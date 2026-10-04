// Author: Jeff.Liu.
export type NotificationPauseState = {paused: boolean; revision: number; owner_instance: string; established: boolean};
type Invoke = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
function snapshot(value: unknown): NotificationPauseState {
  const state = value as NotificationPauseState;
  if (!state || typeof state.paused !== "boolean" || typeof state.established !== "boolean" || !Number.isSafeInteger(state.revision) || state.revision < 0 || !/^[0-9a-f]{64}$/.test(state.owner_instance)) throw Error("system_entry_unavailable");
  return state;
}
export class SystemEntryController {
  private generation = 0;
  private state: NotificationPauseState | null = null;
  private pending: NotificationPauseState | null = null;
  cancel() { this.generation++; this.state = null; this.pending = null; }
  async load(invoke: Invoke, legacy: boolean): Promise<NotificationPauseState> {
    const generation = ++this.generation;
    let state = snapshot(await invoke("get_notification_pause_state", {}));
    if (generation !== this.generation) throw Error("system_entry_cancelled");
    if (!state.established) state = snapshot(await invoke("initialize_notification_pause", {legacy_paused: legacy, expected_owner_instance: state.owner_instance}));
    if (generation !== this.generation) throw Error("system_entry_cancelled");
    const accepted = this.state;
    if (accepted?.owner_instance === state.owner_instance && accepted.revision > state.revision) state = accepted;
    const pending = this.pending;
    this.pending = null;
    if (pending?.owner_instance === state.owner_instance && pending.revision > state.revision) state = pending;
    this.state = state; return state;
  }
  async setPause(invoke: Invoke, paused: boolean): Promise<NotificationPauseState> {
    const state = this.state;
    if (!state) throw Error("system_entry_unavailable");
    const generation = ++this.generation;
    const result = snapshot(await invoke("set_notification_paused", {paused, expected_revision: state.revision, expected_owner_instance: state.owner_instance}));
    if (generation !== this.generation || result.owner_instance !== state.owner_instance) throw Error("system_entry_cancelled");
    if (!this.accept(result)) throw Error("notification_pause_changed");
    return result;
  }
  accept(state: NotificationPauseState): boolean {
    let incoming: NotificationPauseState;
    try { incoming = snapshot(state); } catch { return false; }
    if (!this.state) {
      if (!this.pending || incoming.owner_instance !== this.pending.owner_instance || incoming.revision >= this.pending.revision) this.pending = incoming;
      return false;
    }
    if (incoming.owner_instance !== this.state.owner_instance || incoming.revision < this.state.revision) return false;
    this.state = incoming; return true;
  }
}
