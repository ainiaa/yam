# T20 GUI updater source candidate

Author: Jeff.Liu. This source slice connects the normal App Updates entry,
strict GUI-only configuration, bounded DTO/preference UI and the existing locked
Rust SDK2.13.1. Current updater configuration remains absent: no registration,
extension lookup or network occurs. Install always refuses. No real
request/download/signature/install, GUI/owner/Agent, key or publication was run.

Code freeze（原始文件已归档） maps six exact source/test hashes; the
task-only diff（原始文件已归档） uses Root's verified original bytes, not HEAD's
large prior uncommitted work. The [task-start receipt](task-start-receipt.json)
binds that original capsule. Independent source review is pending.

The first actual App button assertion failed because the Updates entry was
absent. New configuration/controller fixed-error scaffolds are labeled new-body
RED, not baseline behavior bugs. Compiler missing-Debug/private-BundleType and
unused-React build failures are harness/build records. Self-check semantic REDs
cover expired publication, exit publication before abort, unknown build context
and idle settings reopen; all are retained. Actual controller tests use injected
futures; injected SDK success validates only the signed-success boundary mapping.

A synchronous harmless test future proves cancellation/timeout stays cancelling
until exact join. Metadata/artifact redirect clients are HTTPS-only;15s/120s are
whole-operation acceptance/cancellation deadlines, not hard physical deadlines.
Observed/declared256MiB refusal is an acceptance bound, not a hard heap/network
cap. Transfer-finished cannot verify. Startup opt-out/StrictMode/unmount, old
success/error/finally, refresh and private-storage failure use actual App bodies.

Eight fresh author checks all exited0: targeted Rust17/17, Node15/15, full
locked Rust468passed/2ignored, whole Node337passed, standard frontend build,
fmt, locked Clippy-Dwarnings and diff. The first Clippy large-enum failure is
preserved; boxing the private SDK candidate changed layout only, then all eight
checks were rerun. Utility TS aggregate lines/branches/functions are
100%/92.07%/98.97%; updater.ts is100%/82.56%/91.30%. No threshold was relaxed.
The raw check receipt（原始文件已归档） binds each command/exit/timing/hash.
Independent source reviews are pending; native
SDK/deployment/signature/install and official provider acceptance remain pending.
Formal coverage preflight is uncovered; utility TS coverage does not cover React,
Rust or native GUI. User-supplied feed/key and installation compatibility/backup
remain separate deferred work. See [updater boundary](../../yam-updater.md).

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../../development-artifacts.md)。
