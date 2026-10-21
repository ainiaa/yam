mod agent_bridge;
mod agent_events;
mod background;
mod browser_window;
mod claude_resume;
mod cli;
mod codex_context;
mod codex_conversation;
#[cfg(any(target_os = "macos", test))]
mod codex_outcome;
mod desktop_windows;
mod diagnostics;
mod external_terminal;
mod file_preview;
mod gemini_resume;
mod git_context;
#[cfg(target_os = "macos")]
mod gui_startup;
mod history;
mod memory;
mod native_menu;
mod project_config;
mod provider_catalog;
mod provider_launch;
#[cfg(test)]
mod provider_native_tests;
mod provider_probe;
mod session_logs;
mod shell_command_report;
mod shell_cwd;
mod ssh_launch;
mod system_entry;
mod terminal_file_actions;
mod terminal_fonts;
mod terminal_runtime;
mod updater;
mod updater_install;
mod worktree_manager;
mod zsh_directory_reporting;
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
    if let Some(result) = external_terminal::entry(&args[1..]) {
        if let Err(error) = result {
            eprintln!("[YAM] {error}");
            std::process::exit(1);
        }
        return;
    }
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
    generated_context()
}
fn generated_context<R: tauri::Runtime>() -> tauri::Context<R> {
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
#[cfg(test)]
thread_local! {static SESSION_ID_ALLOCATIONS: std::cell::Cell<u64> = const {std::cell::Cell::new(0)};}
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
#[serde(deny_unknown_fields)]
pub struct AgentLaunch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<codex_context::Options>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env_refs: std::collections::BTreeMap<String, String>,
    pub adapter: String,
    pub mode: String,
    pub extra_args: String,
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<provider_launch::ProviderConfig>,
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
    codex_context::validate(launch)?;
    if let Some(provider) = &launch.provider {
        provider.validate(&launch.adapter, &launch.extra_args)?;
    }
    if !matches!(
        launch.adapter.as_str(),
        "codex" | "claude" | "gemini" | "opencode"
    ) || !matches!(launch.mode.as_str(), "task" | "interactive")
    {
        return Err("Unknown agent or launch mode".into());
    }
    if launch.adapter == "gemini" {
        agent_bridge::validate_interactive_args("gemini", &parse_agent_args(&launch.extra_args)?)?;
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
        } else if launch.adapter == "gemini" {
            "node_modules/@google/gemini-cli/bundle/gemini.js"
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
    if let Some(provider) = &launch.provider {
        builder.args(if launch.adapter == "codex" && launch.codex.is_some() {
            codex_context::command_overrides(provider)?
        } else {
            provider.command_overrides(&launch.adapter)?
        });
    }
    if launch.mode == "task" {
        if launch.adapter == "codex" {
            builder.args(["exec", "--json"]);
        } else if launch.adapter == "claude" {
            builder.args(["--print", "--output-format", "stream-json", "--verbose"]);
        } else if launch.adapter == "gemini" {
            builder.args(["--output-format", "stream-json"]);
        } else {
            builder.args(["run", "--format", "json"]);
        }
    }
    builder.args(parse_agent_args(&launch.extra_args)?);
    if let Some(prompt) = prompt {
        if launch.adapter == "gemini" {
            builder.arg(format!(
                "{}={prompt}",
                if launch.mode == "task" {
                    "--prompt"
                } else {
                    "--prompt-interactive"
                }
            ));
        } else {
            builder.arg(
                if launch.adapter == "opencode" && launch.mode == "interactive" {
                    "--prompt"
                } else {
                    "--"
                },
            );
            builder.arg(prompt);
        }
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
        || !matches!(launch.adapter.as_str(), "codex" | "claude" | "gemini")
        || launch.mode != "interactive"
        || (launch.adapter == "codex"
            && launch.provider.is_none()
            && !launch.extra_args.trim().is_empty())
    {
        return Err(
            "Native resume supports default Codex and validated Claude / Gemini interactive sessions".into(),
        );
    }
    if let Some(provider) = &launch.provider {
        provider.validate(&launch.adapter, &launch.extra_args)?;
    }
    if matches!(launch.adapter.as_str(), "claude" | "gemini") {
        agent_bridge::validate_interactive_args(
            &launch.adapter,
            &parse_agent_args(&launch.extra_args)?,
        )?;
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

fn terminal_reopen_launch(
    record: &SessionRecord,
) -> Result<(Option<AgentLaunch>, Option<String>), String> {
    if matches!(record.status.as_str(), "starting" | "running") {
        return Err("This terminal is already running".into());
    }
    validate_working_directory(&record.summary.cwd)?;
    if record.summary.command.is_none()
        && record
            .summary
            .launch
            .as_ref()
            .is_some_and(|launch| launch.mode == "interactive")
    {
        let (_, launch, native) = resume_record_source(record.clone())?;
        Ok((Some(launch), Some(native)))
    } else {
        Ok((None, None))
    }
}
fn resume_command(
    executable: &Path,
    launch: &AgentLaunch,
    id: &str,
) -> Result<CommandBuilder, String> {
    if !valid_resume_id(id)
        || !matches!(launch.adapter.as_str(), "codex" | "claude" | "gemini")
        || launch.mode != "interactive"
        || (launch.adapter == "codex"
            && launch.provider.is_none()
            && !launch.extra_args.trim().is_empty())
        || launch.prompt.is_some()
    {
        return Err("Invalid native resume request".into());
    }
    let mut command = agent_command(executable, launch)?;
    if matches!(launch.adapter.as_str(), "claude" | "gemini") {
        agent_bridge::validate_interactive_args(
            &launch.adapter,
            &parse_agent_args(&launch.extra_args)?,
        )?;
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
            (Some("gemini"), Some("result"))
                if matches!(value["status"].as_str(), Some("success" | "error")) =>
            {
                let succeeded = value["status"] == "success";
                self.phase = if succeeded { "completed" } else { "failed" }.into();
                self.outcome = Some(if succeeded { "succeeded" } else { "failed" }.into());
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<ssh_launch::SshLaunch>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
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

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct CreateSessionReply {
    #[serde(flatten)]
    summary: SessionSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reopened_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    directory_reporting_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command_reporting_warning: Option<String>,
}

#[derive(Clone)]
struct PendingSessionFinish {
    event: SessionStateEvent,
    published: bool,
}

struct Session {
    _directory_reporting_assets: Option<zsh_directory_reporting::Assets>,
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
    pending_finish: Mutex<Option<PendingSessionFinish>>,
    #[cfg(test)]
    exit_observation_fault: Option<Arc<std::sync::atomic::AtomicUsize>>,
    cleanup_done: AtomicBool,
    #[cfg(unix)]
    process_identity: Option<(u32, u64)>,
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
    let result = memory_usage_with(
        &SAMPLING,
        move || memory_processes(&app.state()),
        memory::sample,
    )
    .await;
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
    command_reporting: bool,
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
    #[serde(
        default,
        deserialize_with = "deserialize_clear_display_version",
        skip_serializing_if = "Option::is_none"
    )]
    clear_display_version: Option<u8>,
    projection: serde_json::Value,
    end_offset: u64,
    status: String,
    #[serde(default)]
    persisted: bool,
    #[serde(
        default,
        deserialize_with = "shell_cwd::deserialize_report",
        skip_serializing_if = "Option::is_none"
    )]
    reported_cwd: Option<shell_cwd::ReportedCwd>,
    #[serde(
        default,
        deserialize_with = "shell_command_report::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    reported_command: Option<shell_command_report::ReportedCommand>,
    #[serde(
        default,
        deserialize_with = "shell_command_report::deserialize_navigation",
        skip_serializing_if = "Option::is_none"
    )]
    reported_prompt_navigation: Option<shell_command_report::PromptNavigation>,
}
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ClearDisplayStatus {
    Cleared,
    Unavailable,
    Stale,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct ClearDisplayReply {
    status: ClearDisplayStatus,
}
fn deserialize_clear_display_version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u8>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok((value.as_u64() == Some(1)).then_some(1))
}
fn take_clear_display_version(projection: &mut serde_json::Value) -> Option<u8> {
    projection
        .as_object_mut()?
        .remove("clear_display_version")
        .and_then(|v| (v.as_u64() == Some(1)).then_some(1))
}
fn clear_display_instance(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn clear_display_preflight(
    snapshot: &mut serde_json::Value,
    id: &str,
    expected: &str,
) -> Result<Option<ClearDisplayReply>, String> {
    terminal_runtime::validate_snapshot(snapshot, id, None)?;
    if snapshot.get("instance").and_then(serde_json::Value::as_str) != Some(expected) {
        return Ok(Some(ClearDisplayReply {
            status: ClearDisplayStatus::Stale,
        }));
    }
    let supported = take_clear_display_version(snapshot) == Some(1);
    if !supported || snapshot.get("buffer").and_then(serde_json::Value::as_str) != Some("normal") {
        return Ok(Some(ClearDisplayReply {
            status: ClearDisplayStatus::Unavailable,
        }));
    }
    Ok(None)
}
fn clear_terminal_display(
    manager: State<'_, SessionManager>,
    session_id: String,
    expected_instance: String,
) -> Result<ClearDisplayReply, String> {
    if !clear_display_instance(&expected_instance) {
        return Err("Invalid terminal clear".into());
    }
    proxy!(
        manager,
        "clear_terminal_display",
        serde_json::json!({"session_id":session_id,"expected_instance":expected_instance})
    );
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(&session_id)
        .cloned()
        .ok_or("Unknown live terminal")?;
    let status = session
        .status
        .lock()
        .map_err(|_| "Session status lock poisoned")?;
    let _log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    let unavailable = || ClearDisplayReply {
        status: ClearDisplayStatus::Unavailable,
    };
    if !matches!(status.as_str(), "starting" | "running") {
        return Ok(unavailable());
    }
    let Some(terminal) = session.terminal.as_ref() else {
        return Ok(unavailable());
    };
    let mut snapshot = terminal
        .runtime
        .call("snapshot", &session_id, serde_json::json!({}))?;
    if let Some(reply) = clear_display_preflight(&mut snapshot, &session_id, &expected_instance)? {
        return Ok(reply);
    }
    let reply = terminal.runtime.call(
        "clear_display",
        &session_id,
        serde_json::json!({"expected_instance":expected_instance}),
    )?;
    serde_json::from_value(reply).map_err(|_| "Invalid terminal clear reply".into())
}
fn active_frame(session: &Session) -> Result<TerminalFrame, String> {
    let status = session
        .status
        .lock()
        .map_err(|_| "Session status lock poisoned")?;
    frame_for_status(session, &status)
}

fn frame_for_status(session: &Session, status: &str) -> Result<TerminalFrame, String> {
    frame_for_status_with(session, status, false, |_| Ok(()))
}

fn frame_for_status_with(
    session: &Session,
    status: &str,
    stream: bool,
    ready: impl FnOnce(&SessionLog) -> Result<(), String>,
) -> Result<TerminalFrame, String> {
    let terminal = session
        .terminal
        .as_ref()
        .ok_or("No persistent terminal parser owns this session")?;
    let log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    let mut projection = terminal.runtime.call(
        if stream {
            "stream_snapshot"
        } else {
            "snapshot"
        },
        &session.summary.session_id,
        serde_json::json!({}),
    )?;
    // The stream handoff and its snapshot offset share the output/log lock.
    ready(&log)?;
    let clear_display_version = take_clear_display_version(&mut projection);
    let navigation = shell_command_report::take_navigation(&mut projection);
    let command_report = shell_command_report::take(&mut projection);
    let report = shell_cwd::take_report(&mut projection, shell_cwd::current_platform());
    Ok(TerminalFrame {
        clear_display_version: if !is_terminal(status) {
            clear_display_version
        } else {
            None
        },
        reported_prompt_navigation: if terminal.command_reporting && !is_terminal(status) {
            navigation
        } else {
            None
        },
        reported_command: if terminal.command_reporting && !is_terminal(status) {
            command_report
        } else {
            None
        },
        reported_cwd: if is_terminal(status) { None } else { report },
        projection,
        end_offset: log.end_offset,
        status: status.to_owned(),
        persisted: false,
    })
}
fn prompt_navigation_preflight(
    snapshot: &mut serde_json::Value,
    session_id: &str,
    direction: &str,
    expected_instance: &str,
) -> Result<Option<shell_command_report::NavigationReply>, String> {
    terminal_runtime::validate_snapshot(snapshot, session_id, None)?;
    if snapshot.get("instance").and_then(serde_json::Value::as_str) != Some(expected_instance) {
        return Ok(Some(shell_command_report::NavigationReply {
            status: shell_command_report::NavigationStatus::Stale,
        }));
    }
    let navigation = shell_command_report::take_navigation(snapshot);
    if snapshot.get("buffer").and_then(serde_json::Value::as_str) != Some("normal")
        || navigation.is_none_or(|value| {
            if direction == "previous" {
                !value.previous
            } else {
                !value.next
            }
        })
    {
        return Ok(Some(shell_command_report::NavigationReply {
            status: shell_command_report::NavigationStatus::Unavailable,
        }));
    }
    Ok(None)
}
fn navigate_reported_prompt(
    manager: State<'_, SessionManager>,
    session_id: String,
    direction: String,
    expected_instance: String,
) -> Result<shell_command_report::NavigationReply, String> {
    if !shell_command_report::navigation_arguments(&direction, &expected_instance) {
        return Err("Invalid reported prompt navigation".into());
    }
    proxy!(
        manager,
        "navigate_reported_prompt",
        serde_json::json!({"session_id":session_id,"direction":direction,"expected_instance":expected_instance})
    );
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(&session_id)
        .cloned()
        .ok_or("Unknown live terminal")?;
    let status = session
        .status
        .lock()
        .map_err(|_| "Session status lock poisoned")?;
    let _log = session
        .log
        .lock()
        .map_err(|_| "Session log lock poisoned")?;
    let unavailable = || shell_command_report::NavigationReply {
        status: shell_command_report::NavigationStatus::Unavailable,
    };
    let Some(terminal) = session.terminal.as_ref() else {
        return Ok(unavailable());
    };
    if is_terminal(&status) || !terminal.command_reporting {
        return Ok(unavailable());
    }
    let mut snapshot = terminal
        .runtime
        .call("snapshot", &session_id, serde_json::json!({}))?;
    if let Some(reply) =
        prompt_navigation_preflight(&mut snapshot, &session_id, &direction, &expected_instance)?
    {
        return Ok(reply);
    }
    let reply = terminal.runtime.call(
        "navigate_prompt",
        &session_id,
        serde_json::json!({"direction":direction,"expected_instance":expected_instance}),
    )?;
    serde_json::from_value(reply).map_err(|_| "Invalid prompt navigation reply".into())
}
fn set_terminal_viewport(
    manager: State<'_, SessionManager>,
    session_id: String,
    line: u32,
    bottom: Option<bool>,
) -> Result<(), String> {
    proxy!(
        manager,
        "set_terminal_viewport",
        serde_json::json!({"session_id":session_id,"line":line,"bottom":bottom.unwrap_or(false)})
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
        .call(
            "viewport",
            &session_id,
            serde_json::json!({"line":line,"bottom":bottom.unwrap_or(false)}),
        )?;
    Ok(())
}
fn save_final_frame(session: &Session, status: &str) -> Result<(), String> {
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
    let frame = frame_for_status(session, status)?;
    let bytes = encode_final_frame(frame)?;
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
fn encode_final_frame(mut frame: TerminalFrame) -> Result<Vec<u8>, String> {
    frame.clear_display_version = None;
    frame.reported_cwd = None;
    frame.reported_command = None;
    frame.reported_prompt_navigation = None;
    if let Some(projection) = frame.projection.as_object_mut() {
        projection.remove("cwd_report");
        projection.remove("command_report");
        projection.remove("prompt_navigation");
        projection.remove("clear_display_version");
    }
    serde_json::to_vec(&frame).map_err(|_| "Cannot encode final terminal frame".into())
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

fn read_terminal_frame<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid final terminal frame")?;
    if let Some(frame) = value.as_object_mut() {
        frame.remove("reported_cwd");
        frame.remove("reported_command");
        frame.remove("reported_prompt_navigation");
        frame.remove("clear_display_version");
    }
    if let Some(projection) = value
        .get_mut("projection")
        .and_then(serde_json::Value::as_object_mut)
    {
        projection.remove("cwd_report");
        projection.remove("command_report");
        projection.remove("prompt_navigation");
        projection.remove("clear_display_version");
    }
    let mut frame: TerminalFrame =
        serde_json::from_value(value).map_err(|_| "Invalid final terminal frame")?;
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
    background_events: Mutex<background::EventPoll>,
    relay: Mutex<background::Relay>,
    input_leases: Mutex<background::InputLeases>,
    started: Instant,
    desktop_focus: Mutex<(Instant, bool)>,
    desktop_connected: AtomicBool,
    desktop_foreground: AtomicBool,
    desktop_windows: Arc<Mutex<desktop_windows::Table>>,
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
            background_events: Mutex::new(background::EventPoll::default()),
            relay: Mutex::new(background::Relay::default()),
            input_leases: Mutex::new(background::InputLeases::default()),
            started: Instant::now(),
            desktop_focus: Mutex::new((Instant::now(), false)),
            desktop_connected: AtomicBool::new(false),
            desktop_foreground: AtomicBool::new(false),
            desktop_windows: Arc::new(Mutex::new(desktop_windows::Table::default())),
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
    #[cfg(test)]
    fn shutdown(&self) -> Result<(), String> {
        self.shutdown_with(|session| {
            if session
                .pending_finish
                .lock()
                .map_err(|_| "Session finalization lock poisoned")?
                .is_some()
            {
                return Err(
                    "Session persistence is incomplete; the application remains open".into(),
                );
            }
            Ok(())
        })
    }
    fn shutdown_for<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        native_notify: impl Fn(&AppHandle<R>, &str, &str),
    ) -> Result<(), String> {
        self.shutdown_with(|session| {
            finish_session_with(app, &self.sessions, session, None, &native_notify)
        })
    }
    fn shutdown_with(
        &self,
        retry_finish: impl Fn(&Session) -> Result<(), String>,
    ) -> Result<(), String> {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned".to_string())?
            .values()
            .cloned()
            .collect();
        for session in &sessions {
            retry_finish(session)?;
            if !*session
                .completed
                .0
                .lock()
                .map_err(|_| "Completion lock poisoned")?
            {
                request_session_stop(session)?;
            }
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

    fn history<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<HistoryStore>, String> {
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
        history.configure_agent_version(
            id,
            &prepared.generation,
            prepared.cli_version.as_deref(),
        )?;
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

pub(crate) fn route_notification_session<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<(), String> {
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
    let slot = desktop_windows::owning_slot(app, session_id);
    desktop_windows::show_slot(app, slot)?;
    app.emit_to(slot.label(), "session-notification-click", session_id)
        .map_err(|error| error.to_string())
}

pub(crate) fn route_notification_link<R: tauri::Runtime>(
    app: &AppHandle<R>,
    link: &str,
) -> Result<(), String> {
    let id = session_id_from_link(link).ok_or_else(|| "Invalid session link".to_string())?;
    route_notification_session(app, &id)
}

async fn memory_usage_with(
    gate: &'static Mutex<()>,
    mut owners: impl FnMut() -> Result<memory::OwnerProcesses, String> + Send + 'static,
    sample: impl FnOnce(&memory::OwnerProcesses) -> Result<memory::Sample, String> + Send + 'static,
) -> Result<memory::Sample, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _sampling = gate
            .try_lock()
            .map_err(|_| "Memory sampling already in progress")?;
        let before = owners()?;
        let sample = sample(&before)?;
        if owners()? != before {
            return Err("Task membership changed during memory sampling".into());
        }
        Ok(sample)
    })
    .await
    .map_err(|_| "Memory sampling worker failed")?
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
    #[cfg(test)]
    SESSION_ID_ALLOCATIONS.with(|count| count.set(count.get() + 1));
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

#[cfg(all(test, unix))]
mod terminal_environment_tests;

#[cfg(unix)]
fn configure_terminal_environment(builder: &mut CommandBuilder) {
    // Launchers may omit TERM or inherit dumb, which disables zsh's terminal key bindings.
    if builder
        .get_env("TERM")
        .is_none_or(|value| value.is_empty() || value == "dumb")
    {
        builder.env("TERM", "xterm-256color");
    }
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

// Nullable fields are still required; old clients omit the entire shell option.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShellLaunch {
    #[serde(deserialize_with = "required_nullable")]
    pub program: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub login: Option<bool>,
}
fn validate_shell_launch(shell: &ShellLaunch) -> Result<(), String> {
    if cfg!(windows) != shell.login.is_none() {
        return Err("shell_invalid".into());
    }
    if let Some(program) = &shell.program {
        if program.trim().is_empty()
            || program.len() > 4096
            || program
                .chars()
                .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            || !Path::new(program).is_absolute()
        {
            return Err("shell_invalid".into());
        }
    }
    Ok(())
}
fn owner_default_shell() -> std::ffi::OsString {
    #[cfg(windows)]
    {
        std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
    }
}
fn ordinary_shell_command(
    shell: &ShellLaunch,
    default: impl FnOnce() -> std::ffi::OsString,
) -> Result<CommandBuilder, String> {
    validate_shell_launch(shell)?;
    let program = shell
        .program
        .as_ref()
        .map(std::ffi::OsString::from)
        .unwrap_or_else(default);
    let literal = program.to_str().ok_or("shell_invalid")?;
    if literal.trim().is_empty()
        || literal.len() > 4096
        || literal
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err("shell_invalid".into());
    }
    let path = Path::new(&program);
    #[cfg(not(windows))]
    let supported = path
        .file_name()
        .is_some_and(|name| matches!(name.to_str(), Some("bash" | "zsh" | "fish")));
    #[cfg(windows)]
    let supported = path.file_name().is_some_and(|name| {
        name.to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
    });
    if !supported {
        return Err("shell_unsupported".into());
    }
    #[cfg(windows)]
    let program = if shell.program.is_none() && program == std::ffi::OsStr::new("cmd.exe") {
        // Only the existing system fallback uses native PATH, never Agent PATH or PATHEXT.
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join("cmd.exe"))
            .find(|candidate| candidate.is_absolute() && candidate.is_file())
            .ok_or("shell_unavailable")?
            .into_os_string()
    } else {
        program
    };
    let path = Path::new(&program);
    if !path.is_absolute() {
        return Err("shell_invalid".into());
    }
    let metadata = path.metadata().map_err(|_| "shell_unavailable")?;
    if !metadata.is_file() {
        return Err("shell_unavailable".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("shell_unavailable".into());
        }
    }
    let mut builder = CommandBuilder::new(program);
    #[cfg(windows)]
    builder.arg("/D");
    #[cfg(not(windows))]
    {
        builder.arg("-i");
        if shell.login == Some(true) {
            builder.arg("-l");
        }
    }
    Ok(builder)
}
fn terminal_create_arguments(retained_lines: u16) -> serde_json::Value {
    let mut fields = serde_json::json!({"cols":100,"rows":24});
    if retained_lines != 2000 {
        fields["retained_lines"] = serde_json::json!(retained_lines);
    }
    fields
}
fn terminal_retained_lines(value: Option<u16>, ordinary: bool) -> Result<u16, String> {
    let lines = value.unwrap_or(2000);
    if !(200..=2000).contains(&lines) || (!ordinary && lines != 2000) {
        return Err("terminal_retention_invalid".into());
    }
    Ok(lines)
}
#[allow(clippy::too_many_arguments)]
fn create_session_arguments(
    cwd: &Option<String>,
    command: &Option<String>,
    launch: &Option<AgentLaunch>,
    resume_from: &Option<String>,
    project_config: &Option<project_config::ProjectStart>,
    worktree_attempt: &Option<String>,
    shell: &Option<ShellLaunch>,
    env_refs: &Option<std::collections::BTreeMap<String, String>>,
    retained_lines: &Option<u16>,
    ssh: &Option<ssh_launch::SshLaunch>,
    directory_reporting: &Option<bool>,

    command_reporting: &Option<bool>,
) -> Result<serde_json::Value, String> {
    let standalone_ssh = ssh_launch::standalone(
        ssh.as_ref(),
        command.is_some()
            || launch.is_some()
            || resume_from.is_some()
            || project_config.is_some()
            || worktree_attempt.is_some()
            || shell.is_some()
            || env_refs.as_ref().is_some_and(|v| !v.is_empty())
            || *directory_reporting == Some(true)
            || *command_reporting == Some(true),
    )?;
    terminal_retained_lines(
        *retained_lines,
        command.is_none()
            && launch.is_none()
            && resume_from.is_none()
            && project_config.is_none()
            && worktree_attempt.is_none()
            || standalone_ssh,
    )?;
    zsh_directory_reporting::validate(
        command_reporting.unwrap_or(false),
        ssh.is_none()
            && command.is_none()
            && launch.is_none()
            && resume_from.is_none()
            && project_config.is_none()
            && worktree_attempt.is_none(),
        shell.as_ref(),
        cfg!(windows),
    )
    .map_err(|_| "command_reporting_invalid_combination")?;
    let mut arguments =
        serde_json::json!({"cwd":cwd,"command":command,"launch":launch,"resume_from":resume_from});
    if launch
        .as_ref()
        .is_some_and(|launch| launch.provider.is_some() || !launch.env_refs.is_empty())
        || resume_from.is_some()
        || project_config.is_some()
    {
        arguments["provider_protocol"] = serde_json::json!(provider_launch::PROTOCOL_VERSION);
    }
    if let Some(project) = project_config {
        arguments["project_config"] =
            serde_json::to_value(project).map_err(|_| "project_config_invalid")?;
    }
    if let Some(attempt) = worktree_attempt {
        arguments["worktree_attempt"] = serde_json::json!(attempt);
    }
    if let Some(shell) = shell {
        arguments["shell"] = serde_json::to_value(shell).map_err(|_| "shell_invalid")?;
    }
    if let Some(refs) = env_refs.as_ref().filter(|refs| !refs.is_empty()) {
        arguments["env_refs"] = serde_json::json!(refs);
    }
    if let Some(lines) = retained_lines {
        arguments["retained_lines"] = serde_json::json!(lines);
    }
    if let Some(ssh) = ssh {
        arguments["ssh"] = serde_json::to_value(ssh).map_err(|_| "ssh_invalid")?;
    }
    if *command_reporting == Some(true) {
        arguments["command_reporting"] = serde_json::json!(true);
    }
    Ok(arguments)
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
            codex: None,
            provider: None,
            env_refs: Default::default(),
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

#[tauri::command]
fn provider_protocol_version() -> u8 {
    provider_launch::PROTOCOL_VERSION
}

fn agent_adapters() -> Vec<AgentAdapter> {
    [
        ("shell", "System shell", None),
        ("codex", "OpenAI Codex", Some("codex")),
        ("claude", "Claude Code", Some("claude")),
        ("gemini", "Gemini CLI", Some("gemini")),
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
fn system_ps_path(candidates: &[&Path]) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    candidates
        .iter()
        .find_map(|path| {
            if !path.is_absolute() {
                return None;
            }
            let metadata = std::fs::metadata(path).ok()?;
            (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .then(|| path.to_path_buf())
        })
        .ok_or_else(|| "A system ps executable is required to inspect session process trees".into())
}

#[cfg(unix)]
fn process_tree(root: u32) -> Result<Vec<u32>, String> {
    let output = std::process::Command::new(system_ps_path(&[
        Path::new("/bin/ps"),
        Path::new("/usr/bin/ps"),
    ])?)
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

#[cfg(unix)]
fn verified_session_root_with(
    expected: Option<(u32, u64)>,
    pid: u32,
    read_identity: impl FnOnce(u32) -> Result<Option<u64>, String>,
) -> Result<u32, String> {
    let (original, stamp) = expected.ok_or("Session process identity unavailable")?;
    if pid <= 1 || pid > i32::MAX as u32 || pid != original {
        return Err("Session process identity changed".into());
    }
    if read_identity(pid)?.is_some_and(|current| current != stamp) {
        return Err("Session process identity changed".into());
    }
    Ok(pid)
}

#[cfg(unix)]
fn verified_session_root(session: &Session, pid: u32) -> Result<u32, String> {
    verified_session_root_with(session.process_identity, pid, |pid| {
        if let Some(stamp) = memory::process_identity(pid) {
            return Ok(Some(stamp));
        }
        if unsafe { libc::getsid(pid as i32) } < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(None);
        }
        Err("Session process identity unavailable".into())
    })
}

#[cfg(unix)]
fn exited_session_targets(
    root: u32,
    candidates: &[u32],
    mut session_id: impl FnMut(u32) -> Option<u32>,
) -> Vec<u32> {
    candidates
        .iter()
        .copied()
        .filter(|pid| *pid != root && session_id(*pid) == Some(root))
        .collect()
}

#[cfg(unix)]
fn cleanup_session_members_with(
    mut members: impl FnMut() -> Result<Vec<u32>, String>,
    mut signal: impl FnMut(u32, i32) -> Result<bool, String>,
) -> Result<(), String> {
    let mut stopped = Vec::new();
    let result = (|| {
        for pid in members()? {
            if signal(pid, libc::SIGSTOP)? {
                stopped.push(pid);
            }
        }
        for pid in members()?.into_iter().rev() {
            signal(pid, libc::SIGKILL)?;
        }
        Ok(())
    })();
    if result.is_err() {
        for pid in stopped {
            let _ = signal(pid, libc::SIGCONT);
        }
    }
    result
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
        verified_session_root(session, root)?;
        // shortcut: a dead leader's SID fences members; native session handles are needed to eliminate SID generation reuse races.
        let members = || -> Result<Vec<u32>, String> {
            verified_session_root(session, root)?;
            Ok(exited_session_targets(root, &process_tree(root)?, |pid| {
                u32::try_from(unsafe { libc::getsid(pid as i32) }).ok()
            }))
        };
        cleanup_session_members_with(members, |pid, signal| {
            verified_session_root(session, root)?;
            if unsafe { libc::getsid(pid as i32) } != root as i32 {
                return Ok(false);
            }
            signal_process(pid, signal)?;
            Ok(true)
        })?;
    }
    #[cfg(windows)]
    if let Some(job) = &session.job {
        job.terminate()?;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = session;
    Ok(())
}

fn session_has_exited(session: &Session) -> Result<bool, String> {
    #[cfg(test)]
    if let Some(remaining) = &session.exit_observation_fault {
        if remaining
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err("owned child wait refusal".into());
        }
    }
    let mut child = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?;
    #[cfg(target_os = "macos")]
    if !*session
        .output_done
        .0
        .lock()
        .map_err(|_| "Output completion lock poisoned")?
    {
        if let Some(pid) = child.process_id() {
            // Darwin waitpid and even waitid(WNOWAIT) can discard unread PTY bytes.
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid as i32,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if read == size {
                return Ok(info.pbi_status == libc::SZOMB);
            }
            let error = std::io::Error::last_os_error();
            // libproc does not expose BSD info for an exited/zombie child.
            if read == 0 && error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(true);
            }
            return Err("Session process state is unavailable".into());
        }
    }
    child
        .try_wait()
        .map(|status| status.is_some())
        .map_err(|error| error.to_string())
}

fn terminate_session(session: &Session) -> Result<(), String> {
    if session_has_exited(session)? {
        return Ok(());
    }
    let child = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?;
    #[cfg(unix)]
    let pid = verified_session_root(
        session,
        child.process_id().ok_or("Session has no process ID")?,
    )?;
    #[cfg(not(unix))]
    let pid = child
        .process_id()
        .ok_or_else(|| "Session has no process ID".to_string())?;
    #[cfg(unix)]
    {
        verified_session_root(session, pid)?;
        signal_process(pid, libc::SIGSTOP)?;
        let mut stopped = vec![pid];
        let result: Result<(), String> = (|| {
            // Freeze descendants before killing parents so job-control groups cannot escape.
            for _ in 0..8 {
                verified_session_root(session, pid)?;
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
        let mut child = child;
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

    let exited = session_has_exited(session)?;
    if exited {
        cleanup_session_descendants(session)?;
        return Ok(());
    }
    session.stop_requested.store(true, Ordering::Release);
    match terminate_session(session) {
        Ok(()) => Ok(()),
        Err(error) => {
            let exited = session_has_exited(session)?;
            if exited {
                Ok(())
            } else {
                session.stop_requested.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
}

fn emit_state_with<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session: &Session,
    status: &str,
    exit_code: Option<u32>,
    reason: Option<String>,
    native_notify: impl FnOnce(&AppHandle<R>, &str, &str),
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
    publish_session_state(app, event, native_notify);
    true
}

fn publish_session_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: SessionStateEvent,
    native_notify: impl FnOnce(&AppHandle<R>, &str, &str),
) {
    if let Ok(mut table) = app.state::<SessionManager>().desktop_windows.lock() {
        table.note_status(&event.session_id, &event.status);
    }
    let _ = app.emit("session-state", &event);
    native_notify(app, &event.session_id, &event.status);
}

#[derive(Serialize)]
struct OutputStages {
    version: u8,
    read_count: u64,
    read_bytes: u64,
    read_min: u64,
    read_max: u64,
    read_buckets: [u64; 4],
    publish_count: u64,
    publish_bytes: u64,
    read_errors: u64,
    overflow: bool,
    log_wait: terminal_runtime::StageDuration,
    parser_total: terminal_runtime::StageDuration,
    append: terminal_runtime::StageDuration,
    emit: terminal_runtime::StageDuration,
    parser: terminal_runtime::CallStages,
}
impl Default for OutputStages {
    fn default() -> Self {
        Self {
            version: 1,
            read_count: 0,
            read_bytes: 0,
            read_min: 0,
            read_max: 0,
            read_buckets: [0; 4],
            publish_count: 0,
            publish_bytes: 0,
            read_errors: 0,
            overflow: false,
            log_wait: Default::default(),
            parser_total: Default::default(),
            append: Default::default(),
            emit: Default::default(),
            parser: Default::default(),
        }
    }
}
fn output_stage_enabled(developer: bool, owner: bool, value: Option<&str>) -> bool {
    developer && owner && value == Some("1")
}

fn publish_output<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session: &Session,
    data: String,
    mut stages: Option<&mut OutputStages>,
) {
    if data.is_empty() {
        return;
    }
    if let Some(row) = stages.as_deref_mut() {
        terminal_runtime::stage_add(&mut row.publish_count, 1, &mut row.overflow);
        terminal_runtime::stage_add(&mut row.publish_bytes, data.len() as u64, &mut row.overflow);
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
    let started = stages.as_ref().map(|_| Instant::now());
    let locked = session.log.lock();
    if let (Some(row), Some(started)) = (stages.as_deref_mut(), started) {
        row.log_wait
            .finish(started, locked.is_err(), &mut row.overflow);
    }
    let Ok(mut log) = locked else {
        return;
    };
    if let Some(terminal) = session.terminal.as_ref() {
        let started = stages.as_ref().map(|_| Instant::now());
        let result = if let Some(row) = stages.as_deref_mut() {
            terminal.runtime.output_observed(
                &session.summary.session_id,
                data.as_bytes(),
                Some(&mut row.parser),
            )
        } else {
            terminal
                .runtime
                .output(&session.summary.session_id, data.as_bytes())
        };
        if let (Some(row), Some(started)) = (stages.as_deref_mut(), started) {
            row.parser_total
                .finish(started, result.is_err(), &mut row.overflow);
        }
        if let Err(error) = result {
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
    let started = stages.as_ref().map(|_| Instant::now());
    let appended = append_log(&mut log.file, data.as_bytes(), MAX_SESSION_LOG_BYTES);
    if let (Some(row), Some(started)) = (stages.as_deref_mut(), started) {
        row.append
            .finish(started, appended.is_err(), &mut row.overflow);
    }
    if let Err(error) = appended {
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
    let started = stages.as_ref().map(|_| Instant::now());
    let emitted = app.emit(
        "session-output",
        SessionOutput {
            session_id: session.summary.session_id.clone(),
            data,
            offset,
            end_offset: log.end_offset,
        },
    );
    if let (Some(row), Some(started)) = (stages, started) {
        row.emit
            .finish(started, emitted.is_err(), &mut row.overflow);
    }
}

// A failed durable step keeps this exact outcome for the existing shutdown retry.
fn finish_session_with<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
    session: &Session,
    event: Option<SessionStateEvent>,
    native_notify: impl FnOnce(&AppHandle<R>, &str, &str),
) -> Result<(), String> {
    let mut pending = match session.pending_finish.try_lock() {
        Ok(pending) => pending,
        Err(std::sync::TryLockError::WouldBlock) if event.is_none() => return Ok(()),
        Err(_) => {
            return Err(
                "Session finalization lock unavailable; the application remains open".into(),
            )
        }
    };
    if pending.is_none() {
        *pending = event.map(|event| PendingSessionFinish {
            event,
            published: false,
        });
    }
    let Some(finish) = pending.as_mut() else {
        return Ok(());
    };
    if !finish.published {
        if !session.cleanup_done.load(Ordering::Acquire) {
            terminate_session(session)?;
            cleanup_session_descendants(session)?;
            session.cleanup_done.store(true, Ordering::Release);
        }
        if !*session
            .output_done
            .0
            .lock()
            .map_err(|_| "Output completion lock poisoned")?
        {
            return Err("Terminal output is still draining; the application remains open".into());
        }
        // The reader is finished; native reaping can no longer discard output.
        if session
            .child
            .lock()
            .map_err(|_| "Child lock poisoned")?
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err("Session process is still running; the application remains open".into());
        }
        let status_poisoned = session.status.is_poisoned();
        let (offset, output_error) = {
            let log = session
                .log
                .lock()
                .map_err(|_| "Session log lock poisoned; the application remains open")?;
            (log.end_offset, log.error.clone())
        };
        if let Some(error) = output_error.as_ref() {
            finish.event.status = "failed".into();
            finish.event.reason = Some(error.clone());
        }
        if status_poisoned {
            finish.event.status = "failed".into();
            finish.event.reason = Some("Session status lock poisoned".into());
        }
        let event = &finish.event;
        session.history.update(
            &event.session_id,
            &event.status,
            event.exit_code,
            event.reason.clone(),
            Some(offset),
        )?;
        if output_error.is_none() {
            save_final_frame(session, &event.status)?;
        }
        {
            let active = sessions
                .lock()
                .map_err(|_| "Session manager lock poisoned")?;
            let completed = session
                .completed
                .0
                .lock()
                .map_err(|_| "Completion lock poisoned")?;
            if *completed
                || active
                    .get(&event.session_id)
                    .is_none_or(|owned| !std::ptr::eq(owned.as_ref(), session))
            {
                return Err("Session completion ownership changed".into());
            }
            let mut status = session
                .status
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *status = event.status.clone();
            if status_poisoned {
                session.status.clear_poison();
            }
        }
        // Keep active/incomplete while publishing; a later lock failure must not republish.
        publish_session_state(app, finish.event.clone(), native_notify);
        finish.published = true;
    }
    {
        let mut active = sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned")?;
        let mut completed = session
            .completed
            .0
            .lock()
            .map_err(|_| "Completion lock poisoned")?;
        if active
            .get(&finish.event.session_id)
            .is_none_or(|owned| !std::ptr::eq(owned.as_ref(), session))
        {
            return Err("Session completion ownership changed".into());
        }
        active.remove(&finish.event.session_id);
        *completed = true;
        pending.take();
    }
    session.completed.1.notify_all();
    Ok(())
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
fn run_output_worker<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session: &Session,
    reader: &mut dyn Read,
    mut ready: impl FnMut() -> std::io::Result<bool>,
    mut stages: Option<OutputStages>,
    summary: impl FnOnce(&OutputStages),
) {
    let mut buffer = [0_u8; 4096];
    let mut decoder = Utf8Decoder::default();
    let mut output_error = None;
    loop {
        match ready() {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) => {
                if let Some(row) = stages.as_mut() {
                    terminal_runtime::stage_add(&mut row.read_errors, 1, &mut row.overflow);
                }
                output_error = Some(format!("Terminal poll failed: {error}"));
                break;
            }
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                if let Some(row) = stages.as_mut() {
                    let size = size as u64;
                    terminal_runtime::stage_add(&mut row.read_count, 1, &mut row.overflow);
                    terminal_runtime::stage_add(&mut row.read_bytes, size, &mut row.overflow);
                    row.read_min = if row.read_min == 0 {
                        size
                    } else {
                        row.read_min.min(size)
                    };
                    row.read_max = row.read_max.max(size);
                    let bucket = if size <= 256 {
                        0
                    } else if size <= 1024 {
                        1
                    } else if size <= 2048 {
                        2
                    } else {
                        3
                    };
                    terminal_runtime::stage_add(
                        &mut row.read_buckets[bucket],
                        1,
                        &mut row.overflow,
                    );
                }
                if let Ok(mut activity) = session.last_activity.lock() {
                    *activity = Instant::now();
                }
                publish_output(app, session, decoder.push(&buffer[..size]), stages.as_mut());
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
                if let Some(row) = stages.as_mut() {
                    terminal_runtime::stage_add(&mut row.read_errors, 1, &mut row.overflow);
                }
                output_error = Some(format!("Failed to read terminal output: {error}"));
                break;
            }
        }
    }
    publish_output(app, session, decoder.finish(), stages.as_mut());
    if let Some(error) = output_error {
        if let Ok(mut log) = session.log.lock() {
            log.error.get_or_insert_with(|| error.clone());
        }
        let _ = app.emit(
            "session-error",
            SessionMessage {
                session_id: session.summary.session_id.clone(),
                data: error,
            },
        );
    }
    if let Ok(mut protocol) = session.protocol.lock() {
        protocol.finish();
    }
    if let Ok(mut done) = session.output_done.0.lock() {
        *done = true;
        session.output_done.1.notify_all();
    }
    // Byte-bounded developer stderr may still block; never delay the drain barrier for it.
    if let Some(stages) = stages.as_ref() {
        summary(stages);
    }
}

fn spawn_session_threads(
    app: &AppHandle,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    session: Arc<Session>,
    reader: Box<dyn Read + Send>,
) {
    let _ =
        spawn_session_threads_with(app, sessions, session, reader, background::notify_lifecycle);
}

fn spawn_session_threads_with<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    session: Arc<Session>,
    mut reader: Box<dyn Read + Send>,
    native_notify: impl Fn(&AppHandle<R>, &str, &str) + Send + 'static,
) -> (thread::JoinHandle<()>, thread::JoinHandle<()>) {
    let output_app = app.clone();
    let output_session = Arc::clone(&session);
    let output_worker = thread::spawn(move || {
        #[cfg(unix)]
        let fd = output_session
            .master
            .lock()
            .ok()
            .and_then(|master| master.as_ref().and_then(|master| master.as_raw_fd()));
        let enabled = cfg!(debug_assertions)
            && output_app.state::<SessionManager>().background_owner
            && output_stage_enabled(
                true,
                true,
                std::env::var("YAM_OUTPUT_STAGE_DIAGNOSTICS")
                    .ok()
                    .as_deref(),
            );
        run_output_worker(
            &output_app,
            &output_session,
            reader.as_mut(),
            || {
                #[cfg(unix)]
                if let Some(fd) = fd {
                    return wait_output_ready(fd, &output_session.cancel_output);
                }
                Ok(true)
            },
            enabled.then(OutputStages::default),
            |row| {
                if let Ok(json) = serde_json::to_string(row) {
                    if json.len() + "YAM_OUTPUT_STAGES_V1 ".len() <= 2048 {
                        let _ = writeln!(std::io::stderr().lock(), "YAM_OUTPUT_STAGES_V1 {json}");
                    }
                }
            },
        );
    });

    let wait_app = app.clone();
    let wait_worker = thread::spawn(move || {
        let (status, exit_code, reason) = loop {
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
            let result = session_has_exited(&session);
            match result {
                Ok(true) => {
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
                        break ("failed".into(), None, Some(error));
                    }
                    session.cleanup_done.store(true, Ordering::Release);
                    if !drained {
                        session.cancel_output.store(true, Ordering::Release);
                        break (
                            "failed".into(),
                            None,
                            Some("Process exited but terminal output did not close".into()),
                        );
                    }
                    let exit = match session
                        .child
                        .lock()
                        .map_err(|_| "Child lock poisoned".to_string())
                        .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()))
                    {
                        Ok(Some(exit)) => exit,
                        Ok(None) => {
                            thread::sleep(Duration::from_millis(40));
                            continue;
                        }
                        Err(error) => break ("failed".into(), None, Some(error)),
                    };
                    if session.stop_requested.load(Ordering::Acquire) {
                        break (
                            "stopped".into(),
                            Some(exit.exit_code()),
                            Some("Stopped by user".into()),
                        );
                    }
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
                        _ => "Agent reported failure or the process exited with a non-zero code",
                    };
                    break (status, Some(exit.exit_code()), Some(reason.into()));
                }
                Ok(false) => thread::sleep(Duration::from_millis(40)),
                Err(error) => {
                    let cleanup = terminate_session(&session)
                        .and_then(|_| cleanup_session_descendants(&session));
                    let reason = match cleanup {
                        Ok(()) => {
                            session.cleanup_done.store(true, Ordering::Release);
                            let (lock, done) = &session.output_done;
                            let drained = lock
                                .lock()
                                .ok()
                                .and_then(|drained| {
                                    done.wait_timeout_while(
                                        drained,
                                        Duration::from_secs(2),
                                        |drained| !*drained,
                                    )
                                    .ok()
                                })
                                .is_some_and(|(drained, _)| *drained);
                            if !drained {
                                session.cancel_output.store(true, Ordering::Release);
                            }
                            error
                        }
                        Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
                    };
                    break ("failed".into(), None, Some(reason));
                }
            }
        };
        let event = SessionStateEvent {
            session_id: session.summary.session_id.clone(),
            status,
            exit_code,
            reason,
        };
        if let Err(error) =
            finish_session_with(&wait_app, &sessions, &session, Some(event), &native_notify)
        {
            let _ = wait_app.emit(
                "session-error",
                SessionMessage {
                    session_id: session.summary.session_id.clone(),
                    data: error,
                },
            );
        }
    });
    (output_worker, wait_worker)
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
fn archive_session<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn get_history_policy<R: tauri::Runtime>(
    app: AppHandle<R>,
    manager: State<'_, SessionManager>,
) -> Result<serde_json::Value, String> {
    proxy!(manager, "get_history_policy", serde_json::json!({}));
    manager.history(&app)?.retention_policy()
}
#[tauri::command]
fn set_history_policy<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn preview_archive_deletion<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn cancel_archive_deletion_preview<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn confirm_archive_deletion<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn restore_archive<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn list_archived_sessions<R: tauri::Runtime>(
    app: AppHandle<R>,
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
#[cfg(test)]
thread_local! {
    static A01A_HOME_OVERRIDE: std::cell::RefCell<Option<Result<PathBuf, String>>> = const {std::cell::RefCell::new(None)};
    static A01A_HOME_CALLS: std::cell::Cell<usize> = const {std::cell::Cell::new(0)};
    static A01A_ALLOCATION_CWD: std::cell::RefCell<Option<PathBuf>> = const {std::cell::RefCell::new(None)};
}

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
    shell: Option<ShellLaunch>,
    env_refs: Option<std::collections::BTreeMap<String, String>>,
    directory_reporting: Option<bool>,
    retained_lines: Option<u16>,
    ssh: Option<ssh_launch::SshLaunch>,
    command_reporting: Option<bool>,
) -> Result<CreateSessionReply, String> {
    let mut arguments = create_session_arguments(
        &cwd,
        &command,
        &launch,
        &resume_from,
        &project_config,
        &worktree_attempt,
        &shell,
        &env_refs,
        &retained_lines,
        &ssh,
        &directory_reporting,
        &command_reporting,
    )?;
    if directory_reporting == Some(true) {
        arguments["directory_reporting"] = serde_json::json!(true);
    }
    if command_reporting == Some(true) {
        let client = manager
            .background_client
            .lock()
            .map_err(|_| "Background client lock poisoned")?
            .clone();
        if let Some(client) = client {
            return match desktop_windows::ssh_create(&client, arguments, ssh.is_some()) {
                background::CallOutcome::Completed(Ok(value)) => serde_json::from_value(value)
                    .map_err(|_| "terminal_start_outcome_unknown".into()),
                background::CallOutcome::NotDispatched(error)
                | background::CallOutcome::Completed(Err(error)) => Err(error),
                background::CallOutcome::Unknown(_) => Err("terminal_start_outcome_unknown".into()),
            };
        }
    }
    proxy!(manager, "create_session", arguments);
    let private_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "project_config_preferences")?;
    create_session_owner_with_directory_reporting(
        Some(app),
        &manager,
        &private_root,
        cwd,
        command,
        launch,
        resume_from,
        project_config,
        worktree_attempt,
        shell,
        env_refs,
        directory_reporting,
        retained_lines,
        ssh,
        command_reporting,
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
    create_session_owner_with_shell(
        app,
        manager,
        private_root,
        cwd,
        command,
        launch,
        resume_from,
        project,
        None,
        None,
        None,
    )
}
// The selected ordinary-shell cwd is shared by preflight, spawn and summary.
fn resolve_owner_cwd(
    cwd: Option<String>,
    ordinary: bool,
    home: impl FnOnce() -> Result<PathBuf, String>,
    current: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(Option<String>, PathBuf), String> {
    let cwd = if ordinary && cwd.as_ref().is_none_or(|path| path.trim().is_empty()) {
        let home = home().map_err(|error| format!("Cannot resolve home directory: {error}"))?;
        let literal = home
            .to_str()
            .ok_or("Home directory must be an absolute existing directory")?;
        if !home.is_absolute()
            || literal.trim().is_empty()
            || literal.contains('\0')
            || !home.is_dir()
        {
            return Err("Home directory must be an absolute existing directory".into());
        }
        Some(literal.to_owned())
    } else {
        cwd
    };
    let initial = match cwd.as_ref() {
        Some(path) => PathBuf::from(path),
        None => current().map_err(|_| "worktree_invalid_target")?,
    };
    Ok((cwd, initial))
}

fn owner_home_directory<R: tauri::Runtime>(app: Option<&AppHandle<R>>) -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        A01A_HOME_CALLS.with(|count| count.set(count.get() + 1));
        if let Some(result) = A01A_HOME_OVERRIDE.with(|value| value.borrow().clone()) {
            return result;
        }
    }
    app.ok_or_else(|| "Application handle unavailable".to_string())?
        .path()
        .home_dir()
        .map_err(|error| error.to_string())
}

// CLI and managed worktree starts keep the existing entrypoint and omit ordinary shell settings.
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
    create_session_owner_with_shell(
        app,
        manager,
        private_root,
        cwd,
        command,
        launch,
        resume_from,
        project,
        worktree_attempt,
        None,
        None,
    )
}

pub(crate) fn validate_profile_env_refs(
    refs: &std::collections::BTreeMap<String, String>,
    windows: bool,
) -> Result<(), String> {
    let mut targets = std::collections::BTreeSet::new();
    if refs.len() > 32
        || refs.iter().any(|(target, source)| {
            !project_config::variable(target)
                || !project_config::variable(source)
                || project_config::reserved(target)
                || project_config::reserved(source)
                || !targets.insert(target.to_ascii_uppercase())
        })
    {
        return Err("profile_env_invalid".into());
    }
    if refs.keys().any(|target| {
        if windows {
            matches!(
                target.to_ascii_uppercase().as_str(),
                "USERPROFILE" | "PATHEXT"
            )
        } else {
            target == "SHELL"
        }
    }) {
        return Err("profile_env_unsupported_target".into());
    }
    Ok(())
}
fn resolve_profile_env(
    refs: &std::collections::BTreeMap<String, String>,
    lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut sources = std::collections::BTreeMap::new();
    let mut resolved = std::collections::BTreeMap::new();
    let mut total = 0usize;
    for (target, source) in refs {
        if !sources.contains_key(source) {
            let value = lookup(source)
                .ok_or("profile_env_missing")?
                .into_string()
                .map_err(|_| "profile_env_invalid_value")?;
            if value.contains('\0') {
                return Err("profile_env_invalid_value".into());
            }
            if value.len() > 16384 {
                return Err("profile_env_budget".into());
            }
            sources.insert(source.clone(), value);
        }
        let value = &sources[source];
        total = total
            .saturating_add(target.len())
            .saturating_add(value.len());
        if total > 65536 {
            return Err("profile_env_budget".into());
        }
        resolved.insert(target.clone(), value.clone());
    }
    Ok(resolved)
}
#[cfg(test)]
thread_local! {static A02B_ENV_OVERRIDE:std::cell::RefCell<Option<std::collections::BTreeMap<String,std::ffi::OsString>>>=const{std::cell::RefCell::new(None)};static A02B_ENV_CALLS:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}
fn profile_env_lookup(source: &str) -> Option<std::ffi::OsString> {
    #[cfg(test)]
    {
        A02B_ENV_CALLS.with(|v| v.set(v.get() + 1));
        if let Some(value) = A02B_ENV_OVERRIDE.with(|v| v.borrow().clone()) {
            return value.get(source).cloned();
        }
    }
    std::env::var_os(source)
}
fn report_spawn_failure<T>(
    error: &dyn std::fmt::Display,
    profile_env: bool,
    record: impl FnOnce(&str) -> Result<(), String>,
    emit: impl FnOnce(&str),
) -> Result<T, String> {
    let reason = if profile_env {
        "profile_env_start_failed".to_string()
    } else {
        format!("Failed to start session: {error}")
    };
    record(&reason)?;
    emit(&reason);
    Err(reason)
}

#[allow(clippy::too_many_arguments)]
fn create_session_owner_with_shell(
    app: Option<AppHandle>,
    manager: &SessionManager,
    private_root: &Path,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project: Option<project_config::ProjectStart>,
    worktree_attempt: Option<String>,
    shell: Option<ShellLaunch>,
    env_refs: Option<std::collections::BTreeMap<String, String>>,
) -> Result<SessionSummary, String> {
    create_session_owner_with_directory_reporting(
        app,
        manager,
        private_root,
        cwd,
        command,
        launch,
        resume_from,
        project,
        worktree_attempt,
        shell,
        env_refs,
        None,
        None,
        None,
        None,
    )
    .map(|reply| reply.summary)
}
#[allow(clippy::too_many_arguments)]
fn create_session_owner_with_directory_reporting(
    app: Option<AppHandle>,
    manager: &SessionManager,
    private_root: &Path,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project: Option<project_config::ProjectStart>,
    worktree_attempt: Option<String>,
    shell: Option<ShellLaunch>,
    env_refs: Option<std::collections::BTreeMap<String, String>>,
    directory_reporting: Option<bool>,
    retained_lines: Option<u16>,
    ssh: Option<ssh_launch::SshLaunch>,

    command_reporting: Option<bool>,
) -> Result<CreateSessionReply, String> {
    create_session_with_effects(
        app,
        manager,
        private_root,
        cwd,
        command,
        launch,
        resume_from,
        project,
        worktree_attempt,
        shell,
        env_refs,
        directory_reporting,
        retained_lines,
        ssh,
        command_reporting,
        find_executable,
        |size| {
            native_pty_system()
                .openpty(size)
                .map_err(|error| error.to_string())
        },
        |slave, builder| {
            slave
                .spawn_command(builder)
                .map_err(|error| error.to_string())
        },
        |app, history, id, prepared, builder| {
            manager.connect_agent(app, history, id, prepared, builder)
        },
        background::notify_lifecycle,
        spawn_session_threads,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_session_with_effects<R: tauri::Runtime>(
    app: Option<AppHandle<R>>,
    manager: &SessionManager,
    private_root: &Path,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project: Option<project_config::ProjectStart>,
    worktree_attempt: Option<String>,
    shell: Option<ShellLaunch>,
    env_refs: Option<std::collections::BTreeMap<String, String>>,
    directory_reporting: Option<bool>,
    retained_lines: Option<u16>,
    ssh: Option<ssh_launch::SshLaunch>,

    command_reporting: Option<bool>,
    lookup_executable: impl Fn(&str) -> Option<PathBuf>,
    open_pty: impl FnOnce(PtySize) -> Result<portable_pty::PtyPair, String>,
    mut spawn_command: impl FnMut(
        &dyn portable_pty::SlavePty,
        CommandBuilder,
    ) -> Result<Box<dyn Child + Send + Sync>, String>,
    connect_agent: impl FnOnce(
        &AppHandle<R>,
        Arc<HistoryStore>,
        &str,
        &agent_bridge::Prepared,
        &mut CommandBuilder,
    ) -> Result<(), String>,
    native_notify: impl FnOnce(&AppHandle<R>, &str, &str),
    start_threads: impl FnOnce(
        &AppHandle<R>,
        Arc<Mutex<HashMap<String, Arc<Session>>>>,
        Arc<Session>,
        Box<dyn Read + Send>,
    ),
) -> Result<CreateSessionReply, String> {
    let standalone_ssh = ssh_launch::standalone(
        ssh.as_ref(),
        command.is_some()
            || launch.is_some()
            || resume_from.is_some()
            || project.is_some()
            || worktree_attempt.is_some()
            || shell.is_some()
            || env_refs.as_ref().is_some_and(|v| !v.is_empty())
            || directory_reporting == Some(true)
            || command_reporting == Some(true),
    )?;
    let ssh_builder = ssh.as_ref().map(ssh_launch::command).transpose()?;
    let ordinary = ssh.is_none()
        && command.is_none()
        && launch.is_none()
        && resume_from.is_none()
        && project.is_none()
        && worktree_attempt.is_none();
    let retained_lines = terminal_retained_lines(retained_lines, ordinary || standalone_ssh)?;
    zsh_directory_reporting::validate(
        directory_reporting.unwrap_or(false),
        ordinary,
        shell.as_ref(),
        cfg!(windows),
    )?;
    zsh_directory_reporting::validate(
        command_reporting.unwrap_or(false),
        ordinary,
        shell.as_ref(),
        cfg!(windows),
    )
    .map_err(|_| "command_reporting_invalid_combination")?;
    let has_profile_env = env_refs.as_ref().is_some_and(|refs| !refs.is_empty());
    if has_profile_env {
        if !ordinary {
            return Err("profile_env_invalid_combination".into());
        }
        if shell.is_none() {
            return Err("profile_env_shell_required".into());
        }
        validate_profile_env_refs(env_refs.as_ref().unwrap(), cfg!(windows))?;
    }
    if shell.is_some() && !ordinary {
        return Err("shell_invalid_combination".into());
    }
    let shell_builder = shell
        .as_ref()
        .map(|shell| ordinary_shell_command(shell, owner_default_shell))
        .transpose()?;
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
                lookup_executable(name)
            },
            &|key| std::env::var(key).ok(),
        )?)
    } else {
        None
    };
    let (cwd, command, mut launch, env, project_source) = match prepared {
        Some(prepared) => (
            Some(prepared.cwd.to_string_lossy().into_owned()),
            prepared.command,
            prepared.launch,
            prepared.env,
            Some((prepared.source, prepared.cwd_identity)),
        ),
        None => (
            cwd,
            command,
            launch,
            std::collections::BTreeMap::new(),
            None,
        ),
    };
    let (cwd, initial_cwd) = resolve_owner_cwd(
        cwd,
        ordinary,
        || owner_home_directory(app.as_ref()),
        || std::env::current_dir().map_err(|error| error.to_string()),
    )?;
    if standalone_ssh {
        validate_working_directory(cwd.as_deref().ok_or("ssh_local_directory_invalid")?)?;
    }
    if has_profile_env {
        validate_working_directory(cwd.as_deref().ok_or("profile_env_invalid")?)?;
    }
    let mut env = if has_profile_env {
        resolve_profile_env(env_refs.as_ref().unwrap(), &profile_env_lookup)?
    } else {
        env
    };
    if let Some(launch) = &launch {
        env.extend(project_config::resolve_env_refs(
            &launch.env_refs,
            &|key| std::env::var(key).ok(),
        )?);
    }
    if let Some(launch) = &launch {
        provider_launch::validate_project(launch, &initial_cwd)?;
    }
    if let Some(launch) = &mut launch {
        codex_context::assign_context(launch)?;
    }
    let provider_environment = launch
        .as_ref()
        .map(|launch| {
            provider_launch::prepare(private_root, launch, &|key| {
                env.get(key).cloned().or_else(|| std::env::var(key).ok())
            })
            .map(|environment| environment.with_project_env(&env))
        })
        .transpose()?;
    let _worktree_lifecycle = worktree_manager::start_guard()?;
    if worktree_attempt.is_some() && resume_from.is_some() {
        return Err("worktree_invalid_start".into());
    }
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
        A01A_ALLOCATION_CWD.with(|value| *value.borrow_mut() = Some(initial_cwd.clone()));
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
    let (cwd, command, launch, resume_id, resume_claim, reopened) =
        if let Some(source) = resume_from.as_deref() {
            if cwd.is_some() || command.is_some() || launch.is_some() {
                return Err("Resume cannot override the stored conversation launch".into());
            }
            // The existing start guard serializes resolution and allocation across windows.
            let record = history.latest_terminal(source)?;
            if matches!(record.status.as_str(), "starting" | "running") {
                let active = manager
                    .sessions
                    .lock()
                    .map_err(|_| "Session manager lock poisoned")?;
                let session = active
                    .get(&record.summary.session_id)
                    .ok_or("The terminal process is unavailable; reconnect the terminal owner")?;
                let mut summary = session.summary.clone();
                summary.status = session
                    .status
                    .lock()
                    .map_err(|_| "Session status lock poisoned")?
                    .clone();
                if matches!(summary.status.as_str(), "starting" | "running") {
                    return Ok(CreateSessionReply {
                        summary,
                        reopened_from: Some(record.summary.session_id),
                        directory_reporting_warning: None,
                        command_reporting_warning: None,
                    });
                }
                return Err("Terminal is finishing; open it again after it has stopped".into());
            }
            let (launch, id) = terminal_reopen_launch(&record)?;
            let claim = if id.is_some() {
                Some(
                    claim_resume_source(
                        &history,
                        manager.resume_claims.clone(),
                        &record.summary.session_id,
                    )?
                    .1,
                )
            } else {
                None
            };
            (
                Some(record.summary.cwd.clone()),
                None,
                launch,
                id,
                claim,
                Some(record),
            )
        } else {
            (cwd, command, launch, None, None, None)
        };
    let resume_from = reopened
        .as_ref()
        .map(|record| record.summary.session_id.clone());
    let ssh = reopened
        .as_ref()
        .and_then(|record| record.summary.ssh.clone())
        .or(ssh);
    let ssh_builder = if reopened.is_some() {
        ssh.as_ref().map(ssh_launch::command).transpose()?
    } else {
        ssh_builder
    };
    // Resume restores references and credentials from the stored launch before native probes.
    let provider_environment = if resume_id.is_some() {
        let stored = launch.as_ref().ok_or("Resume launch is missing")?;
        provider_launch::validate_project(
            stored,
            Path::new(cwd.as_deref().ok_or("Resume directory is missing")?),
        )?;
        env = project_config::resolve_env_refs(&stored.env_refs, &|key| std::env::var(key).ok())?;
        Some(
            provider_launch::prepare(private_root, stored, &|key| {
                env.get(key).cloned().or_else(|| std::env::var(key).ok())
            })?
            .with_project_env(&env),
        )
    } else {
        provider_environment
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
    let pair = open_pty(PtySize {
        rows: 24,
        cols: 100,
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|error| format!("Failed to open PTY: {error}"))?;
    if let Some((source, cwd_identity)) = &project_source {
        project_config::revalidate(source, &initial_cwd, cwd_identity, private_root)?;
    }
    if let Some(environment) = &provider_environment {
        environment.validate_before_spawn()?;
    }

    if command.is_some() && launch.is_some() {
        return Err("Choose either an agent or a custom command".into());
    }
    let gemini_identity = launch
        .as_ref()
        .filter(|launch| {
            launch.adapter == "gemini" && launch.mode == "interactive" && resume_id.is_none()
        })
        .map(|_| gemini_resume::new_id())
        .transpose()?;
    let mut launch_executable = None;
    let mut builder = if let Some(builder) = ssh_builder {
        builder
    } else if let Some(launch) = &launch {
        let executable = lookup_executable(&launch.adapter).ok_or_else(|| {
            format!(
                "{} was not found or is not executable on PATH",
                launch.adapter
            )
        })?;
        launch_executable = Some(executable.clone());
        if let Some(id) = resume_id.as_deref() {
            let directory = Path::new(cwd.as_deref().ok_or("Resume directory is missing")?);
            if matches!(launch.adapter.as_str(), "claude" | "gemini") {
                let default_home = app.path().home_dir().map_err(|error| error.to_string())?;
                let config = provider_environment
                    .as_ref()
                    .ok_or("Resume environment is unavailable")?
                    .config_root(&launch.adapter, directory, &default_home);
                if launch.adapter == "claude" {
                    claude_resume::validate(&config, directory, id)?;
                } else {
                    gemini_resume::validate(&config, directory, id)?;
                }
            } else {
                agent_bridge::validate_resume(
                    &executable,
                    directory,
                    id,
                    launch,
                    provider_environment.as_ref(),
                )?;
            }
            resume_command(&executable, launch, id)?
        } else {
            agent_command(&executable, launch)?
        }
    } else if let Some(builder) = shell_builder {
        builder
    } else {
        shell_command(command.as_deref())
    };
    #[cfg(unix)]
    configure_terminal_environment(&mut builder);
    if let Some(id) = &gemini_identity {
        builder.args(["--session-id", id]);
    }
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
    if let Some(environment) = &provider_environment {
        environment.apply_pty(&mut builder);
    }
    let integration = launch
        .as_ref()
        .filter(|launch| launch.mode == "interactive")
        .map(|launch| {
            launch_executable
                .as_deref()
                .ok_or_else(|| "Agent executable unavailable".to_string())
                .and_then(|exe| {
                    agent_bridge::prepare(
                        exe,
                        launch,
                        Path::new(&working_directory),
                        &history.root,
                        provider_environment.as_ref(),
                    )
                })
        });

    let summary = SessionSummary {
        ssh: ssh.clone(),
        session_id: id,
        cwd: working_directory,
        command,
        status: "starting".to_string(),
        launch,
    };
    let mut log = history::PendingSessionLog::open(history.clone(), &summary.session_id)?;
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
                terminal_create_arguments(retained_lines),
            )?;
            Ok::<_, String>(TerminalAttachment {
                command_reporting: ordinary,
                runtime,
                session: summary.session_id.clone(),
                reported: AtomicBool::new(false),
            })
        })
        .transpose()?;
    let restored = if let Some(record) = reopened.as_ref().filter(|_| resume_id.is_none()) {
        let runtime = &terminal
            .as_ref()
            .ok_or("Terminal parser unavailable for restoring history")?
            .runtime;
        let output = read_recorded_log_string(&history, &record.summary.session_id)?;
        for chunk in output.as_bytes().chunks(512 * 1024) {
            runtime.call(
                "restore",
                &summary.session_id,
                serde_json::json!({"data":terminal_runtime::base64(chunk),"final":false}),
            )?;
        }
        let restored = runtime.call(
            "restore",
            &summary.session_id,
            serde_json::json!({"data":"","final":true}),
        )?;
        restored["text"]
            .as_str()
            .ok_or("Invalid terminal history restoration")?
            .as_bytes()
            .to_vec()
    } else {
        Vec::new()
    };
    log.file()
        .write_all(&restored)
        .map_err(|_| "Cannot preserve terminal output")?;
    let restored_offset = restored.len() as u64;
    if let Some(launch) = &summary.launch {
        provider_launch::validate_project(launch, Path::new(&summary.cwd))?;
    }
    if let Some((source, cwd_identity)) = &project_source {
        project_config::revalidate(source, &initial_cwd, cwd_identity, private_root)?;
    }
    if let Some(environment) = &provider_environment {
        environment.validate_before_spawn()?;
    }
    log.begin_commit();
    history.start_continuation(&summary, resume_from.as_deref())?;
    let log = log.commit();
    if restored_offset > 0 {
        history.update(
            &summary.session_id,
            "starting",
            None,
            None,
            Some(restored_offset),
        )?;
    }
    if let Some(integration) = integration {
        match integration {
            Ok(prepared) => {
                if let Err(reason) = connect_agent(
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
    if let Some(native_id) = resume_id.as_deref().or(gemini_identity.as_deref()) {
        history.bind_resume_identity(&summary.session_id, native_id)?;
    }
    #[allow(unused_mut)]
    let (
        mut child,
        directory_reporting_assets,
        directory_reporting_warning,
        command_reporting_warning,
    ) = match zsh_directory_reporting::spawn(
        private_root,
        builder,
        directory_reporting == Some(true),
        command_reporting == Some(true),
        |builder| {
            if let Some((source, cwd_identity)) = &project_source {
                project_config::revalidate(source, &initial_cwd, cwd_identity, private_root)?;
            }
            if let Some(environment) = &provider_environment {
                environment.validate_before_spawn()?;
            }
            spawn_command(pair.slave.as_ref(), builder)
        },
    ) {
        Ok(result) => result,
        Err(error) => {
            return report_spawn_failure(
                &error,
                has_profile_env,
                |reason| {
                    history.update(
                        &summary.session_id,
                        "failed",
                        None,
                        Some(reason.to_string()),
                        None,
                    )
                },
                |reason| {
                    let _ = app.emit(
                        "session-state",
                        SessionStateEvent {
                            session_id: summary.session_id.clone(),
                            status: "failed".into(),
                            exit_code: None,
                            reason: Some(reason.to_string()),
                        },
                    );
                },
            );
        }
    };
    #[cfg(unix)]
    let process_identity = child
        .process_id()
        .and_then(|pid| memory::process_identity(pid).map(|stamp| (pid, stamp)));
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
        _directory_reporting_assets: directory_reporting_assets,
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
            end_offset: restored_offset,
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
        pending_finish: Mutex::new(None),
        #[cfg(test)]
        exit_observation_fault: None,
        cleanup_done: AtomicBool::new(false),
        #[cfg(unix)]
        process_identity,
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
    emit_state_with(
        &app,
        &session,
        "running",
        None,
        Some("PTY started".to_string()),
        native_notify,
    );
    start_threads(&app, Arc::clone(&manager.sessions), session, reader);

    Ok(CreateSessionReply {
        summary: running_summary(summary),
        reopened_from: resume_from,
        directory_reporting_warning,
        command_reporting_warning,
    })
}

fn running_summary(mut summary: SessionSummary) -> SessionSummary {
    summary.status = "running".into();
    summary
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
fn acknowledge_notification<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    let chinese = system_entry::notification_chinese(&app);
    tauri::async_runtime::spawn_blocking(move || {
        history
            .native_delivery(
                &session_id,
                agent_events::NativeSource::Lifecycle(&expected_status),
                |record| {
                    let body = record.reason.clone().unwrap_or_else(|| {
                        system_entry::notification_status(&record.status, chinese)
                    });
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
fn set_notification_locale(
    manager: State<'_, SessionManager>,
    locale: String,
) -> Result<(), String> {
    let args = serde_json::json!({"locale":locale});
    background::validate_command("set_notification_locale", &args)?;
    proxy!(manager, "set_notification_locale", args);
    manager
        .system_entry
        .lock()
        .map_err(|_| "system_entry_unavailable")?
        .notification_chinese = locale == "zh-CN";
    Ok(())
}
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
fn read_agent_receipt<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn list_session_summaries<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn get_session<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn history_overview<R: tauri::Runtime>(
    app: AppHandle<R>,
    manager: State<'_, SessionManager>,
) -> Result<history::Overview, String> {
    proxy!(manager, "history_overview", serde_json::json!({}));
    manager.history(&app)?.overview()
}
#[tauri::command]
fn list_unread_receipts<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn next_attention<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn list_pending_notifications<R: tauri::Runtime>(
    app: AppHandle<R>,
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
async fn search_session_logs<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    let source = app.clone();
    export_diagnostics_with(
        move || diagnostics::report(&source.state::<SessionManager>()),
        move || {
            let Some(destination) = app
                .dialog()
                .file()
                .set_file_name("yam-diagnostics.json")
                .add_filter("JSON", &["json"])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            destination
                .into_path()
                .map(Some)
                .map_err(|_| "invalid_destination")
        },
    )
    .await
}
async fn export_diagnostics_with(
    report: impl FnOnce() -> Result<Vec<u8>, &'static str> + Send + 'static,
    choose: impl FnOnce() -> Result<Option<std::path::PathBuf>, &'static str> + Send + 'static,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = report()?;
        let Some(path) = choose()? else {
            return Ok(false);
        };
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
async fn read_log_excerpt<R: tauri::Runtime>(
    app: AppHandle<R>,
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
fn read_session_log<R: tauri::Runtime>(
    app: AppHandle<R>,
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

fn read_session_snapshot<R: tauri::Runtime>(
    app: AppHandle<R>,
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
    if let Ok(mut table) = manager.desktop_windows.lock() {
        manager
            .desktop_foreground
            .store(table.focus(label, focused), Ordering::Release);
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(gui_startup::plugin());
    builder
        .manage(provider_catalog::Requests::default())
        .manage(file_preview::Requests::default())
        .manage(codex_conversation::Requests::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // The deep-link plugin may not be initialized when a second process arrives.
            for argument in args.iter().skip(1) {
                if session_id_from_link(argument).is_some() {
                    if let Err(error) = route_notification_link(app, argument) {
                        eprintln!("[YAM] {error}");
                    }
                }
            }
            if let Some(window) = app.get_window("main") {
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
        .menu(native_menu::build)
        .on_menu_event(|app, event| {
            native_menu::route(app, event.id().as_ref());
            if event.id().as_ref() == "yam-stop-quit" {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let confirmation = system_entry::confirm_stop_all(app.clone()).await;
                    if confirmation.is_err() {
                        eprintln!("[YAM] Stop confirmation unavailable");
                        return;
                    }
                    if let Err(error) = system_entry::confirmed_action(confirmation, || {
                        stop_all_and_quit(app.clone())
                    })
                    .await
                    {
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
            if window.label() != "main" {
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                browser_window::main_destroyed(window.app_handle());
                if let Ok(mut table) = window.state::<SessionManager>().desktop_windows.lock() {
                    table.note_destroyed(desktop_windows::Slot::Main, 1);
                }
            }
            if let tauri::WindowEvent::Focused(focused) = event {
                record_desktop_focus(&window.state::<SessionManager>(), "main", *focused);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .app_handle()
                    .get_window("terminal-secondary")
                    .is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                    record_desktop_focus(&window.state::<SessionManager>(), "main", false);
                } else if let Ok(mut table) =
                    window.state::<SessionManager>().desktop_windows.lock()
                {
                    table.close("main");
                }
            }
        })
        .on_page_load(|webview, payload| desktop_windows::page_ready(webview, payload.event()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            gui_startup::ready(app.handle())?;
            updater::initialize(app.handle())?;
            if let Some(window) = app.get_window("main") {
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
            if let Some(window) = app.get_window("main") {
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
        .manage(browser_window::Browser::<tauri::Wry>::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(|invoke| {
            let webview = invoke.message.webview_ref().label().to_owned();
            let window = invoke.message.webview_ref().window().label().to_owned();
            browser_window::invoke_gate(
                &webview,
                &window,
                invoke,
                tauri::generate_handler![
                    updater::updater_status,
                    updater::updater_check,
                    updater::updater_download,
                    updater::updater_cancel,
                    updater::updater_set_automatic_checks,
                    updater::updater_install,
                    desktop_windows::desktop_window_bootstrap,
                    desktop_windows::claim_terminal_view,
                    desktop_windows::release_terminal_view,
                    desktop_windows::prepare_terminal_move,
                    desktop_windows::query_terminal_move,
                    desktop_windows::reconcile_terminal_move,
                    desktop_windows::accept_terminal_move,
                    desktop_windows::complete_terminal_move,
                    desktop_windows::recover_terminal_move,
                    desktop_windows::reserve_terminal_start,
                    desktop_windows::open_terminal_window,
                    desktop_windows::open_main_settings,
                    desktop_windows::preview_terminal_file,
                    desktop_windows::reveal_terminal_file,
                    desktop_windows::terminal_input_focused,
                    desktop_windows::commit_window_preferences,
                    desktop_windows::request_main_terminal_zoom,
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
                    desktop_windows::create_session,
                    provider_protocol_version,
                    desktop_windows::write_session,
                    desktop_windows::resize_session,
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
                    desktop_windows::set_agent_notification_context,
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
                    desktop_windows::read_session_snapshot,
                    desktop_windows::read_terminal_frame,
                    stop_all_and_quit,
                    desktop_windows::take_terminal_control,
                    desktop_windows::set_terminal_viewport,
                    desktop_windows::navigate_reported_prompt,
                    desktop_windows::clear_terminal_display,
                    browser_window::browser_status,
                    browser_window::browser_open,
                    browser_window::browser_show,
                    browser_window::browser_reload,
                    browser_window::browser_close,
                    provider_probe::probe_provider_endpoint,
                    provider_probe::list_local_gateways,
                    external_terminal::list_external_terminals,
                    terminal_fonts::list_terminal_fonts,
                    external_terminal::open_external_terminal,
                    system_entry::confirm_stop_all,
                    system_entry::confirm_template_reset,
                    background::reconnect_background,
                    provider_catalog::check_provider_gateway,
                    provider_catalog::cancel_provider_gateway,
                    provider_catalog::load_provider_models,
                    file_preview::read_project_file_preview,
                    file_preview::choose_project_file_preview,
                    file_preview::cancel_file_preview,
                    codex_conversation::read_codex_conversation,
                    codex_conversation::cancel_codex_conversation,
                    native_menu::native_menu_labels,
                    desktop_windows::set_notification_locale
                ],
                |invoke| invoke.resolver.reject("webview_command_forbidden"),
            )
        })
        .build(app_context())
        .expect("error while building YAM")
        .run(handle_owner_exit);
}
fn keep_background_event_loop(owner: bool, stopping: bool) -> bool {
    owner && !stopping
}
#[cfg(target_os = "macos")]
fn handle_native_reopen(
    reopen: bool,
    manager: &SessionManager,
    hide_owner: impl FnOnce() -> Result<(), String>,
    open_owner: impl FnOnce() -> Result<(), String>,
    show_desktop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !reopen || manager.shutting_down.load(Ordering::Acquire) {
        return Ok(());
    }
    if manager.background_owner {
        hide_owner()?;
        open_owner()
    } else {
        show_desktop()
    }
}

fn handle_owner_exit(app: &AppHandle, event: tauri::RunEvent) {
    let manager = app.state::<SessionManager>();
    #[cfg(target_os = "macos")]
    if handle_native_reopen(
        matches!(event, tauri::RunEvent::Reopen { .. }),
        &manager,
        || {
            // Launch Services can promote the resident owner when reopening the regular app bundle.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                .map_err(|_| "system_entry_open_failed".to_string())
        },
        || system_entry::open_native(app),
        || system_entry::show_desktop(app),
    )
    .is_err()
    {
        eprintln!("[YAM] Native reopen failed");
    }
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
    let controller = if manager.background_owner {
        None
    } else {
        app.try_state::<Arc<updater::Controller>>()
    };
    let request = if let tauri::RunEvent::ExitRequested { code, .. } = &event {
        Some(code.unwrap_or(0))
    } else {
        None
    };
    if handle_gui_exit_with(
        &manager,
        controller.as_ref().map(|state| state.inner()),
        request,
        matches!(event, tauri::RunEvent::Exit),
        || {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                api.prevent_exit();
            }
        },
        |controller, code| {
            let handle = app.clone();
            thread::spawn(move || {
                controller.shutdown_and_join();
                handle.exit(code);
            });
        },
    ) {
        return;
    }
    if matches!(event, tauri::RunEvent::Exit) {
        let manager = app.state::<SessionManager>();
        if !manager.shutdown_complete.load(Ordering::Acquire) {
            manager.shutting_down.store(true, Ordering::Release);
            if let Err(error) = manager.shutdown_for(app, background::notify_lifecycle) {
                eprintln!("[YAM] Final exit cleanup failed: {error}");
            }
        }
    }
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let manager = app.state::<SessionManager>();
        if claim_session_exit(&manager, || api.prevent_exit()) {
            let app = app.clone();
            thread::spawn(move || {
                let manager = app.state::<SessionManager>();
                complete_session_exit(
                    &manager,
                    || manager.shutdown_for(&app, background::notify_lifecycle),
                    || app.exit(0),
                    |error| {
                        let _ = app.emit(
                            "session-error",
                            SessionMessage {
                                session_id: String::new(),
                                data: error,
                            },
                        );
                    },
                );
            });
        }
    }
}

fn handle_gui_exit_with(
    manager: &SessionManager,
    controller: Option<&Arc<updater::Controller>>,
    request: Option<i32>,
    exiting: bool,
    prevent_exit: impl FnOnce(),
    start_cleanup: impl FnOnce(Arc<updater::Controller>, i32),
) -> bool {
    // GUI update work is fenced and exactly joined before the detached-client early return.
    if !manager.background_owner {
        if let Some(controller) = controller {
            if let Some(code) = request {
                if controller.prepare_exit() {
                    prevent_exit();
                    if controller.claim_exit_cleanup() {
                        start_cleanup(controller.clone(), code);
                    }
                    return true;
                }
            }
            if exiting {
                controller.shutdown_and_join();
            }
        }
    }
    if manager
        .background_client
        .lock()
        .is_ok_and(|client| client.is_some())
    {
        if exiting || request.is_some() {
            manager.shutting_down.store(true, Ordering::Release);
        }
        return true;
    }
    false
}

fn claim_session_exit(manager: &SessionManager, prevent_exit: impl FnOnce()) -> bool {
    if manager.shutdown_complete.load(Ordering::Acquire) {
        return false;
    }
    prevent_exit();
    !manager.shutting_down.swap(true, Ordering::AcqRel)
}

fn complete_session_exit(
    manager: &SessionManager,
    shutdown: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(),
    report: impl FnOnce(String),
) {
    match shutdown() {
        Ok(()) => exit(),
        Err(error) => {
            manager.shutting_down.store(false, Ordering::Release);
            report(error);
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    include!("coverage_state_tests.rs");

    #[test]
    fn clear_live_scalar_roundtrip_and_saved_strip() {
        let raw = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"scene","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"normal","clear_display_version":1},"end_offset":0,"status":"stopped","clear_display_version":1});
        let live: super::TerminalFrame = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&live).unwrap()["clear_display_version"],
            1
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&super::encode_final_frame(live).unwrap()).unwrap();
        assert!(saved.get("clear_display_version").is_none());
        assert!(saved["projection"].get("clear_display_version").is_none());
        for bad in [
            serde_json::json!(null),
            serde_json::json!({"sensitive":"ignored"}),
            serde_json::json!(true),
        ] {
            let mut historical = raw.clone();
            historical["clear_display_version"] = bad.clone();
            historical["projection"]["clear_display_version"] = bad;
            let decoded = super::decode_saved_frame(
                &serde_json::to_vec(&historical).unwrap(),
                "s-one",
                "stopped",
                0,
            )
            .unwrap();
            assert!(serde_json::to_value(decoded)
                .unwrap()
                .get("clear_display_version")
                .is_none());
        }
    }

    #[test]
    fn clear_snapshot_preflight_strict_support_and_reply() {
        let base = serde_json::json!({"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"screen","cols":20,"rows":8,"cursorX":0,"viewport":0,"buffer":"normal"});
        for cap in [
            None,
            Some(serde_json::json!(null)),
            Some(serde_json::json!(true)),
            Some(serde_json::json!(2)),
        ] {
            let mut scene = base.clone();
            if let Some(cap) = cap {
                scene["clear_display_version"] = cap;
            }
            assert_eq!(
                super::clear_display_preflight(&mut scene, "s-one", &"a".repeat(64))
                    .unwrap()
                    .unwrap()
                    .status,
                super::ClearDisplayStatus::Unavailable
            );
        }
        let mut supported = base.clone();
        supported["clear_display_version"] = serde_json::json!(1);
        assert!(
            super::clear_display_preflight(&mut supported, "s-one", &"a".repeat(64))
                .unwrap()
                .is_none()
        );
        assert!(supported.get("clear_display_version").is_none());
        let mut stale = base.clone();
        assert_eq!(
            super::clear_display_preflight(&mut stale, "s-one", &"b".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            super::ClearDisplayStatus::Stale
        );
        let mut alternate = base.clone();
        alternate["buffer"] = serde_json::json!("alternate");
        alternate["clear_display_version"] = serde_json::json!(1);
        assert_eq!(
            super::clear_display_preflight(&mut alternate, "s-one", &"a".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            super::ClearDisplayStatus::Unavailable
        );
        let mut bad = base;
        bad["session"] = serde_json::json!("other");
        assert!(super::clear_display_preflight(&mut bad, "s-one", &"a".repeat(64)).is_err());
        for bad in [
            serde_json::json!({"status":"unknown"}),
            serde_json::json!({"status":"cleared","extra":1}),
            serde_json::json!({}),
        ] {
            assert!(serde_json::from_value::<super::ClearDisplayReply>(bad).is_err());
        }
    }

    #[test]
    fn a07c3_snapshot_preflight_old_missing_malformed_are_zero_navigation() {
        let base = serde_json::json!({"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"screen","cols":20,"rows":8,"cursorX":0,"viewport":0,"buffer":"normal"});
        for metadata in [
            None,
            Some(serde_json::json!(null)),
            Some(serde_json::json!({"version":1,"previous":false,"next":true})),
            Some(serde_json::json!({"version":1,"previous":true,"next":false,"extra":1})),
        ] {
            let mut snapshot = base.clone();
            if let Some(value) = metadata {
                snapshot["prompt_navigation"] = value;
            }
            let reply = super::prompt_navigation_preflight(
                &mut snapshot,
                "s-one",
                "previous",
                &"a".repeat(64),
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                reply.status,
                super::shell_command_report::NavigationStatus::Unavailable
            );
        }
        let mut good = base.clone();
        good["prompt_navigation"] = serde_json::json!({"version":1,"previous":true,"next":false});
        assert!(super::prompt_navigation_preflight(
            &mut good,
            "s-one",
            "previous",
            &"a".repeat(64)
        )
        .unwrap()
        .is_none());
        let mut stale = base.clone();
        assert_eq!(
            super::prompt_navigation_preflight(&mut stale, "s-one", "previous", &"b".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            super::shell_command_report::NavigationStatus::Stale
        );
        let mut bad = base.clone();
        bad["data"] = serde_json::json!(null);
        assert!(
            super::prompt_navigation_preflight(&mut bad, "s-one", "previous", &"a".repeat(64))
                .is_err()
        );
    }
    #[test]
    fn a07c3_live_navigation_roundtrip_and_saved_strip() {
        let navigation = serde_json::json!({"version":1,"previous":true,"next":false});
        let base = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"scene","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"normal","prompt_navigation":navigation},"end_offset":0,"status":"stopped","reported_prompt_navigation":navigation});
        let live: super::TerminalFrame = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&live).unwrap()["reported_prompt_navigation"],
            navigation
        );
        let saved = super::encode_final_frame(live).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        assert!(value.get("reported_prompt_navigation").is_none());
        assert!(value["projection"].get("prompt_navigation").is_none());
        for bad in [
            serde_json::json!(null),
            serde_json::json!({"version":1,"previous":true}),
            serde_json::json!({"version":1,"previous":1,"next":false}),
        ] {
            let mut raw = base.clone();
            raw["reported_prompt_navigation"] = bad.clone();
            raw["projection"]["prompt_navigation"] = bad;
            let live: super::TerminalFrame = serde_json::from_value(raw.clone()).unwrap();
            assert!(serde_json::to_value(live)
                .unwrap()
                .get("reported_prompt_navigation")
                .is_none());
            let restored = super::decode_saved_frame(
                &serde_json::to_vec(&raw).unwrap(),
                "s-one",
                "stopped",
                0,
            )
            .unwrap();
            assert!(serde_json::to_value(restored).unwrap()["projection"]
                .get("prompt_navigation")
                .is_none());
        }
    }
    #[test]
    fn a07c1_live_optional_command_roundtrip_and_history_strip() {
        let base = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"scene","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"normal","command_report":{"sequence":2,"phase":"complete","last_exit":7}},"end_offset":42,"status":"stopped","reported_command":{"sequence":2,"phase":"complete","last_exit":7}});
        let live: super::TerminalFrame = serde_json::from_value(base.clone()).unwrap();
        let reply = serde_json::to_value(&live).unwrap();
        assert_eq!(reply.get("reported_command"), base.get("reported_command"));
        let bytes = super::encode_final_frame(live).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(saved.get("reported_command").is_none());
        assert!(saved["projection"].get("command_report").is_none());
        for bad in [
            serde_json::json!(true),
            serde_json::json!({"sequence":-1}),
            serde_json::json!({"sequence":1,"phase":"running","last_exit":0}),
        ] {
            let mut value = base.clone();
            value["reported_command"] = bad.clone();
            value["projection"]["command_report"] = bad;
            let live: super::TerminalFrame = serde_json::from_value(value.clone()).unwrap();
            assert!(serde_json::to_value(live)
                .unwrap()
                .get("reported_command")
                .is_none());
            let restored = super::decode_saved_frame(
                &serde_json::to_vec(&value).unwrap(),
                "s-one",
                "stopped",
                42,
            )
            .unwrap();
            let restored = serde_json::to_value(restored).unwrap();
            assert!(restored.get("reported_command").is_none());
            assert!(restored["projection"].get("command_report").is_none());
            assert_eq!(restored["projection"]["data"], "scene");
        }
    }

    #[cfg(unix)]
    #[test]
    fn system_ps_selector_validates_fixed_candidates() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "yam-ps-selector-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        let missing = root.join("missing");
        for path in [&first, &second] {
            std::fs::write(path, b"test-owned executable fixture").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(super::system_ps_path(&[&first, &second]).unwrap(), first);
        assert_eq!(super::system_ps_path(&[&missing, &second]).unwrap(), second);
        std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(super::system_ps_path(&[&first, &second]).unwrap(), second);
        assert!(super::system_ps_path(&[&first, &missing]).is_err());
        assert!(super::system_ps_path(&[&root, &missing]).is_err());
        assert!(super::system_ps_path(&[std::path::Path::new("relative")]).is_err());
        let link = root.join("link");
        std::os::unix::fs::symlink(&second, &link).unwrap();
        assert_eq!(super::system_ps_path(&[&link]).unwrap(), link);
        // A selected executable's launch error is not retried against another candidate.
        let chosen = super::system_ps_path(&[&second]).unwrap();
        std::fs::remove_file(&second).unwrap();
        assert!(std::process::Command::new(chosen).output().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn process_tree_without_path() {
        let root = std::env::temp_dir().join(format!("yam-ps-path-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        for path in [std::ffi::OsStr::new(""), root.as_os_str()] {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::process_tree_without_path_probe",
                    "--ignored",
                ])
                .env("PATH", path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if std::time::Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("Isolated process-tree probe timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            if !status.success() {
                std::fs::remove_dir_all(&root).unwrap();
                panic!("Isolated process-tree probe rejected no-ps PATH");
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "invoked only by bounded current-exe parent"]
    fn process_tree_without_path_probe() {
        let pid = std::process::id();
        assert!(super::process_tree(pid).unwrap().contains(&pid));
    }

    #[test]
    fn a07b1_flattened_reply_preserves_legacy_summary_and_optional_warning() {
        let summary = super::SessionSummary {
            ssh: None,
            session_id: "fixture".into(),
            cwd: "/fixture".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        let plain = serde_json::to_value(&summary).unwrap();
        let reply = super::CreateSessionReply {
            summary: summary.clone(),
            reopened_from: None,
            directory_reporting_warning: None,
            command_reporting_warning: None,
        };
        assert_eq!(serde_json::to_value(&reply).unwrap(), plain);
        let legacy: super::CreateSessionReply = serde_json::from_value(plain.clone()).unwrap();
        assert!(legacy.directory_reporting_warning.is_none());
        let reply = super::CreateSessionReply {
            summary,
            reopened_from: None,
            directory_reporting_warning: Some(super::zsh_directory_reporting::WARNING.into()),
            command_reporting_warning: None,
        };
        let wire = serde_json::to_value(reply).unwrap();
        assert_eq!(
            wire["directory_reporting_warning"],
            "directory_reporting_unavailable"
        );
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<super::SessionSummary>(wire).unwrap())
                .unwrap(),
            plain
        );
    }

    #[test]
    fn terminal_reopen_reply_carries_effective_source_without_changing_legacy_summary() {
        let plain = serde_json::json!({"session_id":"s-123-3","cwd":"/fixture","command":null,"status":"running","launch":null});
        let legacy: super::CreateSessionReply = serde_json::from_value(plain.clone()).unwrap();
        assert!(legacy.reopened_from.is_none());
        assert_eq!(serde_json::to_value(legacy).unwrap(), plain);
        let mut resumed = plain.clone();
        resumed["reopened_from"] = serde_json::json!("s-123-2");
        let reply: super::CreateSessionReply = serde_json::from_value(resumed.clone()).unwrap();
        assert_eq!(reply.reopened_from.as_deref(), Some("s-123-2"));
        assert_eq!(serde_json::to_value(reply).unwrap(), resumed);
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<super::SessionSummary>(resumed).unwrap())
                .unwrap(),
            plain
        );
    }
    #[test]
    fn a05a3_default_parser_create_omits_new_optional_field() {
        assert!(super::terminal_create_arguments(2000)
            .get("retained_lines")
            .is_none());
        for lines in [200, 500, 1999] {
            assert_eq!(
                super::terminal_create_arguments(lines)["retained_lines"],
                lines
            );
        }
    }
    #[test]
    fn a05a3_owner_retention_rejects_before_allocation_and_payload_defaults_omit() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let manager = super::SessionManager::default();
        let before = super::T09_ALLOCATION_BOUNDARY.with(|n| n.get());
        for (command, lines) in [(None, 199), (None, 2001), (Some("".into()), 500)] {
            let result = super::create_session_owner_with_directory_reporting(
                None,
                &manager,
                std::path::Path::new("/fixture-no-read"),
                None,
                command,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(lines),
                None,
                None,
            );
            assert_eq!(result.err().as_deref(), Some("terminal_retention_invalid"));
        }
        assert_eq!(super::T09_ALLOCATION_BOUNDARY.with(|n| n.get()), before);
        for lines in [None, Some(200), Some(500), Some(2000)] {
            let args = super::create_session_arguments(
                &None, &None, &None, &None, &None, &None, &None, &None, &lines, &None, &None, &None,
            )
            .unwrap();
            assert_eq!(
                args.get("retained_lines"),
                lines.map(|n| serde_json::json!(n)).as_ref()
            );
        }
    }
    #[test]
    fn a07b1_actual_owner_invalid_requests_never_reach_allocation() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let manager = super::SessionManager::default();
        let before = super::T09_ALLOCATION_BOUNDARY.with(|n| n.get());
        for shell in [
            Some(super::ShellLaunch {
                program: Some("/bin/bash".into()),
                login: Some(true),
            }),
            Some(super::ShellLaunch {
                program: Some("/bin/fish".into()),
                login: Some(true),
            }),
            Some(super::ShellLaunch {
                program: Some("/bin/zsh-alias".into()),
                login: Some(true),
            }),
        ] {
            let result = super::create_session_owner_with_directory_reporting(
                None,
                &manager,
                std::path::Path::new("/owned-fixture-not-created"),
                None,
                None,
                None,
                None,
                None,
                None,
                shell,
                None,
                Some(true),
                None,
                None,
                None,
            );
            assert_eq!(
                result.err().as_deref(),
                Some("directory_reporting_invalid_combination")
            );
        }
        assert_eq!(super::T09_ALLOCATION_BOUNDARY.with(|n| n.get()), before);
    }

    #[cfg(unix)]
    #[test]
    fn a07b1_actual_zsh_start_reports_fixture_cwd() {
        let _serial = crate::worktree_manager::serial_owner_test();
        use std::io::Write;
        use std::process::{Command, Stdio};
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::path::PathBuf::from(format!(
            "/tmp/yam-a07b1-rc-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(".zshenv"), "typeset fixture_top_level=retained\n").unwrap();
        std::fs::write(root.join(".zshrc"), "PS1=''\n").unwrap();
        let mut builder = portable_pty::CommandBuilder::new("/bin/zsh");
        builder.env("ZDOTDIR", &root);
        let assets = super::zsh_directory_reporting::prepare(&root, &mut builder).unwrap();
        struct ChildGuard(Option<std::process::Child>);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                if let Some(mut child) = self.0.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let mut guard = ChildGuard(Some(
            Command::new("/bin/zsh")
                .args(["-i"])
                .env_clear()
                .env("HOME", &root)
                .env("ZDOTDIR", builder.get_env("ZDOTDIR").unwrap())
                .env(
                    "YAM_ZSH_ENV_PRESENT",
                    builder.get_env("YAM_ZSH_ENV_PRESENT").unwrap(),
                )
                .env(
                    "YAM_ZSH_ENV_VALUE",
                    builder.get_env("YAM_ZSH_ENV_VALUE").unwrap(),
                )
                .env("YAM_ZSH_INIT", builder.get_env("YAM_ZSH_INIT").unwrap())
                .env("PATH", "/usr/bin:/bin")
                .current_dir(&root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let child = guard.0.as_mut().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"print -r -- fixture:$fixture_top_level; exit\n")
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                std::fs::remove_dir_all(&root).unwrap();
                panic!("bounded fixture timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let output = guard.0.take().unwrap().wait_with_output().unwrap();
        drop(assets);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("fixture:retained"));
        assert!(
            output
                .stdout
                .windows(b"\x1b]7;file://localhost".len())
                .any(|s| s == b"\x1b]7;file://localhost"),
            "expected advisory OSC7 from ordinary fixture startup"
        );
    }

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
    fn b05a_secondary_focus_survives_main_blur_and_ignores_foreign_window() {
        let manager = SessionManager::default();
        super::record_desktop_focus(&manager, "terminal-secondary", true);
        assert!(manager.desktop_foreground.load(super::Ordering::Acquire));
        super::record_desktop_focus(&manager, "main", false);
        assert!(manager.desktop_foreground.load(super::Ordering::Acquire));
        super::record_desktop_focus(&manager, "export-dialog", false);
        assert!(manager.desktop_foreground.load(super::Ordering::Acquire));
        super::record_desktop_focus(&manager, "terminal-secondary", false);
        assert!(!manager.desktop_foreground.load(super::Ordering::Acquire));
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
    fn session_id_allocation_observation_is_local_to_calling_thread() {
        let before = super::SESSION_ID_ALLOCATIONS.with(|count| count.get());
        std::thread::spawn(next_session_id).join().unwrap();
        assert_eq!(
            super::SESSION_ID_ALLOCATIONS.with(|count| count.get()),
            before
        );
        next_session_id();
        assert_eq!(
            super::SESSION_ID_ALLOCATIONS.with(|count| count.get()),
            before + 1
        );
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
    fn a07a_live_frame_serde_proxy_roundtrip_retains_directory_report() {
        let value = serde_json::json!({"projection":{},"end_offset":0,"status":"running","reported_cwd":{"path":"/tmp/reported","sequence":2}});
        let frame: super::TerminalFrame = serde_json::from_value(value.clone()).unwrap();
        let reply = serde_json::to_value(&frame).unwrap();
        assert_eq!(reply.get("reported_cwd"), value.get("reported_cwd"));
    }

    #[test]
    fn a07a_optional_live_metadata_is_tolerant_and_final_history_strips_only_metadata() {
        let base = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"scene","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"normal","cwd_report":{"uri":"file:///secret","sequence":1}},"end_offset":42,"status":"stopped","reported_cwd":{"path":"/secret","sequence":1}});
        for report in [
            serde_json::json!({"path":true,"sequence":1}),
            serde_json::json!({"path":"/tmp","sequence":-1}),
            serde_json::json!("bad"),
            serde_json::Value::Null,
        ] {
            let mut value = base.clone();
            value["reported_cwd"] = report;
            let frame: super::TerminalFrame = serde_json::from_value(value.clone()).unwrap();
            assert!(frame.reported_cwd.is_none());
            let restored = super::decode_saved_frame(
                &serde_json::to_vec(&value).unwrap(),
                "s-one",
                "stopped",
                42,
            )
            .unwrap();
            assert!(restored.reported_cwd.is_none());
            assert!(restored.projection.get("cwd_report").is_none());
            assert_eq!(restored.projection["data"], "scene");
        }
        let frame: super::TerminalFrame = serde_json::from_value(base).unwrap();
        assert!(frame.reported_cwd.is_some());
        let bytes = super::encode_final_frame(frame).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(saved.get("reported_cwd").is_none());
        assert!(saved["projection"].get("cwd_report").is_none());
        assert_eq!(saved["projection"]["data"], "scene");
    }

    #[test]
    fn a05a3_saved_full_frames_preserve_and_validate_capacity() {
        for capacity in [200, 500, 2000] {
            let value = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":0,"data":"ALT","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"alternate","retained_lines":capacity},"end_offset":42,"status":"stopped"});
            let frame: super::TerminalFrame = serde_json::from_value(value).unwrap();
            let bytes = super::encode_final_frame(frame).unwrap();
            let restored = super::decode_saved_frame(&bytes, "s-one", "stopped", 42).unwrap();
            assert_eq!(restored.projection["retained_lines"], capacity);
            let mut bad: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            bad["projection"]["retained_lines"] = serde_json::Value::Null;
            assert!(super::decode_saved_frame(
                &serde_json::to_vec(&bad).unwrap(),
                "s-one",
                "stopped",
                42
            )
            .is_err());
        }
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
        assert_eq!(adapters.len(), 5);
        assert_eq!(adapters[0].id, "shell");
        assert!(adapters[0].available);
        assert!(adapters.iter().any(|adapter| adapter.id == "codex"));
        assert!(adapters.iter().any(|adapter| adapter.id == "claude"));
        assert!(adapters.iter().any(|adapter| adapter.id == "gemini"));
    }

    #[test]
    fn history_marks_interrupted_sessions_for_attention() {
        let root = std::env::temp_dir().join(format!("yam-history-test-{}", next_session_id()));
        let history = HistoryStore::open(root.clone()).expect("open history");
        let summary = SessionSummary {
            ssh: None,
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
        let root = std::env::temp_dir().join(format!(
            "yam-review-test-{}-{}",
            std::process::id(),
            next_session_id()
        ));
        let summary = SessionSummary {
            ssh: None,
            session_id: "s-test".into(),
            cwd: "/tmp".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        (root, summary)
    }

    #[test]
    fn history_test_directories_are_process_scoped_and_unique() {
        let (first, _) = test_history();
        let (second, _) = test_history();
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&format!("yam-review-test-{}-", std::process::id())));
        assert_ne!(first, second);
    }

    #[test]
    fn closure_t15_notification_link_never_selects_missing_or_deleted_history() {
        use tauri::Manager;
        let (root, summary) = test_history();
        let history = Arc::new(HistoryStore::open(root.clone()).unwrap());
        history.start(&summary).unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        let manager = SessionManager::default();
        *manager.history.lock().unwrap() = Some(history.clone());
        app.manage(manager);
        for link in [
            "yam://session/s-missing",
            "yam://session/s-test?owner=old",
            "https://session/s-test",
        ] {
            assert!(crate::route_notification_link(app.handle(), link).is_err());
            assert!(app
                .state::<SessionManager>()
                .notification_selection
                .lock()
                .unwrap()
                .is_none());
        }
        crate::route_notification_link(app.handle(), "yam://session/s-test").unwrap();
        assert_eq!(
            app.state::<SessionManager>()
                .notification_selection
                .lock()
                .unwrap()
                .as_deref(),
            Some("s-test")
        );
        history.records.lock().unwrap().clear();
        assert!(crate::route_notification_link(app.handle(), "yam://session/s-test").is_err());
        assert_eq!(
            app.state::<SessionManager>()
                .notification_selection
                .lock()
                .unwrap()
                .as_deref(),
            Some("s-test")
        );
        assert!(app
            .state::<SessionManager>()
            .sessions
            .lock()
            .unwrap()
            .is_empty());
        drop(app);
        drop(history);
        std::fs::remove_dir_all(root).unwrap();
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
        #[cfg(windows)]
        let builder = shell_command(Some(command));
        #[cfg(not(windows))]
        let builder = {
            // Worker fixtures must not inherit login-shell profiles or Zsh's delayed PTY teardown.
            let mut builder = CommandBuilder::new("/bin/sh");
            builder.arg("-c");
            builder.arg(command);
            builder
        };
        let child = pair.slave.spawn_command(builder).unwrap();
        #[cfg(unix)]
        let process_identity = child
            .process_id()
            .and_then(|pid| super::memory::process_identity(pid).map(|stamp| (pid, stamp)));
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(history.log_path(&summary.session_id))
            .unwrap();
        let session = std::sync::Arc::new(super::Session {
            _directory_reporting_assets: None,
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
            pending_finish: std::sync::Mutex::new(None),
            exit_observation_fault: None,
            cleanup_done: std::sync::atomic::AtomicBool::new(false),
            #[cfg(unix)]
            process_identity,
            last_activity: std::sync::Mutex::new(std::time::Instant::now()),
            status: std::sync::Mutex::new("running".into()),
        });
        (session, reader, root)
    }

    #[cfg(unix)]
    #[test]
    fn test_session_fixture_uses_a_fixed_non_login_shell() {
        let (session, mut reader, root) = test_session("printf '%s' \"$0\"");
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        session.child.lock().unwrap().wait().unwrap();
        assert_eq!(output, "/bin/sh");
        drop(reader);
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
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
        use tauri::Manager;
        let app = tauri::test::mock_app();
        app.manage(super::SessionManager::default());
        let manager = app.state::<super::SessionManager>();
        let (session, reader, root) = test_session(if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        });
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(session.summary.session_id.clone(), session.clone());
        let background = super::spawn_session_threads_with(
            app.handle(),
            manager.sessions.clone(),
            session.clone(),
            reader,
            |_, _, _| {},
        );
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let session = session.clone();
                std::thread::spawn(move || super::request_session_stop(&session))
            })
            .collect();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        manager.shutdown().unwrap();
        background.0.join().unwrap();
        background.1.join().unwrap();
        assert!(session.child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(*session.completed.0.lock().unwrap());
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
        use tauri::Manager;
        let app = tauri::test::mock_app();
        app.manage(super::SessionManager::default());
        let manager = app.state::<super::SessionManager>();
        let (session, reader, root) = test_session(if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        });
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(session.summary.session_id.clone(), session.clone());
        let workers = super::spawn_session_threads_with(
            app.handle(),
            manager.sessions.clone(),
            session.clone(),
            reader,
            |_, _, _| {},
        );
        manager.shutdown().unwrap();
        workers.0.join().unwrap();
        workers.1.join().unwrap();
        assert!(session.child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(*session.output_done.0.lock().unwrap());
        assert!(*session.completed.0.lock().unwrap());
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
            ssh: None,
            session_id: "resume-source".into(),
            cwd: root.to_string_lossy().into(),
            command: None,
            status: "stopped".into(),
            launch: Some(super::AgentLaunch {
                codex: None,
                provider: None,
                env_refs: Default::default(),
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
            codex: None,
            provider: None,
            env_refs: Default::default(),
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
            codex: None,
            provider: None,
            env_refs: Default::default(),
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
            codex: None,
            provider: None,
            env_refs: Default::default(),
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
            codex: None,
            provider: None,
            env_refs: Default::default(),
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

    use super::output_stage_enabled;
    #[cfg(unix)]
    use super::{run_output_worker, terminal_runtime, OutputStages, TerminalAttachment};
    #[cfg(unix)]
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[test]
    fn output_stage_enablement_requires_developer_owner_and_explicit_one() {
        assert!(output_stage_enabled(true, true, Some("1")));
        for (developer, owner, value) in [
            (false, true, Some("1")),
            (true, false, Some("1")),
            (true, true, None),
            (true, true, Some("true")),
        ] {
            assert!(!output_stage_enabled(developer, owner, value));
        }
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_worker_counts_raw_utf8_flush_and_emits_after_barrier_once() {
        use std::collections::VecDeque;
        struct Reads(VecDeque<Vec<u8>>);
        impl Read for Reads {
            fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
                assert_eq!(into.len(), 4096);
                let Some(value) = self.0.pop_front() else {
                    return Ok(0);
                };
                into[..value.len()].copy_from_slice(&value);
                Ok(value.len())
            }
        }
        let app = tauri::test::mock_app();
        let (mut session, _, root) = test_session("exit 0");
        session.child.lock().unwrap().wait().unwrap();
        let fixture = terminal_runtime::tests::stage_fixture(false);
        let id = session.summary.session_id.clone();
        Arc::get_mut(&mut session).unwrap().terminal = Some(TerminalAttachment {
            command_reporting: false,
            runtime: fixture.runtime.clone(),
            session: id,
            reported: AtomicBool::new(false),
        });
        let mut reader = Reads(VecDeque::from([
            vec![0xe4, 0xb8],
            vec![0xad],
            vec![b'x'; 4096],
            vec![0xe4],
        ]));
        let mut emitted = 0;
        run_output_worker(
            app.handle(),
            &session,
            &mut reader,
            || Ok(true),
            Some(OutputStages::default()),
            |row| {
                emitted += 1;
                assert!(*session.output_done.0.lock().unwrap());
                assert!(session.log.try_lock().is_ok());
                assert!(session.protocol.try_lock().is_ok());
                fixture
                    .runtime
                    .call("write", "lock-free", serde_json::json!({}))
                    .unwrap();
                assert_eq!(
                    (row.read_count, row.read_bytes, row.read_min, row.read_max),
                    (4, 4100, 1, 4096)
                );
                assert_eq!(row.read_buckets, [3, 0, 0, 1]);
                assert_eq!(row.publish_count, 3);
                assert_eq!(row.publish_bytes, 4102);
                assert_eq!(row.log_wait.count, 3);
                assert_eq!(row.parser_total.count, 3);
                assert_eq!(row.parser.replies, [3, 0, 0]);
                assert_eq!(row.append.count, 3);
                assert_eq!(row.emit.count, 3);
                assert!(!row.overflow);
                let bytes = serde_json::to_vec(row).unwrap();
                assert!(bytes.len() + "YAM_OUTPUT_STAGES_V1 ".len() <= 2048);
                assert!(!String::from_utf8(bytes)
                    .unwrap()
                    .contains(&session.summary.session_id));
            },
        );
        assert_eq!(emitted, 1);
        assert_eq!(session.log.lock().unwrap().end_offset, 4102);
        drop(session);
        drop(fixture);
        let _ = std::fs::remove_dir_all(root);
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_worker_parser_error_keeps_log_emit_and_disabled_has_no_summary() {
        let app = tauri::test::mock_app();
        let (mut session, _, root) = test_session("exit 0");
        session.child.lock().unwrap().wait().unwrap();
        let fixture = terminal_runtime::tests::stage_fixture(true);
        let id = session.summary.session_id.clone();
        Arc::get_mut(&mut session).unwrap().terminal = Some(TerminalAttachment {
            command_reporting: false,
            runtime: fixture.runtime.clone(),
            session: id,
            reported: AtomicBool::new(false),
        });
        let mut reader = std::io::Cursor::new(b"hello");
        let mut reports = 0;
        run_output_worker(
            app.handle(),
            &session,
            &mut reader,
            || Ok(true),
            Some(OutputStages::default()),
            |row| {
                reports += 1;
                assert_eq!(row.parser_total.errors, 1);
                assert_eq!(row.parser.replies, [0, 1, 0]);
                assert_eq!(row.append.count, 1);
                assert_eq!(row.emit.count, 1);
                assert_eq!(row.publish_bytes, 5);
            },
        );
        assert_eq!(reports, 1);
        assert_eq!(session.log.lock().unwrap().end_offset, 5);
        run_output_worker(
            app.handle(),
            &session,
            &mut std::io::Cursor::new(b"x"),
            || Ok(true),
            None,
            |_| panic!("disabled summary"),
        );
        assert_eq!(session.log.lock().unwrap().end_offset, 6);
        drop(session);
        drop(fixture);
        let _ = std::fs::remove_dir_all(root);
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_worker_cancel_read_error_and_poison_still_finalize_once() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("synthetic read error"))
            }
        }
        let app = tauri::test::mock_app();
        let (session, _, root) = test_session("exit 0");
        session.child.lock().unwrap().wait().unwrap();
        let mut reports = 0;
        run_output_worker(
            app.handle(),
            &session,
            &mut Broken,
            || Ok(true),
            Some(OutputStages::default()),
            |row| {
                reports += 1;
                assert_eq!(row.read_errors, 1);
                assert!(*session.output_done.0.lock().unwrap());
            },
        );
        run_output_worker(
            app.handle(),
            &session,
            &mut Broken,
            || Ok(false),
            Some(OutputStages::default()),
            |row| {
                reports += 1;
                assert_eq!(row.read_count, 0);
                assert_eq!(row.read_errors, 0);
            },
        );
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| {
                let _guard = session.log.lock().unwrap();
                panic!("intentional log poison")
            });
            assert!(handle.join().is_err());
        });
        run_output_worker(
            app.handle(),
            &session,
            &mut std::io::Cursor::new(b"x"),
            || Ok(true),
            Some(OutputStages::default()),
            |row| {
                reports += 1;
                assert_eq!(row.log_wait.errors, 1);
                assert_eq!(row.append.count, 0);
                assert_eq!(row.emit.count, 0);
            },
        );
        assert_eq!(reports, 3);
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn output_stage_actual_worker_log_error_still_emits_original_output() {
        let app = tauri::test::mock_app();
        let (session, _, root) = test_session("exit 0");
        session.child.lock().unwrap().wait().unwrap();
        session.log.lock().unwrap().file =
            std::fs::File::open(session.history.log_path(&session.summary.session_id)).unwrap();
        let mut reports = 0;
        run_output_worker(
            app.handle(),
            &session,
            &mut std::io::Cursor::new(b"persist-error"),
            || Ok(true),
            Some(OutputStages::default()),
            |row| {
                reports += 1;
                assert_eq!(row.append.count, 1);
                assert_eq!(row.append.errors, 1);
                assert_eq!(row.emit.count, 1);
                assert_eq!(row.parser_total.count, 0);
            },
        );
        assert_eq!(reports, 1);
        assert_eq!(session.log.lock().unwrap().end_offset, 13);
        assert!(session.log.lock().unwrap().error.is_some());
        drop(session);
        let _ = std::fs::remove_dir_all(root);
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
        let before_counter = SESSION_ID_ALLOCATIONS.with(|count| count.get());
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
            assert_eq!(
                SESSION_ID_ALLOCATIONS.with(|count| count.get()),
                before_counter
            );
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
        let before_counter = SESSION_ID_ALLOCATIONS.with(|count| count.get());
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
            assert_eq!(
                SESSION_ID_ALLOCATIONS.with(|count| count.get()),
                before_counter
            );
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
            let before_counter = SESSION_ID_ALLOCATIONS.with(|count| count.get());
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
            assert_eq!(
                SESSION_ID_ALLOCATIONS.with(|count| count.get()),
                before_counter
            );
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
                ssh: None,
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
            ssh: None,
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
            ssh: None,
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

#[cfg(test)]
mod a01a_home_tests {
    use super::*;

    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-a01a-{}-{}-{}",
                std::process::id(),
                unix_timestamp_millis(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            A01A_HOME_OVERRIDE.with(|value| *value.borrow_mut() = None);
            A01A_HOME_CALLS.with(|count| count.set(0));
            A01A_ALLOCATION_CWD.with(|value| *value.borrow_mut() = None);
            Self(root)
        }
        fn home(&self, result: Result<PathBuf, String>) {
            A01A_HOME_OVERRIDE.with(|value| *value.borrow_mut() = Some(result));
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            A01A_HOME_OVERRIDE.with(|value| *value.borrow_mut() = None);
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a01a_selection_resolves_home_once_for_absent_and_blank_ordinary_cwd() {
        let fixture = Fixture::new();
        for cwd in [None, Some(String::new()), Some(" \t\n".into())] {
            let calls = std::cell::Cell::new(0);
            let (chosen, initial) = resolve_owner_cwd(
                cwd,
                true,
                || {
                    calls.set(calls.get() + 1);
                    Ok(fixture.0.clone())
                },
                || panic!("ordinary shell must not query process cwd"),
            )
            .unwrap();
            assert_eq!(chosen.as_deref(), fixture.0.to_str());
            assert_eq!(initial, fixture.0);
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn a01a_selection_preserves_explicit_path_literal_without_resolvers() {
        for ordinary in [true, false] {
            let literal = " /literal path with spaces/ ".to_string();
            let (chosen, initial) = resolve_owner_cwd(
                Some(literal.clone()),
                ordinary,
                || panic!("explicit cwd must not query home"),
                || panic!("explicit cwd must not query process cwd"),
            )
            .unwrap();
            assert_eq!(chosen, Some(literal.clone()));
            assert_eq!(initial, PathBuf::from(literal));
        }
    }

    #[test]
    fn a01a_selection_rejects_invalid_home_without_process_cwd_fallback() {
        let fixture = Fixture::new();
        let file = fixture.0.join("file");
        fs::write(&file, "fixture").unwrap();
        for home in [
            PathBuf::new(),
            PathBuf::from("relative"),
            PathBuf::from("/bad\0home"),
            file,
            fixture.0.join("missing"),
        ] {
            assert_eq!(
                resolve_owner_cwd(
                    None,
                    true,
                    || Ok(home),
                    || panic!("invalid home must not fall back")
                )
                .unwrap_err(),
                "Home directory must be an absolute existing directory"
            );
        }
        assert_eq!(
            resolve_owner_cwd(
                None,
                true,
                || Err("resolver failed".into()),
                || panic!("missing home must not fall back")
            )
            .unwrap_err(),
            "Cannot resolve home directory: resolver failed"
        );
    }

    #[test]
    fn a01a_nonordinary_missing_and_blank_cwd_keep_previous_preflight_policy() {
        let fixture = Fixture::new();
        let (chosen, initial) = resolve_owner_cwd(
            None,
            false,
            || panic!("nonordinary must not query home"),
            || Ok(fixture.0.clone()),
        )
        .unwrap();
        assert_eq!(chosen, None);
        assert_eq!(initial, fixture.0);
        for literal in ["", " \t"] {
            let (chosen, initial) = resolve_owner_cwd(
                Some(literal.into()),
                false,
                || panic!("nonordinary must not query home"),
                || panic!("supplied nonordinary cwd remains literal"),
            )
            .unwrap();
            assert_eq!(chosen.as_deref(), Some(literal));
            assert_eq!(initial, PathBuf::from(literal));
        }
        assert_eq!(
            resolve_owner_cwd(
                None,
                false,
                || panic!("no home"),
                || Err("current unavailable".into())
            )
            .unwrap_err(),
            "worktree_invalid_target"
        );
    }

    #[test]
    fn a01a_actual_owner_preflight_uses_selected_home_without_allocating_resources() {
        let _owner_test = worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        fixture.home(Ok(fixture.0.clone()));
        // A local yam.json is not an instruction to launch an Agent.
        fs::write(fixture.0.join("yam.json"), "untrusted malformed config").unwrap();
        for cwd in [None, Some(" \t".into())] {
            let manager = SessionManager::default();
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            assert_eq!(
                create_session_owner_with_worktree(
                    None,
                    &manager,
                    &fixture.0.join("private"),
                    cwd,
                    None,
                    None,
                    None,
                    None,
                    None
                )
                .unwrap_err(),
                "test_entry_reached_allocation"
            );
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 1);
            assert_eq!(
                A01A_ALLOCATION_CWD.with(|value| value.borrow().clone()),
                Some(fixture.0.clone())
            );
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert!(!fixture.0.join("private").exists());
        }
        assert_eq!(A01A_HOME_CALLS.with(|count| count.get()), 2);
    }

    #[test]
    fn a01a_actual_owner_rejects_invalid_home_before_preflight_and_allocation() {
        let _owner_test = worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        let file = fixture.0.join("file");
        fs::write(&file, "fixture").unwrap();
        for home in [
            PathBuf::new(),
            PathBuf::from("relative"),
            PathBuf::from("/bad\0home"),
            file,
            fixture.0.join("missing"),
        ] {
            fixture.home(Ok(home));
            let manager = SessionManager::default();
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let before_counter = SESSION_ID_ALLOCATIONS.with(|count| count.get());
            assert_eq!(
                create_session_owner_with_worktree(
                    None,
                    &manager,
                    &fixture.0.join("private"),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None
                )
                .unwrap_err(),
                "Home directory must be an absolute existing directory"
            );
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
            assert_eq!(
                SESSION_ID_ALLOCATIONS.with(|count| count.get()),
                before_counter
            );
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert!(!fixture.0.join("private").exists());
        }
    }

    #[test]
    fn a01a_actual_owner_excludes_explicit_agent_custom_resume_project_and_worktree() {
        let _owner_test = worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        fixture.home(Err("must not query home".into()));
        let launch = || AgentLaunch {
            codex: None,
            provider: None,
            env_refs: Default::default(),
            adapter: "codex".into(),
            mode: "interactive".into(),
            extra_args: String::new(),
            prompt: None,
        };
        let manager = SessionManager::default();
        for (cwd, command, agent, resume, attempt, expected) in [
            (
                Some(fixture.0.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                "test_entry_reached_allocation",
            ),
            (
                None,
                Some("echo literal".into()),
                None,
                None,
                None,
                "test_entry_reached_allocation",
            ),
            (
                None,
                Some(String::new()),
                None,
                None,
                None,
                "test_entry_reached_allocation",
            ),
            (
                None,
                None,
                Some(launch()),
                None,
                None,
                "test_entry_reached_allocation",
            ),
            (
                None,
                None,
                None,
                Some("retained-source".into()),
                None,
                "test_entry_reached_allocation",
            ),
            (
                None,
                None,
                None,
                None,
                Some("unknown".into()),
                "worktree_unknown_attempt",
            ),
        ] {
            assert_eq!(
                create_session_owner_with_worktree(
                    None,
                    &manager,
                    &fixture.0.join("private"),
                    cwd,
                    command,
                    agent,
                    resume,
                    None,
                    attempt
                )
                .unwrap_err(),
                expected
            );
        }
        let project = serde_json::from_value(
            serde_json::json!({"root":fixture.0,"template":null,"overrides":{}}),
        )
        .unwrap();
        assert_eq!(
            create_session_owner_with_worktree(
                None,
                &manager,
                &fixture.0.join("private"),
                None,
                None,
                None,
                None,
                Some(project),
                None
            )
            .unwrap_err(),
            "project_config_untrusted"
        );
        assert_eq!(A01A_HOME_CALLS.with(|count| count.get()), 0);
    }

    #[test]
    fn a01a_ordinary_missing_home_fails_before_allocation() {
        let _owner_test = worktree_manager::serial_owner_test();
        let manager = SessionManager::default();
        T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let error = create_session_owner_with_worktree(
            None,
            &manager,
            &std::env::temp_dir(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "Cannot resolve home directory: Application handle unavailable"
        );
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod a01b_shell_tests {
    use super::*;
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-a01b-{}-{}-{}",
                std::process::id(),
                unix_timestamp_millis(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn executable(&self, name: &str) -> PathBuf {
            let directory = self.0.join("installed shells 中文");
            fs::create_dir_all(&directory).unwrap();
            let program = directory.join(name);
            fs::write(&program, "fixture; never executed").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
            }
            program
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn config(program: Option<&Path>, login: Option<bool>) -> ShellLaunch {
        ShellLaunch {
            program: program.map(|p| p.to_str().unwrap().to_owned()),
            login,
        }
    }
    #[test]
    fn a01b_nullable_fields_are_required_and_unknown_keys_rejected() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"program":null}),
            serde_json::json!({"login":false}),
            serde_json::json!({"program":null,"login":false,"argv":[]}),
            serde_json::json!({"program":0,"login":true}),
        ] {
            assert!(serde_json::from_value::<ShellLaunch>(value).is_err());
        }
        assert!(serde_json::from_value::<ShellLaunch>(
            serde_json::json!({"program":null,"login":null})
        )
        .is_ok());
    }
    #[test]
    fn a01b_proxy_omits_absence_and_preserves_literal_shell() {
        let legacy = create_session_arguments(
            &None, &None, &None, &None, &None, &None, &None, &None, &None, &None, &None, &None,
        )
        .unwrap();
        assert!(legacy.get("shell").is_none());
        let shell = config(Some(Path::new("/literal spaces 中文/bash")), Some(false));
        let payload = create_session_arguments(
            &Some("/home".into()),
            &None,
            &None,
            &None,
            &None,
            &None,
            &Some(shell.clone()),
            &None,
            &None,
            &None,
            &None,
            &None,
        )
        .unwrap();
        assert_eq!(payload["shell"], serde_json::to_value(shell).unwrap());
        assert_eq!(payload["command"], serde_json::Value::Null);
    }
    #[cfg(unix)]
    #[test]
    fn a01b_known_shell_argv_is_interactive_and_login_is_explicit() {
        let fixture = Fixture::new();
        for name in ["bash", "zsh", "fish"] {
            let program = fixture.executable(name);
            for login in [false, true] {
                let shell = config(Some(&program), Some(login));
                let builder =
                    ordinary_shell_command(&shell, || panic!("explicit never resolves default"))
                        .unwrap();
                let expected = if login {
                    vec![
                        program.as_os_str(),
                        std::ffi::OsStr::new("-i"),
                        std::ffi::OsStr::new("-l"),
                    ]
                } else {
                    vec![program.as_os_str(), std::ffi::OsStr::new("-i")]
                };
                assert_eq!(builder.get_argv(), &expected);
            }
        }
        let program = fixture.executable("bash");
        let builder = ordinary_shell_command(&config(None, Some(false)), || {
            program.clone().into_os_string()
        })
        .unwrap();
        assert_eq!(builder.get_argv()[0], program.as_os_str());
        assert_eq!(builder.get_argv().len(), 2);
        assert_eq!(shell_command(None).get_argv()[1], "-l");
        let command = shell_command(Some("literal $(text)"));
        assert_eq!(&command.get_argv()[1..], &["-l", "-c", "literal $(text)"]);
    }
    #[cfg(windows)]
    #[test]
    fn a01b_windows_cmd_has_autorun_disabled_without_login_arguments() {
        let fixture = Fixture::new();
        let program = fixture.executable("CMD.EXE");
        let builder =
            ordinary_shell_command(&config(Some(&program), None), || panic!("explicit")).unwrap();
        assert_eq!(
            builder.get_argv(),
            &vec![program.as_os_str(), std::ffi::OsStr::new("/D")]
        );
        assert!(
            ordinary_shell_command(&config(Some(&program), Some(false)), || panic!("explicit"))
                .is_err()
        );
        assert_eq!(shell_command(None).get_argv()[1], "/D");
    }
    #[test]
    fn a01b_invalid_program_syntax_and_utf8_budget_are_bounded() {
        #[cfg(unix)]
        let login = Some(false);
        #[cfg(windows)]
        let login = None;
        for program in [
            "",
            " \t",
            "relative",
            "/bad\0bash",
            "/bad\nbash",
            "/bad\u{2028}bash",
        ] {
            assert!(validate_shell_launch(&ShellLaunch {
                program: Some(program.into()),
                login
            })
            .is_err());
        }
        #[cfg(unix)]
        {
            let bound = format!("/{}", "中".repeat(1365));
            assert_eq!(bound.len(), 4096);
            assert!(validate_shell_launch(&ShellLaunch {
                program: Some(bound.clone()),
                login
            })
            .is_ok());
            assert!(validate_shell_launch(&ShellLaunch {
                program: Some(format!("{bound}x")),
                login
            })
            .is_err());
            assert!(validate_shell_launch(&config(None, None)).is_err());
        }
        #[cfg(windows)]
        assert!(validate_shell_launch(&config(None, Some(true))).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a01b_file_validation_rejects_missing_directory_nonexecutable_and_unknown_default() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        for program in [fixture.0.join("missing/bash"), fixture.0.clone()] {
            assert!(
                ordinary_shell_command(&config(Some(&program), Some(true)), || panic!("explicit"))
                    .is_err()
            );
        }
        let program = fixture.executable("bash");
        fs::set_permissions(&program, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            ordinary_shell_command(&config(Some(&program), Some(false)), || panic!("explicit"))
                .unwrap_err(),
            "shell_unavailable"
        );
        for name in ["sh", "unknown"] {
            let unknown = fixture.executable(name);
            assert_eq!(
                ordinary_shell_command(&config(None, Some(false)), || unknown.into_os_string())
                    .unwrap_err(),
                "shell_unsupported"
            );
        }
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let link = fixture.0.join("zsh");
        std::os::unix::fs::symlink(&program, &link).unwrap();
        assert_eq!(
            ordinary_shell_command(&config(Some(&link), Some(false)), || panic!("explicit"))
                .unwrap()
                .get_argv()[0],
            link.as_os_str()
        );
    }
    #[test]
    fn a01b_owner_rejects_every_combination_before_allocation() {
        let _serial = worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        let manager = SessionManager::default();
        #[cfg(unix)]
        let shell = config(None, Some(false));
        #[cfg(windows)]
        let shell = config(None, None);
        for index in 0..5 {
            T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let before = SESSION_ID_ALLOCATIONS.with(|count| count.get());
            let command = (index == 0).then(String::new);
            let launch = (index == 1).then(|| AgentLaunch {
                codex: None,
                provider: None,
                env_refs: Default::default(),
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: None,
            });
            let resume = (index == 2).then(|| "stored".into());
            let project = (index == 3).then(|| project_config::ProjectStart {
                root: fixture.0.to_str().unwrap().into(),
                template: None,
                overrides: project_config::LaunchSettings::default(),
            });
            let worktree = (index == 4).then(|| "a".repeat(64));
            assert_eq!(
                create_session_owner_with_shell(
                    None,
                    &manager,
                    &fixture.0.join("private"),
                    None,
                    command,
                    launch,
                    resume,
                    project,
                    worktree,
                    Some(shell.clone()),
                    None,
                )
                .unwrap_err(),
                "shell_invalid_combination"
            );
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
            assert_eq!(SESSION_ID_ALLOCATIONS.with(|count| count.get()), before);
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert!(manager.history.lock().unwrap().is_none());
            assert!(!fixture.0.join("private").exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn a01b_owner_validates_executable_before_worktree_preflight() {
        let _serial = worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        let manager = SessionManager::default();
        let missing = fixture.0.join("bash");
        T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        assert_eq!(
            create_session_owner_with_shell(
                None,
                &manager,
                &fixture.0.join("private"),
                Some(fixture.0.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                None,
                Some(config(Some(&missing), Some(false))),
                None,
            )
            .unwrap_err(),
            "shell_unavailable"
        );
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        assert!(!fixture.0.join("private").exists());
        let program = fixture.executable("bash");
        assert_eq!(
            create_session_owner_with_shell(
                None,
                &manager,
                &fixture.0.join("private"),
                Some(fixture.0.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                None,
                Some(config(Some(&program), Some(false))),
                None,
            )
            .unwrap_err(),
            "test_entry_reached_allocation"
        );
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 1);
        assert_eq!(
            A01A_ALLOCATION_CWD.with(|v| v.borrow().clone()),
            Some(fixture.0.clone())
        );
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod a02b_profile_env_tests {
    use super::*;
    #[test]
    fn a02b_owner_legacy_refs_fail_before_allocation() {
        let _serial = worktree_manager::serial_owner_test();
        let manager = SessionManager::default();
        T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
        let root = std::env::temp_dir();
        let refs = std::collections::BTreeMap::from([("TARGET".into(), "SOURCE".into())]);
        assert_eq!(
            create_session_owner_with_shell(
                None,
                &manager,
                &root.join("yam-a02b-no-private"),
                Some(root.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                None,
                None,
                Some(refs)
            )
            .unwrap_err(),
            "profile_env_shell_required"
        );
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|v| v.get()), 0);
    }
    #[test]
    fn a02b_resolver_snapshots_literal_values_and_checks_budgets() {
        use std::cell::RefCell;
        use std::ffi::OsString;
        let refs = std::collections::BTreeMap::from([
            ("A".into(), "B".into()),
            ("B".into(), "C".into()),
            ("D".into(), "B".into()),
        ]);
        let calls = RefCell::new(Vec::new());
        let resolved = resolve_profile_env(&refs, &|key| {
            calls.borrow_mut().push(key.to_string());
            Some(OsString::from(if key == "B" {
                "空 格\n;$(synthetic)"
            } else {
                ""
            }))
        })
        .unwrap();
        assert_eq!(resolved["A"], "空 格\n;$(synthetic)");
        assert_eq!(resolved["D"], resolved["A"]);
        assert_eq!(resolved["B"], "");
        assert_eq!(*calls.borrow(), vec!["B", "C"]);
        let one = std::collections::BTreeMap::from([("T".into(), "S".into())]);
        assert_eq!(
            resolve_profile_env(&one, &|_| None).unwrap_err(),
            "profile_env_missing"
        );
        assert_eq!(
            resolve_profile_env(&one, &|_| Some(OsString::from("a\0b"))).unwrap_err(),
            "profile_env_invalid_value"
        );
        assert!(resolve_profile_env(&one, &|_| Some(OsString::from("x".repeat(16384)))).is_ok());
        assert_eq!(
            resolve_profile_env(&one, &|_| Some(OsString::from("x".repeat(16385)))).unwrap_err(),
            "profile_env_budget"
        );
        let four = std::collections::BTreeMap::from([
            ("A".into(), "S".into()),
            ("B".into(), "S".into()),
            ("C".into(), "S".into()),
            ("D".into(), "S".into()),
        ]);
        assert!(resolve_profile_env(&four, &|_| Some(OsString::from("x".repeat(16383)))).is_ok());
        assert_eq!(
            resolve_profile_env(&four, &|_| Some(OsString::from("x".repeat(16384)))).unwrap_err(),
            "profile_env_budget"
        );
    }
    #[test]
    fn a02b_platform_targets_are_pure_and_sources_remain_allowed() {
        for (target, windows) in [("SHELL", false), ("UserProfile", true), ("pathext", true)] {
            assert_eq!(
                validate_profile_env_refs(
                    &std::collections::BTreeMap::from([(target.into(), "SOURCE".into())]),
                    windows
                )
                .unwrap_err(),
                "profile_env_unsupported_target"
            );
        }
        for (target, source, windows) in [
            ("shell", "SHELL", false),
            ("TARGET", "USERPROFILE", true),
            ("SHELL", "SOURCE", true),
            ("ComSpec", "SOURCE", true),
            ("PATH", "SOURCE", true),
        ] {
            assert!(validate_profile_env_refs(
                &std::collections::BTreeMap::from([(target.into(), source.into())]),
                windows
            )
            .is_ok());
        }
    }
    #[cfg(unix)]
    #[test]
    fn a02b_nonunicode_is_invalid_not_missing() {
        use std::os::unix::ffi::OsStringExt;
        let refs = std::collections::BTreeMap::from([("T".into(), "S".into())]);
        assert_eq!(
            resolve_profile_env(&refs, &|_| Some(std::ffi::OsString::from_vec(vec![255])))
                .unwrap_err(),
            "profile_env_invalid_value"
        );
    }
    #[cfg(windows)]
    #[test]
    fn a02b_nonunicode_is_invalid_not_missing() {
        use std::os::windows::ffi::OsStringExt;
        let refs = std::collections::BTreeMap::from([("T".into(), "S".into())]);
        assert_eq!(
            resolve_profile_env(&refs, &|_| Some(std::ffi::OsString::from_wide(&[0xd800])))
                .unwrap_err(),
            "profile_env_invalid_value"
        );
    }
    #[test]
    fn a02b_spawn_failure_never_formats_values_and_reuses_reason_for_outputs() {
        struct Secret(std::cell::Cell<usize>);
        impl std::fmt::Display for Secret {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.set(self.0.get() + 1);
                write!(f, "SYNTHETIC_SECRET")
            }
        }
        let secret = Secret(std::cell::Cell::new(0));
        let history = std::cell::RefCell::new(String::new());
        let event = std::cell::RefCell::new(String::new());
        let reply: Result<(), String> = report_spawn_failure(
            &secret,
            true,
            |reason| {
                *history.borrow_mut() = reason.into();
                Ok(())
            },
            |reason| *event.borrow_mut() = reason.into(),
        );
        assert_eq!(reply.unwrap_err(), "profile_env_start_failed");
        assert_eq!(*history.borrow(), "profile_env_start_failed");
        assert_eq!(*event.borrow(), "profile_env_start_failed");
        assert_eq!(secret.0.get(), 0);
    }

    #[test]
    fn a02b_owner_invalid_refs_never_lookup_or_allocate() {
        let _serial = worktree_manager::serial_owner_test();
        let manager = SessionManager::default();
        let root = std::env::temp_dir();
        let shell = ShellLaunch {
            program: Some(
                root.join(if cfg!(windows) { "cmd.exe" } else { "bash" })
                    .to_str()
                    .unwrap()
                    .into(),
            ),
            login: if cfg!(windows) { None } else { Some(false) },
        };
        let blocked = if cfg!(windows) {
            "UserProfile"
        } else {
            "SHELL"
        };
        for (refs, expected) in [
            (
                std::collections::BTreeMap::from([(blocked.into(), "SOURCE".into())]),
                "profile_env_unsupported_target",
            ),
            (
                std::collections::BTreeMap::from([
                    ("Path".into(), "SOURCE".into()),
                    ("PATH".into(), "SOURCE".into()),
                ]),
                "profile_env_invalid",
            ),
            (
                std::collections::BTreeMap::from([("TARGET".into(), "yam_SOURCE".into())]),
                "profile_env_invalid",
            ),
        ] {
            A02B_ENV_CALLS.with(|v| v.set(0));
            T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
            assert_eq!(
                create_session_owner_with_shell(
                    None,
                    &manager,
                    &root,
                    Some(root.to_str().unwrap().into()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(shell.clone()),
                    Some(refs)
                )
                .unwrap_err(),
                expected
            );
            assert_eq!(A02B_ENV_CALLS.with(|v| v.get()), 0);
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|v| v.get()), 0);
        }
        for index in 0..5 {
            A02B_ENV_CALLS.with(|v| v.set(0));
            T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
            let command = (index == 0).then(String::new);
            let launch = (index == 1).then(|| AgentLaunch {
                codex: None,
                provider: None,
                env_refs: Default::default(),
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: None,
            });
            let resume = (index == 2).then(|| "stored".into());
            let project = (index == 3).then(|| project_config::ProjectStart {
                root: root.to_str().unwrap().into(),
                template: None,
                overrides: project_config::LaunchSettings::default(),
            });
            let worktree = (index == 4).then(|| "a".repeat(64));
            assert_eq!(
                create_session_owner_with_shell(
                    None,
                    &manager,
                    &root,
                    None,
                    command,
                    launch,
                    resume,
                    project,
                    worktree,
                    Some(shell.clone()),
                    Some(std::collections::BTreeMap::from([(
                        "TARGET".into(),
                        "SOURCE".into()
                    )]))
                )
                .unwrap_err(),
                "profile_env_invalid_combination"
            );
            assert_eq!(A02B_ENV_CALLS.with(|v| v.get()), 0);
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|v| v.get()), 0);
        }
    }
    #[test]
    fn a02b_owner_resolves_once_before_allocation_and_builder_keeps_program_and_cwd() {
        let _serial = worktree_manager::serial_owner_test();
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "yam-a02b-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        struct Clean(PathBuf);
        impl Drop for Clean {
            fn drop(&mut self) {
                A02B_ENV_OVERRIDE.with(|v| *v.borrow_mut() = None);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clean = Clean(root.clone());
        let program = root.join(if cfg!(windows) { "cmd.exe" } else { "bash" });
        std::fs::write(&program, b"synthetic executable, never spawned").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let shell = ShellLaunch {
            program: Some(program.to_str().unwrap().into()),
            login: if cfg!(windows) { None } else { Some(false) },
        };
        let manager = SessionManager::default();
        let refs = std::collections::BTreeMap::from([
            ("HOME".into(), "SOURCE".into()),
            ("PATH".into(), "SOURCE".into()),
            ("ComSpec".into(), "SOURCE".into()),
        ]);
        for value in [None, Some("literal 空格;$(noexec)"), Some("bad\0value")] {
            A02B_ENV_OVERRIDE.with(|v| {
                *v.borrow_mut() = Some(
                    value
                        .map(|v| {
                            std::collections::BTreeMap::from([(
                                "SOURCE".into(),
                                std::ffi::OsString::from(v),
                            )])
                        })
                        .unwrap_or_default(),
                )
            });
            A02B_ENV_CALLS.with(|v| v.set(0));
            T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
            let error = create_session_owner_with_shell(
                None,
                &manager,
                &root.join("private"),
                Some(root.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                None,
                Some(shell.clone()),
                Some(refs.clone()),
            )
            .unwrap_err();
            assert_eq!(
                error,
                match value {
                    None => "profile_env_missing",
                    Some("bad\0value") => "profile_env_invalid_value",
                    _ => "test_entry_reached_allocation",
                }
            );
            assert_eq!(A02B_ENV_CALLS.with(|v| v.get()), 1);
            assert_eq!(
                T09_ALLOCATION_BOUNDARY.with(|v| v.get()),
                usize::from(value == Some("literal 空格;$(noexec)"))
            );
        }
        let mut builder =
            ordinary_shell_command(&shell, || panic!("must not read default shell")).unwrap();
        builder.cwd(&root);
        let env = resolve_profile_env(&refs, &|_| {
            Some(std::ffi::OsString::from("literal 空格;$(noexec)"))
        })
        .unwrap();
        for (target, value) in env {
            builder.env(target, value);
        }
        assert_eq!(builder.get_argv()[0], program.as_os_str());
        assert_eq!(builder.get_cwd().unwrap(), root.as_os_str());
        assert_eq!(
            builder.get_env("HOME").unwrap(),
            std::ffi::OsStr::new("literal 空格;$(noexec)")
        );
    }
    #[test]
    fn a02b_proxy_omits_none_empty_and_preserves_reference_names() {
        for refs in [None, Some(std::collections::BTreeMap::new())] {
            assert!(create_session_arguments(
                &None, &None, &None, &None, &None, &None, &None, &refs, &None, &None, &None, &None,
            )
            .unwrap()
            .get("env_refs")
            .is_none());
        }
        let refs = Some(std::collections::BTreeMap::from([
            ("__proto__".into(), "SOURCE".into()),
            ("constructor".into(), "SOURCE".into()),
        ]));
        let args = create_session_arguments(
            &None, &None, &None, &None, &None, &None, &None, &refs, &None, &None, &None, &None,
        )
        .unwrap();
        assert_eq!(args["env_refs"]["__proto__"], "SOURCE");
        assert!(args.to_string().contains("SOURCE"));
    }
    #[test]
    fn a02b_reference_name_and_count_boundaries_are_checked_before_lookup() {
        for length in [1, 128] {
            let refs = std::collections::BTreeMap::from([("_".repeat(length), "S".into())]);
            assert!(validate_profile_env_refs(&refs, false).is_ok());
        }
        for refs in [
            std::collections::BTreeMap::from([("_".repeat(129), "S".into())]),
            std::collections::BTreeMap::from([("1A".into(), "S".into())]),
            std::collections::BTreeMap::from([("A".into(), "S-B".into())]),
            std::collections::BTreeMap::from([("Yam_A".into(), "S".into())]),
        ] {
            assert_eq!(
                validate_profile_env_refs(&refs, false).unwrap_err(),
                "profile_env_invalid"
            );
        }
        let refs = (0..32).map(|n| (format!("T{n}"), "S".into())).collect();
        assert!(validate_profile_env_refs(&refs, true).is_ok());
        let mut refs = refs;
        refs.insert("EXTRA".into(), "S".into());
        assert_eq!(
            validate_profile_env_refs(&refs, true).unwrap_err(),
            "profile_env_invalid"
        );
    }
}

#[cfg(test)]
mod d03a_tests {
    use super::*;
    #[test]
    fn d03a_running_reply_preserves_all_typed_and_ordinary_metadata() {
        for ssh in [Some(ssh()), None] {
            let input = SessionSummary {
                ssh,
                session_id: "s-typed-1".into(),
                cwd: "/local".into(),
                command: None,
                status: "starting".into(),
                launch: None,
            };
            let mut expected = input.clone();
            expected.status = "running".into();
            assert_eq!(running_summary(input), expected);
        }
    }

    fn ssh() -> ssh_launch::SshLaunch {
        ssh_launch::SshLaunch {
            host: "Alias_1".into(),
            user: None,
            port: Some(2222),
        }
    }
    #[test]
    fn d03a_arguments_retention_and_mixed_guards() {
        for lines in [200, 500, 2000] {
            let args = create_session_arguments(
                &Some("/local".into()),
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &Some(lines),
                &Some(ssh()),
                &None,
                &None,
            )
            .unwrap();
            assert_eq!(args["ssh"]["host"], "Alias_1");
            assert_eq!(args["retained_lines"], lines);
            assert!(create_session_arguments(
                &None,
                &Some("".into()),
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &Some(lines),
                &Some(ssh()),
                &None,
                &None,
            )
            .is_err());
            assert!(create_session_arguments(
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &None,
                &Some(lines),
                &Some(ssh()),
                &Some(true),
                &None,
            )
            .is_err());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn d03a_owner_validated_ssh_retention_preallocation() {
        let _serial = worktree_manager::serial_owner_test();
        let root = std::env::temp_dir().join(format!(
            "yam-d03a-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let manager = SessionManager::default();
        for lines in [200, 500, 2000] {
            T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
            let result = create_session_owner_with_directory_reporting(
                None,
                &manager,
                &root.join("private"),
                Some(root.to_str().unwrap().into()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(lines),
                Some(ssh()),
                None,
            );
            assert_eq!(result.err().unwrap(), "test_entry_reached_allocation");
            assert_eq!(T09_ALLOCATION_BOUNDARY.with(|v| v.get()), 1);
        }
        T09_ALLOCATION_BOUNDARY.with(|v| v.set(0));
        assert!(create_session_owner_with_directory_reporting(
            None,
            &manager,
            &root.join("private"),
            Some(root.to_str().unwrap().into()),
            Some("".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(500),
            Some(ssh()),
            None,
        )
        .is_err());
        assert_eq!(T09_ALLOCATION_BOUNDARY.with(|v| v.get()), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod native_reopen_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn native_reopen_owner_hides_itself_before_every_gui_open() {
        let manager = SessionManager {
            background_owner: true,
            ..Default::default()
        };
        let actions = std::cell::RefCell::new(Vec::new());
        for _ in 0..2 {
            handle_native_reopen(
                true,
                &manager,
                || {
                    actions.borrow_mut().push("hide_owner");
                    Ok(())
                },
                || {
                    actions.borrow_mut().push("open_gui");
                    Ok(())
                },
                || panic!("owner has no GUI"),
            )
            .unwrap();
        }
        assert_eq!(
            *actions.borrow(),
            vec!["hide_owner", "open_gui", "hide_owner", "open_gui"]
        );
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn native_reopen_owner_does_not_open_gui_if_hiding_fails() {
        let manager = SessionManager {
            background_owner: true,
            ..Default::default()
        };
        assert_eq!(
            handle_native_reopen(
                true,
                &manager,
                || Err("hide_failed".into()),
                || panic!("failed policy change must not launch a GUI"),
                || panic!("owner has no GUI"),
            ),
            Err("hide_failed".into())
        );
        assert!(!manager.shutting_down.load(Ordering::Acquire));
    }

    #[test]
    fn native_reopen_shows_gui_without_opening_owner() {
        let manager = SessionManager::default();
        for _ in 0..2 {
            let shown = Cell::new(false);
            handle_native_reopen(
                true,
                &manager,
                || panic!("GUI must remain a regular foreground app"),
                || panic!("GUI must not launch another desktop"),
                || {
                    shown.set(true);
                    Ok(())
                },
            )
            .unwrap();
            assert!(shown.get());
        }
    }

    #[test]
    fn native_reopen_owner_uses_ready_and_shutdown_guarded_open() {
        let manager = SessionManager {
            background_owner: true,
            ..Default::default()
        };
        let event = true;
        assert_eq!(
            handle_native_reopen(
                event,
                &manager,
                || Ok(()),
                || system_entry::owner_open(&manager, || panic!(), || panic!()),
                || panic!("owner has no desktop window")
            ),
            Err("system_entry_unavailable".into())
        );
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        let launched = Cell::new(0);
        for expected in 1..=2 {
            handle_native_reopen(
                event,
                &manager,
                || Ok(()),
                || {
                    system_entry::owner_open(
                        &manager,
                        || panic!("disconnected"),
                        || {
                            launched.set(launched.get() + 1);
                            Ok(())
                        },
                    )
                },
                || panic!("owner has no desktop window"),
            )
            .unwrap();
            assert_eq!(launched.get(), expected);
            assert!(manager.sessions.lock().unwrap().is_empty());
        }
        manager.shutting_down.store(true, Ordering::Release);
        handle_native_reopen(
            event,
            &manager,
            || panic!("stopping"),
            || panic!("stopping"),
            || panic!("stopping"),
        )
        .unwrap();
    }

    #[test]
    fn native_reopen_ignores_other_events_and_stopping_gui() {
        let manager = SessionManager::default();
        for event in [
            tauri::RunEvent::Ready,
            tauri::RunEvent::Resumed,
            tauri::RunEvent::Exit,
        ] {
            handle_native_reopen(
                matches!(event, tauri::RunEvent::Reopen { .. }),
                &manager,
                || panic!(),
                || panic!(),
                || panic!(),
            )
            .unwrap();
        }
        manager.shutting_down.store(true, Ordering::Release);
        handle_native_reopen(true, &manager, || panic!(), || panic!(), || panic!()).unwrap();
    }

    #[test]
    fn native_reopen_propagates_open_errors_without_fallback_launch() {
        for background_owner in [false, true] {
            let manager = SessionManager {
                background_owner,
                ..Default::default()
            };
            assert_eq!(
                handle_native_reopen(
                    true,
                    &manager,
                    || Ok(()),
                    || {
                        assert!(background_owner);
                        Err("system_entry_open_failed".into())
                    },
                    || {
                        assert!(!background_owner);
                        Err("system_entry_open_failed".into())
                    }
                ),
                Err("system_entry_open_failed".into())
            );
            assert!(!manager.shutting_down.load(Ordering::Acquire));
        }
    }
}
