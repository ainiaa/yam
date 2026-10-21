// Author: Jeff.Liu. Independently authored from the Zsh startup and hook documentation.
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};
#[cfg(any(unix, test))]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) const WARNING: &str = "directory_reporting_unavailable";
pub(crate) const COMMAND_WARNING: &str = "command_reporting_unavailable";
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
#[cfg(any(unix, test))]
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn validate(
    enabled: bool,
    ordinary: bool,
    shell: Option<&super::ShellLaunch>,
    windows: bool,
) -> Result<(), String> {
    if enabled
        && (windows
            || !ordinary
            || shell
                .and_then(|s| s.program.as_deref())
                .is_some_and(|s| Path::new(s).file_name().is_none_or(|s| s != "zsh")))
    {
        return Err("directory_reporting_invalid_combination".into());
    }
    Ok(())
}

pub(crate) struct Assets {
    directory: PathBuf,
    created: bool,
}
type SpawnResult<T> = (T, Option<Assets>, Option<String>, Option<String>);
pub(crate) fn spawn<T, E>(
    root: &Path,
    mut builder: CommandBuilder,
    enabled: bool,
    command_enabled: bool,
    start: impl FnOnce(CommandBuilder) -> Result<T, E>,
) -> Result<SpawnResult<T>, E> {
    let qualified = builder.get_argv().first().is_some_and(|program| {
        let path = Path::new(program);
        path.is_absolute() && path.file_name() == Some(std::ffi::OsStr::new("zsh"))
    });
    let (assets, unavailable) = if enabled || command_enabled {
        if qualified {
            match prepare_modes(root, &mut builder, enabled, command_enabled) {
                Ok(assets) => (Some(assets), false),
                Err(()) => (None, true),
            }
        } else {
            (None, true)
        }
    } else {
        (None, false)
    };
    let warning = (unavailable && enabled).then(|| WARNING.into());
    let command_warning = (unavailable && command_enabled).then(|| COMMAND_WARNING.into());
    let child = start(builder)?;
    Ok((child, assets, warning, command_warning))
}
impl Drop for Assets {
    fn drop(&mut self) {
        if self.created {
            let _ = std::fs::remove_file(self.directory.join(".zshenv"));
            let _ = std::fs::remove_file(self.directory.join("integration.zsh"));
            let _ = std::fs::remove_dir(&self.directory);
        }
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(all(test, unix))]
pub(crate) fn prepare(root: &Path, builder: &mut CommandBuilder) -> Result<Assets, ()> {
    prepare_modes(root, builder, true, false)
}

#[cfg(unix)]
pub(crate) fn prepare_modes(
    root: &Path,
    builder: &mut CommandBuilder,
    cwd: bool,
    command: bool,
) -> Result<Assets, ()> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    if builder
        .get_env("ZDOTDIR")
        .is_some_and(|value| value.is_empty())
    {
        return Err(());
    }
    if ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 256).then_some(n + 1)
        })
        .is_err()
    {
        return Err(());
    }
    let base = root.join("zsh-directory-reporting");
    let directory = base.join(format!(
        "{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut assets = Assets {
        directory,
        created: false,
    };
    let trampoline = if command {
        TRAMPOLINE
            .replace(
                "  _yam_zsh_report\n",
                "  _yam_zsh_precmd \"${_yam_zsh_entry[@]}\"\n",
            )
            .replace(" _yam_zsh_report )", " _yam_zsh_precmd )")
    } else {
        TRAMPOLINE.to_string()
    };
    let integration = format!(
        "{}{}{}",
        if cwd { INTEGRATION } else { "" },
        if command { COMMAND_INTEGRATION } else { "" },
        if command && cwd {
            "\nfunction _yam_zsh_precmd_cwd { _yam_zsh_report; }; precmd_functions+=( _yam_zsh_precmd_cwd )\n"
        } else {
            ""
        }
    );
    let mut write = || -> Result<(), ()> {
        if trampoline.len() > 16384 || integration.len() > 16384 {
            return Err(());
        }
        match std::fs::DirBuilder::new().mode(0o700).create(&base) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(()),
        }
        let metadata = std::fs::symlink_metadata(&base).map_err(|_| ())?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(());
        }
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&assets.directory)
            .map_err(|_| ())?;
        assets.created = true;
        for (name, content) in [
            (".zshenv", trampoline.as_str()),
            ("integration.zsh", integration.as_str()),
        ] {
            let path = assets.directory.join(name);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .map_err(|_| ())?;
            #[cfg(test)]
            if name == "integration.zsh" {
                tests::BEFORE_ASSET_WRITE.with(|hook| {
                    let callback = hook.borrow_mut().take();
                    if let Some(callback) = callback {
                        callback(&mut file, &path);
                    }
                });
            }
            file.write_all(content.as_bytes()).map_err(|_| ())?;
        }
        Ok(())
    };
    write()?;
    let original = builder
        .get_env("ZDOTDIR")
        .map(std::ffi::OsStr::to_os_string);
    builder.env(
        "YAM_ZSH_ENV_PRESENT",
        if original.is_some() { "1" } else { "0" },
    );
    builder.env("YAM_ZSH_ENV_VALUE", original.unwrap_or_default());
    builder.env("YAM_ZSH_INIT", assets.directory.join("integration.zsh"));
    builder.env("ZDOTDIR", &assets.directory);
    Ok(assets)
}
#[cfg(not(unix))]
pub(crate) fn prepare_modes(
    _: &Path,
    _: &mut CommandBuilder,
    _: bool,
    _: bool,
) -> Result<Assets, ()> {
    Err(())
}

#[cfg(unix)]
const TRAMPOLINE: &str = r#"typeset -g _yam_zsh_present=$YAM_ZSH_ENV_PRESENT _yam_zsh_value=$YAM_ZSH_ENV_VALUE _yam_zsh_init=$YAM_ZSH_INIT
unset YAM_ZSH_ENV_PRESENT YAM_ZSH_ENV_VALUE YAM_ZSH_INIT
if [[ $_yam_zsh_present == 1 ]]; then
  export ZDOTDIR=$_yam_zsh_value
else
  unset ZDOTDIR
fi
unset _yam_zsh_present _yam_zsh_value
typeset -g _yam_zsh_original=${ZDOTDIR-$HOME}
_yam_zsh_original+=/
if [[ -r ${_yam_zsh_original}.zshenv ]]; then
  source "${_yam_zsh_original}.zshenv"
fi
unset _yam_zsh_original
function _yam_zsh_initialize {
  local -a _yam_zsh_entry=( "$?" "${pipestatus[@]}" )
  source "$_yam_zsh_init"
  unset _yam_zsh_init
  precmd_functions=( ${precmd_functions:#_yam_zsh_initialize} _yam_zsh_report )
  _yam_zsh_report
}
typeset -ga precmd_functions
precmd_functions+=( _yam_zsh_initialize )
"#;

#[cfg(unix)]
const COMMAND_INTEGRATION: &str = r#"typeset -gi _yam_zsh_pending=0
function _yam_zsh_preexec {
  printf '\033]133;C\007'
  _yam_zsh_pending=1
  return 0
}
function _yam_zsh_precmd {
  local -a _yam_zsh_entry=( "$?" "${pipestatus[@]}" )
  if (( $# )); then _yam_zsh_entry=( "$@" ); fi
  if (( _yam_zsh_pending )); then
    if [[ $_yam_zsh_entry[1] == <0-255> ]]; then
      printf '\033]133;D;%d\007' "$_yam_zsh_entry[1]"
    fi
    _yam_zsh_pending=0
  fi
  printf '\033]133;A\007'
  return 0
}
typeset -ga preexec_functions
preexec_functions+=( _yam_zsh_preexec )
"#;

#[cfg(unix)]
const INTEGRATION: &str = r#"function _yam_zsh_report {
  local -a _yam_zsh_entry=( "$?" "${pipestatus[@]}" )
  setopt localoptions no_shwordsplit
  local LC_ALL=C _yam_zsh_path=$PWD _yam_zsh_uri=file://localhost _yam_zsh_byte _yam_zsh_hex
  local -i _yam_zsh_i
  if [[ $_yam_zsh_path != /* ]] || (( ${#_yam_zsh_path} > 4096 )); then
    printf '\033]7;\007'
    return 0
  fi
  for (( _yam_zsh_i=1; _yam_zsh_i<=${#_yam_zsh_path}; _yam_zsh_i++ )); do
    _yam_zsh_byte=$_yam_zsh_path[_yam_zsh_i]
    case $_yam_zsh_byte in
      [a-zA-Z0-9/._~-]) _yam_zsh_uri+=$_yam_zsh_byte ;;
      *) printf -v _yam_zsh_hex '%%%02X' "'$_yam_zsh_byte"; _yam_zsh_uri+=$_yam_zsh_hex ;;
    esac
    if (( ${#_yam_zsh_uri} > 4096 )); then
      printf '\033]7;\007'
      return 0
    fi
  done
  printf '\033]7;%s\007' "$_yam_zsh_uri"
  return 0
}
"#;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::{OsStr, OsString};
    use std::io::Write;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    type BeforeAssetWrite = Box<dyn FnOnce(&mut std::fs::File, &Path)>;
    std::thread_local! {
        pub(super) static BEFORE_ASSET_WRITE: std::cell::RefCell<Option<BeforeAssetWrite>> = const { std::cell::RefCell::new(None) };
    }
    struct ChildGuard(Option<std::process::Child>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = PathBuf::from(format!(
                "/tmp/yam-a07b1-assets-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn builder() -> CommandBuilder {
        let mut b = CommandBuilder::new("/bin/zsh");
        b.env_clear();
        b
    }
    #[test]
    fn a07b2_shared_validation_allows_only_ordinary_unix_defaults() {
        for shell in [
            None,
            Some(super::super::ShellLaunch {
                program: None,
                login: Some(true),
            }),
            Some(super::super::ShellLaunch {
                program: None,
                login: Some(false),
            }),
        ] {
            assert!(validate(true, true, shell.as_ref(), false).is_ok());
            assert!(validate(true, false, shell.as_ref(), false).is_err());
            assert!(validate(true, true, shell.as_ref(), true).is_err());
        }
    }
    #[test]
    fn a07b2_actual_builder_qualification_uses_raw_argv_not_shell_env() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        for program in [
            OsString::from("/bin/bash"),
            OsString::from("/bin/fish"),
            OsString::from("/bin/sh"),
            OsString::from("zsh"),
            OsString::from(""),
            OsString::from("/bin/ZSH"),
            OsString::from("/bin/zsh-alias"),
        ] {
            let mut b = CommandBuilder::new(program);
            b.arg("-l");
            b.env_clear();
            b.env("SHELL", "/bin/zsh");
            b.cwd(&root.0);
            let argv = b.get_argv().to_vec();
            let calls = std::cell::Cell::new(0);
            let (_, assets, warning, _command_warning) =
                super::spawn(&root.0, b, true, false, |b| -> Result<(), ()> {
                    calls.set(calls.get() + 1);
                    assert_eq!(b.get_argv(), &argv);
                    assert_eq!(b.get_env("SHELL"), Some(OsStr::new("/bin/zsh")));
                    assert_eq!(b.get_env("YAM_ZSH_INIT"), None);
                    Ok(())
                })
                .unwrap();
            assert_eq!(calls.get(), 1);
            assert!(assets.is_none());
            assert_eq!(warning.as_deref(), Some(WARNING));
        }
        for program in [
            OsString::from("/bin/zsh"),
            OsString::from_vec(b"/fixture/\xff/zsh".to_vec()),
        ] {
            for argv in [vec!["-l"], vec!["-i"], vec!["-i", "-l"]] {
                let mut b = CommandBuilder::new(program.clone());
                b.args(argv);
                b.env_clear();
                b.env("SHELL", "/bin/bash");
                let original = b.get_argv().to_vec();
                let (_, assets, warning, _command_warning) =
                    super::spawn(&root.0, b, true, false, |b| -> Result<(), ()> {
                        assert_eq!(b.get_argv(), &original);
                        assert_eq!(b.get_env("SHELL"), Some(OsStr::new("/bin/bash")));
                        Ok(())
                    })
                    .unwrap();
                assert!(assets.is_some());
                assert!(warning.is_none());
                drop(assets);
            }
        }
        let (_, assets, warning, _command_warning) = super::spawn(
            &root.0,
            CommandBuilder::new_default_prog(),
            true,
            false,
            |b| -> Result<(), ()> {
                assert!(b.get_argv().is_empty());
                Ok(())
            },
        )
        .unwrap();
        assert!(assets.is_none());
        assert_eq!(warning.as_deref(), Some(WARNING));
    }
    struct PtyGuard(Option<Box<dyn portable_pty::Child + Send + Sync>>);
    impl Drop for PtyGuard {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn legacy_pty(root: &Path, integrated: bool) -> Vec<u8> {
        use std::io::Read;
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut b = CommandBuilder::new("/bin/zsh");
        b.arg("-l");
        b.env_clear();
        b.env("HOME", root);
        b.env("ZDOTDIR", root);
        b.env("PATH", "/usr/bin:/bin");
        b.env("TERM", "xterm-256color");
        b.cwd(root);
        assert_eq!(&b.get_argv()[1..], &[OsStr::new("-l")]);
        let (child, assets, warning, _command_warning) =
            super::spawn(root, b, integrated, false, |b| pair.slave.spawn_command(b)).unwrap();
        let mut child = PtyGuard(Some(child)); // Immediately owns every postspawn failure cleanup.
        assert_eq!(assets.is_some(), integrated);
        assert!(warning.is_none());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        drop(pair.slave);
        let (send, receive) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if send.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut out = Vec::new();
        while !out.windows(6).any(|s| s == b"READY>") {
            assert!(
                std::time::Instant::now() < deadline,
                "private legacy PTY first prompt timeout"
            );
            if let Ok(bytes) = receive.recv_timeout(std::time::Duration::from_millis(20)) {
                out.extend(bytes);
            }
        }
        writer.write_all(b"print -r -- RESULT:$fixture_top:$fixture_trace:${options[interactive]}:${options[login]}; false | true\nfalse\nprint -r -- DONE; exit 0\n").unwrap();
        drop(writer);
        loop {
            if let Ok(bytes) = receive.recv_timeout(std::time::Duration::from_millis(20)) {
                out.extend(bytes);
            }
            if child.0.as_mut().unwrap().try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "private legacy PTY command timeout"
            );
        }
        let status = child.0.as_mut().unwrap().wait().unwrap();
        assert!(status.success());
        drop(child);
        drop(pair.master);
        reading.join().unwrap();
        for bytes in receive.try_iter() {
            out.extend(bytes);
        }
        drop(assets);
        out
    }
    #[test]
    fn a07b2_actual_private_legacy_login_pty_matches_baseline_and_reports_first_prompt() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0,"PS1='READY> '; function fixture_observer { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- observe:${(j:,:)entry}; }; precmd_functions+=(fixture_observer)");
        let plain = legacy_pty(&root.0, false);
        let integrated = legacy_pty(&root.0, true);
        for bytes in [&plain, &integrated] {
            let text = String::from_utf8_lossy(bytes);
            assert!(
                text.contains("RESULT:retained:env,profile,rc,login:on:on"),
                "{text}"
            );
            assert!(text.contains("internal:000"));
            assert!(text.contains("DONE"));
            assert!(text.contains("observe:0,1,0"));
            assert!(text.contains("observe:1,1"));
        }
        assert!(!plain.windows(4).any(|s| s == b"\x1b]7;"));
        let first = integrated.windows(6).position(|s| s == b"READY>").unwrap();
        let osc = integrated.windows(4).position(|s| s == b"\x1b]7;").unwrap();
        assert!(osc < first, "directory report must precede first prompt");
        let text = String::from_utf8_lossy(&integrated);
        assert!(text.contains(&format!(
            "file://localhost{}",
            root.0.canonicalize().unwrap().display()
        )));
        let observations = |bytes: &[u8]| {
            String::from_utf8_lossy(bytes)
                .lines()
                .filter_map(|line| {
                    line.find("observe:")
                        .map(|i| line[i..].trim_end_matches('\r').to_owned())
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(observations(&plain), observations(&integrated));
    }
    #[test]
    fn a07b1_assets_preserve_raw_values_permissions_and_lifetime() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        for value in [
            None,
            Some(OsString::from("/fixture")),
            Some(OsString::from_vec(b"/fixture/\xff".to_vec())),
        ] {
            let mut b = builder();
            if let Some(value) = &value {
                b.env("ZDOTDIR", value);
            }
            let asset = prepare(&root.0, &mut b).unwrap();
            assert_eq!(
                b.get_env("YAM_ZSH_ENV_PRESENT"),
                Some(OsStr::new(if value.is_some() { "1" } else { "0" }))
            );
            assert_eq!(
                b.get_env("YAM_ZSH_ENV_VALUE"),
                Some(value.as_deref().unwrap_or(OsStr::new("")))
            );
            let dir = asset.directory.clone();
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            for name in [".zshenv", "integration.zsh"] {
                let m = std::fs::metadata(dir.join(name)).unwrap();
                assert_eq!(m.permissions().mode() & 0o777, 0o600);
                assert!(m.len() <= 16384);
            }
            drop(asset);
            assert!(!dir.exists());
        }
    }
    #[test]
    fn a07b1_empty_failure_and_budget_leave_original_builder_untouched() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        let mut b = builder();
        b.env("ZDOTDIR", "");
        assert!(prepare(&root.0, &mut b).is_err());
        assert_eq!(b.get_env("ZDOTDIR"), Some(OsStr::new("")));
        assert_eq!(b.get_env("YAM_ZSH_INIT"), None);
        assert!(!root.0.join("zsh-directory-reporting").exists());
        let mut b = builder();
        b.env("ZDOTDIR", "/fixture");
        let missing = root.0.join("missing");
        assert!(prepare(&missing, &mut b).is_err());
        assert_eq!(b.get_env("ZDOTDIR"), Some(OsStr::new("/fixture")));
        assert_eq!(b.get_env("YAM_ZSH_INIT"), None);
        let previous = ACTIVE.swap(256, Ordering::AcqRel);
        assert!(prepare(&root.0, &mut b).is_err());
        assert_eq!(ACTIVE.load(Ordering::Acquire), 256);
        ACTIVE.store(previous, Ordering::Release);
    }

    #[test]
    fn closure_t18_real_prepare_filesystem_failures_keep_original_spawn_and_budget() {
        let _serial = crate::worktree_manager::serial_owner_test();
        for fault in ["base_file", "shared_base", "unwritable_base", "asset_write"] {
            for (cwd, command) in [(true, false), (false, true), (true, true)] {
                let root = Fixture::new();
                let base = root.0.join("zsh-directory-reporting");
                if fault == "base_file" {
                    std::fs::write(&base, b"owned sentinel").unwrap();
                } else {
                    std::fs::create_dir(&base).unwrap();
                    std::fs::set_permissions(
                        &base,
                        std::fs::Permissions::from_mode(match fault {
                            "shared_base" => 0o755,
                            "unwritable_base" => 0o500,
                            _ => 0o700,
                        }),
                    )
                    .unwrap();
                }
                if fault == "asset_write" {
                    std::fs::write(base.join("keep"), b"owned sentinel").unwrap();
                    BEFORE_ASSET_WRITE.with(|hook| {
                        *hook.borrow_mut() = Some(Box::new(|file, path| {
                            *file = std::fs::File::open(path).unwrap()
                        }))
                    });
                }
                let mut original = builder();
                original.env("ZDOTDIR", "literal fixture");
                original.env("KEEP", "unchanged");
                let argv = original.get_argv().to_vec();
                let before = ACTIVE.load(Ordering::Acquire);
                let calls = std::cell::Cell::new(0);
                let observed = std::cell::RefCell::new(None);
                let result = super::spawn(
                    &root.0,
                    original,
                    cwd,
                    command,
                    |builder| -> Result<(), ()> {
                        calls.set(calls.get() + 1);
                        *observed.borrow_mut() = Some(builder);
                        Ok(())
                    },
                );
                BEFORE_ASSET_WRITE.with(|hook| {
                    hook.borrow_mut().take();
                });
                if fault != "base_file" {
                    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                let (_, assets, warning, command_warning) = result.unwrap();
                assert!(assets.is_none(), "{fault}");
                assert_eq!(calls.get(), 1);
                assert_eq!(warning.as_deref(), cwd.then_some(WARNING));
                assert_eq!(
                    command_warning.as_deref(),
                    command.then_some(COMMAND_WARNING)
                );
                assert_eq!(ACTIVE.load(Ordering::Acquire), before);
                let builder = observed.into_inner().unwrap();
                assert_eq!(builder.get_argv(), &argv);
                assert_eq!(
                    builder.get_env("ZDOTDIR"),
                    Some(OsStr::new("literal fixture"))
                );
                assert_eq!(builder.get_env("KEEP"), Some(OsStr::new("unchanged")));
                assert!(builder.get_env("YAM_ZSH_INIT").is_none());
                if fault == "base_file" {
                    assert_eq!(std::fs::read(&base).unwrap(), b"owned sentinel");
                } else if fault == "asset_write" {
                    assert_eq!(std::fs::read(base.join("keep")).unwrap(), b"owned sentinel");
                    assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
                } else {
                    assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0);
                }
            }
        }
    }

    #[test]
    fn a07b1_production_spawn_seam_is_once_with_original_builder_on_failure() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        for enabled in [false, true] {
            for failure in [false, true] {
                let calls = std::cell::Cell::new(0);
                let mut b = builder();
                b.env("ZDOTDIR", if failure { "" } else { "/fixture" });
                let (_, assets, warning, _command_warning) =
                    super::spawn(&root.0, b, enabled, false, |b| -> Result<(), ()> {
                        calls.set(calls.get() + 1);
                        if !enabled || failure {
                            assert_eq!(
                                b.get_env("ZDOTDIR"),
                                Some(OsStr::new(if failure { "" } else { "/fixture" }))
                            );
                            assert_eq!(b.get_env("YAM_ZSH_INIT"), None);
                        } else {
                            assert!(b.get_env("YAM_ZSH_INIT").is_some());
                        }
                        Ok(())
                    })
                    .unwrap();
                assert_eq!(calls.get(), 1);
                assert_eq!(assets.is_some(), enabled && !failure);
                assert_eq!(warning.as_deref(), (enabled && failure).then_some(WARNING));
                drop(assets);
            }
        }
        let previous = ACTIVE.swap(256, Ordering::AcqRel);
        let mut b = builder();
        b.env("ZDOTDIR", "/fixture");
        let calls = std::cell::Cell::new(0);
        let (_, assets, warning, _command_warning) =
            super::spawn(&root.0, b, true, false, |b| -> Result<(), ()> {
                calls.set(calls.get() + 1);
                assert_eq!(b.get_env("ZDOTDIR"), Some(OsStr::new("/fixture")));
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert!(assets.is_none());
        assert_eq!(warning.as_deref(), Some(WARNING));
        assert_eq!(ACTIVE.load(Ordering::Acquire), 256);
        ACTIVE.store(previous, Ordering::Release);
        let mut b = builder();
        b.env("ZDOTDIR", "/fixture");
        let before = ACTIVE.load(Ordering::Acquire);
        let result = super::spawn(&root.0, b, true, false, |_| -> Result<(), ()> { Err(()) });
        assert!(result.is_err());
        assert_eq!(ACTIVE.load(Ordering::Acquire), before);
    }
    fn run(root: &Path, integrated: bool, login: bool, unset: bool, input: &str) -> Vec<u8> {
        run_with_value(
            root,
            integrated,
            login,
            if unset { None } else { Some(root.as_os_str()) },
            input,
        )
    }
    fn run_with_value(
        root: &Path,
        integrated: bool,
        login: bool,
        value: Option<&OsStr>,
        input: &str,
    ) -> Vec<u8> {
        run_modes(root, integrated, false, login, value, input)
    }
    fn run_modes(
        root: &Path,
        cwd: bool,
        command: bool,
        login: bool,
        value: Option<&OsStr>,
        input: &str,
    ) -> Vec<u8> {
        run_details(root, cwd, command, login, value, input).0
    }
    fn run_details(
        root: &Path,
        cwd: bool,
        command: bool,
        login: bool,
        value: Option<&OsStr>,
        input: &str,
    ) -> (Vec<u8>, Vec<u8>) {
        let mut b = builder();
        if let Some(value) = value {
            b.env("ZDOTDIR", value);
        }
        let assets = (cwd || command).then(|| prepare_modes(root, &mut b, cwd, command).unwrap());
        let mut cmd = Command::new("/bin/zsh");
        cmd.arg("-i");
        if login {
            cmd.arg("-l");
        }
        cmd.env_clear()
            .env("HOME", root)
            .env("PATH", "/usr/bin:/bin")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in [
            "ZDOTDIR",
            "YAM_ZSH_ENV_PRESENT",
            "YAM_ZSH_ENV_VALUE",
            "YAM_ZSH_INIT",
        ] {
            if let Some(value) = b.get_env(name) {
                cmd.env(name, value);
            }
        }
        let mut guard = ChildGuard(Some(cmd.spawn().unwrap()));
        let child = guard.0.as_mut().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("bounded Zsh fixture timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let output = guard.0.take().unwrap().wait_with_output().unwrap();
        drop(assets);
        assert!(output.status.success(), "fixture exit failure");
        (output.stdout, output.stderr)
    }
    fn fixture_rc(root: &Path, rc: &str) {
        std::fs::write(root.join(".zshenv"),"typeset fixture_trace=env; local fixture_top=retained; print -r -- internal:${+YAM_ZSH_ENV_PRESENT}${+YAM_ZSH_ENV_VALUE}${+YAM_ZSH_INIT}; return 0; fixture_trace=wrong\n").unwrap();
        std::fs::write(root.join(".zprofile"), "fixture_trace+=,profile\n").unwrap();
        std::fs::write(
            root.join(".zshrc"),
            format!("fixture_trace+=,rc; PS1=''; {rc}\n"),
        )
        .unwrap();
        std::fs::write(root.join(".zlogin"), "fixture_trace+=,login\n").unwrap();
    }
    #[test]
    fn a07b1_actual_rc_order_top_level_unset_login_and_user_hook_reset() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0, "");
        for login in [false, true] {
            for unset in [false, true] {
                let out=run(&root.0,true,login,unset,"print -r -- fixture:$fixture_top:$fixture_trace; print -r -- present:${+ZDOTDIR}; exit\n");
                let text = String::from_utf8_lossy(&out);
                assert!(text.contains(if login {
                    "fixture:retained:env,profile,rc,login"
                } else {
                    "fixture:retained:env,rc"
                }));
                assert!(text.contains(if unset { "present:0" } else { "present:1" }));
                assert!(text.contains("\x1b]7;file://localhost"));
                assert!(text.contains("internal:000"));
            }
        }
        fixture_rc(&root.0, "precmd_functions=()");
        let out = run(&root.0, true, false, false, "exit\n");
        assert!(!out.windows(4).any(|s| s == b"\x1b]7;"));
        fixture_rc(
            &root.0,
            "function precmd { print -r -- user-nonzero-hook; return 1; }",
        );
        let out = run(&root.0, true, false, false, "exit 0\n");
        assert!(String::from_utf8_lossy(&out).contains("user-nonzero-hook"));
        assert!(out.windows(4).any(|s| s == b"\x1b]7;"));
    }
    #[test]
    fn a07c2_four_mode_spawn_fallback_warns_only_requested_modes_once() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        let blocked = root.0.join("blocked");
        std::fs::write(&blocked, "fixture").unwrap();
        for (cwd, command) in [(false, false), (true, false), (false, true), (true, true)] {
            let calls = std::cell::Cell::new(0);
            let mut b = builder();
            b.arg("-i");
            b.env("ZDOTDIR", root.0.as_os_str());
            let (_, assets, directory_warning, command_warning) =
                super::spawn(&blocked, b, cwd, command, |b| -> Result<(), ()> {
                    calls.set(calls.get() + 1);
                    assert_eq!(
                        b.get_argv(),
                        &[
                            std::ffi::OsString::from("/bin/zsh"),
                            std::ffi::OsString::from("-i")
                        ]
                    );
                    assert_eq!(b.get_env("ZDOTDIR"), Some(root.0.as_os_str()));
                    assert!(b.get_env("YAM_ZSH_INIT").is_none());
                    Ok(())
                })
                .unwrap();
            assert_eq!(calls.get(), 1);
            assert!(assets.is_none());
            assert_eq!(directory_warning.as_deref(), cwd.then_some(WARNING));
            assert_eq!(
                command_warning.as_deref(),
                command.then_some(COMMAND_WARNING)
            );
        }
    }

    #[test]
    fn a07c2_actual_command_boundaries_and_user_status_match_original() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0, "function fixture_observer { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- observe:${(j:,:)entry}; }; precmd_functions+=(fixture_observer)");
        let input = "false | true\nfalse\nexit 0\n";
        let original = run(&root.0, false, false, false, input);
        let integrated = run_modes(&root.0, true, true, false, Some(root.0.as_os_str()), input);
        let observations = |bytes: &[u8]| -> Vec<String> {
            String::from_utf8_lossy(bytes)
                .split('\n')
                .filter_map(|line| {
                    line.find("observe:")
                        .map(|at| line[at..].trim().to_string())
                })
                .collect()
        };
        assert_eq!(observations(&integrated), observations(&original));
        let output = String::from_utf8_lossy(&integrated);
        assert!(
            output.contains("\x1b]133;A\x07"),
            "first observed prompt must report A"
        );
        assert!(
            output.contains("\x1b]133;C\x07"),
            "foreground preexec must report C"
        );
        assert!(
            output.contains("\x1b]133;D;0\x07"),
            "pipeline status must report zero"
        );
        assert!(
            output.contains("\x1b]133;D;1\x07"),
            "false status must report one"
        );
    }

    #[test]
    fn a07c2_actual_four_modes_and_login_keep_user_hooks() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0, "function precmd { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- named:${(j:,:)entry}; }; function fixture_observer { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- observe:${(j:,:)entry}; }; function fixture_preexec { print -r -- userpreexec; }; precmd_functions+=(fixture_observer); preexec_functions+=(fixture_preexec)");
        let input = "true\nfalse\nsetopt PIPE_FAIL\nfalse | true\ntrue | false\n{ false; }\nfalse && true\n\nexit 0\n";
        let observed = |bytes: &[u8]| -> Vec<String> {
            String::from_utf8_lossy(bytes)
                .lines()
                .filter_map(|line| {
                    ["named:", "observe:", "userpreexec"]
                        .iter()
                        .find_map(|label| line.find(label).map(|at| line[at..].to_string()))
                })
                .collect()
        };
        for login in [false, true] {
            let original = run_modes(
                &root.0,
                false,
                false,
                login,
                Some(root.0.as_os_str()),
                input,
            );
            for (cwd, command) in [(false, false), (true, false), (false, true), (true, true)] {
                let integrated = run_modes(
                    &root.0,
                    cwd,
                    command,
                    login,
                    Some(root.0.as_os_str()),
                    input,
                );
                assert_eq!(
                    observed(&integrated),
                    observed(&original),
                    "cwd={cwd} command={command} login={login}"
                );
                let output = String::from_utf8_lossy(&integrated);
                assert_eq!(output.contains("\x1b]7;"), cwd);
                assert_eq!(output.contains("\x1b]133;"), command);
                if command {
                    assert!(output.contains("\x1b]133;D;1\x07"));
                }
            }
        }
    }

    #[test]
    fn a07c2_actual_status_prompt_and_failing_hooks_match_original() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        for rc in [
            "PS1='prompt:%? '; function precmd { return 1; }; function fixture_tail { print -r -- tail; }; precmd_functions+=(fixture_tail)",
            "PS1='prompt:%? '; function fixture_first { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- status:${(j:,:)entry}; return 1; }; function fixture_tail { print -r -- tail; }; precmd_functions+=(fixture_first fixture_tail)",
            "setopt PROMPT_SUBST; PS1='prompt:$? '; function fixture_preexec { return 1; }; preexec_functions+=(fixture_preexec)",
            "PS1='prompt:%? '; precmd_functions=(); preexec_functions=()",
        ] {
            fixture_rc(&root.0,rc);
            let input="false\ntrue\nfalse | true\nif )\nexit 0\n";
            let original=run_details(&root.0,false,false,false,Some(root.0.as_os_str()),input);
            let integrated=run_details(&root.0,true,true,false,Some(root.0.as_os_str()),input);
            let observations=|bytes:&[u8]|->Vec<String>{String::from_utf8_lossy(bytes).lines().filter_map(|line| ["status:","tail"].iter().find_map(|label| line.find(label).map(|at|line[at..].to_owned()))).collect()};
            assert_eq!(observations(&integrated.0),observations(&original.0),"{rc}");
            assert_eq!(integrated.1,original.1,"status-sensitive prompt/errors: {rc}");
        }
    }

    #[test]
    fn a07b1_actual_hook_status_and_pipeline_observations_match_original() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0,"function fixture_observer { local -a entry=( \"$?\" \"${pipestatus[@]}\" ); print -r -- observe:${(j:,:)entry}; }; precmd_functions+=(fixture_observer)");
        let input = "false | true\nfalse\nexit 0\n";
        let observations = |bytes: Vec<u8>| -> Vec<String> {
            String::from_utf8_lossy(&bytes)
                .split('\n')
                .filter_map(|line| line.find("observe:").map(|i| line[i..].to_owned()))
                .collect()
        };
        let original = observations(run(&root.0, false, false, false, input));
        assert!(
            original.iter().any(|s| s.starts_with("observe:1,")),
            "nonzero status must be observed"
        );
        assert!(
            original.iter().any(|s| s == "observe:0,1,0"),
            "pipeline members must be observed: {original:?}"
        );
        assert_eq!(
            observations(run(&root.0, true, false, false, input)),
            original
        );
    }
    #[test]
    fn a07b1_actual_emitter_encodes_utf8_and_refuses_over_budget_complete_uri() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        fixture_rc(&root.0, "");
        let path = root.0.join("space 界%");
        std::fs::create_dir(&path).unwrap();
        let input = format!(
            "cd '{}'; _yam_zsh_report; PWD=/$(printf 'a%.0s' {{1..4079}}); _yam_zsh_report; PWD=/$(printf 'a%.0s' {{1..4080}}); _yam_zsh_report; PWD=/$(printf 'a%.0s' {{1..4096}}); _yam_zsh_report; exit 0\n",
            path.to_str().unwrap()
        );
        let out = run(&root.0, true, false, false, &input);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("space%20%E7%95%8C%25"));
        assert!(text.contains("\x1b]7;\x07"));
        assert!(text
            .split("\x1b]7;")
            .skip(1)
            .filter_map(|s| s.split_once('\x07').map(|(uri, _)| uri))
            .any(|uri| uri.len() == 4096));
        for uri in text
            .split("\x1b]7;")
            .skip(1)
            .filter_map(|s| s.split_once('\x07').map(|(uri, _)| uri))
        {
            assert!(uri.len() <= 4096);
        }
    }
    #[test]
    fn a07b1_actual_nonunicode_zdotdir_preserves_synthetic_bytes() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        let value = root
            .0
            .join(OsString::from_vec(b"nonexistent-rc-\xff".to_vec()));
        let out = run_with_value(
            &root.0,
            true,
            false,
            Some(value.as_os_str()),
            "print -rn -- $ZDOTDIR; exit 0\n",
        );
        use std::os::unix::ffi::OsStrExt;
        assert!(out.ends_with(value.as_os_str().as_bytes()));
    }
    #[test]
    fn a07b1_collision_does_not_remove_unowned_crash_remnant() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let root = Fixture::new();
        let base = root.0.join("zsh-directory-reporting");
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = base.join(format!(
            "{}-{}",
            std::process::id(),
            SEQUENCE.load(Ordering::Acquire)
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(".zshenv"), "unowned-remnant").unwrap();
        let mut b = builder();
        b.env("ZDOTDIR", "/fixture");
        assert!(prepare(&root.0, &mut b).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join(".zshenv")).unwrap(),
            "unowned-remnant"
        );
        assert_eq!(b.get_env("ZDOTDIR"), Some(OsStr::new("/fixture")));
    }
    #[test]
    fn a07b1_platform_and_start_combinations_are_validated_without_probe() {
        let shell = super::super::ShellLaunch {
            program: Some("/bin/zsh".into()),
            login: Some(true),
        };
        assert!(validate(true, true, Some(&shell), false).is_ok());
        for (ordinary, windows) in [(false, false), (true, true), (false, true)] {
            assert!(validate(true, ordinary, Some(&shell), windows).is_err());
            assert!(validate(false, ordinary, Some(&shell), windows).is_ok());
        }
        assert!(validate(true, true, None, false).is_ok());
    }
}
