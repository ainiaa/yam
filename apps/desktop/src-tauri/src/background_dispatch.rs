// Author: Jeff.Liu. Owner command routing, session admission and update shutdown.
use super::{
    cli_event_page, cli_focus_owner, cli_read, dispatch_git_changes, validate_command, Request,
};
use crate::background_events::notify_lifecycle;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;

pub(super) fn argument<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|_| format!("Invalid background argument: {key}"))
}
// Complete controls invalidate render caches even when no further output follows.
fn after_terminal_control<T>(
    manager: &crate::SessionManager,
    session_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let result = operation();
    let notified = manager.relay.lock().map(|mut relay| {
        relay.push(
            "terminal-frame-invalidated",
            serde_json::json!({"session_id":session_id}).to_string(),
        );
    });
    let value = result?;
    notified
        .map(|_| value)
        .map_err(|_| "Terminal frame invalidation unavailable".into())
}

pub(super) fn dispatch(
    app: &tauri::AppHandle,
    request: Request,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    dispatch_with(
        request,
        || app.state(),
        |manager, request| {
            if let Some(result) = dispatch_session_read(app, manager.clone(), &request) {
                return result;
            }
            let args = &request.args;
            if request.command == "set_global_shortcut" {
                return crate::system_entry::set_shortcut_native(
                    app,
                    argument(args, "enabled")?,
                    &argument::<String>(args, "expected_owner_instance")?,
                );
            }
            if request.command == "start_omp_auth" {
                let id: String = argument(args, "session_id")?;
                let active = manager
                    .sessions
                    .lock()
                    .map_err(|_| "Session manager unavailable")?
                    .get(&id)
                    .cloned()
                    .ok_or("OMP terminal is no longer running")?;
                if active.stop_requested.load(Ordering::Acquire) {
                    return Err("OMP terminal is stopping".into());
                }
                crate::omp_router::authorize_auth_job(
                    &active.history.get(&id)?,
                    &argument::<String>(args, "generation")?,
                )?;
                return crate::omp_router::start_auth_job(&active.history.root);
            }
            if request.command == "start_terminal_agent" {
                #[cfg(unix)]
                return crate::interactive_shell::start(
                    app,
                    &manager,
                    &argument::<String>(args, "session_id")?,
                    &argument::<String>(args, "adapter")?,
                    &argument::<String>(args, "mode")?,
                    argument(args, "extra")?,
                    argument::<String>(args, "cwd")?.into(),
                );
                #[cfg(not(unix))]
                return Err("Managed Shell integration is unavailable on this platform".into());
            }
            if request.command == "recover_terminal_agent" {
                #[cfg(unix)]
                {
                    let id = argument::<String>(args, "session_id")?;
                    let active = manager
                        .sessions
                        .lock()
                        .map_err(|_| "Session manager unavailable")?
                        .get(&id)
                        .cloned()
                        .ok_or("Terminal is no longer running")?;
                    if active._interactive_assets.is_none() {
                        return Err("This terminal does not support managed recovery".into());
                    }
                    crate::interactive_shell::recover(&active.history, &id)?;
                    use tauri::Emitter;
                    let _ = app.emit(
                        "agent-state",
                        crate::SessionMessage {
                            session_id: id,
                            data: "updated".into(),
                        },
                    );
                    return Ok(serde_json::json!({"status":"shell"}));
                }
                #[cfg(not(unix))]
                return Err("Managed Shell recovery is unavailable on this platform".into());
            }
            if request.command == "retry_session_finish" {
                crate::retry_session_finish(app.clone(), manager, argument(args, "session_id")?)?;
                return Ok(serde_json::Value::Null);
            }
            if request.command == "cli_start" {
                let private = app.path().app_data_dir().map_err(|_| "cli_unavailable")?;
                let session =
                    crate::cli::owner_start(Some(app.clone()), &manager, &private, &args["start"])?;
                return Ok(serde_json::json!({"session_id":session.session_id,"status":"started"}));
            }
            let result = match request.command.as_str() {
                "project_notification_policy" => {
                    return crate::project_notifications::handle(
                        manager.history(app)?.as_ref(),
                        &args["request"],
                    )
                }
                "project_backup" => {
                    return crate::project_backup::handle(
                        &manager.history(app)?,
                        &args["request"],
                        &manager,
                    )
                }
                "pi_packages" => serde_json::to_value(crate::pi_packages::handle(
                    &app.path()
                        .home_dir()
                        .map_err(|_| "Home directory unavailable")?,
                    argument(args, "request")?,
                )?),
                "copy_codex_routing" => serde_json::to_value(crate::copy_codex_routing(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                )?),
                "get_pi_routing" => serde_json::to_value(crate::get_pi_routing(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                )?),
                "pi_routing_control" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::pi_routing_control(
                        app.clone(),
                        manager,
                        argument(args, "session_id")?,
                        argument(args, "generation")?,
                        argument(args, "request")?,
                    ),
                )?),
                "pi_routing_catalog" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::pi_routing_catalog(
                        app.clone(),
                        manager,
                        argument(args, "cwd")?,
                        argument(args, "gateway")?,
                        argument(args, "probe_model")?,
                    ),
                )?),
                "codex_routing_catalog" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::codex_routing_catalog(
                        app.clone(),
                        manager,
                        argument(args, "cwd")?,
                        argument(args, "config")?,
                        argument(args, "probe_model")?,
                    ),
                )?),
                "get_history_policy" => {
                    serde_json::to_value(crate::get_history_policy(app.clone(), manager)?)
                }
                "set_history_policy" => serde_json::to_value(crate::set_history_policy(
                    app.clone(),
                    manager,
                    argument(args, "auto_archive_30_days")?,
                )?),
                "preview_archive_deletion" => {
                    serde_json::to_value(crate::preview_archive_deletion(
                        app.clone(),
                        manager,
                        argument(args, "session_ids")?,
                        argument(args, "validate_only")?,
                    )?)
                }
                "cancel_archive_deletion_preview" => {
                    serde_json::to_value(crate::cancel_archive_deletion_preview(
                        app.clone(),
                        manager,
                        argument(args, "preview_id")?,
                    )?)
                }
                "confirm_archive_deletion" => {
                    serde_json::to_value(crate::confirm_archive_deletion(
                        app.clone(),
                        manager,
                        argument(args, "preview_id")?,
                    )?)
                }
                "archive_session" => serde_json::to_value(crate::archive_session(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                )?),
                "restore_archive" => serde_json::to_value(crate::restore_archive(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                )?),
                "list_archived_sessions" => serde_json::to_value(crate::list_archived_sessions(
                    app.clone(),
                    manager,
                    argument(args, "request")?,
                )?),
                "list_session_summaries" => serde_json::to_value(crate::list_session_summaries(
                    app.clone(),
                    manager,
                    argument(args, "request")?,
                )?),
                "preview_worktree_create" => serde_json::to_value(crate::preview_worktree_create(
                    app.clone(),
                    manager,
                    argument(args, "root")?,
                    argument(args, "target")?,
                    argument(args, "reference")?,
                    argument(args, "branch")?,
                )?),
                "create_worktree" => serde_json::to_value(crate::create_worktree(
                    app.clone(),
                    manager,
                    argument(args, "attempt")?,
                )?),
                "list_managed_worktrees" => {
                    serde_json::to_value(crate::list_managed_worktrees(app.clone(), manager)?)
                }
                "preview_worktree_cleanup" => {
                    serde_json::to_value(crate::preview_worktree_cleanup(
                        app.clone(),
                        manager,
                        argument(args, "attempt")?,
                    )?)
                }
                "cleanup_worktree" => serde_json::to_value(crate::cleanup_worktree(
                    app.clone(),
                    manager,
                    argument(args, "attempt")?,
                    argument(args, "preview")?,
                )?),
                "get_launch_defaults" => {
                    serde_json::to_value(crate::get_launch_defaults(app.clone(), manager)?)
                }
                "set_launch_defaults" => serde_json::to_value(crate::set_launch_defaults(
                    app.clone(),
                    manager,
                    argument(args, "defaults")?,
                )?),
                "preview_project_config" => serde_json::to_value(crate::preview_project_config(
                    app.clone(),
                    manager,
                    argument(args, "cwd")?,
                )?),
                "trust_project_config" => serde_json::to_value(crate::trust_project_config(
                    app.clone(),
                    manager,
                    argument(args, "cwd")?,
                    argument(args, "preview")?,
                )?),
                "list_unread_receipts" => serde_json::to_value(crate::list_unread_receipts(
                    app.clone(),
                    manager,
                    argument(args, "request")?,
                )?),
                "next_attention" => serde_json::to_value(crate::next_attention(
                    app.clone(),
                    manager,
                    argument(args, "current_session_id")?,
                )?),
                "list_pending_notifications" => {
                    serde_json::to_value(crate::list_pending_notifications(
                        app.clone(),
                        manager,
                        argument(args, "limit")?,
                        argument(args, "after_key")?,
                    )?)
                }
                "scan_history_capacity" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::scan_history_capacity(app.clone(), manager),
                )?),
                "create_session" => serde_json::to_value(crate::create_session(
                    app.clone(),
                    manager,
                    argument(args, "cwd")?,
                    argument(args, "command")?,
                    argument(args, "launch")?,
                    argument(args, "resume_from")?,
                    argument(args, "project_config")?,
                    argument(args, "worktree_attempt")?,
                    argument(args, "shell")?,
                    argument(args, "env_refs")?,
                    argument(args, "directory_reporting")?,
                    argument(args, "retained_lines")?,
                    argument(args, "ssh")?,
                    argument(args, "command_reporting")?,
                )?),
                "read_session_log" => serde_json::to_value(crate::read_session_log(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                )?),
                "acknowledge_notification" => {
                    serde_json::to_value(crate::acknowledge_notification(
                        app.clone(),
                        manager,
                        argument(args, "session_id")?,
                        argument(args, "expected_status")?,
                    )?)
                }
                "test_notification" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::test_notification(app.clone(), manager, argument(args, "session_id")?),
                )?),
                "notify_session" => {
                    serde_json::to_value(tauri::async_runtime::block_on(crate::notify_session(
                        app.clone(),
                        manager,
                        argument(args, "session_id")?,
                        argument(args, "title")?,
                        argument(args, "expected_status")?,
                    ))?)
                }
                "set_notification_locale" => {
                    crate::set_notification_locale(manager, argument(args, "locale")?)?;
                    crate::system_entry::refresh_native(app);
                    serde_json::to_value(())
                }
                "set_agent_notification_context" => {
                    serde_json::to_value(crate::set_agent_notification_context(
                        app.clone(),
                        manager,
                        argument(args, "selected")?,
                        argument(args, "paused")?,
                        argument(args, "pause_revision")?,
                    )?)
                }
                "read_agent_receipt" => serde_json::to_value(crate::read_agent_receipt(
                    app.clone(),
                    manager,
                    argument(args, "session_id")?,
                    argument(args, "receipt")?,
                    argument(args, "revision")?,
                    argument(args, "only_current")?,
                )?),
                "search_session_logs" => serde_json::to_value(tauri::async_runtime::block_on(
                    crate::search_session_logs(
                        app.clone(),
                        manager,
                        argument(args, "session_id")?,
                        argument(args, "request")?,
                    ),
                )?),
                "read_log_excerpt" => {
                    serde_json::to_value(tauri::async_runtime::block_on(crate::read_log_excerpt(
                        app.clone(),
                        manager,
                        argument(args, "session_id")?,
                        argument(args, "offset")?,
                        argument(args, "column")?,
                    ))?)
                }
                _ => return Err("Unsupported background command".into()),
            };
            result.map_err(|_| "Cannot encode background command result".into())
        },
        |manager| manager.shutdown_for(app, notify_lifecycle),
    )
}

pub(super) fn dispatch_session_read<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    manager: tauri::State<'_, crate::SessionManager>,
    request: &Request,
) -> Option<Result<serde_json::Value, String>> {
    if !matches!(
        request.command.as_str(),
        "list_sessions"
            | "get_session"
            | "history_overview"
            | "read_session_snapshot"
            | "read_terminal_frame"
    ) {
        return None;
    }
    Some((|| {
        let args = &request.args;
        let result = match request.command.as_str() {
            "list_sessions" => serde_json::to_value(manager.history(app)?.list()?),
            "get_session" => serde_json::to_value(crate::get_session(
                app.clone(),
                manager,
                argument(args, "session_id")?,
            )?),
            "read_session_snapshot" => serde_json::to_value(crate::read_session_snapshot(
                app.clone(),
                manager,
                argument(args, "session_id")?,
            )?),
            "read_terminal_frame" => serde_json::to_value(crate::read_terminal_frame(
                app.clone(),
                manager,
                argument(args, "session_id")?,
            )?),
            "history_overview" => {
                serde_json::to_value(crate::history_overview(app.clone(), manager)?)
            }
            _ => unreachable!(),
        };
        result.map_err(|_| "Cannot encode background command result".into())
    })())
}

pub(super) fn dispatch_with<'a>(
    request: Request,
    manager: impl FnOnce() -> tauri::State<'a, crate::SessionManager>,
    app_dispatch: impl FnOnce(
        tauri::State<'a, crate::SessionManager>,
        Request,
    ) -> Result<serde_json::Value, String>,
    shutdown: impl FnOnce(tauri::State<'a, crate::SessionManager>) -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    validate_command(&request.command, &request.args)?;
    // Authenticated transport has already decoded owner/client identity. Git cancellation
    // must remain reachable without session admission or any heartbeat/lease mutation.
    if let Some(result) = dispatch_git_changes(&request) {
        return result;
    }
    let manager = manager();
    if request.command == "finish_update" {
        return if manager.shutting_down.load(Ordering::Acquire)
            && manager.shutdown_complete.load(Ordering::Acquire)
        {
            Ok(serde_json::Value::Null)
        } else {
            Err("Update was not prepared".into())
        };
    }
    let args = &request.args;
    let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    {
        // The idle exit decision and request admission share the session lock.
        let _sessions = manager
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned")?;
        if manager.shutting_down.load(Ordering::Acquire) {
            return Err("Background is shutting down; reconnect".into());
        }
        manager.last_request.store(now, Ordering::Release);
    }
    if request.command == "clear_terminal_display" {
        let id: String = argument(args, "session_id")?;
        if !manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .available(&id, &request.client, now)
        {
            return Ok(serde_json::json!({"status":"unavailable"}));
        }
    }
    if matches!(request.command.as_str(), "write_session" | "resize_session") {
        let id: String = argument(args, "session_id")?;
        if !manager
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned")?
            .contains_key(&id)
        {
            return Err("Unknown active terminal".into());
        }
        manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .claim(&id, &request.client, now)?;
    }
    if request.command == "pi_routing_control" {
        let id: String = argument(args, "session_id")?;
        if !manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .available(&id, &request.client, now)
        {
            return Err("This terminal is controlled by another window".into());
        }
    }
    if request.command == "poll_events" {
        manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .heartbeat(&request.client, now);
        let foreground: bool = args
            .get("foreground")
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .map_err(|_| "Invalid foreground context")?
            .unwrap_or(false);
        manager.desktop_connected.store(true, Ordering::Release);
        *manager
            .desktop_focus
            .lock()
            .map_err(|_| "Desktop focus lock poisoned")? = (std::time::Instant::now(), foreground);
    }
    if matches!(
        request.command.as_str(),
        "get_notification_pause_state"
            | "initialize_notification_pause"
            | "set_notification_paused"
    ) {
        return crate::system_entry::pause_command(&manager, &request.command, args);
    }
    if request.command == "get_system_entry_status" {
        return crate::system_entry::status(&manager);
    }
    if request.command == "cli_events" {
        return cli_event_page(&manager, argument(args, "cursor")?);
    }
    if ["cli_status", "cli_list", "cli_show"].contains(&request.command.as_str()) {
        return cli_read(
            &manager,
            &request.command,
            args.get("session_id").and_then(serde_json::Value::as_str),
        );
    }
    if request.command == "cli_focus" {
        let id: String = argument(args, "session_id")?;
        return cli_focus_owner(&manager, &id);
    }
    if request.command == "cli_stop" {
        let id: String = argument(args, "session_id")?;
        crate::stop_session(manager, id.clone())?;
        return Ok(serde_json::json!({"session_id":id,"status":"stop_requested"}));
    }
    let result = match request.command.as_str() {
        "diagnostics_report" => serde_json::to_value(crate::diagnostics::collect_owner(&manager)),
        "get_git_context" => serde_json::to_value(crate::git_context::query(
            std::path::Path::new(&argument::<String>(args, "path")?),
        )?),
        "cancel_history_capacity" => serde_json::to_value(crate::cancel_history_capacity(manager)?),
        "open_terminal_stream" => {
            return crate::external_terminal::open_stream(
                manager,
                &argument::<String>(args, "session_id")?,
                &request.client,
                argument(args, "cols")?,
                argument(args, "rows")?,
            )
        }
        "read_terminal_delta" => {
            return crate::external_terminal::delta(
                &manager,
                &argument::<String>(args, "session_id")?,
                &argument::<String>(args, "expected_instance")?,
                argument(args, "offset")?,
                &request.client,
                now,
            )
        }
        "release_terminal_control" => {
            manager
                .input_leases
                .lock()
                .map_err(|_| "Input ownership lock poisoned")?
                .release(&argument::<String>(args, "session_id")?, &request.client);
            return Ok(serde_json::Value::Null);
        }
        "take_terminal_control" => {
            let id: String = argument(args, "session_id")?;
            let sessions = manager
                .sessions
                .lock()
                .map_err(|_| "Session manager lock poisoned")?;
            let session = sessions.get(&id).ok_or("Unknown active terminal")?;
            if !["starting", "running"].contains(
                &session
                    .status
                    .lock()
                    .map_err(|_| "Session status lock poisoned")?
                    .as_str(),
            ) {
                return Err("The terminal process has ended".into());
            }
            manager
                .input_leases
                .lock()
                .map_err(|_| "Input ownership lock poisoned")?
                .take_control(&id, &request.client, now);
            Ok(serde_json::Value::Null)
        }
        "stop_session" => {
            serde_json::to_value(crate::stop_session(manager, argument(args, "session_id")?)?)
        }
        "session_finish_pending" => serde_json::to_value(crate::session_finish_pending(
            manager,
            argument(args, "session_id")?,
        )?),
        "write_session" => serde_json::to_value(crate::terminal_input::write_session_guarded(
            manager,
            argument(args, "session_id")?,
            argument(args, "data")?,
            argument(args, "expected_agent")?,
        )?),
        "resize_session" => {
            let id: String = argument(args, "session_id")?;
            serde_json::to_value(after_terminal_control(&manager, &id, || {
                crate::resize_session(
                    manager.clone(),
                    id.clone(),
                    argument(args, "cols")?,
                    argument(args, "rows")?,
                )
            })?)
        }
        "clear_terminal_display" => {
            let id: String = argument(args, "session_id")?;
            serde_json::to_value(after_terminal_control(&manager, &id, || {
                crate::clear_terminal_display(
                    manager.clone(),
                    id.clone(),
                    argument(args, "expected_instance")?,
                )
            })?)
        }
        "navigate_reported_prompt" => {
            let id: String = argument(args, "session_id")?;
            serde_json::to_value(after_terminal_control(&manager, &id, || {
                crate::navigate_reported_prompt(
                    manager.clone(),
                    id.clone(),
                    argument(args, "direction")?,
                    argument(args, "expected_instance")?,
                )
            })?)
        }
        "set_terminal_viewport" => {
            let id: String = argument(args, "session_id")?;
            serde_json::to_value(after_terminal_control(&manager, &id, || {
                crate::set_terminal_viewport(
                    manager.clone(),
                    id.clone(),
                    argument(args, "line")?,
                    args.get("bottom").and_then(serde_json::Value::as_bool),
                )
            })?)
        }
        "memory_processes" => serde_json::to_value(crate::memory_processes(&manager)?),
        "background_status" => Ok(serde_json::json!({"pid":std::process::id(),
            "runtime_pid":manager.terminal_runtime.lock().map_err(|_|"Terminal runtime lock poisoned")?.as_ref().and_then(|r|r.process_id().ok()),
            "desktop_connected":manager.desktop_connected.load(Ordering::Acquire) && manager.desktop_focus.lock().map_err(|_|"Desktop focus lock poisoned")?.0.elapsed() < Duration::from_secs(3),
            "ssh_launch_v1":true,
            "zsh_command_reporting_v1":true,
            "updater_idle_install_v1":true,
            "updater_idle_install_v2":true,
            "active_sessions":manager.sessions.lock().map_err(|_|"Session manager lock poisoned")?.len()})),
        "poll_events" => serde_json::to_value(
            manager
                .relay
                .lock()
                .map_err(|_| "Event relay lock poisoned")?
                .poll(argument(args, "cursor")?),
        ),
        "retry_agent_notifications" => {
            serde_json::to_value(crate::retry_agent_notifications(manager)?)
        }
        "cancel_log_search" => serde_json::to_value(tauri::async_runtime::block_on(
            crate::cancel_log_search(manager),
        )?),
        "prepare_update" => {
            claim_idle_update(&manager.sessions, &manager.shutting_down)?;
            if let Err(error) = shutdown(manager.clone()) {
                manager.shutting_down.store(false, Ordering::Release);
                return Err(error);
            }
            Ok(serde_json::Value::Null)
        }
        "shutdown" => {
            manager.shutting_down.store(true, Ordering::Release);
            if let Err(error) = shutdown(manager.clone()) {
                manager.shutting_down.store(false, Ordering::Release);
                return Err(error);
            }
            Ok(serde_json::Value::Null)
        }
        _ => return app_dispatch(manager, request),
    };
    result.map_err(|_| "Cannot encode background command result".into())
}

// Start rechecks the same closing flag while holding this exact session lock before spawning.
pub(super) fn claim_idle_update<T>(
    sessions: &Mutex<std::collections::HashMap<String, T>>,
    closing: &AtomicBool,
) -> Result<(), String> {
    let active = sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?;
    if !active.is_empty() {
        return Err("running_tasks".into());
    }
    if closing.swap(true, Ordering::AcqRel) {
        return Err("Background is closing".into());
    }
    Ok(())
}
#[cfg(test)]
mod dispatch_admission_tests {
    use super::*;
    use crate::background::PROTOCOL_VERSION;
    use tauri::Manager;

    fn request(command: &str, args: serde_json::Value) -> Request {
        Request {
            version: PROTOCOL_VERSION,
            token: "a".repeat(64),
            instance: "b".repeat(64),
            client: "c".repeat(64),
            id: 1,
            command: command.into(),
            args,
        }
    }

    #[test]
    fn contract_and_git_cancellation_precede_session_admission() {
        let dispatch = |request| {
            dispatch_with(
                request,
                || panic!("must not acquire session state"),
                |_, _| panic!("must not reach app dispatch"),
                |_| panic!("must not shut down"),
            )
        };
        assert!(dispatch(request("unknown_command", serde_json::json!({}))).is_err());
        assert!(dispatch(request(
            "cancel_git_changes",
            serde_json::json!({
                "query_token":"12345678-1234-4234-8234-123456789abc"
            })
        ))
        .is_ok());
    }

    #[test]
    fn normal_dispatch_and_shutdown_preserve_admission_and_completion() {
        let app = tauri::test::mock_builder()
            .manage(crate::SessionManager::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let manager = app.state::<crate::SessionManager>();
        assert_eq!(
            dispatch_with(
                request("list_sessions", serde_json::json!({})),
                || manager.clone(),
                |_, request| Ok(serde_json::json!(request.command)),
                |_| panic!("read must not shut down")
            )
            .unwrap(),
            "list_sessions"
        );
        assert_eq!(
            dispatch_with(
                request("prepare_update", serde_json::json!({})),
                || manager.clone(),
                |_, _| panic!("update must not reach app"),
                |_| Err("shutdown failed".into())
            )
            .unwrap_err(),
            "shutdown failed"
        );
        assert!(!manager.shutting_down.load(Ordering::Acquire));
        dispatch_with(
            request("prepare_update", serde_json::json!({})),
            || manager.clone(),
            |_, _| panic!("update must not reach app"),
            |_| Ok(()),
        )
        .unwrap();
        assert!(manager.shutting_down.load(Ordering::Acquire));
        assert!(dispatch_with(
            request("list_sessions", serde_json::json!({})),
            || manager.clone(),
            |_, _| panic!("closing owner must reject reads"),
            |_| Ok(())
        )
        .is_err());
        assert!(dispatch_with(
            request("finish_update", serde_json::json!({})),
            || manager.clone(),
            |_, _| panic!("finish must not reach app"),
            |_| Ok(())
        )
        .is_err());
        manager.shutdown_complete.store(true, Ordering::Release);
        assert_eq!(
            dispatch_with(
                request("finish_update", serde_json::json!({})),
                || manager.clone(),
                |_, _| panic!("finish must not reach app"),
                |_| Ok(())
            )
            .unwrap(),
            serde_json::Value::Null
        );
    }
}

#[cfg(test)]
mod memory_tests {
    #[test]
    fn terminal_control_invalidation_follows_both_success_and_failure_without_replacing_results() {
        let manager = crate::SessionManager::default();
        let result = super::after_terminal_control(&manager, "s-one", || {
            assert!(manager.relay.lock().unwrap().poll(0).events.is_empty());
            Ok(42)
        });
        assert_eq!(result, Ok(42));
        let page = manager.relay.lock().unwrap().poll(0);
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].name, "terminal-frame-invalidated");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&page.events[0].payload).unwrap(),
            serde_json::json!({"session_id":"s-one"})
        );
        let result = super::after_terminal_control(&manager, "s-one", || {
            Err::<(), _>("synthetic control error".to_owned())
        });
        assert_eq!(result.unwrap_err(), "synthetic control error");
        assert_eq!(manager.relay.lock().unwrap().poll(0).events.len(), 2);
    }
}
