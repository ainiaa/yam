# YAM 可靠性修复计划

**目标：** 修复审查确认的9项缺陷，并补齐直接相关的必要能力。

**基线：** `8f198a1`；顺序执行，先红灯测试、再修复、再绿灯验证。沿用Tauri/Rust/React和JSON存储。

## 范围与验收

| 任务 | 目标 | 验收 |
|---|---|---|
| T1 | 历史数据安全 | 损坏历史报错且保留原文件；保存失败显式返回并保留之前的磁盘与内存记录；备份恢复与旧记录兼容 |
| T2 | 会话生命周期安全 | 应用退出显式停止并等待会话；停止清理同一会话的子孙进程且不影响其他会话；终态单次发布并释放运行资源；空闲只提醒而不自动杀进程 |
| T3 | 终端输出一致性 | UTF-8跨块正确解码；日志快照与实时输出按序号去重且不丢失；后台缓存有上限并可从日志恢复；终态等待输出排空 |
| T4 | 跨平台结构化Agent启动 | Agent提示词通过argv传递不经shell拼接；shell和自定义命令兼容；Codex/Claude支持结构化单任务模式并识别协议成功与失败；缺失或不可执行CLI返回清晰错误 |
| T5 | 任务状态与通知可靠性 | Working可切换为Waiting；失败发送可重试并按事件ID去重；通知带项目任务名称并抑制前台活动任务；通知点击定位会话并兼容重启后恢复 |
| T6 | 项目和会话操作 | 目录选择按依赖批准结果实现并校验目录；会话重命名可持久化；按状态筛选且与搜索共同工作；清晰显示历史写入和终端输入失败 |
| T7 | 综合验收与持续验证 | 三平台CI运行Rust与前端验证；故障测试覆盖并发停止与爆量输出；计划文档逐项记录真实验证证据和未覆盖平台项 |

## 执行步骤

### T1：历史数据安全

文件：`apps/desktop/src-tauri/src/lib.rs`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

### T2：会话生命周期安全

文件：`apps/desktop/src-tauri/src/lib.rs`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

### T3：终端输出一致性

文件：`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/session-stream.ts`、`apps/desktop/src/App.tsx`、`apps/desktop/tests/session-stream.test.mjs`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

### T4：跨平台结构化Agent启动

文件：`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/App.tsx`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

### T5：任务状态与通知可靠性

文件：`apps/desktop/src/App.tsx`、`apps/desktop/src/session-stream.ts`、`apps/desktop/src/notifications.ts`、`apps/desktop/tests/session-stream.test.mjs`、`apps/desktop/tests/notifications.test.mjs`、`apps/desktop/src-tauri/src/lib.rs`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] macOS系统通知中心实际点击与退出后点击验收（当前原生SDK通知两项通过；Windows/Linux真实桌面点击仍待对应环境）

### T6：项目和会话操作

文件：`apps/desktop/src/App.tsx`、`apps/desktop/src/App.css`、`apps/desktop/src/workspaces.ts`、`apps/desktop/tests/workspaces.test.mjs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/Cargo.lock`、`apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/package.json`、`apps/desktop/pnpm-lock.yaml`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

### T7：综合验收与持续验证

文件：`.github/workflows/ci.yml`、`apps/desktop/package.json`、`README.md`、`docs`

- [x] 写入正常、边界、异常回归测试
- [x] 运行测试并观察失败
- [x] 最小修复实现
- [x] 定向测试、构建通过
- [x] 复核并记录证据

## 约束与证据边界

- 新依赖需用户批准；用户已批准必要dialog/deep-link/single-instance和平台SDK依赖及推送分支运行CI。
- 不改变已有CLI权限、模型或安全设置；结构化任务模式保留CLI自身权限策略。
- 交互模式的文本提示仅辅助展示，不据此宣布任务完成。
- 本机验证macOS；Windows/Linux只能通过CI矩阵证明，未运行前不得称实机验证完成。
- Converge preflight：缺少CodeGraph索引及coverage配置，记录为工具验证未覆盖；已有code-review-graph可用于影响分析。
- 对任意会话输出进行解析不等同于真实Agent协议认证；协议模式显式选择。

## 执行记录

T1 已完成：新增历史损坏、备份恢复、保存失败、重新打开测试。红灯 3 failed；绿灯 Rust 17 passed。

T2 已完成：后台进程树红灯复现通过修复；并发停止、Map释放、退出等待、空闲提醒测试通过。Rust 21 passed；Windows taskkill 分支等待CI。

T3 已完成：偏移去重、乱序重叠、缺口检测、缓存上限、Unicode边界、自然退出孤儿进程测试通过；Rust 24 passed，前端8 passed，构建通过。

T4 已完成：literal argv、Windows 路径与引号、非法参数、Codex/Claude 分块协议与失败/权限拒绝测试通过；Rust 28 passed，前端构建通过。

T5 已实现：先红灯再修复通知失败重试、并发去重、最新状态提示；终态通知待发送标记与回执持久化，启动恢复重试；原生发送错误反馈、点击选择会话、前台抑制。notify-rust 直接声明已获用户授权。回执测试通过。原生 OS 发送与回执持久化无法构成一个原子事务，崩溃窗口可能重复；应用关闭后点击旧通知尚未覆盖。

T6 已实现重命名与状态筛选，名称校验测试红灯→绿灯；目录选择插件仍待用户批准，保留手工路径入口。

T7 已添加三平台 CI；本机前端12测试、Rust30测试、Clippy通过。复核补充了Unix输出读取取消，避免终态输出关闭失败后线程永久阻塞。原生构建发现已有 opener Rust/JS minor 不一致，已将前端已有依赖对齐为2.7.0。

原生复核记录：Unicode输出、完成状态、空名称校验、重命名、活跃状态筛选及重启名称恢复已实测。第一次/第二次 Cmd+Q 清理了后台进程却没有保存终态；本轮补充 macOS自定义Quit菜单（默认预定义菜单调用NSApplication直接终止），增加shutdown_complete守卫和最终退出清理。通知恢复曾弹出use_default应用选择窗口，现显式设置com.yam.desktop标识；两项等待新版原生复测。

图审查报告给出124处变更符号、118个测试关联缺口（无法关联Rust内联测试及TypeScript模块）；这不是覆盖率结果。实际执行测试覆盖解析器、历史存储、停止并发、输出及通知队列；未配置正式coverage闸门。

最终原生复测：Cmd+Q 后后台 sleep 已消失，磁盘历史为stopped（Stopped by user），退出清理闭环通过；use_default选择弹窗修复后未再出现。追加“自然退出后停止不重分类”红灯回归后修复。

Windows补充：原生Job Object绑定会话进程，停止和自然退出终止Job，最后句柄关闭自动终止关联进程；新增Windows专属句柄关闭测试，本机无法运行。portable-pty先启动再绑定Job，绑定前极短的派生窗口仍需Windows实测；严格消除此窗口需要支持暂停启动的PTY接口。ABI字段按[Microsoft官方结构定义](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)核对。

最终检查：Rust33 passed；前端12 passed；Clippy -D warnings通过；前端构建和macOS调试app打包通过；cargo fmt与git diff --check通过。Vite有xterm主包超过500KiB提示，未引入额外拆分机制。三平台CI已配置，未推送/运行远端CI。

首轮结束时缺口（由下方续修记录更新）：目录选择插件待既有授权问题答复；Windows/Linux运行验证、操作系统通知点击实测及应用关闭后旧通知唤醒路由未完成；CodeGraph/coverage工具闸门未配置。上述项不计为已验证完成。

## 已知缺陷闭环表

| 原问题 | 实现与证据 |
|---|---|
| 退出依赖Drop，正常Quit不清理 | 显式退出监督、完成守卫、macOS受控菜单；原生Cmd+Q进程清理+磁盘stopped实测通过 |
| 只杀根进程/前台进程组 | Unix会话与子孙清理，独立会话不受影响的真实进程测试；Windows Job代码与平台专属测试已补，待Windows运行 |
| 损坏历史静默归零、写入错误吞掉 | 备份恢复、保留损坏证据、保存失败回滚内存、错误事件；故障与重启测试通过 |
| 已结束Session句柄及后台缓存残留 | 终态移除Map，输出缓存按字节和会话数限制；资源释放与缓存测试通过 |
| Windows提示词使用POSIX shell拼接 | Agent统一literal argv，npm shim直接调用Node入口；特殊字符、路径、引号测试通过 |
| 快照与实时缓存重放重复 | 单调字节偏移、重叠截取、缺口重取快照；重放测试通过 |
| 分块UTF-8损坏 | 增量解码并处理EOF尾部；Unicode跨块/非法序列测试通过，原生中文emoji输出通过 |
| 旧Working提示覆盖新Waiting | 比较最新提示位置，任务模式优先协议事件；Working→Waiting回归通过 |
| 发送失败提前计入已通知 | 成功后计入回执、失败保留重试、并发去重、终态pending持久化；队列与回执测试通过，OS点击仍待实测 |

首轮记录：当时只有notify-rust直接声明已获批准，opener为已有依赖minor版本对齐。目录dialog依赖尚未加入。代码留在codex/reliability-closure工作区，未提交、未推送、未发布。


## 授权后续修记录（2026-10-01）

用户已批准必要依赖及提交推送修复分支。首轮修复已提交2a145ba并推送；真实CI [36806784559](https://github.com/ainiaa/yam/actions/runs/36806784559) macOS通过，Windows暴露Unix测试import未按平台限定，Linux32/33测试通过但PTY fixture保留slave使read_to_end永远等EOF。旧run已取消，已修复两项并等待新head验证。

已接入官方directory dialog；选择后复用后端目录校验，取消不修改目录。picker正常/取消/错误回归通过，前端13项测试和构建通过。

已替换旧通知发送链路：macOS UNUserNotificationCenter持久请求+保留delegate；Windows原生protocol toast+当前用户快捷方式身份+yam协议注册；Linux兼容portal/GNOME持久action+当前用户desktop/D-Bus service启动注册。SDK与插件依赖均在授权范围内。移除不用的旧notification插件及notify-rust直接声明，避免两套权限状态冲突。

冷启动通知代理在Tauri Builder.build插件初始化阶段注册，早于事件循环开始；点击目标先保存在后端，前端注册监听后再读取，成功打开后确认，旧确认不覆盖新点击。URL仅接受yam://session/s-...并核实历史记录存在，不执行URL内容。解析与暂存回执正常/边界/异常测试已补。

Linux不支持退出后激活的generic freedesktop通知服务明确返回错误，保留重试。Windows/Linux CI验证编译、测试和进程清理，不等价于交互桌面通知点击实测。原生通知发送与历史回执持久化仍不是原子事务，崩溃窗口可重复。


### 最新验收结果

提交 `5dc47d4` 的 [CI 36809821929](https://github.com/ainiaa/yam/actions/runs/36809821929) 三平台全部success：macOS Rust45/45、Linux44/44、Windows35/35；三平台前端13项测试、生产构建、Rust fmt及Clippy -D warnings全部通过。Linux旧PTY EOF卡死已消失；Windows Job关闭测试改为先确认进程running、再验证3秒内退出，不依赖OS未规定的终止退出码。Linux元数据的路径校验显式按Linux路径语法，跨平台运行测试不误用Windows规则。

macOS原生新增实测：目录对话框取消不改值，选择项目根目录正确回填并保存；UNUserNotificationCenter权限关闭时明确报错且pending保留，临时启用YAM权限后系统接受请求并将历史回执持久化为false；本次验收的权限、提醒样式与通知中心快捷键开关都已恢复原设置。调试包先用ad-hoc签名绑定com.yam.desktop进行SDK验收，发布仍使用自己的正式签名身份，不在产品配置中硬编码调试签名。

macOS系统协议冷启动实测通过：先Cmd+Q退出并确认进程不存在，再在Chrome输入yam://session/s-1a0f56ef9fd-2并确认系统打开YAM；进程由系统重新启动，前端准确选中对应Completed会话、日志中文emoji正确显示。测试浏览器标签页已关闭。此项证明系统启动与前端就绪前暂存路由，不替代UNUserNotificationCenter旧通知响应的直接点击验收。

macOS通知中心直接点击实测（2026-10-01）：经用户授权使用AppleScript操作实际通知列表，临时开启ChatGPT辅助功能并由用户认证。运行中先选中其他历史会话、后台完成`notification-current-live`，点击系统通知后准确选中`s-1a0f5889695-0`，显示Completed及中文emoji输出；点击前后进程均为17340，没有重复实例。退出后用另一个新任务`notification-current-cold`复核：先选中Unicode smoke，等待系统通知，Cmd+Q退出并用pgrep确认进程不存在；随后直接点击保留通知，系统启动进程20141，准确打开`s-1a0f589ca78-1`，Completed及中文emoji日志正确。整个冷启动验收没有手动启动应用。另一个较早的banner-smoke通知也已唤醒应用。验收结束后，ChatGPT辅助功能已恢复off，原有Codex Computer Use权限保留；用户当前已开启的YAM通知权限保留。

样本边界：较早遗留的`notification-live-smoke`测试通知点击没有切换会话，未确认该通知的生成版本与请求标识，不能用它证明当前实现通过，也不能将上述当前SDK样本通过外推为历史实验通知兼容。当前版本新发送通知的运行中点击及发送后退出再点击均已直接验证。

剩余验收边界：Windows/Linux没有本地交互桌面，CI不验证通知中心真实点击；macOS当前原生SDK通知的两项直接点击验收已完成。通知冷启动实现、依赖、目录选择、三平台编译和测试都已完成。CodeGraph/coverage仍是未配置工具闸门，不是已运行覆盖率结果。
