// Author: Jeff.Liu. A terminal owns its Shell; each foreground Agent is a separate run.
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    launch: super::AgentLaunch,
    argv: Vec<String>,
    env: BTreeMap<String, String>,
    root: PathBuf,
    cwd: PathBuf,
    terminal: String,
    prepared: super::agent_bridge::Prepared,
    #[serde(default)]
    run: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchFile {
    terminal: String,
    initial: Option<Manifest>,
}
pub(super) struct Assets {
    directory: PathBuf,
    launch_template: Option<super::AgentLaunch>,
    _zsh: Option<super::zsh_directory_reporting::Assets>,
}
impl Drop for Assets {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn configured_launch(
    template: Option<&super::AgentLaunch>,
    adapter: &str,
    extra: &[String],
) -> Result<super::AgentLaunch, String> {
    if extra.len() > 250 || extra.iter().any(|s| s.len() > 65536 || s.contains('\0')) {
        return Err("Invalid interactive Agent options".into());
    }
    let mut launch = template
        .filter(|l| l.adapter == adapter && l.mode == "interactive")
        .cloned()
        .unwrap_or(super::AgentLaunch {
            adapter: adapter.into(),
            mode: "interactive".into(),
            extra_args: String::new(),
            prompt: None,
            provider: None,
            codex: None,
            claude_context: None,
            env_refs: BTreeMap::new(),
        });
    launch.prompt = None;
    if !extra.is_empty() {
        launch.extra_args.push(' ');
        launch
            .extra_args
            .push_str(&extra.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "));
    }
    if launch.extra_args.len() > 65536 {
        return Err("Agent options are too large".into());
    }
    Ok(launch)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryEvidence {
    version: u8,
    terminal: String,
    generation: String,
    run: String,
    helper: u32,
    helper_identity: u64,
    members: BTreeMap<u32, u64>,
}
fn recovery_path(root: &Path, generation: &str, run: &str) -> Result<PathBuf, String> {
    if [generation, run]
        .iter()
        .any(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("Invalid recovery identity".into());
    }
    let base = root.join("interactive-shell-recovery");
    super::background::private_root(&base)?;
    Ok(base.join(format!("{generation}-{run}.json")))
}
fn write_recovery(root: &Path, proof: &RecoveryEvidence) -> Result<(), String> {
    use std::io::Write;
    let path = recovery_path(root, &proof.generation, &proof.run)?;
    let bytes = serde_json::to_vec(proof).map_err(|_| "Cannot encode recovery evidence")?;
    if bytes.len() > 512 * 1024 {
        return Err("Recovery evidence exceeds its budget; open a new terminal".into());
    }
    let mut file = super::background::private_file(&path, true)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save recovery evidence; open a new terminal".into())
}
#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}
#[cfg(unix)]
pub(super) fn recover(history: &super::HistoryStore, session: &str) -> Result<(), String> {
    use std::io::Read;
    let _guard = super::worktree_manager::start_guard()?;
    let record = history.get(session)?;
    if !matches!(record.status.as_str(), "starting" | "running") {
        return Err("Terminal is no longer running".into());
    }
    if record.agent.phase == "shell" {
        return Ok(());
    }
    let run = record
        .agent
        .process_run
        .as_deref()
        .ok_or("No verifiable Agent run; open a new terminal")?;
    let path = recovery_path(&history.root, &record.agent.generation, run)?;
    let mut bytes = vec![];
    super::background::private_file(&path, false)?
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read recovery evidence")?;
    if bytes.len() > 512 * 1024 {
        return Err("Recovery evidence exceeds its budget".into());
    }
    let proof: RecoveryEvidence = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid recovery evidence; open a new terminal")?;
    if proof.version != 1
        || proof.terminal != session
        || proof.generation != record.agent.generation
        || proof.run != run
        || proof.helper == 0
        || proof.helper > i32::MAX as u32
        || proof.helper_identity == 0
        || proof
            .members
            .iter()
            .any(|(pid, _)| *pid == 0 || *pid > i32::MAX as u32)
    {
        return Err("Recovery evidence does not match the current Agent run".into());
    }
    if super::memory::process_identity(proof.helper).is_some() || process_exists(proof.helper) {
        return Err(
            "Previous helper is still present or its PID was reused; recovery refused".into(),
        );
    }
    if process_rows()?
        .iter()
        .any(|(pid, _, group, zombie)| !zombie && (*pid == proof.helper || *group == proof.helper))
    {
        return Err("Previous Agent job is still present; stop it before recovery".into());
    }
    for (pid, stamp) in &proof.members {
        // Zero records an observed PID with no trusted identity: only its absence permits recovery.
        if *stamp == 0 {
            if process_exists(*pid) {
                return Err(
                    "An unidentified observed Agent PID is still present; recovery refused".into(),
                );
            }
            continue;
        }
        let identity = super::memory::process_identity(*pid);
        if identity == Some(*stamp) || (identity.is_none() && process_exists(*pid)) {
            return Err(
                "An observed Agent child is still present or cannot be verified; recovery refused"
                    .into(),
            );
        }
    }
    history.ingest_agent_run(
        session,
        &proof.generation,
        &super::agent_events::AgentEvent {
            kind: "ProcessExit".into(),
            agent_session_id: proof.generation.clone(),
            turn_id: Some(proof.run.clone()),
            permission_key: None,
            source: None,
        },
        Some(&proof.run),
    )?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn shell(
    root: &Path,
    program: &Path,
    helper: &Path,
    manifest: &Path,
    adapter: &str,
    initial: bool,
    template: Option<&CommandBuilder>,
    reporting: (bool, bool),
) -> Result<
    (
        CommandBuilder,
        Option<super::zsh_directory_reporting::Assets>,
    ),
    String,
> {
    if !matches!(adapter, "pi" | "codex" | "claude" | "gemini" | "opencode") {
        return Err("Unsupported interactive Agent".into());
    }
    let helper = quote(helper.to_str().ok_or("Invalid helper path")?);
    let manifest = quote(manifest.to_str().ok_or("Invalid Agent launch path")?);
    let mut startup=format!("function yam-agent {{ local mode=${{1:-new}}; if (( $# )); then shift; fi; case \"$mode\" in new|resume|recover) ;; *) printf \"Usage: yam-agent new|resume|recover\\n\"; return 2;; esac; {helper} --yam-interactive-agent {manifest} \"$mode\" last -- \"$@\"; }}\n");
    for name in ["pi", "codex", "claude", "gemini", "opencode"] {
        startup.push_str(&format!("function {name} {{ case \"${{1-}}\" in --help|-h|--version|-v|-V) command {name} \"$@\";; *) {helper} --yam-interactive-agent {manifest} new {name} -- \"$@\";; esac; }}\n"));
    }
    startup.push_str(&format!(
        "function _yam_agent_initial {{ unset -f _yam_agent_initial; {}; return 0; }}\n",
        if initial {
            format!("{helper} --yam-interactive-agent {manifest} initial {adapter} --")
        } else {
            ":".into()
        }
    ));
    let mut builder = template
        .cloned()
        .unwrap_or_else(|| CommandBuilder::new(program));
    builder.env("PATH", super::agent_path());
    match program.file_name().and_then(|v| v.to_str()) {
        Some("zsh") => {
            if template.is_none() {
                builder.arg("-l");
            }
            builder.arg("-i");
            let assets = super::zsh_directory_reporting::prepare_agent(
                root,
                &mut builder,
                &startup,
                reporting.0,
                reporting.1,
            )
            .map_err(|_| "Cannot prepare interactive zsh")?;
            Ok((builder, Some(assets)))
        }
        Some("bash") => {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let rc = root.join("agent.bashrc");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&rc)
                .map_err(|e| e.to_string())?;
            let login =
                template.is_none_or(|b| b.get_argv().iter().any(|a| a == "-l" || a == "--login"));
            let configuration = if login {
                r#"[[ ! -r /etc/profile ]] || source /etc/profile
if [[ -r ~/.bash_profile ]]; then source ~/.bash_profile
elif [[ -r ~/.bash_login ]]; then source ~/.bash_login
elif [[ -r ~/.profile ]]; then source ~/.profile
fi"#
            } else {
                "[[ ! -r ~/.bashrc ]] || source ~/.bashrc"
            };
            // Bash establishes job control after rc processing; launch only at the first prompt.
            let first_prompt = if initial {
                r#"
_yam_saved_prompt=( "${PROMPT_COMMAND[@]-}" )
_yam_prompt_type=$(declare -p PROMPT_COMMAND 2>/dev/null || :)
_yam_prompt_array=0; case "$_yam_prompt_type" in 'declare -a'*) _yam_prompt_array=1;; esac
_yam_prompt_exported=0; case "${_yam_prompt_type%% PROMPT_COMMAND=*}" in *x*) _yam_prompt_exported=1;; esac
unset PROMPT_COMMAND
PROMPT_COMMAND=_yam_agent_first_prompt
function _yam_agent_first_prompt {
  unset PROMPT_COMMAND
  if (( _yam_prompt_array )); then PROMPT_COMMAND=( "${_yam_saved_prompt[@]}" ); else PROMPT_COMMAND=${_yam_saved_prompt[0]-}; fi
  if (( _yam_prompt_exported )); then export PROMPT_COMMAND; fi
  unset _yam_saved_prompt _yam_prompt_type _yam_prompt_array _yam_prompt_exported
  unset -f _yam_agent_first_prompt
  _yam_agent_initial
  local _yam_prompt
  for _yam_prompt in "${PROMPT_COMMAND[@]-}"; do if [[ -n $_yam_prompt ]]; then eval "$_yam_prompt"; fi; done
}
"#
            } else {
                "_yam_agent_initial\n"
            };
            write!(file, "{configuration}\n{startup}\n{first_prompt}\n")
                .map_err(|e| e.to_string())?;
            builder.get_argv_mut().truncate(1);
            builder.args(["--noprofile", "--rcfile"]);
            builder.arg(rc);
            builder.arg("-i");
            Ok((builder, None))
        }
        _ => Err("Interactive Agents require zsh or bash; choose a supported default Shell".into()),
    }
}

#[cfg(unix)]
pub(super) fn wrap(
    root: &Path,
    builder: CommandBuilder,
    launch: Option<&super::AgentLaunch>,
    prepared: Option<&super::agent_bridge::Prepared>,
    terminal: &str,
    reporting: (bool, bool),
) -> Result<(CommandBuilder, Assets), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let base = root.join("interactive-shells");
    super::background::private_root(&base)?;
    let directory = base.join(super::agent_bridge::credential()?);
    super::background::private_root(&directory)?;
    let mut assets = Assets {
        directory,
        launch_template: launch.cloned(),
        _zsh: None,
    };
    let cwd: PathBuf = builder
        .get_cwd()
        .ok_or("Missing terminal directory")?
        .into();
    let initial = match (launch, prepared) {
        (Some(launch), Some(prepared)) => Some(Manifest {
            launch: launch.clone(),
            argv: builder
                .get_argv()
                .iter()
                .map(|a| {
                    a.to_str()
                        .map(str::to_string)
                        .ok_or("Agent arguments must be UTF-8")
                })
                .collect::<Result<_, _>>()?,
            env: builder
                .iter_extra_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            root: root.into(),
            cwd: cwd.clone(),
            terminal: terminal.into(),
            prepared: prepared.clone(),
            run: None,
        }),
        (None, None) => None,
        _ => return Err("Incomplete Agent launch".into()),
    };
    let default_adapter = launch.map_or("pi", |l| l.adapter.as_str());
    let manifest = LaunchFile {
        terminal: terminal.into(),
        initial,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Interactive Agent configuration is too large".into());
    }
    let path = assets.directory.join("launch.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    let helper = std::env::current_exe().map_err(|e| e.to_string())?;
    let program = if launch.is_none() {
        builder.get_argv()[0].clone()
    } else {
        super::owner_default_shell()
    };
    let (mut shell, zsh) = shell(
        &assets.directory,
        Path::new(&program),
        &helper,
        &path,
        default_adapter,
        manifest.initial.is_some(),
        launch.is_none().then_some(&builder),
        reporting,
    )?;
    shell.cwd(&cwd);
    #[cfg(unix)]
    super::configure_terminal_environment(&mut shell);
    assets._zsh = zsh;
    Ok((shell, assets))
}
#[cfg(test)]
pub(super) fn initial_argv(builder: &CommandBuilder) -> Option<Vec<std::ffi::OsString>> {
    let path = builder
        .get_argv()
        .windows(2)
        .find(|a| a[0] == "--rcfile")
        .and_then(|a| Path::new(&a[1]).parent())
        .map(|p| p.join("launch.json"))
        .or_else(|| {
            builder
                .get_env("YAM_ZSH_INIT")
                .and_then(|p| Path::new(p).ancestors().nth(3))
                .map(|p| p.join("launch.json"))
        })?;
    Some(
        read_manifest(&path)
            .ok()?
            .initial?
            .argv
            .into_iter()
            .map(Into::into)
            .collect(),
    )
}
fn read_manifest(path: &Path) -> Result<LaunchFile, String> {
    use std::io::Read;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        for (p, directory) in [
            (path, false),
            (path.parent().ok_or("Invalid Agent path")?, true),
        ] {
            let m =
                std::fs::symlink_metadata(p).map_err(|_| "Agent launch is no longer available")?;
            if m.file_type().is_symlink()
                || m.is_dir() != directory
                || (!directory && !m.is_file())
                || m.permissions().mode() & 0o077 != 0
                || m.uid() != unsafe { libc::geteuid() }
            {
                return Err("Unsafe Agent launch file".into());
            }
        }
    }
    let mut bytes = vec![];
    std::fs::File::open(path)
        .map_err(|_| "Cannot open Agent launch")?
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read Agent launch")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Agent launch is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Agent launch".into())
}
fn command(
    manifest: &Manifest,
    mode: &str,
    extra: &[String],
    native: Option<&str>,
    cwd: &Path,
) -> Result<CommandBuilder, String> {
    if mode == "initial" {
        if !extra.is_empty()
            || cwd.canonicalize().map_err(|e| e.to_string())?
                != manifest.cwd.canonicalize().map_err(|e| e.to_string())?
        {
            return Err("Invalid initial Agent launch".into());
        }
        let mut builder =
            CommandBuilder::new(manifest.argv.first().ok_or("Missing Agent executable")?);
        builder.args(&manifest.argv[1..]);
        for (k, v) in &manifest.env {
            builder.env(k, v);
        }
        builder.cwd(cwd);
        return Ok(builder);
    }
    if !matches!(mode, "new" | "resume") {
        return Err("Usage: yam-agent new|resume [CLI options]".into());
    }
    let mut launch = manifest.launch.clone();
    launch.prompt = None;
    if !extra.is_empty() {
        launch.extra_args.push(' ');
        launch
            .extra_args
            .push_str(&extra.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "));
    }
    let executable = Path::new(manifest.argv.first().ok_or("Missing Agent executable")?);
    super::provider_launch::validate_project(&launch, cwd)?;
    let mut builder = if mode == "resume" {
        super::resume_command(
            executable,
            &launch,
            native
                .filter(|id| super::valid_resume_id(id))
                .ok_or("No trusted native conversation is available; use yam-agent new")?,
        )?
    } else {
        super::agent_command(executable, &launch)?
    };
    for (k, v) in &manifest.env {
        builder.env(k, v);
    }
    // Rebuild native hooks after native arguments, using only this terminal's private configuration.
    if launch.adapter == "pi" {
        let id = if mode == "resume" {
            let id = native.unwrap();
            super::pi_router::validate_session(&manifest.root, id, cwd)?;
            id.to_string()
        } else {
            super::gemini_resume::new_id()?
        };
        let file = super::pi_router::session_file(&manifest.root, &id)?;
        let entry = super::pi_router::stage(&manifest.root)?;
        builder.args([
            std::ffi::OsStr::new("--extension"),
            entry.as_os_str(),
            std::ffi::OsStr::new("--session"),
            file.as_os_str(),
        ]);
    } else if launch.adapter == "gemini" && mode == "new" {
        builder.args(["--session-id", &super::gemini_resume::new_id()?]);
    }
    builder.cwd(cwd);
    Ok(builder)
}
#[cfg(unix)]
fn parse_process_rows(text: &str) -> Result<Vec<(u32, u32, u32, bool)>, String> {
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err("Incomplete process snapshot".into());
        }
        rows.push((
            fields[0].parse().map_err(|_| "Invalid process snapshot")?,
            fields[1].parse().map_err(|_| "Invalid process snapshot")?,
            fields[2].parse().map_err(|_| "Invalid process snapshot")?,
            fields[3].starts_with('Z'),
        ));
    }
    if rows.is_empty() {
        return Err("Empty process snapshot".into());
    }
    Ok(rows)
}
#[cfg(unix)]
fn ps_process_rows() -> Result<Vec<(u32, u32, u32, bool)>, String> {
    let mut budget = super::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
        remaining: 1024 * 1024,
    };
    let output = budget
        .run_env(
            &super::system_ps_path(&[Path::new("/bin/ps"), Path::new("/usr/bin/ps")])?,
            &["-axo", "pid=,ppid=,pgid=,stat="],
            Path::new("/"),
            &[],
        )
        .map_err(|_| "Cannot inspect Agent children within the process snapshot budget")?;
    if !output.status.success() {
        return Err("Cannot inspect Agent children".into());
    }
    parse_process_rows(
        std::str::from_utf8(&output.stdout).map_err(|_| "Invalid process snapshot encoding")?,
    )
}
#[cfg(unix)]
fn process_rows() -> Result<Vec<(u32, u32, u32, bool)>, String> {
    #[cfg(target_os = "macos")]
    {
        super::memory::process_tree().or_else(|_| ps_process_rows())
    }
    #[cfg(not(target_os = "macos"))]
    {
        ps_process_rows()
    }
}
#[cfg(unix)]
fn run_members(root: u32, owned: &mut BTreeMap<u32, u64>) -> Result<Vec<u32>, String> {
    let mut unidentified = owned
        .iter()
        .filter_map(|(pid, stamp)| (*stamp == 0).then_some(*pid))
        .collect::<std::collections::BTreeSet<_>>();
    let rows = process_rows()?;
    let owns_group = unsafe { libc::getpgrp() } == root as i32;
    let mut selected = vec![root];
    for (pid, _, group, zombie) in &rows {
        if *zombie {
            continue;
        }
        let tracked = match owned.get(pid).copied() {
            Some(0) => true,
            Some(stamp) => match super::memory::process_identity(*pid) {
                Some(current) => current == stamp,
                None => {
                    owned.insert(*pid, 0);
                    unidentified.insert(*pid);
                    true
                }
            },
            None => false,
        };
        if ((owns_group && *group == root) || tracked) && !selected.contains(pid) {
            selected.push(*pid);
        }
    }
    let mut index = 0;
    while index < selected.len() {
        for (pid, parent, _, zombie) in &rows {
            if !*zombie && *parent == selected[index] && !selected.contains(pid) {
                selected.push(*pid);
            }
        }
        index += 1;
    }
    let mut live = vec![];
    let candidates = selected
        .into_iter()
        .filter(|p| *p != root)
        .collect::<Vec<_>>();
    // Reserve every discovered PID before inspection can fail or a parent can disappear.
    for pid in &candidates {
        owned.entry(*pid).or_insert(0);
    }
    for pid in candidates {
        if unidentified.contains(&pid) {
            if process_exists(pid) {
                return Err("An unidentified observed Agent PID is still present".into());
            }
            owned.remove(&pid);
            continue;
        }
        if let Some(stamp) = super::memory::process_identity(pid) {
            owned.insert(pid, stamp);
            live.push(pid);
        } else if process_exists(pid) {
            owned.insert(pid, 0);
            if process_rows()?.iter().any(|r| r.0 == pid && !r.3) {
                return Err("An Agent child is live but its identity cannot be verified".into());
            }
            owned.remove(&pid);
        } else {
            owned.remove(&pid);
        }
    }
    Ok(live)
}
#[cfg(unix)]
fn cleanup_run(root: u32, owned: &mut BTreeMap<u32, u64>) -> Result<(), String> {
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            let members = run_members(root, owned)?;
            if members.is_empty() {
                return Ok(());
            }
            for pid in members {
                if owned
                    .get(&pid)
                    .is_some_and(|stamp| super::memory::process_identity(pid) == Some(*stamp))
                {
                    super::signal_process(pid, signal)?;
                }
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    if run_members(root, owned)?.is_empty() {
        Ok(())
    } else {
        Err("Agent children did not stop".into())
    }
}
#[cfg(unix)]
fn run(manifest: Manifest, mode: &str, extra: &[String]) -> Result<i32, String> {
    use std::os::unix::process::CommandExt;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let builder = command(&manifest, mode, extra, None, &cwd)?;
    let run = manifest
        .run
        .clone()
        .map(Ok)
        .unwrap_or_else(super::agent_bridge::credential)?;
    let address = manifest
        .env
        .get("YAM_AGENT_ADDRESS")
        .ok_or("Missing Agent connection")?
        .parse()
        .map_err(|_| "Invalid Agent connection")?;
    let known = builder.get_argv().windows(2).find_map(|a| {
        if a[0] == "--session" {
            Path::new(&a[1]).file_stem()?.to_str().map(str::to_string)
        } else if a[0] == "--session-id" {
            a[1].to_str().map(str::to_string)
        } else {
            None
        }
    });
    let event = |kind: &str| super::agent_events::AgentEvent {
        kind: kind.into(),
        agent_session_id: known
            .clone()
            .unwrap_or_else(|| manifest.prepared.generation.clone()),
        turn_id: Some(run.clone()),
        permission_key: None,
        source: None,
    };
    if manifest.run.is_none() {
        super::agent_bridge::submit_run(
            address,
            &manifest.prepared.token,
            event("ProcessStart"),
            Some(run.clone()),
        )?;
    }
    let mut child = std::process::Command::new(&builder.get_argv()[0]);
    child
        .args(&builder.get_argv()[1..])
        .current_dir(&cwd)
        .envs(builder.iter_extra_env_as_str())
        .env("YAM_AGENT_RUN", &run);
    // The Shell owns job control. Only the waiting helper ignores interactive signals.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
        child.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGQUIT, libc::SIG_DFL);
            Ok(())
        });
    }
    let root = std::process::id();
    let helper_identity =
        super::memory::process_identity(root).ok_or("Cannot verify the Agent helper identity")?;
    let mut owned = BTreeMap::new();
    let tty = unsafe {
        let mut mode = std::mem::zeroed();
        (libc::tcgetattr(libc::STDIN_FILENO, &mut mode) == 0).then_some(mode)
    };
    let result = if unsafe { libc::getpgrp() } != root as i32 {
        Err("The interactive Agent must own its foreground job; no CLI was started".into())
    } else {
        child
            .spawn()
            .map_err(|_| "Agent failed to start".to_string())
            .and_then(|mut process| loop {
                if let Err(error) = run_members(root, &mut owned) {
                    let _ = process.kill();
                    let _ = process.wait();
                    break Err(error);
                }
                match process.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                    Err(error) => {
                        let _ = process.kill();
                        let _ = process.wait();
                        break Err(error.to_string());
                    }
                }
            })
    };
    let cleanup = cleanup_run(root, &mut owned);
    if let Some(mode) = tty {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &mode);
        }
    }
    if unsafe { libc::isatty(libc::STDOUT_FILENO) } == 1 {
        use std::io::Write;
        let _ = std::io::stdout().write_all(b"\x1b[?1049l\x1b[?25h\x1b[0m");
    }
    let save_recovery = || {
        write_recovery(
            &manifest.root,
            &RecoveryEvidence {
                version: 1,
                terminal: manifest.terminal.clone(),
                generation: manifest.prepared.generation.clone(),
                run: run.clone(),
                helper: root,
                helper_identity,
                members: owned.clone(),
            },
        )
    };
    if let Err(error) = cleanup {
        save_recovery()?;
        return Err(format!("{error}; cleanup is unconfirmed. After stopping remaining Agent processes, run yam-agent recover. No task will be replayed."));
    }
    if let Err(error) = super::agent_bridge::submit_run(
        address,
        &manifest.prepared.token,
        event("ProcessExit"),
        Some(run.clone()),
    ) {
        save_recovery()?;
        return Err(format!(
            "{error}; exit could not be confirmed. Run yam-agent recover after this helper exits."
        ));
    }
    match result {
        Ok(status) => {
            use std::os::unix::process::ExitStatusExt;
            let code = status
                .code()
                .or_else(|| status.signal().map(|signal| 128 + signal))
                .unwrap_or(1);
            eprintln!("\n[YAM] Agent exited ({code}). Shell ready. {}: new conversation; yam-agent resume: continue.",manifest.launch.adapter);
            Ok(code)
        }
        Err(error) => Err(error),
    }
}
pub(super) fn entry(argv: &[std::ffi::OsString]) -> Option<Result<i32, String>> {
    if argv.first().and_then(|s| s.to_str()) != Some("--yam-interactive-agent") {
        return None;
    }
    Some((|| {
        #[cfg(not(unix))]
        {
            let _ = argv;
            return Err("Interactive Shell integration is unavailable on this platform".into());
        }
        #[cfg(unix)]
        {
            if argv.len() < 5 || argv.len() > 256 || argv[4] != "--" {
                return Err("Invalid Agent launch arguments".into());
            }
            let mode = argv[2].to_str().ok_or("Invalid Agent operation")?;
            let adapter = argv[3]
                .to_str()
                .filter(|s| {
                    matches!(
                        *s,
                        "pi" | "codex" | "claude" | "gemini" | "opencode" | "last"
                    )
                })
                .ok_or("Invalid Agent adapter")?;
            let extra = argv[5..]
                .iter()
                .map(|a| a.to_str().map(str::to_string).ok_or("Invalid Agent option"))
                .collect::<Result<Vec<_>, _>>()?;
            let file = read_manifest(Path::new(&argv[1]))?;
            if mode == "recover" {
                if adapter != "last" || !extra.is_empty() {
                    return Err("Usage: yam-agent recover (no options)".into());
                }
                let descriptor = super::background::Descriptor::read(
                    &super::cli::owner_root().map_err(|_| "Background owner unavailable")?,
                )?;
                super::background::Client::new(descriptor)?.call(
                    "recover_terminal_agent",
                    serde_json::json!({"session_id":file.terminal}),
                )?;
                eprintln!("[YAM] Recovery confirmed. Shell ready; no task was replayed.");
                return Ok(0);
            }
            let manifest = if mode == "initial" {
                file.initial.ok_or("This terminal has no initial Agent")?
            } else {
                if !matches!(mode, "new" | "resume") {
                    return Err("Usage: yam-agent new|resume [CLI options]".into());
                }
                let descriptor = super::background::Descriptor::read(
                    &super::cli::owner_root().map_err(|_| "Background owner unavailable")?,
                )?;
                let value=super::background::Client::new(descriptor)?.call("start_terminal_agent",serde_json::json!({"session_id":file.terminal,"adapter":adapter,"mode":mode,"extra":extra,"cwd":std::env::current_dir().map_err(|e|e.to_string())?}))?;
                serde_json::from_value(value).map_err(|_| "Invalid prepared Agent response")?
            };
            run(manifest, "initial", &[])
        }
    })())
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    #[test]
    fn interactive_shell_survives_cli_failure_and_restarts_in_same_shell() {
        for (program, login) in [
            ("/bin/zsh", true),
            ("/bin/bash", true),
            ("/bin/bash", false),
        ] {
            let root =
                std::env::temp_dir().join(format!("yam-shell-test-{}", crate::next_session_id()));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(
                root.join(".zshrc"),
                "PROMPT='READY>'; export FIXTURE_VALUE=preserved; export PATH=\"$HOME:$PATH\"\n",
            )
            .unwrap();
            std::fs::write(root.join(".zprofile"), "export FIXTURE_PROFILE=loaded\n").unwrap();
            std::fs::write(
                root.join(".bash_profile"),
                "export FIXTURE_PROFILE=loaded\nsource ~/.bashrc\n",
            )
            .unwrap();
            std::fs::write(
                root.join(".bashrc"),
                "PS1='READY>'; export FIXTURE_VALUE=preserved; export PATH=\"$HOME:$PATH\"; PROMPT_COMMAND='printf \"USER-PROMPT\\n\"'\n",
            )
            .unwrap();
            let info = root.join("pi");
            std::fs::write(&info, "#!/bin/sh\nprintf 'NATIVE-META:%s\\n' \"$1\"\n").unwrap();
            std::fs::set_permissions(&info, std::fs::Permissions::from_mode(0o700)).unwrap();
            let helper = root.join("fake-cli");
            std::fs::write(
                &helper,
                "#!/bin/sh\nprintf 'CLI-RAN:%s:%s\\n' \"$FIXTURE_VALUE\" \"$3\"\nprintf 'CLI-PROFILE:%s\\n' \"$FIXTURE_PROFILE\"\nexit 17\n",
            )
            .unwrap();
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
            let template = (!login).then(|| CommandBuilder::new(program));
            let (mut b, _assets) = shell(
                &root,
                Path::new(program),
                &helper,
                &root.join("manifest.json"),
                "pi",
                true,
                template.as_ref(),
                (false, false),
            )
            .unwrap();
            b.env("HOME", &root);
            b.env("YAM_ZSH_ENV_PRESENT", "0");
            b.cwd(&root);
            // prepare owns ZDOTDIR; use an isolated original startup location without replacing it.
            if let Some(value) = b.get_env("YAM_ZSH_INIT").map(|v| v.to_owned()) {
                b.env("YAM_ZSH_INIT", value);
            }
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows: 24,
                    cols: 100,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut child = pair.slave.spawn_command(b).unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            drop(pair.slave);
            let (tx, rx) = std::sync::mpsc::channel();
            let reading = std::thread::spawn(move || {
                let mut buf = [0; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let mut output = String::new();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !output.contains("READY>") && Instant::now() < deadline {
                if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(20)) {
                    output.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
            writer.write_all(b"printf 'SHELL-PID:%s\\n' $$; pi --version; pi --help; pi; yam-agent resume; yam-agent recover; printf 'AFTER:%s\\n' $$; exit\n").unwrap();
            while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
                if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(20)) {
                    output.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
            if child.try_wait().unwrap().is_none() {
                child.kill().unwrap();
            }
            child.wait().unwrap();
            drop(writer);
            drop(pair.master);
            reading.join().unwrap();
            while let Ok(bytes) = rx.try_recv() {
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
            std::fs::remove_dir_all(&root).unwrap();
            assert!(
                output.contains("CLI-RAN:preserved:initial"),
                "initial CLI missing: {output}"
            );
            assert!(
                output.contains("CLI-RAN:preserved:new"),
                "managed CLI restart missing: {output}"
            );
            assert!(
                output.contains("CLI-RAN:preserved:resume"),
                "managed resume missing: {output}"
            );
            assert!(
                output.contains("CLI-RAN:preserved:recover"),
                "local recovery command missing: {output}"
            );
            assert!(
                output.contains("CLI-PROFILE:loaded") == login,
                "login profile was lost for {program}: {output}"
            );
            assert!(
                output.contains("NATIVE-META:--version") && output.contains("NATIVE-META:--help"),
                "metadata must bypass Agent creation: {output}"
            );
            assert_eq!(
                output.matches("CLI-RAN:preserved:").count(),
                4,
                "metadata mutated managed run: {output}"
            );
            if program.ends_with("bash") {
                assert_eq!(
                    output.matches("USER-PROMPT").count(),
                    1,
                    "original PROMPT_COMMAND was lost or duplicated: {output}"
                );
            }
            let pid = output
                .lines()
                .find_map(|s| s.trim().strip_prefix("SHELL-PID:"))
                .unwrap();
            assert!(
                output.contains(&format!("AFTER:{pid}")),
                "Shell was replaced: {output}"
            );
        }
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use crate::agent_events::{AgentEvent, AgentState};
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "explicit macOS permission-boundary check; does not terminate any process"]
    fn interactive_shell_tracked_unreadable_pid_cannot_disappear_from_ownership() {
        assert!(
            crate::memory::process_identity(1).is_none(),
            "Run this check as the normal desktop user"
        );
        let mut owned = BTreeMap::from([(1, 123)]);
        assert!(run_members(std::process::id(), &mut owned).is_err());
        assert_eq!(owned.get(&1), Some(&0));
    }
    #[test]
    fn interactive_shell_failed_scan_remembers_all_discovered_children() {
        let mut first = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut second = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut owned = BTreeMap::from([(first.id(), 0)]);
        let result = run_members(std::process::id(), &mut owned);
        first.kill().unwrap();
        first.wait().unwrap();
        second.kill().unwrap();
        second.wait().unwrap();
        assert!(result.is_err());
        assert!(
            owned.contains_key(&second.id()),
            "A failed inspection must not forget another discovered child"
        );
    }
    #[test]
    fn interactive_shell_unidentified_observed_child_is_never_reclaimed_as_a_new_pid() {
        let mut root = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut owned = BTreeMap::from([(pid, 0)]);
        let result = run_members(root.id(), &mut owned);
        child.kill().unwrap();
        child.wait().unwrap();
        let after = run_members(root.id(), &mut owned);
        root.kill().unwrap();
        root.wait().unwrap();
        assert!(
            result.is_err(),
            "An unidentified observed PID must stay blocked even if a readable process now uses it"
        );
        assert_eq!(
            owned[&pid], 0,
            "Never adopt a new identity for an unidentified observed PID"
        );
        assert!(!after.unwrap().contains(&pid));
    }
    #[test]
    fn interactive_shell_fallback_snapshot_refuses_partial_or_empty_rows() {
        assert_eq!(
            parse_process_rows("11 1 11 S+\n12 11 11 Z\n").unwrap(),
            vec![(11, 1, 11, false), (12, 11, 11, true)]
        );
        for bad in [
            "",
            " \n",
            "11 1 S",
            "11 1 11 S\nbad row\n",
            "11 1 nope S",
            "11 1 11 S extra",
        ] {
            assert!(parse_process_rows(bad).is_err());
        }
        let pid = std::process::id();
        assert!(ps_process_rows().unwrap().iter().any(|row| row.0 == pid));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn interactive_shell_native_snapshot_matches_job_control_without_ps() {
        let source = include_str!("interactive_shell.rs");
        let rows_source = source
            .split("\nfn process_rows(")
            .nth(1)
            .unwrap()
            .split("\n#[cfg(unix)]\nfn run_members(")
            .next()
            .unwrap();
        assert!(
            rows_source.contains("super::memory::process_tree()"),
            "macOS scans must use native process enumeration"
        );
        let rows = process_rows().unwrap();
        let current = rows.iter().find(|r| r.0 == std::process::id()).unwrap();
        assert_eq!(current.1, unsafe { libc::getppid() } as u32);
        assert_eq!(current.2, unsafe { libc::getpgrp() } as u32);
        assert!(!current.3);
    }
    #[test]
    fn interactive_shell_recovery_requires_private_current_evidence_and_dead_processes() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        let root = std::env::temp_dir().join(format!("yam-recovery-{}", crate::next_session_id()));
        let history = crate::HistoryStore::open(root.clone()).unwrap();
        let generation = "a".repeat(64);
        let run = "b".repeat(64);
        let session = "s-1-1";
        history
            .start(&crate::SessionSummary {
                session_id: session.into(),
                cwd: root.to_string_lossy().into_owned(),
                command: None,
                status: "running".into(),
                launch: None,
                ssh: None,
            })
            .unwrap();
        history.configure_agent(session, &generation).unwrap();
        history
            .ingest_agent_run(
                session,
                &generation,
                &event("ProcessStart", "native-one", &run),
                Some(&run),
            )
            .unwrap();
        let before = history.get(session).unwrap().agent;
        assert!(recover(&history, session).is_err());
        assert_eq!(history.get(session).unwrap().agent, before);
        let mut helper = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut group_child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(helper.id() as i32)
            .spawn()
            .unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut proof = RecoveryEvidence {
            version: 1,
            terminal: session.into(),
            generation: generation.clone(),
            run: run.clone(),
            helper: helper.id(),
            helper_identity: crate::memory::process_identity(helper.id()).unwrap(),
            members: BTreeMap::from([(
                child.id(),
                crate::memory::process_identity(child.id()).unwrap(),
            )]),
        };
        let path = recovery_path(&root, &generation, &run).unwrap();
        write_recovery(&root, &proof).unwrap();
        assert!(recover(&history, session).is_err());
        helper.kill().unwrap();
        helper.wait().unwrap();
        assert!(
            recover(&history, session).unwrap_err().contains("job"),
            "Unobserved members of the previous job must prevent recovery"
        );
        group_child.kill().unwrap();
        group_child.wait().unwrap();
        assert!(
            recover(&history, session).is_err(),
            "A surviving observed descendant must prevent recovery"
        );
        proof.members.insert(child.id(), 0);
        std::fs::write(&path, serde_json::to_vec(&proof).unwrap()).unwrap();
        assert!(
            recover(&history, session).is_err(),
            "An unidentified observed PID must also block recovery"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        let helper_pid = proof.helper;
        proof.helper = std::process::id();
        proof.helper_identity = 1;
        std::fs::write(&path, serde_json::to_vec(&proof).unwrap()).unwrap();
        assert!(
            recover(&history, session).is_err(),
            "Reused or ambiguous helper PID must prevent recovery"
        );
        proof.helper = helper_pid;
        proof.run = "c".repeat(64);
        std::fs::write(&path, serde_json::to_vec(&proof).unwrap()).unwrap();
        assert!(
            recover(&history, session).is_err(),
            "Late evidence cannot unlock another run"
        );
        proof.run = run.clone();
        std::fs::write(&path, serde_json::to_vec(&proof).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(recover(&history, session).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        recover(&history, session).unwrap();
        assert_eq!(history.get(session).unwrap().agent.phase, "shell");
        assert_eq!(
            history
                .get(session)
                .unwrap()
                .agent
                .agent_session_id
                .as_deref(),
            Some("native-one")
        );
        assert!(!path.exists());
        recover(&history, session).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interactive_shell_invocations_keep_configuration_without_accumulating_arguments() {
        let template = crate::AgentLaunch {
            adapter: "pi".into(),
            mode: "interactive".into(),
            extra_args: "--yam-small p/small".into(),
            prompt: Some("initial only".into()),
            provider: None,
            codex: None,
            claude_context: None,
            env_refs: BTreeMap::from([("CONFIG_VALUE".into(), "config_ref".into())]),
        };
        let first = configured_launch(
            Some(&template),
            "pi",
            &["--skill".into(), "one's skill".into()],
        )
        .unwrap();
        let second =
            configured_launch(Some(&template), "pi", &["--skill".into(), "two".into()]).unwrap();
        let plain = configured_launch(Some(&template), "pi", &[]).unwrap();
        assert_eq!(
            crate::parse_agent_args(&first.extra_args).unwrap(),
            ["--yam-small", "p/small", "--skill", "one's skill"]
        );
        assert_eq!(
            crate::parse_agent_args(&second.extra_args).unwrap(),
            ["--yam-small", "p/small", "--skill", "two"]
        );
        assert_eq!(plain.extra_args, template.extra_args);
        assert_eq!(plain.env_refs, template.env_refs);
        assert!(plain.prompt.is_none());
        assert_eq!(template.prompt.as_deref(), Some("initial only"));
        assert!(configured_launch(Some(&template), "codex", &[])
            .unwrap()
            .extra_args
            .is_empty());
        assert!(configured_launch(None, "pi", &["bad\0arg".into()]).is_err());
        assert!(configured_launch(None, "pi", &vec!["--offline".into(); 251]).is_err());
        assert!(configured_launch(None, "pi", &["x".repeat(65537)]).is_err());
    }
    #[test]
    fn interactive_shell_owner_uses_terminal_template_for_each_invocation() {
        let source = include_str!("interactive_shell.rs");
        let start = source.split("\npub(super) fn start(").nth(1).unwrap();
        assert!(
            start.contains("configured_launch("),
            "Owner must build each invocation from the immutable terminal template"
        );
        assert!(
            start
                .split_whitespace()
                .collect::<String>()
                .contains("launch_template.as_ref()"),
            "Saved run arguments must not become terminal defaults"
        );
    }
    #[test]
    #[ignore = "explicit process-scan microbenchmark; no desktop or model execution"]
    fn interactive_shell_scan_benchmark() {
        let mut micros = Vec::new();
        for _ in 0..25 {
            let now = std::time::Instant::now();
            run_members(std::process::id(), &mut BTreeMap::new()).unwrap();
            micros.push(now.elapsed().as_micros());
        }
        micros.sort_unstable();
        println!(
            "SCAN_BENCH median_us={} min_us={} max_us={} samples={}",
            micros[12],
            micros[0],
            micros[24],
            micros.len()
        );
    }
    fn event(kind: &str, id: &str, run: &str) -> AgentEvent {
        AgentEvent {
            kind: kind.into(),
            agent_session_id: id.into(),
            turn_id: Some(run.into()),
            permission_key: None,
            source: None,
        }
    }
    #[test]
    fn interactive_shell_process_exit_keeps_history_and_blocks_duplicate_start() {
        let mut state = AgentState {
            generation: "generation".into(),
            ..Default::default()
        };
        state
            .apply(&event("ProcessStart", "native-one", "run-one"))
            .unwrap();
        assert_eq!(state.agent_session_id.as_deref(), Some("native-one"));
        let active = state.clone();
        assert!(state
            .apply(&event("ProcessStart", "native-two", "run-two"))
            .is_err());
        assert_eq!(state, active);
        state
            .apply(&event("ProcessExit", "generation", "old-run"))
            .unwrap();
        assert_eq!(state, active);
        state
            .apply(&event("ProcessExit", "generation", "run-one"))
            .unwrap();
        assert_eq!(state.phase, "shell");
        assert_eq!(state.agent_session_id.as_deref(), Some("native-one"));
        state
            .apply(&event("ProcessStart", "generation", "run-two"))
            .unwrap();
        assert_eq!(state.agent_session_id, None);
    }
    #[test]
    fn interactive_shell_private_manifest_rejects_symlinks_and_public_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root =
            std::env::temp_dir().join(format!("yam-shell-private-{}", crate::next_session_id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("launch.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_manifest(&path).unwrap_err_string().contains("Unsafe"));
        let link = root.join("linked.json");
        symlink(&path, &link).unwrap();
        assert!(read_manifest(&link).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_manifest(&path).unwrap_err_string().contains("Invalid"));
        std::fs::remove_dir_all(&root).unwrap();
    }
    trait ErrorString {
        fn unwrap_err_string(self) -> String;
    }
    impl<T> ErrorString for Result<T, String> {
        fn unwrap_err_string(self) -> String {
            match self {
                Err(e) => e,
                Ok(_) => panic!("expected error"),
            }
        }
    }
    #[test]
    fn interactive_shell_command_reuses_routing_without_replaying_initial_prompt() {
        let root =
            std::env::temp_dir().join(format!("yam-shell-command-{}", crate::next_session_id()));
        std::fs::create_dir(&root).unwrap();
        let prepared = crate::agent_bridge::Prepared::lifecycle().unwrap();
        let manifest = Manifest {
            launch: crate::AgentLaunch {
                adapter: "pi".into(),
                mode: "interactive".into(),
                extra_args: "--yam-small p/small --yam-strong p/strong".into(),
                prompt: Some("do not replay".into()),
                provider: None,
                codex: None,
                claude_context: None,
                env_refs: BTreeMap::new(),
            },
            argv: vec!["/bin/echo".into(), "--".into(), "do not replay".into()],
            env: BTreeMap::from([
                ("YAM_AGENT_ADDRESS".into(), "127.0.0.1:1".into()),
                ("YAM_PI_GENERATION".into(), prepared.generation.clone()),
            ]),
            root: root.clone(),
            cwd: root.clone(),
            terminal: "s-1-1".into(),
            prepared,
            run: None,
        };
        let a = command(&manifest, "new", &[], None, &root).unwrap();
        let args = a.get_argv();
        assert!(!args.iter().any(|s| s == "do not replay"));
        assert!(args.iter().any(|s| s == "--yam-small"));
        assert!(args.iter().any(|s| s == "--extension"));
        assert!(args.iter().any(|s| s == "--session"));
        let id = args.windows(2).find(|a| a[0] == "--session").unwrap()[1].clone();
        let b = command(&manifest, "new", &[], None, &root).unwrap();
        assert!(!b.get_argv().contains(&id));
        assert!(command(&manifest, "resume", &[], None, &root).is_err());
        let native = crate::gemini_resume::new_id().unwrap();
        std::fs::create_dir_all(root.join("pi-sessions")).unwrap();
        std::fs::write(
            crate::pi_router::session_file(&root, &native).unwrap(),
            format!(
                "{}\n",
                serde_json::json!({"type":"session","id":native,"cwd":root})
            ),
        )
        .unwrap();
        let resumed = command(&manifest, "resume", &[], Some(&native), &root).unwrap();
        assert!(resumed
            .get_argv()
            .iter()
            .any(|v| v.to_string_lossy().contains(&native)));
        assert!(command(&manifest, "resume", &[], Some("invalid"), &root).is_err());
        assert!(command(&manifest, "unknown", &[], None, &root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(unix)]
pub(super) fn start(
    app: &tauri::AppHandle,
    manager: &super::SessionManager,
    session: &str,
    adapter: &str,
    mode: &str,
    extra: Vec<String>,
    cwd: PathBuf,
) -> Result<serde_json::Value, String> {
    // The existing owner start guard serializes generation changes and native resume validation.
    let _guard = super::worktree_manager::start_guard()?;
    if !matches!(
        adapter,
        "pi" | "codex" | "claude" | "gemini" | "opencode" | "last"
    ) || !matches!(mode, "new" | "resume")
        || extra.len() > 250
        || extra.iter().any(|s| s.len() > 65536 || s.contains('\0'))
    {
        return Err("Invalid interactive Agent request".into());
    }
    let active = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager unavailable")?
        .get(session)
        .cloned()
        .ok_or("Terminal is no longer running")?;
    if active._interactive_assets.is_none()
        || !matches!(
            active
                .status
                .lock()
                .map_err(|_| "Terminal status unavailable")?
                .as_str(),
            "starting" | "running"
        )
    {
        return Err("This terminal does not support managed interactive Agents".into());
    }
    let history = active.history.clone();
    let record = history.get(session)?;
    let adapter = if adapter == "last" {
        record
            .summary
            .launch
            .as_ref()
            .map_or("pi", |l| l.adapter.as_str())
    } else {
        adapter
    };
    if record.agent.process_run.is_some() && record.agent.phase != "shell" {
        return Err("An Agent is already running or its exit is unconfirmed".into());
    }
    super::validate_working_directory(cwd.to_str().ok_or("Invalid Agent directory")?)?;
    super::worktree_manager::prepare_start(&history.root, &cwd, None)?;
    let launch = configured_launch(
        active
            ._interactive_assets
            .as_ref()
            .unwrap()
            .launch_template
            .as_ref(),
        adapter,
        &extra,
    )?;
    let native = if mode == "resume" {
        if record
            .summary
            .launch
            .as_ref()
            .is_none_or(|l| l.adapter != adapter)
        {
            return Err("No matching native conversation is available".into());
        }
        if cwd.canonicalize().map_err(|e| e.to_string())?
            != Path::new(&record.summary.cwd)
                .canonicalize()
                .map_err(|e| e.to_string())?
        {
            return Err("Return to the previous Agent directory before resuming".into());
        }
        Some(
            record
                .agent
                .agent_session_id
                .as_deref()
                .filter(|id| super::valid_resume_id(id))
                .ok_or("No trusted native conversation is available")?,
        )
    } else {
        None
    };
    super::provider_launch::validate_project(&launch, &cwd)?;
    let executable = super::find_executable(adapter).ok_or("Agent executable is unavailable")?;
    let env =
        super::project_config::resolve_env_refs(&launch.env_refs, &|key| std::env::var(key).ok())?;
    let environment = super::provider_launch::prepare(&history.root, &launch, &|key| {
        env.get(key).cloned().or_else(|| std::env::var(key).ok())
    })?
    .with_project_env(&env);
    if let Some(id) = native {
        if record
            .agent
            .cli_path
            .as_deref()
            .is_some_and(|p| Path::new(p) != executable)
        {
            return Err("The native executable changed; resume was not started".into());
        }
        if matches!(adapter, "claude" | "gemini") {
            use tauri::Manager;
            let config = environment.config_root(
                adapter,
                &cwd,
                &app.path().home_dir().map_err(|e| e.to_string())?,
            );
            if adapter == "claude" {
                super::claude_resume::validate(&config, &cwd, id)?;
            } else {
                super::gemini_resume::validate(&config, &cwd, id)?;
            }
        } else if adapter == "codex" {
            super::agent_bridge::validate_resume(
                &executable,
                &cwd,
                id,
                &launch,
                Some(&environment),
            )?;
        }
    }
    let prepared = match super::agent_bridge::prepare(
        &executable,
        &launch,
        &cwd,
        &history.root,
        Some(&environment),
    ) {
        Ok(p) => p,
        Err(e) if adapter == "pi" => return Err(e),
        Err(_) => super::agent_bridge::Prepared::lifecycle()?,
    };
    let mut base = CommandBuilder::new(&executable);
    base.cwd(&cwd);
    for (k, v) in env {
        base.env(k, v);
    }
    environment.apply_pty(&mut base);
    base.env(
        "YAM_PI_CONTROL_FILE",
        super::pi_router::control_file(&history.root, session)?,
    );
    base.env("YAM_PI_GENERATION", &prepared.generation);
    super::background::private_root(&history.root.join("pi-sessions"))?;
    let mut manifest = Manifest {
        launch,
        argv: vec![executable
            .to_str()
            .ok_or("Invalid Agent executable")?
            .into()],
        env: base
            .iter_extra_env_as_str()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
        root: history.root.clone(),
        cwd: cwd.clone(),
        terminal: session.into(),
        prepared,
        run: Some(super::agent_bridge::credential()?),
    };
    let mut builder = command(&manifest, mode, &[], native, &cwd)?;
    environment.validate_before_spawn()?;
    // No fallible native probe is allowed after registering this run.
    manager.connect_agent(
        app,
        history.clone(),
        session,
        &manifest.prepared,
        &mut builder,
    )?;
    {
        let mut records = history.lock_records()?;
        let mut next = records.clone();
        let record = next
            .iter_mut()
            .find(|r| r.summary.session_id == session)
            .ok_or("Terminal history unavailable")?;
        record.summary.cwd = cwd.to_string_lossy().into_owned();
        record.summary.launch = Some(manifest.launch.clone());
        history.save_locked(&next)?;
        *records = next;
    }
    manifest.argv = builder
        .get_argv()
        .iter()
        .map(|s| {
            s.to_str()
                .map(str::to_string)
                .ok_or("Invalid Agent argument")
        })
        .collect::<Result<_, _>>()?;
    manifest.env = builder
        .iter_extra_env_as_str()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    let known = builder
        .get_argv()
        .windows(2)
        .find_map(|a| {
            if a[0] == "--session" {
                Path::new(&a[1]).file_stem()?.to_str().map(str::to_string)
            } else if a[0] == "--session-id" {
                a[1].to_str().map(str::to_string)
            } else {
                None
            }
        })
        .or_else(|| native.map(str::to_string));
    history.ingest_agent_run(
        session,
        &manifest.prepared.generation,
        &super::agent_events::AgentEvent {
            kind: "ProcessStart".into(),
            agent_session_id: known.unwrap_or_else(|| manifest.prepared.generation.clone()),
            turn_id: manifest.run.clone(),
            permission_key: None,
            source: None,
        },
        manifest.run.as_deref(),
    )?;
    use tauri::Emitter;
    let _ = app.emit(
        "agent-state",
        super::SessionMessage {
            session_id: session.into(),
            data: "updated".into(),
        },
    );
    serde_json::to_value(manifest).map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod wire_tests {
    use super::*;
    use crate::agent_events::AgentEvent;
    use std::sync::Arc;
    fn event(kind: &str, run: &str) -> AgentEvent {
        AgentEvent {
            kind: kind.into(),
            agent_session_id: "generation".into(),
            turn_id: Some(run.into()),
            permission_key: None,
            source: None,
        }
    }
    #[test]
    fn interactive_shell_real_bridge_rejects_duplicate_and_late_events_without_corrupting_active_run(
    ) {
        let root =
            std::env::temp_dir().join(format!("yam-shell-wire-{}", crate::next_session_id()));
        let history = Arc::new(crate::HistoryStore::open(root.clone()).unwrap());
        history
            .start(&crate::SessionSummary {
                session_id: "s-1-1".into(),
                cwd: root.to_string_lossy().into_owned(),
                command: None,
                status: "running".into(),
                launch: None,
                ssh: None,
            })
            .unwrap();
        history.configure_agent("s-1-1", "generation").unwrap();
        let bridge = crate::agent_bridge::Bridge::start(history.clone(), |_, _| {}).unwrap();
        let token = crate::agent_bridge::credential().unwrap();
        bridge.register("s-1-1", &token, "generation").unwrap();
        crate::agent_bridge::submit_run(
            bridge.address,
            &token,
            event("ProcessStart", "one"),
            Some("one".into()),
        )
        .unwrap();
        let before = history.get("s-1-1").unwrap().agent;
        assert!(crate::agent_bridge::submit_run(
            bridge.address,
            &token,
            event("ProcessStart", "two"),
            Some("two".into())
        )
        .is_err());
        assert_eq!(history.get("s-1-1").unwrap().agent, before);
        crate::agent_bridge::submit_run(
            bridge.address,
            &token,
            event("SessionStart", "old"),
            Some("old".into()),
        )
        .unwrap();
        assert_eq!(history.get("s-1-1").unwrap().agent, before);
        crate::agent_bridge::submit_run(
            bridge.address,
            &token,
            event("ProcessExit", "one"),
            Some("one".into()),
        )
        .unwrap();
        let record = history.get("s-1-1").unwrap();
        assert_eq!(record.status, "running");
        assert_eq!(record.agent.phase, "shell");
        assert!(record.ended_at.is_none());
        crate::agent_bridge::submit_run(
            bridge.address,
            &token,
            event("UserPromptSubmit", "one"),
            Some("one".into()),
        )
        .unwrap();
        assert_eq!(history.get("s-1-1").unwrap().agent.phase, "shell");
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "isolated helper subprocess; called only by the wire integration test"]
    fn interactive_shell_helper_worker() {
        let path = std::env::var_os("YAM_SHELL_TEST_MANIFEST").expect("owned helper fixture only");
        let manifest = read_manifest(Path::new(&path)).unwrap().initial.unwrap();
        let expected = std::env::var("YAM_SHELL_TEST_EXIT")
            .map(|value| value.parse::<i32>().unwrap())
            .unwrap_or(17);
        let result = run(manifest, "initial", &[]);
        if std::env::var_os("YAM_SHELL_TEST_RECOVERY").is_some() {
            assert!(result.unwrap_err().contains("yam-agent recover"));
        } else {
            assert_eq!(result.unwrap(), expected);
        }
    }
    #[test]
    fn interactive_shell_exit_delivery_failure_is_recoverable_without_replaying_cli() {
        use std::os::unix::{fs::PermissionsExt, process::CommandExt};
        let root =
            std::env::temp_dir().join(format!("yam-recovery-wire-{}", crate::next_session_id()));
        let history = Arc::new(crate::HistoryStore::open(root.clone()).unwrap());
        let session = "s-1-1";
        history
            .start(&crate::SessionSummary {
                session_id: session.into(),
                cwd: root.to_string_lossy().into_owned(),
                command: None,
                status: "running".into(),
                launch: None,
                ssh: None,
            })
            .unwrap();
        let prepared = crate::agent_bridge::Prepared::lifecycle().unwrap();
        history
            .configure_agent(session, &prepared.generation)
            .unwrap();
        let bridge = crate::agent_bridge::Bridge::start(history.clone(), |_, _| {}).unwrap();
        bridge
            .register(session, &prepared.token, &prepared.generation)
            .unwrap();
        let dir = root.join("private");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let release = root.join("release");
        let ran = root.join("ran");
        let manifest = Manifest {
            launch: crate::AgentLaunch {
                adapter: "pi".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: None,
                provider: None,
                codex: None,
                claude_context: None,
                env_refs: BTreeMap::new(),
            },
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "printf x >> {}; while [ ! -f {} ]; do sleep 0.02; done; exit 17",
                    quote(ran.to_str().unwrap()),
                    quote(release.to_str().unwrap())
                ),
            ],
            env: BTreeMap::from([("YAM_AGENT_ADDRESS".into(), bridge.address.to_string())]),
            root: root.clone(),
            cwd: root.clone(),
            terminal: session.into(),
            prepared,
            run: None,
        };
        let path = dir.join("launch.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&LaunchFile {
                terminal: session.into(),
                initial: Some(manifest),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut helper = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "interactive_shell::wire_tests::interactive_shell_helper_worker",
                "--nocapture",
            ])
            .env("YAM_SHELL_TEST_MANIFEST", path)
            .env("YAM_SHELL_TEST_RECOVERY", "1")
            .current_dir(&root)
            .process_group(0)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !ran.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ran.exists());
        bridge.stop();
        std::fs::write(release, "").unwrap();
        while helper.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if helper.try_wait().unwrap().is_none() {
            helper.kill().unwrap();
        }
        assert!(helper.wait().unwrap().success());
        assert_ne!(history.get(session).unwrap().agent.phase, "shell");
        recover(&history, session).unwrap();
        assert_eq!(history.get(session).unwrap().agent.phase, "shell");
        assert_eq!(
            std::fs::read_to_string(ran).unwrap(),
            "x",
            "Recovery must not run the CLI a second time"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interactive_shell_real_helper_reports_cli_failure_but_keeps_terminal_running() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("yam-shell-helper-{}", crate::next_session_id()));
        let history = Arc::new(crate::HistoryStore::open(root.clone()).unwrap());
        history
            .start(&crate::SessionSummary {
                session_id: "s-1-1".into(),
                cwd: root.to_string_lossy().into_owned(),
                command: None,
                status: "running".into(),
                launch: None,
                ssh: None,
            })
            .unwrap();
        let prepared = crate::agent_bridge::Prepared::lifecycle().unwrap();
        history
            .configure_agent("s-1-1", &prepared.generation)
            .unwrap();
        let bridge = crate::agent_bridge::Bridge::start(history.clone(), |_, _| {}).unwrap();
        bridge
            .register("s-1-1", &prepared.token, &prepared.generation)
            .unwrap();
        let dir = root.join("private");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("launch.json");
        let manifest = Manifest {
            launch: crate::AgentLaunch {
                adapter: "pi".into(),
                mode: "interactive".into(),
                extra_args: String::new(),
                prompt: None,
                provider: None,
                codex: None,
                claude_context: None,
                env_refs: BTreeMap::new(),
            },
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                "test \"$ONLY_AGENT_VALUE\" = scoped || exit 91; sleep 30 </dev/null >/dev/null 2>&1 & echo $! > \"$CHILD_PID_FILE\"; if test -n \"$YAM_SHELL_TEST_SIGNAL\"; then kill -\"$YAM_SHELL_TEST_SIGNAL\" $$; fi; exit \"$YAM_SHELL_TEST_EXIT\"".into(),
            ],
            env: BTreeMap::from([
                ("YAM_AGENT_ADDRESS".into(), bridge.address.to_string()),
                ("ONLY_AGENT_VALUE".into(), "scoped".into()),
                ("CHILD_PID_FILE".into(),root.join("child.pid").to_string_lossy().into_owned()),
            ]),
            root: root.clone(),
            cwd: root.clone(),
            terminal: "s-1-1".into(),
            prepared,
            run: None,
        };
        std::fs::write(
            &path,
            serde_json::to_vec(&LaunchFile {
                terminal: "s-1-1".into(),
                initial: Some(manifest),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let helper = root.join("real-helper");
        std::fs::write(&helper,format!("#!/bin/sh\nexec {} --ignored --exact interactive_shell::wire_tests::interactive_shell_helper_worker --nocapture\n",quote(std::env::current_exe().unwrap().to_str().unwrap()))).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(root.join(".zshrc"), "PROMPT='REAL_READY>'\n").unwrap();
        std::fs::write(root.join(".bashrc"), "PS1='REAL_READY>'\n").unwrap();
        std::fs::write(root.join(".bash_profile"), "source ~/.bashrc\n").unwrap();
        for (program, signal, expected) in [
            ("/bin/zsh", "", 0),
            ("/bin/bash", "", 0),
            ("/bin/zsh", "", 17),
            ("/bin/bash", "", 17),
            ("/bin/zsh", "INT", 130),
            ("/bin/bash", "INT", 130),
            ("/bin/zsh", "TERM", 143),
            ("/bin/bash", "TERM", 143),
        ] {
            let assets_root = root.join(format!(
                "{}-{signal}-{expected}-assets",
                Path::new(program).file_name().unwrap().to_str().unwrap()
            ));
            std::fs::create_dir(&assets_root).unwrap();
            let (mut builder, _assets) = shell(
                &assets_root,
                Path::new(program),
                &helper,
                &path,
                "pi",
                true,
                None,
                (false, false),
            )
            .unwrap();
            builder.env("HOME", &root);
            builder.env("YAM_ZSH_ENV_PRESENT", "0");
            builder.env("YAM_SHELL_TEST_MANIFEST", &path);
            builder.env("YAM_SHELL_TEST_SIGNAL", signal);
            builder.env("YAM_SHELL_TEST_EXIT", expected.to_string());
            builder.cwd(&root);
            let pair = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows: 24,
                    cols: 100,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut child = pair.slave.spawn_command(builder).unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            drop(pair.slave);
            use std::io::{Read, Write};
            let (tx, rx) = std::sync::mpsc::channel();
            let reading = std::thread::spawn(move || {
                let mut b = [0; 4096];
                while let Ok(n) = reader.read(&mut b) {
                    if n == 0 || tx.send(b[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let mut output = String::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !output.contains("REAL_READY>") && std::time::Instant::now() < deadline {
                if let Ok(b) = rx.recv_timeout(std::time::Duration::from_millis(20)) {
                    output.push_str(&String::from_utf8_lossy(&b));
                }
            }
            let _ = writer.write_all(b"printf 'AFTER_REAL_HELPER\\n'; exit\n");
            while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
                if let Ok(b) = rx.recv_timeout(std::time::Duration::from_millis(20)) {
                    output.push_str(&String::from_utf8_lossy(&b));
                }
            }
            if child.try_wait().unwrap().is_none() {
                child.kill().unwrap();
            }
            child.wait().unwrap();
            drop(writer);
            drop(pair.master);
            reading.join().unwrap();
            while let Ok(b) = rx.try_recv() {
                output.push_str(&String::from_utf8_lossy(&b));
            }
            assert!(
                output.contains(&format!("Agent exited ({expected}). Shell ready")),
                "real initial helper failed for {program}: {output}"
            );
            assert!(output.contains("AFTER_REAL_HELPER"));
        }
        let record = history.get("s-1-1").unwrap();
        assert_eq!(record.status, "running");
        assert_eq!(record.agent.phase, "shell");
        assert!(record.ended_at.is_none());
        let pid: i32 = std::fs::read_to_string(root.join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let status = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let alive = status.status.success()
            && !String::from_utf8_lossy(&status.stdout)
                .trim_start()
                .starts_with('Z');
        if alive {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert!(!alive, "CLI child survived a reported ProcessExit");
        assert!(std::env::var_os("ONLY_AGENT_VALUE").is_none());
        bridge.stop();
        std::fs::remove_dir_all(root).unwrap();
    }
}
