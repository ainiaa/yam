# F3 read-only Git changes

Author: Jeff.Liu. The current repair2 source passed independent Root and Astra reviews. Native GUI, F7 and formal provider coverage remain pending.

The explicit **Git changes** entry reads the current project directory. It lists staged/worktree changes separately and shows untracked names only. A selected tracked file can show its staged or worktree patch; binary, unsupported conversion and submodule uncertainty have explicit results. The path reads existing private-shadow Git state with fixed arguments and never writes the user's Git files or takes terminal input control.

Queries share the existing two-second deadline and cumulative 1 MiB subprocess/read budget. Limits are 4,096 rows, 4,096 UTF-8 bytes per path, 256 KiB patch and 1 MiB final serialized DTO. These are accepted-output bounds, not a hard memory cap. Cancellation is authenticated owner/client/query scoped; short runner wait slices do not promise end-to-end ten-millisecond cancellation under worker saturation. Busy queries expose explicit Retry. Directory/owner/selection/close/unmount fences keep old success/error/completion from replacing the current panel; the latest pending query waits for the existing flight to settle.

## Current checks

- Fresh repair2 frontend: 22 targeted（原始文件已归档）, 405 full Node coverage（原始文件已归档）, standard build（原始文件已归档） and diff（原始文件已归档）, all actual exit0.
- Unchanged Rust inputs: 16 targeted（原始文件已归档） and one quiet locked full Rust run（原始文件已归档）: 485 passed, 0 failed, two existing ignored, 100.14s test execution / 101.441s wall. Fmt（原始文件已归档） and Clippy（原始文件已归档） also exited0. Repair2 only changed TypeScript validator/test bytes; these are references to the exact unchanged three Rust inputs, not new runs of the final nine-file/whole snapshot.
- Actual shared Client two-RPC tests cancel a quiet owned temporary child while the sessions lock is held. Actual App/component callbacks cover entry, render-time scope and late-response behavior. Synthetic DTO tests execute production validation/controller and the sole production return helper. These do not replace native GUI or three-platform acceptance. Configured Node coverage is TypeScript coverage, not React/native coverage.

Current nine-file freeze（原始文件已归档）, task-only patch（原始文件已归档）, Root current review（原始文件已归档）, Astra current review（原始文件已归档） and checks（原始文件已归档） bind this candidate. The fingerprint is explicitly scoped, not a whole-workspace SourceReceipt. Task origin（原始文件已归档） records verified original bytes retained in tmp without copying the large dirty tree.

## Failure and review history

Origin classification（原始文件已归档） separates genuine baseline entry/schema failures, fixed-error new-body scaffolds, harness incompatibility and direct-green boundary coverage. The missing App entry, duplicate cancellation, hidden submodule uncertainty and argument-name binding were tested before their fixes. Existing metadata tests and all assertions remain.

The first source reviews（原始文件已归档） and Astra report（原始文件已归档） found pre-passive-effect old patch/control visibility and a final path replacement exceeding the DTO cap. Repair1 component RED（原始文件已归档） and actual final-return RED（原始文件已归档） preceded the fixes. The first DTO fixture put too much padding in one path; its separate harness failure is retained. The fixed helper is the sole actual production return path; that synthetic boundary test is not an executed Git fixture. Root repair1（原始文件已归档） and Astra repair1（原始文件已归档） passed those changes. Closing/reopening the same scope was an additional direct-green control.

A later frontend cap review（原始文件已归档） found a legal 4,096-row / 970,858-byte DTO rejected by invented per-row overhead. Repair2 actual validator/controller RED（原始文件已归档） observes both false validation and unavailable state. The minimal repair keeps a safe raw-field lower bound and the final exact JSON cap: 970,858 bytes and exactly 1 MiB pass, while one additional byte fails. Previous freezes/checks remain historical, not current validation. Raw origins（原始文件已归档） records original bytes/SHA and any lossless gzip copies; the large failure payload is preserved without a full-source capsule.

No real owner/Agent, native application or user repository was launched or modified by this stage. Automatic updater follow-up and license batch02 stay paused. This archive is sealed for independent artifact audit; it does not claim native or formal-provider completion.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
