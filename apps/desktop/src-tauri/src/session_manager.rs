// Author: Jeff.Liu. Session history ownership, agent runtime and orderly shutdown.
use super::{
    agent_bridge, background, finish_session_with, request_session_stop, AppHandle, CommandBuilder,
    HistoryStore, Session, SessionManager, SessionMessage,
};
use std::{
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

impl SessionManager {
    pub(crate) fn acquire_history_owner(&self, root: &Path) -> Result<(), String> {
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
    pub(crate) fn shutdown(&self) -> Result<(), String> {
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
    pub(crate) fn shutdown_for<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        native_notify: impl Fn(&AppHandle<R>, &str, &str),
    ) -> Result<(), String> {
        self.shutdown_with(|session| {
            finish_session_with(app, &self.sessions, session, None, &native_notify)
        })
    }
    pub(crate) fn shutdown_with(
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
        let history = self
            .history
            .lock()
            .map_err(|_| "Session history lock poisoned")?
            .clone();
        if let Some(history) = history {
            history.save_pending_start_failures()?;
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

fn configure_agent_runtime(
    history: &HistoryStore,
    id: &str,
    prepared: &agent_bridge::Prepared,
    builder: &CommandBuilder,
) -> Result<(), String> {
    // OMP's Node launcher is a host; native resume must compare the actual CLI target.
    let cli_path = if builder
        .iter_extra_env_as_str()
        .any(|(key, value)| key == "YAM_OMP_DESKTOP" && value == "1")
    {
        Some(
            builder
                .iter_extra_env_as_str()
                .find_map(|(key, value)| (key == "YAM_OMP_EXECUTABLE").then_some(value))
                .filter(|path| Path::new(path).is_absolute())
                .ok_or("Missing managed OMP executable identity")?,
        )
    } else {
        builder.get_argv().first().and_then(|path| path.to_str())
    };
    history.configure_agent_version(
        id,
        &prepared.generation,
        prepared.cli_version.as_deref(),
        cli_path,
    )
}

impl SessionManager {
    pub(crate) fn acknowledge_selection(&self, session_id: &str) -> Result<(), String> {
        let mut pending = self
            .notification_selection
            .lock()
            .map_err(|_| "Notification selection lock poisoned".to_string())?;
        if pending.as_deref() == Some(session_id) {
            *pending = None;
        }
        Ok(())
    }

    pub(crate) fn history<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Arc<HistoryStore>, String> {
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
    pub(crate) fn start_agent_runtime(
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
    pub(crate) fn connect_agent(
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
        configure_agent_runtime(&history, id, prepared, builder)?;
        if builder
            .iter_extra_env_as_str()
            .any(|(k, v)| k == "YAM_OMP_DESKTOP" && v == "1")
        {
            builder.env("YAM_OMP_TERMINAL", id);
            builder.env("YAM_OMP_GENERATION", &prepared.generation);
        }
        bridge.register(id, &prepared.token, &prepared.generation)?;
        prepared.install(builder, bridge.address)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_cli_facts_record_omp_target_and_preserve_native_executable_guard() {
        if std::env::var_os("YAM_TEST_INHERITED_OMP").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "session_manager::tests::runtime_cli_facts_record_omp_target_and_preserve_native_executable_guard",
                ])
                .env("YAM_TEST_INHERITED_OMP", "1")
                .env("YAM_OMP_DESKTOP", "1")
                .env("YAM_OMP_EXECUTABLE", "/inherited/omp")
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "{}",
                String::from_utf8_lossy(&status.stderr)
            );
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "yam-cli-facts-{}",
            crate::gemini_resume::new_id().unwrap()
        ));
        let history = HistoryStore::open(root.clone()).unwrap();
        let id = "s-1-1";
        history
            .start(&crate::SessionSummary {
                session_id: id.into(),
                cwd: root.to_string_lossy().into(),
                command: None,
                status: "running".into(),
                launch: None,
                ssh: None,
            })
            .unwrap();
        let prepared = agent_bridge::Prepared::lifecycle().unwrap();
        for name in ["pi", "codex", "node"] {
            let executable = root.join(name);
            let mut command = CommandBuilder::new(&executable);
            command.env("YAM_OMP_EXECUTABLE", "/unmarked/target");
            configure_agent_runtime(&history, id, &prepared, &command).unwrap();
            assert_eq!(
                history.get(id).unwrap().agent.cli_path.as_deref(),
                executable.to_str()
            );
        }
        let node = root.join("node");
        let omp = root.join("omp");
        let mut command = CommandBuilder::new(&node);
        command.env("YAM_OMP_DESKTOP", "1");
        command.env("YAM_OMP_EXECUTABLE", &omp);
        configure_agent_runtime(&history, id, &prepared, &command).unwrap();
        let saved = history.get(id).unwrap().agent;
        assert_eq!(saved.cli_path.as_deref(), omp.to_str());
        assert_ne!(
            saved.cli_path.as_deref(),
            root.join("different-omp").to_str()
        );
        command.env_remove("YAM_OMP_EXECUTABLE");
        assert!(configure_agent_runtime(&history, id, &prepared, &command).is_err());
        assert_eq!(history.get(id).unwrap().agent, saved);
        command.env("YAM_OMP_EXECUTABLE", "relative/omp");
        assert!(configure_agent_runtime(&history, id, &prepared, &command).is_err());
        assert_eq!(history.get(id).unwrap().agent, saved);
        drop(history);
        let reopened = HistoryStore::open(root.clone()).unwrap();
        assert_eq!(reopened.get(id).unwrap().agent.cli_path, saved.cli_path);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
