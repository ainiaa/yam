use super::input_leases::InputLeases;

#[test]
fn input_lease_rejects_foreign_owner_until_timeout_then_allows_takeover() {
    let mut leases = InputLeases::default();
    leases.claim("session", "first", 10).unwrap();
    assert!(!leases.available("session", "second", 3010));
    assert!(leases.claim("session", "second", 3010).is_err());
    assert!(leases.available("session", "second", 3011));
    leases.claim("session", "second", 3011).unwrap();
    assert_eq!(leases.owners["session"], ("second".into(), 3011));
}

#[test]
fn external_control_blocks_headless_queries_until_timeout_or_owner_release() {
    let mut leases = InputLeases::default();
    leases.take_external("session", "desktop", 1);
    assert!(!leases.headless_queries("session", 3001));
    assert!(leases.external_owner("session", "desktop", 3001));
    assert!(leases.headless_queries("session", 3002));
    leases.take_external("session", "desktop", 4000);
    leases.release("session", "other");
    assert!(leases.external_owner("session", "desktop", 4001));
    leases.release("session", "desktop");
    assert!(leases.headless_queries("session", 4001));
    assert!(!leases.external_owner("session", "desktop", 4001));
}

#[test]
fn heartbeat_refreshes_only_matching_owner_and_new_owner_clears_external_flag() {
    let mut leases = InputLeases::default();
    leases.take_external("one", "desktop", 1);
    leases.claim("two", "desktop", 1).unwrap();
    leases.take_external("three", "other", 1);
    leases.heartbeat("desktop", 2500);
    assert_eq!(leases.owners["two"].1, 2500);
    assert_eq!(leases.owners["three"].1, 1);
    assert!(leases.headless_queries("three", 3002));
    leases.claim("one", "different", 5501).unwrap();
    assert!(!leases.external_owner("one", "desktop", 5501));
}
