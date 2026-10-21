// Author: Jeff.Liu. A desktop-launched owner may have no TERM at all.
use super::*;

#[test]
fn terminal_environment_defaults_unusable_launcher_term() {
    for value in [
        None,
        Some(""),
        Some("dumb"),
        Some("screen-256color"),
        Some("xterm-256color"),
    ] {
        let mut builder = CommandBuilder::new("/bin/sh");
        builder.env_remove("TERM");
        if let Some(value) = value {
            builder.env("TERM", value);
        }
        configure_terminal_environment(&mut builder);
        assert_eq!(
            builder.get_env("TERM"),
            Some(std::ffi::OsStr::new(
                value
                    .filter(|value| !value.is_empty() && *value != "dumb")
                    .unwrap_or("xterm-256color")
            )),
            "TERM={value:?}"
        );
        builder.env("TERM", "profile-terminal");
        assert_eq!(
            builder.get_env("TERM"),
            Some(std::ffi::OsStr::new("profile-terminal"))
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn terminal_environment_real_zsh_pty_supports_both_delete_keys() {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};
    let root = std::env::temp_dir().join(format!("yam-delete-key-{}", next_session_id()));
    std::fs::create_dir(&root).unwrap();
    let pair = native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut builder = CommandBuilder::new("/bin/zsh");
    // Load the system key bindings, with no user startup files in the isolated HOME.
    builder.arg("-i");
    builder.env_clear();
    builder.env("TERM", "dumb");
    builder.env("HOME", &root);
    builder.env("ZDOTDIR", &root);
    builder.env("PATH", "/usr/bin:/bin");
    builder.env("PROMPT", "YAM_DELETE_PROMPT> ");
    builder.cwd(&root);
    configure_terminal_environment(&mut builder);
    struct ChildGuard(Box<dyn Child + Send + Sync>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let child = ChildGuard(pair.slave.spawn_command(builder).unwrap());
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    drop(pair.slave);
    let (send, receive) = std::sync::mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if send.send(buffer[..size].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let until = |needle: &[u8]| {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = Vec::new();
        while !output.windows(needle.len()).any(|bytes| bytes == needle) {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let Ok(bytes) = receive.recv_timeout(remaining) else {
                break;
            };
            output.extend(bytes);
        }
        output.windows(needle.len()).any(|bytes| bytes == needle)
    };
    writer
        .write_all(b"PROMPT='YAM_DELETE_PROMPT> '; printf '\\nYAM_DELETE_READY\\n'\r")
        .unwrap();
    let ready = until(b"\r\nYAM_DELETE_READY\r\n");
    if ready {
        writer.write_all(b"sss\x7f").unwrap();
    }
    let erased = ready && until(b"\x08 \x08");
    let forward_deleted = if erased {
        writer
            .write_all(b"\x15printf 'FORWARD=<%s>\\n' abXc\x1b[D\x1b[D\x1b[3~\x05\r")
            .unwrap();
        until(b"FORWARD=<abc>\r\n")
    } else {
        false
    };
    drop(child);
    drop(writer);
    drop(pair.master);
    reading.join().unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert!(ready, "isolated zsh did not become ready");
    assert!(
        erased,
        "Delete must move back, erase and move back; missing TERM emitted only a space"
    );
    assert!(
        forward_deleted,
        "Fn+Delete must erase X; TERM=dumb leaves the system binding undefined"
    );
}
