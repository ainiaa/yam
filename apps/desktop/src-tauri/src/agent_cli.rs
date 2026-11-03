// Author: Jeff.Liu. Shared executable discovery for the picker and actual launches.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[cfg(unix)]
pub(crate) fn search_path(path: &OsStr, home: Option<&Path>) -> std::ffi::OsString {
    let mut directories: Vec<_> = std::env::split_paths(path).collect();
    let mut fallback = Vec::new();
    if let Some(home) = home.filter(|p| p.is_absolute()) {
        // Explicit manager defaults precede generic fallbacks, never the inherited PATH.
        if let Some(bin) = nvm_default_bin(&home.join(".nvm")) {
            fallback.push(bin);
        }
        fallback.extend(
            [
                "Library/Application Support/fnm/aliases/default/bin",
                ".local/share/fnm/aliases/default/bin",
                ".fnm/aliases/default/bin",
                ".volta/bin",
                ".bun/bin",
                "Library/pnpm/bin",
                "Library/pnpm",
                ".local/share/pnpm/bin",
                ".local/share/pnpm",
                ".opencode/bin",
                ".asdf/shims",
                ".local/share/mise/shims",
            ]
            .map(|relative| home.join(relative)),
        );
    }
    fallback.push(PathBuf::from("/usr/local/bin"));
    #[cfg(target_os = "macos")]
    fallback.push(PathBuf::from("/opt/homebrew/bin"));
    if let Some(home) = home.filter(|p| p.is_absolute()) {
        fallback.extend([home.join(".local/bin"), home.join(".npm-global/bin")]);
    }
    for directory in fallback {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    std::env::join_paths(directories).unwrap_or_else(|_| path.to_os_string())
}

fn version_parts(value: &str) -> Option<Vec<u32>> {
    value
        .split('.')
        .map(|part| {
            if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                part.parse().ok()
            } else {
                None
            }
        })
        .collect()
}

#[cfg(unix)]
fn nvm_default_bin(root: &Path) -> Option<PathBuf> {
    let mut alias = "default".to_string();
    for _ in 0..8 {
        if alias.is_empty()
            || !Path::new(&alias)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        match std::fs::read_to_string(root.join("alias").join(&alias)) {
            Ok(next) => {
                alias = next.trim().to_string();
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        let prefix = if matches!(alias.as_str(), "node" | "stable") {
            Vec::new()
        } else {
            version_parts(alias.strip_prefix('v').unwrap_or(&alias))?
        };
        if prefix.len() > 3 {
            return None;
        }
        let mut versions = Vec::new();
        for entry in std::fs::read_dir(root.join("versions/node"))
            .ok()?
            .flatten()
        {
            let filename = entry.file_name();
            let Some(value) = filename.to_str().and_then(|s| s.strip_prefix('v')) else {
                continue;
            };
            let Some(parts) =
                version_parts(value).filter(|v| v.len() == 3 && v.starts_with(&prefix))
            else {
                continue;
            };
            let bin = entry.path().join("bin");
            if executable(&bin.join("node")) {
                versions.push((parts, bin));
            }
        }
        return versions
            .into_iter()
            .max_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, bin)| bin);
    }
    None
}

pub(crate) fn find_on_path(name: &str, path: &OsStr) -> Option<PathBuf> {
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(name);
        if executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        for extension in [".exe", ".cmd", ".bat"] {
            let candidate = directory.join(format!("{name}{extension}"));
            if executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}
fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
pub(crate) fn find(name: &str, path: &OsStr, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(found) = find_on_path(name, path) {
        return Some(found);
    }
    #[cfg(target_os = "macos")]
    {
        let home = home.filter(|p| p.is_absolute())?;
        // Native installers and desktop-managed CLIs can exist without their PATH symlink.
        let (root, suffix) = match name {
            "claude" => (home.join(".local/share/claude/versions"), String::new()),
            "codex" => (
                home.join(".codex/packages/app-server-daemon/releases"),
                format!("-{}-apple-darwin", std::env::consts::ARCH),
            ),
            _ => return None,
        };
        let mut versions = Vec::new();
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let filename = entry.file_name();
                let Some(filename) = filename.to_str() else {
                    continue;
                };
                let Some(version) = filename.strip_suffix(&suffix) else {
                    continue;
                };
                let Some(parts) = version_parts(version).filter(|v| v.len() == 3) else {
                    continue;
                };
                let candidate = if name == "codex" {
                    entry.path().join("bin/codex")
                } else {
                    entry.path()
                };
                if executable(&candidate) {
                    versions.push((parts, candidate));
                }
            }
        }
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((_, candidate)) = versions.into_iter().next() {
            return Some(candidate);
        }
        if name == "codex" {
            let candidate = home.join(".codex/plugins/.plugin-appserver/codex-cli/bin/codex");
            if executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = home;
    None
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
    };
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                    "yam-cli-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                )))
        }
        fn file(&self, path: &str, executable: bool) -> PathBuf {
            let p = self.0.join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(
                &p,
                fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
            )
            .unwrap();
            p
        }
        fn find(&self, name: &str) -> Option<PathBuf> {
            find(
                name,
                std::ffi::OsStr::new("/nonexistent-yam-cli-path"),
                Some(&self.0),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn managed_claude_uses_newest_executable_stable_version() {
        let f = Fixture::new();
        f.file(".local/share/claude/versions/2.1.9", true);
        let expected = f.file(".local/share/claude/versions/2.1.12", true);
        f.file(".local/share/claude/versions/2.1.99", false);
        f.file(".local/share/claude/versions/not-a-version", true);
        assert_eq!(f.find("claude"), Some(expected));
        assert_eq!(f.find("unknown"), None);
    }
    #[test]
    fn managed_codex_uses_numeric_versions_and_current_platform_only() {
        let f = Fixture::new();
        let prefix = ".codex/packages/app-server-daemon/releases/";
        let target = format!("{}-apple-darwin", std::env::consts::ARCH);
        f.file(&format!("{prefix}0.9.0-{target}/bin/codex"), true);
        let expected = f.file(&format!("{prefix}0.10.0-{target}/bin/codex"), true);
        f.file(&format!("{prefix}0.99.0-{target}/bin/codex"), false);
        f.file(&format!("{prefix}9.0.0-wrong-platform/bin/codex"), true);
        assert_eq!(f.find("codex"), Some(expected));
    }
    #[test]
    fn path_precedes_managed_cli_and_missing_home_or_broken_link_stays_unavailable() {
        let f = Fixture::new();
        f.file(".local/share/claude/versions/2.1.12", true);
        let cli = f.file("bin/claude", true);
        let path = std::env::join_paths([f.0.join("bin")]).unwrap();
        assert_eq!(find("claude", &path, Some(&f.0)), Some(cli));
        assert_eq!(
            find(
                "claude",
                std::ffi::OsStr::new("/nonexistent-yam-cli-path"),
                None
            ),
            None
        );
        let missing = Fixture::new();
        let link = missing.0.join(".local/share/claude/versions/9.9.9");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(Path::new("/nonexistent-yam-cli"), link).unwrap();
        assert_eq!(missing.find("claude"), None);
    }
}
