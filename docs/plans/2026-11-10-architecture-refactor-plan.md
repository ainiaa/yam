# YAM 架构拆分计划

基线为 `fbf15fc4fccfdcfce9451056d83028b7ef8d75bf`。本计划按模块职责拆分实现，不设置源文件行数或字节数上限。每个切片先补行为回归，再搬迁对应实现，并在原入口验证调用链。

## 执行约束

- 外部行为、IPC 命令、序列化结构、错误语义、异步取消和恢复行为保持不变。
- 新模块拥有清晰的业务职责和稳定接口。调用方不保留重复实现或只转发的兼容层。
- 每个切片必须有正常、边界和失败路径的可执行回归，且覆盖状态新鲜度、并发或权限边界中与该切片相关的部分。
- 每批结束运行对应定向测试和构建。涉及 Rust 的批次还运行匹配的 Rust 测试与 Clippy。
- 不启动桌面 GUI，不改应用标识，不增加依赖，不触发发布或外部操作。

## 阶段 1：按模块职责设置质量门禁

目标是让质量检查能验证模块边界与模块行为，而不是按文件体积判定质量。

- 保留现有 Rust crate 覆盖率、前端工具模块覆盖率和 CI 质量检查入口。
- 对每个新抽出的模块增加聚焦单测或现有集成回归，覆盖模块公共接口的正常、边界、异常行为。
- 质量测试核验模块入口被正常调用，且关键 UI 行为回归运行，不用源文件行数作为验收指标。
- App 源码 AST 抽取型测试夹具必须显式注入其依赖的新模块 helper。全量 coverage 曾捕获 `terminalViewConstruction` 从 App 抽出后，projection、line-height、settings、clear、cursor、layout restore 与 session recovery 等真实入口夹具仍按旧闭包假设执行的问题；已补齐依赖绑定，并通过全量前端覆盖率验证。
- 验收命令为 `python3 -m unittest scripts.test_project_quality scripts.test_project_mutation scripts.test_memory_self_smoke scripts.test_native_coverage -v`，以及各后续阶段冻结的定向命令。

## 阶段 2：App.tsx

按用户可见职责顺序拆分，保留 React 组件作为组装入口。

1. 终端选择上下文与草稿投递。把目标快照、可投递判定、输入守卫和失败语义放入终端选择模块。覆盖取消、会话/轮次变化、失焦、写入排队、投递失败和单次写入。
2. 终端视图生命周期。把创建、恢复、缓存、销毁和视图有效性相关的控制流程收敛到终端会话模块。覆盖窗口切换、owner 断连、过期回调和异步恢复。
3. 更新器设置与轮询。由现有 `UpdaterController` 承担所有权，App 只传递用户动作和显示状态。覆盖取消、轮询重叠、代次变化、下载/安装失败。
4. 会话详情与 review/agent 上下文。复用已有 `review-feedback.ts`、`terminal-selection-context.ts` 和 `SessionInbox` 边界，避免重复派生状态。

已完成选择上下文判定与草稿投递、terminal view 构造配置与 dispose 顺序、原始日志重放代次/parser 完成边界，以及完整 updater React hook（状态、startup、status polling、定时检查、用户动作）。App 保留窗口 admission、布局/焦点和 React setup 的组装职责；这些流程依赖同一批 React refs，当前不引入携带大量闭包的通用控制器。会话详情/review 上下文继续复用现有模块，无重复派生状态的新需求。

每个切片验收为对应 Node 测试通过、`pnpm --dir apps/desktop build` 通过，新增模块由正常 UI/回调入口使用。

## 阶段 3：lib.rs

保留 crate 根作为模块声明与 Tauri 命令注册入口，将会话业务状态和命令实现按职责迁入现有模块或新建模块。

1. 会话输入与 Agent 草稿 admission。迁移 `DraftInputGuard` 和 `write_session_guarded`，保持历史锁、PTY writer 锁、版本校验和写入顺序。
2. Agent receipt 与 session lifecycle 命令。把 receipt 读取、会话状态变更及相关代理调用按现有 `agent_events`、`history` 职责归属。
3. 启动与命令注册支持代码。将环境配置、命令组和测试专用实现从 crate 根移出，保持命令名、参数结构和权限门禁。

已完成 terminal input admission、`read_agent_receipt` command adapter、`session_manager` 的 history 所有权/持久化恢复/Agent runtime/有序关闭，以及 `app_lifecycle` 的 owner/GUI 退出与 macOS reopen。crate 根继续承接类型、会话进程编排和 Tauri 命令注册；既有命令适配不为降低体积批量改可见性。

每个切片先新增状态/并发/拒绝路径回归，再迁移实现。验收使用匹配过滤器的 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`、`cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings` 和 `cargo test --doc --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`。

## 阶段 4：background.rs

按后台 owner 协议职责拆分，保持 wire protocol、认证、请求上限和 CLI/GUI 共用行为。

1. RPC wire types、编码解码和请求边界。
2. command argument contract 与 dispatch 表。
3. owner connection、生命周期、线程与关闭恢复。
4. 后台命令适配与测试分组。

当前已抽取 `background_wire` framing、`background_contract` 参数名合同、`input_leases` 控制权模块、`background_relay` 有界事件缓冲/游标/gap 协议，以及 `background_events` 事件轮询重试和 lifecycle 通知准入策略。Relay 缓冲行为、轮询重试/失败、通知准入已有模块测试。本轮继续将 command argument/dispatch 表迁入 `background_dispatch`，owner startup/idle shutdown 迁入 `background_owner`，Tauri poll loop/event dispatch 与 lifecycle 通知迁入 `background_events`。调用方直接使用模块入口，测试仅在 cfg(test) 下引入私有 helper。

每个切片增加正常请求、未知命令、无效参数、认证拒绝、消息上限、重复请求/重连及关闭恢复的对应回归。Relay 与 event retry/准入策略切片均已完成。验收通过相关 Rust 测试、Clippy、doctest、`python3 -m unittest scripts.test_background_smoke -v`（包含于本轮 85 项质量/后台测试组合）和 `git diff --check`。桌面生命周期 smoke 只在不启动 GUI 的已授权替代路径内执行。

## 阶段 5：集成复核

- 运行前端覆盖率命令 `pnpm --dir apps/desktop test:coverage`，确认现有 TypeScript 工具覆盖门禁仍通过。
- 按项目路线运行 Rust 覆盖率 `python3 scripts/native-coverage.py` 一次，不额外重复全量 `cargo test`。
- 运行前端构建、Rust Clippy、doctest、全量质量单测、`git diff --check`。
- 对最终调用链复核 UI 事件到 Rust 命令、后台 owner dispatch、history 持久化与恢复入口，记录未验证项。

本轮续作引用 `codex://threads/01a1ca10-f78c-79d1-bdf1-fea9db71a992`，已通过宿主 read_thread 读取，并回溯读取其原始审查 chat。沿用原工作区未提交修改；基线 HEAD 为 `fbf15fc4fccfdcfce9451056d83028b7ef8d75bf`。未 commit/push，未启动 GUI。验证快照包括 54 个变更/新增文件（不含本证据文档），按排序路径、NUL 和文件内容计算 SHA-256：`a1ae2d08f727ee3132d5cf259be891d26b70b33e79f50d5589ac197c3968b503`。

2026-11-11 本机验证记录（最终源码仍为工作区差异，日志位于 `/tmp/yam-resume-*20261111.log`）：

| 命令 | 退出码 / 结果 | 耗时 |
| --- | --- | --- |
| `python3 -m unittest scripts.test_project_quality scripts.test_project_mutation scripts.test_memory_self_smoke scripts.test_native_coverage scripts.test_background_smoke -v` | 0，89 项通过 | 2.67s |
| `python3 scripts/project_mutation.py --output /private/tmp/yam-mutation-resume-20261111-01` | 0，40 baseline 用例、8/8 mutants killed | 原始 campaign 日志保留 |
| `python3 scripts/native-coverage.py` | 0，1,163 通过 / 28 ignored；行 87.37%、区域 86.89%、函数 80.55% | 编译 21.856s；测试最长组 71.631s（与 worktree 51.138s 并行） |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked background -- --test-threads=2` | 0，158 项通过（event dispatch 最后搬迁后定向复验） | 28.93s |
| `cargo test --doc --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | 0，0 doctest | 1.32s |

Rust coverage 已全量执行一次；随后 event dispatch 纯迁移只定向复验 background 组并完成 Clippy，不重复全量。最终构建退出码 0（8.40s），最终 Clippy 退出码 0（5.88s）。重放相关真实 App/hook 回调测试 462 项通过；Reopen 间接夹具 19 项通过。最终前端 coverage 退出码 0（52.18s）：2,909 通过、5 skipped，行 99.81%、分支 94.04%、函数 96.36%。独立只读复核退出码 0（640.60s），结论：未发现可由当前改动明确复现的行为回归。命令为 `codex -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' review --base fbf15fc4fccfdcfce9451056d83028b7ef8d75bf`，原始日志 `/tmp/yam-resume-independent-review-20261111.log`；reviewer 未重跑测试、未启动 GUI。`git diff --check` 通过。GUI 生命周期、真实安装/打包和 Windows 专属路径未执行；既有大 chunk 构建警告仍在。

计划按顺序执行，不并行写同一工作区。每个阶段通过后再进入下一阶段。发现公共行为差异或验证缺口时，停在当前阶段修复并复验。
