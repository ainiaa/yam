use super::{
    agent_events, is_terminal, next_session_id, unix_timestamp, SessionRecord, SessionSummary,
    MAX_SESSION_HISTORY_BYTES,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static CAPACITY_GENERATION: AtomicU64 = AtomicU64::new(0);
static CAPACITY_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct HistoryStore {
    pub(crate) root: PathBuf,
    pub(crate) records: Mutex<Vec<SessionRecord>>,
    pub(crate) revision: AtomicU64,
    pub(crate) instance: String,
    pub(crate) archive_pending: AtomicBool,
}
pub(crate) fn bounded_history(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take(MAX_SESSION_HISTORY_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("Failed to read session history: {error}"))?;
    if bytes.len() as u64 > MAX_SESSION_HISTORY_BYTES {
        return Err("Session history exceeds its 32 MiB budget; preserve the file and archive history before retrying".into());
    }
    String::from_utf8(bytes).map_err(|_| "Session history has invalid encoding".into())
}

impl HistoryStore {
    pub(crate) fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create session data directory: {error}"))?;
        let records_path = root.join("sessions.json");
        let records = if records_path.exists() {
            let contents = bounded_history(&records_path)?;
            match serde_json::from_str::<Vec<SessionRecord>>(&contents) {
                Ok(records) => records,
                Err(error) => {
                    let backup = root.join("sessions.json.bak");
                    let backup_contents = bounded_history(&backup).map_err(|_| {
                        format!(
                            "Session history is corrupt ({error}). Original file preserved at {}",
                            records_path.display()
                        )
                    })?;
                    let records =
                        serde_json::from_str(&backup_contents).map_err(|backup_error| {
                            format!("Session history and backup are corrupt: {backup_error}")
                        })?;
                    fs::copy(
                        &records_path,
                        root.join(format!("sessions.corrupt-{}", next_session_id())),
                    )
                    .map_err(|error| format!("Failed to preserve corrupt history: {error}"))?;
                    fs::copy(&backup, &records_path).map_err(|error| {
                        format!("Failed to restore session history backup: {error}")
                    })?;
                    records
                }
            }
        } else {
            Vec::new()
        };
        if records_path.exists() {
            let original = bounded_history(&records_path)?;
            let json: serde_json::Value =
                serde_json::from_str(&original).map_err(|e| e.to_string())?;
            if json
                .as_array()
                .is_some_and(|records| records.iter().any(|record| record.get("agent").is_none()))
            {
                let backup = root.join("sessions.before-agent-events.json");
                if backup.exists() {
                    serde_json::from_str::<Vec<SessionRecord>>(&bounded_history(&backup)?).map_err(|_|"Pre-upgrade history backup is invalid; preserve it and repair before continuing")?;
                } else {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&backup)
                        .map_err(|e| format!("Cannot preserve pre-upgrade history: {e}"))?;
                    file.write_all(original.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|e| format!("Cannot flush pre-upgrade history: {e}"))?;
                }
            }
        }
        let store = Self {
            root,
            records: Mutex::new(records),
            revision: AtomicU64::new(0),
            instance: next_session_id(),
            archive_pending: AtomicBool::new(false),
        };
        store.recover_archive()?;
        Ok(store)
    }

    pub(crate) fn records_path(&self) -> PathBuf {
        self.root.join("sessions.json")
    }

    pub(crate) fn save_locked(&self, records: &[SessionRecord]) -> Result<(), String> {
        if self.archive_pending.load(Ordering::Acquire) {
            return Err("Archive transaction requires recovery; reopen history".into());
        }
        let temp_path = self.root.join("sessions.json.tmp");
        let data = serde_json::to_vec_pretty(records)
            .map_err(|error| format!("Failed to encode session history: {error}"))?;
        if data.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err(
                "Session history budget reached; unread agent receipts were preserved".into(),
            );
        }
        let mut file = File::create(&temp_path)
            .map_err(|error| format!("Failed to write session history: {error}"))?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to flush session history: {error}"))?;
        if self.records_path().exists() {
            let backup_temp = self.root.join("sessions.json.bak.tmp");
            fs::copy(self.records_path(), &backup_temp)
                .map_err(|error| format!("Failed to back up session history: {error}"))?;
            OpenOptions::new()
                .write(true)
                .open(&backup_temp)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Failed to flush history backup: {error}"))?;
            fs::rename(&backup_temp, self.root.join("sessions.json.bak"))
                .map_err(|error| format!("Failed to commit history backup: {error}"))?;
        }
        fs::rename(&temp_path, self.records_path())
            .map_err(|error| format!("Failed to commit session history: {error}"))?;
        #[cfg(unix)]
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Failed to flush history directory: {error}"))?;
        self.revision.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    pub(crate) fn start(&self, summary: &SessionSummary) -> Result<(), String> {
        let mut records = self.lock_records()?;
        let mut updated = records.clone();
        updated.retain(|record| record.summary.session_id != summary.session_id);
        updated.push(SessionRecord {
            summary: summary.clone(),
            status: summary.status.clone(),
            exit_code: None,
            reason: None,
            started_at: unix_timestamp(),
            ended_at: None,
            output_end_offset: 0,
            notification_pending: false,
            agent: agent_events::AgentState::default(),
        });
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    pub(crate) fn update(
        &self,
        session_id: &str,
        status: &str,
        exit_code: Option<u32>,
        reason: Option<String>,
        output_end_offset: Option<u64>,
    ) -> Result<(), String> {
        let mut records = self.lock_records()?;
        let mut updated = records.clone();
        let record = updated
            .iter_mut()
            .find(|record| record.summary.session_id == session_id)
            .ok_or_else(|| format!("Unknown session: {session_id}"))?;
        record.status = status.to_string();
        record.summary.status = status.to_string();
        record.exit_code = exit_code;
        record.reason = reason;
        if let Some(offset) = output_end_offset {
            record.output_end_offset = offset;
        }
        if is_terminal(status) {
            record.ended_at = Some(unix_timestamp());
            record.notification_pending = true;
        }
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    pub(crate) fn acknowledge_notification(
        &self,
        session_id: &str,
        expected_status: &str,
    ) -> Result<(), String> {
        let mut records = self.lock_records()?;
        let mut updated = records.clone();
        let record = updated
            .iter_mut()
            .find(|record| record.summary.session_id == session_id)
            .ok_or_else(|| "Unknown notification session".to_string())?;
        // Validate under the history lock: an old receipt must not consume a new state.
        if record.status != expected_status {
            return Ok(());
        }
        record.notification_pending = false;
        self.save_locked(&updated)?;
        *records = updated;
        Ok(())
    }

    pub(crate) fn list(&self) -> Result<Vec<SessionRecord>, String> {
        let records = self.lock_records()?;
        let mut result = records.clone();
        result.reverse();
        Ok(result)
    }

    pub(crate) fn recover_running(&self) -> Result<(), String> {
        let mut records = self.lock_records()?;
        let mut changed = false;
        let mut updated = records.clone();
        for record in updated.iter_mut() {
            if matches!(record.status.as_str(), "starting" | "running") {
                record.status = "needs_attention".to_string();
                record.summary.status = "needs_attention".to_string();
                record.reason =
                    Some("The background owner restarted; the previous terminal process cannot be reattached".to_string());
                record.ended_at = Some(unix_timestamp());
                record.notification_pending = true;
                changed = true;
            }
        }
        if changed {
            self.save_locked(&updated)?;
            *records = updated;
        }
        Ok(())
    }

    pub(crate) fn log_path(&self, session_id: &str) -> PathBuf {
        self.root.join(format!("{session_id}.log"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PageCursor {
    revision: String,
    offset: usize,
    context: String,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct PageRequest {
    pub page_size: Option<usize>,
    pub cursor: Option<PageCursor>,
    pub query: String,
    pub status: String,
    pub matched_session_ids: Vec<String>,
    pub matched_project_paths: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ItemSummary {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub adapter: Option<String>,
    pub mode: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ItemAgent {
    pub phase: String,
    pub integration: String,
    pub unread_count: usize,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct HistoryItem {
    pub summary: ItemSummary,
    pub status: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub agent: ItemAgent,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct HistoryPage<T> {
    pub revision: String,
    pub items: Vec<T>,
    pub next_cursor: Option<PageCursor>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Overview {
    pub total: usize,
    pub active: usize,
    pub unread_receipts: usize,
    pub failed_receipts: usize,
    pub attention_sessions: usize,
    pub metadata_bytes: Option<u64>,
    pub latest_deletion: Option<DeletionResult>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct InboxItem {
    pub session: HistoryItem,
    pub receipt: agent_events::AgentReceipt,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingKey {
    started_at: u64,
    session_id: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct PendingNotification {
    pub session_id: String,
    pub status: String,
    pub exit_code: Option<u32>,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct PendingPage {
    pub items: Vec<PendingNotification>,
    pub next_key: Option<PendingKey>,
}
fn unread(record: &SessionRecord) -> usize {
    record
        .agent
        .inbox
        .iter()
        .filter(|entry| !entry.read)
        .count()
}
fn attention(record: &SessionRecord) -> bool {
    unread(record) > 0 || record.status == "needs_attention"
}
fn title(record: &SessionRecord) -> Cow<'_, str> {
    record
        .summary
        .launch
        .as_ref()
        .and_then(|launch| launch.prompt.as_deref())
        .filter(|text| !text.is_empty())
        .or(record
            .summary
            .command
            .as_deref()
            .filter(|text| !text.is_empty()))
        .map(Cow::Borrowed)
        .unwrap_or_else(|| {
            record
                .summary
                .launch
                .as_ref()
                .map_or(Cow::Borrowed("Interactive shell"), |launch| {
                    Cow::Owned(format!("{} · {}", launch.adapter, launch.mode))
                })
        })
}

fn item(record: &SessionRecord) -> HistoryItem {
    let launch = record.summary.launch.as_ref();
    HistoryItem {
        summary: ItemSummary {
            session_id: record.summary.session_id.clone(),
            cwd: record.summary.cwd.clone(),
            title: title(record).chars().take(200).collect(),
            adapter: launch.map(|launch| launch.adapter.clone()),
            mode: launch.map(|launch| launch.mode.clone()),
        },
        status: record.status.clone(),
        started_at: record.started_at,
        ended_at: record.ended_at,
        agent: ItemAgent {
            phase: record.agent.phase.clone(),
            integration: record.agent.integration.clone(),
            unread_count: unread(record),
        },
    }
}

impl PageRequest {
    fn validate(&self) -> Result<(usize, String), String> {
        let size = self.page_size.unwrap_or(100);
        if !(1..=200).contains(&size)
            || self.query.chars().count() > 256
            || self.query.contains('\0')
            || ![
                "",
                "all",
                "active",
                "attention",
                "succeeded",
                "failed",
                "stopped",
            ]
            .contains(&self.status.as_str())
        {
            return Err(
                "Invalid history page request; use 1–200 items and at most 256 query characters"
                    .into(),
            );
        }
        let mut context = self.clone();
        context.cursor = None;
        let context =
            serde_json::to_string(&context).map_err(|_| "Invalid history page request")?;
        if context.len() > 1024 * 1024 {
            return Err("History search aliases exceed the 1 MiB request budget".into());
        }
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        context.hash(&mut hash);
        Ok((size, format!("{:016x}", hash.finish())))
    }
    fn matches(&self, record: &SessionRecord) -> bool {
        let status = match self.status.as_str() {
            "active" => matches!(record.status.as_str(), "starting" | "running"),
            "attention" => attention(record) || record.status == "failed",
            "" | "all" => true,
            status => record.status == status,
        };
        let query = self.query.trim().to_lowercase();
        status
            && (query.is_empty()
                || record.summary.session_id.to_lowercase().contains(&query)
                || record.summary.cwd.to_lowercase().contains(&query)
                || title(record).to_lowercase().contains(&query)
                || self
                    .matched_session_ids
                    .contains(&record.summary.session_id)
                || self.matched_project_paths.iter().any(|path| {
                    path.trim_end_matches(['/', '\\'])
                        == record.summary.cwd.trim_end_matches(['/', '\\'])
                }))
    }
    fn offset(&self, revision: &str, context: &str) -> Result<usize, String> {
        match &self.cursor {
            Some(cursor) if cursor.revision != revision || cursor.context != context => {
                Err("History cursor expired; reload history".into())
            }
            Some(cursor) => Ok(cursor.offset),
            None => Ok(0),
        }
    }
}
impl HistoryStore {
    pub(crate) fn get(&self, id: &str) -> Result<SessionRecord, String> {
        let records = self.lock_records()?;
        self.get_locked(&records, id)
    }
    pub(crate) fn page(&self, request: PageRequest) -> Result<HistoryPage<HistoryItem>, String> {
        let (size, context) = request.validate()?;
        let records = self.lock_records()?;
        let revision = format!(
            "{}:{}",
            self.instance,
            self.revision.load(Ordering::Acquire)
        );
        let offset = request.offset(&revision, &context)?;
        if offset > records.len() {
            return Err("Invalid history cursor offset".into());
        }
        let mut items = records
            .iter()
            .rev()
            .filter(|record| request.matches(record))
            .skip(offset)
            .take(size + 1)
            .map(item)
            .collect::<Vec<_>>();
        let next_cursor = (items.len() > size).then(|| PageCursor {
            revision: revision.clone(),
            offset: offset + size,
            context,
        });
        items.truncate(size);
        Ok(HistoryPage {
            revision,
            items,
            next_cursor,
        })
    }
    pub(crate) fn overview(&self) -> Result<Overview, String> {
        let records = self.lock_records()?;
        let mut result = Overview {
            total: records.len(),
            active: records
                .iter()
                .filter(|r| matches!(r.status.as_str(), "starting" | "running"))
                .count(),
            unread_receipts: records.iter().map(unread).sum(),
            failed_receipts: records
                .iter()
                .flat_map(|record| &record.agent.inbox)
                .filter(|receipt| receipt.delivery == "failed")
                .count(),
            attention_sessions: records.iter().filter(|r| attention(r)).count(),
            metadata_bytes: None,
            latest_deletion: self.latest_deletion_receipt()?,
        };
        drop(records);
        result.metadata_bytes = fs::symlink_metadata(self.records_path())
            .ok()
            .filter(|m| m.is_file() && !linked(m))
            .map(|m| m.len());
        Ok(result)
    }
    pub(crate) fn inbox(&self, request: PageRequest) -> Result<HistoryPage<InboxItem>, String> {
        let (size, context) = request.validate()?;
        let records = self.lock_records()?;
        let revision = format!(
            "{}:{}",
            self.instance,
            self.revision.load(Ordering::Acquire)
        );
        let offset = request.offset(&revision, &context)?;
        let mut items = records
            .iter()
            .rev()
            .flat_map(|record| {
                record
                    .agent
                    .inbox
                    .iter()
                    .filter(|entry| !entry.read)
                    .map(move |receipt| (record, receipt))
            })
            .skip(offset)
            .take(size + 1)
            .map(|(record, receipt)| InboxItem {
                session: item(record),
                receipt: receipt.clone(),
            })
            .collect::<Vec<_>>();
        let next_cursor = (items.len() > size).then(|| PageCursor {
            revision: revision.clone(),
            offset: offset + size,
            context,
        });
        items.truncate(size);
        Ok(HistoryPage {
            revision,
            items,
            next_cursor,
        })
    }
    pub(crate) fn next_attention(&self, current: Option<&str>) -> Result<Option<String>, String> {
        let records = self.lock_records()?;
        let priority = |record: &&SessionRecord| {
            if record
                .agent
                .inbox
                .iter()
                .any(|r| !r.read && r.kind == "needs_permission")
            {
                0
            } else if matches!(record.status.as_str(), "failed" | "needs_attention")
                || record
                    .agent
                    .inbox
                    .iter()
                    .any(|r| !r.read && matches!(r.kind.as_str(), "interrupted" | "failed"))
            {
                1
            } else {
                2
            }
        };
        let mut pending = records
            .iter()
            .rev()
            .filter(|r| attention(r))
            .collect::<Vec<_>>();
        pending.sort_by_key(priority);
        if pending.is_empty() {
            return Ok(None);
        }
        let index = current
            .and_then(|id| pending.iter().position(|r| r.summary.session_id == id))
            .map_or(0, |index| (index + 1) % pending.len());
        Ok(Some(pending[index].summary.session_id.clone()))
    }
    pub(crate) fn pending(
        &self,
        limit: usize,
        after: Option<PendingKey>,
    ) -> Result<PendingPage, String> {
        if !(1..=200).contains(&limit) {
            return Err("Invalid pending notification page size".into());
        }
        let records = self.lock_records()?;
        let key = |r: &SessionRecord| PendingKey {
            started_at: r.started_at,
            session_id: r.summary.session_id.clone(),
        };
        let mut pending = records
            .iter()
            .filter(|r| {
                r.notification_pending && after.as_ref().is_none_or(|after| key(r) > *after)
            })
            .collect::<Vec<_>>();
        pending.sort_by_key(|r| key(r));
        let next_key = (pending.len() > limit).then(|| key(pending[limit - 1]));
        let items = pending
            .into_iter()
            .take(limit)
            .map(|r| PendingNotification {
                session_id: r.summary.session_id.clone(),
                status: r.status.clone(),
                exit_code: r.exit_code,
                reason: r
                    .reason
                    .as_ref()
                    .map(|reason| reason.chars().take(200).collect()),
            })
            .collect();
        Ok(PendingPage { items, next_key })
    }
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Capacity {
    pub metadata_bytes: u64,
    pub log_bytes: u64,
    pub scene_bytes: u64,
    pub backup_bytes: u64,
    pub archive_bytes: u64,
    pub other_bytes: u64,
    pub scanned_entries: usize,
    pub complete: bool,
    pub issues: Vec<String>,
}
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
impl Capacity {
    fn issue(&mut self, code: &str) {
        self.complete = false;
        if self.issues.len() < 32 && !self.issues.iter().any(|issue| issue == code) {
            self.issues.push(code.into());
        }
    }
}
pub(crate) fn cancel_capacity() {
    CAPACITY_GENERATION.fetch_add(1, Ordering::AcqRel);
}
pub(crate) fn scan_capacity(root: &Path) -> Result<Capacity, String> {
    let generation = CAPACITY_GENERATION.load(Ordering::Acquire);
    let _guard = CAPACITY_LOCK
        .try_lock()
        .map_err(|_| "Capacity scan already in progress")?;
    scan_capacity_with(root, 10000, Instant::now() + Duration::from_secs(2), || {
        CAPACITY_GENERATION.load(Ordering::Acquire) != generation
    })
}
fn scan_capacity_with(
    root: &Path,
    limit: usize,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
) -> Result<Capacity, String> {
    let mut result = Capacity {
        complete: true,
        ..Default::default()
    };
    let mut stack = vec![(root.to_path_buf(), 0, false)];
    while let Some((directory, depth, archive)) = stack.pop() {
        if cancelled() {
            return Err("Capacity scan cancelled".into());
        }
        if Instant::now() >= deadline {
            result.issue("scan_limit");
            break;
        }
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(m) => m,
            Err(_) => {
                result.issue("storage_unavailable");
                continue;
            }
        };
        if linked(&metadata) || !metadata.is_dir() {
            result.issue("skipped_entry");
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                result.issue("storage_unavailable");
                continue;
            }
        };
        for entry in entries {
            if cancelled() {
                return Err("Capacity scan cancelled".into());
            }
            if result.scanned_entries >= limit || Instant::now() >= deadline {
                result.issue("scan_limit");
                return Ok(result);
            }
            result.scanned_entries += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.issue("storage_unavailable");
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    result.issue("storage_unavailable");
                    continue;
                }
            };
            if linked(&metadata) {
                result.issue("skipped_entry");
                continue;
            }
            let name = entry.file_name();
            let name = name.to_str().unwrap_or("");
            if metadata.is_dir() {
                if (archive || name == "archive") && depth < 4 {
                    stack.push((entry.path(), depth + 1, true));
                } else {
                    result.issue(if depth >= 4 {
                        "scan_limit"
                    } else {
                        "skipped_entry"
                    });
                }
                continue;
            }
            if !metadata.is_file() {
                result.issue("skipped_entry");
                continue;
            }
            let bytes = if archive {
                &mut result.archive_bytes
            } else if name == "sessions.json" {
                &mut result.metadata_bytes
            } else if name.ends_with(".frame.json") {
                &mut result.scene_bytes
            } else if name.ends_with(".log") {
                &mut result.log_bytes
            } else if name.starts_with("sessions.") {
                &mut result.backup_bytes
            } else {
                &mut result.other_bytes
            };
            *bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok(result)
}

pub(crate) struct LogSourceBatch {
    pub sources: Vec<super::session_logs::LogSource>,
    pub positions: Vec<usize>,
    pub end_offsets: Vec<u64>,
    pub end: usize,
    pub total: usize,
    pub snapshot: String,
}
#[cfg(test)]
thread_local! {static ARCHIVE_SHARD_READS: std::cell::Cell<usize> = const {std::cell::Cell::new(0)};}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveEntry {
    item: HistoryItem,
    output_end_offset: u64,
}
fn archive_entry(record: &SessionRecord) -> ArchiveEntry {
    ArchiveEntry {
        item: item(record),
        output_end_offset: record.output_end_offset,
    }
}
const ARCHIVE_PAGE_BYTES: u64 = 1024 * 1024;
const DELETE_BUDGET: u64 = 128 * 1024;
const DELETE_SCOPE: &str =
    "YAM archived records, logs and saved terminal scenes; native CLI history is retained";
const DELETE_EXPIRED: &str = "Deletion preview expired; preview again";
const DELETE_STORAGE: &str = "Deletion storage operation failed";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetentionPolicy {
    auto_archive_30_days: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileProof {
    device: u64,
    inode: u64,
    length: u64,
    modified: u64,
    links: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeleteRole {
    Shard,
    Log,
    Frame,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteFile {
    role: DeleteRole,
    proof: Option<FileProof>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteTarget {
    id: String,
    location: ArchiveLocation,
    files: Vec<DeleteFile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletePreview {
    version: u8,
    preview_id: String,
    instance: String,
    expires_at: u64,
    parent_directory: FileProof,
    root_directory: FileProof,
    archive_directory: FileProof,
    hot_revision: u64,
    archive_revision: u64,
    targets: Vec<DeleteTarget>,
    earliest_ended_at: Option<u64>,
    latest_ended_at: Option<u64>,
    bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteTransaction {
    kind: String,
    version: u8,
    preview: DeletePreview,
    root: ArchiveRoot,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeletionResult {
    pub preview_id: String,
    pub deleted_ids: Vec<String>,
    pub complete: bool,
    pub issues: Vec<String>,
}

fn proof(file: &File, role: Option<&DeleteRole>) -> Result<FileProof, String> {
    let m = file.metadata().map_err(|_| "Unsafe deletion file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.uid() != unsafe { libc::geteuid() }
            || (!m.is_dir()
                && (m.nlink() != 1
                    || m.mode()
                        & if matches!(role, Some(DeleteRole::Log)) {
                            0o022
                        } else {
                            0o077
                        }
                        != 0))
            || (m.is_dir() && m.mode() & 0o022 != 0)
        {
            return Err("Unsafe deletion file".into());
        }
        Ok(FileProof {
            device: m.dev(),
            inode: m.ino(),
            length: m.len(),
            modified: (m.mtime() as u64)
                .wrapping_mul(1_000_000_000)
                .wrapping_add(m.mtime_nsec() as u64),
            links: m.nlink(),
        })
    }
    #[cfg(windows)]
    {
        let _ = role;
        windows_file_proof(file, &m)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (m, role);
        Err("Unsafe deletion file".into())
    }
}
fn directory_proof(path: &Path) -> Result<FileProof, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "Unsafe deletion file")?;
    if linked(&m) || !m.is_dir() {
        return Err("Unsafe deletion file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000 | 0x02000000);
    }
    proof(
        &options.open(path).map_err(|_| "Unsafe deletion file")?,
        None,
    )
}
#[cfg(windows)]
fn windows_file_proof(file: &File, metadata: &fs::Metadata) -> Result<FileProof, String> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    type Handle = *mut c_void;
    #[repr(C)]
    struct Info {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        modified: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[repr(C)]
    struct AclInfo {
        count: u32,
        used: u32,
        free: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: Handle, info: *mut Info) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn LocalFree(memory: Handle) -> Handle;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            kind: u32,
            data: Handle,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn GetSecurityInfo(
            handle: Handle,
            kind: u32,
            information: u32,
            owner: *mut Handle,
            group: *mut Handle,
            dacl: *mut Handle,
            sacl: *mut Handle,
            descriptor: *mut Handle,
        ) -> u32;
        fn EqualSid(left: Handle, right: Handle) -> i32;
        fn ConvertStringSidToSidW(text: *const u16, sid: *mut Handle) -> i32;
        fn GetAclInformation(acl: Handle, info: *mut AclInfo, size: u32, kind: u32) -> i32;
        fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
    }
    let mut info: Info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.attributes & 0x400 != 0
        || (!metadata.is_dir() && info.links != 1)
    {
        return Err("Unsafe deletion file".into());
    }
    let (mut token, mut descriptor, mut owner, mut acl, mut system) = (
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    let result = (|| {
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
            return Err("Unsafe deletion file".into());
        }
        let mut needed = 0;
        unsafe { GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 || needed > 64 * 1024 {
            return Err("Unsafe deletion file".into());
        }
        let mut user = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe { GetTokenInformation(token, 1, user.as_mut_ptr().cast(), needed, &mut needed) }
            == 0
            || unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    1,
                    5,
                    &mut owner,
                    std::ptr::null_mut(),
                    &mut acl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            } != 0
            || owner.is_null()
            || acl.is_null()
        {
            return Err("Unsafe deletion file".into());
        }
        let user_sid = unsafe { *(user.as_ptr().cast::<Handle>()) };
        if unsafe { EqualSid(owner, user_sid) } == 0 {
            return Err("Unsafe deletion file".into());
        }
        let system_text: Vec<u16> = "S-1-5-18".encode_utf16().chain(Some(0)).collect();
        if unsafe { ConvertStringSidToSidW(system_text.as_ptr(), &mut system) } == 0 {
            return Err("Unsafe deletion file".into());
        }
        let mut acl_info = AclInfo {
            count: 0,
            used: 0,
            free: 0,
        };
        if unsafe {
            GetAclInformation(acl, &mut acl_info, std::mem::size_of::<AclInfo>() as u32, 2)
        } == 0
            || acl_info.count == 0
            || acl_info.count > 64
        {
            return Err("Unsafe deletion file".into());
        }
        for index in 0..acl_info.count {
            let mut ace = std::ptr::null_mut();
            if unsafe { GetAce(acl, index, &mut ace) } == 0 || ace.is_null() {
                return Err("Unsafe deletion file".into());
            }
            let bytes = ace.cast::<u8>();
            if unsafe { *bytes } != 0 {
                return Err("Unsafe deletion file".into());
            }
            let size = unsafe { std::ptr::read_unaligned(bytes.add(2).cast::<u16>()) };
            if size < 16 {
                return Err("Unsafe deletion file".into());
            }
            let sid = unsafe { bytes.add(8) }.cast::<c_void>();
            if unsafe { EqualSid(sid, user_sid) } == 0 && unsafe { EqualSid(sid, system) } == 0 {
                return Err("Unsafe deletion file".into());
            }
        }
        Ok(FileProof {
            device: info.volume as u64,
            inode: ((info.index_high as u64) << 32) | info.index_low as u64,
            length: metadata.len(),
            modified: ((info.modified[1] as u64) << 32) | info.modified[0] as u64,
            links: info.links as u64,
        })
    })();
    unsafe {
        if !token.is_null() {
            CloseHandle(token);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor);
        }
        if !system.is_null() {
            LocalFree(system);
        }
    }
    result
}
fn same_directory(path: &Path, expected: &FileProof) -> Result<(), String> {
    let current = directory_proof(path)?;
    if (current.device, current.inode) != (expected.device, expected.inode) {
        return Err(DELETE_EXPIRED.into());
    }
    Ok(())
}
fn deletion_file(path: &Path, role: &DeleteRole) -> Result<Option<(File, FileProof)>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Unsafe deletion file".into()),
        Ok(m) if linked(&m) || !m.is_file() => return Err("Unsafe deletion file".into()),
        Ok(_) => {}
    }
    // Existing session logs may be 0644: readable is safe, shared write access is not.
    #[cfg(unix)]
    let file = if matches!(role, DeleteRole::Log) {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| "Unsafe deletion file")?
    } else {
        super::background::private_file(path, false).map_err(|_| "Unsafe deletion file")?
    };
    #[cfg(not(unix))]
    let file = super::background::private_file(path, false).map_err(|_| "Unsafe deletion file")?;
    let p = proof(&file, Some(role))?;
    Ok(Some((file, p)))
}
fn delete_path(root: &Path, dir: &Path, id: &str, role: &DeleteRole) -> PathBuf {
    match role {
        DeleteRole::Shard => dir.join(format!("{id}.json")),
        DeleteRole::Log => root.join(format!("{id}.log")),
        DeleteRole::Frame => root.join(format!("{id}.frame.json")),
    }
}
fn staged_path(stage: &Path, id: &str, role: &DeleteRole) -> PathBuf {
    stage.join(match role {
        DeleteRole::Shard => format!("{id}.json"),
        DeleteRole::Log => format!("{id}.log"),
        DeleteRole::Frame => format!("{id}.frame.json"),
    })
}
fn eligible(
    record: &SessionRecord,
    claims: &std::collections::HashSet<String>,
    active: &std::collections::HashSet<String>,
) -> Result<(), String> {
    if !matches!(record.status.as_str(), "succeeded" | "failed" | "stopped") {
        return Err("Session is not eligible for archive".into());
    }
    if record.notification_pending
        || record
            .agent
            .inbox
            .iter()
            .any(|r| !r.read || matches!(r.delivery.as_str(), "pending" | "failed"))
    {
        return Err("Session has pending notifications".into());
    }
    if record
        .agent
        .agent_session_id
        .as_ref()
        .is_some_and(|id| claims.contains(id))
    {
        return Err("Session is being resumed".into());
    }
    if active.contains(&record.summary.session_id) {
        return Err("Session is still finalizing".into());
    }
    Ok(())
}
impl HistoryStore {
    // Called while holding the records guard, after any pending transaction has recovered.
    fn latest_deletion_receipt(&self) -> Result<Option<DeletionResult>, String> {
        let path = self.root.join("archive/last-deletion.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Invalid deletion receipt".into()),
            Ok(_) => {}
        }
        self.archive_directory(false)
            .map_err(|_| "Invalid deletion receipt")?;
        let receipt: DeletionResult =
            archive_read(&path, 64 * 1024).map_err(|_| "Invalid deletion receipt")?;
        let mut ids = std::collections::HashSet::new();
        if !archive_id(&receipt.preview_id)
            || receipt.deleted_ids.len() > 20
            || !receipt.issues.is_empty()
            || receipt
                .deleted_ids
                .iter()
                .any(|id| !archive_id(id) || !ids.insert(id))
        {
            return Err("Invalid deletion receipt".into());
        }
        Ok(Some(receipt))
    }
    pub(crate) fn retention_policy(&self) -> Result<serde_json::Value, String> {
        let _records = self.lock_records()?;
        let policy = self.read_retention_policy()?;
        Ok(
            serde_json::json!({"auto_archive_30_days":policy.auto_archive_30_days,"auto_delete":false}),
        )
    }
    fn read_retention_policy(&self) -> Result<RetentionPolicy, String> {
        let path = self.root.join("retention-policy.json");
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RetentionPolicy {
                auto_archive_30_days: false,
            }),
            _ => archive_read(&path, 4096).map_err(|_| "Invalid retention policy".into()),
        }
    }
    pub(crate) fn set_retention_policy(&self, enabled: bool) -> Result<(), String> {
        let _records = self.lock_records()?;
        archive_json(
            &self.root.join("retention-policy.json"),
            &RetentionPolicy {
                auto_archive_30_days: enabled,
            },
            4096,
        )
    }
    #[cfg(test)]
    fn auto_archive_batch(
        &self,
        now: u64,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        deadline: Instant,
    ) -> Result<Vec<String>, String> {
        self.auto_archive_batch_checked(now, claims, active, deadline, &|| false)
    }
    pub(crate) fn auto_archive_batch_checked(
        &self,
        now: u64,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        deadline: Instant,
        cancelled: &impl Fn() -> bool,
    ) -> Result<Vec<String>, String> {
        let ids = {
            let records = self.lock_records()?;
            if !self.read_retention_policy()?.auto_archive_30_days {
                return Ok(Vec::new());
            }
            records
                .iter()
                .filter(|r| {
                    r.ended_at
                        .is_some_and(|ended| ended < now.saturating_sub(30 * 86400))
                        && eligible(r, claims, active).is_ok()
                })
                .take(5)
                .map(|r| r.summary.session_id.clone())
                .collect::<Vec<_>>()
        };
        let mut done = Vec::new();
        for id in ids {
            if Instant::now() >= deadline || cancelled() {
                break;
            }
            self.archive(&id, claims, active)?;
            done.push(id);
        }
        Ok(done)
    }
    fn deletion_directories(
        &self,
        dir: &Path,
    ) -> Result<(FileProof, FileProof, FileProof), String> {
        Ok((
            directory_proof(self.root.parent().ok_or("Unsafe deletion file")?)?,
            directory_proof(&self.root)?,
            directory_proof(dir)?,
        ))
    }
    fn check_deletion_directories(
        &self,
        dir: &Path,
        preview: &DeletePreview,
    ) -> Result<(), String> {
        same_directory(
            self.root.parent().ok_or("Unsafe deletion file")?,
            &preview.parent_directory,
        )?;
        same_directory(&self.root, &preview.root_directory)?;
        same_directory(dir, &preview.archive_directory)
    }
    fn deletion_target(
        &self,
        records: &[SessionRecord],
        dir: &Path,
        id: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
    ) -> Result<(DeleteTarget, u64), String> {
        if records.iter().any(|r| r.summary.session_id == id) {
            return Err("Session is not archived".into());
        }
        let record = self
            .archive_record(id)
            .map_err(|_| "Unknown or unavailable archived session")?;
        eligible(&record, claims, active)?;
        let location: ArchiveLocation = archive_read(&dir.join(format!("{id}.index.json")), 4096)?;
        let mut files = Vec::new();
        for role in [DeleteRole::Shard, DeleteRole::Log, DeleteRole::Frame] {
            let path = delete_path(&self.root, dir, id, &role);
            let data = deletion_file(&path, &role)?;
            if matches!(role, DeleteRole::Frame) && data.is_some() {
                let frame: super::TerminalFrame =
                    archive_read(&path, 64 * 1024 * 1024).map_err(|_| "Unsafe deletion file")?;
                super::terminal_runtime::validate_snapshot(&frame.projection, id, None)
                    .map_err(|_| "Unsafe deletion file")?;
                if frame.end_offset != record.output_end_offset || frame.status != record.status {
                    return Err("Unsafe deletion file".into());
                }
            }
            if matches!(role, DeleteRole::Log)
                && data.as_ref().is_some_and(|(_, p)| {
                    p.length > record.output_end_offset || p.length > super::MAX_SESSION_LOG_BYTES
                })
            {
                return Err("Unsafe deletion file".into());
            }
            files.push(DeleteFile {
                role,
                proof: data.map(|(_, p)| p),
            });
        }
        Ok((
            DeleteTarget {
                id: id.into(),
                location,
                files,
            },
            record.ended_at.unwrap_or(record.started_at),
        ))
    }
    pub(crate) fn preview_archive_deletion(
        &self,
        ids: &[String],
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
    ) -> Result<serde_json::Value, String> {
        if ids.is_empty() || ids.len() > 20 || ids.iter().any(|id| !archive_id(id)) {
            return Err("Invalid deletion selection".into());
        }
        let records = self.lock_records()?;
        let dir = self.archive_directory(false)?;
        let (parent_directory, root_directory, archive_directory) =
            self.deletion_directories(&dir)?;
        let root = self.archive_root(&dir)?;
        let mut targets = Vec::new();
        let mut times = Vec::new();
        for id in ids {
            if targets.iter().any(|t: &DeleteTarget| t.id == *id) {
                continue;
            }
            let (target, time) = self.deletion_target(&records, &dir, id, claims, active)?;
            targets.push(target);
            times.push(time);
        }
        let bytes = targets
            .iter()
            .flat_map(|t| &t.files)
            .filter_map(|f| f.proof.as_ref())
            .map(|p| p.length)
            .sum();
        let preview = DeletePreview {
            version: 1,
            preview_id: next_session_id(),
            instance: self.instance.clone(),
            expires_at: unix_timestamp().saturating_add(300),
            parent_directory,
            root_directory,
            archive_directory,
            hot_revision: self.revision.load(Ordering::Acquire),
            archive_revision: root.revision,
            targets,
            earliest_ended_at: times.iter().copied().min(),
            latest_ended_at: times.iter().copied().max(),
            bytes,
        };
        archive_json(&dir.join("deletion-preview.json"), &preview, DELETE_BUDGET)?;
        Ok(
            serde_json::json!({"preview_id":preview.preview_id,"session_ids":preview.targets.iter().map(|t|&t.id).collect::<Vec<_>>(),"count":preview.targets.len(),"earliest_ended_at":preview.earliest_ended_at,"latest_ended_at":preview.latest_ended_at,"bytes":preview.bytes,"scope":DELETE_SCOPE}),
        )
    }
    pub(crate) fn cancel_archive_deletion_preview(&self, token: &str) -> Result<(), String> {
        let _records = self.lock_records()?;
        let dir = self.archive_directory(false)?;
        let path = dir.join("deletion-preview.json");
        let preview: DeletePreview =
            archive_read(&path, DELETE_BUDGET).map_err(|_| DELETE_EXPIRED)?;
        if preview.preview_id != token || preview.instance != self.instance {
            return Err(DELETE_EXPIRED.into());
        }
        fs::remove_file(path).map_err(|_| DELETE_STORAGE)?;
        sync_directory(&dir)
    }
    #[cfg(test)]
    fn confirm_archive_deletion(
        &self,
        token: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
    ) -> Result<Vec<String>, String> {
        let result = self.delete_result(token, claims, active)?;
        if !result.complete {
            return Err(result
                .issues
                .first()
                .cloned()
                .unwrap_or_else(|| DELETE_STORAGE.into()));
        }
        Ok(result.deleted_ids)
    }
    pub(crate) fn delete_result(
        &self,
        token: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
    ) -> Result<DeletionResult, String> {
        self.delete_operation(token, claims, active, "", || {})
    }
    #[cfg(test)]
    fn delete_with_fault(
        &self,
        token: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        fault: &str,
    ) -> Result<Vec<String>, String> {
        let result = self.delete_operation(token, claims, active, fault, || {})?;
        if !result.complete {
            return Err(result.issues[0].clone());
        }
        Ok(result.deleted_ids)
    }
    #[cfg(test)]
    fn delete_with_hook(
        &self,
        token: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        hook: impl FnOnce(),
    ) -> Result<Vec<String>, String> {
        let result = self.delete_operation(token, claims, active, "", hook)?;
        if !result.complete {
            return Err(result.issues[0].clone());
        }
        Ok(result.deleted_ids)
    }
    fn delete_fault(stage: &str, fault: &str) -> Result<(), String> {
        #[cfg(test)]
        if stage == fault {
            return Err(format!("Injected deletion fault: {stage}"));
        }
        let _ = (stage, fault);
        Ok(())
    }
    fn validate_delete_transaction(txn: &DeleteTransaction) -> Result<(), String> {
        let p = &txn.preview;
        if txn.kind != "delete"
            || txn.version != 1
            || p.version != 1
            || !archive_id(&p.preview_id)
            || p.targets.is_empty()
            || p.targets.len() > 20
            || txn.root.version != 1
            || txn.root.count > txn.root.slots
            || txn.root.slots > 1_000_000
        {
            return Err("Invalid deletion transaction".into());
        }
        let mut seen = std::collections::HashSet::new();
        for target in &p.targets {
            if !archive_id(&target.id)
                || !seen.insert(&target.id)
                || target.location.slot >= 100
                || target.location.page >= 10_000
                || target.location.page * 100 + target.location.slot >= txn.root.slots
                || target.files.len() != 3
            {
                return Err("Invalid deletion transaction".into());
            }
            for (file, role) in
                target
                    .files
                    .iter()
                    .zip([DeleteRole::Shard, DeleteRole::Log, DeleteRole::Frame])
            {
                if std::mem::discriminant(&file.role) != std::mem::discriminant(&role)
                    || file.proof.as_ref().is_some_and(|p| p.links != 1)
                    || (matches!(role, DeleteRole::Shard)
                        && file
                            .proof
                            .as_ref()
                            .is_none_or(|p| p.length > MAX_SESSION_HISTORY_BYTES))
                {
                    return Err("Invalid deletion transaction".into());
                }
            }
        }
        Ok(())
    }
    fn delete_operation(
        &self,
        token: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        fault: &str,
        hook: impl FnOnce(),
    ) -> Result<DeletionResult, String> {
        let mut records = self.lock_records()?;
        let dir = self.archive_directory(false)?;
        self.deletion_directories(&dir)?;
        if let Ok(receipt) =
            archive_read::<DeletionResult>(&dir.join("last-deletion.json"), 64 * 1024)
        {
            if receipt.preview_id == token && receipt.complete && receipt.deleted_ids.len() <= 20 {
                return Ok(receipt);
            }
        }
        let preview: DeletePreview =
            archive_read(&dir.join("deletion-preview.json"), DELETE_BUDGET)
                .map_err(|_| DELETE_EXPIRED)?;
        if preview.version != 1
            || preview.preview_id != token
            || preview.instance != self.instance
            || preview.expires_at <= unix_timestamp()
            || preview.hot_revision != self.revision.load(Ordering::Acquire)
        {
            return Err(DELETE_EXPIRED.into());
        }
        self.check_deletion_directories(&dir, &preview)
            .map_err(|_| DELETE_EXPIRED)?;
        let mut root = self.archive_root(&dir)?;
        if root.revision != preview.archive_revision {
            return Err(DELETE_EXPIRED.into());
        }
        // Open and keep each verified handle until staging; preflight every member before the first move.
        let mut held = Vec::new();
        for target in &preview.targets {
            let (current, _) = self
                .deletion_target(&records, &dir, &target.id, claims, active)
                .map_err(|e| {
                    if matches!(
                        e.as_str(),
                        "Session is being resumed"
                            | "Session has pending notifications"
                            | "Session is still finalizing"
                    ) {
                        e
                    } else {
                        DELETE_EXPIRED.into()
                    }
                })?;
            for (expected, current) in target.files.iter().zip(current.files) {
                if expected.proof != current.proof {
                    return Err(DELETE_EXPIRED.into());
                }
                if let Some((file, p)) = deletion_file(
                    &delete_path(&self.root, &dir, &target.id, &expected.role),
                    &expected.role,
                )? {
                    held.push((file, p, expected.role.clone()));
                }
            }
        }
        root.count = root
            .count
            .checked_sub(preview.targets.len())
            .ok_or("Invalid deletion transaction")?;
        root.revision = root
            .revision
            .checked_add(1)
            .ok_or("Archive revision limit reached")?;
        let txn = DeleteTransaction {
            kind: "delete".into(),
            version: 1,
            preview,
            root,
        };
        Self::validate_delete_transaction(&txn)?;
        self.archive_pending.store(true, Ordering::Release);
        #[cfg(test)]
        if fault == "transaction_publication" {
            fs::create_dir(dir.join("transaction.json")).map_err(|_| DELETE_STORAGE)?;
        }
        archive_json(&dir.join("transaction.json"), &txn, DELETE_BUDGET)?;
        Self::delete_fault("transaction_sync", fault)?;
        hook();
        self.check_deletion_directories(&dir, &txn.preview)?;
        for target in &txn.preview.targets {
            for expected in &target.files {
                let current = deletion_file(
                    &delete_path(&self.root, &dir, &target.id, &expected.role),
                    &expected.role,
                )?;
                if current.as_ref().map(|(_, p)| p) != expected.proof.as_ref() {
                    fs::remove_file(dir.join("transaction.json")).map_err(|_| DELETE_STORAGE)?;
                    sync_directory(&dir)?;
                    self.archive_pending.store(false, Ordering::Release);
                    return Err(DELETE_EXPIRED.into());
                }
            }
        }
        for (file, p, role) in &held {
            if proof(file, Some(role))? != *p {
                return Err(DELETE_EXPIRED.into());
            }
        }
        let mut receipt = DeletionResult {
            preview_id: token.into(),
            deleted_ids: Vec::new(),
            complete: false,
            issues: Vec::new(),
        };
        let result = self.apply_delete(&dir, &txn, &mut records, &mut receipt, fault);
        match result {
            Ok(()) => {
                self.archive_pending.store(false, Ordering::Release);
                Ok(receipt)
            }
            Err(error) => {
                receipt.complete = false;
                receipt.issues = vec![error];
                Ok(receipt)
            }
        }
    }
    fn apply_delete(
        &self,
        dir: &Path,
        txn: &DeleteTransaction,
        records: &mut Vec<SessionRecord>,
        receipt: &mut DeletionResult,
        fault: &str,
    ) -> Result<(), String> {
        Self::validate_delete_transaction(txn)?;
        self.check_deletion_directories(dir, &txn.preview)?;
        let stage = dir.join("delete-staging");
        if !stage.exists() {
            fs::create_dir(&stage).map_err(|_| DELETE_STORAGE)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))
                    .map_err(|_| DELETE_STORAGE)?;
            }
            #[cfg(windows)]
            super::background::protect_windows_path(&stage)?;
            sync_directory(dir)?;
        }
        let stage_proof = directory_proof(&stage)?;
        // Membership removal is committed only after every existing owned source is staged.
        let committed = self.archive_root(dir)?.revision == txn.root.revision;
        for target in &txn.preview.targets {
            for file in &target.files {
                let from = delete_path(&self.root, dir, &target.id, &file.role);
                let to = staged_path(&stage, &target.id, &file.role);
                self.check_deletion_directories(dir, &txn.preview)?;
                same_directory(&stage, &stage_proof)?;
                let staged = deletion_file(&to, &file.role)?;
                if let Some((_, p)) = staged {
                    if Some(&p) != file.proof.as_ref() || fs::symlink_metadata(&from).is_ok() {
                        return Err("Unsafe deletion file".into());
                    }
                    continue;
                }
                let source = deletion_file(&from, &file.role)?;
                match (source, file.proof.as_ref()) {
                    (None, None) => {}
                    (None, Some(_)) if committed => {}
                    (Some((handle, p)), Some(expected)) if &p == expected => {
                        if proof(&handle, Some(&file.role))? != *expected {
                            return Err("Unsafe deletion file".into());
                        }
                        fs::rename(&from, &to).map_err(|_| DELETE_STORAGE)?;
                        self.check_deletion_directories(dir, &txn.preview)?;
                        same_directory(&stage, &stage_proof)?;
                        let staged =
                            deletion_file(&to, &file.role)?.ok_or("Unsafe deletion file")?;
                        if staged.1 != *expected || proof(&handle, Some(&file.role))? != *expected {
                            return Err("Unsafe deletion file".into());
                        }
                    }
                    _ => return Err("Unsafe deletion file".into()),
                }
            }
        }
        sync_directory(&self.root)?;
        sync_directory(dir)?;
        sync_directory(&stage)?;
        Self::delete_fault("files_staged", fault)?;
        self.check_deletion_directories(dir, &txn.preview)?;
        same_directory(&stage, &stage_proof)?;
        let ids = txn
            .preview
            .targets
            .iter()
            .map(|t| t.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let updated = records
            .iter()
            .filter(|r| !ids.contains(r.summary.session_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        let hot = serde_json::to_vec_pretty(&updated).map_err(|_| DELETE_STORAGE)?;
        if hot.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err(DELETE_STORAGE.into());
        }
        for target in &txn.preview.targets {
            let path = dir.join(format!("page-{}.json", target.location.page));
            let mut page: Vec<Option<ArchiveEntry>> = archive_read(&path, ARCHIVE_PAGE_BYTES)?;
            if page.len() > 100
                || target.location.slot >= page.len()
                || page[target.location.slot]
                    .as_ref()
                    .is_some_and(|e| e.item.summary.session_id != target.id)
            {
                return Err("Invalid deletion transaction".into());
            }
            page[target.location.slot] = None;
            archive_json(&path, &page, ARCHIVE_PAGE_BYTES)?;
            let index = dir.join(format!("{}.index.json", target.id));
            if fs::symlink_metadata(&index).is_ok() {
                archive_read::<ArchiveLocation>(&index, 4096)?;
                fs::remove_file(index).map_err(|_| DELETE_STORAGE)?;
            }
        }
        archive_json(&dir.join("root.json"), &txn.root, 4096)?;
        archive_atomic(&self.records_path(), &hot)?;
        Self::delete_fault("manifest_sync", fault)?;
        archive_atomic(&self.root.join("sessions.json.bak"), &hot)?;
        sync_directory(&self.root)?;
        *records = updated;
        self.revision.fetch_add(1, Ordering::AcqRel);
        Self::delete_fault("backup_sync", fault)?;
        for target in &txn.preview.targets {
            for file in &target.files {
                self.check_deletion_directories(dir, &txn.preview)?;
                same_directory(&stage, &stage_proof)?;
                let path = staged_path(&stage, &target.id, &file.role);
                if let Some((_, p)) = deletion_file(&path, &file.role)? {
                    if Some(&p) != file.proof.as_ref() {
                        return Err("Unsafe deletion file".into());
                    }
                    fs::remove_file(path).map_err(|_| DELETE_STORAGE)?;
                    Self::delete_fault("file_delete", fault)?;
                }
            }
            sync_directory(&stage)?;
            receipt.deleted_ids.push(target.id.clone());
            archive_json(&dir.join("last-deletion.json"), receipt, 64 * 1024)?;
            Self::delete_fault("receipt_sync", fault)?;
        }
        // Unknown staging members are retained and reported; never recursively remove a directory.
        fs::remove_dir(&stage).map_err(|_| DELETE_STORAGE)?;
        sync_directory(dir)?;
        receipt.complete = true;
        archive_json(&dir.join("last-deletion.json"), receipt, 64 * 1024)?;
        let preview = dir.join("deletion-preview.json");
        if fs::symlink_metadata(&preview).is_ok() {
            fs::remove_file(preview).map_err(|_| DELETE_STORAGE)?;
        }
        fs::remove_file(dir.join("transaction.json")).map_err(|_| DELETE_STORAGE)?;
        Self::delete_fault("transaction_removed", fault)?;
        sync_directory(dir)?;
        Ok(())
    }
    fn recover_delete_locked(
        &self,
        dir: &Path,
        value: serde_json::Value,
        records: &mut Vec<SessionRecord>,
    ) -> Result<(), String> {
        let txn: DeleteTransaction =
            serde_json::from_value(value).map_err(|_| "Invalid deletion transaction")?;
        Self::validate_delete_transaction(&txn)?;
        let mut receipt = DeletionResult {
            preview_id: txn.preview.preview_id.clone(),
            deleted_ids: Vec::new(),
            complete: false,
            issues: Vec::new(),
        };
        self.apply_delete(dir, &txn, records, &mut receipt, "")?;
        self.archive_pending.store(false, Ordering::Release);
        Ok(())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveRoot {
    version: u8,
    slots: usize,
    count: usize,
    revision: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveLocation {
    page: usize,
    slot: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveTransaction {
    restore: bool,
    id: String,
    location: ArchiveLocation,
    root: ArchiveRoot,
}
fn archive_id(id: &str) -> bool {
    id.starts_with("s-")
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot sync archive directory")?;
    let _ = path;
    Ok(())
}
fn archive_read<T: serde::de::DeserializeOwned>(path: &Path, budget: u64) -> Result<T, String> {
    #[cfg(test)]
    if budget == MAX_SESSION_HISTORY_BYTES {
        ARCHIVE_SHARD_READS.with(|reads| reads.set(reads.get() + 1));
    }
    let file =
        super::background::private_file(path, false).map_err(|_| "Cannot read archive file")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect archive file")?
        .len()
        > budget
    {
        return Err("Archive file exceeds size budget".into());
    }
    let mut bytes = Vec::new();
    file.take(budget + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read archive file")?;
    if bytes.len() as u64 > budget {
        return Err("Archive file exceeds size budget".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid archive file".into())
}
fn archive_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if linked(&metadata) || !metadata.is_file() {
            return Err("Unsafe archive destination".into());
        }
    }
    let parent = path.parent().ok_or("Invalid archive destination")?;
    let temp = parent.join(format!("archive-write-{}.tmp", next_session_id()));
    let result = (|| {
        let mut file = super::background::private_file(&temp, true)
            .map_err(|_| "Cannot create archive file")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot sync archive file")?;
        #[cfg(not(windows))]
        fs::rename(&temp, path).map_err(|_| "Cannot publish archive file")?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from = temp
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let to = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
                return Err("Cannot publish archive file".into());
            }
        }
        sync_directory(parent)
    })();
    let _ = fs::remove_file(temp);
    result
}
fn archive_json(path: &Path, value: &impl Serialize, budget: u64) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode archive file")?;
    if bytes.len() as u64 > budget {
        return Err("Archive file exceeds size budget".into());
    }
    archive_atomic(path, &bytes)
}
impl HistoryStore {
    fn archive_directory(&self, create: bool) -> Result<PathBuf, String> {
        let path = self.root.join("archive");
        if create && !path.exists() {
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("Cannot create archive directory".into()),
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Cannot protect archive directory")?;
            }
            #[cfg(windows)]
            super::background::protect_windows_path(&path)?;
            sync_directory(&self.root)?;
        }
        let m = fs::symlink_metadata(&path).map_err(|_| "Archive directory unavailable")?;
        if linked(&m) || !m.is_dir() {
            return Err("Unsafe archive directory".into());
        }
        Ok(path)
    }
    fn archive_root(&self, dir: &Path) -> Result<ArchiveRoot, String> {
        let path = dir.join("root.json");
        let root: ArchiveRoot = if fs::symlink_metadata(&path).is_ok() {
            archive_read(&path, 4096)?
        } else {
            let deadline = Instant::now() + Duration::from_millis(250);
            for (index, entry) in fs::read_dir(dir)
                .map_err(|_| "Cannot inspect archive manifest")?
                .enumerate()
            {
                if index >= 4096 || Instant::now() >= deadline {
                    return Err("Archive initialization scan exceeds budget".into());
                }
                let entry = entry.map_err(|_| "Cannot inspect archive manifest")?;
                let metadata = fs::symlink_metadata(entry.path())
                    .map_err(|_| "Cannot inspect archive manifest")?;
                let name = entry.file_name();
                let name = name.to_str().ok_or("Invalid archive manifest entry")?;
                let orphan = name.strip_suffix(".json").is_some_and(archive_id);
                if linked(&metadata)
                    || !metadata.is_file()
                    || !orphan
                    || metadata.len() > MAX_SESSION_HISTORY_BYTES
                {
                    return Err("Archive manifest root is missing; preserve archive files and repair before continuing".into());
                }
            }
            ArchiveRoot {
                version: 1,
                ..Default::default()
            }
        };
        if root.version != 1 || root.count > root.slots || root.slots > 1_000_000 {
            return Err("Invalid archive manifest".into());
        }
        Ok(root)
    }
    fn archive_record(&self, id: &str) -> Result<SessionRecord, String> {
        if !archive_id(id) {
            return Err("Unknown session".into());
        }
        let dir = self.archive_directory(false)?;
        let location: ArchiveLocation = archive_read(&dir.join(format!("{id}.index.json")), 4096)?;
        if location.slot >= 100 || location.page >= 10_000 {
            return Err("Invalid archive location".into());
        }
        let root = self.archive_root(&dir)?;
        if location.page * 100 + location.slot >= root.slots || root.count == 0 {
            return Err("Invalid archive location".into());
        }
        let page: Vec<Option<ArchiveEntry>> = archive_read(
            &dir.join(format!("page-{}.json", location.page)),
            ARCHIVE_PAGE_BYTES,
        )?;
        if page.len() > 100
            || page
                .get(location.slot)
                .and_then(Option::as_ref)
                .is_none_or(|item| item.item.summary.session_id != id)
        {
            return Err("Invalid archive membership".into());
        }
        self.archive_shard(&dir, id)
    }
    fn archive_shard(&self, dir: &Path, id: &str) -> Result<SessionRecord, String> {
        if !archive_id(id) {
            return Err("Invalid archive identity".into());
        }
        let record: SessionRecord =
            archive_read(&dir.join(format!("{id}.json")), MAX_SESSION_HISTORY_BYTES)?;
        if record.summary.session_id != id
            || !matches!(record.status.as_str(), "succeeded" | "failed" | "stopped")
        {
            return Err("Invalid archive record".into());
        }
        Ok(record)
    }
    pub(crate) fn get_locked(
        &self,
        records: &[SessionRecord],
        id: &str,
    ) -> Result<SessionRecord, String> {
        if let Some(record) = records.iter().find(|r| r.summary.session_id == id) {
            return Ok(record.clone());
        }
        self.archive_record(id)
            .map_err(|_| "Unknown or unavailable archived session".into())
    }
    pub(crate) fn archive(
        &self,
        id: &str,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
    ) -> Result<(), String> {
        self.change_archive(id, false, claims, active, "")
    }
    pub(crate) fn restore_archive(&self, id: &str) -> Result<(), String> {
        self.change_archive(id, true, &Default::default(), &Default::default(), "")
    }
    fn archive_fault(stage: &str, fault: &str) -> Result<(), String> {
        #[cfg(test)]
        if stage == fault {
            return Err(format!("Injected archive fault: {stage}"));
        }
        let _ = (stage, fault);
        Ok(())
    }
    #[cfg(test)]
    fn archive_with_fault(&self, id: &str, stage: &str) -> Result<(), String> {
        self.change_archive(id, false, &Default::default(), &Default::default(), stage)
    }
    #[cfg(test)]
    fn restore_archive_with_fault(&self, id: &str, stage: &str) -> Result<(), String> {
        self.change_archive(id, true, &Default::default(), &Default::default(), stage)
    }
    fn change_archive(
        &self,
        id: &str,
        restore: bool,
        claims: &std::collections::HashSet<String>,
        active: &std::collections::HashSet<String>,
        fault: &str,
    ) -> Result<(), String> {
        if !archive_id(id) {
            return Err("Invalid archive identity".into());
        }
        let mut records = self.lock_records()?;
        if self.archive_pending.load(Ordering::Acquire) {
            return Err("Archive transaction requires recovery; reopen history".into());
        }
        let record = if restore {
            if records.iter().any(|r| r.summary.session_id == id) {
                return Err("Session is already in hot history".into());
            }
            self.archive_record(id)?
        } else {
            records
                .iter()
                .find(|r| r.summary.session_id == id)
                .cloned()
                .ok_or("Unknown session")?
        };
        if !restore {
            if !matches!(record.status.as_str(), "succeeded" | "failed" | "stopped") {
                return Err("Session is not eligible for archive".into());
            }
            if record.notification_pending
                || record
                    .agent
                    .inbox
                    .iter()
                    .any(|r| !r.read || matches!(r.delivery.as_str(), "pending" | "failed"))
            {
                return Err("Session has pending notifications".into());
            }
            if record
                .agent
                .agent_session_id
                .as_ref()
                .is_some_and(|id| claims.contains(id))
            {
                return Err("Session is being resumed".into());
            }
            if active.contains(id) {
                return Err("Session is still finalizing".into());
            }
        }
        let mut updated = records.clone();
        updated.retain(|r| r.summary.session_id != id);
        if restore {
            updated.push(record.clone());
        }
        let hot =
            serde_json::to_vec_pretty(&updated).map_err(|_| "Cannot encode session history")?;
        if hot.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err(
                "Session history exceeds 32 MiB; archive more sessions before restoring".into(),
            );
        }
        let bytes =
            serde_json::to_vec_pretty(&record).map_err(|_| "Cannot encode archive record")?;
        if bytes.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err("Archive shard exceeds 32 MiB".into());
        }
        let dir = self.archive_directory(true)?;
        let mut root = self.archive_root(&dir)?;
        let location: ArchiveLocation = if restore {
            archive_read(&dir.join(format!("{id}.index.json")), 4096)?
        } else {
            ArchiveLocation {
                page: root.slots / 100,
                slot: root.slots % 100,
            }
        };
        if !restore {
            let manifest_path = dir.join(format!("page-{}.json", location.page));
            let mut page: Vec<Option<ArchiveEntry>> = if manifest_path.exists() {
                archive_read(&manifest_path, ARCHIVE_PAGE_BYTES)?
            } else {
                Vec::new()
            };
            if page.len() > 100 {
                return Err("Invalid archive manifest".into());
            }
            while page.len() <= location.slot {
                page.push(None);
            }
            page[location.slot] = Some(archive_entry(&record));
            if serde_json::to_vec_pretty(&page)
                .map_err(|_| "Cannot encode archive manifest")?
                .len() as u64
                > ARCHIVE_PAGE_BYTES
            {
                return Err("Archive manifest page exceeds size budget".into());
            }
            if root.slots == 1_000_000 {
                return Err("Archive manifest capacity reached".into());
            }
            archive_atomic(&dir.join(format!("{id}.json")), &bytes)?;
            Self::archive_fault("shard_sync", fault)?;
            root.slots += 1;
            root.count += 1;
        } else {
            root.count = root
                .count
                .checked_sub(1)
                .ok_or("Invalid archive manifest")?;
        }
        root.revision = root
            .revision
            .checked_add(1)
            .ok_or("Archive revision limit reached")?;
        let txn = ArchiveTransaction {
            restore,
            id: id.into(),
            location,
            root,
        };
        self.archive_pending.store(true, Ordering::Release);
        #[cfg(test)]
        if fault == "transaction_publication" {
            fs::create_dir(dir.join("transaction.json"))
                .map_err(|_| "Cannot create test transaction obstruction")?;
        }
        archive_json(&dir.join("transaction.json"), &txn, 4096)?;
        Self::archive_fault("transaction_sync", fault)?;
        self.apply_archive(&dir, &txn, &record, &updated, fault)?;
        *records = updated;
        self.archive_pending.store(false, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    fn apply_archive(
        &self,
        dir: &Path,
        txn: &ArchiveTransaction,
        record: &SessionRecord,
        updated: &[SessionRecord],
        fault: &str,
    ) -> Result<(), String> {
        let hot =
            serde_json::to_vec_pretty(updated).map_err(|_| "Cannot encode session history")?;
        if hot.len() as u64 > MAX_SESSION_HISTORY_BYTES {
            return Err(
                "Session history exceeds 32 MiB; archive more sessions before restoring".into(),
            );
        }
        Self::archive_fault("hot_rename", fault)?;
        archive_atomic(&self.records_path(), &hot)?;
        Self::archive_fault("hot_directory_sync", fault)?;
        let path = dir.join(format!("page-{}.json", txn.location.page));
        let mut page: Vec<Option<ArchiveEntry>> = if path.exists() {
            archive_read(&path, ARCHIVE_PAGE_BYTES)?
        } else {
            Vec::new()
        };
        if page.len() > 100 || txn.location.slot >= 100 {
            return Err("Invalid archive page".into());
        }
        while page.len() <= txn.location.slot {
            page.push(None);
        }
        page[txn.location.slot] = if txn.restore {
            None
        } else {
            Some(archive_entry(record))
        };
        archive_json(&path, &page, ARCHIVE_PAGE_BYTES)?;
        let locator = dir.join(format!("{}.index.json", txn.id));
        if txn.restore {
            if locator.exists() {
                fs::remove_file(&locator).map_err(|_| "Cannot update archive membership")?;
            }
        } else {
            archive_json(&locator, &txn.location, 4096)?;
        }
        archive_json(&dir.join("root.json"), &txn.root, 4096)?;
        Self::archive_fault("manifest_sync", fault)?;
        // The automatically recoverable backup has identical membership before txn removal.
        archive_atomic(&self.root.join("sessions.json.bak"), &hot)?;
        sync_directory(&self.root)?;
        Self::archive_fault("transaction_done", fault)?;
        fs::remove_file(dir.join("transaction.json"))
            .map_err(|_| "Cannot complete archive transaction")?;
        #[cfg(test)]
        Self::archive_fault("transaction_removed", fault)?;
        sync_directory(dir)?;
        if txn.restore {
            fs::remove_file(dir.join(format!("{}.json", txn.id)))
                .map_err(|_| "Cannot remove restored archive shard")?;
            sync_directory(dir)?;
        }
        Ok(())
    }
    pub(crate) fn lock_records(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Vec<SessionRecord>>, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned")?;
        if self.archive_pending.load(Ordering::Acquire)
            || fs::symlink_metadata(self.root.join("archive/transaction.json")).is_ok()
        {
            self.recover_archive_locked(&mut records)?;
        }
        Ok(records)
    }
    fn recover_archive(&self) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Session history lock poisoned")?;
        self.recover_archive_locked(&mut records)
    }
    fn recover_archive_locked(&self, records: &mut Vec<SessionRecord>) -> Result<(), String> {
        let path = self.root.join("archive");
        if !path.exists() {
            return Ok(());
        }
        let dir = self.archive_directory(false)?;
        let pending = dir.join("transaction.json");
        match fs::symlink_metadata(&pending) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if self.archive_pending.load(Ordering::Acquire) {
                    // Txn publication never happened, or unlink succeeded after the durable commit.
                    // Reload the authoritative hot snapshot before any caller clones the cache.
                    let contents = bounded_history(&self.records_path())?;
                    let durable: Vec<SessionRecord> = serde_json::from_str(&contents)
                        .map_err(|_| "Cannot reload session history after archive failure")?;
                    sync_directory(&dir)?;
                    *records = durable;
                    self.revision.fetch_add(1, Ordering::AcqRel);
                    self.archive_pending.store(false, Ordering::Release);
                }
                return Ok(());
            }
            Err(_) => return Err("Cannot inspect archive transaction".into()),
            Ok(metadata) if linked(&metadata) || !metadata.is_file() => {
                return Err("Unsafe archive transaction".into())
            }
            Ok(_) => {}
        }
        self.archive_pending.store(true, Ordering::Release);
        let value: serde_json::Value = archive_read(&pending, DELETE_BUDGET)?;
        if value.get("kind").is_some() {
            return self.recover_delete_locked(&dir, value, records);
        }
        let txn: ArchiveTransaction = archive_read(&pending, 4096)?;
        if !archive_id(&txn.id)
            || txn.location.slot >= 100
            || txn.location.page >= 10_000
            || txn.root.version != 1
            || txn.root.count > txn.root.slots
            || txn.root.slots > 1_000_000
        {
            return Err("Invalid archive transaction".into());
        }
        let record = self.archive_shard(&dir, &txn.id)?;
        let mut updated = records.clone();
        updated.retain(|r| r.summary.session_id != txn.id);
        if txn.restore {
            updated.push(record.clone());
        }
        self.apply_archive(&dir, &txn, &record, &updated, "")?;
        *records = updated;
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.archive_pending.store(false, Ordering::Release);
        Ok(())
    }
    pub(crate) fn log_source_batch(
        &self,
        offset: usize,
        cancelled: &impl Fn() -> bool,
    ) -> Result<LogSourceBatch, String> {
        let records = self.lock_records()?;
        let root = if self.root.join("archive").exists() {
            self.archive_root(&self.archive_directory(false)?)?
        } else {
            ArchiveRoot {
                version: 1,
                ..Default::default()
            }
        };
        let total = records
            .len()
            .checked_add(root.slots)
            .ok_or("Log source limit reached")?;
        if offset > total {
            return Err("Log search cursor expired; restart search".into());
        }
        let end = total.min(offset + 256);
        let mut sources = Vec::new();
        let mut positions = Vec::new();
        let mut end_offsets = Vec::new();
        let mut loaded = usize::MAX;
        let mut page: Vec<Option<ArchiveEntry>> = Vec::new();
        for position in offset..end {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            let source = if position < records.len() {
                let record = &records[records.len() - 1 - position];
                end_offsets.push(record.output_end_offset);
                Some(super::session_logs::LogSource {
                    session_id: record.summary.session_id.clone(),
                    cwd: record.summary.cwd.clone(),
                })
            } else {
                let slot = root.slots - 1 - (position - records.len());
                if loaded != slot / 100 {
                    loaded = slot / 100;
                    page = archive_read(
                        &self
                            .archive_directory(false)?
                            .join(format!("page-{loaded}.json")),
                        ARCHIVE_PAGE_BYTES,
                    )?;
                    if page.len() > 100 {
                        return Err("Invalid archive page".into());
                    }
                }
                page.get(slot % 100).and_then(Option::as_ref).map(|item| {
                    end_offsets.push(item.output_end_offset);
                    super::session_logs::LogSource {
                        session_id: item.item.summary.session_id.clone(),
                        cwd: item.item.summary.cwd.clone(),
                    }
                })
            };
            if let Some(source) = source {
                sources.push(source);
                positions.push(position);
            }
        }
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.instance.hash(&mut hash);
        root.revision.hash(&mut hash);
        root.slots.hash(&mut hash);
        for record in records.iter() {
            record.summary.session_id.hash(&mut hash);
        }
        Ok(LogSourceBatch {
            sources,
            positions,
            end_offsets,
            end,
            total,
            snapshot: format!("{:016x}", hash.finish()),
        })
    }
    pub(crate) fn archive_page(
        &self,
        request: PageRequest,
    ) -> Result<HistoryPage<HistoryItem>, String> {
        let (size, context) = request.validate()?;
        if size > 100 {
            return Err("Archive pages allow 1–100 items".into());
        }
        let _records = self.lock_records()?;
        let (dir, root) = if self.root.join("archive").exists() {
            let dir = self.archive_directory(false)?;
            let root = self.archive_root(&dir)?;
            (Some(dir), root)
        } else {
            (
                None,
                ArchiveRoot {
                    version: 1,
                    ..Default::default()
                },
            )
        };
        let revision = format!("{}:archive:{}", self.instance, root.revision);
        let context = format!("archive:{context}");
        let offset = request.offset(&revision, &context)?;
        if offset > root.slots {
            return Err("Invalid archive cursor offset".into());
        }
        let end = root.slots.min(offset + size);
        let mut items = Vec::new();
        let mut loaded_page = usize::MAX;
        let mut page: Vec<Option<ArchiveEntry>> = Vec::new();
        for position in offset..end {
            let slot = root.slots - 1 - position;
            if loaded_page != slot / 100 {
                loaded_page = slot / 100;
                page = archive_read(
                    &dir.as_ref()
                        .ok_or("Archive unavailable")?
                        .join(format!("page-{loaded_page}.json")),
                    ARCHIVE_PAGE_BYTES,
                )?;
                if page.len() > 100 {
                    return Err("Invalid archive page".into());
                }
            }
            if let Some(Some(value)) = page.get_mut(slot % 100) {
                let value = &value.item;
                let query = request.query.trim().to_lowercase();
                if (request.status.is_empty()
                    || request.status == "all"
                    || request.status == value.status)
                    && (query.is_empty()
                        || value.summary.title.to_lowercase().contains(&query)
                        || value.summary.cwd.to_lowercase().contains(&query)
                        || value.summary.session_id.to_lowercase().contains(&query)
                        || request
                            .matched_session_ids
                            .contains(&value.summary.session_id)
                        || request.matched_project_paths.contains(&value.summary.cwd))
                {
                    if let Some(value) = page[slot % 100].take() {
                        items.push(value.item);
                    }
                }
            }
        }
        let next_cursor = (end < root.slots).then(|| PageCursor {
            revision: revision.clone(),
            context,
            offset: end,
        });
        Ok(HistoryPage {
            revision,
            items,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn f1_owner_recovery_reason_persists_without_migrating_ended_records() {
        let root = std::env::temp_dir().join(format!(
            "yam-f1-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = super::HistoryStore::open(root.clone()).unwrap();
        for status in ["running", "starting", "stopped", "needs_attention"] {
            let summary = crate::SessionSummary {
                session_id: format!("s-{status}"),
                cwd: "/tmp".into(),
                command: None,
                status: status.into(),
                launch: None,
            };
            store.start(&summary).unwrap();
            store
                .update(
                    &summary.session_id,
                    status,
                    None,
                    Some("old recorded reason".into()),
                    None,
                )
                .unwrap();
        }
        let before = std::fs::read(root.join("sessions.json")).unwrap();
        let _ = store.list().unwrap();
        assert_eq!(before, std::fs::read(root.join("sessions.json")).unwrap());
        store.recover_running().unwrap();
        drop(store);
        let reopened = super::HistoryStore::open(root.clone()).unwrap();
        for record in reopened.list().unwrap() {
            if record.summary.session_id == "s-running" || record.summary.session_id == "s-starting"
            {
                assert_eq!(record.status, "needs_attention");
                assert_eq!(record.reason.as_deref(), Some("The background owner restarted; the previous terminal process cannot be reattached"));
            } else {
                assert_eq!(record.reason.as_deref(), Some("old recorded reason"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    use super::*;

    struct RetentionFixture {
        history: std::sync::Arc<HistoryStore>,
        native: PathBuf,
    }
    impl Drop for RetentionFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.history.root);
        }
    }
    fn retention_fixture(archived: usize, hot: usize) -> RetentionFixture {
        let history = std::sync::Arc::new(archive_fixture(archived + hot));
        let native = history.root.join("native-cli-fixture");
        fs::create_dir(&native).unwrap();
        fs::write(
            native.join("session.json"),
            b"native conversation must survive",
        )
        .unwrap();
        for index in 0..archived + hot {
            let id = format!("s-{index:05}");
            let log = format!("fixture {id} 中文 😀\n");
            let mut file =
                super::super::background::private_file(&history.log_path(&id), true).unwrap();
            file.write_all(log.as_bytes()).unwrap();
            file.sync_all().unwrap();
            let frame = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":id,"terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":log,"cols":100,"rows":40,"cursorX":0,"viewport":0,"buffer":"normal"},"end_offset":log.len(),"status":"succeeded","persisted":true});
            archive_json(
                &history.root.join(format!("{id}.frame.json")),
                &frame,
                MAX_SESSION_HISTORY_BYTES,
            )
            .unwrap();
            history.records.lock().unwrap()[index].output_end_offset = log.len() as u64;
            history.records.lock().unwrap()[index]
                .agent
                .agent_session_id = Some(format!("native-{index}"));
        }
        history
            .save_locked(&history.records.lock().unwrap())
            .unwrap();
        for index in 0..archived {
            archive_one(&history, &format!("s-{index:05}")).unwrap();
        }
        RetentionFixture { history, native }
    }
    fn deletion_preview(history: &HistoryStore, ids: &[&str]) -> serde_json::Value {
        let ids = ids.iter().map(|id| (*id).to_string()).collect::<Vec<_>>();
        let result =
            history.preview_archive_deletion(&ids, &Default::default(), &Default::default());
        assert!(
            result.is_ok(),
            "eligible archived fixtures must produce a bounded preview: {result:?}"
        );
        result.unwrap()
    }
    fn assert_fixture_intact(fixture: &RetentionFixture, ids: &[&str]) {
        for id in ids {
            assert!(
                fixture.history.get(id).is_ok(),
                "uncommitted/unselected record {id} must survive"
            );
            assert!(fixture.history.log_path(id).is_file());
            assert!(fixture
                .history
                .root
                .join(format!("{id}.frame.json"))
                .is_file());
        }
        assert_eq!(
            fs::read(fixture.native.join("session.json")).unwrap(),
            b"native conversation must survive"
        );
    }
    #[test]
    fn t05_policy_defaults_off_and_explicit_opt_in_persists_across_restart() {
        let fixture = retention_fixture(1, 1);
        let before = fs::read(fixture.history.records_path()).unwrap();
        let policy = fixture.history.retention_policy();
        assert!(
            policy.is_ok(),
            "fresh store must expose disabled policy: {policy:?}"
        );
        assert_eq!(
            policy.unwrap(),
            serde_json::json!({"auto_archive_30_days":false,"auto_delete":false})
        );
        let ids = fixture
            .history
            .auto_archive_batch(
                90 * 86400,
                &Default::default(),
                &Default::default(),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        assert!(ids.is_empty());
        assert_eq!(fs::read(fixture.history.records_path()).unwrap(), before);
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        fixture.history.set_retention_policy(true).unwrap();
        let reopened = HistoryStore::open(fixture.history.root.clone()).unwrap();
        assert_eq!(
            reopened.retention_policy().unwrap()["auto_archive_30_days"],
            true
        );
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[test]
    fn t05_corrupt_or_public_policy_refuses_automation_and_preserves_history() {
        let fixture = retention_fixture(1, 1);
        archive_atomic(
            &fixture.history.root.join("retention-policy.json"),
            b"corrupt",
        )
        .unwrap();
        assert_eq!(
            fixture.history.retention_policy().unwrap_err(),
            "Invalid retention policy"
        );
        assert_eq!(
            fixture
                .history
                .auto_archive_batch(
                    90 * 86400,
                    &Default::default(),
                    &Default::default(),
                    Instant::now() + Duration::from_secs(2)
                )
                .unwrap_err(),
            "Invalid retention policy"
        );
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[cfg(unix)]
    #[test]
    fn t05_public_policy_cannot_silently_enable_automation() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = retention_fixture(1, 1);
        let path = fixture.history.root.join("retention-policy.json");
        archive_atomic(&path, br#"{"auto_archive_30_days":true}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            fixture.history.retention_policy().unwrap_err(),
            "Invalid retention policy"
        );
        assert_eq!(
            fixture
                .history
                .auto_archive_batch(
                    90 * 86400,
                    &Default::default(),
                    &Default::default(),
                    Instant::now() + Duration::from_secs(2)
                )
                .unwrap_err(),
            "Invalid retention policy"
        );
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[test]
    fn t05_saved_frame_uses_existing_on_disk_persisted_flag_semantics() {
        let fixture = retention_fixture(1, 1);
        let path = fixture.history.root.join("s-00000.frame.json");
        let mut frame: serde_json::Value = archive_read(&path, 64 * 1024 * 1024).unwrap();
        // persist_final_frame saves active_frame (persisted=false); decode_saved_frame sets it on read.
        frame["persisted"] = false.into();
        archive_json(&path, &frame, 64 * 1024 * 1024).unwrap();
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        assert_eq!(preview["count"], 1);
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[test]
    fn t05_auto_archive_strict_utc_thirty_day_boundary_missing_future_and_small_batch() {
        let fixture = retention_fixture(0, 12);
        let now = 100 * 86400;
        {
            let mut records = fixture.history.records.lock().unwrap();
            records[0].ended_at = Some(now - 30 * 86400);
            records[1].ended_at = None;
            records[2].ended_at = Some(now + 1);
            records[3].status = "needs_attention".into();
            for record in &mut records[4..] {
                record.ended_at = Some(now - 30 * 86400 - 1);
            }
            fixture.history.save_locked(&records).unwrap();
        }
        fixture.history.set_retention_policy(true).unwrap();
        let expired = fixture
            .history
            .auto_archive_batch(
                now,
                &Default::default(),
                &Default::default(),
                Instant::now(),
            )
            .unwrap();
        assert!(
            expired.is_empty(),
            "cooperative deadline precedes the first mutation"
        );
        let ids = fixture
            .history
            .auto_archive_batch(
                now,
                &Default::default(),
                &Default::default(),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(ids.len(), 5, "each idle batch is at most five records");
        assert!(ids.iter().all(|id| id.as_str() >= "s-00004"));
        for id in ["s-00000", "s-00001", "s-00002", "s-00003"] {
            assert!(fixture
                .history
                .list()
                .unwrap()
                .iter()
                .any(|r| r.summary.session_id == id));
        }
        assert_fixture_intact(&fixture, &["s-00000", "s-00001", "s-00002", "s-00003"]);
    }
    #[test]
    fn t05_auto_archive_rechecks_pending_failed_unread_active_and_native_claims() {
        let fixture = retention_fixture(0, 6);
        {
            let mut records = fixture.history.records.lock().unwrap();
            records[0].notification_pending = true;
            for (index, delivery, read) in [
                (1, "sent", false),
                (2, "pending", true),
                (3, "failed", true),
            ] {
                records[index].agent.inbox.push(agent_events::AgentReceipt {
                    id: format!("r-{index}"),
                    revision: 1,
                    turn_id: "turn".into(),
                    kind: "response_finished".into(),
                    delivery: delivery.into(),
                    read,
                    error: None,
                });
            }
            fixture.history.save_locked(&records).unwrap();
        }
        fixture.history.set_retention_policy(true).unwrap();
        let claims = ["native-4".into()].into_iter().collect();
        let active = ["s-00005".into()].into_iter().collect();
        assert!(fixture
            .history
            .auto_archive_batch(
                90 * 86400,
                &claims,
                &active,
                Instant::now() + Duration::from_secs(2)
            )
            .unwrap()
            .is_empty());
        assert_eq!(fixture.history.list().unwrap().len(), 6);
    }
    #[test]
    fn t05_preview_freezes_exact_ids_count_time_bytes_scope_and_cancel_changes_no_data() {
        let fixture = retention_fixture(2, 1);
        let hot = fs::read(fixture.history.records_path()).unwrap();
        let preview = deletion_preview(&fixture.history, &["s-00000", "s-00001", "s-00000"]);
        assert_eq!(
            preview["session_ids"],
            serde_json::json!(["s-00000", "s-00001"])
        );
        assert_eq!(preview["count"], 2);
        assert_eq!(preview["earliest_ended_at"], 0);
        assert_eq!(preview["latest_ended_at"], 1);
        assert!(preview["bytes"].as_u64().unwrap() > 0);
        assert_eq!(
            preview["scope"],
            "YAM archived records, logs and saved terminal scenes; native CLI history is retained"
        );
        fixture
            .history
            .cancel_archive_deletion_preview(preview["preview_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(fs::read(fixture.history.records_path()).unwrap(), hot);
        assert_fixture_intact(&fixture, &["s-00000", "s-00001", "s-00002"]);
        assert_eq!(
            fixture
                .history
                .confirm_archive_deletion(
                    preview["preview_id"].as_str().unwrap(),
                    &Default::default(),
                    &Default::default()
                )
                .unwrap_err(),
            "Deletion preview expired; preview again"
        );
    }
    #[test]
    fn t05_confirm_deletes_only_previewed_owned_files_and_backup_never_revives_ids() {
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let deleted = fixture
            .history
            .confirm_archive_deletion(
                preview["preview_id"].as_str().unwrap(),
                &Default::default(),
                &Default::default(),
            )
            .unwrap();
        assert_eq!(deleted, ["s-00000"]);
        assert!(fixture.history.get("s-00000").is_err());
        assert!(!fixture.history.log_path("s-00000").exists());
        assert!(!fixture.history.root.join("s-00000.frame.json").exists());
        assert!(!fixture.history.root.join("archive/s-00000.json").exists());
        assert_fixture_intact(&fixture, &["s-00001", "s-00002"]);
        fixture
            .history
            .update("s-00002", "failed", Some(1), None, None)
            .unwrap();
        assert!(
            fixture.history.get("s-00000").is_err(),
            "subsequent writes on the same owner cannot revive deletion"
        );
        fs::write(fixture.history.records_path(), b"corrupt main").unwrap();
        let reopened = HistoryStore::open(fixture.history.root.clone()).unwrap();
        assert!(reopened.get("s-00000").is_err());
        assert!(reopened.get("s-00001").is_ok());
        assert!(reopened.get("s-00002").is_ok());
    }
    #[test]
    fn t05_deletion_selection_rejects_empty_overflow_hot_unknown_and_path_injection() {
        let fixture = retention_fixture(1, 1);
        for ids in [
            vec![],
            vec!["s-00000".into(); 21],
            vec!["../s-00000".into()],
            vec!["s-missing".into()],
            vec!["s-00001".into()],
        ] {
            let error = fixture
                .history
                .preview_archive_deletion(&ids, &Default::default(), &Default::default())
                .unwrap_err();
            assert!(
                matches!(
                    error.as_str(),
                    "Invalid deletion selection"
                        | "Session is not archived"
                        | "Unknown or unavailable archived session"
                ),
                "fixed refusal, received {error}"
            );
            assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        }
    }
    #[test]
    fn t05_preview_revalidation_refuses_restore_native_claim_and_notification_races() {
        for race in ["restore", "claim", "pending", "unread", "failed"] {
            let fixture = retention_fixture(1, 1);
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            let mut claims = std::collections::HashSet::new();
            if race == "restore" {
                fixture.history.restore_archive("s-00000").unwrap();
            } else if race == "claim" {
                claims.insert("native-0".into());
            } else {
                let path = fixture.history.root.join("archive/s-00000.json");
                let mut record = fixture.history.get("s-00000").unwrap();
                if race == "pending" {
                    record.notification_pending = true;
                } else {
                    record.agent.inbox.push(agent_events::AgentReceipt {
                        id: "r-race".into(),
                        revision: 1,
                        turn_id: "turn".into(),
                        kind: "response_finished".into(),
                        delivery: if race == "failed" { "failed" } else { "sent" }.into(),
                        read: race == "failed",
                        error: None,
                    });
                }
                archive_json(&path, &record, MAX_SESSION_HISTORY_BYTES).unwrap();
            }
            let error = fixture
                .history
                .confirm_archive_deletion(
                    preview["preview_id"].as_str().unwrap(),
                    &claims,
                    &Default::default(),
                )
                .unwrap_err();
            assert!(
                matches!(
                    error.as_str(),
                    "Deletion preview expired; preview again"
                        | "Session is being resumed"
                        | "Session has pending notifications"
                ),
                "{race}: {error}"
            );
            assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        }
    }
    #[test]
    fn t05_dirty_frame_or_log_and_restart_expire_the_exact_preview() {
        for race in ["frame", "log", "restart"] {
            let fixture = retention_fixture(1, 1);
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            let history = if race == "restart" {
                std::sync::Arc::new(HistoryStore::open(fixture.history.root.clone()).unwrap())
            } else {
                fixture.history.clone()
            };
            if race == "frame" {
                archive_atomic(&history.root.join("s-00000.frame.json"), b"replaced frame")
                    .unwrap();
            }
            if race == "log" {
                OpenOptions::new()
                    .append(true)
                    .open(history.log_path("s-00000"))
                    .unwrap()
                    .write_all(b"late output")
                    .unwrap();
            }
            assert_eq!(
                history
                    .confirm_archive_deletion(
                        preview["preview_id"].as_str().unwrap(),
                        &Default::default(),
                        &Default::default()
                    )
                    .unwrap_err(),
                "Deletion preview expired; preview again"
            );
            assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn t05_preview_rejects_links_public_files_and_corrupt_shards_without_touching_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for kind in ["log-link", "frame-link", "public", "corrupt", "wrong-id"] {
            let fixture = retention_fixture(1, 1);
            let shard = fixture.history.root.join("archive/s-00000.json");
            if kind.ends_with("link") {
                let path = if kind == "log-link" {
                    fixture.history.log_path("s-00000")
                } else {
                    fixture.history.root.join("s-00000.frame.json")
                };
                fs::remove_file(&path).unwrap();
                symlink(fixture.native.join("session.json"), &path).unwrap();
            } else if kind == "public" {
                fs::set_permissions(&shard, fs::Permissions::from_mode(0o644)).unwrap();
            } else if kind == "corrupt" {
                archive_atomic(&shard, b"corrupt").unwrap();
            } else {
                let mut record = fixture.history.get("s-00000").unwrap();
                record.summary.session_id = "s-wrong".into();
                archive_json(&shard, &record, MAX_SESSION_HISTORY_BYTES).unwrap();
            }
            let error = fixture
                .history
                .preview_archive_deletion(
                    &["s-00000".into()],
                    &Default::default(),
                    &Default::default(),
                )
                .unwrap_err();
            assert!(
                matches!(
                    error.as_str(),
                    "Unsafe deletion file"
                        | "Unknown or unavailable archived session"
                        | "Invalid archive record"
                ),
                "{kind}: {error}"
            );
            assert_eq!(
                fs::read(fixture.native.join("session.json")).unwrap(),
                b"native conversation must survive"
            );
            assert_fixture_intact(&fixture, &["s-00001"]);
        }
    }
    #[test]
    fn t05_delete_faults_recover_on_same_owner_and_restart_without_backup_resurrection() {
        for phase in [
            "transaction_sync",
            "files_staged",
            "manifest_sync",
            "backup_sync",
            "file_delete",
            "transaction_removed",
        ] {
            let fixture = retention_fixture(2, 1);
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            let result = fixture.history.delete_with_fault(
                preview["preview_id"].as_str().unwrap(),
                &Default::default(),
                &Default::default(),
                phase,
            );
            assert_eq!(
                result.unwrap_err(),
                format!("Injected deletion fault: {phase}")
            );
            if phase == "transaction_removed" {
                assert!(!fixture
                    .history
                    .root
                    .join("archive/transaction.json")
                    .exists());
            } else {
                assert!(
                    fixture
                        .history
                        .root
                        .join("archive/transaction.json")
                        .is_file(),
                    "diagnosable transaction remains at {phase}"
                );
            }
            fixture
                .history
                .update("s-00002", "failed", Some(1), None, None)
                .expect("same Arc owner must recover before writing another record");
            assert!(
                fixture.history.get("s-00000").is_err(),
                "same owner cannot revive deleted ID at {phase}"
            );
            assert_fixture_intact(&fixture, &["s-00001", "s-00002"]);
            fs::write(
                fixture.history.records_path(),
                b"corrupt main after recovery",
            )
            .unwrap();
            let reopened = HistoryStore::open(fixture.history.root.clone()).unwrap();
            assert!(reopened.get("s-00000").is_err());
            assert!(reopened.get("s-00001").is_ok());
            assert!(reopened.get("s-00002").is_ok());
        }
    }
    #[test]
    fn t05_delete_unpublished_transaction_preserves_same_owner_usability() {
        let fixture = retention_fixture(1, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let dir = fixture.history.archive_directory(false).unwrap();
        assert_eq!(
            fixture
                .history
                .delete_with_fault(
                    preview["preview_id"].as_str().unwrap(),
                    &Default::default(),
                    &Default::default(),
                    "transaction_publication"
                )
                .unwrap_err(),
            "Unsafe archive destination"
        );
        assert!(
            dir.join("transaction.json").is_dir(),
            "publication failed before a transaction file existed"
        );
        assert!(fixture.history.log_path("s-00000").is_file());
        assert_eq!(
            fs::read(fixture.native.join("session.json")).unwrap(),
            b"native conversation must survive"
        );
        fs::remove_dir(dir.join("transaction.json")).unwrap();
        fixture
            .history
            .update("s-00001", "failed", Some(1), None, None)
            .expect("same owner must not remain poisoned after unpublished transaction");
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[test]
    fn t05_batch_cancellation_after_one_archive_stops_remaining_records() {
        let fixture = retention_fixture(0, 8);
        fixture.history.set_retention_policy(true).unwrap();
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let ids = fixture
            .history
            .auto_archive_batch_checked(
                90 * 86400,
                &Default::default(),
                &Default::default(),
                Instant::now() + Duration::from_secs(2),
                &|| checks.fetch_add(1, Ordering::SeqCst) >= 1,
            )
            .unwrap();
        assert_eq!(
            ids.len(),
            1,
            "new RPC/active/shutdown revokes the batch before its next record"
        );
        assert_eq!(fixture.history.list().unwrap().len(), 7);
        assert_eq!(
            fixture
                .history
                .archive_page(Default::default())
                .unwrap()
                .items
                .len(),
            1
        );
    }
    #[test]
    fn t05_confirm_preflights_entire_set_before_staging_any_member() {
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000", "s-00001"]);
        let first_shard = fs::read(fixture.history.root.join("archive/s-00000.json")).unwrap();
        OpenOptions::new()
            .append(true)
            .open(fixture.history.log_path("s-00001"))
            .unwrap()
            .write_all(b"new data")
            .unwrap();
        assert_eq!(
            fixture
                .history
                .confirm_archive_deletion(
                    preview["preview_id"].as_str().unwrap(),
                    &Default::default(),
                    &Default::default()
                )
                .unwrap_err(),
            "Deletion preview expired; preview again"
        );
        assert_eq!(
            fs::read(fixture.history.root.join("archive/s-00000.json")).unwrap(),
            first_shard
        );
        assert!(!fixture
            .history
            .root
            .join("archive/transaction.json")
            .exists());
        assert_fixture_intact(&fixture, &["s-00000", "s-00001", "s-00002"]);
    }
    #[test]
    fn t05_absent_file_becomes_present_or_present_disappears_invalidates_preview() {
        for initially_present in [false, true] {
            let fixture = retention_fixture(1, 1);
            let frame = fixture.history.root.join("s-00000.frame.json");
            let bytes = fs::read(&frame).unwrap();
            if !initially_present {
                fs::remove_file(&frame).unwrap();
            }
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            if initially_present {
                fs::remove_file(&frame).unwrap();
            } else {
                archive_atomic(&frame, &bytes).unwrap();
            }
            assert_eq!(
                fixture
                    .history
                    .confirm_archive_deletion(
                        preview["preview_id"].as_str().unwrap(),
                        &Default::default(),
                        &Default::default()
                    )
                    .unwrap_err(),
                "Deletion preview expired; preview again"
            );
            assert!(fixture.history.get("s-00000").is_ok());
            assert!(fixture.history.get("s-00001").is_ok());
        }
    }
    #[test]
    fn t05_lost_response_retry_returns_committed_ids_without_deleting_another_record() {
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let token = preview["preview_id"].as_str().unwrap();
        let first = fixture
            .history
            .confirm_archive_deletion(token, &Default::default(), &Default::default())
            .unwrap();
        let retry = fixture
            .history
            .confirm_archive_deletion(token, &Default::default(), &Default::default())
            .unwrap();
        assert_eq!(first, ["s-00000"]);
        assert_eq!(retry, first);
        assert!(fixture.history.get("s-00000").is_err());
        assert_fixture_intact(&fixture, &["s-00001", "s-00002"]);
    }
    #[test]
    fn t05_manifest_change_and_expired_token_require_a_new_preview() {
        for expiry in [false, true] {
            let fixture = retention_fixture(1, 2);
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            if expiry {
                let path = fixture.history.root.join("archive/deletion-preview.json");
                let mut stored: serde_json::Value = archive_read(&path, 128 * 1024).unwrap();
                stored["expires_at"] = 0.into();
                archive_json(&path, &stored, 128 * 1024).unwrap();
            } else {
                archive_one(&fixture.history, "s-00001").unwrap();
            }
            assert_eq!(
                fixture
                    .history
                    .confirm_archive_deletion(
                        preview["preview_id"].as_str().unwrap(),
                        &Default::default(),
                        &Default::default()
                    )
                    .unwrap_err(),
                "Deletion preview expired; preview again"
            );
            assert_fixture_intact(&fixture, &["s-00000", "s-00001", "s-00002"]);
        }
    }
    #[test]
    fn t05_archived_record_with_hot_duplicate_or_active_finalizer_is_not_deleted() {
        for duplicate in [false, true] {
            let fixture = retention_fixture(1, 1);
            let preview = deletion_preview(&fixture.history, &["s-00000"]);
            let mut active = std::collections::HashSet::new();
            if duplicate {
                fixture
                    .history
                    .records
                    .lock()
                    .unwrap()
                    .push(fixture.history.archive_record("s-00000").unwrap());
            } else {
                active.insert("s-00000".into());
            }
            let error = fixture
                .history
                .confirm_archive_deletion(
                    preview["preview_id"].as_str().unwrap(),
                    &Default::default(),
                    &active,
                )
                .unwrap_err();
            assert!(matches!(
                error.as_str(),
                "Deletion preview expired; preview again" | "Session is still finalizing"
            ));
            assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn t05_hardlink_fifo_parent_link_and_writable_parent_refuse_deletion() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{symlink, PermissionsExt};
        for dirty in ["hardlink", "fifo", "parent-link", "parent-mode"] {
            let fixture = retention_fixture(1, 1);
            if dirty == "hardlink" {
                fs::hard_link(
                    fixture.history.log_path("s-00000"),
                    fixture.native.join("shared-log"),
                )
                .unwrap();
            } else if dirty == "fifo" {
                let path = fixture.history.log_path("s-00000");
                fs::remove_file(&path).unwrap();
                let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            } else if dirty == "parent-link" {
                fs::rename(
                    fixture.history.root.join("archive"),
                    fixture.history.root.join("real-archive"),
                )
                .unwrap();
                symlink("real-archive", fixture.history.root.join("archive")).unwrap();
            } else {
                fs::set_permissions(&fixture.history.root, fs::Permissions::from_mode(0o777))
                    .unwrap();
            }
            let started = Instant::now();
            let error = fixture
                .history
                .preview_archive_deletion(
                    &["s-00000".into()],
                    &Default::default(),
                    &Default::default(),
                )
                .unwrap_err();
            assert!(
                matches!(
                    error.as_str(),
                    "Unsafe deletion file"
                        | "Unsafe archive directory"
                        | "Unknown or unavailable archived session"
                ),
                "{dirty}: {error}"
            );
            assert!(started.elapsed() < Duration::from_secs(1));
            assert_eq!(
                fs::read(fixture.native.join("session.json")).unwrap(),
                b"native conversation must survive"
            );
        }
    }
    #[test]
    fn t05_open_handle_path_swap_before_rename_is_refused_without_deleting_replacement() {
        let fixture = retention_fixture(1, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let path = fixture.history.log_path("s-00000");
        let held = fixture.native.join("original-log");
        let result = fixture.history.delete_with_hook(
            preview["preview_id"].as_str().unwrap(),
            &Default::default(),
            &Default::default(),
            || {
                fs::rename(&path, &held).unwrap();
                archive_atomic(&path, b"unrelated replacement").unwrap();
            },
        );
        assert_eq!(
            result.unwrap_err(),
            "Deletion preview expired; preview again"
        );
        assert_eq!(fs::read(&path).unwrap(), b"unrelated replacement");
        assert!(held.is_file());
        assert!(fixture.history.get("s-00000").is_ok());
        assert_fixture_intact(&fixture, &["s-00001"]);
    }
    #[cfg(unix)]
    #[test]
    fn t05_parent_directory_replacement_after_preview_invalidates_file_ownership() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = retention_fixture(1, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let dir = fixture.history.root.join("archive");
        let old = fixture.history.root.join("old-archive");
        fs::rename(&dir, &old).unwrap();
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        for entry in fs::read_dir(&old).unwrap() {
            let entry = entry.unwrap();
            fs::rename(entry.path(), dir.join(entry.file_name())).unwrap();
        }
        assert_eq!(
            fixture
                .history
                .confirm_archive_deletion(
                    preview["preview_id"].as_str().unwrap(),
                    &Default::default(),
                    &Default::default()
                )
                .unwrap_err(),
            DELETE_EXPIRED
        );
        assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
    }
    #[test]
    fn t05_partial_receipt_reports_only_completed_ids_before_same_owner_recovery() {
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000", "s-00001"]);
        let token = preview["preview_id"].as_str().unwrap();
        let result = fixture
            .history
            .delete_operation(
                token,
                &Default::default(),
                &Default::default(),
                "receipt_sync",
                || {},
            )
            .unwrap();
        assert!(!result.complete);
        assert_eq!(result.deleted_ids, vec!["s-00000"]);
        assert_eq!(result.issues, vec!["Injected deletion fault: receipt_sync"]);
        let stage = fixture.history.root.join("archive/delete-staging");
        assert!(!staged_path(&stage, "s-00000", &DeleteRole::Shard).exists());
        assert!(staged_path(&stage, "s-00001", &DeleteRole::Shard).is_file());
        fixture
            .history
            .update("s-00002", "failed", Some(1), None, None)
            .unwrap();
        let retry = fixture
            .history
            .delete_result(token, &Default::default(), &Default::default())
            .unwrap();
        assert!(retry.complete);
        assert_eq!(retry.deleted_ids, vec!["s-00000", "s-00001"]);
        assert_fixture_intact(&fixture, &["s-00002"]);
    }
    #[test]
    fn t05_review_f1_overview_returns_bounded_actual_receipt_after_owner_recovery() {
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000", "s-00001"]);
        let token = preview["preview_id"].as_str().unwrap();
        let partial = fixture
            .history
            .delete_operation(
                token,
                &Default::default(),
                &Default::default(),
                "receipt_sync",
                || {},
            )
            .unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.deleted_ids, vec!["s-00000"]);
        let overview = serde_json::to_value(fixture.history.overview().unwrap()).unwrap();
        assert_eq!(
            overview["latest_deletion"]["deleted_ids"],
            serde_json::json!(["s-00000", "s-00001"])
        );
        assert_eq!(overview["latest_deletion"]["preview_id"], token);
        assert_eq!(overview["latest_deletion"]["complete"], true);
        assert!(!fixture
            .history
            .root
            .join("archive/transaction.json")
            .exists());
        assert_fixture_intact(&fixture, &["s-00002"]);
        assert_eq!(
            serde_json::to_value(fixture.history.overview().unwrap()).unwrap()["latest_deletion"],
            overview["latest_deletion"],
            "repeated read-only refresh does not start another deletion"
        );
    }
    #[test]
    fn t05_review_f1_overview_rejects_untrusted_or_unbounded_receipt_fields() {
        let fixture = retention_fixture(1, 1);
        let path = fixture.history.root.join("archive/last-deletion.json");
        for value in [
            serde_json::json!({"preview_id":"../s-token","deleted_ids":["s-00000"],"complete":true,"issues":[]}),
            serde_json::json!({"preview_id":"s-token","deleted_ids":["s-00000","s-00000"],"complete":true,"issues":[]}),
            serde_json::json!({"preview_id":"s-token","deleted_ids":["../s-other"],"complete":true,"issues":[]}),
            serde_json::json!({"preview_id":"s-token","deleted_ids":(0..21).map(|i|format!("s-{i}")).collect::<Vec<_>>(),"complete":true,"issues":[]}),
            serde_json::json!({"preview_id":"s-token","deleted_ids":[],"complete":true,"issues":[],"private_path":"/secret"}),
            serde_json::json!({"preview_id":"s-token","deleted_ids":[],"complete":true,"issues":["private content"]}),
        ] {
            archive_json(&path, &value, 64 * 1024).unwrap();
            assert_eq!(
                fixture.history.overview().unwrap_err(),
                "Invalid deletion receipt"
            );
            assert_fixture_intact(&fixture, &["s-00000", "s-00001"]);
        }
    }
    #[test]
    fn t05_retained_log_tail_can_be_smaller_than_cumulative_output_offset() {
        let fixture = retention_fixture(1, 1);
        archive_atomic(&fixture.history.log_path("s-00000"), b"tail").unwrap();
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let result = fixture
            .history
            .delete_result(
                preview["preview_id"].as_str().unwrap(),
                &Default::default(),
                &Default::default(),
            )
            .unwrap();
        assert!(result.complete);
        assert_eq!(result.deleted_ids, vec!["s-00000"]);
        assert_fixture_intact(&fixture, &["s-00001"]);
    }
    #[cfg(unix)]
    #[test]
    fn t05_real_open_options_legacy_readable_log_is_owned_but_shared_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        for mode in [0o644, 0o664] {
            let fixture = retention_fixture(1, 1);
            let path = fixture.history.log_path("s-00000");
            let data = fs::read(&path).unwrap();
            fs::remove_file(&path).unwrap();
            let mut log = OpenOptions::new()
                .create(true)
                .read(true)
                .append(true)
                .open(&path)
                .unwrap();
            log.write_all(&data).unwrap();
            log.sync_all().unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            let result = fixture.history.preview_archive_deletion(
                &["s-00000".into()],
                &Default::default(),
                &Default::default(),
            );
            if mode == 0o644 {
                let preview = result.expect(
                    "logs created by the existing session path remain deletable without chmod",
                );
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o644
                );
                assert!(
                    fixture
                        .history
                        .delete_result(
                            preview["preview_id"].as_str().unwrap(),
                            &Default::default(),
                            &Default::default()
                        )
                        .unwrap()
                        .complete
                );
            } else {
                assert_eq!(result.unwrap_err(), "Unsafe deletion file");
                assert_eq!(fs::read(&path).unwrap(), data);
            }
            assert_fixture_intact(&fixture, &["s-00001"]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn t05_staging_permission_failure_retains_transaction_and_remaining_records() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = retention_fixture(2, 1);
        let preview = deletion_preview(&fixture.history, &["s-00000"]);
        let dir = fixture.history.archive_directory(false).unwrap();
        let result = fixture.history.delete_with_hook(
            preview["preview_id"].as_str().unwrap(),
            &Default::default(),
            &Default::default(),
            || {
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
            },
        );
        assert_eq!(result.unwrap_err(), "Deletion storage operation failed");
        assert!(dir.join("transaction.json").is_file());
        assert!(dir.join("s-00000.json").is_file());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        fixture
            .history
            .update("s-00002", "failed", Some(1), None, None)
            .unwrap();
        assert_fixture_intact(&fixture, &["s-00001", "s-00002"]);
    }

    fn archive_fixture(count: usize) -> HistoryStore {
        let history = store(count);
        history
            .save_locked(&history.records.lock().unwrap())
            .unwrap();
        history
    }
    fn archive_one(history: &HistoryStore, id: &str) -> Result<(), String> {
        history.archive(id, &Default::default(), &Default::default())
    }
    #[test]
    fn t04_archive_restore_preserves_by_id_record_unicode_logs_and_frame_paths() {
        let history = archive_fixture(1);
        let before = serde_json::to_value(history.get("s-00000").unwrap()).unwrap();
        let log = history.root.join("s-00000.log");
        let frame = history.root.join("s-00000.frame.json");
        fs::write(&log, "中文 😀 log\n").unwrap();
        fs::write(&frame, b"saved final frame").unwrap();
        assert!(
            archive_one(&history, "s-00000").is_ok(),
            "completed record must archive"
        );
        assert!(history.list().unwrap().is_empty());
        assert_eq!(
            serde_json::to_value(history.get("s-00000").unwrap()).unwrap(),
            before
        );
        assert_eq!(fs::read_to_string(&log).unwrap(), "中文 😀 log\n");
        assert_eq!(fs::read(&frame).unwrap(), b"saved final frame");
        assert_eq!(
            history.archive_page(Default::default()).unwrap().items[0]
                .summary
                .session_id,
            "s-00000"
        );
        history.restore_archive("s-00000").unwrap();
        assert_eq!(history.list().unwrap().len(), 1);
        assert!(history
            .archive_page(Default::default())
            .unwrap()
            .items
            .is_empty());
        assert!(
            history.restore_archive("s-00000").is_err(),
            "restore cannot duplicate a hot ID"
        );
        fs::write(history.records_path(), b"corrupt immediately after restore").unwrap();
        let reopened = HistoryStore::open(history.root.clone()).unwrap();
        assert_eq!(
            reopened.list().unwrap().len(),
            1,
            "recoverable backup preserves the completed restore"
        );
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_rejects_active_attention_unknown_unread_and_pending_delivery() {
        let history = archive_fixture(1);
        let original = history.get("s-00000").unwrap();
        for status in ["running", "starting", "needs_attention", "unknown"] {
            history.records.lock().unwrap()[0].status = status.into();
            assert_eq!(
                archive_one(&history, "s-00000").unwrap_err(),
                "Session is not eligible for archive"
            );
            assert_eq!(history.list().unwrap().len(), 1);
        }
        history.records.lock().unwrap()[0] = original.clone();
        history.records.lock().unwrap()[0].notification_pending = true;
        assert_eq!(
            archive_one(&history, "s-00000").unwrap_err(),
            "Session has pending notifications"
        );
        for (delivery, read) in [("sent", false), ("pending", true), ("failed", true)] {
            let mut record = original.clone();
            record.agent.inbox.push(agent_events::AgentReceipt {
                id: "receipt".into(),
                revision: 1,
                turn_id: "turn".into(),
                kind: "response_finished".into(),
                delivery: delivery.into(),
                read,
                error: None,
            });
            history.records.lock().unwrap()[0] = record;
            assert_eq!(
                archive_one(&history, "s-00000").unwrap_err(),
                "Session has pending notifications",
                "read=true does not consume failed or pending delivery"
            );
        }
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_rejects_native_claim_and_inflight_final_frame() {
        let history = archive_fixture(1);
        history.records.lock().unwrap()[0].agent.agent_session_id =
            Some("12345678-1234-1234-1234-123456789abc".into());
        let claims = ["12345678-1234-1234-1234-123456789abc".to_string()]
            .into_iter()
            .collect();
        assert_eq!(
            history
                .archive("s-00000", &claims, &Default::default())
                .unwrap_err(),
            "Session is being resumed"
        );
        let active = ["s-00000".to_string()].into_iter().collect();
        assert_eq!(
            history
                .archive("s-00000", &Default::default(), &active)
                .unwrap_err(),
            "Session is still finalizing"
        );
        assert_eq!(history.list().unwrap().len(), 1);
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_manifest_pages_are_bounded_and_stale_cursors_expire() {
        let history = archive_fixture(101);
        for index in 0..101 {
            archive_one(&history, &format!("s-{index:05}")).unwrap();
        }
        let first = history.archive_page(Default::default()).unwrap();
        assert_eq!(first.items.len(), 100);
        let cursor = first.next_cursor.unwrap();
        let second = history
            .archive_page(PageRequest {
                cursor: Some(cursor.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.is_none());
        assert_ne!(
            first.items[0].summary.session_id,
            second.items[0].summary.session_id
        );
        history
            .restore_archive(&second.items[0].summary.session_id)
            .unwrap();
        assert!(history
            .archive_page(PageRequest {
                cursor: Some(cursor),
                ..Default::default()
            })
            .unwrap_err()
            .contains("expired"));
        for size in [0, 101, usize::MAX] {
            assert!(history
                .archive_page(PageRequest {
                    page_size: Some(size),
                    ..Default::default()
                })
                .is_err());
        }
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_cursor_isolated_from_hot_and_unrelated_hot_events() {
        let history = archive_fixture(203);
        let hot_cursor = history
            .page(Default::default())
            .unwrap()
            .next_cursor
            .unwrap();
        assert!(history
            .archive_page(PageRequest {
                cursor: Some(hot_cursor),
                ..Default::default()
            })
            .is_err());
        for index in 0..101 {
            archive_one(&history, &format!("s-{index:05}")).unwrap();
        }
        let archive_cursor = history
            .archive_page(Default::default())
            .unwrap()
            .next_cursor
            .unwrap();
        assert!(history
            .page(PageRequest {
                cursor: Some(archive_cursor.clone()),
                ..Default::default()
            })
            .is_err());
        history
            .update("s-00202", "failed", Some(1), None, None)
            .unwrap();
        assert_eq!(
            history
                .archive_page(PageRequest {
                    cursor: Some(archive_cursor),
                    ..Default::default()
                })
                .unwrap()
                .items
                .len(),
            1
        );
        fs::remove_dir_all(history.root).unwrap();
    }
    fn archive_shard(history: &HistoryStore, id: &str) -> PathBuf {
        let mut dirs = vec![history.root.join("archive")];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    dirs.push(path);
                } else if kind.is_file() {
                    if let Ok(record) =
                        serde_json::from_slice::<SessionRecord>(&fs::read(&path).unwrap())
                    {
                        if record.summary.session_id == id {
                            return path;
                        }
                    }
                }
            }
        }
        panic!("published archive shard exists for {id}");
    }
    #[test]
    fn t04_archive_read_rejects_corrupt_and_oversized_shards_without_hot_changes() {
        for malformed in ["corrupt", "oversized"] {
            let history = archive_fixture(2);
            archive_one(&history, "s-00000").unwrap();
            let path = archive_shard(&history, "s-00000");
            if malformed == "corrupt" {
                fs::write(path, b"corrupt JSON").unwrap();
            } else {
                OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_len(MAX_SESSION_HISTORY_BYTES + 1)
                    .unwrap();
            }
            let before = fs::read(history.records_path()).unwrap();
            assert!(history.get("s-00000").is_err());
            assert!(history.restore_archive("s-00000").is_err());
            assert_eq!(fs::read(history.records_path()).unwrap(), before);
            fs::remove_dir_all(history.root).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn t04_archive_read_refuses_symlink_shards_and_keeps_private_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let history = archive_fixture(2);
        archive_one(&history, "s-00000").unwrap();
        let path = archive_shard(&history, "s-00000");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let external = history.root.join("outside.json");
        fs::rename(&path, &external).unwrap();
        let before = fs::read(&external).unwrap();
        symlink(&external, &path).unwrap();
        assert!(history.get("s-00000").is_err());
        assert!(history.restore_archive("s-00000").is_err());
        assert_eq!(fs::read(external).unwrap(), before);
        assert_eq!(history.list().unwrap().len(), 1);
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_real_backend_search_continues_all_513_hot_and_archived_sources_and_expires_context() {
        let history = archive_fixture(513);
        for index in 0..513 {
            fs::write(
                history.log_path(&format!("s-{index:05}")),
                if index == 0 {
                    "中文 😀 archived hit\n"
                } else {
                    "empty\n"
                },
            )
            .unwrap();
        }
        for index in 0..260 {
            archive_one(&history, &format!("s-{index:05}")).unwrap();
        }
        ARCHIVE_SHARD_READS.with(|reads| reads.set(0));
        let sessions = Mutex::new(Default::default());
        let mut cursor = serde_json::Value::Null;
        let mut hits = Vec::new();
        let mut pages = 0;
        loop {
            let request=serde_json::from_value(serde_json::json!({"query":"中文 😀","case_sensitive":true,"skip":0,"limit":50,"source_cursor":cursor})).unwrap();
            let page =
                super::super::search_retained_logs(&history, &sessions, None, request, || false)
                    .unwrap();
            pages += 1;
            assert!(pages <= 3);
            let value = serde_json::to_value(page).unwrap();
            hits.extend(value["hits"].as_array().unwrap().iter().cloned());
            if value["next_cursor"].is_null() {
                break;
            }
            cursor = value["next_cursor"].clone();
        }
        ARCHIVE_SHARD_READS.with(|reads|assert_eq!(reads.get(),0,"global scanning must use bounded manifest metadata, never full 32 MiB record shards"));
        assert_eq!(pages, 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["session_id"], "s-00000");
        assert_eq!(hits[0]["text"], "中文 😀 archived hit");
        let changed=serde_json::from_value(serde_json::json!({"query":"other","case_sensitive":true,"skip":0,"limit":50,"source_cursor":cursor})).unwrap();
        assert!(
            super::super::search_retained_logs(&history, &sessions, None, changed, || false)
                .unwrap_err()
                .contains("expired")
        );
        let next=serde_json::from_value(serde_json::json!({"query":"中文 😀","case_sensitive":true,"skip":0,"limit":50,"source_cursor":cursor})).unwrap();
        let extra = history.get("s-00512").unwrap().summary;
        let mut new = extra;
        new.session_id = "s-added".into();
        history.start(&new).unwrap();
        assert!(
            super::super::search_retained_logs(&history, &sessions, None, next, || false)
                .unwrap_err()
                .contains("expired")
        );
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_native_resume_saved_scene_and_retained_excerpt_use_id_fallback() {
        let history = archive_fixture(1);
        let native = "01a0f6ec-5463-78c3-a404-5a7ad3b933fe";
        {
            let mut records = history.records.lock().unwrap();
            let record = &mut records[0];
            record.summary.cwd = history.root.to_string_lossy().into();
            record.summary.command = None;
            record.summary.launch = Some(super::super::AgentLaunch {
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: Some("never replay".into()),
            });
            record.agent.generation = "trusted-launch".into();
            record.agent.agent_session_id = Some(native.into());
            record.output_end_offset = 42;
            history.save_locked(&records).unwrap();
        }
        let frame = serde_json::json!({"projection":{"version":1,"instance":"a".repeat(64),"session":"s-00000","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":0,"data":"中文 😀 ALT","cols":20,"rows":8,"cursorX":3,"viewport":0,"buffer":"alternate"},"end_offset":42,"status":"succeeded"});
        let path = history.root.join("s-00000.frame.json");
        super::super::background::private_file(&path, true)
            .unwrap()
            .write_all(&serde_json::to_vec(&frame).unwrap())
            .unwrap();
        fs::write(history.log_path("s-00000"), "中文 😀 retained\n").unwrap();
        let claims = std::sync::Arc::new(Mutex::new(Default::default()));
        let (_, claim) =
            super::super::claim_resume_source(&history, claims.clone(), "s-00000").unwrap();
        assert_eq!(
            history
                .archive("s-00000", &claims.lock().unwrap(), &Default::default())
                .unwrap_err(),
            "Session is being resumed"
        );
        assert!(super::super::claim_resume_source(&history, claims.clone(), "s-00000").is_err());
        drop(claim);
        archive_one(&history, "s-00000").unwrap();
        let reopened = HistoryStore::open(history.root.clone()).unwrap();
        assert!(reopened.list().unwrap().is_empty());
        let (_, launch, id) = super::super::resume_source(&reopened, "s-00000").unwrap();
        assert_eq!(id, native);
        assert_eq!(launch.prompt, None);
        let record = reopened.get("s-00000").unwrap();
        let bytes = super::super::saved_frame_bytes(&path).unwrap().unwrap();
        let restored = super::super::decode_saved_frame(
            &bytes,
            "s-00000",
            &record.status,
            record.output_end_offset,
        )
        .unwrap();
        assert!(restored.persisted);
        assert_eq!(restored.projection["data"], "中文 😀 ALT");
        let log = super::super::recorded_log(&reopened, &Mutex::new(Default::default()), &record)
            .unwrap();
        assert_eq!(log.data, "中文 😀 retained\n");
        assert!(super::super::session_logs::excerpt(&log, log.offset, 0)
            .unwrap()
            .contains("中文 😀"));
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_restore_faults_recover_one_complete_copy_and_never_revive_archive_from_backup() {
        for stage in [
            "transaction_sync",
            "hot_rename",
            "hot_directory_sync",
            "manifest_sync",
            "transaction_done",
        ] {
            let history = archive_fixture(2);
            archive_one(&history, "s-00000").unwrap();
            let before = serde_json::to_value(history.get("s-00000").unwrap()).unwrap();
            assert_eq!(
                history
                    .restore_archive_with_fault("s-00000", stage)
                    .unwrap_err(),
                format!("Injected archive fault: {stage}")
            );
            assert!(history.archive_pending.load(Ordering::Acquire));
            assert!(history
                .update("s-00001", "failed", Some(1), None, None)
                .is_ok());
            let reopened = HistoryStore::open(history.root.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(reopened.get("s-00000").unwrap()).unwrap(),
                before
            );
            let hot = reopened
                .list()
                .unwrap()
                .iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count();
            let archived = reopened
                .archive_page(Default::default())
                .unwrap()
                .items
                .iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count();
            assert_eq!(hot + archived, 1);
            reopened
                .update("s-00001", "failed", Some(1), None, None)
                .unwrap();
            fs::write(reopened.records_path(), b"corrupt").unwrap();
            let recovered_backup = HistoryStore::open(history.root.clone()).unwrap();
            let hot = recovered_backup
                .list()
                .unwrap()
                .iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count();
            let archived = recovered_backup
                .archive_page(Default::default())
                .unwrap()
                .items
                .iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count();
            assert_eq!(hot + archived, 1);
            assert!(recovered_backup.get("s-00000").is_ok());
            fs::remove_dir_all(history.root).unwrap();
        }
    }
    #[test]
    fn t04_restore_recovery_over_budget_fails_before_exposing_history() {
        let history = archive_fixture(2);
        history.records.lock().unwrap()[0].summary.command = Some("a".repeat(1024 * 1024));
        history
            .save_locked(&history.records.lock().unwrap())
            .unwrap();
        archive_one(&history, "s-00000").unwrap();
        assert_eq!(
            history
                .restore_archive_with_fault("s-00000", "transaction_sync")
                .unwrap_err(),
            "Injected archive fault: transaction_sync"
        );
        // Read durable hot state directly: a public read now recovers the same owner first.
        let mut hot: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        hot[0].summary.command = Some("b".repeat(MAX_SESSION_HISTORY_BYTES as usize - 4096));
        fs::write(
            history.records_path(),
            serde_json::to_vec_pretty(&hot).unwrap(),
        )
        .unwrap();
        assert!(
            HistoryStore::open(history.root.clone()).is_err(),
            "recover must enforce the hot budget before exposing bridge/history"
        );
        fs::remove_dir_all(history.root).unwrap();
    }
    fn same_owner_continues(history: &std::sync::Arc<HistoryStore>, archived: bool) {
        history
            .update(
                "s-00001",
                "failed",
                Some(1),
                Some("continued on same owner".into()),
                Some(7),
            )
            .expect("same cached owner must recover and continue normal lifecycle writes");
        assert!(history.get("s-00001").unwrap().notification_pending);
        history
            .acknowledge_notification("s-00001", "failed")
            .expect("notification receipt persists on the same owner");
        assert!(!history.get("s-00001").unwrap().notification_pending);
        history
            .configure_agent("s-00002", "same-owner-generation")
            .expect("agent event mutation persists on the same owner");
        assert_eq!(
            history.get("s-00002").unwrap().agent.generation,
            "same-owner-generation"
        );
        let disk: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        let memory = history.list().unwrap();
        let disk_ids = disk
            .iter()
            .map(|r| r.summary.session_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let memory_ids = memory
            .iter()
            .map(|r| r.summary.session_id.clone())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            disk_ids, memory_ids,
            "same-instance cache and disk must agree before subsequent writers"
        );
        assert_eq!(
            disk_ids.contains("s-00000"),
            !archived,
            "subsequent normal writes must not revive archived A"
        );
        assert_eq!(
            history
                .archive_page(Default::default())
                .unwrap()
                .items
                .iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count(),
            usize::from(archived)
        );
        assert_eq!(history.get("s-00000").unwrap().status, "succeeded");
    }
    #[test]
    fn t04_review_f1_same_owner_recovers_when_transaction_publication_never_created_a_file() {
        let history = std::sync::Arc::new(archive_fixture(3));
        let dir = history.archive_directory(true).unwrap();
        let before = fs::read(history.records_path()).unwrap();
        assert_eq!(
            history
                .archive_with_fault("s-00000", "transaction_publication")
                .unwrap_err(),
            "Unsafe archive destination"
        );
        assert_eq!(fs::read(history.records_path()).unwrap(), before);
        assert!(
            fs::symlink_metadata(dir.join("transaction.json"))
                .unwrap()
                .is_dir(),
            "txn publication actually failed before a txn file existed"
        );
        fs::remove_dir(dir.join("transaction.json")).unwrap();
        same_owner_continues(&history, false);
        fs::remove_dir_all(&history.root).unwrap();
    }
    #[test]
    fn t04_review_f1_same_owner_recovers_effective_hot_rename_without_reopening_gui() {
        let history = std::sync::Arc::new(archive_fixture(3));
        let mut request = PageRequest {
            page_size: Some(1),
            ..Default::default()
        };
        request.cursor = history.page(request.clone()).unwrap().next_cursor;
        let catalog = history.log_source_batch(0, &|| false).unwrap().snapshot;
        assert_eq!(
            history
                .archive_with_fault("s-00000", "hot_directory_sync")
                .unwrap_err(),
            "Injected archive fault: hot_directory_sync"
        );
        let disk: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        assert!(disk.iter().all(|r| r.summary.session_id != "s-00000"));
        assert!(history.root.join("archive/transaction.json").is_file());
        history
            .list()
            .expect("read guard recovers the same owner before exposing records");
        assert!(
            history.page(request).unwrap_err().contains("expired"),
            "recovery invalidates a hot page even before the subsequent lifecycle write"
        );
        assert_ne!(
            history.log_source_batch(0, &|| false).unwrap().snapshot,
            catalog,
            "recovered membership changes the source catalog"
        );
        same_owner_continues(&history, true);
        assert!(!history.root.join("archive/transaction.json").exists());
        fs::remove_dir_all(&history.root).unwrap();
    }
    #[test]
    fn t04_review_f1_same_owner_recovers_after_transaction_unlink_before_directory_sync() {
        let history = std::sync::Arc::new(archive_fixture(3));
        assert_eq!(
            history
                .archive_with_fault("s-00000", "transaction_removed")
                .unwrap_err(),
            "Injected archive fault: transaction_removed"
        );
        assert!(
            !history.root.join("archive/transaction.json").exists(),
            "the injected failure occurs after txn unlink"
        );
        let disk: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        assert!(disk.iter().all(|r| r.summary.session_id != "s-00000"));
        let backup: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.root.join("sessions.json.bak")).unwrap())
                .unwrap();
        assert!(backup.iter().all(|r| r.summary.session_id != "s-00000"));
        same_owner_continues(&history, true);
        fs::remove_dir_all(&history.root).unwrap();
    }
    fn restore_same_owner_fault(stage: &str) {
        let history = std::sync::Arc::new(archive_fixture(3));
        archive_one(&history, "s-00000").unwrap();
        assert_eq!(
            history
                .restore_archive_with_fault("s-00000", stage)
                .unwrap_err(),
            format!("Injected archive fault: {stage}")
        );
        let disk: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
        assert_eq!(
            disk.iter()
                .filter(|r| r.summary.session_id == "s-00000")
                .count(),
            1
        );
        if stage == "transaction_removed" {
            assert!(!history.root.join("archive/transaction.json").exists());
        } else {
            assert!(history.root.join("archive/transaction.json").is_file());
        }
        same_owner_continues(&history, false);
        assert!(!history.root.join("archive/transaction.json").exists());
        fs::remove_dir_all(&history.root).unwrap();
    }
    #[test]
    fn t04_review_f1_same_owner_restore_recovers_effective_hot_rename() {
        restore_same_owner_fault("hot_directory_sync");
    }
    #[test]
    fn t04_review_f1_same_owner_restore_recovers_transaction_unlink_before_sync() {
        restore_same_owner_fault("transaction_removed");
    }
    fn archive_file_snapshot(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                assert!(entry.file_type().unwrap().is_file());
                (
                    entry.file_name().to_str().unwrap().to_owned(),
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }
    #[test]
    fn t04_review_f2_missing_root_rejects_new_archive_without_overwriting_existing_membership() {
        let history = archive_fixture(2);
        archive_one(&history, "s-00000").unwrap();
        let dir = history.root.join("archive");
        fs::rename(
            dir.join("root.json"),
            history.root.join("saved-archive-root.json"),
        )
        .unwrap();
        let before = archive_file_snapshot(&dir);
        let hot_before = fs::read(history.records_path()).unwrap();
        assert!(
            archive_one(&history, "s-00001").is_err(),
            "an absent root with existing archive files must never reset slot allocation to zero"
        );
        assert_eq!(
            archive_file_snapshot(&dir),
            before,
            "existing shard/index/page and archive directory contents remain unchanged"
        );
        assert_eq!(fs::read(history.records_path()).unwrap(), hot_before);
        fs::rename(
            history.root.join("saved-archive-root.json"),
            dir.join("root.json"),
        )
        .unwrap();
        assert_eq!(history.get("s-00000").unwrap().status, "succeeded");
        assert_eq!(
            history.archive_page(Default::default()).unwrap().items[0]
                .summary
                .session_id,
            "s-00000"
        );
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_review_f2_first_archive_initializes_an_empty_manifest_normally() {
        let history = archive_fixture(1);
        assert!(!history.root.join("archive").exists());
        archive_one(&history, "s-00000").unwrap();
        assert!(history.root.join("archive/root.json").is_file());
        assert_eq!(
            history
                .archive_page(Default::default())
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(history.get("s-00000").unwrap().status, "succeeded");
        fs::remove_dir_all(history.root).unwrap();
    }
    fn archive_fault(stage: &str) {
        let history = archive_fixture(2);
        let id = "s-00000";
        let before = serde_json::to_value(history.get(id).unwrap()).unwrap();
        assert_eq!(
            history.archive_with_fault(id, stage).unwrap_err(),
            format!("Injected archive fault: {stage}")
        );
        if matches!(
            stage,
            "hot_directory_sync" | "manifest_sync" | "transaction_done"
        ) {
            let disk: Vec<SessionRecord> =
                serde_json::from_slice(&fs::read(history.records_path()).unwrap()).unwrap();
            assert!(
                disk.iter().all(|r| r.summary.session_id != id),
                "hot rename must already be effective before directory-sync fault"
            );
        }

        if stage != "shard_sync" {
            assert!(
                history.archive_pending.load(Ordering::Acquire),
                "failed transaction remains pending until recovery"
            );
            assert!(
                history
                    .update("s-00001", "failed", Some(1), None, None)
                    .is_ok(),
                "same owner recovers before its next hot write"
            );
        }
        let reopened = HistoryStore::open(history.root.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(reopened.get(id).unwrap()).unwrap(),
            before,
            "restart retains the entire record"
        );
        let copies = reopened
            .list()
            .unwrap()
            .iter()
            .filter(|r| r.summary.session_id == id)
            .count()
            + reopened
                .archive_page(Default::default())
                .unwrap()
                .items
                .iter()
                .filter(|r| r.summary.session_id == id)
                .count();
        assert_eq!(copies, 1, "recovery membership must deduplicate by ID");
        assert!(reopened
            .update("s-00001", "failed", Some(1), None, None)
            .is_ok());
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_fault_shard_sync() {
        archive_fault("shard_sync");
    }
    #[test]
    fn t04_archive_fault_transaction_sync() {
        archive_fault("transaction_sync");
    }
    #[test]
    fn t04_archive_fault_hot_rename() {
        archive_fault("hot_rename");
    }
    #[test]
    fn t04_archive_fault_hot_directory_sync_after_effective_rename() {
        archive_fault("hot_directory_sync");
    }
    #[test]
    fn t04_archive_fault_manifest_sync() {
        archive_fault("manifest_sync");
    }
    #[test]
    fn t04_archive_fault_transaction_done() {
        archive_fault("transaction_done");
    }
    #[test]
    fn t04_archive_backup_recovery_cannot_resurrect_archived_record() {
        let history = archive_fixture(2);
        archive_one(&history, "s-00000").unwrap();
        // Corruption immediately after commit must not resurrect the pre-archive backup.
        let backup: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(history.root.join("sessions.json.bak")).unwrap())
                .unwrap();
        assert!(backup.iter().all(|r| r.summary.session_id != "s-00000"));
        fs::write(history.records_path(), b"corrupt main").unwrap();
        let reopened = HistoryStore::open(history.root.clone()).unwrap();
        assert!(reopened
            .list()
            .unwrap()
            .iter()
            .all(|r| r.summary.session_id != "s-00000"));
        assert_eq!(reopened.get("s-00000").unwrap().status, "succeeded");
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_restore_over_budget_preserves_archive_and_hot_records() {
        let history = archive_fixture(2);
        history.records.lock().unwrap()[0].summary.command = Some("a".repeat(1024 * 1024));
        history
            .save_locked(&history.records.lock().unwrap())
            .unwrap();
        archive_one(&history, "s-00000").unwrap();
        history.records.lock().unwrap()[0].summary.command =
            Some("b".repeat(MAX_SESSION_HISTORY_BYTES as usize - 4096));
        history
            .save_locked(&history.records.lock().unwrap())
            .unwrap();
        let before = fs::read(history.records_path()).unwrap();
        assert_eq!(
            history.restore_archive("s-00000").unwrap_err(),
            "Session history exceeds 32 MiB; archive more sessions before restoring"
        );
        assert_eq!(fs::read(history.records_path()).unwrap(), before);
        assert_eq!(
            history
                .archive_page(Default::default())
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(history.get("s-00000").is_ok());
        fs::remove_dir_all(history.root).unwrap();
    }
    #[test]
    fn t04_archive_rejects_oversize_shard_without_moving_hot_record() {
        let history = archive_fixture(1);
        history.records.lock().unwrap()[0].summary.command =
            Some("a".repeat(MAX_SESSION_HISTORY_BYTES as usize));
        assert_eq!(
            archive_one(&history, "s-00000").unwrap_err(),
            "Archive shard exceeds 32 MiB"
        );
        assert_eq!(history.list().unwrap().len(), 1);
        fs::remove_dir_all(history.root).unwrap();
    }

    fn store(count: usize) -> HistoryStore {
        let root = std::env::temp_dir().join(format!("yam-history-pages-{}", next_session_id()));
        let store = HistoryStore::open(root).unwrap();
        *store.records.lock().unwrap() = (0..count)
            .map(|index| SessionRecord {
                summary: SessionSummary {
                    session_id: format!("s-{index:05}"),
                    cwd: "/中文/😀".into(),
                    command: Some("secret command".into()),
                    status: "succeeded".into(),
                    launch: None,
                },
                status: "succeeded".into(),
                exit_code: Some(0),
                reason: None,
                started_at: index as u64,
                ended_at: Some(index as u64),
                output_end_offset: 0,
                notification_pending: false,
                agent: Default::default(),
            })
            .collect();
        store
    }
    #[test]
    fn history_pages_cover_empty_single_boundaries_and_ten_thousand_without_inbox() {
        for count in [0, 1, 100, 101, 10000] {
            let store = store(count);
            let mut request = PageRequest::default();
            let mut ids = Vec::new();
            loop {
                let page = store.page(request.clone()).unwrap();
                assert!(page.items.len() <= 100);
                let json = serde_json::to_value(&page).unwrap();
                for value in json["items"].as_array().unwrap() {
                    assert!(value["summary"].get("command").is_none());
                    assert!(value["summary"].get("launch").is_none());
                    assert!(value["agent"].get("inbox").is_none());
                }
                ids.extend(
                    page.items
                        .iter()
                        .map(|item| item.summary.session_id.clone()),
                );
                let Some(cursor) = page.next_cursor else {
                    break;
                };
                request.cursor = Some(cursor);
            }
            assert_eq!(ids.len(), count);
            let expected = (0..count)
                .rev()
                .map(|index| format!("s-{index:05}"))
                .collect::<Vec<_>>();
            assert_eq!(ids, expected);
            fs::remove_dir_all(store.root).unwrap();
        }
    }
    #[test]
    fn history_rejects_illegal_sizes_stale_query_and_changed_snapshot() {
        let store = store(201);
        for size in [0, 201, usize::MAX] {
            assert!(store
                .page(PageRequest {
                    page_size: Some(size),
                    ..Default::default()
                })
                .is_err());
        }
        assert_eq!(
            store
                .page(PageRequest {
                    page_size: Some(200),
                    ..Default::default()
                })
                .unwrap()
                .items
                .len(),
            200
        );
        let mut request = PageRequest {
            cursor: store.page(Default::default()).unwrap().next_cursor,
            ..Default::default()
        };
        request.query = "different".into();
        assert!(store.page(request.clone()).unwrap_err().contains("expired"));
        request.query.clear();
        store
            .update("s-00000", "failed", Some(1), None, None)
            .unwrap();
        assert!(store.page(request).unwrap_err().contains("expired"));
        assert!(store.get("missing").is_err());
        assert_eq!(store.get("s-00000").unwrap().status, "failed");
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_search_global_aliases_unicode_and_pending_keys_survive_acknowledgement() {
        let store = store(201);
        let page = store
            .page(PageRequest {
                query: "中文/😀".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items.len(), 100);
        let page = store
            .page(PageRequest {
                query: "renamed".into(),
                matched_session_ids: vec!["s-00000".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items[0].summary.session_id, "s-00000");
        let page = store
            .page(PageRequest {
                query: "project alias".into(),
                matched_project_paths: vec!["/中文/😀/".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items.len(), 100);
        {
            let mut records = store.records.lock().unwrap();
            for record in records.iter_mut() {
                record.notification_pending = true;
            }
            records[0].status = "needs_attention".into();
        }
        assert_eq!(store.overview().unwrap().total, 201);
        assert_eq!(store.overview().unwrap().attention_sessions, 1);
        assert_eq!(
            store.next_attention(None).unwrap().as_deref(),
            Some("s-00000")
        );
        let first = store.pending(100, None).unwrap();
        assert_eq!(first.items.len(), 100);
        store
            .acknowledge_notification(&first.items[0].session_id, &first.items[0].status)
            .unwrap();
        let second = store.pending(100, first.next_key).unwrap();
        assert_eq!(second.items.len(), 100);
        assert_eq!(second.items[0].session_id, "s-00100");
        assert!(store.pending(0, None).is_err());
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_instances_are_isolated_and_reopening_expires_old_cursors() {
        let first = store(101);
        let second = store(1);
        {
            let records = first.records.lock().unwrap();
            first.save_locked(&records).unwrap();
        }
        let cursor = first.page(Default::default()).unwrap().next_cursor;
        second
            .update("s-00000", "failed", Some(1), None, None)
            .unwrap();
        assert!(
            first
                .page(PageRequest {
                    cursor: cursor.clone(),
                    ..Default::default()
                })
                .is_ok(),
            "another store must not invalidate this store"
        );
        let reopened = HistoryStore::open(first.root.clone()).unwrap();
        assert!(reopened
            .page(PageRequest {
                cursor,
                ..Default::default()
            })
            .unwrap_err()
            .contains("expired"));
        fs::remove_dir_all(first.root).unwrap();
        fs::remove_dir_all(second.root).unwrap();
    }
    #[test]
    fn history_failed_save_keeps_record_and_cursor_valid() {
        let store = store(101);
        let cursor = store.page(Default::default()).unwrap().next_cursor;
        fs::create_dir(store.root.join("sessions.json.tmp")).unwrap();
        assert!(store
            .update("s-00000", "failed", Some(1), None, None)
            .is_err());
        assert_eq!(store.get("s-00000").unwrap().status, "succeeded");
        assert!(store
            .page(PageRequest {
                cursor,
                ..Default::default()
            })
            .is_ok());
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_cursor_context_stays_small_when_search_aliases_are_large() {
        let store = store(201);
        let aliases = (0..10000).map(|index| format!("s-{index:05}")).collect();
        let mut request = PageRequest {
            query: "alias".into(),
            matched_session_ids: aliases,
            ..Default::default()
        };
        let first = store.page(request.clone()).unwrap();
        let cursor = first.next_cursor.unwrap();
        assert!(
            cursor.context.len() <= 32,
            "cursor must not duplicate the alias payload"
        );
        request.cursor = Some(cursor);
        assert_eq!(store.page(request).unwrap().items.len(), 100);
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_failed_delivery_count_includes_the_101st_unread_receipt_outside_page_one() {
        let store = store(1);
        {
            let mut records = store.records.lock().unwrap();
            records[0].agent.inbox = (0..101)
                .map(|index| agent_events::AgentReceipt {
                    id: format!("r-{index}"),
                    revision: 1,
                    turn_id: "turn".into(),
                    kind: "response_finished".into(),
                    delivery: if index == 100 { "failed" } else { "sent" }.into(),
                    read: false,
                    error: None,
                })
                .collect();
        }
        let first = store.inbox(Default::default()).unwrap();
        assert_eq!(first.items.len(), 100);
        assert!(first
            .items
            .iter()
            .all(|item| item.receipt.delivery != "failed"));
        let overview = serde_json::to_value(store.overview().unwrap()).unwrap();
        assert_eq!(overview["failed_receipts"], 1);
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_global_inbox_attention_and_agent_writes_are_independent_of_loaded_page() {
        let store = store(201);
        {
            let mut records = store.records.lock().unwrap();
            let record = &mut records[0];
            record.status = "running".into();
            record.agent.inbox = (0..101)
                .map(|index| agent_events::AgentReceipt {
                    id: format!("r-{index}"),
                    revision: 1,
                    turn_id: "turn".into(),
                    kind: if index == 0 {
                        "needs_permission"
                    } else {
                        "response_finished"
                    }
                    .into(),
                    delivery: "sent".into(),
                    read: false,
                    error: None,
                })
                .collect();
        }
        let overview = store.overview().unwrap();
        assert_eq!(
            (
                overview.active,
                overview.unread_receipts,
                overview.attention_sessions
            ),
            (1, 101, 1)
        );
        assert_eq!(
            store
                .page(PageRequest {
                    status: "active".into(),
                    ..Default::default()
                })
                .unwrap()
                .items[0]
                .summary
                .session_id,
            "s-00000"
        );
        let first = store.inbox(Default::default()).unwrap();
        assert_eq!(first.items.len(), 100);
        assert!(first.next_cursor.is_some());
        let next = store
            .inbox(PageRequest {
                cursor: first.next_cursor.clone(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.items.len(), 1);
        assert_eq!(
            store.next_attention(Some("s-00000")).unwrap().as_deref(),
            Some("s-00000")
        );
        store.read_agent_receipt("s-00000", "r-0", 1).unwrap();
        assert_eq!(store.overview().unwrap().unread_receipts, 100);
        assert!(store
            .inbox(PageRequest {
                cursor: first.next_cursor,
                ..Default::default()
            })
            .unwrap_err()
            .contains("expired"));
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_agent_title_fallback_preserves_adapter_mode_and_empty_prompt_rules() {
        let store = store(1);
        {
            let mut records = store.records.lock().unwrap();
            records[0].summary.command = None;
            records[0].summary.launch = Some(super::super::AgentLaunch {
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: None,
            });
        }
        assert_eq!(
            store.page(Default::default()).unwrap().items[0]
                .summary
                .title,
            "codex · interactive"
        );
        {
            let mut records = store.records.lock().unwrap();
            records[0].summary.launch.as_mut().unwrap().prompt = Some(String::new());
            records[0].summary.command = Some("echo 中文 😀".into());
        }
        assert_eq!(
            store.page(Default::default()).unwrap().items[0]
                .summary
                .title,
            "echo 中文 😀"
        );
        {
            let mut records = store.records.lock().unwrap();
            records[0].summary.launch = None;
            records[0].summary.command = Some(String::new());
        }
        assert_eq!(
            store.page(Default::default()).unwrap().items[0]
                .summary
                .title,
            "Interactive shell"
        );
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_titles_are_unicode_bounded_and_protection_refuses_oversized_save() {
        let store = store(1);
        {
            let mut records = store.records.lock().unwrap();
            records[0].summary.launch = Some(super::super::AgentLaunch {
                adapter: "codex".into(),
                mode: "interactive".into(),
                extra_args: "PRIVATE_ARGV".into(),
                prompt: Some("😀".repeat(400)),
            });
            records[0].agent.agent_session_id = Some("PRIVATE_NATIVE_ID".into());
        }
        let page = store.page(Default::default()).unwrap();
        assert_eq!(page.items[0].summary.title.chars().count(), 200);
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("PRIVATE_ARGV"));
        assert!(!json.contains("PRIVATE_NATIVE_ID"));
        {
            let mut records = store.records.lock().unwrap();
            records[0].summary.command = Some("x".repeat(MAX_SESSION_HISTORY_BYTES as usize));
        }
        let before = store.revision.load(Ordering::Acquire);
        let records = store.records.lock().unwrap();
        assert!(store.save_locked(&records).unwrap_err().contains("budget"));
        assert_eq!(store.revision.load(Ordering::Acquire), before);
        drop(records);
        assert!(!store.records_path().exists());
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_capacity_observes_mid_scan_cancel_depth_and_single_scan_boundary() {
        let store = store(0);
        fs::create_dir_all(store.root.join("archive/a/b/c/d")).unwrap();
        fs::write(store.root.join("archive/a/b/c/d/part.json"), b"archive").unwrap();
        let scan = scan_capacity_with(
            &store.root,
            100,
            Instant::now() + Duration::from_secs(2),
            || false,
        )
        .unwrap();
        assert!(!scan.complete);
        assert!(scan.issues.contains(&"scan_limit".into()));
        let ticks = std::cell::Cell::new(0);
        assert!(scan_capacity_with(
            &store.root,
            100,
            Instant::now() + Duration::from_secs(2),
            || {
                ticks.set(ticks.get() + 1);
                ticks.get() > 1
            }
        )
        .unwrap_err()
        .contains("cancelled"));
        let guard = CAPACITY_LOCK.lock().unwrap();
        assert!(scan_capacity(&store.root).unwrap_err().contains("already"));
        drop(guard);
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_overview_exposes_exact_hot_metadata_size_without_scanning_other_files() {
        let store = store(0);
        let file = File::create(store.root.join("sessions.json")).unwrap();
        file.set_len(24 * 1024 * 1024).unwrap();
        let value = serde_json::to_value(store.overview().unwrap()).unwrap();
        assert_eq!(value["metadata_bytes"], 24 * 1024 * 1024);
        fs::remove_dir_all(store.root).unwrap();
    }
    #[test]
    fn history_capacity_classifies_cancels_and_reports_limits_and_io_failures() {
        let store = store(0);
        fs::create_dir(store.root.join("archive")).unwrap();
        for (name, bytes) in [
            ("sessions.json", 4),
            ("s-one.log", 5),
            ("s-one.frame.json", 6),
            ("sessions.json.bak", 7),
            ("archive/part.json", 8),
        ] {
            fs::write(store.root.join(name), vec![b' '; bytes]).unwrap();
        }
        let scan = scan_capacity_with(
            &store.root,
            100,
            Instant::now() + Duration::from_secs(2),
            || false,
        )
        .unwrap();
        assert!(scan.complete);
        assert_eq!(
            (
                scan.metadata_bytes,
                scan.log_bytes,
                scan.scene_bytes,
                scan.backup_bytes,
                scan.archive_bytes
            ),
            (4, 5, 6, 7, 8)
        );
        assert!(scan_capacity_with(
            &store.root,
            100,
            Instant::now() + Duration::from_secs(2),
            || true
        )
        .unwrap_err()
        .contains("cancelled"));
        assert!(
            !scan_capacity_with(
                &store.root,
                0,
                Instant::now() + Duration::from_secs(2),
                || false
            )
            .unwrap()
            .complete
        );
        assert!(
            !scan_capacity_with(&store.root, 100, Instant::now(), || false)
                .unwrap()
                .complete
        );
        assert_eq!(
            scan_capacity_with(
                &store.root.join("missing"),
                100,
                Instant::now() + Duration::from_secs(2),
                || false
            )
            .unwrap()
            .issues,
            vec!["storage_unavailable"]
        );
        fs::remove_dir_all(store.root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn history_capacity_never_follows_file_or_root_symlinks() {
        let store = store(0);
        let outside = store.root.with_extension("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.log"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, store.root.join("archive")).unwrap();
        let scan = scan_capacity_with(
            &store.root,
            100,
            Instant::now() + Duration::from_secs(2),
            || false,
        )
        .unwrap();
        assert_eq!(scan.log_bytes + scan.archive_bytes, 0);
        assert!(!scan.complete);
        let link = store.root.with_extension("link");
        std::os::unix::fs::symlink(&store.root, &link).unwrap();
        assert_eq!(
            scan_capacity_with(&link, 100, Instant::now() + Duration::from_secs(2), || {
                false
            })
            .unwrap()
            .issues,
            vec!["skipped_entry"]
        );
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(store.root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
