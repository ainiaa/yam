// Author: Jeff.Liu. Explicit local file metadata only; no content reads or default application launch.
use serde::Serialize;
use std::path::Path;
const ERROR: &str = "terminal_file_unavailable";
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(super) struct Preview {
    pub path: String,
    pub canonical: String,
}
pub(super) fn literal(path: &str) -> Result<(), String> {
    if !path.starts_with('/')||path.len()>4096||path.chars().any(|c|c.is_control()||matches!(c,'\u{61c}'|'\u{200e}'|'\u{200f}'|'\u{2028}'..='\u{202e}'|'\u{2066}'..='\u{2069}')){return Err(ERROR.into());}
    Ok(())
}
fn canonical_text(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or_else(|| ERROR.to_string())?;
    literal(value)?;
    Ok(value.into())
}
pub(super) fn preview(path: &str) -> Result<Preview, String> {
    literal(path)?;
    let canonical = std::fs::canonicalize(path).map_err(|_| ERROR.to_string())?;
    if !std::fs::metadata(&canonical)
        .map_err(|_| ERROR.to_string())?
        .is_file()
    {
        return Err(ERROR.into());
    }
    let canonical = canonical_text(&canonical)?;
    Ok(Preview {
        path: path.into(),
        canonical,
    })
}
pub(super) fn reveal(
    path: &str,
    expected: &str,
    check: impl FnOnce() -> Result<(), String>,
    native: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    literal(expected)?;
    let current = preview(path)?;
    if current.canonical != expected {
        return Err(ERROR.into());
    }
    check()?;
    native(Path::new(&current.canonical))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-a04b2-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn a04b2_literal_budget_and_controls() {
        for value in [
            "",
            "relative",
            "~/file",
            "file:///a",
            "/a\n",
            "/a\u{85}",
            "/a\u{202e}",
            "/a\u{2028}",
            "/a\u{2029}",
        ] {
            assert!(literal(value).is_err(), "{value:?}");
        }
        assert!(literal(&format!("/{}", "é".repeat(2048))).is_err());
        assert!(literal(&format!("/{}", "a".repeat(4095))).is_ok());
        assert!(literal("/a b/文件%20:12 ").is_ok());
    }
    #[test]
    fn a04b2_regular_only_and_missing() {
        let f = Fixture::new();
        let file = f.0.join("space %20:12 文件");
        std::fs::write(&file, []).unwrap();
        assert!(preview(file.to_str().unwrap()).is_ok());
        assert!(preview(f.0.to_str().unwrap()).is_err());
        assert!(preview(f.0.join("missing").to_str().unwrap()).is_err());
    }
    #[test]
    fn a04b2_confirm_guard_and_changed_target_do_not_reveal() {
        let f = Fixture::new();
        let file = f.0.join("file");
        std::fs::write(&file, []).unwrap();
        let path = file.to_str().unwrap();
        let p = preview(path).unwrap();
        assert!(reveal(
            path,
            "/different",
            || Ok(()),
            |_| panic!("no native reveal")
        )
        .is_err());
        assert!(reveal(
            path,
            &p.canonical,
            || Err("old epoch".into()),
            |_| panic!("no native reveal")
        )
        .is_err());
        let mut calls = 0;
        reveal(
            path,
            &p.canonical,
            || Ok(()),
            |_| {
                calls += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
    }
    #[cfg(unix)]
    #[test]
    fn a04b2_symlink_regular_target_and_swap() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let file = f.0.join("file");
        std::fs::write(&file, []).unwrap();
        let link = f.0.join("link");
        symlink(&file, &link).unwrap();
        let path = link.to_str().unwrap();
        let p = preview(path).unwrap();
        assert_eq!(
            p.canonical,
            std::fs::canonicalize(&file).unwrap().to_str().unwrap()
        );
        std::fs::remove_file(&link).unwrap();
        symlink(&f.0, &link).unwrap();
        assert!(reveal(
            path,
            &p.canonical,
            || Ok(()),
            |_| panic!("no native reveal")
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a04b2_non_utf8_canonical_rejected_without_lossy_conversion() {
        use std::os::unix::ffi::OsStringExt;
        let path = std::path::PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', 255]));
        assert!(canonical_text(&path).is_err());
    }
}
