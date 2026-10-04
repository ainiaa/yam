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
    install_blocked_reason: &'static str,
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
}
pub(super) struct Controller {
    state: Mutex<State>,
    exit_cleanup: std::sync::atomic::AtomicBool,
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
                install_blocked_reason: "install_unavailable",
            },
            candidate: None,
            verified: None,
            flight: None,
            closed: false,
        }),
        exit_cleanup: std::sync::atomic::AtomicBool::new(false),
    }))
}
impl Controller {
    // Shared by the real ExitRequested body. Fence before any background-client return.
    pub(super) fn prepare_exit(&self) -> bool {
        let (generation, pending) = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            state.verified = None;
            (state.dto.generation, state.flight.is_some())
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
            if !state.dto.configured {
                return Err("updater_not_configured".into());
            }
            if expected != state.dto.generation {
                return Err("updater_stale".into());
            }
            if state.flight.is_some() {
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
    pub(super) fn install(&self) -> Result<Snapshot, String> {
        Err("updater_install_unavailable".into())
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
pub(super) fn updater_status(controller: tauri::State<'_, Arc<Controller>>) -> Snapshot {
    controller.status()
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
            Ok(Outcome::Available(Candidate {
                release,
                sdk: Some(Box::new(update)),
            }))
        },
    )
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
#[tauri::command]
pub(super) fn updater_install(
    controller: tauri::State<'_, Arc<Controller>>,
) -> Result<Snapshot, String> {
    controller.install()
}

#[cfg(test)]
mod tests {
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
            controller.install().unwrap_err(),
            "updater_install_unavailable"
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
    fn t20_sdk_success_boundary_has_fixed_dto_and_install_always_denied() {
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
        assert_eq!(
            controller.install().unwrap_err(),
            "updater_install_unavailable"
        );
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
}
