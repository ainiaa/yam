use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{MainThreadMarker, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNErrorCode, UNMutableNotificationContent, UNNotification,
    UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(30);
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
            let link = response.notification().request().identifier().to_string();
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
            // Alert also presents on macOS 10.14/10.15; Banner/List require 11.
            #[allow(deprecated)]
            let options =
                UNNotificationPresentationOptions::Alert | UNNotificationPresentationOptions::Sound;
            completion.call((options,));
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
    title: String,
    body: String,
) -> Result<(), String> {
    // Create and release all SDK objects inside the worker's autorelease pool.
    std::thread::spawn(move || {
        autoreleasepool(|_| {
            require_app_bundle()?;
            if !DELEGATE_READY.load(Ordering::Acquire) {
                return Err("macOS notification delegate is not initialized".into());
            }
            let request = notification_request(&session_id, &title, &body)?;
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
            receiver
                .recv_timeout(CALLBACK_TIMEOUT)
                .map_err(|error| format!("Wait for macOS notification authorization: {error}"))??;
            let (sender, receiver) = mpsc::channel();
            let delivery = RcBlock::new(move |error: *mut NSError| {
                let result = delivery_result(unsafe { error.as_ref() });
                let _ = sender.send(result);
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&delivery));
            receiver
                .recv_timeout(CALLBACK_TIMEOUT)
                .map_err(|error| format!("Wait for macOS notification delivery: {error}"))?
        })
    })
    .join()
    .map_err(|_| "macOS notification worker panicked".to_string())?
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

fn notification_request(
    session_id: &str,
    title: &str,
    body: &str,
) -> Result<Retained<UNNotificationRequest>, String> {
    let identifier = format!("yam://session/{session_id}");
    if crate::session_id_from_link(&identifier).as_deref() != Some(session_id) {
        return Err("Invalid notification session ID".into());
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    Ok(
        UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_identifier_and_unicode_content_roundtrip() {
        objc2::rc::autoreleasepool(|_| {
            let title = "任务完成 <&>\"' 😀";
            let body = "请查看会话\nLine two\t終わり";
            let request = notification_request("s-abcdef-0", title, body).unwrap();
            assert_eq!(request.identifier().to_string(), "yam://session/s-abcdef-0");
            assert_eq!(request.content().title().to_string(), title);
            assert_eq!(request.content().body().to_string(), body);
            assert!(request.trigger().is_none());
            assert!(request.content().sound().is_some());
        });
    }

    #[test]
    fn empty_content_is_supported_and_malformed_ids_are_rejected() {
        objc2::rc::autoreleasepool(|_| {
            let request = notification_request("s-1", "", "").unwrap();
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
                    notification_request(id, "title", "body").is_err(),
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
