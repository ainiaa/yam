use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HealthReport {
    pub app: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: String,
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
    stop_requested: AtomicBool,
    status: Mutex<String>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
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
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("s-{now:x}-{sequence:x}")
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

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "stopped")
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
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
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
        if session.stop_requested.load(Ordering::Acquire) {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }

        let result = session
            .child
            .lock()
            .map_err(|_| "child lock poisoned".to_string())
            .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));

        match result {
            Ok(Some(exit)) => {
                if session.stop_requested.load(Ordering::Acquire) {
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
fn create_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<SessionSummary, String> {
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
    let session = Arc::new(Session {
        summary: summary.clone(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        stop_requested: AtomicBool::new(false),
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
    session.stop_requested.store(true, Ordering::Release);
    let result = session
        .child
        .lock()
        .map_err(|_| "Child lock poisoned".to_string())?
        .kill()
        .map_err(|error| format!("Failed to stop session: {error}"));
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            create_session,
            write_session,
            resize_session,
            stop_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running YAM");
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use portable_pty::{native_pty_system, PtySize};

    use super::{is_terminal, next_session_id, shell_command, HealthReport};

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
        assert!(!is_terminal("running"));
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
}
