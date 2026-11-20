// Author: Jeff.Liu. Project policy affects native presentation, never Inbox read state.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path},
};
const ERROR: &str = "Project notification settings are unavailable. Reload before changing them.";
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Policy {
    #[default]
    All,
    Important,
    Muted,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    version: u32,
    revision: u64,
    projects: BTreeMap<String, Policy>,
}
fn project_key(path: &str) -> Result<String, String> {
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| c == Component::ParentDir)
    {
        return Err(ERROR.into());
    }
    Ok(Path::new(path)
        .components()
        .collect::<std::path::PathBuf>()
        .to_string_lossy()
        .into_owned())
}
fn load(history: &crate::history::HistoryStore) -> Result<Settings, String> {
    let path = history.root.join("project-notifications.json");
    if matches!(std::fs::symlink_metadata(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound) {
        return Ok(Settings {
            version: 1,
            ..Default::default()
        });
    }
    let file = crate::background::private_file(&path, false).map_err(|_| ERROR)?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() > 1024 * 1024 {
        return Err(ERROR.into());
    }
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if settings.version != 1
        || settings.projects.len() > 1024
        || settings
            .projects
            .keys()
            .any(|key| project_key(key).as_ref() != Ok(key))
    {
        return Err(ERROR.into());
    }
    Ok(settings)
}
pub(super) fn allows(
    history: &crate::history::HistoryStore,
    project: &str,
    kind: &str,
) -> Result<bool, String> {
    let settings = load(history)?;
    let Ok(key) = project_key(project) else {
        return Ok(true);
    };
    Ok(
        match settings.projects.get(&key).copied().unwrap_or_default() {
            Policy::All => true,
            Policy::Important => matches!(kind, "needs_permission" | "failed"),
            Policy::Muted => false,
        },
    )
}
pub(super) fn handle(
    history: &crate::history::HistoryStore,
    request: &Value,
) -> Result<Value, String> {
    let object = request.as_object().ok_or(ERROR)?;
    let action = request["action"].as_str().ok_or(ERROR)?;
    let keys = if action == "get" {
        vec!["action", "project"]
    } else if action == "set" {
        vec!["action", "project", "policy", "expected_revision"]
    } else {
        return Err(ERROR.into());
    };
    if object.len() != keys.len() || object.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(ERROR.into());
    }
    let key = project_key(request["project"].as_str().ok_or(ERROR)?)?;
    // Share the final delivery gate so a successful mute applies to the next notification.
    let _gate = crate::agent_events::NATIVE_DELIVERY
        .lock()
        .map_err(|_| ERROR)?;
    let mut settings = load(history)?;
    if action == "set" {
        let policy: Policy =
            serde_json::from_value(request["policy"].clone()).map_err(|_| ERROR)?;
        if request["expected_revision"].as_u64() != Some(settings.revision) {
            return Err(ERROR.into());
        }
        if policy == Policy::All {
            settings.projects.remove(&key);
        } else {
            settings.projects.insert(key.clone(), policy);
        }
        if settings.projects.len() > 1024 {
            return Err(ERROR.into());
        }
        settings.revision = settings.revision.checked_add(1).ok_or(ERROR)?;
        let bytes = serde_json::to_vec(&settings).map_err(|_| ERROR)?;
        if bytes.len() > 1024 * 1024 {
            return Err(ERROR.into());
        }
        crate::history::archive_atomic(&history.root.join("project-notifications.json"), &bytes)?;
    }
    Ok(
        json!({"project":key,"policy":settings.projects.get(&key).copied().unwrap_or_default(),"revision":settings.revision}),
    )
}
#[tauri::command]
pub(super) fn project_notification_policy(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::SessionManager>,
    request: Value,
) -> Result<Value, String> {
    if let Some(client) = manager.background_client.lock().map_err(|_| ERROR)?.clone() {
        return client.call("project_notification_policy", json!({"request":request}));
    }
    handle(manager.history(&app)?.as_ref(), &request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (std::path::PathBuf, crate::history::HistoryStore) {
        let root =
            std::env::temp_dir().join(format!("yam-project-notify-{}", crate::next_session_id()));
        let h = crate::history::HistoryStore::open(root.clone()).unwrap();
        (root, h)
    }
    #[test]
    fn policy_is_persistent_project_scoped_and_revision_guarded() {
        let (root, h) = fixture();
        assert!(allows(&h, "/one", "response_finished").unwrap());
        let saved = handle(
            &h,
            &json!({"action":"set","project":"/one/","policy":"important","expected_revision":0}),
        )
        .unwrap();
        assert_eq!(saved["policy"], "important");
        assert!(allows(&h, "/one", "needs_permission").unwrap());
        assert!(allows(&h, "/one", "failed").unwrap());
        assert!(!allows(&h, "/one", "response_finished").unwrap());
        assert!(allows(&h, "/one-child", "response_finished").unwrap());
        assert!(allows(&h, "/other", "response_finished").unwrap());
        assert!(allows(&h, "legacy-relative", "failed").unwrap());
        assert!(handle(
            &h,
            &json!({"action":"set","project":"/one","policy":"muted","expected_revision":0})
        )
        .is_err());
        drop(h);
        let h = crate::history::HistoryStore::open(root.clone()).unwrap();
        assert!(!allows(&h, "/one", "response_finished").unwrap());
        let saved = handle(
            &h,
            &json!({"action":"set","project":"/one","policy":"muted","expected_revision":1}),
        )
        .unwrap();
        for kind in [
            "needs_permission",
            "failed",
            "response_finished",
            "interrupted",
        ] {
            assert!(!allows(&h, "/one", kind).unwrap());
        }
        assert_eq!(saved["revision"], 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_settings_and_paths_do_not_silently_mute_projects() {
        let (root, h) = fixture();
        for request in [
            json!({}),
            json!({"action":"set","project":"relative","policy":"muted","expected_revision":0}),
            json!({"action":"set","project":"/one","policy":"unknown","expected_revision":0}),
            json!({"action":"get","project":"/one","unknown":true}),
        ] {
            assert!(handle(&h, &request).is_err());
        }
        assert!(allows(&h, "/one", "failed").unwrap());
        let path = root.join("project-notifications.json");
        std::fs::write(&path, b"{invalid").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(allows(&h, "/one", "failed").is_err());
        assert!(handle(&h, &json!({"action":"get","project":"/one"})).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{invalid");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn muted_delivery_preserves_inbox_and_other_projects_and_global_pause() {
        use crate::agent_events::{AgentEvent, DeliveryQueue, NativeSource};
        let (root, h) = fixture();
        for (id, cwd) in [("one", "/one"), ("two", "/two")] {
            h.start(&crate::SessionSummary {
                session_id: id.into(),
                cwd: cwd.into(),
                status: "running".into(),
                command: None,
                launch: None,
                ssh: None,
            })
            .unwrap();
            h.configure_agent(id, &format!("generation-{id}")).unwrap();
            for kind in ["SessionStart", "UserPromptSubmit", "TurnComplete"] {
                h.ingest_agent(
                    id,
                    &format!("generation-{id}"),
                    &AgentEvent {
                        kind: kind.into(),
                        agent_session_id: format!("native-{id}"),
                        turn_id: (kind != "SessionStart").then(|| "turn".into()),
                        source: None,
                        permission_key: None,
                    },
                )
                .unwrap();
            }
        }
        handle(
            &h,
            &json!({"action":"set","project":"/one","policy":"muted","expected_revision":0}),
        )
        .unwrap();
        let before = h.get("one").unwrap().agent.inbox.clone();
        let mut queue = DeliveryQueue::default();
        let mut sent = Vec::new();
        queue
            .tick(&h, 0, None, true, |_, _| {
                panic!("Global pause must prevent every delivery")
            })
            .unwrap();
        queue
            .tick(&h, 1, None, false, |id, receipt| {
                h.native_delivery(id, NativeSource::Round(receipt), |_| {
                    sent.push(id.to_owned());
                    Ok(())
                })
            })
            .unwrap();
        assert_eq!(sent, vec!["two"]);
        let after = h.get("one").unwrap().agent.inbox;
        assert_eq!(after.len(), before.len());
        assert_eq!(after[0].read, before[0].read);
        assert_eq!(after[0].delivery, "suppressed");
        h.update("one", "failed", None, None, None).unwrap();
        assert!(!h
            .native_delivery("one", NativeSource::Lifecycle("failed"), |_| panic!(
                "Muted lifecycle sent"
            ))
            .unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
