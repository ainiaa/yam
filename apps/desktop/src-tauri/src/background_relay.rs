use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RelayEvent {
    pub name: String,
    pub payload: String,
    pub(super) sequence: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct RelayPage {
    pub cursor: u64,
    pub gap: bool,
    pub events: Vec<RelayEvent>,
}

#[derive(Default)]
pub(super) struct Relay {
    pub(super) events: VecDeque<RelayEvent>,
    pub(super) bytes: usize,
    pub(super) sequence: u64,
    pub(super) lost: u64,
}

impl Relay {
    pub(super) fn push(&mut self, name: &str, payload: String) {
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

    pub(super) fn poll(&self, cursor: u64) -> RelayPage {
        RelayPage {
            cursor: self.sequence,
            gap: cursor < self.lost || cursor > self.sequence,
            events: self
                .events
                .iter()
                .filter(|event| event.sequence > cursor)
                .cloned()
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Relay;

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
}
