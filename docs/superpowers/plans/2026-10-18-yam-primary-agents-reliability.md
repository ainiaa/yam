# YAM Claude Code / Codex 主要场景优化方案

> **执行说明：** 用户已确认按 T1—T6 实施，并要求 Converge 多模型协作、测试先行、保留原生 TUI、不影响现有应用和任务、不调用真实厂商。T1—T5 源码验证完成；T6 的候选源码综合验证见第 12 节，固定包启用和候选桌面验收等待安全窗口。以下保留已批准方案及规划阶段依据，不授权付费请求、提交或运行中包替换。

**作者：** Jeff.Liu。**日期：** 2026-10-18。

**目标：** 优先保证 Claude Code、Codex 原生 TUI，以及两者连接 DeepSeek / 协议兼容网关的日常开发流程可靠。

**架构：** 继续复用现有 PTY、后台 owner、Agent hook、连接快照、隔离配置目录、模板和原生 Continue。供应商与 CLI 分开表达；第三方调用仍由原生 CLI 负责。保持 Rust / Tauri / React / xterm 技术栈，不新增 SDK、代理服务或依赖，不重构整体架构。

**执行边界：** 所有步骤串行推进，每步交付可观察结果。应用启用仍须满足第 8 节的运行安全条件。

---

## 1. 本轮范围与成功标准

本轮以当前 macOS 环境为第一验收平台，覆盖以下六条路径：

| 路径 | 执行器 | 配置来源 | 核心协议 / 行为 |
|---|---|---|---|
| Claude 原生配置 | Claude Code TUI | 继承 CLI 配置和登录状态 | YAM 不推断其最终上游 |
| Codex 原生配置 | Codex TUI | 继承 CLI 配置和登录状态 | YAM 不推断其最终上游 |
| Claude + DeepSeek | Claude Code TUI | YAM 独立 API 配置 | DeepSeek Anthropic 兼容入口 |
| Codex + DeepSeek | Codex TUI | YAM 独立 API 配置 | DeepSeek Responses 入口 |
| Claude + 自定义网关 | Claude Code TUI | YAM 独立 API 配置 | 网关必须兼容 Anthropic Messages |
| Codex + 自定义网关 | Codex TUI | YAM 独立 API 配置 | 网关必须兼容 Responses |

六条路径都要覆盖：创建 → 输入 → 流式响应 → 工具调用 / 权限 → 回合结果 → 多会话切换 → 查看历史 → 继续对话。兼容性结论绑定实际 CLI 版本、模型与端点；不把一种网关的结果推广到所有供应商。

这些是完整使用目标，不表示本地夹具能证明真实服务可用。未获真实服务调用授权时，原生继承模式只验证启动、配置来源和隔离；真实响应、账户额度和供应商工具回合保留未验收，不能把六条路径汇总为厂商全通过。

统一验收要求：

- 每次明确启动只创建一个执行；结果未知时不自动重试创建。
- 提交内容、凭据、响应、状态和通知都属于正确的会话及回合。
- 第三方出错不回退到官方订阅、不暗换模型、不重放原 prompt。
- GUI 重开、隐藏标签、查看历史不重跑任务；Continue 使用原连接和原生对话身份。
- 中文输入、粘贴、滚动、焦点和 TUI 权限交互可实际使用。
- 原有运行任务、原生认证文件及历史保持；验证只控制明确登记的测试会话。

## 2. 当前已有能力与实际缺口

以下为现有代码和既有验收的事实，不将已有功能重复规划成重建工作。

| 项目 | 已有基础 | 本轮处理 |
|---|---|---|
| 原生 TUI / 后台运行 | 两个 CLI 已接入 PTY、owner 和原生回调 | 扩充主要场景回归，按失败结果修复 |
| Provider 隔离 | 有连接快照、私有目录、环境变量引用、冲突保护 | 保留；覆盖官方与第三方同时运行 |
| DeepSeek 入口 | `provider-config.ts:25` 默认绑定 Codex；前后端限制 `deepseek` 仅用于 Codex | 增加明确的 Claude + DeepSeek 入口 |
| Claude 模型选择 | 当前只传主模型 `--model`，受管环境会移除继承的 `ANTHROPIC_*` / `CLAUDE_*` | 验证轻量模型、子任务请求的实际选择，补最小必要映射 |
| Codex 第三方模型 | 已使用 Responses；当前没有专门的 DeepSeek 模型能力目录 | 核对当前 CLI 所需的模型元数据，不假定模型名能表达上下文和工具能力 |
| 凭据 | 从 owner 的环境解析；历史只存变量名 | 改进缺失 / 冲突提示；不引入热更新密钥库 |
| 连通性 / 目录 | 本地 TCP 检查；Magpie 身份和模型目录 GET | 保持为局部检查，不改称推理验证 |
| Codex API 失败 | 已修复；回执观察限定 macOS / Codex 0.162.1 | 复用并验证边界，显示版本能力限制 |
| Claude Esc | CLI 本身支持；原生 TUI 缺少可靠外部中断终态 | 按已确认决定保留为已知限制，不新增 SDK |
| 历史与 Continue | 已有连接快照、原生 ID、Previous runs | 补 Claude / DeepSeek 与网关矩阵，强化只读查看和显式续聊边界 |
| 已结束标签 | `selectTerminalTab → openTerminal` 可进入恢复并创建执行 | 本方案建议：已结束 Agent 标签默认只读，启动由显式操作触发 |

本轮只读核对基线：HEAD `8fb2cb00c32a5ae72b48f0d04776eec1420734ab`，Source Receipt `2cef2158eba0d270b31c557c545a0e180f8bce3b4994f417a047a4ee80974f88`，已有 259 条 changed entries。全部已有未提交内容保留。确认后开始前重新核对基线，不能以本方案覆盖后续用户修改。

既有最近回归是前端 1547 通过、Rust 749 通过 / 7 ignored；这是此前版本证据，本次规划没有重新运行测试，也不作为未来实现的通过回执。

## 3. 接入和配置设计

### 3.1 保持数据结构，补齐选择

- 复用 `ProviderConfig { id, model, base_url, api_key_env }` 和 `AgentLaunch.adapter`。
- 保留已有 `deepseek` 选择为 Codex + DeepSeek，新增表单选择 `deepseek-claude`；保存时仍为 `id=deepseek, adapter=claude`。
- `supportsProvider`、Rust `ProviderConfig::validate`、模板回显、项目默认值和历史详情同步接受这两个明确组合；不放开任意 CLI / Provider 组合。
- 两种入口使用各自的默认端点：Codex `https://api.deepseek.com`；Claude `https://api.deepseek.com/anthropic`。模型可编辑，不把模型列表缓存永久视为有效能力。
- 不自动修改旧模板或旧历史的模型、URL、目录和原生 ID。修改模型 / URL 后只影响明确新建的配置，不迁移已有对话。
- 界面同时展示 CLI、Provider、配置模型和端点。原生选项标为“继承 CLI 配置”，不能直接标为“已验证官方订阅”。

### 3.2 明确协议和模型能力

- Codex 的自定义端点要求 Responses；Claude 的自定义端点要求 Anthropic Messages。只支持 Chat Completions 的服务不能因标注“OpenAI compatible”就被认作兼容 Codex。
- Claude 受管 DeepSeek 会话的主模型、默认模型别名和子任务模型要在夹具中验证。默认映射到用户选定模型，避免遗漏映射后使用供应商隐式映射；本轮不增加一套复杂的模型路由编辑器。
- 保留既有已验证的 API 认证方式。对照当前 CLI 验证所需 header，清除竞争的认证变量；不因文档示例变量不同而盲目替换认证。
- 对 Codex DeepSeek 核对上下文窗口、工具调用格式和支持的推理参数。先写当前已安装 CLI 的失败用例；需要时只在该受管私有目录生成经过审阅的最小模型元数据。不下载执行供应商安装脚本、不导入大段远程系统提示词、不改全局 `~/.codex`。
- 不把不支持的功能伪装成支持；文档、图片、搜索等额外能力按具体服务证据说明，本轮通过标准以文本开发任务、工具及权限为主。

### 3.3 保持隔离和凭据边界

- 凭据值只在后台准备子进程时解析；配置、模板、项目文件、历史、诊断只保存变量名或脱敏状态。
- 缺失凭据、非法端点、认证配置冲突、配置目录不安全均在创建 PTY 和落历史前失败。
- 官方与第三方并行时分别使用原生 / 受管目录，校验进程环境、路由和原生存储归属。
- 普通关闭再打开 GUI 不刷新后台 owner 的环境。提示应说明“后台未读取到指定变量”，不能误导用户反复新开窗口。
- 暂不新增运行中 owner 的密钥注入、Keychain 集成或配置热重载；需要新环境的会话在安全启用窗口再验证。
- 不复制全局认证、信任、插件或 MCP 配置到隔离目录。对用户原生模式中的已有配置保持继承；受管模式明确说明其配置来源和隔离边界。

## 4. 回合状态与失败设计

复用现有 `AgentState` / Inbox，不另建状态系统。

| 场景 | 预期 |
|---|---|
| 收到可信开始事件 | 当前会话当前回合 Working |
| 正常结束 | Response finished；同一回合不再产生 failed |
| 权限等待 | Permission required；审批仍由原生 TUI 处理 |
| 已确认 API 失败 | Round failed，可查看原生错误；不把密钥或完整返回体写入通知 |
| CLI 自己还在重试 / 等待网络 | 不因一段静默或一次临时 HTTP 错误提前宣告失败 |
| Codex 可信取消 | Round interrupted；仍可在同一 CLI 中继续下一轮 |
| Claude Esc 缺少外部终态 | 保留已知限制，提示在原生 TUI 确认；不根据 Escape、光标或静默时间伪造 interrupted |
| Hook 未信任 / 回执能力不支持 | 清楚显示回执不可用或能力受限；终端仍可用 |
| 重复、迟到或旧 generation 事件 | 不重复通知、不覆盖新回合、不修改其他会话 |

失败覆盖 400 / 401 / 403 / 404 / 429 / 5xx、连接拒绝、断流、延迟首 token；最终判定依据 CLI 的真实终态，而非某一次网络请求。错误后在原 TUI 继续一轮，必须恢复正确状态。

Codex 版本保护继续保留；新增版本只有通过对应格式夹具和实际 CLI 验证后才能放行。不能通过删除版本检查声称兼容。观察器在完成、取消、进程退出和期限结束时释放；不新增常驻 app-server 监视进程。

## 5. 会话连续性与日常操作设计

### 5.1 查看和执行分开

**建议的用户行为调整：** 选择已结束的 Claude / Codex 标签先显示原输出或可用的只读历史。只有 Continue / Run again 才创建执行；普通 Shell 的既有恢复行为不在本次调整范围。

- Continue：同一原生对话，恢复保存的 CLI、Provider、模型、URL、目录和变量引用。
- Run again：明确新执行 / 新对话，不伪装续聊。
- Native ID 不存在、原项目缺失、凭据缺失、配置不兼容：明确失败，保留历史，不自动新开空会话。
- Continue 双击或响应未知：不得重复创建；返回后保持名称、置顶、原生 ID 关联和 Previous runs。
- 查看、搜索、刷新历史、切标签、重新打开 GUI 不发送模型请求。
- 官方 / API / 不同网关的同名会话不能合并；连接变化也不能把旧对话续到新上游。

### 5.2 完整 TUI 路径验收

分别在两个真实 TUI 上验证中文输入法、英文、退格 / 光标、多行粘贴取消与确认、权限菜单、Esc、切换 pane、分屏缩放、回看历史、复制及搜索。程序注入 Unicode 不替代真实输入法验收。

两个 Agent 并行输出时，输入和审批只发送至当前目标；搜索框 / 启动框关闭后的迟到挂接不能抢焦点。长输出和回看过程中检查最近修复的滚动条、阅读位置、Return to live 和隐藏恢复，不重做终端架构。

## 6. 六个实施任务

各任务顺序为：添加失败断言 → 运行确认红灯 → 最小修复 → 定向绿灯 → 相关回归 → 记录结果。没有复现缺陷的既有能力保留，通过新增回归证明，不为了“优化”改写。

| 任务 | 一个可独立验收的结果 | 主要范围 | 关键测试 |
|---|---|---|---|
| T1 双 CLI DeepSeek 入口 | Claude / Codex 均可明确配置 DeepSeek 且旧配置不变 | `provider-config.ts`、`App.tsx`、`provider_launch.rs`、模板 / 项目配置测试 | 两个预设来回切换；保存 / Apply / 项目默认 / 历史重读；旧 deepseek 仍绑定 Codex；非法组合拒绝 |
| T2 原生模型请求正确 | 实际 CLI 发出的模型、协议和认证与选择相符 | `provider_launch.rs`、`provider_native_tests.rs`、现有 `provider_api.py` | 两 CLI 的真实本地请求；工具回合；Claude 模型别名；Codex 模型能力；官方目录哨兵不变 |
| T3 启动问题可处理 | 配置 / 凭据 / 能力错误在正确位置给出明确下一步 | 启动错误、连接详情、`provider_launch.rs`、现有 probe / catalog 文案 | 缺变量不落历史；旧 owner 拒绝不重试；改 URL 后旧查询不能覆盖；TCP / 目录成功不变成推理成功 |
| T4 回合状态可信 | 支持范围内失败 / 完成 / 权限不混淆，限制清楚 | `agent_bridge.rs`、`agent_events.rs`、`codex_outcome.rs`、状态 / 通知组件 | 正常 / 异常 / 乱序 / 重复 / 跨会话；失败后成功；版本未知；Claude Esc 保持已知限制 |
| T5 续聊与浏览安全 | 浏览不执行，Continue 恢复原对话和原路由 | `App.tsx`、`session-recovery.ts`、现有后台 / 历史 / resume 校验 | 已结束 Agent 标签不创建；两次 Continue；双击 / 未知结果；配置变更、缺 ID、旧日志；名称 / 置顶保持 |
| T6 主要场景集成验收 | 当前应用中的六条使用路径有可追溯结果和边界 | 前述调用链、已有 native fixture、桌面验收、能力文档 | 真实 TUI、本地协议夹具、并行输入 / 输出、GUI 重开、权限、精确停止、清理与原任务保持 |

T1 → T2 → T3 → T4 → T5 → T6 顺序执行。每步结果单独可看，不将所有问题积压到最后。T6 的源码修复仅限前五步冻结路径；若实体验收发现根因在其他终端模块，先报告证据和补充范围，再按确认后的范围处理，不以集成验收为由扩大为全仓改造。

## 7. 测试与验收层级

### 自动回归

以下是确认后执行的命令，本次没有运行：

```sh
cd /Users/liuwenyuan/www/tools/yam/apps/desktop
rtk node --test tests/provider-config.test.mjs tests/launch-templates.test.mjs tests/project-config.test.mjs
rtk node --test tests/provider-probe.test.mjs tests/provider-catalog.test.mjs tests/connection-details-ui.test.mjs
rtk node --test tests/agent-events.test.mjs tests/notifications.test.mjs tests/attention-actions.test.mjs
rtk node --test tests/session-recovery.test.mjs tests/conversation-continuity.test.mjs tests/terminal-reopen-ui.test.mjs
rtk pnpm test
rtk pnpm run build
cd /Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri
rtk cargo test --locked provider_launch -- --test-threads=2
rtk cargo test --locked codex_outcome -- --test-threads=2
rtk cargo test --locked provider_native_codex_continuity -- --ignored --test-threads=1
rtk cargo test --locked provider_native_claude_continuity -- --ignored --test-threads=1
rtk cargo test --locked -- --test-threads=2
```

复用现有 Rust / Node 测试与本地 API fixture；native 两项使用已安装 CLI，仅访问 loopback，不调用真实厂商。Claude 的现有原生 fixture 当前为 Gemini 兼容路由，T2 应改成对本轮 Claude + DeepSeek / custom 的覆盖，保留既有保护断言。实际测试数量和 ignored 原因以新结果记录，不沿用旧数字作为新通过。

### 原生桌面验收

| 必测组 | 场景 |
|---|---|
| 首次使用 | 真实目录 / hook 信任交互、一次启动、输入焦点、首轮响应 |
| 开发回合 | 流式文本 → 在临时项目读文件 / 执行无害命令 → 权限允许 / 拒绝 → 回合结束 |
| 异常恢复 | Key 无效、无权限、错误模型、限流 / 服务错误、断流、网关不可达、错误后下一轮成功 |
| 会话恢复 | 测试会话停止 → Continue → 原 native ID / 路由 / 上下文保持；浏览旧标签无新请求 |
| 并行 | Claude 与 Codex、官方配置与第三方配置共存；状态、输入、权限、Inbox 不串会话 |
| 日常交互 | 真实 IME、多行粘贴、搜索 / 复制、滚动回看、隐藏 / 恢复、分屏和焦点 |
| 生命周期 | GUI 正常退出 / 重开保持 owner 和会话；只停止选定测试会话，旁边测试会话继续可用 |

“源码通过”“实际 CLI + 本地夹具通过”“固定应用 GUI 通过”“真实厂商通过”分列。前三级通过不能改称 DeepSeek 实际服务通过。

### 真实服务抽验

本方案默认不发送付费请求。需要标注“真实 DeepSeek / 官方服务通过”时，另经用户授权，使用已有有效凭据及独立临时项目，进行最小文本 + 一次工具调用 + 一次续聊，记录脱敏结果。未授权或无凭据时，明确保持未验收，不阻止其他确定性验证。

## 8. 当前应用和任务保护

1. 开始前记录固定应用路径、GUI / owner 身份、原有会话集合、运行任务身份及当前连接配置摘要；不读取密钥内容。
2. 开发和自动测试不向原任务发送输入、Esc、Stop、Continue 或任何恢复请求；原任务也不作为验收夹具。
3. 只维护现有固定 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app` / `com.yam.desktop`，不创建第二个验收 App。
4. 自动测试采用临时目录和明确属于本轮的测试进程；清理必须核对身份，只清理这些资源。
5. 固定 `.app` 中的 helper 也会被运行中 CLI 调用。不能把“仅覆盖包、不重启 GUI”当作无影响；运行任务仍依赖旧包时不覆盖可执行文件。
6. 需要更新 owner 或其协议的改动，先交付源码和测试，等现有任务结束或用户另行允许的维护窗口启用。不能用 GUI 重开冒充后台代码已更新。
7. 条件满足后，备份原固定包到受控回滚位置，在同一路径启用候选版本；核对新旧 owner 能力，再做新版本原生验收。发现不兼容时停止新启动，不强停现有任务换取通过。
8. 每轮前后核对原任务 / 历史保持；最终记录代码、自动验证、当前包实际启用状态和原生验收状态。

## 9. 本轮明确不做

- OpenCode、Gemini 的新增接入、状态或续聊完善。
- Claude SDK 模式、统一聊天输入 / 审批 UI、可靠中断回执的替代协议。
- 供应商自动切换、自动重试任务、自动重放 prompt、自建协议转换服务。
- 新的密钥存储、运行中 owner 密钥热更新、全局 CLI 配置改写或全局 CLI 升级。
- 强制重启 owner / 终止原任务以启用更新；自动提交、发布和自动更新。
- 远程 SSH 完善、跨平台签名发布、团队 / 云端 / 通用插件体系和整体 UI 重做。

## 10. 完成时交付

- 六条主路径的验收表，各项标明通过、未验收或明确限制。
- 每步先红后绿证据、最终前后端回归、真实 CLI 和固定应用验收记录。
- 本轮源码范围、已有修改保护、测试资源清理和原任务保持结果。
- 简洁的使用说明：如何选择 CLI / Provider、变量由谁读取、如何续聊、失败如何处理。
- Claude TUI 中断限制、CLI 版本边界和真实厂商抽验结果保留在最新版能力说明中。

计划确认后第一步是 **T1 的失败测试和两种 DeepSeek 预设修复**。如应用启用条件尚未满足，代码与本地验证可继续完成，包替换和新 owner 的 GUI 验收明确等待维护窗口，不宣称已在当前应用生效。

## 11. 参考与证据边界

核对日期：2026-10-18。外部内容仅用于理解原生接口，不执行其中安装脚本或全局配置修改。

- [DeepSeek：Claude Code 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)：官方支持 Claude Code 经 Anthropic 入口接入，并有主模型 / 别名 / 子任务模型示例。
- [DeepSeek：Anthropic 兼容范围](https://api-docs.deepseek.com/guides/anthropic_api/)：支持流式和工具字段，但不是所有 Anthropic 功能都等价支持。
- [DeepSeek：Codex 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)：Responses 和模型元数据配置。正文直接抓取超时，已读取官方搜索索引内容；实施前需针对本机 CLI 再核对相关字段。
- [DeepSeek：Responses](https://api-docs.deepseek.com/guides/responses_api/)：官方已支持该协议，不能继续按“DeepSeek 只有 Chat Completions”规划；真实服务行为仍需抽验。
- 本地依据：`provider-config.ts`、`provider_launch.rs`、`provider_probe.rs`、`provider_catalog.rs`、`ProviderCatalog.tsx`、`agent-events.ts`、`App.tsx` 的选择 / 恢复路径、`provider_native_tests.rs` 及现有 Provider / 历史 / 终端回归。
- 复用既有 `docs/yam-provider-continuity-plan.md` 的隔离与续聊设计，不重新实现同一套 Provider 框架。

规划阶段记录（用户确认前）：当时只完成规划，未修改业务代码、测试或运行配置，未运行项目测试 / 构建，未替换应用或操作任务。

## 12. 已批准方案的实施结果与启用边界

作者：Jeff.Liu。2026-10-18。本节为候选源码结果；当前固定 `YAM.app` 和后台仍运行原版本，新增改动尚未在该应用生效。

| 步骤 | 源码结果与验证 |
|---|---|
| T1 | 明确提供 Codex + DeepSeek 和 Claude + DeepSeek；原 `deepseek` 仍选择 Codex，新入口保存相同 Provider 结构。旧模板、项目配置和历史不迁移；先红后绿，分项规格与质量复核通过。 |
| T2 | DeepSeek + Claude 的主模型、Opus/Sonnet/Haiku 别名及子代理模型统一到所选模型，其他连接保持原解析。真实本机 CLI 经非转发 loopback 验证模型、认证、流式、文件工具、子代理及续聊；现有 Codex 配置可完成本轮工具回合，无须新增模型目录机制。 |
| T3 | 缺失或非法凭据在创建会话前指出后台需要的变量名，不打印值；表单区分 Responses / Anthropic Messages，说明重开窗口不刷新后台环境，须先结束任务再重启后台。TCP / 目录仍不代表上游推理可用。42 个前端和 27 个 Rust 测试重复通过。 |
| T4 | 修复旧 Claude 提交事件把后续就绪、失败或权限回合改回 Working 的问题；先以完整状态断言复现，再将兼容分支限定当前 turn，保留当前 prompt ID 重复的兼容行为。93 个前端及 13 个结果观察、28 个状态、25 个桥接测试重复通过。限制说明出现在交互会话的 Connection details 中。 |
| T5 | 已结束 Claude / Codex 标签、冷读取和布局恢复复用只读历史入口，不启动默认 shell 或 Agent；执行须显式 Continue / Run again。活动 Agent 和普通 Shell 保留原流程，续聊快照、原生身份、名称、置顶及 Previous runs 机制不变。80 个前端、4 个存储测试重复通过，额外 140 个布局回归通过。 |
| T6 | 全量前端 **1563 passed / 0 skipped**；Rust **755 passed / 13 ignored**，doctest 通过；13 个 ignored 中的 **9 个本机 CLI 协议测试已单独执行并通过**，含 8 个主要 Agent 测试及 1 个既有 Gemini 回归。TypeScript / Web build 通过。Node 现有覆盖范围为 `src/*.ts`，行 / 分支 / 函数 **99.74% / 94.48% / 96.60%**，不代表 TSX、Rust 或桌面体验覆盖率。 |

### 六条路径的分层结论

| 路径 | 本轮证据 | 尚未覆盖 |
|---|---|---|
| Claude 原生配置 | 继承 CLI 的准备 / 参数 / 隔离与历史恢复回归 | 真实账户响应、候选 GUI / TUI |
| Codex 原生配置 | 继承 CLI 的准备 / 参数 / 隔离与历史恢复回归 | 真实账户响应、候选 GUI / TUI |
| Claude + DeepSeek | 预设及模型映射；本机 CLI 的 Messages、工具、子代理、续聊 fixture | DeepSeek 服务、额度及候选 GUI / TUI |
| Codex + DeepSeek | 预设；本机 CLI 的 Responses、工具及续聊 fixture | DeepSeek 服务、额度及候选 GUI / TUI |
| Claude + 自定义网关 | 本机 CLI 的 Messages、所选模型及真实文件工具回合 fixture | 任意实际网关的兼容性及候选 GUI / TUI |
| Codex + 自定义网关 | 本机 CLI 的 Responses、所选模型及真实文件工具回合 fixture | 任意实际网关的兼容性及候选 GUI / TUI |

上述原生 CLI 协议夹具不等于交互 TUI、权限界面、真实 IME 或当前固定应用验收。原有 3 个任务、50 条会话集合、后台 owner 及固定应用文件逐阶段核对保持；本轮没有重启 GUI / owner、替换包或控制原任务。只有满足第 8 节的安全窗口后才启用，并补做候选包的输入、IME、权限、并行、GUI 重开和精确停止验收。

### 已知限制与证据缺项

- Claude 原生 TUI 的 Escape 取消仍缺可靠外部终态回执；不新增 SDK 或按终端文本猜测。Codex API 失败观察仍只接受 macOS / 已测 `0.162.1` 格式，其他版本不放开保护。
- Converge 多模型采用 Luna 定点调查、Sol 独立分项复核与一次组合复核，根控制器单写入；组合静态复核通过。外部 runner 的 `PermissionError` 未重放，宿主复核不冒充该 runner 成功。
- 严格 Plan audit 的源码链和范围通过，但验收命令 argv 未全部匹配：早期回执记录实际 `node/cargo`，冻结命令含 `rtk`，另有宽过滤器和文件顺序差异。保留原始回执，不改写为正式 Suite 通过；根受管状态初始化和原生覆盖率绑定也仍未覆盖。T1 有初始 Source Receipt 和红绿证据，未保存逐文件前态副本。
- 未调用真实厂商，未新增 OpenCode / Gemini 能力，未验证其他系统、macOS 通知横幅 / 点击及候选 GUI；不把历史旧包的验收算作本次候选通过。

完整逐步日志、源码绑定、运行保护及严格审计见[实施证据目录](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/primary-agents-implementation-20261018)。本轮交付为候选源码及本地验证，T6 整体桌面启用验收仍为部分完成。
