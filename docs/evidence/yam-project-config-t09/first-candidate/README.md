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
| Initial module/API behavior, compiled Rust | 15 failed, exit101; no compilation error counted | [Rust red](yam-t09-rust-red.log) |
| Initial TS/API behavior, successful module load | 8 failed, exit1 | [Node red](yam-t09-node-red.log) |
| Reserved trampoline/custom-env/pending cancel | Rust16 failed; Node9 failed against error skeleton | [Rust review red](yam-t09-review-rust-red.log), [Node review red](yam-t09-review-node-red.log) |
| Owner shared entry ordering | Expected config rejection, actual allocation-boundary marker; assertion red | [Entry red](yam-t09-entry-red.log) |
| Exact RPC shapes | 17 passed, new unsupported get_launch_defaults assertion failed | [RPC red](yam-t09-pre-rpc-red.log) |
| Actual App action | Expected owner projectConfig request, actual undefined; assertion red independently confirmed | [App red](yam-t09-app-red.log) |
| Actual preview JSX | Missing explicit Trust button; assertion red | [Preview red](yam-t09-preview-ui-red.log) |
| Missing trusted source | Deletion reached allocation and produced assertion red; rename-away is also checked after the same fix; explicit project path now requires a present file | [Missing source red](missing-source-red.log) |
| Global preference scalar type | Array adapter/mode incorrectly passed type guard; assertion red, now requires strings | [Type guard red](global-types-red.log) |
| Actual App title | Actual stale `old` vs expected owner `new`; assertion red | [Title red](yam-t09-title-red.log) |
| Module/RPC/owner expansion | 19 passed | [Owner/module green](yam-t09-entry-coverage.log) |
| TS state, extracted App action and actual JSX | 12 passed | [UI green](yam-t09-ui-final-green.log) |

The initial Rust test NUL escape had a syntax error and was corrected before the recorded compilable red run; this error is not TDD evidence. Additional owner changed/env/cwd/CLI and valid-allocation-boundary cases directly passed the already fixed shared guard; they are coverage expansion, not fabricated additional reds. Root's independent first-red receipt is [retained](yam-t09-root-red-verification.json).

The owner entry tests invoke the same owner-body function used by the Tauri command with None AppHandle; one fixed test-only boundary returns before any AppHandle use. Invalid cases assert no boundary hit, no session-ID increment, no HistoryStore/session allocation, and unchanged own private fixture files. A valid case proves the boundary marker is actually hit. The CLI-missing hook is thread-local, cfg(test)-only and restored by Drop; real PATH/CLI are untouched. This validates call order, not real PTY or GUI execution. Environment/canonical/source tests use real self-created files; literal argv tests inspect the production builder. App action tests execute extracted/transpiled production startSession with mocked invoke; JSX tests render the actual preview function and click callbacks. These are not a full mounted/browser App or native keyboard test.

## Acceptance boundaries and checks

Real GUI configuration/trust/launch, real Agent CLI/Hook integration, system notification/auxiliary permissions, and Windows/Linux native file-identity/permission/shell paths remain unverified. All runtime tests use their own synthetic fixtures; no real project or application preferences were altered. The earlier T08 package owner RPC and October 1–2 GUI samples belong to those builds, not this newly changed product source. No new native package was built or launched for T09.

Final checks follow the frozen sequence: Rust tests, frontend coverage, Python, frontend build, Rust fmt, clippy, diff. Validation（原始文件已归档） records actual results/counts and scope; index（原始文件已归档） records bounded evidence hashes. Tool TS coverage excludes React and Rust; official Converge coverage provider remains unconfigured and is not claimed.

Final frozen-source host checks: Rust275 passed/2 existing native fixtures ignored (20 T09 tests); Node150 passed (12 project-config tests), TypeScript tool lines/functions100%, branches96.79%, project-config.ts branches81.08%; Python80 passed. Frontend build, fmt, clippy and diff all returned exit0. The existing >500 kB chunk warning remains. Python completed before frontend build. Code freeze（原始文件已归档） binds the exact code/test files; it is a specific file manifest, not the controller’s whole-workspace fingerprint.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../../development-artifacts.md)。
