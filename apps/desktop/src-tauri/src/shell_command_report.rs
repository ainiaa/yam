// Author: Jeff.Liu. Shell stdout reports are optional display metadata, never process truth.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub(crate) struct ReportedCommand {
    pub sequence: u64,
    pub phase: String,
    pub last_exit: Option<u8>,
}
pub(crate) fn decode(value: serde_json::Value) -> Option<ReportedCommand> {
    let obj = value.as_object()?;
    if obj.len() != 3 {
        return None;
    }
    let sequence = obj.get("sequence")?.as_u64()?;
    if sequence >= 9_007_199_254_740_991 {
        return None;
    }
    let phase = obj.get("phase")?.as_str()?;
    if !matches!(
        phase,
        "unknown" | "prompt" | "input" | "running" | "complete"
    ) {
        return None;
    }
    let exit = obj.get("last_exit")?;
    let last_exit = if exit.is_null() {
        None
    } else {
        Some(u8::try_from(exit.as_u64()?).ok()?)
    };
    if matches!(phase, "unknown" | "running") && last_exit.is_some() {
        return None;
    }
    Some(ReportedCommand {
        sequence,
        phase: phase.into(),
        last_exit,
    })
}
pub(crate) fn take(projection: &mut serde_json::Value) -> Option<ReportedCommand> {
    let value = projection.as_object_mut()?.remove("command_report")?;
    decode(value)
}
pub(crate) fn deserialize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ReportedCommand>, D::Error> {
    let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
    Ok(decode(value))
}
#[cfg(test)]
mod tests {
    #[test]
    fn a07c1_strict_optional_report_never_mutates_scene() {
        for phase in ["unknown", "prompt", "input", "running", "complete"] {
            assert!(super::decode(
                serde_json::json!({"sequence":0,"phase":phase,"last_exit":null})
            )
            .is_some());
        }
        for exit in [0, 1, 255] {
            assert!(super::decode(
                serde_json::json!({"sequence":1,"phase":"complete","last_exit":exit})
            )
            .is_some());
        }
        for bad in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!({"sequence":1,"phase":"complete"}),
            serde_json::json!({"sequence":1,"phase":"bad","last_exit":null}),
            serde_json::json!({"sequence":1,"phase":"running","last_exit":0}),
            serde_json::json!({"sequence":1,"phase":"unknown","last_exit":1}),
            serde_json::json!({"sequence":1,"phase":"complete","last_exit":256}),
            serde_json::json!({"sequence":1,"phase":"complete","last_exit":-1}),
            serde_json::json!({"sequence":1.5,"phase":"complete","last_exit":0}),
            serde_json::json!({"sequence":9007199254740991u64,"phase":"unknown","last_exit":null}),
            serde_json::json!({"sequence":1,"phase":"prompt","last_exit":null,"extra":true}),
        ] {
            let mut scene = serde_json::json!({"data":"screen","command_report":bad});
            assert!(super::take(&mut scene).is_none());
            assert_eq!(scene, serde_json::json!({"data":"screen"}));
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub(crate) struct PromptNavigation {
    pub version: u8,
    pub previous: bool,
    pub next: bool,
}
pub(crate) fn decode_navigation(value: serde_json::Value) -> Option<PromptNavigation> {
    let object = value.as_object()?;
    if object.len() != 3 || object.get("version")?.as_u64() != Some(1) {
        return None;
    }
    Some(PromptNavigation {
        version: 1,
        previous: object.get("previous")?.as_bool()?,
        next: object.get("next")?.as_bool()?,
    })
}
pub(crate) fn take_navigation(projection: &mut serde_json::Value) -> Option<PromptNavigation> {
    decode_navigation(projection.as_object_mut()?.remove("prompt_navigation")?)
}
pub(crate) fn deserialize_navigation<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<PromptNavigation>, D::Error> {
    Ok(decode_navigation(
        <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?,
    ))
}
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NavigationReply {
    pub status: NavigationStatus,
}
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NavigationStatus {
    Moved,
    Unavailable,
    Stale,
}
pub(crate) fn navigation_arguments(direction: &str, instance: &str) -> bool {
    matches!(direction, "previous" | "next")
        && instance.len() == 64
        && instance
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod navigation_tests {
    #[test]
    fn a07c3_optional_navigation_and_reply_are_exact() {
        for previous in [true, false] {
            for next in [true, false] {
                assert!(super::decode_navigation(
                    serde_json::json!({"version":1,"previous":previous,"next":next})
                )
                .is_some());
            }
        }
        for bad in [
            serde_json::json!(null),
            serde_json::json!({"version":1,"previous":true}),
            serde_json::json!({"version":1,"previous":true,"next":false,"extra":0}),
        ] {
            let mut scene = serde_json::json!({"data":"screen","prompt_navigation":bad});
            assert!(super::take_navigation(&mut scene).is_none());
            assert_eq!(scene, serde_json::json!({"data":"screen"}));
        }
        for status in ["moved", "unavailable", "stale"] {
            assert!(serde_json::from_value::<super::NavigationReply>(
                serde_json::json!({"status":status})
            )
            .is_ok());
        }
        for bad in [
            serde_json::json!({"status":"other"}),
            serde_json::json!({"status":"moved","extra":0}),
            serde_json::json!(null),
        ] {
            assert!(serde_json::from_value::<super::NavigationReply>(bad).is_err());
        }
        assert!(!super::navigation_arguments("previous", &"A".repeat(64)));
    }
}
