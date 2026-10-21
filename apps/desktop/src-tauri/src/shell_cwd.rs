// Author: Jeff.Liu. OSC 7 is untrusted display metadata, never directory authority.
#[derive(Clone, Copy)]
pub(crate) enum Platform {
    Unix,
    Windows,
}
pub(crate) fn parse_uri(uri: &str, platform: Platform) -> Option<String> {
    if uri.len() > 4096 || uri.chars().any(char::is_control) || uri.contains(['?', '#', '\\']) {
        return None;
    }
    let rest = uri.strip_prefix("file://")?;
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let raw = &rest.as_bytes()[slash..];
    let mut bytes = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        let byte = if raw[index] == b'%' {
            let hex = |b: u8| (b as char).to_digit(16).map(|v| v as u8);
            let value = hex(*raw.get(index + 1)?)? * 16 + hex(*raw.get(index + 2)?)?;
            if value == b'/' || value == b'\\' {
                return None;
            }
            index += 3;
            value
        } else {
            let value = raw[index];
            index += 1;
            value
        };
        bytes.push(byte);
    }
    let path = String::from_utf8(bytes).ok()?;
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || path.split('/').any(|s| s == "." || s == "..")
        || path.starts_with("//")
    {
        return None;
    }
    let drive = path.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(2) == Some(&b':')
        && path.as_bytes().get(3) == Some(&b'/');
    match platform {
        Platform::Unix if !drive => Some(path),
        Platform::Windows if drive => Some(path[1..].to_owned()),
        _ => None,
    }
}

pub(crate) fn current_platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Unix
    }
}
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub(crate) struct ReportedCwd {
    pub path: Option<String>,
    pub sequence: u64,
}
fn sequence(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().filter(|s| *s <= 9_007_199_254_740_991)
}
fn valid_path(path: &str, platform: Platform) -> bool {
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || path.contains('\\')
        || path.split('/').any(|s| s == "." || s == "..")
    {
        return false;
    }
    match platform {
        Platform::Unix => {
            path.starts_with('/')
                && !path.starts_with("//")
                && !(path.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic)
                    && path.as_bytes().get(2) == Some(&b':')
                    && path.as_bytes().get(3) == Some(&b'/'))
        }
        Platform::Windows => {
            path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && path.as_bytes().get(1) == Some(&b':')
                && path.as_bytes().get(2) == Some(&b'/')
        }
    }
}
pub(crate) fn decode_report(value: serde_json::Value, platform: Platform) -> Option<ReportedCwd> {
    let obj = value.as_object()?;
    if obj.len() != 2 {
        return None;
    }
    let sequence = sequence(obj.get("sequence")?)?;
    let path = match obj.get("path")? {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) if valid_path(s, platform) => Some(s.clone()),
        _ => return None,
    };
    if sequence == 9_007_199_254_740_991 && path.is_some() {
        return None;
    }
    Some(ReportedCwd { path, sequence })
}
pub(crate) fn deserialize_report<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ReportedCwd>, D::Error> {
    use serde::Deserialize;
    Ok(decode_report(
        serde_json::Value::deserialize(deserializer)?,
        current_platform(),
    ))
}
pub(crate) fn take_report(
    projection: &mut serde_json::Value,
    platform: Platform,
) -> Option<ReportedCwd> {
    let value = projection.as_object_mut()?.remove("cwd_report")?;
    let obj = value.as_object()?;
    if obj.len() != 2 {
        return None;
    }
    let sequence = sequence(obj.get("sequence")?)?;
    let path = match obj.get("uri")? {
        serde_json::Value::String(uri) if sequence < 9_007_199_254_740_991 => {
            parse_uri(uri, platform)
        }
        serde_json::Value::String(_) | serde_json::Value::Null => None,
        _ => return None,
    };
    Some(ReportedCwd { path, sequence })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closure_t18_direct_report_dto_validates_platform_shape_sequence_and_byte_budget() {
        const MAX: u64 = 9_007_199_254_740_991;
        for platform in [Platform::Unix, Platform::Windows] {
            let prefix = match platform {
                Platform::Unix => "/",
                Platform::Windows => "C:/",
            };
            for path in [
                prefix.to_string(),
                format!("{prefix}space 文件"),
                format!("{prefix}{}", "x".repeat(4096 - prefix.len())),
            ] {
                let report =
                    decode_report(serde_json::json!({"path":path,"sequence":MAX-1}), platform)
                        .unwrap();
                assert_eq!(report.path.as_deref(), Some(path.as_str()));
                assert_eq!(report.sequence, MAX - 1);
            }
            for sequence in [0, MAX] {
                let report = decode_report(
                    serde_json::json!({"path":null,"sequence":sequence}),
                    platform,
                )
                .unwrap();
                assert!(report.path.is_none());
                assert_eq!(report.sequence, sequence);
            }
            assert!(
                decode_report(serde_json::json!({"path":prefix,"sequence":MAX}), platform)
                    .is_none()
            );
            assert!(decode_report(
                serde_json::json!({"path":format!("{prefix}{}","é".repeat(2048)),"sequence":1}),
                platform
            )
            .is_none());
            for path in [
                "",
                "relative",
                "//server/share",
                "C:\\work",
                "/tmp/../outside",
                "/tmp/./file",
                "/tmp/\u{0}",
                "/tmp/\u{85}",
            ] {
                assert!(
                    decode_report(serde_json::json!({"path":path,"sequence":1}), platform)
                        .is_none(),
                    "{path:?}"
                );
            }
            for sequence in [
                serde_json::json!(-1),
                serde_json::json!(MAX + 1),
                serde_json::json!(u64::MAX),
                serde_json::json!(1.0),
                serde_json::json!("1"),
                serde_json::json!(true),
                serde_json::Value::Null,
            ] {
                assert!(decode_report(
                    serde_json::json!({"path":null,"sequence":sequence}),
                    platform
                )
                .is_none());
            }
            for value in [
                serde_json::json!(null),
                serde_json::json!([]),
                serde_json::json!({}),
                serde_json::json!({"path":null}),
                serde_json::json!({"sequence":1}),
                serde_json::json!({"path":true,"sequence":1}),
                serde_json::json!({"path":null,"sequence":1,"extra":0}),
            ] {
                assert!(decode_report(value, platform).is_none());
            }
        }
        assert!(decode_report(
            serde_json::json!({"path":"C:/work","sequence":1}),
            Platform::Windows
        )
        .is_some());
        assert!(decode_report(
            serde_json::json!({"path":"C:/work","sequence":1}),
            Platform::Unix
        )
        .is_none());
        assert!(decode_report(
            serde_json::json!({"path":"/C:/work","sequence":1}),
            Platform::Unix
        )
        .is_none());
        assert!(decode_report(
            serde_json::json!({"path":"/work","sequence":1}),
            Platform::Windows
        )
        .is_none());
    }

    #[test]
    fn closure_t18_invalid_optional_cwd_deserialization_keeps_the_terminal_payload() {
        #[derive(serde::Deserialize)]
        struct Frame {
            data: String,
            #[serde(default, deserialize_with = "deserialize_report")]
            cwd: Option<ReportedCwd>,
        }
        for value in [
            serde_json::json!(null),
            serde_json::json!({"path":"relative","sequence":1}),
            serde_json::json!({"path":null,"sequence":"bad"}),
        ] {
            let frame: Frame =
                serde_json::from_value(serde_json::json!({"data":"unchanged screen","cwd":value}))
                    .unwrap();
            assert!(frame.cwd.is_none());
            assert_eq!(frame.data, "unchanged screen");
        }
        let frame: Frame =
            serde_json::from_value(serde_json::json!({"data":"unchanged screen"})).unwrap();
        assert!(frame.cwd.is_none());
    }
    #[test]
    fn a07a_snapshot_optional_metadata_removal_preserves_screen_and_latest_clear() {
        for (uri, path) in [
            ("file:///tmp", Some("/tmp")),
            ("file://remote/tmp", None),
            ("file:///tmp/%2fetc", None),
        ] {
            let mut projection =
                serde_json::json!({"data":"screen","cwd_report":{"uri":uri,"sequence":3}});
            let report = take_report(&mut projection, Platform::Unix).unwrap();
            assert_eq!(report.path.as_deref(), path);
            assert_eq!(report.sequence, 3);
            assert!(projection.get("cwd_report").is_none());
            assert_eq!(projection["data"], "screen");
        }
        for report in [
            serde_json::json!({"uri":"file:///tmp","sequence":-1}),
            serde_json::json!({"uri":true,"sequence":1}),
            serde_json::json!({"uri":"file:///tmp","sequence":1,"extra":true}),
        ] {
            let mut projection = serde_json::json!({"data":"screen","cwd_report":report});
            assert!(take_report(&mut projection, Platform::Unix).is_none());
            assert!(projection.get("cwd_report").is_none());
            assert_eq!(projection["data"], "screen");
        }
        let mut saturated = serde_json::json!({"cwd_report":{"uri":"file:///tmp","sequence":9_007_199_254_740_991u64}});
        assert!(take_report(&mut saturated, Platform::Unix)
            .unwrap()
            .path
            .is_none());
    }

    #[test]
    fn a07a_uri_normal_and_platform_boundaries() {
        assert_eq!(
            parse_uri("file:///tmp/a%20b/中", Platform::Unix),
            Some("/tmp/a b/中".into())
        );
        assert_eq!(
            parse_uri("file://LOCALHOST/", Platform::Unix),
            Some("/".into())
        );
        assert_eq!(
            parse_uri("file:///C:/work/a%20b", Platform::Windows),
            Some("C:/work/a b".into())
        );
        assert_eq!(
            parse_uri("file:///C:/", Platform::Windows),
            Some("C:/".into())
        );
        assert_eq!(
            parse_uri("file:///tmp/%252f%3f%23+", Platform::Unix),
            Some("/tmp/%2f?#+".into())
        );
        assert!(parse_uri("file:///C:/work", Platform::Unix).is_none());
        assert!(parse_uri("file:///tmp", Platform::Windows).is_none());
    }
    #[test]
    fn a07a_uri_rejects_malformed_remote_ambiguous_and_controls() {
        for uri in [
            "",
            "https:///tmp",
            "FILE:///tmp",
            "file://host/tmp",
            "file://localhost:80/tmp",
            "file://user@localhost/tmp",
            "file://localhost/tmp?q",
            "file:///tmp#f",
            "file:///tmp/%",
            "file:///tmp/%GG",
            "file:///tmp/%ff",
            "file:///tmp/%00",
            "file:///tmp/%0a",
            "file:///tmp/%7f",
            "file:///tmp/%C2%85",
            "file:///tmp/%2fetc",
            "file:///tmp/%5Cetc",
            "file:///tmp/..",
            "file:///tmp/%2e/next",
            "file:///tmp\\bad",
            "file:relative",
        ] {
            assert!(parse_uri(uri, Platform::Unix).is_none(), "{uri}");
        }
        for uri in [
            "file:///C:relative",
            "file:////host/share",
            "file:///1:/tmp",
        ] {
            assert!(parse_uri(uri, Platform::Windows).is_none(), "{uri}");
        }
    }
    #[test]
    fn a07a_uri_utf8_budget_is_bytes_not_characters() {
        let uri = format!("file:///{}", "é".repeat(2044));
        assert_eq!(uri.len(), 4096);
        assert!(parse_uri(&uri, Platform::Unix).is_some());
        assert!(parse_uri(&(uri + "x"), Platform::Unix).is_none());
    }
}
