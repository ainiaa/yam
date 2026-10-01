# YAM

Your Agent Mission Control.

A reliable, cross-platform workspace for AI coding agents such as Codex and Claude Code.

## Status

YAM is in active development. The desktop app manages PTY sessions, bounded terminal logs, project history and structured Codex/Claude tasks.

The current session slice also persists output and history locally, recovers interrupted sessions as `needs_attention`, and reminds about idle sessions without killing them. Single-task mode uses structured CLI result events; interactive mode remains a terminal. See the [product and implementation plan](docs/PLAN.md) and [M2 stability design](docs/M2-stability-design.md) for the roadmap and acceptance criteria.

## Development

Requirements: Node.js 24+, pnpm 10, and the Rust stable toolchain.

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

See [repair plan and evidence](docs/repair-plan.md). History saves are atomic with a recoverable backup; storage errors are visible. Active sessions are stopped explicitly on exit. Agent prompts are passed as literal arguments. Notifications retain pending receipts for retry, suppress the selected foreground session, and open the associated session through persisted native notification activation, including app restart. macOS uses UserNotifications; Windows uses protocol toasts; Linux requires GNOME or a notification portal supporting host-app registration (xdg-desktop-portal 1.20+). Unsupported Linux notification backends return an error and preserve retry state. A crash between OS delivery and receipt persistence can cause a duplicate notification; OS notification display remains subject to system settings.

CI runs frontend tests/build and Rust fmt/clippy/tests on macOS, Linux and Windows. The native directory picker validates selected folders and preserves cancellation. Native notification acceptance and click behavior remain subject to OS permissions and desktop capabilities; see the repair plan for actual platform evidence.

### Interactive rounds and conversation resume

Codex CLI 0.159.3 interactive sessions can report separate response-completion and interruption events through session-only hooks. Review and trust YAM's four hooks in the CLI to enable integration; YAM does not change global hook definitions, approval or sandbox policies. Existing conflicting config hooks, unsupported versions and adapters fall back to the ordinary terminal. Claude interactive round tracking is not yet validated.

The inbox keeps each round unread until its entry is opened; OS acceptance is a separate delivery result. Keyboard shortcuts (Cmd on macOS / Ctrl elsewhere + Shift) default to `]` for attention, `[` for the previous session, `K` for search and `M` for notification pause; configure them in the sidebar. Enter in search opens the first match. The selected run mode is remembered without changing the initial single-task default.

For a stopped default Codex interactive session with a trusted native conversation ID, **Continue conversation** starts a new process using native resume. YAM verifies the original directory, provider, installed CLI version and conversation first, clears the old prompt and refuses duplicate resumes. Opening history, clicking a notification or starting YAM does not restart a task. Other adapters and custom launch arguments are not advertised as resume support.

macOS native validation and local automated checks are recorded in [execution evidence](docs/yam-next-stage-execution.md). Windows/Linux desktop notifications, old-notification activation and formal signing remain separate acceptance gaps; CI packaging alone does not verify them.
