export class NotificationQueue {
  private completed = new Set<string>();
  private inFlight = new Set<string>();
  suppress(id: string) { this.completed.add(id); }
  async deliver(id: string, send: () => Promise<void>) {
    if (this.completed.has(id)) return true;
    if (this.inFlight.has(id)) return false;
    this.inFlight.add(id);
    try { await send(); this.completed.add(id); return true; }
    finally { this.inFlight.delete(id); }
  }
}
export function inferAgentPhase(data: string): "idle" | "working" | "waiting" {
  const latest = (pattern: RegExp) => { const matches = [...data.matchAll(pattern)]; return matches[matches.length - 1]?.index ?? -1; };
  const working = latest(/working\s*\(|esc to interrupt|working\b/gi);
  const waiting = latest(/ask (?:codex|claude).*anything|how can i help|›\s*$/gi);
  return waiting > working ? "waiting" : working >= 0 ? "working" : "idle";
}
