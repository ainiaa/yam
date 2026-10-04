// Author: Jeff.Liu
// Only fixed labels and numbers cross the diagnostics boundary; source text is never serialized.
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
const MAX_BYTES: usize = 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_RECEIPTS: usize = 16384;
const SCAN_TIME: Duration = Duration::from_millis(250);

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Health {
    Available,
    #[default]
    Unavailable,
    Unknown,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Parser {
    Present,
    #[default]
    Unavailable,
    Unknown,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    StateBusy,
    OwnerUnavailable,
    InvalidReport,
    StorageUnavailable,
    ScanLimit,
    SkippedEntry,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sessions {
    total: u64,
    scanned: u64,
    starting: u64,
    running: u64,
    succeeded: u64,
    failed: u64,
    stopped: u64,
    needs_attention: u64,
    unknown: u64,
    notification_pending: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Integrations {
    connected: u64,
    connecting: u64,
    unavailable: u64,
    unknown: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipts {
    scanned: u64,
    unread: u64,
    pending: u64,
    accepted: u64,
    suppressed: u64,
    failed: u64,
    unknown: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Errors {
    session_unknown: u64,
    notification: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Storage {
    status: Health,
    metadata_bytes: u64,
    backup_bytes: u64,
    log_bytes: u64,
    scene_bytes: u64,
    other_bytes: u64,
    scanned_entries: u64,
    partial: bool,
    error: Option<ErrorCode>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnerReport {
    connection: Health,
    history: Health,
    parser: Parser,
    sessions: Sessions,
    integrations: Integrations,
    receipts: Receipts,
    errors: Errors,
    counts_partial: bool,
    storage: Storage,
    error: Option<ErrorCode>,
}

pub(super) fn collect_owner(manager: &super::SessionManager) -> OwnerReport {
    let deadline = Instant::now() + SCAN_TIME;
    let mut result = OwnerReport {
        connection: Health::Available,
        ..Default::default()
    };
    result.parser = match manager.terminal_runtime.try_lock() {
        Ok(runtime) if runtime.is_some() => Parser::Present,
        Ok(_) => Parser::Unavailable,
        Err(_) => Parser::Unknown,
    };
    // Do not initialize/recover history, probe the parser, or change task/input/notification state.
    let history = match manager.history.try_lock() {
        Ok(history) => history.as_ref().cloned(),
        Err(_) => {
            result.error = Some(ErrorCode::StateBusy);
            None
        }
    };
    let Some(history) = history else {
        return result;
    };
    match history.records.try_lock() {
        Ok(records) => {
            if history
                .archive_pending
                .load(std::sync::atomic::Ordering::Acquire)
            {
                result.counts_partial = true;
                result.error = Some(ErrorCode::StateBusy);
                return result;
            }
            result.history = Health::Available;
            result.sessions.total = records.len() as u64;
            for record in records.iter().take(MAX_RECORDS) {
                if Instant::now() >= deadline {
                    result.counts_partial = true;
                    break;
                }
                result.sessions.scanned += 1;
                *match record.status.as_str() {
                    "starting" => &mut result.sessions.starting,
                    "running" => &mut result.sessions.running,
                    "succeeded" => &mut result.sessions.succeeded,
                    "failed" => &mut result.sessions.failed,
                    "stopped" => &mut result.sessions.stopped,
                    "needs_attention" => &mut result.sessions.needs_attention,
                    _ => &mut result.sessions.unknown,
                } += 1;
                result.sessions.notification_pending += u64::from(record.notification_pending);
                result.errors.session_unknown += u64::from(record.reason.is_some());
                *match record.agent.integration.as_str() {
                    "connected" => &mut result.integrations.connected,
                    "connecting" => &mut result.integrations.connecting,
                    "unavailable" => &mut result.integrations.unavailable,
                    _ => &mut result.integrations.unknown,
                } += 1;
                for receipt in &record.agent.inbox {
                    if result.receipts.scanned >= MAX_RECEIPTS as u64 || Instant::now() >= deadline
                    {
                        result.counts_partial = true;
                        break;
                    }
                    result.receipts.scanned += 1;
                    result.receipts.unread += u64::from(!receipt.read);
                    result.errors.notification += u64::from(receipt.error.is_some());
                    *match receipt.delivery.as_str() {
                        "pending" => &mut result.receipts.pending,
                        "accepted" => &mut result.receipts.accepted,
                        "suppressed" => &mut result.receipts.suppressed,
                        "failed" => &mut result.receipts.failed,
                        _ => &mut result.receipts.unknown,
                    } += 1;
                }
            }
            result.counts_partial |= result.sessions.scanned < result.sessions.total;
        }
        Err(_) => {
            result.error = Some(ErrorCode::StateBusy);
        }
    }
    result.storage = scan_storage(&history.root, MAX_RECORDS, deadline);
    result
}

fn scan_storage(root: &Path, limit: usize, deadline: Instant) -> Storage {
    let mut result = Storage {
        partial: true,
        error: Some(ErrorCode::StorageUnavailable),
        ..Default::default()
    };
    // Never descend into directories or follow a symlink/reparse point, even for the scan root.
    let Ok(metadata) = std::fs::symlink_metadata(root) else {
        return result;
    };
    if !metadata.is_dir() || linked(&metadata) {
        return result;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return result;
    };
    result.status = Health::Available;
    result.partial = false;
    result.error = None;
    // ponytail: cooperative 250 ms / 4096-entry top-level scan; totals are partial when bounded.
    for entry in entries {
        if result.scanned_entries >= limit as u64 || Instant::now() >= deadline {
            result.partial = true;
            result.error = Some(ErrorCode::ScanLimit);
            break;
        }
        result.scanned_entries += 1;
        let metadata = entry
            .as_ref()
            .ok()
            .and_then(|entry| std::fs::symlink_metadata(entry.path()).ok());
        let Some(metadata) = metadata.filter(|m| m.is_file() && !linked(m)) else {
            result.partial = true;
            result.error = Some(ErrorCode::SkippedEntry);
            continue;
        };
        let entry = entry.expect("entry with metadata");
        let name = entry.file_name();
        let bytes = match name.to_str() {
            Some("sessions.json") => &mut result.metadata_bytes,
            Some("sessions.json.bak" | "sessions.before-agent-events.json") => {
                &mut result.backup_bytes
            }
            Some(name) if name.ends_with(".frame.json") => &mut result.scene_bytes,
            Some(name) if name.ends_with(".log") => &mut result.log_bytes,
            _ => &mut result.other_bytes,
        };
        *bytes = bytes.saturating_add(metadata.len());
    }
    result
}
fn linked(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

pub(super) fn report(manager: &super::SessionManager) -> Result<Vec<u8>, &'static str> {
    let client = manager
        .background_client
        .try_lock()
        .map(|client| client.clone());
    let owner = match client {
        Ok(Some(client)) => match client.call("diagnostics_report", serde_json::json!({})) {
            Ok(value) => {
                serde_json::from_value::<OwnerReport>(value).unwrap_or_else(|_| OwnerReport {
                    error: Some(ErrorCode::InvalidReport),
                    ..Default::default()
                })
            }
            Err(_) => OwnerReport {
                error: Some(ErrorCode::OwnerUnavailable),
                ..Default::default()
            },
        },
        Ok(None) if manager.background_owner => collect_owner(manager),
        Ok(None) => OwnerReport {
            error: Some(ErrorCode::OwnerUnavailable),
            ..Default::default()
        },
        Err(_) => OwnerReport {
            error: Some(ErrorCode::StateBusy),
            ..Default::default()
        },
    };
    // Build/static strings are allowed; every owner field is an enum, number, or fixed structure.
    bounded_json(&serde_json::json!({
        "schema_version":1,
        "app":{"version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"architecture":std::env::consts::ARCH},
        "protocols":{"background":super::background::PROTOCOL_VERSION,"agent_bridge":1,"parser":1,"terminal":"6.0.0","serialize":"0.14.0"},
        "parser_health_probed":false,
        "owner":owner,
    }))
}
fn bounded_json(value: &impl Serialize) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "encode_failed")?;
    if bytes.len() > MAX_BYTES {
        return Err("size_limit");
    }
    Ok(bytes)
}

pub(super) fn write_selected(
    destination: Option<&Path>,
    bytes: &[u8],
) -> Result<bool, &'static str> {
    let Some(target) = destination else {
        return Ok(false);
    };
    if bytes.len() > MAX_BYTES {
        return Err("size_limit");
    }
    let parent = target
        .parent()
        .filter(|_| target.is_absolute() && target.file_name().is_some())
        .ok_or("invalid_destination")?;
    let temporary = parent.join(format!(".yam-diagnostics-{}.tmp", super::next_session_id()));
    // Reuse private create_new/no-follow checks. Publication preserves every existing target.
    let mut file =
        super::background::private_file(&temporary, true).map_err(|_| "destination_unwritable")?;
    let result = (|| {
        #[cfg(windows)]
        super::background::protect_windows_path(&temporary)
            .map_err(|_| "destination_unwritable")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "write_failed")?;
        std::fs::hard_link(&temporary, target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "destination_exists"
            } else {
                "publish_failed"
            }
        })
    })();
    drop(file);
    let cleanup = std::fs::remove_file(&temporary);
    result?;
    cleanup.map_err(|_| "cleanup_failed")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "yam-diagnostics-{}",
            super::super::next_session_id()
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    fn manager(
        root: &Path,
        records: Vec<super::super::SessionRecord>,
    ) -> super::super::SessionManager {
        super::super::SessionManager {
            background_owner: true,
            history: Mutex::new(Some(Arc::new(super::super::HistoryStore {
                archive_pending: std::sync::atomic::AtomicBool::new(false),
                root: root.to_owned(),
                records: Mutex::new(records),
                revision: std::sync::atomic::AtomicU64::new(0),
                instance: super::super::next_session_id(),
            }))),
            ..Default::default()
        }
    }
    fn record(status: &str) -> super::super::SessionRecord {
        serde_json::from_value(serde_json::json!({
            "summary":{"session_id":"private-session-id","cwd":"/private/secret/project","command":"secret argv", "status":status,
                "launch":{"adapter":"codex","mode":"interactive","extra_args":"--secret=credential","prompt":"private prompt"}},
            "status":status,"exit_code":null,"reason":"secret /private/path bearer credential","started_at":1,"ended_at":null,
            "notification_pending":true,
            "agent":{"generation":"private-generation","agent_session_id":"private-native-id","turn_id":"private-turn","phase":"private phase", "background":"private background", "integration":"private integration", "revision":1,"turns":[],"seen":[],
                "inbox":[{"id":"private-receipt-id","revision":1,"turn_id":"private-turn","kind":"private kind","delivery":"private delivery","read":false,"error":"secret receipt error /private/path"}]}
        })).unwrap()
    }
    fn json(manager: &super::super::SessionManager) -> serde_json::Value {
        serde_json::from_slice(&report(manager).unwrap()).unwrap()
    }

    #[test]
    fn diagnostics_pending_archive_is_unavailable_without_recovering_or_counting_stale_records() {
        let root = root();
        let owner = manager(&root, vec![record("running")]);
        let history = owner.history.lock().unwrap().as_ref().unwrap().clone();
        history
            .archive_pending
            .store(true, std::sync::atomic::Ordering::Release);
        let value = json(&owner);
        assert_eq!(value["owner"]["history"], "unavailable");
        assert_eq!(value["owner"]["error"], "state_busy");
        assert_eq!(value["owner"]["counts_partial"], true);
        assert_eq!(value["owner"]["sessions"]["total"], 0);
        assert!(history
            .archive_pending
            .load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(history.records.lock().unwrap().len(), 1);
        assert!(!root.join("sessions.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_aggregates_allowlisted_counts_without_sensitive_strings_or_lifecycle_changes() {
        let root = root();
        let owner = manager(&root, vec![record("running"), record("secret status")]);
        let before = serde_json::to_vec(
            &*owner
                .history
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .records
                .lock()
                .unwrap(),
        )
        .unwrap();
        let bytes = report(&owner).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["owner"]["sessions"]["running"], 1);
        assert_eq!(value["owner"]["sessions"]["unknown"], 1);
        assert_eq!(value["owner"]["integrations"]["unknown"], 2);
        assert_eq!(value["owner"]["receipts"]["unknown"], 2);
        assert_eq!(value["owner"]["receipts"]["unread"], 2);
        assert_eq!(value["owner"]["errors"]["session_unknown"], 2);
        assert_eq!(value["owner"]["errors"]["notification"], 2);
        assert_eq!(value["owner"]["parser"], "unavailable");
        assert_eq!(value["protocols"]["terminal"], "6.0.0");
        assert!(bytes.len() <= 1024 * 1024);
        let text = String::from_utf8(bytes).unwrap();
        for sensitive in [
            "secret",
            "/private/",
            "private prompt",
            "private-native-id",
            "private-session-id",
            "private-receipt-id",
            "private-generation",
            "private delivery",
            "private integration",
        ] {
            assert!(!text.contains(sensitive), "leaked {sensitive}");
        }
        assert_eq!(
            before,
            serde_json::to_vec(
                &*owner
                    .history
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .records
                    .lock()
                    .unwrap()
            )
            .unwrap()
        );
        assert!(owner.sessions.lock().unwrap().is_empty());
        assert!(!owner
            .shutting_down
            .load(std::sync::atomic::Ordering::Acquire));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_zero_records_busy_or_missing_state_are_truthful_and_nonblocking() {
        let root = root();
        let owner = manager(&root, vec![]);
        assert_eq!(json(&owner)["owner"]["sessions"]["total"], 0);
        let history = owner.history.lock().unwrap().as_ref().unwrap().clone();
        let _busy = history.records.lock().unwrap();
        let started = Instant::now();
        assert_eq!(json(&owner)["owner"]["history"], "unavailable");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            json(&super::super::SessionManager::default())["owner"]["connection"],
            "unavailable"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_count_budgets_are_partial_and_json_size_is_enforced_before_writing() {
        let root = root();
        let owner = manager(&root, (0..4097).map(|_| record("running")).collect());
        let value = json(&owner);
        assert_eq!(value["owner"]["sessions"]["total"], 4097);
        assert_eq!(value["owner"]["sessions"]["running"], 4096);
        assert_eq!(value["owner"]["counts_partial"], true);
        assert_eq!(
            bounded_json(&"x".repeat(1024 * 1024)).unwrap_err(),
            "size_limit"
        );
        let target = root.join("oversize.json");
        assert_eq!(
            write_selected(Some(&target), &vec![b'x'; 1024 * 1024 + 1]).unwrap_err(),
            "size_limit"
        );
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_receipt_budget_and_exact_file_size_are_bounded() {
        let root = root();
        let mut entry = record("running");
        entry.agent.inbox = vec![entry.agent.inbox[0].clone(); MAX_RECEIPTS + 1];
        let owner = manager(&root, vec![entry]);
        let value = json(&owner);
        assert_eq!(value["owner"]["receipts"]["scanned"], MAX_RECEIPTS);
        assert_eq!(value["owner"]["counts_partial"], true);
        let target = root.join("limit.json");
        let bytes = vec![b' '; MAX_BYTES];
        assert!(write_selected(Some(&target), &bytes).unwrap());
        assert_eq!(fs::metadata(&target).unwrap().len(), MAX_BYTES as u64);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_faulty_or_disconnected_owner_does_not_leak_errors_or_create_state() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for result in [
            serde_json::json!({"Err":"secret /private/path prompt"}),
            serde_json::json!({"Ok":{"connection":"secret","path":"/private/path"}}),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap().to_string();
            let client = Arc::new(
                super::super::background::Client::new(super::super::background::Descriptor {
                    version: super::super::background::PROTOCOL_VERSION,
                    address,
                    instance: "b".repeat(64),
                    token: "a".repeat(64),
                })
                .unwrap(),
            );
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut prefix = [0; 4];
                stream.read_exact(&mut prefix).unwrap();
                let mut bytes = vec![0; u32::from_be_bytes(prefix) as usize];
                stream.read_exact(&mut bytes).unwrap();
                let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["command"], "diagnostics_report");
                assert_eq!(request["args"], serde_json::json!({}));
                let reply = serde_json::to_vec(&serde_json::json!({"version":super::super::background::PROTOCOL_VERSION,"instance":request["instance"],"client":request["client"],"id":request["id"],"result":result})).unwrap();
                stream
                    .write_all(&(reply.len() as u32).to_be_bytes())
                    .unwrap();
                stream.write_all(&reply).unwrap();
            });
            let owner = super::super::SessionManager {
                background_client: Mutex::new(Some(client.clone())),
                ..Default::default()
            };
            let bytes = report(&owner).unwrap();
            server.join().unwrap();
            let text = String::from_utf8(bytes).unwrap();
            assert!(!text.contains("secret"));
            assert!(!text.contains("/private/path"));
            assert!(text.contains("owner_unavailable") || text.contains("invalid_report"));
            // A second read uses the same now-disconnected owner, with no discovery or replacement.
            assert_eq!(json(&owner)["owner"]["error"], "owner_unavailable");
            assert!(Arc::ptr_eq(
                owner.background_client.lock().unwrap().as_ref().unwrap(),
                &client
            ));
            assert!(owner.history.lock().unwrap().is_none());
            assert!(owner.sessions.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn diagnostics_save_cancel_existing_missing_directory_and_private_file() {
        let root = root();
        assert!(!write_selected(None, b"{}").unwrap());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let target = root.join("diagnostics.json");
        assert!(write_selected(Some(&target), b"{}").unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"{}");
        assert_eq!(
            write_selected(Some(&target), b"new").unwrap_err(),
            "destination_exists"
        );
        assert_eq!(fs::read(&target).unwrap(), b"{}");
        assert_eq!(
            write_selected(Some(&root.join("missing/file.json")), b"{}").unwrap_err(),
            "destination_unwritable"
        );
        assert_eq!(
            write_selected(Some(Path::new("relative.json")), b"{}").unwrap_err(),
            "invalid_destination"
        );
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            1,
            "temporary files must be cleaned"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn diagnostics_storage_counts_top_level_bytes_with_entry_deadline_and_missing_limits() {
        let root = root();
        fs::write(root.join("sessions.json"), b"123").unwrap();
        fs::write(root.join("sessions.json.bak"), b"12").unwrap();
        fs::write(root.join("private-session.log"), b"1234").unwrap();
        fs::write(root.join("private-session.frame.json"), b"12345").unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let value = serde_json::to_value(scan_storage(&root, 4096, deadline)).unwrap();
        assert_eq!(value["metadata_bytes"], 3);
        assert_eq!(value["backup_bytes"], 2);
        assert_eq!(value["log_bytes"], 4);
        assert_eq!(value["scene_bytes"], 5);
        assert_eq!(value["partial"], false);
        assert_eq!(
            serde_json::to_value(scan_storage(&root, 1, deadline)).unwrap()["partial"],
            true
        );
        assert_eq!(
            serde_json::to_value(scan_storage(&root, 4096, Instant::now())).unwrap()["partial"],
            true
        );
        assert_eq!(
            serde_json::to_value(scan_storage(&root.join("missing"), 4096, deadline)).unwrap()
                ["status"],
            "unavailable"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn diagnostics_storage_and_export_never_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let outside = root();
        let root = root();
        fs::write(outside.join("private.log"), vec![b'x'; 100]).unwrap();
        symlink(outside.join("private.log"), root.join("link.log")).unwrap();
        symlink(&outside, root.join("linked-directory")).unwrap();
        let value = serde_json::to_value(scan_storage(
            &root,
            4096,
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
        assert_eq!(value["log_bytes"], 0);
        assert_eq!(value["partial"], true);
        assert_eq!(
            write_selected(Some(&root.join("link.log")), b"{}").unwrap_err(),
            "destination_exists"
        );
        assert_eq!(fs::read(outside.join("private.log")).unwrap().len(), 100);
        let value = serde_json::to_value(scan_storage(
            &root.join("linked-directory"),
            4096,
            Instant::now() + Duration::from_secs(1),
        ))
        .unwrap();
        assert_eq!(value["status"], "unavailable");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
