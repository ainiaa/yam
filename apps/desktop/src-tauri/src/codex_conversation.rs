// Author: Jeff.Liu. Read-only Codex history, separate from the terminal runtime.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
const LIMIT: usize = 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    session: String,
    thread: String,
    generation: String,
    conversation: Option<String>,
    started: u64,
    cwd: PathBuf,
    home: PathBuf,
    provider: String,
    owner: String,
    storage: (u128, u128),
}
#[derive(Debug, Serialize)]
struct Item {
    id: String,
    turn_id: String,
    kind: String,
    text: String,
    paths: Vec<String>,
    truncated: bool,
}
#[derive(Debug)]
struct RawPage {
    items: Vec<Item>,
    next: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct Page {
    query_token: String,
    session_id: String,
    thread_id: String,
    generation: String,
    read_at: u64,
    direction: String,
    items: Vec<Item>,
    next_cursor: Option<String>,
}
fn identifier(v: &Value) -> Result<String, String> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or("conversation_invalid_response".into())
}
fn bounded(s: String) -> (String, bool) {
    if s.len() <= 65536 {
        return (s, false);
    }
    let mut n = 65536;
    while !s.is_char_boundary(n) {
        n -= 1
    }
    (s[..n].into(), true)
}
fn project(row: &Value) -> Result<Item, String> {
    let item = &row["item"];
    let id = identifier(&item["id"])?;
    let turn_id = identifier(&row["turnId"])?;
    let (kind, text, paths) = match item["type"]
        .as_str()
        .ok_or("conversation_invalid_response")?
    {
        "userMessage" => {
            let content = item["content"]
                .as_array()
                .ok_or("conversation_invalid_response")?;
            let mut text = Vec::new();
            for v in content {
                if v["type"] == "text" {
                    text.push(v["text"].as_str().ok_or("conversation_invalid_response")?)
                } else {
                    text.push("[Unsupported message content]")
                }
            }
            ("user", text.join("\n"), vec![])
        }
        "agentMessage" => (
            "agent",
            item["text"]
                .as_str()
                .ok_or("conversation_invalid_response")?
                .into(),
            vec![],
        ),
        "commandExecution" => (
            "tool",
            format!(
                "{}\n{}",
                item["command"].as_str().unwrap_or("Command"),
                item["aggregatedOutput"].as_str().unwrap_or("")
            ),
            vec![],
        ),
        "mcpToolCall" | "dynamicToolCall" => (
            "tool",
            format!(
                "{}\n{}",
                item["tool"].as_str().unwrap_or("Tool"),
                serde_json::to_string(&item["result"])
                    .map_err(|_| "conversation_invalid_response")?
            ),
            vec![],
        ),
        "fileChange" => {
            let changes = item["changes"]
                .as_array()
                .ok_or("conversation_invalid_response")?;
            if changes.len() > 256 {
                return Err("conversation_invalid_response".into());
            }
            let mut paths = Vec::new();
            let mut text = Vec::new();
            for c in changes {
                let p = c["path"]
                    .as_str()
                    .filter(|p| {
                        !p.is_empty() && p.len() <= 4096 && !p.chars().any(char::is_control)
                    })
                    .ok_or("conversation_invalid_response")?;
                paths.push(p.into());
                text.push(format!("{p}\n{}", c["diff"].as_str().unwrap_or("")));
            }
            ("file", text.join("\n"), paths)
        }
        _ => ("unknown", "Unsupported native record".into(), vec![]),
    };
    let (text, truncated) = bounded(text);
    Ok(Item {
        id,
        turn_id,
        kind: kind.into(),
        text,
        paths,
        truncated,
    })
}
#[derive(Default)]
struct Window {
    active: Option<(String, Arc<AtomicBool>)>,
    cancelled: VecDeque<String>,
    cursors: VecDeque<(String, Identity, String, String, u16)>,
}
#[derive(Clone, Default)]
pub(crate) struct Requests(Arc<Mutex<HashMap<String, Window>>>);
fn token_valid(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl Requests {
    fn begin(&self, w: &str, t: &str) -> Result<Arc<AtomicBool>, String> {
        if !token_valid(t) {
            return Err("conversation_invalid_request".into());
        }
        let mut all = self.0.lock().map_err(|_| "conversation_unavailable")?;
        let q = all.entry(w.into()).or_default();
        if q.cancelled.iter().any(|x| x == t) {
            return Err("conversation_cancelled".into());
        }
        if q.active.is_some() {
            return Err("conversation_busy".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        q.active = Some((t.into(), flag.clone()));
        Ok(flag)
    }
    fn finish(&self, w: &str, t: &str) {
        if let Ok(mut all) = self.0.lock() {
            if let Some(q) = all.get_mut(w) {
                if q.active.as_ref().is_some_and(|(id, _)| id == t) {
                    q.active = None;
                }
            }
        }
    }
    fn cancel(&self, w: &str, t: &str) {
        if let Ok(mut all) = self.0.lock() {
            let q = all.entry(w.into()).or_default();
            if let Some((id, f)) = &q.active {
                if id == t {
                    f.store(true, Ordering::Release)
                }
            }
            if !q.cancelled.iter().any(|x| x == t) {
                q.cancelled.push_back(t.into());
                if q.cancelled.len() > 16 {
                    q.cancelled.pop_front();
                }
            }
        }
    }
    fn cursor(
        &self,
        w: &str,
        id: &Identity,
        t: &str,
        direction: &str,
        _limit: u16,
    ) -> Result<String, String> {
        if t.len() > 8192 {
            return Err("conversation_invalid_cursor".into());
        }
        let all = self.0.lock().map_err(|_| "conversation_unavailable")?;
        all.get(w)
            .and_then(|q| {
                q.cursors
                    .iter()
                    .find(|(token, i, _, d, _)| token == t && i == id && d == direction)
            })
            .map(|(_, _, raw, _, _)| raw.clone())
            .ok_or("conversation_invalid_cursor".into())
    }
    #[allow(clippy::too_many_arguments)]
    fn finish_page(
        &self,
        w: &str,
        token: &str,
        identity: Identity,
        current: Identity,
        page: RawPage,
        direction: &str,
        limit: u16,
        flag: &AtomicBool,
    ) -> Result<Page, String> {
        if current != identity {
            return Err("conversation_identity_changed".into());
        }
        // Cancellation and cursor publication share the active-request lock.
        let mut all = self.0.lock().map_err(|_| "conversation_unavailable")?;
        let window = all.get_mut(w).ok_or("conversation_cancelled")?;
        if !window.active.as_ref().is_some_and(|(active, cancelled)| {
            active == token
                && std::ptr::eq(cancelled.as_ref(), flag)
                && !cancelled.load(Ordering::Acquire)
        }) {
            return Err("conversation_cancelled".into());
        }
        let mut output = Page {
            query_token: token.into(),
            session_id: identity.session.clone(),
            thread_id: identity.thread.clone(),
            generation: identity.generation.clone(),
            read_at: crate::unix_timestamp_millis()
                .try_into()
                .map_err(|_| "conversation_unavailable")?,
            direction: direction.into(),
            items: page.items,
            next_cursor: None,
        };
        let mut validate = |cursor: Option<&str>| {
            output.next_cursor = cursor.map(str::to_owned);
            if serde_json::to_vec(&output)
                .map_err(|_| "conversation_invalid_response")?
                .len()
                > LIMIT
            {
                return Err("conversation_response_too_large".into());
            }
            Ok(())
        };
        if let Some(raw) = page.next.as_deref() {
            save_cursor_checked(window, &identity, raw, direction, limit, |cursor| {
                validate(Some(cursor))
            })?;
        } else {
            validate(None)?;
        }
        Ok(output)
    }

    #[cfg(test)]
    fn save_cursor(
        &self,
        w: &str,
        id: &Identity,
        raw: &str,
        direction: &str,
        limit: u16,
    ) -> Result<String, String> {
        let mut all = self.0.lock().map_err(|_| "conversation_unavailable")?;
        let q = all.entry(w.into()).or_default();
        save_cursor_checked(q, id, raw, direction, limit, |_| Ok(()))
    }
}
fn save_cursor_checked(
    q: &mut Window,
    id: &Identity,
    raw: &str,
    direction: &str,
    limit: u16,
    validate: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 8192 {
        return Err("conversation_invalid_response".into());
    }
    if let Some((token, _, _, _, _)) = q
        .cursors
        .iter()
        .find(|(_, i, r, d, l)| i == id && r == raw && d == direction && *l == limit)
    {
        validate(token)?;
        return Ok(token.clone());
    }
    let token = crate::agent_bridge::credential().map_err(|_| "conversation_unavailable")?;
    validate(&token)?;
    q.cursors.push_back((
        token.clone(),
        id.clone(),
        raw.into(),
        direction.into(),
        limit,
    ));
    if q.cursors.len() > 128 {
        q.cursors.pop_front();
    }
    Ok(token)
}

fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("conversation_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("conversation_timed_out".into())
    } else {
        Ok(())
    }
}
fn spawn_writer(
    mut input: impl Write + Send + 'static,
) -> (
    std::sync::mpsc::SyncSender<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    let (send, receive) = std::sync::mpsc::sync_channel::<Vec<u8>>(4);
    let join = std::thread::spawn(move || {
        while let Ok(bytes) = receive.recv() {
            if input.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    (send, join)
}
fn home_stamp(home: &Path) -> Result<(u128, u128), String> {
    let mut stamps = Vec::new();
    for path in [home.to_path_buf(), home.join("sessions")] {
        let m = std::fs::symlink_metadata(path).map_err(|_| "conversation_storage_unavailable")?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err("conversation_storage_unavailable".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if m.uid() != unsafe { libc::geteuid() } {
                return Err("conversation_storage_unavailable".into());
            }
            stamps.push((u128::from(m.dev()) << 64) | u128::from(m.ino()));
        }
        #[cfg(not(unix))]
        {
            stamps.push(
                m.created()
                    .map_err(|_| "conversation_storage_unavailable")?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "conversation_storage_unavailable")?
                    .as_nanos(),
            );
        }
    }
    Ok((stamps[0], stamps[1]))
}
fn native_home() -> Result<(PathBuf, String), String> {
    let home = std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|p| PathBuf::from(p).join(".codex"))
        })
        .ok_or("conversation_storage_unavailable")?;
    let m = std::fs::symlink_metadata(&home).map_err(|_| "conversation_storage_unavailable")?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err("conversation_storage_unavailable".into());
    }
    let home = home
        .canonicalize()
        .map_err(|_| "conversation_storage_unavailable")?;
    let path = home.join("config.toml");
    if !path
        .try_exists()
        .map_err(|_| "conversation_storage_unavailable")?
    {
        return Ok((home, "openai".into()));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let f = options
        .open(path)
        .map_err(|_| "conversation_storage_unavailable")?;
    if !f
        .metadata()
        .map_err(|_| "conversation_storage_unavailable")?
        .is_file()
    {
        return Err("conversation_storage_unavailable".into());
    }
    let mut bytes = Vec::new();
    f.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "conversation_storage_unavailable")?;
    if bytes.len() > LIMIT {
        return Err("conversation_storage_unavailable".into());
    }
    let config = std::str::from_utf8(&bytes).map_err(|_| "conversation_storage_unavailable")?;
    let mut provider = None;
    // Only simple top-level strings are needed; ambiguous TOML leaves the terminal available.
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "model_provider" {
            continue;
        }
        if provider.is_some() {
            return Err("conversation_storage_unavailable".into());
        }
        let v = value.trim();
        let decoded = serde_json::from_str::<String>(v)
            .ok()
            .or_else(|| {
                v.strip_prefix('\'')
                    .and_then(|s| s.strip_suffix('\''))
                    .map(str::to_owned)
            })
            .ok_or("conversation_storage_unavailable")?;
        provider = Some(identifier(&json!(decoded))?);
    }
    Ok((home, provider.unwrap_or_else(|| "openai".into())))
}
fn record_identity(
    record: &crate::SessionRecord,
    root: &Path,
    owner: &str,
) -> Result<Identity, String> {
    let launch = record
        .summary
        .launch
        .as_ref()
        .ok_or("conversation_unsupported")?;
    if record.summary.ssh.is_some()
        || launch.adapter != "codex"
        || record.agent.generation.is_empty()
    {
        return Err("conversation_unsupported".into());
    }
    let args =
        crate::parse_agent_args(&launch.extra_args).map_err(|_| "conversation_unsupported")?;
    crate::agent_bridge::validate_interactive_args("codex", &args)
        .map_err(|_| "conversation_unsupported")?;
    if args
        .iter()
        .any(|a| a == "--oss" || a.starts_with("--local-provider"))
        || launch
            .env_refs
            .keys()
            .any(|s| matches!(s.as_str(), "CODEX_HOME" | "HOME" | "USERPROFILE"))
    {
        return Err("conversation_unsupported".into());
    }
    let thread = identifier(&json!(record.agent.agent_session_id))?;
    let cwd = Path::new(&record.summary.cwd)
        .canonicalize()
        .map_err(|_| "conversation_identity_changed")?;
    if !cwd.is_dir() {
        return Err("conversation_identity_changed".into());
    }
    let (home, provider) = if launch.provider.is_some() {
        (
            crate::provider_launch::existing_home(root, launch)
                .map_err(|_| "conversation_storage_unavailable")?,
            if launch.codex.is_some() {
                "openai"
            } else {
                "yam_api"
            }
            .into(),
        )
    } else {
        native_home()?
    };
    let storage = home_stamp(&home)?;
    Ok(Identity {
        session: record.summary.session_id.clone(),
        thread,
        generation: record.agent.generation.clone(),
        conversation: record.conversation_id.clone(),
        started: record.started_at,
        cwd,
        home,
        provider,
        owner: owner.into(),
        storage,
    })
}
#[tauri::command(rename_all = "snake_case")]
// Keep the existing Tauri command argument contract.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn read_codex_conversation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    session_id: String,
    query_token: String,
    cursor: Option<String>,
    limit: Option<u16>,
    direction: Option<String>,
) -> Result<Page, String> {
    let requests = requests.inner().clone();
    let scope = window.label().to_owned();
    let flag = requests.begin(&scope, &query_token)?;
    let r = requests.clone();
    let w = scope.clone();
    let token = query_token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let limit = limit.unwrap_or(50);
        let direction = direction.unwrap_or_else(|| "asc".into());
        if !(1..=50).contains(&limit) || !matches!(direction.as_str(), "asc" | "desc") {
            return Err("conversation_invalid_request".into());
        }
        let manager = app.state::<crate::SessionManager>();
        let client = manager
            .background_client
            .lock()
            .map_err(|_| "conversation_unavailable")?
            .clone()
            .ok_or("conversation_unavailable")?;
        let owner = format!("{:p}", Arc::as_ptr(&client));
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| "conversation_storage_unavailable")?;
        let before = crate::get_session(
            app.clone(),
            app.state::<crate::SessionManager>(),
            session_id.clone(),
        )
        .map_err(|_| "conversation_unavailable")?;
        let identity = record_identity(&before, &root, &owner)?;
        let raw = cursor
            .as_deref()
            .map(|c| r.cursor(&w, &identity, c, &direction, limit))
            .transpose()?;
        let program = crate::find_executable("codex").ok_or("conversation_unsupported")?;
        #[cfg(windows)]
        if program
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        {
            return Err("conversation_unsupported".into());
        }
        let mut command = Command::new(program);
        command.args(["--no-daemon", "app-server", "--listen", "stdio://"]);
        let page = read_page(
            command,
            &identity,
            raw.as_deref(),
            limit,
            &direction,
            &flag,
            Duration::from_secs(6),
        )?;
        let after = crate::get_session(
            app.clone(),
            app.state::<crate::SessionManager>(),
            session_id.clone(),
        )
        .map_err(|_| "conversation_unavailable")?;
        let current = manager
            .background_client
            .lock()
            .map_err(|_| "conversation_unavailable")?
            .clone()
            .ok_or("conversation_identity_changed")?;
        if !Arc::ptr_eq(&client, &current) {
            return Err("conversation_identity_changed".into());
        }
        let current = record_identity(&after, &root, &owner)?;
        r.finish_page(
            &w, &token, identity, current, page, &direction, limit, &flag,
        )
    })
    .await;
    requests.finish(&scope, &query_token);
    result.map_err(|_| "conversation_unavailable".to_string())?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) fn cancel_codex_conversation(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    query_token: String,
) -> Result<(), String> {
    if !token_valid(&query_token) {
        return Err("conversation_invalid_request".into());
    }
    requests.cancel(window.label(), &query_token);
    Ok(())
}
fn read_page(
    mut command: Command,
    id: &Identity,
    cursor: Option<&str>,
    limit: u16,
    direction: &str,
    cancel: &AtomicBool,
    budget: Duration,
) -> Result<RawPage, String> {
    if !(1..=50).contains(&limit)
        || !matches!(direction, "asc" | "desc")
        || cursor.is_some_and(|s| s.is_empty() || s.len() > 8192)
    {
        return Err("conversation_invalid_request".into());
    }
    let deadline = Instant::now() + budget;
    check(cancel, deadline)?;
    if home_stamp(&id.home)? != id.storage {
        return Err("conversation_identity_changed".into());
    }
    command.current_dir(&id.cwd).env_clear();
    for name in [
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "USER",
        "LOGNAME",
        "SystemRoot",
    ] {
        if let Some(v) = std::env::var_os(name) {
            command.env(name, v);
        }
    }
    command
        .env("CODEX_HOME", &id.home)
        .env("NO_PROXY", "*")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
    let mut child = command.spawn().map_err(|_| "conversation_unavailable")?;
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle;
        match crate::WindowsJob::attach(child.as_raw_handle()) {
            Ok(j) => j,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("conversation_unavailable".into());
            }
        }
    };
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::sync_channel(4);
    let reader = std::thread::spawn(move || {
        let mut out = std::io::BufReader::new(stdout);
        for _ in 0..64 {
            let mut bytes = Vec::new();
            let result = (&mut out)
                .take(LIMIT as u64 + 1)
                .read_until(b'\n', &mut bytes);
            let value = match result {
                Ok(0) => break,
                Ok(_) if bytes.len() > LIMIT => Err("conversation_response_too_large".to_string()),
                Ok(_) if bytes.last() != Some(&b'\n') => {
                    Err("conversation_invalid_response".into())
                }
                Ok(_) => serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| "conversation_invalid_response".into()),
                Err(_) => Err("conversation_unavailable".into()),
            };
            let stop = value.is_err();
            if send.try_send(value).is_err() || stop {
                break;
            }
        }
    });
    let (input, writer) = spawn_writer(child.stdin.take().unwrap());
    let result = (|| {
        let mut serial = 0u64;
        let mut rpc = |method: &str, params: Value| -> Result<Value, String> {
            check(cancel, deadline)?;
            serial += 1;
            let mut bytes =
                serde_json::to_vec(&json!({"id":serial,"method":method,"params":params}))
                    .map_err(|_| "conversation_unavailable")?;
            bytes.push(b'\n');
            input
                .try_send(bytes)
                .map_err(|_| "conversation_unavailable")?;
            loop {
                check(cancel, deadline)?;
                match receive.recv_timeout(Duration::from_millis(15)) {
                    Ok(value) => {
                        let value = value?;
                        if value.get("method").is_some() {
                            if value.get("id").is_none() {
                                continue;
                            }
                            return Err("conversation_unavailable".into());
                        }
                        if value["id"].as_u64() != Some(serial) {
                            return Err("conversation_invalid_response".into());
                        }
                        if value.get("error").is_some() {
                            return Err("conversation_unavailable".into());
                        }
                        if method == "initialize" {
                            input
                                .try_send(b"{\"method\":\"initialized\"}\n".to_vec())
                                .map_err(|_| "conversation_unavailable")?;
                        }
                        return value
                            .get("result")
                            .cloned()
                            .ok_or("conversation_invalid_response".into());
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => return Err("conversation_invalid_response".into()),
                }
            }
        };
        rpc(
            "initialize",
            json!({"clientInfo":{"name":"yam-history","version":"0.1.0"},"capabilities":{"experimentalApi":false}}),
        )?;
        let meta = rpc(
            "thread/read",
            json!({"threadId":id.thread,"includeTurns":false}),
        )?;
        let t = &meta["thread"];
        if t["historyMode"] != "paginated" {
            return Err("conversation_unsupported".into());
        }
        if t["id"] != id.thread
            || t["modelProvider"] != id.provider
            || t["cwd"]
                .as_str()
                .and_then(|s| Path::new(s).canonicalize().ok())
                .as_ref()
                != Some(&id.cwd)
        {
            return Err("conversation_identity_changed".into());
        }
        let mut params = json!({"threadId":id.thread,"limit":limit,"sortDirection":direction});
        if let Some(c) = cursor {
            params["cursor"] = json!(c)
        }
        let page = rpc("thread/items/list", params)?;
        let data = page["data"]
            .as_array()
            .filter(|d| d.len() <= limit as usize)
            .ok_or("conversation_invalid_response")?;
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for row in data {
            let item = project(row)?;
            if !seen.insert((item.turn_id.clone(), item.id.clone())) {
                return Err("conversation_invalid_response".into());
            }
            items.push(item)
        }
        let next = match page.get("nextCursor") {
            Some(Value::Null) => None,
            Some(Value::String(s))
                if !s.is_empty() && s.len() <= 8192 && Some(s.as_str()) != cursor =>
            {
                Some(s.clone())
            }
            _ => return Err("conversation_invalid_response".into()),
        };
        check(cancel, deadline)?;
        Ok(RawPage { items, next })
    })();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    #[cfg(windows)]
    drop(job);
    let _ = child.wait();
    drop(input);
    let _ = writer.join();
    let _ = reader.join();
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn closure_t06_changed_storage_refuses_before_any_rpc_process_can_start() {
        for changed in ["home", "sessions"] {
            let fixture = Fixture::new();
            let identity = fixture.identity();
            let path = if changed == "home" {
                fixture.0.join("home")
            } else {
                fixture.0.join("home/sessions")
            };
            std::fs::rename(&path, fixture.0.join("retired")).unwrap();
            std::fs::create_dir_all(fixture.0.join("home/sessions")).unwrap();
            let marker = fixture.0.join("rpc-started");
            let mut command = Command::new("python3");
            command
                .args([
                    "-c",
                    "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('started')",
                ])
                .arg(&marker);
            let result = read_page(
                command,
                &identity,
                None,
                2,
                "asc",
                &AtomicBool::new(false),
                Duration::from_millis(500),
            );
            assert!(
                !marker.exists(),
                "changed {changed} still started a process using its replacement"
            );
            assert_eq!(result.unwrap_err(), "conversation_identity_changed");
        }
    }

    #[cfg(unix)]
    #[test]
    fn closure_t06_linked_or_non_directory_storage_never_starts_a_reader() {
        for changed in ["home-link", "sessions-link", "sessions-file"] {
            let fixture = Fixture::new();
            let identity = fixture.identity();
            let path = if changed == "home-link" {
                fixture.0.join("home")
            } else {
                fixture.0.join("home/sessions")
            };
            std::fs::rename(&path, fixture.0.join("retired")).unwrap();
            if changed == "sessions-file" {
                std::fs::write(&path, b"not a directory").unwrap();
            } else {
                std::fs::create_dir_all(fixture.0.join("other/sessions")).unwrap();
                std::os::unix::fs::symlink(fixture.0.join("other"), &path).unwrap();
            }
            let marker = fixture.0.join("rpc-started");
            let mut command = Command::new("python3");
            command
                .args([
                    "-c",
                    "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('started')",
                ])
                .arg(&marker);
            let result = read_page(
                command,
                &identity,
                None,
                2,
                "asc",
                &AtomicBool::new(false),
                Duration::from_millis(500),
            );
            assert_eq!(result.unwrap_err(), "conversation_storage_unavailable");
            assert!(!marker.exists());
        }
    }

    #[test]
    fn closure_t06_post_rpc_identity_cancel_and_superseded_token_never_commit_a_cursor() {
        let token = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        for change in [
            "none",
            "home",
            "sessions",
            "owner",
            "generation",
            "provider",
            "cancel",
            "superseded",
            "reused_token",
            "finished",
            "empty",
        ] {
            let fixture = Fixture::new();
            let requests = Requests::default();
            let flag = requests.begin("main", token).unwrap();
            let identity = fixture.identity();
            let page = fixture
                .query(
                    if change == "empty" { "empty" } else { "normal" },
                    None,
                    "asc",
                    &flag,
                )
                .unwrap();
            let mut current = identity.clone();
            match change {
                "home" | "sessions" => {
                    let path = if change == "home" {
                        fixture.0.join("home")
                    } else {
                        fixture.0.join("home/sessions")
                    };
                    std::fs::rename(path, fixture.0.join("retired")).unwrap();
                    std::fs::create_dir_all(fixture.0.join("home/sessions")).unwrap();
                    current = fixture.identity();
                }
                "owner" => current.owner = "new-owner".into(),
                "generation" => current.generation = "new-generation".into(),
                "provider" => current.provider = "new-provider".into(),
                "cancel" => requests.cancel("main", token),
                "superseded" | "reused_token" => {
                    requests.finish("main", token);
                    requests
                        .begin(
                            "main",
                            if change == "superseded" {
                                "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
                            } else {
                                token
                            },
                        )
                        .unwrap();
                }
                "finished" => requests.finish("main", token),
                _ => {}
            }
            let result = requests.finish_page(
                "main",
                token,
                identity.clone(),
                current,
                page,
                "asc",
                2,
                &flag,
            );
            if matches!(change, "none" | "empty") {
                let page = result.unwrap();
                assert_eq!(page.query_token, token);
                assert_eq!(page.generation, identity.generation);
                if change == "none" {
                    let opaque = page.next_cursor.unwrap();
                    assert_ne!(opaque, "native-next");
                    assert_eq!(
                        requests
                            .cursor("main", &identity, &opaque, "asc", 2)
                            .unwrap(),
                        "native-next"
                    );
                } else {
                    assert!(page.next_cursor.is_none() && page.items.is_empty());
                }
            } else {
                assert!(
                    result.is_err(),
                    "{change} unexpectedly published a stale page"
                );
                assert_eq!(
                    result.err().unwrap(),
                    if matches!(
                        change,
                        "cancel" | "superseded" | "reused_token" | "finished"
                    ) {
                        "conversation_cancelled"
                    } else {
                        "conversation_identity_changed"
                    }
                );
                assert!(
                    requests.0.lock().unwrap()["main"].cursors.is_empty(),
                    "{change} committed a stale page cursor"
                );
            }
        }
    }

    #[test]
    fn closure_t06_oversized_projected_real_rpc_page_preserves_existing_cursor_budget() {
        for mode in ["fresh_cursor", "cached_cursor", "no_cursor"] {
            let fixture = Fixture::new();
            let identity = fixture.identity();
            let requests = Requests::default();
            let token = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
            let flag = requests.begin("main", token).unwrap();
            let original = if mode == "cached_cursor" {
                "native-next"
            } else {
                "old-0"
            };
            let first = requests
                .save_cursor("main", &identity, original, "asc", 50)
                .unwrap();
            for n in 1..128 {
                requests
                    .save_cursor("main", &identity, &format!("old-{n}"), "asc", 50)
                    .unwrap();
            }
            let before = requests.0.lock().unwrap()["main"].cursors.len();
            let mut command = Command::new("python3");
            command
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../tests/fixtures/codex_conversation_rpc.py"
                ))
                .arg("projection_boundary");
            let mut page = read_page(
                command,
                &identity,
                None,
                50,
                "asc",
                &flag,
                Duration::from_secs(2),
            )
            .unwrap();
            assert_eq!(page.items.len(), 50);
            if mode == "no_cursor" {
                page.next = None;
            }
            let result = requests.finish_page(
                "main",
                token,
                identity.clone(),
                identity.clone(),
                page,
                "asc",
                50,
                &flag,
            );
            assert_eq!(result.err().unwrap(), "conversation_response_too_large");
            assert_eq!(requests.0.lock().unwrap()["main"].cursors.len(), before);
            assert_eq!(
                requests
                    .cursor("main", &identity, &first, "asc", 50)
                    .unwrap(),
                original,
                "a rejected projected page evicted a valid existing cursor"
            );
        }
    }

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "yam-conversation-{}",
                crate::agent_bridge::credential().unwrap()
            ));
            std::fs::create_dir_all(p.join("project")).unwrap();
            std::fs::create_dir_all(p.join("home/sessions")).unwrap();
            Self(p)
        }
        fn identity(&self) -> Identity {
            Identity {
                session: "s-one".into(),
                thread: "native-one".into(),
                generation: "launch-one".into(),
                conversation: Some("conversation-one".into()),
                started: 1,
                cwd: self.0.join("project").canonicalize().unwrap(),
                home: self.0.join("home").canonicalize().unwrap(),
                provider: "yam_api".into(),
                owner: "owner-one".into(),
                storage: home_stamp(&self.0.join("home")).unwrap(),
            }
        }
        fn query(
            &self,
            mode: &str,
            cursor: Option<&str>,
            direction: &str,
            cancel: &std::sync::atomic::AtomicBool,
        ) -> Result<RawPage, String> {
            let mut c = std::process::Command::new("python3");
            c.arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/codex_conversation_rpc.py"
            ))
            .arg(mode);
            read_page(
                c,
                &self.identity(),
                cursor,
                2,
                direction,
                cancel,
                std::time::Duration::from_millis(700),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn codex_conversation_record_identity_requires_native_local_launch() {
        let f = Fixture::new();
        let mut record:crate::SessionRecord=serde_json::from_value(json!({"conversation_id":"c","summary":{"session_id":"s","cwd":f.0.join("project"),"command":null,"status":"running","launch":{"adapter":"codex","mode":"interactive","prompt":"","extra_args":"","env_refs":{},"provider":{"id":"custom","model":"model","base_url":"http://127.0.0.1:9876/v1","api_key_env":null}}},"status":"running","exit_code":null,"reason":null,"started_at":1,"ended_at":null,"agent":{"generation":"g","agent_session_id":"native","turn_id":null,"phase":"idle","background":"unknown","integration":"connected","revision":0,"turns":[],"seen":[],"inbox":[]}})).unwrap();
        assert!(record_identity(&record, &f.0, "owner").is_err());
        let launch = record.summary.launch.as_ref().unwrap();
        let env = crate::provider_launch::prepare(&f.0, launch, &|name| {
            assert!(
                matches!(name, "CODEX_HOME" | "HOME" | "USERPROFILE"),
                "no credential lookup for keyless fixture"
            );
            None
        })
        .unwrap();
        assert!(record_identity(&record, &f.0, "owner").is_err());
        std::fs::create_dir(env.home.as_ref().unwrap().join("sessions")).unwrap();
        assert!(record_identity(&record, &f.0, "owner").is_ok());
        let before = std::fs::read(env.home.as_ref().unwrap().join("config.toml")).unwrap();
        record_identity(&record, &f.0, "owner").unwrap();
        assert_eq!(
            before,
            std::fs::read(env.home.as_ref().unwrap().join("config.toml")).unwrap()
        );
        record.agent.generation.clear();
        assert!(record_identity(&record, &f.0, "owner").is_err());
        record.agent.generation = "g".into();
        record.agent.agent_session_id = None;
        assert!(record_identity(&record, &f.0, "owner").is_err());
        record.agent.agent_session_id = Some("native".into());
        record.summary.launch.as_mut().unwrap().adapter = "claude".into();
        assert!(record_identity(&record, &f.0, "owner").is_err());
    }
    #[test]
    #[ignore = "requires explicit synthetic P0 receipt; never reads user history"]
    fn codex_conversation_actual_cli_reopens_only_explicit_synthetic_store() {
        let receipt =
            std::env::var("YAM_SYNTHETIC_CODEX_RECEIPT").expect("explicit synthetic receipt");
        let prior: Value = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        let fixture = PathBuf::from(prior["fixture"].as_str().unwrap());
        assert!(fixture
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("codex-private-"));
        let before = std::fs::read(fixture.join("requests.jsonl")).unwrap();
        let id = Identity {
            session: "synthetic-only".into(),
            thread: prior["thread_id"].as_str().unwrap().into(),
            generation: "synthetic-generation".into(),
            conversation: None,
            started: 1,
            cwd: fixture.join("project").canonicalize().unwrap(),
            home: fixture.join("store").canonicalize().unwrap(),
            provider: "p0".into(),
            owner: "synthetic-only".into(),
            storage: home_stamp(&fixture.join("store")).unwrap(),
        };
        let expected = prior["ordered_entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["item"]["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let mut ids = Vec::new();
        let mut cursor = None;
        let cancel = AtomicBool::new(false);
        for _ in 0..5 {
            let mut c = Command::new(crate::find_executable("codex").unwrap());
            c.args(["--no-daemon", "app-server", "--listen", "stdio://"]);
            let page = read_page(
                c,
                &id,
                cursor.as_deref(),
                3,
                "asc",
                &cancel,
                Duration::from_secs(6),
            )
            .unwrap();
            ids.extend(page.items.iter().map(|v| v.id.clone()));
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        assert!(cursor.is_none());
        assert_eq!(ids, expected);
        assert_eq!(
            before,
            std::fs::read(fixture.join("requests.jsonl")).unwrap()
        );
    }
    #[test]
    fn codex_conversation_reads_fixed_methods_and_projects_order_without_hidden_reasoning() {
        let f = Fixture::new();
        let flag = AtomicBool::new(false);
        let page = f.query("normal", None, "asc", &flag).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].kind, "user");
        assert_eq!(page.items[0].text, "hello <script>");
        assert_eq!(page.items[1].kind, "unknown");
        assert!(!serde_json::to_string(&page.items)
            .unwrap()
            .contains("SECRET_REASONING"));
        assert_eq!(page.next.as_deref(), Some("native-next"));
        let next = f
            .query("normal", Some("native-next"), "asc", &flag)
            .unwrap();
        assert_eq!(next.items[0].id, "agent-two");
        assert!(next.next.is_none());
        assert_eq!(f.query("empty", None, "asc", &flag).unwrap().items.len(), 0);
    }
    #[test]
    fn codex_conversation_rejects_metadata_protocol_size_timeout_and_cancellation() {
        let f = Fixture::new();
        let flag = AtomicBool::new(false);
        for mode in [
            "thread",
            "cwd",
            "provider",
            "legacy",
            "missing_mode",
            "bad_json",
            "wrong_id",
            "rpc_error",
            "duplicate",
            "too_many",
            "bad_item",
            "big",
            "unterminated",
        ] {
            assert!(f.query(mode, None, "asc", &flag).is_err(), "{mode}");
        }
        assert_eq!(
            f.query("hang", None, "asc", &flag).unwrap_err(),
            "conversation_timed_out"
        );
        flag.store(true, Ordering::Release);
        assert_eq!(
            f.query("normal", None, "asc", &flag).unwrap_err(),
            "conversation_cancelled"
        );
        flag.store(false, Ordering::Release);
        let flag = Arc::new(flag);
        let copy = flag.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            copy.store(true, Ordering::Release)
        });
        assert_eq!(
            f.query("hang", None, "asc", &flag).unwrap_err(),
            "conversation_cancelled"
        );
        t.join().unwrap();
    }
    #[test]
    fn codex_conversation_cursor_and_requests_are_bounded_and_identity_bound() {
        let f = Fixture::new();
        let id = f.identity();
        let requests = Requests::default();
        let token = "11111111-1111-1111-1111-111111111111";
        let flag = requests.begin("main", token).unwrap();
        assert!(requests.begin("main", token).is_err());
        requests.cancel("main", token);
        assert!(flag.load(Ordering::Acquire));
        requests.finish("main", token);
        assert!(requests.begin("main", token).is_err());
        let cursor = requests
            .save_cursor("main", &id, "native-next", "asc", 2)
            .unwrap();
        assert!(cursor.len() <= 8192);
        assert_ne!(cursor, "native-next");
        assert_eq!(
            requests.cursor("main", &id, &cursor, "asc", 2).unwrap(),
            "native-next"
        );
        let mut other = id.clone();
        other.generation = "other".into();
        assert!(requests.cursor("main", &other, &cursor, "asc", 2).is_err());
        for other in ["desc", "bad"] {
            assert!(requests.cursor("main", &id, &cursor, other, 2).is_err());
        }
        assert!(requests
            .cursor("other-window", &id, &cursor, "asc", 2)
            .is_err());
        assert_eq!(
            requests.cursor("main", &id, &cursor, "asc", 50).unwrap(),
            "native-next"
        );
        assert!(requests
            .save_cursor("main", &id, &"x".repeat(8193), "asc", 2)
            .is_err());
    }
    #[test]
    fn codex_conversation_writer_does_not_block_the_deadline_supervisor() {
        struct Blocked(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
        impl Write for Blocked {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.send(()).unwrap();
                self.1.recv().unwrap();
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (send, join) = spawn_writer(Blocked(entered, wait));
        send.try_send(vec![b'x'; 50000]).unwrap();
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        let flag = AtomicBool::new(true);
        assert_eq!(
            check(&flag, Instant::now() + Duration::from_secs(1)).unwrap_err(),
            "conversation_cancelled"
        );
        release.send(()).unwrap();
        drop(send);
        join.join().unwrap();
    }
    #[test]
    fn codex_conversation_stalled_stdin_still_obeys_deadline() {
        let f = Fixture::new();
        let now = Instant::now();
        let flag = AtomicBool::new(false);
        assert!(f
            .query("blocked_write", Some(&"\0".repeat(8192)), "asc", &flag)
            .is_err());
        assert!(
            now.elapsed() < Duration::from_millis(1600),
            "stdin was not supervised: {:?}",
            now.elapsed()
        );
    }
    #[test]
    fn codex_conversation_projection_bounds_text_and_never_exposes_arbitrary_payloads() {
        let row = json!({"turnId":"turn","item":{"type":"commandExecution","id":"tool","command":"echo hi","aggregatedOutput":"x".repeat(70000),"secret":"HIDDEN"}});
        let p = project(&row).unwrap();
        assert_eq!(p.kind, "tool");
        assert!(p.truncated);
        assert!(p.text.len() <= 65536);
        assert!(!p.text.contains("HIDDEN"));
        let files=project(&json!({"turnId":"t","item":{"id":"f","type":"fileChange","changes":[{"path":"/tmp/example","diff":"patch"}]}})).unwrap();
        assert_eq!(files.paths, vec!["/tmp/example"]);
        assert!(
            project(&json!({"turnId":"t","item":{"type":"agentMessage","text":"missing ID"}}))
                .is_err()
        );
    }
}
