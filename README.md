# YAM

Your Agent Mission Control.

A reliable, cross-platform workspace for AI coding agents such as Codex and Claude Code.

## Status

YAM is in active development. The desktop app manages PTY sessions, bounded terminal logs, project history and structured Codex/Claude tasks.

The current session slice also persists output and history locally, recovers interrupted sessions as `needs_attention`, and reminds about idle sessions without killing them. Single-task mode uses structured CLI result events; interactive mode remains a terminal. See the [product and implementation plan](docs/PLAN.md) and [M2 stability design](docs/M2-stability-design.md) for the roadmap and acceptance criteria.

## Development

Requirements: Node.js 24+, pnpm 10, Python 3.11+, and the Rust stable toolchain. The macOS desktop application requires macOS 13.5 or later.

The build downloads and verifies the pinned official Node 26.10.0 terminal runtime and bundles it with the application. End users do not need to install Node. Background ownership and supported terminal restoration are implemented; native acceptance gaps are tracked in the [continuity plan and execution evidence](docs/yam-session-continuity-plan.md).

```bash
cd apps/desktop
pnpm install
pnpm tauri dev
```

Validation commands:

```bash
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug
```

## Reliability verification

See [repair plan and evidence](docs/repair-plan.md). History saves are atomic with a recoverable backup; storage errors are visible. Closing the desktop keeps active tasks in an independent background process. Use **Stop all tasks and quit** to stop them explicitly; reconnecting does not relaunch a task. An idle background with no connected desktop and no active tasks exits after 60 seconds. Agent prompts are passed as literal arguments. Notifications retain pending receipts for retry, suppress the selected foreground session, and open the associated session through persisted native notification activation, including app restart. macOS uses UserNotifications; Windows uses protocol toasts; Linux requires GNOME or a notification portal supporting host-app registration (xdg-desktop-portal 1.20+). Unsupported Linux notification backends return an error and preserve retry state. A crash between OS delivery and receipt persistence can cause a duplicate notification; OS notification display remains subject to system settings.

CI runs frontend tests/build and Rust fmt/clippy/tests on macOS, Linux and Windows. The native directory picker validates selected folders and preserves cancellation. Native notification acceptance and click behavior remain subject to OS permissions and desktop capabilities; see the repair plan for actual platform evidence.

### Interactive rounds and conversation resume

Codex CLI 0.159.3 interactive sessions can report separate response-completion and interruption events through session-only hooks. Review and trust YAM's six hooks in the CLI to enable integration; YAM does not change global hook definitions, approval or sandbox policies. Codex integration probes the installed CLI’s six session hooks instead of locking to a version number. Existing conflicting config hooks and unsupported capabilities fall back to the ordinary terminal. Permission requests are tracked separately from completion and tool progress clears only its matching request. Stable Claude 2.x releases from the measured 2.1.286 baseline have session-only hooks for permission and API failure events; a reply produces a conservative “response ready, may continue” reminder. Model and effort arguments keep hook integration; settings, session-identity and unknown arguments retain ordinary CLI behavior with a visible integration warning. The measured Claude 2.1.286 failure path and two-round reply reminders are verified on macOS; other platform desktop acceptance remains pending.

The inbox keeps each round unread until its entry is opened; OS acceptance is a separate delivery result. Keyboard shortcuts (Cmd on macOS / Ctrl elsewhere + Shift) default to `]` for attention, `[` for the previous session, `K` for search and `M` for notification pause; configure them in the sidebar. Enter in search opens the first match. The selected run mode is remembered without changing the initial single-task default.

For a stopped default Codex or Claude interactive session with a validated native conversation ID, **Continue conversation** starts a new process using that exact native resume ID, clears the old prompt and refuses duplicate resumes. Codex checks the original directory, provider and conversation through the installed CLI; Claude checks the local main-conversation metadata and original directory before passing `--resume`. Opening history, clicking a notification or starting YAM does not restart a task. Other adapters and custom launch arguments are not advertised as resume support.

macOS native validation and local automated checks are recorded in [execution evidence](docs/yam-next-stage-execution.md). Windows/Linux desktop notifications, old-notification activation and actual Developer ID signing remain separate acceptance gaps; the signing and notarization flow has executable checks; CI packaging alone does not verify them.


The continuity implementation and measured limits are tracked in [the execution plan](docs/yam-session-continuity-plan.md). Supported terminal/TUI state stays in the background parser while the desktop is closed; ended sessions retain a read-only final scene. Older records without a saved scene offer log replay instead. A failed background or parser is reported explicitly rather than silently restarting an Agent. **Take control** explicitly transfers terminal input from another connected client.

Session log search supports the current session or all recorded sessions, bounded result pages, excerpts and case matching. Export offers plain text or raw terminal output with session metadata, uses a native destination dialog, and refuses to overwrite an existing file.

OpenCode 1.18.34 was measured with session-only integration, native prompt/parent IDs and separate completion, permission, interruption and failure events. One YAM process binds to one verified OpenCode root; switching roots with `/new` marks integration unavailable, so start another YAM session for a new root. Native callback and delivery queues each retain at most 128 events; overflow reports unavailable rather than guessing completion. Native session lookup has a one-second deadline and aborts its SDK request. Latest macOS background exit/reconnect and frozen-scene checks pass; native keyboard/mouse/resize, the new architecture's WebKit-inclusive memory comparison and cross-platform packaging acceptance remain pending.
