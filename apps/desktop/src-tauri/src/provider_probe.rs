// Author: Jeff.Liu. Only literal loopback targets; no DNS, HTTP, TLS or credentials.
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProbeStatus {
    Reachable,
    Unreachable,
    TimedOut,
    Unsupported,
}

pub(super) fn targets(input: &str) -> Option<Vec<SocketAddr>> {
    if input.len() > 2048 || input.bytes().any(|b| b <= 32 || b == 127) {
        return None;
    }
    let url = tauri::Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    // Check the original authority: URL parsers normalize aliases such as 127.1.
    let authority = input.split_once("://")?.1.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let host = if authority.starts_with('[') {
        &authority[..=authority.find(']')?]
    } else {
        authority.split(':').next()?
    };
    let port = url.port_or_known_default()?;
    if port == 0 {
        return None;
    }
    match host.to_ascii_lowercase().as_str() {
        "localhost" => Some(vec![
            (Ipv4Addr::LOCALHOST, port).into(),
            (Ipv6Addr::LOCALHOST, port).into(),
        ]),
        "127.0.0.1" => Some(vec![(Ipv4Addr::LOCALHOST, port).into()]),
        "[::1]" => Some(vec![(Ipv6Addr::LOCALHOST, port).into()]),
        _ => None,
    }
}

fn probe_with(
    input: &str,
    timeout: Duration,
    mut connect: impl FnMut(SocketAddr, Duration) -> io::Result<()>,
) -> ProbeStatus {
    let Some(addresses) = targets(input) else {
        return ProbeStatus::Unsupported;
    };
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return ProbeStatus::TimedOut;
        }
        match connect(address, remaining) {
            Ok(()) => return ProbeStatus::Reachable,
            Err(error) => {
                timed_out |= matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                )
            }
        }
    }
    if timed_out {
        ProbeStatus::TimedOut
    } else {
        ProbeStatus::Unreachable
    }
}

fn probe(input: &str) -> ProbeStatus {
    probe_with(input, Duration::from_secs(2), |address, remaining| {
        TcpStream::connect_timeout(&address, remaining).map(drop)
    })
}

#[tauri::command]
pub(crate) async fn probe_provider_endpoint(endpoint: String) -> Result<ProbeStatus, String> {
    probe_provider_endpoint_with(endpoint, probe).await
}

async fn probe_provider_endpoint_with(
    endpoint: String,
    worker: impl FnOnce(&str) -> ProbeStatus + Send + 'static,
) -> Result<ProbeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || worker(&endpoint))
        .await
        .map_err(|_| "provider_probe_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
    use std::time::{Duration, Instant};

    #[test]
    fn closure_t11_probe_command_joins_real_connect_and_normalizes_worker_panic() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            assert_eq!(
                probe_provider_endpoint(format!("http://{}/v1", listener.local_addr().unwrap()))
                    .await
                    .unwrap(),
                ProbeStatus::Reachable
            );
            let (mut stream, _) = listener.accept().unwrap();
            use std::io::Read;
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            assert_eq!(stream.read(&mut [0]).unwrap(), 0);
            assert_eq!(
                probe_provider_endpoint("https://example.com".into())
                    .await
                    .unwrap(),
                ProbeStatus::Unsupported
            );
            assert_eq!(
                probe_provider_endpoint_with("http://127.0.0.1".into(), |_| panic!(
                    "owned probe failure"
                ))
                .await
                .unwrap_err(),
                "provider_probe_unavailable"
            );
        });
    }

    #[test]
    fn provider_probe_only_accepts_exact_loopback_http_urls() {
        for url in [
            "http://localhost:3425/v1",
            "https://127.0.0.1",
            "http://[::1]:3425/",
        ] {
            assert!(targets(url).is_some(), "{url}");
        }
        for url in [
            "",
            "not a URL",
            "ftp://localhost:3425",
            "https://example.com",
            "http://127.0.0.2",
            "http://127.1",
            "http://2130706433",
            "http://localhost.evil",
            "http://localhost.",
            "http://user:secret@localhost",
            "http://localhost/?token=secret",
            "http://localhost/#secret",
            "http://localhost:0",
            "http://localhost:65536",
            " http://localhost",
            "http://local\nhost",
        ] {
            assert!(targets(url).is_none(), "{url}");
        }
        assert!(targets(&format!("http://localhost/{}", "a".repeat(2048))).is_none());
        let addresses = targets("http://localhost:3425/v1").unwrap();
        assert_eq!(addresses.len(), 2);
        assert_eq!(
            addresses[0],
            std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, 3425))
        );
        assert_eq!(
            addresses[1],
            std::net::SocketAddr::from((Ipv6Addr::LOCALHOST, 3425))
        );
    }

    #[test]
    fn provider_probe_connects_to_a_real_local_listener_without_sending_bytes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let result = probe(&format!("http://{}/v1", listener.local_addr().unwrap()));
        assert_eq!(result, ProbeStatus::Reachable);
        let (mut stream, _) = listener.accept().unwrap();
        use std::io::Read;
        let mut byte = [0];
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        assert_eq!(stream.read(&mut byte).unwrap(), 0);
    }

    #[test]
    fn provider_probe_refusal_timeout_and_localhost_fallback_are_bounded() {
        assert_eq!(
            probe_with("http://127.0.0.1:9", Duration::from_secs(2), |_, _| Err(
                io::ErrorKind::ConnectionRefused.into()
            )),
            ProbeStatus::Unreachable
        );
        assert_eq!(
            probe_with("http://127.0.0.1:9", Duration::from_secs(2), |_, _| Err(
                io::ErrorKind::TimedOut.into()
            )),
            ProbeStatus::TimedOut
        );
        let mut calls = 0;
        assert_eq!(
            probe_with(
                "http://localhost:9",
                Duration::from_secs(2),
                |_, remaining| {
                    calls += 1;
                    assert!(remaining <= Duration::from_secs(2));
                    if calls == 1 {
                        Err(io::ErrorKind::ConnectionRefused.into())
                    } else {
                        Ok(())
                    }
                }
            ),
            ProbeStatus::Reachable
        );
        assert_eq!(calls, 2);
        let start = Instant::now();
        let mut attempts = 0;
        assert_eq!(
            probe_with(
                "http://localhost:9",
                Duration::from_millis(5),
                |_, remaining| {
                    attempts += 1;
                    std::thread::sleep(remaining);
                    Err(io::ErrorKind::TimedOut.into())
                }
            ),
            ProbeStatus::TimedOut
        );
        assert_eq!(attempts, 1);
        assert!(start.elapsed() < Duration::from_millis(250));
        assert_eq!(
            probe_with(
                "https://example.com",
                Duration::from_secs(2),
                |_, _| panic!("remote addresses must never be contacted")
            ),
            ProbeStatus::Unsupported
        );
    }
}

#[cfg(any(target_os = "macos", test))]
fn installed_gateways(roots: &[std::path::PathBuf]) -> Vec<&'static str> {
    [
        ("magpie", "magpie.app"),
        ("cc-switch", "CC Switch.app"),
        ("echobird", "EchoBird.app"),
    ]
    .into_iter()
    .filter_map(|(id, name)| {
        roots
            .iter()
            .any(|root| root.join(name).join("Contents/Info.plist").is_file())
            .then_some(id)
    })
    .collect()
}

#[tauri::command]
pub(crate) async fn list_local_gateways() -> Result<Vec<&'static str>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let mut roots = vec![std::path::PathBuf::from("/Applications")];
            if let Some(home) = std::env::var_os("HOME") {
                roots.push(std::path::PathBuf::from(home).join("Applications"));
            }
            installed_gateways(&roots)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    })
    .await
    .map_err(|_| "local_gateway_discovery_unavailable".into())
}

#[cfg(test)]
mod installed_gateway_tests {
    use super::*;
    #[test]
    fn installed_gateways_use_only_known_bundles_and_never_read_gateway_configuration() {
        let root =
            std::env::temp_dir().join(format!("yam-gateway-discovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(installed_gateways(std::slice::from_ref(&root)).is_empty());
        for app in ["magpie.app", "CC Switch.app", "EchoBird.app", "Unknown.app"] {
            let contents = root.join(app).join("Contents");
            std::fs::create_dir_all(&contents).unwrap();
            std::fs::write(contents.join("Info.plist"), b"fixture metadata").unwrap();
        }
        assert_eq!(
            installed_gateways(&[root.clone(), root.clone()]),
            vec!["magpie", "cc-switch", "echobird"]
        );
        std::fs::remove_file(root.join("CC Switch.app/Contents/Info.plist")).unwrap();
        assert_eq!(
            installed_gateways(std::slice::from_ref(&root)),
            vec!["magpie", "echobird"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
