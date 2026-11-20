use super::{terminal_input::DraftInputGuard, AgentLaunch, SessionRecord};

fn record() -> SessionRecord {
    serde_json::from_value(serde_json::json!({
        "summary": {
            "session_id": "session-one",
            "cwd": "/work/project",
            "command": null,
            "status": "running",
            "launch": {
                "adapter": "pi",
                "mode": "interactive",
                "extra_args": "",
                "prompt": null
            }
        },
        "status": "running",
        "exit_code": null,
        "reason": null,
        "started_at": 1,
        "ended_at": null,
        "agent": {
            "generation": "generation-one",
            "agent_session_id": "native-one",
            "turn_id": "turn-one",
            "revision": 7,
            "background": "idle",
            "integration": "connected",
            "phase": "response_finished",
            "route_pending": false,
            "turns": [],
            "seen": [],
            "inbox": []
        }
    }))
    .unwrap()
}

fn guard() -> DraftInputGuard {
    serde_json::from_value(serde_json::json!({
        "cwd": "/work/project",
        "generation": "generation-one",
        "nativeSessionId": "native-one",
        "turnId": "turn-one",
        "revision": 7,
        "managedCodex": false
    }))
    .unwrap()
}

#[test]
fn draft_admission_accepts_matching_interactive_agent_and_bounded_bracketed_text() {
    assert!(guard()
        .validate(&record(), "\u{1b}[200~review this\u{1b}[201~")
        .is_ok());
}

#[test]
fn draft_admission_rejects_changed_session_state_and_malformed_input() {
    let stale = [
        |record: &mut SessionRecord| record.status = "stopped".into(),
        |record: &mut SessionRecord| record.summary.cwd = "/other".into(),
        |record: &mut SessionRecord| record.agent.phase = "working".into(),
        |record: &mut SessionRecord| record.agent.revision += 1,
        |record: &mut SessionRecord| record.agent.route_pending = true,
        |record: &mut SessionRecord| record.agent.integration = "disconnected".into(),
    ];
    for mutate in stale {
        let mut current = record();
        mutate(&mut current);
        assert!(guard()
            .validate(&current, "\u{1b}[200~review\u{1b}[201~")
            .is_err());
    }
    for input in [
        "review",
        "\u{1b}[200~\u{1b}[201~",
        "\u{1b}[200~bad\u{1b}[201~extra",
        &format!("\u{1b}[200~{}\u{1b}[201~", "x".repeat(65 * 1024)),
    ] {
        assert!(guard().validate(&record(), input).is_err());
    }
}

#[test]
fn draft_admission_matches_managed_codex_launch_state() {
    let mut current = record();
    current.summary.launch = Some(AgentLaunch {
        omp: None,
        claude_context: None,
        codex: Some(super::codex_context::Options {
            image_mode: super::codex_context::ImageMode::Native,
            context: None,
            route: Some(super::codex_routing::Route {
                name: "review".into(),
                config: "model = 'x'".into(),
                state: None,
                enabled: None,
                connection: None,
                native_model: None,
            }),
        }),
        env_refs: Default::default(),
        adapter: "codex".into(),
        mode: "interactive".into(),
        extra_args: String::new(),
        prompt: None,
        provider: None,
    });
    let mut expected = guard();
    expected.managed_codex = true;
    assert!(expected
        .validate(&current, "\u{1b}[200~review\u{1b}[201~")
        .is_ok());
    expected.managed_codex = false;
    assert!(expected
        .validate(&current, "\u{1b}[200~review\u{1b}[201~")
        .is_err());
}
