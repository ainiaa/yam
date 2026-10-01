mod agent_bridge;
mod agent_events;
pub fn agent_helper_entry() -> bool {
    agent_bridge::helper_entry()
}
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(any(target_os = "linux", test))]
mod linux_notifications;
#[cfg(target_os = "macos")]
mod mac_notifications;
#[cfg(any(windows, test))]
mod windows_notifications;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SESSION_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SESSION_HISTORY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HealthReport {
    pub app: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentLaunch {
    pub adapter: String,
    pub mode: String,
    pub extra_args: String,
    pub prompt: Option<String>,
}

fn parse_agent_args(input: &str) -> Result<Vec<String>, String> {
    if input.contains('\0') || input.len() > 65536 {
        return Err("Invalid CLI arguments".into());
    }
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if Some(ch) == quote {
            quote = None;
        } else if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
            started = true;
        } else if ch == '\\'
            && quote != Some('\'')
            && chars.peek().is_some_and(|next| {
                *next == '"' || *next == '\\' || (quote.is_none() && next.is_whitespace())
            })
        {
            current.push(chars.next().expect("peeked argument character"));
            started = true;
        } else if quote.is_none() && ch.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(ch);
            started = true;
        }
    }
    if quote.is_some() {
        return Err("CLI arguments contain an unclosed quote".into());
    }
    if started {
        args.push(current);
    }
    if args.len() > 128 {
        return Err("Too many CLI arguments".into());
    }
    Ok(args)
}

fn agent_command(executable: &Path, launch: &AgentLaunch) -> Result<CommandBuilder, String> {
    if !matches!(launch.adapter.as_str(), "codex" | "claude")
        || !matches!(launch.mode.as_str(), "task" | "interactive")
    {
        return Err("Unknown agent or launch mode".into());
    }
    let prompt = launch
        .prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty());
    if launch.mode == "task" && prompt.is_none() {
        return Err("Single task mode requires a prompt".into());
    }
    if prompt.is_some_and(|prompt| prompt.contains('\0') || prompt.len() > 1024 * 1024) {
        return Err("Invalid agent prompt".into());
    }
    let mut builder = CommandBuilder::new(executable);
    #[cfg(windows)]
    if executable.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    }) {
        // npm shims are launched through Node directly; cmd.exe never interprets the user's prompt.
        let directory = executable
            .parent()
            .ok_or_else(|| "Invalid CLI wrapper path".to_string())?;
        let script = directory.join(if launch.adapter == "codex" {
            "node_modules/@openai/codex/bin/codex.js"
        } else {
            "node_modules/@anthropic-ai/claude-code/cli.js"
        });
        if !script.is_file() {
            return Err("This batch wrapper cannot be launched safely. Select a native CLI executable or use Custom command.".into());
        }
        let node = if directory.join("node.exe").is_file() {
            directory.join("node.exe")
        } else {
            find_executable("node")
                .ok_or_else(|| "Node.js is required for this npm-installed agent".to_string())?
        };
        builder = CommandBuilder::new(node);
        builder.arg(script);
    }
    if launch.mode == "task" {
        if launch.adapter == "codex" {
            builder.args(["exec", "--json"]);
        } else {
            builder.args(["--print", "--output-format", "stream-json", "--verbose"]);
        }
    }
    builder.args(parse_agent_args(&launch.extra_args)?);
    if let Some(prompt) = prompt {
        builder.arg("--");
        builder.arg(prompt);
    }
    Ok(builder)
}

fn valid_resume_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, b)| {
            if [8, 13, 18, 23].contains(&index) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn resume_source(
    history: &HistoryStore,
    session_id: &str,
) -> Result<(String, AgentLaunch, String), String> {
    let record = history
        .list()?
        .into_iter()
        .find(|record| record.summary.session_id == session_id)
        .ok_or("Resume source is missing from YAM history")?;
    if matches!(record.status.as_str(), "starting" | "running") {
        return Err("This conversation is already running; select its terminal".into());
    }
    let mut launch = record
        .summary
        .launch
        .ok_or("This history has no supported Agent conversation")?;
    if record.summary.command.is_some()
        || launch.adapter != "codex"
        || launch.mode != "interactive"
        || !launch.extra_args.trim().is_empty()
    {
        return Err(
            "Native resume is currently supported for default Codex interactive sessions only"
                .into(),
        );
    }
    let id = record
        .agent
        .agent_session_id
        .filter(|id| valid_resume_id(id))
        .ok_or("No trusted native conversation ID is available")?;
    if record.agent.generation.is_empty() {
        return Err("Conversation identity was not established by a YAM launch".into());
    }
    validate_working_directory(&record.summary.cwd)?;
    launch.prompt = None;
    Ok((record.summary.cwd, launch, id))
}
fn resume_command(
    executable: &Path,
    launch: &AgentLaunch,
    id: &str,
) -> Result<CommandBuilder, String> {
    if !valid_resume_id(id)
        || launch.adapter != "codex"
        || launch.mode != "interactive"
        || !launch.extra_args.trim().is_empty()
        || launch.prompt.is_some()
    {
        return Err("Invalid native resume request".into());
    }
    let mut command = agent_command(executable, launch)?;
    command.args(["resume", id]);
    Ok(command)
}

struct AgentProtocol {
    adapter: Option<String>,
    pending: String,
    discarding: bool,
    phase: String,
    outcome: Option<String>,
}

impl AgentProtocol {
    fn new(adapter: Option<&str>) -> Self {
        Self {
            adapter: adapter.map(str::to_string),
            pending: String::new(),
            discarding: false,
            phase: "idle".into(),
            outcome: None,
        }
    }
    fn push(&mut self, data: &str) {
        if self.adapter.is_none() {
            return;
        }
        self.pending.push_str(data);
        while let Some(end) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=end).collect();
            if self.discarding {
                self.discarding = false;
                continue;
            }
            if line.len() <= 1024 * 1024 {
                self.parse_line(line.trim());
            }
        }
        // ponytail: JSONL records above 1 MiB are skipped; raise the bound if real agent fixtures require it.
        if self.pending.len() > 1024 * 1024 {
            self.pending.clear();
            self.discarding = true;
        }
    }
    fn finish(&mut self) {
        let tail = std::mem::take(&mut self.pending);
        if !self.discarding {
            self.parse_line(tail.trim());
        }
    }
    fn parse_line(&mut self, line: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        if value
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null())
        {
            return;
        }
        match (self.adapter.as_deref(), value["type"].as_str()) {
            (Some("codex"), Some("turn.started")) => {
                self.phase = "working".into();
                self.outcome = None;
            }
            (Some("codex"), Some("turn.completed")) => {
                self.phase = "completed".into();
                self.outcome = Some("succeeded".into());
            }
            (Some("codex"), Some("turn.failed")) => {
                self.phase = "failed".into();
                self.outcome = Some("failed".into());
            }
            (Some("claude"), Some("result")) => {
                let status = if value["is_error"].as_bool() == Some(true)
                    || value["subtype"].as_str() != Some("success")
                {
                    "failed"
                } else if value["permission_denials"]
                    .as_array()
                    .is_some_and(|denials| !denials.is_empty())
                {
                    "needs_attention"
                } else {
                    "succeeded"
                };
                self.phase = match status {
                    "succeeded" => "completed",
                    "failed" => "failed",
                    _ => "waiting",
                }
                .into();
                self.outcome = Some(status.into());
            }
            (Some("claude"), Some("system")) if value["subtype"] == "permission_denied" => {
                self.phase = "waiting".into();
                self.outcome = Some("needs_attention".into());
            }
            (Some("claude"), Some("assistant" | "stream_event")) => self.phase = "working".into(),
            _ => {}
        }
    }
    fn phase(&self) -> &str {
        &self.phase
    }
    fn terminal_status(&self, success: bool) -> &str {
        if !success {
            "failed"
        } else if self.adapter.is_none() {
            "succeeded"
        } else {
            self.outcome.as_deref().unwrap_or("needs_attention")
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: String,
    #[serde(default)]
    pub launch: Option<AgentLaunch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentAdapter {
    pub id: String,
    pub label: String,
    pub executable: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRecord {
    pub summary: SessionSummary,
    pub status: String,
    pub exit_code: Option<u32>,
    pub reason: Option<String>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub output_end_offset: u64,
    #[serde(default)]
    pub notification_pending: bool,
    #[serde(default)]
    pub agent: agent_events::AgentState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionMessage {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionOutput {
    session_id: String,
    data: String,
    offset: u64,
    end_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
struct LogSnapshot {
    data: String,
    offset: u64,
    end_offset: u64,
    status: String,
}

struct SessionLog {
    file: File,
    end_offset: u64,
    error: Option<String>,
}

#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut result = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(text) => {
                    result.push_str(text);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    result.push_str(
                        std::str::from_utf8(&self.pending[consumed..consumed + valid])
                            .expect("valid UTF-8 prefix"),
                    );
                    consumed += valid;
                    match error.error_len() {
                        Some(length) => {
                            result.push('�');
                            consumed += length;
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        result
    }
    fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        tail
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionStateEvent {
    session_id: String,
    status: String,
    exit_code: Option<u32>,
    reason: Option<String>,
}

#[cfg(windows)]
struct WindowsJob(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl WindowsJob {
    fn attach(process: std::os::windows::io::RawHandle) -> Result<Self, String> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        #[repr(C)]
        #[derive(Default)]
        struct BasicLimits {
            process_time: i64,
            job_time: i64,
            flags: u32,
            minimum_working_set: usize,
            maximum_working_set: usize,
            active_processes: u32,
            affinity: usize,
            priority: u32,
            scheduling: u32,
        }
        #[repr(C)]
        #[derive(Default)]
        struct ExtendedLimits {
            basic: BasicLimits,
            io_counters: [u64; 6],
            process_memory: usize,
            job_memory: usize,
            peak_process_memory: usize,
            peak_job_memory: usize,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateJobObjectW(
                attributes: *const std::ffi::c_void,
                name: *const u16,
            ) -> std::os::windows::io::RawHandle;
            fn SetInformationJobObject(
                job: std::os::windows::io::RawHandle,
                class: i32,
                information: *const std::ffi::c_void,
                length: u32,
            ) -> i32;
            fn AssignProcessToJobObject(
                job: std::os::windows::io::RawHandle,
                process: std::os::windows::io::RawHandle,
            ) -> i32;
        }
        const EXTENDED_LIMIT_INFORMATION: i32 = 9;
        const KILL_ON_JOB_CLOSE: u32 = 0x2000;
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(format!(
                "Failed to create session job: {}",
                std::io::Error::last_os_error()
            ));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = ExtendedLimits::default();
        limits.basic.flags = KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                EXTENDED_LIMIT_INFORMATION,
                (&limits as *const ExtendedLimits).cast(),
                std::mem::size_of::<ExtendedLimits>() as u32,
            )
        };
        if configured == 0 {
            return Err(format!(
                "Failed to configure session job: {}",
                std::io::Error::last_os_error()
            ));
        }
        if unsafe { AssignProcessToJobObject(handle.as_raw_handle(), process) } == 0 {
            return Err(format!(
                "Failed to attach session process: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(handle))
    }
    fn terminate(&self) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn TerminateJobObject(job: std::os::windows::io::RawHandle, code: u32) -> i32;
        }
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(format!(
                "Failed to terminate session job: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct ResumeClaim {
    claims: Arc<Mutex<std::collections::HashSet<String>>>,
    id: String,
}
impl ResumeClaim {
    fn acquire(
        claims: Arc<Mutex<std::collections::HashSet<String>>>,
        id: &str,
    ) -> Result<Self, String> {
        if !claims
            .lock()
            .map_err(|_| "Resume ownership lock poisoned")?
            .insert(id.into())
        {
            return Err(
                "This conversation is already being resumed; select its running terminal".into(),
            );
        }
        Ok(Self {
            claims,
            id: id.into(),
        })
    }
}
impl Drop for ResumeClaim {
    fn drop(&mut self) {
        if let Ok(mut claims) = self.claims.lock() {
            claims.remove(&self.id);
        }
    }
}

struct Session {
    _resume_claim: Option<ResumeClaim>,
    summary: SessionSummary,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
    log: Mutex<SessionLog>,
    output_done: (Mutex<bool>, Condvar),
    cancel_output: AtomicBool,
    protocol: Mutex<AgentProtocol>,
    history: Arc<HistoryStore>,
    stop_requested: AtomicBool,
    idle_notified: AtomicBool,
    completed: (Mutex<bool>, Condvar),
    last_activity: Mutex<Instant>,
    status: Mutex<String>,
}

pub struct SessionManager {
    resume_claims: Arc<Mutex<std::collections::HashSet<String>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    shutting_down: AtomicBool,
    shutdown_complete: AtomicBool,
    notification_selection: Mutex<Option<String>>,
    history: Mutex<Option<Arc<HistoryStore>>>,
    agent_bridge: Mutex<Option<agent_bridge::Bridge>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            resume_claims: Arc::new(Mutex::new(std::collections::HashSet::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            shutting_down: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            notification_selection: Mutex::new(None),
            history: Mutex::new(None),
            agent_bridge: Mutex::new(None),
        }
    }
}

impl SessionManager {
    fn shutdown(&self) -> Result<(), String> {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?
            .values()
            .cloned()
            .collect();
        for session in &sessions {
            request_session_stop(session)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        for session in &sessions {
            let (lock, ready) = &session.completed;
            let completed = lock
                .lock()
                .map_err(|_| "Completion lock poisoned".to_string())?;
            let (completed, _) = ready
                .wait_timeout_while(
                    completed,
                    deadline.saturating_duration_since(Instant::now()),
                    |done| !*done,
                )
                .map_err(|_| "Completion lock poisoned".to_string())?;
            if !*completed {
                return Err("Session cleanup timed out; the application remains open".into());
            }
        }
        let mut runtime = self
            .agent_bridge
            .lock()
            .map_err(|_| "Agent bridge lock poisoned")?;
        if let Some(bridge) = runtime.as_ref() {
            bridge.stop_until(deadline)?;
        }
        runtime.take();
        self.shutdown_complete.store(true, Ordering::Release);
        Ok(())
    }
}

struct HistoryStore {
    root: PathBuf,
    records: Mutex<Vec<SessionRecord>>,
}
fn bounded_history(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take(MAX_SESSION_HISTORY_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("Failed to read session history: {error}"))?;
    if bytes.len() as u64 > MAX_SESSION_HISTORY_BYTES {
        return Err("Session history exceeds its 32 MiB budget; preserve the file and archive history before retrying".into());
    }
    String::from_utf8(bytes).map_err(|_| "Session history has invalid encoding".into())
}

impl HistoryStore {
    fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create session data directory: {error}"))?;
        let records_path = root.join("sessions.json");
        let records = if records_path.exists() {
            let contents = bounded_history(&records_path)?;
            match serde_json::from_str::<Vec<SessionRecord>>(&contents) {
                Ok(records) => records,
                Err(error) => {
                    let backup = root.join("sessions.json.bak");
                    let backup_contents = bounded_history(&backup).map_err(|_| {
                        format!(
                            "Session history is corrupt ({error}). Original file preserved at {}",
                            records_path.display()
                        )
                    })?;
                    let records =
                        serde_json::from_str(&backup_contents).map_err(|backup_error| {
                            format!("Session history and backup are corrupt: {backup_error}")
                        })?;
                    fs::copy(
                        &records_path,
                        root.join(format!("sessions.corrupt-{}", next_session_id())),
                    )
                    .map_err(|error| format!("Failed to preserve corrupt history: {error}"))?;
                    fs::copy(&backup, &records_path).map_err(|error| {
                        format!("Failed to restore session history backup: {error}")
                    })?;
                    records
                }
            }
        } else {
            Vec::new()
        };
        if records_path.exists() {
            let original = bounded_history(&records_path)?;
            let json: serde_json::Value =
                serde_json::from_str(&original).map_err(|e| e.to_string())?;
            if json
                .as_array()
                .is_some_and(|records| records.iter().any(|record| record.get("agent").is_none()))
            {
                let backup = root.join("sessions.before-agent-events.json");
                if backup.exists() {
                    serde_json::from_str::<Vec<SessionRecord>>(&bounded_history(&backup)?).map_err(|_|"Pre-upgrade history backup is invalid; preserve it and repair before continuing")?;
                } else {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&backup)
                        .map_err(|e| format!("Cannot preserve pre-upgrade history: {e}"))?;
                    file.write_all(original.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|e| format!("Cannot flush pre-upgrade history: {e}"))?;
                }
            }
        }
        Ok(Self {
            root,
            records: Mutex::new(records),
        })
    }

    fn records_path(&self) -> PathBuf {
        self.root.join("sessions.json")
    }

    fn save_locked(&self, records: &[SessionRecord]) -> Result<(), String> {
        let temp_path = self.root.join("sessions.json.tmp");
        let data = serde_json::to_vec_pretty(records)
            .map_err(|error| format!("Failed to encode session history: {error}"))?;
        if data.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err(
                "Session history budget reached; unread agent receipts were preserved".into(),
            );
        }
        let mut file = File::create(&temp_path)
            .map_err(|error| format!("Failed to write session history: {error}"))?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to flush session history: {error}"))?;
        if self.records_path().exists() {
            let backup_temp = self.root.join("sessions.json.bak.tmp");
            fs::copy(self.records_path(), &backup_temp)
                .map_err(|error| format!("Failed to back up session history: {error}"))?;
            OpenOptions::new()
                .write(true)
                .open(&backup_temp)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Failed to flush history backup: {error}"))?;
            fs::rename(&backup_temp, self.root.join("sessions.json.bak"))
                .map_err(|error| format!("Failed to commit history backup: {error}"))?;
        }
        fs::rename(&temp_path, self.records_path())
            .map_err(|error| format!("Failed to commit session history: {error}"))?;
        #[cfg(unix)]
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Failed to flush history directory: {error}"))?;
        Ok(())
    }

    fn start(&self, summary: &SessionSummary) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned".to_string())?;
        let mut updated = records.clone();
        updated.retain(|record| record.summary.session_id != summary.session_id);
        updated.push(SessionRecord {
            summary: summary.clone(),
            status: summary.status.clone(),
            exit_code: None,
            reason: None,
            started_at: unix_timestamp(),
            ended_at: None,
            output_end_offset: 0,
            notification_pending: false,
            agent: agent_events::AgentState::default(),
        });
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    fn update(
        &self,
        session_id: &str,
        status: &str,
        exit_code: Option<u32>,
        reason: Option<String>,
        output_end_offset: Option<u64>,
    ) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned".to_string())?;
        let mut updated = records.clone();
        let record = updated
            .iter_mut()
            .find(|record| record.summary.session_id == session_id)
            .ok_or_else(|| format!("Unknown session: {session_id}"))?;
        record.status = status.to_string();
        record.summary.status = status.to_string();
        record.exit_code = exit_code;
        record.reason = reason;
        if let Some(offset) = output_end_offset {
            record.output_end_offset = offset;
        }
        if is_terminal(status) {
            record.ended_at = Some(unix_timestamp());
            record.notification_pending = true;
        }
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    fn acknowledge_notification(
        &self,
        session_id: &str,
        expected_status: &str,
    ) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned".to_string())?;
        let mut updated = records.clone();
        let record = updated
            .iter_mut()
            .find(|record| record.summary.session_id == session_id)
            .ok_or_else(|| "Unknown notification session".to_string())?;
        // Validate under the history lock: an old receipt must not consume a new state.
        if record.status != expected_status {
            return Ok(());
        }
        record.notification_pending = false;
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    fn list(&self) -> Result<Vec<SessionRecord>, String> {
        self.records
            .lock()
            .map(|records| {
                let mut result = records.clone();
                result.reverse();
                result
            })
            .map_err(|_| "Session history lock poisoned".to_string())
    }

    fn recover_running(&self) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned".to_string())?;
        let mut changed = false;
        let mut updated = records.clone();
        for record in updated.iter_mut() {
            if matches!(record.status.as_str(), "starting" | "running") {
                record.status = "needs_attention".to_string();
                record.summary.status = "needs_attention".to_string();
                record.reason =
                    Some("The application closed while this session was running".to_string());
                record.ended_at = Some(unix_timestamp());
                record.notification_pending = true;
                changed = true;
            }
        }
        if changed {
            self.save_locked(&updated)?;
            *records = updated;
        }
        Ok(())
    }

    fn log_path(&self, session_id: &str) -> PathBuf {
        self.root.join(format!("{session_id}.log"))
    }
}

impl SessionManager {
    fn acknowledge_selection(&self, session_id: &str) -> Result<(), String> {
        let mut pending = self
            .notification_selection
            .lock()
            .map_err(|_| "Notification selection lock poisoned".to_string())?;
        if pending.as_deref() == Some(session_id) {
            *pending = None;
        }
        Ok(())
    }

    fn history(&self, app: &AppHandle) -> Result<Arc<HistoryStore>, String> {
        let mut history = self
            .history
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?;
        if let Some(store) = history.as_ref() {
            return Ok(Arc::clone(store));
        }
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
            .join("sessions");
        let store = Arc::new(HistoryStore::open(root)?);
        store.recover_running()?;
        *history = Some(Arc::clone(&store));
        Ok(store)
    }
    fn start_agent_runtime(
        &self,
        app: &AppHandle,
        history: Arc<HistoryStore>,
    ) -> Result<(), String> {
        let mut runtime = self
            .agent_bridge
            .lock()
            .map_err(|_| "Agent bridge lock poisoned")?;
        agent_bridge::Bridge::retire_stopped(&mut runtime)?;
        if runtime.is_none() {
            let emitter = app.clone();
            *runtime = Some(agent_bridge::Bridge::start(
                history.clone(),
                move |id, error| {
                    let event = if error.is_some() {
                        "session-error"
                    } else {
                        "agent-state"
                    };
                    let _ = emitter.emit(
                        event,
                        SessionMessage {
                            session_id: id.into(),
                            data: error.unwrap_or_else(|| "updated".into()),
                        },
                    );
                    if event == "session-error" {
                        let _ = emitter.emit(
                            "agent-state",
                            SessionMessage {
                                session_id: id.into(),
                                data: "degraded".into(),
                            },
                        );
                    }
                },
            )?);
        }
        let bridge = runtime.as_ref().ok_or("Agent bridge unavailable")?;
        bridge.start_delivery(app.clone())
    }
    fn connect_agent(
        &self,
        app: &AppHandle,
        history: Arc<HistoryStore>,
        id: &str,
        prepared: &agent_bridge::Prepared,
        builder: &mut CommandBuilder,
    ) -> Result<(), String> {
        self.start_agent_runtime(app, history.clone())?;
        let runtime = self
            .agent_bridge
            .lock()
            .map_err(|_| "Agent bridge lock poisoned")?;
        let bridge = runtime.as_ref().ok_or("Agent bridge unavailable")?;
        history.configure_agent(id, &prepared.generation)?;
        bridge.register(id, &prepared.token, &prepared.generation)?;
        prepared.install(builder, bridge.address)
    }
}

impl HealthReport {
    fn current() -> Self {
        Self {
            app: "YAM".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            status: "ready".to_string(),
        }
    }
}

fn session_id_from_link(link: &str) -> Option<String> {
    let url = tauri::Url::parse(link).ok()?;
    if url.scheme() != "yam"
        || url.host_str() != Some("session")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let id = url.path().strip_prefix('/')?;
    if id.len() < 3
        || id.len() > 128
        || !id.starts_with("s-")
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some(id.to_string())
}

pub(crate) fn route_notification_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let manager = app.state::<SessionManager>();
    if !manager
        .history(app)?
        .list()?
        .iter()
        .any(|record| record.summary.session_id == session_id)
    {
        return Err("Notification refers to an unknown session".into());
    }
    *manager
        .notification_selection
        .lock()
        .map_err(|_| "Notification selection lock poisoned".to_string())? = Some(session_id.into());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    app.emit("session-notification-click", session_id)
        .map_err(|error| error.to_string())
}

pub(crate) fn route_notification_link(app: &AppHandle, link: &str) -> Result<(), String> {
    let id = session_id_from_link(link).ok_or_else(|| "Invalid session link".to_string())?;
    route_notification_session(app, &id)
}

#[tauri::command]
fn pending_notification_selection(
    manager: State<'_, SessionManager>,
) -> Result<Option<String>, String> {
    manager
        .notification_selection
        .lock()
        .map(|id| id.clone())
        .map_err(|_| "Notification selection lock poisoned".into())
}

#[tauri::command]
fn acknowledge_notification_selection(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.acknowledge_selection(&session_id)
}

fn next_session_id() -> String {
    let now = unix_timestamp_millis();
    let sequence = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("s-{now:x}-{sequence:x}")
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn session_idle_timeout() -> Duration {
    let seconds = std::env::var("YAM_SESSION_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(15 * 60)
        .max(1);
    Duration::from_secs(seconds)
}

fn validate_working_directory(path: &str) -> Result<(), String> {
    if Path::new(path).is_dir() {
        Ok(())
    } else {
        Err(format!(
            "Working directory does not exist or is not a directory: {path}"
        ))
    }
}

fn append_log(log: &mut File, data: &[u8], max_bytes: u64) -> std::io::Result<()> {
    if max_bytes == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Log size must be positive",
        ));
    }
    let current_size = log.metadata()?.len();
    if current_size.saturating_add(data.len() as u64) > max_bytes {
        // Keep a contiguous tail and leave room for future chunks instead of rewriting 8 MiB per read.
        let keep = (max_bytes / 2).min(max_bytes.saturating_sub(data.len() as u64));
        let mut tail = vec![0; keep.min(current_size) as usize];
        log.seek(SeekFrom::End(-(tail.len() as i64)))?;
        log.read_exact(&mut tail)?;
        let start = tail
            .iter()
            .position(|byte| byte & 0xc0 != 0x80)
            .unwrap_or(tail.len());
        log.set_len(0)?;
        log.seek(SeekFrom::Start(0))?;
        log.write_all(&tail[start..])?;
    }
    let mut start = data.len().saturating_sub(max_bytes as usize);
    while start < data.len() && data[start] & 0xc0 == 0x80 {
        start += 1;
    }
    log.write_all(&data[start..])?;
    log.flush()
}

fn shell_command(command: Option<&str>) -> CommandBuilder {
    #[cfg(windows)]
    {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut builder = CommandBuilder::new(shell);
        builder.arg("/D");
        if let Some(command) = command {
            builder.arg("/C");
            builder.arg(command);
        }
        builder
    }

    #[cfg(not(windows))]
    {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut builder = CommandBuilder::new(shell);
        builder.arg("-l");
        if let Some(command) = command {
            builder.arg("-c");
            builder.arg(command);
        }
        builder
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata().ok()?.permissions().mode() & 0o111 != 0 {
                    return Some(candidate);
                }
            }
            #[cfg(not(unix))]
            return Some(candidate);
        }
        #[cfg(windows)]
        for extension in [".exe", ".cmd", ".bat"] {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn agent_adapters() -> Vec<AgentAdapter> {
    [
        ("shell", "System shell", None),
        ("codex", "OpenAI Codex", Some("codex")),
        ("claude", "Claude Code", Some("claude")),
    ]
    .into_iter()
    .map(|(id, label, executable)| {
        let path = executable.and_then(find_executable);
        let available = id == "shell" || path.is_some();
        AgentAdapter {
            id: id.to_string(),
            label: label.to_string(),
            executable: executable.map(str::to_string),
            available,
        }
    })
    .collect()
}

fn is_terminal(status: &str) -> bool {
    matches!(
        status,
        "succeeded" | "failed" | "stopped" | "needs_attention"
    )
}

#[cfg(unix)]
fn process_tree(root: u32) -> Result<Vec<u32>, String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
        .map_err(|error| format!("Failed to inspect session process tree: {error}"))?;
    if !output.status.success() {
        return Err("Failed to inspect session process tree".into());
    }
    let processes: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect();
    let mut tree = vec![root];
    // A PTY shell owns its POSIX session; job-control children retain that SID after reparenting.
    for &(pid, _) in &processes {
        if pid != root && unsafe { libc::getsid(pid as i32) } == root as i32 {
            tree.push(pid);
        }
    }
    let mut index = 0;
    while index < tree.len() {
        let parent = tree[index];
        for &(pid, ppid) in &processes {
            if ppid == parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        index += 1;
    }
    Ok(tree)
}

#[cfg(unix)]
fn signal_process(pid: u32, signal: i32) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("Refusing unsafe process signal".into());
    }
    if unsafe { libc::kill(pid as i32, signal) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(format!("Failed to signal session process: {error}"));
        }
    }
    Ok(())
}

fn cleanup_session_descendants(session: &Session) -> Result<(), String> {
    #[cfg(unix)]
    {
        let root = session
            .child
            .lock()
            .map_err(|_| "Child lock poisoned".to_string())?
            .process_id()
            .ok_or_else(|| "Session has no process ID".to_string())?;
        let descendants = process_tree(root)?;
        for &pid in descendants.iter().skip(1) {
            signal_process(pid, libc::SIGSTOP)?;
        }
        let result: Result<(), String> = (|| {
            for &pid in process_tree(root)?.iter().skip(1).rev() {
                signal_process(pid, libc::SIGKILL)?;
            }
            Ok(())
        })();
        if result.is_err() {
            for &pid in descendants.iter().skip(1) {
                let _ = signal_process(pid, libc::SIGCONT);
            }
        }
        result?;
    }
    #[cfg(windows)]
    if let Some(job) = &session.job {
        job.terminate()?;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = session;
    Ok(())
}

fn terminate_session(session: &Session) -> Result<(), String> {
    let mut child = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    let pid = child
        .process_id()
        .ok_or_else(|| "Session has no process ID".to_string())?;
    #[cfg(unix)]
    {
        signal_process(pid, libc::SIGSTOP)?;
        let mut stopped = vec![pid];
        let result: Result<(), String> = (|| {
            // Freeze descendants before killing parents so job-control groups cannot escape.
            for _ in 0..8 {
                let tree = process_tree(pid)?;
                for &member in &tree {
                    if !stopped.contains(&member) {
                        signal_process(member, libc::SIGSTOP)?;
                        stopped.push(member);
                    }
                }
                if process_tree(pid)?
                    .iter()
                    .all(|member| stopped.contains(member))
                {
                    for &member in stopped.iter().rev() {
                        signal_process(member, libc::SIGKILL)?;
                    }
                    return Ok(());
                }
            }
            Err("Session process tree kept changing; stop was not completed".into())
        })();
        if result.is_err() {
            for member in stopped {
                let _ = signal_process(member, libc::SIGCONT);
            }
        }
        result
    }
    #[cfg(windows)]
    {
        if let Some(job) = &session.job {
            return job.terminate();
        }
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|error| format!("Failed to stop session process tree: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Failed to stop session process tree: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        child
            .kill()
            .map_err(|error| format!("Failed to stop session: {error}"))
    }
}

fn request_session_stop(session: &Session) -> Result<(), String> {
    let already_terminal = session
        .status
        .lock()
        .map(|status| is_terminal(&status))
        .map_err(|_| "Session status lock poisoned".to_string())?;
    if already_terminal {
        return Ok(());
    }

    let exited = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some();
    if exited {
        cleanup_session_descendants(session)?;
        return Ok(());
    }
    session.stop_requested.store(true, Ordering::Release);
    match terminate_session(session) {
        Ok(()) => Ok(()),
        Err(error) => {
            let exited = session
                .child
                .lock()
                .map_err(|_| "Child lock poisoned".to_string())?
                .try_wait()
                .map_err(|wait_error| wait_error.to_string())?;
            if exited.is_some() {
                Ok(())
            } else {
                session.stop_requested.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
}

fn emit_state(
    app: &AppHandle,
    session: &Session,
    status: &str,
    exit_code: Option<u32>,
    reason: Option<String>,
) -> bool {
    let mut current = session.status.lock().expect("session status lock poisoned");
    if is_terminal(&current) {
        return false;
    }

    *current = status.to_string();
    if let Err(error) = session.history.update(
        &session.summary.session_id,
        status,
        exit_code,
        reason.clone(),
        session.log.lock().ok().map(|log| log.end_offset),
    ) {
        eprintln!("[YAM] {error}");
        let _ = app.emit(
            "session-error",
            SessionMessage {
                session_id: session.summary.session_id.clone(),
                data: error,
            },
        );
    }
    let event = SessionStateEvent {
        session_id: session.summary.session_id.clone(),
        status: status.to_string(),
        exit_code,
        reason,
    };
    let _ = app.emit("session-state", event);
    true
}

fn publish_output(app: &AppHandle, session: &Session, data: String) {
    if data.is_empty() {
        return;
    }
    if let Ok(mut protocol) = session.protocol.lock() {
        let previous = protocol.phase().to_string();
        protocol.push(&data);
        if protocol.phase() != previous {
            let _ = app.emit(
                "session-phase",
                SessionMessage {
                    session_id: session.summary.session_id.clone(),
                    data: protocol.phase().to_string(),
                },
            );
        }
    }
    let Ok(mut log) = session.log.lock() else {
        return;
    };
    let offset = log.end_offset;
    log.end_offset += data.len() as u64;
    if let Err(error) = append_log(&mut log.file, data.as_bytes(), MAX_SESSION_LOG_BYTES) {
        let reason = format!("Failed to persist terminal output: {error}");
        log.error = Some(reason.clone());
        eprintln!("[YAM] {reason}");
        let _ = app.emit(
            "session-error",
            SessionMessage {
                session_id: session.summary.session_id.clone(),
                data: reason,
            },
        );
    }
    let _ = app.emit(
        "session-output",
        SessionOutput {
            session_id: session.summary.session_id.clone(),
            data,
            offset,
            end_offset: log.end_offset,
        },
    );
}

fn finish_session(sessions: &Mutex<HashMap<String, Arc<Session>>>, session: &Session) {
    if let Ok(mut active) = sessions.lock() {
        active.remove(&session.summary.session_id);
    }
    if let Ok(mut completed) = session.completed.0.lock() {
        *completed = true;
        session.completed.1.notify_all();
    }
}

fn idle_reminder_due(session: &Session, idle: Duration, timeout: Duration) -> bool {
    if idle < timeout {
        session.idle_notified.store(false, Ordering::Release);
        return false;
    }
    !session.idle_notified.swap(true, Ordering::AcqRel)
}

#[cfg(unix)]
fn wait_output_ready(fd: i32, cancelled: &AtomicBool) -> std::io::Result<bool> {
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
        if ready > 0 {
            return Ok(true);
        }
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

fn spawn_session_threads(
    app: &AppHandle,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    session: Arc<Session>,
    mut reader: Box<dyn Read + Send>,
) {
    let output_app = app.clone();
    let output_session_id = session.summary.session_id.clone();
    let output_session = Arc::clone(&session);
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        let mut decoder = Utf8Decoder::default();
        #[cfg(unix)]
        let fd = output_session
            .master
            .lock()
            .ok()
            .and_then(|master| master.as_raw_fd());
        loop {
            #[cfg(unix)]
            if let Some(fd) = fd {
                match wait_output_ready(fd, &output_session.cancel_output) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        eprintln!("[YAM] Terminal poll failed: {error}");
                        break;
                    }
                }
            }
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if let Ok(mut activity) = output_session.last_activity.lock() {
                        *activity = Instant::now();
                    }
                    publish_output(&output_app, &output_session, decoder.push(&buffer[..size]));
                }
                Err(error) => {
                    #[cfg(unix)]
                    if error.raw_os_error() == Some(libc::EIO) {
                        break;
                    }
                    let _ = output_app.emit(
                        "session-error",
                        SessionMessage {
                            session_id: output_session_id.clone(),
                            data: format!("Failed to read terminal output: {error}"),
                        },
                    );
                    break;
                }
            }
        }
        publish_output(&output_app, &output_session, decoder.finish());
        if let Ok(mut protocol) = output_session.protocol.lock() {
            protocol.finish();
        }
        if let Ok(mut done) = output_session.output_done.0.lock() {
            *done = true;
            output_session.output_done.1.notify_all();
        }
    });

    let wait_app = app.clone();
    thread::spawn(move || {
        loop {
            let idle = session
                .last_activity
                .lock()
                .map(|activity| activity.elapsed())
                .unwrap_or_default();
            if idle_reminder_due(&session, idle, session_idle_timeout()) {
                let _ = wait_app.emit("session-attention", SessionMessage {
                session_id: session.summary.session_id.clone(),
                data: "No recent activity. The session is still running; check whether input is needed.".into(),
            });
            }

            let result = session
                .child
                .lock()
                .map_err(|_| "child lock poisoned".to_string())
                .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));

            match result {
                Ok(Some(exit)) => {
                    let cleanup = cleanup_session_descendants(&session);
                    let (lock, done) = &session.output_done;
                    let drained = lock
                        .lock()
                        .ok()
                        .and_then(|drained| {
                            done.wait_timeout_while(drained, Duration::from_secs(2), |drained| {
                                !*drained
                            })
                            .ok()
                        })
                        .is_some_and(|(drained, _)| *drained);
                    if let Err(error) = cleanup {
                        emit_state(
                            &wait_app,
                            &session,
                            "failed",
                            Some(exit.exit_code()),
                            Some(error),
                        );
                    } else if !drained {
                        session.cancel_output.store(true, Ordering::Release);
                        emit_state(
                            &wait_app,
                            &session,
                            "failed",
                            Some(exit.exit_code()),
                            Some("Process exited but terminal output did not close".into()),
                        );
                    } else if session.stop_requested.load(Ordering::Acquire) {
                        emit_state(
                            &wait_app,
                            &session,
                            "stopped",
                            Some(exit.exit_code()),
                            Some("Stopped by user".to_string()),
                        );
                    } else {
                        let status = session
                            .protocol
                            .lock()
                            .map(|protocol| protocol.terminal_status(exit.success()).to_string())
                            .unwrap_or_else(|_| "failed".into());
                        let reason = match status.as_str() {
                            "succeeded" => "Task completed successfully",
                            "needs_attention" => {
                                "Agent needs attention or did not report a recognized task result"
                            }
                            _ => {
                                "Agent reported failure or the process exited with a non-zero code"
                            }
                        };
                        emit_state(
                            &wait_app,
                            &session,
                            &status,
                            Some(exit.exit_code()),
                            Some(reason.into()),
                        );
                    }
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(40)),
                Err(error) => {
                    let cleanup = terminate_session(&session);
                    let reason = match cleanup {
                        Ok(()) => error,
                        Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
                    };
                    emit_state(&wait_app, &session, "failed", None, Some(reason));
                    break;
                }
            }
        }
        finish_session(&sessions, &session);
    });
}

#[tauri::command]
fn validate_project_directory(path: String) -> Result<(), String> {
    if !Path::new(&path).is_absolute() {
        return Err("Project directory must be absolute".into());
    }
    validate_working_directory(&path)
}

#[tauri::command]
fn health_check() -> HealthReport {
    HealthReport::current()
}

#[tauri::command]
fn list_adapters() -> Vec<AgentAdapter> {
    agent_adapters()
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
) -> Result<SessionSummary, String> {
    if manager.shutting_down.load(Ordering::Acquire) {
        return Err("Application is closing".into());
    }
    let history = manager.history(&app)?;
    let (cwd, launch, resume_id) = if let Some(source) = resume_from {
        if cwd.is_some() || command.is_some() || launch.is_some() {
            return Err("Resume cannot override the stored conversation launch".into());
        }
        let (cwd, launch, id) = resume_source(&history, &source)?;
        (Some(cwd), Some(launch), Some(id))
    } else {
        (cwd, launch, None)
    };
    let resume_claim = resume_id
        .as_deref()
        .map(|id| ResumeClaim::acquire(manager.resume_claims.clone(), id))
        .transpose()?;
    let id = next_session_id();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to open PTY: {error}"))?;

    if command.is_some() && launch.is_some() {
        return Err("Choose either an agent or a custom command".into());
    }
    let mut builder = if let Some(launch) = &launch {
        let executable = find_executable(&launch.adapter).ok_or_else(|| {
            format!(
                "{} was not found or is not executable on PATH",
                launch.adapter
            )
        })?;
        if let Some(id) = resume_id.as_deref() {
            agent_bridge::validate_resume(
                &executable,
                Path::new(cwd.as_deref().ok_or("Resume directory is missing")?),
                id,
            )?;
            resume_command(&executable, launch, id)?
        } else {
            agent_command(&executable, launch)?
        }
    } else {
        shell_command(command.as_deref())
    };
    let working_directory = cwd
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| ".".into())
                .to_string_lossy()
                .into_owned()
        });
    validate_working_directory(&working_directory)?;
    builder.cwd(&working_directory);
    let integration = launch
        .as_ref()
        .filter(|launch| launch.mode == "interactive")
        .map(|launch| {
            find_executable(&launch.adapter)
                .ok_or_else(|| "Agent executable unavailable".to_string())
                .and_then(|exe| agent_bridge::prepare(&exe, launch, Path::new(&working_directory)))
        });

    let summary = SessionSummary {
        session_id: id,
        cwd: working_directory,
        command,
        status: "starting".to_string(),
        launch,
    };
    let log_path = history.log_path(&summary.session_id);
    let log = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open session log: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read PTY output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY input: {error}"))?;

    let mut active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?;
    if manager.shutting_down.load(Ordering::Acquire) {
        return Err("Application is closing".into());
    }
    history.start(&summary)?;
    if let Some(integration) = integration {
        match integration {
            Ok(prepared) => {
                if let Err(reason) = manager.connect_agent(
                    &app,
                    history.clone(),
                    &summary.session_id,
                    &prepared,
                    &mut builder,
                ) {
                    history.unavailable_agent(&summary.session_id, &reason)?;
                }
            }
            Err(reason) => history.unavailable_agent(&summary.session_id, &reason)?,
        }
    }
    if let Some(native_id) = resume_id.as_deref() {
        history.bind_resume_identity(&summary.session_id, native_id)?;
    }
    #[allow(unused_mut)]
    let mut child = match pair.slave.spawn_command(builder) {
        Ok(child) => child,
        Err(error) => {
            let reason = format!("Failed to start session: {error}");
            history.update(
                &summary.session_id,
                "failed",
                None,
                Some(reason.clone()),
                None,
            )?;
            let _ = app.emit(
                "session-state",
                SessionStateEvent {
                    session_id: summary.session_id.clone(),
                    status: "failed".into(),
                    exit_code: None,
                    reason: Some(reason.clone()),
                },
            );
            return Err(reason);
        }
    };
    // ponytail: portable-pty spawns before Job assignment; strict race-free ownership needs suspended spawning.
    #[cfg(windows)]
    let job = match child
        .as_raw_handle()
        .ok_or_else(|| "Session has no native process handle".to_string())
        .and_then(WindowsJob::attach)
    {
        Ok(job) => Some(job),
        Err(_) if child.try_wait().ok().flatten().is_some() => None,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            history.update(
                &summary.session_id,
                "failed",
                None,
                Some(error.clone()),
                None,
            )?;
            return Err(error);
        }
    };
    let session = Arc::new(Session {
        _resume_claim: resume_claim,
        summary: summary.clone(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        #[cfg(windows)]
        job,
        log: Mutex::new(SessionLog {
            file: log,
            end_offset: 0,
            error: None,
        }),
        output_done: (Mutex::new(false), Condvar::new()),
        cancel_output: AtomicBool::new(false),
        protocol: Mutex::new(AgentProtocol::new(
            summary
                .launch
                .as_ref()
                .filter(|launch| launch.mode == "task")
                .map(|launch| launch.adapter.as_str()),
        )),
        history,
        stop_requested: AtomicBool::new(false),
        idle_notified: AtomicBool::new(false),
        completed: (Mutex::new(false), Condvar::new()),
        last_activity: Mutex::new(Instant::now()),
        status: Mutex::new("starting".to_string()),
    });

    active.insert(summary.session_id.clone(), Arc::clone(&session));
    drop(active);
    let _ = app.emit(
        "session-state",
        SessionStateEvent {
            session_id: summary.session_id.clone(),
            status: "starting".to_string(),
            exit_code: None,
            reason: None,
        },
    );
    emit_state(
        &app,
        &session,
        "running",
        None,
        Some("PTY started".to_string()),
    );
    spawn_session_threads(&app, Arc::clone(&manager.sessions), session, reader);

    Ok(SessionSummary {
        status: "running".to_string(),
        ..summary
    })
}

#[tauri::command]
fn write_session(
    manager: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown session: {session_id}"))?;
    session
        .writer
        .lock()
        .map_err(|_| "Session writer lock poisoned".to_string())?
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to session: {error}"))?;
    if let Ok(mut activity) = session.last_activity.lock() {
        *activity = Instant::now();
    }
    Ok(())
}

#[tauri::command]
fn resize_session(
    manager: State<'_, SessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("Terminal dimensions must be greater than zero".to_string());
    }
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown session: {session_id}"))?;
    let result = session
        .master
        .lock()
        .map_err(|_| "PTY master lock poisoned".to_string())?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize session: {error}"));
    result
}

#[tauri::command]
fn stop_session(manager: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown session: {session_id}"))?;
    request_session_stop(&session)
}

#[tauri::command]
fn acknowledge_notification(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
    expected_status: String,
) -> Result<(), String> {
    manager
        .history(&app)?
        .acknowledge_notification(&session_id, &expected_status)
}

#[tauri::command]
async fn notify_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
    title: String,
    expected_status: String,
) -> Result<(), String> {
    if title.chars().count() > 200 {
        return Err("Notification title is too long".into());
    }
    let history = manager.history(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        history
            .native_delivery(
                &session_id,
                agent_events::NativeSource::Lifecycle(&expected_status),
                |record| {
                    let body = record
                        .reason
                        .clone()
                        .unwrap_or_else(|| format!("Session {}", record.status));
                    send_native_notification(app, session_id.clone(), title, body)
                },
            )
            .map(|_| ())
    })
    .await
    .map_err(|error| format!("Notification worker failed: {error}"))?
}
fn send_native_notification(
    app: AppHandle,
    session_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac_notifications::send(app, session_id, title, body)
    }
    #[cfg(windows)]
    {
        windows_notifications::send(app, session_id, title, body)
    }
    #[cfg(target_os = "linux")]
    {
        linux_notifications::send(app, session_id, title, body)
    }
}

#[tauri::command]
fn set_agent_notification_context(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    selected: Option<String>,
    paused: bool,
) -> Result<(), String> {
    let history = manager.history(&app)?;
    let records = history.list()?;
    if selected
        .as_ref()
        .is_some_and(|id| !records.iter().any(|r| r.summary.session_id == *id))
    {
        return Err("Unknown selected agent session".into());
    }
    manager.start_agent_runtime(&app, history)?;
    let runtime = manager
        .agent_bridge
        .lock()
        .map_err(|_| "Agent bridge lock poisoned")?;
    let bridge = runtime.as_ref().ok_or("Agent bridge unavailable")?;
    *bridge
        .context
        .lock()
        .map_err(|_| "Agent context lock poisoned")? = (true, selected, paused);
    Ok(())
}
#[tauri::command]
fn retry_agent_notifications(manager: State<'_, SessionManager>) -> Result<(), String> {
    let runtime = manager
        .agent_bridge
        .lock()
        .map_err(|_| "Agent bridge lock poisoned")?;
    runtime
        .as_ref()
        .ok_or("Agent bridge unavailable")?
        .retry
        .fetch_add(1, Ordering::AcqRel);
    Ok(())
}
#[tauri::command]
fn read_agent_receipt(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
    receipt: String,
    revision: u64,
) -> Result<(), String> {
    manager
        .history(&app)?
        .read_agent_receipt(&session_id, &receipt, revision)
}

#[tauri::command]
fn list_sessions(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<Vec<SessionRecord>, String> {
    manager.history(&app)?.list()
}

#[tauri::command]
fn read_session_log(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<String, String> {
    let history = manager.history(&app)?;
    if !history
        .list()?
        .iter()
        .any(|record| record.summary.session_id == session_id)
    {
        return Err(format!("Unknown session: {session_id}"));
    }
    let path = history.log_path(&session_id);
    let bytes = fs::read(&path).map_err(|error| format!("Failed to read session log: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn read_session_snapshot(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<LogSnapshot, String> {
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned();
    if let Some(session) = active {
        let log = session
            .log
            .lock()
            .map_err(|_| "Session log lock poisoned".to_string())?;
        if let Some(error) = &log.error {
            return Err(error.clone());
        }
        let bytes =
            fs::read(session.history.log_path(&session_id)).map_err(|error| error.to_string())?;
        let data =
            String::from_utf8(bytes).map_err(|error| format!("Invalid UTF-8 log: {error}"))?;
        let end_offset = log.end_offset;
        drop(log);
        Ok(LogSnapshot {
            offset: end_offset.saturating_sub(data.len() as u64),
            end_offset,
            data,
            status: session
                .status
                .lock()
                .map_err(|_| "Session status lock poisoned".to_string())?
                .clone(),
        })
    } else {
        let history = manager.history(&app)?;
        let record = history
            .list()?
            .into_iter()
            .find(|record| record.summary.session_id == session_id)
            .ok_or_else(|| format!("Unknown session: {session_id}"))?;
        let data = read_session_log(app, manager, session_id)?;
        let end_offset = record.output_end_offset.max(data.len() as u64);
        Ok(LogSnapshot {
            offset: end_offset - data.len() as u64,
            end_offset,
            data,
            status: record.status,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The deep-link plugin may not be initialized when a second process arrives.
            for argument in args.iter().skip(1) {
                if session_id_from_link(argument).is_some() {
                    if let Err(error) = route_notification_link(app, argument) {
                        eprintln!("[YAM] {error}");
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("native-notifications")
                .setup(|app, _| {
                    #[cfg(target_os = "macos")]
                    if let Err(error) = mac_notifications::init(app) {
                        eprintln!("[YAM] {error}");
                    }
                    #[cfg(target_os = "linux")]
                    if let Err(error) = linux_notifications::init(app) {
                        eprintln!("[YAM] {error}");
                    }
                    #[cfg(windows)]
                    if let Err(error) = app.deep_link().register_all() {
                        eprintln!("[YAM] Protocol registration failed: {error}");
                    }
                    Ok(())
                })
                .build(),
        )
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first() {
                // Native predefined Quit invokes NSApplication. Route Cmd+Q through ExitRequested.
                let count = application.items()?.len();
                if count > 0 {
                    application.remove_at(count - 1)?;
                }
                application.append(&tauri::menu::MenuItem::with_id(
                    app,
                    "yam-quit",
                    "Quit YAM",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "yam-quit" {
                app.exit(0);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(error) = route_notification_link(&handle, url.as_str()) {
                        eprintln!("[YAM] {error}");
                    }
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    if let Err(error) = route_notification_link(app.handle(), url.as_str()) {
                        eprintln!("[YAM] {error}");
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.current_monitor()? {
                    let area = monitor.work_area();
                    let scale = monitor.scale_factor();
                    let width = 1180.0_f64.min(area.size.width as f64 / scale - 48.0);
                    let height = 760.0_f64.min(area.size.height as f64 / scale - 80.0);
                    window.set_size(tauri::LogicalSize::new(width, height))?;
                    let outer = window.outer_size()?;
                    window.set_position(tauri::PhysicalPosition::new(
                        area.position.x + (area.size.width.saturating_sub(outer.width) / 2) as i32,
                        area.position.y
                            + (area.size.height.saturating_sub(outer.height) / 2) as i32,
                    ))?;
                }
            }
            Ok(())
        })
        .manage(SessionManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            validate_project_directory,
            list_adapters,
            create_session,
            write_session,
            resize_session,
            stop_session,
            list_sessions,
            notify_session,
            acknowledge_notification,
            set_agent_notification_context,
            retry_agent_notifications,
            read_agent_receipt,
            pending_notification_selection,
            acknowledge_notification_selection,
            read_session_log,
            read_session_snapshot
        ])
        .build(tauri::generate_context!())
        .expect("error while building YAM")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let manager = app.state::<SessionManager>();
                if !manager.shutdown_complete.load(Ordering::Acquire) {
                    manager.shutting_down.store(true, Ordering::Release);
                    if let Err(error) = manager.shutdown() {
                        eprintln!("[YAM] Final exit cleanup failed: {error}");
                    }
                }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let manager = app.state::<SessionManager>();
                if manager.shutdown_complete.load(Ordering::Acquire) {
                    return;
                }
                api.prevent_exit();
                if !manager.shutting_down.swap(true, Ordering::AcqRel) {
                    let app = app.clone();
                    thread::spawn(move || match app.state::<SessionManager>().shutdown() {
                        Ok(()) => app.exit(0),
                        Err(error) => {
                            app.state::<SessionManager>()
                                .shutting_down
                                .store(false, Ordering::Release);
                            let _ = app.emit(
                                "session-error",
                                SessionMessage {
                                    session_id: String::new(),
                                    data: error,
                                },
                            );
                        }
                    });
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::MAX_SESSION_HISTORY_BYTES;
    use std::fs;
    #[cfg(unix)]
    use std::io::Read;

    use portable_pty::{native_pty_system, PtySize};

    use super::{
        agent_adapters, append_log, is_terminal, next_session_id, shell_command, HealthReport,
        HistoryStore, SessionManager, SessionSummary,
    };

    #[test]
    fn notification_selection_survives_startup_and_stale_acknowledgement() {
        let manager = SessionManager::default();
        *manager.notification_selection.lock().unwrap() = Some("s-first".into());
        assert_eq!(
            manager.notification_selection.lock().unwrap().as_deref(),
            Some("s-first")
        );
        manager.acknowledge_selection("s-other").unwrap();
        assert_eq!(
            manager.notification_selection.lock().unwrap().as_deref(),
            Some("s-first")
        );
        *manager.notification_selection.lock().unwrap() = Some("s-newer".into());
        manager.acknowledge_selection("s-first").unwrap();
        assert_eq!(
            manager.notification_selection.lock().unwrap().as_deref(),
            Some("s-newer")
        );
        manager.acknowledge_selection("s-newer").unwrap();
        assert_eq!(*manager.notification_selection.lock().unwrap(), None);
    }

    #[test]
    fn health_report_identifies_yam_and_ready_state() {
        let report = HealthReport::current();

        assert_eq!(report.app, "YAM");
        assert_eq!(report.status, "ready");
        assert!(!report.version.is_empty());
        assert!(!report.platform.is_empty());
        assert!(!report.architecture.is_empty());
    }

    #[test]
    fn health_report_is_deterministic_for_the_same_runtime() {
        assert_eq!(HealthReport::current(), HealthReport::current());
    }

    #[test]
    fn session_ids_are_unique_and_non_empty() {
        let first = next_session_id();
        let second = next_session_id();

        assert!(!first.is_empty());
        assert_ne!(first, second);
    }

    #[test]
    fn terminal_statuses_are_terminal() {
        assert!(is_terminal("succeeded"));
        assert!(is_terminal("failed"));
        assert!(is_terminal("stopped"));
        assert!(is_terminal("needs_attention"));
        assert!(!is_terminal("running"));
    }

    #[test]
    fn built_in_adapters_include_shell_and_agent_entries() {
        let adapters = agent_adapters();
        assert_eq!(adapters.len(), 3);
        assert_eq!(adapters[0].id, "shell");
        assert!(adapters[0].available);
        assert!(adapters.iter().any(|adapter| adapter.id == "codex"));
        assert!(adapters.iter().any(|adapter| adapter.id == "claude"));
    }

    #[test]
    fn history_marks_interrupted_sessions_for_attention() {
        let root = std::env::temp_dir().join(format!("yam-history-test-{}", next_session_id()));
        let history = HistoryStore::open(root.clone()).expect("open history");
        let summary = SessionSummary {
            session_id: "s-test".to_string(),
            cwd: "/tmp".to_string(),
            command: Some("sleep 10".to_string()),
            status: "running".to_string(),
            launch: None,
        };
        history.start(&summary).expect("start record");
        history.recover_running().expect("recover history");
        let record = history.list().expect("list history").pop().expect("record");

        assert_eq!(record.status, "needs_attention");
        assert!(record
            .reason
            .unwrap_or_default()
            .contains("application closed"));
        let _ = std::fs::remove_dir_all(root);
    }

    fn test_history() -> (std::path::PathBuf, SessionSummary) {
        let root = std::env::temp_dir().join(format!("yam-review-test-{}", next_session_id()));
        let summary = SessionSummary {
            session_id: "s-test".into(),
            cwd: "/tmp".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        (root, summary)
    }
    #[test]
    fn history_upgrade_keeps_an_immutable_pre_agent_backup_and_defaults_old_fields() {
        let (root, summary) = test_history();
        let history = HistoryStore::open(root.clone()).unwrap();
        history.start(&summary).unwrap();
        let mut old: serde_json::Value =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        old[0].as_object_mut().unwrap().remove("agent");
        let original = serde_json::to_vec(&old).unwrap();
        fs::write(history.records_path(), &original).unwrap();
        let upgraded = HistoryStore::open(root.clone()).unwrap();
        assert_eq!(upgraded.list().unwrap()[0].agent.integration, "unavailable");
        let backup = root.join("sessions.before-agent-events.json");
        assert_eq!(fs::read(&backup).unwrap(), original);
        upgraded
            .configure_agent(&summary.session_id, "new-launch")
            .unwrap();
        HistoryStore::open(root.clone()).unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn history_budget_failure_preserves_the_existing_file_and_in_memory_state() {
        let (root, summary) = test_history();
        let history = HistoryStore::open(root.clone()).unwrap();
        history.start(&summary).unwrap();
        let original = fs::read(history.records_path()).unwrap();
        let mut oversized = summary.clone();
        oversized.cwd = "x".repeat(MAX_SESSION_HISTORY_BYTES as usize);
        assert!(history.start(&oversized).is_err());
        assert_eq!(fs::read(history.records_path()).unwrap(), original);
        assert_eq!(history.list().unwrap()[0].summary.cwd, summary.cwd);
        fs::remove_dir_all(root).unwrap();
    }

    fn test_session(
        command: &str,
    ) -> (
        std::sync::Arc<super::Session>,
        Box<dyn std::io::Read + Send>,
        std::path::PathBuf,
    ) {
        let (root, mut summary) = test_history();
        let history = std::sync::Arc::new(HistoryStore::open(root.clone()).unwrap());
        summary.session_id = next_session_id();
        history.start(&summary).unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let child = pair
            .slave
            .spawn_command(shell_command(Some(command)))
            .unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(history.log_path(&summary.session_id))
            .unwrap();
        let session = std::sync::Arc::new(super::Session {
            _resume_claim: None,
            summary,
            master: std::sync::Mutex::new(pair.master),
            writer: std::sync::Mutex::new(writer),
            #[cfg(windows)]
            job: Some(super::WindowsJob::attach(child.as_raw_handle().unwrap()).unwrap()),
            child: std::sync::Mutex::new(child),
            log: std::sync::Mutex::new(super::SessionLog {
                file: log,
                end_offset: 0,
                error: None,
            }),
            output_done: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
            cancel_output: std::sync::atomic::AtomicBool::new(false),
            protocol: std::sync::Mutex::new(super::AgentProtocol::new(None)),
            history,
            stop_requested: std::sync::atomic::AtomicBool::new(false),
            idle_notified: std::sync::atomic::AtomicBool::new(false),
            completed: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
            last_activity: std::sync::Mutex::new(std::time::Instant::now()),
            status: std::sync::Mutex::new("running".into()),
        });
        (session, reader, root)
    }

    #[test]
    fn idle_reminders_do_not_stop_a_running_session_and_reset_on_activity() {
        use std::time::Duration;
        let (session, _, root) = test_session(if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        });
        assert!(!super::idle_reminder_due(
            &session,
            Duration::from_secs(1),
            Duration::from_secs(2)
        ));
        assert!(super::idle_reminder_due(
            &session,
            Duration::from_secs(2),
            Duration::from_secs(2)
        ));
        assert!(!super::idle_reminder_due(
            &session,
            Duration::from_secs(3),
            Duration::from_secs(2)
        ));
        assert!(!session
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(session.child.lock().unwrap().try_wait().unwrap().is_none());
        assert!(!super::idle_reminder_due(
            &session,
            Duration::ZERO,
            Duration::from_secs(2)
        ));
        assert!(super::idle_reminder_due(
            &session,
            Duration::from_secs(2),
            Duration::from_secs(2)
        ));
        super::request_session_stop(&session).unwrap();
        session.child.lock().unwrap().wait().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_after_natural_exit_does_not_reclassify_completion() {
        let (session, _, root) = test_session("exit 0");
        session.child.lock().unwrap().wait().unwrap();
        super::request_session_stop(&session).unwrap();
        assert!(!session
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_stop_is_idempotent_and_finished_sessions_are_released() {
        let manager = super::SessionManager::default();
        let (session, _, root) = test_session(if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        });
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(session.summary.session_id.clone(), session.clone());
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let session = session.clone();
                std::thread::spawn(move || super::request_session_stop(&session))
            })
            .collect();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        session.child.lock().unwrap().wait().unwrap();
        super::finish_session(&manager.sessions, &session);
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(*session.completed.0.lock().unwrap());
        assert!(manager.shutdown().is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_close_terminates_owned_process() {
        use std::os::windows::io::AsRawHandle;
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let job = super::WindowsJob::attach(child.as_raw_handle()).unwrap();
        assert!(
            child.try_wait().unwrap().is_none(),
            "fixture must be running before Job closes"
        );
        drop(job);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Closing the last Job handle did not terminate the owned process");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn shutdown_started_does_not_mean_exit_is_ready() {
        let manager = super::SessionManager::default();
        manager
            .shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(!manager
            .shutdown_complete
            .load(std::sync::atomic::Ordering::Acquire));
        manager.shutdown().unwrap();
        assert!(manager
            .shutdown_complete
            .load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn shutdown_stops_sessions_and_waits_for_cleanup() {
        let manager = super::SessionManager::default();
        let (session, _, root) = test_session(if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        });
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(session.summary.session_id.clone(), session.clone());
        let sessions = manager.sessions.clone();
        let cleanup = std::thread::spawn(move || {
            loop {
                if session.child.lock().unwrap().try_wait().unwrap().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            super::finish_session(&sessions, &session);
        });
        manager.shutdown().unwrap();
        cleanup.join().unwrap();
        assert!(manager.sessions.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_cleans_background_job_groups_without_harming_other_sessions() {
        use std::io::BufRead;
        let (session, reader, root) =
            test_session("set -m; trap '' HUP; sleep 30 & echo YAM_PID:$!; wait");
        let mut reader = std::io::BufReader::new(reader);
        let pid: i32 = loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if let Some(value) = line.trim().strip_prefix("YAM_PID:") {
                if let Ok(pid) = value.parse() {
                    break pid;
                }
            }
        };
        let (other, _, other_root) = test_session("sleep 30");
        super::request_session_stop(&session).unwrap();
        session.child.lock().unwrap().wait().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        // Always clean the fixture, including when the assertion detects the old bug.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let other_running = other.child.lock().unwrap().try_wait().unwrap().is_none();
        super::request_session_stop(&other).unwrap();
        other.child.lock().unwrap().wait().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(other_root).unwrap();
        assert!(!alive, "background descendant survived session stop");
        assert!(other_running, "stop affected an unrelated session");
    }

    #[test]
    fn corrupt_history_is_rejected_without_destroying_evidence() {
        let (root, _) = test_history();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("sessions.json"), b"{broken").unwrap();
        assert!(HistoryStore::open(root.clone()).is_err());
        assert_eq!(
            std::fs::read(root.join("sessions.json")).unwrap(),
            b"{broken"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_recovers_valid_backup_and_preserves_corrupt_primary() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        std::fs::copy(root.join("sessions.json"), root.join("sessions.json.bak")).unwrap();
        std::fs::write(root.join("sessions.json"), b"broken").unwrap();
        let recovered = HistoryStore::open(root.clone()).unwrap();
        assert_eq!(recovered.list().unwrap().len(), 1);
        assert!(std::fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("sessions.corrupt-")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_history_start_does_not_create_an_in_memory_record() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        assert!(store.start(&summary).is_err());
        assert!(store.list().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_history_update_is_reported_and_leaves_previous_state() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        let error = store
            .update("s-test", "succeeded", Some(0), None, None)
            .unwrap_err();
        assert!(error.contains("write session history"));
        assert_eq!(store.list().unwrap()[0].status, "running");
        assert_eq!(
            HistoryStore::open(root.clone()).unwrap().list().unwrap()[0].status,
            "running"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn natural_exit_cleanup_finds_orphans_in_other_job_groups() {
        use std::os::unix::process::CommandExt;
        let pid_file = std::env::temp_dir().join(format!("yam-pid-{}", next_session_id()));
        let command = format!(
            "trap '' HUP; sleep 30 & echo $! > '{}'; exit 0",
            pid_file.display()
        );
        let mut builder = std::process::Command::new("/bin/sh");
        builder.args(["-c", &command]);
        unsafe {
            builder.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = builder.spawn().unwrap();
        let parent = child.id();
        child.wait().unwrap();
        let descendant: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let owned = super::process_tree(parent).unwrap();
        unsafe {
            libc::kill(descendant, libc::SIGKILL);
        }
        std::fs::remove_file(pid_file).unwrap();
        assert!(
            owned.contains(&(descendant as u32)),
            "orphan lost when the shell exited"
        );
    }

    #[test]
    fn a_running_resume_claim_blocks_duplicate_conversations_until_cleanup() {
        let claims = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        let first = super::ResumeClaim::acquire(claims.clone(), "native-one").unwrap();
        assert!(super::ResumeClaim::acquire(claims.clone(), "native-one").is_err());
        let other = super::ResumeClaim::acquire(claims.clone(), "native-other").unwrap();
        drop(first);
        assert!(super::ResumeClaim::acquire(claims.clone(), "native-one").is_ok());
        assert!(super::ResumeClaim::acquire(claims.clone(), "native-other").is_err());
        drop(other);
        assert!(claims.lock().unwrap().is_empty());
    }

    #[test]
    fn resume_uses_trusted_history_and_never_replays_an_original_prompt_or_shell() {
        let root = std::env::temp_dir().join(next_session_id());
        let store = HistoryStore::open(root.clone()).unwrap();
        let native_id = "01a0f6ec-5463-78c3-a404-5a7ad3b933fe";
        let summary = SessionSummary {
            session_id: "resume-source".into(),
            cwd: root.to_string_lossy().into(),
            command: None,
            status: "stopped".into(),
            launch: Some(super::AgentLaunch {
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: Some("never resend".into()),
            }),
        };
        store.start(&summary).unwrap();
        store
            .configure_agent(&summary.session_id, "trusted-launch")
            .unwrap();
        store.records.lock().unwrap()[0].agent.agent_session_id = Some(native_id.into());
        let (cwd, launch, id) = super::resume_source(&store, &summary.session_id).unwrap();
        assert_eq!(cwd, summary.cwd);
        assert_eq!(id, native_id);
        assert_eq!(launch.prompt, None);
        let mut resumed = summary.clone();
        resumed.session_id = "resume-next".into();
        store.start(&resumed).unwrap();
        store
            .bind_resume_identity(&resumed.session_id, native_id)
            .unwrap();
        let reopened = HistoryStore::open(root.clone()).unwrap();
        assert_eq!(
            super::resume_source(&reopened, &resumed.session_id)
                .unwrap()
                .2,
            native_id
        );
        assert_eq!(
            reopened
                .list()
                .unwrap()
                .iter()
                .find(|record| record.summary.session_id == resumed.session_id)
                .unwrap()
                .agent
                .integration,
            "unavailable"
        );
        let command = super::resume_command(std::path::Path::new("codex"), &launch, &id).unwrap();
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(&argv[1..], &["resume", native_id]);
        assert!(super::resume_source(&store, "missing").is_err());
        store
            .update(&summary.session_id, "running", None, None, None)
            .unwrap();
        assert!(super::resume_source(&store, &summary.session_id)
            .unwrap_err()
            .contains("already running"));
        store
            .update(&summary.session_id, "stopped", None, None, None)
            .unwrap();
        store.records.lock().unwrap()[0].agent.agent_session_id = Some("--last".into());
        assert!(super::resume_source(&store, &summary.session_id).is_err());
        for bad in [
            "",
            "--last",
            "not-a-uuid",
            "01a0f6ec-5463-78c3-a404-5a7ad3b933fg",
        ] {
            assert!(super::resume_command(std::path::Path::new("codex"), &launch, bad).is_err());
        }
        store.records.lock().unwrap()[0].agent.agent_session_id = Some(native_id.into());
        for (adapter, mode, args) in [
            ("claude", "interactive", ""),
            ("codex", "task", ""),
            ("codex", "interactive", "--model custom"),
        ] {
            let mut records = store.records.lock().unwrap();
            let launch = records[0].summary.launch.as_mut().unwrap();
            launch.adapter = adapter.into();
            launch.mode = mode.into();
            launch.extra_args = args.into();
            drop(records);
            assert!(super::resume_source(&store, &summary.session_id).is_err());
        }
        let mut records = store.records.lock().unwrap();
        records[0].summary = summary.clone();
        records[0].summary.cwd = root.join("missing").to_string_lossy().into();
        drop(records);
        assert!(super::resume_source(&store, &summary.session_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_launch_passes_prompt_as_one_literal_argument() {
        let prompt = "fix C:\\work & echo unsafe | 'quote' \"double\" %PATH%";
        let launch = super::AgentLaunch {
            adapter: "codex".into(),
            mode: "task".into(),
            extra_args: "--model 'test model'".into(),
            prompt: Some(prompt.into()),
        };
        let builder = super::agent_command(std::path::Path::new("codex"), &launch).unwrap();
        let args: Vec<_> = builder
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "codex",
                "exec",
                "--json",
                "--model",
                "test model",
                "--",
                prompt
            ]
        );
    }

    #[test]
    fn agent_arguments_preserve_windows_paths_and_reject_invalid_quotes() {
        assert_eq!(
            super::parse_agent_args(r#"--cwd C:\work\app --label "hello world" ''"#).unwrap(),
            vec!["--cwd", r"C:\work\app", "--label", "hello world", ""]
        );
        assert!(super::parse_agent_args("--model 'broken").is_err());
        assert!(super::parse_agent_args("bad\0arg").is_err());
        let launch = super::AgentLaunch {
            adapter: "claude".into(),
            mode: "task".into(),
            extra_args: String::new(),
            prompt: None,
        };
        assert!(super::agent_command(std::path::Path::new("claude"), &launch).is_err());
    }

    #[test]
    fn agent_protocol_tracks_split_success_failure_and_missing_completion() {
        let mut protocol = super::AgentProtocol::new(Some("codex"));
        protocol.push("{\"type\":\"turn.star");
        protocol.push("ted\"}\r\n{\"type\":\"turn.completed\",\"usage\":{}}\n");
        assert_eq!(protocol.phase(), "completed");
        assert_eq!(protocol.terminal_status(true), "succeeded");
        assert_eq!(protocol.terminal_status(false), "failed");
        let mut failed = super::AgentProtocol::new(Some("codex"));
        failed.push("{\"type\":\"turn.failed\",\"error\":{\"message\":\"rate limit\"}}\n");
        assert_eq!(failed.terminal_status(true), "failed");
        let missing = super::AgentProtocol::new(Some("codex"));
        assert_eq!(missing.terminal_status(true), "needs_attention");
        assert_eq!(
            super::AgentProtocol::new(None).terminal_status(true),
            "succeeded"
        );
    }

    #[test]
    fn claude_permission_denials_require_attention_and_json_is_not_guessed() {
        let mut protocol = super::AgentProtocol::new(Some("claude"));
        protocol.push("Working done Completed this is only text\n");
        assert_eq!(protocol.terminal_status(true), "needs_attention");
        protocol.push("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"permission_denials\":[{\"tool_name\":\"Bash\"}]}\n");
        assert_eq!(protocol.terminal_status(true), "needs_attention");
        let mut good = super::AgentProtocol::new(Some("claude"));
        good.push("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"permission_denials\":[]}\n");
        assert_eq!(good.terminal_status(true), "succeeded");
        good.push("{\"type\":\"result\",\"subtype\":\"error_max_turns\",\"is_error\":true}\n");
        assert_eq!(good.terminal_status(true), "failed");
    }

    #[test]
    fn utf8_decoder_preserves_characters_split_at_every_boundary() {
        let original = "中文🙂\r\n".as_bytes();
        for split in 0..=original.len() {
            let mut decoder = super::Utf8Decoder::default();
            let mut text = decoder.push(&original[..split]);
            text.push_str(&decoder.push(&original[split..]));
            text.push_str(&decoder.finish());
            assert_eq!(text, "中文🙂\r\n");
        }
    }

    #[test]
    fn utf8_decoder_replaces_invalid_and_incomplete_bytes_without_panicking() {
        let mut decoder = super::Utf8Decoder::default();
        assert_eq!(decoder.push(&[b'a', 0xff, 0xe4]), "a�");
        assert_eq!(decoder.finish(), "�");
    }

    #[test]
    fn project_directory_validation_rejects_relative_files_and_missing_paths() {
        let (root, _) = test_history();
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("file");
        std::fs::write(&file, "test").unwrap();
        assert!(super::validate_project_directory(root.to_string_lossy().into()).is_ok());
        assert!(super::validate_project_directory(file.to_string_lossy().into()).is_err());
        assert!(super::validate_project_directory(".".into()).is_err());
        assert!(
            super::validate_project_directory(root.join("missing").to_string_lossy().into())
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn blocked_terminal_reader_can_be_cancelled() {
        let mut descriptors = [0; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        let cancelled = std::sync::atomic::AtomicBool::new(true);
        assert!(!super::wait_output_ready(descriptors[0], &cancelled).unwrap());
        unsafe {
            libc::close(descriptors[0]);
            libc::close(descriptors[1]);
        }
    }

    #[test]
    fn session_links_accept_only_named_local_sessions() {
        assert_eq!(
            super::session_id_from_link("yam://session/s-abc-1"),
            Some("s-abc-1".into())
        );
        for link in [
            "https://session/s-abc-1",
            "yam://other/s-abc-1",
            "yam://session/../etc",
            "yam://session/s-abc-1?command=rm",
            "yam://session/s-abc-1#fragment",
            "yam://user@session/s-abc-1",
            "yam://session/s-abc-1/other",
            "yam://session/%2fetc",
            "yam://session/",
        ] {
            assert_eq!(super::session_id_from_link(link), None, "{link}");
        }
    }

    #[test]
    fn failed_notification_receipt_preserves_pending_after_crash_and_can_recover() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        store
            .update(&summary.session_id, "succeeded", Some(0), None, None)
            .unwrap();
        // Simulate the disk failing after the OS accepted the notification.
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        assert!(store
            .acknowledge_notification(&summary.session_id, "succeeded")
            .is_err());
        assert!(store.list().unwrap()[0].notification_pending);
        drop(store);
        let reopened = HistoryStore::open(root.clone()).unwrap();
        assert!(reopened.list().unwrap()[0].notification_pending);
        assert_eq!(reopened.list().unwrap()[0].status, "succeeded");
        std::fs::remove_dir(root.join("sessions.json.tmp")).unwrap();
        reopened
            .acknowledge_notification(&summary.session_id, "succeeded")
            .unwrap();
        drop(reopened);
        assert!(!HistoryStore::open(root.clone()).unwrap().list().unwrap()[0].notification_pending);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_notification_receipt_preserves_new_terminal_pending() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        store
            .update(&summary.session_id, "succeeded", Some(0), None, None)
            .unwrap();
        store
            .acknowledge_notification(&summary.session_id, "idle_attention")
            .unwrap();
        assert!(store.list().unwrap()[0].notification_pending);
        assert!(HistoryStore::open(root.clone()).unwrap().list().unwrap()[0].notification_pending);
        store
            .acknowledge_notification(&summary.session_id, "running")
            .unwrap();
        assert!(store.list().unwrap()[0].notification_pending);
        store
            .acknowledge_notification(&summary.session_id, "succeeded")
            .unwrap();
        assert!(!store.list().unwrap()[0].notification_pending);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notification_receipt_survives_reopen_and_unknown_receipt_is_rejected() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        store
            .update(&summary.session_id, "succeeded", Some(0), None, None)
            .unwrap();
        assert!(HistoryStore::open(root.clone()).unwrap().list().unwrap()[0].notification_pending);
        assert!(store
            .acknowledge_notification("missing", "succeeded")
            .is_err());
        store
            .acknowledge_notification(&summary.session_id, "succeeded")
            .unwrap();
        assert!(!HistoryStore::open(root.clone()).unwrap().list().unwrap()[0].notification_pending);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_history_update_survives_reopen() {
        let (root, summary) = test_history();
        let store = HistoryStore::open(root.clone()).unwrap();
        store.start(&summary).unwrap();
        store
            .update(
                "s-test",
                "succeeded",
                Some(0),
                Some("done".into()),
                Some(123),
            )
            .unwrap();
        let reopened = HistoryStore::open(root.clone()).unwrap();
        let record = reopened.list().unwrap().pop().unwrap();
        assert_eq!(record.status, "succeeded");
        assert_eq!(record.exit_code, Some(0));
        assert_eq!(record.output_end_offset, 123);
        assert!(record.ended_at.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_command_uses_login_shell_and_command_flag() {
        let _ = shell_command(Some("printf hello"));
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_executes_command_and_returns_output() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open PTY");
        let mut child = pair
            .slave
            .spawn_command(shell_command(Some("printf 'yam-m1\\n'")))
            .expect("spawn command");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).expect("read PTY output");
        let exit = child.wait().expect("wait for command");

        assert!(exit.success());
        assert!(String::from_utf8_lossy(&bytes).contains("yam-m1"));
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_reports_non_zero_exit_code() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open PTY");
        let mut child = pair
            .slave
            .spawn_command(shell_command(Some("exit 7")))
            .expect("spawn command");
        let exit = child.wait().expect("wait for command");

        assert!(!exit.success());
        assert_eq!(exit.exit_code(), 7);
    }

    #[test]
    fn missing_working_directory_is_rejected_before_spawn() {
        let error = super::validate_working_directory("/yam/path/that/does/not/exist")
            .expect_err("missing directory should be rejected");

        assert!(error.contains("does not exist"));
    }

    #[test]
    fn session_logs_are_bounded_and_keep_latest_output() {
        let path = std::env::temp_dir().join(format!("yam-log-test-{}", next_session_id()));
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("create log");
        append_log(&mut log, b"first", 8).expect("write first chunk");
        append_log(&mut log, b"second", 8).expect("rotate log");
        drop(log);

        let contents = std::fs::read_to_string(&path).expect("read log");
        assert!(contents.len() <= 8);
        assert!(contents.ends_with("second"));
        let _ = std::fs::remove_file(path);
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_can_be_stopped_before_natural_exit() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open PTY");
        let mut child = pair
            .slave
            .spawn_command(shell_command(Some("sleep 30")))
            .expect("spawn command");
        child.kill().expect("kill command");
        let exit = child.wait().expect("wait for stopped command");

        assert!(!exit.success());
    }
}
