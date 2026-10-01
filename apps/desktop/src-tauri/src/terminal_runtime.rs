// Author: Jeff.Liu. The background owns the persistent parser over private pipes.
use serde_json::Value;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
fn base64(bytes: &[u8]) -> String {
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
        && value["viewport"].as_u64().is_some_and(|n| n <= 2000)
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
    pub(super) fn start(
        executable: &Path,
        input: impl Fn(String, String) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        let instance = super::agent_bridge::credential()?;
        let mut child = Command::new(executable)
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
        let _serial = self
            .serial
            .lock()
            .map_err(|_| "Terminal request lock poisoned")?;
        if self.failed.load(Ordering::Acquire) {
            return Err(
                "Terminal parser unavailable; stop affected tasks before restarting it".into(),
            );
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut request = fields
            .as_object()
            .cloned()
            .ok_or("Invalid terminal arguments")?;
        request.insert("op".into(), op.into());
        request.insert("session".into(), session.into());
        request.insert("id".into(), id.into());
        let mut bytes =
            serde_json::to_vec(&request).map_err(|_| "Cannot encode terminal request")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Terminal request exceeds frame budget".into());
        }
        bytes.push(b'\n');
        let result = self
            .requests
            .try_send(bytes)
            .map_err(|_| "Terminal input pipe unavailable".to_string())
            .and_then(|_| self.receive());
        let response = match result {
            Ok(response) if response["id"] == id => response,
            _ => {
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
            return Err(response["error"]
                .as_str()
                .unwrap_or("Terminal request failed")
                .into());
        }
        if op == "snapshot"
            && (response["data"]["instance"] != self.instance
                || response["data"]["session"] != session)
        {
            self.failed.store(true, Ordering::Release);
            return Err("Terminal snapshot identity mismatch".into());
        }
        if op == "snapshot" {
            validate_snapshot(&response["data"], session, Some(&self.instance))?;
        }
        Ok(response["data"].clone())
    }
    pub(super) fn stop(&self) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub(super) fn output(&self, session: &str, bytes: &[u8]) -> Result<(), String> {
        self.call("write", session, serde_json::json!({"data":base64(bytes)}))
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
mod tests {
    use super::*;
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
