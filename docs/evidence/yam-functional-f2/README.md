# F2 adjustable split and pane swaps

Author: Jeff.Liu. F2 adds bounded split adjustment to Side by side and Stacked layouts, fixed-grid pane swaps, and version2 ratio persistence with version1 defaulting to 50 percent. Focus follows the swapped session identity; selected session and existing control state remain unchanged. Layout operations do not create or stop tasks or acquire input control.

## Final verification

The test-first actual App JSX → `TerminalLayout` → App guard regression failed before the disabled-polarity repair, then passed. The final targeted four-suite run passed 155/155 tests, the full Node run passed 392/392, and the independent focused Node run passed 8/8. The configured Node test coverage report for `src/*.ts` shows 100% lines, 92.56% branches and 98.99% functions. The desktop build and `git diff --check` exited successfully; Vite retained its advisory that one generated chunk exceeds 500 kB.

See the semantic RED（原始文件已归档）, focused GREEN（原始文件已归档）, 155-test targeted run（原始文件已归档）, 392-test coverage run（原始文件已归档）, independent 8-test run（原始文件已归档）, build（原始文件已归档）, source diff check（原始文件已归档）, final documentation diff check（原始文件已归档） and scoped documentation delta（原始文件已归档）. The R2 source review（原始文件已归档） passed; its actual UI wiring probe（原始文件已归档） covers horizontal, vertical and grid guard states. The compact evidence index（原始文件已归档） records hashes for the reviewed source, documentation, diffs, reports and raw checks.

## Review history and evidence limits

Earlier review findings on discrete-key/reset cancellation and grid swap entrypoints were fixed before the R1 source review. The R1 report's remaining finding was the App's “allowed” predicate wired directly to a `disabled` prop; R2 added a regression that reads the actual App JSX property and exercises the actual component and callbacks, then inverted the predicate at the App boundary. The R1 focused 8-failure RED and 10-pass GREEN output, plus its build and diff output, were tool output only and were not saved as raw files. Their history references are recorded in the evidence index; the contemporaneous independent report is [source-review-r1.json]. The R2 source-test freeze（原始文件已归档） preserves the current source and log hashes.

These results establish source behavior and mocked-IPC callback/component behavior. Native GUI interaction, packaged reopen, Windows/Linux behavior, F7 and the formal coverage provider were not covered. The TypeScript coverage figures do not claim React or native UI coverage. The full SourceReceipt remains in `/tmp`; this evidence package keeps scoped freezes and necessary raw checks rather than copying that full receipt.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
