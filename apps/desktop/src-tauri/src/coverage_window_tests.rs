// Author: Jeff.Liu. MockRuntime windows exercise the production command and ownership paths.

fn closure_t04_arguments() -> Result<serde_json::Value, String> {
    crate::create_session_arguments(
        &None, &None, &None, &None, &None, &None, &None, &None, &None, &None, &None, &None,
    )
}

#[test]
fn closure_t04_local_creation_refusal_releases_only_its_window_reservation() {
    let fixture = Rust85Windows::new();
    let before = fixture.manager().desktop_windows.lock().unwrap().capacity();
    let ticket = reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).unwrap();
    let calls = std::cell::Cell::new(0);
    let result = create_session_with(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        ticket,
        None,
        None,
        false,
        closure_t04_arguments(),
        || {
            calls.set(calls.get() + 1);
            Err("owned deterministic allocation refusal".into())
        },
    );
    assert!(result
        .err()
        .unwrap()
        .contains("owned deterministic allocation refusal"));
    assert_eq!(calls.get(), 1);
    let manager = fixture.manager();
    let table = manager.desktop_windows.lock().unwrap();
    assert_eq!(
        table.capacity(),
        before,
        "local refusal leaked its window reservation"
    );
    assert!(!table.starts.contains_key(&ticket));
    assert!(table.unknown_starts.is_empty());
    assert_eq!(table.owner(&fixture.session.id()), Some(Slot::Main));
    drop(table);
    assert!(reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).is_ok());
}

#[test]
fn closure_t04_create_route_keeps_admission_before_argument_error_and_local_side_effects() {
    let fixture = Rust85Windows::new();
    let ticket = reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).unwrap();
    assert!(
        create_session_with(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            0,
            ticket,
            None,
            None,
            false,
            Err("owned invalid arguments".into()),
            || panic!("stale epoch cannot allocate"),
        )
        .err()
        .unwrap()
            != "owned invalid arguments"
    );
    assert!(fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .starts
        .contains_key(&ticket));
    assert_eq!(
        create_session_with(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            ticket,
            None,
            None,
            false,
            Err("owned invalid arguments".into()),
            || panic!("invalid arguments cannot allocate"),
        )
        .err()
        .unwrap(),
        "owned invalid arguments"
    );
    assert!(!fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .starts
        .contains_key(&ticket));
}

#[test]
fn closure_t04_actual_client_outcomes_commit_refuse_or_fence_window_start_without_respawn() {
    use crate::background::{Client, Descriptor};
    use std::io::{Read, Write};
    for outcome in [
        "success",
        "refusal",
        "invalid_reply",
        "unknown",
        "not_dispatched",
    ] {
        let fixture = Rust85Windows::new();
        let before = fixture.manager().desktop_windows.lock().unwrap().capacity();
        let ticket =
            reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).unwrap();
        let second =
            reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).unwrap();
        let id = crate::next_session_id();
        let mut summary = fixture.session.session.summary.clone();
        summary.session_id = id.clone();
        let success = serde_json::to_value(crate::CreateSessionReply {
            summary,
            reopened_from: None,
            directory_reporting_warning: None,
            command_reporting_warning: None,
        })
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let client = std::sync::Arc::new(
            Client::new(Descriptor {
                version: 2,
                address,
                instance: "a".repeat(64),
                token: "b".repeat(64),
            })
            .unwrap(),
        );
        *fixture.manager().background_client.lock().unwrap() = Some(client);
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            let attempts = match outcome {
                "unknown" => 2,
                "not_dispatched" => 0,
                _ => 1,
            };
            if attempts == 0 {
                drop(listener);
                return requests;
            }
            for _ in 0..attempts {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(stream) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "owned start listener timed out"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                        Err(error) => panic!("owned start listener: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut length = [0; 4];
                stream.read_exact(&mut length).unwrap();
                let length = u32::from_be_bytes(length) as usize;
                assert!(length <= 2 * 1024 * 1024);
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).unwrap();
                let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["command"], "create_session");
                if outcome != "unknown" {
                    let result: Result<serde_json::Value, String> = match outcome {
                        "success" => Ok(success.clone()),
                        "refusal" => Err("owned remote allocation refusal".into()),
                        _ => Ok(serde_json::json!({"invalid":true})),
                    };
                    let reply=serde_json::to_vec(&serde_json::json!({"version":2,"instance":request["instance"],"client":request["client"],"id":request["id"],"result":result})).unwrap();
                    stream
                        .write_all(&(reply.len() as u32).to_be_bytes())
                        .unwrap();
                    stream.write_all(&reply).unwrap();
                }
                requests.push(request);
            }
            requests
        });
        if outcome == "not_dispatched" {
            while !worker.is_finished() {
                std::thread::yield_now();
            }
        }
        let result = create_session_with(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            ticket,
            None,
            None,
            false,
            closure_t04_arguments(),
            || panic!("a remote start must never allocate locally"),
        );
        let requests = worker.join().unwrap();
        let manager = fixture.manager();
        let table = manager.desktop_windows.lock().unwrap();
        match outcome {
            "success" => {
                assert_eq!(result.unwrap().summary.session_id, id);
                assert!(!table.starts.contains_key(&ticket));
                assert_eq!(table.owner(&id), Some(Slot::Main));
                assert_eq!(table.capacity(), before + 2);
            }
            "unknown" | "invalid_reply" => {
                assert_eq!(result.err().unwrap(), "terminal_start_outcome_unknown");
                assert!(
                    table.starts.contains_key(&ticket) && table.unknown_starts.contains(&ticket)
                );
                assert_eq!(table.capacity(), before + 2);
                drop(table);
                assert_eq!(
                    create_session_with(
                        fixture.app.handle().clone(),
                        fixture.main.clone(),
                        fixture.manager(),
                        1,
                        second,
                        None,
                        None,
                        false,
                        closure_t04_arguments(),
                        || panic!("unknown allocation cannot respawn"),
                    )
                    .err()
                    .unwrap(),
                    "terminal_start_outcome_unknown"
                );
                assert!(!fixture
                    .manager()
                    .desktop_windows
                    .lock()
                    .unwrap()
                    .starts
                    .contains_key(&second));
                assert!(
                    reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None)
                        .is_err()
                );
                if outcome == "unknown" {
                    assert_eq!(requests.len(), 2);
                    for key in ["client", "id", "args"] {
                        assert_eq!(requests[0][key], requests[1][key]);
                    }
                }
                continue;
            }
            _ => {
                assert!(result.is_err());
                assert!(!table.starts.contains_key(&ticket));
                assert!(table.unknown_starts.is_empty());
                assert_eq!(table.capacity(), before + 1);
            }
        }
        assert!(table.starts.contains_key(&second));
    }
}

fn closure_t04_move(fixture: &Rust85Windows) -> MoveReceipt {
    fixture.frame();
    let before = fixture.manager().desktop_windows.lock().unwrap().capacity();
    let MoveReply::Pending { receipt } = tauri::async_runtime::block_on(prepare_terminal_move(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
        serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
    ))
    .unwrap() else {
        panic!("expected a move receipt")
    };
    assert_eq!(receipt.session_id, fixture.session.id());
    assert_eq!(receipt.source_epoch, 1);
    assert_eq!(receipt.source_generation, fixture.generation);
    let Some(MoveReply::Pending { receipt: released }) = release_terminal_view(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
        Some(receipt.token),
    )
    .unwrap() else {
        panic!("expected source release acknowledgement")
    };
    assert_eq!(released.token, receipt.token);
    assert_eq!(released.session_id, receipt.session_id);
    assert_ne!(released.target_generation, fixture.generation);
    let epoch = fixture.secondary_epoch();
    for _ in 0..2 {
        let MoveReply::Pending { receipt: accepted } = accept_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            epoch,
            receipt.token,
        ) else {
            panic!("lost acceptance acknowledgement must be replayable")
        };
        assert_eq!(accepted.target_generation, released.target_generation);
        assert_eq!(accepted.session_id, receipt.session_id);
    }
    let MoveReply::Completed { receipt: completed } = complete_terminal_move(
        fixture.secondary.clone(),
        fixture.manager(),
        epoch,
        receipt.token,
    ) else {
        panic!("expected completed move")
    };
    assert_eq!(completed.token, receipt.token);
    assert_eq!(completed.session_id, receipt.session_id);
    assert_eq!(completed.source_generation, fixture.generation);
    assert_eq!(completed.target_generation, released.target_generation);
    assert_eq!(
        fixture.manager().desktop_windows.lock().unwrap().capacity(),
        before
    );
    completed
}

#[test]
fn closure_t04_notification_context_follows_current_owner_epoch_and_focused_window_after_move() {
    let fixture = Rust85Windows::new();
    fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .focus("main", true);
    let sent = std::cell::RefCell::new(Vec::new());
    set_agent_notification_context_with(
        fixture.main.clone(),
        fixture.manager(),
        1,
        Some(fixture.session.id()),
        |selected| {
            sent.borrow_mut().push(selected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(*sent.borrow(), [Some(fixture.session.id())]);
    let receipt = closure_t04_move(&fixture);
    let before = sent.borrow().len();
    assert!(set_agent_notification_context_with(
        fixture.main.clone(),
        fixture.manager(),
        1,
        Some(fixture.session.id()),
        |_| panic!("old owner cannot publish notification context")
    )
    .is_err());
    assert!(set_agent_notification_context_with(
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch + 1,
        Some(fixture.session.id()),
        |_| panic!("stale epoch cannot publish notification context")
    )
    .is_err());
    assert_eq!(sent.borrow().len(), before);
    set_agent_notification_context_with(
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch,
        Some(fixture.session.id()),
        |selected| {
            sent.borrow_mut().push(selected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        sent.borrow().last(),
        Some(&None),
        "the focused source no longer owns its stale selection"
    );
    secondary_window_event(
        &fixture.manager(),
        receipt.target_epoch,
        &tauri::WindowEvent::Focused(true),
    );
    set_agent_notification_context_with(
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch,
        Some(fixture.session.id()),
        |selected| {
            sent.borrow_mut().push(selected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(sent.borrow().last(), Some(&Some(fixture.session.id())));
}

#[test]
fn closure_t04_target_generation_reads_resizes_and_fences_all_old_source_tickets() {
    let fixture = Rust85Windows::new();
    let receipt = closure_t04_move(&fixture);
    let frame = read_terminal_frame(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch,
        receipt.target_generation,
        fixture.session.id(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(frame.projection["session"], fixture.session.id());
    assert_eq!(frame.projection["instance"], fixture.instance);
    let snapshot = read_session_snapshot(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch,
        receipt.target_generation,
        fixture.session.id(),
    )
    .unwrap();
    assert_eq!(snapshot.status, "running");
    resize_session(
        fixture.secondary.clone(),
        fixture.manager(),
        receipt.target_epoch,
        receipt.target_generation,
        fixture.session.id(),
        90,
        30,
    )
    .unwrap();
    assert!(write_session(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        "blocked".into()
    )
    .is_err());
    let before = fixture.session.requests();
    assert!(resize_session(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        91,
        31
    )
    .is_err());
    assert_eq!(fixture.session.requests(), before);
    let manager = fixture.manager();
    let table = manager.desktop_windows.lock().unwrap();
    let claim = &table.claims[&fixture.session.id()];
    assert_eq!(claim.inflight, 0);
    assert!(!claim.unknown && !claim.parser_uncertain);
    assert_eq!(claim.slot, Slot::Secondary);
}

#[test]
fn closure_t04_actual_local_parser_error_retains_owner_and_failed_parser_fence() {
    let fixture = Rust85Windows::new();
    fixture.frame();
    fixture.session.configure(
        serde_json::json!({}),
        serde_json::json!({"snapshot":"error"}),
    );
    assert!(read_terminal_frame(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id()
    )
    .is_err());
    {
        let manager = fixture.manager();
        let table = manager.desktop_windows.lock().unwrap();
        let claim = &table.claims[&fixture.session.id()];
        assert!(
            !claim.unknown,
            "a completed local error is not an unknown transport outcome"
        );
        assert!(
            claim.parser_uncertain,
            "a failed parser call cannot authorize moving its view"
        );
        assert_eq!(claim.inflight, 0);
        assert_eq!(table.owner(&fixture.session.id()), Some(Slot::Main));
    }
    assert!(matches!(
        tauri::async_runtime::block_on(prepare_terminal_move(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.session.id(),
            fixture.generation,
            serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
        ))
        .unwrap(),
        MoveReply::Unavailable
    ));
    assert!(
        read_terminal_frame(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.generation,
            fixture.session.id()
        )
        .is_err(),
        "failed parser must stay unavailable until affected tasks stop"
    );
}

#[test]
fn closure_t04_known_local_pty_error_recovers_only_with_the_original_parser_frame() {
    for changed_instance in [false, true] {
        let fixture = Rust85Windows::new();
        fixture.frame();
        let master = fixture.session.session.master.lock().unwrap().take();
        let result = resize_session(
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.generation,
            fixture.session.id(),
            90,
            30,
        );
        *fixture.session.session.master.lock().unwrap() = master;
        assert!(result.err().unwrap().contains("PTY is closed"));
        {
            let manager = fixture.manager();
            let table = manager.desktop_windows.lock().unwrap();
            let claim = &table.claims[&fixture.session.id()];
            assert!(!claim.unknown && claim.parser_uncertain);
            assert_eq!(claim.inflight, 0);
        }
        if changed_instance {
            fixture.session.configure(
                serde_json::json!({"instance":"f".repeat(64)}),
                serde_json::json!({}),
            );
            let _ = read_terminal_frame(
                fixture.app.handle().clone(),
                fixture.main.clone(),
                fixture.manager(),
                1,
                fixture.generation,
                fixture.session.id(),
            );
            assert!(
                fixture.manager().desktop_windows.lock().unwrap().claims[&fixture.session.id()]
                    .parser_uncertain,
                "a different parser instance cannot clear the failed operation's uncertainty"
            );
            assert!(matches!(
                tauri::async_runtime::block_on(prepare_terminal_move(
                    fixture.app.handle().clone(),
                    fixture.main.clone(),
                    fixture.manager(),
                    1,
                    fixture.session.id(),
                    fixture.generation,
                    serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
                ))
                .unwrap(),
                MoveReply::Unavailable
            ));
        } else {
            fixture.frame();
            closure_t04_move(&fixture);
        }
    }
}

#[test]
fn closure_t04_unknown_ipc_frame_cannot_be_cleared_by_a_later_local_success() {
    use crate::background::{Client, Descriptor};
    use std::io::Read;
    let fixture = Rust85Windows::new();
    fixture.frame();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let client = Client::new(Descriptor {
        version: 2,
        address: listener.local_addr().unwrap().to_string(),
        instance: "a".repeat(64),
        token: "b".repeat(64),
    })
    .unwrap();
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(stream) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "owned read listener timed out"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("owned listener: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let length = u32::from_be_bytes(length) as usize;
        assert!(length <= 2 * 1024 * 1024);
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).unwrap();
        let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request["command"], "read_terminal_frame");
        // The authenticated request arrived; the peer disappears without a receipt.
    });
    *fixture.manager().background_client.lock().unwrap() = Some(std::sync::Arc::new(client));
    assert!(read_terminal_frame(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id()
    )
    .is_err());
    worker.join().unwrap();
    fixture.manager().background_client.lock().unwrap().take();
    fixture.frame();
    {
        let manager = fixture.manager();
        let table = manager.desktop_windows.lock().unwrap();
        assert!(table.claims[&fixture.session.id()].unknown);
        assert_eq!(table.claims[&fixture.session.id()].inflight, 0);
        assert_eq!(table.owner(&fixture.session.id()), Some(Slot::Main));
    }
    assert!(matches!(
        tauri::async_runtime::block_on(prepare_terminal_move(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.session.id(),
            fixture.generation,
            serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
        ))
        .unwrap(),
        MoveReply::Unavailable
    ));
}

#[test]
fn closure_t04_notification_context_coalesces_reentry_and_can_retry_a_failed_sender() {
    let fixture = Rust85Windows::new();
    fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .focus("main", true);
    let sent = std::cell::RefCell::new(Vec::new());
    set_agent_notification_context_with(
        fixture.main.clone(),
        fixture.manager(),
        1,
        Some(fixture.session.id()),
        |selected| {
            if sent.borrow().is_empty() {
                set_agent_notification_context_with(
                    fixture.main.clone(),
                    fixture.manager(),
                    1,
                    None,
                    |_| panic!("a reentrant context must be coalesced by the in-flight sender"),
                )?;
            }
            sent.borrow_mut().push(selected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(*sent.borrow(), [Some(fixture.session.id()), None]);
    assert!(
        !fixture
            .manager()
            .desktop_windows
            .lock()
            .unwrap()
            .context_sending
    );
    assert_eq!(
        set_agent_notification_context_with(
            fixture.main.clone(),
            fixture.manager(),
            1,
            Some(fixture.session.id()),
            |_| Err("owned sender refusal".into())
        )
        .unwrap_err(),
        "owned sender refusal"
    );
    assert!(
        !fixture
            .manager()
            .desktop_windows
            .lock()
            .unwrap()
            .context_sending
    );
    set_agent_notification_context_with(
        fixture.main.clone(),
        fixture.manager(),
        1,
        Some(fixture.session.id()),
        |selected| {
            sent.borrow_mut().push(selected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(sent.borrow().last(), Some(&Some(fixture.session.id())));
}

#[test]
fn closure_t04_target_creation_failure_keeps_source_claim_and_does_not_reserve_a_move() {
    let fixture = Rust85Windows::new();
    fixture.frame();
    let appearance = serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"});
    let calls = std::cell::Cell::new(0);
    let before = fixture.manager().desktop_windows.lock().unwrap().capacity();
    let reply = tauri::async_runtime::block_on(prepare_terminal_move_with(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
        appearance.clone(),
        |target| {
            calls.set(calls.get() + 1);
            assert_eq!(target, Slot::Secondary);
            std::future::ready(Err("owned target window refusal".into()))
        },
    ))
    .unwrap();
    assert!(matches!(reply, MoveReply::Unavailable));
    assert_eq!(calls.get(), 1);
    {
        let manager = fixture.manager();
        let table = manager.desktop_windows.lock().unwrap();
        assert_eq!(table.capacity(), before);
        assert!(table.moves.iter().all(Option::is_none));
        let claim = &table.claims[&fixture.session.id()];
        assert_eq!(claim.generation, fixture.generation);
        assert_eq!(claim.slot, Slot::Main);
        assert!(!claim.closed && !claim.unknown && !claim.parser_uncertain);
    }
    assert!(matches!(
        tauri::async_runtime::block_on(prepare_terminal_move_with(
            fixture.main.clone(),
            fixture.manager(),
            0,
            fixture.session.id(),
            fixture.generation,
            appearance,
            |_| -> std::future::Ready<Result<(), String>> {
                panic!("stale source must not try to create a target")
            },
        ))
        .unwrap(),
        MoveReply::Unavailable
    ));
    closure_t04_move(&fixture);
}

struct Rust85Windows {
    app: tauri::App<tauri::test::MockRuntime>,
    main: tauri::Webview<tauri::test::MockRuntime>,
    secondary: tauri::Webview<tauri::test::MockRuntime>,
    session: crate::tests::Rust85Session,
    instance: String,
    generation: u64,
}

impl Rust85Windows {
    fn new() -> Self {
        let mut session = crate::tests::Rust85Session::new("exit 0");
        session.session.child.lock().unwrap().wait().unwrap();
        let instance = session.parser();
        let app = session.app();
        let main_window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let main: tauri::Webview<tauri::test::MockRuntime> = main_window.as_ref().clone();
        let context = desktop_window_bootstrap(
            app.handle().clone(),
            main.clone(),
            app.state(),
            vec![session.id()],
            vec![],
            1,
        )
        .unwrap();
        assert_eq!(context.owned_ids, vec![session.id()]);
        let generation = claim_terminal_view(
            app.handle().clone(),
            main.clone(),
            app.state(),
            1,
            session.id(),
        )
        .unwrap()
        .unwrap();
        create_secondary(app.handle()).unwrap();
        let secondary = app.get_webview("terminal-secondary").unwrap();
        Self {
            app,
            main,
            secondary,
            session,
            instance,
            generation,
        }
    }

    fn manager(&self) -> tauri::State<'_, SessionManager> {
        self.app.state()
    }
    fn secondary_epoch(&self) -> u64 {
        self.manager().desktop_windows.lock().unwrap().slots[1].epoch
    }
    fn frame(&self) -> TerminalFrame {
        read_terminal_frame(
            self.app.handle().clone(),
            self.main.clone(),
            self.manager(),
            1,
            self.generation,
            self.session.id(),
        )
        .unwrap()
        .unwrap()
    }
}

#[test]
fn rust85_window_bootstrap_checks_epoch_identity_limits_and_existing_history() {
    let fixture = Rust85Windows::new();
    assert_eq!(trusted_slot(&fixture.main).unwrap(), Slot::Main);
    assert_eq!(trusted_slot(&fixture.secondary).unwrap(), Slot::Secondary);
    *fixture.manager().desktop_windows.lock().unwrap() = Table::default();
    let context = desktop_window_bootstrap(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        vec![fixture.session.id(), "s-gone".into()],
        vec![],
        1,
    )
    .unwrap();
    assert_eq!(context.owned_ids, vec![fixture.session.id()]);
    assert!(!context.restore_blocked);
    assert!(desktop_window_bootstrap(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        vec![],
        vec![],
        0
    )
    .is_err());
    *fixture.manager().desktop_windows.lock().unwrap() = Table::default();
    assert!(desktop_window_bootstrap(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        vec!["../invalid".into()],
        vec![],
        1
    )
    .is_err());
    let too_many = (0..17).map(|i| format!("s-{i}")).collect();
    assert!(desktop_window_bootstrap(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        too_many,
        vec![],
        1
    )
    .is_err());
    let guest = tauri::WebviewWindowBuilder::new(
        &fixture.app,
        "guest",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .build()
    .unwrap();
    let guest: &tauri::Webview<tauri::test::MockRuntime> = guest.as_ref();
    assert!(trusted_slot(guest).is_err());
    assert!(reserve_terminal_start(guest.clone(), fixture.manager(), 1, None).is_err());
}

#[test]
fn rust85_window_claim_release_and_reservation_keep_one_owner_and_generation() {
    let fixture = Rust85Windows::new();
    assert_eq!(
        claim_terminal_view(
            fixture.app.handle().clone(),
            fixture.secondary.clone(),
            fixture.manager(),
            fixture.secondary_epoch(),
            fixture.session.id()
        )
        .unwrap(),
        None
    );
    assert_eq!(
        fixture.manager().desktop_windows.lock().unwrap().slots[0]
            .requested
            .as_deref(),
        Some(fixture.session.id().as_str())
    );
    let reservation =
        reserve_terminal_start(fixture.main.clone(), fixture.manager(), 1, None).unwrap();
    assert!(fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .starts
        .contains_key(&reservation));
    assert!(reserve_terminal_start(fixture.main.clone(), fixture.manager(), 0, None).is_err());
    assert!(release_terminal_view(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation + 1,
        None
    )
    .is_err());
    assert!(release_terminal_view(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
        None
    )
    .unwrap()
    .is_none());
    let next = claim_terminal_view(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
    )
    .unwrap()
    .unwrap();
    assert_ne!(next, fixture.generation);
    assert!(fixture
        .manager()
        .desktop_windows
        .lock()
        .unwrap()
        .begin(Slot::Main, 1, &fixture.session.id(), fixture.generation)
        .is_err());
    assert!(claim_terminal_view(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        "s-missing".into()
    )
    .is_err());
}

#[test]
fn rust85_window_move_commands_ack_accept_complete_and_fence_old_generations() {
    let fixture = Rust85Windows::new();
    fixture.frame();
    let reply = tauri::async_runtime::block_on(prepare_terminal_move(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
        serde_json::json!({"fontFamily":"Menlo","fontSize":16,"theme":"system"}),
    ))
    .unwrap();
    let MoveReply::Pending { receipt } = reply else {
        panic!("expected pending move")
    };
    assert!(matches!(
        query_terminal_move(
            fixture.main.clone(),
            fixture.manager(),
            1,
            Some(fixture.session.id())
        ),
        MoveReply::Pending { .. }
    ));
    assert!(matches!(
        release_terminal_view(
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.session.id(),
            fixture.generation,
            Some(receipt.token)
        )
        .unwrap(),
        Some(MoveReply::Pending { .. })
    ));
    let epoch = fixture.secondary_epoch();
    assert!(matches!(
        accept_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            epoch,
            receipt.token
        ),
        MoveReply::Pending { .. }
    ));
    assert!(matches!(
        complete_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            epoch,
            receipt.token
        ),
        MoveReply::Completed { .. }
    ));
    assert!(matches!(
        complete_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            epoch,
            receipt.token
        ),
        MoveReply::Completed { .. }
    ));
    assert!(write_session(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        "blocked".into()
    )
    .is_err());
    assert_eq!(
        fixture
            .manager()
            .desktop_windows
            .lock()
            .unwrap()
            .owner(&fixture.session.id()),
        Some(Slot::Secondary)
    );
    assert!(matches!(
        query_terminal_move(fixture.main.clone(), fixture.manager(), 0, None),
        MoveReply::Unavailable
    ));
    assert!(matches!(
        accept_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            epoch,
            u64::MAX
        ),
        MoveReply::Stale
    ));
}

#[test]
fn rust85_window_reconcile_and_recovery_keep_native_fences() {
    let fixture = Rust85Windows::new();
    fixture.frame();
    let MoveReply::Resume { generation, .. } = reconcile_terminal_move(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id(),
        fixture.generation,
    ) else {
        panic!("expected generation fence")
    };
    assert_ne!(generation, fixture.generation);
    assert!(matches!(
        tauri::async_runtime::block_on(recover_terminal_move(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            999
        ))
        .unwrap(),
        MoveReply::Stale
    ));
    assert!(matches!(
        tauri::async_runtime::block_on(recover_terminal_move(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            0,
            999
        ))
        .unwrap(),
        MoveReply::Unavailable
    ));
    assert!(matches!(
        query_terminal_move(
            fixture.secondary.clone(),
            fixture.manager(),
            fixture.secondary_epoch(),
            None
        ),
        MoveReply::Stale
    ));
}

#[test]
fn rust85_window_terminal_wrappers_use_ticket_and_real_state_commands() {
    let fixture = Rust85Windows::new();
    let frame = fixture.frame();
    assert_eq!(frame.projection["session"], fixture.session.id());
    assert!(!frame.persisted);
    resize_session(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        98,
        32,
    )
    .unwrap();
    set_terminal_viewport(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        4,
        Some(true),
    )
    .unwrap();
    assert_eq!(
        clear_terminal_display(
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.generation,
            fixture.session.id(),
            fixture.instance.clone()
        )
        .unwrap()
        .status,
        crate::ClearDisplayStatus::Unavailable
    );
    assert_eq!(
        navigate_reported_prompt(
            fixture.main.clone(),
            fixture.manager(),
            1,
            fixture.generation,
            fixture.session.id(),
            "previous".into(),
            fixture.instance.clone()
        )
        .unwrap()
        .status,
        crate::shell_command_report::NavigationStatus::Moved
    );
    assert!(resize_session(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        0,
        24
    )
    .is_err());
    assert!(clear_terminal_display(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
        "bad".into()
    )
    .is_err());
    assert!(write_session(
        fixture.main.clone(),
        fixture.manager(),
        0,
        fixture.generation,
        fixture.session.id(),
        "x".into()
    )
    .is_err());
    let snapshot = read_session_snapshot(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id(),
    )
    .unwrap();
    assert_eq!(snapshot.status, "running");
    assert_eq!(snapshot.end_offset, 0);
    {
        let manager = fixture.manager();
        let table = manager.desktop_windows.lock().unwrap();
        let claim = &table.claims[&fixture.session.id()];
        assert_eq!(claim.inflight, 0);
        assert!(!claim.unknown);
        assert_eq!(
            claim.parser_instance.as_deref(),
            Some(fixture.instance.as_str())
        );
    }
    assert!(take_terminal_control(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.generation,
        fixture.session.id()
    )
    .is_err());
}

#[test]
fn rust85_window_preferences_settings_and_zoom_validate_scope_before_mutation() {
    let fixture = Rust85Windows::new();
    for key in ["other", "yam.window.secret"] {
        assert!(commit_window_preferences(
            fixture.app.handle().clone(),
            fixture.main.clone(),
            fixture.manager(),
            1,
            key.into(),
            Some("value".into()),
            None
        )
        .is_err());
    }
    assert!(commit_window_preferences(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        fixture.secondary_epoch(),
        "yam.terminalSettings".into(),
        None,
        None
    )
    .is_err());
    assert!(commit_window_preferences(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        0,
        "yam.terminalSettings".into(),
        None,
        None
    )
    .is_err());
    assert_eq!(
        fixture
            .manager()
            .desktop_windows
            .lock()
            .unwrap()
            .preference_revision,
        0
    );
    commit_window_preferences(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        "yam.terminalSettings".into(),
        Some("settings".into()),
        Some("apply".into()),
    )
    .unwrap();
    assert_eq!(
        fixture
            .manager()
            .desktop_windows
            .lock()
            .unwrap()
            .preference_revision,
        1
    );
    assert!(commit_window_preferences(
        fixture.app.handle().clone(),
        fixture.main.clone(),
        fixture.manager(),
        1,
        "yam.theme".into(),
        None,
        Some("apply".into())
    )
    .is_err());
    assert!(request_main_terminal_zoom(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        fixture.secondary_epoch(),
        "invalid".into()
    )
    .is_err());
    request_main_terminal_zoom(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        fixture.secondary_epoch(),
        "larger".into(),
    )
    .unwrap();
    open_main_settings(
        fixture.app.handle().clone(),
        fixture.secondary.clone(),
        fixture.manager(),
        fixture.secondary_epoch(),
        Some("updates".into()),
    )
    .unwrap();
    create_secondary(fixture.app.handle()).unwrap();
    show_slot(fixture.app.handle(), Slot::Main).unwrap();
    show_slot(fixture.app.handle(), Slot::Secondary).unwrap();
    page_ready(&fixture.main, tauri::webview::PageLoadEvent::Finished);
    page_ready(&fixture.main, tauri::webview::PageLoadEvent::Started);
    assert!(!terminal_input_focused(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id()
    )
    .unwrap());
    fixture.manager().desktop_windows.lock().unwrap().slots[0].selected =
        Some(fixture.session.id());
    crate::record_desktop_focus(&fixture.manager(), "main", true);
    assert!(terminal_input_focused(
        fixture.main.clone(),
        fixture.manager(),
        1,
        fixture.session.id()
    )
    .unwrap());
}

#[test]
fn rust85_window_events_keep_old_epoch_from_closing_a_new_window() {
    let fixture = Rust85Windows::new();
    let epoch = fixture.secondary_epoch();
    secondary_window_event(
        &fixture.manager(),
        epoch,
        &tauri::WindowEvent::Focused(true),
    );
    assert!(fixture
        .manager()
        .desktop_foreground
        .load(crate::Ordering::Acquire));
    secondary_window_event(
        &fixture.manager(),
        epoch,
        &tauri::WindowEvent::Focused(false),
    );
    assert!(!fixture
        .manager()
        .desktop_foreground
        .load(crate::Ordering::Acquire));
    fixture.manager().desktop_windows.lock().unwrap().slots[1].epoch = epoch + 1;
    secondary_window_event(&fixture.manager(), epoch, &tauri::WindowEvent::Destroyed);
    assert!(fixture.manager().desktop_windows.lock().unwrap().slots[1].alive);
    secondary_window_event(
        &fixture.manager(),
        epoch + 1,
        &tauri::WindowEvent::Destroyed,
    );
    assert!(!fixture.manager().desktop_windows.lock().unwrap().slots[1].alive);
}

#[test]
fn language_theme_locale_command_updates_only_current_trusted_main_epoch() {
    let fixture=Rust85Windows::new();
    set_notification_locale(fixture.main.clone(),fixture.manager(),1,"zh-CN".into()).unwrap();
    assert!(fixture.manager().system_entry.lock().unwrap().notification_chinese);
    assert!(set_notification_locale(fixture.secondary.clone(),fixture.manager(),fixture.secondary_epoch(),"en".into()).is_err());
    assert!(set_notification_locale(fixture.main.clone(),fixture.manager(),2,"en".into()).is_err());
    assert!(set_notification_locale(fixture.main.clone(),fixture.manager(),1,"de".into()).is_err());
    assert!(fixture.manager().system_entry.lock().unwrap().notification_chinese);
    set_notification_locale(fixture.main.clone(),fixture.manager(),1,"en".into()).unwrap();
    assert!(!fixture.manager().system_entry.lock().unwrap().notification_chinese);
}
