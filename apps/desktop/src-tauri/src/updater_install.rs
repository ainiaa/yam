// Author: Jeff.Liu. Keep a local macOS backup until the installed identity and signature pass.
use std::path::Path;
#[cfg(target_os = "macos")]
fn command(program: &str, args: &[&str]) -> Result<std::process::Output, &'static str> {
    let mut budget = crate::git_context::Budget {
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(90),
        remaining: 64 * 1024,
    };
    let output = budget
        .run_env(Path::new(program), args, Path::new("/"), &[])
        .map_err(|_| "operation_failed")?;
    if !output.status.success() {
        return Err("operation_failed");
    }
    Ok(output)
}
#[cfg(target_os = "macos")]
fn transaction(
    bundle: &Path,
    copy: impl FnOnce(&Path, &Path) -> Result<(), &'static str>,
    apply: impl FnOnce() -> Result<(), &'static str>,
    validate: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    use std::os::unix::fs::DirBuilderExt;
    if bundle.file_name().and_then(|n| n.to_str()) != Some("YAM.app")
        || !bundle.is_dir()
        || std::fs::symlink_metadata(bundle)
            .map_err(|_| "manual_install_required")?
            .file_type()
            .is_symlink()
    {
        return Err("manual_install_required");
    }
    let parent = bundle.parent().ok_or("manual_install_required")?;
    let stage = parent.join(format!(
        ".YAM-update-{}",
        crate::agent_bridge::credential().map_err(|_| "operation_failed")?
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|_| "manual_install_required")?;
    let backup = stage.join("YAM.app");
    if let Err(error) = copy(bundle, &backup) {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        apply().and_then(|_| validate())
    }))
    .unwrap_or(Err("operation_failed"));
    if result.is_err() {
        let failed = stage.join("failed.app");
        if (bundle.exists() && std::fs::rename(bundle, &failed).is_err())
            || std::fs::rename(&backup, bundle).is_err()
        {
            eprintln!(
                "[YAM] Update rollback requires recovery from {}",
                backup.display()
            );
            return Err("rollback_failed");
        }
    }
    let _ = std::fs::remove_dir_all(stage);
    result
}
pub(super) fn install(
    update: &tauri_plugin_updater::Update,
    bytes: &[u8],
) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().map_err(|_| "operation_failed")?;
        let bundle = executable
            .ancestors()
            .nth(3)
            .ok_or("manual_install_required")?;
        let path = bundle.to_str().ok_or("manual_install_required")?;
        transaction(
            bundle,
            |from, to| {
                command(
                    "/usr/bin/ditto",
                    &[
                        "--noqtn",
                        from.to_str().ok_or("operation_failed")?,
                        to.to_str().ok_or("operation_failed")?,
                    ],
                )
                .map(|_| ())
            },
            || update.install(bytes).map_err(|_| "operation_failed"),
            || {
                command(
                    "/usr/bin/codesign",
                    &["--verify", "--deep", "--strict", path],
                )?;
                let plist = bundle.join("Contents/Info.plist");
                let plist = plist.to_str().ok_or("operation_failed")?;
                for (field, expected) in [
                    ("CFBundleIdentifier", "com.yam.desktop"),
                    ("CFBundleShortVersionString", update.version.as_str()),
                ] {
                    let output = command(
                        "/usr/bin/plutil",
                        &["-extract", field, "raw", "-o", "-", plist],
                    )?;
                    if String::from_utf8_lossy(&output.stdout).trim() != expected {
                        return Err("operation_failed");
                    }
                }
                Ok(())
            },
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        update.install(bytes).map_err(|_| "operation_failed")
    }
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn update_backup_restores_install_or_validation_failures_and_cleans_owned_stage() {
        for outcome in [
            "success",
            "install_error",
            "validation_error",
            "copy_error",
            "install_panic",
            "validation_panic",
        ] {
            let root = std::env::temp_dir()
                .join(format!("yam-update-backup-{}", crate::next_session_id()));
            std::fs::create_dir(&root).unwrap();
            let bundle = root.join("YAM.app");
            std::fs::create_dir(&bundle).unwrap();
            std::fs::write(bundle.join("version"), "old").unwrap();
            let result = transaction(
                &bundle,
                |from, to| {
                    if outcome == "copy_error" {
                        return Err("operation_failed");
                    }
                    std::fs::create_dir(to).unwrap();
                    std::fs::copy(from.join("version"), to.join("version")).unwrap();
                    Ok(())
                },
                || {
                    std::fs::remove_dir_all(&bundle).unwrap();
                    std::fs::create_dir(&bundle).unwrap();
                    std::fs::write(bundle.join("version"), "new").unwrap();
                    if outcome == "install_panic" {
                        panic!("owned installer panic");
                    }
                    if outcome == "install_error" {
                        Err("operation_failed")
                    } else {
                        Ok(())
                    }
                },
                || {
                    if outcome == "validation_panic" {
                        panic!("owned validation panic");
                    }
                    if outcome == "validation_error" {
                        Err("operation_failed")
                    } else {
                        Ok(())
                    }
                },
            );
            assert_eq!(result.is_ok(), outcome == "success");
            assert_eq!(
                std::fs::read_to_string(bundle.join("version")).unwrap(),
                if outcome == "success" { "new" } else { "old" }
            );
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn update_backup_rejects_other_apps_before_mutation() {
        assert_eq!(
            transaction(
                Path::new("/tmp/Other.app"),
                |_, _| panic!("copy"),
                || panic!("install"),
                || panic!("validate")
            )
            .unwrap_err(),
            "manual_install_required"
        );
    }
}
