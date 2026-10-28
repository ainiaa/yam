# YAM Session Basics Implementation Plan

> Execute sequentially in this workspace with Converge and test-first changes. Preserve the existing dirty baseline. No commit, public release, new dependency, or alternate GUI identity is included.

**Goal:** Restore a ready terminal directly, release safe ended views, and provide consistent creation, duplication and naming.

**Architecture:** Keep the native owner and its window/generation guards. Reuse New session and shared title metadata; a duplicate has its own process and native conversation. Source configuration, ChatGPT Desktop and unrelated running tasks remain intact during implementation.

**Tech Stack:** Existing Tauri, Rust, React, TypeScript, Node test runner and native WebKit checks.

Author: Jeff.Liu.

## Approved behavior

- One New session dialog, project context and existing Command+N. Enter starts the reviewed configuration.
- Duplicate session pre-fills that same dialog, retaining directory/program/provider/image mode/terminal appearance and presentation target where available. Never replay a prior task or reuse native conversation identity.
- Sidebar and tab share one manual title. Enter saves, Escape cancels, explicit reset restores the automatic title. Capture the selected target before editing, persist before closing, synchronize both windows.
- Hidden live tasks remain alive. Only ended, saved, idle views can release rendering claims. Never evade admission limits by stopping another task.
- Reopen must fit and focus the existing selected view without a manual tab switch. Tool accessibility failure is not equivalent to process failure.

## Sequential tasks

### T1 — Window restoration
- [ ] Reproduce restoration with actual App callbacks and positive-size DOM mounting.
- [ ] Retain an observed failing test.
- [ ] Fix the shared restoration boundary.
- [ ] Run terminal-layout-restore, terminal-layout and window-context tests.
- [ ] Record native window observation separately from deterministic checks.

### T2 — View capacity
- [ ] Reproduce full capacity with a safe ended hidden view.
- [ ] Test refusal, live protection, delayed release and failed release.
- [ ] Release native capacity before new admission without racing pending views.
- [ ] Run terminal-views, window-context and terminal-layout tests.

### T3 — Creation and duplication
- [ ] Test copy field selection, unsupported history, custom commands and secret references.
- [ ] Reuse New session with captured source settings and an independent launch identity.
- [ ] Add matching sidebar/tab actions without another primary New button.
- [ ] Run session-actions, unified-new-session and terminal-launch tests.

### T4 — Naming
- [ ] Test target switching, stale results, empty/long names, persistence errors and reset.
- [ ] Add one write-first shared name boundary accessible from either window.
- [ ] Reuse it from sidebar, tab menu and tab double-click.
- [ ] Run session-actions, sidebar-actions and window-context tests.

### T5 — Integration and installation
- [ ] Unify menu dismissal, translated errors and search Escape behavior.
- [ ] Run frontend coverage/build, native regressions and diff checks.
- [ ] Independently review scoped behavior and integration.
- [ ] Build one version-bound candidate, validate notices and signatures.
- [ ] Update /Applications/YAM.app and the canonical debug bundle, then restart and verify.
- [ ] Clearly report every native or external acceptance item that cannot be verified.

The validated Plan v6 and original source receipt are retained at `/tmp/yam-session-basics-20261023/`. Pending checkboxes do not claim completed verification.
