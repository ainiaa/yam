// Author: Jeff.Liu. Serialize macOS GUI initialization until the existing singleton is ready.
use std::{
    fs::File,
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::Path,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

struct Gate(Mutex<Option<File>>);

pub(super) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    plugin_with(
        |app| Ok(app.path().app_data_dir()?.join("gui-startup")),
        Duration::from_secs(10),
    )
}
fn plugin_with<R: tauri::Runtime>(
    root: impl FnOnce(&tauri::AppHandle<R>) -> Result<std::path::PathBuf, Box<dyn std::error::Error>>
        + Send
        + 'static,
    timeout: Duration,
) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("yam-gui-startup")
        .setup(move |app, _| {
            let root = root(app)?;
            let file = acquire_lock(&root, timeout).map_err(std::io::Error::other)?;
            app.manage(Gate(Mutex::new(Some(file))));
            Ok(())
        })
        .build()
}

pub(super) fn ready(app: &tauri::AppHandle) -> Result<(), String> {
    // shortcut: Tauri 2 macOS socket naming; recheck when upgrading the single-instance plugin.
    let identifier = app.config().identifier.replace(['.', '-'], "_");
    let socket = std::path::PathBuf::from(format!("/tmp/{identifier}_si.sock"));
    ready_at(app, &socket, Duration::from_secs(5))
}
fn ready_at<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    socket: &Path,
    timeout: Duration,
) -> Result<(), String> {
    release_when_ready(&app.state::<Gate>(), socket, timeout)
}

fn acquire_lock(root: &Path, timeout: Duration) -> Result<File, String> {
    crate::background::private_root(root)?;
    let path = root.join("startup.lock");
    let file = match crate::background::private_file(&path, true) {
        Ok(file) => file,
        Err(_) => crate::background::private_file(&path, false)?,
    };
    let deadline = Instant::now() + timeout;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) {
            return Err("Cannot lock GUI startup".into());
        }
        if Instant::now() >= deadline {
            return Err("Another YAM instance is still starting; try opening it again".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn release_when_ready(gate: &Gate, socket: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match UnixStream::connect(socket) {
            Ok(stream) => {
                drop(stream);
                gate.0
                    .lock()
                    .map_err(|_| "GUI startup lock poisoned")?
                    .take();
                return Ok(());
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                return Err("YAM single-instance listener is unavailable; startup stopped".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::net::UnixListener, path::PathBuf, thread, time::Instant};

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-gui-startup-{}-{}",
                std::process::id(),
                crate::next_session_id()
            ));
            crate::background::private_root(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn closure_t19_actual_plugin_setup_keeps_ownership_until_owned_listener_ready() {
        let root = Root::new();
        let path = root.0.clone();
        let app = tauri::test::mock_builder()
            .plugin(plugin_with(move |_| Ok(path), Duration::ZERO))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert!(app.state::<Gate>().0.lock().unwrap().is_some());
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        let path = root.0.clone();
        let duplicate = tauri::test::mock_builder()
            .plugin(plugin_with(move |_| Ok(path), Duration::ZERO))
            .build(tauri::test::mock_context(tauri::test::noop_assets()));
        assert!(duplicate.is_err());
        let socket = root.0.join("s");
        assert!(ready_at(app.handle(), &socket, Duration::ZERO).is_err());
        assert!(app.state::<Gate>().0.lock().unwrap().is_some());
        let listener = UnixListener::bind(&socket).unwrap();
        let inherited = app
            .state::<Gate>()
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .try_clone()
            .unwrap();
        let child = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            drop(inherited);
        });
        ready_at(app.handle(), &socket, Duration::ZERO).unwrap();
        assert!(app.state::<Gate>().0.lock().unwrap().is_none());
        let other_owner = acquire_lock(&root.0, Duration::from_secs(1)).unwrap();
        ready_at(app.handle(), &socket, Duration::ZERO).unwrap();
        assert!(
            acquire_lock(&root.0, Duration::ZERO).is_err(),
            "duplicate readiness released a different lock owner"
        );
        drop(other_owner);
        child.join().unwrap();
        drop(listener);
        assert!(acquire_lock(&root.0, Duration::ZERO).is_ok());
    }

    #[test]
    fn closure_t19_plugin_resource_failure_stops_before_managing_or_replacing_storage() {
        let root = Root::new();
        let rejected = tauri::test::mock_builder()
            .plugin(plugin_with(
                |_| {
                    Err(Box::new(std::io::Error::other(
                        "owned resource unavailable",
                    )))
                },
                Duration::ZERO,
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()));
        assert!(rejected.is_err());
        assert!(!root.0.join("startup.lock").exists());
        let path = root.0.join("owned-file");
        fs::write(&path, b"unchanged").unwrap();
        let invalid = path.clone();
        let rejected = tauri::test::mock_builder()
            .plugin(plugin_with(move |_| Ok(invalid), Duration::ZERO))
            .build(tauri::test::mock_context(tauri::test::noop_assets()));
        assert!(rejected.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unchanged");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }

    #[test]
    fn gui_startup_lock_excludes_another_launch_and_releases_after_last_handle_closes() {
        let root = Root::new();
        let first = acquire_lock(&root.0, Duration::ZERO).unwrap();
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        // A concurrently forked child may retain this file description until exec.
        let inherited = first.try_clone().unwrap();
        let child = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            drop(inherited);
        });
        drop(first);
        assert!(acquire_lock(&root.0, Duration::from_secs(1)).is_ok());
        child.join().unwrap();
    }

    #[test]
    fn gui_startup_contender_waits_for_first_initialization() {
        let root = Root::new();
        let first = acquire_lock(&root.0, Duration::ZERO).unwrap();
        let other_root = root.0.clone();
        let contender = thread::spawn(move || acquire_lock(&other_root, Duration::from_secs(1)));
        thread::sleep(Duration::from_millis(30));
        assert!(!contender.is_finished());
        drop(first);
        assert!(contender.join().unwrap().is_ok());
    }

    #[test]
    fn gui_startup_busy_timeout_is_bounded() {
        let root = Root::new();
        let _first = acquire_lock(&root.0, Duration::ZERO).unwrap();
        let start = Instant::now();
        assert!(acquire_lock(&root.0, Duration::from_millis(20)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn gui_startup_releases_only_after_delayed_listener_is_available() {
        let root = Root::new();
        let gate = Gate(Mutex::new(Some(
            acquire_lock(&root.0, Duration::ZERO).unwrap(),
        )));
        let socket = root.0.join("ready.sock");
        let target = socket.clone();
        let listener = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            let listener = UnixListener::bind(target).unwrap();
            listener.accept().unwrap();
        });
        release_when_ready(&gate, &socket, Duration::from_secs(1)).unwrap();
        listener.join().unwrap();
        assert!(gate.0.lock().unwrap().is_none());
        assert!(acquire_lock(&root.0, Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn gui_startup_missing_or_invalid_listener_keeps_exclusive_lock() {
        let root = Root::new();
        let gate = Gate(Mutex::new(Some(
            acquire_lock(&root.0, Duration::ZERO).unwrap(),
        )));
        let socket = root.0.join("missing.sock");
        assert!(release_when_ready(&gate, &socket, Duration::from_millis(20)).is_err());
        assert!(gate.0.lock().unwrap().is_some());
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        fs::write(&socket, "not a listener").unwrap();
        assert!(release_when_ready(&gate, &socket, Duration::ZERO).is_err());
        assert!(gate.0.lock().unwrap().is_some());
        drop(gate);
        assert!(acquire_lock(&root.0, Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn gui_startup_rejects_shared_symlink_and_fifo_lock_files() {
        use std::{
            ffi::CString,
            os::unix::{
                ffi::OsStrExt,
                fs::{symlink, PermissionsExt},
            },
        };
        let root = Root::new();
        let path = root.0.join("startup.lock");
        fs::write(&path, "").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        fs::remove_file(&path).unwrap();
        let target = root.0.join("unrelated");
        fs::write(&target, "unchanged").unwrap();
        symlink(&target, &path).unwrap();
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "unchanged");
        fs::remove_file(&path).unwrap();
        let fifo = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let start = Instant::now();
        assert!(acquire_lock(&root.0, Duration::ZERO).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
