# YAM

Your Agent Mission Control.

A desktop workspace for Codex, Claude Code, OpenCode and other local CLI sessions.

## Status

**Current support: macOS only. Windows/Linux support, CI jobs and installation packages are paused.** Published packages currently target Apple Silicon.

YAM is in active development. The [current capability matrix](docs/yam-capability-matrix.md) is the single reference for supported behavior, degraded operation, unimplemented features, platform acceptance and resource budgets. Release baseline: [`0.1.11`](docs/releases/0.1.11.md) (unnotarized macOS Apple Silicon build); historical reports retain their original commits and limits.

Session switching lives in the project sidebar. A single terminal has no session tab strip; split panes show only their active session title. Existing saved layouts remain readable, and switching a view keeps background tasks running. File editor tabs remain available for working with multiple files.

The app groups sessions by project, supports single-task and interactive modes, and keeps PTYs and terminal state in an independent background owner. Closing the desktop preserves active tasks; reconnecting, opening history and clicking notifications do not relaunch them. **Stop all tasks and quit** explicitly stops tasks. An owner with no active tasks exits after 60 seconds without a client request. Lost background/parser state is reported explicitly.

History uses atomic local JSON with a recoverable backup; logs and saved final scenes are separate files. Older records without a scene offer log replay. The frontend retains at most 16 terminal views, history metadata is limited to 32 MiB, each log to 8 MiB, and parser scrollback to 2000 lines. These are separate budgets, not a promise of unlimited sessions. Log search/export operate on retained output; export refuses to overwrite an existing file.

Codex and Claude support validated native conversation resume through **Continue conversation**. Interactive round integration requires compatible CLI capabilities and session hooks; unsupported versions, conflicting settings or custom arguments may retain the ordinary terminal with a warning. Measured samples: Codex 0.159.3, Claude 2.1.286 and OpenCode 1.18.34. OpenCode binds one verified native root per YAM process; `/new` requires a new YAM session for integration. OpenCode native resume is not implemented.

The inbox tracks each round independently. OS notification acceptance, user visibility and reading an inbox entry are separate facts. Unsupported Linux notification services return an error and retain retry state; supported activation requires GNOME or a host-app notification portal (xdg-desktop-portal 1.20+). Windows/Linux real notification clicks and wakeup, current architecture's native keyboard/mouse/resize/rapid switching/Cmd+Q workflow, and formal signed distribution remain unvalidated. See the matrix for macOS notification samples and signing limits.

The status bar samples application and task memory separately. Latest [live memory](docs/superpowers/plans/2026-10-02-live-memory.md), [hidden renderer](docs/superpowers/plans/2026-10-02-renderer-memory.md) and [continuity measurements](docs/yam-memory-continuity.md) include real WebKit evidence and remaining limits. Ended hidden views release only after saved-scene confirmation; live views stay warm. Measurements do not establish a fixed saving, absence of leaks or an advantage over cmux.

## Codex session configuration

Automatic routing settings are shared by Pi and Codex. Select a connection and model separately for each classifier and each lightweight, standard or strong execution slot; A/B/C are ordered candidates within a tier. In a Codex strategy, keep **Native Codex login** and use **Add local gateway** to add a second connection. A subscription classifier can select a gateway execution model, and execution tiers can use either connection. Classification failure never authorizes a paid fallback. Verifying a model does not overwrite an existing strategy's roles.

New strategies containing both native login and a local gateway keep the official Codex terminal and one native thread. Connection changes happen between confirmed turns, retaining history and the next turn's native permissions. Unconfirmed changes stop dispatch and require reopening the session. Existing single-connection threads retain their original binding; create a new routed session to combine sources. Separate subscription homes remain isolated. Other gateway models must advertise compatible model and reasoning capabilities.

A session-specific API/gateway connection uses a private Codex configuration and authentication file. Skills, plugins, rules, agents, prompts, hooks and executable resources reference their original installed locations; YAM does not copy their directory trees. Package symlinks and parent-relative dependencies keep their original meaning, and installed resource updates are visible through the shared references. Shared resources retain their original permissions.

The root session, native subagents and child CLI processes inherit the session connection. Profile and role configuration overlays, logs, databases and refreshable credential state remain private so starting a YAM session does not rewrite Desktop’s global configuration or login files. Gateway image mode adds its guidance only to the private effective instruction file; native image mode directly shares the installed instructions.

This behavior applies to newly created contexts. Existing running sessions keep their original contexts. macOS/Linux use symbolic links; Windows requires symbolic-link permission (for example, Developer Mode). If resources cannot be referenced, startup reports an error rather than silently copying them.

On macOS/Linux with zsh or bash, new interactive sessions keep a Shell as their PTY root. Exiting Pi or another foreground CLI returns to that Shell; `exit` at the Shell prompt ends the terminal. Pi accepts `/exit`, a standalone `exit`/`quit`, and its native Ctrl+D shortcut. Shell functions for `pi`, `codex`, `claude`, `gemini`, and `opencode` enter the managed launch path; `--help`/`--version` stay native information commands and do not replace the last conversation. `yam-agent new` starts the last selected CLI without replaying its original prompt; `yam-agent resume` validates and resumes its last trusted conversation in the same project. Changing directory before a new run updates its recorded project. `command <cli>` explicitly uses the unwrapped native command. Background task execution is unchanged. Fixed launch configuration is retained for this terminal; options typed at the Shell prompt apply only to that invocation and do not accumulate. `yam-agent recover` verifies a failed exit receipt using private run evidence, the previous helper/job and observed descendants before restoring Shell readiness; it never kills processes or reruns a task. Missing evidence, a live/reused helper PID or an unverifiable process leaves the run blocked: stop the remaining processes and retry, or open a new terminal. A helper killed before it saves evidence requires a new terminal. macOS process scans use bounded native enumeration at the same observation interval, with a bounded `ps` fallback when native inspection is incomplete; Windows behavior is unchanged.

Shell bootstrap files are private and do not modify user dotfiles. zsh keeps native startup processing; bash loads the chosen login profiles or non-login `.bashrc` once through a private rcfile. CLI-specific credentials remain in the CLI environment. Before reporting a CLI exit, YAM stops remaining members of its foreground job and descendants observed with matching process identities; uncertain cleanup blocks managed restart. Processes that deliberately escape before observation remain a native CLI/OS limitation. Existing running terminals are not hot-swapped. Windows keeps its existing launch behavior; fish is not yet supported for managed Agent sessions.

Fresh interactive Codex sessions without automatic routing on macOS launch the target CLI without auxiliary version, configuration or hooks probes. Native hooks compose with inherited hooks, and the original `notify` callback stays under Codex's control. YAM confirms integration from runtime receipts and reads native turn outcomes for completion, failure and cancellation; subagent hooks do not change the root session's turn. Native hook review remains enabled. Conversation resume keeps its existing metadata checks; other platforms keep their existing integration path.

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

CI builds/tests and packages macOS only. Pull requests run once; pushes run on `main`, and newer commits cancel superseded checks. Actual isolated package lifecycle checks exist for all three; CI does not substitute for real notification, input or signed installation acceptance. See the [desktop notes](apps/desktop/README.md), [roadmap](docs/PLAN.md), [continuity record](docs/yam-session-continuity-plan.md) and [notification history](docs/notification-acceptance.md).

开发产物的保留与归档约定见[开发产物归档规则](docs/development-artifacts.md)。
