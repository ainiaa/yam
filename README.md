# YAM

Your Agent Mission Control.

A desktop workspace for Codex, Claude Code, OpenCode and other local CLI sessions.

## Status

YAM is in active development. The [current capability matrix](docs/yam-capability-matrix.md) is the single reference for supported behavior, degraded operation, unimplemented features, platform acceptance and resource budgets. Source baseline: `6b00a7d`; historical reports retain their original commits and limits.

The app groups sessions by project, supports single-task and interactive modes, and keeps PTYs and terminal state in an independent background owner. Closing the desktop preserves active tasks; reconnecting, opening history and clicking notifications do not relaunch them. **Stop all tasks and quit** explicitly stops tasks. An owner with no active tasks exits after 60 seconds without a client request. Lost background/parser state is reported explicitly.

History uses atomic local JSON with a recoverable backup; logs and saved final scenes are separate files. Older records without a scene offer log replay. The frontend retains at most 16 terminal views, history metadata is limited to 32 MiB, each log to 8 MiB, and parser scrollback to 2000 lines. These are separate budgets, not a promise of unlimited sessions. Log search/export operate on retained output; export refuses to overwrite an existing file.

Codex and Claude support validated native conversation resume through **Continue conversation**. Interactive round integration requires compatible CLI capabilities and session hooks; unsupported versions, conflicting settings or custom arguments may retain the ordinary terminal with a warning. Measured samples: Codex 0.159.3, Claude 2.1.286 and OpenCode 1.18.34. OpenCode binds one verified native root per YAM process; `/new` requires a new YAM session for integration. OpenCode native resume is not implemented.

The inbox tracks each round independently. OS notification acceptance, user visibility and reading an inbox entry are separate facts. Unsupported Linux notification services return an error and retain retry state; supported activation requires GNOME or a host-app notification portal (xdg-desktop-portal 1.20+). Windows/Linux real notification clicks and wakeup, current architecture's native keyboard/mouse/resize/rapid switching/Cmd+Q workflow, and formal signed distribution remain unvalidated. See the matrix for macOS notification samples and signing limits.

The status bar samples application and task memory separately. Latest [live memory](docs/superpowers/plans/2026-10-02-live-memory.md), [hidden renderer](docs/superpowers/plans/2026-10-02-renderer-memory.md) and [continuity measurements](docs/yam-memory-continuity.md) include real WebKit evidence and remaining limits. Ended hidden views release only after saved-scene confirmation; live views stay warm. Measurements do not establish a fixed saving, absence of leaks or an advantage over cmux.

## Development

Requirements: Node.js 24+, pnpm 10, Python 3.11+, and Rust stable. macOS requires 13.5+. Agent CLIs must be installed separately. The build verifies and bundles the pinned official Node 26.10.0 terminal runtime; end users do not need Node.

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
