// Author: Jeff.Liu.
export type SessionAvailability = "available" | "owner_unavailable" | "terminal_unavailable";
type RecoveryRecord = {
  summary: {session_id:string; command:string|null; ssh?:unknown; launch?:{adapter:string;mode:string;extra_args:string;provider?:unknown}|null};
  status:string; reason?:string|null;
  agent?: {generation?:string;agent_session_id:string|null};
};
const ended = new Set(["succeeded", "failed", "stopped", "needs_attention"]);
const legacyOwnerReason = "The application closed while this session was running";
const ownerReason = "The background owner restarted; the previous terminal process cannot be reattached";

// A structural candidate only. The owner reloads and validates native identity after explicit Continue.
export function sessionRecovery(record:RecoveryRecord|null, selected:string|null, shown:string|null,
  status:string, starting:boolean, availability:SessionAvailability) {
  const matches = !!record && record.summary.session_id === selected && selected === shown;
  const available = matches && availability === "available" && status !== "unavailable";
  const launch = record?.summary.launch;
  const nativeId = record?.agent?.agent_session_id;
  const chooseNative = !!(available && !starting && ended.has(record!.status) && ended.has(status)
    && record!.summary.command === null && launch?.adapter === "codex" && launch.mode === "interactive"
    && (launch.provider || launch.extra_args.trim() === "") && nativeId == null);
  const canContinue = chooseNative || !!(available && !starting && ended.has(record!.status) && ended.has(status)
    && record!.summary.command === null && launch?.mode === "interactive"
    && ["codex", "claude", "gemini", "pi"].includes(launch.adapter)
    && (launch.adapter !== "codex" || !!launch.provider || launch.extra_args.trim() === "")
    && record!.agent?.generation?.trim()
    && typeof nativeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId));
  const canRunAgain = !!(available && !starting && (ended.has(record!.status) || ["starting", "running"].includes(record!.status)));
  const canOpenTerminal=!!(available&&!starting&&ended.has(record!.status)&&ended.has(status)&&!record!.summary.ssh);
  let notice:string|null = null;
  if (matches && availability === "owner_unavailable") {
    notice = "Background connection unavailable. The current process state cannot be confirmed here.";
  } else if (matches && (availability === "terminal_unavailable" || status === "unavailable")) {
    notice = "This terminal state is unavailable. The previous terminal state cannot be restored here.";
  } else if (matches && record!.status === "needs_attention") {
    notice = [legacyOwnerReason, ownerReason].includes(record!.reason ?? "")
      ? "The background owner restarted; the previous terminal process cannot be reattached. Review recorded output and choose an explicit action."
      : "This task needs attention. Review its recorded output and choose an explicit action.";
  } else if (matches && ended.has(record!.status) && ended.has(status) && ["claude", "codex", "pi"].includes(launch?.adapter ?? "")) {
    notice = chooseNative ? "Recorded output only. Choose a saved conversation in the native CLI to continue."
      : canContinue
      ? "Recorded output only. Choose Continue to resume the saved conversation, or Run again to start a new task."
      : "Recorded output only. Choose Run again to start a new task.";
  }
  if(!notice&&canOpenTerminal)notice="Saved terminal output. Type to open a new terminal here; previous tasks will not run again.";
  return {canContinue, canRunAgain, canOpenTerminal, chooseNative, notice};
}
