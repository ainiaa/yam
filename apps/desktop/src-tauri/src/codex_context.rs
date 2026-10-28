// Author: Jeff.Liu.
use crate::provider_launch::ProviderConfig;
#[path = "codex_oauth.rs"]
mod oauth;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageMode {
    #[default]
    Native,
    GatewayApi,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Options {
    pub image_mode: ImageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

pub(crate) fn validate(launch: &crate::AgentLaunch) -> Result<(), String> {
    if launch.adapter == "claude"
        && launch.provider.is_some()
        && launch.claude_context.as_ref().is_some_and(|id| {
            !(32..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err("Invalid Claude configuration snapshot".into());
    }
    if let Some(options) = &launch.codex {
        if launch.adapter != "codex"
            || options.image_mode == ImageMode::GatewayApi && launch.provider.is_none()
        {
            return Err("Codex image options require the corresponding Codex connection".into());
        }
        if options.context.as_ref().is_some_and(|id| {
            !(32..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }) {
            return Err("Invalid Codex configuration snapshot".into());
        }
    }
    Ok(())
}
pub(crate) fn assign_context(launch: &mut crate::AgentLaunch) -> Result<(), String> {
    validate(launch)?;
    if launch.adapter == "claude" && launch.provider.is_some() {
        launch.claude_context = Some(crate::agent_bridge::credential()?);
    }
    if launch.adapter == "codex" && launch.provider.is_some() {
        let options = launch.codex.get_or_insert_with(Options::default);
        options.context = Some(crate::agent_bridge::credential()?);
    }
    Ok(())
}
fn home(root: &Path, launch: &crate::AgentLaunch) -> Result<PathBuf, String> {
    validate(launch)?;
    let id = launch
        .codex
        .as_ref()
        .and_then(|options| options.context.as_deref())
        .ok_or("Missing Codex configuration snapshot")?;
    Ok(root.join("providers/codex").join(format!("ctx-{id}")))
}
pub(crate) fn api_base(provider: &ProviderConfig) -> Result<String, String> {
    let base = provider.base_url.trim_end_matches('/');
    let url = tauri::Url::parse(base).map_err(|_| "Invalid provider endpoint")?;
    Ok(if url.path().is_empty() || url.path() == "/" {
        format!("{base}/v1")
    } else {
        base.into()
    })
}
fn connection(provider: &ProviderConfig) -> Result<BTreeMap<String, toml::Value>, String> {
    Ok(BTreeMap::from([
        ("model".into(), provider.model.clone().into()),
        ("model_provider".into(), "openai".into()),
        ("openai_base_url".into(), api_base(provider)?.into()),
        ("cli_auth_credentials_store".into(), "file".into()),
        ("mcp_oauth_credentials_store".into(), "file".into()),
        ("forced_login_method".into(), "api".into()),
    ]))
}
pub(crate) fn command_overrides(provider: &ProviderConfig) -> Result<Vec<String>, String> {
    let mut args = vec!["--no-daemon".into()];
    for (key, value) in connection(provider)? {
        args.extend(["-c".into(), format!("{key}={value}")]);
    }
    Ok(args)
}
fn overlay(
    value: &mut toml::Value,
    provider: &ProviderConfig,
    pin_model: bool,
) -> Result<(), String> {
    let table = value
        .as_table_mut()
        .ok_or("Codex configuration must be a TOML table")?;
    for (key, value) in connection(provider)? {
        if pin_model || key != "model" {
            table.insert(key, value);
        }
    }
    table.remove("forced_chatgpt_workspace_id");
    if let Some(profiles) = table
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
    {
        for (_, profile) in profiles.iter_mut() {
            overlay(profile, provider, false)?;
        }
    }
    Ok(())
}
fn legacy_overlay(
    value: &mut toml::Value,
    provider: &ProviderConfig,
    pin_model: bool,
    home: &Path,
) -> Result<(), String> {
    overlay(value, provider, pin_model)?;
    let table = value
        .as_table_mut()
        .ok_or("Invalid legacy Codex configuration")?;
    table.insert("model_provider".into(), "yam_api".into());
    table.insert(
        "sqlite_home".into(),
        home.to_string_lossy().into_owned().into(),
    );
    let providers = table
        .entry("model_providers")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("Invalid legacy Codex providers")?;
    providers.insert("yam_api".into(), toml::Value::try_from(serde_json::json!({"name":provider.id,"base_url":provider.base_url,"wire_api":"responses","env_key":"YAM_PROVIDER_API_KEY","requires_openai_auth":false,"supports_websockets":false})).map_err(|_| "Cannot encode legacy Codex connection")?);
    if let Some(profiles) = table
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
    {
        for (_, profile) in profiles {
            legacy_overlay(profile, provider, false, home)?;
        }
    }
    Ok(())
}

fn without_legacy_runtime(mut config: toml::Value) -> toml::Value {
    if let Some(set) = config
        .get_mut("shell_environment_policy")
        .and_then(|policy| policy.get_mut("set"))
        .and_then(toml::Value::as_table_mut)
    {
        set.retain(|key, _| !conflicting_env(key));
    }
    if let Some(profiles) = config
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
    {
        for (_, profile) in profiles {
            *profile = without_legacy_runtime(profile.clone());
        }
    }
    config
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| "Cannot read inherited Codex configuration")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Inherited Codex configuration exceeds 1 MiB".into());
    }
    Ok(bytes)
}
fn parse(bytes: &[u8]) -> Result<toml::Value, String> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| toml::from_str(text).ok())
        .ok_or_else(|| "Invalid inherited Codex TOML configuration".into())
}
fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = crate::background::private_file(path, true)?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect Codex snapshot")?
        .len()
        != 0
    {
        return Err("Codex snapshot already exists".into());
    }
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot write Codex snapshot".into())
}
fn replace_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok() && private_read(path)? == bytes {
        return Ok(());
    }
    let temporary = path.with_extension(format!("pending-{}", crate::agent_bridge::credential()?));
    let result = write(&temporary, bytes).and_then(|_| {
        std::fs::rename(&temporary, path)
            .map_err(|_| "Cannot update private Codex configuration".into())
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
fn private_read(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    crate::background::private_file(path, false)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read private Codex snapshot")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Invalid private Codex snapshot".into());
    }
    Ok(bytes)
}

// Keep installed package identities: parent-relative skill resources depend on the real directory.
pub(crate) fn share_resource(source: &Path, target: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(source).map_err(|_| "Inherited Codex resource is unavailable")?;
    if !meta.is_dir() && !meta.is_file() {
        return Err("Inherited Codex resource is not a regular file or directory".into());
    }
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(source, target);
    #[cfg(windows)]
    let result = if meta.is_dir() {
        std::os::windows::fs::symlink_dir(source, target)
    } else {
        std::os::windows::fs::symlink_file(source, target)
    };
    result.map_err(|_| {
        "Cannot reference installed Codex resources; symbolic-link support is required".into()
    })
}
fn resolve(base: &Path, text: &str) -> PathBuf {
    let expanded =
        if text == "~" || text.starts_with("~/") || cfg!(windows) && text.starts_with("~\\") {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(text.get(2..).unwrap_or("")))
        } else {
            None
        };
    let path = expanded.as_deref().unwrap_or_else(|| Path::new(text));
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    joined.components().collect()
}

fn relative_path(path: &Path, source: &Path) -> Option<PathBuf> {
    path.strip_prefix(source)
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            source
                .canonicalize()
                .ok()
                .and_then(|base| path.strip_prefix(base).ok().map(PathBuf::from))
        })
}
fn map_path(path: &Path, source: &Path, target: &Path) -> PathBuf {
    relative_path(path, source)
        .map(|relative| target.join(relative))
        .unwrap_or_else(|| path.to_path_buf())
}
fn hook_state_paths(config: &mut toml::Value, source: &Path, target: &Path) {
    if let Some(states) = config
        .get_mut("hooks")
        .and_then(|hooks| hooks.get_mut("state"))
        .and_then(toml::Value::as_table_mut)
    {
        let original = std::mem::take(states);
        for (key, value) in original {
            // Codex writes native absolute identities; older records may retain a file: prefix.
            let (scheme, path) = key
                .strip_prefix("file:")
                .map_or(("", key.as_str()), |path| ("file:", path));
            let mapped = [
                source.to_path_buf(),
                source
                    .canonicalize()
                    .unwrap_or_else(|_| source.to_path_buf()),
            ]
            .into_iter()
            .find_map(|base| {
                let prefix = format!("{}/", base.display());
                let (file, tail) = path.strip_prefix(&prefix)?.split_once(':')?;
                if (file == "config.toml" || file == "hooks.json" || file.ends_with(".config.toml"))
                    && Path::new(file).components().count() == 1
                {
                    Some(format!("{scheme}{}:{tail}", target.join(file).display()))
                } else {
                    None
                }
            })
            .unwrap_or(key);
            states.insert(mapped, value);
        }
    }
}

fn rebase(
    value: &mut toml::Value,
    base: &Path,
    source: &Path,
    target: &Path,
    stage: &Path,
    provider: &ProviderConfig,
    roles: &mut Vec<PathBuf>,
) -> Result<(), String> {
    match value {
        toml::Value::Table(table) => {
            for (key, value) in table {
                if key == "hooks" {
                    continue;
                }
                if key == "config_file" {
                    if let Some(text) = value.as_str() {
                        let role_source = resolve(base, text)
                            .canonicalize()
                            .map_err(|_| "Inherited Codex agent configuration is unavailable")?;
                        if roles.len() >= 32 || roles.contains(&role_source) {
                            return Err("Inherited Codex agent configuration contains a cycle or exceeds 32 files".into());
                        }
                        let mut role = parse(&read(&role_source)?)?;
                        if !target.join("yam-context.json").exists() {
                            oauth::inherit(&role, source, stage)?;
                        }
                        roles.push(role_source.clone());
                        rebase(
                            &mut role,
                            role_source.parent().unwrap(),
                            source,
                            target,
                            stage,
                            provider,
                            roles,
                        )?;
                        overlay(&mut role, provider, false)?;
                        private_runtime(&mut role, target);
                        hook_state_paths(&mut role, source, target);
                        roles.pop();
                        let directory = stage.join("yam-agent-configs");
                        crate::background::private_root(&directory)?;
                        use std::hash::{Hash, Hasher};
                        let mut hash = std::collections::hash_map::DefaultHasher::new();
                        role_source.hash(&mut hash);
                        let name = format!("{:016x}.toml", hash.finish());
                        let bytes = toml::to_string(&role)
                            .map_err(|_| "Cannot serialize inherited agent configuration")?;
                        if directory.join(&name).exists() {
                            if private_read(&directory.join(&name))? != bytes.as_bytes() {
                                return Err("Inherited agent path collision".into());
                            }
                        } else {
                            write(&directory.join(&name), bytes.as_bytes())?;
                        }
                        *value = target
                            .join("yam-agent-configs")
                            .join(name)
                            .to_string_lossy()
                            .into_owned()
                            .into();
                        continue;
                    }
                }
                if let Some(text) = value.as_str() {
                    if matches!(
                        key.as_str(),
                        "cwd"
                            | "path"
                            | "model_instructions_file"
                            | "experimental_instructions_file"
                            | "compact_prompt_file"
                            | "model_catalog_json"
                            | "model_catalog_json_file"
                    ) {
                        *value = resolve(base, text).to_string_lossy().into_owned().into();
                    } else if key == "CODEX_HOME"
                        && Path::new(text).is_absolute()
                        && relative_path(Path::new(text), source).is_some()
                    {
                        *value = map_path(Path::new(text), source, target)
                            .to_string_lossy()
                            .into_owned()
                            .into();
                    }
                } else {
                    rebase(value, base, source, target, stage, provider, roles)?;
                }
            }
        }
        toml::Value::Array(values) => {
            for value in values {
                rebase(value, base, source, target, stage, provider, roles)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn private_runtime(config: &mut toml::Value, target: &Path) {
    if let Some(table) = config.as_table_mut() {
        for name in ["log_dir", "sqlite_home"] {
            if table.contains_key(name) {
                table.insert(
                    name.into(),
                    target.join(name).to_string_lossy().into_owned().into(),
                );
            }
        }
    }
}

fn snapshot(
    source: &Path,
    stage: &Path,
    target: &Path,
    launch: &crate::AgentLaunch,
) -> Result<(), String> {
    let mut config = match std::fs::metadata(source.join("config.toml")) {
        Ok(_) => parse(&read(&source.join("config.toml"))?)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(Default::default())
        }
        _ => return Err("Cannot read inherited Codex config.toml".into()),
    };
    if source.exists() {
        for entry in std::fs::read_dir(source)
            .map_err(|_| "Cannot enumerate original Codex configuration")?
        {
            let entry = entry.map_err(|_| "Cannot inspect original Codex configuration")?;
            let name = entry.file_name();
            let text = name.to_string_lossy();
            // These are configuration resources, not Desktop history, databases, caches or authentication.
            if matches!(
                text.as_ref(),
                "skills"
                    | "plugins"
                    | "rules"
                    | "agents"
                    | "prompts"
                    | "commands"
                    | "hooks"
                    | "bin"
                    | "hooks.json"
                    | ".credentials.json"
                    | "AGENTS.md"
                    | "AGENTS.override.md"
            ) || text.ends_with(".md")
            {
                if text == ".credentials.json" {
                    // MCP refresh tokens remain private so refreshes cannot change Desktop's login state.
                    if !target.join("yam-context.json").exists() {
                        write(&stage.join(&name), &read(&entry.path())?)?;
                    }
                } else {
                    share_resource(&entry.path(), &stage.join(&name))?;
                }
            }
        }
    }
    let provider = launch
        .provider
        .as_ref()
        .ok_or("Missing provider connection")?;
    if !target.join("yam-context.json").exists() {
        oauth::inherit(&config, source, stage)?;
    }
    rebase(
        &mut config,
        source,
        source,
        target,
        stage,
        provider,
        &mut Vec::new(),
    )?;
    overlay(&mut config, provider, true)?;
    hook_state_paths(&mut config, source, target);
    // Explicit global runtime paths must remain private, while their non-connection settings survive.
    if let Some(table) = config.as_table_mut() {
        for name in ["log_dir", "sqlite_home"] {
            if table.contains_key(name) {
                table.insert(
                    name.into(),
                    target.join(name).to_string_lossy().into_owned().into(),
                );
            }
        }
    }
    if source.is_dir() {
        for entry in std::fs::read_dir(source).map_err(|_| "Cannot inspect Codex profiles")? {
            let entry = entry.map_err(|_| "Cannot inspect Codex profile")?;
            if !entry
                .file_name()
                .to_string_lossy()
                .ends_with(".config.toml")
            {
                continue;
            }
            let mut profile = parse(&read(&entry.path())?)?;
            if !target.join("yam-context.json").exists() {
                oauth::inherit(&profile, source, stage)?;
            }
            rebase(
                &mut profile,
                source,
                source,
                target,
                stage,
                provider,
                &mut Vec::new(),
            )?;
            overlay(&mut profile, provider, false)?;
            private_runtime(&mut profile, target);
            hook_state_paths(&mut profile, source, target);
            write(
                &stage.join(entry.file_name()),
                toml::to_string(&profile)
                    .map_err(|_| "Cannot serialize Codex profile")?
                    .as_bytes(),
            )?;
        }
    }
    let bytes =
        toml::to_string(&config).map_err(|_| "Cannot serialize inherited Codex configuration")?;
    write(&stage.join("config.toml"), bytes.as_bytes())?;
    write(&stage.join("yam-config.toml"), bytes.as_bytes())?;
    if launch
        .codex
        .as_ref()
        .is_none_or(|options| options.image_mode == ImageMode::GatewayApi)
    {
        // Codex prefers AGENTS.override.md when present; append to the effective original instructions.
        let path = if stage.join("AGENTS.override.md").is_file() {
            stage.join("AGENTS.override.md")
        } else {
            stage.join("AGENTS.md")
        };
        let mut instructions = match std::fs::read(&path) {
            Ok(instructions) => instructions,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && matches!(std::fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound) =>
            {
                Vec::new()
            }
            Err(_) => return Err("Cannot read inherited Codex instructions".into()),
        };
        if !instructions.is_empty() {
            instructions.extend_from_slice(b"\n\n");
        }
        instructions.extend_from_slice(crate::provider_launch::IMAGE_API_INSTRUCTIONS.as_bytes());
        if path.exists() {
            std::fs::remove_file(&path).map_err(|_| "Cannot prepare image API instructions")?;
        }
        write(&path, &instructions)?;
    }
    Ok(())
}

pub(crate) struct Prepared {
    directories: Vec<(PathBuf, (u64, u64))>,
    files: Vec<(PathBuf, crate::history::FileProof, Vec<u8>)>,
    baseline: toml::Value,
    pub(crate) legacy: bool,
}
fn without_ui(mut config: toml::Value) -> toml::Value {
    if let Some(table) = config.as_table_mut() {
        // Native CLI persists these preferences; connection and resource bindings stay guarded.
        for key in [
            "projects",
            "tui",
            "notice",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "web_search",
        ] {
            table.remove(key);
        }
        if let Some(hooks) = table.get_mut("hooks").and_then(toml::Value::as_table_mut) {
            hooks.remove("state");
            if hooks.is_empty() {
                table.remove("hooks");
            }
        }
    }
    config
}
impl Prepared {
    pub(crate) fn capture(
        root: &Path,
        home: &Path,
        launch: &crate::AgentLaunch,
    ) -> Result<Self, String> {
        let expected = serde_json::to_vec(&(launch.provider.as_ref(), launch.codex.as_ref()))
            .map_err(|_| "Invalid Codex connection")?;
        if private_read(&home.join("yam-context.json"))? != expected {
            return Err("Codex snapshot connection changed".into());
        }
        let legacy = launch.codex.is_none();
        if legacy {
            let instructions = if home.join("AGENTS.override.md").is_file() {
                home.join("AGENTS.override.md")
            } else {
                home.join("AGENTS.md")
            };
            if !private_read(&instructions)?
                .ends_with(crate::provider_launch::IMAGE_API_INSTRUCTIONS.as_bytes())
            {
                return Err("Legacy gateway instructions changed".into());
            }
        }
        if !legacy {
            let auth: serde_json::Value =
                serde_json::from_slice(&private_read(&home.join("auth.json"))?)
                    .map_err(|_| "Invalid private Codex authentication")?;
            if auth.as_object().is_none_or(|value| value.len() != 1)
                || auth["OPENAI_API_KEY"].as_str().is_none_or(|key| {
                    key.is_empty() || key.len() > 16384 || key.chars().any(char::is_control)
                })
            {
                return Err(
                    "Private Codex authentication must contain only the session API key".into(),
                );
            }
        } else if std::fs::symlink_metadata(home.join("auth.json")).is_ok() {
            return Err("Unexpected authentication in legacy Codex home".into());
        }
        let baseline = parse(&private_read(&home.join("yam-config.toml"))?)?;
        let mut pinned = baseline.clone();
        if legacy {
            legacy_overlay(
                &mut pinned,
                launch.provider.as_ref().ok_or("Missing provider")?,
                true,
                home,
            )?;
        } else {
            overlay(
                &mut pinned,
                launch.provider.as_ref().ok_or("Missing provider")?,
                true,
            )?;
        }

        if baseline != pinned {
            return Err("Codex snapshot route changed".into());
        }
        let directories = [
            root.to_path_buf(),
            root.join("providers"),
            root.join("providers/codex"),
            home.to_path_buf(),
        ]
        .into_iter()
        .map(|path| {
            Ok((
                path.clone(),
                crate::history::private_directory_identity(&path)?,
            ))
        })
        .collect::<Result<_, String>>()?;
        let mut paths = vec![
            home.join("config.toml"),
            home.join("yam-config.toml"),
            home.join("yam-context.json"),
        ];
        if !legacy {
            paths.push(home.join("auth.json"));
        }
        for name in ["AGENTS.md", "AGENTS.override.md"] {
            let path = home.join(name);
            if path.exists()
                && !std::fs::symlink_metadata(&path)
                    .map_err(|_| "Cannot inspect inherited Codex instructions")?
                    .file_type()
                    .is_symlink()
            {
                paths.push(path);
            }
        }
        for entry in std::fs::read_dir(home).map_err(|_| "Cannot inspect Codex profiles")? {
            let entry = entry.map_err(|_| "Cannot inspect Codex profile")?;
            if entry
                .file_name()
                .to_string_lossy()
                .ends_with(".config.toml")
            {
                paths.push(entry.path());
            }
        }
        for directory in ["yam-agent-configs", "yam-inherited"] {
            let roles = home.join(directory);
            if roles.exists() {
                for entry in
                    std::fs::read_dir(&roles).map_err(|_| "Cannot inspect inherited agents")?
                {
                    paths.push(entry.map_err(|_| "Cannot inspect inherited agents")?.path());
                }
            }
        }
        let files = paths
            .into_iter()
            .map(|path| {
                let file = crate::background::private_file(&path, false)?;
                Ok((
                    path.clone(),
                    crate::history::private_file_stamp(&file)?,
                    private_read(&path)?,
                ))
            })
            .collect::<Result<_, String>>()?;
        let prepared = Self {
            directories,
            files,
            baseline,
            legacy,
        };
        prepared.validate()?;
        Ok(prepared)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.legacy
            && self
                .directories
                .last()
                .is_some_and(|(home, _)| std::fs::symlink_metadata(home.join("auth.json")).is_ok())
        {
            return Err("Unexpected authentication in legacy Codex home".into());
        }
        for (path, identity) in &self.directories {
            if crate::history::private_directory_identity(path)? != *identity {
                return Err("Codex snapshot directory changed".into());
            }
        }
        for (path, identity, bytes) in &self.files {
            let file = crate::background::private_file(path, false)?;
            if !identity.same_identity(&crate::history::private_file_stamp(&file)?) {
                return Err("Codex snapshot file replaced".into());
            }
            let current = private_read(path)?;
            if path.file_name().is_some_and(|name| name == "config.toml")
                && self
                    .directories
                    .last()
                    .is_some_and(|(home, _)| path.parent() == Some(home.as_path()))
            {
                let actual = without_ui(parse(&current)?);
                let expected = without_ui(self.baseline.clone());
                let changed = if self.legacy {
                    without_legacy_runtime(actual) != without_legacy_runtime(expected)
                } else {
                    actual != expected
                };
                if changed {
                    return Err(
                        "Codex inherited configuration changed; restart with a new session".into(),
                    );
                }
            } else if current != *bytes {
                return Err("Codex snapshot changed before launch".into());
            }
        }
        Ok(())
    }
}
fn child_environment(
    config: &mut toml::Value,
    vars: &BTreeMap<String, String>,
) -> Result<(), String> {
    let table = config.as_table_mut().ok_or("Invalid Codex configuration")?;
    let policy = table
        .entry("shell_environment_policy")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("Invalid Codex shell environment policy")?;
    let overrides = policy
        .entry("set")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("Invalid Codex shell environment overrides")?;
    overrides.retain(|key, _| !conflicting_env(key));
    for (key, value) in vars {
        overrides.insert(key.clone(), value.clone().into());
    }
    // Native Codex applies include_only after explicit overrides; keep only the session connection exceptions.
    if let Some(include) = policy.get_mut("include_only") {
        let include = include
            .as_array_mut()
            .ok_or("Invalid Codex shell environment allowlist")?;
        if !include.is_empty() {
            for key in vars.keys() {
                if !include.iter().any(|v| v.as_str() == Some(key)) {
                    include.push(key.clone().into());
                }
            }
        }
    }
    if let Some(profiles) = table
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
    {
        for (_, profile) in profiles.iter_mut() {
            child_environment(profile, vars)?;
        }
    }
    Ok(())
}
fn snapshot_child_environment(stage: &Path, vars: &BTreeMap<String, String>) -> Result<(), String> {
    let mut paths = vec![stage.join("config.toml"), stage.join("yam-config.toml")];
    for dir in [stage.to_path_buf(), stage.join("yam-agent-configs")] {
        if !dir.exists() {
            continue;
        }
        for entry in
            std::fs::read_dir(&dir).map_err(|_| "Cannot inspect private Codex configurations")?
        {
            let path = entry
                .map_err(|_| "Cannot inspect private Codex configuration")?
                .path();
            if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".config.toml"))
                || dir != stage
            {
                paths.push(path);
            }
        }
    }
    for path in paths {
        let mut config = parse(&private_read(&path)?)?;
        let original = config.clone();
        child_environment(&mut config, vars)?;
        let bytes =
            toml::to_string(&config).map_err(|_| "Cannot serialize private Codex configuration")?;
        if original != config {
            let temporary =
                path.with_extension(format!("pending-{}", crate::agent_bridge::credential()?));
            let result = write(&temporary, bytes.as_bytes()).and_then(|_| {
                std::fs::rename(&temporary, &path)
                    .map_err(|_| "Cannot update private Codex configuration".into())
            });
            if result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            result?;
        }
    }
    Ok(())
}

fn share_legacy_resource(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth >= 32 {
        return Err("Legacy Codex resource merge exceeded its depth limit".into());
    }
    if std::fs::symlink_metadata(target).is_err() {
        return share_resource(source, target);
    }
    if source
        .canonicalize()
        .ok()
        .is_some_and(|source| target.canonicalize().ok().as_ref() == Some(&source))
    {
        return Ok(());
    }
    if source.is_dir()
        && target.is_dir()
        && !std::fs::symlink_metadata(target)
            .map_err(|_| "Cannot inspect legacy resource")?
            .file_type()
            .is_symlink()
    {
        for entry in std::fs::read_dir(source).map_err(|_| "Cannot enumerate legacy resources")? {
            let entry = entry.map_err(|_| "Cannot inspect legacy resource")?;
            share_legacy_resource(&entry.path(), &target.join(entry.file_name()), depth + 1)?;
        }
        return Ok(());
    }
    if source.is_file()
        && target.is_file()
        && source
            .metadata()
            .is_ok_and(|meta| meta.len() <= 1024 * 1024)
        && std::fs::read(source).ok() == std::fs::read(target).ok()
    {
        return Ok(());
    }
    Err(
        "Inherited Codex resource conflicts with a legacy resource; existing data was preserved"
            .into(),
    )
}

pub(crate) fn prepare_legacy(
    root: &Path,
    home: &Path,
    launch: &crate::AgentLaunch,
    vars: &BTreeMap<String, String>,
    lookup: &dyn Fn(&str) -> Option<String>,
    previous: Option<toml::Value>,
) -> Result<Prepared, String> {
    if let Some(previous) = previous {
        let stage = home.with_extension(format!("inherit-{}", crate::agent_bridge::credential()?));
        crate::background::private_root(&stage)?;
        let result = (|| -> Result<(), String> {
            let source = lookup("CODEX_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    lookup(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .map(|value| PathBuf::from(value).join(".codex"))
                })
                .unwrap_or_else(|| stage.join("unconfigured"));
            if !source.is_absolute()
                || source.starts_with(root.join("providers"))
                    && source != stage.join("unconfigured")
                || source.canonicalize().is_ok_and(|source| {
                    root.canonicalize()
                        .is_ok_and(|root| source.starts_with(root.join("providers")))
                })
            {
                return Err("Cannot inherit a relative or managed Codex configuration".into());
            }
            snapshot(&source, &stage, home, launch)?;
            for dir in [stage.clone(), stage.join("yam-agent-configs")] {
                if !dir.is_dir() {
                    continue;
                }
                for entry in
                    std::fs::read_dir(&dir).map_err(|_| "Cannot inspect legacy snapshot")?
                {
                    let path = entry.map_err(|_| "Cannot inspect legacy snapshot")?.path();
                    if path.extension().is_none_or(|extension| extension != "toml") {
                        continue;
                    }
                    let mut config = parse(&private_read(&path)?)?;
                    legacy_overlay(
                        &mut config,
                        launch.provider.as_ref().ok_or("Missing legacy provider")?,
                        dir == stage
                            && path.file_name().is_some_and(|name| {
                                name == "config.toml" || name == "yam-config.toml"
                            }),
                        home,
                    )?;
                    if path.parent() == Some(stage.as_path())
                        && path.file_name().is_some_and(|name| {
                            name == "config.toml"
                                || name.to_string_lossy().ends_with(".config.toml")
                        })
                    {
                        let directory = stage.join("yam-inherited");
                        crate::background::private_root(&directory)?;
                        let mut imported = config.clone();
                        child_environment(&mut imported, vars)?;
                        write(
                            &directory.join(path.file_name().unwrap()),
                            toml::to_string(&imported)
                                .map_err(|_| "Cannot encode inherited configuration baseline")?
                                .as_bytes(),
                        )?;
                    }
                    if path
                        .file_name()
                        .is_some_and(|name| name == "config.toml" || name == "yam-config.toml")
                    {
                        for key in ["projects", "tui", "notice"] {
                            if let Some(values) = previous.get(key).and_then(toml::Value::as_table)
                            {
                                config
                                    .as_table_mut()
                                    .unwrap()
                                    .entry(key)
                                    .or_insert_with(|| toml::Value::Table(Default::default()))
                                    .as_table_mut()
                                    .ok_or("Invalid legacy UI metadata")?
                                    .extend(values.clone());
                            }
                        }
                        if let Some(state) =
                            previous.get("hooks").and_then(|hooks| hooks.get("state"))
                        {
                            config
                                .as_table_mut()
                                .unwrap()
                                .entry("hooks")
                                .or_insert_with(|| toml::Value::Table(Default::default()))
                                .as_table_mut()
                                .ok_or("Invalid legacy hook metadata")?
                                .insert("state".into(), state.clone());
                        }
                    }
                    std::fs::remove_file(&path).map_err(|_| "Cannot prepare legacy connection")?;
                    write(
                        &path,
                        toml::to_string(&config)
                            .map_err(|_| "Cannot encode legacy configuration")?
                            .as_bytes(),
                    )?;
                }
            }
            snapshot_child_environment(&stage, vars)?;
            let context = serde_json::to_vec(&(launch.provider.as_ref(), launch.codex.as_ref()))
                .map_err(|_| "Invalid legacy connection")?;
            let marker = home.join("yam-context.json");
            if !marker.exists() {
                for entry in std::fs::read_dir(&stage)
                    .map_err(|_| "Cannot inspect legacy resource conflicts")?
                {
                    let entry = entry.map_err(|_| "Cannot inspect legacy resource conflict")?;
                    let name = entry.file_name();
                    let target = home.join(&name);
                    if !target.exists() || name == "config.toml" || name == "AGENTS.md" {
                        continue;
                    }
                    let metadata = std::fs::symlink_metadata(entry.path())
                        .map_err(|_| "Cannot inspect inherited resource")?;
                    if metadata.file_type().is_symlink() {
                        let original = std::fs::read_link(entry.path())
                            .map_err(|_| "Cannot resolve inherited resource")?;
                        share_legacy_resource(&original, &target, 0)?;
                    } else if !metadata.is_file()
                        || private_read(&target)? != private_read(&entry.path())?
                    {
                        return Err("Inherited Codex configuration conflicts with legacy data; existing data was preserved".into());
                    }
                }
            }
            if marker.exists() {
                if private_read(&marker)? != context {
                    return Err("Legacy Codex connection changed".into());
                }
            } else {
                write(&marker, &context)?;
            }
            for entry in std::fs::read_dir(&stage).map_err(|_| "Cannot publish legacy resources")? {
                let entry = entry.map_err(|_| "Cannot publish legacy resource")?;
                let name = entry.file_name();
                if name == "config.toml" || name == "yam-config.toml" {
                    continue;
                }
                let target = home.join(&name);
                let metadata = std::fs::symlink_metadata(entry.path())
                    .map_err(|_| "Cannot inspect staged legacy resource")?;
                if metadata.file_type().is_symlink() {
                    let original = std::fs::read_link(entry.path())
                        .map_err(|_| "Cannot resolve inherited resource")?;
                    if name == "AGENTS.md" && target.exists() {
                        std::fs::rename(entry.path(), &target)
                            .map_err(|_| "Cannot replace legacy instructions")?;
                        continue;
                    }
                    share_legacy_resource(&original, &target, 0)?;
                } else if (name == "yam-agent-configs" || name == "yam-inherited")
                    && target.exists()
                {
                    crate::background::private_root(&target)?;
                    for file in std::fs::read_dir(entry.path())
                        .map_err(|_| "Cannot publish legacy agent configurations")?
                    {
                        let file = file.map_err(|_| "Cannot publish legacy agent configuration")?;
                        std::fs::rename(file.path(), target.join(file.file_name()))
                            .map_err(|_| "Cannot publish legacy agent configuration")?;
                    }
                } else if target.exists() && name != "AGENTS.md" && name != "AGENTS.override.md" {
                    if private_read(&target)? != private_read(&entry.path())? {
                        return Err(
                            "Inherited Codex configuration conflicts with legacy data".into()
                        );
                    }
                } else {
                    std::fs::rename(entry.path(), target)
                        .map_err(|_| "Cannot publish legacy capability resource")?;
                }
            }
            // Commit configuration last; rollout files, databases and native IDs never move.
            for name in ["yam-config.toml", "config.toml"] {
                std::fs::rename(stage.join(name), home.join(name))
                    .map_err(|_| "Cannot publish inherited legacy configuration")?;
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&stage);
        result?;
    }
    Prepared::capture(root, home, launch)?;
    // Legacy environment references support key rotation; only managed child connection values change.
    snapshot_child_environment(home, vars)?;
    refresh_inherited(root, home, launch, vars, lookup)?;
    Prepared::capture(root, home, launch)
}

fn inherited_source(
    root: &Path,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<PathBuf>, String> {
    let source = lookup("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            lookup(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|v| PathBuf::from(v).join(".codex"))
        });
    if let Some(source) = &source {
        if !source.is_absolute()
            || source.starts_with(root.join("providers"))
            || source
                .canonicalize()
                .is_ok_and(|p| p.starts_with(root.join("providers")))
        {
            return Err("Cannot inherit a relative or managed Codex configuration".into());
        }
    }
    Ok(source)
}
fn inherited_config_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in
        std::fs::read_dir(directory).map_err(|_| "Cannot inspect inherited configurations")?
    {
        let path = entry
            .map_err(|_| "Cannot inspect inherited configuration")?
            .path();
        if path
            .file_name()
            .is_some_and(|v| v == "config.toml" || v.to_string_lossy().ends_with(".config.toml"))
        {
            files.push(path);
        }
    }
    Ok(files)
}
fn store_inherited_baseline(stage: &Path) -> Result<(), String> {
    let baseline = stage.join("yam-inherited");
    crate::background::private_root(&baseline)?;
    for path in inherited_config_files(stage)? {
        write(
            &baseline.join(path.file_name().unwrap()),
            &private_read(&path)?,
        )?;
    }
    Ok(())
}
fn refresh_table(current: &mut toml::Value, previous: &toml::Value, upstream: &toml::Value) {
    let keys: std::collections::BTreeSet<_> = previous
        .as_table()
        .into_iter()
        .flat_map(|v| v.keys())
        .chain(upstream.as_table().into_iter().flat_map(|v| v.keys()))
        .cloned()
        .collect();
    for key in keys {
        let old = previous.get(&key);
        let new = upstream.get(&key);
        if old == new {
            continue;
        }
        if new.is_some_and(toml::Value::is_table)
            || (new.is_none()
                && old.is_some_and(toml::Value::is_table)
                && current.get(&key).is_some_and(toml::Value::is_table))
        {
            let value = current
                .as_table_mut()
                .unwrap()
                .entry(key.clone())
                .or_insert_with(|| toml::Value::Table(Default::default()));
            if !value.is_table() {
                *value = toml::Value::Table(Default::default());
            }
            let empty = toml::Value::Table(Default::default());
            refresh_table(value, old.unwrap_or(&empty), new.unwrap_or(&empty));
            if new.is_none() && value.as_table().is_some_and(|v| v.is_empty()) {
                current.as_table_mut().unwrap().remove(&key);
            }
        } else if let Some(value) = new {
            current.as_table_mut().unwrap().insert(key, value.clone());
        } else {
            current.as_table_mut().unwrap().remove(&key);
        }
    }
}
fn refresh_inherited(
    root: &Path,
    home: &Path,
    launch: &crate::AgentLaunch,
    vars: &BTreeMap<String, String>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let Some(source) = inherited_source(root, lookup)? else {
        return Ok(());
    };
    let previous = Prepared::capture(root, home, launch)?;
    let baseline = home.join("yam-inherited");
    let previous_profiles =
        inherited_config_files(if baseline.exists() { &baseline } else { home })?;
    let stage = home.with_extension(format!("refresh-{}", crate::agent_bridge::credential()?));
    std::fs::create_dir(&stage).map_err(|_| "Cannot stage inherited Codex refresh")?;
    crate::background::private_root(&stage)?;
    let result = (|| {
        snapshot(&source, &stage, home, launch)?;
        if launch.codex.is_none() {
            let mut files = inherited_config_files(&stage)?;
            files.push(stage.join("yam-config.toml"));
            if stage.join("yam-agent-configs").is_dir() {
                files.extend(
                    std::fs::read_dir(stage.join("yam-agent-configs"))
                        .map_err(|_| "Cannot inspect inherited agents")?
                        .map(|e| e.map(|e| e.path()))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| "Cannot inspect inherited agents")?,
                );
            }
            for path in files {
                let mut config = parse(&private_read(&path)?)?;
                legacy_overlay(
                    &mut config,
                    launch.provider.as_ref().ok_or("Missing provider")?,
                    path.parent() == Some(stage.as_path())
                        && path
                            .file_name()
                            .is_some_and(|n| n == "config.toml" || n == "yam-config.toml"),
                    home,
                )?;
                replace_private(
                    &path,
                    toml::to_string(&config)
                        .map_err(|_| "Cannot encode inherited configuration")?
                        .as_bytes(),
                )?;
            }
        }
        snapshot_child_environment(&stage, vars)?;
        store_inherited_baseline(&stage)?;
        for path in inherited_config_files(&stage)? {
            let name = path.file_name().unwrap();
            let current_path = home.join(name);
            if !current_path.exists() {
                continue;
            }
            let old_path = home.join("yam-inherited").join(name);
            let mut old = if old_path.exists() {
                parse(&private_read(&old_path)?)?
            } else if name == "config.toml" {
                parse(&private_read(&home.join("yam-config.toml"))?)?
            } else {
                parse(&private_read(&current_path)?)?
            };
            if !old_path.exists() && launch.codex.is_none() && name == "config.toml" {
                for key in ["projects", "tui", "notice"] {
                    old.as_table_mut().unwrap().remove(key);
                }
                if let Some(hooks) = old.get_mut("hooks").and_then(toml::Value::as_table_mut) {
                    hooks.remove("state");
                }
            }
            let mut current = parse(&private_read(&current_path)?)?;
            let upstream = parse(&private_read(&path)?)?;
            refresh_table(&mut current, &old, &upstream);
            replace_private(
                &path,
                toml::to_string(&current)
                    .map_err(|_| "Cannot encode refreshed configuration")?
                    .as_bytes(),
            )?;
        }
        replace_private(
            &stage.join("yam-config.toml"),
            &private_read(&stage.join("config.toml"))?,
        )?;
        previous.validate()?;
        // Publish configuration only; session files, databases and private MCP credentials never move.
        for entry in
            std::fs::read_dir(&stage).map_err(|_| "Cannot publish configuration refresh")?
        {
            let entry = entry.map_err(|_| "Cannot publish configuration refresh")?;
            let name = entry.file_name();
            if name == "config.toml" || name == "yam-config.toml" {
                continue;
            }
            let target = home.join(&name);
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|_| "Cannot inspect staged configuration")?;
            if name == "yam-agent-configs" || name == "yam-inherited" {
                crate::background::private_root(&target)?;
                for file in
                    std::fs::read_dir(entry.path()).map_err(|_| "Cannot publish inherited files")?
                {
                    let file = file.map_err(|_| "Cannot inspect inherited file")?;
                    replace_private(&target.join(file.file_name()), &private_read(&file.path())?)?;
                }
            } else if name == "AGENTS.md" || name == "AGENTS.override.md" {
                let same = if metadata.file_type().is_symlink() {
                    std::fs::read_link(&target).ok() == std::fs::read_link(entry.path()).ok()
                } else {
                    private_read(&target).ok() == Some(private_read(&entry.path())?)
                };
                if !same {
                    std::fs::rename(entry.path(), &target)
                        .map_err(|_| "Cannot refresh inherited instructions")?;
                }
            } else if metadata.file_type().is_symlink() {
                share_legacy_resource(
                    &std::fs::read_link(entry.path())
                        .map_err(|_| "Cannot resolve inherited resource")?,
                    &target,
                    0,
                )?;
            } else if !target.exists() {
                std::fs::rename(entry.path(), &target)
                    .map_err(|_| "Cannot publish inherited configuration")?;
            } else if name.to_string_lossy().ends_with(".config.toml") {
                replace_private(&target, &private_read(&entry.path())?)?;
            }
        }
        for entry in previous_profiles {
            let name = entry.file_name().unwrap();
            if name != "config.toml" && !stage.join(name).exists() {
                let target = home.join(name);
                if target.exists() {
                    private_read(&target)?;
                    std::fs::remove_file(target)
                        .map_err(|_| "Cannot remove deleted inherited profile")?;
                }
                let path = baseline.join(name);
                if path.exists() {
                    std::fs::remove_file(path)
                        .map_err(|_| "Cannot update inherited profile baseline")?;
                }
            }
        }
        for name in ["yam-config.toml", "config.toml"] {
            replace_private(&home.join(name), &private_read(&stage.join(name))?)?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

pub(crate) fn prepare(
    root: &Path,
    launch: &crate::AgentLaunch,
    key: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(PathBuf, BTreeMap<String, String>, Prepared), String> {
    for path in [
        root.to_path_buf(),
        root.join("providers"),
        root.join("providers/codex"),
    ] {
        crate::background::private_root(&path)?;
    }
    let root = root
        .canonicalize()
        .map_err(|_| "Cannot resolve private Codex root")?;
    let home = home(&root, launch)?;
    let base = api_base(launch.provider.as_ref().ok_or("Missing provider")?)?;
    let vars = BTreeMap::from([
        ("CODEX_HOME".into(), home.to_string_lossy().into_owned()),
        ("OPENAI_BASE_URL".into(), base),
        ("OPENAI_API_KEY".into(), key.into()),
        ("CODEX_API_KEY".into(), key.into()),
        ("YAM_PROVIDER_API_KEY".into(), key.into()),
    ]);
    if std::fs::symlink_metadata(&home).is_err() {
        let source = lookup("CODEX_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                lookup(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(|s| PathBuf::from(s).join(".codex"))
            })
            .ok_or("Cannot locate original Codex configuration")?;
        if !source.is_absolute() {
            return Err("Original CODEX_HOME must be absolute".into());
        }
        if source.starts_with(root.join("providers")) {
            return Err("Cannot inherit another YAM managed Codex home".into());
        }
        let stage = home.with_extension("pending");
        std::fs::create_dir(&stage)
            .map_err(|_| "Incomplete Codex snapshot already exists; start a new session")?;
        crate::background::private_root(&stage)?;
        let result = (|| -> Result<(), String> {
            snapshot(&source, &stage, &home, launch)?;
            snapshot_child_environment(&stage, &vars)?;
            store_inherited_baseline(&stage)?;
            write(
                &stage.join("auth.json"),
                serde_json::to_vec(&serde_json::json!({"OPENAI_API_KEY":key}))
                    .unwrap()
                    .as_slice(),
            )?;
            write(
                &stage.join("yam-context.json"),
                &serde_json::to_vec(&(launch.provider.as_ref(), launch.codex.as_ref()))
                    .map_err(|_| "Invalid Codex connection")?,
            )?;
            std::fs::rename(&stage, &home)
                .map_err(|_| "Cannot publish Codex configuration snapshot".into())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&stage);
        }
        result?;
    }
    // Validate the old connection before replacing only its current credential and child aliases.
    Prepared::capture(&root, &home, launch)?;
    snapshot_child_environment(&home, &vars)?;
    let auth: serde_json::Value = serde_json::from_slice(&private_read(&home.join("auth.json"))?)
        .map_err(|_| "Invalid Codex session authentication")?;
    if auth["OPENAI_API_KEY"].as_str() != Some(key) {
        replace_private(
            &home.join("auth.json"),
            &serde_json::to_vec(&serde_json::json!({"OPENAI_API_KEY":key}))
                .map_err(|_| "Invalid Codex authentication")?,
        )?;
    }
    refresh_inherited(&root, &home, launch, &vars, lookup)?;
    let prepared = Prepared::capture(&root, &home, launch)?;
    Ok((home, vars, prepared))
}
pub(crate) fn existing_home(root: &Path, launch: &crate::AgentLaunch) -> Result<PathBuf, String> {
    let home = home(root, launch)?;
    Prepared::capture(root, &home, launch)?;
    home.canonicalize()
        .map_err(|_| "Codex snapshot is unavailable".into())
}
pub(crate) fn conflicting_env(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "CODEX_HOME"
            | "OPENAI_API_KEY"
            | "OPENAI_BASE_URL"
            | "CODEX_API_KEY"
            | "YAM_PROVIDER_API_KEY"
            | "OPENAI_ORG_ID"
            | "OPENAI_ORGANIZATION"
            | "OPENAI_PROJECT_ID"
            | "CODEX_ACCESS_TOKEN"
            | "CODEX_AUTH_TOKEN"
            | "CODEX_AUTH_URL"
            | "CODEX_LOGIN_URL"
            | "OPENAI_ACCESS_TOKEN"
    )
}

pub(crate) fn validate_project(launch: &crate::AgentLaunch, cwd: &Path) -> Result<(), String> {
    fn check(
        config: &toml::Value,
        base: &Path,
        provider: &ProviderConfig,
        legacy: bool,
        visited: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        if let Some(table) = config.as_table() {
            for (key, value) in table {
                let valid = match key.as_str() {
                    "model_provider" => {
                        value.as_str() == Some(if legacy { "yam_api" } else { "openai" })
                    }
                    "openai_base_url" => value.as_str().is_some_and(|url| {
                        url.trim_end_matches('/')
                            == api_base(provider).unwrap_or_default().trim_end_matches('/')
                    }),
                    "forced_login_method" => value.as_str() == Some("api"),
                    "cli_auth_credentials_store" | "mcp_oauth_credentials_store" => {
                        value.as_str() == Some("file")
                    }
                    "log_dir" | "sqlite_home" | "shell_environment_policy" => false,
                    "model_providers" => value
                        .get(if legacy { "yam_api" } else { "openai" })
                        .is_none_or(|selected| {
                            selected.as_table().is_some_and(|table| {
                                table.iter().all(|(key, value)| match key.as_str() {
                                    "base_url" => value.as_str().is_some_and(|url| {
                                        url.trim_end_matches('/')
                                            == if legacy {
                                                provider.base_url.trim_end_matches('/').to_string()
                                            } else {
                                                api_base(provider)
                                                    .unwrap_or_default()
                                                    .trim_end_matches('/')
                                                    .to_string()
                                            }
                                    }),
                                    "env_key" => {
                                        value.as_str()
                                            == Some(if legacy {
                                                "YAM_PROVIDER_API_KEY"
                                            } else {
                                                "OPENAI_API_KEY"
                                            })
                                    }
                                    "requires_openai_auth" => value.as_bool() == Some(!legacy),
                                    "wire_api" => value.as_str() == Some("responses"),
                                    "http_headers" | "env_http_headers" | "query_params" => {
                                        value.as_table().is_some_and(|table| table.is_empty())
                                    }
                                    "experimental_bearer_token" => false,
                                    _ => true,
                                })
                            })
                        }),
                    _ => true,
                };
                if !valid {
                    return Err("Project Codex configuration overrides the session connection; remove the conflicting connection setting before launching managed children".into());
                }
                if key == "config_file" {
                    let path = resolve(
                        base,
                        value
                            .as_str()
                            .ok_or("Invalid project Codex agent configuration")?,
                    )
                    .canonicalize()
                    .map_err(|_| "Project Codex agent configuration is unavailable")?;
                    if visited.len() >= 32 || visited.contains(&path) {
                        return Err("Project Codex agent configuration contains a cycle".into());
                    }
                    visited.push(path.clone());
                    check(
                        &parse(&read(&path)?)?,
                        path.parent().unwrap(),
                        provider,
                        legacy,
                        visited,
                    )?;
                    visited.pop();
                } else if key != "model_providers" {
                    check(value, base, provider, legacy, visited)?;
                }
            }
        }
        Ok(())
    }
    let provider = launch.provider.as_ref().ok_or("Missing provider")?;
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "Provider project directory is unavailable")?;
    let user_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok());
    for (depth, parent) in cwd.ancestors().enumerate() {
        if depth >= 64 {
            return Err("Project Codex configuration lookup exceeded 64 directories".into());
        }
        if user_home.as_deref() == Some(parent) {
            break;
        }
        let path = parent.join(".codex/config.toml");
        match std::fs::metadata(&path) {
            Ok(_) => check(
                &parse(&read(&path)?)?,
                path.parent().unwrap(),
                provider,
                launch.codex.is_none(),
                &mut Vec::new(),
            )?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect project Codex configuration".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        launch: crate::AgentLaunch,
    }
    impl Fixture {
        fn new(mode: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-inheritance-{}",
                crate::agent_bridge::credential().unwrap()
            ));
            let source = root.join("original");
            std::fs::create_dir_all(&source).unwrap();
            let launch = serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null,"provider":{"id":"codex","model":"main-selected","base_url":"http://127.0.0.1:3425","api_key_env":null},"codex":{"image_mode":mode,"context":"0123456789abcdef0123456789abcdef"}})).unwrap();
            Self {
                root,
                source,
                launch,
            }
        }
        fn prepare(&self) -> Result<crate::provider_launch::Environment, String> {
            crate::provider_launch::prepare(&self.root, &self.launch, &|name| {
                if name == "CODEX_HOME" {
                    Some(self.source.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn routing_review_private_replace_is_idempotent_and_refuses_links() {
        let f = Fixture::new("native");
        let path = f.root.join("private.toml");
        replace_private(&path, b"model_reasoning_effort='max'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let inode = std::fs::metadata(&path).unwrap().ino();
            replace_private(&path, b"model_reasoning_effort='max'\n").unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        }
        replace_private(&path, b"model_reasoning_effort='high'\n").unwrap();
        assert_eq!(
            private_read(&path).unwrap(),
            b"model_reasoning_effort='high'\n"
        );
        #[cfg(unix)]
        {
            let link = f.root.join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(replace_private(&link, b"wrong").is_err());
            assert_eq!(
                private_read(&path).unwrap(),
                b"model_reasoning_effort='high'\n"
            );
        }
    }
    #[test]
    fn routing_review_rebase_keeps_cwd_resources_and_reasoning_without_changing_unrelated_text() {
        let f = Fixture::new("native");
        let stage = f.root.join("stage");
        let mut value:toml::Value=toml::from_str("cwd='work'\nmodel_instructions_file='rules.md'\ncompact_prompt_file='summary.md'\nmodel_reasoning_effort='max'\nmodel='chosen'\n").unwrap();
        rebase(
            &mut value,
            &f.source,
            &f.source,
            &stage,
            &stage,
            f.launch.provider.as_ref().unwrap(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(value["cwd"].as_str(), f.source.join("work").to_str());
        assert_eq!(
            value["model_instructions_file"].as_str(),
            f.source.join("rules.md").to_str()
        );
        assert_eq!(
            value["compact_prompt_file"].as_str(),
            f.source.join("summary.md").to_str()
        );
        assert_eq!(value["model_reasoning_effort"].as_str(), Some("max"));
        assert_eq!(value["model"].as_str(), Some("chosen"));
    }
    #[test]
    fn repair_refresh_codex_old_context_removes_deleted_upstream_profiles() {
        for legacy in [false, true] {
            let mut f = Fixture::new("native");
            if legacy {
                f.launch.codex = None;
            }
            std::fs::write(f.source.join("review.config.toml"), "model='review'\n").unwrap();
            let home = f.prepare().unwrap().home.unwrap();
            std::fs::remove_dir_all(home.join("yam-inherited")).unwrap();
            std::fs::remove_file(f.source.join("review.config.toml")).unwrap();
            assert!(home.join("review.config.toml").is_file());
            f.prepare().unwrap();
            assert!(
                !home.join("review.config.toml").exists(),
                "old managed profile must follow upstream deletion"
            );
        }
    }

    #[test]
    fn repair_refresh_codex_global_config_profiles_and_instructions_without_history_loss() {
        for legacy in [false, true] {
            let mut f = Fixture::new("native");
            if legacy {
                f.launch.codex = None;
            }
            std::fs::write(
                f.source.join("config.toml"),
                "model_reasoning_effort='low'\nweb_search='disabled'\n",
            )
            .unwrap();
            std::fs::write(f.source.join("review.config.toml"), "model='review-old'\n").unwrap();
            std::fs::write(f.source.join("AGENTS.md"), "instructions-old").unwrap();
            let env = f.prepare().unwrap();
            let home = env.home.unwrap();
            std::fs::create_dir_all(home.join("sessions")).unwrap();
            std::fs::write(home.join("sessions/native-id.jsonl"), "history").unwrap();
            let mut config = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
            config
                .as_table_mut()
                .unwrap()
                .insert("model_reasoning_effort".into(), "high".into());
            std::fs::write(home.join("config.toml"), toml::to_string(&config).unwrap()).unwrap();
            std::fs::write(
                f.source.join("config.toml"),
                "model_reasoning_effort='low'\nweb_search='live'\n[features]\nmulti_agent=true\n",
            )
            .unwrap();
            std::fs::write(f.source.join("review.config.toml"), "model='review-new'\n").unwrap();
            std::fs::write(f.source.join("AGENTS.md"), "instructions-new").unwrap();
            let refreshed = f
                .prepare()
                .expect("upstream configuration must refresh in the same context");
            assert_eq!(refreshed.home.as_ref(), Some(&home));
            assert!(refreshed.validate_before_spawn().is_ok());
            let actual = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
            assert_eq!(actual["web_search"].as_str(), Some("live"));
            assert_eq!(actual["model_reasoning_effort"].as_str(), Some("high"));
            assert_eq!(actual["features"]["multi_agent"].as_bool(), Some(true));
            assert_eq!(
                parse(&private_read(&home.join("review.config.toml")).unwrap()).unwrap()["model"]
                    .as_str(),
                Some("review-new")
            );
            assert!(std::fs::read_to_string(home.join("AGENTS.md"))
                .unwrap()
                .starts_with("instructions-new"));
            assert_eq!(
                std::fs::read_to_string(home.join("sessions/native-id.jsonl")).unwrap(),
                "history"
            );
            let unchanged = f.prepare().unwrap();
            assert!(
                refreshed.validate_before_spawn().is_ok(),
                "unchanged input must not replace pinned configuration files"
            );
            assert!(unchanged.validate_before_spawn().is_ok());
            std::fs::write(
                f.source.join("config.toml"),
                "model_reasoning_effort='xhigh'\n",
            )
            .unwrap();
            std::fs::remove_file(f.source.join("review.config.toml")).unwrap();
            f.prepare().unwrap();
            let actual = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
            assert_eq!(actual["model_reasoning_effort"].as_str(), Some("xhigh"));
            assert!(actual.get("web_search").is_none());
            assert!(!home.join("review.config.toml").exists());
            let before = private_read(&home.join("config.toml")).unwrap();
            std::fs::write(f.source.join("config.toml"), "malformed = [").unwrap();
            assert!(f.prepare().is_err());
            assert_eq!(private_read(&home.join("config.toml")).unwrap(), before);
        }
    }

    #[test]
    fn repair_rotation_preserves_native_home_history_and_preferences() {
        let mut f = Fixture::new("native");
        f.launch.provider.as_mut().unwrap().api_key_env = Some("ROTATION_API_KEY".into());
        std::fs::write(f.source.join("auth.json"), br#"{"account":"unchanged"}"#).unwrap();
        let prepare = |key: &str| {
            crate::provider_launch::prepare(&f.root, &f.launch, &|name| match name {
                "CODEX_HOME" => Some(f.source.to_string_lossy().into_owned()),
                "ROTATION_API_KEY" => Some(key.into()),
                _ => None,
            })
        };
        let first = prepare("old-key").unwrap();
        let home = first.home.clone().unwrap();
        std::fs::create_dir(home.join("sessions")).unwrap();
        std::fs::write(home.join("sessions/native-id.jsonl"), "native history").unwrap();
        let mut config = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
        config
            .as_table_mut()
            .unwrap()
            .insert("model_reasoning_effort".into(), "high".into());
        std::fs::write(home.join("config.toml"), toml::to_string(&config).unwrap()).unwrap();
        let next =
            prepare("new-key").expect("rotated gateway key must resume the original context");
        assert_eq!(next.home.as_ref(), Some(&home));
        assert!(next.validate_before_spawn().is_ok());
        assert!(
            first.validate_before_spawn().is_err(),
            "prepared credentials cannot silently become stale"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/native-id.jsonl")).unwrap(),
            "native history"
        );
        let auth: serde_json::Value =
            serde_json::from_slice(&private_read(&home.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth, serde_json::json!({"OPENAI_API_KEY":"new-key"}));
        let config = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
        for name in ["OPENAI_API_KEY", "CODEX_API_KEY", "YAM_PROVIDER_API_KEY"] {
            assert_eq!(
                config["shell_environment_policy"]["set"][name].as_str(),
                Some("new-key")
            );
            assert_eq!(next.vars[name], "new-key");
        }
        assert_eq!(
            std::fs::read(f.source.join("auth.json")).unwrap(),
            br#"{"account":"unchanged"}"#
        );
        assert!(prepare("").is_err());
        assert!(prepare("bad\nkey").is_err());
        config_tamper(&home);
        assert!(
            prepare("third-key").is_err(),
            "rotation cannot repair a tampered route"
        );
        fn config_tamper(home: &Path) {
            let mut config = parse(&private_read(&home.join("config.toml")).unwrap()).unwrap();
            config["model_provider"] = "untrusted".into();
            std::fs::write(home.join("config.toml"), toml::to_string(&config).unwrap()).unwrap();
        }
    }

    #[test]
    #[cfg(unix)]
    fn shared_skill_checkout_keeps_real_directory_and_parent_dependencies_live() {
        let fixture = Fixture::new("native");
        let package = fixture.root.join("skill-package");
        let skill = package.join("skills/example");
        for dir in [
            &skill,
            &package.join("scripts"),
            &package.join("docs"),
            &fixture.source.join("skills"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            skill.join("SKILL.md"),
            "Read ../../docs/standard.md and ../../scripts/impact.py",
        )
        .unwrap();
        std::fs::write(package.join("docs/standard.md"), "standard").unwrap();
        std::fs::write(package.join("scripts/impact.py"), "print('shared')").unwrap();
        std::os::unix::fs::symlink(&skill, fixture.source.join("skills/example")).unwrap();
        std::fs::write(
            fixture.source.join("config.toml"),
            "model_instructions_file = 'skills/example/../../docs/standard.md'\n",
        )
        .unwrap();
        let env = fixture.prepare().unwrap();
        let config =
            parse(&read(&env.home.as_ref().unwrap().join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(config["model_instructions_file"].as_str().unwrap()).unwrap(),
            "standard"
        );
        let path = env.home.as_ref().unwrap().join("skills/example");
        assert_eq!(path.canonicalize().unwrap(), skill.canonicalize().unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("../../docs/standard.md")).unwrap(),
            "standard"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("../../scripts/impact.py")).unwrap(),
            "print('shared')"
        );
        std::fs::write(skill.join("SKILL.md"), "updated installed skill").unwrap();
        assert_eq!(
            std::fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "updated installed skill"
        );
        env.validate_before_spawn().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn shared_resources_keep_identity_while_connection_auth_and_runtime_stay_private() {
        let fixture = Fixture::new("native");
        let original = "model = 'desktop-model'\nmodel_instructions_file = 'instructions.txt'\n";
        std::fs::write(fixture.source.join("config.toml"), original).unwrap();
        std::fs::write(fixture.source.join("auth.json"), "desktop-auth-sentinel").unwrap();
        std::fs::write(
            fixture.source.join("instructions.txt"),
            "original instructions",
        )
        .unwrap();
        std::fs::write(fixture.source.join("AGENTS.md"), "original agent policy").unwrap();
        for name in [
            "skills", "plugins", "rules", "agents", "prompts", "commands", "hooks", "bin",
        ] {
            std::fs::create_dir(fixture.source.join(name)).unwrap();
            std::fs::write(fixture.source.join(name).join("marker"), name).unwrap();
        }
        let env = fixture.prepare().unwrap();
        let home = env.home.as_ref().unwrap();
        for name in [
            "skills",
            "plugins",
            "rules",
            "agents",
            "prompts",
            "commands",
            "hooks",
            "bin",
            "AGENTS.md",
        ] {
            assert_eq!(
                home.join(name).canonicalize().unwrap(),
                fixture.source.join(name).canonicalize().unwrap(),
                "{name} was copied"
            );
        }
        let config = parse(&read(&home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            config["model_instructions_file"].as_str(),
            fixture.source.join("instructions.txt").to_str()
        );
        std::fs::write(
            fixture.source.join("instructions.txt"),
            "changed installed instructions",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(config["model_instructions_file"].as_str().unwrap()).unwrap(),
            "changed installed instructions"
        );
        assert!(!std::fs::symlink_metadata(home.join("auth.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!std::fs::symlink_metadata(home.join("config.toml"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("config.toml")).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("auth.json")).unwrap(),
            "desktop-auth-sentinel"
        );
        std::fs::write(fixture.source.join("AGENTS.md"), "updated shared policy").unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "updated shared policy"
        );
        env.validate_before_spawn().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn failed_private_configuration_cleanup_never_removes_shared_source_resources() {
        let fixture = Fixture::new("native");
        std::fs::create_dir_all(fixture.source.join("skills/example")).unwrap();
        let skill = fixture.source.join("skills/example/SKILL.md");
        std::fs::write(&skill, "source must survive").unwrap();
        std::fs::write(fixture.source.join("broken.config.toml"), "invalid = [").unwrap();
        assert!(fixture.prepare().is_err());
        assert_eq!(
            std::fs::read_to_string(&skill).unwrap(),
            "source must survive"
        );
        assert!(!home(&fixture.root, &fixture.launch).unwrap().exists());
        assert!(!home(&fixture.root, &fixture.launch)
            .unwrap()
            .with_extension("pending")
            .exists());
    }

    #[test]
    #[cfg(unix)]
    fn gateway_instruction_read_errors_refuse_instead_of_discarding_inherited_policy() {
        let fixture = Fixture::new("gateway_api");
        let instructions = fixture.source.join("AGENTS.md");
        std::fs::create_dir(&instructions).unwrap();
        std::fs::write(instructions.join("preserved"), "source must remain intact").unwrap();
        assert!(
            fixture
                .prepare()
                .err()
                .is_some_and(|error| error == "Cannot read inherited Codex instructions"),
            "an unreadable original must not become gateway-only instructions"
        );
        assert_eq!(
            std::fs::read_to_string(instructions.join("preserved")).unwrap(),
            "source must remain intact"
        );
        let home = home(&fixture.root, &fixture.launch).unwrap();
        assert!(!home.exists());
        assert!(!home.with_extension("pending").exists());
    }

    #[test]
    fn child_environment_survives_native_filtering_in_main_profiles_and_roles() {
        let fixture = Fixture::new("native");
        let policy = "[shell_environment_policy]\ninherit='core'\nexclude=['OPENAI*']\ninclude_only=['PATH']\n[shell_environment_policy.set]\nOPENAI_API_KEY='wrong-global-key'\nKEEP='preserved'\n";
        let original = format!("[agents.reviewer]\nconfig_file='reviewer.toml'\n{policy}\n[profiles.work.shell_environment_policy]\ninherit='none'\ninclude_only=['PATH']\n");
        std::fs::write(fixture.source.join("config.toml"), &original).unwrap();
        std::fs::write(fixture.source.join("reviewer.toml"), policy).unwrap();
        std::fs::write(fixture.source.join("work.config.toml"), policy).unwrap();
        let env = fixture.prepare().unwrap();
        let home = env.home.unwrap();
        let config = parse(&read(&home.join("config.toml")).unwrap()).unwrap();
        let role = Path::new(
            config["agents"]["reviewer"]["config_file"]
                .as_str()
                .unwrap(),
        );
        for config in [
            config.clone(),
            config["profiles"]["work"].clone(),
            parse(&read(role).unwrap()).unwrap(),
            parse(&read(&home.join("work.config.toml")).unwrap()).unwrap(),
        ] {
            let policy = &config["shell_environment_policy"];
            assert!(matches!(policy["inherit"].as_str(), Some("core" | "none")));
            for key in [
                "CODEX_HOME",
                "OPENAI_BASE_URL",
                "OPENAI_API_KEY",
                "CODEX_API_KEY",
                "YAM_PROVIDER_API_KEY",
            ] {
                assert!(policy["include_only"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v.as_str() == Some(key)));
                assert!(policy["set"][key].as_str().is_some());
            }
            assert_eq!(policy["set"]["CODEX_HOME"].as_str(), home.to_str());
            assert_eq!(
                policy["set"]["OPENAI_API_KEY"].as_str(),
                Some("yam-local-gateway")
            );
        }
        assert_eq!(
            config["shell_environment_policy"]["set"]["KEEP"].as_str(),
            Some("preserved")
        );
        assert_eq!(
            config["shell_environment_policy"]["exclude"][0].as_str(),
            Some("OPENAI*")
        );
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("config.toml")).unwrap(),
            original
        );
    }

    #[test]
    fn invalid_child_environment_policies_fail_atomically_and_stale_snapshots_fail_closed() {
        for policy in [
            "shell_environment_policy=[]",
            "[shell_environment_policy]\nset=[]",
            "[shell_environment_policy]\ninclude_only='PATH'",
        ] {
            let fixture = Fixture::new("native");
            std::fs::write(fixture.source.join("config.toml"), policy).unwrap();
            assert!(fixture.prepare().is_err());
            assert!(!home(&fixture.root, &fixture.launch).unwrap().exists());
        }
        let fixture = Fixture::new("native");
        let env = fixture.prepare().unwrap();
        let path = env.home.unwrap().join("config.toml");
        let mut config = parse(&read(&path).unwrap()).unwrap();
        config
            .as_table_mut()
            .unwrap()
            .remove("shell_environment_policy");
        std::fs::write(path, toml::to_string(&config).unwrap()).unwrap();
        assert!(fixture.prepare().err().unwrap().contains("new session"));
    }

    #[test]
    fn image_modes_preserve_original_effective_instructions() {
        for mode in ["native", "gateway_api"] {
            let fixture = Fixture::new(mode);
            std::fs::write(fixture.source.join("AGENTS.md"), "normal instructions").unwrap();
            std::fs::write(
                fixture.source.join("AGENTS.override.md"),
                "override instructions",
            )
            .unwrap();
            let env = fixture.prepare().unwrap();
            let home = env.home.unwrap();
            assert_eq!(
                std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
                "normal instructions"
            );
            let instructions = std::fs::read_to_string(home.join("AGENTS.override.md")).unwrap();
            assert!(instructions.starts_with("override instructions"));
            assert_eq!(
                instructions.contains("YAM session image API route"),
                mode == "gateway_api"
            );
            assert_eq!(
                std::fs::read_to_string(fixture.source.join("AGENTS.override.md")).unwrap(),
                "override instructions"
            );
        }
    }
    #[test]
    fn fidelity_codex_native_reasoning_preferences_survive_resume_without_route_changes() {
        let fixture = Fixture::new("native");
        let env = fixture.prepare().unwrap();
        let home = env.home.as_ref().unwrap();
        let path = home.join("config.toml");
        let mut config = parse(&std::fs::read(&path).unwrap()).unwrap();
        for (key, value) in [
            ("model_reasoning_effort", "xhigh"),
            ("model_reasoning_summary", "detailed"),
            ("web_search", "live"),
        ] {
            config
                .as_table_mut()
                .unwrap()
                .insert(key.into(), value.into());
        }
        std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
        let resumed = fixture
            .prepare()
            .expect("native reasoning preference edits must survive restore");
        resumed.validate_before_spawn().unwrap();
        let actual = parse(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(actual["model_reasoning_effort"].as_str(), Some("xhigh"));
        assert_eq!(actual["web_search"].as_str(), Some("live"));
        config["openai_base_url"] = "https://wrong.invalid".into();
        std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
        assert!(fixture.prepare().is_err());
    }

    #[test]
    fn inherits_profiles_role_models_and_relative_resources_without_global_writes() {
        let fixture = Fixture::new("native");
        std::fs::write(fixture.source.join("config.toml"), "model_instructions_file = 'instructions.txt'\nlog_dir = '/tmp/original-log'\nsqlite_home = '/tmp/original-db'\n[agents.reviewer]\nconfig_file = 'reviewer.toml'\n").unwrap();
        std::fs::write(
            fixture.source.join("instructions.txt"),
            "private inherited instructions",
        )
        .unwrap();
        std::fs::write(fixture.source.join("reviewer.toml"), "model = 'review-model'\nmodel_provider = 'original'\nmodel_instructions_file = 'instructions.txt'\n").unwrap();
        std::fs::write(
            fixture.source.join("work.config.toml"),
            "model = 'profile-model'\nmodel_provider = 'original'\n[features]\njs_repl = true\n",
        )
        .unwrap();
        let env = fixture.prepare().unwrap();
        let home = env.home.unwrap();
        let config = parse(&std::fs::read(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            config["model_instructions_file"].as_str(),
            fixture.source.join("instructions.txt").to_str()
        );
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("instructions.txt")).unwrap(),
            "private inherited instructions"
        );
        let profile = parse(&std::fs::read(home.join("work.config.toml")).unwrap()).unwrap();
        assert_eq!(profile["model"].as_str(), Some("profile-model"));
        assert_eq!(profile["model_provider"].as_str(), Some("openai"));
        assert_eq!(profile["features"]["js_repl"].as_bool(), Some(true));
        let role_path = Path::new(
            config["agents"]["reviewer"]["config_file"]
                .as_str()
                .unwrap(),
        );
        assert!(role_path.starts_with(&home));
        let role = parse(&std::fs::read(role_path).unwrap()).unwrap();
        assert_eq!(role["model"].as_str(), Some("review-model"));
        assert_eq!(role["model_provider"].as_str(), Some("openai"));
        assert_eq!(
            role["openai_base_url"].as_str(),
            Some("http://127.0.0.1:3425/v1")
        );
        assert_eq!(config["log_dir"].as_str(), home.join("log_dir").to_str());
        assert_eq!(
            config["sqlite_home"].as_str(),
            home.join("sqlite_home").to_str()
        );
        assert!(!home.join("instructions.txt").exists());
        assert_eq!(
            std::fs::read_to_string(fixture.source.join("instructions.txt")).unwrap(),
            "private inherited instructions"
        );
    }
    #[test]
    fn rejects_malformed_configs_invalid_options_and_resource_cycles() {
        let fixture = Fixture::new("native");
        std::fs::write(fixture.source.join("config.toml"), "invalid = [").unwrap();
        assert!(fixture.prepare().err().unwrap().contains("TOML"));
        assert!(!home(&fixture.root, &fixture.launch).unwrap().exists());
        for id in ["../escape", "A123456789abcdef0123456789abcdef", ""] {
            let mut launch = fixture.launch.clone();
            launch.codex.as_mut().unwrap().context = Some(id.into());
            assert!(validate(&launch).is_err());
        }
        let mut launch = fixture.launch.clone();
        launch.adapter = "claude".into();
        assert!(validate(&launch).is_err());
        launch.adapter = "codex".into();
        launch.provider = None;
        launch.codex.as_mut().unwrap().image_mode = ImageMode::GatewayApi;
        assert!(validate(&launch).is_err());
        #[cfg(unix)]
        {
            std::fs::write(fixture.source.join("config.toml"), "").unwrap();
            std::os::unix::fs::symlink(
                fixture.source.join("skills"),
                fixture.source.join("skills"),
            )
            .unwrap();
            assert!(fixture.prepare().is_err());
        }
    }
    #[test]
    fn snapshot_proofs_reject_route_auth_and_role_replacement_but_allow_ui_metadata() {
        for file in [
            "config.toml",
            "auth.json",
            "yam-context.json",
            "yam-config.toml",
        ] {
            let fixture = Fixture::new("native");
            let env = fixture.prepare().unwrap();
            std::fs::write(env.home.as_ref().unwrap().join(file), "changed").unwrap();
            assert!(env.validate_before_spawn().is_err(), "{file}");
        }
        let fixture = Fixture::new("native");
        let env = fixture.prepare().unwrap();
        let path = env.home.as_ref().unwrap().join("config.toml");
        let mut config = std::fs::read_to_string(&path).unwrap();
        config.push_str("\n[tui]\nnotifications = false\n[projects.\\\"/tmp/example\\\"]\ntrust_level = 'trusted'\n");
        std::fs::write(&path, config.replace("\\\"", "\"")).unwrap();
        env.validate_before_spawn().unwrap();
    }
    #[test]
    fn native_hook_trust_state_survives_reopen_without_changing_global_configuration() {
        let fixture = Fixture::new("native");
        let original = b"model = 'original-model'\n";
        std::fs::write(fixture.source.join("config.toml"), original).unwrap();
        let env = fixture.prepare().unwrap();
        let path = env.home.as_ref().unwrap().join("config.toml");
        let mut config = parse(&std::fs::read(&path).unwrap()).unwrap();
        let state_key = "/<session-flags>/config.toml:session_start:0:0";
        let state = toml::Table::from_iter([(
            "trusted_hash".into(),
            toml::Value::String(format!("sha256:{}", "a".repeat(64))),
        )]);
        config.as_table_mut().unwrap().insert(
            "hooks".into(),
            toml::Value::Table(toml::Table::from_iter([(
                "state".into(),
                toml::Value::Table(toml::Table::from_iter([(
                    state_key.into(),
                    toml::Value::Table(state),
                )])),
            )])),
        );
        std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
        env.validate_before_spawn().unwrap();
        fixture.prepare().unwrap().validate_before_spawn().unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("trusted_hash"));
        assert_eq!(
            std::fs::read(fixture.source.join("config.toml")).unwrap(),
            original
        );
    }

    #[test]
    fn readonly_snapshot_lookup_creates_nothing_and_fresh_contexts_are_unique() {
        let fixture = Fixture::new("native");
        assert!(existing_home(&fixture.root, &fixture.launch).is_err());
        assert!(!fixture.root.join("providers").exists());
        let mut first = fixture.launch.clone();
        first.codex.as_mut().unwrap().context = None;
        let mut second = first.clone();
        assign_context(&mut first).unwrap();
        assign_context(&mut second).unwrap();
        assert_ne!(first.codex, second.codex);
        let saved = first.codex.clone();
        assign_context(&mut first).unwrap();
        assert_ne!(
            first.codex, saved,
            "a new creation must not reuse a history snapshot id"
        );
    }
    #[test]
    fn inherited_environment_preserves_mcp_credentials_and_filters_only_connection_overrides() {
        let fixture = Fixture::new("native");
        let env = fixture
            .prepare()
            .unwrap()
            .with_project_env(&BTreeMap::from([
                ("ANTHROPIC_API_KEY".into(), "mcp-credential".into()),
                ("CODEX_CA_CERTIFICATE".into(), "/tmp/cert".into()),
                ("OPENAI_BASE_URL".into(), "https://wrong.invalid".into()),
            ]));
        assert_eq!(env.vars["ANTHROPIC_API_KEY"], "mcp-credential");
        assert_eq!(env.vars["CODEX_CA_CERTIFICATE"], "/tmp/cert");
        assert_eq!(env.vars["OPENAI_BASE_URL"], "http://127.0.0.1:3425/v1");
        let mut command = std::process::Command::new("codex");
        command.env("CODEX_ACCESS_TOKEN", "desktop-token");
        env.apply_command(&mut command);
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "CODEX_ACCESS_TOKEN" && value.is_none()));
        assert!(command.get_envs().any(|(name, value)| name == "CODEX_HOME"
            && value == env.home.as_ref().map(|path| path.as_os_str())));
    }

    #[test]
    #[cfg(unix)]
    fn shares_skill_checkout_without_traversing_recursive_repository_metadata() {
        let fixture = Fixture::new("native");
        let skill = fixture.source.join("skills/example");
        std::fs::create_dir_all(skill.join(".claude/skills")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "original installed skill").unwrap();
        std::os::unix::fs::symlink(&skill, skill.join(".claude/skills/example")).unwrap();
        let env = fixture.prepare().unwrap();
        assert_eq!(
            std::fs::read_to_string(env.home.unwrap().join("skills/example/SKILL.md")).unwrap(),
            "original installed skill"
        );
    }

    #[test]
    #[ignore = "Opt-in references installed Codex resources from a disposable private configuration; no inference"]
    fn installed_codex_resources_are_inherited_without_source_changes() {
        let fixture = Fixture::new("native");
        let source = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".codex"));
        let before = std::fs::read(source.join("config.toml")).unwrap();
        let auth_before = std::fs::read(source.join("auth.json")).ok();
        let original = parse(&before).unwrap();
        let start = std::time::Instant::now();
        let env = crate::provider_launch::prepare(&fixture.root, &fixture.launch, &|name| {
            (name == "CODEX_HOME").then(|| source.to_string_lossy().into_owned())
        })
        .unwrap();
        let home = env.home.as_ref().unwrap();
        let current = parse(&std::fs::read(home.join("config.toml")).unwrap()).unwrap();
        for name in ["features", "plugins", "sandbox_mode", "approval_policy"] {
            assert!(
                current.get(name) == original.get(name),
                "inherited configuration field {name} differs"
            );
        }
        let original_servers = original.get("mcp_servers").unwrap().as_table().unwrap();
        let inherited_servers = current.get("mcp_servers").unwrap().as_table().unwrap();
        assert!(
            original_servers.keys().eq(inherited_servers.keys()),
            "MCP server names changed"
        );
        for (name, server) in original_servers {
            for key in [
                "command",
                "url",
                "args",
                "enabled",
                "tools",
                "startup_timeout_sec",
            ] {
                assert!(
                    server.get(key) == inherited_servers[name].get(key),
                    "MCP {name} setting {key} changed"
                );
            }
            if let Some(command) = server.get("command").and_then(toml::Value::as_str) {
                if Path::new(command).starts_with(&source) {
                    assert!(
                        Path::new(inherited_servers[name]["command"].as_str().unwrap()).is_file(),
                        "MCP executable was not copied"
                    );
                }
            }
        }
        assert_eq!(
            std::fs::read(home.join("AGENTS.md")).unwrap(),
            std::fs::read(source.join("AGENTS.md")).unwrap()
        );
        assert!(home.join("skills/.system/imagegen/SKILL.md").is_file());
        assert!(home.join("plugins").is_dir());
        assert!(
            std::fs::read(source.join("config.toml")).unwrap() == before,
            "Original Codex configuration changed"
        );
        assert!(
            std::fs::read(source.join("auth.json")).ok() == auth_before,
            "Original Codex authentication changed"
        );
        env.validate_before_spawn().unwrap();
        println!(
            "Installed resource snapshot prepared in {:?}; original config/auth unchanged",
            start.elapsed()
        );
    }

    #[test]
    fn hook_trust_paths_inherit_native_and_legacy_identities_without_granting_trust() {
        let fixture = Fixture::new("native");
        let target = fixture.root.join("private");
        for scheme in ["", "file:"] {
            let source_key = format!(
                "{scheme}{}/hooks.json:session_start:0:0",
                fixture.source.display()
            );
            let target_key = format!("{scheme}{}/hooks.json:session_start:0:0", target.display());
            let state = toml::Value::Table(toml::map::Map::from_iter([
                ("trusted_hash".into(), "sha256:already-reviewed".into()),
                ("enabled".into(), false.into()),
            ]));
            let mut config = parse(b"[hooks.state]").unwrap();
            config["hooks"]["state"]
                .as_table_mut()
                .unwrap()
                .insert(source_key.clone(), state.clone());
            hook_state_paths(&mut config, &fixture.source, &target);
            assert!(config["hooks"]["state"].get(&source_key).is_none());
            assert_eq!(config["hooks"]["state"][&target_key], state);
        }
        let keys = [
            format!(
                "{}/../hooks.json:session_start:0:0",
                fixture.source.display()
            ),
            format!(
                "{}-other/hooks.json:session_start:0:0",
                fixture.source.display()
            ),
            format!(
                "{}/plugins/hook.json:session_start:0:0",
                fixture.source.display()
            ),
            "ponytail@ponytail:hooks/hooks.json:session_start:0:0".into(),
            "/<session-flags>/config.toml:session_start:0:0".into(),
        ];
        let mut config = parse(b"[hooks.state]").unwrap();
        config["hooks"]["state"] = toml::Value::Table(toml::map::Map::from_iter(
            keys.into_iter()
                .map(|key| (key, toml::Value::Table(Default::default()))),
        ));
        let original = config.clone();
        hook_state_paths(&mut config, &fixture.source, &target);
        assert_eq!(config, original);
        let mut empty = toml::Value::Table(Default::default());
        hook_state_paths(&mut empty, &fixture.source, &target);
        assert!(empty.get("hooks").is_none());
    }

    #[test]
    fn inherits_mcp_file_credentials_and_remaps_hook_trust_identity() {
        let fixture = Fixture::new("native");
        let key = format!(
            "file:{}/hooks.json:SessionStart:0:0",
            fixture.source.display()
        );
        let hook_command = fixture
            .source
            .join("bin/hook")
            .to_string_lossy()
            .into_owned();
        let config = format!("mcp_oauth_credentials_store = 'file'\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = 'command'\ncommand = '{hook_command}'\n[hooks.state.'{key}']\ntrusted_hash = 'sha256:sentinel'\nenabled = false\n");
        std::fs::write(fixture.source.join("config.toml"), config).unwrap();
        std::fs::write(fixture.source.join(".credentials.json"), r#"{"fixture":{"server_name":"fixture","server_url":"https://example.invalid/mcp","client_id":"client","access_token":"test-token","scopes":[]}}"#).unwrap();
        let env = fixture.prepare().unwrap();
        let home = env.home.unwrap();
        let current = parse(&std::fs::read(home.join("config.toml")).unwrap()).unwrap();
        let mapped = format!("file:{}/hooks.json:SessionStart:0:0", home.display());
        assert_eq!(
            current["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str(),
            Some(hook_command.as_str())
        );
        assert!(current["hooks"]["state"].get(&key).is_none());
        assert_eq!(
            current["hooks"]["state"][&mapped]["trusted_hash"].as_str(),
            Some("sha256:sentinel")
        );
        assert_eq!(
            current["hooks"]["state"][&mapped]["enabled"].as_bool(),
            Some(false)
        );
        assert!(home.join(".credentials.json").is_file());
        assert_eq!(
            std::fs::read(home.join(".credentials.json")).unwrap(),
            std::fs::read(fixture.source.join(".credentials.json")).unwrap()
        );
    }
    #[test]
    #[cfg(unix)]
    fn inherited_absolute_executables_and_external_skill_disable_paths_remain_valid() {
        let fixture = Fixture::new("native");
        let external = fixture.root.join("skill-checkout");
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("SKILL.md"), "skill").unwrap();
        std::fs::create_dir(fixture.source.join("skills")).unwrap();
        std::os::unix::fs::symlink(&external, fixture.source.join("skills/example")).unwrap();
        std::fs::create_dir(fixture.source.join("bin")).unwrap();
        std::fs::write(fixture.source.join("bin/server"), "binary").unwrap();
        std::fs::write(fixture.source.join("config.toml"), format!("[[skills.config]]\npath = 'skills/example/SKILL.md'\nenabled = false\n[mcp_servers.example]\ncommand = '{}'\ncwd = '.'\n[mcp_servers.example.env]\nCODEX_HOME = '{}'\nMCP_DATA = '{}'\n", fixture.source.join("bin/server").display(), fixture.source.display(), fixture.source.join("bin/server").display())).unwrap();
        let env = fixture.prepare().unwrap();
        let home = env.home.unwrap();
        let config = parse(&std::fs::read(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            config["skills"]["config"][0]["path"].as_str(),
            fixture.source.join("skills/example/SKILL.md").to_str()
        );
        assert_eq!(
            config["mcp_servers"]["example"]["command"].as_str(),
            fixture.source.join("bin/server").to_str()
        );
        assert!(Path::new(
            config["mcp_servers"]["example"]["command"]
                .as_str()
                .unwrap()
        )
        .is_file());
        assert_eq!(
            Path::new(
                config["mcp_servers"]["example"]["env"]["CODEX_HOME"]
                    .as_str()
                    .unwrap()
            ),
            home.as_path()
        );
        assert_eq!(
            config["mcp_servers"]["example"]["env"]["MCP_DATA"].as_str(),
            fixture.source.join("bin/server").to_str()
        );
        assert_eq!(
            config["mcp_servers"]["example"]["cwd"].as_str(),
            fixture.source.to_str()
        );
    }

    #[test]
    fn native_tilde_paths_and_profile_hook_state_keep_their_meaning() {
        let user_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap();
        assert_eq!(
            resolve(Path::new("/config"), "~/instructions.md"),
            user_home.join("instructions.md")
        );
        let mut config: toml::Value = toml::from_str(
            "[hooks.state.'file:/original/work.config.toml:Stop:0:0']\nenabled = false\n",
        )
        .unwrap();
        hook_state_paths(&mut config, Path::new("/original"), Path::new("/private"));
        assert_eq!(
            config["hooks"]["state"]["file:/private/work.config.toml:Stop:0:0"]["enabled"]
                .as_bool(),
            Some(false)
        );
    }
    #[test]
    fn rejects_private_auth_tokens_stale_credentials_and_preexisting_staging() {
        let fixture = Fixture::new("native");
        let env = fixture.prepare().unwrap();
        let path = env.home.as_ref().unwrap().join("auth.json");
        std::fs::write(
            &path,
            r#"{"tokens":{"access_token":"desktop-must-never-be-used"}}"#,
        )
        .unwrap();
        assert!(existing_home(&fixture.root, &fixture.launch).is_err());
        assert!(fixture.prepare().is_err());
        let fixture = Fixture::new("native");
        std::fs::create_dir_all(
            home(&fixture.root, &fixture.launch)
                .unwrap()
                .with_extension("pending"),
        )
        .unwrap();
        assert!(fixture.prepare().is_err());
    }
    #[test]
    fn rejects_project_connection_overrides_that_would_reroute_bare_child_codex() {
        let fixture = Fixture::new("native");
        let project = fixture.root.join("project");
        std::fs::create_dir_all(project.join(".codex")).unwrap();
        std::fs::write(
            project.join(".codex/config.toml"),
            "model_provider = 'other'\n",
        )
        .unwrap();
        assert!(crate::provider_launch::validate_project(&fixture.launch, &project).is_err());
        for policy in [
            "[shell_environment_policy]\ninherit='none'\n",
            "[profiles.work.shell_environment_policy.set]\nCODEX_HOME='/global'\n",
        ] {
            std::fs::write(project.join(".codex/config.toml"), policy).unwrap();
            assert!(crate::provider_launch::validate_project(&fixture.launch, &project).is_err());
        }
        std::fs::write(
            project.join(".codex/config.toml"),
            "[features]\nmulti_agent = true\n",
        )
        .unwrap();
        crate::provider_launch::validate_project(&fixture.launch, &project).unwrap();
    }
}
