use crate::background::RelayPage;
use std::time::Duration;
use std::{
    sync::{atomic::Ordering, Arc},
    thread,
};

pub(super) fn poll_events_with_reconnect(
    cursor: u64,
    foreground: bool,
    mut call: impl FnMut(serde_json::Value) -> Result<serde_json::Value, String>,
    mut wait: impl FnMut(Duration),
) -> (Result<RelayPage, String>, bool) {
    const ATTEMPTS: u64 = 3;
    let mut last_error = String::new();
    for attempt in 0..ATTEMPTS {
        let result =
            call(serde_json::json!({"cursor":cursor,"foreground":foreground})).and_then(|value| {
                serde_json::from_value::<RelayPage>(value)
                    .map_err(|_| "Invalid background event page".into())
            });
        match result {
            Ok(page) => return (Ok(page), attempt > 0),
            Err(error) => last_error = error,
        }
        if attempt + 1 < ATTEMPTS {
            wait(Duration::from_millis(250 * (attempt + 1)));
        }
    }
    // Reuse the authenticated client. Recovery never discovers or starts another owner.
    (Err(last_error), false)
}

pub(super) fn poll(
    client: &crate::background::Client,
    cursor: u64,
    foreground: bool,
) -> Result<(RelayPage, bool), String> {
    let (result, reconnected) = poll_events_with_reconnect(
        cursor,
        foreground,
        |args| client.call("poll_events", args),
        thread::sleep,
    );
    result.map(|page| (page, reconnected))
}

pub(super) fn lifecycle_due(
    foreground: bool,
    selected: Option<&str>,
    session: &str,
    paused: bool,
) -> bool {
    !paused && (!foreground || selected != Some(session))
}

#[derive(Default)]
pub(super) struct EventPoll {
    pub(super) running: bool,
    pub(super) cursor: u64,
}
impl EventPoll {
    pub(super) fn is_running(&self) -> bool {
        self.running
    }
}

// Unopened terminals recover from authoritative frames rather than buffering live bytes in WebKit.
pub(super) fn emit_desktop_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    payload: serde_json::Value,
) {
    use tauri::{Emitter, Manager};
    if name == "session-output" {
        if let Some(id) = payload["session_id"].as_str() {
            if let Ok(table) = app.state::<super::SessionManager>().desktop_windows.lock() {
                if !table.observes_output(id) {
                    return;
                }
            }
        }
    }
    let _ = app.emit(name, payload);
}

pub(super) fn start_event_poll(
    app: &tauri::AppHandle,
    client: Arc<crate::background::Client>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let manager = app.state::<super::SessionManager>();
    let mut poll = manager
        .background_events
        .lock()
        .map_err(|_| "background_reconnect_unavailable")?;
    if poll.running {
        return Ok(());
    }
    poll.running = true;
    let mut cursor = poll.cursor;
    drop(poll);
    let app = app.clone();
    thread::spawn(move || {
        while !app
            .state::<super::SessionManager>()
            .shutting_down
            .load(Ordering::Acquire)
        {
            match self::poll(
                &client,
                cursor,
                app.state::<super::SessionManager>()
                    .desktop_foreground
                    .load(Ordering::Acquire),
            ) {
                Ok((page, reconnected)) => {
                    if page.gap || reconnected {
                        let _ = app.emit(
                            "background-gap",
                            serde_json::json!({"missing_events":page.gap}),
                        );
                    }
                    cursor = page.cursor;
                    if let Ok(mut poll) = app
                        .state::<super::SessionManager>()
                        .background_events
                        .lock()
                    {
                        poll.cursor = cursor;
                    }
                    for event in page.events {
                        if let Ok(payload) =
                            serde_json::from_str::<serde_json::Value>(&event.payload)
                        {
                            if event.name == "desktop-open" && payload == serde_json::json!({}) {
                                let _ = super::system_entry::show_desktop(&app);
                            } else if event.name == "desktop-owner-quit"
                                && payload == serde_json::json!({})
                            {
                                app.exit(0);
                            } else if event.name == "cli-focus" {
                                let manager = app.state::<super::SessionManager>();
                                let _ = crate::background::desktop_cli_focus(
                                    &manager,
                                    &payload,
                                    |id| super::route_notification_session(&app, id),
                                );
                            } else {
                                if event.name == "session-state" {
                                    if let (Some(id), Some(status)) =
                                        (payload["session_id"].as_str(), payload["status"].as_str())
                                    {
                                        let manager = app.state::<super::SessionManager>();
                                        if let Ok(mut table) = manager.desktop_windows.lock() {
                                            table.note_status(id, status);
                                        };
                                    }
                                }
                                emit_desktop_event(&app, &event.name, payload);
                            }
                        }
                    }
                }
                Err(error) => {
                    if let Ok(mut poll) = app
                        .state::<super::SessionManager>()
                        .background_events
                        .lock()
                    {
                        poll.running = false;
                    }
                    let _ = app.emit(
                        "session-error",
                        serde_json::json!({"session_id":"","data":error}),
                    );
                    return; // Never silently restart an owner or rerun its tasks after a crash.
                }
            }
            thread::sleep(Duration::from_millis(40));
        }
        if let Ok(mut poll) = app
            .state::<super::SessionManager>()
            .background_events
            .lock()
        {
            poll.running = false;
        }
    });
    Ok(())
}

pub(super) fn notify_lifecycle(app: &tauri::AppHandle, session: &str, status: &str) {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    if !manager.background_owner
        || !super::is_terminal(status)
        || manager.shutting_down.load(Ordering::Acquire)
    {
        return;
    }
    let foreground = manager
        .desktop_focus
        .lock()
        .is_ok_and(|f| f.1 && f.0.elapsed() < Duration::from_secs(3));
    let Ok((selected, paused)) = super::system_entry::lifecycle_context(&manager) else {
        return;
    };
    if !lifecycle_due(foreground, selected.as_deref(), session, paused) {
        return;
    }
    let Ok(history) = manager.history(app) else {
        return;
    };
    let app = app.clone();
    let session = session.to_string();
    let status = status.to_string();
    let chinese = super::system_entry::notification_chinese(&app);
    thread::spawn(move || {
        if let Err(error) = history.native_delivery(
            &session,
            super::agent_events::NativeSource::Lifecycle(&status),
            |record| {
                super::send_native_notification(
                    app.clone(),
                    session.clone(),
                    &record.summary.cwd,
                    super::system_entry::notification_status(&record.status, chinese),
                    record
                        .reason
                        .clone()
                        .unwrap_or_else(|| record.summary.cwd.clone()),
                    &record.status,
                )
            },
        ) {
            eprintln!("[YAM] {error}");
        }
    });
}
#[cfg(test)]
#[path = "background_events_tests.rs"]
mod tests;
