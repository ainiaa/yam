// Author: Jeff.Liu. Explicit GUI gateway queries; no background terminal work.
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BODY_LIMIT: usize = 1024 * 1024;
const STDERR_LIMIT: usize = 8192;
const QUERY_BUDGET: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize)]
pub(crate) struct IdentityReply {
    query_token: String,
    status: &'static str,
    http_status: Option<u16>,
    version: Option<String>,
}

impl IdentityReply {
    fn new(token: &str, status: &'static str) -> Self {
        Self {
            query_token: token.into(),
            status,
            http_status: None,
            version: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogReply {
    query_token: String,
    status: &'static str,
    http_status: Option<u16>,
    models: Vec<CatalogModel>,
}
#[derive(Debug, Serialize)]
struct CatalogModel {
    id: String,
    display_name: Option<String>,
    owned_by: Option<String>,
}
impl CatalogReply {
    fn new(token: &str, status: &'static str) -> Self {
        Self {
            query_token: token.into(),
            status,
            http_status: None,
            models: Vec::new(),
        }
    }
}

fn parse_models(bytes: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid_response")?;
    if value.get("object").and_then(serde_json::Value::as_str) != Some("list") {
        return Err("invalid_response");
    }
    match value.get("has_more").and_then(serde_json::Value::as_bool) {
        Some(false) => {}
        Some(true) => return Err("pagination_unsupported"),
        None => return Err("invalid_response"),
    }
    let items = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or("invalid_response")?;
    if items.len() > 1000 {
        return Err("response_too_large");
    }
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or("invalid_response")?;
        if id.is_empty()
            || id.len() > 256
            || id.chars().any(|c| c.is_whitespace() || c.is_control())
            || !seen.insert(id)
        {
            return Err("invalid_response");
        }
        let label = |name| -> Result<Option<String>, &'static str> {
            match item.get(name) {
                None | Some(serde_json::Value::Null) => Ok(None),
                Some(serde_json::Value::String(text))
                    if text.len() <= 256 && !text.chars().any(char::is_control) =>
                {
                    Ok(Some(text.clone()))
                }
                _ => Err("invalid_response"),
            }
        };
        models.push(CatalogModel {
            id: id.into(),
            display_name: label("display_name")?,
            owned_by: label("owned_by")?,
        });
    }
    Ok(models)
}

fn load_models(
    endpoint: &str,
    key_env: Option<&str>,
    token: &str,
    cancel: &AtomicBool,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> CatalogReply {
    let deadline = Instant::now() + QUERY_BUDGET;
    if cancel.load(Ordering::Acquire) {
        return CatalogReply::new(token, "cancelled");
    }
    let Some(mut url) = identity_url(endpoint) else {
        return CatalogReply::new(token, "unsupported");
    };
    url.set_path("/v1/models");
    let key = match credential(key_env, lookup) {
        Ok(key) => key,
        Err(reason) => return CatalogReply::new(token, reason),
    };
    let (code, bytes) = match fetch(&url, key, cancel, deadline) {
        Ok(value) => value,
        Err(reason) => return CatalogReply::new(token, reason),
    };
    let mut reply = CatalogReply::new(token, "invalid_response");
    reply.http_status = Some(code);
    if !(200..300).contains(&code) {
        reply.status = if [401, 403].contains(&code) {
            "authentication_refused"
        } else if (300..400).contains(&code) {
            "redirect_refused"
        } else {
            "http_error"
        };
        return reply;
    }
    match parse_models(&bytes) {
        Ok(models) => {
            reply.models = models;
            reply.status = "loaded";
        }
        Err(reason) => reply.status = reason,
    }
    reply
}

#[derive(Default)]
struct WindowQuery {
    active: Option<(String, Arc<AtomicBool>)>,
    cancelled: VecDeque<String>,
}

#[derive(Clone, Default)]
pub(crate) struct Requests(Arc<Mutex<HashMap<String, WindowQuery>>>);

impl Requests {
    fn begin(&self, window: &str, token: &str) -> Result<Arc<AtomicBool>, &'static str> {
        let mut entries = self.0.lock().map_err(|_| "unavailable")?;
        let entry = entries.entry(window.into()).or_default();
        if entry.cancelled.iter().any(|item| item == token) {
            return Err("cancelled");
        }
        if entry.active.is_some() {
            return Err("busy");
        }
        let flag = Arc::new(AtomicBool::new(false));
        entry.active = Some((token.into(), flag.clone()));
        Ok(flag)
    }
    fn cancel(&self, window: &str, token: &str) {
        if let Ok(mut entries) = self.0.lock() {
            let entry = entries.entry(window.into()).or_default();
            if let Some((active, flag)) = &entry.active {
                if active == token {
                    flag.store(true, Ordering::Release);
                }
            }
            // A close can arrive before its async query is admitted.
            if !entry.cancelled.iter().any(|item| item == token) {
                entry.cancelled.push_back(token.into());
                if entry.cancelled.len() > 16 {
                    entry.cancelled.pop_front();
                }
            }
        }
    }
    fn finish(&self, window: &str, token: &str) -> bool {
        if let Ok(mut entries) = self.0.lock() {
            if let Some(entry) = entries.get_mut(window) {
                if entry
                    .active
                    .as_ref()
                    .is_some_and(|(active, _)| active == token)
                {
                    let cancelled = entry.active.as_ref().unwrap().1.load(Ordering::Acquire);
                    entry.active = None;
                    return cancelled;
                }
            }
        }
        false
    }
}

fn valid_token(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn identity_url(endpoint: &str) -> Option<tauri::Url> {
    crate::provider_probe::targets(endpoint)?;
    let authority = endpoint.split_once("://")?.1;
    let path = authority.find('/').map(|i| &authority[i..]).unwrap_or("");
    if !matches!(path, "" | "/" | "/v1" | "/v1/") {
        return None;
    }
    let mut url = tauri::Url::parse(endpoint).ok()?;
    url.set_path("/api/hello");
    Some(url)
}

fn credential(
    name: Option<&str>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<String>, &'static str> {
    let Some(name) = name else {
        return Ok(None);
    };
    if !crate::project_config::variable(name) || crate::project_config::reserved(name) {
        return Err("credential_unavailable");
    }
    let value = lookup(name).filter(|value| {
        !value.trim().is_empty() && value.len() <= 16384 && !value.chars().any(char::is_control)
    });
    value.map(Some).ok_or("credential_unavailable")
}

fn curl_command(url: &tauri::Url, remaining: Duration) -> Command {
    let mut command = Command::new("/usr/bin/curl");
    command.env_clear().args([
        "--disable",
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--proxy",
        "",
        "--proto",
        "=http,https",
        "--max-time",
        &format!("{:.3}", remaining.as_secs_f64()),
        "--max-filesize",
        &BODY_LIMIT.to_string(),
        "--request",
        "GET",
        "--config",
        "-",
        "--user-agent",
        "YAM/0.1.0",
        "--write-out",
        "\n%{http_code}",
    ]);
    if url.host_str() == Some("localhost") {
        command.args([
            "--resolve",
            &format!(
                "localhost:{}:127.0.0.1,[::1]",
                url.port_or_known_default().unwrap_or(0)
            ),
        ]);
    }
    command
        .args(["--url", url.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn bounded_read(
    mut pipe: impl Read,
    limit: usize,
    overflow: &AtomicBool,
) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    pipe.by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "unavailable")?;
    if bytes.len() > limit {
        overflow.store(true, Ordering::Release);
        return Err("response_too_large");
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn fetch(
    url: &tauri::Url,
    key: Option<String>,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(u16, Vec<u8>), &'static str> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("timed_out");
    }
    fetch_command(curl_command(url, remaining), key, cancel, deadline)
}

#[cfg(target_os = "macos")]
fn fetch_command(
    mut command: Command,
    key: Option<String>,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(u16, Vec<u8>), &'static str> {
    let mut child = command.spawn().map_err(|_| "transport_unavailable")?;
    let stdout = child.stdout.take().ok_or("unavailable")?;
    let stderr = child.stderr.take().ok_or("unavailable")?;
    let mut stdin = child.stdin.take().ok_or("unavailable")?;
    let config = key
        .map(|value| {
            format!(
                "header = \"Authorization: Bearer {}\"\n",
                value.replace('\\', "\\\\").replace('"', "\\\"")
            )
        })
        .unwrap_or_default();
    let writer = std::thread::spawn(move || stdin.write_all(config.as_bytes()));
    let overflow = Arc::new(AtomicBool::new(false));
    let output_overflow = overflow.clone();
    let output = std::thread::spawn(move || bounded_read(stdout, BODY_LIMIT + 4, &output_overflow));
    let error_overflow = overflow.clone();
    let errors = std::thread::spawn(move || bounded_read(stderr, STDERR_LIMIT, &error_overflow));
    let completion = loop {
        let failure = if cancel.load(Ordering::Acquire) {
            Some("cancelled")
        } else if Instant::now() >= deadline {
            Some("timed_out")
        } else if overflow.load(Ordering::Acquire) {
            Some("response_too_large")
        } else {
            None
        };
        if let Some(reason) = failure {
            let _ = child.kill();
            let _ = child.wait();
            break Err(reason);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            ),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("unavailable");
            }
        }
    };
    let written = writer.join();
    let bytes = join_readers(output, errors);
    let status = completion?;
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled");
    }
    if Instant::now() >= deadline {
        return Err("timed_out");
    }
    if !status.success() {
        return Err(match status.code() {
            Some(28) => "timed_out",
            Some(63) => "response_too_large",
            Some(60) => "tls_error",
            Some(6 | 7) => "unreachable",
            _ => "unavailable",
        });
    }
    if !matches!(written, Ok(Ok(()))) {
        return Err("unavailable");
    }
    let bytes = bytes?;
    if bytes.len() < 4 || bytes[bytes.len() - 4] != b'\n' {
        return Err("invalid_response");
    }
    let code = std::str::from_utf8(&bytes[bytes.len() - 3..])
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|code| (100..=599).contains(code))
        .ok_or("invalid_response")?;
    Ok((code, bytes[..bytes.len() - 4].to_vec()))
}

#[cfg(target_os = "macos")]
fn join_readers(
    output: std::thread::JoinHandle<Result<Vec<u8>, &'static str>>,
    errors: std::thread::JoinHandle<Result<Vec<u8>, &'static str>>,
) -> Result<Vec<u8>, &'static str> {
    let output = output.join();
    let errors = errors.join();
    let bytes = output.map_err(|_| "unavailable")?;
    let _ = errors.map_err(|_| "unavailable")??;
    bytes
}

#[cfg(not(target_os = "macos"))]
fn fetch(
    _url: &tauri::Url,
    _key: Option<String>,
    _cancel: &AtomicBool,
    _deadline: Instant,
) -> Result<(u16, Vec<u8>), &'static str> {
    Err("transport_unavailable")
}

fn check_identity(
    endpoint: &str,
    key_env: Option<&str>,
    token: &str,
    cancel: &AtomicBool,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> IdentityReply {
    let deadline = Instant::now() + QUERY_BUDGET;
    if cancel.load(Ordering::Acquire) {
        return IdentityReply::new(token, "cancelled");
    }
    let Some(url) = identity_url(endpoint) else {
        return IdentityReply::new(token, "unsupported");
    };
    let key = match credential(key_env, lookup) {
        Ok(key) => key,
        Err(reason) => return IdentityReply::new(token, reason),
    };
    let (code, bytes) = match fetch(&url, key, cancel, deadline) {
        Ok(value) => value,
        Err(reason) => return IdentityReply::new(token, reason),
    };
    let mut reply = IdentityReply::new(token, "invalid_response");
    reply.http_status = Some(code);
    if !(200..300).contains(&code) {
        reply.status = if [401, 403].contains(&code) {
            "authentication_refused"
        } else if (300..400).contains(&code) {
            "redirect_refused"
        } else {
            "http_error"
        };
        return reply;
    }
    let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value,
        Err(_) => return reply,
    };
    if value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|name| name != "magpie")
    {
        reply.status = "unrecognized";
        return reply;
    }
    let Some(version) = value.get("version").and_then(serde_json::Value::as_str) else {
        return reply;
    };
    if value.get("name").and_then(serde_json::Value::as_str) != Some("magpie")
        || version.is_empty()
        || version.len() > 128
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+_-".contains(&b))
    {
        return reply;
    }
    reply.status = "identified";
    reply.version = Some(version.into());
    reply
}

#[tauri::command]
pub(crate) async fn check_provider_gateway(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    endpoint: String,
    api_key_env: Option<String>,
    query_token: String,
) -> Result<IdentityReply, String> {
    check_provider_gateway_with(
        window.label().to_string(),
        requests.inner().clone(),
        query_token,
        move |token, flag| {
            check_identity(&endpoint, api_key_env.as_deref(), token, flag, &|name| {
                std::env::var(name).ok()
            })
        },
    )
    .await
}

async fn check_provider_gateway_with(
    scope: String,
    requests: Requests,
    query_token: String,
    worker: impl FnOnce(&str, &AtomicBool) -> IdentityReply + Send + 'static,
) -> Result<IdentityReply, String> {
    if !valid_token(&query_token) {
        return Err("provider_catalog_invalid_request".into());
    }
    let flag = match requests.begin(&scope, &query_token) {
        Ok(flag) => flag,
        Err(reason) => return Ok(IdentityReply::new(&query_token, reason)),
    };
    let token = query_token.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || worker(&token, &flag)).await;
    let cancelled = requests.finish(&scope, &query_token);
    let reply = reply.map_err(|_| "provider_catalog_unavailable".to_string())?;
    Ok(if cancelled {
        IdentityReply::new(&query_token, "cancelled")
    } else {
        reply
    })
}

#[tauri::command]
pub(crate) fn cancel_provider_gateway(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    query_token: String,
) -> Result<(), String> {
    if !valid_token(&query_token) {
        return Err("provider_catalog_invalid_request".into());
    }
    requests.cancel(window.label(), &query_token);
    Ok(())
}

#[tauri::command]
pub(crate) async fn load_provider_models(
    window: tauri::WebviewWindow,
    requests: tauri::State<'_, Requests>,
    endpoint: String,
    api_key_env: Option<String>,
    query_token: String,
) -> Result<CatalogReply, String> {
    load_provider_models_with(
        window.label().to_string(),
        requests.inner().clone(),
        query_token,
        move |token, flag| {
            load_models(&endpoint, api_key_env.as_deref(), token, flag, &|name| {
                std::env::var(name).ok()
            })
        },
    )
    .await
}

async fn load_provider_models_with(
    scope: String,
    requests: Requests,
    query_token: String,
    worker: impl FnOnce(&str, &AtomicBool) -> CatalogReply + Send + 'static,
) -> Result<CatalogReply, String> {
    if !valid_token(&query_token) {
        return Err("provider_catalog_invalid_request".into());
    }
    let flag = match requests.begin(&scope, &query_token) {
        Ok(flag) => flag,
        Err(reason) => return Ok(CatalogReply::new(&query_token, reason)),
    };
    let token = query_token.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || worker(&token, &flag)).await;
    let cancelled = requests.finish(&scope, &query_token);
    let reply = reply.map_err(|_| "provider_catalog_unavailable".to_string())?;
    Ok(if cancelled {
        CatalogReply::new(&query_token, "cancelled")
    } else {
        reply
    })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    const TOKEN: &str = "12345678-1234-4234-8234-123456789abc";

    #[test]
    fn closure_t11_reader_panic_still_joins_the_other_reader() {
        let (release, held) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        let output = std::thread::spawn(|| -> Result<Vec<u8>, &'static str> {
            panic!("owned reader failure")
        });
        let errors = std::thread::spawn(move || {
            held.recv().unwrap();
            Ok(Vec::new())
        });
        let worker = std::thread::spawn(move || {
            done.send(join_readers(output, errors)).unwrap();
        });
        let early = finished.recv_timeout(Duration::from_millis(100));
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(
            early.is_err(),
            "the stderr reader was detached after stdout panicked"
        );
        assert_eq!(
            finished
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap_err(),
            "unavailable"
        );
    }

    #[test]
    fn closure_t11_transport_exit_codes_and_spawn_failures_are_normalized() {
        for (code, expected) in [
            (28, "timed_out"),
            (63, "response_too_large"),
            (60, "tls_error"),
            (6, "unreachable"),
            (7, "unreachable"),
            (1, "unavailable"),
        ] {
            let mut command = Command::new("/bin/sh");
            command
                .env_clear()
                .args(["-c", &format!("/bin/cat >/dev/null; exit {code}")])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            assert_eq!(
                fetch_command(
                    command,
                    Some("private-fixture-key".into()),
                    &AtomicBool::new(false),
                    Instant::now() + QUERY_BUDGET
                )
                .unwrap_err(),
                expected
            );
        }
        let missing =
            std::env::temp_dir().join(format!("yam-missing-curl-{}", crate::next_session_id()));
        assert_eq!(
            fetch_command(
                Command::new(missing),
                None,
                &AtomicBool::new(false),
                Instant::now() + QUERY_BUDGET
            )
            .unwrap_err(),
            "transport_unavailable"
        );
        for (body, expected) in [
            ("", None),
            ("\\n000", None),
            ("\\n600", None),
            ("\\nabc", None),
            ("payload\\n200", Some((200, b"payload".to_vec()))),
        ] {
            let mut command = Command::new("/bin/sh");
            command
                .env_clear()
                .args([
                    "-c",
                    "/bin/cat >/dev/null; printf '%b' \"$1\"",
                    "fixture",
                    body,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let actual = fetch_command(
                command,
                None,
                &AtomicBool::new(false),
                Instant::now() + QUERY_BUDGET,
            );
            if let Some(expected) = expected {
                assert_eq!(actual.unwrap(), expected);
            } else {
                assert_eq!(actual.unwrap_err(), "invalid_response");
            }
        }
    }

    #[test]
    fn closure_t11_commands_release_admission_after_success_panic_and_cancel() {
        tauri::async_runtime::block_on(async {
            let requests = Requests::default();
            assert_eq!(
                check_provider_gateway_with(
                    "main".into(),
                    requests.clone(),
                    "bad".into(),
                    |_, _| panic!("invalid request admitted")
                )
                .await
                .unwrap_err(),
                "provider_catalog_invalid_request"
            );
            let f = Fixture::new("identity");
            let endpoint = f.endpoint.clone();
            assert_eq!(
                check_provider_gateway_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    move |token, flag| check_identity(&endpoint, None, token, flag, &|_| None)
                )
                .await
                .unwrap()
                .status,
                "identified"
            );
            assert_eq!(
                check_provider_gateway_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    |_, _| panic!("owned worker failure")
                )
                .await
                .unwrap_err(),
                "provider_catalog_unavailable"
            );
            let active = requests.begin("main", TOKEN).unwrap();
            assert_eq!(
                load_provider_models_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    |_, _| panic!("busy request admitted")
                )
                .await
                .unwrap()
                .status,
                "busy"
            );
            requests.cancel("main", TOKEN);
            assert!(active.load(Ordering::Acquire));
            requests.finish("main", TOKEN);
            assert_eq!(
                load_provider_models_with(
                    "main".into(),
                    requests.clone(),
                    TOKEN.into(),
                    |_, _| panic!("cancelled request admitted")
                )
                .await
                .unwrap()
                .status,
                "cancelled"
            );
            assert_eq!(
                load_provider_models_with(
                    "other".into(),
                    requests.clone(),
                    TOKEN.into(),
                    |_, _| panic!("owned models failure")
                )
                .await
                .unwrap_err(),
                "provider_catalog_unavailable"
            );
            let f = Fixture::new("models-empty");
            let endpoint = f.endpoint.clone();
            assert_eq!(
                load_provider_models_with(
                    "other".into(),
                    requests.clone(),
                    TOKEN.into(),
                    move |token, flag| load_models(&endpoint, None, token, flag, &|_| None)
                )
                .await
                .unwrap()
                .status,
                "loaded"
            );
            assert!(requests
                .0
                .lock()
                .unwrap()
                .values()
                .all(|entry| entry.active.is_none()));
        });
        let requests = Requests::default();
        let shared = requests.clone();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(check_provider_gateway_with(
                "main".into(),
                shared,
                TOKEN.into(),
                move |token, flag| {
                    entered.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(2)).unwrap();
                    assert!(flag.load(Ordering::Acquire));
                    IdentityReply::new(token, "cancelled")
                },
            ))
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        requests.cancel("other", TOKEN);
        assert!(!requests.0.lock().unwrap()["main"]
            .active
            .as_ref()
            .unwrap()
            .1
            .load(Ordering::Acquire));
        requests.cancel("main", TOKEN);
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap().status, "cancelled");
        assert!(requests.0.lock().unwrap()["main"].active.is_none());
    }

    #[test]
    fn closure_t11_late_cancel_is_checked_when_finishing_the_query() {
        tauri::async_runtime::block_on(async {
            let requests = Requests::default();
            let shared = requests.clone();
            let reply = check_provider_gateway_with(
                "main".into(),
                requests.clone(),
                TOKEN.into(),
                move |token, _| {
                    shared.cancel("main", token);
                    IdentityReply::new(token, "identified")
                },
            )
            .await
            .unwrap();
            assert_eq!(reply.status, "cancelled");
            let shared = requests.clone();
            let reply = load_provider_models_with(
                "models".into(),
                requests.clone(),
                TOKEN.into(),
                move |token, _| {
                    shared.cancel("models", token);
                    CatalogReply::new(token, "loaded")
                },
            )
            .await
            .unwrap();
            assert_eq!(reply.status, "cancelled");
            assert!(requests
                .0
                .lock()
                .unwrap()
                .values()
                .all(|entry| entry.active.is_none()));
        });
    }

    #[test]
    fn provider_catalog_models_projects_only_display_fields_without_selecting_or_inference() {
        let f = Fixture::new("models");
        let reply = load_models(&f.endpoint, None, TOKEN, &AtomicBool::new(false), &|_| {
            panic!("no key")
        });
        assert_eq!(reply.status, "loaded");
        assert_eq!(reply.http_status, Some(200));
        assert_eq!(reply.models.len(), 2);
        assert_eq!(reply.models[0].id, "provider/model-1");
        assert_eq!(reply.models[0].display_name.as_deref(), Some("Model one"));
        assert_eq!(reply.models[0].owned_by.as_deref(), Some("fixture"));
        assert!(!serde_json::to_string(&reply).unwrap().contains("secret"));
        assert_eq!(f.requests()[0]["path"], "/v1/models");
        assert_eq!(f.requests().len(), 1);
        let empty = Fixture::new("models-empty");
        let reply = load_models(
            &empty.endpoint,
            None,
            TOKEN,
            &AtomicBool::new(false),
            &|_| None,
        );
        assert_eq!(reply.status, "loaded");
        assert!(reply.models.is_empty());
    }

    #[test]
    fn provider_catalog_models_rejects_incomplete_or_ambiguous_catalogs_as_a_whole() {
        for (mode, reason) in [
            ("models-more", "pagination_unsupported"),
            ("models-duplicate", "invalid_response"),
            ("models-invalid", "invalid_response"),
            ("models-too-many", "response_too_large"),
            ("models-bad-shape", "invalid_response"),
            ("models-invalid-label", "invalid_response"),
        ] {
            let f = Fixture::new(mode);
            let reply = load_models(&f.endpoint, None, TOKEN, &AtomicBool::new(false), &|_| None);
            assert_eq!(reply.status, reason, "{mode}");
            assert!(reply.models.is_empty());
        }
    }

    #[test]
    fn provider_catalog_models_parser_covers_id_byte_limits_schema_and_optional_labels() {
        let encode = |item| {
            serde_json::to_vec(&serde_json::json!({"object":"list","data":[item],"has_more":false}))
                .unwrap()
        };
        let valid =
            encode(serde_json::json!({"id":"m".repeat(256),"display_name":null,"owned_by":""}));
        assert_eq!(parse_models(&valid).unwrap()[0].id.len(), 256);
        let unicode = encode(serde_json::json!({"id":"模".repeat(85)}));
        assert_eq!(parse_models(&unicode).unwrap()[0].id.len(), 255);
        for id in [
            "".to_string(),
            "m".repeat(257),
            "模".repeat(86),
            "bad\u{0085}id".into(),
            "bad\u{0000}id".into(),
        ] {
            assert_eq!(
                parse_models(&encode(serde_json::json!({"id":id}))).unwrap_err(),
                "invalid_response"
            );
        }
        for item in [
            serde_json::json!({"id":42}),
            serde_json::json!({"id":"ok","display_name":42}),
            serde_json::json!({"id":"ok","owned_by":"x".repeat(257)}),
            serde_json::json!({"id":"ok","owned_by":"bad\nlabel"}),
        ] {
            assert_eq!(parse_models(&encode(item)).unwrap_err(), "invalid_response");
        }
        for value in [
            serde_json::json!([]),
            serde_json::json!({"object":"list","data":[]}),
            serde_json::json!({"object":"list","data":{},"has_more":false}),
            serde_json::json!({"object":"list","data":[],"has_more":"false"}),
        ] {
            assert_eq!(
                parse_models(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
                "invalid_response"
            );
        }
        let full = serde_json::json!({"object":"list","data":(0..1000).map(|i|serde_json::json!({"id":format!("m-{i}")})).collect::<Vec<_>>(),"has_more":false});
        assert_eq!(
            parse_models(&serde_json::to_vec(&full).unwrap())
                .unwrap()
                .len(),
            1000
        );
    }

    #[test]
    fn provider_catalog_models_reuses_status_limits_timeout_and_cancel_contracts() {
        for (mode, reason) in [
            ("401", "authentication_refused"),
            ("redirect", "redirect_refused"),
            ("bad", "invalid_response"),
            ("large", "response_too_large"),
            ("slow", "timed_out"),
        ] {
            let f = Fixture::new(mode);
            let reply = load_models(&f.endpoint, None, TOKEN, &AtomicBool::new(false), &|_| None);
            assert_eq!(reply.status, reason, "{mode}");
            assert!(reply.models.is_empty());
        }
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            load_models(
                "http://localhost:3425",
                None,
                TOKEN,
                &cancelled,
                &|_| panic!("cancelled")
            )
            .status,
            "cancelled"
        );
        assert_eq!(
            load_models(
                "https://example.com",
                Some("PRIVATE"),
                TOKEN,
                &AtomicBool::new(false),
                &|_| panic!("remote")
            )
            .status,
            "unsupported"
        );
    }

    #[test]
    fn provider_catalog_request_registry_is_scoped_and_fences_cancel_before_start() {
        let requests = Requests::default();
        let first = requests.begin("main", TOKEN).unwrap();
        assert_eq!(requests.begin("main", "other").unwrap_err(), "busy");
        let second = requests.begin("terminal-secondary", TOKEN).unwrap();
        requests.cancel("main", "other");
        assert!(!first.load(Ordering::Acquire));
        requests.cancel("main", TOKEN);
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        requests.finish("main", "wrong");
        assert_eq!(requests.begin("main", "next").unwrap_err(), "busy");
        requests.finish("main", TOKEN);
        assert_eq!(requests.begin("main", TOKEN).unwrap_err(), "cancelled");
        assert!(requests.begin("main", "next").is_ok());
        requests.cancel("future-window", TOKEN);
        assert_eq!(
            requests.begin("future-window", TOKEN).unwrap_err(),
            "cancelled"
        );
        for i in 0..40 {
            requests.cancel("future-window", &format!("token-{i}"));
        }
        assert_eq!(
            requests.0.lock().unwrap()["future-window"].cancelled.len(),
            16
        );
    }

    #[test]
    fn provider_catalog_limits_output_tokens_and_curl_environment() {
        assert!(valid_token(TOKEN));
        for value in [
            "",
            "x",
            "12345678_1234-4234-8234-123456789abc",
            "12345678-1234-4234-8234-123456789abz",
        ] {
            assert!(!valid_token(value));
        }
        for (bytes, limit, expected) in
            [(b"abc".as_slice(), 3, true), (b"abcd".as_slice(), 3, false)]
        {
            let overflow = AtomicBool::new(false);
            assert_eq!(bounded_read(bytes, limit, &overflow).is_ok(), expected);
            assert_eq!(overflow.load(Ordering::Acquire), !expected);
        }
        let url = identity_url("http://localhost:3425/v1").unwrap();
        let command = curl_command(&url, QUERY_BUDGET);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(args[0], "--disable");
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--resolve", "localhost:3425:127.0.0.1,[::1]"]));
        assert!(args.windows(2).any(|pair| pair == ["--config", "-"]));
        assert!(!args
            .iter()
            .any(|arg| ["--location", "--insecure", "--header"].contains(arg)));
        assert_eq!(command.get_envs().count(), 0);
        for endpoint in [
            "http://localhost/a/../v1",
            "http://localhost//v1",
            "http://localhost/v1%2f",
            "http://localhost:0",
        ] {
            assert!(identity_url(endpoint).is_none(), "{endpoint}");
        }
    }

    struct Fixture {
        child: Child,
        root: PathBuf,
        endpoint: String,
    }
    impl Fixture {
        fn new(mode: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("yam-catalog-{}", crate::next_session_id()));
            fs::create_dir(&root).unwrap();
            let mut child = Command::new("python3")
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../tests/fixtures/provider_catalog_api.py"),
                )
                .args(["--mode", mode, "--receipts"])
                .arg(root.join("requests.jsonl"))
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut line = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
            Self {
                child,
                root,
                endpoint: ready["endpoint"].as_str().unwrap().into(),
            }
        }
        fn requests(&self) -> Vec<serde_json::Value> {
            fs::read_to_string(self.root.join("requests.jsonl"))
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
        fn check(&self) -> IdentityReply {
            check_identity(
                &self.endpoint,
                None,
                TOKEN,
                &AtomicBool::new(false),
                &|_| panic!("no credential lookup"),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn provider_catalog_identifies_real_loopback_http_without_model_requests() {
        let f = Fixture::new("identity");
        let reply = f.check();
        assert_eq!(reply.status, "identified");
        assert_eq!(reply.version.as_deref(), Some("0.1.fixture"));
        assert_eq!(reply.http_status, Some(200));
        assert_eq!(reply.query_token, TOKEN);
        let calls = f.requests();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["method"], "GET");
        assert_eq!(calls[0]["path"], "/api/hello");
        assert_eq!(calls[0]["auth_present"], false);
    }

    #[test]
    fn provider_catalog_rejects_unsupported_targets_before_key_lookup() {
        for endpoint in [
            "https://example.com/v1",
            "http://127.1/v1",
            "http://localhost.evil/v1",
            "http://localhost/v2",
            "http://localhost/prefix/v1",
            "http://user:secret@localhost/v1",
            "http://localhost/v1?key=secret",
            "http://localhost/v1#secret",
        ] {
            let reply = check_identity(
                endpoint,
                Some("PRIVATE_KEY"),
                TOKEN,
                &AtomicBool::new(false),
                &|_| panic!("unsupported target must not resolve a key"),
            );
            assert_eq!(reply.status, "unsupported", "{endpoint}");
        }
    }

    #[test]
    fn provider_catalog_checks_http_status_and_never_follows_redirects() {
        for (mode, expected) in [
            ("401", "authentication_refused"),
            ("403", "authentication_refused"),
            ("404", "http_error"),
            ("429", "http_error"),
            ("500", "http_error"),
            ("503", "http_error"),
            ("redirect", "redirect_refused"),
        ] {
            let f = Fixture::new(mode);
            let reply = f.check();
            assert_eq!(reply.status, expected, "{mode}");
            assert!(reply.version.is_none());
            assert_eq!(f.requests().len(), 1);
        }
    }

    #[test]
    fn provider_catalog_rejects_bad_identity_and_oversize_replies_without_echoing_them() {
        for (mode, expected) in [
            ("bad", "invalid_response"),
            ("unrecognized", "unrecognized"),
            ("unsafe-version", "invalid_response"),
            ("large", "response_too_large"),
            ("large-unknown", "response_too_large"),
        ] {
            let f = Fixture::new(mode);
            let reply = f.check();
            assert_eq!(reply.status, expected, "{mode}");
            assert!(reply.version.is_none());
            assert!(!serde_json::to_string(&reply).unwrap().contains("secret"));
        }
    }

    #[test]
    fn provider_catalog_only_resolves_the_selected_safe_environment_reference() {
        let f = Fixture::new("identity");
        let reply = check_identity(
            &f.endpoint,
            Some("GATEWAY_API_KEY"),
            TOKEN,
            &AtomicBool::new(false),
            &|name| {
                assert_eq!(name, "GATEWAY_API_KEY");
                Some("fixture-\"quoted\\marker".into())
            },
        );
        assert_eq!(reply.status, "identified");
        assert_eq!(f.requests()[0]["auth_present"], true);
        for name in ["", "1BAD", "YAM_PROVIDER_API_KEY", "BAD\nHEADER"] {
            let reply = check_identity(
                &f.endpoint,
                Some(name),
                TOKEN,
                &AtomicBool::new(false),
                &|_| panic!("invalid reference must not be resolved"),
            );
            assert_eq!(reply.status, "credential_unavailable");
        }
        for value in [
            None,
            Some(String::new()),
            Some("x\r\nInjected: value".into()),
            Some("x".repeat(16385)),
        ] {
            let reply = check_identity(
                &f.endpoint,
                Some("GATEWAY_API_KEY"),
                TOKEN,
                &AtomicBool::new(false),
                &|_| value.clone(),
            );
            assert_eq!(reply.status, "credential_unavailable");
        }
        assert_eq!(
            f.requests().len(),
            1,
            "invalid credentials must never contact the gateway"
        );
    }

    #[test]
    fn provider_catalog_timeout_and_cancellation_reap_their_own_request() {
        let f = Fixture::new("slow");
        let start = Instant::now();
        assert_eq!(f.check().status, "timed_out");
        assert!(start.elapsed() < Duration::from_secs(5));
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let endpoint = f.endpoint.clone();
        let worker =
            std::thread::spawn(move || check_identity(&endpoint, None, TOKEN, &flag, &|_| None));
        std::thread::sleep(Duration::from_millis(50));
        cancelled.store(true, Ordering::Release);
        assert_eq!(worker.join().unwrap().status, "cancelled");
        let before = f.requests().len();
        let reply = check_identity(&f.endpoint, None, TOKEN, &cancelled, &|_| {
            panic!("cancelled before spawn")
        });
        assert_eq!(reply.status, "cancelled");
        assert_eq!(f.requests().len(), before);
    }
}
