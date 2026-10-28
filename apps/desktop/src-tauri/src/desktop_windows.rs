// Author: Jeff.Liu. Exactly two GUI slots; same-GUI moves without owner-wire change.
use super::{
    AgentLaunch, CreateSessionReply, LogSnapshot, SessionManager, ShellLaunch, TerminalFrame,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
const ERROR: &str = "terminal_window_unavailable";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Slot {
    Main,
    #[serde(rename = "terminal-secondary")]
    Secondary,
}
impl Slot {
    fn parse(label: &str) -> Result<Self, String> {
        match label {
            "main" => Ok(Self::Main),
            "terminal-secondary" => Ok(Self::Secondary),
            _ => Err(ERROR.into()),
        }
    }
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Secondary => "terminal-secondary",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Main => 0,
            Self::Secondary => 1,
        }
    }
}
// Keep test vocabulary concise without exposing arbitrary window names.
#[derive(Default)]
struct WindowSlot {
    epoch: u64,
    alive: bool,
    focused: bool,
    selected: Option<String>,
    requested: Option<String>,
}
struct Claim {
    slot: Slot,
    epoch: Option<u64>,
    generation: u64,
    inflight: usize,
    closed: bool,
    unknown: bool,
    parser_uncertain: bool,
    parser_instance: Option<String>,
}
// Author: Jeff.Liu. Finite same-GUI move API; unresolved IPC is never guessed complete.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum MoveReply {
    Pending { receipt: MoveReceipt },
    Resume { generation: u64 },
    Unavailable,
    Busy,
    Stale,
    Completed { receipt: MoveReceipt },
}
#[derive(Clone, Debug, Serialize)]
pub(super) struct MoveReceipt {
    token: u64,
    session_id: String,
    source: Slot,
    source_epoch: u64,
    source_generation: u64,
    target: Slot,
    target_epoch: u64,
    target_generation: u64,
    appearance: serde_json::Value,
    phase: String,
    source_destroyed: bool,
    target_destroyed: bool,
    accepted: bool,
}
struct StartReservation {
    slot: Slot,
    epoch: u64,
    dispatched: bool,
}
pub(super) struct Table {
    slots: [WindowSlot; 2],
    initialized: bool,
    owners: HashMap<String, Slot>,
    claims: HashMap<String, Claim>,
    ended: HashSet<String>,
    starts: HashMap<u64, StartReservation>,
    unknown_starts: HashSet<u64>,
    next_start: u64,
    next_claim: u64,
    pub(super) conflict: bool,
    context_sending: bool,
    context_pending: bool,
    restore_blocked: bool,
    preference_revision: u64,
    file_jobs: [bool; 2],
    moves: [Option<MoveReceipt>; 2],
    resumes: [Option<(String, u64, u64, u64)>; 2],
    next_move: u64,
}
impl Default for Table {
    fn default() -> Self {
        Self {
            slots: [
                WindowSlot {
                    epoch: 1,
                    alive: true,
                    ..Default::default()
                },
                WindowSlot::default(),
            ],
            initialized: false,
            owners: HashMap::new(),
            claims: HashMap::new(),
            ended: HashSet::new(),
            starts: HashMap::new(),
            unknown_starts: HashSet::new(),
            next_start: 0,
            next_claim: 0,
            conflict: false,
            context_sending: false,
            context_pending: false,
            restore_blocked: false,
            preference_revision: 0,
            file_jobs: [false; 2],
            moves: [None, None],
            resumes: [None, None],
            next_move: 0,
        }
    }
}
impl Table {
    fn pending_move(&self, id: &str) -> bool {
        self.moves
            .iter()
            .flatten()
            .any(|r| r.session_id == id && r.phase != "completed")
    }
    fn move_index(&self, token: u64) -> Option<usize> {
        self.moves.iter().position(|r| {
            r.as_ref().is_some_and(|r| {
                r.token == token
                    && (r.phase != "completed"
                        || self.claims.get(&r.session_id).is_some_and(|claim| {
                            claim.slot == r.target
                                && claim.epoch == Some(r.target_epoch)
                                && claim.generation == r.target_generation
                                && !claim.closed
                        }))
            })
        })
    }
    fn move_reply(&self, index: usize) -> MoveReply {
        let receipt = self.moves[index].as_ref().unwrap().clone();
        if receipt.phase == "completed" {
            MoveReply::Completed { receipt }
        } else {
            MoveReply::Pending { receipt }
        }
    }
    fn appearance_valid(value: &serde_json::Value) -> bool {
        let Some(v) = value.as_object() else {
            return false;
        };
        if v.len() != 3
            || !v
                .keys()
                .all(|k| ["fontFamily", "fontSize", "theme"].contains(&k.as_str()))
        {
            return false;
        }
        let Some(font) = v.get("fontFamily").and_then(|v| v.as_str()) else {
            return false;
        };
        !font.trim().is_empty()
            && font.encode_utf16().count() <= 200
            && !font
                .chars()
                .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
            && v.get("fontSize")
                .and_then(|v| v.as_u64())
                .is_some_and(|n| (10..=24).contains(&n))
            && v.get("theme")
                .and_then(|v| v.as_str())
                .is_some_and(|v| ["app", "dark", "light", "solarized", "system"].contains(&v))
    }
    fn move_source_valid(&self, slot: Slot, epoch: u64, id: &str, generation: u64) -> bool {
        self.valid(slot, epoch).is_ok()
            && self.owner(id) == Some(slot)
            && self.claims.get(id).is_some_and(|c| {
                c.slot == slot
                    && c.epoch == Some(epoch)
                    && c.generation == generation
                    && generation > 0
                    && c.inflight == 0
                    && !c.closed
                    && !c.unknown
                    && !c.parser_uncertain
                    && c.parser_instance.is_some()
            })
    }
    fn prepare_move(
        &mut self,
        slot: Slot,
        epoch: u64,
        id: &str,
        generation: u64,
        appearance: serde_json::Value,
    ) -> MoveReply {
        if let Some(r) = self.moves[slot.index()].as_ref() {
            if r.session_id == id
                && r.source_epoch == epoch
                && r.source_generation == generation
                && r.phase != "completed"
            {
                return self.move_reply(slot.index());
            }
        }
        if !Self::appearance_valid(&appearance)
            || !self.move_source_valid(slot, epoch, id, generation)
        {
            return MoveReply::Unavailable;
        }
        let target = if slot == Slot::Main {
            Slot::Secondary
        } else {
            Slot::Main
        };
        if self
            .moves
            .iter()
            .flatten()
            .any(|r| r.phase != "completed" && (r.source == slot || r.target == target))
        {
            return MoveReply::Busy;
        }
        let target_epoch = self.slots[target.index()].epoch;
        if self.valid(target, target_epoch).is_err() {
            return MoveReply::Unavailable;
        }
        let Some(token) = self
            .next_move
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
        else {
            return MoveReply::Unavailable;
        };
        self.next_move = token;
        self.claims.get_mut(id).unwrap().closed = true;
        self.moves[slot.index()] = Some(MoveReceipt {
            token,
            session_id: id.into(),
            source: slot,
            source_epoch: epoch,
            source_generation: generation,
            target,
            target_epoch,
            target_generation: 0,
            appearance,
            phase: "awaiting_source".into(),
            source_destroyed: false,
            target_destroyed: false,
            accepted: false,
        });
        self.resumes[slot.index()] = None;
        self.move_reply(slot.index())
    }
    fn reconcile_move(&mut self, slot: Slot, epoch: u64, id: &str, generation: u64) -> MoveReply {
        if self.valid(slot, epoch).is_err() {
            return MoveReply::Unavailable;
        }
        if let Some(r) = self.moves[slot.index()].as_ref() {
            if r.session_id == id && r.source_epoch == epoch && r.source_generation == generation {
                return self.move_reply(slot.index());
            }
        }
        if let Some((old_id, old_epoch, old_gen, new_gen)) = &self.resumes[slot.index()] {
            if old_id == id
                && *old_epoch == epoch
                && *old_gen == generation
                && self.claims.get(id).is_some_and(|c| {
                    c.generation == *new_gen
                        && !c.closed
                        && !c.unknown
                        && !c.parser_uncertain
                        && c.inflight == 0
                })
            {
                return MoveReply::Resume {
                    generation: *new_gen,
                };
            }
        }
        if !self.move_source_valid(slot, epoch, id, generation) || self.pending_move(id) {
            return MoveReply::Unavailable;
        }
        let Some(next) = self
            .next_claim
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
        else {
            return MoveReply::Unavailable;
        };
        self.next_claim = next;
        self.claims.get_mut(id).unwrap().generation = next;
        self.resumes[slot.index()] = Some((id.into(), epoch, generation, next));
        MoveReply::Resume { generation: next }
    }
    fn commit_move_ack(&mut self, index: usize) -> MoveReply {
        let r = self.moves[index].as_ref().unwrap().clone();
        if r.phase != "awaiting_source" {
            return self.move_reply(index);
        }
        if self.valid(r.target, r.target_epoch).is_err() {
            return MoveReply::Unavailable;
        }
        if !self.claims.get(&r.session_id).is_some_and(|c| {
            c.slot == r.source
                && c.epoch == Some(r.source_epoch)
                && c.generation == r.source_generation
                && c.closed
                && c.inflight == 0
                && !c.unknown
                && !c.parser_uncertain
        }) {
            return MoveReply::Unavailable;
        }
        let Some(next) = self
            .next_claim
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
        else {
            return MoveReply::Unavailable;
        };
        self.next_claim = next;
        let c = self.claims.get_mut(&r.session_id).unwrap();
        c.slot = r.target;
        c.epoch = Some(r.target_epoch);
        c.generation = next;
        c.parser_instance = None;
        self.owners.insert(r.session_id.clone(), r.target);
        let receipt = self.moves[index].as_mut().unwrap();
        receipt.phase = "awaiting_target".into();
        receipt.target_generation = next;
        self.move_reply(index)
    }
    fn ack_move(
        &mut self,
        slot: Slot,
        epoch: u64,
        id: &str,
        generation: u64,
        token: u64,
    ) -> MoveReply {
        let Some(index) = self.move_index(token) else {
            return MoveReply::Stale;
        };
        let r = self.moves[index].as_ref().unwrap();
        if self.valid(slot, epoch).is_err()
            || r.source != slot
            || r.source_epoch != epoch
            || r.session_id != id
            || r.source_generation != generation
        {
            return MoveReply::Stale;
        }
        self.commit_move_ack(index)
    }
    fn accept_move(&mut self, slot: Slot, epoch: u64, token: u64) -> MoveReply {
        let Some(index) = self.move_index(token) else {
            return MoveReply::Stale;
        };
        let r = self.moves[index].as_ref().unwrap().clone();
        if self.valid(slot, epoch).is_err() || r.target != slot || r.target_epoch != epoch {
            return MoveReply::Stale;
        }
        if r.phase == "awaiting_source" {
            return MoveReply::Unavailable;
        }
        if !self.claims.get(&r.session_id).is_some_and(|c| {
            c.slot == slot
                && c.epoch == Some(epoch)
                && c.generation == r.target_generation
                && c.inflight == 0
                && !c.unknown
                && !c.parser_uncertain
        }) {
            return MoveReply::Unavailable;
        }
        if r.phase != "completed" {
            self.claims.get_mut(&r.session_id).unwrap().closed = false;
            self.moves[index].as_mut().unwrap().accepted = true;
        }
        self.move_reply(index)
    }
    fn complete_move(&mut self, slot: Slot, epoch: u64, token: u64) -> MoveReply {
        let Some(index) = self.move_index(token) else {
            return MoveReply::Stale;
        };
        let r = self.moves[index].as_ref().unwrap().clone();
        if self.valid(slot, epoch).is_err() || r.target != slot || r.target_epoch != epoch {
            return MoveReply::Stale;
        }
        if r.phase == "completed" {
            return self.move_reply(index);
        }
        if !r.accepted
            || !self.claims.get(&r.session_id).is_some_and(|c| {
                c.slot == slot
                    && c.epoch == Some(epoch)
                    && c.generation == r.target_generation
                    && !c.closed
                    && c.inflight == 0
                    && !c.unknown
                    && !c.parser_uncertain
            })
        {
            return MoveReply::Unavailable;
        }
        self.moves[index].as_mut().unwrap().phase = "completed".into();
        self.move_reply(index)
    }
    fn recover_move(&mut self, slot: Slot, epoch: u64, token: u64) -> MoveReply {
        let Some(index) = self.move_index(token) else {
            return MoveReply::Stale;
        };
        let r = self.moves[index].as_ref().unwrap().clone();
        if self.valid(slot, epoch).is_err()
            || (slot != r.source && slot != r.target)
            || r.phase == "completed"
            || !r.target_destroyed
        {
            return MoveReply::Unavailable;
        }
        let target_epoch = self.slots[r.target.index()].epoch;
        if target_epoch == r.target_epoch || self.valid(r.target, target_epoch).is_err() {
            return MoveReply::Unavailable;
        }
        if !self.claims.get(&r.session_id).is_some_and(|c| {
            c.inflight == 0
                && !c.unknown
                && !c.parser_uncertain
                && if r.phase == "awaiting_source" {
                    c.slot == r.source
                        && c.epoch == Some(r.source_epoch)
                        && c.generation == r.source_generation
                } else {
                    c.slot == r.target
                        && c.epoch == Some(r.target_epoch)
                        && c.generation == r.target_generation
                }
        }) {
            return MoveReply::Unavailable;
        }
        let Some(next_token) = self
            .next_move
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
        else {
            return MoveReply::Unavailable;
        };
        let next_generation = if r.phase == "awaiting_target" {
            let Some(n) = self
                .next_claim
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
            else {
                return MoveReply::Unavailable;
            };
            Some(n)
        } else {
            None
        };
        self.next_move = next_token;
        let receipt = self.moves[index].as_mut().unwrap();
        receipt.token = next_token;
        receipt.target_epoch = target_epoch;
        receipt.target_destroyed = false;
        receipt.accepted = false;
        if let Some(n) = next_generation {
            self.next_claim = n;
            let c = self.claims.get_mut(&r.session_id).unwrap();
            c.epoch = Some(target_epoch);
            c.generation = n;
            c.closed = true;
            c.parser_instance = None;
            receipt.target_generation = n;
        }
        if r.source_destroyed && r.phase == "awaiting_source" {
            self.commit_move_ack(index)
        } else {
            self.move_reply(index)
        }
    }
    pub(super) fn note_destroyed(&mut self, slot: Slot, epoch: u64) {
        for index in 0..2 {
            let Some(r) = self.moves[index].as_mut() else {
                continue;
            };
            if r.phase == "completed" {
                continue;
            }
            if r.target == slot && r.target_epoch == epoch {
                r.target_destroyed = true;
            }
            if r.source == slot && r.source_epoch == epoch {
                r.source_destroyed = true;
                let _ = self.commit_move_ack(index);
            }
        }
    }
    fn query_move(&self, slot: Slot, epoch: u64, id: Option<&str>) -> MoveReply {
        if self.valid(slot, epoch).is_err() {
            return MoveReply::Unavailable;
        }
        for index in 0..2 {
            if let Some(r) = &self.moves[index] {
                if self.move_index(r.token) == Some(index)
                    && (r.phase != "completed" || id.is_some())
                    && id.is_none_or(|id| id == r.session_id)
                    && ((r.source == slot && r.source_epoch == epoch)
                        || (r.target == slot && (r.target_epoch == epoch || r.target_destroyed)))
                {
                    return self.move_reply(index);
                }
            }
        }
        MoveReply::Stale
    }
    fn valid(&self, slot: Slot, epoch: u64) -> Result<(), String> {
        let current = &self.slots[slot.index()];
        if !self.initialized || !current.alive || current.epoch != epoch {
            Err(ERROR.into())
        } else {
            Ok(())
        }
    }
    pub(super) fn note_status(&mut self, id: &str, status: &str) {
        if !super::is_terminal(status) {
            return;
        }
        if self.claims.contains_key(id) {
            self.ended.insert(id.into());
        } else {
            self.owners.remove(id);
            self.ended.remove(id);
        }
    }
    fn owner(&self, id: &str) -> Option<Slot> {
        self.owners.get(id).copied()
    }
    fn capacity(&self) -> usize {
        self.claims.len() + self.starts.len()
    }
    fn bootstrap(
        &mut self,
        main: &[String],
        secondary: &[String],
        valid: &[String],
    ) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        let valid: HashSet<_> = valid.iter().collect();
        let main: HashSet<_> = main.iter().filter(|id| valid.contains(id)).collect();
        let secondary: HashSet<_> = secondary.iter().filter(|id| valid.contains(id)).collect();
        if main.union(&secondary).count() > 16 {
            self.restore_blocked = true;
            return Err("terminal_restore_limit".into());
        }
        self.conflict = main.intersection(&secondary).next().is_some();
        for (ids, slot) in [(&main, Slot::Main), (&secondary, Slot::Secondary)] {
            for id in ids {
                if self.owners.contains_key(id.as_str()) {
                    continue;
                }
                self.owners.insert((*id).clone(), slot);
                self.claims.insert(
                    (*id).clone(),
                    Claim {
                        slot,
                        epoch: None,
                        generation: 0,
                        inflight: 0,
                        closed: false,
                        unknown: false,
                        parser_uncertain: false,
                        parser_instance: None,
                    },
                );
            }
        }
        self.initialized = true;
        Ok(())
    }
    fn open_secondary(&mut self) -> Result<u64, String> {
        let slot = &mut self.slots[1];
        if !slot.alive {
            slot.epoch = slot.epoch.checked_add(1).ok_or(ERROR)?;
            slot.alive = true;
        }
        Ok(slot.epoch)
    }
    fn attach(&mut self, slot: Slot, epoch: u64, id: &str) -> Result<u64, String> {
        self.valid(slot, epoch)?;
        if self.pending_move(id) {
            return Err("terminal_move_pending".into());
        }
        if self.owner(id) != Some(slot) {
            return Err("terminal_foreign_window".into());
        }
        if let Some(claim) = self.claims.get(id) {
            if claim.closed || claim.epoch.is_some_and(|old| old != epoch) {
                return Err("terminal_view_draining".into());
            }
            if claim.epoch == Some(epoch) && claim.generation > 0 {
                return Ok(claim.generation);
            }
        }
        if !self.claims.contains_key(id) && self.capacity() >= 16 {
            return Err("terminal_view_limit".into());
        }
        let generation = self.next_claim.checked_add(1).ok_or(ERROR)?;
        self.next_claim = generation;
        self.claims.insert(
            id.into(),
            Claim {
                slot,
                epoch: Some(epoch),
                generation,
                inflight: 0,
                closed: false,
                unknown: false,
                parser_uncertain: false,
                parser_instance: None,
            },
        );
        Ok(generation)
    }
    fn start_unknown(&mut self, ticket: u64) {
        if self.starts.contains_key(&ticket) {
            self.unknown_starts.insert(ticket);
        }
    }
    fn start_blocked(&self, slot: Slot, epoch: u64) -> bool {
        self.unknown_starts.iter().any(|ticket| {
            self.starts
                .get(ticket)
                .is_some_and(|start| start.slot == slot && start.epoch == epoch)
        })
    }
    fn check_start(&mut self, slot: Slot, epoch: u64, ticket: u64) -> Result<(), String> {
        self.valid(slot, epoch)?;
        let start = self.starts.get(&ticket).ok_or(ERROR)?;
        if start.slot != slot || start.epoch != epoch {
            return Err(ERROR.into());
        }
        if start.dispatched {
            return Err(if self.unknown_starts.contains(&ticket) {
                "terminal_start_outcome_unknown"
            } else {
                ERROR
            }
            .into());
        }
        if self.start_blocked(slot, epoch) {
            if !self.unknown_starts.contains(&ticket) {
                self.starts.remove(&ticket);
            }
            return Err("terminal_start_outcome_unknown".into());
        }
        self.starts.get_mut(&ticket).ok_or(ERROR)?.dispatched = true;
        Ok(())
    }
    fn reserve(&mut self, slot: Slot, epoch: u64) -> Result<u64, String> {
        self.valid(slot, epoch)?;
        if self.start_blocked(slot, epoch) {
            return Err("terminal_start_outcome_unknown".into());
        }
        if self.capacity() >= 16 {
            return Err("terminal_view_limit".into());
        }
        let id = self.next_start.checked_add(1).ok_or(ERROR)?;
        self.next_start = id;
        self.starts.insert(
            id,
            StartReservation {
                slot,
                epoch,
                dispatched: false,
            },
        );
        Ok(id)
    }
    fn reserve_reopen(
        &mut self,
        slot: Slot,
        epoch: u64,
        source: Option<&str>,
    ) -> Result<u64, String> {
        self.valid(slot, epoch)?;
        let released = source
            .filter(|id| {
                self.owner(id) == Some(slot)
                    && !self.pending_move(id)
                    && self.claims.get(*id).is_some_and(|claim| {
                        claim.slot == slot
                            && claim.epoch.is_none()
                            && claim.generation == 0
                            && claim.inflight == 0
                            && !claim.closed
                            && !claim.unknown
                            && !claim.parser_uncertain
                    })
            })
            .and_then(|id| self.claims.remove(id).map(|claim| (id.to_string(), claim)));
        let result = self.reserve(slot, epoch);
        if result.is_err() {
            if let Some((id, claim)) = released {
                self.claims.insert(id, claim);
            }
        }
        result
    }
    fn reopened(&mut self, ticket: u64, id: &str) -> Result<(), String> {
        if !self.starts.contains_key(&ticket) {
            return Err(ERROR.into());
        }
        if self.owners.contains_key(id) {
            self.starts.remove(&ticket);
            self.unknown_starts.remove(&ticket);
            Ok(())
        } else {
            self.created(ticket, id)
        }
    }
    fn created(&mut self, ticket: u64, id: &str) -> Result<(), String> {
        let start = self.starts.remove(&ticket).ok_or(ERROR)?;
        let (slot, epoch) = (start.slot, start.epoch);
        self.unknown_starts.remove(&ticket);
        if self.owners.contains_key(id) {
            self.starts.insert(ticket, start);
            return Err(ERROR.into());
        }
        self.owners.insert(id.into(), slot);
        let closed = !self.slots[slot.index()].alive || self.slots[slot.index()].epoch != epoch;
        if !closed {
            self.claims.insert(
                id.into(),
                Claim {
                    slot,
                    epoch: Some(epoch),
                    generation: 0,
                    inflight: 0,
                    closed: false,
                    unknown: false,
                    parser_uncertain: false,
                    parser_instance: None,
                },
            );
        }
        Ok(())
    }
    fn begin(&mut self, slot: Slot, epoch: u64, id: &str, generation: u64) -> Result<(), String> {
        self.valid(slot, epoch)?;
        let claim = self.claims.get_mut(id).ok_or(ERROR)?;
        if claim.slot != slot
            || claim.epoch != Some(epoch)
            || claim.closed
            || claim.generation != generation
            || generation == 0
        {
            return Err(ERROR.into());
        }
        claim.inflight = claim
            .inflight
            .checked_add(1)
            .ok_or("terminal_request_overflow")?;
        Ok(())
    }
    fn finish(&mut self, slot: Slot, epoch: u64, id: &str, generation: u64, known: bool) {
        if let Some(claim) = self.claims.get_mut(id) {
            if claim.slot != slot
                || claim.epoch != Some(epoch)
                || claim.inflight == 0
                || claim.generation != generation
            {
                return;
            }
            claim.inflight -= 1;
            claim.unknown |= !known;
            if claim.closed
                && claim.inflight == 0
                && !claim.unknown
                && !claim.parser_uncertain
                && !self
                    .moves
                    .iter()
                    .flatten()
                    .any(|r| r.session_id == id && r.phase != "completed")
            {
                self.claims.remove(id);
                if self.ended.remove(id) {
                    self.owners.remove(id);
                }
            }
        }
    }
    fn release_view(
        &mut self,
        slot: Slot,
        epoch: u64,
        id: &str,
        generation: u64,
    ) -> Result<(), String> {
        if self.pending_move(id) {
            return Err("terminal_move_pending".into());
        }
        let Some(claim) = self.claims.get_mut(id) else {
            return Ok(());
        };
        if claim.slot != slot || claim.epoch != Some(epoch) || claim.generation != generation {
            return Err(ERROR.into());
        }
        claim.closed = true;
        if claim.inflight == 0 && !claim.unknown && !claim.parser_uncertain {
            self.claims.remove(id);
            if self.ended.remove(id) {
                self.owners.remove(id);
            }
        }
        Ok(())
    }
    pub(super) fn close(&mut self, label: &str) {
        let Ok(slot) = Slot::parse(label) else {
            return;
        };
        let epoch = self.slots[slot.index()].epoch;
        self.slots[slot.index()].alive = false;
        self.slots[slot.index()].focused = false;
        self.slots[slot.index()].selected = None;
        let ids = self
            .claims
            .iter()
            .filter(|(_, c)| c.slot == slot && c.epoch == Some(epoch))
            .map(|(id, c)| (id.clone(), c.generation))
            .collect::<Vec<_>>();
        for (id, generation) in ids {
            let _ = self.release_view(slot, epoch, &id, generation);
        }
    }
    pub(super) fn focus(&mut self, label: &str, focused: bool) -> bool {
        if let Ok(slot) = Slot::parse(label) {
            if focused {
                for current in &mut self.slots {
                    current.focused = false;
                }
            }
            self.slots[slot.index()].focused = focused;
        }
        self.slots.iter().any(|slot| slot.focused)
    }
    fn selected(&self) -> Option<String> {
        let (index, slot) = self
            .slots
            .iter()
            .enumerate()
            .find(|(_, slot)| slot.focused)?;
        slot.selected
            .as_ref()
            .filter(|id| self.owner(id).is_some_and(|owner| owner.index() == index))
            .cloned()
    }
}
fn slot_for_pair(webview: &str, window: &str) -> Result<Slot, String> {
    if !super::browser_window::trusted_pair(webview, window) {
        return Err(ERROR.into());
    }
    Slot::parse(webview)
}
fn trusted_slot<R: tauri::Runtime>(webview: &Webview<R>) -> Result<Slot, String> {
    slot_for_pair(webview.label(), webview.window().label())
}

struct Ticket {
    table: Arc<Mutex<Table>>,
    slot: Slot,
    epoch: u64,
    generation: u64,
    id: String,
    known: bool,
}
impl Ticket {
    fn begin<R: tauri::Runtime>(
        window: &Webview<R>,
        manager: &SessionManager,
        epoch: u64,
        id: &str,
        generation: u64,
    ) -> Result<Self, String> {
        let slot = trusted_slot(window)?;
        manager
            .desktop_windows
            .lock()
            .map_err(|_| ERROR)?
            .begin(slot, epoch, id, generation)?;
        Ok(Self {
            table: Arc::clone(&manager.desktop_windows),
            slot,
            epoch,
            generation,
            id: id.into(),
            known: false,
        })
    }
    fn call<T: serde::de::DeserializeOwned>(
        &mut self,
        manager: &SessionManager,
        command: &str,
        args: serde_json::Value,
        fallback: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let client = manager
            .background_client
            .lock()
            .map_err(|_| "Background client lock poisoned")?
            .clone();
        let Some(client) = client else {
            let result = fallback();
            self.known = true;
            if result.is_err() {
                self.parser_failed(command);
            }
            return result;
        };
        match client.call_outcome(command, args) {
            super::background::CallOutcome::NotDispatched(error) => {
                self.known = true;
                Err(error)
            }
            super::background::CallOutcome::Unknown(error) => Err(error),
            super::background::CallOutcome::Completed(result) => {
                self.known = true;
                if result.is_err() {
                    self.parser_failed(command);
                }
                serde_json::from_value(result?)
                    .map_err(|_| "Invalid background command result".into())
            }
        }
    }
    fn parser_failed(&self, command: &str) {
        if matches!(
            command,
            "resize_session"
                | "read_terminal_frame"
                | "set_terminal_viewport"
                | "navigate_reported_prompt"
                | "clear_terminal_display"
        ) {
            if let Ok(mut table) = self.table.lock() {
                if let Some(claim) = table.claims.get_mut(&self.id) {
                    if claim.generation == self.generation {
                        claim.parser_uncertain = true;
                    }
                }
            }
        }
    }
    fn frame(&mut self, frame: &Option<TerminalFrame>) {
        let Some(frame) = frame else {
            return;
        };
        if let Ok(mut table) = self.table.lock() {
            table.note_status(&self.id, &frame.status);
        }
        if frame.persisted || !matches!(frame.status.as_str(), "starting" | "running") {
            return;
        }
        let Some(instance) = frame
            .projection
            .get("instance")
            .and_then(serde_json::Value::as_str)
        else {
            return;
        };
        if let Ok(mut table) = self.table.lock() {
            if let Some(claim) = table.claims.get_mut(&self.id) {
                if claim.generation == self.generation && claim.epoch == Some(self.epoch) {
                    if claim.parser_instance.as_deref() == Some(instance) {
                        claim.parser_uncertain = false;
                    }
                    if !claim.parser_uncertain {
                        claim.parser_instance = Some(instance.into());
                    }
                }
            }
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut table) = self.table.lock() {
            table.finish(self.slot, self.epoch, &self.id, self.generation, self.known);
        }
    }
}
#[derive(Serialize)]
pub(super) struct Context {
    slot: Slot,
    epoch: u64,
    main_epoch: u64,
    owned_ids: Vec<String>,
    conflict: bool,
    restore_blocked: bool,
    requested_session: Option<String>,
}
#[tauri::command]
pub(super) fn desktop_window_bootstrap<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    main_ids: Vec<String>,
    secondary_ids: Vec<String>,
    expected_epoch: u64,
) -> Result<Context, String> {
    trusted_slot(&window)?;
    let slot = Slot::parse(window.label())?;
    let initialized = {
        let table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        let native = &table.slots[slot.index()];
        if !native.alive || native.epoch != expected_epoch {
            return Err(ERROR.into());
        }
        table.initialized
    };
    let mut blocked = false;
    if !initialized {
        if slot != Slot::Main || main_ids.len() > 16 || secondary_ids.len() > 16 {
            return Err(ERROR.into());
        }
        let mut valid = Vec::new();
        for id in main_ids.iter().chain(&secondary_ids) {
            if !(id.starts_with("s-")
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
            {
                return Err(ERROR.into());
            }
            let client = manager.background_client.lock().map_err(|_| ERROR)?.clone();
            let record = if let Some(client) = client {
                match client.call_outcome("get_session", serde_json::json!({"session_id":id})) {
                    super::background::CallOutcome::Completed(Ok(value)) => Some(
                        serde_json::from_value::<super::SessionRecord>(value).map_err(|_| ERROR)?,
                    ),
                    super::background::CallOutcome::Completed(Err(error)) => {
                        let listed =
                            match client.call_outcome("list_sessions", serde_json::json!({})) {
                                super::background::CallOutcome::Completed(Ok(value)) => {
                                    serde_json::from_value::<Vec<super::SessionRecord>>(value)
                                        .map_err(|_| ERROR)?
                                }
                                _ => return Err(error),
                            };
                        if listed.iter().any(|record| record.summary.session_id == *id) {
                            return Err(error);
                        }
                        None
                    }
                    super::background::CallOutcome::NotDispatched(error)
                    | super::background::CallOutcome::Unknown(error) => return Err(error),
                }
            } else {
                super::get_session(app.clone(), app.state::<SessionManager>(), id.clone()).ok()
            };
            if let Some(record) = record {
                if record.summary.session_id == *id {
                    valid.push(id.clone());
                }
            }
        }
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        if let Err(error) = table.bootstrap(&main_ids, &secondary_ids, &valid) {
            if error != "terminal_restore_limit" {
                return Err(error);
            }
            table.bootstrap(&[], &[], &[])?;
            blocked = true;
        }
    }
    let table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
    let native = &table.slots[slot.index()];
    if !native.alive || native.epoch != expected_epoch {
        return Err(ERROR.into());
    }
    Ok(Context {
        slot,
        epoch: native.epoch,
        main_epoch: table.slots[0].epoch,
        owned_ids: table
            .owners
            .iter()
            .filter(|(_, s)| **s == slot)
            .map(|(id, _)| id.clone())
            .collect(),
        conflict: table.conflict,
        restore_blocked: blocked || table.restore_blocked,
        requested_session: native.requested.clone(),
    })
}
#[tauri::command]
pub(super) fn claim_terminal_view<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
) -> Result<Option<u64>, String> {
    trusted_slot(&window)?;
    let slot = Slot::parse(window.label())?;
    let record = super::get_session(
        app.clone(),
        app.state::<SessionManager>(),
        session_id.clone(),
    )?;
    let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
    table.valid(slot, desktop_epoch)?;
    let owner = table.owner(&session_id).unwrap_or(Slot::Main);
    if owner != slot {
        table.slots[owner.index()].requested = Some(session_id.clone());
        drop(table);
        show_slot(&app, owner)?;
        let _ = app.emit_to(owner.label(), "terminal-window-selection", &session_id);
        return Ok(None);
    }
    if slot == Slot::Secondary && !table.owners.contains_key(&session_id) {
        return Err("terminal_foreign_window".into());
    }
    if record.summary.session_id != session_id {
        return Err(ERROR.into());
    }
    table.owners.entry(session_id.clone()).or_insert(slot);
    table.attach(slot, desktop_epoch, &session_id).map(Some)
}
#[tauri::command]
pub(super) fn release_terminal_view<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
    desktop_generation: u64,
    move_token: Option<u64>,
) -> Result<Option<MoveReply>, String> {
    trusted_slot(&window)?;
    if let Some(token) = move_token {
        let reply = manager.desktop_windows.lock().map_err(|_| ERROR)?.ack_move(
            Slot::parse(window.label())?,
            desktop_epoch,
            &session_id,
            desktop_generation,
            token,
        );
        if let MoveReply::Pending { receipt } = &reply {
            let _ = window.app_handle().emit_to(
                receipt.target.label(),
                "terminal-tab-move",
                receipt.token,
            );
        }
        return Ok(Some(reply));
    }
    manager
        .desktop_windows
        .lock()
        .map_err(|_| ERROR)?
        .release_view(
            Slot::parse(window.label())?,
            desktop_epoch,
            &session_id,
            desktop_generation,
        )
        .map(|_| None)
}
async fn ensure_move_target<R: tauri::Runtime>(
    app: AppHandle<R>,
    target: Slot,
) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if target == Slot::Secondary {
            create_secondary(&handle)
        } else {
            let window = handle.get_window(target.label()).ok_or(ERROR)?;
            window
                .show()
                .and_then(|_| window.unminimize())
                .and_then(|_| window.set_focus())
                .map_err(|_| ERROR.to_string())
        }
    })
    .await
    .map_err(|_| ERROR.to_string())??;
    if app.get_window(target.label()).is_none() {
        return Err(ERROR.into());
    }
    Ok(())
}
#[tauri::command]
pub(super) async fn prepare_terminal_move<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
    desktop_generation: u64,
    appearance: serde_json::Value,
) -> Result<MoveReply, String> {
    prepare_terminal_move_with(
        window,
        manager,
        desktop_epoch,
        session_id,
        desktop_generation,
        appearance,
        |target| ensure_move_target(app, target),
    )
    .await
}

async fn prepare_terminal_move_with<
    R: tauri::Runtime,
    F: std::future::Future<Output = Result<(), String>>,
>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
    desktop_generation: u64,
    appearance: serde_json::Value,
    ensure_target: impl FnOnce(Slot) -> F,
) -> Result<MoveReply, String> {
    trusted_slot(&window)?;
    let Ok(slot) = Slot::parse(window.label()) else {
        return Ok(MoveReply::Unavailable);
    };
    {
        let Ok(table) = manager.desktop_windows.lock() else {
            return Ok(MoveReply::Unavailable);
        };
        if !table.move_source_valid(slot, desktop_epoch, &session_id, desktop_generation) {
            if let Some(r) = table.moves[slot.index()].as_ref() {
                if table.valid(slot, desktop_epoch).is_ok()
                    && r.session_id == session_id
                    && r.source_generation == desktop_generation
                    && r.source_epoch == desktop_epoch
                {
                    return Ok(table.move_reply(slot.index()));
                }
            }
            return Ok(MoveReply::Unavailable);
        }
    }
    let target = if slot == Slot::Main {
        Slot::Secondary
    } else {
        Slot::Main
    };
    if ensure_target(target).await.is_err() {
        return Ok(MoveReply::Unavailable);
    }
    let Ok(mut table) = manager.desktop_windows.lock() else {
        return Ok(MoveReply::Unavailable);
    };
    Ok(table.prepare_move(
        slot,
        desktop_epoch,
        &session_id,
        desktop_generation,
        appearance,
    ))
}

#[tauri::command]
pub(super) fn query_terminal_move<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: Option<String>,
) -> MoveReply {
    let Ok(slot) = trusted_slot(&window) else {
        return MoveReply::Unavailable;
    };
    let Ok(table) = manager.desktop_windows.lock() else {
        return MoveReply::Unavailable;
    };
    if table.valid(slot, desktop_epoch).is_err() {
        return MoveReply::Unavailable;
    }
    table.query_move(slot, desktop_epoch, session_id.as_deref())
}
#[tauri::command]
pub(super) fn reconcile_terminal_move<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
    desktop_generation: u64,
) -> MoveReply {
    let Ok(slot) = trusted_slot(&window) else {
        return MoveReply::Unavailable;
    };
    let Ok(mut table) = manager.desktop_windows.lock() else {
        return MoveReply::Unavailable;
    };
    table.reconcile_move(slot, desktop_epoch, &session_id, desktop_generation)
}
#[tauri::command]
pub(super) fn accept_terminal_move<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    token: u64,
) -> MoveReply {
    let Ok(slot) = trusted_slot(&window) else {
        return MoveReply::Unavailable;
    };
    let Ok(mut table) = manager.desktop_windows.lock() else {
        return MoveReply::Unavailable;
    };
    table.accept_move(slot, desktop_epoch, token)
}
#[tauri::command]
pub(super) fn complete_terminal_move<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    token: u64,
) -> MoveReply {
    let Ok(slot) = trusted_slot(&window) else {
        return MoveReply::Unavailable;
    };
    let Ok(mut table) = manager.desktop_windows.lock() else {
        return MoveReply::Unavailable;
    };
    table.complete_move(slot, desktop_epoch, token)
}
#[tauri::command]
pub(super) async fn recover_terminal_move<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    token: u64,
) -> Result<MoveReply, String> {
    trusted_slot(&window)?;
    let Ok(slot) = Slot::parse(window.label()) else {
        return Ok(MoveReply::Unavailable);
    };
    let target = {
        let Ok(table) = manager.desktop_windows.lock() else {
            return Ok(MoveReply::Unavailable);
        };
        if table.valid(slot, desktop_epoch).is_err() {
            return Ok(MoveReply::Unavailable);
        }
        let Some(index) = table.move_index(token) else {
            return Ok(MoveReply::Stale);
        };
        let r = table.moves[index].as_ref().unwrap();
        if !r.target_destroyed || r.phase == "completed" || (slot != r.source && slot != r.target) {
            return Ok(MoveReply::Unavailable);
        }
        r.target
    };
    if ensure_move_target(app, target).await.is_err() {
        return Ok(MoveReply::Unavailable);
    }
    let Ok(mut table) = manager.desktop_windows.lock() else {
        return Ok(MoveReply::Unavailable);
    };
    Ok(table.recover_move(slot, desktop_epoch, token))
}
#[tauri::command]
pub(super) fn reserve_terminal_start<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    resume_from: Option<String>,
) -> Result<u64, String> {
    trusted_slot(&window)?;
    manager
        .desktop_windows
        .lock()
        .map_err(|_| ERROR)?
        .reserve_reopen(
            Slot::parse(window.label())?,
            desktop_epoch,
            resume_from.as_deref(),
        )
}
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(super) fn create_session(
    app: AppHandle,
    window: Webview,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_reservation: u64,
    cwd: Option<String>,
    command: Option<String>,
    launch: Option<AgentLaunch>,
    resume_from: Option<String>,
    project_config: Option<super::project_config::ProjectStart>,
    worktree_attempt: Option<String>,
    shell: Option<ShellLaunch>,
    env_refs: Option<std::collections::BTreeMap<String, String>>,
    directory_reporting: Option<bool>,
    retained_lines: Option<u16>,
    ssh: Option<super::ssh_launch::SshLaunch>,
    command_reporting: Option<bool>,
) -> Result<CreateSessionReply, String> {
    let arguments = super::create_session_arguments(
        &cwd,
        &command,
        &launch,
        &resume_from,
        &project_config,
        &worktree_attempt,
        &shell,
        &env_refs,
        &retained_lines,
        &ssh,
        &directory_reporting,
        &command_reporting,
    );
    let reopening = resume_from.clone();
    let has_ssh = ssh.is_some();
    create_session_with(
        app.clone(),
        window,
        manager.clone(),
        desktop_epoch,
        desktop_reservation,
        reopening,
        directory_reporting,
        has_ssh,
        arguments,
        || {
            super::create_session(
                app.clone(),
                manager.clone(),
                cwd,
                command,
                launch,
                resume_from,
                project_config,
                worktree_attempt,
                shell,
                env_refs,
                directory_reporting,
                retained_lines,
                ssh,
                command_reporting,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn create_session_with<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_reservation: u64,
    reopening: Option<String>,
    directory_reporting: Option<bool>,
    ssh: bool,
    arguments: Result<serde_json::Value, String>,
    local_create: impl FnOnce() -> Result<CreateSessionReply, String>,
) -> Result<CreateSessionReply, String> {
    trusted_slot(&window)?;
    let slot = Slot::parse(window.label())?;
    {
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        table.check_start(slot, desktop_epoch, desktop_reservation)?;
    }
    let mut arguments = match arguments {
        Ok(arguments) => arguments,
        Err(error) => {
            manager
                .desktop_windows
                .lock()
                .map_err(|_| ERROR)?
                .starts
                .remove(&desktop_reservation);
            return Err(error);
        }
    };
    if directory_reporting == Some(true) {
        arguments["directory_reporting"] = serde_json::json!(true);
    }
    let client = manager.background_client.lock().map_err(|_| ERROR)?.clone();
    let result = if let Some(client) = client {
        match ssh_create(&client, arguments, ssh) {
            super::background::CallOutcome::Completed(Ok(value)) => {
                match serde_json::from_value(value) {
                    Ok(reply) => Ok(reply),
                    Err(_) => {
                        manager
                            .desktop_windows
                            .lock()
                            .map_err(|_| ERROR)?
                            .start_unknown(desktop_reservation);
                        Err("terminal_start_outcome_unknown".into())
                    }
                }
            }
            super::background::CallOutcome::Completed(Err(error))
            | super::background::CallOutcome::NotDispatched(error) => {
                manager
                    .desktop_windows
                    .lock()
                    .map_err(|_| ERROR)?
                    .starts
                    .remove(&desktop_reservation);
                Err(error)
            }
            super::background::CallOutcome::Unknown(_) => {
                manager
                    .desktop_windows
                    .lock()
                    .map_err(|_| ERROR)?
                    .start_unknown(desktop_reservation);
                Err("terminal_start_outcome_unknown".into())
            }
        }
    } else {
        let result = local_create();
        if result.is_err() {
            manager
                .desktop_windows
                .lock()
                .map_err(|_| ERROR)?
                .starts
                .remove(&desktop_reservation);
        }
        result
    };
    if let Ok(reply) = &result {
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        if let Some(previous) = reopening.as_deref() {
            table.reopened(desktop_reservation, &reply.summary.session_id)?;
            drop(table);
            if slot == Slot::Secondary {
                let previous = reply.reopened_from.as_deref().unwrap_or(previous);
                let _ = app.emit_to(
                    Slot::Main.label(),
                    "terminal-reopened",
                    serde_json::json!({"previous":previous,"next":reply.summary.session_id}),
                );
            }
        } else {
            table.created(desktop_reservation, &reply.summary.session_id)?;
        }
    }

    result
}

#[tauri::command]
pub(super) fn write_session<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
    data: String,
) -> Result<(), String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "write_session",
        serde_json::json!({"session_id":session_id,"data":data}),
        || super::write_session(manager.clone(), session_id, data),
    )
}
#[tauri::command]
pub(super) fn resize_session<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    trusted_slot(&window)?;
    if cols == 0 || rows == 0 {
        return Err("Terminal dimensions must be greater than zero".into());
    }
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "resize_session",
        serde_json::json!({"session_id":session_id,"cols":cols,"rows":rows}),
        || super::resize_session(manager.clone(), session_id, cols, rows),
    )
}
#[tauri::command(async)]
pub(super) fn read_terminal_frame<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
) -> Result<Option<TerminalFrame>, String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    let result = ticket.call(
        &manager,
        "read_terminal_frame",
        serde_json::json!({"session_id":session_id}),
        || super::read_terminal_frame(app, manager.clone(), session_id),
    );
    if let Ok(frame) = &result {
        ticket.frame(frame);
    }
    result
}
#[tauri::command(async)]
pub(super) fn read_session_snapshot<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
) -> Result<LogSnapshot, String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "read_session_snapshot",
        serde_json::json!({"session_id":session_id}),
        || super::read_session_snapshot(app, manager.clone(), session_id),
    )
}
#[tauri::command]
pub(super) fn clear_terminal_display<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
    expected_instance: String,
) -> Result<super::ClearDisplayReply, String> {
    trusted_slot(&window)?;
    if !super::clear_display_instance(&expected_instance) {
        return Err("Invalid terminal clear".into());
    }
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "clear_terminal_display",
        serde_json::json!({"session_id":session_id,"expected_instance":expected_instance}),
        || {
            Ok(super::ClearDisplayReply {
                status: super::ClearDisplayStatus::Unavailable,
            })
        },
    )
}
#[tauri::command]
pub(super) fn navigate_reported_prompt<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
    direction: String,
    expected_instance: String,
) -> Result<super::shell_command_report::NavigationReply, String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(&manager,"navigate_reported_prompt",serde_json::json!({"session_id":session_id,"direction":direction,"expected_instance":expected_instance}),||super::navigate_reported_prompt(manager.clone(),session_id,direction,expected_instance))
}
#[tauri::command]
pub(super) fn set_terminal_viewport<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
    line: u32,
    bottom: Option<bool>,
) -> Result<(), String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "set_terminal_viewport",
        serde_json::json!({"session_id":session_id,"line":line,"bottom":bottom.unwrap_or(false)}),
        || super::set_terminal_viewport(manager.clone(), session_id, line, bottom),
    )
}
#[tauri::command]
pub(super) fn take_terminal_control<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    desktop_generation: u64,
    session_id: String,
) -> Result<(), String> {
    trusted_slot(&window)?;
    let mut ticket = Ticket::begin(
        &window,
        &manager,
        desktop_epoch,
        &session_id,
        desktop_generation,
    )?;
    ticket.call(
        &manager,
        "take_terminal_control",
        serde_json::json!({"session_id":session_id}),
        || super::take_terminal_control(manager.clone(), session_id),
    )
}
pub(super) fn native_ready_script(epoch: u64) -> String {
    format!("window.__YAM_DESKTOP_EPOCH__={epoch};window.dispatchEvent(new Event('yam-native-window-ready'));" )
}
pub(super) fn page_ready<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    event: tauri::webview::PageLoadEvent,
) {
    if event != tauri::webview::PageLoadEvent::Finished || trusted_slot(webview).is_err() {
        return;
    }
    let epoch = {
        let manager = webview.state::<SessionManager>();
        let Ok(table) = manager.desktop_windows.lock() else {
            return;
        };
        let Ok(slot) = Slot::parse(webview.label()) else {
            return;
        };
        if slot != Slot::Main {
            return;
        }
        let native = &table.slots[slot.index()];
        if !native.alive {
            return;
        }
        native.epoch
    };
    let _ = webview.eval(native_ready_script(epoch));
}
fn create_secondary<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_window(Slot::Secondary.label()) {
        return window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
            .map_err(|_| ERROR.into());
    }
    let epoch = {
        let manager = app.state::<SessionManager>();
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        if table.slots[1].alive {
            return Ok(());
        }
        table.open_secondary()?
    };
    let result = tauri::WebviewWindowBuilder::new(
        app,
        Slot::Secondary.label(),
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("YAM — second terminal window")
    .theme(Some(tauri::Theme::Dark))
    .inner_size(1180.0, 760.0)
    .initialization_script(native_ready_script(epoch))
    .on_page_load(move |handle, payload| {
        let webview: &tauri::Webview<R> = handle.as_ref();
        if payload.event() == tauri::webview::PageLoadEvent::Finished
            && super::browser_window::trusted_pair(webview.label(), webview.window().label())
        {
            let _ = webview.eval(native_ready_script(epoch));
        }
    })
    .build();
    let window = match result {
        Ok(window) => window,
        Err(_) => {
            let manager = app.state::<SessionManager>();
            let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
            if table.slots[1].epoch == epoch {
                table.close(Slot::Secondary.label());
            }
            return Err("terminal_window_create_failed".into());
        }
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        secondary_window_event(&handle.state::<SessionManager>(), epoch, event);
    });
    super::record_desktop_focus(
        &app.state::<SessionManager>(),
        Slot::Secondary.label(),
        window.is_focused().unwrap_or(false),
    );
    Ok(())
}
fn secondary_window_event(manager: &SessionManager, epoch: u64, event: &tauri::WindowEvent) {
    if let Ok(mut table) = manager.desktop_windows.lock() {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            table.note_destroyed(Slot::Secondary, epoch);
        }
        if table.slots[1].epoch != epoch {
            return;
        }
        match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                table.close(Slot::Secondary.label())
            }
            tauri::WindowEvent::Focused(focused) => {
                table.focus(Slot::Secondary.label(), *focused);
            }
            _ => {}
        }
        manager.desktop_foreground.store(
            table.slots.iter().any(|slot| slot.focused),
            super::Ordering::Release,
        );
    };
}

pub(super) fn show_slot<R: tauri::Runtime>(app: &AppHandle<R>, slot: Slot) -> Result<(), String> {
    if let Some(window) = app.get_window(slot.label()) {
        return window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
            .map_err(|_| ERROR.into());
    }
    if slot != Slot::Secondary {
        return Err("terminal_window_closed".into());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if create_secondary(&handle).is_err() {
            let _ = handle.emit_to(
                "main",
                "terminal-window-error",
                "Second terminal window is unavailable. Running tasks were preserved.",
            );
        }
    });
    Ok(())
}
pub(super) fn owning_slot<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Slot {
    app.state::<SessionManager>()
        .desktop_windows
        .lock()
        .ok()
        .and_then(|table| table.owner(id))
        .unwrap_or(Slot::Main)
}
#[tauri::command]
pub(super) async fn open_terminal_window<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
) -> Result<(), String> {
    trusted_slot(&window)?;
    {
        manager
            .desktop_windows
            .lock()
            .map_err(|_| ERROR)?
            .valid(Slot::parse(window.label())?, desktop_epoch)?;
    }
    tauri::async_runtime::spawn_blocking(move || create_secondary(&app))
        .await
        .map_err(|_| ERROR.to_string())?
}
// A permit lives inside the actual blocking worker, never in its waiting future.
struct FileJob {
    table: Arc<Mutex<Table>>,
    slot: Slot,
    epoch: u64,
}
impl FileJob {
    fn begin(table: Arc<Mutex<Table>>, label: &str, epoch: u64) -> Result<Self, String> {
        let slot = Slot::parse(label)?;
        {
            let mut state = table.lock().map_err(|_| ERROR)?;
            state.valid(slot, epoch)?;
            if state.file_jobs[slot.index()] {
                return Err("terminal_file_busy".into());
            }
            state.file_jobs[slot.index()] = true;
        }
        Ok(Self { table, slot, epoch })
    }
    fn check(&self) -> Result<(), String> {
        self.table
            .lock()
            .map_err(|_| ERROR)?
            .valid(self.slot, self.epoch)
    }
}
impl Drop for FileJob {
    fn drop(&mut self) {
        if let Ok(mut table) = self.table.lock() {
            table.file_jobs[self.slot.index()] = false;
        }
    }
}
#[tauri::command]
pub(super) async fn preview_terminal_file(
    window: Webview,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    path: String,
) -> Result<super::terminal_file_actions::Preview, String> {
    trusted_slot(&window)?;
    if !cfg!(target_os = "macos") {
        return Err("terminal_file_platform_unavailable".into());
    }
    let job = FileJob::begin(
        manager.desktop_windows.clone(),
        window.label(),
        desktop_epoch,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = super::terminal_file_actions::preview(&path)?;
        job.check()?;
        Ok(result)
    })
    .await
    .map_err(|_| "terminal_file_unavailable".to_string())?
}
#[tauri::command]
pub(super) async fn reveal_terminal_file(
    window: Webview,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    path: String,
    canonical: String,
) -> Result<(), String> {
    trusted_slot(&window)?;
    if !cfg!(target_os = "macos") {
        return Err("terminal_file_platform_unavailable".into());
    }
    let job = FileJob::begin(
        manager.desktop_windows.clone(),
        window.label(),
        desktop_epoch,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        super::terminal_file_actions::reveal(
            &path,
            &canonical,
            || job.check(),
            |path| {
                tauri_plugin_opener::reveal_item_in_dir(path)
                    .map_err(|_| "terminal_file_unavailable".into())
            },
        )
    })
    .await
    .map_err(|_| "terminal_file_unavailable".to_string())?
}
#[cfg(test)]
mod file_job_tests {
    use super::*;
    fn fixture() -> Arc<Mutex<Table>> {
        let mut t = Table {
            initialized: true,
            ..Default::default()
        };
        t.slots[1] = WindowSlot {
            epoch: 2,
            alive: true,
            ..Default::default()
        };
        Arc::new(Mutex::new(t))
    }
    #[test]
    fn clear_benign_ticket_finishes_without_parser_uncertainty() {
        let table = Arc::new(Mutex::new(Table::default()));
        {
            let mut t = table.lock().unwrap();
            t.bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
                .unwrap();
            t.attach(Slot::Main, 1, "s-1-1").unwrap();
        }
        let generation = table.lock().unwrap().claims["s-1-1"].generation;
        table
            .lock()
            .unwrap()
            .begin(Slot::Main, 1, "s-1-1", generation)
            .unwrap();
        let mut ticket = super::Ticket {
            table: table.clone(),
            slot: Slot::Main,
            epoch: 1,
            generation,
            id: "s-1-1".into(),
            known: false,
        };
        let result = ticket
            .call(
                &super::SessionManager::default(),
                "clear_terminal_display",
                serde_json::json!({}),
                || {
                    Ok(super::super::ClearDisplayReply {
                        status: super::super::ClearDisplayStatus::Unavailable,
                    })
                },
            )
            .unwrap();
        assert_eq!(result.status, super::super::ClearDisplayStatus::Unavailable);
        drop(ticket);
        let t = table.lock().unwrap();
        assert!(!t.claims["s-1-1"].unknown);
        assert!(!t.claims["s-1-1"].parser_uncertain);
        assert_eq!(t.claims["s-1-1"].inflight, 0);
    }
    #[test]
    fn a07c3_benign_navigation_ticket_finishes_without_parser_uncertainty() {
        let table = Arc::new(Mutex::new(Table::default()));
        {
            let mut t = table.lock().unwrap();
            t.bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
                .unwrap();
            t.attach(Slot::Main, 1, "s-1-1").unwrap();
        }
        let generation = table.lock().unwrap().claims["s-1-1"].generation;
        table
            .lock()
            .unwrap()
            .begin(Slot::Main, 1, "s-1-1", generation)
            .unwrap();
        let mut ticket = super::Ticket {
            table: table.clone(),
            slot: Slot::Main,
            epoch: 1,
            generation,
            id: "s-1-1".into(),
            known: false,
        };
        let result = ticket
            .call(
                &super::SessionManager::default(),
                "navigate_reported_prompt",
                serde_json::json!({}),
                || {
                    Ok(super::super::shell_command_report::NavigationReply {
                        status: super::super::shell_command_report::NavigationStatus::Unavailable,
                    })
                },
            )
            .unwrap();
        assert_eq!(
            result.status,
            super::super::shell_command_report::NavigationStatus::Unavailable
        );
        drop(ticket);
        let t = table.lock().unwrap();
        assert!(!t.claims["s-1-1"].unknown);
        assert!(!t.claims["s-1-1"].parser_uncertain);
        assert_eq!(t.claims["s-1-1"].inflight, 0);
    }
    #[test]
    fn a04b2_file_job_rejects_bad_native_source_and_stale_epoch() {
        let t = fixture();
        assert!(FileJob::begin(t.clone(), "other", 1).is_err());
        assert!(FileJob::begin(t.clone(), "main", 2).is_err());
        let job = FileJob::begin(t.clone(), "main", 1).unwrap();
        t.lock().unwrap().slots[0].alive = false;
        assert!(job.check().is_err());
    }
    #[test]
    fn a04b2_waiter_cancel_does_not_release_real_worker_or_old_epoch() {
        let t = fixture();
        let job = FileJob::begin(t.clone(), "main", 1).unwrap();
        let (send, recv) = std::sync::mpsc::channel();
        let (entered_send, entered) = std::sync::mpsc::channel();
        let (result_send, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered_send.send(()).unwrap();
            recv.recv().unwrap();
            let value = job.check();
            assert!(value.is_err());
            drop(job);
            let _ = result_send.send(value);
        });
        entered.recv().unwrap();
        drop(result);
        assert!(FileJob::begin(t.clone(), "main", 1).is_err());
        {
            let mut state = t.lock().unwrap();
            state.slots[0].epoch = 3;
        }
        assert!(FileJob::begin(t.clone(), "main", 3).is_err());
        send.send(()).unwrap();
        worker.join().unwrap();
        assert!(FileJob::begin(t, "main", 3).is_ok());
    }
    #[test]
    fn a04b2_file_job_fixed_slot_bound_and_actual_completion() {
        let t = fixture();
        let job = FileJob::begin(t.clone(), "main", 1).unwrap();
        assert!(FileJob::begin(t.clone(), "main", 1).is_err());
        let other = FileJob::begin(t.clone(), "terminal-secondary", 2).unwrap();
        drop(other);
        assert!(FileJob::begin(t.clone(), "terminal-secondary", 2).is_ok());
        drop(job);
        assert!(FileJob::begin(t, "main", 1).is_ok());
    }
}
fn settings_target(target: Option<&str>) -> Result<&str, String> {
    match target.unwrap_or("settings") {
        value @ ("appearance"
        | "settings"
        | "profiles"
        | "keyboard-shortcuts"
        | "updates"
        | "paste-settings"
        | "system-entry"
        | "directory-reporting"
        | "command-reporting"
        | "launch-settings"
        | "support") => Ok(value),
        _ => Err("invalid_settings_target".into()),
    }
}
#[cfg(test)]
#[test]
fn settings_targets_preserve_pages_and_reject_unknown_values() {
    assert_eq!(settings_target(None).unwrap(), "settings");
    for page in [
        "appearance",
        "settings",
        "profiles",
        "keyboard-shortcuts",
        "updates",
        "paste-settings",
        "system-entry",
        "directory-reporting",
        "command-reporting",
        "support",
    ] {
        assert_eq!(settings_target(Some(page)).unwrap(), page);
    }
    for page in ["", "constructor", "stop-all", "../updates"] {
        assert!(settings_target(Some(page)).is_err());
    }
}
#[tauri::command]
pub(super) fn open_main_settings<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    target: Option<String>,
) -> Result<(), String> {
    let target = settings_target(target.as_deref())?;
    trusted_slot(&window)?;
    manager
        .desktop_windows
        .lock()
        .map_err(|_| ERROR)?
        .valid(Slot::parse(window.label())?, desktop_epoch)?;
    show_slot(&app, Slot::Main)?;
    app.emit_to("main", "terminal-main-settings", target)
        .map_err(|_| ERROR.into())
}
#[tauri::command]
pub(super) fn set_notification_locale<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    locale: String,
) -> Result<(), String> {
    trusted_slot(&window)?;
    if Slot::parse(window.label())? != Slot::Main {
        return Err(ERROR.into());
    }
    manager
        .desktop_windows
        .lock()
        .map_err(|_| ERROR)?
        .valid(Slot::Main, desktop_epoch)?;
    super::background::validate_command(
        "set_notification_locale",
        &serde_json::json!({"locale":locale}),
    )?;
    manager
        .system_entry
        .lock()
        .map_err(|_| ERROR)?
        .notification_chinese = locale == "zh-CN";
    super::set_notification_locale(manager, locale)
}
#[tauri::command]
pub(super) fn set_agent_notification_context(
    app: AppHandle,
    window: Webview,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    selected: Option<String>,
) -> Result<(), String> {
    set_agent_notification_context_with(
        window,
        manager.clone(),
        desktop_epoch,
        selected,
        |selected| {
            super::set_agent_notification_context(
                app.clone(),
                manager.clone(),
                selected,
                None,
                None,
            )
        },
    )
}

fn set_agent_notification_context_with<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    selected: Option<String>,
    mut send_selected: impl FnMut(Option<String>) -> Result<(), String>,
) -> Result<(), String> {
    trusted_slot(&window)?;
    let slot = Slot::parse(window.label())?;
    {
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        table.valid(slot, desktop_epoch)?;
        if selected
            .as_ref()
            .is_some_and(|id| table.owner(id) != Some(slot))
        {
            return Err(ERROR.into());
        }
        table.slots[slot.index()].selected = selected;
        table.context_pending = true;
        if table.context_sending {
            return Ok(());
        }
        table.context_sending = true;
    }
    loop {
        let selected = {
            let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
            if !table.context_pending {
                table.context_sending = false;
                return Ok(());
            }
            table.context_pending = false;
            table.selected()
        };
        if let Err(error) = send_selected(selected) {
            manager
                .desktop_windows
                .lock()
                .map_err(|_| ERROR)?
                .context_sending = false;
            return Err(error);
        }
    }
}

#[tauri::command]
pub(super) fn terminal_input_focused<R: tauri::Runtime>(
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    session_id: String,
) -> Result<bool, String> {
    trusted_slot(&window)?;
    if !manager
        .desktop_foreground
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(false);
    }
    let table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
    table.valid(Slot::parse(window.label())?, desktop_epoch)?;
    Ok(table.selected().as_deref() == Some(&session_id))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    include!("coverage_window_tests.rs");

    #[test]
    fn native_identity_exact_pairs_preserve_budget_and_reject_guests() {
        for label in ["main", "terminal-secondary"] {
            assert_eq!(slot_for_pair(label, label).unwrap().label(), label);
        }
        for (leaf, parent) in [
            ("guest", "main"),
            ("guest", "terminal-secondary"),
            ("main", "terminal-secondary"),
            ("terminal-secondary", "main"),
            ("main", "guest"),
        ] {
            let mut table = Table::default();
            table.bootstrap(&[], &[], &[]).unwrap();
            let result = slot_for_pair(leaf, parent).and_then(|slot| table.reserve(slot, 1));
            assert!(result.is_err());
            assert!(table.starts.is_empty());
            let table = Arc::new(Mutex::new(table));
            let job = slot_for_pair(leaf, parent)
                .and_then(|slot| FileJob::begin(Arc::clone(&table), slot.label(), 1));
            assert!(job.is_err());
            assert_eq!(table.lock().unwrap().file_jobs, [false, false]);
        }
    }
    #[test]
    fn native_identity_wrong_parent_rejects_before_table_admission() {
        let mut table = Table::default();
        table.bootstrap(&[], &[], &[]).unwrap();
        let result =
            slot_for_pair("main", "terminal-secondary").and_then(|slot| table.reserve(slot, 1));
        assert!(
            result.is_err(),
            "trusted leaf name in a different parent must not reserve"
        );
        assert!(table.starts.is_empty());
    }

    #[test]
    fn b05a_completed_history_does_not_accumulate_sticky_active_owners() {
        let mut table = Table::default();
        table.bootstrap(&[], &[], &[]).unwrap();
        for n in 0..1000 {
            let id = format!("s-{n:x}-1");
            let ticket = table.reserve(Slot::Main, 1).unwrap();
            table.created(ticket, &id).unwrap();
            let generation = table.attach(Slot::Main, 1, &id).unwrap();
            table.release_view(Slot::Main, 1, &id, generation).unwrap();
            // Existing authenticated lifecycle metadata is the cleanup proof, not view disposal.
            table.note_status(&id, "stopped");
        }
        assert_eq!(
            table.owners.len(),
            0,
            "completed and fully drained history must not retain sticky active owners"
        );
    }
    #[test]
    fn terminal_reopen_reuses_start_receipt_without_stealing_existing_window_ownership() {
        let mut table = Table::default();
        table.bootstrap(&[], &[], &[]).unwrap();
        assert_eq!(table.open_secondary().unwrap(), 1);
        let first = table.reserve(Slot::Main, 1).unwrap();
        table.reopened(first, "s-1-1").unwrap();
        let generation = table.attach(Slot::Main, 1, "s-1-1").unwrap();
        for slot in [Slot::Main, Slot::Secondary] {
            let ticket = table.reserve(slot, 1).unwrap();
            table.reopened(ticket, "s-1-1").unwrap();
            assert!(!table.starts.contains_key(&ticket));
            assert_eq!(table.owner("s-1-1"), Some(Slot::Main));
            assert_eq!(table.claims["s-1-1"].generation, generation);
        }
        assert!(table.reopened(99999, "s-1-1").is_err());
    }
    #[test]
    fn b05a_capacity_reservations_and_sticky_ownership_are_separate() {
        let mut table = Table::default();
        table.bootstrap(&[], &[], &[]).unwrap();
        for n in 0..16 {
            let reservation = table.reserve(Slot::Main, 1).unwrap();
            table.created(reservation, &format!("s-{n:x}-1")).unwrap();
        }
        assert!(table.reserve(Slot::Secondary, 1).is_err());
        table
            .release_view(
                Slot::Main,
                1,
                "s-0-1",
                table.claims.get("s-0-1").map_or(0, |c| c.generation),
            )
            .unwrap();
        assert_eq!(table.owner("s-0-1"), Some(Slot::Main));
        assert_eq!(table.capacity(), 15);
    }

    #[test]
    fn terminal_reopen_full_saved_layout_reuses_only_its_own_unattached_claim() {
        let ids: Vec<String> = (0..16).map(|n| format!("s-{n:x}-1")).collect();
        let mut table = Table::default();
        table.bootstrap(&ids, &[], &ids).unwrap();
        assert_eq!(table.capacity(), 16);
        let ticket = table.reserve_reopen(Slot::Main, 1, Some(&ids[0])).unwrap();
        assert_eq!(table.capacity(), 16);
        assert!(!table.claims.contains_key(&ids[0]));
        assert_eq!(table.owner(&ids[0]), Some(Slot::Main));
        table.reopened(ticket, "s-ff-1").unwrap();
        assert!(table.attach(Slot::Main, 1, "s-ff-1").is_ok());

        for refusal in ["live", "foreign", "unknown", "overflow"] {
            let mut table = Table::default();
            table.bootstrap(&ids, &[], &ids).unwrap();
            match refusal {
                "live" => {
                    table.attach(Slot::Main, 1, &ids[0]).unwrap();
                }
                "foreign" => {
                    table.owners.insert(ids[0].clone(), Slot::Secondary);
                    table.claims.get_mut(&ids[0]).unwrap().slot = Slot::Secondary;
                }
                "unknown" => {
                    table.claims.get_mut(&ids[0]).unwrap().unknown = true;
                }
                "overflow" => {
                    table.next_start = u64::MAX;
                }
                _ => unreachable!(),
            }
            assert!(
                table.reserve_reopen(Slot::Main, 1, Some(&ids[0])).is_err(),
                "{refusal}"
            );
            assert_eq!(table.capacity(), 16, "{refusal}");
            assert!(table.claims.contains_key(&ids[0]), "{refusal}");
            assert!(table.starts.is_empty(), "{refusal}");
        }
    }
    #[test]
    fn b05a_more_than_eight_rpc_tickets_preserve_input_and_drain_own_generation() {
        let mut table = Table::default();
        table
            .bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        table.attach(Slot::Main, 1, "s-1-1").unwrap();
        for _ in 0..32 {
            table
                .begin(
                    Slot::Main,
                    1,
                    "s-1-1",
                    table.claims.get("s-1-1").map_or(0, |c| c.generation),
                )
                .unwrap();
        }
        table
            .release_view(
                Slot::Main,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation),
            )
            .unwrap();
        assert!(table.attach(Slot::Main, 1, "s-1-1").is_err());
        for _ in 0..32 {
            table.finish(
                Slot::Main,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation),
                true,
            );
        }
        assert_eq!(table.capacity(), 0);
        assert_eq!(table.owner("s-1-1"), Some(Slot::Main));
        table.attach(Slot::Main, 1, "s-1-1").unwrap();
        table.finish(
            Slot::Main,
            0,
            "s-1-1",
            table.claims.get("s-1-1").map_or(0, |c| c.generation),
            true,
        );
        assert_eq!(table.capacity(), 1);
    }
    #[test]
    fn b05a_unknown_isolation_and_checked_overflow_do_not_wrap() {
        let mut table = Table::default();
        table
            .bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        table.attach(Slot::Main, 1, "s-1-1").unwrap();
        table.claims.get_mut("s-1-1").unwrap().inflight = usize::MAX;
        assert!(table
            .begin(
                Slot::Main,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation)
            )
            .is_err());
        table.claims.get_mut("s-1-1").unwrap().inflight = 1;
        table.finish(
            Slot::Main,
            1,
            "s-1-1",
            table.claims.get("s-1-1").map_or(0, |c| c.generation),
            false,
        );
        table
            .release_view(
                Slot::Main,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation),
            )
            .unwrap();
        assert!(table.attach(Slot::Main, 1, "s-1-1").is_err());
        assert_eq!(table.capacity(), 1);
    }
    #[test]
    fn b05a_bootstrap_duplicates_main_priority_and_union_budget_before_claims() {
        let mut table = Table::default();
        table
            .bootstrap(
                &["s-1-1".into()],
                &["s-1-1".into(), "s-2-1".into()],
                &["s-1-1".into(), "s-2-1".into()],
            )
            .unwrap();
        assert_eq!(table.owner("s-1-1"), Some(Slot::Main));
        assert_eq!(table.owner("s-2-1"), Some(Slot::Secondary));
        assert!(table.conflict);
        assert_eq!(table.capacity(), 2);
        let mut full = Table::default();
        let ids = (0..17).map(|n| format!("s-{n:x}-1")).collect::<Vec<_>>();
        assert!(full.bootstrap(&ids[..9], &ids[9..], &ids).is_err());
        assert_eq!(full.capacity(), 0);
    }
    #[test]
    fn b05a_rejected_input_does_not_disable_explicit_take_in_current_view() {
        let mut table = Table::default();
        table
            .bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        table.attach(Slot::Main, 1, "s-1-1").unwrap();
        table
            .begin(
                Slot::Main,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation),
            )
            .unwrap();
        table.finish(
            Slot::Main,
            1,
            "s-1-1",
            table.claims.get("s-1-1").map_or(0, |c| c.generation),
            false,
        );
        assert!(
            table
                .begin(
                    Slot::Main,
                    1,
                    "s-1-1",
                    table.claims.get("s-1-1").map_or(0, |c| c.generation)
                )
                .is_ok(),
            "current view must still permit explicit Take after rejection"
        );
    }
    #[test]
    fn b05a_same_epoch_late_release_cannot_close_new_claim() {
        let mut table = Table::default();
        table
            .bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        let old = table.attach(Slot::Main, 1, "s-1-1").unwrap();
        table.release_view(Slot::Main, 1, "s-1-1", old).unwrap();
        let current = table.attach(Slot::Main, 1, "s-1-1").unwrap();
        assert!(current > old);
        assert!(table.release_view(Slot::Main, 1, "s-1-1", old).is_err());
        table.finish(Slot::Main, 1, "s-1-1", old, false);
        assert!(table.begin(Slot::Main, 1, "s-1-1", current).is_ok());
    }
    #[test]
    fn b05a_foreign_slots_and_stale_epochs_reject_before_rpc() {
        let mut table = Table::default();
        table
            .bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        table.attach(Slot::Main, 1, "s-1-1").unwrap();
        assert!(table
            .begin(
                Slot::Secondary,
                1,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation)
            )
            .is_err());
        assert!(table
            .begin(
                Slot::Main,
                0,
                "s-1-1",
                table.claims.get("s-1-1").map_or(0, |c| c.generation)
            )
            .is_err());
        assert!(Slot::parse("export-dialog").is_err());
    }
}

#[derive(Clone, Serialize)]
struct PreferenceCommit {
    source_epoch: u64,
    revision: u64,
    key: String,
    value: Option<String>,
    appearance_action: Option<String>,
}
#[tauri::command]
pub(super) fn commit_window_preferences<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    key: String,
    value: Option<String>,
    appearance_action: Option<String>,
) -> Result<(), String> {
    let slot = trusted_slot(&window)?;
    let session_preference = key
        .strip_prefix("yam.sessionName.")
        .map(|id| (id, true))
        .or_else(|| key.strip_prefix("yam.sessionLaunch.").map(|id| (id, false)));
    if let Some((id, name)) = session_preference {
        if !id.starts_with("s-")
            || id.len() < 3
            || id.len() > 122
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(ERROR.into());
        }
        let parsed: serde_json::Value =
            serde_json::from_str(value.as_deref().unwrap_or("null")).map_err(|_| ERROR)?;
        if name {
            if !parsed.is_null()
                && !parsed.as_str().is_some_and(|s| {
                    !s.trim().is_empty()
                        && s.chars().count() <= 200
                        && !s.chars().any(char::is_control)
                })
            {
                return Err(ERROR.into());
            }
        } else if !parsed.is_null()
            && !parsed.as_object().is_some_and(|o| {
                o.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "terminal" | "ordinary" | "appearance" | "envRefs"
                    )
                }) && o
                    .get("terminal")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| matches!(v, "yam" | "terminal" | "iterm2"))
            })
        {
            return Err(ERROR.into());
        }
    }
    if slot != Slot::Main && session_preference.is_none()
        || !key.starts_with("yam.")
        || key.starts_with("yam.window.")
        || key.len() > 150
        || value.as_ref().is_some_and(|value| {
            value.len()
                > if session_preference.is_some() {
                    65536
                } else {
                    1024 * 1024
                }
        })
        || appearance_action
            .as_deref()
            .is_some_and(|action| !matches!(action, "apply" | "larger" | "smaller" | "reset"))
        || appearance_action.is_some() && key != "yam.terminalSettings"
    {
        return Err(ERROR.into());
    }
    let (revision, main_epoch) = {
        let mut table = manager.desktop_windows.lock().map_err(|_| ERROR)?;
        table.valid(slot, desktop_epoch)?;
        table.preference_revision = table
            .preference_revision
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or(ERROR)?;
        (table.preference_revision, table.slots[0].epoch)
    };
    let shared_session = session_preference.is_some();
    let commit = PreferenceCommit {
        source_epoch: main_epoch,
        revision,
        key,
        value,
        appearance_action,
    };
    app.emit_to(
        Slot::Secondary.label(),
        "terminal-window-preferences",
        &commit,
    )
    .map_err(|_| ERROR)?;
    if shared_session {
        app.emit_to(Slot::Main.label(), "terminal-window-preferences", &commit)
            .map_err(|_| ERROR)?;
    }
    Ok(())
}
#[tauri::command]
pub(super) fn request_main_terminal_zoom<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: Webview<R>,
    manager: State<'_, SessionManager>,
    desktop_epoch: u64,
    action: String,
) -> Result<(), String> {
    trusted_slot(&window)?;
    if !matches!(action.as_str(), "larger" | "smaller" | "reset") {
        return Err(ERROR.into());
    }
    manager
        .desktop_windows
        .lock()
        .map_err(|_| ERROR)?
        .valid(Slot::parse(window.label())?, desktop_epoch)?;
    app.emit_to("main", "terminal-main-zoom", action)
        .map_err(|_| ERROR.into())
}

#[cfg(test)]
mod b05b_tests {
    use super::*;
    fn source() -> (Table, u64) {
        let mut t = Table::default();
        t.bootstrap(&["s-1-1".into()], &[], &["s-1-1".into()])
            .unwrap();
        t.open_secondary().unwrap();
        let g = t.attach(Slot::Main, 1, "s-1-1").unwrap();
        t.claims.get_mut("s-1-1").unwrap().parser_instance = Some("parser-1".into());
        (t, g)
    }
    #[test]
    fn app_palette_survives_the_same_validated_window_move_contract() {
        let (mut table, generation) = source();
        let mut preferences = appearance();
        preferences["theme"] = "app".into();
        assert!(matches!(
            table.prepare_move(Slot::Main, 1, "s-1-1", generation, preferences),
            MoveReply::Pending { .. }
        ));
    }
    fn appearance() -> serde_json::Value {
        serde_json::json!({"fontFamily":"Menlo","fontSize":19,"theme":"system"})
    }
    #[test]
    fn b05b_prepare_keeps_one_budget_and_blocks_old_commands() {
        let (mut t, g) = source();
        assert!(matches!(
            t.prepare_move(Slot::Main, 1, "s-1-1", g, appearance()),
            MoveReply::Pending { .. }
        ));
        assert_eq!(t.capacity(), 1);
        assert!(t.begin(Slot::Main, 1, "s-1-1", g).is_err());
        assert!(t.attach(Slot::Main, 1, "s-1-1").is_err());
    }
    #[test]
    fn b05b_inflight_unknown_parser_refuse_without_transition() {
        for kind in 0..3 {
            let (mut t, g) = source();
            let c = t.claims.get_mut("s-1-1").unwrap();
            match kind {
                0 => c.inflight = 1,
                1 => c.unknown = true,
                _ => c.parser_uncertain = true,
            };
            assert!(matches!(
                t.prepare_move(Slot::Main, 1, "s-1-1", g, appearance()),
                MoveReply::Unavailable
            ));
            assert_eq!(t.owner("s-1-1"), Some(Slot::Main));
        }
    }
    #[test]
    fn b05b_unknown_prepare_none_reconcile_rotates_and_fences_late_prepare() {
        let (mut t, g) = source();
        let MoveReply::Resume { generation, .. } = t.reconcile_move(Slot::Main, 1, "s-1-1", g)
        else {
            panic!("expected native fence")
        };
        assert_ne!(generation, g);
        assert!(matches!(
            t.prepare_move(Slot::Main, 1, "s-1-1", g, appearance()),
            MoveReply::Unavailable
        ));
        assert!(t.begin(Slot::Main, 1, "s-1-1", g).is_err());
        assert!(t.begin(Slot::Main, 1, "s-1-1", generation).is_ok());
    }
    #[test]
    fn b05b_generation_overflow_leaves_original_claim() {
        let (mut t, g) = source();
        t.next_claim = u64::MAX;
        assert!(matches!(
            t.reconcile_move(Slot::Main, 1, "s-1-1", g),
            MoveReply::Unavailable
        ));
        assert_eq!(t.claims["s-1-1"].generation, g);
    }
    fn prepared(t: &mut Table, g: u64) -> MoveReceipt {
        let MoveReply::Pending { receipt } =
            t.prepare_move(Slot::Main, 1, "s-1-1", g, appearance())
        else {
            panic!("prepare")
        };
        receipt
    }
    #[test]
    fn b05b_disposal_ack_accept_complete_idempotent_and_old_release_safe() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        assert!(t.release_view(Slot::Main, 1, "s-1-1", g).is_err());
        assert_eq!(t.capacity(), 1);
        assert_eq!(t.owner("s-1-1"), Some(Slot::Main));
        let MoveReply::Pending { receipt: a } = t.ack_move(Slot::Main, 1, "s-1-1", g, r.token)
        else {
            panic!("ack")
        };
        assert_ne!(a.target_generation, g);
        assert_eq!(t.owner("s-1-1"), Some(Slot::Secondary));
        assert!(t.attach(Slot::Secondary, 1, "s-1-1").is_err());
        let MoveReply::Pending { receipt: b } = t.ack_move(Slot::Main, 1, "s-1-1", g, r.token)
        else {
            panic!("duplicate ack")
        };
        assert_eq!(a.target_generation, b.target_generation);
        assert!(t.release_view(Slot::Main, 1, "s-1-1", g).is_err());
        assert!(matches!(
            t.accept_move(Slot::Secondary, 1, r.token),
            MoveReply::Pending { .. }
        ));
        assert!(matches!(
            t.accept_move(Slot::Secondary, 1, r.token),
            MoveReply::Pending { .. }
        ));
        assert!(matches!(
            t.complete_move(Slot::Secondary, 1, r.token),
            MoveReply::Completed { .. }
        ));
        assert!(matches!(
            t.complete_move(Slot::Secondary, 1, r.token),
            MoveReply::Completed { .. }
        ));
        assert_eq!(t.capacity(), 1);
    }
    #[test]
    fn b05b_closed_target_needs_actual_destroyed_even_never_accepted() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        t.close("terminal-secondary");
        t.open_secondary().unwrap();
        assert!(matches!(
            t.recover_move(Slot::Main, 1, r.token),
            MoveReply::Unavailable
        ));
        t.note_destroyed(Slot::Secondary, 1);
        let MoveReply::Pending { receipt: new } = t.recover_move(Slot::Main, 1, r.token) else {
            panic!("actual destroyed recovery")
        };
        assert_ne!(new.token, r.token);
        assert_eq!(new.target_epoch, 2);
        assert!(matches!(
            t.accept_move(Slot::Secondary, 2, r.token),
            MoveReply::Stale
        ));
        assert!(t.slots[1].alive);
        assert_eq!(t.capacity(), 1);
    }
    #[test]
    fn b05b_closed_accepted_unknown_preserves_process_and_budget() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        t.ack_move(Slot::Main, 1, "s-1-1", g, r.token);
        t.accept_move(Slot::Secondary, 1, r.token);
        t.claims.get_mut("s-1-1").unwrap().unknown = true;
        t.close("terminal-secondary");
        t.note_destroyed(Slot::Secondary, 1);
        t.open_secondary().unwrap();
        assert!(matches!(
            t.recover_move(Slot::Main, 1, r.token),
            MoveReply::Unavailable
        ));
        assert_eq!(t.capacity(), 1);
        assert!(t.owners.contains_key("s-1-1"));
    }
    #[test]
    fn b05b_real_source_destroyed_can_ack_but_close_requested_cannot() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        t.close("main");
        assert_eq!(t.owner("s-1-1"), Some(Slot::Main));
        t.note_destroyed(Slot::Main, 1);
        assert_eq!(t.owner("s-1-1"), Some(Slot::Secondary));
        assert_eq!(t.capacity(), 1);
        assert!(matches!(
            t.accept_move(Slot::Secondary, 1, r.token),
            MoveReply::Pending { .. }
        ));
    }

    #[test]
    fn b05b_new_target_epoch_can_query_only_destroyed_pending_receipt() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        t.close("terminal-secondary");
        t.open_secondary().unwrap();
        assert!(matches!(
            t.query_move(Slot::Secondary, 2, None),
            MoveReply::Stale
        ));
        t.note_destroyed(Slot::Secondary, 1);
        assert!(
            matches!(t.query_move(Slot::Secondary,2,None),MoveReply::Pending{receipt} if receipt.token==r.token)
        );
    }
    #[test]
    fn b05b_global_sixteen_budget_is_preserved_through_transfer() {
        let (mut t, g) = source();
        for n in 2..=16 {
            let id = format!("s-{n}-1");
            t.owners.insert(id.clone(), Slot::Main);
            t.attach(Slot::Main, 1, &id).unwrap();
        }
        assert_eq!(t.capacity(), 16);
        let r = prepared(&mut t, g);
        t.ack_move(Slot::Main, 1, "s-1-1", g, r.token);
        t.accept_move(Slot::Secondary, 1, r.token);
        t.complete_move(Slot::Secondary, 1, r.token);
        assert_eq!(t.capacity(), 16);
        assert!(t.reserve(Slot::Secondary, 1).is_err());
    }
    #[test]
    fn b05b_superseded_completed_token_is_stale_during_reverse_move() {
        let (mut t, g) = source();
        let r = prepared(&mut t, g);
        let MoveReply::Pending { receipt: a } = t.ack_move(Slot::Main, 1, "s-1-1", g, r.token)
        else {
            panic!("ack")
        };
        t.accept_move(Slot::Secondary, 1, r.token);
        t.complete_move(Slot::Secondary, 1, r.token);
        t.claims.get_mut("s-1-1").unwrap().parser_instance = Some("parser-1".into());
        let MoveReply::Pending { receipt: reverse } = t.prepare_move(
            Slot::Secondary,
            1,
            "s-1-1",
            a.target_generation,
            appearance(),
        ) else {
            panic!("reverse")
        };
        assert!(matches!(
            t.complete_move(Slot::Secondary, 1, r.token),
            MoveReply::Stale
        ));
        assert!(matches!(
            t.accept_move(Slot::Secondary, 1, r.token),
            MoveReply::Stale
        ));
        assert!(
            matches!(t.query_move(Slot::Main,1,Some("s-1-1")),MoveReply::Pending{receipt} if receipt.token==reverse.token)
        );
        assert_eq!(t.capacity(), 1);
    }
}

pub(super) fn ssh_create(
    client: &super::background::Client,
    args: serde_json::Value,
    ssh: bool,
) -> super::background::CallOutcome {
    if ssh {
        match client.call_outcome("background_status", serde_json::json!({})) {
            super::background::CallOutcome::Completed(Ok(value))
                if value.get("ssh_launch_v1") == Some(&serde_json::Value::Bool(true)) => {}
            _ => {
                return super::background::CallOutcome::NotDispatched(
                    "ssh_owner_unsupported".into(),
                )
            }
        }
    }
    if args.get("command_reporting") == Some(&serde_json::Value::Bool(true)) {
        match client.call_outcome("background_status", serde_json::json!({})) {
            super::background::CallOutcome::Completed(Ok(value))
                if value.get("zsh_command_reporting_v1")
                    == Some(&serde_json::Value::Bool(true)) => {}
            _ => {
                return super::background::CallOutcome::NotDispatched(
                    "command_reporting_owner_unsupported".into(),
                )
            }
        }
    }
    client.call_outcome("create_session", args)
}
#[cfg(test)]
mod d03a_tests {
    use super::*;
    use std::io::{Read, Write};

    fn accept_fake_stream(listener: &std::net::TcpListener) -> std::net::TcpStream {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let stream = loop {
            if let Ok((stream, _)) = listener.accept() {
                break stream;
            }
            assert!(std::time::Instant::now() < until, "bounded fake accept");
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        // macOS accepted sockets inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        stream
    }

    #[cfg(unix)]
    #[test]
    fn fake_accepted_stream_is_blocking_before_request_bytes() {
        use std::os::fd::AsRawFd;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let stream = accept_fake_stream(&listener);
        let stream_flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) };
        assert!(stream_flags >= 0);
        assert_eq!(
            stream_flags & libc::O_NONBLOCK,
            0,
            "fake reads require blocking mode"
        );
        assert_eq!(
            stream.read_timeout().unwrap(),
            Some(std::time::Duration::from_secs(3))
        );
        let listener_flags = unsafe { libc::fcntl(listener.as_raw_fd(), libc::F_GETFL) };
        assert!(listener_flags >= 0);
        assert_ne!(listener_flags & libc::O_NONBLOCK, 0);
    }

    #[test]
    fn a07c2_unsupported_command_capability_zero_create_actual_client() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = super::super::background::Client::new(super::super::background::Descriptor {
            version: 2,
            address: listener.local_addr().unwrap().to_string(),
            instance: "a".repeat(64),
            token: "b".repeat(64),
        })
        .unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut len = [0; 4];
            stream.read_exact(&mut len).unwrap();
            let mut data = vec![0; u32::from_be_bytes(len) as usize];
            stream.read_exact(&mut data).unwrap();
            let r: serde_json::Value = serde_json::from_slice(&data).unwrap();
            let reply = serde_json::json!({"version":2,"instance":r["instance"],"client":r["client"],"id":r["id"],"result":{"Ok":{"zsh_command_reporting_v1":false}}});
            let b = serde_json::to_vec(&reply).unwrap();
            stream.write_all(&(b.len() as u32).to_be_bytes()).unwrap();
            stream.write_all(&b).unwrap();
            r["command"].as_str().unwrap().to_string()
        });
        let result = ssh_create(
            &client,
            serde_json::json!({"command_reporting":true}),
            false,
        );
        let command = worker.join().unwrap();
        assert_eq!(command, "background_status");
        assert!(matches!(
            result,
            super::super::background::CallOutcome::NotDispatched(_)
        ));
    }

    #[test]
    fn d03a_unsupported_capability_zero_create_actual_client() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = super::super::background::Client::new(super::super::background::Descriptor {
            version: 2,
            address: listener.local_addr().unwrap().to_string(),
            instance: "a".repeat(64),
            token: "b".repeat(64),
        })
        .unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut len = [0; 4];
            stream.read_exact(&mut len).unwrap();
            let mut data = vec![0; u32::from_be_bytes(len) as usize];
            stream.read_exact(&mut data).unwrap();
            let r: serde_json::Value = serde_json::from_slice(&data).unwrap();
            let reply = serde_json::json!({"version":2,"instance":r["instance"],"client":r["client"],"id":r["id"],"result":{"Ok":{"ssh_launch_v1":false}}});
            let b = serde_json::to_vec(&reply).unwrap();
            stream.write_all(&(b.len() as u32).to_be_bytes()).unwrap();
            stream.write_all(&b).unwrap();
            r["command"].as_str().unwrap().to_string()
        });
        let result = ssh_create(
            &client,
            serde_json::json!({"ssh":{"host":"alias","user":null,"port":null}}),
            true,
        );
        let command = worker.join().unwrap();
        assert_eq!(command, "background_status");
        assert!(matches!(
            result,
            super::super::background::CallOutcome::NotDispatched(_)
        ));
    }

    #[test]
    fn a07c2_same_client_command_capability_refusal_unknown_outcomes() {
        use super::super::background::{CallOutcome, Client, Descriptor};
        type Reply = Option<Result<serde_json::Value, String>>;
        let cases: Vec<(&str, Vec<Reply>)> = vec![
            (
                "positive",
                vec![
                    Some(Ok(serde_json::json!({"zsh_command_reporting_v1":true}))),
                    Some(Ok(serde_json::json!({"started":true}))),
                ],
            ),
            ("missing", vec![Some(Ok(serde_json::json!({})))]),
            (
                "wrongtype",
                vec![Some(Ok(
                    serde_json::json!({"zsh_command_reporting_v1":"true"}),
                ))],
            ),
            ("status_refusal", vec![Some(Err("refused".into()))]),
            ("status_unknown", vec![None]),
            (
                "create_refusal",
                vec![
                    Some(Ok(serde_json::json!({"zsh_command_reporting_v1":true}))),
                    Some(Err("refused".into())),
                ],
            ),
            (
                "create_unknown",
                vec![
                    Some(Ok(serde_json::json!({"zsh_command_reporting_v1":true}))),
                    None,
                    None,
                ],
            ),
        ];
        for (name, replies) in cases {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let client = Client::new(Descriptor {
                version: 2,
                address: listener.local_addr().unwrap().to_string(),
                instance: "a".repeat(64),
                token: "b".repeat(64),
            })
            .unwrap();
            let worker = std::thread::spawn(move || {
                let mut requests = Vec::new();
                for reply in replies {
                    let mut stream = accept_fake_stream(&listener);
                    let mut length = [0; 4];
                    stream.read_exact(&mut length).unwrap();
                    let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
                    stream.read_exact(&mut bytes).unwrap();
                    let r: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    if let Some(result) = reply {
                        let response = serde_json::json!({"version":2,"instance":r["instance"],"client":r["client"],"id":r["id"],"result":result});
                        let bytes = serde_json::to_vec(&response).unwrap();
                        stream
                            .write_all(&(bytes.len() as u32).to_be_bytes())
                            .unwrap();
                        stream.write_all(&bytes).unwrap();
                    }
                    requests.push(r);
                }
                requests
            });
            let args = serde_json::json!({"command_reporting":true,"retained_lines":500});
            let outcome = ssh_create(&client, args.clone(), false);
            let requests = worker.join().unwrap();
            assert_eq!(requests[0]["command"], "background_status");
            assert!(requests.iter().all(|r| r["client"] == requests[0]["client"]
                && r["instance"] == requests[0]["instance"]));
            match name {
                "positive" => assert!(matches!(outcome, CallOutcome::Completed(Ok(_)))),
                "create_refusal" => assert!(matches!(outcome, CallOutcome::Completed(Err(_)))),
                "create_unknown" => {
                    assert!(matches!(outcome, CallOutcome::Unknown(_)));
                    assert_eq!(requests[1]["id"], requests[2]["id"]);
                    assert_eq!(requests[1]["args"], requests[2]["args"]);
                }
                _ => {
                    assert!(matches!(outcome, CallOutcome::NotDispatched(_)));
                    assert!(requests.iter().all(|r| r["command"] == "background_status"));
                }
            }
            if name.starts_with("create") || name == "positive" {
                assert_eq!(requests[1]["command"], "create_session");
                assert_eq!(requests[1]["args"], args);
            }
        }
    }
    #[test]
    fn d03a_same_client_positive_refusal_and_unknown_outcomes() {
        use super::super::background::{CallOutcome, Client, Descriptor};
        type Reply = Option<Result<serde_json::Value, String>>;
        let cases: Vec<(&str, Vec<Reply>)> = vec![
            (
                "positive",
                vec![
                    Some(Ok(serde_json::json!({"ssh_launch_v1":true}))),
                    Some(Ok(serde_json::json!({"started":true}))),
                ],
            ),
            ("missing", vec![Some(Ok(serde_json::json!({})))]),
            (
                "wrongtype",
                vec![Some(Ok(serde_json::json!({"ssh_launch_v1":"true"})))],
            ),
            ("status_refusal", vec![Some(Err("refused".into()))]),
            ("status_unknown", vec![None]),
            (
                "create_refusal",
                vec![
                    Some(Ok(serde_json::json!({"ssh_launch_v1":true}))),
                    Some(Err("refused".into())),
                ],
            ),
            (
                "create_unknown",
                vec![
                    Some(Ok(serde_json::json!({"ssh_launch_v1":true}))),
                    None,
                    None,
                ],
            ),
        ];
        for (name, replies) in cases {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let client = Client::new(Descriptor {
                version: 2,
                address: listener.local_addr().unwrap().to_string(),
                instance: "a".repeat(64),
                token: "b".repeat(64),
            })
            .unwrap();
            let worker = std::thread::spawn(move || {
                let mut requests = Vec::new();
                for reply in replies {
                    let mut stream = accept_fake_stream(&listener);
                    let mut length = [0; 4];
                    stream.read_exact(&mut length).unwrap();
                    let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
                    stream.read_exact(&mut bytes).unwrap();
                    let r: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    if let Some(result) = reply {
                        let response = serde_json::json!({"version":2,"instance":r["instance"],"client":r["client"],"id":r["id"],"result":result});
                        let bytes = serde_json::to_vec(&response).unwrap();
                        stream
                            .write_all(&(bytes.len() as u32).to_be_bytes())
                            .unwrap();
                        stream.write_all(&bytes).unwrap();
                    }
                    requests.push(r);
                }
                requests
            });
            let args = serde_json::json!({"ssh":{"host":"Alias_1","user":null,"port":2222},"retained_lines":500});
            let outcome = ssh_create(&client, args.clone(), true);
            let requests = worker.join().unwrap();
            assert_eq!(requests[0]["command"], "background_status");
            assert!(requests.iter().all(|r| r["client"] == requests[0]["client"]
                && r["instance"] == requests[0]["instance"]));
            match name {
                "positive" => assert!(matches!(outcome, CallOutcome::Completed(Ok(_)))),
                "create_refusal" => assert!(matches!(outcome, CallOutcome::Completed(Err(_)))),
                "create_unknown" => {
                    assert!(matches!(outcome, CallOutcome::Unknown(_)));
                    assert_eq!(requests[1]["id"], requests[2]["id"]);
                    assert_eq!(requests[1]["args"], requests[2]["args"]);
                }
                _ => {
                    assert!(matches!(outcome, CallOutcome::NotDispatched(_)));
                    assert!(requests.iter().all(|r| r["command"] == "background_status"));
                }
            }
            if name.starts_with("create") || name == "positive" {
                assert_eq!(requests[1]["command"], "create_session");
                assert_eq!(requests[1]["args"], args);
            }
        }
    }
}

#[cfg(test)]
mod d03a_unknown_start_tests {
    use super::*;
    #[test]
    fn d03a_unknown_blocks_only_exact_slot_epoch() {
        let mut t = Table::default();
        t.bootstrap(&[], &[], &[]).unwrap();
        t.slots[1].alive = true;
        t.slots[1].epoch = 1;
        let a = t.reserve(Slot::Main, 1).unwrap();
        let pending = t.reserve(Slot::Main, 1).unwrap();
        t.start_unknown(a);
        assert_eq!(
            t.reserve(Slot::Main, 1).unwrap_err(),
            "terminal_start_outcome_unknown"
        );
        assert!(t.reserve(Slot::Secondary, 1).is_ok());
        t.slots[0].epoch = 2;
        assert!(t.reserve(Slot::Main, 2).is_ok());
        assert!(t.starts.contains_key(&a));
        assert!(t.starts.contains_key(&pending));
    }
    #[test]
    fn d03a_pre_reserved_second_create_rejected_and_ticket_released() {
        let mut t = Table::default();
        t.bootstrap(&[], &[], &[]).unwrap();
        let first = t.reserve(Slot::Main, 1).unwrap();
        let second = t.reserve(Slot::Main, 1).unwrap();
        t.start_unknown(first);
        assert_eq!(
            t.check_start(Slot::Main, 1, second).unwrap_err(),
            "terminal_start_outcome_unknown"
        );
        assert!(!t.starts.contains_key(&second));
        assert!(t.starts.contains_key(&first));
        assert_eq!(t.unknown_starts.len(), 1);
        assert!(t.check_start(Slot::Main, 1, first).is_err());
        assert!(t.starts.contains_key(&first));
        assert_eq!(t.capacity(), 1);
    }
    #[test]
    fn d03a_unknown_marker_bounded_and_stale_epoch_zero_admission() {
        let mut t = Table::default();
        t.bootstrap(&[], &[], &[]).unwrap();
        t.start_unknown(999);
        assert!(t.unknown_starts.is_empty());
        let first = t.reserve(Slot::Main, 1).unwrap();
        t.start_unknown(first);
        for _ in 0..100 {
            assert!(t.reserve(Slot::Main, 1).is_err());
        }
        assert_eq!(t.capacity(), 1);
        t.slots[0].epoch = 2;
        assert!(t.check_start(Slot::Main, 1, first).is_err());
        assert!(t.reserve(Slot::Main, 2).is_ok());
        assert_eq!(t.capacity(), 2);
    }
    #[test]
    fn d03a_known_refusal_release_allows_new_start() {
        let mut t = Table::default();
        t.bootstrap(&[], &[], &[]).unwrap();
        let ticket = t.reserve(Slot::Main, 1).unwrap();
        t.starts.remove(&ticket);
        assert!(t.reserve(Slot::Main, 1).is_ok());
    }
}
