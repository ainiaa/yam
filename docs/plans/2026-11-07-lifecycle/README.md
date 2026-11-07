# YAM 任务生命周期修复与优化

作者：Jeff.Liu

基线：`3472fc761d8e0b5aa5f979456fce135d3fbe72fa`。需求来自当前会话的生命周期审查及用户“先修复已知问题，再借鉴 Orca，先落实优化计划，然后逐步实现”的授权。

## 最新结论

2026-11-07 的最终源码已完成六项验收，Converge 状态为 `complete`，用户回执为 `ready`。规格和质量独立盲审均通过，最终 Trace 复跑及清单审计退出码均为 0，本轮任务锁已释放。详情见 [正式验收](formal-acceptance.md) 和 [可公开的机器摘要](acceptance.json)。以下首轮记录保留历史语义，不能用其中旧的未覆盖结论替代最新验收结果。

用户随后明确授权整理、提交和推送本轮改动，暂不发布。源码、测试、当前计划摘要和验收日志纳入版本库；其他任务的未跟踪资料保持原状。原始 `plan.json` 与完整 Source Receipt 含本机其他任务文件清单，保留本地，不纳入公开提交；原始指纹及本计划的 T1–T5 摘要保存在 `acceptance.json`，该摘要不冒充可重新验证的原始 Plan/Evidence Receipt。

## 执行范围

沿用现有 Tauri 后台 owner、Shell、PTY、历史记录和 Pi，不增加依赖或运行时。实施和验收阶段没有启动本机 GUI、提交、推送或发布；提交与推送按上述后续授权执行，发布仍不在范围内。已有其他事项的未跟踪计划和证据不属于本次改动。

| 顺序 | 可验收结果 | 验证边界 |
| --- | --- | --- |
| T1 | 输入、缩放、单任务停止不在 GUI 主线程等待 owner | 复用启动入口的异步 dispatch；保留输入顺序、窗口 ticket 和所有权；扩展现有 dispatch 回归 |
| T2 | 启动记录提交后的准备失败明确结束为失败 | MockRuntime 注入 Shell 准备错误；没有子进程、没有假 starting、记录和日志可读、重试不受阻 |
| T3 | 对已退出任务单独重试最终保存，不终止其他任务 | 复用 pending_finish/finalizer；只允许已退出任务；保存失败保留记录，重复调用不重复通知 |
| T4 | 任务 diff 基线跨 GUI 重启保留 | 私有有界文件、原子更新、绑定会话和目录身份；损坏/链接/超预算拒绝，显式替换和清除保持原行为 |
| T5 | 任务结果关联现有 diff/产物/验证入口，明确证据含义 | 展示“Agent 已返回/需检查”，不凭退出码或模型自述显示“测试通过”；保留现有回合与终端状态区分 |

T1–T5 顺序执行，共享模块不并行写入。每项先观察目标行为的红灯，再做最小实现并运行定向绿灯；结束时运行所需的跨模块检查与独立只读复核。验证记录保存在忽略目录 `.artifacts/lifecycle-20261107/`，记录源码、命令、退出码、耗时及跳过项。

## Orca 参考与行为映射

已实际读取 `stablyai/orca` 提交 `89fb7c8abedd6e3b6cea654f0414524e3887f439` 的以下源码；只借鉴行为，不要求技术栈或内部实现一致。

- [终止控制器](https://github.com/stablyai/orca/blob/89fb7c8abedd6e3b6cea654f0414524e3887f439/src/main/daemon/sessions/session-termination-controller.ts)：区分终止请求和物理退出，合并在途清理，失败后允许明确重试。映射到 T3 的现有 finalizer。
- [Shell 就绪屏障](https://github.com/stablyai/orca/blob/89fb7c8abedd6e3b6cea654f0414524e3887f439/src/main/daemon/sessions/session-shell-ready-barrier.ts)：就绪、超时和清理具有显式状态。参考其状态表达；本次不重写 YAM Shell 启动机制。
- [工作区创建占用](https://github.com/stablyai/orca/blob/89fb7c8abedd6e3b6cea654f0414524e3887f439/src/main/workspaces/creation/worktree-create-in-flight.ts)：异步工作保留身份，完成前不暴露错误归属。映射到 T1/T2 的原请求与记录一致性。
- [工作区生命周期](https://www.onorca.dev/docs/model/worktrees#per-feature-lifecycle)：工作区串联执行、Review、Ship、归档。映射到 T4/T5 的变更证据连续性；不增加自动提交、合并或远程托管。

| 输入/状态 | 输出和副作用 | 已知调用方 | 验证 |
| --- | --- | --- | --- |
| owner 慢响应，输入/缩放/停止 | GUI dispatch 异步；同一输入队列仍有序 | App → desktop_windows/lib → owner | session-start-responsiveness / session-actions / lifecycle-confirmation |
| 历史已 starting，准备失败 | 无子进程；持久化 failed；错误可追踪 | create_session / CLI start / Continue | coverage_state_tests 中的启动夹具 |
| 进程已退出，pending_finish 存在 | 只重试此 session 的保存和一次终态发布 | 单任务恢复入口 → finish_session_with | 最终帧失败、重试、重复调用及其他活动任务夹具 |
| GUI 重启后读取原基线 | 同一会话和目录返回原基线；不可伪造成功 | RunChanges → run_changes | run_changes 正常/异常/身份替换测试 |
| Agent 回合返回 | 展示结果及现有证据入口；验证未知保持未知 | App / 回合状态展示 | 无 GUI 的 UI callback / 文案契约测试 |

## 早期验收边界（历史）

项目已有覆盖率入口为 `python3 scripts/native-coverage.py`（85%），Converge 原生适配器当前未识别此脚本入口，预检返回 `uncovered: coverage`。执行选择器已允许继续有独立项目测试的实现；不得将该缺口写为 Converge 正式验收通过。GUI、真实 CLI/模型行为和跨平台原生验收单独标记，不以 Mock 代替。

## 实施补充

T4 同时处理已确认永久删除任务的基线清理，释放持久化容量；失败保留原数据并返回未完成清理，可用原删除 token 重试。归档保留基线。T5 复用当前任务的变更、文件和已记录输出，不新增验收状态或自动验收规则。仓库没有 CHANGELOG，本轮不创建发布文件。

## 首轮复核与修复批

独立只读源码复核发现 3 项同范围缺陷，集中修复：比较身份由后端 canonical path 与目录 inode 检查决定，避免把路径别名误判成目录变化；基线元数据/清除只验证本地会话与基线 token，不要求项目目录仍存在；基线位于 sessions/run-baselines，永久删除清理纳入已有持久化 transaction，锁占用或写入失败保持未完成，重启由既有历史恢复路径重放。未增加新事务系统或依赖。

目录缺失不会恢复文件或自动重建项目，比较和重新捕获继续要求有效目录。归档保留基线；永久删除释放被删任务的容量。

## 后续有限修复轮

首轮修复后的独立复核确认原三项已关闭，另发现两种不同根因：删除前已有损坏的可选基线存储会拖累健康历史；同一会话重连和事件缺口没有刷新待保存状态。旧轮保留为未覆盖终态，在原授权和同一聊天内建立第二个有限修复轮，未重置旧轮预算。

新增回归先观察到上述两项失败。删除现在在发布 transaction 前预检基线存储，损坏文件不自动覆盖、不删除任务数据、其他历史仍可用；发布后产生的清理故障仍由既有 transaction 重放。重连或缺口恢复完成当前视图挂接后，再查询该会话的最终保存状态，不重启任务。

## 首轮交付边界（历史）

五项实现及后续修复已落地。最新仓内结果：前端 2610 通过、5 跳过；Rust 1128 通过、28 ignored，行覆盖率 87.23%；构建、Clippy、格式和 doctest 检查通过。最后一次独立只读源码复核未发现明确可操作缺陷。详情及跳过范围见 [验证记录](verification.md)。Converge 正式门禁仍有已记录的工具/回执缺口，不标记正式完成；没有提交、推送或启动 GUI。
