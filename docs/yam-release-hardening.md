# Desktop configuration hardening — T18 partial slice

## 2026-10-18 生产加固增量：CLI 事实与隔离负载验证

作者：Jeff.Liu。以下是候选源码的本轮增量；固定 `YAM.app` 与原有任务保持，新增行为尚未应用到运行包。下文各轮记录为历史快照，不能作为本轮候选的原生验收。

- 后台在启动准备时采集有界 CLI 版本输出，复用启动时已解析的可执行路径；版本与平台随会话代际持久化，旧记录显示 Unknown。连接详情读取当前会话 Agent 状态；Codex 失败回执的格式能力仅对 macOS / 0.162.1 显示支持，连接未建立、版本或平台未知时明确未验证。兼容性信息不证明某条回执已送达。
- Claude 原生 Esc 取消继续保留外部回执不可靠的提示；没有新增 SDK、输入拦截或真实厂商请求。版本查询关闭 CLI 自动更新与非必要遥测；查询失败仍沿用现有集成不可用或未知版本的边界。
- 长日志观察器保留逐条描述符的大小、所有者及链接检查；路径检查按消耗字节批量执行，提交终态前再次核对路径身份与大小。实际回归覆盖缓冲中的截断后恢复，避免错误接受旧缓存终态。128 MiB 文件、2 MiB 单行、最长一小时及 macOS / Codex 0.162.1 的原有限制不变。
- 合成长日志 **8 × 16 MiB** 基线全部在 **15 秒**期限内未完成；最终保留逐条描述符保护的实现实测最慢 **0.7535 秒**，连续三轮通过。只计文件观察器；夹具 `alive() == true`，不含原生进程查询、TUI、网络或真实厂商耗时。
- 隔离 `HistoryStore` **8 × 32 轮 / 256 回执**，经过真实共享锁及持久化路径。独立按输入核对每条 ID / turn / kind / revision、全局唯一性、旧代际拒绝、重复与迟到事件、通知确认与已读状态、重载保真；连续三轮通过。一次精确断言采样约 **15.51 秒**，完整轮次 P95 **1.003 秒**；该指标含一轮全部读写及落盘，不能称 RPC P95 或桌面响应时间。持久化语义未改变。

### 本轮证据与仍需满足的门禁

本轮每条验证要求完整 argv 与冻结计划精确匹配；最终结果只以同源 Evidence Receipt v2 与 `plan_check.py audit --require-complete` 为准。旧一轮的 argv 不匹配回执保留为不完整历史，不补造或重写。本轮计划、保护检查和最终交付清单见[生产加固计划](superpowers/plans/2026-10-18-yam-production-hardening.md)。

Converge 原生完整门禁仍未满足：官方状态校验将运行开始前已有的脏路径计为 scope drift（本轮实际拒绝 `AGENTS.md`），不能靠扩大授权范围绕过。现有 Node 测试/覆盖率没有该 Suite 的原生 TDD 适配器；本机没有 cargo-llvm-cov / cargo-tarpaulin，Apple LLVM 15 实际拒绝合并当前 Rust LLVM 22 的 profile（raw 10 / expected 8）。因此不新增无效 coverage 配置、不冒充 Rust 覆盖率，不宣称受管 Single State 或原生 TDD complete。

候选固定包 GUI / 原生 TUI / IME / 通知和真实厂商仍未验收；本轮不替换、重启或控制既有应用及任务。源码自动化通过与生产启用分别记录。

## 2026-10-18 主要 Agent 优化候选：尚未替换当前应用

作者：Jeff.Liu。Claude / Codex 的 DeepSeek 选择、模型映射、配置提示、旧回合隔离和结束标签只读浏览已完成源码修复及本地验证；使用原生 TUI，无新 SDK、依赖或全局配置改写。

前端 **1563 passed**、Rust **755 passed / 13 ignored**、本机 CLI loopback **9 passed**，TypeScript / Web build 及 Node 覆盖率门槛通过。源码分项与组合静态复核通过。原有任务、全部 50 条会话、后台 owner 及固定包文件保持。

**发布 / 原生验收未完成**：为保护运行任务，没有覆盖固定 `YAM.app` 或重启后台；候选 GUI / TUI / IME、真实服务和其他系统未验。严格 Converge audit 的源码链 / 范围通过，argv / 受管状态 / 原生覆盖率缺项如实保留。Claude 中断回执与 Codex 已测格式限制不变。完整结果和维护窗口要求见[主要场景方案第 12 节](superpowers/plans/2026-10-18-yam-primary-agents-reliability.md#12-已批准方案的实施结果与启用边界)。以下记录均为此前各轮快照。

## 2026-10-18 Codex API 失败后续收口；Claude TUI 中断回执为已知限制

作者：Jeff.Liu。此节更新下方较早的部分验收结果。

- **Codex 0.162.1 / macOS API 失败已修复并实测**：现有 hook helper 启动有界观察进程，只读取当前 `CODEX_HOME/sessions` 下无符号链接、当前用户所有的普通日志文件。核实原生 session / cwd / turn 和已测版本后，将精确回合的 `task_complete.error` 映射为现有鉴权 Wire v1 的 `TurnFailed`；错误正文不进入回执。成功和 `turn_aborted` 不补发失败事件。
- 观察进程复核设备号 / inode / 链接数，拒绝替换、截断、过大文件及未知格式；单行 2 MiB、日志 128 MiB、初始化请求 64 KiB、最长一小时。非阻塞初始化不会卡住 hook；原始 CLI 的 PID / 启动时间不再匹配时退出，保留原进程组以便后台停止会话时一并清理。当前只启用 macOS，其他系统和其他 Codex 日志版本不计入覆盖。
- 最终固定 `YAM.app` 正常重开后，原生 API 失败 → 未读失败回执、成功恢复、Escape 中断、再次成功恢复均通过；最终 GUI 的历史失败 Inbox 导航保留 kind / read。候选构建实测当前失败导航只确认对应回执；前端未变，最终包未重测这条 ACK 操作。原 owner 17717 保留；本轮两条 Codex 测试会话均已停止；清理时恢复旧测试标签额外产生的一条空白 shell 已核实来源并停止，未发送输入。首次覆盖应用包后直接执行 hook 曾在 `_dyld_start` 超过旧 owner 配置的 2 秒时限，程序尚未进入 hook；正常重开同一个 GUI 后再验收通过，未重启 owner，也未把先前超时样本算为通过。
- **Claude 2.1.302 原生 TUI 中断回执为已知限制**：CLI 本身支持 Escape 取消，但没有向 YAM 提供覆盖首字节前取消的可靠终态。已核实 hooks、SDK、TUI、受鉴权本地 socket 及 transcript 分支；SDK 的 `cancelled` 同时可能表示 API 硬失败，必须结合匹配请求的 `result.terminal_reason`。用户已于 2026-10-18 决定保留原生 TUI、不新增 SDK 模式；中断回执暂作为已知限制，不计为已修复或已通过原生验收。本次决定仅更新文档，现有 YAM.app、后台和正在运行的任务保持不变。

测试：新增 Codex 回归 **12 passed**，含失败 / 成功 / 中断分类、身份与格式拒绝、部分行、文件替换 / 截断 / 越界 / 超限、进程退出 / PID 复用、初始化背压；先红后绿，并独立复审两项发现。前端 **1547 passed**；Rust library **749 passed / 7 ignored**。未验证真实第三方模型、macOS 通知横幅 / 点击、Windows / Linux 和其他 Codex 版本。Claude 的 8 项分类器契约测试与 7 项静态契约检查通过，不冒充原生中断验收。

## 2026-10-18 Agent 失败 / 中断原生验收（部分通过）

作者：Jeff.Liu。复用固定 `YAM.app` / `com.yam.desktop`，GUI 56836、后台 owner 17717 均保留。仅操作本轮创建的测试会话；模型请求使用本机非转发夹具。原有 3 条运行任务的启动配置、启动时间、原生会话与 generation 哈希一致，41 条原会话均保留。

| 原生分支 | 结果 | 实测现象 |
| --- | --- | --- |
| Codex API 失败 | **阻塞，未闭环** | CLI 已失败，结构化 JSONL 含精确 turn 的 `task_complete.error`；YAM 仍为 `working`，无失败回执 |
| Codex Escape 中断 | 通过 | `interrupted`，精确 turn 的未读回执；CLI 进程继续运行 |
| Claude API 失败 | 通过 | 原生 `StopFailure` → `failed`，保留未读失败回执 |
| Claude Escape 中断 | **阻塞，未闭环** | 请求已取消、CLI 回到输入状态；YAM 仍为 `working`，无中断回执 |
| OpenCode API 失败 | 通过 | 原生错误 → `failed`，保留未读失败回执 |
| OpenCode 双 Escape 中断 | 通过 | 原生取消 → `interrupted`；单 Escape 的超时成功样本不计入中断通过 |

三种 CLI 均实测后续轮次恢复，早先回执的 kind / read 保持。Codex 当前中断、OpenCode 当前失败的 Inbox 导航打开对应 Terminal，且各只 ACK 一条当前回执；三种 CLI 的历史失败 / 中断导航均不 ACK。Claude 正常响应仅计为 `needs_attention`，不等同任务完成。重复 / 晚到事件保护由现有自动化覆盖，不冒充本轮原生事件重放。

**修复边界**：本轮未修改产品运行时代码。当前 Codex hook 契约没有 API 失败事件，需要新增有界、精确身份校验的结构化状态采集；仅重建 GUI 不能验证 owner 内的采集修复。实测 Claude 2.1.300 hook 契约没有 Escape 中断事件，取消后的 transcript 也无可靠终态，需要上游事件或另行设计结构化控制通道。独立只读复核确认这两个采集缺口；按保留运行中 owner / 任务的约束，本轮不宣称闭环。

本轮验收脚本 **14 passed / 2 failed**（以上两项，退出码 1）；前端 **1545 passed / 0 failed / 0 skipped**；Rust library **737 passed / 0 failed / 7 ignored**。无新产品修复，因此无新产品代码红绿记录，也未重新构建应用、重启 GUI / owner。未验证 macOS 通知横幅 / 点击、Windows / Linux 和真实第三方模型。CLI 自更新副作用：测试中的 Claude 2.1.300 自行安装了 2.1.302；已在本轮专属配置中禁用后续自更新，未回滚全局 CLI。

清理：停止本轮 3 条存活测试会话与本机 API 夹具，保留 1 条启动失败记录及全部测试历史；最终 owner 仍为 17717、仅原有 3 条任务运行。详情见[本轮完整回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/agent-failure-interruption-20261018/acceptance-report.md)。以下旧结论保留为当次快照。

## 2026-10-18 P0 / P1 原生收口

作者：Jeff.Liu。复用固定 YAM.app / com.yam.desktop，已载入最新 GUI；后台 owner 17717 与原有 3 条运行任务身份保持，原有 37 条会话保留。P0 的隐藏身份刷新、别名文件预览和历史分页原生回归通过；最终分页 50→61 条，真实阅读锚点偏移 0 px，无模型请求。

P1 补测并修复 Terminal 热切换的旧 Agent 状态，以及 Inbox 未切到 Terminal 的导航问题；历史卡只读、不恢复已结束进程，等待期间的新输入焦点和终端结束边界均有失败回归及修复。真实 Codex hook 完成/权限回执、Inbox 当前/历史/已结束导航、搜狗拼音“你好”、复制、保日志清屏、单会话停止、全局停止确认与取消已验。最终前端 **1545 passed / 0 failed / 0 skipped**，Rust library **737 passed / 0 failed / 7 ignored**，固定 debug app 构建与 diff check 通过，独立只读定向复审无剩余发现。

**仍未验证**：macOS 通知横幅/点击（权限明确拒绝）、Agent failed/interrupted hook 的完整原生路径、全局停止确认/托盘停止、强制断线重连、真实第三方模型与完整 Suite/发布门禁。原 owner 承载运行任务，未为验收重启或断开；本次测试进程已清理，测试历史保留。[本次完整回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/p0-p1-closure-20261018/acceptance-report.md)。以下旧结论保留为当次快照。


Author: Jeff.Liu

This slice changes only Tauri CSP/capability configuration and Cargo package
metadata. Rust handlers, App/Vite/frontend code, plugin initialization, dependency
requirements/features, package version and Cargo.lock remain unchanged. It does
not complete release signing, licensing, notices or native security acceptance.

Production CSP has `default-src 'self'`, strict `script-src 'self'`, local IPC
`connect-src ipc: http://ipc.localhost`, self-only images/fonts, and no frames,
objects, base URL replacement or form submission. It adds no wildcard origin,
remote development host, script `unsafe-inline` or `unsafe-eval`. Existing Tauri
asset CSP modification remains enabled; its bundled hash/nonce handling is not
replaced by a new framework.

Production `style-src 'self' 'unsafe-inline'` is a limited compatibility choice:
the installed xterm6 DOM renderer and viewport create runtime style elements
without assigning nonces. This exception is for styles, not production scripts.
Actual native rendering, fonts and resulting CSP enforcement still require an
owned-package test.

A separate development CSP retains the same finite policy except that it allows
inline **development scripts** for the installed React Refresh inline module
preamble, and connects to the default localhost Vite/HMR endpoints1420/1421.
It allows no eval, wildcard websocket scheme or arbitrary remote host. Development
React script-inline and production xterm style-inline are separate exceptions.
Default localhost startup/HMR was not run during this configuration-only task.
For a developer-supplied `TAURI_DEV_HOST`, supply an explicit Tauri `--config`
override for `app.security.devCsp` with that exact trusted origin/ports. Vite is
unchanged; neither a custom-host launch nor its CSP compatibility is claimed.
Do not expand production CSP to accommodate development hosts.

The main-window capability grants only `core:event:allow-listen`,
`core:event:allow-unlisten` and `dialog:allow-open`, matching frontend event
subscriptions/disposers and the single-directory picker. It adds no remote
origins or additional windows/webviews. Removing unused `core:default`,
`opener:default` and `deep-link:default` is a consumer-based narrowing, not a claim
that the old defaults were a demonstrated vulnerability. Custom app commands
and Rust internal deep-link parsing/get-current/on-open routes are unchanged;
plugin bootstrap remains intact. Real dialog/listener/OS protocol acceptance
is pending.

Cargo authors is `Jeff.Liu`, with description `YAM desktop terminal workspace
for local agent sessions`. No SPDX license or rights-holder decision is inferred.
The approved Rust updater SDK stays at requirement2/resolved2.13.1 with the exact
same locked graph; updater registration/configuration/installation is not added.

All eight planned host checks ran: configuration8/8, Rust402passed/2ignored,
Node252passed, Python93passed, standard frontend build, fmt, locked clippy and
diff, all exit0. The finite source-set test oracle rejects invalid policy strings;
it does not emulate a browser or establish WebKit enforcement. Existing URI and
session-ID parser tests ran unchanged. Utility TypeScript coverage is100%lines/
functions and95.08%branches; it does not cover React/native enforcement.

Native WebKit startup, terminal styles/fonts, IPC/listeners/dialogs, rejected
unapproved scripts/resources, default/custom-host HMR and OS deep-link/unknown-ID
routing remain pending. No real GUI, user owner, Agent, signing, publication or
frozen T06 package/data was used. Third-party-notice completeness, project
license and three-platform release/install acceptance are outside this slice.
See [bounded evidence](evidence/yam-release-hardening-t18/README.md).

## Release CLI error rendering — T19 sourceflow partial slice

Author: Jeff.Liu. The release helper now reports fixed timeout, subprocess,
tool/file-operation and bundle/signature/notarization-rejection categories,
instead of formatting exception text containing arguments, identity/profile
values, paths or dynamic messages. Captured stdout/stderr non-disclosure is
preserved, not a reproduced prior stream leak. This rendering applies only to
operation exceptions caught by main; argparse diagnostics are unchanged.
Parser, exit status, success text, delivery ordering
and acceptance policy are unchanged. `check()` is verified by a mock to call
exactly codesign verify/details, stapler validate and spctl assessment; no signing,
identity lookup, submit/upload or staple call is included. This exact-sequence
assertion was direct-green on the original source, not a newly failing test.

Four actual main-error fixtures first failed on artificial nonsecret sentinels;
the repaired target suite passes10/10. The explicit host fixture wrapper runs97
cases:96pass and one named native runtime-build/codesign test skipped. That is
fixture-only validation, not unfiltered Python or native release acceptance.
Real certificate/profile readiness, Apple service, signed production stapling/
Gatekeeper and Windows/Linux signed-package/native install acceptance remain
blocked/excluded pending a separate authorized capable-machine run. Nothing is
signed, uploaded or published in this slice. See [sourceflow evidence](evidence/yam-release-sourceflow-t19/README.md).

## Five frontend notice sources — T18 partial follow-up

Author: Jeff.Liu. The existing runtime notice assembler now includes separate
package/version headings and original package-owned LICENSE bodies for react
19.3.0, react-dom19.3.0, lucide-react0.468.0, @xterm/xterm6.0.0 and
@xterm/addon-fit0.11.0 and @xterm/addon-search0.16.0. Versions are fixed against the recorded pnpm lock and
installed metadata; missing/mismatched metadata or invalid LICENSE sources fail
before SEA/final publication. Strict UTF-8 byte decoding and byte output preserve
original CRLF and whitespace. Node/headless/serializer source assembly remains.

Actual main fixtures use an isolated temporary repository, local synthetic
archive, denied URL access, mocked subprocesses and a non-Darwin target. Normal
and thirteen invalid-source subcases pass; filtered host fixtures run99 with
98pass and one explicit native runtime-build/codesign skip. The fixture checks
preexisting final binary/notices preservation, not a full builder transaction.
No real runtime build, download, signing, package or T06 asset was used.

Coverage is limited to these five direct frontend package texts. Tauri JS/API/
plugins, Cargo/Rust, transitive and full bundled inventory remain unresolved;
no project license or full notice-completeness claim is made. Actual packaged
resource/native visibility and release/install acceptance remain pending.
See [frontend notice evidence](evidence/yam-frontend-notices-t18/README.md).


## Offline notice gate (T18 source)

The [notice integrity inventory](THIRD_PARTY_NOTICES.md) and content-addressed original bodies replace sample/count-only readiness. Developer builds explicitly emit incomplete developer notices and a non-release-eligible report. Formal builds use a tiny release override and deny gaps, stale locks, unqualified or corrupt bodies, and missing Node aggregate material before runtime fetch/SEA. macOS check/deliver validates exact packaged notice/report/runtime bytes before signing or notarization tools. Reports publish last; mixed output after promotion failure is rejected, without claiming multi-file atomicity. Current real inventory has 500 gaps and is not release-ready. Unit fixtures use synthetic binaries and mocked native release tools; no signing, network collection, publication, or native packaged license acceptance ran.

Material batch01 passed independent Root and Astra source reviews; the subsequent addon-search 0.16.0 exact source and full 548-identity candidate received independent mechanical review and root approval. The R2 mechanism remains: a fixed, independently approved canonical manifest digest binds all 548 identities, supplemental bodies, declarations, provenance, gap classifications and additional Node material. Collection produces candidates without granting readiness and rejects unapproved candidates before accepted return/publication; the public approval check, both render modes and packaged validation reject mapping changes before validator body reads. Future material changes require separate review and approval-anchor updates; no flag or environment bypass is provided.

[Material batch01 evidence](evidence/yam-full-notices-t18/material-batch01/README.md) preserves 15 exact-source qualifications, the Android Apache-text gap, retained atomic-waker third-party text, actual RED/GREEN and five fresh checks. Current coverage is 48 identities (39 Cargo and 9 npm), with 500 gaps: 31 known and 469 awaiting classification. Node aggregate attribution is additional. Developer output is deterministic at 4,774,510 bytes and remains non-release-eligible. [Historical R2 evidence](evidence/yam-full-notices-t18/r2/README.md) retains the preceding 32/515 state; older R1/R2 files remain unchanged. The collector/render/release-gate source slice is complete; full notice material, legal, native signed release and formal provider acceptance remain incomplete.

## 0.1.1 updater deployment (2026-10-20)

Author: Jeff.Liu. This section supersedes the earlier SDK-only/update-unavailable snapshot.

- Source: https://github.com/ainiaa/yam/releases/latest/download/latest.json. Public key is in tauri.conf.json; private signing material remains outside the repository, under the current user's private application support directory. Back it up securely before publishing any release; losing it requires a manually installed key rotation.
- Version metadata is signed (`requireSignedVersion=true`); downgrades are disabled. Updates are GUI-only. The background owner exposes only idle preparation/finalization and never loads the updater SDK.
- Automatic mode checks at startup and every six hours, downloads and verifies, and shows a badge. It never installs automatically. Install and restart is explicitly chosen by the user.
- Install admission locks the same session map used by native task creation. Any running task rejects installation. The old idle owner quiesces, then the installer holds the owner file lock while replacing the program, so concurrent CLI starts cannot race into the old binary.
- macOS preserves a local backup until code signature, bundle identifier and target version pass. A failed replacement restores the backup. A rollback failure keeps the hidden .YAM-update-* backup folder beside the app for manual recovery, logs its exact path, and blocks further checks/replacement in that process. Installation cannot be cancelled halfway; exit waits for its worker.
- Existing installations whose owner lacks the idle update capability need one full YAM restart. Checking/downloading can continue while sessions run.

### Prepare a release; no implicit publication

1. The release wrapper explicitly seals macOS bundles: it uses APPLE_SIGNING_IDENTITY when supplied and ad hoc signing otherwise. Build with `pnpm build:release --bundles app` from apps/desktop, with TAURI_SIGNING_PRIVATE_KEY pointing to the private key and TAURI_SIGNING_PRIVATE_KEY_PASSWORD supplied privately. The existing notice gate must pass; never publish a developer incomplete-notices package.
2. Keep each platform's generated updater artifact and matching .sig together. When renaming artifacts to include architecture, rename before signing with `pnpm tauri signer sign --private-key-path <private-path> --app-version 0.1.1 <artifact>`. Do not include a private key or password in manifests, release notes, logs or repository files.
3. Run `python3 scripts/updater_release.py --version 0.1.1 --artifact darwin-aarch64=<signed-artifact> --notes docs/releases/0.1.1.md --output <release-directory>` from the repository root. Add one --artifact per supported platform; the script only prepares latest.json and SHA256SUMS, and rejects signatures without the matching signed version.
4. Review the concrete package, signature, notice report, checksums and release notes. Publish to tag v0.1.1 only with approval. Upload latest.json, all listed artifacts, their .sig files and SHA256SUMS together. An unpublished release cannot provide live updates; absent platform assets remain unavailable rather than falling back to another platform.
5. An Apple Developer ID signature/notarization is separate from the updater signature. Ad hoc local signing does not provide Gatekeeper trust for distribution. Windows/Linux installation requires platform-native acceptance before publication of those assets.

## 0.1.2 release preparation (2026-10-21)

Author: Jeff.Liu. This section supersedes the earlier implicit ad hoc release-wrapper behavior.

- `pnpm build:release` now requires an explicit Developer ID Application identity for macOS. An unnotarized local candidate must use `pnpm build:release --preview --bundles app`; it is not presented as Apple-notarized.
- Package, Tauri, Cargo manifest and root lockfile versions must agree before spawning a build.
- `python3 scripts/prepare-release.py --version 0.1.2 --target darwin-aarch64 --app <YAM.app> --artifact <signed.app.tar.gz> --notes docs/releases/0.1.2.md --output <new-directory> --preview` prepares complete assets locally without publishing. Omit `--preview` only for an app that passes the existing Developer ID, stapling and Gatekeeper checks.
- Preparation checks exact bundle identity/version/architecture, release-eligible third-party notices, all archive files against the inspected app and the version-bound updater signature. It stages the archive, signature, latest.json, release status, release notes and checksums together. Existing output is never silently reused.
- The application version bump changes the root Cargo package only. All 554 third-party identities and qualified license bodies remain unchanged; the input digest and approved manifest anchor are refreshed together.
- The current machine has no Apple Developer ID or notarization profile. A preview package and its independent updater signature do not establish Apple Gatekeeper trust. Public distribution requires the user's explicit choice; no publish operation is part of the preparation script.
