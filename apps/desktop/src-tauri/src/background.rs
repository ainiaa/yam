// Author: Jeff.Liu. Authenticated, bounded transport for one user-owned background instance.
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
const MAX_REQUEST: usize = 1024 * 1024;
// An 8 MiB retained log can expand sixfold when JSON escapes control bytes.
const MAX_RESPONSE: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    version: u8,
    token: String,
    instance: String,
    pub client: String,
    pub id: u64,
    pub command: String,
    pub args: serde_json::Value,
}
fn hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0, |different, (a, b)| different | (a ^ b))
            == 0
}
fn decode_request(bytes: &[u8], token: &str, instance: &str) -> Result<Request, String> {
    if bytes.len() > MAX_REQUEST {
        return Err("Background request exceeds size budget".into());
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|_| "Invalid background request schema")?;
    if request.version != 1
        || !hex(&request.token)
        || !hex(&request.instance)
        || !hex(&request.client)
        || !equal(&request.token, token)
        || !equal(&request.instance, instance)
        || request.id == 0
        || request.id > 9_007_199_254_740_991
        || !request.args.is_object()
        || request.command.is_empty()
        || request.command.len() > 64
        || !request
            .command
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Invalid background identity or request".into());
    }
    Ok(request)
}
pub(super) fn private_file(path: &Path, create: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    if create {
        options.write(true).create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT: inspect, never follow links.
    }
    let file = options
        .open(path)
        .map_err(|_| "Cannot open private background file")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect background file")?
        .is_file()
    {
        return Err("Background connection must be a regular file".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file
            .metadata()
            .map_err(|_| "Cannot inspect background file")?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err("Background connection cannot be a reparse point".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect background file")?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("Background credentials are not private to the current user".into());
        }
    }
    Ok(file)
}
fn private_root(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|_| "Cannot create background directory")?;
    let metadata =
        std::fs::symlink_metadata(root).map_err(|_| "Cannot inspect background directory")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Invalid background directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Background directory belongs to another user".into());
        }
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect background directory")?;
    }
    #[cfg(windows)]
    protect_windows_path(root)?;
    Ok(())
}
#[cfg(windows)]
fn protect_windows_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
        fn SetFileSecurityW(
            path: *const u16,
            information: u32,
            descriptor: *mut std::ffi::c_void,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let text: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err("Cannot construct private background permissions".into());
    }
    let result = unsafe { SetFileSecurityW(name.as_ptr(), 0x80000004, descriptor) };
    unsafe { LocalFree(descriptor) };
    if result == 0 {
        return Err("Cannot protect background path".into());
    }
    Ok(())
}

pub(super) struct OwnerLock {
    _file: File,
}
impl OwnerLock {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        private_root(root)?;
        let path = root.join("owner.lock");
        let file = match private_file(&path, true) {
            Ok(file) => file,
            Err(_) => private_file(&path, false)?,
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("Another background instance owns this workspace".into());
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            #[repr(C)]
            struct Overlapped {
                internal: usize,
                high: usize,
                offset: u32,
                offset_high: u32,
                event: *mut std::ffi::c_void,
            }
            #[link(name = "kernel32")]
            extern "system" {
                fn LockFileEx(
                    file: *mut std::ffi::c_void,
                    flags: u32,
                    reserved: u32,
                    low: u32,
                    high: u32,
                    overlapped: *mut Overlapped,
                ) -> i32;
            }
            let mut overlap = Overlapped {
                internal: 0,
                high: 0,
                offset: 0,
                offset_high: 0,
                event: std::ptr::null_mut(),
            };
            if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlap) } == 0 {
                return Err("Another background instance owns this workspace".into());
            }
        }
        Ok(Self { _file: file })
    }
}

#[cfg(unix)]
impl Drop for OwnerLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // A PTY fork can briefly inherit this file description before exec; release explicitly.
        unsafe {
            libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Descriptor {
    pub version: u8,
    pub address: String,
    pub instance: String,
    pub token: String,
}
impl Descriptor {
    fn validate(&self) -> Result<SocketAddr, String> {
        let address: SocketAddr = self
            .address
            .parse()
            .map_err(|_| "Invalid background address")?;
        if self.version != 1
            || !hex(&self.token)
            || !hex(&self.instance)
            || address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            || address.port() == 0
        {
            return Err("Invalid background descriptor".into());
        }
        Ok(address)
    }
    pub fn publish(&self, root: &Path) -> Result<(), String> {
        self.validate()?;
        private_root(root)?;
        let temporary = root.join(format!("connection-{}.tmp", self.instance));
        let mut file = private_file(&temporary, true)?;
        let result = (|| {
            #[cfg(windows)]
            protect_windows_path(&temporary)?;
            let bytes =
                serde_json::to_vec(self).map_err(|_| "Cannot encode background descriptor")?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Cannot commit background descriptor")?;
            drop(file);
            std::fs::rename(&temporary, root.join("connection.json"))
                .map_err(|_| "Cannot publish background descriptor".to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
    pub fn read(root: &Path) -> Result<Self, String> {
        let mut bytes = Vec::new();
        private_file(&root.join("connection.json"), false)?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read background descriptor")?;
        if bytes.len() > 4096 {
            return Err("Background descriptor exceeds size budget".into());
        }
        let value: Self =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid background descriptor schema")?;
        value.validate()?;
        Ok(value)
    }
}

fn read_frame(stream: &mut TcpStream, limit: usize) -> Result<Vec<u8>, String> {
    read_frame_with_budget(stream, limit, Duration::from_secs(3))
}
fn read_frame_with_budget(
    stream: &mut TcpStream,
    limit: usize,
    budget: Duration,
) -> Result<Vec<u8>, String> {
    // Winsock accepts inherit the nonblocking listener mode; timeout-based framing requires blocking I/O.
    stream
        .set_nonblocking(false)
        .map_err(|_| "Cannot configure background frame mode")?;
    let deadline = std::time::Instant::now() + budget;
    let mut read = |mut bytes: &mut [u8]| -> Result<(), String> {
        while !bytes.is_empty() {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("Background frame timed out".into());
            }
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| "Cannot bound background frame")?;
            match stream.read(bytes) {
                Ok(0) => return Err("Incomplete background frame".into()),
                Ok(size) => bytes = &mut bytes[size..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("Background frame unavailable or timed out".into()),
            }
        }
        Ok(())
    };
    let mut length = [0u8; 4];
    read(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > limit {
        return Err("Background frame exceeds size budget".into());
    }
    let mut bytes = vec![0; length];
    read(&mut bytes)?;
    Ok(bytes)
}
fn write_frame(stream: &mut TcpStream, bytes: &[u8], limit: usize) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err("Background frame exceeds size budget".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|_| "Cannot send background frame".into())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: u8,
    instance: String,
    client: String,
    id: u64,
    result: Result<serde_json::Value, String>,
}

pub(super) struct Server {
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    _owner: OwnerLock,
}
impl Server {
    #[cfg(test)]
    pub fn start(
        root: &Path,
        dispatch: impl Fn(Request) -> Result<serde_json::Value, String> + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::start_owned(root, OwnerLock::acquire(root)?, dispatch, || {})
    }
    fn start_owned(
        root: &Path,
        owner: OwnerLock,
        dispatch: impl Fn(Request) -> Result<serde_json::Value, String> + Send + Sync + 'static,
        exit_after_reply: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Cannot bind background transport")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure background transport")?;
        let descriptor = Descriptor {
            version: 1,
            address: listener
                .local_addr()
                .map_err(|_| "Cannot resolve background transport")?
                .to_string(),
            instance: super::agent_bridge::credential()?,
            token: super::agent_bridge::credential()?,
        };
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let dispatch = Arc::new(dispatch);
        let exit_after_reply = Arc::new(exit_after_reply);
        // Publishing only after binding prevents a descriptor from referring to an unbound port.
        descriptor.publish(root)?;
        let thread = thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            while !stop.load(Ordering::Acquire) {
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
                // Leave pending connections in the bounded OS backlog until a worker is free.
                // Accepting and immediately closing them loses ordinary desktop startup bursts.
                if workers.len() >= 8 {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let descriptor = descriptor.clone();
                        let dispatch = dispatch.clone();
                        let exit_after_reply = exit_after_reply.clone();
                        workers.push(thread::spawn(move || {
                            let mut handle = || -> Result<(), String> {
                                stream
                                    .set_read_timeout(Some(Duration::from_secs(3)))
                                    .map_err(|_| "Cannot bound background input")?;
                                stream
                                    .set_write_timeout(Some(Duration::from_secs(3)))
                                    .map_err(|_| "Cannot bound background output")?;
                                let bytes = read_frame(&mut stream, MAX_REQUEST)?;
                                let request = decode_request(
                                    &bytes,
                                    &descriptor.token,
                                    &descriptor.instance,
                                )?;
                                let shutdown = request.command == "shutdown";
                                let client = request.client.clone();
                                let id = request.id;
                                let result = if request.command == "ping"
                                    && request.args == serde_json::json!({})
                                {
                                    Ok(serde_json::json!({"ready":true}))
                                } else {
                                    dispatch(request)
                                };
                                let mut response = Response {
                                    version: 1,
                                    instance: descriptor.instance.clone(),
                                    client,
                                    id,
                                    result,
                                };
                                let mut bytes = serde_json::to_vec(&response)
                                    .map_err(|_| "Cannot encode background response")?;
                                if bytes.len() > MAX_RESPONSE {
                                    response.result =
                                        Err("Background response exceeds size budget".into());
                                    bytes = serde_json::to_vec(&response)
                                        .map_err(|_| "Cannot encode background budget error")?;
                                }
                                // Attempt the receipt before exiting; an accepted stop-all must also finish if its peer has disappeared.
                                let written = write_frame(&mut stream, &bytes, MAX_RESPONSE);
                                if shutdown && response.result.is_ok() {
                                    exit_after_reply();
                                }
                                written
                            };
                            // Never log unauthenticated request bytes or credentials.
                            let _ = handle();
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        let server = Self {
            stopped,
            thread: Some(thread),
            _owner: owner,
        };
        Client::new(Descriptor::read(root)?)?.call("ping", serde_json::json!({}))?;
        Ok(server)
    }
}

fn validate_command(command: &str, args: &serde_json::Value) -> Result<(), String> {
    let (allowed, required): (&[&str], &[&str]) = match command {
        "list_sessions"
        | "shutdown"
        | "background_status"
        | "retry_agent_notifications"
        | "cancel_log_search" => (&[], &[]),
        "poll_events" => (&["cursor", "foreground"], &["cursor"]),
        "acknowledge_notification" => (
            &["session_id", "expected_status"],
            &["session_id", "expected_status"],
        ),
        "notify_session" => (
            &["session_id", "expected_status", "title"],
            &["session_id", "expected_status", "title"],
        ),
        "set_agent_notification_context" => (&["selected", "paused"], &["selected", "paused"]),
        "read_agent_receipt" => (
            &["session_id", "receipt", "revision"],
            &["session_id", "receipt", "revision"],
        ),
        "search_session_logs" => (&["session_id", "request"], &["session_id", "request"]),
        "set_terminal_viewport" => (&["session_id", "line"], &["session_id", "line"]),
        "read_log_excerpt" => (
            &["session_id", "offset", "column"],
            &["session_id", "offset", "column"],
        ),
        "create_session" => (&["cwd", "command", "launch", "resume_from"], &[]),
        "take_terminal_control"
        | "stop_session"
        | "read_session_snapshot"
        | "read_session_log"
        | "read_terminal_frame" => (&["session_id"], &["session_id"]),
        "write_session" => (&["session_id", "data"], &["session_id", "data"]),
        "resize_session" => (
            &["session_id", "cols", "rows"],
            &["session_id", "cols", "rows"],
        ),
        _ => return Err("Unsupported background command".into()),
    };
    let args = args
        .as_object()
        .ok_or("Invalid background command arguments")?;
    if args.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !args.contains_key(*key))
    {
        return Err("Invalid background command arguments".into());
    }
    if command == "create_session" {
        for field in ["cwd", "command", "resume_from"] {
            if args
                .get(field)
                .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                return Err(format!("Invalid background argument: {field}"));
            }
        }
        if let Some(launch) = args.get("launch").filter(|launch| !launch.is_null()) {
            let fields = launch.as_object().ok_or("Invalid background launch")?;
            if fields
                .keys()
                .any(|key| !["adapter", "mode", "extra_args", "prompt"].contains(&key.as_str()))
            {
                return Err("Invalid background launch fields".into());
            }
            let _: super::AgentLaunch =
                serde_json::from_value(launch.clone()).map_err(|_| "Invalid background launch")?;
        }
    }
    Ok(())
}
fn argument<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|_| format!("Invalid background argument: {key}"))
}
fn dispatch(app: &tauri::AppHandle, request: Request) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    validate_command(&request.command, &request.args)?;
    let manager = app.state::<super::SessionManager>();
    let args = &request.args;
    let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    manager.last_request.store(now, Ordering::Release);
    if matches!(request.command.as_str(), "write_session" | "resize_session") {
        let id: String = argument(args, "session_id")?;
        if !manager
            .sessions
            .lock()
            .map_err(|_| "Session manager lock poisoned")?
            .contains_key(&id)
        {
            return Err("Unknown active terminal".into());
        }
        manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .claim(&id, &request.client, now)?;
    }
    if request.command == "poll_events" {
        manager
            .input_leases
            .lock()
            .map_err(|_| "Input ownership lock poisoned")?
            .heartbeat(&request.client, now);
        let foreground: bool = args
            .get("foreground")
            .map(|v| serde_json::from_value(v.clone()))
            .transpose()
            .map_err(|_| "Invalid foreground context")?
            .unwrap_or(false);
        manager.desktop_connected.store(true, Ordering::Release);
        *manager
            .desktop_focus
            .lock()
            .map_err(|_| "Desktop focus lock poisoned")? = (std::time::Instant::now(), foreground);
    }
    let result = match request.command.as_str() {
        "list_sessions" => serde_json::to_value(super::list_sessions(app.clone(), manager)?),
        "create_session" => serde_json::to_value(super::create_session(
            app.clone(),
            manager,
            argument(args, "cwd")?,
            argument(args, "command")?,
            argument(args, "launch")?,
            argument(args, "resume_from")?,
        )?),
        "take_terminal_control" => {
            let id: String = argument(args, "session_id")?;
            let sessions = manager
                .sessions
                .lock()
                .map_err(|_| "Session manager lock poisoned")?;
            let session = sessions.get(&id).ok_or("Unknown active terminal")?;
            if !["starting", "running"].contains(
                &session
                    .status
                    .lock()
                    .map_err(|_| "Session status lock poisoned")?
                    .as_str(),
            ) {
                return Err("The terminal process has ended".into());
            }
            manager
                .input_leases
                .lock()
                .map_err(|_| "Input ownership lock poisoned")?
                .take_control(&id, &request.client, now);
            Ok(serde_json::Value::Null)
        }
        "stop_session" => {
            serde_json::to_value(super::stop_session(manager, argument(args, "session_id")?)?)
        }
        "write_session" => serde_json::to_value(super::write_session(
            manager,
            argument(args, "session_id")?,
            argument(args, "data")?,
        )?),
        "resize_session" => serde_json::to_value(super::resize_session(
            manager,
            argument(args, "session_id")?,
            argument(args, "cols")?,
            argument(args, "rows")?,
        )?),
        "read_session_snapshot" => serde_json::to_value(super::read_session_snapshot(
            app.clone(),
            manager,
            argument(args, "session_id")?,
        )?),
        "read_terminal_frame" => serde_json::to_value(super::read_terminal_frame(
            app.clone(),
            manager,
            argument(args, "session_id")?,
        )?),
        "set_terminal_viewport" => serde_json::to_value(super::set_terminal_viewport(
            manager,
            argument(args, "session_id")?,
            argument(args, "line")?,
        )?),
        "background_status" => Ok(serde_json::json!({"pid":std::process::id(),
            "desktop_connected":manager.desktop_connected.load(Ordering::Acquire) && manager.desktop_focus.lock().map_err(|_|"Desktop focus lock poisoned")?.0.elapsed() < Duration::from_secs(3),
            "active_sessions":manager.sessions.lock().map_err(|_|"Session manager lock poisoned")?.len()})),
        "poll_events" => serde_json::to_value(
            manager
                .relay
                .lock()
                .map_err(|_| "Event relay lock poisoned")?
                .poll(argument(args, "cursor")?),
        ),
        "read_session_log" => serde_json::to_value(super::read_session_log(
            app.clone(),
            manager,
            argument(args, "session_id")?,
        )?),
        "acknowledge_notification" => serde_json::to_value(super::acknowledge_notification(
            app.clone(),
            manager,
            argument(args, "session_id")?,
            argument(args, "expected_status")?,
        )?),
        "notify_session" => {
            serde_json::to_value(tauri::async_runtime::block_on(super::notify_session(
                app.clone(),
                manager,
                argument(args, "session_id")?,
                argument(args, "title")?,
                argument(args, "expected_status")?,
            ))?)
        }
        "set_agent_notification_context" => {
            serde_json::to_value(super::set_agent_notification_context(
                app.clone(),
                manager,
                argument(args, "selected")?,
                argument(args, "paused")?,
            )?)
        }
        "retry_agent_notifications" => {
            serde_json::to_value(super::retry_agent_notifications(manager)?)
        }
        "read_agent_receipt" => serde_json::to_value(super::read_agent_receipt(
            app.clone(),
            manager,
            argument(args, "session_id")?,
            argument(args, "receipt")?,
            argument(args, "revision")?,
        )?),
        "search_session_logs" => {
            serde_json::to_value(tauri::async_runtime::block_on(super::search_session_logs(
                app.clone(),
                manager,
                argument(args, "session_id")?,
                argument(args, "request")?,
            ))?)
        }
        "read_log_excerpt" => {
            serde_json::to_value(tauri::async_runtime::block_on(super::read_log_excerpt(
                app.clone(),
                manager,
                argument(args, "session_id")?,
                argument(args, "offset")?,
                argument(args, "column")?,
            ))?)
        }
        "cancel_log_search" => serde_json::to_value(tauri::async_runtime::block_on(
            super::cancel_log_search(manager),
        )?),
        "shutdown" => {
            manager.shutting_down.store(true, Ordering::Release);
            if let Err(error) = manager.shutdown() {
                manager.shutting_down.store(false, Ordering::Release);
                return Err(error);
            }
            Ok(serde_json::Value::Null)
        }
        _ => return Err("Unsupported background command".into()),
    };
    result.map_err(|_| "Cannot encode background command result".into())
}

#[derive(Default)]
struct StartRequests {
    results: std::collections::HashMap<
        (String, u64),
        (serde_json::Value, Result<serde_json::Value, String>),
    >,
    reserved: usize,
}
impl StartRequests {
    fn run(
        &mut self,
        client: &str,
        id: u64,
        args: serde_json::Value,
        start: impl FnOnce() -> Result<serde_json::Value, String>,
    ) -> Result<serde_json::Value, String> {
        let key = (client.to_string(), id);
        if let Some((original, result)) = self.results.get(&key) {
            if original != &args {
                return Err("Start request identity was reused with different arguments".into());
            }
            return result.clone();
        }
        let bytes = serde_json::to_vec(&args)
            .map_err(|_| "Cannot measure start request")?
            .len();
        let reserve = bytes.saturating_mul(2).saturating_add(16_384);
        // ponytail: retain 256 start receipts / 16 MiB per backend lifetime; refuse instead of evicting deduplication.
        if self.results.len() >= 256 || self.reserved.saturating_add(reserve) > 16 * 1024 * 1024 {
            return Err("Background start receipt budget reached; stop tasks and close the background before starting more".into());
        }
        self.reserved += reserve;
        let result = start();
        self.results.insert(key, (args, result.clone()));
        result
    }
}

#[derive(Default)]
pub(super) struct InputLeases {
    owners: std::collections::HashMap<String, (String, u64)>,
}
impl InputLeases {
    fn claim(&mut self, session: &str, client: &str, now: u64) -> Result<(), String> {
        if self
            .owners
            .get(session)
            .is_some_and(|(owner, last)| owner != client && now.saturating_sub(*last) <= 3000)
        {
            return Err("Another desktop currently controls this terminal".into());
        }
        self.owners.insert(session.into(), (client.into(), now));
        Ok(())
    }
    fn take_control(&mut self, session: &str, client: &str, now: u64) {
        self.owners.insert(session.into(), (client.into(), now));
    }
    fn heartbeat(&mut self, client: &str, now: u64) {
        for (owner, last) in self.owners.values_mut() {
            if owner == client {
                *last = now;
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RelayEvent {
    pub name: String,
    pub payload: String,
    sequence: u64,
}
#[derive(Serialize, Deserialize)]
pub(super) struct RelayPage {
    pub cursor: u64,
    pub gap: bool,
    pub events: Vec<RelayEvent>,
}
#[derive(Default)]
pub(super) struct Relay {
    events: std::collections::VecDeque<RelayEvent>,
    bytes: usize,
    sequence: u64,
    lost: u64,
}
impl Relay {
    fn push(&mut self, name: &str, payload: String) {
        self.sequence += 1;
        let size = name.len() + payload.len();
        if size > 4 * 1024 * 1024 {
            self.lost = self.sequence;
            return;
        }
        self.bytes += size;
        self.events.push_back(RelayEvent {
            name: name.into(),
            payload,
            sequence: self.sequence,
        });
        // ponytail: a 4 MiB / 1024-event relay; cursor gaps require snapshot resynchronization.
        while self.bytes > 4 * 1024 * 1024 || self.events.len() > 1024 {
            if let Some(event) = self.events.pop_front() {
                self.bytes -= event.name.len() + event.payload.len();
                self.lost = self.lost.max(event.sequence);
            }
        }
    }
    fn poll(&self, cursor: u64) -> RelayPage {
        RelayPage {
            cursor: self.sequence,
            gap: cursor < self.lost || cursor > self.sequence,
            events: self
                .events
                .iter()
                .filter(|e| e.sequence > cursor)
                .cloned()
                .collect(),
        }
    }
}
fn connect_or_start(
    root: &Path,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<Client, String> {
    let existing = || -> Result<Client, String> {
        let client = Client::new(Descriptor::read(root)?)?;
        client.call("ping", serde_json::json!({}))?;
        Ok(client)
    };
    if let Ok(client) = existing() {
        return Ok(client);
    }
    // Never start a replacement while a live owner holds history, even with an unreadable descriptor.
    drop(OwnerLock::acquire(root)?);
    start()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(client) = existing() {
            return Ok(client);
        }
        if std::time::Instant::now() >= deadline {
            return Err("Background startup did not become ready; no tasks were launched".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}
pub(super) fn attach(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("background");
    let client = Arc::new(connect_or_start(&root, || {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        super::terminal_runtime::service_command(&executable)
            .arg("--yam-background")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start background: {e}"))?;
        Ok(())
    })?);
    *app.state::<super::SessionManager>()
        .background_client
        .lock()
        .map_err(|_| "Background client lock poisoned")? = Some(client.clone());
    let app = app.clone();
    thread::spawn(move || {
        let mut cursor = 0;
        while !app
            .state::<super::SessionManager>()
            .shutting_down
            .load(Ordering::Acquire)
        {
            match poll_events_with_reconnect(
                &client,
                cursor,
                app.state::<super::SessionManager>()
                    .desktop_foreground
                    .load(Ordering::Acquire),
            ) {
                Ok((page, reconnected)) => {
                    if page.gap || reconnected {
                        let _ = app.emit(
                            "background-gap",
                            serde_json::json!({"missing_events":page.gap}),
                        );
                    }
                    cursor = page.cursor;
                    for event in page.events {
                        if let Ok(payload) =
                            serde_json::from_str::<serde_json::Value>(&event.payload)
                        {
                            let _ = app.emit(&event.name, payload);
                        }
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "session-error",
                        serde_json::json!({"session_id":"","data":error}),
                    );
                    break; // Never silently restart an owner or rerun its tasks after a crash.
                }
            }
            thread::sleep(Duration::from_millis(40));
        }
    });
    Ok(())
}

fn poll_events_with_reconnect(
    client: &Client,
    cursor: u64,
    foreground: bool,
) -> Result<(RelayPage, bool), String> {
    const ATTEMPTS: u64 = 3;
    let mut last_error = String::new();
    for attempt in 0..ATTEMPTS {
        let result = client
            .call(
                "poll_events",
                serde_json::json!({"cursor":cursor,"foreground":foreground}),
            )
            .and_then(|value| {
                serde_json::from_value::<RelayPage>(value)
                    .map_err(|_| "Invalid background event page".into())
            });
        match result {
            Ok(page) => return Ok((page, attempt > 0)),
            Err(error) => last_error = error,
        }
        if attempt + 1 < ATTEMPTS {
            thread::sleep(Duration::from_millis(250 * (attempt + 1)));
        }
    }
    // Client retains its authenticated descriptor. Recovery never discovers or starts another owner.
    Err(last_error)
}

fn lifecycle_due(foreground: bool, selected: Option<&str>, session: &str, paused: bool) -> bool {
    !paused && (!foreground || selected != Some(session))
}
pub(super) fn notify_lifecycle(app: &tauri::AppHandle, session: &str, status: &str) {
    use tauri::Manager;
    let manager = app.state::<super::SessionManager>();
    if !manager.background_owner
        || !super::is_terminal(status)
        || manager.shutting_down.load(Ordering::Acquire)
    {
        return;
    }
    let foreground = manager
        .desktop_focus
        .lock()
        .is_ok_and(|f| f.1 && f.0.elapsed() < Duration::from_secs(3));
    let context = manager.agent_bridge.lock().ok().and_then(|bridge| {
        bridge
            .as_ref()
            .and_then(|b| b.context.lock().ok().map(|c| c.clone()))
    });
    let (selected, paused) = context.map(|c| (c.1, c.2)).unwrap_or((None, false));
    if !lifecycle_due(foreground, selected.as_deref(), session, paused) {
        return;
    }
    let Ok(history) = manager.history(app) else {
        return;
    };
    let app = app.clone();
    let session = session.to_string();
    let status = status.to_string();
    thread::spawn(move || {
        if let Err(error) = history.native_delivery(
            &session,
            super::agent_events::NativeSource::Lifecycle(&status),
            |record| {
                super::send_native_notification(
                    app.clone(),
                    session.clone(),
                    format!("Session {}", record.status),
                    record
                        .reason
                        .clone()
                        .unwrap_or_else(|| record.summary.cwd.clone()),
                )
            },
        ) {
            eprintln!("[YAM] {error}");
        }
    });
}
fn idle_due(now: u64, last_request: u64, active: usize) -> bool {
    active == 0 && now.saturating_sub(last_request) >= 60_000
}
fn configure_owner_app(config: &mut tauri::utils::config::AppConfig) {
    config.windows.clear();
    // The GUI owns GTK/D-Bus activation. Sharing its name makes the owner a remote GUI instance.
    #[cfg(target_os = "linux")]
    {
        config.enable_gtk_app_id = false;
    }
}
pub(super) fn run() -> Result<(), String> {
    use tauri::{Listener, Manager};
    #[cfg(target_os = "macos")]
    ignore_platform_window_restoration();
    #[cfg(target_os = "macos")]
    let _activity = ProcessActivity::begin();
    let mut context = super::app_context();
    configure_owner_app(&mut context.config_mut().app);
    let owner: Arc<std::sync::Mutex<Option<Server>>> = Arc::new(std::sync::Mutex::new(None));
    let setup_owner = owner.clone();
    tauri::Builder::default()
        .manage(super::SessionManager {
            background_owner: true,
            ..Default::default()
        })
        .setup(move |app| {
            eprintln!("[YAM] Initializing background owner");
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            for name in [
                "session-output",
                "session-state",
                "session-phase",
                "session-attention",
                "session-error",
                "agent-state",
                "session-notification-click",
            ] {
                let handle = app.handle().clone();
                app.listen_any(name, move |event| {
                    if let Ok(mut relay) = handle.state::<super::SessionManager>().relay.lock() {
                        relay.push(name, event.payload().into());
                    }
                });
            }
            #[cfg(target_os = "macos")]
            super::mac_notifications::init(app.handle())?;
            let root = app.path().app_data_dir()?.join("background");
            let owner_lock = OwnerLock::acquire(&root)?;
            // Exclusive ownership precedes recovery of interrupted records and all history writes.
            app.state::<super::SessionManager>().history(app.handle())?;
            let executable = app.path().resolve(
                if cfg!(windows) {
                    "target/terminal-runtime/yam-terminal.exe"
                } else {
                    "target/terminal-runtime/yam-terminal"
                },
                tauri::path::BaseDirectory::Resource,
            )?;
            let (send, receive) = std::sync::mpsc::sync_channel::<(String, String)>(64);
            let parser = Arc::new(super::terminal_runtime::Runtime::start(
                &executable,
                move |id, data| {
                    send.try_send((id, data))
                        .map_err(|_| "Terminal query queue exceeded its budget".into())
                },
            )?);
            *app.state::<super::SessionManager>()
                .terminal_runtime
                .lock()
                .map_err(|_| "Terminal runtime lock poisoned")? = Some(parser);
            let handle = app.handle().clone();
            thread::spawn(move || {
                for (id, data) in receive {
                    if let Err(error) = super::write_session(
                        handle.state::<super::SessionManager>(),
                        id.clone(),
                        data,
                    ) {
                        use tauri::Emitter;
                        let _ = handle.emit(
                            "session-error",
                            super::SessionMessage {
                                session_id: id,
                                data: error,
                            },
                        );
                    }
                }
            });
            let handle = app.handle().clone();
            let starts = std::sync::Mutex::new(StartRequests::default());
            let exit_handle = app.handle().clone();
            let server = Server::start_owned(
                &root,
                owner_lock,
                move |request| {
                    validate_command(&request.command, &request.args)?;
                    if request.command == "create_session" {
                        let client = request.client.clone();
                        let id = request.id;
                        let args = request.args.clone();
                        starts
                            .lock()
                            .map_err(|_| "Start receipt lock poisoned")?
                            .run(&client, id, args, || dispatch(&handle, request))
                    } else {
                        dispatch(&handle, request)
                    }
                },
                move || exit_handle.exit(0),
            )?;
            *setup_owner
                .lock()
                .map_err(|_| "Background owner lock poisoned")? = Some(server);
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(1));
                let manager = handle.state::<super::SessionManager>();
                if manager.shutting_down.load(Ordering::Acquire) {
                    break;
                }
                let Ok(active) = manager.sessions.lock() else {
                    break;
                };
                let now = manager.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                if idle_due(
                    now,
                    manager.last_request.load(Ordering::Acquire),
                    active.len(),
                ) {
                    manager.shutting_down.store(true, Ordering::Release);
                    drop(active); // Start checks this flag again under the same session lock.
                    match manager.shutdown() {
                        Ok(()) => {
                            handle.exit(0);
                            break;
                        }
                        Err(error) => {
                            eprintln!("[YAM] {error}");
                            manager.shutting_down.store(false, Ordering::Release);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("Cannot initialize background: {error}"))?
        .run(super::handle_owner_exit);
    owner
        .lock()
        .map_err(|_| "Background owner lock poisoned")?
        .take();
    Ok(())
}
#[cfg(target_os = "macos")]
fn process_activity_options() -> objc2_foundation::NSActivityOptions {
    objc2_foundation::NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
}

#[cfg(target_os = "macos")]
pub(super) struct ProcessActivity(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
);

#[cfg(target_os = "macos")]
impl ProcessActivity {
    pub(super) fn begin() -> Self {
        Self(
            objc2_foundation::NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                process_activity_options(),
                &objc2_foundation::NSString::from_str("Monitor user terminal sessions"),
            ),
        )
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProcessActivity {
    fn drop(&mut self) {
        // The token belongs to beginActivity above and is ended exactly once.
        unsafe {
            objc2_foundation::NSProcessInfo::processInfo().endActivity(&self.0);
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn ignore_platform_window_restoration() {
    use objc2_foundation::{
        NSArgumentDomain, NSMutableCopying, NSNumber, NSString, NSUserDefaults,
    };
    // YAM creates its own window and restores its sessions; AppKit crash prompts must not block setup.
    // Argument-domain values are process-local; no saved state or persistent preferences are edited.
    let defaults = NSUserDefaults::standardUserDefaults();
    let domain = defaults
        .volatileDomainForName(unsafe { NSArgumentDomain })
        .mutableCopy();
    let value = NSNumber::new_bool(true);
    let key = NSString::from_str("ApplePersistenceIgnoreState");
    unsafe {
        domain.setObject_forKey(&value, objc2::runtime::ProtocolObject::from_ref(&*key));
        defaults.setVolatileDomain_forName(&domain, NSArgumentDomain);
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(super) struct Client {
    descriptor: Descriptor,
    identity: String,
    next_id: AtomicU64,
}
impl Client {
    pub fn new(descriptor: Descriptor) -> Result<Self, String> {
        descriptor.validate()?;
        Ok(Self {
            descriptor,
            identity: super::agent_bridge::credential()?,
            next_id: AtomicU64::new(1),
        })
    }
    pub fn call(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = Request {
            version: 1,
            token: self.descriptor.token.clone(),
            instance: self.descriptor.instance.clone(),
            client: self.identity.clone(),
            id,
            command: command.into(),
            args,
        };
        let bytes = serde_json::to_vec(&request).map_err(|_| "Cannot encode background request")?;
        decode_request(&bytes, &self.descriptor.token, &self.descriptor.instance)?;
        let exchange = || -> Result<Vec<u8>, String> {
            let mut stream =
                TcpStream::connect_timeout(&self.descriptor.validate()?, Duration::from_secs(2))
                    .map_err(|_| "Background instance is unavailable")?;
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .map_err(|_| "Cannot bound background request")?;
            write_frame(&mut stream, &bytes, MAX_REQUEST)?;
            read_frame_with_budget(&mut stream, MAX_RESPONSE, Duration::from_secs(35))
        };
        // Only start requests have retained receipts. Reuse the exact wire identity once after transport loss.
        let reply = exchange()
            .or_else(|error| {
                if command == "create_session" {
                    exchange()
                } else {
                    Err(error)
                }
            })
            .map_err(|error| format!("Background {command}: {error}"))?;
        let response: Response =
            serde_json::from_slice(&reply).map_err(|_| "Invalid background response")?;
        if response.version != 1
            || response.instance != self.descriptor.instance
            || response.client != self.identity
            || response.id != id
        {
            return Err("Background response identity mismatch".into());
        }
        response.result
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn inherited_nonblocking_connections_wait_for_fragmented_request_bytes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = std::thread::spawn(move || {
            use std::io::Write;
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(40));
            for chunk in [
                &4u32.to_be_bytes()[..2],
                &4u32.to_be_bytes()[2..],
                b"te",
                b"st",
            ] {
                stream.write_all(chunk).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap(); // Winsock accepts inherit the listening socket's mode.
        let frame =
            super::read_frame_with_budget(&mut stream, 1024, std::time::Duration::from_secs(1));
        peer.join().unwrap();
        assert_eq!(frame.unwrap(), b"test");
    }
    #[test]
    fn the_windowless_owner_does_not_claim_the_linux_desktop_activation_name() {
        let mut config = tauri::utils::config::AppConfig {
            enable_gtk_app_id: true,
            windows: vec![tauri::utils::config::WindowConfig::default()],
            ..Default::default()
        };
        assert!(!config.windows.is_empty());
        super::configure_owner_app(&mut config);
        assert!(config.windows.is_empty());
        assert_eq!(config.enable_gtk_app_id, !cfg!(target_os = "linux"));
    }
    use super::*;
    #[test]
    fn viewport_command_cannot_accept_input_bytes_or_an_unbounded_target() {
        assert!(validate_command(
            "set_terminal_viewport",
            &serde_json::json!({"session_id":"s-one","line":2})
        )
        .is_ok());
        assert!(validate_command(
            "set_terminal_viewport",
            &serde_json::json!({"session_id":"s-one","line":2,"data":"input"})
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn dropping_owner_explicitly_unlocks_even_while_a_forked_child_retains_the_file() {
        let root =
            std::env::temp_dir().join(format!("yam-fork-lock-{}", super::super::next_session_id()));
        let owner = OwnerLock::acquire(&root).unwrap();
        let mut pipe = [0; 2];
        assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe {
                libc::close(pipe[1]);
                let mut byte = 0u8;
                libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe {
            libc::close(pipe[0]);
        }
        drop(owner);
        let next = OwnerLock::acquire(&root);
        unsafe {
            libc::close(pipe[1]);
            libc::waitpid(child, std::ptr::null_mut(), 0);
        }
        assert!(
            next.is_ok(),
            "inherited descriptor must not retain released ownership"
        );
        drop(next);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lifecycle_notifications_follow_focus_selection_and_pause_after_desktop_detaches() {
        assert!(!lifecycle_due(true, Some("s-one"), "s-one", false));
        assert!(lifecycle_due(true, Some("s-two"), "s-one", false));
        assert!(lifecycle_due(false, Some("s-one"), "s-one", false));
        assert!(!lifecycle_due(false, None, "s-one", true));
    }
    #[test]
    fn idle_cleanup_requires_no_tasks_and_a_full_minute_without_a_client_request() {
        assert!(!idle_due(59_999, 0, 0));
        assert!(idle_due(60_000, 0, 0));
        assert!(!idle_due(70_000, 20_000, 0));
        assert!(!idle_due(70_000, 0, 1));
    }
    #[test]
    fn owner_status_has_no_arguments_or_arbitrary_inspection_targets() {
        assert!(validate_command("background_status", &serde_json::json!({})).is_ok());
        assert!(validate_command("background_status", &serde_json::json!({"pid":1})).is_err());
    }
    #[test]
    fn input_ownership_expires_and_cannot_be_stolen_by_another_live_client() {
        let mut leases = InputLeases::default();
        assert!(leases.claim("s-one", "a", 0).is_ok());
        assert!(leases.claim("s-one", "a", 1000).is_ok());
        assert!(leases.claim("s-one", "b", 1001).is_err());
        assert!(leases.claim("s-two", "b", 1001).is_ok());
        assert!(leases.claim("s-one", "b", 4001).is_ok());
        assert!(leases.claim("s-one", "a", 4002).is_err());
    }
    #[test]
    fn explicit_takeover_replaces_only_the_selected_input_lease() {
        let mut leases = InputLeases::default();
        leases.claim("s-one", "a", 0).unwrap();
        leases.claim("s-two", "a", 0).unwrap();
        leases.take_control("s-one", "b", 1000);
        assert!(leases.claim("s-one", "a", 1001).is_err());
        assert!(leases.claim("s-one", "b", 1001).is_ok());
        assert!(leases.claim("s-two", "a", 1001).is_ok());
        leases.heartbeat("a", 2000);
        assert!(leases.claim("s-one", "a", 2001).is_err());
        assert!(leases.claim("s-one", "a", 4002).is_ok());
        assert!(validate_command(
            "take_terminal_control",
            &serde_json::json!({"session_id":"s-one","client":"b"})
        )
        .is_err());
    }
    #[test]
    fn relay_is_bounded_and_reports_a_gap_without_consuming_another_clients_cursor() {
        let mut relay = Relay::default();
        relay.push("session-state", "{\"status\":\"running\"}".into());
        let first = relay.poll(0);
        assert!(!first.gap);
        assert_eq!(first.events.len(), 1);
        assert_eq!(relay.poll(0).events.len(), 1);
        for _ in 0..1100 {
            relay.push("session-output", "x".repeat(4096));
        }
        assert!(relay.bytes <= 4 * 1024 * 1024);
        assert!(relay.events.len() <= 1024);
        assert!(relay.poll(first.cursor).gap);
        let current = relay.poll(relay.sequence);
        assert!(!current.gap);
        assert!(current.events.is_empty());
        relay.push("session-output", "x".repeat(4 * 1024 * 1024 + 1));
        assert!(relay.poll(current.cursor).gap);
    }
    #[test]
    fn discovery_reuses_an_authenticated_owner_and_never_spawns_a_duplicate() {
        let root =
            std::env::temp_dir().join(format!("yam-discovery-{}", super::super::next_session_id()));
        let server = Server::start(&root, |_| Ok(serde_json::Value::Null)).unwrap();
        let client = connect_or_start(&root, || panic!("live owner must be reused")).unwrap();
        assert!(client.call("ping", serde_json::json!({})).is_ok());
        drop(server);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(connect_or_start(&root, || Err("fixture launch refused".into())).is_err());
        if root.exists() {
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn oversized_authenticated_response_reports_a_budget_error_instead_of_a_disconnect() {
        let root = std::env::temp_dir().join(format!(
            "yam-background-response-{}",
            super::super::next_session_id()
        ));
        let server =
            Server::start(&root, |_| Ok(serde_json::json!("x".repeat(MAX_RESPONSE)))).unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        assert_eq!(
            client
                .call("list_sessions", serde_json::json!({}))
                .unwrap_err(),
            "Background response exceeds size budget"
        );
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_lost_start_reply_reconnects_with_the_same_request_identity() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let descriptor = Descriptor {
            version: 1,
            address: listener.local_addr().unwrap().to_string(),
            token: "a".repeat(64),
            instance: "b".repeat(64),
        };
        let peer = descriptor.clone();
        let server = thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let request = decode_request(
                &read_frame(&mut first, MAX_REQUEST).unwrap(),
                &peer.token,
                &peer.instance,
            )
            .unwrap();
            drop(first); // The task exists, but its response did not reach the client.
            let (mut second, _) = listener.accept().unwrap();
            let replay = decode_request(
                &read_frame(&mut second, MAX_REQUEST).unwrap(),
                &peer.token,
                &peer.instance,
            )
            .unwrap();
            assert_eq!(
                (request.id, request.client, request.args),
                (replay.id, replay.client.clone(), replay.args)
            );
            let response = Response {
                version: 1,
                instance: peer.instance,
                client: replay.client,
                id: replay.id,
                result: Ok(serde_json::json!({"session_id":"s-one"})),
            };
            write_frame(
                &mut second,
                &serde_json::to_vec(&response).unwrap(),
                MAX_RESPONSE,
            )
            .unwrap();
        });
        let client = Client::new(descriptor).unwrap();
        assert_eq!(
            client
                .call("create_session", serde_json::json!({}))
                .unwrap()["session_id"],
            "s-one"
        );
        server.join().unwrap();
    }
    #[test]
    fn a_retried_start_never_launches_twice_and_a_reused_key_cannot_change_arguments() {
        let mut starts = StartRequests::default();
        let mut calls = 0;
        let args = serde_json::json!({"command":"fixture"});
        let first = starts
            .run("client", 1, args.clone(), || {
                calls += 1;
                Ok(serde_json::json!({"session_id":"s-fixture"}))
            })
            .unwrap();
        let replay = starts
            .run("client", 1, args.clone(), || panic!("duplicate launch"))
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(calls, 1);
        assert!(starts
            .run(
                "client",
                1,
                serde_json::json!({"command":"different"}),
                || panic!("changed launch")
            )
            .is_err());
        assert!(starts
            .run("client", 2, args.clone(), || Err("fixture failure".into()))
            .is_err());
        assert!(starts
            .run("client", 2, args, || panic!("failed launch replayed"))
            .is_err());
    }
    #[test]
    fn a_full_start_receipt_budget_refuses_new_launches_but_keeps_existing_receipts() {
        let mut starts = StartRequests::default();
        let args = serde_json::json!({});
        for id in 1..=256 {
            starts
                .run("client", id, args.clone(), || Ok(serde_json::json!(id)))
                .unwrap();
        }
        assert!(starts
            .run("client", 257, args.clone(), || panic!("unbounded launch"))
            .is_err());
        assert_eq!(
            starts
                .run("client", 1, args, || panic!("old launch repeated"))
                .unwrap(),
            serde_json::json!(1)
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn process_activity_prevents_app_nap_without_preventing_machine_or_display_sleep() {
        use objc2_foundation::NSActivityOptions;
        let options = process_activity_options();
        assert!(!options.contains(NSActivityOptions::IdleSystemSleepDisabled));
        assert!(!options.contains(NSActivityOptions::IdleDisplaySleepDisabled));
        let activity = ProcessActivity::begin();
        drop(activity);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn background_restoration_override_changes_only_the_volatile_argument_domain() {
        use objc2_foundation::{NSArgumentDomain, NSBundle, NSString, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        let old = defaults.volatileDomainForName(unsafe { NSArgumentDomain });
        let identifier = NSBundle::mainBundle()
            .bundleIdentifier()
            .unwrap_or_else(|| NSString::from_str("com.yam.background-test"));
        let persistent = defaults.persistentDomainForName(&identifier);
        ignore_platform_window_restoration();
        assert!(defaults.boolForKey(&NSString::from_str("ApplePersistenceIgnoreState")));
        assert_eq!(persistent, defaults.persistentDomainForName(&identifier));
        unsafe {
            defaults.setVolatileDomain_forName(&old, NSArgumentDomain);
        }
    }
    #[test]
    fn dispatcher_accepts_only_known_commands_and_their_exact_argument_shape() {
        assert!(validate_command("list_sessions", &serde_json::json!({})).is_ok());
        assert!(
            validate_command("stop_session", &serde_json::json!({"session_id":"s-valid"})).is_ok()
        );
        assert!(validate_command("kill_pid", &serde_json::json!({"pid":42})).is_err());
        assert!(validate_command(
            "read_session_snapshot",
            &serde_json::json!({"session_id":"s-valid", "path":"/tmp/file"})
        )
        .is_err());
        assert!(validate_command(
            "list_sessions",
            &serde_json::json!({"session_id":"s-valid"})
        )
        .is_err());
        assert!(validate_command(
            "resize_session",
            &serde_json::json!({"session_id":"s-valid", "cols":80})
        )
        .is_err());
        assert!(validate_command("create_session", &serde_json::json!({"launch":{"adapter":"codex","mode":"interactive","extra_args":"","prompt":null,"unexpected":{}}})).is_err());
        assert!(validate_command("create_session", &serde_json::json!({"command":[]})).is_err());
    }
    #[test]
    fn frame_budget_is_absolute_even_when_peer_keeps_dripping_bytes() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let writer = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let _ = stream.write_all(&100u32.to_be_bytes());
            for _ in 0..10 {
                thread::sleep(Duration::from_millis(30));
                if stream.write_all(b"x").is_err() {
                    break;
                }
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let started = std::time::Instant::now();
        assert!(
            read_frame_with_budget(&mut stream, MAX_REQUEST, Duration::from_millis(80)).is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(200));
        drop(stream);
        writer.join().unwrap();
    }
    #[test]
    fn event_reconnect_does_not_discover_or_start_a_replacement_owner() {
        let root = std::env::temp_dir().join(format!(
            "yam-relay-owner-{}",
            super::super::next_session_id()
        ));
        let original = Server::start(&root, |_| Ok(serde_json::Value::Null)).unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        drop(original);
        let seen = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let calls = seen.clone();
        let replacement = Server::start(&root, move |_| {
            calls.fetch_add(1, Ordering::AcqRel);
            Ok(serde_json::json!({"cursor":8,"gap":false,"events":[]}))
        })
        .unwrap();
        assert!(poll_events_with_reconnect(&client, 7, false).is_err());
        assert_eq!(
            seen.load(Ordering::Acquire),
            0,
            "stale desktop must not accept a new owner"
        );
        drop(replacement);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn event_poll_recovers_a_transient_failure_with_the_same_identity_and_cursor() {
        let root = std::env::temp_dir().join(format!(
            "yam-relay-retry-{}",
            super::super::next_session_id()
        ));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let requests = seen.clone();
        let server = Server::start(&root, move |request| {
            assert_eq!(request.command, "poll_events");
            assert_eq!(
                request.args,
                serde_json::json!({"cursor":7,"foreground":false})
            );
            let mut seen = requests.lock().unwrap();
            seen.push((request.client, request.id));
            if seen.len() == 1 {
                Err("Transient test failure".into())
            } else {
                Ok(serde_json::json!({"cursor":8,"gap":false,"events":[]}))
            }
        })
        .unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let (page, reconnected) = poll_events_with_reconnect(&client, 7, false).unwrap();
        assert_eq!(page.cursor, 8);
        assert!(reconnected);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, seen[1].0);
        assert_ne!(seen[0].1, seen[1].1);
        drop(seen);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
        let root = std::env::temp_dir().join(format!(
            "yam-relay-failure-{}",
            super::super::next_session_id()
        ));
        let count = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let attempts = count.clone();
        let server = Server::start(&root, move |_| {
            attempts.fetch_add(1, Ordering::AcqRel);
            Err("Unavailable".into())
        })
        .unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        assert!(poll_events_with_reconnect(&client, 7, false).is_err());
        assert_eq!(count.load(Ordering::Acquire), 3);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_worker_pool_waits_without_resetting_authenticated_clients() {
        let root =
            std::env::temp_dir().join(format!("yam-burst-{}", super::super::next_session_id()));
        let (started, observed) = std::sync::mpsc::channel();
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let worker_gate = gate.clone();
        let server = Server::start(&root, move |_| {
            started.send(()).unwrap();
            let (lock, condition) = &*worker_gate;
            drop(
                condition
                    .wait_while(lock.lock().unwrap(), |open| !*open)
                    .unwrap(),
            );
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let client = Client::new(descriptor.clone()).unwrap();
                thread::spawn(move || client.call("list_sessions", serde_json::json!({})))
            })
            .collect();
        for _ in 0..8 {
            observed.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        let client = Client::new(descriptor).unwrap();
        let ninth = thread::spawn(move || client.call("ping", serde_json::json!({})));
        thread::sleep(Duration::from_millis(80));
        let premature = ninth.is_finished();
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        let response = ninth.join().unwrap();
        assert!(
            !premature,
            "A saturated pool must retain the connection until a worker becomes free"
        );
        assert!(response.unwrap()["ready"].as_bool().unwrap());
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn accepted_shutdown_still_exits_if_the_requesting_peer_disconnects() {
        use std::os::fd::AsRawFd;
        let root = std::env::temp_dir().join(format!(
            "yam-shutdown-lost-{}",
            super::super::next_session_id()
        ));
        let (started, ready) = std::sync::mpsc::channel();
        let (exited, done) = std::sync::mpsc::channel();
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let worker_gate = gate.clone();
        let server = Server::start_owned(
            &root,
            OwnerLock::acquire(&root).unwrap(),
            move |_| {
                started.send(()).unwrap();
                let (lock, condition) = &*worker_gate;
                drop(
                    condition
                        .wait_while(lock.lock().unwrap(), |open| !*open)
                        .unwrap(),
                );
                Ok(serde_json::Value::Null)
            },
            move || {
                exited.send(()).unwrap();
            },
        )
        .unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        let mut socket = TcpStream::connect(descriptor.validate().unwrap()).unwrap();
        let request = Request {
            version: 1,
            token: descriptor.token,
            instance: descriptor.instance,
            client: "a".repeat(64),
            id: 1,
            command: "shutdown".into(),
            args: serde_json::json!({}),
        };
        write_frame(
            &mut socket,
            &serde_json::to_vec(&request).unwrap(),
            MAX_REQUEST,
        )
        .unwrap();
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let linger = libc::linger {
            l_onoff: 1,
            l_linger: 0,
        };
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_LINGER,
                    (&linger as *const libc::linger).cast(),
                    std::mem::size_of_val(&linger) as libc::socklen_t,
                )
            },
            0
        );
        drop(socket);
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let result = done.recv_timeout(Duration::from_secs(1));
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
        result.expect("Accepted stop-all must not retain a closed owner after the peer disappears");
    }
    #[test]
    fn shutdown_exit_runs_only_after_successful_reply() {
        let root =
            std::env::temp_dir().join(format!("yam-shutdown-{}", super::super::next_session_id()));
        let (sent, received) = std::sync::mpsc::channel();
        let server = Server::start_owned(
            &root,
            OwnerLock::acquire(&root).unwrap(),
            |request| {
                if request.args == serde_json::json!({}) {
                    Ok(serde_json::Value::Null)
                } else {
                    Err("shutdown failed".into())
                }
            },
            move || {
                sent.send(()).unwrap();
            },
        )
        .unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        assert!(client
            .call("shutdown", serde_json::json!({"invalid":true}))
            .is_err());
        assert!(received.try_recv().is_err());
        assert_eq!(
            client.call("shutdown", serde_json::json!({})).unwrap(),
            serde_json::Value::Null
        );
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn transport_authenticates_before_dispatch_and_binds_reply_identity() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let root = std::env::temp_dir().join(format!(
            "yam-background-rpc-{}",
            super::super::next_session_id()
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let server = Server::start(&root, move |request| {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({"command": request.command, "client": request.client, "args": request.args}))
        }).unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        let client = Client::new(descriptor.clone()).unwrap();
        assert_eq!(
            client.call("list_sessions", serde_json::json!({})).unwrap()["command"],
            "list_sessions"
        );
        let mut forged = descriptor.clone();
        forged.token = "0".repeat(64);
        assert!(Client::new(forged)
            .unwrap()
            .call("list_sessions", serde_json::json!({}))
            .is_err());
        let mut stale = descriptor;
        stale.instance = "1".repeat(64);
        assert!(Client::new(stale)
            .unwrap()
            .call("list_sessions", serde_json::json!({}))
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(client.call("bad-command", serde_json::json!({})).is_err());
        drop(server);
        assert!(client.call("list_sessions", serde_json::json!({})).is_err());
        assert!(OwnerLock::acquire(&root).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn framing_rejects_oversize_and_partial_requests_without_dispatch() {
        use std::net::TcpStream;
        let root = std::env::temp_dir().join(format!(
            "yam-background-frame-{}",
            super::super::next_session_id()
        ));
        let server = Server::start(&root, |_| panic!("invalid frame reached dispatcher")).unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        for size in [0u32, (MAX_REQUEST + 1) as u32] {
            let mut stream = TcpStream::connect(&descriptor.address).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            stream.write_all(&size.to_be_bytes()).unwrap();
            assert!(read_frame(&mut stream, MAX_RESPONSE).is_err());
        }
        let mut stream = TcpStream::connect(&descriptor.address).unwrap();
        stream.write_all(&100u32.to_be_bytes()).unwrap();
        stream.write_all(b"partial").unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(read_frame(&mut stream, MAX_RESPONSE).is_err());
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn credentials_and_instance_bind_every_request_before_dispatch() {
        let valid = serde_json::json!({"version":1,"token":"a".repeat(64),"instance":"b".repeat(64),"client":"c".repeat(64),"id":1,"command":"list_sessions","args":{}});
        let request = decode_request(
            valid.to_string().as_bytes(),
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        assert_eq!(request.command, "list_sessions");
        for field in ["token", "instance", "client"] {
            let mut invalid = valid.clone();
            invalid[field] = serde_json::json!("invalid");
            assert!(decode_request(
                invalid.to_string().as_bytes(),
                &"a".repeat(64),
                &"b".repeat(64)
            )
            .is_err());
        }
        let mut invalid = valid.clone();
        invalid["extra"] = serde_json::json!("secret");
        assert!(decode_request(
            invalid.to_string().as_bytes(),
            &"a".repeat(64),
            &"b".repeat(64)
        )
        .is_err());
        assert!(decode_request(
            &vec![b'x'; MAX_REQUEST + 1],
            &"a".repeat(64),
            &"b".repeat(64)
        )
        .is_err());
    }
    #[test]
    fn owner_lock_is_exclusive_and_released_by_handle_lifecycle() {
        let root = std::env::temp_dir().join(format!(
            "yam-background-lock-{}",
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let first = OwnerLock::acquire(&root).unwrap();
        assert!(OwnerLock::acquire(&root).is_err());
        drop(first);
        assert!(OwnerLock::acquire(&root).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn fifo_credentials_are_rejected_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let root = std::env::temp_dir().join(format!(
            "yam-background-fifo-{}",
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let path =
            std::ffi::CString::new(root.join("connection.json").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(Descriptor::read(&root).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn credentials_cannot_be_read_from_a_shared_file_or_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "yam-background-credential-{}",
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let descriptor = Descriptor {
            version: 1,
            address: "127.0.0.1:12345".into(),
            instance: "b".repeat(64),
            token: "a".repeat(64),
        };
        descriptor.publish(&root).unwrap();
        assert_eq!(
            std::fs::metadata(root.join("connection.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(Descriptor::read(&root).is_ok());
        std::fs::set_permissions(
            root.join("connection.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(Descriptor::read(&root).is_err());
        std::fs::rename(root.join("connection.json"), root.join("real.json")).unwrap();
        std::os::unix::fs::symlink(root.join("real.json"), root.join("connection.json")).unwrap();
        assert!(Descriptor::read(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
