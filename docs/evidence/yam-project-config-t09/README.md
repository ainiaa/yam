# T09 trusted project launch configuration

Author: Jeff.Liu. Date: 2026-10-03. This working-tree feature adds optional version-1 `yam.json`, application-private defaults, explicit preview/trust, named tasks, owner-side revalidation, and environment references. The [desktop guide](../../../apps/desktop/README.md) describes schema and user actions. No dependency, new Adapter/command DSL, automatic command, real user configuration, Hook trust, or system permission was introduced or changed.

## Behavior and integration

A project is first previewed. Trust approves the exact bounded file bytes for a canonical directory and physical root identity; it does not launch anything. Start session remains explicit. File changes, another same-named root, or physical root replacement require approval again. An alias of the same physical root shares trust. The owner rereads `yam.json` at the actual start preflight; a cached GUI preview cannot bypass it. Removing or moving an approved source also rejects the explicit project request instead of silently falling back. Optional no-file manual launches remain compatible.

Precedence is this session's explicit UI edits > selected trusted template/project defaults > private application defaults. Empty argument/prompt/command overrides are retained. The App displays derived project fields without calling global preference setters; the launch request transmits only the edit map, not every initialized UI field. Project values do not silently become application defaults. A separate button saves manual fields to the private global preference file. Actual owner-returned command/launch data supplies the session title, so stale manual/global commands cannot label a project task.

Existing AgentLaunch and the literal argv builder remain in use. Custom command text is passed unchanged to the existing shell builder. Environment entries map a target name to an existing owner variable name, not a value or a shell template. Values are injected only through builder.env, not persisted, returned, or used by YAM to substitute command strings. User-requested shell expansion keeps its original semantics. `.env` is not read. All `YAM_` source/target names are denied case-insensitively, including the Windows `YAM_CUSTOM_COMMAND` trampoline.

Limits: 64 KiB source; 32 templates and 32 environment references; 128-character variable names; 1 MiB private preference file with 16 trusted roots. Configuration reads are bounded and reject symbolic links/reparse points. The private preference file uses a private create-new temporary file, sync, atomic replacement, and Unix parent sync; resolved env values never enter it. A configured cwd is an existing relative subdirectory inside the canonical project root with no `..` traversal. Missing CLI/env, unsupported fields/version, duplicates, malformed arguments, or cwd errors reject before a new project launch reaches history/session-ID/PTY/log/Bridge allocation.

The actual Tauri entry retains existing manual/resume fields and forwards an optional project request to the owner. Legacy requests omit that field; an older owner's unsupported project RPC is reported without auto-replacing the owner or rerunning active tasks. Private preferences and project validation do not change global CLI settings.

## TDD evidence

| Stage | Executable result | Raw evidence |
|---|---|---|
| Initial module/API behavior, compiled Rust | 15 failed, exit101; no compilation error counted | Rust red（原始文件已归档） |
| Initial TS/API behavior, successful module load | 8 failed, exit1 | Node red（原始文件已归档） |
| Reserved trampoline/custom-env/pending cancel | Rust16 failed; Node9 failed against error skeleton | Rust review red（原始文件已归档）, Node review red（原始文件已归档） |
| Owner shared entry ordering | Expected config rejection, actual allocation-boundary marker; assertion red | Entry red（原始文件已归档） |
| Exact RPC shapes | 17 passed, new unsupported get_launch_defaults assertion failed | RPC red（原始文件已归档） |
| Actual App action | Expected owner projectConfig request, actual undefined; assertion red independently confirmed | App red（原始文件已归档） |
| Actual preview JSX | Missing explicit Trust button; assertion red | Preview red（原始文件已归档） |
| Missing trusted source | Deletion reached allocation and produced assertion red; rename-away is also checked after the same fix; explicit project path now requires a present file | Missing source red（原始文件已归档） |
| Global preference scalar type | Array adapter/mode incorrectly passed type guard; assertion red, now requires strings | Type guard red（原始文件已归档） |
| Actual App title | Actual stale `old` vs expected owner `new`; assertion red | Title red（原始文件已归档） |
| Module/RPC/owner expansion | 19 passed | Owner/module green（原始文件已归档） |
| TS state, extracted App action and actual JSX | 12 passed | UI green（原始文件已归档） |

The initial Rust test NUL escape had a syntax error and was corrected before the recorded compilable red run; this error is not TDD evidence. Additional owner changed/env/cwd/CLI and valid-allocation-boundary cases directly passed the already fixed shared guard; they are coverage expansion, not fabricated additional reds. Root's independent first-red receipt is retained（原始文件已归档）.

The owner entry tests invoke the same owner-body function used by the Tauri command with None AppHandle; one fixed test-only boundary returns before any AppHandle use. Invalid cases assert no boundary hit, no session-ID increment, no HistoryStore/session allocation, and unchanged own private fixture files. A valid case proves the boundary marker is actually hit. The CLI-missing hook is thread-local, cfg(test)-only and restored by Drop; real PATH/CLI are untouched. This validates call order, not real PTY or GUI execution. Environment/canonical/source tests use real self-created files; literal argv tests inspect the production builder. App action tests execute extracted/transpiled production startSession with mocked invoke; JSX tests render the actual preview function and click callbacks. These are not a full mounted/browser App or native keyboard test.

## Acceptance boundaries and checks

Real GUI configuration/trust/launch, real Agent CLI/Hook integration, system notification/auxiliary permissions, and Windows/Linux native file-identity/permission/shell paths remain unverified. All runtime tests use their own synthetic fixtures; no real project or application preferences were altered. The earlier T08 package owner RPC and October 1–2 GUI samples belong to those builds, not this newly changed product source. No new native package was built or launched for T09.

Final checks follow the frozen sequence: Rust tests, frontend coverage, Python, frontend build, Rust fmt, clippy, diff. Validation（原始文件已归档） records actual results/counts and scope; index（原始文件已归档） records bounded evidence hashes. Tool TS coverage excludes React and Rust; official Converge coverage provider remains unconfigured and is not claimed.

First-candidate frozen-source host checks: Rust275 passed/2 existing native fixtures ignored (20 T09 tests); Node150 passed (12 project-config tests), TypeScript tool lines/functions100%, branches96.79%, project-config.ts branches81.08%; Python80 passed. Frontend build, fmt, clippy and diff all returned exit0. The existing >500 kB chunk warning remains. Python completed before frontend build. Code freeze（原始文件已归档） binds the exact code/test files; it is a specific file manifest, not the controller’s whole-workspace fingerprint.

## First review repair

The first candidate is retained in first-candidate（原始文件已归档）, including its README, validation, index and code freeze. Those snapshots describe the earlier source and checks. Astra reproduced the actual App race: A preview pending, cwd changed to B, B completed, user selected Chosen and opted out, then late A reset B’s template/use state. The actual App callback regression observed seven failed test results (two parent tests and five subtests), red（原始文件已归档）. The minimal App ref supplies one shared generation to read/approve/cancel/cwd/unmount; success, catch and finally write UI only if still current. Helper cancellation is retained. The same actual callbacks and cwd effect now pass all seven results green（原始文件已归档）, including stale errors and clearing a newer busy state.

After the repair, Node157 passed (14 project-config top-level tests plus five review subtests), tool lines/functions100%, aggregate branches97.08% and project-config.ts83.78%; frontend build and diff actually reran successfully. Rust/Python sources and scripts did not change, so the prior actual Rust275/2 ignored, Python80, fmt/clippy records are referenced at the same hashes instead of claimed as rerun. Current validation（原始文件已归档） labels reused versus rerun checks. The code freeze identifies the only two changed code/test files in this review. Native acceptance boundaries remain unchanged.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
