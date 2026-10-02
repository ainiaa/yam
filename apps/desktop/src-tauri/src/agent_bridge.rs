use crate::agent_events::AgentEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_WIRE_BYTES: u64 = 4096;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    version: u8,
    token: String,
    event: AgentEvent,
}
fn read_wire(reader: impl Read) -> Result<Wire, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_WIRE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_WIRE_BYTES {
        return Err("Agent event too large".into());
    }
    let wire: Wire = serde_json::from_slice(&bytes).map_err(|_| "Invalid agent event schema")?;
    if wire.version != 1
        || wire.token.len() != 64
        || !wire.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid agent protocol or credential".into());
    }
    Ok(wire)
}
fn read_connection(stream: &mut TcpStream, stopping: &AtomicBool) -> Result<Wire, String> {
    // Accepted sockets inherit nonblocking mode on some platforms. A per-read timeout
    // alone also lets a slow sender hold the only receiver indefinitely.
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_millis(350);
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        if stopping.load(Ordering::Acquire) {
            return Err("Agent bridge stopping".into());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Agent event deadline exceeded".into());
        }
        stream
            .set_read_timeout(Some(remaining.min(Duration::from_millis(50))))
            .map_err(|e| e.to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => return read_wire(bytes.as_slice()),
            Ok(size) => {
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.len() as u64 > MAX_WIRE_BYTES {
                    return Err("Agent event too large".into());
                }
                // Explicit framing avoids relying on runtimes' differing TCP half-close behavior.
                if bytes.ends_with(b"\n") {
                    return read_wire(bytes.as_slice());
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}
fn local_address(value: &str) -> Result<SocketAddr, String> {
    let address: SocketAddr = value.parse().map_err(|_| "Invalid agent address")?;
    if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) || address.port() == 0 {
        return Err("Agent address must be IPv4 loopback".into());
    }
    Ok(address)
}
fn previous_notify(response: &serde_json::Value) -> Result<Vec<String>, String> {
    let config = response
        .get("result")
        .and_then(|v| v.get("config"))
        .filter(|v| v.is_object())
        .ok_or("Cannot read effective agent configuration")?;
    if let Some(hooks) = config.get("hooks").filter(|v| !v.is_null()) {
        let hooks = hooks.as_object().ok_or("Invalid existing agent hooks")?;
        // CLI overrides replace config.toml arrays, unlike independent hook files.
        for kind in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "Interrupt",
            "PermissionRequest",
            "PostToolUse",
        ] {
            if let Some(groups) = hooks.get(kind) {
                let groups = groups.as_array().ok_or("Invalid existing agent hooks")?;
                if !groups.is_empty() {
                    return Err(format!("Existing {kind} config hooks require manual hook integration; existing CLI behavior is preserved"));
                }
            }
        }
    }
    match config.get("notify") {
        None | Some(serde_json::Value::Null) => Ok(vec![]),
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.contains(char::from(0)))
                    .map(str::to_string)
                    .ok_or_else(|| "Invalid existing notify callback".into())
            })
            .collect(),
        _ => Err("Invalid existing notify callback".into()),
    }
}
fn normalize(value: &serde_json::Value, notify: bool) -> Result<AgentEvent, String> {
    let kind = if notify {
        if value.get("type").and_then(|v| v.as_str()) != Some("agent-turn-complete") {
            return Err("Unsupported notify event".into());
        }
        "TurnComplete"
    } else {
        value
            .get("hook_event_name")
            .and_then(|v| v.as_str())
            .ok_or("Missing hook event")?
    };
    let kind = match kind {
        "PostToolUse" | "PostToolUseFailure" => "ToolProgress",
        other => other,
    };
    if ![
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "Interrupt",
        "PermissionRequest",
        "TurnComplete",
        "ToolProgress",
        "TurnFailed",
        "ResponseReady",
    ]
    .contains(&kind)
    {
        return Err("Unsupported hook event".into());
    }
    let identity = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map(str::to_string)
    };
    let agent_session_id = identity(if notify { "thread-id" } else { "session_id" })
        .ok_or("Missing agent session identity")?;
    let turn_id = identity(if notify { "turn-id" } else { "turn_id" });
    if kind != "SessionStart" && turn_id.is_none() {
        return Err("Missing agent turn identity".into());
    }
    Ok(AgentEvent {
        kind: kind.into(),
        agent_session_id,
        turn_id,
        source: None,
        permission_key: if ["PermissionRequest", "ToolProgress"].contains(&kind) {
            permission_key(value)
        } else {
            None
        },
    })
}
fn permission_key(value: &serde_json::Value) -> Option<String> {
    let name = value["tool_name"].as_str()?;
    if !value["tool_input"].is_object() {
        return None;
    }
    // ponytail: identical concurrent tool inputs share a key; use native call IDs
    // when the CLI supplies them. Correlation only, not a security identity. Keep commands and arguments
    // out of persisted receipts and diagnostics.
    let input = serde_json::to_vec(&serde_json::json!([name, value["tool_input"]])).ok()?;
    let hash = input.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    Some(format!("tool-{hash:016x}"))
}
fn normalize_claude(value: &serde_json::Value) -> Result<AgentEvent, String> {
    let kind = match value["hook_event_name"].as_str() {
        Some("SessionStart") => "SessionStart",
        Some("UserPromptSubmit") => "UserPromptSubmit",
        Some("PermissionRequest") => "PermissionRequest",
        Some("PostToolUse" | "PostToolUseFailure") => "ToolProgress",
        Some("StopFailure") => "TurnFailed",
        Some("Stop")
            if value["last_assistant_message"]
                .as_str()
                .is_some_and(|message| !message.trim().is_empty()) =>
        {
            "ResponseReady"
        }
        _ => return Err("Unsupported Claude hook event".into()),
    };
    // Claude prompt_id is the native per-prompt UUID. Never invent a counter or
    // read a potentially delayed transcript to correlate a turn.
    let mut event = normalize(
        &serde_json::json!({
            "hook_event_name":kind,
            "session_id":value["session_id"],
            "turn_id":value["prompt_id"],
        }),
        false,
    )?;
    event.source = Some("claude".into());
    if ["PermissionRequest", "ToolProgress"].contains(&event.kind.as_str()) {
        event.permission_key = permission_key(value);
    }
    Ok(event)
}
fn claude_args(exe: &str) -> Result<Vec<String>, String> {
    if exe.is_empty() || exe.contains(['\0', '\n', '\r']) {
        return Err("Invalid helper executable path".into());
    }
    let mut hooks = serde_json::Map::new();
    for kind in [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "StopFailure",
        "Stop",
    ] {
        // PermissionRequest carries tool identity; Notification(permission_prompt)
        // repeats the same request without that identity and cannot be cleared safely.
        let group = serde_json::json!({"hooks":[{"type":"command","command":exe,"args":["--yam-claude-hook"],"timeout":2}]});
        hooks.insert(kind.into(), serde_json::json!([group]));
    }
    Ok(vec![
        "--settings".into(),
        serde_json::json!({"hooks":hooks}).to_string(),
    ])
}
pub(super) fn credential() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    #[cfg(unix)]
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| "Secure random source unavailable")?;
    #[cfg(windows)]
    {
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(
                provider: *mut std::ffi::c_void,
                buffer: *mut u8,
                length: u32,
                flags: u32,
            ) -> i32;
        }
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG with a null provider uses the OS CSPRNG.
        if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 {
            return Err("Secure random source unavailable".into());
        }
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(super) struct Bridge {
    pub(super) address: SocketAddr,
    bindings: Arc<Mutex<HashMap<String, (String, String)>>>,
    history: Arc<super::HistoryStore>,
    stopping: Arc<AtomicBool>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    delivery_worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    pub(super) context: Arc<Mutex<(bool, Option<String>, bool)>>,
    pub(super) retry: Arc<std::sync::atomic::AtomicU64>,
}
impl Bridge {
    pub(super) fn retire_stopped(runtime: &mut Option<Self>) -> Result<(), String> {
        if let Some(bridge) = runtime.as_ref() {
            if bridge.stopping.load(Ordering::Acquire) {
                bridge.stop_until(std::time::Instant::now())?;
                *runtime = None;
            }
        }
        Ok(())
    }
    pub(super) fn start(
        history: Arc<super::HistoryStore>,
        changed: impl Fn(&str, Option<String>) + Send + 'static,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let bindings = Arc::new(Mutex::new(HashMap::<String, (String, String)>::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        let routes = bindings.clone();
        let stop = stopping.clone();
        let store = history.clone();
        let worker = std::thread::spawn(move || {
            // ponytail: serialize bounded local events; use a bounded worker pool only if measured hook latency requires it.
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        let result = (|| {
                            if peer.ip() != address.ip() {
                                return Err("Non-local agent event".into());
                            }
                            stream
                                .set_write_timeout(Some(Duration::from_millis(350)))
                                .map_err(|e| e.to_string())?;
                            let wire = read_connection(&mut stream, &stop)?;
                            let (id, generation) = routes
                                .lock()
                                .map_err(|_| "Agent routing lock poisoned")?
                                .get(&wire.token)
                                .cloned()
                                .ok_or("Unknown agent credential")?;
                            if let Err(error) = store.ingest_agent(&id, &generation, &wire.event) {
                                let _ = store.agent_failure(&id, &generation, &error);
                                changed(
                                    &id,
                                    Some(format!("Agent event could not be saved: {error}")),
                                );
                                return Err(error);
                            }
                            changed(&id, None);
                            Ok::<(), String>(())
                        })();
                        let _ = stream.write_all(if result.is_ok() {
                            b"{\"accepted\":true}"
                        } else {
                            b"{\"accepted\":false}"
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            address,
            bindings,
            history,
            stopping,
            worker: Mutex::new(Some(worker)),
            delivery_worker: Mutex::new(None),
            context: Arc::new(Mutex::new((false, None, false))),
            retry: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        })
    }
    pub(super) fn start_delivery(&self, app: tauri::AppHandle) -> Result<(), String> {
        use tauri::{Emitter, Manager};
        let mut worker = self
            .delivery_worker
            .lock()
            .map_err(|_| "Agent delivery lock poisoned")?;
        if worker.is_some() {
            return Ok(());
        }
        let history = self.history.clone();
        let context = self.context.clone();
        let stop = self.stopping.clone();
        let retry = self.retry.clone();
        *worker = Some(std::thread::spawn(move || {
            let mut queue = super::agent_events::DeliveryQueue::default();
            let started = std::time::Instant::now();
            let mut epoch = retry.load(Ordering::Acquire);
            while !stop.load(Ordering::Acquire) {
                if let Ok(context) = context.lock().map(|c| c.clone()) {
                    if epoch != retry.load(Ordering::Acquire) {
                        epoch = retry.load(Ordering::Acquire);
                        queue.retry();
                    }
                    let manager = app.state::<super::SessionManager>();
                    let foreground = if manager.background_owner {
                        manager.desktop_focus.lock().is_ok_and(|focus| {
                            focus.1 && focus.0.elapsed() < Duration::from_secs(3)
                        })
                    } else {
                        app.get_webview_window("main")
                            .is_some_and(|w| w.is_focused().unwrap_or(false))
                    };
                    let result = queue.tick(
                        &history,
                        started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        if foreground {
                            context.1.as_deref()
                        } else {
                            None
                        },
                        !context.0 || context.2,
                        |id, entry| {
                            let label = match entry.kind.as_str() {
                                "response_finished" => "Response finished",
                                "needs_permission" => "Permission required",
                                "interrupted" => "Round interrupted",
                                "failed" => "Round failed",
                                "needs_attention" => "Response ready; hooks may continue",
                                _ => "Agent attention",
                            };
                            history.native_delivery(
                                id,
                                super::agent_events::NativeSource::Round(entry),
                                |_| {
                                    super::send_native_notification(
                                        app.clone(),
                                        id.into(),
                                        format!("YAM · {label}"),
                                        format!("{label}. Open YAM to review this round."),
                                    )
                                },
                            )
                        },
                    );
                    match result {
                        Ok(ids) => {
                            for id in ids {
                                let _ = app.emit(
                                    "agent-state",
                                    super::SessionMessage {
                                        session_id: id,
                                        data: "updated".into(),
                                    },
                                );
                            }
                        }
                        Err(error) => {
                            let _ = app.emit(
                                "session-error",
                                super::SessionMessage {
                                    session_id: String::new(),
                                    data: error,
                                },
                            );
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }));
        Ok(())
    }
    pub(super) fn register(
        &self,
        session: &str,
        token: &str,
        generation: &str,
    ) -> Result<(), String> {
        let records = self.history.list()?;
        let mut routes = self
            .bindings
            .lock()
            .map_err(|_| "Agent routing lock poisoned")?;
        routes.retain(|_, (id, generation)| {
            records.iter().any(|r| {
                r.summary.session_id == *id
                    && r.agent.generation == *generation
                    && ["starting", "running"].contains(&r.status.as_str())
            })
        });
        if self.stopping.load(Ordering::Acquire) || routes.len() >= 256 {
            return Err("Agent bridge capacity reached or closing".into());
        }
        if !records
            .iter()
            .any(|r| r.summary.session_id == session && r.agent.generation == generation)
        {
            return Err("Unknown agent launch".into());
        }
        if token.len() != 64
            || !token.bytes().all(|b| b.is_ascii_hexdigit())
            || routes.contains_key(token)
        {
            return Err("Invalid or duplicate agent credential".into());
        }
        routes.insert(token.into(), (session.into(), generation.into()));
        Ok(())
    }
    pub(super) fn stop(&self) {
        let _ = self.stop_until(std::time::Instant::now() + Duration::from_millis(500));
    }
    pub(super) fn stop_until(&self, deadline: std::time::Instant) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        for worker in [&self.worker, &self.delivery_worker] {
            let mut worker = worker.lock().map_err(|_| "Agent cleanup lock poisoned")?;
            while worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
                if std::time::Instant::now() >= deadline {
                    return Err("Agent notification cleanup timed out; the application remains open and unread receipts are preserved".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if let Some(worker) = worker.take() {
                worker.join().map_err(|_| "Agent worker panicked")?;
            }
        }
        Ok(())
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop();
    }
}
fn submit(address: SocketAddr, token: &str, event: AgentEvent) -> Result<(), String> {
    let address = local_address(&address.to_string())?;
    let bytes = serde_json::to_vec(&Wire {
        version: 1,
        token: token.into(),
        event,
    })
    .map_err(|e| e.to_string())?;
    read_wire(bytes.as_slice())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(350)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(350)))
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|e| e.to_string())?;
    let mut reply = Vec::new();
    stream
        .take(128)
        .read_to_end(&mut reply)
        .map_err(|e| e.to_string())?;
    let accepted = serde_json::from_slice::<serde_json::Value>(&reply)
        .map_err(|_| "Invalid agent acknowledgement")?;
    if accepted.get("accepted").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Agent event was not committed".into());
    }
    Ok(())
}
fn forward_previous(args: &[String], raw: &str) -> Result<(), String> {
    let Some(program) = args.first() else {
        return Ok(());
    };
    let mut child = std::process::Command::new(program)
        .args(&args[1..])
        .arg(raw)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "Existing notify callback could not start")?;
    // The existing callback remains asynchronous; reap it without delaying the agent turn.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
pub(crate) fn helper_entry() -> bool {
    let mut args = std::env::args();
    args.next();
    let mode = args.next();
    let notify = match mode.as_deref() {
        Some("--yam-agent-hook") => false,
        Some("--yam-agent-notify") => true,
        Some("--yam-claude-hook") => false,
        _ => return false,
    };
    let raw = (|| {
        if notify {
            let raw = args.next().ok_or("Missing notify payload")?;
            if raw.len() > 512 * 1024 {
                return Err("Agent payload too large");
            }
            Ok(raw)
        } else {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(512 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read hook payload")?;
            if bytes.len() > 512 * 1024 {
                return Err("Agent payload too large");
            }
            String::from_utf8(bytes).map_err(|_| "Invalid hook encoding")
        }
    })();
    let result = (|| {
        let raw = raw.map_err(str::to_string)?;
        let original = (|| {
            if notify {
                let callback = std::env::var("YAM_PREVIOUS_NOTIFY")
                    .map_err(|_| "Missing preserved notify callback")?;
                let callback: Vec<String> = serde_json::from_str(&callback)
                    .map_err(|_| "Invalid preserved notify callback")?;
                forward_previous(&callback, &raw)
            } else {
                Ok(())
            }
        })();
        // Forwarding failure must not prevent YAM from receiving its own event.
        let own = (|| {
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|_| "Invalid native agent payload")?;
            let event = if mode.as_deref() == Some("--yam-claude-hook") {
                normalize_claude(&value)?
            } else {
                normalize(&value, notify)?
            };
            let address = local_address(
                &std::env::var("YAM_AGENT_ADDRESS").map_err(|_| "Missing agent address")?,
            )?;
            let token = std::env::var("YAM_AGENT_TOKEN").map_err(|_| "Missing agent credential")?;
            submit(address, &token, event)
        })();
        original.and(own)
    })();
    if result.is_err() {
        eprintln!("[YAM] Agent event integration degraded; open YAM for diagnostics");
    }
    if !notify {
        println!("{{}}");
    }
    true
}
fn effective_notify(
    program: &std::ffi::OsStr,
    prefix: &[std::ffi::OsString],
    cwd: &std::path::Path,
) -> Result<Vec<String>, String> {
    previous_notify(&agent_query(
        program,
        prefix,
        cwd,
        "config/read",
        serde_json::json!({"cwd":cwd.to_string_lossy(),"includeLayers":true}),
    )?)
}
fn agent_query(
    program: &std::ffi::OsStr,
    prefix: &[std::ffi::OsString],
    cwd: &std::path::Path,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::io::BufRead;
    let mut command = std::process::Command::new(program);
    command
        .args(prefix)
        .args(["app-server", "--listen", "stdio://"])
        .env("PATH", super::agent_path())
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start agent config query")?;
    #[cfg(windows)]
    let job = attach_query_job(&mut child)?;
    let stdout = child.stdout.take().ok_or("Missing config query output")?;
    let (send, receive) = std::sync::mpsc::sync_channel(4);
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout.take(1024 * 1024)).split(b'\n') {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else {
                break;
            };
            if value.get("id").is_some() && send.try_send(value).is_err() {
                break;
            }
        }
    });
    let result = (|| {
        let mut input = child.stdin.take().ok_or("Missing config query input")?;
        let write = |input: &mut std::process::ChildStdin,
                     value: serde_json::Value|
         -> Result<(), String> {
            serde_json::to_writer(&mut *input, &value).map_err(|e| e.to_string())?;
            input.write_all(b"\n").map_err(|e| e.to_string())
        };
        write(
            &mut input,
            serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"yam","version":"0.1.0"},"capabilities":{"experimentalApi":false}}}),
        )?;
        let initialized = receive
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Config query initialization timed out")?;
        if initialized.get("id").and_then(|v| v.as_u64()) != Some(1)
            || initialized.get("result").is_none()
        {
            return Err("Config query initialization failed".into());
        }
        write(&mut input, serde_json::json!({"method":"initialized"}))?;
        write(
            &mut input,
            serde_json::json!({"id":2,"method":method,"params":params}),
        )?;
        let response = receive
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Effective configuration query timed out")?;
        if response.get("id").and_then(|v| v.as_u64()) != Some(2) {
            return Err("Invalid config response identity".into());
        }
        if response.get("error").is_some() {
            return Err(
                "Agent query rejected; conversation or provider configuration is unavailable"
                    .into(),
            );
        }
        Ok(response)
    })();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    #[cfg(windows)]
    drop(job);
    let _ = child.wait();
    let _ = reader.join();
    result
}
#[cfg(windows)]
fn attach_query_job(child: &mut std::process::Child) -> Result<super::WindowsJob, String> {
    use std::os::windows::io::AsRawHandle;
    match super::WindowsJob::attach(child.as_raw_handle()) {
        Ok(job) => Ok(job),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}
fn injected_args(exe: &str) -> Result<Vec<String>, String> {
    if exe.is_empty() || exe.contains(char::from(0)) || exe.contains(['\n', '\r']) {
        return Err("Invalid helper executable path".into());
    }
    #[cfg(unix)]
    let command = format!("'{}' --yam-agent-hook", exe.replace('\'', "'\\''"));
    #[cfg(windows)]
    let command = {
        if exe.contains(['\"', '%', '!']) {
            return Err("Helper path cannot be safely quoted on Windows".into());
        }
        format!("\"{exe}\" --yam-agent-hook")
    };
    let mut args = vec![];
    for kind in [
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "Interrupt",
        "PermissionRequest",
        "PostToolUse",
    ] {
        args.push("-c".into());
        args.push(format!(
            "hooks.{kind}=[{{hooks=[{{type=\"command\",command={},timeout=2}}]}}]",
            serde_json::to_string(&command).map_err(|e| e.to_string())?
        ));
    }
    args.push("-c".into());
    args.push(format!(
        "notify={}",
        serde_json::to_string(&vec![exe, "--yam-agent-notify"]).map_err(|e| e.to_string())?
    ));
    Ok(args)
}
fn validate_hook_capabilities(
    response: &serde_json::Value,
    cwd: &std::path::Path,
) -> Result<(), String> {
    let entry = response["result"]["data"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["cwd"].as_str() == cwd.to_str())
        })
        .ok_or("Agent did not report hook capabilities for this directory")?;
    if !entry["errors"].as_array().is_some_and(Vec::is_empty) {
        return Err("Agent hook configuration is invalid".into());
    }
    let hooks = entry["hooks"]
        .as_array()
        .ok_or("Missing agent hook capabilities")?;
    for event in [
        "sessionStart",
        "userPromptSubmit",
        "stop",
        "interrupt",
        "permissionRequest",
        "postToolUse",
    ] {
        if !hooks.iter().any(|hook| {
            hook["eventName"].as_str() == Some(event)
                && hook["source"].as_str() == Some("sessionFlags")
                && hook["enabled"] == true
        }) {
            return Err("Agent does not support all required YAM session hooks".into());
        }
    }
    Ok(())
}
fn compatible_claude_version(output: &str) -> bool {
    let Some(version) = output.strip_suffix(" (Claude Code)") else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let numbers: Option<Vec<u64>> = parts.iter().map(|part| part.parse().ok()).collect();
    // ponytail: Claude exposes no hook-capability RPC; accept stable 2.x updates
    // from the measured exec-form baseline, and confirm connection via SessionStart.
    numbers.is_some_and(|v| v[0] == 2 && (v[1], v[2]) >= (1, 286))
}
fn compatible_opencode_version(output: &str) -> bool {
    let parts: Vec<_> = output.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let values: Option<Vec<u64>> = parts.iter().map(|p| p.parse().ok()).collect();
    // ponytail: OpenCode has no plugin capability query; confirm native message/event binding at launch.
    values.is_some_and(|v| v[0] == 1 && (v[1], v[2]) >= (18, 34))
}
fn opencode_config(original: Option<&str>, plugin: &str) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(original.filter(|s| !s.is_empty()).unwrap_or("{}"))
            .map_err(|_| "Existing OpenCode inline configuration cannot be safely merged")?;
    let object = value
        .as_object_mut()
        .ok_or("OpenCode inline configuration must be an object")?;
    let plugins = object
        .entry("plugin")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or("Existing OpenCode plugin list is invalid")?;
    plugins.push(serde_json::json!(plugin));
    serde_json::to_string(&value).map_err(|e| e.to_string())
}
fn opencode_plugin(assets: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let directory = assets.join("helpers");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    include_bytes!("opencode-plugin.mjs").hash(&mut hash);
    let path = directory.join(format!("opencode-{:016x}.mjs", hash.finish()));
    let source = include_bytes!("opencode-plugin.mjs");
    if !path.try_exists().map_err(|e| e.to_string())? {
        if let Err(error) = super::session_logs::write_export(&path, source) {
            if !path.try_exists().map_err(|e| e.to_string())? {
                return Err(format!("Cannot store YAM plugin: {error}"));
            }
        }
    }
    let mut bytes = vec![];
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(source.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes != source {
        return Err("Existing YAM OpenCode plugin differs; integration was not injected".into());
    }
    Ok(path)
}

pub(super) fn validate_interactive_args(adapter: &str, args: &[String]) -> Result<(), String> {
    let (values, flags): (&[&str], &[&str]) = if adapter == "opencode" {
        (&["--model", "-m", "--agent"], &[])
    } else if adapter == "claude" {
        (
            &[
                "--model",
                "--effort",
                "--permission-mode",
                "--append-system-prompt",
                "--system-prompt",
                "--name",
            ],
            &["--verbose"],
        )
    } else {
        (
            &[
                "--model",
                "-m",
                "--sandbox",
                "-s",
                "--ask-for-approval",
                "-a",
                "--image",
                "-i",
                "--add-dir",
                "--local-provider",
            ],
            &[
                "--search",
                "--no-alt-screen",
                "--oss",
                "--approve-for-me",
                "--strict-config",
                "--no-daemon",
            ],
        )
    };
    let error = || {
        "Custom CLI configuration requires manual hook integration; existing CLI behavior is preserved".to_string()
    };
    let mut i = 0;
    while i < args.len() {
        let argument = &args[i];
        if flags.contains(&argument.as_str()) {
            i += 1;
            continue;
        }
        if let Some((name, value)) = argument.split_once('=') {
            if !values.contains(&name) || value.is_empty() {
                return Err(error());
            }
            i += 1;
        } else {
            if !values.contains(&argument.as_str())
                || args
                    .get(i + 1)
                    .is_none_or(|value| value.is_empty() || value.starts_with('-'))
            {
                return Err(error());
            }
            i += 2;
        }
    }
    Ok(())
}
fn measured_version(
    program: &std::ffi::OsStr,
    prefix: &[std::ffi::OsString],
) -> Result<(), String> {
    measured_version_checked(program, prefix, compatible_claude_version)
}
fn measured_version_checked(
    program: &std::ffi::OsStr,
    prefix: &[std::ffi::OsString],
    compatible: fn(&str) -> bool,
) -> Result<(), String> {
    let mut command = std::process::Command::new(program);
    command
        .args(prefix)
        .arg("--version")
        .env("PATH", super::agent_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "Cannot query agent version")?;
    #[cfg(windows)]
    let mut job = Some(attach_query_job(&mut child)?);
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    break Err("Agent version query failed".into());
                }
                // Reap descendants before reading EOF: an exited CLI wrapper may
                // leave a child holding its stdout pipe open.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                #[cfg(windows)]
                drop(job.take());
                let mut bytes = Vec::new();
                if child
                    .stdout
                    .take()
                    .ok_or("Missing agent version output")?
                    .take(4097)
                    .read_to_end(&mut bytes)
                    .is_err()
                {
                    break Err("Cannot read agent version".into());
                }
                break if bytes.len() <= 4096 && compatible(String::from_utf8_lossy(&bytes).trim()) {
                    Ok(())
                } else {
                    Err("This CLI version has not passed YAM hook compatibility checks".into())
                };
            }
            Err(_) => break Err("Agent version query failed".into()),
            Ok(None) if std::time::Instant::now() >= deadline => {
                break Err("Agent version query timed out".into())
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    #[cfg(windows)]
    drop(job);
    let _ = child.wait();
    result
}
fn validate_resume_metadata(
    response: &serde_json::Value,
    id: &str,
    cwd: &std::path::Path,
    provider: &str,
) -> Result<(), String> {
    let thread = &response["result"]["thread"];
    if thread["id"].as_str() != Some(id) {
        return Err(
            "The original conversation no longer exists; no new conversation was started".into(),
        );
    }
    let original = thread["cwd"]
        .as_str()
        .ok_or("Original conversation directory is unavailable")?;
    if std::path::Path::new(original)
        .canonicalize()
        .map_err(|_| "Original conversation directory is missing")?
        != cwd
            .canonicalize()
            .map_err(|_| "Resume directory is missing")?
    {
        return Err("Original conversation directory differs; resume was not started".into());
    }
    if thread["modelProvider"].as_str() != Some(provider) {
        return Err(
            "Original provider differs from the current configuration; resume was not started"
                .into(),
        );
    }
    Ok(())
}
pub(super) fn validate_resume(
    executable: &std::path::Path,
    cwd: &std::path::Path,
    id: &str,
) -> Result<(), String> {
    let launch = super::AgentLaunch {
        adapter: "codex".into(),
        mode: "interactive".into(),
        extra_args: String::new(),
        prompt: None,
    };
    let command = super::agent_command(executable, &launch)?;
    let argv = command.get_argv();
    let config = agent_query(
        &argv[0],
        &argv[1..],
        cwd,
        "config/read",
        serde_json::json!({"cwd":cwd.to_string_lossy(),"includeLayers":true}),
    )?;
    let provider = match &config["result"]["config"]["model_provider"] {
        serde_json::Value::Null => "openai",
        serde_json::Value::String(value) if !value.is_empty() => value,
        _ => return Err("Invalid provider configuration".into()),
    };
    let thread = agent_query(
        &argv[0],
        &argv[1..],
        cwd,
        "thread/read",
        serde_json::json!({"threadId":id,"includeTurns":false}),
    )?;
    validate_resume_metadata(&thread, id, cwd, provider)
}
pub(super) struct Prepared {
    pub(super) token: String,
    pub(super) generation: String,
    args: Vec<String>,
    original: Vec<String>,
    opencode: Option<String>,
}
pub(super) fn prepare(
    executable: &std::path::Path,
    launch: &super::AgentLaunch,
    cwd: &std::path::Path,
    assets: &std::path::Path,
) -> Result<Prepared, String> {
    if launch.adapter == "opencode" && launch.mode == "interactive" {
        validate_interactive_args("opencode", &super::parse_agent_args(&launch.extra_args)?)?;
        let plain = super::AgentLaunch {
            prompt: None,
            extra_args: String::new(),
            ..launch.clone()
        };
        let command = super::agent_command(executable, &plain)?;
        let argv = command.get_argv();
        measured_version_checked(&argv[0], &argv[1..], compatible_opencode_version)?;
        let path = opencode_plugin(assets)?;
        let url = tauri::Url::from_file_path(&path).map_err(|_| "Invalid YAM plugin path")?;
        let original = std::env::var("OPENCODE_CONFIG_CONTENT")
            .map_err(|_| "OpenCode configuration is not UTF-8")
            .or_else(|e| {
                if std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none() {
                    Ok(String::new())
                } else {
                    Err(e)
                }
            })?;
        return Ok(Prepared {
            token: credential()?,
            generation: credential()?,
            args: vec![],
            original: vec![],
            opencode: Some(opencode_config(Some(&original), url.as_str())?),
        });
    }
    if launch.adapter == "claude" && launch.mode == "interactive" {
        validate_interactive_args("claude", &super::parse_agent_args(&launch.extra_args)?)?;
        let plain = super::AgentLaunch {
            prompt: None,
            extra_args: String::new(),
            ..launch.clone()
        };
        let command = super::agent_command(executable, &plain)?;
        let argv = command.get_argv();
        measured_version(&argv[0], &argv[1..])?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        return Ok(Prepared {
            token: credential()?,
            generation: credential()?,
            args: claude_args(exe.to_str().ok_or("Helper executable path is not UTF-8")?)?,
            original: vec![],
            opencode: None,
        });
    }
    if launch.adapter != "codex" || launch.mode != "interactive" {
        return Err("Reliable interactive hooks are currently validated for Codex only".into());
    }
    let extra = super::parse_agent_args(&launch.extra_args)?;
    validate_interactive_args("codex", &extra)?;
    let plain = super::AgentLaunch {
        adapter: "codex".into(),
        mode: "interactive".into(),
        extra_args: String::new(),
        prompt: None,
    };
    let command = super::agent_command(executable, &plain)?;
    let argv = command.get_argv();
    let original = effective_notify(&argv[0], &argv[1..], cwd)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_str().ok_or("Helper executable path is not UTF-8")?;
    if original.first().is_some_and(|program| program == exe) {
        return Err("Recursive notify callback rejected".into());
    }
    let args = injected_args(exe)?;
    let mut probe = argv[1..].to_vec();
    probe.extend(args.iter().map(std::ffi::OsString::from));
    let capabilities = agent_query(
        &argv[0],
        &probe,
        cwd,
        "hooks/list",
        serde_json::json!({"cwds":[cwd.to_string_lossy()]}),
    )?;
    validate_hook_capabilities(&capabilities, cwd)?;
    Ok(Prepared {
        token: credential()?,
        generation: credential()?,
        args,
        original,
        opencode: None,
    })
}
impl Prepared {
    pub(super) fn install(
        &self,
        builder: &mut portable_pty::CommandBuilder,
        address: SocketAddr,
    ) -> Result<(), String> {
        if let Some(config) = &self.opencode {
            builder.env("OPENCODE_CONFIG_CONTENT", config);
        }
        let index = builder
            .get_argv()
            .iter()
            .position(|a| a == "--")
            .unwrap_or(builder.get_argv().len());
        builder
            .get_argv_mut()
            .splice(index..index, self.args.iter().map(std::ffi::OsString::from));
        builder.env("YAM_AGENT_ADDRESS", address.to_string());
        builder.env("YAM_AGENT_TOKEN", &self.token);
        builder.env(
            "YAM_PREVIOUS_NOTIFY",
            serde_json::to_string(&self.original).map_err(|e| e.to_string())?,
        );
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn three_agent_receipts_and_logs_remain_isolated_across_connections_and_history_reopen() {
        use super::super::{session_logs, AgentLaunch, HistoryStore, SessionSummary};
        let root = std::env::temp_dir().join(format!(
            "yam-joint-flow-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(HistoryStore::open(root.clone()).unwrap());
        let bridge = Bridge::start(history.clone(), |_, _| {}).unwrap();
        let sessions = Mutex::new(std::collections::HashMap::new());
        let mut bindings = vec![];
        for adapter in ["codex", "claude", "opencode"] {
            let id = format!("s-{adapter}");
            let native = format!("main-{adapter}");
            let token = credential().unwrap();
            history
                .start(&SessionSummary {
                    session_id: id.clone(),
                    cwd: root.to_string_lossy().into_owned(),
                    command: None,
                    status: "running".into(),
                    launch: Some(AgentLaunch {
                        adapter: adapter.into(),
                        mode: "interactive".into(),
                        extra_args: String::new(),
                        prompt: None,
                    }),
                })
                .unwrap();
            history.configure_agent(&id, adapter).unwrap();
            bridge.register(&id, &token, adapter).unwrap();
            bindings.push((adapter, id, native, token));
        }
        let address = bridge.address;
        std::thread::scope(|scope| {
            for (adapter, id, native, token) in bindings {
                let history = history.clone();
                scope.spawn(move || {
                    let event = |kind: &str, turn: Option<&str>| AgentEvent {
                        kind: kind.into(),
                        agent_session_id: native.clone(),
                        turn_id: turn.map(str::to_owned),
                        permission_key: None,
                        source: (adapter != "codex").then(|| adapter.into()),
                    };
                    // Each submit uses a new authenticated TCP connection; receipts belong to the launch.
                    submit(address, &token, event("SessionStart", None)).unwrap();
                    for kind in ["UserPromptSubmit", "PermissionRequest", "ToolProgress"] {
                        submit(address, &token, event(kind, Some("one"))).unwrap();
                    }
                    let finished = if adapter == "claude" {
                        "ResponseReady"
                    } else {
                        "TurnComplete"
                    };
                    submit(address, &token, event(finished, Some("one"))).unwrap();
                    submit(address, &token, event(finished, Some("one"))).unwrap();
                    let mut child = event("TurnComplete", Some("child-turn"));
                    child.agent_session_id = format!("child-{adapter}");
                    submit(address, &token, child).unwrap();
                    for kind in ["UserPromptSubmit", "TurnFailed", "TurnComplete"] {
                        submit(address, &token, event(kind, Some("two"))).unwrap();
                    }
                    assert!(
                        submit(address, &credential().unwrap(), event("SessionStart", None))
                            .is_err()
                    );
                    let record = history
                        .list()
                        .unwrap()
                        .into_iter()
                        .find(|r| r.summary.session_id == id)
                        .unwrap();
                    assert_eq!(record.agent.phase, "failed");
                    assert_eq!(
                        record.agent.agent_session_id.as_deref(),
                        Some(native.as_str())
                    );
                    assert_eq!(
                        record.agent.inbox.len(),
                        3,
                        "duplicate, child and failed-round completions must not add receipts"
                    );
                    let receipt = &record.agent.inbox[0];
                    assert!(history
                        .read_agent_receipt(&id, &receipt.id, receipt.revision + 1)
                        .is_err());
                    history
                        .read_agent_receipt(&id, &receipt.id, receipt.revision)
                        .unwrap();

                    let output =
                        format!("\x1b[31m联合验证 {adapter} 中😀\x1b[0m\r\nsecond line\r\n");
                    std::fs::write(history.log_path(&id), &output).unwrap();
                    history
                        .update(&id, "stopped", None, None, Some(output.len() as u64))
                        .unwrap();
                    assert!(
                        submit(address, &token, event("UserPromptSubmit", Some("three"))).is_err()
                    );
                });
            }
        });
        bridge.stop();
        let reopened = HistoryStore::open(root.clone()).unwrap();
        let records = reopened.list().unwrap();
        assert_eq!(records.len(), 3);
        assert!(records
            .iter()
            .all(|r| r.status == "stopped" && r.agent.inbox.len() == 3 && r.agent.inbox[0].read));
        let sources = records
            .iter()
            .map(|r| session_logs::LogSource {
                session_id: r.summary.session_id.clone(),
                cwd: r.summary.cwd.clone(),
            })
            .collect::<Vec<_>>();
        let read = |id: &str| {
            let record = records
                .iter()
                .find(|r| r.summary.session_id == id)
                .ok_or("Unknown log session")?;
            super::super::recorded_log(&reopened, &sessions, record)
        };
        let page = session_logs::search(
            &sources,
            read,
            &session_logs::SearchRequest {
                query: "联合验证".into(),
                case_sensitive: false,
                skip: 0,
                limit: 50,
            },
            || false,
        )
        .unwrap();
        let page = serde_json::to_value(page).unwrap();
        assert_eq!(page["complete"], true);
        let hits = page["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 3);
        let mut hit_ids = hits
            .iter()
            .map(|hit| hit["session_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        hit_ids.sort_unstable();
        assert_eq!(hit_ids, ["s-claude", "s-codex", "s-opencode"]);
        for hit in hits {
            let id = hit["session_id"].as_str().unwrap();
            let adapter = id.strip_prefix("s-").unwrap();
            let unique = format!("联合验证 {adapter} 中😀");
            assert!(hit["text"].as_str().unwrap().contains(&unique));
            let log = read(id).unwrap();
            assert_eq!(
                log.data,
                format!("\x1b[31m{unique}\x1b[0m\r\nsecond line\r\n")
            );
            let excerpt = session_logs::excerpt(
                &log,
                hit["offset"].as_u64().unwrap(),
                hit["column"].as_u64().unwrap() as usize,
            )
            .unwrap();
            assert!(excerpt.contains(&unique));
            let plain = session_logs::export_text("", &log, false);
            assert!(plain.contains(&unique) && !plain.contains('\x1b'));
            assert_eq!(session_logs::export_text("", &log, true), log.data);
            let target = root.join(format!("{id}.txt"));
            session_logs::write_export(&target, plain.as_bytes()).unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), plain);
            assert!(session_logs::write_export(&target, b"overwrite").is_err());
            assert_eq!(std::fs::read_to_string(&target).unwrap(), plain);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    fn valid_wire() -> Vec<u8> {
        br#"{"version":1,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":{"kind":"SessionStart","agent_session_id":"main","turn_id":null}}"#.to_vec()
    }
    #[test]
    fn framed_events_are_acknowledged_without_waiting_for_a_half_close() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let result = read_connection(&mut stream, &AtomicBool::new(false));
            assert!(
                result.is_ok(),
                "a newline frame must not wait for socket EOF"
            );
            stream.write_all(b"ack").unwrap();
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client.write_all(&valid_wire()).unwrap();
        client.write_all(b"\n").unwrap();
        let mut reply = vec![];
        client.read_to_end(&mut reply).unwrap();
        worker.join().unwrap();
        assert_eq!(reply, b"ack");
    }

    #[test]
    fn opencode_config_append_preserves_every_existing_field_and_validates_plugins() {
        let original = serde_json::json!({"model":"existing","permission":{"bash":"ask"},"plugin":["existing",["module",{"option":true}]]});
        let next: serde_json::Value = serde_json::from_str(
            &opencode_config(Some(&original.to_string()), "file:///YAM%20plugin.mjs").unwrap(),
        )
        .unwrap();
        assert_eq!(next["model"], original["model"]);
        assert_eq!(next["permission"], original["permission"]);
        assert_eq!(next["plugin"][0], original["plugin"][0]);
        assert_eq!(next["plugin"][1], original["plugin"][1]);
        assert_eq!(next["plugin"][2], "file:///YAM%20plugin.mjs");
        for invalid in ["not JSON", "[]", "{\"plugin\":false}"] {
            assert!(opencode_config(Some(invalid), "file:///x").is_err());
        }
        for version in ["1.18.34", "1.18.35", "1.19.0"] {
            assert!(compatible_opencode_version(version));
        }
        for version in ["1.18.33", "2.0.0", "1.18.34-beta", "nonsense"] {
            assert!(!compatible_opencode_version(version));
        }
        assert!(validate_interactive_args(
            "opencode",
            &["--model".into(), "provider/model".into()]
        )
        .is_ok());
        for flag in [
            "--session",
            "--continue",
            "--port",
            "--hostname",
            "--auto",
            "--pure",
        ] {
            assert!(validate_interactive_args("opencode", &[flag.into()]).is_err());
        }
    }

    #[test]
    fn resume_metadata_rejects_missing_moved_or_different_provider_threads() {
        let root = std::env::temp_dir();
        let id = "01a0f6ec-5463-78c3-a404-5a7ad3b933fe";
        let good =
            serde_json::json!({"result":{"thread":{"id":id,"cwd":root,"modelProvider":"openai"}}});
        assert!(validate_resume_metadata(&good, id, &root, "openai").is_ok());
        let mut bad = good.clone();
        bad["result"]["thread"]["id"] = serde_json::json!("other");
        assert!(validate_resume_metadata(&bad, id, &root, "openai").is_err());
        let mut bad = good.clone();
        bad["result"]["thread"]["cwd"] = serde_json::json!("/missing-yam-resume-directory");
        assert!(validate_resume_metadata(&bad, id, &root, "openai").is_err());
        assert!(validate_resume_metadata(&good, id, &root, "different-provider").is_err());
        assert!(validate_resume_metadata(
            &serde_json::json!({"error":{"message":"missing"}}),
            id,
            &root,
            "openai"
        )
        .is_err());
        assert!(validate_resume_metadata(
            &serde_json::json!({"result":{"thread":{"id":id,"cwd":root}}}),
            id,
            &root,
            "openai"
        )
        .is_err());
    }

    #[test]
    fn wire_size_version_and_fields_are_strictly_validated() {
        assert!(read_wire(valid_wire().as_slice()).is_ok());
        for bytes in [
            vec![b'x'; 4097],
            b"{}".to_vec(),
            b"[]".to_vec(),
            valid_wire()
                .iter()
                .copied()
                .chain(
                    b"{}
"
                    .iter()
                    .copied(),
                )
                .collect(),
        ] {
            assert!(read_wire(bytes.as_slice()).is_err());
        }
        let mut value: serde_json::Value = serde_json::from_slice(&valid_wire()).unwrap();
        value["version"] = serde_json::json!(2);
        assert!(read_wire(serde_json::to_vec(&value).unwrap().as_slice()).is_err());
        value["version"] = serde_json::json!(1);
        value["token"] = serde_json::json!("short");
        assert!(read_wire(serde_json::to_vec(&value).unwrap().as_slice()).is_err());
    }
    #[test]
    fn helper_can_connect_only_to_ipv4_loopback_with_a_port() {
        assert_eq!(local_address("127.0.0.1:54321").unwrap().port(), 54321);
        for address in [
            "0.0.0.0:123",
            "10.0.0.1:123",
            "[::1]:123",
            "127.0.0.1:0",
            "example.org:123",
        ] {
            assert!(local_address(address).is_err());
        }
    }
    #[test]
    fn effective_notify_is_preserved_and_invalid_callback_is_not_overwritten() {
        let result =
            serde_json::json!({"result":{"config":{"notify":["/callback path","turn-ended"]}}});
        assert_eq!(
            previous_notify(&result).unwrap(),
            vec!["/callback path", "turn-ended"]
        );
        assert!(
            previous_notify(&serde_json::json!({"result":{"config":{"notify":[12]}}})).is_err()
        );
        assert!(
            previous_notify(&serde_json::json!({"error":{"message":"config failed"}})).is_err()
        );
        assert!(
            previous_notify(&serde_json::json!({"result":{"config":{}}}))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn existing_config_hooks_are_never_replaced_by_session_injection() {
        for kind in ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt"] {
            let mut response =
                serde_json::json!({"result":{"config":{"notify":["/original"],"hooks":{}}}});
            response["result"]["config"]["hooks"][kind] = serde_json::json!([
                {"matcher":null,"hooks":[{"type":"command","command":"original-user-hook","timeout":7}]}
            ]);
            assert!(previous_notify(&response).is_err(), "must preserve {kind}");
            for invalid in [serde_json::json!({}), serde_json::json!("invalid")] {
                response["result"]["config"]["hooks"][kind] = invalid;
                assert!(previous_notify(&response).is_err());
            }
            response["result"]["config"]["hooks"][kind] = serde_json::json!([]);
            assert_eq!(previous_notify(&response).unwrap(), vec!["/original"]);
        }
        let response = serde_json::json!({"result":{"config":{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"keep-this"}]}]}}}});
        assert!(
            previous_notify(&response).unwrap().is_empty(),
            "unmodified event hooks do not prevent integration"
        );
        assert!(previous_notify(&serde_json::json!({"result":{"config":{"hooks":[]}}})).is_err());
    }
    #[test]
    fn native_payloads_keep_identity_and_reject_missing_or_unknown_fields() {
        let start=normalize(&serde_json::json!({"hook_event_name":"SessionStart","session_id":"main","private":"ignored"}),false).unwrap();
        assert_eq!(start.kind, "SessionStart");
        assert_eq!(start.agent_session_id, "main");
        assert_eq!(start.turn_id, None);
        let done=normalize(&serde_json::json!({"type":"agent-turn-complete","thread-id":"main","turn-id":"one","last-assistant-message":"never forwarded"}),true).unwrap();
        assert_eq!(done.kind, "TurnComplete");
        assert_eq!(done.turn_id.as_deref(), Some("one"));
        assert!(normalize(
            &serde_json::json!({"type":"other","thread-id":"main","turn-id":"one"}),
            true
        )
        .is_err());
        assert!(normalize(
            &serde_json::json!({"hook_event_name":"Stop","session_id":"main"}),
            false
        )
        .is_err());
        assert!(normalize(
            &serde_json::json!({"hook_event_name":"SessionStart","session_id":""}),
            false
        )
        .is_err());
    }
    #[test]
    fn credentials_are_independent_secure_256_bit_hex_values() {
        let a = credential().unwrap();
        let b = credential().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|v| v.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
    #[test]
    fn closing_interrupts_a_partial_request_and_install_preserves_literal_prompt() {
        let root = std::env::temp_dir().join(format!(
            "yam-bridge-stop-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        let bridge = Bridge::start(history, |_, _| {}).unwrap();
        let mut partial = TcpStream::connect(bridge.address).unwrap();
        partial.write_all(b"{").unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let start = std::time::Instant::now();
        bridge.stop();
        assert!(start.elapsed() < Duration::from_millis(250));
        let prepared = Prepared {
            token: credential().unwrap(),
            generation: credential().unwrap(),
            args: vec!["-c".into(), "notify=[]".into()],
            original: vec!["existing".into(), "literal ' 中文".into()],
            opencode: None,
        };
        let mut command = portable_pty::CommandBuilder::new("codex");
        command.args(["--model", "model", "--", "literal $(touch ignored) 中文"]);
        prepared
            .install(&mut command, local_address("127.0.0.1:12345").unwrap())
            .unwrap();
        assert_eq!(
            command.get_argv(),
            &[
                "codex",
                "--model",
                "model",
                "-c",
                "notify=[]",
                "--",
                "literal $(touch ignored) 中文"
            ]
            .map(std::ffi::OsString::from)
        );
        assert!(!command
            .get_argv()
            .iter()
            .any(|a| a.to_string_lossy().contains(&prepared.token)));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blocked_native_sender_does_not_block_stop_indefinitely_or_consume_receipts() {
        let root = std::env::temp_dir().join(format!(
            "yam-bridge-blocked-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        history
            .start(&super::super::SessionSummary {
                session_id: "a".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        history.configure_agent("a", "launch").unwrap();
        for (kind, turn) in [
            ("SessionStart", None),
            ("UserPromptSubmit", Some("one")),
            ("TurnComplete", Some("one")),
        ] {
            history
                .ingest_agent(
                    "a",
                    "launch",
                    &AgentEvent {
                        kind: kind.into(),
                        agent_session_id: "main".into(),
                        turn_id: turn.map(str::to_string),
                        permission_key: None,
                        source: None,
                    },
                )
                .unwrap();
        }
        let bridge = Bridge::start(history.clone(), |_, _| {}).unwrap();
        let (entered, ready) = std::sync::mpsc::channel();
        *bridge.delivery_worker.lock().unwrap() = Some(std::thread::spawn(move || {
            entered.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(1200));
        }));
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        let start = std::time::Instant::now();
        bridge.stop();
        assert!(
            start.elapsed() < Duration::from_millis(750),
            "native send must not extend bridge cleanup indefinitely"
        );
        assert!(bridge
            .stop_until(std::time::Instant::now())
            .unwrap_err()
            .contains("timed out"));
        let receipt = &history.list().unwrap()[0].agent.inbox[0];
        assert!(!receipt.read);
        assert_eq!(receipt.delivery, "pending");
        std::thread::sleep(Duration::from_millis(750));
        bridge
            .stop_until(std::time::Instant::now() + Duration::from_millis(100))
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn completed_failed_shutdown_can_retire_its_bridge_before_a_new_agent_launch() {
        let root = std::env::temp_dir().join(format!(
            "yam-bridge-restart-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        let mut runtime = Some(Bridge::start(history.clone(), |_, _| {}).unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        *runtime.as_ref().unwrap().delivery_worker.lock().unwrap() =
            Some(std::thread::spawn(move || {
                let _ = wait.recv_timeout(Duration::from_secs(2));
            }));
        assert!(runtime
            .as_ref()
            .unwrap()
            .stop_until(std::time::Instant::now() + Duration::from_millis(30))
            .is_err());
        assert!(Bridge::retire_stopped(&mut runtime).is_err());
        assert!(runtime.is_some());
        release.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        Bridge::retire_stopped(&mut runtime).unwrap();
        assert!(runtime.is_none());
        history
            .start(&super::super::SessionSummary {
                session_id: "new".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        history.configure_agent("new", "fresh").unwrap();
        let bridge = Bridge::start(history, |_, _| {}).unwrap();
        let token = credential().unwrap();
        bridge.register("new", &token, "fresh").unwrap();
        submit(
            bridge.address,
            &token,
            AgentEvent {
                kind: "SessionStart".into(),
                agent_session_id: "main".into(),
                turn_id: None,
                permission_key: None,
                source: None,
            },
        )
        .unwrap();
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn authenticated_loopback_commits_before_acknowledging_and_expires_with_lifecycle() {
        let root =
            std::env::temp_dir().join(format!("yam-bridge-{}", super::super::next_session_id()));
        let history = std::sync::Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        for id in ["a", "b"] {
            history
                .start(&super::super::SessionSummary {
                    session_id: id.into(),
                    cwd: "/tmp".into(),
                    command: None,
                    status: "running".into(),
                    launch: None,
                })
                .unwrap();
            history.configure_agent(id, id).unwrap();
        }
        let updates = Arc::new(Mutex::new(Vec::<(String, Option<String>)>::new()));
        let captured = updates.clone();
        let bridge = Bridge::start(history.clone(), move |id, error| {
            captured.lock().unwrap().push((id.into(), error));
        })
        .unwrap();
        let token = credential().unwrap();
        let other = credential().unwrap();
        bridge.register("a", &token, "a").unwrap();
        bridge.register("b", &other, "b").unwrap();
        let bytes = serde_json::to_vec(&Wire {
            version: 1,
            token: token.clone(),
            event: AgentEvent {
                kind: "SessionStart".into(),
                agent_session_id: "main".into(),
                turn_id: None,
                permission_key: None,
                source: None,
            },
        })
        .unwrap();
        let mut fragmented = TcpStream::connect(bridge.address).unwrap();
        fragmented
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        fragmented.write_all(&bytes[..1]).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        fragmented.write_all(&bytes[1..]).unwrap();
        fragmented.shutdown(Shutdown::Write).unwrap();
        let mut reply = Vec::new();
        fragmented.read_to_end(&mut reply).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&reply).unwrap()["accepted"],
            true
        );
        let mut slow = TcpStream::connect(bridge.address).unwrap();
        let dripper = std::thread::spawn(move || {
            for _ in 0..30 {
                if slow.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        std::thread::sleep(Duration::from_millis(450));
        let event = || AgentEvent {
            kind: "SessionStart".into(),
            agent_session_id: "main".into(),
            turn_id: None,
            permission_key: None,
            source: None,
        };
        assert!(submit(bridge.address, &credential().unwrap(), event()).is_err());
        submit(bridge.address, &token, event()).unwrap();
        dripper.join().unwrap();
        assert_eq!(
            history
                .list()
                .unwrap()
                .iter()
                .find(|r| r.summary.session_id == "a")
                .unwrap()
                .agent
                .agent_session_id
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            history
                .list()
                .unwrap()
                .iter()
                .find(|r| r.summary.session_id == "b")
                .unwrap()
                .agent
                .agent_session_id,
            None
        );
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        assert!(submit(bridge.address, &other, event()).is_err());
        assert!(updates
            .lock()
            .unwrap()
            .iter()
            .any(|(id, error)| id == "b" && error.is_some()));
        assert_eq!(
            history
                .list()
                .unwrap()
                .iter()
                .find(|r| r.summary.session_id == "b")
                .unwrap()
                .agent
                .agent_session_id,
            None
        );
        std::fs::remove_dir(root.join("sessions.json.tmp")).unwrap();
        history.update("a", "stopped", None, None, None).unwrap();
        assert!(submit(bridge.address, &token, event()).is_err());
        bridge.stop();
        assert!(submit(bridge.address, &other, event()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn existing_callback_gets_the_original_payload_as_one_literal_argument() {
        let path = std::env::temp_dir().join(format!(
            "yam-notify-forward-{}",
            super::super::next_session_id()
        ));
        let payload = r#"{"last-assistant-message":"$(touch /tmp/never-yam) quotes ' and 中文"}"#;
        let args = vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf '%s' \"$2\" > \"$1\"".into(),
            "callback".into(),
            path.to_string_lossy().into_owned(),
        ];
        forward_previous(&args, payload).unwrap();
        for _ in 0..100 {
            if std::fs::read_to_string(&path).ok().as_deref() == Some(payload) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), payload);
        std::fs::remove_file(path).unwrap();
        assert!(forward_previous(&["/no/such/callback".into()], payload).is_err());
        assert!(forward_previous(&[], payload).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn config_rpc_requires_successful_initialization_and_reads_effective_callback() {
        let script="read init; printf '%s\\n' '{\"id\":1,\"result\":{}}'; read initialized; read query; printf '%s\\n' '{\"id\":2,\"result\":{\"config\":{\"notify\":[\"/original\",\"turn-ended\"]}}}'; read end";
        let result = effective_notify(
            std::ffi::OsStr::new("/bin/sh"),
            &["-c".into(), script.into()],
            std::path::Path::new("/tmp"),
        )
        .unwrap();
        assert_eq!(result, vec!["/original", "turn-ended"]);
        assert!(effective_notify(
            std::ffi::OsStr::new("/bin/sh"),
            &[
                "-c".into(),
                "printf '%s\\n' '{\"id\":1,\"error\":{}}'".into()
            ],
            std::path::Path::new("/tmp")
        )
        .is_err());
    }
    #[test]
    fn injected_config_contains_no_policy_override_and_quotes_the_executable() {
        let args = injected_args("/application path/YAM").unwrap();
        assert_eq!(args.len(), 14);
        assert!(!args
            .iter()
            .any(|arg| arg.contains("hooks.PostToolUseFailure=")));
        for kind in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "Interrupt",
            "PermissionRequest",
            "PostToolUse",
        ] {
            assert!(args
                .iter()
                .any(|a| a.starts_with(&format!("hooks.{kind}="))));
        }
        assert!(args
            .iter()
            .any(|a| a == "notify=[\"/application path/YAM\",\"--yam-agent-notify\"]"));
        assert!(args.iter().any(|a| a.contains("--yam-agent-hook")));
        for arg in &args {
            assert!(!arg.contains("bypass"));
            assert!(!arg.contains("sandbox"));
            assert!(!arg.contains("approval"));
        }
        assert!(injected_args("").is_err());
    }

    #[test]
    fn permission_hooks_preserve_existing_policy_and_normalize_progress() {
        for kind in ["PermissionRequest", "PostToolUse"] {
            let existing = serde_json::json!({"result":{"config":{"hooks":{kind:[{"hooks":[{"type":"command","command":"original-policy"}]}]}}}});
            assert!(
                previous_notify(&existing).is_err(),
                "must not replace {kind}"
            );
            let event = normalize(&serde_json::json!({"hook_event_name":kind,"session_id":"main","turn_id":"one","tool_input":{"command":"sensitive"}}),false).unwrap();
            assert_eq!(
                event.kind,
                if kind == "PermissionRequest" {
                    kind
                } else {
                    "ToolProgress"
                }
            );
            assert_eq!(event.turn_id.as_deref(), Some("one"));
        }
    }
    #[test]
    fn claude_uses_native_prompt_identity_and_explicit_failure_without_success_guessing() {
        let prompt = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"claude-main","prompt_id":"prompt-one","prompt":"private"});
        let e = normalize_claude(&prompt).unwrap();
        assert_eq!(e.kind, "UserPromptSubmit");
        assert_eq!(serde_json::to_value(&e).unwrap()["source"], "claude");
        assert_eq!(e.turn_id.as_deref(), Some("prompt-one"));
        let failure = normalize_claude(&serde_json::json!({"hook_event_name":"StopFailure","session_id":"claude-main","prompt_id":"prompt-one","error":"private"})).unwrap();
        assert_eq!(failure.kind, "TurnFailed");
        assert!(normalize_claude(&serde_json::json!({"hook_event_name":"StopFailure","session_id":"claude-main","turn_id":"guessed"})).is_err());
        assert!(normalize_claude(&serde_json::json!({"hook_event_name":"SubagentStop","session_id":"child","prompt_id":"prompt-one"})).is_err());
        assert!(normalize_claude(&serde_json::json!({"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"claude-main","prompt_id":"prompt-one"})).is_err());
        assert!(normalize_claude(&serde_json::json!({"hook_event_name":"Notification","notification_type":"idle_prompt","session_id":"claude-main","prompt_id":"prompt-one"})).is_err());
        let args = claude_args("/application path/YAM").unwrap();
        assert_eq!(args[0], "--settings");
        let settings: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        assert_eq!(settings.as_object().unwrap().len(), 1);
        assert!(settings["hooks"]["Notification"].is_null());
        assert_eq!(settings["hooks"].as_object().unwrap().len(), 7);
        let hook = &settings["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(hook["command"], "/application path/YAM");
        assert_eq!(hook["args"], serde_json::json!(["--yam-claude-hook"]));
        assert!(claude_args("").is_err());
    }
    #[test]
    fn claude_stop_reports_readiness_without_claiming_final_completion() {
        let stop = serde_json::json!({"hook_event_name":"Stop","session_id":"claude-main","prompt_id":"prompt-one","last_assistant_message":"private reply","stop_hook_active":false,"background_tasks":[{"status":"running"}]});
        assert_eq!(normalize_claude(&stop).unwrap().kind, "ResponseReady");
        let mut missing = stop.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("last_assistant_message");
        assert!(normalize_claude(&missing).is_err());
        let settings: serde_json::Value =
            serde_json::from_str(&claude_args("/application path/YAM").unwrap()[1]).unwrap();
        assert!(settings["hooks"]["Stop"].is_array());
        let request = serde_json::json!({"hook_event_name":"PermissionRequest","session_id":"main","turn_id":"one","tool_name":"Bash","tool_input":{"command":"private"}});
        let a = normalize(&request, false).unwrap();
        let mut done = request.clone();
        done["hook_event_name"] = serde_json::json!("PostToolUse");
        assert_eq!(
            a.permission_key,
            normalize(&done, false).unwrap().permission_key
        );
        assert!(a.permission_key.is_some());
        done["tool_input"]["command"] = serde_json::json!("another");
        assert_ne!(
            a.permission_key,
            normalize(&done, false).unwrap().permission_key
        );
        assert!(!serde_json::to_string(&a).unwrap().contains("private"));
    }
    #[test]
    fn alternate_config_directory_and_remote_flags_degrade_before_any_cli_query() {
        for extra in [
            "-cnotify=[]",
            "-pprofile",
            "-C/tmp",
            "--cd=/tmp",
            "--remote=ws://localhost:123",
            "--worktree",
        ] {
            let launch = super::super::AgentLaunch {
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: extra.into(),
                prompt: None,
            };
            let error = prepare(
                std::path::Path::new("/no/such/cli"),
                &launch,
                std::path::Path::new("/tmp"),
                std::path::Path::new("/tmp"),
            )
            .err()
            .unwrap();
            assert!(
                error.contains("manual hook integration"),
                "{extra}: {error}"
            );
        }
    }
    #[test]
    fn compatible_claude_updates_are_not_locked_to_one_patch() {
        for version in [
            "2.1.286 (Claude Code)",
            "2.1.287 (Claude Code)",
            "2.2.0 (Claude Code)",
        ] {
            assert!(compatible_claude_version(version), "{version}");
        }
        for version in [
            "2.1.285 (Claude Code)",
            "3.0.0 (Claude Code)",
            "2.1.287-beta (Claude Code)",
            "2.1.287",
            "codex-cli 2.1.287",
            "2.1.287.1 (Claude Code)",
        ] {
            assert!(!compatible_claude_version(version), "{version}");
        }
    }
    #[test]
    fn safe_interactive_arguments_preserve_hooks_but_conflicts_degrade() {
        for (adapter, args) in [
            (
                "claude",
                vec!["--model", "fable", "--effort=high", "--verbose"],
            ),
            (
                "claude",
                vec![
                    "--permission-mode",
                    "default",
                    "--append-system-prompt",
                    "Keep replies short",
                ],
            ),
            (
                "codex",
                vec!["--model", "model", "--sandbox=read-only", "--no-alt-screen"],
            ),
            (
                "codex",
                vec![
                    "--oss",
                    "--local-provider",
                    "ollama",
                    "--image",
                    "diagram.png",
                    "--add-dir",
                    "/tmp",
                    "--no-daemon",
                ],
            ),
        ] {
            assert!(validate_interactive_args(
                adapter,
                &args.iter().map(|s| s.to_string()).collect::<Vec<_>>()
            )
            .is_ok());
        }
        for (adapter, arg) in [
            ("claude", "--settings=private.json"),
            ("claude", "--bare"),
            ("claude", "--resume=old"),
            ("claude", "--safe-mode"),
            ("claude", "--model"),
            ("claude", "--model="),
            ("codex", "--worktree=/tmp"),
            ("codex", "--remote=remote"),
            ("codex", "-cnotify=[]"),
            ("codex", "exec"),
            ("codex", "--"),
        ] {
            assert!(
                validate_interactive_args(adapter, &[arg.to_string()]).is_err(),
                "{adapter} {arg}"
            );
        }
    }
    #[test]
    fn codex_hook_probe_requires_all_injected_events_and_no_config_errors() {
        let hooks = [
            "sessionStart",
            "userPromptSubmit",
            "stop",
            "interrupt",
            "permissionRequest",
            "postToolUse",
        ]
        .map(|event| serde_json::json!({"eventName":event,"source":"sessionFlags","enabled":true}));
        let response =
            serde_json::json!({"result":{"data":[{"cwd":"/tmp","errors":[],"hooks":hooks}]}});
        assert!(validate_hook_capabilities(&response, std::path::Path::new("/tmp")).is_ok());
        let mut bad = response.clone();
        bad["result"]["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(validate_hook_capabilities(&bad, std::path::Path::new("/tmp")).is_err());
        bad = response.clone();
        bad["result"]["data"][0]["hooks"][0]["source"] = serde_json::json!("user");
        assert!(validate_hook_capabilities(&bad, std::path::Path::new("/tmp")).is_err());
        bad = response.clone();
        bad["result"]["data"][0]["hooks"][0]["enabled"] = serde_json::json!(false);
        assert!(validate_hook_capabilities(&bad, std::path::Path::new("/tmp")).is_err());
        bad = response.clone();
        bad["result"]["data"][0]["errors"] = serde_json::json!([{"message":"unsupported hook"}]);
        assert!(validate_hook_capabilities(&bad, std::path::Path::new("/tmp")).is_err());
        assert!(validate_hook_capabilities(&response, std::path::Path::new("/elsewhere")).is_err());
        assert!(validate_hook_capabilities(
            &serde_json::json!({"result":{}}),
            std::path::Path::new("/tmp")
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn claude_version_query_accepts_updates_and_times_out_without_hanging() {
        assert!(measured_version(
            std::ffi::OsStr::new("/bin/sh"),
            &["-c".into(), "printf '2.1.286 (Claude Code)\\n'".into()]
        )
        .is_ok());
        assert!(measured_version(
            std::ffi::OsStr::new("/bin/sh"),
            &["-c".into(), "printf '3.0.0 (Claude Code)\\n'".into()]
        )
        .is_err());
        let start = std::time::Instant::now();
        assert!(measured_version(
            std::ffi::OsStr::new("/bin/sh"),
            &["-c".into(), "sleep 10".into()]
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(4));
        let start = std::time::Instant::now();
        assert!(measured_version(
            std::ffi::OsStr::new("/bin/sh"),
            &[
                "-c".into(),
                "sleep 1 & printf '2.1.286 (Claude Code)\\n'".into()
            ]
        )
        .is_ok());
        assert!(
            start.elapsed() < Duration::from_millis(600),
            "an exited query must not wait for descendants holding stdout"
        );
    }
}
