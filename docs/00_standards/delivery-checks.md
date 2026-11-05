# YAM 交付检查与复核

作者：Jeff.Liu

## 推送前完成

1. 冻结本次范围及保留行为。先检查被改动规则的保存、恢复、执行入口，以及序列化、长度、异步切换和平台权限边界；不在长 CI 接近结束时才补查已修改的系统 API 契约。
2. 先写或更新回归并观察失败，再做最小修改。执行时保留日志：源码 HEAD 和未提交 diff 摘要、命令、退出码、通过/跳过数量、耗时。测试不能启动本机桌面应用，既有 opt-in 保持关闭。
3. 先跑定向检查，再跑本次需要的完整验证。相同源码、相同命令已有通过结果时复用；修复只重跑受影响检查及必要回归。性能对照需要的重复运行单独标明，不作为日常重复验收。
4. 在本地稳定提交上完成独立源码复核，集中修复确认的问题。复核输入一次提供：需求/保留行为、基线与当前提交、diff、调用边界、实际验证记录、未覆盖项。只读 reviewer 不负责在沙箱里重跑需要写临时文件的检查；代码评审不等待远端 CI，也不以自己的最终结论为前提。
5. 推送经复核的稳定提交。最终检查前端、原生、`desktop` 三个作业都成功，PR HEAD 与 CI head SHA 相同。CI 新发现的真实问题仍须修复并在新提交重新验证；保留旧结果，不当成新提交的放行凭证。

## 复用现有定向入口

在仓库根目录执行，按改动选择，不要求每次全部执行：

| 改动范围 | 提前运行的检查 |
| --- | --- |
| CI / 质量门槛 | `node --test apps/desktop/tests/ci-workflow.test.mjs`；`python3 -m unittest scripts.test_project_quality scripts.test_project_mutation -v` |
| 终端构建资源 | `python3 -m unittest discover -s scripts -p test_terminal_runtime.py` |
| Pi 策略、导入导出、模型标识 | `node --test apps/desktop/tests/preferences-backup.test.mjs apps/desktop/tests/pi-routing-ui.test.mjs`；`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked portable_pi_policy_export` |
| 原生异步执行与上下文 | `node --test apps/desktop/tests/native-codex.test.mjs apps/desktop/tests/pi-native-context.test.mjs` |
| Git 索引/快照/文件权限 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked git_context::tests -- --test-threads=2`；首次推送前核实所改标准库 API 的平台权限要求 |

涉及普通与覆盖率构建差异时，比较 `cargo test -- --list` 和 `cargo llvm-cov --no-report --no-cfg-coverage -- --list`（均带项目 manifest 与 `--locked`），确认测试名称集合一致。列表验证不代替实际测试。

## CI 覆盖与缓存

- `frontend` 与 `native` 在独立 macOS runner 并行；各自准备所需终端资源。前端测试前仍生成原生权限 schema。
- `native` 用完整 crate 的 `cargo llvm-cov --no-cfg-coverage --fail-under-lines=85` 执行单元/集成测试一次。关闭额外 `cfg(coverage)`，保留普通配置语义；不筛选测试、不降低门槛、不复用旧 profile 数据。
- `desktop` 保留原有 required-check 名称，使用 `always()` 读取两路结果；任一路失败、取消或跳过均拒绝后续打包。成功后运行普通应用构建、doctest、实际后台生命周期、签名归档及产物上传。
- 测试产物名包含 `github.run_attempt`，同一提交重跑时保留各次独立产物，避免不可变同名产物冲突；归档内部文件名和签名验收不变。
- Rust 缓存按 OS、架构、工具链、依赖/工作流配置和作业用途隔离。只缓存依赖、编译输出及固定版本覆盖率工具；不缓存原始覆盖率 profile 或整个 coverage 根目录。覆盖率继续使用工具默认清理行为，缓存命中也必须实际执行测试。
- 工具/平台能力缺口在复核前注明。Windows 用例在 macOS 上不能视作运行通过；产品运行时的完整机器化 TDD 追溯未覆盖项不因 CI 优化而被改写为通过。

## 耗时对照

- 基线为提交 `a2a1372` 的 [CI 41941050828](https://github.com/ainiaa/yam/actions/runs/41941050828)：单作业 29 分 11 秒，普通 Rust 全量 8 分 7 秒，覆盖率全量 8 分 53 秒。
- 本机先记录旧的两轮 Rust 测试，再记录新覆盖率全量与 doctest；命令、测试集合、编译缓存状态及耗时分别保留。该对照不启动 GUI，不代替远端打包验收。
- 远端先运行新配置，再对同一提交完整重跑一次。分别报告首次缓存未命中、再次缓存命中与每个作业耗时。并行流程按最早作业开始到最终作业结束统计墙钟时间，排队时间另外列出，不累加并行作业时间冒充用户等待时间。
- 最终实测数值及运行链接写入 PR 说明；未经实测不承诺提速比例。只更新说明不更改已经验证的源码提交。

### 本机对照记录（2026-11-05）

Rust 1.98.1 / cargo-llvm-cov 0.9.1，已有本机依赖缓存；产品 Rust 源码未变。旧/新模式列出的测试名称集合完全一致：1138 项；实跑均为 1110 通过、28 忽略。新模式行覆盖率 87.16%，doctest 为 0 项。

| 检查链路 | 耗时 |
| --- | ---: |
| 旧：普通全量 146.901 秒 + 覆盖率全量 169.113 秒 | 316.014 秒 |
| 新模式首次运行：覆盖率 169.920 秒 + doctest 8.546 秒 | 178.466 秒 |
| 新模式热缓存运行：覆盖率 167.660 秒 + doctest 2.463 秒 | 170.123 秒 |

该热缓存样本的 Rust 阶段减少约 46.2%。这是单机顺序命令对照，包含编译与执行，已有依赖缓存，不能称为远端冷构建或整个 CI 的提速比例；远端并行与缓存效果另按同一提交两次运行实测。
