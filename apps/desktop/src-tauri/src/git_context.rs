// Author: Jeff.Liu. Git context is read-only and bounded across the entire query.
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GitContext {
    kind: String,
    branch: Option<String>,
    dirty: Option<bool>,
    root: Option<String>,
    common_dir: Option<String>,
}
#[cfg(test)]
thread_local! {
    static FAIL_POST_SPAWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static POST_SPAWN_PID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}
pub(crate) struct Budget {
    pub(crate) deadline: Instant,
    pub(crate) remaining: usize,
}
impl Budget {
    #[cfg(test)]
    fn run(&mut self, program: &Path, args: &[&str], cwd: &Path) -> Result<Output, String> {
        self.run_env(program, args, cwd, &[])
    }
    pub(crate) fn run_env(
        &mut self,
        program: &Path,
        args: &[&str],
        cwd: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output, String> {
        self.run_env_cancel(program, args, cwd, env, None)
    }
    fn run_env_cancel(
        &mut self,
        program: &Path,
        args: &[&str],
        cwd: &Path,
        env: &[(OsString, OsString)],
        cancel: Option<&AtomicBool>,
    ) -> Result<Output, String> {
        check_cancel(cancel)?;
        if Instant::now() >= self.deadline {
            return Err("git_timeout".into());
        }
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_PAGER", "cat");
        command.envs(env.iter().cloned());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git_missing"
            } else {
                "git_query_failed"
            }
        })?;
        let result = (|| {
            #[cfg(test)]
            if FAIL_POST_SPAWN.with(|fault| fault.get()) {
                POST_SPAWN_PID.with(|pid| pid.set(child.id()));
                return Err("git_query_failed".into());
            }
            #[cfg(windows)]
            let _job = {
                use std::os::windows::io::AsRawHandle;
                crate::WindowsJob::attach(child.as_raw_handle()).map_err(|_| "git_query_failed")?
            };
            let mut stdout = child.stdout.take().ok_or("git_query_failed")?;
            let mut stderr = child.stderr.take().ok_or("git_query_failed")?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
                    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                    if flags < 0
                        || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
                    {
                        return Err("git_query_failed".into());
                    }
                }
                let mut out = Vec::new();
                let mut err = Vec::new();
                let mut eof = [false, false];
                let mut status = None;
                loop {
                    check_cancel(cancel)?;
                    if Instant::now() >= self.deadline {
                        return Err("git_timeout".into());
                    }
                    for (index, stream, target) in [
                        (0, &mut stdout as &mut dyn Read, &mut out),
                        (1, &mut stderr as &mut dyn Read, &mut err),
                    ] {
                        if eof[index] {
                            continue;
                        }
                        let mut bytes = [0; 4096];
                        loop {
                            check_cancel(cancel)?;
                            if Instant::now() >= self.deadline {
                                return Err("git_timeout".into());
                            }
                            match stream.read(&mut bytes) {
                                Ok(0) => {
                                    eof[index] = true;
                                    break;
                                }
                                Ok(size) => {
                                    if size > self.remaining {
                                        return Err("git_output_limit".into());
                                    }
                                    self.remaining -= size;
                                    target.extend_from_slice(&bytes[..size]);
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                                Err(_) => return Err("git_query_failed".into()),
                            }
                        }
                    }
                    if status.is_none() {
                        status = child.try_wait().map_err(|_| "git_query_failed")?;
                    }
                    if eof.iter().all(|done| *done) {
                        if let Some(status) = status {
                            return Ok(Output {
                                status,
                                stdout: out,
                                stderr: err,
                            });
                        }
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            #[cfg(not(unix))]
            {
                let (send, receive) = std::sync::mpsc::sync_channel(2);
                for (index, mut stream) in [
                    (0, Box::new(stdout) as Box<dyn Read + Send>),
                    (1, Box::new(stderr) as Box<dyn Read + Send>),
                ] {
                    let send = send.clone();
                    std::thread::spawn(move || loop {
                        let mut bytes = vec![0; 4096];
                        match stream.read(&mut bytes) {
                            Ok(size) => {
                                bytes.truncate(size);
                                if send.send((index, Ok(bytes))).is_err() || size == 0 {
                                    break;
                                }
                            }
                            Err(e) => {
                                let _ = send.send((index, Err(e)));
                                break;
                            }
                        }
                    });
                }
                drop(send);
                let mut out = Vec::new();
                let mut err = Vec::new();
                let mut eof = [false, false];
                while !eof.iter().all(|done| *done) {
                    check_cancel(cancel)?;
                    if Instant::now() >= self.deadline {
                        return Err("git_timeout".into());
                    }
                    let wait = self
                        .deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(10));
                    let (index, data) = match receive.recv_timeout(wait) {
                        Ok(data) => data,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => return Err("git_query_failed".into()),
                    };
                    let data = data.map_err(|_| "git_query_failed")?;
                    if data.is_empty() {
                        eof[index] = true;
                        continue;
                    }
                    if data.len() > self.remaining {
                        return Err("git_output_limit".into());
                    }
                    self.remaining -= data.len();
                    if index == 0 {
                        out.extend(data);
                    } else {
                        err.extend(data);
                    }
                }
                loop {
                    if let Some(status) = child.try_wait().map_err(|_| "git_query_failed")? {
                        return Ok(Output {
                            status,
                            stdout: out,
                            stderr: err,
                        });
                    }
                    check_cancel(cancel)?;
                    if Instant::now() >= self.deadline {
                        return Err("git_timeout".into());
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        })();
        if result.is_err() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            if child.try_wait().ok().flatten().is_none() {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
        result
    }
}
#[cfg(test)]
fn run_bounded(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    deadline: Instant,
    limit: usize,
) -> Result<Output, String> {
    Budget {
        deadline,
        remaining: limit,
    }
    .run(program, args, cwd)
}

const MAX_QUERY_BYTES: usize = 1024 * 1024;
const FIXED_ARGS: &[&str] = &[
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
];
static QUERY_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static NEXT_SHADOW: AtomicU64 = AtomicU64::new(0);
pub(crate) struct Shadow(pub(crate) PathBuf);
impl Shadow {
    pub(crate) fn new() -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!(
            "yam-git-context-{}-{}",
            std::process::id(),
            NEXT_SHADOW.fetch_add(1, Ordering::Relaxed)
        ));
        let mut directory = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(&root).map_err(|_| "git_query_failed")?;
        let shadow = Self(root);
        crate::background::private_root(&shadow.0).map_err(|_| "git_query_failed")?;
        for path in ["objects", "refs", "info"] {
            fs::create_dir(shadow.0.join(path)).map_err(|_| "git_query_failed")?;
        }
        Ok(shadow)
    }
    pub(crate) fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let target = self.0.join(path);
        let mut file = options.open(&target).map_err(|_| "git_query_failed")?;
        #[cfg(windows)]
        crate::background::protect_windows_path(&target).map_err(|_| "git_query_failed")?;
        file.write_all(bytes).map_err(|_| "git_query_failed".into())
    }
}
impl Drop for Shadow {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(crate) fn read_regular(path: &Path, budget: &mut Budget) -> Result<Option<Vec<u8>>, String> {
    if Instant::now() >= budget.deadline {
        return Err("git_timeout".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("git_query_failed".into()),
    };
    if !file.metadata().map_err(|_| "git_query_failed")?.is_file() {
        return Err("git_query_failed".into());
    }
    let mut bytes = Vec::new();
    file.take((budget.remaining + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "git_query_failed")?;
    if bytes.len() > budget.remaining {
        return Err("git_output_limit".into());
    }
    budget.remaining -= bytes.len();
    if Instant::now() >= budget.deadline {
        return Err("git_timeout".into());
    }
    Ok(Some(bytes))
}
pub(crate) fn config_environment() -> Result<Vec<(OsString, OsString)>, String> {
    let mut result = Vec::new();
    for (key, value) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        ]
        .contains(&upper.as_str())
        {
            return Err("git_environment".into());
        }
        if upper.starts_with("GIT_CONFIG_") {
            result.push((key, value));
        }
    }
    #[cfg(test)]
    {
        result.clear();
        result.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
        result.push(("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()));
    }
    Ok(result)
}
pub(crate) fn git_command(
    git: &Path,
    path: &Path,
    env: &[(OsString, OsString)],
    budget: &mut Budget,
    args: &[&str],
) -> Result<Output, String> {
    let mut argv = FIXED_ARGS.to_vec();
    argv.extend_from_slice(args);
    budget.run_env(git, &argv, path, env)
}
fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        Err("git_cancelled".into())
    } else {
        Ok(())
    }
}
fn git_command_cancel(
    cancel: Option<&AtomicBool>,
    git: &Path,
    path: &Path,
    env: &[(OsString, OsString)],
    budget: &mut Budget,
    args: &[&str],
) -> Result<Output, String> {
    let mut argv = FIXED_ARGS.to_vec();
    argv.extend_from_slice(args);
    budget.run_env_cancel(git, &argv, path, env, cancel)
}
fn checked_text(output: Output) -> Result<String, String> {
    if !output.status.success() {
        return Err("git_query_failed".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "git_query_failed".into())
}
pub(crate) fn safe_config(bytes: &[u8]) -> Result<String, String> {
    let mut safe=String::from("[core]\n bare = false\n fsmonitor = false\n hooksPath = /dev/null\n attributesFile = /dev/null\n[status]\n submoduleSummary = false\n");
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let entry = std::str::from_utf8(entry).map_err(|_| "git_query_failed")?;
        let (key, value) = entry.split_once('\n').ok_or("git_query_failed")?;
        let key = key.to_ascii_lowercase();
        if key.starts_with("filter.")
            && (key.ends_with(".clean") || key.ends_with(".process"))
            && !value.trim().is_empty()
        {
            return Err("git_external_filter".into());
        }
        if key == "core.excludesfile" && !value.is_empty() {
            return Err("git_conversion_unsupported".into());
        }
        if key == "core.attributesfile" && !value.trim().is_empty() {
            return Err("git_conversion_unsupported".into());
        }
        if (key == "extensions.partialclone" && !value.is_empty())
            || (key.starts_with("remote.")
                && key.ends_with(".promisor")
                && !["false", "no", "off", "0"].contains(&value))
        {
            return Err("git_conversion_unsupported".into());
        }
        if key == "extensions.objectformat" && value != "sha1" {
            return Err("git_conversion_unsupported".into());
        }
        let valid = match key.as_str() {
            "core.excludesfile" => value.is_empty(),
            "core.autocrlf" => ["true", "false", "input"].contains(&value),
            "core.eol" => ["lf", "crlf", "native"].contains(&value),
            "core.filemode" | "core.symlinks" | "core.ignorecase" => {
                ["true", "false"].contains(&value)
            }
            _ => continue,
        };
        if !valid {
            return Err("git_conversion_unsupported".into());
        }
        safe.push_str(&format!(
            "[core]\n {} = {}\n",
            key.strip_prefix("core.").unwrap_or(""),
            value
        ));
    }
    Ok(safe)
}
fn query_impl(
    path: &Path,
    git: &Path,
    env: Vec<(OsString, OsString)>,
    changed: impl FnOnce(),
) -> Result<GitContext, String> {
    query_snapshot(path, git, env, changed, false).map(|(context, _)| context)
}
fn query_snapshot(
    path: &Path,
    git: &Path,
    env: Vec<(OsString, OsString)>,
    changed: impl FnOnce(),
    cleanup: bool,
) -> Result<(GitContext, Option<CleanupSnapshot>), String> {
    let (context, snapshot, _) =
        query_snapshot_changes(path, git, env, changed, cleanup, None, None)?;
    Ok((context, snapshot))
}
fn query_snapshot_changes(
    path: &Path,
    git: &Path,
    env: Vec<(OsString, OsString)>,
    changed: impl FnOnce(),
    cleanup: bool,
    changes: Option<(&str, Option<(&str, &str)>)>,
    cancel: Option<&AtomicBool>,
) -> Result<(GitContext, Option<CleanupSnapshot>, Option<GitChanges>), String> {
    check_cancel(cancel)?;
    let _query = QUERY_GATE.try_lock().map_err(|_| "git_busy")?;
    let mut budget = Budget {
        deadline: Instant::now() + Duration::from_secs(2),
        remaining: MAX_QUERY_BYTES,
    };
    if !path.is_absolute()
        || path.to_string_lossy().len() > 4096
        || path.to_string_lossy().chars().any(char::is_control)
    {
        return Err("git_invalid_path".into());
    }
    let path = fs::canonicalize(path).map_err(|_| "git_invalid_path")?;
    if !path.is_dir() {
        return Err("git_invalid_path".into());
    }
    let config = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["config", "--null", "--list"],
    )?;
    if !config.status.success() {
        return Err("git_query_failed".into());
    }
    let safe = safe_config(&config.stdout)?;
    if cleanup
        && config.stdout.split(|b| *b == 0).any(|entry| {
            let Some(split) = entry.iter().position(|b| *b == b'\n') else {
                return false;
            };
            let key = String::from_utf8_lossy(&entry[..split]).to_ascii_lowercase();
            key.starts_with("filter.") && key.ends_with(".smudge") && !entry[split + 1..].is_empty()
        })
    {
        return Err("git_conversion_unsupported".into());
    }

    let discover = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["rev-parse", "--is-inside-work-tree"],
    )?;
    if !discover.status.success() {
        return Ok((
            GitContext {
                kind: "not_repository".into(),
                branch: None,
                dirty: None,
                root: None,
                common_dir: None,
            },
            None,
            changes.map(|(token, _)| GitChanges {
                query_token: token.into(),
                path: path.to_string_lossy().into_owned(),
                root: None,
                rows: Vec::new(),
                patch: None,
            }),
        ));
    }
    if discover.stdout != b"true\n" {
        return Err("git_query_failed".into());
    }
    let metadata_args = [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--absolute-git-dir",
        "--git-path",
        "index",
        "--git-path",
        "objects",
        "--git-path",
        "info/attributes",
    ];
    let metadata = checked_text(git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &metadata_args,
    )?)?;
    let parts: Vec<_> = metadata.lines().collect();
    if parts.len() != 6
        || parts
            .iter()
            .any(|p| !Path::new(p).is_absolute() || p.chars().any(char::is_control))
    {
        return Err("git_query_failed".into());
    }
    let root = PathBuf::from(parts[0]);
    let index = PathBuf::from(parts[3]);
    // Defaults outside the repository are deliberately unsupported rather than silently dropped.
    let home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    if home.is_some_and(|home| home.join("git/attributes").exists())
        || Path::new("/etc/gitattributes").exists()
    {
        return Err("git_conversion_unsupported".into());
    }
    let branch_out = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )?;
    let branch = if branch_out.status.success() {
        Some(
            String::from_utf8(branch_out.stdout)
                .map_err(|_| "git_query_failed")?
                .trim_end()
                .to_owned(),
        )
    } else {
        None
    };
    let head = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["rev-parse", "--verify", "HEAD"],
    )?;
    let oid = if head.status.success() {
        Some(
            String::from_utf8(head.stdout)
                .map_err(|_| "git_query_failed")?
                .trim_end()
                .to_owned(),
        )
    } else if branch.is_some() {
        None
    } else {
        return Err("git_query_failed".into());
    };
    if oid
        .as_ref()
        .is_some_and(|oid| oid.len() != 40 || !oid.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("git_conversion_unsupported".into());
    }
    let tracked = git_command_cancel(
        cancel,
        git,
        &root,
        &env,
        &mut budget,
        &["ls-files", "--cached", "--stage", "-z"],
    )?;
    if !tracked.status.success() {
        return Err("git_query_failed".into());
    }
    let has_submodule = tracked
        .stdout
        .split(|byte| *byte == 0)
        .any(|entry| entry.starts_with(b"160000 "));
    if cleanup && has_submodule {
        return Err("git_submodule_unavailable".into());
    }
    if cleanup {
        let tree = git_command_cancel(
            cancel,
            git,
            &path,
            &env,
            &mut budget,
            &["ls-tree", "-r", "-z", "HEAD"],
        )?;
        if !tree.status.success()
            || tree
                .stdout
                .split(|b| *b == 0)
                .any(|entry| entry.starts_with(b"160000 "))
        {
            return Err("git_submodule_unavailable".into());
        }
    }
    let before_inventory = if cleanup {
        Some(cleanup_inventory(&root, &mut budget)?)
    } else {
        None
    };
    let mut tracked_paths = Vec::new();
    let mut attributes =
        std::collections::BTreeSet::from([root.join(".gitattributes"), PathBuf::from(parts[5])]);
    for name in tracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = std::str::from_utf8(name).map_err(|_| "git_conversion_unsupported")?;
        let (_, name) = name.split_once('\t').ok_or("git_query_failed")?;
        tracked_paths.push(name);
        if tracked_paths.len() > 4096 {
            return Err("git_output_limit".into());
        }
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("git_query_failed".into());
        }
        let mut parent = relative.parent();
        while let Some(dir) = parent {
            attributes.insert(root.join(dir).join(".gitattributes"));
            parent = dir.parent();
        }
    }
    if attributes.len() > 4096 {
        return Err("git_output_limit".into());
    }
    let mut original_attributes = Vec::new();
    for file in attributes {
        original_attributes.push((file.clone(), read_regular(&file, &mut budget)?));
    }
    let original_index = read_regular(&index, &mut budget)?;
    // Git stores info/exclude in the common directory, including linked worktrees.
    // Build the final component without rev-parse canonicalization so NOFOLLOW sees links.
    let exclude = PathBuf::from(parts[1]).join("info/exclude");
    let original_exclude = read_regular(&exclude, &mut budget)?;
    let shadow = Shadow::new()?;
    shadow.write("config", safe.as_bytes())?;
    shadow.write(
        "HEAD",
        format!(
            "{}\n",
            oid.as_deref().unwrap_or("ref: refs/heads/yam-unborn")
        )
        .as_bytes(),
    )?;
    if let Some(bytes) = &original_index {
        shadow.write("index", bytes)?;
    }
    if let Some((_, Some(bytes))) = original_attributes
        .iter()
        .find(|(file, _)| file == Path::new(parts[5]))
    {
        shadow.write("info/attributes", bytes)?;
    }
    if let Some(bytes) = &original_exclude {
        shadow.write("info/exclude", bytes)?;
    }
    // The fixed private config is the execution barrier. Rechecking originals only validates the result's snapshot.
    let safe_env = vec![
        (OsString::from("GIT_CONFIG_NOSYSTEM"), OsString::from("1")),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_ATTR_NOSYSTEM".into(), "1".into()),
        ("GIT_DIR".into(), shadow.0.as_os_str().to_owned()),
        ("GIT_WORK_TREE".into(), root.as_os_str().to_owned()),
        ("GIT_OBJECT_DIRECTORY".into(), OsString::from(parts[4])),
    ];
    if cleanup {
        // Check the exact private index used by status; never clear flags in the original.
        let flags = git_command_cancel(
            cancel,
            git,
            &root,
            &safe_env,
            &mut budget,
            &["ls-files", "-v", "-z"],
        )?;
        if !flags.status.success() {
            return Err("git_query_failed".into());
        }
        if !flags.stdout.is_empty() && !flags.stdout.ends_with(&[0]) {
            return Err("git_conversion_unsupported".into());
        }
        for entry in flags
            .stdout
            .split(|b| *b == 0)
            .filter(|entry| !entry.is_empty())
        {
            if entry.len() < 3 || entry[1] != b' ' || !b"HSMRCK?".contains(&entry[0]) {
                return Err("git_conversion_unsupported".into());
            }
            if entry[0] == b'S' {
                return Err("git_conversion_unsupported".into());
            }
        }
    }
    let mut attribute_args = vec!["check-attr", "--all", "-z", "--"];
    attribute_args.extend(tracked_paths);
    // Metadata-only lookup: it does not perform clean/process conversion. Compare effective
    // rules instead of guessing the installed Git's compiled system-attribute prefix.
    let effective_attributes = if attribute_args.len() > 4 {
        let original = git_command_cancel(cancel, git, &root, &env, &mut budget, &attribute_args)?;
        let isolated =
            git_command_cancel(cancel, git, &root, &safe_env, &mut budget, &attribute_args)?;
        if !original.status.success() || !isolated.status.success() {
            return Err("git_query_failed".into());
        }
        if original.stdout != isolated.stdout {
            return Err("git_attributes_unsupported".into());
        }
        Some(original.stdout)
    } else {
        None
    };
    changed();
    let status = git_command_cancel(
        cancel,
        git,
        &root,
        &safe_env,
        &mut budget,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            if cleanup || changes.is_some() {
                "--untracked-files=all"
            } else {
                "--untracked-files=normal"
            },
            if cleanup {
                "--ignored=matching"
            } else {
                "--ignore-submodules=all"
            },
            "--ignore-submodules=all",
        ],
    )?;
    if !status.status.success() {
        return Err("git_query_failed".into());
    }
    let staged = git_command_cancel(
        cancel,
        git,
        &root,
        &safe_env,
        &mut budget,
        &[
            "diff",
            "--cached",
            "--raw",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
        ],
    )?;
    if !staged.status.success() {
        return Err("git_query_failed".into());
    }
    if changes.is_some()
        && (has_submodule
            || staged.stdout.split(|b| *b == 0).any(|entry| {
                entry.starts_with(b":160000 ") || entry.get(8..15) == Some(&b"160000 "[..])
            }))
    {
        return Err("git_submodule_unavailable".into());
    }
    let change_result = if let Some((token, selected)) = changes {
        let rows = parse_change_rows(&status.stdout)?;
        let patch = if let Some((selected_path, side)) = selected {
            let row = rows
                .iter()
                .find(|row| row.path == selected_path)
                .ok_or("git_context_changed")?;
            let kind = if row.untracked || row.unsupported {
                Some("unsupported")
            } else if (side == "staged" && row.staged == " ")
                || (side == "worktree" && row.worktree == " ")
            {
                return Err("git_context_changed".into());
            } else {
                None
            };
            if let Some(kind) = kind {
                Some(GitPatch {
                    path: selected_path.into(),
                    side: side.into(),
                    kind: kind.into(),
                    text: None,
                })
            } else {
                let mut args = vec![
                    "--literal-pathspecs",
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    "--ignore-submodules=all",
                    "--numstat",
                    "-z",
                ];
                if side == "staged" {
                    args.push("--cached");
                }
                args.extend(["--", selected_path]);
                let stat = git_command_cancel(cancel, git, &root, &safe_env, &mut budget, &args)?;
                if !stat.status.success() {
                    return Err("git_query_failed".into());
                }
                if stat.stdout.starts_with(b"-\t-\t") {
                    Some(GitPatch {
                        path: selected_path.into(),
                        side: side.into(),
                        kind: "binary".into(),
                        text: None,
                    })
                } else {
                    args.retain(|arg| *arg != "--numstat" && *arg != "-z");
                    args.insert(2, "--patch");
                    let patch =
                        git_command_cancel(cancel, git, &root, &safe_env, &mut budget, &args)?;
                    if !patch.status.success() {
                        return Err("git_query_failed".into());
                    }
                    if patch.stdout.len() > 262144 {
                        return Err("git_output_limit".into());
                    }
                    let text = String::from_utf8(patch.stdout)
                        .map_err(|_| "git_conversion_unsupported")?;
                    Some(GitPatch {
                        path: selected_path.into(),
                        side: side.into(),
                        kind: "text".into(),
                        text: Some(text),
                    })
                }
            }
        } else {
            None
        };
        Some(GitChanges {
            query_token: token.into(),
            path: path.to_string_lossy().into_owned(),
            root: Some(parts[0].into()),
            rows,
            patch,
        })
    } else {
        None
    };
    if let Some(original) = effective_attributes {
        let current = git_command_cancel(cancel, git, &root, &env, &mut budget, &attribute_args)?;
        if !current.status.success() || current.stdout != original {
            return Err("git_context_changed".into());
        }
    }
    let current_config = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["config", "--null", "--list"],
    )?;
    if !current_config.status.success() || current_config.stdout != config.stdout {
        return Err("git_context_changed".into());
    }
    if checked_text(git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &metadata_args,
    )?)? != metadata
    {
        return Err("git_context_changed".into());
    }
    if read_regular(&exclude, &mut budget)? != original_exclude {
        return Err("git_context_changed".into());
    }
    if read_regular(&index, &mut budget)? != original_index {
        return Err("git_context_changed".into());
    }
    for (file, bytes) in &original_attributes {
        if read_regular(file, &mut budget)? != *bytes {
            return Err("git_context_changed".into());
        }
    }
    let final_head = git_command_cancel(
        cancel,
        git,
        &path,
        &env,
        &mut budget,
        &["rev-parse", "--verify", "HEAD"],
    )?;
    let final_oid = if final_head.status.success() {
        Some(
            String::from_utf8(final_head.stdout)
                .map_err(|_| "git_query_failed")?
                .trim_end()
                .to_owned(),
        )
    } else {
        None
    };
    if final_oid != oid {
        return Err("git_context_changed".into());
    }
    if has_submodule && status.stdout.is_empty() && staged.stdout.is_empty() {
        return Err("git_submodule_unavailable".into());
    }
    let snapshot = if cleanup {
        let inventory = cleanup_inventory(&root, &mut budget)?;
        if before_inventory.as_ref() != Some(&inventory) {
            return Err("git_context_changed".into());
        }
        let mut attrs: Vec<_> = original_attributes
            .iter()
            .map(|(file, bytes)| {
                (
                    file.strip_prefix(&root)
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "info/attributes".into()),
                    bytes,
                )
            })
            .collect();
        // Absolute collection order changes when the worktree moves to quarantine.
        attrs.sort_by(|left, right| left.0.cmp(&right.0));
        let bytes = serde_json::to_vec(&(
            &config.stdout,
            &original_index,
            &original_exclude,
            attrs,
            &oid,
        ))
        .map_err(|_| "git_query_failed")?;
        if bytes.len() + inventory.len() > MAX_QUERY_BYTES {
            return Err("git_output_limit".into());
        }
        Some(CleanupSnapshot {
            head: oid.clone().ok_or("git_query_failed")?,
            admin: PathBuf::from(parts[2]),
            bytes,
            inventory,
        })
    } else {
        None
    };
    check_cancel(cancel)?;
    if change_result.as_ref().is_some_and(|result| {
        serde_json::to_vec(result).map_or(true, |bytes| bytes.len() > MAX_QUERY_BYTES)
    }) {
        return Err("git_output_limit".into());
    }
    Ok((
        GitContext {
            kind: if branch.is_some() {
                "repository"
            } else {
                "detached"
            }
            .into(),
            branch,
            dirty: Some(!status.stdout.is_empty() || !staged.stdout.is_empty()),
            root: Some(parts[0].into()),
            common_dir: Some(parts[1].into()),
        },
        snapshot,
        change_result,
    ))
}
pub(crate) fn fixed_git(git: &Path, resolver_cwd: &Path) -> Result<PathBuf, String> {
    let candidate = if git.is_absolute() {
        git.to_owned()
    } else {
        resolver_cwd.join(git)
    };
    let fixed = fs::canonicalize(candidate).map_err(|_| "git_missing")?;
    if !fixed.is_absolute() || !fixed.is_file() {
        return Err("git_missing".into());
    }
    Ok(fixed)
}
pub(crate) fn query(path: &Path) -> Result<GitContext, String> {
    let git = crate::find_executable("git").ok_or("git_missing")?;
    let resolver_cwd = std::env::current_dir().map_err(|_| "git_missing")?;
    query_resolved_git(path, &git, &resolver_cwd)
}
fn query_resolved_git(path: &Path, git: &Path, resolver_cwd: &Path) -> Result<GitContext, String> {
    let fixed = fixed_git(git, resolver_cwd)?;
    query_impl(path, &fixed, config_environment()?, || {})
}
#[cfg(test)]
fn query_with_git(path: &Path, git: &Path) -> Result<GitContext, String> {
    query_impl(path, git, config_environment()?, || {})
}
#[cfg(test)]
fn query_env(path: &Path, env: &[(&str, &str)]) -> Result<GitContext, String> {
    if env.iter().any(|(key, _)| {
        [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
        ]
        .contains(key)
    }) {
        return Err("git_environment".into());
    }
    let mut environment = config_environment()?;
    for (key, value) in env {
        environment.retain(|(k, _)| k != OsStr::new(key));
        environment.push((key.into(), value.into()));
    }
    query_impl(
        path,
        &crate::find_executable("git").ok_or("git_missing")?,
        environment,
        || {},
    )
}
#[cfg(test)]
fn query_changed(path: &Path, changed: impl FnOnce()) -> Result<GitContext, String> {
    query_impl(
        path,
        &crate::find_executable("git").ok_or("git_missing")?,
        config_environment()?,
        changed,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static TEST_QUERY_SEQUENCE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    pub(super) fn serial_query_test() -> std::sync::MutexGuard<'static, ()> {
        TEST_QUERY_SEQUENCE
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    struct Repo(std::path::PathBuf);
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "yam-t12-{}-{} 中 space",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("empty-hooks")).unwrap();
            let repo = Self(fs::canonicalize(path).unwrap());
            repo.git(&["init", "-b", "fixture"]);
            repo.git(&[
                "config",
                "core.hooksPath",
                repo.0.join("empty-hooks").to_str().unwrap(),
            ]);
            repo.git(&["config", "user.name", "T12 Fixture"]);
            repo.git(&["config", "user.email", "fixture@example.invalid"]);
            repo
        }
        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_COMMON_DIR")
                .env_remove("GIT_CONFIG_COUNT")
                .env_remove("GIT_CONFIG_PARAMETERS")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_OPTIONAL_LOCKS", "0")
                .output()
                .unwrap();
            assert!(out.status.success(), "fixture git failed");
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        }
        fn commit(&self) {
            fs::write(self.0.join("file.txt"), "fixture\n").unwrap();
            self.git(&["add", "file.txt"]);
            self.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[cfg(unix)]
    #[test]
    fn t12_post_spawn_setup_error_reaps_owned_child() {
        let _serial = serial_query_test();
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                FAIL_POST_SPAWN.with(|fault| fault.set(false));
            }
        }
        let _reset = Reset;
        FAIL_POST_SPAWN.with(|fault| fault.set(true));
        let start = Instant::now();
        let result = run_bounded(
            Path::new("/bin/sh"),
            &["-c", "exec sleep 30"],
            &std::env::temp_dir(),
            start + Duration::from_secs(2),
            1024,
        );
        assert_eq!(result.unwrap_err(), "git_query_failed");
        assert!(start.elapsed() < Duration::from_secs(1));
        let pid = POST_SPAWN_PID.with(|pid| pid.get()) as i32;
        assert!(pid > 0, "fault must hit a spawned child");
        let deadline = Instant::now() + Duration::from_millis(500);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let still_owned = unsafe { libc::kill(pid, 0) } == 0;
        if still_owned {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
        }
        assert!(
            !still_owned,
            "post-spawn setup failure must kill and reap child"
        );
    }
    #[test]
    fn t12_unborn_unicode_spaces() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let value = query(&repo.0).unwrap();
        assert_eq!(value.kind, "repository");
        assert_eq!(value.branch.as_deref(), Some("fixture"));
        assert_eq!(value.dirty, Some(false));
        assert_eq!(value.root.as_deref(), repo.0.to_str());
    }
    #[test]
    fn t12_clean_is_readonly() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let index = fs::read(repo.0.join(".git/index")).unwrap();
        let head = fs::read(repo.0.join(".git/HEAD")).unwrap();
        let value = query(&repo.0).unwrap();
        assert_eq!(value.dirty, Some(false));
        assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), index);
        assert_eq!(fs::read(repo.0.join(".git/HEAD")).unwrap(), head);
        assert_eq!(
            fs::read_to_string(repo.0.join("file.txt")).unwrap(),
            "fixture\n"
        );
    }
    #[test]
    fn t12_dirty_and_detached() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        repo.git(&["checkout", "--detach"]);
        fs::write(repo.0.join("file.txt"), "changed").unwrap();
        let value = query(&repo.0).unwrap();
        assert_eq!(value.branch, None);
        assert_eq!(value.dirty, Some(true));
        assert_eq!(value.kind, "detached");
    }
    #[test]
    fn t12_nonrepo_is_normal() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        fs::remove_dir_all(repo.0.join(".git")).unwrap();
        let value = query(&repo.0).unwrap();
        assert_eq!(value.kind, "not_repository");
        assert_eq!(value.dirty, None);
        assert_eq!(value.branch, None);
    }
    #[test]
    fn t12_linked_worktree_relationship() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let linked = repo.0.join("linked 工作树");
        repo.git(&[
            "worktree",
            "add",
            "-b",
            "linked-fixture",
            linked.to_str().unwrap(),
        ]);
        let value = query(&linked).unwrap();
        assert_eq!(value.branch.as_deref(), Some("linked-fixture"));
        assert_eq!(value.root.as_deref(), linked.to_str());
        assert_eq!(value.common_dir, query(&repo.0).unwrap().common_dir);
    }
    #[test]
    fn t12_missing_git_fixed_error() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        assert_eq!(
            query_with_git(&repo.0, &repo.0.join("missing-git")).unwrap_err(),
            "git_missing"
        );
    }
    #[test]
    fn t12_invalid_path_fixed_error() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        assert_eq!(
            query(&repo.0.join("absent")).unwrap_err(),
            "git_invalid_path"
        );
        let file = repo.0.join("ordinary-file");
        fs::write(&file, "x").unwrap();
        assert_eq!(query(&file).unwrap_err(), "git_invalid_path");
    }
    #[test]
    fn t12_filter_refused_without_execution() {
        let _serial = serial_query_test();
        for key in ["filter.fixture.clean", "filter.fixture.process"] {
            let repo = Repo::new();
            repo.commit();
            let marker = repo.0.join("filter-ran");
            repo.git(&["config", key, &format!("touch '{}'", marker.display())]);
            fs::write(repo.0.join(".gitattributes"), "file.txt filter=fixture\n").unwrap();
            assert_eq!(query(&repo.0).unwrap_err(), "git_external_filter");
            assert!(!marker.exists());
        }
    }
    #[test]
    fn t12_fsmonitor_disabled_without_execution() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let marker = repo.0.join("fsmonitor-ran");
        let script = repo.0.join("monitor.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        repo.git(&["config", "core.fsmonitor", script.to_str().unwrap()]);
        assert_eq!(query(&repo.0).unwrap().dirty, Some(true));
        assert!(!marker.exists());
    }
    #[cfg(unix)]
    #[test]
    fn t12_actual_child_timeout() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let start = std::time::Instant::now();
        assert_eq!(
            run_bounded(
                std::path::Path::new("/bin/sh"),
                &["-c", "sleep 5"],
                &repo.0,
                start + std::time::Duration::from_millis(80),
                1024
            )
            .unwrap_err(),
            "git_timeout"
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }
    #[cfg(unix)]
    #[test]
    fn t12_actual_child_output_limit() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        assert_eq!(
            run_bounded(
                std::path::Path::new("/bin/sh"),
                &["-c", "while :; do printf 'xxxxxxxxxxxxxxxx'; done"],
                &repo.0,
                std::time::Instant::now() + std::time::Duration::from_secs(2),
                128
            )
            .unwrap_err(),
            "git_output_limit"
        );
    }
    #[cfg(unix)]
    #[test]
    fn t12_budget_shared_stdout_stderr_and_deadline() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let mut budget = Budget {
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(2),
            remaining: 128,
        };
        budget
            .run(
                std::path::Path::new("/bin/sh"),
                &["-c", "printf '%080d' 0"],
                &repo.0,
            )
            .unwrap();
        assert_eq!(
            budget
                .run(
                    std::path::Path::new("/bin/sh"),
                    &["-c", "printf '%080d' 0 >&2"],
                    &repo.0
                )
                .unwrap_err(),
            "git_output_limit"
        );
        let mut budget = Budget {
            deadline: std::time::Instant::now() + std::time::Duration::from_millis(100),
            remaining: 1024,
        };
        budget
            .run(
                std::path::Path::new("/bin/sh"),
                &["-c", "sleep 0.07"],
                &repo.0,
            )
            .unwrap();
        assert_eq!(
            budget
                .run(
                    std::path::Path::new("/bin/sh"),
                    &["-c", "sleep 0.07"],
                    &repo.0
                )
                .unwrap_err(),
            "git_timeout"
        );
    }
    #[cfg(unix)]
    #[test]
    fn t12_child_exit_inherited_pipe_does_not_hang() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let start = std::time::Instant::now();
        assert_eq!(
            run_bounded(
                std::path::Path::new("/bin/sh"),
                &["-c", "sleep 5 & exit 0"],
                &repo.0,
                start + std::time::Duration::from_millis(80),
                1024
            )
            .unwrap_err(),
            "git_timeout"
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }
    #[test]
    fn t12_filter_all_effective_config_scopes() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let source = repo.0.join("external.conf");
        fs::write(
            &source,
            "[filter \"fixture\"]\n clean = private-secret-value\n",
        )
        .unwrap();
        for env in [
            vec![("GIT_CONFIG_GLOBAL", source.to_str().unwrap())],
            vec![
                ("GIT_CONFIG_NOSYSTEM", "0"),
                ("GIT_CONFIG_SYSTEM", source.to_str().unwrap()),
            ],
            vec![
                ("GIT_CONFIG_COUNT", "1"),
                ("GIT_CONFIG_KEY_0", "filter.fixture.process"),
                ("GIT_CONFIG_VALUE_0", "private-secret-value"),
            ],
            vec![(
                "GIT_CONFIG_PARAMETERS",
                "'filter.fixture.clean=private-secret-value'",
            )],
        ] {
            assert_eq!(query_env(&repo.0, &env).unwrap_err(), "git_external_filter");
        }
        repo.git(&[
            "config",
            &format!("includeIf.gitdir:{}/.path", repo.0.display()),
            source.to_str().unwrap(),
        ]);
        assert_eq!(query(&repo.0).unwrap_err(), "git_external_filter");
        repo.git(&[
            "config",
            "--unset-all",
            &format!("includeIf.gitdir:{}/.path", repo.0.display()),
        ]);
        repo.git(&["config", "extensions.worktreeConfig", "true"]);
        repo.git(&[
            "config",
            "--worktree",
            "filter.fixture.process",
            "private-secret-value",
        ]);
        assert_eq!(query(&repo.0).unwrap_err(), "git_external_filter");
    }
    #[test]
    fn t12_repository_environment_cannot_redirect_query() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let other = Repo::new();
        other.commit();
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
        ] {
            assert_eq!(
                query_env(&repo.0, &[(key, other.0.to_str().unwrap())]).unwrap_err(),
                "git_environment"
            );
        }
    }
    #[test]
    fn t12_preflight_changes_refused_without_filter_execution() {
        let _serial = serial_query_test();
        for attributes in [false, true] {
            let repo = Repo::new();
            repo.commit();
            let marker = repo.0.join("must-not-run");
            let value = query_changed(&repo.0, || {
                repo.git(&[
                    "config",
                    "filter.injected.clean",
                    &format!("touch '{}'", marker.display()),
                ]);
                if attributes {
                    fs::write(repo.0.join(".gitattributes"), "file.txt filter=injected\n").unwrap();
                }
            });
            assert_eq!(value.unwrap_err(), "git_context_changed");
            assert!(!marker.exists());
        }
    }
    #[test]
    fn t12_submodules_skipped_without_independent_filters() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let nested = Repo::new();
        nested.commit();
        let hash = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{hash},nested"),
        ]);
        let marker = nested.0.join("must-not-run");
        nested.git(&[
            "config",
            "filter.fixture.clean",
            &format!("touch '{}'", marker.display()),
        ]);
        fs::write(nested.0.join(".gitattributes"), "file.txt filter=fixture\n").unwrap();
        fs::rename(&nested.0, repo.0.join("nested")).unwrap();
        assert_eq!(query(&repo.0).unwrap().dirty, Some(true));
        assert!(!repo.0.join("nested/must-not-run").exists());
    }

    #[test]
    fn t12_owner_query_guard_refuses_concurrent_reader() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let (started, wait) = std::sync::mpsc::channel();
        let (release, continue_read) = std::sync::mpsc::channel();
        let path = repo.0.clone();
        let first = std::thread::spawn(move || {
            query_changed(&path, || {
                started.send(()).unwrap();
                continue_read.recv().unwrap();
            })
        });
        wait.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let second = query(&repo.0);
        release.send(()).unwrap();
        let initial = first.join().unwrap();
        assert_eq!(second.unwrap_err(), "git_busy");
        assert!(initial.is_ok());
    }

    #[test]
    fn t12_builtin_line_endings_and_info_attributes_preserved() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.git(&["config", "core.autocrlf", "true"]);
        fs::write(repo.0.join("line.txt"), "first\r\nsecond\r\n").unwrap();
        repo.git(&["add", "line.txt"]);
        repo.git(&["commit", "-m", "line ending fixture"]);
        fs::write(
            repo.0.join(".git/info/attributes"),
            "line.txt text eol=crlf\n",
        )
        .unwrap();
        assert_eq!(query(&repo.0).unwrap().dirty, Some(false));
        fs::write(repo.0.join("line.txt"), "changed\r\n").unwrap();
        assert_eq!(query(&repo.0).unwrap().dirty, Some(true));
    }
    #[test]
    fn t12_unsupported_global_attributes_are_not_clean() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let attributes = repo.0.join("external-attributes");
        fs::write(&attributes, "file.txt text\n").unwrap();
        repo.git(&[
            "config",
            "core.attributesFile",
            attributes.to_str().unwrap(),
        ]);
        assert_eq!(query(&repo.0).unwrap_err(), "git_conversion_unsupported");
    }

    #[test]
    fn t12_committed_submodule_is_unavailable_without_visiting_filters() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let nested = Repo::new();
        nested.commit();
        let hash = nested.git(&["rev-parse", "HEAD"]);
        repo.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{hash},nested"),
        ]);
        repo.git(&["commit", "-m", "gitlink fixture"]);
        let marker = nested.0.join("must-not-run");
        nested.git(&[
            "config",
            "filter.fixture.clean",
            &format!("touch '{}'", marker.display()),
        ]);
        fs::write(nested.0.join(".gitattributes"), "file.txt filter=fixture\n").unwrap();
        fs::write(nested.0.join("file.txt"), "changed").unwrap();
        fs::rename(&nested.0, repo.0.join("nested")).unwrap();
        assert_eq!(query(&repo.0).unwrap_err(), "git_submodule_unavailable");
        assert!(!repo.0.join("nested/must-not-run").exists());
    }

    #[test]
    fn t12_config_read_failure_is_unavailable_not_nonrepo() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        fs::write(repo.0.join(".git/config"), "[invalid\nprivate-secret\n").unwrap();
        assert_eq!(query(&repo.0).unwrap_err(), "git_query_failed");
    }
    #[test]
    fn t12_effective_attributes_mismatch_is_unavailable() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let isolated = repo.0.join("controlled-xdg");
        fs::create_dir_all(isolated.join("git")).unwrap();
        fs::write(isolated.join("git/attributes"), "file.txt text eol=crlf\n").unwrap();
        // Test-only environment changes the original command's default attribute source; no host/system file is written.
        assert_eq!(
            query_env(&repo.0, &[("XDG_CONFIG_HOME", isolated.to_str().unwrap())]).unwrap_err(),
            "git_attributes_unsupported"
        );
    }
    #[test]
    fn t12_partial_clone_config_refused_before_object_commands() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        repo.git(&["config", "extensions.partialClone", "fixture"]);
        assert_eq!(query(&repo.0).unwrap_err(), "git_conversion_unsupported");
    }
    #[cfg(unix)]
    #[test]
    fn t12_relative_git_resolver_cannot_execute_project_sibling() {
        let _serial = serial_query_test();
        use std::os::unix::fs::PermissionsExt;
        let install = Repo::new();
        let project = Repo::new();
        project.commit();
        let installed = crate::find_executable("git")
            .unwrap()
            .canonicalize()
            .unwrap();
        for root in [&install.0, &project.0] {
            fs::create_dir(root.join("bin")).unwrap();
        }
        let trusted = install.0.join("bin/git");
        fs::write(
            &trusted,
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", installed.display()),
        )
        .unwrap();
        let marker = project.0.join("wrong-git-ran");
        let wrong = project.0.join("bin/git");
        fs::write(
            &wrong,
            format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
        )
        .unwrap();
        for script in [&trusted, &wrong] {
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let result = query_resolved_git(&project.0, Path::new("bin/git"), &install.0);
        assert!(
            !marker.exists(),
            "relative program was re-resolved inside the target project"
        );
        assert_eq!(result.unwrap().branch.as_deref(), Some("fixture"));
    }
    #[test]
    fn t12_review_info_exclude_preserves_clean_and_dirty() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        fs::write(repo.0.join(".git/info/exclude"), "ignored-*.txt\n").unwrap();
        fs::write(repo.0.join("ignored-only.txt"), "fixture").unwrap();
        assert_eq!(repo.git(&["status", "--porcelain=v1"]), "");
        assert_eq!(query(&repo.0).unwrap().dirty, Some(false));
        fs::write(repo.0.join("file.txt"), "changed").unwrap();
        assert_eq!(query(&repo.0).unwrap().dirty, Some(true));
    }
    #[test]
    fn t12_review_linked_worktree_uses_effective_info_exclude() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let linked = repo.0.join("linked");
        repo.git(&[
            "worktree",
            "add",
            "-b",
            "linked-ignore",
            linked.to_str().unwrap(),
        ]);
        fs::write(repo.0.join(".git/info/exclude"), "ignored-only.txt\n").unwrap();
        fs::write(linked.join("ignored-only.txt"), "fixture").unwrap();
        assert_eq!(query(&linked).unwrap().dirty, Some(false));
    }
    #[test]
    fn t12_review_configured_excludes_are_explicitly_unsupported() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let source = repo.0.join(".git/fixture-ignore");
        fs::write(&source, "ignored-only.txt\n").unwrap();
        fs::write(repo.0.join("ignored-only.txt"), "fixture").unwrap();
        for path in [
            source.to_str().unwrap(),
            ".git/fixture-ignore",
            "~/fixture-ignore",
            "%(prefix)/fixture-ignore",
        ] {
            repo.git(&["config", "core.excludesFile", path]);
            assert_eq!(query(&repo.0).unwrap_err(), "git_conversion_unsupported");
        }
        repo.git(&["config", "--unset", "core.excludesFile"]);
        assert_eq!(
            query_env(
                &repo.0,
                &[
                    ("GIT_CONFIG_COUNT", "1"),
                    ("GIT_CONFIG_KEY_0", "core.excludesFile"),
                    ("GIT_CONFIG_VALUE_0", source.to_str().unwrap())
                ]
            )
            .unwrap_err(),
            "git_conversion_unsupported"
        );
        repo.git(&["config", "extensions.worktreeConfig", "true"]);
        repo.git(&[
            "config",
            "--worktree",
            "core.excludesFile",
            source.to_str().unwrap(),
        ]);
        assert_eq!(query(&repo.0).unwrap_err(), "git_conversion_unsupported");
    }
    #[test]
    fn t12_review_info_exclude_limit_and_change() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let source = repo.0.join(".git/info/exclude");
        fs::write(&source, vec![b'x'; MAX_QUERY_BYTES + 1]).unwrap();
        assert_eq!(query(&repo.0).unwrap_err(), "git_output_limit");
        fs::write(&source, "ignored\n").unwrap();
        assert_eq!(
            query_changed(&repo.0, || {
                fs::write(&source, "changed-ignore\n").unwrap();
            })
            .unwrap_err(),
            "git_context_changed"
        );
    }
    #[cfg(unix)]
    #[test]
    fn t12_review_info_exclude_symlink_is_refused() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let source = repo.0.join(".git/info/exclude");
        fs::remove_file(&source).unwrap();
        std::os::unix::fs::symlink(repo.0.join("file.txt"), &source).unwrap();
        assert_eq!(query(&repo.0).unwrap_err(), "git_query_failed");
    }
    #[test]
    fn t12_review_subdirectory_does_not_hide_external_gitlink() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        fs::create_dir(repo.0.join("sub")).unwrap();
        fs::write(repo.0.join("sub/file.txt"), "fixture").unwrap();
        repo.git(&["add", "sub/file.txt"]);
        let nested = Repo::new();
        nested.commit();
        let hash = nested.git(&["rev-parse", "HEAD"]);
        repo.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{hash},nested"),
        ]);
        repo.git(&["commit", "-m", "external gitlink fixture"]);
        fs::write(nested.0.join("file.txt"), "changed").unwrap();
        fs::rename(&nested.0, repo.0.join("nested")).unwrap();
        assert_eq!(query(&repo.0).unwrap_err(), "git_submodule_unavailable");
        assert_eq!(
            query(&repo.0.join("sub")).unwrap_err(),
            "git_submodule_unavailable"
        );
    }

    #[test]
    fn f3_unborn_unicode_literal_binary_and_deleted_changes() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        let name = ":(glob)新 file.txt";
        fs::write(repo.0.join(name), "first\n").unwrap();
        repo.git(&["--literal-pathspecs", "add", "--", name]);
        let token = "d2345678-1234-4234-8234-123456789abc";
        let patch = query_changes(&repo.0, "o", "u", token, Some((name, "staged")))
            .unwrap()
            .patch
            .unwrap();
        assert_eq!(patch.kind, "text");
        assert!(patch.text.unwrap().contains("+first"));
        repo.git(&["commit", "-m", "unicode fixture"]);
        fs::write(repo.0.join(name), [0, 1, 2, 3]).unwrap();
        assert_eq!(
            query_changes(&repo.0, "o", "u", token, Some((name, "worktree")))
                .unwrap()
                .patch
                .unwrap()
                .kind,
            "binary"
        );
        fs::remove_file(repo.0.join(name)).unwrap();
        assert!(query_changes(&repo.0, "o", "u", token, None)
            .unwrap()
            .rows
            .iter()
            .any(|row| row.path == name && row.worktree == "D"));
    }
    #[test]
    fn f3_selected_member_untracked_and_large_are_explicit() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let token = "e2345678-1234-4234-8234-123456789abc";
        fs::write(repo.0.join("new"), "SECRET").unwrap();
        assert_eq!(
            query_changes(&repo.0, "o", "p", token, Some(("new", "worktree")))
                .unwrap()
                .patch
                .unwrap()
                .kind,
            "unsupported"
        );
        assert_eq!(
            query_changes(&repo.0, "o", "p", token, Some(("not-listed", "staged"))).unwrap_err(),
            "git_context_changed"
        );
        fs::write(repo.0.join("file.txt"), "line\n".repeat(60000)).unwrap();
        assert_eq!(
            query_changes(&repo.0, "o", "p", token, Some(("file.txt", "worktree"))).unwrap_err(),
            "git_output_limit"
        );
    }
    #[test]
    fn f3_external_conversion_config_never_executes() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let marker = repo.0.join("executed");
        repo.git(&[
            "config",
            "filter.fixture.clean",
            &format!("touch {}", marker.display()),
        ]);
        fs::write(repo.0.join(".gitattributes"), "file.txt filter=fixture\n").unwrap();
        fs::write(repo.0.join("file.txt"), "changed").unwrap();
        assert_eq!(
            query_changes(
                &repo.0,
                "o",
                "p",
                "f2345678-1234-4234-8234-123456789abc",
                None
            )
            .unwrap_err(),
            "git_external_filter"
        );
        assert!(!marker.exists());
    }
    #[test]
    fn f3_final_return_caps_after_the_last_path_replacement() {
        fn response(bytes: usize) -> GitChanges {
            let mut value = GitChanges {
                query_token: "12345678-1234-4234-8234-123456789abc".into(),
                path: "/repo".into(),
                root: Some("/repo".into()),
                rows: (0..4096)
                    .map(|i| GitChange {
                        path: format!("{i:04}-{}", "x".repeat(140)),
                        staged: " ".into(),
                        worktree: "M".into(),
                        untracked: false,
                        unsupported: false,
                    })
                    .collect(),
                patch: None,
            };
            let current = serde_json::to_vec(&value).unwrap().len();
            assert!(current <= bytes);
            let mut remaining = bytes - current;
            for row in &mut value.rows {
                let padding = remaining.min(4096 - row.path.len());
                row.path.push_str(&"y".repeat(padding));
                remaining -= padding;
            }
            assert_eq!(remaining, 0);
            assert_eq!(serde_json::to_vec(&value).unwrap().len(), bytes);
            value
        }
        let equal = finish_changes(response(MAX_QUERY_BYTES), Path::new("/repo")).unwrap();
        assert_eq!(serde_json::to_vec(&equal).unwrap().len(), MAX_QUERY_BYTES);
        assert!(finish_changes(response(MAX_QUERY_BYTES - 1), Path::new("/repo")).is_ok());
        let alias = format!("/{}repo", "./".repeat(50));
        assert_eq!(
            finish_changes(response(MAX_QUERY_BYTES), Path::new(&alias)).unwrap_err(),
            "git_output_limit"
        );
    }

    #[test]
    fn f3_submodule_uncertainty_not_hidden_by_other_changes() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let oid = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{oid},nested"),
        ]);
        fs::write(repo.0.join("file.txt"), "top dirty").unwrap();
        assert_eq!(
            query_changes(
                &repo.0,
                "o",
                "p",
                "62345678-1234-4234-8234-123456789abc",
                None
            )
            .unwrap_err(),
            "git_submodule_unavailable"
        );
    }
    #[test]
    fn f3_status_parser_bounds_rename_and_non_utf8_are_fixed() {
        let _serial = serial_query_test();
        let rows = parse_change_rows(b"R  dest\0source\0?? new\0").unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].unsupported);
        assert!(rows[1].untracked);
        assert_eq!(
            parse_change_rows(b" M missing-nul").unwrap_err(),
            "git_query_failed"
        );
        assert_eq!(
            parse_change_rows(b" M \xff\0").unwrap_err(),
            "git_conversion_unsupported"
        );
        let bytes = b"?? file\0".repeat(4097);
        assert_eq!(parse_change_rows(&bytes).unwrap_err(), "git_output_limit");
    }
    #[test]
    fn f3_cancel_capacity_expiry_and_matching_active_never_evict() {
        let _serial = serial_query_test();
        *CHANGE_REGISTRY.lock().unwrap() = ChangeRegistry::default();
        for i in 0..16 {
            cancel_changes("o", "c", &format!("12345678-1234-4234-8234-{i:012}")).unwrap();
        }
        assert_eq!(
            cancel_changes("o", "c", "additional").unwrap_err(),
            "git_cancel_capacity"
        );
        let active = ChangeAdmission::new("o", "c", "active").unwrap();
        cancel_changes("o", "c", "active").unwrap();
        assert!(active.flag.load(Ordering::Acquire));
        drop(active);
        cancel_changes("o", "c", "12345678-1234-4234-8234-000000000000").unwrap();
        assert!(ChangeAdmission::new("o", "other", "12345678-1234-4234-8234-000000000000").is_ok());
        CHANGE_REGISTRY
            .lock()
            .unwrap()
            .early
            .iter_mut()
            .for_each(|(_, expiry)| *expiry = Instant::now() - Duration::from_millis(1));
        assert!(ChangeAdmission::new("o", "c", "12345678-1234-4234-8234-000000000000").is_ok());
        *CHANGE_REGISTRY.lock().unwrap() = ChangeRegistry::default();
    }
    #[test]
    fn f3_changes_lists_staged_worktree_and_untracked_without_writes() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        fs::write(repo.0.join("file.txt"), "staged\n").unwrap();
        repo.git(&["add", "file.txt"]);
        fs::write(repo.0.join("file.txt"), "worktree\n").unwrap();
        fs::write(repo.0.join("新 file.txt"), "untracked").unwrap();
        let index = fs::read(repo.0.join(".git/index")).unwrap();
        let value = query_changes(
            &repo.0,
            "owner",
            "client",
            "12345678-1234-4234-8234-123456789abc",
            None,
        )
        .unwrap();
        let row = value.rows.iter().find(|r| r.path == "file.txt").unwrap();
        assert_eq!((&row.staged[..], &row.worktree[..]), ("M", "M"));
        assert!(value
            .rows
            .iter()
            .any(|r| r.path == "新 file.txt" && r.untracked));
        assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), index);
    }
    #[test]
    fn f3_changes_selected_staged_and_worktree_are_distinct() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        fs::write(repo.0.join("file.txt"), "staged\n").unwrap();
        repo.git(&["add", "file.txt"]);
        fs::write(repo.0.join("file.txt"), "worktree\n").unwrap();
        for (side, text) in [("staged", "+staged"), ("worktree", "+worktree")] {
            let result = query_changes(
                &repo.0,
                "owner",
                "client",
                "12345678-1234-4234-8234-123456789abc",
                Some(("file.txt", side)),
            )
            .unwrap();
            let patch = result.patch.unwrap();
            assert_eq!(patch.kind, "text");
            assert!(patch.text.unwrap().contains(text));
        }
    }
    #[test]
    fn f3_changes_cancel_before_admission_does_not_spawn() {
        let _serial = serial_query_test();
        let repo = Repo::new();
        repo.commit();
        let token = "a2345678-1234-4234-8234-123456789abc";
        cancel_changes("owner", "early", token).unwrap();
        assert_eq!(
            query_changes(&repo.0, "owner", "early", token, None).unwrap_err(),
            "git_cancelled"
        );
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CleanupSnapshot {
    pub head: String,
    pub admin: PathBuf,
    pub bytes: Vec<u8>,
    pub inventory: Vec<u8>,
}
pub(crate) fn cleanup_snapshot(
    path: &Path,
    git: &Path,
    env: Vec<(OsString, OsString)>,
) -> Result<CleanupSnapshot, String> {
    let (context, snapshot) = query_snapshot(path, git, env, || {}, true)?;
    if context.dirty != Some(false) {
        return Err("worktree_not_clean".into());
    }
    snapshot.ok_or_else(|| "git_query_failed".into())
}
// No symlink traversal. The inventory is metadata-only, bounded and compared again before disposition.
pub(crate) fn cleanup_inventory(root: &Path, budget: &mut Budget) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
        let mut pending = vec![PathBuf::new()];
        let mut entries = Vec::new();
        let mut count = 0usize;
        while let Some(relative) = pending.pop() {
            if Instant::now() >= budget.deadline {
                return Err("git_timeout".into());
            }
            let path = root.join(&relative);
            let metadata = fs::symlink_metadata(&path).map_err(|_| "git_query_failed")?;
            if !relative.as_os_str().is_empty() {
                count += 1;
                if count > 4096 {
                    return Err("git_output_limit".into());
                }
                if path.file_name() == Some(std::ffi::OsStr::new(".git"))
                    && relative != Path::new(".git")
                {
                    return Err("git_nested_repository".into());
                }
                if !metadata.is_dir() && !metadata.is_file() && !metadata.file_type().is_symlink() {
                    return Err("git_conversion_unsupported".into());
                }
                let link = if metadata.file_type().is_symlink() {
                    fs::read_link(&path)
                        .map_err(|_| "git_query_failed")?
                        .as_os_str()
                        .as_bytes()
                        .to_vec()
                } else {
                    Vec::new()
                };
                let entry = (
                    relative.as_os_str().as_bytes().to_vec(),
                    metadata.dev(),
                    metadata.ino(),
                    metadata.mode(),
                    metadata.len(),
                    metadata.mtime(),
                    metadata.mtime_nsec(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                    link,
                );
                let size = serde_json::to_vec(&entry)
                    .map_err(|_| "git_query_failed")?
                    .len()
                    + 1;
                budget.remaining = budget
                    .remaining
                    .checked_sub(size)
                    .ok_or("git_output_limit")?;
                entries.push(entry);
            }
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                for entry in fs::read_dir(&path).map_err(|_| "git_query_failed")? {
                    let entry = entry.map_err(|_| "git_query_failed")?;
                    pending.push(relative.join(entry.file_name()));
                    if pending.len() + count > 4096 {
                        return Err("git_output_limit".into());
                    }
                }
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let bytes = serde_json::to_vec(&entries).map_err(|_| "git_query_failed")?;
        if bytes.len() > MAX_QUERY_BYTES {
            return Err("git_output_limit".into());
        }
        Ok(bytes)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, budget);
        Err("git_conversion_unsupported".into())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GitChange {
    pub path: String,
    pub staged: String,
    pub worktree: String,
    pub untracked: bool,
    pub unsupported: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GitPatch {
    pub path: String,
    pub side: String,
    pub kind: String,
    pub text: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GitChanges {
    pub query_token: String,
    pub path: String,
    pub root: Option<String>,
    pub rows: Vec<GitChange>,
    pub patch: Option<GitPatch>,
}

#[derive(Default)]
struct ChangeRegistry {
    active: Option<(String, Arc<AtomicBool>)>,
    early: Vec<(String, Instant)>,
}
static CHANGE_REGISTRY: Mutex<ChangeRegistry> = Mutex::new(ChangeRegistry {
    active: None,
    early: Vec::new(),
});
fn scope_key(owner: &str, client: &str, token: &str) -> String {
    format!("{owner}/{client}/{token}")
}
struct ChangeAdmission {
    key: String,
    flag: Arc<AtomicBool>,
}
impl ChangeAdmission {
    fn new(owner: &str, client: &str, token: &str) -> Result<Self, String> {
        let key = scope_key(owner, client, token);
        let mut registry = CHANGE_REGISTRY.lock().map_err(|_| "git_query_failed")?;
        registry
            .early
            .retain(|(_, deadline)| *deadline > Instant::now());
        if registry.early.iter().any(|(entry, _)| entry == &key) {
            return Err("git_cancelled".into());
        }
        if registry.active.is_some() {
            return Err("git_busy".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        registry.active = Some((key.clone(), flag.clone()));
        Ok(Self { key, flag })
    }
}
impl Drop for ChangeAdmission {
    fn drop(&mut self) {
        if let Ok(mut registry) = CHANGE_REGISTRY.lock() {
            if registry
                .active
                .as_ref()
                .is_some_and(|(key, _)| key == &self.key)
            {
                registry.active = None;
            }
        }
    }
}
pub(crate) fn cancel_changes(owner: &str, client: &str, token: &str) -> Result<(), String> {
    let key = scope_key(owner, client, token);
    let mut registry = CHANGE_REGISTRY.lock().map_err(|_| "git_query_failed")?;
    registry
        .early
        .retain(|(_, deadline)| *deadline > Instant::now());
    if let Some((entry, flag)) = &registry.active {
        if entry == &key {
            flag.store(true, Ordering::Release);
            return Ok(());
        }
    }
    if registry.early.iter().any(|(entry, _)| entry == &key) {
        return Ok(());
    }
    if registry.early.len() >= 16 {
        return Err("git_cancel_capacity".into());
    }
    registry
        .early
        .push((key, Instant::now() + Duration::from_secs(10)));
    Ok(())
}
fn parse_change_rows(bytes: &[u8]) -> Result<Vec<GitChange>, String> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) {
        return Err("git_query_failed".into());
    }
    let mut entries = bytes.split(|b| *b == 0).filter(|entry| !entry.is_empty());
    let mut rows = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4
            || entry[2] != b' '
            || !b" MADRCUT?!".contains(&entry[0])
            || !b" MADRCUT?!".contains(&entry[1])
        {
            return Err("git_query_failed".into());
        }
        let name = std::str::from_utf8(&entry[3..]).map_err(|_| "git_conversion_unsupported")?;
        if name.len() > 4096 || name.chars().any(char::is_control) {
            return Err("git_conversion_unsupported".into());
        }
        let unsupported = [entry[0], entry[1]].iter().any(|b| b"RCU".contains(b))
            || matches!(&entry[..2], b"AA" | b"DD");
        if entry[0] == b'R' || entry[0] == b'C' || entry[1] == b'R' || entry[1] == b'C' {
            let old = entries.next().ok_or("git_query_failed")?;
            if old.len() > 4096 || std::str::from_utf8(old).is_err() {
                return Err("git_conversion_unsupported".into());
            }
        }
        if rows.len() >= 4096 {
            return Err("git_output_limit".into());
        }
        rows.push(GitChange {
            path: name.into(),
            staged: (entry[0] as char).to_string(),
            worktree: (entry[1] as char).to_string(),
            untracked: &entry[..2] == b"??",
            unsupported,
        });
    }
    Ok(rows)
}
#[cfg(test)]
thread_local! { pub(crate) static F3_TEST_GIT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }
pub(crate) fn query_changes(
    path: &Path,
    owner: &str,
    client: &str,
    token: &str,
    selected: Option<(&str, &str)>,
) -> Result<GitChanges, String> {
    let admission = ChangeAdmission::new(owner, client, token)?;
    let git = crate::find_executable("git").ok_or("git_missing")?;
    #[cfg(test)]
    let git = F3_TEST_GIT
        .with(|value| value.borrow().clone())
        .unwrap_or(git);
    let fixed = fixed_git(&git, &std::env::current_dir().map_err(|_| "git_missing")?)?;
    let (_, _, changes) = query_snapshot_changes(
        path,
        &fixed,
        config_environment()?,
        || {},
        false,
        Some((token, selected)),
        Some(&admission.flag),
    )?;
    finish_changes(changes.ok_or("git_query_failed")?, path)
}
// The sole final DTO return path, after the caller's path spelling is restored.
fn finish_changes(mut value: GitChanges, path: &Path) -> Result<GitChanges, String> {
    value.path = path.to_string_lossy().into_owned();
    if serde_json::to_vec(&value)
        .map_err(|_| "git_query_failed")?
        .len()
        > MAX_QUERY_BYTES
    {
        return Err("git_output_limit".into());
    }
    Ok(value)
}

#[cfg(test)]
pub(crate) fn f3_serial_query_test() -> std::sync::MutexGuard<'static, ()> {
    tests::serial_query_test()
}
