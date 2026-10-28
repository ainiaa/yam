// Author: Jeff.Liu. Reuse Pi's terminal UI, native session tree and provider configuration.
use portable_pty::CommandBuilder;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const DEFAULT_ARGS: &str = "--yam-gateway http://127.0.0.1:3425 --yam-small yam-gateway/codex/gpt-6-luna --yam-strong yam-gateway/codex/gpt-6.1-sol";

pub(super) fn command(
    exe: &Path,
    launch: &crate::AgentLaunch,
    resuming: bool,
) -> Result<CommandBuilder, String> {
    if launch.mode != "interactive" || launch.provider.is_some() {
        return Err("Pi routing supports local interactive sessions using Pi configuration or its gateway flag".into());
    }
    let args = crate::parse_agent_args(if launch.extra_args.trim().is_empty() {
        DEFAULT_ARGS
    } else {
        &launch.extra_args
    })?;
    let mut retained = Vec::new();
    let (mut native_model, mut native_thinking, mut controlled_effort) = (false, false, false);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let key = arg.split('=').next().unwrap_or("");
        if matches!(
            key,
            "--session"
                | "--session-dir"
                | "--resume"
                | "--continue"
                | "-r"
                | "-c"
                | "--mode"
                | "--no-session"
                | "--no-extensions"
                | "--print"
                | "-p"
                | "--help"
                | "-h"
                | "--version"
                | "-v"
                | "--extension"
                | "-e"
        ) || arg == "--"
            || (!arg.starts_with('-'))
        {
            return Err("Pi session identity and YAM extension are managed by YAM; use native commands inside the session".into());
        }
        // Explicit options with values must stay literal, including values beginning with a dash.
        let takes_value = matches!(
            key,
            "--model"
                | "--thinking"
                | "--provider"
                | "--yam-small"
                | "--yam-strong"
                | "--yam-classifier"
                | "--yam-gateway"
                | "--yam-fixed-model"
                | "--yam-effort"
                | "--tools"
                | "--skill"
                | "--append-system-prompt"
                | "--system-prompt"
                | "--prompt-template"
                | "--theme"
        );
        if !takes_value
            && !matches!(
                key,
                "--no-skills" | "--no-prompt-templates" | "--offline" | "--no-themes"
            )
        {
            return Err(format!("Unsupported Pi launch flag: {key}; configure native settings or use the session commands"));
        }
        let value = if takes_value && !arg.contains('=') {
            Some(iter.next().ok_or("Missing Pi option value")?)
        } else {
            None
        };
        if resuming && matches!(key, "--model" | "--thinking" | "--provider") {
            continue;
        }
        native_model |= key == "--model";
        native_thinking |= key == "--thinking";
        controlled_effort |= key == "--yam-effort";
        retained.push(arg.clone());
        if let Some(v) = value {
            retained.push(v.clone());
        }
    }
    let mut b = CommandBuilder::new(exe);
    b.env("PATH", crate::agent_path());
    b.env(
        "YAM_PI_EXPLICIT_THINKING",
        if native_thinking { "1" } else { "0" },
    );
    if !resuming {
        if !native_model {
            b.args(["--model", "yam/auto"]);
        }
        if !native_model && !native_thinking && !controlled_effort {
            b.args(["--thinking", "off"]);
        }
    }
    b.args(retained);
    if let Some(prompt) = &launch.prompt {
        if !resuming {
            if prompt.contains('\0') || prompt.len() > 1024 * 1024 {
                return Err("Invalid Pi prompt".into());
            }
            b.args(["--", prompt]);
        }
    }
    Ok(b)
}
pub(super) fn stage(root: &Path) -> Result<PathBuf, String> {
    let sources = [
        ("entry.ts", include_str!("../pi/entry.ts")),
        ("router.mjs", include_str!("../pi/router.mjs")),
        ("policy.mjs", include_str!("../pi/policy.mjs")),
        ("control.mjs", include_str!("../pi/control.mjs")),
    ];
    let hash = format!(
        "{:x}",
        Sha256::digest(
            sources
                .iter()
                .map(|(_, s)| *s)
                .collect::<String>()
                .as_bytes()
        )
    );
    let parent = root.join("pi-router");
    crate::background::private_root(&parent)?;
    let directory = parent.join(hash);
    crate::background::private_root(&directory)?;
    for (name, source) in sources {
        let path = directory.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let mut bytes = Vec::new();
                crate::background::private_file(&path, false)?
                    .take(source.len() as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read Pi extension")?;
                if bytes != source.as_bytes() {
                    return Err("Pi extension was modified; refusing to launch".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut f = crate::background::private_file(&path, true)?;
                f.write_all(source.as_bytes())
                    .and_then(|_| f.sync_all())
                    .map_err(|_| "Cannot save Pi extension")?;
            }
            Err(_) => return Err("Cannot inspect Pi extension".into()),
        }
    }
    Ok(directory.join("entry.ts"))
}
pub(super) fn session_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !crate::valid_resume_id(id) || id.len() != 36 {
        return Err("Invalid Pi session identity".into());
    }
    Ok(root.join("pi-sessions").join(format!("{id}.jsonl")))
}
pub(super) fn validate_session(root: &Path, id: &str, cwd: &Path) -> Result<(), String> {
    let file = session_file(root, id)?;
    let metadata = std::fs::symlink_metadata(&file)
        .map_err(|_| "Pi session is missing; no new conversation was created")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Invalid Pi session file".into());
    }
    // Pi creates ordinary files; the owned 0700 directory protects its transcript without altering Pi's writes.
    crate::background::private_root(file.parent().ok_or("Invalid Pi session directory")?)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let input = options.open(&file).map_err(|_| "Cannot open Pi session")?;
    let meta = input.metadata().map_err(|_| "Cannot inspect Pi session")?;
    if !meta.is_file() {
        return Err("Invalid Pi session file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err("Pi session belongs to another user".into());
        }
    }
    let mut reader = std::io::BufReader::new(input.take(65537));
    use std::io::BufRead;
    let mut line = Vec::new();
    reader
        .read_until(b'\n', &mut line)
        .map_err(|_| "Cannot read Pi session")?;
    if line.len() > 65536 || line.last() != Some(&b'\n') {
        return Err("Invalid Pi session header".into());
    }
    let header: serde_json::Value =
        serde_json::from_slice(&line).map_err(|_| "Invalid Pi session header")?;
    let saved = header["cwd"]
        .as_str()
        .ok_or("Missing Pi project directory")?;
    let current = cwd
        .canonicalize()
        .map_err(|_| "Pi project is unavailable")?;
    let recorded = Path::new(saved)
        .canonicalize()
        .map_err(|_| "Pi project is unavailable")?;
    if header["type"] != "session" || recorded != current {
        return Err("Pi session belongs to a different project".into());
    }
    Ok(())
}

// Author: Jeff.Liu.
#[cfg(test)]
mod tests {
    use super::super::*;
    fn launch() -> AgentLaunch {
        serde_json::from_value(serde_json::json!({"adapter":"pi","mode":"interactive","extra_args":"--yam-small native/small --yam-strong native/strong","prompt":null})).unwrap()
    }
    #[test]
    fn pi_router_launch_accepts_native_role_flags_without_changing_official_defaults() {
        let builder = agent_command(Path::new("pi"), &launch())
            .expect("Pi auto router is an installed adapter");
        assert!(builder
            .get_argv()
            .windows(2)
            .any(|a| a == ["--model", "yam/auto"]));
        assert!(builder
            .get_argv()
            .windows(2)
            .any(|a| a == ["--yam-strong", "native/strong"]));
        let mut official = launch();
        official.adapter = "codex".into();
        official.extra_args = "--model chosen -c model_reasoning_effort=high".into();
        let before = agent_command(Path::new("codex"), &official).unwrap();
        assert!(!before.get_argv().iter().any(|v| v == "yam/auto"));
    }
    #[test]
    fn routing_review_pi_inline_model_effort_and_native_defaults_are_not_overridden() {
        for choice in ["native/strong:high", "native/strong"] {
            let mut l = launch();
            l.extra_args =
                format!("--model {choice} --yam-small native/small --yam-strong native/strong");
            let b = agent_command(Path::new("pi"), &l).unwrap();
            assert!(
                !b.get_argv().iter().any(|a| a == "--thinking"),
                "explicit physical model owns its native effort default"
            );
        }
    }
    #[test]
    fn pi_router_explicit_model_and_effort_are_preserved() {
        let mut manual = launch();
        manual.extra_args = "--model native/strong --thinking max".into();
        let b = agent_command(Path::new("pi"), &manual).unwrap();
        assert_eq!(b.get_argv().iter().filter(|a| *a == "--model").count(), 1);
        assert!(b.get_argv().windows(2).any(|a| a == ["--thinking", "max"]));
    }
    #[test]
    fn pi_router_native_session_restore_reads_normal_pi_permissions_and_rejects_wrong_project() {
        let root = std::env::temp_dir().join(format!("yam-pi-{}", next_session_id()));
        std::fs::create_dir_all(root.join("pi-sessions")).unwrap();
        let id = "01234567-1234-1234-1234-0123456789ab";
        let file = super::session_file(&root, id).unwrap();
        let project = root.join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(
            &file,
            format!("{}\n", serde_json::json!({"type":"session","cwd":project})),
        )
        .unwrap();
        assert!(super::validate_session(&root, id, &project).is_ok());
        assert!(super::validate_session(&root, id, Path::new("/other")).is_err());
        let physical = project.canonicalize().unwrap();
        std::fs::write(
            &file,
            format!("{}\n", serde_json::json!({"type":"session","cwd":physical})),
        )
        .unwrap();
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&project, &alias).unwrap();
            assert!(super::validate_session(&root, id, &alias).is_ok());
        }
        std::fs::write(&file, vec![b'x'; 65537]).unwrap();
        assert!(super::validate_session(&root, id, &project).is_err());
        assert!(super::validate_session(&root, "../escape", Path::new("/repo")).is_err());
        std::fs::remove_file(&file).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", &file).unwrap();
            assert!(super::validate_session(&root, id, Path::new("/repo")).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pi_router_resume_does_not_reapply_startup_selection_over_native_locks() {
        let mut l = launch();
        l.extra_args="--model native/small --thinking low --yam-small native/small --yam-strong native/strong".into();
        let b =
            resume_command(Path::new("pi"), &l, "01234567-1234-1234-1234-0123456789ab").unwrap();
        assert!(!b
            .get_argv()
            .iter()
            .any(|a| a == "--model" || a == "--thinking"));
        assert!(b.get_argv().iter().any(|a| a == "--yam-strong"));
    }
    #[test]
    fn pi_router_cannot_override_owned_session_or_disable_its_extension() {
        for args in [
            "--no-extensions",
            "--session /other",
            "--mode rpc",
            "--no-session",
        ] {
            let mut bad = launch();
            bad.extra_args = args.into();
            assert!(agent_command(Path::new("pi"), &bad).is_err(), "{args}");
        }
    }
}

// Private per-runtime descriptor; the frontend receives only its public state.
pub(super) fn control_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !id.starts_with("s-")
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid Pi runtime identity".into());
    }
    let directory = root.join("pi-controls");
    crate::background::private_root(&directory)?;
    Ok(directory.join(format!("{id}.json")))
}
fn descriptor(root: &Path, id: &str, generation: &str) -> Result<serde_json::Value, String> {
    let path = control_file(root, id)?;
    let mut bytes = Vec::new();
    crate::background::private_file(&path, false)?
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read Pi state")?;
    if bytes.len() > 65536 {
        return Err("Pi state exceeds limit".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Pi state")?;
    if value["v"] != 1
        || value["state"]["generation"].as_str() != Some(generation)
        || !value["token"]
            .as_str()
            .is_some_and(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
        || value["port"].as_u64().is_none_or(|p| p == 0 || p > 65535)
        || value["state"]["revision"].as_u64().is_none()
    {
        return Err("Pi state does not match this runtime generation".into());
    }
    Ok(value)
}
pub(super) fn read_state(
    root: &Path,
    record: &crate::SessionRecord,
) -> Result<serde_json::Value, String> {
    require_pi(record)?;
    let path = control_file(root, &record.summary.session_id)?;
    let state = if path.try_exists().map_err(|_| "Cannot inspect Pi state")? {
        descriptor(root, &record.summary.session_id, &record.agent.generation)?["state"].clone()
    } else {
        serde_json::Value::Null
    };
    Ok(
        serde_json::json!({"active":(["starting","running"].contains(&record.status.as_str())),"state":state}),
    )
}
fn require_pi(record: &crate::SessionRecord) -> Result<(), String> {
    if !record
        .summary
        .launch
        .as_ref()
        .is_some_and(|l| l.adapter == "pi")
    {
        return Err("Session is not a Pi runtime".into());
    }
    Ok(())
}
pub(super) fn control_request(
    root: &Path,
    record: &crate::SessionRecord,
    generation: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::net::{Shutdown, SocketAddr, TcpStream};
    use std::time::Duration;
    require_pi(record)?;
    if record.status != "running" || record.agent.generation != generation {
        return Err("Pi runtime ended or changed; refresh before changing routing".into());
    }
    let object = request.as_object().ok_or("Invalid Pi control")?;
    if object
        .keys()
        .any(|k| !["action", "revision", "data"].contains(&k.as_str()))
        || request["revision"].as_u64().is_none()
        || !["set", "reset", "retry", "catalog"].contains(&request["action"].as_str().unwrap_or(""))
        || request.to_string().len() > 8192
    {
        return Err("Invalid Pi control".into());
    }
    let value = descriptor(root, &record.summary.session_id, generation)?;
    let address = SocketAddr::from((
        [127, 0, 0, 1],
        value["port"].as_u64().ok_or("Invalid Pi control port")? as u16,
    ));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "Pi control connection unavailable")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(18)))
        .map_err(|_| "Pi control timeout unavailable")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Pi control timeout unavailable")?;
    let mut wire = request;
    wire["token"] = value["token"].clone();
    wire["generation"] = generation.into();
    stream
        .write_all(wire.to_string().as_bytes())
        .and_then(|_| stream.shutdown(Shutdown::Write))
        .map_err(|_| "Pi control disconnected")?;
    let mut bytes = Vec::new();
    stream
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Pi control response unavailable")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Pi control response exceeds limit".into());
    }
    let response: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Pi control response")?;
    if response["ok"] != true {
        return Err(response["error"]
            .as_str()
            .unwrap_or("Pi control rejected")
            .to_string());
    }
    if response["state"]["generation"] != generation {
        return Err("Pi runtime changed".into());
    }
    // Never forward arbitrary fields (including a descriptor credential) to the webview.
    Ok(serde_json::json!({"state":response["state"],"models":response["models"]}))
}
static CATALOG_PROBE: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(super) fn catalog(
    root: &Path,
    gateway: Option<&str>,
    cwd: &Path,
) -> Result<serde_json::Value, String> {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };
    let _probe = CATALOG_PROBE
        .try_lock()
        .map_err(|_| "A Pi catalog check is already running; retry shortly")?;
    if gateway.is_some_and(|s| s.len() > 2048 || s.chars().any(char::is_control)) {
        return Err("Invalid Pi gateway".into());
    }
    crate::validate_working_directory(&cwd.to_string_lossy())?;
    let exe = crate::find_executable("pi").ok_or("Pi executable unavailable")?;
    let entry = stage(root)?;
    let mut command = Command::new(exe);
    command
        .args([
            "--mode",
            "rpc",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
            "--offline",
            "--no-session",
            "--extension",
        ])
        .arg(entry)
        .arg("--yam-catalog-probe")
        .current_dir(cwd)
        .env("PATH", crate::agent_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("YAM_") {
            command.env_remove(key);
        }
    }
    if let Some(gateway) = gateway {
        command.args(["--yam-gateway", gateway]);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start Pi catalog preflight")?;
    let output = child.stdout.take().ok_or("Pi catalog output unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output.take(2 * 1024 * 1024)).lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let value =
                    if value["type"] == "extension_ui_request" && value["method"] == "notify" {
                        serde_json::from_str(value["message"].as_str().unwrap_or(""))
                            .unwrap_or(serde_json::Value::Null)
                    } else {
                        value
                    };
                if value["type"] == "yam_catalog" {
                    let _ = sender.send(value);
                    return;
                }
            }
        }
    });
    let result = receiver
        .recv_timeout(Duration::from_secs(18))
        .map_err(|_| "Pi catalog unavailable or timed out".to_string());
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    let value = result?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.to_string());
    }
    let models = value["models"].as_array().ok_or("Invalid Pi catalog")?;
    if models.len() > 4096
        || models
            .iter()
            .any(|m| m["key"].as_str().is_none_or(|k| k.len() > 512) || !m["levels"].is_array())
    {
        return Err("Invalid Pi catalog".into());
    }
    Ok(serde_json::json!({"models":models}))
}

#[cfg(test)]
mod control_tests {
    use super::*;
    #[test]
    fn pi_control_descriptor_rejects_generation_links_and_oversize_without_exposing_secret() {
        let root = std::env::temp_dir().join(format!(
            "yam-pi-control-{}",
            crate::gemini_resume::new_id().unwrap()
        ));
        let path = control_file(&root, "s-pi-test").unwrap();
        let mut file = crate::background::private_file(&path, true).unwrap();
        let state = serde_json::json!({"v":1,"port":12345,"token":"a".repeat(64),"state":{"revision":1,"generation":"g"}});
        file.write_all(state.to_string().as_bytes()).unwrap();
        drop(file);
        assert!(descriptor(&root, "s-pi-test", "g").is_ok());
        assert!(descriptor(&root, "s-pi-test", "other").is_err());
        assert!(control_file(&root, "../escaped").is_err());
        std::fs::write(&path, vec![b'x'; 65537]).unwrap();
        assert!(descriptor(&root, "s-pi-test", "g").is_err());
        std::fs::remove_file(&path).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/dev/null", &path).unwrap();
            assert!(descriptor(&root, "s-pi-test", "g").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pi_owner_control_is_scoped_bounded_and_never_returns_descriptor_credentials() {
        use std::net::TcpListener;
        let root = std::env::temp_dir().join(format!(
            "yam-pi-control-wire-{}",
            crate::gemini_resume::new_id().unwrap()
        ));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let token = "a".repeat(64);
        let path = control_file(&root, "s-pi-wire").unwrap();
        let descriptor = serde_json::json!({"v":1,"port":listener.local_addr().unwrap().port(),"token":token,"state":{"generation":"g","revision":1}});
        crate::background::private_file(&path, true)
            .unwrap()
            .write_all(descriptor.to_string().as_bytes())
            .unwrap();
        let agent = crate::agent_events::AgentState {
            generation: "g".into(),
            ..Default::default()
        };
        let mut record:crate::SessionRecord=serde_json::from_value(serde_json::json!({"summary":{"session_id":"s-pi-wire","cwd":"/tmp","command":null,"status":"running","launch":{"adapter":"pi","mode":"interactive","extra_args":"","prompt":null}},"status":"running","exit_code":null,"reason":null,"started_at":0,"ended_at":null,"agent":agent})).unwrap();
        assert_eq!(read_state(&root, &record).unwrap()["active"], true);
        let request = serde_json::json!({"action":"catalog","revision":1});
        assert!(control_request(&root, &record, "old", request.clone()).is_err());
        assert!(control_request(
            &root,
            &record,
            "g",
            serde_json::json!({"action":"execute","revision":1})
        )
        .is_err());
        record.status = "stopped".into();
        assert!(control_request(&root, &record, "g", request.clone()).is_err());
        record.status = "running".into();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut raw = String::new();
            stream.read_to_string(&mut raw).unwrap();
            let wire: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(wire["token"], token);
            assert_eq!(wire["generation"], "g");
            assert_eq!(wire["action"], "catalog");
            stream.write_all(serde_json::json!({"ok":true,"token":token,"state":{"generation":"g","revision":2},"models":[]}).to_string().as_bytes()).unwrap();
        });
        let reply = control_request(&root, &record, "g", request).unwrap();
        worker.join().unwrap();
        assert!(reply.get("token").is_none());
        assert_eq!(reply["state"]["revision"], 2);
        record.summary.launch = None;
        assert!(read_state(&root, &record).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pi_structured_effort_does_not_inject_off_and_literal_values_are_not_options() {
        let launch = |extra_args: &str| {
            serde_json::from_value::<crate::AgentLaunch>(serde_json::json!({"adapter":"pi","mode":"interactive","extra_args":extra_args,"prompt":null})).unwrap()
        };
        let controlled = command(Path::new("pi"), &launch("--yam-effort auto"), false).unwrap();
        assert!(!controlled.get_argv().iter().any(|a| a == "--thinking"));
        let explicit = command(Path::new("pi"), &launch("--thinking off"), false).unwrap();
        assert_eq!(
            explicit.get_env("YAM_PI_EXPLICIT_THINKING"),
            Some(std::ffi::OsStr::new("1"))
        );
        let literal = command(
            Path::new("pi"),
            &launch("--append-system-prompt --model"),
            false,
        )
        .unwrap();
        assert!(literal.get_argv().iter().any(|a| a == "yam/auto"));
        assert_eq!(
            literal.get_env("YAM_PI_EXPLICIT_THINKING"),
            Some(std::ffi::OsStr::new("0"))
        );
    }
}
