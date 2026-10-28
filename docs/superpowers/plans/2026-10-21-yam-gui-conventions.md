# YAM GUI conventions implementation plan

> Execute sequentially in the current workspace; user approved this design and implementation on 2026-10-21.

**Goal:** Correct the seven reported GUI defects and modal stacking without changing provider isolation or terminal ownership safeguards.

**Architecture:** Reuse the existing Select geometry and menu styling for an editable combobox. Keep settings sections and persistence callbacks independent inside one bounded scrolling body. Keep native session reservations/epochs and notification ownership intact for both windows.

**Tech Stack:** Existing React, TypeScript, Tauri, Node test runner. No new dependencies.

## Approved design and acceptance

1. Font and size each use a single editable combobox. Font matching is case-insensitive over the existing font presets; custom font families remain valid. Font size remains integer 10–24. Line height uses the same editable control with its existing range.
2. Terminal settings has a fixed header and close control, a single scrollable body and compact sections. Per-section save scope and validation remain unchanged; no duplicate Cancel buttons. Existing drafts are not applied on close.
3. Show one coherent whole-window empty state; split empty panes retain their own guidance. Do not display a fabricated root project or unrelated Git state.
4. Available installed CLIs can be selected and launched from either window. Preserve reserve/create/ownership, startup failure, provider configuration and existing tasks. Missing CLIs still show a reason and cannot launch.
5. Sidebar New session is the primary visible entry; remove topbar, project-row and whole-empty-state duplicate new buttons. Preserve shortcuts and native menu.
6. Action menus close on outside pointer/focus, Escape, or enabled action; one menu opens at a time. Disclosure sections are unaffected. Move tab commands are direct menu items.
7. Native menu/settings openings do not stack unrelated modals. Never cancel an in-flight irreversible/busy operation to open another dialog.

## Sequential implementation and regression

- [ ] Add executable regressions before source changes: component callbacks for input/search/selection/IME/keyboard/blur, real menu event listeners, dialog transition refusal, App startup policy and empty-state rendering.
- [ ] Run `node --test tests/gui-conventions.test.mjs tests/terminal-settings-ui.test.mjs tests/new-session-ui.test.mjs` from apps/desktop; retain missing-behavior failures.
- [ ] Implement shared editable combobox and menu/modal policy; integrate settings, profile controls and App/TerminalLayout callers.
- [ ] Enable auxiliary-window CLI creation through existing reservation boundary; verify provider payload, exactly one creation, failure and stale epoch behavior.
- [ ] Run targeted suites, full frontend tests and `pnpm build`. Run relevant native window tests; collect native coverage where feasible without installing dependencies.
- [ ] Review full scoped diff against the approved acceptance, then perform fresh read-only review per Converge. Record tool/trace/mutation gaps without claiming formal complete.
- [ ] Build only the designated YAM.app. Check app id/signature; install and reopen only after verifying task safety.
- [ ] Exercise real main/secondary windows, font search/custom input, size bounds, scrolling at small window size, menu dismissal, modal replacement, new-session choices and terminal input/search.

## Evidence boundary

Initial GUI examples are the four user screenshots attached on 2026-10-21. Code inspection confirms split controls, nested modal states, two empty-state layers, explicit auxiliary CLI prohibition and non-dismissable details menus. `/tmp/yam-gui-conventions-20261021/contract.json` binds baseline and scope snapshots. Existing unrelated dirty files must not be reset or committed.
