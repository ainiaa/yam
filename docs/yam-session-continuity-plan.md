# YAM 会话连续性与 Agent 扩展实施计划

作者：Jeff.Liu。日期：2026-10-01。

代码基线：`d94f2718dbaf3c5d1ef760218eca2ad80dc02c15`，开始时工作区干净。

## 需求与状态

本次新增范围取代上一阶段“不提供退出后继续运行”的边界：

1. OpenCode 的可靠轮次、权限和异常通知；为其他有明确原生事件的 CLI 保留会话限定的接入契约。
2. 会话日志内容搜索和导出。
3. 桌面主进程退出后，已启动的任务继续运行；重新打开连接同一进程。
4. 重新打开后恢复终端/TUI 当前现场。
5. 包含 WebKit 子进程的内存测量。
6. 上轮已确认的 Claude 原生续聊。

起草时这些均为待实现；当前进度以文末执行记录为准，不能将设计文字当作测试证明。Windows/Linux 系统通知点击与唤醒继续暂缓；这不等于放弃后台生命周期、PTY 或恢复功能的跨平台实现。不得把 macOS 实测结果推广为其他平台桌面验收。

基线依据：`resume_source` / `resume_command` 只接受默认 Codex 交互会话；`SessionManager::shutdown` 主动停止任务；`openHistory` 只使用有限日志重放；不存在完整终端快照依赖；本机未发现 OpenCode 可执行文件。

## 设计与选择

### 后台运行

推荐复用现有 Rust/portable-pty，把会话持有职责移到按需启动的 YAM 后台进程。桌面界面作为连接者，通过本机认证接口发送输入、调整尺寸、读取输出、停止任务和订阅状态。复用现有身份、轮次、通知回执和历史模型；界面与后台不得分别写同一历史文件。

后台仅在需要会话时启动，不添加开机服务、全局 Hook 或系统级守护配置。退出界面不杀任务；提供独立的“停止全部任务并退出”动作。初次上线向用户明确说明新的退出行为。操作系统重启、注销、后台进程崩溃不是“界面退出”；这时记录中断，禁止自动重跑任务。

认证凭据仅限当前用户，接口大小、连接数、请求时限均有界；无未认证的命令执行、任意路径读取或任意 PID 终止入口。重连需要同时核验后台实例身份和会话身份，不能只凭 PID 判断进程归属。两个界面同时连接时，仅当前输入拥有者可写；接管要明确，重试不能重复启动任务。

其他路线：只隐藏窗口可节省改动，但主进程仍存活，不满足本次“退出”；改用 tmux 或替换 PTY 库增加外部依赖与平台差异，不作为首选。

### 终端/TUI 恢复

复用同一版本 xterm 的状态语义。先隔离验证官方 `@xterm/headless` 和 `@xterm/addon-serialize`，候选方案是在后台维护终端解析状态，输出带序号的快照与增量，界面先在原尺寸恢复再调整尺寸。若需 Node sidecar，必须验证可打包的运行时与后台总成本，不要求最终用户预装开发用 Node。

此候选尚未冻结成正式架构。插件是实验性实现，正常屏幕、交替屏幕、光标、颜色、模式、滚动位置、中文/emoji、软换行、缩放、跨块 UTF-8 和未完成控制序列必须逐项对照。序列化未覆盖的状态不得静默丢失，不能为通过测试改成“日志恢复”。若候选不满足这些要求，保留失败证据，重新评估成熟终端内核；不自写完整 ANSI 解析器。

“完整”指已声明支持的终端状态及当前配置的滚动历史，不指无限滚动历史，也不包含恢复已经死亡的 Agent 进程。界面关闭期间后台仍需解析输出，因此仅在关闭前保存一次快照不合格。快照必须绑定会话、后台实例、终端版本、尺寸及输出序号，快照与后续输出之间不能丢字或重复。损坏、版本不兼容、磁盘空间不足要明确报错，保留原数据，不冒充恢复成功。

### 日志搜索与导出

搜索已由 YAM 记录的终端输出，按会话或全部会话检索；结果包含会话标题、目录、匹配片段和位置，点击打开对应日志位置。与侧栏会话名称搜索分开。首版使用普通文本、大小写开关和分页；不增加搜索引擎、正则表达式或数据库。

搜索视图将控制序列转换为安全文本，不执行 OSC 链接或输出中的 HTML。日志是输出记录，不宣称还原所有键盘输入或 Agent 内部思考。动态 TUI 重绘日志可能包含多次输出，明确其记录语义。

导出选择一个会话，默认 UTF-8 纯文本，也可明确选择原始终端输出；保留会话标题、目录、起止时间和结果等元数据。通过已有 dialog 原生保存位置，不静默覆盖文件；取消不产生文件，写入失败保留现有目标。用户选择导出时说明记录可能含敏感内容，不声称自动脱敏。仅按已有会话 ID 访问日志，不允许前端提供任意源路径。

扫描不在 UI 线程运行；单次查询限制输入长度、结果数和读取预算，支持取消/失效查询，报告部分结果与不可读文件。检索范围只包含实际保留日志；被预算淘汰的内容不能搜索或导出，界面明确说明。

### Claude 原生续聊

用户主动选择已停止、有可信 Claude 会话 ID 的记录，使用原生 `--resume` 启动新进程，清除旧启动提示词；绝不使用 `--continue` 猜测最近会话。验证 CLI 能力、原目录、会话记录与身份；失效 ID、跨目录和重复恢复要拒绝，不能自动降级为新对话。

只有能验证恢复语义的启动配置提供入口；已测安全参数是否可以原样恢复由测试决定，不能一概丢弃模型参数。自定义 shell 命令和改变配置源的参数不猜测恢复。后台仍运行的会话使用“重新连接”，不再启动原生 resume。

### OpenCode 与其他 CLI

优先通过 OpenCode 原生事件接入，比较会话限定本地插件与认证服务事件流；以真实安装版本支持的事件和 session/message/request ID 为准。只在 YAM 启动的进程注入，不修改全局或项目配置，不占用固定端口，不修改模型/provider/审批策略。

绑定主会话及可信轮次边界，区分用户等待权限、回复结束、错误和子会话。`session.idle` 必须与当前用户轮次关联，启动空闲或子 Agent 空闲不能发主会话完成通知。重复/乱序/断连不能污染下一轮；重连需读取可信现状，不能凭静默判断成功。保留已有用户插件和 Hook。

新增 Agent 的有限首个交付对象为 OpenCode，现有 Codex/Claude 保持回归。其他 CLI 可通过文档化、会话限定的事件入口接入，但只有执行真实验证后才加入支持矩阵；不承诺任意 CLI 自动拥有准确轮次通知，也不建立通用插件市场。

### WebKit 内存测量

统计 YAM 桌面、实际归属的 WebContent/Networking/GPU、后台和终端 sidecar；Agent/模型进程单独列示。不能仅按 PPID 找 WebKit，因为 XPC 进程可能由系统持有；也不能把其他应用的 WebKit 加进 YAM。

先验证本机 `footprint` 与进程归属查询可用性。物理 footprint、RSS 分别标注，不能相加成一个指标。共享或无法确定归属的进程单列，报告范围不完整；权限不足保留缺口，不自动申请管理员权限。

固定夹具测空闲、1/4/16 会话、快速切换、30 分钟固定输出、停止会话后和退出界面后；记录硬件、OS、构建方式、终端尺寸、滚动预算、PID/归属依据及采样时间。每次只输出统计值，不采集其他进程的命令参数或环境。比较改造前后同样场景，依据测量决定预算；此项不能直接证明超过 cmux。

## 执行顺序与退出条件

每一步先补失败测试，再最小实现；完成回归、范围复审并记录证据后才进入依赖步骤。当前会话顺序执行，不并发修改共享文件。

| 步骤 | 交付 | 关键路径 | 必须通过的验收 |
|---|---|---|---|
| P0 | 内存采样工具与现有版本基线 | `scripts/`、测量报告 | PID 复用/进程退出/归属不明/拒绝访问测试；实际包含 WebKit 的采样及 30 分钟场景，未确定归属不得写全量通过 |
| P1 | 日志内容搜索 | Rust 日志访问、App、测试 | 中文/大小写/空查询/跨会话/ANSI/大日志/读取错误/取消；结果定位正确，不抢终端焦点 |
| P2 | 日志导出 | Rust 日志访问、dialog、App、测试 | 纯文本/原始格式/元数据/Unicode/取消/覆盖确认/磁盘故障/非法源 ID；原目标不被失败写入破坏 |
| P3 | Claude 原生续聊 | `lib.rs`、`agent_bridge.rs`、App、测试 | 两轮真实对话退出后恢复原上下文；失效/错目录/重复/参数安全测试；原有 Codex resume 回归 |
| P4 | OpenCode 轮次通知 | Agent 桥接/状态、启动 UI、测试和烟测脚本 | 真实两轮、权限等待及恢复、错误、中断、子会话、并发、乱序/重放、断连；用户配置保持 |
| P5 | 终端状态技术验证 | 隔离终端夹具 | 快照前后状态逐项等价；后台持续输出、拆分控制序列、损坏快照测试；确定正式依赖和打包方案 |
| P6 | 后台会话与重连 | 会话核心、后台入口、认证客户端、历史和打包 | 主进程真实退出后任务 PID/PTY 继续；重开同一会话；无重复启动；双界面、异常退出、停止及跨平台进程测试 |
| P7 | 冷启动终端/TUI 恢复 | P5 选定内核、P6 序号协议、终端视图 | 无界面期间持续输出后重开恢复现场；输入/鼠标模式和缩放正常；快照与增量竞争无缺字/重复；正常屏幕/交替屏幕/Unicode实测 |
| P8 | 联合验收与内存复测 | 测试、CI、执行记录与用户文档 | P0 相同负载复测；三个 Agent + 后台退出重连 + 搜索导出联合流程；三平台构建和进程测试；如实保留未实测桌面项 |

P1→P2，P5→P6→P7，全部已交付步骤→P8。P0 必须先执行；后台改造前获得现有版本资源基线。独立步骤仍按表顺序执行，P5 未通过不能交付 P7。

常规验证沿用现有入口：

```sh
rtk pnpm -C apps/desktop test
rtk pnpm -C apps/desktop test:coverage
rtk pnpm -C apps/desktop build
rtk cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
rtk cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
rtk cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
rtk python3 -m unittest discover -s scripts -p 'test_*.py'
```

每个新步骤再绑定对应新测试与真实烟测命令，P5 后才冻结后台/恢复实现细节与验收夹具。上述命令列表不是执行结果。既有 Converge coverage/图谱正式回执缺口继续如实记录，不改门槛或自动重建索引。

## 需要确认的具体变更

用户已授权上述功能和先计划再实施。正式新增依赖仍遵循全局 AGENTS.md：

- 允许在隔离验证目录使用 `@xterm/headless`、`@xterm/addon-serialize` 并验证打包运行时；不立即引入正式产品依赖。
- 允许在隔离验证目录安装 OpenCode CLI，复用现有 provider 配置进行真实烟测；不改全局默认 CLI、模型、权限或 Hook。
- 审阅本文中的后台进程方案。终端候选通过 P5 后，按测量结果提供精确正式依赖清单，未授权的依赖不提前写入产品清单。

外部 CLI 信任、系统权限、证书、发布均不由功能授权自动获得；确实出现相关门禁时再针对实际事项处理。当前不请求新的通知点击权限，不合并、不发布。

## 参考与证据边界

- [OpenCode 原生事件](https://opencode.ai/docs/plugins/)：session/permission/message 事件；其示例空闲通知不等于 YAM 完整轮次关联实现。
- [OpenCode 服务](https://opencode.ai/docs/server/)：认证、事件流、TUI/服务关系；具体启动方式仍需本机实测。
- [xterm 官方序列化说明](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/README.md)：明确为实验性插件。
- [序列化接口](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/typings/addon-serialize.d.ts)：尺寸、光标、模式及交替屏幕选项；不证明全部内部解析状态可保存。
- [Claude CLI](https://code.claude.com/docs/en/cli-reference)：原生 `--resume`；具体安装版本还需真实恢复验证。

截至本文写入：完成源码定位、官方资料核对和本机工具发现；未实现六项新功能、未完成内存采样或真实 OpenCode 运行。由于依赖/新后台设计尚待确认，本文是可审阅计划草案，不伪造已决字段或生成已通过的执行回执。

## 执行记录：2026-10-01

用户已批准后台设计与隔离依赖验证。Plan v6 已校验通过，当前顺序执行。正式产品依赖仍未修改。

P0 的采样工具和基础基线已通过；12 个 Python 测试（含 6 个新增边界测试）通过。空闲、1/4/16 会话基础采样均取得明确 coalition 归属与物理 footprint。30 分钟持续输出在旧安装包中采样，长测结论仍待汇总。为避免无意义串行等待，该长测与源码实现独立，归入 P8 最终验收；P1 只依赖已完成的工具及基础基线，不依赖尚未得出的长期趋势。

Converge preflight 仍报 coverage 未配置；项目实际 Node coverage 命令不降低阈值。正式工具回执缺口保留，不阻止已授权功能的可执行测试与实现。

P0 长测已完成：347 次完整样本、16 个持续输出任务、约 1800 秒；5–10 分钟均值 462.47 MiB，最后 5 分钟 461.72 MiB。停止后 13 次完整样本 Agent 数均为 0，末次 447.63 MiB；停止终端仍留缓存，不能把稳定趋势当作无泄漏证明。详见 yam-memory-baseline.md。

P1/P2 已实现并通过 110 个 Rust 测试、62 个 Node 测试及覆盖率门槛，前端构建通过。新增用例先失败后修复，涵盖 Unicode、控制序列、分页、取消、扫描预算、读取失败、过期位置和中断写入。原生隔离包已验证中文/emoji 搜索、50+11 条分页、隐含 OSC 链接不入搜索、定位保留焦点、纯文本/原始导出与取消无文件；导出文件内容断言通过。搜索打开的输入焦点已修复，仍需重建包验证；全部会话/大小写的原生操作仍待补齐。本条为阶段证据，不宣称全部计划完成。

P1/P2 最后原生补验：重建后打开搜索直接输入 needle 生效；全会话 Match case 为 1 条、关闭为 50 条第一页，取消导出无文件。Clippy -D warnings 通过。P1/P2 阶段关闭，进入 P3。

P3 已补 Claude --resume 的安全参数、可信 YAM ID、原目录主会话元数据核验，保留 Codex 原路径；112 个 Rust 测试与 62 个 Node 测试通过。真实双轮会话 1557f493-abe6-45dd-ba69-a727c7adf7f6 回复 READY / YAM_CONTINUITY_7Q9，原 YAM 进程 s-1a0f82b62c9-0 停止后，Continue 新建 s-1a0f832b647-1 并连接同一原生 ID；恢复后提问仍待回复验收。没有新增 CLI 信任、依赖或关闭全局 Hook。

P5 隔离早期探针（等待外部 CLI 回复期间执行）：scripts/terminal-state-probe.mjs 默认模式 2/8 通过，CSI 半序列、分块 UTF-8、制表位、滚动区域、保存光标、字符集失败，不能独立用于完整状态迁移。候选 --projection 模式由同一个后台解析器继续持有这些状态，前端只接收渲染快照，8/8 通过；这仅是技术可行性证据，尚未测试性能、完整模式范围、视口与打包，因此不冻结正式后台方案。

P3 真实验收关闭：恢复后第三条助手回复再次为 YAM_CONTINUITY_7Q9，原生 ID 保持 1557f493-abe6-45dd-ba69-a727c7adf7f6；历史中恢复 launch.prompt 为 null，文本断言为 READY / token / token 三条。测试会话均已停止，隔离应用退出，没有新增持久信任或权限。

P4 已实现会话限定 OpenCode 插件、原生主会话/message ID 关联、权限/异常/中断事件与有限 ACK 重试，未添加正式依赖。真实首轮发现 Bun 半关闭导致空 ACK，新增 Rust keep-open 失败测试后改为显式换行帧，保留旧 EOF 客户端兼容；116 个 Rust 测试通过。scripts/opencode-round-smoke.py 在认证本机 OpenCode 服务运行两轮，5 个事件（SessionStart、两轮提交/完成）正确关联且无重复。本机无 OpenCode 凭据，隔离公开夹具使用官方当前列为免费的 space-bunny-free；未读取 YAM 代码或发送用户文件。原生 YAM 重建复验仍待完成，权限、错误、中断和子会话真实验收仍待执行。

P5 渲染投影扩展至 15 个案例通过（尚非完整验收）。为补充官方插件遗漏，验证原生滚动范围/鼠标编码/光标可见与形状的受控状态；使用内部只读字段，须固定 xterm 版本并加运行时契约检查，不宣称公共稳定 API。16 个后台解析器、100x40、2000 行预算、1600 行/秒的 10 秒探针：进程 RSS 约 141→224 MiB，13.16% 单核，当前可见终端全量序列化 p95 15.76ms、约 2MB/s；不包含 WebKit 渲染成本，不能当作最终 UI 性能验收。


执行补证（2026-10-02）：OpenCode 原生 YAM 会话 s-1a0f85c2bbb-0 两轮主会话 ses_f07a3c4efffeBPEJPqFP2SeD1E，两个独立 msg ID、两个 TurnComplete inbox 回执、状态 response_finished；停止测试后 status=stopped。桌面通知因前台抑制为 suppressed，不冒充已发送系统通知。补失败 ACK 回归先失败后修复：插件保留待提交原生事件，按序重放并在后台有限退避重试；真实认证服务双轮复测 5 事件通过。66 个 Node 测试、覆盖率门槛及 Clippy 通过。P4 权限/异常/子会话等实际 CLI 验收尚未关闭。

P5 打包候选：官方 Node 26.10.0 Darwin ARM64 的下载 SHA256 与官方清单一致，--build-sea 生成自包含程序，临时 ad-hoc 签名后在 PATH=/usr/bin:/bin 下解析中文、emoji 和拆分 CSI 成功。动态依赖只含 4 个系统库，不含 Homebrew；文件大小 145451648 字节（约 138.7 MiB），这是明确体积成本。scripts/terminal-sea-probe.py 可重复运行这一检查；不等于正式 Developer ID 签名或三平台打包已验收。

P5 投影探针新增窄/宽尺寸、退出交替屏幕、组合滚动区右边界和视口，21 个案例通过。组合右边界测试先失败：CUP 把 pending-wrap 光标列夹紧，需在经过版本/边界检查的投影元数据中恢复 cursorX；不修改后台解析状态。隔离原生 WKWebView 已验证前 20 个案例与真正 @xterm/xterm 前端逐格/模式等价，屏幕尺寸非零，解析 0–7ms（小夹具，不能替代负载验收）；视口新案例仍待加入 WebKit 对照。完整原生输入/鼠标、损坏帧、加载负载、三平台和 P6/P7 仍待完成，不能宣称最终恢复功能完成。

正式依赖候选可审阅清单：固定 @xterm/xterm=6.0.0（现有依赖版本收紧），新增 @xterm/headless=6.0.0、@xterm/addon-serialize=0.14.0；构建时按平台/架构固定官方 Node 26.10.0 并校验 SHA256，打包单个 SEA 终端程序。保留 MIT 授权文件；终端程序只作为后台解析器，不运行用户 JavaScript，也不要求用户安装 Node。Node SEA 是实验性接口，因此固定构建版本和协议、编译后真实烟测，失败不得降级为日志恢复。正式产品依赖目前仍未改；用户确认后才能实施清单。若打包体积或最终 WebKit 负载验收不达标，保留证据再调整方案，不能偷偷引入其他内核。

用户于 2026-10-02 明确批准上述正式依赖与 Node 26.10.0 打包候选；pnpm 精确新增 headless/serialize 并固定前端 xterm=6.0.0，lock 已更新。scripts/terminal-webkit-probe.py 将原生对照变成可重复检查，含视口的 21 个案例全部通过，100x40 负载及 P6/P7 集成验收仍待完成。

2026-10-02 最新兼容决定：用户先要求保留旧系统支持，随后明确改为“macos最低版本修改为13.5吧。继续”。以最新决定为准，最低版本配置改为 13.5，继续已批准的 xterm 6.0.0 / serialize 0.14.0 / Node 26.10.0 方案；旧系统内核重新评估不再是当前执行分支。此前 Node 隔离打包结果仍有效，但正式后台打包、退出恢复和完整联合验收仍未完成。

P4 扩展真实烟测 13 事件通过：两个完成轮次、权限等待/拒绝后工具恢复与中断、无效模型失败、主动 abort、真实 child session 回复不污染主会话。补红灯发现两处根因并修复：assistant.error 中的 MessageAbortedError 也必须映射 Interrupt；权限拒绝后的原生 idle + tool-calls 已结束且无最终回复，不能一直显示 working，应记中断。没有永久权限授予或用户文件访问，读取夹具请求均拒绝。正在补双进程并发及有界队列检查；P4 最终收口仍以这些证据为准。

P5 私有管道终端服务 terminal-service.cjs 已实现，69 个 Node 测试/门槛通过；服务保留同一解析器，拆分字符/控制序列和查询回复测试通过，非法尺寸/源/未知字段/不存在会话不修改有效状态。依据 16x100x40/2000 行探针暂设总 4000000 单元预算，超限明确拒绝新建/缩放，不偷偷改变旧尺寸。新增打包器锁定 6 个官方架构 SHA256；下载失败/校验失败/超预算不发布部分文件，另一 writer 的临时文件也保留（先失败后修复，4 Python 用例通过）。正式打包尚未成功：npm 包许可证文件名需补核对；不把候选原型签名结果当作正式服务已打包。

P5 正式终端服务 SEA 已打包成功：官方 Node 26.10.0 / Darwin ARM64、固定 SHA256，自包含程序 145451648 字节，真实 create→Unicode write→snapshot 私有协议在无开发 Node PATH 下通过。上游 xterm 6.0.0 MIT 许可证因 npm 包未附原文件，保留在 terminal-licenses/XTERM-LICENSE，构建汇入第三方声明，Node LICENSE 一并打包。Tauri beforeDev/beforeBuild 和 CI 已接入固定 runtime 构建；Windows 使用完整资源数组覆盖，防止默认 Unix 文件混入。三平台实际 CI 尚待 P8。

P4 双进程并发双轮均通过，两个不同 ses ID、各 5 事件。断连突发测试另发现接收发送链共用导致过长积压，先失败后将原生状态处理与发送 drain 分离，保留最多 128 原生事件，超限 fail closed 并提交 IntegrationUnavailable；新 Rust 测试证明不清空未读回执、旧轮次不能污染新轮次。当前 70 Node 测试、16 Python 测试及 Clippy 通过，完整 Rust 与最新真实扩展回归正在执行。

P5 macOS 包验证已完成：Info.plist 的 LSMinimumSystemVersion=13.5，实际内嵌终端程序与第三方许可证齐全；无开发 Node PATH 下内嵌程序 create/snapshot 通过，sidecar 的 ad-hoc 签名校验通过。调试包约 176 MiB，不能将调试体积当作正式发布体积。Windows/Linux 实际打包仍待 P8。

P6 基础后台入口已实现：同一可执行文件 --yam-background 使用零 WebView 的独立进程，复用现有 SessionManager/portable-pty/HistoryStore；认证连接绑定随机后台实例、客户端与请求 ID。限定 IPv4 loopback、8 个连接、1 MiB 请求/16 MiB 响应，读取预算按绝对时间计算，凭据和文件仅当前用户可读；Unix 锁/FIFO/符号链接边界已有测试，Windows 使用独占文件锁与受保护 DACL，仍待平台运行。只接受已列明会话命令及其参数，不提供任意路径/PID 操作。桌面旧路径也持有同一历史所有权锁，防止过渡期双写；尚未将桌面会话转接到后台。

P6 原生基础烟测 scripts/background-smoke.py 在隔离 com.yam.background-validation 包通过：客户端 socket 断开后任务 PID/PTY 保持，同一会话只一条历史；第二个后台被拒绝；明确停止与关闭成功。强制结束后台后重新打开标记 needs_attention、原任务不再运行且没有自动重跑。新增中断复测先暴露 AppKit crash-history 恢复确认框堵塞无窗口启动，经 /usr/bin/sample 定位；后台启动前只在当前进程的 NSArgumentDomain 关闭窗口恢复，测试确认未更改持久偏好，也未删除系统恢复数据。修复后的真实强制退出/重开烟测通过，最新基础样本 s-1a0f8bd042f-0。此脚本明确不覆盖桌面主进程退出重开，不能据此关闭 P6。

当前源码 127 个 Rust、70 个 Node 和 16 个 Python 测试通过；Node 已配置工具类范围覆盖率 100% 行/99.06% 分支/100% 函数，不代表 React 或后台 Rust 全量覆盖。P6 仍待桌面 RPC 转接、输入所有权/接管、幂等启动、事件重连、后台通知与闲置生命周期；P7 现场恢复和 P8 新架构内存/联合/跨平台验收未完成。正式 Converge coverage/Review v3 回执缺口仍为 uncovered，不以普通测试结果冒充正式回执。

P6 幂等启动补验：后台按客户端/request ID 保留原参数与启动结果；同键同参数返回原会话，同键不同参数拒绝，失败结果也不重复执行。启动响应丢失后客户端仅对 create_session 使用同一 wire 身份重连一次，输入/其他副作用不自动重试。回执保留上限为每后台生命周期 256 次启动、16 MiB 预留预算，达到上限拒绝新启动而不淘汰去重记录；这是一项明确上限，非无限后台会话承诺。参数形状和 launch 字段在去重前检查，避免保留不受控嵌套对象。先失败后修复的测试及原生重复启动烟测通过，最新样本 s-1a0f8c801eb-0；130 个 Rust 测试、Clippy 和原生打包通过。P6 的幂等启动子项完成，其他桌面转接/输入接管/通知/闲置生命周期仍待实施，P6 整体保持进行中。

P6 响应预算边界补验：已认证的过大响应必须返回明确预算错误，不能以断连伪装成后台失联；先失败的回归已修复。最新完整 Rust 131 项、Clippy -D warnings、fmt、diff 检查和原生打包通过；正常后台烟测重新执行通过。桌面仍使用原会话路径，不能将后台协议基础验收写成“桌面退出后继续运行”已交付。


P6/P7 集成补证（2026-10-02）：桌面已转接独立后台，后台独占历史与 PTY，并持有打包后的持久解析器；桌面通过认证 RPC 和有限事件中继读写，事件缺口重新取场景。后台实例更换或解析器崩溃不会静默重跑任务。输入租约按客户端心跳维持、3 秒失联后释放，已补显式 Take control 命令/入口；接管仅作用于当前活跃终端，旧客户端输入被拒绝。GUI 普通退出保留后台，Stop all tasks and quit 明确停止任务后退出；空闲且无活跃任务 60 秒后结束后台。响应预算改为 64 MiB，覆盖 8 MiB 控制字符日志的 JSON 转义膨胀，仍为有限预算。

P7 真实后台双轮查询验收通过：隔离桌面 SIGTERM 退出后，两轮 CSI 光标查询各收到唯一正确应答，后台与任务 PID 未变；重开桌面复用同一后台，不重复启动会话。任务结束后保存备用屏幕、中文与元数据，整个后台重启后保存投影逐项相等，历史维持 stopped/无活跃任务。scripts/background-smoke.py --desktop 样本 s-1a0f911cfb3-0 通过，包括 frozen_scene_after_owner_restart。该脚本没有模拟原生键盘、鼠标或窗口缩放，不用其结果冒充这些验收。

原生窗口已实际显示保存的 ALT 中/YAM_QUERY_2=PASSED 备用屏幕，输入禁用提示正确。验收另外发现并修复两个后台问题：8 个连接工作线程满载时原先直接拒绝下一连接，改为不 accept、等待已有线程释放（OS backlog 有限，保留既有请求超时）；新增第九连接回归先失败后通过。关闭后台必须在写出成功关闭回执之后再触发主循环退出，避免桌面等待不存在的响应；新增成功/失败关闭回执测试通过。连接错误现在标明具体命令。修复打包后的原生窗口自动恢复上次 stopped 会话且未显示启动连接错误。

最新 145 个 Rust、75 个 Node（工具类行 100%/分支 99.20%/函数 100%）、16 个 Python 测试、Clippy -D warnings、前端构建和 diff 检查通过。Take control 源码晚于上述原生打包，仍需重建原生复验。Mac 在键盘/鼠标验收中再次自动锁定，已请求解锁，未自动改系统锁屏设置。P6/P7 整体仍在进行中：原生实时输入/刷新/鼠标/缩放、普通 Cmd+Q 重开、显式接管实际 RPC、PTY 输入阻塞上限仍需核对；P8 新架构包含后台/解析器/WebKit 的总内存负载、联合流与三平台打包 CI 尚未完成。Windows/Linux 通知点击/唤醒继续按用户要求延期。Converge coverage/Review v3 正式回执仍 uncovered。


P6 边界再验（2026-10-02）：事件心跳原先每次同步查询窗口焦点，Mac 锁定时可能堵住独立心跳。改由 main 窗口 Focused 事件写入原子状态，轮询只读取该状态；其他窗口焦点不能污染主窗口上下文，新增回归通过。锁屏期间真实 --desktop --idle-check 验收 s-1a0f9226395-0 通过：连接的空闲 GUI 在 65 秒后后台 PID 不变，输入接管使旧客户端立即只读，未知会话拒绝接管，任务/后台退出重开与保存现场重启仍通过。关闭成功回执发送前不退出；即使已接受关闭的客户端用 TCP RST 消失，也在尝试回执后完成后台退出，不保留停止后的实例锁。该 RST 回归先失败后通过；完整 Rust 147 项和 Clippy 通过。

P4 边界补验：OpenCode 在 /new 切换根会话时原先静默忽略，现明确发布当前已验证轮次的 IntegrationUnavailable，并保留原回执，要求新建 YAM 会话。SDK 原生会话查询通过官方 RequestInit/AbortSignal 选项使用 1 秒截止；测试证明超时释放事件顺序，迟到结果不能建立错误身份。除 socket outbox 外，待执行原生回调也限制为 128；500 个不产生发送消息的原生回调突发先失败后明确 unavailable，不再无限积压。77 个 Node 测试通过，覆盖率仍仅工具类 100% 行/99.20% 分支/100% 函数。官方类型来源：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/js/src/gen/client/types.gen.ts 。真实双轮与扩展 13 事件在隔离 HOME/XDG、无用户凭据、仅公开合成提示下通过；最新回调上限后正在复跑，最终结果须以完成输出为准。

当前剩余：Mac 再次锁定，原生实时键盘、鼠标、缩放和 Cmd+Q 再打开仍待人工解锁后继续；P8 后台/解析器/WebKit 总内存采集、负载对照、联合流和 Windows/Linux 生命周期/打包 CI 未关闭。PTY 写入的业务阻塞上限仍待处理，不能用传输读取超时冒充写入已可中断。现有 collector 对从 shell 直接启动而没有 LaunchServices coalition 的实例会 fail closed，尚不能用该模式声明内存完整测量。无新依赖、CLI 信任或系统权限；没有提交、推送或发布本轮改动。Converge 正式回执继续 uncovered。


P6 输入与锁屏复验（2026-10-02）：此前 65 秒心跳复验有一次失败，不能沿用单次通过结论。同步焦点查询已移除后，进一步按 Apple 原生 NSProcessInfo 活动 API 标记持续会话监控；选择 UserInitiatedAllowingIdleSystemSleep，回归确认不阻止系统或显示器休眠、活动 token 成对释放。新包连续两次 --desktop --idle-check 完整通过，样本 s-1a0f93db74d-0、s-1a0f93f72d7-0；包含真实桌面进程退出/重开、相同后台/任务 PID、显式输入接管、备用屏幕保存和整个后台重启后的保存场景等价。该证据仍不是原生 Cmd+Q/鼠标/缩放验收。Apple 原生依据：https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheAppLevel.html 。

Unix PTY 输入先补红灯后修复：master 设置非阻塞，输出 reader 对 WouldBlock/Interrupted 继续；共用输入锁绝对截止与 stop 取消，输入最多 3 秒，部分接受后返回准确字节数并明确禁止整段重发。真实 raw PTY 不读取输入、Unix socket 背压、Unicode/空输入/取消以及输入锁堵塞回归均通过。Windows writer 的同步 WriteFile 仍待平台有限取消处理，不把 Unix 成果写成三平台已关闭。

P7 保存现场的读取边界补红灯后修复：复用私有文件读取检查，拒绝符号链接（含断链）、非当前用户私有文件、非普通文件和超 64 MiB 文件；不存在的历史场景仍返回 None 以支持旧日志。真实文件回归通过。上一轮全部 Rust 152 项通过；新增保存文件回归也通过，最终全量检查将在本轮末重跑。

P8 collector 已扩展为可选 --background：用私有 600/O_NOFOLLOW 的连接描述符和认证状态绑定 owner PID，再核对同包可执行文件及单一终端服务父子身份，归属包含后台后代、区分自定义 PTY 工作负载。桌面退出且确无已连接桌面时允许后台独立采样；存在已连接桌面却缺少 LaunchServices coalition 时仍 fail closed。真实隔离包后台-only采样 /tmp/yam-continuity-background-only-probe2-20261002.jsonl 为 complete，归属 71392 owner/71393 terminal-service，RSS 133218304 字节、物理 footprint 求和 27774000 字节；这只是单次空闲诊断，不是最终 16 会话/30 分钟/WebKit 总内存验收。新增 2 个 Python 归属/私有描述符回归，当前 Python 18 项通过。

P4 最新有限回调实现后的真实 OpenCode 扩展 13 事件已通过，原生会话 ses_f06d4c891ffeHzA229vX0JAV7s；此前“正在复跑”状态已被本次完成证据取代。Mac 原生输入/鼠标/缩放与 Cmd+Q 尚待可用桌面，CUA 最新 inventory 超时；未更改锁屏/权限设置。P8 完整内存联合流、三平台打包/生命周期 CI 和正式 Converge coverage/Review v3 仍 uncovered。

本轮收口检查：153 Rust、77 Node、18 Python 全部通过；Clippy --all-targets -D warnings、计划 v6 校验和 git diff --check 通过。Node coverage 仍只覆盖 src/*.ts（100% 行/99.20% 分支/100% 函数），不能冒充 Rust/React coverage 或正式 Review v3。最终原生包与三平台 CI 继续执行，尚未改写 P6/P7/P8 为全部完成。

最终原生包 178.52 MiB（debug）通过 --desktop 烟测，样本 s-1a0f946dd3f-0：真实 GUI 退出/重开、后台/任务 PID 保持、输入接管、后台双轮查询、停止和整个后台重启后的保存场景等价全部通过；本次未带 --idle-check，JSON 的 connected_idle_retains_owner=false 表示未执行该子项，两次 65 秒通过证据见前文。准备将当前可审阅实现检查点提交并推送既有修复分支以执行三平台 CI，不合并或发布。

三平台 CI 已由 71ab941 推送启动（run 36926048286），macOS 安装步骤暴露 @xterm/xterm lock importer specifier 仍为 ^6.0.0，而 package 已固定 6.0.0。本地 pnpm install --frozen-lockfile 同样红灯；仅将 importer specifier 同步为已批准的 6.0.0，不变更已解析版本/依赖图。离线冻结安装通过，不放宽 CI 的 frozen-lockfile 检查。

Windows CI 进一步暴露打包脚本使用默认 cp1252 解码 xterm UTF-8 JavaScript（run 36926250696，build:terminal，byte 0x90/position 83026）。新增真实打包回归将缺省文本编码强制为 cp1252：针对修复前脚本运行复现相同 UnicodeDecodeError；全部文件/协议文本显式 UTF-8 后通过原生 SEA 生成和中文/emoji probe。未添加依赖，也未使用 PYTHONUTF8 环境绕开源代码问题。Windows 完整 CI 将由本次修复再次验证，当前不能宣称已通过。

53e140f 的 macOS CI 已通过、Linux 已进入包上传；Windows SEA UTF-8 打包通过后暴露测试 cfg(unix) 误附到 viewport 测试，而 fork/pipe 继承锁测试未限定 Unix。将 cfg 移到实际 Unix-only 测试，保留 viewport 的跨平台覆盖，修复真实 Windows 编译红灯，不跳过平台业务检查。

Windows 输入已先增加原生匿名管道堵塞/Unicode/取消回归，再实现当前写线程的 CancelSynchronousIo 截止与 stop 取消；使用本进程当前线程 handle，不终止线程/任务，不添加依赖。取消与 WriteFile 入口竞争时重试，无法确认取消时记录错误；错误保留已确认前缀并说明最后一次写入可能部分接受，禁止整段自动重发。该 API 标记取消后并不保证所有类型 I/O 都立即完成，因此只在 Windows CI 原生管道回归通过后才能收口此子项。本机 macOS 无法执行这项 Windows 测试，当前仍 uncovered；Microsoft 原生契约：https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelsynchronousio 。
