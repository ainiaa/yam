// Author: Jeff.Liu. Commands operate only on test-owned state, PTYs and history files.
static RUST85_OWNER_SEARCH_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn closure_t20_owned_session_crosses_wire_move_agent_finish_archive_and_real_reopen() {
    use crate::desktop_windows as windows;
    use crate::tests::{closure_t01_app, closure_t01_shell, closure_t01_start, T01Started};
    use std::sync::Mutex;
    use tauri::Manager;
    let _serial = crate::worktree_manager::serial_owner_test();
    let mut fixture = crate::tests::Rust85Session::new("exit 0");
    let instance = fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    std::fs::write(fixture.root.join("bash"), b"#!/bin/sh\nstty -echo\nprintf 'READY\\n'\nIFS= read -r line\nprintf 'WIRE:%s\\n' \"$line\"\nIFS= read -r line\nprintf 'TAIL:%s\\n' \"$line\"\n").unwrap();
    let app = closure_t01_app(&fixture);
    let manager = app.state::<crate::SessionManager>();
    let started = T01Started::default();
    let spawns = std::cell::Cell::new(0);
    let reply = closure_t01_start(
        &fixture,
        &app,
        None,
        None,
        |slave, command| {
            spawns.set(spawns.get() + 1);
            slave.spawn_command(command).map_err(|e| e.to_string())
        },
        |_, _, _, _, _| panic!("ordinary shell has no hook probe"),
        &started,
    )
    .unwrap();
    let id = reply.summary.session_id;
    assert_ne!(id, fixture.id());
    let (allocated, reader) = started.borrow_mut().pop().unwrap();
    assert_eq!(allocated.id(), id);
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let workers = crate::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        allocated.session.clone(),
        reader,
        move |_, id, status| {
            observed
                .lock()
                .unwrap()
                .push((id.to_owned(), status.to_owned()))
        },
    );
    let handle = app.handle().clone();
    let wire_root = fixture.root.join("whole-chain-wire");
    let server = Server::start(&wire_root, move |request| {
        dispatch_with(
            request,
            || handle.state(),
            |manager, request| {
                if request.command == "archive_session" {
                    crate::archive_session(
                        handle.clone(),
                        manager,
                        argument(&request.args, "session_id")?,
                    )?;
                    return Ok(serde_json::Value::Null);
                }
                dispatch_session_read(&handle, manager, &request)
                    .unwrap_or_else(|| Err("unexpected whole-chain command".into()))
            },
            |_| panic!("no owner shutdown in this workflow"),
        )
    })
    .unwrap();
    let client = Client::new(Descriptor::read(&wire_root).unwrap()).unwrap();
    let main_window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let main = main_window.as_ref().clone();
    windows::desktop_window_bootstrap(
        app.handle().clone(),
        main.clone(),
        app.state(),
        vec![id.clone()],
        vec![],
        1,
    )
    .unwrap();
    let generation = windows::claim_terminal_view(
        app.handle().clone(),
        main.clone(),
        app.state(),
        1,
        id.clone(),
    )
    .unwrap()
    .unwrap();
    // The parser is a protocol fixture; exact output bytes come from the real PTY log.
    let ready_deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::fs::read(allocated.session.history.log_path(&id)).unwrap() != b"READY\r\n" {
        assert!(
            std::time::Instant::now() < ready_deadline,
            "owned shell did not disable echo before input"
        );
        thread::sleep(Duration::from_millis(5));
    }
    client
        .call(
            "write_session",
            serde_json::json!({"session_id":id,"data":"owned-π\n"}),
        )
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let bytes = std::fs::read(allocated.session.history.log_path(&id)).unwrap();
        if bytes.ends_with("WIRE:owned-π\r\n".as_bytes()) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "real PTY output did not reach log: {bytes:?}"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let frame = windows::read_terminal_frame(
        app.handle().clone(),
        main.clone(),
        app.state(),
        1,
        generation,
        id.clone(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(frame.projection["session"], id);
    assert_eq!(frame.projection["instance"], instance);
    let pending = tauri::async_runtime::block_on(windows::prepare_terminal_move(
        app.handle().clone(),
        main.clone(),
        app.state(),
        1,
        id.clone(),
        generation,
        serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
    ))
    .unwrap();
    let pending = serde_json::to_value(pending).unwrap();
    let token = pending["receipt"]["token"].as_u64().unwrap();
    let released = windows::release_terminal_view(
        main.clone(),
        app.state(),
        1,
        id.clone(),
        generation,
        Some(token),
    )
    .unwrap()
    .unwrap();
    let released = serde_json::to_value(released).unwrap();
    let receipt = &released["receipt"];
    assert_eq!(receipt["session_id"], id);
    let epoch = receipt["target_epoch"].as_u64().unwrap();
    let target_generation = receipt["target_generation"].as_u64().unwrap();
    let secondary = app.get_webview("terminal-secondary").unwrap();
    assert_eq!(
        serde_json::to_value(windows::accept_terminal_move(
            secondary.clone(),
            app.state(),
            epoch,
            token
        ))
        .unwrap()["receipt"]["session_id"],
        id
    );
    assert_eq!(
        serde_json::to_value(windows::complete_terminal_move(
            secondary.clone(),
            app.state(),
            epoch,
            token
        ))
        .unwrap()["receipt"]["session_id"],
        id
    );
    assert!(windows::write_session(
        main,
        app.state(),
        1,
        generation,
        id.clone(),
        "FORBIDDEN\n".into()
    )
    .is_err());
    allocated
        .session
        .history
        .configure_agent(&id, "whole-chain-generation")
        .unwrap();
    let changes = Arc::new(Mutex::new(Vec::new()));
    let changed = changes.clone();
    let bridge =
        crate::agent_bridge::Bridge::start(allocated.session.history.clone(), move |id, error| {
            assert!(error.is_none());
            changed.lock().unwrap().push(id.to_owned());
        })
        .unwrap();
    let credential = crate::agent_bridge::credential().unwrap();
    bridge
        .register(&id, &credential, "whole-chain-generation")
        .unwrap();
    for kind in [
        "SessionStart",
        "UserPromptSubmit",
        "TurnComplete",
        "TurnComplete",
    ] {
        let mut stream = TcpStream::connect(bridge.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(&serde_json::to_vec(&serde_json::json!({"version":1,"token":credential,"event":{"kind":kind,"agent_session_id":"whole-chain-native","turn_id":if kind=="SessionStart" {None} else {Some("whole-chain-turn")}}})).unwrap()).unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut ack = String::new();
        stream.read_to_string(&mut ack).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&ack).unwrap()["accepted"],
            true
        );
    }
    assert_eq!(
        changes.lock().unwrap().as_slice(),
        [id.clone(), id.clone(), id.clone(), id.clone()]
    );
    let live = client
        .call("get_session", serde_json::json!({"session_id":id}))
        .unwrap();
    assert_eq!(live["status"], "running");
    assert_eq!(live["agent"]["inbox"].as_array().unwrap().len(), 1);
    windows::write_session(
        secondary.clone(),
        app.state(),
        epoch,
        target_generation,
        id.clone(),
        "finish\n".into(),
    )
    .unwrap();
    crate::tests::closure_t02_wait_workers(workers);
    let expected = "READY\r\nWIRE:owned-π\r\nTAIL:finish\r\n".as_bytes();
    assert_eq!(
        std::fs::read(allocated.session.history.log_path(&id)).unwrap(),
        expected
    );
    assert_eq!(
        *notifications.lock().unwrap(),
        [(id.clone(), "succeeded".into())]
    );
    assert!(manager.sessions.lock().unwrap().is_empty());
    let ended = client
        .call("get_session", serde_json::json!({"session_id":id}))
        .unwrap();
    assert_eq!(ended["summary"]["session_id"], id);
    assert_eq!(ended["status"], "succeeded");
    assert_eq!(ended["output_end_offset"], expected.len());
    let final_frame: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join(format!("{id}.frame.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(final_frame["projection"]["session"], id);
    assert_eq!(final_frame["projection"]["instance"], instance);
    assert_eq!(final_frame["end_offset"], expected.len());
    assert_eq!(final_frame["status"], "succeeded");
    bridge
        .stop_until(std::time::Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(client
        .call("archive_session", serde_json::json!({"session_id":id}))
        .unwrap_err()
        .contains("pending notifications"));
    let receipt = &allocated.session.history.get(&id).unwrap().agent.inbox[0];
    allocated
        .session
        .history
        .agent_delivery(&id, &receipt.id, receipt.revision, "accepted", None)
        .unwrap();
    crate::read_agent_receipt(
        app.handle().clone(),
        app.state(),
        id.clone(),
        receipt.id.clone(),
        receipt.revision,
    )
    .unwrap();
    allocated
        .session
        .history
        .acknowledge_notification(&id, "succeeded")
        .unwrap();
    client
        .call("archive_session", serde_json::json!({"session_id":id}))
        .unwrap();
    assert!(!allocated
        .session
        .history
        .list()
        .unwrap()
        .iter()
        .any(|record| record.summary.session_id == id));
    assert!(serde_json::to_string(
        &allocated
            .session
            .history
            .archive_page(Default::default())
            .unwrap()
    )
    .unwrap()
    .contains(&id));
    crate::restore_archive(app.handle().clone(), app.state(), id.clone()).unwrap();
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"restore":{"text":String::from_utf8(expected.to_vec()).unwrap()}}),
    );
    let reopened = closure_t01_start(
        &fixture,
        &app,
        Some(id.clone()),
        None,
        |slave, _| {
            spawns.set(spawns.get() + 1);
            slave
                .spawn_command(
                    crate::ordinary_shell_command(&shell, || panic!("explicit owned shell"))
                        .unwrap(),
                )
                .map_err(|e| e.to_string())
        },
        |_, _, _, _, _| panic!("stored shell has no hook probe"),
        &started,
    )
    .unwrap();
    assert_eq!(reopened.reopened_from, Some(id.clone()));
    assert_ne!(reopened.summary.session_id, id);
    let (continuation, reader) = started.borrow_mut().pop().unwrap();
    let record = continuation
        .session
        .history
        .get(&continuation.id())
        .unwrap();
    assert_eq!(record.conversation_id, Some(id.clone()));
    assert_eq!(record.output_end_offset, expected.len() as u64);
    assert_eq!(
        std::fs::read(continuation.session.history.log_path(&continuation.id())).unwrap(),
        expected
    );
    let workers = crate::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        continuation.session.clone(),
        reader,
        |_, _, _| {},
    );
    client
        .call(
            "write_session",
            serde_json::json!({"session_id":continuation.id(),"data":"reopened\nfinish\n"}),
        )
        .unwrap();
    crate::tests::closure_t02_wait_workers(workers);
    assert_eq!(spawns.get(), 2);
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert_eq!(
        allocated
            .session
            .history
            .get(&id)
            .unwrap()
            .agent
            .inbox
            .len(),
        1
    );
    assert_eq!(
        allocated
            .session
            .history
            .get(&id)
            .unwrap()
            .output_end_offset,
        expected.len() as u64
    );
    drop(server);
}

#[test]
fn closure_t03_wire_routes_history_terminal_and_cli_through_actual_business_functions() {
    use tauri::Manager;
    let mut fixture = crate::tests::Rust85Session::new("read line; sleep 30");
    let instance = fixture.parser();
    let app = fixture.app();
    let handle = app.handle().clone();
    let root = fixture.root.join("wire");
    let server = Server::start(&root, move |request| {
        dispatch_with(
            request,
            || handle.state(),
            |manager, request| {
                dispatch_session_read(&handle, manager, &request)
                    .unwrap_or_else(|| Err("unexpected native route".into()))
            },
            |_| panic!("this fixture never sends shutdown"),
        )
    })
    .unwrap();
    let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
    let id = fixture.id();
    let record = client
        .call("get_session", serde_json::json!({"session_id":id}))
        .unwrap();
    assert_eq!(record["summary"]["session_id"], id);
    assert_eq!(
        client
            .call("list_sessions", serde_json::json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        client
            .call("cli_show", serde_json::json!({"session_id":id}))
            .unwrap()["session_id"],
        id
    );
    let frame = client
        .call("read_terminal_frame", serde_json::json!({"session_id":id}))
        .unwrap();
    assert_eq!(frame["projection"]["session"], id);
    assert_eq!(frame["projection"]["instance"], instance);
    let snapshot = client
        .call(
            "read_session_snapshot",
            serde_json::json!({"session_id":id}),
        )
        .unwrap();
    assert_eq!(snapshot["status"], "running");
    assert_eq!(snapshot["end_offset"], 0);
    for command in ["get_session", "read_terminal_frame", "cli_show"] {
        assert!(matches!(
            client.call_outcome(command, serde_json::json!({"session_id":"s-missing"})),
            CallOutcome::Completed(Err(_))
        ));
    }
    drop(server);
}

#[test]
fn closure_t03_lost_write_reply_is_unknown_and_foreign_lease_prevents_a_second_effect() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("while IFS= read -r file && IFS= read -r line; do printf '%s\\n' \"$line\" >> \"$file\"; done");
    let marker = fixture.root.join("received.txt");
    let app = fixture.app();
    let handle = app.handle().clone();
    let root = fixture.root.join("wire");
    let server = Server::start(&root, move |request| {
        dispatch_with(
            request,
            || handle.state(),
            |_, _| Err("unexpected native route".into()),
            |_| panic!("this fixture never sends shutdown"),
        )
    })
    .unwrap();
    let descriptor = Descriptor::read(&root).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut proxy = descriptor.clone();
    proxy.address = listener.local_addr().unwrap().to_string();
    let client = Client::new(proxy).unwrap();
    let worker = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let (mut incoming, _) = loop {
            match listener.accept() {
                Ok(stream) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "owned proxy timed out"
                    );
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("owned proxy: {error}"),
            }
        };
        let bytes =
            read_frame_with_budget(&mut incoming, MAX_REQUEST, Duration::from_secs(2)).unwrap();
        let mut outgoing = TcpStream::connect_timeout(
            &descriptor.address.parse().unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        outgoing
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write_frame(&mut outgoing, &bytes, MAX_REQUEST).unwrap();
        let reply =
            read_frame_with_budget(&mut outgoing, MAX_RESPONSE, Duration::from_secs(2)).unwrap();
        assert!(serde_json::from_slice::<Response>(&reply)
            .unwrap()
            .result
            .is_ok());
        // The write reached the owner; deliberately lose only its successful receipt.
    });
    let data = format!("{}\nfirst\n", marker.display());
    assert!(matches!(
        client.call_outcome(
            "write_session",
            serde_json::json!({"session_id":fixture.id(),"data":data})
        ),
        CallOutcome::Unknown(_)
    ));
    worker.join().unwrap();
    let other = Client::new(Descriptor::read(&root).unwrap()).unwrap();
    assert_ne!(other.identity, client.identity);
    let args = serde_json::json!({"session_id":fixture.id(),"data":format!("{}\nsecond\n",marker.display())});
    assert!(
        matches!(other.call_outcome("write_session", args.clone()), CallOutcome::Completed(Err(error)) if error.contains("controls"))
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::fs::read(&marker).ok().as_deref() != Some(b"first\n") {
        assert!(
            std::time::Instant::now() < deadline,
            "owned shell did not receive the write"
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(std::fs::read(&marker).unwrap(), b"first\n");
    other
        .call(
            "take_terminal_control",
            serde_json::json!({"session_id":fixture.id()}),
        )
        .unwrap();
    other.call("write_session", args).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::fs::read(&marker).unwrap() != b"first\nsecond\n" {
        assert!(
            std::time::Instant::now() < deadline,
            "explicit takeover did not reach the owned shell"
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        app.state::<crate::SessionManager>()
            .input_leases
            .lock()
            .unwrap()
            .owners[&fixture.id()]
            .0,
        other.identity
    );
    drop(server);
}

#[test]
fn closure_t03_wire_rejects_bad_identity_frames_and_shutdown_before_business_effects() {
    use tauri::Manager;
    let app = tauri::test::mock_app();
    app.manage(crate::SessionManager::default());
    let root = std::env::temp_dir().join(format!("yam-closure-wire-{}", crate::next_session_id()));
    let handle = app.handle().clone();
    let calls = Arc::new(AtomicU64::new(0));
    let observed = calls.clone();
    let server = Server::start(&root, move |request| {
        observed.fetch_add(1, Ordering::Relaxed);
        dispatch_with(
            request,
            || handle.state(),
            |_, _| panic!("invalid request reached a native route"),
            |_| panic!("invalid request shut down"),
        )
    })
    .unwrap();
    let descriptor = Descriptor::read(&root).unwrap();
    app.state::<crate::SessionManager>()
        .last_request
        .store(u64::MAX, Ordering::Release);
    for field in ["token", "instance", "client"] {
        let mut request = serde_json::json!({"version":PROTOCOL_VERSION,"token":descriptor.token,"instance":descriptor.instance,"client":"c".repeat(64),"id":1,"command":"background_status","args":{}});
        request[field] = if field == "client" {
            serde_json::json!("bad")
        } else {
            serde_json::json!("f".repeat(64))
        };
        let mut stream = TcpStream::connect(&descriptor.address).unwrap();
        write_frame(
            &mut stream,
            &serde_json::to_vec(&request).unwrap(),
            MAX_REQUEST,
        )
        .unwrap();
        assert!(read_frame_with_budget(&mut stream, MAX_RESPONSE, Duration::from_secs(1)).is_err());
    }
    for bytes in [
        ((MAX_REQUEST + 1) as u32).to_be_bytes().to_vec(),
        [100u32.to_be_bytes().as_slice(), b"{}"].concat(),
    ] {
        let mut stream = TcpStream::connect(&descriptor.address).unwrap();
        stream.write_all(&bytes).unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(read_frame_with_budget(&mut stream, MAX_RESPONSE, Duration::from_secs(1)).is_err());
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let client = Client::new(descriptor).unwrap();
    assert!(matches!(
        client.call_outcome("unknown_command", serde_json::json!({})),
        CallOutcome::Completed(Err(_))
    ));
    assert_eq!(
        app.state::<crate::SessionManager>()
            .last_request
            .load(Ordering::Acquire),
        u64::MAX
    );
    app.state::<crate::SessionManager>()
        .shutting_down
        .store(true, Ordering::Release);
    assert!(
        matches!(client.call_outcome("background_status", serde_json::json!({})), CallOutcome::Completed(Err(error)) if error.contains("shutting down"))
    );
    assert_eq!(
        app.state::<crate::SessionManager>()
            .last_request
            .load(Ordering::Acquire),
        u64::MAX
    );
    let _serial = crate::git_context::f3_serial_query_test();
    client
        .call(
            "cancel_git_changes",
            serde_json::json!({"query_token":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}),
        )
        .unwrap();
    assert_eq!(
        app.state::<crate::SessionManager>()
            .last_request
            .load(Ordering::Acquire),
        u64::MAX
    );
    drop(server);
    let unavailable = client.call_outcome("background_status", serde_json::json!({}));
    assert!(matches!(unavailable, CallOutcome::NotDispatched(_)));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn closure_t03_reconnect_keeps_original_client_cursor_owner_and_foreign_lease() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("sleep 30");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let handle = app.handle().clone();
    let root = fixture.root.join("wire");
    let polls = Arc::new(AtomicU64::new(0));
    let observed = polls.clone();
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed_requests = requests.clone();
    let server = Server::start(&root, move |request| {
        if request.command == "poll_events" {
            observed_requests.lock().unwrap().push((
                request.client.clone(),
                request.args["cursor"].as_u64().unwrap(),
            ));
            if observed.fetch_add(1, Ordering::Relaxed) < 2 {
                return Err("owned transient poll refusal".into());
            }
        }
        dispatch_with(
            request,
            || handle.state(),
            |manager, request| {
                dispatch_session_read(&handle, manager, &request)
                    .unwrap_or_else(|| Err("unexpected native route".into()))
            },
            |_| panic!("this fixture never sends shutdown"),
        )
    })
    .unwrap();
    let client = Arc::new(Client::new(Descriptor::read(&root).unwrap()).unwrap());
    let client_manager = crate::SessionManager::default();
    *client_manager.background_client.lock().unwrap() = Some(client.clone());
    manager
        .relay
        .lock()
        .unwrap()
        .push("owned-event", "{}".into());
    manager
        .input_leases
        .lock()
        .unwrap()
        .take_control("own", &client.identity, u64::MAX);
    manager
        .input_leases
        .lock()
        .unwrap()
        .take_control("foreign", &"d".repeat(64), 0);
    let replacement_calls = Arc::new(AtomicU64::new(0));
    let replacement_observed = replacement_calls.clone();
    let replacement_root = fixture.root.join("replacement");
    let replacement = Server::start(&replacement_root, move |_| {
        replacement_observed.fetch_add(1, Ordering::Relaxed);
        Err("a replacement owner must never be contacted".into())
    })
    .unwrap();
    Descriptor::read(&replacement_root)
        .unwrap()
        .publish(&root)
        .unwrap();
    let starts = std::cell::Cell::new(0);
    reconnect_existing(&client_manager, |received| {
        starts.set(starts.get() + 1);
        assert!(Arc::ptr_eq(&received, &client));
        let (page, retried) = poll_events_with_reconnect(&received, 0, true)?;
        assert!(retried);
        assert_eq!(page.cursor, 1);
        assert!(!page.gap);
        assert_eq!(page.events.len(), 1);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        *requests.lock().unwrap(),
        vec![(client.identity.clone(), 0); 3]
    );
    assert_ne!(
        manager.input_leases.lock().unwrap().owners["own"].1,
        u64::MAX
    );
    assert_eq!(manager.input_leases.lock().unwrap().owners["foreign"].1, 0);
    let (gap, retried) = poll_events_with_reconnect(&client, 99, false).unwrap();
    assert!(gap.gap && !retried);
    assert_eq!(gap.cursor, 1);
    client_manager.shutting_down.store(true, Ordering::Release);
    assert!(
        reconnect_existing(&client_manager, |_| panic!("shutdown cannot start polling")).is_err()
    );
    client_manager.shutting_down.store(false, Ordering::Release);
    drop(server);
    assert!(reconnect_existing(&client_manager, |_| panic!(
        "missing original owner cannot start polling"
    ))
    .is_err());
    assert!(poll_events_with_reconnect(&client, 1, false).is_err());
    assert_eq!(starts.get(), 1);
    assert_eq!(replacement_calls.load(Ordering::Relaxed), 0);
    assert!(Arc::ptr_eq(
        client_manager
            .background_client
            .lock()
            .unwrap()
            .as_ref()
            .unwrap(),
        &client
    ));
    assert_eq!(manager.input_leases.lock().unwrap().owners["foreign"].1, 0);
    assert_eq!(
        requests.lock().unwrap().last().unwrap(),
        &(client.identity.clone(), 99)
    );
    drop(replacement);
}

fn rust85_request(command: &str, args: serde_json::Value, client: char) -> Request {
    Request {
        version: PROTOCOL_VERSION,
        token: "a".repeat(64),
        instance: "b".repeat(64),
        client: client.to_string().repeat(64),
        id: 1,
        command: command.into(),
        args,
    }
}

fn rust85_dispatch(
    app: &tauri::App<tauri::test::MockRuntime>,
    command: &str,
    args: serde_json::Value,
    client: char,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    dispatch_with(
        rust85_request(command, args, client),
        || app.state(),
        |_, _| Err("unexpected native command".into()),
        |manager| manager.shutdown_for(app.handle(), |_, _, _| {}),
    )
}

#[test]
fn rust85_owner_admission_validates_before_state_and_preserves_git_cancel_bypass() {
    let _serial = crate::git_context::f3_serial_query_test();
    use tauri::Manager;
    let app = tauri::test::mock_app();
    let invalid = dispatch_with(
        rust85_request("background_status", serde_json::json!({"extra":true}), 'c'),
        || panic!("invalid input must not acquire state"),
        |_, _| panic!("invalid input must not dispatch"),
        |_| panic!("invalid input must not shut down"),
    );
    assert!(invalid.is_err());
    app.manage(crate::SessionManager::default());
    let manager = app.state::<crate::SessionManager>();
    manager.last_request.store(u64::MAX, Ordering::Release);
    manager.shutting_down.store(true, Ordering::Release);
    assert!(
        rust85_dispatch(&app, "background_status", serde_json::json!({}), 'c')
            .unwrap_err()
            .contains("shutting down")
    );
    assert_eq!(manager.last_request.load(Ordering::Acquire), u64::MAX);
    let cancelled = dispatch_with(
        rust85_request(
            "cancel_git_changes",
            serde_json::json!({"query_token":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}),
            'c',
        ),
        || panic!("Git cancellation must not acquire session state"),
        |_, _| panic!("Git cancellation must not fall through"),
        |_| panic!("Git cancellation must not shut down"),
    );
    assert!(cancelled.is_ok(), "{cancelled:?}");
    assert!(manager.input_leases.lock().unwrap().owners.is_empty());
    manager.shutting_down.store(false, Ordering::Release);
    let result = dispatch_with(
        rust85_request("get_history_policy", serde_json::json!({}), 'c'),
        || app.state(),
        |state, request| {
            assert!(state.sessions.try_lock().is_ok());
            assert!(state.input_leases.try_lock().is_ok());
            assert_eq!(request.command, "get_history_policy");
            Ok(serde_json::json!({"forwarded":true}))
        },
        |_| panic!("history policy must not shut down"),
    )
    .unwrap();
    assert_eq!(result["forwarded"], true);
    assert_ne!(manager.last_request.load(Ordering::Acquire), u64::MAX);
}

#[test]
fn rust85_owner_input_leases_block_foreign_writes_and_allow_explicit_takeover() {
    use tauri::Manager;
    let mut fixture = crate::tests::Rust85Session::new("read line; printf '%s' \"$line\"");
    let instance = fixture.parser();
    let app = fixture.app();
    let id = fixture.id();
    let write = serde_json::json!({"session_id":id,"data":""});
    assert!(rust85_dispatch(&app, "write_session", write.clone(), 'c').is_ok());
    assert!(rust85_dispatch(&app, "write_session", write.clone(), 'd').is_err());
    assert_eq!(
        rust85_dispatch(
            &app,
            "clear_terminal_display",
            serde_json::json!({"session_id":id,"expected_instance":instance}),
            'd'
        )
        .unwrap()["status"],
        "unavailable"
    );
    assert!(rust85_dispatch(
        &app,
        "take_terminal_control",
        serde_json::json!({"session_id":id}),
        'd'
    )
    .is_ok());
    assert!(rust85_dispatch(&app, "write_session", write, 'd').is_ok());
    assert!(rust85_dispatch(
        &app,
        "resize_session",
        serde_json::json!({"session_id":id,"cols":90,"rows":30}),
        'd'
    )
    .is_ok());
    assert!(rust85_dispatch(
        &app,
        "write_session",
        serde_json::json!({"session_id":"missing","data":"x"}),
        'd'
    )
    .unwrap_err()
    .contains("Unknown active"));
    *fixture.session.status.lock().unwrap() = "stopped".into();
    assert!(rust85_dispatch(
        &app,
        "take_terminal_control",
        serde_json::json!({"session_id":id}),
        'c'
    )
    .unwrap_err()
    .contains("ended"));
    let manager = app.state::<crate::SessionManager>();
    assert_eq!(
        manager.input_leases.lock().unwrap().owners[&id].0,
        "d".repeat(64)
    );
}

#[test]
fn external_stream_cut_and_authenticated_deltas_keep_offsets_ownership_and_final_tail() {
    use tauri::Manager;
    let mut fixture = crate::tests::Rust85Session::new("sleep 30");
    let instance = fixture.parser();
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    *manager.terminal_runtime.lock().unwrap() = Some(fixture.session.terminal.as_ref().unwrap().runtime.clone());
    let id = fixture.id();
    {
        let mut log = fixture.session.log.lock().unwrap();
        crate::append_log(&mut log.file, b"BEFORE", crate::MAX_SESSION_LOG_BYTES).unwrap();
        log.end_offset = 6;
    }
    let start = rust85_dispatch(&app, "open_terminal_stream", serde_json::json!({"session_id":id,"cols":80,"rows":24}), 'c').unwrap();
    assert_eq!(start["end_offset"], 6);
    assert_eq!(start["projection"]["instance"], instance);
    assert!(!manager.input_leases.lock().unwrap().headless_queries(&id, 0));
    let args = serde_json::json!({"session_id":id,"expected_instance":instance,"offset":6});
    assert_eq!(rust85_dispatch(&app, "read_terminal_delta", args.clone(), 'c').unwrap()["data"], "");
    assert!(rust85_dispatch(&app, "read_terminal_delta", args.clone(), 'd').is_err());
    let mut foreign = args.clone(); foreign["expected_instance"] = serde_json::json!("f".repeat(64));
    assert!(rust85_dispatch(&app, "read_terminal_delta", foreign, 'c').is_err());
    {
        let mut log = fixture.session.log.lock().unwrap();
        crate::append_log(&mut log.file, "中文 TAIL".as_bytes(), crate::MAX_SESSION_LOG_BYTES).unwrap();
        log.end_offset += "中文 TAIL".len() as u64;
    }
    let tail = rust85_dispatch(&app, "read_terminal_delta", args.clone(), 'c').unwrap();
    assert_eq!(tail["data"], "中文 TAIL");
    assert_eq!(tail["end_offset"], 17);
    rust85_dispatch(&app, "release_terminal_control", serde_json::json!({"session_id":id}), 'd').unwrap();
    assert!(!manager.input_leases.lock().unwrap().headless_queries(&id, 0));
    rust85_dispatch(&app, "take_terminal_control", serde_json::json!({"session_id":id}), 'd').unwrap();
    assert!(manager.input_leases.lock().unwrap().headless_queries(&id, 0));
    assert!(rust85_dispatch(&app, "read_terminal_delta", args.clone(), 'c').is_err());
    rust85_dispatch(&app, "open_terminal_stream", serde_json::json!({"session_id":id,"cols":80,"rows":24}), 'c').unwrap();
    fixture.session.history.update(&id, "succeeded", Some(0), None, Some(17)).unwrap();
    *fixture.session.status.lock().unwrap() = "succeeded".into();
    manager.sessions.lock().unwrap().remove(&id);
    let final_tail = rust85_dispatch(&app, "read_terminal_delta", args, 'c').unwrap();
    assert_eq!(final_tail["data"], "中文 TAIL");
    assert_eq!(final_tail["running"], false);
    assert_eq!(final_tail["more"], false);
    rust85_dispatch(&app, "release_terminal_control", serde_json::json!({"session_id":id}), 'c').unwrap();
    assert!(manager.input_leases.lock().unwrap().headless_queries(&id, 0));
}

#[test]
fn rust85_owner_terminal_commands_and_process_membership_use_only_owned_children() {
    use tauri::Manager;
    let mut fixture = crate::tests::Rust85Session::new("sleep 30");
    let instance = fixture.parser();
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let id = fixture.id();
    *manager.terminal_runtime.lock().unwrap() =
        Some(fixture.session.terminal.as_ref().unwrap().runtime.clone());
    let processes = rust85_dispatch(&app, "memory_processes", serde_json::json!({}), 'c').unwrap();
    assert_eq!(processes["pid"], std::process::id());
    assert_eq!(
        processes["workloads"],
        serde_json::json!([fixture.session.child.lock().unwrap().process_id().unwrap()])
    );
    assert!(processes["runtime_pid"].as_u64().unwrap() > 0);
    assert_eq!(
        rust85_dispatch(
            &app,
            "clear_terminal_display",
            serde_json::json!({"session_id":id,"expected_instance":instance}),
            'c'
        )
        .unwrap()["status"],
        "cleared"
    );
    assert_eq!(rust85_dispatch(&app, "navigate_reported_prompt", serde_json::json!({"session_id":id,"direction":"previous","expected_instance":instance}), 'c').unwrap()["status"], "moved");
    assert!(rust85_dispatch(
        &app,
        "set_terminal_viewport",
        serde_json::json!({"session_id":id,"line":0,"bottom":true}),
        'c'
    )
    .is_ok());
    assert!(rust85_dispatch(
        &app,
        "stop_session",
        serde_json::json!({"session_id":id}),
        'c'
    )
    .is_ok());
    *fixture.session.status.lock().unwrap() = "stopped".into();
    assert_eq!(
        rust85_dispatch(&app, "memory_processes", serde_json::json!({}), 'c').unwrap()["workloads"],
        serde_json::json!([])
    );
    *manager.terminal_runtime.lock().unwrap() = None;
    assert!(
        rust85_dispatch(&app, "memory_processes", serde_json::json!({}), 'c')
            .unwrap_err()
            .contains("runtime unavailable")
    );
}

#[test]
fn rust85_owner_poll_updates_only_client_heartbeat_and_reports_event_gaps() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("sleep 30");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    {
        let mut leases = manager.input_leases.lock().unwrap();
        leases.take_control("one", &"c".repeat(64), 0);
        leases.take_control("two", &"d".repeat(64), 0);
    }
    manager
        .relay
        .lock()
        .unwrap()
        .push("test-event", "{}".into());
    let page = rust85_dispatch(
        &app,
        "poll_events",
        serde_json::json!({"cursor":0,"foreground":true}),
        'c',
    )
    .unwrap();
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    assert!(manager.desktop_connected.load(Ordering::Acquire));
    assert!(manager.desktop_focus.lock().unwrap().1);
    assert_eq!(manager.input_leases.lock().unwrap().owners["two"].1, 0);
    assert!(
        rust85_dispatch(&app, "background_status", serde_json::json!({}), 'c').unwrap()
            ["desktop_connected"]
            .as_bool()
            .unwrap()
    );
    let gap = rust85_dispatch(&app, "poll_events", serde_json::json!({"cursor":99}), 'c').unwrap();
    assert_eq!(gap["gap"], true);
    assert!(gap["events"].as_array().unwrap().is_empty());
    assert!(!manager.desktop_focus.lock().unwrap().1);
}

#[test]
fn rust85_owner_local_commands_cover_status_cli_errors_cancellation_and_shutdown() {
    let _search_serial = RUST85_OWNER_SEARCH_TEST.lock().unwrap();
    use tauri::Manager;
    let app = tauri::test::mock_app();
    app.manage(crate::SessionManager::default());
    assert!(rust85_dispatch(&app, "get_system_entry_status", serde_json::json!({}), 'c').is_ok());
    assert_eq!(
        rust85_dispatch(
            &app,
            "get_notification_pause_state",
            serde_json::json!({}),
            'c'
        )
        .unwrap_err(),
        "system_entry_unavailable"
    );
    assert!(rust85_dispatch(&app, "cli_status", serde_json::json!({}), 'c').is_err());
    assert!(rust85_dispatch(&app, "cli_list", serde_json::json!({}), 'c').is_err());
    assert!(rust85_dispatch(
        &app,
        "cli_show",
        serde_json::json!({"session_id":"s-missing"}),
        'c'
    )
    .is_err());
    assert!(rust85_dispatch(
        &app,
        "cli_focus",
        serde_json::json!({"session_id":"s-missing"}),
        'c'
    )
    .is_err());
    assert!(rust85_dispatch(
        &app,
        "cli_stop",
        serde_json::json!({"session_id":"s-missing"}),
        'c'
    )
    .is_err());
    assert!(rust85_dispatch(&app, "cli_events", serde_json::json!({"cursor":0}), 'c').is_ok());
    assert!(rust85_dispatch(
        &app,
        "retry_agent_notifications",
        serde_json::json!({}),
        'c'
    )
    .unwrap_err()
    .contains("unavailable"));
    assert!(rust85_dispatch(&app, "cancel_log_search", serde_json::json!({}), 'c').is_ok());
    assert_eq!(
        rust85_dispatch(&app, "shutdown", serde_json::json!({}), 'c').unwrap(),
        serde_json::Value::Null
    );
    assert!(app
        .state::<crate::SessionManager>()
        .shutting_down
        .load(Ordering::Acquire));
}

#[test]
fn rust85_owner_history_commands_preserve_policy_paging_and_notification_fences() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let handle = app.handle().clone();
    let id = fixture.id();
    assert_eq!(
        crate::get_history_policy(handle.clone(), manager.clone()).unwrap()["auto_delete"],
        false
    );
    crate::set_history_policy(handle.clone(), manager.clone(), true).unwrap();
    assert_eq!(
        crate::get_history_policy(handle.clone(), manager.clone()).unwrap()["auto_archive_30_days"],
        true
    );
    assert_eq!(
        crate::list_session_summaries(handle.clone(), manager.clone(), Default::default())
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        crate::history_overview(handle.clone(), manager.clone())
            .unwrap()
            .total,
        1
    );
    assert!(
        crate::list_unread_receipts(handle.clone(), manager.clone(), Default::default())
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        crate::next_attention(handle.clone(), manager.clone(), None).unwrap(),
        None
    );
    assert!(crate::list_pending_notifications(handle.clone(), manager.clone(), 10, None).is_ok());
    assert!(crate::read_agent_receipt(
        handle.clone(),
        manager.clone(),
        id.clone(),
        "missing".into(),
        1
    )
    .is_err());
    fixture
        .session
        .history
        .update(&id, "succeeded", Some(0), None, Some(0))
        .unwrap();
    crate::acknowledge_notification(handle.clone(), manager.clone(), id.clone(), "failed".into())
        .unwrap();
    assert!(
        fixture
            .session
            .history
            .get(&id)
            .unwrap()
            .notification_pending
    );
    crate::acknowledge_notification(
        handle.clone(),
        manager.clone(),
        id.clone(),
        "succeeded".into(),
    )
    .unwrap();
    assert!(
        !fixture
            .session
            .history
            .get(&id)
            .unwrap()
            .notification_pending
    );
    assert!(crate::archive_session(handle.clone(), manager.clone(), id.clone()).is_err());
    manager.sessions.lock().unwrap().remove(&id);
    crate::archive_session(handle.clone(), manager.clone(), id.clone()).unwrap();
    assert_eq!(
        crate::list_archived_sessions(handle.clone(), manager.clone(), Default::default())
            .unwrap()
            .items
            .len(),
        1
    );
    let preview =
        crate::preview_archive_deletion(handle.clone(), manager.clone(), vec![id.clone()]).unwrap();
    let preview_id = preview["preview_id"].as_str().unwrap().to_owned();
    crate::cancel_archive_deletion_preview(handle.clone(), manager.clone(), preview_id.clone())
        .unwrap();
    assert!(crate::confirm_archive_deletion(handle.clone(), manager.clone(), preview_id).is_err());
    crate::restore_archive(handle.clone(), manager.clone(), id.clone()).unwrap();
    assert_eq!(
        crate::list_session_summaries(handle.clone(), manager.clone(), Default::default())
            .unwrap()
            .items
            .len(),
        1
    );
    crate::archive_session(handle.clone(), manager.clone(), id.clone()).unwrap();
    let preview =
        crate::preview_archive_deletion(handle.clone(), manager.clone(), vec![id.clone()]).unwrap();
    let deleted = crate::confirm_archive_deletion(
        handle,
        manager,
        preview["preview_id"].as_str().unwrap().into(),
    )
    .unwrap();
    assert!(deleted.complete);
    assert_eq!(deleted.deleted_ids, vec![id]);
}

#[test]
fn rust85_owner_log_commands_read_owned_files_and_reject_unknown_sessions() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let handle = app.handle().clone();
    let id = fixture.id();
    std::fs::write(fixture.session.history.log_path(&id), "hello coverage\n").unwrap();
    assert_eq!(
        crate::read_session_log(handle.clone(), manager.clone(), id.clone()).unwrap(),
        "hello coverage\n"
    );
    assert!(crate::read_session_log(handle.clone(), manager.clone(), "missing".into()).is_err());
    let excerpt = tauri::async_runtime::block_on(crate::read_log_excerpt(
        handle.clone(),
        manager.clone(),
        id,
        0,
        0,
    ))
    .unwrap();
    assert!(excerpt.contains("hello coverage"));
}

#[test]
fn rust85_owner_pause_wrappers_enforce_owner_revision_and_status_reads_are_bounded() {
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    assert!(crate::get_notification_pause_state(manager.clone()).is_err());
    let owner = "b".repeat(64);
    manager
        .system_entry
        .lock()
        .unwrap()
        .initialize(&owner, true, true, || Ok(()))
        .unwrap();
    let paused =
        crate::initialize_notification_pause(manager.clone(), true, owner.clone()).unwrap();
    assert!(paused.paused && paused.established);
    assert_eq!(
        crate::get_notification_pause_state(manager.clone()).unwrap(),
        paused
    );
    assert!(crate::set_notification_paused(
        manager.clone(),
        false,
        paused.revision,
        "c".repeat(64)
    )
    .is_err());
    let resumed =
        crate::set_notification_paused(manager.clone(), false, paused.revision, owner).unwrap();
    assert!(!resumed.paused);
    assert!(resumed.revision > paused.revision);
    assert!(crate::set_notification_paused(
        manager.clone(),
        true,
        paused.revision,
        resumed.owner_instance
    )
    .is_err());
    let status = crate::get_system_entry_status(manager.clone()).unwrap();
    assert_eq!(status["running"], 1);
    assert_eq!(status["unread"], 0);
    {
        let _busy = manager.sessions.lock().unwrap();
        assert!(crate::get_system_entry_status(manager.clone()).unwrap()["running"].is_null());
    }
    {
        let _busy = fixture.session.history.records.lock().unwrap();
        assert!(crate::get_system_entry_status(manager.clone()).unwrap()["unread"].is_null());
    }
    fixture
        .session
        .history
        .archive_pending
        .store(true, Ordering::Release);
    assert!(crate::get_system_entry_status(manager.clone()).unwrap()["unread"].is_null());
    fixture
        .session
        .history
        .archive_pending
        .store(false, Ordering::Release);
    assert!(crate::take_terminal_control(manager, fixture.id())
        .unwrap_err()
        .contains("background owner"));
}

#[test]
fn rust85_owner_search_command_reads_live_and_retained_logs_and_fences_invalid_cursors() {
    use tauri::Manager;
    let _search_serial = RUST85_OWNER_SEARCH_TEST.lock().unwrap();
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let id = fixture.id();
    let text = "hello coverage\nhello again\n";
    std::fs::write(fixture.session.history.log_path(&id), text).unwrap();
    let request = |cursor| crate::session_logs::SearchRequest {
        query: "hello".into(),
        case_sensitive: false,
        skip: 0,
        limit: 1,
        source_cursor: cursor,
    };
    let page = tauri::async_runtime::block_on(crate::search_session_logs(
        app.handle().clone(),
        manager.clone(),
        Some(id.clone()),
        request(None),
    ))
    .unwrap();
    assert_eq!(page.hits.len(), 1);
    assert!(page.has_more);
    assert!(page.current_cursor.is_some());
    let invalid = Some(crate::session_logs::SearchCursor {
        source_offset: 0,
        snapshot: Some("stale".into()),
    });
    assert!(tauri::async_runtime::block_on(crate::search_session_logs(
        app.handle().clone(),
        manager.clone(),
        Some(id.clone()),
        request(invalid)
    ))
    .unwrap_err()
    .contains("cursor expired"));
    assert!(tauri::async_runtime::block_on(crate::search_session_logs(
        app.handle().clone(),
        manager.clone(),
        Some("missing".into()),
        request(None)
    ))
    .is_err());
    manager.sessions.lock().unwrap().remove(&id);
    fixture
        .session
        .history
        .update(&id, "succeeded", Some(0), None, Some(text.len() as u64))
        .unwrap();
    let snapshot =
        crate::read_session_snapshot(app.handle().clone(), manager.clone(), id.clone()).unwrap();
    assert_eq!(snapshot.data, text);
    assert_eq!(snapshot.status, "succeeded");
    let page = tauri::async_runtime::block_on(crate::search_session_logs(
        app.handle().clone(),
        manager.clone(),
        None,
        request(None),
    ))
    .unwrap();
    assert_eq!(page.hits.len(), 1);
    assert!(page.current_cursor.is_some());
    tauri::async_runtime::block_on(crate::cancel_log_search(manager)).unwrap();
}

#[test]
fn rust85_owner_git_wrappers_fail_without_client_and_query_only_a_private_non_repository() {
    let _serial = crate::git_context::f3_serial_query_test();
    use tauri::Manager;
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    assert!(tauri::async_runtime::block_on(crate::get_git_changes(
        manager.clone(),
        fixture.root.to_string_lossy().into(),
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
        None,
        None
    ))
    .is_err());
    assert!(tauri::async_runtime::block_on(crate::cancel_git_changes(
        manager.clone(),
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into()
    ))
    .is_err());
    let context = tauri::async_runtime::block_on(crate::get_git_context(
        manager,
        fixture.root.to_string_lossy().into(),
    ))
    .unwrap();
    assert!(serde_json::to_value(context).unwrap()["root"].is_null());
}

#[test]
fn rust85_owner_history_proxy_propagates_authenticated_failure_without_local_mutation() {
    use tauri::Manager;
    let _search_serial = RUST85_OWNER_SEARCH_TEST.lock().unwrap();
    let fixture = crate::tests::Rust85Session::new("exit 0");
    let app = fixture.app();
    let manager = app.state::<crate::SessionManager>();
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = requests.clone();
    let root = fixture.root.join("private-owner");
    let _server = Server::start(&root, move |request| {
        observed
            .lock()
            .unwrap()
            .push((request.command, request.args));
        Err("owned-proxy-refusal".into())
    })
    .unwrap();
    *manager.background_client.lock().unwrap() = Some(std::sync::Arc::new(
        Client::new(Descriptor::read(&root).unwrap()).unwrap(),
    ));
    let handle = app.handle().clone();
    let id = fixture.id();
    let preview = "a".repeat(64);
    assert_eq!(
        crate::get_history_policy(handle.clone(), manager.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::set_history_policy(handle.clone(), manager.clone(), true)
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::archive_session(handle.clone(), manager.clone(), id.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::restore_archive(handle.clone(), manager.clone(), id.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::preview_archive_deletion(handle.clone(), manager.clone(), vec![id.clone()])
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::cancel_archive_deletion_preview(handle.clone(), manager.clone(), preview.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::confirm_archive_deletion(handle.clone(), manager.clone(), preview)
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::list_archived_sessions(handle.clone(), manager.clone(), Default::default())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::list_session_summaries(handle.clone(), manager.clone(), Default::default())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::history_overview(handle.clone(), manager.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::list_unread_receipts(handle.clone(), manager.clone(), Default::default())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::next_attention(handle.clone(), manager.clone(), Some(id.clone()))
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::list_pending_notifications(handle.clone(), manager.clone(), 10, None)
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::read_agent_receipt(
            handle.clone(),
            manager.clone(),
            id.clone(),
            "receipt".into(),
            1
        )
        .err()
        .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::acknowledge_notification(
            handle.clone(),
            manager.clone(),
            id.clone(),
            "succeeded".into()
        )
        .err()
        .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::read_session_log(handle.clone(), manager.clone(), id.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        tauri::async_runtime::block_on(crate::read_log_excerpt(
            handle,
            manager.clone(),
            id.clone(),
            0,
            0
        ))
        .err()
        .as_deref(),
        Some("owned-proxy-refusal")
    );
    assert_eq!(
        crate::retry_agent_notifications(manager.clone())
            .err()
            .as_deref(),
        Some("owned-proxy-refusal")
    );
    let recorded = requests.lock().unwrap();
    assert_eq!(recorded.len(), 18);
    assert_eq!(
        recorded[1],
        (
            "set_history_policy".into(),
            serde_json::json!({"auto_archive_30_days":true})
        )
    );
    assert_eq!(
        recorded[2],
        (
            "archive_session".into(),
            serde_json::json!({"session_id":id})
        )
    );
    assert_eq!(fixture.session.history.list().unwrap().len(), 1);
    assert_eq!(
        fixture.session.history.retention_policy().unwrap()["auto_archive_30_days"],
        false
    );
    assert!(manager.sessions.lock().unwrap().contains_key(&fixture.id()));
}
