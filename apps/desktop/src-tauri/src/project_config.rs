// Author: Jeff.Liu. Bounded project settings; trust and launch are separate actions.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
const MAX_SOURCE: usize = 65536;
const MAX_STORE: usize = 1024 * 1024;
static CONFIG_GATE: Mutex<()> = Mutex::new(());
static CONFIG_COUNTER: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct LaunchSettings(pub BTreeMap<String, Value>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preview {
    pub root: String,
    pub identity: String,
    pub source: String,
    pub config: Option<Value>,
    pub trusted: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectStart {
    pub root: String,
    pub template: Option<String>,
    pub overrides: LaunchSettings,
}
pub(crate) struct PreparedLaunch {
    pub cwd: PathBuf,
    pub launch: Option<crate::AgentLaunch>,
    pub command: Option<String>,
    pub env: BTreeMap<String, String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    global: LaunchSettings,
    trusted: Vec<Preview>,
}
fn code(value: &str) -> String {
    value.into()
}
fn reserved(name: &str) -> bool {
    name.to_ascii_uppercase().starts_with("YAM_")
}
fn variable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}
fn validate_settings(value: &Value, template: bool) -> Result<(), String> {
    let fields = value
        .as_object()
        .ok_or_else(|| code("project_config_invalid"))?;
    for (key, value) in fields {
        if key == "name" && template {
            if value.as_str().is_none_or(|name| {
                name.trim().is_empty()
                    || name.chars().count() > 100
                    || name.chars().any(char::is_control)
            }) {
                return Err(code("project_config_invalid"));
            }
            continue;
        }
        if ![
            "adapter",
            "mode",
            "extra_args",
            "prompt",
            "command",
            "cwd",
            "env",
        ]
        .contains(&key.as_str())
        {
            return Err(code("project_config_invalid"));
        }
        if key == "env" {
            let env = value
                .as_object()
                .ok_or_else(|| code("project_config_invalid"))?;
            if env.len() > 32 {
                return Err(code("project_config_invalid"));
            }
            for (target, source) in env {
                let source = source
                    .as_str()
                    .ok_or_else(|| code("project_config_invalid"))?;
                if !variable(target) || !variable(source) {
                    return Err(code("project_config_invalid"));
                }
                if reserved(target) || reserved(source) {
                    return Err(code("project_config_reserved_env"));
                }
            }
        } else if !((key == "prompt" || key == "command") && value.is_null()) {
            let text = value
                .as_str()
                .ok_or_else(|| code("project_config_invalid"))?;
            if text.contains('\0') || text.len() > MAX_SOURCE {
                return Err(code("project_config_invalid"));
            }
            if key == "adapter"
                && !["shell", "custom", "codex", "claude", "opencode"].contains(&text)
            {
                return Err(code("project_config_invalid"));
            }
            if key == "mode" && !["task", "interactive"].contains(&text) {
                return Err(code("project_config_invalid"));
            }
            if key == "extra_args" {
                crate::parse_agent_args(text).map_err(|_| code("project_config_invalid"))?;
            }
        }
    }
    Ok(())
}
pub(crate) fn parse_config(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_SOURCE {
        return Err(code("project_config_budget"));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| code("project_config_invalid"))?;
    let fields = value
        .as_object()
        .ok_or_else(|| code("project_config_invalid"))?;
    if fields.get("version") != Some(&json!(1))
        || fields
            .keys()
            .any(|key| !["version", "defaults", "templates"].contains(&key.as_str()))
    {
        return Err(code("project_config_invalid"));
    }
    if let Some(defaults) = fields.get("defaults") {
        validate_settings(defaults, false)?;
    }
    if let Some(templates) = fields.get("templates") {
        let templates = templates
            .as_array()
            .ok_or_else(|| code("project_config_invalid"))?;
        if templates.len() > 32 {
            return Err(code("project_config_invalid"));
        }
        let mut names = std::collections::HashSet::new();
        for template in templates {
            validate_settings(template, true)?;
            let name = template
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| code("project_config_invalid"))?;
            if !names.insert(name.trim()) {
                return Err(code("project_config_invalid"));
            }
        }
    }
    Ok(value)
}
fn root_identity(root: &Path) -> Result<String, String> {
    let metadata = fs::metadata(root).map_err(|_| code("project_config_cwd"))?;
    if !metadata.is_dir() {
        return Err(code("project_config_cwd"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Info {
            attributes: u32,
            creation: [u32; 2],
            access: [u32; 2],
            write: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                file: std::os::windows::io::RawHandle,
                info: *mut Info,
            ) -> i32;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(root)
            .map_err(|_| code("project_config_cwd"))?;
        let mut info = std::mem::MaybeUninit::<Info>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(code("project_config_cwd"));
        }
        let info = unsafe { info.assume_init() };
        Ok(format!(
            "{}:{}:{}",
            info.volume, info.index_high, info.index_low
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(code("project_config_cwd"))
    }
}
fn observed(project: &Path) -> Result<Preview, String> {
    let root = fs::canonicalize(project).map_err(|_| code("project_config_cwd"))?;
    let identity = root_identity(&root)?;
    let path = root.join("yam.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preview {
                root: root.to_string_lossy().into_owned(),
                identity,
                source: String::new(),
                config: None,
                trusted: false,
            })
        }
        Err(_) => return Err(code("project_config_read")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(code("project_config_link"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(code("project_config_link"));
        }
    }
    if metadata.len() > MAX_SOURCE as u64 {
        return Err(code("project_config_budget"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options
        .open(path)
        .map_err(|_| code("project_config_read"))?;
    if !file
        .metadata()
        .map_err(|_| code("project_config_read"))?
        .is_file()
    {
        return Err(code("project_config_link"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_SOURCE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| code("project_config_read"))?;
    let config = parse_config(&bytes)?;
    let source = String::from_utf8(bytes).map_err(|_| code("project_config_invalid"))?;
    if identity != root_identity(&root)? {
        return Err(code("project_config_changed"));
    }
    Ok(Preview {
        root: root.to_string_lossy().into_owned(),
        identity,
        source,
        config: Some(config),
        trusted: false,
    })
}
fn read_store(private: &Path) -> Result<Store, String> {
    let path = private.join("project-launch.json");
    if !path
        .try_exists()
        .map_err(|_| code("project_config_preferences"))?
    {
        return Ok(Store {
            version: 1,
            ..Store::default()
        });
    }
    let file = crate::background::private_file(&path, false)
        .map_err(|_| code("project_config_preferences"))?;
    let mut bytes = Vec::new();
    file.take((MAX_STORE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| code("project_config_preferences"))?;
    if bytes.len() > MAX_STORE {
        return Err(code("project_config_budget"));
    }
    let store: Store =
        serde_json::from_slice(&bytes).map_err(|_| code("project_config_preferences"))?;
    if store.version != 1 || store.trusted.len() > 16 {
        return Err(code("project_config_preferences"));
    }
    validate_settings(
        &serde_json::to_value(&store.global).map_err(|_| code("project_config_preferences"))?,
        false,
    )?;
    Ok(store)
}
fn write_store(private: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|_| code("project_config_preferences"))?;
    if bytes.len() > MAX_STORE {
        return Err(code("project_config_budget"));
    }
    crate::background::private_root(private).map_err(|_| code("project_config_preferences"))?;
    let path = private.join("project-launch.json");
    if path.exists() {
        crate::background::private_file(&path, false)
            .map_err(|_| code("project_config_preferences"))?;
    }
    let temporary = private.join(format!(
        "project-launch-{}-{}-{}.tmp",
        std::process::id(),
        crate::unix_timestamp_millis(),
        CONFIG_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = crate::background::private_file(&temporary, true)
            .map_err(|_| code("project_config_preferences"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| code("project_config_preferences"))?;
        fs::rename(&temporary, &path).map_err(|_| code("project_config_preferences"))?;
        #[cfg(unix)]
        File::open(private)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| code("project_config_preferences"))?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn matches(approved: &Preview, current: &Preview) -> bool {
    approved.root == current.root
        && approved.identity == current.identity
        && approved.source == current.source
}
pub(crate) fn preview(project: &Path, private: &Path) -> Result<Preview, String> {
    let _gate = CONFIG_GATE
        .lock()
        .map_err(|_| code("project_config_preferences"))?;
    let mut current = observed(project)?;
    current.trusted = current.config.is_some()
        && read_store(private)?
            .trusted
            .iter()
            .any(|p| matches(p, &current));
    Ok(current)
}
pub(crate) fn trust(project: &Path, private: &Path, expected: &Preview) -> Result<(), String> {
    let _gate = CONFIG_GATE
        .lock()
        .map_err(|_| code("project_config_preferences"))?;
    let current = observed(project)?;
    if current.config.is_none() || !matches(expected, &current) {
        return Err(code("project_config_changed"));
    }
    let mut store = read_store(private)?;
    store.trusted.retain(|p| p.root != current.root);
    if store.trusted.len() >= 16 {
        return Err(code("project_config_budget"));
    }
    store.trusted.push(current);
    write_store(private, &store)
}
pub(crate) fn get_global(private: &Path) -> Result<LaunchSettings, String> {
    let _gate = CONFIG_GATE
        .lock()
        .map_err(|_| code("project_config_preferences"))?;
    Ok(read_store(private)?.global)
}
pub(crate) fn set_global(private: &Path, global: &LaunchSettings) -> Result<(), String> {
    let _gate = CONFIG_GATE
        .lock()
        .map_err(|_| code("project_config_preferences"))?;
    validate_settings(
        &serde_json::to_value(global).map_err(|_| code("project_config_invalid"))?,
        false,
    )?;
    let mut store = read_store(private)?;
    store.global = global.clone();
    write_store(private, &store)
}
pub(crate) fn prepare(
    project: &Path,
    private: &Path,
    template: Option<&str>,
    ui: &LaunchSettings,
    cli: &dyn Fn(&str) -> Option<PathBuf>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<PreparedLaunch, String> {
    let _gate = CONFIG_GATE
        .lock()
        .map_err(|_| code("project_config_preferences"))?;
    let current = observed(project)?;
    if current.config.is_none() {
        return Err(code("project_config_untrusted"));
    }
    let store = read_store(private)?;
    if current.config.is_some() && !store.trusted.iter().any(|p| matches(p, &current)) {
        return Err(code("project_config_untrusted"));
    }
    let mut settings = store.global.0;
    if let Some(config) = &current.config {
        if let Some(defaults) = config.get("defaults").and_then(Value::as_object) {
            settings.extend(defaults.clone());
        }
        if let Some(name) = template {
            let item = config
                .get("templates")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
                })
                .ok_or_else(|| code("project_config_template_missing"))?;
            settings.extend(
                item.as_object()
                    .unwrap()
                    .iter()
                    .filter(|(key, _)| key.as_str() != "name")
                    .map(|(k, v)| (k.clone(), v.clone())),
            );
        }
    } else if template.is_some() {
        return Err(code("project_config_template_missing"));
    }
    settings.extend(ui.0.clone());
    validate_settings(
        &serde_json::to_value(&settings).map_err(|_| code("project_config_invalid"))?,
        false,
    )?;
    let root = Path::new(&current.root);
    let cwd = if let Some(path) = settings.get("cwd").and_then(Value::as_str) {
        if Path::new(path).is_absolute()
            || Path::new(path)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(code("project_config_cwd"));
        }
        fs::canonicalize(root.join(path)).map_err(|_| code("project_config_cwd"))?
    } else {
        root.to_path_buf()
    };
    if !cwd.is_dir() || !cwd.starts_with(root) {
        return Err(code("project_config_cwd"));
    }
    let text = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let adapter = text("adapter").unwrap_or_else(|| "shell".into());
    let mode = text("mode").unwrap_or_else(|| "interactive".into());
    let command = text("command").filter(|command| !command.is_empty());
    let launch = if ["shell", "custom"].contains(&adapter.as_str()) {
        None
    } else {
        if command.is_some() {
            return Err(code("project_config_invalid"));
        }
        let executable = cli(&adapter)
            .filter(|path| path.is_file())
            .ok_or_else(|| code("project_config_cli_missing"))?;
        let launch = crate::AgentLaunch {
            adapter,
            mode,
            extra_args: text("extra_args").unwrap_or_default(),
            prompt: text("prompt"),
        };
        crate::agent_command(&executable, &launch).map_err(|_| code("project_config_invalid"))?;
        Some(launch)
    };
    let mut resolved = BTreeMap::new();
    if let Some(references) = settings.get("env").and_then(Value::as_object) {
        for (target, source) in references {
            let value =
                env(source.as_str().unwrap()).ok_or_else(|| code("project_config_env_missing"))?;
            if value.contains('\0') {
                return Err(code("project_config_env_missing"));
            }
            resolved.insert(target.clone(), value);
        }
    }
    Ok(PreparedLaunch {
        cwd,
        launch,
        command,
        env: resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        base: PathBuf,
        project: PathBuf,
        private: PathBuf,
        cli: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "yam-t09-{}-{}-{}",
                std::process::id(),
                crate::unix_timestamp_millis(),
                FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&base).unwrap();
            let project = base.join("one/api");
            fs::create_dir_all(&project).unwrap();
            let private = base.join("app-private");
            fs::create_dir(&private).unwrap();
            let cli = base.join("fake-cli");
            fs::write(&cli, b"fixture; never executed").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self {
                base,
                project,
                private,
                cli,
            }
        }
        fn source(&self, value: serde_json::Value) {
            fs::write(
                self.project.join("yam.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
        fn approve(&self) -> Preview {
            let p = preview(&self.project, &self.private).unwrap();
            trust(&self.project, &self.private, &p).unwrap();
            p
        }
        fn prepare(&self, ui: LaunchSettings) -> Result<PreparedLaunch, String> {
            prepare(
                &self.project,
                &self.private,
                None,
                &ui,
                &|_| Some(self.cli.clone()),
                &|key| {
                    if key == "EXISTING_KEY" {
                        Some("owner-only-secret; $(literal)".to_string())
                    } else {
                        None
                    }
                },
            )
        }
        fn private_snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
            let mut files: Vec<_> = fs::read_dir(&self.private)
                .unwrap()
                .map(|e| {
                    let p = e.unwrap().path();
                    let data = fs::read(&p).unwrap();
                    (p, data)
                })
                .collect();
            files.sort();
            files
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn settings(value: serde_json::Value) -> LaunchSettings {
        serde_json::from_value(value).unwrap()
    }
    fn normal() -> serde_json::Value {
        json!({"version":1,"defaults":{"adapter":"codex","mode":"interactive","extra_args":"--model literal","prompt":null},"templates":[{"name":"Review","adapter":"claude","mode":"task","prompt":"Review 中😀","extra_args":"--verbose"}]})
    }
    fn error(result: Result<impl Sized, String>, expected: &str) {
        match result {
            Ok(_) => panic!("expected {expected}"),
            Err(actual) => assert_eq!(actual, expected),
        }
    }

    #[test]
    fn t09_v1_normal_config_and_optional_absence_are_valid() {
        assert_eq!(
            serde_json::to_value(parse_config(&serde_json::to_vec(&normal()).unwrap()).unwrap())
                .unwrap(),
            normal()
        );
        let f = Fixture::new();
        assert!(preview(&f.project, &f.private).unwrap().config.is_none());
        assert!(f.private_snapshot().is_empty());
    }
    #[test]
    fn t09_unknown_version_fields_and_duplicate_templates_are_rejected() {
        for value in [
            json!({"version":2}),
            json!({"version":"1"}),
            json!({"version":1,"unknown":true}),
            json!({"version":1,"defaults":{"adapter":"codex","unknown":"x"}}),
            json!({"version":1,"templates":[{"name":"Same"},{"name":"Same"}]}),
        ] {
            error(
                parse_config(&serde_json::to_vec(&value).unwrap()),
                "project_config_invalid",
            );
        }
    }
    #[test]
    fn t09_invalid_adapter_mode_args_names_and_env_structure_are_rejected() {
        for defaults in [
            json!({"adapter":"invented"}),
            json!({"mode":"automatic"}),
            json!({"extra_args":"\"unterminated"}),
            json!({"extra_args":"\0"}),
            json!({"extra_args":"a ".repeat(129)}),
            json!({"env":{"BAD-NAME":"SOURCE"}}),
            json!({"env":{"DEST":123}}),
        ] {
            error(
                parse_config(
                    &serde_json::to_vec(&json!({"version":1,"defaults":defaults})).unwrap(),
                ),
                "project_config_invalid",
            );
        }
        error(
            parse_config(
                &serde_json::to_vec(&json!({"version":1,"templates":[{"name":""}]})).unwrap(),
            ),
            "project_config_invalid",
        );
    }
    #[test]
    fn t09_json_bytes_are_bounded_and_links_are_rejected_without_side_effects() {
        error(parse_config(&vec![b' '; 65537]), "project_config_budget");
        let f = Fixture::new();
        fs::write(f.project.join("yam.json"), vec![b' '; 65537]).unwrap();
        error(preview(&f.project, &f.private), "project_config_budget");
        assert!(f.private_snapshot().is_empty());
        #[cfg(unix)]
        {
            fs::remove_file(f.project.join("yam.json")).unwrap();
            std::os::unix::fs::symlink(&f.cli, f.project.join("yam.json")).unwrap();
            error(preview(&f.project, &f.private), "project_config_link");
        }
    }
    #[test]
    fn t09_first_preview_and_cancel_do_not_trust_or_execute_malicious_command() {
        let f = Fixture::new();
        let marker = f.base.join("never-executed");
        let command = format!("touch {}; $(echo secret)", marker.display());
        f.source(json!({"version":1,"defaults":{"adapter":"custom","command":command}}));
        let p = preview(&f.project, &f.private).unwrap();
        assert!(!p.trusted);
        assert!(p.config.is_some());
        drop(p);
        error(
            f.prepare(LaunchSettings::default()),
            "project_config_untrusted",
        );
        assert!(!marker.exists());
        assert!(f.private_snapshot().is_empty());
    }
    #[test]
    fn t09_trust_is_explicit_and_changed_bytes_are_rechecked_at_owner_prepare() {
        let f = Fixture::new();
        f.source(normal());
        let p = f.approve();
        assert!(preview(&f.project, &f.private).unwrap().trusted);
        f.source(
            json!({"version":1,"defaults":{"adapter":"custom","command":"touch /never-executed"}}),
        );
        error(trust(&f.project, &f.private, &p), "project_config_changed");
        error(
            f.prepare(LaunchSettings::default()),
            "project_config_untrusted",
        );
    }
    #[test]
    fn t09_ui_trusted_project_global_precedence_preserves_global_and_empty_override() {
        let f = Fixture::new();
        set_global(
            &f.private,
            &settings(json!({"adapter":"codex","mode":"interactive","extra_args":"--global"})),
        )
        .unwrap();
        f.source(json!({"version":1,"defaults":{"adapter":"claude","extra_args":"--project"}}));
        f.approve();
        let before = f.private_snapshot();
        let p = f
            .prepare(settings(
                json!({"extra_args":"","prompt":"literal $(touch nope); ${KEY} 中😀"}),
            ))
            .unwrap();
        let launch = p.launch.unwrap();
        assert_eq!(launch.adapter, "claude");
        assert_eq!(launch.mode, "interactive");
        assert_eq!(launch.extra_args, "");
        assert_eq!(
            launch.prompt.as_deref(),
            Some("literal $(touch nope); ${KEY} 中😀")
        );
        assert_eq!(before, f.private_snapshot());
    }
    #[test]
    fn t09_agent_metacharacters_remain_literal_argv_and_custom_remains_shell_text() {
        let f = Fixture::new();
        let text = "$(touch nope); ${EXISTING_KEY} 中😀";
        f.source(json!({"version":1,"defaults":{"adapter":"codex","mode":"task","extra_args":"'$(echo literal)' ';'","prompt":text}}));
        f.approve();
        let p = f.prepare(LaunchSettings::default()).unwrap();
        let command = crate::agent_command(&f.cli, p.launch.as_ref().unwrap()).unwrap();
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(argv.contains(&text.to_string()));
        assert!(argv.contains(&"$(echo literal)".to_string()));
        assert!(argv.contains(&";".to_string()));
        f.source(json!({"version":1,"defaults":{"adapter":"custom","command":"printf '%s' '${EXISTING_KEY} $(literal)'"}}));
        f.approve();
        let custom = f.prepare(LaunchSettings::default()).unwrap();
        assert_eq!(
            custom.command.as_deref(),
            Some("printf '%s' '${EXISTING_KEY} $(literal)'")
        );
        assert!(custom.launch.is_none());
    }
    #[test]
    fn t09_env_is_owner_reference_only_and_never_persisted_or_previewed_as_value() {
        let f = Fixture::new();
        f.source(json!({"version":1,"defaults":{"adapter":"codex","mode":"interactive","env":{"TARGET_KEY":"EXISTING_KEY"}}}));
        f.approve();
        let before = f.private_snapshot();
        let p = f.prepare(LaunchSettings::default()).unwrap();
        assert_eq!(
            p.env.get("TARGET_KEY").map(String::as_str),
            Some("owner-only-secret; $(literal)")
        );
        assert!(
            !serde_json::to_string(&preview(&f.project, &f.private).unwrap())
                .unwrap()
                .contains("owner-only-secret")
        );
        assert_eq!(before, f.private_snapshot());
        for (_, bytes) in before {
            assert!(!String::from_utf8_lossy(&bytes).contains("owner-only-secret"));
        }
    }
    #[test]
    fn t09_missing_env_and_dotenv_values_fail_before_private_history_log_or_cli_changes() {
        let f = Fixture::new();
        f.source(json!({"version":1,"defaults":{"adapter":"codex","mode":"interactive","env":{"TARGET_KEY":"MISSING_KEY"}}}));
        fs::write(f.project.join(".env"), "MISSING_KEY=must-not-read-secret").unwrap();
        f.approve();
        let before = f.private_snapshot();
        error(
            f.prepare(LaunchSettings::default()),
            "project_config_env_missing",
        );
        assert_eq!(before, f.private_snapshot());
        assert!(!f.private.join("sessions").exists());
        assert_eq!(fs::read(&f.cli).unwrap(), b"fixture; never executed");
    }
    #[test]
    fn t09_internal_env_sources_and_targets_are_case_insensitively_reserved() {
        for key in [
            "YAM_AGENT_BRIDGE",
            "YAM_AGENT_TOKEN",
            "YAM_LAUNCH_ID",
            "YAM_SESSION_ID",
            "YAM_AGENT_GENERATION",
            "YAM_AGENT_ADAPTER",
            "yam_agent_token",
            "YAM_CUSTOM_COMMAND",
            "YaM_cUsToM_cOmMaNd",
        ] {
            for env in [json!({(key):"EXISTING_KEY"}), json!({"TARGET_KEY":key})] {
                error(
                    parse_config(
                        &serde_json::to_vec(&json!({"version":1,"defaults":{"env":env}})).unwrap(),
                    ),
                    "project_config_reserved_env",
                );
            }
        }
    }
    #[test]
    fn t09_invalid_cwd_missing_cli_and_unknown_template_do_not_allocate_or_mutate_preferences() {
        let f = Fixture::new();
        f.source(normal());
        f.approve();
        let before = f.private_snapshot();
        error(
            prepare(
                &f.project,
                &f.private,
                None,
                &LaunchSettings::default(),
                &|_| None,
                &|_| None,
            ),
            "project_config_cli_missing",
        );
        error(
            prepare(
                &f.project,
                &f.private,
                Some("Unknown"),
                &LaunchSettings::default(),
                &|_| Some(f.cli.clone()),
                &|_| None,
            ),
            "project_config_template_missing",
        );
        for cwd in ["../outside", "/absolute/not-project", "missing"] {
            error(
                f.prepare(settings(json!({"cwd":cwd}))),
                "project_config_cwd",
            );
        }
        assert_eq!(before, f.private_snapshot());
        assert!(!f.private.join("sessions").exists());
    }
    #[test]
    fn t09_template_selection_is_explicit_and_uses_existing_agent_launch() {
        let f = Fixture::new();
        f.source(normal());
        f.approve();
        let p = prepare(
            &f.project,
            &f.private,
            Some("Review"),
            &LaunchSettings::default(),
            &|_| Some(f.cli.clone()),
            &|_| None,
        )
        .unwrap();
        let launch = p.launch.unwrap();
        assert_eq!(launch.adapter, "claude");
        assert_eq!(launch.mode, "task");
        assert_eq!(launch.prompt.as_deref(), Some("Review 中😀"));
    }
    #[test]
    fn t09_same_name_other_root_and_replaced_physical_root_never_inherit_trust() {
        let f = Fixture::new();
        f.source(normal());
        let p = f.approve();
        let other = f.base.join("two/api");
        fs::create_dir_all(&other).unwrap();
        fs::copy(f.project.join("yam.json"), other.join("yam.json")).unwrap();
        assert!(!preview(&other, &f.private).unwrap().trusted);
        fs::rename(&f.project, f.base.join("original-api")).unwrap();
        fs::create_dir(&f.project).unwrap();
        f.source(normal());
        assert!(!preview(&f.project, &f.private).unwrap().trusted);
        error(trust(&f.project, &f.private, &p), "project_config_changed");
    }
    #[cfg(unix)]
    #[test]
    fn t09_canonical_alias_shares_only_the_same_physical_root() {
        let f = Fixture::new();
        f.source(normal());
        f.approve();
        let alias = f.base.join("alias");
        std::os::unix::fs::symlink(&f.project, &alias).unwrap();
        let p = preview(&alias, &f.private).unwrap();
        assert!(p.trusted);
        assert_eq!(Path::new(&p.root), fs::canonicalize(&f.project).unwrap());
    }
    #[test]
    fn t09_custom_env_uses_builder_env_without_application_shell_interpolation() {
        let f = Fixture::new();
        let command = "printf '%s' '${TARGET_KEY} $(literal)'";
        f.source(json!({"version":1,"defaults":{"adapter":"custom","command":command,"env":{"TARGET_KEY":"EXISTING_KEY"}}}));
        f.approve();
        let prepared = f.prepare(LaunchSettings::default()).unwrap();
        assert_eq!(prepared.command.as_deref(), Some(command));
        let mut builder = crate::shell_command(prepared.command.as_deref());
        for (key, value) in prepared.env {
            builder.env(key, value);
        }
        #[cfg(not(windows))]
        assert_eq!(builder.get_argv().last().unwrap().to_str(), Some(command));
        #[cfg(windows)]
        {
            assert_eq!(
                builder.get_argv().last().unwrap().to_str(),
                Some("%YAM_CUSTOM_COMMAND%")
            );
        }
        assert_eq!(
            builder.get_env("TARGET_KEY").unwrap().to_str(),
            Some("owner-only-secret; $(literal)")
        );
    }
}
