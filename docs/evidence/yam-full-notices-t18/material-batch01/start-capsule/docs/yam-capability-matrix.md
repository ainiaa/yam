# YAM 当前能力清单

作者：Jeff.Liu。更新：2026-10-03。当前源码基线：`6b00a7dcad249c4fca90efbcdafdbc4a836ea8ec`（`6b00a7d`），应用版本 0.1.0。本文统一当前声明；历史报告保留当时的提交、事实和缺口。后续任务取得新证据后再更新对应能力。

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

| 能力 | 当前状态与边界 | 依据 / 最后记录的验证基线 |
|---|---|---|
| 项目/会话 | 已支持本地目录分组、并行会话、筛选、重命名、搜索、重新运行，目录取消保留原值 | [App](../apps/desktop/src/App.tsx)、[项目工具](../apps/desktop/src/workspaces.ts)、[阶段记录](yam-next-stage-execution.md)；macOS 阶段样本，当前代码 `6b00a7d` |
| 持续后台 | 已支持独立 owner 持有 PTY/parser，GUI 退出继续，重开同一 owner 不重复启动 | [后台](../apps/desktop/src-tauri/src/background.rs)、[连续性记录](yam-session-continuity-plan.md)；`400f5ba` [三平台 CI 36938013741](https://github.com/ainiaa/yam/actions/runs/36938013741) 实际隔离包生命周期 |
| 停止/恢复 | 已支持显式 Stop all tasks and quit 清理；无活跃任务且 60 秒无客户端请求才闲置退出；后台/parser 故障可见，遗留运行态 needs_attention，不自动重跑 | [会话管理](../apps/desktop/src-tauri/src/lib.rs)、后台与同上包证据；普通 Cmd+Q 联合流程未原生验收 |
| 终端/输入 | 已支持后台持续解析、投影/最终场景，显式 Take control 转移输入；部分接受后不整段自动重发 | [终端服务](../apps/desktop/terminal-service.cjs)、[内核](../apps/desktop/src-tauri/src/terminal_runtime.rs)、连续性记录；`400f5ba` 三平台场景/生命周期与 Windows 管道/ConPTY 回归；原生键鼠/缩放/快速切换未验收 |
| 历史 | 已支持 JSON 原子保存/备份恢复、结束场景只读；旧记录无场景降级日志回放；存储/容量错误可见，不静默丢弃未读回执 | [HistoryStore](../apps/desktop/src-tauri/src/history.rs)、[回执](../apps/desktop/src-tauri/src/agent_events.rs)，当前 `6b00a7d` 及连续性记录 |
| 历史摘要分页与容量管理 | 当前工作区新增默认100/上限200的摘要页、按ID详情、全局活动/未读/关注查询、独立有界收件箱和通知重试；游标绑定store instance/revision与查询上下文，过期重载；容量面板区分元数据/日志/场景/备份/归档，24 MiB提醒；归档/还原操作见下列T04工作区实现 | [历史](../apps/desktop/src-tauri/src/history.rs)、[前端](../apps/desktop/src/history.ts)、[分页回归](../apps/desktop/tests/history.test.mjs)；2026-10-03 T03工作区自动化，当前页外日志命中/通知按ID读取；原生桌面分页操作未实机验收 |
| 历史归档/还原 | 当前工作区已支持显式按ID归档完成/失败/停止的记录；无未读、待发/失败通知、原生续聊claim或仍持有最终场景的Session时才允许。自动归档默认关闭，T05可显式启用30天规则；日志/frame保持原路径。分片、事务、hot、manifest、可恢复bak同步后完成，重启先恢复再暴露历史；还原超过32 MiB明确拒绝。归档页独立revision和来源上下文，详情/场景/原生续聊按ID可读档案 | [HistoryStore](../apps/desktop/src-tauri/src/history.rs)、[归档入口](../apps/desktop/src/HistoryArchive.tsx)、[原生管理](../apps/desktop/src-tauri/src/lib.rs)、[UI回归](../apps/desktop/tests/history-archive.test.mjs)；2026-10-03 T04/T05工作区自动化，三平台实际桌面归档/恢复/原生续聊联合操作未原生验收；后台协议v2，活跃v1 owner保留任务并提示升级 |
| 历史保留/永久清理 | 当前工作区新增应用内最多20个归档ID的预览与单独确认/取消，展示精确条数、时间、逻辑字节与范围；默认自动归档和自动删除关闭，损坏policy报错并保持关闭。仅显式启用后，owner无活跃任务且60秒无RPC时小批归档UTC严格超过30天且全部已读的结束记录；每项和批末重新检查RPC/active/shutdown。永久清理仅验证过的YAM归档分片、日志与保存场景，不清CLI原生历史或取证备份；私有事务在同owner或重启恢复，hot/bak成员同步后才删除文件。部分失败保留固定错误与事务，UI仅清实际回执ID对应名称、偏好和结束视图缓存 | [历史](../apps/desktop/src-tauri/src/history.rs)、[后台](../apps/desktop/src-tauri/src/background.rs)、[预览确认入口](../apps/desktop/src/HistoryArchive.tsx)；2026-10-03 T05宿主自动化，三平台原生权限/中断与实际桌面清理未原生验收；本开发未清理用户真实数据 |
| 日志搜索/导出 | 已支持当前/全部保留日志分页搜索、Unicode/ANSI 位置/摘录；T04增加热历史与档案的有界continuation，无命中也能继续；游标绑定owner/查询/范围/源成员与归档revision，变更明确重启搜索、纯文本/原始导出，原生目的地、禁止覆盖；截断的旧输出不能找回 | [日志](../apps/desktop/src-tauri/src/session_logs.rs)、[搜索](../apps/desktop/src/SessionLogSearch.tsx)、[导出](../apps/desktop/src/SessionLogExport.tsx)，连续性记录 `4cb533d` 核心/日志联合验证及包脚本 |
| 收件箱/通知 | 已支持逐轮权限/回复/中断/失败回执、重试/暂停/前台抑制；打开指定收件箱项才已读，OS 接受不清未读；送达/持久化间崩溃可能重复 | [Agent 状态](../apps/desktop/src-tauri/src/agent_events.rs)、[通知历史](notification-acceptance.md)，macOS 2026-10-01 样本及 `3c181db` 阶段 CI；当前架构通知联合桌面流程未原生验收 |
| 实时内存 | 已支持每 5 秒、单在途采样，隐藏时停止；应用含 GUI/WebKit/owner/parser，任务单列；归属不完整/过期/失败显示不可用 | [采样](../apps/desktop/src-tauri/src/memory.rs)、[轮询](../apps/desktop/src/memory.ts)、[live-memory](superpowers/plans/2026-10-02-live-memory.md)，`585edb3` CI、`ca396c4` WebKit receiver 修复与后续自采样/真实前端 IPC；当前 `6b00a7d`，可见 UI 读取超时仍未验收 |
| 可信项目启动配置 | 当前工作区已实现可选version1 yam.json、预览与独立显式信任、用户单独启动、命名模板和应用私有默认；本次明确UI编辑>信任项目/模板>global，空串覆盖有效。owner启动前重读精确有界source并绑定canonical路径/物理根，变更或同名不同根不继承信任。env只引用owner已有变量，源/目标YAM_大小写均拒绝，值仅builder.env，不读.env/持久化/回传，不插值custom shell文本 | [项目配置](../apps/desktop/src-tauri/src/project_config.rs)、[实际App路径](../apps/desktop/src/App.tsx)、[预览](../apps/desktop/src/ProjectConfigPreview.tsx)、[T09测试证据](evidence/yam-project-config-t09/README.md)；正常/边界/异常、TOCTOU、取消旧回包、字面argv和owner分配前拒绝自动化；真实GUI/CLI/Hook/权限及Windows/Linux未原生验收 |
| 隐藏视图释放 | 已支持最新选择成功后释放已结束且保存确认的隐藏完整视图；live、旧日志、保存失败及旧 owner 缺 persisted 时保留 | [缓存](../apps/desktop/src/terminal-views.ts)、App、[renderer-memory](superpowers/plans/2026-10-02-renderer-memory.md)，当前 `6b00a7d` 测试及固定原生 WebKit 夹具，非真实用户百分比收益 |
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

T10当前工作区已提供终端字体/10–24整数字号/dark-light-solarized主题的显式保存与取消，损坏偏好回退提示；沿xterm options更新已有实例、fit并对已确认可写的live/ready view单飞合并最新尺寸，backend输入lease仍权威，偏好不自动take control。有限命令面板复用已有动作，普通输入/IME/dialog不抢键，终端焦点可唤起；已配P快捷键优先并提示按钮入口。最多100个本地pin仅导航排序，永久清理回执同步移除对应pin；关闭verified/persisted ended idle视图不删历史或停止任务。Run again/Continue文案与原动作分开。详情与宿主自动化范围见[T10证据](evidence/yam-terminal-settings-t10/README.md)；没有新native包或真实GUI/Windows/Linux验收，T08旧包不冒领T10。

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

Source code now binds the complete 535 Cargo/12 production npm inventory and independent accepted body qualifications, renders cache-free original bytes, and enforces an explicit formal-release gate before runtime/SEA and native release tools. Qualified material covers 24 Cargo/8 npm; 515 explicit gaps remain (26 prior Cargo, 485 newly unclassified archive candidates, 2 npm declaration-only, 2 headless/serializer applicability). Node aggregate LICENSE is additional. Developer output is incomplete and never release-eligible. This does not complete project license choice, compatibility review, full-text gap resolution, native packaged notices, signing, or publication. Details: [notice integrity](THIRD_PARTY_NOTICES.md).

Current R2 source passed independent Root and Astra source reviews. A fixed, independently approved canonical manifest digest binds the entire 547-identity material inventory, including supplemental bodies, declarations, provenance, gap classifications and additional Node material. Collection produces candidates without granting readiness; Collection rejects unapproved candidates before accepted return/publication; the public approval check, both render modes and packaged validation reject mapping changes before validator body reads. Future material changes require separate review and approval-anchor updates; no flag or environment bypass is provided.

The five fresh checks, 28 actual failing assertions before repair, and the separate direct-green freshly report-bound package regression are preserved in [current R2 evidence](evidence/yam-full-notices-t18/r2/README.md). The unchanged R1 archive is historical and superseded after a later supplemental-inventory finding; its earlier source review is not final ArtifactReview acceptance. Current counts remain 32 qualified identities, 515 material gaps (30 known and 485 awaiting classification), and one additional Node attribution. Developer output remains deterministic at 4,774,340 bytes and is never release-eligible. The collector/render/release-gate source slice is complete; full notice material, legal, native signed release and formal provider acceptance remain incomplete.
