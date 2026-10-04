// Author: Jeff.Liu.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct PauseState {
    pub paused: bool,
    pub revision: u64,
    pub owner_instance: String,
    pub established: bool,
}
#[derive(Clone, Default)]
pub(super) struct EntryState {
    pub pause: Option<PauseState>,
    pub enabled: bool,
    pub registered: bool,
    pub tray_available: bool,
    pub shortcut_available: bool,
    pub warning: Option<String>,
    context_requested: bool,
}
impl EntryState {
    pub fn initialize(
        &mut self,
        instance: &str,
        owner: bool,
        ready: bool,
        tray: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if !owner || !ready {
            return Err("system_entry_unavailable".into());
        }
        if self.pause.is_some() {
            return Ok(());
        }
        self.pause = Some(PauseState {
            paused: false,
            revision: 0,
            owner_instance: instance.into(),
            established: false,
        });
        tray().map_err(|_| "system_tray_unavailable".into())
    }
    pub fn seed(&mut self, owner: &str, paused: bool) -> Result<PauseState, String> {
        let state = self.pause.as_ref().ok_or("system_entry_unavailable")?;
        if owner != state.owner_instance {
            return Err("notification_pause_changed".into());
        }
        if state.established {
            return Ok(state.clone());
        }
        self.set_pause(owner, state.revision, paused)
    }
    pub fn set_pause(
        &mut self,
        owner: &str,
        revision: u64,
        paused: bool,
    ) -> Result<PauseState, String> {
        let state = self.pause.as_mut().ok_or("system_entry_unavailable")?;
        if owner != state.owner_instance || revision != state.revision {
            return Err("notification_pause_changed".into());
        }
        if !state.established || state.paused != paused {
            let next = state
                .revision
                .checked_add(1)
                .ok_or("notification_pause_changed")?;
            state.paused = paused;
            state.established = true;
            state.revision = next;
        }
        Ok(state.clone())
    }
    pub fn context(&mut self, legacy: Option<bool>) -> Result<PauseState, String> {
        let state = self
            .pause
            .as_ref()
            .ok_or("system_entry_unavailable")?
            .clone();
        match legacy {
            Some(paused) if !state.established => self.seed(&state.owner_instance, paused),
            _ => Ok(state),
        }
    }
    pub fn shortcut(
        &mut self,
        enabled: bool,
        native: impl FnOnce(bool) -> Result<(), String>,
        save: impl FnOnce(bool) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.registered != enabled {
            native(enabled).map_err(|_| "global_shortcut_unavailable".to_string())?;
            self.registered = enabled;
        }
        save(enabled).map_err(|_| "system_entry_preferences_unavailable".to_string())?;
        self.enabled = enabled;
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    version: u8,
    global_shortcut_enabled: bool,
}
pub(super) fn preferences(raw: &[u8]) -> Result<bool, String> {
    if raw.len() > 4096 {
        return Err("system_entry_preferences_invalid".into());
    }
    let value: Preferences =
        serde_json::from_slice(raw).map_err(|_| "system_entry_preferences_invalid")?;
    if value.version != 1 {
        return Err("system_entry_preferences_invalid".into());
    }
    Ok(value.global_shortcut_enabled)
}
pub(super) fn open(
    ready: bool,
    connected: bool,
    relay: impl FnOnce() -> Result<(), String>,
    launch: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !ready {
        return Err("system_entry_unavailable".into());
    }
    if connected {
        let _ = relay();
    }
    launch().map_err(|_| "system_entry_open_failed".into())
}
pub(super) fn stop_and_quit(
    stop: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(),
) -> Result<(), String> {
    stop().map_err(|_| "system_entry_shutdown_failed")?;
    exit();
    Ok(())
}
pub(super) fn pause_command(
    manager: &super::SessionManager,
    command: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    super::background::validate_command(command, args)?;
    let mut settings = manager
        .system_entry
        .lock()
        .map_err(|_| "system_entry_unavailable")?;
    let bridge = manager
        .agent_bridge
        .lock()
        .map_err(|_| "system_entry_unavailable")?;
    let mut context = bridge
        .as_ref()
        .map(|value| value.context.lock().map_err(|_| "system_entry_unavailable"))
        .transpose()?;
    let previous = settings.pause.clone();
    if command == "set_agent_notification_context" {
        settings.context_requested = true;
    }
    let state = match command {
        "get_notification_pause_state" => {
            settings.pause.clone().ok_or("system_entry_unavailable")?
        }
        "initialize_notification_pause" => settings.seed(
            args["expected_owner_instance"]
                .as_str()
                .ok_or("system_entry_invalid")?,
            args["legacy_paused"]
                .as_bool()
                .ok_or("system_entry_invalid")?,
        )?,
        "set_notification_paused" => settings.set_pause(
            args["expected_owner_instance"]
                .as_str()
                .ok_or("system_entry_invalid")?,
            args["expected_revision"]
                .as_u64()
                .ok_or("system_entry_invalid")?,
            args["paused"].as_bool().ok_or("system_entry_invalid")?,
        )?,
        "set_agent_notification_context" => {
            settings.context(args.get("paused").and_then(serde_json::Value::as_bool))?
        }
        _ => return Err("system_entry_invalid".into()),
    };
    if let Some(context) = context.as_mut() {
        synchronize_context(&settings, context, command, args)?;
    }
    drop(context);
    drop(bridge);
    drop(settings);
    let value = serde_json::to_value(&state).map_err(|_| "system_entry_unavailable")?;
    if previous.as_ref() != Some(&state) {
        manager
            .relay
            .lock()
            .map_err(|_| "system_entry_unavailable")?
            .push("notification-pause-state", value.to_string());
    }
    Ok(value)
}
fn synchronize_context(
    settings: &EntryState,
    context: &mut (bool, Option<String>, bool),
    command: &str,
    args: &serde_json::Value,
) -> Result<(), String> {
    let state = settings.pause.as_ref().ok_or("system_entry_unavailable")?;
    context.2 = state.paused;
    context.0 = settings.context_requested && state.established;
    if command == "set_agent_notification_context" {
        context.1 = args["selected"].as_str().map(str::to_owned);
    }
    Ok(())
}
pub(super) fn lifecycle_context(
    manager: &super::SessionManager,
) -> Result<(Option<String>, bool), String> {
    let settings = manager
        .system_entry
        .lock()
        .map_err(|_| "system_entry_unavailable")?;
    let state = settings.pause.as_ref().ok_or("system_entry_unavailable")?;
    if (settings.context_requested
        || manager
            .desktop_connected
            .load(std::sync::atomic::Ordering::Acquire))
        && !state.established
    {
        return Err("system_entry_unavailable".into());
    }
    let paused = state.paused;
    let bridge = manager
        .agent_bridge
        .lock()
        .map_err(|_| "system_entry_unavailable")?;
    let selected = bridge
        .as_ref()
        .map(|value| {
            value
                .context
                .lock()
                .map(|context| context.1.clone())
                .map_err(|_| "system_entry_unavailable")
        })
        .transpose()?
        .flatten();
    Ok((selected, paused))
}
pub(super) fn read_preferences(path: &std::path::Path) -> Result<bool, String> {
    use std::io::Read;
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("system_entry_preferences_invalid".into()),
        Ok(_) => {}
    }
    let file = super::background::private_file(path, false)
        .map_err(|_| "system_entry_preferences_invalid")?;
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "system_entry_preferences_invalid")?;
    preferences(&bytes)
}
pub(super) fn save_preferences(path: &std::path::Path, enabled: bool) -> Result<(), String> {
    use std::io::Write;
    let save = || -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or("system_entry_preferences_unavailable")?;
        let metadata = std::fs::symlink_metadata(parent)
            .map_err(|_| "system_entry_preferences_unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("system_entry_preferences_unavailable".into());
        }
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                super::background::private_file(path, false)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("system_entry_preferences_unavailable".into()),
        }
        let temporary = parent.join(format!(
            ".system-entry-{}-{}.tmp",
            std::process::id(),
            super::next_session_id()
        ));
        let result = (|| -> Result<(), String> {
            let mut file = super::background::private_file(&temporary, true)?;
            file.write_all(
                serde_json::json!({"version":1,"global_shortcut_enabled":enabled})
                    .to_string()
                    .as_bytes(),
            )
            .map_err(|_| "system_entry_preferences_unavailable")?;
            file.sync_all()
                .map_err(|_| "system_entry_preferences_unavailable")?;
            std::fs::rename(&temporary, path)
                .map_err(|_| "system_entry_preferences_unavailable")?;
            #[cfg(unix)]
            std::fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|_| "system_entry_preferences_unavailable")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    };
    save().map_err(|_| "system_entry_preferences_unavailable".into())
}
pub(super) fn owner_open(
    manager: &super::SessionManager,
    relay: impl FnOnce() -> Result<(), String>,
    launch: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let ready = manager.background_owner
        && manager
            .system_entry
            .lock()
            .map_err(|_| "system_entry_unavailable")?
            .pause
            .is_some();
    {
        let _sessions = manager
            .sessions
            .lock()
            .map_err(|_| "system_entry_unavailable")?;
        if !ready || manager.shutting_down.load(Ordering::Acquire) {
            return Err("system_entry_unavailable".into());
        }
        manager.last_request.store(
            manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Ordering::Release,
        );
    }
    let connected = manager.desktop_connected.load(Ordering::Acquire)
        && manager
            .desktop_focus
            .lock()
            .map_err(|_| "system_entry_unavailable")?
            .0
            .elapsed()
            < std::time::Duration::from_secs(3);
    open(ready, connected, relay, launch)
}
pub(super) fn owner_stop(
    manager: &super::SessionManager,
    stop: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(),
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    {
        let _sessions = manager
            .sessions
            .lock()
            .map_err(|_| "system_entry_unavailable")?;
        if !manager.background_owner || manager.shutting_down.swap(true, Ordering::AcqRel) {
            return Err("system_entry_unavailable".into());
        }
    }
    let result = stop_and_quit(stop, exit);
    if result.is_err() {
        manager.shutting_down.store(false, Ordering::Release);
    }
    result
}
pub(super) fn configure_shortcut(
    manager: &super::SessionManager,
    enabled: bool,
    native: impl FnOnce(bool) -> Result<(), String>,
    save: impl FnOnce(bool) -> Result<(), String>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if manager.system_entry_busy.swap(true, Ordering::AcqRel) {
        return Err("system_entry_busy".into());
    }
    struct Release<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            self.0.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _release = Release(&manager.system_entry_busy);
    let mut state = manager
        .system_entry
        .lock()
        .map_err(|_| "system_entry_unavailable")?
        .clone();
    if !manager.background_owner || state.pause.is_none() {
        return Err("system_entry_unavailable".into());
    }
    // OS operations dispatch to the main thread and wait. No manager or settings guard crosses this call.
    let result = state.shortcut(enabled, native, save);
    let mut current = manager
        .system_entry
        .lock()
        .map_err(|_| "system_entry_unavailable")?;
    current.enabled = state.enabled;
    current.registered = state.registered;
    current.warning = result.as_ref().err().cloned();
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn state() -> EntryState {
        let mut s = EntryState::default();
        s.initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        s
    }
    #[test]
    fn t11_owner_only_ready_once_and_default_shortcut_off() {
        let calls = Cell::new(0);
        let mut s = EntryState::default();
        assert!(s
            .initialize("owner", false, true, || {
                calls.set(1);
                Ok(())
            })
            .is_err());
        assert!(s
            .initialize("owner", true, false, || {
                calls.set(1);
                Ok(())
            })
            .is_err());
        assert_eq!(calls.get(), 0);
        s.initialize(&"a".repeat(64), true, true, || {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        s.initialize(&"a".repeat(64), true, true, || {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert!(!s.enabled && !s.registered);
    }
    #[test]
    fn t11_pause_migration_and_tray_precedence() {
        let mut s = state();
        let p = s.set_pause(&"a".repeat(64), 0, true).unwrap();
        assert!(p.paused && p.established);
        assert_eq!(s.seed(&"a".repeat(64), false).unwrap(), p);
        assert_eq!(s.context(Some(false)).unwrap(), p);
    }
    #[test]
    fn t11_pause_owner_and_revision_cas_are_atomic() {
        let mut s = state();
        let p = s.seed(&"a".repeat(64), true).unwrap();
        assert!(s.set_pause(&"b".repeat(64), p.revision, false).is_err());
        assert!(s.set_pause(&"a".repeat(64), 0, false).is_err());
        assert_eq!(s.pause.as_ref(), Some(&p));
        assert_eq!(
            s.set_pause(&"a".repeat(64), p.revision, true)
                .unwrap()
                .revision,
            p.revision
        );
        let mut overflow = state();
        overflow.pause.as_mut().unwrap().revision = u64::MAX;
        assert!(overflow.set_pause(&"a".repeat(64), u64::MAX, true).is_err());
        assert!(!overflow.pause.unwrap().paused);
    }
    #[test]
    fn t11_legacy_context_seeds_once_without_history_or_bridge() {
        let mut s = state();
        let p = s.context(Some(true)).unwrap();
        assert_eq!(p.revision, 1);
        assert!(p.paused);
        assert_eq!(s.context(Some(false)).unwrap(), p);
    }
    #[test]
    fn t11_shortcut_explicit_only_conflict_disable_and_save_failure() {
        let mut s = state();
        let calls = Cell::new(0);
        assert!(s
            .shortcut(
                true,
                |_| {
                    calls.set(1);
                    Err("OS conflict".into())
                },
                |_| Ok(())
            )
            .is_err());
        assert!(!s.registered && !s.enabled);
        s.shortcut(
            true,
            |v| {
                assert!(v);
                calls.set(calls.get() + 1);
                Ok(())
            },
            |v| {
                assert!(v);
                Ok(())
            },
        )
        .unwrap();
        assert!(s.registered && s.enabled);
        assert!(s
            .shortcut(false, |_| Err("unregister".into()), |_| Ok(()))
            .is_err());
        assert!(s.registered);
        assert!(s
            .shortcut(false, |_| Ok(()), |_| Err("disk".into()))
            .is_err());
        assert!(!s.registered);
        assert_eq!(calls.get(), 2);
    }
    #[test]
    fn t11_preferences_bounded_strict_boolean_only() {
        assert!(!preferences(br#"{"version":1,"global_shortcut_enabled":false}"#).unwrap());
        assert!(preferences(br#"{"version":1,"global_shortcut_enabled":true}"#).unwrap());
        for raw in [
            br#"{"version":2,"global_shortcut_enabled":true}"#.as_slice(),
            br#"{"version":1,"global_shortcut_enabled":"secret"}"#,
            br#"{"version":1,"global_shortcut_enabled":true,"command":"secret"}"#,
            b"bad",
        ] {
            assert!(preferences(raw).is_err());
        }
        assert!(preferences(&vec![b'x'; 4097]).is_err());
    }
    #[test]
    fn t11_open_existing_gui_or_fixed_launch_without_task_operation() {
        let relay = Cell::new(0);
        let launch = Cell::new(0);
        open(
            true,
            true,
            || {
                relay.set(1);
                Ok(())
            },
            || {
                launch.set(1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!((relay.get(), launch.get()), (1, 1));
        open(
            true,
            false,
            || Ok(()),
            || {
                launch.set(1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(launch.get(), 1);
        assert!(open(false, true, || panic!(), || panic!()).is_err());
    }
    #[test]
    fn t11_explicit_stop_all_only_exits_after_success() {
        let exited = Cell::new(false);
        assert!(stop_and_quit(|| Err("cleanup".into()), || exited.set(true)).is_err());
        assert!(!exited.get());
        stop_and_quit(|| Ok(()), || exited.set(true)).unwrap();
        assert!(exited.get());
    }
}

#[cfg(test)]
mod wiring_tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    fn manager() -> super::super::SessionManager {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        manager
    }
    #[test]
    fn t11_actual_pause_rpc_strict_and_fenced_then_legacy_context_preserves_tray_choice() {
        let manager = manager();
        let owner = "a".repeat(64);
        for (command, args) in [
            ("get_notification_pause_state", json!({})),
            (
                "initialize_notification_pause",
                json!({"legacy_paused":false,"expected_owner_instance":owner}),
            ),
            (
                "set_notification_paused",
                json!({"paused":true,"expected_revision":0,"expected_owner_instance":owner}),
            ),
            ("set_agent_notification_context", json!({"selected":null})),
        ] {
            super::super::background::validate_command(command, &args).unwrap();
        }
        let chosen = pause_command(
            &manager,
            "set_notification_paused",
            &json!({"paused":true,"expected_revision":0,"expected_owner_instance":owner}),
        )
        .unwrap();
        let later = pause_command(
            &manager,
            "set_agent_notification_context",
            &json!({"selected":null,"paused":false}),
        )
        .unwrap();
        assert_eq!(chosen, later);
        assert!(later["paused"].as_bool().unwrap());
        assert!(pause_command(
            &manager,
            "set_notification_paused",
            &json!({"paused":false,"expected_revision":1,"expected_owner_instance":"b".repeat(64)})
        )
        .is_err());
        for args in [
            json!({"paused":"secret","expected_revision":1,"expected_owner_instance":owner}),
            json!({"paused":false,"expected_revision":1,"expected_owner_instance":owner,"secret":"secret"}),
            json!({"paused":false,"expected_revision":-1,"expected_owner_instance":owner}),
        ] {
            assert!(
                super::super::background::validate_command("set_notification_paused", &args)
                    .is_err()
            );
        }
        assert!(manager.history.lock().unwrap().is_none());
        assert!(manager.agent_bridge.lock().unwrap().is_none());
        assert!(manager.input_leases.lock().unwrap().t11_owner_count() == 0);
    }
    #[test]
    fn t11_lifecycle_without_bridge_uses_authoritative_pause_no_initialization() {
        let manager = manager();
        manager
            .system_entry
            .lock()
            .unwrap()
            .set_pause(&"a".repeat(64), 0, true)
            .unwrap();
        assert_eq!(lifecycle_context(&manager).unwrap(), (None, true));
        assert!(manager.history.lock().unwrap().is_none());
    }
    #[test]
    fn t11_authenticated_wire_snapshot_and_owner_replacement_cas() {
        let root = std::env::temp_dir().join(format!(
            "yam-t11-wire-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let manager = Arc::new(manager());
        let peer = manager.clone();
        let server = super::super::background::Server::start(&root, move |request| {
            super::super::background::validate_command(&request.command, &request.args)?;
            pause_command(&peer, &request.command, &request.args)
        })
        .unwrap();
        let client = super::super::background::Client::new(
            super::super::background::Descriptor::read(&root).unwrap(),
        )
        .unwrap();
        let state = client
            .call("get_notification_pause_state", json!({}))
            .unwrap();
        assert_eq!(state["owner_instance"], "a".repeat(64));
        assert!(client
            .call(
                "initialize_notification_pause",
                json!({"legacy_paused":true,"expected_owner_instance":"b".repeat(64)})
            )
            .is_err());
        assert_eq!(
            client
                .call("get_notification_pause_state", json!({}))
                .unwrap(),
            state
        );
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod native_operation_tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    fn manager() -> super::super::SessionManager {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        manager
    }
    #[test]
    fn t11_real_open_admission_and_stop_failure_restore_gate_without_lease_or_selection_change() {
        let manager = manager();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let launches = Cell::new(0);
        owner_open(
            &manager,
            || panic!("not connected"),
            || {
                assert!(manager.sessions.try_lock().is_ok());
                launches.set(1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(launches.get(), 1);
        assert!(manager.last_request.load(Ordering::Acquire) > 0);
        manager.desktop_connected.store(true, Ordering::Release);
        *manager.desktop_focus.lock().unwrap() = (std::time::Instant::now(), true);
        owner_open(
            &manager,
            || Ok(()),
            || {
                launches.set(launches.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(launches.get(), 2);
        assert!(owner_stop(
            &manager,
            || {
                assert!(manager.shutting_down.load(Ordering::Acquire));
                assert!(manager.sessions.try_lock().is_ok());
                Err("secret".into())
            },
            || panic!()
        )
        .is_err());
        assert!(!manager.shutting_down.load(Ordering::Acquire));
        let exited = Cell::new(false);
        owner_stop(&manager, || Ok(()), || exited.set(true)).unwrap();
        assert!(exited.get());
        assert!(owner_open(&manager, || panic!(), || panic!()).is_err());
        assert!(manager.notification_selection.lock().unwrap().is_none());
        assert_eq!(manager.input_leases.lock().unwrap().t11_owner_count(), 0);
    }
    #[test]
    fn t11_shortcut_native_operations_release_all_business_and_settings_locks() {
        let manager = manager();
        configure_shortcut(
            &manager,
            true,
            |enabled| {
                assert!(enabled);
                assert!(manager.system_entry.try_lock().is_ok());
                assert!(manager.agent_bridge.try_lock().is_ok());
                assert!(manager.sessions.try_lock().is_ok());
                Ok(())
            },
            |enabled| {
                assert!(enabled);
                Ok(())
            },
        )
        .unwrap();
        assert!(manager.system_entry.lock().unwrap().registered);
    }
    #[test]
    fn t11_native_preferences_missing_defaults_disabled_without_writing() {
        let root = std::env::temp_dir().join(format!(
            "yam-t11-missing-prefs-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("system-entry.json");
        for _ in 0..2 {
            assert_eq!(read_preferences(&path), Ok(false));
            assert!(std::fs::symlink_metadata(&path).is_err());
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        }
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn t11_native_preferences_existing_invalid_sources_stay_rejected() {
        let root = std::env::temp_dir().join(format!(
            "yam-t11-invalid-prefs-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("system-entry.json");
        save_preferences(&path, false).unwrap();
        assert_eq!(read_preferences(&path), Ok(false));
        save_preferences(&path, true).unwrap();
        assert_eq!(read_preferences(&path), Ok(true));
        for bytes in [
            Vec::new(),
            b"bad".to_vec(),
            br#"{"version":2,"global_shortcut_enabled":false}"#.to_vec(),
            br#"{"version":1,"global_shortcut_enabled":"false"}"#.to_vec(),
            br#"{"version":1,"global_shortcut_enabled":false,"command":"secret"}"#.to_vec(),
            vec![b' '; 4097],
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                read_preferences(&path),
                Err("system_entry_preferences_invalid".into())
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        // An inaccessible path shape must not be mistaken for absence.
        assert_eq!(
            read_preferences(&path.join("child")),
            Err("system_entry_preferences_invalid".into())
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn t11_native_preferences_dangling_link_and_appearing_unsafe_file_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!(
            "yam-t11-link-prefs-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("system-entry.json");
        let missing = root.join("missing");
        symlink(&missing, &path).unwrap();
        assert_eq!(
            read_preferences(&path),
            Err("system_entry_preferences_invalid".into())
        );
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!missing.exists());
        std::fs::remove_file(&path).unwrap();
        // A later unsafe entry is independently rejected, never accepted as a default.
        save_preferences(&path, true).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            read_preferences(&path),
            Err("system_entry_preferences_invalid".into())
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn t11_private_preferences_atomic_roundtrip_and_link_directory_corruption_rejected() {
        let root = std::env::temp_dir().join(format!(
            "yam-t11-prefs-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("system-entry.json");
        assert_eq!(read_preferences(&path), Ok(false));
        save_preferences(&path, true).unwrap();
        assert!(read_preferences(&path).unwrap());
        save_preferences(&path, false).unwrap();
        assert!(!read_preferences(&path).unwrap());
        std::fs::write(&path, b"bad").unwrap();
        assert!(read_preferences(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(save_preferences(&path, true).is_err());
        assert!(read_preferences(&path).is_err());
        std::fs::remove_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let other = root.join("other");
            std::fs::write(&other, b"secret").unwrap();
            symlink(&other, &path).unwrap();
            assert!(read_preferences(&path).is_err());
            assert!(save_preferences(&path, true).is_err());
            assert_eq!(std::fs::read(&other).unwrap(), b"secret");
            std::fs::remove_file(&path).unwrap();
            save_preferences(&path, true).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_preferences(&path).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Clone)]
pub(super) struct NativeEntry {
    _tray: tauri::tray::TrayIcon,
    summary: tauri::menu::MenuItem<tauri::Wry>,
    pause: tauri::menu::CheckMenuItem<tauri::Wry>,
    preferences: std::path::PathBuf,
}
pub(super) fn menu_action(
    id: &str,
    pressed: bool,
    open: impl FnOnce() -> Result<(), String>,
    pause: impl FnOnce() -> Result<(), String>,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !pressed {
        return Ok(());
    }
    match id {
        "yam-open" => open(),
        "yam-pause" => pause(),
        "yam-stop" => stop(),
        _ => Err("system_entry_invalid".into()),
    }
}
pub(super) fn status(manager: &super::SessionManager) -> Result<serde_json::Value, String> {
    let state = manager
        .system_entry
        .try_lock()
        .map_err(|_| "system_entry_unavailable")?
        .clone();
    let running = manager
        .sessions
        .try_lock()
        .ok()
        .map(|sessions| sessions.len());
    let unread = manager.history.try_lock().ok().and_then(|history| {
        history.as_ref().and_then(|history| {
            if history
                .archive_pending
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return None;
            }
            let records = history.records.try_lock().ok()?;
            if records.len() > 10_000 {
                return None;
            }
            let mut count = 0usize;
            let mut receipts = 0usize;
            for record in records.iter() {
                count += usize::from(record.notification_pending);
                receipts += record.agent.inbox.len();
                if receipts > 100_000 {
                    return None;
                }
                count += record
                    .agent
                    .inbox
                    .iter()
                    .filter(|receipt| !receipt.read)
                    .count();
            }
            Some(count)
        })
    });
    Ok(
        serde_json::json!({"owner_instance":state.pause.as_ref().map(|pause|pause.owner_instance.clone()),"global_shortcut_enabled":state.enabled,"global_shortcut_registered":state.registered,"shortcut_available":state.shortcut_available,"tray_available":state.tray_available,"warning":state.warning,"running":running,"unread":unread}),
    )
}
#[cfg(test)]
mod menu_tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    #[test]
    fn t11_actual_native_callback_finite_actions_pressed_only_and_status_has_no_heartbeat() {
        let calls = Cell::new(0);
        menu_action("yam-open", false, || panic!(), || panic!(), || panic!()).unwrap();
        menu_action(
            "yam-open",
            true,
            || {
                calls.set(1);
                Ok(())
            },
            || panic!(),
            || panic!(),
        )
        .unwrap();
        menu_action(
            "yam-pause",
            true,
            || panic!(),
            || {
                calls.set(2);
                Ok(())
            },
            || panic!(),
        )
        .unwrap();
        menu_action(
            "yam-stop",
            true,
            || panic!(),
            || panic!(),
            || {
                calls.set(3);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert!(menu_action("user-command", true, || panic!(), || panic!(), || panic!()).is_err());
        let manager = super::super::SessionManager::default();
        manager.last_request.store(99, Ordering::Release);
        let summary = status(&manager).unwrap();
        assert_eq!(summary["running"], 0);
        assert!(summary["unread"].is_null());
        assert_eq!(manager.last_request.load(Ordering::Acquire), 99);
        assert!(manager.history.lock().unwrap().is_none());
        assert!(manager.agent_bridge.lock().unwrap().is_none());
        assert!(manager.notification_selection.lock().unwrap().is_none());
    }
}

pub(super) fn show_desktop(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .ok_or("system_entry_open_failed")?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|_| "system_entry_open_failed".into())
}
fn report(app: &tauri::AppHandle, warning: &str) {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    if let Ok(mut state) = manager.system_entry.lock() {
        state.warning = Some(warning.into());
    }
    publish_status(&manager);
}
fn publish_status(manager: &super::SessionManager) {
    if let Ok(value) = status(manager) {
        if let Ok(mut relay) = manager.relay.lock() {
            relay.push("system-entry-status", value.to_string());
        }
    }
}
pub(super) fn open_native(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    owner_open(
        &manager,
        || {
            manager
                .relay
                .lock()
                .map_err(|_| "system_entry_unavailable")?
                .push("desktop-open", "{}".into());
            Ok(())
        },
        || {
            std::process::Command::new(
                std::env::current_exe().map_err(|_| "system_entry_open_failed")?,
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "system_entry_open_failed")?;
            Ok(())
        },
    )
}
fn stop_native(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    owner_stop(
        &manager,
        || manager.shutdown(),
        || {
            if let Ok(mut relay) = manager.relay.lock() {
                relay.push("desktop-owner-quit", "{}".into());
            }
            app.exit(0);
        },
    )
}
fn dispatch_native(app: &tauri::AppHandle, id: &str, pressed: bool) {
    use tauri::Manager;
    let result = menu_action(
        id,
        pressed,
        || open_native(app),
        || {
            let manager = app.state::<super::SessionManager>();
            let state = manager
                .system_entry
                .lock()
                .map_err(|_| "system_entry_unavailable")?
                .pause
                .clone()
                .ok_or("system_entry_unavailable")?;
            pause_command(&manager, "set_notification_paused", &serde_json::json!({"paused":!state.paused,"expected_revision":state.revision,"expected_owner_instance":state.owner_instance})).map(|_| ())
        },
        || stop_native(app),
    );
    if result.is_err() {
        report(app, "system_entry_action_failed");
    }
    refresh_native(app);
}
pub(super) fn set_shortcut_native(
    app: &tauri::AppHandle,
    enabled: bool,
    owner_instance: &str,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.state::<super::SessionManager>();
    {
        let state = manager
            .system_entry
            .lock()
            .map_err(|_| "system_entry_unavailable")?;
        if state
            .pause
            .as_ref()
            .is_none_or(|pause| pause.owner_instance != owner_instance)
        {
            return Err("system_entry_owner_changed".into());
        }
        if !state.shortcut_available {
            return Err("global_shortcut_unavailable".into());
        }
    }
    let path = manager
        .system_entry_native
        .lock()
        .map_err(|_| "system_entry_unavailable")?
        .as_ref()
        .ok_or("system_entry_unavailable")?
        .preferences
        .clone();
    let result = configure_shortcut(
        &manager,
        enabled,
        |enabled| {
            if enabled {
                app.global_shortcut().register("CommandOrControl+Shift+Y")
            } else {
                app.global_shortcut().unregister("CommandOrControl+Shift+Y")
            }
            .map_err(|_| "global_shortcut_unavailable".into())
        },
        |enabled| save_preferences(&path, enabled),
    );
    publish_status(&manager);
    result?;
    status(&manager)
}
pub(super) fn initialize_native(app: &tauri::AppHandle, root: &std::path::Path) {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    // Called once from owner setup, on the native main thread, after exclusive Server readiness.
    let ready = manager.background_owner
        && manager
            .system_entry
            .lock()
            .is_ok_and(|state| state.pause.is_some());
    if !ready {
        return;
    }
    let plugin = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    let app = app.clone();
                    std::thread::spawn(move || dispatch_native(&app, "yam-open", true));
                }
            })
            .build(),
    );
    if let Ok(mut state) = manager.system_entry.lock() {
        state.shortcut_available = plugin.is_ok();
        if plugin.is_err() {
            state.warning = Some("global_shortcut_unavailable".into());
        }
    }
    let built = (|| -> Result<NativeEntry, String> {
        use tauri::menu::{CheckMenuItem, Menu, MenuItem};
        let summary = MenuItem::with_id(
            app,
            "yam-summary",
            "Tasks / unread unavailable",
            false,
            None::<&str>,
        )
        .map_err(|_| "system_tray_unavailable")?;
        let open = MenuItem::with_id(app, "yam-open", "Open YAM", true, None::<&str>)
            .map_err(|_| "system_tray_unavailable")?;
        let pause = CheckMenuItem::with_id(
            app,
            "yam-pause",
            "Pause notifications",
            true,
            false,
            None::<&str>,
        )
        .map_err(|_| "system_tray_unavailable")?;
        let stop = MenuItem::with_id(
            app,
            "yam-stop",
            "Stop all tasks and quit",
            true,
            None::<&str>,
        )
        .map_err(|_| "system_tray_unavailable")?;
        let menu = Menu::with_items(app, &[&summary, &open, &pause, &stop])
            .map_err(|_| "system_tray_unavailable")?;
        let icon = app
            .default_window_icon()
            .cloned()
            .ok_or("system_tray_unavailable")?;
        let tray = tauri::tray::TrayIconBuilder::with_id("yam-owner-entry")
            .icon(icon)
            .menu(&menu)
            .on_menu_event(|app, event| {
                let app = app.clone();
                let id = event.id().as_ref().to_string();
                std::thread::spawn(move || dispatch_native(&app, &id, true));
            })
            .build(app)
            .map_err(|_| "system_tray_unavailable")?;
        Ok(NativeEntry {
            _tray: tray,
            summary,
            pause,
            preferences: root.join("system-entry.json"),
        })
    })();
    match built {
        Ok(native) => {
            let path = native.preferences.clone();
            if let Ok(mut slot) = manager.system_entry_native.lock() {
                *slot = Some(native);
            }
            if let Ok(mut state) = manager.system_entry.lock() {
                state.tray_available = true;
            }
            match read_preferences(&path) {
                Ok(enabled) => {
                    let owner = if let Ok(mut state) = manager.system_entry.lock() {
                        state.enabled = enabled;
                        state
                            .pause
                            .as_ref()
                            .map(|pause| pause.owner_instance.clone())
                    } else {
                        None
                    };
                    if enabled {
                        if let Some(owner) = owner {
                            if set_shortcut_native(app, true, &owner).is_err() {
                                report(app, "global_shortcut_unavailable");
                            }
                        }
                    }
                }
                Err(_) => report(app, "system_entry_preferences_invalid"),
            }
        }
        Err(_) => report(app, "system_tray_unavailable"),
    }
    refresh_native(app);
}
pub(super) fn refresh_native(app: &tauri::AppHandle) {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    let native = manager
        .system_entry_native
        .try_lock()
        .ok()
        .and_then(|value| value.clone());
    let state = manager
        .system_entry
        .try_lock()
        .ok()
        .and_then(|value| value.pause.clone());
    let summary = status(&manager).ok();
    // Handles are cloned under short locks; native APIs can dispatch/wait only after those guards drop.
    if let Some(native) = native {
        if let Some(state) = state {
            let _ = native.pause.set_checked(state.paused);
        }
        if let Some(summary) = summary {
            let number = |key: &str| {
                summary[key]
                    .as_u64()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "unavailable".into())
            };
            let _ = native.summary.set_text(format!(
                "Tasks: {} / unread: {}",
                number("running"),
                number("unread")
            ));
        }
    }
}

#[cfg(test)]
mod open_delivery_tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    #[test]
    fn t11_actual_open_fresh_heartbeat_without_consumer_still_delivers_normal_single_instance_launch(
    ) {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        manager.desktop_connected.store(true, Ordering::Release);
        *manager.desktop_focus.lock().unwrap() = (std::time::Instant::now(), false);
        *manager.notification_selection.lock().unwrap() = Some("s-1-2".into());
        let relay = Cell::new(0);
        let launch = Cell::new(0);
        owner_open(
            &manager,
            || {
                relay.set(1);
                Ok(())
            },
            || {
                launch.set(1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(relay.get(), 1);
        assert_eq!(launch.get(), 1, "fresh heartbeat is not delivery proof");
        owner_open(
            &manager,
            || Err("stale peer".into()),
            || {
                launch.set(launch.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(launch.get(), 2);
        assert_eq!(
            manager.notification_selection.lock().unwrap().as_deref(),
            Some("s-1-2")
        );
        assert_eq!(manager.input_leases.lock().unwrap().t11_owner_count(), 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod initial_pause_tests {
    use super::*;
    use std::sync::atomic::Ordering;
    #[test]
    fn t11_actual_bridge_context_waits_for_migration_and_lifecycle_new_gui_is_fail_closed() {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        let mut context = (false, None, false);
        let mut settings = manager.system_entry.lock().unwrap();
        settings.context_requested = true;
        synchronize_context(
            &settings,
            &mut context,
            "set_agent_notification_context",
            &serde_json::json!({"selected":null}),
        )
        .unwrap();
        assert!(
            !context.0,
            "selection must not start delivery before one-time pause migration"
        );
        settings.seed(&"a".repeat(64), true).unwrap();
        synchronize_context(
            &settings,
            &mut context,
            "initialize_notification_pause",
            &serde_json::json!({}),
        )
        .unwrap();
        assert!(context.0 && context.2);
        drop(settings);
        let initial = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        initial
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"b".repeat(64), true, true, || Ok(()))
            .unwrap();
        assert_eq!(lifecycle_context(&initial).unwrap(), (None, false));
        initial.desktop_connected.store(true, Ordering::Release);
        assert!(lifecycle_context(&initial).is_err());
        assert!(initial.history.lock().unwrap().is_none());
    }
}

#[cfg(test)]
mod before_poll_tests {
    use super::*;
    #[test]
    fn t11_initial_selection_before_heartbeat_fences_lifecycle_until_seed() {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"a".repeat(64), true, true, || Ok(()))
            .unwrap();
        pause_command(
            &manager,
            "set_agent_notification_context",
            &serde_json::json!({"selected":null}),
        )
        .unwrap();
        assert!(!manager
            .desktop_connected
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(lifecycle_context(&manager).is_err());
        pause_command(
            &manager,
            "initialize_notification_pause",
            &serde_json::json!({"legacy_paused":true,"expected_owner_instance":"a".repeat(64)}),
        )
        .unwrap();
        assert_eq!(lifecycle_context(&manager).unwrap(), (None, true));
        assert!(manager.history.lock().unwrap().is_none());
    }
    #[test]
    fn t11_owner_stop_reuses_actual_empty_manager_cleanup() {
        let manager = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        let exited = std::cell::Cell::new(false);
        owner_stop(&manager, || manager.shutdown(), || exited.set(true)).unwrap();
        assert!(manager
            .shutdown_complete
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(exited.get());
    }
}
