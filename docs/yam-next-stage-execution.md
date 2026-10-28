# 草案实施记录
作者：Jeff.Liu。基线：0617b23d01be696212eb953994b420b119e89d4c。执行计划：yam-next-stage-plan.json。

## 当前进度（以下新证据优先于历史记录）

| 批次 | 当前结论 | 未覆盖边界 |
|---|---|---|
| B0 | Codex 实际 Hook 能力探测；Claude 2.1.286 原生双轮通过 | 更新版本的真实事件语义仍需安装后验收 |
| B1 | macOS 双轮、通知点击/同构建唤醒、Claude 审批→工具进展→回复、真实中断与收件箱通过 | Codex 工具进展本轮实测待临时信任；完整跨平台异常矩阵未覆盖 |
| B2 | 导航、可配置快捷键、模式记忆已实现，回归及原生主要操作通过 | 完整跨平台 UI 未覆盖；模式记忆已通过原生重启复测 |
| B3 | 已实现并有本机终端/压力证据 | cmux 对照、WebKit 全进程内存未测 |
| B4 | 主动原生 resume 已实现；真实上下文续答通过 | 身份保留/重复拒绝已复测；其他 CLI/provider/平台未覆盖 |
| B5 | 本地检查及提交 77180ef 的三平台 CI、打包通过 | 三平台真实通知点击/唤醒、正式签名、正式工具回执待验收 |

冻结 JSON 中的 pending 为原计划快照；本节与后续实测记录是执行进度，不改写冻结验收。Converge native preflight 实际返回 coverage uncovered（未识别项目现有 Node coverage 配置），没有正式 Trace/Review v3 完成回执；不能据此宣称整个 Converge 计划完成。

## B0 — 能力验证完成（Codex 纵向切片，Claude 降级）
已完成本机版本、Codex 双轮与 Hook 续跑语义验证，见 agent-capabilities.md 和冻结探针脚本。临时信任授权已撤销。已验证 Codex app-server 的只读 config/read 能返回按 cwd 合并的 notify 配置，启动、初始化和查询合计约 218 ms，可用于保留原回调；该 API 查询不创建 Agent 线程、不发模型请求。选择标准库 loopback TCP 上的单条有界 JSON 接收，凭据只经环境传入，本次启动绑定；现有单实例激活路径不能复用。非 UI Rust helper、认证入口、原回调转发及异常端到端行为在 B1 验证。Claude 正常回应、权限、中断未验收。这个能力结论不等于 B1 实现/全平台支持已完成。

## B3 — 实现与本机验收通过（正式工具回执及对照测量未覆盖）
已有 Chromium 固定输出基线（1180×760 浏览器，100×30 终端，207500 字节中文/emoji，10 次 reset/write）：解析约 3.3–19.7 ms。滚动第 50 行在重放后变成底部第 1000 行；这是可复现的上下文缺失。
16 个 xterm、每个 1000 行 scrollback、同输出固定夹具，GC 后 JS heap 增量 8698232 字节。这个测量不是原生 WebKit 总内存，也不是 30 分钟压力或 cmux 对比。

采用独立活跃终端实例，初始上限 16；只淘汰已退出视图，不释放活跃 TUI。达到上限时拒绝打开/启动更多视图，提示停止已有会话。隐藏视图保持可测量尺寸并持续消费输出。首次/冷历史仍读有限日志，无法保证恢复完整 TUI；输出缺口禁用输入并提示日志恢复限制。

已观察断言红灯后实现 TerminalViews 与实际 App 选择协调器；47 个前端测试通过，TypeScript 工具模块覆盖率行 100%、分支 98.83%、函数 100%；该统计不覆盖 App.tsx 渲染路径。build 通过。真实 Chromium DOM + mock IPC 已验证 A/B/A 保留同一个 xterm DOM、每个会话只读一次快照、背景 Unicode/alternate-screen 更新、输入固定路由、正数尺寸缩放。

独立只读复核发现的隐藏协议应答、旧查询注入、延迟焦点、旧生命周期回写、重放回调竞争及启动期间容量竞争均已补回归并修复。测试执行实际 App 函数及事件处理器，而非另写一套协调逻辑；本轮新增失败断言均已观察红/绿。最后的 B3 复核没有阻塞项；启动错误释放创建守卫、重复启动被拒绝、已打开终端仍可切换。这些外部 CLI 复核没有绑定正式 Converge Review v3 回执，不能据此宣称正式 Converge 闭环。

隔离包 com.yam.validation 原生 WebKit + portable-pty 验证：两个 alternate-screen/中文/emoji TUI 在前后台持续接收 CSI 6n 并回传，旧运行中测试均超过 600 次 INPUT、零 QUERY TIMEOUT；新构建复测分别 272/60 次 INPUT、零超时，切回后 z 只进入第一个终端，搜索 native 没有进入任何 PTY。最终 .app 复测新增 TUI 首次查询成功（17 次 INPUT、零超时），正常退出后状态 stopped 且没有测试 PTY 残留。编译后最终 .app Helper 冒烟也通过。用户 YAM 数据目录未用于这些测试。重启隔离包后只展示历史，不重启命令，已停止历史显示冷恢复限制。

30 分钟固定输出：每 50 ms 写入 100 行固定中文/emoji/75 个 x 字符，使用 alternate screen、每 20 帧查询光标；会话 s-1a0f640e4e7-2 正常退出（1800 秒），累计 output_end_offset=329902855 byte，最终日志 6994998 byte，运行时日志始终不超过既有 8388608 byte 上限。主进程 61 次、30 秒间隔 RSS 采样跨度 1803.53 秒，范围 44656–59296 KiB，首尾 53264/49760 KiB。这里只测主进程，不包含 WebKit/CLI 总内存；渲染进程候选 PID 2033 随隔离应用退出消失，但没有充分归属证据，不统计为总内存。该负载结果不是与 cmux 的对照，也不是延迟统计或 Rust 覆盖率。重放竞争/容量守卫的后续修复由回归和浏览器验证覆盖，未重新运行整段 30 分钟压力。

## B1 — 接入实现与本地验证进行中
新增轮次状态、稳定收件箱 ID/revision、精确已读/发送回执；事件检查当前生命周期和随机启动 generation，提交失败不 ACK。标准库 IPv4 loopback TCP、256 bit OS 随机凭据、4096 byte 认证 JSON。编译后的非 UI Helper 已验证成功事件、错误凭据、连接中断、原有 notify 消息原样转发；没有进入 UI/单实例路径，也没有执行真实 Agent。通过 app-server config/read 保存有效原 notify；仅已测 Codex 0.159.3 交互接入，未知版本和自定义 config/profile 降级；未注入权限 Hook，尚未验证其真实事件能力。Stop 不证明最终响应，只有匹配主线程/turn 的 notify 才产生完成回执。
82 个 Rust 测试通过（包含原有平台测试），前端 47 个测试与覆盖阈值通过。构建通过；最终 Clippy 和隔离 .app 构建已通过。没有新增依赖。真实 CLI Helper 双轮通知端到端需要新增临时 Helper Hook 信任，已另行提问，尚未得到答复；capture.py 信任已撤销，不能复用于这个新 Helper。不得将冻结 capture 记录或编译后二进制夹具冒充新 Helper 的真实 CLI 验收。
历史夹具实测：1000 个空记录约 838002 byte，一个 512 回执记录约 186702 byte；保留既有 JSON 存储，设置 32 MiB 总量拒绝写入预算，保留未读数据；旧结构默认兼容，首次升级保存不被滚动备份覆盖的 sessions.before-agent-events.json。
后端通知队列已接入；系统 accepted 不等于 read，前台抑制也保留未读，永久错误暂停、瞬时错误退避，发送成功后落盘失败只重试回执。补测并修复：macOS 接收 socket 继承 nonblocking 导致分片拒绝、慢发送总时限、上一轮首次晚到完成丢失、真实平台永久错误分类、原 notify 环境缺失导致 YAM 事件不发送、查询子进程持有 stdout、已认证落盘/容量失败无诊断。过期 launch 的失败不能改变新 launch；有效新事件可恢复连接状态。

进程通知和轮次通知共用 native 发送守卫，持锁后重新读状态；已连接 Agent 的旧空闲提醒不覆盖轮次，进程退出后的旧轮次保留未读但抑制横幅。屏障测试验证 native 发送期间历史仍可更新，进程结束通知随后发送，发送不读收件箱。Bridge 清理使用整体退出 deadline；系统发送卡住时报告超时、保留 worker/回执并保持应用打开，可再次请求退出，不能冒称已取消 OS 请求或成功清理。阻塞发送测试已观察红/绿；真实 Linux D-Bus 卡死尚未复现。退出超时后，只有旧 worker 全部结束才撤销旧桥接器，并在后续启动创建新的监听/路由/发送线程；阻塞期间不会强行替换，已结束线程不导致永久降级。真实 loopback 恢复回归通过，最终针对恢复调用面的只读复核没有阻塞项。

隔离 macOS 包实际返回 UNErrorDomain NotificationsNotAllowed；已用 NSError 回归修正为明确 permission denied，暂停自动重试，界面正确提示去系统设置后重试。[Apple 语义](https://developer.apple.com/documentation/usernotifications/unerror/code/notificationsnotallowed?language=objc)。未开启隔离包通知权限，所以本轮不能验收系统横幅/点击；旧修复分支的 OS 点击验证不等于新轮次通知通过。

## B2/B4/B5 — 待闭环
B1 界面接入同时预置了收件箱/未读/下一关注导航，尚未通过全部实际 UI 验收。B4 原生 resume 仍未实现。
已构建隔离标识 com.yam.validation 的 YAM Validation.app，用于原生验证；当前用户 YAM 进程未退出。测试包不等于正式签名或分发。

按草案前置证据推进。Windows/Linux 真桌面、正式证书、Rust 覆盖与外部审核工具缺口不能用本地编译冒充通过。

## 2026-10-01 — 实现复查与通知暂停回归
复查事件归属/去重、发送与已读回执、后台终端输入归属、快照竞争、通知暂停和重试调用链。本轮确认并修复两个问题，均先观察新增回归断言失败，再修改业务代码：

- 后端在通知暂停期间消耗显式重试标记，恢复通知后永久错误仍被阻止重试。暂停 tick 不再清除此标记；测试覆盖多次暂停 tick、恢复后失败重试及后续瞬时错误退避边界。
- 前端在等待 list_sessions 期间收到暂停操作后仍发送进程通知并确认回执。异步读取返回后重新检查暂停状态；测试验证暂停期间不发送、不确认、保留待发送项，恢复后发送并确认。

本轮完整验证：82 个 Rust 测试、48 个前端测试全部通过，前端模块覆盖阈值通过（该统计不覆盖 App.tsx 渲染路径），TypeScript/Vite 构建、Clippy、格式与差异检查通过。这两个回归使用真实协调器函数和后端队列，未触发系统通知或新增 CLI 信任。

仍未闭环：B1 新 Helper 的真实 Codex 双轮、Claude 正常回应/权限/中断能力，B2 完整导航与 UI 验收，B4 原生 resume，B5 当前改动的跨平台 CI、真实桌面通知点击和签名/分发验证。旧探针、旧修复分支 CI 和本机单元测试不能替代这些验收。当前新增改动未提交/推送。

## 2026-10-01 — 继续修复：保留用户既有 Hook
用户明确选择保留新 Helper 真实双轮验收缺口，不再申请/执行该临时信任。B1 的关键验收未通过，按冻结计划依赖顺序，不推进依赖它的 B2/B4 新功能；继续修复已有 B1 调用链。

发现并实证修复 config.toml Hook 覆盖：在临时 CODEX_HOME 中仅设置无执行能力的测试命令字符串，使用已安装 Codex 0.159.3 的 app-server config/read 只读查询。无命令行覆盖时 Stop 保留 original-user-stop/timeout=7；加入 -c hooks.Stop=… 后仅剩 yam-helper-test/timeout=2。未启动 Agent、执行 Hook、改用户配置或写信任。此前独立 Hook 文件继续执行的证据不覆盖此情形。

新增回归先失败于“must preserve SessionStart”，修复后四类冲突、空数组、无关事件、非法结构及原 notify 保留均通过。共用配置检查在 prepare 注入前拒绝覆盖；create_session 沿原有错误分支展示集成降级，并启动未注入 YAM 配置的普通 CLI。未添加依赖或 Hook 合并框架。

最后源码验证：cargo test --locked 全部 83 个 Rust 测试通过，48 个前端测试及覆盖阈值通过，构建通过；Clippy、格式和差异检查通过。独立只读复核检查规格、prepare/effective_notify/create_session 调用链及测试，未发现该修复范围内的阻塞项；该复核不是正式 Converge Review v3 回执。B1/B2/B4/B5 既有未验收项仍保留，未提交/推送或发布。

## 2026-10-01 — Helper 真实双轮核心链路通过
用户随后明确授权真实双轮测试，并允许本次 4 个 Helper Hook 临时信任、结束后撤销。当前源码隔离 .app 重新构建通过，编译后二进制冒烟通过。仅信任 4 个会话定义；既有未审核 Hook 未增加信任。

受控 PTY 上真实 Codex 0.159.3 使用隔离应用的已注册 Bridge 与相同 Helper 参数。主线程 01a0f6c3-833c-7092-85cf-5a8e6b68b832、同一 PID 69140，两个 turn 01a0f6c3-f50d-7613-8227-329bd49c49a0 / 01a0f6c5-3102-77a1-9546-ed6fecefe687 分别回答 YAM_HELPER_ONE / YAM_HELPER_TWO。CLI 在第二条提交后仍存活、YAM 会话 running；后端提交两条独立 response_finished 回执（revision 4/7），第二轮不改变第一条。实际界面显示 2 条未读和两个收件箱条目；不是历史 capture 夹具或 Python 模拟 receiver。

系统通知权限关闭，两条后台发送均 failed/permission denied，保持未读。切回目标会话后发送结果 suppressed、未读仍为 2。结束后测试 CLI 与隔离应用全部退出，状态 stopped、未读保留；精确撤销 4 个新增信任，原有 hooks.state 与测试前快照一致。原有一项 Hook 在原生审核时误关闭，已恢复；没有遗留启用状态变更。

本次未修改业务代码。原生终端的 CUA 画面空白、键盘焦点不稳定，故改用受控 PTY 操作；原生应用启动到交互输入的完整路径仍未验收，需要另行复现定位。核心 CLI→编译后 Helper→真实 YAM Bridge/持久状态→收件箱链路通过，不等于系统横幅/点击或 B1 全部发布验收完成。Claude、权限/中断异常全矩阵、Windows/Linux、B2/B4/B5 既有缺口仍保留。临时脱敏回执：/tmp/yam-helper-live-evidence.json。

后续原生显示复查：重新启动隔离包后，界面仍显示 2 条未读；点击已停止的 CLI 历史，截图可见 YAM_HELPER_ONE 回复与完整 Hook 审核菜单。历史冷恢复不是始终空白。上次活跃终端的空白与焦点现象尚未稳定复现/定位，不列为已确认的持续渲染缺陷，也不以此次冷恢复冒充原生新建交互路径通过。只查看历史，没有重启 CLI、执行 Hook 或重新授予信任；复查后关闭隔离包。

## 2026-10-01 — 首次终端焦点修复与原生显示复查
继续调查原生空白现象：无 Hook 的本地 alternate-screen/CSI 6n 程序在日志中持续输出并收到正确会话的光标应答。临时隔离诊断包确认终端尺寸、字符测量与解析缓冲正常；原生后台启动截图空白，点击窗口或打开检查器后显示。前台窗口从首页新建后直接显示中文、Emoji、光标和查询输出。仍不能将后台截图现象判定为持续渲染缺陷，因此未加入强制刷新或修改 xterm 私有实现。临时诊断代码全部撤回，最终构建不含探针。

确认一个独立焦点缺陷：从 empty-state 的 New session 启动，React 移除旧启动按钮，焦点落回 document.body；原协调器只接受旧元素仍获焦，因此不聚焦终端。新增实际协调器回归先失败，再仅放行“旧元素已断开且焦点落回 body”；用户转去搜索或原元素仍连接时不抢焦点。

本轮 51 个前端测试和既有模块覆盖阈值通过（App.tsx 不在模块覆盖统计内），TypeScript/Vite 与隔离原生 .app 构建通过，差异检查通过。额外使用已安装 Chromium 和实际 App 做 DOM 冒烟：首页按钮 → 启动 → 无额外点击，activeElement 为 xterm-helper-textarea，键入 z 路由到会话 a，中文行可见。原生前台新建截图显示正常；CUA 原生键盘自动化不稳定，未用浏览器结果冒充完整原生 CLI 交互验收。

自检覆盖 openHistory 的首次/暖切换、异步旧选中保护、解析完成后聚焦和搜索焦点保留；本次低影响焦点修复无新增依赖、Hook 信任或系统权限。验收程序均停止，隔离包退出。B1 的完整原生 CLI、Claude/权限/中断与系统横幅点击，B2/B4/B5 既有未完成项仍保留；不声明整个计划闭环，也未提交/推送当前变更。

## 2026-10-01 — 本次授权后的原生双轮与主动续聊

用户本次明确允许 4 个 Helper 会话 Hook 临时信任并开启隔离包通知。原 debug bundle 的 linker ad-hoc 签名未绑定 Info.plist；将测试包复制到 ~/Applications/YAM Validation.app，以 com.yam.validation 重新进行本地 ad-hoc 签名后，系统设置出现单独 YAM Validation 项。只开启该隔离包通知，没有改正常 YAM 设置。这不是 Developer ID 签名/公证证明。

原生 YAM 创建 s-1a0f6ebf159-0；Codex 主 ID 01a0f6ec-5463-78c3-a404-5a7ad3b933fe。原生 CUA 输入实际完成 4 次回复（第一条 ONE 因观察延迟重复提交，两条各有独立 turn，不能冒称仅一轮重复事件），随后 Esc 实际中断第五轮。两条前台 ONE 分别 suppressed/revision 4、7；切到另一个终端后 TWO/THREE 分别 accepted/revision 10、13，CLI 仍 running。点击具体 TWO 收件箱条目后，仅 revision 10 read=true，revision 13 保持未读。真实中断 revision 15 kind=interrupted/suppressed，没有误归成功。下一关注快捷键回到目标会话并交给终端焦点。未观测系统横幅实际呈现时间，accepted 只说明 OS API 接受。

退出测试会话及隔离包后状态 stopped，精确撤销 4 个新增 session-flags trust；原 15 项 hooks.state 全部一致。后续不信任 Hook 的续聊测试再次核对新增/变更均为 0。脱敏原生回执 /tmp/yam-native-final-evidence.json。通知中心 CUA 仍绑定天气小组件，系统通知点击/退出后唤醒仍未验收。

B2 按 TDD 补齐介入优先级、上一个会话、快速搜索 Enter 到达、暂停/恢复提醒、可配置且互不冲突的 Cmd/Ctrl+Shift 快捷键；IME/repeat/弹窗/编辑快捷键时不截获。模式保持默认 task，改用 Run one task/Continuous conversation 并保存选择、说明 Hook 未就绪边界。实际 App 协调器与工具回归覆盖容量拒绝、重新选中不覆盖上一会话、延迟焦点、modal 阻止等。

B4 只接受 YAM 历史 source ID，由后端取可信主会话 UUID；不允许客户端覆盖命令/目录/参数。仅支持已测 Codex 0.159.3、普通交互启动且无自定义参数；校验存在的目录、CLI、只读 thread/read 原 ID/目录/provider，不回退新对话。清除旧 prompt，直接 argv resume UUID。启动失败和清理释放会话占用，重复启动同一续聊被拒绝，其他终端不被全局启动锁阻塞。可信 resume 身份保存在历史中，仍不冒称 Hook 已连接。

隔离包重启后，主动点击 Continue conversation 创建 s-1a0f705f64f-0；不新增任何信任，选择 continue without trusting。原生界面展示原 TWO/THREE 与中断记录；提交未含标签的上下文问题后，真实 CLI 回答 YAM_NATIVE_THREE。搜索快捷键把焦点放到搜索框，Enter 到原历史；上一个会话返回续聊；暂停/恢复快捷键切换后恢复原状态。最终停止续聊，未自动重启历史、运行 shell 或重发原任务 prompt。

本地最终验证仍需绑定下述最后检查与原生包复测；平台/签名/正式工具缺口保留。

最终隔离包 s-1a0f70eb564-0 复测：主动恢复原 ID 后，从原历史再次点击续聊被明确拒绝（already being resumed），未产生第二个运行会话。停止后 agent_session_id 仍为 01a0f6ec-5463-78c3-a404-5a7ad3b933fe、integration=connecting，继续按钮可用；未信任 Hook 不伪称连接成功。模式设置 Continuous conversation 跨包重启保留，测试后恢复原 task；暂停偏好恢复 off。最终 Helper 二进制冒烟通过。87 个 Rust 测试、57 个前端测试通过，模块覆盖行 100%、分支 99.01%、函数 100%（仍不覆盖 App.tsx 整体渲染）；实际 App 协调器单独回归。Vite/TypeScript 与隔离 .app 构建通过；最后 Clippy、格式与 diff 检查见本轮命令回执。无新增依赖或审批/沙箱变更。

## 2026-10-01 — 当前提交三平台 CI 通过

修复已提交并推送到 codex/reliability-closure，业务提交 77180ef253c814280b4293cabc9f4ef7c002cabe。[Desktop checks 36851285080](https://github.com/ainiaa/yam/actions/runs/36851285080) 的 headSha 与该提交一致，最终 conclusion=success。macOS、Ubuntu 22.04、Windows 均通过前端测试/覆盖阈值、构建、Rust 格式、Clippy、cargo test --locked 和桌面打包，测试产物已上传；不引用旧分支 CI 替代本轮证据。

该 CI 不操作真实桌面通知中心，不证明通知点击/退出后唤醒或 Developer ID 签名/公证。macOS CUA 仍只能读取通知中心天气小组件，Control Center 入口超时；Windows/Linux 没有可操作的真实桌面。Claude 正常回应与权限事件、正式 Converge 工具回执及 cmux 对照仍未覆盖，整个冻结验收不能标为完成。所有本次测试 CLI 与隔离包已退出，4 个新增 Hook 信任已撤销，原有 15 项状态一致；隔离包通知权限保留本次授权的开启状态。

## 2026-10-01 — 非桌面剩余项的后续闭环

用户要求排除桌面体验后继续处理其余剩余项。新有限计划 yam-nondesktop-closure-plan.json 校验 status=valid，按 N1/N2/N3 同会话顺序实施；不修改原冻结计划。当前正式证书仍为 0，用户明确改为先完成签名与公证流程及检查，不申请证书或发布。

N1 新增权限事件注入、处理后恢复、并行工具身份关联及 API 失败回执；回归先失败后修复。Claude 原生 prompt_id 经真实探针确认；当前失败路径 CLI→编译后 Helper→认证测试 receiver 通过，正常模型回复被现有服务 base_url 配置错误阻断。Stop 最终完成不能由 Hook 独自证明；采用“回复就绪，可能继续”的可撤回默认，工具进展可恢复工作状态。用户已授权本次 7 项 Codex 会话 Hook/隔离 Claude 目录临时信任与主应用辅助功能，系统辅助功能开关已实测开启；未绕过认证或提前写信任记录。

N2 签名、公证、staple、Gatekeeper 流程已实现 scripts/macos-release.py；6 个命令 mock 回归通过，覆盖正常顺序、缺失证书/错误包、拒绝公证、ad-hoc/缺失 hardened runtime、嵌套代码与命令失败、已有签名身份不匹配。隔离 com.yam.validation 包被实际只读 check 明确拒绝。无真实证书，未签正式包、上传公证或发布；使用方式见 macos-release.md。

Converge native preflight 仍返回 coverage uncovered（未识别已有可执行 Node coverage），不降阈值、不重建图索引，不宣称正式 Review v3 完成。最终源码检查与真实通知激活证据仍需在收尾段绑定。


### 本轮最终本机证据

Codex 0.159.3 实测只支持本次 6 项 Hook；移除了不支持的 PostToolUseFailure 注入，未扩大授权范围。原生持续会话 s-1a0f74bedcb-0 两轮主线程 01a0f74c-5780-7ad2-9c62-e4c10d8125a8 分别收到独立完成回执（revision 4/7），后台第二轮 accepted。真实一次性工具审批 s-1a0f755f649-0 先收到 needs_permission revision 3，批准一次后完成 revision 5，最终 pending key 为空；没有采集到完成前 ToolProgress 中间态，因此不把原生权限关联恢复的完整时序标为已验收，相关逻辑由回归测试覆盖。

真实 Claude 持续会话 s-1a0f76371e7-0 在隔离目录临时信任后，SessionStart/UserPromptSubmit/StopFailure 经正式 Helper 写入实际 HistoryStore。原生 session_id 82877ff0-4d8d-4f86-b31d-15bf239818cf、prompt_id eaca5325-48f3-4fd1-889e-9cc9ada813e2；phase=failed、revision=3、失败回执未读且前台 suppressed。本地服务仍返回 HTTP400/缺少 base_url；正常双轮和权限流不虚报通过，未修改用户全局 Provider 或认证配置。

通知运行中点击和同构建退出后唤醒通过；跨构建旧 ad-hoc 通知身份匹配失败，详情见 notification-acceptance.md。验收发现冷启动 GUI 仅有 /usr/bin:/bin 时 CLI 缺失，先补失败测试，再统一发现/版本查询/实际启动的子进程 PATH，保留原目录优先级并补常见用户安装目录。最终隔离包以该最小 PATH 实际启动后 Codex/Claude 均可选，Claude 真实 Helper 已连接。

96 项 Rust 单元测试、57 项前端测试与 6 项签名流程回归通过；TypeScript/Vite、隔离 .app 构建、Clippy、格式与最终编译 Helper 冒烟通过。测试统计不等于正式 Converge 覆盖或真实跨平台桌面验收。6 个新增 Codex Hook 信任已撤销，15 个原有状态与基线完全一致；隔离 Claude 目录的新增信任已撤销。主应用 ChatGPT 辅助功能经 macOS 认证后已确认恢复 off；原有 Codex Computer Use 权限保持 on。

验收后模式偏好恢复为 task、暂停通知 off；最终 pgrep -x yam-desktop 无结果。正式 native preflight 在最终业务提交再次执行，仍为 coverage uncovered（no executable coverage command is configured），没有改低门槛或伪造 Review v3 回执。

最终业务提交 3c181db43fc2c9903c36a4e0aa768c2105856ab4 已推送。对应 [Desktop checks 36860989797](https://github.com/ainiaa/yam/actions/runs/36860989797) headSha 完全一致，macOS、Ubuntu 22.04、Windows 全部 success；覆盖前端覆盖率、TypeScript/Vite、Rust 格式/Clippy/test --locked、平台 app/deb/nsis 打包与测试产物保存，macOS 另执行 6 个签名流程 mock 测试。没有合并、发布或真实公证上传。

当前事项保持部分完成：Claude 正常双轮/真实权限流需修复现有 Provider 配置后验收，Codex 原生审批完成前恢复的中间态未采样，正式签名升级旧通知与跨平台真桌面未验收，正式 Converge coverage/Review v3 仍 uncovered。已实现的状态机与流程不以这些缺口虚报全面闭环。


## 2026-10-01 — Claude Provider 恢复后的双轮关联修复

用户要求重新检查 Claude。2.1.286 的真实 -p 请求正常返回 YAM_CLAUDE_RECOVERY_OK，exit=0、is_error=false、terminal_reason=completed，之前的 base_url 配置阻塞已解除。旧 YAM 构建的持续会话 s-1a0f7769ded-0 第一轮回复成功，第二轮因 Unknown agent turn 降级；这属于 YAM 的真实关联缺陷，不能以单次模型回复宣称通知正常。

元数据探针 446cd50d-099d-4a12-bcbc-5ab13ffa6944 捕获 UserPromptSubmit/Stop 第一轮同为 e1f47105-2cca-4207-9042-36178f148441；第二轮 UserPromptSubmit 仍为该 ID，而第二轮 Stop 为 5057512f-8411-4c34-b101-d4a89b6537a7。修复仅对 Helper 标记为 Claude 的事件：重复提交 ID 表示工作活动，后续已连接主会话的原生事件建立真实新轮次；继续拒绝非主会话、非法来源和 Codex 未知轮次。回归先失败后通过，没有生成轮次计数器或读取延迟 transcript。

97 项 Rust 测试、Clippy、TypeScript/Vite 与隔离 app 构建通过；新源码编译 Helper 冒烟通过，旧包对新增来源断言先失败。真实探针进程已退出；未新增 CLI 信任或辅助功能权限，用户原有 YAM 目录信任保持。修复提交 b9d4b65 已推送，真实最终双轮与对应 CI 证据在后续补充。

终端非阻断警告已通过 CLI transcript 的 hook command 区分：SessionStart 的 JSON 格式错误来自现有 claude-mem 启动 Hook，UserPromptSubmit 的缺失 graphify-out/graph.json 来自现有 query-graphify.sh；第一轮 Stop 的 claude-mem summarize 花费 110256ms，YAM Helper 为 35ms。没有修改这些全局/插件 Hook，也没有把其耗时当作 YAM Helper 耗时。

最终隔离构建真实双轮通过：s-1a0f7849b5b-0、原生主会话 1f17ed3a-5ff2-4fb6-8bd0-0e8a781554c4，回复 YAM_CLAUDE_FIXED_ONE/TWO。第一轮 prompt_id 75832eb1-b4b0-4c77-98f2-2ab0d2ce9e8e、ResponseReady revision=3/suppressed；第二次提交仍复用该 ID，但状态正常恢复 working revision=4；第二轮原生 Stop ID 1ac50e0a-ee8c-4ab2-8e8e-a37d9edc27d7 获得独立 ResponseReady revision=5/accepted，两个回执均未读、integration=connected，持续 CLI 未退出。后台 OS accepted 不替代横幅可见或点击验收。正常双轮 Provider 阻塞至此解除，Claude 真实权限流仍未验收。

本次无新信任/辅助功能授权，探针和 YAM 会话已停止，隔离包默认模式恢复 task、暂停通知 off。旧失败验收记录保留以追溯根因，未覆盖旧证据或宣称版本升级兼容门禁已改造。

修复业务提交 b9d4b65cc1351cd4957262ffee8336387007f0b7 的 [Desktop checks 36864578925](https://github.com/ainiaa/yam/actions/runs/36864578925) headSha 完全一致，macOS/Linux/Windows 全部 success，包含当前源码测试、Clippy、覆盖率和平台打包。最终 pgrep -x yam-desktop 无结果；97 项 Rust 单元测试与编译 Helper 冒烟通过。无合并或发布。

## 2026-10-01 — CLI 升级兼容、参数与 Claude 权限闭环

本轮范围：修复版本号锁定、安全参数误降级及权限状态验收；Windows/Linux 系统通知按用户要求暂缓。基线 7939602。

Codex 改为在隔离 app-server 进程注入相同六类会话 Hook，经只读 hooks/list 确认目标 cwd 下六类 sessionFlags Hook 均启用且配置无错误；不执行 Hook、不新增信任、不发模型请求。原生 0.159.3 已实际返回六类 Hook。resume 使用真实 config/read 与 thread/read，不再靠固定版本号判断。Claude 没有同等 Hook 能力 RPC，采用已测 2.1.286 为最低 exec-form 基线，允许稳定 2.x 更新；未知主版本/预发布/畸形输出保持降级，SessionStart 才能确认连接。允许升级不等于所有未来版本事件语义已验收。

参数扫描仅放行已核实的交互选项：模型、思考强度、既有权限模式等；保留原参数传递，不改审批/沙箱策略。配置覆盖、目录/会话切换、子命令、缺少值及未知参数仍明确降级。三项新增回归先出现编译红灯，再实现；Rust 100 测试、前端 57 测试与模块覆盖阈值、Clippy、签名流程 6 测试、原生隔离包与编译 Helper 冒烟通过。Converge preflight 实际仍为 coverage uncovered，未安装工具/重建索引/放宽门槛。

真实 Claude 会话 s-1a0f7a023f5-0 携带 --model fable --effort low，集成 connected；实际执行 15 秒无文件副作用的 Python Bash 命令，产出 YAM_CLAUDE_PERMISSION_OK 并形成单条 response_ready 回执。现有全局 Bash(*) 自动许可导致没有 PermissionRequest，不能冒充审批验收。后续使用仅本次测试进程的 settings source 和空 allow 列表触发原生请求；全局配置不修改。

实际复现了 Claude 双重审批提醒：原生 PermissionRequest 带工具身份，Notification(permission_prompt) 重复同一提示但不带工具身份，导致第二条回执及无法被 PostToolUse 清除的 unknown 权限。先修改订阅/归一化回归观察断言失败，再移除重复 Notification 订阅，仅保留原生 PermissionRequest；没有新增时间窗口、猜测合并或吞掉真正不同的请求。

最终原生隔离权限验收：s-1a0f7b3a83e-0，Claude 主会话 ced11d1b-0821-4630-9f8b-cc04a7b59e7d，原生 prompt_id 8f4a5a57-9edf-41fe-916a-ea4833e5b2b1。真实 Bash /usr/bin/printf YAM_PERMISSION_FIXED_OK，仅选择一次 Yes，未保存许可规则。HistoryStore 顺序 working/revision 2 → needs_permission/3（仅一条、一个工具 key）→ matching PostToolUse 后 working/4（keys 清空）→ response_ready/5（仅一条）。两个独立未读回执分别是审批与回复，不是两个审批。最终输出 YAM_PERMISSION_FIXED_DONE；连接始终 connected，CLI 仍 running。临时脱敏证据 /tmp/yam-claude-fixed-permission-evidence.jsonl，已执行状态顺序与计数断言。

测试为真实 CLI → 编译 Helper → 原生 YAM Bridge/HistoryStore；为触发审批，仅本次进程使用 project settings source、空 allow 和 default 模式，同时保留本机 provider/模型。正常默认全局 Bash(*) 启动的模型/effort 参数另已原生验收；不能把隔离测试说成默认全局配置会请求审批。全局 settings 文件 SHA256 未变、项目既有 trust 未变；临时外部导入 warning bookkeeping 精确恢复。没有新增辅助功能权限；临时 wrapper 已删除、验收 CLI 与应用退出、运行模式恢复 task。Codex hooks.state 与原 15 项基线完全一致。

原生验收另外发现再次运行 Claude 被命名为 Interactive shell，且任务 prompt 丢失于默认标题；实际 startSession 协调器测试先失败，再改为依据后端返回的 launch/adapter/prompt 命名。58 个前端回归与覆盖门槛通过，原生再次运行的标题为 Claude Code。最终 Rust 100 回归、Clippy、原生 build、编译 Helper 冒烟通过。

剩余状态：Windows/Linux 通知按本轮用户要求暂缓；Codex PermissionRequest → matching ToolProgress 的本轮原生测试待六个 Hook 的临时信任答复。Converge coverage/Trace/Review v3 仍未覆盖：本机 guard 不识别项目 Node coverage 阈值，Rust LLVM coverage 工具链缺失；未改全局 Suite、安装工具或重建用户索引。已有 Developer ID 证书为 0，正式签名/公证实物与跨构建旧通知/安装迁移验收仍是外部条件；既有流程及检查已实现。全局 claude-mem/graphify 报错不属于 YAM Helper，未修改外部插件。

最终业务提交：2c2ff7b57ed7ecdedb5b2929f5f265835eecea7d，已推送 codex/reliability-closure。精确业务 SHA 的 GitHub CI 36871796571 三平台均 success（Windows NSIS、Ubuntu deb、macOS app/archive），包含 Node 覆盖阈值、build、fmt、Clippy、Rust 回归、macOS 签名流程 mock 与打包。回执：https://github.com/ainiaa/yam/actions/runs/36871796571。这不等于 Windows/Linux 实际通知验收或 Developer ID 签名；运行模式、临时 wrapper、项目 import warning 与全局信任已恢复/清理。文档收口提交使用 skip ci，不将旧业务 SHA 的 CI 冒充新业务变更通过。
