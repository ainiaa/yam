# YAM 交付检查与复核

作者：Jeff.Liu

## 推送前完成

1. 冻结本次范围及保留行为。先检查被改动规则的保存、恢复、执行入口，以及序列化、长度、异步切换和平台权限边界；不在长 CI 接近结束时才补查已修改的系统 API 契约。
2. 先写或更新回归并观察失败，再做最小修改。执行时保留日志：源码 HEAD 和未提交 diff 摘要、命令、退出码、通过/跳过数量、耗时。测试不能启动本机桌面应用，既有 opt-in 保持关闭。
3. 先跑定向检查，再跑本次需要的完整验证。相同源码、相同命令已有通过结果时复用；修复只重跑受影响检查及必要回归。性能对照需要的重复运行单独标明，不作为日常重复验收。
4. 在本地稳定提交上完成独立源码复核，集中修复确认的问题。复核输入一次提供：需求/保留行为、基线与当前提交、diff、调用边界、实际验证记录、未覆盖项。只读 reviewer 不负责在沙箱里重跑需要写临时文件的检查；代码评审不等待远端 CI，也不以自己的最终结论为前提。
5. 推送经复核的稳定提交。最终检查 `plan` 与所选路线的必需作业成功、`desktop` 门禁成功，PR HEAD 与 CI head SHA 相同。CI 新发现的真实问题仍须修复并在新提交重新验证；保留旧结果，不当成新提交的放行凭证。

## 稳定的源码复核入口

使用现有 Codex CLI 的原生只读 diff review，`BASELINE_COMMIT` 替换为本轮冻结的基线提交：

```sh
codex -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' review --base BASELINE_COMMIT
```

复核请求明确区分“源码应配置的检查/门禁”和“推送后才能取得的远端执行结果”，记录实际检查的提交、原始输出和退出码。源码无已知缺陷不等于整条 CI 已通过。适配器格式错误或把未来 CI 当成前置条件时，保留失败回执，使用稳定的只读源码入口继续复核；不伪造适配器通过，也不为输出格式重复跑完整测试或另建编排框架。已确认的源码缺陷必须修复，不能借替换入口跳过。

## 复用现有定向入口

在仓库根目录执行，按改动选择，不要求每次全部执行：

| 改动范围 | 提前运行的检查 |
| --- | --- |
| CI / 质量门槛 | `node --test apps/desktop/tests/ci-workflow.test.mjs`；`python3 -m unittest scripts.test_project_quality scripts.test_project_mutation scripts.test_memory_self_smoke -v` |
| 终端构建资源 | `python3 -m unittest discover -s scripts -p test_terminal_runtime.py` |
| Pi 策略、导入导出、模型标识 | `node --test apps/desktop/tests/preferences-backup.test.mjs apps/desktop/tests/pi-routing-ui.test.mjs`；`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked portable_pi_policy_export` |
| 原生异步执行与上下文 | `node --test apps/desktop/tests/native-codex.test.mjs apps/desktop/tests/pi-native-context.test.mjs` |
| Git 索引/快照/文件权限 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked git_context::tests -- --test-threads=2`；首次推送前核实所改标准库 API 的平台权限要求 |

涉及普通与覆盖率构建差异时，比较 `cargo test -- --list` 和 `cargo llvm-cov --no-report --no-cfg-coverage -- --list`（均带项目 manifest 与 `--locked`），确认测试名称集合一致。列表验证不代替实际测试。

## CI 影响面分流

- `plan` 对 PR 的完整 `base.sha...head.sha` 执行 NUL 分隔的原始 Git 差异检查，不只看最新提交。关闭 rename 折叠、外部 diff、textconv 和 submodule 忽略；Git 错误、超时、警告、缺失对象、非法数据或空差异均走全量。非 PR（含 main push）总是全量。
- 当前快速白名单只有同一夹具组的四个精确路径：`apps/desktop/tests/fixtures/provider_api.py`、`scripts/terminal-latency-probe.py`、`scripts/test_loopback_fixtures.py`、`scripts/test_terminal_latency_probe.py`。全部变更都必须是这些路径的普通文件内容修改，不能新增、删除、重命名、改类型或 executable 位。生产、混合、未知路径，以及 Updater/Catalog 夹具均走全量。扩白名单必须补调用影响和定向回归，不按 `.py` 后缀放行。
- `quick` 只准备 Node/Python 和冻结的 pnpm 依赖，执行 loopback 与终端共 16 项定向检查；不构建原生程序、应用或浏览器，不启动 GUI。新增测试数量可随需求增长，不以固定数量替代断言。
- PR 中修改 CI 工作流、选择器或其合约时，仍走全量，同时额外执行同一份 `quick` 任务验证启动前提和计时。该结果不能替代全量作业，不宣称本 PR 已走纯快速路线。
- `desktop` 保留 required-check 名称并始终汇总：计划必须成功；纯快速路线要求 quick 成功且三项全量作业均明确 skipped；全量路线要求前端/原生/打包成功，额外 quick 验证按计划要求 success 或 skipped。失败、取消、缺失、未知路线/标志均拒绝。12 项选择器/门禁测试覆盖真实 Git 差异及状态组合；以实际测试输出为准。

## CI 覆盖与缓存（全量路线）

- `frontend` 与 `native` 在独立 macOS runner 并行；各自准备所需终端资源。前端测试前用普通 `cargo test --doc` 同时生成原生权限 schema、执行 doctest 和生成可复用代码，替代仅生成检查元数据的 `cargo check`。
- 内存自采样在 `native` 覆盖率测试之后运行，复用同一 runner、同一 `CARGO_LLVM_COV_TARGET_DIR` 中唯一的当前测试程序；缺失或歧义即失败，不回退到普通构建缓存。采样 helper 的额外 profile 写入空设备，避免污染已完成的覆盖率结果。选择逻辑用 Mock/临时普通文件验证，不在本机启动验收 App。
- `native` 用完整 crate 的 `cargo llvm-cov --no-cfg-coverage --fail-under-lines=85` 执行单元/集成测试一次。关闭额外 `cfg(coverage)`，保留普通配置语义；不筛选测试、不降低门槛、不复用旧 profile 数据。
- `package` 仅在前端和原生两路都成功且 `!cancelled()` 时运行普通应用构建、实际后台生命周期、签名归档及产物上传；doctest 已由前端门禁执行一次，不在打包后切换测试依赖再编译。新提交取消旧运行时，打包仍可被取消。
- `desktop` 以 `always()` 运行轻量 checkout 和 Python 路线门禁，不执行构建/上传；长打包作业不得使用 `always()`。[GitHub 取消语义](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
- 测试产物名包含 `github.run_attempt`，同一提交重跑时保留各次独立产物，避免不可变同名产物冲突；归档内部文件名和签名验收不变。
- Rust 缓存按 OS、架构、工具链、Cargo 锁文件/清单/config 及作业用途隔离。缓存代号为 `v3-lines`；前端新增普通 doctest 编译输出使用 `v3-lines-docs`，仍回退旧前端缓存以复用依赖。原生和打包键不变，避免无关的冷编译。不把工作流排版或每个提交 SHA 加入缓存身份，避免不相关 CI 修改使依赖缓存失效、每个提交重复保存大缓存。允许回退到同平台/工具链/用途的已有缓存，Cargo 仍核对当前源码和编译参数的指纹。只缓存依赖、编译输出及固定版本覆盖率工具；不缓存原始覆盖率 profile 或整个 coverage 根目录。覆盖率继续使用工具默认清理行为，缓存命中也必须实际执行测试。
- 工具/平台能力缺口在复核前注明。Windows 用例在 macOS 上不能视作运行通过；产品运行时的完整机器化 TDD 追溯未覆盖项不因 CI 优化而被改写为通过。

## 耗时对照

- 基线为提交 `a2a1372` 的 [CI 41941050828](https://github.com/ainiaa/yam/actions/runs/41941050828)：单作业 29 分 11 秒，普通 Rust 全量 8 分 7 秒，覆盖率全量 8 分 53 秒。
- 本机先记录旧的两轮 Rust 测试，再记录新覆盖率全量与 doctest；命令、测试集合、编译缓存状态及耗时分别保留。该对照不启动 GUI，不代替远端打包验收。
- 日常只跟进一次自动触发的 CI，不为测热缓存追加全量重跑。快速路线按所选任务实测；包含生产/CI 改动的 PR 保持全量，快速任务的并行验证另标为任务实测，不能当成纯快速 PR 的完整墙钟时间。历史冷/热对照仅保留为已完成的实验记录。并行流程按最早作业开始到最终作业结束统计墙钟时间，排队时间另外列出，不累加并行作业时间冒充用户等待时间。
- 最终实测数值及运行链接写入 PR 说明；未经实测不承诺提速比例。只更新说明不更改已经验证的源码提交。

### 本机对照记录（2026-11-05）

Rust 1.98.1 / cargo-llvm-cov 0.9.1，已有本机依赖缓存；产品 Rust 源码未变。旧/新模式列出的测试名称集合完全一致：1138 项；实跑均为 1110 通过、28 忽略。新模式行覆盖率 87.16%，doctest 为 0 项。

| 检查链路 | 耗时 |
| --- | ---: |
| 旧：普通全量 146.901 秒 + 覆盖率全量 169.113 秒 | 316.014 秒 |
| 新模式首次运行：覆盖率 169.920 秒 + doctest 8.546 秒 | 178.466 秒 |
| 新模式热缓存运行：覆盖率 167.660 秒 + doctest 2.463 秒 | 170.123 秒 |

该热缓存样本的 Rust 阶段减少约 46.2%。这是单机顺序命令对照，包含编译与执行，已有依赖缓存，不能称为远端冷构建或整个 CI 的提速比例；远端并行与缓存效果另按同一提交两次运行实测。


### 全量耗时核对（提交 bbfe292）

[CI 41968979200](https://github.com/ainiaa/yam/actions/runs/41968979200) 总耗时 8:30：原生 5:43、前端 5:32 并行，再串行打包 2:39。原生覆盖率阶段 246 秒，其中实际测试 188.35 秒，其余约 58 秒为编译/报告；前端覆盖率 167 秒，两次 WebKit 共 54 秒；打包阶段含真实构建 48 秒、普通 doctest 37 秒、生命周期 14 秒、缓存恢复/保存共 32 秒。阶段名称并不只代表打包压缩。

前端日志中单项较慢者包含浏览器 opt-in 防护 10.69 秒、逃逸子进程/管道回收 5.44 秒，以及多项 App 回调测试的 2–4 秒执行；Rust 日志在真实 worktree 清理测试组中有多次 5–13 秒无完成结果的间隔。这些是后续定向计时线索，不能把完成结果间隔当作独立单测耗时。当前稳定 Rust 不支持 `--report-time`，不为采集指标开启不稳定编译开关。

本轮记录各全量 runner 的 CPU、有效并行度和内存，消除机器容量假设。快速分流与缓存身份优化不代表已经优化这些测试实现；后续须针对热点验证夹具初始化、事件等待和源码处理成本，再决定改动，不直接调大并发或缩短业务超时取得速度数字。
