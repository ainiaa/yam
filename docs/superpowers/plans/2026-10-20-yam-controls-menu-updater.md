# YAM dropdowns, native menus and automatic updates

Author: Jeff.Liu. Design approved in this chat on 2026-10-20.

## Approved scope

1. Replace all application select controls with the shared dark dropdown. Preserve original values, change callbacks, disabled choices and focus; retain the searchable model picker.
2. Group native menus into File/Edit/View/Session/Window. Reuse existing operations, native editing/window behavior and user shortcut mappings. Route each menu click to one focused YAM desktop webview. Closing a tab/view must not stop its task.
3. Check/download updates using public ainiaa/yam Releases, pinned YAM public signing key, signed version metadata and no downgrades. Only a user click may install; authoritative idle admission shares the task start lock. Hold task ownership while installing, join installation before exit, and recover failed macOS replacement from a local backup.
4. Run targeted and full regressions, independent read-only review, package/signature checks and macOS desktop acceptance. Install the candidate in Applications when idle. Public release publication requires separate approval.

## Implementation and verification

- T1: Select, selection policy and all 25 callers; actual callback, geometry and keyboard regressions plus existing caller tests.
- T2: Native menu construction, one focused window route, frontend dispatch and customized shortcut hints; reuse native editing and close/quit handling.
- T3: Periodic checks, automatic download, visible update status and explicit install; task-owner idle barrier, verified candidate admission, failure/restart behavior, signed artifact manifest preparation. No new external service or dependency.
- T4: Full frontend/native/Python checks and actual desktop acceptance. Report public release availability, developer signing/notarization and untested platform limits separately.

Machine-readable frozen plan and source baseline are retained in .git/convergent-delivery/plans/yam-controls-menu-updater-20261020.
