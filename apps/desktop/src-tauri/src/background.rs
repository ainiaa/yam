// Author: Jeff.Liu. Authenticated, bounded transport for one user-owned background instance.
#[path = "background_dispatch.rs"]
mod commands;
use commands::argument;
#[path = "background_owner.rs"]
mod owner;
use super::background_events::start_event_poll;
#[cfg(test)]
use super::background_events::{lifecycle_due, poll as poll_events_with_reconnect};
pub(super) use super::background_relay::{Relay, RelayEvent, RelayPage};
use super::background_wire::{read_frame, read_frame_with_budget, write_frame};
#[cfg(test)]
use commands::claim_idle_update;
pub(super) use owner::run;
#[cfg(test)]
use owner::{configure_owner_app, idle_due, idle_maintenance_exit_due};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
#[cfg(test)]
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
pub(super) const PROTOCOL_VERSION: u8 = 2;
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
    if request.version != PROTOCOL_VERSION {
        return Err("Background protocol upgrade required; existing tasks continue until the owner is restarted".into());
    }
    if !hex(&request.token)
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
pub(super) fn private_root(root: &Path) -> Result<(), String> {
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
pub(super) fn protect_windows_path(path: &Path) -> Result<(), String> {
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
        if self.version != PROTOCOL_VERSION {
            return Err("Background protocol upgrade required; existing tasks continue until the owner is restarted".into());
        }
        if !hex(&self.token)
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
        Self::start_owned(
            root,
            OwnerLock::acquire(root)?,
            dispatch,
            || {},
            super::agent_bridge::credential()?[..32].to_string(),
        )
    }
    fn start_owned(
        root: &Path,
        owner: OwnerLock,
        dispatch: impl Fn(Request) -> Result<serde_json::Value, String> + Send + Sync + 'static,
        exit_after_reply: impl Fn() + Send + Sync + 'static,
        namespace: String,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Cannot bind background transport")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure background transport")?;
        let descriptor = Descriptor {
            version: PROTOCOL_VERSION,
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
                        let namespace = namespace.clone();
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
                                let shutdown = matches!(request.command.as_str(), "shutdown" | "prepare_update" | "finish_update");
                                let client = request.client.clone();
                                let id = request.id;
                                let result = if request.command == "ping"
                                    && request.args == serde_json::json!({})
                                {
                                    Ok(serde_json::json!({"ready":true,"start_key_context":namespace}))
                                } else if request.command == "cli_start" && !request.args["request_key"].as_str().is_some_and(|key| key.starts_with(&namespace)) {
                                    // A stale owner's key is never admitted to the start/cache dispatch.
                                    Ok(serde_json::json!({"outcome":"outcome_unknown"}))
                                } else {
                                    dispatch(request)
                                };
                                let mut response = Response {
                                    version: PROTOCOL_VERSION,
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

pub(crate) fn validate_command(command: &str, args: &serde_json::Value) -> Result<(), String> {
    if matches!(command, "get_git_changes" | "cancel_git_changes") {
        let object = args.as_object().ok_or("git_invalid_request")?;
        let allowed: &[&str] = if command == "get_git_changes" {
            &["path", "query_token", "selected_path", "side", "baseline"]
        } else {
            &["query_token"]
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str()))
            || !args["query_token"].as_str().is_some_and(|token| {
                token.len() == 36
                    && token.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                        }
                    })
            })
        {
            return Err("git_invalid_request".into());
        }
        if command == "get_git_changes"
            && (args["path"].as_str().is_none_or(|path| {
                path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control)
            }) || object.contains_key("selected_path") != object.contains_key("side")
                || (object.contains_key("selected_path")
                    && (args["selected_path"].as_str().is_none_or(|path| {
                        path.is_empty()
                            || path.len() > 4096
                            || path.chars().any(char::is_control)
                            || std::path::Path::new(path).is_absolute()
                            || path
                                .split(['/', '\\'])
                                .any(|part| part == ".." || part.is_empty())
                    }) || !matches!(
                        args["side"].as_str(),
                        Some("staged" | "worktree" | "committed")
                    ))))
        {
            return Err("git_invalid_request".into());
        }
        if command == "get_git_changes" {
            let baseline = object.get("baseline");
            if baseline.is_some_and(|value| {
                value
                    .as_str()
                    .is_none_or(|reference| !super::git_context::valid_baseline(reference))
            }) || object.contains_key("side")
                && ((args["side"] == "committed") != baseline.is_some())
            {
                return Err("git_invalid_request".into());
            }
        }
        return Ok(());
    }
    if command == "cli_events" && !args.get("cursor").is_some_and(serde_json::Value::is_u64) {
        return Err("cli_events_invalid".into());
    }
    let (allowed, required) = super::background_contract::command_fields(command)?;
    let args = super::background_contract::validate_fields(args, allowed, required)?;
    if let Some(guard) = args
        .get("expected_agent")
        .filter(|_| command == "write_session")
    {
        serde_json::from_value::<super::terminal_input::DraftInputGuard>(guard.clone())
            .map_err(|_| "Invalid background argument: expected_agent")?;
    }
    if matches!(command, "session_finish_pending" | "retry_session_finish")
        && args["session_id"]
            .as_str()
            .is_none_or(|id| super::session_id_from_link(&format!("yam://session/{id}")).is_none())
    {
        return Err("Invalid final persistence session identity".into());
    }
    if command == "open_terminal_stream"
        && (args["cols"]
            .as_u64()
            .is_none_or(|v| !(2..=500).contains(&v))
            || args["rows"]
                .as_u64()
                .is_none_or(|v| !(2..=200).contains(&v)))
    {
        return Err("Invalid terminal stream dimensions".into());
    }
    if command == "read_terminal_delta"
        && (args["offset"].as_u64().is_none()
            || !args["expected_instance"]
                .as_str()
                .is_some_and(super::clear_display_instance))
    {
        return Err("Invalid terminal stream cursor".into());
    }
    if command == "clear_terminal_display"
        && !args["expected_instance"]
            .as_str()
            .is_some_and(super::clear_display_instance)
    {
        return Err("Invalid terminal clear".into());
    }
    if command == "navigate_reported_prompt"
        && !args["direction"]
            .as_str()
            .zip(args["expected_instance"].as_str())
            .is_some_and(|(direction, instance)| {
                super::shell_command_report::navigation_arguments(direction, instance)
            })
    {
        return Err("Invalid reported prompt navigation".into());
    }
    if command == "set_terminal_viewport"
        && (args["line"]
            .as_u64()
            .is_none_or(|line| line > u32::MAX as u64)
            || args.get("bottom").is_some_and(|value| !value.is_boolean()))
    {
        return Err("Invalid terminal viewport".into());
    }
    if command == "set_global_shortcut"
        && (!args["enabled"].is_boolean()
            || args["expected_owner_instance"]
                .as_str()
                .is_none_or(|value| {
                    value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                }))
    {
        return Err("system_entry_invalid".into());
    }
    if matches!(
        command,
        "initialize_notification_pause" | "set_notification_paused"
    ) && (args["expected_owner_instance"]
        .as_str()
        .is_none_or(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || (command == "initialize_notification_pause" && !args["legacy_paused"].is_boolean())
        || (command == "set_notification_paused"
            && (!args["paused"].is_boolean() || !args["expected_revision"].is_u64())))
    {
        return Err("system_entry_invalid".into());
    }
    if command == "set_notification_locale"
        && !matches!(args["locale"].as_str(), Some("en" | "zh-CN"))
    {
        return Err("system_entry_invalid".into());
    }
    if command == "set_agent_notification_context"
        && (args.get("paused").is_some_and(|value| !value.is_boolean())
            || args
                .get("pause_revision")
                .is_some_and(|value| !value.is_u64())
            || (!args["selected"].is_null() && args["selected"].as_str().is_none()))
    {
        return Err("system_entry_invalid".into());
    }
    if matches!(
        command,
        "create_worktree" | "preview_worktree_cleanup" | "cleanup_worktree"
    ) {
        for field in if command == "cleanup_worktree" {
            &["attempt", "preview"][..]
        } else {
            &["attempt"][..]
        } {
            if args[*field].as_str().is_none_or(|value| {
                value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) {
                return Err("Invalid worktree identity".into());
            }
        }
    }
    if command == "preview_worktree_create" {
        for field in ["root", "target", "reference"] {
            if args[field].as_str().is_none_or(|value| {
                value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control)
            }) {
                return Err("Invalid worktree preview argument".into());
            }
        }
        if args.get("branch").is_some_and(|value| {
            !value.is_null()
                && value.as_str().is_none_or(|value| {
                    value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control)
                })
        }) {
            return Err("Invalid worktree branch".into());
        }
    }
    if command == "create_session"
        && args.get("worktree_attempt").is_some_and(|value| {
            !value.is_null()
                && value.as_str().is_none_or(|value| {
                    value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        })
    {
        return Err("Invalid worktree identity".into());
    }
    if matches!(command, "archive_session" | "restore_archive")
        && args
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|id| super::session_id_from_link(&format!("yam://session/{id}")).is_none())
    {
        return Err("Invalid archive identity".into());
    }
    if command == "set_history_policy" && !args["auto_archive_30_days"].is_boolean() {
        return Err("Invalid retention policy".into());
    }
    if command == "preview_archive_deletion"
        && args["session_ids"].as_array().is_none_or(|ids| {
            ids.is_empty()
                || ids.len() > 20
                || ids.iter().any(|id| {
                    id.as_str().is_none_or(|id| {
                        super::session_id_from_link(&format!("yam://session/{id}")).as_deref()
                            != Some(id)
                    })
                })
        })
    {
        return Err("Invalid deletion selection".into());
    }
    if matches!(
        command,
        "confirm_archive_deletion" | "cancel_archive_deletion_preview"
    ) && args["preview_id"].as_str().is_none_or(|id| {
        super::session_id_from_link(&format!("yam://session/{id}")).as_deref() != Some(id)
    }) {
        return Err("Invalid deletion preview".into());
    }
    if command == "get_git_context"
        && args["path"]
            .as_str()
            .is_none_or(|path| path.is_empty() || path.len() > 4096 || path.contains('\0'))
    {
        return Err("Invalid Git directory argument".into());
    }
    if matches!(command, "preview_project_config" | "trust_project_config")
        && args["cwd"]
            .as_str()
            .is_none_or(|path| path.is_empty() || path.len() > 4096 || path.contains('\0'))
    {
        return Err("Invalid project configuration directory".into());
    }
    if command == "trust_project_config" {
        let _: super::project_config::Preview = serde_json::from_value(args["preview"].clone())
            .map_err(|_| "Invalid project configuration preview")?;
    }
    if command == "set_launch_defaults" {
        let _: super::project_config::LaunchSettings =
            serde_json::from_value(args["defaults"].clone())
                .map_err(|_| "Invalid launch defaults")?;
    }
    if command == "create_session" {
        let provider_required = args.get("launch").is_some_and(|launch| {
            launch.get("provider").is_some_and(|value| !value.is_null())
                || launch
                    .get("env_refs")
                    .is_some_and(|value| value.as_object().is_none_or(|refs| !refs.is_empty()))
        }) || args
            .get("resume_from")
            .is_some_and(|value| !value.is_null())
            || args
                .get("project_config")
                .is_some_and(|value| !value.is_null());
        if (provider_required || args.contains_key("provider_protocol"))
            && args
                .get("provider_protocol")
                .and_then(serde_json::Value::as_u64)
                != Some(u64::from(crate::provider_launch::PROTOCOL_VERSION))
        {
            return Err("Provider isolation requires an updated background owner; fully quit and reopen YAM".into());
        }
        let reporting: Option<bool> = argument(
            &serde_json::Value::Object(args.clone()),
            "directory_reporting",
        )
        .map_err(|_| "directory_reporting_invalid_combination")?;
        let command_reporting: Option<bool> = argument(
            &serde_json::Value::Object(args.clone()),
            "command_reporting",
        )
        .map_err(|_| "command_reporting_invalid_combination")?;
        let ssh: Option<super::ssh_launch::SshLaunch> =
            argument(&serde_json::Value::Object(args.clone()), "ssh").map_err(|_| "ssh_invalid")?;
        let standalone_ssh = super::ssh_launch::standalone(
            ssh.as_ref(),
            [
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
                "shell",
            ]
            .iter()
            .any(|key| args.get(*key).is_some_and(|v| !v.is_null()))
                || args
                    .get("env_refs")
                    .is_some_and(|v| v.as_object().is_none_or(|v| !v.is_empty()))
                || reporting == Some(true)
                || command_reporting == Some(true),
        )?;
        let ordinary = ssh.is_none()
            && [
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
            ]
            .iter()
            .all(|key| args.get(*key).is_none_or(|v| v.is_null()));
        let retained: Option<u16> =
            argument(&serde_json::Value::Object(args.clone()), "retained_lines")
                .map_err(|_| "terminal_retention_invalid")?;
        super::terminal_retained_lines(retained, ordinary || standalone_ssh)?;
        let reporting_shell: Option<super::ShellLaunch> =
            argument(&serde_json::Value::Object(args.clone()), "shell")
                .map_err(|_| "shell_invalid")?;
        super::zsh_directory_reporting::validate(
            reporting.unwrap_or(false),
            ordinary,
            reporting_shell.as_ref(),
            cfg!(windows),
        )?;

        super::zsh_directory_reporting::validate(
            command_reporting.unwrap_or(false),
            ordinary,
            reporting_shell.as_ref(),
            cfg!(windows),
        )
        .map_err(|_| "command_reporting_invalid_combination")?;

        if let Some(value) = args.get("env_refs").filter(|v| !v.is_null()) {
            let refs: std::collections::BTreeMap<String, String> =
                serde_json::from_value(value.clone()).map_err(|_| "profile_env_invalid")?;
            if !refs.is_empty() {
                if args.get("shell").is_none_or(|v| v.is_null()) {
                    return Err("profile_env_shell_required".into());
                }
                if [
                    "command",
                    "launch",
                    "resume_from",
                    "project_config",
                    "worktree_attempt",
                ]
                .iter()
                .any(|key| args.get(*key).is_some_and(|v| !v.is_null()))
                {
                    return Err("profile_env_invalid_combination".into());
                }
                super::validate_profile_env_refs(&refs, cfg!(windows))?;
            }
        }
        if let Some(value) = args.get("shell").filter(|value| !value.is_null()) {
            let shell: super::ShellLaunch =
                serde_json::from_value(value.clone()).map_err(|_| "shell_invalid")?;
            super::validate_shell_launch(&shell)?;
            if [
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
            ]
            .iter()
            .any(|key| args.get(*key).is_some_and(|value| !value.is_null()))
            {
                return Err("shell_invalid_combination".into());
            }
        }
        if let Some(project) = args.get("project_config").filter(|value| !value.is_null()) {
            let _: super::project_config::ProjectStart = serde_json::from_value(project.clone())
                .map_err(|_| "Invalid project configuration launch")?;
        }
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
            if fields.keys().any(|key| {
                ![
                    "adapter",
                    "mode",
                    "extra_args",
                    "prompt",
                    "provider",
                    "env_refs",
                    "codex",
                    "omp",
                ]
                .contains(&key.as_str())
            }) {
                return Err("Invalid background launch fields".into());
            }
            let launch: super::AgentLaunch =
                serde_json::from_value(launch.clone()).map_err(|_| "Invalid background launch")?;
            super::codex_context::validate(&launch)?;
            super::project_config::validate_env_refs(&launch.env_refs)?;
            if let Some(provider) = &launch.provider {
                provider.validate(&launch.adapter, &launch.extra_args)?;
            }
        }
    }
    if command.starts_with("cli_") {
        if ["cli_show", "cli_focus", "cli_stop"].contains(&command) {
            let id = args
                .get("session_id")
                .and_then(serde_json::Value::as_str)
                .ok_or("Invalid CLI arguments")?;
            if super::session_id_from_link(&format!("yam://session/{id}")).is_none() {
                return Err("Invalid CLI arguments".into());
            }
        }
        if command == "cli_start" {
            let key = args
                .get("request_key")
                .and_then(serde_json::Value::as_str)
                .ok_or("Invalid CLI arguments")?;
            let start = args
                .get("start")
                .and_then(serde_json::Value::as_object)
                .ok_or("Invalid CLI arguments")?;
            if !super::cli::valid_key(key)
                || start.len() != 4
                || start
                    .keys()
                    .any(|key| !["cwd", "adapter", "mode", "prompt"].contains(&key.as_str()))
            {
                return Err("Invalid CLI arguments".into());
            }
            for field in ["cwd", "adapter", "mode", "prompt"] {
                if !start.get(field).is_some_and(serde_json::Value::is_string) {
                    return Err("Invalid CLI arguments".into());
                }
            }
            if start["cwd"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
                || start["prompt"].as_str().is_none_or(|s| s.len() > 65536)
                || start["adapter"].as_str().is_none_or(|s| {
                    s.is_empty()
                        || s.len() > 64
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
                || !["task", "interactive"].contains(&start["mode"].as_str().unwrap_or(""))
            {
                return Err("Invalid CLI arguments".into());
            }
        }
    }
    Ok(())
}
fn dispatch_session_start(
    starts: &std::sync::Mutex<StartRequests>,
    request: Request,
    dispatch: impl FnOnce(Request) -> Result<serde_json::Value, String>,
) -> Result<serde_json::Value, String> {
    validate_command(&request.command, &request.args)?;
    let client = request.client.clone();
    let id = request.id;
    let args = request.args.clone();
    starts
        .lock()
        .map_err(|_| "Start receipt lock poisoned")?
        .run(&client, id, args, || dispatch(request))
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

pub(super) fn connect_or_start(
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
    if let Err(error) = Descriptor::read(root) {
        if error.to_lowercase().contains("upgrade") && OwnerLock::acquire(root).is_err() {
            return Err(error);
        }
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
fn reap_background(
    mut child: std::process::Child,
) -> thread::JoinHandle<std::io::Result<std::process::ExitStatus>> {
    // Detaching the waiter lets the owner outlive the GUI while reaping any exit during its lifetime.
    thread::spawn(move || child.wait())
}

pub(super) fn attach(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("background");
    let client = Arc::new(connect_or_start(&root, || {
        let script = app
            .path()
            .resolve(
                "target/terminal-runtime/yam-terminal.cjs",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| e.to_string())?;
        let cache = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("runtimes/node");
        let node = super::node_runtime::resolve(&script, &cache, true, |phase| {
            use tauri::Emitter;
            let _ = app.emit("terminal-runtime-setup", phase);
        })?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let executable = super::mac_app::background_executable(&executable)?;
        let child = super::terminal_runtime::service_command(&executable)
            .arg("--yam-background")
            .arg("--yam-terminal-node")
            .arg(node)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start background: {e}"))?;
        reap_background(child);
        Ok(())
    })?);
    *app.state::<super::SessionManager>()
        .background_client
        .lock()
        .map_err(|_| "Background client lock poisoned")? = Some(client.clone());
    start_event_poll(app, client)
}

fn reconnect_existing(
    manager: &super::SessionManager,
    start: impl FnOnce(Arc<Client>) -> Result<(), String>,
) -> Result<(), String> {
    if manager.background_owner || manager.shutting_down.load(Ordering::Acquire) {
        return Err("background_reconnect_unavailable".into());
    }
    let client = manager
        .background_client
        .lock()
        .map_err(|_| "background_reconnect_unavailable")?
        .clone()
        .ok_or("background_reconnect_unavailable")?;
    client.call("history_overview", serde_json::json!({}))?;
    start(client)
}

#[tauri::command]
pub(super) async fn reconnect_background(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        reconnect_existing(&app.state::<super::SessionManager>(), |client| {
            start_event_poll(&app, client)
        })
    })
    .await
    .map_err(|_| "background_reconnect_unavailable")?
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

pub(super) enum CallOutcome {
    NotDispatched(String),
    Completed(Result<serde_json::Value, String>),
    Unknown(String),
}
impl CallOutcome {
    fn into_result(self) -> Result<serde_json::Value, String> {
        match self {
            Self::Completed(result) => result,
            Self::NotDispatched(error) | Self::Unknown(error) => Err(error),
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
        self.call_outcome(command, args).into_result()
    }
    pub(super) fn call_outcome(&self, command: &str, args: serde_json::Value) -> CallOutcome {
        let (id, bytes) = match self.encode_request(command, args) {
            Ok(value) => value,
            Err(error) => return CallOutcome::NotDispatched(error),
        };
        let exchange = || -> Result<Vec<u8>, (bool, String)> {
            let address = self.descriptor.validate().map_err(|error| (false, error))?;
            let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                .map_err(|_| (false, "Background instance is unavailable".into()))?;
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .map_err(|_| (false, "Cannot bound background request".into()))?;
            // Any write attempt can have reached the authenticated owner, including a partial write.
            write_frame(&mut stream, &bytes, MAX_REQUEST).map_err(|error| (true, error))?;
            let (limit, deadline) = if command == "diagnostics_report" {
                (1024 * 1024, Duration::from_secs(3))
            } else if command == "pi_packages"
                || command == "pi_routing_catalog"
                || command == "codex_routing_catalog"
            {
                (2 * 1024 * 1024, Duration::from_secs(150))
            } else {
                (MAX_RESPONSE, Duration::from_secs(35))
            };
            read_frame_with_budget(&mut stream, limit, deadline).map_err(|error| (true, error))
        };
        let reply = match exchange() {
            Ok(reply) => reply,
            Err((attempted, error)) => {
                if command == "create_session" {
                    match exchange() {
                        Ok(reply) => reply,
                        Err((retry_attempted, error)) => {
                            return if attempted || retry_attempted {
                                CallOutcome::Unknown(format!("Background {command}: {error}"))
                            } else {
                                CallOutcome::NotDispatched(format!("Background {command}: {error}"))
                            }
                        }
                    }
                } else {
                    return if attempted {
                        CallOutcome::Unknown(format!("Background {command}: {error}"))
                    } else {
                        CallOutcome::NotDispatched(format!("Background {command}: {error}"))
                    };
                }
            }
        };
        match self.decode_response(&reply, id) {
            Ok(response) => CallOutcome::Completed(response.result),
            Err(error) => CallOutcome::Unknown(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::input_leases::InputLeases;

    #[cfg(unix)]
    #[test]
    fn background_waiter_preserves_live_child_and_reaps_normal_exit() {
        let mut child = std::process::Command::new("/bin/cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let input = child.stdin.take().unwrap();
        let waiter = super::reap_background(child);
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        assert!(!waiter.is_finished());
        drop(input);
        assert!(waiter.join().unwrap().unwrap().success());
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[cfg(unix)]
    include!("coverage_background_tests.rs");
    #[test]
    fn a07c3_prompt_navigation_strict_arguments() {
        let valid = serde_json::json!({"session_id":"s","direction":"previous","expected_instance":"a".repeat(64)});
        assert!(super::validate_command("navigate_reported_prompt", &valid).is_ok());
        for field in ["direction", "expected_instance"] {
            let mut bad = valid.clone();
            bad[field] = serde_json::json!("bad");
            assert!(super::validate_command("navigate_reported_prompt", &bad).is_err());
        }
        let mut extra = valid.clone();
        extra["line"] = serde_json::json!(1);
        assert!(super::validate_command("navigate_reported_prompt", &extra).is_err());
    }

    #[test]
    fn a05a3_strict_retention_create_is_validated_before_dispatch() {
        for lines in [200, 500, 2000] {
            assert!(super::validate_command(
                "create_session",
                &serde_json::json!({"retained_lines":lines})
            )
            .is_ok());
        }
        assert!(super::validate_command(
            "create_session",
            &serde_json::json!({"retained_lines":null})
        )
        .is_ok());
        for lines in [
            serde_json::json!(199),
            serde_json::json!(2001),
            serde_json::json!(1.5),
            serde_json::json!("500"),
            serde_json::json!(true),
        ] {
            assert!(super::validate_command(
                "create_session",
                &serde_json::json!({"retained_lines":lines})
            )
            .is_err());
        }
        for field in [
            "command",
            "launch",
            "resume_from",
            "project_config",
            "worktree_attempt",
        ] {
            let mut args = serde_json::json!({"retained_lines":500});
            args[field] = serde_json::json!("");
            assert!(super::validate_command("create_session", &args).is_err());
        }
    }
    #[test]
    fn a07c2_strict_command_defaults_and_nonordinary_shapes_are_guarded() {
        for shell in [
            serde_json::Value::Null,
            serde_json::json!({"program":null,"login":true}),
            serde_json::json!({"program":null,"login":false}),
        ] {
            let args = serde_json::json!({"command_reporting":true,"shell":shell});
            assert!(super::validate_command("create_session", &args).is_ok());
            for field in [
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
            ] {
                let mut bad = args.clone();
                bad[field] = serde_json::json!("");
                assert!(super::validate_command("create_session", &bad).is_err());
            }
        }
    }
    #[test]
    fn a07c2_invalid_command_reporting_requests_fail_before_dispatch() {
        for args in [
            serde_json::json!({"command_reporting":true,"command":""}),
            serde_json::json!({"command_reporting":"true"}),
            serde_json::json!({"command_reporting":true,"shell":{"program":"/bin/fish","login":true}}),
        ] {
            assert!(
                super::validate_command("create_session", &args).is_err(),
                "{args}"
            );
        }
        for flag in [serde_json::Value::Null, serde_json::json!(false)] {
            assert!(super::validate_command(
                "create_session",
                &serde_json::json!({"command_reporting":flag})
            )
            .is_ok());
        }
    }

    #[test]
    fn a07b2_strict_defaults_and_nonordinary_shapes_are_guarded() {
        for shell in [
            serde_json::Value::Null,
            serde_json::json!({"program":null,"login":true}),
            serde_json::json!({"program":null,"login":false}),
        ] {
            let args = serde_json::json!({"directory_reporting":true,"shell":shell});
            assert!(super::validate_command("create_session", &args).is_ok());
            for field in [
                "command",
                "launch",
                "resume_from",
                "project_config",
                "worktree_attempt",
            ] {
                let mut bad = args.clone();
                bad[field] = serde_json::json!("");
                assert!(super::validate_command("create_session", &bad).is_err());
            }
        }
    }
    #[test]
    fn a07b1_invalid_reporting_requests_fail_before_dispatch() {
        for args in [
            serde_json::json!({"directory_reporting":true,"command":""}),
            serde_json::json!({"directory_reporting":"true"}),
            serde_json::json!({"directory_reporting":true,"shell":{"program":"/bin/fish","login":true}}),
        ] {
            assert!(
                super::validate_command("create_session", &args).is_err(),
                "{args}"
            );
        }
        for flag in [serde_json::Value::Null, serde_json::json!(false)] {
            assert!(super::validate_command(
                "create_session",
                &serde_json::json!({"directory_reporting":flag})
            )
            .is_ok());
        }
    }

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
    #[test]
    fn viewport_bottom_intent_is_optional_boolean_and_keeps_line_validation() {
        for args in [
            serde_json::json!({"session_id":"s-one","line":0,"bottom":true}),
            serde_json::json!({"session_id":"s-one","line":2,"bottom":false}),
            serde_json::json!({"session_id":"s-one","line":2}),
        ] {
            assert!(validate_command("set_terminal_viewport", &args).is_ok());
        }
        for args in [
            serde_json::json!({"session_id":"s-one","line":0,"bottom":"true"}),
            serde_json::json!({"session_id":"s-one","line":0,"bottom":null}),
            serde_json::json!({"session_id":"s-one","line":-1,"bottom":true}),
            serde_json::json!({"session_id":"s-one","line":4294967296u64}),
            serde_json::json!({"session_id":"s-one","bottom":true}),
            serde_json::json!({"session_id":"s-one","line":0,"bottom":true,"data":"input"}),
        ] {
            assert!(validate_command("set_terminal_viewport", &args).is_err());
        }
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
    fn a01b_rpc_shape_and_combination_are_strict() {
        let valid = serde_json::json!({"program":null,"login":if cfg!(windows){serde_json::Value::Null}else{serde_json::json!(true)}});
        assert!(validate_command("create_session", &serde_json::json!({})).is_ok());
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"shell":null,"command":"literal"})
        )
        .is_ok());
        for shell in [
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!({"program":null}),
            serde_json::json!({"login":true}),
            serde_json::json!({"program":null,"login":false,"argv":[]}),
            serde_json::json!({"program":null,"login":"false"}),
        ] {
            assert!(
                validate_command("create_session", &serde_json::json!({"shell":shell})).is_err()
            );
        }
        for (key, value) in [
            ("command", serde_json::json!("")),
            (
                "launch",
                serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null}),
            ),
            ("resume_from", serde_json::json!("stored")),
            (
                "project_config",
                serde_json::json!({"root":"/fixture","template":null,"overrides":{}}),
            ),
            ("worktree_attempt", serde_json::json!("a".repeat(64))),
        ] {
            let mut args = serde_json::json!({"shell":valid});
            if matches!(key, "resume_from" | "project_config") {
                args["provider_protocol"] =
                    serde_json::json!(crate::provider_launch::PROTOCOL_VERSION);
            }
            args[key] = value;
            assert_eq!(
                validate_command("create_session", &args).unwrap_err(),
                "shell_invalid_combination"
            );
        }
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"shell":valid,"session_id":"forged"})
        )
        .is_err());
    }

    #[test]
    fn a01b_rpc_accepts_explicit_ordinary_shell() {
        #[cfg(unix)]
        let shell = serde_json::json!({"program":"/bin/bash","login":false});
        #[cfg(windows)]
        let shell = serde_json::json!({"program":null,"login":null});
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"cwd":null,"command":null,"launch":null,"shell":shell})
        )
        .is_ok());
    }

    #[test]
    fn t13_worktree_rpc_accepts_only_semantic_bounded_arguments() {
        for (name, value) in [
            (
                "preview_worktree_create",
                serde_json::json!({"root":"/fixture/repo","target":"/fixture/worktree","reference":"refs/heads/main","branch":null}),
            ),
            (
                "create_worktree",
                serde_json::json!({"attempt":"a".repeat(64)}),
            ),
            ("list_managed_worktrees", serde_json::json!({})),
            (
                "preview_worktree_cleanup",
                serde_json::json!({"attempt":"a".repeat(64)}),
            ),
            (
                "cleanup_worktree",
                serde_json::json!({"attempt":"a".repeat(64),"preview":"b".repeat(64)}),
            ),
        ] {
            assert!(
                validate_command(name, &value).is_ok(),
                "semantic command {name} must be accepted"
            );
        }
        assert!(validate_command(
            "create_worktree",
            &serde_json::json!({"attempt":"a".repeat(64),"session_id":"forged","command":"git"})
        )
        .is_err());
    }
    #[test]
    fn t13_create_session_accepts_opaque_attempt_but_not_arbitrary_session_id() {
        assert!(validate_command("create_session",&serde_json::json!({"cwd":"/fixture/worktree","command":null,"launch":null,"resume_from":null,"worktree_attempt":"a".repeat(64)})).is_ok());
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"cwd":"/fixture/worktree","session_id":"forged"})
        )
        .is_err());
    }
    #[test]
    fn t12_git_context_rpc_has_only_bounded_directory_argument() {
        assert!(
            validate_command("get_git_context", &serde_json::json!({"path":"/fixture"})).is_ok()
        );
        for value in [
            serde_json::json!({}),
            serde_json::json!({"path":3}),
            serde_json::json!({"path":""}),
            serde_json::json!({"path":"/fixture","command":"status"}),
            serde_json::json!({"path":"x".repeat(4097)}),
        ] {
            assert!(validate_command("get_git_context", &value).is_err());
        }
    }
    #[test]
    fn owner_status_has_no_arguments_or_arbitrary_inspection_targets() {
        assert!(validate_command("background_status", &serde_json::json!({})).is_ok());
        assert!(validate_command("background_status", &serde_json::json!({"pid":1})).is_err());
        assert!(validate_command("memory_processes", &serde_json::json!({})).is_ok());
        assert!(validate_command("memory_processes", &serde_json::json!({"pid":1})).is_err());
    }
    #[test]
    fn diagnostics_rpc_accepts_no_inspection_targets_and_limits_response_size() {
        assert!(validate_command("diagnostics_report", &serde_json::json!({})).is_ok());
        for args in [
            serde_json::json!({"path":"/private/secret"}),
            serde_json::json!({"session_id":"secret"}),
            serde_json::json!({"prompt":"secret"}),
        ] {
            assert!(validate_command("diagnostics_report", &args).is_err());
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = Client::new(Descriptor {
            version: PROTOCOL_VERSION,
            address: listener.local_addr().unwrap().to_string(),
            instance: "b".repeat(64),
            token: "a".repeat(64),
        })
        .unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _: Request =
                serde_json::from_slice(&read_frame(&mut stream, MAX_REQUEST).unwrap()).unwrap();
            // An authenticated owner may be faulty; reject its length before allocating a body.
            stream
                .write_all(&(1024 * 1024 + 1u32).to_be_bytes())
                .unwrap();
        });
        assert!(client
            .call("diagnostics_report", serde_json::json!({}))
            .is_err());
        server.join().unwrap();
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
    fn native_query_responder_follows_only_its_live_lease_and_explicit_release() {
        let mut leases = InputLeases::default();
        assert!(leases.headless_queries("s-one", 0));
        leases.take_external("s-one", "external", 100);
        assert!(!leases.headless_queries("s-one", 101));
        leases.claim("s-one", "external", 1000).unwrap();
        leases.release("s-one", "other");
        assert!(!leases.headless_queries("s-one", 1001));
        assert!(leases.headless_queries("s-other", 1001));
        assert!(leases.headless_queries("s-one", 4001));
        leases.claim("s-one", "desktop", 4001).unwrap();
        assert!(leases.headless_queries("s-one", 4001));
        leases.take_external("s-one", "external", 5000);
        leases.take_control("s-one", "desktop", 5001);
        leases.release("s-one", "external");
        assert!(leases.headless_queries("s-one", 5001));
        assert!(leases.claim("s-one", "other", 5002).is_err());
        leases.take_external("s-one", "external", 6000);
        leases.release("s-one", "external");
        assert!(leases.headless_queries("s-one", 6001));
        assert!(leases.claim("s-one", "desktop", 6001).is_ok());
    }
    #[test]
    fn stream_requests_are_strict_and_cannot_inject_paths_clients_or_unbounded_reads() {
        let args = serde_json::json!({"session_id":"s-one","expected_instance":"a".repeat(64),"offset":42});
        assert!(validate_command("read_terminal_delta", &args).is_ok());
        for (key, value) in [
            ("offset", serde_json::json!(-1)),
            ("offset", serde_json::json!(1.5)),
            ("expected_instance", serde_json::json!("bad")),
            ("path", serde_json::json!("/etc/passwd")),
            ("limit", serde_json::json!(u64::MAX)),
            ("client", serde_json::json!("other")),
        ] {
            let mut invalid = args.clone();
            invalid[key] = value;
            assert!(
                validate_command("read_terminal_delta", &invalid).is_err(),
                "{key}"
            );
        }
        assert!(validate_command(
            "open_terminal_stream",
            &serde_json::json!({"session_id":"s-one","cols":80,"rows":24})
        )
        .is_ok());
        for (cols, rows) in [(1, 24), (501, 24), (80, 1), (80, 201)] {
            assert!(validate_command(
                "open_terminal_stream",
                &serde_json::json!({"session_id":"s-one","cols":cols,"rows":rows})
            )
            .is_err());
        }
        {
            let op = "release_terminal_control";
            assert!(validate_command(op, &serde_json::json!({"session_id":"s-one"})).is_ok());
            assert!(validate_command(
                op,
                &serde_json::json!({"session_id":"s-one","client":"forged"})
            )
            .is_err());
        }
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
                .call("history_overview", serde_json::json!({}))
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
            version: PROTOCOL_VERSION,
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
                version: PROTOCOL_VERSION,
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
    fn t04_old_client_receives_upgrade_before_archive_mutation() {
        let token = "a".repeat(64);
        let instance = "b".repeat(64);
        let request = serde_json::to_vec(&serde_json::json!({"version":1,"token":token,"instance":instance,"client":"c".repeat(64),"id":1,"command":"archive_session","args":{"session_id":"s-old"}})).unwrap();
        let error = decode_request(&request, &token, &instance)
            .err()
            .expect("v1 clients must be refused before dispatch");
        assert!(error.to_lowercase().contains("upgrade"));
    }
    #[test]
    fn t04_upgrade_keeps_old_live_owner_and_does_not_start_replacement() {
        let root =
            std::env::temp_dir().join(format!("yam-old-owner-{}", super::super::next_session_id()));
        let lock = OwnerLock::acquire(&root).unwrap();
        let descriptor = serde_json::json!({"version":1,"address":"127.0.0.1:1","token":"a".repeat(64),"instance":"b".repeat(64)});
        let bytes = serde_json::to_vec(&descriptor).unwrap();
        private_file(&root.join("connection.json"), true)
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        let starts = std::cell::Cell::new(0);
        let error = connect_or_start(&root, || {
            starts.set(starts.get() + 1);
            Err("unexpected replacement".into())
        })
        .err()
        .unwrap();
        assert_eq!(starts.get(), 0);
        assert_eq!(std::fs::read(root.join("connection.json")).unwrap(), bytes);
        assert!(
            OwnerLock::acquire(&root).is_err(),
            "existing owner lease remains held"
        );
        assert!(
            error.to_lowercase().contains("upgrade"),
            "incompatible live owner needs an explicit upgrade message: {error}"
        );
        drop(lock);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn t04_archive_rpc_validates_only_bounded_id_and_page_arguments() {
        assert!(validate_command(
            "archive_session",
            &serde_json::json!({"session_id":"s-valid"})
        )
        .is_ok());
        assert!(validate_command(
            "restore_archive",
            &serde_json::json!({"session_id":"s-valid"})
        )
        .is_ok());
        assert!(validate_command(
            "list_archived_sessions",
            &serde_json::json!({"request":{"page_size":100}})
        )
        .is_ok());
        assert!(validate_command(
            "archive_session",
            &serde_json::json!({"session_id":"s-valid","path":"/tmp/escape"})
        )
        .is_err());
        assert!(validate_command(
            "archive_session",
            &serde_json::json!({"session_id":"../escape"})
        )
        .is_err());
    }
    #[test]
    fn clear_arguments_and_read_only_lease_admission() {
        let valid = serde_json::json!({"session_id":"s","expected_instance":"a".repeat(64)});
        assert!(super::validate_command("clear_terminal_display", &valid).is_ok());
        for bad in [
            serde_json::json!({"session_id":"s"}),
            serde_json::json!({"session_id":"s","expected_instance":"A".repeat(64)}),
            serde_json::json!({"session_id":"s","expected_instance":"a".repeat(64),"mode":"all"}),
        ] {
            assert!(super::validate_command("clear_terminal_display", &bad).is_err());
        }
        let mut leases = InputLeases::default();
        assert!(leases.available("s", "one", 1));
        assert!(leases.owners.is_empty());
        leases.claim("s", "one", 100).unwrap();
        let original = leases.owners.clone();
        assert!(leases.available("s", "one", 101));
        assert!(!leases.available("s", "two", 3100));
        assert!(leases.available("s", "two", 3101));
        assert_eq!(leases.owners, original);
    }
    #[test]
    fn interactive_shell_recovery_rpc_refuses_force_and_process_targets() {
        assert!(validate_command(
            "recover_terminal_agent",
            &serde_json::json!({"session_id":"s-valid"})
        )
        .is_ok());
        for extra in ["force", "pid", "path", "generation", "run"] {
            let mut args = serde_json::json!({"session_id":"s-valid"});
            args[extra] = serde_json::json!(true);
            assert!(validate_command("recover_terminal_agent", &args).is_err());
        }
        assert!(validate_command("recover_terminal_agent", &serde_json::json!({})).is_err());
    }
    #[test]
    fn lifecycle_finish_rpc_requires_only_a_bounded_session_identity() {
        for command in ["session_finish_pending", "retry_session_finish"] {
            assert!(
                validate_command(command, &serde_json::json!({"session_id":"s-owned"})).is_ok()
            );
            for args in [
                serde_json::json!({}),
                serde_json::json!({"session_id":"../other"}),
                serde_json::json!({"session_id":"s-owned","force":true}),
            ] {
                assert!(validate_command(command, &args).is_err());
            }
        }
    }

    #[test]
    fn dispatcher_accepts_only_known_commands_and_their_exact_argument_shape() {
        assert!(validate_command("history_overview", &serde_json::json!({})).is_ok());
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
            "history_overview",
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
                thread::spawn(move || client.call("history_overview", serde_json::json!({})))
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
        for command in ["shutdown", "prepare_update"] {
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
                "d".repeat(32),
            )
            .unwrap();
            let descriptor = Descriptor::read(&root).unwrap();
            let mut socket = TcpStream::connect(descriptor.validate().unwrap()).unwrap();
            let request = Request {
                version: PROTOCOL_VERSION,
                token: descriptor.token,
                instance: descriptor.instance,
                client: "a".repeat(64),
                id: 1,
                command: command.into(),
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
            result.expect(
                "Accepted stop-all must not retain a closed owner after the peer disappears",
            );
        }
    }
    #[test]
    fn shutdown_exit_runs_only_after_successful_reply() {
        for command in ["shutdown", "prepare_update"] {
            let root = std::env::temp_dir()
                .join(format!("yam-shutdown-{}", super::super::next_session_id()));
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
                "d".repeat(32),
            )
            .unwrap();
            let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
            assert!(client
                .call(command, serde_json::json!({"invalid":true}))
                .is_err());
            assert!(received.try_recv().is_err());
            assert_eq!(
                client.call(command, serde_json::json!({})).unwrap(),
                serde_json::Value::Null
            );
            received.recv_timeout(Duration::from_secs(1)).unwrap();
            drop(server);
            std::fs::remove_dir_all(root).unwrap();
        }
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
            client
                .call("history_overview", serde_json::json!({}))
                .unwrap()["command"],
            "history_overview"
        );
        let mut forged = descriptor.clone();
        forged.token = "0".repeat(64);
        assert!(Client::new(forged)
            .unwrap()
            .call("history_overview", serde_json::json!({}))
            .is_err());
        let mut stale = descriptor;
        stale.instance = "1".repeat(64);
        assert!(Client::new(stale)
            .unwrap()
            .call("history_overview", serde_json::json!({}))
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(client.call("bad-command", serde_json::json!({})).is_err());
        drop(server);
        assert!(client
            .call("history_overview", serde_json::json!({}))
            .is_err());
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
        let valid = serde_json::json!({"version":PROTOCOL_VERSION,"token":"a".repeat(64),"instance":"b".repeat(64),"client":"c".repeat(64),"id":1,"command":"history_overview","args":{}});
        let request = decode_request(
            valid.to_string().as_bytes(),
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        assert_eq!(request.command, "history_overview");
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
            version: PROTOCOL_VERSION,
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

#[cfg(test)]
mod history_rpc_tests {
    use super::*;
    #[test]
    fn t05_existing_idle_boundaries_still_require_sixty_seconds_and_zero_active() {
        assert!(!idle_due(59_999, 0, 0));
        assert!(idle_due(60_000, 0, 0));
        assert!(!idle_due(60_000, 1, 0));
        assert!(!idle_due(60_000, 0, 1));
    }
    #[test]
    fn t05_idle_post_batch_new_rpc_and_active_task_prevent_owner_exit() {
        assert_eq!(
            idle_maintenance_exit_due(62_000, 61_999, 0),
            Ok(false),
            "a newer RPC during maintenance revokes the old idle decision"
        );
        assert_eq!(
            idle_maintenance_exit_due(62_000, 0, 1),
            Ok(false),
            "a newly active task during maintenance keeps its owner alive"
        );
        assert_eq!(idle_maintenance_exit_due(62_000, 0, 0), Ok(true));
    }
    #[test]
    fn t05_retention_rpc_accepts_only_policy_and_exact_preview_tokens() {
        for (command, args) in [
            ("get_history_policy", serde_json::json!({})),
            (
                "set_history_policy",
                serde_json::json!({"auto_archive_30_days":false}),
            ),
            (
                "preview_archive_deletion",
                serde_json::json!({"session_ids":["s-fixture"]}),
            ),
            (
                "cancel_archive_deletion_preview",
                serde_json::json!({"preview_id":"s-preview"}),
            ),
            (
                "confirm_archive_deletion",
                serde_json::json!({"preview_id":"s-preview"}),
            ),
        ] {
            assert!(
                validate_command(command, &args).is_ok(),
                "{command}: missing authorized retention RPC"
            );
            let mut injected = args.clone();
            injected
                .as_object_mut()
                .unwrap()
                .insert("path".into(), "/native-cli/history".into());
            assert_eq!(
                validate_command(command, &injected).unwrap_err(),
                "Invalid background command arguments"
            );
        }
    }
    #[test]
    fn t05_retention_rpc_rejects_unbounded_ids_and_automatic_delete_flags() {
        for args in [
            serde_json::json!({"auto_archive_30_days":"yes"}),
            serde_json::json!({"auto_archive_30_days":null}),
        ] {
            assert_eq!(
                validate_command("set_history_policy", &args).unwrap_err(),
                "Invalid retention policy"
            );
        }
        assert_eq!(
            validate_command(
                "set_history_policy",
                &serde_json::json!({"auto_archive_30_days":true,"auto_delete":true})
            )
            .unwrap_err(),
            "Invalid background command arguments"
        );
        for ids in [
            serde_json::json!([]),
            serde_json::json!(["../s-bad"]),
            serde_json::json!([1]),
            serde_json::json!(vec!["s-fixture"; 21]),
        ] {
            assert_eq!(
                validate_command(
                    "preview_archive_deletion",
                    &serde_json::json!({"session_ids":ids})
                )
                .unwrap_err(),
                "Invalid deletion selection"
            );
        }
        for command in [
            "confirm_archive_deletion",
            "cancel_archive_deletion_preview",
        ] {
            assert_eq!(
                validate_command(command, &serde_json::json!({"preview_id":"../../history"}))
                    .unwrap_err(),
                "Invalid deletion preview"
            );
        }
    }
    #[test]
    fn history_legacy_authenticated_list_rpc_remains_valid_for_packaged_smoke_clients() {
        assert!(
            validate_command("list_sessions", &serde_json::json!({})).is_ok(),
            "existing authenticated packaged clients must retain their no-argument read command"
        );
        assert!(
            validate_command("list_sessions", &serde_json::json!({"session_id":"s-old"})).is_err()
        );
    }
    #[test]
    fn history_rpc_accepts_bounded_commands_and_rejects_unexpected_fields() {
        for (command, args) in [
            ("list_session_summaries", serde_json::json!({"request":{}})),
            ("get_session", serde_json::json!({"session_id":"s-old"})),
            ("history_overview", serde_json::json!({})),
            ("list_unread_receipts", serde_json::json!({"request":{}})),
            (
                "next_attention",
                serde_json::json!({"current_session_id":null}),
            ),
            (
                "list_pending_notifications",
                serde_json::json!({"limit":100,"after_key":null}),
            ),
            ("scan_history_capacity", serde_json::json!({})),
            ("cancel_history_capacity", serde_json::json!({})),
        ] {
            assert!(validate_command(command, &args).is_ok(), "{command}");
            let mut args = args;
            args.as_object_mut()
                .unwrap()
                .insert("unexpected".into(), true.into());
            assert!(validate_command(command, &args).is_err());
        }
    }
}

#[cfg(test)]
mod t09_project_rpc_tests {
    use super::*;
    #[test]
    fn t09_project_rpc_has_exact_preview_trust_defaults_and_create_shapes() {
        for (command, args) in [
            ("get_launch_defaults", serde_json::json!({})),
            (
                "set_launch_defaults",
                serde_json::json!({"defaults":{"adapter":"codex"}}),
            ),
            (
                "preview_project_config",
                serde_json::json!({"cwd":"/fixture"}),
            ),
            (
                "trust_project_config",
                serde_json::json!({"cwd":"/fixture","preview":{"root":"/fixture","identity":"1:2","source":"{}","config":null,"trusted":false}}),
            ),
            (
                "create_session",
                serde_json::json!({"provider_protocol":crate::provider_launch::PROTOCOL_VERSION,"project_config":{"root":"/fixture","template":null,"overrides":{}}}),
            ),
        ] {
            assert!(validate_command(command, &args).is_ok(), "{command}");
        }
        for args in [
            serde_json::json!({"project_config":{"root":"/fixture","template":null,"overrides":{},"env_values":{"KEY":"secret"}}}),
            serde_json::json!({"project_config":{"root":3,"overrides":{}}}),
        ] {
            assert!(validate_command("create_session", &args).is_err());
        }
        assert!(validate_command(
            "preview_project_config",
            &serde_json::json!({"cwd":"/fixture","execute":true})
        )
        .is_err());
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"cwd":"/fixture","command":"echo old","launch":null})
        )
        .is_ok());
        assert!(validate_command(
            "create_session",
            &serde_json::json!({"provider_protocol":crate::provider_launch::PROTOCOL_VERSION,"resume_from":"s-fixture"})
        )
        .is_ok());
    }
}

#[cfg(test)]
mod cli_contract_tests {
    use super::*;
    use serde_json::json;
    fn request(client: &str, key: &str, args: serde_json::Value) -> Request {
        Request {
            version: PROTOCOL_VERSION,
            token: "a".repeat(64),
            instance: "b".repeat(64),
            client: client.repeat(64),
            id: 1,
            command: "cli_start".into(),
            args: json!({"request_key":key,"start":args}),
        }
    }
    #[test]
    fn t16_owner_start_key_deduplicates_two_fresh_client_sequence_one_requests() {
        let mut receipts = StartRequests::default();
        let mut allocations = 0;
        let args = json!({"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"});
        let first = request("c", &"d".repeat(64), args.clone());
        let second = request("e", &"d".repeat(64), args);
        let one = receipts
            .run_cli(&first, || {
                allocations += 1;
                Ok(json!({"session_id":"s-1-2"}))
            })
            .unwrap();
        let two = receipts
            .run_cli(&second, || {
                allocations += 1;
                Ok(json!({"session_id":"s-1-3"}))
            })
            .unwrap();
        assert_eq!(one, two);
        assert_eq!(allocations, 1);
    }
    #[test]
    fn t16_owner_key_mismatch_and_budget_refuse_without_eviction_or_allocation() {
        let mut receipts = StartRequests::default();
        let mut allocations = 0;
        for i in 0..256 {
            let r = request("c", &format!("{i:064x}"), json!({"cwd":"/fixture"}));
            receipts
                .run_cli(&r, || {
                    allocations += 1;
                    Ok(json!({"session_id":"s-1-2"}))
                })
                .unwrap();
        }
        let before = allocations;
        assert!(receipts
            .run_cli(
                &request("e", &format!("{:064x}", 256), json!({"cwd":"/fixture"})),
                || {
                    allocations += 1;
                    Ok(json!({}))
                }
            )
            .is_err());
        assert!(receipts
            .run_cli(
                &request("e", &format!("{:064x}", 0), json!({"cwd":"/different"})),
                || {
                    allocations += 1;
                    Ok(json!({}))
                }
            )
            .is_err());
        assert!(receipts
            .run_cli(
                &request("e", &format!("{:064x}", 0), json!({"cwd":"/fixture"})),
                || {
                    allocations += 1;
                    Ok(json!({}))
                }
            )
            .is_ok());
        assert_eq!(before, allocations);
    }
    #[test]
    fn t16_focus_only_fresh_existing_gui_queues_a_bounded_event_without_spawn_route() {
        let mut relay = Relay::default();
        queue_cli_focus(true, Duration::from_millis(2999), true, "s-1-2", &mut relay).unwrap();
        let page = relay.poll(0);
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].name, "cli-focus");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&page.events[0].payload).unwrap(),
            json!({"session_id":"s-1-2"})
        );
    }
    #[test]
    fn t16_focus_disconnected_stale_or_unknown_has_no_relay_side_effect() {
        for (connected, age, exists) in [
            (false, Duration::ZERO, true),
            (true, Duration::from_secs(3), true),
            (true, Duration::ZERO, false),
        ] {
            let mut relay = Relay::default();
            assert!(queue_cli_focus(connected, age, exists, "s-1-2", &mut relay).is_err());
            assert!(relay.poll(0).events.is_empty());
        }
    }
    #[test]
    fn t16_semantic_cli_rpc_shape_is_strict_bounded_and_additive() {
        for (name, args) in [
            ("cli_status", json!({})),
            ("cli_list", json!({})),
            ("cli_show", json!({"session_id":"s-1-2"})),
            ("cli_focus", json!({"session_id":"s-1-2"})),
            ("cli_stop", json!({"session_id":"s-1-2"})),
            (
                "cli_start",
                json!({"request_key":"a".repeat(64),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"literal"}}),
            ),
        ] {
            assert!(validate_command(name, &args).is_ok(), "{name}");
        }
        assert!(validate_command("cli_status", &json!({"token":"SECRET"})).is_err());
        assert!(
            validate_command("cli_start", &json!({"request_key":"SECRET","start":{}})).is_err()
        );
    }
}
impl StartRequests {
    fn run_cli(
        &mut self,
        request: &Request,
        start: impl FnOnce() -> Result<serde_json::Value, String>,
    ) -> Result<serde_json::Value, String> {
        let key = request
            .args
            .get("request_key")
            .and_then(serde_json::Value::as_str)
            .filter(|key| super::cli::valid_key(key))
            .ok_or("Invalid CLI arguments")?;
        // The colon namespace cannot collide with authenticated 64-hex wire client IDs.
        self.run(
            &format!("cli:{key}"),
            0,
            request.args["start"].clone(),
            start,
        )
    }
}
fn queue_cli_focus(
    connected: bool,
    age: Duration,
    exists: bool,
    id: &str,
    relay: &mut Relay,
) -> Result<(), String> {
    if super::session_id_from_link(&format!("yam://session/{id}")).is_none() || !exists {
        return Err("cli_unknown_session".into());
    }
    if !connected || age >= Duration::from_secs(3) {
        return Err("cli_gui_disconnected".into());
    }
    relay.push(
        "cli-focus",
        serde_json::json!({"session_id":id}).to_string(),
    );
    Ok(())
}

impl Client {
    fn encode_request(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<(u64, Vec<u8>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = Request {
            version: PROTOCOL_VERSION,
            token: self.descriptor.token.clone(),
            instance: self.descriptor.instance.clone(),
            client: self.identity.clone(),
            id,
            command: command.into(),
            args,
        };
        let bytes = serde_json::to_vec(&request).map_err(|_| "Cannot encode background request")?;
        decode_request(&bytes, &self.descriptor.token, &self.descriptor.instance)?;
        Ok((id, bytes))
    }
    fn decode_response(&self, reply: &[u8], id: u64) -> Result<Response, String> {
        let response: Response =
            serde_json::from_slice(reply).map_err(|_| "Invalid background response")?;
        if response.version != PROTOCOL_VERSION
            || response.instance != self.descriptor.instance
            || response.client != self.identity
            || response.id != id
        {
            return Err("Background response identity mismatch".into());
        }
        Ok(response)
    }
    pub(super) fn call_cli(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, super::cli::ErrorClass> {
        use super::cli::ErrorClass;
        let (id, bytes) = self
            .encode_request(command, args)
            .map_err(|_| ErrorClass::Arguments)?;
        let address = self
            .descriptor
            .validate()
            .map_err(|_| ErrorClass::Connection)?;
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(|_| ErrorClass::Connection)?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| ErrorClass::Connection)?;
        // Once a start write is attempted, any lost or unauthenticated reply is unknown. Never retry.
        let transport = if command == "cli_start" {
            ErrorClass::OutcomeUnknown
        } else {
            ErrorClass::Connection
        };
        write_frame(&mut stream, &bytes, MAX_REQUEST).map_err(|_| transport)?;
        let (limit, deadline) = if command == "cli_events" {
            (272 * 1024, Duration::from_secs(3))
        } else {
            (MAX_RESPONSE, Duration::from_secs(35))
        };
        let reply = read_frame_with_budget(&mut stream, limit, deadline).map_err(|_| transport)?;
        let value = self
            .decode_response(&reply, id)
            .map_err(|_| transport)?
            .result
            .map_err(|_| ErrorClass::Business)?;
        if command == "cli_start"
            && value.get("outcome").and_then(serde_json::Value::as_str) == Some("outcome_unknown")
        {
            return Err(ErrorClass::OutcomeUnknown);
        }
        Ok(value)
    }
}
pub(super) fn desktop_cli_focus(
    manager: &super::SessionManager,
    payload: &serde_json::Value,
    route: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if manager.background_owner {
        return Err("cli_desktop_only".into());
    }
    let object = payload.as_object().ok_or("cli_invalid_focus")?;
    let id = object
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("cli_invalid_focus")?;
    if object.len() != 1 || super::session_id_from_link(&format!("yam://session/{id}")).is_none() {
        return Err("cli_invalid_focus".into());
    }
    route(id)
}
#[cfg(test)]
mod cli_wire_tests {
    use super::super::cli::ErrorClass;
    use super::*;
    use serde_json::json;
    use std::{sync::Mutex, time::Instant};
    pub(super) fn peer(
        reply: Option<Result<serde_json::Value, String>>,
        wrong_identity: bool,
    ) -> (Client, JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let descriptor = Descriptor {
            version: PROTOCOL_VERSION,
            address: listener.local_addr().unwrap().to_string(),
            token: "a".repeat(64),
            instance: "b".repeat(64),
        };
        let instance = descriptor.instance.clone();
        let worker = thread::spawn(move || {
            let end = Instant::now() + Duration::from_millis(600);
            let mut count = 0;
            while Instant::now() < end {
                if let Ok((mut stream, _)) = listener.accept() {
                    count += 1;
                    let bytes =
                        read_frame_with_budget(&mut stream, MAX_REQUEST, Duration::from_secs(1))
                            .unwrap();
                    let request: Request = serde_json::from_slice(&bytes).unwrap();
                    if let Some(result) = reply.clone() {
                        let response = Response {
                            version: PROTOCOL_VERSION,
                            instance: if wrong_identity {
                                "c".repeat(64)
                            } else {
                                instance.clone()
                            },
                            client: request.client,
                            id: request.id,
                            result,
                        };
                        write_frame(
                            &mut stream,
                            &serde_json::to_vec(&response).unwrap(),
                            MAX_RESPONSE,
                        )
                        .unwrap();
                    }
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            count
        });
        (Client::new(descriptor).unwrap(), worker)
    }
    #[test]
    fn t16_wire_authenticated_business_error_is_fixed_and_distinct() {
        let (client, worker) = peer(Some(Err("SECRET arbitrary business text".into())), false);
        let result = client.call_cli("cli_show", json!({"session_id":"s-1-2"}));
        assert_eq!(result, Err(ErrorClass::Business));
        assert_eq!(worker.join().unwrap(), 1);
    }
    #[test]
    fn t16_wire_start_lost_reply_or_identity_failure_is_unknown_and_never_retries() {
        for (reply, wrong) in [(None, false), (Some(Ok(json!({}))), true)] {
            let (client, worker) = peer(reply, wrong);
            let result = client.call_cli("cli_start",json!({"request_key":"d".repeat(64),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}}));
            assert_eq!(result, Err(ErrorClass::OutcomeUnknown));
            assert_eq!(worker.join().unwrap(), 1);
        }
    }
    #[test]
    fn t16_wire_no_connection_is_not_an_unknown_started_operation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        drop(listener);
        let client = Client::new(Descriptor {
            version: PROTOCOL_VERSION,
            address,
            token: "a".repeat(64),
            instance: "b".repeat(64),
        })
        .unwrap();
        assert_eq!(client.call_cli("cli_start",json!({"request_key":"d".repeat(64),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}})),Err(ErrorClass::Connection));
    }
    #[test]
    fn closure_t01_lost_success_reply_replays_cached_receipt_without_second_allocation() {
        let root = std::env::temp_dir().join(format!(
            "yam-closure-start-{}",
            super::super::next_session_id()
        ));
        let starts = Arc::new(Mutex::new(StartRequests::default()));
        let count = Arc::new(AtomicU64::new(0));
        let allocations = count.clone();
        let server = Server::start(&root, move |request| {
            starts.lock().unwrap().run_cli(&request, || {
                allocations.fetch_add(1, Ordering::Relaxed);
                Ok(json!({"session_id":"s-1-2"}))
            })
        })
        .unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        let direct = Client::new(descriptor.clone()).unwrap();
        let args = json!({"request_key":format!("{}{}",direct.cli_context().unwrap(),"d".repeat(32)),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"owned fixture"}});
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut proxy = descriptor.clone();
        proxy.address = listener.local_addr().unwrap().to_string();
        let client = Client::new(proxy).unwrap();
        let worker = thread::spawn(move || {
            let end = Instant::now() + Duration::from_secs(3);
            let (mut incoming, _) = loop {
                match listener.accept() {
                    Ok(stream) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < end, "owned proxy timed out");
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) => panic!("owned proxy failed: {e}"),
                }
            };
            let bytes =
                read_frame_with_budget(&mut incoming, MAX_REQUEST, Duration::from_secs(2)).unwrap();
            let mut outgoing = TcpStream::connect_timeout(
                &descriptor.address.parse().unwrap(),
                Duration::from_secs(2),
            )
            .unwrap();
            outgoing
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            write_frame(&mut outgoing, &bytes, MAX_REQUEST).unwrap();
            let reply = read_frame_with_budget(&mut outgoing, MAX_RESPONSE, Duration::from_secs(2))
                .unwrap();
            let reply: Response = serde_json::from_slice(&reply).unwrap();
            assert_eq!(reply.result.unwrap(), json!({"session_id":"s-1-2"}));
            // The owner completed; losing only this reply must not start another process.
        });
        assert_eq!(
            client.call_cli("cli_start", args.clone()),
            Err(ErrorClass::OutcomeUnknown)
        );
        worker.join().unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 1);
        let retry = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        assert_ne!(retry.identity, client.identity);
        assert_eq!(
            retry.call_cli("cli_start", args).unwrap(),
            json!({"session_id":"s-1-2"})
        );
        assert_eq!(count.load(Ordering::Relaxed), 1);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn t16_wire_two_actual_fresh_clients_share_one_owner_receipt() {
        let root = std::env::temp_dir().join(format!(
            "yam-t16-wire-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let starts = Arc::new(Mutex::new(StartRequests::default()));
        let count = Arc::new(AtomicU64::new(0));
        let allocations = count.clone();
        let server = Server::start(&root, move |request| {
            starts.lock().unwrap().run_cli(&request, || {
                allocations.fetch_add(1, Ordering::Relaxed);
                Ok(json!({"session_id":"s-1-2"}))
            })
        })
        .unwrap();
        let first = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let second = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        assert_ne!(first.identity, second.identity);
        let args = json!({"request_key":format!("{}{}",first.cli_context().unwrap(),"d".repeat(32)),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}});
        let one = first.call_cli("cli_start", args.clone()).unwrap();
        let two = second.call_cli("cli_start", args).unwrap();
        assert_eq!(one, two);
        assert_eq!(count.load(Ordering::Relaxed), 1);
        drop(server);
        for entry in std::fs::read_dir(&root).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn t16_desktop_focus_handoff_updates_only_local_pending_selection_and_owner_cannot_route() {
        let manager = super::super::SessionManager::default();
        desktop_cli_focus(&manager, &json!({"session_id":"s-1-2"}), |id| {
            *manager.notification_selection.lock().unwrap() = Some(id.into());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            *manager.notification_selection.lock().unwrap(),
            Some("s-1-2".into())
        );
        let owner = super::super::SessionManager {
            background_owner: true,
            ..Default::default()
        };
        let called = std::cell::Cell::new(false);
        assert!(
            desktop_cli_focus(&owner, &json!({"session_id":"s-1-2"}), |_| {
                called.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!called.get());
    }
}

fn cli_read(
    manager: &super::SessionManager,
    command: &str,
    id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let history = manager
        .history
        .lock()
        .map_err(|_| "cli_unavailable")?
        .as_ref()
        .cloned()
        .ok_or("cli_unavailable")?;
    if command == "cli_show" {
        return super::cli::session_metadata(&history.get(id.ok_or("cli_unknown_session")?)?)
            .map_err(|_| "cli_unavailable".into());
    }
    let records = history.lock_records()?;
    match command {
        "cli_status" => {
            let context = manager.cli_namespace.get().ok_or("cli_unavailable")?;
            Ok(
                serde_json::json!({"status":"ready","total_sessions":records.len(),"active_sessions":records.iter().filter(|r| matches!(r.status.as_str(),"starting"|"running")).count(),"start_key_context":context}),
            )
        }
        "cli_list" => {
            let items = records
                .iter()
                .rev()
                .take(100)
                .map(super::cli::session_metadata)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "cli_unavailable")?;
            Ok(
                serde_json::json!({"sessions":items,"total":records.len(),"truncated":records.len()>100}),
            )
        }
        _ => Err("cli_invalid_read".into()),
    }
}
#[cfg(test)]
mod cli_read_tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    #[test]
    fn t16_actual_owner_reads_are_bounded_fixed_and_do_not_change_sessions_leases_or_notification_context(
    ) {
        let records: Vec<super::super::SessionRecord>=(0..101).map(|i| serde_json::from_value(json!({"summary":{"session_id":format!("s-1-{i}"),"cwd":"/fixture","status":"running","command":"SECRET command","launch":{"adapter":"codex","mode":"task","extra_args":"SECRET args","prompt":"SECRET prompt"}},"status":"running","exit_code":null,"reason":"SECRET reason","started_at":i,"ended_at":null})).unwrap()).collect();
        let original = serde_json::to_value(&records).unwrap();
        let history = Arc::new(super::super::HistoryStore {
            root: std::env::temp_dir().join(format!(
                "yam-t16-read-{}-{}",
                std::process::id(),
                super::super::next_session_id()
            )),
            records: Mutex::new(records),
            revision: AtomicU64::new(0),
            instance: "fixture".into(),
            pending_start_failures: Default::default(),
            archive_pending: AtomicBool::new(false),
        });
        let manager = super::super::SessionManager::default();
        manager.cli_namespace.set("d".repeat(32)).unwrap();
        *manager.history.lock().unwrap() = Some(history.clone());
        let status = cli_read(&manager, "cli_status", None).unwrap();
        assert_eq!(status["total_sessions"], 101);
        let list = cli_read(&manager, "cli_list", None).unwrap();
        assert_eq!(list["sessions"].as_array().unwrap().len(), 100);
        assert_eq!(list["total"], 101);
        assert_eq!(list["truncated"], true);
        assert!(!list.to_string().contains("SECRET"));
        let show = cli_read(&manager, "cli_show", Some("s-1-2")).unwrap();
        assert_eq!(show["session_id"], "s-1-2");
        assert!(!show.to_string().contains("SECRET"));
        assert!(cli_read(&manager, "cli_show", Some("s-unknown")).is_err());
        assert_eq!(
            serde_json::to_value(&*history.records.lock().unwrap()).unwrap(),
            original
        );
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(manager.input_leases.lock().unwrap().owners.is_empty());
        assert!(!manager.desktop_connected.load(Ordering::Acquire));
        assert!(manager.notification_selection.lock().unwrap().is_none());
        assert!(!history.root.exists());
    }
}

impl Client {
    pub(super) fn cli_context(&self) -> Result<String, super::cli::ErrorClass> {
        let reply = self.call_cli("ping", serde_json::json!({}))?;
        let context = reply
            .get("start_key_context")
            .and_then(serde_json::Value::as_str)
            .filter(|context| context.len() == 32 && context.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(super::cli::ErrorClass::Compatibility)?;
        Ok(context.into())
    }
}
fn cli_focus_owner(manager: &super::SessionManager, id: &str) -> Result<serde_json::Value, String> {
    let history = manager
        .history
        .lock()
        .map_err(|_| "cli_unavailable")?
        .as_ref()
        .cloned()
        .ok_or("cli_unavailable")?;
    let exists = history.get(id).is_ok();
    let focus = manager
        .desktop_focus
        .lock()
        .map_err(|_| "cli_unavailable")?;
    queue_cli_focus(
        manager.desktop_connected.load(Ordering::Acquire),
        focus.0.elapsed(),
        exists,
        id,
        &mut *manager.relay.lock().map_err(|_| "cli_unavailable")?,
    )?;
    Ok(serde_json::json!({"session_id":id,"status":"queued"}))
}
#[cfg(test)]
mod cli_namespace_tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{Barrier, Mutex},
        time::Instant,
    };
    #[test]
    fn t16_d11_actual_server_namespace_and_concurrent_clients_allocate_once() {
        let root = std::env::temp_dir().join(format!(
            "yam-t16-namespace-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let starts = Arc::new(Mutex::new(StartRequests::default()));
        let count = Arc::new(AtomicU64::new(0));
        let allocations = count.clone();
        let server = Server::start(&root, move |request| {
            starts.lock().unwrap().run_cli(&request, || {
                allocations.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(30));
                Ok(json!({"session_id":"s-1-2"}))
            })
        })
        .unwrap();
        let first = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let second = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let context = first.cli_context().unwrap();
        assert_eq!(context.len(), 32);
        assert_eq!(second.cli_context().unwrap(), context);
        let args = json!({"request_key":format!("{context}{}","d".repeat(32)),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}});
        let barrier = Arc::new(Barrier::new(3));
        let one_barrier = barrier.clone();
        let one_args = args.clone();
        let one = thread::spawn(move || {
            one_barrier.wait();
            first.call_cli("cli_start", one_args)
        });
        let two_barrier = barrier.clone();
        let two = thread::spawn(move || {
            two_barrier.wait();
            second.call_cli("cli_start", args)
        });
        barrier.wait();
        assert_eq!(one.join().unwrap().unwrap(), two.join().unwrap().unwrap());
        assert_eq!(count.load(Ordering::Relaxed), 1);
        drop(server);
        for entry in std::fs::read_dir(&root).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn t16_d11_actual_lowlevel_start_cannot_bypass_context_or_allocate_on_replacement_key() {
        let root = std::env::temp_dir().join(format!(
            "yam-t16-bypass-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let count = Arc::new(AtomicU64::new(0));
        let allocations = count.clone();
        let server = Server::start(&root, move |_| {
            allocations.fetch_add(1, Ordering::Relaxed);
            Ok(json!({"session_id":"s-1-2"}))
        })
        .unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let result=client.call_cli("cli_start",json!({"request_key":"0".repeat(64),"start":{"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}}));
        assert_eq!(count.load(Ordering::Relaxed), 0);
        assert_eq!(result, Err(super::super::cli::ErrorClass::OutcomeUnknown));
        drop(server);
        for entry in std::fs::read_dir(&root).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
    fn manager() -> super::super::SessionManager {
        let manager = super::super::SessionManager::default();
        *manager.history.lock().unwrap() = Some(Arc::new(super::super::HistoryStore {
            root: std::env::temp_dir().join(format!(
                "yam-t16-context-{}-{}",
                std::process::id(),
                super::super::next_session_id()
            )),
            records: Mutex::new(Vec::new()),
            revision: AtomicU64::new(0),
            instance: "SECRET-native-identity".into(),
            pending_start_failures: Default::default(),
            archive_pending: AtomicBool::new(false),
        }));
        manager
    }
    #[test]
    fn t16_d11_status_context_is_preinitialized_and_safe_not_generated_by_read() {
        let manager = manager();
        assert!(cli_read(&manager, "cli_status", None).is_err());
        assert!(manager.cli_namespace.get().is_none());
        let context = "d".repeat(32);
        manager.cli_namespace.set(context.clone()).unwrap();
        let dto = cli_read(&manager, "cli_status", None).unwrap();
        assert_eq!(dto["start_key_context"], context);
        assert!(!dto.to_string().contains("SECRET"));
        assert_eq!(manager.cli_namespace.get(), Some(&context));
        assert!(manager.input_leases.lock().unwrap().owners.is_empty());
        assert!(manager.notification_selection.lock().unwrap().is_none());
    }
    #[test]
    fn t16_actual_owner_focus_dispatch_then_desktop_local_selection_has_no_spawn_or_input_lease_effect(
    ) {
        let manager = manager();
        let record:super::super::SessionRecord=serde_json::from_value(json!({"summary":{"session_id":"s-1-2","cwd":"/fixture","status":"running","command":null},"status":"running","exit_code":null,"reason":null,"started_at":1,"ended_at":null})).unwrap();
        manager
            .history
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .records
            .lock()
            .unwrap()
            .push(record);
        manager.desktop_connected.store(true, Ordering::Release);
        *manager.desktop_focus.lock().unwrap() = (Instant::now(), true);
        let dto = cli_focus_owner(&manager, "s-1-2").unwrap();
        assert_eq!(dto["status"], "queued");
        let page = manager.relay.lock().unwrap().poll(0);
        assert_eq!(page.events.len(), 1);
        let payload = serde_json::from_str(&page.events[0].payload).unwrap();
        let desktop = super::super::SessionManager::default();
        desktop_cli_focus(&desktop, &payload, |id| {
            *desktop.notification_selection.lock().unwrap() = Some(id.into());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            *desktop.notification_selection.lock().unwrap(),
            Some("s-1-2".into())
        );
        assert!(manager.notification_selection.lock().unwrap().is_none());
        assert!(manager.input_leases.lock().unwrap().owners.is_empty());
        assert!(manager.sessions.lock().unwrap().is_empty());
        manager.desktop_connected.store(false, Ordering::Release);
        assert!(cli_focus_owner(&manager, "s-1-2").is_err());
        assert!(cli_focus_owner(&manager, "s-unknown").is_err());
        assert_eq!(manager.relay.lock().unwrap().poll(0).events.len(), 1);
    }
    #[test]
    fn t16_d11_authenticated_old_owner_without_context_is_compatibility_not_a_new_start() {
        let (client, peer) = super::cli_wire_tests::peer(Some(Ok(json!({"ready":true}))), false);
        assert_eq!(
            client.cli_context(),
            Err(super::super::cli::ErrorClass::Compatibility)
        );
        assert_eq!(peer.join().unwrap(), 1);
    }

    #[test]
    fn t16_actual_sender_replacement_key_is_unknown_with_original_key_and_zero_start_sends() {
        let first_root = std::env::temp_dir().join(format!(
            "yam-t16-first-owner-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let second_root = std::env::temp_dir().join(format!(
            "yam-t16-next-owner-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        let first_server = Server::start(&first_root, |_| Ok(json!({}))).unwrap();
        let first = Client::new(Descriptor::read(&first_root).unwrap()).unwrap();
        let old_key = format!("{}{}", first.cli_context().unwrap(), "c".repeat(32));
        drop(first_server);
        let count = Arc::new(AtomicU64::new(0));
        let sends = count.clone();
        let next_server = Server::start(&second_root, move |_| {
            sends.fetch_add(1, Ordering::Relaxed);
            Ok(json!({"session_id":"s-1-2"}))
        })
        .unwrap();
        let next = Client::new(Descriptor::read(&second_root).unwrap()).unwrap();
        let mut key = Some(old_key.clone());
        let result = super::super::cli::start_on_client(
            &next,
            json!({"cwd":"/fixture","adapter":"codex","mode":"task","prompt":"SECRET"}),
            &mut key,
        );
        assert_eq!(result, Err(super::super::cli::ErrorClass::OutcomeUnknown));
        assert_eq!(key, Some(old_key));
        assert_eq!(count.load(Ordering::Relaxed), 0);
        drop(next_server);
        for root in [first_root, second_root] {
            for entry in std::fs::read_dir(&root).unwrap() {
                std::fs::remove_file(entry.unwrap().path()).unwrap();
            }
            std::fs::remove_dir(root).unwrap();
        }
    }
}

#[cfg(test)]
mod cli_event_tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    #[test]
    fn t17_events_route_is_strict_and_read_only_without_focus_or_lease_heartbeat() {
        assert!(validate_command("cli_events", &json!({"cursor":0})).is_ok());
        assert!(validate_command("cli_events", &json!({"cursor":0,"foreground":true})).is_err());
        assert!(validate_command("cli_events", &json!({"cursor":-1})).is_err());
        let manager = super::super::SessionManager::default();
        manager.relay.lock().unwrap().push(
            "session-state",
            json!({"session_id":"s-1-2","status":"running","reason":"SECRET"}).to_string(),
        );
        let before = *manager.desktop_focus.lock().unwrap();
        let page = cli_event_page(&manager, 0).unwrap();
        assert_eq!(page["events"][0]["type"], "lifecycle");
        assert!(!page.to_string().contains("SECRET"));
        assert!(!manager.desktop_connected.load(Ordering::Acquire));
        assert_eq!(*manager.desktop_focus.lock().unwrap(), before);
        assert!(manager.input_leases.lock().unwrap().owners.is_empty());
    }
    #[test]
    fn t17_projection_excludes_raw_terminal_errors_native_ids_and_unknown_fields() {
        let mut relay = Relay::default();
        for name in [
            "session-output",
            "session-error",
            "session-notification-click",
            "agent-state",
        ] {
            relay.push(
                name,
                json!({"session_id":"s-1-2","data":"SECRET_TOKEN_NATIVE_ID"}).to_string(),
            );
        }
        relay.push(
            "session-phase",
            json!({"session_id":"s-1-2","data":"working","token":"SECRET"}).to_string(),
        );
        relay.push(
            "session-state",
            json!({"session_id":"s-1-2","status":"SECRET"}).to_string(),
        );
        let manager = super::super::SessionManager::default();
        *manager.relay.lock().unwrap() = relay;
        let page = cli_event_page(&manager, 0).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        assert_eq!(
            page["events"][0],
            json!({"sequence":5,"type":"phase","session_id":"s-1-2","phase":"working"})
        );
        assert_eq!(page["cursor"], 6);
    }
    #[test]
    fn t17_relay_overflow_explicit_gap_and_bounded_original_sequence_pages() {
        let manager = super::super::SessionManager::default();
        for _ in 0..1200 {
            manager.relay.lock().unwrap().push(
                "session-state",
                json!({"session_id":"s-1-2","status":"running"}).to_string(),
            );
        }
        let page = cli_event_page(&manager, 0).unwrap();
        assert_eq!(page["gap"], true);
        assert_eq!(page["gap_sequence"], 176);
        assert_eq!(page["events"].as_array().unwrap().len(), 128);
        assert_eq!(page["events"][0]["sequence"], 177);
        assert_eq!(page["cursor"], 304);
        assert!(cli_event_page(&manager, 1201).is_err());
        let next = cli_event_page(&manager, 304).unwrap();
        assert_eq!(next["events"][0]["sequence"], 305);
    }
    #[test]
    fn t17_actual_owner_observation_preserves_gui_payload_and_projects_hot_agent_counts() {
        let manager = super::super::SessionManager::default();
        let mut agent = super::super::agent_events::AgentState {
            phase: "working".into(),
            integration: "connected".into(),
            revision: 7,
            agent_session_id: Some("SECRET_NATIVE".into()),
            turn_id: Some("SECRET_TURN".into()),
            permission_keys: vec!["SECRET_PERMISSION".into()],
            ..Default::default()
        };
        agent.inbox.push(super::super::agent_events::AgentReceipt {
            permission_key: None,
            id: "SECRET_RECEIPT".into(),
            revision: 1,
            turn_id: "SECRET_TURN".into(),
            kind: "turn".into(),
            delivery: "failed".into(),
            read: false,
            error: Some("SECRET_ERROR".into()),
        });
        let mut record:super::super::SessionRecord=serde_json::from_value(json!({"summary":{"session_id":"s-1-2","cwd":"/fixture","status":"running","command":"SECRET_PROMPT","launch":null},"status":"running","exit_code":null,"reason":null,"started_at":0,"ended_at":null})).unwrap();
        record.agent = agent;
        let store = Arc::new(super::super::HistoryStore {
            root: std::env::temp_dir().join(format!("yam-t17-hot-{}", std::process::id())),
            records: Mutex::new(vec![record]),
            revision: AtomicU64::new(0),
            instance: "fixture".into(),
            pending_start_failures: Default::default(),
            archive_pending: AtomicBool::new(false),
        });
        *manager.history.lock().unwrap() = Some(store.clone());
        observe_owner_event(
            &manager,
            "agent-state",
            r#"{"session_id":"s-1-2","data":"updated"}"#,
        )
        .unwrap();
        let relay = manager.relay.lock().unwrap();
        assert_eq!(
            relay.events[0].payload,
            r#"{"session_id":"s-1-2","data":"updated"}"#
        );
        drop(relay);
        let page = cli_event_page(&manager, 0).unwrap();
        assert_eq!(page["events"][0]["type"], "agent_snapshot");
        assert_eq!(page["events"][0]["revision"], 7);
        assert_eq!(page["events"][0]["receipts"]["failed"], 1);
        assert!(!page.to_string().contains("SECRET"));
        assert!(store.records.try_lock().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn t17_cancel_child_fixture() {
        let Some(root) = std::env::var_os("YAM_T17_FIXTURE_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let _ = super::super::cli::stream_events_for_client(
            &client,
            &root,
            &root.join("cursor.json"),
            &mut std::io::stdout().lock(),
        );
    }
    #[cfg(unix)]
    #[test]
    fn t17_default_ctrl_c_stops_actual_stream_owned_child_without_stopping_mock_owner() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let root = fixture_root();
        let calls = Arc::new(AtomicU64::new(0));
        let counter = calls.clone();
        let server=Server::start(&root,move|r|{assert_eq!(r.command,"cli_events");let seq=counter.fetch_add(1,Ordering::Relaxed)+1;Ok(json!({"cursor":seq,"gap":false,"gap_sequence":0,"events":[{"sequence":seq,"type":"phase","session_id":"s-1-2","phase":"working"}]}))}).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("background::cli_event_tests::t17_cancel_child_fixture")
            .arg("--nocapture")
            .env("YAM_T17_FIXTURE_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while calls.load(Ordering::Relaxed) == 0
            && child.try_wait().unwrap().is_none()
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        let reached = calls.load(Ordering::Relaxed) > 0;
        let alive = child.try_wait().unwrap().is_none();
        if alive {
            assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
        }
        let status = child.wait().unwrap();
        let owner = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let owner_alive = owner.call("ping", json!({})).is_ok();
        drop(server);
        cleanup(&root);
        assert!(
            reached,
            "actual stream fixture never sent its event request"
        );
        assert_eq!(status.signal(), Some(libc::SIGINT));
        assert!(owner_alive);
    }

    #[test]
    fn t17_actual_event_wire_refuses_over_page_budget_before_large_json_decode() {
        let root = fixture_root();
        let server =
            Server::start(&root, move |_| Ok(json!({"oversize":"X".repeat(280*1024)}))).unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let refused = matches!(
            client.call_cli("cli_events", json!({"cursor":0})),
            Err(super::super::cli::ErrorClass::Connection)
        );
        drop(server);
        cleanup(&root);
        assert!(
            refused,
            "events wire must reject an oversized response before JSON decoding"
        );
    }

    #[test]
    fn t17_same_owner_reconnect_success_keeps_original_sequence_and_client_identity() {
        let root = fixture_root();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let descriptor = Descriptor {
            version: PROTOCOL_VERSION,
            address: listener.local_addr().unwrap().to_string(),
            token: "a".repeat(64),
            instance: "b".repeat(64),
        };
        descriptor.publish(&root).unwrap();
        let wire = descriptor.clone();
        let worker = thread::spawn(move || {
            let mut identity = None;
            for attempt in 0..3 {
                let (mut connection, _) = listener.accept().unwrap();
                let request = decode_request(
                    &read_frame(&mut connection, MAX_REQUEST).unwrap(),
                    &wire.token,
                    &wire.instance,
                )
                .unwrap();
                assert_eq!(request.command, "cli_events");
                if let Some(old) = identity.as_ref() {
                    assert_eq!(old, &request.client);
                }
                identity = Some(request.client.clone());
                if attempt == 0 {
                    continue;
                }
                assert_eq!(request.args["cursor"], if attempt == 1 { 0 } else { 1 });
                let result = if attempt == 1 {
                    Ok(
                        json!({"cursor":1,"gap":false,"gap_sequence":0,"events":[{"sequence":1,"type":"phase","session_id":"s-1-2","phase":"working"}]}),
                    )
                } else {
                    Err("SECRET_STOP".into())
                };
                let response = Response {
                    version: PROTOCOL_VERSION,
                    instance: wire.instance.clone(),
                    client: request.client,
                    id: request.id,
                    result,
                };
                write_frame(
                    &mut connection,
                    &serde_json::to_vec(&response).unwrap(),
                    MAX_RESPONSE,
                )
                .unwrap();
            }
        });
        let client = Client::new(descriptor).unwrap();
        let mut output = vec![];
        assert_eq!(
            super::super::cli::stream_events_for_client(
                &client,
                &root,
                &root.join("cursor.json"),
                &mut output
            ),
            Err(super::super::cli::ErrorClass::Business)
        );
        worker.join().unwrap();
        let lines: Vec<serde_json::Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["sequence"], 1);
        cleanup(&root);
    }
    #[test]
    fn t17_replacement_after_written_page_retains_checkpoint_and_never_connects_new_identity() {
        let root = fixture_root();
        let path = root.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let count = calls.clone();
        let server=Server::start(&root,move|request|{assert_eq!(request.command,"cli_events");if count.fetch_add(1,Ordering::Relaxed)==0{Ok(json!({"cursor":1,"gap":false,"gap_sequence":0,"events":[{"sequence":1,"type":"phase","session_id":"s-1-2","phase":"working"}]}))}else{let mut replacement=Descriptor::read(&path).unwrap();replacement.instance="e".repeat(64);replacement.publish(&path).unwrap();Ok(json!({"too_large":"X".repeat(280*1024)}))}}).unwrap();
        let descriptor = Descriptor::read(&root).unwrap();
        let original = descriptor.instance.clone();
        let client = Client::new(descriptor).unwrap();
        let mut output = vec![];
        assert_eq!(
            super::super::cli::stream_events_for_client(
                &client,
                &root,
                &root.join("cursor.json"),
                &mut output
            ),
            Err(super::super::cli::ErrorClass::Connection)
        );
        let lines: Vec<serde_json::Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], json!({"type":"instance_change"}));
        let checkpoint: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("cursor.json")).unwrap()).unwrap();
        assert_eq!(checkpoint["instance"], original);
        assert_eq!(checkpoint["sequence"], 1);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        drop(server);
        cleanup(&root);
    }

    fn hot_history(
        agent: super::super::agent_events::AgentState,
    ) -> Arc<super::super::HistoryStore> {
        let mut record:super::super::SessionRecord=serde_json::from_value(json!({"summary":{"session_id":"s-1-2","cwd":"/fixture","status":"running","command":"SECRET","launch":null},"status":"running","exit_code":null,"reason":null,"started_at":0,"ended_at":null})).unwrap();
        record.agent = agent;
        Arc::new(super::super::HistoryStore {
            root: std::env::temp_dir().join(format!("yam-t17-review-{}", std::process::id())),
            records: Mutex::new(vec![record]),
            revision: AtomicU64::new(0),
            instance: "fixture".into(),
            pending_start_failures: Default::default(),
            archive_pending: AtomicBool::new(false),
        })
    }
    #[test]
    fn t17_review_manager_history_contention_requires_cli_only_gap_without_global_gui_gap() {
        let manager = super::super::SessionManager::default();
        let history = hot_history(Default::default());
        *manager.history.lock().unwrap() = Some(history);
        let held = manager.history.lock().unwrap();
        observe_owner_event(
            &manager,
            "agent-state",
            r#"{"session_id":"s-1-2","data":"updated"}"#,
        )
        .unwrap();
        let page = cli_event_page(&manager, 0).unwrap();
        drop(held);
        assert!(
            page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line["type"] == "gap" && line["snapshot_required"] == true),
            "a lost final observation must be explicit to the CLI"
        );
        assert!(!manager.relay.lock().unwrap().poll(0).gap);
        assert_eq!(
            manager.relay.lock().unwrap().events[0].payload,
            r#"{"session_id":"s-1-2","data":"updated"}"#
        );
    }
    #[test]
    fn t17_review_records_contention_requires_cli_only_gap_even_without_a_later_event() {
        let manager = super::super::SessionManager::default();
        let history = hot_history(Default::default());
        *manager.history.lock().unwrap() = Some(history.clone());
        let held = history.records.lock().unwrap();
        observe_owner_event(
            &manager,
            "agent-state",
            r#"{"session_id":"s-1-2","data":"updated"}"#,
        )
        .unwrap();
        let page = cli_event_page(&manager, 0).unwrap();
        drop(held);
        assert!(
            page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line["type"] == "gap" && line["snapshot_required"] == true),
            "busy records must not silently lose the final receipt state"
        );
        assert!(!manager.relay.lock().unwrap().poll(0).gap);
    }
    #[test]
    fn t17_review_actual_agent_apply_terminal_permission_attention_and_interrupt_phases_survive_projection(
    ) {
        use super::super::agent_events::{AgentEvent, AgentState};
        for (kind, expected) in [
            ("TurnComplete", "response_finished"),
            ("PermissionRequest", "needs_permission"),
            ("ResponseReady", "needs_attention"),
            ("Interrupt", "interrupted"),
        ] {
            let mut agent = AgentState {
                generation: "fixture-generation".into(),
                integration: "connecting".into(),
                ..Default::default()
            };
            let event = |kind: &str, turn: Option<&str>| AgentEvent {
                kind: kind.into(),
                agent_session_id: "SECRET_NATIVE".into(),
                turn_id: turn.map(str::to_string),
                permission_key: (kind == "PermissionRequest").then(|| "SECRET_PERMISSION".into()),
                source: None,
            };
            agent.apply(&event("SessionStart", None)).unwrap();
            agent
                .apply(&event("UserPromptSubmit", Some("SECRET_TURN")))
                .unwrap();
            agent.apply(&event(kind, Some("SECRET_TURN"))).unwrap();
            assert_eq!(agent.phase, expected);
            let manager = super::super::SessionManager::default();
            *manager.history.lock().unwrap() = Some(hot_history(agent));
            observe_owner_event(
                &manager,
                "agent-state",
                r#"{"session_id":"s-1-2","data":"updated"}"#,
            )
            .unwrap();
            let page = cli_event_page(&manager, 0).unwrap();
            assert_eq!(
                page["events"][0]["phase"], expected,
                "actual {kind} phase must not become unknown"
            );
            assert!(!page.to_string().contains("SECRET"));
        }
    }
    fn phase_agent(kind: &str) -> super::super::agent_events::AgentState {
        use super::super::agent_events::{AgentEvent, AgentState};
        let mut agent = AgentState {
            generation: "SECRET_GENERATION".into(),
            integration: "connecting".into(),
            ..Default::default()
        };
        let event = |kind: &str, turn: Option<&str>| AgentEvent {
            kind: kind.into(),
            agent_session_id: "SECRET_NATIVE".into(),
            turn_id: turn.map(str::to_string),
            permission_key: (kind == "PermissionRequest").then(|| "SECRET_PERMISSION".into()),
            source: None,
        };
        agent.apply(&event("SessionStart", None)).unwrap();
        agent
            .apply(&event("UserPromptSubmit", Some("SECRET_TURN")))
            .unwrap();
        agent.apply(&event(kind, Some("SECRET_TURN"))).unwrap();
        agent
    }

    fn assert_query_snapshot_phase(agent: super::super::agent_events::AgentState, expected: &str) {
        let history = hot_history(agent);
        {
            let mut records = history.records.lock().unwrap();
            records[0].summary.launch = Some(super::super::AgentLaunch {
                omp: None,
                claude_context: None,
                codex: None,
                provider: None,
                env_refs: Default::default(),
                adapter: "codex".into(),
                mode: "task".into(),
                prompt: Some("SECRET_PROMPT".into()),
                extra_args: "SECRET_ARGV".into(),
            });
            records[0].reason = Some("SECRET_REASON".into());
            for receipt in &mut records[0].agent.inbox {
                receipt.error = Some("SECRET_ERROR".into());
            }
        }
        let original = serde_json::to_value(&*history.records.lock().unwrap()).unwrap();
        let revision = history.revision.load(Ordering::Acquire);
        let manager = super::super::SessionManager::default();
        *manager.history.lock().unwrap() = Some(history.clone());
        manager.desktop_connected.store(true, Ordering::Release);
        *manager.notification_selection.lock().unwrap() = Some("s-9-9".into());
        manager
            .input_leases
            .lock()
            .unwrap()
            .claim("s-1-2", "fixture-client", 123)
            .unwrap();
        let leases = manager.input_leases.lock().unwrap().owners.clone();
        let list = cli_read(&manager, "cli_list", None).unwrap();
        let show = cli_read(&manager, "cli_show", Some("s-1-2")).unwrap();
        for dto in [&list["sessions"][0], &show] {
            let mut keys: Vec<_> = dto
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                [
                    "adapter",
                    "cwd",
                    "mode",
                    "phase",
                    "receipts",
                    "session_id",
                    "status"
                ]
            );
            assert_eq!(dto["receipts"].as_object().unwrap().len(), 3);
            assert!(!dto.to_string().contains("SECRET"));
        }
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert_eq!(manager.input_leases.lock().unwrap().owners, leases);
        assert!(manager.desktop_connected.load(Ordering::Acquire));
        assert_eq!(
            manager.notification_selection.lock().unwrap().as_deref(),
            Some("s-9-9")
        );
        observe_owner_event(
            &manager,
            "agent-state",
            r#"{"session_id":"s-1-2","native":"SECRET_RAW"}"#,
        )
        .unwrap();
        let page = cli_event_page(&manager, 0).unwrap();
        assert!(!page.to_string().contains("SECRET"));
        assert!(valid_cli_event_line(&page["events"][0]));
        assert_eq!(
            serde_json::to_value(&*history.records.lock().unwrap()).unwrap(),
            original
        );
        assert_eq!(history.revision.load(Ordering::Acquire), revision);
        assert_eq!(
            (
                &list["sessions"][0]["phase"],
                &show["phase"],
                &page["events"][0]["phase"]
            ),
            (&json!(expected), &json!(expected), &json!(expected)),
            "list/show and event snapshot must retain the same Agent phase"
        );
    }

    #[test]
    fn t16_phase_response_finished_actual_apply_list_show_snapshot() {
        let agent = phase_agent("TurnComplete");
        assert_eq!(agent.phase, "response_finished");
        assert_query_snapshot_phase(agent, "response_finished");
    }
    #[test]
    fn t16_phase_needs_permission_actual_apply_list_show_snapshot() {
        let agent = phase_agent("PermissionRequest");
        assert_eq!(agent.phase, "needs_permission");
        assert_query_snapshot_phase(agent, "needs_permission");
    }
    #[test]
    fn t16_phase_needs_attention_actual_apply_list_show_snapshot() {
        let agent = phase_agent("ResponseReady");
        assert_eq!(agent.phase, "needs_attention");
        assert_query_snapshot_phase(agent, "needs_attention");
    }
    #[test]
    fn t16_phase_interrupted_actual_apply_list_show_snapshot() {
        let agent = phase_agent("Interrupt");
        assert_eq!(agent.phase, "interrupted");
        assert_query_snapshot_phase(agent, "interrupted");
    }
    #[test]
    fn t16_phase_failed_actual_apply_list_show_snapshot() {
        let agent = phase_agent("TurnFailed");
        assert_eq!(agent.phase, "failed");
        assert_query_snapshot_phase(agent, "failed");
    }
    #[test]
    fn t16_phase_existing_idle_working_waiting_preserve_readonly_dto() {
        for phase in ["idle", "working", "waiting"] {
            let agent = super::super::agent_events::AgentState {
                phase: phase.into(),
                ..Default::default()
            };
            assert_query_snapshot_phase(agent, phase);
        }
    }
    #[test]
    fn t16_phase_unknown_secret_and_empty_are_redacted_without_state_mutation() {
        for phase in ["SECRET_UNKNOWN", ""] {
            let agent = super::super::agent_events::AgentState {
                phase: phase.into(),
                ..Default::default()
            };
            assert_query_snapshot_phase(agent, "unknown");
        }
    }

    fn fixture_root() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "yam-t17-stream-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&p).unwrap();
        p
    }
    fn cleanup(root: &Path) {
        for entry in std::fs::read_dir(root).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn t17_actual_authenticated_event_wire_checkpoint_then_business_error_stops_once() {
        let root = fixture_root();
        let manager = Arc::new(super::super::SessionManager::default());
        manager.relay.lock().unwrap().push(
            "session-state",
            json!({"session_id":"s-1-2","status":"running"}).to_string(),
        );
        let owner = manager.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let counter = calls.clone();
        let server = Server::start(&root, move |r| {
            assert_eq!(r.command, "cli_events");
            if counter.fetch_add(1, Ordering::Relaxed) == 0 {
                cli_event_page(&owner, r.args["cursor"].as_u64().unwrap())
            } else {
                Err("SECRET_REFUSAL".into())
            }
        })
        .unwrap();
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let mut output = vec![];
        assert_eq!(
            super::super::cli::stream_events_for_client(
                &client,
                &root,
                &root.join("cursor.json"),
                &mut output
            ),
            Err(super::super::cli::ErrorClass::Business)
        );
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        let checkpoint: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("cursor.json")).unwrap()).unwrap();
        assert_eq!(checkpoint["sequence"], 1);
        assert_eq!(String::from_utf8(output).unwrap().lines().count(), 1);
        assert!(!manager.desktop_connected.load(Ordering::Acquire));
        drop(server);
        cleanup(&root);
    }
    #[test]
    fn t17_replacement_cursor_emits_explicit_stop_without_request_or_checkpoint_change() {
        let root = fixture_root();
        let calls = Arc::new(AtomicU64::new(0));
        let count = calls.clone();
        let server = Server::start(&root, move |_| {
            count.fetch_add(1, Ordering::Relaxed);
            Ok(json!({}))
        })
        .unwrap();
        let cursor = root.join("cursor.json");
        let bytes =
            serde_json::to_vec(&json!({"version":1,"instance":"a".repeat(64),"sequence":9}))
                .unwrap();
        let mut file = private_file(&cursor, true).unwrap();
        file.write_all(&bytes).unwrap();
        drop(file);
        let client = Client::new(Descriptor::read(&root).unwrap()).unwrap();
        let mut output = vec![];
        assert_eq!(
            super::super::cli::stream_events_for_client(&client, &root, &cursor, &mut output),
            Err(super::super::cli::ErrorClass::Connection)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&output).unwrap(),
            json!({"type":"instance_change"})
        );
        assert_eq!(std::fs::read(&cursor).unwrap(), bytes);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        drop(server);
        cleanup(&root);
    }
    #[test]
    fn t17_same_client_transport_loss_is_exactly_three_attempts_no_poll_or_new_owner() {
        let root = fixture_root();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let descriptor = Descriptor {
            version: PROTOCOL_VERSION,
            address: listener.local_addr().unwrap().to_string(),
            token: "a".repeat(64),
            instance: "b".repeat(64),
        };
        descriptor.publish(&root).unwrap();
        let attempts = Arc::new(AtomicU64::new(0));
        let count = attempts.clone();
        let worker = thread::spawn(move || {
            let mut identity = None;
            for _ in 0..3 {
                let (mut connection, _) = listener.accept().unwrap();
                let bytes = read_frame(&mut connection, MAX_REQUEST).unwrap();
                let request: Request = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request.command, "cli_events");
                if let Some(old) = identity.as_ref() {
                    assert_eq!(old, &request.client);
                }
                identity = Some(request.client);
                count.fetch_add(1, Ordering::Relaxed);
            }
        });
        let client = Client::new(descriptor).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            super::super::cli::stream_events_for_client(
                &client,
                &root,
                &root.join("cursor.json"),
                &mut Vec::new()
            ),
            Err(super::super::cli::ErrorClass::Connection)
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 3);
        assert!(started.elapsed() < Duration::from_secs(5));
        worker.join().unwrap();
        cleanup(&root);
    }
    #[test]
    fn t17_missing_history_never_initializes_and_filtered_page_advances_without_gap() {
        let manager = super::super::SessionManager::default();
        for _ in 0..150 {
            observe_owner_event(
                &manager,
                "agent-state",
                r#"{"session_id":"s-1-2","data":"updated"}"#,
            )
            .unwrap();
        }
        let p = cli_event_page(&manager, 0).unwrap();
        assert_eq!(p["cursor"], 128);
        assert_eq!(p["gap"], false);
        assert_eq!(p["events"], json!([]));
        assert!(manager.history.lock().unwrap().is_none());
        let next = cli_event_page(&manager, 128).unwrap();
        assert_eq!(next["cursor"], 150);
    }
    #[test]
    fn t17_single_oversize_raw_event_marks_gap_instead_of_secrets_or_false_clean() {
        let manager = super::super::SessionManager::default();
        manager
            .relay
            .lock()
            .unwrap()
            .push("session-output", "X".repeat(4 * 1024 * 1024 + 1));
        let p = cli_event_page(&manager, 0).unwrap();
        assert_eq!(p["gap"], true);
        assert_eq!(p["gap_sequence"], 1);
        assert_eq!(p["cursor"], 1);
        assert_eq!(p["events"], json!([]));
    }
}

fn finite<'a>(value: &'a str, allowed: &[&str]) -> &'a str {
    if allowed.contains(&value) {
        value
    } else {
        "unknown"
    }
}
fn project_cli_event(event: &RelayEvent) -> Option<serde_json::Value> {
    use serde_json::json;
    if event.name == "cli-state-unavailable" && event.payload == "{}" {
        return Some(json!({"sequence":event.sequence,"type":"gap","snapshot_required":true}));
    }
    if event.payload.len() > 65536 {
        return None;
    }
    let p: serde_json::Value = serde_json::from_str(&event.payload).ok()?;
    let id = p.get("session_id")?.as_str()?;
    super::session_id_from_link(&format!("yam://session/{id}"))?;
    let mut line = match event.name.as_str() {
        "session-state" => {
            let status = p.get("status")?.as_str()?;
            if ![
                "starting",
                "running",
                "succeeded",
                "failed",
                "stopped",
                "needs_attention",
            ]
            .contains(&status)
            {
                return None;
            }
            json!({"type":"lifecycle","session_id":id,"status":status})
        }
        "session-phase" => {
            let phase = p.get("data")?.as_str()?;
            if ![
                "idle",
                "working",
                "waiting",
                "completed",
                "failed",
                "unknown",
            ]
            .contains(&phase)
            {
                return None;
            }
            json!({"type":"phase","session_id":id,"phase":phase})
        }
        "cli-agent-snapshot" => {
            let phase = p.get("phase")?.as_str()?;
            let integration = p.get("integration")?.as_str()?;
            if finite(phase, super::cli::CLI_AGENT_PHASES) != phase
                || finite(
                    integration,
                    &[
                        "connecting",
                        "connected",
                        "unavailable",
                        "degraded",
                        "unknown",
                    ],
                ) != integration
            {
                return None;
            }
            let mut counts = serde_json::Map::new();
            for key in [
                "count",
                "read",
                "unread",
                "pending",
                "failed",
                "accepted",
                "suppressed",
                "unknown",
            ] {
                let n = p.get("receipts")?.get(key)?.as_u64()?;
                if n > 10000 {
                    return None;
                }
                counts.insert(key.into(), json!(n));
            }
            json!({"type":"agent_snapshot","session_id":id,"phase":phase,"integration":integration,"revision":p.get("revision")?.as_u64()?,"receipts":counts})
        }
        _ => return None,
    };
    line["sequence"] = json!(event.sequence);
    Some(line)
}
pub(super) fn valid_cli_event_line(line: &serde_json::Value) -> bool {
    if line.get("type").and_then(serde_json::Value::as_str) == Some("gap") {
        return line
            .get("sequence")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|seq| {
                line == &serde_json::json!({"type":"gap","sequence":seq,"snapshot_required":true})
            });
    }
    let Some(kind) = line.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(sequence) = line.get("sequence").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    let Some(mut p) = line.as_object().cloned() else {
        return false;
    };
    p.remove("type");
    p.remove("sequence");
    let name = match kind {
        "lifecycle" => "session-state",
        "phase" => {
            let Some(phase) = p.remove("phase") else {
                return false;
            };
            p.insert("data".into(), phase);
            "session-phase"
        }
        "agent_snapshot" => "cli-agent-snapshot",
        _ => return false,
    };
    project_cli_event(&RelayEvent {
        name: name.into(),
        payload: serde_json::Value::Object(p).to_string(),
        sequence,
    })
    .as_ref()
        == Some(line)
}
fn cli_event_page(
    manager: &super::SessionManager,
    cursor: u64,
) -> Result<serde_json::Value, String> {
    let relay = manager.relay.lock().map_err(|_| "cli_events_unavailable")?;
    if cursor > relay.sequence {
        return Err("cli_events_cursor".into());
    }
    let floor = cursor.max(relay.lost);
    let mut high = floor;
    let mut events = vec![];
    let mut bytes = 0;
    for event in relay.events.iter().filter(|e| e.sequence > floor).take(128) {
        if let Some(line) = project_cli_event(event) {
            let size = line.to_string().len();
            if bytes + size > 256 * 1024 {
                break;
            }
            bytes += size;
            events.push(line);
        }
        high = event.sequence;
    }
    Ok(
        serde_json::json!({"cursor":high,"gap":cursor<relay.lost,"gap_sequence":if cursor<relay.lost {relay.lost}else{0},"events":events}),
    )
}
fn agent_snapshot(manager: &super::SessionManager, id: &str) -> Result<Option<String>, ()> {
    let Some(history) = manager.history.try_lock().map_err(|_| ())?.clone() else {
        return Ok(None);
    };
    if history.archive_pending.load(Ordering::Acquire) {
        return Err(());
    }
    let records = history.records.try_lock().map_err(|_| ())?;
    let Some(record) = records.iter().find(|r| r.summary.session_id == id) else {
        return Ok(None);
    };
    let agent = &record.agent;
    if agent.inbox.len() > 10000 {
        return Err(());
    }
    let mut counts = serde_json::Map::new();
    counts.insert("count".into(), serde_json::json!(agent.inbox.len()));
    for key in [
        "read",
        "unread",
        "pending",
        "failed",
        "accepted",
        "suppressed",
        "unknown",
    ] {
        let n = agent
            .inbox
            .iter()
            .filter(|receipt| match key {
                "read" => receipt.read,
                "unread" => !receipt.read,
                "unknown" => !["pending", "failed", "accepted", "suppressed"]
                    .contains(&receipt.delivery.as_str()),
                _ => receipt.delivery == key,
            })
            .count();
        counts.insert(key.into(), serde_json::json!(n));
    }
    Ok(Some(serde_json::json!({"session_id":id,"phase":finite(&agent.phase,super::cli::CLI_AGENT_PHASES),"integration":finite(&agent.integration,&["connecting","connected","unavailable","degraded","unknown"]),"revision":agent.revision,"receipts":counts}).to_string()))
}

fn observe_owner_event(
    manager: &super::SessionManager,
    name: &str,
    payload: &str,
) -> Result<(), String> {
    let observed = if name == "agent-state" {
        serde_json::from_str::<serde_json::Value>(payload)
            .ok()
            .and_then(|p| {
                p.get("session_id")
                    .and_then(serde_json::Value::as_str)
                    .map(|id| agent_snapshot(manager, id))
            })
    } else {
        None
    };
    // History locks are released before relay. Only the CLI sees missing snapshot guidance.
    let mut relay = manager.relay.lock().map_err(|_| "cli_events_unavailable")?;
    relay.push(name, payload.into());
    match observed {
        Some(Ok(Some(snapshot))) => relay.push("cli-agent-snapshot", snapshot),
        Some(Err(())) => relay.push("cli-state-unavailable", "{}".into()),
        _ => {}
    }
    Ok(())
}

impl Client {
    pub(super) fn event_instance(&self) -> &str {
        &self.descriptor.instance
    }
}

#[cfg(test)]
mod git_changes_contract_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn f3_actual_dispatch_list_returns_bounded_metadata() {
        let _serial = super::super::git_context::f3_serial_query_test();
        let request = Request {
            version: PROTOCOL_VERSION,
            token: "a".repeat(64),
            instance: "b".repeat(64),
            client: "c".repeat(64),
            id: 1,
            command: "cancel_git_changes".into(),
            args: json!({"query_token":"b2345678-1234-4234-8234-123456789abc"}),
        };
        assert!(dispatch_git_changes(&request)
            .expect("actual semantic endpoint must handle cancel")
            .is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn f3_actual_shared_client_cancels_quiet_child_while_sessions_locked() {
        let _serial = super::super::git_context::f3_serial_query_test();
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;
        let root = std::env::temp_dir().join(format!(
            "yam-f3-wire-{}-{}",
            std::process::id(),
            super::super::next_session_id()
        ));
        std::fs::create_dir(&root).unwrap();
        private_root(&root).unwrap();
        let repo = root.join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = super::super::find_executable("git")
            .unwrap()
            .canonicalize()
            .unwrap();
        let run = |args: &[&str]| {
            let output = std::process::Command::new(&git)
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(output.status.success());
        };
        run(&["init", "-q"]);
        let marker = root.join("quiet-started");
        let executable = root.join("git-wrapper");
        std::fs::write(&executable,format!("#!/bin/sh\nfor arg in \"$@\"; do\nif [ \"$arg\" = status ]; then echo $$ > '{}'; sleep 10; fi\ndone\nexec '{}' \"$@\"\n",marker.display(),git.display())).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let manager = Arc::new(super::super::SessionManager::default());
        let dispatch_manager = manager.clone();
        let wrapper = executable.clone();
        let server = Server::start(&root, move |request| {
            super::super::git_context::F3_TEST_GIT
                .with(|value| *value.borrow_mut() = Some(wrapper.clone()));
            let response = dispatch_git_changes(&request);
            super::super::git_context::F3_TEST_GIT.with(|value| *value.borrow_mut() = None);
            if let Some(result) = response {
                result
            } else {
                let _guard = dispatch_manager.sessions.lock().unwrap();
                Err("unexpected admission".into())
            }
        })
        .unwrap();
        let client = Arc::new(Client::new(Descriptor::read(&root).unwrap()).unwrap());
        let querying = client.clone();
        let directory = repo.to_string_lossy().into_owned();
        let token = "c2345678-1234-4234-8234-123456789abc";
        let query = std::thread::spawn(move || {
            querying.call(
                "get_git_changes",
                json!({"path":directory,"query_token":token}),
            )
        });
        // Setup includes Git probes; cancellation latency is timed separately below.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !marker.exists() && !query.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(marker.exists(), "query must reach actual quiet Git child");
        let _sessions = manager.sessions.lock().unwrap();
        let begin = Instant::now();
        client
            .call("cancel_git_changes", json!({"query_token":token}))
            .unwrap();
        assert_eq!(query.join().unwrap().unwrap_err(), "git_cancelled");
        assert!(
            begin.elapsed() < Duration::from_secs(1),
            "cancel must not wait whole query deadline"
        );
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "own child must exit");
        drop(_sessions);
        drop(server);
        std::fs::remove_dir_all(&root).unwrap();
    }
    const TOKEN: &str = "12345678-1234-4234-8234-123456789abc";
    struct BranchRepo(std::path::PathBuf);
    impl BranchRepo {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "yam-branch-{}-{}",
                std::process::id(),
                super::super::next_session_id()
            ));
            std::fs::create_dir(&root).unwrap();
            let repo = Self(std::fs::canonicalize(root).unwrap());
            repo.git(&["init", "-b", "fixture"]);
            repo
        }
        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "user.name=Jeff.Liu",
                    "-c",
                    "user.email=fixture@example.invalid",
                ])
                .args(args)
                .current_dir(&self.0)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(output.status.success(), "fixture Git failed");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }
        fn query(
            &self,
            baseline: Option<&str>,
            selected: Option<(&str, &str)>,
        ) -> Result<serde_json::Value, String> {
            let mut args = json!({"path":self.0,"query_token":TOKEN});
            if let Some(baseline) = baseline {
                args["baseline"] = baseline.into();
            }
            if let Some((path, side)) = selected {
                args["selected_path"] = path.into();
                args["side"] = side.into();
            }
            dispatch_git_changes(&Request {
                version: 1,
                token: "unused-direct-dispatch".into(),
                instance: "branch-fixture".into(),
                client: "branch-fixture".into(),
                id: 1,
                command: "get_git_changes".into(),
                args,
            })
            .unwrap()
        }
    }
    impl Drop for BranchRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn branch_compare_committed_patch_excludes_index_worktree_and_untracked_without_writes() {
        let _serial = super::super::git_context::f3_serial_query_test();
        let repo = BranchRepo::new();
        std::fs::write(repo.0.join("file.txt"), "before\n").unwrap();
        repo.git(&["add", "file.txt"]);
        repo.git(&["commit", "-m", "baseline"]);
        let base = repo.git(&["rev-parse", "HEAD"]);
        std::fs::write(repo.0.join("file.txt"), "committed\n").unwrap();
        repo.git(&["commit", "-am", "change"]);
        let head = repo.git(&["rev-parse", "HEAD"]);
        std::fs::write(repo.0.join("file.txt"), "staged-only\n").unwrap();
        repo.git(&["add", "file.txt"]);
        std::fs::write(repo.0.join("file.txt"), "worktree-only\n").unwrap();
        std::fs::write(repo.0.join("untracked"), "private\n").unwrap();
        let index = std::fs::read(repo.0.join(".git/index")).unwrap();
        let status = repo.git(&["status", "--porcelain=v1"]);
        let value = repo.query(Some(&base), Some(("file.txt", "committed")));
        assert!(value.is_ok(), "{value:?}");
        let value = value.unwrap();
        assert_eq!(value["comparison"]["base"], base);
        assert_eq!(value["comparison"]["head"], head);
        let text = value["patch"]["text"].as_str().unwrap();
        assert!(text.contains("+committed"));
        assert!(!text.contains("staged-only") && !text.contains("worktree-only"));
        assert_eq!(value["rows"].as_array().unwrap().len(), 1);
        assert_eq!(value["rows"][0]["committed"], "M");
        assert_eq!(repo.git(&["status", "--porcelain=v1"]), status);
        assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
        assert!(repo.query(None, None).unwrap()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["untracked"] == true));
        assert!(repo.query(Some("refs/heads/missing"), None).is_err());
    }
    #[test]
    fn branch_compare_rename_delete_binary_and_literal_paths_are_explicit() {
        let _serial = super::super::git_context::f3_serial_query_test();
        let repo = BranchRepo::new();
        for name in ["old.txt", "deleted.txt", ":(glob)新 file.txt"] {
            std::fs::write(repo.0.join(name), "before\n").unwrap();
        }
        repo.git(&["add", "."]);
        repo.git(&["commit", "-m", "baseline"]);
        let base = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&["mv", "old.txt", "renamed.txt"]);
        repo.git(&["rm", "deleted.txt"]);
        std::fs::write(repo.0.join(":(glob)新 file.txt"), "changed\n").unwrap();
        std::fs::write(repo.0.join("binary.dat"), [0, 1, 2]).unwrap();
        repo.git(&["add", "."]);
        repo.git(&["commit", "-m", "changes"]);
        let value = repo.query(Some(&base), None).unwrap();
        let rows = value["rows"].as_array().unwrap();
        assert!(rows
            .iter()
            .any(|row| row["path"] == "old.txt" && row["committed"] == "D"));
        assert!(rows
            .iter()
            .any(|row| row["path"] == "renamed.txt" && row["committed"] == "A"));
        assert_eq!(
            repo.query(Some(&base), Some(("binary.dat", "committed")))
                .unwrap()["patch"]["kind"],
            "binary"
        );
        assert!(repo
            .query(Some(&base), Some((":(glob)新 file.txt", "committed")))
            .unwrap()["patch"]["text"]
            .as_str()
            .unwrap()
            .contains("+changed"));
        assert_eq!(
            repo.query(Some(&base), Some(("missing.txt", "committed")))
                .unwrap_err(),
            "git_context_changed"
        );
    }
    #[test]
    fn f3_query_schema_allows_list_and_exact_selected_side() {
        assert!(validate_command(
            "get_git_changes",
            &json!({"path":"/fixture/repo","query_token":TOKEN})
        )
        .is_ok());
        for side in ["staged", "worktree"] {
            assert!(validate_command("get_git_changes", &json!({"path":"/fixture/repo","query_token":TOKEN,"selected_path":"目录/file.txt","side":side})).is_ok());
        }
    }
    #[test]
    fn branch_compare_schema_requires_explicit_baseline_and_matching_side() {
        assert!(validate_command("get_git_changes", &json!({"path":"/fixture/repo","query_token":TOKEN,"baseline":"HEAD~1","selected_path":"file.txt","side":"committed"})).is_ok());
        for baseline in [
            json!(""),
            json!("--all"),
            json!("main\n"),
            json!(4),
            json!(null),
        ] {
            assert!(validate_command(
                "get_git_changes",
                &json!({"path":"/fixture/repo","query_token":TOKEN,"baseline":baseline})
            )
            .is_err());
        }
        assert!(validate_command("get_git_changes", &json!({"path":"/fixture/repo","query_token":TOKEN,"side":"committed","selected_path":"file.txt"})).is_err());
        assert!(validate_command("get_git_changes", &json!({"path":"/fixture/repo","query_token":TOKEN,"baseline":"main","side":"staged","selected_path":"file.txt"})).is_err());
    }
    #[test]
    fn f3_cancel_schema_allows_exact_token() {
        assert!(validate_command("cancel_git_changes", &json!({"query_token":TOKEN})).is_ok());
    }
    #[test]
    fn f3_query_schema_rejects_invalid_and_unpaired_selection() {
        for args in [
            json!({"path":"/fixture/repo","query_token":TOKEN,"side":"staged"}),
            json!({"path":"/fixture/repo","query_token":TOKEN,"selected_path":"file.txt"}),
            json!({"path":"/fixture/repo","query_token":TOKEN,"selected_path":"../escape","side":"worktree"}),
            json!({"path":"/fixture/repo","query_token":TOKEN,"selected_path":"file.txt","side":"HEAD"}),
            json!({"path":"/fixture/repo","query_token":TOKEN,"extra":"SECRET"}),
            json!({"path":"/fixture/repo","query_token":TOKEN.to_uppercase()}),
            json!({"path":"/fixture/repo","query_token":"bad"}),
            json!({"path":"/fixture/repo","query_token":TOKEN,"selected_path":"x".repeat(4097),"side":"staged"}),
        ] {
            assert!(validate_command("get_git_changes", &args).is_err());
        }
    }
    #[test]
    fn f3_cancel_schema_rejects_unknown_fields_and_bad_token() {
        for args in [
            json!({}),
            json!({"query_token":"bad"}),
            json!({"query_token":TOKEN,"path":"/fixture"}),
        ] {
            assert!(validate_command("cancel_git_changes", &args).is_err());
        }
    }
}

fn dispatch_git_changes(request: &Request) -> Option<Result<serde_json::Value, String>> {
    if !matches!(
        request.command.as_str(),
        "get_git_changes" | "cancel_git_changes"
    ) {
        return None;
    }
    Some((|| {
        validate_command(&request.command, &request.args)?;
        let token = request.args["query_token"]
            .as_str()
            .ok_or("git_invalid_request")?;
        if request.command == "cancel_git_changes" {
            super::git_context::cancel_changes(&request.instance, &request.client, token)?;
            return Ok(serde_json::json!({"query_token":token,"cancel_requested":true}));
        }
        let selected = request.args["selected_path"]
            .as_str()
            .zip(request.args["side"].as_str());
        serde_json::to_value(super::git_context::query_changes(
            std::path::Path::new(request.args["path"].as_str().ok_or("git_invalid_request")?),
            &request.instance,
            &request.client,
            token,
            selected,
            request.args["baseline"].as_str(),
        )?)
        .map_err(|_| "git_query_failed".into())
    })())
}

#[cfg(test)]
mod f6_log_compatibility_tests {
    #[test]
    fn f6_receiving_snapshot_and_search_accept_old_owner_without_ranges() {
        let snapshot: super::super::LogSnapshot = serde_json::from_value(
            serde_json::json!({"data":"legacy","offset":0,"end_offset":6,"status":"stopped"}),
        )
        .unwrap();
        assert!(snapshot.range.is_none());
        let page: super::super::session_logs::SearchPage=serde_json::from_value(serde_json::json!({"hits":[],"has_more":false,"complete":true,"issues":[],"next_cursor":null,"current_cursor":null})).unwrap();
        assert!(page.scanned_ranges.is_empty());
    }
}

#[cfg(test)]
mod a02b_tests {
    #[test]
    fn a02b_background_accepts_only_narrow_ordinary_env_refs() {
        let valid = serde_json::json!({"shell":{"program":null,"login":if cfg!(windows){serde_json::Value::Null}else{serde_json::json!(true)}},"env_refs":{"TARGET":"SOURCE"}});
        assert_eq!(super::validate_command("create_session", &valid), Ok(()));
        for refs in [
            serde_json::json!([]),
            serde_json::json!({"A":1}),
            serde_json::json!({"Path":"A","PATH":"B"}),
            serde_json::json!({"YAM_A":"B"}),
        ] {
            let mut args = valid.clone();
            args["env_refs"] = refs;
            assert!(super::validate_command("create_session", &args).is_err());
        }
        for field in [
            "command",
            "launch",
            "resume_from",
            "project_config",
            "worktree_attempt",
        ] {
            let mut args = valid.clone();
            args[field] = serde_json::json!("");
            assert!(super::validate_command("create_session", &args).is_err());
        }
    }

    #[test]
    fn a05a3_actual_cached_start_preserves_captured_capacity() {
        let starts = std::sync::Mutex::new(super::StartRequests::default());
        let calls = std::cell::Cell::new(0);
        let request = |id| super::Request {
            version: 1,
            token: String::new(),
            instance: String::new(),
            client: "retention-fixture".into(),
            id,
            command: "create_session".into(),
            args: serde_json::json!({"retained_lines":500}),
        };
        let first = super::dispatch_session_start(&starts, request(1), |r| {
            calls.set(calls.get() + 1);
            Ok(r.args)
        });
        assert_eq!(first.as_ref().unwrap()["retained_lines"], 500);
        assert_eq!(
            super::dispatch_session_start(&starts, request(1), |_| panic!(
                "must not redispatch cached start"
            )),
            first
        );
        assert_eq!(calls.get(), 1);
    }
    #[test]
    fn a07b1_actual_cached_dispatch_prepares_and_spawns_once_including_failure_warning() {
        let _serial = crate::worktree_manager::serial_owner_test();
        let starts = std::sync::Mutex::new(super::StartRequests::default());
        let calls = std::cell::Cell::new(0);
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::path::PathBuf::from(format!(
            "/tmp/yam-a07b1-cache-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let request = |id| super::Request {
            version: 1,
            token: String::new(),
            instance: String::new(),
            client: "a07b1-fixture".into(),
            id,
            command: "create_session".into(),
            args: serde_json::json!({"directory_reporting":true,"shell":{"program":"/bin/zsh","login":true}}),
        };
        for (id, failure) in [(1, false), (2, true)] {
            let first = super::dispatch_session_start(&starts, request(id), |_| {
                let mut b = portable_pty::CommandBuilder::new("/bin/zsh");
                b.env_clear();
                b.env("ZDOTDIR", if failure { "" } else { "/fixture" });
                let (_, assets, warning, _command_warning) = crate::zsh_directory_reporting::spawn(
                    &root,
                    b,
                    true,
                    false,
                    |_| -> Result<(), String> {
                        calls.set(calls.get() + 1);
                        Ok(())
                    },
                )?;
                drop(assets);
                Ok(serde_json::json!({"warning":warning}))
            });
            assert_eq!(
                super::dispatch_session_start(&starts, request(id), |_| panic!(
                    "retained request must not dispatch"
                )),
                first
            );
            assert_eq!(calls.get(), id as usize);
        }
        starts.lock().unwrap().reserved = 16 * 1024 * 1024;
        assert!(
            super::dispatch_session_start(&starts, request(3), |_| panic!(
                "full budget must not prepare or spawn"
            ))
            .is_err()
        );
        assert_eq!(calls.get(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a02b_actual_start_dispatch_keeps_dynamic_resolution_in_retained_receipt() {
        use std::cell::Cell;
        use std::ffi::OsString;
        let starts = std::sync::Mutex::new(super::StartRequests::default());
        let calls = Cell::new(0);
        let request = |id| super::Request {
            version: 1,
            token: String::new(),
            instance: String::new(),
            client: "synthetic-client".into(),
            id,
            command: "create_session".into(),
            args: serde_json::json!({"shell":{"program":null,"login":if cfg!(windows){serde_json::Value::Null}else{serde_json::json!(true)}},"env_refs":{"TARGET":"SOURCE"}}),
        };
        for (id, value) in [(1, Some("literal")), (2, None), (3, Some("oversized"))] {
            let first = super::dispatch_session_start(&starts, request(id), |req| {
                let refs = serde_json::from_value(req.args["env_refs"].clone()).unwrap();
                let env = crate::resolve_profile_env(&refs, &|_| {
                    calls.set(calls.get() + 1);
                    value.map(|v| {
                        OsString::from(if v == "oversized" {
                            "x".repeat(16385)
                        } else {
                            v.into()
                        })
                    })
                })?;
                Ok(serde_json::json!({"count":env.len()}))
            });
            assert_eq!(
                super::dispatch_session_start(&starts, request(id), |_| panic!(
                    "must not dispatch a retained request"
                )),
                first
            );
            assert_eq!(calls.get(), id as usize);
        }
        starts.lock().unwrap().reserved = 16 * 1024 * 1024;
        assert!(
            super::dispatch_session_start(&starts, request(4), |_| panic!(
                "budget must reject before resolve"
            ))
            .is_err()
        );
        assert_eq!(calls.get(), 3);
        assert!(
            super::dispatch_session_start(&starts, request(1), |_| panic!("old receipt remains"))
                .is_ok()
        );
        let mut changed = request(1);
        changed.args["env_refs"] = serde_json::json!({"TARGET":"OTHER"});
        assert!(super::dispatch_session_start(&starts, changed, |_| panic!(
            "changed request must not resolve"
        ))
        .is_err());
    }
    #[test]
    fn a02b_spawn_fixed_reason_is_cached_without_reformatting_or_republishing() {
        struct Secret(std::cell::Cell<usize>);
        impl std::fmt::Display for Secret {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.set(self.0.get() + 1);
                write!(f, "SYNTHETIC_SECRET")
            }
        }
        let secret = Secret(std::cell::Cell::new(0));
        let records = std::cell::RefCell::new(Vec::new());
        let events = std::cell::RefCell::new(Vec::new());
        let starts = std::sync::Mutex::new(super::StartRequests::default());
        let request = || super::Request {
            version: 1,
            token: String::new(),
            instance: String::new(),
            client: "synthetic".into(),
            id: 8,
            command: "create_session".into(),
            args: serde_json::json!({"shell":{"program":null,"login":if cfg!(windows){serde_json::Value::Null}else{serde_json::json!(true)}},"env_refs":{"TARGET":"SOURCE"}}),
        };
        let first = super::dispatch_session_start(&starts, request(), |_| {
            crate::report_spawn_failure(
                &secret,
                true,
                |reason| {
                    records.borrow_mut().push(reason.to_string());
                    Ok(())
                },
                |reason| events.borrow_mut().push(reason.to_string()),
            )
        });
        assert_eq!(first, Err("profile_env_start_failed".into()));
        assert_eq!(
            super::dispatch_session_start(&starts, request(), |_| panic!(
                "cached spawn failure must not run"
            )),
            first
        );
        assert_eq!(*records.borrow(), vec!["profile_env_start_failed"]);
        assert_eq!(*events.borrow(), vec!["profile_env_start_failed"]);
        assert_eq!(secret.0.get(), 0);
    }
}

#[cfg(test)]
mod b05a_completion_tests {
    use super::*;
    fn descriptor(listener: &TcpListener) -> Descriptor {
        Descriptor {
            version: PROTOCOL_VERSION,
            address: listener.local_addr().unwrap().to_string(),
            instance: "a".repeat(64),
            token: "b".repeat(64),
        }
    }
    #[test]
    fn b05a_matched_refusal_is_completed_and_does_not_retry_input() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = Client::new(descriptor(&listener)).unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let bytes = read_frame(&mut stream, MAX_REQUEST).unwrap();
            let request: Request = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request.command, "write_session");
            let response = Response {
                version: PROTOCOL_VERSION,
                instance: request.instance,
                client: request.client,
                id: request.id,
                result: Err("lease held by another client".into()),
            };
            write_frame(
                &mut stream,
                &serde_json::to_vec(&response).unwrap(),
                MAX_RESPONSE,
            )
            .unwrap();
            listener.set_nonblocking(true).unwrap();
            assert!(listener.accept().is_err());
        });
        assert!(matches!(
            client.call_outcome(
                "write_session",
                serde_json::json!({"session_id":"s-1-1","data":"x"})
            ),
            CallOutcome::Completed(Err(_))
        ));
        worker.join().unwrap();
    }
    #[test]
    fn b05a_after_write_transport_loss_is_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = Client::new(descriptor(&listener)).unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_frame(&mut stream, MAX_REQUEST).unwrap();
        });
        assert!(matches!(
            client.call_outcome(
                "write_session",
                serde_json::json!({"session_id":"s-1-1","data":"x"})
            ),
            CallOutcome::Unknown(_)
        ));
        worker.join().unwrap();
    }
    #[test]
    fn b05a_bad_request_is_not_dispatched() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = Client::new(descriptor(&listener)).unwrap();
        assert!(matches!(
            client.call_outcome("write_session", serde_json::json!([])),
            CallOutcome::NotDispatched(_)
        ));
    }
}

#[cfg(test)]
mod d03a_tests {
    #[test]
    fn d03a_background_standalone_ssh_retention_three_values() {
        for lines in [200, 500, 2000] {
            assert!(super::validate_command("create_session",&serde_json::json!({"cwd":"/tmp","ssh":{"host":"Alias_1","user":null,"port":null},"retained_lines":lines})).is_ok());
        }
    }
    #[test]
    fn d03a_background_mixed_ssh_rejected() {
        for (key, value) in [
            ("command", serde_json::json!("")),
            ("resume_from", serde_json::json!("stored")),
            ("shell", serde_json::json!({"program":null,"login":true})),
            ("directory_reporting", serde_json::json!(true)),
            ("env_refs", serde_json::json!({"T":"S"})),
        ] {
            let mut args =
                serde_json::json!({"cwd":"/tmp","ssh":{"host":"alias","user":null,"port":null}});
            args[key] = value;
            assert!(super::validate_command("create_session", &args).is_err());
        }
    }
    #[test]
    fn d03a_same_ssh_start_request_is_cached_once() {
        let mut starts = super::StartRequests::default();
        let args = serde_json::json!({"ssh":{"host":"Alias_1","user":null,"port":2222},"retained_lines":500});
        let calls = std::cell::Cell::new(0);
        let value = starts
            .run("client", 1, args.clone(), || {
                calls.set(calls.get() + 1);
                Ok(serde_json::json!({"ssh":args["ssh"]}))
            })
            .unwrap();
        assert_eq!(
            starts
                .run("client", 1, args.clone(), || panic!(
                    "no logical second start"
                ))
                .unwrap(),
            value
        );
        let mut changed = args;
        changed["ssh"]["port"] = serde_json::json!(22);
        assert!(starts
            .run("client", 1, changed, || panic!("no replacement"))
            .is_err());
        assert_eq!(calls.get(), 1);
    }
}

#[cfg(test)]
mod provider_protocol_tests {
    use super::*;
    #[test]
    fn provider_rpc_accepts_snapshot_with_required_marker_and_old_wire_fails_closed() {
        let launch:crate::AgentLaunch=serde_json::from_value(serde_json::json!({"adapter":"codex","mode":"interactive","extra_args":"","prompt":null,"provider":{"id":"deepseek","model":"deepseek-flash","base_url":"https://api.deepseek.com","api_key_env":"DEEPSEEK_API_KEY"},"env_refs":{"DEEPSEEK_API_KEY":"OWNER_KEY"}})).unwrap();
        let args = crate::create_session_arguments(
            &None,
            &None,
            &Some(launch),
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
        )
        .unwrap();
        assert_eq!(args["provider_protocol"], 1);
        validate_command("create_session", &args).unwrap();
        let mut no_marker = args.clone();
        no_marker
            .as_object_mut()
            .unwrap()
            .remove("provider_protocol");
        assert!(validate_command("create_session", &no_marker).is_err());
        let mut malformed = args.clone();
        malformed["launch"]["provider"]["api_key_env"] = serde_json::json!("sk-plain-key");
        assert!(validate_command("create_session", &malformed).is_err());
        let mut unknown = args.clone();
        unknown["launch"]["unknown"] = serde_json::json!(true);
        assert!(validate_command("create_session", &unknown).is_err());
        let resume = crate::create_session_arguments(
            &None,
            &None,
            &None,
            &Some("ended-session".into()),
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
            &None,
        )
        .unwrap();
        assert_eq!(resume["provider_protocol"], 1);
        validate_command("create_session", &resume).unwrap();
        // Protocol v2 owners reject unknown top-level fields before dispatch.
        let legacy_allowed = [
            "cwd",
            "command",
            "launch",
            "resume_from",
            "project_config",
            "worktree_attempt",
            "shell",
            "env_refs",
            "directory_reporting",
            "command_reporting",
            "retained_lines",
            "ssh",
        ];
        assert!(args
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !legacy_allowed.contains(&key.as_str())));
        assert!(resume
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !legacy_allowed.contains(&key.as_str())));
    }
}

#[cfg(test)]
mod explicit_reconnect_tests {
    use super::*;
    #[test]
    fn t5_explicit_reconnect_authenticates_original_client_and_preserves_cursor() {
        for (reply, wrong_identity, accepted) in [
            (Ok(serde_json::json!({"active":2})), false, true),
            (Err("owner unavailable".into()), false, false),
            (Ok(serde_json::json!({"active":2})), true, false),
        ] {
            let (client, peer) = super::cli_wire_tests::peer(Some(reply), wrong_identity);
            let manager = super::super::SessionManager::default();
            let client = Arc::new(client);
            *manager.background_client.lock().unwrap() = Some(client.clone());
            manager.background_events.lock().unwrap().cursor = 99;
            let started = std::cell::Cell::new(false);
            let result = reconnect_existing(&manager, |selected| {
                assert!(Arc::ptr_eq(&selected, &client));
                let poll = manager.background_events.lock().unwrap();
                assert_eq!(poll.cursor, 99);
                assert!(!poll.running);
                started.set(true);
                Ok(())
            });
            assert_eq!(result.is_ok(), accepted);
            assert_eq!(started.get(), accepted);
            assert_eq!(peer.join().unwrap(), 1);
        }
    }
    #[test]
    fn t5_explicit_reconnect_without_original_client_never_discovers_or_starts_owner() {
        let manager = super::super::SessionManager::default();
        let started = std::cell::Cell::new(false);
        assert!(reconnect_existing(&manager, |_| {
            started.set(true);
            Ok(())
        })
        .is_err());
        assert!(!started.get());
    }
    #[test]
    fn update_idle_admission_shares_the_start_lock_and_never_stops_active_tasks() {
        let sessions = Mutex::new(std::collections::HashMap::from([(
            "running".to_string(),
            (),
        )]));
        let closing = AtomicBool::new(false);
        assert_eq!(
            claim_idle_update(&sessions, &closing).unwrap_err(),
            "running_tasks"
        );
        assert!(!closing.load(Ordering::Acquire));
        assert_eq!(sessions.lock().unwrap().len(), 1);
        sessions.lock().unwrap().clear();
        claim_idle_update(&sessions, &closing).unwrap();
        assert!(closing.load(Ordering::Acquire));
        assert!(claim_idle_update(&sessions, &closing).is_err());
        for command in ["prepare_update", "finish_update"] {
            assert!(validate_command(command, &serde_json::json!({})).is_ok());
            assert!(validate_command(command, &serde_json::json!({"force":true})).is_err());
        }
    }
}

#[cfg(test)]
#[test]
fn notification_test_wire_accepts_only_one_session_reference() {
    assert!(validate_command(
        "test_notification",
        &serde_json::json!({"session_id":"s-test"})
    )
    .is_ok());
    assert!(validate_command("test_notification", &serde_json::json!({})).is_err());
    assert!(validate_command(
        "test_notification",
        &serde_json::json!({"session_id":"s-test","title":"untrusted"})
    )
    .is_err());
}
