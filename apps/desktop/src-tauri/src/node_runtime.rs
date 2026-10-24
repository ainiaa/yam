// Author: Jeff.Liu. Only the private terminal parser uses this runtime.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const VERSION: &str = "26.10.0";
const LIMIT: u64 = 200 * 1024 * 1024;
struct Artifact {
    name: String,
    sha256: String,
    member: Option<String>,
}
impl Artifact {
    fn url(&self) -> String {
        format!("https://nodejs.org/dist/v{VERSION}/{}", self.name)
    }
}
fn artifact_for(os: &str, arch: &str) -> Result<Artifact, String> {
    let os = match os {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win",
        _ => return Err("Unsupported Node runtime platform".into()),
    };
    let arch = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("Unsupported Node runtime architecture".into()),
    };
    let folder = format!("node-v{VERSION}-{os}-{arch}");
    let name = if os == "win" {
        format!("win-{arch}/node.exe")
    } else {
        format!("{folder}.tar.gz")
    };
    let manifest: std::collections::HashMap<String, String> = serde_json::from_str(include_str!(
        "../../../../scripts/node-runtime-checksums.json"
    ))
    .map_err(|_| "Invalid Node download manifest")?;
    let sha256 = manifest
        .get(&name)
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Missing Node download checksum")?
        .clone();
    Ok(Artifact {
        name,
        sha256,
        member: (os != "win").then(|| format!("{folder}/bin/node")),
    })
}
#[cfg(test)]
fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_digest(path: &Path) -> Result<String, String> {
    let file = crate::background::private_file(path, false)?;
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut reader = file.take(LIMIT + 1);
    let mut bytes = [0; 65536];
    loop {
        let n = reader
            .read(&mut bytes)
            .map_err(|_| "Cannot read private Node runtime")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > LIMIT {
            return Err("Node runtime exceeds size limit".into());
        }
        digest.update(&bytes[..n]);
    }
    if size == 0 {
        return Err("Empty Node runtime".into());
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) fn compatible_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        && parts[0].parse::<u64>().is_ok_and(|v| v >= 22)
}
fn candidates(path: &std::ffi::OsStr) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in std::env::split_paths(path).filter(|p| p.is_absolute()) {
        let file = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if !file.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if !file
                .metadata()
                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
            {
                continue;
            }
        }
        if let Ok(file) = file.canonicalize() {
            if !result.contains(&file) {
                result.push(file);
            }
        }
    }
    result
}
fn probe(node: &Path, script: &Path) -> Result<(), String> {
    let runtime = crate::terminal_runtime::Runtime::start_node(node, script, |_, _| Ok(()))?;
    runtime.call("create", "probe", serde_json::json!({"cols":20,"rows":8}))?;
    runtime.output("probe", "中文 😀".as_bytes())?;
    let frame = runtime.call("snapshot", "probe", serde_json::json!({}))?;
    if !frame["data"]
        .as_str()
        .is_some_and(|data| data.contains("中文 😀"))
    {
        return Err("Node terminal capability probe failed".into());
    }
    Ok(())
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    artifact: String,
    binary: String,
}
fn cache_prefix(item: &Artifact) -> String {
    format!("node-{VERSION}-{}-", &item.sha256[..12])
}
fn cached(
    root: &Path,
    item: &Artifact,
    mut validate: impl FnMut(&Path) -> Result<(), String>,
) -> Result<Option<PathBuf>, String> {
    if !root.exists() {
        return Ok(None);
    }
    crate::background::private_root(root)?;
    let mut dirs = fs::read_dir(root)
        .map_err(|_| "Cannot inspect private Node cache")?
        .filter_map(Result::ok)
        .filter(|d| {
            d.file_name()
                .to_string_lossy()
                .starts_with(&cache_prefix(item))
        })
        .map(|d| d.path())
        .collect::<Vec<_>>();
    dirs.sort();
    for dir in dirs {
        let valid = (|| -> Result<PathBuf, String> {
            let meta = fs::symlink_metadata(&dir).map_err(|_| "Invalid Node cache")?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("Invalid Node cache".into());
            }
            crate::background::private_root(&dir)?;
            let mut bytes = Vec::new();
            crate::background::private_file(&dir.join("receipt.json"), false)?
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| "Invalid Node receipt")?;
            if bytes.len() > 4096 {
                return Err("Invalid Node receipt".into());
            }
            let receipt: Receipt =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid Node receipt")?;
            let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            if receipt.artifact != item.sha256 || receipt.binary != file_digest(&node)? {
                return Err("Private Node checksum mismatch".into());
            }
            validate(&node)?;
            Ok(node)
        })();
        if let Ok(node) = valid {
            return Ok(Some(node));
        }
    }
    Ok(None)
}
fn copy_bounded(
    reader: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
) -> Result<u64, String> {
    let mut size = 0;
    let mut bytes = [0; 65536];
    loop {
        let n = reader
            .read(&mut bytes)
            .map_err(|_| "Node download/read failed")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > limit {
            return Err("Node runtime exceeds size limit".into());
        }
        output
            .write_all(&bytes[..n])
            .map_err(|_| "Cannot write private Node runtime")?;
    }
    if size == 0 {
        return Err("Empty Node runtime download".into());
    }
    Ok(size)
}
struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn install(
    root: &Path,
    item: &Artifact,
    fetch: impl FnOnce(&mut fs::File) -> Result<(), String>,
    validate: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    crate::background::private_root(root)?;
    let token = crate::agent_bridge::credential()?;
    let stage = Stage(root.join(format!(".install-{token}")));
    fs::create_dir(&stage.0).map_err(|_| "Cannot stage private Node runtime")?;
    crate::background::private_root(&stage.0)?;
    let archive = stage.0.join("download");
    let mut output = crate::background::private_file(&archive, true)?;
    fetch(&mut output)?;
    output
        .sync_all()
        .map_err(|_| "Cannot persist Node download")?;
    drop(output);
    if file_digest(&archive)? != item.sha256 {
        return Err("Node download checksum mismatch".into());
    }
    let node = stage
        .0
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if let Some(member) = &item.member {
        let input = crate::background::private_file(&archive, false)?;
        // Only one regular member is copied; tar paths are never unpacked into the filesystem.
        let decoder = flate2::read::GzDecoder::new(input);
        let mut tar = tar::Archive::new(decoder.take(600 * 1024 * 1024));
        let mut found = false;
        for entry in tar.entries().map_err(|_| "Invalid Node archive")? {
            let mut entry = entry.map_err(|_| "Invalid Node archive")?;
            if entry.path_bytes().as_ref() != member.as_bytes() {
                continue;
            }
            if found || !entry.header().entry_type().is_file() || entry.size() > LIMIT {
                return Err("Invalid Node executable member".into());
            }
            let mut output = crate::background::private_file(&node, true)?;
            copy_bounded(&mut entry, &mut output, LIMIT)?;
            output
                .sync_all()
                .map_err(|_| "Cannot persist Node executable")?;
            found = true;
        }
        if !found {
            return Err("Node executable missing from archive".into());
        }
    } else {
        fs::rename(&archive, &node).map_err(|_| "Cannot stage Node executable")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect Node executable")?;
    }
    #[cfg(windows)]
    crate::background::protect_windows_path(&node)?;
    let receipt = Receipt {
        artifact: item.sha256.clone(),
        binary: file_digest(&node)?,
    };
    validate(&node)?;
    let mut report = crate::background::private_file(&stage.0.join("receipt.json"), true)?;
    report
        .write_all(&serde_json::to_vec(&receipt).map_err(|_| "Cannot encode Node receipt")?)
        .map_err(|_| "Cannot write Node receipt")?;
    report
        .sync_all()
        .map_err(|_| "Cannot persist Node receipt")?;
    drop(report);
    if archive.exists() {
        fs::remove_file(&archive).map_err(|_| "Cannot clean Node staging")?;
    }
    let target = root.join(format!("{}{token}", cache_prefix(item)));
    fs::rename(&stage.0, &target).map_err(|_| "Cannot publish private Node runtime")?;
    Ok(target.join(node.file_name().ok_or("Invalid Node executable name")?))
}
fn download(item: &Artifact, output: &mut fs::File) -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Cannot initialize Node download")?;
    let mut response = client
        .get(item.url())
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Cannot download Node from nodejs.org; check the network and retry")?;
    if response.content_length().is_some_and(|n| n > LIMIT) {
        return Err("Node download exceeds size limit".into());
    }
    copy_bounded(&mut response, output, LIMIT)?;
    Ok(())
}
fn select_or_install(
    nodes: &[PathBuf],
    root: &Path,
    item: &Artifact,
    allow_download: bool,
    status: impl Fn(&str),
    mut validate: impl FnMut(&Path) -> Result<(), String>,
    fetch: impl FnOnce(&mut fs::File) -> Result<(), String>,
) -> Result<PathBuf, String> {
    status("Checking terminal runtime…");
    for node in nodes {
        if validate(node).is_ok() {
            return Ok(node.clone());
        }
    }
    if let Some(node) = cached(root, item, &mut validate)? {
        return Ok(node);
    }
    if !allow_download {
        return Err(
            "Compatible Node is unavailable. Reopen YAM to prepare its private terminal runtime."
                .into(),
        );
    }
    crate::background::private_root(root)?;
    let deadline = Instant::now() + Duration::from_secs(200);
    let _guard = loop {
        match crate::background::OwnerLock::acquire(root) {
            Ok(guard) => break guard,
            Err(error) => {
                if error != "Another background instance owns this workspace"
                    || Instant::now() >= deadline
                {
                    return Err(format!(
                        "Cannot acquire private Node installation lock: {error}"
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    if let Some(node) = cached(root, item, &mut validate)? {
        return Ok(node);
    }
    status("Downloading YAM private terminal runtime…");
    install(root,item,fetch,validate).map_err(|error|format!("YAM terminal runtime setup failed: {error}. Existing tasks and global Node were not changed. Retry initialization when the network is available."))
}
pub(super) fn resolve(
    script: &Path,
    root: &Path,
    allow_download: bool,
    status: impl Fn(&str),
) -> Result<PathBuf, String> {
    let item = artifact_for(std::env::consts::OS, std::env::consts::ARCH)?;
    select_or_install(
        &candidates(&crate::agent_path()),
        root,
        &item,
        allow_download,
        status,
        |p| probe(p, script),
        |out| download(&item, out),
    )
}
pub(super) fn background_node(args: &[std::ffi::OsString]) -> Result<Option<PathBuf>, String> {
    match args {
        [] => Ok(None),
        [flag, path] if flag == "--yam-terminal-node" && Path::new(path).is_absolute() => {
            Ok(Some(PathBuf::from(path)))
        }
        _ => Err("Invalid background startup arguments".into()),
    }
}
pub(super) fn prepare_cli(owner_root: &Path) -> Result<PathBuf, String> {
    let context = crate::app_context();
    let resources =
        tauri::utils::platform::resource_dir(context.package_info(), &tauri::utils::Env::default())
            .map_err(|e| e.to_string())?;
    let script = resources.join("target/terminal-runtime/yam-terminal.cjs");
    let cache = owner_root
        .parent()
        .ok_or("Invalid YAM data directory")?
        .join("runtimes/node");
    resolve(&script, &cache, true, |phase| eprintln!("[YAM] {phase}"))
}
fn initialize_once(
    ready: &std::sync::Mutex<bool>,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut ready = ready
        .lock()
        .map_err(|_| "Terminal runtime initialization lock poisoned")?;
    if !*ready {
        start()?;
        *ready = true;
    }
    Ok(())
}
#[tauri::command]
pub(super) async fn initialize_background(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        initialize_once(
            &app.state::<crate::SessionManager>().background_initialized,
            || {
                crate::background::attach(&app)?;
                app.state::<crate::SessionManager>()
                    .background_starting
                    .store(false, std::sync::atomic::Ordering::Release);
                Ok(())
            },
        )
    })
    .await
    .map_err(|_| "Terminal runtime initialization failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Cursor, path::PathBuf};
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("yam-node-{}", crate::next_session_id()));
            crate::background::private_root(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn archive(name: &str, body: &[u8], kind: tar::EntryType) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(gz);
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(kind);
        header.set_cksum();
        tar.append_data(&mut header, name, body).unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }
    fn artifact(bytes: &[u8]) -> Artifact {
        Artifact {
            name: "node-v26.10.0-test.tar.gz".into(),
            sha256: hex_digest(bytes),
            member: Some("node-v26.10.0-test/bin/node".into()),
        }
    }
    #[test]
    fn selected_runtime_argument_is_absolute_literal_and_has_no_environment_effect() {
        let root = Root::new();
        let path = root.0.join("node with spaces");
        assert_eq!(background_node(&[]).unwrap(), None);
        assert_eq!(
            background_node(&["--yam-terminal-node".into(), path.as_os_str().into()]).unwrap(),
            Some(path)
        );
        for args in [
            vec!["node".into()],
            vec!["--yam-terminal-node".into(), "relative/node".into()],
            vec!["--unknown".into(), "/node".into()],
            vec!["--yam-terminal-node".into(), "/node".into(), "extra".into()],
        ] {
            assert!(background_node(&args).is_err());
        }
    }
    #[test]
    fn official_manifest_covers_six_platforms_and_rejects_unsupported() {
        for os in ["macos", "linux", "windows"] {
            for arch in ["aarch64", "x86_64"] {
                let item = artifact_for(os, arch).unwrap();
                assert_eq!(item.sha256.len(), 64);
                assert!(item.url().starts_with("https://nodejs.org/dist/v26.10.0/"));
                assert_eq!(item.member.is_none(), os == "windows");
            }
        }
        assert!(artifact_for("macos", "x86").is_err());
        assert!(artifact_for("freebsd", "x86_64").is_err());
    }
    #[test]
    fn versions_use_a_minimum_and_capabilities_not_a_minor_whitelist() {
        for v in ["22.0.0", "24.16.1", "25.9.0", "26.10.0", "99.1.0"] {
            assert!(compatible_version(v), "{v}");
        }
        for v in [
            "20.20.0",
            "21.9.0",
            "garbage",
            "22",
            "22.0.0-nightly",
            "22.0.0.1",
        ] {
            assert!(!compatible_version(v), "{v}");
        }
    }
    #[test]
    fn verified_install_is_private_cached_and_never_replaces_existing_files() {
        let root = Root::new();
        let bytes = archive(
            "node-v26.10.0-test/bin/node",
            b"fake-node",
            tar::EntryType::Regular,
        );
        let item = artifact(&bytes);
        let node = install(
            &root.0,
            &item,
            |out| {
                std::io::copy(&mut Cursor::new(&bytes), out).unwrap();
                Ok(())
            },
            |p| {
                assert_eq!(fs::read(p).unwrap(), b"fake-node");
                Ok(())
            },
        )
        .unwrap();
        assert!(node.is_absolute());
        assert_eq!(
            cached(&root.0, &item, |_| Ok(())).unwrap(),
            Some(node.clone())
        );
        fs::write(&node, b"corrupt").unwrap();
        assert_eq!(cached(&root.0, &item, |_| Ok(())).unwrap(), None);
        let other = install(
            &root.0,
            &item,
            |out| {
                std::io::copy(&mut Cursor::new(&bytes), out).unwrap();
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
        assert_ne!(other, node);
        assert_eq!(fs::read(node).unwrap(), b"corrupt");
    }
    #[test]
    fn bad_download_archive_and_probe_never_publish_or_leave_staging() {
        let root = Root::new();
        let bytes = archive(
            "node-v26.10.0-test/bin/node",
            b"fake",
            tar::EntryType::Regular,
        );
        let item = artifact(&bytes);
        assert!(install(&root.0, &item, |_| Err("offline".into()), |_| Ok(())).is_err());
        assert!(install(
            &root.0,
            &item,
            |out| {
                out.write_all(b"tamper").unwrap();
                Ok(())
            },
            |_| panic!("unverified execution")
        )
        .is_err());
        for body in [
            archive("wrong/bin/node", b"fake", tar::EntryType::Regular),
            archive("node-v26.10.0-test/bin/node", b"", tar::EntryType::Symlink),
            b"not gzip".to_vec(),
        ] {
            let invalid = artifact(&body);
            assert!(install(
                &root.0,
                &invalid,
                |out| {
                    out.write_all(&body).unwrap();
                    Ok(())
                },
                |_| panic!("invalid archive execution")
            )
            .is_err());
        }
        assert!(install(
            &root.0,
            &item,
            |out| {
                out.write_all(&bytes).unwrap();
                Ok(())
            },
            |_| Err("incompatible".into())
        )
        .is_err());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
    #[test]
    fn download_limit_checks_boundary_and_cleans_no_global_state() {
        let mut out = Vec::new();
        assert!(copy_bounded(&mut Cursor::new(b"abc"), &mut out, 3).is_ok());
        assert!(copy_bounded(&mut Cursor::new(b"abcd"), &mut Vec::new(), 3).is_err());
        assert!(copy_bounded(&mut Cursor::new(b""), &mut Vec::new(), 3).is_err());
        let root = Root::new();
        let first = root.0.join("a");
        let second = root.0.join("b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let paths =
            std::env::join_paths([PathBuf::from("."), first.clone(), first.clone(), second])
                .unwrap();
        let found = candidates(&paths);
        assert!(found.iter().all(|p| p.is_absolute()));
        assert_eq!(found.len(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn late_installed_node_after_long_or_duplicate_path_never_downloads() {
        use std::os::unix::fs::PermissionsExt;
        let root = Root::new();
        let installed = root.0.join("installed");
        fs::create_dir(&installed).unwrap();
        let node = installed.join("node");
        fs::write(&node, b"fixture").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        let empty = (0..65)
            .map(|index| {
                let p = root.0.join(format!("empty-{index}"));
                fs::create_dir(&p).unwrap();
                p
            })
            .collect::<Vec<_>>();
        for mut dirs in [empty.clone(), vec![empty[0].clone(); 65]] {
            dirs.push(installed.clone());
            let path = std::env::join_paths(dirs).unwrap();
            let nodes = candidates(&path);
            assert_eq!(nodes, vec![node.canonicalize().unwrap()]);
            let selected = select_or_install(
                &nodes,
                &root.0.join("cache"),
                &artifact(b"not downloaded"),
                true,
                |_| {},
                |_| Ok(()),
                |_| panic!("Compatible installed Node must not download"),
            )
            .unwrap();
            assert_eq!(selected, node.canonicalize().unwrap());
            assert!(!root.0.join("cache").exists());
        }
    }
    #[test]
    fn verified_cache_after_many_invalid_entries_still_works_offline() {
        let root = Root::new();
        let bytes = archive(
            "node-v26.10.0-test/bin/node",
            b"node",
            tar::EntryType::Regular,
        );
        let item = artifact(&bytes);
        let node = install(
            &root.0,
            &item,
            |out| {
                out.write_all(&bytes).unwrap();
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
        let last = root.0.join(format!("{}zz-last", cache_prefix(&item)));
        fs::rename(node.parent().unwrap(), &last).unwrap();
        for index in 0..65 {
            fs::create_dir(root.0.join(format!("{}00-{index:02}", cache_prefix(&item)))).unwrap();
        }
        let selected = select_or_install(
            &[],
            &root.0,
            &item,
            false,
            |_| {},
            |_| Ok(()),
            |_| panic!("Offline cache must not download"),
        )
        .unwrap();
        assert_eq!(
            selected,
            last.join(if cfg!(windows) { "node.exe" } else { "node" })
        );
    }
    #[test]
    fn installed_then_cache_then_download_and_offline_error() {
        let root = Root::new();
        let item = artifact(b"fake");
        let installed = root.0.join("system-node");
        let cache = root.0.join("cache");
        let result = select_or_install(
            &[installed.clone()],
            &cache,
            &item,
            true,
            |_| {},
            |p| {
                assert_eq!(p, installed);
                Ok(())
            },
            |_| panic!("installed Node must avoid downloads"),
        )
        .unwrap();
        assert_eq!(result, installed);
        assert!(!cache.exists());
        let error = select_or_install(
            &[],
            &cache,
            &item,
            false,
            |_| {},
            |_| Ok(()),
            |_| panic!("offline owner must not download"),
        )
        .unwrap_err();
        assert!(error.contains("Compatible Node"));
        assert!(!cache.exists());
        let error = select_or_install(
            &[],
            &cache,
            &item,
            true,
            |_| {},
            |_| Ok(()),
            |_| Err("offline".into()),
        )
        .unwrap_err();
        assert!(error.contains("offline"));
        assert!(!fs::read_dir(&cache).unwrap().any(|v| v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".install")));
    }
    #[test]
    fn concurrent_preparation_downloads_once_and_reuses_verified_cache() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        };
        let root = Root::new();
        let bytes = Arc::new(archive(
            "node-v26.10.0-test/bin/node",
            b"node",
            tar::EntryType::Regular,
        ));
        let barrier = Arc::new(Barrier::new(2));
        let downloads = Arc::new(AtomicUsize::new(0));
        let handles = (0..2)
            .map(|_| {
                let root = root.0.clone();
                let bytes = bytes.clone();
                let barrier = barrier.clone();
                let downloads = downloads.clone();
                std::thread::spawn(move || {
                    let item = artifact(&bytes);
                    barrier.wait();
                    select_or_install(
                        &[],
                        &root,
                        &item,
                        true,
                        |_| {},
                        |_| Ok(()),
                        |out| {
                            downloads.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(50));
                            out.write_all(&bytes).unwrap();
                            Ok(())
                        },
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let paths = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(paths[0], paths[1]);
        assert_eq!(downloads.load(Ordering::SeqCst), 1);
    }
    #[test]
    #[ignore = "Downloads the pinned official Node to an isolated temporary directory"]
    fn official_private_download_and_offline_cache_reuse() {
        let root = Root::new();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/terminal-runtime");
        let script = dir.join("yam-terminal.cjs");
        let item = artifact_for(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let node = select_or_install(
            &[],
            &root.0,
            &item,
            true,
            |s| eprintln!("{s}"),
            |p| probe(p, &script),
            |out| download(&item, out),
        )
        .unwrap();
        let same = select_or_install(
            &[],
            &root.0,
            &item,
            false,
            |_| {},
            |p| probe(p, &script),
            |_| panic!("cache must not download"),
        )
        .unwrap();
        assert_eq!(same, node);
        probe(&node, &script).unwrap();
    }
    #[test]
    fn actual_script_accepts_installed_and_private_node() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/terminal-runtime");
        let script = dir.join("yam-terminal.cjs");
        assert!(script.is_file(), "build the script fixture first");
        let mut nodes = candidates(&crate::agent_path());
        let private = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if private.is_file() {
            nodes.push(private);
        }
        assert!(!nodes.is_empty(), "a compatible Node fixture is required");
        let mut passed = 0;
        for node in nodes {
            if probe(&node, &script).is_ok() {
                passed += 1;
            }
        }
        assert!(passed > 0);
        assert!(crate::terminal_runtime::Runtime::start_node(
            Path::new("node"),
            &script,
            |_, _| Ok(())
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn candidates_skip_relative_paths_and_private_cache_rejects_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = Root::new();
        let path = root.0.join("node");
        fs::write(&path, b"test").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let paths =
            std::env::join_paths([PathBuf::from("."), root.0.clone(), root.0.clone()]).unwrap();
        assert_eq!(candidates(&paths), vec![path.canonicalize().unwrap()]);
        let bytes = b"fake";
        let item = Artifact {
            name: "win-x64/node.exe".into(),
            sha256: hex_digest(bytes),
            member: None,
        };
        let node = install(
            &root.0.join("cache"),
            &item,
            |out| {
                out.write_all(bytes).unwrap();
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
        fs::remove_file(&node).unwrap();
        symlink(&path, &node).unwrap();
        assert_eq!(
            cached(&root.0.join("cache"), &item, |_| Ok(())).unwrap(),
            None
        );
    }
}

#[cfg(test)]
mod startup_tests {
    #[test]
    fn preparation_is_once_only_concurrent_and_retryable_after_failure() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        };
        let state = Arc::new(Mutex::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        assert!(super::initialize_once(&state, || Err("offline".into())).is_err());
        assert!(!*state.lock().unwrap());
        let handles = (0..2)
            .map(|_| {
                let state = state.clone();
                let calls = calls.clone();
                std::thread::spawn(move || {
                    super::initialize_once(&state, || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(25));
                        Ok(())
                    })
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
