# T17 read-only events evidence

Author: Jeff.Liu.

The [CLI Events contract](../../yam-cli.md#read-only-event-subscription-t17) projects fixed lifecycle/phase/agent-count observations from the existing bounded relay. Actual background owner event listeners use a shared observation body: original GUI agent-state bytes are preserved, a separate safe hot-history snapshot is constructed after updates, and history locks are released before relay push. It does not lazy-initialize history or serialize inbox/native IDs/errors. Observations may coalesce; they are not exact historical business-commit replay. No App/lib/agent_bridge/Cargo/dependency change, new listener, consumer queue or production thread was added.

## Test-first stages

| Stage | Actual result | Receipt |
| --- | --- | --- |
| Core grammar/read-only/projection/cursor/writer scaffold |11tests:2directgreen/9semantic failures, compiled/executed |core red（原始文件已归档） |
| Authenticated stream, replacement, retry and actual-body cancellation |18tests:14pass/4semantic failures |stream red（原始文件已归档） |
| Wire-frame budget before decoding |1actual AssertionError failure before272KiB event transport cap |wire budget red（原始文件已归档） |
| Final finite targeted |21passed; one is the owned test-child entry fixture |targeted（原始文件已归档） |

The first private-field compile error remains in its harness files and is not semantic red. Initial hostile-file/flush cases passed only because the scaffold refused all requests; they were rerun against actual implementations. Missing-history/filtered high-water/single oversize cases and the last two actual-wire recovery/replacement cases were directgreen supplementary validation, not fabricated red.

Normal, boundary and error checks execute the actual owner observation/page bodies and authenticated mock TCP framing. They verify no desktop_connected/focus/input-lease mutation, original sequence/high-water progression,128-slot overflow paging and gap guidance, strict private1KiB cursor handling (unknown keys/version/instance/corruption/link/FIFO/nonprivate), ordered/deduplicated writes and flush-before-checkpoint, unchanged checkpoint on failed output, and bounded output with available history/relay locks. Same Client transport retry is exactly three attempts; a transient loss followed by success emits one original sequence. Initial and after-output descriptor replacement produce explicit stop, preserve checkpoint and never send to a new identity.

The Unix cancellation test spawns only its own current test-binary child, running the production stream body against a mock descriptor/transport. It sends SIGINT to that owned PID only; the parent mock owner still responds. It is not generic sleep offered as CLI proof, and it is not native packaged console/GUI/Agent acceptance. The child-entry test is counted in Rust's actual test total but is a fixture rather than a standalone feature oracle.

Code freeze（原始文件已归档） is current candidate2 and lists two source hashes. The following Root21 result is historical first-candidate evidence, not validation of the current freeze. Root independently21/21passed, unchanged before/after; Root targeted receipt（原始文件已归档） separates that check from author tests. Root independently reproduced both semantic red stages; their original logs and controlled D12–D15 seam receipt remain in this directory. The first candidate completed Rust399/2ignored, Node252, Python80, frontend build and fmt, but clippy exited101 on two cfg(test) lint violations. Its logs and original freeze remain in first-candidate（原始文件已归档）. Formal review found two production P2s despite first21tests passing: a busy history/record lock silently lost the last snapshot, and four legitimate AgentState phases became unknown. Three actual regressions failed before fixing them; review red（原始文件已归档） and independent Root red are preserved. The phase red stopped at the first `response_finished` case; after the fix all four real apply/event subcases executed and passed.

The observer now appends a fixed CLI-only unavailable marker on initialized-history contention/recovery uncertainty; projection emits the existing safe gap line with snapshot_required. It leaves original GUI bytes and global Relay.lost unchanged. A small shared phase whitelist retains response_finished/needs_permission/needs_attention/interrupted. No thread, queue or framework was added. Tests holding manager.history and records guards release them without a later event and still receive explicit CLI-only gap guidance. Missing history remains uninitialized.

Author final24tests passed (one child-entry fixture). Fresh affected checks: Rust402passed/2ignored,76.36s execution/77.343s wall; fmt0.229s, clippy3.068s, diff0.017s all exit0. Node252/Python80/frontend build are the actual same-input first-candidate checks, not reruns. Utility TS coverage100%lines/functions95.08%branches does not cover React/Rust. Root independently24/24passed and confirmed the two P2s closed; Root final receipt（原始文件已归档） and review（原始文件已归档） separate its evidence from author tests. Astra independently24/24passed with two source hashes unchanged and no confirmed remaining P0/P1/P2; Astra final receipt（原始文件已归档） preserves that proof.

## Limits

No real owner, Agent, GUI, user namespace, Hook, permission or frozen T06 package/data was used. No raw terminal/output/error/prompt/native receipt/turn/token event is sent to stdout. A private cursor stores its opaque owner witness only for reconnection. Slow stdout blocks only this client after receipt of one bounded RPC page; owner relay overflow becomes an explicit gap. Across abrupt death after stdout but before checkpoint, duplicates are possible and exactly-once output/disk atomicity is not claimed. Native three-platform package, Ctrl+C and real Agent delivery acceptance remain pending; official provider gates were not executed.


## Final seal

Validation（原始文件已归档） distinguishes fresh affected checks, same-input references, independent reviews and unexecuted native/provider gates. End receipt（原始文件已归档）, document/integrity check（原始文件已归档） and evidence index（原始文件已归档） seal finite source/docs/artifacts, excluding the index's own hash. Source remains at the second freeze; the first candidate and failures are historical, not overwritten. Host source review is closed; native packaged GUI/Agent/console acceptance remains pending.


Final source/doc/artifact integrity checks returned no errors; all evidence JSON parsed. Source remains frozen at candidate2. Final doc diff check is recorded in validation. No SDK or next-task work is included, and all workspace writes stop after this seal.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
