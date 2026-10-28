// Author: Jeff.Liu. Export only explicitly supplied preferences; never read credentials or sessions.
use serde::Deserialize;
use serde_json::Value;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    version: u32,
    settings: std::collections::BTreeMap<String, Value>,
    connections: Vec<Connection>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connection {
    name: String,
    adapter: String,
    provider: crate::provider_launch::ProviderConfig,
}
fn fields(value: &Value, allowed: &[&str]) -> bool {
    value.as_object().is_some_and(|map| {
        map.len() == allowed.len() && map.keys().all(|k| allowed.contains(&k.as_str()))
    })
}
pub(super) fn encode(raw: &str) -> Result<Vec<u8>, &'static str> {
    if raw.len() > 1024 * 1024 {
        return Err("size_limit");
    }
    let backup: Backup = serde_json::from_str(raw).map_err(|_| "invalid_backup")?;
    if backup.version != 1 || backup.connections.len() > 32 || backup.settings.len() > 5 {
        return Err("invalid_backup");
    }
    for (key, value) in &backup.settings {
        let valid = match key.as_str() {
            "yam.appAppearance.v1" => {
                fields(
                    value,
                    &["language", "theme", "background", "backgroundStrength"],
                ) && value["background"].is_null()
            }
            "yam.terminalSettings" => fields(value, &["fontFamily", "fontSize", "theme"]),
            "yam.terminalCursor.v1" => fields(value, &["shape", "blink"]),
            "yam.terminalLineHeight.v1" => fields(value, &["lineHeight"]),
            "yam.appShortcuts.v1" => {
                fields(value, &["version", "bindings"])
                    && value["version"] == 1
                    && value["bindings"].as_object().is_some_and(|bindings| {
                        bindings.keys().all(|key| {
                            [
                                "terminal",
                                "palette",
                                "split-horizontal",
                                "split-vertical",
                                "attention",
                                "previous",
                                "search",
                                "pause",
                                "clear-display",
                            ]
                            .contains(&key.as_str())
                        }) && bindings
                            .values()
                            .all(|v| v.is_null() || fields(v, &["key", "shift"]))
                    })
            }
            _ => false,
        };
        if !valid {
            return Err("invalid_backup");
        }
    }
    for row in &backup.connections {
        if row.name.trim().is_empty()
            || row.name.chars().count() > 80
            || row.name.chars().any(char::is_control)
            || row.provider.validate(&row.adapter, "").is_err()
        {
            return Err("invalid_backup");
        }
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "invalid_backup")?;
    serde_json::to_vec_pretty(&value).map_err(|_| "encode_failed")
}
