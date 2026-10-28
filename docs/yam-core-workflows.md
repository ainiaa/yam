# YAM 核心工作流验收与操作说明

作者：Jeff.Liu。更新：2026-10-18。

本轮目标是舒适、可靠地使用本地 AI Agent，不要求完整对齐 cmux。以下六条必须在当前桌面应用中实际观察；源码测试、打包和后台 RPC 通过不能替代桌面体验通过。自动更新继续暂停。

## 当前状态

### 2026-10-18 Claude / Codex 候选源码结果

作者：Jeff.Liu。当前应用未替换；以下优化须等原任务结束或获准维护窗口后启用，尚未计为候选桌面验收通过。

- 新建时分别选择 Codex + DeepSeek / Claude + DeepSeek，填写模型、正确协议端点及凭据变量名；变量由后台读取，重开窗口不会刷新后台环境。
- 候选版本中，已结束 Claude / Codex 标签只查看保存输出；Continue 恢复保存的连接及可信原生身份，Run again 显式开启新任务。活动 Agent 和普通 Shell 保持原流程。
- 候选版本的 Connection details 显示 Claude Escape 外部回执限制，以及 Codex 失败观察的 macOS / 0.162.1 边界；重试和静默不当作失败。
- 本地源码验证：前端 1563 通过，Rust 755 通过 / 13 ignored，其中 9 个 CLI 协议夹具另行通过；Web build 通过。此结果不替代 GUI / TUI、IME、权限交互和真实服务验收。

详细边界及六条路径见[主要场景实施结果](superpowers/plans/2026-10-18-yam-primary-agents-reliability.md#12-已批准方案的实施结果与启用边界)。严格 Suite 回执仍有缺项。下方保留较早桌面验收的当次事实。

## 2026-10-18 第二轮补充复核

GPT-6.1-sol / GPT-6-astra 对第二轮全部改动独立复核，闭环三类问题：目录别名导致预览响应误拒绝、后台会话身份/回合版本陈旧（含异步 claim 覆盖竞态）、加载较早消息时阅读位置偏移。历史与注意事项相关测试夹具同时补齐真实 helper 和无隐藏错误断言。

当前源码验证：前端 **1535 passed / 0 failed / 0 skip**，覆盖率 **99.74% / 94.52% / 96.60%**；Rust 默认并发与双线程各 **737 passed / 0 failed / 7 ignored**，doctest 通过。Web、原生与 Tauri `--no-bundle` 构建通过，最终两模型复核无遗留发现。[完整回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/second-round-plan-20261017/implementation-report.md)。

本次未替换运行中的应用包、未重启 GUI/owner、未向任务发送输入或停止请求。原有 3 条任务的身份/配置哈希与全部 37 条会话 ID 保持；当前运行实例仍使用补充修复前版本，新修复的原生 GUI 验收尚未执行。以下既有 GUI 结论和旧测试数量保留为先前交付快照。

### 2026-10-17：桌面优化第二轮 R1—R3

2026-10-18 补验完成：结束 Codex 标签启动恢复与阅读历史均不新增会话；原 owner、3 条原任务和同一对话的 6 条消息保持。

第二轮九个步骤的实现与分项复核记录见仓库外的 [执行回执](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/second-round-plan-20261017/implementation-report.md)。继续使用固定 `YAM.app`、`com.yam.desktop` 和既有 owner；没有新增依赖或真实厂商推理请求。

| 使用入口 | 当前行为与实际验证 |
|---|---|
| New Agent / command → 自定义连接 | 显式检查本机网关身份、读取模型目录、筛选并选择原始模型 ID；读取不自动选模型。GUI 本机 fixture 已验证目录→选择→保存模板→Apply→启动。身份/API 可访问不等于上游认证、计费或推理可用。 |
| Git changes | staged/worktree 的文件行号与变更块可导航；文件预览单独显示当前工作树来源。GUI 已观察 staged 与 worktree 区分、行定位、文本查找与 HTML 字面显示；查询不写 Git index。 |
| Choose file to preview | 仅显式读取已授权项目内常规 UTF-8 文本（≤1 MiB）或静态 PNG/JPEG/WebP（≤5 MiB、1600 万像素）；拒绝链接、根外文件与 `.git`。GUI 已验证文件选择、取消、文本定位和图片缩放；边界/替换竞态/动画及损坏格式由原生回归覆盖。PNG 完整压缩数据校验与 JPEG 空扫描拒绝已先红后绿；损坏 JPEG 也已在最终应用显示 `file_invalid_image`。 |
| Terminal / Conversation | 已核实本机 Codex 身份才读结构化历史；只读，不提供输入或审批。每页最多 50 条、单条显示最多 64 KiB、累计最多 500 条；工具默认折叠、未知类型保留占位，文件入口重新授权。加载与刷新保留已读内容；刷新失败提供 Terminal 退路。 |
| Refresh conversation / 可信回合事件 | 无固定轮询；一个在途和一个最新待处理请求，按原生 ID 去重。实际 Codex 0.162.1 合成存储分页读取通过，GUI 连续两次 Continue 后同一原生 thread 显示 6 条消息；两次刷新与重开读取均无新增 fixture POST。工具/文件/未知类型、500 条上限、乱序与迟到响应由协议及组件回归覆盖。 |
| 切换与 GUI 重开 | 终端保持挂载，输入仍走原终端；真实鼠标 Terminal→Conversation 后恢复原控件焦点。普通退出再开仍为原 owner 和相同运行会话，不通过重跑取得历史。修复了 warm terminal 缓存身份回退及 section 自身聚焦覆盖子控件的缺陷。 |
| 慢网关并行输出 | 本机 3 秒超时期间合成终端输出计数 194→227（每行约 1 KiB、每秒 10 行）；这是有限并行可用性观察，不是高吞吐性能达标。 |

补充复核前交付快照的全前端 **1520 项通过、0 skip**，覆盖率 lines/branches/functions 为 **99.74% / 94.52% / 96.60%**；Web build 通过。完整 Rust 两种并发各 736 项通过、7 项忽略；原生构建和最终包身份见执行回执，原始失败与修复日志保留。GPT-6.1-sol 与 GPT-6-astra 的独立源码复核分项记录，不冒充正式 Converge Suite 验收；其 coverage parser 绑定缺口仍为 uncovered。

边界：macOS 是本轮实际环境；Windows/Linux、旧 Codex/legacy 存储、真实厂商认证/额度/计费未验证。不支持的 CLI/存储明确不可用并保留 Terminal。第一轮的旧 owner 托盘、确认全局停止和主动断连重连缺项仍保留，自动更新继续暂停。

### 2026-10-17：桌面优化第一轮 T1—T6

本轮复用固定 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`，应用标识仍为 `com.yam.desktop`。该第一轮回执形成时，第二轮尚未实施；当前第二轮事实见上节。

| 操作 | 当前行为与验收边界 |
|---|---|
| 读取启动模板失败 | 显示错误并保留原始存储；保存、覆盖、复制、删除均受保护。可复制原始数据；重置须明确确认，取消及写入失败保留原数据。 |
| Continue conversation | 成功后立即继承自定义名称和置顶，连续续聊保持；提交原运行 ID，由 owner 使用原生身份和原连接快照。 |
| Connection details | 展示选中会话保存的 CLI、配置来源、配置模型和脱敏端点。原生选项继承 CLI 配置；实际模型、认证、计费和最终上游均未验证。 |
| 连接模板 | 原格式保存可选 provider 快照及环境变量名；Apply 可重复填充新建表单，不启动或修改已有会话，不保存解析后的密钥。 |
| Check local port | 手动 TCP 检查 `localhost`、`127.0.0.1` 或 `::1`，同一次检查共用最多 2 秒预算；不解析 DNS、不发送 HTTP/TLS/模型请求，不进入终端输出服务队列。连通不表示认证或模型可用。 |
| Stop all tasks and quit | 窗口、托盘和 macOS 应用菜单共用原生确认；显示当前任务数量快照，读取失败显示数量不可用。只有确认才停止全部任务，取消不发 shutdown。 |
| Reconnect background | 断连后显式校验原认证客户端并恢复原事件游标，再重挂接可见终端；不创建替代 owner，不重新运行任务。原 owner 已退出时需重新打开 YAM。 |
| 四类关闭/停止操作 | 隐藏标签只隐藏视图；普通关闭 GUI 保留后台任务；Stop session 只停止当前；Stop all tasks 影响执行时的全部后台任务。 |

本轮跨功能回归已覆盖模板保护、显式恢复、保存连接引用、两次续聊继承名称/置顶以及取消全局停止。最新前端全量 **1445 项通过、0 skip**，Node 覆盖率通过现有 lines/branches/functions 的 95/90/95 门槛。Web build、固定身份 macOS 开发包构建及三项已安装 CLI 的本机 fixture 沿用前述 GUI 验收回执；后续修复只涉及 Rust 的测试模块，运行时源码逐字未变。

#### Rust exit 101 后续排查（2026-10-17）

未改源码时，Rust 按仓库 CI 的 `--locked -- --test-threads=2` 单独运行是 707 项通过、6 项既有忽略；与前端测试、覆盖率同时运行时，完整捕获 **705 项通过、2 项失败、6 项忽略，exit 101**。失败为 `d03a_same_client_positive_refusal_and_unknown_outcomes` 和 `a07c2_same_client_command_capability_refusal_unknown_outcomes`，均在测试假服务器读取四字节长度头时返回 errno 35 / `WouldBlock`，随后父测试在 join 处失败。

当前 macOS 探针确认 accepted socket 继承监听器的非阻塞模式；即使设置读超时，无数据的 `read_exact` 也会在约 1 微秒内返回 `WouldBlock`。因此本次复现的根因是测试连接模式，不是三秒预算不足。先增加“请求字节到达前 accepted stream 必须为 blocking、listener 仍为 nonblocking、读预算仍为三秒”的回归，实际红灯为 `O_NONBLOCK=4`；随后在共享的 `#[cfg(test)]` accept 初始化中显式清除此模式，保留原轮询、超时和所有协议断言。

修复后的 **5 项定向测试连续 10 轮通过**；还原原并发条件后 Rust **708 项通过、6 项既有忽略**，同时运行的前端 1445 项与覆盖率均通过；完整 Rust 默认并发配置亦为 **708 项通过、6 项既有忽略**。这两次完整 Rust 都保留原始 stdout/stderr，未通过减小并发或延长超时取得通过。改动模块的格式检查通过；全文件的既有格式差异保留。修复前后 owner PID 和两条运行会话 ID 一致，任务保持运行。

早先只保留哈希的 exit 101 回执无法补回原文，不能逐字证明它与本次两项失败相同。本次完整失败流、堆栈、确定性红灯、绿灯和并发复验记录均已保留于 `rust-exit-101-20261017` 交付目录；本结论只覆盖本次实际复现并修复的问题，不宣称所有稳定性风险归零。Linux/Windows 未运行本次回归。证据入口：[完整失败日志](/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/rust-exit-101-20261017/attempt-02-ci2-concurrent.combined.log)。

本轮原生 GUI 已在用户明确允许后，改用按 GUI PID 定向的 macOS 辅助功能接口补验；原有 CUA 按应用标识读取超时，进程采样强烈支持其误选无窗后台，但没有完整调用追踪，不把这一推断视为严格根因证明。固定 YAM.app 的运行 UUID 与新构建一致，原 owner 和原任务始终保留。验收实际发现模板重置的父窗口 sheet 死锁：先复现、补失败回归，再改用独立的无父窗口原生确认，Cancel、复制原文和明确确认后恢复写入均已在新包复验。测试前的模板原文已精确还原，最后只删除本轮自建模板。

| 本轮桌面清单 | 实际状态 |
|---|---|
| 坏模板 UI 保护与显式重置 | 通过：损坏警告与写保护、复制原文、取消保留、明确重置后可写均实测；原始备份精确恢复。写入失败由自动化覆盖。 |
| 自定义名称连续续聊、置顶和历史归组 | 通过本机 fixture：GUI 中 Codex 连续两次 Continue，名称、置顶、原生 UUID、连接快照和上下文保持。该路径在重置修复前完成；字节比对确认续聊代码未改，当前包三 CLI fixture 再次通过。 |
| 原生继承/API/网关详情显示 | 普通 Shell 缺少元数据时显示 Unknown；受管 API 显示保存的 CLI、模型和本机端点，未验证实际模型/认证/计费/最终上游的说明可见。连接模板保存及两次 Apply 已实测。原生厂商账户不在本次范围。 |
| 本机端口正常/关闭/超时与终端持续输出并行 | 通过：正常、关闭、不支持及真实超时文案可见；约 2 秒超时期间 heartbeat 从 50 增至 59。检查前后模型 POST 计数均为 10，无新增推理请求。 |
| 取消停止、停止当前、确认全局停止 | 当前 GUI 的窗口和 macOS 菜单确认均取消，任务保持；仅 Stop 本轮自建任务后原任务仍运行。原 owner 是旧二进制，未点击其托盘停止入口；确认全局停止会终止用户任务，未执行。 |
| 关闭 GUI、Dock 重开、重复启动和原任务挂接 | 普通 Cmd+Q 后 owner、原任务与自建 heartbeat 持续；固定路径重开恢复相同会话，live 输入标记可见。窗口存在时 Dock 激活及重复启动均复用唯一 GUI。用户允许临时固定后，普通退出至无 GUI，再仅从 Dock 重开为新 GUI，原 owner 与全部运行会话 ID 保持，GUI 数为 1；随后已恢复未固定，其他 Dock 固定项未变。 |
| provider 不回落原生认证、续聊连接不变 | Codex、Claude、Gemini 三项已安装 CLI + 本机 API fixture 保持 UUID/上下文、隔离 key 与官方配置哨兵；GUI Codex 两次续聊亦保持本机连接。未调用真实厂商账户。 |

本轮仍为部分验收：保留原任务约束下，未执行当前版本托盘确认、确认全局停止或主动中断 owner 后的显式 Reconnect；退出后 Dock 重开及临时固定还原已补验。该第一轮回执未覆盖真实厂商账号往返、Windows/Linux 桌面流程及第二轮功能；当前第二轮事实见上节。重置修复定向 35 项、全前端 1445 项、后续 Rust 原并发条件及默认并发配置下各 708 项（6 项既有忽略）、三项 CLI fixture、覆盖率和原生构建均通过；两种模型的独立复核通过，均未将上述缺口记为通过。本轮交付目录中的 `T6-native-gui-observations.json`、`T6-followup-product-delta.json`、`T6-followup-bundle-identity.json` 与 `gui/*.json` 保留实际证据；早期失败和超时记录不删除。

以下历史段落保留其当时源码和独立验收应用的证据边界。

2026-10-10 原生实查辅助功能、屏幕录制权限均可用，并已实际运行独立 R11、R12、R13、R14、R15 验收应用。早期“权限未授权、尚未启动、全部待验收”记录仅代表当时状态，不能作为当前结论。以下六条仍为**部分验证或未验收**，不能汇总为全部通过。自动更新继续暂停。

R11 与修复前 184 项源码集合一致；其前端既有回归为 1342 项通过。真实关闭主窗后，后台 owner 和两个 Shell 保持运行，但 Finder 无法重开窗口。补充 macOS Reopen 路由后，实际行为单测 RED 为 1 项通过、3 项失败，GREEN 为 4 项通过；全 Rust 660 项通过、3 项既有忽略，Sol 独立源码审核通过。

独立 R12 在本次 Reopen 验收时通过对应源码与构建身份检查；该产物不包含后续 header CSS/title 修复，后者已通过标准 Web build 和 Chromium 几何验证，待新原生构建复验。关闭主窗后，Finder 重开产生新 GUI PID 15017，原 owner PID 14305 与 A/B 会话 `s-1a123d2aeb3-1`、`s-1a123d2fe89-2` 保持，`desktop_connected=true`、活跃会话数为 2。CUA 随后误连无窗 owner，尚未完成重开后原会话 live 输入的界面闭环，不能把后台重连证据等同于全部恢复体验通过。

随后仅通过对应 fixture 的正常 authenticated shutdown 清理 R11/R12 owner；11 个原 PID 实查均已消失。这是受控清理，不是 GUI 精确 Stop 验收。界面后来显示保存的 A/B 已停止及 B 的标记输出。

真实 Codex 交互式 CLI 会话 `s-1a123e0eb59-1` 已在临时目录启动，累计付费请求为 0。用户在操作时明确同意“信任这6个YAM Hook并继续验收”后，已对 R12 会话实际执行信任；Hook 总览的 review warning 消失，事件 active 数与 installed 数一致，页脚变为 enter details / esc close。该次记录中 owner PID 19065、`desktop_connected=true`、活跃会话数为 1；launch 为 Codex interactive，额外参数为空、prompt 为 null。证据为 `/tmp/yam-core-acceptance-20261010/agent-hook-followup/trust-20261010T035300Z.json`。信任后短回复、可信事件、通知和 Continue 仍未验收；最近可信状态观测为 `phase=unknown`、`integration=connecting`，系统通知界面显示 disabled。当时 CUA 返回 Mac is locked；后续已实际确认解锁并完成下述 R13 有限原生验收，在该次 R13 验收时锁屏已解除；后续 R14/R15 的解锁后有限观察见下文。R12 仍是此前二进制，本次未对其已有会话执行 Stop。

Agent 页面还暴露了头部布局问题：Git 状态被挤成逐字一列，占去大部分终端空间。已补实际 header JSX 与 CSS 的浏览器几何回归并进行最小修复；该验证属于浏览器布局，修复后原生 WebView 仍待复验。该源码与文档已通过 gpt6.1-sol 独立有限审核；原生复验仍待完成。证据与最短复现记录位于 `/tmp/yam-core-acceptance-20261010`。

用户随后报告终端持续闪烁、无法使用。已在实际 Chromium/xterm 渲染中复现其中的空白中间帧：完整投影先同步 reset、再异步 write 场景，使清空后的 normal buffer 暴露给绘制。最小源码修复将 RIS 与完整场景放入同一次 write；实际浏览器 RED 为 29 次 blank paint，GREEN 为 0，含接近 8 MB 场景、焦点和输入断言。最终全前端 1345/1345 通过、0 skip，标准 TypeScript/Vite build 和 diff check 通过，gpt6.1-sol 独立有限审核 PASS。证据位于 `/tmp/yam-terminal-flicker-20261010`。同尺寸 resize 仅为疑似放大因素，没有持续 loop 证据，本次未修改。用户进一步明确闪烁位于终端/Codex 内容。后续原生有限采样见下文；该证据不构成所有闪烁永久消失或长期稳定性结论。独立 R13 已打包成功（exit 0，21.42 秒），冻结源码未变、隔离 bundle identity 与启动前独立 namespace 检查通过，构建时记录为未启动；后续已首次启动（累计 launches=1）并完成下述有限原生观察。该包仅供开发验收、不可发布；构建与产物依据为 `/tmp/yam-terminal-flicker-20261010/r13-build-result.json` 和 `r13-artifact-receipt.json`。

解锁后首次启动独立 R13，新 namespace 初始历史为空，冻结源码保持不变。普通 Shell A `s-1a12413d329-1` 内持续合成 TUI 在第 67、118 帧截图中固定内容可见，输入 `abc123` 完整；退出标记为 `YAM_R13_TUI_EXIT typed='abc123' frames=136`。退出时出现的 q 随外部 UI 变化被观察到，并非 root 发送。截图采样未见空白，但没有逐帧原生 trace 或长时间稳定性测试。返回 Shell 后 `YAM_R13_INPUT_OK` 标记可见；Cmd+F 搜索退出标记显示 1 of 1 和黄色高亮，关闭后恢复输入焦点。

同一 R13 普通 Shell 内实际启动 bare Codex CLI 0.162.0，无新增 YAM Agent Hook 注入或信任操作；更新提示以 Escape 跳过。未提交文本 `YAM_NATIVE_INPUT_ONLY` 完整可见，Ctrl+U 清除；slash 菜单可见，Down 将选中项从 /model 移到 /fast，未接受菜单设置，Ctrl+C 返回 Shell。累计付费请求仍为 0。这验证了实际 Codex TUI 的有限输入和菜单交互，不验证 YAM Agent 事件、真实回复或 Continue。

R13 普通 Shell 精确停止有限通过：GUI Stop A 后显示 stopped、活跃数为 1，B `s-1a12416a959-2` 仍输出 `YAM_R13_B_STILL_RUNNING`；随后 GUI Stop B 显示 stopped、R13 活跃数归零。未对 R12 已有会话执行 Stop。该结论限于两条普通 Shell，不扩展为所有 Agent Stop 验收通过。原生证据为 `/tmp/yam-terminal-flicker-20261010/native-followup/native-observations.json`；真实付费回复、可信事件、Continue、通知、IME 仍未闭环，系统通知仍显示 disabled。

2026-10-10 用户指出默认界面低频控件过多后，已完成有限 UI 收敛：会话重跑/Continue、重命名、导出、设置、通知与控制权操作进入 **More actions**；原整排分屏/焦点/排列/恢复操作收进 **Layout**，每个 pane 的 **Pane actions** 保留 Move tab；侧栏 **Manage workspace** 汇总筛选、收件箱、快捷键、归档与容量管理，项目的 **Project actions** 汇总编辑、Pin 和排序，键盘路径保留。常用标题、紧凑 Running/Stopped 状态、New terminal、Find 和终端标签常驻；有未读/待关注时仍显示对应入口。有效 Git branch 紧凑显示，运行目录/阶段详情、memory、engine/version/session ID 与诊断导出收入 More 的详情分组。系统通知 disabled 改为菜单内中性说明及 Retry，其他真实错误、owner/move/paste/停止后的输入保护保留；容量文案已改为既有归档恢复入口说明，保留“不自动删除历史”。

本次实际 JSX/CSS Chromium 回归与 Escape handler 测试通过，全前端 **1360/1360、0 skip**，标准 build/diff check 通过；gpt6.1-sol 对冻结六文件与 19 项定向测试独立有限审核 PASS、0 skip。独立开发验收包 **R14** 已构建成功（exit 0），六文件源码冻结一致，产物身份、空 URL schemes、启动前独立 namespace 检查通过；不是可发布产物。早期仅一次 CUA getApp 尝试返回 **Mac is locked**，当时启动状态未知、已验证原生操作为 0（`/tmp/yam-ui-declutter-20261010/r14-native-status.json`）；这是历史快照。用户随后解锁，已完成以下 R14/R15 有限原生复验，锁屏不再是当前阻塞。

R14 普通 Shell 的 `YAM_R14_INPUT_OK` 输出可见；Cmd+F 显示 1 of 2 和黄色高亮，Escape 返回终端输入焦点。More 可滚动至诊断区，Escape 回到 summary；Layout 的 Split down 后第二条 Shell 输出 `YAM_R14_PANE_B_OK`，Pane 2 的 Move tab → To pane 1 后仍输出 `YAM_R14_MOVED_B_OK`。Manage workspace 的修正容量文案可见，当前隔离项目菜单可打开，Escape 回到 summary；两条测试 Shell 经 GUI Stop 后统计为 2 sessions、0 active。此为当前窗口、项目及两 pane 的有限观察，不保证大量项目底部或 16 pane 的所有菜单边界。

R14 同时确认 More 中 Copy terminal output / Clear terminal display 仍继承 `.icon-button.small` 的 28px 尺寸，文字换行重叠。已先补真实 JSX/CSS 的 DOM Range 文字边界回归，RED 精确报告这两项；仅提高菜单上下文选择器优先级后，GREEN 六场景按钮为 166×28、无文字溢出或相邻重叠，业务回调未改。全前端 1360/1360、0 skip，标准 build/diff check 通过；gpt6.1-sol 独立有限审核及 1 项实际浏览器测试（六场景、0 skip）PASS。

独立 developer-only **R15** 构建 exit 0，冻结源码、六项产物及隔离身份检查通过。原生 More 的上述文字与图标已完整显示、无重叠；Terminal settings 能打开，字体及字号输入/预设可见，Escape 关闭设置，再点 More summary 收起菜单，返回终端后 `YAM_R15_AFTER_MENU_OK` 输出可见。R15 会话 `s-1a1245149ea-1` 首次 AX 点击 Stop 没有可观察状态变化，仍为 active；重试同一可见 Stop 后显示 Stopped，Manage workspace 为 1 session、0 active，不能记作首次点击通过。

本次未操作既有 R12/R13，累计付费请求为 0。终端启动输出“❌终端代理已关闭”已核实来自 `/Users/liuwenyuan/.zshrc:46`，不是 YAM 应用错误，未修改 Shell 配置。原生证据为 `/tmp/yam-ui-declutter-native-20261010/r14-native-observations.json` 与 `r15-native-observations.json`。验证限于当前窗口/项目、R14 两 pane 与 R15 单 pane；大量项目底部/16 pane 几何、完整 Agent 对话、Continue、系统通知、IME 和持续高输出仍未验收。此前 R13 有限事实保留，六核心流程不汇总为全通过，自动更新继续暂停。

历史验收应用：[YAM R11](</Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri/target/debug/bundle/macos/YAM R11 26b3db93899a5a58be4bdb93abd74618.app>)。R12 使用独立构建，不能以旧 R11 或普通 YAM 会话代替。隔离项目为 `/private/tmp/yam-core-project-20261010-biU5v8`；Agent 也仅使用临时目录。

## 1. 从项目启动 Agent

添加隔离项目，选择该目录，打开 **New Agent / command**，选择已安装且可用的 Agent。确认启动设置，再显式点击一次 Start，将这个真实 Agent 会话记为 C。当前已实际启动 Codex interactive CLI，并在用户操作时明确同意后信任 6 项 YAM Hook；登录、可信事件和完整任务往返仍未确认。后续已解锁，并在 R13 普通 Shell 启动 bare Codex 完成有限输入/菜单观察；该次未注入新 Hook，不替代项目启动 Agent 的完整验收。

实际 Agent 请求可能消耗套餐额度，须由用户选择并明确发送；当前仅启动 CLI，付费请求数为 0。可以先用两个普通终端验证目录和输入通路，但这不能算 Agent 启动验收通过。

通过标准：项目和目录正确，一次操作只创建一个会话，实际 CLI 可用；启动失败有可理解的界面提示，不向其他终端输出错误。结果未知时暂停新启动，不自动重试。

## 2. 并行管理与切换

通过 **New terminal** 在临时目录创建 A、B 两个普通 Shell 终端。下面的 `printf`、`pwd` 和粘贴命令只输入 A/B，不输入真实 Agent C。分别输入无副作用的标记，例如 `printf 'A_READY\n'; pwd` 和 `printf 'B_READY\n'; pwd`。切换 A→B→A，再通过 **Layout** 菜单中的分屏控制并排显示；需要移动现有标签时，打开对应 **Pane actions** 菜单中的 Move tab。分别输入不同标记，检查输入与输出归属。A/B 验证的是终端通路，不能替代 C 的 Agent 体验验收。

用标签的 × 隐藏一个视图，再通过 **Layout → Reopen last hidden tab** 恢复。× 的含义是 Hide tab，源码设计为保留会话，不是 Stop。

通过标准：切换、分屏和隐藏恢复不重复启动进程、不串输入、不丢失原查看位置；恢复的是原会话。项目排序不改变会话或进程。

## 3. 可信状态与通知

仅对具备真实事件来源的 Agent C 测试一轮等待用户或完成事件。选中普通终端 B 时观察 C 的状态与收件箱，通过关注项跳回 C；系统通知获授权时，再单独验证通知送达和点击定位。

通过标准：状态与操作指向正确会话，缺少事件时显示未知或未上报，不从终端文字推断完成。普通 Shell 的命令状态不是可信 Agent 状态。操作系统通知权限不足时，系统通知项记为未验收，不记为通过。

## 4. 恢复与历史输出

先记录 A、B 的标题、目录、标记及可见会话身份。保持任务运行，关闭当前独立验收应用主窗口，再打开同一份应用，检查是否重新附着原会话、是否保留历史输出、是否发生重复启动。

主窗口关闭与标签隐藏是不同动作：已观察到 GUI 退出而 owner 与两个 Shell 存活；R12 的 Finder 重开及后台重连已有证据，原会话重连后的界面输入仍待补验。不要用 Cmd+W 代替这一步；也不要点 **Stop all tasks and quit YAM**，该操作会停止附着 owner 的全部任务。

在 **More actions** 中选择 **Continue**，另行使用真实 Agent C，只用于支持的、已结束且拥有核实原生身份的交互式 Codex/Claude 对话，不能对普通 Shell A/B 验证。没有可用身份时记为不支持或未验收；**Run again** 是显式创建新任务，不是恢复原进程，也不是通用 checkpoint。

通过标准：仍存在的会话恢复原身份，不自动重跑命令；已退出任务不伪装存活；历史保留范围与截断信息可理解。恢复失败可见，损坏数据不被静默覆盖。

## 5. 输入、复制粘贴、搜索与滚动

在 A 测试英文输入、实际中文输入法、退格及左右键。粘贴两行无副作用的 `printf` 命令，先取消预览，再显式确认；根据 Shell 状态显式按回车，检查文本和输出只出现一次。

产生约 200 行带编号的普通输出，回看旧内容，再产生新输出。检查回看位置、新输出提示和 **Return to live**。用 Cmd+F 查找一个标记，检查高亮、上一/下一、大小写和非法正则提示；关闭查找后继续输入。复制输出及清屏入口位于 **More actions**；测试复制选区与清屏，切换标签后检查旧内容是否错误恢复。

通过标准：输入不丢失、不重复、不发往其他会话；取消粘贴不发送内容；回看不被强制拉到底部；搜索与复制可用；清屏不停止进程、不删除日志。实际输入法和 Agent TUI 必须单独观察，不能由程序注入 Unicode 或普通 Shell 测试代替。

## 6. 精确停止

A、B 均保持运行。选中 A，点击一次 **Stop session**，切换到 B，输入 `printf 'B_AFTER_STOP\n'`。返回 A，检查真实结束状态。

通过标准：只有 A 停止，B 仍可输入与输出；A 的迟到失败提示不覆盖 B。不能仅凭停止请求 ACK 认为进程已退出；安全拒绝或结果未知须如实记录，不用强杀代替成功。

## 记录与收口

| 流程 | 当前桌面结果 | 需要记录 |
|---|---|---|
| 项目启动 Agent | 部分验证：Codex CLI 已启动，用户同意后已信任 6 项 Hook | 临时目录、interactive、0 付费请求；完整任务往返未验 |
| 并行管理 | R11 普通 Shell 切换、分屏、隐藏恢复及 R14 两 pane 有限观察 | R14 Layout Split down、Pane 2 Move tab 到 pane 1 后输入输出可见；真实多 Agent 并行及 16 pane 未验 |
| 状态与通知 | 未验收 | 最近 Codex 状态 unknown/connecting；系统通知 disabled；已按用户同意操作 Hook 信任，事件/通知未验 |
| 恢复 | 部分验证 | R11 原生失败；修复后 R12 新 GUI、原 owner/会话保持、后台重连；界面 live 输入未闭环 |
| 终端交互 | 部分验证 | 标记查找黄色高亮、非法正则提示；两行粘贴取消/确认且各输出一次；200 行回看、新输出提示和 Return to live 已观察；IME、复制选区、clear 未验；空白帧源码修复后 R13 合成 TUI 截图未见空白、abc123 完整；实际 bare Codex 未提交文本/清除/菜单 Down 移动通过；非逐帧或长期稳定性验收 |
| 精确停止 | R13 两条普通 Shell 有限通过 | GUI Stop A 后 B 标记继续输出、活跃数 1；再 GUI Stop B 后活跃数 0；本轮 R14 两 Shell 最终 0 active，R15 首次 Stop 无变化、重试后 0 active；既有 R12/R13 本轮未操作，所有 Agent 的停止行为仍未验收 |

每项只填写实际通过、实际失败、未验收或不支持。失败记录最短复现步骤、原会话与可见现象，不收集密钥、认证信息或完整私密输出。复现后先补回归测试，再最小修复并重验受影响流程，最后由独立模型复审。

完整远程平台、浏览器自动化、通用插件、移动端与 Cloud 不属于本轮。吞吐数据只用于定位实际交互阻塞，1 MiB/s 不是独立完成门槛。
