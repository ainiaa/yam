# T08 current-package native owner RPC acceptance

Author: Jeff.Liu. Run date: 2026-10-03. This is one macOS synthetic PTY run, not GUI, real Agent, or notification acceptance. It reused the frozen T06 unsigned release package; no package rebuild, product change, permission change, Hook trust change, or real history cleanup occurred.

Invocation（原始文件已归档）, raw stdout（原始文件已归档）, raw stderr（原始文件已归档）, and result（原始文件已归档） record the actual run. It started at 09:54:51 UTC and exited 0; stderr is empty. The 09:55:20 result time is the post-run identity/hash/process check, not an exact process-duration measurement. The invocation and stdout contain no authentication token.

## Frozen identity and command

HEAD is `6b00a7dcad249c4fca90efbcdafdbc4a836ea8ec` plus the T05 dirty product source. T06 build receipt（原始文件已归档） and build command correction（原始文件已归档） bind the actual build, source, and package. The receipt does not provide a new embedded product revision. The package identifier is `com.yam.performance-validation-t06`; the actual `CFBundleExecutable` is `yam-desktop`.

- Product source SHA256: `56379e7671dd8b4b57b050e03f25d9c99e77c3ee2e3171e52a8830ebf4c3f94c`.
- Package SHA256: `f6546f95e2d53519e3cb90a7c055c25cbb51ba3c17b9d1a3b1129138c55c6929`.
- Runner SHA256: `1129e89467cf991b87c072d9e5fd61255242e6ffbec9627e83b418c4480979ef`.
- Receipt SHA256: `4506350ac9face9e18c2ce0e0a76485a86b0f5f2d1b1b025a0efbcd5230da56e`.

From repository root, the actual command was:

```sh
rtk proxy python3 scripts/background-platform-smoke.py --executable 'apps/desktop/src-tauri/target/release/bundle/macos/YAM Performance Validation T06.app/Contents/MacOS/yam-desktop' --identifier com.yam.performance-validation-t06 --receipt docs/evidence/yam-performance-t06/build-receipt.json
```

The validation profile was nonexistent immediately before this single run. It is now nonempty and preserved. This command must not be rerun against that profile, and the profile must not be cleared to enable another run. The only removed files were the runner's own temporary synthetic fixture.

Before any owner/PTY/GUI startup, explicit guards reject optimized Python, missing/corrupt/wrong-schema receipts, production or mismatched identifiers, a sibling executable inconsistent with `Info.plist`, changed product source or any package resource, and unsafe/nonempty validation data. Receipt-bound `--desktop` is rejected. The existing T06 validator is reused; commit/source-state descriptive fields are not separately authenticated by this helper. Package/product hashes were checked again after the run. Each owner start resets descriptor/client/confirmation and confirms status PID equals the newly launched child with `desktop_connected=false`; unconfirmed candidates receive no cleanup RPC. Notification context is paused before creating a synthetic session.

## Actual result and boundaries

| Check | Actual result | Scope |
|---|---|---|
| Client disconnect/reconnect | Same owner PID and one active synthetic session; marker advances | RPC clients, no GUI close |
| Unicode retained log/search/excerpt | `NATIVE_CONTINUITY 中😀` locates the same retained output after reconnect and owner restart | Current synthetic session |
| Input lease transfer | Holder claims with empty legal write, contender gets exact conflict, explicit takeover succeeds, old holder gets exact conflict | Two authenticated RPC clients, not two GUI windows |
| Explicit stop and cold owner restart | Final scene persists exactly; no active task returns | Owner restart, not App GUI reopen |
| Owner crash | Synthetic PTY stops; restored record is `needs_attention` and marker does not restart | No automatic task rerun; actual UI presentation untested |
| Explicit stop-all/shutdown | Final synthetic owner exits | No Cmd+Q or menu click |
| Identity and cleanup | Three distinct verified PID/instance pairs; all three PIDs absent at post-run check | Own launched children only |
| Notifications | Paused before each create | No send, banner, click, or permission acceptance |

The three verified owner PIDs were 26749, 26837, and 26846; full random instance identifiers are in raw stdout. Source/package/runner/receipt hashes match the frozen inputs; runner and test hashes did not change during the run. No authentication descriptor/token is published.

## Remaining native acceptance

| Item | Status and reason |
|---|---|
| GUI red close, ordinary Cmd+Q, GUI reopen and same owner | Unmeasured; this run never launched GUI. Legacy CI fixture `terminate` is not Cmd+Q |
| Real App keyboard, paste/copy, TUI resize/switch/control UI | Unmeasured; RPC lease and saved projection do not establish keyboard or clipboard behavior |
| Real Codex/Claude/OpenCode native conversation | Unmeasured; only self-created Python PTYs ran |
| Notification delivery/click/exit wake, foreground suppression UI | Unmeasured; notifications remained paused |
| Hook trust, notification/auxiliary permissions | Unchanged and untested; no permission request was authorized for this run |
| Windows/Linux real desktop and package | Unmeasured in T08; older CI samples remain historical evidence |
| Signing, upgrade, install-location and old notification identity | Unmeasured; unsigned isolated package is not formal distribution |

CUA inventory attempts timed out three times in the controlling session. This establishes automation unavailability, not a diagnosis of missing OS permissions. October 1–2 GUI/notification samples retain their original package/commit scope in [notification acceptance](../../notification-acceptance.md) and cannot be attributed to this current package.

## Verification

Test-first red evidence was independently reproduced before implementation: 23 tests compiled/executed with 13 failures and 3 errors, including real `main()` mocks showing unconfirmed-candidate shutdown and connected-desktop task creation. The minimal guard/confirmation/lease implementation then passed all 23 tests. Normal, boundary, error, optimized-Python, pre-start no-side-effect, timeout/restart cleanup, pause ordering, and exact lease-conflict cases are executable without native startup.

The final sequential checks passed: Python 80 tests, frontend 138 tests, tool TS lines/functions 100% and branches 98.69%, frontend build, and diff check. The existing >500 kB build chunk warning remains. Final frozen checks and their actual counts are recorded in validation（原始文件已归档）; hashes of this evidence directory are recorded in evidence index（原始文件已归档）. Rust product code did not change during T06–T08; previously executed fmt/clippy checks are cited from T06 validation（原始文件已归档）, not claimed as newly rerun T08 checks. Formal Converge coverage provider remains unconfigured.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
