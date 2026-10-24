// Author: Jeff.Liu. Opt-in real CLI checks against a loopback fixture, with no vendor credentials.
use super::*;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

struct Fixture {
    root: PathBuf,
    server: Child,
    url: String,
    token: String,
}
fn fixture_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "yam-native-provider-{}-{}",
        std::process::id(),
        next_session_id()
    ))
}
#[test]
fn native_provider_fixture_paths_are_process_scoped_and_unique() {
    let first = fixture_root();
    assert_ne!(first, fixture_root());
    assert!(first
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with(&format!("yam-native-provider-{}-", std::process::id())));
}
impl Fixture {
    fn new() -> Self {
        let root = fixture_root();
        fs::create_dir_all(root.join("official/.codex")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        assert!(Command::new("git")
            .args([
                "-c",
                "init.templateDir=",
                "-c",
                "init.defaultBranch=main",
                "init",
                "--quiet"
            ])
            .arg(root.join("project"))
            .status()
            .unwrap()
            .success());
        for name in [".codex", ".claude", ".gemini"] {
            fs::create_dir(root.join("project").join(name)).unwrap();
        }
        fs::write(root.join("project/.codex/config.toml"), "model_provider = \"wrong_project\"\n[model_providers.wrong_project]\nname = \"wrong\"\nbase_url = \"http://127.0.0.1:1\"\nwire_api = \"responses\"\n").unwrap();
        fs::write(
            root.join("project/.claude/settings.json"),
            r#"{"permissions":{"deny":["Bash"]},"env":{"PROJECT_VALUE":"kept"}}"#,
        )
        .unwrap();
        fs::write(
            root.join("project/.gemini/.env"),
            "GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:1\nGEMINI_API_KEY=wrong-project-key\n",
        )
        .unwrap();
        fs::write(
            root.join("official/.codex/config.toml"),
            "official-config-sentinel",
        )
        .unwrap();
        fs::write(
            root.join("official/.codex/auth.json"),
            "official-auth-sentinel",
        )
        .unwrap();
        let token = format!(
            "YAM_CODEWORD_{}",
            &agent_bridge::credential().unwrap()[..16]
        );
        let mut server = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/provider_api.py"))
            .args(["--token", &token, "--receipts"])
            .arg(root.join("requests.jsonl"))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(server.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
        Self {
            root,
            server,
            url: ready["base_url"].as_str().unwrap().into(),
            token,
        }
    }
    fn environment(&self, launch: &AgentLaunch) -> provider_launch::Environment {
        provider_launch::validate_project(launch, &self.root.join("project")).unwrap();
        let mut environment =
            provider_launch::prepare(&self.root.join("private"), launch, &|name| {
                if launch.codex.is_some() && name == "CODEX_HOME" {
                    Some(
                        self.root
                            .join("official/.codex")
                            .to_string_lossy()
                            .into_owned(),
                    )
                } else {
                    panic!("No real credentials are used")
                }
            })
            .unwrap();
        environment.vars.insert(
            "HOME".into(),
            self.root.join("official").to_string_lossy().into(),
        );
        environment.vars.insert(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        );
        environment
            .vars
            .insert("DISABLE_AUTOUPDATER".into(), "1".into());
        environment
            .vars
            .insert("GEMINI_TELEMETRY_ENABLED".into(), "false".into());
        environment
    }
    fn run(
        &self,
        argv: &[std::ffi::OsString],
        environment: &provider_launch::Environment,
        label: &str,
    ) -> String {
        let output = self.root.join(format!("{label}.jsonl"));
        let error = self.root.join(format!("{label}.stderr"));
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(self.root.join("project"))
            .stdin(Stdio::null())
            .stdout(File::create(&output).unwrap())
            .stderr(File::create(&error).unwrap())
            .env("OPENAI_API_KEY", "official-key-do-not-use")
            .env("CODEX_HOME", self.root.join("official/.codex"));
        environment.apply_command(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(50);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                panic!("Native CLI timed out: {}", error.display());
            }
            thread::sleep(Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "Native CLI failed ({status}); stderr: {}",
            fs::read_to_string(error).unwrap()
        );
        fs::read_to_string(output).unwrap()
    }

    fn receipts(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(self.root.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        if thread::panicking() {
            eprintln!("Native CLI evidence retained at {}", self.root.display());
        } else {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn native_id(output: &str) -> String {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find_map(|value| {
            value["thread_id"]
                .as_str()
                .or(value["session_id"].as_str())
                .filter(|id| valid_resume_id(id))
                .map(str::to_owned)
        })
        .expect("CLI must emit a native UUID")
}

// Headless flags exercise the production command and native store without driving a terminal UI.
fn headless(
    mut argv: Vec<std::ffi::OsString>,
    adapter: &str,
    resume: bool,
    prompt: &str,
) -> Vec<std::ffi::OsString> {
    if adapter == "codex" {
        let index = argv
            .iter()
            .position(|v| v == if resume { "resume" } else { "--" })
            .unwrap();
        argv.splice(index..index, ["exec".into(), "--json".into()]);
    } else if adapter == "claude" {
        argv.splice(
            1..1,
            [
                "--print".into(),
                "--verbose".into(),
                "--output-format".into(),
                "stream-json".into(),
            ],
        );
    } else {
        for arg in &mut argv {
            if arg.to_string_lossy().starts_with("--prompt-interactive=") {
                *arg = format!("--prompt={prompt}").into();
            }
        }
        argv.extend([
            "--output-format".into(),
            "stream-json".into(),
            "--skip-trust".into(),
        ]);
    }
    if resume {
        if adapter == "gemini" {
            argv.push(format!("--prompt={prompt}").into());
        } else {
            argv.extend(["--".into(), prompt.into()]);
        }
    }
    argv
}

fn continuity(adapter: &str, provider: &str, model: &str) {
    continuity_with_image_mode(adapter, provider, model, None);
}
fn continuity_with_image_mode(
    adapter: &str,
    provider: &str,
    model: &str,
    image_mode: Option<&str>,
) {
    let fixture = Fixture::new();
    let original_config = if image_mode.is_some() {
        "model_reasoning_effort = 'low'\n[shell_environment_policy]\ninherit = 'core'\nexclude = ['OPENAI*']\ninclude_only = ['PATH']\n[shell_environment_policy.set]\nOPENAI_API_KEY = 'wrong-global-key'\n[features]\nmulti_agent = true\n"
    } else {
        "official-config-sentinel"
    };
    if image_mode.is_some() {
        fs::write(
            fixture.root.join("official/.codex/config.toml"),
            original_config,
        )
        .unwrap();
        fs::remove_file(fixture.root.join("project/.codex/config.toml")).unwrap();
    }
    let exe = find_executable(adapter)
        .expect("Install the requested CLI before explicitly running this smoke check");
    let prompt = format!(
        "Remember this codeword and reply with it: {}. Do not use tools.",
        fixture.token
    );
    let endpoint = if adapter == "claude" && provider == "deepseek" {
        format!("{}/anthropic", fixture.url)
    } else {
        fixture.url.clone()
    };
    let mut launch:AgentLaunch=serde_json::from_value(serde_json::json!({"adapter":adapter,"mode":"interactive","extra_args":"","prompt":prompt,"provider":{"id":provider,"model":model,"base_url":endpoint,"api_key_env":null}})).unwrap();
    if let Some(mode) = image_mode {
        launch.codex =
            Some(serde_json::from_value(serde_json::json!({"image_mode":mode})).unwrap());
        crate::codex_context::assign_context(&mut launch).unwrap();
    }
    let environment = fixture.environment(&launch);
    let initial = agent_command(&exe, &launch).unwrap();
    let mut argv = headless(initial.get_argv().to_vec(), adapter, false, &prompt);
    let explicit = (adapter == "gemini").then(|| gemini_resume::new_id().unwrap());
    if let Some(id) = &explicit {
        argv.extend(["--session-id".into(), id.into()]);
    }
    let first = fixture.run(&argv, &environment, "first");
    assert!(
        first.contains(&fixture.token),
        "First native response must contain the codeword: {first}"
    );
    let id = native_id(&first);
    if let Some(explicit) = explicit {
        assert_eq!(id, explicit);
    }
    let root = fixture.root.join("sessions");
    let history = HistoryStore::open(root.clone()).unwrap();
    let mut summary = SessionSummary {
        ssh: None,
        session_id: "initial".into(),
        cwd: fixture.root.join("project").to_string_lossy().into(),
        command: None,
        status: "stopped".into(),
        launch: Some(launch),
    };
    history.start(&summary).unwrap();
    history
        .configure_agent("initial", "trusted-launch")
        .unwrap();
    history.bind_resume_identity("initial", &id).unwrap();
    drop(history);
    let history = HistoryStore::open(root).unwrap();
    let (cwd, resumed, stored_id) = resume_source(&history, "initial").unwrap();
    assert_eq!(stored_id, id);
    let restored_environment = fixture.environment(&resumed);
    assert_eq!(environment.home, restored_environment.home);
    match adapter {
        "codex" => agent_bridge::validate_resume(
            &exe,
            Path::new(&cwd),
            &id,
            &resumed,
            Some(&restored_environment),
        )
        .unwrap(),
        "claude" => claude_resume::validate(
            restored_environment.home.as_ref().unwrap(),
            Path::new(&cwd),
            &id,
        )
        .unwrap(),
        _ => gemini_resume::validate(
            &restored_environment.home.as_ref().unwrap().join(".gemini"),
            Path::new(&cwd),
            &id,
        )
        .unwrap(),
    }
    let followup =
        "YAM_FOLLOWUP: What codeword did I ask you to remember? Reply with it. Do not use tools.";
    let command = resume_command(&exe, &resumed, &id).unwrap();
    let second = fixture.run(
        &headless(command.get_argv().to_vec(), adapter, true, followup),
        &restored_environment,
        "continued",
    );
    assert_eq!(native_id(&second), id);
    assert!(
        second.contains(&fixture.token),
        "Native continuation lost its context: {second}"
    );
    summary.session_id = "continued".into();
    summary.launch = Some(resumed);
    history
        .start_continuation(&summary, Some("initial"))
        .unwrap();
    history.bind_resume_identity("continued", &id).unwrap();
    let page = history.page(history::PageRequest::default()).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].previous_runs, vec!["initial"]);
    let receipts = fixture.receipts();
    if adapter == "codex" {
        assert!(
            receipts
                .iter()
                .all(|row| row["image_route_instructions"] == (image_mode != Some("native"))),
            "Fresh and resumed Codex must both receive the selected image API route: {receipts:?}"
        );
    }
    assert!(
        receipts.iter().any(|row| row["followup"] == true
            && row["initial"] == true
            && row["local_key"] == true),
        "The resumed request must carry prior context and the isolated local key: {receipts:?}"
    );
    if matches!(adapter, "codex" | "claude") {
        assert!(
            receipts
                .iter()
                .filter(|row| row["followup"] == true)
                .all(|row| row["model"] == model),
            "Native requests must keep the selected model: {receipts:?}"
        );
        assert!(
            receipts
                .iter()
                .any(|row| row["stream"] == true && row["local_key"] == true),
            "Native inference must use the isolated streaming API: {receipts:?}"
        );
        if adapter == "claude" && provider == "deepseek" {
            assert!(
                receipts
                    .iter()
                    .all(|row| row["path"].as_str().unwrap().starts_with("/anthropic/")),
                "DeepSeek Anthropic path must be preserved: {receipts:?}"
            );
        }
    }
    assert_eq!(
        fs::read_to_string(fixture.root.join("official/.codex/config.toml")).unwrap(),
        original_config
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("official/.codex/auth.json")).unwrap(),
        "official-auth-sentinel"
    );
    println!("{provider}/{adapter}: fresh process resumed UUID {id}, native context preserved, isolated key and official sentinels verified");
}

#[test]
#[ignore = "Opt-in installed Codex + loopback API; no vendor calls"]
fn provider_native_codex_continuity() {
    continuity("codex", "deepseek", "deepseek-flash");
}
#[test]
#[ignore = "Opt-in installed Claude + loopback API; no vendor calls"]
fn provider_native_claude_continuity() {
    continuity("claude", "deepseek", "deepseek-flash");
}

fn tool_roundtrip(adapter: &str, provider: &str, subtask: bool) {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("project/probe.txt"),
        format!("YAM_TOOL_OUTPUT_{}", fixture.token),
    )
    .unwrap();
    let exe = find_executable(adapter).expect("Install the explicitly selected CLI");
    let model = if provider == "custom" {
        "gateway/selected-model"
    } else {
        "deepseek-flash"
    };
    let prompt = if subtask {
        format!(
            "YAM_SUBTASK_PROBE: Ask a subagent to reply with {}.",
            fixture.token
        )
    } else {
        format!(
            "YAM_TOOL_PROBE: Read probe.txt, then reply with {}.",
            fixture.token
        )
    };
    let endpoint = if adapter == "claude" && provider == "deepseek" {
        format!("{}/anthropic", fixture.url)
    } else {
        fixture.url.clone()
    };
    let launch: AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":adapter,"mode":"interactive","extra_args":"","prompt":prompt,"provider":{"id":provider,"model":model,"base_url":endpoint,"api_key_env":null}})).unwrap();
    let environment = fixture.environment(&launch);
    let command = agent_command(&exe, &launch).unwrap();
    let output = fixture.run(
        &headless(command.get_argv().to_vec(), adapter, false, &prompt),
        &environment,
        "tools",
    );
    assert!(
        output.contains(&fixture.token),
        "Native tool round must finish: {output}"
    );
    let receipts = fixture.receipts();
    assert!(
        receipts.iter().any(|row| row["tool_issued"] == true
            && row["stream"] == true
            && row["local_key"] == true),
        "Native CLI must receive a supported tool call: {receipts:?}"
    );
    if !subtask {
        assert!(
            receipts.iter().any(|row| row["tool_result_seen"] == true
                && row["tool_output_ok"] == true
                && row["local_key"] == true),
            "Native CLI must send the actual file result back: {receipts:?}"
        );
    }
    assert!(
        receipts
            .iter()
            .filter(|row| row["tool_issued"] == true
                || row["tool_result_seen"] == true
                || row["subtask_child"] == true)
            .all(|row| row["model"] == model),
        "Tool requests must keep the configured model: {receipts:?}"
    );
    if subtask {
        assert!(
            receipts.iter().any(|row| row["subtask_child"] == true
                && row["model"] == model
                && row["local_key"] == true),
            "A real child-agent request must keep the selected model and key: {receipts:?}"
        );
    }
    assert_eq!(
        fs::read_to_string(fixture.root.join("official/.codex/config.toml")).unwrap(),
        "official-config-sentinel"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("official/.codex/auth.json")).unwrap(),
        "official-auth-sentinel"
    );
    println!("{provider}/{adapter}: selected model and isolated authentication verified; native subtask request={subtask}");
}

#[test]
#[ignore = "Opt-in installed Codex + loopback tool API; no vendor calls"]
fn provider_native_codex_tool_roundtrip() {
    tool_roundtrip("codex", "deepseek", false);
}

#[test]
#[ignore = "Opt-in installed Claude + loopback tool API; no vendor calls"]
fn provider_native_claude_tool_roundtrip() {
    tool_roundtrip("claude", "deepseek", false);
}

#[test]
#[ignore = "Opt-in installed Claude + loopback subagent API; no vendor calls"]
fn provider_native_claude_subtask_model() {
    tool_roundtrip("claude", "deepseek", true);
}

#[test]
#[ignore = "Opt-in installed Codex + custom loopback tool API; no vendor calls"]
fn provider_native_codex_custom_gateway_tools() {
    tool_roundtrip("codex", "custom", false);
}

#[test]
#[ignore = "Opt-in installed Claude + custom loopback tool API; no vendor calls"]
fn provider_native_claude_custom_gateway_tools() {
    tool_roundtrip("claude", "custom", false);
}

#[test]
#[ignore = "Opt-in installed Claude + legacy loopback gateway; no vendor calls"]
fn provider_native_claude_legacy_gateway_continuity() {
    continuity("claude", "gemini", "gemini/mock-model");
}
#[test]
#[ignore = "Opt-in installed Gemini + loopback API; no vendor calls"]
fn provider_native_gemini_continuity() {
    continuity("gemini", "gemini", "gemini-3-flash-preview");
}

#[test]
#[ignore = "Opt-in installed Codex and unmodified imagegen SDK script against loopback only; set YAM_TEST_IMAGE_PYTHON and YAM_TEST_IMAGE_SCRIPT"]
fn provider_native_codex_image_sdk_uses_session_gateway() {
    image_sdk_with_mode(None);
}
fn image_sdk_with_mode(image_mode: Option<&str>) {
    let python =
        std::env::var("YAM_TEST_IMAGE_PYTHON").expect("Select an existing Python with OpenAI SDK");
    let script =
        std::env::var("YAM_TEST_IMAGE_SCRIPT").expect("Select installed unmodified imagegen.py");
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\"'\"'"));
    for scenario in ["generate", "edit", "error"] {
        let fixture = Fixture::new();
        let original_config = if image_mode.is_some() {
            "model_reasoning_effort = 'low'\n[shell_environment_policy]\ninherit = 'core'\nexclude = ['OPENAI*']\ninclude_only = ['PATH']\n[shell_environment_policy.set]\nOPENAI_API_KEY = 'wrong-global-key'\n[features]\nmulti_agent = true\n"
        } else {
            "official-config-sentinel"
        };
        if image_mode.is_some() {
            fs::write(
                fixture.root.join("official/.codex/config.toml"),
                original_config,
            )
            .unwrap();
            fs::remove_file(fixture.root.join("project/.codex/config.toml")).unwrap();
        }
        let prompt = format!("YAM_IMAGE_PROBE {}: 画一张小鸡吃米图。", fixture.token);
        fs::write(
            fixture.root.join("project/AGENTS.md"),
            "YAM_PROJECT_INSTRUCTIONS_SENTINEL: preserve project instructions.",
        )
        .unwrap();
        let mut launch: AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":prompt,"provider":{"id":"custom","model":"3qrouter/gpt-6.1-sol","base_url":fixture.url,"api_key_env":null}})).unwrap();
        if let Some(mode) = image_mode {
            launch.codex =
                Some(serde_json::from_value(serde_json::json!({"image_mode":mode})).unwrap());
            crate::codex_context::assign_context(&mut launch).unwrap();
        }
        let environment = fixture.environment(&launch);
        let home = environment.home.as_ref().unwrap();
        let config_before = fs::read(home.join("config.toml")).unwrap();
        let image = fixture.root.join("project/result.png");
        // The fixture returns bytes; the real installed SDK and script save them.
        let reference = fixture.root.join("project/input.png");
        fs::write(&reference, b"fixture image for multipart route").unwrap();
        let mode = if scenario == "edit" {
            format!("edit --image {}", quote(reference.to_str().unwrap()))
        } else {
            "generate".into()
        };
        let command = format!(
            "{} {} {mode} --prompt {} --out {}",
            quote(&python),
            quote(&script),
            quote(if scenario == "error" {
                "YAM_IMAGE_ERROR"
            } else {
                "Draw a red pixel"
            }),
            quote(image.to_str().unwrap())
        );
        fs::write(fixture.root.join("image-command.txt"), command).unwrap();
        let executable = find_executable("codex").expect("Install selected Codex");
        let command = agent_command(&executable, &launch).unwrap();
        let mut argv = headless(command.get_argv().to_vec(), "codex", false, &prompt);
        // Only this synthetic fixture grants network access to the child SDK's loopback request.
        argv.splice(1..1, ["--sandbox".into(), "danger-full-access".into()]);
        let output = fixture.run(&argv, &environment, scenario);
        let receipts = fixture.receipts();
        assert!(receipts.iter().filter(|r| r["image_request"] != true).all(|r| r["image_route_instructions"] == (image_mode != Some("native")) && r["project_instructions_preserved"] == true), "A normal image prompt must receive both the session API route and original project instructions: {receipts:?}");
        let images: Vec<_> = receipts
            .iter()
            .filter(|r| r["image_request"] == true)
            .collect();
        assert_eq!(
            images.len(),
            1,
            "Exactly one SDK request must reach the session gateway: {receipts:?}; {output}"
        );
        assert_eq!(
            images[0]["path"],
            if scenario == "edit" {
                "/v1/images/edits"
            } else {
                "/v1/images/generations"
            }
        );
        assert_eq!(
            images[0]["model"], "gpt-image-2",
            "Preserve the mature skill's image model contract"
        );
        assert_eq!(images[0]["local_key"], true);
        assert_eq!(images[0]["official_key_seen"], false);
        assert_eq!(images[0]["edit_images"], usize::from(scenario == "edit"));
        assert!(receipts
            .iter()
            .filter(|r| r["image_request"] != true)
            .all(|r| r["model"] == "3qrouter/gpt-6.1-sol"));
        if scenario == "error" {
            assert!(!image.exists());
            assert!(
                output.contains("YAM_LOCAL_IMAGE_REFUSAL"),
                "Gateway refusal must reach Codex: {output}"
            );
        } else {
            assert!(fs::read(&image).unwrap().starts_with(b"\x89PNG\r\n\x1a\n"));
            assert!(
                output.contains("Wrote"),
                "Real SDK script output must return to Codex: {output}"
            );
        }
        assert!(!output.contains("official-key-do-not-use"));
        assert!(!output.contains("OPENAI_API_KEY is not set"));
        assert!(fs::read(home.join("config.toml"))
            .unwrap()
            .starts_with(&config_before));
        let reopened = fixture.environment(&launch);
        assert_eq!(reopened.home.as_ref(), Some(home));
        reopened.validate_before_spawn().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("official/.codex/config.toml")).unwrap(),
            original_config
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("official/.codex/auth.json")).unwrap(),
            "official-auth-sentinel"
        );
        println!("image SDK {scenario}: real Codex, original skill script, session URL/key, global config preserved");
    }
}

#[test]
#[ignore = "Opt-in installed Codex against loopback API, inherited native/gateway image contexts; no vendor calls"]
fn provider_native_codex_inherited_context_continuity() {
    for mode in ["native", "gateway_api"] {
        continuity_with_image_mode("codex", "custom", "gateway/selected-model", Some(mode));
    }
}

#[test]
#[ignore = "Opt-in installed Codex and imagegen SDK against loopback; inherited native and gateway image modes"]
fn provider_native_codex_inherited_image_sdk() {
    for mode in ["native", "gateway_api"] {
        image_sdk_with_mode(Some(mode));
    }
}

#[test]
#[ignore = "Opt-in installed Codex, local MCP echo and real child agent against loopback API only"]
fn provider_native_codex_inherited_mcp_and_subagent() {
    for scenario in ["YAM_MCP_PROBE", "YAM_CODEX_CHILD_PROBE"] {
        let fixture = Fixture::new();
        let source = fixture.root.join("official/.codex");
        let mcp = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/mcp_echo.py")
            .canonicalize()
            .unwrap();
        fs::write(source.join("config.toml"), format!("[features]\nmulti_agent = true\n[mcp_servers.fixture]\ncommand = 'python3'\nargs = ['{}']\n[agents.reviewer]\ndescription = 'Inherited reviewer'\nconfig_file = 'reviewer.toml'\n", mcp.display())).unwrap();
        fs::write(
            source.join("reviewer.toml"),
            "model = 'gateway/child-model'\nmodel_provider = 'previous-provider'\n",
        )
        .unwrap();
        fs::remove_file(fixture.root.join("project/.codex/config.toml")).unwrap();
        let prompt = format!("{scenario}: {}", fixture.token);
        let mut launch: AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":prompt,"provider":{"id":"custom","model":"gateway/main-model","base_url":fixture.url,"api_key_env":null},"codex":{"image_mode":"native"}})).unwrap();
        crate::codex_context::assign_context(&mut launch).unwrap();
        let env = fixture.environment(&launch);
        let command = agent_command(&find_executable("codex").unwrap(), &launch).unwrap();
        let output = fixture.run(
            &headless(command.get_argv().to_vec(), "codex", false, &prompt),
            &env,
            "inheritance-tools",
        );
        let receipts = fixture.receipts();
        if scenario == "YAM_MCP_PROBE" {
            assert!(
                receipts
                    .iter()
                    .any(|r| r["tool_result_seen"] == true && r["tool_output_ok"] == true),
                "Native MCP result missing: {receipts:?}; {output}"
            );
        } else {
            assert!(receipts.iter().any(|r| r["subtask_child"] == true && r["model"] == "gateway/child-model" && r["local_key"] == true), "Native child must retain role model and gateway authentication: {receipts:?}; {output}");
        }
        assert!(receipts.iter().all(|r| r["local_key"] == true));
        assert_eq!(
            fs::read_to_string(source.join("auth.json")).unwrap(),
            "official-auth-sentinel"
        );
        println!("{scenario}: native inherited tool route verified");
    }
}

#[test]
#[cfg(unix)]
#[ignore = "Opt-in installed headless Codex skill catalog with synthetic shared resources; no inference or desktop app"]
fn provider_native_codex_shared_skill_catalog() {
    let fixture = Fixture::new();
    let source = fixture.root.join("official/.codex");
    let package = fixture.root.join("skill-package");
    let skill = package.join("skills/yam-shared-fixture");
    fs::create_dir_all(&skill).unwrap();
    fs::create_dir_all(package.join("docs")).unwrap();
    fs::create_dir_all(source.join("skills")).unwrap();
    fs::write(skill.join("SKILL.md"), "---\nname: yam-shared-fixture\ndescription: Synthetic skill to verify shared package paths.\n---\nRead ../../docs/standard.md.\n").unwrap();
    fs::write(package.join("docs/standard.md"), "shared dependency").unwrap();
    std::os::unix::fs::symlink(&skill, source.join("skills/yam-shared-fixture")).unwrap();
    fs::write(source.join("config.toml"), "").unwrap();
    fs::remove_file(fixture.root.join("project/.codex/config.toml")).unwrap();
    let mut launch: AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null,"provider":{"id":"custom","model":"gateway/main-model","base_url":fixture.url,"api_key_env":null},"codex":{"image_mode":"native"}})).unwrap();
    crate::codex_context::assign_context(&mut launch).unwrap();
    let env = fixture.environment(&launch);
    let script = r#"
import json, os, pathlib, select, subprocess, sys, time
p = subprocess.Popen([sys.argv[1], '--no-daemon', 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
def send(value):
    p.stdin.write(json.dumps(value) + '\n'); p.stdin.flush()
def response(serial):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        ready, _, _ = select.select([p.stdout], [], [], max(0, deadline-time.monotonic()))
        if not ready: break
        line = p.stdout.readline()
        if not line: raise AssertionError('Codex app-server exited before skill catalog response')
        value = json.loads(line)
        if value.get('id') == serial:
            assert 'error' not in value, value
            return value['result']
    raise AssertionError('Codex skill catalog timed out')
try:
    send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'yam-shared-fixture','version':'1'},'capabilities':{'experimentalApi':False}}})
    response(1); send({'method':'initialized'})
    send({'id':2,'method':'skills/list','params':{'cwds':[sys.argv[2]],'forceReload':True}})
    catalog = response(2)
    matches = [s for row in catalog['data'] for s in row['skills'] if s['name']=='yam-shared-fixture']
    assert len(matches)==1, catalog
    path = pathlib.Path(matches[0]['path'])
    assert path.resolve() == pathlib.Path(sys.argv[3]).resolve(), matches
    assert (path.parent/'../../docs/standard.md').read_text() == 'shared dependency'
    print(json.dumps({'skill':matches[0]['name'],'path':str(path),'resolved_path':str(path.resolve()),'dependency':'readable','inference_requests':0}))
finally:
    os.killpg(p.pid, 15)
    try: p.wait(timeout=3)
    except subprocess.TimeoutExpired: os.killpg(p.pid, 9); p.wait()
"#;
    let mut command = Command::new("python3");
    command
        .arg("-c")
        .arg(script)
        .arg(find_executable("codex").unwrap())
        .arg(fixture.root.join("project"))
        .arg(skill.join("SKILL.md"))
        .env("HOME", fixture.root.join("official"))
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("HTTPS_PROXY", "http://127.0.0.1:1")
        .env("ALL_PROXY", "http://127.0.0.1:1")
        .env("NO_PROXY", "127.0.0.1,localhost");
    env.apply_command(&mut command);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert_eq!(
        fs::read_to_string(source.join("auth.json")).unwrap(),
        "official-auth-sentinel"
    );
}
