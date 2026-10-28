> 当前支持范围：仅 macOS，现有发布包与实机验收以 Apple Silicon 为准。Windows/Linux 暂停支持、CI 测试和安装包构建；下文涉及其他平台的历史记录保留作参考。

## 本轮工作流优化（2026-10-27，作者：Jeff.Liu）

| 能力 | 当前范围与边界 |
|---|---|
| 原生 CLI 运行信息 | 展示已记录的可执行路径、原生会话标识和集成状态；没有原生证据时不宣称模型、推理参数已生效。凭据仅展示来源。 |
| 本轮变更 | 手动记录当前本地会话的 Git 已跟踪文本基线；仅在 GUI 内存保留。最大 2048 路径、单基线 16 MiB、合计 32 MiB、最多 4 份。未跟踪文件只列名称；不推断作者。 |
| 文件编辑 | 主窗口内 CodeMirror 按需加载，UTF-8 文本至多 1 MiB，最多打开 16 个文件；保留换行格式，写入沿用原生版本比对和原子保存。 |
| 草稿恢复 | 本机 localStorage 最多 16 份、合计 2 MiB；不进入设置备份。恢复后重新核对磁盘版本，有冲突时保留草稿并阻止覆盖；缓存不可用会明确提示。当前活动编辑器保留撤销历史，切换文件不保留撤销栈。 |
| 差异与反馈 | 当前工作树新侧行可定位到当前草稿，旧侧与暂存区行仅作为反馈上下文；快照行号不保证与当前文本一致。显式填入原生会话输入，复用现有粘贴/FIFO，不发送 Enter、不另建会话。需要已连接、空闲且身份可核对的本地交互式 CLI 和 bracketed paste 模式。 |
| 平台 | 文件原生实现使用 Unix 安全目录访问；Windows 暂不支持文件编辑与轮次基线。不支持时显示明确提示。macOS 为本轮实际构建平台；Linux 未做桌面实机验收。SSH 本轮不扩展。 |
| 交付校验 | `scripts/verify-yam-bundle.py YAM.app --version 版本号` 在不启动 App 的情况下核对主程序/helper 的固定标识、版本、签名、去签名后代码和解析资源。 |

无界面性能对照：macOS 26.6.2 arm64、Node v25.9.0，16 会话、100×40、2000 行回滚缓冲，每组 3 次 10 秒。完整快照序列化 P95 的组内中位数：冻结基线 16.95 ms，当前 17.24 ms；吞吐均约 1600 行/秒。单核 CPU 占用中位数分别 16.85% / 16.56%。脚本和被测 xterm 版本未改变，约 1.7% 的差异不构成提速或回退结论；未测 GUI paint、按键到像素、真实多 Agent 推理负载或 Warp 对照。

最终源码验证：前端 1918 通过、3 项真实浏览器检查保持跳过；Rust 1040 通过、25 项 opt-in 保持忽略。前端行/分支/函数覆盖率 99.71% / 94.41% / 96.38%，Rust 行覆盖率 87.30%。4 项真实官方 CLI 本地回环通过；新增轮次基线的根目录身份和替换版本保护共 2 个定向变异均被测试捕获。CLI 启动、桥接、Codex/Claude 配置核心四个文件与本轮任务基线逐字节一致。CodeMirror 新增 17 个锁定 npm 身份、6 份 MIT 正文经过独立归档与材料核验，历史 554 条保留，当前清单 571 条。

本轮只增强工作流，沿用官方 CLI 的参数、配置、推理与恢复机制；不增加自研模型循环。测试证据属于无界面状态/交互逻辑验证，不等同于真实桌面绘制或跨平台验收。

# YAM 当前能力与验收入口

作者：Jeff.Liu。最后公开版本：0.1.9；当前工作区正在执行 [体验优化计划](superpowers/plans/2026-10-24-yam-experience.md)。下方多轮记录均为历史快照，不能代替当前版本结论。

| 能力 | 当前状态 |
| --- | --- |
| 原生 CLI／子代理与独立连接 | 已实现；资源共用、连接和可写认证状态隔离；不改全局 Desktop 配置 |
| 新建、复制、快捷新建、命名、主题、中英文 | 已实现；新候选继续改进搜索和配置复用 |
| 存活会话恢复／结束只读 | 0.1.9 已修正业务语义；GUI 单独重开的实际画面验收仍未闭环 |
| 已停止 Agent 继续 | 已知 ID 精确续聊；缺少 Codex ID 时显式选择原生历史 |
| 通知 | 系统横幅受系统设置约束；已验证共享屏幕设置影响，候选补测试通知与说明 |
| 内存、Git、差异、工作树、文件定位 | 已有基础；候选前置常用入口，不自动执行 Git 写操作 |
| 诊断及偏好备份 | 脱敏诊断已有；候选增加纯数字启动耗时、白名单偏好导入导出 |
| 发布和更新 | v0.1.9 已公开；真实 0.1.8→0.1.9 自动下载、验签、空闲安装和重启已通过 |
| Apple 公证 | 缺 Developer ID／公证凭据，当前仅未公证预览 |
| Windows／Linux／Intel | 不以 Mac 测试替代平台验收；Windows 修复另列，尚不宣称全部可用 |

## 证据索引

- [0.1.9 发布说明](releases/0.1.9.md)；[公开发布与已知缺口](https://github.com/ainiaa/yam/releases/tag/v0.1.9)。
- 本轮源码、测试和安装结果按体验计划逐项记录。没有实际通过的检查不计为已验收。

---

# 以下为历史能力与分轮证据（按原样保留）

# YAM 当前能力清单

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

## 2026-10-18 Claude / Codex 主要场景：候选源码已验证，固定包待安全启用

作者：Jeff.Liu。当前固定 `YAM.app`、后台 owner 和原有任务未变；本节新增行为尚未在运行包生效，下方原生记录保留为历史快照。

- 新增明确的 Claude + DeepSeek 选择，旧 DeepSeek 仍为 Codex；Claude 的主模型、别名和子代理统一到所选 DeepSeek 模型。模板、项目配置及历史结构保持。
- 缺失凭据指出后台需要的环境变量名；界面说明 Responses / Anthropic Messages 及后台环境刷新条件。旧 Claude 提交事件不能再覆盖后续回合的就绪、失败或权限状态。
- 已结束 Claude / Codex 标签及布局恢复改为只读历史，执行通过显式 Continue / Run again；活动 Agent 与普通 Shell 保留原流程。
- 全量前端 **1563 passed**，Rust **755 passed / 13 ignored**；其中 **9 个本机 CLI loopback 测试另行通过**。TypeScript / Web build 与现有 Node 覆盖率门槛通过；分项及组合静态复核通过。
- **仍为部分验收**：候选固定包 GUI / TUI / IME 和真实厂商未验；Claude Escape 回执、Codex macOS / 0.162.1 边界保留。严格 Converge argv / 状态 / 原生覆盖率绑定缺项，不声称 Suite 全通过。

详细六路径矩阵、步骤结果和启用条件见[主要场景实施结果](superpowers/plans/2026-10-18-yam-primary-agents-reliability.md#12-已批准方案的实施结果与启用边界)。

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


## 2026-10-18 第二轮补充复核

GPT-6.1-sol / GPT-6-astra 对第二轮全部改动独立复核，闭环三类问题：目录别名导致预览响应误拒绝、后台会话身份/回合版本陈旧（含异步 claim 覆盖竞态）、加载较早消息时阅读位置偏移。历史与注意事项相关测试夹具同时补齐真实 helper 和无隐藏错误断言。

当前源码验证：前端 **1535 passed / 0 failed / 0 skip**，覆盖率 **99.74% / 94.52% / 96.60%**；Rust 默认并发与双线程各 **737 passed / 0 failed / 7 ignored**，doctest 通过。Web、原生与 Tauri `--no-bundle` 构建通过，最终两模型复核无遗留发现。[完整回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/second-round-plan-20261017/implementation-report.md)。

本次未替换运行中的应用包、未重启 GUI/owner、未向任务发送输入或停止请求。原有 3 条任务的身份/配置哈希与全部 37 条会话 ID 保持；当前运行实例仍使用补充修复前版本，新修复的原生 GUI 验收尚未执行。以下既有 GUI 结论和旧测试数量保留为先前交付快照。


2026-10-09：[B01d 项目颜色与内置图标](superpowers/plans/2026-10-09-yam-cmux-b01d.md)源码与独立审核通过：main 已保存项目的唯一 Edit project… 入口同时编辑名称、六种固定颜色与 folder/terminal/play 三种内置图标；保旧改名、只读目录与200 Unicode字符限制。Default删除own字段，Reset仅改草稿；视觉字段陈旧拒绝保存，Pin/重排保最新metadata，Add-await保外观且使用显式新名称，secondary零echo。49定向/1312全前端/build/diff精确184绑定，独立49与3actual probe分组。不是任意emoji/图片/图标、完整B01或GUI/ReactDOM验收；未跑Rust/cov/Suite，updater暂停。

2026-10-09：[B01c 项目置顶](superpowers/plans/2026-10-09-yam-cmux-b01c.md)源码与独立审核通过：main 已保存项目可 Pin／Unpin，旧记录 absent pinned 视为 false；稳定置顶组在前，Pin 加入组末，Unpin 不记旧位，↑/↓ 仅同组相邻移动。先写后生效，失败保原数据，Add-await 保最新 metadata 与显式新名称，改名保标记，secondary 刷新零 echo。65定向/1305全前端/build/diff精确184绑定，独立65与3actual probe分组；未跑Rust/cov/GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[A02c2 v5 布局成员外观恢复](superpowers/plans/2026-10-09-yam-cmux-a02c2.md)源码与独立审核通过：仅已核实当前owner的新renderer恢复成员字体/字号/symbolic theme，cached保实际外观，pending注释保留；旧v1–v4形状及成功恢复autosave保持，App保存v5≤16成员/core4KiB/full32KiB。现有Apply/zoom/secondary触发own布局保存，失败raw保留/current外观不假回滚；无效整体拒绝沿既有gate。350定向/1296全前端/build/diff精确184绑定，独立350与2probe分组；未跑Rust/cov/GUI/ReactDOM/fullA02/Suite，updater暂停。

2026-10-09：[A02c2a 无效布局原始数据保留](superpowers/plans/2026-10-09-yam-cmux-a02c2a.md)源码与独立审核通过：损坏/读取失败警告后保原raw，自动保存与外观Apply不覆盖；无效布局Retry不可用，显式新建终端沿原路径解除保留。正常有效恢复/owner失败Retry/global16不变；实际覆盖RED→一行既有gate修复，optional appearance fixture 六ReferenceError历史保留。266定向/1280全前端/build/diff精确184绑定，独立266与2callback分组；未跑Rust/cov/GUI/ReactDOM/v5/fullA02/Suite，updater暂停。

2026-10-09：[B01b 项目上移／下移](superpowers/plans/2026-10-09-yam-cmux-b01b.md)源码与独立审核通过：main 侧栏已保存唯一目录项目 ↑/↓ 相邻移动，边界禁用，derived/secondary 无入口；保目录/名称/当前项目/折叠/会话/进程，最新集合先写后生效，Add-await 保重排，secondary 零 echo。68定向/1274全前端/build/diff精确184绑定，独立68与3callback分组；UI语义RED、missing helper scaffold和夹具失败分列。未跑Rust/cov/GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[B01a 项目直接改名](superpowers/plans/2026-10-09-yam-cmux-b01a.md)源码与独立审核通过：main 侧栏手动项目 Rename project…，只读目录、1–200 Unicode code point 显示名；保目录/顺序/折叠/当前项目/进程，derived-only 与 secondary 无入口。先写后生效，Add 异步验证后保最新集合；57定向/1263全前端/build/diff精确184绑定，独立57及3callback分组。真实入口/写失败RED与夹具失败分列；未重跑Rust/cov、无GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[A11 R9 current-at-run隔离实测](superpowers/plans/2026-10-09-yam-cmux-a11-r9.md)一次300/300，提交→parser P95 25.780542ms、3693844bytes exact drain；high630441.974B/s（nominal60.1236%）、4932.079ms stall，非1MiB达标。echo STOP ACK/flood server-rejected未知原因原stop_failed保留，shutdown在parser signal后ACK，fallback=true/graceful=false；root四PID None/私有namespace移除。513product/183selected及独立F7/bundle/gate审核通过，保留唯一R9app但无GUI/no-hang/cmux/fullA11/Suite结论。empty[] plist历史澄清与失败断言保留；本次docs更新使旧current-source gate过期，updater暂停。

2026-10-09：[B04b Clear入口](superpowers/plans/2026-10-09-yam-cmux-b04b.md)源码/独立审核闭环：palette及第九可编辑快捷键，fresh mac Command+K/其他Ctrl+Shift+L；旧8/4与损坏/读取失败保持Clear=null，Save先写后生效。焦点/完整守卫先于键盘拦截；面板关闭提交后consume-first effect按身份/版本执行一次，closed forged/新modal/stale为0RPC，Reopen第五参数保留。79target/1247full/build/diff精确183绑定，独立58+21及5App分组不重复加总；无Rust/cov/GUI/IME/ReactDOM/fullB04/Suite，updater暂停。R9新隔离包仅计划。

2026-10-09：[B05c 重新打开隐藏标签](superpowers/plans/2026-10-09-yam-cmux-b05c.md)源码/独立审核闭环：工具栏与palette、最后空tab仍可达；每window一个memory-only cached记录，同renderer原pane/当前focused fallback，零输入/历史重放/进程启动/控制权获取。live→ended失效，已ended同cached可readonly；不是关闭进程或持久undo/fullB05。166target/1236full/build/diff精确182绑定，独立166+5App分组不加总；无Rust/cov/GUI/ReactDOM/TUI/Suite，updater暂停。当时下一Clear入口仅候选（现B04b已源码交付）。

2026-10-09：[权威 Clear terminal display](superpowers/plans/2026-10-09-yam-terminal-authoritative-clear.md)源码/独立审核闭环：运行中 normal buffer 保留当前行，旧显示不被权威scene恢复，日志不删除/零输入/不重启；普通、Agent、command、SSH均适用，saved/alternate/old-cap不可用。pending手动意图0viewport RPC，完成后正常poll刷新；公开clear+bottom/marker ring。fresh1225full/build精确181绑定闭合旧pretrim证据缺口，fmt/clippy/diff通过；无fullRust/cov/GUI/ReactDOM/真实owner/fullparity/Suite，updater暂停。NEXT B05仅计划。

2026-10-09：[A08d 独立终端行高](superpowers/plans/2026-10-09-yam-cmux-a08d.md)源码与独立审核闭环：默认1.35，1–2最多两位小数，独立输入/预设/Save，当前及未来视图共享全局设置，不改变Profile或移动schema。同值Save仅重试仍有效的未完成fit，P2真实RED已闭环；52定向/1213全前端/build/diff通过，独立52+三个App分组及原探针通过（不加总唯一数）。本片未重跑coverage/Rust；AST非GUI，full A08/native/Suite待验，updater暂停。


2026-10-09：[Native window identity前提](superpowers/plans/2026-10-09-yam-cmux-native-window-identity.md)源码/独立审核闭环：26个可信叶/父身份守卫保留epoch/claim/Unknown，父窗口激活与叶URL/eval查找区分；浏览器仍独立窗口，非同pane/full C01。现有SDK生产unstable必要补充、536包/lock/cap不变。640Rust/3既有ignored按仅Cargo变更的精确投影保留，最终normal check/link/fmt/clippy/diff及7JS通过；独立4identity/33window/10browser/7JS分组不加总。nativeGUI/Suite待验、updater暂停。

2026-10-09：[A07c3 上报提示符位置导航](superpowers/plans/2026-10-09-yam-cmux-a07c3.md)源码/独立审核闭环：普通运行中本地终端 More actions→Previous/Next reported prompt，仅滚动有界100位置、不发送输入、不循环，不保证精确PS1；上报状态仍不可信。两项parser失败/替换导航残留P2真实RED→GREEN并独立关闭。r2 1193full/11UI/build/diff；Rust字节未变，native5/fmt/clippy与独立r1 84front+5native按投影保留，r2 11UI+两个原probe分组；无新coverage/fullRust、GUI/ReactDOM/fullA07/Suite验收，updater暂停。

2026-10-09：[A07c2 可选Zsh命令状态报告](superpowers/plans/2026-10-09-yam-cmux-a07c2.md)已源码/独立审核闭环：独立默认OFF、未来普通Unix Zsh/Profile，单包装四模式自动A/C/D与0–255退出码；不修改RC、不重注入现会话、cwd偏好独立。状态是不可信Shell报告而非进程/Agent完成证明，P2帮助说明遗漏已实际RED→GREEN闭环。r1 final1179/build/diff；coverage历史r0 99.73/93.76/96.33未重跑。独立r0 109前端/8native/14cwd，r1 18UI+1外部组件probe分组保留；native GUI/owner、Ctrl-C/jobcontrol、完整A07/Suite待验；当时提示符跳转尚未实现（后续A07c3已交付），updater暂停。

2026-10-09：[A07c1 Shell-reported状态接收](superpowers/plans/2026-10-09-yam-cmux-a07c1.md)有限源码与测试审核通过：普通本地终端显示有界当前phase/last exit，缺标记显示Not reported，非可信进程/Agent真值。当时自动Zsh发射器尚未实现（后续A07c2已交付）、当时提示符跳转尚未实现（后续A07c3已交付）；1152 full/cov/build/native2+cwd6与独立66项前端、2项native receiver及1个外部actualApp synthetic probe通过，GUI/fullA07/Suite未验，updater暂停。

2026-10-09：[A11 r8隔离实测](superpowers/plans/2026-10-09-yam-cmux-a11-r8.md)300/300，提交→parser P95 26.165334ms，3689748bytes exact drain；两次STOP ACK，最终direct wait/PID None/cleanup complete。fallback=true、graceful=false；高档629626.241B/s（nominal的60.0458%），非1MiB达标/GUI/cmux/fullA11或跨源码性能提升。构建current-at-run，文档更新后旧receipt/gate不改；r7历史拒绝不追认根因，updater暂停。

2026-10-09：[Unix process-tree lookup](superpowers/plans/2026-10-09-yam-terminal-stop-ps.md)移除PATH依赖，固定系统ps缺失明确失败。真实无PATH RED→GREEN、两隔离子probe、选择器边界与7项既有生命周期测试及独立审核通过；Windows/身份/恢复流程保持。未证明r7 stop拒绝原因，原结果保留；fresh packaged r8、GUI/Suite仍待，updater暂停。

2026-10-09：[A11 r7隔离实测](superpowers/plans/2026-10-09-yam-cmux-a11-r7.md)：300/300，提交→parser P95 30.454875ms，非UI延迟；3408148bytes exact drain。高档仅577438B/s（offered的55.07%）。两次stop拒绝后fallback清理完成、direct wait/四PID absence成立，graceful=false，拒绝原因未证实。无完整A11/cmux/原生GUI结论；本次文档更新使旧构建后续current-source gate过期，updater暂停。

作者：Jeff.Liu。更新：2026-10-08。当前HEAD为`8fb2cb0`加已授权未提交的终端对齐切片，应用版本0.1.0；HEAD不等于dirty源码冻结快照。本文当前布局声明见[执行记录](superpowers/plans/2026-10-08-yam-cmux-terminal-parity-progress.md)，下方历史报告保留各自提交、事实与缺口，不混称最新原生验收。

T06 当前测量另绑定已闭环 T05 的 dirty 产品源码与一次 unsigned release 隔离包；HEAD 本身不足以描述该工作区。[冻结构建与原始证据](evidence/yam-performance-t06/README.md) 区分后台 owner、原生 WebKit 中的终端模块和仍未验收的真实 App 交互。三轮 owner 短测、三轮各100次模块输入、三轮各100 warm/100 ended cold 模块切换已实测；末槽超时与逐槽持续输出缺口先红后修，新连续性短测18/18完整。16路持续输出显式30分钟实测361/361槽、全阶段379/379完整，0迟到/缺槽；后台内存中位54.146 MiB、峰值62.443 MiB，CPU中位0.070664核，实际输出约77.6kB/s。停止后约57.990 MiB，重新启动owner后25.909 MiB，明确不是GUI App重开。当前不宣称整 App 性能目标达标。空 GUI 的9个实际采样为partial，普通 Cmd+Q、真实键鼠/通知/Hook/权限流程及生产 output queue 遥测仍未验收。

T06 完成测量后顺序验证：Python63项、前端138项通过，工具TS覆盖率lines/functions100%、branches98.69%；frontend build、Rust fmt --check与clippy -D warnings通过。未修改产品源码、引入依赖、调整权限或清理真实历史；最终证据包含失败探针、无效CPU单位/重叠运行标签及每5秒曲线，不能用模块采样替代整App原生验收。

T07 已完成[候选评估并保留基线](evidence/yam-performance-t07/README.md)：模块warm p95约3/2/2 ms、强制ended cold约15/16/17 ms不代表实际App切换；输入p95 101/101/100 ms包含50 ms探针轮询，不能归因投影。same-size resize仅列为service revision候选，Rust PTY同步、输入lease、output/viewport revision和恢复ready=false契约保持；Take control当前没有立即尺寸同步。缺少同机固定负载实际App三轮100次warm路径目标改善≥15%、其它关键p95退化≤10%的比较证据，因此不改产品实现、不宣称优化或整App目标通过，也不把证据不足说成候选无收益。真实App路径测量仍待原生验收。

T08 当前冻结包已完成[一次纯 owner RPC 原生验收](evidence/yam-native-t08/README.md)：启动前后校验实际 bundle executable、隔离身份、产品源码及完整包/资源 SHA，profile 由不存在变为非空后保留。RPC 重连同 owner、Unicode 日志定位、两 client 精确租约冲突/接管、显式停止后场景重启保留、owner 崩溃 needs_attention 且不自动重跑、stop-all 实测通过，exit0、stderr为空，3个本轮owner均退出。通知全程暂停，未运行GUI；owner restart不代表App GUI重开，RPC双client不代表双窗口UI。真实红关闭/Cmd+Q、原生键鼠复制/TUI/控制UI、真实CLI/Hook、通知点击/权限与Windows/Linux仍未验收。CUA三次超时只证明控制工具本轮不可用，不诊断缺权限；10月1–2旧包证据不归入本轮。

| 标签 | 含义 |
|---|---|
| 已支持 | 当前代码具备该行为，有下列代码/自动化/实测依据；同时查看平台验收边界 |
| 降级 | 缺前置能力、可信身份或容量时明确回到普通终端、日志或不可用状态 |
| 未实现 | 没有用户可用的完整入口/契约，路线图不构成支持承诺 |
| 未原生验收 | 已有代码或自动化，但指定平台/操作/当前架构的实际桌面验收未覆盖 |

“已支持”和“未原生验收”可同时成立：实现与实机证据是两个维度。回复就绪、进程退出、OS 接受通知、用户看到通知和用户已读分别记录。

## 功能与证据

### 2026-10-17 第二轮桌面优化

2026-10-18 补验完成：结束 Codex 标签启动恢复与阅读历史均不新增会话；原 owner、3 条原任务和同一对话的 6 条消息保持。

作者：Jeff.Liu。当前实现和有限原生验收：

| 能力 | 当前状态 | 证据边界 |
|---|---|---|
| 本机网关与模型目录 | 显式身份检查、GET 模型目录、筛选/选择及既有模板 Apply；3 秒/1 MiB 限量与取消 | 固定 macOS 应用本机 fixture 目录→模板→启动已验证；不表示真实厂商认证、额度、计费或推理通过。 |
| Git 变更导航与文件预览 | staged/worktree 行号和块导航；原生授权下只读 UTF-8 与静态 PNG/JPEG/WebP，查找/行定位/缩放 | GUI 正常与取消、字面 HTML、图片缩放通过；路径/替换/格式/像素/资源释放边界有回归。损坏 JPEG 原生拒绝已实测。 |
| Codex Conversation | 核实 thread/cwd/provider/generation/store；只读分页、50/500 条预算、64 KiB 单条显示、工具折叠及未知占位；保留终端和阅读状态 | Codex 0.162.1 合成存储实际分页和 GUI 两次 Continue、重复刷新、重开后 6 条消息保持；读取无新增 fixture POST。协议边界和迟到/乱序由自动化覆盖；legacy/不支持 CLI 明确不可用。 |
| 原任务保持 | 固定应用普通退出与重开复用原 owner/运行会话；切换恢复子控件焦点；慢网关期间有限输出继续 | macOS PID 定向 GUI 与认证后台状态证据；不代表长期稳定性、吞吐性能或跨平台验收。 |

前端 1520 项和覆盖率 99.74/94.52/96.60、Web build 通过；原生最终检查、两种模型复核及完整边界见[第二轮工作流](yam-core-workflows.md#2026-10-17桌面优化第二轮-r1r3)与[执行回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/second-round-plan-20261017/implementation-report.md)。没有真实厂商请求、无新依赖；Windows/Linux 与真实账号未验，正式 Suite coverage 绑定仍 uncovered，第一轮缺项保持，updater 暂停。

### 2026-10-17 第一轮桌面优化

| 能力 | 本轮状态 | 当前证据边界 |
|---|---|---|
| 模板损坏保护与恢复 | 读取错误保护、复制原文、确认重置和失败保留；原生父窗口 sheet 死锁已先红后绿修复 | 新包 GUI 实测取消保留、复制原文、明确重置后恢复写入；原始备份精确还原。写入失败由自动化覆盖。 |
| 续聊名称与置顶 | 成功后即时继承，连续两次保留，沿用原连接与原生身份 | GUI Codex 连续两次本机 API fixture 续聊保持名称/置顶/UUID/上下文；修复重置后续聊代码字节未变，三 CLI fixture 再次通过。真实账号未执行。 |
| 会话连接详情 | 保存的启动快照与脱敏端点；认证/计费/运行时模型/最终上游未验证 | 当前 GUI 缺元数据为 Unknown，受管 API 快照和未验证说明可见；组件与窗口几何回归通过。 |
| 本机连接模板和端口检查 | 沿用可选 provider 模板；显式 loopback TCP 共用 2 秒预算，无模型请求 | GUI 保存/两次 Apply、正常/关闭/不支持/真实超时通过；超时期间 heartbeat 50→59，检查前后 POST 数均为 10。 |
| 全局停止确认与显式重连 | GUI/托盘/macOS 菜单共用确认；原 Client/游标恢复，不自动重跑 | 当前窗口和 macOS 菜单取消保持任务，只停止自建 fixture 后原任务仍运行；普通退出重开、live 输入、Dock 激活/重复启动复用唯一 GUI 已实测。旧 owner 托盘、确认全局停止、强制断连后的显式重连未执行；退出后 Dock 重开保持原 owner/全部运行会话且唯一 GUI；临时固定已还原。 |

前端 1445 项、覆盖率门槛通过；原 GUI 阶段的三项已安装 CLI 本机 fixture、35 项重置定向回归、Web build 和固定 macOS 开发包构建回执保留。后续已在同样并发条件下完整复现两项 Rust 假服务器 `read_exact` 的 `WouldBlock`：当前 macOS 的 accepted socket 继承 listener 非阻塞模式，设置读超时不会清除此模式。确定性回归先红后绿，共享测试 accept 边界显式恢复 blocking，保留三秒预算与原断言；5 项定向连续 10 轮通过，原并发条件与默认并发的完整 Rust 均为 708 项通过、6 项既有忽略。只改 `#[cfg(test)]` 模块，运行时源码及 owner/运行任务保持。完整新失败日志已保存；早先仅哈希的回执仍无法恢复原文，不把它改写成已确证的同一失败。全文件既有格式差异及其他系统运行缺口保留。

用户允许按 GUI PID 定向控制后，已补验上述原生流程；整体仍为部分验收，旧 owner 托盘、确认全局停止和主动断连重连等未执行项保留。该第一轮回执未覆盖第二轮、真实厂商账号和 Windows/Linux；当前第二轮事实见上节，历史 R11—R15 保留原证据边界。详见[当前工作流验收](yam-core-workflows.md#2026-10-17桌面优化第一轮-t1t6)。

| 能力 | 当前状态与边界 | 依据 / 最后记录的验证基线 |
|---|---|---|
| 默认终端光标（A08c） | 源码/独立审核支持block、underline、bar与blink；独立write-first Save，默认block/true，损坏raw保留；main一次发布、secondary零echo，Profile不变，程序可覆默认。native/ReactDOM/DECSCUSR视觉及inactive/fullA08待验 | [A08c记录](superpowers/plans/2026-10-09-yam-cmux-a08c.md)：94target/127fixtures/980full，coverage99.71/93.85/96.24/build/diff；Rustprefix25未变未重跑；独立66+2实际facade probes |
| 项目/会话 | 已支持本地目录分组、并行会话、筛选、重命名、搜索、重新运行，目录取消保留原值 | [App](../apps/desktop/src/App.tsx)、[项目工具](../apps/desktop/src/workspaces.ts)、[阶段记录](yam-next-stage-execution.md)；macOS 阶段样本，当前代码 `6b00a7d` |
| 持续后台 | 已支持独立 owner 持有 PTY/parser，GUI 退出继续，重开同一 owner 不重复启动 | [后台](../apps/desktop/src-tauri/src/background.rs)、[连续性记录](yam-session-continuity-plan.md)；`400f5ba` [三平台 CI 36938013741](https://github.com/ainiaa/yam/actions/runs/36938013741) 实际隔离包生命周期 |
| 停止/恢复 | 已支持显式 Stop all tasks and quit 清理；无活跃任务且 60 秒无客户端请求才闲置退出；后台/parser 故障可见，遗留运行态 needs_attention，不自动重跑 | [会话管理](../apps/desktop/src-tauri/src/lib.rs)、后台与同上包证据；普通 Cmd+Q 联合流程未原生验收 |
| 终端/输入 | 已支持后台持续解析、投影/最终场景，显式 Take control 转移输入；部分接受后不整段自动重发 | [终端服务](../apps/desktop/terminal-service.cjs)、[内核](../apps/desktop/src-tauri/src/terminal_runtime.rs)、连续性记录；`400f5ba` 三平台场景/生命周期与 Windows 管道/ConPTY 回归；原生键鼠/缩放/快速切换未验收 |
| 普通新建、默认home与Shell选择 | 已支持一动作普通终端，缺省目录由owner解析home；显式Unix Bash/Zsh/Fish interactive/login选择与Windows cmd.exe `/D`；独立保存仅影响之后普通启动，旧请求/默认偏好omit字段，旧owner显式拒绝不自动重跑。个人命名Profile支持名字、Shell/cwd、CRUD/default/selected启动及损坏存储显式恢复；环境名称引用由owner临时解析并有预算/平台保护；初始字体/字号/主题快照与逐view字号操作已支持；可信项目Profile/冷显示恢复待后续 | [A01a](superpowers/plans/2026-10-08-yam-cmux-a01a.md)、[A01b](superpowers/plans/2026-10-08-yam-cmux-a01b.md)；[A02a](superpowers/plans/2026-10-08-yam-cmux-a02a.md)、[A02b](superpowers/plans/2026-10-08-yam-cmux-a02b.md) [A02c1](superpowers/plans/2026-10-08-yam-cmux-a02c1.md) 最新827前端/独立审核通过，527串行Rust/2原有忽略继承A02b证据；完整Rust默认并行fixture资源失败仍未覆盖；原生Shell/login/Profile、真实ReactDOM与Win/Linux运行未覆盖 |
| 固定两窗口 B05a | More actions/Palette打开main之外一个secondary；新建独占session，选择外窗活动session聚焦原slot；global16 view/pending/draining、双namespace隐藏成员owner核实恢复0spawn；失败保raw，显式Retry busy/成功解除gate。main唯一settings/notifications；secondary存在时mainclose隐藏，显式Quit原样 | [B05a回执](superpowers/plans/2026-10-08-yam-cmux-b05a.md)；9生产+23tests/32owned，941前端、coverage99.56/93.69/95.76/build，12定向/559串行Rust+2原ignored/fmt/clippy；独立360front+12Rust与r1 220+两个1probe、spec/quality通过，355成员归档。native/ReactDOM/crossGUI/三平台未验；不是move/镜像或完整B05，updater暂停 |
| 同GUI两窗口标签移动 B05b | main↔secondary显式移动原session；源暂停/真实dispose后ACK、目标ready complete，单global16预算；Check/Continue/Open显式pending恢复，native epoch/generation隔离，无spawn/restart | [B05b回执](superpowers/plans/2026-10-09-yam-cmux-b05b.md)；4生产+6tests/140source，227target/993full、coverage99.72/93.41/96.08/build，11target/578serialRust+2原ignored/fmt/clippy/diff；独立34+193front/2probes/11Rust及spec/quality PASS。原生/ReactDOM/PID/CrossGUI/Suite未验，不含镜像/拖放/fullB05；旧debug包不含本片，updater暂停 |
| 固定保留缓冲区对齐 A05a1 | 新view由浏览器隐式1000对齐现owner2000，唯一常量复用frame viewport上限；共享factory覆盖普通/Profile/history/move，不迁移live、不改owner/global16预算 | [A05a1回执](superpowers/plans/2026-10-09-yam-cmux-a05a1.md)；2生产+7tests/141source，50target/168bindings/998full、coverage99.72/93.41/96.08/build/diff；独立95+151及spec/quality PASS。Rust25字节不变未重跑，实际>1000 RED→GREEN。DOM/open/Fitstub、ASCII非fullcells/native/memorybench/Suite；键盘未实现，旧debug包不含本片 |
| 未来普通终端保留行数 A05a3 | 独立保存200–2000/default2000，仅新ordinary/Profile；已有/恢复/move按recorded frame，保存0当前view改变；default请求省略，legacy frame2000，保守预算不增 | [A05a3回执](superpowers/plans/2026-10-09-yam-cmux-a05a3.md)；9生产+12tests/145source，321target/1038full、coverage99.72/93.54/96.12/build/diff，Rust7target/585serial+2原ignored/fmt/clippy；独立93+7及bundle33，overlap原证据与串行纠正保留。native/ReactDOM/fullA05/memory/OS/Suite未验，旧debug138不含，updater暂停 |
| Shared方向键未知值边界修复 | 只接受四精确Arrow，原两平台方向组合保持；synthetic原型名称拒绝且不throw/consume/action，无App/key policy变化 | [有限修复回执](superpowers/plans/2026-10-09-yam-cmux-shortcut-boundary.md)；1生产+2tests/145source，12独立RED→GREEN，101target/1052full、coverage99.72/93.50/96.12/build/diff；Rust25未变，独立82+1/spec/quality PASS。native物理键/ReactDOM/OS/TUI/Suite仍未验 |
| 固定键盘viewport A05a2 | mac Command、其他Ctrl+Shift的PageUp/PageDown/End；current focused ready normal/mouse-none守卫，先consume再publicpage一次，onScroll单RPC/livebottom权威确认/retainedlocal；排除保底库行为 | [A05a2回执](superpowers/plans/2026-10-09-yam-cmux-a05a2.md)；2生产+2tests/142source，55target/1019full、coverage99.72/93.45/96.08/build/diff，Rust25未变未重跑；独立91+12+1及r1spec/quality PASS，原prototype P2关闭、r0保留。nativeDOM/TUI/OS/fullA05/Suite未验，旧debug包不含本片 |
| 可选Zsh目录报告 A07b1/A07b2 | 默认OFF独立偏好，Save仅未来Unix ordinary/Profile；明确Zsh和Current/System default可请求，owner原始argv0绝对basename zsh才注入，最终SHELL不改变判断。unsupported默认原builder一次/0assets/warning；legacy[-l]/System[-i/login]不变，现会话不变。私有raw ZDOTDIR/trampoline/4096-byte OSC7、256资产与原失败清理保持 | [A07b1回执](superpowers/plans/2026-10-08-yam-cmux-a07b1.md)历史证据保持；[A07b2回执](superpowers/plans/2026-10-09-yam-cmux-a07b2.md)：4生产+4tests/8owned、145source，53/1062前端、coverage99.72/93.51/96.12/build，18target/589serialRust+2原ignored/fmt/clippy/diff，独立57+18通过。真实私有legacy-l PTY baseline/integrated验证RC顺序/首提示/status；首canonical期望fixture失败与业务前GREEN如实。非Unicode命名RC/任意host RC/崩溃残留/native ownerGUI/ReactDOM/defaultShell安装选择/跨平台/完整A07/Suite待验；旧debug138不含，updater暂停 |
| OSC7目录报告 A07a | receiver-only；当前可见view纯文本Terminal-reported directory是不可信stdout声明，launch/New/Git/trust/resume cwd不变。仅local file URI/当前平台绝对路径、URI/path各4096 UTF8 bytes；坏/缺最新metadata只清报告，live serde/proxy保字段，历史outer+raw剥离，watermark/缓存/失效守卫，不额外同path重绘 | [A07a回执](superpowers/plans/2026-10-08-yam-cmux-a07a.md)；5生产+8测试/13owned，83定向/897全量前端，533串行Rust/2原有ignored、fmt/clippy/diff；895-era coverage99.70/94.12/96.79/build绑定相同final前端business。独立294+6及actual probe与spec/quality通过，122源码/23raw/9checks匹配、207成员归档。receiver不注入hooks/自动cd；DirectoryValidation旧122源码debug构建与root/review packaged parser各6checks/14requests已通过、21成员归档，非owner/GUI/Shell证明。真实native/ReactDOM/跨平台、整套默认并行Rust/完整A07待验；既有PTY日志可能已含OSC |
| 应用快捷键 B04a | 八项动作可编辑或null禁用；Command/Ctrl精确平台路由，非macOS除Ctrl+N都Shift；逻辑字母/括号和有限reserved冲突；window capture单执行，draft校验/写成功才应用，旧key缺新key才内存迁移 | [B04a回执](superpowers/plans/2026-10-08-yam-cmux-b04a.md)；4生产+9测试，writer108/全量865/coverage/build、独立138及160handler probe与spec/quality通过；117源码和16回执匹配。真实ReactDOM/WebView/xterm/布局/IME/AltGr/OS/Windows/Linux待验，不称完整B04或OS全局 |
| 粘贴预览 A04a | 原生textarea text/plain捕获；默认换行/非tab控制字符预览，独立risky/always/never；全模式128 KiB UTF-8/Unicode预算，4096 code point显示但确认完整原串；单pending、绑定原view/版本/焦点，观测失效零发送。沿普通write_session claim，不接管、不保证新增严格lease原子性 | [A04a回执](superpowers/plans/2026-10-08-yam-cmux-a04a.md)；源码全量849/coverage/build、独立262与17 fixture probe、spec/quality通过；真实ReactDOM/当前包剪贴板/GUI焦点/IME/TUI/ownerPTY及Windows/Linux未原生验收，完整A04仍待后续 |
| System终端配色 A08b | global/Profile Theme可选System，symbolic存储/提交、三字段/v3/defaultdark不变；每窗口本地深浅色，仅current own system views改palette，不fit/resize/write/广播/焦点，显式主题不动，字体ready fit不丢 | [A08b回执](superpowers/plans/2026-10-09-yam-cmux-a08b.md)；4生产+8测试/12owned，120target/967full、coverage99.56/93.75/95.78/build/diff；独立120+2actual probes PASS/135hash匹配。Rust未变未重跑；49fixturefail修绑定保原断言，latestpostinstall实际RED。nativeOS/ReactDOM/chrome/cursor/fullA08/Suite未验，updater暂停 |
| macOS选中文件 A04b2 | More actions → Show selected file in Finder…；精确绝对选区→本机原始/canonical路径预览→显式Finder显示，regular-only/4096bytes/身份与nativeepoch复核，每窗口一个真实job；取消不早释放，不读内容、不执行/defaultopen、不写PTY或存储 | [A04b2回执](superpowers/plans/2026-10-09-yam-cmux-a04b2.md)；7生产+3测试/135source，952front/8target/567serialRust+2ignored、coverage99.56/93.65/95.77/build/fmt/clippy/diff；独立30+29front/8Rust+2actualprobes PASS。Rustfull仅test初始化旧字节，finaltarget现字节；Finder/ReactDOM/OS/Suite/真实非UTF8filesystem EILSEQ/TOCTOU未验，不称editor/OSC8或完整A04，updater暂停 |
| 可见HTTP(S)链接 A04b1 | 仅literal URL、精确Cmd/Ctrl主键、4px抖动；选择/拖动/TUI/modal拒绝，当前view/cell signature复核；raw/canonical各4096 bytes，16行/8192units/32候选超预算全拒。main窄scope默认HTTP(S) opener，不write/take。OSC8 no-op且可能shadow，路径/editor另片 | [A04b1回执](superpowers/plans/2026-10-08-yam-cmux-a04b1.md)；3生产+4测试，writer124/885、coverage99.70/94.07/96.79/build/diff、独立94+actual probes、spec/quality通过；当前LinksValidation隔离包build0/hash一致但未原生运行，GUI/OS browser权限/TUI/ReactDOM/WindowsLinux、OSC8/完整A04待验 |
| 嵌套布局、标签与焦点 | 已支持16叶/深度16内局部分屏，每pane多标签、菜单移动、内部拖动排序/跨pane/四边缘原子拆分；每split20–80%受实际最小尺寸约束的拖动/键盘调整与重置；实际几何方向焦点、临时最大化/还原。v4迁移v1/2/3并向owner核实包括隐藏成员；不创建/停止原会话、不自动接管。固定两窗口B05a源码已交付；同GUI显式跨窗口move源码见B05b；镜像与原生验收待实现/验证 | [TerminalLayout](../apps/desktop/src/TerminalLayout.tsx)、[状态](../apps/desktop/src/terminal-layout.ts)、[最新执行记录](superpowers/plans/2026-10-08-yam-cmux-terminal-parity-progress.md)；755前端测试及逐切片独立审核通过，覆盖率仅TS，realReactDOM/native当前布局、重开和三平台未覆盖；旧F2记录仅历史 |
| 历史 | 已支持 JSON 原子保存/备份恢复、结束场景只读；旧记录无场景降级日志回放；存储/容量错误可见，不静默丢弃未读回执 | [HistoryStore](../apps/desktop/src-tauri/src/history.rs)、[回执](../apps/desktop/src-tauri/src/agent_events.rs)，当前 `6b00a7d` 及连续性记录 |
| 历史摘要分页与容量管理 | 当前工作区新增默认100/上限200的摘要页、按ID详情、全局活动/未读/关注查询、独立有界收件箱和通知重试；游标绑定store instance/revision与查询上下文，过期重载；容量面板区分元数据/日志/场景/备份/归档，24 MiB提醒；归档/还原操作见下列T04工作区实现 | [历史](../apps/desktop/src-tauri/src/history.rs)、[前端](../apps/desktop/src/history.ts)、[分页回归](../apps/desktop/tests/history.test.mjs)；2026-10-03 T03工作区自动化，当前页外日志命中/通知按ID读取；原生桌面分页操作未实机验收 |
| 历史归档/还原 | 当前工作区已支持显式按ID归档完成/失败/停止的记录；无未读、待发/失败通知、原生续聊claim或仍持有最终场景的Session时才允许。自动归档默认关闭，T05可显式启用30天规则；日志/frame保持原路径。分片、事务、hot、manifest、可恢复bak同步后完成，重启先恢复再暴露历史；还原超过32 MiB明确拒绝。归档页独立revision和来源上下文，详情/场景/原生续聊按ID可读档案 | [HistoryStore](../apps/desktop/src-tauri/src/history.rs)、[归档入口](../apps/desktop/src/HistoryArchive.tsx)、[原生管理](../apps/desktop/src-tauri/src/lib.rs)、[UI回归](../apps/desktop/tests/history-archive.test.mjs)；2026-10-03 T04/T05工作区自动化，三平台实际桌面归档/恢复/原生续聊联合操作未原生验收；后台协议v2，活跃v1 owner保留任务并提示升级 |
| 历史保留/永久清理 | 当前工作区新增应用内最多20个归档ID的预览与单独确认/取消，展示精确条数、时间、逻辑字节与范围；默认自动归档和自动删除关闭，损坏policy报错并保持关闭。仅显式启用后，owner无活跃任务且60秒无RPC时小批归档UTC严格超过30天且全部已读的结束记录；每项和批末重新检查RPC/active/shutdown。永久清理仅验证过的YAM归档分片、日志与保存场景，不清CLI原生历史或取证备份；私有事务在同owner或重启恢复，hot/bak成员同步后才删除文件。部分失败保留固定错误与事务，UI仅清实际回执ID对应名称、偏好和结束视图缓存 | [历史](../apps/desktop/src-tauri/src/history.rs)、[后台](../apps/desktop/src-tauri/src/background.rs)、[预览确认入口](../apps/desktop/src/HistoryArchive.tsx)；2026-10-03 T05宿主自动化，三平台原生权限/中断与实际桌面清理未原生验收；本开发未清理用户真实数据 |
| 日志搜索/导出 | 已支持当前/全部保留日志分页搜索、Unicode/ANSI 位置/摘录；T04增加热历史与档案的有界continuation，无命中也能继续；游标绑定owner/查询/范围/源成员与归档revision，变更明确重启搜索、纯文本/原始导出，原生目的地、禁止覆盖；截断的旧输出不能找回 | [日志](../apps/desktop/src-tauri/src/session_logs.rs)、[搜索](../apps/desktop/src/SessionLogSearch.tsx)、[导出](../apps/desktop/src/SessionLogExport.tsx)，连续性记录 `4cb533d` 核心/日志联合验证及包脚本 |
| 收件箱/通知 | 已支持逐轮权限/回复/中断/失败回执、重试/暂停/前台抑制；打开指定收件箱项才已读，OS 接受不清未读；送达/持久化间崩溃可能重复 | [Agent 状态](../apps/desktop/src-tauri/src/agent_events.rs)、[通知历史](notification-acceptance.md)，macOS 2026-10-01 样本及 `3c181db` 阶段 CI；当前架构通知联合桌面流程未原生验收 |
| 实时内存 | 已支持每 5 秒、单在途采样，隐藏时停止；应用含 GUI/WebKit/owner/parser，任务单列；归属不完整/过期/失败显示不可用 | [采样](../apps/desktop/src-tauri/src/memory.rs)、[轮询](../apps/desktop/src/memory.ts)、[live-memory](superpowers/plans/2026-10-02-live-memory.md)，`585edb3` CI、`ca396c4` WebKit receiver 修复与后续自采样/真实前端 IPC；当前 `6b00a7d`，可见 UI 读取超时仍未验收 |
| 可信项目启动配置 | 当前工作区已实现可选version1 yam.json、预览与独立显式信任、用户单独启动、命名模板和应用私有默认；本次明确UI编辑>信任项目/模板>global，空串覆盖有效。owner启动前重读精确有界source并绑定canonical路径/物理根，变更或同名不同根不继承信任。env只引用owner已有变量，源/目标YAM_大小写均拒绝，值仅builder.env，不读.env/持久化/回传，不插值custom shell文本 | [项目配置](../apps/desktop/src-tauri/src/project_config.rs)、[实际App路径](../apps/desktop/src/App.tsx)、[预览](../apps/desktop/src/ProjectConfigPreview.tsx)、[T09测试证据](evidence/yam-project-config-t09/README.md)；正常/边界/异常、TOCTOU、取消旧回包、字面argv和owner分配前拒绝自动化；真实GUI/CLI/Hook/权限及Windows/Linux未原生验收 |
| 个人启动模板 | 已支持最多32个本机个人模板，显式保存/更新/复制/删除；名称1–80个Unicode code point；仅保存adapter、mode、extra_args、prompt、command和可选provider连接快照（密钥仅环境变量名）。读取失败保留原始数据并保护所有写操作，明确确认重置成功后才恢复写入。应用模板只填充启动表单，不启动任务、不信任项目、不接管终端，且保留cwd、项目预览/信任和设置。localStorage明文保存，prompt/custom command/参数未加密，不应保存secret；不持久化env、cwd、模板名运行时信息或task state | [F4实现与测试](../apps/desktop/src/launch-templates.ts)、[F4证据](evidence/yam-functional-f4/README.md)；生产模块、组件和 App 回调自动化通过；本轮 GUI 模板保存/Apply 两次及损坏后取消/复制/重置已实测；Windows/Linux 和真实厂商账户联合验收未覆盖 |
| 隐藏视图释放 | 当前布局全部成员（包括隐藏结束标签）受16视图预算保护；非成员的已结束且保存确认缓存可按既有策略释放，live、旧日志、保存失败或旧owner缺persisted时保留 | [缓存](../apps/desktop/src/terminal-views.ts)、[当前布局记录](superpowers/plans/2026-10-08-yam-cmux-b02b.md)；旧[renderer-memory](superpowers/plans/2026-10-02-renderer-memory.md)测量保留历史边界，不代表新GUI收益 |
| 脱敏诊断导出 | 已支持无选中会话时从状态栏导出 JSON；固定版本/平台/协议信息、健康枚举及会话/回执/集成计数，不含输入、终端文本、argv/env、凭据、身份、路径或原始错误；取消不写入，私有临时文件完整发布且禁止覆盖 | [诊断](../apps/desktop/src-tauri/src/diagnostics.rs)、[RPC](../apps/desktop/src-tauri/src/background.rs)、[前端测试](../apps/desktop/tests/diagnostics.test.mjs)；2026-10-03 T02 工作区自动化，原生目的地对话框三平台实机操作未验收 |

## Agent 与原生版本样本

以下是 macOS 本机真实样本，不是唯一允许版本或三平台支持保证。CLI 由用户安装；YAM 不改全局 Hook、模型、审批或沙箱。单任务结果与持续交互回复不混称整个任务结束。

| Agent | 已支持 | 降级 / 未实现 | 证据及平台边界 |
|---|---|---|---|
| Codex 0.159.3 | 单任务结构化结果；交互六类会话 Hook + 最终 notify、主 session/turn 过滤；验证目录/provider/native ID 后显式 Continue conversation | 未信任/六类能力未启用、同名配置 Hook 冲突、未知/身份参数时普通终端并 warning；Stop 本身不宣称完成 | [Agent 历史](agent-capabilities.md)、[阶段记录](yam-next-stage-execution.md)、[桥接](../apps/desktop/src-tauri/src/agent_bridge.rs)；hooks/list 探测而非锁版本，macOS 已测，Windows/Linux 真实 CLI 桌面流程未验收 |
| Claude Code 2.1.286 | 单任务结构化结果；会话限定七类 Hook、权限/失败、保守 response_ready；验证本地主对话元数据/目录后显式 --resume | 从样本起稳定 2.x 可探测接入，未知主版本/预发布/冲突或未知参数降级；Stop 回复就绪可能继续；相同工具/输入并行权限不保证精确关联 | Agent 历史、阶段记录及桥接；macOS 正常双轮/失败/权限/原生续聊有样本，未来版本及 Windows/Linux 未原生验收 |
| OpenCode 1.18.34 | 单任务/持续接入，原生 prompt/parent ID、完成/权限/中断/失败；每进程绑定一个验证 root | /new 切 root 或队列超限明确 integration unavailable，需新建 YAM 会话；原生 Continue conversation 未实现 | [插件](../apps/desktop/src-tauri/src/opencode-plugin.mjs)、连续性记录 P4 真实双轮/13 事件；三真实 CLI 同一原生联合流程未验收 |
| Shell / custom command | PTY、输入、退出状态、日志和空闲提醒 | 无可信轮次/原生身份时不声明交互轮次完成或原生续聊 | 会话管理及当前自动化；自定义参数保留原 CLI 行为 |

## 平台与发布

| 平台 | 已有证据 | 未原生验收 / 降级 |
|---|---|---|
| macOS 13.5+ | Apple M5 / 16 GiB / ARM64 / macOS 26.6.2，debug/ad-hoc；WebKit 启动/内部自采样、真实前端 IPC；`400f5ba` 包生命周期；2026-10-01 隔离包真实通知点击/退出唤醒 | 当前架构键鼠/缩放/快速切换、正常 Cmd+Q/通知联合流程；可见内存 UI；Developer ID 签名/公证、安装位置迁移/跨构建旧通知稳定性 |
| Windows | CI Rust/NSIS 构建、实际包资源 --desktop 生命周期，输入取消/Unicode shell 路径/ConPTY 关闭回归 | 真实 Agent/桌面交互、系统通知点击/退出唤醒、正式签名安装/升级；working set 已实现但实机显示未验收 |
| Linux | CI Rust/deb、实际 deb 解包布局、独立 D-Bus/Xvfb --desktop 生命周期 | 真实桌面/Agent/通知点击/退出唤醒、实际安装/卸载；generic freedesktop 通知服务明确报错且保留重试，activation 需 GNOME 或 host-app Registry portal（xdg-desktop-portal 1.20+）；RSS 实机显示未验收 |

`400f5ba` 生命周期退出方法是 terminate fixture process、通知暂停，不能代替上述真实桌面操作。各 CI 结果按报告绑定提交查阅。[macOS 发布流程](macos-release.md) 有可执行检查，缺 Developer ID 身份时正式分发未验收；debug 包不等于 release 性能或正式发行版。公证/外部发布仍需环境及授权。

## 容量与性能边界

| 当前预算 | 适用范围与限制行为 | 代码依据 |
|---|---|---|
| 16 个前台缓存视图 | 每个 GUI 的 TerminalViews；live 保留，满且无 ended 候选则拒绝再打开；非系统总会话/历史上限或分屏数量 | [App](../apps/desktop/src/App.tsx)、[TerminalViews](../apps/desktop/src/terminal-views.ts) |
| 32 MiB 历史元数据 | sessions.json 序列化/读取预算，非总磁盘预算；达到限制报错并保留已有文件/未读回执 | [HistoryStore](../apps/desktop/src-tauri/src/history.rs) |
| 100 / 200 摘要与收件箱页 | 默认100，最大200；摘要标题最多200 Unicode字符，不带完整prompt/command/argv、inbox或原生身份。分页改善传输/渲染，JSON全量保存成本保留 | 历史模块、App |
| 10000 entries / 深度4 / 2秒 | 私有sessions根与archive目录分类逻辑字节扫描；后台单在途，可取消；不跟随符号链接/Windows reparse point；协作式截止、I/O失败或省略标partial并给固定错误码 | 历史模块；扫描不持records锁 |
| 32 MiB 单归档分片 / 100槽 manifest页 | 一记录一私有分片；manifest页最多100槽且最多1 MiB，root/locator/txn各最多4 KiB；生命周期最多1,000,000槽（还原保留空槽，不压缩）；归档页每请求最多扫描100槽。禁止链接/损坏/超限读写；失败事务在同一owner后续访问前恢复，无法安全恢复时阻止hot写；main与可恢复bak成员一致后清txn。root缺失时最多检查4096条/协作式250ms，仅无索引的合法孤立分片允许首次初始化 | 历史模块 |
| 4 KiB policy / 128 KiB删除预览与txn / 64 KiB最新回执 | 单个预览最多20个去重ID、5分钟有效，绑定owner instance、hot/archive revision、文件存在性与身份、父目录身份；不接受前端路径或字节数。仅保存最新有界回执，同token已完成请求可幂等重试，不累计tombstone。仅log角色允许当前UID、无共享写位的旧0644格式；分片/场景/policy仍要求私有文件，所有目标拒绝硬链接/FIFO/链接/reparse。可选闲置归档每批最多5条/协作式2秒，无自动永久删除 | 历史模块、后台；Windows所有权实现未在本机原生验收 |
| 256来源 / 64 MiB 日志内容 / 最多4 MiB档案摘要 | 每次日志请求最多256来源槽、最多64 MiB保留输出；档案来源摘要最多4页×1 MiB及固定root，逐槽检查取消，不读取完整归档分片。累计output_end_offset用于原日志绝对位置，不作为8 MiB文件大小。单个显式详情/续聊/范围选择最多读取32 MiB档案记录；下一批由continuation继续，截断输出不能恢复 | 历史模块、原生日志管理、日志查询 |
| 8 MiB 单日志 | 每会话日志较早输出会截断；搜索/导出仅保留部分，非无限审计历史 | [会话日志](../apps/desktop/src-tauri/src/lib.rs)、[查询](../apps/desktop/src-tauri/src/session_logs.rs) |
| 2000 行投影滚动历史 | 每后台 xterm parser scrollback，当前屏幕另计；日志与投影分别有界，日志尾不能完整重建活跃 TUI | [终端服务](../apps/desktop/terminal-service.cjs) |
| 256 parser sessions / 4,000,000 cells | parser 同时实例与总 cols × (rows + 2000) 预算，create/resize 超限拒绝；独立于前台视图预算 | 终端服务 |
| 128 + 128 OpenCode events | 原生待执行回调、发送队列各 128；超限 unavailable，不猜测丢失轮次完成 | [OpenCode 插件](../apps/desktop/src-tauri/src/opencode-plugin.mjs) |
| 1 MiB 诊断 JSON | 白名单报告和诊断 RPC 响应有界；已断连时导出明确不可用状态，不发现/启动替代 owner；目的地必须支持硬链接，不回退覆盖写入 | [诊断](../apps/desktop/src-tauri/src/diagnostics.rs)、后台 RPC |
| 4096 会话 / 16384 回执 / 250 ms | 聚合只读已打开后台历史，锁忙明确不可用；计数超预算标 partial。存储仅扫描 sessions 顶层，最多 4096 条、协作式 250 ms 截止；不跟随符号链接/Windows reparse point，不递归。字节为文件逻辑大小，省略/失败/超限标 partial，非整个应用磁盘占用 | 诊断；parser present 仅表示已配置实例存在，`parser_health_probed=false`，没有探测进程健康 |

内存口径：macOS physical footprint、Linux RSS、Windows working set；应用逐进程相加包含共享记账，非系统去重占用，任务另列。没有严格同机/同负载 cmux 对照，不能证明没有泄漏。

[连续性测量](yam-memory-continuity.md) 的 `400f5ba` 生产实现：16 会话/2000 行/30 分钟 343 完整样本，中位 340.28 MiB、范围 323.12–592.43 MiB；独立重开短测中位 587.06 MiB。保留构建/尺寸/编译干扰和峰值，后续 live-memory/renderer 修改不自动继承结果。[已结束视图 WebKit 夹具](superpowers/plans/2026-10-02-renderer-memory.md) 约省 13 MiB、返回约 5 ms / 1003 ms，是机制证据，非整个 App/当前单会话降幅；旧 owner 缺 persisted 时保守保留视图。

T10当前工作区已提供终端字体/10–24整数字号/dark-light-solarized主题的显式保存与取消，损坏偏好回退提示；沿xterm options更新已有实例、fit并对已确认可写的live/ready view单飞合并最新尺寸，backend输入lease仍权威，偏好不自动take control。有限命令面板复用已有动作，普通输入/IME/dialog不抢键，终端焦点可唤起；B04a已用统一八项注册表替换旧P冲突优先策略；已知冲突拒绝保存，禁用palette热键仍保留按钮入口，参见B04a回执。最多100个本地pin仅导航排序，永久清理回执同步移除对应pin；关闭verified/persisted ended idle视图不删历史或停止任务。Run again/Continue文案与原动作分开。详情与宿主自动化范围见[T10证据](evidence/yam-terminal-settings-t10/README.md)；没有新native包或真实GUI/Windows/Linux验收，T08旧包不冒领T10。

## 已交付代码与待验收入口

当前宿主代码已提供 worktree 创建与启动保护、固定 2/4 pane 分屏、公开 CLI 与安全事件订阅；这些阶段的自动化验证不等于原生三平台产品验收，相关 native 项仍 pending。macOS worktree 可恢复 Trash 创建/清理成功及持久重开已有独立隔离原生跟进样本，其他场景/Windows/Linux仍未验收或未实现；跨项目共享模板和完整更新安装仍待交付或验收。系统托盘/全局唤起现已提供 owner 宿主接线，原生验收仍 pending。T15 已接入 App 的 ID-only 布局偏好与当前 owner 验证恢复，原生重开验收仍待执行；自定义命令不等于可分享 Adapter 配置。后续见 [优化方案](superpowers/plans/2026-10-03-yam-optimization-proposal.md)；正式开源许可由权利人决定，本任务未增加。

## 验证命令与证据口径

从仓库根运行，以下是复验入口，不表示本次文档任务执行了所有命令：

```sh
rtk pnpm --dir apps/desktop test:coverage
rtk pnpm --dir apps/desktop build
rtk cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
rtk cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
rtk cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=2
rtk python3 -m unittest discover -s scripts -p 'test_*.py'
rtk git diff --check
```

最新 renderer-memory 记录前端 88 项、Rust 165 项通过，两项原生 fixture 默认 ignored；工具模块 lines/functions 100%、branches 98.62%。优化方案基线另记录 Python 27 项及 build 通过。历史数字绑定执行记录，不是整个 React/Rust 覆盖率或每次文档修改的新测试结果。正式 Converge coverage provider / Review v3 runner 未配置，与实际可执行检查分开记录。

2026-10-03 T02 当前工作区：新增诊断测试先观察 Rust 6 项、前端 5 项行为断言红灯，再实现；最终 Rust 174 项通过、2 项原生 fixture ignored，前端 93 项通过、生产 build 通过。工具 TS 覆盖率 lines/functions 100%、branches 98.62%，不代表 App.tsx/Rust 整体覆盖率。诊断自动化覆盖正常/取消、不可写目的地、已有文件/符号链接、未知敏感字符串、大小/条数预算、锁忙、RPC 白名单和断连不替换 owner；原生保存对话框操作仍未实机验收。

2026-10-03 T03 当前工作区自动化：Rust190项通过、2项原有原生fixture ignored；前端106项通过、生产build、fmt、clippy与diff检查通过。工具TS覆盖率lines/functions100%、branches98.69%，history.ts三项均100%；不代表React或Rust整体覆盖率。首屏分页RPC、跨store/reopen游标隔离、最新查询上下文、精确热metadata大小、旧通知详情选择竞争、大别名游标和Agent标题fallback均有实际红灯后绿灯。TDD顺序例外：初版后端分页/统计/scanner核心先实现后补Rust测试，不能宣称整个T03严格先测试；后补正常/边界/异常自动化均通过。容量按文件逻辑大小展示；实际归档和还原未在T03实现。

T03独立复核发现的三项回归已在同一修复轮关闭：保留旧受认证、无参数`list_sessions`后台RPC供包生命周期/CI客户端读取，GUI仍使用分页摘要；失败通知重试入口依据热历史全局`failed_receipts`，第101项不受首100项收件箱页限制；关注跳转在查询发起时占位共享详情选择版本，旧返回/错误不能覆盖较新手动选择或关注跳转。三项先观察实际行为断言红灯，修复后上述冻结全量检查通过；未修改脚本、新增依赖或执行真实数据清理。

2026-10-03 T04当前工作区：测试-only阶段先观察Rust23项与前端7项断言红灯、Python新v2/旧v1边界红灯，再授权生产实现。归档/还原事务各具名故障点要求精确注入码；hot rename已生效而目录同步失败、立即损坏main后的bak恢复、还原恢复超限、私有权限/链接/损坏/分片超限、pending/failed且已读回执、实际原生claim与按ID场景/Unicode日志保留有回归。新增真实513来源（260档案+253热记录）走backend source batch；metadata回归先实际观察260次完整shard读取红灯，再改为manifest固定output_end_offset与原路径日志读取，要求完整shard读取0次。自动化不能替代上述三平台原生联合验收；正式Converge coverage provider仍未配置。

T04最终当前源码检查：Rust214项通过、2项原有原生fixture ignored；前端113项通过，工具TS lines/functions100%、branches98.69%；Python29项通过；生产build、fmt、clippy与diff检查通过。生产bundle仍有既有大chunk提示。归档/还原/连续日志搜索的实际桌面与三平台权限/事务原生操作仍未验收，上述为宿主自动化证据。

T04独立初审修复轮：先观察同owner恢复/缺失root的Rust语义红灯（7项中6失败）和热行/归档行自定义名的实际JSX断言红灯（3项失败），再修复。统一records guard在持锁状态重放事务；未发布txn或txn已删除时重载durable hot成员，恢复变更使热分页与日志来源游标失效。生命周期更新、通知确认和Agent写入复用该guard；不依赖重开GUI，完整记录、唯一成员与bak防复活断言保留。root丢失且已有manifest/index时拒绝归档并保持原文件；正常首次归档成功。归档UI复用App现有titleFor，保留Unicode自定义名。诊断pending状态另先观察available断言红灯，再返回既有unavailable/state_busy及partial计数，保持只读且不恢复事务。

修复轮最终当前源码：Rust222项通过、2项原有原生fixture ignored；T04定向31项及新增审查7项通过；前端116项通过，工具TS lines/functions100%、branches98.69%；Python29项通过；生产build、fmt、clippy与diff检查通过。新增发布失败钩子仅cfg(test)，在pending置位后让真实写入遇到目录阻碍；该扩充场景现有恢复协调直接通过，不作为新红灯宣称。原生桌面/三平台联合验收仍未完成；正式Converge provider未配置，以上自动化不冒充原生或正式覆盖闸门。

2026-10-03 T05当前工作区：tests-only阶段Rust可编译，新增行为25项实际断言失败、1项既有idle边界通过；前端12项实际AssertionError红灯后授权实现。最终T05定向Rust31项、前端13项通过；全量Rust253项通过、2项原有原生fixture ignored，前端129项通过，工具TS lines/functions100%、branches98.69%，Python29项通过；生产build、fmt、clippy与diff检查通过，保留既有大chunk提示。测试覆盖取消/冻结集合/过期与重启、claim与通知拒绝、全集合preflight、父目录替换、硬链接/FIFO/权限、发布/移动/manifest/bak/删除/回执/txn移除阶段故障的同owner及重启恢复、备份不复活、实际JSX操作和旧响应/重复确认/精准缓存清理。合法保存场景persisted=false、累计offset大于保留日志尾、旧OpenOptions日志0644均先观察语义红灯再修复；0644预览不chmod，0664明确拒绝。以上为宿主自动化，不代表React/Rust全量覆盖、真实用户清理、三平台原生桌面或正式Converge coverage/Review v3验收；T03既有TDD顺序例外保持前文记录。

T05独立初审修复轮：先观察7项实际前端函数/JSX语义红灯，另观察跨关闭/卸载/共享App刷新的前端红灯与可编译Rust回执字段红灯，再授权生产修复。确认操作的partial或丢响应保留原token，列表恢复后最多查询一次同token，最终actual IDs才收口；Close可用，关闭及初始App刷新消费既有最新有界实际回执，读取不启动未经确认的删除，同token/IDs重复刷新不取消较新选择。overview严格验证64 KiB内、最多20个合法去重ID及合法token，不透传未知字段或私有内容；非法回执测试先红后绿。删除/还原成功仅移除对应勾选ID，partial保留未完成及无关选择，20条选择容量释放；策略load/save与卸载共用版本，旧false/错误不覆盖较新成功。实际JSON保存的lastSession匹配与实际App关闭回调缺失刷新也先观察AssertionError，再修复并验证原生确认/取消调用不混用。修复轮最终全量Rust255项通过、2项原有原生fixture ignored，前端138项通过（T05定向22项），工具TS lines/functions100%、branches98.69%，Python29项通过；生产build、fmt、clippy与diff检查通过，保留既有大chunk提示。没有新增依赖或清理用户真实数据，三平台原生验收与正式provider缺口保持前述边界。

2026-10-03 T08收尾：新增安全tests-only红灯经根独立重现（23项13fail/3error），最小runner修复后23项全部通过，再经前置只读复核执行单次当前冻结包owner RPC验收。最终顺序全量Python80项、前端138项通过；工具TS lines/functions100%、branches98.69%；frontend build和diff检查通过，保留既有大chunk提示。仅测量runner/tests与文档变更，产品Rust未改；T06已执行fmt/clippy回执继续引用，不冒充T08重跑。证据包/source/runner/receipt SHA与原始argv、无token PID/instance回执、JSON/链接/index核验见[T08证据](evidence/yam-native-t08/README.md)，正式Converge coverage provider仍未配置。


T09工作区交付：首次preview和trust均不自动执行，应用默认独立保存且项目derive表单不写global；owner与App实际路径测试的证据范围见[T09](evidence/yam-project-config-t09/README.md)。本轮改变产品源码，不把T08旧冻结包纯RPC验收或10月1–2旧GUI样本冒领为新项目配置原生通过。新配置错误入口通过None AppHandle单一分配边界探针验证同owner函数内顺序，不代表真实PTY/GUI验收；changed/env/cwd/CLI错误扩充在已修guard直接通过，保留此前实际red，不伪造新red。正式Converge coverage provider仍未配置。

T09最终冻结源码自动化：Rust275项通过、2项原有原生fixture ignored（T09定向20项）；前端150项通过（项目配置12项），工具TS lines/functions100%、branches96.79%，project-config.ts branches81.08%；Python80项通过；生产frontend build、fmt、clippy、diff均exit0，保留既有大chunk提示。删除/移走已信任源的显式项目请求拒绝而非静默global回退；普通manual无项目请求仍兼容。上述是宿主自动化与实际App函数/JSX路径证据，不代表真实GUI、PTY、Agent CLI/Hook、Windows/Linux或正式覆盖闸门验收。

T09首次只读审查修复：实际App回调先观察7项语义红灯（2父测试+5子测试），修复read/approve/cancel/cwd/unmount共享generation，迟到success/error/finally均不得写新UI。随后实际Node157项通过，工具TS lines/functions100%、branches97.08%，project-config.ts83.78%；frontend build与diff重跑通过。Rust/Python/脚本源未变，引用同SHA先前真实Rust275/2ignored、Python80及fmt/clippy，不冒充重跑。第一轮冻结回执和旧green保留在T09 first-candidate，原生与正式provider边界不变。

T10最终宿主检查：Rust275项通过、2项原有native fixture ignored（64.39s，同T09 native源码SHA；最后前端selector/test修改后引用此同源结果，不冒称再次Rust运行）；最终前端181项通过（两T10模块/实际App23项及新firstAttachment1项），工具TS lines/functions100%、branches97.46%，terminal-settings三项100%、command-palette branches97.62%；Python80项通过，frontend build、fmt、clippy、diff exit0。保留既有大chunk提示和先前抽取fixture失败日志；正式provider和真实GUI/Windows/Linux/CLI/Hook/权限缺口保持上述边界。


T12 adds active-project read-only Git context through the existing authenticated owner RPC: branch/detached/unborn, canonical worktree/common directory and dirty state. The App keeps one flight through cancellation and five-second intervals, with old project/owner/unmount replies rejected; a nonblocking owner-wide guard also excludes other clients. Git queries share a two-second subprocess deadline and cumulative 1 MiB output/metadata budget. Effective external clean/process filters and steering environment are refused; private fixed-config shadow status never loads original drivers/hooks. Known unsupported attributes/conversions, changed metadata, busy/timeout/overflow and indeterminate gitlink state are unavailable, never clean. Effective attribute rules for at most 4096 tracked paths are compared original versus shadow; mismatch and partial-clone/promisor config fail closed. Native GUI/Windows/Linux remain unverified; no T13 worktree management is implied. See [T12 evidence](evidence/yam-git-context-t12/README.md).

T12 final host checks: Rust302 passed/2 ignored (74.07s), frontend190 passed, tool TS lines/functions100% and branches96.10% (`git-context.ts` branches85.19%), Python80 passed; frontend build/fmt/clippy/diff exit0. Node/Python/build unchanged-source results are referenced after the final Rust-only fixes, not described as reruns. Relative installed Git resolution and post-spawn setup cleanup each had a real semantic red before the minimal fix; raw prior runs remain in T12 evidence. Actual App effects use mocked IPC/timers; no real GUI, Windows Job API, Linux native operation or official coverage-provider gate is accepted by these checks.

T12 formal review correction: earlier302Rust/190Node/80Python green did not cover ignored-only untracked files or a gitlink outside a selected subdirectory. New six-case semantic red and existing two-thread fixture conflict were reproduced before fixing bounded common info/exclude snapshots, explicit nonempty configured-excludes unavailability, canonical-root metadata and cfg(test)-only test serialization. Final33T12 cases passed under two threads; production single-flight/busy behavior is unchanged. First-candidate receipts and failures remain in T12 evidence; updated full Rust checks are recorded separately.

T12 second frozen candidate: actual full Rust 308 passed/2 ignored68.60s; fmt/clippy3.15s/diff exit0. Same-source frontend190/Python80/build receipts are referenced without claiming reruns.33T12 cases passed with actual CI two-thread strategy; real GUI/Windows Job/Linux and official provider remain unverified.

T13 creation candidate adds explicit preview → create files only → separate first-session launch through authenticated owner RPC. Default branch and actual first SessionSummary ID share a durable reservation. First claim verifies fixed commit/branch/registry and physical identity; consumed worktrees allow legitimate later commits and new ordinary session IDs. Fixed-config checkout isolates executable Git configuration, rejects effective clean/smudge/process drivers and differing/unsupported attributes/conversions, and retains incomplete creating/failed residue. Ordinary/Resume lifecycle checks include descendants and parent aliases; old project/owner/component callbacks cannot launch or overwrite newer UI.

Historical T13 creation-stage result: **actual cleanup success remained pending**, not completed by `worktree_cleanup_unavailable` or a disabled control. The confirmed final-remove filter execution gap is documented in [T13 evidence](evidence/yam-worktree-t13/README.md); no original remove/force/rmtree/prune fallback is used. Independent directory/ID fixtures are not native two-Agent/PTY, GUI, Windows/Linux, Hook or permission acceptance. T06/T08 frozen native-package evidence does not cover this newer source.

T13 frozen creation-candidate host checks: Rust340passed/2ignored81.39s, frontend201passed, Python80passed; build/fmt/clippy/diff exit0. Tool TS lines/functions100%, aggregate branches94.79%, worktree-controls.ts branches82% (no React/Rust coverage claim). After two Rust-only lint fixes, Rust/fmt/clippy/diff were rerun; actual unchanged-source Node/Python/build receipts are referenced. Root independently32T13 two-thread cases/11Nodepassed with9SHA matched; Astra independently9owner/11Nodepassed and closed the symlink-away P2, finding no remaining P0/P1/P2 in creation scope. Actual cleanup success, native GUI/PTY/two-Agent/Windows/Linux/permissions and official provider gates remain pending.


T14 fixed-pane candidate adds Single/Side by side/Stacked/Four panes with unique session membership, independent visible frame/viewport/size paths, actual DOM/window focus input and notification suppression, and hide-only close/collapse. Visible ended views are protected in admission and eviction; pending Start reserves capacity without premature disposal. Existing raw live protocol routing, cold replay protection, first attachment and backend-authoritative input leases remain. Layout changes do not create/stop/take control or broadcast input. T15 App-integrated ID-only restore is now source-verified as described below; native reopen remains pending.

T14 first frozen candidate passed 231 frontend tests but formal review found two P2s: hidden raw replay completion lost readiness, and Start admission ignored protected ended scenes. Actual callback regressions reproduced both before the minimal fixes; first-candidate receipts and raw failures are preserved. Second-candidate historical author checks: 235 frontend tests passed, tool TS lines/functions100%, aggregate branches94.66% (`terminal-layout.ts`91.67%, `terminal-views.ts`98.08%); targeted four-file97 passed; frontend build/fmt/clippy/diff exit0. Python80 and Rust340/2ignored are referenced from actual unchanged-source runs, not claimed as reruns. See [T14 evidence](evidence/yam-layout-t14/README.md).

T14 host automation includes actual App callbacks/component structure, mocked IPC and 120 logical output ticks for two and four panes. Native GUI four-pane continuous output, keyboard/paste/resize/paint and Windows/Linux remain pending. Inline pane host-reference churn is a deferred nonblocking P3 model finding, not measured native latency or an optimization result. Formal coverage provider remains unconfigured; T14 is not native-acceptance complete.


T14 third candidate corrects the second-review notification-context P2: concurrent old A requests could overwrite actual B focus at the owner. Three actual callback regressions failed before adding a single-flight/latest-only frontend queue; focus/paused snapshots coalesce, old reject proceeds to latest, and unmount drops queued requests. This is source/callback modeled arrival evidence, not a native IPC timing measurement. Third-candidate historical Node238 passed (four-file targeted100), build/diff exit0; tool TS lines/functions100%, branches94.66%. Backend/script inputs unchanged, so actual earlier fmt/clippy/Python80 and T13 Rust340/2ignored receipts are referenced without claiming reruns. Third-candidate review confirmed an initialization P2: the pre-mount preference effect was dropped and terminal mount did not resend persisted pause. A complete actual-effect ordering regression failed before adding the single mount-time sync. Fourth-candidate fresh Node239 passed (four-file targeted101), build/diff exit0; tool TS coverage percentages and same-source references remain unchanged. Root independently101/101 and Astra independently101/101 plus original initialization1/1 passed, twelve source hashes matched, and final finite review found no remaining P0/P1/P2. All three prior P2s and queue-introduced initialization P2 are closed. Native acceptance and deferred P3 limits remain unchanged.


T14 final scope audit correction: root found four early `tsc -b` generated, untracked nonowned files absent at start; the original scope failure and first seal remain in evidence. Root backed up exact bytes and removed only those four files, then canonical pnpm frontend build passed exit0/1.398s with all twelve source hashes unchanged and generated files absent. Documentation/evidence were explicitly reopened once to record this cleanup and reseal; no business/test/config/ignore change or native acceptance claim was made.


T15 partial_scope=pure preference validation only: independent version1 ID-only finite schema, strict mode/slot/selected validation, raw4096 JS-code-unit preparse bound and64-character ASCII session-ID bound, corrupt/unavailable fallback and fixed storage warnings are implemented without App integration. New13pure tests and33existing views passed; final wholeNode252passed, standard build/diff exit0. Module lines/branches/functions100%, aggregate tool TS branches95.08%. Actual semantic scaffold red and sparse-slot red remain; initial TS2550 build failure was fixed with the existing ES-compatible own-property pattern, not compiler settings. That pure-stage snapshot did not integrate the App. The user subsequently approved current-owner validation of ID-only hints; the source integration below supersedes the earlier pending App/decision status while keeping native acceptance pending.


T16 finite CLI candidate adds same-executable non-UI status/list/show/start/focus/stop with literal parsing, bounded UTF-8 prompt input, caller-canonical project paths, authenticated metadata whitelist and fixed error classes. Default commands connect only to an existing owner; only explicit Start --start-owner can spawn one with an independent Unix process group. Native discovery uses existing OS APIs without AppBuilder/GUI and refuses unsupported directory overrides. An owner-lifetime public CLI namespace binds64-hex request keys: same key/arguments deduplicate across fresh clients, different arguments and receipt-budget overflow refuse, and replacement/lost replies never silently resend Start. Focus queues to the existing desktop-local selection bridge and does not launch a GUI.

T16 author frozen host checks: Rust378passed/2ignored, frontend252passed, Python80passed; standard build/fmt/clippy/diff exit0, targeted38passed. Utility TS coverage100%lines/functions95.08%branches does not cover React/Rust. Real debug invalid UTF-8/unknown entry checks returned2 without GUI/owner; this is not packaged acceptance. Root and Astra independently38/38passed with four frozen hashes matching; final finite review has no confirmed remaining P0/P1/P2. First concurrent-cargo review failures were fixture root collisions, corrected only by seven cfg(test) PID prefixes. Two author concurrent processes each38/38passed, then Rust378/2ignored/fmt/clippy/diff were freshly rerun exit0; frontend252/Python80/build are actual same-input references, not reruns. Native macOS/Windows/Linux packaged stdout, real Agent/GUI focus/notification/Hook acceptance remain pending, and formal provider gates are unconfigured. See [CLI documentation](yam-cli.md) and [T16 evidence](evidence/yam-cli-t16/README.md).


T17 event candidate adds same-executable read-only JSON-lines observations through the existing authenticated private IPC, without App/lib/agent_bridge/dependency changes. Actual owner listener preserves GUI agent-state payload and appends a separate hot-history safe snapshot containing fixed phase/integration/revision/aggregate receipt counts. Original relay sequences survive filtering; pages scan at most128slots with256KiB safe JSON and272KiB client wire cap/3s response deadline. Overflow explicitly requires a snapshot; no exact commit replay is claimed. Private strict1KiB versioned cursors checkpoint only after output flush; interruption can repeat an uncheckpointed page, so consumers deduplicate. Same-client retries are finite and replacement stops without new-owner connection/start.

T17 targeted author21tests passed (one is the test-child entry fixture), and Root independently21passed with two frozen source hashes matching. The actual shared stream-body Unix SIGINT test used only an owned harmless child and mock transport; slow/error writer and readonly owner-body tests are host automation, not native GUI/Agent/platform acceptance. First review found two P2s despite21targeted passing: contended hot-history locks silently dropped the final observation and four real AgentState phases became unknown. Actual3regressions failed before a CLI-only unavailable-gap marker and shared finite phase whitelist; GUI payload/globalrelay lost behavior remains unchanged. Final author24tests passed (one fixture), fresh affected Rust402/2ignored/fmt/clippy/diff passed; Node252/Python80/build are actual same-input references, not reruns. Root and Astra independently24/24passed, both source hashes matched and finite review found no remaining confirmed P0/P1/P2. Official provider gates remain unconfigured. See [event evidence](evidence/yam-events-t17/README.md).

## T20SDK — 历史 Rust dependency provisioning stage

该 SDK-only 历史阶段用户批准 Rust updater SDK。desktop cfg 声明 `tauri-plugin-updater = "2"`，Cargo 一次解析锁定 2.13.1；该阶段未添加 JavaScript SDK、plugin registration、权限、公钥、endpoint、网络更新检查或安装。该部分不等于完整 T20 自动更新，当时也未改变既有启动/owner 业务源码；后续 GUI source slice 见下文，feed、密钥归属、分发格式、服务/签名/发布及三平台原生安装验收仍 pending。作者实际配置5/5、host Rust402pass/2ignored、Python85pass、fmt/locked clippy/diff均0；Root/Astra各自独立5/5且3source SHA稳定，Astra locked offline图检查0、无剩余confirmed P0/P1/P2。新增35包均为SDK依赖闭包，0删除、10现有包仅依赖条目变化，既有版本/checksum不变。官方provider gates未执行。准确自动化与独立复核事实见 [SDK 文档](yam-updater.md) 和 [SDK-only 证据](evidence/yam-updater-sdk-t20/README.md)。

## T18Hardening — 配置与元数据部分交付

当前配置生产CSP为strict script self/localIPC，无script inline/eval或远端wildcard；生产style-only inline为已有xterm无nonce动态style，独立默认localhost开发CSP的script inline仅为ReactRefresh preamble，HMR固定1420/1421。TAURI_DEV_HOST需开发者明确Tauri config覆盖，不改Vite或放宽生产策略；默认/custom-host原生开发启动未执行。main capability仅event listen/unlisten与dialog open，不将移除unused broad defaults声称为已复现漏洞；Rust/plugin/deeplink业务不变。Cargo authors为Jeff.Liu、具体YAMdescription，version/license决定/SDK2.13.1 lock/deps/features不变。

作者计划8checks全部实际0：配置8/8、Rust402pass/2ignored、Node252pass、Python93pass、standard build/fmt/locked clippy/diff；utility TS覆盖100%lines/functions95.08%branches不等于React/native覆盖。实际WebKit/CSP阻断/terminal字体style/IPC/dialog/listener/OS协议、原生三平台sign/install/notice完整性/权利人license及完整release仍pending，未操作GUI/userowner/Agent/T06资产或发布。详情见 [配置文档](yam-release-hardening.md) 与 [本阶段证据](evidence/yam-release-hardening-t18/README.md)。

## T16Phase — CLI Agent phase 投影修复

后续源码复核确认CLI list/show仅保留idle/working/waiting，丢失真实AgentState的response_finished/needs_permission/needs_attention/interrupted/failed，而event snapshot已保留。五个独立具名实际apply→list/show/snapshot回归逐一红灯；最小修复移动既有十值Agent白名单，供metadata与snapshot producer/projector共用。任意文本仍unknown、固定DTO字段/records revision/非空lease与focus保持，另一session-phase protocol域不拓宽，无新命令或重放语义。

作者实际target7/7、既有T17_24/24、full lockedRust409pass/2ignored/fmt/locked clippy/diff全0；Node252/Python93/build仅引用此前T18实际记录，未当前重跑。未改Cargo/lock/config/CSP/frontend/SDK注册或历史冻结证据；real Agent/packaged CLI/GUI/三平台/官方provider gate仍未执行。准确独立复核及源码冻结见 [phase修复证据](evidence/yam-cli-phase-t16/README.md)。

## T19SourceFlow — 发布错误输出部分修复

macOS release CLI对main捕获的operation异常不再格式化原始异常，改为固定timeout/subprocess/tool-or-file/validation rejection分类，argparse诊断保持原样；不回显命令、identity/profile、路径或工具输出，deliver/check/parser/退出码/成功文本保持。四个独立main异常fixture用人工非秘密command/path/动态message sentinel真实红灯后修复，captured stdout/stderr此前未直接回显，对应断言是保持约束而非复现stream泄漏；target10/10绿；check exact4commands在原源码directgreen，不冒充新红灯或原生验收。全host fixture wrapper实际97run/96pass/1skip，唯一跳过test_terminal_runtime.RuntimeTests.test_native_builder_preserves_unicode_with_legacy_default_encoding（会真实runtime build/codesign），其余执行；不能称unfiltered全Python或native release通过。真实证书/profile/Apple服务/production stapling/Gatekeeper/WinLinux签名包安装仍blocked/excluded，未签名/上传/发布/选择平台，也未改SDK/config/GUI/owner/Agent/T06或旧封存证据。准确源码与独立审查见 [sourceflow证据](evidence/yam-release-sourceflow-t19/README.md)。

## T18FrontendNotices — 五个直接前端包文本部分补齐

现有notice source assembler追加react19.3.0/react-dom19.3.0/lucide-react0.468.0/@xterm/xterm6.0.0/@xterm/addon-fit0.11.0各自package-owned LICENSE与独立版本标题，固定版本已核pnpm lock及installed metadata。严格name/version/nonempty stringlicense与regular非空UTF8正文，byte读写保留CRLF/空白；Node/headless/serializer来源保持，无parser/framework/dependency或项目license选择。actual main自有temp/mocked fixtures先观察normal缺heading与13badcase noerror语义红，修后normal1method与bad1method13subcases全绿；filteredhost99run98pass1明确native runtime build/codesign skip、diff0。未运行真实builder/Node/SEA/network/codesign/target/T06，不能称原生package可见性或fullnotice通过；Tauri JS/API/plugins、Cargo/Rust/transitive/fullbundle inventory仍未解决，项目许可/完整release/install验收pending。确切source/provenance/独立审查见 [前端notice部分证据](evidence/yam-frontend-notices-t18/README.md)。


### T15 App restore source integration

Author: Jeff.Liu. Current-owner-validated ID-only hints now reach the actual App startup and persistence effects. Every saved ID must match `get_session` before any attachment; one invalid/rejected/deleted ID resets the entire layout to a single empty pane with a fixed warning. Valid empty layouts and selected-empty slots retain intent. Initial pending notifications bypass saved restore; later notification/user/owner/unmount boundaries cancel stale success, failure, parser/RAF and finalization paths. Existing cold views never acquire input control automatically. Newer user intent during frame wait uses the shared latest-visible cold handoff so retained panes can become ready without input takeover.

Final host checks: new App regression50/50, affected layout/codec/view/notification98/98, whole Node302/302 with aggregate TS line/branch/function100%/95.09%/100%, standard frontend build and diff check all exit0. The configured coverage measures `src/*.ts`, not React/native GUI coverage. Formal provider preflight remains uncovered; no threshold or configuration was relaxed. Rust/backend/CLI/dependencies are unchanged and were not rerun. Root/Astra independent source review passes the same final freeze; each independently runs50/98 tests, and additional reproduction/assertion audits pass. These are source reviews, not official provider acceptance. Native packaged reopen/keyboard/window and OS acceptance remain pending. [Evidence](evidence/yam-layout-restore-t15/README.md).

### F2 Adjustable split and pane swaps

Author: Jeff.Liu. Side-by-side and stacked panes use an accessible 20–80% divider with pointer drag, keyboard adjustment and reset to 50%; cancelling a drag restores committed geometry, and discrete keyboard/reset input cancels the active drag first. The four-pane grid remains fixed and exposes focused-to-target pane swaps. Focus follows the same session identity, while selected session and existing control state remain unchanged. Invalid/same targets and swaps during restore, session creation, owner unavailability or an unsettled visible populated pane are refused. Layout changes never create/stop tasks or take input control. Saved split ratio is version2 data; version1 layouts migrate to 50%, with existing current-owner all-ID verification and whole-layout fallback retained.

Final author checks passed: focused polarity regression1 expected RED then3/3 GREEN; affected four-suite Node155/155; full Node coverage392/392 (100% lines, 92.56% branches, 98.99% functions); desktop build and diff check exit0. Astra's independent focused run passed8/8, its actual JSX/guard/component probe covered horizontal, vertical and grid availability boundaries, and R2 source review passed. R1 review findings around discrete drag cancellation and grid swaps and R2 finding around disabled polarity are closed; original R1 focused failure/green tool output was not persisted to raw files, so the history boundary is recorded in the evidence index. These are source and mocked-IPC checks only: no native GUI/package reopen, F7, or formal provider coverage is claimed. See [F2 evidence](evidence/yam-functional-f2/README.md).

T15 App repair round1 preserves the failed first candidate: independent source review found that cancelling boot attachment left retained panes permanently unready and unrelated historical deletion receipts cancelled startup verification. After all IDs validate, at most four attachments begin synchronously; shared cancellation coalesces the latest visible read-only handoff. Passive unrelated deletion does not cancel; a deleted saved ID invalidates the whole hint with one fixed warning. Seven new actual callback assertions failed before the shared fix. Round1 independent source review exposed residual selection fences: internal attachments and passive unrelated receipts must not advance a user detail request. Round2 reproduces those two failures plus six stale user-history success/error cases, separates internal/passive mutation, and binds user queries to the current intent generation. Final Root/Astra independent source review passes with no remaining scoped finding; native reopen remains unverified.

T11 当前宿主交付：独占 ready owner 的托盘初始化、有限菜单/数字计数、固定零参数 Open 单实例 fallback、显式 Stop all 直接 cleanup、默认关闭并显式启用的 Rust global shortcut，以及普通窗口设置/错误回退。通知 pause 以当前 owner/revision CAS 为权威，首次 legacy seed 和 GUI selection 请求在 heartbeat 前的迁移 fence、Bridge/lifecycle 同步、旧响应失效均自动验证；focus selection 不覆盖托盘选择。锁定 tauri-plugin-global-shortcut 2.4.0 与 tray-icon，未引入 JS SDK。详情见 [系统入口](yam-system-entry.md) 与 [T11 证据](evidence/yam-system-entry-t11/README.md)。本轮只执行 host fixtures、mock OS/IPC 和实际 App 源回调；真实 native tray/shortcut/GUI/三平台/权限验收未执行，formal provider coverage 仍 uncovered。

T11 宿主最终作者检查：Rust428通过/2ignored（T11定向19），前端Node315通过，TS aggregate branches94.14%（system-entry.ts75.76%，不把提取App闭包当React/native覆盖）；Python99run/98通过/1明确排除既有native runtime-builder/codesign测试。标准frontend build/fmt/clippy/diff均实际exit0；首clippy lint失败与修复后5项Rust检查原始记录保留。独立源码复审发现延迟refresh覆盖较新已接受pause revision，两真实回归先RED后最小同owner最高revision合并；第二候选fresh Node/build/diff，Rust/filtered Python为相同输入实际通过记录，不冒称重跑。Root独立74 Node与原refresh probe通过；Astra独立19 Rust/74 Node/1实际App probe通过，13源码SHA一致且无剩余范围内阻断。以上为独立源码复审，不是正式provider/native gate；native/provider边界不变。


## T13 macOS recoverable cleanup source slice

Author: Jeff.Liu. 当前 WorktreeControls 与受认证 owner 已接入显式预览/确认移到系统 Trash；清洁证书包含 ignored/untracked、nested/gitlink、有效 filter/隐藏 index flags 拒绝、当前 HEAD 与实际 finishing/live 会话守卫。原目录完整移动到私有同卷 Q，只有原路径仍缺失时执行 ordinary non-force Git registration remove；Foundation 返回位置和对象身份验证、持久 Trashed 后才显示完成，分支/提交不删。nonfinal 仅保留明确人工恢复信息、不重试 Trash/回滚/修注册；untouched Prepared 只对账 journal 回 Created 并失效旧 token。原创建阶段冻结证据不改写。

当前宿主定向 T13 49 项、实际 WorktreeControls/flow 18 项通过；所有清理 tests 使用自有 temporary Git 与注入 native seam，不调用真实系统 Trash。本候选7项实际exit0：lockedRust445通过/2ignored、Node322通过、标准build/fmt/lockedclippy/diff；TS aggregate branches93.22%、worktree-controls80.65%，不等于React/native覆盖。完整检查与独立源码复审结果见 [清理证据](evidence/yam-worktree-cleanup-t13/README.md)，Root/Astra同7源冻结独立源码复审通过，无剩余范围内finding；Root18Node、Astra18Rust/18Node及4case精确reconcile probe分别独立通过，不冒称双方重跑全量或official provider/native验收。该宿主清理 slice 未执行实际 macOS Trash/GUI/权限、Windows/Linux 与 formal provider gates；后续独立 macOS Trash/持久重开成功记录见当前原生跟进段。其他 OS 清理入口固定 unsupported。现有 T12 普通查询与 T13 创建/SessionID/Resume 语义保持。


## T20 GUI updater source slice

Author: Jeff.Liu. 当前普通窗口已接入 Updates，GUI-only严格配置门禁、单一SDK worker、有限check/download/cancel/自动检查boolean偏好、HTTPS-only redirect与15s/120s acceptance/cancellation期限。当前无updater配置，正常unconfigured且零plugin注册/extension lookup/network。SDK仅真实download Ok后的签名/版本验证边界可发布verified；256MiB为observed accepted-byte限制，非硬内存/网络上限。超时/取消/退出fence后等待exact join，cancelling期间不接新worker；install始终拒绝，包括直接伪造调用。未修改Cargo/lock/config/CSP/ACL/owner，未加JS SDK或部署假feed/key。

宿主测试覆盖actual配置/controller/GUI退出共享body与实际App startup/StrictMode/optout/关闭/迟到回包、DTO/private preference/component；注入SDK成功只证明边界映射，不是实际crypto/network通过。作者8项新鲜检查均0：Rust17定向/468通过2ignored、Node16定向/338全量、标准build/fmt/lockedclippy/diff；TS aggregate100%lines/92.23%branches/98.97%functions，updater.ts100%/84.44%/91.30%，不等于React/Rust/native覆盖。首候选独立源码复核发现设置关闭/重开时旧status在途导致idle无重试；R1实际回归先RED后增加有界500ms重试，保持单一RPC与旧回包失效。当前R1六源冻结经Root/Astra独立源码复核通过，无剩余范围内P0–P2；实际App/controller回归和连续5个重试周期证实最多一个500ms timer，fresh idle后停止，详见 [当前证据](evidence/yam-updater-t20/README.md)。供给配置、服务/密钥/签名/发布、三平台原生SDK请求/签名与安装兼容/备份/owner协调仍pending；formal provider preflight coverage uncovered，不宣称正式gate完成。

当前macOS跟进验收已在独立隔离noTask包验证T11首次缺失preferences默认关闭无warning，以及T13真实Trash返回/重开持久结果；详情见 [原生跟进证据](evidence/yam-native-current-followup/README.md)。这不补齐global快捷键callback、真实Agent任务、populated layout restore或三平台验收；历史T11/T13宿主快照保持原样。


### T18 full notice source pipeline

Source code now binds the complete 535 Cargo/13 production npm inventory and independent accepted body qualifications, renders cache-free original bytes, and enforces an explicit formal-release gate before runtime/SEA and native release tools. Qualified material covers 39 Cargo/9 npm; 500 explicit gaps remain (27 known Cargo, 469 unreviewed archive candidates, 2 npm declaration-only, 2 headless/serializer applicability). Node aggregate LICENSE is additional. Developer output is incomplete and never release-eligible. This does not complete project license choice, compatibility review, full-text gap resolution, native packaged notices, signing, or publication. Details: [notice integrity](THIRD_PARTY_NOTICES.md).

Material batch01 passed independent Root and Astra source reviews; the subsequent addon-search 0.16.0 exact source and full 548-identity candidate received independent mechanical review and root approval. The R2 mechanism remains: a fixed, independently approved canonical manifest digest binds all 548 identities, supplemental bodies, declarations, provenance, gap classifications and additional Node material. Collection produces candidates without granting readiness and rejects unapproved candidates before accepted return/publication; the public approval check, both render modes and packaged validation reject mapping changes before validator body reads. Future material changes require separate review and approval-anchor updates; no flag or environment bypass is provided.

[Material batch01 evidence](evidence/yam-full-notices-t18/material-batch01/README.md) preserves 15 exact-source qualifications, the Android Apache-text gap, retained atomic-waker third-party text, actual RED/GREEN and five fresh checks. Current coverage is 48 identities (39 Cargo and 9 npm), with 500 gaps: 31 known and 469 awaiting classification. Node aggregate attribution is additional. Developer output is deterministic at 4,774,510 bytes and remains non-release-eligible. [Historical R2 evidence](evidence/yam-full-notices-t18/r2/README.md) retains the preceding 32/515 state; older R1/R2 files remain unchanged. The collector/render/release-gate source slice is complete; full notice material, legal, native signed release and formal provider acceptance remain incomplete.

## 2026-10-04 功能优化优先级

本轮按[功能计划](superpowers/plans/2026-10-04-yam-functional-improvements.md)逐步执行F1–F7。自动更新后续开发与发行验收暂停，待版本稳定恢复；已有代码和历史证据保留。Agent原生续聊能力差异仅后续协议研究，不作为本轮产品缺陷。各项实现与测试结果单独记录，计划不代表已实现。

## F1：显式恢复体验（源码交付）

普通关闭窗口保留既有后台行为；后台连接不可用、终端/parser 不可用与生命周期 `needs_attention` 分开呈现，不凭查看或静态健康检查判定进程死亡。owner 恢复旧 running/starting 历史时，新 reason 明确旧 terminal 不能重新接回；旧记录不迁移，旧 `application closed` 文案只在相应生命周期场景兼容显示。

Continue 仅对当前选中的已结束 Codex/Claude 记录提供结构性候选，仍由现有 owner 校验来源与会话身份后显式启动新进程；Run again 明确新任务。无自动重跑、Take control、输入租约接管。OpenCode 原生续聊差异保留后续研究。断连 epoch、raw parser 完成次序、启动协议授权及低频 React 呈现刷新已覆盖实际 App 回调。

[证据与边界](evidence/yam-functional-f1/README.md)：作者定向 Node 122/122、全量 Node 368/368、静默串行 locked Rust 469 passed/2 个既有 ignored；标准 build/fmt/clippy/diff 全部实际通过。Root/Astra 独立源码复审通过，不代表 formal provider gate；native GUI/owner/Agent 续聊未执行、formal coverage 仍 uncovered。自动更新后续和许可 batch02 继续暂停。


## F3：只读 Git 修改查看（源码交付）

当前项目目录提供显式 Git changes 入口，区分 staged/worktree，untracked 仅显示文件名；选择已跟踪文件读取单文件比较。二进制、不支持的转换及子模块不确定性明确呈现，不伪装完整结果。固定 Git 参数复用私有 shadow、总2秒 deadline/1MiB 输出读取预算；最多4096行/4096 UTF-8字节路径/256KiB patch/1MiB最终DTO。此为接受输出限制，非硬内存上限。认证 owner/client/query 取消不等待会话业务锁；短轮询片不承诺 worker 饱和下端到端10ms。busy提供显式Retry，不自动无界重试；不写 Git、创建任务或接管输入。

目录/owner/选择/关闭/unmount 废弃旧回包，render 阶段即隐藏旧状态和操作；单一在途完成后仅处理最新 pending 请求。三个独审 finding 已关闭：render-time scope、最终请求路径替换后的 DTO cap、合法大型清单被虚构开销误拒绝。当前作者新鲜 Node22/22、全量405/405、标准build/diff均0；Rust三输入不变，引用定向16与静默 locked串行全量485通过/2既有ignored，以及fmt/clippy，而非冒称新9源/whole重跑。Root/Astra独立源码复审通过，详情与真实RED/harness边界见 [F3证据](evidence/yam-functional-f3/README.md)。native GUI/三平台/F7/formal provider仍待；自动更新后续及许可batch02暂停状态不变。


## F5：待处理事项卡片（源码交付）

卡片区分权限请求、待处理、故障与终态，显式定位原会话终端。历史/来源未确认事件只导航，不清当前未读；权限仍在原生 agent 终端处理，无虚假 approve/reject、自动输入、启动或控制权接管。只有最初为当前事件且附着后的 fresh current-owner get_session 仍匹配原始 ID/revision/turn/generation/phase 才发送既有读取回执；owner 为最终校验者，generation 仅记录来源 epoch，非加密签名，ACK 不是原子 current-turn 事务。

当前 repair1 将作用域约束传入实际 openHistory，旧 frame/snapshot/parser/错误与刷新不能越过新选择或待处理操作；自身版本的合法 busy 清理仍可执行，不能清除替换附件，普通后台 pane 行为保持。作者定向88/88、全量 Node488/488、标准build/diff实际通过；Root/Astra独立源码复审通过。详见 [F5证据](evidence/yam-functional-f5/README.md)。native GUI/Agent/F7 与 formal provider 仍未验收。

## F6：保留日志范围与导出（源码交付）

可靠来源显示精确 u64 十进制半开字节范围；旧 ended end0、缺失或不一致 offset 标未知，不声称找回丢失输出。缺失/非法 retained byte count 保持未知，明确有效0才显示0。当前 local/current-owner snapshot/search/String 读取使用严格 UTF-8、有界8MiB+1读取，先拒超限再解码；旧 owner proxy 读取不因此自动有界或严格；已实现的兼容保护是旧 owner 返回的 snapshot 在导出组装范围/metadata/body及弹保存框前再次校验8MiB。plain 导出清理后的文件长度与原始保留字节范围分开。

搜索范围仅代表成功读取且计入本页预算的来源（含零命中）；超过剩余64MiB的已读来源不列 scanned descriptor，保留 incomplete 与该来源 cursor。逐行耗尽才完整，early-hit 不完整；保留既有预算。不安全 Number offset 禁用 excerpt RPC，仍可定位会话。actual export render-time 身份与请求 fence 覆盖切换/ABA/卸载/旧 finally；取消无 Saved，既有文件保护保留，不声称撤销已获用户批准的磁盘写入。

[证据](evidence/yam-functional-f6/README.md)：当前R1 Node25/25、全量509/509、Rust定向12/12（为全量子集）、静默串行 locked 全量497 passed/2既有ignored；标准build/fmt/clippy/diff均实际0。Root/Astra独立源码复审通过。首候选两P2、实际RED和编译/测试oracle差异均保留；native GUI/保存框/真实owner/Agent/F7及formal provider覆盖仍未完成。

## F7：当前集成验证

F1–F6源码与有限smoke helper已通过独立源码复审。当前实际检查：Python host167run/166pass/唯一指定native runtime默认编码测试skip，背景46项为其子集；Node509/509含覆盖率，静默locked串行Rust497passed/2既有ignored，build/fmt/clippy/diff全部0。原计划MD/JSON保留冻结规划状态，交付事实见当前证据。

新唯一编译标识macOS developer应用实际77.329秒synthetic PTY流程通过：SIGTERM方式GUI退出重开保留owner/task身份、后台终端query回复与Unicode alternate scene、显式输入接管、stop-all shutdown、65秒连接idle及owner重启后的冻结scene；精确唯一包进程无残留。CUA路径timeout及ID Invalid app，未成功读取或操作UI，不能推断产品deadlock，也不代表六项交互UI/点关闭/真实Agent续聊或通知delivery/WindowsLinux原生验收。developer notices incomplete、非release/legal；updater后续与license batch02暂停，原生Agent续聊差异留研究。

[F7当前证据](evidence/yam-functional-f7/README.md)区分first candidate/R1、真实RED/harness、构建及原生阶段输入、最终自动检查和未覆盖边界；formal provider coverage仍uncovered。

| 独立浏览器窗口 C01a | main More actions → Browser，HTTP(S)URL与Show/Reload/Close；固定单独窗口，native identity gate和exact WebView plugin scope，generation/Destroyed保留不确定关闭状态 | [C01a回执](superpowers/plans/2026-10-09-yam-cmux-c01a.md)；60/1073front、599Rust+2原ignored/10target，独立60+10 PASS。124-file frontend/security投影绑定；native iframe/plugin/render/ReactDOM/跨平台/full C01/Suite未验，旧debug138未含，updater暂停 |

| A11有限owner/parser测量 | 隔离F7实跑r6完成：300/300 submission→parser P95 30.329208ms，writeRPC P95 15.197292ms，3251476bytes exact drain；cleanup真实wait/absent | [回执](superpowers/plans/2026-10-09-yam-cmux-a11-fixture.md)：高档1MiB/s offered仅544755.82B/s、stall4.938s；134 helper/独立sol，原失败和清理recoverable错误保留。非paint/ACK起点；nativeGUI/ReactDOM/cmux/RSS/full A11/Suite仍open，updater暂停 |

| D03a 显式SSH终端 | main More→Connect SSH；mac固定系统SSH/原生配置，typed历史与显式Reconnect；全局click snapshot；Unknown当前窗口暂停新启动、保已有会话，无自动解除 | [有限回执](superpowers/plans/2026-10-09-yam-cmux-d03a.md)：1084front/616Rust+2原ignored、独立140+17+probe，两P2已闭环。实际SSH/认证/GUI/ReactDOM/host/IPv6/CLI扩展/fullD03/Suite未验；旧debug未含，updater暂停 |

### A09a 单文件拖放路径（2026-10-09）

当前活动终端可确认单个普通文件的完整引用路径并插入一次，不附 Enter、不读取/上传内容。源码及1126前端、独立154审核通过；[有限收据](superpowers/plans/2026-10-09-yam-cmux-a09a.md)。目录、多文件、真实GUI/file RPC、图像上传协议和完整A09仍待验。

### A11b1 测量工具诊断（2026-10-09）

现有fixture增加有界清理请求分类/实际预算与阶段实际数据、marker、stall记录；源码及128 Python tests、独立审核通过。[收据](superpowers/plans/2026-10-09-yam-cmux-a11b1.md)。本片未运行新实际性能负载，不证明新吞吐或根因；完整A11/GUI/Suite待验，未来须fresh artifact binding。

### D03b IPv6 字面地址（2026-10-09）

Connect SSH 接受 bare 或 UI 一对[] IPv6，独立端口字段；保原拼写与系统配置，标题[]仅展示。源码/1138前端/20Rust定向及独立33离线对照通过。[有限收据](superpowers/plans/2026-10-09-yam-cmux-d03b.md)。zone/CIDR/URI/bracketport不支持；真实主机、GUI、降级兼容及完整D03待验。

2026-10-09：[STOP安全拒绝诊断](superpowers/plans/2026-10-09-yam-terminal-stop-rejection-diagnostics.md)有限工具切片通过：新 diagnostics v2 严格保留三固定枚举，仅匹配请求/完整原生字符串分类，其他 outcome 为 null；不保留原始错误。6定向 RED→GREEN、134 helper 与独立 GPT-6.1-sol 134/spec/quality PASS（不重复加总），STOP顺序/预算/身份屏障/fallback/stop_failed保持。184源码map仅exact4变化；R9 v1及未知原因不变，无新native修复/性能结论/owner/GUI/build/全前端/fullA11/Suite验收，updater暂停。

2026-10-09：[Native输出阶段诊断](superpowers/plans/2026-10-09-yam-native-output-stage-diagnostics.md)有限源码切片及独立Sol复审通过：dev/debug background owner显式1开启，普通app默认关闭，专用fixture固定设置1主动开启（无额外CLI开关）；worker记录原始读长四桶及真实锁/serial/reply/append/emit阶段，嵌套区间不相加，reply非纯parser、GUI未测。Rust定向12/Python9、library656通过+3既有忽略、helpers143及fmt/diff通过；Sol12/9与false-complete回归通过，root核对修复冻结。仅两条匿名观测，不推断身份；stderr写入时间无界、可能丢失摘要且有观测开销。无新artifact实际run、无16KiB优化，不构成R9根因/修复、native性能、完整A11/Suite结论；updater暂停。


2026-10-09（作者：Jeff.Liu）：R10 隔离后台 owner/parser 实跑在当次冻结输入上通过有限结果审核：300/300 submission→parser projection marker，P95 26.164292ms；高档实际 622097.65B/s，不是 1MiB/s 达标。两条匿名阶段诊断不映射会话、不归因性能改善；两个 STOP 请求均 ACK，但 parser signal 先于 acknowledged owner shutdown，使用 fallback，不能称 graceful shutdown。Root 实查五个 PID 与 run root absent，Sol 独立结果审核通过。持久证据包位于 `~/.local/share/yam/development-archives/20261009-terminal-r10-stages/evidence.tar.gz`，SHA-256 `b8a296eee5ca7a33ee6c5188e5ce987d3f05aef1d1f258ad725df2c6137b1a98`；35成员为34列举证据加自排除的内部manifest。该结论仅为 current-at-run；后续源码及本次文档变化使旧R10 current gate不适用于当前工作树，原始receipt/gate保持不变。未验证 GUI paint/native GUI、cmux对齐或完整A11/Suite，也未交付性能修复；updater继续暂停。

2026-10-09（作者：Jeff.Liu）：启动/停止反馈有限修复已通过独立Sol源码与47项定向审核。启动失败与unknown仅保留既有UI错误及未知结果暂停指引，不向任何已有终端写入合成提示；admission释放、启动标志、成功history/refresh与未知结果禁止再次创建保持。停止RPC始终发送调用时捕获的ID；迟到失败仅在仍mounted、detailVersion及ID均未变时显示，覆盖A→B及A→B→A，双pending不重试。未承诺同一detail中新旧错误排序或重复stop串行化。实际callback/deferred RED后定向47/47、全前端1326/1326、标准build及diff check通过；只是Node依赖替身下的真实回调验证，非ReactDOM/native GUI/PTY验收。184源码集合仅App.tsx与terminal-launch.test.mjs变化，其余182完全一致；修复后聚合SHA-256 `ef87a1fd9b30c9fa19d5229e3f7c7c439d248f440bed2ca1271c4769824b116d`。固定证据归档见 `~/.local/share/yam/development-archives/20261009-session-operation-feedback/evidence.tar.gz`；历史阶段结论和未验范围不因此升级。


2026-10-09（作者：Jeff.Liu）：B01项目侧栏有限拖拽排序通过Sol独立源码/规格/质量审核。主窗口已保存且身份唯一的项目提供独立原生拖拽手柄，保留↑↓键盘操作；新纯函数仅在同一Pin组内移动到目标位置，保留其他组的槽位与项目对象。常量MIME标记不携带路径，授权来自同一renderer内存intent；任意成功列表替换使旧拖拽失效，drop再核对最新唯一ID、字面路径及Pin组，外部/File拖拽不消费intent。继续先保存再更新ref/state、成功发布一次，保存失败保持原状态。实际feature缺失RED后定向65/65、全前端1342/1342、标准build/diff check及Sol独立65项通过；184源码仅App.tsx、workspaces.ts及对应两测试变化，其余180一致，聚合SHA-256 `1532a58f4b8b1b7972a5d82b7f1d244024f7f5422637a5f6e2a693a0b72437a8`。证据归档：`~/.local/share/yam/development-archives/20261009-project-drag/evidence.tar.gz`。验证限于纯函数和Node实际回调/JSX替身，未验证ReactDOM/native GUI拖拽，不代表完整B01、项目层级或cmux全部对齐；updater继续暂停。
