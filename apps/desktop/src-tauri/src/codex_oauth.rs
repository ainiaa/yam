// Author: Jeff.Liu. Imported MCP tokens stay in the private Codex home.
use serde_json::{json, Value};
use std::path::Path;

fn convert(value: Value, name: &str, url: &str) -> Result<Value, String> {
    let tokens = &value["token_response"];
    if value["server_name"].as_str().is_none_or(|stored| {
        stored.trim_start_matches("local:") != name.trim_start_matches("local:")
    }) || value["url"].as_str() != Some(url)
        || value["client_id"].as_str().is_none()
        || tokens["access_token"].as_str().is_none_or(|s| s.is_empty())
    {
        return Err("MCP keychain credential identity or format is unsupported".into());
    }
    Ok(
        json!({"server_name":value["server_name"],"server_url":url,"issuer":value["issuer"],"client_id":value["client_id"],"access_token":tokens["access_token"],"refresh_token":tokens["refresh_token"],"expires_at":value["expires_at"],"scopes":tokens["scope"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>()}),
    )
}
// Codex 0.163.0 rmcp-client/oauth.rs uses millisecond expiry and a 30-second refresh skew.
fn file_credential_usable(value: &Value, name: &str, url: &str, now: u64) -> bool {
    for key in ["issuer", "refresh_token"] {
        if value
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return false;
        }
    }
    if !value["access_token"].is_string()
        || value.get("scopes").is_some_and(|v| {
            !v.as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        })
        || value.get("executor_owned").is_some_and(|v| !v.is_boolean())
    {
        return false;
    }
    let nonblank = |key: &str| value[key].as_str().is_some_and(|s| !s.trim().is_empty());
    if !value["server_name"].as_str().is_some_and(|stored| {
        stored.strip_prefix("local:").unwrap_or(stored)
            == name.strip_prefix("local:").unwrap_or(name)
    }) || value["server_url"].as_str() != Some(url)
        || !nonblank("client_id")
    {
        return false;
    }
    let needs_refresh = match value.get("expires_at") {
        None | Some(Value::Null) => false,
        Some(expiry) => match expiry.as_u64() {
            Some(expiry) => now.saturating_add(30_000) >= expiry,
            None => return false,
        },
    };
    if needs_refresh {
        nonblank("issuer") && nonblank("refresh_token")
    } else {
        nonblank("access_token")
    }
}

type KeychainResult = Result<Option<(String, Value)>, String>;

fn import(
    config: &toml::Value,
    source: &Path,
    stage: &Path,
    store: &mut serde_json::Map<String, Value>,
    lookup: &mut dyn FnMut(&str, &str, &Path) -> KeychainResult,
) -> Result<bool, String> {
    let mode = config
        .get("mcp_oauth_credentials_store")
        .and_then(toml::Value::as_str)
        .unwrap_or("auto");
    let backend = config
        .get("auth_keyring_backend")
        .and_then(toml::Value::as_str)
        .unwrap_or(if cfg!(windows) { "secrets" } else { "direct" });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let mut changed = false;
    if mode != "file" {
        if let Some(servers) = config.get("mcp_servers").and_then(toml::Value::as_table) {
            for (name, server) in servers {
                let Some(url) = server.get("url").and_then(toml::Value::as_str) else {
                    continue;
                };
                if server.get("enabled").and_then(toml::Value::as_bool) == Some(false)
                    || server.get("bearer_token_env_var").is_some()
                {
                    continue;
                }
                let result = if backend == "direct" {
                    lookup(name, url, stage)
                } else if mode == "auto" {
                    // Public HTTP servers need no OAuth; native Codex can request a private login if necessary.
                    Ok(None)
                } else {
                    Err("MCP encrypted keychain inheritance is unavailable; use a file-based MCP login or existing CLI configuration".into())
                };
                let credential = match result {
                    Ok(value) => value,
                    Err(_)
                        if mode == "auto"
                            && store
                                .values()
                                .any(|value| file_credential_usable(value, name, url, now)) =>
                    {
                        None
                    }
                    Err(error) => return Err(error),
                };
                if let Some((key, value)) = credential {
                    store.insert(key, convert(value, name, url)?);
                    changed = true;
                }
            }
        }
    }
    let _ = source;
    Ok(changed)
}
pub(super) fn inherit(config: &toml::Value, source: &Path, stage: &Path) -> Result<(), String> {
    let path = stage.join(".credentials.json");
    let mut store: serde_json::Map<String, Value> = if path.exists() {
        serde_json::from_slice(&super::read(&path)?)
            .map_err(|_| "Invalid inherited MCP credential file")?
    } else {
        Default::default()
    };
    let mut inherited = config.clone();
    if source.join("config.toml").exists() {
        let original = super::parse(&super::read(&source.join("config.toml"))?)?;
        for key in ["mcp_oauth_credentials_store", "auth_keyring_backend"] {
            if inherited.get(key).is_none() {
                if let Some(value) = original.get(key) {
                    inherited
                        .as_table_mut()
                        .ok_or("Invalid Codex configuration")?
                        .insert(key.into(), value.clone());
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    inherited
        .as_table_mut()
        .ok_or("Invalid Codex configuration")?
        .insert("auth_keyring_backend".into(), "unavailable".into());
    if import(&inherited, source, stage, &mut store, &mut keychain)? {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|_| "Cannot prepare private MCP credentials")?;
        }
        super::write(
            &path,
            &serde_json::to_vec(&store).map_err(|_| "Cannot serialize private MCP credentials")?,
        )?;
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn keychain(name: &str, url: &str, stage: &Path) -> Result<Option<(String, Value)>, String> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut budget = crate::git_context::Budget {
        deadline,
        remaining: 65536,
    };
    let path = stage.join(format!(
        "yam-oauth-key-{}.json",
        crate::agent_bridge::credential()?
    ));
    super::write(
        &path,
        &serde_json::to_vec(&json!({"type":"http","url":url,"headers":{}})).unwrap(),
    )?;
    let hash = budget.run_env(
        Path::new("/usr/bin/shasum"),
        &[
            "-a",
            "256",
            path.to_str().ok_or("Invalid private MCP path")?,
        ],
        stage,
        &[],
    );
    let _ = std::fs::remove_file(path);
    let hash =
        hash.map_err(|_| "MCP keychain identity query timed out or exceeded its output limit")?;
    if !hash.status.success() {
        return Err("Cannot derive MCP credential identity".into());
    }
    let hash = std::str::from_utf8(&hash.stdout)
        .ok()
        .and_then(|s| s.split_whitespace().next())
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Invalid MCP identity digest")?;
    let key = format!(
        "{}|{}",
        name.strip_prefix("local:").unwrap_or(name),
        &hash[..16]
    );
    let result = budget
        .run_env(
            Path::new("/usr/bin/security"),
            &[
                "find-generic-password",
                "-s",
                "Codex MCP Credentials",
                "-a",
                &key,
                "-w",
            ],
            stage,
            &[],
        )
        .map_err(|_| "MCP keychain read timed out or exceeded its output limit")?;
    if result.status.code() == Some(44) {
        return Ok(None);
    }
    if !result.status.success() {
        return Err(
            "Cannot read MCP keychain login; authorize read access or use a file-based MCP login"
                .into(),
        );
    }
    let value = serde_json::from_slice(&result.stdout)
        .map_err(|_| "Unsupported MCP keychain credential format")?;
    Ok(Some((key, value)))
}
#[cfg(not(target_os = "macos"))]
fn keychain(_: &str, _: &str, _: &Path) -> Result<Option<(String, Value)>, String> {
    Err("MCP keychain inheritance is unavailable on this platform; use a file-based MCP login or existing CLI configuration".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keychain_import_preserves_file_entries_and_copies_only_matching_tokens() {
        let config: toml::Value =
            toml::from_str("[mcp_servers.fixture]\nurl='https://example.invalid/mcp'\n").unwrap();
        let mut store = serde_json::Map::from_iter([("file-entry".into(), json!({"kept":true}))]);
        let mut lookup = |name: &str, url: &str, _: &Path| {
            Ok(Some((
                "fixture|hash".into(),
                json!({"server_name":name,"url":url,"client_id":"client","issuer":"issuer","expires_at":1234,"token_response":{"access_token":"private-token","refresh_token":"refresh","scope":"read write"}}),
            )))
        };
        assert!(import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut store,
            &mut lookup
        )
        .unwrap());
        assert_eq!(store["file-entry"], json!({"kept":true}));
        assert_eq!(store["fixture|hash"]["scopes"], json!(["read", "write"]));
        assert_eq!(store["fixture|hash"]["access_token"], "private-token");
        assert!(convert(json!({"server_name":"wrong"}), "fixture", "url").is_err());
    }
    #[test]
    fn file_and_auto_public_servers_do_not_require_an_unsupported_keychain() {
        let mut config: toml::Value = toml::from_str("mcp_oauth_credentials_store='file'\n[mcp_servers.fixture]\nurl='https://example.invalid/mcp'\n").unwrap();
        assert!(!import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut Default::default(),
            &mut |_, _, _| panic!("keychain must not be queried")
        )
        .unwrap());
        config["mcp_oauth_credentials_store"] = "auto".into();
        config
            .as_table_mut()
            .unwrap()
            .insert("auth_keyring_backend".into(), "secrets".into());
        for backend in ["secrets", "unavailable"] {
            config["auth_keyring_backend"] = backend.into();
            assert!(!import(
                &config,
                Path::new("/original"),
                Path::new("/private"),
                &mut Default::default(),
                &mut |_, _, _| panic!(
                    "public auto server must not require an unsupported keychain"
                )
            )
            .unwrap());
        }
        config["mcp_oauth_credentials_store"] = "keyring".into();
        assert!(import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut Default::default(),
            &mut |_, _, _| panic!("explicit keyring remains unsupported")
        )
        .is_err());
    }
    #[test]
    fn file_fallback_matches_native_oauth_expiry_and_refresh_policy() {
        let base = json!({"server_name":"fixture","server_url":"https://example.invalid/mcp","client_id":"client","access_token":"token"});
        for (expiry, refresh, issuer, expected) in [
            (None, None, None, true),
            (Some(31_001), None, None, true),
            (Some(31_000), None, None, false),
            (Some(999), None, None, false),
            (Some(999), Some("refresh"), None, false),
            (
                Some(999),
                Some("refresh"),
                Some("https://issuer.invalid"),
                true,
            ),
            (Some(999), Some(" "), Some("https://issuer.invalid"), false),
        ] {
            let mut value = base.clone();
            value["expires_at"] = json!(expiry);
            value["refresh_token"] = json!(refresh);
            value["issuer"] = json!(issuer);
            assert_eq!(
                file_credential_usable(&value, "fixture", "https://example.invalid/mcp", 1_000),
                expected
            );
        }
        for (field, invalid) in [
            ("issuer", json!(7)),
            ("refresh_token", json!(7)),
            ("scopes", json!([7])),
            ("executor_owned", json!("yes")),
            ("expires_at", json!("soon")),
        ] {
            let mut value = base.clone();
            value[field] = invalid;
            assert!(!file_credential_usable(
                &value,
                "fixture",
                "https://example.invalid/mcp",
                1_000
            ));
        }
        let mut missing_access = base.clone();
        missing_access
            .as_object_mut()
            .unwrap()
            .remove("access_token");
        missing_access["expires_at"] = json!(0);
        missing_access["issuer"] = json!("https://issuer.invalid");
        missing_access["refresh_token"] = json!("refresh");
        assert!(!file_credential_usable(
            &missing_access,
            "fixture",
            "https://example.invalid/mcp",
            1_000
        ));
        for field in ["client_id", "access_token"] {
            let mut value = base.clone();
            value[field] = json!(" ");
            assert!(!file_credential_usable(
                &value,
                "fixture",
                "https://example.invalid/mcp",
                1_000
            ));
        }
    }

    #[test]
    fn auto_keychain_errors_require_matching_usable_file_credentials() {
        let config: toml::Value =
            toml::from_str("[mcp_servers.fixture]\nurl='https://example.invalid/mcp'\n").unwrap();
        for value in [
            json!(null),
            json!({"kept":true}),
            json!({"server_name":"other","server_url":"https://example.invalid/mcp","client_id":"client","access_token":"token"}),
            json!({"server_name":"fixture","server_url":"https://other.invalid/mcp","client_id":"client","access_token":"token"}),
            json!({"server_name":"fixture","server_url":"https://example.invalid/mcp","access_token":"token"}),
            json!({"server_name":"fixture","server_url":"https://example.invalid/mcp","client_id":"client","access_token":""}),
        ] {
            let mut store = serde_json::Map::new();
            if !value.is_null() {
                store.insert("fallback".into(), value);
            }
            let before = store.clone();
            assert!(
                import(
                    &config,
                    Path::new("/original"),
                    Path::new("/private"),
                    &mut store,
                    &mut |_, _, _| Err("unsupported keychain platform".into())
                )
                .is_err(),
                "Auto must not hide unsupported or failed keychain lookup without usable fallback"
            );
            assert_eq!(store, before);
        }
    }

    #[test]
    fn auto_keychain_errors_preserve_file_fallback_but_keyring_errors_are_explicit() {
        let mut config: toml::Value =
            toml::from_str("[mcp_servers.fixture]\nurl='https://example.invalid/mcp'\n").unwrap();
        let mut store = serde_json::Map::from_iter([(
            "file-entry".into(),
            json!({"server_name":"fixture","server_url":"https://example.invalid/mcp","client_id":"client","access_token":"file-token","refresh_token":"refresh","scopes":[]}),
        )]);
        assert!(!import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut store,
            &mut |_, _, _| Err("locked".into())
        )
        .unwrap());
        assert_eq!(store["file-entry"]["access_token"], "file-token");
        config
            .as_table_mut()
            .unwrap()
            .insert("auth_keyring_backend".into(), "secrets".into());
        assert!(!import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut store,
            &mut |_, _, _| panic!("unsupported backend must use the matching file fallback")
        )
        .unwrap());
        config
            .as_table_mut()
            .unwrap()
            .insert("mcp_oauth_credentials_store".into(), "keyring".into());
        assert!(import(
            &config,
            Path::new("/original"),
            Path::new("/private"),
            &mut store,
            &mut |_, _, _| Err("locked".into())
        )
        .is_err());
    }
}
