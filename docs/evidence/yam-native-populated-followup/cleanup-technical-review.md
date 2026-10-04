# Focused native cleanup technical review

Author: Jeff.Liu. Reviewed 2026-10-04T03:16:49.470590+00:00.

Verdict: the proposed narrowly attributed GUI SIGTERM followed by one pinned private-owner authenticated `shutdown` RPC is an appropriate exceptional cleanup route under the stated task-cleanup authorization. No source change, new task budget, broad termination, or permission request is required. It must remain separate from normal GUI Stop all and quit acceptance.

## Source evidence

- `apps/desktop/src-tauri/src/lib.rs:3686–3703`: GUI `stop_all_and_quit` delegates to `stop_background_and_quit`, which calls the existing background client with `shutdown`, exact empty arguments, then calls GUI `app.exit(0)` only after success.
- `apps/desktop/src-tauri/src/background.rs:1193–1200`: shutdown sets the stopping fence, invokes `SessionManager::shutdown`, and clears that fence and returns an error if cleanup fails.
- `apps/desktop/src-tauri/src/lib.rs:1012–1057`: manager shutdown requests stops, waits for session completion under the existing deadline, stops the bridge and terminal parser, then sets shutdown complete.
- `apps/desktop/src-tauri/src/background.rs:487–490,1657`: after attempting the response, only successful shutdown triggers the owner `app.exit(0)`. Lost response is therefore not proof that shutdown failed.
- `apps/desktop/src-tauri/src/background.rs:1831–1865,3153–3184`: existing client pins descriptor identity, bounds transport, validates response version/instance/client/id, and does not retry shutdown after transport loss. Preserve these properties in the existing private test transport.

## Minimal cleanup conditions

1. Before either action, revalidate exact positive GUI PID 43275 with start identity and private executable hash; owner PID 41144 with start, namespace, listener and pinned descriptor instance; and absence of all four admitted fixture task PIDs. Treat an already absent exact process as absent, not as a reason to discover or target a replacement. Record attributed parser identities for the final absence check.
2. Signal only that exact GUI PID once, after the identity check immediately preceding the signal. Do not select by process name, bundle identifier, process group, or executable substring. Confirm its absence before owner shutdown so no surviving client can initiate a new owner. SIGTERM is termination, not normal GUI cleanup or a proof of updater exit cleanup.
3. Revalidate the same owner after GUI termination. Send exactly one authenticated `shutdown` request with empty arguments using the pinned private descriptor and existing framed protocol. Do not call connect-or-start, accept a changed descriptor, disclose credentials, or silently reconnect to a replacement owner.
4. Validate a received reply's full identity and result. On transport loss, record the acknowledgement as unknown and independently test the original owner's start identity and owned parser absence; accepted shutdown may already have completed after a lost response. A cleanup error, surviving process, or identity mismatch remains incomplete and does not justify automatic owner SIGTERM/SIGKILL or repeated RPCs.
5. Preserve stage, appdata, history, original expired sessions and all receipts. Record actual GUI/owner/parser/task absence separately from the previously successful live-process continuity checkpoint. UI pane restoration, shortcut wakeup and normal GUI cleanup remain uncovered.

## Sample interpretation

The GUI sample identifies PID 43275 and primarily shows `NSApplication run` / `CFRunLoop` Mach-port waiting; the owner sample independently identifies PID 41144 with the same bundle identifier and a similar idle event-loop stack. These samples do not establish a source deadlock, successful UI restoration, or which PID CUA attempted to address. The shared bundle identifier makes the proposed routing explanation plausible, but the samples do not prove it. No additional UI retry or task admission is needed for cleanup.

No narrower existing combined non-UI GUI-and-owner exit API was established in the reviewed code. The authenticated owner shutdown is the existing normal manager-cleanup path; the exact GUI signal is the separately recorded exception. A bundle-ID quit would be less precise with these two same-bundle processes.

## Reviewed bytes

- `/Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri/src/lib.rs`: `9cf2e9336828adf4b18853437a529fe6c763c57503509ecde9967795ff0ff4d9`
- `/Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri/src/background.rs`: `dfde8a9deedeacf300a8935b061a5f0a5623ecf1b534645d29442dcb0664787c`
- `/tmp/yam-native-focused-GUI-sample.txt`: `a123abbc104962e6788bee61c631d6ab83ae275a62535fe5e68bb63d910de92d`
- `/tmp/yam-native-focused-owner-sample.txt`: `0a846e3d3312b792e9292ce5c8e9b7925046899d434f4df897c8b7b3dfb1462e`

This reviewer only read source and saved samples. No process/UI/network operation, task admission, repository edit, or actual cleanup was performed. The live process guards and previously successful checkpoint remain Root's execution evidence and require fresh pre-action validation by the executor.
