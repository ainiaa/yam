#[test]
fn closure_t02_partial_stop_and_rescan_failures_resume_only_confirmed_owned_targets() {
    for failure in ["stop", "rescan", "kill", "skipped"] {
        let scans = std::cell::Cell::new(0);
        let actions = std::cell::RefCell::new(Vec::new());
        let result = super::cleanup_session_members_with(
            || {
                let count = scans.get() + 1;
                scans.set(count);
                if failure == "rescan" && count == 2 {
                    Err("owned rescan refusal".into())
                } else {
                    Ok(vec![11, 12])
                }
            },
            |pid, signal| {
                actions.borrow_mut().push((pid, signal));
                if failure == "skipped" && pid == 11 {
                    return Ok(false);
                }
                if (matches!(failure, "stop" | "skipped") && pid == 12 && signal == libc::SIGSTOP)
                    || (failure == "kill" && pid == 12 && signal == libc::SIGKILL)
                {
                    return Err(format!("owned {failure} refusal"));
                }
                Ok(true)
            },
        );
        assert!(result.unwrap_err().contains(failure));
        let resumed: Vec<_> = actions
            .borrow()
            .iter()
            .filter(|(_, signal)| *signal == libc::SIGCONT)
            .map(|(pid, _)| *pid)
            .collect();
        let expected = match failure {
            "stop" => vec![11],
            "skipped" => vec![],
            _ => vec![11, 12],
        };
        assert_eq!(
            resumed, expected,
            "partial {failure} failure stranded an owned stopped process"
        );
    }
    let actions = std::cell::RefCell::new(Vec::new());
    super::cleanup_session_members_with(
        || Ok(vec![11, 12]),
        |pid, signal| {
            actions.borrow_mut().push((pid, signal));
            Ok(true)
        },
    )
    .unwrap();
    assert_eq!(
        *actions.borrow(),
        [
            (11, libc::SIGSTOP),
            (12, libc::SIGSTOP),
            (12, libc::SIGKILL),
            (11, libc::SIGKILL)
        ]
    );
}

#[test]
fn closure_t02_process_identity_and_exited_sid_policy_reject_foreign_targets() {
    let never =
        |_| -> Result<Option<u64>, String> { panic!("invalid identity must not query a process") };
    assert!(super::verified_session_root_with(None, 123, never).is_err());
    assert!(super::verified_session_root_with(Some((123, 17)), 124, never).is_err());
    assert!(super::verified_session_root_with(Some((0, 17)), 0, never).is_err());
    assert!(super::verified_session_root_with(Some((u32::MAX, 17)), u32::MAX, never).is_err());
    assert!(super::verified_session_root_with(Some((123, 17)), 123, |_| Ok(Some(18))).is_err());
    assert!(
        super::verified_session_root_with(Some((123, 17)), 123, |_| Err(
            "owned lookup unavailable".into()
        ))
        .is_err()
    );
    assert_eq!(
        super::verified_session_root_with(Some((123, 17)), 123, |_| Ok(Some(17))).unwrap(),
        123
    );
    assert_eq!(
        super::verified_session_root_with(Some((123, 17)), 123, |_| Ok(None)).unwrap(),
        123
    );
    let members = super::exited_session_targets(123, &[123, 200, 300, 400], |pid| match pid {
        200 => Some(123),
        300 => Some(999),
        _ => None,
    });
    assert_eq!(
        members,
        [200],
        "a stale root PID's children in another SID are not owned"
    );
}

#[test]
fn closure_t02_changed_reported_pid_never_signals_another_owned_session() {
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    let other = Rust85Session::new("sleep 30");
    let (session, _reader, root) = test_session("sleep 30");
    let mut session = std::sync::Arc::try_unwrap(session).ok().unwrap();
    let child = session.child.into_inner().unwrap();
    let reported_pid = std::sync::Arc::new(AtomicU32::new(
        other.session.child.lock().unwrap().process_id().unwrap(),
    ));
    session.exit_observation_fault = Some(std::sync::Arc::new(AtomicUsize::new(0)));
    session.child = std::sync::Mutex::new(Box::new(T02WaitFault {
        child,
        reported_pid: reported_pid.clone(),
    }));
    let fixture = Rust85Session {
        session: std::sync::Arc::new(session),
        root,
        parser: None,
    };
    let result = super::request_session_stop(&fixture.session);
    reported_pid.store(0, Ordering::Release);
    let other_running = other
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none();
    let own_running = fixture
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none();
    assert!(
        result.is_err(),
        "changed child PID must fail before any signal"
    );
    assert!(
        other_running && own_running,
        "identity mismatch affected a test-owned process"
    );
    assert!(!fixture.session.stop_requested.load(Ordering::Acquire));
}

#[test]
fn closure_t02_shutdown_waits_for_last_publication_before_completing() {
    use tauri::Manager;
    let (session, reader, root) = test_session("printf last-publication; exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let notifications = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = notifications.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, _| {
            observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            entered_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
        },
    );
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let handle = app.handle().clone();
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let shutdown = std::thread::spawn(move || {
        let result = handle
            .state::<super::SessionManager>()
            .shutdown_for(&handle, |_, _, _| {
                panic!("in-flight publication must not repeat")
            });
        result_tx.send(result).unwrap();
    });
    let early = result_rx.recv_timeout(std::time::Duration::from_millis(100));
    release_tx.send(()).unwrap();
    closure_t02_wait_workers(workers);
    let was_pending = matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout));
    match early {
        Ok(result) => result.unwrap(),
        Err(_) => result_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap(),
    };
    shutdown.join().unwrap();
    assert!(
        was_pending,
        "shutdown completed while last native publication was blocked"
    );
    assert_eq!(notifications.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert!(manager
        .shutdown_complete
        .load(std::sync::atomic::Ordering::Acquire));
}

#[test]
fn closure_t02_lock_failure_after_publication_retries_commit_without_republishing() {
    use tauri::Manager;
    let (session, reader, root) = test_session("exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let owned = fixture.session.clone();
    let notifications = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = notifications.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, _| {
            observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _held = owned.completed.0.lock().unwrap();
                panic!("owned completion poison during publication");
            }));
        },
    );
    closure_t02_wait_workers(workers);
    assert!(manager.sessions.lock().unwrap().contains_key(&fixture.id()));
    assert!(fixture.session.pending_finish.lock().unwrap().is_some());
    assert_eq!(notifications.load(std::sync::atomic::Ordering::Relaxed), 1);
    fixture.session.completed.0.clear_poison();
    manager
        .shutdown_for(app.handle(), |_, _, _| {
            panic!("published outcome cannot notify twice")
        })
        .unwrap();
    assert!(*fixture.session.completed.0.lock().unwrap());
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert_eq!(notifications.load(std::sync::atomic::Ordering::Relaxed), 1);
}

#[test]
fn closure_t02_exit_requests_claim_once_and_failed_cleanup_reopens_gate() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let manager = std::sync::Arc::new(super::SessionManager::default());
    let prevented = std::sync::Arc::new(AtomicUsize::new(0));
    let claimed = std::sync::Arc::new(AtomicUsize::new(0));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let manager = manager.clone();
            let prevented = prevented.clone();
            let claimed = claimed.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                if super::claim_session_exit(&manager, || {
                    prevented.fetch_add(1, Ordering::Relaxed);
                }) {
                    claimed.fetch_add(1, Ordering::Relaxed);
                }
            })
        })
        .collect();
    barrier.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(prevented.load(Ordering::Relaxed), 2);
    assert_eq!(claimed.load(Ordering::Relaxed), 1);
    let exited = std::cell::Cell::new(0);
    let errors = std::cell::RefCell::new(Vec::new());
    super::complete_session_exit(
        &manager,
        || Err("owned shutdown refusal".into()),
        || exited.set(exited.get() + 1),
        |error| errors.borrow_mut().push(error),
    );
    assert_eq!(exited.get(), 0);
    assert_eq!(*errors.borrow(), ["owned shutdown refusal"]);
    assert!(!manager.shutting_down.load(Ordering::Acquire));
    assert!(!manager.shutdown_complete.load(Ordering::Acquire));
    assert!(super::claim_session_exit(&manager, || {}));
    super::complete_session_exit(
        &manager,
        || manager.shutdown(),
        || exited.set(exited.get() + 1),
        |_| panic!("empty owned shutdown cannot fail"),
    );
    assert_eq!(exited.get(), 1);
    assert!(!super::claim_session_exit(&manager, || panic!(
        "completed cleanup cannot prevent exit again"
    )));
    for (owner, stopping, expected) in [
        (false, false, false),
        (false, true, false),
        (true, false, true),
        (true, true, false),
    ] {
        assert_eq!(super::keep_background_event_loop(owner, stopping), expected);
    }
}

#[derive(Debug)]
struct T02WaitFault {
    child: Box<dyn super::Child + Send + Sync>,
    reported_pid: std::sync::Arc<std::sync::atomic::AtomicU32>,
}
impl portable_pty::ChildKiller for T02WaitFault {
    fn kill(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        self.child.clone_killer()
    }
}
impl portable_pty::Child for T02WaitFault {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        self.child.try_wait()
    }
    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        self.child.wait()
    }
    fn process_id(&self) -> Option<u32> {
        let pid = self.reported_pid.load(std::sync::atomic::Ordering::Acquire);
        if pid == 0 {
            self.child.process_id()
        } else {
            Some(pid)
        }
    }
    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.child.as_raw_handle()
    }
}

#[test]
fn closure_t02_unconfirmed_cleanup_retains_owned_child_until_explicit_retry() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::Manager;
    let other = Rust85Session::new("sleep 30");
    let (session, reader, root) = test_session("printf owned-ready; sleep 30");
    let mut session = std::sync::Arc::try_unwrap(session).ok().unwrap();
    let child = session.child.into_inner().unwrap();
    let remaining = std::sync::Arc::new(AtomicUsize::new(usize::MAX));
    session.exit_observation_fault = Some(remaining.clone());
    session.child = std::sync::Mutex::new(Box::new(T02WaitFault {
        child,
        reported_pid: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
    }));
    let fixture = Rust85Session {
        session: std::sync::Arc::new(session),
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let (output, wait) = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, status| observed.lock().unwrap().push(status.to_owned()),
    );
    let end = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !wait.is_finished() {
        assert!(
            std::time::Instant::now() < end,
            "owned failed-cleanup waiter did not return"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let retained = manager.sessions.lock().unwrap().contains_key(&fixture.id());
    let completed = *fixture.session.completed.0.lock().unwrap();
    let notifications_before = notifications.lock().unwrap().clone();
    remaining.store(0, Ordering::Release);
    let child_was_alive = fixture
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none();
    super::terminate_session(&fixture.session).unwrap();
    closure_t02_wait_workers((output, wait));
    assert!(
        retained && !completed && child_was_alive,
        "unconfirmed live process cannot be completed/forgotten"
    );
    assert!(notifications_before.is_empty());
    manager
        .shutdown_for(app.handle(), |_, _, status| {
            notifications.lock().unwrap().push(status.to_owned())
        })
        .unwrap();
    assert_eq!(*notifications.lock().unwrap(), ["failed"]);
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(other
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
}

#[test]
fn closure_t02_poisoned_completion_locks_keep_pending_before_any_publication() {
    use tauri::Manager;
    for poison_active in [false, true] {
        let (session, reader, root) = test_session("exit 0");
        let fixture = Rust85Session {
            session,
            root,
            parser: None,
        };
        let app = fixture.app();
        let manager = app.state::<super::SessionManager>();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if poison_active {
                let _held = manager.sessions.lock().unwrap();
                panic!("owned active-map poison");
            } else {
                let _held = fixture.session.completed.0.lock().unwrap();
                panic!("owned completion poison");
            }
        }));
        let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = notifications.clone();
        let workers = super::spawn_session_threads_with(
            app.handle(),
            manager.sessions.clone(),
            fixture.session.clone(),
            reader,
            move |_, _, status| observed.lock().unwrap().push(status.to_owned()),
        );
        closure_t02_wait_workers(workers);
        assert!(fixture.session.pending_finish.lock().unwrap().is_some());
        assert!(notifications.lock().unwrap().is_empty());
        assert!(manager
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&fixture.id()));
        assert!(!*fixture
            .session
            .completed
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner()));
        // The fixture poisoned only an unchanged lock; restoring it models explicit repair.
        manager.sessions.clear_poison();
        fixture.session.completed.0.clear_poison();
        manager
            .shutdown_for(app.handle(), |_, _, status| {
                notifications.lock().unwrap().push(status.to_owned())
            })
            .unwrap();
        assert_eq!(*notifications.lock().unwrap(), ["succeeded"]);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[test]
fn closure_t02_poison_and_storage_failure_recover_through_existing_shutdown() {
    use tauri::Manager;
    let (session, reader, root) = test_session("exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = fixture.session.status.lock().unwrap();
        panic!("owned status poison before storage failure");
    }));
    std::fs::create_dir(fixture.root.join("sessions.json.tmp")).unwrap();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        |_, _, _| panic!("uncommitted state cannot notify"),
    );
    closure_t02_wait_workers(workers);
    assert!(fixture.session.pending_finish.lock().unwrap().is_some());
    assert!(!*fixture.session.completed.0.lock().unwrap());
    std::fs::remove_dir(fixture.root.join("sessions.json.tmp")).unwrap();
    let notifications = std::cell::RefCell::new(Vec::new());
    manager
        .shutdown_for(app.handle(), |_, _, status| {
            notifications.borrow_mut().push(status.to_owned())
        })
        .unwrap();
    assert_eq!(*notifications.borrow(), ["failed"]);
    assert!(!fixture.session.status.is_poisoned());
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn closure_t02_child_wait_error_reaps_real_owned_pid_and_preserves_other_fixture() {
    use tauri::Manager;
    let other = Rust85Session::new("sleep 30");
    let (session, reader, root) = test_session("printf owned-tail; sleep 30");
    let mut session = std::sync::Arc::try_unwrap(session).ok().unwrap();
    let child = session.child.into_inner().unwrap();
    let pid = child.process_id().unwrap();
    session.exit_observation_fault = Some(std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(1)));
    session.child = std::sync::Mutex::new(Box::new(T02WaitFault {
        child,
        reported_pid: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
    }));
    let fixture = Rust85Session {
        session: std::sync::Arc::new(session),
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let owned = fixture.session.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, status| {
            assert_eq!(status, "failed");
            assert!(*owned.output_done.0.lock().unwrap());
        },
    );
    closure_t02_join(&fixture.session, workers);
    assert!(fixture
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_some());
    assert_ne!(other.session.child.lock().unwrap().process_id(), Some(pid));
    assert!(other
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "failed");
    assert_eq!(record.exit_code, None);
    assert!(record.reason.unwrap().contains("owned child wait refusal"));
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn closure_t02_wait_error_after_root_exit_still_cleans_owned_background_job() {
    use std::io::BufRead;
    use tauri::Manager;
    let other = Rust85Session::new("sleep 30");
    let (session, reader, root) = test_session(
        "exec /bin/sh -c 'trap \"\" HUP; sleep 30 >/dev/null 2>&1 & echo YAM_PID:$!; exit 0'",
    );
    let mut reader = std::io::BufReader::new(reader);
    let pid: u32 = loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if let Some(pid) = line
            .trim()
            .strip_prefix("YAM_PID:")
            .and_then(|v| v.parse().ok())
        {
            break pid;
        }
    };
    let identity = super::memory::process_identity(pid).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while session.child.lock().unwrap().try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            super::terminate_session(&session).unwrap();
            super::cleanup_session_descendants(&session).unwrap();
            panic!("owned fixture shell did not exit before wait-fault injection");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let mut session = std::sync::Arc::try_unwrap(session).ok().unwrap();
    let child = session.child.into_inner().unwrap();
    session.exit_observation_fault = Some(std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(1)));
    session.child = std::sync::Mutex::new(Box::new(T02WaitFault {
        child,
        reported_pid: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
    }));
    let fixture = Rust85Session {
        session: std::sync::Arc::new(session),
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        Box::new(reader),
        |_, _, _| {},
    );
    closure_t02_join(&fixture.session, workers);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while super::memory::process_identity(pid) == Some(identity)
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let survived = super::memory::process_identity(pid) == Some(identity);
    super::cleanup_session_descendants(&fixture.session).unwrap();
    assert!(
        !survived,
        "wait error forgot the exited root's owned background job"
    );
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "failed");
    assert_eq!(record.exit_code, None);
    assert!(other
        .session
        .child
        .lock()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
}

#[test]
fn closure_t02_real_exit_preserves_failure_attention_and_stop_semantics() {
    use tauri::Manager;
    for (command,adapter,stop,expected) in [
        ("exit 7", None, false, "failed"),
        ("printf '%s' '{\"type\":\"turn.failed\"}'; exit 0",Some("codex"),false,"failed"),
        ("printf '%s' '{\"type\":\"result\",\"subtype\":\"success\",\"permission_denials\":[{}]}'; exit 0",Some("claude"),false,"needs_attention"),
        ("printf owned-ready; sleep 30",None,true,"stopped"),
    ] {
        let (session, reader, root)=test_session(command);
        let fixture=Rust85Session {session,root,parser:None};
        *fixture.session.protocol.lock().unwrap()=super::AgentProtocol::new(adapter);
        let app=fixture.app();
        let manager=app.state::<super::SessionManager>();
        let workers=super::spawn_session_threads_with(app.handle(),manager.sessions.clone(),fixture.session.clone(),reader,|_,_,_|{});
        if stop { super::request_session_stop(&fixture.session).unwrap(); super::request_session_stop(&fixture.session).unwrap(); }
        closure_t02_join(&fixture.session,workers);
        let record=fixture.session.history.get(&fixture.id()).unwrap();
        assert_eq!(record.status,expected,"{command}");
        if adapter.is_some() { assert_eq!(record.exit_code,Some(0)); }
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[test]
fn closure_t02_drain_timeout_keeps_active_until_reader_stops_and_shutdown_retries() {
    use tauri::Manager;
    struct HeldRead(std::sync::mpsc::Receiver<()>);
    impl std::io::Read for HeldRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            self.0
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            Ok(0)
        }
    }
    let (session, _reader, root) = test_session("printf owned; exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let (release, held) = std::sync::mpsc::channel();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let (output, wait) = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        Box::new(HeldRead(held)),
        move |_, _, status| observed.lock().unwrap().push(status.to_owned()),
    );
    let end = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while !wait.is_finished() {
        assert!(
            std::time::Instant::now() < end,
            "owned waiter did not reach the drain timeout"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let retained = manager.sessions.lock().unwrap().contains_key(&fixture.id());
    let completed = *fixture.session.completed.0.lock().unwrap();
    let notifications_before = notifications.lock().unwrap().clone();
    release.send(()).unwrap();
    closure_t02_wait_workers((output, wait));
    assert!(
        retained && !completed,
        "reader pending must retain active/incomplete state"
    );
    assert!(notifications_before.is_empty());
    assert!(*fixture.session.output_done.0.lock().unwrap());
    manager
        .shutdown_for(app.handle(), |_, _, status| {
            notifications.lock().unwrap().push(status.to_owned())
        })
        .unwrap();
    assert_eq!(*notifications.lock().unwrap(), ["failed"]);
    assert!(fixture
        .session
        .history
        .get(&fixture.id())
        .unwrap()
        .reason
        .unwrap()
        .contains("output did not close"));
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn closure_t02_real_workers_report_read_error_as_failure_after_owned_child_exit() {
    use tauri::Manager;
    struct Refused;
    impl std::io::Read for Refused {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("owned output read refusal"))
        }
    }
    let (session, _reader, root) = test_session("printf owned; exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        Box::new(Refused),
        |_, _, _| {},
    );
    closure_t02_join(&fixture.session, workers);
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "failed");
    assert!(record.reason.unwrap().contains("owned output read refusal"));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_exit_poll_keeps_unread_pty_output_until_drain() {
    use std::io::Read;
    let (session, mut reader, root) = test_session("printf frame-tail; exit 7");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if super::session_has_exited(&fixture.session).unwrap() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "child did not exit");
        std::thread::yield_now();
    }
    let mut output = Vec::new();
    reader.read_to_end(&mut output).unwrap();
    assert_eq!(
        output, b"frame-tail",
        "polling must not reap before PTY drain"
    );
    *fixture.session.output_done.0.lock().unwrap() = true;
    let status = loop {
        if let Some(status) = fixture.session.child.lock().unwrap().try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "drained child did not become waitable"
        );
        std::thread::yield_now();
    };
    assert_eq!(status.exit_code(), 7);
    assert!(super::session_has_exited(&fixture.session).unwrap());
    let pid = fixture.session.child.lock().unwrap().process_id().unwrap();
    let mut raw = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, &mut raw, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_exit_poll_preserves_signal_status_and_tail_output() {
    use std::io::Read;
    let (session, mut reader, root) = test_session("printf signal-tail; kill -TERM $$");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !super::session_has_exited(&fixture.session).unwrap() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    let mut output = Vec::new();
    reader.read_to_end(&mut output).unwrap();
    assert_eq!(output, b"signal-tail");
    *fixture.session.output_done.0.lock().unwrap() = true;
    let status = loop {
        if let Some(status) = fixture.session.child.lock().unwrap().try_wait().unwrap() {
            break status;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    };
    assert!(!status.success());
    assert_eq!(status.exit_code(), 1);
    assert!(status.signal().is_some());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_exit_poll_leaves_running_child_running() {
    let fixture = Rust85Session::new("sleep 30");
    assert!(!super::session_has_exited(&fixture.session).unwrap());
    assert!(!fixture
        .session
        .stop_requested
        .load(std::sync::atomic::Ordering::Acquire));
}

#[test]
fn closure_t02_frame_publication_failure_keeps_session_until_same_finalizer_recovers() {
    use tauri::Manager;
    let (session, reader, root) = test_session(r#"exec /bin/sh -c "printf frame-tail; exit 0""#);
    let mut fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    fixture.parser();
    std::fs::create_dir(fixture.root.join(format!("{}.frame.json", fixture.id()))).unwrap();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, status| observed.lock().unwrap().push(status.to_owned()),
    );
    closure_t02_wait_workers(workers);
    assert!(notifications.lock().unwrap().is_empty());
    assert!(!*fixture.session.completed.0.lock().unwrap());
    assert!(manager.sessions.lock().unwrap().contains_key(&fixture.id()));
    assert!(manager.shutdown().unwrap_err().contains("remains open"));
    assert_eq!(
        std::fs::read(fixture.session.history.log_path(&fixture.id())).unwrap(),
        b"frame-tail"
    );
    assert!(!std::fs::read_dir(&fixture.root).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".frame.tmp")));
    std::fs::remove_dir(fixture.root.join(format!("{}.frame.json", fixture.id()))).unwrap();
    manager
        .shutdown_for(app.handle(), |_, _, status| {
            notifications.lock().unwrap().push(status.to_owned())
        })
        .unwrap();
    assert_eq!(*notifications.lock().unwrap(), ["succeeded"]);
    assert!(*fixture.session.completed.0.lock().unwrap());
    assert!(manager.sessions.lock().unwrap().is_empty());
    let frame: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join(format!("{}.frame.json", fixture.id()))).unwrap(),
    )
    .unwrap();
    assert_eq!(frame["status"], "succeeded");
    manager
        .shutdown_for(app.handle(), |_, _, _| {
            panic!("completed session cannot notify twice")
        })
        .unwrap();
}

#[test]
fn closure_t02_failed_history_write_never_notifies_success_or_changes_previous_bytes() {
    use tauri::Manager;
    let (session, reader, root) = test_session("exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let before = std::fs::read(fixture.session.history.records_path()).unwrap();
    std::fs::create_dir(fixture.root.join("sessions.json.tmp")).unwrap();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |_, _, status| observed.lock().unwrap().push(status.to_owned()),
    );
    closure_t02_wait_workers(workers);
    assert!(notifications.lock().unwrap().is_empty());
    assert!(!*fixture.session.completed.0.lock().unwrap());
    assert!(manager.sessions.lock().unwrap().contains_key(&fixture.id()));
    assert!(manager.shutdown().unwrap_err().contains("remains open"));
    assert_eq!(
        std::fs::read(fixture.session.history.records_path()).unwrap(),
        before
    );
    assert_eq!(
        fixture.session.history.get(&fixture.id()).unwrap().status,
        "running"
    );
    std::fs::remove_dir(fixture.root.join("sessions.json.tmp")).unwrap();
    manager
        .shutdown_for(app.handle(), |_, _, status| {
            notifications.lock().unwrap().push(status.to_owned())
        })
        .unwrap();
    assert_eq!(*notifications.lock().unwrap(), ["succeeded"]);
    assert_eq!(
        fixture.session.history.get(&fixture.id()).unwrap().status,
        "succeeded"
    );
    assert!(*fixture.session.completed.0.lock().unwrap());
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn closure_t02_poisoned_status_does_not_panic_worker_or_leave_completion_pending() {
    use tauri::Manager;
    let (session, reader, root) = test_session("exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = fixture.session.status.lock().unwrap();
        panic!("owned status poison");
    }));
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        |_, _, status| assert_eq!(status, "failed"),
    );
    closure_t02_join(&fixture.session, workers);
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "failed");
    assert!(record.reason.unwrap().contains("status lock poisoned"));
    assert!(manager.sessions.lock().unwrap().is_empty());
}

fn closure_t02_join(
    session: &super::Session,
    workers: (std::thread::JoinHandle<()>, std::thread::JoinHandle<()>),
) {
    let finished = session.completed.0.lock().unwrap();
    let (finished, timeout) = session
        .completed
        .1
        .wait_timeout_while(finished, std::time::Duration::from_secs(5), |done| !*done)
        .unwrap();
    assert!(
        *finished && !timeout.timed_out(),
        "owned session did not complete"
    );
    drop(finished);
    closure_t02_wait_workers(workers);
}

pub(super) fn closure_t02_wait_workers(
    workers: (std::thread::JoinHandle<()>, std::thread::JoinHandle<()>),
) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !workers.0.is_finished() || !workers.1.is_finished() {
        assert!(
            std::time::Instant::now() < end,
            "owned workers did not stop"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    workers.0.join().unwrap();
    workers.1.join().unwrap();
}

#[test]
fn closure_t02_real_workers_drain_utf8_before_status_frame_removal_and_completion() {
    use tauri::Manager;
    let (session, reader, root) = test_session(r#"exec /bin/sh -c "printf 'tail-\317\200\342\202'; exit 0""#);
    let mut fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    fixture.parser();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let notifications = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    let owned = fixture.session.clone();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        move |app, id, status| {
            assert!(
                *owned.output_done.0.lock().unwrap(),
                "terminal state preceded the drain barrier"
            );
            assert!(
                !*owned.completed.0.lock().unwrap(),
                "completion preceded terminal publication"
            );
            assert!(app
                .state::<super::SessionManager>()
                .sessions
                .lock()
                .unwrap()
                .contains_key(id));
            observed.lock().unwrap().push(status.to_owned());
        },
    );
    closure_t02_join(&fixture.session, workers);
    assert_eq!(*notifications.lock().unwrap(), ["succeeded"]);
    assert!(manager.sessions.lock().unwrap().is_empty());
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "succeeded");
    assert_eq!(record.exit_code, Some(0));
    let bytes = std::fs::read(fixture.session.history.log_path(&fixture.id())).unwrap();
    assert_eq!(bytes, "tail-π�".as_bytes());
    assert_eq!(record.output_end_offset, bytes.len() as u64);
    let frame: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join(format!("{}.frame.json", fixture.id()))).unwrap(),
    )
    .unwrap();
    assert_eq!(frame["end_offset"], bytes.len() as u64);
    assert_eq!(frame["status"], "succeeded");
    let requests = fixture.requests();
    let rows = requests.as_array().unwrap();
    let last_snapshot = rows.iter().rposition(|r| r["op"] == "snapshot").unwrap();
    let writes: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r["op"] == "write")
        .collect();
    assert!(!writes.is_empty());
    assert!(writes.iter().all(|(index, _)| *index < last_snapshot));
}

#[test]
fn closure_t02_real_workers_never_report_success_after_log_persistence_failure() {
    use tauri::Manager;
    let (session, reader, root) = test_session("printf 'lost-tail'; exit 0");
    let fixture = Rust85Session {
        session,
        root,
        parser: None,
    };
    let path = fixture.session.history.log_path(&fixture.id());
    fixture.session.log.lock().unwrap().file = std::fs::File::open(path).unwrap();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    let workers = super::spawn_session_threads_with(
        app.handle(),
        manager.sessions.clone(),
        fixture.session.clone(),
        reader,
        |_, _, _| {},
    );
    closure_t02_join(&fixture.session, workers);
    let record = fixture.session.history.get(&fixture.id()).unwrap();
    assert_eq!(record.status, "failed");
    assert!(record.reason.unwrap().contains("persist terminal output"));
    assert!(fixture.session.log.lock().unwrap().error.is_some());
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn closure_t01_log_open_failure_stops_before_parser_history_and_spawn() {
    use std::os::unix::fs::PermissionsExt;
    use tauri::Manager;
    let _serial = super::worktree_manager::serial_owner_test();
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
    let result = super::create_session_with_effects(
        Some(app.handle().clone()),
        &manager,
        &fixture.root,
        Some(fixture.root.to_string_lossy().into_owned()),
        None,
        None,
        None,
        None,
        None,
        Some(shell),
        None,
        None,
        None,
        None,
        None,
        |_| panic!("ordinary shell cannot look up agent"),
        |size| {
            let pair = super::native_pty_system()
                .openpty(size)
                .map_err(|e| e.to_string())?;
            std::fs::set_permissions(&fixture.root, std::fs::Permissions::from_mode(0o500))
                .unwrap();
            Ok(pair)
        },
        |_, _| panic!("log failure cannot spawn"),
        |_, _, _, _, _| panic!("log failure cannot connect"),
        |_, _, _| panic!("log failure cannot notify"),
        |_, _, _, _| panic!("log failure cannot start workers"),
    );
    std::fs::set_permissions(&fixture.root, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.err().unwrap().contains("Failed to open session log"));
    assert!(fixture.requests().as_array().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
        before
    );
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(manager.resume_claims.lock().unwrap().is_empty());
}

#[test]
fn closure_t01_pending_log_preserves_new_hardlinked_path_and_committed_bytes() {
    use std::io::Write;
    let fixture = Rust85Session::new("exit 0");
    let history = fixture.session.history.clone();
    let id = super::next_session_id();
    let path = history.log_path(&id);
    {
        let mut log = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
        log.file().write_all(b"owned bytes").unwrap();
        std::fs::hard_link(&path, fixture.root.join("hardlink")).unwrap();
    }
    assert_eq!(std::fs::read(&path).unwrap(), b"owned bytes");
    let id = super::next_session_id();
    let path = history.log_path(&id);
    let mut log = super::history::PendingSessionLog::open(history, &id).unwrap();
    log.file().write_all(b"committed bytes").unwrap();
    drop(log.commit());
    assert_eq!(std::fs::read(path).unwrap(), b"committed bytes");
}

#[test]
fn closure_t01_native_resume_claim_bridge_failure_and_retry_use_private_owned_processes() {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use tauri::Manager;
    let _serial = super::worktree_manager::serial_owner_test();
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    let executable = fixture.root.join("fake-agent");
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o700)
        .open(&executable)
        .unwrap();
    file.write_all(b"#!/bin/sh\nfor arg do if [ \"$arg\" = --version ]; then printf '2.1.286 (Claude Code)\\n'; exit 0; fi; done\nexit 77\n").unwrap();
    drop(file);
    let launch: super::AgentLaunch = serde_json::from_value(serde_json::json!({
        "adapter":"claude","mode":"interactive","extra_args":"","prompt":"original prompt must not replay",
        "provider":{"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:1","api_key_env":null}
    })).unwrap();
    let environment =
        super::provider_launch::prepare(&fixture.root, &launch, &|_| panic!("no real credentials"))
            .unwrap();
    let config = environment.config_root(
        "claude",
        &fixture.root,
        &fixture.root.join("forbidden-fallback"),
    );
    assert!(config.starts_with(fixture.root.join("providers")));
    let native = "12345678-1234-1234-1234-123456789abc";
    let transcript = config.join("projects/fixture");
    std::fs::create_dir_all(&transcript).unwrap();
    let cwd = fixture.root.canonicalize().unwrap();
    std::fs::write(
        transcript.join(format!("{native}.jsonl")),
        serde_json::to_vec(&serde_json::json!({
            "type":"user", "sessionId":native,"isSidechain":false,"cwd":cwd,
            "message":{"role":"user","content":"owned fixture"}
        }))
        .unwrap(),
    )
    .unwrap();
    let mut summary = fixture.session.summary.clone();
    summary.cwd = fixture.root.to_string_lossy().into_owned();
    summary.command = None;
    summary.launch = Some(launch);
    summary.status = "succeeded".into();
    fixture.session.history.start(&summary).unwrap();
    fixture
        .session
        .history
        .configure_agent(&fixture.id(), "owned-generation")
        .unwrap();
    fixture
        .session
        .history
        .bind_resume_identity(&fixture.id(), native)
        .unwrap();
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let started = T01Started::default();
    let (_, held) = super::claim_resume_source(
        &fixture.session.history,
        manager.resume_claims.clone(),
        &fixture.id(),
    )
    .unwrap();
    let error = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |_, _| panic!("held native claim must not spawn"),
        |_, _, _, _, _| panic!("held native claim must not connect"),
        &started,
    )
    .err()
    .unwrap();
    assert!(error.contains("already being resumed"));
    assert!(fixture.requests().as_array().unwrap().is_empty());
    drop(held);
    let connections = std::cell::Cell::new(0);
    let failed = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |_, builder| {
            let args: Vec<_> = builder
                .get_argv()
                .iter()
                .map(|v| v.to_string_lossy().into_owned())
                .collect();
            assert!(args.windows(2).any(|v| v == ["--resume", native]));
            assert!(!args.iter().any(|v| v.contains("original prompt")));
            Err("owned native spawn refusal".into())
        },
        |_, _, _, _, _| {
            connections.set(connections.get() + 1);
            Err("owned bridge registration refusal".into())
        },
        &started,
    )
    .err()
    .unwrap();
    assert!(failed.contains("owned native spawn refusal"));
    assert_eq!(connections.get(), 1);
    assert!(manager.resume_claims.lock().unwrap().is_empty());
    assert!(manager.sessions.lock().unwrap().is_empty());
    let failed = fixture
        .session
        .history
        .latest_terminal(&fixture.id())
        .unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed
        .agent
        .integration
        .contains("owned bridge registration refusal"));
    assert_eq!(failed.agent.agent_session_id.as_deref(), Some(native));
    assert!(fixture
        .session
        .history
        .log_path(&failed.summary.session_id)
        .exists());
    let spawns = std::cell::Cell::new(0);
    let reply = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |slave, builder| {
            spawns.set(spawns.get() + 1);
            let args: Vec<_> = builder
                .get_argv()
                .iter()
                .map(|v| v.to_string_lossy().into_owned())
                .collect();
            assert!(args.windows(2).any(|v| v == ["--resume", native]));
            slave
                .spawn_command(super::ordinary_shell_command(&shell, || "unused".into()).unwrap())
                .map_err(|e| e.to_string())
        },
        |_, history, id, prepared, _| {
            history.configure_agent_version(
                id,
                &prepared.generation,
                prepared.cli_version.as_deref(),
            )
        },
        &started,
    )
    .unwrap();
    assert_eq!(spawns.get(), 1);
    assert_eq!(reply.reopened_from, Some(failed.summary.session_id));
    assert_eq!(manager.sessions.lock().unwrap().len(), 1);
    let record = fixture
        .session
        .history
        .get(&reply.summary.session_id)
        .unwrap();
    assert_eq!(record.conversation_id, Some(fixture.id()));
    assert_eq!(record.agent.agent_session_id.as_deref(), Some(native));
    assert_eq!(
        record.agent.cli_version.as_deref(),
        Some("2.1.286 (Claude Code)")
    );
    assert!(manager.resume_claims.lock().unwrap().contains(native));
    assert_eq!(
        fixture.session.history.get(&fixture.id()).unwrap().status,
        "succeeded"
    );
    manager.sessions.lock().unwrap().clear();
    drop(started);
    assert!(manager.resume_claims.lock().unwrap().is_empty());
}

#[test]
fn closure_t01_ambiguous_commit_never_reads_linked_history_to_delete_log() {
    let fixture = Rust85Session::new("exit 0");
    let history = fixture.session.history.clone();
    let id = super::next_session_id();
    let log = history.log_path(&id);
    let mut pending = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
    pending.begin_commit();
    let original = history.records_path();
    std::fs::rename(&original, fixture.root.join("saved-history.json")).unwrap();
    let outside = fixture.root.join("other-records.json");
    std::fs::write(&outside, b"[]").unwrap();
    std::os::unix::fs::symlink(&outside, &original).unwrap();
    drop(pending);
    assert!(
        log.exists(),
        "linked history cannot authorize rollback deletion"
    );
    assert_eq!(std::fs::read(outside).unwrap(), b"[]");
    std::fs::remove_file(&original).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let fifo = std::ffi::CString::new(original.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let id = super::next_session_id();
    let log = history.log_path(&id);
    let mut pending = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
    pending.begin_commit();
    let started = std::time::Instant::now();
    drop(pending);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(
        log.exists(),
        "FIFO history is uncertain and cannot authorize deletion"
    );
}

#[test]
fn closure_t01_spawn_failure_preserves_committed_log_and_failed_history_then_retries() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    closure_t01_shell(&fixture.root);
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let started = T01Started::default();
    let error = closure_t01_start(
        &fixture,
        &app,
        None,
        None,
        |_, _| Err("owned spawn refusal".into()),
        |_, _, _, _, _| panic!("shell cannot connect bridge"),
        &started,
    )
    .err()
    .unwrap();
    assert!(error.contains("owned spawn refusal"));
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(started.borrow().is_empty());
    let rows = fixture.requests();
    let id = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["op"] == "create")
        .unwrap()["session"]
        .as_str()
        .unwrap();
    let record = fixture.session.history.get(id).unwrap();
    assert_eq!(record.status, "failed");
    assert!(record.reason.unwrap().contains("owned spawn refusal"));
    assert!(fixture.session.history.log_path(id).exists());
    assert!(rows
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["op"] == "close" && r["session"] == id));
    let reply = closure_t01_start(
        &fixture,
        &app,
        None,
        None,
        |slave, builder| slave.spawn_command(builder).map_err(|e| e.to_string()),
        |_, _, _, _, _| panic!("shell cannot connect bridge"),
        &started,
    )
    .unwrap();
    assert_ne!(reply.summary.session_id, id);
    assert_eq!(started.borrow().len(), 1);
    assert_eq!(fixture.session.history.get(id).unwrap().status, "failed");
    manager.sessions.lock().unwrap().clear();
}

#[test]
fn closure_t01_stored_reopen_restore_failure_rolls_back_and_retry_uses_one_new_id() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    fixture
        .session
        .history
        .update(&fixture.id(), "succeeded", Some(0), None, None)
        .unwrap();
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"restore":"error"}),
    );
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let started = T01Started::default();
    let error = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |_, _| panic!("failed restore must not spawn"),
        |_, _, _, _, _| panic!("stored shell cannot connect bridge"),
        &started,
    )
    .err()
    .unwrap();
    assert!(
        error.contains("owned parser refusal"),
        "unexpected restore error: {error}"
    );
    let requests = fixture.requests();
    let rows = requests.as_array().unwrap();
    let id = rows.iter().find(|r| r["op"] == "create").unwrap()["session"]
        .as_str()
        .unwrap();
    assert!(rows
        .iter()
        .any(|r| r["op"] == "close" && r["session"] == id));
    assert!(!fixture.session.history.log_path(id).exists());
    assert_eq!(fixture.session.history.list().unwrap().len(), 1);
    assert!(manager.sessions.lock().unwrap().is_empty());
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"restore":{"text":"restored π"}}),
    );
    let allocations = std::cell::Cell::new(0);
    let reply = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |slave, _| {
            allocations.set(allocations.get() + 1);
            slave
                .spawn_command(super::ordinary_shell_command(&shell, || "unused".into()).unwrap())
                .map_err(|e| e.to_string())
        },
        |_, _, _, _, _| panic!("stored shell cannot connect bridge"),
        &started,
    )
    .unwrap();
    assert_eq!(allocations.get(), 1);
    assert_eq!(reply.reopened_from, Some(fixture.id()));
    assert_ne!(reply.summary.session_id, id);
    let record = fixture
        .session
        .history
        .get(&reply.summary.session_id)
        .unwrap();
    assert_eq!(record.conversation_id, Some(fixture.id()));
    assert_eq!(record.output_end_offset, "restored π".len() as u64);
    assert_eq!(
        std::fs::read(fixture.session.history.log_path(&reply.summary.session_id)).unwrap(),
        "restored π".as_bytes()
    );
    let active = manager.sessions.lock().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(
        active[&reply.summary.session_id]
            .terminal
            .as_ref()
            .unwrap()
            .session,
        reply.summary.session_id
    );
    drop(active);
    manager.sessions.lock().unwrap().clear();
}

#[test]
fn closure_t01_running_reopen_reuses_live_id_and_finishing_rejects_without_allocation() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    closure_t01_shell(&fixture.root);
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    *manager.terminal_runtime.lock().unwrap() = fixture.parser.clone();
    let started = T01Started::default();
    let reply = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |_, _| panic!("running source must not allocate"),
        |_, _, _, _, _| panic!("running source must not connect"),
        &started,
    )
    .unwrap();
    assert_eq!(reply.summary.session_id, fixture.id());
    assert!(started.borrow().is_empty());
    assert!(fixture.requests().as_array().unwrap().is_empty());
    *fixture.session.status.lock().unwrap() = "succeeded".into();
    let error = closure_t01_start(
        &fixture,
        &app,
        Some(fixture.id()),
        None,
        |_, _| panic!("finishing source must not allocate"),
        |_, _, _, _, _| panic!("finishing source must not connect"),
        &started,
    )
    .err()
    .unwrap();
    assert!(error.contains("finishing"));
    assert!(fixture.requests().as_array().unwrap().is_empty());
    assert_eq!(manager.sessions.lock().unwrap().len(), 1);
}
#[test]
fn closure_t01_pending_log_preserves_committed_existing_replaced_and_uncertain_files() {
    let _serial = super::worktree_manager::serial_owner_test();
    use std::io::Write;
    let fixture = Rust85Session::new("exit 0");
    let history = fixture.session.history.clone();
    let id = super::next_session_id();
    let path = history.log_path(&id);
    {
        let mut log = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
        log.file().write_all(b"restored bytes").unwrap();
    }
    assert!(!path.exists(), "own writes must not prevent rollback");
    std::fs::write(&path, b"existing bytes").unwrap();
    drop(super::history::PendingSessionLog::open(history.clone(), &id).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"existing bytes");
    std::fs::remove_file(&path).unwrap();
    {
        let _log = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
        std::fs::rename(&path, path.with_extension("retained")).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
    }
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    std::fs::remove_file(&path).unwrap();
    {
        let mut log = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
        log.begin_commit();
        let mut summary = fixture.session.summary.clone();
        summary.session_id = id.clone();
        history.start(&summary).unwrap();
    }
    assert!(
        path.exists(),
        "durably referenced log must survive ambiguous commit result"
    );
    std::fs::remove_file(&path).unwrap();
    {
        let mut log = super::history::PendingSessionLog::open(history.clone(), &id).unwrap();
        log.begin_commit();
        std::fs::write(history.records_path(), b"unreadable history").unwrap();
    }
    assert!(path.exists(), "uncertain history must preserve log");
}

// Author: Jeff.Liu. Fixtures own every PTY, parser and history directory they exercise.
pub(super) type T01Started =
    std::cell::RefCell<Vec<(Rust85Session, Box<dyn std::io::Read + Send>)>>;

pub(super) fn closure_t01_app(fixture: &Rust85Session) -> tauri::App<tauri::test::MockRuntime> {
    use tauri::Manager;
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    manager.sessions.lock().unwrap().clear();
    *manager.terminal_runtime.lock().unwrap() = fixture.parser.clone();
    app
}

#[test]
fn closure_t10_changed_managed_gemini_config_refuses_before_spawn_and_history_commit() {
    use std::os::unix::fs::PermissionsExt;
    use tauri::Manager;
    let _serial = super::worktree_manager::serial_owner_test();
    for change in [
        "unchanged",
        "auth",
        "settings_inode",
        "connection",
        "home_inode",
        "permissions",
        "directory_permissions",
        "symlink",
        "hardlink",
    ] {
        let mut fixture = Rust85Session::new("exit 0");
        fixture.parser();
        let app = closure_t01_app(&fixture);
        let manager = app.state::<super::SessionManager>();
        let launch: super::AgentLaunch = serde_json::from_value(serde_json::json!({
            "adapter":"gemini", "mode":"task", "extra_args":"", "prompt":"owned fixture",
            "provider":{"id":"gemini","model":"fixture-model","base_url":"http://127.0.0.1:3425","api_key_env":null}
        })).unwrap();
        let prepared = super::provider_launch::prepare(&fixture.root, &launch, &|_| {
            panic!("no source credentials")
        })
        .unwrap();
        let home = prepared.home.as_ref().unwrap().clone();
        let settings = home.join(".gemini/settings.json");
        let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
        let spawned = std::cell::Cell::new(0);
        let result = super::create_session_with_effects(
            Some(app.handle().clone()),
            &manager,
            &fixture.root,
            Some(fixture.root.to_string_lossy().into_owned()),
            None,
            Some(launch),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            |_| Some(fixture.root.join("fake-agent")),
            |size| {
                match change {
                    "unchanged" => {}
                    "auth" => std::fs::write(
                        &settings,
                        br#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#,
                    )
                    .unwrap(),
                    "settings_inode" => {
                        std::fs::rename(&settings, settings.with_extension("saved")).unwrap();
                        std::fs::copy(settings.with_extension("saved"), &settings).unwrap();
                    }
                    "connection" => {
                        std::fs::write(home.join("yam-connection.json"), b"{}").unwrap()
                    }
                    "home_inode" => {
                        let saved = home.with_extension("saved");
                        std::fs::rename(&home, &saved).unwrap();
                        super::background::private_root(&home).unwrap();
                        super::background::private_root(&home.join(".gemini")).unwrap();
                        std::fs::copy(
                            saved.join("yam-connection.json"),
                            home.join("yam-connection.json"),
                        )
                        .unwrap();
                        std::fs::copy(saved.join(".gemini/settings.json"), &settings).unwrap();
                    }
                    "permissions" => {
                        std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o644))
                            .unwrap()
                    }
                    "directory_permissions" => {
                        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755))
                            .unwrap()
                    }
                    "symlink" | "hardlink" => {
                        let saved = settings.with_extension("saved");
                        std::fs::rename(&settings, &saved).unwrap();
                        if change == "symlink" {
                            std::os::unix::fs::symlink(saved, &settings).unwrap();
                        } else {
                            std::fs::hard_link(saved, &settings).unwrap();
                        }
                    }
                    _ => unreachable!(),
                }
                super::native_pty_system()
                    .openpty(size)
                    .map_err(|e| e.to_string())
            },
            |_, _| {
                spawned.set(spawned.get() + 1);
                Err("owned spawn boundary".into())
            },
            |_, _, _, _, _| panic!("task mode has no hook probe"),
            |_, _, _| {},
            |_, _, _, _| panic!("failed spawn never starts workers"),
        );
        let error = result.err().unwrap();
        if change == "unchanged" {
            assert_eq!(
                spawned.get(),
                1,
                "safe managed config reaches spawn: {error}"
            );
            assert!(error.contains("owned spawn boundary"));
        } else {
            assert_eq!(
                spawned.get(),
                0,
                "{change}: changed managed config must fail before spawn, got {error}"
            );
            assert_eq!(
                error, "Managed provider configuration changed; no CLI was started",
                "{change}"
            );
            assert_eq!(
                serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
                before,
                "{change}"
            );
        }
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(manager.resume_claims.lock().unwrap().is_empty());
    }
}

#[test]
fn closure_t10_project_prepare_cannot_outlive_changed_or_revoked_trust() {
    use tauri::Manager;
    let _serial = super::worktree_manager::serial_owner_test();
    for change in [
        "unchanged",
        "source",
        "root",
        "revoked",
        "cwd_escape",
        "cwd_inode",
    ] {
        let mut fixture = Rust85Session::new("exit 0");
        fixture.parser();
        let project = fixture.root.join("owned-project");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(project.join("sub")).unwrap();
        let outside = fixture.root.join("owned-outside-project");
        std::fs::create_dir(&outside).unwrap();
        let original =
            br#"{"version":1,"defaults":{"adapter":"custom","command":"printf approved","cwd":"sub"}}"#;
        std::fs::write(project.join("yam.json"), original).unwrap();
        let preview = super::project_config::preview(&project, &fixture.root).unwrap();
        super::project_config::trust(&project, &fixture.root, &preview).unwrap();
        let app = closure_t01_app(&fixture);
        let manager = app.state::<super::SessionManager>();
        let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
        let spawned = std::cell::Cell::new(0);
        let result = super::create_session_with_effects(
            Some(app.handle().clone()),
            &manager,
            &fixture.root,
            None,
            None,
            None,
            None,
            Some(super::project_config::ProjectStart {
                root: project.to_string_lossy().into_owned(),
                template: None,
                overrides: Default::default(),
            }),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            |_| panic!("custom project has no agent executable"),
            |size| {
                match change {
                    "unchanged" => {},
                    "source" => std::fs::write(project.join("yam.json"), br#"{"version":1,"defaults":{"adapter":"custom","command":"printf changed"}}"#).unwrap(),
                    "root" => { std::fs::rename(&project, project.with_extension("saved")).unwrap(); std::fs::create_dir(&project).unwrap(); std::fs::write(project.join("yam.json"), original).unwrap(); },
                    "revoked" => {
                        let path = fixture.root.join("project-launch.json");
                        let mut store: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                        store["trusted"] = serde_json::json!([]);
                        std::fs::write(path, serde_json::to_vec(&store).unwrap()).unwrap();
                    },
                    "cwd_escape" | "cwd_inode" => {
                        std::fs::rename(project.join("sub"), project.join("saved-sub")).unwrap();
                        if change == "cwd_escape" { std::os::unix::fs::symlink(&outside, project.join("sub")).unwrap(); }
                        else { std::fs::create_dir(project.join("sub")).unwrap(); }
                    },
                    _ => unreachable!(),
                }
                super::native_pty_system()
                    .openpty(size)
                    .map_err(|e| e.to_string())
            },
            |_, _| {
                spawned.set(spawned.get() + 1);
                Err("owned project spawn boundary".into())
            },
            |_, _, _, _, _| panic!("custom project has no hook probe"),
            |_, _, _| {},
            |_, _, _, _| panic!("failed spawn cannot start workers"),
        );
        let error = result.err().unwrap();
        if change == "unchanged" {
            assert_eq!(spawned.get(), 1, "{error}");
        } else {
            assert_eq!(
                spawned.get(),
                0,
                "{change}: approved snapshot became stale but reached spawn: {error}"
            );
            assert_eq!(error, "project_config_changed", "{change}");
            assert_eq!(
                serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
                before
            );
        }
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}

#[test]
fn closure_t10_final_spawn_rechecks_config_changed_during_hook_registration() {
    use std::os::unix::fs::PermissionsExt;
    use tauri::Manager;
    let _serial = super::worktree_manager::serial_owner_test();
    for change in ["connection", "cwd"] {
        let mut fixture = Rust85Session::new("exit 0");
        fixture.parser();
        let executable = fixture.root.join("fake-claude");
        std::fs::write(
            &executable,
            b"#!/bin/sh\nprintf '2.1.302 (Claude Code)\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launch: super::AgentLaunch = serde_json::from_value(serde_json::json!({
        "adapter":"claude","mode":"interactive","extra_args":"","prompt":null,
        "provider":{"id":"claude","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}
    })).unwrap();
        let environment = super::provider_launch::prepare(&fixture.root, &launch, &|_| {
            panic!("no source credentials")
        })
        .unwrap();
        let connection = environment.home.unwrap().join("yam-connection.json");
        let project = fixture.root.join("late-project");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(project.join("sub")).unwrap();
        let outside = fixture.root.join("late-outside");
        std::fs::create_dir(&outside).unwrap();
        let source = serde_json::json!({"version":1,"defaults":{"adapter":"claude","mode":"interactive","extra_args":"","prompt":null,"provider":launch.provider,"cwd":"sub"}});
        std::fs::write(
            project.join("yam.json"),
            serde_json::to_vec(&source).unwrap(),
        )
        .unwrap();
        let preview = super::project_config::preview(&project, &fixture.root).unwrap();
        super::project_config::trust(&project, &fixture.root, &preview).unwrap();

        let app = closure_t01_app(&fixture);
        let manager = app.state::<super::SessionManager>();
        let connected = std::cell::Cell::new(0);
        let spawned = std::cell::Cell::new(0);
        let result = super::create_session_with_effects(
            Some(app.handle().clone()),
            &manager,
            &fixture.root,
            (change == "connection").then(|| fixture.root.to_string_lossy().into_owned()),
            None,
            (change == "connection").then_some(launch),
            None,
            (change == "cwd").then(|| super::project_config::ProjectStart {
                root: project.to_string_lossy().into_owned(),
                template: None,
                overrides: Default::default(),
            }),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            |_| Some(executable.clone()),
            |size| {
                super::native_pty_system()
                    .openpty(size)
                    .map_err(|e| e.to_string())
            },
            |_, _| {
                spawned.set(spawned.get() + 1);
                Err("must not reach process spawn".into())
            },
            |_, _, _, _, _| {
                connected.set(connected.get() + 1);
                if change == "connection" {
                    std::fs::write(&connection, b"{}").unwrap();
                } else {
                    std::fs::rename(project.join("sub"), project.join("saved-sub")).unwrap();
                    std::os::unix::fs::symlink(&outside, project.join("sub")).unwrap();
                }
                Ok(())
            },
            |_, _, _| {},
            |_, _, _, _| panic!("failed start never publishes workers"),
        );
        assert_eq!(
            connected.get(),
            1,
            "real version check must prepare the hook registration"
        );
        assert_eq!(spawned.get(), 0);
        assert!(result.err().unwrap().contains(if change == "connection" {
            "Managed provider configuration changed; no CLI was started"
        } else {
            "project_config_changed"
        }));
        assert!(manager.sessions.lock().unwrap().is_empty());
        let record = fixture
            .session
            .history
            .list()
            .unwrap()
            .into_iter()
            .find(|record| record.summary.launch.is_some())
            .unwrap();
        assert_eq!(
            record.status, "failed",
            "a final pre-spawn refusal persists the existing failure contract"
        );
    }
}
pub(super) fn closure_t01_start(
    fixture: &Rust85Session,
    app: &tauri::App<tauri::test::MockRuntime>,
    resume: Option<String>,
    launch: Option<super::AgentLaunch>,
    spawn: impl FnMut(
        &dyn portable_pty::SlavePty,
        super::CommandBuilder,
    ) -> Result<Box<dyn super::Child + Send + Sync>, String>,
    connect: impl FnOnce(
        &tauri::AppHandle<tauri::test::MockRuntime>,
        std::sync::Arc<super::HistoryStore>,
        &str,
        &super::agent_bridge::Prepared,
        &mut super::CommandBuilder,
    ) -> Result<(), String>,
    started: &T01Started,
) -> Result<super::CreateSessionReply, String> {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    let ordinary = resume.is_none() && launch.is_none();
    super::create_session_with_effects(
        Some(app.handle().clone()),
        &manager,
        &fixture.root,
        resume
            .is_none()
            .then(|| fixture.root.to_string_lossy().into_owned()),
        None,
        launch,
        resume,
        None,
        None,
        ordinary.then(|| super::ShellLaunch {
            program: Some(fixture.root.join("bash").to_string_lossy().into_owned()),
            login: Some(false),
        }),
        None,
        None,
        None,
        None,
        None,
        |name| {
            matches!(name, "claude" | "codex" | "gemini").then(|| fixture.root.join("fake-agent"))
        },
        |size| {
            super::native_pty_system()
                .openpty(size)
                .map_err(|error| error.to_string())
        },
        spawn,
        connect,
        |_, _, _| {},
        |_, _, session, reader| {
            started.borrow_mut().push((
                Rust85Session {
                    session,
                    root: fixture.root.join("allocated-cleanup"),
                    parser: None,
                },
                reader,
            ))
        },
    )
}

#[test]
fn terminal_environment_production_spawn_defaults_unusable_owner_term() {
    let _serial = super::worktree_manager::serial_owner_test();
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    closure_t01_shell(&fixture.root);
    let app = closure_t01_app(&fixture);
    let started = T01Started::default();
    let expected = std::env::var_os("TERM")
        .filter(|value| !value.is_empty() && value.as_os_str() != "dumb")
        .unwrap_or_else(|| "xterm-256color".into());
    let result = closure_t01_start(
        &fixture, &app, None, None,
        |_, builder| {
            assert_eq!(builder.get_env("TERM"), Some(expected.as_os_str()));
            Err("owned TERM spawn boundary".into())
        },
        |_, _, _, _, _| panic!("ordinary shell has no agent probe"),
        &started,
    );
    assert!(result.err().unwrap().contains("owned TERM spawn boundary"));
    assert!(started.borrow().is_empty());
}

#[test]
fn closure_t01_parser_create_failure_keeps_history_and_removes_uncommitted_log() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    closure_t01_shell(&fixture.root);
    fixture.configure(serde_json::json!({}), serde_json::json!({"create":"error"}));
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
    let started = T01Started::default();
    let result = closure_t01_start(
        &fixture,
        &app,
        None,
        None,
        |_, _| panic!("parser failure must not spawn"),
        |_, _, _, _, _| panic!("parser failure must not connect"),
        &started,
    );
    let error = result.err().unwrap();
    assert!(
        error.contains("owned parser refusal"),
        "unexpected parser failure: {error}"
    );
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(manager.resume_claims.lock().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
        before
    );
    assert!(started.borrow().is_empty());
    let requests = fixture.requests();
    let request = requests
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["op"] == "create")
        .unwrap();
    let log = fixture
        .session
        .history
        .log_path(request["session"].as_str().unwrap());
    assert!(
        !log.exists(),
        "failed allocation left an untracked session log: {}",
        log.display()
    );
}

#[test]
fn closure_t01_history_commit_failure_closes_parser_and_removes_uncommitted_log() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    closure_t01_shell(&fixture.root);
    let app = closure_t01_app(&fixture);
    let manager = app.state::<super::SessionManager>();
    let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
    std::fs::create_dir(fixture.root.join("sessions.json.tmp")).unwrap();
    let started = T01Started::default();
    let result = closure_t01_start(
        &fixture,
        &app,
        None,
        None,
        |_, _| panic!("history failure must not spawn"),
        |_, _, _, _, _| panic!("history failure must not connect"),
        &started,
    );
    let error = result.err().unwrap();
    assert!(
        error.contains("session history"),
        "unexpected history error: {error}"
    );
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(manager.resume_claims.lock().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
        before
    );
    assert!(started.borrow().is_empty());
    let requests = fixture.requests();
    let rows = requests.as_array().unwrap();
    let created = rows
        .iter()
        .find(|r| r["op"] == "create")
        .unwrap_or_else(|| {
            panic!("no parser create for history failure {error}; requests={requests}")
        });
    let id = created["session"].as_str().unwrap();
    assert!(rows
        .iter()
        .any(|r| r["op"] == "close" && r["session"] == id));
    assert!(
        !fixture.session.history.log_path(id).exists(),
        "history failure left an uncommitted log"
    );
}

pub(super) fn closure_t01_shell(root: &std::path::Path) -> super::ShellLaunch {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = root.join("bash");
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o700)
        .open(&path)
        .unwrap();
    file.write_all(b"#!/bin/sh\nprintf 'T01_READY\\n'\nIFS= read -r line\n")
        .unwrap();
    super::ShellLaunch {
        program: Some(path.to_string_lossy().into_owned()),
        login: Some(false),
    }
}

#[test]
fn closure_t01_real_allocation_updates_owned_pty_parser_history_and_active_state() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    manager.sessions.lock().unwrap().clear();
    *manager.terminal_runtime.lock().unwrap() = fixture.parser.clone();
    let started = std::cell::RefCell::new(Vec::new());
    let notifications = std::cell::Cell::new(0);
    let reply = super::create_session_with_effects(
        Some(app.handle().clone()),
        &manager,
        &fixture.root,
        Some(fixture.root.to_string_lossy().into_owned()),
        None,
        None,
        None,
        None,
        None,
        Some(shell),
        None,
        None,
        None,
        None,
        None,
        |name| panic!("ordinary shell must not discover an agent: {name}"),
        |size| {
            super::native_pty_system()
                .openpty(size)
                .map_err(|error| error.to_string())
        },
        |slave, builder| {
            slave
                .spawn_command(builder)
                .map_err(|error| error.to_string())
        },
        |_, _, _, _, _| panic!("ordinary shell must not register an agent"),
        |_, _, _| notifications.set(notifications.get() + 1),
        |_, _, session, reader| {
            started.borrow_mut().push((
                Rust85Session {
                    session,
                    root: fixture.root.join("allocated-cleanup"),
                    parser: None,
                },
                reader,
            ));
        },
    )
    .unwrap();
    let id = &reply.summary.session_id;
    assert_eq!(reply.summary.status, "running");
    assert!(reply.reopened_from.is_none());
    let active = manager.sessions.lock().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[id].summary.session_id, *id);
    assert_eq!(*active[id].status.lock().unwrap(), "running");
    let size = active[id]
        .master
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .get_size()
        .unwrap();
    assert_eq!((size.cols, size.rows), (100, 24));
    drop(active);
    let record = fixture
        .session
        .history
        .list()
        .unwrap()
        .into_iter()
        .find(|r| r.summary.session_id == *id)
        .unwrap();
    assert_eq!(record.status, "running");
    assert_eq!(notifications.get(), 1);
    assert_eq!(started.borrow().len(), 1);
    let requests = fixture.requests();
    let creates: Vec<_> = requests
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["op"] == "create")
        .collect();
    assert_eq!(creates.len(), 1);
    assert_eq!(creates[0]["session"], *id);
    manager.sessions.lock().unwrap().clear();
    drop(started);
}

#[test]
fn closure_t01_pty_failure_allocates_no_history_parser_child_or_active_session() {
    let _serial = super::worktree_manager::serial_owner_test();
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.parser();
    let shell = closure_t01_shell(&fixture.root);
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    manager.sessions.lock().unwrap().clear();
    *manager.terminal_runtime.lock().unwrap() = fixture.parser.clone();
    let before = serde_json::to_value(fixture.session.history.list().unwrap()).unwrap();
    let opened = std::cell::Cell::new(0);
    let result = super::create_session_with_effects(
        Some(app.handle().clone()),
        &manager,
        &fixture.root,
        Some(fixture.root.to_string_lossy().into_owned()),
        None,
        None,
        None,
        None,
        None,
        Some(shell),
        None,
        None,
        None,
        None,
        None,
        |_| panic!("unexpected agent lookup"),
        |_| {
            opened.set(opened.get() + 1);
            Err("owned PTY refusal".to_owned())
        },
        |_, _| panic!("PTY failure must not spawn"),
        |_, _, _, _, _| panic!("PTY failure must not register an agent"),
        |_, _, _| panic!("PTY failure must not publish running"),
        |_, _, _, _| panic!("PTY failure must not start workers"),
    );
    assert!(result.err().unwrap().contains("owned PTY refusal"));
    assert_eq!(opened.get(), 1);
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(manager.resume_claims.lock().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(fixture.session.history.list().unwrap()).unwrap(),
        before
    );
    assert!(fixture.requests().as_array().unwrap().is_empty());
}

#[test]
fn closure_t16_memory_worker_checks_real_task_membership_and_busy_or_failed_workers() {
    use tauri::Manager;
    static GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static PANIC_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let mut fixture = Rust85Session::new("sleep 30");
    fixture.parser();
    let app = fixture.app();
    *app.state::<super::SessionManager>()
        .terminal_runtime
        .lock()
        .unwrap() = fixture.parser.clone();
    let owner = super::memory_processes(&app.state()).unwrap();
    assert_eq!(owner.workloads.len(), 1);
    let handle = app.handle().clone();
    let sample = tauri::async_runtime::block_on(super::memory_usage_with(
        &GATE,
        move || super::memory_processes(&handle.state()),
        |_| {
            Ok(super::memory::Sample {
                application_bytes: 10,
                workload_bytes: 20,
                metric: "fixture",
                sampled_at: 1,
            })
        },
    ))
    .unwrap();
    assert_eq!((sample.application_bytes, sample.workload_bytes), (10, 20));
    let handle = app.handle().clone();
    let session = fixture.session.clone();
    let changed = tauri::async_runtime::block_on(super::memory_usage_with(
        &GATE,
        move || super::memory_processes(&handle.state()),
        move |_| {
            *session.status.lock().unwrap() = "exited".into();
            Ok(super::memory::Sample {
                application_bytes: 10,
                workload_bytes: 20,
                metric: "fixture",
                sampled_at: 1,
            })
        },
    ));
    assert_eq!(
        changed.err().unwrap(),
        "Task membership changed during memory sampling"
    );
    let held = GATE.lock().unwrap();
    let busy = tauri::async_runtime::block_on(super::memory_usage_with(
        &GATE,
        || panic!("busy owner lookup"),
        |_| panic!("busy sampler"),
    ));
    drop(held);
    assert_eq!(busy.err().unwrap(), "Memory sampling already in progress");
    let failed = tauri::async_runtime::block_on(super::memory_usage_with(
        &PANIC_GATE,
        || panic!("owned worker failure"),
        |_| panic!("unreachable sampler"),
    ));
    assert_eq!(failed.err().unwrap(), "Memory sampling worker failed");
}

pub(super) struct Rust85Session {
    pub(super) session: std::sync::Arc<super::Session>,
    pub(super) root: std::path::PathBuf,
    parser: Option<std::sync::Arc<super::terminal_runtime::Runtime>>,
}

impl Rust85Session {
    pub(super) fn new(command: &str) -> Self {
        let (session, _, root) = test_session(command);
        Self {
            session,
            root,
            parser: None,
        }
    }

    pub(super) fn app(&self) -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Manager;
        let app = tauri::test::mock_app();
        app.manage(super::SessionManager::default());
        let manager = app.state::<super::SessionManager>();
        *manager.history.lock().unwrap() = Some(self.session.history.clone());
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(self.id(), self.session.clone());
        app
    }

    pub(super) fn id(&self) -> String {
        self.session.summary.session_id.clone()
    }

    pub(super) fn parser(&mut self) -> String {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let path = self.root.join("rust85-parser.cjs");
        let node = super::find_executable("node").expect("Node is a project test prerequisite");
        let script = r#"
const readline=require('node:readline');const emit=x=>console.log(JSON.stringify(x));
const instance=process.env.YAM_TERMINAL_INSTANCE;let patch={},replies={},requests=[];
emit({type:'ready',version:1,instance,terminal_version:'6.0.0',serialize_version:'0.14.0'});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
let data=null;if(r.op==='fixture_set'){patch=r.patch||{};replies=r.replies||{};}
else if(r.op==='fixture_requests'){data=requests;}
else if(r.op==='fixture_instance'){data=instance;}
else {requests.push(r);if(r.op==='snapshot'||r.op==='stream_snapshot'){data={version:1,instance,session:r.session,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,data:'screen',cols:80,rows:24,cursorX:0,viewport:0,buffer:'normal',clear_display_version:1,prompt_navigation:{version:1,previous:true,next:true},...patch};}
else if(r.op==='clear_display'){data={status:'cleared'};}
else if(r.op==='navigate_prompt'){data={status:'moved'};}
if(Object.hasOwn(replies,r.op)){if(replies[r.op]==='error'){emit({id:r.id,ok:false,error:'owned parser refusal'});return;}data=replies[r.op];}}
emit({id:r.id,ok:true,data});});
"#;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)
            .unwrap();
        write!(file, "#!{}\n{}", node.display(), script).unwrap();
        drop(file);
        let runtime = std::sync::Arc::new(
            super::terminal_runtime::Runtime::start(&path, |_, _| Ok(())).unwrap(),
        );
        let instance = runtime
            .call("fixture_instance", &self.id(), serde_json::json!({}))
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        std::sync::Arc::get_mut(&mut self.session).unwrap().terminal =
            Some(super::TerminalAttachment {
                runtime: runtime.clone(),
                session: self.id(),
                reported: std::sync::atomic::AtomicBool::new(false),
                command_reporting: true,
            });
        self.parser = Some(runtime);
        instance
    }

    pub(super) fn configure(&self, patch: serde_json::Value, replies: serde_json::Value) {
        self.parser
            .as_ref()
            .unwrap()
            .call(
                "fixture_set",
                &self.id(),
                serde_json::json!({"patch":patch,"replies":replies}),
            )
            .unwrap();
    }

    pub(super) fn requests(&self) -> serde_json::Value {
        self.parser
            .as_ref()
            .unwrap()
            .call("fixture_requests", &self.id(), serde_json::json!({}))
            .unwrap()
    }
}

impl Drop for Rust85Session {
    fn drop(&mut self) {
        if let Some(parser) = &self.parser {
            parser.stop();
        }
        let _ = super::request_session_stop(&self.session);
        if let Ok(mut child) = self.session.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn rust85_state_fixture_drop_reaps_only_its_owned_child_and_directory() {
    let fixture = Rust85Session::new("sleep 30");
    let session = fixture.session.clone();
    let root = fixture.root.clone();
    drop(fixture);
    assert!(session.child.lock().unwrap().try_wait().unwrap().is_some());
    assert!(!root.exists());
}

#[test]
fn rust85_state_unknown_and_invalid_commands_do_not_allocate_a_session() {
    use tauri::Manager;
    let app = tauri::test::mock_app();
    app.manage(super::SessionManager::default());
    let manager = app.state::<super::SessionManager>();
    let id = "missing".to_owned();
    assert!(
        super::clear_terminal_display(manager.clone(), id.clone(), "bad".into())
            .unwrap_err()
            .contains("Invalid terminal clear")
    );
    assert!(
        super::clear_terminal_display(manager.clone(), id.clone(), "a".repeat(64))
            .unwrap_err()
            .contains("Unknown live terminal")
    );
    assert!(super::navigate_reported_prompt(
        manager.clone(),
        id.clone(),
        "bad".into(),
        "a".repeat(64)
    )
    .is_err());
    assert!(super::navigate_reported_prompt(
        manager.clone(),
        id.clone(),
        "previous".into(),
        "a".repeat(64)
    )
    .unwrap_err()
    .contains("Unknown live terminal"));
    assert!(
        super::write_session(manager.clone(), id.clone(), "x".into())
            .unwrap_err()
            .contains("Unknown session")
    );
    assert!(super::resize_session(manager.clone(), id.clone(), 0, 24)
        .unwrap_err()
        .contains("greater than zero"));
    assert!(super::resize_session(manager.clone(), id.clone(), 80, 0).is_err());
    assert!(super::resize_session(manager.clone(), id.clone(), 80, 24)
        .unwrap_err()
        .contains("Unknown session"));
    assert!(super::set_terminal_viewport(manager.clone(), id.clone(), 0, None).is_err());
    assert!(super::stop_session(manager.clone(), id.clone()).is_err());
    assert!(super::take_terminal_control(manager.clone(), id)
        .unwrap_err()
        .contains("background owner"));
    assert!(super::retry_agent_notifications(manager.clone())
        .unwrap_err()
        .contains("Agent bridge unavailable"));
    assert!(manager.sessions.lock().unwrap().is_empty());
}

#[test]
fn rust85_state_write_and_resize_reach_only_the_owned_pty() {
    use tauri::Manager;
    let fixture = Rust85Session::new("read line; test \"$line\" = coverage-write");
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    super::resize_session(manager.clone(), fixture.id(), 91, 37).unwrap();
    let dimensions = fixture
        .session
        .master
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .get_size()
        .unwrap();
    assert_eq!((dimensions.cols, dimensions.rows), (91, 37));
    *fixture.session.last_activity.lock().unwrap() =
        std::time::Instant::now() - std::time::Duration::from_secs(10);
    super::write_session(manager.clone(), fixture.id(), "coverage-write\n".into()).unwrap();
    assert!(
        fixture.session.last_activity.lock().unwrap().elapsed() < std::time::Duration::from_secs(2)
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let status = loop {
        if let Some(status) = fixture.session.child.lock().unwrap().try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned shell did not receive the expected input"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    assert!(status.success());
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), "a".repeat(64))
            .unwrap()
            .status,
        super::ClearDisplayStatus::Unavailable
    );
    assert_eq!(
        super::navigate_reported_prompt(
            manager.clone(),
            fixture.id(),
            "previous".into(),
            "a".repeat(64)
        )
        .unwrap()
        .status,
        super::shell_command_report::NavigationStatus::Unavailable
    );
    assert!(
        super::set_terminal_viewport(manager.clone(), fixture.id(), 7, None)
            .unwrap_err()
            .contains("parser unavailable")
    );
    fixture.session.master.lock().unwrap().take();
    assert!(super::resize_session(manager.clone(), fixture.id(), 80, 24)
        .unwrap_err()
        .contains("PTY is closed"));
    assert!(
        super::write_session(manager.clone(), fixture.id(), "x".into())
            .unwrap_err()
            .contains("PTY is closed")
    );
}

#[test]
fn rust85_state_clear_and_navigation_enforce_lifecycle_and_reply_contracts() {
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.session.child.lock().unwrap().wait().unwrap();
    let instance = fixture.parser();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), instance.clone())
            .unwrap()
            .status,
        super::ClearDisplayStatus::Cleared
    );
    for direction in ["previous", "next"] {
        assert_eq!(
            super::navigate_reported_prompt(
                manager.clone(),
                fixture.id(),
                direction.into(),
                instance.clone()
            )
            .unwrap()
            .status,
            super::shell_command_report::NavigationStatus::Moved
        );
    }
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), "b".repeat(64))
            .unwrap()
            .status,
        super::ClearDisplayStatus::Stale
    );
    assert_eq!(
        super::navigate_reported_prompt(
            manager.clone(),
            fixture.id(),
            "previous".into(),
            "b".repeat(64)
        )
        .unwrap()
        .status,
        super::shell_command_report::NavigationStatus::Stale
    );
    fixture.configure(
        serde_json::json!({"buffer":"alternate"}),
        serde_json::json!({}),
    );
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), instance.clone())
            .unwrap()
            .status,
        super::ClearDisplayStatus::Unavailable
    );
    assert_eq!(
        super::navigate_reported_prompt(
            manager.clone(),
            fixture.id(),
            "next".into(),
            instance.clone()
        )
        .unwrap()
        .status,
        super::shell_command_report::NavigationStatus::Unavailable
    );
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"clear_display":{},"navigate_prompt":{}}),
    );
    assert!(
        super::clear_terminal_display(manager.clone(), fixture.id(), instance.clone())
            .unwrap_err()
            .contains("Invalid terminal clear reply")
    );
    assert!(super::navigate_reported_prompt(
        manager.clone(),
        fixture.id(),
        "next".into(),
        instance.clone()
    )
    .unwrap_err()
    .contains("Invalid prompt navigation reply"));
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"clear_display":"error","navigate_prompt":"error"}),
    );
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), instance.clone()).unwrap_err(),
        "owned parser refusal"
    );
    assert_eq!(
        super::navigate_reported_prompt(
            manager.clone(),
            fixture.id(),
            "previous".into(),
            instance.clone()
        )
        .unwrap_err(),
        "owned parser refusal"
    );
    let before = fixture.requests().as_array().unwrap().len();
    *fixture.session.status.lock().unwrap() = "stopped".into();
    assert_eq!(
        super::clear_terminal_display(manager.clone(), fixture.id(), instance.clone())
            .unwrap()
            .status,
        super::ClearDisplayStatus::Unavailable
    );
    assert_eq!(
        super::navigate_reported_prompt(manager.clone(), fixture.id(), "previous".into(), instance)
            .unwrap()
            .status,
        super::shell_command_report::NavigationStatus::Unavailable
    );
    assert_eq!(fixture.requests().as_array().unwrap().len(), before);
}

#[test]
fn rust85_state_viewport_and_resize_rollback_preserve_parser_dimensions() {
    use tauri::Manager;
    let mut fixture = Rust85Session::new("exit 0");
    fixture.session.child.lock().unwrap().wait().unwrap();
    fixture.parser();
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    super::set_terminal_viewport(manager.clone(), fixture.id(), 9, None).unwrap();
    super::set_terminal_viewport(manager.clone(), fixture.id(), 4, Some(true)).unwrap();
    let requests = fixture.requests();
    let viewports: Vec<_> = requests
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["op"] == "viewport")
        .collect();
    assert_eq!(
        (
            viewports[0]["line"].as_u64(),
            viewports[0]["bottom"].as_bool()
        ),
        (Some(9), Some(false))
    );
    assert_eq!(
        (
            viewports[1]["line"].as_u64(),
            viewports[1]["bottom"].as_bool()
        ),
        (Some(4), Some(true))
    );
    super::resize_session(manager.clone(), fixture.id(), 92, 31).unwrap();
    fixture.session.master.lock().unwrap().take();
    assert!(
        super::resize_session(manager.clone(), fixture.id(), 101, 39)
            .unwrap_err()
            .contains("PTY is closed")
    );
    let requests = fixture.requests();
    let sizes: Vec<_> = requests
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["op"] == "resize")
        .map(|r| (r["cols"].as_u64(), r["rows"].as_u64()))
        .collect();
    assert_eq!(
        sizes,
        vec![
            (Some(92), Some(31)),
            (Some(101), Some(39)),
            (Some(80), Some(24))
        ]
    );
    fixture.configure(
        serde_json::json!({}),
        serde_json::json!({"viewport":"error"}),
    );
    assert_eq!(
        super::set_terminal_viewport(manager, fixture.id(), 0, None).unwrap_err(),
        "owned parser refusal"
    );
}

#[test]
fn rust85_state_active_frame_strips_capabilities_after_terminal_completion() {
    let mut fixture = Rust85Session::new("exit 0");
    fixture.session.child.lock().unwrap().wait().unwrap();
    fixture.parser();
    fixture.session.log.lock().unwrap().end_offset = 17;
    let active = super::active_frame(&fixture.session).unwrap();
    assert_eq!(active.end_offset, 17);
    assert!(!active.persisted);
    assert_eq!(active.clear_display_version, Some(1));
    assert!(active.reported_prompt_navigation.is_some());
    *fixture.session.status.lock().unwrap() = "stopped".into();
    let ended = super::active_frame(&fixture.session).unwrap();
    assert!(ended.clear_display_version.is_none());
    assert!(ended.reported_prompt_navigation.is_none());
    assert!(ended.reported_command.is_none());
    assert!(ended.reported_cwd.is_none());
    assert!(ended.projection.get("clear_display_version").is_none());
    assert!(ended.projection.get("prompt_navigation").is_none());
}

#[test]
fn rust85_state_stop_is_idempotent_and_writes_reject_stopped_sessions() {
    use tauri::Manager;
    let fixture = Rust85Session::new("sleep 30");
    let app = fixture.app();
    let manager = app.state::<super::SessionManager>();
    super::stop_session(manager.clone(), fixture.id()).unwrap();
    super::stop_session(manager.clone(), fixture.id()).unwrap();
    assert!(fixture
        .session
        .stop_requested
        .load(std::sync::atomic::Ordering::Acquire));
    assert!(super::write_session(manager, fixture.id(), "ignored".into()).is_err());
}
