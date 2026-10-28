# T10 terminal preferences and navigation

Author: Jeff.Liu. Date: 2026-10-03. This bounded working-tree change uses existing xterm options, local preferences, terminal views and App actions. No dependency, owner RPC, native/Rust business code, user task, Hook trust or system permission was added or changed. [User guide](../../../apps/desktop/README.md).

## Implemented behavior

Font family is bounded to 200 UTF-16 units and rejects controls; whole font size is 10–24; dark/light/solarized are finite built-in terminal themes. The existing 13px font and 1.35 line height remain defaults. Save persists validated preferences; Cancel never saves. Missing preferences are normal, invalid/unavailable preferences fall back with a visible alert. Cached instances receive options and fit; constructor reads current options, without disposing/recreating running terminals. Viewport revision invalidates an older frame request.

Owner size requests remain the existing resize_session RPC. Each view has one in-flight request and one latest pending size. Readonly/unattached/disposed/zero-size views cannot send. Disposal, detach, owner/lifecycle change and writable loss during an await drop queued work and suppress stale dirty/error writes. Writable is only the last confirmed frontend state: explicit new/continued first attachment, write success or explicit Take control confirmation. Rejection clears it. The backend input lease remains authoritative; this is not a concurrent lease ownership proof and preferences never issue take_terminal_control. First attachment still synchronizes its initial dimensions.

The finite palette filters without executing and uses existing new/previous/switch, session/log search, inbox, eligible Continue, diagnostics and settings actions. Results use loaded history and cap 100. Ordinary text/select/contenteditable input, IME, repeat, dialogs and shortcut editing are protected; non-IME terminal focus can use the shortcut. Existing configurable P takes priority over the new P binding, with a button conflict explanation. Search does not stop/delete/re-run tasks.

Pins cap 100 local IDs and sort within the loaded project group; they do not retain extra terminal renderers. Permanent deletion receipts remove only matching pins from state/storage through the shared cleanup callback, including recovery refresh. Ended-close accepts actual succeeded/failed/stopped/needs_attention statuses only with a verified persisted scene and no parsing/updating; it releases only the target renderer and pending UI state, preserving pins/history/other views. Run again and Continue stay distinct explicit actions.

## TDD and evidence

| Stage | Actual result | Evidence |
|---|---|---|
| Pure API tests and fixed error skeleton, loaded successfully |9 failed, exit1; independently confirmed by root|Initial red（原始文件已归档）|
| Actual App input handler |input invoked preventDefault/stopPropagation/attention unexpectedly; assertion red, not a task-stop call|Input red（原始文件已归档）|
| Constructor/options, viewport, queue and TTY palette |14 tests:8 passed/6 failed; constructor13 versus20, TTY palette missing, input stolen, viewport0 versus1 and queue stub behavior|Integration red（原始文件已归档）|
| Actual permanent pin cleanup and ended-close callback |2 failed, exit1|Pin/close red（原始文件已归档）|
| Settings UI plus existing integration |16 passed/1 missing actual UI assertion failed|Component red（原始文件已归档）|
| Real terminal statuses, close guards, existing P shortcut and await invalidation |19 tests:14 passed/5 failed; independently checked by root|Boundaries red（原始文件已归档）|
| Readonly and await-lost writable |2 assertion failures, exit1|Lease red（原始文件已归档）|
| Actual App resize and explicit takeover selection |2 failures, exit1|App lease red（原始文件已归档）|
| Explicit first attachment |false writable versus true, assertion red|First attachment red（原始文件已归档）|
| Preserve original line height and release only target pending caches |separate actual constructor/close assertion reds|Line height（原始文件已归档）, Target pending（原始文件已归档）|
| Final four targeted files |87 passed, exit0|Targeted green（原始文件已归档）|

The first constructor extraction syntax error and initial hanging resize-test interruption were corrected before the preserved semantic red runs; they are not red evidence. Import error（原始文件已归档） was a missing .ts extension and is not behavior red. Parsing/updating negative cases were initially protected by the unsupported-status predicate; their passing coverage after fixing the actual status set is not a fabricated independent red. Existing App extraction fixtures required injected new pin refs and actual resize/fit helpers, documented by the controller’s scope amendment（原始文件已归档）; original protocol/domain assertions remain, with a pending resize reversal awaited through the real single-flight helper. The early full Node log（原始文件已归档） retains those fixture failures; the later keyboard fixture failure（原始文件已归档） was fixed by injecting the real palette helper into the already owned agent-events fixture, preserving its original assertions.

These tests invoke production module code, extracted/transpiled actual App callbacks, actual JSX functions and synthetic xterm/storage/IPC fixtures. They are not full mounted React coverage or native GUI/PTY acceptance. No real preference store/task was modified. T09 late callback guards remain covered by the final whole frontend suite.

## Final checks and boundaries

Frozen order: Rust tests, frontend coverage, Python, frontend build, fmt, clippy, diff. Validation（原始文件已归档）, code freeze（原始文件已归档） and evidence index（原始文件已归档） record actual facts. Tool TypeScript coverage excludes App/React and Rust; official Converge coverage provider is unconfigured. Native GUI font rendering/keyboard/clipboard, real Agent CLI/Hook/permissions and Windows/Linux remain unverified. The previous T08 native package does not contain T09/T10 product changes and was not rebuilt/launched here. This task does not start T11.

Final input-boundary check also observed an actual App assertion red for HTML `contenteditable=""` with the new P key (red（原始文件已归档）); the guard now accepts any editable attribute except false, preserving ordinary input/select/textarea/dialog protection. The final whole frontend suite passes the corrected callback and the earlier T09 generation regressions.

Final host checks: Rust275 passed/2 existing native fixtures ignored (64.39s); final Node181 passed, including23 settings/palette/App tests plus the new first-attachment test, tool lines/functions100%, branches97.46% (terminal-settings100%, command-palette97.62% branches); Python80 passed (10.570s). Frontend build, fmt, clippy and diff returned exit0, with the existing large-chunk warning. Python completed before frontend build. Rust was actually executed in T10 and its unchanged source SHA matched T09; its result is reused after the last frontend-only selector/test change, not described as another Rust rerun.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
