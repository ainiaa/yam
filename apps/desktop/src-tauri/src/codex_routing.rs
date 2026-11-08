// Author: Jeff.Liu. Bind each managed Codex terminal to an owner-created route session.
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeModel {
    pub model: String,
    pub effort: String,
}

impl NativeModel {
    fn valid(&self) -> bool {
        !self.model.is_empty()
            && self.model.len() <= 450
            && self
                .model
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:/-".contains(&c))
            && matches!(
                self.effort.as_str(),
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Route {
    pub name: String,
    pub config: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(
        default,
        rename = "nativeModel",
        skip_serializing_if = "Option::is_none"
    )]
    pub native_model: Option<NativeModel>,
}

impl Route {
    pub(crate) fn validate(
        &self,
        launch: &crate::AgentLaunch,
        options: &crate::codex_context::Options,
    ) -> Result<(), String> {
        if !cfg!(unix)
            || launch.adapter != "codex"
            || launch.mode != "interactive"
            || launch.provider.is_some()
            || options.context.is_some()
            || options.image_mode != crate::codex_context::ImageMode::Native
            || !launch.extra_args.trim().is_empty()
            || !launch.env_refs.is_empty()
            || self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
            || self.config.len() > 48_000
            || self.native_model.as_ref().is_some_and(|model| {
                !model.valid()
                    || self.connection.as_deref().is_none_or(|name| {
                        name.is_empty()
                            || name.len() > 128
                            || !name
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                    })
            })
            || self
                .state
                .as_deref()
                .is_some_and(|id| !crate::valid_resume_id(id))
            || launch
                .prompt
                .as_ref()
                .is_some_and(|prompt| prompt.contains('\0') || prompt.len() > 48_000)
        {
            return Err("Invalid managed Codex routing launch".into());
        }
        Ok(())
    }
}

pub(super) fn route(launch: &crate::AgentLaunch) -> Option<&Route> {
    launch.codex.as_ref()?.route.as_ref()
}

fn stage(root: &Path) -> Result<PathBuf, String> {
    static STAGE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = STAGE
        .lock()
        .map_err(|_| "Cannot lock Codex routing runtime")?;
    let sources = [
        (
            "scripts/codex-auto-route.mjs",
            include_str!("../../../../scripts/codex-auto-route.mjs"),
        ),
        (
            "scripts/codex-route-app-server.mjs",
            include_str!("../../../../scripts/codex-route-app-server.mjs"),
        ),
        (
            "scripts/codex-native-routing.mjs",
            include_str!("../../../../scripts/codex-native-routing.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/control.mjs",
            include_str!("../pi/control.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/codex-route-config.mjs",
            include_str!("../pi/codex-route-config.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/task-rules.mjs",
            include_str!("../pi/task-rules.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/policy.mjs",
            include_str!("../pi/policy.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/failure.mjs",
            include_str!("../pi/failure.mjs"),
        ),
        (
            "apps/desktop/src-tauri/pi/agent-executor.mjs",
            include_str!("../pi/agent-executor.mjs"),
        ),
    ];
    let mut hash = Sha256::new();
    for (name, source) in sources {
        hash.update(name);
        hash.update([0]);
        hash.update(source);
        hash.update([0]);
    }
    let parent = root.join("codex-routing-runtime");
    crate::background::private_root(&parent)?;
    let directory = parent.join(format!("{:x}", hash.finalize()));
    for relative in [
        "",
        "scripts",
        "apps",
        "apps/desktop",
        "apps/desktop/src-tauri",
        "apps/desktop/src-tauri/pi",
    ] {
        crate::background::private_root(&directory.join(relative))?;
    }
    for (relative, source) in sources {
        let path = directory.join(relative);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let mut bytes = Vec::new();
                crate::background::private_file(&path, false)?
                    .take(source.len() as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read Codex routing runtime")?;
                if bytes != source.as_bytes() {
                    return Err("Codex routing runtime was modified".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut file = crate::background::private_file(&path, true)?;
                file.write_all(source.as_bytes())
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot stage Codex routing runtime")?;
            }
            Err(_) => return Err("Cannot inspect Codex routing runtime".into()),
        }
    }
    Ok(directory.join("scripts/codex-auto-route.mjs"))
}

pub(super) fn command(
    executable: &Path,
    launch: &crate::AgentLaunch,
    root: &Path,
) -> Result<CommandBuilder, String> {
    crate::codex_context::validate(launch)?;
    let route = route(launch).ok_or("Codex routing strategy is missing")?;
    let id = route
        .state
        .as_ref()
        .ok_or("Codex routing state is missing")?;
    let parent = root.join("codex-routing-sessions");
    crate::background::private_root(&parent)?;
    let entry = stage(root)?;
    let node = crate::node_runtime::prepare_cli(root)?;
    let mut builder = CommandBuilder::new(node);
    builder.arg(entry);
    builder.args(["--interactive", "--session"]);
    builder.arg(parent.join(id));
    builder.arg("--codex");
    builder.arg(executable);
    builder.env_remove("NODE_OPTIONS");
    builder.env_remove("NODE_PATH");
    builder.env("YAM_CODEX_ROUTE_CONFIG", &route.config);
    builder.env("YAM_CODEX_ROUTE_NAME", &route.name);
    builder.env(
        "YAM_CODEX_ROUTE_ENABLED",
        if route.enabled == Some(false) {
            "false"
        } else {
            "true"
        },
    );
    builder.env(
        "YAM_CODEX_ROUTE_CONNECTION",
        route.connection.as_deref().unwrap_or(""),
    );
    builder.env(
        "YAM_CODEX_ROUTE_NATIVE_MODEL",
        route
            .native_model
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "Invalid Codex native settings")?
            .unwrap_or_default(),
    );
    builder.env(
        "YAM_CODEX_ROUTE_PROMPT",
        launch.prompt.as_deref().unwrap_or(""),
    );
    Ok(builder)
}

pub(super) fn catalog(
    root: &Path,
    cwd: &Path,
    config: &str,
    probe: Option<&str>,
) -> Result<serde_json::Value, String> {
    use std::time::{Duration, Instant};
    if config.len() > 48_000
        || probe.is_some_and(|key| key.len() > 512 || key.chars().any(char::is_control))
    {
        return Err("Invalid Codex catalog request".into());
    }
    let executable = crate::find_executable("codex").ok_or("Codex executable unavailable")?;
    let entry = stage(root)?;
    let node = crate::node_runtime::prepare_cli(root)?;
    let directory = if cwd.is_dir() { cwd } else { root };
    if probe.is_some() && !cwd.is_dir() {
        return Err("Choose an existing project directory to verify a model".into());
    }
    let mut args = vec![
        entry.to_string_lossy().into_owned(),
        "--catalog".into(),
        "--codex".into(),
        executable.to_string_lossy().into_owned(),
    ];
    if let Some(model) = probe {
        args.extend(["--probe-model".into(), model.into()]);
    }
    let mut budget = crate::git_context::Budget {
        deadline: Instant::now() + Duration::from_secs(if probe.is_some() { 80 } else { 30 }),
        remaining: 2 * 1024 * 1024,
    };
    let output = budget
        .run_env(
            &node,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            directory,
            &[
                ("NODE_OPTIONS".into(), "".into()),
                ("NODE_PATH".into(), "".into()),
                ("YAM_CODEX_ROUTE_CONFIG".into(), config.into()),
                ("PATH".into(), crate::agent_path()),
            ],
        )
        .map_err(|_| "Codex catalog unavailable or timed out")?;
    if !output.status.success() {
        return Err("Codex catalog failed; check the selected connection and login".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "Invalid Codex catalog response")?;
    if value["models"]
        .as_array()
        .is_none_or(|models| models.len() > 1000)
    {
        return Err("Invalid Codex model catalog".into());
    }
    value["used_default_directory"] = (!cwd.is_dir()).into();
    Ok(value)
}

#[cfg(all(test, unix))]
#[test]
fn managed_codex_stages_reusable_runtime_and_refuses_modified_sources() {
    let root = std::env::temp_dir().join(crate::next_session_id());
    let entry = stage(&root).unwrap();
    assert_eq!(stage(&root).unwrap(), entry);
    let directory = entry.parent().unwrap().parent().unwrap();
    assert!(directory
        .join("apps/desktop/src-tauri/pi/codex-route-config.mjs")
        .is_file());
    assert!(entry.with_file_name("codex-route-app-server.mjs").is_file());
    assert!(entry.with_file_name("codex-native-routing.mjs").is_file());
    assert!(directory
        .join("apps/desktop/src-tauri/pi/control.mjs")
        .is_file());
    std::fs::write(&entry, b"modified").unwrap();
    assert!(stage(&root).unwrap_err().contains("modified"));
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(all(test, unix))]
#[test]
fn managed_history_requires_the_persisted_thread_and_owned_state() {
    let root = std::env::temp_dir().join(crate::next_session_id());
    let id = "11111111-1111-1111-1111-111111111111";
    let parent = root.join("codex-routing-sessions").join(id);
    crate::background::private_root(&parent).unwrap();
    let route = Route {
        name: "Native".into(),
        config: "{}".into(),
        state: Some(id.into()),
        enabled: None,
        connection: None,
        native_model: None,
    };
    let state = serde_json::json!({"v":2,"threadId":id,"connectionHome":"/private/home","provider":"openai"});
    let file = parent.join("state.json");
    crate::background::private_file(&file, true)
        .unwrap()
        .write_all(state.to_string().as_bytes())
        .unwrap();
    assert_eq!(
        conversation_home(&root, &route, id).unwrap(),
        (PathBuf::from("/private/home"), "openai".into())
    );
    let mut state = state;
    state["provider"] = serde_json::json!("yam_route");
    std::fs::write(&file, state.to_string()).unwrap();
    assert_eq!(
        conversation_home(&root, &route, id).unwrap(),
        (PathBuf::from("/private/home"), "yam_route".into())
    );
    assert!(conversation_home(&root, &route, "different").is_err());
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink("/tmp/missing-routing-state", &file).unwrap();
    assert!(conversation_home(&root, &route, id).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

pub(super) fn copy_route(root: &Path, route: &Route) -> Result<Option<Route>, String> {
    let fallback = || {
        if route.enabled == Some(false)
            && route
                .native_model
                .as_ref()
                .is_none_or(|model| !model.valid())
        {
            return Err("Current Codex native settings are unavailable; reopen the source session before copying".into());
        }
        Ok(Some(Route {
            state: None,
            ..route.clone()
        }))
    };
    let Some(id) = route.state.as_deref() else {
        return fallback();
    };
    if !crate::valid_resume_id(id) {
        return Err("Invalid Codex routing identity".into());
    }
    let path = root
        .join("codex-routing-sessions")
        .join(id)
        .join("state.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return fallback(),
        Err(_) => return Err("Cannot read current Codex routing strategy".into()),
        Ok(_) => {}
    }
    let state = read_route_state(root, route)?;
    if state["v"] == 1 {
        return fallback();
    }
    if state["v"] != 2 {
        return Err("Invalid Codex routing state".into());
    }
    if !state["connectionSwitch"].is_null() {
        return Err(
            "Reopen the source Codex session after its unconfirmed connection change".into(),
        );
    }
    match state["enabled"].as_bool() {
        Some(enabled) => {
            let name = state["name"]
                .as_str()
                .filter(|name| {
                    !name.trim().is_empty()
                        && name.chars().count() <= 80
                        && !name.chars().any(char::is_control)
                })
                .ok_or("Invalid current Codex routing name")?;
            if !state["config"].is_object() {
                return Err("Invalid current Codex routing configuration".into());
            }
            let config = state["config"].to_string();
            if config.len() > 48_000 {
                return Err("Invalid current Codex routing configuration".into());
            }
            let native_model = serde_json::from_value::<NativeModel>(state["nativeModel"].clone())
                .ok()
                .filter(NativeModel::valid);
            let connection = state["connectionName"]
                .as_str()
                .filter(|name| {
                    !name.is_empty()
                        && name.len() <= 128
                        && name
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                })
                .map(str::to_owned);
            let pin_current = !enabled || state["provider"] == "yam_route";
            let (connection, native_model) = match (pin_current, connection, native_model) {
                (true, Some(connection), Some(model)) => (Some(connection), Some(model)),
                _ if !enabled => return Err("Current Codex native settings are unavailable; reopen the source session before copying".into()),
                _ => (None, None),
            };
            Ok(Some(Route {
                name: name.into(),
                config,
                state: None,
                enabled: if enabled { None } else { Some(false) },
                native_model,
                connection,
            }))
        }
        None => Err("Invalid Codex routing state".into()),
    }
}

fn read_route_state(root: &Path, route: &Route) -> Result<serde_json::Value, String> {
    let id = route
        .state
        .as_deref()
        .filter(|id| crate::valid_resume_id(id))
        .ok_or("conversation_storage_unavailable")?;
    let path = root
        .join("codex-routing-sessions")
        .join(id)
        .join("state.json");
    let mut bytes = Vec::new();
    crate::background::private_file(&path, false)?
        .take(128001)
        .read_to_end(&mut bytes)
        .map_err(|_| "conversation_storage_unavailable")?;
    if bytes.len() > 128000 {
        return Err("conversation_storage_unavailable".into());
    }
    let state: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "conversation_storage_unavailable")?;
    Ok(state)
}

pub(super) fn conversation_home(
    root: &Path,
    route: &Route,
    thread: &str,
) -> Result<(PathBuf, String), String> {
    let state = read_route_state(root, route)?;
    if state["threadId"].as_str() != Some(thread) || state["v"] != 2 {
        return Err("conversation_identity_changed".into());
    }
    let home = state["connectionHome"]
        .as_str()
        .filter(|s| {
            Path::new(s).is_absolute() && s.len() <= 4096 && !s.chars().any(char::is_control)
        })
        .ok_or("conversation_storage_unavailable")?;
    let provider = state["provider"]
        .as_str()
        .filter(|s| matches!(*s, "openai" | "yam_api" | "yam_route"))
        .ok_or("conversation_storage_unavailable")?;
    Ok((PathBuf::from(home), provider.into()))
}

#[cfg(all(test, unix))]
#[test]
fn copying_native_routing_reads_effective_policy_and_off_without_identity() {
    let root = std::env::temp_dir().join(crate::next_session_id());
    let id = "11111111-1111-1111-1111-111111111111";
    let parent = root.join("codex-routing-sessions").join(id);
    crate::background::private_root(&parent).unwrap();
    let original = Route {
        name: "old".into(),
        config: "{}".into(),
        state: Some(id.into()),
        enabled: None,
        connection: None,
        native_model: None,
    };
    assert_eq!(copy_route(&root, &original).unwrap().unwrap().state, None);
    let file = parent.join("state.json");
    let state =
        serde_json::json!({"v":2,"enabled":true,"name":"changed","config":{"connections":{}}});
    crate::background::private_file(&file, true)
        .unwrap()
        .write_all(state.to_string().as_bytes())
        .unwrap();
    let copied = copy_route(&root, &original).unwrap().unwrap();
    assert_eq!(copied.name, "changed");
    assert_eq!(copied.config, "{\"connections\":{}}");
    assert_eq!(copied.state, None);
    std::fs::write(&file, br#"{"v":2,"enabled":false,"name":"changed","config":{"connections":{}},"connectionName":"native","nativeModel":{"model":"deepseek","effort":"high"}}"#).unwrap();
    let off = copy_route(&root, &original).unwrap().unwrap();
    assert_eq!(off.enabled, Some(false));
    assert_eq!(off.connection.as_deref(), Some("native"));
    std::fs::write(&file, br#"{"v":2,"enabled":true,"name":"changed","config":{"connections":{}},"provider":"yam_route","connectionName":"local","nativeModel":{"model":"auto/deepseek-flash","effort":"high"}}"#).unwrap();
    let mixed = copy_route(&root, &original).unwrap().unwrap();
    assert_eq!(mixed.connection.as_deref(), Some("local"));
    assert_eq!(mixed.native_model.unwrap().model, "auto/deepseek-flash");
    std::fs::write(&file, br#"{"v":2,"connectionSwitch":{"to":"local"}}"#).unwrap();
    assert!(copy_route(&root, &original).is_err());
    std::fs::write(&file, br#"{"v":2,"enabled":true,"config":"invalid"}"#).unwrap();
    assert!(copy_route(&root, &original).is_err());
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink("/tmp/missing-routing-state", &file).unwrap();
    assert!(copy_route(&root, &original).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(all(test, unix))]
#[test]
fn disabled_copy_preserves_observed_model_and_refuses_unknown_native_settings() {
    let root = std::env::temp_dir().join(crate::next_session_id());
    let id = "11111111-1111-1111-1111-111111111111";
    let parent = root.join("codex-routing-sessions").join(id);
    crate::background::private_root(&parent).unwrap();
    let original: Route =
        serde_json::from_value(serde_json::json!({"name":"old","config":"{}","state":id})).unwrap();
    let mut state = serde_json::json!({"v":2,"enabled":false,"name":"changed","config":{"connections":{}},"connectionName":"native","nativeModel":{"model":"vendor/deepseek:pro","effort":"high"}});
    let file = parent.join("state.json");
    crate::background::private_file(&file, true)
        .unwrap()
        .write_all(state.to_string().as_bytes())
        .unwrap();
    let copied = copy_route(&root, &original).unwrap().unwrap();
    let json = serde_json::to_value(&copied).unwrap();
    assert_eq!(json["nativeModel"], state["nativeModel"]);
    assert_eq!(serde_json::from_value::<Route>(json).unwrap(), copied);
    for unknown in [
        serde_json::Value::Null,
        serde_json::json!({"model":"deepseek","effort":"unknown"}),
        serde_json::json!({"model":"","effort":"high"}),
    ] {
        state["nativeModel"] = unknown;
        std::fs::write(&file, state.to_string()).unwrap();
        assert!(copy_route(&root, &original)
            .unwrap_err()
            .contains("native settings"));
    }
    state["enabled"] = true.into();
    std::fs::write(&file, state.to_string()).unwrap();
    assert!(copy_route(&root, &original).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(all(test, unix))]
#[test]
fn native_copy_launch_validates_the_model_snapshot() {
    let native = serde_json::json!({"model":"vendor/deepseek:pro","effort":"high"});
    for (settings, valid) in [
        (native, true),
        (
            serde_json::json!({"model":"bad\nmodel","effort":"high"}),
            false,
        ),
        (
            serde_json::json!({"model":"deepseek","effort":"unknown"}),
            false,
        ),
        (
            serde_json::json!({"model":"x".repeat(451),"effort":"high"}),
            false,
        ),
    ] {
        let launch: crate::AgentLaunch = serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","codex":{"image_mode":"native","route":{"name":"copy","config":"{}","enabled":false,"connection":"native","nativeModel":settings}}})).unwrap();
        assert_eq!(crate::codex_context::validate(&launch).is_ok(), valid);
    }
}
