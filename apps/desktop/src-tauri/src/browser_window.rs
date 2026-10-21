// Author: Jeff.Liu. One independent, untrusted browser window; no terminal ownership.
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Manager, State, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub(super) fn trusted_pair(webview: &str, window: &str) -> bool {
    matches!(
        (webview, window),
        ("main", "main") | ("terminal-secondary", "terminal-secondary")
    )
}

pub(super) fn invoke_gate<I>(
    webview: &str,
    window: &str,
    invoke: I,
    dispatch: impl FnOnce(I) -> bool,
    reject: impl FnOnce(I),
) -> bool {
    if trusted_pair(webview, window) {
        dispatch(invoke)
    } else {
        reject(invoke);
        true
    }
}

fn parse_url(value: &str, origins: &[Url]) -> Result<Url, String> {
    let invalid = || "browser_url_invalid".to_string();
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > 4096
    {
        return Err(invalid());
    }
    // Empty userinfo is still credentials syntax, although Url normalizes it away.
    if value.split_once("://").is_some_and(|(_, tail)| {
        tail.split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains('@'))
    }) {
        return Err(invalid());
    }
    let host = url.host_str().unwrap_or_default();
    if [
        "tauri.localhost",
        "asset.localhost",
        "ipc.localhost",
        "yam.localhost",
    ]
    .contains(&host)
    {
        return Err(invalid());
    }
    let loopback = |host: &str| matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if origins.iter().any(|origin| {
        origin.origin() == url.origin()
            || (loopback(host)
                && origin.host_str().is_some_and(loopback)
                && origin.port_or_known_default() == url.port_or_known_default())
    }) {
        return Err(invalid());
    }
    Ok(url)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Closed,
    Creating,
    Open,
    Closing,
}
#[derive(Clone, Serialize)]
pub(super) struct Snapshot {
    generation: u64,
    phase: Phase,
    url: Option<String>,
    loading: bool,
}
struct Lifecycle {
    generation: u64,
    phase: Phase,
    url: Option<String>,
    loading: bool,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: Phase::Closed,
            url: None,
            loading: false,
        }
    }
}
impl Lifecycle {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            generation: self.generation,
            phase: self.phase,
            url: self.url.clone(),
            loading: self.loading,
        }
    }
    fn begin(&mut self, expected: u64, url: &Url) -> Result<(u64, bool), String> {
        if expected != self.generation {
            return Err("browser_stale".into());
        }
        let creating = match self.phase {
            Phase::Closed => true,
            Phase::Open => false,
            _ => return Err("browser_busy".into()),
        };
        if creating {
            self.generation = self
                .generation
                .checked_add(1)
                .ok_or("browser_generation_exhausted")?;
            self.phase = Phase::Creating;
        }
        self.url = Some(url.to_string());
        self.loading = false;
        Ok((self.generation, creating))
    }
    fn built(&mut self, generation: u64, main_exists: bool) -> bool {
        if self.generation != generation || !matches!(self.phase, Phase::Creating | Phase::Closing)
        {
            return false;
        }
        if self.phase == Phase::Creating && main_exists {
            self.phase = Phase::Open;
            true
        } else {
            self.phase = Phase::Closing;
            false
        }
    }
    fn close(&mut self, generation: u64) -> Result<(), String> {
        if self.generation != generation {
            return Err("browser_stale".into());
        }
        if self.phase != Phase::Closed {
            self.phase = Phase::Closing;
        }
        Ok(())
    }
    fn destroyed(&mut self, generation: u64) {
        if self.generation == generation {
            self.phase = Phase::Closed;
            self.url = None;
            self.loading = false;
        }
    }
    fn build_failed(&mut self, generation: u64, exists: bool) {
        if self.generation == generation {
            if exists {
                self.phase = Phase::Closing;
            } else {
                self.destroyed(generation);
            }
        }
    }
    fn page(&mut self, generation: u64, loading: bool) {
        if self.generation == generation && matches!(self.phase, Phase::Creating | Phase::Open) {
            self.loading = loading;
        }
    }
}

struct Instance<R: tauri::Runtime = tauri::Wry> {
    life: Lifecycle,
    window: Option<WebviewWindow<R>>,
}
pub(super) struct Browser<R: tauri::Runtime = tauri::Wry> {
    inner: Arc<Mutex<Instance<R>>>,
}
impl<R: tauri::Runtime> Default for Instance<R> {
    fn default() -> Self {
        Self {
            life: Lifecycle::default(),
            window: None,
        }
    }
}
impl<R: tauri::Runtime> Default for Browser<R> {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Instance::default())),
        }
    }
}
const LABEL: &str = "browser-preview";
fn main_only(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" && webview.window().label() == "main" {
        Ok(())
    } else {
        Err("browser_control_forbidden".into())
    }
}
fn snapshot<R: tauri::Runtime>(browser: &Browser<R>) -> Result<Snapshot, String> {
    Ok(browser
        .inner
        .lock()
        .map_err(|_| "browser_unavailable")?
        .life
        .snapshot())
}
fn rules<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<Url> {
    let mut origins = Vec::new();
    if let Some(url) = &app.config().build.dev_url {
        origins.push(url.clone());
    }
    if let Some(main) = app
        .get_webview("main")
        .filter(|leaf| trusted_pair(leaf.label(), leaf.window().label()))
    {
        if let Ok(url) = main.url() {
            origins.push(url);
        }
    }
    origins
}
fn current_window<R: tauri::Runtime>(
    browser: &Browser<R>,
    generation: u64,
) -> Result<WebviewWindow<R>, String> {
    let state = browser.inner.lock().map_err(|_| "browser_unavailable")?;
    if state.life.generation != generation {
        return Err("browser_stale".into());
    }
    if state.life.phase != Phase::Open {
        return Err("browser_busy".into());
    }
    state
        .window
        .clone()
        .ok_or_else(|| "browser_unavailable".into())
}
fn show_current<R: tauri::Runtime>(
    app: &AppHandle<R>,
    browser: &Browser<R>,
    generation: u64,
) -> Result<(), String> {
    if app.get_window("main").is_none() {
        return Err("browser_unavailable".into());
    }
    let window = current_window(browser, generation)?;
    window.show().map_err(|_| "browser_show_failed")?;
    window.set_focus().map_err(|_| "browser_show_failed".into())
}
fn observe_window<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    inner: Arc<Mutex<Instance<R>>>,
    generation: u64,
) {
    window.on_window_event(move |event| observe_event(&inner, generation, event));
}
fn observe_event<R: tauri::Runtime>(
    inner: &Arc<Mutex<Instance<R>>>,
    generation: u64,
    event: &tauri::WindowEvent,
) {
    if let Ok(mut state) = inner.lock() {
        if state.life.generation != generation {
            return;
        }
        match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let _ = state.life.close(generation);
            }
            tauri::WindowEvent::Destroyed => {
                state.life.destroyed(generation);
                state.window = None;
            }
            _ => {}
        }
    }
}

fn deny_popup<R: tauri::Runtime>() -> tauri::webview::NewWindowResponse<R> {
    tauri::webview::NewWindowResponse::Deny
}
fn deny_download() -> bool {
    false
}
fn deny_permission() -> tauri::webview::PermissionResponse {
    tauri::webview::PermissionResponse::Deny
}
fn native_close(operation: impl FnOnce() -> tauri::Result<()>) -> Result<(), String> {
    operation().map_err(|_| "browser_close_failed".into())
}
fn create<R: tauri::Runtime>(
    app: &AppHandle<R>,
    generation: u64,
    url: Url,
    origins: Vec<Url>,
) -> Result<Snapshot, String> {
    let browser = app.state::<Browser<R>>();
    let page_state = browser.inner.clone();
    let navigation_state = browser.inner.clone();
    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("YAM Browser")
        .visible(false)
        .incognito(true)
        .devtools(false)
        .on_navigation(move |url| {
            if parse_url(url.as_str(), &origins).is_err() {
                return false;
            }
            if let Ok(mut state) = navigation_state.lock() {
                if state.life.generation == generation
                    && matches!(state.life.phase, Phase::Creating | Phase::Open)
                {
                    state.life.url = Some(url.to_string());
                }
            }
            true
        })
        .on_new_window(|_, _| deny_popup::<R>())
        .on_download(|_, _| deny_download())
        .on_permission_request(|_, _| deny_permission())
        .on_document_title_changed(|window, _| {
            let _ = window.set_title("YAM Browser");
        })
        .on_page_load(move |_, payload| {
            if let Ok(mut state) = page_state.lock() {
                state.life.page(
                    generation,
                    payload.event() == tauri::webview::PageLoadEvent::Started,
                );
            }
        })
        .build();
    let window = match result {
        Ok(window) => window,
        Err(_) => {
            // A fixed label collision is not evidence of destruction. Keep it reserved.
            let existing = app.get_webview_window(LABEL);
            if let Some(window) = &existing {
                observe_window(window, browser.inner.clone(), generation);
            }
            let mut state = browser.inner.lock().map_err(|_| "browser_unavailable")?;
            if state.life.generation == generation {
                state.life.build_failed(generation, existing.is_some());
                state.window = existing;
            }
            return Err("browser_create_failed".into());
        }
    };
    // Register before attachment/show, including canceled or main-destroyed builds.
    observe_window(&window, browser.inner.clone(), generation);
    let main_exists = app.get_window("main").is_some();
    let show = {
        let mut state = browser.inner.lock().map_err(|_| "browser_unavailable")?;
        if state.life.generation == generation
            && matches!(state.life.phase, Phase::Creating | Phase::Closing)
        {
            state.window = Some(window.clone());
        }
        state.life.built(generation, main_exists)
    };
    if show {
        show_current(app, &browser, generation)?;
    } else {
        native_close(|| window.close())?;
    }
    snapshot(&browser)
}

#[tauri::command]
pub(super) fn browser_status(
    webview: Webview,
    browser: State<'_, Browser>,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    snapshot(&browser)
}
#[tauri::command]
pub(super) async fn browser_open(
    app: AppHandle,
    webview: Webview,
    url: String,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    browser_open_with(app, url, expected_generation).await
}
async fn browser_open_with<R: tauri::Runtime>(
    app: AppHandle<R>,
    url: String,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    let origins = rules(&app);
    let url = parse_url(&url, &origins)?;
    let browser = app.state::<Browser<R>>();
    let (generation, creating) = browser
        .inner
        .lock()
        .map_err(|_| "browser_unavailable")?
        .life
        .begin(expected_generation, &url)?;
    if creating {
        tauri::async_runtime::spawn_blocking(move || create(&app, generation, url, origins))
            .await
            .map_err(|_| "browser_create_failed".to_string())?
    } else {
        let window = current_window(&browser, generation)?;
        window
            .navigate(url)
            .map_err(|_| "browser_navigation_failed")?;
        show_current(&app, &browser, generation)?;
        snapshot(&browser)
    }
}
#[tauri::command]
pub(super) fn browser_show(
    app: AppHandle,
    webview: Webview,
    browser: State<'_, Browser>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    show_current(&app, &browser, expected_generation)?;
    snapshot(&browser)
}
#[tauri::command]
pub(super) fn browser_reload(
    webview: Webview,
    browser: State<'_, Browser>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    current_window(&browser, expected_generation)?
        .reload()
        .map_err(|_| "browser_reload_failed")?;
    snapshot(&browser)
}
#[tauri::command]
pub(super) fn browser_close(
    webview: Webview,
    browser: State<'_, Browser>,
    expected_generation: u64,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    close(&browser, Some(expected_generation))?;
    snapshot(&browser)
}
fn close<R: tauri::Runtime>(browser: &Browser<R>, expected: Option<u64>) -> Result<(), String> {
    let window = {
        let mut state = browser.inner.lock().map_err(|_| "browser_unavailable")?;
        let generation = expected.unwrap_or(state.life.generation);
        state.life.close(generation)?;
        state.window.clone()
    };
    if let Some(window) = window {
        native_close(|| window.close())?;
    }
    Ok(())
}
fn cleanup(operation: impl FnOnce() -> Result<(), String>, warn: impl FnOnce(&str)) {
    if operation().is_err() {
        warn("browser_cleanup_unavailable");
    }
}
pub(super) fn main_destroyed(app: &AppHandle) {
    if let Some(browser) = app.try_state::<Browser>() {
        cleanup(|| close(&browser, None), |code| eprintln!("[YAM] {code}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn closure_t12_app(main: bool) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(Browser::<tauri::test::MockRuntime>::default());
        if main {
            WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
                .build()
                .unwrap();
        }
        app
    }

    #[test]
    fn closure_t12_open_uses_actual_builder_and_fences_stale_observer_events() {
        let app = closure_t12_app(true);
        let handle = app.handle().clone();
        let first = tauri::async_runtime::block_on(browser_open_with(
            handle.clone(),
            "https://example.test/first".into(),
            0,
        ))
        .unwrap();
        assert_eq!(first.phase, Phase::Open);
        assert_eq!(first.generation, 1);
        let window = app.get_webview_window(LABEL).unwrap();
        assert_eq!(window.label(), LABEL);
        assert_eq!(
            tauri::async_runtime::block_on(browser_open_with(
                handle.clone(),
                "https://example.test/stale".into(),
                0
            ))
            .err()
            .unwrap(),
            "browser_stale"
        );
        let next = tauri::async_runtime::block_on(browser_open_with(
            handle,
            "https://example.test/next".into(),
            1,
        ))
        .unwrap();
        assert_eq!(next.generation, 1);
        let browser = app.state::<Browser<tauri::test::MockRuntime>>();
        observe_event(&browser.inner, 0, &tauri::WindowEvent::Destroyed);
        assert_eq!(snapshot(&browser).unwrap().phase, Phase::Open);
        assert!(browser.inner.lock().unwrap().window.is_some());
        observe_event(&browser.inner, 1, &tauri::WindowEvent::Destroyed);
        assert_eq!(snapshot(&browser).unwrap().phase, Phase::Closed);
        assert!(browser.inner.lock().unwrap().window.is_none());
    }

    #[test]
    fn closure_t12_builder_failure_and_missing_main_keep_the_exact_reservation() {
        let app = closure_t12_app(true);
        WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        let result = tauri::async_runtime::block_on(browser_open_with(
            app.handle().clone(),
            "https://example.test/".into(),
            0,
        ));
        assert_eq!(result.err().unwrap(), "browser_create_failed");
        let browser = app.state::<Browser<tauri::test::MockRuntime>>();
        assert_eq!(snapshot(&browser).unwrap().phase, Phase::Closing);
        assert!(browser.inner.lock().unwrap().window.is_some());
        assert_eq!(
            tauri::async_runtime::block_on(browser_open_with(
                app.handle().clone(),
                "https://example.test/".into(),
                1
            ))
            .err()
            .unwrap(),
            "browser_busy"
        );
        let absent = closure_t12_app(false);
        let result = tauri::async_runtime::block_on(browser_open_with(
            absent.handle().clone(),
            "https://example.test/".into(),
            0,
        ))
        .unwrap();
        assert_eq!(result.phase, Phase::Closing);
        assert!(absent.get_webview_window(LABEL).is_some());
        let browser = absent.state::<Browser<tauri::test::MockRuntime>>();
        assert_eq!(
            show_current(absent.handle(), &browser, 1).err().unwrap(),
            "browser_unavailable"
        );
    }

    #[test]
    fn c01a_compiled_gate_trusted_identity_dispatches_once() {
        for label in ["main", "terminal-secondary"] {
            let dispatch = Cell::new(0);
            let reject = Cell::new(0);
            assert!(invoke_gate(
                label,
                label,
                (),
                |_| {
                    dispatch.set(dispatch.get() + 1);
                    true
                },
                |_| reject.set(reject.get() + 1)
            ));
            assert_eq!(dispatch.get(), 1);
            assert_eq!(reject.get(), 0);
        }
    }
    #[test]
    fn c01a_compiled_gate_rejects_remote_local_frames_and_forged_payload_identity() {
        for (webview, window) in [
            ("browser-preview", "browser-preview"),
            ("browser-preview", "main"),
            ("main", "browser-preview"),
            ("other", "other"),
            ("terminal-secondary", "main"),
        ] {
            for source in [
                "https://example.test/",
                "http://localhost:1420/iframe",
                "about:srcdoc",
            ] {
                let dispatch = Cell::new(0);
                let reject = Cell::new(0);
                let payload = (source, "main", "terminal-secondary");
                assert!(invoke_gate(
                    webview,
                    window,
                    payload,
                    |_| {
                        dispatch.set(dispatch.get() + 1);
                        false
                    },
                    |value| {
                        assert_eq!(value, payload);
                        reject.set(reject.get() + 1)
                    }
                ));
                assert_eq!(dispatch.get(), 0, "{webview}/{window}/{source}");
                assert_eq!(reject.get(), 1);
            }
        }
    }
    #[test]
    fn c01a_url_valid_http_localhost_and_exact_budget() {
        let origins = [Url::parse("http://localhost:1420/").unwrap()];
        for url in [
            "https://example.test/a?q=literal#part",
            "http://localhost:8123/",
            "http://127.0.0.1:8123/",
        ] {
            assert!(parse_url(url, &origins).is_ok());
        }
        let prefix = "https://example.test/";
        assert!(parse_url(
            &(prefix.to_owned() + &"a".repeat(4096 - prefix.len())),
            &origins
        )
        .is_ok());
    }
    #[test]
    fn c01a_url_rejects_credentials_controls_app_origins_and_utf8_budgets() {
        let origins = [
            Url::parse("http://localhost:1420/").unwrap(),
            Url::parse("tauri://localhost/").unwrap(),
        ];
        for value in [
            "",
            "file:///tmp/a",
            "data:text/plain,x",
            "javascript:1",
            "tauri://localhost/",
            "asset://localhost/",
            "https://user:pass@example.test/",
            "https://@example.test/",
            "https://example.test/\nsecret",
            "http://localhost:1420/local",
            "http://127.0.0.1:1420/",
            "https://tauri.localhost/a",
            "http://asset.localhost/a",
            "http://ipc.localhost/a",
        ] {
            assert!(parse_url(value, &origins).is_err(), "{value:?}");
        }
        assert!(parse_url(
            &("https://example.test/".to_owned() + &"a".repeat(4096)),
            &origins
        )
        .is_err());
        // Input may fit while percent-encoded canonical serialization exceeds the budget.
        assert!(parse_url(
            &("https://example.test/".to_owned() + &"é".repeat(800)),
            &origins
        )
        .is_err());
    }
    #[test]
    fn c01a_lifecycle_create_and_navigate_keep_single_generation() {
        let mut state = Lifecycle::default();
        let url = Url::parse("https://example.test/").unwrap();
        assert_eq!(state.begin(0, &url).unwrap(), (1, true));
        assert_eq!(state.phase, Phase::Creating);
        assert!(state.begin(1, &url).is_err());
        assert!(state.built(1, true));
        assert_eq!(state.phase, Phase::Open);
        assert_eq!(state.begin(1, &url).unwrap(), (1, false));
        assert!(state.begin(0, &url).is_err());
    }
    #[test]
    fn c01a_lifecycle_close_requested_keeps_label_until_destroyed_and_stale_events_ignore() {
        let mut state = Lifecycle::default();
        let url = Url::parse("https://example.test/").unwrap();
        state.begin(0, &url).unwrap();
        state.close(1).unwrap();
        assert_eq!(state.phase, Phase::Closing);
        assert!(!state.built(1, true));
        assert!(state.begin(1, &url).is_err());
        state.destroyed(0);
        assert_eq!(state.phase, Phase::Closing);
        state.destroyed(1);
        assert_eq!(state.phase, Phase::Closed);
        assert_eq!(state.begin(1, &url).unwrap(), (2, true));
        assert!(state.built(2, true));
        state.destroyed(1);
        state.page(1, true);
        assert_eq!(state.phase, Phase::Open);
        assert!(!state.loading);
        assert!(state.close(1).is_err());
        state.close(2).unwrap();
        state.close(2).unwrap();
        assert_eq!(state.phase, Phase::Closing);
    }
    #[test]
    fn c01a_lifecycle_main_gone_build_failure_duplicate_and_overflow_are_conservative() {
        let url = Url::parse("https://example.test/").unwrap();
        let mut state = Lifecycle::default();
        state.begin(0, &url).unwrap();
        assert!(!state.built(1, false));
        assert_eq!(state.phase, Phase::Closing);
        state.build_failed(1, true);
        assert_eq!(state.phase, Phase::Closing);
        state.build_failed(1, false);
        assert_eq!(state.phase, Phase::Closed);
        assert!(state.url.is_none());
        state.generation = u64::MAX;
        assert!(state.begin(u64::MAX, &url).is_err());
        assert_eq!(state.phase, Phase::Closed);
    }
    #[test]
    fn c01a_actual_denial_callbacks_and_native_close_error_keep_reservation() {
        assert!(matches!(
            deny_popup::<tauri::Wry>(),
            tauri::webview::NewWindowResponse::Deny
        ));
        assert!(!deny_download());
        assert!(matches!(
            deny_permission(),
            tauri::webview::PermissionResponse::Deny
        ));
        let mut life = Lifecycle::default();
        let url = Url::parse("https://example.test/").unwrap();
        life.begin(0, &url).unwrap();
        assert!(life.built(1, true));
        life.close(1).unwrap();
        let calls = Cell::new(0);
        let failed = native_close(|| {
            calls.set(calls.get() + 1);
            Err(std::io::Error::other("private raw URL must not escape").into())
        });
        assert_eq!(failed, Err("browser_close_failed".into()));
        assert_eq!(calls.get(), 1);
        assert_eq!(life.phase, Phase::Closing);
        assert!(life.begin(1, &url).is_err());
        native_close(|| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(life.phase, Phase::Closing);
        life.destroyed(1);
        assert_eq!(life.phase, Phase::Closed);
    }
    #[test]
    fn c01a_destroyed_before_build_attachment_is_not_resurrected() {
        let mut life = Lifecycle::default();
        let url = Url::parse("https://example.test/").unwrap();
        life.begin(0, &url).unwrap();
        life.close(1).unwrap();
        life.destroyed(1);
        assert!(!life.built(1, true));
        assert_eq!(life.phase, Phase::Closed);
        assert!(life.url.is_none());
    }
    #[test]
    fn c01a_main_cleanup_failure_reports_only_fixed_warning_once() {
        let warning = std::cell::RefCell::new(Vec::new());
        let calls = Cell::new(0);
        cleanup(
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            |code| warning.borrow_mut().push(code.to_owned()),
        );
        assert!(warning.borrow().is_empty());
        cleanup(
            || {
                calls.set(calls.get() + 1);
                Err("raw URL secret".into())
            },
            |code| warning.borrow_mut().push(code.to_owned()),
        );
        assert_eq!(*warning.borrow(), vec!["browser_cleanup_unavailable"]);
        assert_eq!(calls.get(), 2);
    }
}

#[cfg(test)]
mod native_identity_tests {
    use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl};

    #[tauri::command]
    fn identity_probe(window: Webview<tauri::test::MockRuntime>) -> String {
        window.window().label().to_owned()
    }

    #[test]
    fn native_identity_multi_child_command_argument_retains_parent() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![identity_probe])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let parent = tauri::WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let leaf = app.get_webview("main").unwrap();
        leaf.window()
            .add_child(
                WebviewBuilder::new("identity-guest", WebviewUrl::default()),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(10.0, 10.0),
            )
            .unwrap();
        assert!(app.get_webview_window("main").is_none());
        assert!(app.get_window("main").is_some());
        assert_eq!(leaf.window().label(), "main");
        let response = tauri::test::get_ipc_response(
            &parent,
            tauri::webview::InvokeRequest {
                cmd: "identity_probe".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<String>().unwrap());
        assert_eq!(response, Ok("main".to_owned()));
        drop(parent);
    }
}

#[cfg(test)]
mod native_identity_acl_tests {
    use tauri::{LogicalPosition, LogicalSize, Webview, WebviewBuilder, WebviewUrl};
    type Mock = tauri::test::MockRuntime;
    // Public test helper requires AsRef; this borrowed adapter does not alter IPC.
    struct Leaf<'a>(&'a Webview<Mock>);
    impl AsRef<Webview<Mock>> for Leaf<'_> {
        fn as_ref(&self) -> &Webview<Mock> {
            self.0
        }
    }
    #[tauri::command]
    fn open_url() -> &'static str {
        "opener-sentinel"
    }
    #[tauri::command]
    fn open() -> &'static str {
        "dialog-sentinel"
    }
    #[tauri::command]
    fn custom_sentinel() -> &'static str {
        "trusted-custom"
    }
    fn invoke(
        leaf: &Webview<Mock>,
        cmd: &str,
        url: &str,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let body = if cmd == "plugin:event|listen" {
            serde_json::json!({"event":"identity-test", "target":{"kind":"Any"}, "handler":42})
        } else {
            serde_json::json!({})
        };
        tauri::test::get_ipc_response(
            &Leaf(leaf),
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }
    #[test]
    fn native_identity_configured_acl_positive_controls_and_guest_denials() {
        let app = tauri::test::mock_builder()
            .invoke_handler(|invoke| {
                let leaf = invoke.message.webview_ref().label().to_owned();
                let parent = invoke.message.webview_ref().window().label().to_owned();
                super::invoke_gate(
                    &leaf,
                    &parent,
                    invoke,
                    tauri::generate_handler![custom_sentinel],
                    |invoke| invoke.resolver.reject("untrusted_webview"),
                )
            })
            .plugin(
                tauri::plugin::Builder::<Mock>::new("opener")
                    .invoke_handler(tauri::generate_handler![open_url])
                    .build(),
            )
            .plugin(
                tauri::plugin::Builder::<Mock>::new("dialog")
                    .invoke_handler(tauri::generate_handler![open])
                    .build(),
            )
            .build(super::super::generated_context())
            .unwrap();
        for label in ["main", "terminal-secondary"] {
            let handle = tauri::WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
                .build()
                .unwrap();
            let leaf: &Webview<Mock> = handle.as_ref();
            for cmd in [
                "custom_sentinel",
                "plugin:event|listen",
                "plugin:opener|open_url",
                "plugin:dialog|open",
            ] {
                assert!(
                    invoke(leaf, cmd, "tauri://localhost").is_ok(),
                    "trusted positive {label} {cmd}"
                );
            }
            let guest = leaf
                .window()
                .add_child(
                    WebviewBuilder::new(format!("guest-{label}"), WebviewUrl::default()),
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(10.0, 10.0),
                )
                .unwrap();
            for url in [
                "tauri://localhost",
                "http://localhost:1420",
                "https://example.com",
            ] {
                for cmd in [
                    "custom_sentinel",
                    "plugin:event|listen",
                    "plugin:opener|open_url",
                    "plugin:dialog|open",
                ] {
                    assert!(
                        invoke(&guest, cmd, url).is_err(),
                        "guest denial {label} {url} {cmd}"
                    );
                }
            }
        }
    }
}
