// Author: Jeff.Liu.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
const MAX_FILES: usize = 2048;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_STORED_BYTES: usize = 32 * 1024 * 1024;
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct BaselineInfo {
    id: String,
    root: String,
    captured_at: u64,
    files: usize,
    skipped: usize,
}
#[derive(Debug, serde::Serialize)]
struct Row {
    path: String,
    kind: String,
}
#[derive(Debug, serde::Serialize)]
struct Patch {
    path: String,
    text: String,
}
#[derive(Debug, serde::Serialize)]
pub(crate) struct Report {
    baseline: BaselineInfo,
    rows: Vec<Row>,
    skipped: usize,
    patch: Option<Patch>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Content {
    Text(String),
    Missing,
    Unavailable,
}
#[derive(Debug)]
struct Snapshot {
    root: PathBuf,
    stamp: (u64, u64),
    files: BTreeMap<String, Content>,
    untracked: BTreeSet<String>,
    bytes: usize,
}
struct Baseline {
    info: BaselineInfo,
    snapshot: Snapshot,
}
#[derive(Default)]
struct Store {
    entries: BTreeMap<String, Baseline>,
}
// shortcut: baselines stay in this GUI process; persist privately only if cross-restart comparison is requested.
static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
#[cfg(unix)]
fn root_stamp(root: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = crate::file_preview::open_root(root)?
        .metadata()
        .map_err(|_| "round_unavailable")?;
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(not(unix))]
fn root_stamp(_root: &Path) -> Result<(u64, u64), String> {
    Err("file_platform_unavailable".into())
}
fn content(root: &Path, path: &str) -> Result<Content, String> {
    match crate::project_files::read_snapshot(root, path) {
        Ok(Some(text)) => Ok(Content::Text(text)),
        Ok(None) => Ok(Content::Missing),
        Err(code) if code == "file_changed" => Err("round_capture_changed".into()),
        Err(code) if code == "file_platform_unavailable" => Err(code),
        Err(_) => Ok(Content::Unavailable),
    }
}
fn scoped_names(
    root: &Path,
    inventory: &crate::git_context::TrackedInventory,
    names: &[String],
) -> Result<BTreeSet<String>, String> {
    let prefix = root
        .strip_prefix(&inventory.root)
        .map_err(|_| "round_context_changed")?;
    Ok(names
        .iter()
        .filter_map(|name| Path::new(name).strip_prefix(prefix).ok())
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}
fn collect(
    root: &Path,
    extra: &BTreeSet<String>,
    after_read: impl FnOnce(),
) -> Result<Snapshot, String> {
    let deadline = Instant::now() + Duration::from_secs(6);
    let stamp = root_stamp(root)?;
    let inventory = crate::git_context::tracked_inventory(root)?;
    let mut paths = scoped_names(root, &inventory, &inventory.tracked)?;
    paths.extend(extra.iter().cloned());
    let untracked = scoped_names(root, &inventory, &inventory.untracked)?;
    if paths.len() > MAX_FILES || untracked.len() > MAX_FILES {
        return Err("round_limit".into());
    }
    let mut bytes = untracked.iter().map(String::len).sum::<usize>();
    let mut files = BTreeMap::new();
    for path in paths {
        if Instant::now() >= deadline {
            return Err("round_timeout".into());
        }
        let value = content(root, &path)?;
        bytes += path.len()
            + match &value {
                Content::Text(text) => text.len(),
                _ => 0,
            };
        if bytes > MAX_BYTES {
            return Err("round_limit".into());
        }
        files.insert(path, value);
    }
    after_read();
    for (path, before) in &files {
        if Instant::now() >= deadline {
            return Err("round_timeout".into());
        }
        if content(root, path)? != *before {
            return Err("round_capture_changed".into());
        }
    }
    if root_stamp(root)? != stamp {
        return Err("round_context_changed".into());
    }
    if crate::git_context::tracked_inventory(root)? != inventory {
        return Err("round_capture_changed".into());
    }
    if Instant::now() >= deadline {
        return Err("round_timeout".into());
    }
    Ok(Snapshot {
        root: root.into(),
        stamp,
        files,
        untracked,
        bytes,
    })
}
fn diff_text(before: &str, after: &str) -> Result<String, String> {
    if before == after {
        return Ok(String::new());
    }
    let shadow = crate::git_context::Shadow::new()?;
    shadow.write("before", before.as_bytes())?;
    shadow.write("after", after.as_bytes())?;
    let git = crate::find_executable("git").ok_or("git_missing")?;
    let git = crate::git_context::fixed_git(&git, &shadow.0)?;
    let env = vec![
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_ATTR_NOSYSTEM".into(), "1".into()),
    ];
    let mut budget = crate::git_context::Budget {
        deadline: Instant::now() + Duration::from_secs(2),
        remaining: 262144,
    };
    let result = budget.run_env(
        &git,
        &[
            "--no-pager",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.attributesFile=/dev/null",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            "before",
            "after",
        ],
        &shadow.0,
        &env,
    )?;
    if !matches!(result.status.code(), Some(0 | 1)) {
        return Err("round_unavailable".into());
    }
    String::from_utf8(result.stdout).map_err(|_| "round_unavailable".into())
}
impl Store {
    fn info(&self, root: &Path, session: &str) -> Result<Option<BaselineInfo>, String> {
        let Some(value) = self.entries.get(session) else {
            return Ok(None);
        };
        if value.snapshot.root != root {
            return Err("round_context_changed".into());
        }
        Ok(Some(value.info.clone()))
    }
    fn capture(
        &mut self,
        root: &Path,
        session: &str,
        expected: Option<&str>,
    ) -> Result<BaselineInfo, String> {
        if self
            .entries
            .get(session)
            .map(|value| value.info.id.as_str())
            != expected
        {
            return Err("round_baseline_changed".into());
        }
        let snapshot = collect(root, &BTreeSet::new(), || {})?;
        let stored = self
            .entries
            .iter()
            .filter(|(id, _)| id.as_str() != session)
            .map(|(_, entry)| entry.snapshot.bytes)
            .sum::<usize>();
        if stored + snapshot.bytes > MAX_STORED_BYTES
            || !self.entries.contains_key(session) && self.entries.len() >= 4
        {
            return Err("round_storage_full".into());
        }
        let info = BaselineInfo {
            id: format!("baseline-{}", crate::next_session_id()),
            root: root.to_string_lossy().into_owned(),
            captured_at: crate::unix_timestamp(),
            files: snapshot.files.len(),
            skipped: snapshot
                .files
                .values()
                .filter(|value| matches!(value, Content::Unavailable))
                .count(),
        };
        self.entries.insert(
            session.into(),
            Baseline {
                info: info.clone(),
                snapshot,
            },
        );
        Ok(info)
    }
    fn compare(
        &self,
        root: &Path,
        session: &str,
        id: &str,
        selected: Option<&str>,
    ) -> Result<Report, String> {
        let before = self
            .entries
            .get(session)
            .filter(|entry| entry.info.id == id)
            .ok_or("round_baseline_changed")?;
        if before.snapshot.root != root || before.snapshot.stamp != root_stamp(root)? {
            return Err("round_context_changed".into());
        }
        let now = collect(
            root,
            &before.snapshot.files.keys().cloned().collect(),
            || {},
        )?;
        if now.stamp != before.snapshot.stamp {
            return Err("round_context_changed".into());
        }
        let mut rows = Vec::new();
        let mut skipped = 0;
        for (path, after) in &now.files {
            let old = before.snapshot.files.get(path);
            if old == Some(after) {
                if matches!(after, Content::Unavailable) {
                    skipped += 1;
                }
                continue;
            }
            if matches!(old, Some(Content::Unavailable)) || matches!(after, Content::Unavailable) {
                skipped += 1;
                rows.push(Row {
                    path: path.clone(),
                    kind: "unavailable".into(),
                });
                continue;
            }
            let kind = match (old, after) {
                (None, _) => "unrecorded",
                (_, Content::Missing) => "deleted",
                (Some(Content::Missing), _) => "restored",
                _ => "modified",
            };
            rows.push(Row {
                path: path.clone(),
                kind: kind.into(),
            });
        }
        for path in now.untracked.difference(&before.snapshot.untracked) {
            if !now.files.contains_key(path) {
                rows.push(Row {
                    path: path.clone(),
                    kind: "untracked".into(),
                });
            }
        }
        for path in before.snapshot.untracked.difference(&now.untracked) {
            if !now.files.contains_key(path) {
                rows.push(Row {
                    path: path.clone(),
                    kind: "untracked_removed".into(),
                });
            }
        }
        if rows.len() > MAX_FILES {
            return Err("round_limit".into());
        }
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        let patch = if let Some(path) = selected {
            let row = rows
                .iter()
                .find(|row| {
                    row.path == path
                        && matches!(row.kind.as_str(), "modified" | "deleted" | "restored")
                })
                .ok_or("round_comparison_unavailable")?;
            let old = match before.snapshot.files.get(path) {
                Some(Content::Text(text)) => text.as_str(),
                _ => "",
            };
            let current = match now.files.get(path) {
                Some(Content::Text(text)) => text.as_str(),
                _ => "",
            };
            Some(Patch {
                path: row.path.clone(),
                text: diff_text(old, current)?,
            })
        } else {
            None
        };
        Ok(Report {
            baseline: before.info.clone(),
            rows,
            skipped,
            patch,
        })
    }
    fn clear(&mut self, root: &Path, session: &str, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .get(session)
            .filter(|entry| entry.info.id == id)
            .ok_or("round_baseline_changed")?;
        if entry.snapshot.root != root {
            return Err("round_context_changed".into());
        }
        self.entries.remove(session);
        Ok(())
    }
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn get_run_baseline_info(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<BaselineInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project_files::session_root(&app, session_id.clone())?;
        STORE
            .try_lock()
            .map_err(|_| "round_busy")?
            .info(&root, &session_id)
    })
    .await
    .map_err(|_| "round_unavailable")?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn capture_run_baseline(
    app: tauri::AppHandle,
    session_id: String,
    expected_id: Option<String>,
) -> Result<BaselineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project_files::session_root(&app, session_id.clone())?;
        STORE.try_lock().map_err(|_| "round_busy")?.capture(
            &root,
            &session_id,
            expected_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "round_unavailable")?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn compare_run_baseline(
    app: tauri::AppHandle,
    session_id: String,
    baseline_id: String,
    path: Option<String>,
) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project_files::session_root(&app, session_id.clone())?;
        STORE.try_lock().map_err(|_| "round_busy")?.compare(
            &root,
            &session_id,
            &baseline_id,
            path.as_deref(),
        )
    })
    .await
    .map_err(|_| "round_unavailable")?
}
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn clear_run_baseline(
    app: tauri::AppHandle,
    session_id: String,
    baseline_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project_files::session_root(&app, session_id.clone())?;
        STORE
            .try_lock()
            .map_err(|_| "round_busy")?
            .clear(&root, &session_id, &baseline_id)
    })
    .await
    .map_err(|_| "round_unavailable")?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Command};
    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("yam-run-changes-{}", crate::next_session_id()));
            crate::background::private_root(&path).unwrap();
            let repo = Self(fs::canonicalize(path).unwrap());
            repo.git(&["init", "-q"]);
            fs::write(repo.0.join("a.txt"), "base\n").unwrap();
            repo.git(&["add", "a.txt"]);
            repo.git(&[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "fixture",
            ]);
            repo
        }
        fn git(&self, args: &[&str]) {
            assert!(Command::new(crate::find_executable("git").unwrap())
                .current_dir(&self.0)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "commit.gpgsign=false"
                ])
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn ignore_fix_run_baseline_respects_configured_patterns_and_compares_tracked_text() {
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        fs::write(repo.0.join(".git/global-ignore"), "*.secret\n").unwrap();
        repo.git(&["config", "core.excludesfile", ".git/global-ignore"]);
        fs::write(repo.0.join("hidden.secret"), "not listed").unwrap();
        let mut store = Store::default();
        let baseline = store.capture(&repo.0, "ignore-session", None).unwrap();
        fs::write(repo.0.join("a.txt"), "after\n").unwrap();
        let result = store
            .compare(&repo.0, "ignore-session", &baseline.id, Some("a.txt"))
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].path, "a.txt");
        assert!(result.patch.unwrap().text.contains("+after"));
    }
    #[test]
    fn run_changes_compare_excludes_existing_human_edits_and_never_writes_index_or_files() {
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        fs::write(repo.0.join("a.txt"), "human\nbase\n").unwrap();
        let index = fs::read(repo.0.join(".git/index")).unwrap();
        let mut store = Store::default();
        let info = store.capture(&repo.0, "s-one", None).unwrap();
        fs::write(repo.0.join("a.txt"), "human\nbase\nai\n").unwrap();
        let report = store
            .compare(&repo.0, "s-one", &info.id, Some("a.txt"))
            .unwrap();
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].kind, "modified");
        let patch = report.patch.unwrap();
        assert!(patch.text.contains("+ai"));
        assert!(!patch.text.contains("+human"));
        assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), index);
        assert_eq!(
            fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "human\nbase\nai\n"
        );
        assert_eq!(
            store
                .compare(&repo.0, "another", &info.id, None)
                .unwrap_err(),
            "round_baseline_changed"
        );
    }
    #[test]
    fn run_changes_handles_deletion_untracked_names_stale_tokens_and_explicit_replacement() {
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        let mut store = Store::default();
        fs::write(repo.0.join("private.env"), "do-not-auto-read").unwrap();
        let info = store.capture(&repo.0, "s-one", None).unwrap();
        assert!(!store.entries["s-one"]
            .snapshot
            .files
            .contains_key("private.env"));
        fs::remove_file(repo.0.join("a.txt")).unwrap();
        fs::write(repo.0.join("new.txt"), "new secret").unwrap();
        let report = store
            .compare(&repo.0, "s-one", &info.id, Some("a.txt"))
            .unwrap();
        assert!(report.patch.unwrap().text.contains("-base"));
        assert!(report
            .rows
            .iter()
            .any(|row| row.path == "new.txt" && row.kind == "untracked"));
        assert_eq!(
            store.capture(&repo.0, "s-one", None).unwrap_err(),
            "round_baseline_changed"
        );
        assert_eq!(
            store.clear(&repo.0, "s-one", "stale").unwrap_err(),
            "round_baseline_changed"
        );
        let next = store.capture(&repo.0, "s-one", Some(&info.id)).unwrap();
        assert_ne!(next.id, info.id);
        assert_eq!(
            store.compare(&repo.0, "s-one", &info.id, None).unwrap_err(),
            "round_baseline_changed"
        );
        store.clear(&repo.0, "s-one", &next.id).unwrap();
        assert!(store.info(&repo.0, "s-one").unwrap().is_none());
    }
    #[test]
    fn run_changes_rejects_concurrent_capture_and_root_replacement_without_losing_baseline() {
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        let error = collect(&repo.0, &Default::default(), || {
            fs::write(repo.0.join("a.txt"), "raced\n").unwrap();
        })
        .unwrap_err();
        assert_eq!(error, "round_capture_changed");
        let mut store = Store::default();
        let info = store.capture(&repo.0, "s-one", None).unwrap();
        let previous = repo.0.with_extension("previous");
        fs::rename(&repo.0, &previous).unwrap();
        fs::create_dir(&repo.0).unwrap();
        assert_eq!(
            store.compare(&repo.0, "s-one", &info.id, None).unwrap_err(),
            "round_context_changed"
        );
        fs::remove_dir(&repo.0).unwrap();
        fs::rename(previous, &repo.0).unwrap();
        assert_eq!(store.info(&repo.0, "s-one").unwrap().unwrap().id, info.id);
    }
    #[test]
    fn run_changes_limits_and_external_filters_preserve_the_previous_baseline() {
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        let mut store = Store::default();
        let info = store.capture(&repo.0, "s-one", None).unwrap();
        repo.git(&["config", "filter.fixture.clean", "touch forbidden-marker"]);
        fs::write(repo.0.join(".gitattributes"), "a.txt filter=fixture\n").unwrap();
        assert_eq!(
            store.capture(&repo.0, "s-one", Some(&info.id)).unwrap_err(),
            "git_external_filter"
        );
        assert!(!repo.0.join("forbidden-marker").exists());
        repo.git(&["config", "--unset", "filter.fixture.clean"]);
        fs::remove_file(repo.0.join(".gitattributes")).unwrap();
        for index in 0..MAX_FILES {
            fs::write(repo.0.join(format!("extra-{index}")), "").unwrap();
        }
        repo.git(&["add", "--all"]);
        assert_eq!(
            store.capture(&repo.0, "s-one", Some(&info.id)).unwrap_err(),
            "round_limit"
        );
        assert_eq!(store.info(&repo.0, "s-one").unwrap().unwrap().id, info.id);
    }

    #[test]
    fn run_changes_skip_binary_and_symlinks_and_missing_reads_stay_inside_root() {
        use std::os::unix::fs::symlink;
        let _serial = crate::git_context::f3_serial_query_test();
        let repo = Repo::new();
        fs::write(repo.0.join("binary.dat"), [0, 1, 2]).unwrap();
        symlink("/etc/passwd", repo.0.join("linked")).unwrap();
        repo.git(&["add", "binary.dat", "linked"]);
        let mut store = Store::default();
        let info = store.capture(&repo.0, "s-one", None).unwrap();
        assert_eq!(info.skipped, 2);
        assert!(
            crate::project_files::read_snapshot(&repo.0, "missing/nested.txt")
                .unwrap()
                .is_none()
        );
        assert!(crate::project_files::read_snapshot(&repo.0, "linked").is_err());
        assert!(crate::project_files::read_snapshot(&repo.0, "../escape").is_err());
        assert_eq!(
            store
                .compare(&repo.0, "s-one", &info.id, Some("linked"))
                .unwrap_err(),
            "round_comparison_unavailable"
        );
        assert_eq!(
            store
                .compare(&repo.0, "s-one", &info.id, Some("private.env"))
                .unwrap_err(),
            "round_comparison_unavailable"
        );
    }
}
