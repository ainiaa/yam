# YAM Language and Theme Implementation Plan

作者：Jeff.Liu

**Goal:** Ship complete Simplified Chinese/English app UI plus unified live themes without changing task execution or global CLI configuration.

**Architecture:** i18next resources use stable English source keys with exact matching and explicit interpolation; only application-owned UI is translated. App preferences are validated, persisted and synchronized across desktop windows. CSS semantic tokens and xterm palettes share a theme definition; existing explicit terminal/profile preferences remain valid. Native menu actions retain stable IDs and language labels update independently of routing.

**Tech stack:** Existing React/Tauri/xterm; user approved i18next/react-i18next. One writer, sequential implementation; read-only translation research produces candidate resource dictionaries outside the repository. No mixed-worktree commit.

## T1 — Preferences and translation foundation
- [ ] Add failing tests for locale normalization, unsupported fallback, interpolation, preference validation and corrupt storage.
- [ ] Add i18next/react-i18next, translation resources and validated app preference module.
- [ ] Run `node --test tests/app-preferences.test.mjs tests/i18n.test.mjs` from apps/desktop.

## T2 — Complete bilingual UI
- [ ] Translate app-owned static labels, dynamic statuses and errors, native menu labels and notifications. Keep user content, CLI output, identifiers and protocol values unchanged.
- [ ] Native menu recognition must not depend on English display text. Re-label existing items without rebuilding task ownership or changing IDs.
- [ ] Cover missing keys and dynamic UI with integration assertions. Run existing UI fixtures in English and new bilingual fixtures.

## T3 — Unified themes
- [ ] Test palettes, safe local background, cross-window changes and disposal before implementation.
- [ ] Add one Language and appearance panel: System/Chinese/English, System/YAM Dark/YAM Light/Mocha/Nord preview cards, optional local background and strength, restore defaults.
- [ ] Replace app hardcoded colors with tokens; retain terminal explicit palette choices. Recolor existing default views directly without remount, resize or process write.
- [ ] Verify all menus/dialogs, find highlighting, main/secondary and minimum dimensions.

## Dependency packaging scope

The approved i18n dependencies also require the existing npm inventory, original license bodies and qualification records in `scripts/third_party_notices.py`, `scripts/test_third_party_notices.py` and `scripts/third-party-notices/**`. This necessary packaging work preserves the prior inventory and digest gates; an independent archive review qualifies the six new identities, including TypeScript third party notices.

## Native notification repair scope

Independent spec review found that lifecycle and agent-round notifications were still generated in English by the background owner. This requires the existing notification producers in `background.rs`, `lib.rs`, `agent_bridge.rs` and `system_entry.rs`, plus the trusted main-window command in `desktop_windows.rs` and `window-context.ts`. A finite locale value is synchronized to owner memory; notification delivery identity, acknowledgments, user titles, paths and raw errors remain unchanged.

## Installed GUI repair scope

Native GUI acceptance revealed nested menu items were not updated by the top-level lookup, the appearance header lacked the shared layout class, and a valid PNG background was blocked by the existing CSP. The bounded repair uses recursive action-ID caption updates, localized tray/confirmation text, the shared dialog header, and revocable blob image URLs using the existing file-preview pattern. The CSP remains unchanged. A separate boundary regression clears native appearance overrides for Follow system. Source changes invalidate earlier reviews; those receipts remain historical/uncovered until a final frozen-source review.

## T4 — Regression, review and installation
- [ ] `pnpm test:coverage`; `pnpm build` in apps/desktop.
- [ ] `cargo llvm-cov --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --fail-under-lines=85 -- --test-threads=2`.
- [ ] Fresh independent read-only spec then quality review of the task diff; repair confirmed scope defects using red/green tests.
- [ ] Build only canonical `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`, verify signature, install at /Applications/YAM.app, preserve single-instance behavior and safe update admission.
- [ ] Native acceptance: switch languages/themes while a dedicated Shell is running, retain PID/input/scroll/layout, ensure main/secondary synchronization and restart persistence. Stop only the dedicated test process; restore original user preferences.

## Evidence limits
Formal Converge Trace requires Node mutation and exact graph impact receipts that the installed toolchain may not support. Preserve that as uncovered instead of inventing a complete managed-state receipt; ordinary tests, review, build and installed GUI evidence remain mandatory. External terminal windows follow their own application settings. No real model prompt or public release is part of this task.
