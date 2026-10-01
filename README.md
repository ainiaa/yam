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

See [repair plan and evidence](docs/repair-plan.md). History saves are atomic with a recoverable backup; storage errors are visible. Active sessions are stopped explicitly on exit. Agent prompts are passed as literal arguments. Notifications retain pending receipts for retry, suppress the selected foreground session, and open the associated session on click while the app is running. A crash between OS delivery and receipt persistence can cause a duplicate notification; OS notification display remains subject to system settings.

CI runs frontend tests/build and Rust fmt/clippy/tests on macOS, Linux and Windows. Adding the directory picker is pending approval for the official Tauri dialog dependency. Windows Job Object cleanup and native notification behavior still require platform validation.
