# YAM Desktop

The Tauri 2, React and TypeScript desktop application for YAM. Rust owns session supervision, storage and authenticated background communication; the bundled Node/xterm service owns terminal parsing. The frontend displays terminal projections and session state.

The [current capability matrix](../../docs/yam-capability-matrix.md) records the baseline, CLI samples, budgets and platform acceptance. The [repository README](../../README.md) describes user behavior; the [product plan](../../docs/PLAN.md) is a roadmap.

## Development

Install Node.js 24+, pnpm 10, Python 3.11+ and Rust stable, plus native Tauri build prerequisites for your OS. macOS requires 13.5+. Agent CLIs are separate installations. The build downloads, verifies and bundles Node 26.10.0 for terminal parsing.

From the repository root:

```bash
rtk pnpm --dir apps/desktop install
rtk pnpm --dir apps/desktop tauri dev
rtk pnpm --dir apps/desktop test:coverage
rtk pnpm --dir apps/desktop build
rtk cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
rtk cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
rtk cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=2
rtk python3 -m unittest discover -s scripts -p 'test_*.py'
rtk pnpm --dir apps/desktop tauri build --debug
```

`test:coverage` gates executed `src/*.ts` utility modules at 95% lines/functions and 90% branches. It does not measure whole React or Rust coverage. Ignored native fixture tests require their documented isolated app environment; a default pass does not prove those fixtures ran.

Debug/ad-hoc packages are validation artifacts. Formal macOS signing and notarization require the [release procedure](../../docs/macos-release.md) and an available Developer ID identity; Windows/Linux desktop and installation gaps remain in the matrix.


## Trusted project launch settings (T09)

Author: Jeff.Liu. A project may provide an optional `yam.json` version 1. Open New session, choose the directory, then **Preview yam.json**. Loading only previews the configuration; **Trust this exact configuration** approves it, and **Start session** is a separate action. Any file-byte change or physical project-root replacement requires approval again. Canonical aliases of the same physical root share trust; another same-named directory does not.

```json
{
  "version": 1,
  "defaults": {"adapter": "codex", "mode": "interactive", "extra_args": "--model example", "env": {"SERVICE_TOKEN": "EXISTING_SERVICE_TOKEN"}},
  "templates": [
    {"name": "Review", "adapter": "claude", "mode": "task", "prompt": "Review the current changes"},
    {"name": "Tests", "adapter": "custom", "command": "pnpm test", "cwd": "."}
  ]
}
```

Only the existing `codex`, `claude`, `opencode`, `shell`, and `custom` choices and `task`/`interactive` modes are supported. Templates merge over project defaults. This session's explicitly edited fields (including an empty argument string) take priority over trusted project settings, which take priority over application-private defaults. Project values are displayed without writing them into application defaults; saving defaults is a separate button available outside project-settings mode. Uncheck Use trusted project settings or cancel the preview to return to manual launch behavior.

Arguments and prompts use the existing literal Agent argv builder. A custom command remains explicit shell text; YAM does not interpolate `${variables}` or command templates into it. `env` maps a target variable name to an existing variable name in the owner process. Values are injected only into the child command builder, never returned to the frontend, serialized into preferences/history, or inserted into command text. The shell can still apply its own explicitly requested expansion. YAM does not read `.env`. Source and target names beginning `YAM_` are reserved case-insensitively, including `YAM_CUSTOM_COMMAND`.

Configuration permits only `version`, `defaults`, and `templates`; launch fields are `adapter`, `mode`, `extra_args`, `prompt`, `command`, `cwd`, and `env`, plus a template `name`. Unknown fields/version, duplicate names, invalid arguments, missing CLI/environment variables, or invalid working directories fail before a new launch reaches history/session-ID/PTY/log/Bridge allocation. A configured `cwd` must be a relative existing directory inside the canonical project root and cannot contain `..`. Application-private `project-launch.json` stores global defaults and approved bounded source bytes/physical root identity, not resolved environment values. Source bytes are limited to 64 KiB, templates and environment references to 32 each, and the private preference file to 1 MiB/16 trusted roots. Exceeding a limit gives an explicit error. Project configuration files must be regular files; symbolic links and reparse points are rejected.

The owner reads the actual file again at launch; an outdated preview cannot bypass trust. Older owners that do not support these RPCs report the unsupported operation, retain their active tasks, and are not automatically replaced. Legacy manual/resume requests omit the new optional configuration field.

[T09 evidence](../../docs/evidence/yam-project-config-t09/README.md) records executable Rust, actual extracted App action/JSX, and frontend tests. These tests do not establish real GUI/keyboard, CLI Hook/permissions, or Windows/Linux native operation; no user configuration or global CLI settings were changed during development.


### Terminal preferences and navigation (T10 working tree)

Author: Jeff.Liu. Open **Terminal settings** to set a font family of 1–200 UTF-16 units without control characters, a whole font size of 10–24, and dark/light/solarized terminal colors. Save persists `yam.terminalSettings`; Cancel discards the draft. Missing preferences use the existing defaults; damaged/unavailable preferences show a fallback message. Existing line height stays 1.35. All cached xterm instances receive options and fit without reconstruction; new instances read the current settings. Only a live, attached, ready view with its last confirmed writable state sends owner resize requests. Per-view requests run one at a time and merge pending dimensions to the latest; disposal, detach, owner/lifecycle change or loss of writable state drops pending work. The owner’s existing input lease is authoritative. Preference changes do not take control. Explicit new/continued first attachment, a confirmed write, or **Take control** can confirm writable state; a rejected write/resize clears it. These guards do not claim absolute knowledge of a concurrent lease takeover.

**Command palette** is available by button or Cmd/Ctrl+Shift+P, including terminal focus. If P is already assigned in existing shortcut preferences, that action keeps priority and the palette button explains the conflict. IME, ordinary input/textarea/select/contenteditable fields, open dialogs and shortcut-editing controls suppress global actions. The palette only filters until an explicit result is chosen. It offers new/previous/switch sessions, session/log search, inbox, eligible Continue conversation, diagnostics and settings using the existing actions; results use currently loaded history and are bounded to 100. It does not execute arbitrary command text, stop a task, delete history, or run again merely by searching.

**Pin/Unpin** is local navigation metadata, limited to 100 IDs in `yam.pinnedSessions`. Pinned rows sort first within their loaded project group without changing terminal-cache retention. Permanent deletion receipts also remove only their IDs from pins and stored preferences, including the shared history refresh recovery path. **Close ended view** releases only a verified saved terminal scene that is ended and no longer parsing/updating, plus its pending UI output/state. It keeps pins, history and all other views/tasks; select history to reconstruct it. **Run again** starts another task from the saved command; **Continue conversation** explicitly starts a new Agent process for an eligible original conversation. These remain separate controls.

See [T10 evidence](../../docs/evidence/yam-terminal-settings-t10/README.md). Tests exercise production module/App callbacks and JSX with synthetic storage, terminals and owner calls. Current real GUI font rendering, clipboard/keyboard, Windows/Linux and Agent/Hook/system permission behavior were not newly measured; the earlier frozen native package does not contain T10.

### Read-only Git context (T12)

The active project/session shows its branch or detached HEAD, dirty state, canonical worktree and common Git directory. Only the active directory is queried, at most once per five seconds in this window, with one owner-wide query in flight. Queries share a two-second subprocess deadline and 1 MiB cumulative output/metadata budget. Git is read through the existing authenticated background transport; no commit, push, reset, network or worktree management action is added.

External clean/process filters, repository-steering environment, changed metadata, timeout/overflow, unsupported conversions/attributes, partial clone and indeterminate submodule state show Git status unavailable. The private fixed-config status snapshot prevents original hooks/filters from executing. Non-repository directories remain normal projects. Windows/Linux and real GUI behavior are not accepted by host unit tests. See the [T12 evidence and limits](../../docs/evidence/yam-git-context-t12/README.md).

T12 Git ignore boundary: common `info/exclude` is copied within the shared metadata budget and rechecked; linked worktrees use the common source. Nonempty effective `core.excludesFile` returns unavailable rather than guessing configured path expansion. Repository-wide tracked metadata is read at canonical root even when a subdirectory is active.

### Explicit managed worktree creation (T13 candidate)

Author: Jeff.Liu. In the new-session dialog, **Create a managed worktree** previews local `HEAD`, a branch or tag and an unused absolute directory. Confirmation creates files from the fixed commit only; **Start first session** is a separate action through the existing owner launch path. The default branch `codex/yam/<first session id>` uses the actual reserved session ID. Uncommitted changes and the source index are preserved. A project `yam.json` in the new root requires its own T09 preview/trust; parent trust does not transfer.

Occupied targets/branches, fixed-commit gitlinks, nested repositories and effective external clean/smudge/process filters are refused. Registration uses `worktree add --no-checkout` with a private empty hooks directory; checkout uses a private fixed-config Git directory and the actual new index. Supported builtin conversions are retained; differing or unsupported attributes/conversions are refused. Preview reads share two seconds/1 MiB; creation subprocesses share ten seconds/1 MiB after preview revalidation. Private atomic records are limited to 1 MiB/256 entries; owner preview tokens to 32 with ten-minute expiry.

`creating` is durable before Git changes. Failed/interrupted creation retains its directory and branch; reopen marks incomplete records failed, never complete merely because Git registered them. Canonical Git relationship and physical directory identity are checked before starting. The first ID is consumed once before allocations; subsequent ordinary Start/Run again uses new IDs and permits legitimate commits in the verified worktree. Ordinary/Resume lifecycle checks cover managed descendants and aliases. Closing a terminal does not remove a worktree or stop a task.

**macOS worktree cleanup now has an explicit Preview cleanup → Move to Trash flow.** The owner refuses dirty/ignored/untracked, unsupported-filter, invalid-identity and active/finishing-session targets. It moves the whole verified directory to private same-volume quarantine, rechecks it, removes only the Git registration using ordinary non-force removal, and uses Foundation Trash. Only the verified durable final result reports success; branches are retained. Nonfinal outcomes provide retained-file/manual recovery guidance, with no automatic retry/rollback/registration repair. Windows/Linux cleanup is unsupported; real macOS Trash/GUI/permissions and native PTY/two-Agent acceptance remain pending. See [cleanup scope](../../docs/yam-worktree-cleanup.md) and [new cleanup evidence](../../docs/evidence/yam-worktree-cleanup-t13/README.md). The [historical creation-stage contract gap](../../docs/evidence/yam-worktree-t13/README.md) remains preserved as a point-in-time record.

### Fixed terminal panes (T14 candidate)

Author: Jeff.Liu. **Single**, **Side by side**, **Stacked** and **Four panes** show up to four distinct cached sessions. Click a pane or its header, then select an existing session for that pane. Clicking a terminal focuses it; a form field keeps its own keyboard focus. **Hide** and shrinking the layout only detach views from the visible layout; they do not stop sessions or delete history. Narrow windows scroll the pane grid. Layout preference restore is integrated by the T15 candidate below; packaged native reopen remains unverified.

Each visible pane has its own frame flight, viewport revision and positive-size fit/resize. Old owner, replaced/closed pane and stale parser responses cannot overwrite a newer selection. Live hidden views remain cached; visible ended scenes are protected from eviction. When all cache slots are live or protected, Start refuses before creating an owner session. A pending Start reserves a hidden ended victim without disposing its scene; selecting that victim is temporarily refused, and failure releases the reservation.

Normal keyboard/paste input goes only to the actual focused terminal in a focused window. Existing strict live-terminal protocol responses still return to their original PTY; cold projections do not replay protocol input. Backend input leases remain authoritative and **Take control** remains explicit. Layout changes and restored attachments do not broadcast input or automatically create, stop or take control of tasks. Notification suppression uses the actual focused terminal, so another visible pane or an unfocused window can still notify.

See [T14 evidence](../../docs/evidence/yam-layout-t14/README.md). Production App callbacks/components were tested with mocked terminal/IPC, including 2/4-pane continuous-output loops. Real native GUI four-pane output, paint, keyboard, resize and Windows/Linux behavior remain pending; these tests do not establish native acceptance or a performance improvement.

### Layout preferences and existing-session restore (T15)

Author: Jeff.Liu. The App now saves a version1 ID-only layout (mode, up to four pane IDs and selected ID). On startup, it checks every saved nonempty ID through the current authenticated owner's `get_session` before attaching any pane. Any invalid, missing, rejected or mismatched ID discards the whole hint and shows a fixed single-empty warning. Valid empty slots and intentional empty layouts remain empty; only a missing preference may migrate a verified `yam.lastSession`. IDs are hints for the current owner, not proof of the same owner across reopen.

Pending notification selection takes priority; newer notification/user intent, owner invalidation and unmount cancel old restore work. Once all IDs validate, at most four pane reads start together. A shared cancellation handoff keeps retained visible panes usable under the latest user layout without claiming input. Passive unrelated history-deletion receipts do not cancel startup; a deleted saved ID discards the whole hint. Restoration opens existing running, ended or owner-known archived records with cold, read-only attachment. It never creates, resumes, stops, writes to or takes control of a task. Saving waits for the startup decision and then tracks layout membership, mode and focus. Storage errors use fixed messages without rolling back live views. Automated actual-App callback/effect fixtures pass; native packaged reopen, real keyboard/window behavior and formal provider coverage remain unverified. See [App integration evidence](../../docs/evidence/yam-layout-restore-t15/README.md) and the historical [pure-codec stage](../../docs/evidence/yam-layout-t15/README.md).


## Finite command-line entry (T16)

Author: Jeff.Liu. The same executable has a non-UI status/list/show/start/focus/stop entry with authenticated owner requests and fixed metadata/error output. See [CLI syntax and boundaries](../../docs/yam-cli.md) and [automated evidence](../../docs/evidence/yam-cli-t16/README.md). Native packaged console behavior and real GUI focus/Agent acceptance remain pending; these host checks do not exercise a user's owner or tasks.


## Read-only CLI events (T17)

Author: Jeff.Liu. `events --json --cursor-file <path>` projects bounded owner lifecycle/phase/agent-count observations through the existing authenticated channel. Original relay sequences, explicit gap/snapshot guidance, private owner-bound checkpoints and finite same-client reconnect are documented in [CLI Events](../../docs/yam-cli.md#read-only-event-subscription-t17) and [event evidence](../../docs/evidence/yam-events-t17/README.md). It does not use desktop polling, focus or input ownership. Native packaged console/cancellation/real Agent acceptance remains pending.

## GUI updater source boundary

The normal window now exposes **Updates**, finite status/check/download/cancel controls and a boolean startup-check preference, using the locked Rust SDK2.13.1. The current updater configuration is absent, so the GUI remains unconfigured with zero SDK registration/lookup/network. Installation always refuses. Supplied deployment configuration, real SDK network/signature behavior and native install/compatibility/backup acceptance remain pending. See [updater boundary](../../docs/yam-updater.md) and [source evidence](../../docs/evidence/yam-updater-t20/README.md); the earlier SDK-only evidence remains historical.

## Release configuration hardening only

T18 adds a finite production CSP with strict scripts/local IPC and a style-inline exception for existing xterm runtime CSS; a separate default-localhost development policy has a React Refresh script-inline exception. The main capability contains only event listen/unlisten and directory-dialog open permissions. Cargo author/description now identify Jeff.Liu/YAM; version, license decision, SDK dependency graph and application code are unchanged. See [configuration scope](../../docs/yam-release-hardening.md) and [evidence](../../docs/evidence/yam-release-hardening-t18/README.md). Host tests/builds are distinct from pending native WebKit/IPC/dialog/OS deep-link/HMR enforcement and full release acceptance.

## CLI Agent-phase projection repair

Read-only list/show metadata now shares the existing finite Agent-phase allowlist with event snapshots, preserving response_finished/needs_permission/needs_attention/interrupted/failed from actual AgentState transitions. Unknown text remains redacted; DTO fields, cursor/retry semantics, leases/focus and the separate session-protocol phase domain are unchanged. See [bounded repair evidence](../../docs/evidence/yam-cli-phase-t16/README.md). Host regression tests are separate from pending real Agent/packaged CLI/native acceptance.

## Release CLI sourceflow repair (T19 partial)

Author: Jeff.Liu. The local macOS release helper renders fixed exception-class
errors without echoing command arguments, identity/profile values, paths or tool
output. Fixed rendering covers only caught operation exceptions; argparse
diagnostics remain unchanged. The reproduced leak concerns command/path/dynamic
exception messages; captured-output non-disclosure is a preservation guard.
Delivery behavior is unchanged. Ten mocked release fixtures pass; the
host wrapper runs97/96pass/1explicit native build/codesign skip. This is not
native signing, Apple notarization, production Gatekeeper or cross-platform
installation acceptance. See [sourceflow evidence](../../docs/evidence/yam-release-sourceflow-t19/README.md) and [release boundaries](../../docs/yam-release-hardening.md).

## Five frontend notices (T18 partial follow-up)

Author: Jeff.Liu. The existing bundled notice source assembler adds original
LICENSE sections for the five pinned direct frontend packages React/React DOM,
Lucide React, xterm renderer and fit addon, retaining CRLF/whitespace and refusing
invalid sources before SEA/final publication. Actual main fixtures are entirely
temporary/mocked; filtered Python fixtures run99/98pass/1native-build skip.
No real runtime/package build was executed. Tauri JS/plugins, Rust/transitive
inventory, complete notices/project license and native resource visibility remain
unresolved. See [five-package evidence](../../docs/evidence/yam-frontend-notices-t18/README.md).

## System entry

The ready exclusive owner now provides native tray initialization with task/unread counts, Open YAM, Pause notifications, and explicit Stop all tasks and quit. The normal window exposes a default-off **CommandOrControl+Shift+Y** global shortcut checkbox and visible conflict/save warnings. Pause is owner-authoritative with first-migration and owner/revision fences; ordinary focus updates carry selection only. Open uses a bounded GUI event plus a fixed zero-argument single-instance fallback, without task creation or terminal input claims. Ordinary window close/quit keeps task ownership.

[T11 contract](../../docs/yam-system-entry.md) and [evidence](../../docs/evidence/yam-system-entry-t11/README.md) distinguish executable host tests from native acceptance: real tray/shortcut/GUI, platform and permission checks remain pending, and formal provider coverage is uncovered. This development stage did not launch a real owner, GUI or Agent.


### Full notices release gate (T18 source)

Ordinary builds now explicitly package a developer-incomplete notice artifact and report. `pnpm build:release` uses the separate release configuration and fails closed while any full-body gap remains; macOS release checks verify the report, current manifest/bodies, and runtime before native release tools. The inventory is 535 Cargo + 12 production npm identities, with Node aggregate attribution separate. Current coverage is 24 Cargo + 8 npm, with 515 classified gaps. See [notice integrity](../../docs/THIRD_PARTY_NOTICES.md). This source pipeline is not legal or native release acceptance; actual native runtime encoding smoke is excluded from this task's host fixture run.

Current R2 source passed independent Root and Astra source reviews. A fixed, independently approved canonical manifest digest binds the entire 547-identity material inventory, including supplemental bodies, declarations, provenance, gap classifications and additional Node material. Collection produces candidates without granting readiness; Collection rejects unapproved candidates before accepted return/publication; the public approval check, both render modes and packaged validation reject mapping changes before validator body reads. Future material changes require separate review and approval-anchor updates; no flag or environment bypass is provided.

The five fresh checks, 28 actual failing assertions before repair, and the separate direct-green freshly report-bound package regression are preserved in [current R2 evidence](../../docs/evidence/yam-full-notices-t18/r2/README.md). The unchanged R1 archive is historical and superseded after a later supplemental-inventory finding; its earlier source review is not final ArtifactReview acceptance. Current counts remain 32 qualified identities, 515 material gaps (30 known and 485 awaiting classification), and one additional Node attribution. Developer output remains deterministic at 4,774,340 bytes and is never release-eligible. The collector/render/release-gate source slice is complete; full notice material, legal, native signed release and formal provider acceptance remain incomplete.
