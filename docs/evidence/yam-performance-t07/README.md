# T07 terminal refresh candidate decision

Author: Jeff.Liu. Date: 2026-10-03. Decision: **retain the existing implementation**. T07 delivers a source-backed candidate assessment, not a product optimization or a passed App performance target.

This assessment uses the closed [T06 evidence](../yam-performance-t06/README.md), its unchanged build receipt（原始文件已归档）, and the controller's final T06 workspace fingerprint `27164fba85c9007c958cbcf99b19332856a02a61873fdebd49b43b55d30cf881` (`/tmp/yam-t06-end-source-final.json`, HEAD plus dirty tree). The measured package remains `f6546f95e2d53519e3cb90a7c055c25cbb51ba3c17b9d1a3b1129138c55c6929`; it was not rebuilt for T07.

## What the measurements establish

| Frozen T06 observation | Three-round p95 | Limit of inference |
|---|---|---|
| Warm terminal-module selection | approximately 3 / 2 / 2 ms | Native WebKit fixture, verified write callback; not actual App selection, fit, RPC, PTY resize or visible UI timing |
| Forced ended-scene cold restoration | approximately 15 / 16 / 17 ms | Static ended-scene experiment that deliberately releases hidden views; not the App's live cache behavior or a production improvement |
| PTY input → production projection → WebKit two-rAF | 101 / 101 / 100 ms | Includes HTTP/owner RPC and the existing 50 ms probe polling wait; cannot attribute this p95 to projection or claim App keyboard latency |

The raw, unrounded values and 100 sequences per mode/round are in the renderer summaries（原始文件已归档） and input summaries（原始文件已归档）, with rounds 2 and 3 beside them. The 361-point owner curve（原始文件已归档） measures background memory/CPU under 16 synthetic outputs; it does not supply an App warm-selection comparison. Empty-GUI samples were partial; real App input/switching and normal Cmd+Q remain unmeasured.

## Candidate and correctness boundaries

Independent Astra review identified a **same-size terminal-service revision candidate**. These current source observations support investigating it, but do not establish a user-visible bottleneck or benefit:

- [App.tsx](../../../apps/desktop/src/App.tsx), line 802: after selection, the animation-frame callback fits the terminal, calls `resize_session` for a nonterminal record and then marks the view dirty.
- [terminal-service.cjs](../../../apps/desktop/terminal-service.cjs), line 56: `resize` validates dimensions/budget, calls the terminal resize and increments revision, including a request with unchanged dimensions. Output writes (line 52) and viewport operations (line 59) have their own revision progression.
- [lib.rs](../../../apps/desktop/src-tauri/src/lib.rs), line 2646: native resize synchronizes parser and PTY, retaining a prior snapshot and rolling the parser dimensions back when PTY resize fails. A future service-only revision candidate must not skip this Rust PTY synchronization or its validation/rollback.
- [background.rs](../../../apps/desktop/src-tauri/src/background.rs), line 652: both resize and write require the active session and input lease. Same dimensions are not authorization to bypass ownership.
- App recovery (line 490) clears `ready`, cursor and first attachment, and advances lifecycle/viewport guards. A revision optimization must preserve output/viewport progression, instance/lifecycle isolation and this `ready=false` recovery path. Existing [frame tests](../../../apps/desktop/tests/terminal-frame.test.mjs) and [view tests](../../../apps/desktop/tests/terminal-views.test.mjs) cover these contracts; they are not new T07 performance evidence.
- App's **Take control** handler (line 1171) invokes `take_terminal_control` and focuses the terminal; it does not immediately synchronize dimensions. This assessment does not claim that missing synchronization is implemented.

## Why the baseline is retained

The approved threshold requires at least three comparable actual-App rounds, including 100 warm selections at fixed dimensions, with at least 15% target improvement and no other key p95 regression above 10%, while preserving terminal and ownership semantics. There is no such before/after App evidence. Module switching and polling-inclusive input results cannot substitute for it. Therefore no candidate is applied, and no optimization or performance-target success is claimed. **Lack of qualifying evidence does not disprove the candidate's potential benefit.** The candidate remains pending native-path measurement; T07 does not add probes, dependencies, product changes, forced GC, live-view release or reduced scrollback.

This document and the capability-matrix progress note are the only T07 changes. Validation is limited to local links, source anchors, exact numbers against the frozen T06 summaries and `git diff --check`. No business behavior changed, so no empty tests or repeated full test suite is reported as T07 validation. T06's existing full checks remain historical evidence, distinct from this assessment.

Actual validation on 2026-10-03: the stdlib document check passed 62 local links across this README and the matrix, six T06 summary files and eight exact source anchors. All 800 T06 indexed evidence files and nine measurement/test script hashes remain unchanged. The final T06 controller fingerprint matches the cited value. `rtk proxy git diff --check` exited 0. No performance probe or full test suite was run for this document-only decision.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
