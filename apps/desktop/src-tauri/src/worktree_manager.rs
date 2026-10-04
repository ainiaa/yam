// Author: Jeff.Liu. Explicit creation and recoverable macOS cleanup of managed worktrees.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    pub(super) fn serial_worktree_test() -> std::sync::MutexGuard<'static, ()> {
        TEST_SERIAL
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-t13-contract-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn save(&self, record: ManagedRecord) {
            std::fs::write(
                self.0.join("worktrees.json"),
                serde_json::to_vec(&Manifest {
                    version: 1,
                    revision: 1,
                    records: vec![record],
                    identities: Default::default(),
                    cleanup: Default::default(),
                })
                .unwrap(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Test-only: discard only this fixture's previews, leaving production limits unchanged.
            if let Ok(mut previews) = PREVIEWS.lock() {
                previews.retain(|preview| !preview.private.starts_with(&self.0));
            }
            if let Ok(mut previews) = CLEANUP_PREVIEWS.lock() {
                previews.retain(|preview| !preview.private.starts_with(&self.0));
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn record() -> ManagedRecord {
        ManagedRecord {
            attempt: "a".repeat(64),
            session_id: "s-123-1".into(),
            repository: "/fixture/repo".into(),
            common_dir: "/fixture/repo/.git".into(),
            target: "/fixture/worktree".into(),
            branch: "codex/yam/s-123-1".into(),
            commit: "b".repeat(40),
            state: RecordState::Created,
            checkout_complete: true,
            session_claimed: false,
        }
    }
    #[test]
    fn t13_manifest_normal_and_reserved_real_id() {
        let _serial = serial_worktree_test();
        let value = Manifest {
            version: 1,
            revision: 1,
            records: vec![record()],
            identities: Default::default(),
            cleanup: Default::default(),
        };
        let decoded = decode_manifest(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            decoded.records[0].branch,
            format!("codex/yam/{}", decoded.records[0].session_id)
        );
    }
    #[test]
    fn t13_manifest_rejects_version_unknown_duplicates_and_size() {
        let _serial = serial_worktree_test();
        let value = serde_json::to_value(Manifest {
            version: 1,
            revision: 1,
            records: vec![record()],
            identities: Default::default(),
            cleanup: Default::default(),
        })
        .unwrap();
        for bad in [
            json!({"version":2,"revision":1,"records":[]}),
            json!({"version":1,"revision":1,"records":[],"command":"private"}),
            json!({"version":1,"revision":1,"records":[record(),record()]}),
        ] {
            assert_eq!(
                decode_manifest(&serde_json::to_vec(&bad).unwrap()).unwrap_err(),
                "worktree_manifest_invalid"
            );
        }
        assert!(decode_manifest(&serde_json::to_vec(&value).unwrap()).is_ok());
        assert_eq!(
            decode_manifest(&vec![b' '; 1024 * 1024 + 1]).unwrap_err(),
            "worktree_manifest_limit"
        );
    }
    #[test]
    fn t13_claim_real_session_id_once_across_reopen() {
        let _serial = serial_worktree_test();
        let fixture = Fixture::new();
        let saved = record();
        fixture.save(saved.clone());
        assert_eq!(
            claim_record(
                &fixture.0,
                &saved.attempt,
                std::path::Path::new(&saved.target)
            )
            .unwrap(),
            saved.session_id
        );
        assert_eq!(
            claim_record(
                &fixture.0,
                &saved.attempt,
                std::path::Path::new(&saved.target)
            )
            .unwrap_err(),
            "worktree_session_consumed"
        );
        let manifest =
            decode_manifest(&std::fs::read(fixture.0.join("worktrees.json")).unwrap()).unwrap();
        assert!(
            manifest.records[0].session_claimed,
            "claim must be durable before downstream allocations"
        );
    }
    #[test]
    fn t13_forged_attempt_wrong_root_and_incomplete_checkout_cannot_claim() {
        let _serial = serial_worktree_test();
        let fixture = Fixture::new();
        let saved = record();
        fixture.save(saved.clone());
        assert_eq!(
            claim_record(
                &fixture.0,
                &"c".repeat(64),
                std::path::Path::new(&saved.target)
            )
            .unwrap_err(),
            "worktree_unknown_attempt"
        );
        assert_eq!(
            claim_record(&fixture.0, &saved.attempt, std::path::Path::new("/other")).unwrap_err(),
            "worktree_identity_changed"
        );
        for state in [
            RecordState::Creating,
            RecordState::Failed,
            RecordState::Removing,
            RecordState::Removed,
        ] {
            let mut incomplete = saved.clone();
            incomplete.state = state;
            fixture.save(incomplete);
            assert_eq!(
                claim_record(
                    &fixture.0,
                    &saved.attempt,
                    std::path::Path::new(&saved.target)
                )
                .unwrap_err(),
                "worktree_not_ready"
            );
        }
    }
    #[test]
    fn t13_registered_residue_is_not_checkout_completion() {
        let _serial = serial_worktree_test();
        let mut saved = record();
        saved.state = RecordState::Creating;
        saved.checkout_complete = false;
        let recovered = reconcile_record(&saved, true).unwrap();
        assert_ne!(recovered.state, RecordState::Created);
        assert!(!recovered.checkout_complete);
        assert_eq!(
            recovered.target, saved.target,
            "recovery preserves explicit residue; no deletion"
        );
    }
    #[test]
    fn t13_cleanup_preflight_and_dirty_active_ignored_guards() {
        let _serial = serial_worktree_test();
        let saved = record();
        assert!(validate_cleanup(&saved, &[], false, false, false, false).is_ok());
        for (dirty, untracked, ignored, nested) in [
            (true, false, false, false),
            (false, true, false, false),
            (false, false, true, false),
            (false, false, false, true),
        ] {
            assert_eq!(
                validate_cleanup(&saved, &[], dirty, untracked, ignored, nested).unwrap_err(),
                "worktree_not_clean"
            );
        }
        assert_eq!(
            validate_cleanup(
                &saved,
                &[std::path::PathBuf::from(&saved.target).join("sub")],
                false,
                false,
                false,
                false
            )
            .unwrap_err(),
            "worktree_active"
        );
    }
    #[test]
    fn t13_filter_smudge_only_is_refused_without_values() {
        let _serial = serial_worktree_test();
        assert!(validate_filter_config(b"core.bare\nfalse\0").is_ok());
        for driver in ["clean", "smudge", "process"] {
            let config = format!("filter.fixture.{driver}\nprivate-secret-marker-command\0");
            assert_eq!(
                validate_filter_config(config.as_bytes()).unwrap_err(),
                "worktree_external_filter"
            );
        }
    }
    #[test]
    fn t13_start_and_cleanup_share_one_lifecycle_gate() {
        let _serial = serial_worktree_test();
        let first = start_guard().unwrap();
        assert!(
            cleanup_guard().is_err(),
            "cleanup cannot race pending ordinary/Resume start"
        );
        drop(first);
        assert!(cleanup_guard().is_ok());
    }
    struct GitFixture {
        owned: Fixture,
        repository: std::path::PathBuf,
        private: std::path::PathBuf,
        target: std::path::PathBuf,
    }
    impl GitFixture {
        fn new() -> Self {
            let owned = Fixture::new();
            let repository = owned.0.join("repo 中 space");
            let private = owned.0.join("private");
            let target = owned.0.join("new worktree 中");
            std::fs::create_dir(&repository).unwrap();
            std::fs::create_dir(&private).unwrap();
            std::fs::create_dir(owned.0.join("empty-hooks")).unwrap();
            let fixture = Self {
                owned,
                repository,
                private,
                target,
            };
            fixture.git(&["init", "-b", "fixture"]);
            fixture.git(&[
                "config",
                "core.hooksPath",
                fixture.owned.0.join("empty-hooks").to_str().unwrap(),
            ]);
            fixture.git(&["config", "user.name", "T13 Fixture"]);
            fixture.git(&["config", "user.email", "fixture@example.invalid"]);
            std::fs::write(fixture.repository.join("file.txt"), "committed fixture\n").unwrap();
            std::fs::write(fixture.repository.join("Unicode 中.txt"), "unicode\n").unwrap();
            fixture.git(&["add", "file.txt", "Unicode 中.txt"]);
            fixture.git(&["commit", "-m", "fixture"]);
            fixture
        }
        fn git(&self, args: &[&str]) -> String {
            let git = crate::find_executable("git")
                .unwrap()
                .canonicalize()
                .unwrap();
            let mut command = std::process::Command::new(git);
            for (key, _) in std::env::vars_os() {
                if key
                    .to_string_lossy()
                    .to_ascii_uppercase()
                    .starts_with("GIT_")
                {
                    command.env_remove(key);
                }
            }
            let result = command
                .args(args)
                .current_dir(&self.repository)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_OPTIONAL_LOCKS", "0")
                .output()
                .unwrap();
            assert!(result.status.success(), "owned Git fixture setup failed");
            String::from_utf8(result.stdout).unwrap().trim().into()
        }
        fn input(&self) -> CreateInput {
            CreateInput {
                root: self.repository.to_string_lossy().into(),
                target: self.target.to_string_lossy().into(),
                reference: "refs/heads/fixture".into(),
                branch: None,
            }
        }
    }
    #[test]
    fn t13_git_preview_reserves_real_id_without_branch_or_directory() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let branches = fixture.git(&["branch", "--list"]);
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        assert_eq!(
            preview.record.branch,
            format!("codex/yam/{}", preview.record.session_id)
        );
        assert_eq!(preview.record.commit, fixture.git(&["rev-parse", "HEAD"]));
        assert!(!fixture.target.exists());
        assert_eq!(fixture.git(&["branch", "--list"]), branches);
    }
    #[test]
    fn t13_git_create_populates_fixed_commit_without_copying_uncommitted_changes_and_is_idempotent()
    {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        std::fs::write(fixture.repository.join("file.txt"), "uncommitted change").unwrap();
        let source_index = std::fs::read(fixture.repository.join(".git/index")).unwrap();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let created = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert_eq!(created.state, RecordState::Created);
        assert!(created.checkout_complete);
        assert_eq!(created.session_id, preview.record.session_id);
        assert_eq!(
            std::fs::read_to_string(fixture.target.join("file.txt")).unwrap(),
            "committed fixture\n"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.target.join("Unicode 中.txt")).unwrap(),
            "unicode\n"
        );
        assert_eq!(
            std::fs::read(fixture.repository.join(".git/index")).unwrap(),
            source_index
        );
        let retry = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert_eq!(retry.branch, created.branch);
        assert_eq!(retry.target, created.target);
        let reopened = list_managed(&fixture.private).unwrap();
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].session_id, created.session_id);
    }
    #[test]
    fn t13_git_existing_target_branch_and_missing_ref_are_refused() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        std::fs::create_dir(&fixture.target).unwrap();
        std::fs::write(fixture.target.join("keep"), "user-like fixture").unwrap();
        assert_eq!(
            preview_create(&fixture.private, &fixture.input()).unwrap_err(),
            "worktree_target_occupied"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.target.join("keep")).unwrap(),
            "user-like fixture"
        );
        let mut input = fixture.input();
        input.target = fixture.owned.0.join("other").to_string_lossy().into();
        input.branch = Some("fixture".into());
        assert_eq!(
            preview_create(&fixture.private, &input).unwrap_err(),
            "worktree_branch_occupied"
        );
        input.branch = None;
        input.reference = "refs/heads/absent".into();
        assert_eq!(
            preview_create(&fixture.private, &input).unwrap_err(),
            "worktree_ref_unavailable"
        );
    }
    #[cfg(unix)]
    #[test]
    fn t13_git_smudge_and_post_checkout_are_never_executed() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let marker = fixture.owned.0.join("external-must-not-run");
        fixture.git(&[
            "config",
            "filter.fixture.smudge",
            &format!("touch '{}'", marker.display()),
        ]);
        assert_eq!(
            preview_create(&fixture.private, &fixture.input()).unwrap_err(),
            "worktree_external_filter"
        );
        assert!(!marker.exists());
        fixture.git(&["config", "--unset", "filter.fixture.smudge"]);
        let hooks = fixture.owned.0.join("configured-hooks");
        std::fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        fixture.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn t13_git_builtin_crlf_checkout_matches_normal_git_semantics() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        fixture.git(&["config", "core.autocrlf", "true"]);
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert_eq!(
            std::fs::read(fixture.target.join("file.txt")).unwrap(),
            b"committed fixture\r\n"
        );
    }
    #[test]
    fn t13_git_config_changed_after_preview_refuses_before_registration() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        fixture.git(&[
            "config",
            "filter.fixture.smudge",
            "private-command-must-not-run",
        ]);
        assert_eq!(
            create_managed(&fixture.private, &preview.record.attempt).unwrap_err(),
            "worktree_external_filter"
        );
        assert!(!fixture.target.exists());
    }
    fn owner_start(
        fixture: &GitFixture,
        record: &ManagedRecord,
        cwd: std::path::PathBuf,
        project: Option<crate::project_config::ProjectStart>,
    ) -> Result<crate::SessionSummary, String> {
        let manager = crate::SessionManager::default();
        crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let result = crate::create_session_owner_with_worktree(
            None,
            &manager,
            &fixture.private,
            if project.is_none() {
                Some(cwd.to_string_lossy().into())
            } else {
                None
            },
            None,
            None,
            None,
            project,
            Some(record.attempt.clone()),
        );
        assert!(manager.sessions.lock().unwrap().is_empty());
        result
    }
    #[test]
    fn t13_owner_valid_managed_start_claims_reserved_id_once_before_allocation() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), None).unwrap_err(),
            "test_entry_reached_allocation"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 1);
        assert_eq!(
            crate::T13_ALLOCATION_SESSION.with(|id| id.borrow().clone()),
            Some(record.session_id.clone())
        );
        assert!(read_manifest(&fixture.private).unwrap().records[0].session_claimed);
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), None).unwrap_err(),
            "worktree_session_consumed"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
    }
    #[test]
    fn t13_owner_changed_head_wrong_cwd_and_incomplete_record_never_allocate() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        assert_eq!(
            owner_start(&fixture, &record, fixture.repository.clone(), None).unwrap_err(),
            "worktree_identity_changed"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        let git = installed_git().unwrap();
        let output = std::process::Command::new(&git)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "checkout",
                "--detach",
                &record.commit,
            ])
            .current_dir(&fixture.target)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), None).unwrap_err(),
            "worktree_identity_changed"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        let mut manifest = read_manifest(&fixture.private).unwrap();
        manifest.records[0].state = RecordState::Creating;
        manifest.records[0].checkout_complete = false;
        save_manifest(&fixture.private, &manifest).unwrap();
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), None).unwrap_err(),
            "worktree_not_ready"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
    }
    #[test]
    fn t13_owner_replaced_physical_root_never_allocates() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        let gitfile = std::fs::read(fixture.target.join(".git")).unwrap();
        std::fs::rename(
            &fixture.target,
            fixture.owned.0.join("retained-original-target"),
        )
        .unwrap();
        std::fs::create_dir(&fixture.target).unwrap();
        std::fs::write(fixture.target.join(".git"), gitfile).unwrap();
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), None).unwrap_err(),
            "worktree_identity_changed"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
    }
    #[test]
    fn t13_owner_ordinary_start_cannot_bypass_incomplete_descendant_or_alias() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let _record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        std::fs::create_dir(fixture.target.join("sub")).unwrap();
        let mut manifest = read_manifest(&fixture.private).unwrap();
        manifest.records[0].state = RecordState::Creating;
        manifest.records[0].checkout_complete = false;
        save_manifest(&fixture.private, &manifest).unwrap();
        let mut paths = vec![fixture.target.join("sub")];
        #[cfg(unix)]
        {
            let alias = fixture.owned.0.join("alias");
            std::os::unix::fs::symlink(&fixture.target, &alias).unwrap();
            paths.push(alias.join("sub"));
        }
        for path in paths {
            crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
            let result = crate::create_session_owner_with_worktree(
                None,
                &crate::SessionManager::default(),
                &fixture.private,
                Some(path.to_string_lossy().into()),
                None,
                None,
                None,
                None,
                None,
            );
            assert_eq!(result.unwrap_err(), "worktree_not_ready");
            assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        }
    }
    #[test]
    fn t13_owner_consumed_worktree_allows_normal_commit_and_run_again_with_new_id() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        claim_record(
            &fixture.private,
            &record.attempt,
            &fixture.target.canonicalize().unwrap(),
        )
        .unwrap();
        let git = installed_git().unwrap();
        let mut command = std::process::Command::new(git);
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        let result = command
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=T13 Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "ordinary worktree development",
            ])
            .current_dir(&fixture.target)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(result.status.success());
        crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let result = crate::create_session_owner_with_worktree(
            None,
            &crate::SessionManager::default(),
            &fixture.private,
            Some(fixture.target.to_string_lossy().into()),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.unwrap_err(), "test_entry_reached_allocation");
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 1);
        assert_eq!(
            list_managed(&fixture.private).unwrap()[0].state,
            RecordState::Created
        );
    }
    #[cfg(unix)]
    #[test]
    fn t13_owner_ordinary_and_resume_shared_preflight_reject_symlink_away_from_incomplete_target() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        let mut manifest = read_manifest(&fixture.private).unwrap();
        manifest.records[0].state = RecordState::Creating;
        manifest.records[0].checkout_complete = false;
        save_manifest(&fixture.private, &manifest).unwrap();
        std::fs::rename(
            &fixture.target,
            fixture.owned.0.join("retained-incomplete-target"),
        )
        .unwrap();
        let outside = fixture.owned.0.join("ordinary-directory");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(outside.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, &fixture.target).unwrap();
        let cwd = fixture.target.join("sub");
        assert_eq!(
            prepare_start(&fixture.private, &cwd, None).err().unwrap(),
            "worktree_not_ready",
            "Resume uses this same preflight after resolving its stored cwd"
        );
        crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let result = crate::create_session_owner_with_worktree(
            None,
            &crate::SessionManager::default(),
            &fixture.private,
            Some(cwd.to_string_lossy().into()),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.unwrap_err(), "worktree_not_ready");
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        assert!(!read_manifest(&fixture.private).unwrap().records[0].session_claimed);
        let _ = record;
    }
    #[cfg(unix)]
    #[test]
    fn t13_owner_different_parent_alias_cannot_escape_incomplete_target_identity() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        create_managed(&fixture.private, &preview.record.attempt).unwrap();
        let mut manifest = read_manifest(&fixture.private).unwrap();
        manifest.records[0].state = RecordState::Creating;
        manifest.records[0].checkout_complete = false;
        save_manifest(&fixture.private, &manifest).unwrap();
        let alternate = fixture.owned.0.join("different-parent-alias");
        std::os::unix::fs::symlink(&fixture.owned.0, &alternate).unwrap();
        std::fs::rename(&fixture.target, fixture.owned.0.join("retained-old-target")).unwrap();
        let outside = fixture.owned.0.join("ordinary-directory");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(outside.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, &fixture.target).unwrap();
        let cwd = alternate
            .join(fixture.target.file_name().unwrap())
            .join("sub");
        assert_eq!(
            prepare_start(&fixture.private, &cwd, None).err().unwrap(),
            "worktree_not_ready"
        );
        crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.set(0));
        let result = crate::create_session_owner_with_worktree(
            None,
            &crate::SessionManager::default(),
            &fixture.private,
            Some(cwd.to_string_lossy().into()),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.unwrap_err(), "worktree_not_ready");
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
    }
    #[test]
    fn t13_owner_new_worktree_project_config_requires_new_root_trust() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        std::fs::write(
            fixture.repository.join("yam.json"),
            br#"{"version":1,"defaults":{"adapter":"custom","command":"echo fixture"}}"#,
        )
        .unwrap();
        fixture.git(&["add", "yam.json"]);
        fixture.git(&["commit", "-m", "project fixture"]);
        let parent = crate::project_config::preview(&fixture.repository, &fixture.private).unwrap();
        crate::project_config::trust(&fixture.repository, &fixture.private, &parent).unwrap();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &preview.record.attempt).unwrap();
        let project = serde_json::from_value(
            serde_json::json!({"root":fixture.target,"template":null,"overrides":{}}),
        )
        .unwrap();
        assert_eq!(
            owner_start(&fixture, &record, fixture.target.clone(), Some(project)).unwrap_err(),
            "project_config_untrusted"
        );
        assert_eq!(crate::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()), 0);
        assert!(!read_manifest(&fixture.private).unwrap().records[0].session_claimed);
    }
    #[test]
    fn t13_owner_rpc_endpoints_use_actual_private_body_and_cleanup_never_removes() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let preview: CreatePreview = serde_json::from_value(
            owner_command(
                &fixture.private,
                "preview_worktree_create",
                serde_json::to_value(fixture.input()).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        let created: ManagedRecord = serde_json::from_value(
            owner_command(
                &fixture.private,
                "create_worktree",
                serde_json::json!({"attempt":preview.record.attempt}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(created.state, RecordState::Created);
        let records: Vec<ManagedRecord> = serde_json::from_value(
            owner_command(
                &fixture.private,
                "list_managed_worktrees",
                serde_json::json!({}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].session_id, preview.record.session_id);
        let before = std::fs::read(fixture.private.join("worktrees.json")).unwrap();
        for (command, args) in [
            (
                "preview_worktree_cleanup",
                serde_json::json!({"attempt":created.attempt}),
            ),
            (
                "cleanup_worktree",
                serde_json::json!({"attempt":created.attempt,"preview":"f".repeat(64)}),
            ),
        ] {
            assert_eq!(
                owner_command(&fixture.private, command, args).unwrap_err(),
                "worktree_cleanup_unavailable"
            );
        }
        assert!(fixture.target.is_dir());
        assert_eq!(
            std::fs::read(fixture.private.join("worktrees.json")).unwrap(),
            before
        );
        assert_eq!(
            owner_command(
                &fixture.private,
                "create_worktree",
                serde_json::json!({"attempt":created.attempt,"session_id":"forged"})
            )
            .unwrap_err(),
            "worktree_invalid_request"
        );
    }
    #[test]
    fn t13_git_two_managed_directories_have_distinct_reserved_ids_and_independent_files() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let first = preview_create(&fixture.private, &fixture.input()).unwrap();
        let first = create_managed(&fixture.private, &first.record.attempt).unwrap();
        let mut input = fixture.input();
        input.target = fixture
            .owned
            .0
            .join("second-worktree")
            .to_string_lossy()
            .into();
        let second = preview_create(&fixture.private, &input).unwrap();
        let second = create_managed(&fixture.private, &second.record.attempt).unwrap();
        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.branch, second.branch);
        assert_ne!(first.target, second.target);
        std::fs::write(
            std::path::Path::new(&first.target).join("file.txt"),
            "first worktree edit",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&second.target).join("file.txt")).unwrap(),
            "committed fixture\n"
        );
        assert_eq!(list_managed(&fixture.private).unwrap().len(), 2);
    }
    #[test]
    fn t13_git_confirmed_commit_gitlink_rejected_even_if_staged_deleted() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let hash = fixture.git(&["rev-parse", "HEAD"]);
        fixture.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{hash},nested"),
        ]);
        fixture.git(&["commit", "-m", "gitlink fixture"]);
        fixture.git(&["update-index", "--force-remove", "nested"]);
        assert_eq!(
            preview_create(&fixture.private, &fixture.input()).unwrap_err(),
            "worktree_submodule_unsupported"
        );
        assert!(!fixture.target.exists());
    }
    #[test]
    fn t13_git_nested_selected_repository_is_rejected() {
        let _serial = serial_worktree_test();
        let outer = GitFixture::new();
        let nested = outer.repository.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let git = crate::find_executable("git")
            .unwrap()
            .canonicalize()
            .unwrap();
        let output = std::process::Command::new(git)
            .args(["-c", "core.hooksPath=/dev/null", "init", "-b", "nested"])
            .current_dir(&nested)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(output.status.success());
        let mut input = outer.input();
        input.root = nested.to_string_lossy().into();
        assert_eq!(
            preview_create(&outer.private, &input).unwrap_err(),
            "worktree_nested_repository"
        );
    }
    #[test]
    fn t13_git_target_inside_existing_repository_is_rejected() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let mut input = fixture.input();
        input.target = fixture.repository.join("embedded").to_string_lossy().into();
        assert_eq!(
            preview_create(&fixture.private, &input).unwrap_err(),
            "worktree_nested_repository"
        );
        assert!(!fixture.repository.join("embedded").exists());
    }
    fn assert_creation_fault(stage: CreateFault) {
        let fixture = GitFixture::new();
        let preview = preview_create(&fixture.private, &fixture.input()).unwrap();
        CREATE_FAULT.with(|fault| fault.set(Some(stage)));
        FAULT_HIT.with(|hit| hit.set(None));
        let result = create_managed(&fixture.private, &preview.record.attempt);
        CREATE_FAULT.with(|fault| fault.set(None));
        assert_eq!(
            FAULT_HIT.with(|hit| hit.get()),
            Some(stage),
            "specified real stage must be hit"
        );
        assert_eq!(result.unwrap_err(), "worktree_injected_fault");
        let reopened = list_managed(&fixture.private).unwrap();
        assert_eq!(reopened.len(), 1);
        assert!(!reopened[0].checkout_complete);
        assert_ne!(reopened[0].state, RecordState::Created);
    }
    #[test]
    fn t13_git_fault_after_creating_is_durable_without_directory() {
        let _serial = serial_worktree_test();
        assert_creation_fault(CreateFault::Creating);
    }
    #[test]
    fn t13_git_fault_after_registration_is_not_complete_checkout() {
        let _serial = serial_worktree_test();
        assert_creation_fault(CreateFault::Registration);
    }
    #[test]
    fn t13_git_fault_after_checkout_before_publish_stays_unready() {
        let _serial = serial_worktree_test();
        assert_creation_fault(CreateFault::Checkout);
    }

    #[test]
    fn t13_cleanup_actual_endpoint_previews_clean_created_worktree_without_mutation() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let value = owner_cleanup_command(
            &fixture.private,
            &cleanup_manager(),
            "preview_worktree_cleanup",
            json!({"attempt":record.attempt}),
            |_| panic!("preview must not trash"),
        )
        .unwrap();
        assert_eq!(value["attempt"], record.attempt);
        assert_eq!(value["target"], record.target);
        assert_eq!(value["branch"], record.branch);
        assert_eq!(value["action"], "trash");
        assert_eq!(value["preview"].as_str().unwrap().len(), 64);
        assert!(fixture.target.join("file.txt").exists());
        assert!(fixture
            .git(&["worktree", "list", "--porcelain"])
            .contains(&record.target));
    }
    #[test]
    fn t13_cleanup_actual_endpoint_refuses_ignored_untracked_and_staged_before_any_move() {
        let _serial = serial_worktree_test();
        for kind in ["ignored", "untracked", "staged"] {
            let fixture = GitFixture::new();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            if kind == "ignored" {
                std::fs::write(
                    fixture.repository.join(".git/info/exclude"),
                    "retained.tmp\n",
                )
                .unwrap();
            }
            std::fs::write(fixture.target.join("retained.tmp"), b"must survive").unwrap();
            if kind == "staged" {
                fixture.git(&["-C", &record.target, "add", "retained.tmp"]);
            }
            assert_eq!(
                owner_cleanup_command(
                    &fixture.private,
                    &cleanup_manager(),
                    "preview_worktree_cleanup",
                    json!({"attempt":record.attempt}),
                    |_| panic!("dirty must not trash")
                )
                .unwrap_err(),
                "worktree_not_clean",
                "{kind}"
            );
            assert_eq!(
                std::fs::read(fixture.target.join("retained.tmp")).unwrap(),
                b"must survive"
            );
            assert!(fixture
                .git(&["worktree", "list", "--porcelain"])
                .contains(&record.target));
        }
    }
    #[test]
    fn t13_cleanup_index_flags_refuse_clean_and_hidden_changes_before_preview_or_confirm() {
        let _serial = serial_worktree_test();
        for flag in ["--assume-unchanged", "--skip-worktree"] {
            for changed in [false, true] {
                let fixture = GitFixture::new();
                let manager = cleanup_manager();
                let create = preview_create(&fixture.private, &fixture.input()).unwrap();
                let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
                let preview = cleanup_preview(&fixture, &manager, &record);
                fixture.git(&["-C", &record.target, "update-index", flag, "file.txt"]);
                if changed {
                    std::fs::write(fixture.target.join("file.txt"), b"hidden retained").unwrap();
                }
                assert_eq!(
                    owner_cleanup_command(
                        &fixture.private,
                        &manager,
                        "preview_worktree_cleanup",
                        json!({"attempt":record.attempt}),
                        |_| panic!("flag must not Trash")
                    )
                    .unwrap_err(),
                    "git_conversion_unsupported",
                    "{flag}/{changed}"
                );
                assert!(owner_cleanup_command(
                    &fixture.private,
                    &manager,
                    "cleanup_worktree",
                    json!({"attempt":record.attempt,"preview":preview["preview"]}),
                    |_| panic!("flag must not Trash")
                )
                .is_err());
                assert!(fixture.target.join("file.txt").exists());
                assert!(fixture
                    .git(&["worktree", "list", "--porcelain"])
                    .contains(&record.target));
                assert_eq!(
                    list_managed(&fixture.private).unwrap()[0].state,
                    RecordState::Created
                );
            }
        }
    }
    #[test]
    fn t13_cleanup_config_checkpoint_recreated_target_prevents_remove_and_trash() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        let target = fixture.target.clone();
        let hit = std::rc::Rc::new(std::cell::Cell::new(false));
        let mark = hit.clone();
        CLEANUP_ACTION.with(|action| {
            *action.borrow_mut() = Some(Box::new(move |stage| {
                if stage == CleanupFault::ConfigChecked {
                    mark.set(true);
                    std::fs::create_dir(&target).unwrap();
                    std::fs::write(target.join("foreign"), b"foreign retained").unwrap();
                }
            }))
        });
        let result = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| panic!("foreign target must not Trash"),
        );
        CLEANUP_ACTION.with(|action| *action.borrow_mut() = None);
        assert!(hit.get(), "actual config checkpoint must be hit");
        let result = result.unwrap();
        assert_eq!(result["cleanup"]["reason"], "worktree_target_occupied");
        assert_eq!(
            std::fs::read(fixture.target.join("foreign")).unwrap(),
            b"foreign retained"
        );
        assert!(
            Path::new(result["cleanup"]["retained_path"].as_str().unwrap())
                .join("file.txt")
                .exists()
        );
        assert!(fixture
            .git(&["worktree", "list", "--porcelain"])
            .contains(&record.target));
    }
    #[test]
    fn t13_cleanup_actual_unknown_native_adapter_and_reopen_projection_preserve_uncertainty() {
        let _serial = serial_worktree_test();
        for mode in [
            "unknown_error",
            "generic_error_moved",
            "crash_before_url",
            "saved_url",
        ] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            let destination = fixture.owned.0.join("mock Trash uncertain");
            let fault = match mode {
                "crash_before_url" => Some(CleanupFault::NativeReturned),
                "saved_url" => Some(CleanupFault::ReturnedSaved),
                _ => None,
            };
            CLEANUP_FAULT.with(|slot| slot.set(fault));
            CLEANUP_FAULT_HIT.with(|slot| slot.set(None));
            let result = owner_cleanup_command(
                &fixture.private,
                &manager,
                "cleanup_worktree",
                json!({"attempt":record.attempt,"preview":preview["preview"]}),
                |q| {
                    std::fs::rename(q, &destination).unwrap();
                    match mode {
                        "unknown_error" => Err("worktree_native_result_unknown".into()),
                        "generic_error_moved" => Err("fixed test native failure".into()),
                        _ => Ok(destination.clone()),
                    }
                },
            );
            CLEANUP_FAULT.with(|slot| slot.set(None));
            if let Some(fault) = fault {
                assert_eq!(CLEANUP_FAULT_HIT.with(|slot| slot.get()), Some(fault));
                assert!(result.is_err());
            } else {
                assert_eq!(
                    result.unwrap()["cleanup"]["reason"],
                    "worktree_native_result_unknown",
                    "{mode}"
                );
            }
            let records = list_managed(&fixture.private).unwrap();
            let manifest = read_manifest(&fixture.private).unwrap();
            let projected =
                record_projection(&records[0], manifest.cleanup.get(&record.attempt)).unwrap();
            assert_eq!(projected["state"], "removing");
            assert_eq!(projected["cleanup"]["recovery_needed"], true);
            if mode == "saved_url" {
                assert_eq!(
                    projected["cleanup"]["returned_path"],
                    destination.to_str().unwrap()
                );
            } else {
                assert_eq!(
                    projected["cleanup"]["reason"], "worktree_native_result_unknown",
                    "{mode}"
                );
                assert!(projected["cleanup"]["returned_path"].is_null());
            }
            assert!(destination.join("file.txt").exists());
            assert_eq!(
                owner_cleanup_command(
                    &fixture.private,
                    &manager,
                    "cleanup_worktree",
                    json!({"attempt":record.attempt,"preview":preview["preview"]}),
                    |_| panic!("never repeat unknown move")
                )
                .unwrap_err(),
                "worktree_recovery_needed"
            );
        }
    }
    fn cleanup_manager() -> crate::SessionManager {
        let manager = crate::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        manager
            .system_entry
            .lock()
            .unwrap()
            .initialize(&"c".repeat(64), true, true, || Ok(()))
            .unwrap();
        manager
    }
    fn cleanup_preview(
        fixture: &GitFixture,
        manager: &crate::SessionManager,
        record: &ManagedRecord,
    ) -> serde_json::Value {
        owner_cleanup_command(
            &fixture.private,
            manager,
            "preview_worktree_cleanup",
            json!({"attempt":record.attempt}),
            |_| panic!("preview trash"),
        )
        .unwrap()
    }
    fn native_attribute_fixture(repository_name: &str, target_name: &str) -> GitFixture {
        let mut fixture = GitFixture::new();
        let repository = fixture.owned.0.join(repository_name);
        std::fs::rename(&fixture.repository, &repository).unwrap();
        fixture.repository = repository;
        fixture.target = fixture.owned.0.join(target_name);
        std::fs::create_dir(fixture.repository.join("nested")).unwrap();
        std::fs::write(
            fixture.repository.join(".gitattributes"),
            b"*.txt text eol=lf\n",
        )
        .unwrap();
        std::fs::write(
            fixture.repository.join("nested/.gitattributes"),
            b"*.txt text\n",
        )
        .unwrap();
        std::fs::write(
            fixture.repository.join("nested/file.txt"),
            b"nested fixture\n",
        )
        .unwrap();
        fixture.git(&["add", ".gitattributes", "nested"]);
        fixture.git(&["commit", "-m", "attribute fixture"]);
        std::fs::write(
            fixture.repository.join(".git/info/attributes"),
            b"file.txt text\n",
        )
        .unwrap();
        fixture
    }

    fn assert_native_attribute_cleanup(repository_name: &str, target_name: &str) {
        let fixture = native_attribute_fixture(repository_name, target_name);
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        let calls = std::cell::Cell::new(0);
        let trash = fixture.owned.0.join("injected-disposition");
        let result = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |q| {
                calls.set(calls.get() + 1);
                std::fs::rename(q, &trash).unwrap();
                Ok(trash.clone())
            },
        )
        .unwrap();
        assert_eq!(
            result["state"], "removed",
            "unchanged attributes must survive quarantine relocation"
        );
        assert_eq!(result["cleanup"]["phase"], "trashed");
        assert_eq!(calls.get(), 1);
        assert_eq!(
            std::fs::read(trash.join("nested/.gitattributes")).unwrap(),
            b"*.txt text\n"
        );
        assert_eq!(
            std::fs::read(trash.join("nested/file.txt")).unwrap(),
            b"nested fixture\n"
        );
        assert_eq!(fixture.git(&["rev-parse", &record.branch]), record.commit);
    }

    #[test]
    fn t13_native_attributes_sibling_layout_cleanup_reaches_removed() {
        let _serial = serial_worktree_test();
        assert_native_attribute_cleanup("synthetic-repository", "synthetic-worktree");
    }

    #[test]
    fn t13_native_attributes_reverse_lexical_layout_cleanup_reaches_removed() {
        let _serial = serial_worktree_test();
        assert_native_attribute_cleanup("z-repository", "a-worktree");
    }

    #[test]
    fn t13_native_attributes_value_and_presence_changes_refuse_disposition() {
        let _serial = serial_worktree_test();
        for remove in [false, true] {
            let fixture = native_attribute_fixture("synthetic-repository", "synthetic-worktree");
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            let attributes = fixture.repository.join(".git/info/attributes");
            let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let observed = hit.clone();
            CLEANUP_ACTION.with(|action| {
                *action.borrow_mut() = Some(Box::new(move |stage| {
                    if stage == CleanupFault::Quarantined {
                        observed.store(true, std::sync::atomic::Ordering::SeqCst);
                        if remove {
                            std::fs::remove_file(&attributes).unwrap();
                        } else {
                            std::fs::write(&attributes, b"file.txt text eol=lf\n").unwrap();
                        }
                    }
                }));
            });
            let result = owner_cleanup_command(
                &fixture.private,
                &manager,
                "cleanup_worktree",
                json!({"attempt":record.attempt,"preview":preview["preview"]}),
                |_| panic!("changed attributes must not reach disposition"),
            )
            .unwrap();
            CLEANUP_ACTION.with(|action| *action.borrow_mut() = None);
            assert!(hit.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(result["state"], "removing");
            assert_eq!(result["cleanup"]["reason"], "worktree_cleanup_changed");
            assert_eq!(result["cleanup"]["recovery_needed"], true);
            assert!(
                Path::new(result["cleanup"]["retained_path"].as_str().unwrap())
                    .join("file.txt")
                    .exists()
            );
            assert!(fixture
                .git(&["worktree", "list", "--porcelain"])
                .contains(&record.target));
        }
    }

    #[test]
    fn t13_cleanup_native_injected_success_retains_branch_and_idempotent_result() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        let calls = std::cell::Cell::new(0);
        let trash = fixture.owned.0.join("mock Trash 中");
        let result = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |q| {
                calls.set(calls.get() + 1);
                assert!(!fixture.target.exists());
                assert!(!fixture
                    .git(&["worktree", "list", "--porcelain"])
                    .contains(&record.target));
                std::fs::rename(q, &trash).unwrap();
                Ok(trash.clone())
            },
        )
        .unwrap();
        assert_eq!(result["state"], "removed");
        assert_eq!(result["cleanup"]["phase"], "trashed");
        assert_eq!(
            std::fs::read(trash.join("file.txt")).unwrap(),
            b"committed fixture\n"
        );
        assert_eq!(fixture.git(&["rev-parse", &record.branch]), record.commit);
        let replay = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| panic!("must not repeat native trash"),
        )
        .unwrap();
        assert_eq!(result, replay);
        assert_eq!(calls.get(), 1);
    }
    #[test]
    fn t13_cleanup_current_clean_commit_is_confirmed_and_retained() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        std::fs::write(fixture.target.join("file.txt"), b"new commit\n").unwrap();
        fixture.git(&["-C", &record.target, "add", "file.txt"]);
        fixture.git(&[
            "-C",
            &record.target,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "new",
        ]);
        let head = fixture.git(&["-C", &record.target, "rev-parse", "HEAD"]);
        assert_ne!(head, record.commit);
        let preview = cleanup_preview(&fixture, &manager, &record);
        assert_eq!(preview["commit"], head);
    }
    #[test]
    fn t13_cleanup_native_error_and_wrong_result_are_durable_manual_recovery() {
        let _serial = serial_worktree_test();
        for wrong in [false, true] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            let result = owner_cleanup_command(
                &fixture.private,
                &manager,
                "cleanup_worktree",
                json!({"attempt":record.attempt,"preview":preview["preview"]}),
                |_| {
                    if wrong {
                        Ok(fixture.repository.clone())
                    } else {
                        Err("SENSITIVE native error".into())
                    }
                },
            )
            .unwrap();
            assert_eq!(result["state"], "removing");
            assert_eq!(result["cleanup"]["recovery_needed"], true);
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("SENSITIVE"));
            assert!(!fixture.target.exists());
            let retained = Path::new(result["cleanup"]["retained_path"].as_str().unwrap());
            assert!(retained.join("file.txt").exists());
            assert_eq!(
                owner_cleanup_command(
                    &fixture.private,
                    &manager,
                    "cleanup_worktree",
                    json!({"attempt":record.attempt,"preview":preview["preview"]}),
                    |_| panic!("nonfinal cannot retry Trash")
                )
                .unwrap_err(),
                "worktree_recovery_needed"
            );
            assert_eq!(
                list_managed(&fixture.private).unwrap()[0].state,
                RecordState::Removing
            );
        }
    }
    #[test]
    fn t13_cleanup_preview_change_and_owner_replacement_refuse_before_move() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        std::fs::write(fixture.target.join("file.txt"), b"changed").unwrap();
        assert!(owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| panic!("changed trash")
        )
        .is_err());
        assert!(fixture.target.exists());
        let replacement = cleanup_manager();
        replacement
            .system_entry
            .lock()
            .unwrap()
            .pause
            .as_mut()
            .unwrap()
            .owner_instance = "d".repeat(64);
        assert!(owner_cleanup_command(
            &fixture.private,
            &replacement,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| panic!("replacement trash")
        )
        .is_err());
        assert!(fixture.target.exists());
    }

    #[derive(Debug)]
    struct InertChild;
    impl portable_pty::ChildKiller for InertChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }
    impl portable_pty::Child for InertChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }
    fn inert_session(
        fixture: &GitFixture,
        cwd: &Path,
        completed: bool,
    ) -> std::sync::Arc<crate::Session> {
        use std::sync::atomic::AtomicBool;
        use std::sync::{Condvar, Mutex};
        let history = std::sync::Arc::new(
            crate::HistoryStore::open(fixture.owned.0.join("mock-history")).unwrap(),
        );
        std::sync::Arc::new(crate::Session {
            _resume_claim: None,
            summary: crate::SessionSummary {
                session_id: "s-1-1".into(),
                cwd: cwd.to_str().unwrap().into(),
                command: None,
                status: "succeeded".into(),
                launch: None,
            },
            master: Mutex::new(None),
            writer: Mutex::new(Box::new(std::io::sink())),
            child: Mutex::new(Box::new(InertChild)),
            #[cfg(windows)]
            job: None,
            log: Mutex::new(crate::SessionLog {
                file: std::fs::File::create(fixture.owned.0.join("mock-log")).unwrap(),
                end_offset: 0,
                error: None,
            }),
            terminal: None,
            output_done: (Mutex::new(false), Condvar::new()),
            cancel_output: AtomicBool::new(false),
            protocol: Mutex::new(crate::AgentProtocol::new(None)),
            history,
            stop_requested: AtomicBool::new(false),
            idle_notified: AtomicBool::new(false),
            completed: (Mutex::new(completed), Condvar::new()),
            last_activity: Mutex::new(std::time::Instant::now()),
            status: Mutex::new("succeeded".into()),
        })
    }
    #[test]
    fn t13_cleanup_actual_sessions_finishing_child_alias_guard_and_ended_release() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        std::fs::create_dir(fixture.target.join("sub")).unwrap();
        let session = inert_session(&fixture, &fixture.target.join("sub"), false);
        manager
            .sessions
            .lock()
            .unwrap()
            .insert("s-1-1".into(), session.clone());
        assert_eq!(
            owner_cleanup_command(
                &fixture.private,
                &manager,
                "preview_worktree_cleanup",
                json!({"attempt":record.attempt}),
                |_| panic!("active trash")
            )
            .unwrap_err(),
            "worktree_active"
        );
        *session.completed.0.lock().unwrap() = true;
        // Empty directories are not file changes, but are retained and bounded by the inventory.
        assert!(owner_cleanup_command(
            &fixture.private,
            &manager,
            "preview_worktree_cleanup",
            json!({"attempt":record.attempt}),
            |_| panic!("preview trash")
        )
        .is_ok());
        let gate = start_guard().unwrap();
        assert_eq!(
            owner_cleanup_command(
                &fixture.private,
                &manager,
                "preview_worktree_cleanup",
                json!({"attempt":record.attempt}),
                |_| panic!("busy trash")
            )
            .unwrap_err(),
            "worktree_busy"
        );
        drop(gate);
    }

    #[test]
    fn t13_cleanup_every_reached_boundary_reopens_without_disposition_or_false_success() {
        let _serial = serial_worktree_test();
        for stage in [
            CleanupFault::Prepared,
            CleanupFault::Renamed,
            CleanupFault::Quarantined,
            CleanupFault::Unregistered,
            CleanupFault::Trashing,
            CleanupFault::NativeReturned,
            CleanupFault::ReturnedSaved,
        ] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            CLEANUP_FAULT.with(|fault| fault.set(Some(stage)));
            CLEANUP_FAULT_HIT.with(|hit| hit.set(None));
            let destination = fixture.owned.0.join("mock recovered Trash");
            let result = owner_cleanup_command(
                &fixture.private,
                &manager,
                "cleanup_worktree",
                json!({"attempt":record.attempt,"preview":preview["preview"]}),
                |q| {
                    std::fs::rename(q, &destination).unwrap();
                    Ok(destination.clone())
                },
            );
            CLEANUP_FAULT.with(|fault| fault.set(None));
            assert_eq!(
                CLEANUP_FAULT_HIT.with(|hit| hit.get()),
                Some(stage),
                "fault must really be reached"
            );
            assert!(result.is_err());
            let before = read_manifest(&fixture.private).unwrap();
            let q = Path::new(&before.cleanup[&record.attempt].quarantine);
            assert!(
                fixture.target.join("file.txt").exists()
                    || q.join("file.txt").exists()
                    || destination.join("file.txt").exists()
            );
            let records = list_managed(&fixture.private).unwrap();
            let after = read_manifest(&fixture.private).unwrap();
            if stage == CleanupFault::Prepared {
                assert_eq!(records[0].state, RecordState::Created);
                assert!(!after.cleanup.contains_key(&record.attempt));
                assert_eq!(
                    owner_cleanup_command(
                        &fixture.private,
                        &manager,
                        "cleanup_worktree",
                        json!({"attempt":record.attempt,"preview":preview["preview"]}),
                        |_| panic!("old token")
                    )
                    .unwrap_err(),
                    "worktree_preview_changed"
                );
            } else {
                assert_eq!(records[0].state, RecordState::Removing);
                assert_eq!(
                    after.cleanup[&record.attempt].reason.as_deref(),
                    Some(if stage == CleanupFault::NativeReturned {
                        "worktree_native_result_unknown"
                    } else {
                        "worktree_recovery_needed"
                    })
                );
                assert_eq!(
                    owner_cleanup_command(
                        &fixture.private,
                        &manager,
                        "cleanup_worktree",
                        json!({"attempt":record.attempt,"preview":preview["preview"]}),
                        |_| panic!("no nonfinal retry")
                    )
                    .unwrap_err(),
                    "worktree_recovery_needed"
                );
            }
            assert_eq!(fixture.git(&["rev-parse", &record.branch]), record.commit);
        }
    }
    #[test]
    fn t13_cleanup_quarantine_cannot_be_started_as_unmanaged_directory() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        let result = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| Err("native failed".into()),
        )
        .unwrap();
        let q = Path::new(result["cleanup"]["retained_path"].as_str().unwrap());
        assert_eq!(
            prepare_start(&fixture.private, q, None).err().as_deref(),
            Some("worktree_not_ready")
        );
    }
    #[test]
    fn t13_cleanup_late_handle_write_remains_in_injected_trash() {
        use std::io::Write;
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(fixture.target.join("file.txt"))
            .unwrap();
        let destination = fixture.owned.0.join("mock late write Trash");
        let result = owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |q| {
                std::fs::rename(q, &destination).unwrap();
                handle.write_all(b"late data").unwrap();
                Ok(destination.clone())
            },
        )
        .unwrap();
        assert_eq!(result["state"], "removed");
        assert!(std::fs::read(destination.join("file.txt"))
            .unwrap()
            .ends_with(b"late data"));
    }

    #[test]
    fn t13_cleanup_filters_nested_gitlink_and_inventory_limit_fail_closed() {
        let _serial = serial_worktree_test();
        for kind in ["clean", "smudge", "process", "nested", "gitlink", "limit"] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let marker = fixture.owned.0.join("must-not-execute");
            let expected = match kind {
                "clean" | "smudge" | "process" => {
                    fixture.git(&[
                        "config",
                        &format!("filter.fixture.{kind}"),
                        &format!("touch '{}'", marker.display()),
                    ]);
                    if kind == "smudge" {
                        "git_conversion_unsupported"
                    } else {
                        "git_external_filter"
                    }
                }
                "nested" => {
                    std::fs::create_dir_all(fixture.target.join("nested/.git")).unwrap();
                    "git_nested_repository"
                }
                "gitlink" => {
                    fixture.git(&[
                        "-C",
                        &record.target,
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        &format!("160000,{},sub", record.commit),
                    ]);
                    fixture.git(&[
                        "-C",
                        &record.target,
                        "-c",
                        "user.name=Fixture",
                        "-c",
                        "user.email=fixture@example.invalid",
                        "commit",
                        "-m",
                        "gitlink",
                    ]);
                    "git_submodule_unavailable"
                }
                _ => {
                    for index in 0..4097 {
                        std::fs::write(fixture.target.join(format!("entry-{index}")), b"").unwrap();
                    }
                    "git_output_limit"
                }
            };
            assert_eq!(
                owner_cleanup_command(
                    &fixture.private,
                    &manager,
                    "preview_worktree_cleanup",
                    json!({"attempt":record.attempt}),
                    |_| panic!("refused trash")
                )
                .unwrap_err(),
                expected,
                "{kind}"
            );
            assert!(!marker.exists());
            assert!(fixture.target.join("file.txt").exists());
        }
    }
    #[test]
    fn t13_cleanup_expired_revision_locked_and_dirty_after_preview_never_move() {
        let _serial = serial_worktree_test();
        for kind in ["expired", "revision", "locked", "dirty", "config"] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            match kind {
                "expired" => {
                    CLEANUP_PREVIEWS
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .find(|item| item.token == preview["preview"])
                        .unwrap()
                        .expires = std::time::Instant::now();
                }
                "revision" => {
                    let mut manifest = read_manifest(&fixture.private).unwrap();
                    manifest.revision += 1;
                    save_manifest(&fixture.private, &manifest).unwrap();
                }
                "locked" => {
                    fixture.git(&["worktree", "lock", &record.target]);
                }
                "dirty" => {
                    std::fs::write(fixture.target.join("new ignored"), b"retain").unwrap();
                }
                _ => {
                    fixture.git(&["config", "core.autocrlf", "true"]);
                }
            }
            assert!(
                owner_cleanup_command(
                    &fixture.private,
                    &manager,
                    "cleanup_worktree",
                    json!({"attempt":record.attempt,"preview":preview["preview"]}),
                    |_| panic!("must not trash")
                )
                .is_err(),
                "{kind}"
            );
            assert!(fixture.target.join("file.txt").exists());
            assert!(fixture
                .git(&["worktree", "list", "--porcelain"])
                .contains(&record.target));
        }
    }

    #[test]
    fn t13_cleanup_observed_postrename_mutation_and_recreated_target_preserve_both() {
        let _serial = serial_worktree_test();
        for recreate in [false, true] {
            let fixture = GitFixture::new();
            let manager = cleanup_manager();
            let create = preview_create(&fixture.private, &fixture.input()).unwrap();
            let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
            let preview = cleanup_preview(&fixture, &manager, &record);
            let private = fixture.private.clone();
            let target = fixture.target.clone();
            let attempt = record.attempt.clone();
            CLEANUP_ACTION.with(|action| {
                *action.borrow_mut() = Some(Box::new(move |stage| {
                    if stage == CleanupFault::Quarantined {
                        if recreate {
                            std::fs::create_dir(&target).unwrap();
                            std::fs::write(target.join("foreign"), b"foreign retained").unwrap();
                        } else {
                            let manifest = read_manifest(&private).unwrap();
                            std::fs::write(
                                Path::new(&manifest.cleanup[&attempt].quarantine)
                                    .join("late ignored"),
                                b"late retained",
                            )
                            .unwrap();
                        }
                    }
                }))
            });
            let result = owner_cleanup_command(
                &fixture.private,
                &manager,
                "cleanup_worktree",
                json!({"attempt":record.attempt,"preview":preview["preview"]}),
                |_| panic!("must not Trash changed tree"),
            )
            .unwrap();
            CLEANUP_ACTION.with(|action| *action.borrow_mut() = None);
            assert_eq!(result["state"], "removing");
            assert_eq!(result["cleanup"]["recovery_needed"], true);
            let q = Path::new(result["cleanup"]["retained_path"].as_str().unwrap());
            assert!(q.join("file.txt").exists());
            if recreate {
                assert_eq!(
                    std::fs::read(fixture.target.join("foreign")).unwrap(),
                    b"foreign retained"
                );
            } else {
                assert_eq!(
                    std::fs::read(q.join("late ignored")).unwrap(),
                    b"late retained"
                );
            }
            assert!(fixture
                .git(&["worktree", "list", "--porcelain"])
                .contains(&record.target));
        }
    }
    #[test]
    fn t13_cleanup_journal_wrong_path_and_phase_are_rejected_without_recovery_action() {
        let _serial = serial_worktree_test();
        let fixture = GitFixture::new();
        let manager = cleanup_manager();
        let create = preview_create(&fixture.private, &fixture.input()).unwrap();
        let record = create_managed(&fixture.private, &create.record.attempt).unwrap();
        let preview = cleanup_preview(&fixture, &manager, &record);
        owner_cleanup_command(
            &fixture.private,
            &manager,
            "cleanup_worktree",
            json!({"attempt":record.attempt,"preview":preview["preview"]}),
            |_| Err("fake native failure".into()),
        )
        .unwrap();
        let baseline: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.private.join("worktrees.json")).unwrap())
                .unwrap();
        for (field, value) in [
            ("original", json!(fixture.repository)),
            ("quarantine", json!(fixture.repository)),
            ("returned", json!([0, 1])),
            ("phase", json!("config_checked")),
            ("parent_identity", json!("arbitrary-secret")),
        ] {
            let mut bad = baseline.clone();
            bad["cleanup"][&record.attempt][field] = value;
            assert!(
                decode_manifest(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "must reject {field}"
            );
        }
        let mut bad = baseline;
        bad["cleanup"][&record.attempt]["phase"] = json!("trashed");
        bad["cleanup"][&record.attempt]["reason"] = serde_json::Value::Null;
        bad["cleanup"][&record.attempt]["returned"] = json!([47, 116, 109, 112]);
        assert!(
            decode_manifest(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "nonfinal record cannot claim trashed journal"
        );
    }
}

use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::fs::OpenOptions;
use std::{fs, path::Path};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordState {
    Creating,
    Created,
    Failed,
    Removing,
    Removed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagedRecord {
    pub attempt: String,
    pub session_id: String,
    pub repository: String,
    pub common_dir: String,
    pub target: String,
    pub branch: String,
    pub commit: String,
    pub state: RecordState,
    pub checkout_complete: bool,
    pub session_claimed: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub revision: u64,
    pub records: Vec<ManagedRecord>,
    #[serde(default)]
    identities: std::collections::BTreeMap<String, WorktreeIdentity>,
    #[serde(default)]
    cleanup: std::collections::BTreeMap<String, CleanupJournal>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorktreeIdentity {
    repository: String,
    common: String,
    target: Option<String>,
}

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
static LIFECYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static CLAIM: std::sync::Mutex<()> = std::sync::Mutex::new(());
static NEXT_WRITE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn decode_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("worktree_manifest_limit".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "worktree_manifest_invalid")?;
    if manifest.version != 1
        || manifest.records.len() > 256
        || manifest.identities.len() > manifest.records.len()
        || manifest.cleanup.len() > manifest.records.len()
    {
        return Err("worktree_manifest_invalid".into());
    }
    let mut attempts = std::collections::HashSet::new();
    let mut sessions = std::collections::HashSet::new();
    for record in &manifest.records {
        if record.attempt.len() != 64
            || !record.attempt.bytes().all(|b| b.is_ascii_hexdigit())
            || record.commit.len() != 40
            || !record.commit.bytes().all(|b| b.is_ascii_hexdigit())
            || !attempts.insert(&record.attempt)
            || !sessions.insert(&record.session_id)
            || record.session_id.len() > 128
            || !record.session_id.starts_with("s-")
            || record.session_id.chars().any(char::is_control)
            || [&record.repository, &record.common_dir, &record.target]
                .iter()
                .any(|path| {
                    path.len() > 4096
                        || !std::path::Path::new(path).is_absolute()
                        || path.chars().any(char::is_control)
                })
            || record.branch.is_empty()
            || record.branch.len() > 1024
            || record.branch.chars().any(char::is_control)
            || (record.branch.starts_with("codex/yam/")
                && record.branch != format!("codex/yam/{}", record.session_id))
            || (record.state == RecordState::Created && !record.checkout_complete)
        {
            return Err("worktree_manifest_invalid".into());
        }
    }
    for (attempt, identity) in &manifest.identities {
        if !attempts.iter().any(|known| known.as_str() == attempt)
            || [&identity.repository, &identity.common]
                .iter()
                .any(|value| {
                    value.is_empty()
                        || value.len() > 128
                        || value
                            .chars()
                            .any(|character| !character.is_ascii_digit() && character != ':')
                })
            || identity.target.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || value
                        .chars()
                        .any(|character| !character.is_ascii_digit() && character != ':')
            })
        {
            return Err("worktree_manifest_invalid".into());
        }
    }
    for (attempt, journal) in &manifest.cleanup {
        let record = manifest
            .records
            .iter()
            .find(|record| &record.attempt == attempt)
            .ok_or("worktree_manifest_invalid")?;
        let expected_quarantine = Path::new(&record.target)
            .parent()
            .ok_or("worktree_manifest_invalid")?
            .join(format!(".yam-quarantine-{}", journal.token))
            .join("worktree");
        if journal.original != record.target
            || Path::new(&journal.quarantine) != expected_quarantine
            || (journal.phase == CleanupPhase::Trashed && record.state != RecordState::Removed)
            || (journal.phase != CleanupPhase::Trashed && record.state != RecordState::Removing)
            || [&journal.parent_identity, &journal.target_identity]
                .iter()
                .any(|value| {
                    value.is_empty() || value.chars().any(|ch| !ch.is_ascii_digit() && ch != ':')
                })
            || journal
                .returned
                .as_ref()
                .is_some_and(|value| !value.starts_with(b"/") || value.contains(&0))
            || !attempts.iter().any(|known| known.as_str() == attempt)
            || !valid_token(&journal.token)
            || !valid_token(&journal.owner)
            || [&journal.original, &journal.quarantine]
                .iter()
                .any(|value| {
                    value.len() > 4096
                        || !Path::new(value).is_absolute()
                        || value.chars().any(char::is_control)
                })
            || journal
                .returned
                .as_ref()
                .is_some_and(|value| value.len() > 4096 || value.is_empty())
            || journal.target_identity.len() > 128
            || journal.parent_identity.len() > 128
            || journal
                .reason
                .as_ref()
                .is_some_and(|value| !CLEANUP_REASONS.contains(&value.as_str()))
            || (journal.phase == CleanupPhase::Trashed
                && (journal.returned.is_none() || journal.reason.is_some()))
        {
            return Err("worktree_manifest_invalid".into());
        }
    }
    Ok(manifest)
}
fn read_manifest(root: &std::path::Path) -> Result<Manifest, String> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(root.join("worktrees.json"))
        .map_err(|_| "worktree_manifest_unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "worktree_manifest_unavailable")?
        .is_file()
    {
        return Err("worktree_manifest_unavailable".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "worktree_manifest_unavailable")?;
    decode_manifest(&bytes)
}
fn save_manifest(root: &std::path::Path, manifest: &Manifest) -> Result<(), String> {
    use std::io::Write;
    let bytes = serde_json::to_vec(manifest).map_err(|_| "worktree_manifest_invalid")?;
    decode_manifest(&bytes)?;
    crate::background::private_root(root).map_err(|_| "worktree_manifest_unavailable")?;
    let target = root.join("worktrees.json");
    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("worktree_manifest_unavailable".into());
        }
    }
    let sequence = NEXT_WRITE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = root.join(format!("worktrees-{}-{sequence}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "worktree_manifest_unavailable")?;
    #[cfg(windows)]
    crate::background::protect_windows_path(&temporary)
        .map_err(|_| "worktree_manifest_unavailable")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "worktree_manifest_unavailable")?;
    drop(file);
    std::fs::rename(&temporary, &target).map_err(|_| "worktree_manifest_unavailable")?;
    #[cfg(unix)]
    std::fs::File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(|_| "worktree_manifest_unavailable")?;
    Ok(())
}
// Record-layer only: production must verify actual canonical/Git ownership before calling this.
fn claim_record(
    root: &std::path::Path,
    attempt: &str,
    cwd: &std::path::Path,
) -> Result<String, String> {
    let _claim = CLAIM.lock().map_err(|_| "worktree_busy")?;
    let mut manifest = read_manifest(root)?;
    let record = manifest
        .records
        .iter_mut()
        .find(|record| record.attempt == attempt)
        .ok_or("worktree_unknown_attempt")?;
    if std::path::Path::new(&record.target) != cwd {
        return Err("worktree_identity_changed".into());
    }
    if record.state != RecordState::Created || !record.checkout_complete {
        return Err("worktree_not_ready".into());
    }
    if record.session_claimed {
        return Err("worktree_session_consumed".into());
    }
    record.session_claimed = true;
    let session = record.session_id.clone();
    manifest.revision = manifest
        .revision
        .checked_add(1)
        .ok_or("worktree_manifest_invalid")?;
    save_manifest(root, &manifest)?;
    Ok(session)
}
fn reconcile_record(record: &ManagedRecord, _registered: bool) -> Result<ManagedRecord, String> {
    let mut record = record.clone();
    if record.state == RecordState::Creating {
        record.state = RecordState::Failed;
        record.checkout_complete = false;
    }
    Ok(record)
}
#[cfg(test)]
fn validate_cleanup(
    record: &ManagedRecord,
    active: &[std::path::PathBuf],
    dirty: bool,
    untracked: bool,
    ignored: bool,
    nested: bool,
) -> Result<(), String> {
    if active.iter().any(|path| path.starts_with(&record.target)) {
        return Err("worktree_active".into());
    }
    if dirty || untracked || ignored || nested {
        return Err("worktree_not_clean".into());
    }
    if record.state != RecordState::Created || !record.checkout_complete {
        return Err("worktree_not_ready".into());
    }
    Ok(())
}
fn validate_filter_config(bytes: &[u8]) -> Result<(), String> {
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let entry = std::str::from_utf8(entry).map_err(|_| "worktree_config_unavailable")?;
        let (key, value) = entry
            .split_once('\n')
            .ok_or("worktree_config_unavailable")?;
        let key = key.to_ascii_lowercase();
        if key.starts_with("filter.")
            && [".clean", ".smudge", ".process"]
                .iter()
                .any(|suffix| key.ends_with(suffix))
            && !value.trim().is_empty()
        {
            return Err("worktree_external_filter".into());
        }
    }
    Ok(())
}
pub(crate) fn start_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    LIFECYCLE.try_lock().map_err(|_| "worktree_busy".into())
}
#[cfg(test)]
fn cleanup_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    LIFECYCLE.try_lock().map_err(|_| "worktree_busy".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateInput {
    pub root: String,
    pub target: String,
    pub reference: String,
    pub branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CreatePreview {
    #[serde(flatten)]
    pub record: ManagedRecord,
    pub reference: String,
    pub revision: u64,
}

#[derive(Clone)]
struct PendingCreate {
    private: std::path::PathBuf,
    input: CreateInput,
    preview: CreatePreview,
    identity: WorktreeIdentity,
    expires: std::time::Instant,
}
static PREVIEWS: std::sync::Mutex<Vec<PendingCreate>> = std::sync::Mutex::new(Vec::new());
fn git_text(
    git: &std::path::Path,
    path: &std::path::Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    budget: &mut crate::git_context::Budget,
    args: &[&str],
) -> Result<String, String> {
    let output = crate::git_context::git_command(git, path, env, budget, args)?;
    if !output.status.success() {
        return Err("worktree_git_unavailable".into());
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(|_| "worktree_git_unavailable".into())
}
fn installed_git() -> Result<std::path::PathBuf, String> {
    let candidate = crate::find_executable("git").ok_or("worktree_git_missing")?;
    crate::git_context::fixed_git(
        &candidate,
        &std::env::current_dir().map_err(|_| "worktree_git_missing")?,
    )
    .map_err(|_| "worktree_git_missing".into())
}
fn inspect_create(
    input: &CreateInput,
    session_id: &str,
    attempt: &str,
) -> Result<ManagedRecord, String> {
    use std::path::Path;
    let git = installed_git()?;
    let env = crate::git_context::config_environment()?;
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: MAX_MANIFEST_BYTES,
    };
    for value in [&input.root, &input.target, &input.reference] {
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("worktree_invalid_input".into());
        }
    }
    let root = std::fs::canonicalize(&input.root).map_err(|_| "worktree_invalid_root")?;
    if !root.is_dir() {
        return Err("worktree_invalid_root".into());
    }
    let discovered = git_text(
        &git,
        &root,
        &env,
        &mut budget,
        &["rev-parse", "--show-toplevel"],
    )?;
    let root = std::fs::canonicalize(discovered).map_err(|_| "worktree_invalid_root")?;
    if let Some(parent) = root.parent() {
        let discovery = crate::git_context::git_command(
            &git,
            parent,
            &env,
            &mut budget,
            &["rev-parse", "--show-toplevel"],
        )?;
        if discovery.status.success() {
            return Err("worktree_nested_repository".into());
        }
    }
    let target = Path::new(&input.target);
    if !target.is_absolute() {
        return Err("worktree_invalid_target".into());
    }
    match std::fs::symlink_metadata(target) {
        Ok(_) => return Err("worktree_target_occupied".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("worktree_invalid_target".into()),
    }
    let name = target.file_name().ok_or("worktree_invalid_target")?;
    if name == "." || name == ".." {
        return Err("worktree_invalid_target".into());
    }
    let parent = target
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or("worktree_invalid_target")?;
    let discovery = crate::git_context::git_command(
        &git,
        &parent,
        &env,
        &mut budget,
        &["rev-parse", "--show-toplevel"],
    )?;
    if discovery.status.success() {
        return Err("worktree_nested_repository".into());
    }
    let target = parent.join(name);
    let config = crate::git_context::git_command(
        &git,
        &root,
        &env,
        &mut budget,
        &["config", "--null", "--list"],
    )?;
    if !config.status.success() {
        return Err("worktree_config_unavailable".into());
    }
    validate_filter_config(&config.stdout)?;
    crate::git_context::safe_config(&config.stdout)
        .map_err(|_| "worktree_conversion_unsupported")?;
    if !(input.reference == "HEAD"
        || input.reference.starts_with("refs/heads/")
        || input.reference.starts_with("refs/tags/"))
    {
        return Err("worktree_ref_unavailable".into());
    }
    let reference = format!("{}^{{commit}}", input.reference);
    let commit = git_text(
        &git,
        &root,
        &env,
        &mut budget,
        &["rev-parse", "--verify", "--end-of-options", &reference],
    )
    .map_err(|_| "worktree_ref_unavailable")?;
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("worktree_ref_unavailable".into());
    }
    let tree = crate::git_context::git_command(
        &git,
        &root,
        &env,
        &mut budget,
        &["ls-tree", "-r", "-z", "--full-tree", &commit],
    )?;
    if !tree.status.success() {
        return Err("worktree_git_unavailable".into());
    }
    if tree
        .stdout
        .split(|byte| *byte == 0)
        .any(|entry| entry.starts_with(b"160000 "))
    {
        return Err("worktree_submodule_unsupported".into());
    }
    let branch = input
        .branch
        .clone()
        .unwrap_or_else(|| format!("codex/yam/{session_id}"));
    if branch.starts_with('-')
        || branch.chars().any(char::is_control)
        || branch.len() > 1024
        || (branch.starts_with("codex/yam/") && branch != format!("codex/yam/{session_id}"))
    {
        return Err("worktree_invalid_branch".into());
    }
    git_text(
        &git,
        &root,
        &env,
        &mut budget,
        &["check-ref-format", "--branch", &branch],
    )
    .map_err(|_| "worktree_invalid_branch")?;
    let branch_ref = format!("refs/heads/{branch}");
    let occupied = crate::git_context::git_command(
        &git,
        &root,
        &env,
        &mut budget,
        &["show-ref", "--verify", "--quiet", &branch_ref],
    )?;
    if occupied.status.success() {
        return Err("worktree_branch_occupied".into());
    }
    if occupied.status.code() != Some(1) {
        return Err("worktree_git_unavailable".into());
    }
    let common = git_text(
        &git,
        &root,
        &env,
        &mut budget,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = Path::new(&common)
        .canonicalize()
        .map_err(|_| "worktree_git_unavailable")?;
    Ok(ManagedRecord {
        attempt: attempt.into(),
        session_id: session_id.into(),
        repository: root.to_string_lossy().into(),
        common_dir: common.to_string_lossy().into(),
        target: target.to_string_lossy().into(),
        branch,
        commit,
        state: RecordState::Creating,
        checkout_complete: false,
        session_claimed: false,
    })
}
fn preview_create(private: &std::path::Path, input: &CreateInput) -> Result<CreatePreview, String> {
    let _gate = start_guard()?;
    let session_id = crate::next_session_id();
    let attempt = crate::agent_bridge::credential()?;
    let record = inspect_create(input, &session_id, &attempt)?;
    let revision = if private.join("worktrees.json").exists() {
        read_manifest(private)?.revision
    } else {
        0
    };
    let preview = CreatePreview {
        record,
        reference: input.reference.clone(),
        revision,
    };
    let mut pending = PREVIEWS.lock().map_err(|_| "worktree_busy")?;
    pending.retain(|item| item.expires > std::time::Instant::now());
    if pending.len() >= 32 {
        return Err("worktree_preview_limit".into());
    }
    pending.push(PendingCreate {
        private: private.to_path_buf(),
        input: input.clone(),
        preview: preview.clone(),
        identity: WorktreeIdentity {
            repository: directory_identity(std::path::Path::new(&preview.record.repository))?,
            common: directory_identity(std::path::Path::new(&preview.record.common_dir))?,
            target: None,
        },
        expires: std::time::Instant::now() + std::time::Duration::from_secs(600),
    });
    Ok(preview)
}

fn create_managed(private: &std::path::Path, attempt: &str) -> Result<ManagedRecord, String> {
    let _gate = start_guard()?;
    let mut manifest = match std::fs::symlink_metadata(private.join("worktrees.json")) {
        Ok(_) => read_manifest(private)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Manifest {
            version: 1,
            revision: 0,
            records: Vec::new(),
            identities: Default::default(),
            cleanup: Default::default(),
        },
        Err(_) => return Err("worktree_manifest_unavailable".into()),
    };
    if let Some(record) = manifest
        .records
        .iter()
        .find(|record| record.attempt == attempt)
    {
        return if record.state == RecordState::Created && record.checkout_complete {
            Ok(record.clone())
        } else {
            Err("worktree_not_ready".into())
        };
    }
    let pending = PREVIEWS
        .lock()
        .map_err(|_| "worktree_busy")?
        .iter()
        .find(|item| {
            item.private == private
                && item.preview.record.attempt == attempt
                && item.expires > std::time::Instant::now()
        })
        .cloned()
        .ok_or("worktree_unknown_attempt")?;
    let expected = &pending.preview.record;
    let record = inspect_create(&pending.input, &expected.session_id, &expected.attempt)?;
    if record.repository != expected.repository
        || record.common_dir != expected.common_dir
        || record.target != expected.target
        || record.branch != expected.branch
        || record.commit != expected.commit
        || manifest.revision != pending.preview.revision
    {
        return Err("worktree_preview_changed".into());
    }
    if manifest.records.len() >= 256 {
        return Err("worktree_manifest_limit".into());
    }
    if directory_identity(std::path::Path::new(&record.repository))? != pending.identity.repository
        || directory_identity(std::path::Path::new(&record.common_dir))? != pending.identity.common
    {
        return Err("worktree_identity_changed".into());
    }
    manifest
        .identities
        .insert(record.attempt.clone(), pending.identity.clone());
    manifest.records.push(record.clone());
    manifest.revision = manifest
        .revision
        .checked_add(1)
        .ok_or("worktree_manifest_invalid")?;
    save_manifest(private, &manifest)?;
    #[cfg(test)]
    fault_point(CreateFault::Creating)?;
    let git = installed_git()?;
    let env = crate::git_context::config_environment()?;
    let root = std::path::Path::new(&record.repository);
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(10),
        remaining: MAX_MANIFEST_BYTES,
    };
    let config = crate::git_context::git_command(
        &git,
        root,
        &env,
        &mut budget,
        &["config", "--null", "--list"],
    )?;
    if !config.status.success() {
        return Err("worktree_config_unavailable".into());
    }
    validate_filter_config(&config.stdout)?;
    let safe = crate::git_context::safe_config(&config.stdout)
        .map_err(|_| "worktree_conversion_unsupported")?;
    let shadow = crate::git_context::Shadow::new()?;
    std::fs::create_dir(shadow.0.join("empty-hooks")).map_err(|_| "worktree_git_unavailable")?;
    shadow.write("config", safe.as_bytes())?;
    shadow.write("HEAD", format!("{}\n", record.commit).as_bytes())?;
    let common = std::path::Path::new(&record.common_dir);
    let info = crate::git_context::read_regular(&common.join("info/attributes"), &mut budget)?;
    if let Some(bytes) = &info {
        shadow.write("info/attributes", bytes)?;
    }
    let mut isolated = vec![
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_ATTR_NOSYSTEM".into(), "1".into()),
        ("GIT_DIR".into(), shadow.0.as_os_str().to_owned()),
        ("GIT_WORK_TREE".into(), root.as_os_str().to_owned()),
        (
            "GIT_OBJECT_DIRECTORY".into(),
            common.join("objects").into_os_string(),
        ),
        (
            "GIT_INDEX_FILE".into(),
            shadow.0.join("index").into_os_string(),
        ),
    ];
    git_text(
        &git,
        root,
        &isolated,
        &mut budget,
        &["read-tree", &record.commit],
    )?;
    let paths =
        crate::git_context::git_command(&git, root, &isolated, &mut budget, &["ls-files", "-z"])?;
    if !paths.status.success() {
        return Err("worktree_git_unavailable".into());
    }
    let paths: Vec<&str> = paths
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| std::str::from_utf8(entry).map_err(|_| "worktree_conversion_unsupported"))
        .collect::<Result<_, _>>()?;
    if paths.len() > 4096 {
        return Err("worktree_output_limit".into());
    }
    let mut args = vec!["check-attr", "--cached", "--all", "-z", "--"];
    args.extend(paths);
    let mut original = env.clone();
    original.push((
        "GIT_INDEX_FILE".into(),
        shadow.0.join("index").into_os_string(),
    ));
    let original_attrs =
        crate::git_context::git_command(&git, root, &original, &mut budget, &args)?;
    let isolated_attrs =
        crate::git_context::git_command(&git, root, &isolated, &mut budget, &args)?;
    if !original_attrs.status.success()
        || !isolated_attrs.status.success()
        || original_attrs.stdout != isolated_attrs.stdout
    {
        return Err("worktree_conversion_unsupported".into());
    }
    git_text(
        &git,
        root,
        &env,
        &mut budget,
        &[
            "-c",
            &format!("core.hooksPath={}", shadow.0.join("empty-hooks").display()),
            "worktree",
            "add",
            "--no-checkout",
            "-b",
            &record.branch,
            "--",
            &record.target,
            &record.commit,
        ],
    )?;
    #[cfg(test)]
    fault_point(CreateFault::Registration)?;
    let target = std::path::Path::new(&record.target);
    let index = git_text(
        &git,
        target,
        &env,
        &mut budget,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?;
    for (key, value) in &mut isolated {
        if key == "GIT_WORK_TREE" {
            *value = target.as_os_str().to_owned();
        }
        if key == "GIT_INDEX_FILE" {
            *value = index.clone().into();
        }
    }
    git_text(
        &git,
        target,
        &isolated,
        &mut budget,
        &["read-tree", "-m", "-u", &record.commit],
    )?;
    #[cfg(test)]
    fault_point(CreateFault::Checkout)?;
    let after_config = crate::git_context::git_command(
        &git,
        root,
        &env,
        &mut budget,
        &["config", "--null", "--list"],
    )?;
    let after_info =
        crate::git_context::read_regular(&common.join("info/attributes"), &mut budget)?;
    if !after_config.status.success() || config.stdout != after_config.stdout || info != after_info
    {
        return Err("worktree_preview_changed".into());
    }
    let actual_head = git_text(&git, target, &env, &mut budget, &["rev-parse", "HEAD"])?;
    let actual_branch = git_text(
        &git,
        target,
        &env,
        &mut budget,
        &["symbolic-ref", "--short", "HEAD"],
    )?;
    let actual_common = git_text(
        &git,
        target,
        &env,
        &mut budget,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if actual_head != record.commit
        || actual_branch != record.branch
        || std::path::Path::new(&actual_common)
            .canonicalize()
            .map_err(|_| "worktree_identity_changed")?
            != common
    {
        return Err("worktree_identity_changed".into());
    }
    manifest
        .identities
        .get_mut(attempt)
        .ok_or("worktree_identity_changed")?
        .target = Some(directory_identity(target)?);
    let mut created = record;
    created.state = RecordState::Created;
    created.checkout_complete = true;
    *manifest
        .records
        .last_mut()
        .ok_or("worktree_manifest_invalid")? = created.clone();
    manifest.revision = manifest
        .revision
        .checked_add(1)
        .ok_or("worktree_manifest_invalid")?;
    save_manifest(private, &manifest)?;
    Ok(created)
}
#[cfg(test)]
fn fault_point(stage: CreateFault) -> Result<(), String> {
    if CREATE_FAULT.with(|fault| fault.get()) == Some(stage) {
        FAULT_HIT.with(|hit| hit.set(Some(stage)));
        return Err("worktree_injected_fault".into());
    }
    Ok(())
}

fn verify_relation(
    record: &ManagedRecord,
    git: &std::path::Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    budget: &mut crate::git_context::Budget,
) -> Result<(), String> {
    let target = std::path::Path::new(&record.target);
    let canonical = target
        .canonicalize()
        .map_err(|_| "worktree_identity_changed")?;
    if canonical != target {
        return Err("worktree_identity_changed".into());
    }
    let root = git_text(git, target, env, budget, &["rev-parse", "--show-toplevel"])?;
    let common = git_text(
        git,
        target,
        env,
        budget,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let head = git_text(git, target, env, budget, &["rev-parse", "HEAD"])?;
    let branch = git_text(
        git,
        target,
        env,
        budget,
        &["symbolic-ref", "--short", "HEAD"],
    )?;
    if std::path::Path::new(&root)
        .canonicalize()
        .map_err(|_| "worktree_identity_changed")?
        != target
        || std::path::Path::new(&common)
            .canonicalize()
            .map_err(|_| "worktree_identity_changed")?
            != std::path::Path::new(&record.common_dir)
        || (!record.session_claimed && head != record.commit)
        || branch != record.branch
    {
        return Err("worktree_identity_changed".into());
    }
    Ok(())
}
fn list_managed(private: &std::path::Path) -> Result<Vec<ManagedRecord>, String> {
    let _gate = start_guard()?;
    match std::fs::symlink_metadata(private.join("worktrees.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("worktree_manifest_unavailable".into()),
        Ok(_) => {}
    }
    let mut manifest = read_manifest(private)?;
    let git = installed_git()?;
    let env = crate::git_context::config_environment()?;
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: MAX_MANIFEST_BYTES,
    };
    let mut changed = reconcile_cleanup(&mut manifest, &git, &env)?;
    for record in &mut manifest.records {
        if record.state == RecordState::Creating {
            *record = reconcile_record(record, false)?;
            changed = true;
        } else if record.state == RecordState::Created
            && (verify_physical(record, manifest.identities.get(&record.attempt)).is_err()
                || verify_relation(record, &git, &env, &mut budget).is_err())
        {
            if std::time::Instant::now() >= budget.deadline || budget.remaining == 0 {
                return Err("worktree_git_unavailable".into());
            }
            record.state = RecordState::Failed;
            record.checkout_complete = false;
            changed = true;
        }
    }
    if changed {
        manifest.revision = manifest
            .revision
            .checked_add(1)
            .ok_or("worktree_manifest_invalid")?;
        save_manifest(private, &manifest)?;
    }
    Ok(manifest.records)
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq)]
enum CreateFault {
    Creating,
    Registration,
    Checkout,
}
#[cfg(test)]
thread_local! {static CREATE_FAULT:std::cell::Cell<Option<CreateFault>>=const {std::cell::Cell::new(None)};static FAULT_HIT:std::cell::Cell<Option<CreateFault>>=const {std::cell::Cell::new(None)};}

fn directory_identity(root: &Path) -> Result<String, String> {
    let metadata = fs::metadata(root).map_err(|_| "worktree_identity_changed".to_string())?;
    if !metadata.is_dir() {
        return Err("worktree_identity_changed".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Info {
            attributes: u32,
            creation: [u32; 2],
            access: [u32; 2],
            write: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                file: std::os::windows::io::RawHandle,
                info: *mut Info,
            ) -> i32;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(root)
            .map_err(|_| "worktree_identity_changed".to_string())?;
        let mut info = std::mem::MaybeUninit::<Info>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err("worktree_identity_changed".to_string());
        }
        let info = unsafe { info.assume_init() };
        Ok(format!(
            "{}:{}:{}",
            info.volume, info.index_high, info.index_low
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("worktree_identity_changed".to_string())
    }
}

fn verify_physical(
    record: &ManagedRecord,
    identity: Option<&WorktreeIdentity>,
) -> Result<(), String> {
    let identity = identity.ok_or("worktree_identity_changed")?;
    if directory_identity(std::path::Path::new(&record.repository))? != identity.repository
        || directory_identity(std::path::Path::new(&record.common_dir))? != identity.common
        || Some(directory_identity(std::path::Path::new(&record.target))?) != identity.target
    {
        return Err("worktree_identity_changed".into());
    }
    Ok(())
}
pub(crate) struct StartCheck {
    record: Option<ManagedRecord>,
    identity: Option<WorktreeIdentity>,
    pub session_id: Option<String>,
}
pub(crate) fn prepare_start(
    private: &std::path::Path,
    cwd: &std::path::Path,
    attempt: Option<&str>,
) -> Result<StartCheck, String> {
    let canonical = cwd.canonicalize().map_err(|_| "worktree_invalid_target")?;
    let associations = association_paths(cwd)?;
    let manifest = match std::fs::symlink_metadata(private.join("worktrees.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if attempt.is_some() {
                return Err("worktree_unknown_attempt".into());
            }
            return Ok(StartCheck {
                record: None,
                identity: None,
                session_id: None,
            });
        }
        Err(_) => return Err("worktree_manifest_unavailable".into()),
        Ok(_) => read_manifest(private)?,
    };
    if manifest.cleanup.values().any(|journal| {
        associations
            .iter()
            .any(|path| path.starts_with(&journal.quarantine))
    }) {
        return Err("worktree_not_ready".into());
    }
    let record = if let Some(attempt) = attempt {
        Some(
            manifest
                .records
                .iter()
                .find(|record| record.attempt == attempt)
                .ok_or("worktree_unknown_attempt")?,
        )
    } else {
        manifest
            .records
            .iter()
            .filter(|record| {
                associations
                    .iter()
                    .any(|path| path.starts_with(&record.target))
            })
            .max_by_key(|record| record.target.len())
    };
    let Some(record) = record else {
        return Ok(StartCheck {
            record: None,
            identity: None,
            session_id: None,
        });
    };
    if record.state != RecordState::Created || !record.checkout_complete {
        return Err("worktree_not_ready".into());
    }
    if !canonical.starts_with(&record.target) {
        return Err("worktree_identity_changed".into());
    }
    if attempt.is_some() && record.session_claimed {
        return Err("worktree_session_consumed".into());
    }
    let identity = manifest.identities.get(&record.attempt);
    verify_physical(record, identity)?;
    let git = installed_git()?;
    let env = crate::git_context::config_environment()?;
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: MAX_MANIFEST_BYTES,
    };
    verify_relation(record, &git, &env, &mut budget).map_err(|_| "worktree_identity_changed")?;
    let session_id = if record.session_claimed {
        None
    } else {
        Some(claim_record(
            private,
            &record.attempt,
            std::path::Path::new(&record.target),
        )?)
    };
    Ok(StartCheck {
        record: Some(record.clone()),
        identity: identity.cloned(),
        session_id,
    })
}
pub(crate) fn recheck_start(check: &StartCheck, cwd: &std::path::Path) -> Result<(), String> {
    let Some(record) = &check.record else {
        return Ok(());
    };
    let canonical = cwd
        .canonicalize()
        .map_err(|_| "worktree_identity_changed")?;
    if !canonical.starts_with(&record.target) {
        return Err("worktree_identity_changed".into());
    }
    verify_physical(record, check.identity.as_ref())?;
    let git = installed_git()?;
    let env = crate::git_context::config_environment()?;
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: MAX_MANIFEST_BYTES,
    };
    verify_relation(record, &git, &env, &mut budget).map_err(|_| "worktree_identity_changed".into())
}

#[cfg(test)]
pub(crate) fn serial_owner_test() -> std::sync::MutexGuard<'static, ()> {
    tests::serial_worktree_test()
}

pub(crate) fn owner_command(
    private: &Path,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::background::validate_command(command, &args).map_err(|_| "worktree_invalid_request")?;
    match command {
        "preview_worktree_create" => serde_json::to_value(preview_create(
            private,
            &serde_json::from_value(args).map_err(|_| "worktree_invalid_request")?,
        )?)
        .map_err(|_| "worktree_invalid_request".into()),
        "create_worktree" => serde_json::to_value(create_managed(
            private,
            args["attempt"].as_str().ok_or("worktree_invalid_request")?,
        )?)
        .map_err(|_| "worktree_invalid_request".into()),
        "list_managed_worktrees" => {
            let records = list_managed(private)?;
            let manifest = if records.is_empty() {
                None
            } else {
                Some(read_manifest(private)?)
            };
            let values = records
                .iter()
                .map(|record| {
                    record_projection(
                        record,
                        manifest
                            .as_ref()
                            .and_then(|manifest| manifest.cleanup.get(&record.attempt)),
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::Value::Array(values))
        }
        "preview_worktree_cleanup" | "cleanup_worktree" => {
            Err("worktree_cleanup_unavailable".into())
        }
        _ => Err("worktree_invalid_request".into()),
    }
}

fn lexical_absolute(path: &Path) -> Result<std::path::PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "worktree_invalid_target")?
            .join(path)
    };
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err("worktree_invalid_target".into());
                }
            }
            part => normalized.push(part.as_os_str()),
        }
    }
    Ok(normalized)
}

fn association_paths(path: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let lexical = lexical_absolute(path)?;
    let mut paths = vec![
        lexical.clone(),
        path.canonicalize().map_err(|_| "worktree_invalid_target")?,
    ];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    // Resolve each parent without following the candidate target's final component.
    // This recognizes managed roots through a different parent alias, including
    // a target replaced by a symlink pointing out of the managed directory.
    for (count, ancestor) in lexical.ancestors().enumerate() {
        if count >= 256 || std::time::Instant::now() >= deadline {
            return Err("worktree_invalid_target".into());
        }
        if let (Some(parent), Some(name)) = (ancestor.parent(), ancestor.file_name()) {
            if let Ok(parent) = parent.canonicalize() {
                paths.push(parent.join(name));
            }
            if let Ok(link) = std::fs::read_link(ancestor) {
                let link = if link.is_absolute() {
                    link
                } else {
                    ancestor
                        .parent()
                        .ok_or("worktree_invalid_target")?
                        .join(link)
                };
                paths.push(lexical_absolute(&link)?);
            }
        }
    }
    Ok(paths)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CleanupPhase {
    Prepared,
    Quarantined,
    Unregistered,
    Trashing,
    Trashed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupJournal {
    token: String,
    owner: String,
    original: String,
    quarantine: String,
    parent_identity: String,
    target_identity: String,
    phase: CleanupPhase,
    returned: Option<Vec<u8>>,
    reason: Option<String>,
}
const CLEANUP_REASONS: &[&str] = &[
    "worktree_recovery_needed",
    "worktree_cleanup_changed",
    "worktree_native_trash_failed",
    "worktree_native_result_unknown",
    "worktree_registration_unknown",
    "worktree_target_occupied",
    "worktree_manifest_unavailable",
];
struct PendingCleanup {
    private: std::path::PathBuf,
    attempt: String,
    token: String,
    owner: String,
    revision: u64,
    snapshot: crate::git_context::CleanupSnapshot,
    parent_identity: String,
    expires: std::time::Instant,
}
static CLEANUP_PREVIEWS: std::sync::Mutex<Vec<PendingCleanup>> = std::sync::Mutex::new(Vec::new());
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn cleanup_budget() -> crate::git_context::Budget {
    crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: MAX_MANIFEST_BYTES,
    }
}
fn cleanup_owner(manager: &crate::SessionManager) -> Result<String, String> {
    if !manager.background_owner
        || manager
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("worktree_cleanup_unavailable".into());
    }
    let owner = manager
        .system_entry
        .lock()
        .map_err(|_| "worktree_cleanup_unavailable")?
        .pause
        .as_ref()
        .map(|pause| pause.owner_instance.clone())
        .ok_or("worktree_cleanup_unavailable")?;
    if !valid_token(&owner) {
        return Err("worktree_cleanup_unavailable".into());
    }
    Ok(owner)
}
fn cleanup_inactive(manager: &crate::SessionManager, target: &Path) -> Result<(), String> {
    // LIFECYCLE is already held. Clone the actual owned sessions and release the map before any Git I/O.
    let sessions: Vec<_> = manager
        .sessions
        .lock()
        .map_err(|_| "worktree_active")?
        .values()
        .cloned()
        .collect();
    for session in sessions {
        if *session.completed.0.lock().map_err(|_| "worktree_active")? {
            continue;
        }
        let cwd = Path::new(&session.summary.cwd);
        let paths = association_paths(cwd).map_err(|_| "worktree_active")?;
        if paths.iter().any(|path| path.starts_with(target)) {
            return Err("worktree_active".into());
        }
    }
    Ok(())
}
fn registry_record(
    record: &ManagedRecord,
    git: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    budget: &mut crate::git_context::Budget,
) -> Result<Option<String>, String> {
    let output = crate::git_context::git_command(
        git,
        Path::new(&record.repository),
        env,
        budget,
        &["worktree", "list", "--porcelain", "-z"],
    )?;
    if !output.status.success() {
        return Err("worktree_registration_unknown".into());
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| "worktree_registration_unknown")?;
    let mut found = None;
    for block in text.split("\0\0") {
        let fields: Vec<_> = block.split('\0').collect();
        if fields.first().copied() != Some(format!("worktree {}", record.target).as_str()) {
            continue;
        }
        if found.is_some() || fields.iter().any(|field| field.starts_with("locked")) {
            return Err("worktree_registration_unknown".into());
        }
        if !fields.contains(&format!("branch refs/heads/{}", record.branch).as_str()) {
            return Err("worktree_identity_changed".into());
        }
        let head = fields
            .iter()
            .find_map(|field| field.strip_prefix("HEAD "))
            .ok_or("worktree_registration_unknown")?;
        if head.len() != 40 || !head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("worktree_registration_unknown".into());
        }
        found = Some(head.into());
    }
    Ok(found)
}
fn cleanup_certificate(
    record: &ManagedRecord,
    identity: Option<&WorktreeIdentity>,
    manager: &crate::SessionManager,
    git: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<crate::git_context::CleanupSnapshot, String> {
    if record.state != RecordState::Created || !record.checkout_complete {
        return Err("worktree_not_ready".into());
    }
    verify_physical(record, identity)?;
    if record.target == record.repository {
        return Err("worktree_identity_changed".into());
    }
    cleanup_inactive(manager, Path::new(&record.target))?;
    let mut relation = record.clone();
    relation.session_claimed = true;
    let mut budget = cleanup_budget();
    verify_relation(&relation, git, env, &mut budget)?;
    let head =
        registry_record(record, git, env, &mut budget)?.ok_or("worktree_identity_changed")?;
    let snapshot =
        crate::git_context::cleanup_snapshot(Path::new(&record.target), git, env.to_vec())?;
    if snapshot.head != head {
        return Err("worktree_cleanup_changed".into());
    }
    Ok(snapshot)
}
fn record_projection(
    record: &ManagedRecord,
    journal: Option<&CleanupJournal>,
) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(record).map_err(|_| "worktree_manifest_invalid")?;
    if let Some(journal) = journal {
        let returned = journal
            .returned
            .as_ref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok());
        value["cleanup"] = serde_json::json!({"phase":journal.phase,"recovery_needed":journal.phase!=CleanupPhase::Trashed,"retained_path":journal.quarantine,"returned_path":returned,"reason":journal.reason});
    }
    Ok(value)
}
fn persist_cleanup(
    private: &Path,
    manifest: &mut Manifest,
    attempt: &str,
    journal: &CleanupJournal,
) -> Result<(), String> {
    manifest.cleanup.insert(attempt.into(), journal.clone());
    manifest
        .records
        .iter_mut()
        .find(|record| record.attempt == attempt)
        .ok_or("worktree_unknown_attempt")?
        .state = if journal.phase == CleanupPhase::Trashed {
        RecordState::Removed
    } else {
        RecordState::Removing
    };
    manifest.revision = manifest
        .revision
        .checked_add(1)
        .ok_or("worktree_manifest_invalid")?;
    save_manifest(private, manifest)
}
fn cleanup_recovery(
    private: &Path,
    manifest: &mut Manifest,
    record: &ManagedRecord,
    journal: &mut CleanupJournal,
    reason: &str,
) -> Result<serde_json::Value, String> {
    journal.reason = Some(
        if CLEANUP_REASONS.contains(&reason) {
            reason
        } else {
            "worktree_recovery_needed"
        }
        .into(),
    );
    persist_cleanup(private, manifest, &record.attempt, journal)?;
    let current = manifest
        .records
        .iter()
        .find(|item| item.attempt == record.attempt)
        .ok_or("worktree_unknown_attempt")?;
    record_projection(current, Some(journal))
}
fn sync_cleanup_parent(path: &Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "worktree_recovery_needed".into())
}
fn quarantine_move(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes())
            .map_err(|_| "worktree_invalid_target")?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes())
            .map_err(|_| "worktree_invalid_target")?;
        if unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        } != 0
        {
            return Err("worktree_recovery_needed".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (from, to);
        Err("worktree_cleanup_unsupported".into())
    }
}
pub(crate) fn owner_cleanup_command(
    private: &Path,
    manager: &crate::SessionManager,
    command: &str,
    args: serde_json::Value,
    trash: impl FnOnce(&Path) -> Result<std::path::PathBuf, String>,
) -> Result<serde_json::Value, String> {
    crate::background::validate_command(command, &args).map_err(|_| "worktree_invalid_request")?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (private, manager, trash);
        return Err("worktree_cleanup_unsupported".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _gate = start_guard()?;
        let owner = cleanup_owner(manager)?;
        let attempt = args["attempt"].as_str().ok_or("worktree_invalid_request")?;
        let mut manifest = read_manifest(private)?;
        let record = manifest
            .records
            .iter()
            .find(|record| record.attempt == attempt)
            .cloned()
            .ok_or("worktree_unknown_attempt")?;
        if let Some(journal) = manifest.cleanup.get(attempt) {
            if command == "cleanup_worktree"
                && args["preview"].as_str() == Some(&journal.token)
                && journal.phase == CleanupPhase::Trashed
            {
                return record_projection(&record, Some(journal));
            }
            return Err("worktree_recovery_needed".into());
        }
        let git = installed_git()?;
        let env = crate::git_context::config_environment()?;
        let snapshot = cleanup_certificate(
            &record,
            manifest.identities.get(attempt),
            manager,
            &git,
            &env,
        )?;
        let parent = Path::new(&record.target)
            .parent()
            .ok_or("worktree_identity_changed")?;
        let parent_identity = directory_identity(parent)?;
        if command == "preview_worktree_cleanup" {
            let token = crate::agent_bridge::credential()?;
            let now = std::time::Instant::now();
            let mut previews = CLEANUP_PREVIEWS.lock().map_err(|_| "worktree_busy")?;
            previews.retain(|item| {
                item.expires > now && !(item.private == private && item.attempt == attempt)
            });
            let retained: usize = previews
                .iter()
                .map(|item| item.snapshot.bytes.len() + item.snapshot.inventory.len())
                .sum();
            if previews.len() >= 256
                || retained + snapshot.bytes.len() + snapshot.inventory.len() > MAX_MANIFEST_BYTES
            {
                return Err("worktree_preview_limit".into());
            }
            let head = snapshot.head.clone();
            previews.push(PendingCleanup {
                private: private.into(),
                attempt: attempt.into(),
                token: token.clone(),
                owner,
                revision: manifest.revision,
                snapshot,
                parent_identity,
                expires: now + std::time::Duration::from_secs(120),
            });
            return Ok(
                serde_json::json!({"attempt":attempt,"preview":token,"target":record.target,"branch":record.branch,"commit":head,"action":"trash"}),
            );
        }
        if command != "cleanup_worktree" {
            return Err("worktree_invalid_request".into());
        }
        let token = args["preview"].as_str().ok_or("worktree_invalid_request")?;
        let pending = {
            let mut previews = CLEANUP_PREVIEWS.lock().map_err(|_| "worktree_busy")?;
            let position = previews
                .iter()
                .position(|item| {
                    item.private == private
                        && item.attempt == attempt
                        && item.token == token
                        && item.owner == owner
                })
                .ok_or("worktree_preview_changed")?;
            previews.remove(position)
        };
        if pending.expires <= std::time::Instant::now()
            || pending.revision != manifest.revision
            || pending.snapshot != snapshot
            || pending.parent_identity != parent_identity
        {
            return Err("worktree_preview_changed".into());
        }
        cleanup_inactive(manager, Path::new(&record.target))?;
        let wrapper = parent.join(format!(".yam-quarantine-{token}"));
        let mut builder = std::fs::DirBuilder::new();
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
        builder
            .create(&wrapper)
            .map_err(|_| "worktree_target_occupied")?;
        let q = wrapper.join("worktree");
        let mut journal = CleanupJournal {
            token: token.into(),
            owner,
            original: record.target.clone(),
            quarantine: q.to_str().ok_or("worktree_invalid_target")?.into(),
            parent_identity,
            target_identity: directory_identity(Path::new(&record.target))?,
            phase: CleanupPhase::Prepared,
            returned: None,
            reason: None,
        };
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        #[cfg(test)]
        cleanup_fault(CleanupFault::Prepared)?;
        if quarantine_move(Path::new(&record.target), &q).is_err() {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_recovery_needed",
            );
        }
        #[cfg(test)]
        cleanup_fault(CleanupFault::Renamed)?;
        if sync_cleanup_parent(parent)
            .and_then(|_| sync_cleanup_parent(&wrapper))
            .is_err()
            || directory_identity(&q).ok().as_ref() != Some(&journal.target_identity)
        {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_recovery_needed",
            );
        }
        journal.phase = CleanupPhase::Quarantined;
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        #[cfg(test)]
        cleanup_fault(CleanupFault::Quarantined)?;
        let mut moved_env = env.clone();
        moved_env.push(("GIT_DIR".into(), snapshot.admin.as_os_str().into()));
        moved_env.push(("GIT_WORK_TREE".into(), q.as_os_str().into()));
        if crate::git_context::cleanup_snapshot(&q, &git, moved_env).as_ref() != Ok(&snapshot) {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_cleanup_changed",
            );
        }
        if !cleanup_path_absent(Path::new(&record.target)) {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_target_occupied",
            );
        }
        let mut budget = cleanup_budget();
        let config = crate::git_context::git_command(
            &git,
            Path::new(&record.repository),
            &env,
            &mut budget,
            &["config", "--null", "--list"],
        )?;
        if !config.status.success()
            || validate_filter_config(&config.stdout).is_err()
            || crate::git_context::safe_config(&config.stdout).is_err()
        {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_cleanup_changed",
            );
        }
        #[cfg(test)]
        cleanup_fault(CleanupFault::ConfigChecked)?;
        if !cleanup_path_absent(Path::new(&record.target)) {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_target_occupied",
            );
        }
        // Original absent: ordinary remove cannot traverse the quarantined target. This is not a config sandbox.
        let _remove = crate::git_context::git_command(
            &git,
            Path::new(&record.repository),
            &env,
            &mut budget,
            &["worktree", "remove", &record.target],
        );
        if !matches!(
            registry_record(&record, &git, &env, &mut cleanup_budget()),
            Ok(None)
        ) {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_registration_unknown",
            );
        }
        journal.phase = CleanupPhase::Unregistered;
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        #[cfg(test)]
        cleanup_fault(CleanupFault::Unregistered)?;
        if directory_identity(&q).ok().as_ref() != Some(&journal.target_identity)
            || crate::git_context::cleanup_inventory(&q, &mut cleanup_budget())
                .ok()
                .as_ref()
                != Some(&snapshot.inventory)
        {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_cleanup_changed",
            );
        }
        journal.phase = CleanupPhase::Trashing;
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        #[cfg(test)]
        cleanup_fault(CleanupFault::Trashing)?;
        let destination = match trash(&q) {
            Ok(path) => path,
            Err(error) => {
                let reason = if error == "worktree_native_result_unknown"
                    || directory_identity(&q).ok().as_ref() != Some(&journal.target_identity)
                {
                    "worktree_native_result_unknown"
                } else {
                    "worktree_native_trash_failed"
                };
                return cleanup_recovery(private, &mut manifest, &record, &mut journal, reason);
            }
        };
        #[cfg(test)]
        cleanup_fault(CleanupFault::NativeReturned)?;
        use std::os::unix::ffi::OsStrExt;
        let bytes = destination.as_os_str().as_bytes();
        if !destination.is_absolute()
            || bytes.len() > 4096
            || bytes.is_empty()
            || !cleanup_path_absent(&q)
            || directory_identity(&destination).ok().as_ref() != Some(&journal.target_identity)
            || std::fs::symlink_metadata(&destination)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(true)
        {
            return cleanup_recovery(
                private,
                &mut manifest,
                &record,
                &mut journal,
                "worktree_native_result_unknown",
            );
        }
        journal.returned = Some(bytes.to_vec());
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        #[cfg(test)]
        cleanup_fault(CleanupFault::ReturnedSaved)?;
        journal.phase = CleanupPhase::Trashed;
        persist_cleanup(private, &mut manifest, attempt, &journal)?;
        let current = manifest
            .records
            .iter()
            .find(|record| record.attempt == attempt)
            .ok_or("worktree_unknown_attempt")?;
        record_projection(current, Some(&journal))
    }
}
pub(crate) fn native_trash(path: &Path) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let bytes = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "worktree_native_trash_failed")?;
        let url = unsafe {
            objc2_foundation::NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
                std::ptr::NonNull::new(bytes.as_ptr().cast_mut())
                    .ok_or("worktree_native_trash_failed")?,
                true,
                None,
            )
        };
        let mut returned = None;
        objc2_foundation::NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut returned))
            .map_err(|_| "worktree_native_trash_failed")?;
        let returned = returned.ok_or("worktree_native_result_unknown")?;
        if !returned.isFileURL() {
            return Err("worktree_native_result_unknown".into());
        }
        let bytes =
            unsafe { std::ffi::CStr::from_ptr(returned.fileSystemRepresentation().as_ptr()) }
                .to_bytes();
        if bytes.is_empty() || bytes.len() > 4096 {
            return Err("worktree_native_result_unknown".into());
        }
        let path = std::path::PathBuf::from(std::ffi::OsString::from_vec(bytes.to_vec()));
        if !path.is_absolute() {
            return Err("worktree_native_result_unknown".into());
        }
        Ok(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("worktree_cleanup_unsupported".into())
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq)]
enum CleanupFault {
    Prepared,
    Renamed,
    Quarantined,
    ConfigChecked,
    Unregistered,
    Trashing,
    NativeReturned,
    ReturnedSaved,
}
#[cfg(test)]
type CleanupAction = Box<dyn Fn(CleanupFault)>;
#[cfg(test)]
thread_local! {static CLEANUP_FAULT:std::cell::Cell<Option<CleanupFault>>=const{std::cell::Cell::new(None)};static CLEANUP_FAULT_HIT:std::cell::Cell<Option<CleanupFault>>=const{std::cell::Cell::new(None)};static CLEANUP_ACTION:std::cell::RefCell<Option<CleanupAction>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
fn cleanup_fault(stage: CleanupFault) -> Result<(), String> {
    CLEANUP_ACTION.with(|action| {
        if let Some(action) = action.borrow().as_ref() {
            action(stage);
        }
    });
    if CLEANUP_FAULT.with(|fault| fault.get()) == Some(stage) {
        CLEANUP_FAULT_HIT.with(|hit| hit.set(Some(stage)));
        return Err("worktree_injected_fault".into());
    }
    Ok(())
}

fn reconcile_cleanup(
    manifest: &mut Manifest,
    git: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<bool, String> {
    let attempts: Vec<_> = manifest.cleanup.keys().cloned().collect();
    let mut changed = false;
    for attempt in attempts {
        let journal = manifest
            .cleanup
            .get(&attempt)
            .cloned()
            .ok_or("worktree_manifest_invalid")?;
        if journal.phase == CleanupPhase::Trashed {
            continue;
        }
        let record = manifest
            .records
            .iter()
            .find(|record| record.attempt == attempt)
            .ok_or("worktree_manifest_invalid")?;
        let mut relation = record.clone();
        relation.session_claimed = true;
        let untouched = journal.phase == CleanupPhase::Prepared
            && matches!(std::fs::symlink_metadata(&journal.quarantine),Err(error) if error.kind()==std::io::ErrorKind::NotFound)
            && directory_identity(Path::new(&journal.original))
                .ok()
                .as_ref()
                == Some(&journal.target_identity)
            && directory_identity(
                Path::new(&journal.original)
                    .parent()
                    .ok_or("worktree_manifest_invalid")?,
            )
            .ok()
            .as_ref()
                == Some(&journal.parent_identity)
            && verify_physical(record, manifest.identities.get(&attempt)).is_ok()
            && verify_relation(&relation, git, env, &mut cleanup_budget()).is_ok()
            && matches!(
                registry_record(record, git, env, &mut cleanup_budget()),
                Ok(Some(_))
            );
        if untouched {
            manifest.cleanup.remove(&attempt);
            manifest
                .records
                .iter_mut()
                .find(|record| record.attempt == attempt)
                .ok_or("worktree_manifest_invalid")?
                .state = RecordState::Created;
            changed = true;
        } else {
            let reason = if journal.phase == CleanupPhase::Trashing
                && journal.returned.is_none()
                && directory_identity(Path::new(&journal.quarantine))
                    .ok()
                    .as_ref()
                    != Some(&journal.target_identity)
            {
                Some("worktree_native_result_unknown".to_owned())
            } else {
                journal
                    .reason
                    .clone()
                    .or_else(|| Some("worktree_recovery_needed".into()))
            };
            if journal.reason != reason {
                manifest
                    .cleanup
                    .get_mut(&attempt)
                    .ok_or("worktree_manifest_invalid")?
                    .reason = reason;
                changed = true;
            }
        }
    }
    Ok(changed)
}

fn cleanup_path_absent(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path),Err(error) if error.kind()==std::io::ErrorKind::NotFound)
}
