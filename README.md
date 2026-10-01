# YAM

Your Agent Mission Control.

A reliable, cross-platform workspace for AI coding agents such as Codex and Claude Code.

## Status

YAM is in active development. The current M0 slice boots a Tauri desktop shell, verifies the Rust runtime through IPC, and is ready for the first session-management feature.

The current session slice also persists output and history locally, recovers interrupted sessions as `needs_attention`, and supervises idle sessions. See the [product and implementation plan](docs/PLAN.md) and [M2 stability design](docs/M2-stability-design.md) for the roadmap and acceptance criteria.

## Development

Requirements: Node.js, Corepack, and the Rust stable toolchain.

```bash
cd apps/desktop
corepack pnpm install
corepack pnpm tauri dev
```

Validation commands:

```bash
corepack pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
corepack pnpm tauri build --debug
```
