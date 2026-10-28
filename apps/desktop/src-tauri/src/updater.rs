// Author: Jeff.Liu. GUI-only updater configuration and finite operation controller.
use serde_json::Value;
#[derive(Debug, Clone)]
pub(super) struct Configuration {
    sdk: tauri_plugin_updater::Config,
}
pub(super) fn configuration(
    value: Option<&Value>,
    supported: bool,
) -> Result<Option<Configuration>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let invalid = || "updater_configuration_invalid".to_string();
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 4
        || object.keys().any(|key| {
            ![
                "pubkey",
                "endpoints",
                "requireSignedVersion",
                "allowDowngrades",
            ]
            .contains(&key.as_str())
        })
        || object.get("requireSignedVersion") != Some(&Value::Bool(true))
        || object.get("allowDowngrades") != Some(&Value::Bool(false))
    {
        return Err(invalid());
    }
    let key = object
        .get("pubkey")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let endpoints = object
        .get("endpoints")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if key.trim().is_empty()
        || key.len() > 4096
        || !(1..=4).contains(&endpoints.len())
        || endpoints.iter().any(|endpoint| {
            endpoint
                .as_str()
                .is_none_or(|url| url.len() > 2048 || url.chars().any(char::is_control))
        })
    {
        return Err(invalid());
    }
    let sdk: tauri_plugin_updater::Config =
        serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    if sdk.endpoints.iter().any(|url| {
        url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
    }) {
        return Err(invalid());
    }
    if !supported {
        return Err("updater_platform_unsupported".into());
    }
    Ok(Some(Configuration { sdk }))
}

const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GENERATION: u64 = (1u64 << 53) - 1;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};
#[derive(Debug, Clone, serde::Serialize)]
pub(super) struct Release {
    version: String,
    notes: String,
    published: Option<String>,
}
impl Release {
    fn valid(&self) -> bool {
        !self.version.is_empty()
            && self.version.len() <= 128
            && !self.version.chars().any(char::is_control)
            && self.notes.len() <= 8192
            && !self
                .notes
                .chars()
                .any(|c| c.is_control() && !['\n', '\r', '\t'].contains(&c))
            && self
                .published
                .as_ref()
                .is_none_or(|p| p.len() <= 64 && !p.chars().any(char::is_control))
    }
}
#[derive(Clone)]
struct Candidate {
    release: Release,
    sdk: Option<Box<tauri_plugin_updater::Update>>,
}
enum Outcome {
    NoUpdate,
    Available(Candidate),
    Verified(Vec<u8>),
}
#[derive(Clone, Copy)]
enum Operation {
    Check,
    Download,
}
#[derive(Debug, Clone, serde::Serialize)]
struct Transfer {
    observed: u64,
    total: Option<u64>,
}
#[derive(Debug, Clone, serde::Serialize)]
pub(super) struct Snapshot {
    generation: u64,
    state: String,
    current_version: String,
    configured: bool,
    automatic_checks: bool,
    release: Option<Release>,
    progress: Option<Transfer>,
    reason: Option<&'static str>,
    install_allowed: bool,
    install_blocked_reason: Option<&'static str>,
}
struct Flight {
    deadline: Instant,
    generation: u64,
    abort: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    reason: Mutex<Option<&'static str>>,
    joined: Mutex<bool>,
    done: Condvar,
}
impl Flight {
    fn wait(&self) {
        let mut joined = self.joined.lock().unwrap_or_else(|p| p.into_inner());
        while !*joined {
            joined = self.done.wait(joined).unwrap_or_else(|p| p.into_inner());
        }
    }
    fn abort(&self) {
        let abort = self.abort.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(abort) = abort {
            abort();
        }
    }
}
struct State {
    dto: Snapshot,
    candidate: Option<Candidate>,
    verified: Option<Vec<u8>>,
    flight: Option<Arc<Flight>>,
    closed: bool,
    installing: bool,
}
pub(super) struct Controller {
    state: Mutex<State>,
    exit_cleanup: std::sync::atomic::AtomicBool,
    install_done: Condvar,
}
struct Progress {
    controller: Weak<Controller>,
    generation: u64,
}
impl Progress {
    fn observe(&self, bytes: u64, total: Option<u64>) -> Result<(), String> {
        let controller = self.controller.upgrade().ok_or("updater_cancelled")?;
        let overflow = {
            let mut state = controller.state.lock().map_err(|_| "updater_unavailable")?;
            if state.dto.generation != self.generation || state.dto.state != "downloading" {
                return Err("updater_cancelled".into());
            }
            let previous = state.dto.progress.as_ref().map_or(0, |p| p.observed);
            let observed = previous.checked_add(bytes);
            let overflow = observed.is_none_or(|v| v > MAX_ARTIFACT_BYTES)
                || total.is_some_and(|v| v > MAX_ARTIFACT_BYTES);
            if !overflow {
                state.dto.progress = Some(Transfer {
                    observed: observed.unwrap_or(0),
                    total,
                });
            }
            overflow
        };
        if overflow {
            controller.request_cancel(self.generation, "artifact_too_large")?;
            return Err("updater_artifact_too_large".into());
        }
        Ok(())
    }
    // Transfer completion is not signature verification. Only the joined SDK result can verify.
    fn transfer_finished(&self) {}
}
fn initialize_with(
    value: Option<&Value>,
    supported: bool,
    gui: bool,
    version: &str,
    register: impl FnOnce(&Configuration) -> Result<(), String>,
) -> Result<Arc<Controller>, String> {
    if version.is_empty() || version.len() > 128 || version.chars().any(char::is_control) {
        return Err("updater_version_invalid".into());
    }
    let (configured, state, reason) = if !gui {
        (false, "unsupported", Some("gui_only"))
    } else {
        match configuration(value, supported) {
            Ok(None) => (false, "unconfigured", None),
            Ok(Some(config)) => {
                if register(&config).is_ok() {
                    (true, "idle", None)
                } else {
                    (false, "unsupported", Some("sdk_unavailable"))
                }
            }
            Err(error) => (
                false,
                "unsupported",
                Some(if error == "updater_platform_unsupported" {
                    "platform_unsupported"
                } else {
                    "configuration_invalid"
                }),
            ),
        }
    };
    Ok(Arc::new(Controller {
        state: Mutex::new(State {
            dto: Snapshot {
                generation: 0,
                state: state.into(),
                current_version: version.into(),
                configured,
                automatic_checks: true,
                release: None,
                progress: None,
                reason,
                install_allowed: false,
                install_blocked_reason: Some("not_ready"),
            },
            candidate: None,
            verified: None,
            flight: None,
            closed: false,
            installing: false,
        }),
        exit_cleanup: std::sync::atomic::AtomicBool::new(false),
        install_done: Condvar::new(),
    }))
}
impl Controller {
    // Shared by the real ExitRequested body. Fence before any background-client return.
    pub(super) fn prepare_exit(&self) -> bool {
        let (generation, pending) = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            state.verified = None;
            (
                state.dto.generation,
                state.flight.is_some() || state.installing,
            )
        };
        if pending {
            let _ = self.request_cancel(generation, "cancelled");
        }
        pending
    }
    pub(super) fn claim_exit_cleanup(&self) -> bool {
        !self
            .exit_cleanup
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }
    fn set_automatic(&self, expected: u64, enabled: bool) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "updater_unavailable")?;
        if state.closed {
            return Err("updater_shutdown".into());
        }
        if state.installing {
            return Err("updater_busy".into());
        }
        if state.dto.generation != expected {
            return Err("updater_stale".into());
        }
        state.dto.automatic_checks = enabled;
        Ok(state.dto.clone())
    }
    pub(super) fn status(&self) -> Snapshot {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .dto
            .clone()
    }
    fn start<F: std::future::Future<Output = Result<Outcome, String>> + Send + 'static>(
        self: &Arc<Self>,
        operation: Operation,
        expected: u64,
        timeout: Duration,
        work: impl FnOnce(Progress, Option<Candidate>) -> F + Send + 'static,
    ) -> Result<Snapshot, String> {
        let (flight, candidate) = {
            let mut state = self.state.lock().map_err(|_| "updater_unavailable")?;
            if state.closed {
                return Err("updater_shutdown".into());
            }
            if state.dto.reason == Some("rollback_failed") {
                return Err("updater_recovery_required".into());
            }
            if !state.dto.configured {
                return Err("updater_not_configured".into());
            }
            if expected != state.dto.generation {
                return Err("updater_stale".into());
            }
            if state.flight.is_some() || state.installing {
                return Err("updater_busy".into());
            }
            if matches!(operation, Operation::Download)
                && (state.dto.state != "available" || state.candidate.is_none())
            {
                return Err("updater_candidate_unavailable".into());
            }
            state.dto.generation = state
                .dto
                .generation
                .checked_add(1)
                .filter(|n| *n < MAX_GENERATION)
                .ok_or("updater_generation_exhausted")?;
            state.dto.state = if matches!(operation, Operation::Check) {
                "checking"
            } else {
                "downloading"
            }
            .into();
            state.dto.reason = None;
            state.dto.progress = None;
            state.verified = None;
            if matches!(operation, Operation::Check) {
                state.candidate = None;
                state.dto.release = None;
            }
            let flight = Arc::new(Flight {
                deadline: Instant::now() + timeout,
                generation: state.dto.generation,
                abort: Mutex::new(None),
                reason: Mutex::new(None),
                joined: Mutex::new(false),
                done: Condvar::new(),
            });
            state.flight = Some(flight.clone());
            (flight, state.candidate.clone())
        };
        let progress = Progress {
            controller: Arc::downgrade(self),
            generation: flight.generation,
        };
        // No state lock is held while constructing or polling the adapter future.
        let task = tauri::async_runtime::spawn(async move { work(progress, candidate).await });
        let abort = task.inner().abort_handle();
        *flight.abort.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::new(move || abort.abort()));
        if flight
            .reason
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            flight.abort();
        }
        let controller = self.clone();
        let completion = flight.clone();
        tauri::async_runtime::spawn(async move {
            let result = task.await; // Exact SDK worker joined before replacement admission.
            controller.finish(&completion, result.ok().and_then(Result::ok));
        });
        let controller = Arc::downgrade(self);
        let deadline = flight.clone();
        std::thread::spawn(move || {
            let joined = deadline.joined.lock().unwrap_or_else(|p| p.into_inner());
            let (joined, _) = deadline
                .done
                .wait_timeout_while(
                    joined,
                    deadline.deadline.saturating_duration_since(Instant::now()),
                    |done| !*done,
                )
                .unwrap_or_else(|p| p.into_inner());
            let elapsed = !*joined;
            drop(joined);
            if elapsed {
                if let Some(controller) = controller.upgrade() {
                    let _ = controller.request_cancel(deadline.generation, "deadline_exceeded");
                }
            }
        });
        Ok(self.status())
    }
    fn finish(&self, flight: &Arc<Flight>, outcome: Option<Outcome>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !state
            .flight
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            return;
        }
        let mut reason = *flight.reason.lock().unwrap_or_else(|p| p.into_inner());
        // Enforce publication even if the deadline waiter or abort callback has not run yet.
        if reason.is_none() && state.closed {
            reason = Some("cancelled");
        }
        if reason.is_none() && Instant::now() >= flight.deadline {
            reason = Some("deadline_exceeded");
        }
        if let Some(reason) = reason {
            state.dto.state = if reason == "cancelled" {
                "cancelled"
            } else {
                "error"
            }
            .into();
            state.dto.reason = if reason == "cancelled" {
                None
            } else {
                Some(reason)
            };
            state.candidate = None;
            state.verified = None;
            state.dto.release = None;
            state.dto.progress = None;
        } else {
            match outcome {
                Some(Outcome::NoUpdate) if state.dto.state == "checking" => {
                    state.dto.state = "upToDate".into();
                }
                Some(Outcome::Available(candidate))
                    if state.dto.state == "checking" && candidate.release.valid() =>
                {
                    state.dto.release = Some(candidate.release.clone());
                    state.candidate = Some(candidate);
                    state.dto.state = "available".into();
                }
                Some(Outcome::Verified(bytes))
                    if state.dto.state == "downloading"
                        && state.candidate.is_some()
                        && bytes.len() as u64 <= MAX_ARTIFACT_BYTES =>
                {
                    state.verified = Some(bytes);
                    state.dto.state = "verified".into();
                }
                _ => {
                    state.dto.state = "error".into();
                    state.dto.reason = Some("operation_failed");
                    state.candidate = None;
                    state.verified = None;
                    state.dto.release = None;
                    state.dto.progress = None;
                }
            }
        }
        state.flight = None;
        *flight.joined.lock().unwrap_or_else(|p| p.into_inner()) = true;
        drop(state);
        flight.done.notify_all();
    }
    fn request_cancel(
        &self,
        expected: u64,
        reason: &'static str,
    ) -> Result<Option<Arc<Flight>>, String> {
        let flight = {
            let mut state = self.state.lock().map_err(|_| "updater_unavailable")?;
            if state.dto.generation != expected {
                return Err("updater_stale".into());
            }
            if state.installing {
                return Err("updater_installing".into());
            }
            let Some(flight) = state.flight.clone() else {
                return Ok(None);
            };
            if flight
                .reason
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_none()
            {
                *flight.reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(reason);
                state.dto.generation = state
                    .dto
                    .generation
                    .checked_add(1)
                    .filter(|n| *n <= MAX_GENERATION)
                    .ok_or("updater_generation_exhausted")?;
                state.dto.state = "cancelling".into();
                state.verified = None;
            }
            flight
        };
        flight.abort();
        Ok(Some(flight))
    }
    pub(super) fn cancel_and_join(&self, expected: u64) -> Result<Snapshot, String> {
        if let Some(flight) = self.request_cancel(expected, "cancelled")? {
            flight.wait();
        }
        Ok(self.status())
    }
    fn install_with(
        self: &Arc<Self>,
        expected: u64,
        work: impl FnOnce(Candidate, &[u8]) -> Result<(), &'static str> + Send + 'static,
        restart: impl FnOnce() + Send + 'static,
    ) -> Result<Snapshot, String> {
        let (candidate, bytes, snapshot) = {
            let mut state = self.state.lock().map_err(|_| "updater_unavailable")?;
            if state.closed {
                return Err("updater_shutdown".into());
            }
            if state.dto.reason == Some("rollback_failed") {
                return Err("updater_recovery_required".into());
            }
            if state.dto.generation != expected {
                return Err("updater_stale".into());
            }
            if state.installing || state.flight.is_some() {
                return Err("updater_busy".into());
            }
            if state.dto.state != "verified"
                || state.candidate.is_none()
                || state.verified.is_none()
            {
                return Err("updater_not_verified".into());
            }
            state.dto.generation = state
                .dto
                .generation
                .checked_add(1)
                .filter(|n| *n < MAX_GENERATION)
                .ok_or("updater_generation_exhausted")?;
            state.installing = true;
            state.dto.state = "installing".into();
            state.dto.reason = None;
            let bytes = state.verified.take().unwrap();
            (state.candidate.clone().unwrap(), bytes, state.dto.clone())
        };
        let controller = self.clone();
        std::thread::spawn(move || {
            // Installation is a critical section: exit joins it and cancellation cannot abandon it.
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(candidate, &bytes)))
                    .unwrap_or(Err("operation_failed"));
            let restart_now = {
                let mut state = controller.state.lock().unwrap_or_else(|p| p.into_inner());
                state.installing = false;
                if !state.closed {
                    if let Err(reason) = result {
                        state.verified = Some(bytes);
                        state.dto.state = "verified".into();
                        state.dto.reason = Some(match reason {
                            "running_tasks" => "running_tasks",
                            "owner_upgrade_required" => "owner_upgrade_required",
                            "owner_unavailable" => "owner_unavailable",
                            "manual_install_required" => "manual_install_required",
                            "rollback_failed" => "rollback_failed",
                            _ => "operation_failed",
                        });
                    } else {
                        state.dto.state = "restarting".into();
                    }
                }
                result.is_ok() && !state.closed
            };
            controller.install_done.notify_all();
            if restart_now {
                restart();
            }
        });
        Ok(snapshot)
    }
    #[cfg(test)]
    fn has_verified_bytes(&self) -> bool {
        self.state.lock().unwrap().verified.is_some()
    }
    pub(super) fn shutdown_and_join(&self) {
        let (generation, flight) = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            state.verified = None;
            (state.dto.generation, state.flight.clone())
        };
        let _ = self.request_cancel(generation, "cancelled");
        if let Some(flight) = flight {
            flight.wait();
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while state.installing {
            state = self
                .install_done
                .wait(state)
                .unwrap_or_else(|p| p.into_inner());
        }
        state.candidate = None;
        state.verified = None;
        state.dto.release = None;
    }
}

fn supported_build(bundle: Option<tauri::utils::config::BundleType>) -> bool {
    use tauri::utils::config::BundleType;
    matches!(
        bundle,
        Some(
            BundleType::App
                | BundleType::AppImage
                | BundleType::Deb
                | BundleType::Rpm
                | BundleType::Msi
                | BundleType::Nsis
        )
    )
}
// Called only by the normal GUI setup; the zero-window owner never registers this SDK.
pub(super) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let supported = cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )) && cfg!(any(target_arch = "x86_64", target_arch = "aarch64"))
        && supported_build(tauri::utils::platform::bundle_type());
    let controller = initialize_with(
        app.config().plugins.0.get("updater"),
        supported,
        true,
        &app.package_info().version.to_string(),
        |config| {
            app.plugin(
                tauri_plugin_updater::Builder::new()
                    .pubkey(config.sdk.pubkey.clone())
                    .build(),
            )
            .map_err(|_| "updater_sdk_unavailable".into())
        },
    )?;
    app.manage(controller);
    Ok(())
}
#[tauri::command]
pub(super) async fn updater_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    controller: tauri::State<'_, Arc<Controller>>,
) -> Result<Snapshot, String> {
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut snapshot = controller.status();
        if snapshot.state == "verified" {
            if snapshot.reason == Some("rollback_failed") {
                snapshot.install_blocked_reason = Some("manual_recovery_required");
                return snapshot;
            }
            let status = background_client(&app).and_then(|client| {
                client
                    .call("background_status", serde_json::json!({}))
                    .map_err(|_| "owner_unavailable")
            });
            snapshot.install_blocked_reason = status
                .and_then(|value| idle_install_permission(&value))
                .err();
            snapshot.install_allowed = snapshot.install_blocked_reason.is_none();
        }
        snapshot
    })
    .await
    .map_err(|_| "updater_unavailable".into())
}
#[tauri::command(rename_all = "snake_case")]
pub(super) fn updater_set_automatic_checks(
    controller: tauri::State<'_, Arc<Controller>>,
    expected_generation: u64,
    enabled: bool,
) -> Result<Snapshot, String> {
    controller.set_automatic(expected_generation, enabled)
}
#[tauri::command(rename_all = "snake_case")]
pub(super) fn updater_check(
    app: tauri::AppHandle,
    controller: tauri::State<'_, Arc<Controller>>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    use tauri_plugin_updater::UpdaterExt;
    controller.start(
        Operation::Check,
        expected_generation,
        Duration::from_secs(15),
        move |_, _| async move {
            let sdk = app
                .updater_builder()
                .timeout(Duration::from_secs(15))
                .configure_client(|builder| builder.https_only(true))
                .build()
                .map_err(|_| "updater_operation_failed")?;
            let Some(update) = sdk.check().await.map_err(|_| "updater_operation_failed")? else {
                return Ok(Outcome::NoUpdate);
            };
            candidate_from_update(update).map(Outcome::Available)
        },
    )
}
fn candidate_from_update(update: tauri_plugin_updater::Update) -> Result<Candidate, String> {
    let url = &update.download_url;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 2048
    {
        return Err("updater_artifact_invalid".into());
    }
    let release = Release {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        published: update.date.map(|date| date.to_string()),
    };
    if !release.valid() {
        return Err("updater_metadata_invalid".into());
    }
    Ok(Candidate {
        release,
        sdk: Some(Box::new(update)),
    })
}
#[tauri::command(rename_all = "snake_case")]
pub(super) fn updater_download(
    controller: tauri::State<'_, Arc<Controller>>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    controller.start(
        Operation::Download,
        expected_generation,
        Duration::from_secs(120),
        move |progress, candidate| async move {
            let mut update = candidate
                .and_then(|candidate| candidate.sdk)
                .ok_or("updater_candidate_unavailable")?;
            // SDK check returns an Update with timeout=None; preserve the configured HTTPS-only client.
            update.timeout = Some(Duration::from_secs(120));
            let progress = Arc::new(progress);
            let finished = progress.clone();
            let bytes = update
                .download(
                    move |bytes, total| {
                        let _ = progress.observe(bytes as u64, total);
                    },
                    move || finished.transfer_finished(),
                )
                .await
                .map_err(|_| "updater_operation_failed")?;
            // Only this SDK Ok boundary follows its signature/signed-version verification.
            Ok(Outcome::Verified(bytes))
        },
    )
}
#[tauri::command(rename_all = "snake_case")]
pub(super) async fn updater_cancel(
    controller: tauri::State<'_, Arc<Controller>>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.cancel_and_join(expected_generation))
        .await
        .map_err(|_| "updater_unavailable")?
}
fn background_client<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Arc<crate::background::Client>, &'static str> {
    use tauri::Manager;
    app.state::<crate::SessionManager>()
        .background_client
        .lock()
        .map_err(|_| "owner_unavailable")?
        .clone()
        .ok_or("owner_unavailable")
}
fn idle_install_permission(status: &serde_json::Value) -> Result<(), &'static str> {
    if status["updater_idle_install_v2"] != true {
        Err("owner_upgrade_required")
    } else if status["active_sessions"].as_u64() != Some(0) {
        Err("running_tasks")
    } else {
        Ok(())
    }
}
fn release_install_admission(closing: &std::sync::atomic::AtomicBool, reason: &str) -> bool {
    if reason == "rollback_failed" {
        return false;
    }
    closing.store(false, std::sync::atomic::Ordering::Release);
    reason != "running_tasks"
}
fn wait_for_owner(
    root: &std::path::Path,
    timeout: Duration,
) -> Result<crate::background::OwnerLock, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(owner) = crate::background::OwnerLock::acquire(root) {
            return Ok(owner);
        }
        if Instant::now() >= deadline {
            return Err("owner_unavailable");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn install_candidate(
    app: &tauri::AppHandle,
    candidate: Candidate,
    bytes: &[u8],
) -> Result<(), &'static str> {
    use tauri::Manager;
    let update = candidate.sdk.ok_or("operation_failed")?;
    let client = background_client(app)?;
    let status = client
        .call("background_status", serde_json::json!({}))
        .map_err(|_| "owner_unavailable")?;
    // The count is advisory. prepare_update repeats admission atomically with native session creation.
    idle_install_permission(&status)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "owner_unavailable")?
        .join("background");
    let manager = app.state::<crate::SessionManager>();
    let result = (|| {
        client
            .call("prepare_update", serde_json::json!({}))
            .map_err(|error| {
                if error == "running_tasks" {
                    "running_tasks"
                } else {
                    "owner_unavailable"
                }
            })?;
        manager
            .shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        // The v2 owner exits after preparing, even if its receipt is lost; no second RPC can strand it.
        // Keep the owner file lock through replacement so CLI clients cannot start the old binary.
        let _owner = wait_for_owner(&root, Duration::from_secs(5))?;
        crate::updater_install::install(&update, bytes)
    })();
    if let Err(reason) = result {
        if !release_install_admission(&manager.shutting_down, reason) {
            return result;
        }
        // A lost preparation receipt may still have committed the owner's exit.
        let Ok(owner) = wait_for_owner(&root, Duration::from_secs(5)) else {
            return result;
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        while manager
            .background_events
            .lock()
            .map(|poll| poll.is_running())
            .unwrap_or(true)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        drop(owner);
        // Installation was admitted only while idle, so reconnecting cannot rerun an interrupted task.
        let _ = crate::background::attach(app);
    }
    result
}
#[tauri::command(rename_all = "snake_case")]
pub(super) fn updater_install(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    controller: tauri::State<'_, Arc<Controller>>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("updater_main_window_required".into());
    }
    let restart = app.clone();
    controller.install_with(
        expected_generation,
        move |candidate, bytes| install_candidate(&app, candidate, bytes),
        move || restart.request_restart(),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn async_status_keeps_unavailable_busy_and_manual_recovery_install_gates() {
        use tauri::Manager;
        let root = std::env::temp_dir().join(format!(
            "yam-update-status-gates-{}",
            crate::next_session_id()
        ));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let server = crate::background::Server::start(&root, move |_| {
            observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(serde_json::json!({"active_sessions":1,"updater_idle_install_v2":true}))
        })
        .unwrap();
        let controller = controller();
        controller.state.lock().unwrap().dto.state = "verified".into();
        let app = tauri::test::mock_builder()
            .manage(crate::SessionManager::default())
            .manage(controller.clone())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let status = || {
            tauri::async_runtime::block_on(super::updater_status(app.handle().clone(), app.state()))
                .unwrap()
        };
        let unavailable = status();
        assert!(!unavailable.install_allowed);
        assert_eq!(
            unavailable.install_blocked_reason,
            Some("owner_unavailable")
        );
        *app.state::<crate::SessionManager>()
            .background_client
            .lock()
            .unwrap() = Some(Arc::new(
            crate::background::Client::new(crate::background::Descriptor::read(&root).unwrap())
                .unwrap(),
        ));
        let busy = status();
        assert!(!busy.install_allowed);
        assert_eq!(busy.install_blocked_reason, Some("running_tasks"));
        controller.state.lock().unwrap().dto.reason = Some("rollback_failed");
        let recovery = status();
        assert!(!recovery.install_allowed);
        assert_eq!(
            recovery.install_blocked_reason,
            Some("manual_recovery_required")
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn status_poll_yields_the_caller_while_owner_response_is_held() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        use tauri::Manager;
        let root =
            std::env::temp_dir().join(format!("yam-update-status-{}", crate::next_session_id()));
        let (entered, observed) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let held = Mutex::new(held);
        let server = crate::background::Server::start(&root, move |request| {
            assert_eq!(request.command, "background_status");
            entered.send(()).unwrap();
            held.lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            Ok(serde_json::json!({"active_sessions":0,"updater_idle_install_v2":true}))
        })
        .unwrap();
        let manager = crate::SessionManager::default();
        *manager.background_client.lock().unwrap() = Some(Arc::new(
            crate::background::Client::new(crate::background::Descriptor::read(&root).unwrap())
                .unwrap(),
        ));
        let controller = controller();
        controller.state.lock().unwrap().dto.state = "verified".into();
        let app = tauri::test::mock_builder()
            .manage(manager)
            .manage(controller)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let mut pending = Box::pin(super::updater_status(app.handle().clone(), app.state()));
        let start = Instant::now();
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "status polling must yield before waiting for the owner"
        );
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
        let result = tauri::async_runtime::block_on(pending).unwrap();
        assert_eq!(result.state, "verified");
        assert!(result.install_allowed);
        assert_eq!(result.install_blocked_reason, None);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn owner_wait_never_reconnects_to_an_owner_that_still_holds_the_lock() {
        let root =
            std::env::temp_dir().join(format!("yam-update-lock-{}", crate::next_session_id()));
        let owner = crate::background::OwnerLock::acquire(&root).unwrap();
        assert!(super::wait_for_owner(&root, std::time::Duration::ZERO).is_err());
        drop(owner);
        let retained = super::wait_for_owner(&root, std::time::Duration::ZERO).unwrap();
        assert!(crate::background::OwnerLock::acquire(&root).is_err());
        drop(retained);
        assert!(crate::background::OwnerLock::acquire(&root).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn install_failure_only_reopens_safe_admission_and_never_restarts_after_failed_rollback() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for (reason, reconnect, closed) in [
            ("rollback_failed", false, true),
            ("running_tasks", false, false),
            ("owner_unavailable", true, false),
            ("operation_failed", true, false),
        ] {
            let closing = AtomicBool::new(true);
            assert_eq!(
                super::release_install_admission(&closing, reason),
                reconnect
            );
            assert_eq!(closing.load(Ordering::Acquire), closed);
        }
    }
    #[test]
    fn idle_install_requires_self_exiting_owner_and_explicit_zero_tasks() {
        use serde_json::json;
        for (status, expected) in [
            (
                json!({"updater_idle_install_v1":true,"active_sessions":0}),
                Err("owner_upgrade_required"),
            ),
            (
                json!({"updater_idle_install_v2":"true","active_sessions":0}),
                Err("owner_upgrade_required"),
            ),
            (
                json!({"updater_idle_install_v2":true,"active_sessions":1}),
                Err("running_tasks"),
            ),
            (
                json!({"updater_idle_install_v2":true}),
                Err("running_tasks"),
            ),
            (
                json!({"updater_idle_install_v2":true,"active_sessions":0}),
                Ok(()),
            ),
        ] {
            assert_eq!(super::idle_install_permission(&status), expected);
        }
    }
    #[cfg(target_os = "macos")]
    struct ClosureT14Fixture {
        child: std::process::Child,
        root: std::path::PathBuf,
        endpoint: String,
    }
    #[cfg(target_os = "macos")]
    impl ClosureT14Fixture {
        fn new(mode: &str) -> Self {
            use std::io::BufRead;
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir()
                .join(format!("yam-updater-owned-{}", crate::next_session_id()));
            std::fs::create_dir(&root).unwrap();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut child = std::process::Command::new("python3")
                .arg(
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../tests/fixtures/updater_api.py"),
                )
                .args(["--mode", mode, "--root"])
                .arg(&root)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let mut ready = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&ready).unwrap();
            Self {
                child,
                root,
                endpoint: value["endpoint"].as_str().unwrap().into(),
            }
        }
    }
    #[cfg(target_os = "macos")]
    impl Drop for ClosureT14Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn closure_t14_real_sdk_verifies_bytes_and_signed_version_on_owned_https() {
        use tauri::Manager;
        use tauri_plugin_updater::UpdaterExt;
        tauri::async_runtime::block_on(async {
            for mode in [
                "valid",
                "changed-bytes",
                "wrong-version",
                "no-update",
                "held",
            ] {
                let fixture = ClosureT14Fixture::new(mode);
                let mut context = tauri::test::mock_context(tauri::test::noop_assets());
                context.config_mut().plugins.0.insert("updater".into(),serde_json::json!({
                    "pubkey":include_str!("../../tests/fixtures/updater-public.key").trim(),
                    "endpoints":[fixture.endpoint],"requireSignedVersion":true,"allowDowngrades":false
                }));
                let app = tauri::test::mock_builder()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                    .build(context)
                    .unwrap();
                // This private session accepts its ephemeral certificate; production client stays unchanged.
                let sdk = app
                    .updater_builder()
                    .timeout(Duration::from_secs(3))
                    .executable_path(fixture.root.join("YAM.app/Contents/MacOS/YAM"))
                    .configure_client(|builder| {
                        builder
                            .https_only(true)
                            .danger_accept_invalid_certs(true)
                            .no_proxy()
                    })
                    .build()
                    .unwrap();
                let found = sdk.check().await.unwrap();
                if mode == "no-update" {
                    assert!(found.is_none());
                    let receipts =
                        std::fs::read_to_string(fixture.root.join("requests.jsonl")).unwrap();
                    assert_eq!(receipts.lines().count(), 1);
                    continue;
                }
                let mut update = found.unwrap();
                update.timeout = Some(if mode == "held" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(3)
                });
                if mode == "valid" {
                    let candidate = candidate_from_update(update.clone()).unwrap();
                    assert_eq!(candidate.release.version, "7.8.9");
                    for url in [
                        "http://127.0.0.1/a",
                        "https://user:password@example.test/a",
                        "https://example.test/a#fragment",
                    ] {
                        let mut invalid = update.clone();
                        invalid.download_url = url.parse().unwrap();
                        assert_eq!(
                            candidate_from_update(invalid).err().unwrap(),
                            "updater_artifact_invalid"
                        );
                    }
                    let mut invalid = update.clone();
                    invalid.body = Some("x".repeat(8193));
                    assert_eq!(
                        candidate_from_update(invalid).err().unwrap(),
                        "updater_metadata_invalid"
                    );
                }
                let finished = std::sync::atomic::AtomicBool::new(false);
                let observed = std::sync::atomic::AtomicUsize::new(0);
                let result = update
                    .download(
                        |bytes, _| {
                            observed.fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
                        },
                        || finished.store(true, std::sync::atomic::Ordering::Release),
                    )
                    .await;
                assert_eq!(
                    finished.load(std::sync::atomic::Ordering::Acquire),
                    mode != "held"
                );
                assert_eq!(
                    observed.load(std::sync::atomic::Ordering::Relaxed) > 0,
                    mode != "held"
                );
                if mode == "valid" {
                    assert_eq!(
                        result.unwrap(),
                        include_bytes!("../../tests/fixtures/updater-artifact.txt")
                    );
                } else if mode == "held" {
                    assert!(
                        matches!(result,Err(tauri_plugin_updater::Error::Reqwest(ref error)) if error.is_timeout())
                    );
                } else {
                    assert!(
                        result.is_err(),
                        "SDK must reject {mode} after the transfer callback"
                    );
                }
                let controller = controller();
                let candidate = candidate_from_update(update).unwrap();
                controller
                    .start(
                        Operation::Check,
                        0,
                        Duration::from_secs(3),
                        move |_, _| async move { Ok(Outcome::Available(candidate)) },
                    )
                    .unwrap();
                await_state(&controller, "available");
                app.manage(controller.clone());
                updater_download(app.state(), controller.status().generation).unwrap();
                if mode == "held" {
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while std::fs::read_to_string(fixture.root.join("requests.jsonl"))
                        .unwrap()
                        .lines()
                        .count()
                        < 3
                        && Instant::now() < deadline
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    assert_eq!(
                        std::fs::read_to_string(fixture.root.join("requests.jsonl"))
                            .unwrap()
                            .lines()
                            .count(),
                        3
                    );
                    updater_cancel(app.state(), controller.status().generation)
                        .await
                        .unwrap();
                    assert_eq!(controller.status().state, "cancelled");
                    assert!(controller.state.lock().unwrap().flight.is_none());
                } else {
                    await_state(
                        &controller,
                        if mode == "valid" { "verified" } else { "error" },
                    );
                }
                assert_eq!(controller.has_verified_bytes(), mode == "valid");
                if mode != "valid" {
                    assert!(controller
                        .install_with(
                            controller.status().generation,
                            |_, _| panic!("unverified"),
                            || {}
                        )
                        .is_err());
                }
                controller.shutdown_and_join();
                let paths: Vec<_> = std::fs::read_to_string(fixture.root.join("requests.jsonl"))
                    .unwrap()
                    .lines()
                    .map(|row| {
                        serde_json::from_str::<serde_json::Value>(row).unwrap()["path"]
                            .as_str()
                            .unwrap()
                            .to_string()
                    })
                    .collect();
                assert_eq!(paths, ["/manifest", "/artifact", "/artifact"]);
            }
        });
    }

    #[test]
    fn closure_t14_exit_fences_and_joins_updater_before_detached_client_return() {
        let root =
            std::env::temp_dir().join(format!("yam-updater-exit-{}", crate::next_session_id()));
        let server =
            crate::background::Server::start(&root, |_| panic!("fixture never sends RPC")).unwrap();
        let manager = crate::SessionManager::default();
        *manager.background_client.lock().unwrap() = Some(Arc::new(
            crate::background::Client::new(crate::background::Descriptor::read(&root).unwrap())
                .unwrap(),
        ));
        let controller = controller();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        controller
            .start(
                Operation::Check,
                0,
                Duration::from_secs(3),
                move |_, _| async move {
                    entered.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(Outcome::NoUpdate)
                },
            )
            .unwrap();
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        let prevented = std::cell::Cell::new(0);
        let (exited, exit) = std::sync::mpsc::channel();
        let cleanup = std::cell::RefCell::new(None);
        assert!(crate::handle_gui_exit_with(
            &manager,
            Some(&controller),
            Some(7),
            false,
            || prevented.set(prevented.get() + 1),
            |owned, code| {
                *cleanup.borrow_mut() = Some(std::thread::spawn(move || {
                    owned.shutdown_and_join();
                    exited.send(code).unwrap();
                }));
            }
        ));
        let early = exit.recv_timeout(Duration::from_millis(50));
        assert!(crate::handle_gui_exit_with(
            &manager,
            Some(&controller),
            Some(7),
            false,
            || prevented.set(prevented.get() + 1),
            |_, _| panic!("duplicate exit cleanup")
        ));
        assert!(!manager
            .shutting_down
            .load(std::sync::atomic::Ordering::Acquire));
        release.send(()).unwrap();
        cleanup.into_inner().unwrap().join().unwrap();
        assert!(
            early.is_err(),
            "exit happened before the exact worker joined"
        );
        assert_eq!(exit.recv_timeout(Duration::from_secs(1)).unwrap(), 7);
        assert_eq!(prevented.get(), 2);
        assert!(controller
            .start(
                Operation::Check,
                controller.status().generation,
                Duration::from_secs(1),
                |_, _| async { panic!("closed controller cannot start") }
            )
            .is_err());
        assert!(crate::handle_gui_exit_with(
            &manager,
            Some(&controller),
            Some(7),
            false,
            || panic!("joined exit must not be prevented"),
            |_, _| panic!("joined exit has no cleanup")
        ));
        assert!(manager
            .shutting_down
            .load(std::sync::atomic::Ordering::Acquire));
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn t20_actual_exit_body_fences_worker_before_background_client_return() {
        let controller = controller();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        controller
            .start(
                Operation::Check,
                0,
                Duration::from_secs(2),
                move |_, _| async move {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(Outcome::Available(candidate()))
                },
            )
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let required = controller.prepare_exit();
        // Release our harmless fixture even on a semantic failure.
        release_tx.send(()).unwrap();
        controller.shutdown_and_join();
        assert!(required, "GUI exit must defer until exact worker join");
        assert!(controller.status().release.is_none());
        assert!(controller
            .start(
                Operation::Check,
                controller.status().generation,
                Duration::from_secs(1),
                |_, _| async { panic!("exit SDK access") }
            )
            .is_err());
    }
    #[test]
    fn t20_no_update_and_rejected_metadata_remain_finite() {
        let controller = controller();
        controller
            .start(Operation::Check, 0, Duration::from_secs(1), |_, _| async {
                Ok(Outcome::NoUpdate)
            })
            .unwrap();
        await_state(&controller, "upToDate");
        controller
            .start(
                Operation::Check,
                controller.status().generation,
                Duration::from_secs(1),
                |_, _| async {
                    let mut value = candidate();
                    value.release.notes = "x".repeat(8193);
                    Ok(Outcome::Available(value))
                },
            )
            .unwrap();
        await_state(&controller, "error");
        assert!(controller.status().release.is_none());
    }
    #[test]
    fn t20_acceptance_deadline_rejects_result_even_before_timer_runs() {
        let controller = controller();
        let flight = Arc::new(Flight {
            deadline: Instant::now() - Duration::from_millis(1),
            generation: 1,
            abort: Mutex::new(None),
            reason: Mutex::new(None),
            joined: Mutex::new(false),
            done: Condvar::new(),
        });
        {
            let mut state = controller.state.lock().unwrap();
            state.dto.generation = 1;
            state.dto.state = "checking".into();
            state.flight = Some(flight.clone());
        }
        controller.finish(&flight, Some(Outcome::Available(candidate())));
        assert_eq!(controller.status().state, "error");
        assert_eq!(controller.status().reason, Some("deadline_exceeded"));
        assert!(controller.status().release.is_none());
        assert!(*flight.joined.lock().unwrap());
    }
    #[test]
    fn t20_unknown_build_context_never_activates_sdk() {
        assert!(!supported_build(None));
        assert!(supported_build(Some(tauri::utils::config::BundleType::App)));
    }
    #[test]
    fn t20_exit_fence_rejects_completion_before_abort_callback() {
        let controller = controller();
        let flight = Arc::new(Flight {
            deadline: Instant::now() + Duration::from_secs(1),
            generation: 1,
            abort: Mutex::new(None),
            reason: Mutex::new(None),
            joined: Mutex::new(false),
            done: Condvar::new(),
        });
        {
            let mut state = controller.state.lock().unwrap();
            state.closed = true;
            state.dto.generation = 1;
            state.dto.state = "checking".into();
            state.flight = Some(flight.clone());
        }
        controller.finish(&flight, Some(Outcome::Available(candidate())));
        assert_eq!(controller.status().state, "cancelled");
        assert!(controller.status().release.is_none());
    }
    #[test]
    fn t20_generation_reserves_cancel_fence_and_preferences_are_read_only() {
        let controller = controller();
        {
            controller.state.lock().unwrap().dto.generation = MAX_GENERATION - 1;
        }
        assert!(controller
            .start(
                Operation::Check,
                MAX_GENERATION - 1,
                Duration::from_secs(1),
                |_, _| async { panic!("exhausted SDK access") }
            )
            .is_err());
        let before = controller.status();
        assert!(controller.set_automatic(0, false).is_err());
        let after = controller.set_automatic(before.generation, false).unwrap();
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.state, before.state);
        assert!(!after.automatic_checks);
    }
    fn controller() -> std::sync::Arc<Controller> {
        initialize_with(Some(&supplied()), true, true, "0.1.0", |_| Ok(())).unwrap()
    }
    fn await_state(controller: &Controller, state: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while controller.status().state != state && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(controller.status().state, state);
    }
    fn candidate() -> Candidate {
        Candidate {
            release: Release {
                version: "0.2.0".into(),
                notes: "plain release notes".into(),
                published: None,
            },
            sdk: None,
        }
    }
    #[test]
    fn t20_actual_initialization_missing_invalid_owner_never_registers() {
        let registrations = std::cell::Cell::new(0);
        let absent = initialize_with(None, true, true, "0.1.0", |_| {
            registrations.set(1);
            Ok(())
        })
        .unwrap();
        assert_eq!(absent.status().state, "unconfigured");
        assert_eq!(registrations.get(), 0);
        assert!(absent
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                |_, _| async {
                    panic!("unconfigured SDK lookup");
                }
            )
            .is_err());
        let invalid = serde_json::json!({"pubkey":"secret","unknown":"private"});
        let invalid = initialize_with(Some(&invalid), true, true, "0.1.0", |_| {
            panic!("invalid registration")
        })
        .unwrap();
        assert_eq!(invalid.status().state, "unsupported");
        let owner = initialize_with(Some(&supplied()), true, false, "0.1.0", |_| {
            panic!("owner registration")
        })
        .unwrap();
        assert_eq!(owner.status().state, "unsupported");
    }
    #[test]
    fn t20_single_worker_duplicate_and_stale_requests_precede_adapter() {
        let controller = controller();
        let first = controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                |_, _| std::future::pending::<Result<Outcome, String>>(),
            )
            .unwrap();
        assert_eq!(first.state, "checking");
        assert!(controller
            .start(
                Operation::Check,
                first.generation,
                std::time::Duration::from_secs(1),
                |_, _| async {
                    panic!("duplicate adapter");
                }
            )
            .is_err());
        assert!(controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                |_, _| async {
                    panic!("stale adapter");
                }
            )
            .is_err());
        assert_eq!(
            controller.cancel_and_join(first.generation).unwrap().state,
            "cancelled"
        );
    }
    #[test]
    fn t20_transfer_finished_and_signature_failure_never_verify() {
        let controller = controller();
        controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                |_, _| async { Ok(Outcome::Available(candidate())) },
            )
            .unwrap();
        await_state(&controller, "available");
        let generation = controller.status().generation;
        controller
            .start(
                Operation::Download,
                generation,
                std::time::Duration::from_secs(1),
                |progress, candidate| async move {
                    assert_eq!(candidate.unwrap().release.version, "0.2.0");
                    progress.observe(4, Some(4))?;
                    progress.transfer_finished();
                    Err("private signature/error sentinel".into())
                },
            )
            .unwrap();
        await_state(&controller, "error");
        assert!(!controller.has_verified_bytes());
        let dto = serde_json::to_string(&controller.status()).unwrap();
        assert!(!dto.contains("private signature"));
        assert_eq!(
            controller
                .install_with(
                    controller.status().generation,
                    |_, _| panic!("unverified"),
                    || {}
                )
                .unwrap_err(),
            "updater_not_verified"
        );
    }
    #[test]
    fn t20_observed_unknown_total_overflow_and_declared_limit_refuse_verified() {
        for declared in [None, Some(MAX_ARTIFACT_BYTES + 1)] {
            let controller = controller();
            controller
                .start(
                    Operation::Check,
                    0,
                    std::time::Duration::from_secs(1),
                    |_, _| async { Ok(Outcome::Available(candidate())) },
                )
                .unwrap();
            await_state(&controller, "available");
            let generation = controller.status().generation;
            controller
                .start(
                    Operation::Download,
                    generation,
                    std::time::Duration::from_secs(1),
                    move |progress, _| async move {
                        if declared.is_none() {
                            progress.observe(MAX_ARTIFACT_BYTES, None)?;
                        }
                        assert!(progress.observe(1, declared).is_err());
                        Ok(Outcome::Verified(vec![1]))
                    },
                )
                .unwrap();
            await_state(&controller, "error");
            assert_eq!(controller.status().reason, Some("artifact_too_large"));
            assert!(!controller.has_verified_bytes());
        }
    }
    #[test]
    fn t20_cancel_fences_late_success_until_exact_worker_join() {
        let controller = controller();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let first = controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                move |_, _| async move {
                    entered.send(()).unwrap();
                    blocked.recv().unwrap();
                    Ok(Outcome::Available(candidate()))
                },
            )
            .unwrap();
        ready
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        let cancel = controller.clone();
        let joining = std::thread::spawn(move || cancel.cancel_and_join(first.generation).unwrap());
        await_state(&controller, "cancelling");
        assert!(!joining.is_finished());
        assert!(controller
            .start(
                Operation::Check,
                controller.status().generation,
                std::time::Duration::from_secs(1),
                |_, _| async {
                    panic!("replacement before join");
                }
            )
            .is_err());
        release.send(()).unwrap();
        assert_eq!(joining.join().unwrap().state, "cancelled");
        assert!(controller.status().release.is_none());
        assert!(!controller.has_verified_bytes());
    }
    #[test]
    fn t20_deadline_is_cancelling_until_join_not_physical_deadline_claim() {
        let controller = controller();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_millis(20),
                move |_, _| async move {
                    entered.send(()).unwrap();
                    blocked.recv().unwrap();
                    Ok(Outcome::Available(candidate()))
                },
            )
            .unwrap();
        ready
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        await_state(&controller, "cancelling");
        release.send(()).unwrap();
        await_state(&controller, "error");
        assert_eq!(controller.status().reason, Some("deadline_exceeded"));
        assert!(controller.status().release.is_none());
    }
    #[test]
    fn t20_sdk_success_boundary_has_fixed_dto_and_requires_owner_admission() {
        let controller = controller();
        controller
            .start(
                Operation::Check,
                0,
                std::time::Duration::from_secs(1),
                |_, _| async { Ok(Outcome::Available(candidate())) },
            )
            .unwrap();
        await_state(&controller, "available");
        controller
            .start(
                Operation::Download,
                controller.status().generation,
                std::time::Duration::from_secs(1),
                |_, _| async { Ok(Outcome::Verified(vec![1, 2, 3])) },
            )
            .unwrap();
        await_state(&controller, "verified");
        assert!(controller.has_verified_bytes());
        controller
            .install_with(
                controller.status().generation,
                |_, _| Err("running_tasks"),
                || panic!("restart"),
            )
            .unwrap();
        await_state(&controller, "verified");
        let dto = serde_json::to_value(controller.status()).unwrap();
        assert_eq!(dto.as_object().unwrap().len(), 10);
        assert_eq!(dto["install_allowed"], false);
        for forbidden in [
            "sdk",
            "pubkey",
            "endpoints",
            "bytes",
            "signature",
            "url",
            "headers",
        ] {
            assert!(dto.get(forbidden).is_none());
        }
        controller.shutdown_and_join();
        assert!(!controller.has_verified_bytes());
    }

    use super::*;
    fn supplied() -> Value {
        serde_json::json!({"pubkey":"structurally supplied fixture key","endpoints":["https://updates.example.invalid/manifest.json"],"requireSignedVersion":true,"allowDowngrades":false})
    }
    #[test]
    fn t20_absent_configuration_is_normal_unconfigured() {
        assert!(configuration(None, true).unwrap().is_none());
    }
    #[test]
    fn t20_configuration_structural_key_and_fixed_transport_are_accepted() {
        assert!(configuration(Some(&supplied()), true).unwrap().is_some());
    }
    #[test]
    fn t20_configuration_rejects_unknown_insecure_empty_and_unsigned_inputs() {
        for (field, invalid) in [
            ("pubkey", Value::String(" ".into())),
            ("pubkey", Value::String("x".repeat(4097))),
            ("endpoints", serde_json::json!([])),
            (
                "endpoints",
                serde_json::json!(["http://updates.example.invalid/feed"]),
            ),
            (
                "endpoints",
                serde_json::json!(["https://user:secret@updates.example.invalid/feed"]),
            ),
            (
                "endpoints",
                serde_json::json!(["https://updates.example.invalid/feed#fragment"]),
            ),
            (
                "endpoints",
                serde_json::json!(vec!["https://updates.example.invalid/a"; 5]),
            ),
            ("requireSignedVersion", Value::Bool(false)),
            ("allowDowngrades", Value::Bool(true)),
            ("headers", serde_json::json!({"secret":"private"})),
        ] {
            let mut value = supplied();
            value[field] = invalid;
            assert_eq!(
                configuration(Some(&value), true).unwrap_err(),
                "updater_configuration_invalid"
            );
        }
    }
    #[test]
    fn t20_valid_configuration_unknown_platform_is_unsupported() {
        assert_eq!(
            configuration(Some(&supplied()), false).unwrap_err(),
            "updater_platform_unsupported"
        );
    }
    fn downloaded() -> Arc<Controller> {
        let controller = controller();
        controller
            .start(Operation::Check, 0, Duration::from_secs(1), |_, _| async {
                Ok(Outcome::Available(candidate()))
            })
            .unwrap();
        await_state(&controller, "available");
        controller
            .start(
                Operation::Download,
                controller.status().generation,
                Duration::from_secs(1),
                |_, _| async { Ok(Outcome::Verified(vec![1, 2, 3])) },
            )
            .unwrap();
        await_state(&controller, "verified");
        controller
    }
    #[test]
    fn update_install_requires_verified_generation_and_retries_failed_idle_admission() {
        let controller = controller();
        assert_eq!(
            controller
                .install_with(0, |_, _| panic!("unverified"), || {})
                .unwrap_err(),
            "updater_not_verified"
        );
        let controller = downloaded();
        let generation = controller.status().generation;
        assert_eq!(
            controller
                .install_with(generation - 1, |_, _| panic!("stale"), || {})
                .unwrap_err(),
            "updater_stale"
        );
        controller
            .install_with(
                generation,
                |_, bytes| {
                    assert_eq!(bytes, [1, 2, 3]);
                    Err("running_tasks")
                },
                || panic!("failed restart"),
            )
            .unwrap();
        await_state(&controller, "verified");
        assert!(controller.has_verified_bytes());
        assert_eq!(controller.status().reason, Some("running_tasks"));
        controller
            .install_with(controller.status().generation, |_, _| Ok(()), || {})
            .unwrap();
        await_state(&controller, "restarting");
    }
    #[test]
    fn update_install_cannot_be_cancelled_replaced_or_abandoned_during_exit() {
        let controller = downloaded();
        let (entered, ready) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        controller
            .install_with(
                controller.status().generation,
                move |_, _| {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                },
                || {},
            )
            .unwrap();
        ready.recv().unwrap();
        assert_eq!(controller.status().state, "installing");
        let generation = controller.status().generation;
        assert!(controller.cancel_and_join(generation).is_err());
        assert!(controller
            .start(
                Operation::Check,
                generation,
                Duration::from_secs(1),
                |_, _| async { panic!("replace") }
            )
            .is_err());
        assert!(controller.prepare_exit());
        let copy = controller.clone();
        let (done, joined) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            copy.shutdown_and_join();
            done.send(()).unwrap();
        });
        assert!(joined.recv_timeout(Duration::from_millis(20)).is_err());
        release.send(()).unwrap();
        joined.recv_timeout(Duration::from_secs(2)).unwrap();
        thread.join().unwrap();
    }
    #[test]
    fn update_failed_rollback_requires_manual_recovery_before_any_replacement_or_recheck() {
        let controller = downloaded();
        controller
            .install_with(
                controller.status().generation,
                |_, _| Err("rollback_failed"),
                || panic!("restart"),
            )
            .unwrap();
        await_state(&controller, "verified");
        let generation = controller.status().generation;
        assert_eq!(
            controller
                .install_with(generation, |_, _| panic!("retry"), || {})
                .unwrap_err(),
            "updater_recovery_required"
        );
        assert_eq!(
            controller
                .start(
                    Operation::Check,
                    generation,
                    Duration::from_secs(1),
                    |_, _| async { panic!("reset recovery") }
                )
                .unwrap_err(),
            "updater_recovery_required"
        );
    }
}
