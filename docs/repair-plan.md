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

- [ ] 写入正常、边界、异常回归测试
- [ ] 运行测试并观察失败
- [ ] 最小修复实现
- [ ] 定向测试、构建通过
- [ ] 复核并记录证据

### T6：项目和会话操作

文件：`apps/desktop/src/App.tsx`、`apps/desktop/src/App.css`、`apps/desktop/src/workspaces.ts`、`apps/desktop/tests/workspaces.test.mjs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/Cargo.lock`、`apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/package.json`、`apps/desktop/pnpm-lock.yaml`

- [ ] 写入正常、边界、异常回归测试
- [ ] 运行测试并观察失败
- [ ] 最小修复实现
- [ ] 定向测试、构建通过
- [ ] 复核并记录证据

### T7：综合验收与持续验证

文件：`.github/workflows/ci.yml`、`apps/desktop/package.json`、`README.md`、`docs`

- [ ] 写入正常、边界、异常回归测试
- [ ] 运行测试并观察失败
- [ ] 最小修复实现
- [ ] 定向测试、构建通过
- [ ] 复核并记录证据

## 约束与证据边界

- 新依赖需用户批准，目录dialog插件等待答复。
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

尚未闭环项：目录选择插件待既有授权问题答复；Windows/Linux运行验证、操作系统通知点击实测及应用关闭后旧通知唤醒路由未完成；CodeGraph/coverage工具闸门未配置。上述项不计为已验证完成。

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

所有新增依赖中只有notify-rust直接声明已获批准，opener为已有依赖minor版本对齐。目录dialog依赖尚未加入。代码留在codex/reliability-closure工作区，未提交、未推送、未发布。
