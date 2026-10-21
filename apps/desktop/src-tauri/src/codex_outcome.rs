use serde_json::Value;

struct Decoder<'a> {
    session: &'a str,
    turn: &'a str,
    cwd: &'a str,
    metadata: bool,
    started: bool,
}
impl Decoder<'_> {
    fn line(&mut self, line: &[u8]) -> Result<Option<bool>, &'static str> {
        let value: Value = serde_json::from_slice(line).map_err(|_| "Invalid outcome record")?;
        let payload = &value["payload"];
        if !self.metadata {
            // Rollout JSONL is not a stable API; accept only the measured native format.
            if value["type"] != "session_meta"
                || payload["id"] != self.session
                || payload["cwd"] != self.cwd
                || !matches!(payload["cli_version"].as_str(), Some("0.162.1" | "0.163.0"))
            {
                return Err("Unsupported outcome identity or format");
            }
            self.metadata = true;
            return Ok(None);
        }
        if value["type"] == "session_meta" {
            return Err("Repeated outcome metadata");
        }
        if value["type"] != "event_msg" || payload["turn_id"] != self.turn {
            return Ok(None);
        }
        match payload["type"].as_str() {
            Some("task_started") => self.started = true,
            Some("task_complete" | "turn_aborted") => {
                if !self.started {
                    return Err("Missing native turn start");
                }
                let error = payload.get("error").filter(|v| !v.is_null());
                if error.is_some_and(|v| !v.is_object()) {
                    return Err("Unsupported outcome error");
                }
                return Ok(Some(payload["type"] == "task_complete" && error.is_some()));
            }
            _ => {}
        }
        Ok(None)
    }
}

#[cfg(unix)]
fn observe(
    root: &std::path::Path,
    path: &std::path::Path,
    decoder: &mut Decoder<'_>,
    timeout: std::time::Duration,
    mut alive: impl FnMut() -> bool,
) -> Result<Option<bool>, &'static str> {
    use std::{
        io::{BufRead, Read},
        os::unix::fs::MetadataExt,
        time::{Duration, Instant},
    };
    const MAX_BYTES: u64 = 128 * 1024 * 1024;
    const MAX_LINE: usize = 2 * 1024 * 1024;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Outcome outside native home")?;
    let root = std::fs::File::open(root).map_err(|_| "Outcome root unavailable")?;
    let file = crate::file_preview::open_beneath(&root, relative)?;
    let metadata = file.metadata().map_err(|_| "Outcome unavailable")?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err("Invalid outcome file");
    }
    let mut reader = std::io::BufReader::new(file);
    let mut pending = Vec::new();
    let mut seen = 0u64;
    let deadline = Instant::now() + timeout;
    let mut path_checked_at = 0u64;
    while Instant::now() < deadline && alive() {
        // Bound path checks by consumed bytes; read_until can refill inside a record.
        if reader.buffer().is_empty()
            || seen.saturating_sub(path_checked_at) >= reader.capacity() as u64
        {
            let current = crate::file_preview::open_beneath(&root, relative)?
                .metadata()
                .map_err(|_| "Outcome unavailable")?;
            if current.dev() != metadata.dev()
                || current.ino() != metadata.ino()
                || current.nlink() != 1
            {
                return Err("Outcome file replaced");
            }
            path_checked_at = seen;
        }
        let current = reader
            .get_ref()
            .metadata()
            .map_err(|_| "Outcome unavailable")?;
        if current.nlink() != 1 || current.uid() != metadata.uid() {
            return Err("Invalid outcome file");
        }
        if current.len() < seen || current.len() > MAX_BYTES {
            return Err("Outcome file truncated or too large");
        }
        let count = reader
            .by_ref()
            .take((MAX_LINE + 1 - pending.len()) as u64)
            .read_until(b'\n', &mut pending)
            .map_err(|_| "Cannot read outcome")?;
        seen += count as u64;
        if pending.len() > MAX_LINE || seen > MAX_BYTES {
            return Err("Outcome record too large");
        }
        if pending.ends_with(b"\n") {
            if let Some(outcome) = decoder.line(&pending)? {
                let current = crate::file_preview::open_beneath(&root, relative)?
                    .metadata()
                    .map_err(|_| "Outcome unavailable")?;
                if current.dev() != metadata.dev()
                    || current.ino() != metadata.ino()
                    || current.nlink() != 1
                {
                    return Err("Outcome file replaced");
                }
                if current.len() < seen || current.len() > MAX_BYTES {
                    return Err("Outcome file truncated or too large");
                }
                if !alive() || Instant::now() >= deadline {
                    return Ok(None);
                }
                return Ok(Some(outcome));
            }
            pending.clear();
        } else {
            std::thread::sleep(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeProcess {
    pid: u32,
    start: [u64; 2],
}

#[cfg(target_os = "macos")]
fn process(pid: u32) -> Option<libc::proc_bsdinfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let count = unsafe {
        libc::proc_pidinfo(
            pid.try_into().ok()?,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (count == size && info.pbi_uid == unsafe { libc::geteuid() } && info.pbi_status != 5)
        .then_some(info)
}

#[cfg(target_os = "macos")]
impl NativeProcess {
    fn ancestor() -> Option<Self> {
        let mut pid = unsafe { libc::getppid() } as u32;
        for _ in 0..8 {
            let info = process(pid)?;
            let name = info
                .pbi_comm
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8)
                .collect::<Vec<_>>();
            if name.starts_with(b"codex") {
                return Some(Self {
                    pid,
                    start: [info.pbi_start_tvsec, info.pbi_start_tvusec],
                });
            }
            if info.pbi_ppid <= 1 || info.pbi_ppid == pid {
                break;
            }
            pid = info.pbi_ppid;
        }
        None
    }
    fn alive(&self) -> bool {
        process(self.pid).is_some_and(|p| self.start == [p.pbi_start_tvsec, p.pbi_start_tvusec])
    }
}

#[cfg(target_os = "macos")]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    event: crate::agent_events::AgentEvent,
    cwd: String,
    root: std::path::PathBuf,
    path: std::path::PathBuf,
    process: NativeProcess,
}

#[cfg(target_os = "macos")]
pub(crate) fn start(
    value: &Value,
    event: &crate::agent_events::AgentEvent,
) -> Result<(), &'static str> {
    use std::{
        path::PathBuf,
        process::{Command, Stdio},
    };
    if event.kind != "UserPromptSubmit" {
        return Ok(());
    }
    let cwd = value["cwd"]
        .as_str()
        .filter(|s| s.len() <= 8192)
        .ok_or("Missing native cwd")?;
    let path = value["transcript_path"]
        .as_str()
        .filter(|s| s.len() <= 8192)
        .ok_or("Missing native transcript")?;
    let home = std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".codex")))
        .ok_or("Missing native home")?;
    let request = Request {
        event: event.clone(),
        cwd: cwd.into(),
        root: home.join("sessions"),
        path: path.into(),
        process: NativeProcess::ancestor().ok_or("Native process unavailable")?,
    };
    let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid observer request")?;
    if bytes.len() > 64 * 1024 {
        return Err("Observer request too large");
    }
    let mut child = Command::new(std::env::current_exe().map_err(|_| "Helper unavailable")?)
        .arg("--yam-codex-outcome")
        .env_clear()
        .env(
            "YAM_AGENT_ADDRESS",
            std::env::var_os("YAM_AGENT_ADDRESS").ok_or("Missing agent address")?,
        )
        .env(
            "YAM_AGENT_TOKEN",
            std::env::var_os("YAM_AGENT_TOKEN").ok_or("Missing agent credential")?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Outcome observer could not start")?;
    let result = initialize(
        child.stdin.take().ok_or("Observer input unavailable")?,
        &bytes,
    );
    if result.is_err() {
        let _ = child.kill();
    }
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    result
}

#[cfg(target_os = "macos")]
fn initialize(mut stdin: std::process::ChildStdin, bytes: &[u8]) -> Result<(), &'static str> {
    use std::{io::Write, os::fd::AsRawFd};
    let fd = stdin.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Observer input unavailable");
    }
    stdin
        .write_all(bytes)
        .map_err(|_| "Cannot initialize observer")
}

#[cfg(target_os = "macos")]
pub(crate) fn run(raw: &str) -> Result<Option<crate::agent_events::AgentEvent>, &'static str> {
    let mut request: Request = serde_json::from_str(raw).map_err(|_| "Invalid observer request")?;
    let mut decoder = Decoder {
        session: &request.event.agent_session_id,
        turn: request
            .event
            .turn_id
            .as_deref()
            .ok_or("Missing native turn")?,
        cwd: &request.cwd,
        metadata: false,
        started: false,
    };
    // Stay in the original process group; owner stop reaps the observer with the CLI.
    let result = observe(
        &request.root,
        &request.path,
        &mut decoder,
        std::time::Duration::from_secs(3600),
        || request.process.alive(),
    )?;
    if result == Some(true) {
        request.event.kind = "TurnFailed".into();
        request.event.permission_key = None;
        request.event.source = None;
        return Ok(Some(request.event));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::{fs, io::Write, path::PathBuf, time::Duration};

    fn decoder() -> Decoder<'static> {
        Decoder {
            session: "thread-1",
            turn: "turn-1",
            cwd: "/project",
            metadata: false,
            started: false,
        }
    }
    fn feed(d: &mut Decoder<'_>, value: Value) -> Result<Option<bool>, &'static str> {
        d.line(&serde_json::to_vec(&value).unwrap())
    }
    fn meta() -> Value {
        json!({"type":"session_meta","payload":{"id":"thread-1","cwd":"/project","cli_version":"0.162.1"}})
    }
    fn event(kind: &str, turn: &str) -> Value {
        json!({"type":"event_msg","payload":{"type":kind,"turn_id":turn}})
    }
    fn started() -> Decoder<'static> {
        let mut d = decoder();
        assert_eq!(feed(&mut d, meta()).unwrap(), None);
        assert_eq!(feed(&mut d, event("task_started", "turn-1")).unwrap(), None);
        d
    }
    #[test]
    fn native_api_failure_is_a_terminal_failure_without_error_text() {
        let mut d = started();
        let mut v = event("task_complete", "turn-1");
        v["payload"]["error"] =
            json!({"message":"SECRET provider response","codex_error_info":"other"});
        assert_eq!(feed(&mut d, v).unwrap(), Some(true));
    }
    #[test]
    fn codex_0163_observed_outcomes_keep_failure_success_abort_and_identity_distinct() {
        // Recorded from the installed CLI against an isolated loopback 401 endpoint; IDs and paths normalized.
        let records: Vec<Value> = include_str!("../../tests/fixtures/codex-0.163-outcome.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for (index, expected) in [(2, Some(true)), (3, Some(false)), (4, Some(false))] {
            let mut d = Decoder {
                session: "thread-0163",
                turn: "turn-0163",
                ..decoder()
            };
            assert_eq!(feed(&mut d, records[0].clone()).unwrap(), None);
            assert_eq!(feed(&mut d, records[1].clone()).unwrap(), None);
            assert_eq!(feed(&mut d, records[index].clone()).unwrap(), expected);
        }
        let mut foreign = Decoder {
            session: "different-thread",
            turn: "turn-0163",
            ..decoder()
        };
        assert!(feed(&mut foreign, records[0].clone()).is_err());
    }
    #[test]
    fn success_and_abort_stop_observation_without_synthesizing_failure() {
        for kind in ["task_complete", "turn_aborted"] {
            let mut d = started();
            assert_eq!(feed(&mut d, event(kind, "turn-1")).unwrap(), Some(false));
        }
        let mut d = started();
        let mut v = event("task_complete", "turn-1");
        v["payload"]["error"] = Value::Null;
        assert_eq!(feed(&mut d, v).unwrap(), Some(false));
    }
    #[test]
    fn wrong_identity_unknown_format_and_missing_start_fail_closed() {
        for (key, value) in [
            ("id", "other"),
            ("cwd", "/elsewhere"),
            ("cli_version", "99.0.0"),
        ] {
            let mut d = decoder();
            let mut v = meta();
            v["payload"][key] = value.into();
            assert!(feed(&mut d, v).is_err(), "{key}");
        }
        let mut d = decoder();
        assert!(feed(&mut d, event("task_complete", "turn-1")).is_err());
        let mut d = decoder();
        feed(&mut d, meta()).unwrap();
        assert!(feed(&mut d, event("task_complete", "turn-1")).is_err());
        assert!(d.line(b"not json").is_err());
    }
    #[test]
    fn other_turns_and_nested_error_text_are_not_failure_receipts() {
        let mut d = started();
        let mut v = event("task_complete", "other");
        v["payload"]["error"] = json!({"message":"error"});
        assert_eq!(feed(&mut d, v).unwrap(), None);
        assert_eq!(feed(&mut d, json!({"type":"response_item","payload":{"type":"message","error":{"message":"error"}}})).unwrap(), None);
        assert_eq!(
            feed(&mut d, event("task_complete", "turn-1")).unwrap(),
            Some(false)
        );
    }
    #[test]
    fn retry_and_stream_errors_do_not_complete_a_native_turn() {
        let mut d = started();
        for kind in ["error", "stream_error", "retrying", "warning"] {
            let mut value = event(kind, "turn-1");
            value["payload"]["error"] = json!({"message":"transient provider error"});
            assert_eq!(feed(&mut d, value).unwrap(), None);
        }
        assert_eq!(
            feed(&mut d, event("task_complete", "turn-1")).unwrap(),
            Some(false)
        );
    }
    #[cfg(unix)]
    fn fixture() -> (PathBuf, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "yam-outcome-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("2026/10/18")).unwrap();
        let path = root.join("2026/10/18/rollout.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        for v in [meta(), event("task_started", "turn-1")] {
            writeln!(file, "{v}").unwrap();
        }
        (root, path)
    }
    #[cfg(unix)]
    #[test]
    fn observer_waits_for_complete_line_and_matching_failure() {
        let (root, path) = fixture();
        let writer = path.clone();
        let thread = std::thread::spawn(move || {
            let mut f = fs::OpenOptions::new().append(true).open(writer).unwrap();
            write!(f, "{{\"type\":\"event_msg\",\"payload\":").unwrap();
            std::thread::sleep(Duration::from_millis(30));
            writeln!(
                f,
                "{{\"type\":\"task_complete\",\"turn_id\":\"turn-1\",\"error\":{{}}}}}}"
            )
            .unwrap();
        });
        assert_eq!(
            observe(&root, &path, &mut decoder(), Duration::from_secs(2), || {
                true
            })
            .unwrap(),
            Some(true)
        );
        thread.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn observer_rejects_escape_symlink_and_non_regular_files() {
        use std::os::unix::fs::symlink;
        let (root, path) = fixture();
        let alias = root.join("alias.jsonl");
        symlink(&path, &alias).unwrap();
        for file in [&alias, &root, &root.join("../outside.jsonl")] {
            assert!(observe(
                &root,
                file,
                &mut decoder(),
                Duration::from_millis(1),
                || true
            )
            .is_err());
        }
        fs::create_dir(root.join("elsewhere")).unwrap();
        symlink(root.join("elsewhere"), root.join("link-dir")).unwrap();
        assert!(observe(
            &root,
            &root.join("link-dir/file"),
            &mut decoder(),
            Duration::from_millis(1),
            || true
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn observer_exits_on_deadline_or_original_process_exit() {
        let (root, path) = fixture();
        assert_eq!(
            observe(
                &root,
                &path,
                &mut decoder(),
                Duration::from_millis(5),
                || true
            )
            .unwrap(),
            None
        );
        assert_eq!(
            observe(
                &root,
                &path,
                &mut decoder(),
                Duration::from_secs(20),
                || false
            )
            .unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn observer_rejects_oversized_records_files_and_hard_links() {
        use std::io::{Seek, SeekFrom};
        let (root, path) = fixture();
        let alias = root.join("hard-link.jsonl");
        fs::hard_link(&path, &alias).unwrap();
        assert!(
            observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
                true
            })
            .is_err()
        );
        fs::remove_file(alias).unwrap();
        let mut f = fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_len(129 * 1024 * 1024).unwrap();
        assert!(
            observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
                true
            })
            .is_err()
        );
        f.set_len(0).unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        f.write_all(&vec![b'a'; 2 * 1024 * 1024 + 1]).unwrap();
        assert!(
            observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
                true
            })
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn observer_does_not_follow_a_replaced_file_or_read_a_truncated_record() {
        let (root, path) = fixture();
        let replacement = path.clone();
        let mut calls = 0;
        let result = observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
            calls += 1;
            if calls == 3 {
                fs::write(&replacement, b"\n").unwrap();
            }
            true
        });
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_identity_rejects_exit_and_pid_reuse() {
        let pid = std::process::id();
        let p = process(pid).unwrap();
        let mut identity = NativeProcess {
            pid,
            start: [p.pbi_start_tvsec, p.pbi_start_tvusec],
        };
        assert!(identity.alive());
        identity.start[1] += 1;
        assert!(!identity.alive());
        identity.pid = u32::MAX;
        assert!(!identity.alive());
    }
    #[cfg(unix)]
    #[test]
    fn observer_rejects_path_replacement_before_committing_an_old_inode_failure() {
        let (root, path) = fixture();
        let old = root.join("renamed.jsonl");
        let mut calls = 0;
        let result = observe(
            &root,
            &path,
            &mut decoder(),
            Duration::from_millis(200),
            || {
                calls += 1;
                if calls == 3 {
                    fs::rename(&path, &old).unwrap();
                    fs::write(&path, b"replacement\n").unwrap();
                    let mut f = fs::OpenOptions::new().append(true).open(&old).unwrap();
                    writeln!(f, "{}", json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","error":{}}})).unwrap();
                }
                true
            },
        );
        assert!(
            result.is_err(),
            "renamed original file must not deliver a failure: {result:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn non_reading_worker_cannot_block_the_native_prompt_hook() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sleep")
            .arg("0.4")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let result = initialize(child.stdin.take().unwrap(), &vec![b'a'; 256 * 1024]);
        let elapsed = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(150), "blocked {elapsed:?}");
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "bounded synthetic load; never uses native CLI or app state"]
    fn outcome_load_eight_long_sessions_keep_exact_identity_and_outcomes() {
        use std::io::BufWriter;
        use std::sync::{Arc, Barrier};
        const WORKERS: usize = 8;
        const BYTES: u64 = 16 * 1024 * 1024;
        let mut fixtures = Vec::new();
        for worker in 0..WORKERS {
            let (root, path) = fixture();
            let session = format!("thread-{worker}");
            let turn = format!("turn-{worker}");
            let mut file = BufWriter::new(fs::File::create(&path).unwrap());
            writeln!(file, "{}", json!({"type":"session_meta","payload":{"id":session,"cwd":"/project","cli_version":"0.162.1"}})).unwrap();
            let line = format!(
                "{}\n",
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"foreign","error":{},"padding":"x".repeat(160)}})
            );
            for _ in 0..BYTES / line.len() as u64 {
                file.write_all(line.as_bytes()).unwrap();
            }
            writeln!(file, "{}", event("task_started", &turn)).unwrap();
            let mut done = event(
                if worker % 3 == 2 {
                    "turn_aborted"
                } else {
                    "task_complete"
                },
                &turn,
            );
            if worker % 3 == 0 {
                done["payload"]["error"] = json!({"message":"synthetic failure"});
            }
            writeln!(file, "{done}").unwrap();
            file.flush().unwrap();
            assert!(fs::metadata(&path).unwrap().len() >= BYTES - line.len() as u64);
            fixtures.push((root, path, session, turn));
        }
        let barrier = Arc::new(Barrier::new(WORKERS + 1));
        let wall = std::time::Instant::now();
        let threads: Vec<_> = fixtures.into_iter().enumerate().map(|(worker, (root, path, session, turn))| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut d = Decoder { session: &session, turn: &turn, cwd: "/project", metadata: false, started: false };
                barrier.wait();
                let start = std::time::Instant::now();
                let result = observe(&root, &path, &mut d, Duration::from_secs(15), || true);
                let elapsed = start.elapsed();
                fs::remove_dir_all(root).unwrap();
                assert_eq!(result.unwrap(), Some(worker % 3 == 0), "worker {worker} must ignore foreign terminal records and finish within 15 seconds");
                assert!(elapsed < Duration::from_secs(15));
                elapsed.as_secs_f64()
            })
        }).collect();
        barrier.wait();
        let mut seconds: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        seconds.sort_by(f64::total_cmp);
        println!(
            "outcome_load_metrics {}",
            json!({"workers":WORKERS,"history_bytes_per_worker":BYTES,"worker_seconds":seconds,"max_seconds":seconds[WORKERS-1],"wall_seconds":wall.elapsed().as_secs_f64()})
        );
    }

    #[cfg(unix)]
    #[test]
    fn observer_rechecks_size_before_committing_buffered_terminal_records() {
        for oversize in [false, true] {
            let (root, path) = fixture();
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","error":{}}})).unwrap();
            let mut calls = 0;
            let result = observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
                calls += 1;
                if calls == 3 {
                    file.set_len(if oversize { 129 * 1024 * 1024 } else { 0 })
                        .unwrap();
                }
                true
            });
            assert!(
                result.is_err(),
                "buffered terminal records must not bypass a changed file size: {result:?}"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn observer_rejects_truncate_and_regrow_while_unrelated_line_is_cached() {
        let (root, path) = fixture();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", event("task_started", "foreign")).unwrap();
        writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","error":{}}})).unwrap();
        let length = file.metadata().unwrap().len();
        let mut calls = 0;
        let result = observe(&root, &path, &mut decoder(), Duration::from_secs(1), || {
            calls += 1;
            if calls == 3 {
                file.set_len(0).unwrap();
            }
            if calls == 4 {
                file.set_len(length).unwrap();
            }
            true
        });
        fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_err(),
            "transient truncation must invalidate cached records: {result:?}"
        );
    }
}
