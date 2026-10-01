// Protocol activation is handled by Windows, so no callback or live YAM
// process is required. A per-user shortcut preserves toasts in Action Center.
#[cfg(windows)]
pub fn send(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link()
        .register_all()
        .map_err(|error| format!("Register notification protocol: {error}"))?;
    let xml = toast_xml(&session_id, &title, &body)?;
    let app_id = app.config().identifier.clone();
    // A fresh thread guarantees a compatible WinRT apartment without changing
    // the caller's apartment (Tauri's UI thread may already use STA).
    std::thread::spawn(move || show_toast(&app_id, &xml))
        .join()
        .map_err(|_| "Windows notification worker panicked".to_string())?
}

#[cfg(windows)]
fn show_toast(app_id: &str, xml: &str) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
    };

    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|error| format!("Initialize Windows notifications: {error}"))?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _apartment = Apartment;
    register_shortcut(app_id)?;
    let document = XmlDocument::new()
        .map_err(|error| format!("Create Windows notification document: {error}"))?;
    document
        .LoadXml(&HSTRING::from(xml))
        .map_err(|error| format!("Load Windows notification content: {error}"))?;
    let notification = ToastNotification::CreateToastNotification(&document)
        .map_err(|error| format!("Create Windows notification: {error}"))?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .map_err(|error| format!("Create Windows notifier: {error}"))?;
    let setting = notifier
        .Setting()
        .map_err(|error| format!("Read Windows notification permission: {error}"))?;
    if setting != NotificationSetting::Enabled {
        return Err(format!("Windows notifications are disabled ({setting:?})"));
    }
    notifier
        .Show(&notification)
        .map_err(|error| format!("Show Windows notification: {error}"))
}

#[cfg(windows)]
fn register_shortcut(app_id: &str) -> Result<(), String> {
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::PathBuf,
    };
    use windows::{
        core::{w, Interface, GUID, PCWSTR},
        Win32::{
            Storage::EnhancedStorage::{
                PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID,
            },
            System::{
                Com::{
                    CoCreateInstance, CoTaskMemFree, IPersistFile,
                    StructuredStorage::{InitPropVariantFromCLSID, PROPVARIANT},
                    CLSCTX_INPROC_SERVER,
                },
                Variant::VT_LPWSTR,
            },
            UI::Shell::{
                FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore,
                SHGetKnownFolderPath, SHStrDupW, ShellLink, KF_FLAG_CREATE,
            },
        },
    };

    // Config identifiers become filenames; never allow path components.
    if app_id.is_empty()
        || app_id.len() > 128
        || !app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Invalid Windows notification application ID".into());
    }
    static SHORTCUT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = SHORTCUT_LOCK
        .lock()
        .map_err(|_| "Windows shortcut lock poisoned".to_string())?;
    let executable =
        std::env::current_exe().map_err(|error| format!("Locate YAM executable: {error}"))?;
    let exe_wide: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        (|| -> windows::core::Result<()> {
            let folder = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_CREATE, None)?;
            let directory = PathBuf::from(OsString::from_wide(folder.as_wide()));
            CoTaskMemFree(Some(folder.0.cast()));
            // Use an identifier-specific shortcut; do not overwrite the
            // installer's user-facing shortcut or another application's link.
            let shortcut = directory.join(format!("{app_id}.lnk"));
            let shortcut_wide: Vec<u16> =
                shortcut.as_os_str().encode_wide().chain(Some(0)).collect();
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(exe_wide.as_ptr()))?;
            link.SetDescription(w!("YAM session notifications"))?;
            link.SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)?;
            let properties: IPropertyStore = link.cast()?;
            let id_wide: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
            let mut id = PROPVARIANT::default();
            let id_data = &mut *id.Anonymous.Anonymous;
            id_data.Anonymous.pwszVal = SHStrDupW(PCWSTR(id_wide.as_ptr()))?;
            id_data.vt = VT_LPWSTR;
            properties.SetValue(&PKEY_AppUserModel_ID, &id)?;
            // Microsoft's protocol-only activation option uses a stub CLSID;
            // intentionally do not register a COM activation server for it.
            let activator =
                InitPropVariantFromCLSID(&GUID::from_u128(0xd87068c6_1899_494e_8d51_bcc8933d0cc9))?;
            properties.SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &activator)?;
            properties.Commit()?;
            let file: IPersistFile = link.cast()?;
            file.Save(PCWSTR(shortcut_wide.as_ptr()), true)
        })()
    };
    result.map_err(|error| format!("Register YAM notification shortcut: {error}"))
}

fn toast_xml(session_id: &str, title: &str, body: &str) -> Result<String, String> {
    if !session_id.starts_with("s-")
        || session_id.len() <= 2
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid notification session ID".into());
    }
    let title = escape_xml(title)?;
    let body = escape_xml(body)?;
    Ok(format!(
        "<toast activationType=\"protocol\" launch=\"yam://session/{session_id}\"><visual><binding template=\"ToastGeneric\"><text>{title}</text><text>{body}</text></binding></visual></toast>"
    ))
}

fn escape_xml(text: &str) -> Result<String, String> {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\t'
            | '\n'
            | '\r'
            | '\u{20}'..='\u{d7ff}'
            | '\u{e000}'..='\u{fffd}'
            | '\u{10000}'..='\u{10ffff}' => escaped.push(character),
            _ => return Err("Notification text contains an invalid XML character".into()),
        }
    }
    Ok(escaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_uses_protocol_activation_without_process_callback() {
        assert_eq!(
            toast_xml("s-abcdef-0", "Finished", "Review the session").unwrap(),
            "<toast activationType=\"protocol\" launch=\"yam://session/s-abcdef-0\"><visual><binding template=\"ToastGeneric\"><text>Finished</text><text>Review the session</text></binding></visual></toast>"
        );
    }

    #[test]
    fn escapes_xml_and_preserves_unicode_and_allowed_whitespace() {
        let xml = toast_xml("s-1", "<&>\"'", "完成\n\t\r😀").unwrap();
        assert!(xml.contains("<text>&lt;&amp;&gt;&quot;&apos;</text>"));
        assert!(xml.contains("<text>完成\n\t\r😀</text>"));
        assert!(toast_xml(&format!("s-{}", "a".repeat(126)), "", "").is_ok());
    }

    #[test]
    fn rejects_empty_oversized_and_injection_session_ids() {
        for id in [
            "",
            "s-",
            "a-1",
            "s-1_2",
            "../secret",
            "s/1",
            "s?other",
            "s#other",
            "s%22",
            "s\" />",
            " s",
            "会话",
        ] {
            assert!(toast_xml(id, "title", "body").is_err(), "accepted {id:?}");
        }
        assert!(toast_xml(&format!("s-{}", "a".repeat(127)), "title", "body").is_err());
    }

    #[test]
    fn rejects_characters_xml_cannot_represent() {
        for character in [
            '\0', '\u{1}', '\u{8}', '\u{b}', '\u{c}', '\u{1f}', '\u{fffe}', '\u{ffff}',
        ] {
            assert!(toast_xml("s-1", &character.to_string(), "body").is_err());
            assert!(toast_xml("s-1", "title", &character.to_string()).is_err());
        }
    }
}
