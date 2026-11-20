use std::collections::{HashMap, HashSet};

const LEASE_MILLIS: u64 = 3000;

#[derive(Default)]
pub(super) struct InputLeases {
    pub(super) owners: HashMap<String, (String, u64)>,
    external: HashSet<String>,
}

impl InputLeases {
    pub(super) fn available(&self, session: &str, client: &str, now: u64) -> bool {
        !self.owners.get(session).is_some_and(|(owner, last)| {
            owner != client && now.saturating_sub(*last) <= LEASE_MILLIS
        })
    }

    #[cfg(test)]
    pub(super) fn t11_owner_count(&self) -> usize {
        self.owners.len()
    }

    pub(super) fn claim(&mut self, session: &str, client: &str, now: u64) -> Result<(), String> {
        if self.owners.get(session).is_some_and(|(owner, last)| {
            owner != client && now.saturating_sub(*last) <= LEASE_MILLIS
        }) {
            return Err("Another desktop currently controls this terminal".into());
        }
        if self
            .owners
            .get(session)
            .is_none_or(|(owner, last)| owner != client || now.saturating_sub(*last) > LEASE_MILLIS)
        {
            self.external.remove(session);
        }
        self.owners.insert(session.into(), (client.into(), now));
        Ok(())
    }

    pub(super) fn take_control(&mut self, session: &str, client: &str, now: u64) {
        self.external.remove(session);
        self.owners.insert(session.into(), (client.into(), now));
    }

    pub(super) fn take_external(&mut self, session: &str, client: &str, now: u64) {
        self.take_control(session, client, now);
        self.external.insert(session.into());
    }

    pub(super) fn release(&mut self, session: &str, client: &str) {
        if self
            .owners
            .get(session)
            .is_some_and(|(owner, _)| owner == client)
        {
            self.owners.remove(session);
            self.external.remove(session);
        }
    }

    pub(super) fn external_owner(&self, session: &str, client: &str, now: u64) -> bool {
        self.external.contains(session)
            && self.owners.get(session).is_some_and(|(owner, last)| {
                owner == client && now.saturating_sub(*last) <= LEASE_MILLIS
            })
    }

    pub(super) fn headless_queries(&self, session: &str, now: u64) -> bool {
        !self.external.contains(session)
            || self
                .owners
                .get(session)
                .is_none_or(|(_, last)| now.saturating_sub(*last) > LEASE_MILLIS)
    }

    pub(super) fn heartbeat(&mut self, client: &str, now: u64) {
        for (owner, last) in self.owners.values_mut() {
            if owner == client {
                *last = now;
            }
        }
    }
}
