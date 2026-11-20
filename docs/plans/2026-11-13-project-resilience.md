# YAM 项目使用与恢复改进计划及本地验收记录

作者：Jeff.Liu

## 目标与边界

按“计划 → 失败回归 → 最小实现 → 定向验证 → 集成检查 → 独立复核 → 修复复验”推进本轮五项改进。

基线提交：`b1a7b9d4d05c7af7d6929591dab13f4edabf9a0c`。开始时已有 142 个变更条目，原文件副本保存在 `.artifacts/project-resilience-20261113/baseline/`；本轮增量从该快照计算，未撤销已有工作。

不提交、推送、安装或发布。不启动可见桌面应用，不干扰运行中的 `/Applications/YAM.app`。调试打包只使用既定的 `YAM` / `com.yam.desktop` 与固定路径。

## 顺序计划与结果

| 步骤 | 验收行为 | 本地结果 |
| --- | --- | --- |
| T1 启动预检 | 不可用的首选 CLI 保持选中；安装和切换需明确操作；只读展示程序、目录、连接引用事实，区分认证未知 | 已实现；30 项初始定向回归通过，纳入最终完整前端检查 |
| T2 项目备份与恢复 | 含归档的项目历史、当前窗口的项目布局、可选保留日志；预览后恢复为新记录，保留原数据，不启动进程或发送输入 | 已实现；13 项 Rust 备份回归通过；实际 App 多窗格/隐藏标签只读恢复通过 |
| T3 可信状态时间 | 当前可信状态推进才记录 UTC 时间；旧轮次、重复、读取与重连不刷新；旧数据未知，不按耗时判定卡死 | 已实现；20 项前端、42 项 Rust 初始定向回归通过，另有 1 项既有忽略 |
| T4 窄窗口 | 主、副窗口最小逻辑尺寸 720×600；保留字号；项目工具在窄窗口占满工作区；核心操作与设置关闭可达 | 已实现；无窗口 WebKit 720×600 布局与焦点检查通过 |
| T5 项目通知 | 全部、仅权限请求/失败、静音；后台持久化并保护并发更新；保留 Inbox/未读与全局暂停 | 已实现；3 项前端、3 项 Rust 初始定向回归通过，纳入最终完整检查 |
| 集成与复核 | 检查调用契约、序列化、所有权、失败恢复与任务之间的组合 | spec、quality、integration 独立只读复核均通过；确认的缺陷已修复并复验 |

### 备份数据约定

- 每份备份最多 2,000 条记录、16 MiB；超限拒绝，不截断历史。
- 排除 CLI 启动配置、凭据配置和原生 Agent 会话 ID。标题和可选日志仍可能包含业务敏感信息。
- 日志仅包含仍保留的终端输出，不等于完整原生 Agent 对话或完整终端解析器状态。
- 恢复生成新 ID，保存确定性恢复结果；同一确认操作重试不重复导入。结果文件原子写入，残缺结果可由同一次恢复重试修复。
- 历史先保存，打开布局是后续明确操作；多窗格和隐藏标签使用既有批量恢复版本隔离，只读打开。
- 已恢复布局列表有条数和总字节预算；所有历史记录仍可从侧栏/归档查看，原结果文件保留。
- 通知 important 模式仅展示 `needs_permission` / `failed`；静音影响展示，不自动标记已读。手动测试通知绕过项目策略。

## 最终验证

所有原始日志、源码指纹、完整 argv、退出码与耗时均保存在忽略目录 `.artifacts/project-resilience-20261113/`。下面各项退出码均为 0。

| 检查 | 实际命令或记录 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 前端全量与覆盖率 | `pnpm --dir apps/desktop test:coverage`；`final-frontend.json` | 3040 通过、5 跳过；行 99.80%、分支 94.21%、函数 96.64% | 47.203 秒 |
| Rust 全量与覆盖率 | `python3 scripts/native-coverage.py`；`closure-native.json` | 1209 通过、30 既有忽略；行 87.41%，超过 85% 门槛 | 120.497 秒 |
| Rust 静态检查 | `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings`；`final-clippy.json` | 通过 | 7.421 秒 |
| 文档测试 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --doc`；`doctest-final.json` | 执行成功，0 项 doctest | 3.806 秒 |
| 质量脚本 | `python3 -m unittest scripts.test_project_quality scripts.test_project_mutation scripts.test_memory_self_smoke scripts.test_native_coverage -v` | 37 通过 | 0.774 秒 |
| Mutation | `python3 scripts/project_mutation.py --output /tmp/yam-project-resilience-mutations-20261113-01a1d3f8-final` | 实际生成 8、捕获 8；执行 42 项选择器基线 | 100.341 秒 |
| WebKit | `python3 -m unittest scripts.test_webkit_memory_smoke -v`；`final-webkit.json` | 7 通过，含 720×600、脏设置关闭、错误拒绝 | 26.016 秒 |
| 实际 React 项目流程 | `final-project-webkit.json` | 720×600 下导出→预览→确认恢复→项目静音；IPC 为惰性夹具，无启动/输入 RPC | 4.038 秒 |
| 调试打包 | `env APPLE_SIGNING_IDENTITY=- pnpm --dir apps/desktop exec tauri build --debug --bundles app --no-sign --ci`；`bundle.json` | 固定 `target/debug/bundle/macos/YAM.app` 构建成功；未签名、未启动 | 51.082 秒 |
| 增量格式 | `git diff --check` | 通过 | — |

前端 5 个跳过项为既有 3 个 Chrome 显式 opt-in 与 2 个 Pi SDK Markdown 检查；未开启相关 opt-in。Rust 30 个忽略项包含实机/原生 CLI/手工基准等既有 opt-in，完整清单见覆盖率原始输出。未额外重复运行普通全量 `cargo test`；检查失败并修改相关源码后才复验。

Mutation 首次实测发现隔离副本缺 OMP 的编译期 sibling 资源，补失败回归后修复复制逻辑，随后实测 8/8。当前 `agent_events.rs` SHA-256 为 `2c6fffa09250e2a5943e57971d9c9e0dbfba53871a7d0622467aa9a4b5998957`，与成功 campaign 一致；没有用更新摘要代替实测。

## 已闭环的复核发现

- spec：后台命令契约漏登记；全局标题错误影响项目限额；路径尾斜杠导致布局成员遗漏。分别观察失败并修复，`review-spec-recheck.md` 为 pass。
- quality：批量恢复错误使用单选附着校验；合法大备份的结果文件无法重新读取。复用真实 App 恢复夹具与 2,000 条多字节标题样例复现并修复，`review-quality-recheck.md` 为 pass。
- 同范围检查：恢复附着失败仍关闭界面、异步布局意图过期、预览后文件改变、恢复已提交但刷新失败、结果文件残缺、结果结构或总大小异常、操作中设置导航与未选项目提示，均有失败/成功回归。
- 旧恢复测试复用夹具新增依赖后出现 6 个 ReferenceError；补齐导入绑定，35 项定向及最终 3040 项前端检查通过。
- `review-integration.md` 为 pass，未确认残留的跨任务源码缺陷。reviewer 全程只读，未跑测试或启动 GUI。

## 未覆盖与认证边界

- 没有安装或启动调试包，没有修改、重启或控制当前运行中的正式应用。
- 无窗口 WebKit 使用 fixture IPC；真实桌面经过 owner RPC 的完整跨窗口恢复、系统文件选择、系统通知投递/权限/唤起与 GUI 生命周期仍未实机验收。
- 未执行签名、公证、发布、远端 CI 或 PR HEAD 对齐。本地通过不代表发布放行。
- 原开发阶段的 `plan-audit.json` 为 PARTIAL：计划文档漏登范围，部分定向命令与冻结 argv 不同，任务完成边界不足。该回执保留，当前源码补验收单独记录如下，不能将补验收解释为当时已遵守全部执行协议。

## 追踪补齐与当前源码补验收

本节响应“补齐追踪记录缺口，完成正式流程审计”。只修改本计划文档，不改产品、测试或发布配置。补验收基线是实际读取的 Source Receipt `d90244805970207a2a4c8bc021b6e4faa6e9ca6d7ac92a426e90b7eac2901960`；原始实现基线和 142 个既有变更副本仍保留，不以补验收基线替代原始增量审查。

证据目录：`.artifacts/project-resilience-20261113/audit-reconciliation/`。该目录由本地忽略规则排除；尚未提交或上传，交接时需随本计划一起保留证据目录。原始目录中的回执保持原样。

### 缺口处理

| 缺口 | 补齐方式 | 防止误报 |
| --- | --- | --- |
| 计划文档漏登范围 | 新计划明确登记本文；对原基线到当前的全部 38 个增量路径另做完整清单核验 | 禁止新增范围外路径；原 scope drift 不改写 |
| 冻结命令不匹配 | T1—T5 按原始完整 argv 各执行一次，新增 observed 回执 | 不将包含额外参数的旧命令改记为相同命令 |
| 完成边界不完整 | 对当前源码顺序补验收，每项实际记录 source_before/source_after、退出码和耗时 | 不猜测旧文件内容，不回填历史 DONE |
| 缺显式集成任务 | 增加依赖 T5 的 I1，冻结集成检查与最终验收 | 所有验收必须绑定当前源码，源码变化即不能沿用旧回执 |
| 原始证据分散 | A0 核验 72 份历史回执、原始 stdout/stderr 摘要和初始脏文件副本，索引保留失败记录 | 不删除失败，也不将旧证据标为当前通过 |
| 产品验证与流程认证混用 | 分开记录当前补验收计划审计、原开发时序及真实桌面/发布边界 | Plan 审计不冒充受管 Single State、TDD Trace 或发布认证 |

### 冻结的补验收顺序

`plan.json` 为 Plan v6，顺序为 A0 → T1 → T2 → T3 → T4 → T5 → I1；`checkpoint=same_session`，不要求提交授权。

| 任务 | 实际验证命令 |
| --- | --- |
| A0 原始记录与范围核验 | `python3 .artifacts/project-resilience-20261113/audit-reconciliation/verify-records.py` |
| T1 启动预检复验 | `node --test apps/desktop/tests/new-session-ui.test.mjs` |
| T2 项目备份复验 | `node --test apps/desktop/tests/project-backup.test.mjs` |
| T3 状态时间复验 | `node --test apps/desktop/tests/session-runtime-info.test.mjs` |
| T4 窄窗口复验 | `node --test apps/desktop/tests/header-layout.test.mjs` |
| T5 项目通知复验 | `node --test apps/desktop/tests/project-notifications.test.mjs` |
| I1 集成检查 | 前端覆盖率、Rust 覆盖率、Clippy、doctest、质量脚本、mutation、无窗口 WebKit、React 项目流程、`git diff --check`；完整 argv 见冻结计划 |

本次重跑用于取得当前源码的补验收回执，不将重复执行计为新增测试。Rust 全量仅通过覆盖率命令执行一次，不追加普通全量 `cargo test`。调试包复用原 `bundle.json`：先核对构建时到当前仅本文档变化，不重复打包或启动。

### 审计与判定入口

1. `freeze.json` 保存本次请求、实际补验收基线、原始记录 SHA-256、72 份历史回执清单、38 个原实现增量路径和唯一允许修改的文档路径。
2. `records-index.json` 保存逐份完整 argv、源码指纹、回执指纹、退出码、耗时、测试计数；历史失败按历史事实保留。原计划、旧审计输入/输出及旧报告另有 `original-*` 副本。
3. `execution.json` 保存本次各任务的真实边界和回执；`audit-input.json` 以这些记录形成最终审计 envelope。独立只读复核输入包含完整增量、证据与未覆盖范围，输出为 `review-audit.md`。
4. 正式门禁使用现有 `converge-plan/scripts/plan_check.py audit --workspace <仓库绝对路径> --input - --require-complete`，输出 `audit.json`，命令、退出码和耗时另存 `audit-command.json`。只有退出码 0、`complete=true`、全部任务 DONE、源码链与依赖顺序有效、两类 scope drift 为空、最终验收通过，才能关闭本次补验收。
5. 使用同一审计器核对缺回执、错 argv、范围漂移、陈旧最终验收四种负向输入；`audit-negative-controls.json` 保存实际拒绝结果。该检查验证门禁仍有效，不修改审计器或降低门槛。
6. `delivery-report.json` 保存本次实际结论、最终源码、独立复核、各检查和原始 PARTIAL 的关联。最终判定以这些实际产物为准，不从本文的执行计划推定通过。

本次补验收审计覆盖当前交付的追踪与源码验收，不追认旧开发时序，也不签发缺失的受管执行协议认证。真实桌面 owner RPC、系统通知/文件选择、GUI 生命周期、安装签名公证、远端 CI 和发布仍按上文列为未覆盖，不纳入本地通过结论。

## 后续真实桌面验收

上述“未启动/未覆盖真实桌面”描述的是前阶段边界。用户后续授权本机启动、指定旧测试会话退出及通知卡片 AppleScript 验收后，新增的实机结果和通知路由修复记录见 [真实桌面与系统通知验收](2026-11-13-project-resilience-desktop.md)。原回执及审计不回填；仍未发布。
