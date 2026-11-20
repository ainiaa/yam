// Author: Jeff.Liu. Package the existing standalone Provider; OMP keeps its own terminal and sessions.
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Options {
    pub policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthSource {
    Yam,
    Pi,
}
impl Options {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if let Some(raw) = &self.policy {
            if raw.len() > 65536
                || !serde_json::from_str::<serde_json::Value>(raw).is_ok_and(|v| v.is_object())
            {
                return Err("Invalid OMP routing strategy".into());
            }
        }
        if self
            .session
            .as_ref()
            .is_some_and(|id| !crate::valid_resume_id(id))
        {
            return Err("Invalid OMP session identity".into());
        }
        Ok(())
    }
}
pub(crate) fn prepare_launch(
    launch: &mut crate::AgentLaunch,
    resuming: bool,
) -> Result<(), String> {
    if launch.adapter != "omp" {
        return Ok(());
    }
    if !cfg!(target_os = "macos") || launch.mode != "interactive" || launch.provider.is_some() {
        return Err(
            "OMP requires a local macOS interactive terminal using its routing strategy".into(),
        );
    }
    let options = launch.omp.get_or_insert_with(Options::default);
    options.validate()?;
    if options.auth.is_none() {
        options.auth = Some(if resuming {
            AuthSource::Pi
        } else {
            AuthSource::Yam
        });
    }
    if resuming {
        if options.session.is_none() {
            return Err("OMP history has no trusted session directory".into());
        }
    } else {
        if options.session.is_some() {
            return Err("New OMP launches cannot select an existing conversation".into());
        }
        options.session = Some(crate::gemini_resume::new_id()?);
    }
    Ok(())
}
pub(crate) fn stage(root: &Path) -> Result<PathBuf, String> {
    static STAGE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = STAGE
        .lock()
        .map_err(|_| "Cannot lock OMP runtime staging")?;
    let sources = [
        (
            "extensions/omp-chatgpt/run.mjs",
            include_str!("../../../../extensions/omp-chatgpt/run.mjs"),
        ),
        (
            "extensions/omp-chatgpt/index.mjs",
            include_str!("../../../../extensions/omp-chatgpt/index.mjs"),
        ),
        (
            "extensions/omp-chatgpt/provider.mjs",
            include_str!("../../../../extensions/omp-chatgpt/provider.mjs"),
        ),
        (
            "extensions/omp-chatgpt/runtime.mjs",
            include_str!("../../../../extensions/omp-chatgpt/runtime.mjs"),
        ),
        (
            "extensions/omp-chatgpt/auth.mjs",
            include_str!("../../../../extensions/omp-chatgpt/auth.mjs"),
        ),
        (
            "extensions/omp-chatgpt/yam-auth.mjs",
            include_str!("../../../../extensions/omp-chatgpt/yam-auth.mjs"),
        ),
        (
            "extensions/omp-chatgpt/yam-auth-helper.mjs",
            include_str!("../../../../extensions/omp-chatgpt/yam-auth-helper.mjs"),
        ),
        (
            "extensions/omp-chatgpt/routing.mjs",
            include_str!("../../../../extensions/omp-chatgpt/routing.mjs"),
        ),
        (
            "extensions/omp-chatgpt/routing-policy.mjs",
            include_str!("../../../../extensions/omp-chatgpt/routing-policy.mjs"),
        ),
        (
            "extensions/omp-chatgpt/auth-job.mjs",
            include_str!("../../../../extensions/omp-chatgpt/auth-job.mjs"),
        ),
        (
            "extensions/omp-chatgpt/desktop.mjs",
            include_str!("../../../../extensions/omp-chatgpt/desktop.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/task-rules.mjs",
            include_str!("../pi/task-rules.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/policy.mjs",
            include_str!("../pi/policy.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/failure.mjs",
            include_str!("../pi/failure.mjs"),
        ),
    ];
    let hash = format!(
        "{:x}",
        Sha256::digest(
            sources
                .iter()
                .map(|(p, s)| format!("{p}\0{s}\0"))
                .collect::<String>()
                .as_bytes()
        )
    );
    let parent = root.join("omp-runtime");
    crate::background::private_root(&parent)?;
    let destination = parent.join(hash);
    crate::background::private_root(&destination)?;
    for (name, source) in sources {
        let mut parent = destination.clone();
        let path = Path::new(name);
        for part in path.parent().unwrap().components() {
            parent.push(part);
            crate::background::private_root(&parent)?;
        }
        let file = destination.join(name);
        match std::fs::symlink_metadata(&file) {
            Ok(_) => {
                let mut bytes = Vec::new();
                crate::background::private_file(&file, false)?
                    .take(source.len() as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read OMP runtime")?;
                if bytes != source.as_bytes() {
                    return Err("OMP runtime was modified".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                crate::background::private_file(&file, true)?
                    .write_all(source.as_bytes())
                    .map_err(|_| "Cannot stage OMP runtime")?;
            }
            Err(_) => return Err("Cannot inspect OMP runtime".into()),
        }
    }
    Ok(destination.join("extensions/omp-chatgpt/run.mjs"))
}
fn session_dir(root: &Path, options: &Options) -> Result<PathBuf, String> {
    options.validate()?;
    let id = options
        .session
        .as_ref()
        .ok_or("Missing managed OMP session directory")?;
    let parent = root.join("omp-sessions");
    crate::background::private_root(&parent)?;
    let path = parent.join(id);
    crate::background::private_root(&path)?;
    Ok(path)
}
pub(crate) fn validate_session(
    root: &Path,
    launch: &crate::AgentLaunch,
    id: &str,
    cwd: &Path,
) -> Result<PathBuf, String> {
    if !crate::valid_resume_id(id) {
        return Err("Invalid OMP conversation identity".into());
    }
    let dir = session_dir(
        root,
        launch
            .omp
            .as_ref()
            .ok_or("Missing OMP launch configuration")?,
    )?;
    let entries = std::fs::read_dir(dir).map_err(|_| "Cannot inspect OMP sessions")?;
    for (index, entry) in entries.enumerate() {
        if index >= 128 {
            return Err("OMP session directory exceeds its inspection budget".into());
        }
        let path = entry.map_err(|_| "Cannot inspect OMP session")?.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let file = crate::background::private_file(&path, false)?;
        let mut reader = std::io::BufReader::new(file.take(16385));
        let mut header = String::new();
        let mut bytes = 0;
        loop {
            header.clear();
            let read = reader
                .read_line(&mut header)
                .map_err(|_| "Cannot read OMP session header")?;
            bytes += read;
            if bytes > 16384 {
                return Err("OMP session header is too large".into());
            }
            if read == 0 {
                break;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&header) else {
                break;
            };
            // OMP can prepend title metadata when it rewrites a saved conversation.
            if value["type"] == "title" {
                continue;
            }
            if value["type"] == "session" && value["id"] == id {
                let saved = value["cwd"]
                    .as_str()
                    .ok_or("OMP session directory is missing")?;
                if Path::new(saved).canonicalize().ok() != cwd.canonicalize().ok() || !cwd.is_dir()
                {
                    return Err("OMP conversation belongs to another directory".into());
                }
                return Ok(path);
            }
            break;
        }
    }
    Err("Trusted OMP conversation was not found; the original prompt will not be replayed".into())
}
pub(crate) fn validate_launch(launch: &crate::AgentLaunch) -> Result<Vec<String>, String> {
    if launch.mode != "interactive" || launch.provider.is_some() {
        return Err("OMP requires a managed interactive terminal".into());
    }
    let options = launch
        .omp
        .as_ref()
        .ok_or("Missing managed OMP configuration")?;
    options.validate()?;
    let mut args = Vec::new();
    let parsed = crate::parse_agent_args(&launch.extra_args)?;
    let mut iter = parsed.iter();
    while let Some(arg) = iter.next() {
        let name = arg.split('=').next().unwrap_or("");
        let value = matches!(
            name,
            "--model"
                | "--thinking"
                | "--tools"
                | "--skills"
                | "--system-prompt"
                | "--append-system-prompt"
                | "--max-time"
                | "--max-cost"
                | "--warn-cost"
        );
        if !value
            && !matches!(
                name,
                "--no-tools"
                    | "--no-lsp"
                    | "--no-pty"
                    | "--no-skills"
                    | "--no-rules"
                    | "--no-context-files"
                    | "--hide-thinking"
                    | "--no-title"
            )
            || options.policy.is_some() && matches!(name, "--model" | "--thinking")
        {
            return Err(format!(
                "OMP session and routing options are managed by YAM: {name}"
            ));
        }
        args.push(arg.clone());
        if value && !arg.contains('=') {
            args.push(iter.next().ok_or("Missing OMP option value")?.clone());
        }
    }
    Ok(args)
}
pub(crate) fn command(
    executable: &Path,
    launch: &crate::AgentLaunch,
    root: &Path,
    resume: Option<&Path>,
) -> Result<CommandBuilder, String> {
    let args = validate_launch(launch)?;
    let options = launch.omp.as_ref().unwrap();
    let node = crate::find_executable("node")
        .ok_or("Node.js is required for the OMP Provider launcher")?;
    let mut b = CommandBuilder::new(node);
    b.arg(stage(root)?);
    b.args(args);
    b.env("PATH", crate::agent_path());
    b.env_remove("NODE_OPTIONS");
    b.env_remove("NODE_PATH");
    b.env("YAM_OMP_EXECUTABLE", executable);
    b.env("YAM_OMP_DESKTOP", "1");
    b.env(
        "YAM_OMP_AUTH_SOURCE",
        if options.auth == Some(AuthSource::Pi) {
            "pi"
        } else {
            "yam"
        },
    );
    b.env("YAM_OMP_AUTH_DIR", root.join("omp-auth"));
    b.env(
        "YAM_OMP_AUTH_OWNER_DESCRIPTOR",
        root.parent()
            .ok_or("Missing OMP owner root")?
            .join("background/connection.json"),
    );
    b.env("YAM_OMP_POLICY", options.policy.as_deref().unwrap_or(""));
    b.env("YAM_OMP_SESSION_DIR", session_dir(root, options)?);
    b.env_remove("YAM_OMP_RESUME");
    if let Some(path) = resume {
        b.env("YAM_OMP_RESUME", path);
    }
    if let Some(prompt) = launch.prompt.as_ref().filter(|_| resume.is_none()) {
        if prompt.contains('\0') || prompt.len() > 1024 * 1024 {
            return Err("Invalid OMP prompt".into());
        }
        b.args(["--", prompt]);
    }
    Ok(b)
}

// A login shell can restore environment variables after the PTY builder was serialized.
pub(crate) fn sanitize_process(child: &mut std::process::Command) {
    child.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    if !child
        .get_envs()
        .any(|(key, value)| key == "YAM_OMP_RESUME" && value.is_some())
    {
        child.env_remove("YAM_OMP_RESUME");
    }
}

pub(crate) fn authorize_auth_job(
    record: &crate::SessionRecord,
    generation: &str,
) -> Result<(), String> {
    if !["starting", "running"].contains(&record.status.as_str())
        || record.agent.generation != generation
        || !record.summary.launch.as_ref().is_some_and(|l| {
            l.adapter == "omp"
                && l.omp
                    .as_ref()
                    .is_some_and(|o| o.auth == Some(AuthSource::Yam))
        })
    {
        return Err("No current YAM-authenticated OMP session".into());
    }
    Ok(())
}

// Spawn from the owner so terminal tree cleanup cannot kill an accepted rotating grant.
pub(crate) fn start_auth_job(root: &Path) -> Result<serde_json::Value, String> {
    let node =
        crate::find_executable("node").ok_or("Node is unavailable for YAM authentication")?;
    spawn_auth_job(&node, &stage(root)?, &root.join("omp-auth"))
}
pub(super) fn spawn_auth_job(
    node: &Path,
    entry: &Path,
    auth: &Path,
) -> Result<serde_json::Value, String> {
    use std::{
        process::{Command, Stdio},
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 16).then_some(n + 1)
        })
        .map_err(|_| "YAM authentication capacity reached")?;
    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg("--yam-auth-broker")
        .env("YAM_OMP_AUTH_DIR", auth)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => {
            ACTIVE.fetch_sub(1, Ordering::AcqRel);
            return Err("Cannot start YAM authentication worker".into());
        }
    };
    let output = child
        .stdout
        .take()
        .ok_or("Missing authentication worker pipe")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = tx.send(
            std::io::BufReader::new(output.take(1025))
                .read_line(&mut line)
                .map(|_| line),
        );
    });
    let ready = rx
        .recv_timeout(Duration::from_secs(8))
        .ok()
        .and_then(Result::ok)
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| {
            v["address"]
                .as_str()
                .and_then(|s| s.parse::<std::net::SocketAddr>().ok())
                .is_some_and(|a| {
                    a.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) && a.port() != 0
                })
                && v["token"]
                    .as_str()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        });
    if ready.is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
        return Err("YAM authentication worker did not become ready".into());
    }
    std::thread::spawn(move || {
        let _ = child.wait();
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    });
    Ok(ready.unwrap())
}
