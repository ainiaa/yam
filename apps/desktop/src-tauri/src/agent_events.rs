use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentReceipt {
    pub id: String,
    pub revision: u64,
    pub turn_id: String,
    pub kind: String,
    pub delivery: String,
    pub read: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentState {
    pub generation: String,
    #[serde(default)]
    pub cli_version: Option<String>,
    #[serde(default)]
    pub cli_path: Option<String>,
    #[serde(default)]
    pub cli_platform: Option<String>,
    pub agent_session_id: Option<String>,
    pub turn_id: Option<String>,
    pub phase: String,
    pub background: String,
    pub integration: String,
    pub revision: u64,
    pub turns: Vec<String>,
    pub seen: Vec<String>,
    pub inbox: Vec<AgentReceipt>,
    #[serde(default)]
    pub permission_keys: Vec<String>,
}
impl Default for AgentState {
    fn default() -> Self {
        Self {
            generation: String::new(),
            cli_version: None,
            cli_path: None,
            cli_platform: None,
            agent_session_id: None,
            turn_id: None,
            phase: "unknown".into(),
            background: "unknown".into(),
            integration: "unavailable".into(),
            revision: 0,
            turns: vec![],
            seen: vec![],
            inbox: vec![],
            permission_keys: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentEvent {
    pub kind: String,
    pub agent_session_id: String,
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}
impl AgentState {
    pub fn apply(&mut self, event: &AgentEvent) -> Result<Option<String>, String> {
        let mut next = self.clone();
        let result = next.apply_inner(event)?;
        *self = next;
        Ok(result)
    }
    fn apply_inner(&mut self, event: &AgentEvent) -> Result<Option<String>, String> {
        fn valid(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }
        if event
            .source
            .as_deref()
            .is_some_and(|source| !matches!(source, "claude" | "opencode"))
        {
            return Err("Unsupported agent event source".into());
        }
        if !valid(&self.generation)
            || !valid(&event.agent_session_id)
            || event.turn_id.as_deref().is_some_and(|id| !valid(id))
            || event.permission_key.as_deref().is_some_and(|id| !valid(id))
        {
            return Err("Invalid agent event identity".into());
        }
        if ![
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "TurnComplete",
            "PermissionRequest",
            "Interrupt",
            "ToolProgress",
            "TurnFailed",
            "ResponseReady",
            "IntegrationUnavailable",
        ]
        .contains(&event.kind.as_str())
        {
            return Err("Unsupported agent event".into());
        }
        if event.kind == "SessionStart" {
            if self.agent_session_id.is_some()
                && (self.agent_session_id.as_deref() != Some(&event.agent_session_id)
                    || self.integration != "connecting")
            {
                return Ok(None);
            }
            self.agent_session_id = Some(event.agent_session_id.clone());
            self.phase = "idle".into();
            self.integration = "connected".into();
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or("Agent revision exhausted")?;
            return Ok(None);
        }
        // Notify also runs on the title-generation thread; it cannot establish routing.
        if self.agent_session_id.as_deref() != Some(&event.agent_session_id) {
            return Ok(None);
        }
        let turn = event.turn_id.as_deref().ok_or("Missing agent turn ID")?;
        if event.kind == "IntegrationUnavailable" {
            if event.source.as_deref() != Some("opencode") {
                return Err("Unsupported integration status source".into());
            }
            if self.turn_id.as_deref() != Some(turn) {
                return Ok(None);
            }
            self.integration = "unavailable".into();
            self.phase = "unknown".into();
            self.permission_keys.clear();
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or("Agent revision exhausted")?;
            return Ok(None);
        }
        self.integration = "connected".into();
        if event.kind == "UserPromptSubmit" {
            if self.turns.iter().any(|seen| seen == turn) {
                // Claude 2.1.286 can submit the previous prompt_id. This hook
                // confirms activity, while later native hooks establish the new ID.
                if event.source.as_deref() == Some("claude")
                    && self.turn_id.as_deref() == Some(turn)
                    && self.phase != "working"
                {
                    self.phase = "working".into();
                    self.permission_keys.clear();
                    self.revision = self
                        .revision
                        .checked_add(1)
                        .ok_or("Agent revision exhausted")?;
                }
                return Ok(None);
            }
            if self.turns.len() >= 1024 {
                return Err("Agent turn capacity reached; continue in a new YAM session".into());
            }
            self.turns.push(turn.into());
            self.turn_id = Some(turn.into());
            self.permission_keys.clear();
            self.phase = "working".into();
        } else {
            if !self.turns.iter().any(|known| known == turn) {
                if event.source.as_deref() != Some("claude")
                    || ![
                        "PermissionRequest",
                        "ToolProgress",
                        "ResponseReady",
                        "TurnFailed",
                    ]
                    .contains(&event.kind.as_str())
                {
                    return Err("Unknown agent turn".into());
                }
                if self.turns.len() >= 1024 {
                    return Err("Agent turn capacity reached; continue in a new YAM session".into());
                }
                self.turns.push(turn.into());
                self.turn_id = Some(turn.into());
                self.permission_keys.clear();
                self.phase = "working".into();
            }
            if ["Stop", "TurnComplete", "ResponseReady"].contains(&event.kind.as_str())
                && ["TurnFailed", "Interrupt"].iter().any(|kind| {
                    self.seen
                        .contains(&format!("{}:{}:{}", self.generation, turn, kind))
                })
            {
                return Ok(None);
            }
            if ["PermissionRequest", "ToolProgress"].contains(&event.kind.as_str()) {
                if self.turn_id.as_deref() != Some(turn)
                    || ["response_finished", "interrupted", "failed"].contains(&self.phase.as_str())
                {
                    return Ok(None);
                }
                if event.kind == "ToolProgress" {
                    if self.phase == "needs_attention" && self.permission_keys.is_empty() {
                        self.phase = "working".into();
                        self.revision = self
                            .revision
                            .checked_add(1)
                            .ok_or("Agent revision exhausted")?;
                        return Ok(None);
                    }
                    if let Some(key) = event
                        .permission_key
                        .as_deref()
                        .filter(|key| self.permission_keys.iter().any(|pending| pending == key))
                    {
                        self.permission_keys.retain(|pending| pending != key);
                        if self.permission_keys.is_empty() {
                            self.phase = "working".into();
                        }
                        self.revision = self
                            .revision
                            .checked_add(1)
                            .ok_or("Agent revision exhausted")?;
                    }
                    return Ok(None);
                }
                let key = event.permission_key.as_deref().unwrap_or("unknown");
                if self.permission_keys.iter().any(|pending| pending == key) {
                    return Ok(None);
                }
                if self.permission_keys.len() >= 32 {
                    return Err("Pending permission capacity reached".into());
                }
                self.permission_keys.push(key.into());
            }
            if event.kind == "Stop" {
                if self.turn_id.as_deref() != Some(turn) {
                    return Ok(None);
                }
                if !["response_finished", "unknown"].contains(&self.phase.as_str()) {
                    self.revision = self
                        .revision
                        .checked_add(1)
                        .ok_or("Agent revision exhausted")?;
                    self.phase = "unknown".into();
                }
                return Ok(None);
            }
            let identity = if event.kind == "PermissionRequest" {
                format!(
                    "{}:{}:{}:{}",
                    self.generation, turn, event.kind, self.revision
                )
            } else {
                format!("{}:{}:{}", self.generation, turn, event.kind)
            };
            if self.seen.contains(&identity) {
                return Ok(None);
            }
            if self.seen.len() >= 2048 {
                return Err("Agent event capacity reached; continue in a new YAM session".into());
            }
            if self.inbox.len() >= 512 {
                self.inbox.retain(|entry| {
                    !entry.read || !["accepted", "suppressed"].contains(&entry.delivery.as_str())
                });
                if self.inbox.len() >= 512 {
                    return Err(
                        "Agent inbox capacity reached; read delivered entries before continuing"
                            .into(),
                    );
                }
            }
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or("Agent revision exhausted")?;
            let phase = match event.kind.as_str() {
                "TurnComplete" => "response_finished",
                "PermissionRequest" => "needs_permission",
                "TurnFailed" => "failed",
                "ResponseReady" => "needs_attention",
                _ => "interrupted",
            };
            if self.turn_id.as_deref() == Some(turn) {
                self.phase = phase.into();
                if ["response_finished", "failed", "interrupted"].contains(&phase) {
                    self.permission_keys.clear();
                }
            }
            self.seen.push(identity.clone());
            self.inbox.push(AgentReceipt {
                id: identity.clone(),
                revision: self.revision,
                turn_id: turn.into(),
                kind: phase.into(),
                delivery: "pending".into(),
                read: false,
                error: None,
            });
            return Ok(Some(identity));
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("Agent revision exhausted")?;
        Ok(None)
    }
    pub fn read(&mut self, id: &str, revision: u64) -> Result<(), String> {
        let entry = self
            .inbox
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("Unknown agent receipt")?;
        if entry.revision != revision {
            return Err("Stale agent receipt revision".into());
        }
        entry.read = true;
        Ok(())
    }
}

impl super::HistoryStore {
    fn edit_agent<T>(
        &self,
        id: &str,
        edit: impl FnOnce(&mut AgentState) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut records = self.lock_records()?;
        let mut next = records.clone();
        let record = next
            .iter_mut()
            .find(|record| record.summary.session_id == id)
            .ok_or("Unknown agent session")?;
        let result = edit(&mut record.agent)?;
        if next != *records {
            self.save_locked(&next)?;
            *records = next;
        }
        Ok(result)
    }
    #[cfg(test)]
    pub(super) fn configure_agent(&self, id: &str, generation: &str) -> Result<(), String> {
        self.configure_agent_version(id, generation, None, None)
    }
    pub(super) fn configure_agent_version(
        &self,
        id: &str,
        generation: &str,
        cli_version: Option<&str>,
        cli_path: Option<&str>,
    ) -> Result<(), String> {
        self.edit_agent(id, |state| {
            *state = AgentState {
                generation: generation.into(),
                cli_version: cli_version.map(str::to_string),
                cli_path: cli_path.map(str::to_string),
                cli_platform: Some(std::env::consts::OS.into()),
                integration: "connecting".into(),
                ..Default::default()
            };
            Ok(())
        })
    }
    pub(super) fn bind_resume_identity(&self, id: &str, native_id: &str) -> Result<(), String> {
        if !super::valid_resume_id(native_id) {
            return Err("Invalid native resume identity".into());
        }
        self.edit_agent(id, |state| {
            state.agent_session_id = Some(native_id.into());
            if state.generation.is_empty() {
                state.generation = format!("resume-{id}");
            }
            Ok(())
        })
    }
    pub(super) fn unavailable_agent(&self, id: &str, reason: &str) -> Result<(), String> {
        self.edit_agent(id, |state| {
            state.integration = format!("unavailable: {reason}");
            state.phase = "unknown".into();
            Ok(())
        })
    }
    pub(super) fn agent_failure(
        &self,
        id: &str,
        generation: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut records = self.lock_records()?;
        let mut next = records.clone();
        let record = next
            .iter_mut()
            .find(|r| r.summary.session_id == id)
            .ok_or("Unknown agent session")?;
        if record.agent.generation != generation
            || !["starting", "running"].contains(&record.status.as_str())
        {
            return Err("Expired agent launch".into());
        }
        record.agent.integration = format!("unavailable: {reason}");
        record.agent.phase = "unknown".into();
        self.save_locked(&next)?;
        *records = next;
        Ok(())
    }
    pub(super) fn ingest_agent(
        &self,
        id: &str,
        generation: &str,
        event: &AgentEvent,
    ) -> Result<Option<String>, String> {
        // Lifecycle and launch identity are checked inside the same lock as the atomic commit.
        let mut records = self.lock_records()?;
        let mut next = records.clone();
        let record = next
            .iter_mut()
            .find(|record| record.summary.session_id == id)
            .ok_or("Unknown agent session")?;
        if record.agent.generation != generation
            || !["starting", "running"].contains(&record.status.as_str())
        {
            return Err("Expired agent launch".into());
        }
        let result = record.agent.apply(event)?;
        if next != *records {
            self.save_locked(&next)?;
            *records = next;
        }
        Ok(result)
    }
    pub(super) fn read_agent_receipt(
        &self,
        id: &str,
        receipt: &str,
        revision: u64,
    ) -> Result<(), String> {
        self.edit_agent(id, |state| state.read(receipt, revision))
    }
    pub(super) fn agent_delivery(
        &self,
        id: &str,
        receipt: &str,
        revision: u64,
        delivery: &str,
        error: Option<String>,
    ) -> Result<(), String> {
        if !["accepted", "failed", "suppressed"].contains(&delivery) {
            return Err("Invalid agent delivery receipt".into());
        }
        self.edit_agent(id, |state| {
            let entry = state
                .inbox
                .iter_mut()
                .find(|entry| entry.id == receipt)
                .ok_or("Unknown agent receipt")?;
            if entry.revision != revision {
                return Err("Stale agent receipt revision".into());
            }
            entry.delivery = delivery.into();
            entry.error = error;
            Ok(())
        })
    }
}
pub(super) enum NativeSource<'a> {
    Lifecycle(&'a str),
    Round(&'a AgentReceipt),
}
// ponytail: serialize native notification requests globally; use per-session gates if measured delivery latency requires it.
pub(crate) static NATIVE_DELIVERY: std::sync::Mutex<()> = std::sync::Mutex::new(());
impl super::HistoryStore {
    pub(super) fn native_delivery(
        &self,
        id: &str,
        source: NativeSource<'_>,
        send: impl FnOnce(&super::SessionRecord) -> Result<(), String>,
    ) -> Result<bool, String> {
        let _gate = NATIVE_DELIVERY
            .lock()
            .map_err(|_| "Native notification gate poisoned")?;
        let record = self
            .list()?
            .into_iter()
            .find(|r| r.summary.session_id == id)
            .ok_or("Unknown notification session")?;
        let eligible = match source {
            NativeSource::Lifecycle(status) => {
                if status == "idle_attention" {
                    ["starting", "running"].contains(&record.status.as_str())
                        && record.agent.integration != "connected"
                } else {
                    record.status == status
                        && !(status == "stopped"
                            && record.reason.as_deref() == Some("Stopped by user"))
                }
            }
            NativeSource::Round(expected) => {
                ["starting", "running"].contains(&record.status.as_str())
                    && record.agent.inbox.iter().any(|e| {
                        e.id == expected.id
                            && e.revision == expected.revision
                            && !e.read
                            && ["pending", "failed"].contains(&e.delivery.as_str())
                    })
            }
        };
        if !eligible {
            return Ok(false);
        }
        send(&record)?;
        Ok(true)
    }
}
#[derive(Default)]
pub(super) struct DeliveryQueue {
    delivered: std::collections::HashMap<String, String>,
    retries: std::collections::HashMap<String, (u64, u32)>,
    explicit_retry: bool,
}
impl DeliveryQueue {
    pub(super) fn tick(
        &mut self,
        history: &super::HistoryStore,
        now: u64,
        selected: Option<&str>,
        paused: bool,
        mut send: impl FnMut(&str, &AgentReceipt) -> Result<bool, String>,
    ) -> Result<Vec<String>, String> {
        let records = history.list()?;
        let mut changed = vec![];
        self.delivered.retain(|id, _| {
            records.iter().any(|r| {
                r.agent
                    .inbox
                    .iter()
                    .any(|e| e.id == *id && ["pending", "failed"].contains(&e.delivery.as_str()))
            })
        });
        self.retries.retain(|id, _| {
            records.iter().any(|r| {
                r.agent
                    .inbox
                    .iter()
                    .any(|e| e.id == *id && ["pending", "failed"].contains(&e.delivery.as_str()))
            })
        });
        for record in records {
            let pending = record
                .agent
                .inbox
                .iter()
                .filter(|e| ["pending", "failed"].contains(&e.delivery.as_str()))
                .collect::<Vec<_>>();
            for entry in &pending {
                if let Some(delivery) = self.delivered.get(&entry.id) {
                    history.agent_delivery(
                        &record.summary.session_id,
                        &entry.id,
                        entry.revision,
                        delivery,
                        None,
                    )?;
                    changed.push(record.summary.session_id.clone());
                    continue;
                }
                if paused {
                    continue;
                }
                if !self.explicit_retry
                    && !self.retries.contains_key(&entry.id)
                    && entry.error.as_deref().is_some_and(permanent_delivery_error)
                {
                    self.retries.insert(entry.id.clone(), (u64::MAX, 1));
                }
                if entry.read || selected == Some(&record.summary.session_id) {
                    self.delivered.insert(entry.id.clone(), "suppressed".into());
                    history.agent_delivery(
                        &record.summary.session_id,
                        &entry.id,
                        entry.revision,
                        "suppressed",
                        None,
                    )?;
                    changed.push(record.summary.session_id.clone());
                    continue;
                }
                if self
                    .retries
                    .get(&entry.id)
                    .is_some_and(|(next, _)| now < *next)
                {
                    continue;
                }
                match send(&record.summary.session_id, entry) {
                    Ok(accepted) => {
                        let delivery = if accepted { "accepted" } else { "suppressed" };
                        self.delivered.insert(entry.id.clone(), delivery.into());
                        history.agent_delivery(
                            &record.summary.session_id,
                            &entry.id,
                            entry.revision,
                            delivery,
                            None,
                        )?;
                    }
                    Err(error) => {
                        let attempts = self
                            .retries
                            .get(&entry.id)
                            .map_or(1, |(_, attempts)| attempts.saturating_add(1));
                        let permanent = permanent_delivery_error(&error);
                        let delay = 15000u64
                            .saturating_mul(1u64 << attempts.saturating_sub(1).min(5))
                            .min(300000);
                        self.retries.insert(
                            entry.id.clone(),
                            (
                                if permanent {
                                    u64::MAX
                                } else {
                                    now.saturating_add(delay)
                                },
                                attempts,
                            ),
                        );
                        history.agent_delivery(
                            &record.summary.session_id,
                            &entry.id,
                            entry.revision,
                            "failed",
                            Some(error.chars().take(500).collect()),
                        )?;
                    }
                }
                changed.push(record.summary.session_id.clone());
            }
        }
        changed.sort();
        changed.dedup();
        if !paused {
            self.explicit_retry = false;
        }
        Ok(changed)
    }
    pub(super) fn retry(&mut self) {
        self.retries.clear();
        self.explicit_retry = true;
    }
}
fn permanent_delivery_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    [
        "denied",
        "disabled",
        "permission",
        "unsupported",
        "invalid",
        "notifications require the installed yam.app bundle",
        "this desktop cannot provide notifications that reopen yam after exit",
    ]
    .iter()
    .any(|word| lower.contains(word))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opencode_native_source_retains_strict_turn_identity() {
        let mut state = AgentState {
            generation: "generation".into(),
            integration: "connecting".into(),
            ..Default::default()
        };
        let mut start = event("SessionStart", None);
        start.source = Some("opencode".into());
        state.apply(&start).unwrap();
        let mut prompt = event("UserPromptSubmit", Some("one"));
        prompt.source = Some("opencode".into());
        state.apply(&prompt).unwrap();
        let mut complete = event("TurnComplete", Some("one"));
        complete.source = Some("opencode".into());
        assert!(state.apply(&complete).unwrap().is_some());
        assert!(state.apply(&complete).unwrap().is_none());
        complete.turn_id = Some("unknown".into());
        assert!(state.apply(&complete).is_err());
    }

    #[test]
    fn a_validated_resume_keeps_identity_without_claiming_hook_connection() {
        let mut state = state();
        state.agent_session_id = Some("main-thread".into());
        state.integration = "connecting".into();
        state.apply(&event("SessionStart", None)).unwrap();
        assert_eq!(state.integration, "connected");
        assert_eq!(state.phase, "idle");
        state
            .apply(&event("UserPromptSubmit", Some("one")))
            .unwrap();
        state.apply(&event("SessionStart", None)).unwrap();
        assert_eq!(state.phase, "working");
        let mut other = event("SessionStart", None);
        other.agent_session_id = "title".into();
        state.apply(&other).unwrap();
        assert_eq!(state.agent_session_id.as_deref(), Some("main-thread"));
        assert_eq!(state.phase, "working");
    }

    #[test]
    fn user_stops_are_silent_while_completion_failure_and_unexpected_stops_notify() {
        let root = std::env::temp_dir().join(format!(
            "yam-quiet-stop-{}",
            super::super::next_session_id()
        ));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        for (id, status, reason, notify) in [
            ("manual", "stopped", Some("Stopped by user"), false),
            ("complete", "succeeded", None, true),
            ("error", "failed", Some("Process failed"), true),
            (
                "unexpected",
                "stopped",
                Some("Terminal owner disconnected"),
                true,
            ),
            ("unexplained", "stopped", None, true),
        ] {
            history
                .start(&super::super::SessionSummary {
                    ssh: None,
                    session_id: id.into(),
                    cwd: "/tmp".into(),
                    command: None,
                    status: "running".into(),
                    launch: None,
                })
                .unwrap();
            history
                .update(id, status, None, reason.map(str::to_owned), None)
                .unwrap();
            let record = history
                .list()
                .unwrap()
                .into_iter()
                .find(|r| r.summary.session_id == id)
                .unwrap();
            assert_eq!(record.notification_pending, notify, "{id}: pending receipt");
            let mut sent = false;
            assert_eq!(
                history
                    .native_delivery(id, NativeSource::Lifecycle(status), |_| {
                        sent = true;
                        Ok(())
                    })
                    .unwrap(),
                notify,
                "{id}: native eligibility"
            );
            assert_eq!(sent, notify);
        }
        // Old releases persisted a pending receipt for manually stopped tasks.
        history
            .records
            .lock()
            .unwrap()
            .iter_mut()
            .find(|r| r.summary.session_id == "manual")
            .unwrap()
            .notification_pending = true;
        let pending = history.pending(200, None).unwrap();
        assert!(!pending.items.iter().any(|r| r.session_id == "manual"));
        assert_eq!(pending.items.len(), 4);
        assert!(!history
            .native_delivery("manual", NativeSource::Lifecycle("stopped"), |_| panic!(
                "old manual stop must remain silent"
            ))
            .unwrap());
        history.recover_running().unwrap();
        assert!(!history.get("manual").unwrap().notification_pending);
        assert!(history.get("unexpected").unwrap().notification_pending);
        let reopened = super::super::HistoryStore::open(root.clone()).unwrap();
        assert!(!reopened.get("manual").unwrap().notification_pending);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_native_sources_cannot_overwrite_a_newer_round_or_process_result() {
        let root = std::env::temp_dir().join(format!(
            "yam-native-source-{}",
            super::super::next_session_id()
        ));
        let store = super::super::HistoryStore::open(root.clone()).unwrap();
        store
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "a".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        store.configure_agent("a", "launch").unwrap();
        store
            .ingest_agent("a", "launch", &event("SessionStart", None))
            .unwrap();
        store
            .ingest_agent("a", "launch", &event("UserPromptSubmit", Some("one")))
            .unwrap();
        store
            .ingest_agent("a", "launch", &event("TurnComplete", Some("one")))
            .unwrap();
        let receipt = store.list().unwrap()[0].agent.inbox[0].clone();
        let mut sends = 0;
        assert!(!store
            .native_delivery("a", NativeSource::Lifecycle("idle_attention"), |_| {
                sends += 1;
                Ok(())
            })
            .unwrap());
        assert!(store
            .native_delivery("a", NativeSource::Round(&receipt), |_| {
                sends += 1;
                Ok(())
            })
            .unwrap());
        store.update("a", "succeeded", Some(0), None, None).unwrap();
        assert!(store
            .native_delivery("a", NativeSource::Lifecycle("succeeded"), |_| {
                sends += 1;
                Ok(())
            })
            .unwrap());
        assert!(!store
            .native_delivery("a", NativeSource::Round(&receipt), |_| {
                sends += 1;
                Ok(())
            })
            .unwrap());
        assert_eq!(sends, 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_gate_orders_in_flight_round_before_process_completion_without_blocking_history() {
        let root = std::env::temp_dir().join(format!(
            "yam-native-barrier-{}",
            super::super::next_session_id()
        ));
        let store = std::sync::Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        store
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "a".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        store.configure_agent("a", "launch").unwrap();
        for (kind, turn) in [
            ("SessionStart", None),
            ("UserPromptSubmit", Some("one")),
            ("TurnComplete", Some("one")),
        ] {
            store
                .ingest_agent("a", "launch", &event(kind, turn))
                .unwrap();
        }
        let receipt = store.list().unwrap()[0].agent.inbox[0].clone();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = calls.clone();
        let first_store = store.clone();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let first = std::thread::spawn(move || {
            first_store.native_delivery("a", NativeSource::Round(&receipt), |_| {
                captured.lock().unwrap().push("round");
                entered.send(()).unwrap();
                wait.recv_timeout(std::time::Duration::from_secs(2))
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
        });
        ready
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        store.update("a", "succeeded", Some(0), None, None).unwrap();
        let second_store = store.clone();
        let captured = calls.clone();
        let second = std::thread::spawn(move || {
            second_store.native_delivery("a", NativeSource::Lifecycle("succeeded"), |_| {
                captured.lock().unwrap().push("process");
                Ok(())
            })
        });
        std::thread::sleep(std::time::Duration::from_millis(30));
        let before_release = calls.lock().unwrap().clone();
        release.send(()).unwrap();
        assert!(first.join().unwrap().unwrap());
        assert!(second.join().unwrap().unwrap());
        assert_eq!(before_release, vec!["round"]);
        assert_eq!(*calls.lock().unwrap(), vec!["round", "process"]);
        assert!(!store.list().unwrap()[0].agent.inbox[0].read);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn event(kind: &str, turn: Option<&str>) -> AgentEvent {
        AgentEvent {
            kind: kind.into(),
            agent_session_id: "main-thread".into(),
            turn_id: turn.map(str::to_string),
            source: None,
            permission_key: ["PermissionRequest", "ToolProgress"]
                .contains(&kind)
                .then(|| "test-tool".into()),
        }
    }
    fn state() -> AgentState {
        let mut state = AgentState {
            generation: "launch-one".into(),
            integration: "connecting".into(),
            ..Default::default()
        };
        state.apply(&event("SessionStart", None)).unwrap();
        state
    }
    #[test]
    fn native_delivery_retries_only_the_receipt_after_send_and_never_reads_the_inbox() {
        let root = std::env::temp_dir().join(format!(
            "yam-agent-delivery-{}",
            super::super::next_session_id()
        ));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        history
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "s".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        history.configure_agent("s", "g").unwrap();
        for (kind, turn) in [
            ("SessionStart", None),
            ("UserPromptSubmit", Some("one")),
            ("TurnComplete", Some("one")),
        ] {
            history.ingest_agent("s", "g", &event(kind, turn)).unwrap();
        }
        let mut queue = DeliveryQueue::default();
        let mut sends = 0;
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        assert!(queue
            .tick(&history, 0, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .is_err());
        assert_eq!(sends, 1);
        std::fs::remove_dir(root.join("sessions.json.tmp")).unwrap();
        queue
            .tick(&history, 1, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 1);
        let entry = history.list().unwrap()[0].agent.inbox[0].clone();
        assert_eq!(entry.delivery, "accepted");
        assert!(!entry.read);
        for (kind, turn) in [
            ("UserPromptSubmit", Some("two")),
            ("TurnComplete", Some("two")),
        ] {
            history.ingest_agent("s", "g", &event(kind, turn)).unwrap();
        }
        queue
            .tick(&history, 2, Some("s"), false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 1);
        let entries = history.list().unwrap()[0].agent.inbox.clone();
        assert_eq!(entries[1].delivery, "suppressed");
        assert!(!entries[1].read);
        for turn in ["three", "four"] {
            history
                .ingest_agent("s", "g", &event("UserPromptSubmit", Some(turn)))
                .unwrap();
            history
                .ingest_agent("s", "g", &event("TurnComplete", Some(turn)))
                .unwrap();
        }
        queue
            .tick(&history, 3, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(
            sends, 3,
            "separate rounds each retain their own send receipt"
        );
        let entries = history.list().unwrap()[0].agent.inbox.clone();
        assert!(entries[2..]
            .iter()
            .all(|entry| entry.delivery == "accepted" && !entry.read));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permanent_delivery_errors_wait_for_explicit_retry_and_transient_errors_back_off() {
        let root = std::env::temp_dir().join(format!(
            "yam-agent-backoff-{}",
            super::super::next_session_id()
        ));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        history
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "s".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        history.configure_agent("s", "g").unwrap();
        for (kind, turn) in [
            ("SessionStart", None),
            ("UserPromptSubmit", Some("one")),
            ("TurnComplete", Some("one")),
        ] {
            history.ingest_agent("s", "g", &event(kind, turn)).unwrap();
        }
        let mut queue = DeliveryQueue::default();
        let mut sends = 0;
        queue
            .tick(&history, 0, None, false, |_, _| {
                sends += 1;
                Err("Notification permission denied".into())
            })
            .unwrap();
        queue
            .tick(&history, 999999, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 1);
        let mut restarted = DeliveryQueue::default();
        restarted
            .tick(&history, 0, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(
            sends, 1,
            "persisted permission failures remain paused after restart"
        );
        queue.retry();
        for now in [999999, 1000000] {
            queue
                .tick(&history, now, None, true, |_, _| {
                    sends += 1;
                    Ok(true)
                })
                .unwrap();
        }
        assert_eq!(sends, 1, "explicit retry must not send while paused");
        queue
            .tick(&history, 1000000, None, false, |_, _| {
                sends += 1;
                Err("Temporary send failure".into())
            })
            .unwrap();
        assert_eq!(
            sends, 2,
            "explicit retry must survive paused delivery ticks"
        );
        queue
            .tick(&history, 1014999, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 2);
        queue
            .tick(&history, 1015000, None, true, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 2);
        queue
            .tick(&history, 1015000, None, false, |_, _| {
                sends += 1;
                Ok(true)
            })
            .unwrap();
        assert_eq!(sends, 3);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn two_rounds_are_separate_without_ending_the_process() {
        let mut s = state();
        for turn in ["one", "two"] {
            s.apply(&event("UserPromptSubmit", Some(turn))).unwrap();
            s.apply(&event("TurnComplete", Some(turn))).unwrap();
        }
        assert_eq!(s.inbox.len(), 2);
        assert_ne!(s.inbox[0].id, s.inbox[1].id);
        assert_eq!(s.phase, "response_finished");
        assert_eq!(s.background, "unknown");
    }
    #[test]
    fn permission_requests_repeat_only_after_progress_and_never_after_completion() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        assert_eq!(s.phase, "needs_permission");
        let revision = s.revision;
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        assert_eq!(s.revision, revision);
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        assert_eq!(s.phase, "working");
        let progress = s.revision;
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        assert_eq!(s.revision, progress);
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        assert_eq!(s.inbox.len(), 2);
        assert_ne!(s.inbox[0].id, s.inbox[1].id);
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        let completed = s.clone();
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        assert_eq!(s, completed);
        assert!(s.apply(&event("ToolProgress", Some("unknown"))).is_err());
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        let current = s.clone();
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        assert_eq!(s, current);
    }
    #[test]
    fn api_failure_is_a_separate_unread_failure_receipt_and_never_completion() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnFailed", Some("one"))).unwrap();
        assert_eq!(s.phase, "failed");
        assert_eq!(s.inbox[0].kind, "failed");
        assert!(!s.inbox[0].read);
        let failed = s.clone();
        s.apply(&event("TurnFailed", Some("one"))).unwrap();
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        s.apply(&event("Stop", Some("one"))).unwrap();
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        assert_eq!(s, failed);
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        assert_eq!(s.phase, "working");
    }
    #[test]
    fn unrelated_parallel_tool_cannot_clear_another_permission_request() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        let keyed = |kind: &str, key: &str| {
            serde_json::from_value::<AgentEvent>(serde_json::json!({"kind":kind,"agent_session_id":"main-thread","turn_id":"one","permission_key":key})).unwrap()
        };
        s.apply(&keyed("PermissionRequest", "tool-a")).unwrap();
        let pending = s.clone();
        s.apply(&keyed("ToolProgress", "unrelated-tool")).unwrap();
        assert_eq!(s, pending);
        s.apply(&keyed("PermissionRequest", "tool-b")).unwrap();
        assert_eq!(s.inbox.len(), 2);
        s.apply(&keyed("ToolProgress", "tool-a")).unwrap();
        assert_eq!(s.phase, "needs_permission");
        s.apply(&keyed("ToolProgress", "tool-b")).unwrap();
        assert_eq!(s.phase, "working");
        let mut old = serde_json::to_value(&s).unwrap();
        old.as_object_mut().unwrap().remove("permission_keys");
        assert!(serde_json::from_value::<AgentState>(old).is_ok());
    }
    #[test]
    fn failure_recovery_keeps_new_success_and_ignores_old_or_foreign_failures() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnFailed", Some("one"))).unwrap();
        let failure = s.inbox[0].clone();
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        assert_eq!(s.phase, "working");
        assert_eq!(s.inbox, vec![failure.clone()]);
        s.apply(&event("TurnComplete", Some("two"))).unwrap();
        let recovered = s.clone();
        for kind in ["TurnFailed", "TurnComplete", "Stop", "PermissionRequest"] {
            s.apply(&event(kind, Some("one"))).unwrap();
        }
        let mut foreign = event("TurnFailed", Some("two"));
        foreign.agent_session_id = "other-thread".into();
        s.apply(&foreign).unwrap();
        assert_eq!(s, recovered);
        assert_eq!(s.inbox[0], failure);
        assert_eq!(s.inbox[1].kind, "response_finished");
        assert!(s.inbox.iter().all(|entry| !entry.read));
    }
    #[test]
    fn claude_repeated_submit_id_uses_later_native_turn_without_guessing() {
        let native = |kind: &str, turn: &str| {
            serde_json::from_value::<AgentEvent>(serde_json::json!({"kind":kind,"agent_session_id":"main-thread","turn_id":turn,"source":"claude"})).unwrap()
        };
        let mut s = state();
        s.apply(&native("UserPromptSubmit", "one")).unwrap();
        s.apply(&native("ResponseReady", "one")).unwrap();
        s.apply(&native("UserPromptSubmit", "one")).unwrap();
        assert_eq!(s.phase, "working");
        assert_eq!(s.turns, vec!["one"]);
        s.apply(&native("ResponseReady", "two")).unwrap();
        assert_eq!(s.turns, vec!["one", "two"]);
        assert_eq!(s.turn_id.as_deref(), Some("two"));
        assert_eq!(s.inbox.len(), 2);
        assert_ne!(s.inbox[0].id, s.inbox[1].id);
        let completed = s.clone();
        s.apply(&native("ResponseReady", "two")).unwrap();
        assert_eq!(s, completed);
        let mut other = native("ResponseReady", "child-turn");
        other.agent_session_id = "child".into();
        s.apply(&other).unwrap();
        assert_eq!(s, completed);
        assert!(s
            .apply(&event("ResponseReady", Some("codex-unknown")))
            .is_err());
        let invalid = serde_json::from_value::<AgentEvent>(serde_json::json!({"kind":"ResponseReady","agent_session_id":"main-thread","turn_id":"three","source":"unrecognized"})).unwrap();
        assert!(s.apply(&invalid).is_err());
        assert_eq!(s, completed);
        s.apply(&native("UserPromptSubmit", "two")).unwrap();
        s.apply(&native("PermissionRequest", "three")).unwrap();
        assert_eq!(s.turn_id.as_deref(), Some("three"));
        assert_eq!(s.phase, "needs_permission");
        s.apply(&native("TurnFailed", "three")).unwrap();
        assert_eq!(s.phase, "failed");
    }
    #[test]
    fn claude_old_submit_cannot_restart_a_later_ready_failed_or_permission_turn() {
        let native = |kind: &str, turn: &str| {
            serde_json::from_value::<AgentEvent>(serde_json::json!({"kind":kind,"agent_session_id":"main-thread","turn_id":turn,"source":"claude","permission_key":"tool-two"})).unwrap()
        };
        for kind in ["ResponseReady", "TurnFailed", "PermissionRequest"] {
            let mut s = state();
            s.apply(&native("UserPromptSubmit", "one")).unwrap();
            s.apply(&native("ResponseReady", "one")).unwrap();
            s.apply(&native("UserPromptSubmit", "two")).unwrap();
            s.apply(&native(kind, "two")).unwrap();
            let current = s.clone();
            s.apply(&native("UserPromptSubmit", "one")).unwrap();
            assert_eq!(s, current, "late submit after {kind}");
        }
    }
    #[test]
    fn reply_readiness_is_attention_not_final_completion_and_can_resume_work() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("ResponseReady", Some("one"))).unwrap();
        assert_eq!(s.phase, "needs_attention");
        assert_eq!(s.inbox[0].kind, "needs_attention");
        let revision = s.revision;
        s.apply(&event("ResponseReady", Some("one"))).unwrap();
        assert_eq!(s.revision, revision);
        s.apply(&event("ToolProgress", Some("one"))).unwrap();
        assert_eq!(s.phase, "working");
        s.apply(&event("ResponseReady", Some("one"))).unwrap();
        assert_eq!(
            s.phase, "working",
            "duplicate stop cannot reset resumed work"
        );
        s.apply(&event("TurnFailed", Some("one"))).unwrap();
        let failed = s.clone();
        s.apply(&event("ResponseReady", Some("one"))).unwrap();
        assert_eq!(s, failed);
    }
    #[test]
    fn duplicates_and_late_events_cannot_affect_the_next_turn() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        let revision = s.revision;
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        assert_eq!(s.revision, revision);
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        assert_eq!(s.turn_id.as_deref(), Some("two"));
        assert_eq!(s.phase, "working");
        assert_eq!(s.inbox.len(), 1);
    }
    #[test]
    fn first_late_completion_is_recorded_in_its_own_round_without_changing_the_current_phase() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        assert!(s
            .apply(&event("TurnComplete", Some("one")))
            .unwrap()
            .is_some());
        assert_eq!(s.turn_id.as_deref(), Some("two"));
        assert_eq!(s.phase, "working");
        assert_eq!(s.inbox[0].turn_id, "one");
        s.apply(&event("TurnComplete", Some("two"))).unwrap();
        assert_eq!(s.inbox.len(), 2);
        assert_eq!(s.phase, "response_finished");
        assert!(s
            .apply(&event("TurnComplete", Some("never-submitted")))
            .is_err());
    }
    #[test]
    fn actual_native_compatibility_errors_are_permanent_but_session_bus_failures_are_transient() {
        for error in ["macOS notifications require the installed YAM.app bundle","This desktop cannot provide notifications that reopen YAM after exit. A notification portal with host-app Registry is required."] {assert!(permanent_delivery_error(error),"{error}");}
        assert!(!permanent_delivery_error(
            "Notification session bus unavailable: timeout"
        ));
    }
    #[test]
    fn integration_failure_cannot_keep_claiming_the_agent_is_working() {
        let root = std::env::temp_dir().join(format!(
            "yam-agent-degraded-{}",
            super::super::next_session_id()
        ));
        let store = super::super::HistoryStore::open(root.clone()).unwrap();
        store
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "a".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        store.configure_agent("a", "launch").unwrap();
        store
            .ingest_agent("a", "launch", &event("SessionStart", None))
            .unwrap();
        store
            .ingest_agent("a", "launch", &event("UserPromptSubmit", Some("one")))
            .unwrap();
        store
            .unavailable_agent("a", "event capacity reached")
            .unwrap();
        let state = store.list().unwrap().remove(0).agent;
        assert_eq!(state.phase, "unknown");
        assert_eq!(state.turn_id.as_deref(), Some("one"));
        assert_eq!(state.agent_session_id.as_deref(), Some("main-thread"));
        store
            .ingest_agent("a", "launch", &event("UserPromptSubmit", Some("two")))
            .unwrap();
        assert_eq!(store.list().unwrap()[0].agent.integration, "connected");
        assert!(store.agent_failure("a", "expired", "stale error").is_err());
        assert_eq!(store.list().unwrap()[0].agent.phase, "working");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn opencode_overflow_is_unavailable_without_erasing_receipts_or_poisoning_a_newer_turn() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        let mut degraded = event("IntegrationUnavailable", Some("one"));
        degraded.source = Some("opencode".into());
        s.apply(&degraded).unwrap();
        assert_eq!(s.phase, "working");
        degraded.turn_id = Some("two".into());
        s.apply(&degraded).unwrap();
        assert_eq!(s.phase, "unknown");
        assert_eq!(s.integration, "unavailable");
        assert_eq!(s.inbox.len(), 1);
        assert!(!s.inbox[0].read);
        degraded.source = Some("claude".into());
        assert!(s.apply(&degraded).is_err());
    }
    #[test]
    fn title_thread_and_stop_signal_do_not_send_completion() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("Stop", Some("one"))).unwrap();
        assert!(s.inbox.is_empty());
        assert_ne!(s.phase, "response_finished");
        let mut title = event("TurnComplete", Some("title"));
        title.agent_session_id = "title-thread".into();
        s.apply(&title).unwrap();
        assert!(s.inbox.is_empty());
        assert_eq!(s.agent_session_id.as_deref(), Some("main-thread"));
    }
    #[test]
    fn old_read_receipt_cannot_acknowledge_the_next_round() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("TurnComplete", Some("one"))).unwrap();
        assert_eq!(s.inbox.len(), 1);
        let old = s.inbox[0].clone();
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        s.apply(&event("TurnComplete", Some("two"))).unwrap();
        assert!(s.read(&old.id, old.revision + 1).is_err());
        s.read(&old.id, old.revision).unwrap();
        assert!(s.inbox[0].read);
        assert!(!s.inbox[1].read);
    }
    #[test]
    fn permission_and_interrupt_are_not_success_and_send_does_not_mean_read() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        assert_eq!(s.phase, "needs_permission");
        s.apply(&event("PermissionRequest", Some("one"))).unwrap();
        assert_eq!(s.inbox.len(), 1);
        s.apply(&event("Interrupt", Some("one"))).unwrap();
        assert_eq!(s.phase, "interrupted");
        assert!(!s.inbox[0].read);
    }
    #[test]
    fn interrupted_round_cannot_be_overwritten_by_late_success_or_stop() {
        let mut s = state();
        s.apply(&event("UserPromptSubmit", Some("one"))).unwrap();
        s.apply(&event("Interrupt", Some("one"))).unwrap();
        let interrupted = s.clone();
        for kind in ["Stop", "TurnComplete", "ResponseReady"] {
            s.apply(&event(kind, Some("one"))).unwrap();
            assert_eq!(s, interrupted, "late {kind} must not undo interruption");
        }
        s.apply(&event("UserPromptSubmit", Some("two"))).unwrap();
        s.apply(&event("TurnComplete", Some("two"))).unwrap();
        assert_eq!(s.phase, "response_finished");
        assert_eq!(s.inbox.len(), 2);
    }
    #[test]
    fn missing_identity_unknown_event_and_oversized_fields_are_rejected() {
        let mut s = state();
        assert!(s.apply(&event("UserPromptSubmit", None)).is_err());
        assert!(s.apply(&event("Unexpected", Some("one"))).is_err());
        let mut e = event("SessionStart", None);
        e.agent_session_id = "x".repeat(129);
        assert!(s.apply(&e).is_err());
        let mut empty = AgentState::default();
        assert!(empty.apply(&event("SessionStart", None)).is_err());
    }
    #[test]
    fn required_unread_receipts_are_bounded_without_silent_eviction() {
        let mut s = state();
        for turn in 0..512 {
            let t = turn.to_string();
            s.apply(&event("UserPromptSubmit", Some(&t))).unwrap();
            s.apply(&event("TurnComplete", Some(&t))).unwrap();
        }
        s.apply(&event("UserPromptSubmit", Some("overflow")))
            .unwrap();
        assert!(s.apply(&event("TurnComplete", Some("overflow"))).is_err());
        assert_eq!(s.inbox.len(), 512);
    }
    #[test]
    fn event_commit_read_and_send_receipts_survive_reopen_without_ending_process() {
        let root = std::env::temp_dir().join(format!(
            "yam-agent-store-{}",
            super::super::next_session_id()
        ));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        let summary = super::super::SessionSummary {
            ssh: None,
            session_id: "s-one".into(),
            cwd: "/tmp".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        history.start(&summary).unwrap();
        history.configure_agent("s-one", "generation").unwrap();
        for (kind, turn) in [
            ("SessionStart", None),
            ("UserPromptSubmit", Some("one")),
            ("TurnComplete", Some("one")),
        ] {
            history
                .ingest_agent("s-one", "generation", &event(kind, turn))
                .unwrap();
        }
        let record = history.list().unwrap().remove(0);
        let receipt = &record.agent.inbox[0];
        history
            .agent_delivery("s-one", &receipt.id, receipt.revision, "accepted", None)
            .unwrap();
        let reopened = super::super::HistoryStore::open(root.clone()).unwrap();
        assert_eq!(reopened.list().unwrap()[0].status, "running");
        assert!(!reopened.list().unwrap()[0].agent.inbox[0].read);
        reopened
            .read_agent_receipt("s-one", &receipt.id, receipt.revision)
            .unwrap();
        assert!(
            super::super::HistoryStore::open(root.clone())
                .unwrap()
                .list()
                .unwrap()[0]
                .agent
                .inbox[0]
                .read
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_commit_never_acknowledges_event_and_stale_launch_is_rejected() {
        let root = std::env::temp_dir().join(format!(
            "yam-agent-failure-{}",
            super::super::next_session_id()
        ));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        let summary = super::super::SessionSummary {
            ssh: None,
            session_id: "s-one".into(),
            cwd: "/tmp".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        history.start(&summary).unwrap();
        history.configure_agent("s-one", "generation").unwrap();
        assert!(history
            .ingest_agent("s-one", "old-generation", &event("SessionStart", None))
            .is_err());
        std::fs::create_dir(root.join("sessions.json.tmp")).unwrap();
        assert!(history
            .ingest_agent("s-one", "generation", &event("SessionStart", None))
            .is_err());
        assert_eq!(history.list().unwrap()[0].agent.agent_session_id, None);
        std::fs::remove_dir(root.join("sessions.json.tmp")).unwrap();
        history
            .ingest_agent("s-one", "generation", &event("SessionStart", None))
            .unwrap();
        assert_eq!(
            history.list().unwrap()[0].agent.agent_session_id.as_deref(),
            Some("main-thread")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn simultaneous_duplicate_events_commit_one_stable_receipt() {
        use std::sync::{Arc, Barrier};
        let root = std::env::temp_dir().join(format!(
            "yam-agent-race-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        let summary = super::super::SessionSummary {
            ssh: None,
            session_id: "s-one".into(),
            cwd: "/tmp".into(),
            command: None,
            status: "running".into(),
            launch: None,
        };
        history.start(&summary).unwrap();
        history.configure_agent("s-one", "generation").unwrap();
        history
            .ingest_agent("s-one", "generation", &event("SessionStart", None))
            .unwrap();
        history
            .ingest_agent(
                "s-one",
                "generation",
                &event("UserPromptSubmit", Some("one")),
            )
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let history = Arc::clone(&history);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    history
                        .ingest_agent("s-one", "generation", &event("TurnComplete", Some("one")))
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_some()).count(), 1);
        assert_eq!(history.list().unwrap()[0].agent.inbox.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn runtime_info_records_cli_without_hooks_for_task_and_gemini() {
        for (adapter, mode) in [("codex", "task"), ("gemini", "interactive")] {
            let root = std::env::temp_dir().join(format!(
                "yam-runtime-info-{}",
                super::super::next_session_id()
            ));
            let history = super::super::HistoryStore::open(root.clone()).unwrap();
            let summary = super::super::SessionSummary {
                ssh: None,
                session_id: "s-one".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "starting".into(),
                launch: Some(super::super::AgentLaunch {
                    adapter: adapter.into(),
                    mode: mode.into(),
                    extra_args: String::new(),
                    prompt: Some("fixture".into()),
                    codex: None,
                    claude_context: None,
                    provider: None,
                    env_refs: Default::default(),
                }),
            };
            history
                .start_continuation_with_cli(&summary, None, Some("/fixture/bin/agent"))
                .unwrap();
            history
                .unavailable_agent("s-one", "fixture unsupported hooks")
                .unwrap();
            let saved = super::super::HistoryStore::open(root.clone())
                .unwrap()
                .list()
                .unwrap()
                .remove(0);
            assert_eq!(saved.agent.cli_path.as_deref(), Some("/fixture/bin/agent"));
            assert_eq!(
                saved.agent.cli_platform.as_deref(),
                Some(std::env::consts::OS)
            );
            assert!(saved.agent.agent_session_id.is_none());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn runtime_info_cli_path_is_additive_and_preserved_by_native_events() {
        let mut legacy = serde_json::to_value(AgentState::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("cli_path");
        let old: AgentState = serde_json::from_value(legacy).unwrap();
        assert!(old.cli_path.is_none());
        let mut state = AgentState {
            generation: "generation".into(),
            cli_path: Some("/fixture/bin/codex".into()),
            ..Default::default()
        };
        state.apply(&event("SessionStart", None)).unwrap();
        state
            .apply(&event("UserPromptSubmit", Some("one")))
            .unwrap();
        assert_eq!(state.cli_path.as_deref(), Some("/fixture/bin/codex"));
        let restored: AgentState =
            serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap();
        assert_eq!(restored.cli_path.as_deref(), Some("/fixture/bin/codex"));
    }

    #[test]
    fn launch_cli_facts_are_additive_and_survive_native_event_updates() {
        let mut legacy = serde_json::to_value(AgentState::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("cli_version");
        legacy.as_object_mut().unwrap().remove("cli_platform");
        let old: AgentState = serde_json::from_value(legacy.clone()).unwrap();
        let old = serde_json::to_value(old).unwrap();
        assert!(old["cli_version"].is_null());
        assert!(old["cli_platform"].is_null());
        legacy["generation"] = "generation".into();
        legacy["cli_version"] = "codex-cli 0.162.1".into();
        legacy["cli_platform"] = "macos".into();
        let mut state: AgentState = serde_json::from_value(legacy).unwrap();
        state.apply(&event("SessionStart", None)).unwrap();
        state
            .apply(&event("UserPromptSubmit", Some("one")))
            .unwrap();
        let saved = serde_json::to_value(state).unwrap();
        assert_eq!(saved["cli_version"], "codex-cli 0.162.1");
        assert_eq!(saved["cli_platform"], "macos");
    }

    #[test]
    fn runtime_info_owner_configures_and_persists_cli_facts_per_launch_generation() {
        let root =
            std::env::temp_dir().join(format!("yam-cli-facts-{}", super::super::next_session_id()));
        let history = super::super::HistoryStore::open(root.clone()).unwrap();
        history
            .start(&super::super::SessionSummary {
                ssh: None,
                session_id: "s-one".into(),
                cwd: "/tmp".into(),
                command: None,
                status: "running".into(),
                launch: None,
            })
            .unwrap();
        history
            .configure_agent_version(
                "s-one",
                "generation",
                Some("codex-cli 0.162.1"),
                Some("/fixture/bin/codex"),
            )
            .unwrap();
        history
            .ingest_agent("s-one", "generation", &event("SessionStart", None))
            .unwrap();
        let reopened = super::super::HistoryStore::open(root.clone()).unwrap();
        let saved = &reopened.list().unwrap()[0].agent;
        assert_eq!(saved.cli_version.as_deref(), Some("codex-cli 0.162.1"));
        assert_eq!(saved.cli_platform.as_deref(), Some(std::env::consts::OS));
        assert_eq!(saved.cli_path.as_deref(), Some("/fixture/bin/codex"));
        reopened.configure_agent("s-one", "new-generation").unwrap();
        assert!(reopened.list().unwrap()[0].agent.cli_version.is_none());
        assert!(reopened.list().unwrap()[0].agent.cli_path.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "bounded isolated HistoryStore load; never uses installed app state"]
    fn agent_parallel_load_isolates_generations_receipts_and_persistent_history() {
        use std::sync::{Arc, Barrier};
        use std::time::{Duration, Instant};
        const WORKERS: usize = 8;
        const TURNS: usize = 32;
        let root = std::env::temp_dir().join(format!(
            "yam-agent-load-{}",
            super::super::next_session_id()
        ));
        let history = Arc::new(super::super::HistoryStore::open(root.clone()).unwrap());
        for worker in 0..WORKERS {
            let id = format!("s-{worker}");
            history
                .start(&super::super::SessionSummary {
                    ssh: None,
                    session_id: id.clone(),
                    cwd: "/tmp".into(),
                    command: None,
                    status: "running".into(),
                    launch: None,
                })
                .unwrap();
            history
                .configure_agent_version(
                    &id,
                    &format!("g-{worker}"),
                    Some("codex-cli 0.162.1"),
                    None,
                )
                .unwrap();
        }
        let barrier = Arc::new(Barrier::new(WORKERS + 1));
        let threads: Vec<_> = (0..WORKERS)
            .map(|worker| {
                let history = history.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let id = format!("s-{worker}");
                    let generation = format!("g-{worker}");
                    let native = format!("native-{worker}");
                    let make = |kind: &str, turn: Option<&str>| AgentEvent {
                        agent_session_id: native.clone(),
                        ..event(kind, turn)
                    };
                    barrier.wait();
                    let start = Instant::now();
                    history
                        .ingest_agent(&id, &generation, &make("SessionStart", None))
                        .unwrap();
                    let mut seconds = Vec::new();
                    for round in 0..TURNS {
                        let turn = format!("t-{worker}-{round}");
                        let tick = Instant::now();
                        history
                            .ingest_agent(&id, &generation, &make("UserPromptSubmit", Some(&turn)))
                            .unwrap();
                        let kind =
                            ["TurnComplete", "TurnFailed", "Interrupt"][(worker + round) % 3];
                        let done = make(kind, Some(&turn));
                        let receipt = history
                            .ingest_agent(&id, &generation, &done)
                            .unwrap()
                            .unwrap();
                        assert!(history
                            .ingest_agent(&id, &generation, &done)
                            .unwrap()
                            .is_none());
                        assert!(history.ingest_agent(&id, "old-generation", &done).is_err());
                        let mut foreign = done.clone();
                        foreign.agent_session_id = "foreign-native".into();
                        assert!(history
                            .ingest_agent(&id, &generation, &foreign)
                            .unwrap()
                            .is_none());
                        if round > 0 {
                            let previous = format!("t-{worker}-{}", round - 1);
                            let late = ["TurnComplete", "TurnFailed", "Interrupt"]
                                [(worker + round - 1) % 3];
                            assert!(history
                                .ingest_agent(&id, &generation, &make(late, Some(&previous)))
                                .unwrap()
                                .is_none());
                        }
                        let records = history.list().unwrap();
                        let entry = records
                            .iter()
                            .find(|r| r.summary.session_id == id)
                            .unwrap()
                            .agent
                            .inbox
                            .iter()
                            .find(|r| r.id == receipt)
                            .unwrap();
                        history
                            .agent_delivery(&id, &receipt, entry.revision, "accepted", None)
                            .unwrap();
                        history
                            .read_agent_receipt(&id, &receipt, entry.revision)
                            .unwrap();
                        seconds.push(tick.elapsed().as_secs_f64());
                    }
                    assert!(start.elapsed() < Duration::from_secs(30));
                    seconds
                })
            })
            .collect();
        let wall = Instant::now();
        barrier.wait();
        let mut latencies: Vec<_> = threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap())
            .collect();
        let expected = history.list().unwrap();
        let restored = super::super::HistoryStore::open(root.clone())
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(expected, restored);
        assert_eq!(restored.len(), WORKERS);
        for worker in 0..WORKERS {
            let row = restored
                .iter()
                .find(|r| r.summary.session_id == format!("s-{worker}"))
                .unwrap();
            assert_eq!(row.status, "running");
            assert_eq!(row.agent.generation, format!("g-{worker}"));
            assert_eq!(
                row.agent.agent_session_id.as_deref(),
                Some(format!("native-{worker}").as_str())
            );
            assert_eq!(row.agent.cli_version.as_deref(), Some("codex-cli 0.162.1"));
            let turns: Vec<_> = (0..TURNS)
                .map(|round| format!("t-{worker}-{round}"))
                .collect();
            let ids: Vec<_> = (0..TURNS)
                .map(|round| {
                    format!(
                        "g-{worker}:t-{worker}-{round}:{}",
                        ["TurnComplete", "TurnFailed", "Interrupt"][(worker + round) % 3]
                    )
                })
                .collect();
            assert_eq!(row.agent.turns, turns);
            assert_eq!(
                row.agent.turn_id.as_deref(),
                turns.last().map(String::as_str)
            );
            assert_eq!(row.agent.seen, ids);
            assert_eq!(row.agent.revision, 1 + 2 * TURNS as u64);
            assert_eq!(row.agent.integration, "connected");
            assert_eq!(
                row.agent.cli_platform.as_deref(),
                Some(std::env::consts::OS)
            );
            assert_eq!(row.agent.inbox.len(), TURNS);
            for (round, receipt) in row.agent.inbox.iter().enumerate() {
                assert_eq!(receipt.id, ids[round]);
                assert_eq!(receipt.turn_id, turns[round]);
                assert_eq!(receipt.revision, 3 + 2 * round as u64);
                assert_eq!(
                    receipt.kind,
                    ["response_finished", "failed", "interrupted"][(worker + round) % 3]
                );
                assert_eq!(receipt.error, None);
            }
            assert_eq!(
                row.agent.phase,
                ["response_finished", "failed", "interrupted"][(worker + TURNS - 1) % 3]
            );
            assert!(row.agent.inbox.iter().all(|r| r.read
                && r.delivery == "accepted"
                && r.turn_id.starts_with(&format!("t-{worker}-"))));
        }
        let unique: std::collections::HashSet<_> = restored
            .iter()
            .flat_map(|row| row.agent.inbox.iter().map(|receipt| &receipt.id))
            .collect();
        assert_eq!(unique.len(), WORKERS * TURNS);
        latencies.sort_by(f64::total_cmp);
        println!(
            "agent_parallel_load_metrics {}",
            serde_json::json!({"workers":WORKERS,"turns_per_worker":TURNS,"receipts":WORKERS*TURNS,"wall_seconds":wall.elapsed().as_secs_f64(),"round_p95_seconds":latencies[latencies.len()*95/100],"round_max_seconds":latencies.last().unwrap()})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
