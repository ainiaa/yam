// Author: Jeff.Liu.
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf},
    sync::atomic::AtomicBool,
};
use tauri::Manager;
const LIMIT: usize = 1024 * 1024;

#[derive(Debug, serde::Serialize)]
pub(crate) struct Entry {
    name: String,
    directory: bool,
}
#[derive(Debug, serde::Serialize)]
pub(crate) struct Document {
    text: String,
    revision: String,
}

fn relative(value: &str, empty: bool) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.len() > 4096
        || value.is_empty() && !empty
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
        || value
            .split('/')
            .any(|p| p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("file_invalid_path".into());
    }
    Ok(path)
}
fn document(bytes: Vec<u8>) -> Result<Document, String> {
    if bytes.len() > LIMIT {
        return Err("file_too_large".into());
    }
    if bytes.contains(&0) {
        return Err("files_binary".into());
    }
    let revision = format!("{:x}", Sha256::digest(&bytes));
    Ok(Document {
        text: String::from_utf8(bytes).map_err(|_| "file_invalid_utf8")?,
        revision,
    })
}
fn read(root: &Path, name: &str) -> Result<Document, String> {
    let path = root.join(relative(name, false)?);
    document(crate::file_preview::read_bytes(
        root,
        &path,
        &AtomicBool::new(false),
        || {},
        LIMIT,
    )?)
}
#[cfg(unix)]
pub(crate) fn read_snapshot(root: &Path, name: &str) -> Result<Option<String>, String> {
    let relative = relative(name, false)?;
    let directory = crate::file_preview::open_root(root)?;
    if crate::file_preview::open_beneath_optional(&directory, relative)?.is_none() {
        return Ok(None);
    }
    read(root, name).map(|value| Some(value.text))
}
#[cfg(not(unix))]
pub(crate) fn read_snapshot(_root: &Path, _name: &str) -> Result<Option<String>, String> {
    Err("file_platform_unavailable".into())
}
#[cfg(unix)]
fn list(root: &Path, name: &str) -> Result<Vec<Entry>, String> {
    use std::os::fd::IntoRawFd;
    let path = relative(name, true)?;
    let root = crate::file_preview::open_root(root)?;
    let directory = if path.as_os_str().is_empty() {
        root
    } else {
        crate::file_preview::open_beneath(&root, path)?
    };
    if !directory
        .metadata()
        .map_err(|_| "file_unavailable")?
        .is_dir()
    {
        return Err("file_not_regular".into());
    }
    let fd = directory.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err("file_unavailable".into());
    }
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let stream = Directory(stream);
    let mut entries = Vec::new();
    let mut scanned = 0;
    loop {
        // readdir reports end and errors through errno; clear it before each call.
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                return Err("file_unavailable".into());
            }
            break;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        let Ok(name) = bytes.to_str() else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }
        scanned += 1;
        if scanned > 2000 {
            return Err("files_directory_too_large".into());
        }
        if relative(name, false).is_err() {
            continue;
        }
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                libc::dirfd(stream.0),
                bytes.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err("file_unavailable".into());
        }
        let mode = unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT;
        if mode == libc::S_IFREG || mode == libc::S_IFDIR {
            entries.push(Entry {
                name: name.into(),
                directory: mode == libc::S_IFDIR,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
#[cfg(unix)]
fn save(root: &Path, name: &str, revision: &str, text: &str) -> Result<Document, String> {
    use std::{
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, PermissionsExt},
            },
        },
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex,
        },
    };
    static SAVES: Mutex<()> = Mutex::new(());
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let _lock = SAVES.lock().map_err(|_| "file_unavailable")?;
    let path = relative(name, false)?;
    let result = document(text.as_bytes().to_vec())?;
    if read(root, name)?.revision != revision {
        return Err("file_changed".into());
    }
    let root_fd = crate::file_preview::open_root(root)?;
    let parent = match path.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(path) => crate::file_preview::open_beneath(&root_fd, path)?,
        None => root_fd.try_clone().map_err(|_| "file_unavailable")?,
    };
    let current = crate::file_preview::open_beneath(&root_fd, path)?;
    let metadata = current.metadata().map_err(|_| "file_unavailable")?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o222 == 0 {
        return Err("file_not_regular".into());
    }
    let target = std::ffi::CString::new(path.file_name().ok_or("file_invalid_path")?.as_bytes())
        .map_err(|_| "file_invalid_path")?;
    let temporary = std::ffi::CString::new(format!(
        ".yam-save-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
    .unwrap();
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err("file_unavailable".into());
    }
    struct Pending<'a>(&'a std::fs::File, &'a std::ffi::CStr);
    impl Drop for Pending<'_> {
        fn drop(&mut self) {
            unsafe { libc::unlinkat(self.0.as_raw_fd(), self.1.as_ptr(), 0) };
        }
    }
    let _pending = Pending(&parent, &temporary);
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.write_all(text.as_bytes())
        .map_err(|_| "files_save_failed")?;
    file.set_permissions(std::fs::Permissions::from_mode(metadata.mode() & 0o777))
        .map_err(|_| "files_save_failed")?;
    file.sync_all().map_err(|_| "files_save_failed")?;
    #[cfg(all(test, unix))]
    BEFORE_COMMIT.with(|hook| {
        if let Some(callback) = hook.borrow_mut().take() {
            callback();
        }
    });
    if read(root, name)?.revision != revision {
        return Err("file_changed".into());
    }
    let live_root = crate::file_preview::open_root(root)?;
    let original_root = root_fd.metadata().map_err(|_| "file_unavailable")?;
    let live_root_metadata = live_root.metadata().map_err(|_| "file_unavailable")?;
    if original_root.dev() != live_root_metadata.dev()
        || original_root.ino() != live_root_metadata.ino()
    {
        return Err("file_changed".into());
    }
    let live_parent = if let Some(path) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        crate::file_preview::open_beneath(&live_root, path)?
    } else {
        live_root
    };
    let live = live_parent.metadata().map_err(|_| "file_unavailable")?;
    let pinned = parent.metadata().map_err(|_| "file_unavailable")?;
    if live.dev() != pinned.dev() || live.ino() != pinned.ino() {
        return Err("file_changed".into());
    }
    let prepared = file.metadata().map_err(|_| "files_save_failed")?;
    let source =
        crate::file_preview::open_beneath(&parent, Path::new(temporary.to_str().unwrap()))?
            .metadata()
            .map_err(|_| "files_save_failed")?;
    let temporary_path = path.with_file_name(temporary.to_str().unwrap());
    if prepared.dev() != source.dev()
        || prepared.ino() != source.ino()
        || read(root, temporary_path.to_str().ok_or("file_invalid_path")?)?.revision
            != result.revision
    {
        return Err("file_changed".into());
    }
    // shortcut: external editors do not share our lock; revision checks are optimistic, as in a normal editor.
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        return Err("files_save_failed".into());
    }
    Ok(result)
}
#[cfg(not(unix))]
fn list(_root: &Path, _name: &str) -> Result<Vec<Entry>, String> {
    Err("file_platform_unavailable".into())
}
#[cfg(not(unix))]
fn save(_root: &Path, _name: &str, _revision: &str, _text: &str) -> Result<Document, String> {
    Err("file_platform_unavailable".into())
}

pub(crate) fn session_root(app: &tauri::AppHandle, session_id: String) -> Result<PathBuf, String> {
    let session = crate::get_session(app.clone(), app.state(), session_id)
        .map_err(|_| "file_session_unavailable")?;
    if session.summary.ssh.is_some() {
        return Err("file_session_unavailable".into());
    }
    std::fs::canonicalize(session.summary.cwd).map_err(|_| "file_session_unavailable".into())
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn list_project_files(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&session_root(&app, session_id)?, &path))
        .await
        .map_err(|_| "file_unavailable")?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn read_project_text(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || read(&session_root(&app, session_id)?, &path))
        .await
        .map_err(|_| "file_unavailable")?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn save_project_text(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
    revision: String,
    text: String,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save(&session_root(&app, session_id)?, &path, &revision, &text)
    })
    .await
    .map_err(|_| "file_unavailable")?
}

#[cfg(all(test, unix))]
thread_local! {
    static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "yam-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn browse_sorted_directories_and_dotfiles_without_symlinks_or_git() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("src")).unwrap();
        fs::create_dir(f.0.join(".git")).unwrap();
        fs::write(f.0.join("z.txt"), "z").unwrap();
        fs::write(f.0.join(".env.example"), "").unwrap();
        symlink("src", f.0.join("link")).unwrap();
        let entries = list(&f.0, "").unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.name.as_str(), e.directory))
                .collect::<Vec<_>>(),
            vec![("src", true), (".env.example", false), ("z.txt", false)]
        );
        assert!(list(&f.0, "src").unwrap().is_empty());
    }
    #[test]
    fn edit_unicode_empty_crlf_and_preserve_permissions() {
        let f = Fixture::new();
        let path = f.0.join("a.txt");
        fs::write(&path, "中文\r\n😀\r\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let original = read(&f.0, "a.txt").unwrap();
        assert_eq!(original.text, "中文\r\n😀\r\n");
        let saved = save(&f.0, "a.txt", &original.revision, "").unwrap();
        assert_eq!(saved.text, "");
        assert_eq!(fs::read(&path).unwrap(), b"");
        assert_ne!(original.revision, saved.revision);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            list(&f.0, "").unwrap().len(),
            1,
            "temporary files cleaned up"
        );
    }
    #[test]
    fn conflicts_do_not_overwrite_ai_changes_or_recreate_deleted_files() {
        let f = Fixture::new();
        let path = f.0.join("a");
        fs::write(&path, "old").unwrap();
        let original = read(&f.0, "a").unwrap();
        fs::write(&path, "AI edit").unwrap();
        assert_eq!(
            save(&f.0, "a", &original.revision, "my edit").unwrap_err(),
            "file_changed"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "AI edit");
        fs::remove_file(&path).unwrap();
        assert!(save(&f.0, "a", &original.revision, "my edit").is_err());
        assert!(!path.exists());
    }
    #[test]
    fn save_rechecks_root_parent_and_file_after_preparing_atomic_replacement() {
        for mode in ["content", "symlink", "parent", "root"] {
            let f = Fixture::new();
            let outside = Fixture::new();
            fs::create_dir(f.0.join("src")).unwrap();
            fs::write(f.0.join("src/a"), "original").unwrap();
            fs::write(outside.0.join("secret"), "secret").unwrap();
            let original = read(&f.0, "src/a").unwrap();
            let root = f.0.clone();
            let secret = outside.0.join("secret");
            let moved = outside.0.join("moved");
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || match mode {
                    "content" => fs::write(root.join("src/a"), "AI updated").unwrap(),
                    "symlink" => {
                        fs::remove_file(root.join("src/a")).unwrap();
                        symlink(secret, root.join("src/a")).unwrap();
                    }
                    "parent" => {
                        fs::rename(root.join("src"), &moved).unwrap();
                        fs::create_dir(root.join("src")).unwrap();
                        fs::write(root.join("src/a"), "original").unwrap();
                    }
                    _ => {
                        fs::rename(&root, &moved).unwrap();
                        fs::create_dir(&root).unwrap();
                        fs::create_dir(root.join("src")).unwrap();
                        fs::write(root.join("src/a"), "original").unwrap();
                    }
                }))
            });
            assert!(
                save(&f.0, "src/a", &original.revision, "my edit").is_err(),
                "{mode}"
            );
            assert_eq!(
                fs::read_to_string(outside.0.join("secret")).unwrap(),
                "secret"
            );
            if matches!(mode, "parent" | "root") {
                let old = if mode == "parent" {
                    outside.0.join("moved/a")
                } else {
                    outside.0.join("moved/src/a")
                };
                assert_eq!(fs::read_to_string(old).unwrap(), "original");
            }
        }
    }

    #[test]
    fn save_refuses_substituted_or_modified_prepared_file() {
        for mode in ["symlink", "replace", "modify"] {
            let f = Fixture::new();
            let outside = Fixture::new();
            fs::write(f.0.join("a"), "original").unwrap();
            fs::write(outside.0.join("secret"), "secret").unwrap();
            let original = read(&f.0, "a").unwrap();
            let root = f.0.clone();
            let secret = outside.0.join("secret");
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    let temporary = fs::read_dir(&root)
                        .unwrap()
                        .map(|e| e.unwrap().path())
                        .find(|p| {
                            p.file_name()
                                .unwrap()
                                .to_string_lossy()
                                .starts_with(".yam-save-")
                        })
                        .unwrap();
                    if mode != "modify" {
                        fs::remove_file(&temporary).unwrap();
                    }
                    if mode == "symlink" {
                        symlink(secret, temporary).unwrap();
                    } else {
                        fs::write(temporary, "INJECT!").unwrap();
                    }
                }))
            });
            assert!(
                save(&f.0, "a", &original.revision, "my edit").is_err(),
                "{mode}"
            );
            assert_eq!(fs::read_to_string(f.0.join("a")).unwrap(), "original");
            assert_eq!(
                fs::read_to_string(outside.0.join("secret")).unwrap(),
                "secret"
            );
            assert_eq!(list(&f.0, "").unwrap().len(), 1);
        }
    }
    #[test]
    fn path_escape_symlinks_git_binary_large_and_hardlinks_are_rejected() {
        let f = Fixture::new();
        fs::write(f.0.join("a"), "text").unwrap();
        symlink("a", f.0.join("link")).unwrap();
        fs::hard_link(f.0.join("a"), f.0.join("hard")).unwrap();
        fs::write(f.0.join("binary"), b"a\0b").unwrap();
        fs::write(f.0.join("invalid"), [255]).unwrap();
        fs::write(f.0.join("large"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        for path in [
            "../a",
            "/etc/passwd",
            ".git/config",
            "link",
            "hard",
            "binary",
            "invalid",
            "large",
        ] {
            assert!(read(&f.0, path).is_err(), "read {path}");
            assert!(save(&f.0, path, "invalid", "new").is_err(), "save {path}");
        }
        for path in ["..", "/etc", ".git", "link"] {
            assert!(list(&f.0, path).is_err(), "list {path}");
        }
    }
    #[test]
    fn bounded_text_and_directory_listing_and_readonly_files() {
        let f = Fixture::new();
        let path = f.0.join("a");
        fs::write(&path, vec![b'x'; 1024 * 1024]).unwrap();
        let original = read(&f.0, "a").unwrap();
        assert_eq!(original.text.len(), 1024 * 1024);
        assert!(save(&f.0, "a", &original.revision, &"x".repeat(1024 * 1024 + 1)).is_err());
        assert!(save(&f.0, "a", &original.revision, "a\0b").is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(save(&f.0, "a", &original.revision, "new").is_err());
        for n in 0..2001 {
            fs::write(f.0.join(format!("f{n}")), "").unwrap();
        }
        assert_eq!(list(&f.0, "").unwrap_err(), "files_directory_too_large");
    }
}
