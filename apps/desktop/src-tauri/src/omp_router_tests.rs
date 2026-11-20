// Author: Jeff.Liu
use super::*;
fn omp_launch() -> AgentLaunch {
    serde_json::from_value(serde_json::json!({"adapter":"omp","mode":"interactive","extra_args":"","prompt":null,"omp":{"policy":"{}","session":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}})).unwrap()
}
#[test]
fn omp_adapter_and_managed_snapshot_contract() {
    assert!(agent_adapters().iter().any(|a| a.id == "omp"));
    let mut launch = omp_launch();
    assert!(omp_router::prepare_launch(&mut launch, false).is_err());
    assert!(omp_router::prepare_launch(&mut launch, true).is_ok());
    launch.omp.as_mut().unwrap().session = None;
    omp_router::prepare_launch(&mut launch, false).unwrap();
    assert!(valid_resume_id(
        launch.omp.as_ref().unwrap().session.as_ref().unwrap()
    ));
}
#[test]
fn omp_authentication_defaults_and_legacy_resume_keep_their_identity() {
    let mut fresh = omp_launch();
    fresh.omp.as_mut().unwrap().session = None;
    omp_router::prepare_launch(&mut fresh, false).unwrap();
    assert_eq!(serde_json::to_value(&fresh).unwrap()["omp"]["auth"], "yam");
    let mut legacy = omp_launch();
    omp_router::prepare_launch(&mut legacy, true).unwrap();
    assert_eq!(serde_json::to_value(&legacy).unwrap()["omp"]["auth"], "pi");
    let mut explicit: AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":"omp","mode":"interactive","extra_args":"","omp":{"policy":null,"auth":"yam","session":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}})).unwrap();
    omp_router::prepare_launch(&mut explicit, true).unwrap();
    assert_eq!(
        serde_json::to_value(&explicit).unwrap()["omp"]["auth"],
        "yam"
    );
    assert!(serde_json::from_value::<AgentLaunch>(serde_json::json!({"adapter":"omp","mode":"interactive","extra_args":"","omp":{"policy":null,"auth":"unknown"}})).is_err());
}
#[test]
fn omp_command_stages_provider_and_guards_owned_arguments() {
    let root = std::env::temp_dir().join(format!(
        "yam-omp-app-test-{}",
        gemini_resume::new_id().unwrap()
    ));
    let mut launch = omp_launch();
    let command = omp_router::command(Path::new("/fixture/omp"), &launch, &root, None).unwrap();
    let argv: Vec<_> = command
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy())
        .collect();
    assert!(argv[1].ends_with("extensions/omp-chatgpt/run.mjs"));
    assert!(command.get_env("YAM_OMP_DESKTOP").is_some());
    assert_eq!(command.get_env("YAM_OMP_AUTH_SOURCE").unwrap(), "yam");
    assert_eq!(
        command.get_env("YAM_OMP_AUTH_DIR").unwrap(),
        root.join("omp-auth")
    );
    launch.omp.as_mut().unwrap().auth = Some(omp_router::AuthSource::Pi);
    let backup = omp_router::command(Path::new("/fixture/omp"), &launch, &root, None).unwrap();
    assert_eq!(backup.get_env("YAM_OMP_AUTH_SOURCE").unwrap(), "pi");
    let entry = Path::new(argv[1].as_ref()).with_file_name("index.mjs");
    assert!(entry.is_file());
    for arg in [
        "--resume hacked",
        "--session-dir /tmp/other",
        "--profile other",
        "--mode rpc",
        "-e /tmp/evil",
        "--api-key secret",
        "--config /tmp/overlay",
        "--model yam-chatgpt/gpt-6-luna",
    ] {
        launch.extra_args = arg.into();
        assert!(
            omp_router::command(Path::new("/fixture/omp"), &launch, &root, None).is_err(),
            "{arg}"
        );
    }
    launch.extra_args = "--append-system-prompt '--resume'".into();
    assert!(omp_router::command(Path::new("/fixture/omp"), &launch, &root, None).is_ok());
    std::fs::write(entry, "tampered").unwrap();
    assert!(omp_router::stage(&root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn omp_resume_validates_native_header_directory_and_links() {
    let root = std::env::temp_dir().join(format!(
        "yam-omp-resume-{}",
        gemini_resume::new_id().unwrap()
    ));
    std::fs::create_dir(&root).unwrap();
    let launch = omp_launch();
    let dir = root
        .join("omp-sessions")
        .join(launch.omp.as_ref().unwrap().session.as_ref().unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    let id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let file = dir.join("native.jsonl");
    std::fs::write(
        &file,
        format!(
            "{}\n",
            serde_json::json!({"type":"session","id":id,"cwd":root})
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(
        omp_router::validate_session(&root, &launch, id, &root).unwrap(),
        file
    );
    assert!(omp_router::validate_session(&root, &launch, id, &std::env::temp_dir()).is_err());
    assert!(omp_router::validate_session(&root, &launch, "../evil", &root).is_err());
    #[cfg(unix)]
    {
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), &file).unwrap();
        assert!(omp_router::validate_session(&root, &launch, id, &root).is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn omp_resume_accepts_title_preamble_without_trusting_later_conversation_entries() {
    let root = std::env::temp_dir().join(format!(
        "yam-omp-title-{}",
        gemini_resume::new_id().unwrap()
    ));
    let launch = omp_launch();
    let dir = root
        .join("omp-sessions")
        .join(launch.omp.as_ref().unwrap().session.as_ref().unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    let id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let file = dir.join("native.jsonl");
    let header = serde_json::json!({"type":"session","id":id,"cwd":root}).to_string();
    let title =
        serde_json::json!({"type":"title","title":"Retained native conversation"}).to_string();
    std::fs::write(&file, format!("{title}\n{header}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(
        omp_router::validate_session(&root, &launch, id, &root).unwrap(),
        file
    );
    std::fs::write(&file, format!("{title}\n{title}\n{header}\n")).unwrap();
    assert_eq!(
        omp_router::validate_session(&root, &launch, id, &root).unwrap(),
        file
    );
    assert!(omp_router::validate_session(
        &root,
        &launch,
        "cccccccc-cccc-cccc-cccc-cccccccccccc",
        &root
    )
    .is_err());
    assert!(omp_router::validate_session(&root, &launch, id, &std::env::temp_dir()).is_err());
    for prefix in [
        serde_json::json!({"type":"message","message":{"role":"user"}}).to_string(),
        serde_json::json!({"type":"session","id":"cccccccc-cccc-cccc-cccc-cccccccccccc","cwd":root}).to_string(),
        "invalid JSON".into(),
    ] {
        std::fs::write(&file, format!("{prefix}\n{header}\n")).unwrap();
        assert!(omp_router::validate_session(&root, &launch, id, &root).is_err());
    }
    let large_title = serde_json::json!({"type":"title","title":"x".repeat(9000)}).to_string();
    std::fs::write(&file, format!("{large_title}\n{large_title}\n{header}\n")).unwrap();
    assert!(omp_router::validate_session(&root, &launch, id, &root)
        .unwrap_err()
        .contains("too large"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[ignore = "Explicit native launcher smoke fixture; requires YAM_OMP_LIVE_ROOT"]
fn omp_live_command_receipt_is_explicitly_opt_in() {
    let root = std::env::var_os("YAM_OMP_LIVE_ROOT").expect("Explicit live fixture directory");
    let root = Path::new(&root);
    background::private_root(root).unwrap();
    let mut launch = omp_launch();
    launch.omp.as_mut().unwrap().session = None;
    omp_router::prepare_launch(&mut launch, false).unwrap();
    let exe = find_executable("omp").unwrap();
    let command = omp_router::command(&exe, &launch, root, None).unwrap();
    let data = serde_json::json!({"argv":command.get_argv().iter().map(|a|a.to_string_lossy()).collect::<Vec<_>>(),"env":command.iter_extra_env_as_str().collect::<std::collections::BTreeMap<_,_>>(),"launch":launch});
    std::fs::write(
        root.join("command.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
}
#[test]
fn omp_project_defaults_store_policy_without_native_identity() {
    let root = std::env::temp_dir().join(format!(
        "yam-omp-project-{}",
        gemini_resume::new_id().unwrap()
    ));
    background::private_root(&root).unwrap();
    let valid = project_config::LaunchSettings(
        serde_json::from_value(
            serde_json::json!({"adapter":"omp","mode":"interactive","omp":{"policy":"{}"}}),
        )
        .unwrap(),
    );
    project_config::set_global(&root, &valid).unwrap();
    assert_eq!(
        project_config::get_global(&root).unwrap().0["omp"]["policy"],
        "{}"
    );
    for value in [
        serde_json::json!({"adapter":"pi","omp":{"policy":"{}"}}),
        serde_json::json!({"adapter":"omp","omp":{"policy":"{}","session":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}}),
    ] {
        assert!(project_config::set_global(
            &root,
            &project_config::LaunchSettings(serde_json::from_value(value).unwrap())
        )
        .is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn omp_final_spawn_drops_login_shell_node_preloads_and_stale_resume() {
    let mut child = std::process::Command::new("node");
    child.env("NODE_OPTIONS", "--require /untrusted/preload.js");
    child.env("NODE_PATH", "/untrusted/modules");
    omp_router::sanitize_process(&mut child);
    let env: std::collections::BTreeMap<_, _> = child.get_envs().collect();
    for key in ["NODE_OPTIONS", "NODE_PATH", "YAM_OMP_RESUME"] {
        assert_eq!(env.get(std::ffi::OsStr::new(key)), Some(&None));
    }
}
#[test]
fn omp_background_create_accepts_the_actual_app_snapshot_and_rejects_foreign_fields() {
    let mut args = serde_json::json!({"cwd":"/tmp","command":null,"launch":{"adapter":"omp","mode":"interactive","extra_args":"","prompt":null,"provider":null,"omp":{"policy":"{}"}}});
    assert!(background::validate_command("create_session", &args).is_ok());
    args["launch"]["omp"]["unknown"] = serde_json::json!(true);
    assert!(background::validate_command("create_session", &args).is_err());
    args["launch"]["omp"]
        .as_object_mut()
        .unwrap()
        .remove("unknown");
    args["launch"]["adapter"] = serde_json::json!("pi");
    assert!(background::validate_command("create_session", &args).is_err());
}

#[test]
fn omp_auth_jobs_require_current_yam_identity_and_bound_private_owner_configuration() {
    let root = std::env::temp_dir().join(format!(
        "yam-omp-auth-contract-{}",
        crate::next_session_id()
    ));
    let history = crate::HistoryStore::open(root.clone()).unwrap();
    let mut launch = omp_launch();
    launch.omp.as_mut().unwrap().session = None;
    omp_router::prepare_launch(&mut launch, false).unwrap();
    history
        .start(&crate::SessionSummary {
            session_id: "s-1-1".into(),
            cwd: root.to_string_lossy().into(),
            command: None,
            status: "running".into(),
            launch: Some(launch.clone()),
            ssh: None,
        })
        .unwrap();
    history.configure_agent("s-1-1", "generation").unwrap();
    let mut record = history.get("s-1-1").unwrap();
    assert!(omp_router::authorize_auth_job(&record, "generation").is_ok());
    assert!(omp_router::authorize_auth_job(&record, "old").is_err());
    record
        .summary
        .launch
        .as_mut()
        .unwrap()
        .omp
        .as_mut()
        .unwrap()
        .auth = Some(omp_router::AuthSource::Pi);
    assert!(omp_router::authorize_auth_job(&record, "generation").is_err());
    record.summary.launch = Some(launch.clone());
    record.status = "stopped".into();
    assert!(omp_router::authorize_auth_job(&record, "generation").is_err());
    let builder = omp_router::command(Path::new("/fixture/omp"), &launch, &root, None).unwrap();
    assert_eq!(
        builder.get_env("YAM_OMP_AUTH_OWNER_DESCRIPTOR").unwrap(),
        root.parent().unwrap().join("background/connection.json")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn omp_auth_owner_worker_survives_terminal_tree_cleanup_and_reaps() {
    let root =
        std::env::temp_dir().join(format!("yam-omp-auth-worker-{}", crate::next_session_id()));
    std::fs::create_dir_all(&root).unwrap();
    let script = root.join("worker.sh");
    let saved = root.join("saved");
    std::fs::write(&script,format!("printf '{{\"address\":\"127.0.0.1:12345\",\"token\":\"{}\",\"pid\":%s}}\\n' $$\nsleep 1\nprintf saved > '{}'\n","a".repeat(64),saved.display())).unwrap();
    let mut terminal = std::process::Command::new("/bin/sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .unwrap();
    let job = omp_router::spawn_auth_job(Path::new("/bin/sh"), &script, &root).unwrap();
    let worker = job["pid"].as_u64().unwrap() as u32;
    let tree = crate::process_tree(terminal.id()).unwrap();
    assert!(!tree.contains(&worker));
    for pid in tree.into_iter().rev() {
        crate::signal_process(pid, libc::SIGKILL).unwrap();
    }
    let _ = terminal.wait();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !saved.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), "saved");
    while unsafe { libc::kill(worker as i32, 0) } == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(unsafe { libc::kill(worker as i32, 0) }, -1);
    assert!(omp_router::spawn_auth_job(Path::new("/bin/false"), &script, &root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
