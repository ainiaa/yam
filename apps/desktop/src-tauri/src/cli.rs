// Author: Jeff.Liu. Literal CLI parsing and bounded metadata; native entry is wired separately.
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
};
const MAX_PROMPT_BYTES: usize = 64 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ErrorClass {
    Arguments,
    Connection,
    Business,
    OutcomeUnknown,
    Compatibility,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct StartOptions {
    project: PathBuf,
    adapter: String,
    mode: String,
    prompt_file: PathBuf,
    request_key: Option<String>,
    start_owner: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Events(PathBuf),
    Status,
    List,
    Show(String),
    Start(StartOptions),
    Focus(String),
    Stop(String),
}
pub(super) fn valid_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_id(value: &str) -> bool {
    super::session_id_from_link(&format!("yam://session/{value}")).is_some()
}
fn parse(argv: &[OsString]) -> Result<Option<Command>, ErrorClass> {
    let invalid = ErrorClass::Arguments;
    if argv.len() > 20 {
        return Err(invalid);
    }
    let words: Vec<&str> = argv
        .iter()
        .map(|word| {
            word.to_str()
                .filter(|word| word.len() <= 4096 && !word.contains('\0'))
                .ok_or(invalid)
        })
        .collect::<Result<_, _>>()?;
    let parsed = match words.as_slice() {
        [] => return Ok(None),
        [link] if link.starts_with("yam://") => return Ok(None),
        ["events", "--json", "--cursor-file", path] if !path.is_empty() => {
            Command::Events((*path).into())
        }
        ["status", "--json"] => Command::Status,
        ["sessions", "list", "--json"] => Command::List,
        ["session", "show", id, "--json"] if valid_id(id) => Command::Show((*id).into()),
        ["session", "focus", id] if valid_id(id) => Command::Focus((*id).into()),
        ["session", "stop", id] if valid_id(id) => Command::Stop((*id).into()),
        ["session", "start", tail @ ..] => {
            let mut fields = std::collections::HashMap::new();
            let mut start_owner = false;
            let mut index = 0;
            while index < tail.len() {
                let key = tail[index];
                if key == "--start-owner" {
                    if start_owner {
                        return Err(invalid);
                    }
                    start_owner = true;
                    index += 1;
                    continue;
                }
                if ![
                    "--project",
                    "--adapter",
                    "--mode",
                    "--prompt-file",
                    "--request-key",
                ]
                .contains(&key)
                {
                    return Err(invalid);
                }
                let value = *tail
                    .get(index + 1)
                    .filter(|value| !value.is_empty())
                    .ok_or(invalid)?;
                if fields.insert(key, value).is_some() {
                    return Err(invalid);
                }
                index += 2;
            }
            let project = *fields.get("--project").ok_or(invalid)?;
            let adapter = *fields.get("--adapter").ok_or(invalid)?;
            let mode = *fields.get("--mode").ok_or(invalid)?;
            let prompt_file = *fields.get("--prompt-file").ok_or(invalid)?;
            if adapter.len() > 64
                || !adapter
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || !["task", "interactive"].contains(&mode)
            {
                return Err(invalid);
            }
            let request_key = fields.get("--request-key").map(|key| (*key).to_string());
            if request_key.as_deref().is_some_and(|key| !valid_key(key)) {
                return Err(invalid);
            }
            Command::Start(StartOptions {
                project: project.into(),
                adapter: adapter.into(),
                mode: mode.into(),
                prompt_file: prompt_file.into(),
                request_key,
                start_owner,
            })
        }
        _ => return Err(invalid),
    };
    Ok(Some(parsed))
}
fn read_prompt_file(path: &Path) -> Result<String, ErrorClass> {
    let invalid = ErrorClass::Arguments;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    if std::fs::symlink_metadata(path)
        .map_err(|_| invalid)?
        .file_type()
        .is_symlink()
    {
        return Err(invalid);
    }
    let file = options.open(path).map_err(|_| invalid)?;
    let metadata = file.metadata().map_err(|_| invalid)?;
    if !metadata.is_file() || metadata.len() > MAX_PROMPT_BYTES as u64 {
        return Err(invalid);
    }
    let mut bytes = Vec::new();
    file.take((MAX_PROMPT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid)?;
    if bytes.len() > MAX_PROMPT_BYTES {
        return Err(invalid);
    }
    String::from_utf8(bytes).map_err(|_| invalid)
}
pub(super) fn diagnostic(class: ErrorClass, key: Option<&str>) -> (i32, String) {
    let (code, label) = match class {
        ErrorClass::Arguments => (2, "invalid_arguments"),
        ErrorClass::Connection => (3, "owner_unavailable"),
        ErrorClass::Business => (4, "operation_refused"),
        ErrorClass::OutcomeUnknown => (5, "outcome_unknown"),
        ErrorClass::Compatibility => (3, "owner_upgrade_required"),
    };
    let message = if class == ErrorClass::OutcomeUnknown {
        key.filter(|key| valid_key(key))
            .map(|key| format!("{label} request_key={key}"))
            .unwrap_or_else(|| label.into())
    } else {
        label.into()
    };
    (code, message)
}
pub(super) const CLI_AGENT_PHASES: &[&str] = &[
    "idle",
    "working",
    "waiting",
    "completed",
    "failed",
    "unknown",
    "response_finished",
    "needs_permission",
    "needs_attention",
    "interrupted",
];

pub(super) fn session_metadata(
    record: &super::SessionRecord,
) -> Result<serde_json::Value, ErrorClass> {
    if !valid_id(&record.summary.session_id) || record.summary.cwd.len() > 4096 {
        return Err(ErrorClass::Business);
    }
    let status = if [
        "starting",
        "running",
        "succeeded",
        "failed",
        "stopped",
        "needs_attention",
    ]
    .contains(&record.status.as_str())
    {
        record.status.as_str()
    } else {
        "unknown"
    };
    let adapter = record
        .summary
        .launch
        .as_ref()
        .map(|launch| launch.adapter.as_str())
        .filter(|value| ["codex", "claude", "gemini", "opencode", "custom"].contains(value))
        .unwrap_or("unknown");
    let mode = record
        .summary
        .launch
        .as_ref()
        .map(|launch| launch.mode.as_str())
        .filter(|value| ["task", "interactive"].contains(value))
        .unwrap_or("unknown");
    let phase = if CLI_AGENT_PHASES.contains(&record.agent.phase.as_str()) {
        record.agent.phase.as_str()
    } else {
        "unknown"
    };
    Ok(
        serde_json::json!({"session_id":record.summary.session_id,"status":status,"cwd":record.summary.cwd,"adapter":adapter,"mode":mode,"phase":phase,"receipts":{"count":record.agent.inbox.len(),"unread":record.agent.inbox.iter().filter(|receipt| !receipt.read).count(),"failed":record.agent.inbox.iter().filter(|receipt| receipt.delivery == "failed").count()}}),
    )
}

pub(super) fn owner_start(
    app: Option<tauri::AppHandle>,
    manager: &super::SessionManager,
    private: &Path,
    start: &serde_json::Value,
) -> Result<super::SessionSummary, String> {
    let cwd = start
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .ok_or("cli_invalid_project")?;
    let root = Path::new(cwd)
        .canonicalize()
        .map_err(|_| "cli_invalid_project")?;
    if !root.is_dir() {
        return Err("cli_invalid_project".into());
    }
    let cwd = root.to_str().ok_or("cli_invalid_project")?.to_string();
    let adapter = start
        .get("adapter")
        .and_then(serde_json::Value::as_str)
        .ok_or("cli_invalid_adapter")?;
    if !["codex", "claude", "opencode"].contains(&adapter) {
        return Err("cli_invalid_adapter".into());
    }
    let executable = resolve_agent(adapter)
        .filter(|path| path.is_absolute())
        .ok_or("cli_missing_agent")?;
    let launch = super::AgentLaunch {
        adapter: adapter.into(),
        mode: start
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .ok_or("cli_invalid_launch")?
            .into(),
        prompt: Some(
            start
                .get("prompt")
                .and_then(serde_json::Value::as_str)
                .ok_or("cli_invalid_launch")?
                .into(),
        ),
        extra_args: String::new(),
    };
    super::agent_command(&executable, &launch).map_err(|_| "cli_invalid_launch")?;
    super::validate_working_directory(&cwd).map_err(|_| "cli_invalid_project")?;
    super::create_session_owner_with_worktree(
        app,
        manager,
        private,
        Some(cwd),
        None,
        Some(launch),
        None,
        None,
        None,
    )
}
fn resolve_agent(adapter: &str) -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(available) = TEST_EXECUTABLE.with(|flag| flag.get()) {
        return available.then(|| PathBuf::from("/usr/bin/true"));
    }
    super::find_executable(adapter)
}
fn owner_command(program: &Path) -> std::process::Command {
    let mut command = super::terminal_runtime::service_command(program);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}
pub(super) fn entry_dispatch(
    argv: &[OsString],
    helper: impl FnOnce() -> bool,
    background: impl FnOnce() -> bool,
    cli: impl FnOnce(&[OsString]) -> Result<bool, ErrorClass>,
    gui: impl FnOnce(),
) -> Result<(), ErrorClass> {
    if argv.iter().any(|word| word.to_str().is_none()) {
        return Err(ErrorClass::Arguments);
    }
    if helper() || background() || cli(argv)? {
        return Ok(());
    }
    gui();
    Ok(())
}
pub(super) fn run_entry(argv: &[OsString]) -> Result<bool, ErrorClass> {
    let Some(command) = parse(argv)? else {
        return Ok(false);
    };
    if let Command::Events(path) = &command {
        run_events(path)?;
        return Ok(true);
    }
    let mut key = if let Command::Start(options) = &command {
        options.request_key.clone()
    } else {
        None
    };
    let result = execute(&command, &mut key);
    match result {
        Ok(value) => println!("{value}"),
        Err(class) => {
            let (code, message) = diagnostic(class, key.as_deref());
            eprintln!("{message}");
            std::process::exit(code);
        }
    }
    Ok(true)
}
fn execute(command: &Command, key: &mut Option<String>) -> Result<serde_json::Value, ErrorClass> {
    let prepared = if let Command::Start(options) = command {
        Some(prepare_start(options)?)
    } else {
        None
    };
    let context = super::app_context();
    let root = resolve_owner_root(
        &context.config().identifier,
        context.config().app.app_directories_override.is_some(),
        native_user_data,
    )?;
    let allow_start = matches!(command,Command::Start(options) if options.start_owner);
    let client = connect_owner(&root, allow_start, || {
        let executable = std::env::current_exe().map_err(|_| "cli_executable")?;
        owner_command(&executable)
            .arg("--yam-background")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "cli_owner_start")?;
        Ok(())
    })?;
    if !matches!(command, Command::Start(_)) {
        client.cli_context()?;
    }
    match command {
        Command::Events(_) => Err(ErrorClass::Arguments),
        Command::Status => client.call_cli("cli_status", serde_json::json!({})),
        Command::List => client.call_cli("cli_list", serde_json::json!({})),
        Command::Show(id) => client.call_cli("cli_show", serde_json::json!({"session_id":id})),
        Command::Focus(id) => client.call_cli("cli_focus", serde_json::json!({"session_id":id})),
        Command::Stop(id) => client.call_cli("cli_stop", serde_json::json!({"session_id":id})),
        Command::Start(_) => start_on_client(&client, prepared.ok_or(ErrorClass::Arguments)?, key),
    }
}

fn prepare_start(options: &StartOptions) -> Result<serde_json::Value, ErrorClass> {
    let prompt = read_prompt_file(&options.prompt_file)?;
    let project = options
        .project
        .canonicalize()
        .map_err(|_| ErrorClass::Arguments)?;
    if !project.is_dir() {
        return Err(ErrorClass::Arguments);
    }
    Ok(
        serde_json::json!({"cwd":project.to_str().ok_or(ErrorClass::Arguments)?,"adapter":options.adapter,"mode":options.mode,"prompt":prompt}),
    )
}
pub(super) fn start_on_client(
    client: &super::background::Client,
    prepared: serde_json::Value,
    key: &mut Option<String>,
) -> Result<serde_json::Value, ErrorClass> {
    let context = client.cli_context()?;
    let nonce = super::agent_bridge::credential().map_err(|_| ErrorClass::Connection)?;
    let bound = bind_start_key(&context, key.as_deref(), &nonce[..32])?;
    *key = Some(bound.clone());
    let mut result = client.call_cli(
        "cli_start",
        serde_json::json!({"request_key":bound,"start":prepared}),
    )?;
    result["request_key"] = serde_json::json!(bound);
    Ok(result)
}

#[cfg(test)]
thread_local! { static TEST_EXECUTABLE: std::cell::Cell<Option<bool>> = const {std::cell::Cell::new(None)}; }

fn resolve_owner_root(
    identifier: &str,
    override_present: bool,
    native: impl FnOnce() -> Result<PathBuf, ErrorClass>,
) -> Result<PathBuf, ErrorClass> {
    if override_present
        || identifier.is_empty()
        || identifier.len() > 255
        || identifier.split('.').any(str::is_empty)
        || !identifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
    {
        return Err(ErrorClass::Connection);
    }
    let root = native()?;
    if !root.is_absolute() || root.as_os_str().len() > 4096 {
        return Err(ErrorClass::Connection);
    }
    Ok(root.join(identifier).join("background"))
}
fn native_user_data() -> Result<PathBuf, ErrorClass> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{
            NSHomeDirectory, NSSearchPathDirectory, NSSearchPathDomainMask,
            NSSearchPathForDirectoriesInDomains,
        };
        let native_home = PathBuf::from(NSHomeDirectory().to_string());
        if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) {
            if PathBuf::from(home).canonicalize().ok() != native_home.canonicalize().ok() {
                return Err(ErrorClass::Connection);
            }
        }
        let roots = NSSearchPathForDirectoriesInDomains(
            NSSearchPathDirectory::ApplicationSupportDirectory,
            NSSearchPathDomainMask::UserDomainMask,
            true,
        );
        if roots.len() != 1 {
            return Err(ErrorClass::Connection);
        }
        Ok(PathBuf::from(roots.objectAtIndex(0).to_string()))
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("XDG_DATA_HOME").is_some_and(|path| !PathBuf::from(path).is_absolute())
        {
            return Err(ErrorClass::Connection);
        }
        Ok(gio::glib::user_data_dir())
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG},
        };
        let pointer =
            unsafe { SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KNOWN_FOLDER_FLAG(0), None) }
                .map_err(|_| ErrorClass::Connection)?;
        let result = (|| {
            let mut chars = Vec::new();
            for offset in 0..=4096 {
                let value = unsafe { *pointer.0.add(offset) };
                if value == 0 {
                    return String::from_utf16(&chars)
                        .map(PathBuf::from)
                        .map_err(|_| ErrorClass::Connection);
                }
                chars.push(value);
            }
            Err(ErrorClass::Connection)
        })();
        unsafe {
            CoTaskMemFree(Some(pointer.0.cast()));
        }
        result
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Err(ErrorClass::Connection)
    }
}
fn connect_owner(
    root: &Path,
    allow_start: bool,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<super::background::Client, ErrorClass> {
    if allow_start {
        super::background::connect_or_start(root, start).map_err(|_| ErrorClass::Connection)
    } else {
        super::background::Client::new(
            super::background::Descriptor::read(root).map_err(|_| ErrorClass::Connection)?,
        )
        .map_err(|_| ErrorClass::Connection)
    }
}

fn bind_start_key(
    context: &str,
    provided: Option<&str>,
    nonce: &str,
) -> Result<String, ErrorClass> {
    if context.len() != 32 || !context.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ErrorClass::Compatibility);
    }
    if let Some(key) = provided {
        if !valid_key(key) {
            return Err(ErrorClass::Arguments);
        }
        if !key.starts_with(context) {
            return Err(ErrorClass::OutcomeUnknown);
        }
        return Ok(key.into());
    }
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ErrorClass::Connection);
    }
    Ok(format!("{context}{nonce}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::Instant,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "yam-t16-cli-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            fs::write(&p, bytes).unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for entry in fs::read_dir(&self.0).unwrap() {
                let _ = fs::remove_file(entry.unwrap().path());
            }
            let _ = fs::remove_dir(&self.0);
        }
    }
    fn args(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }
    #[test]
    fn t16_literal_read_and_control_grammar() {
        for (argv, expected) in [
            (vec!["status", "--json"], Command::Status),
            (vec!["sessions", "list", "--json"], Command::List),
            (
                vec!["session", "show", "s-1-2", "--json"],
                Command::Show("s-1-2".into()),
            ),
            (
                vec!["session", "focus", "s-1-2"],
                Command::Focus("s-1-2".into()),
            ),
            (
                vec!["session", "stop", "s-1-2"],
                Command::Stop("s-1-2".into()),
            ),
        ] {
            assert_eq!(parse(&args(&argv)), Ok(Some(expected)));
        }
    }
    #[test]
    fn t16_literal_start_optional_owner_and_key_without_shell_expansion() {
        let argv = args(&[
            "session",
            "start",
            "--project",
            "/fixture/中 space;$(literal)",
            "--adapter",
            "codex",
            "--mode",
            "task",
            "--prompt-file",
            "/fixture/prompt 中.txt",
            "--request-key",
            &"a".repeat(64),
            "--start-owner",
        ]);
        let Some(Command::Start(start)) = parse(&argv).unwrap() else {
            panic!("Expected literal start")
        };
        assert_eq!(start.project, PathBuf::from("/fixture/中 space;$(literal)"));
        assert_eq!(start.adapter, "codex");
        assert_eq!(start.mode, "task");
        assert!(start.start_owner);
        assert_eq!(start.request_key, Some("a".repeat(64)));
        let Some(Command::Start(start)) = parse(&args(&[
            "session",
            "start",
            "--project",
            ".",
            "--adapter",
            "claude",
            "--mode",
            "interactive",
            "--prompt-file",
            "prompt.txt",
        ]))
        .unwrap() else {
            panic!("Expected start")
        };
        assert!(!start.start_owner);
        assert_eq!(start.request_key, None);
    }
    #[test]
    fn t16_no_arguments_and_system_deep_link_preserve_gui_entry() {
        assert_eq!(parse(&[]), Ok(None));
        assert_eq!(parse(&args(&["yam://session/s-1-2"])), Ok(None));
    }
    #[test]
    fn t16_unknown_missing_duplicate_extra_and_invalid_arguments_refuse_gui_fallthrough() {
        for argv in [
            vec!["unknown"],
            vec!["--secret=SECRET"],
            vec!["status"],
            vec!["status", "--json", "--start-owner"],
            vec!["sessions", "list", "--json", "extra"],
            vec!["session", "show", "../SECRET", "--json"],
            vec!["session", "focus", "s-1-2", "--json"],
            vec!["session", "start", "--project", "."],
            vec![
                "session",
                "start",
                "--project",
                ".",
                "--project",
                ".",
                "--adapter",
                "codex",
                "--mode",
                "task",
                "--prompt-file",
                "x",
            ],
            vec!["yam://session/s-1-2", "unknown"],
        ] {
            assert_eq!(parse(&args(&argv)), Err(ErrorClass::Arguments));
        }
    }
    #[test]
    fn t16_start_bounds_and_unknown_modes_are_argument_errors() {
        for (key, value) in [
            ("--mode", "unknown"),
            ("--request-key", "SECRET"),
            ("--adapter", "../SECRET"),
            ("--project", ""),
        ] {
            let mut argv = args(&[
                "session",
                "start",
                "--project",
                ".",
                "--adapter",
                "codex",
                "--mode",
                "task",
                "--prompt-file",
                "x",
            ]);
            if let Some(index) = argv.iter().position(|v| v == key) {
                argv[index + 1] = value.into();
            } else {
                argv.extend(args(&[key, value]));
            }
            assert_eq!(parse(&argv), Err(ErrorClass::Arguments));
        }
        let mut argv = args(&[
            "session",
            "start",
            "--project",
            ".",
            "--adapter",
            "codex",
            "--mode",
            "task",
            "--prompt-file",
            "x",
        ]);
        argv[3] = "x".repeat(4097).into();
        assert_eq!(parse(&argv), Err(ErrorClass::Arguments));
    }
    #[cfg(unix)]
    #[test]
    fn t16_non_utf8_argument_is_fixed_usage_error() {
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(
            parse(&[OsString::from_vec(vec![255])]),
            Err(ErrorClass::Arguments)
        );
    }
    #[test]
    fn t16_prompt_regular_utf8_literal_and_exact_byte_boundary() {
        let f = Fixture::new();
        let p = f.file("Unicode prompt.txt", "literal $(secret); 中😀\n".as_bytes());
        assert_eq!(read_prompt_file(&p).unwrap(), "literal $(secret); 中😀\n");
        let p = f.file("max", &vec![b'x'; MAX_PROMPT_BYTES]);
        assert_eq!(read_prompt_file(&p).unwrap().len(), MAX_PROMPT_BYTES);
    }
    #[test]
    fn t16_prompt_missing_directory_non_utf8_and_oversize_are_redacted_refusals() {
        let f = Fixture::new();
        for p in [
            f.0.join("missing SECRET"),
            f.0.clone(),
            f.file("invalid", &[255]),
            f.file("oversize", &vec![b'x'; MAX_PROMPT_BYTES + 1]),
        ] {
            assert_eq!(read_prompt_file(&p), Err(ErrorClass::Arguments));
        }
    }
    #[cfg(unix)]
    #[test]
    fn t16_prompt_symlink_and_fifo_never_follow_or_block() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let p = f.file("actual", b"SECRET");
        let link = f.0.join("link");
        symlink(p, &link).unwrap();
        assert_eq!(read_prompt_file(&link), Err(ErrorClass::Arguments));
        let fifo = f.0.join("fifo");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let start = Instant::now();
        assert_eq!(read_prompt_file(&fifo), Err(ErrorClass::Arguments));
        assert!(start.elapsed().as_secs_f64() < 1.0);
    }
    #[test]
    fn t16_exit_diagnostics_are_distinct_fixed_and_unknown_returns_only_opaque_key() {
        for (class, code, label) in [
            (ErrorClass::Arguments, 2, "invalid_arguments"),
            (ErrorClass::Connection, 3, "owner_unavailable"),
            (ErrorClass::Business, 4, "operation_refused"),
            (ErrorClass::OutcomeUnknown, 5, "outcome_unknown"),
        ] {
            let (actual, message) = diagnostic(class, Some(&"a".repeat(64)));
            assert_eq!(actual, code);
            assert!(message.contains(label));
            assert!(!message.contains("SECRET"));
        }
        let (_, message) = diagnostic(ErrorClass::OutcomeUnknown, Some(&"a".repeat(64)));
        assert!(message.contains(&"a".repeat(64)));
    }
    #[test]
    fn t16_session_metadata_is_fixed_and_never_serializes_launch_or_reason() {
        let record:super::super::SessionRecord=serde_json::from_value(json!({"summary":{"session_id":"s-1-2","cwd":"/fixture","status":"running","command":"SECRET command","launch":{"adapter":"codex","mode":"task","extra_args":"SECRET args","prompt":"SECRET prompt"}},"status":"running","exit_code":null,"reason":"SECRET reason","started_at":1,"ended_at":null})).unwrap();
        let dto = session_metadata(&record).unwrap();
        let object = dto.as_object().unwrap();
        assert_eq!(
            object
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "session_id",
                "status",
                "cwd",
                "adapter",
                "mode",
                "phase",
                "receipts"
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(dto["session_id"], "s-1-2");
        assert_eq!(dto["adapter"], "codex");
        assert_eq!(dto["mode"], "task");
        assert!(!dto.to_string().contains("SECRET"));
    }
    #[test]
    fn t16_owner_preflight_cwd_adapter_and_missing_cli_fail_before_allocation() {
        let fixture = Fixture::new();
        let manager = super::super::SessionManager::default();
        for (cwd, adapter, expected) in [
            (
                fixture.0.join("missing").to_str().unwrap(),
                "codex",
                "cli_invalid_project",
            ),
            (
                fixture.0.to_str().unwrap(),
                "not-supported",
                "cli_invalid_adapter",
            ),
            (
                fixture.0.to_str().unwrap(),
                "yam-t16-no-such-agent",
                "cli_invalid_adapter",
            ),
        ] {
            let before = super::super::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get());
            let result = owner_start(
                None,
                &manager,
                &fixture.0,
                &json!({"cwd":cwd,"adapter":adapter,"mode":"task","prompt":"SECRET"}),
            );
            assert_eq!(result.unwrap_err(), expected);
            assert_eq!(
                super::super::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()),
                before
            );
            assert!(manager.sessions.lock().unwrap().is_empty());
            assert!(manager.history.lock().unwrap().is_none());
            assert!(manager.agent_bridge.lock().unwrap().is_none());
        }
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn t16_explicit_owner_spawn_has_its_own_process_group() {
        let mut child = owner_command(Path::new("/bin/sleep"))
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let id = child.id() as libc::pid_t;
        let group = unsafe { libc::getpgid(id) };
        let own_group = unsafe { libc::getpgrp() };
        let _ = child.kill();
        child.wait().unwrap();
        assert_eq!(group, id);
        assert_ne!(group, own_group);
    }

    #[test]
    fn t16_actual_entry_dispatch_preserves_helper_priority_and_never_falls_unknown_into_gui() {
        let calls = std::cell::RefCell::new(Vec::new());
        let result = entry_dispatch(
            &args(&["unknown SECRET"]),
            || {
                calls.borrow_mut().push("helper");
                false
            },
            || {
                calls.borrow_mut().push("background");
                false
            },
            |argv| {
                calls.borrow_mut().push("cli");
                parse(argv).map(|value| value.is_some())
            },
            || calls.borrow_mut().push("gui"),
        );
        assert_eq!(result, Err(ErrorClass::Arguments));
        assert_eq!(*calls.borrow(), vec!["helper", "background", "cli"]);
        calls.borrow_mut().clear();
        entry_dispatch(
            &args(&["--yam-background"]),
            || false,
            || true,
            |_| panic!("Background must precede CLI"),
            || panic!("No UI"),
        )
        .unwrap();
        entry_dispatch(
            &args(&["yam://session/s-1-2"]),
            || false,
            || false,
            |argv| parse(argv).map(|value| value.is_some()),
            || calls.borrow_mut().push("gui"),
        )
        .unwrap();
        assert_eq!(*calls.borrow(), vec!["gui"]);
    }
    #[cfg(unix)]
    #[test]
    fn t16_non_utf8_entry_precheck_runs_before_utf8_helper_or_gui() {
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(
            entry_dispatch(
                &[OsString::from_vec(vec![255])],
                || panic!("UTF8 helper must never run"),
                || panic!("Background must never run"),
                |_| panic!("Invalid args"),
                || panic!("No UI")
            ),
            Err(ErrorClass::Arguments)
        );
    }

    #[test]
    fn t16_owner_normal_literal_start_reaches_existing_boundary_but_missing_cli_and_bad_prompt_do_not(
    ) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                TEST_EXECUTABLE.with(|flag| flag.set(None));
            }
        }
        let _reset = Reset;
        let fixture = Fixture::new();
        let manager = super::super::SessionManager::default();
        let start = json!({"cwd":fixture.0,"adapter":"codex","mode":"task","prompt":"literal 中 $(not-shell)"});
        TEST_EXECUTABLE.with(|flag| flag.set(Some(true)));
        let before = super::super::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get());
        assert_eq!(
            owner_start(None, &manager, &fixture.0, &start).unwrap_err(),
            "test_entry_reached_allocation"
        );
        assert_eq!(
            super::super::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()),
            before + 1
        );
        TEST_EXECUTABLE.with(|flag| flag.set(Some(false)));
        assert_eq!(
            owner_start(None, &manager, &fixture.0, &start).unwrap_err(),
            "cli_missing_agent"
        );
        TEST_EXECUTABLE.with(|flag| flag.set(Some(true)));
        let mut bad = start.clone();
        bad["prompt"] = json!("SECRET\0");
        assert_eq!(
            owner_start(None, &manager, &fixture.0, &bad).unwrap_err(),
            "cli_invalid_launch"
        );
        assert_eq!(
            super::super::T09_ALLOCATION_BOUNDARY.with(|hit| hit.get()),
            before + 1
        );
    }

    #[test]
    fn t16_native_path_uses_exact_packaged_identifier_without_creating_dirs() {
        let fixture = Fixture::new();
        let native = fixture.0.join("native-user-data");
        let result = resolve_owner_root("com.yam.fixture", false, || Ok(native.clone())).unwrap();
        assert_eq!(result, native.join("com.yam.fixture/background"));
        assert!(!native.exists());
    }
    #[test]
    fn t16_native_path_failure_override_relative_and_invalid_identifier_fail_closed() {
        for (identifier, overridden) in [
            ("../SECRET", false),
            ("", false),
            ("com.yam.fixture", true),
            ("a/b", false),
        ] {
            let hit = std::cell::Cell::new(false);
            assert_eq!(
                resolve_owner_root(identifier, overridden, || {
                    hit.set(true);
                    Ok(PathBuf::from("/native"))
                }),
                Err(ErrorClass::Connection)
            );
            assert!(!hit.get());
        }
        assert_eq!(
            resolve_owner_root("com.yam.fixture", false, || Ok(PathBuf::from("relative"))),
            Err(ErrorClass::Connection)
        );
        assert_eq!(
            resolve_owner_root("com.yam.fixture", false, || Err(ErrorClass::Connection)),
            Err(ErrorClass::Connection)
        );
    }
    #[test]
    fn t16_absent_owner_default_never_allocates_or_starts_and_explicit_start_is_the_only_exception()
    {
        let f = Fixture::new();
        let root = f.0.join("background");
        let called = std::cell::Cell::new(0);
        assert!(matches!(
            connect_owner(&root, false, || {
                called.set(called.get() + 1);
                Ok(())
            }),
            Err(ErrorClass::Connection)
        ));
        assert_eq!(called.get(), 0);
        assert!(!root.exists());
        assert!(matches!(
            connect_owner(&root, true, || {
                called.set(called.get() + 1);
                Err("fixture_start_failed".into())
            }),
            Err(ErrorClass::Connection)
        ));
        assert_eq!(called.get(), 1);
    }

    #[test]
    fn t16_key_same_owner_and_caller_nonce_are_opaque_and_replacement_refuses_before_send() {
        let context = "a".repeat(32);
        let key = format!("{context}{}", "c".repeat(32));
        assert_eq!(
            bind_start_key(&context, Some(&key), &"d".repeat(32)),
            Ok(key.clone())
        );
        assert_eq!(
            bind_start_key(&context, None, &"d".repeat(32)),
            Ok(format!("{context}{}", "d".repeat(32)))
        );
        assert_eq!(
            bind_start_key(&"b".repeat(32), Some(&key), &"d".repeat(32)),
            Err(ErrorClass::OutcomeUnknown)
        );
        assert_eq!(
            bind_start_key("", Some(&key), &"d".repeat(32)),
            Err(ErrorClass::Compatibility)
        );
        let (code, label) = diagnostic(ErrorClass::Compatibility, None);
        assert_eq!(code, 3);
        assert_eq!(label, "owner_upgrade_required");
    }

    #[test]
    fn t16_actual_sender_canonicalizes_relative_project_in_caller_cwd_before_any_rpc() {
        let fixture = Fixture::new();
        let prompt = fixture.file("literal prompt 中", b"literal $(not-shell)");
        let cwd = std::env::current_dir().unwrap();
        let mut relative = PathBuf::new();
        for component in cwd.components() {
            if matches!(component, std::path::Component::Normal(_)) {
                relative.push("..");
            }
        }
        for component in fixture.0.components() {
            if let std::path::Component::Normal(part) = component {
                relative.push(part);
            }
        }
        let options = StartOptions {
            project: relative,
            adapter: "codex".into(),
            mode: "task".into(),
            prompt_file: prompt,
            request_key: None,
            start_owner: false,
        };
        let prepared = prepare_start(&options).unwrap();
        assert_eq!(
            prepared["cwd"],
            fixture.0.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(Path::new(prepared["cwd"].as_str().unwrap()).is_absolute());
        assert_eq!(prepared["prompt"], "literal $(not-shell)");
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EventCursor {
    version: u8,
    instance: String,
    sequence: u64,
}

fn validate_event_cursor(cursor: &EventCursor) -> Result<(), ErrorClass> {
    if cursor.version != 1 || !valid_key(&cursor.instance) {
        return Err(ErrorClass::Arguments);
    }
    Ok(())
}
fn load_event_cursor(path: &Path) -> Result<Option<EventCursor>, ErrorClass> {
    if path.file_name().is_none()
        || !path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .is_dir()
    {
        return Err(ErrorClass::Arguments);
    }
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ErrorClass::Arguments),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => return Err(ErrorClass::Arguments),
        _ => {}
    }
    let mut bytes = Vec::new();
    super::background::private_file(path, false)
        .map_err(|_| ErrorClass::Arguments)?
        .take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| ErrorClass::Arguments)?;
    if bytes.len() > 1024 {
        return Err(ErrorClass::Arguments);
    }
    let cursor: EventCursor = serde_json::from_slice(&bytes).map_err(|_| ErrorClass::Arguments)?;
    validate_event_cursor(&cursor)?;
    Ok(Some(cursor))
}
fn checkpoint_event_cursor(path: &Path, cursor: &EventCursor) -> Result<(), ErrorClass> {
    use std::io::Write;
    validate_event_cursor(cursor)?;
    load_event_cursor(path)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(
        ".yam-event-cursor-{}-{}.tmp",
        std::process::id(),
        super::agent_bridge::credential().map_err(|_| ErrorClass::Arguments)?
    ));
    let mut file =
        super::background::private_file(&temporary, true).map_err(|_| ErrorClass::Arguments)?;
    let result = (|| {
        #[cfg(windows)]
        super::background::protect_windows_path(&temporary).map_err(|_| ErrorClass::Arguments)?;
        let bytes = serde_json::to_vec(cursor).map_err(|_| ErrorClass::Arguments)?;
        if bytes.len() > 1024 {
            return Err(ErrorClass::Arguments);
        }
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| ErrorClass::Arguments)?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|_| ErrorClass::Arguments)?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|p| p.sync_all())
            .map_err(|_| ErrorClass::Arguments)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
fn consume_event_page(
    cursor: &mut EventCursor,
    page: serde_json::Value,
    writer: &mut impl std::io::Write,
    mut checkpoint: impl FnMut(&EventCursor) -> Result<(), ErrorClass>,
) -> Result<(), ErrorClass> {
    validate_event_cursor(cursor)?;
    let invalid = ErrorClass::Business;
    let object = page.as_object().ok_or(invalid)?;
    if object.len() != 4
        || !object
            .keys()
            .all(|k| ["cursor", "gap", "gap_sequence", "events"].contains(&k.as_str()))
        || page.to_string().len() > 256 * 1024
    {
        return Err(invalid);
    }
    let high = page["cursor"].as_u64().ok_or(invalid)?;
    let gap = page["gap"].as_bool().ok_or(invalid)?;
    let floor = page["gap_sequence"].as_u64().ok_or(invalid)?;
    let events = page["events"].as_array().ok_or(invalid)?;
    if high < cursor.sequence || floor > high || (!gap && floor != 0) || events.len() > 128 {
        return Err(invalid);
    }
    let mut previous = if gap { floor } else { 0 };
    for line in events {
        let seq = line["sequence"].as_u64().ok_or(invalid)?;
        if seq <= previous || seq > high || !super::background::valid_cli_event_line(line) {
            return Err(invalid);
        }
        previous = seq;
    }
    let mut bytes = vec![];
    if gap && floor > cursor.sequence {
        serde_json::to_writer(
            &mut bytes,
            &serde_json::json!({"type":"gap","sequence":floor,"snapshot_required":true}),
        )
        .map_err(|_| invalid)?;
        bytes.push(b'\n');
    }
    for line in events.iter().filter(|line| {
        line["sequence"]
            .as_u64()
            .is_some_and(|seq| seq > cursor.sequence)
    }) {
        serde_json::to_writer(&mut bytes, line).map_err(|_| invalid)?;
        bytes.push(b'\n');
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|_| ErrorClass::Connection)?;
    if high > cursor.sequence {
        let mut next = cursor.clone();
        next.sequence = high;
        checkpoint(&next)?;
        *cursor = next;
    }
    Ok(())
}
#[cfg(test)]
mod event_tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "yam-t17-cursor-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> PathBuf {
            self.0.join("cursor.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for entry in std::fs::read_dir(&self.0).unwrap() {
                let _ = std::fs::remove_file(entry.unwrap().path());
            }
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    fn cursor() -> EventCursor {
        EventCursor {
            version: 1,
            instance: "a".repeat(64),
            sequence: 0,
        }
    }
    fn page() -> serde_json::Value {
        json!({"cursor":2,"gap":false,"gap_sequence":0,"events":[{"sequence":1,"type":"lifecycle","session_id":"s-1-2","status":"running"},{"sequence":2,"type":"phase","session_id":"s-1-2","phase":"working"}]})
    }
    #[test]
    fn t17_events_literal_grammar_does_not_fallthrough_gui_or_accept_start_owner() {
        let p = parse(&[
            "events".into(),
            "--json".into(),
            "--cursor-file".into(),
            "/fixture/cursor".into(),
        ])
        .unwrap();
        assert!(format!("{p:?}").contains("Events"));
        assert!(parse(&[
            "events".into(),
            "--json".into(),
            "--cursor-file".into(),
            "/fixture/cursor".into(),
            "--start-owner".into()
        ])
        .is_err());
    }
    #[test]
    fn t17_private_cursor_normal_missing_roundtrip_and_strict_schema() {
        let f = Fixture::new();
        assert_eq!(load_event_cursor(&f.path()).unwrap(), None);
        checkpoint_event_cursor(&f.path(), &cursor()).unwrap();
        assert_eq!(load_event_cursor(&f.path()).unwrap(), Some(cursor()));
        for bad in [
            json!({"version":2,"instance":"a".repeat(64),"sequence":0}),
            json!({"version":1,"instance":"bad","sequence":0}),
            json!({"version":1,"instance":"a".repeat(64),"sequence":0,"token":"SECRET"}),
        ] {
            std::fs::write(f.path(), bad.to_string()).unwrap();
            assert!(load_event_cursor(&f.path()).is_err());
        }
        std::fs::write(f.path(), " ".repeat(1025)).unwrap();
        assert!(load_event_cursor(&f.path()).is_err());
        std::fs::write(f.path(), "{").unwrap();
        assert!(load_event_cursor(&f.path()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn t17_cursor_links_fifo_and_public_permissions_fail_closed_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new();
        std::fs::write(f.0.join("target"), "SECRET").unwrap();
        symlink(f.0.join("target"), f.path()).unwrap();
        assert!(load_event_cursor(&f.path()).is_err());
        std::fs::remove_file(f.path()).unwrap();
        let name = CString::new(f.path().to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let now = std::time::Instant::now();
        assert!(load_event_cursor(&f.path()).is_err());
        assert!(now.elapsed() < std::time::Duration::from_secs(1));
        std::fs::remove_file(f.path()).unwrap();
        std::fs::write(f.path(), serde_json::to_vec(&cursor()).unwrap()).unwrap();
        std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_event_cursor(&f.path()).is_err());
    }
    #[test]
    fn t17_order_dedup_original_sequences_and_checkpoint_after_flush() {
        let mut c = cursor();
        let mut output = Vec::new();
        let mut commits = vec![];
        consume_event_page(&mut c, page(), &mut output, |c| {
            commits.push(c.sequence);
            Ok(())
        })
        .unwrap();
        assert_eq!(c.sequence, 2);
        assert_eq!(commits, vec![2]);
        let before = output.clone();
        consume_event_page(&mut c, page(), &mut output, |_| Ok(())).unwrap();
        assert_eq!(output, before);
        let lines: Vec<serde_json::Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["sequence"], 1);
        assert_eq!(lines[1]["sequence"], 2);
    }
    #[test]
    fn t17_gap_requires_snapshot_with_original_floor_then_events() {
        let mut c = cursor();
        let mut output = Vec::new();
        let p = json!({"cursor":180,"gap":true,"gap_sequence":176,"events":[{"sequence":180,"type":"phase","session_id":"s-1-2","phase":"working"}]});
        consume_event_page(&mut c, p, &mut output, |_| Ok(())).unwrap();
        let lines: Vec<serde_json::Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(
            lines[0],
            json!({"sequence":176,"type":"gap","snapshot_required":true})
        );
        assert_eq!(lines[1]["sequence"], 180);
        assert_eq!(c.sequence, 180);
    }
    #[test]
    fn t17_partial_stdout_flush_failure_or_poisoned_page_never_advances_checkpoint() {
        struct Fail;
        impl std::io::Write for Fail {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        let mut c = cursor();
        let mut committed = false;
        assert!(consume_event_page(&mut c, page(), &mut Fail, |_| {
            committed = true;
            Ok(())
        })
        .is_err());
        assert!(!committed);
        assert_eq!(c.sequence, 0);
        let mut bad = page();
        bad["events"][0]["token"] = json!("SECRET");
        assert!(consume_event_page(&mut c, bad, &mut Vec::new(), |_| Ok(())).is_err());
        assert_eq!(c.sequence, 0);
    }
    #[test]
    fn t17_slow_writer_has_no_owner_history_or_relay_lock_and_bounded_page() {
        let manager = Arc::new(super::super::SessionManager::default());
        struct Probe(Arc<super::super::SessionManager>);
        impl std::io::Write for Probe {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                assert!(self.0.relay.try_lock().is_ok());
                assert!(self.0.history.try_lock().is_ok());
                std::thread::sleep(std::time::Duration::from_millis(1));
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut c = cursor();
        consume_event_page(&mut c, page(), &mut Probe(manager.clone()), |_| Ok(())).unwrap();
        assert!(!manager.desktop_connected.load(Ordering::Acquire));
        assert!(manager.input_leases.try_lock().is_ok());
    }
}

fn instance_change(writer: &mut impl std::io::Write) -> Result<(), ErrorClass> {
    writer
        .write_all(b"{\"type\":\"instance_change\"}\n")
        .and_then(|_| writer.flush())
        .map_err(|_| ErrorClass::Connection)
}
fn read_event_page(
    client: &super::background::Client,
    root: &Path,
    sequence: u64,
    writer: &mut impl std::io::Write,
) -> Result<serde_json::Value, ErrorClass> {
    for attempt in 0..3 {
        match client.call_cli("cli_events", serde_json::json!({"cursor":sequence})) {
            Ok(page) => return Ok(page),
            Err(ErrorClass::Connection) => {
                // Inspect only for a changed identity. Never construct/connect a replacement client.
                if super::background::Descriptor::read(root)
                    .is_ok_and(|d| d.instance != client.event_instance())
                {
                    instance_change(writer)?;
                    return Err(ErrorClass::Connection);
                }
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(250 * (attempt + 1)));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(ErrorClass::Connection)
}
pub(super) fn stream_events_for_client(
    client: &super::background::Client,
    root: &Path,
    path: &Path,
    writer: &mut impl std::io::Write,
) -> Result<(), ErrorClass> {
    let mut cursor = load_event_cursor(path)?.unwrap_or_else(|| EventCursor {
        version: 1,
        instance: client.event_instance().into(),
        sequence: 0,
    });
    if cursor.instance != client.event_instance() {
        instance_change(writer)?;
        return Err(ErrorClass::Connection);
    }
    loop {
        let page = read_event_page(client, root, cursor.sequence, writer)?;
        consume_event_page(&mut cursor, page, writer, |next| {
            checkpoint_event_cursor(path, next)
        })?;
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}
fn run_events(path: &Path) -> Result<(), ErrorClass> {
    load_event_cursor(path)?; // Invalid cursor input fails before owner discovery or output.
    let context = super::app_context();
    let root = resolve_owner_root(
        &context.config().identifier,
        context.config().app.app_directories_override.is_some(),
        native_user_data,
    )?;
    let client = connect_owner(
        &root,
        false,
        || Err("cli_events_existing_owner_only".into()),
    )?;
    stream_events_for_client(&client, &root, path, &mut std::io::stdout().lock())
}
