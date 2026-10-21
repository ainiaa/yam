// Author: Jeff.Liu. Typed system OpenSSH launch; no configuration/key reads.
use serde::{Deserialize, Serialize};
use std::net::Ipv6Addr;
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SshLaunch {
    pub host: String,
    #[serde(deserialize_with = "super::required_nullable")]
    pub user: Option<String>,
    #[serde(deserialize_with = "super::required_nullable")]
    pub port: Option<u16>,
}
impl<'de> Deserialize<'de> for SshLaunch {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            host: String,
            #[serde(deserialize_with = "super::required_nullable")]
            user: Option<String>,
            #[serde(deserialize_with = "super::required_nullable")]
            port: Option<u16>,
        }
        let fields = Fields::deserialize(deserializer)?;
        let value = Self {
            host: fields.host,
            user: fields.user,
            port: fields.port,
        };
        validate(&value).map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}
fn safe_name(value: &str, max: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}
pub fn validate(ssh: &SshLaunch) -> Result<(), String> {
    if !(safe_name(&ssh.host, 253)
        || (ssh.host.len() <= 253
            && ssh.host.is_ascii()
            && ssh.host.contains(':')
            && ssh.host.parse::<Ipv6Addr>().is_ok()))
        || ssh.user.as_ref().is_some_and(|v| !safe_name(v, 64))
        || ssh.port == Some(0)
    {
        return Err("ssh_invalid".into());
    }
    Ok(())
}
pub fn standalone(ssh: Option<&SshLaunch>, mixed: bool) -> Result<bool, String> {
    if let Some(ssh) = ssh {
        validate(ssh)?;
        if mixed {
            return Err("ssh_invalid_combination".into());
        }
        return Ok(true);
    }
    Ok(false)
}
pub fn title(ssh: &SshLaunch) -> String {
    format!(
        "SSH {}{}{}",
        ssh.user
            .as_ref()
            .map(|v| format!("{v}@"))
            .unwrap_or_default(),
        if ssh.host.parse::<Ipv6Addr>().is_ok() {
            format!("[{}]", ssh.host)
        } else {
            ssh.host.clone()
        },
        ssh.port.map(|v| format!(":{v}")).unwrap_or_default()
    )
}
pub fn command_with_availability(
    ssh: &SshLaunch,
    mac: bool,
    available: bool,
) -> Result<portable_pty::CommandBuilder, String> {
    validate(ssh)?;
    if !mac || !available {
        return Err("ssh_unavailable".into());
    }
    let mut b = portable_pty::CommandBuilder::new("/usr/bin/ssh");
    if let Some(port) = ssh.port {
        b.arg("-p");
        b.arg(port.to_string());
    }
    b.arg("--");
    b.arg(
        ssh.user
            .as_ref()
            .map(|u| format!("{u}@{}", ssh.host))
            .unwrap_or_else(|| ssh.host.clone()),
    );
    Ok(b)
}
pub fn command(ssh: &SshLaunch) -> Result<portable_pty::CommandBuilder, String> {
    #[cfg(unix)]
    let available = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata("/usr/bin/ssh")
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    #[cfg(not(unix))]
    let available = false;
    command_with_availability(ssh, cfg!(target_os = "macos"), available)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> SshLaunch {
        SshLaunch {
            host: "Alias_1".into(),
            user: Some("jeff".into()),
            port: Some(2222),
        }
    }
    #[test]
    fn d03a_literal_argv_and_nullable_defaults() {
        let ssh = value();
        assert!(validate(&ssh).is_ok());
        let b = command_with_availability(&ssh, true, true).unwrap();
        assert_eq!(
            b.get_argv(),
            &["/usr/bin/ssh", "-p", "2222", "--", "jeff@Alias_1"].map(std::ffi::OsString::from)
        );
        let b = command_with_availability(
            &SshLaunch {
                host: "alias".into(),
                user: None,
                port: None,
            },
            true,
            true,
        )
        .unwrap();
        assert_eq!(
            b.get_argv(),
            &["/usr/bin/ssh", "--", "alias"].map(std::ffi::OsString::from)
        );
    }
    #[test]
    fn d03a_strict_shapes_and_unsupported_grammar() {
        for raw in [
            r#"{"host":"x","user":null}"#,
            r#"{"host":"x","port":null}"#,
            r#"{"host":"x","user":null,"port":null,"x":1}"#,
            r#"{"host":"x","user":null,"port":65536}"#,
        ] {
            assert!(serde_json::from_str::<SshLaunch>(raw).is_err());
        }
        for host in ["-x", "a@b", "a:b", "a/b", "a b", "x;id", "中"] {
            let mut ssh = value();
            ssh.host = host.into();
            assert!(validate(&ssh).is_err());
        }
        assert!(command_with_availability(&value(), false, true).is_err());
        assert!(command_with_availability(&value(), true, false).is_err());
    }
    #[test]
    fn d03a_invalid_stored_grammar_rejected_on_decode() {
        assert!(
            serde_json::from_str::<SshLaunch>(r#"{"host":"x;id","user":null,"port":null}"#)
                .is_err()
        );
    }
    #[test]
    fn d03a_boundaries() {
        for port in [1, 65535] {
            assert!(validate(&SshLaunch {
                host: "a".repeat(253),
                user: Some("u".repeat(64)),
                port: Some(port)
            })
            .is_ok());
        }
        for ssh in [
            SshLaunch {
                host: "a".repeat(254),
                user: None,
                port: None,
            },
            SshLaunch {
                host: "a".into(),
                user: Some("u".repeat(65)),
                port: None,
            },
            SshLaunch {
                host: "a".into(),
                user: None,
                port: Some(0),
            },
        ] {
            assert!(validate(&ssh).is_err());
        }
    }
    #[test]
    fn d03b_ipv6_native_validation_spelling_title_and_literal_argv() {
        for host in [
            "::1",
            "::",
            "2001:db8::1",
            "2001:0DB8:0000:0000:0000:0000:0000:0001",
            "1:2:3:4:5:6:7:8",
            "::ffff:192.0.2.1",
            "::192.0.2.1",
        ] {
            let ssh = SshLaunch {
                host: host.into(),
                user: Some("jeff".into()),
                port: Some(2222),
            };
            assert!(validate(&ssh).is_ok(), "{host}");
            assert_eq!(
                command_with_availability(&ssh, false, true).unwrap_err(),
                "ssh_unavailable"
            );
            assert_eq!(
                command_with_availability(&ssh, true, false).unwrap_err(),
                "ssh_unavailable"
            );
            assert_eq!(title(&ssh), format!("SSH jeff@[{host}]:2222"));
            let command = command_with_availability(&ssh, true, true).unwrap();
            assert_eq!(
                command.get_argv(),
                &["/usr/bin/ssh", "-p", "2222", "--", &format!("jeff@{host}")]
                    .map(std::ffi::OsString::from)
            );
            assert_eq!(
                serde_json::from_value::<SshLaunch>(serde_json::to_value(&ssh).unwrap()).unwrap(),
                ssh
            );
        }
    }
    #[test]
    fn d03b_ipv6_native_invalid_matrix_and_bare_only() {
        for host in [
            ":",
            ":::1",
            "2001::db8::1",
            "1:2:3:4:5:6:7",
            "1:2:3:4:5:6:7:8:9",
            "12345::1",
            "gg::1",
            "::ffff:192.0.2.256",
            "::ffff:192.00.2.1",
            "[::1]",
            "fe80::1%en0",
            "fe80::1%3",
            "fe80::1%25en0",
            "::1/128",
            "ssh://[::1]",
            "::1?x",
            "::1#x",
            "::1\n",
            "::1;id",
            "中::1",
        ] {
            let ssh = SshLaunch {
                host: host.into(),
                user: None,
                port: None,
            };
            assert!(validate(&ssh).is_err(), "{host}");
            assert!(
                serde_json::from_value::<SshLaunch>(serde_json::to_value(&ssh).unwrap()).is_err()
            );
            assert!(command_with_availability(&ssh, true, true).is_err());
        }
    }
}
