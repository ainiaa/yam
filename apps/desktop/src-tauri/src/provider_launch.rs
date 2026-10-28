// Author: Jeff.Liu.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) const PROTOCOL_VERSION: u8 = 1;
static PREPARE_GATE: Mutex<()> = Mutex::new(());
pub(crate) const IMAGE_API_INSTRUCTIONS: &str = "# YAM session image API route\n\nThe user selected an API/gateway connection for this YAM session. OPENAI_BASE_URL and OPENAI_API_KEY are already bound to that connection in this process and its child tools. They do not select an OpenAI account or the user's ChatGPT Desktop login.\n\nFor requested images, use the installed imagegen skill's bundled API workflow through this configured route, subject to normal tool and network approvals. Preserve the skill's image-specific model, format, and output rules. The absence of the native image_gen tool does not mean the API credential is missing. Before claiming that a credential is absent, check only whether the variable is set; never print credential values or authorization headers. Do not ask the user to obtain a separate OpenAI key or repeat gateway setup. Report actual dependency, network approval, or upstream errors separately. Never switch to the default OpenAI endpoint, another provider, or Desktop credentials to work around an error.\n";

pub(crate) struct Environment {
    pub(crate) vars: BTreeMap<String, String>,
    pub(crate) home: Option<PathBuf>,
    storage: Option<PreparedStorage>,
    context: Option<crate::codex_context::Prepared>,
}

const CONFIG_CHANGED: &str = "Managed provider configuration changed; no CLI was started";
struct PreparedStorage {
    directories: Vec<(PathBuf, (u64, u64))>,
    files: Vec<(PathBuf, crate::history::FileProof, Vec<u8>)>,
}
fn managed_file(path: &Path) -> Result<(crate::history::FileProof, Vec<u8>), String> {
    let read = || {
        let mut file = crate::background::private_file(path, false)?;
        let before = crate::history::private_file_stamp(&file)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| CONFIG_CHANGED)?;
        let after = crate::history::private_file_stamp(&file)?;
        let current =
            crate::history::private_file_stamp(&crate::background::private_file(path, false)?)?;
        if before != after || after != current || bytes.len() > 1024 * 1024 {
            return Err(CONFIG_CHANGED.into());
        }
        Ok((after, bytes))
    };
    read().map_err(|_: String| CONFIG_CHANGED.into())
}
impl PreparedStorage {
    fn capture(
        root: &Path,
        home: &Path,
        launch: &crate::AgentLaunch,
        connection: &str,
    ) -> Result<Self, String> {
        let mut directories = vec![
            root.to_path_buf(),
            root.join("providers"),
            root.join("providers").join(&launch.adapter),
            home.to_path_buf(),
        ];
        let paths = if launch.adapter == "claude" {
            vec![home.join("yam-connection.json")]
        } else {
            directories.push(home.join(".gemini"));
            vec![
                home.join("yam-connection.json"),
                home.join(".gemini/settings.json"),
            ]
        };
        let directories = directories
            .into_iter()
            .map(|path| {
                let identity = crate::history::private_directory_identity(&path)
                    .map_err(|_| CONFIG_CHANGED)?;
                Ok((path, identity))
            })
            .collect::<Result<_, String>>()?;
        let files = paths
            .into_iter()
            .map(|path| {
                let (identity, bytes) = managed_file(&path)?;
                let expected = if path
                    .file_name()
                    .is_some_and(|name| name == "yam-connection.json")
                {
                    connection.as_bytes().to_vec()
                } else {
                    let value: serde_json::Value =
                        serde_json::from_slice(&bytes).map_err(|_| CONFIG_CHANGED)?;
                    if bytes.len() > 65536
                        || value["security"]["auth"]["selectedType"] != "gemini-api-key"
                    {
                        return Err(CONFIG_CHANGED.into());
                    }
                    bytes
                };
                Ok((path, identity, expected))
            })
            .collect::<Result<_, String>>()?;
        let storage = Self { directories, files };
        storage.validate()?;
        Ok(storage)
    }
    fn validate(&self) -> Result<(), String> {
        self.validate_directories()?;
        for (path, expected_identity, expected) in &self.files {
            let (identity, bytes) = managed_file(path)?;
            if !expected_identity.same_identity(&identity) {
                return Err(CONFIG_CHANGED.into());
            }
            if bytes != *expected {
                return Err(CONFIG_CHANGED.into());
            }
        }
        self.validate_directories()
    }
    fn validate_directories(&self) -> Result<(), String> {
        for (path, expected) in &self.directories {
            if crate::history::private_directory_identity(path).map_err(|_| CONFIG_CHANGED)?
                != *expected
            {
                return Err(CONFIG_CHANGED.into());
            }
        }
        Ok(())
    }
}
pub(crate) fn prepare(
    root: &Path,
    launch: &crate::AgentLaunch,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Environment, String> {
    crate::codex_context::validate(launch)?;
    let Some(provider) = &launch.provider else {
        return Ok(Environment {
            vars: BTreeMap::new(),
            home: None,
            storage: None,
            context: None,
        });
    };
    provider.validate(&launch.adapter, &launch.extra_args)?;
    let key = match &provider.api_key_env {
        Some(name) => lookup(name)
            .filter(|key| {
                !key.trim().is_empty() && key.len() <= 16384 && !key.chars().any(char::is_control)
            })
            .ok_or_else(|| format!("Provider credential is unavailable in the background owner; check environment variable {name}"))?,
        None => "yam-local-gateway".into(),
    };
    crate::codex_context::validate(launch)?;
    if launch.adapter == "codex" && launch.codex.is_some() {
        let _gate = PREPARE_GATE
            .lock()
            .map_err(|_| "Provider preparation is unavailable")?;
        let (home, vars, context) = crate::codex_context::prepare(root, launch, &key, lookup)?;
        return Ok(Environment {
            vars,
            home: Some(home),
            storage: None,
            context: Some(context),
        });
    }
    let (snapshot, target_home) = managed_home(root, launch)?;
    let _gate = PREPARE_GATE
        .lock()
        .map_err(|_| "Provider preparation is unavailable")?;
    crate::background::private_root(root)?;
    let mut home = root.to_path_buf();
    for part in [
        "providers",
        launch.adapter.as_str(),
        target_home
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid provider directory")?,
    ] {
        home.push(part);
        crate::background::private_root(&home)?;
    }
    if launch.adapter == "codex" && std::fs::symlink_metadata(home.join("auth.json")).is_ok() {
        return Err(
            "Managed provider directory contains unexpected authentication; no CLI was started"
                .into(),
        );
    }
    let mut vars = BTreeMap::new();
    if launch.adapter == "codex" {
        let expected = codex_config(provider, &snapshot)?;
        let previous = if home.join("config.toml").exists() {
            let (_, bytes) = managed_file(&home.join("config.toml"))?;
            match validate_codex_config(&bytes, expected.as_bytes()) {
                Ok(()) => {
                    if !home.join("yam-context.json").exists() {
                        exact_private_file(
                            &home.join("AGENTS.md"),
                            IMAGE_API_INSTRUCTIONS.as_bytes(),
                        )?;
                    }
                    Some(
                        toml::from_str::<toml::Value>(
                            std::str::from_utf8(&bytes).map_err(|_| CONFIG_CHANGED)?,
                        )
                        .map_err(|_| CONFIG_CHANGED)?,
                    )
                }
                Err(error) if !home.join("yam-config.toml").exists() => return Err(error),
                Err(_) => None,
            }
        } else {
            Some(toml::Value::Table(Default::default()))
        };
        vars.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
        // Imagegen's SDK reads these aliases; pin both to this session, never the global account.
        let base = provider.base_url.trim_end_matches('/');
        let path = tauri::Url::parse(base).map_err(|_| "Invalid provider endpoint")?;
        let api_base = if path.path().is_empty() || path.path() == "/" {
            format!("{base}/v1")
        } else {
            base.into()
        };
        vars.insert("OPENAI_BASE_URL".into(), api_base);
        vars.insert("OPENAI_API_KEY".into(), key.clone());
        vars.insert("YAM_PROVIDER_API_KEY".into(), key);
        let context =
            crate::codex_context::prepare_legacy(root, &home, launch, &vars, lookup, previous)?;
        return Ok(Environment {
            vars,
            home: Some(home),
            storage: None,
            context: Some(context),
        });
    } else {
        exact_private_file(&home.join("yam-connection.json"), snapshot.as_bytes())?;
        if launch.adapter == "claude" {
            crate::claude_context::inherit(root, &home, lookup)?;
            vars.insert(
                "CLAUDE_CONFIG_DIR".into(),
                home.to_string_lossy().into_owned(),
            );
            let profiles = home.join("anthropic");
            crate::background::private_root(&profiles)?;
            vars.insert(
                "ANTHROPIC_CONFIG_DIR".into(),
                profiles.to_string_lossy().into_owned(),
            );
            vars.insert("ANTHROPIC_API_KEY".into(), key);
            vars.insert("ANTHROPIC_BASE_URL".into(), provider.base_url.clone());
            if provider.id == "deepseek" {
                for name in [
                    "ANTHROPIC_MODEL",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                    "CLAUDE_CODE_SUBAGENT_MODEL",
                ] {
                    vars.insert(
                        name.into(),
                        lookup(name).unwrap_or_else(|| provider.model.clone()),
                    );
                }
            }
        } else {
            let config = home.join(".gemini");
            crate::background::private_root(&config)?;
            let settings = config.join("settings.json");
            if settings
                .try_exists()
                .map_err(|_| "Cannot inspect managed Gemini settings")?
            {
                let mut bytes = Vec::new();
                crate::background::private_file(&settings, false)?
                    .take(65537)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read managed Gemini settings")?;
                let value: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid managed Gemini settings")?;
                if bytes.len() > 65536
                    || value["security"]["auth"]["selectedType"] != "gemini-api-key"
                {
                    return Err("Managed Gemini authentication changed; no CLI was started".into());
                }
            } else {
                exact_private_file(
                    &settings,
                    br#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
                )?;
            }
            vars.insert(
                "GEMINI_CLI_HOME".into(),
                home.to_string_lossy().into_owned(),
            );
            vars.insert("GEMINI_API_KEY".into(), key);
            vars.insert("GOOGLE_GEMINI_BASE_URL".into(), provider.base_url.clone());
        }
    }
    let storage = PreparedStorage::capture(root, &home, launch, &snapshot)?;
    Ok(Environment {
        vars,
        home: Some(home),
        storage: Some(storage),
        context: None,
    })
}

fn managed_home(root: &Path, launch: &crate::AgentLaunch) -> Result<(String, PathBuf), String> {
    let provider = launch.provider.as_ref().ok_or("Missing provider")?;
    provider.validate(&launch.adapter, &launch.extra_args)?;
    let snapshot = if launch.adapter == "claude" && launch.claude_context.is_some() {
        serde_json::to_string(&(provider, &launch.claude_context))
    } else {
        serde_json::to_string(provider)
    }
    .map_err(|_| "Invalid provider connection")?;
    // Stable FNV names survive Rust upgrades; the immutable connection prefix rejects collisions.
    let fingerprint = snapshot.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    Ok((
        snapshot,
        root.join("providers")
            .join(&launch.adapter)
            .join(format!("{fingerprint:016x}")),
    ))
}
// Only recognize the on-disk pre-inheritance format; never use it to launch a new session.
fn codex_config(provider: &ProviderConfig, snapshot: &str) -> Result<String, String> {
    Ok(format!(
        "# YAM managed connection: {snapshot}\nmodel = {}\nmodel_provider = \"yam_api\"\ncli_auth_credentials_store = \"file\"\nforced_login_method = \"api\"\nweb_search = \"disabled\"\n\n[model_providers.yam_api]\nname = {}\nbase_url = {}\nwire_api = \"responses\"\nenv_key = \"YAM_PROVIDER_API_KEY\"\nrequires_openai_auth = false\nsupports_websockets = false\n",
        quoted(&provider.model)?, quoted(&provider.id)?, quoted(&provider.base_url)?,
    ))
}
pub(crate) fn existing_home(root: &Path, launch: &crate::AgentLaunch) -> Result<PathBuf, String> {
    if launch.adapter != "codex" {
        return Err("conversation_unsupported".into());
    }
    if launch.codex.is_some() {
        return crate::codex_context::existing_home(root, launch);
    }
    let (snapshot, home) = managed_home(root, launch)?;
    for path in [
        root.to_path_buf(),
        root.join("providers"),
        root.join("providers/codex"),
        home.clone(),
    ] {
        let m = std::fs::symlink_metadata(&path).map_err(|_| "conversation_storage_unavailable")?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err("conversation_storage_unavailable".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
                return Err("conversation_storage_unavailable".into());
            }
        }
    }
    if std::fs::symlink_metadata(home.join("auth.json")).is_ok() {
        return Err("conversation_storage_unavailable".into());
    }
    if home.join("yam-config.toml").exists() {
        crate::codex_context::Prepared::capture(root, &home, launch)?;
        return home
            .canonicalize()
            .map_err(|_| "conversation_storage_unavailable".into());
    }
    let expected = codex_config(launch.provider.as_ref().unwrap(), &snapshot)?;
    let mut bytes = Vec::new();
    crate::background::private_file(&home.join("config.toml"), false)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "conversation_storage_unavailable")?;
    validate_codex_config(&bytes, expected.as_bytes())?;
    home.canonicalize()
        .map_err(|_| "conversation_storage_unavailable".into())
}

pub(crate) fn validate_project(launch: &crate::AgentLaunch, cwd: &Path) -> Result<(), String> {
    let Some(provider) = &launch.provider else {
        return Ok(());
    };
    if launch.adapter == "claude" {
        validate_claude_settings(&crate::parse_agent_args(&launch.extra_args)?, Some(cwd))?;
    }
    if launch.env_refs.keys().any(|name| {
        (if launch.codex.is_some() {
            crate::codex_context::conflicting_env(name)
        } else {
            conflicting_env(name)
        }) && !provider.api_key_env.as_ref().is_some_and(|selected| {
            if cfg!(windows) {
                selected.eq_ignore_ascii_case(name)
            } else {
                selected == name
            }
        })
    }) {
        return Err("Project environment references override the selected API provider; remove conflicting API/auth references".into());
    }
    if launch.adapter == "codex" {
        return crate::codex_context::validate_project(launch, cwd);
    }
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "Provider project directory is unavailable")?;
    let user_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok());
    let folder = if launch.adapter == "claude" {
        ".claude"
    } else {
        ".gemini"
    };
    let mut paths = Vec::new();
    for (depth, root) in cwd.ancestors().enumerate() {
        if depth >= 64 {
            return Err("Project settings lookup exceeded its scan budget".into());
        }
        if root != cwd && user_home.as_deref() == Some(root) {
            break;
        }
        paths.push(root.join(folder).join("settings.json"));
        if launch.adapter == "claude" {
            paths.push(root.join(folder).join("settings.local.json"));
        }
        let git_entry = root.join(".git");
        if git_entry.exists() {
            if launch.adapter == "claude" && git_entry.is_file() {
                let candidate = crate::find_executable("git")
                    .ok_or("Git is required to inspect worktree settings")?;
                let git = crate::git_context::fixed_git(
                    &candidate,
                    &std::env::current_dir().map_err(|_| "Cannot resolve Git")?,
                )?;
                let mut budget = crate::git_context::Budget {
                    deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
                    remaining: 65536,
                };
                let output = crate::git_context::git_command(
                    &git,
                    root,
                    &crate::git_context::config_environment()?,
                    &mut budget,
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                )?;
                if !output.status.success() {
                    return Err("Cannot inspect original worktree settings".into());
                }
                let common = PathBuf::from(
                    String::from_utf8(output.stdout)
                        .map_err(|_| "Invalid worktree settings path")?
                        .trim(),
                );
                if common.file_name().is_some_and(|name| name == ".git") {
                    paths.push(
                        common
                            .parent()
                            .ok_or("Invalid original worktree root")?
                            .join(".claude/settings.local.json"),
                    );
                }
            }
            break;
        }
    }
    for path in paths {
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata) if metadata.is_file() && metadata.len() <= 2 * 1024 * 1024 => {}
            _ => return Err("Cannot safely inspect project provider settings".into()),
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut bytes = Vec::new();
        options
            .open(&path)
            .map_err(|_| "Cannot inspect project provider settings")?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read project provider settings")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("Project provider settings exceeded their size limit".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "Project provider settings are invalid")?;
        let env_conflict = value["env"]
            .as_object()
            .is_some_and(|env| env.keys().any(|key| conflicting_env(key)));
        let claude_conflict = launch.adapter == "claude"
            && (!value["apiKeyHelper"].is_null()
                || value["forceLoginMethod"]
                    .as_str()
                    .is_some_and(|method| method != "console"));
        let gemini_conflict = launch.adapter == "gemini"
            && value["security"]["auth"].as_object().is_some_and(|auth| {
                auth.iter().any(|(key, value)| match key.as_str() {
                    "selectedType" | "enforcedType" => {
                        value != "gemini-api-key" && !value.is_null()
                    }
                    "useExternal" => value == true,
                    _ => true,
                })
            });
        if env_conflict || claude_conflict || gemini_conflict {
            return Err("Project settings override the selected API provider; remove their API/auth overrides or choose native CLI login".into());
        }
    }
    Ok(())
}

fn quoted(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "Invalid provider connection".into())
}

fn validate_codex_config(bytes: &[u8], expected: &[u8]) -> Result<(), String> {
    let changed = "Managed provider configuration changed; no CLI was started";
    if bytes.len() > 1024 * 1024 {
        return Err(changed.into());
    }
    let tail = bytes.strip_prefix(expected).ok_or(changed)?;
    let tail = std::str::from_utf8(tail).map_err(|_| changed)?;
    // Codex appends trust/UI metadata; keep it without allowing changes to connection settings.
    let mut metadata = false;
    for line in tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        if let Some(table) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            metadata = matches!(table, "tui" | "notice" | "hooks.state")
                || ["tui.", "projects.", "hooks.state."]
                    .iter()
                    .any(|prefix| table.starts_with(prefix));
            if !metadata {
                return Err(changed.into());
            }
        } else if !metadata || line.starts_with('[') {
            return Err(changed.into());
        }
    }
    Ok(())
}

fn exact_private_file(path: &Path, expected: &[u8]) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let mut bytes = Vec::new();
            crate::background::private_file(path, false)?
                .take(expected.len() as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read managed provider configuration")?;
            if bytes != expected {
                return Err("Managed provider configuration changed; no CLI was started".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = crate::background::private_file(path, true)?;
            file.write_all(expected)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Cannot save managed provider configuration")?;
        }
        Err(_) => return Err("Cannot inspect managed provider configuration".into()),
    }
    Ok(())
}

pub(crate) fn conflicting_env(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    crate::codex_context::conflicting_env(&name)
        || matches!(
            name.as_str(),
            "ANTHROPIC_UNIX_SOCKET"
                | "CLAUDE_CODE_USE_ANTHROPIC_AWS"
                | "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"
                | "CLAUDE_CODE_USE_MANTLE"
                | "ANTHROPIC_AWS_BASE_URL"
                | "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"
                | "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"
                | "CLAUDE_CODE_SKIP_BEDROCK_AUTH"
                | "CLAUDE_CODE_SKIP_VERTEX_AUTH"
                | "CLAUDE_CODE_SKIP_FOUNDRY_AUTH"
                | "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"
                | "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH"
                | "CLAUDE_CODE_SKIP_MANTLE_AUTH"
                | "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"
                | "CLAUDE_CODE_API_BASE_URL"
                | "CLAUDE_CODE_USE_GATEWAY"
                | "AWS_BEARER_TOKEN_BEDROCK"
                | "ANTHROPIC_FOUNDRY_AUTH_TOKEN"
                | "ANTHROPIC_AWS_API_KEY"
                | "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR"
                | "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
                | "CLAUDE_CODE_HOST_AUTH_ENV_VAR"
                | "CLAUDE_CODE_HOST_CREDS_FILE"
                | "CLAUDE_CODE_HOST_GATEWAY_LINEAGE"
                | "CLAUDE_BG_AUTH_SNAPSHOT_PATH"
                | "CLAUDE_BG_SOCKET_TOKENS_PATH"
                | "ANTHROPIC_CONFIG_DIR"
                | "ANTHROPIC_PROFILE"
                | "ANTHROPIC_FEDERATION_RULE_ID"
                | "ANTHROPIC_ORGANIZATION_ID"
                | "ANTHROPIC_WORKSPACE_ID"
                | "ANTHROPIC_SERVICE_ACCOUNT_ID"
                | "ANTHROPIC_IDENTITY_TOKEN"
                | "ANTHROPIC_IDENTITY_TOKEN_FILE"
                | "ANTHROPIC_SCOPE"
                | "CLAUDE_CODE_FEDERATION_CACHE_DIR"
                | "ANTHROPIC_API_KEY"
                | "ANTHROPIC_AUTH_TOKEN"
                | "ANTHROPIC_BASE_URL"
                | "ANTHROPIC_CUSTOM_HEADERS"
                | "ANTHROPIC_FOUNDRY_API_KEY"
                | "ANTHROPIC_FOUNDRY_BASE_URL"
                | "ANTHROPIC_FOUNDRY_RESOURCE"
                | "ANTHROPIC_BEDROCK_BASE_URL"
                | "ANTHROPIC_VERTEX_BASE_URL"
                | "CLAUDE_CONFIG_DIR"
                | "CLAUDE_CODE_OAUTH_TOKEN"
                | "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"
                | "CLAUDE_CODE_USE_BEDROCK"
                | "CLAUDE_CODE_USE_VERTEX"
                | "CLAUDE_CODE_USE_FOUNDRY"
                | "GEMINI_CLI_HOME"
                | "GEMINI_API_KEY"
                | "GOOGLE_API_KEY"
                | "GOOGLE_APPLICATION_CREDENTIALS"
                | "GOOGLE_GEMINI_BASE_URL"
                | "GOOGLE_VERTEX_BASE_URL"
                | "GOOGLE_GENAI_USE_VERTEXAI"
        )
}

impl Environment {
    pub(crate) fn validate_before_spawn(&self) -> Result<(), String> {
        if let Some(context) = &self.context {
            context.validate().map_err(|error| {
                if context.legacy {
                    CONFIG_CHANGED.to_string()
                } else {
                    error
                }
            })?;
        }
        match &self.storage {
            Some(storage) => storage.validate(),
            None => Ok(()),
        }
    }
    fn conflicts(&self, name: &str) -> bool {
        if self.context.as_ref().is_some_and(|context| !context.legacy) {
            crate::codex_context::conflicting_env(name)
        } else {
            conflicting_env(name)
        }
    }
    fn value(&self, name: &str) -> Option<std::ffi::OsString> {
        self.vars
            .iter()
            .find(|(key, _)| {
                if cfg!(windows) {
                    key.eq_ignore_ascii_case(name)
                } else {
                    key.as_str() == name
                }
            })
            .map(|(_, value)| value.into())
            .or_else(|| {
                if self.home.is_some() && self.conflicts(name) {
                    None
                } else {
                    std::env::var_os(name)
                }
            })
    }
    pub(crate) fn config_root(&self, adapter: &str, cwd: &Path, fallback: &Path) -> PathBuf {
        let selected = if adapter == "claude" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "GEMINI_CLI_HOME"
        };
        let directory = self
            .value(selected)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let path = if let Some(directory) = directory {
            if adapter == "claude" {
                directory
            } else {
                directory.join(".gemini")
            }
        } else {
            self.value(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| fallback.to_path_buf())
                .join(if adapter == "claude" {
                    ".claude"
                } else {
                    ".gemini"
                })
        };
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    }
    pub(crate) fn with_project_env(mut self, env: &BTreeMap<String, String>) -> Self {
        let mut vars: BTreeMap<_, _> = env
            .iter()
            .filter(|(name, _)| self.home.is_none() || !self.conflicts(name))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        vars.extend(self.vars);
        self.vars = vars;
        self
    }

    pub(crate) fn apply_pty(&self, command: &mut portable_pty::CommandBuilder) {
        if self.home.is_some() {
            let removed: Vec<_> = command
                .iter_full_env_as_str()
                .filter(|(key, _)| self.conflicts(key))
                .map(|(key, _)| key.to_string())
                .collect();
            for key in removed {
                command.env_remove(key);
            }
        }
        for (key, value) in &self.vars {
            command.env(key, value);
        }
    }
    pub(crate) fn apply_command(&self, command: &mut std::process::Command) {
        if self.home.is_some() {
            let keys: Vec<_> = std::env::vars_os()
                .map(|(key, _)| key)
                .chain(command.get_envs().map(|(key, _)| key.to_owned()))
                .collect();
            for key in keys {
                if key.to_str().is_some_and(|name| self.conflicts(name)) {
                    command.env_remove(key);
                }
            }
        }
        command.envs(&self.vars);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub model: String,
    pub base_url: String,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub api_key_env: Option<String>,
}

// Interpret only the TOML key; values and capability semantics belong to the official CLI.
pub(crate) fn config_override_path(value: &str) -> Result<Vec<String>, String> {
    let (key, _) = value
        .split_once('=')
        .ok_or("CLI configuration requires key=value")?;
    let tree: toml::Value =
        toml::from_str(&format!("{key}=false")).map_err(|_| "Invalid CLI configuration key")?;
    let mut result = Vec::new();
    let mut value = &tree;
    while let Some(table) = value.as_table() {
        if table.len() != 1 {
            return Err("Invalid CLI configuration key".into());
        }
        let (key, next) = table.iter().next().unwrap();
        result.push(key.clone());
        value = next;
    }
    if result.is_empty() {
        return Err("Invalid CLI configuration key".into());
    }
    Ok(result)
}

pub(crate) fn validate_claude_settings(args: &[String], cwd: Option<&Path>) -> Result<(), String> {
    for (index, arg) in args.iter().enumerate() {
        let value = if arg == "--settings" {
            Some(
                args.get(index + 1)
                    .ok_or("Missing Claude settings")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--settings=")
        };
        let Some(value) = value else {
            continue;
        };
        let settings = if value.trim_start().starts_with('{') {
            Some(
                serde_json::from_str::<serde_json::Value>(value)
                    .map_err(|_| "Invalid Claude settings")?,
            )
        } else if let Some(cwd) = cwd {
            let path = cwd.join(value);
            Some(
                crate::claude_context::read_json(&path)?
                    .ok_or("Claude settings file is unavailable")?,
            )
        } else {
            None
        };
        if settings.as_ref().is_some_and(|settings| {
            !settings.is_object()
                || settings["env"]
                    .as_object()
                    .is_some_and(|env| env.keys().any(|key| conflicting_env(key)))
                || [
                    "apiKeyHelper",
                    "forceLoginMethod",
                    "forceLoginOrgUUID",
                    "awsAuthRefresh",
                    "awsCredentialExport",
                ]
                .iter()
                .any(|key| !settings[*key].is_null())
        }) {
            return Err("CLI settings override the selected API connection; use native CLI login or remove authentication overrides".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_launch_args(
    adapter: &str,
    args: &[String],
    managed: bool,
) -> Result<(), String> {
    fn route_table(value: &toml::Value) -> bool {
        value.as_table().is_some_and(|table| {
            table.iter().any(|(key, value)| {
                matches!(
                    key.as_str(),
                    "model_provider"
                        | "model_providers"
                        | "openai_base_url"
                        | "config_file"
                        | "forced_login_method"
                        | "cli_auth_credentials_store"
                        | "mcp_oauth_credentials_store"
                        | "shell_environment_policy"
                        | "log_dir"
                        | "sqlite_home"
                ) || route_table(value)
            })
        })
    }
    fn profile(value: &str) -> Result<(), String> {
        if value.is_empty() || matches!(value, "." | "..") || value.contains(['/', '\\']) {
            return Err(
                "Managed profiles must be names inside the inherited Codex configuration directory"
                    .into(),
            );
        }
        Ok(())
    }
    let conflict = || {
        "CLI arguments override the managed connection or session; use YAM connection and session controls".to_string()
    };
    if managed && adapter == "claude" {
        validate_claude_settings(args, None)?;
    }
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let name = arg.split('=').next().unwrap_or_default();
        if adapter == "claude"
            && (name == "--print" || (arg.starts_with("-p") && !arg.starts_with("--")))
        {
            return Err(conflict());
        }
        if adapter == "gemini"
            && (matches!(
                name,
                "--session-file"
                    | "--prompt"
                    | "-p"
                    | "--prompt-interactive"
                    | "-i"
                    | "--output-format"
                    | "-o"
                    | "--acp"
                    | "--experimental-acp"
                    | "--list-sessions"
                    | "--delete-session"
                    | "--list-extensions"
                    | "-l"
            ) || (!arg.starts_with("--")
                && ["-p", "-i", "-o", "-l"]
                    .iter()
                    .any(|prefix| arg.starts_with(prefix)))
                || matches!(arg.as_str(), "extensions" | "skills" | "hooks" | "gemma"))
        {
            return Err(conflict());
        }
        if matches!(
            name,
            "--remote"
                | "--remote-auth-token-env"
                | "--cd"
                | "-C"
                | "--worktree"
                | "-w"
                | "--resume"
                | "-r"
                | "--continue"
                | "--fork-session"
                | "--session-id"
                | "--from-pr"
                | "--teleport"
                | "--desktop"
                | "--cloud"
                | "--environment"
                | "--background"
                | "--bg"
                | "--tmux"
                | "--"
        ) || managed && (matches!(name, "--local-provider" | "--oss"))
            || arg.starts_with("-C") && !arg.starts_with("--")
            || arg.starts_with("-r") && !arg.starts_with("--")
            || arg.starts_with("-w") && !arg.starts_with("--")
            || adapter == "claude" && arg.starts_with("-c") && !arg.starts_with("--")
        {
            return Err(conflict());
        }
        let config = if adapter == "codex" {
            if matches!(name, "-c" | "--config") {
                Some(if let Some((_, value)) = arg.split_once('=') {
                    value
                } else {
                    index += 1;
                    args.get(index).ok_or_else(conflict)?.as_str()
                })
            } else {
                arg.strip_prefix("-c").filter(|_| !arg.starts_with("--"))
            }
        } else {
            None
        };
        if let Some(value) = config {
            let path = config_override_path(value)?;
            if managed
                && (matches!(
                    path[0].as_str(),
                    "model_provider"
                        | "model_providers"
                        | "openai_base_url"
                        | "cli_auth_credentials_store"
                        | "mcp_oauth_credentials_store"
                        | "forced_login_method"
                        | "forced_chatgpt_workspace_id"
                        | "log_dir"
                        | "sqlite_home"
                        | "shell_environment_policy"
                ) || path.iter().any(|key| key == "config_file"))
            {
                return Err(conflict());
            }
            if managed && matches!(path[0].as_str(), "agents" | "profiles") {
                let tree = toml::from_str::<toml::Value>(value).ok();
                if path.iter().any(|key| key == "model_provider")
                    || tree.as_ref().is_some_and(route_table)
                {
                    return Err(conflict());
                }
            }
        } else if adapter == "claude" && matches!(name, "--debug" | "-d") {
            if !arg.contains('=')
                && args
                    .get(index + 1)
                    .is_some_and(|value| !value.starts_with('-'))
            {
                index += 1;
            }
        } else if adapter == "claude"
            && matches!(
                name,
                "--add-dir"
                    | "--mcp-config"
                    | "--allowedTools"
                    | "--allowed-tools"
                    | "--disallowedTools"
                    | "--disallowed-tools"
                    | "--tools"
            )
        {
            let mut values = usize::from(arg.contains('='));
            while args
                .get(index + 1)
                .is_some_and(|value| !value.starts_with('-'))
            {
                index += 1;
                values += 1;
            }
            if values == 0 {
                return Err("Missing CLI option value".into());
            }
        } else if matches!(
            name,
            "--debug-file"
                | "--include-directories"
                | "--approval-mode"
                | "--policy"
                | "--admin-policy"
                | "--allowed-mcp-server-names"
                | "--allowed-tools"
                | "--extensions"
                | "-e"
                | "--fake-responses"
                | "--fake-responses-non-strict"
                | "--record-responses"
                | "--model"
                | "-m"
                | "--local-provider"
                | "--profile"
                | "-p"
                | "--effort"
                | "--permission-mode"
                | "--agent"
                | "--agents"
                | "--add-dir"
                | "--append-system-prompt"
                | "--system-prompt"
                | "--name"
                | "--plugin-dir"
                | "--settings"
                | "--setting-sources"
                | "--mcp-config"
                | "--enable"
                | "--disable"
                | "--sandbox"
                | "-s"
                | "--ask-for-approval"
                | "-a"
                | "--image"
                | "-i"
        ) && !(adapter == "gemini" && matches!(name, "--sandbox" | "-s"))
        {
            let inline = arg.split_once('=').map(|(_, value)| value);
            let value = if let Some(value) = inline {
                value
            } else {
                index += 1;
                args.get(index).ok_or("Missing CLI option value")?.as_str()
            };
            if (value.is_empty() && name != "--setting-sources")
                || (inline.is_none() && value.starts_with('-'))
            {
                return Err("Missing CLI option value".into());
            }
            if managed && adapter == "codex" && matches!(name, "--profile" | "-p") {
                profile(value)?;
            }
        } else if !arg.starts_with('-')
            && matches!(
                arg.as_str(),
                "exec"
                    | "e"
                    | "review"
                    | "login"
                    | "logout"
                    | "auth"
                    | "resume"
                    | "fork"
                    | "app"
                    | "app-server"
                    | "remote-control"
                    | "exec-server"
                    | "cloud"
                    | "mcp"
                    | "plugin"
                    | "plugins"
                    | "agents"
                    | "attach"
                    | "stop"
                    | "kill"
                    | "purge"
                    | "rm"
                    | "respawn"
                    | "install"
                    | "update"
                    | "upgrade"
                    | "setup-token"
                    | "gateway"
                    | "import"
                    | "doctor"
                    | "completion"
                    | "sandbox"
                    | "debug"
                    | "apply"
                    | "archive"
                    | "delete"
                    | "queue"
                    | "unarchive"
                    | "migrate-rollouts"
                    | "features"
                    | "help"
            )
        {
            return Err(conflict());
        }
        if managed && adapter == "codex" {
            if let Some(value) = arg
                .strip_prefix("--profile=")
                .or_else(|| arg.strip_prefix("-p").filter(|_| !arg.starts_with("--")))
            {
                if !value.is_empty() {
                    profile(value)?;
                }
            }
        }
        index += 1;
    }
    Ok(())
}

impl ProviderConfig {
    pub(crate) fn command_overrides(&self, adapter: &str) -> Result<Vec<String>, String> {
        if adapter != "codex" {
            return Ok(vec!["--model".into(), self.model.clone()]);
        }
        let mut args = vec!["--no-daemon".into()];
        for value in [
            format!("model={}", quoted(&self.model)?),
            "model_provider=\"yam_api\"".into(),
            "cli_auth_credentials_store=\"file\"".into(),
            "forced_login_method=\"api\"".into(),
            format!("model_providers.yam_api.name={}", quoted(&self.id)?),
            format!(
                "model_providers.yam_api.base_url={}",
                quoted(&self.base_url)?
            ),
            "model_providers.yam_api.wire_api=\"responses\"".into(),
            "model_providers.yam_api.env_key=\"YAM_PROVIDER_API_KEY\"".into(),
            "model_providers.yam_api.requires_openai_auth=false".into(),
            "model_providers.yam_api.supports_websockets=false".into(),
        ] {
            args.extend(["-c".into(), value]);
        }
        Ok(args)
    }
    pub(crate) fn validate(&self, adapter: &str, extra_args: &str) -> Result<(), String> {
        if !match self.id.as_str() {
            "codex" => adapter == "codex",
            "deepseek" => matches!(adapter, "codex" | "claude"),
            "claude" => adapter == "claude",
            "gemini" => matches!(adapter, "gemini" | "claude"),
            "custom" => matches!(adapter, "codex" | "claude" | "gemini"),
            _ => false,
        } || self.model.is_empty()
            || self.model.len() > 256
            || self
                .model
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || self.base_url.len() > 2048
            || self
                .base_url
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("Invalid provider connection".into());
        }
        let url = tauri::Url::parse(&self.base_url).map_err(|_| "Invalid provider endpoint")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(url.scheme() == "https" || local && url.scheme() == "http")
        {
            return Err("Use HTTPS or a loopback HTTP gateway without URL credentials".into());
        }
        match &self.api_key_env {
            Some(name)
                if crate::project_config::variable(name)
                    && !crate::project_config::reserved(name) => {}
            None if local => {}
            _ => {
                return Err("Select a valid API key environment variable or a local gateway".into())
            }
        }
        let args = crate::parse_agent_args(extra_args)?;
        validate_launch_args(adapter, &args, true)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{agent_command, AgentLaunch};
    use serde_json::{json, Value};
    use std::path::Path;

    fn deepseek() -> Value {
        json!({"id":"deepseek","model":"deepseek-flash","base_url":"https://api.deepseek.com","api_key_env":"DEEPSEEK_API_KEY"})
    }
    fn launch(provider: Value) -> AgentLaunch {
        serde_json::from_value(json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null,"provider":provider})).unwrap()
    }

    #[test]
    fn provider_launch_deepseek_accepts_both_native_executors_without_migrating_snapshots() {
        for adapter in ["codex", "claude"] {
            let mut launch = launch(deepseek());
            launch.adapter = adapter.into();
            if adapter == "claude" {
                launch.provider.as_mut().unwrap().base_url =
                    "https://api.deepseek.com/anthropic".into();
            }
            let saved = serde_json::to_value(&launch).unwrap();
            let restored: AgentLaunch = serde_json::from_value(saved.clone()).unwrap();
            assert_eq!(serde_json::to_value(&restored).unwrap(), saved);
            assert!(
                agent_command(Path::new(adapter), &restored).is_ok(),
                "{adapter}"
            );
        }
        let provider: super::ProviderConfig = serde_json::from_value(deepseek()).unwrap();
        for adapter in ["gemini", "opencode", "shell", "custom"] {
            assert!(provider.validate(adapter, "").is_err(), "{adapter}");
        }
    }

    #[test]
    fn provider_launch_deepseek_claude_pins_default_and_subtask_models() {
        for model in ["deepseek-flash", "vendor/deepseek-model"] {
            let fixture = Fixture::new();
            let mut launch = launch(deepseek());
            launch.adapter = "claude".into();
            launch.provider.as_mut().unwrap().model = model.into();
            launch.provider.as_mut().unwrap().base_url =
                "https://api.deepseek.com/anthropic".into();
            let environment = super::prepare(&fixture.0, &launch, &|name| {
                (name == "DEEPSEEK_API_KEY").then(|| "unit-provider-value".into())
            })
            .unwrap();
            let mut command = std::process::Command::new("claude");
            for name in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                command.env(name, "other-inherited-model");
            }
            environment.apply_command(&mut command);
            let actual: std::collections::BTreeMap<_, _> = command
                .get_envs()
                .map(|(key, value)| (key.to_str().unwrap(), value.and_then(|v| v.to_str())))
                .collect();
            for name in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                assert_eq!(actual.get(name), Some(&Some(model)), "{name}");
            }
            assert_eq!(
                actual.get("ANTHROPIC_BASE_URL"),
                Some(&Some("https://api.deepseek.com/anthropic"))
            );
            let command = agent_command(Path::new("claude"), &launch).unwrap();
            assert!(command
                .get_argv()
                .windows(2)
                .any(|args| args == ["--model", model]));
        }
    }

    #[test]
    fn provider_launch_other_claude_connections_keep_native_model_alias_resolution() {
        for id in ["claude", "custom"] {
            let fixture = Fixture::new();
            let mut launch = launch(
                json!({"id":id,"model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
            );
            launch.adapter = "claude".into();
            let environment = super::prepare(&fixture.0, &launch, &|name| match name {
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE" => None,
                _ => panic!("local gateway"),
            })
            .unwrap();
            for name in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                assert!(!environment.vars.contains_key(name), "{id}: {name}");
            }
            assert!(agent_command(Path::new("claude"), &launch)
                .unwrap()
                .get_argv()
                .windows(2)
                .any(|args| args == ["--model", "sonnet"]));
        }
    }

    #[test]
    fn provider_launch_connection_survives_history_roundtrip_without_key_values() {
        let input = deepseek();
        let restored: AgentLaunch =
            serde_json::from_value(serde_json::to_value(launch(input.clone())).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap()["provider"], input);
    }

    #[test]
    fn provider_launch_invalid_connection_is_rejected_at_command_boundary() {
        for (field, value) in [
            ("id", json!("unknown")),
            ("model", json!("")),
            ("model", json!("model\nsecret")),
            ("base_url", json!("http://example.com")),
            ("base_url", json!("https://secret@example.com")),
            ("base_url", json!("https://example.com/?api_key=secret")),
            ("api_key_env", json!("sk-plain-secret")),
            ("api_key_env", Value::Null),
        ] {
            let mut provider = deepseek();
            provider[field] = value;
            let result = agent_command(Path::new("codex"), &launch(provider));
            assert!(result.is_err(), "invalid {field} must not start a CLI");
        }
    }

    #[test]
    fn provider_launch_cannot_hide_connection_overrides_in_extra_arguments() {
        for args in [
            "-c model_provider=other",
            "--profile ../../other",
            "--remote ws://localhost:1",
        ] {
            let mut launch = launch(deepseek());
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("codex"), &launch).is_err(),
                "{args}"
            );
        }
    }

    #[test]
    fn provider_launch_legacy_official_launch_remains_unchanged() {
        let launch: AgentLaunch = serde_json::from_value(
            json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null}),
        )
        .unwrap();
        let command = agent_command(Path::new("codex"), &launch).unwrap();
        assert_eq!(command.get_argv(), &[std::ffi::OsString::from("codex")]);
        assert!(serde_json::to_value(launch)
            .unwrap()
            .get("provider")
            .is_none());
    }

    struct Fixture(std::path::PathBuf);
    #[test]
    fn provider_images_session_instructions_are_private_additive_and_guarded() {
        let fixture = Fixture::new();
        let launch = launch(
            json!({"id":"custom","model":"fixture","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        let environment = super::prepare(&fixture.0, &launch, &|_| None).unwrap();
        let home = environment.home.as_ref().unwrap();
        let path = home.join("AGENTS.md");
        let original =
            std::fs::read(&path).expect("The model must receive its configured image API route");
        let note = String::from_utf8_lossy(&original);
        assert!(note.contains("YAM session image API route"));
        assert!(note.contains("OPENAI_BASE_URL") && note.contains("OPENAI_API_KEY"));
        assert!(note.contains("normal tool and network approvals"));
        assert!(!note.contains("yam-local-gateway"));
        let config_before = std::fs::read(home.join("config.toml")).unwrap();
        std::fs::write(home.join("history-sentinel"), "kept").unwrap();
        super::prepare(&fixture.0, &launch, &|_| None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(
            std::fs::read(home.join("config.toml")).unwrap(),
            config_before
        );
        assert_eq!(
            std::fs::read_to_string(home.join("history-sentinel")).unwrap(),
            "kept"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::write(&path, "changed instructions").unwrap();
        assert!(environment.validate_before_spawn().is_err());
        assert!(super::prepare(&fixture.0, &launch, &|_| None).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "changed instructions"
        );
        std::fs::write(&path, &original).unwrap();
        let prepared = super::prepare(&fixture.0, &launch, &|_| None).unwrap();
        std::fs::rename(&path, home.join("old-instructions")).unwrap();
        std::fs::write(&path, &original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(
            prepared.validate_before_spawn().is_err(),
            "Replaced instruction identity must be rejected"
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(home.join("old-instructions"), &path).unwrap();
            assert!(super::prepare(&fixture.0, &launch, &|_| None).is_err());
        }
        let native: AgentLaunch = serde_json::from_value(
            json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null}),
        )
        .unwrap();
        let ordinary = Fixture::new();
        super::prepare(&ordinary.0, &native, &|_| None).unwrap();
        assert_eq!(std::fs::read_dir(&ordinary.0).unwrap().count(), 0);
    }
    #[test]
    fn provider_images_sdk_uses_only_session_gateway_and_preserves_native_history() {
        for (url, expected) in [
            ("http://127.0.0.1:3425", "http://127.0.0.1:3425/v1"),
            ("http://127.0.0.1:3425/", "http://127.0.0.1:3425/v1"),
            ("http://127.0.0.1:3425/v1/", "http://127.0.0.1:3425/v1"),
            (
                "https://gateway.example/api/v2/",
                "https://gateway.example/api/v2",
            ),
        ] {
            let fixture = Fixture::new();
            let launch = launch(
                json!({"id":"custom","model":"3qrouter/gpt-6.1-sol","base_url":url,"api_key_env":"GATEWAY_KEY"}),
            );
            let environment = super::prepare(&fixture.0, &launch, &|name| {
                if matches!(
                    name,
                    "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
                ) {
                    return None;
                }
                assert_eq!(name, "GATEWAY_KEY");
                Some("session-key".into())
            })
            .unwrap();
            assert_eq!(environment.vars["OPENAI_BASE_URL"], expected);
            assert_eq!(environment.vars["OPENAI_API_KEY"], "session-key");
            assert_eq!(environment.vars["YAM_PROVIDER_API_KEY"], "session-key");
            let home = environment.home.unwrap();
            let before = std::fs::read(home.join("config.toml")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(home.join("config.toml"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o077,
                    0,
                    "child connection values must stay private"
                );
            }
            std::fs::write(home.join("native-history-sentinel"), b"kept").unwrap();
            let rotated = super::prepare(&fixture.0, &launch, &|name| {
                (!matches!(
                    name,
                    "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
                ))
                .then(|| "rotated-key".into())
            })
            .unwrap();
            assert_eq!(rotated.vars["OPENAI_API_KEY"], "rotated-key");
            assert_eq!(rotated.home.as_ref(), Some(&home));
            let mut previous: toml::Value =
                toml::from_str(std::str::from_utf8(&before).unwrap()).unwrap();
            let mut current: toml::Value =
                toml::from_str(&std::fs::read_to_string(home.join("config.toml")).unwrap())
                    .unwrap();
            assert_eq!(
                current["shell_environment_policy"]["set"]["OPENAI_API_KEY"].as_str(),
                Some("rotated-key")
            );
            previous
                .as_table_mut()
                .unwrap()
                .remove("shell_environment_policy");
            current
                .as_table_mut()
                .unwrap()
                .remove("shell_environment_policy");
            assert_eq!(previous, current);
            assert_eq!(
                std::fs::read(home.join("native-history-sentinel")).unwrap(),
                b"kept"
            );
            for command in [
                agent_command(Path::new("codex"), &launch).unwrap(),
                crate::resume_command(
                    Path::new("codex"),
                    &launch,
                    "01a0f6ec-5463-78c3-a404-5a7ad3b933fe",
                )
                .unwrap(),
            ] {
                let args = format!("{:?}", command.get_argv());
                assert!(args.contains("3qrouter/gpt-6.1-sol"));
                assert!(!args.contains("session-key"));
                assert!(!args.contains("OpenAI"));
            }
        }
        let fixture = Fixture::new();
        let local = launch(
            json!({"id":"custom","model":"fixture","base_url":"http://localhost:3425","api_key_env":null}),
        );
        let environment = super::prepare(&fixture.0, &local, &|name| {
            if matches!(
                name,
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
            ) {
                return None;
            }
            panic!("No OpenAI or gateway key is needed for a keyless local gateway")
        })
        .unwrap();
        assert_eq!(environment.vars["OPENAI_API_KEY"], "yam-local-gateway");
        assert_eq!(
            environment.vars["OPENAI_BASE_URL"],
            "http://localhost:3425/v1"
        );
        for key in ["", "bad\nkey"] {
            let mut launch = local.clone();
            launch.provider.as_mut().unwrap().api_key_env = Some("GATEWAY_KEY".into());
            assert!(super::prepare(&fixture.0, &launch, &|name| (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| key.into()))
            .is_err());
        }
        let mut native = local;
        native.provider = None;
        assert!(super::prepare(&fixture.0, &native, &|_| None)
            .unwrap()
            .vars
            .is_empty());
        for adapter in ["claude", "gemini"] {
            native.adapter = adapter.into();
            native.provider = Some(serde_json::from_value(json!({"id":"custom","model":"fixture","base_url":"http://localhost:3425","api_key_env":null})).unwrap());
            let environment = super::prepare(&fixture.0, &native, &|_| None).unwrap();
            assert!(!environment.vars.contains_key("OPENAI_API_KEY"));
            assert!(!environment.vars.contains_key("OPENAI_BASE_URL"));
        }
    }
    #[test]
    fn closure_t10_codex_guard_allows_native_metadata_but_refuses_auth_or_connection_changes() {
        use std::io::Write;
        let fixture = Fixture::new();
        let launch = launch(
            json!({"id":"custom","model":"fixture","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        let environment = super::prepare(&fixture.0, &launch, &|name| match name {
            "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE" => None,
            _ => panic!("no source credentials"),
        })
        .unwrap();
        let home = environment.home.as_ref().unwrap();
        let config = home.join("config.toml");
        let original = std::fs::read(&config).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&config)
            .unwrap()
            .write_all(b"\n[projects.owned]\ntrust_level = 'trusted'\n")
            .unwrap();
        environment.validate_before_spawn().unwrap();
        std::fs::write(home.join("auth.json"), b"owned unexpected auth").unwrap();
        assert_eq!(
            environment.validate_before_spawn().unwrap_err(),
            super::CONFIG_CHANGED
        );
        std::fs::remove_file(home.join("auth.json")).unwrap();
        environment.validate_before_spawn().unwrap();
        std::fs::write(&config, b"model_provider = 'changed'\n").unwrap();
        assert_eq!(
            environment.validate_before_spawn().unwrap_err(),
            super::CONFIG_CHANGED
        );
        std::fs::write(&config, original).unwrap();
        environment.validate_before_spawn().unwrap();
        let legacy: AgentLaunch = serde_json::from_value(
            json!({"adapter":"codex","mode":"task","extra_args":"","prompt":"owned"}),
        )
        .unwrap();
        super::prepare(&fixture.0, &legacy, &|_| {
            panic!("unmanaged needs no credential")
        })
        .unwrap()
        .validate_before_spawn()
        .unwrap();
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("yam-provider-{}", crate::next_session_id()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn provider_launch_prepares_stable_private_home_without_touching_official_auth() {
        let fixture = Fixture::new();
        let official = fixture.0.join("official");
        std::fs::create_dir_all(&official).unwrap();
        std::fs::write(official.join("config.toml"), "official-config-sentinel").unwrap();
        std::fs::write(official.join("auth.json"), "official-auth-sentinel").unwrap();
        let launch = launch(deepseek());
        let prepared = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
            ))
            .then(|| "private-key-sentinel".into())
        })
        .unwrap();
        let home = prepared.home.unwrap();
        assert_ne!(home, official);
        assert_eq!(prepared.vars["CODEX_HOME"], home.to_str().unwrap());
        assert_eq!(
            prepared.vars["YAM_PROVIDER_API_KEY"],
            "private-key-sentinel"
        );
        let config = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("wire_api = \"responses\""));
        assert!(config.contains("requires_openai_auth = false"));
        assert!(config.contains("cli_auth_credentials_store = \"file\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(home.join("config.toml"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
        assert!(!home.join("auth.json").exists());
        assert_eq!(
            std::fs::read_to_string(official.join("config.toml")).unwrap(),
            "official-config-sentinel"
        );
        assert_eq!(
            std::fs::read_to_string(official.join("auth.json")).unwrap(),
            "official-auth-sentinel"
        );
        let again = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
            ))
            .then(|| "rotated-key-sentinel".into())
        })
        .unwrap();
        assert_eq!(again.home.as_ref(), Some(&home));
        assert_eq!(again.vars["YAM_PROVIDER_API_KEY"], "rotated-key-sentinel");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&home).unwrap().permissions().mode() & 0o077,
                0
            );
            assert_eq!(
                std::fs::metadata(home.join("config.toml"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
    }

    #[test]
    fn provider_launch_keeps_codex_native_metadata_on_reopen() {
        let fixture = Fixture::new();
        let launch = launch(deepseek());
        let prepared = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "first-key".into())
        })
        .unwrap();
        let path = prepared.home.as_ref().unwrap().join("config.toml");
        let original = std::fs::read_to_string(&path).unwrap();
        let metadata = r#"
    [tui]
    screen_reader_detection_done = true
    [tui.model_availability_nux]
    "gpt-6.1-sol" = 1
    [projects."/tmp/yam-provider-workspace"]
    trust_level = "trusted"
    [hooks.state]
    [hooks.state."/<session-flags>/config.toml:session_start:0:0"]
    trusted_hash = "sha256:287f61eada55c48a197d89224e8deca398d8436a6107572e5ff9d84e251e915f"
    [notice]
    hide_full_access_warning = true
    "#;
        let updated = format!("{original}{metadata}");
        std::fs::write(&path, &updated).unwrap();
        let again = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "rotated-key".into())
        })
        .unwrap();
        assert_eq!(again.home, prepared.home);
        assert_eq!(again.vars["YAM_PROVIDER_API_KEY"], "rotated-key");
        let actual: toml::Value = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut expected: toml::Value = toml::from_str(&updated).unwrap();
        expected["shell_environment_policy"]["set"]["OPENAI_API_KEY"] = "rotated-key".into();
        expected["shell_environment_policy"]["set"]["YAM_PROVIDER_API_KEY"] = "rotated-key".into();
        assert_eq!(actual, expected);
        for tail in [
            "api_key = \"foreign-key\"\n",
            "[model_providers.other]\nbase_url = \"https://other.example\"\n",
            "[tui.evil]\n[mcp_servers.foreign]\ncommand = \"foreign\"\n",
            "[tui_other]\nvalue = true\n",
        ] {
            let invalid = format!("{original}{tail}");
            std::fs::write(&path, &invalid).unwrap();
            assert!(
                super::prepare(&fixture.0, &launch, &|name| (!matches!(
                    name,
                    "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
                ))
                .then(|| "key".into()))
                .is_err(),
                "{tail}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        }
        let changed = updated.replace("https://api.deepseek.com", "https://other.example");
        std::fs::write(&path, changed).unwrap();
        assert!(super::prepare(&fixture.0, &launch, &|name| (!matches!(
            name,
            "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
        ))
        .then(|| "key".into()))
        .is_err());
    }

    #[test]
    fn provider_launch_codex_metadata_rejects_unsafe_files_and_oversize_content() {
        let fixture = Fixture::new();
        let launch = launch(deepseek());
        let prepared = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into())
        })
        .unwrap();
        let path = prepared.home.unwrap().join("config.toml");
        let original = std::fs::read(&path).unwrap();
        let mut invalid_utf8 = original.clone();
        invalid_utf8.extend_from_slice(b"\n[tui]\nvalue = ");
        invalid_utf8.push(0xff);
        let mut oversized = original.clone();
        oversized.extend_from_slice(b"\n[tui]\n#");
        oversized.extend(std::iter::repeat_n(b'x', 1024 * 1024));
        for bytes in [invalid_utf8, oversized] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(super::prepare(&fixture.0, &launch, &|name| (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into()))
            .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        #[cfg(unix)]
        {
            let external = fixture.0.join("unrelated.toml");
            std::fs::write(&external, &original).unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&external, &path).unwrap();
            assert!(super::prepare(&fixture.0, &launch, &|name| (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into()))
            .is_err());
            assert_eq!(std::fs::read(&external).unwrap(), original);
        }
    }

    #[test]
    fn provider_launch_missing_or_invalid_credential_fails_before_filesystem_changes() {
        let fixture = Fixture::new();
        for credential in [
            None,
            Some(String::new()),
            Some("key\nsecret".into()),
            Some("x".repeat(16385)),
        ] {
            let error = super::prepare(&fixture.0, &launch(deepseek()), &|_| credential.clone())
                .err()
                .expect("invalid credentials must be rejected");
            assert!(error.contains("DEEPSEEK_API_KEY"), "{error}");
            assert!(error.contains("background owner"), "{error}");
            assert!(!error.contains("key\nsecret"));
            assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
        }
    }

    #[test]
    fn provider_launch_changed_connection_gets_another_home_and_conflicts_fail_closed() {
        let fixture = Fixture::new();
        let prepared = super::prepare(&fixture.0, &launch(deepseek()), &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into())
        })
        .unwrap();
        let original = prepared.home.unwrap();
        let mut changed = deepseek();
        changed["base_url"] = json!("https://other.example/v1");
        let another = super::prepare(&fixture.0, &launch(changed), &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into())
        })
        .unwrap();
        assert_ne!(another.home.as_ref(), Some(&original));
        std::fs::write(original.join("config.toml"), "foreign-config-sentinel").unwrap();
        assert!(
            super::prepare(&fixture.0, &launch(deepseek()), &|name| (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "key".into()))
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(original.join("config.toml")).unwrap(),
            "foreign-config-sentinel"
        );
    }

    #[test]
    fn provider_launch_local_gateway_uses_only_a_non_upstream_marker() {
        let fixture = Fixture::new();
        let mut gateway = deepseek();
        gateway["base_url"] = json!("http://127.0.0.1:3425/v1");
        gateway["api_key_env"] = Value::Null;
        let prepared = super::prepare(&fixture.0, &launch(gateway), &|name| {
            if matches!(
                name,
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
            ) {
                return None;
            }
            panic!("gateway must not read an upstream key")
        })
        .unwrap();
        assert_eq!(prepared.vars["YAM_PROVIDER_API_KEY"], "yam-local-gateway");
    }

    #[test]
    fn provider_launch_official_preparation_neither_reads_keys_nor_creates_files() {
        let fixture = Fixture::new();
        let mut launch = launch(deepseek());
        launch.provider = None;
        let prepared = super::prepare(&fixture.0, &launch, &|_| {
            panic!("official environment is unchanged")
        })
        .unwrap();
        assert!(prepared.home.is_none());
        assert!(prepared.vars.is_empty());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[test]
    fn provider_launch_actual_owner_checks_missing_key_before_history_or_pty_allocation() {
        let _owner_test = crate::worktree_manager::serial_owner_test();
        let fixture = Fixture::new();
        let mut provider = deepseek();
        provider["api_key_env"] = json!(format!(
            "MISSING_{}",
            crate::next_session_id().replace('-', "_")
        ));
        let manager = crate::SessionManager::default();
        let error = crate::create_session_owner_with_worktree(
            None,
            &manager,
            &fixture.0,
            Some(fixture.0.to_string_lossy().into_owned()),
            None,
            Some(launch(provider)),
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("credential"), "{error}");
        assert!(manager.history.lock().unwrap().is_none());
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[test]
    fn provider_launch_process_and_probe_environments_strip_conflicting_authentication() {
        let fixture = Fixture::new();
        let launch = launch(deepseek());
        let prepared = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "private-key".into())
        })
        .unwrap();
        let mut pty = agent_command(Path::new("codex"), &launch).unwrap();
        pty.env("OPENAI_API_KEY", "official-key-sentinel");
        pty.env("OPENAI_BASE_URL", "https://wrong.example/v1");
        pty.env("OPENAI_ORG_ID", "official-org");
        pty.env("CODEX_HOME", "official-home-sentinel");
        pty.env("KEEP_THIS", "unrelated");
        prepared.apply_pty(&mut pty);
        assert_eq!(pty.get_env("OPENAI_API_KEY").unwrap(), "private-key");
        assert!(pty.get_env("OPENAI_ORG_ID").is_none());
        assert_eq!(
            pty.get_env("OPENAI_BASE_URL").unwrap(),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            pty.get_env("CODEX_HOME").unwrap(),
            prepared.home.as_ref().unwrap().as_os_str()
        );
        assert_eq!(pty.get_env("KEEP_THIS").unwrap(), "unrelated");
        assert!(!format!("{:?}", pty.get_argv()).contains("private-key"));
        let mut probe = std::process::Command::new("codex");
        probe
            .env("OPENAI_API_KEY", "official-key-sentinel")
            .env("OPENAI_BASE_URL", "https://wrong.example/v1")
            .env("CODEX_HOME", "official-home-sentinel");
        prepared.apply_command(&mut probe);
        let env: std::collections::BTreeMap<_, _> = probe
            .get_envs()
            .map(|(k, v)| (k.to_owned(), v.map(ToOwned::to_owned)))
            .collect();
        assert_eq!(
            env.get(std::ffi::OsStr::new("OPENAI_API_KEY")),
            Some(&Some("private-key".into()))
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("OPENAI_BASE_URL")),
            Some(&Some("https://api.deepseek.com/v1".into()))
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("CODEX_HOME")),
            Some(&Some(prepared.home.unwrap().into_os_string()))
        );
    }
    #[test]
    fn provider_continuity_restores_snapshot_and_rotated_env_refs_after_reopen() {
        let fixture = Fixture::new();
        let mut launch = launch(deepseek());
        launch.extra_args = "--no-alt-screen".into();
        let mut value = serde_json::to_value(&launch).unwrap();
        value["env_refs"] = json!({"DEEPSEEK_API_KEY":"OWNER_DEEPSEEK_KEY"});
        let launch: AgentLaunch = serde_json::from_value(value).unwrap();
        let store = crate::HistoryStore::open(fixture.0.join("sessions")).unwrap();
        let summary = crate::SessionSummary {
            ssh: None,
            session_id: "first".into(),
            cwd: fixture.0.to_string_lossy().into(),
            command: None,
            status: "stopped".into(),
            launch: Some(launch),
        };
        store.start(&summary).unwrap();
        store.configure_agent("first", "trusted").unwrap();
        let native = "01a0f6ec-5463-78c3-a404-5a7ad3b933fe";
        store.bind_resume_identity("first", native).unwrap();
        let reopened = crate::HistoryStore::open(fixture.0.join("sessions")).unwrap();
        let (_, launch, id) = crate::resume_source(&reopened, "first").unwrap();
        assert_eq!(id, native);
        assert_eq!(
            serde_json::to_value(&launch).unwrap()["env_refs"],
            json!({"DEEPSEEK_API_KEY":"OWNER_DEEPSEEK_KEY"})
        );
        let env = crate::project_config::resolve_env_refs(&launch.env_refs, &|name| {
            (name == "OWNER_DEEPSEEK_KEY").then(|| "rotated-secret".into())
        })
        .unwrap();
        let prepared = super::prepare(&fixture.0, &launch, &|name| env.get(name).cloned()).unwrap();
        assert_eq!(prepared.vars["YAM_PROVIDER_API_KEY"], "rotated-secret");
        assert!(crate::resume_command(Path::new("codex"), &launch, &id).is_ok());
        assert!(!std::fs::read_to_string(store.records_path())
            .unwrap()
            .contains("rotated-secret"));
        assert!(crate::project_config::resolve_env_refs(&launch.env_refs, &|_| None).is_err());
    }

    #[test]
    fn provider_continuity_archive_restore_keeps_newest_execution() {
        let fixture = Fixture::new();
        let root = fixture.0.join("sessions");
        let store = crate::HistoryStore::open(root.clone()).unwrap();
        let ids = ["s-100-1", "s-100-f", "s-100-10"];
        let mut summary = crate::SessionSummary {
            ssh: None,
            session_id: ids[0].into(),
            cwd: fixture.0.to_string_lossy().into(),
            command: None,
            status: "stopped".into(),
            launch: Some(launch(deepseek())),
        };
        store.start(&summary).unwrap();
        for index in 1..ids.len() {
            summary.session_id = ids[index].into();
            store
                .start_continuation(&summary, Some(ids[index - 1]))
                .unwrap();
        }
        {
            let mut records = store.lock_records().unwrap();
            for record in records.iter_mut() {
                record.started_at = 1;
                record.ended_at = Some(1);
            }
            records.last_mut().unwrap().status = "running".into();
        }
        std::fs::write(store.log_path(ids[0]), "older output").unwrap();
        for id in &ids[..2] {
            store
                .archive(id, &Default::default(), &Default::default())
                .unwrap();
            store.restore_archive(id).unwrap();
            let reopened = crate::HistoryStore::open(root.clone()).unwrap();
            let page = reopened
                .page(crate::history::PageRequest::default())
                .unwrap();
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].summary.session_id, ids[2]);
            assert_eq!(page.items[0].status, "running");
            assert_eq!(page.items[0].previous_runs.len(), 2);
            assert!(page.items[0].previous_runs.contains(&id.to_string()));
        }
        store
            .lock_records()
            .unwrap()
            .iter_mut()
            .find(|r| r.summary.session_id == ids[2])
            .unwrap()
            .status = "stopped".into();
        store
            .archive(ids[2], &Default::default(), &Default::default())
            .unwrap();
        store.restore_archive(ids[2]).unwrap();
        let reopened = crate::HistoryStore::open(root).unwrap();
        assert_eq!(
            reopened
                .page(crate::history::PageRequest::default())
                .unwrap()
                .items[0]
                .summary
                .session_id,
            ids[2]
        );
        assert_eq!(
            std::fs::read_to_string(reopened.log_path(ids[0])).unwrap(),
            "older output"
        );
    }

    #[test]
    fn provider_continuity_groups_runs_and_keeps_execution_logs_after_reopen() {
        let fixture = Fixture::new();
        let store = crate::HistoryStore::open(fixture.0.join("sessions")).unwrap();
        let mut summary = crate::SessionSummary {
            ssh: None,
            session_id: "first".into(),
            cwd: fixture.0.to_string_lossy().into(),
            command: None,
            status: "stopped".into(),
            launch: Some(launch(deepseek())),
        };
        store.start(&summary).unwrap();
        std::fs::write(store.log_path("first"), "previous output").unwrap();
        summary.session_id = "second".into();
        store.start_continuation(&summary, Some("first")).unwrap();
        summary.session_id = "third".into();
        store.start_continuation(&summary, Some("second")).unwrap();
        let reopened = crate::HistoryStore::open(fixture.0.join("sessions")).unwrap();
        let page = reopened
            .page(crate::history::PageRequest::default())
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].summary.session_id, "third");
        assert_eq!(page.items[0].previous_runs, vec!["second", "first"]);
        assert_eq!(
            reopened.get("third").unwrap().conversation_id.as_deref(),
            Some("first")
        );
        assert_eq!(
            std::fs::read_to_string(reopened.log_path("first")).unwrap(),
            "previous output"
        );
        assert!(reopened.get("first").is_ok());
        summary.session_id = "invalid".into();
        assert!(reopened
            .start_continuation(&summary, Some("missing"))
            .is_err());
        assert!(reopened.get("invalid").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn provider_continuity_native_validation_uses_the_managed_environment() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let launch = launch(deepseek());
        let environment = super::prepare(&fixture.0, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "fake-key".into())
        })
        .unwrap();
        let exe = fixture.0.join("fake-codex");
        let native = "01a0f6ec-5463-78c3-a404-5a7ad3b933fe";
        let script = format!(
            r#"#!/bin/sh
[ -f "$CODEX_HOME/config.toml" ] || exit 3
read init
printf '%s\n' '{{"id":1,"result":{{}}}}'
read initialized
read query
case "$query" in
*config/read*) printf '%s\n' '{{"id":2,"result":{{"config":{{"model_provider":"yam_api"}}}}}}';;
*thread/read*) printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"{native}","cwd":{cwd},"modelProvider":"yam_api"}}}}}}';;
esac
read end
"#,
            cwd = serde_json::to_string(&fixture.0.to_string_lossy()).unwrap()
        );
        std::fs::write(&exe, script).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        crate::agent_bridge::validate_resume(&exe, &fixture.0, native, &launch, Some(&environment))
            .unwrap();
        assert!(
            crate::agent_bridge::validate_resume(&exe, &fixture.0, native, &launch, None).is_err()
        );
    }

    #[test]
    fn provider_runners_claude_and_gemini_use_separate_config_and_native_arguments() {
        let fixture = Fixture::new();
        for (id, adapter, config_key, credential_key) in [
            ("claude", "claude", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"),
            ("gemini", "gemini", "GEMINI_CLI_HOME", "GEMINI_API_KEY"),
            ("gemini", "claude", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"),
        ] {
            let mut launch = launch(
                json!({"id":id,"model":"gateway-model","base_url":"http://127.0.0.1:3425","api_key_env":null}),
            );
            launch.adapter = adapter.into();
            let env = super::prepare(&fixture.0, &launch, &|name| {
                if matches!(
                    name,
                    "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
                ) {
                    return None;
                }
                panic!("gateway uses no source credential")
            })
            .unwrap();
            assert!(env.vars.contains_key(config_key));
            assert!(env.vars.contains_key(credential_key));
            assert!(!env.vars.contains_key("CODEX_HOME"));
            assert!(env
                .home
                .as_ref()
                .unwrap()
                .to_string_lossy()
                .contains(adapter));
            let command = crate::agent_command(Path::new(adapter), &launch).unwrap();
            let args: Vec<_> = command
                .get_argv()
                .iter()
                .map(|v| v.to_string_lossy())
                .collect();
            assert!(args
                .windows(2)
                .any(|args| args == ["--model", "gateway-model"]));
            assert!(!args.iter().any(|arg| arg.contains("model_provider")));
        }
        let legacy: AgentLaunch = serde_json::from_value(
            json!({"adapter":"gemini","mode":"task","extra_args":"","prompt":"literal prompt"}),
        )
        .unwrap();
        let command = crate::agent_command(Path::new("gemini"), &legacy).unwrap();
        let args: Vec<_> = command
            .get_argv()
            .iter()
            .map(|v| v.to_string_lossy())
            .collect();
        assert_eq!(
            args,
            [
                "gemini",
                "--output-format",
                "stream-json",
                "--prompt=literal prompt"
            ]
        );
    }

    #[test]
    fn gemini_runner_cannot_override_owner_identity_and_reports_native_results() {
        let mut launch:AgentLaunch=serde_json::from_value(json!({"adapter":"gemini","mode":"interactive","extra_args":"","prompt":"--help $(literal)"})).unwrap();
        let cmd = crate::agent_command(Path::new("gemini"), &launch).unwrap();
        assert_eq!(
            cmd.get_argv().last().unwrap(),
            "--prompt-interactive=--help $(literal)"
        );
        for value in [
            "--resume latest",
            "--session-id 446cd50d-099d-4a12-bcbc-5ab13ffa6944",
            "--session-file /tmp/other",
        ] {
            launch.extra_args = value.into();
            assert!(crate::agent_command(Path::new("gemini"), &launch).is_err());
        }
        let mut protocol = crate::AgentProtocol::new(Some("gemini"));
        protocol.push("{\"type\":\"result\",\"status\":\"success\"}\n");
        assert_eq!(protocol.outcome.as_deref(), Some("succeeded"));
        protocol.push("{\"type\":\"result\",\"status\":\"error\"}\n");
        assert_eq!(protocol.outcome.as_deref(), Some("failed"));
    }

    #[test]
    fn provider_probe_environment_preserves_project_refs_without_reintroducing_official_auth() {
        let fixture = Fixture::new();
        let refs = std::collections::BTreeMap::from([
            ("CODEX_HOME".into(), "/explicit/native-home".into()),
            ("OPENAI_API_KEY".into(), "official-secret".into()),
            ("OPENAI_BASE_URL".into(), "https://wrong.example/v1".into()),
            ("PROJECT_VALUE".into(), "owner-resolved-value".into()),
        ]);
        let managed = super::prepare(&fixture.0, &launch(deepseek()), &|name| {
            (!matches!(
                name,
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE"
            ))
            .then(|| "selected-key".into())
        })
        .unwrap()
        .with_project_env(&refs);
        assert_eq!(managed.vars["PROJECT_VALUE"], "owner-resolved-value");
        assert_eq!(managed.vars["OPENAI_API_KEY"], "selected-key");
        assert_eq!(
            managed.vars["OPENAI_BASE_URL"],
            "https://api.deepseek.com/v1"
        );
        assert_ne!(managed.vars["CODEX_HOME"], "/explicit/native-home");
        let mut official = launch(deepseek());
        official.provider = None;
        let native = super::prepare(&fixture.0, &official, &|_| None)
            .unwrap()
            .with_project_env(&refs);
        assert_eq!(native.vars["CODEX_HOME"], "/explicit/native-home");
        assert_eq!(native.vars["PROJECT_VALUE"], "owner-resolved-value");
    }

    #[test]
    fn provider_project_auth_conflicts_fail_before_start_and_keep_other_settings() {
        let fixture = Fixture::new();
        std::fs::create_dir(fixture.0.join(".git")).unwrap();
        std::fs::create_dir(fixture.0.join(".claude")).unwrap();
        std::fs::create_dir(fixture.0.join("nested")).unwrap();
        let mut launch = launch(
            json!({"id":"claude","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        let config = fixture.0.join(".claude/settings.json");
        for value in [
            json!({"env":{"ANTHROPIC_BASE_URL":"https://another.example"}}),
            json!({"apiKeyHelper":"do-not-run"}),
            json!({"forceLoginMethod":"claudeai"}),
        ] {
            std::fs::write(&config, value.to_string()).unwrap();
            assert!(super::validate_project(&launch, &fixture.0.join("nested")).is_err());
        }
        let normal =
            json!({"permissions":{"deny":["Bash"]},"env":{"PROJECT_VALUE":"allowed"}}).to_string();
        std::fs::write(&config, &normal).unwrap();
        super::validate_project(&launch, &fixture.0).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), normal);
        std::fs::write(&config, "invalid json").unwrap();
        assert!(super::validate_project(&launch, &fixture.0).is_err());
        launch.provider = None;
        super::validate_project(&launch, &fixture.0).unwrap();
        launch.adapter = "gemini".into();
        launch.provider=Some(serde_json::from_value(json!({"id":"gemini","model":"gemini-3-flash-preview","base_url":"http://127.0.0.1:3425","api_key_env":null})).unwrap());
        std::fs::create_dir(fixture.0.join(".gemini")).unwrap();
        std::fs::write(
            fixture.0.join(".gemini/settings.json"),
            r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#,
        )
        .unwrap();
        assert!(super::validate_project(&launch, &fixture.0).is_err());
    }
    #[test]
    fn provider_explicit_project_auth_refs_are_conflicts_except_the_selected_key_reference() {
        let fixture = Fixture::new();
        let mut managed = launch(deepseek());
        for target in ["CODEX_HOME", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] {
            managed.env_refs =
                std::collections::BTreeMap::from([(target.into(), "OWNER_VALUE".into())]);
            assert!(
                super::validate_project(&managed, &fixture.0).is_err(),
                "{target}"
            );
        }
        managed.env_refs =
            std::collections::BTreeMap::from([("DEEPSEEK_API_KEY".into(), "OWNER_VALUE".into())]);
        super::validate_project(&managed, &fixture.0).unwrap();
    }
    #[test]
    fn provider_native_storage_resolution_uses_effective_home_and_explicit_cli_directory() {
        let fixture = Fixture::new();
        let mut native = launch(deepseek());
        native.provider = None;
        let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let refs = std::collections::BTreeMap::from([
            (
                variable.into(),
                fixture.0.join("alternate").to_string_lossy().into(),
            ),
            ("CLAUDE_CONFIG_DIR".into(), "".into()),
            ("GEMINI_CLI_HOME".into(), "".into()),
        ]);
        let environment = super::prepare(&fixture.0, &native, &|_| None)
            .unwrap()
            .with_project_env(&refs);
        assert_eq!(
            environment.config_root("claude", &fixture.0, Path::new("/desktop-home")),
            fixture.0.join("alternate/.claude")
        );
        assert_eq!(
            environment.config_root("gemini", &fixture.0, Path::new("/desktop-home")),
            fixture.0.join("alternate/.gemini")
        );
        let environment = super::prepare(&fixture.0, &native, &|_| None)
            .unwrap()
            .with_project_env(&std::collections::BTreeMap::from([(
                "CLAUDE_CONFIG_DIR".into(),
                "relative-store".into(),
            )]));
        assert_eq!(
            environment.config_root("claude", &fixture.0, Path::new("/desktop-home")),
            fixture.0.join("relative-store")
        );
    }
    #[test]
    fn inherited_codex_context_preserves_config_and_isolates_auth() {
        let fixture = Fixture::new();
        let source = fixture.0.join("original");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(
            source.join("config.toml"),
            r#"model = "old"
model_provider = "old_provider"
web_search = "cached"
[features]
multi_agent = true
[mcp_servers.example]
command = "node"
args = ["example.js"]
[profiles.work]
model_provider = "old_provider"
"#,
        )
        .unwrap();
        std::fs::write(source.join("AGENTS.md"), "Original instructions").unwrap();
        std::fs::write(
            source.join("auth.json"),
            r#"{"tokens":{"access_token":"desktop-only"}}"#,
        )
        .unwrap();
        std::fs::create_dir(source.join("skills")).unwrap();
        std::fs::write(source.join("skills/example.md"), "original skill").unwrap();
        let launch: AgentLaunch = serde_json::from_value(json!({
            "adapter":"codex","mode":"interactive","extra_args":"","prompt":null,
            "provider":{"id":"codex","model":"gateway-model","base_url":"http://127.0.0.1:3425","api_key_env":null},
            "codex":{"image_mode":"native","context":"0123456789abcdef0123456789abcdef"}
        })).unwrap();
        let env = super::prepare(&fixture.0, &launch, &|name| match name {
            "CODEX_HOME" => Some(source.to_string_lossy().into_owned()),
            _ => None,
        })
        .unwrap();
        let home = env.home.as_ref().unwrap();
        let config = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("multi_agent = true"));
        assert!(config.contains("[mcp_servers.example]"));
        assert!(config.contains("web_search = \"cached\""));
        assert!(!config.contains("old_provider"));
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "Original instructions"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("skills/example.md")).unwrap(),
            "original skill"
        );
        let auth = std::fs::read_to_string(home.join("auth.json")).unwrap();
        assert!(auth.contains("yam-local-gateway"));
        assert!(!auth.contains("desktop-only"));
        assert_eq!(env.vars["OPENAI_BASE_URL"], "http://127.0.0.1:3425/v1");
        assert_eq!(env.vars["CODEX_API_KEY"], "yam-local-gateway");
        env.validate_before_spawn().unwrap();
        let original = std::fs::read_to_string(source.join("config.toml")).unwrap();
        assert!(original.contains("old_provider"));
        assert!(std::fs::read_to_string(source.join("auth.json"))
            .unwrap()
            .contains("desktop-only"));
        let saved: AgentLaunch =
            serde_json::from_value(serde_json::to_value(&launch).unwrap()).unwrap();
        assert_eq!(
            super::existing_home(&fixture.0, &saved).unwrap(),
            home.canonicalize().unwrap()
        );
        std::fs::write(source.join("AGENTS.md"), "Changed original").unwrap();
        let resumed = super::prepare(&fixture.0, &saved, &|_| None).unwrap();
        assert_eq!(resumed.home.as_ref(), Some(home));
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "Changed original"
        );
        resumed.validate_before_spawn().unwrap();
    }
    #[test]
    fn fidelity_environment_preserves_reasoning_for_pty_probe_and_project_refs() {
        for adapter in ["codex", "claude", "gemini"] {
            let f = Fixture::new();
            let mut launch = launch(
                json!({"id":"custom","model":"test-model","base_url":"http://127.0.0.1:3425/v1","api_key_env":null}),
            );
            launch.adapter = adapter.into();
            let env = super::prepare(&f.0, &launch, &|_| None).unwrap();
            let options: std::collections::BTreeMap<String, String> =
                std::collections::BTreeMap::from([
                    ("CLAUDE_CODE_EFFORT_LEVEL".into(), "max".into()),
                    ("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), "64000".into()),
                    ("CODEX_FEATURE_FLAG_FIXTURE".into(), "enabled".into()),
                    ("GEMINI_MODEL".into(), "custom-model".into()),
                    ("OPENAI_API_KEY".into(), "stale-key".into()),
                    ("ANTHROPIC_AUTH_TOKEN".into(), "stale-auth".into()),
                ]);
            let mut pty = agent_command(Path::new(adapter), &launch).unwrap();
            let mut probe = std::process::Command::new(adapter);
            for (key, value) in &options {
                pty.env(key, value);
                probe.env(key, value);
            }
            env.apply_pty(&mut pty);
            env.apply_command(&mut probe);
            let probe_env: std::collections::BTreeMap<_, _> = probe.get_envs().collect();
            for key in [
                "CLAUDE_CODE_EFFORT_LEVEL",
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
                "CODEX_FEATURE_FLAG_FIXTURE",
                "GEMINI_MODEL",
            ] {
                assert_eq!(
                    pty.get_env(key).and_then(|v| v.to_str()),
                    Some(options[key].as_str()),
                    "{adapter}: {key}"
                );
                assert_eq!(
                    probe_env.get(std::ffi::OsStr::new(key)),
                    Some(&Some(std::ffi::OsStr::new(&options[key])))
                );
            }
            assert!(pty.get_env("ANTHROPIC_AUTH_TOKEN").is_none());
            assert_ne!(
                pty.get_env("OPENAI_API_KEY").and_then(|v| v.to_str()),
                Some("stale-key")
            );
            let env = env.with_project_env(&options);
            assert_eq!(
                env.vars.get("CLAUDE_CODE_EFFORT_LEVEL").map(String::as_str),
                Some("max")
            );
            assert!(!env.vars.contains_key("ANTHROPIC_AUTH_TOKEN"));
        }
    }

    #[test]
    fn fidelity_environment_claude_settings_keep_effort_without_auth_override() {
        let f = Fixture::new();
        let source = f.0.join("original");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("settings.json"), json!({"env":{"CLAUDE_CODE_EFFORT_LEVEL":"xhigh","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"32000","ANTHROPIC_AUTH_TOKEN":"stale-auth","CLAUDE_CODE_USE_BEDROCK":"1"}}).to_string()).unwrap();
        let mut launch = launch(
            json!({"id":"custom","model":"test","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        let env = super::prepare(&f.0, &launch, &|name| {
            (name == "CLAUDE_CONFIG_DIR").then(|| source.to_string_lossy().into_owned())
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(env.home.unwrap().join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "xhigh");
        assert_eq!(value["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "32000");
        assert!(value["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(value["env"].get("CLAUDE_CODE_USE_BEDROCK").is_none());
    }

    #[test]
    fn fidelity_environment_accepts_project_reasoning_but_rejects_authentication() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join(".claude")).unwrap();
        let path = f.0.join(".claude/settings.json");
        let mut launch = launch(
            json!({"id":"custom","model":"test","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        std::fs::write(&path, json!({"env":{"CLAUDE_CODE_EFFORT_LEVEL":"high","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"32000"}}).to_string()).unwrap();
        assert!(super::validate_project(&launch, &f.0).is_ok());
        std::fs::write(
            &path,
            json!({"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}).to_string(),
        )
        .unwrap();
        assert!(super::validate_project(&launch, &f.0).is_err());
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "GEMINI_API_KEY",
            "GOOGLE_GENAI_USE_VERTEXAI",
        ] {
            assert!(super::conflicting_env(key), "{key}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn review_claude_native_diagnostics_and_multiple_directories_keep_hooks_and_resume() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let executable = fixture.0.join("fake-claude");
        std::fs::write(
            &executable,
            b"#!/bin/sh\nprintf '2.1.307 (Claude Code)\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        for args in [
            "--debug-file debug",
            "--debug=hooks",
            "--debug mcp",
            "--add-dir /tmp /var/tmp --debug=hooks",
            "--allowedTools Read Edit --disallowedTools Bash",
            "--setting-sources '' --debug=hooks",
        ] {
            for managed in [false, true] {
                let mut launch = launch(
                    json!({"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
                );
                launch.adapter = "claude".into();
                launch.extra_args = args.into();
                if !managed {
                    launch.provider = None;
                }
                assert!(agent_command(&executable, &launch).is_ok(), "start: {args}");
                assert!(
                    crate::agent_bridge::prepare(
                        &executable,
                        &launch,
                        &fixture.0,
                        &fixture.0,
                        None
                    )
                    .is_ok(),
                    "hooks: {args}"
                );
                assert!(
                    crate::resume_command(
                        &executable,
                        &launch,
                        "01a0f6ec-5463-78c3-a404-5a7ad3b933fe"
                    )
                    .is_ok(),
                    "resume: {args}"
                );
            }
        }
    }

    #[test]
    fn review_claude_conflicting_modes_do_not_gain_hook_integration() {
        for args in [
            "--bare",
            "--safe-mode",
            "--print",
            "--resume foreign",
            "--continue",
            "--session-id foreign",
            "--plugin-dir /tmp auth",
            "--add-dir /tmp /var/tmp --resume foreign",
            "--allowedTools Read --print",
        ] {
            assert!(
                crate::agent_bridge::validate_interactive_args(
                    "claude",
                    &crate::parse_agent_args(args).unwrap()
                )
                .is_err(),
                "{args}"
            );
        }
    }

    #[test]
    fn review_gemini_ordinary_arguments_keep_start_and_resume_identity_boundaries() {
        for args in [
            "--include-directories /tmp",
            "--include-directories /tmp,/var/tmp",
            "--include-directories /tmp --include-directories /var/tmp",
            "--include-directories debug",
            "--extensions extension-one,extension-two",
            "--sandbox",
            "-s --extensions auth",
            "--policy mcp --allowed-tools Read --approval-mode plan",
            "--model native-model --include-directories /tmp",
        ] {
            for managed in [false, true] {
                let mut launch = launch(
                    json!({"id":"gemini","model":"fixture","base_url":"http://127.0.0.1:3425","api_key_env":null}),
                );
                launch.adapter = "gemini".into();
                launch.extra_args = args.into();
                if !managed {
                    launch.provider = None;
                }
                assert!(
                    agent_command(Path::new("gemini"), &launch).is_ok(),
                    "start: {args}"
                );
                assert!(
                    crate::resume_command(
                        Path::new("gemini"),
                        &launch,
                        "01a0f6ec-5463-78c3-a404-5a7ad3b933fe"
                    )
                    .is_ok(),
                    "resume: {args}"
                );
            }
        }
        let mut launch = launch(
            json!({"id":"gemini","model":"fixture","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "gemini".into();
        for args in [
            "--resume foreign",
            "--session-id foreign",
            "--remote ws://127.0.0.1:1",
            "--include-directories /tmp mcp list",
            "--session-file /tmp/other",
            "--output-format json",
            "-ojson",
            "--prompt foreign",
            "-pforeign",
            "--prompt-interactive foreign",
            "-iforeign",
            "--acp",
            "--experimental-acp",
            "--list-sessions",
            "--delete-session 1",
            "--list-extensions",
            "-l",
            "extensions list",
            "skills list",
            "hooks list",
            "gemma list",
        ] {
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("gemini"), &launch).is_err(),
                "{args}"
            );
            assert!(
                crate::resume_command(
                    Path::new("gemini"),
                    &launch,
                    "01a0f6ec-5463-78c3-a404-5a7ad3b933fe"
                )
                .is_err(),
                "{args}"
            );
        }
    }

    #[test]
    fn transparency_claude_explicit_model_environment_survives_gateway_defaults() {
        for explicit in [Some("native-child[1m]"), Some(""), None] {
            let fixture = Fixture::new();
            let mut launch = launch(deepseek());
            launch.adapter = "claude".into();
            launch.provider.as_mut().unwrap().base_url = "http://127.0.0.1:3425".into();
            let environment = super::prepare(&fixture.0, &launch, &|name| match name {
                "DEEPSEEK_API_KEY" => Some("synthetic-gateway-key".into()),
                "ANTHROPIC_DEFAULT_HAIKU_MODEL" | "CLAUDE_CODE_SUBAGENT_MODEL" => {
                    explicit.map(str::to_owned)
                }
                _ => None,
            })
            .unwrap();
            for key in [
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                assert_eq!(
                    environment.vars[key],
                    explicit.unwrap_or("deepseek-flash"),
                    "{key}"
                );
            }
            assert_eq!(
                environment.vars["ANTHROPIC_DEFAULT_SONNET_MODEL"],
                "deepseek-flash"
            );
            assert_eq!(
                environment.vars["ANTHROPIC_API_KEY"],
                "synthetic-gateway-key"
            );
            let mut command = std::process::Command::new("claude");
            environment.apply_command(&mut command);
            let actual: std::collections::BTreeMap<_, _> = command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect();
            assert_eq!(
                actual["CLAUDE_CODE_SUBAGENT_MODEL"].as_deref(),
                Some(explicit.unwrap_or("deepseek-flash"))
            );
        }
    }

    #[test]
    fn transparency_model_explicit_choices_keep_native_arguments_hooks_and_resume() {
        for (adapter, args) in [
            ("codex", "--model explicit-model"),
            ("codex", "-mexplicit-model"),
            ("codex", "-c='model=\"explicit-model\"'"),
            ("codex", "--model=explicit-model"),
            ("codex", "-c model=\"explicit-model\""),
            ("codex", "--config='\"model\"=\"explicit-model\"'"),
            ("codex", "--profile review"),
            ("codex", "-preview"),
            ("claude", "--model explicit-model --effort high"),
            ("claude", "--model=explicit-model"),
        ] {
            for inherited in [false, true] {
                let mut launch = launch(
                    json!({"id":"custom","model":"yam-default","base_url":"http://127.0.0.1:3425","api_key_env":null}),
                );
                launch.adapter = adapter.into();
                launch.extra_args = args.into();
                if inherited && adapter == "codex" {
                    launch.codex =
                        Some(serde_json::from_value(json!({"image_mode":"native"})).unwrap());
                }
                let command = agent_command(Path::new(adapter), &launch).unwrap();
                let actual: Vec<_> = command
                    .get_argv()
                    .iter()
                    .map(|v| v.to_string_lossy().into_owned())
                    .collect();
                let original = crate::parse_agent_args(args).unwrap();
                assert!(
                    actual.ends_with(&original),
                    "native argument order changed: {actual:?}"
                );
                assert!(
                    !actual
                        .iter()
                        .any(|v| v == "yam-default" || v == "model=\"yam-default\""),
                    "YAM must not force its model above an explicit native selection: {actual:?}"
                );
                crate::agent_bridge::validate_interactive_args(adapter, &original).unwrap();
                assert!(crate::resume_command(
                    Path::new(adapter),
                    &launch,
                    "01a0f6ec-5463-78c3-a404-5a7ad3b933fe"
                )
                .is_ok());
            }
        }
    }

    #[test]
    fn transparency_model_default_and_gateway_resume_boundaries_remain_available() {
        let mut launch = launch(
            json!({"id":"custom","model":"yam-default","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        assert!(format!(
            "{:?}",
            agent_command(Path::new("codex"), &launch)
                .unwrap()
                .get_argv()
        )
        .contains("yam-default"));
        for args in [
            "--resume foreign",
            "--cd /tmp",
            "-c model_provider=foreign",
            "--remote ws://127.0.0.1:1",
        ] {
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("codex"), &launch).is_err(),
                "{args}"
            );
        }
    }

    #[test]
    fn fidelity_arguments_native_configuration_reaches_official_cli() {
        for args in [
            "-c 'model_reasoning_effort=\"high\"'",
            "--config=model_reasoning_summary=auto",
            "--profile deep-review",
            "-pdeep-review",
            "--enable multi_agent --disable fast_mode",
            "--search",
            "--future-native-feature=value",
        ] {
            let mut launch = launch(deepseek());
            launch.extra_args = args.into();
            let command = agent_command(Path::new("codex"), &launch)
                .unwrap_or_else(|error| panic!("{args}: {error}"));
            let actual: Vec<_> = command
                .get_argv()
                .iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect();
            for value in crate::parse_agent_args(args).unwrap() {
                assert!(actual.contains(&value), "{value}");
            }
        }
        let mut launch = launch(
            json!({"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        for args in [
            "--effort xhigh --add-dir /tmp/extra --agent reviewer",
            "--plugin-dir /tmp/plugins",
            "--settings '{\"effortLevel\":\"max\"}'",
        ] {
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("claude"), &launch).is_ok(),
                "{args}"
            );
        }
    }

    #[test]
    fn fidelity_arguments_managed_connection_cannot_be_overridden() {
        for args in [
            "-c 'model_provider=\"other\"'",
            "--config '\"model_provider\"=\"other\"'",
            "--config 'agents.review.config_file=\"/tmp/other.toml\"'",
            "--config 'shell_environment_policy.inherit=\"none\"'",
            "--config 'agents.review={config_file=\"/tmp/other.toml\"}'",
            "--config 'profiles.x={model_provider=\"other\"}'",
            "--profile ../../escape",
            "-p../../escape",
            "-rUUID",
            "-wfoo",
            "--remote ws://localhost:1",
            "--cd /tmp",
            "-C/tmp",
            "--worktree",
            "resume other",
            "--continue",
            "--session-id another",
            "--config",
        ] {
            let mut launch = launch(deepseek());
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("codex"), &launch).is_err(),
                "{args}"
            );
        }
        let mut launch = launch(
            json!({"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        for args in [
            "--settings '{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"other\"}}'",
            "--settings '{\"apiKeyHelper\":\"other\"}'",
            "--resume other",
            "--session-id another",
        ] {
            launch.extra_args = args.into();
            assert!(
                agent_command(Path::new("claude"), &launch).is_err(),
                "{args}"
            );
        }
    }

    #[test]
    fn fidelity_arguments_file_settings_resolve_at_project_boundary() {
        let f = Fixture::new();
        let mut launch = launch(
            json!({"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
        );
        launch.adapter = "claude".into();
        launch.extra_args = "--settings extra.json".into();
        let path = f.0.join("extra.json");
        std::fs::write(&path, r#"{"effortLevel":"max"}"#).unwrap();
        assert!(super::validate_project(&launch, &f.0).is_ok());
        std::fs::write(&path, r#"{"apiKeyHelper":"other"}"#).unwrap();
        assert!(super::validate_project(&launch, &f.0).is_err());
    }
    fn fidelity_legacy_fixture(f: &Fixture, launch: &crate::AgentLaunch) -> std::path::PathBuf {
        use std::io::Write;
        let (connection, home) = super::managed_home(&f.0, launch).unwrap();
        for path in [
            f.0.clone(),
            f.0.join("providers"),
            f.0.join("providers/codex"),
            home.clone(),
        ] {
            crate::background::private_root(&path).unwrap();
        }
        let mut config =
            super::codex_config(launch.provider.as_ref().unwrap(), &connection).unwrap();
        config.push_str("\n[tui]\nnotifications = false\n[projects.\"/legacy/project\"]\ntrust_level = \"trusted\"\n");
        crate::background::private_file(&home.join("config.toml"), true)
            .unwrap()
            .write_all(config.as_bytes())
            .unwrap();
        crate::background::private_file(&home.join("AGENTS.md"), true)
            .unwrap()
            .write_all(super::IMAGE_API_INSTRUCTIONS.as_bytes())
            .unwrap();
        std::fs::create_dir(home.join("sessions")).unwrap();
        std::fs::write(
            home.join("sessions/rollout.jsonl"),
            "same-native-id-and-history",
        )
        .unwrap();
        std::fs::write(home.join("state_5.sqlite"), "same-native-database").unwrap();
        home
    }

    #[test]
    fn fidelity_legacy_new_launches_normalize_to_native_inheritance() {
        let mut launch = launch(deepseek());
        assert!(launch.codex.is_none());
        crate::codex_context::assign_context(&mut launch).unwrap();
        let options = launch.codex.unwrap();
        assert_eq!(options.image_mode, crate::codex_context::ImageMode::Native);
        assert!(options.context.is_some());
    }

    #[test]
    fn fidelity_legacy_inherits_capabilities_without_moving_history_or_changing_provider() {
        let f = Fixture::new();
        let launch = launch(deepseek());
        let home = fidelity_legacy_fixture(&f, &launch);
        let original = f.0.join("original");
        std::fs::create_dir_all(original.join("skills/fixture")).unwrap();
        std::fs::write(original.join("skills/fixture/SKILL.md"), "native-skill").unwrap();
        std::fs::write(original.join("AGENTS.md"), "original-user-policy").unwrap();
        std::fs::write(original.join("auth.json"), "must-not-copy-account").unwrap();
        std::fs::write(original.join("config.toml"), "model_reasoning_effort='high'\nweb_search='live'\nsqlite_home='/must-not-use-global-store'\n[features]\nmulti_agent=true\n[mcp_servers.fixture]\ncommand='/usr/bin/false'\n[agents.reviewer]\nconfig_file='reviewer.toml'\n").unwrap();
        std::fs::write(
            original.join("reviewer.toml"),
            "model='role-model'\nmodel_reasoning_effort='xhigh'\n",
        )
        .unwrap();
        std::fs::write(
            original.join("review.config.toml"),
            "model_reasoning_effort='xhigh'\n",
        )
        .unwrap();
        let saved = serde_json::to_value(&launch).unwrap();
        let prepare = |key: &str| {
            super::prepare(&f.0, &launch, &|name| match name {
                "CODEX_HOME" => Some(original.to_string_lossy().into_owned()),
                "DEEPSEEK_API_KEY" => Some(key.into()),
                _ => None,
            })
            .unwrap()
        };
        let env = prepare("first-key");
        assert_eq!(env.home.as_ref(), Some(&home));
        let config: toml::Value =
            toml::from_str(&std::fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["model_provider"].as_str(), Some("yam_api"));
        assert_eq!(
            config["sqlite_home"].as_str(),
            Some(home.to_string_lossy().as_ref())
        );
        assert_eq!(config["model_reasoning_effort"].as_str(), Some("high"));
        assert_eq!(config["web_search"].as_str(), Some("live"));
        assert_eq!(config["features"]["multi_agent"].as_bool(), Some(true));
        assert_eq!(
            config["mcp_servers"]["fixture"]["command"].as_str(),
            Some("/usr/bin/false")
        );
        assert_eq!(
            config["projects"]["/legacy/project"]["trust_level"].as_str(),
            Some("trusted")
        );
        assert_eq!(config["tui"]["notifications"].as_bool(), Some(false));
        assert!(std::fs::read_to_string(home.join("AGENTS.md"))
            .unwrap()
            .contains("original-user-policy"));
        assert_eq!(
            std::fs::read_to_string(home.join("skills/fixture/SKILL.md")).unwrap(),
            "native-skill"
        );
        let profile: toml::Value =
            toml::from_str(&std::fs::read_to_string(home.join("review.config.toml")).unwrap())
                .unwrap();
        assert_eq!(profile["model_reasoning_effort"].as_str(), Some("xhigh"));
        assert_eq!(profile["model_provider"].as_str(), Some("yam_api"));
        let role_path = config["agents"]["reviewer"]["config_file"]
            .as_str()
            .unwrap();
        let role: toml::Value =
            toml::from_str(&std::fs::read_to_string(role_path).unwrap()).unwrap();
        assert_eq!(role["model"].as_str(), Some("role-model"));
        assert_eq!(role["model_provider"].as_str(), Some("yam_api"));
        assert!(!home.join("auth.json").exists());
        let resumed = prepare("rotated-key");
        resumed.validate_before_spawn().unwrap();
        assert_eq!(resumed.vars["OPENAI_API_KEY"], "rotated-key");
        let current: toml::Value =
            toml::from_str(&std::fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(
            current["shell_environment_policy"]["set"]["OPENAI_API_KEY"].as_str(),
            Some("rotated-key")
        );
        assert_eq!(serde_json::to_value(&launch).unwrap(), saved);
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/rollout.jsonl")).unwrap(),
            "same-native-id-and-history"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("state_5.sqlite")).unwrap(),
            "same-native-database"
        );
        assert_eq!(
            super::existing_home(&f.0, &launch).unwrap(),
            home.canonicalize().unwrap()
        );
        assert!(!launch
            .provider
            .as_ref()
            .unwrap()
            .command_overrides("codex")
            .unwrap()
            .iter()
            .any(|arg| arg.starts_with("web_search=")));
        std::fs::write(home.join("config.toml"), "model_provider='other'\n").unwrap();
        assert!(
            super::prepare(&f.0, &launch, &|name| (name == "DEEPSEEK_API_KEY")
                .then(|| "rotated-key".into()))
            .is_err()
        );
    }

    #[test]
    fn fidelity_legacy_failed_upgrade_preserves_old_configuration_and_native_history() {
        let f = Fixture::new();
        let launch = launch(deepseek());
        let home = fidelity_legacy_fixture(&f, &launch);
        let before = std::fs::read(home.join("config.toml")).unwrap();
        let original = f.0.join("original");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("config.toml"), "invalid = [").unwrap();
        assert!(super::prepare(&f.0, &launch, &|name| match name {
            "CODEX_HOME" => Some(original.to_string_lossy().into_owned()),
            "DEEPSEEK_API_KEY" => Some("key".into()),
            _ => None,
        })
        .is_err());
        assert_eq!(std::fs::read(home.join("config.toml")).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/rollout.jsonl")).unwrap(),
            "same-native-id-and-history"
        );
        assert!(!home.join("yam-config.toml").exists());
    }
    #[test]
    fn fidelity_legacy_project_routes_are_checked_before_native_preparation() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join(".codex")).unwrap();
        let path = f.0.join(".codex/config.toml");
        let mut provider = deepseek();
        provider["api_key_env"] = json!(format!(
            "MISSING_{}",
            crate::next_session_id().replace('-', "_")
        ));
        let launch = launch(provider);
        std::fs::write(&path, "model_provider='other'\n").unwrap();
        let manager = crate::SessionManager::default();
        let _serial = crate::worktree_manager::serial_owner_test();
        let error = crate::create_session_owner_with_worktree(
            None,
            &manager,
            &f.0,
            Some(f.0.to_string_lossy().into_owned()),
            None,
            Some(launch.clone()),
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("Project Codex configuration"), "{error}");
        assert!(super::validate_project(&launch, &f.0).is_err());
        std::fs::write(
            &path,
            "model_provider='yam_api'\nmodel_reasoning_effort='high'\n",
        )
        .unwrap();
        assert!(super::validate_project(&launch, &f.0).is_ok());
        std::fs::write(
            &path,
            "[model_providers.yam_api]\nbase_url='http://127.0.0.1:1'\n",
        )
        .unwrap();
        assert!(super::validate_project(&launch, &f.0).is_err());
    }
    #[test]
    fn fidelity_claude_current_auth_routes_cannot_override_host_configuration() {
        for key in [
            "ANTHROPIC_UNIX_SOCKET",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
            "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
            "CLAUDE_CODE_USE_MANTLE",
            "ANTHROPIC_AWS_BASE_URL",
            "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
            "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
            "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
            "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
            "CLAUDE_CODE_HOST_CREDS_FILE",
            "ANTHROPIC_PROFILE",
            "ANTHROPIC_CONFIG_DIR",
        ] {
            assert!(super::conflicting_env(key), "{key}");
            let f = Fixture::new();
            let source = f.0.join("original");
            std::fs::create_dir(&source).unwrap();
            std::fs::write(
                source.join("settings.json"),
                json!({"env":{key:"alternate"},"effortLevel":"xhigh"}).to_string(),
            )
            .unwrap();
            let mut launch = launch(
                json!({"id":"custom","model":"sonnet","base_url":"http://127.0.0.1:3425","api_key_env":null}),
            );
            launch.adapter = "claude".into();
            let env = super::prepare(&f.0, &launch, &|name| {
                (name == "CLAUDE_CONFIG_DIR").then(|| source.to_string_lossy().into_owned())
            })
            .unwrap();
            let mut pty = crate::agent_command(Path::new("claude"), &launch).unwrap();
            let mut probe = std::process::Command::new("claude");
            pty.env(key, "alternate");
            probe.env(key, "alternate");
            env.apply_pty(&mut pty);
            env.apply_command(&mut probe);
            assert_ne!(pty.get_env(key).and_then(|v| v.to_str()), Some("alternate"));
            assert_ne!(
                probe
                    .get_envs()
                    .find(|(k, _)| k == &std::ffi::OsStr::new(key))
                    .and_then(|(_, v)| v)
                    .and_then(|v| v.to_str()),
                Some("alternate")
            );
            let current: serde_json::Value = serde_json::from_slice(
                &std::fs::read(env.home.as_ref().unwrap().join("settings.json")).unwrap(),
            )
            .unwrap();
            assert!(current["env"].get(key).is_none(), "{key}");
            launch.extra_args = format!("--settings '{}'", json!({"env":{key:"alternate"}}));
            assert!(
                crate::agent_command(Path::new("claude"), &launch).is_err(),
                "{key}"
            );
        }
    }
}

#[cfg(test)]
mod readonly_home_tests {
    #[test]
    fn provider_launch_existing_home_never_creates_or_resolves_credentials() {
        let root = std::env::temp_dir().join(format!(
            "yam-home-{}",
            crate::agent_bridge::credential().unwrap()
        ));
        let launch:crate::AgentLaunch=serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","prompt":"","extra_args":"","provider":{"id":"custom","model":"test","base_url":"http://127.0.0.1:9876/v1","api_key_env":"NEVER_RESOLVE"}})).unwrap();
        assert!(super::existing_home(&root, &launch).is_err());
        assert!(!root.exists());
        let env = super::prepare(&root, &launch, &|name| {
            (!matches!(
                name,
                "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "HOME" | "USERPROFILE"
            ))
            .then(|| "synthetic-key".into())
        })
        .unwrap();
        let home = env.home.unwrap().canonicalize().unwrap();
        assert_eq!(super::existing_home(&root, &launch).unwrap(), home);
        let path = home.join("config.toml");
        let before = std::fs::read(&path).unwrap();
        assert_eq!(super::existing_home(&root, &launch).unwrap(), home);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, "changed").unwrap();
        assert!(super::existing_home(&root, &launch).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"changed");
        std::fs::remove_dir_all(root).unwrap();
    }
}
