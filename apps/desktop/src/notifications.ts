export class NotificationQueue {
  private completed = new Set<string>();
  private inFlight = new Set<string>();
  private failures = new Map<string, { attempts: number; nextRetry: number }>();
  canRetry(id: string, now = Date.now()) {
    return now >= (this.failures.get(id)?.nextRetry ?? 0);
  }
  recordFailure(id: string, reason: unknown, now = Date.now()) {
    const failure = notificationFailure(reason);
    const attempts = Math.min((this.failures.get(id)?.attempts ?? 0) + 1, 6);
    const delay = failure.kind === "transient" ? Math.min(15000 * 2 ** (attempts - 1), 300000) : Infinity;
    this.failures.set(id, { attempts, nextRetry: now + delay });
    return failure.message;
  }
  clearFailure(id: string) { this.failures.delete(id); }
  resetRetries() { this.failures.clear(); }
  suppress(id: string) { this.completed.add(id); }
  async deliver(id: string, send: () => Promise<void>, scope = id) {
    if (this.completed.has(id)) return true;
    if (this.inFlight.has(scope)) return false;
    this.inFlight.add(scope);
    try { await send(); this.completed.add(id); return true; }
    finally { this.inFlight.delete(scope); }
  }
}
export function inferAgentPhase(data: string): "idle" | "working" | "waiting" {
  const latest = (pattern: RegExp) => { const matches = [...data.matchAll(pattern)]; return matches[matches.length - 1]?.index ?? -1; };
  const working = latest(/working\s*\(|esc to interrupt|working\b/gi);
  const waiting = latest(/ask (?:codex|claude).*anything|how can i help|›\s*$/gi);
  return waiting > working ? "waiting" : working >= 0 ? "working" : "idle";
}

export function notificationFailure(reason: unknown): { kind: "permission" | "unsupported" | "invalid" | "transient"; message: string } {
  const detail = reason instanceof Error ? reason.message : String(reason);
  if (/notification permission was denied|notifications are disabled/i.test(detail)) {
    return { kind: "permission", message: "Notifications are disabled. Enable YAM notifications in your system settings, then retry." };
  }
  if (/access (?:is )?denied|permission denied|0x80070005|org\.freedesktop\.(?:DBus\.Error\.(?:AccessDenied|AuthFailed)|portal\.Error\.NotAllowed)/i.test(detail)) {
    return { kind: "permission", message: `YAM cannot access notification services: ${detail}. Check application installation and system permissions, then retry.` };
  }
  if (/macOS notifications require the installed YAM\.app bundle/i.test(detail)) {
    return { kind: "unsupported", message: "Run the installed YAM.app bundle to send macOS notifications, then retry." };
  }
  if (/This desktop cannot provide notifications that reopen YAM after exit/i.test(detail)) {
    return { kind: "unsupported", message: "This desktop cannot reopen YAM from notifications. Use GNOME or a notification portal with host-app Registry support, then retry." };
  }
  if (/Invalid notification session ID|Unknown notification session|Notification title is too long|invalid XML character/i.test(detail)) {
    return { kind: "invalid", message: `Notification could not be sent: ${detail}. Automatic retries are paused.` };
  }
  return { kind: "transient", message: `Notification delivery or receipt failed: ${detail}. Automatic retry will back off up to five minutes; you can also retry now.` };
}

export const terminalStatuses = new Set(["succeeded", "failed", "stopped", "needs_attention"]);

export function discardAttentionRetries<T extends { session_id: string; status: string }>(pending: Map<string, T>, sessionId: string) {
  const removed: string[] = [];
  for (const [key, event] of pending) {
    if (event.session_id === sessionId && event.status === "idle_attention") {
      pending.delete(key);
      removed.push(key);
    }
  }
  return removed;
}
