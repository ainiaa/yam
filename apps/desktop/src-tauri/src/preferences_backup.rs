// Author: Jeff.Liu. Export only explicitly supplied preferences; never read credentials or sessions.
use serde::Deserialize;
use serde_json::Value;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    version: u32,
    settings: std::collections::BTreeMap<String, Value>,
    connections: Vec<Connection>,
    #[serde(default, rename = "piRouting")]
    pi_routing: Option<Value>,
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
fn portable_policy(value: &Value) -> bool {
    let model = |value: &Value| {
        value.as_str().is_some_and(|key| {
            key.encode_utf16().count() <= 512
                && key.split_once('/').is_some_and(|(provider, id)| {
                    !provider.is_empty()
                        && !id.is_empty()
                        && provider
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                        && id
                            .chars()
                            .all(|c| !c.is_whitespace() && !c.is_control() && c != '\u{feff}')
                })
        })
    };
    let text = |value: &Value, limit: usize| {
        value
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= limit)
    };
    let levels = ["medium", "high", "xhigh", "max"];
    let tiered = value["v"] == 2;
    let mut keys = vec![
        "v",
        "small",
        "strong",
        "classifier",
        "model",
        "effort",
        "billing",
        "rules",
    ];
    let mut roles = vec!["small", "strong", "classifier"];
    if tiered {
        keys.push("medium");
        roles.push("medium");
    }
    if !fields(value, &keys)
        || !(value["v"] == 1 || tiered)
        || !roles.iter().all(|key| model(&value[key]))
        || !(value["model"] == "auto" || model(&value["model"]))
        || !value["effort"].as_str().is_some_and(|v| {
            [
                "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
            ]
            .contains(&v)
        })
        || !value["billing"]
            .as_str()
            .is_some_and(|v| ["configured", "subscription"].contains(&v))
    {
        return false;
    }
    if value["billing"] == "subscription"
        && roles
            .iter()
            .copied()
            .chain(std::iter::once("model"))
            .any(|key| {
                let key = value[key].as_str().unwrap_or("");
                key != "auto" && !key.starts_with("yam-codex/") && !key.starts_with("openai-codex/")
            })
    {
        return false;
    }
    let policy = &value["rules"];
    if !fields(policy, &["v", "rules", "fallback"])
        || !(policy["v"] == 1 || tiered && policy["v"] == 2)
        || policy.to_string().len() > 6000
        || !fields(&policy["fallback"], &["model", "effort"])
        || policy["fallback"]["model"] != if policy["v"] == 2 { "medium" } else { "strong" }
        || !policy["fallback"]["effort"]
            .as_str()
            .is_some_and(|v| ["high", "xhigh", "max"].contains(&v))
    {
        return false;
    }
    let Some(rules) = policy["rules"].as_array().filter(|rows| rows.len() == 6) else {
        return false;
    };
    let mut seen = std::collections::BTreeSet::new();
    rules.iter().all(|rule| {
        let task = rule["task"].as_str().unwrap_or("");
        fields(
            rule,
            &["task", "description", "examples", "model", "effort"],
        ) && [
            "transform",
            "answer",
            "repository",
            "coding",
            "review",
            "other",
        ]
        .contains(&task)
            && seen.insert(task)
            && text(&rule["description"], 600)
            && rule["examples"]
                .as_array()
                .is_some_and(|rows| rows.len() <= 4 && rows.iter().all(|v| text(v, 160)))
            && rule["model"].as_str().is_some_and(|v| {
                ["small", "strong"].contains(&v) || policy["v"] == 2 && v == "medium"
            })
            && rule["effort"].as_str().is_some_and(|v| levels.contains(&v))
            && (["transform", "answer"].contains(&task)
                || (rule["model"] == "strong" || policy["v"] == 2 && rule["model"] == "medium")
                    && rule["effort"] != "medium")
    })
}
pub(super) fn encode(raw: &str) -> Result<Vec<u8>, &'static str> {
    if raw.len() > 1024 * 1024 {
        return Err("size_limit");
    }
    let backup: Backup = serde_json::from_str(raw).map_err(|_| "invalid_backup")?;
    if ![1, 2].contains(&backup.version)
        || backup.connections.len() > 32
        || backup.settings.len() > 5
        || backup
            .pi_routing
            .as_ref()
            .is_some_and(|value| !portable_policy(value))
    {
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
    if (backup.version == 2) != value.get("piRouting").is_some() {
        return Err("invalid_backup");
    }
    serde_json::to_vec_pretty(&value).map_err(|_| "encode_failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn portable_backup() -> Value {
        let rules: Vec<_> = ["transform", "answer", "repository", "coding", "review", "other"]
            .iter()
            .map(|task| serde_json::json!({"task":task,"description":"Task intent","examples":[],"model":"strong","effort":"high"}))
            .collect();
        serde_json::json!({"version":2,"settings":{},"connections":[],"piRouting":{
            "v":1,"small":"yam-codex/sol","strong":"yam-codex/sol","classifier":"yam-codex/sol",
            "model":"auto","effort":"auto","billing":"subscription",
            "rules":{"v":1,"rules":rules,"fallback":{"model":"strong","effort":"high"}}
        }})
    }
    #[test]
    fn portable_pi_policy_export_accepts_v2_and_keeps_v1_compatible() {
        let value = portable_backup();
        let result = encode(&value.to_string()).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&result).unwrap(), value);
        assert!(encode(r#"{"version":2,"settings":{},"connections":[],"piRouting":null}"#).is_ok());
        assert!(encode(r#"{"version":1,"settings":{},"connections":[]}"#).is_ok());
    }
    #[test]
    fn portable_pi_policy_export_accepts_catalog_names_and_utf16_boundary() {
        for key in [
            "p/model@2026".to_string(),
            "p/模型".into(),
            format!("p/{}", "字".repeat(510)),
        ] {
            let mut value = portable_backup();
            value["piRouting"]["billing"] = "configured".into();
            for role in ["small", "strong", "classifier", "model"] {
                value["piRouting"][role] = key.clone().into();
            }
            let encoded = encode(&value.to_string()).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&encoded).unwrap(), value);
        }
        for key in [
            format!("p/{}", "字".repeat(511)),
            "p/two words".into(),
            "p/control\u{85}".into(),
            "p/space\u{feff}".into(),
            "p/NUL\0".into(),
        ] {
            let mut value = portable_backup();
            value["piRouting"]["billing"] = "configured".into();
            value["piRouting"]["small"] = key.into();
            assert!(encode(&value.to_string()).is_err());
        }
    }
    #[test]
    fn portable_pi_policy_export_rejects_credentials_invalid_rules_and_unknown_versions() {
        for kind in [
            "gateway",
            "token",
            "unknown-rule",
            "billing",
            "unsafe-floor",
            "version",
            "missing-policy",
            "legacy-policy",
            "model",
            "huge-description",
        ] {
            let mut value = portable_backup();
            match kind {
                "gateway" | "token" => value["piRouting"][kind] = "PRIVATE_SECRET".into(),
                "unknown-rule" => value["piRouting"]["rules"]["token"] = "PRIVATE_SECRET".into(),
                "billing" => value["piRouting"]["strong"] = "yam-gateway/api".into(),
                "unsafe-floor" => value["piRouting"]["rules"]["rules"][2]["model"] = "small".into(),
                "version" => value["version"] = 3.into(),
                "missing-policy" => {
                    value.as_object_mut().unwrap().remove("piRouting");
                }
                "legacy-policy" => value["version"] = 1.into(),
                "model" => value["piRouting"]["small"] = "https://user:secret@host".into(),
                "huge-description" => {
                    value["piRouting"]["rules"]["rules"][0]["description"] = "x".repeat(601).into()
                }
                _ => unreachable!(),
            }
            assert!(encode(&value.to_string()).is_err(), "{kind}");
        }
    }
    #[test]
    fn portable_pi_policy_export_three_tier_retains_medium_and_subscription_floor() {
        let mut value = portable_backup();
        value["piRouting"]["v"] = 2.into();
        value["piRouting"]["medium"] = "yam-codex/medium".into();
        value["piRouting"]["rules"]["v"] = 2.into();
        value["piRouting"]["rules"]["fallback"]["model"] = "medium".into();
        value["piRouting"]["rules"]["rules"][2]["model"] = "medium".into();
        assert_eq!(
            serde_json::from_slice::<Value>(&encode(&value.to_string()).unwrap()).unwrap(),
            value
        );
        for medium in [
            serde_json::json!(null),
            serde_json::json!("p/paid"),
            serde_json::json!(""),
        ] {
            let mut invalid = value.clone();
            invalid["piRouting"]["medium"] = medium;
            assert!(encode(&invalid.to_string()).is_err());
        }
        let mut invalid = value.clone();
        invalid["piRouting"]["rules"]["rules"][2]["model"] = "small".into();
        assert!(encode(&invalid.to_string()).is_err());
        invalid = value;
        invalid["piRouting"]["v"] = 1.into();
        assert!(encode(&invalid.to_string()).is_err());
    }
}
