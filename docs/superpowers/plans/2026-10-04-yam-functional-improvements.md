# YAM 功能优化与逐步闭环计划

作者：Jeff.Liu。日期：2026-10-04。状态：用户已授权先规划、再逐步实施；每项通过测试及独立复审后进入下一项。

## 本轮目标与已决事项

优先完善日常功能流程。自动更新的后续开发、安装及发行验收暂停，保留已交付代码，版本稳定后再恢复。OpenCode 等 Agent 的原生续聊差异只记后续研究，不算本轮缺陷；后续核实官方协议及可验证身份，不假设上游永远不支持。第三方材料批次不作为本轮主线。

已有 dirty 工作区必须保留。沿用 Tauri/Rust/React/xterm、认证 owner、现有 CLI 与输入租约；没有新依赖、数据库、插件框架或外部服务。任务启动、输入接管、Git写操作仍由用户明确操作；本轮不会发布或提交 Git 历史。

## 顺序与验收

| 步骤 | 用户可用结果 | 验收重点 |
|---|---|---|
| F1 恢复指引 | 失效会话明确说明当前状态；可查看历史，显式重新运行或使用现有可信续聊入口 | 窗口关闭但任务存活时不显示已丢失；session lifecycle needs_attention 与 Agent response-ready 不混淆；未知原因用固定说明；读取不自动启动任务、不接管输入；迟到回包不能操作另一会话 |
| F2 分屏操作 | 保留现有 1/2/4 固定布局，双屏可调整比例、键盘调节和重置，可交换面板位置 | 比例20–80%；空槽/同槽/失效索引；交换保留选中会话、终端实例与输入租约；旧布局偏好兼容，损坏回退；所有保存ID仍由当前owner核实，失效整体回单面板 |
| F3 任务结果查看 | 在当前项目/会话目录内查看 Git 修改文件及只读差异 | staged/unstaged/untracked明确区分；Unicode/二进制/大文件/取消；有界输出与deadline；目录或owner变化使旧结果失效；不执行external diff/textconv/filter、不stage/commit/merge |
| F4 跨项目命令模板 | 应用内命名、编辑、复制、删除和选择启动模板；套用到启动表单，再由用户启动 | 复用现有LaunchDefaults与支持的adapter；schema版本、数量/长度预算、损坏存储；UI明确模板会保存prompt/command文本；不保存解析后的环境密钥、不自动信任仓库yam.json；不套用模板就启动 |
| F5 待处理事项 | 权限、回复待处理和故障用可操作卡片展示，定位当前会话终端 | 轮次/权限/终态分开；已过期事件不误操作或清未读；按钮只定位终端并复用现有查看语义；未经可验证原生协议不伪造“批准/拒绝”应答，不关闭CLI审批策略 |
| F6 日志保留范围 | 搜索与导出明确当前保留范围、是否已截断，避免误认为完整输出 | 有可靠offset时显示实际范围，缺失时标未知；32MiB历史/8MiB日志/2000行预算保持；不声称找回已丢输出；保存取消/已有文件/切换会话竞态保持 |
| F7 联合收口 | 上述功能在同一实际App控制链共存，文档准确区分源码完成和实机验收 | 不回退通知、归档、owner验证、输入租约及启动可信配置；受影响自动化/构建通过；原生验证用新的隔离样本，工具或平台不可用如实保留未覆盖 |

F2 的面板交换先提供按钮/键盘入口，拖拽交互按同一任务实际实现可验证的方式补齐；不扩为任意嵌套布局。F3 首批交付只读结果查看；提交、合并与PR写操作另有明确操作契约时再扩展。F4 是可共享使用的应用模板，不建设动态Adapter执行框架。F5 卡片提供可用的终端处理入口；结构化原生应答作为协议能力研究，不冒充已实现。

## 实现及验证契约

每项先核实实际代码和调用链、冻结最小 owned paths，再补正常/边界/异常失败测试，最小实现，运行定向及相关回归，停止源码写入进行 Root/Astra 独立复审；发现同范围问题先复现修根因，然后复核。当前共享工作区只有一个实现写入者。新任务开始时重新绑定上一个完成状态，不能借旧测试宣布新功能完成。

F1/F2/F4/F5 优先复用现有 Node 实际App回调测试及静态组件夹具；F3涉及Rust/后台则执行 locked 定向及全量Rust、fmt/clippy与Node；F6按实际前后端改动运行对应测试。统一 `rtk proxy pnpm --dir apps/desktop test:coverage`、`rtk proxy pnpm --dir apps/desktop build`、`rtk proxy git diff --check`。TS工具覆盖率不等于React/native覆盖率。正式Converge coverage没有配置时保留 uncovered，不降低阈值。

原生验收不重用旧T06/T20样本冒领当前实现，不启动真实Agent或操作用户工作目录来代替测试。没有新依赖或外部发布授权。本计划从用户已有授权直接顺序执行，不要求逐项重复确认。

## 当前入口与边界

恢复入口：App的选中SessionRecord、rerunSelectedSession/resumeSelectedSession 与生命周期事件；Agent阶段另由agent-events处理。布局：TerminalLayout、terminal-layout、terminal-layout-persistence及App fit/resize/protected views。结果：GitContextPolling、认证owner与只读git_context。模板：ProjectConfigPreview、LaunchDefaults与已有启动dialog。待处理：inbox/AgentReceipt及openReceipt。日志：SessionLogSearch/SessionLogExport与session_logs。

自动更新暂停与原生续聊差异的研究记录由本文件及当前能力表统一说明；之前冻结证据不改写。
