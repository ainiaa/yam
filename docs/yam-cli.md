# YAM CLI (T16–T17)

Author: Jeff.Liu.

The desktop executable accepts these finite commands before initializing the GUI. Use the executable inside the installed application bundle; packaged stdout behavior on macOS, Windows and Linux has not been accepted yet.

```text
yam-desktop status --json
yam-desktop sessions list --json
yam-desktop session show <session-id> --json
yam-desktop session start --project <directory> --adapter <codex|claude|opencode> --mode <task|interactive> --prompt-file <file> [--request-key <64-hex>] [--start-owner]
yam-desktop session focus <session-id>
yam-desktop session stop <session-id>
```

Arguments are literal. Unknown commands and invalid/non-UTF-8 arguments return a fixed error instead of opening the GUI. Empty arguments and the existing `yam://` system route retain desktop behavior; existing Agent helper and background entry points retain priority. The event subscription is described below.

Commands connect to an existing authenticated owner by default. Only `session start --start-owner` may start a background owner. It uses null standard streams and a separate Unix process group; an old incompatible owner is not replaced. The CLI does not build a Tauri application or initialize a WebView to discover storage.

## Start and outcome recovery

The prompt must be a regular UTF-8 file of at most 64 KiB. Links, directories and Unix FIFOs are rejected. Project paths are canonicalized in the CLI caller's working directory before transmission. CLI and owner preflight run before session history, PTY, log or Bridge allocation. Start uses the existing literal Agent launch pipeline and integration guards; it does not implicitly trust `yam.json`, load project defaults or alter global CLI/Hook settings.

Authenticated status exposes `start_key_context`, a non-secret 32-hex CLI namespace created once per owner lifetime. It is independent of the owner's authentication token, descriptor instance and session IDs. A caller may combine this context with its own 32-hex nonce to supply a 64-hex request key; otherwise the CLI generates that nonce. The key is returned with successful Start and an uncertain outcome.

Two clients submitting the same key and identical arguments to the same owner receive the same result with one allocation. Different arguments are refused. The shared receipt store refuses capacity beyond 256 entries or its 16 MiB budget rather than evicting a receipt. This guarantee lasts only for that owner lifetime. Start is sent once by the semantic CLI client; it does not silently retry or create another task after losing a reply. A key from a replaced owner returns `outcome_unknown` before sending Start. Preserve the original key and inspect the owner/session state before deciding what to do next.

## Metadata and focus

Status contains readiness, session counts and the public Start key context. List is limited to 100 hot sessions with total/truncated metadata. Show resolves one ID, including archived history. Session DTOs expose only session ID, status, working directory, adapter, mode, phase and aggregate receipt counts. They do not include prompts, commands, extra arguments, environment values, stored launch objects or credentials. Read operations do not change input leases or desktop notification context.

List/show Agent phases and `agent_snapshot` share one fixed allowlist: `idle`, `working`, `waiting`, `completed`, `failed`, `unknown`, `response_finished`, `needs_permission`, `needs_attention`, `interrupted`. The five actual apply-derived completion/permission/attention/interruption/failure phases no longer become `unknown` in query metadata. Arbitrary stored values still map to fixed `unknown`. This is distinct from the unchanged session-protocol `phase` event domain; it adds no DTO fields, replay or commands. See [phase projection repair](evidence/yam-cli-phase-t16/README.md).

Focus requires a known session and a desktop connection refreshed within three seconds. It queues a bounded `cli-focus` event for the existing desktop Rust bridge. The bridge uses local pending notification selection and never starts a GUI. `queued` means relay acceptance, not confirmed native focus; disconnect races do not launch another desktop. Stop returns `stop_requested` through the existing owner operation. Focus and Stop do not bypass the backend's session/input authority.

## Fixed errors

| Exit | Diagnostic | Meaning |
| --- | --- | --- |
| 2 | `invalid_arguments` | Invalid syntax, path or prompt input. |
| 3 | `owner_unavailable` | Owner connection or identity unavailable before a Start send. |
| 3 | `owner_upgrade_required` | Authenticated owner lacks the CLI key-context contract. |
| 4 | `operation_refused` | Authenticated owner refused the operation. |
| 5 | `outcome_unknown` | Start may have been sent, or its key belongs to another owner lifetime. |

Standard error uses fixed classifications and, for an uncertain Start, the valid opaque request key. It does not echo raw transport errors, prompt bytes or arbitrary input arguments.

## Native directory boundary

Discovery uses the existing Foundation Application Support, GLib user-data or Windows Roaming AppData API, then the configured application identifier and `background` directory. It does not create a directory just to query an absent owner. Invalid identifiers, relative roots and Tauri application-directory overrides are refused. On macOS, a conflicting HOME override is unsupported instead of guessing a second namespace; Linux rejects relative XDG_DATA_HOME. Native API failure is explicit. Windows/Linux branches and packaged console behavior remain unverified on their platforms.

The [T16 evidence](evidence/yam-cli-t16/README.md) distinguishes mock/unit checks and harmless debug-entry execution from actual packaged acceptance. No real owner, Agent, GUI, notification permission or Hook was exercised in this stage.


## Read-only event subscription (T17)

```text
yam-desktop events --json --cursor-file <path>
```

This command connects only to the existing authenticated owner. It never starts or replaces one, calls desktop `poll_events`, changes foreground/notification context, heartbeats an input lease, or takes control. The same non-UI entry is used; `--start-owner` is invalid for Events.

Each stdout line is a fixed DTO with the original relay sequence. Supported observations are `lifecycle` (session ID/status), `phase` (session ID/finite phase), and `agent_snapshot` (session ID, finite phase/integration, revision and aggregate receipt counts). `agent_snapshot` observes already-initialized hot history after the source update. It may coalesce changes; it is not exact historical replay of every business commit. Existing GUI `agent-state` payloads remain unchanged. Snapshot records exclude prompts, command/input/log/tool text, credentials, native Agent/receipt/turn IDs, permission keys, raw errors and inbox objects. Unknown phase/integration/delivery values become fixed labels/counts, never arbitrary text.

The existing relay retains at most1024events/4MiB. One read-only page scans at most128 original slots and limits safe JSON to256KiB; the client rejects a wire frame over272KiB before JSON decoding and uses a three-second response deadline. Raw terminal/errors/UI events are filtered but their sequence slots remain. A page containing only filtered events still advances the high-water mark. Gaps between allowed events therefore do not themselves mean data loss. Overflow, including a rejected oversized original event, emits an explicit line such as:

```json
{"sequence":176,"type":"gap","snapshot_required":true}
```

Normal contention or poison of an initialized history/record lock (or pending recovery) can prevent an observation snapshot. The owner then appends a fixed CLI-only missing-state marker, projected as the same `gap`/`snapshot_required` JSON line with its original relay sequence. It does not alter the old GUI payload or artificially change global relay `lost`/GUI gap state. Missing uninitialized history is not opened by the observer. Agent snapshots preserve the fixed phases `idle`, `working`, `waiting`, `completed`, `failed`, `unknown`, `response_finished`, `needs_permission`, `needs_attention` and `interrupted`; arbitrary values remain `unknown`.

After a gap, obtain a fresh Status/List/Show snapshot and resynchronize your consumer. The CLI does not automatically fetch or claim a complete historical snapshot. Subsequent allowed lines retain their original larger sequences.

The cursor file has strict version1 fields `version`, `instance` and `sequence`, at most1024bytes. The opaque owner instance is stored only in this private checkpoint and transport headers, never event stdout. Its parent directory must exist; new files use private permissions. Corrupt/unknown-field/version/instance files, links, Unix FIFOs, directories and nonprivate files fail closed before output. Checkpoint replacement uses a private create-new temporary file, sync and atomic rename (and Unix parent sync); it does not create user directories.

The client receives one bounded response completely before writing/flush to stdout, then checkpoints its high-water sequence. Owner/history/relay locks are released before transport/output. There is no per-consumer thread or unbounded queue. Slow output causes a later relay overflow gap while owner work can continue. Partial output, flush or checkpoint failure terminates with a fixed diagnostic. Abrupt death between stdout and checkpoint may repeat the uncheckpointed page on restart; consumers must deduplicate by sequence and discard an incomplete trailing JSON line. Exactly-once stdout/disk atomicity is not claimed.

Within one run, already-advanced sequences are not emitted again. Transport loss retries at most three times using the same Client identity and descriptor, with bounded delays. Authenticated business refusal is not retried. A changed instance emits `{"type":"instance_change"}` and stops with exit3, preserving the old checkpoint. Descriptor inspection diagnoses replacement without connecting to it; the CLI never rediscovers/starts a new owner to continue a subscription.

Default OS cancellation applies. The Unix host test sends SIGINT only to an owned harmless test-binary child executing the actual stream body against a mock transport; the mock owner stays reachable. This does not prove native packaged Ctrl+C/console behavior on three platforms. The [T17 evidence](evidence/yam-events-t17/README.md) records host tests and native exceptions.
