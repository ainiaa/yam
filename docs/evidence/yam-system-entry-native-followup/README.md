# T11 native preference followup

Author: Jeff.Liu

This followup improves first-run behavior: an absent optional `system-entry.json` now returns shortcut disabled without an invalid-preference warning or writing a default file. The earlier contract allowed a warning; this is a behavior adjustment, not a persistence-corruption finding. Existing files still use the original private, no-follow, bounded reader. Only exact `NotFound` from no-follow metadata inspection selects the disabled default; other inspection errors remain invalid.

The task-only diff（原始文件已归档） changes the reader and regression tests only. The original roundtrip test changes its missing-file expectation; its remaining corruption, directory, symlink, permission and valid true/false assertions remain. New reader tests verify repeated absence without writes, existing malformed/oversized/extra-key sources, inaccessible path shape, dangling links, and unsafe modes. The initial semantic RED（原始文件已归档） had one genuine missing-file assertion failure and two direct-green safety tests. These host fixtures do not establish arbitrary filesystem race immunity or native OS shortcut registration.

The current source freeze（原始文件已归档） binds one source file. Fresh checks（原始文件已归档）: T11 targeted 22 passed; full Rust 448 passed and 2 ignored; fmt, locked Clippy and diff each exited 0. All checks observed the same source hash. No owner, GUI, Agent or native shortcut was launched for these checks. Source inspection retains the existing `if enabled` registration branch, so a false default requests no shortcut registration; this is not a native callback acceptance result.

Independent Root source review（原始文件已归档） and Astra source review（原始文件已归档） passed with no known finding in this scope. Both reviewed the exact task-only change; Astra inspected author checks and raw results without duplicating Cargo execution. Formal provider coverage remains uncovered; native shortcut callbacks and task-persistence acceptance remain separate. Existing T11/T13 evidence and the isolated native build snapshot were not rewritten.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
