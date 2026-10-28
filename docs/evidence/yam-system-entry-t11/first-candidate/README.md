# T11 system entry evidence

Author: Jeff.Liu.

This candidate implements the full host vertical slice for owner tray/global shortcut and owner-authoritative pause. Native acceptance and the formal provider gate are pending; mock native callbacks are not native confirmation. [Product contract](../../yam-system-entry.md) describes the delivered scope.

Code freeze（原始文件已归档） binds 13 source/config/test files. Task-only diff（原始文件已归档） uses the SHA-verified [task-start capsule](task-start-capsule.json), not HEAD, which includes earlier uncommitted stages. The lib.rs initial copy is an explicitly verified reconstruction; other baseline files were copied before edits. The controlled agent-events fixture change only supplies the new pause callback dependency and preserves existing assertions.

Initial Rust 0/8 and three Node bodies were fixed-error/new-body placeholder RED, not baseline behavior failures. The initial actual App selected-only test was a genuine baseline integration RED: focus sent paused=true. Additional genuine semantic RED covered stale same-owner settings finally, owner replacement during conflict refresh, fresh-heartbeat/no-consumer Open delivery, migration before GUI snapshot/first heartbeat, newer pause event during initial read, and missing event-subscription rejection handlers. Compiler/private-symbol/type and AST harness failures are retained separately. Two old T14 pause-payload oracles were intentionally updated to selection-only; their original logs remain historical.

The first whole Node run's missing toggleNotificationPause fixture dependency is a harness gap, not feature TDD. Root's controlled amendment adds only agent-events.test.mjs; no agent-events production logic changed. No historical task evidence was edited.

[Dependency resolution](dependency-resolution.json) records the one actual graph resolution. Large raw metadata remains under /tmp with size/hash; repo evidence uses a bounded receipt. Subsequent Cargo checks use --locked. [Host Python wrapper](host-fixtures.py) skips exactly the existing native runtime-builder/codesign fixture and runs all other host tests. It does not claim unfiltered/native Python acceptance.

Final author checks: 19 targeted Rust tests; full Rust 428 passed / 2 ignored; host Python 99 run / 98 passed / 1 explicit native skip; Node 313 passed; standard frontend build, fmt, clippy and diff passed. TS aggregate lines/functions are 100%, branches 94.10%; system-entry.ts branches are 72.41%. Actual extracted App tests are not React/native coverage. The first clippy run failed on one equivalent nested validator condition; that raw and pre-clippy freeze remain historical, followed by fresh final target/full Rust/fmt/clippy/diff. Node/Python/build are actual same-input checks from before that Rust-only lint correction, not reruns. Independent source review remains pending this preview. No real owner, native GUI, Agent, Hook, permission or user namespace action ran.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../../development-artifacts.md)。
