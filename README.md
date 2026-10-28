# YAM

Your Agent Mission Control.

A desktop workspace for Codex, Claude Code, OpenCode and other local CLI sessions.

## Status

YAM is in active development. The [current capability matrix](docs/yam-capability-matrix.md) is the single reference for supported behavior, degraded operation, unimplemented features, platform acceptance and resource budgets. Release baseline: [`0.1.10`](docs/releases/0.1.10.md) (unnotarized macOS Apple Silicon build); historical reports retain their original commits and limits.

The app groups sessions by project, supports single-task and interactive modes, and keeps PTYs and terminal state in an independent background owner. Closing the desktop preserves active tasks; reconnecting, opening history and clicking notifications do not relaunch them. **Stop all tasks and quit** explicitly stops tasks. An owner with no active tasks exits after 60 seconds without a client request. Lost background/parser state is reported explicitly.

History uses atomic local JSON with a recoverable backup; logs and saved final scenes are separate files. Older records without a scene offer log replay. The frontend retains at most 16 terminal views, history metadata is limited to 32 MiB, each log to 8 MiB, and parser scrollback to 2000 lines. These are separate budgets, not a promise of unlimited sessions. Log search/export operate on retained output; export refuses to overwrite an existing file.

Codex and Claude support validated native conversation resume through **Continue conversation**. Interactive round integration requires compatible CLI capabilities and session hooks; unsupported versions, conflicting settings or custom arguments may retain the ordinary terminal with a warning. Measured samples: Codex 0.159.3, Claude 2.1.286 and OpenCode 1.18.34. OpenCode binds one verified native root per YAM process; `/new` requires a new YAM session for integration. OpenCode native resume is not implemented.

The inbox tracks each round independently. OS notification acceptance, user visibility and reading an inbox entry are separate facts. Unsupported Linux notification services return an error and retain retry state; supported activation requires GNOME or a host-app notification portal (xdg-desktop-portal 1.20+). Windows/Linux real notification clicks and wakeup, current architecture's native keyboard/mouse/resize/rapid switching/Cmd+Q workflow, and formal signed distribution remain unvalidated. See the matrix for macOS notification samples and signing limits.

The status bar samples application and task memory separately. Latest [live memory](docs/superpowers/plans/2026-10-02-live-memory.md), [hidden renderer](docs/superpowers/plans/2026-10-02-renderer-memory.md) and [continuity measurements](docs/yam-memory-continuity.md) include real WebKit evidence and remaining limits. Ended hidden views release only after saved-scene confirmation; live views stay warm. Measurements do not establish a fixed saving, absence of leaks or an advantage over cmux.

## Codex session configuration

A session-specific API/gateway connection uses a private Codex configuration and authentication file. Skills, plugins, rules, agents, prompts, hooks and executable resources reference their original installed locations; YAM does not copy their directory trees. Package symlinks and parent-relative dependencies keep their original meaning, and installed resource updates are visible through the shared references. Shared resources retain their original permissions.

The root session, native subagents and child CLI processes inherit the session connection. Profile and role configuration overlays, logs, databases and refreshable credential state remain private so starting a YAM session does not rewrite Desktop’s global configuration or login files. Gateway image mode adds its guidance only to the private effective instruction file; native image mode directly shares the installed instructions.

This behavior applies to newly created contexts. Existing running sessions keep their original contexts. macOS/Linux use symbolic links; Windows requires symbolic-link permission (for example, Developer Mode). If resources cannot be referenced, startup reports an error rather than silently copying them.

Fresh interactive Codex sessions on macOS launch the target CLI without auxiliary version, configuration or hooks probes. Native hooks compose with inherited hooks, and the original `notify` callback stays under Codex's control. YAM confirms integration from runtime receipts and reads native turn outcomes for completion, failure and cancellation; subagent hooks do not change the root session's turn. Native hook review remains enabled. Conversation resume keeps its existing metadata checks; other platforms keep their existing integration path.

## Development

Requirements: Node.js 24+, pnpm 10, Python 3.11+, and Rust stable. macOS requires 13.5+. Agent CLIs must be installed separately. Production bundles contain a small terminal parser script. YAM prefers an installed native Node 22+ that passes the terminal capability probe; otherwise first startup downloads checksum-verified official Node 26.10.0 to YAM’s private app-data directory. Initial setup needs network access only when no compatible installed or cached Node exists. Global Node, PATH and agent CLI environments are not changed. The standalone SEA builder remains available for isolated tests.

From the repository root:

```bash
rtk pnpm --dir apps/desktop install
rtk pnpm --dir apps/desktop tauri dev
```

Validation commands:

```bash
rtk pnpm --dir apps/desktop test:coverage
rtk pnpm --dir apps/desktop build
rtk cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=2
rtk python3 -m unittest discover -s scripts -p 'test_*.py'
rtk pnpm --dir apps/desktop tauri build --debug
```

CI builds/tests on macOS, Windows and Linux. Actual isolated package lifecycle checks exist for all three; CI does not substitute for real notification, input or signed installation acceptance. See the [desktop notes](apps/desktop/README.md), [roadmap](docs/PLAN.md), [continuity record](docs/yam-session-continuity-plan.md) and [notification history](docs/notification-acceptance.md).

开发产物的保留与归档约定见[开发产物归档规则](docs/development-artifacts.md)。
