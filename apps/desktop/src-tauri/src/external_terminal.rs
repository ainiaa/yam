// Author: Jeff.Liu. External terminals are views of an existing YAM-owned PTY.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

fn valid_attachment(id: &str, instance: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && super::session_id_from_link(&format!("yam://session/{id}")).is_some()
        && instance.len() == 64
        && instance.bytes().all(|b| b.is_ascii_hexdigit())
}
fn installed(roots: &[PathBuf]) -> Vec<&'static str> {
    [("terminal", "Terminal.app"), ("iterm2", "iTerm.app")]
        .into_iter()
        .filter_map(|(id, name)| {
            roots
                .iter()
                .any(|root| root.join(name).join("Contents/Info.plist").is_file())
                .then_some(id)
        })
        .collect()
}
#[tauri::command]
pub(crate) async fn list_external_terminals() -> Result<Vec<&'static str>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let mut roots = vec![
                PathBuf::from("/Applications"),
                PathBuf::from("/System/Applications/Utilities"),
            ];
            if let Some(home) = std::env::var_os("HOME") {
                roots.push(PathBuf::from(home).join("Applications"));
            }
            installed(&roots)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    })
    .await
    .map_err(|_| "External terminal discovery unavailable".into())
}
fn launch_command(program: &Path, id: &str, instance: &str) -> Result<String, String> {
    if !program.is_absolute() || !valid_attachment(id, instance) {
        return Err("Invalid external terminal attachment".into());
    }
    let program = program.to_str().ok_or("Unsupported application path")?;
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let command = format!(
        "exec {} --yam-terminal {} {}",
        quote(program),
        quote(id),
        quote(instance)
    );
    Ok(format!("/bin/sh -c {}", quote(&command)))
}
#[cfg(target_os = "macos")]
fn open(terminal: &str, command: &str) -> Result<(), String> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let script = match terminal {
        "terminal" => "on run argv\ntell application id \"com.apple.Terminal\"\nactivate\ndo script (item 1 of argv)\nend tell\nend run",
        "iterm2" => "on run argv\ntell application id \"com.googlecode.iterm2\"\nactivate\ncreate window with default profile command (item 1 of argv)\nend tell\nend run",
        _ => return Err("Unsupported external terminal".into()),
    };
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-e", script, "--", command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot open the external terminal")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("macOS could not open the terminal. Check YAM's Automation permission in System Settings.".into())
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("External terminal open request timed out. Check the terminal before trying again.".into());
            }
        }
    }
}
#[tauri::command]
pub(crate) async fn open_external_terminal(
    session_id: String,
    terminal: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        if !["terminal", "iterm2"].contains(&terminal.as_str()) {
            return Err("Unsupported external terminal".into());
        }
        let root = super::cli::owner_root().map_err(|_| "Background connection unavailable")?;
        let descriptor = super::background::Descriptor::read(&root)?;
        let command = launch_command(
            &std::env::current_exe().map_err(|_| "Application path unavailable")?,
            &session_id,
            &descriptor.instance,
        )?;
        let client = super::background::Client::new(descriptor)?;
        let record = client.call("cli_show", serde_json::json!({"session_id":session_id}))?;
        if record["session_id"] != session_id
            || !matches!(record["status"].as_str(), Some("starting" | "running"))
        {
            return Err("The managed session is no longer running".into());
        }
        open(&terminal, &command)
    })
    .await
    .map_err(|_| "External terminal open unavailable".to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, terminal);
        Err("External terminal attachment is currently available on macOS only".into())
    }
}

pub(super) fn entry(argv: &[OsString]) -> Option<Result<(), String>> {
    if argv.first().and_then(|s| s.to_str()) != Some("--yam-terminal") {
        return None;
    }
    Some((|| {
        let [_, id, instance] = argv else {
            return Err("Invalid external terminal attachment arguments".into());
        };
        let id = id.to_str().ok_or("Invalid session identity")?;
        let instance = instance.to_str().ok_or("Invalid owner identity")?;
        if !valid_attachment(id, instance) {
            return Err("Invalid external terminal identity".into());
        }
        #[cfg(target_os = "macos")]
        {
            let descriptor = super::background::Descriptor::read(
                &super::cli::owner_root().map_err(|_| "Background connection unavailable")?,
            )?;
            if descriptor.instance != instance {
                return Err(
                    "The original background owner is unavailable; the task was not restarted"
                        .into(),
                );
            }
            let client = super::background::Client::new(descriptor)?;
            attach(id, |op, args| client.call(op, args))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("External terminal attachment is currently available on macOS only".into())
        }
    })())
}

#[cfg(unix)]
struct Tty {
    fd: i32,
    saved: libc::termios,
}
#[cfg(unix)]
impl Tty {
    fn raw(fd: i32) -> Result<Self, String> {
        let mut saved = unsafe { std::mem::zeroed() };
        if unsafe { libc::isatty(fd) } != 1 || unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
            return Err("Attachment requires an interactive terminal".into());
        }
        let mut raw = saved;
        unsafe {
            libc::cfmakeraw(&mut raw);
        }
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err("Cannot initialize the terminal".into());
        }
        Ok(Self { fd, saved })
    }
    fn size(&self) -> Result<(u16, u16), String> {
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(self.fd, libc::TIOCGWINSZ, &mut size) } != 0
            || size.ws_col < 2
            || size.ws_row < 2
        {
            return Err("Terminal dimensions unavailable".into());
        }
        Ok((size.ws_col.min(500), size.ws_row.min(200)))
    }
}
#[cfg(unix)]
impl Drop for Tty {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
        }
    }
}

#[cfg(unix)]
struct Nonblocking {
    fd: i32,
    flags: i32,
}
#[cfg(unix)]
impl Nonblocking {
    fn new(fd: i32) -> Result<Self, String> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("Cannot initialize bounded terminal output".into());
        }
        Ok(Self { fd, flags })
    }
}
#[cfg(unix)]
impl Drop for Nonblocking {
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFL, self.flags);
        }
    }
}
#[cfg(unix)]
fn output_until(
    output: &mut std::fs::File,
    parts: &[&[u8]],
    deadline: std::time::Instant,
) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let fd = output.as_raw_fd();
    for bytes in parts {
        for chunk in bytes.chunks(8192) {
            super::write_input_until(output, fd, chunk, deadline, &cancelled).map_err(|_| {
                "External terminal output stalled or closed; the task remains in YAM"
            })?;
        }
    }
    Ok(())
}

pub(super) fn open_stream(
    manager: tauri::State<'_, super::SessionManager>,
    id: &str,
    client: &str,
    cols: u16,
    rows: u16,
) -> Result<serde_json::Value, String> {
    super::resize_session(manager.clone(), id.into(), cols, rows)?;
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(id)
        .cloned()
        .ok_or("Unknown active terminal")?;
    let status = session
        .status
        .lock()
        .map_err(|_| "Session status lock poisoned")?;
    if !matches!(status.as_str(), "running" | "starting") {
        return Err("The managed terminal has ended".into());
    }
    let scene = super::frame_for_status_with(&session, &status, true, |log| {
        if let Some(error) = &log.error {
            return Err(error.clone());
        }
        let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .take_external(id, client, now);
        Ok(())
    })?;
    serde_json::to_value(scene).map_err(|_| "Cannot encode terminal stream".into())
}

#[cfg(unix)]
fn read_delta(file: &std::fs::File, end: u64, offset: u64) -> Result<String, String> {
    use std::os::unix::fs::FileExt;
    let length = file
        .metadata()
        .map_err(|_| "Cannot inspect terminal log")?
        .len();
    let start = end
        .checked_sub(length)
        .ok_or("Invalid terminal log range")?;
    if offset < start || offset > end {
        return Err("Terminal output gap; reconnect explicitly from YAM".into());
    }
    let mut bytes = vec![0; (end - offset).min(65536) as usize];
    file.read_exact_at(&mut bytes, offset - start)
        .map_err(|_| "Cannot read terminal output")?;
    match std::str::from_utf8(&bytes) {
        Ok(_) => {}
        Err(error) if error.error_len().is_none() && offset + (bytes.len() as u64) < end => {
            bytes.truncate(error.valid_up_to());
        }
        Err(_) => return Err("Invalid terminal output encoding".into()),
    }
    String::from_utf8(bytes).map_err(|_| "Invalid terminal output encoding".into())
}
#[cfg(not(unix))]
fn read_delta(_file: &std::fs::File, _end: u64, _offset: u64) -> Result<String, String> {
    Err("External terminal streams are unavailable on this platform".into())
}

pub(super) fn delta(
    manager: &super::SessionManager,
    id: &str,
    instance: &str,
    offset: u64,
    client: &str,
    now: u64,
) -> Result<serde_json::Value, String> {
    let runtime = manager
        .terminal_runtime
        .lock()
        .map_err(|_| "Terminal runtime lock poisoned")?
        .clone()
        .ok_or("Terminal runtime unavailable")?;
    if runtime.instance() != instance {
        return Err("Terminal stream instance changed".into());
    }
    {
        let mut leases = manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?;
        if !leases.external_owner(id, client, now) {
            return Err(
                "Terminal control changed or expired; reconnect explicitly from YAM".into(),
            );
        }
        leases.heartbeat(client, now);
    }
    let session = manager
        .sessions
        .lock()
        .map_err(|_| "Session manager lock poisoned")?
        .get(id)
        .cloned();
    let (data, end, running) = if let Some(session) = session {
        let status = session
            .status
            .lock()
            .map_err(|_| "Session status lock poisoned")?;
        let log = session
            .log
            .lock()
            .map_err(|_| "Session log lock poisoned")?;
        if let Some(error) = &log.error {
            return Err(error.clone());
        }
        (
            read_delta(&log.file, log.end_offset, offset)?,
            log.end_offset,
            matches!(status.as_str(), "starting" | "running"),
        )
    } else {
        let history = manager
            .history
            .lock()
            .map_err(|_| "Session history lock poisoned")?
            .clone()
            .ok_or("Session history unavailable")?;
        let record = history.get(id)?;
        if matches!(record.status.as_str(), "running" | "starting") {
            return Err("Terminal output unavailable".into());
        }
        let file =
            std::fs::File::open(history.log_path(id)).map_err(|_| "Cannot read terminal output")?;
        (
            read_delta(&file, record.output_end_offset, offset)?,
            record.output_end_offset,
            false,
        )
    };
    let next = offset + data.len() as u64;
    Ok(
        serde_json::json!({"instance":instance,"session":id,"offset":offset,
        "end_offset":next,"data":data,"running":running,"more":next < end}),
    )
}

fn delta_frame(
    value: serde_json::Value,
    id: &str,
    instance: &str,
    offset: u64,
) -> Result<(String, u64, bool, bool), String> {
    let data = value["data"].as_str().ok_or("Invalid terminal delta")?;
    let end = offset
        .checked_add(data.len() as u64)
        .ok_or("Invalid terminal delta range")?;
    if value["instance"] != instance
        || value["session"] != id
        || value["offset"] != offset
        || value["end_offset"] != end
        || data.len() > 65536
        || (value["more"] == true && data.is_empty())
    {
        return Err(
            "Terminal stream identity or offset changed; reconnect explicitly from YAM".into(),
        );
    }
    Ok((
        data.into(),
        end,
        value["running"]
            .as_bool()
            .ok_or("Invalid terminal delta status")?,
        value["more"]
            .as_bool()
            .ok_or("Invalid terminal delta range")?,
    ))
}

fn frame(
    value: serde_json::Value,
    id: &str,
    expected: Option<&str>,
) -> Result<(String, u64, String, bool), String> {
    let projection = &value["projection"];
    super::terminal_runtime::validate_snapshot(projection, id, expected)?;
    let status = value["status"].as_str().ok_or("Invalid terminal status")?;
    Ok((
        projection["instance"].as_str().unwrap().into(),
        value["end_offset"]
            .as_u64()
            .ok_or("Invalid terminal stream offset")?,
        projection["data"].as_str().unwrap().into(),
        matches!(status, "starting" | "running"),
    ))
}
fn input(pending: &mut Vec<u8>, bytes: &[u8]) -> Result<(String, bool), String> {
    let end = bytes.iter().position(|b| *b == 0x1d);
    pending.extend_from_slice(&bytes[..end.unwrap_or(bytes.len())]);
    if pending.len() > 8192 {
        return Err("Terminal input exceeds the size limit".into());
    }
    let count = match std::str::from_utf8(pending) {
        Ok(s) => s.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => return Err("Terminal input must use UTF-8".into()),
    };
    let text = String::from_utf8(pending.drain(..count).collect())
        .map_err(|_| "Invalid terminal input")?;
    Ok((text, end.is_some()))
}
#[cfg(target_os = "macos")]
fn attach(
    id: &str,
    mut call: impl FnMut(&str, serde_json::Value) -> Result<serde_json::Value, String>,
) -> Result<(), String> {
    attach_fds(id, 0, 1, &mut call)
}
#[cfg(target_os = "macos")]
fn attach_fds(
    id: &str,
    input_fd: i32,
    output_fd: i32,
    mut call: impl FnMut(&str, serde_json::Value) -> Result<serde_json::Value, String>,
) -> Result<(), String> {
    use std::{
        io::Read,
        os::fd::FromRawFd,
        time::{Duration, Instant},
    };
    let tty = Tty::raw(input_fd)?;
    if unsafe { libc::isatty(output_fd) } != 1 {
        return Err("Attachment requires terminal output".into());
    }
    let args = serde_json::json!({"session_id":id});
    let reader = unsafe { libc::dup(input_fd) };
    if reader < 0 {
        return Err("Terminal input unavailable".into());
    }
    let mut stdin = unsafe { std::fs::File::from_raw_fd(reader) };
    let writer = unsafe { libc::dup(output_fd) };
    if writer < 0 {
        return Err("Terminal output unavailable".into());
    }
    let mut output = unsafe { std::fs::File::from_raw_fd(writer) };
    let _flags = Nonblocking::new(writer)?;
    let mut opened = false;
    let result = (|| {
        let mut size = tty.size()?;
        let initial = call(
            "open_terminal_stream",
            serde_json::json!({"session_id":id,"cols":size.0,"rows":size.1}),
        )?;
        opened = true;
        let first = frame(initial, id, None)?;
        if !first.3 {
            return Err("The managed terminal has ended".into());
        }
        let mut offset = first.1;
        let mut pending = Vec::new();
        let mut due = Instant::now();
        let mut renewed = Instant::now();
        output_until(
            &mut output,
            &[
                b"\x1bc\x1b[3J\x1b[?2026h",
                first.2.as_bytes(),
                b"\x1b[?2026l",
            ],
            renewed + Duration::from_millis(2000),
        )?;
        let mut resize_error = None;
        loop {
            if renewed.elapsed() >= Duration::from_millis(2500) {
                return Err("Terminal control lease expired; reconnect explicitly from YAM".into());
            }
            if Instant::now() >= due {
                let requested = Instant::now();
                let scene = delta_frame(
                    call(
                        "read_terminal_delta",
                        serde_json::json!({
                            "session_id":id,"expected_instance":first.0,"offset":offset,
                        }),
                    )?,
                    id,
                    &first.0,
                    offset,
                )?;
                if requested.elapsed() >= Duration::from_millis(2500) {
                    return Err(
                        "Terminal control lease expired; reconnect explicitly from YAM".into(),
                    );
                }
                renewed = requested;
                output_until(
                    &mut output,
                    &[scene.0.as_bytes()],
                    renewed + Duration::from_millis(2000),
                )?;
                offset = scene.1;
                if !scene.2 && !scene.3 {
                    break;
                }
                if scene.2 {
                    if let Some(error) = resize_error.take() {
                        return Err(error);
                    }
                    let next = tty.size()?;
                    if next != size {
                        // A final delta must still drain if the process exits during resize.
                        if let Err(error) = call(
                            "resize_session",
                            serde_json::json!({"session_id":id,"cols":next.0,"rows":next.1}),
                        ) {
                            resize_error = Some(error);
                        } else {
                            size = next;
                        }
                    }
                }
                due = if scene.3 || resize_error.is_some() {
                    Instant::now()
                } else {
                    Instant::now() + Duration::from_millis(100)
                };
            }
            let mut descriptor = libc::pollfd {
                fd: input_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut descriptor, 1, 25) };
            if ready < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err("External terminal input closed".into());
            }
            if descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                break;
            }
            if descriptor.revents & libc::POLLIN != 0 {
                let mut bytes = [0; 4096];
                let count = match stdin.read(&mut bytes) {
                    Ok(count) => count,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                        ) =>
                    {
                        continue
                    }
                    Err(_) => return Err("External terminal input closed".into()),
                };
                if count == 0 {
                    break;
                }
                let (text, detach) = input(&mut pending, &bytes[..count])?;
                if renewed.elapsed() >= Duration::from_millis(2500) {
                    return Err(
                        "Terminal control lease expired; reconnect explicitly from YAM".into(),
                    );
                }
                if !text.is_empty() {
                    call(
                        "write_session",
                        serde_json::json!({"session_id":id,"data":text}),
                    )?;
                }
                if detach {
                    break;
                }
            }
        }
        Ok(())
    })();
    if opened {
        let _ = call("release_terminal_control", args);
    }
    let _ = output_until(&mut output, &[b"\x1b[?2026l\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?2004l\x1b[?25h\r\nYAM external view detached. The task remains managed in YAM.\r\n"], Instant::now() + Duration::from_millis(100));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachment_arguments_and_shell_quoting_do_not_expose_credentials_or_execute_ids() {
        let instance = "a".repeat(64);
        assert!(valid_attachment("s-1-2", &instance));
        for id in ["", "s-1-2;touch /tmp/evil", "../s-1-2", "s-1-2\n"] {
            assert!(!valid_attachment(id, &instance));
        }
        assert!(!valid_attachment("s-1-2", "short"));
        let command =
            launch_command(Path::new("/tmp/a' b/$x`cmd`/YAM"), "s-1-2", &instance).unwrap();
        assert!(command.starts_with("/bin/sh -c "));
        assert!(!command.contains("token"));
        assert!(launch_command(Path::new("relative"), "s-1-2", &instance).is_err());
        assert!(entry(&["--yam-terminal".into(), "s-1-2".into()])
            .unwrap()
            .is_err());
        assert!(entry(&["status".into()]).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn delta_reads_are_bounded_utf8_contiguous_and_do_not_move_the_log_writer() {
        use std::io::{Seek, SeekFrom, Write};
        let path = std::env::temp_dir().join(format!(
            "yam-delta-{}",
            super::super::agent_bridge::credential().unwrap()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let data = format!("{}中文tail", "x".repeat(65535));
        file.write_all(data.as_bytes()).unwrap();
        let end = data.len() as u64;
        let first = read_delta(&file, end, 0).unwrap();
        assert_eq!(first.len(), 65535);
        let last = read_delta(&file, end, first.len() as u64).unwrap();
        assert_eq!(last, "中文tail");
        assert_eq!(file.stream_position().unwrap(), end);
        assert_eq!(read_delta(&file, end, end).unwrap(), "");
        assert!(read_delta(&file, end, end + 1).is_err());
        assert!(read_delta(&file, end, 65536).is_err());
        super::super::append_log(&mut file, b"0123456789", 20).unwrap();
        assert!(read_delta(&file, end + 10, 0).is_err());
        assert_eq!(read_delta(&file, end + 10, end).unwrap(), "0123456789");
        file.seek(SeekFrom::End(0)).unwrap();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn input_preserves_split_utf8_controls_and_detaches_without_forwarding_the_detach_key() {
        let mut pending = Vec::new();
        assert_eq!(
            input(&mut pending, &[0xe4, 0xb8]).unwrap(),
            (String::new(), false)
        );
        assert_eq!(
            input(&mut pending, &[0xad, 3, 27, b'[', b'A']).unwrap(),
            ("中\x03\x1b[A".into(), false)
        );
        assert_eq!(
            input(&mut pending, b"ok\x1dignored").unwrap(),
            ("ok".into(), true)
        );
        assert!(input(&mut pending, &[0xff]).is_err());
        assert!(input(&mut Vec::new(), &[b'x'; 8193]).is_err());
    }
    #[test]
    fn frame_rejects_foreign_owner_and_unsupported_versions_before_rendering() {
        let scene = serde_json::json!({"status":"running","end_offset":0,"projection":{"version":1,"instance":"a".repeat(64),"session":"s-1-2","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"hello","cols":80,"rows":24,"cursorX":5,"viewport":0,"buffer":"normal"}});
        assert!(frame(scene.clone(), "s-1-2", None).is_ok());
        assert!(frame(scene.clone(), "s-1-3", None).is_err());
        assert!(frame(scene.clone(), "s-1-2", Some(&"b".repeat(64))).is_err());
        let mut bad = scene;
        bad["projection"]["version"] = serde_json::json!(2);
        assert!(frame(bad, "s-1-2", None).is_err());
    }
    #[test]
    fn delta_frame_rejects_gaps_foreign_identity_overflow_and_invalid_status() {
        let scene = serde_json::json!({"instance":"a".repeat(64),"session":"s-1-2","offset":42,"end_offset":45,"data":"中","running":true,"more":false});
        assert_eq!(
            delta_frame(scene.clone(), "s-1-2", &"a".repeat(64), 42)
                .unwrap()
                .0,
            "中"
        );
        for (key, value) in [
            ("instance", serde_json::json!("b".repeat(64))),
            ("session", serde_json::json!("s-other")),
            ("offset", serde_json::json!(41)),
            ("end_offset", serde_json::json!(44)),
            ("running", serde_json::Value::Null),
            ("more", serde_json::json!("yes")),
            ("data", serde_json::json!("x".repeat(65537))),
        ] {
            let mut invalid = scene.clone();
            invalid[key] = value;
            assert!(
                delta_frame(invalid, "s-1-2", &"a".repeat(64), 42).is_err(),
                "{key}"
            );
        }
        let mut empty = scene;
        empty["data"] = serde_json::json!("");
        empty["end_offset"] = serde_json::json!(42);
        empty["more"] = serde_json::json!(true);
        assert!(delta_frame(empty, "s-1-2", &"a".repeat(64), 42).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn raw_terminal_guard_restores_the_original_pseudo_terminal_attributes() {
        let (mut master, mut slave) = (0, 0);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut before: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::tcgetattr(slave, &mut before) }, 0);
        {
            let _guard = Tty::raw(slave).unwrap();
        }
        let mut after: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::tcgetattr(slave, &mut after) }, 0);
        // PENDIN is kernel-managed when canonical processing is restored.
        assert_eq!(
            before.c_lflag & !libc::PENDIN,
            after.c_lflag & !libc::PENDIN
        );
        assert_eq!(before.c_iflag, after.c_iflag);
        assert_eq!(before.c_oflag, after.c_oflag);
        assert_eq!(before.c_cc, after.c_cc);
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        assert!(Tty::raw(-1).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn real_pseudo_terminal_attachment_forwards_input_once_and_never_stops_or_restarts_a_task() {
        let (mut master, mut slave) = (0, 0);
        let mut dimensions = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut dimensions,
                )
            },
            0
        );
        let scene = serde_json::json!({"status":"running","end_offset":0,"projection":{"version":1,"instance":"a".repeat(64),"session":"s-1-2","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"hello","cols":80,"rows":24,"cursorX":5,"viewport":0,"buffer":"normal"}});
        let mut calls = Vec::new();
        attach_fds("s-1-2", slave, slave, |name, args| {
            calls.push((name.to_string(), args));
            if name == "open_terminal_stream" {
                let bytes = "中文\x03\x1dignored".as_bytes();
                assert_eq!(
                    unsafe { libc::write(master, bytes.as_ptr().cast(), bytes.len()) },
                    bytes.len() as isize
                );
            }
            Ok(if name == "open_terminal_stream" {
                scene.clone()
            } else if name == "read_terminal_delta" {
                AcceptanceFixture::empty_delta()
            } else {
                serde_json::Value::Null
            })
        })
        .unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(op, _)| op == "write_session")
                .map(|(_, args)| args["data"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["中文\x03"]
        );
        assert!(calls.iter().all(|(op, _)| [
            "open_terminal_stream",
            "read_terminal_delta",
            "release_terminal_control",
            "resize_session",
            "write_session"
        ]
        .contains(&op.as_str())));
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
    }
    #[cfg(unix)]
    #[test]
    fn undrained_terminal_output_has_a_deadline_and_restores_descriptor_flags() {
        use std::{
            os::fd::FromRawFd,
            time::{Duration, Instant},
        };
        let (mut master, mut slave) = (0, 0);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let flags = unsafe { libc::fcntl(slave, libc::F_GETFL) };
        let mut output = unsafe { std::fs::File::from_raw_fd(slave) };
        let started = Instant::now();
        {
            let _guard = Nonblocking::new(slave).unwrap();
            assert!(output_until(
                &mut output,
                &[&vec![b'x'; 1024 * 1024]],
                Instant::now() + Duration::from_millis(100)
            )
            .is_err());
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        let mutable = libc::O_NONBLOCK | libc::O_APPEND | libc::O_ASYNC;
        assert_eq!(
            unsafe { libc::fcntl(slave, libc::F_GETFL) } & mutable,
            flags & mutable
        );
        unsafe {
            libc::close(master);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn idle_attachment_renews_without_input_and_detaches_when_another_controller_wins() {
        let (mut master, mut slave) = (0, 0);
        let mut dimensions = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut dimensions,
                )
            },
            0
        );
        let scene = serde_json::json!({"status":"running","end_offset":0,"projection":{"version":1,"instance":"a".repeat(64),"session":"s-1-2","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"hello","cols":80,"rows":24,"cursorX":5,"viewport":0,"buffer":"normal"}});
        let mut calls = Vec::new();
        let mut resize = 0;
        let error = attach_fds("s-1-2", slave, slave, |name, _| {
            calls.push(name.to_string());
            if name == "read_terminal_delta" {
                resize += 1;
                if resize == 12 {
                    return Err("Another desktop currently controls this terminal".into());
                }
            }
            Ok(if name == "open_terminal_stream" {
                scene.clone()
            } else if name == "read_terminal_delta" {
                AcceptanceFixture::empty_delta()
            } else {
                serde_json::Value::Null
            })
        })
        .unwrap_err();
        assert!(error.contains("Another desktop"));
        assert_eq!(resize, 12);
        assert_eq!(
            calls
                .iter()
                .filter(|op| op.as_str() == "open_terminal_stream")
                .count(),
            1
        );
        assert!(!calls.iter().any(|op| [
            "write_session",
            "stop_session",
            "poll_events",
            "create_session"
        ]
        .contains(&op.as_str())));
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
    }
    #[cfg(target_os = "macos")]
    struct AcceptanceFixture {
        root: PathBuf,
        master: Option<std::os::fd::OwnedFd>,
        slave: std::os::fd::OwnedFd,
    }
    #[cfg(target_os = "macos")]
    impl AcceptanceFixture {
        fn new() -> Self {
            use std::os::fd::FromRawFd;
            let root = std::env::temp_dir().join(format!(
                "yam-external-acceptance-{}-{}",
                std::process::id(),
                &super::super::agent_bridge::credential().unwrap()[..12]
            ));
            std::fs::create_dir(&root).unwrap();
            let (mut master, mut slave) = (0, 0);
            let mut size = libc::winsize {
                ws_col: 80,
                ws_row: 24,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            assert_eq!(
                unsafe {
                    libc::openpty(
                        &mut master,
                        &mut slave,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut size,
                    )
                },
                0
            );
            Self {
                root,
                master: Some(unsafe { std::os::fd::OwnedFd::from_raw_fd(master) }),
                slave: unsafe { std::os::fd::OwnedFd::from_raw_fd(slave) },
            }
        }
        fn scene() -> serde_json::Value {
            serde_json::json!({"status":"running","end_offset":0,"projection":{"version":1,"instance":"a".repeat(64),"session":"s-1-2","terminal_version":"6.0.0","serialize_version":"0.14.0","revision":1,"data":"\u{1b}[32mfixture 中文\u{1b}[0m","cols":80,"rows":24,"cursorX":12,"viewport":0,"buffer":"normal"}})
        }
        fn empty_delta() -> serde_json::Value {
            serde_json::json!({"instance":"a".repeat(64),"session":"s-1-2","offset":0,"end_offset":0,"data":"","running":true,"more":false})
        }
        fn send(master: i32, bytes: &[u8]) {
            assert_eq!(
                unsafe { libc::write(master, bytes.as_ptr().cast(), bytes.len()) },
                bytes.len() as isize
            );
        }
    }
    #[cfg(target_os = "macos")]
    impl Drop for AcceptanceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn stream_restores_once_then_forwards_only_contiguous_deltas_and_drains_final_output() {
        use std::os::fd::AsRawFd;
        let fixture = AcceptanceFixture::new();
        let master = fixture.master.as_ref().unwrap().as_raw_fd();
        let slave = fixture.slave.as_raw_fd();
        let mut calls = Vec::new();
        let mut offset = 42;
        attach_fds("s-1-2", slave, slave, |op, args| {
            calls.push(op.to_string());
            match op {
                "open_terminal_stream" => {
                    assert_eq!(args["cols"], 80); assert_eq!(args["rows"], 24);
                    let mut scene = AcceptanceFixture::scene();
                    scene["end_offset"] = serde_json::json!(42);
                    Ok(scene)
                }
                "read_terminal_delta" => {
                    if offset == 42 {
                        let dimensions = libc::winsize {ws_col:90,ws_row:24,ws_xpixel:0,ws_ypixel:0};
                        assert_eq!(unsafe {libc::ioctl(slave,libc::TIOCSWINSZ,&dimensions)},0);
                    }
                    assert_eq!(args["offset"], offset);
                    assert_eq!(args["expected_instance"], "a".repeat(64));
                    let data = if offset == 42 { "\x1b[2;1H增量" } else { "\r\nfinal tail" };
                    let start = offset;
                    offset += data.len() as u64;
                    Ok(serde_json::json!({"instance":"a".repeat(64),"session":"s-1-2","offset":start,"end_offset":offset,"data":data,"running":offset < 65,"more":false}))
                }
                "resize_session" => { assert_eq!(args["cols"],90); Ok(serde_json::Value::Null) },
                "release_terminal_control" => Ok(serde_json::Value::Null),
                other => panic!("Unexpected operation: {other}"),
            }
        }).unwrap();
        let _nonblocking = Nonblocking::new(master).unwrap();
        let mut output = Vec::new();
        loop {
            let mut bytes = [0; 4096];
            let count = unsafe { libc::read(master, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count <= 0 {
                break;
            }
            output.extend_from_slice(&bytes[..count as usize]);
        }
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.matches("\x1bc").count(), 1);
        assert_eq!(output.matches("fixture 中文").count(), 1);
        assert_eq!(output.matches("增量").count(), 1);
        assert_eq!(output.matches("final tail").count(), 1);
        assert_eq!(
            calls
                .iter()
                .filter(|op| *op == "open_terminal_stream")
                .count(),
            1
        );
        assert_eq!(calls.iter().filter(|op| *op == "resize_session").count(), 1);
        assert_eq!(calls.last().unwrap(), "release_terminal_control");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn authenticated_background_transport_and_real_tty_keep_the_same_session_on_detach() {
        use std::{
            os::fd::AsRawFd,
            sync::{Arc, Mutex},
        };
        let fixture = AcceptanceFixture::new();
        let master = fixture.master.as_ref().unwrap().as_raw_fd();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let server = super::super::background::Server::start(&fixture.root, move |request| {
            observed
                .lock()
                .unwrap()
                .push((request.command.clone(), request.args.clone()));
            if request.command != "ping" {
                assert_eq!(request.args["session_id"], "s-1-2");
            }
            match request.command.as_str() {
                "ping" | "resize_session" | "release_terminal_control" => {
                    Ok(serde_json::Value::Null)
                }
                "read_terminal_delta" => Ok(AcceptanceFixture::empty_delta()),
                "open_terminal_stream" => {
                    AcceptanceFixture::send(master, "中文\x03\x1d".as_bytes());
                    Ok(AcceptanceFixture::scene())
                }
                "write_session" => {
                    assert_eq!(request.args["data"], "中文\x03");
                    Ok(serde_json::Value::Null)
                }
                _ => panic!("unexpected external operation {}", request.command),
            }
        })
        .unwrap();
        let descriptor = super::super::background::Descriptor::read(&fixture.root).unwrap();
        let client = super::super::background::Client::new(descriptor).unwrap();
        attach_fds(
            "s-1-2",
            fixture.slave.as_raw_fd(),
            fixture.slave.as_raw_fd(),
            |op, args| client.call(op, args),
        )
        .unwrap();
        let trace = calls.lock().unwrap();
        assert_eq!(
            trace
                .iter()
                .filter(|(op, _)| op == "open_terminal_stream")
                .count(),
            1
        );
        assert_eq!(
            trace.iter().filter(|(op, _)| op == "write_session").count(),
            1
        );
        assert!(!trace.iter().any(|(op, _)| [
            "stop_session",
            "create_session",
            "cli_stop",
            "poll_events"
        ]
        .contains(&op.as_str())));
        drop(trace);
        drop(client);
        drop(server);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn actual_shell_launch_keeps_hostile_path_characters_literal() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = AcceptanceFixture::new();
        let program = fixture
            .root
            .join("YAM ' 中文 $(touch pwned) `touch pwned2` $HOME");
        std::fs::write(&program, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let instance = "b".repeat(64);
        let command = launch_command(&program, "s-1-2", &instance).unwrap();
        let result = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .current_dir(&fixture.root)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            format!("--yam-terminal\ns-1-2\n{instance}\n")
        );
        assert!(!fixture.root.join("pwned").exists());
        assert!(!fixture.root.join("pwned2").exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn backend_failures_owner_changes_and_window_hangup_never_stop_or_retry_the_task() {
        use std::os::fd::AsRawFd;
        for scenario in ["write_error", "foreign_frame", "window_closed", "ended"] {
            let mut fixture = AcceptanceFixture::new();
            let master = fixture.master.as_ref().unwrap().as_raw_fd();
            let mut calls = Vec::new();
            let mut reads = 0;
            let result = attach_fds(
                "s-1-2",
                fixture.slave.as_raw_fd(),
                fixture.slave.as_raw_fd(),
                |op, _| {
                    calls.push(op.to_string());
                    if op == "open_terminal_stream" && scenario == "write_error" {
                        AcceptanceFixture::send(master, b"fixture command\n");
                    }
                    if op == "write_session" {
                        return Err("owned synthetic write failure".into());
                    }
                    let mut scene = AcceptanceFixture::empty_delta();
                    if op == "read_terminal_delta" {
                        reads += 1;
                        if reads == 1 && scenario == "window_closed" {
                            drop(fixture.master.take());
                        }
                        if reads == 1 && scenario == "foreign_frame" {
                            scene["instance"] = serde_json::json!("b".repeat(64));
                        }
                        if reads == 1 && scenario == "ended" {
                            scene["running"] = serde_json::json!(false);
                        }
                    }
                    Ok(if op == "open_terminal_stream" {
                        AcceptanceFixture::scene()
                    } else if op == "read_terminal_delta" {
                        scene
                    } else {
                        serde_json::Value::Null
                    })
                },
            );
            if matches!(scenario, "ended" | "window_closed") {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err());
            }
            assert_eq!(
                calls
                    .iter()
                    .filter(|op| op.as_str() == "open_terminal_stream")
                    .count(),
                1
            );
            assert_eq!(
                calls
                    .iter()
                    .filter(|op| op.as_str() == "write_session")
                    .count(),
                usize::from(scenario == "write_error")
            );
            assert!(
                !calls
                    .iter()
                    .any(|op| ["create_session", "stop_session", "poll_events"]
                        .contains(&op.as_str()))
            );
            if scenario == "window_closed" {
                continue;
            }
            let mut state: libc::termios = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe { libc::tcgetattr(fixture.slave.as_raw_fd(), &mut state) },
                0
            );
            assert_ne!(
                state.c_lflag & libc::ICANON,
                0,
                "cooked mode must be restored for {scenario}"
            );
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_discovery_is_allowlisted_deduplicated_and_does_not_execute_apps() {
        let fixture = AcceptanceFixture::new();
        assert!(installed(std::slice::from_ref(&fixture.root)).is_empty());
        for name in ["Terminal.app", "iTerm.app", "Unknown.app"] {
            let contents = fixture.root.join(name).join("Contents");
            std::fs::create_dir_all(&contents).unwrap();
            std::fs::write(contents.join("Info.plist"), b"fixture").unwrap();
        }
        assert_eq!(
            installed(&[fixture.root.clone(), fixture.root.clone()]),
            vec!["terminal", "iterm2"]
        );
        std::fs::remove_file(fixture.root.join("iTerm.app/Contents/Info.plist")).unwrap();
        assert_eq!(
            installed(std::slice::from_ref(&fixture.root)),
            vec!["terminal"]
        );
    }
}
