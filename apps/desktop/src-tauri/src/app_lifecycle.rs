// Author: Jeff.Liu. GUI and owner exit, reopen and session cleanup fences.
use super::{background_events, system_entry, updater, AppHandle, SessionManager, SessionMessage};
use std::{
    sync::{atomic::Ordering, Arc},
    thread,
};
use tauri::{Emitter, Manager};

pub(crate) fn keep_background_event_loop(owner: bool, stopping: bool) -> bool {
    owner && !stopping
}
#[cfg(target_os = "macos")]
pub(crate) fn handle_native_reopen(
    reopen: bool,
    manager: &SessionManager,
    hide_owner: impl FnOnce() -> Result<(), String>,
    open_owner: impl FnOnce() -> Result<(), String>,
    show_desktop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !reopen || manager.shutting_down.load(Ordering::Acquire) {
        return Ok(());
    }
    if manager.background_owner {
        hide_owner()?;
        open_owner()
    } else {
        show_desktop()
    }
}

pub(crate) fn handle_owner_exit(app: &AppHandle, event: tauri::RunEvent) {
    let manager = app.state::<SessionManager>();
    #[cfg(target_os = "macos")]
    if handle_native_reopen(
        matches!(event, tauri::RunEvent::Reopen { .. }),
        &manager,
        || {
            // Launch Services can promote the resident owner when reopening the regular app bundle.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                .map_err(|_| "system_entry_open_failed".to_string())
        },
        || system_entry::open_native(app),
        || system_entry::show_desktop(app),
    )
    .is_err()
    {
        eprintln!("[YAM] Native reopen failed");
    }
    if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
        if manager.background_owner {
            eprintln!(
                "[YAM] Background exit request: code={code:?}, stopping={}",
                manager.shutting_down.load(Ordering::Acquire)
            );
        }
        if keep_background_event_loop(
            manager.background_owner,
            manager.shutting_down.load(Ordering::Acquire),
        ) {
            // The zero-window owner must stay alive until shutdown or its idle deadline.
            api.prevent_exit();
            return;
        }
    }
    let controller = if manager.background_owner {
        None
    } else {
        app.try_state::<Arc<updater::Controller>>()
    };
    let request = if let tauri::RunEvent::ExitRequested { code, .. } = &event {
        Some(code.unwrap_or(0))
    } else {
        None
    };
    if handle_gui_exit_with(
        &manager,
        controller.as_ref().map(|state| state.inner()),
        request,
        matches!(event, tauri::RunEvent::Exit),
        || {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                api.prevent_exit();
            }
        },
        |controller, code| {
            let handle = app.clone();
            thread::spawn(move || {
                controller.shutdown_and_join();
                handle.exit(code);
            });
        },
    ) {
        return;
    }
    if matches!(event, tauri::RunEvent::Exit) {
        let manager = app.state::<SessionManager>();
        if !manager.shutdown_complete.load(Ordering::Acquire) {
            manager.shutting_down.store(true, Ordering::Release);
            if let Err(error) = manager.shutdown_for(app, background_events::notify_lifecycle) {
                eprintln!("[YAM] Final exit cleanup failed: {error}");
            }
        }
    }
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let manager = app.state::<SessionManager>();
        if claim_session_exit(&manager, || api.prevent_exit()) {
            let app = app.clone();
            thread::spawn(move || {
                let manager = app.state::<SessionManager>();
                complete_session_exit(
                    &manager,
                    || manager.shutdown_for(&app, background_events::notify_lifecycle),
                    || app.exit(0),
                    |error| {
                        let _ = app.emit(
                            "session-error",
                            SessionMessage {
                                session_id: String::new(),
                                data: error,
                            },
                        );
                    },
                );
            });
        }
    }
}

pub(crate) fn handle_gui_exit_with(
    manager: &SessionManager,
    controller: Option<&Arc<updater::Controller>>,
    request: Option<i32>,
    exiting: bool,
    prevent_exit: impl FnOnce(),
    start_cleanup: impl FnOnce(Arc<updater::Controller>, i32),
) -> bool {
    // GUI update work is fenced and exactly joined before the detached-client early return.
    if !manager.background_owner {
        if let Some(controller) = controller {
            if let Some(code) = request {
                if controller.prepare_exit() {
                    prevent_exit();
                    if controller.claim_exit_cleanup() {
                        start_cleanup(controller.clone(), code);
                    }
                    return true;
                }
            }
            if exiting {
                controller.shutdown_and_join();
            }
        }
    }
    if manager
        .background_client
        .lock()
        .is_ok_and(|client| client.is_some())
    {
        if exiting || request.is_some() {
            manager.shutting_down.store(true, Ordering::Release);
        }
        return true;
    }
    false
}

pub(crate) fn claim_session_exit(manager: &SessionManager, prevent_exit: impl FnOnce()) -> bool {
    if manager.shutdown_complete.load(Ordering::Acquire) {
        return false;
    }
    prevent_exit();
    !manager.shutting_down.swap(true, Ordering::AcqRel)
}

pub(crate) fn complete_session_exit(
    manager: &SessionManager,
    shutdown: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(),
    report: impl FnOnce(String),
) {
    match shutdown() {
        Ok(()) => exit(),
        Err(error) => {
            manager.shutting_down.store(false, Ordering::Release);
            report(error);
        }
    }
}
