// Author: Jeff.Liu. Portable snapshots become new, inert history records.
use crate::{history::HistoryStore, SessionRecord, SessionSummary};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::Path,
};
const LIMIT: usize = 16 * 1024 * 1024;
const ERROR: &str =
    "Project backup is invalid, unavailable or exceeds its 16 MiB budget. Nothing was overwritten.";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    version: u32,
    project: String,
    created_at: u64,
    sessions: Vec<Entry>,
    layout: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    title: String,
    status: String,
    started_at: u64,
    ended_at: Option<u64>,
    log: Option<String>,
}
fn marker(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn fields(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && o.keys().all(|k| keys.contains(&k.as_str())))
}
fn layout_name(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|n| !n.is_empty() && n.len() <= 4 && n.bytes().all(|b| b.is_ascii_digit()))
}
fn check_layout(layout: &Value, ids: &BTreeSet<String>) -> bool {
    if layout.is_null() {
        return true;
    }
    fn node(
        v: &Value,
        depth: usize,
        ids: &BTreeSet<String>,
        members: &mut BTreeSet<String>,
        names: &mut BTreeSet<String>,
        leaves: &mut usize,
    ) -> bool {
        if depth > 16 {
            return false;
        }
        match v["kind"].as_str() {
            Some("pane") => {
                if !fields(v, &["kind", "paneId", "sessionId", "tabs"]) {
                    return false;
                }
                let Some(name) = v["paneId"].as_str().filter(|s| layout_name(s, "p-")) else {
                    return false;
                };
                if !names.insert(name.into()) {
                    return false;
                }
                *leaves += 1;
                let Some(tabs) = v["tabs"].as_array().filter(|t| t.len() <= 16) else {
                    return false;
                };
                if !(v["sessionId"].is_null() && tabs.is_empty()
                    || v["sessionId"]
                        .as_str()
                        .is_some_and(|id| tabs.iter().any(|t| t.as_str() == Some(id))))
                {
                    return false;
                }
                tabs.iter().all(|t| {
                    t.as_str()
                        .is_some_and(|id| ids.contains(id) && members.insert(id.into()))
                }) && members.len() <= 16
                    && *leaves <= 16
            }
            Some("split") => {
                if !fields(v, &["kind", "nodeId", "axis", "ratio", "first", "second"]) {
                    return false;
                }
                let Some(name) = v["nodeId"].as_str().filter(|s| layout_name(s, "n-")) else {
                    return false;
                };
                names.insert(name.into())
                    && matches!(v["axis"].as_str(), Some("horizontal" | "vertical"))
                    && v["ratio"].as_f64().is_some_and(|r| {
                        r.is_finite() && r.fract() == 0.0 && (20.0..=80.0).contains(&r)
                    })
                    && node(&v["first"], depth + 1, ids, members, names, leaves)
                    && node(&v["second"], depth + 1, ids, members, names, leaves)
            }
            _ => false,
        }
    }
    let mut count = 0;
    fields(layout, &["root", "focused"])
        && node(
            &layout["root"],
            1,
            ids,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
            &mut count,
        )
        && layout["focused"].as_u64().is_some_and(|i| i < count as u64)
}
fn validate(value: &Value) -> Result<Backup, String> {
    if serde_json::to_vec(value).map_err(|_| ERROR)?.len() > LIMIT {
        return Err(ERROR.into());
    }
    let b: Backup = serde_json::from_value(value.clone()).map_err(|_| ERROR)?;
    let mut ids = BTreeSet::new();
    if b.version != 1
        || !Path::new(&b.project).is_absolute()
        || b.project.len() > 4096
        || b.project.chars().any(char::is_control)
        || b.sessions.len() > 2000
        || !b.sessions.iter().all(|s| {
            marker(&s.id)
                && ids.insert(s.id.clone())
                && s.title.len() <= 800
                && !s.title.chars().any(char::is_control)
                && matches!(
                    s.status.as_str(),
                    "starting" | "running" | "succeeded" | "failed" | "stopped" | "needs_attention"
                )
                && s.log.as_ref().is_none_or(|s| s.len() <= 8 * 1024 * 1024)
        })
        || !check_layout(&b.layout, &ids)
    {
        return Err(ERROR.into());
    }
    Ok(b)
}
fn validate_restored_receipt(value: &Value) -> Result<(), String> {
    if !fields(value, &["project", "ids", "titles", "layout"]) {
        return Err(ERROR.into());
    }
    let project = value["project"].as_str().ok_or(ERROR)?;
    if !Path::new(project).is_absolute()
        || project.len() > 4096
        || project.chars().any(char::is_control)
    {
        return Err(ERROR.into());
    }
    let ids: BTreeMap<String, String> =
        serde_json::from_value(value["ids"].clone()).map_err(|_| ERROR)?;
    let titles: BTreeMap<String, String> =
        serde_json::from_value(value["titles"].clone()).map_err(|_| ERROR)?;
    let targets = ids.values().cloned().collect::<BTreeSet<_>>();
    if ids.len() > 2000
        || targets.len() != ids.len()
        || ids.keys().any(|id| !marker(id))
        || ids.values().any(|id| {
            id.len() > 64
                || crate::session_id_from_link(&format!("yam://session/{id}")).as_deref()
                    != Some(id)
        })
        || titles.keys().cloned().collect::<BTreeSet<_>>() != targets
        || titles
            .values()
            .any(|title| title.len() > 800 || title.chars().any(char::is_control))
        || !check_layout(&value["layout"], &targets)
    {
        return Err(ERROR.into());
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_backup(path: &Path) -> Result<(Value, String), String> {
    if !path.is_absolute() {
        return Err(ERROR.into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|_| ERROR)?;
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err(ERROR.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(ERROR.into());
        }
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() > LIMIT {
        return Err(ERROR.into());
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    validate(&value)?;
    Ok((value, digest(&bytes)))
}
fn create(
    history: &HistoryStore,
    manager: &crate::SessionManager,
    project: &str,
    logs: bool,
    layout: Value,
    titles: &BTreeMap<String, String>,
) -> Result<Value, String> {
    if !Path::new(project).is_absolute() {
        return Err(ERROR.into());
    }
    let revision = history.revision.load(std::sync::atomic::Ordering::Acquire);
    let mut offset = 0;
    let mut snapshot = None;
    let mut sessions = Vec::new();
    let mut bytes = 0usize;
    loop {
        let batch = history.log_source_batch(offset, &|| false)?;
        if snapshot.as_ref().is_some_and(|s| s != &batch.snapshot) {
            return Err("History changed during backup. Retry after it settles.".into());
        }
        snapshot = Some(batch.snapshot);
        for source in batch.sources {
            if Path::new(&source.cwd) != Path::new(project) {
                continue;
            }
            let record = history.get(&source.session_id)?;
            let log = if logs {
                let active = manager
                    .sessions
                    .lock()
                    .map_err(|_| ERROR)?
                    .get(&source.session_id)
                    .cloned();
                let log = active
                    .as_ref()
                    .map(|session| session.log.lock().map_err(|_| ERROR))
                    .transpose()?;
                if let Some(error) = log.as_ref().and_then(|log| log.error.as_ref()) {
                    return Err(error.clone());
                }
                let mut data = Vec::new();
                let file =
                    crate::background::private_file(&history.log_path(&source.session_id), false)?;
                file.take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut data)
                    .map_err(|_| ERROR)?;
                if data.len() > 8 * 1024 * 1024 {
                    return Err(ERROR.into());
                }
                bytes = bytes.saturating_add(data.len());
                if bytes > LIMIT {
                    return Err(ERROR.into());
                }
                Some(String::from_utf8_lossy(&data).into_owned())
            } else {
                None
            };
            sessions.push(Entry {
                id: source.session_id.clone(),
                title: titles
                    .get(&source.session_id)
                    .cloned()
                    .unwrap_or_else(|| "Restored history".into()),
                status: record.status,
                started_at: record.started_at,
                ended_at: record.ended_at,
                log,
            });
            if sessions.len() > 2000 {
                return Err(ERROR.into());
            }
        }
        if batch.end >= batch.total {
            break;
        }
        offset = batch.end;
    }
    if history.revision.load(std::sync::atomic::Ordering::Acquire) != revision {
        return Err("History changed during backup. Retry after it settles.".into());
    }
    let value = serde_json::to_value(Backup {
        version: 1,
        project: project.into(),
        created_at: crate::unix_timestamp(),
        sessions,
        layout,
    })
    .map_err(|_| ERROR)?;
    validate(&value)?;
    Ok(value)
}
fn remap(node: &mut Value, ids: &BTreeMap<String, String>) {
    if node["kind"] == "pane" {
        node["sessionId"] = node["sessionId"]
            .as_str()
            .and_then(|id| ids.get(id))
            .map_or(Value::Null, |id| json!(id));
        node["tabs"] = json!(node["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|id| ids.get(id.as_str().unwrap()))
            .collect::<Vec<_>>());
    } else {
        remap(&mut node["first"], ids);
        remap(&mut node["second"], ids);
    }
}
#[cfg(test)]
fn restore(history: &std::sync::Arc<HistoryStore>, input: &Value) -> Result<Value, String> {
    restore_key(history, input, &crate::next_session_id())
}
fn restore_key(
    history: &std::sync::Arc<HistoryStore>,
    input: &Value,
    key: &str,
) -> Result<Value, String> {
    let backup = validate(input)?;
    if !marker(key) || key.len() > 64 {
        return Err(ERROR.into());
    }
    let fingerprint = digest(&serde_json::to_vec(input).map_err(|_| ERROR)?);
    let reason = format!("Restored project snapshot {fingerprint}. No process was started.");
    let ids: BTreeMap<_, _> = backup
        .sessions
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (
                s.id.clone(),
                format!("s-{}-{i:x}", &digest(key.as_bytes())[..32]),
            )
        })
        .collect();
    let mut layout = backup.layout;
    if !layout.is_null() {
        remap(&mut layout["root"], &ids);
    }
    let titles: BTreeMap<_, _> = backup
        .sessions
        .iter()
        .map(|s| (ids[&s.id].clone(), s.title.clone()))
        .collect();
    let result = json!({"project":backup.project,"ids":ids,"layout":layout,"titles":titles});
    let mut records = history.lock_records()?;
    let mut updated = records.clone();
    let mut pending = Vec::new();
    for entry in &backup.sessions {
        let id = &ids[&entry.id];
        if let Ok(existing) = history.get_locked(&records, id) {
            if existing.reason.as_deref() != Some(&reason) {
                return Err("Restore identifier already belongs to another backup".into());
            }
            continue;
        }
        // Only fresh IDs are writable; rollback owns only their newly allocated logs.
        let log_path = history.log_path(id);
        let existed = log_path.exists();
        let mut log = crate::history::PendingSessionLog::open(history.clone(), id)?;
        let text = entry.log.as_deref().unwrap_or("");
        if existed {
            let mut bytes = Vec::new();
            crate::background::private_file(&log_path, false)?
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| ERROR)?;
            if bytes != text.as_bytes() {
                return Err(
                    "Restore log identity changed; preserve it and choose a new restore".into(),
                );
            }
        } else {
            log.file()
                .write_all(text.as_bytes())
                .and_then(|_| log.file().sync_all())
                .map_err(|_| "Restore log could not be saved")?;
        }
        pending.push(log);
        let status = if crate::is_terminal(&entry.status) {
            entry.status.clone()
        } else {
            "stopped".into()
        };
        updated.push(SessionRecord {
            conversation_id: None,
            summary: SessionSummary {
                ssh: None,
                session_id: id.clone(),
                cwd: backup.project.clone(),
                command: None,
                status: status.clone(),
                launch: None,
            },
            status,
            exit_code: None,
            reason: Some(reason.clone()),
            started_at: entry.started_at,
            ended_at: Some(entry.ended_at.unwrap_or(backup.created_at)),
            output_end_offset: text.len() as u64,
            notification_pending: false,
            agent: Default::default(),
        });
    }
    if updated.len() != records.len() {
        // A failed fsync may follow publication. Keep staged logs until history recovery decides ownership.
        for log in &mut pending {
            log.begin_commit();
        }
        history.save_locked(&updated)?;
        *records = updated;
        for log in pending {
            log.commit();
        }
    }
    let receipt = history
        .root
        .join(format!("project-backup-layout-{key}.json"));
    crate::history::archive_atomic(&receipt, &serde_json::to_vec(&result).map_err(|_| ERROR)?)
        .map_err(|_| {
            "History restored; layout receipt could not be saved. Retry the same restore."
        })?;
    Ok(result)
}
pub(super) fn handle(
    history: &std::sync::Arc<HistoryStore>,
    request: &Value,
    manager: &crate::SessionManager,
) -> Result<Value, String> {
    match request["action"].as_str() {
        Some("create") if fields(request, &["action", "project", "logs", "layout", "titles"]) => {
            create(
                history,
                manager,
                request["project"].as_str().ok_or(ERROR)?,
                request["logs"].as_bool().ok_or(ERROR)?,
                request["layout"].clone(),
                &serde_json::from_value(request["titles"].clone()).map_err(|_| ERROR)?,
            )
        }
        Some("preview") if fields(request, &["action", "path"]) => {
            let (value, fingerprint) =
                read_backup(Path::new(request["path"].as_str().ok_or(ERROR)?))?;
            let b = validate(&value)?;
            Ok(
                json!({"fingerprint":fingerprint,"project":b.project,"sessions":b.sessions.iter().map(|s|json!({"id":s.id,"title":s.title,"status":s.status,"has_log":s.log.is_some()})).collect::<Vec<_>>(),"layout":b.layout}),
            )
        }
        Some("restore") if fields(request, &["action", "path", "fingerprint", "key"]) => {
            let (value, fingerprint) =
                read_backup(Path::new(request["path"].as_str().ok_or(ERROR)?))?;
            if request["fingerprint"].as_str() != Some(&fingerprint) {
                return Err("Backup changed after preview. Select it again.".into());
            }
            restore_key(history, &value, request["key"].as_str().ok_or(ERROR)?)
        }
        Some("restored") if fields(request, &["action"]) => {
            let mut paths = std::fs::read_dir(&history.root)
                .map_err(|_| ERROR)?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                        n.starts_with("project-backup-layout-") && n.ends_with(".json")
                    })
                })
                .collect::<Vec<_>>();
            paths.sort();
            let mut values = Vec::new();
            let mut total = 2usize;
            for p in paths.into_iter().rev().take(32) {
                let file = crate::background::private_file(&p, false)?;
                let mut bytes = Vec::new();
                file.take(LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| ERROR)?;
                if bytes.len() > LIMIT {
                    return Err(ERROR.into());
                }
                let value = serde_json::from_slice::<Value>(&bytes).map_err(|_| ERROR)?;
                validate_restored_receipt(&value)?;
                if total.saturating_add(bytes.len() + 1) > LIMIT {
                    break;
                }
                total += bytes.len() + 1;
                values.push(value);
            }
            Ok(json!(values))
        }
        _ => Err(ERROR.into()),
    }
}
pub(super) fn encode(raw: &str) -> Result<Vec<u8>, String> {
    if raw.len() > LIMIT {
        return Err(ERROR.into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| ERROR)?;
    validate(&value)?;
    let bytes = serde_json::to_vec(&value).map_err(|_| ERROR)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (
        std::path::PathBuf,
        std::sync::Arc<crate::history::HistoryStore>,
    ) {
        let root = std::env::temp_dir().join(format!("yam-backup-{}", crate::next_session_id()));
        let store = crate::history::HistoryStore::open(root.clone()).unwrap();
        (root, std::sync::Arc::new(store))
    }
    fn backup() -> serde_json::Value {
        json!({"version":1,"project":"/project","created_at":100,"sessions":[{"id":"old","title":"Saved work","status":"running","started_at":90,"ended_at":null,"log":"hello\n"}],"layout":{"root":{"kind":"pane","paneId":"p-0","sessionId":"old","tabs":["old"]},"focused":0}})
    }
    #[test]
    fn restore_creates_inert_new_records_and_keeps_originals() {
        let (root, history) = fixture();
        let input = backup();
        let first = restore(&history, &input).unwrap();
        let second = restore(&history, &input).unwrap();
        let id = first["ids"]["old"].as_str().unwrap();
        assert_ne!(id, second["ids"]["old"].as_str().unwrap());
        let record = history.get(id).unwrap();
        assert_eq!(record.status, "stopped");
        assert!(record.summary.launch.is_none());
        assert!(record.summary.command.is_none());
        assert!(record.summary.ssh.is_none());
        assert!(record.agent.agent_session_id.is_none());
        assert!(!record.notification_pending);
        assert_eq!(
            std::fs::read_to_string(history.log_path(id)).unwrap(),
            "hello\n"
        );
        assert_eq!(history.lock_records().unwrap().len(), 2);
        assert_eq!(first["layout"]["root"]["sessionId"], id);
        assert!(crate::history::HistoryStore::open(root.clone())
            .unwrap()
            .get(id)
            .is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn repeated_restore_key_reuses_records_and_logs() {
        let (root, history) = fixture();
        let a = restore_key(&history, &backup(), "retry-key").unwrap();
        let b = restore_key(&history, &backup(), "retry-key").unwrap();
        assert_eq!(a, b);
        assert_eq!(history.lock_records().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(history.log_path(a["ids"]["old"].as_str().unwrap())).unwrap(),
            "hello\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retry_repairs_an_incomplete_layout_receipt_without_duplicate_history() {
        let (root, history) = fixture();
        let result = restore_key(&history, &backup(), "receipt-retry").unwrap();
        let path = root.join("project-backup-layout-receipt-retry.json");
        std::fs::write(&path, b"{incomplete").unwrap();
        let retry = restore_key(&history, &backup(), "receipt-retry").unwrap();
        assert_eq!(retry, result);
        let rows = handle(&history, &json!({"action":"restored"}), &Default::default()).unwrap();
        assert_eq!(rows.as_array().unwrap(), &vec![result]);
        assert_eq!(history.lock_records().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn maximum_count_multibyte_titles_keep_restored_receipts_readable() {
        let (root, history) = fixture();
        let title = "🦀".repeat(200);
        let rows=(0..2000).map(|i|json!({"id":format!("old-{i}"),"title":title,"status":"stopped","started_at":1,"ended_at":1,"log":null})).collect::<Vec<_>>();
        let backup =
            json!({"version":1,"project":"/project","created_at":1,"sessions":rows,"layout":null});
        let result = restore_key(&history, &backup, "large-titles").unwrap();
        let rows = handle(&history, &json!({"action":"restored"}), &Default::default()).unwrap();
        assert_eq!(rows[0], result);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restored_list_rejects_wrong_shape_without_changing_the_file() {
        let (root, history) = fixture();
        let path = root.join("project-backup-layout-malformed.json");
        let mut file = crate::background::private_file(&path, true).unwrap();
        file.write_all(b"null").unwrap();
        assert!(handle(&history, &json!({"action":"restored"}), &Default::default()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"null");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restored_list_bounds_the_combined_payload_of_large_valid_receipts() {
        let (root, history) = fixture();
        for group in 0..8 {
            let ids = (0..2000)
                .map(|i| (format!("source-{i}"), format!("s-{:x}-{i:x}", group + 1)))
                .collect::<BTreeMap<_, _>>();
            let titles = ids
                .values()
                .map(|id| (id.clone(), "\\".repeat(800)))
                .collect::<BTreeMap<_, _>>();
            let value = json!({"project":"/project","ids":ids,"titles":titles,"layout":null});
            let mut file = crate::background::private_file(
                &root.join(format!("project-backup-layout-large-{group}.json")),
                true,
            )
            .unwrap();
            file.write_all(&serde_json::to_vec(&value).unwrap())
                .unwrap();
        }
        let rows = handle(&history, &json!({"action":"restored"}), &Default::default()).unwrap();
        assert!(!rows.as_array().unwrap().is_empty());
        assert!(serde_json::to_vec(&rows).unwrap().len() <= LIMIT);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unrelated_global_titles_do_not_limit_a_small_project_backup() {
        let (root, history) = fixture();
        restore(&history, &backup()).unwrap();
        let titles = (0..2001)
            .map(|i| (format!("other-{i}"), "Unrelated".to_string()))
            .collect();
        let exported = create(
            &history,
            &Default::default(),
            "/project",
            false,
            serde_json::Value::Null,
            &titles,
        )
        .unwrap();
        assert_eq!(exported["sessions"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_backup_never_modifies_history() {
        let (root, history) = fixture();
        for field in ["credentials", "launch", "command"] {
            let mut input = backup();
            input["sessions"][0][field] = json!("secret");
            assert!(restore(&history, &input).is_err());
        }
        for input in [
            json!({}),
            json!({"version":2}),
            {
                let mut v = backup();
                v["sessions"][0]["id"] = json!("../escape");
                v
            },
            {
                let mut v = backup();
                v["layout"]["root"]["sessionId"] = json!("missing");
                v
            },
            {
                let mut v = backup();
                let row = v["sessions"][0].clone();
                v["sessions"].as_array_mut().unwrap().push(row);
                v
            },
        ] {
            assert!(restore(&history, &input).is_err());
        }
        assert!(history.lock_records().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn export_includes_archived_runs_and_excludes_launch_and_credentials() {
        let (root, history) = fixture();
        let restored = restore(&history, &backup()).unwrap();
        let id = restored["ids"]["old"].as_str().unwrap();
        history
            .archive(id, &Default::default(), &Default::default())
            .unwrap();
        let result = create(
            &history,
            &Default::default(),
            "/project",
            true,
            json!(null),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(result["sessions"][0]["log"], "hello\n");
        assert!(result["sessions"][0].get("launch").is_none());
        assert!(result["sessions"][0].get("agent").is_none());
        assert!(create(
            &history,
            &Default::default(),
            "/other",
            false,
            json!(null),
            &Default::default()
        )
        .unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preview_detects_changed_file_and_oversize_without_restoring() {
        let (root, history) = fixture();
        let path = root.join("chosen.json");
        std::fs::write(&path, serde_json::to_vec(&backup()).unwrap()).unwrap();
        let preview = handle(
            &history,
            &json!({"action":"preview","path":path}),
            &Default::default(),
        )
        .unwrap();
        std::fs::write(&path, b"{}").unwrap();
        assert!(handle(&history,&json!({"action":"restore","path":path,"fingerprint":preview["fingerprint"],"key":"restore-key"}), &Default::default()).is_err());
        assert!(validate(
            &json!({"version":1,"project":"/project","created_at":0,"sessions":[],"layout":null})
        )
        .is_ok());
        assert!(read_backup(&root).is_err());
        assert!(validate(&{
            let mut v = backup();
            v["sessions"][0]["log"] = json!("x".repeat(8 * 1024 * 1024 + 1));
            v
        })
        .is_err());
        assert!(history.lock_records().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn preview_rejects_symlinks() {
        let (root, history) = fixture();
        let path = root.join("chosen.json");
        std::fs::write(&path, serde_json::to_vec(&backup()).unwrap()).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_backup(&link).is_err());
        assert!(history.lock_records().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
pub(super) fn project_backup(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::SessionManager>,
    request: Value,
) -> Result<Value, String> {
    if let Some(client) = manager.background_client.lock().map_err(|_| ERROR)?.clone() {
        return client.call("project_backup", json!({"request":request}));
    }
    handle(&manager.history(&app)?, &request, &manager)
}
#[tauri::command]
pub(super) async fn choose_project_backup(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("YAM project backup", &["json"])
            .blocking_pick_file()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|_| ERROR.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| ERROR.to_string())?
}
#[tauri::command]
pub(super) async fn export_project_backup(
    app: tauri::AppHandle,
    backup: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = encode(&backup)?;
        let Some(p) = app
            .dialog()
            .file()
            .set_file_name("yam-project-backup.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let p = p.into_path().map_err(|_| ERROR)?;
        crate::diagnostics::write_selected_with_limit(Some(&p), &bytes, LIMIT)
            .map_err(str::to_owned)
    })
    .await
    .map_err(|_| ERROR.to_string())?
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn exported_large_backup_is_readable_and_existing_file_is_preserved() {
        let root =
            std::env::temp_dir().join(format!("yam-backup-limit-{}", crate::next_session_id()));
        crate::background::private_root(&root).unwrap();
        let target = root.join("backup.json");
        let value = json!({"version":1,"project":"/p","created_at":1,"sessions":[{"id":"old","title":"Title","status":"succeeded","started_at":1,"ended_at":1,"log":"x".repeat(1024*1024+1)}],"layout":null});
        let bytes = encode(&value.to_string()).unwrap();
        assert!(
            crate::diagnostics::write_selected_with_limit(Some(&target), &bytes, LIMIT).unwrap()
        );
        assert_eq!(read_backup(&target).unwrap().0, value);
        assert!(
            crate::diagnostics::write_selected_with_limit(Some(&target), b"changed", LIMIT)
                .is_err()
        );
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(crate::diagnostics::write_selected_with_limit(None, &bytes, LIMIT).is_ok());
        assert!(crate::diagnostics::write_selected_with_limit(
            Some(&root.join("small")),
            &bytes,
            1
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn layout_names_and_ratios_must_match_normal_layout_contract() {
        let ids = BTreeSet::from(["old".into()]);
        for (name, ratio) in [("p-other", 50.0), ("p-1", 50.5)] {
            let layout = json!({"focused":0,"root":{"kind":"split","nodeId":"n-0","axis":"horizontal","ratio":ratio,"first":{"kind":"pane","paneId":name,"tabs":["old"],"sessionId":"old"},"second":{"kind":"pane","paneId":"p-2","tabs":[],"sessionId":null}}});
            assert!(!check_layout(&layout, &ids));
        }
    }
}
