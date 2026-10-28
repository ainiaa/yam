use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(crate) fn read_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let mut bytes = Vec::new();
    match std::fs::File::open(path) {
        Ok(file) => file
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read inherited Claude settings")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read inherited Claude settings".into()),
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Inherited Claude settings exceed their size limit".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Invalid inherited Claude settings: {}", path.display()))?;
    if !value.is_object() {
        return Err("Invalid inherited Claude settings".into());
    }
    Ok(Some(value))
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode inherited Claude settings")?;
    if std::fs::symlink_metadata(path).is_ok() {
        let mut current = Vec::new();
        crate::background::private_file(path, false)?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut current)
            .map_err(|_| "Cannot inspect managed Claude settings")?;
        if current == bytes {
            return Ok(());
        }
    }
    let temporary = path.with_extension(format!("yam-{}", crate::agent_bridge::credential()?));
    let result = (|| {
        let mut file = crate::background::private_file(&temporary, true)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot save inherited Claude settings")?;
        std::fs::rename(&temporary, path)
            .map_err(|_| "Cannot publish inherited Claude settings".into())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn share(source: &Path, target: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(target).is_ok() {
        if std::fs::read_link(target).ok().as_deref() == Some(source) {
            return Ok(());
        }
        return Err("Inherited Claude resource conflicts with an existing managed resource".into());
    }
    crate::codex_context::share_resource(source, target)
}

fn merge_settings(base: &mut serde_json::Value, current: &serde_json::Value) {
    match (base, current) {
        (serde_json::Value::Object(base), serde_json::Value::Object(current)) => {
            for (key, value) in current {
                if let Some(previous) = base.get_mut(key) {
                    merge_settings(previous, value);
                } else {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
        (serde_json::Value::Array(base), serde_json::Value::Array(current)) => {
            for value in current {
                if !base.contains(value) {
                    base.push(value.clone());
                }
            }
        }
        (base, current) => *base = current.clone(),
    }
}

fn refresh_settings(
    current: &mut serde_json::Value,
    previous: &serde_json::Value,
    upstream: &serde_json::Value,
) {
    let keys: std::collections::BTreeSet<_> = previous
        .as_object()
        .into_iter()
        .flat_map(|v| v.keys())
        .chain(upstream.as_object().into_iter().flat_map(|v| v.keys()))
        .cloned()
        .collect();
    for key in keys {
        let old = previous.get(&key);
        let new = upstream.get(&key);
        if old == new {
            continue;
        }
        if new.is_some_and(serde_json::Value::is_object)
            || (new.is_none()
                && old.is_some_and(serde_json::Value::is_object)
                && current.get(&key).is_some_and(serde_json::Value::is_object))
        {
            if !current.get(&key).is_some_and(serde_json::Value::is_object) {
                current[&key] = serde_json::json!({});
            }
            refresh_settings(
                &mut current[&key],
                old.unwrap_or(&serde_json::Value::Null),
                new.unwrap_or(&serde_json::Value::Null),
            );
            if new.is_none() && current[&key].as_object().is_some_and(|v| v.is_empty()) {
                current.as_object_mut().unwrap().remove(&key);
            }
        } else if let Some(value) = new {
            current[&key] = value.clone();
        } else {
            current.as_object_mut().unwrap().remove(&key);
        }
    }
}

fn connection_free_settings(mut settings: serde_json::Value) -> serde_json::Value {
    let table = settings.as_object_mut().unwrap();
    for key in [
        "apiKeyHelper",
        "forceLoginMethod",
        "forceLoginOrgUUID",
        "awsAuthRefresh",
        "awsCredentialExport",
    ] {
        table.remove(key);
    }
    if let Some(env) = table
        .get_mut("env")
        .and_then(serde_json::Value::as_object_mut)
    {
        env.retain(|name, _| !super::provider_launch::conflicting_env(name));
    }
    settings
}

pub(crate) fn inherit(
    root: &Path,
    home: &Path,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let marker = home.join("yam-native-settings.json");
    let previous = if std::fs::symlink_metadata(&marker).is_ok() {
        crate::background::private_file(&marker, false)?;
        let value = read_json(&marker)?.ok_or("Invalid Claude configuration marker")?;
        if value != serde_json::json!({"version":1})
            && !(value["version"] == 2
                && value["settings"].is_object()
                && value["state"].is_object())
        {
            return Err("Invalid Claude configuration snapshot marker".into());
        }
        if let Some(settings) = read_json(&home.join("settings.json"))? {
            crate::provider_launch::validate_claude_settings(
                &["--settings".into(), settings.to_string()],
                None,
            )?;
        }
        Some(value)
    } else {
        None
    };
    let explicit = lookup("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty());
    let Some(source) = explicit.as_ref().map(PathBuf::from).or_else(|| {
        lookup("HOME")
            .or_else(|| lookup("USERPROFILE"))
            .map(|value| PathBuf::from(value).join(".claude"))
    }) else {
        write_json(&marker, &serde_json::json!({"version":1}))?;
        return Ok(());
    };
    if !source.is_absolute() || source.starts_with(root.join("providers")) {
        return Err(
            "Inherited Claude configuration must use an absolute, non-managed directory".into(),
        );
    }
    if source.canonicalize().is_ok_and(|source| {
        root.canonicalize()
            .is_ok_and(|root| source.starts_with(root.join("providers")))
    }) {
        return Err("Cannot inherit another managed Claude directory".into());
    }
    let original_settings = connection_free_settings(
        read_json(&source.join("settings.json"))?.unwrap_or_else(|| serde_json::json!({})),
    );
    let mut settings =
        read_json(&home.join("settings.json"))?.unwrap_or_else(|| serde_json::json!({}));
    if let Some(previous) = previous.as_ref().filter(|v| v["version"] == 2) {
        refresh_settings(&mut settings, &previous["settings"], &original_settings);
    } else if previous.is_some() {
        // Version 1 did not retain an upstream baseline; keep a recoverable copy before adopting current defaults.
        if !home.join("yam-settings-v1.json").exists() {
            write_json(&home.join("yam-settings-v1.json"), &settings)?;
        }
        refresh_settings(&mut settings, &serde_json::Value::Null, &original_settings);
    } else {
        let current = settings;
        settings = original_settings.clone();
        merge_settings(&mut settings, &current);
    }
    let settings = connection_free_settings(settings);
    write_json(&home.join("settings.json"), &settings)?;
    let mut inherited_state = serde_json::json!({});
    for name in [
        "CLAUDE.md",
        "AGENTS.md",
        "skills",
        "agents",
        "hooks",
        "plugins",
        "rules",
        "output-styles",
        "commands",
        "workflows",
        "keybindings.json",
    ] {
        let path = source.join(name);
        if path.exists() {
            share(&path, &home.join(name))?;
        }
    }
    let state = if explicit.is_some() {
        source.join(".claude.json")
    } else {
        source
            .parent()
            .ok_or("Invalid Claude configuration directory")?
            .join(".claude.json")
    };
    if let Some(original) = read_json(&state)? {
        let path = home.join(".claude.json");
        let mut current = read_json(&path)?.unwrap_or_else(|| serde_json::json!({}));
        let mut inherited = serde_json::json!({});
        if let Some(mcp) = original.get("mcpServers") {
            inherited["mcpServers"] = mcp.clone();
        }
        if let Some(projects) = original["projects"].as_object() {
            for (project, settings) in projects {
                for field in [
                    "mcpServers",
                    "disabledMcpServers",
                    "enabledMcpServers",
                    "enabledMcpjsonServers",
                    "disabledMcpjsonServers",
                ] {
                    if let Some(value) = settings.get(field) {
                        inherited["projects"][project][field] = value.clone();
                    }
                }
            }
        }
        inherited_state = inherited.clone();
        if !inherited.as_object().unwrap().is_empty()
            || previous.as_ref().is_some_and(|v| v["version"] == 2)
        {
            // Copy capability fields only; native account, trust and transcript state stay private.
            if let Some(previous) = previous.as_ref().filter(|v| v["version"] == 2) {
                refresh_settings(&mut current, &previous["state"], &inherited);
            } else if previous.is_some() {
                refresh_settings(&mut current, &serde_json::Value::Null, &inherited);
            } else {
                let mut merged = inherited.clone();
                merge_settings(&mut merged, &current);
                current = merged;
            }
            write_json(&path, &current)?;
        }
    }
    if !state.exists() {
        if let Some(previous) = previous.as_ref().filter(|v| v["version"] == 2) {
            let path = home.join(".claude.json");
            if let Some(mut current) = read_json(&path)? {
                refresh_settings(&mut current, &previous["state"], &inherited_state);
                write_json(&path, &current)?;
            }
        }
    }
    if source.join("projects").is_dir() {
        for project in std::fs::read_dir(source.join("projects"))
            .map_err(|_| "Cannot inspect Claude memory")?
        {
            let project = project.map_err(|_| "Cannot inspect Claude memory")?;
            if project.path().join("memory").is_dir() {
                let target = home.join("projects").join(project.file_name());
                crate::background::private_root(&home.join("projects"))?;
                crate::background::private_root(&target)?;
                share(&project.path().join("memory"), &target.join("memory"))?;
            }
        }
    }
    write_json(
        &marker,
        &serde_json::json!({"version":2, "settings":original_settings, "state":inherited_state}),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "yam-claude-context-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(path.join("original")).unwrap();
            Self(path)
        }
        fn prepare(&self) -> Result<crate::provider_launch::Environment, String> {
            let launch = serde_json::from_value(json!({"adapter":"claude","mode":"interactive","extra_args":"","prompt":null,"provider":{"id":"custom","model":"sonnet","base_url":"https://example.com/anthropic","api_key_env":"TEST_KEY"}})).unwrap();
            crate::provider_launch::prepare(&self.0.join("yam"), &launch, &|name| match name {
                "TEST_KEY" => Some("synthetic-token".into()),
                "CLAUDE_CONFIG_DIR" => Some(self.0.join("original").to_string_lossy().into_owned()),
                _ => None,
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn repair_refresh_claude_v1_upgrade_retains_private_preferences_and_backup() {
        let f = Fixture::new();
        let original = f.0.join("original/settings.json");
        std::fs::write(&original, r#"{"effortLevel":"low"}"#).unwrap();
        let env = f.prepare().unwrap();
        let home = env.home.unwrap();
        super::write_json(
            &home.join("yam-native-settings.json"),
            &json!({"version":1}),
        )
        .unwrap();
        let private =
            json!({"effortLevel":"high","theme":"dark","permissions":{"deny":["Read(private)"]}});
        super::write_json(&home.join("settings.json"), &private).unwrap();
        std::fs::write(&original, r#"{"effortLevel":"max"}"#).unwrap();
        super::write_json(&home.join(".claude.json"), &json!({"mcpServers":{"svc":{"command":"old"}},"projects":{"p":{"hasTrustDialogAccepted":true}}})).unwrap();
        std::fs::write(
            f.0.join("original/.claude.json"),
            r#"{"mcpServers":{"svc":{"command":"new"}}}"#,
        )
        .unwrap();
        f.prepare().unwrap();
        let state = super::read_json(&home.join(".claude.json"))
            .unwrap()
            .unwrap();
        assert_eq!(state["mcpServers"]["svc"]["command"], "new");
        assert_eq!(state["projects"]["p"]["hasTrustDialogAccepted"], true);
        f.prepare().unwrap();
        assert_eq!(
            super::read_json(&home.join(".claude.json"))
                .unwrap()
                .unwrap()["mcpServers"]["svc"]["command"],
            "new"
        );
        let updated = super::read_json(&home.join("settings.json"))
            .unwrap()
            .unwrap();
        assert_eq!(updated["effortLevel"], "max");
        assert_eq!(updated["theme"], "dark");
        assert_eq!(updated["permissions"], private["permissions"]);
        assert_eq!(
            super::read_json(&home.join("yam-settings-v1.json"))
                .unwrap()
                .unwrap(),
            private
        );
        assert_eq!(
            super::read_json(&home.join("yam-native-settings.json"))
                .unwrap()
                .unwrap()["version"],
            2
        );
        let before = std::fs::read(home.join("settings.json")).unwrap();
        super::write_json(
            &home.join("yam-native-settings.json"),
            &json!({"version":9}),
        )
        .unwrap();
        assert!(f.prepare().is_err());
        assert_eq!(std::fs::read(home.join("settings.json")).unwrap(), before);
    }

    #[test]
    fn repair_refresh_claude_upstream_changes_preserve_native_state() {
        let f = Fixture::new();
        std::fs::write(
            f.0.join("original").join("settings.json"),
            r#"{"effortLevel":"low","language":"en","permissions":{"deny":["Read(secret)"]}}"#,
        )
        .unwrap();
        std::fs::write(
            f.0.join("original/.claude.json"),
            r#"{"projects":{"trusted":{"enabledMcpServers":["old"]}}}"#,
        )
        .unwrap();
        let first = f.prepare().unwrap();
        let home = first.home.unwrap();
        let mut private = super::read_json(&home.join("settings.json"))
            .unwrap()
            .unwrap();
        private["effortLevel"] = "high".into();
        private["theme"] = "dark".into();
        std::fs::write(home.join("settings.json"), private.to_string()).unwrap();
        super::write_json(&home.join(".claude.json"), &json!({"projects":{"trusted":{"hasTrustDialogAccepted":true,"enabledMcpServers":["old"]}},"customNativeState":true})).unwrap();
        std::fs::create_dir_all(home.join("projects/trusted")).unwrap();
        std::fs::write(home.join("projects/trusted/native-id.jsonl"), "history").unwrap();
        std::fs::write(
            f.0.join("original").join("settings.json"),
            r#"{"effortLevel":"low","language":"zh","permissions":{"deny":["Read(new-secret)"]}}"#,
        )
        .unwrap();
        std::fs::write(
            f.0.join("original/.claude.json"),
            r#"{"projects":{"trusted":{"enabledMcpServers":["new"]}}}"#,
        )
        .unwrap();
        f.prepare().unwrap();
        assert_eq!(
            super::read_json(&home.join(".claude.json"))
                .unwrap()
                .unwrap()["projects"]["trusted"]["enabledMcpServers"],
            json!(["new"])
        );
        std::fs::remove_file(f.0.join("original/.claude.json")).unwrap();
        f.prepare().unwrap();
        let state = super::read_json(&home.join(".claude.json"))
            .unwrap()
            .unwrap();
        assert_eq!(state["projects"]["trusted"]["hasTrustDialogAccepted"], true);
        assert!(state["projects"]["trusted"]
            .get("enabledMcpServers")
            .is_none());
        let updated = super::read_json(&home.join("settings.json"))
            .unwrap()
            .unwrap();
        assert_eq!(updated["language"], "zh");
        assert_eq!(updated["effortLevel"], "high");
        assert_eq!(updated["theme"], "dark");
        assert_eq!(
            updated["permissions"]["deny"],
            serde_json::json!(["Read(new-secret)"])
        );
        assert_eq!(
            super::read_json(&home.join(".claude.json"))
                .unwrap()
                .unwrap()["customNativeState"],
            true
        );
        assert_eq!(
            std::fs::read_to_string(home.join("projects/trusted/native-id.jsonl")).unwrap(),
            "history"
        );
        std::fs::write(
            f.0.join("original").join("settings.json"),
            r#"{"effortLevel":"xhigh"}"#,
        )
        .unwrap();
        f.prepare().unwrap();
        let updated = super::read_json(&home.join("settings.json"))
            .unwrap()
            .unwrap();
        assert_eq!(updated["effortLevel"], "xhigh");
        assert!(updated.get("language").is_none());
        assert_eq!(updated["theme"], "dark");
        let before = std::fs::read(home.join("settings.json")).unwrap();
        std::fs::write(f.0.join("original").join("settings.json"), "malformed").unwrap();
        assert!(f.prepare().is_err());
        assert_eq!(std::fs::read(home.join("settings.json")).unwrap(), before);
    }

    #[test]
    fn inherits_native_capabilities_without_account_or_transcripts() {
        let f = Fixture::new();
        let original = f.0.join("original");
        let settings = json!({"effortLevel":"high","permissions":{"deny":["Bash(rm *)"]},"hooks":{"Stop":[]},"enabledPlugins":{"fixture@market":true},"apiKeyHelper":"must-not-run","forceLoginMethod":"claudeai","env":{"ANTHROPIC_BASE_URL":"https://wrong.invalid","NORMAL_OPTION":"keep"}});
        std::fs::write(original.join("settings.json"), settings.to_string()).unwrap();
        for resource in [
            "CLAUDE.md",
            "skills/test/SKILL.md",
            "agents/reviewer.md",
            "hooks/check.sh",
            "plugins/installed_plugins.json",
            "rules/security.md",
            "output-styles/custom.md",
            "commands/check.md",
            "workflows/check.js",
            "projects/project/memory/MEMORY.md",
        ] {
            let path = original.join(resource);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, resource).unwrap();
        }
        std::fs::write(original.join(".credentials.json"), "do not inherit").unwrap();
        std::fs::write(
            original.join("projects/project/session.jsonl"),
            "private transcript",
        )
        .unwrap();
        std::fs::write(original.join(".claude.json"), json!({"oauthAccount":{"token":"do-not-copy"},"mcpServers":{"fixture":{"command":"fixture-mcp"}}}).to_string()).unwrap();
        let env = f.prepare().unwrap();
        let home = env.config_root("claude", &f.0, &original);
        assert!(
            home.join("settings.json").is_file(),
            "native user settings must survive the managed config directory"
        );
        let actual: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(actual["permissions"], settings["permissions"]);
        assert_eq!(actual["effortLevel"], "high");
        assert_eq!(actual["hooks"], settings["hooks"]);
        assert_eq!(actual["enabledPlugins"], settings["enabledPlugins"]);
        assert!(actual.get("apiKeyHelper").is_none());
        assert!(actual.get("forceLoginMethod").is_none());
        assert!(actual["env"].get("ANTHROPIC_BASE_URL").is_none());
        assert_eq!(actual["env"]["NORMAL_OPTION"], "keep");
        for resource in [
            "CLAUDE.md",
            "skills/test/SKILL.md",
            "agents/reviewer.md",
            "hooks/check.sh",
            "plugins/installed_plugins.json",
            "rules/security.md",
            "output-styles/custom.md",
            "commands/check.md",
            "workflows/check.js",
            "projects/project/memory/MEMORY.md",
        ] {
            assert_eq!(
                std::fs::read(home.join(resource)).unwrap(),
                std::fs::read(original.join(resource)).unwrap(),
                "{resource}"
            );
        }
        assert!(!home.join(".credentials.json").exists());
        assert!(!home.join("projects/project/session.jsonl").exists());
        let mcp: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["fixture"]["command"], "fixture-mcp");
        assert!(mcp.get("oauthAccount").is_none());
        assert_eq!(
            std::fs::read(original.join("settings.json")).unwrap(),
            settings.to_string().as_bytes()
        );
        std::fs::write(
            home.join("projects/project/new-session.jsonl"),
            "new history",
        )
        .unwrap();
        f.prepare()
            .expect("resume must retain the managed native history");
        assert_eq!(
            std::fs::read_to_string(home.join("projects/project/new-session.jsonl")).unwrap(),
            "new history"
        );
    }

    #[test]
    fn absent_optional_config_is_valid_but_malformed_settings_fail_closed() {
        let f = Fixture::new();
        assert!(f.prepare().is_ok());
        let broken = Fixture::new();
        std::fs::write(broken.0.join("original/settings.json"), "{broken").unwrap();
        assert!(
            broken.prepare().is_err(),
            "invalid policy must not silently disappear"
        );
    }

    #[test]
    fn oversized_and_non_object_settings_are_rejected() {
        let f = Fixture::new();
        for value in ["[]".to_string(), " ".repeat(2 * 1024 * 1024 + 1)] {
            std::fs::write(f.0.join("original/settings.json"), value).unwrap();
            assert!(f.prepare().is_err());
        }
    }

    #[test]
    fn changed_global_settings_refresh_without_replacing_native_history() {
        let f = Fixture::new();
        let original = f.0.join("original/settings.json");
        std::fs::write(&original, r#"{"effortLevel":"high"}"#).unwrap();
        let env = f.prepare().unwrap();
        let home = env.config_root("claude", &f.0, &f.0);
        std::fs::write(home.join("history.jsonl"), "native-state").unwrap();
        std::fs::write(&original, r#"{"effortLevel":"max"}"#).unwrap();
        f.prepare().unwrap();
        assert_eq!(
            super::read_json(&home.join("settings.json"))
                .unwrap()
                .unwrap()["effortLevel"],
            "max"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("history.jsonl")).unwrap(),
            "native-state"
        );
    }
    #[test]
    fn fidelity_claude_contexts_refresh_settings_on_resume_and_new_launches() {
        let f = Fixture::new();
        let source = f.0.join("original/settings.json");
        std::fs::write(&source, r#"{"effortLevel":"low"}"#).unwrap();
        let mut launch:crate::AgentLaunch=serde_json::from_value(json!({"adapter":"claude","mode":"interactive","extra_args":"","prompt":null,"provider":{"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}})).unwrap();
        crate::codex_context::assign_context(&mut launch).unwrap();
        assert!(
            serde_json::to_value(&launch).unwrap()["claude_context"].is_string(),
            "new managed Claude launches need a persisted config context"
        );
        let prepare = |launch: &crate::AgentLaunch| {
            crate::provider_launch::prepare(&f.0.join("yam"), launch, &|name| {
                (name == "CLAUDE_CONFIG_DIR")
                    .then(|| f.0.join("original").to_string_lossy().into_owned())
            })
            .unwrap()
        };
        let env = prepare(&launch);
        let home = env.config_root("claude", &f.0, &f.0);
        std::fs::write(
            home.join("settings.json"),
            r#"{"effortLevel":"xhigh","permissions":{"deny":["Bash(rm *)"]}}"#,
        )
        .unwrap();
        std::fs::write(home.join("history.jsonl"), "same history").unwrap();
        std::fs::write(&source, r#"{"effortLevel":"max"}"#).unwrap();
        prepare(&launch);
        assert_eq!(
            super::read_json(&home.join("settings.json"))
                .unwrap()
                .unwrap()["effortLevel"],
            "max"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("history.jsonl")).unwrap(),
            "same history"
        );
        let mut next = launch.clone();
        crate::codex_context::assign_context(&mut next).unwrap();
        let next_env = prepare(&next);
        let next_home = next_env.config_root("claude", &f.0, &f.0);
        assert_ne!(home, next_home);
        assert_eq!(
            super::read_json(&next_home.join("settings.json"))
                .unwrap()
                .unwrap()["effortLevel"],
            "max"
        );
        std::fs::write(
            home.join("settings.json"),
            r#"{"env":{"ANTHROPIC_UNIX_SOCKET":"/tmp/wrong.sock"}}"#,
        )
        .unwrap();
        assert!(crate::provider_launch::prepare(&f.0.join("yam"), &launch, &|_| None).is_err());
    }

    #[test]
    fn fidelity_claude_local_mcp_fields_are_inherited_without_project_trust_or_history() {
        let f = Fixture::new();
        let project = f.0.join("project");
        std::fs::create_dir(&project).unwrap();
        let key = project
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let source = json!({"projects":{key.clone():{"mcpServers":{"local":{"type":"stdio","command":"/usr/bin/false","args":[],"env":{}}},"disabledMcpServers":["blocked"],"enabledMcpServers":["allowed"],"enabledMcpjsonServers":["project"],"disabledMcpjsonServers":["disabled-project"],"hasTrustDialogAccepted":true,"history":["original transcript"]}},"oauthAccount":{"token":"must-not-copy"}});
        std::fs::write(f.0.join("original/.claude.json"), source.to_string()).unwrap();
        let env = f.prepare().unwrap();
        let home = env.config_root("claude", &f.0, &f.0);
        let current = super::read_json(&home.join(".claude.json"))
            .unwrap()
            .expect("local MCP must be inherited even without user-scope MCP");
        for field in [
            "mcpServers",
            "disabledMcpServers",
            "enabledMcpServers",
            "enabledMcpjsonServers",
            "disabledMcpjsonServers",
        ] {
            assert_eq!(
                current["projects"][&key][field], source["projects"][&key][field],
                "{field}"
            );
        }
        assert!(current["projects"][&key]
            .get("hasTrustDialogAccepted")
            .is_none());
        assert!(current["projects"][&key].get("history").is_none());
        assert!(current.get("oauthAccount").is_none());
    }
}
