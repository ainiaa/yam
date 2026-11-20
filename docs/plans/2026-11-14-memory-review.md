# YAM 剩余内存审查与修复计划

作者：Jeff.Liu

- 请求：为什么修改后仍占较多内存；继续仔细审查、确认可优化空间并在原授权内修复，先不发布。
- 起点：HEAD `b1a7b9d4d05c7af7d6929591dab13f4edabf9a0c`；实际源码 Source Receipt `14d9fc932a91516345eb4de92c163eeb5e5649601e123873a3967a219d32dd58`。完整原有脏文件清单保存在 `.artifacts/memory-review-20261114/baseline-source.json`，不还原前轮变更。
- 计划契约、画像、Provider binding、lease、原始采样保存在 `.artifacts/memory-review-20261114/`；宿主计划面板已同步。此处是普通任务证据，不声称受管 Single State / 自动 TDD Trace 认证。

## 执行顺序与验收

1. **审查与取证**：按真实进程拆分 idle 内存，记录同包界面重启对照；核实缓存、释放、帧刷新、侧栏隐藏行等路径。不能用 RSS 或虚拟地址空间代替 physical footprint。
2. **TDD 修复**：折叠已结束列表不调用行渲染；关闭终端搜索后恢复原有安全增量路径；同步到相同尺寸时不发送无效 resize。覆盖展开/关闭、活动搜索、选区、不安全状态、真实尺寸变化、在途回到原尺寸、失败与生命周期失效。保留数据、2000 行语义与原安全回退。
3. **验证与复核**：定向红绿、前端覆盖率与 build；更新唯一规范 debug App；固定相同历史和选中会话做候选启动后观察；用本地合成任务验证搜索关闭后持续输出。原始尝试均保留；检查未读计数、任务清场和进程身份。独立只读复核本轮增量。不开外部桌面应用、不发布。

## 已核实的审查起点

- 当前无任务，内存合计 456.69 MiB：WebContent 236.24、Node 108.93、桌面 30.61、后台 19.25 MiB，其余为同组系统辅助进程。口径是各进程 physical footprint 相加，共享记账未去重，PTY 任务和采样器排除。
- 同一 debug 包正常退出/恢复同一个已停止会话后，合计 451.39 MiB；WebContent 178.02、GPU 64.89、Node 108.93 MiB。界面重启未重启 Node；这是单点诊断，不是稳定窗口性能结论。
- Rust 终端附件 Drop 发 close，Node close dispose/delete，结束后从 manager 移除；前轮隔离验证已证明旧 renderer buffer 可回收，Node dispose 后 ArrayBuffers 可释放。这些证据不证明未知泄漏不存在。
- 已确认三处无效成本：折叠 ended details 仍创建全部会话和菜单；`view.find` 存在即永久阻断安全增量；每次输入成功后的尺寸同步无相同尺寸短路。

## 本轮结果

## 本轮实现与边界

- `EndedSessions` 保留原生 details/summary，只在展开时调用行 factory；关闭释放子树。内部菜单 toggle 冒泡不会改变父组。分组、计数、选中、pin、attention、搜索筛选、历史数据和行操作逻辑继续复用原实现。
- `appendProjectedOutput` 的准入与解析提交两端只阻止活动搜索，关闭的 controller 不再永久强迫全帧重放。真实 controller 关闭后 cursor 正确前移且 dirty 保持 false；重新打开读取当前缓冲；解析途中打开搜索会 dirty 回权威帧。所有身份、控制代次、尺寸、选区、模式和 FIFO 上限保留。
- `queueTerminalResize` 只在干净、无权威帧读取、无 resize 在途、frameSize 与 renderer 一致时省略重复请求。未知几何、dirty、失败重试和在途回原尺寸维持同步。新建/continue 首次附着保留原始初始同步。
- 独立质量复核发现 P2：poll 在 read 前清 dirty，旧 frameSize 不能代表 owner 仍处于原尺寸。实际 App 调用交错测试先红灯198通过/2失败，再增加 `!updating` 检查，绿灯269通过/0失败。唯一一次定向 re-review 返回需求通过、`code-review-pass`；同根因邻接路径未发现新问题。旧失败和通过均保留。

## 验证证据

源码 `327389367559a8d9655c7e9ea683512c4fdaa2214172faece6ff0752c840434e` 同时绑定最终定向测试、完整前端覆盖率、规范调试包和独立复核；本文件最终回填只改文档，最终完整性命令重新检查代码/测试字节未变。

| 检查 | 结果 | 命令 / 原始证据 |
|---|---|---|
| 首轮 TDD | 54通过/5失败、0运行错误 → 59通过 | `red.*` / `green.*` |
| 提交边界加强 | 64通过/2失败 → 421通过 | `commit-boundary-red.*` / `green-boundaries.*` |
| 独立复核修复 | 198通过/2失败 → 269通过 | `review-repair-red.*` / `review-repair-green.*` |
| 最终前端覆盖率 | 3108通过/0失败/5跳过；行99.80%、分支94.22%、函数96.64%；90.182秒 | `npm --prefix apps/desktop run test:coverage`；`frontend-repaired.*` |
| 最终规范 debug 包 | tsc、Vite、Tauri app 打包通过；19.258秒 | `npm --prefix apps/desktop run tauri -- build --debug --bundles app`；`debug-bundle-repaired.*` |
| 独立复核 | spec-pass；质量发现P2后定向复核通过，185.362秒且源码未变 | `codex -c sandbox_mode="read-only" -c approval_policy="never" review -`；`review-spec.*` / `review-quality.*` / `review-rereview.*` |
| 真实桌面 | 鼠标/Return展开关闭、内部菜单、38→104搜索匹配、关闭后持续输出、中文emoji通过 | `ended-gui-observed.json` / `stream-probe/gui-observed.json`；实际 CUA AX 与截图，初次候选7aaaa版；最终修复只增加resize读取中保守检查 |
| 本轮任务清场 | 实际先观测running，再观测stopped；active_sessions=0；通知策略恢复all | `stream-finish.*` / `stream-probe/result.json` |

未重复全量 Rust：相对本轮 Source Receipt，Rust、Node生产文件、依赖与配置未变；前轮 Rust 结果仅作历史背景，不冒充本轮重跑。五项现有 browser/Pi 集成仍跳过，未打开额外桌面测试 opt-in。构建仍有原有主chunk体积提示，没有通过上调警告门槛或新增依赖消除它。

## 内存结果与解释

1. 入场空闲单点456.69MiB（页面236.24、Node108.93、两个Rust49.86，其余同组系统服务）。GUI正常重启后单点451.39MiB，页面178.02、GPU64.89、Node不变；启动/图形缓存稳定后继续回落，不能把启动单点与稳态直接比较。
2. 独立120秒窗口：修复前355.6449MiB，首个修复候选355.6604MiB，差0.0156MiB，**未测出空闲总量下降**。两边各25样本/25原始尝试，核心身份固定、两秒稳定窗口，无任务、同一已停止的candidate4_0、历史未删，后台72191/Node72196不重启。页面中位数136.41→147.41、GPU15.94→11.19、Node108.93→105.54，不能把单进程降低算总收益。基线启动后老化时间更长；只作诊断，不作为严格因果/统计显著性或长期泄漏证明。该对照为7aaaa中间版，不能改写成最终327389版实测。
3. 活动搜索实际瞬时观测最高674.7MiB，关闭并返回实时后418.5MiB。说明保留缓冲的搜索/全帧重放会产生显著瞬时分配与回收波动；这些是实际现象，没有稳定窗口、JS可达性或堆对象归属证明，不能据此认定泄漏或声称已经彻底优化完毕。
4. 前轮同一解析器隔离归因（显式GC，非产品配置）：16个100列、2000保留行终端，line数组37.35MiB、解析缓冲8MiB、JS live heap约19MiB；dispose后ArrayBuffers可降到0.08MiB，RSS仍保留高水位。当前Node的105MiB physical footprint不能直接等同于活跃会话数据；本轮没有生产V8堆快照，不能精确声称其中每一MiB都无用或必要。

剩余可量化方向是活动搜索的整段缓冲扫描/重放分配、Node闲置期堆与分配器保留、首次加载的前端常驻成本。这些是后续需专项基准的优化方向，尚未证明存在新的泄漏。未以减少2000行语义、强制产品GC、重启后台隐藏数字或删除用户历史取得结果。本轮不作8小时稳定性结论。

## 最终包当前窗口与收口

最终修复源码327389版，60秒预热后120秒25样本/25尝试，总量中位数 **399.73 MiB**。页面217.78、GPU63.17、Node17.56、桌面35.06、后台19.77 MiB，其余为同组系统辅助服务。各进程中位数之和不强求等于逐样本合计的中位数。

该窗口场景为新增本轮一条已停止测试历史并选中它。采样发现最终包重开后后台从72191变为68717、Node从72196变为68772；单窗口内部身份固定，但不与前一窗口作性能因果比较，也不将Node降低归因于相同进程自然GC。`final-window-boundary.json`明确覆盖通用采样脚本描述的跨窗口边界；原始结果未改写。

最终 CUA AX/截图确认已停止、引擎就绪、116未读、中文emoji可读；此时footer394.2MiB是后续单点。实际运行状态active_sessions=0，本轮owned工作负载进程为空，GUI仅一个规范实例。最终包仅保留于`apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`。`/Applications/YAM.app`主程序SHA保持`32df709e04385248373ec8b6a708cc8f6168e06e33176b741d98e7bf51dfd7ef`，无commit、push、tag、发布或安装。

本轮已确认的三项无效成本及复核发现的resize交错缺陷均已修复并验证；**不宣称空闲内存已明显降低，也不宣称全部内存问题解决**。当前大头为WebKit页面与GPU，活动搜索和运行时历史仍是后续应测量的方向。当前普通任务记录不冒充受管Single State或自动Trace认证。

未覆盖：未重跑8小时长测；五项既有集成跳过；未取得生产JavaScript/V8可达性堆快照。正式计划完成审计与最终完整性回执写在`.artifacts/memory-review-20261114/plan-audit.raw.json`及`final-integrity-final.json`；只有命令实际成功才作为收口证据。

审计记录：首轮正式audit如实返回PARTIAL，原因是计划verification含非命令形式的GUI/复核说明，且任务只附最终完整性回执，argv集合未匹配。已保留`first-plan-audit.raw.json`、首轮plan/execution；将正式verification修正为实际可执行的`final-integrity.py`聚合门禁。该门禁逐项核对原定测试、完整覆盖率、打包、独立复核、GUI、最终窗口、清场与源码，验收和门槛未减少。修正说明见`verification-correction.json`。
