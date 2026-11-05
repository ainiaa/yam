// Author: Jeff.Liu. Pi owns package installation and personal settings writes.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
const LIMIT: usize = 2 * 1024 * 1024;
static PACKAGE_WRITE: Mutex<()> = Mutex::new(());
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    List,
    Search { query: String },
    Install { source: String, revision: String },
    Remove { source: String, revision: String },
}
fn resolve_dir(home: &Path, configured: Option<&str>) -> Result<PathBuf, String> {
    let path = match configured.filter(|s| !s.is_empty()) {
        None => home.join(".pi/agent"),
        Some(s) if s.starts_with("~/") => home.join(&s[2..]),
        Some(s) => PathBuf::from(s),
    };
    if !home.is_absolute() || !path.is_absolute() {
        return Err("Pi configuration directory must be absolute".into());
    }
    Ok(path)
}
fn valid_name(name: &str) -> bool {
    fn part(s: &str) -> bool {
        !s.is_empty()
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
    }
    if name.len() > 214 {
        return false;
    }
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, name)| part(scope) && part(name))
    } else {
        part(name)
    }
}
fn valid_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 128 {
        return false;
    }
    let mut build = version.split('+');
    let main = build.next().unwrap_or("");
    let identifiers = |s: &str| {
        !s.is_empty()
            && s.split('.').all(|part| {
                !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
    };
    if build.next().is_some_and(|s| !identifiers(s)) || build.next().is_some() {
        return false;
    }
    let (numbers, pre) = main
        .split_once('-')
        .map_or((main, None), |(a, b)| (a, Some(b)));
    let parts = numbers.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))
        })
        && pre.is_none_or(identifiers)
}
fn parse_source(source: &str, pinned: bool) -> Result<(String, Option<String>), String> {
    let body = source
        .strip_prefix("npm:")
        .ok_or("Only npm Pi packages are supported here")?;
    let (name, version) = body
        .rfind('@')
        .filter(|i| *i > 0)
        .map_or((body, None), |i| (&body[..i], Some(&body[i + 1..])));
    if !valid_name(name)
        || version.is_some_and(|v| !valid_version(v))
        || pinned && version.is_none()
    {
        return Err("Invalid Pi npm package or exact version".into());
    }
    Ok((name.into(), version.map(str::to_owned)))
}
fn npm_name(source: &str) -> Option<&str> {
    let body = source.strip_prefix("npm:")?;
    let offset = usize::from(body.starts_with('@'));
    let name = &body[..body[offset..]
        .find('@')
        .map_or(body.len(), |at| at + offset)];
    valid_name(name).then_some(name)
}
fn snapshot(dir: &Path, available: bool) -> Result<Value, String> {
    let path = dir.join("settings.json");
    let bytes = match fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Ok(meta) if meta.is_file() && meta.len() <= LIMIT as u64 => {
            let mut bytes = Vec::new();
            fs::File::open(&path)
                .map_err(|_| "Cannot read Pi personal settings")?
                .take(LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read Pi personal settings")?;
            if bytes.len() > LIMIT {
                return Err("Pi personal settings are too large".into());
            }
            bytes
        }
        _ => return Err("Pi personal settings are unavailable or too large".into()),
    };
    let settings: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
            .map_err(|_| "Pi personal settings contain invalid JSON")?
    };
    if !settings.is_object() {
        return Err("Pi personal settings must be an object".into());
    }
    let mut packages = Vec::new();
    let mut configured_names = Vec::new();
    let mut counts = HashMap::new();
    let mut other_count = 0;
    if let Some(configured) = settings.get("packages") {
        let rows = configured
            .as_array()
            .filter(|r| r.len() <= 512)
            .ok_or("Invalid Pi packages configuration")?;
        for row in rows {
            let source = row
                .as_str()
                .or_else(|| row.get("source").and_then(Value::as_str))
                .ok_or("Invalid Pi package source in personal settings")?;
            if let Some(name) = npm_name(source) {
                *counts.entry(name).or_insert(0usize) += 1;
                if !configured_names.contains(&name) {
                    configured_names.push(name);
                }
            }
            if let Ok((name, _)) = parse_source(source, false) {
                packages.push(json!({"name":name,"source":source}));
            } else {
                other_count += 1;
            }
        }
    }
    let managed = packages.len();
    packages.retain(|p| counts.get(p["name"].as_str().unwrap_or("")).copied() == Some(1));
    other_count += managed - packages.len();
    Ok(
        json!({"revision":format!("{:x}",Sha256::digest(&bytes)),"packages":packages,"configured_names":configured_names,"other_count":other_count,"pi_available":available}),
    )
}
fn clean_description(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !c.is_control() && !matches!(*c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
        })
        .take(500)
        .collect()
}
fn decode_search(value: &Value) -> Result<Value, String> {
    let rows = value["objects"]
        .as_array()
        .filter(|a| a.len() <= 250)
        .ok_or("Invalid Pi package search response")?;
    let mut seen = HashSet::new();
    let mut packages = Vec::new();
    for row in rows {
        let p = &row["package"];
        let (Some(name), Some(version)) = (p["name"].as_str(), p["version"].as_str()) else {
            continue;
        };
        if !valid_name(name)
            || !valid_version(version)
            || !p["keywords"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|k| k == "pi-package"))
            || !seen.insert(name)
        {
            continue;
        }
        packages.push(json!({"name":name,"version":version,"source":format!("npm:{name}@{version}"),"description":clean_description(p["description"].as_str().unwrap_or(""))}));
        if packages.len() == 30 {
            break;
        }
    }
    Ok(json!({"packages":packages}))
}
fn change_args(state: &Value, request: &Value) -> Result<Vec<String>, String> {
    let request: Request =
        serde_json::from_value(request.clone()).map_err(|_| "Invalid Pi package request")?;
    let (action, source, revision, pinned) = match request {
        Request::Install { source, revision } => ("install", source, revision, true),
        Request::Remove { source, revision } => ("remove", source, revision, false),
        _ => return Err("Invalid Pi package mutation".into()),
    };
    if !state["pi_available"].as_bool().unwrap_or(false) {
        return Err("Pi executable unavailable".into());
    }
    if state["revision"].as_str() != Some(&revision) {
        return Err("Pi packages changed; refresh before continuing".into());
    }
    let (name, _) = parse_source(&source, pinned)?;
    let installed = state["packages"]
        .as_array()
        .ok_or("Invalid Pi package state")?;
    if action == "install"
        && state["configured_names"]
            .as_array()
            .ok_or("Invalid Pi package state")?
            .iter()
            .any(|p| p == &name)
    {
        return Err("This Pi package is already configured; no settings were replaced".into());
    }
    if action == "remove" && !installed.iter().any(|p| p["source"] == source) {
        return Err("This Pi package is no longer configured; refresh before continuing".into());
    }
    if action == "install"
        && installed.len() as u64 + state["other_count"].as_u64().unwrap_or(0) >= 512
    {
        return Err("Pi package limit reached; manage existing references through Pi CLI".into());
    }
    Ok(vec![action.into(), source])
}
fn registry_json(url: reqwest::Url) -> Result<Value, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Pi package search is unavailable")?;
    let response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Cannot reach the npm registry; try again later")?;
    let mut bytes = Vec::new();
    response
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the npm registry response")?;
    if bytes.len() > LIMIT {
        return Err("The npm registry response is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid npm registry response".into())
}
fn search(query: &str) -> Result<Value, String> {
    if query.len() > 200 || query.chars().any(char::is_control) {
        return Err("Pi package search is too long or invalid".into());
    }
    let mut url = reqwest::Url::parse("https://registry.npmjs.org/-/v1/search").unwrap();
    url.query_pairs_mut()
        .append_pair("text", &format!("keywords:pi-package {}", query.trim()))
        .append_pair("size", "50");
    decode_search(&registry_json(url)?)
}
fn verify_package(source: &str) -> Result<(), String> {
    let (name, version) = parse_source(source, true)?;
    let version = version.unwrap();
    let mut url = reqwest::Url::parse("https://registry.npmjs.org/").unwrap();
    url.path_segments_mut().unwrap().push(&name).push(&version);
    let value = registry_json(url)?;
    if value["name"] != name
        || value["version"] != version
        || !value["keywords"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|k| k == "pi-package"))
    {
        return Err("This version is not a discoverable Pi package; refresh the market".into());
    }
    Ok(())
}
fn run_command(exe: &Path, dir: &Path, args: &[String], timeout: Duration) -> Result<(), String> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .current_dir(dir)
        .env("PATH", crate::agent_path())
        .env("PI_CODING_AGENT_DIR", dir)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("YAM_") {
            command.env_remove(key);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start Pi package management")?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else if status.code() == Some(4) {
                    Err("Pi packages changed; refresh before continuing".into())
                } else {
                    Err(
                        "Pi package operation failed; refresh the installed list before retrying"
                            .into(),
                    )
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => break,
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("Pi package operation timed out; refresh the installed list before retrying".into())
}
fn package_sdk_args(
    pi: &Path,
    dir: &Path,
    args: &[String],
    revision: &str,
) -> Result<Vec<String>, String> {
    if args.len() != 2 {
        return Err("Invalid Pi package mutation".into());
    }
    let executable = pi
        .canonicalize()
        .map_err(|_| "Pi package SDK unavailable")?;
    let root = executable
        .ancestors()
        .skip(1)
        .take(4)
        .find(|candidate| {
            fs::read(candidate.join("package.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some_and(|manifest| {
                    matches!(
                        manifest["name"].as_str(),
                        Some("@earendil-works/pi-coding-agent" | "@mariozechner/pi-coding-agent")
                    )
                })
                && candidate.join("dist/index.js").is_file()
        })
        .ok_or("Pi package SDK unavailable")?;
    let mut script = include_str!("../pi/packages.mjs").to_string();
    script.push_str("\ntry{await main(process.argv.slice(1));}catch(error){process.exitCode=error?.code===\"PI_SETTINGS_CHANGED\"?4:1;}");
    Ok(vec![
        "--input-type=module".into(),
        "-e".into(),
        script,
        "--".into(),
        root.to_str().ok_or("Pi package SDK unavailable")?.into(),
        dir.to_str().ok_or("Pi package SDK unavailable")?.into(),
        args[0].clone(),
        args[1].clone(),
        revision.into(),
    ])
}
fn run_package_sdk(pi: &Path, dir: &Path, args: &[String], revision: &str) -> Result<(), String> {
    let node = crate::find_executable("node").ok_or("Pi package SDK unavailable")?;
    run_command(
        &node,
        dir,
        &package_sdk_args(pi, dir, args, revision)?,
        Duration::from_secs(120),
    )
}
fn change_packages(
    dir: &Path,
    executable: Option<&Path>,
    request: &Value,
    verify: impl FnOnce(&str) -> Result<(), String>,
    run: impl FnOnce(&Path, &[String]) -> Result<(), String>,
) -> Result<Value, String> {
    let state = snapshot(dir, executable.is_some())?;
    let args = change_args(&state, request)?;
    if args[0] == "install" {
        verify(&args[1])?;
    }
    change_args(&snapshot(dir, executable.is_some())?, request)?;
    fs::create_dir_all(dir).map_err(|_| "Cannot open the Pi personal configuration directory")?;
    run(executable.ok_or("Pi executable unavailable")?, &args)?;
    let after = snapshot(dir, true)?;
    let (name, _) = parse_source(&args[1], false)?;
    let persisted = if args[0] == "install" {
        after["packages"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|p| p["source"] == args[1]))
    } else {
        !after["configured_names"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|p| p == &name))
    };
    if !persisted {
        return Err(
            "Pi did not persist the package change; refresh the installed list before retrying"
                .into(),
        );
    }
    Ok(after)
}
pub(super) fn handle(home: &Path, request: Value) -> Result<Value, String> {
    let parsed: Request =
        serde_json::from_value(request.clone()).map_err(|_| "Invalid Pi package request")?;
    if let Request::Search { query } = parsed {
        return search(&query);
    }
    let configured = std::env::var("PI_CODING_AGENT_DIR").ok();
    let dir = resolve_dir(home, configured.as_deref())?;
    let executable = crate::find_executable("pi");
    if matches!(parsed, Request::List) {
        return snapshot(&dir, executable.is_some());
    }
    let _write = PACKAGE_WRITE
        .try_lock()
        .map_err(|_| "A Pi package operation is already running")?;
    change_packages(
        &dir,
        executable.as_deref(),
        &request,
        verify_package,
        |exe, args| run_package_sdk(exe, &dir, args, request["revision"].as_str().unwrap_or("")),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, time::Duration};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("yam-pi-packages-{}", crate::next_session_id()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn pi_packages_sources_are_literal_npm_names_and_exact_versions() {
        for name in ["npm:pi-test@1.2.3", "npm:@scope/pi-test@1.0.0-beta.1"] {
            assert!(parse_source(name, true).is_ok(), "{name}");
        }
        assert_eq!(
            parse_source("npm:@scope/pi-test", false).unwrap(),
            ("@scope/pi-test".into(), None)
        );
        for value in [
            "npm:pi-test",
            "npm:pi-test@latest",
            "npm:pi-test@^1",
            "npm:../test@1.0.0",
            "npm:pi-test@1.0.0;echo BAD",
            "npm:pi-test@1.0.0\n",
            "--approve",
            "git:github.com/a/b",
            "file:/tmp/test",
            "npm:a/b@1.0.0",
            "npm:UPPER@1.0.0",
        ] {
            assert!(parse_source(value, true).is_err(), "{value}");
        }
        assert!(parse_source(&format!("npm:{}@1.0.0", "a".repeat(215)), true).is_err());
    }
    #[test]
    fn pi_packages_profile_matches_native_personal_scope() {
        assert_eq!(
            resolve_dir(Path::new("/home/user"), None).unwrap(),
            PathBuf::from("/home/user/.pi/agent")
        );
        assert_eq!(
            resolve_dir(Path::new("/home/user"), Some("~/custom pi")).unwrap(),
            PathBuf::from("/home/user/custom pi")
        );
        assert!(resolve_dir(Path::new("/home/user"), Some("relative")).is_err());
    }
    #[test]
    fn pi_packages_snapshot_preserves_native_filters_and_never_returns_private_settings() {
        let f = Fixture::new();
        assert_eq!(snapshot(&f.0, true).unwrap()["packages"], json!([]));
        let original = json!({"theme":"dark","secret":"DO_NOT_EXPOSE","packages":["npm:pi-one@1.2.3",{"source":"npm:@scope/pi-two","extensions":[]},"git:https://private:password@example.com/repo"]});
        fs::write(f.0.join("settings.json"), original.to_string()).unwrap();
        let s = snapshot(&f.0, true).unwrap();
        assert_eq!(s["packages"].as_array().unwrap().len(), 2);
        assert_eq!(s["other_count"], 1);
        assert!(!s.to_string().contains("DO_NOT_EXPOSE"));
        assert!(!s.to_string().contains("password"));
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(f.0.join("settings.json")).unwrap()).unwrap(),
            original
        );
        fs::write(f.0.join("settings.json"), "{broken").unwrap();
        assert!(snapshot(&f.0, true).is_err());
        fs::write(f.0.join("settings.json"), " ".repeat(2 * 1024 * 1024 + 1)).unwrap();
        assert!(snapshot(&f.0, true).is_err());
    }
    #[test]
    fn pi_packages_search_filters_non_pi_invalid_versions_duplicates_and_unsafe_text() {
        let row = |name: &str, version: &str, pi: bool| json!({"package":{"name":name,"version":version,"description":"useful\u{001b}[31m plugin","keywords":if pi{json!(["pi-package"])}else{json!(["other"])}}});
        let result=decode_search(&json!({"objects":[row("pi-valid","1.0.0",true),row("ordinary","1.0.0",false),row("pi-valid","1.0.0",true),row("--bad","1.0.0",true),row("pi-bad","latest",true)]})).unwrap();
        assert_eq!(result["packages"].as_array().unwrap().len(), 1);
        assert_eq!(result["packages"][0]["source"], "npm:pi-valid@1.0.0");
        assert!(!result.to_string().contains("\\u001b"));
        assert!(decode_search(&json!({"objects":"bad"})).is_err());
    }
    #[test]
    fn pi_packages_changes_reject_stale_overwrites_and_unconfigured_removals() {
        let f = Fixture::new();
        fs::write(
            f.0.join("settings.json"),
            json!({"packages":[{"source":"npm:pi-one@1.0.0","extensions":[]}]}).to_string(),
        )
        .unwrap();
        let s = snapshot(&f.0, true).unwrap();
        let revision = s["revision"].as_str().unwrap();
        assert_eq!(
            change_args(
                &s,
                &json!({"action":"install","source":"npm:pi-two@2.0.0","revision":revision})
            )
            .unwrap(),
            vec!["install", "npm:pi-two@2.0.0"]
        );
        assert_eq!(
            change_args(
                &s,
                &json!({"action":"remove","source":"npm:pi-one@1.0.0","revision":revision})
            )
            .unwrap(),
            vec!["remove", "npm:pi-one@1.0.0"]
        );
        for request in [
            json!({"action":"install","source":"npm:pi-one@2.0.0","revision":revision}),
            json!({"action":"remove","source":"npm:pi-absent","revision":revision}),
            json!({"action":"remove","source":"npm:pi-one@1.0.0","revision":"stale"}),
            json!({"action":"install","source":"npm:pi-new@1.0.0","revision":revision,"local":true}),
            json!({"action":"update","source":"npm:pi-one@1.0.0","revision":revision}),
        ] {
            assert!(change_args(&s, &request).is_err());
        }
    }
    #[test]
    fn pi_packages_rechecks_external_settings_changes_after_registry_verification() {
        let f = Fixture::new();
        let path = f.0.join("settings.json");
        fs::write(&path, json!({"packages":[],"keep":true}).to_string()).unwrap();
        let before = snapshot(&f.0, true).unwrap();
        let request =
            json!({"action":"install","source":"npm:pi-test@1.0.0","revision":before["revision"]});
        let ran = std::cell::Cell::new(false);
        let external=json!({"packages":[{"source":"npm:pi-test@latest","extensions":["kept.ts"]}],"keep":true}).to_string();
        let error = change_packages(
            &f.0,
            Some(Path::new("owned-pi")),
            &request,
            |_| {
                fs::write(&path, &external).unwrap();
                Ok(())
            },
            |_, _| {
                ran.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("changed"));
        assert!(!ran.get());
        assert_eq!(fs::read_to_string(path).unwrap(), external);
    }
    #[test]
    fn pi_packages_zero_exit_without_persisted_change_is_not_success() {
        for action in ["install", "remove"] {
            let f = Fixture::new();
            let packages = if action == "remove" {
                json!(["npm:pi-test@1.0.0"])
            } else {
                json!([])
            };
            fs::write(
                f.0.join("settings.json"),
                json!({"packages":packages,"keep":true}).to_string(),
            )
            .unwrap();
            let before = snapshot(&f.0, true).unwrap();
            let request =
                json!({"action":action,"source":"npm:pi-test@1.0.0","revision":before["revision"]});
            let error = change_packages(
                &f.0,
                Some(Path::new("owned-pi")),
                &request,
                |_| Ok(()),
                |_, _| Ok(()),
            )
            .unwrap_err();
            assert!(error.contains("did not persist"));
        }
    }
    #[test]
    fn pi_packages_verified_install_and_remove_preserve_unrelated_configuration() {
        let f = Fixture::new();
        let path = f.0.join("settings.json");
        fs::write(
            &path,
            json!({"packages":[],"keep":{"untouched":true}}).to_string(),
        )
        .unwrap();
        for action in ["install", "remove"] {
            let before = snapshot(&f.0, true).unwrap();
            let request =
                json!({"action":action,"source":"npm:pi-test@1.0.0","revision":before["revision"]});
            let result = change_packages(
                &f.0,
                Some(Path::new("owned-pi")),
                &request,
                |_| {
                    assert_eq!(action, "install");
                    Ok(())
                },
                |_, args| {
                    assert_eq!(
                        &args[..2],
                        &[action.to_string(), "npm:pi-test@1.0.0".to_string()]
                    );
                    let mut saved: Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    saved["packages"] = if action == "install" {
                        json!(["npm:pi-test@1.0.0"])
                    } else {
                        json!([])
                    };
                    fs::write(&path, saved.to_string()).unwrap();
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                result["packages"].as_array().unwrap().len(),
                usize::from(action == "install")
            );
            let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(saved["keep"], json!({"untouched":true}));
        }
    }
    #[test]
    fn pi_packages_duplicate_npm_sources_are_read_only_and_capacity_is_bounded() {
        let f = Fixture::new();
        let path = f.0.join("settings.json");
        fs::write(&path,json!({"packages":["npm:pi-one@1.0.0",{"source":"npm:pi-one@latest","extensions":["keep.ts"]},"npm:pi-one@npm:@scope/other@1.0.0"]}).to_string()).unwrap();
        let state = snapshot(&f.0, true).unwrap();
        assert_eq!(state["packages"], json!([]));
        assert_eq!(state["configured_names"], json!(["pi-one"]));
        assert_eq!(state["other_count"], 3);
        fs::write(
            &path,
            json!({"packages":vec!["npm:pi-one@1.0.0";512]}).to_string(),
        )
        .unwrap();
        let state = snapshot(&f.0, true).unwrap();
        assert!(change_args(
            &state,
            &json!({"action":"install","source":"npm:pi-new@1.0.0","revision":state["revision"]})
        )
        .unwrap_err()
        .contains("limit"));
    }
    #[test]
    fn pi_packages_sdk_arguments_are_literal_and_resolve_only_the_installed_pi_package() {
        let f = Fixture::new();
        let root = f.0.join("sdk");
        fs::create_dir_all(root.join("dist/cli")).unwrap();
        fs::write(
            root.join("package.json"),
            json!({"name":"@earendil-works/pi-coding-agent"}).to_string(),
        )
        .unwrap();
        let cli = root.join("dist/cli/main.js");
        fs::write(&cli, "").unwrap();
        fs::write(root.join("dist/index.js"), "").unwrap();
        let revision = "a".repeat(64);
        let args = package_sdk_args(
            &cli,
            &f.0,
            &["install".into(), "npm:pi-test@1.0.0".into()],
            &revision,
        )
        .unwrap();
        assert_eq!(&args[0..2], &["--input-type=module", "-e"]);
        assert!(args[2].contains("projectTrusted:false"));
        assert_eq!(
            &args[3..],
            &[
                "--".to_string(),
                root.canonicalize().unwrap().to_str().unwrap().into(),
                f.0.to_str().unwrap().into(),
                "install".into(),
                "npm:pi-test@1.0.0".into(),
                revision
            ]
        );
        fs::write(
            root.join("package.json"),
            json!({"name":"other"}).to_string(),
        )
        .unwrap();
        assert!(package_sdk_args(&cli, &f.0, &[], "").is_err());
    }
    #[test]
    fn pi_packages_registry_client_is_safe_on_cold_start() {
        const CHILD: &str = "YAM_PI_REGISTRY_COLD_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "pi_packages::tests::pi_packages_registry_client_is_safe_on_cold_start",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "cold registry child failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
        });
        assert_eq!(
            registry_json(format!("http://{address}/").parse().unwrap()).unwrap(),
            json!({})
        );
        server.join().unwrap();
    }
    #[test]
    fn pi_packages_range_and_tag_identities_cannot_be_replaced_by_discovery() {
        let f = Fixture::new();
        let path = f.0.join("settings.json");
        let original=json!({"packages":[{"source":"npm:pi-test@^1.0.0","extensions":["kept.ts"]},"npm:@scope/tool@latest"]}).to_string();
        fs::write(&path, &original).unwrap();
        let state = snapshot(&f.0, true).unwrap();
        assert_eq!(state["configured_names"], json!(["pi-test", "@scope/tool"]));
        assert_eq!(state["packages"], json!([]));
        for name in ["pi-test", "@scope/tool"] {
            assert!(change_args(&state,&json!({"action":"install","source":format!("npm:{name}@2.0.0"),"revision":state["revision"]})).unwrap_err().contains("already configured"));
        }
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }
    #[test]
    fn pi_packages_busy_mutation_is_rejected_without_launch_or_config_write() {
        let f = Fixture::new();
        let _busy = PACKAGE_WRITE.lock().unwrap();
        let error = handle(
            &f.0,
            json!({"action":"install","source":"npm:pi-safe@1.0.0","revision":"a".repeat(64)}),
        )
        .unwrap_err();
        assert_eq!(error, "A Pi package operation is already running");
        assert!(!f.0.join(".pi").exists());
    }
    #[cfg(unix)]
    #[test]
    fn pi_packages_stale_sdk_exit_is_not_a_generic_installer_error() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let exe = f.0.join("owned-stale");
        fs::write(&exe, "#!/bin/sh\nexit 4\n").unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(run_command(&exe, &f.0, &[], Duration::from_secs(2))
            .unwrap_err()
            .contains("changed"));
    }
    #[cfg(unix)]
    #[test]
    fn pi_packages_native_command_is_bounded_literal_and_redacts_child_failure() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let exe = f.0.join("fake-pi");
        fs::write(&exe,"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PI_CODING_AGENT_DIR/args\"\nprintf PRIVATE_ERROR >&2\nexit 1\n").unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
        let args = vec![
            "install".into(),
            "npm:@scope/pi-test@1.0.0".into(),
            "--no-approve".into(),
        ];
        let err = run_command(&exe, &f.0, &args, Duration::from_secs(2)).unwrap_err();
        assert!(!err.contains("PRIVATE_ERROR"));
        assert_eq!(
            fs::read_to_string(f.0.join("args")).unwrap(),
            "install\nnpm:@scope/pi-test@1.0.0\n--no-approve\n"
        );
        fs::write(&exe, "#!/bin/sh\nsleep 5 &\nwait\n").unwrap();
        let began = std::time::Instant::now();
        assert!(run_command(&exe, &f.0, &args, Duration::from_millis(100)).is_err());
        assert!(began.elapsed() < Duration::from_secs(2));
    }
}
