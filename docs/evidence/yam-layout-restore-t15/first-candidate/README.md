# T15 App layout restore: source integration candidate

Author: Jeff.Liu. ID-only hints are verified against the current authenticated owner. They do not establish the same owner across reopen. No real owner, Agent, GUI, native PTY, Hook, packaging or permission action ran.

The actual App reads `yam.terminalLayout`, waits for startup notification arbitration, checks at most four saved IDs with `get_session`, and attaches existing records using `openHistory(..., false, pane)`. All IDs must validate before any pane attaches. One missing/rejected/mismatched ID discards the entire hint to a single empty layout and fixed warning. Valid empty layouts and slots remain intentional; only an absent key allows verified legacy last-session migration. No restore create/resume/start/stop/write/takeover/PTY resize occurs. Saves are suppressed while verification is pending, then follow actual membership/mode/focus changes.

A dedicated generation arbitrates user intent, notifications, owner invalidation and unmount. Internal restore attachments do not invalidate their own following panes. The same-ID usability regression found that cancelling a pending boot frame left a selected view unready; an explicit user selection now obtains a fresh ordinary read-only attachment. A separate deferred-notification regression found that a newer empty-pane focus could lose to an older click; the notification query/attachment/ack now share the intent guard. Existing valid hidden raw parser readiness and startup protocol semantics are preserved.

## Executed checks

Check receipts（原始文件已归档） and code freeze（原始文件已归档） bind the final source. Actual command results: new App tests27/27; affected four-file suite98/98; whole Node279/279; standard `pnpm --dir apps/desktop build`; `git diff --check`: all exit0. Aggregate configured TS coverage is100% lines,95.08% branches,100% functions. The coverage command includes `src/*.ts`; it does not establish React, packaged native or official provider coverage. The recorded formal preflight was uncovered. Backend/Rust/Python inputs were not changed or rerun in this task.

## Failure provenance and review boundaries

Initial semantic RED（原始文件已归档） has13 AssertionError failures and1 direct-green owner invalidation assertion; baseline absence of restore makes that direct green insufficient cancellation proof. Expanded RED（原始文件已归档） has24 AssertionError failures and1 direct green. The first author harness had two fixture failures (a pre-created rejected promise and unrelated refresh-history closure), corrected only in tests; neither is used as semantic RED. Same-ID frame RED（原始文件已归档） and notification-user RED（原始文件已归档） record the later genuine defects and source prefixes. Initial coverage fixture failure（原始文件已归档） records missing new closure dependencies, not feature RED. The controller added only six existing test fixtures; original assertions remain intact.

Task-only App diff（原始文件已归档） compares the candidate with exact task-start reconstruction（原始文件已归档）. The reconstruction SHA35c436dda757785776cb3f9a10cce7aca5be95f453b208dc0f4a3b39aaee2d1d exactly matches the initial RED task-start source receipt; this is reverse reconstruction, not an original realtime byte backup. Historical pure T15/T14 evidence is unchanged. Root/Astra independent frozen review is pending; this preview is not a final seal.

Native packaged reopen, actual keyboard/window behavior and OS acceptance remain unverified. These in-memory fixtures execute actual App declarations, effects and callbacks with production layout/view/frame helpers; they do not simulate a native acceptance pass.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../../development-artifacts.md)。
