pub(super) fn command_fields(
    command: &str,
) -> Result<(&'static [&'static str], &'static [&'static str]), String> {
    let fields: (&'static [&'static str], &'static [&'static str]) = match command {
        "get_system_entry_status"
        | "get_notification_pause_state"
        | "cli_status"
        | "cli_list"
        | "list_sessions"
        | "list_managed_worktrees"
        | "get_launch_defaults"
        | "get_history_policy"
        | "history_overview"
        | "scan_history_capacity"
        | "cancel_history_capacity"
        | "shutdown"
        | "prepare_update"
        | "finish_update"
        | "background_status"
        | "memory_processes"
        | "diagnostics_report"
        | "retry_agent_notifications"
        | "cancel_log_search" => (&[], &[]),
        "list_archived_sessions"
        | "list_session_summaries"
        | "list_unread_receipts"
        | "project_backup"
        | "project_notification_policy"
        | "pi_packages" => (&["request"], &["request"]),
        "cli_show"
        | "cli_focus"
        | "cli_stop"
        | "archive_session"
        | "restore_archive"
        | "get_session"
        | "session_finish_pending"
        | "retry_session_finish"
        | "test_notification"
        | "recover_terminal_agent"
        | "get_pi_routing"
        | "copy_codex_routing"
        | "release_terminal_control"
        | "take_terminal_control"
        | "stop_session"
        | "read_session_snapshot"
        | "read_session_log"
        | "read_terminal_frame" => (&["session_id"], &["session_id"]),
        "start_omp_auth" => (&["session_id", "generation"], &["session_id", "generation"]),
        "start_terminal_agent" => (
            &["session_id", "adapter", "mode", "extra", "cwd"],
            &["session_id", "adapter", "mode", "extra", "cwd"],
        ),
        "pi_routing_control" => (
            &["session_id", "generation", "request"],
            &["session_id", "generation", "request"],
        ),
        "pi_routing_catalog" => (&["cwd", "gateway", "probe_model"], &["cwd", "gateway"]),
        "codex_routing_catalog" => (&["cwd", "config", "probe_model"], &["cwd", "config"]),
        "cli_start" => (&["request_key", "start"], &["request_key", "start"]),
        "cli_events" => (&["cursor"], &["cursor"]),
        "set_history_policy" => (&["auto_archive_30_days"], &["auto_archive_30_days"]),
        "preview_archive_deletion" => (&["session_ids", "validate_only"], &["session_ids"]),
        "cancel_archive_deletion_preview" | "confirm_archive_deletion" => {
            (&["preview_id"], &["preview_id"])
        }
        "next_attention" => (&["current_session_id"], &["current_session_id"]),
        "list_pending_notifications" => (&["limit", "after_key"], &["limit", "after_key"]),
        "poll_events" => (&["cursor", "foreground"], &["cursor"]),
        "acknowledge_notification" => (
            &["session_id", "expected_status"],
            &["session_id", "expected_status"],
        ),
        "notify_session" => (
            &["session_id", "expected_status", "title"],
            &["session_id", "expected_status", "title"],
        ),
        "set_global_shortcut" => (
            &["enabled", "expected_owner_instance"],
            &["enabled", "expected_owner_instance"],
        ),
        "initialize_notification_pause" => (
            &["legacy_paused", "expected_owner_instance"],
            &["legacy_paused", "expected_owner_instance"],
        ),
        "set_notification_paused" => (
            &["paused", "expected_revision", "expected_owner_instance"],
            &["paused", "expected_revision", "expected_owner_instance"],
        ),
        "set_notification_locale" => (&["locale"], &["locale"]),
        "set_agent_notification_context" => {
            (&["selected", "paused", "pause_revision"], &["selected"])
        }
        "read_agent_receipt" => (
            &["session_id", "receipt", "revision", "only_current"],
            &["session_id", "receipt", "revision"],
        ),
        "search_session_logs" => (&["session_id", "request"], &["session_id", "request"]),
        "clear_terminal_display" => (
            &["session_id", "expected_instance"],
            &["session_id", "expected_instance"],
        ),
        "navigate_reported_prompt" => (
            &["session_id", "direction", "expected_instance"],
            &["session_id", "direction", "expected_instance"],
        ),
        "set_terminal_viewport" => (&["session_id", "line", "bottom"], &["session_id", "line"]),
        "read_log_excerpt" => (
            &["session_id", "offset", "column"],
            &["session_id", "offset", "column"],
        ),
        "preview_worktree_create" => (
            &["root", "target", "reference", "branch"],
            &["root", "target", "reference"],
        ),
        "create_worktree" | "preview_worktree_cleanup" => (&["attempt"], &["attempt"]),
        "cleanup_worktree" => (&["attempt", "preview"], &["attempt", "preview"]),
        "get_git_context" => (&["path"], &["path"]),
        "preview_project_config" => (&["cwd"], &["cwd"]),
        "trust_project_config" => (&["cwd", "preview"], &["cwd", "preview"]),
        "set_launch_defaults" => (&["defaults"], &["defaults"]),
        "create_session" => (
            &[
                "cwd",
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
                "provider_protocol",
                "shell",
                "env_refs",
                "directory_reporting",
                "command_reporting",
                "retained_lines",
                "ssh",
            ],
            &[],
        ),
        "open_terminal_stream" => (
            &["session_id", "cols", "rows"],
            &["session_id", "cols", "rows"],
        ),
        "read_terminal_delta" => (
            &["session_id", "expected_instance", "offset"],
            &["session_id", "expected_instance", "offset"],
        ),
        "write_session" => (
            &["session_id", "data", "expected_agent"],
            &["session_id", "data"],
        ),
        "resize_session" => (
            &["session_id", "cols", "rows"],
            &["session_id", "cols", "rows"],
        ),
        _ => return Err("Unsupported background command".into()),
    };
    Ok(fields)
}

pub(super) fn validate_fields<'a>(
    args: &'a serde_json::Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>, String> {
    let object = args
        .as_object()
        .ok_or("Invalid background command arguments")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err("Invalid background command arguments".into());
    }
    Ok(object)
}

#[cfg(test)]
mod tests {
    #[test]
    fn project_commands_pass_the_same_owner_contract_used_by_proxy_calls() {
        for command in ["project_backup", "project_notification_policy"] {
            let (allowed, required) = super::command_fields(command)
                .expect("registered GUI command must reach the owner");
            assert!(super::validate_fields(
                &serde_json::json!({"request":{"action":"get"}}),
                allowed,
                required
            )
            .is_ok());
            assert!(super::validate_fields(&serde_json::json!({}), allowed, required).is_err());
        }
    }
    #[test]
    fn command_field_contracts_accept_optional_and_reject_unknown_or_missing_fields() {
        let (allowed, required) = super::command_fields("write_session").unwrap();
        assert!(super::validate_fields(
            &serde_json::json!({"session_id":"s-one","data":"text"}),
            allowed,
            required,
        )
        .is_ok());
        assert!(super::validate_fields(
            &serde_json::json!({"session_id":"s-one","data":"text","extra":true}),
            allowed,
            required,
        )
        .is_err());
        assert!(super::validate_fields(
            &serde_json::json!({"session_id":"s-one"}),
            allowed,
            required,
        )
        .is_err());
        assert!(super::command_fields("unknown_command").is_err());
    }
}
