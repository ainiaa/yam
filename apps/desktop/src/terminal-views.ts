// Active TUI parser/alternate-screen state cannot be reconstructed from a bounded log tail.
export class TerminalViews<T extends { dispose(): void }> {
 private views = new Map<string, { value: T; running: boolean }>();
 private limit: number;
 constructor(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Terminal limit must be positive");
  this.limit = limit;
 }
 get all() { return [...this.views.values()].map(entry => entry.value); }
 get size() { return this.views.size; }
 get canOpen() { return this.size < this.limit || [...this.views.values()].some(entry => !entry.running); }
 get(id: string) { return this.views.get(id)?.value; }
 open(id: string, running: boolean, create: () => T): T {
  if (!id) throw new Error("Terminal session ID is required");
  const existing = this.views.get(id);
  if (existing) {
   this.views.delete(id); this.views.set(id, existing);
   existing.running = running;
   return existing.value;
  }
  const victim = this.size >= this.limit ? [...this.views].find(([, entry]) => !entry.running) : undefined;
  if (this.size >= this.limit && !victim) throw new Error("Terminal limit reached. Stop an open session before opening another; live terminal state is preserved.");
  const value = create();
  if (victim) { victim[1].value.dispose(); this.views.delete(victim[0]); }
  this.views.set(id, { value, running });
  return value;
 }
 setRunning(id: string, running: boolean) { const entry = this.views.get(id); if (entry) entry.running = running; }
 retain(keep: (value: T) => boolean) {
  for (const [id, entry] of this.views) {
   if (!keep(entry.value)) { entry.value.dispose(); this.views.delete(id); }
  }
 }
 clear() { for (const entry of this.views.values()) entry.value.dispose(); this.views.clear(); }
}
