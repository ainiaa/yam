use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{
    MainThreadMarker, NSBundle, NSError, NSObject, NSObjectProtocol, NSString, NSUUID,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNErrorCode, UNMutableNotificationContent, UNNotification,
    UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
    UNTimeIntervalNotificationTrigger, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
#[test]
fn closure_t15_callback_wait_discards_late_and_repeated_delivery_results() {
    let (sender, receiver) = mpsc::channel();
    assert!(
        wait_callback(receiver, Duration::from_millis(1), "authorization")
            .unwrap_err()
            .starts_with("Wait for macOS notification authorization:")
    );
    assert!(sender.send(Ok(())).is_err());
    let (sender, receiver) = mpsc::channel();
    sender.send(Err("denied".into())).unwrap();
    sender.send(Ok(())).unwrap();
    assert_eq!(
        wait_callback(receiver, Duration::from_millis(10), "authorization").unwrap_err(),
        "denied"
    );
    assert!(sender.send(Ok(())).is_err());
    let (sender, receiver) = mpsc::channel();
    sender.send(Ok(())).unwrap();
    wait_callback(receiver, Duration::from_millis(10), "delivery").unwrap();
    assert!(sender.send(Err("late failure".into())).is_err());
}
fn presentation_options() -> UNNotificationPresentationOptions {
    // YAM requires macOS 13.5; request the modern foreground banner explicitly.
    UNNotificationPresentationOptions::Banner
        | UNNotificationPresentationOptions::List
        | UNNotificationPresentationOptions::Sound
}
static DELEGATE_READY: AtomicBool = AtomicBool::new(false);

struct DelegateIvars {
    app: tauri::AppHandle,
}

define_class!(
    // NSObject has no subclassing requirements. Only immutable, thread-safe
    // AppHandle state is accessed by notification callbacks.
    #[unsafe(super(NSObject))]
    #[name = "YAMUserNotificationCenterDelegate"]
    #[ivars = DelegateIvars]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            struct Completion<'a>(&'a DynBlock<dyn Fn()>);
            impl Drop for Completion<'_> {
                fn drop(&mut self) {
                    self.0.call(());
                }
            }
            let _completion = Completion(completion);
            if &*response.actionIdentifier() == unsafe { UNNotificationDismissActionIdentifier } {
                return;
            }
            let link = notification_link(&response.notification().request());
            if let Err(error) = crate::route_notification_link(&self.ivars().app, &link) {
                eprintln!("[YAM] Notification activation failed: {error}");
            }
        }

        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((presentation_options(),));
        }
    }
);

thread_local! {
    // UNUserNotificationCenter.delegate is weak. The main thread retains this
    // delegate for its entire event-loop lifetime, including cold-start clicks.
    static DELEGATE: RefCell<Option<Retained<NotificationDelegate>>> = const { RefCell::new(None) };
}

/// Must run on the main thread before the application finishes launching.
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("macOS notification delegate must initialize on the main thread".into());
    }
    require_app_bundle()?;
    autoreleasepool(|_| {
        let allocated = NotificationDelegate::alloc().set_ivars(DelegateIvars { app: app.clone() });
        let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(allocated), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));
        DELEGATE_READY.store(true, Ordering::Release);
    });
    Ok(())
}

pub fn send(
    _app: tauri::AppHandle,
    session_id: String,
    project: String,
    title: String,
    body: String,
    kind: String,
) -> Result<(), String> {
    // Create and release all SDK objects inside the worker's autorelease pool.
    std::thread::spawn(move || {
        autoreleasepool(|_| {
            require_app_bundle()?;
            if !DELEGATE_READY.load(Ordering::Acquire) {
                return Err("macOS notification delegate is not initialized".into());
            }
            let grouping = (kind != "test").then_some((
                project.as_str(),
                notification_lane(&kind),
                crate::unix_timestamp(),
            ));
            let request = notification_request(&session_id, &title, &body, grouping)?;
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let (sender, receiver) = mpsc::channel();
            let authorization = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                // The framework keeps NSError alive for the callback duration.
                let result = authorization_result(granted.as_bool(), unsafe { error.as_ref() });
                let _ = sender.send(result);
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &authorization,
            );
            wait_callback(receiver, CALLBACK_TIMEOUT, "authorization")?;
            let (sender, receiver) = mpsc::channel();
            let delivery = RcBlock::new(move |error: *mut NSError| {
                let result = delivery_result(unsafe { error.as_ref() });
                let _ = sender.send(result);
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&delivery));
            wait_callback(receiver, CALLBACK_TIMEOUT, "delivery")
        })
    })
    .join()
    .map_err(|_| "macOS notification worker panicked".to_string())?
}

fn wait_callback(
    receiver: mpsc::Receiver<Result<(), String>>,
    timeout: Duration,
    stage: &str,
) -> Result<(), String> {
    receiver
        .recv_timeout(timeout)
        .map_err(|error| format!("Wait for macOS notification {stage}: {error}"))?
}

fn authorization_result(granted: bool, error: Option<&NSError>) -> Result<(), String> {
    if let Some(error) = error {
        if error.domain().to_string() == "UNErrorDomain"
            && error.code() == UNErrorCode::NotificationsNotAllowed.0
        {
            return Err("macOS notification permission was denied".into());
        }
        Err(format!(
            "macOS notification authorization failed: {}",
            error.localizedDescription()
        ))
    } else if !granted {
        Err("macOS notification permission was denied".into())
    } else {
        Ok(())
    }
}

fn delivery_result(error: Option<&NSError>) -> Result<(), String> {
    if let Some(error) = error {
        if error.domain().to_string() == "UNErrorDomain"
            && error.code() == UNErrorCode::NotificationsNotAllowed.0
        {
            return Err("macOS notification permission was denied".into());
        }
        Err(format!(
            "macOS notification delivery failed: {}",
            error.localizedDescription()
        ))
    } else {
        Ok(())
    }
}

fn require_app_bundle() -> Result<(), String> {
    // Calling currentNotificationCenter outside an app bundle raises an
    // Objective-C exception; reject unbundled development/test executables.
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return Err("macOS notifications require the installed YAM.app bundle".into());
    }
    Ok(())
}

fn notification_link(request: &UNNotificationRequest) -> String {
    if let Some(link) = request
        .content()
        .targetContentIdentifier()
        .filter(|value| !value.is_empty())
    {
        return link.to_string();
    }
    let link = request.content().threadIdentifier().to_string();
    if link.is_empty() {
        // Notifications delivered by older YAM versions stored the target as the ID.
        request.identifier().to_string()
    } else {
        link
    }
}

fn notification_lane(kind: &str) -> &str {
    match kind {
        "succeeded" | "response_finished" => "completion",
        "failed" => "failure",
        "needs_permission" => "permission",
        _ => "attention",
    }
}

fn notification_request(
    session_id: &str,
    title: &str,
    body: &str,
    grouping: Option<(&str, &str, u64)>,
) -> Result<Retained<UNNotificationRequest>, String> {
    let identifier = format!("yam://session/{session_id}");
    if crate::session_id_from_link(&identifier).as_deref() != Some(session_id) {
        return Err("Invalid notification session ID".into());
    }
    let content = UNMutableNotificationContent::new();
    content.setTargetContentIdentifier(Some(&NSString::from_str(&identifier)));
    let (request_id, thread_id, trigger) = if let Some((project, lane, now)) = grouping {
        if project.is_empty() {
            return Err("Invalid notification project".into());
        }
        let thread = format!("yam.project.{:x}", Sha256::digest(project.as_bytes()));
        // OS-owned requests survive GUI exit; replace pending updates within a ten-second bucket.
        let id = format!("{thread}.{lane}.{}", now / 10);
        (
            NSString::from_str(&id),
            NSString::from_str(&thread),
            Some(UNTimeIntervalNotificationTrigger::triggerWithTimeInterval_repeats(2.0, false)),
        )
    } else {
        (
            NSUUID::UUID().UUIDString(),
            NSString::from_str("yam.test"),
            None,
        )
    };
    content.setThreadIdentifier(&thread_id);
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    // The latest merged request keeps its own navigation target, independent of project grouping.
    Ok(
        UNNotificationRequest::requestWithIdentifier_content_trigger(
            &request_id,
            &content,
            trigger.as_deref().map(|value| &**value),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grouping_identity_is_separate_from_notification_navigation() {
        autoreleasepool(|_| {
            let request = notification_request("s-one", "Project · Task", "Done", None).unwrap();
            assert_eq!(
                request
                    .content()
                    .targetContentIdentifier()
                    .unwrap()
                    .to_string(),
                "yam://session/s-one"
            );
            assert!(!request
                .content()
                .threadIdentifier()
                .to_string()
                .starts_with("yam://session/"));
        });
    }

    #[test]
    fn project_bursts_replace_one_pending_request_and_keep_the_latest_target() {
        autoreleasepool(|_| {
            let first = notification_request(
                "s-one",
                "first",
                "one",
                Some(("/a/project", "completion", 100)),
            )
            .unwrap();
            let latest = notification_request(
                "s-two",
                "latest",
                "two",
                Some(("/a/project", "completion", 109)),
            )
            .unwrap();
            let next = notification_request(
                "s-two",
                "next",
                "three",
                Some(("/a/project", "completion", 110)),
            )
            .unwrap();
            let other = notification_request(
                "s-three",
                "other",
                "four",
                Some(("/b/project", "completion", 100)),
            )
            .unwrap();
            assert_eq!(first.identifier(), latest.identifier());
            assert_ne!(latest.identifier(), next.identifier());
            assert_eq!(
                first.content().threadIdentifier(),
                next.content().threadIdentifier()
            );
            assert_ne!(
                first.content().threadIdentifier(),
                other.content().threadIdentifier()
            );
            assert!(!first
                .content()
                .threadIdentifier()
                .to_string()
                .contains("/a/project"));
            assert_eq!(notification_link(&latest), "yam://session/s-two");
            assert_eq!(latest.content().body().to_string(), "two");
            let trigger = latest.trigger().unwrap();
            assert!(!trigger.repeats());
            let interval: f64 = unsafe { msg_send![&*trigger, timeInterval] };
            assert_eq!(interval, 2.0);
            for kind in ["failure", "permission", "attention"] {
                let important = notification_request(
                    "s-one",
                    "important",
                    "attention",
                    Some(("/a/project", kind, 100)),
                )
                .unwrap();
                assert_ne!(important.identifier(), first.identifier());
                assert_eq!(
                    important.content().threadIdentifier(),
                    first.content().threadIdentifier()
                );
            }
            assert!(
                notification_request("s-one", "title", "body", Some(("", "completion", 100)))
                    .is_err()
            );
        });
    }

    #[test]
    fn grouping_lanes_preserve_failures_permissions_and_unexpected_stops() {
        assert_eq!(
            notification_lane("succeeded"),
            notification_lane("response_finished")
        );
        for kind in [
            "failed",
            "needs_permission",
            "idle_attention",
            "needs_attention",
            "stopped",
        ] {
            assert_ne!(notification_lane(kind), notification_lane("succeeded"));
        }
        assert_ne!(
            notification_lane("failed"),
            notification_lane("needs_permission")
        );
    }

    #[test]
    fn request_identifier_and_unicode_content_roundtrip() {
        objc2::rc::autoreleasepool(|_| {
            let title = "任务完成 <&>\"' 😀";
            let body = "请查看会话\nLine two\t終わり";
            let request = notification_request("s-abcdef-0", title, body, None).unwrap();
            let second = notification_request("s-abcdef-0", title, body, None).unwrap();
            assert_ne!(request.identifier(), second.identifier());
            assert_eq!(request.content().threadIdentifier().to_string(), "yam.test");
            assert_eq!(notification_link(&request), "yam://session/s-abcdef-0");
            assert_eq!(notification_link(&second), "yam://session/s-abcdef-0");
            let legacy = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str("yam://session/s-old"),
                &UNMutableNotificationContent::new(),
                None,
            );
            assert_eq!(notification_link(&legacy), "yam://session/s-old");
            let old_content = UNMutableNotificationContent::new();
            old_content.setThreadIdentifier(&NSString::from_str("yam://session/s-previous"));
            let previous = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSUUID::UUID().UUIDString(),
                &old_content,
                None,
            );
            assert_eq!(notification_link(&previous), "yam://session/s-previous");
            assert_eq!(request.content().title().to_string(), title);
            assert_eq!(request.content().body().to_string(), body);
            assert!(request.trigger().is_none());
            assert!(request.content().sound().is_some());
        });
    }

    #[test]
    fn empty_content_is_supported_and_malformed_ids_are_rejected() {
        objc2::rc::autoreleasepool(|_| {
            let request = notification_request("s-1", "", "", None).unwrap();
            assert_eq!(request.content().title().to_string(), "");
            assert_eq!(request.content().body().to_string(), "");
            for id in [
                "",
                "s-",
                "../secret",
                "s-1/other",
                "s-1?query",
                "s-1#fragment",
                "s-%22",
                "会话",
            ] {
                assert!(
                    notification_request(id, "title", "body", None).is_err(),
                    "accepted {id:?}"
                );
            }
        });
    }

    #[test]
    fn authorization_and_delivery_propagate_denial_and_system_errors() {
        autoreleasepool(|_| {
            assert!(authorization_result(true, None).is_ok());
            assert!(authorization_result(false, None)
                .unwrap_err()
                .contains("denied"));
            assert!(delivery_result(None).is_ok());
            let denied = unsafe {
                NSError::errorWithDomain_code_userInfo(
                    &NSString::from_str("UNErrorDomain"),
                    1,
                    None,
                )
            };
            assert!(authorization_result(false, Some(&denied))
                .unwrap_err()
                .contains("permission was denied"));
            assert!(delivery_result(Some(&denied))
                .unwrap_err()
                .contains("permission was denied"));
            let error = unsafe {
                NSError::errorWithDomain_code_userInfo(
                    &NSString::from_str("YAMNotificationTest"),
                    42,
                    None,
                )
            };
            let description = error.localizedDescription().to_string();
            assert!(authorization_result(true, Some(&error))
                .unwrap_err()
                .contains(&description));
            assert!(delivery_result(Some(&error))
                .unwrap_err()
                .contains(&description));
        });
    }
}

#[cfg(test)]
#[test]
fn foreground_presentation_requests_banner_list_and_sound_on_supported_macos() {
    let options = presentation_options();
    assert!(options.contains(UNNotificationPresentationOptions::Banner));
    assert!(options.contains(UNNotificationPresentationOptions::List));
    assert!(options.contains(UNNotificationPresentationOptions::Sound));
}
