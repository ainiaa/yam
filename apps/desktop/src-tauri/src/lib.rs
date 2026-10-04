mod agent_bridge;
mod agent_events;
mod background;
mod claude_resume;
mod cli;
mod diagnostics;
mod git_context;
mod history;
mod memory;
mod project_config;
mod session_logs;
mod system_entry;
mod terminal_runtime;
mod updater;
mod worktree_manager;
pub fn agent_helper_entry() -> bool {
    agent_bridge::helper_entry()
}
pub fn background_entry() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--yam-background") {
        return false;
    }
    if std::env::args().count() != 2 {
        eprintln!("[YAM] Invalid background startup arguments");
        return true;
    }
    if let Err(error) = background::run() {
        eprintln!("[YAM] {error}");
    }
    true
}
pub fn binary_entry() {
    let args: Vec<_> = std::env::args_os().collect();
    // Preflight precedes helpers which retain their valid UTF-8 entry contract.
    let result = if args.iter().any(|arg| arg.to_str().is_none()) {
        Err(cli::ErrorClass::Arguments)
    } else {
        cli::entry_dispatch(
            &args[1..],
            agent_helper_entry,
            background_entry,
            cli::run_entry,
            run,
        )
    };
    if let Err(class) = result {
        let (code, message) = cli::diagnostic(class, None);
        eprintln!("{message}");
        std::process::exit(code);
    }
}
fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}
use history::HistoryStore;
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
use tauri_plugin_dialog::DialogExt;

#[cfg(any(target_os = "linux", test))]
mod linux_notifications;
#[cfg(target_os = "macos")]
mod mac_notifications;
#[cfg(any(windows, test))]
mod windows_notifications;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SESSION_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SESSION_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
static LOG_SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);
static LOG_SEARCH_LOCK: Mutex<()> = Mutex::new(());

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
    if !matches!(launch.adapter.as_str(), "codex" | "claude" | "opencode")
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
        } else if launch.adapter == "claude" {
            "node_modules/@anthropic-ai/claude-code/cli.js"
        } else {
            "node_modules/opencode-ai/bin/opencode"
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
    builder.env("PATH", agent_path());
    if launch.mode == "task" {
        if launch.adapter == "codex" {
            builder.args(["exec", "--json"]);
        } else if launch.adapter == "claude" {
            builder.args(["--print", "--output-format", "stream-json", "--verbose"]);
        } else {
            builder.args(["run", "--format", "json"]);
        }
    }
    builder.args(parse_agent_args(&launch.extra_args)?);
    if let Some(prompt) = prompt {
        builder.arg(
            if launch.adapter == "opencode" && launch.mode == "interactive" {
                "--prompt"
            } else {
                "--"
            },
        );
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
#[cfg(test)]
fn resume_source(
    history: &HistoryStore,
    session_id: &str,
) -> Result<(String, AgentLaunch, String), String> {
    resume_record_source(history.get(session_id)?)
}
fn resume_record_source(record: SessionRecord) -> Result<(String, AgentLaunch, String), String> {
    if matches!(record.status.as_str(), "starting" | "running") {
        return Err("This conversation is already running; select its terminal".into());
    }
    let mut launch = record
        .summary
        .launch
        .ok_or("This history has no supported Agent conversation")?;
    if record.summary.command.is_some()
        || !matches!(launch.adapter.as_str(), "codex" | "claude")
        || launch.mode != "interactive"
        || (launch.adapter == "codex" && !launch.extra_args.trim().is_empty())
    {
        return Err(
            "Native resume supports default Codex and validated Claude interactive sessions".into(),
        );
    }
    if launch.adapter == "claude" {
        agent_bridge::validate_interactive_args("claude", &parse_agent_args(&launch.extra_args)?)?;
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
        || !matches!(launch.adapter.as_str(), "codex" | "claude")
        || launch.mode != "interactive"
        || (launch.adapter == "codex" && !launch.extra_args.trim().is_empty())
        || launch.prompt.is_some()
    {
        return Err("Invalid native resume request".into());
    }
    let mut command = agent_command(executable, launch)?;
    if launch.adapter == "claude" {
        agent_bridge::validate_interactive_args("claude", &parse_agent_args(&launch.extra_args)?)?;
        command.args(["--resume", id]);
    } else {
        command.args(["resume", id]);
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LogSnapshot {
    data: String,
    offset: u64,
    end_offset: u64,
    status: String,
    #[serde(default)]
    range: Option<session_logs::RetainedLogRange>,
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
    #[cfg(test)]
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
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
    log: Mutex<SessionLog>,
    terminal: Option<TerminalAttachment>,
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

macro_rules! proxy {
    ($manager:expr, $command:literal, $args:expr) => {
        let client = {
            $manager
                .background_client
                .lock()
                .map_err(|_| "Background client lock poisoned")?
                .clone()
        };
        if let Some(client) = client {
            return serde_json::from_value(client.call($command, $args)?)
                .map_err(|_| "Invalid background command result".into());
        }
    };
}

fn memory_processes(manager: &SessionManager) -> Result<memory::OwnerProcesses, String> {
    proxy!(manager, "memory_processes", serde_json::json!({}));
    let sessions: Vec<_> = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .values()
        .cloned()
        .collect();
    let mut workloads = Vec::new();
    for session in sessions {
        if ["starting", "running"].contains(
            &session
                .status
                .lock()
                .map_err(|_| "Session status lock poisoned")?
                .as_str(),
        ) {
            if let Some(pid) = session
                .child
                .lock()
                .map_err(|_| "Session child lock poisoned")?
                .process_id()
            {
                workloads.push(pid);
            }
        }
    }
    workloads.sort_unstable();
    workloads.dedup();
    let runtime_pid = manager
        .terminal_runtime
        .lock()
        .map_err(|_| "Terminal runtime lock poisoned")?
        .as_ref()
        .ok_or("Terminal runtime unavailable")?
        .process_id()?;
    Ok(memory::OwnerProcesses {
        pid: std::process::id(),
        runtime_pid,
        workloads,
    })
}

#[tauri::command]
async fn memory_usage(app: AppHandle) -> Result<memory::Sample, String> {
    static SAMPLING: Mutex<()> = Mutex::new(());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _sampling = SAMPLING
            .try_lock()
            .map_err(|_| "Memory sampling already in progress")?;
        let manager = app.state::<SessionManager>();
        let before = memory_processes(&manager)?;
        let sample = memory::sample(&before)?;
        if memory_processes(&manager)? != before {
            return Err("Task membership changed during memory sampling".into());
        }
        Ok(sample)
    })
    .await
    .map_err(|_| "Memory sampling worker failed")?;
    #[cfg(debug_assertions)]
    match &result {
        Ok(sample) => eprintln!(
            "[YAM memory] application_bytes={} workload_bytes={}",
            sample.application_bytes, sample.workload_bytes
        ),
        Err(error) => eprintln!("[YAM memory] {error}"),
    }
    result
}

struct TerminalAttachment {
    runtime: Arc<terminal_runtime::Runtime>,
    session: String,
    reported: AtomicBool,
}
impl Drop for TerminalAttachment {
    fn drop(&mut self) {
        let _ = self
            .runtime
            .call("close", &self.session, serde_json::json!({}));
    }
}
#[derive(Serialize, Deserialize)]
struct TerminalFrame {
    projection: serde_json::Value,
    end_offset: u64,
    status: String,
    #[serde(default)]
    persisted: bool,
}
fn active_frame(session: &Session) -> Result<TerminalFrame, String> {
    let terminal = session
        .terminal
        .as_ref()
        .ok_or("No persistent terminal parser owns this session")?;
    let status = session
        .status
        .lock()
        .map_err(|_| "Session status lock poisoned")?;
    let log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    let projection = terminal.runtime.call(
        "snapshot",
        &session.summary.session_id,
        serde_json::json!({}),
    )?;
    Ok(TerminalFrame {
        projection,
        end_offset: log.end_offset,
        status: status.clone(),
        persisted: false,
    })
}
#[tauri::command]
fn set_terminal_viewport(
    manager: State<'_, SessionManager>,
    session_id: String,
    line: u32,
) -> Result<(), String> {
    proxy!(
        manager,
        "set_terminal_viewport",
        serde_json::json!({"session_id":session_id,"line":line})
    );
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(&session_id)
        .cloned()
        .ok_or("Unknown live terminal")?;
    let _log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    session
        .terminal
        .as_ref()
        .ok_or("Terminal parser unavailable")?
        .runtime
        .call("viewport", &session_id, serde_json::json!({"line":line}))?;
    Ok(())
}
fn save_final_frame(session: &Session) -> Result<(), String> {
    if session.terminal.is_none() {
        return Ok(());
    }
    if !*session
        .output_done
        .0
        .lock()
        .map_err(|_| "Output completion lock poisoned")?
    {
        return Err("Terminal output did not drain; a complete final scene is unavailable".into());
    }
    let frame = active_frame(session)?;
    let bytes = serde_json::to_vec(&frame).map_err(|_| "Cannot encode final terminal frame")?;
    let path = session
        .history
        .root
        .join(format!("{}.frame.json", session.summary.session_id));
    let temporary = session.history.root.join(format!(
        "{}.{}.frame.tmp",
        session.summary.session_id,
        next_session_id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        #[cfg(unix)]
        File::open(&session.history.root)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("Cannot save final terminal frame: {e}"))
}
fn saved_frame_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect final terminal frame".into()),
        Ok(_) => {}
    }
    let file = background::private_file(path, false)?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect final terminal frame")?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("Final terminal frame exceeds size budget".into());
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read final terminal frame")?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Final terminal frame exceeds size budget".into());
    }
    Ok(Some(bytes))
}

#[tauri::command]
fn read_terminal_frame(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Option<TerminalFrame>, String> {
    proxy!(
        manager,
        "read_terminal_frame",
        serde_json::json!({"session_id":session_id})
    );
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(&session_id)
        .cloned();
    if let Some(session) = active {
        return active_frame(&session).map(Some);
    }
    let history = manager.history(&app)?;
    let record = history.get(&session_id)?;
    let path = history.root.join(format!("{session_id}.frame.json"));
    let Some(bytes) = saved_frame_bytes(&path)? else {
        return Ok(None);
    };
    decode_saved_frame(
        &bytes,
        &session_id,
        &record.status,
        record.output_end_offset,
    )
    .map(Some)
}

fn decode_saved_frame(
    bytes: &[u8],
    session_id: &str,
    status: &str,
    end_offset: u64,
) -> Result<TerminalFrame, String> {
    let mut frame: TerminalFrame =
        serde_json::from_slice(bytes).map_err(|_| "Invalid final terminal frame")?;
    terminal_runtime::validate_snapshot(&frame.projection, session_id, None)?;
    if !is_terminal(status) || frame.status != status || frame.end_offset != end_offset {
        return Err("Final terminal frame does not match recorded lifecycle".into());
    }
    frame.persisted = true;
    Ok(frame)
}

pub struct SessionManager {
    resume_claims: Arc<Mutex<std::collections::HashSet<String>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    shutting_down: AtomicBool,
    shutdown_complete: AtomicBool,
    notification_selection: Mutex<Option<String>>,
    history: Mutex<Option<Arc<HistoryStore>>>,
    agent_bridge: Mutex<Option<agent_bridge::Bridge>>,
    background_owner: bool,
    cli_namespace: std::sync::OnceLock<String>,
    background_client: Mutex<Option<Arc<background::Client>>>,
    relay: Mutex<background::Relay>,
    input_leases: Mutex<background::InputLeases>,
    started: Instant,
    desktop_focus: Mutex<(Instant, bool)>,
    desktop_connected: AtomicBool,
    desktop_foreground: AtomicBool,
    last_request: AtomicU64,
    terminal_runtime: Mutex<Option<Arc<terminal_runtime::Runtime>>>,
    history_owner: Mutex<Option<background::OwnerLock>>,
    system_entry: Mutex<system_entry::EntryState>,
    system_entry_busy: AtomicBool,
    system_entry_native: Mutex<Option<system_entry::NativeEntry>>,
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
            background_owner: false,
            cli_namespace: std::sync::OnceLock::new(),
            background_client: Mutex::new(None),
            relay: Mutex::new(background::Relay::default()),
            input_leases: Mutex::new(background::InputLeases::default()),
            started: Instant::now(),
            desktop_focus: Mutex::new((Instant::now(), false)),
            desktop_connected: AtomicBool::new(false),
            desktop_foreground: AtomicBool::new(false),
            last_request: AtomicU64::new(0),
            terminal_runtime: Mutex::new(None),
            history_owner: Mutex::new(None),
            system_entry: Mutex::new(system_entry::EntryState::default()),
            system_entry_busy: AtomicBool::new(false),
            system_entry_native: Mutex::new(None),
        }
    }
}

impl SessionManager {
    fn acquire_history_owner(&self, root: &Path) -> Result<(), String> {
        if self.background_owner {
            return Ok(());
        }
        let mut owner = self
            .history_owner
            .lock()
            .map_err(|_| "History owner lock poisoned")?;
        if owner.is_none() {
            *owner = Some(background::OwnerLock::acquire(root)?);
        }
        Ok(())
    }
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
        if let Some(parser) = self
            .terminal_runtime
            .lock()
            .map_err(|_| "Terminal runtime lock poisoned")?
            .take()
        {
            parser.stop();
        }
        self.shutdown_complete.store(true, Ordering::Release);
        Ok(())
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
        if self
            .background_client
            .lock()
            .map_err(|_| "Background client lock poisoned")?
            .is_some()
        {
            return Err("Desktop cannot open owner history directly".into());
        }
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
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
        self.acquire_history_owner(&root.join("background"))?;
        let root = root.join("sessions");
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
    get_session(
        app.clone(),
        app.state::<SessionManager>(),
        session_id.into(),
    )?;
    *manager
        .notification_selection
        .lock()
        .map_err(|_| "Notification selection lock poisoned".to_string())? = Some(session_id.into());
    if manager.background_owner {
        std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .arg(format!("yam://session/{session_id}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot reopen desktop: {e}"))?;
    }
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
            // portable-pty uses C argv quoting, while cmd parses shell quoting. Expand the literal shell text inside cmd.
            builder.arg("%YAM_CUSTOM_COMMAND%");
            builder.env("YAM_CUSTOM_COMMAND", command);
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

fn agent_path() -> std::ffi::OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(unix)]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        agent_path_with_home(&path, home.as_deref())
    }
    #[cfg(not(unix))]
    path
}

#[cfg(unix)]
fn agent_path_with_home(path: &std::ffi::OsStr, home: Option<&Path>) -> std::ffi::OsString {
    let mut directories: Vec<_> = std::env::split_paths(path).collect();
    // ponytail: common CLI install locations only; custom prefixes still require
    // a configured PATH or an explicit Custom command, without running shell startup scripts.
    let mut fallback = vec![PathBuf::from("/usr/local/bin")];
    #[cfg(target_os = "macos")]
    fallback.push(PathBuf::from("/opt/homebrew/bin"));
    if let Some(home) = home.filter(|home| home.is_absolute()) {
        fallback.extend([home.join(".local/bin"), home.join(".npm-global/bin")]);
    }
    for directory in fallback {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    std::env::join_paths(directories).unwrap_or_else(|_| path.to_os_string())
}

fn find_executable(name: &str) -> Option<PathBuf> {
    find_executable_on_path(name, &agent_path())
}

fn find_executable_on_path(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate
                    .metadata()
                    .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
                {
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

#[cfg(all(test, unix))]
#[test]
fn cold_gui_path_finds_user_cli_and_preserves_existing_precedence() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("yam-cold-path-{}", next_session_id()));
    let user_bin = root.join(".npm-global/bin");
    std::fs::create_dir_all(&user_bin).unwrap();
    let cli = user_bin.join("yam-cold-test-cli");
    std::fs::write(&cli, "#!/bin/sh\nexit 0\n").unwrap();
    let minimal = std::ffi::OsStr::new("/usr/bin:/bin");
    let path = agent_path_with_home(minimal, Some(&root));
    assert!(
        find_executable_on_path("yam-cold-test-cli", &path).is_none(),
        "non-executable file is rejected"
    );
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        find_executable_on_path("yam-cold-test-cli", &path),
        Some(cli)
    );
    assert_eq!(
        std::env::split_paths(&path).take(2).collect::<Vec<_>>(),
        vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
    );
    assert!(agent_path_with_home(minimal, None)
        .to_string_lossy()
        .contains("/usr/local/bin"));
    assert!(find_executable_on_path("yam-no-such-cli", &path).is_none());
    let command = agent_command(
        Path::new("codex"),
        &AgentLaunch {
            adapter: "codex".into(),
            mode: "interactive".into(),
            extra_args: String::new(),
            prompt: None,
        },
    )
    .unwrap();
    assert!(command.get_env("PATH").is_some());
    std::fs::remove_dir_all(root).unwrap();
}

fn agent_adapters() -> Vec<AgentAdapter> {
    [
        ("shell", "System shell", None),
        ("codex", "OpenAI Codex", Some("codex")),
        ("claude", "Claude Code", Some("claude")),
        ("opencode", "OpenCode", Some("opencode")),
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
    background::notify_lifecycle(app, &session.summary.session_id, status);
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
    if let Some(terminal) = session.terminal.as_ref() {
        if let Err(error) = terminal
            .runtime
            .output(&session.summary.session_id, data.as_bytes())
        {
            if !terminal.reported.swap(true, Ordering::AcqRel) {
                let _ = app.emit(
                    "session-error",
                    SessionMessage {
                        session_id: session.summary.session_id.clone(),
                        data: error,
                    },
                );
            }
        }
    }
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
    if let Err(error) = save_final_frame(session) {
        eprintln!("[YAM] {error}");
    }
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

#[cfg(windows)]
fn close_exited_console(session: &Session) {
    // ClosePseudoConsole sends its final output before closing the pipe; the reader is still running.
    let master = session
        .master
        .lock()
        .ok()
        .and_then(|mut master| master.take());
    drop(master);
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
            .and_then(|master| master.as_ref().and_then(|master| master.as_raw_fd()));
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
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) {
                        continue;
                    }
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
                    #[cfg(windows)]
                    close_exited_console(&session);
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

fn claim_resume_source(
    history: &HistoryStore,
    claims: Arc<Mutex<std::collections::HashSet<String>>>,
    source: &str,
) -> Result<(SessionRecord, ResumeClaim), String> {
    let mut held = claims.lock().map_err(|_| "Resume claim lock poisoned")?;
    let records = history.lock_records()?;
    let record = history.get_locked(&records, source)?;
    let id = record
        .agent
        .agent_session_id
        .as_deref()
        .filter(|id| valid_resume_id(id))
        .ok_or("No trusted native conversation ID is available")?
        .to_owned();
    if !held.insert(id.clone()) {
        return Err("This conversation is already being resumed".into());
    }
    drop(records);
    drop(held);
    Ok((record, ResumeClaim { claims, id }))
}
#[tauri::command]
fn archive_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    proxy!(
        manager,
        "archive_session",
        serde_json::json!({"session_id":session_id})
    );
    let history = manager.history(&app)?;
    // Every owned Session remains in this map until final log/frame persistence finishes.
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .keys()
        .cloned()
        .collect();
    let _gate = agent_events::NATIVE_DELIVERY
        .lock()
        .map_err(|_| "Notification delivery lock poisoned")?;
    let claims = manager
        .resume_claims
        .lock()
        .map_err(|_| "Resume claim lock poisoned")?;
    history.archive(&session_id, &claims, &active)
}
#[tauri::command]
fn get_history_policy(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<serde_json::Value, String> {
    proxy!(manager, "get_history_policy", serde_json::json!({}));
    manager.history(&app)?.retention_policy()
}
#[tauri::command]
fn set_history_policy(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    auto_archive_30_days: bool,
) -> Result<(), String> {
    proxy!(
        manager,
        "set_history_policy",
        serde_json::json!({"auto_archive_30_days":auto_archive_30_days})
    );
    manager
        .history(&app)?
        .set_retention_policy(auto_archive_30_days)
}
#[tauri::command]
fn preview_archive_deletion(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    proxy!(
        manager,
        "preview_archive_deletion",
        serde_json::json!({"session_ids":session_ids})
    );
    let history = manager.history(&app)?;
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .keys()
        .cloned()
        .collect();
    let _gate = agent_events::NATIVE_DELIVERY
        .lock()
        .map_err(|_| "Notification delivery lock poisoned")?;
    let claims = manager
        .resume_claims
        .lock()
        .map_err(|_| "Resume claim lock poisoned")?;
    history.preview_archive_deletion(&session_ids, &claims, &active)
}
#[tauri::command]
fn cancel_archive_deletion_preview(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    preview_id: String,
) -> Result<(), String> {
    proxy!(
        manager,
        "cancel_archive_deletion_preview",
        serde_json::json!({"preview_id":preview_id})
    );
    manager
        .history(&app)?
        .cancel_archive_deletion_preview(&preview_id)
}
#[tauri::command]
fn confirm_archive_deletion(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    preview_id: String,
) -> Result<history::DeletionResult, String> {
    proxy!(
        manager,
        "confirm_archive_deletion",
        serde_json::json!({"preview_id":preview_id})
    );
    let history = manager.history(&app)?;
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .keys()
        .cloned()
        .collect();
    let _gate = agent_events::NATIVE_DELIVERY
        .lock()
        .map_err(|_| "Notification delivery lock poisoned")?;
    let claims = manager
        .resume_claims
        .lock()
        .map_err(|_| "Resume claim lock poisoned")?;
    history.delete_result(&preview_id, &claims, &active)
}
#[tauri::command]
fn restore_archive(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    proxy!(
        manager,
        "restore_archive",
        serde_json::json!({"session_id":session_id})
    );
    let history = manager.history(&app)?;
    let _gate = agent_events::NATIVE_DELIVERY
        .lock()
        .map_err(|_| "Notification delivery lock poisoned")?;
    let _claims = manager
        .resume_claims
        .lock()
        .map_err(|_| "Resume claim lock poisoned")?;
    history.restore_archive(&session_id)
}
#[tauri::command]
fn list_archived_sessions(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    request: history::PageRequest,
) -> Result<history::HistoryPage<history::HistoryItem>, String> {
    proxy!(
        manager,
        "list_archived_sessions",
        serde_json::json!({"request":request})
    );
    manager.history(&app)?.archive_page(request)
}

#[cfg(test)]
thread_local! {static T09_MISSING_CLI: std::cell::Cell<bool> = const {std::cell::Cell::new(false)};}
#[cfg(test)]
thread_local! {static T13_ALLOCATION_SESSION:std::cell::RefCell<Option<String>>=const {std::cell::RefCell::new(None)};}
#[cfg(test)]
thread_local! {static T09_ALLOCATION_BOUNDARY: std::cell::Cell<usize> = const {std::cell::Cell::new(0)};}

fn worktree_private(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "worktree_manifest_unavailable".into())
}
#[tauri::command]
fn preview_worktree_create(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    root: String,
    target: String,
    reference: String,
    branch: Option<String>,
) -> Result<serde_json::Value, String> {
    let args =
        serde_json::json!({"root":root,"target":target,"reference":reference,"branch":branch});
    proxy!(manager, "preview_worktree_create", args);
    worktree_manager::owner_command(&worktree_private(&app)?, "preview_worktree_create", args)
}
#[tauri::command]
fn create_worktree(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    attempt: String,
) -> Result<serde_json::Value, String> {
    let args = serde_json::json!({"attempt":attempt});
    proxy!(manager, "create_worktree", args);
    worktree_manager::owner_command(&worktree_private(&app)?, "create_worktree", args)
}
#[tauri::command]
fn list_managed_worktrees(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<serde_json::Value, String> {
    let args = serde_json::json!({});
    proxy!(manager, "list_managed_worktrees", args);
    worktree_manager::owner_command(&worktree_private(&app)?, "list_managed_worktrees", args)
}
#[tauri::command]
fn preview_worktree_cleanup(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    attempt: String,
) -> Result<serde_json::Value, String> {
    let args = serde_json::json!({"attempt":attempt});
    proxy!(manager, "preview_worktree_cleanup", args);
    worktree_manager::owner_cleanup_command(
        &worktree_private(&app)?,
        &manager,
        "preview_worktree_cleanup",
        args,
        worktree_manager::native_trash,
    )
}
#[tauri::command]
fn cleanup_worktree(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    attempt: String,
    preview: String,
) -> Result<serde_json::Value, String> {
    let args = serde_json::json!({"attempt":attempt,"preview":preview});
    proxy!(manager, "cleanup_worktree", args);
    worktree_manager::owner_cleanup_command(
        &worktree_private(&app)?,
        &manager,
        "cleanup_worktree",
        args,
        worktree_manager::native_trash,
    )
}

#[tauri::command]
async fn get_git_context(
    manager: State<'_, SessionManager>,
    path: String,
) -> Result<git_context::GitContext, String> {
    let client = manager
        .background_client
        .lock()
        .map_err(|_| "git_query_failed")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(client) = client {
            serde_json::from_value(
                client.call("get_git_context", serde_json::json!({"path":path}))?,
            )
            .map_err(|_| "git_query_failed".into())
        } else {
            git_context::query(Path::new(&path))
        }
    })
    .await
    .map_err(|_| "git_query_failed")?
}
#[tauri::command(rename_all = "snake_case")]
async fn get_git_changes(
    manager: State<'_, SessionManager>,
    path: String,
    query_token: String,
    selected_path: Option<String>,
    side: Option<String>,
) -> Result<git_context::GitChanges, String> {
    let client = manager
        .background_client
        .lock()
        .map_err(|_| "git_query_failed")?
        .clone()
        .ok_or("git_query_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = serde_json::json!({"path":path,"query_token":query_token});
        if let Some(path) = selected_path {
            args["selected_path"] = path.into();
        }
        if let Some(side) = side {
            args["side"] = side.into();
        }
        serde_json::from_value(client.call("get_git_changes", args)?)
            .map_err(|_| "git_query_failed".into())
    })
    .await
    .map_err(|_| "git_query_failed")?
}
#[tauri::command(rename_all = "snake_case")]
async fn cancel_git_changes(
    manager: State<'_, SessionManager>,
    query_token: String,
) -> Result<serde_json::Value, String> {
    let client = manager
        .background_client
        .lock()
        .map_err(|_| "git_query_failed")?
        .clone()
        .ok_or("git_query_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        client.call(
            "cancel_git_changes",
            serde_json::json!({"query_token":query_token}),
        )
    })
    .await
    .map_err(|_| "git_query_failed")?
}

#[tauri::command]
fn get_launch_defaults(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<project_config::LaunchSettings, String> {
    proxy!(manager, "get_launch_defaults", serde_json::json!({}));
    project_config::get_global(
        &app.path()
            .app_data_dir()
            .map_err(|_| "project_config_preferences")?,
    )
}
#[tauri::command]
fn set_launch_defaults(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    defaults: project_config::LaunchSettings,
) -> Result<(), String> {
    proxy!(
        manager,
        "set_launch_defaults",
        serde_json::json!({"defaults":defaults})
    );
    project_config::set_global(
        &app.path()
            .app_data_dir()
            .map_err(|_| "project_config_preferences")?,
        &defaults,
    )
}
#[tauri::command]
fn preview_project_config(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    cwd: String,
) -> Result<project_config::Preview, String> {
    proxy!(
        manager,
        "preview_project_config",
        serde_json::json!({"cwd":cwd})
    );
    project_config::preview(
        Path::new(&cwd),
        &app.path()
            .app_data_dir()
            .map_err(|_| "project_config_preferences")?,
    )
}
#[tauri::command]
fn trust_project_config(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    cwd: String,
    preview: project_config::Preview,
) -> Result<project_config::Preview, String> {
    proxy!(
        manager,
        "trust_project_config",
        serde_json::json!({"cwd":cwd,"preview":preview})
    );
    let private = app
        .path()
        .app_data_dir()
        .map_err(|_| "project_config_preferences")?;
    project_config::trust(Path::new(&cwd), &private, &preview)?;
    project_config::preview(Path::new(&cwd), &private)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project_config: Option<project_config::ProjectStart>,
    worktree_attempt: Option<String>,
) -> Result<SessionSummary, String> {
    let mut arguments =
        serde_json::json!({"cwd":cwd,"command":command,"launch":launch,"resume_from":resume_from});
    if let Some(project) = &project_config {
        arguments["project_config"] =
            serde_json::to_value(project).map_err(|_| "project_config_invalid")?;
    }
    if let Some(attempt) = &worktree_attempt {
        arguments["worktree_attempt"] = serde_json::json!(attempt);
    }
    proxy!(manager, "create_session", arguments);
    let private_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "project_config_preferences")?;
    create_session_owner_with_worktree(
        Some(app),
        &manager,
        &private_root,
        cwd,
        command,
        launch,
        resume_from,
        project_config,
        worktree_attempt,
    )
}
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn create_session_owner(
    app: Option<AppHandle>,
    manager: &SessionManager,
    private_root: &Path,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project: Option<project_config::ProjectStart>,
) -> Result<SessionSummary, String> {
    let _serial = worktree_manager::serial_owner_test();
    create_session_owner_with_worktree(
        app,
        manager,
        private_root,
        cwd,
        command,
        launch,
        resume_from,
        project,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
fn create_session_owner_with_worktree(
    app: Option<AppHandle>,
    manager: &SessionManager,
    private_root: &Path,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project: Option<project_config::ProjectStart>,
    worktree_attempt: Option<String>,
) -> Result<SessionSummary, String> {
    let prepared = if let Some(project) = project {
        if cwd.is_some() || command.is_some() || launch.is_some() || resume_from.is_some() {
            return Err("project_config_invalid".into());
        }
        Some(project_config::prepare(
            Path::new(&project.root),
            private_root,
            project.template.as_deref(),
            &project.overrides,
            &|name| {
                #[cfg(test)]
                if T09_MISSING_CLI.with(|missing| missing.get()) {
                    return None;
                }
                find_executable(name)
            },
            &|key| std::env::var(key).ok(),
        )?)
    } else {
        None
    };
    let (cwd, command, launch, env) = match prepared {
        Some(prepared) => (
            Some(prepared.cwd.to_string_lossy().into_owned()),
            prepared.command,
            prepared.launch,
            prepared.env,
        ),
        None => (cwd, command, launch, std::collections::BTreeMap::new()),
    };
    let _worktree_lifecycle = worktree_manager::start_guard()?;
    if worktree_attempt.is_some() && resume_from.is_some() {
        return Err("worktree_invalid_start".into());
    }
    let initial_cwd = cwd
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|_| "worktree_invalid_target")?);
    let initial_check = if resume_from.is_none() {
        Some(worktree_manager::prepare_start(
            private_root,
            &initial_cwd,
            worktree_attempt.as_deref(),
        )?)
    } else {
        None
    };
    #[cfg(test)]
    if app.is_none() {
        T13_ALLOCATION_SESSION.with(|id| {
            *id.borrow_mut() = initial_check
                .as_ref()
                .and_then(|check| check.session_id.clone())
        });
        T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(hit.get() + 1));
        return Err("test_entry_reached_allocation".into());
    }
    let app = app.ok_or("Application handle unavailable")?;
    if manager.shutting_down.load(Ordering::Acquire) {
        return Err("Application is closing".into());
    }
    let history = manager.history(&app)?;
    let (cwd, launch, resume_id, resume_claim) = if let Some(source) = resume_from {
        if cwd.is_some() || command.is_some() || launch.is_some() {
            return Err("Resume cannot override the stored conversation launch".into());
        }
        let (record, claim) =
            claim_resume_source(&history, manager.resume_claims.clone(), &source)?;
        let (cwd, launch, id) = resume_record_source(record)?;
        (Some(cwd), Some(launch), Some(id), Some(claim))
    } else {
        (cwd, launch, None, None)
    };
    let resumed_check;
    let start_check = if let Some(check) = initial_check.as_ref() {
        check
    } else {
        let resumed_cwd = Path::new(cwd.as_deref().ok_or("Resume directory is missing")?);
        resumed_check = worktree_manager::prepare_start(private_root, resumed_cwd, None)?;
        &resumed_check
    };
    let id = start_check
        .session_id
        .clone()
        .unwrap_or_else(next_session_id);
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
            let directory = Path::new(cwd.as_deref().ok_or("Resume directory is missing")?);
            if launch.adapter == "claude" {
                let config = std::env::var_os("CLAUDE_CONFIG_DIR")
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or(
                        app.path()
                            .home_dir()
                            .map_err(|e| e.to_string())?
                            .join(".claude"),
                    );
                claude_resume::validate(&config, directory, id)?;
            } else {
                agent_bridge::validate_resume(&executable, directory, id)?;
            }
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
    for (key, value) in env {
        builder.env(key, value);
    }
    let integration = launch
        .as_ref()
        .filter(|launch| launch.mode == "interactive")
        .map(|launch| {
            find_executable(&launch.adapter)
                .ok_or_else(|| "Agent executable unavailable".to_string())
                .and_then(|exe| {
                    agent_bridge::prepare(
                        &exe,
                        launch,
                        Path::new(&working_directory),
                        &history.root,
                    )
                })
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
    #[cfg(unix)]
    configure_terminal_input(pair.master.as_ref())?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read PTY output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY input: {error}"))?;

    validate_working_directory(&summary.cwd)?;
    worktree_manager::recheck_start(start_check, Path::new(&summary.cwd))?;
    let mut active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?;
    if manager.shutting_down.load(Ordering::Acquire) {
        return Err("Application is closing".into());
    }
    let terminal = manager
        .terminal_runtime
        .lock()
        .map_err(|_| "Terminal runtime lock poisoned")?
        .clone()
        .map(|runtime| {
            runtime.call(
                "create",
                &summary.session_id,
                serde_json::json!({"cols":100,"rows":24}),
            )?;
            Ok::<_, String>(TerminalAttachment {
                runtime,
                session: summary.session_id.clone(),
                reported: AtomicBool::new(false),
            })
        })
        .transpose()?;
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
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        #[cfg(windows)]
        job,
        terminal,
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

#[cfg(unix)]
fn configure_terminal_input(master: &dyn portable_pty::MasterPty) -> Result<(), String> {
    let fd = master
        .as_raw_fd()
        .ok_or("PTY input does not support bounded native writes")?;
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Cannot configure bounded terminal input".into());
    }
    Ok(())
}

fn input_lock<'a, T>(
    mutex: &'a Mutex<T>,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<std::sync::MutexGuard<'a, T>, String> {
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Terminal input cancelled; no bytes were accepted".into());
        }
        if Instant::now() >= deadline {
            return Err("Terminal input lock is busy; no bytes were accepted".into());
        }
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("Terminal input lock poisoned".into())
            }
            Err(std::sync::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(1)),
        }
    }
}

#[cfg(unix)]
fn write_input_until(
    writer: &mut dyn Write,
    fd: i32,
    bytes: &[u8],
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut written = 0;
    let failure = |reason: &str, written: usize| {
        format!("Terminal input {reason} after {written}/{} bytes; do not resend partially accepted input",bytes.len())
    };
    while written < bytes.len() {
        if cancelled.load(Ordering::Acquire) {
            return Err(failure("cancelled", written));
        }
        if Instant::now() >= deadline {
            return Err(failure("deadline reached", written));
        }
        match writer.write(&bytes[written..]) {
            Ok(0) => return Err(failure("writer closed", written)),
            Ok(size) => written += size,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let mut descriptor = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let ready = unsafe {
                    libc::poll(
                        &mut descriptor,
                        1,
                        remaining.as_millis().clamp(1, 100) as i32,
                    )
                };
                if ready < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                {
                    return Err(failure("readiness failed", written));
                }
            }
            Err(error) => return Err(failure(&error.to_string(), written)),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn write_windows_input(
    writer: &mut dyn Write,
    bytes: &[u8],
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn OpenThread(access: u32, inherit: i32, id: u32) -> RawHandle;
        fn CancelSynchronousIo(thread: RawHandle) -> i32;
    }
    if bytes.is_empty() {
        return Ok(());
    }
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        return Err("Terminal input cancelled before writing; no bytes were accepted".into());
    }
    // THREAD_TERMINATE is the documented access required to cancel this thread's synchronous I/O.
    let raw = unsafe { OpenThread(0x0001, 0, GetCurrentThreadId()) };
    if raw.is_null() {
        return Err("Cannot enable cancellable terminal input".into());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let done = AtomicBool::new(false);
    struct Finished<'a>(&'a AtomicBool);
    impl Drop for Finished<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    thread::scope(|scope| {
        let done_ref = &done;
        scope.spawn(move || {
            let mut reported = false;
            while !done_ref.load(Ordering::Acquire) {
                if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                    // Retry when cancellation races with entry into WriteFile. Never cancel another thread.
                    if unsafe { CancelSynchronousIo(handle.as_raw_handle()) } == 0 {
                        let error = std::io::Error::last_os_error();
                        if error.raw_os_error() != Some(1168) && !reported {
                            eprintln!("[YAM] Terminal input cancellation failed: {error}");
                            reported = true;
                        }
                    }
                }
                thread::sleep(Duration::from_millis(1));
            }
        });
        let _finished = Finished(&done);
        let mut written = 0;
        let failure = |reason: &str, written: usize| {
            format!("Terminal input {reason}; confirmed prefix {written}/{} bytes, last write may be partially accepted; do not resend input", bytes.len())
        };
        while written < bytes.len() {
            if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(failure("cancelled or deadline reached", written));
            }
            match writer.write(&bytes[written..]) {
                Ok(0) => return Err(failure("writer closed", written)),
                Ok(size) => written += size,
                Err(error) => return Err(failure(&error.to_string(), written)),
            }
        }
        Ok(())
    })
}

#[tauri::command]
fn write_session(
    manager: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    proxy!(
        manager,
        "write_session",
        serde_json::json!({"session_id":session_id,"data":data})
    );
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown session: {session_id}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    #[cfg(unix)]
    let fd = input_lock(&session.master, deadline, &session.stop_requested)?
        .as_ref()
        .ok_or("PTY is closed")?
        .as_raw_fd()
        .ok_or("PTY input does not support bounded native writes")?;
    let mut writer = input_lock(&session.writer, deadline, &session.stop_requested)?;
    #[cfg(unix)]
    write_input_until(
        writer.as_mut(),
        fd,
        data.as_bytes(),
        deadline,
        &session.stop_requested,
    )?;
    #[cfg(windows)]
    write_windows_input(
        writer.as_mut(),
        data.as_bytes(),
        deadline,
        &session.stop_requested,
    )?;
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
    proxy!(
        manager,
        "resize_session",
        serde_json::json!({"session_id":session_id,"cols":cols,"rows":rows})
    );
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
    let _log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    let previous = if let Some(terminal) = &session.terminal {
        let previous = terminal
            .runtime
            .call("snapshot", &session_id, serde_json::json!({}))?;
        terminal.runtime.call(
            "resize",
            &session_id,
            serde_json::json!({"cols":cols,"rows":rows}),
        )?;
        Some(previous)
    } else {
        None
    };
    let result = session
        .master
        .lock()
        .map_err(|_| "PTY master lock poisoned".to_string())
        .and_then(|master| {
            master
                .as_ref()
                .ok_or_else(|| "PTY is closed".to_string())?
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Failed to resize session: {error}"))
        });
    if result.is_err() {
        if let (Some(terminal), Some(previous)) = (&session.terminal, previous) {
            terminal.runtime.call(
                "resize",
                &session_id,
                serde_json::json!({"cols":previous["cols"],"rows":previous["rows"]}),
            )?;
        }
    }
    result
}

#[tauri::command]
fn stop_session(manager: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    proxy!(
        manager,
        "stop_session",
        serde_json::json!({"session_id":session_id})
    );
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
    proxy!(
        manager,
        "acknowledge_notification",
        serde_json::json!({"session_id":session_id,"expected_status":expected_status})
    );
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
    proxy!(
        manager,
        "notify_session",
        serde_json::json!({"session_id":session_id,"title":title,"expected_status":expected_status})
    );
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
fn get_notification_pause_state(
    manager: State<'_, SessionManager>,
) -> Result<system_entry::PauseState, String> {
    proxy!(
        manager,
        "get_notification_pause_state",
        serde_json::json!({})
    );
    serde_json::from_value(system_entry::pause_command(
        &manager,
        "get_notification_pause_state",
        &serde_json::json!({}),
    )?)
    .map_err(|_| "system_entry_unavailable".into())
}
#[tauri::command(rename_all = "snake_case")]
fn initialize_notification_pause(
    manager: State<'_, SessionManager>,
    legacy_paused: bool,
    expected_owner_instance: String,
) -> Result<system_entry::PauseState, String> {
    let args = serde_json::json!({"legacy_paused":legacy_paused,"expected_owner_instance":expected_owner_instance});
    proxy!(manager, "initialize_notification_pause", args.clone());
    serde_json::from_value(system_entry::pause_command(
        &manager,
        "initialize_notification_pause",
        &args,
    )?)
    .map_err(|_| "system_entry_unavailable".into())
}
#[tauri::command(rename_all = "snake_case")]
fn set_notification_paused(
    manager: State<'_, SessionManager>,
    paused: bool,
    expected_revision: u64,
    expected_owner_instance: String,
) -> Result<system_entry::PauseState, String> {
    let args = serde_json::json!({"paused":paused,"expected_revision":expected_revision,"expected_owner_instance":expected_owner_instance});
    proxy!(manager, "set_notification_paused", args.clone());
    serde_json::from_value(system_entry::pause_command(
        &manager,
        "set_notification_paused",
        &args,
    )?)
    .map_err(|_| "system_entry_unavailable".into())
}
#[tauri::command]
fn get_system_entry_status(
    manager: State<'_, SessionManager>,
) -> Result<serde_json::Value, String> {
    proxy!(manager, "get_system_entry_status", serde_json::json!({}));
    system_entry::status(&manager)
}
#[tauri::command]
fn set_global_shortcut(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    enabled: bool,
    expected_owner_instance: String,
) -> Result<serde_json::Value, String> {
    let args =
        serde_json::json!({"enabled":enabled,"expected_owner_instance":expected_owner_instance});
    proxy!(manager, "set_global_shortcut", args);
    system_entry::set_shortcut_native(&app, enabled, &expected_owner_instance)
}
#[tauri::command]
fn set_agent_notification_context(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    selected: Option<String>,
    paused: Option<bool>,
    pause_revision: Option<u64>,
) -> Result<(), String> {
    let mut args = serde_json::json!({"selected":selected});
    if let Some(paused) = paused {
        args["paused"] = paused.into();
    }
    if let Some(revision) = pause_revision {
        args["pause_revision"] = revision.into();
    }
    proxy!(manager, "set_agent_notification_context", args.clone());
    let history = manager.history(&app)?;
    if let Some(id) = selected.as_ref() {
        history.get(id)?;
    }
    // Bridge startup does not acquire settings. Its disabled context is synchronized only after it returns.
    manager.start_agent_runtime(&app, history)?;
    system_entry::pause_command(&manager, "set_agent_notification_context", &args)?;
    Ok(())
}
#[tauri::command]
fn retry_agent_notifications(manager: State<'_, SessionManager>) -> Result<(), String> {
    proxy!(manager, "retry_agent_notifications", serde_json::json!({}));
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
    proxy!(
        manager,
        "read_agent_receipt",
        serde_json::json!({"session_id":session_id,"receipt":receipt,"revision":revision})
    );
    manager
        .history(&app)?
        .read_agent_receipt(&session_id, &receipt, revision)
}

#[tauri::command]
fn list_session_summaries(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    request: history::PageRequest,
) -> Result<history::HistoryPage<history::HistoryItem>, String> {
    proxy!(
        manager,
        "list_session_summaries",
        serde_json::json!({"request":request})
    );
    manager.history(&app)?.page(request)
}
#[tauri::command]
fn get_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<SessionRecord, String> {
    proxy!(
        manager,
        "get_session",
        serde_json::json!({"session_id":session_id})
    );
    manager.history(&app)?.get(&session_id)
}
#[tauri::command]
fn history_overview(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<history::Overview, String> {
    proxy!(manager, "history_overview", serde_json::json!({}));
    manager.history(&app)?.overview()
}
#[tauri::command]
fn list_unread_receipts(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    request: history::PageRequest,
) -> Result<history::HistoryPage<history::InboxItem>, String> {
    proxy!(
        manager,
        "list_unread_receipts",
        serde_json::json!({"request":request})
    );
    manager.history(&app)?.inbox(request)
}
#[tauri::command]
fn next_attention(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    current_session_id: Option<String>,
) -> Result<Option<String>, String> {
    proxy!(
        manager,
        "next_attention",
        serde_json::json!({"current_session_id":current_session_id})
    );
    manager
        .history(&app)?
        .next_attention(current_session_id.as_deref())
}
#[tauri::command]
fn list_pending_notifications(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    limit: usize,
    after_key: Option<history::PendingKey>,
) -> Result<history::PendingPage, String> {
    proxy!(
        manager,
        "list_pending_notifications",
        serde_json::json!({"limit":limit,"after_key":after_key})
    );
    manager.history(&app)?.pending(limit, after_key)
}
#[tauri::command]
async fn scan_history_capacity(
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<history::Capacity, String> {
    proxy!(manager, "scan_history_capacity", serde_json::json!({}));
    let root = manager.history(&app)?.root.clone();
    tauri::async_runtime::spawn_blocking(move || history::scan_capacity(&root))
        .await
        .map_err(|_| "Capacity worker failed")?
}
#[tauri::command]
fn cancel_history_capacity(manager: State<'_, SessionManager>) -> Result<(), String> {
    proxy!(manager, "cancel_history_capacity", serde_json::json!({}));
    history::cancel_capacity();
    Ok(())
}

fn recorded_log(
    history: &HistoryStore,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
    record: &SessionRecord,
) -> Result<session_logs::LogData, String> {
    recorded_log_source(
        history,
        sessions,
        &record.summary.session_id,
        record.output_end_offset,
    )
}
fn recorded_log_source(
    history: &HistoryStore,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
    session_id: &str,
    output_end_offset: u64,
) -> Result<session_logs::LogData, String> {
    if session_id_from_link(&format!("yam://session/{session_id}")).is_none() {
        return Err("Invalid log session identity".into());
    }
    let active = sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(session_id)
        .cloned();
    let log = active
        .as_ref()
        .map(|s| s.log.lock().map_err(|_| "Session log lock poisoned"))
        .transpose()?;
    if let Some(error) = log.as_ref().and_then(|log| log.error.as_ref()) {
        return Err(error.clone());
    }
    let data = session_logs::read_bounded_log(
        File::open(history.log_path(session_id)).map_err(|_| "Cannot read retained log")?,
    )?;
    let reported_end = log
        .as_ref()
        .map(|log| log.end_offset)
        .unwrap_or(output_end_offset);
    let range = session_logs::retained_range(data.len(), reported_end, log.is_some());
    // The legacy parser base remains separate from authoritative absolute provenance.
    let offset = reported_end.max(data.len() as u64) - data.len() as u64;
    Ok(session_logs::LogData {
        data,
        offset,
        range: Some(range),
    })
}

#[tauri::command]
async fn search_session_logs(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: Option<String>,
    request: session_logs::SearchRequest,
) -> Result<session_logs::SearchPage, String> {
    proxy!(
        manager,
        "search_session_logs",
        serde_json::json!({"session_id":session_id,"request":request})
    );
    let generation = LOG_SEARCH_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let history = manager.history(&app)?;
    let sessions = manager.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOG_SEARCH_LOCK.lock().map_err(|_| "Search lock poisoned")?;
        search_retained_logs(&history, &sessions, session_id, request, || {
            LOG_SEARCH_GENERATION.load(Ordering::Acquire) != generation
        })
    })
    .await
    .map_err(|_| "Log search worker failed".to_string())?
}

fn search_retained_logs(
    history: &HistoryStore,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
    session_id: Option<String>,
    request: session_logs::SearchRequest,
    cancelled: impl Fn() -> bool,
) -> Result<session_logs::SearchPage, String> {
    let original = request.source_cursor.clone();
    let batch = if let Some(id) = session_id.as_ref() {
        let record = history.get(id).map_err(|_| "Unknown log session")?;
        history::LogSourceBatch {
            sources: vec![session_logs::LogSource {
                session_id: id.clone(),
                cwd: record.summary.cwd,
            }],
            positions: vec![0],
            end_offsets: vec![record.output_end_offset],
            end: 1,
            total: 1,
            snapshot: history.instance.clone(),
        }
    } else {
        history.log_source_batch(original.as_ref().map_or(0, |c| c.source_offset), &cancelled)?
    };
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(
        &(
            &batch.snapshot,
            &request.query,
            request.case_sensitive,
            &session_id,
        ),
        &mut hash,
    );
    let snapshot = format!("{:016x}", std::hash::Hasher::finish(&hash));
    if original
        .as_ref()
        .is_some_and(|c| c.snapshot.as_deref() != Some(snapshot.as_str()))
    {
        return Err("Log search cursor expired; restart search".into());
    }
    let mut bounded = request;
    bounded.source_cursor = None;
    let offsets = batch
        .sources
        .iter()
        .zip(&batch.end_offsets)
        .map(|(source, offset)| (source.session_id.as_str(), *offset))
        .collect::<HashMap<_, _>>();
    let mut page = session_logs::search(
        &batch.sources,
        |id| {
            recorded_log_source(
                history,
                sessions,
                id,
                *offsets.get(id).ok_or("Unknown log source")?,
            )
        },
        &bounded,
        cancelled,
    )?;
    page.current_cursor = Some(session_logs::SearchCursor {
        source_offset: original.as_ref().map_or(0, |c| c.source_offset),
        snapshot: Some(snapshot.clone()),
    });
    if let Some(cursor) = page.next_cursor.as_mut() {
        cursor.source_offset = batch
            .positions
            .get(cursor.source_offset)
            .copied()
            .unwrap_or(batch.end);
        cursor.snapshot = Some(snapshot);
    } else if !page.has_more && batch.end < batch.total {
        page.next_cursor = Some(session_logs::SearchCursor {
            source_offset: batch.end,
            snapshot: Some(snapshot),
        });
        page.complete = false;
    }
    Ok(page)
}

#[tauri::command]
async fn export_diagnostics(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = diagnostics::report(&app.state::<SessionManager>())?;
        let Some(destination) = app
            .dialog()
            .file()
            .set_file_name("yam-diagnostics.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = destination.into_path().map_err(|_| "invalid_destination")?;
        diagnostics::write_selected(Some(&path), &bytes)
    })
    .await
    .map_err(|_| "worker_failed".to_string())?
    .map_err(str::to_owned)
}

#[derive(Debug, Serialize)]
struct LogExportReceipt {
    path: String,
    range: session_logs::RetainedLogRange,
}
fn prepare_log_export(
    record: &SessionRecord,
    snapshot: LogSnapshot,
    title: &str,
    raw: bool,
) -> Result<(String, session_logs::RetainedLogRange), String> {
    if snapshot.data.len() > 8 * 1024 * 1024 {
        return Err("Log exceeds its 8 MiB budget".into());
    }
    let range = snapshot
        .range
        .unwrap_or_else(|| session_logs::retained_range(snapshot.data.len(), 0, false));
    let metadata = serde_json::to_string_pretty(&serde_json::json!({"session_id":record.summary.session_id,"title":title,
        "cwd":record.summary.cwd,"status":snapshot.status,"started_at":record.started_at,"ended_at":record.ended_at,
        "retained_output_offset":snapshot.offset,"retained_range":range,"format":if raw {"raw terminal output"}else{"plain text"}})).map_err(|e|e.to_string())?;
    let log = session_logs::LogData {
        data: snapshot.data,
        offset: snapshot.offset,
        range: Some(range.clone()),
    };
    let content = session_logs::export_text(
        &format!("YAM recorded session output\n{metadata}\n\n"),
        &log,
        raw,
    );
    Ok((content, range))
}
fn publish_log_export(
    path: Option<&Path>,
    content: &str,
    range: session_logs::RetainedLogRange,
) -> Result<Option<LogExportReceipt>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    session_logs::write_export(path, content.as_bytes())?;
    Ok(Some(LogExportReceipt {
        path: path.to_string_lossy().into_owned(),
        range,
    }))
}

#[tauri::command]
async fn export_session_log(
    app: AppHandle,
    _manager: State<'_, SessionManager>,
    session_id: String,
    title: String,
    raw: bool,
) -> Result<Option<LogExportReceipt>, String> {
    if title.chars().count() > 200 || title.contains('\0') {
        return Err("Invalid export title".into());
    }
    let record = get_session(
        app.clone(),
        app.state::<SessionManager>(),
        session_id.clone(),
    )?;
    let snapshot = read_session_snapshot(
        app.clone(),
        app.state::<SessionManager>(),
        session_id.clone(),
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let (content, range) = prepare_log_export(&record, snapshot, &title, raw)?;
        let path = app
            .dialog()
            .file()
            .set_file_name(format!("yam-{session_id}.txt"))
            .add_filter("Text", &["txt"])
            .blocking_save_file()
            .map(|path| path.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        publish_log_export(path.as_deref(), &content, range)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_log_excerpt(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
    offset: u64,
    column: usize,
) -> Result<String, String> {
    proxy!(
        manager,
        "read_log_excerpt",
        serde_json::json!({"session_id":session_id,"offset":offset,"column":column})
    );
    let history = manager.history(&app)?;
    let sessions = manager.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let record = history.get(&session_id)?;
        let log = recorded_log(&history, &sessions, &record)?;
        session_logs::excerpt(&log, offset, column)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn cancel_log_search(manager: State<'_, SessionManager>) -> Result<(), String> {
    proxy!(manager, "cancel_log_search", serde_json::json!({}));
    LOG_SEARCH_GENERATION.fetch_add(1, Ordering::AcqRel);
    // Wait for the cancelled read to leave the shared scan boundary before accepting a new UI query.
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = LOG_SEARCH_LOCK.lock().map_err(|_| "Search lock poisoned")?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_session_log(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<String, String> {
    proxy!(
        manager,
        "read_session_log",
        serde_json::json!({"session_id":session_id})
    );
    let history = manager.history(&app)?;
    read_recorded_log_string(&history, &session_id)
}

fn read_recorded_log_string(history: &HistoryStore, session_id: &str) -> Result<String, String> {
    history.get(session_id)?;
    let path = history.log_path(session_id);
    let file = fs::File::open(&path).map_err(|_| "Log could not be read".to_string())?;
    session_logs::read_bounded_log(file)
}

#[tauri::command]
fn read_session_snapshot(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<LogSnapshot, String> {
    proxy!(
        manager,
        "read_session_snapshot",
        serde_json::json!({"session_id":session_id})
    );
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned();
    let (log, status) = if let Some(session) = active {
        let data = recorded_log_source(&session.history, &manager.sessions, &session_id, 0)?;
        let status = session
            .status
            .lock()
            .map_err(|_| "Session status lock poisoned")?
            .clone();
        (data, status)
    } else {
        let history = manager.history(&app)?;
        let record = history.get(&session_id)?;
        let data = recorded_log_source(
            &history,
            &manager.sessions,
            &session_id,
            record.output_end_offset,
        )?;
        (data, record.status)
    };
    Ok(LogSnapshot {
        end_offset: log.offset.saturating_add(log.data.len() as u64),
        offset: log.offset,
        data: log.data,
        status,
        range: log.range,
    })
}

#[tauri::command]
fn take_terminal_control(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    proxy!(
        manager,
        "take_terminal_control",
        serde_json::json!({"session_id":session_id})
    );
    Err("Input control requires the background owner".into())
}

fn record_desktop_focus(manager: &SessionManager, label: &str, focused: bool) {
    if label == "main" {
        manager.desktop_foreground.store(focused, Ordering::Release);
    }
}

fn stop_background_and_quit(app: AppHandle) -> Result<(), String> {
    let client = app
        .state::<SessionManager>()
        .background_client
        .lock()
        .map_err(|_| "Background client lock poisoned")?
        .clone()
        .ok_or("Background is unavailable")?;
    client.call("shutdown", serde_json::json!({}))?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
async fn stop_all_and_quit(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_background_and_quit(app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    background::ignore_platform_window_restoration();
    #[cfg(target_os = "macos")]
    let _activity = background::ProcessActivity::begin();
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
                    "yam-stop-quit",
                    "Stop all tasks and quit",
                    true,
                    None::<&str>,
                )?)?;
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
            if event.id().as_ref() == "yam-stop-quit" {
                let app = app.clone();
                thread::spawn(move || {
                    if let Err(error) = stop_background_and_quit(app.clone()) {
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
            if event.id().as_ref() == "yam-quit" {
                app.exit(0);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                record_desktop_focus(&window.state::<SessionManager>(), window.label(), *focused);
            }
        })
        .setup(|app| {
            updater::initialize(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                record_desktop_focus(
                    &app.state::<SessionManager>(),
                    "main",
                    window.is_focused().unwrap_or(false),
                );
            }
            background::attach(app.handle())?;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(error) = route_notification_link(&handle, url.as_str()) {
                        eprintln!("[YAM] {error}");
                    }
                }
            });
            for argument in std::env::args().skip(1) {
                if session_id_from_link(&argument).is_some() {
                    route_notification_link(app.handle(), &argument)?;
                }
            }
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
            updater::updater_status,
            updater::updater_check,
            updater::updater_download,
            updater::updater_cancel,
            updater::updater_set_automatic_checks,
            updater::updater_install,
            health_check,
            memory_usage,
            validate_project_directory,
            list_adapters,
            archive_session,
            get_history_policy,
            set_history_policy,
            preview_archive_deletion,
            cancel_archive_deletion_preview,
            confirm_archive_deletion,
            restore_archive,
            list_archived_sessions,
            get_launch_defaults,
            get_git_context,
            get_git_changes,
            cancel_git_changes,
            preview_worktree_create,
            create_worktree,
            list_managed_worktrees,
            preview_worktree_cleanup,
            cleanup_worktree,
            set_launch_defaults,
            preview_project_config,
            trust_project_config,
            create_session,
            write_session,
            resize_session,
            stop_session,
            list_session_summaries,
            get_session,
            history_overview,
            list_unread_receipts,
            next_attention,
            list_pending_notifications,
            scan_history_capacity,
            cancel_history_capacity,
            notify_session,
            acknowledge_notification,
            get_notification_pause_state,
            initialize_notification_pause,
            set_notification_paused,
            get_system_entry_status,
            set_global_shortcut,
            set_agent_notification_context,
            retry_agent_notifications,
            read_agent_receipt,
            pending_notification_selection,
            acknowledge_notification_selection,
            read_session_log,
            search_session_logs,
            cancel_log_search,
            read_log_excerpt,
            export_session_log,
            export_diagnostics,
            read_session_snapshot,
            read_terminal_frame,
            stop_all_and_quit,
            take_terminal_control,
            set_terminal_viewport
        ])
        .build(app_context())
        .expect("error while building YAM")
        .run(handle_owner_exit);
}
fn keep_background_event_loop(owner: bool, stopping: bool) -> bool {
    owner && !stopping
}
fn handle_owner_exit(app: &AppHandle, event: tauri::RunEvent) {
    let manager = app.state::<SessionManager>();
    if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
        if manager.background_owner {
            eprintln!(
                "[YAM] Background exit request: code={code:?}, stopping={}",
                manager.shutting_down.load(Ordering::Acquire)
            );
        }
        if keep_background_event_loop(
            manager.background_owner,
            manager.shutting_down.load(Ordering::Acquire),
        ) {
            // The zero-window owner must stay alive until shutdown or its idle deadline.
            api.prevent_exit();
            return;
        }
    }
    // GUI update work is fenced and exactly joined before the detached-client early return.
    if !manager.background_owner {
        if let Some(controller) = app.try_state::<Arc<updater::Controller>>() {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if controller.prepare_exit() {
                    api.prevent_exit();
                    if controller.claim_exit_cleanup() {
                        let controller = controller.inner().clone();
                        let handle = app.clone();
                        let code = code.unwrap_or(0);
                        thread::spawn(move || {
                            controller.shutdown_and_join();
                            handle.exit(code);
                        });
                    }
                    return;
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                controller.shutdown_and_join();
            }
        }
    }
    if manager
        .background_client
        .lock()
        .is_ok_and(|client| client.is_some())
    {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            manager.shutting_down.store(true, Ordering::Release);
        }
        return;
    }
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
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn custom_cmd_quotes_and_unicode_paths_reach_the_native_shell_unchanged() {
        let root =
            std::env::temp_dir().join(format!("yam quoted 中文 {}", super::next_session_id()));
        std::fs::create_dir_all(&root).unwrap();
        let output = root.join("quoted result.txt");
        let shell =
            std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        let command = format!(
            "\"{shell}\" /D /C echo YAM_QUOTED_COMMAND>\"{}\"",
            output.display()
        );
        let builder = super::shell_command(Some(&command));
        let mut child = std::process::Command::new(&builder.get_argv()[0]);
        child.args(&builder.get_argv()[1..]);
        if let Some(value) = builder.get_env("YAM_CUSTOM_COMMAND") {
            child.env("YAM_CUSTOM_COMMAND", value);
        }
        assert!(child.status().unwrap().success());
        assert!(std::fs::read_to_string(&output)
            .unwrap()
            .contains("YAM_QUOTED_COMMAND"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn an_exited_conpty_closes_output_before_the_final_scene_deadline() {
        use std::io::{Read, Write};
        let (session, mut reader, history) = test_session("echo YAM_CONPTY_DRAIN");
        let (done, receive) = std::sync::mpsc::channel();
        let output = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = reader.read_to_end(&mut bytes);
            let _ = done.send((result, bytes));
        });
        session
            .writer
            .lock()
            .unwrap()
            .write_all(b"\x1b[1;1R")
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while session.child.lock().unwrap().try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        super::close_exited_console(&session);
        let (result, bytes) = receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        result.unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("YAM_CONPTY_DRAIN"));
        output.join().unwrap();
        drop(session);
        std::fs::remove_dir_all(&history).unwrap();
    }
    use super::MAX_SESSION_HISTORY_BYTES;
    #[test]
    fn a_background_owner_keeps_its_event_loop_without_a_desktop_window() {
        assert!(super::keep_background_event_loop(true, false));
        assert!(!super::keep_background_event_loop(false, false));
        assert!(!super::keep_background_event_loop(true, true));
    }
    #[test]
    fn desktop_history_cannot_write_while_another_process_owns_background_history() {
        let root =
            std::env::temp_dir().join(format!("yam-history-owner-{}", super::next_session_id()));
        let desktop = super::SessionManager::default();
        desktop.acquire_history_owner(&root).unwrap();
        desktop.acquire_history_owner(&root).unwrap();
        let second = super::SessionManager::default();
        assert!(second.acquire_history_owner(&root).is_err());
        assert!(super::background::OwnerLock::acquire(&root).is_err());
        drop(desktop);
        let background = super::background::OwnerLock::acquire(&root).unwrap();
        assert!(second.acquire_history_owner(&root).is_err());
        drop(background);
        second.acquire_history_owner(&root).unwrap();
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
    use std::fs;
    #[cfg(unix)]
    use std::io::Read;

    use portable_pty::{native_pty_system, PtySize};

    use super::{
        agent_adapters, append_log, is_terminal, next_session_id, shell_command, HealthReport,
        HistoryStore, SessionManager, SessionSummary,
    };

    #[cfg(unix)]
    #[test]
    fn native_raw_pty_input_is_nonblocking_and_cannot_hang_when_child_does_not_read() {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        super::configure_terminal_input(pair.master.as_ref()).unwrap();
        let fd = pair.master.as_raw_fd().unwrap();
        let mut settings: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::tcgetattr(fd, &mut settings) }, 0);
        unsafe { libc::cfmakeraw(&mut settings) };
        assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &settings) }, 0);
        let mut writer = pair.master.take_writer().unwrap();
        let started = std::time::Instant::now();
        assert!(super::write_input_until(
            writer.as_mut(),
            fd,
            &vec![b'x'; 2 * 1024 * 1024],
            started + std::time::Duration::from_millis(40),
            &std::sync::atomic::AtomicBool::new(false)
        )
        .unwrap_err()
        .contains("deadline"));
        assert!(started.elapsed() < std::time::Duration::from_millis(300));
    }
    #[cfg(windows)]
    #[test]
    fn synchronous_windows_pipe_input_can_be_cancelled_without_waiting_for_the_reader() {
        use std::os::windows::io::{FromRawHandle, RawHandle};
        #[link(name = "kernel32")]
        extern "system" {
            fn CreatePipe(
                read: *mut RawHandle,
                write: *mut RawHandle,
                attributes: *const std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 4096) },
            0
        );
        let mut reader = unsafe { std::fs::File::from_raw_handle(read) };
        let mut writer = unsafe { std::fs::File::from_raw_handle(write) };
        let drain = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut reader, &mut data).unwrap();
            data
        });
        let started = std::time::Instant::now();
        let result = super::write_windows_input(
            &mut writer,
            &vec![b'x'; 2 * 1024 * 1024],
            started + std::time::Duration::from_millis(40),
            &std::sync::atomic::AtomicBool::new(false),
        );
        let elapsed = started.elapsed();
        drop(writer);
        let received = drain.join().unwrap();
        assert!(result.unwrap_err().contains("do not resend"));
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "input waited for the reader: {elapsed:?}"
        );
        assert!(received.len() < 2 * 1024 * 1024);
        let mut output = Vec::new();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        super::write_windows_input(
            &mut output,
            "中文😀".as_bytes(),
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            &cancelled,
        )
        .unwrap();
        assert_eq!(output, "中文😀".as_bytes());
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        assert!(super::write_windows_input(
            &mut output,
            b"extra",
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            &cancelled
        )
        .is_err());
        assert_eq!(output, "中文😀".as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn saved_terminal_frames_reject_links_public_files_and_oversized_content() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(super::next_session_id());
        std::fs::create_dir(&root).unwrap();
        let path = root.join("saved.frame.json");
        assert!(super::saved_frame_bytes(&path).unwrap().is_none());
        std::fs::write(&path, b"frame").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(super::saved_frame_bytes(&path).unwrap().unwrap(), b"frame");
        let link = root.join("link");
        symlink(&path, &link).unwrap();
        assert!(super::saved_frame_bytes(&link).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(super::saved_frame_bytes(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        assert!(super::saved_frame_bytes(&path)
            .unwrap_err()
            .contains("budget"));
        std::fs::remove_file(&path).unwrap();
        assert!(
            super::saved_frame_bytes(&link).is_err(),
            "a broken link is an error, not a legacy session"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_input_lock_is_bounded_and_cancelled_without_accepting_bytes() {
        let lock = std::sync::Mutex::new(7);
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            *super::input_lock(
                &lock,
                std::time::Instant::now() + std::time::Duration::from_secs(1),
                &cancelled
            )
            .unwrap(),
            7
        );
        let _held = lock.lock().unwrap();
        let started = std::time::Instant::now();
        assert!(super::input_lock(
            &lock,
            started + std::time::Duration::from_millis(20),
            &cancelled
        )
        .unwrap_err()
        .contains("no bytes"));
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        cancelled.store(true, super::Ordering::Release);
        assert!(super::input_lock(
            &lock,
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            &cancelled
        )
        .unwrap_err()
        .contains("cancelled"));
    }
    #[cfg(unix)]
    #[test]
    fn blocked_terminal_input_times_out_with_a_partial_byte_receipt() {
        use std::os::{fd::AsRawFd, unix::net::UnixStream};
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        let fd = writer.as_raw_fd();
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let started = std::time::Instant::now();
        let result = super::write_input_until(
            &mut writer,
            fd,
            &bytes,
            started + std::time::Duration::from_millis(40),
            &std::sync::atomic::AtomicBool::new(false),
        );
        assert!(started.elapsed() < std::time::Duration::from_millis(300));
        let error = result.unwrap_err();
        assert!(error.contains("deadline"));
        assert!(error.contains("bytes"));
        assert!(error.contains("not resend"));
        reader.set_nonblocking(true).unwrap();
        let mut received = Vec::new();
        let _ = std::io::Read::read_to_end(&mut reader, &mut received);
        assert!(!received.is_empty());
        assert!(received.len() < bytes.len());
        assert!(received.iter().all(|byte| *byte == b'x'));
    }
    #[cfg(unix)]
    #[test]
    fn terminal_input_preserves_unicode_and_checks_cancellation_before_writing() {
        use std::os::{fd::AsRawFd, unix::net::UnixStream};
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        let fd = writer.as_raw_fd();
        let bytes = "hello 中文 😀\n".as_bytes();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        super::write_input_until(
            &mut writer,
            fd,
            bytes,
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            &cancelled,
        )
        .unwrap();
        let mut received = vec![0; bytes.len()];
        std::io::Read::read_exact(&mut reader, &mut received).unwrap();
        assert_eq!(received, bytes);
        cancelled.store(true, super::Ordering::Release);
        assert!(super::write_input_until(
            &mut writer,
            fd,
            b"never",
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            &cancelled
        )
        .unwrap_err()
        .contains("cancelled"));
        reader.set_nonblocking(true).unwrap();
        assert_eq!(
            std::io::Read::read(&mut reader, &mut [0])
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        super::write_input_until(&mut writer, fd, b"", std::time::Instant::now(), &cancelled)
            .unwrap();
    }
    #[test]
    fn only_main_window_focus_changes_desktop_heartbeat_context() {
        let manager = SessionManager::default();
        super::record_desktop_focus(&manager, "main", true);
        assert!(manager.desktop_foreground.load(super::Ordering::Acquire));
        super::record_desktop_focus(&manager, "export-dialog", false);
        assert!(manager.desktop_foreground.load(super::Ordering::Acquire));
        super::record_desktop_focus(&manager, "main", false);
        assert!(!manager.desktop_foreground.load(super::Ordering::Acquire));
    }
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
    fn saved_scene_confirmation_requires_valid_identity_and_recorded_lifecycle() {
        let value = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":0,"data":"ALT","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"alternate"},"end_offset":42,"status":"stopped"});
        let bytes = serde_json::to_vec(&value).unwrap();
        let frame: super::TerminalFrame = serde_json::from_slice(&bytes).unwrap();
        assert!(!frame.persisted);
        assert!(
            super::decode_saved_frame(&bytes, "s-one", "stopped", 42)
                .unwrap()
                .persisted
        );
        assert!(super::decode_saved_frame(&bytes, "s-other", "stopped", 42).is_err());
        assert!(super::decode_saved_frame(&bytes, "s-one", "running", 42).is_err());
        assert!(super::decode_saved_frame(&bytes, "s-one", "failed", 42).is_err());
        assert!(super::decode_saved_frame(&bytes, "s-one", "stopped", 41).is_err());
        assert!(super::decode_saved_frame(b"broken", "s-one", "stopped", 42).is_err());
    }

    #[test]
    fn built_in_adapters_include_shell_and_agent_entries() {
        let adapters = agent_adapters();
        assert_eq!(adapters.len(), 4);
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
            .contains("background owner restarted"));
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
            master: std::sync::Mutex::new(Some(pair.master)),
            writer: std::sync::Mutex::new(writer),
            #[cfg(windows)]
            job: Some(super::WindowsJob::attach(child.as_raw_handle().unwrap()).unwrap()),
            child: std::sync::Mutex::new(child),
            terminal: None,
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
        {
            let mut records = store.records.lock().unwrap();
            let launch = records[0].summary.launch.as_mut().unwrap();
            launch.adapter = "claude".into();
            launch.extra_args = "--model fable".into();
        }
        let (_, claude, id) = super::resume_source(&store, &summary.session_id).unwrap();
        assert_eq!(claude.adapter, "claude");
        assert_eq!(claude.extra_args, "--model fable");
        assert_eq!(claude.prompt, None);
        assert_eq!(id, native_id);
        for (adapter, mode, args) in [
            ("unknown", "interactive", ""),
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
    fn opencode_uses_native_prompt_options_without_shell_interpretation() {
        let mut launch = super::AgentLaunch {
            adapter: "opencode".into(),
            mode: "interactive".into(),
            extra_args: "--model opencode/space-bunny-free".into(),
            prompt: Some("literal $(ignored) 中文".into()),
        };
        let cmd = super::agent_command(std::path::Path::new("opencode"), &launch).unwrap();
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &args[1..],
            &[
                "--model",
                "opencode/space-bunny-free",
                "--prompt",
                "literal $(ignored) 中文"
            ]
        );
        launch.mode = "task".into();
        let cmd = super::agent_command(std::path::Path::new("opencode"), &launch).unwrap();
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &args[1..],
            &[
                "run",
                "--format",
                "json",
                "--model",
                "opencode/space-bunny-free",
                "--",
                "literal $(ignored) 中文"
            ]
        );
    }

    #[test]
    fn claude_resume_preserves_safe_options_and_never_replays_the_prompt() {
        let id = "446cd50d-099d-4a12-bcbc-5ab13ffa6944";
        let mut launch = super::AgentLaunch {
            adapter: "claude".into(),
            mode: "interactive".into(),
            extra_args: "--model fable --effort high".into(),
            prompt: None,
        };
        let cmd = super::resume_command(std::path::Path::new("claude"), &launch, id).unwrap();
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &args[1..],
            &["--model", "fable", "--effort", "high", "--resume", id]
        );
        for args in [
            "--resume another",
            "--settings arbitrary",
            "--continue",
            "--session-id arbitrary",
        ] {
            launch.extra_args = args.into();
            assert!(super::resume_command(std::path::Path::new("claude"), &launch, id).is_err());
        }
        launch.extra_args = String::new();
        launch.prompt = Some("never replay".into());
        assert!(super::resume_command(std::path::Path::new("claude"), &launch, id).is_err());
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

#[cfg(test)]
mod t09_entry_tests {
    use super::*;
    #[test]
    fn t09_owner_entry_rejects_config_errors_before_the_allocation_boundary() {
        let base = std::env::temp_dir().join(format!(
            "yam-t09-entry-{}-{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        fs::create_dir(&base).unwrap();
        struct OwnFixture(PathBuf);
        impl Drop for OwnFixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = OwnFixture(base.clone());
        let root = base.join("project");
        let private = base.join("app-private");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&private).unwrap();
        let manager = SessionManager::default();
        let before_counter = SESSION_COUNTER.load(Ordering::Relaxed);
        for (source, expected) in [
            (serde_json::json!({"version":2}), "project_config_invalid"),
            (
                serde_json::json!({"version":1,"defaults":{"adapter":"custom","command":"touch must-not-execute"}}),
                "project_config_untrusted",
            ),
        ] {
            fs::write(root.join("yam.json"), serde_json::to_vec(&source).unwrap()).unwrap();
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let project: project_config::ProjectStart = serde_json::from_value(
                serde_json::json!({"root":root,"template":null,"overrides":{}}),
            )
            .unwrap();
            let result = create_session_owner(
                None,
                &manager,
                &private,
                None,
                None,
                None,
                None,
                Some(project),
            );
            assert_eq!(result.unwrap_err(), expected);
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
            assert_eq!(SESSION_COUNTER.load(Ordering::Relaxed), before_counter);
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert!(fs::read_dir(&private).unwrap().next().is_none());
        }
    }
    #[test]
    fn t09_owner_entry_changed_env_cwd_and_cli_errors_never_reach_allocations() {
        let base = std::env::temp_dir().join(format!(
            "yam-t09-entry-more-{}-{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        fs::create_dir(&base).unwrap();
        struct OwnFixture(PathBuf);
        impl Drop for OwnFixture {
            fn drop(&mut self) {
                T09_MISSING_CLI.with(|flag| flag.set(false));
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = OwnFixture(base.clone());
        let root = base.join("project");
        let private = base.join("app-private");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&private).unwrap();
        let manager = SessionManager::default();
        let before_counter = SESSION_COUNTER.load(Ordering::Relaxed);
        let write = |value: serde_json::Value| {
            fs::write(root.join("yam.json"), serde_json::to_vec(&value).unwrap()).unwrap()
        };
        let approve = || {
            let p = project_config::preview(&root, &private).unwrap();
            project_config::trust(&root, &private, &p).unwrap();
        };
        let run = |overrides: serde_json::Value, expected: &str| {
            let before = fs::read(private.join("project-launch.json")).unwrap();
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let project = serde_json::from_value(
                serde_json::json!({"root":root,"template":null,"overrides":overrides}),
            )
            .unwrap();
            let result = create_session_owner(
                None,
                &manager,
                &private,
                None,
                None,
                None,
                None,
                Some(project),
            );
            assert_eq!(result.unwrap_err(), expected);
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
            assert_eq!(SESSION_COUNTER.load(Ordering::Relaxed), before_counter);
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert_eq!(
                fs::read(private.join("project-launch.json")).unwrap(),
                before
            );
            assert_eq!(fs::read_dir(&private).unwrap().count(), 1);
            assert!(!private.join("sessions").exists());
        };
        write(
            serde_json::json!({"version":1,"defaults":{"adapter":"custom","command":"echo literal"}}),
        );
        approve();
        write(
            serde_json::json!({"version":1,"defaults":{"adapter":"custom","command":"echo changed"}}),
        );
        run(serde_json::json!({}), "project_config_untrusted");
        approve();
        run(serde_json::json!({"cwd":"missing"}), "project_config_cwd");
        let missing = format!("T09_REQUIRED_ENV_{}", std::process::id());
        assert!(std::env::var_os(&missing).is_none());
        write(
            serde_json::json!({"version":1,"defaults":{"adapter":"custom","command":"echo literal","env":{"TARGET_KEY":missing}}}),
        );
        approve();
        run(serde_json::json!({}), "project_config_env_missing");
        write(serde_json::json!({"version":1,"defaults":{"adapter":"codex","mode":"interactive"}}));
        approve();
        T09_MISSING_CLI.with(|flag| flag.set(true));
        run(serde_json::json!({}), "project_config_cli_missing");
        T09_MISSING_CLI.with(|flag| flag.set(false));
        write(
            serde_json::json!({"version":1,"defaults":{"adapter":"custom","command":"echo literal"}}),
        );
        approve();
        T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let project =
            serde_json::from_value(serde_json::json!({"root":root,"template":null,"overrides":{}}))
                .unwrap();
        assert_eq!(
            create_session_owner(
                None,
                &manager,
                &private,
                None,
                None,
                None,
                None,
                Some(project)
            )
            .unwrap_err(),
            "test_entry_reached_allocation"
        );
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 1);
    }
    #[test]
    fn t09_owner_entry_missing_trusted_source_never_falls_back_or_allocates() {
        for rename in [false, true] {
            let base = std::env::temp_dir().join(format!(
                "yam-t09-source-missing-{}-{}-{rename}",
                std::process::id(),
                unix_timestamp_millis()
            ));
            fs::create_dir(&base).unwrap();
            struct OwnFixture(PathBuf);
            impl Drop for OwnFixture {
                fn drop(&mut self) {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }
            let _cleanup = OwnFixture(base.clone());
            let root = base.join("project");
            let private = base.join("app-private");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&private).unwrap();
            fs::write(
                root.join("yam.json"),
                br#"{"version":1,"defaults":{"adapter":"custom","command":"echo trusted"}}"#,
            )
            .unwrap();
            let preview = project_config::preview(&root, &private).unwrap();
            project_config::trust(&root, &private, &preview).unwrap();
            let before = fs::read(private.join("project-launch.json")).unwrap();
            if rename {
                fs::rename(root.join("yam.json"), root.join("yam.moved.json")).unwrap();
            } else {
                fs::remove_file(root.join("yam.json")).unwrap();
            }
            let manager = SessionManager::default();
            let before_counter = SESSION_COUNTER.load(Ordering::Relaxed);
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let project = serde_json::from_value(
                serde_json::json!({"root":root,"template":null,"overrides":{}}),
            )
            .unwrap();
            assert_eq!(
                create_session_owner(
                    None,
                    &manager,
                    &private,
                    None,
                    None,
                    None,
                    None,
                    Some(project)
                )
                .unwrap_err(),
                "project_config_untrusted"
            );
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
            assert_eq!(SESSION_COUNTER.load(Ordering::Relaxed), before_counter);
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert_eq!(
                fs::read(private.join("project-launch.json")).unwrap(),
                before
            );
            assert_eq!(fs::read_dir(&private).unwrap().count(), 1);
        }
    }
}

#[cfg(test)]
mod f6_log_tests {
    use super::*;
    fn string_log_fixture(bytes: &[u8]) -> (HistoryStore, PathBuf, String) {
        let root = std::env::temp_dir().join(format!(
            "yam-f6-string-{}-{}",
            std::process::id(),
            next_session_id()
        ));
        let store = HistoryStore::open(root.clone()).unwrap();
        let id = "s-f6-string".to_string();
        store
            .start(&SessionSummary {
                session_id: id.clone(),
                status: "running".into(),
                cwd: root.to_string_lossy().into(),
                command: None,
                launch: None,
            })
            .unwrap();
        fs::write(store.log_path(&id), bytes).unwrap();
        (store, root, id)
    }
    #[test]
    fn f6_legacy_string_read_normal_exact_budget_and_missing_session() {
        let (store, root, id) = string_log_fixture("中文\r\n".as_bytes());
        assert_eq!(read_recorded_log_string(&store, &id).unwrap(), "中文\r\n");
        fs::write(store.log_path(&id), vec![b'x'; 8 * 1024 * 1024]).unwrap();
        assert_eq!(
            read_recorded_log_string(&store, &id).unwrap().len(),
            8 * 1024 * 1024
        );
        assert!(read_recorded_log_string(&store, "s-missing").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn f6_legacy_string_read_rejects_invalid_utf8() {
        let (store, root, id) = string_log_fixture(&[0xff]);
        let result = read_recorded_log_string(&store, &id);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap_err(), "Log encoding is invalid");
    }
    #[test]
    fn f6_legacy_string_read_rejects_oversize_before_partial_utf8() {
        let mut bytes = vec![b'x'; 8 * 1024 * 1024];
        bytes.extend_from_slice("中".as_bytes());
        let (store, root, id) = string_log_fixture(&bytes);
        let result = read_recorded_log_string(&store, &id);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap_err(), "Log exceeds its 8 MiB budget");
    }
    #[test]
    fn f6_actual_recorded_source_range_preserves_legacy_and_utf8() {
        let root = std::env::temp_dir().join(format!(
            "yam-f6-{}-{}",
            std::process::id(),
            next_session_id()
        ));
        struct Own(PathBuf);
        impl Drop for Own {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _own = Own(root.clone());
        let history = HistoryStore::open(root).unwrap();
        fs::create_dir_all(history.log_path("s-f6").parent().unwrap()).unwrap();
        fs::write(history.log_path("s-f6"), "中文").unwrap();
        let sessions = Mutex::new(HashMap::new());
        let legacy = recorded_log_source(&history, &sessions, "s-f6", 0).unwrap();
        assert_eq!(legacy.range.as_ref().unwrap().truncation, "unknown");
        assert_eq!(legacy.range.as_ref().unwrap().retained_bytes, 6);
        let known = recorded_log_source(&history, &sessions, "s-f6", 106).unwrap();
        assert_eq!(
            known.range.as_ref().unwrap().start_offset.as_deref(),
            Some("100")
        );
        let broken = recorded_log_source(&history, &sessions, "s-f6", 3).unwrap();
        assert_eq!(broken.range.as_ref().unwrap().truncation, "unknown");
        fs::write(history.log_path("s-f6"), [0xff]).unwrap();
        assert!(recorded_log_source(&history, &sessions, "s-f6", 1).is_err());
    }
}

#[cfg(test)]
mod f6_export_tests {
    use super::*;
    #[test]
    fn f6_r1_received_export_snapshot_budget_is_checked_before_assembly() {
        let root = std::env::temp_dir().join(format!(
            "yam-f6-received-{}-{}",
            std::process::id(),
            next_session_id()
        ));
        let store = HistoryStore::open(root.clone()).unwrap();
        let summary = SessionSummary {
            session_id: "s-f6-received".into(),
            status: "running".into(),
            cwd: root.to_string_lossy().into(),
            command: None,
            launch: None,
        };
        store.start(&summary).unwrap();
        let record = store.get(&summary.session_id).unwrap();
        fs::remove_dir_all(&root).unwrap();
        for raw in [false, true] {
            for supplied in [false, true] {
                for size in [8 * 1024 * 1024, 8 * 1024 * 1024 + 1] {
                    let range =
                        supplied.then(|| session_logs::retained_range(size, size as u64, true));
                    let snapshot = LogSnapshot {
                        data: "x".repeat(size),
                        offset: 0,
                        end_offset: size as u64,
                        status: "running".into(),
                        range,
                    };
                    let result = prepare_log_export(&record, snapshot, "received fixture", raw);
                    if size == 8 * 1024 * 1024 {
                        let (content, range) = result.unwrap();
                        assert!(content.starts_with("YAM recorded session output\n"));
                        assert_eq!(range.retained_bytes, size);
                    } else {
                        assert!(result.is_err(),"over-budget received snapshot must fail (raw={raw}, supplied={supplied})");
                        assert_eq!(result.err().unwrap(), "Log exceeds its 8 MiB budget");
                    }
                }
            }
        }
    }
    #[test]
    fn f6_actual_export_capture_metadata_content_and_saved_receipt_share_snapshot() {
        let root = std::env::temp_dir().join(format!(
            "yam-f6-export-{}-{}",
            std::process::id(),
            next_session_id()
        ));
        struct Own(PathBuf);
        impl Drop for Own {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _own = Own(root.clone());
        let store = HistoryStore::open(root.clone()).unwrap();
        let summary = SessionSummary {
            session_id: "s-f6-export".into(),
            status: "running".into(),
            cwd: root.to_string_lossy().into(),
            command: Some("fixture".into()),
            launch: None,
        };
        store.start(&summary).unwrap();
        let record = store.get(&summary.session_id).unwrap();
        for raw in [false, true] {
            let snapshot = LogSnapshot {
                data: "中文\n".into(),
                offset: 100,
                end_offset: 107,
                status: "running".into(),
                range: None,
            };
            let (content, range) = prepare_log_export(&record, snapshot, "captured", raw).unwrap();
            assert!(content.contains("中文"));
            assert!(content.contains("retained_range"));
            assert_eq!(range.retained_bytes, 7);
            // Legacy receiving-owner snapshot lacks new provenance: do not infer exact range.
            assert_eq!(range.truncation, "unknown");
            assert!(publish_log_export(None, &content, range.clone())
                .unwrap()
                .is_none());
            let path = root.join(if raw { "raw.txt" } else { "plain.txt" });
            let result = publish_log_export(Some(&path), &content, range)
                .unwrap()
                .unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
            assert_eq!(result.path, path.to_string_lossy());
            assert!(publish_log_export(Some(&path), "overwrite", result.range).is_err());
            assert_eq!(fs::read_to_string(path).unwrap(), content);
        }
        let source_path = store.log_path(&summary.session_id);
        fs::write(&source_path, "中文\n").unwrap();
        let captured = recorded_log_source(
            &store,
            &Mutex::new(HashMap::new()),
            &summary.session_id,
            107,
        )
        .unwrap();
        let snapshot = LogSnapshot {
            data: captured.data,
            offset: captured.offset,
            end_offset: 107,
            status: "stopped".into(),
            range: captured.range,
        };
        fs::write(source_path, "later append must not be exported").unwrap();
        let (content, range) = prepare_log_export(&record, snapshot, "captured", true).unwrap();
        assert_eq!(range.start_offset.as_deref(), Some("100"));
        assert_eq!(range.end_offset_exclusive.as_deref(), Some("107"));
        assert!(content.contains("\"100\""));
        assert!(!content.contains("later append"));
        let receipt = publish_log_export(Some(&root.join("captured.txt")), &content, range)
            .unwrap()
            .unwrap();
        assert_eq!(receipt.range.retained_bytes, 7);
    }
}
