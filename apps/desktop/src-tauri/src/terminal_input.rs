use super::{SessionManager, SessionRecord};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DraftInputGuard {
    pub(super) cwd: String,
    pub(super) generation: String,
    pub(super) native_session_id: String,
    pub(super) turn_id: Option<String>,
    pub(super) revision: u64,
    pub(super) managed_codex: bool,
}

impl DraftInputGuard {
    pub(super) fn validate(&self, record: &SessionRecord, data: &str) -> Result<(), String> {
        let launch = record.summary.launch.as_ref();
        let agent = &record.agent;
        if record.status != "running"
            || record.summary.ssh.is_some()
            || record.summary.cwd != self.cwd
            || !launch.is_some_and(|launch| {
                launch.mode == "interactive"
                    && matches!(
                        launch.adapter.as_str(),
                        "codex" | "claude" | "gemini" | "opencode" | "pi"
                    )
                    && launch
                        .codex
                        .as_ref()
                        .is_some_and(|codex| codex.route.is_some())
                        == self.managed_codex
            })
            || agent.integration != "connected"
            || agent.route_pending
            || !matches!(agent.phase.as_str(), "idle" | "response_finished")
            || self.generation.is_empty()
            || self.native_session_id.is_empty()
            || agent.generation != self.generation
            || agent.agent_session_id.as_deref() != Some(self.native_session_id.as_str())
            || agent.turn_id != self.turn_id
            || agent.revision != self.revision
        {
            return Err("Agent draft target changed; no bytes were accepted".into());
        }
        let body = data
            .strip_prefix("\x1b[200~")
            .and_then(|body| body.strip_suffix("\x1b[201~"))
            .filter(|body| {
                !body.is_empty()
                    && body.len() <= 64 * 1024
                    && !body.chars().any(|c| {
                        (c.is_control() && !matches!(c, '\t' | '\r'))
                            || (self.managed_codex && c == '\r')
                            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                    })
            });
        if body.is_none() {
            return Err("Invalid Agent draft input; no bytes were accepted".into());
        }
        Ok(())
    }
}

pub(super) fn write_session_guarded(
    manager: State<'_, SessionManager>,
    session_id: String,
    data: String,
    expected_agent: Option<DraftInputGuard>,
) -> Result<(), String> {
    let client = manager
        .background_client
        .lock()
        .map_err(|_| "Background client lock poisoned")?
        .clone();
    if let Some(client) = client {
        let mut args = serde_json::json!({"session_id":session_id,"data":data});
        if let Some(guard) = &expected_agent {
            args["expected_agent"] = serde_json::to_value(guard).map_err(|e| e.to_string())?;
        }
        return serde_json::from_value(client.call("write_session", args)?)
            .map_err(|_| "Invalid background command result".into());
    }
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown session: {session_id}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    #[cfg(unix)]
    let fd = super::input_lock(&session.master, deadline, &session.stop_requested)?
        .as_ref()
        .ok_or("PTY is closed")?
        .as_raw_fd()
        .ok_or("PTY input does not support bounded native writes")?;
    let mut writer = super::input_lock(&session.writer, deadline, &session.stop_requested)?;
    // Agent events and input admission share the authoritative history record.
    // Hold it through the bounded write so a committed turn change cannot interleave.
    let draft_records = if let Some(guard) = &expected_agent {
        let records =
            super::input_lock(&session.history.records, deadline, &session.stop_requested)?;
        let record = records
            .iter()
            .find(|record| record.summary.session_id == session_id)
            .ok_or("Agent draft target changed; no bytes were accepted")?;
        guard.validate(record, &data)?;
        Some(records)
    } else {
        None
    };
    #[cfg(unix)]
    super::write_input_until(
        writer.as_mut(),
        fd,
        data.as_bytes(),
        deadline,
        &session.stop_requested,
    )?;
    #[cfg(windows)]
    super::write_windows_input(
        writer.as_mut(),
        data.as_bytes(),
        deadline,
        &session.stop_requested,
    )?;
    drop(draft_records);
    if let Ok(mut activity) = session.last_activity.lock() {
        *activity = Instant::now();
    }
    Ok(())
}
