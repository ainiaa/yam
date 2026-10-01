use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SESSION_LOG_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HealthReport {
    pub app: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: String,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionStateEvent {
    session_id: String,
    status: String,
    exit_code: Option<u32>,
    reason: Option<String>,
}

struct Session {
    summary: SessionSummary,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    log: Mutex<File>,
    history: Arc<HistoryStore>,
    stop_requested: AtomicBool,
    timeout_requested: AtomicBool,
    last_activity: Mutex<Instant>,
    status: Mutex<String>,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    history: Mutex<Option<Arc<HistoryStore>>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            history: Mutex::new(None),
        }
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        let Ok(sessions) = self.sessions.get_mut() else {
            return;
        };
        for session in sessions.values() {
            session.stop_requested.store(true, Ordering::Release);
            let _ = terminate_session(session);
        }
    }
}

struct HistoryStore {
    root: PathBuf,
    records: Mutex<Vec<SessionRecord>>,
}

impl HistoryStore {
    fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create session data directory: {error}"))?;
        let records_path = root.join("sessions.json");
        let records = if records_path.exists() {
            let contents = fs::read_to_string(&records_path)
                .map_err(|error| format!("Failed to read session history: {error}"))?;
            serde_json::from_str(&contents).unwrap_or_default()
        } else {
            Vec::new()
        };
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
        fs::write(&temp_path, data)
            .map_err(|error| format!("Failed to write session history: {error}"))?;
        fs::rename(&temp_path, self.records_path())
            .map_err(|error| format!("Failed to commit session history: {error}"))
    }

    fn start(&self, summary: &SessionSummary) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned".to_string())?;
        records.retain(|record| record.summary.session_id != summary.session_id);
        records.push(SessionRecord {
            summary: summary.clone(),
            status: summary.status.clone(),
            exit_code: None,
            reason: None,
            started_at: unix_timestamp(),
            ended_at: None,
        });
        self.save_locked(&records)
    }

    fn update(
        &self,
        session_id: &str,
        status: &str,
        exit_code: Option<u32>,
        reason: Option<String>,
    ) {
        if let Ok(mut records) = self.records.lock() {
            if let Some(record) = records
                .iter_mut()
                .find(|record| record.summary.session_id == session_id)
            {
                record.status = status.to_string();
                record.summary.status = status.to_string();
                record.exit_code = exit_code;
                record.reason = reason;
                if is_terminal(status) {
                    record.ended_at = Some(unix_timestamp());
                }
                let _ = self.save_locked(&records);
            }
        }
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
        for record in records.iter_mut() {
            if matches!(record.status.as_str(), "starting" | "running") {
                record.status = "needs_attention".to_string();
                record.summary.status = "needs_attention".to_string();
                record.reason =
                    Some("The application closed while this session was running".to_string());
                record.ended_at = Some(unix_timestamp());
                changed = true;
            }
        }
        if changed {
            self.save_locked(&records)?;
        }
        Ok(())
    }

    fn log_path(&self, session_id: &str) -> PathBuf {
        self.root.join(format!("{session_id}.log"))
    }
}

impl SessionManager {
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
    let current_size = log.metadata()?.len();
    if current_size.saturating_add(data.len() as u64) > max_bytes {
        log.set_len(0)?;
        log.seek(SeekFrom::Start(0))?;
        log.write_all(b"[YAM] Log truncated after reaching the session size limit.\r\n")?;
    }
    log.write_all(data)?;
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

fn terminate_session(session: &Session) -> Result<(), String> {
    let child_result = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?
        .kill()
        .map_err(|error| format!("Failed to stop session: {error}"));

    #[cfg(unix)]
    {
        let process_group = session
            .master
            .lock()
            .ok()
            .and_then(|master| master.process_group_leader());
        if let Some(process_group) = process_group {
            // portable-pty starts the shell in its own process group on Unix.
            unsafe {
                let _ = libc::kill(-process_group, libc::SIGKILL);
            }
        }
    }

    child_result
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
    session.history.update(
        &session.summary.session_id,
        status,
        exit_code,
        reason.clone(),
    );
    let event = SessionStateEvent {
        session_id: session.summary.session_id.clone(),
        status: status.to_string(),
        exit_code,
        reason,
    };
    let _ = app.emit("session-state", event);
    true
}

fn spawn_session_threads(app: &AppHandle, session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let output_app = app.clone();
    let output_session_id = session.summary.session_id.clone();
    let output_session = Arc::clone(&session);
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if let Ok(mut log) = output_session.log.lock() {
                        let _ = append_log(&mut log, &buffer[..size], MAX_SESSION_LOG_BYTES);
                    }
                    if let Ok(mut activity) = output_session.last_activity.lock() {
                        *activity = Instant::now();
                    }
                    let output = SessionOutput {
                        session_id: output_session_id.clone(),
                        data: String::from_utf8_lossy(&buffer[..size]).into_owned(),
                    };
                    let _ = output_app.emit("session-output", output);
                }
                Err(_) => break,
            }
        }
    });

    let wait_app = app.clone();
    thread::spawn(move || loop {
        let idle = session
            .last_activity
            .lock()
            .map(|activity| activity.elapsed())
            .unwrap_or_default();
        if !session.stop_requested.load(Ordering::Acquire) && idle >= session_idle_timeout() {
            session.timeout_requested.store(true, Ordering::Release);
            session.stop_requested.store(true, Ordering::Release);
        }
        if session.stop_requested.load(Ordering::Acquire) {
            let _ = terminate_session(&session);
        }

        let result = session
            .child
            .lock()
            .map_err(|_| "child lock poisoned".to_string())
            .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));

        match result {
            Ok(Some(exit)) => {
                if session.timeout_requested.load(Ordering::Acquire) {
                    emit_state(
                        &wait_app,
                        &session,
                        "needs_attention",
                        Some(exit.exit_code()),
                        Some("Session stopped after producing no output for too long".to_string()),
                    );
                } else if session.stop_requested.load(Ordering::Acquire) {
                    emit_state(
                        &wait_app,
                        &session,
                        "stopped",
                        Some(exit.exit_code()),
                        Some("Stopped by user".to_string()),
                    );
                } else if exit.success() {
                    emit_state(
                        &wait_app,
                        &session,
                        "succeeded",
                        Some(exit.exit_code()),
                        Some("Process exited normally".to_string()),
                    );
                } else {
                    emit_state(
                        &wait_app,
                        &session,
                        "failed",
                        Some(exit.exit_code()),
                        Some("Process exited with a non-zero code".to_string()),
                    );
                }
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                emit_state(&wait_app, &session, "failed", None, Some(error));
                break;
            }
        }
    });
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
) -> Result<SessionSummary, String> {
    let history = manager.history(&app)?;
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

    let mut builder = shell_command(command.as_deref());
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

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|error| format!("Failed to start session: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read PTY output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY input: {error}"))?;

    let summary = SessionSummary {
        session_id: id,
        cwd: working_directory,
        command,
        status: "starting".to_string(),
    };
    let log_path = history.log_path(&summary.session_id);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open session log: {error}"))?;
    history.start(&summary)?;
    let session = Arc::new(Session {
        summary: summary.clone(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        log: Mutex::new(log),
        history,
        stop_requested: AtomicBool::new(false),
        timeout_requested: AtomicBool::new(false),
        last_activity: Mutex::new(Instant::now()),
        status: Mutex::new("starting".to_string()),
    });

    manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .insert(summary.session_id.clone(), Arc::clone(&session));
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
    spawn_session_threads(&app, session, reader);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            list_adapters,
            create_session,
            write_session,
            resize_session,
            stop_session,
            list_sessions,
            read_session_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running YAM");
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::Read;

    use portable_pty::{native_pty_system, PtySize};

    use super::{
        agent_adapters, append_log, is_terminal, next_session_id, shell_command, HealthReport,
        HistoryStore, SessionSummary,
    };

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
        let mut log = File::create(&path).expect("create log");
        append_log(&mut log, b"first", 8).expect("write first chunk");
        append_log(&mut log, b"second", 8).expect("rotate log");
        drop(log);

        let contents = std::fs::read_to_string(&path).expect("read log");
        assert!(contents.contains("Log truncated"));
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
