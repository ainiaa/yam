fn activation_metadata(app_id: &str, executable: &str) -> Result<(String, String), String> {
    if !app_id.contains('.')
        || !app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        || !executable.starts_with('/')
        || executable.contains(['\0', '\n', '\r'])
    {
        return Err("Invalid Linux activation identity or executable".into());
    }
    // Desktop Exec has both the key-file escape layer and command-line quoting.
    let service_exec = format!(
        "\"{}\"",
        executable
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
    );
    let desktop_exec = service_exec.replace('\\', "\\\\").replace('%', "%%");
    Ok((
        // Tao's registered GTK application does not handle Open; URI launches use Exec %u.
        // Notification ActivateAction calls still auto-start the matching D-Bus service.
        format!("[Desktop Entry]\nType=Application\nName=YAM\nExec={desktop_exec} %u\nIcon={app_id}\nTerminal=false\nDBusActivatable=false\nX-GNOME-UsesNotifications=true\nMimeType=x-scheme-handler/yam;\n"),
        format!("[D-BUS Service]\nName={app_id}\nExec={service_exec}\n"),
    ))
}

#[cfg(target_os = "linux")]
use gio::{glib, prelude::*};

#[cfg(target_os = "linux")]
static INITIALIZATION: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();

fn require_initialization(state: &std::sync::OnceLock<Result<(), String>>) -> Result<(), String> {
    state
        .get()
        .cloned()
        .unwrap_or_else(|| Err("Linux notification activation has not been initialized".into()))
}

#[cfg(target_os = "linux")]
fn application(app: &tauri::AppHandle) -> Result<gio::Application, String> {
    let application =
        gio::Application::default().ok_or_else(|| "GTK application is unavailable".to_string())?;
    if application.application_id().as_deref() != Some(app.config().identifier.as_str())
        || !application.is_registered()
        || application.is_remote()
    {
        return Err(
            "Linux notifications require enableGtkAppId and the primary GTK application".into(),
        );
    }
    Ok(application)
}

/// Install the D-Bus launcher before exporting notification actions. Kept after
/// shutdown so the desktop can restart this executable when a notification is clicked.
#[cfg(target_os = "linux")]
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    INITIALIZATION.get_or_init(|| initialize(app)).clone()
}

#[cfg(target_os = "linux")]
fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    use std::{fs, path::PathBuf};
    let application = application(app)?;
    // current_exe inside an AppImage points into a temporary mount removed at exit.
    let executable = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .map(Ok)
        .unwrap_or_else(std::env::current_exe)
        .map_err(|error| error.to_string())?;
    let executable = executable
        .to_str()
        .ok_or("Linux executable path is not UTF-8")?;
    let app_id = &app.config().identifier;
    let (desktop, service) = activation_metadata(app_id, executable)?;
    let root = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .filter(|path| path.is_absolute())
        .ok_or("Linux application data directory is unavailable")?;
    for (directory, extension, contents) in [
        ("applications", "desktop", desktop),
        ("dbus-1/services", "service", service),
    ] {
        let directory = root.join(directory);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Linux activation directory failed: {error}"))?;
        let path = directory.join(format!("{app_id}.{extension}"));
        // Refresh our per-user launcher when an application upgrade moves the executable.
        let temporary = path.with_extension(format!("{extension}.tmp"));
        fs::write(&temporary, contents)
            .map_err(|error| format!("Linux activation registration failed: {error}"))?;
        fs::rename(temporary, path)
            .map_err(|error| format!("Linux activation registration failed: {error}"))?;
    }
    let action = gio::SimpleAction::new("open-session", Some(glib::VariantTy::STRING));
    let app_handle = app.clone();
    action.connect_activate(move |_, parameter| {
        if let Some(session_id) = parameter.and_then(|value| value.str()) {
            if let Err(error) = crate::route_notification_session(&app_handle, session_id) {
                eprintln!("Notification session activation failed: {error}");
            }
        }
    });
    application.add_action(&action);
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn send(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    require_initialization(&INITIALIZATION)?;
    use std::collections::BTreeMap;
    let address =
        gio::dbus_address_get_for_bus_sync(gio::BusType::Session, None::<&gio::Cancellable>)
            .map_err(|error| format!("Notification session bus unavailable: {error}"))?;
    // A private peer avoids earlier portal requests by GTK/Tauri preventing Registry.Register.
    // A fresh peer per send also registers again after portal restarts.
    let connection = gio::DBusConnection::for_address_sync(
        &address,
        gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
            | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
        None::<&gio::DBusAuthObserver>,
        None::<&gio::Cancellable>,
    )
    .map_err(|error| format!("Notification bus connection failed: {error}"))?;
    let app_id = &app.config().identifier;
    let notification = notification_payload(&session_id, &title, &body);
    let options = BTreeMap::<String, glib::Variant>::new();
    let portal = call(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.host.portal.Registry",
        "Register",
        &(app_id, options).to_variant(),
    )
    .and_then(|_| {
        call(
            &connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Notification",
            "AddNotification",
            &(&session_id, &notification).to_variant(),
        )
    });
    if portal.is_ok() {
        return Ok(());
    }
    // GNOME's native backend retains application action targets and D-Bus activates
    // after exit. The generic freedesktop ActionInvoked backend cannot do this.
    call(
        &connection,
        "org.gtk.Notifications",
        "/org/gtk/Notifications",
        "org.gtk.Notifications",
        "AddNotification",
        &(app_id, &session_id, &notification).to_variant(),
    )
    .map(|_| ())
    .map_err(|gnome| {
        let portal = portal.unwrap_err();
        delivery_error(
            &portal.to_string(),
            &gnome.to_string(),
            backend_unavailable(&portal) && backend_unavailable(&gnome),
        )
    })
}

#[cfg(target_os = "linux")]
fn notification_payload(
    session_id: &str,
    title: &str,
    body: &str,
) -> std::collections::BTreeMap<&'static str, glib::Variant> {
    std::collections::BTreeMap::from([
        ("title", title.to_variant()),
        ("body", body.to_variant()),
        ("default-action", "app.open-session".to_variant()),
        ("default-action-target", session_id.to_variant()),
    ])
}

#[cfg(target_os = "linux")]
fn call(
    connection: &gio::DBusConnection,
    destination: &str,
    path: &str,
    interface: &str,
    method: &str,
    parameters: &glib::Variant,
) -> Result<glib::Variant, glib::Error> {
    connection.call_sync(
        Some(destination),
        path,
        interface,
        method,
        Some(parameters),
        Some(glib::VariantTy::UNIT),
        gio::DBusCallFlags::NONE,
        5000,
        None::<&gio::Cancellable>,
    )
}

fn delivery_error(portal: &str, gnome: &str, unavailable: bool) -> String {
    if unavailable {
        format!("This desktop cannot provide notifications that reopen YAM after exit. A notification portal with host-app Registry (xdg-desktop-portal 1.20+) or GNOME is required. Portal: {portal}; GNOME: {gnome}")
    } else {
        format!("Linux notification delivery failed. Portal: {portal}; GNOME: {gnome}")
    }
}

#[cfg(target_os = "linux")]
fn backend_unavailable(error: &glib::Error) -> bool {
    use glib::translate::{IntoGlib, ToGlibPtr};
    // GDBus's stable domain/code avoids localized error text. glib 0.18 has no
    // code accessor; the borrowed GError stays valid for this read.
    let raw: *const glib::ffi::GError = error.to_glib_none().0;
    error.domain().into_glib() == unsafe { gio::ffi::g_dbus_error_quark() }
        && matches!(
            unsafe { (*raw).code },
            gio::ffi::G_DBUS_ERROR_SERVICE_UNKNOWN
                | gio::ffi::G_DBUS_ERROR_NAME_HAS_NO_OWNER
                | gio::ffi::G_DBUS_ERROR_NOT_SUPPORTED
                | gio::ffi::G_DBUS_ERROR_UNKNOWN_METHOD
                | gio::ffi::G_DBUS_ERROR_UNKNOWN_INTERFACE
                | gio::ffi::G_DBUS_ERROR_UNKNOWN_OBJECT
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn delivery_errors_only_pause_for_confirmed_backend_absence() {
        let missing = "ServiceUnknown";
        assert!(super::delivery_error(missing, missing, true).starts_with("This desktop cannot"));
        for error in ["Timeout was reached", "NoReply", "Permission denied"] {
            let message = super::delivery_error(error, missing, false);
            assert!(message.starts_with("Linux notification delivery failed"));
            assert!(message.contains(error));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn native_dbus_errors_distinguish_missing_services_from_transient_failures() {
        use gio::glib::translate::from_glib_full;
        for (name, unavailable) in [
            ("org.freedesktop.DBus.Error.ServiceUnknown", true),
            ("org.freedesktop.DBus.Error.UnknownMethod", true),
            ("org.freedesktop.DBus.Error.NoReply", false),
            ("org.freedesktop.DBus.Error.Timeout", false),
            ("org.freedesktop.DBus.Error.AccessDenied", false),
        ] {
            let name = std::ffi::CString::new(name).unwrap();
            let message = std::ffi::CString::new("test").unwrap();
            let error: gio::glib::Error = unsafe {
                from_glib_full(gio::ffi::g_dbus_error_new_for_dbus_error(
                    name.as_ptr(),
                    message.as_ptr(),
                ))
            };
            assert_eq!(super::backend_unavailable(&error), unavailable);
        }
        let timeout = gio::glib::Error::new(gio::IOErrorEnum::TimedOut, "timeout");
        assert!(!super::backend_unavailable(&timeout));
    }

    #[test]
    fn send_requires_successful_activation_registration() {
        let missing = std::sync::OnceLock::new();
        assert!(super::require_initialization(&missing).is_err());
        let failed = std::sync::OnceLock::new();
        failed
            .set(Err("Cannot write D-Bus service".to_string()))
            .unwrap();
        assert_eq!(
            super::require_initialization(&failed),
            Err("Cannot write D-Bus service".to_string())
        );
        let ready = std::sync::OnceLock::new();
        ready.set(Ok(())).unwrap();
        assert_eq!(super::require_initialization(&ready), Ok(()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn activation_exec_round_trips_through_native_keyfile_and_argument_parsers() {
        let executable = "/opt/YAM $ test/100%\\\"yam";
        let (desktop, service) = super::activation_metadata("com.yam.desktop", executable).unwrap();
        let service_exec = service
            .lines()
            .find_map(|line| line.strip_prefix("Exec="))
            .unwrap();
        let arguments = gio::glib::shell_parse_argv(service_exec).unwrap();
        assert_eq!(arguments[0].to_str(), Some(executable));
        assert_eq!(arguments.len(), 1);
        let keyfile = gio::glib::KeyFile::new();
        keyfile
            .load_from_data(&desktop, gio::glib::KeyFileFlags::NONE)
            .unwrap();
        let desktop_exec = keyfile.string("Desktop Entry", "Exec").unwrap();
        let arguments = gio::glib::shell_parse_argv(desktop_exec.as_str()).unwrap();
        assert_eq!(
            arguments[0].to_str().unwrap().replace("%%", "%"),
            executable
        );
        assert_eq!(arguments[1].to_str(), Some("%u"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn notification_payload_retains_typed_session_action_for_process_restart() {
        use gio::prelude::*;
        let notification = super::notification_payload("s-123-4", "Done", "Session completed");
        assert_eq!(notification.to_variant().type_().as_str(), "a{sv}");
        assert_eq!(
            notification["default-action"].str(),
            Some("app.open-session")
        );
        assert_eq!(notification["default-action-target"].str(), Some("s-123-4"));
        assert_eq!(
            ("s-123-4", &notification).to_variant().type_().as_str(),
            "(sa{sv})"
        );
        assert_eq!(
            ("com.yam.desktop", "s-123-4", &notification)
                .to_variant()
                .type_()
                .as_str(),
            "(ssa{sv})"
        );
    }

    #[test]
    fn activation_metadata_uses_the_installed_executable_without_shell_interpolation() {
        let (desktop, service) =
            super::activation_metadata("com.yam.desktop", "/opt/YAM $ test/100%\\\"yam").unwrap();
        assert!(desktop.contains("DBusActivatable=false\n"));
        assert!(desktop.contains("X-GNOME-UsesNotifications=true\n"));
        assert!(desktop.contains("MimeType=x-scheme-handler/yam;\n"));
        assert!(desktop.contains("100%%"));
        assert!(service.contains("Name=com.yam.desktop\n"));
        assert!(service.contains("100%"));
        assert!(!service.contains("100%%"));
        assert!(desktop.contains("\\\\$"));
        assert!(service.contains("\\$"));
    }

    #[test]
    fn activation_metadata_rejects_invalid_identity_or_executable() {
        assert!(super::activation_metadata("com.yam.desktop", "/usr/bin/yam").is_ok());
        assert!(super::activation_metadata("bad\nName=injected", "/usr/bin/yam").is_err());
        assert!(super::activation_metadata("com.yam.desktop", "relative/yam").is_err());
        assert!(super::activation_metadata("com.yam.desktop", "/usr/bin/yam\nExec=bad").is_err());
    }
}
