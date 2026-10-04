# T14 fixed terminal panes — fourth candidate

Author: Jeff.Liu. This finite candidate implements fixed single, horizontal two, vertical two and grid four layouts. Native four-pane acceptance remains pending; T15 persistence is not included. The frozen plan（原始文件已归档） and its two fixture amendments remain controller-owned. Code freeze（原始文件已归档） records the current twelve source/test hashes; first candidate（原始文件已归档） remains unchanged.

The App keeps each visible pane's frame flight, viewport revision, positive viewport fit and owner resize separate. Per-view lifecycle/owner/attachment checks discard stale success/error/finally without changing another pane. Clicking a pane/header updates the actual selected terminal; forms and IME retain input protection. Normal Unicode/paste input requires actual terminal/window focus. The existing strictly limited live raw protocol response route and startup first attachment remain; cold projections cannot emit old responses. Backend leases remain authoritative, and layout/restore never auto-claims control or broadcasts input. Notification suppression is limited to actual terminal focus, not merely a selected or visible session.

Hide and layout shrink do not stop sessions or delete history. All visible ended scenes are protected both in cache admission and eviction. A pending Start reserves a hidden ended victim; its old scene survives until a replacement factory succeeds. A reserved victim cannot be made visible before attachment, and owner failure/unknown receipt/factory failure releases the reservation. Cache-full refusal occurs before owner creation. No new dependencies, backend/CLI changes, native processes or user repositories were used.

## Executed evidence and limits

| Evidence | Actual result | Boundary |
| --- | --- | --- |
| Initial actual App red（原始文件已归档）, boundary red（原始文件已归档） | 10 semantic failures, then 49 tests with 13 failures/36 passes | Executable actual callbacks, no import/compiler red |
| First candidate full coverage（原始文件已归档） | 231 passed | Did not cover the two later confirmed P2s |
| Hidden completion regression（原始文件已归档） | Actual readiness assertion failed | Legitimate replay completion must update readiness even while hidden |
| Protected admission regressions（原始文件已归档） | Two actual semantic failures | No owner create on protected-full cache; pending admission survives warm/layout changes |
| Second-candidate historical targeted（原始文件已归档） | 97 passed, exit0, 0.712s | Four files: layout/views/project-config/worktree-controls; mocked terminal and IPC |
| Second-candidate historical coverage（原始文件已归档） | 235 passed, exit0, 2.691s | Tool TS lines/functions100%, branches94.66%; layout91.67%, views98.08%; no React/Rust/native coverage claim |
| Third-candidate context red（原始文件已归档） | 3 actual semantic failures | Concurrent owner assignment model; not native IPC timing |
| Third-candidate historical targeted（原始文件已归档） | 100 passed, exit0, 0.821s | Original tests plus latest coalescing, blur/paused/reject and unmount |
| Third-candidate historical coverage（原始文件已归档） | 238 passed, exit0, 2.701s | Tool TS lines/functions100%, branches94.66%; layout91.67%, views98.08% |
| Actual initialization red（原始文件已归档） | 1 actual semantic failure | Initial preference effect before complete terminal setup effect lost persisted pause |
| Fourth-candidate targeted（原始文件已归档） | 101 passed, exit0, 0.780s | Four files; all earlier callback guards remain |
| Final planned coverage（原始文件已归档） | 239 passed, exit0, 2.697s | Tool TS lines/functions100%, branches94.66%; layout91.67%, views98.08% |
| Fresh build（原始文件已归档）, diff（原始文件已归档） | Both exit0 | Build retains the existing large-chunk advisory |
| fmt（原始文件已归档）, clippy（原始文件已归档） | Both exit0 | Backend source unchanged after these actual runs; no rerun claimed |
| Python first-candidate run（原始文件已归档） | 80 passed, 11.179s | Scripts and Python inputs unchanged; referenced, not rerun |
| Rust same-source receipt（原始文件已归档） | Prior T13 340 passed/2 ignored | Exact backend hashes unchanged; referenced, not a T14 cargo test run |

The continuous-output runner uses the actual App output listener and 100ms timer callback with synthetic frame/terminal/IPC data. Two and four sources each run 120 logical ticks, with one flight per pane and all cursors advancing; an additional selection tick leaves A unchanged while other panes update. It performs no write/create/stop/take-control calls. This is a Node simulation, not a wall-clock native long test, real PTY output, paint/latency measurement or native GUI acceptance.

The first App callback regression, controlled layout scaffold failure and focused-during-projection Unicode failure precede their fixes. Additional finite oracles that immediately passed are recorded as direct green. Fixture ReferenceError/TypeError closure gaps are not counted as feature TDD: first fixture gap（原始文件已归档）, admission fixture gap（原始文件已归档）. Approved changes inject production helpers/pools and keep original domain assertions. The first fixture amendment（原始文件已归档） and admission amendment（原始文件已归档） document this limited scope.

## Independent review history

Root independently observed the initial and boundary reds and first-candidate 63/63 targeted plus a separate 58/58 fixture run; these are two runs, not one 121-test run. Their original receipts are retained: targeted（原始文件已归档）, fixtures（原始文件已归档）. Astra's exact first-candidate reproductions and source-prefix failures are retained verbatim: hidden replay script（原始文件已归档）/log（原始文件已归档）, capacity script（原始文件已归档）/log（原始文件已归档）. Root independently reproduced both failures: hidden（原始文件已归档）, capacity（原始文件已归档）.

The hidden-completion fix updates legitimate parser readiness/firstAttachment/replay bookkeeping regardless of visibility, while mounting/inert UI stays visibility-gated. Protected-aware admission now matches open and preserves a reserved victim during an asynchronous Start. Formal second-candidate review closed both original P2s, then confirmed a notification context-order P2. The third candidate serializes context writes with one in-flight request and one latest focus/paused snapshot; obsolete errors do not update UI, queued latest survives failure, and unmount drops pending work. Root independently ran the third-candidate four-file suite: 100/100, exit0, 0.676s; twelve source hashes matched before/after with zero drift. Its raw log（原始文件已归档） and receipt（原始文件已归档） are retained separately from the author run and historical second-candidate 97. Third-candidate review confirmed an initialization P2 introduced by the mount guard: the notification preference effect runs before terminal setup, so persisted pause never reached owner on initial mount. The actual regression（原始文件已归档） failed before the one-line terminal-setup sync fix. Astra script（原始文件已归档）/log（原始文件已归档） and Root red（原始文件已归档） retain that source point in time; the third freeze（原始文件已归档） is unchanged. Root independently verified the fourth-candidate four-file suite: 101/101, exit0, 0.676s; twelve source hashes matched before/after with zero drift. Its raw（原始文件已归档） and receipt（原始文件已归档） describe the final current candidate; historical 100/97/63 counts are earlier candidates. Astra fourth-candidate closing review matched all twelve hashes, independently passed the original initialization reproduction 1/1 and four-file suite 101/101, and found no remaining P0/P1/P2. The initial-effect raw（原始文件已归档） and targeted raw（原始文件已归档） are retained verbatim. All three original P2s and the initialization P2 introduced by the queue fix are closed in this finite source scope; native acceptance stays pending.

The second-candidate context-order script（原始文件已归档）/log（原始文件已归档） confirms actual focus B while a late A request can overwrite the modeled owner selection. It is an actual App callback with deterministic owner-arrival model, not a native IPC timing experiment. The second-candidate freeze（原始文件已归档） and old checks remain unchanged. Three new actual regressions failed before the single-flight fix; the previous late-error test now schedules A rejection before B dispatch and keeps its no-error/latest-B assertions. Its old schedule failure remains in first fix run（原始文件已归档）, not counted as a new product defect.

Astra's reference-churn model（原始文件已归档）/log（原始文件已归档） found same-props rerender changed four host refs, scheduling four fits (16 pane fits/8 resize calls). This is a deferred nonblocking P3, not measured native speed or proven functional loss. No performance optimization is claimed.

Real native GUI four-pane visible continuous output, keyboard/paste, resize/paint, permission/Hook behavior and Windows/Linux remain unexecuted. Official Converge coverage-provider configuration is absent; these executable host checks do not substitute for that gate. T13 actual worktree cleanup remains pending. No native GUI probe was run and no task/history was stopped or deleted during T14 development.

## Controlled evidence reseal after generated-file audit

The first seal at 2026-10-03T16:55:18.689644UTC is retained verbatim in first-seal index（原始文件已归档）, with its original validation, end-source and documents. Root's subsequent whole-scope audit（原始文件已归档） failed only because an early author `tsc -b` invocation had generated four nonowned regular untracked files absent at T14 start: `tsconfig.node.tsbuildinfo`, `tsconfig.tsbuildinfo`, `vite.config.d.ts` and `vite.config.js` under apps/desktop. That failure is retained; it is not a business P2 or a prior successful scope audit.

Root alone backed up exact bytes and removed those four generated files, without changing `vite.config.ts`, configuration or ignore rules. The cleanup receipt（原始文件已归档） records backup paths/hashes and all twelve source hashes unchanged before/after. Root's canonical `rtk proxy pnpm --dir apps/desktop build` then passed exit0 in 1.398s: raw（原始文件已归档）, receipt（原始文件已归档）. All four files remain absent. The controlled reopen modifies only documentation/evidence to record these actual results and recompute the final index; the c32c1adc code freeze, tests and finite review result stay unchanged. Native acceptance and deferred P3 limits also stay unchanged.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
