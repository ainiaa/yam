use crate::background_events::{lifecycle_due, poll_events_with_reconnect};

#[test]
fn event_poll_retries_failures_and_marks_recovery() {
    let page = serde_json::json!({"cursor":4,"gap":false,"events":[]});
    let mut calls = 0;
    let (result, recovered) = poll_events_with_reconnect(
        3,
        true,
        |_| {
            calls += 1;
            if calls == 1 {
                Err("disconnected".into())
            } else {
                Ok(page.clone())
            }
        },
        |_| {},
    );
    assert_eq!(calls, 2);
    assert!(recovered);
    assert_eq!(result.unwrap().cursor, 4);
}

#[test]
fn event_poll_stops_after_three_failed_attempts() {
    let mut calls = 0;
    let (result, recovered) = poll_events_with_reconnect(
        0,
        false,
        |_| {
            calls += 1;
            Err("unavailable".into())
        },
        |_| {},
    );
    assert_eq!(calls, 3);
    assert!(!recovered);
    assert!(matches!(result, Err(error) if error == "unavailable"));
}

#[test]
fn lifecycle_notifications_skip_paused_or_selected_foreground_sessions() {
    assert!(lifecycle_due(false, Some("s"), "s", false));
    assert!(!lifecycle_due(true, Some("s"), "s", false));
    assert!(!lifecycle_due(false, None, "s", true));
}
