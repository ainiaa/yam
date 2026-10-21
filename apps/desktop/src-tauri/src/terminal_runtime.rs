// Author: Jeff.Liu. The background owns the persistent parser over private pipes.
use serde_json::Value;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
pub(super) fn service_command(executable: &Path) -> Command {
    let command = Command::new(executable);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: the two service children have no console UI.
        command
    };
    command
}

pub(super) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for block in bytes.chunks(3) {
        let n = ((block[0] as usize) << 16)
            | ((block.get(1).copied().unwrap_or(0) as usize) << 8)
            | block.get(2).copied().unwrap_or(0) as usize;
        result.push(ALPHABET[(n >> 18) & 63] as char);
        result.push(ALPHABET[(n >> 12) & 63] as char);
        result.push(if block.len() > 1 {
            ALPHABET[(n >> 6) & 63] as char
        } else {
            '='
        });
        result.push(if block.len() > 2 {
            ALPHABET[n & 63] as char
        } else {
            '='
        });
    }
    result
}
pub(super) fn validate_snapshot(
    value: &Value,
    session: &str,
    instance: Option<&str>,
) -> Result<(), String> {
    let cols = value["cols"]
        .as_u64()
        .filter(|c| (2..=500).contains(c))
        .ok_or("Invalid terminal frame dimensions")?;
    let retained = match value.get("retained_lines") {
        None => 2000,
        Some(value) => value
            .as_u64()
            .filter(|n| (200..=2000).contains(n))
            .ok_or("Invalid terminal retention frame")?,
    };
    let valid = value["version"] == 1
        && value["session"] == session
        && value["terminal_version"] == "6.0.0"
        && value["serialize_version"] == "0.14.0"
        && value["instance"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes().all(|b| b.is_ascii_hexdigit())
                && instance.is_none_or(|expected| s == expected)
        })
        && value["revision"]
            .as_u64()
            .is_some_and(|n| n <= 9_007_199_254_740_991)
        && value["rows"]
            .as_u64()
            .is_some_and(|n| (2..=200).contains(&n))
        && value["cursorX"].as_u64().is_some_and(|n| n <= cols)
        && value["viewport"].as_u64().is_some_and(|n| n <= retained)
        && matches!(value["buffer"].as_str(), Some("normal" | "alternate"))
        && value["data"]
            .as_str()
            .is_some_and(|s| s.len() <= 8 * 1024 * 1024);
    if valid {
        Ok(())
    } else {
        Err("Invalid terminal frame identity or version contract".into())
    }
}
#[derive(Default, serde::Serialize)]
pub(super) struct StageDuration {
    pub count: u64,
    pub sum_ns: u64,
    pub max_ns: u64,
    pub errors: u64,
}
impl StageDuration {
    pub(super) fn record(&mut self, nanos: u64, error: bool, overflow: &mut bool) {
        stage_add(&mut self.count, 1, overflow);
        stage_add(&mut self.sum_ns, nanos, overflow);
        self.max_ns = self.max_ns.max(nanos);
        stage_add(&mut self.errors, u64::from(error), overflow);
    }
    pub(super) fn finish(&mut self, started: Instant, error: bool, overflow: &mut bool) {
        let nanos = started.elapsed().as_nanos();
        *overflow |= nanos > u64::MAX as u128;
        self.record(nanos.min(u64::MAX as u128) as u64, error, overflow);
    }
}
pub(super) fn stage_add(value: &mut u64, amount: u64, overflow: &mut bool) {
    let (sum, exceeded) = value.overflowing_add(amount);
    *value = if exceeded { u64::MAX } else { sum };
    *overflow |= exceeded;
}
// Fixed outcome order is shared with the isolated fixture's strict numeric schema.
#[derive(Clone, Copy)]
enum StageOutcome {
    Accepted,
    SerialPoison,
    Unavailable,
    Arguments,
    Encode,
    FrameBudget,
    Enqueue,
    Reply,
    Service,
    Snapshot,
}
#[derive(Default, serde::Serialize)]
pub(super) struct CallStages {
    pub serial: StageDuration,
    pub reply: StageDuration,
    pub replies: [u64; 3],
    pub outcomes: [u64; 10],
    pub overflow: bool,
}
pub(super) struct Runtime {
    child: Arc<Mutex<Child>>,
    requests: mpsc::SyncSender<Vec<u8>>,
    replies: Mutex<mpsc::Receiver<Result<Value, String>>>,
    serial: Mutex<()>,
    failed: Arc<AtomicBool>,
    next: AtomicU64,
    instance: String,
}
impl Runtime {
    pub(super) fn instance(&self) -> &str {
        &self.instance
    }
    pub(super) fn process_id(&self) -> Result<u32, String> {
        Ok(self
            .child
            .lock()
            .map_err(|_| "Terminal process lock poisoned")?
            .id())
    }
    pub(super) fn start(
        executable: &Path,
        input: impl Fn(String, String) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        let instance = super::agent_bridge::credential()?;
        let mut child = service_command(executable)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("NODE_SEA_OPTIONS")
            .env("YAM_TERMINAL_INSTANCE", &instance)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot start bundled terminal parser")?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Terminal input pipe unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Terminal output pipe unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let failed = Arc::new(AtomicBool::new(false));
        let (requests, receive) = mpsc::sync_channel::<Vec<u8>>(2);
        let (send, replies) = mpsc::sync_channel(2);
        let reader_failed = failed.clone();
        let reader_child = child.clone();
        let expected = instance.clone();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let result = (|| -> Result<(), String> {
                loop {
                    let mut bytes = Vec::new();
                    let count = reader
                        .by_ref()
                        .take(64 * 1024 * 1024 + 1)
                        .read_until(b'\n', &mut bytes)
                        .map_err(|_| "Terminal parser pipe failed")?;
                    if count == 0 {
                        return Err("Terminal parser exited; its live state cannot be reconstructed from logs".into());
                    }
                    if count > 64 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
                        return Err("Terminal parser response exceeds frame budget".into());
                    }
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid terminal parser response")?;
                    if value["type"] == "input" {
                        if value["instance"] != expected {
                            return Err("Terminal input instance mismatch".into());
                        }
                        let session = value["session"]
                            .as_str()
                            .filter(|s| {
                                !s.is_empty()
                                    && s.len() <= 128
                                    && s.bytes().all(|c| {
                                        c.is_ascii_alphanumeric() || c == b'-' || c == b'_'
                                    })
                            })
                            .ok_or("Invalid terminal input identity")?;
                        let data = value["data"]
                            .as_str()
                            .filter(|s| s.len() <= 8192)
                            .ok_or("Terminal query reply exceeds budget")?;
                        input(session.into(), data.into())?;
                    } else if send.send(Ok(value)).is_err() {
                        return Ok(());
                    }
                }
            })();
            if let Err(error) = result {
                reader_failed.store(true, Ordering::Release);
                if let Ok(mut child) = reader_child.lock() {
                    let _ = child.kill();
                }
                let _ = send.try_send(Err(error));
            }
        });
        std::thread::spawn(move || {
            for bytes in receive {
                if stdin.write_all(&bytes).is_err() {
                    break;
                }
            }
        });
        let runtime = Self {
            child,
            requests,
            replies: Mutex::new(replies),
            serial: Mutex::new(()),
            failed,
            next: AtomicU64::new(1),
            instance,
        };
        let ready = runtime.receive()?;
        if ready["type"] != "ready"
            || ready["version"] != 1
            || ready["instance"] != runtime.instance
            || ready["terminal_version"] != "6.0.0"
            || ready["serialize_version"] != "0.14.0"
        {
            return Err("Bundled terminal parser version mismatch".into());
        }
        Ok(runtime)
    }
    fn receive(&self) -> Result<Value, String> {
        let result = self
            .replies
            .lock()
            .map_err(|_| "Terminal response lock poisoned")?
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Terminal parser did not respond within its deadline")?;
        result
    }
    pub(super) fn call(&self, op: &str, session: &str, fields: Value) -> Result<Value, String> {
        self.call_observed(op, session, fields, None)
    }
    pub(super) fn call_observed(
        &self,
        op: &str,
        session: &str,
        fields: Value,
        mut stages: Option<&mut CallStages>,
    ) -> Result<Value, String> {
        let mut outcome = StageOutcome::Accepted;
        let result = (|| {
            let started = stages.as_ref().map(|_| Instant::now());
            let serial = self.serial.lock();
            if let (Some(row), Some(started)) = (stages.as_deref_mut(), started) {
                row.serial
                    .finish(started, serial.is_err(), &mut row.overflow);
            }
            let _serial = serial.map_err(|_| {
                outcome = StageOutcome::SerialPoison;
                "Terminal request lock poisoned"
            })?;
            if self.failed.load(Ordering::Acquire) {
                outcome = StageOutcome::Unavailable;
                return Err(
                    "Terminal parser unavailable; stop affected tasks before restarting it".into(),
                );
            }
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            let mut request = fields.as_object().cloned().ok_or_else(|| {
                outcome = StageOutcome::Arguments;
                "Invalid terminal arguments"
            })?;
            request.insert("op".into(), op.into());
            request.insert("session".into(), session.into());
            request.insert("id".into(), id.into());
            let mut bytes = serde_json::to_vec(&request).map_err(|_| {
                outcome = StageOutcome::Encode;
                "Cannot encode terminal request"
            })?;
            if bytes.len() > 1024 * 1024 {
                outcome = StageOutcome::FrameBudget;
                return Err("Terminal request exceeds frame budget".into());
            }
            bytes.push(b'\n');
            let enqueued = self.requests.try_send(bytes);
            // No ACK interval exists until a request has actually entered the channel.
            let started = if enqueued.is_ok() {
                stages.as_ref().map(|_| Instant::now())
            } else {
                None
            };
            let enqueued_ok = enqueued.is_ok();
            let result = enqueued
                .map_err(|_| "Terminal input pipe unavailable".to_string())
                .and_then(|_| self.receive());
            if let (Some(row), Some(started)) = (stages.as_deref_mut(), started) {
                let kind = match &result {
                    Ok(reply) if reply["id"] == id => usize::from(reply["ok"] != true),
                    _ => 2,
                };
                row.reply.finish(started, kind != 0, &mut row.overflow);
                stage_add(&mut row.replies[kind], 1, &mut row.overflow);
            }
            let response = match result {
                Ok(response) if response["id"] == id => response,
                _ => {
                    outcome = if enqueued_ok {
                        StageOutcome::Reply
                    } else {
                        StageOutcome::Enqueue
                    };
                    self.failed.store(true, Ordering::Release);
                    if let Ok(mut child) = self.child.lock() {
                        let _ = child.kill();
                    }
                    return Err(
                        "Terminal parser lost its response; full live state is unavailable".into(),
                    );
                }
            };
            if response["ok"] != true {
                outcome = StageOutcome::Service;
                return Err(response["error"]
                    .as_str()
                    .unwrap_or("Terminal request failed")
                    .into());
            }
            if matches!(op, "snapshot" | "stream_snapshot")
                && (response["data"]["instance"] != self.instance
                    || response["data"]["session"] != session)
            {
                outcome = StageOutcome::Snapshot;
                self.failed.store(true, Ordering::Release);
                return Err("Terminal snapshot identity mismatch".into());
            }
            if matches!(op, "snapshot" | "stream_snapshot") {
                validate_snapshot(&response["data"], session, Some(&self.instance)).inspect_err(
                    |_| {
                        outcome = StageOutcome::Snapshot;
                    },
                )?;
            }
            Ok(response["data"].clone())
        })();
        if let Some(row) = stages {
            stage_add(&mut row.outcomes[outcome as usize], 1, &mut row.overflow);
        }
        result
    }
    pub(super) fn stop(&self) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub(super) fn output(&self, session: &str, bytes: &[u8]) -> Result<(), String> {
        self.output_observed(session, bytes, None)
    }
    pub(super) fn output_observed(
        &self,
        session: &str,
        bytes: &[u8],
        stages: Option<&mut CallStages>,
    ) -> Result<(), String> {
        self.call_observed(
            "write",
            session,
            serde_json::json!({"data":base64(bytes)}),
            stages,
        )
        .map(|_| ())
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #[cfg(windows)]
    #[test]
    fn service_children_do_not_allocate_a_console_window() {
        let output = super::service_command(&std::env::current_exe().unwrap())
            .args([
                "--exact",
                "terminal_runtime::tests::service_console_probe",
                "--ignored",
                "--nocapture",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("YAM_NO_CONSOLE_OK"));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Invoked by the service process creation test in an isolated child"]
    fn service_console_probe() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> std::os::windows::io::RawHandle;
        }
        assert!(
            unsafe { GetConsoleWindow() }.is_null(),
            "service child allocated a console"
        );
        println!("YAM_NO_CONSOLE_OK");
    }

    use super::*;
    // Author: Jeff.Liu. Owned fake-service fixture, never a packaged owner.
    #[cfg(unix)]
    pub(crate) struct StageFixture {
        pub runtime: Arc<Runtime>,
        path: std::path::PathBuf,
    }
    #[cfg(unix)]
    impl Drop for StageFixture {
        fn drop(&mut self) {
            self.runtime.stop();
            let _ = std::fs::remove_file(&self.path);
        }
    }
    #[cfg(unix)]
    pub(crate) fn stage_fixture(refuse_write: bool) -> StageFixture {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "yam-output-stage-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/terminal-runtime/node");
        create_stage_fixture(path, &node, refuse_write)
            .unwrap_or_else(|error| panic!("fake service setup: {error}"))
    }
    #[cfg(unix)]
    fn create_stage_fixture(
        path: std::path::PathBuf,
        node: &Path,
        refuse_write: bool,
    ) -> Result<StageFixture, String> {
        use std::os::unix::fs::OpenOptionsExt;
        let script = r#"
const readline=require('node:readline');const emit=x=>console.log(JSON.stringify(x));const instance=process.env.YAM_TERMINAL_INSTANCE;
emit({type:'ready',version:1,instance,terminal_version:'6.0.0',serialize_version:'0.14.0'});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.op==='exit'){process.exit(0);return;}
if(r.op==='wrong'){emit({id:r.id+1,ok:true,data:null});return;}
if(r.op==='error'||(refuseWrite&&r.op==='write')){emit({id:r.id,ok:false,error:'safe fixture refusal'});return;}
if(r.op==='snapshot'){emit({id:r.id,ok:true,data:{instance:'wrong',session:r.session}});return;}
emit({id:r.id,ok:true,data:null});});
"#;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let content = format!(
            "#!{}\nconst refuseWrite={};\n{}",
            node.display(),
            refuse_write,
            script
        );
        if let Err(error) = file.write_all(content.as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
        drop(file);
        let runtime = match Runtime::start(&path, |_, _| Ok(())) {
            Ok(runtime) => Arc::new(runtime),
            Err(error) => {
                let _ = std::fs::remove_file(&path);
                return Err(error);
            }
        };
        Ok(StageFixture { runtime, path })
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_fixture_collision_preserves_file_and_failed_setup_cleans_owned_file() {
        use std::os::unix::fs::PermissionsExt;
        struct OwnedDirectory(std::path::PathBuf);
        impl Drop for OwnedDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory =
            std::env::temp_dir().join(format!("yam-stage-collision-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let root = OwnedDirectory(directory);
        let path = root.0.join("service");
        std::fs::write(&path, b"sentinel").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let node = root.0.join("missing-node");
        assert!(create_stage_fixture(path.clone(), &node, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"sentinel");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = root.0.join("linked-service");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(create_stage_fixture(link.clone(), &node, false).is_err());
        assert!(std::fs::symlink_metadata(link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&path).unwrap(), b"sentinel");
        let fresh = root.0.join("new-service");
        assert!(create_stage_fixture(fresh.clone(), &node, false).is_err());
        assert!(!fresh.exists());
    }
    #[test]
    fn output_stage_duration_zero_error_and_saturation_are_explicit() {
        let mut value = StageDuration::default();
        let mut overflow = false;
        value.record(5, false, &mut overflow);
        value.record(9, true, &mut overflow);
        assert_eq!(
            (value.count, value.sum_ns, value.max_ns, value.errors),
            (2, 14, 9, 1)
        );
        assert!(!overflow);
        value.sum_ns = u64::MAX;
        value.record(1, false, &mut overflow);
        assert_eq!(value.sum_ns, u64::MAX);
        assert!(overflow);
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_runtime_success_service_error_and_pre_enqueue_failures() {
        let fixture = stage_fixture(false);
        let runtime = &fixture.runtime;
        let mut observed = CallStages::default();
        runtime
            .call_observed(
                "write",
                "one",
                serde_json::json!({"data":"eA=="}),
                Some(&mut observed),
            )
            .unwrap();
        assert_eq!(
            runtime
                .call_observed("error", "two", serde_json::json!({}), Some(&mut observed))
                .unwrap_err(),
            "safe fixture refusal"
        );
        assert!(!runtime.failed.load(Ordering::Acquire));
        assert_eq!(
            runtime
                .call_observed("write", "two", Value::Null, Some(&mut observed))
                .unwrap_err(),
            "Invalid terminal arguments"
        );
        assert_eq!(
            runtime
                .call_observed(
                    "write",
                    "two",
                    serde_json::json!({"data":"x".repeat(1024*1024)}),
                    Some(&mut observed)
                )
                .unwrap_err(),
            "Terminal request exceeds frame budget"
        );
        assert_eq!(observed.serial.count, 4);
        assert_eq!(observed.serial.errors, 0);
        assert_eq!(observed.reply.count, 2);
        assert_eq!(observed.replies, [1, 1, 0]);
        assert_eq!(observed.outcomes, [1, 0, 0, 1, 0, 1, 0, 0, 1, 0]);
        runtime
            .call("write", "still-live", serde_json::json!({}))
            .unwrap();
        assert_eq!(
            observed.serial.count, 4,
            "unobserved call must not alter caller-owned counters"
        );
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_runtime_wrong_id_exit_and_snapshot_keep_failure_policy() {
        for op in ["wrong", "exit", "snapshot"] {
            let fixture = stage_fixture(false);
            let runtime = &fixture.runtime;
            let mut observed = CallStages::default();
            assert!(runtime
                .call_observed(op, "one", serde_json::json!({}), Some(&mut observed))
                .is_err());
            assert!(runtime.failed.load(Ordering::Acquire));
            assert_eq!(observed.reply.count, 1);
            assert_eq!(observed.serial.count, 1);
            if matches!(op, "snapshot" | "stream_snapshot") {
                assert_eq!(observed.replies, [1, 0, 0]);
                assert_eq!(observed.outcomes[9], 1);
            } else {
                assert_eq!(observed.replies, [0, 0, 1]);
                assert_eq!(observed.outcomes[7], 1);
            }
            assert!(runtime
                .call_observed("write", "one", serde_json::json!({}), Some(&mut observed))
                .is_err());
            assert_eq!(observed.outcomes[2], 1);
            assert_eq!(observed.reply.count, 1);
        }
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_runtime_enqueue_failure_has_no_ack_and_preserves_kill() {
        for disconnected in [false, true] {
            let mut fixture = stage_fixture(false);
            let (sender, receiver) = mpsc::sync_channel(0);
            let old = std::mem::replace(
                &mut Arc::get_mut(&mut fixture.runtime).unwrap().requests,
                sender,
            );
            let _receiver = if disconnected {
                drop(receiver);
                None
            } else {
                Some(receiver)
            };
            let mut observed = CallStages::default();
            assert_eq!(
                fixture
                    .runtime
                    .call_observed("write", "one", serde_json::json!({}), Some(&mut observed))
                    .unwrap_err(),
                "Terminal parser lost its response; full live state is unavailable"
            );
            assert!(fixture.runtime.failed.load(Ordering::Acquire));
            assert_eq!(observed.serial.count, 1);
            assert_eq!(observed.reply.count, 0);
            assert_eq!(observed.outcomes[6], 1);
            drop(old);
        }
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_runtime_shared_serial_is_retained_between_sessions() {
        let fixture = stage_fixture(false);
        let runtime = fixture.runtime.clone();
        let held = runtime.serial.lock().unwrap();
        let (started, entered) = mpsc::channel();
        let (sent, received) = mpsc::channel();
        std::thread::scope(|scope| {
            let runtime = &runtime;
            scope.spawn(move || {
                started.send(()).unwrap();
                let mut stages = CallStages::default();
                let result = runtime.call_observed(
                    "write",
                    "second-session",
                    serde_json::json!({}),
                    Some(&mut stages),
                );
                sent.send((result, stages)).unwrap();
            });
            entered.recv().unwrap();
            assert_eq!(runtime.next.load(Ordering::Relaxed), 1);
            assert!(received.try_recv().is_err());
            drop(held);
            let (result, stages) = received.recv_timeout(Duration::from_secs(5)).unwrap();
            result.unwrap();
            assert_eq!(stages.serial.count, 1);
            assert_eq!(stages.reply.count, 1);
            assert_eq!(stages.outcomes[0], 1);
        });
    }
    #[cfg(unix)]
    #[test]
    fn output_stage_actual_runtime_poison_records_attempt_without_reply() {
        let fixture = stage_fixture(false);
        let runtime = &fixture.runtime;
        std::thread::scope(|scope| {
            let thread = scope.spawn(|| {
                let _guard = runtime.serial.lock().unwrap();
                panic!("intentional serial poison");
            });
            assert!(thread.join().is_err());
        });
        let mut observed = CallStages::default();
        assert_eq!(
            runtime
                .call_observed("write", "one", serde_json::json!({}), Some(&mut observed))
                .unwrap_err(),
            "Terminal request lock poisoned"
        );
        assert_eq!(observed.serial.count, 1);
        assert_eq!(observed.serial.errors, 1);
        assert_eq!(observed.reply.count, 0);
        assert_eq!(observed.outcomes[1], 1);
        assert!(!runtime.failed.load(Ordering::Acquire));
    }

    #[test]
    fn a05a3_frame_capacity_rejects_present_bad_and_bounds_viewport() {
        let mut f = serde_json::json!({"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"","cols":20,"rows":8,"cursorX":0,"viewport":0,"buffer":"normal"});
        assert!(validate_snapshot(&f, "s-one", None).is_ok());
        for bad in [
            serde_json::json!(null),
            serde_json::json!(199),
            serde_json::json!(2001),
            serde_json::json!(1.5),
            serde_json::json!("500"),
        ] {
            f["retained_lines"] = bad;
            assert!(validate_snapshot(&f, "s-one", None).is_err());
        }
        for lines in [200, 500, 2000] {
            f["retained_lines"] = serde_json::json!(lines);
            f["viewport"] = serde_json::json!(lines);
            assert!(validate_snapshot(&f, "s-one", None).is_ok());
            f["viewport"] = serde_json::json!(lines + 1);
            assert!(validate_snapshot(&f, "s-one", None).is_err());
        }
    }
    #[test]
    fn saved_frames_validate_identity_versions_dimensions_and_pending_wrap_cursor() {
        let good = serde_json::json!({"version":1,"instance":"a".repeat(64),"session":"s-one","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":2,"data":"\u{1b}[31m中","cols":20,"rows":8,"cursorX":20,"viewport":0,"buffer":"normal"});
        assert!(validate_snapshot(&good, "s-one", None).is_ok());
        assert!(validate_snapshot(&good, "s-other", None).is_err());
        assert!(validate_snapshot(&good, "s-one", Some(&"b".repeat(64))).is_err());
        for (key, value) in [
            ("version", serde_json::json!(2)),
            ("terminal_version", serde_json::json!("6.1.0")),
            ("cols", serde_json::json!(0)),
            ("cursorX", serde_json::json!(21)),
            ("viewport", serde_json::json!(2001)),
            ("buffer", serde_json::json!("unknown")),
            ("data", serde_json::json!(null)),
        ] {
            let mut invalid = good.clone();
            invalid[key] = value;
            assert!(validate_snapshot(&invalid, "s-one", None).is_err(), "{key}");
        }
    }
    #[test]
    fn encoding_preserves_every_byte_and_padding_boundary() {
        for (input, expected) in [
            (b"".as_slice(), ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (&[0, 255, 128], "AP+A"),
        ] {
            assert_eq!(base64(input), expected);
        }
    }
    #[cfg(unix)]
    #[test]
    fn a05a3_actual_runtime_old_strict_refusal_preserves_existing_parser() {
        use std::os::unix::fs::PermissionsExt;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "yam-retention-runtime-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let node =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/terminal-runtime/node");
        let script = r#"
const readline=require('node:readline');const sessions=new Set();const instance=process.env.YAM_TERMINAL_INSTANCE;
const emit=value=>console.log(JSON.stringify(value));emit({type:'ready',version:1,instance,terminal_version:'6.0.0',serialize_version:'0.14.0'});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.op==='create'&&Object.hasOwn(r,'retained_lines')){emit({id:r.id,ok:false,error:'Invalid terminal request'});return;}if(r.op==='create'){sessions.add(r.session);emit({id:r.id,ok:true,data:null});return;}if(r.op==='snapshot'&&sessions.has(r.session)){emit({id:r.id,ok:true,data:{version:1,instance,session:r.session,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:0,data:'original',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'}});return;}emit({id:r.id,ok:false,error:'Unknown terminal'});});
"#;
        std::fs::write(&path, format!("#!{}\n{}", node.display(), script)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = Runtime::start(&path, |_, _| Ok(())).unwrap();
        runtime
            .call(
                "create",
                "existing",
                serde_json::json!({"cols":20,"rows":8}),
            )
            .unwrap();
        let original = runtime
            .call("snapshot", "existing", serde_json::json!({}))
            .unwrap();
        assert!(runtime
            .call("create", "new", crate::terminal_create_arguments(500))
            .is_err());
        assert!(!runtime.failed.load(Ordering::Acquire));
        assert_eq!(
            runtime
                .call("snapshot", "existing", serde_json::json!({}))
                .unwrap(),
            original
        );
        runtime
            .call("create", "default", crate::terminal_create_arguments(2000))
            .unwrap();
        runtime.stop();
        assert!(runtime.child.lock().unwrap().try_wait().unwrap().is_some());
        drop(runtime);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn real_packaged_parser_keeps_pending_bytes_queries_and_alternate_screen() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/terminal-runtime");
        let executable = directory.join(if cfg!(windows) {
            "yam-terminal.exe"
        } else {
            "yam-terminal"
        });
        let (send, receive) = std::sync::mpsc::channel();
        let runtime = Runtime::start(&executable, move |session, data| {
            send.send((session, data))
                .map_err(|_| "Query consumer closed".into())
        })
        .unwrap();
        runtime
            .call("create", "s-one", serde_json::json!({"cols":20,"rows":8}))
            .unwrap();
        runtime
            .call(
                "write",
                "s-one",
                serde_json::json!({"data":base64(&[0xe4,0xb8])}),
            )
            .unwrap();
        assert!(!runtime
            .call("snapshot", "s-one", serde_json::json!({}))
            .unwrap()["data"]
            .as_str()
            .unwrap()
            .contains('�'));
        runtime
            .call(
                "write",
                "s-one",
                serde_json::json!({"data":base64(&[0xad])}),
            )
            .unwrap();
        runtime
            .call(
                "write",
                "s-one",
                serde_json::json!({"data":base64(b"\x1b[?1049hALT\x1b[6n")}),
            )
            .unwrap();
        let frame = runtime
            .call("snapshot", "s-one", serde_json::json!({}))
            .unwrap();
        assert_eq!(frame["buffer"], "alternate");
        assert!(frame["data"].as_str().unwrap().contains("ALT"));
        let query = receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(query.0, "s-one");
        assert!(query.1.ends_with('R'));
        assert!(runtime
            .call("resize", "s-one", serde_json::json!({"cols":0,"rows":8}))
            .is_err());
        assert_eq!(
            runtime
                .call("snapshot", "s-one", serde_json::json!({}))
                .unwrap()["cols"],
            20
        );
        runtime.child.lock().unwrap().kill().unwrap();
        assert!(runtime
            .call("snapshot", "s-one", serde_json::json!({}))
            .is_err());
        assert!(runtime
            .call("snapshot", "s-one", serde_json::json!({}))
            .is_err());
    }
}
