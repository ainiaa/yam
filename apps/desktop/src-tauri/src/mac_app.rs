// Author: Jeff.Liu. Keep the resident owner distinct from the GUI in Launch Services.
use std::path::{Path, PathBuf};
const HELPER: &str = "Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background";

pub(super) fn is_helper(executable: &Path) -> bool {
    executable.ends_with(HELPER)
        && executable
            .ancestors()
            .nth(6)
            .is_some_and(|p| p.extension().is_some_and(|e| e == "app"))
}
pub(super) fn desktop_bundle(executable: &Path) -> Option<PathBuf> {
    let bundle = if is_helper(executable) {
        executable.ancestors().nth(6)?
    } else if executable.ends_with("Contents/MacOS/yam-desktop") {
        executable.ancestors().nth(3)?
    } else {
        return None;
    };
    (bundle.extension().is_some_and(|e| e == "app")).then(|| bundle.to_path_buf())
}
pub(super) fn background_executable(executable: &Path) -> Result<PathBuf, String> {
    let Some(bundle) = desktop_bundle(executable) else {
        return Ok(executable.into());
    };
    let helper = bundle.join(HELPER);
    let metadata = std::fs::symlink_metadata(&helper)
        .map_err(|_| "YAM background helper is missing; reinstall YAM")?;
    use std::os::unix::fs::PermissionsExt;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err("YAM background helper is invalid; reinstall YAM".into());
    }
    Ok(helper)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("yam-helper-{}", crate::next_session_id()));
        fs::create_dir_all(root.join("YAM app.app/Contents/MacOS")).unwrap();
        root
    }
    #[test]
    fn main_and_helper_resolve_to_the_same_gui_but_distinct_owner() {
        let root = fixture();
        let app = root.join("YAM app.app");
        let gui = app.join("Contents/MacOS/yam-desktop");
        fs::write(&gui, b"gui").unwrap();
        assert!(
            background_executable(&gui).is_err(),
            "packaged GUI must not impersonate missing helper"
        );
        let helper = app.join("Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background");
        fs::create_dir_all(helper.parent().unwrap()).unwrap();
        fs::write(&helper, b"helper").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(background_executable(&gui).unwrap(), helper);
        assert_eq!(background_executable(&helper).unwrap(), helper);
        assert_eq!(desktop_bundle(&gui), Some(app.clone()));
        assert_eq!(desktop_bundle(&helper), Some(app));
        assert!(is_helper(&helper));
        assert!(!is_helper(&gui));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unbundled_development_keeps_its_executable_and_symlink_helper_is_rejected() {
        let root = fixture();
        let dev = root.join("debug/yam-desktop");
        assert_eq!(background_executable(&dev).unwrap(), dev);
        assert_eq!(desktop_bundle(&dev), None);
        let gui = root.join("YAM app.app/Contents/MacOS/yam-desktop");
        let helper = root
            .join("YAM app.app/Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background");
        fs::create_dir_all(helper.parent().unwrap()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&gui, &helper).unwrap();
            assert!(background_executable(&gui).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unrelated_nested_apps_are_not_mistaken_for_the_yam_helper() {
        assert!(!is_helper(std::path::Path::new(
            "/tmp/Other.app/Contents/MacOS/yam-background"
        )));
        assert_eq!(
            desktop_bundle(std::path::Path::new("/tmp/Other.app/Contents/MacOS/other")),
            None
        );
    }
}
