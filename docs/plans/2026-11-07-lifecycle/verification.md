# 生命周期实施验证

作者：Jeff.Liu

## 最终验证

最新验收结果为 `complete / ready`，无未关闭验收项，规格/质量独立盲审、最终 Trace 复跑与清单审计均通过。版本库中的 [acceptance.json](acceptance.json) 保存验收项、所验证源码/测试文件哈希、命令展示、实际退出码、测试计数、原始回执指纹及日志校验和；它是归档摘要，不是重新签发的原始回执。[evidence](evidence/) 中的日志规范化了主机路径和行尾空白，摘要同时保留原文件和归档文件的 SHA-256。

| 实际检查 | 结果 | 耗时记录 |
| --- | --- | --- |
| Node 全量覆盖率（文件并发 1，原阈值 95%/90%/95%） | 2613 通过、5 跳过；行/分支/函数 99.80%/94.58%/96.45% | 完整输出见 `evidence/frontend-coverage.txt` |
| `python3 scripts/native-coverage.py` | 退出 0，行覆盖率 87.27%，门槛 85%；清单逐项核对，无额外普通 Rust 全量测试 | 初次最终源码执行 153.20 秒；阶段数据随原始回执保留本地 |
| 启动保存及回合身份定向回归 | `lifecycle_start_` 5 项、`lifecycle_delivery_` 2 项，各三次通过；对应 RED 有真实断言失败 | 单次时长未单独保存，退出码/计数见机器摘要 |
| 冻结 Rust 变异 | 2 个生成、2 个捕获；包含 baseline 实跑 | 初次最终源码执行 100.59 秒 |
| Clippy / doctest / 前端构建 / 格式与 diff | 全部退出 0；doctest 为 0 项，构建体积提示保留 | 日志见 `evidence`；未计时项不推算 |
| 最终 native Trace 复跑 | 退出 0，重新执行绑定测试、变异、覆盖率和 CodeGraph | 314.04 秒 |
| 最终清单审计 | 退出 0，覆盖全部冻结清单 | 0.66 秒 |

不需要 Claude API 或订阅即可执行本轮本地回归；测试用本地事件、临时文件和故障注入，定向与终验进程移除了 Claude/Anthropic 凭证环境变量。独立审查实际使用 `codex-exec-v1 / openai`。没有真实 Claude、GUI、浏览器 opt-in 或 Windows/Linux 实机验收；未打发布包。远端 CI 不在此本地验收结论内，另以 [PR #4 的 Checks](https://github.com/ainiaa/yam/pull/4/checks) 和 PR 正文记录最终 HEAD 的实测结果；本地摘要不替代远端门禁。

## 首轮验证（以下为历史记录）

源码基线：`3472fc761d8e0b5aa5f979456fce135d3fbe72fa`。本轮仅有工作区改动，没有提交、推送或发布。既有未跟踪计划不属于本轮。原始输出位于仓库根目录 `.artifacts/lifecycle-20261107/`（忽略目录）；不能把此目录误解为计划目录的子目录。

## 已实施范围

T1–T5 已按顺序完成实现和定向红绿验证：异步 IPC、启动准备失败补偿、单任务最终保存重试、私有有界基线持久化、结果与当前任务变更/文件/记录输出入口关联。响应结束和进程结束均不等于测试通过或任务验收通过。

首轮独立源码复核确认 3 项缺陷，已合为一次修复批：目录别名误判、目录缺失后无法清除、删除清理未进入持久化恢复。新回归先观察到失败，修复后定向通过；历史事务在基线锁占用时保持未完成，重启后重放清理，其他任务的基线保留。元数据和清除不要求原目录存在，比较继续验证 canonical 目录及 inode。

## 最新源码整体检查（包含后续两项修复）

以下是实际执行记录，不是待执行命令。覆盖率全量分别只用项目现有入口；没有另外执行全量 `cargo test`。

| 命令 | 退出码 | 结果 | 墙钟耗时 |
| --- | --- | --- | --- |
| `pnpm --dir apps/desktop run test:coverage` | 0 | 2610 通过，5 跳过；行 99.80%、分支 94.55%、函数 96.45% | 56.04 秒 |
| `python3 scripts/native-coverage.py` | 0 | 1128 通过，28 ignored；行覆盖率 87.23%（门槛 85%） | 121.30 秒 |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 0 | 无警告 | 7.67 秒 |
| `pnpm --dir apps/desktop run build` | 0 | TypeScript 与 Vite 构建通过；保留现有体积提示 | 9.55 秒 |
| `cargo test --doc --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=2` | 0 | 0 个 doctest | 1.85 秒 |
| `git diff --check` | 0 | 通过 | 未单独计时 |

对应原始日志：`frontend-coverage-followup.log`、`native-coverage-followup.log`、`clippy-followup.log`、`frontend-build-followup.log`、`doctest-followup.log`。初次全量前端失败的两个旧夹具已更新，旧失败日志保留；并发 Git 测试新夹具补齐现有串行锁后通过。首轮复核原文为 `review-initial.log`。修复后复核 `review-final.log` 确认原三项关闭，又发现两种不同根因；保留旧轮并另开有限修复轮。最新源码复核保存在 `review-followup.log`。

## 跳过和证据边界

没有启动 GUI、浏览器或真实模型/CLI 验收，没有新建或运行另一个 YAM 应用实例，没有构建发布包。前端 3 项浏览器测试未开启 opt-in，2 项真实 Pi Markdown parser 测试未提供 SDK；Rust 的 28 项 ignored 保留项目原有保护。没有 Windows/Linux 运行结果，不以 macOS 单元测试代替跨平台或桌面验收。

Converge native 预检未识别现有 `python3 scripts/native-coverage.py` 入口，返回 `uncovered: coverage`；项目覆盖率实测通过不会自动修复适配器缺口。稳定 CLI 只读源码复核的原始结果也不冒充绑定的 Review v3 机器回执。本轮可报告实际实现和仓内检查结果，不能报告 Converge 正式完成门禁通过。没有为了适配门禁改动 Skill、降低项目门槛或新增依赖。

## 后续修复的实证

`followup-native-red.log` 观察到损坏的可选存储已导致删除提交的失败反例；`followup-ui-red.log` 观察到同一会话重连和 gap 恢复缺失待保存状态。修复后 `followup-native-green.log` 为 25 通过、2 ignored；`followup-ui-green2.log` 为 193 通过（均为定向子集）。

新增预检在发布删除事务前验证可选基线存储，已有损坏文件不会触发任务删除，不会覆盖未知快照，其他历史仍可读；应修复该存储后再删除。事务发布后的故障仍保留并重放清理；故障注入放在发布后，避免把删除前拒绝误当成恢复成功。重连和 gap 的实际回调在视图挂接完成后查询当前 session，既验证查询又验证 pending 状态恢复，不创建替代任务。

最终产品/测试源码哈希记录在 `followup-source.json`，验证后不再修改这些文件。计划文档和最终复核结果的补录不代替代码检查。

## 最终只读复核

`review-followup.log` 的稳定 CLI 复核退出码为 0，结论为“未发现本次改动引入的明确、可操作缺陷”。实际检查基线持久化、归档删除恢复、保存重试 RPC 及前端调用边界；没有重跑测试或启动 GUI。复核后再次核对产品/测试源码哈希，无变化。

本轮实现与仓内检查已结束，没有已知未关闭的同范围源码缺陷；Converge 正式机器化验收仍因 native 覆盖率入口适配和绑定 Review v3 回执未覆盖而保持未覆盖终态，不宣称正式门禁通过。原始两轮状态、失败与修复证据均保留，没有重置旧轮或修改 Skill 门槛。未提交、推送、发布或启动应用。
