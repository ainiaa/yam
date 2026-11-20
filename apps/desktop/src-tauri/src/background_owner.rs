// Author: Jeff.Liu. Windowless owner startup, maintenance and shutdown.
use super::{
    commands::dispatch, dispatch_session_start, observe_owner_event, validate_command, Descriptor,
    OwnerLock, Request, Server, StartRequests,
};
#[cfg(target_os = "macos")]
use super::{ignore_platform_window_restoration, ProcessActivity};
use crate::background_events::notify_lifecycle;
use std::{
    sync::{atomic::Ordering, Arc},
    thread,
    time::Duration,
};

pub(super) fn idle_due(now: u64, last_request: u64, active: usize) -> bool {
    active == 0 && now.saturating_sub(last_request) >= 60_000
}
pub(super) fn idle_maintenance_exit_due(
    now: u64,
    last_request_after: u64,
    active_after: usize,
) -> Result<bool, String> {
    Ok(idle_due(now, last_request_after, active_after))
}
pub(super) fn configure_owner_app(config: &mut tauri::utils::config::AppConfig) {
    config.windows.clear();
    // The GUI owns GTK/D-Bus activation. Sharing its name makes the owner a remote GUI instance.
    #[cfg(target_os = "linux")]
    {
        config.enable_gtk_app_id = false;
    }
}
pub(crate) fn run() -> Result<(), String> {
    let selected_node =
        crate::node_runtime::background_node(&std::env::args_os().skip(2).collect::<Vec<_>>())?;
    use tauri::{Listener, Manager};
    #[cfg(target_os = "macos")]
    ignore_platform_window_restoration();
    #[cfg(target_os = "macos")]
    let _activity = ProcessActivity::begin();
    let mut context = crate::app_context();
    configure_owner_app(&mut context.config_mut().app);
    let owner: Arc<std::sync::Mutex<Option<Server>>> = Arc::new(std::sync::Mutex::new(None));
    let setup_owner = owner.clone();
    eprintln!("[YAM] Creating background event loop");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(crate::SessionManager {
            background_owner: true,
            ..Default::default()
        })
        .setup(move |app| {
            eprintln!("[YAM] Initializing background owner");
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            for name in [
                "session-output",
                "session-state",
                "session-phase",
                "session-attention",
                "session-error",
                "agent-state",
                "session-notification-click",
            ] {
                let handle = app.handle().clone();
                app.listen_any(name, move |event| {
                    let _ = observe_owner_event(
                        &handle.state::<crate::SessionManager>(),
                        name,
                        event.payload(),
                    );
                });
            }
            #[cfg(target_os = "macos")]
            crate::mac_notifications::init(app.handle())?;
            let root = app.path().app_data_dir()?.join("background");
            let owner_lock = OwnerLock::acquire(&root)?;
            // Exclusive ownership precedes recovery of interrupted records and all history writes.
            app.state::<crate::SessionManager>().history(app.handle())?;
            let script = app.path().resolve(
                "target/terminal-runtime/yam-terminal.cjs",
                tauri::path::BaseDirectory::Resource,
            )?;
            let cache = app.path().app_data_dir()?.join("runtimes/node");
            let node = match selected_node {
                Some(node) => node,
                None => crate::node_runtime::resolve(&script, &cache, false, |_| {})?,
            };
            let (send, receive) = std::sync::mpsc::sync_channel::<(String, String)>(64);
            let query_handle = app.handle().clone();
            let parser = Arc::new(crate::terminal_runtime::Runtime::start_node(
                &node,
                &script,
                move |id, data| {
                    let manager = query_handle.state::<crate::SessionManager>();
                    let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    // Decide when the query is parsed. Pre-handoff replies still drain once.
                    if !manager
                        .input_leases
                        .lock()
                        .map_err(|_| "Input ownership lock poisoned")?
                        .headless_queries(&id, now)
                    {
                        return Ok(());
                    }
                    send.try_send((id, data))
                        .map_err(|_| "Terminal query queue exceeded its budget".into())
                },
            )?);
            *app.state::<crate::SessionManager>()
                .terminal_runtime
                .lock()
                .map_err(|_| "Terminal runtime lock poisoned")? = Some(parser);
            let handle = app.handle().clone();
            thread::spawn(move || {
                for (id, data) in receive {
                    if let Err(error) = crate::write_session(
                        handle.state::<crate::SessionManager>(),
                        id.clone(),
                        data,
                    ) {
                        use tauri::Emitter;
                        let _ = handle.emit(
                            "session-error",
                            crate::SessionMessage {
                                session_id: id,
                                data: error,
                            },
                        );
                    }
                }
            });
            let handle = app.handle().clone();
            let namespace = crate::agent_bridge::credential()?[..32].to_string();
            app.state::<crate::SessionManager>()
                .cli_namespace
                .set(namespace.clone())
                .map_err(|_| "cli_context_initialized")?;
            let starts = std::sync::Mutex::new(StartRequests::default());
            let exit_handle = app.handle().clone();
            let server = Server::start_owned(
                &root,
                owner_lock,
                move |request| {
                    validate_command(&request.command, &request.args)?;
                    if request.command == "create_session" {
                        dispatch_session_start(&starts, request, |request| {
                            dispatch(&handle, request)
                        })
                    } else if request.command == "cli_start" {
                        let duplicate = Request {
                            version: request.version,
                            token: request.token.clone(),
                            instance: request.instance.clone(),
                            client: request.client.clone(),
                            id: request.id,
                            command: request.command.clone(),
                            args: request.args.clone(),
                        };
                        starts
                            .lock()
                            .map_err(|_| "cli_unavailable")?
                            .run_cli(&duplicate, || dispatch(&handle, request))
                    } else {
                        dispatch(&handle, request)
                    }
                },
                move || exit_handle.exit(0),
                namespace,
            )?;
            *setup_owner
                .lock()
                .map_err(|_| "Background owner lock poisoned")? = Some(server);
            let instance = Descriptor::read(&root)?.instance;
            app.state::<crate::SessionManager>()
                .system_entry
                .lock()
                .map_err(|_| "system_entry_unavailable")?
                .initialize(&instance, true, true, || Ok(()))?;
            crate::system_entry::initialize_native(app.handle(), &root);
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(1));
                crate::system_entry::refresh_native(&handle);
                let manager = handle.state::<crate::SessionManager>();
                if manager.shutting_down.load(Ordering::Acquire) {
                    break;
                }
                let Ok(active) = manager.sessions.lock() else {
                    break;
                };
                let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if idle_due(
                    now,
                    manager.last_request.load(Ordering::Acquire),
                    active.len(),
                ) {
                    let request_before = manager.last_request.load(Ordering::Acquire);
                    drop(active);
                    let maintenance = (|| -> Result<(), String> {
                        let history = manager.history(&handle)?;
                        let _gate = crate::agent_events::NATIVE_DELIVERY
                            .lock()
                            .map_err(|_| "Notification delivery lock poisoned")?;
                        let claims = manager
                            .resume_claims
                            .lock()
                            .map_err(|_| "Resume claim lock poisoned")?;
                        history.auto_archive_batch_checked(
                            crate::unix_timestamp(),
                            &claims,
                            &Default::default(),
                            std::time::Instant::now() + Duration::from_secs(2),
                            &|| {
                                manager.shutting_down.load(Ordering::Acquire)
                                    || manager.last_request.load(Ordering::Acquire)
                                        != request_before
                                    || manager
                                        .sessions
                                        .lock()
                                        .map_or(true, |sessions| !sessions.is_empty())
                            },
                        )?;
                        Ok(())
                    })();
                    if let Err(error) = maintenance {
                        eprintln!("[YAM] {error}");
                    }
                    let Ok(active) = manager.sessions.lock() else {
                        break;
                    };
                    let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    // Request admission also holds this lock: no accepted RPC can slip past this check.
                    if manager.shutting_down.load(Ordering::Acquire)
                        || !idle_maintenance_exit_due(
                            now,
                            manager.last_request.load(Ordering::Acquire),
                            active.len(),
                        )
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    manager.shutting_down.store(true, Ordering::Release);
                    drop(active); // Start checks this flag again under the same session lock.
                    match manager.shutdown_for(&handle, notify_lifecycle) {
                        Ok(()) => {
                            handle.exit(0);
                            break;
                        }
                        Err(error) => {
                            eprintln!("[YAM] {error}");
                            manager.shutting_down.store(false, Ordering::Release);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("Cannot initialize background: {error}"))?
        .run(crate::app_lifecycle::handle_owner_exit);
    owner
        .lock()
        .map_err(|_| "Background owner lock poisoned")?
        .take();
    Ok(())
}
