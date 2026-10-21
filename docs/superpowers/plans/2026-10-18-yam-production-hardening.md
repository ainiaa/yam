# YAM 生产加固计划（2026-10-18）

作者：Jeff.Liu

用户已授权先计划、再按 TDD 顺序实施。本计划使用 Converge Plan / writing-plans；根控制器唯一写入，多模型只读侦察与独立复核。

## 边界与基线

- 基线源码：`4c6bfaa17cf6fa888c03a98ac1f855fc2910a37b23405114ca136307c2052f18`；HEAD：`8fb2cb00c32a5ae72b48f0d04776eec1420734ab`。保留已有 260 项工作区变更。
- 不调用真实厂商、不替换或重启现有 YAM.app、不向现有任务输入或停止任务。保留原生 TUI。
- 能力事实来自后台启动准备时解析到的 CLI，随会话代际存档；旧数据明确未知。
- 压测仅用临时目录、合成日志和隔离 HistoryStore。无新依赖、SDK、全局 CLI 配置修改。
- Converge 历史证据不重写；新鲜验证修复当前证据链，工具不支持项保留 uncovered。

## 顺序步骤

### T1 — Launch-time CLI version and receipt capability facts survive history and render truthfully for current and legacy sessions

- Background owner records bounded CLI version and platform from the same resolved launch executable; no GUI-side probing or provider request
- Old records and unavailable integration show unknown/unverified capability; successful hook setup never claims every receipt delivered
- Claude Esc limit and Codex macOS 0.162.1 format guard remain visible; no terminal input interception

范围：`apps/desktop/src-tauri/src/agent_bridge.rs`, `apps/desktop/src-tauri/src/agent_events.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/agent-events.ts`, `apps/desktop/src/App.tsx`, `apps/desktop/tests/connection-details-ui.test.mjs`, `apps/desktop/tests/agent-events.test.mjs`。

TDD：先补断言并保存真实 RED；已有行为的负载基线按实测记录，不制造假红灯。最小实现后执行以下冻结命令并做独立复核。

```sh
rtk node --experimental-strip-types --test apps/desktop/tests/connection-details-ui.test.mjs apps/desktop/tests/agent-events.test.mjs
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml agent_bridge -- --test-threads=2
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml agent_events -- --test-threads=2
```

### T2 — Bounded long-log observation preserves identity and termination under isolated parallel readers

- Synthetic 16 MiB history per observer, 8 simultaneous independent sessions, exact final outcomes and foreign-turn rejection
- Each observer ends within 15 seconds; record baseline and current timings with total bytes/readers; optimize only on observed failure or measured bottleneck
- Truncation, replacement, oversize, partial lines, original process exit and deadline remain fail closed

范围：`apps/desktop/src-tauri/src/codex_outcome.rs`。

TDD：先补断言并保存真实 RED；已有行为的负载基线按实测记录，不制造假红灯。最小实现后执行以下冻结命令并做独立复核。

```sh
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml codex_outcome -- --test-threads=2
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml outcome_load -- --ignored --nocapture --test-threads=1
```

### T3 — Concurrent event ingestion keeps session and generation isolation under bounded sustained load

- 8 concurrent sessions, 32 turns each through the actual isolated HistoryStore ingestion boundary; zero cross-session or duplicate receipts
- Check stale generations, duplicate/late terminal events, persistence reload, and exact final states; finish within 30 seconds
- Never mutate installed app state, existing owner or real task histories

范围：`apps/desktop/src-tauri/src/agent_events.rs`。

TDD：先补断言并保存真实 RED；已有行为的负载基线按实测记录，不制造假红灯。最小实现后执行以下冻结命令并做独立复核。

```sh
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml agent_events -- --test-threads=2
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml agent_parallel_load -- --ignored --nocapture --test-threads=1
```

### T4 — Current source has an auditable integrated verification record with explicit remaining production boundaries

- Every verification receipt matches the exact frozen argv and current task source; historical receipts remain immutable
- Re-evaluate Single State and native coverage binding using official helpers; resolve supported gaps and report unsupported runner/tool limits honestly
- Full frontend, Rust, web build, isolated CLI protocol checks and independent spec/quality review pass; installed app hash, mtime, owner and original sessions unchanged

范围：`docs/superpowers/plans/2026-10-18-yam-production-hardening.md`, `docs/yam-capability-matrix.md`, `docs/yam-release-hardening.md`, `docs/00_standards/test-commands.yml`, `docs/00_standards/quality-targets.yml`。

TDD：先补断言并保存真实 RED；已有行为的负载基线按实测记录，不制造假红灯。最小实现后执行以下冻结命令并做独立复核。

```sh
rtk pnpm --dir apps/desktop test
rtk pnpm --dir apps/desktop build
rtk pnpm --dir apps/desktop test:coverage
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=2
rtk cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml provider_native_tests -- --ignored --test-threads=1
```

## 交付条件

每步同步真实结果与源码回执；最终分别报告源码自动化、CLI 协议、桌面激活、真实厂商和 Converge 机制证据。后两项受当前授权边界限制，不能称已生产验收通过。

## 本轮实现结果与证据边界

作者：Jeff.Liu。

| 步骤 | 已完成的源码与本地验证 | 复核 |
| --- | --- | --- |
| T1 | 启动时版本 / 平台存档，未知与未连接提示，复用一次可执行路径解析；17 前端、27 桥接、30 状态测试连续三轮通过，Web 构建通过 | 规格与质量均通过；两项发现先补红灯后修复 |
| T2 | 8 路各 16 MiB：基线全部超过 15 秒，最终最慢采样 0.7535 秒；15 常规回归及显式负载测试连续三轮通过 | 规格与质量均通过；截断后恢复先红后绿，逐条描述符保护保留 |
| T3 | 8 会话 × 32 轮：256 条精确回执、去重、代际隔离、确认 / 已读与重载；30 常规测试及显式负载测试连续三轮通过 | 规格与质量均通过；补强独立预期断言，未改持久化业务语义 |
| T4 | 执行上方冻结的全量前端、Rust、构建、Node 覆盖率、CLI loopback 命令，并重新验证负载及运行环境保护；最终状态以同源清单和严格审计为准 | 在当前源码上做组合规格与质量复核；不等同原生启用验收 |

本轮工件根目录：

`/Users/liuwenyuan/.codex/visualizations/2026/10/16/01a143d9-337c-73b3-a49b-9c3cb6457139/yam-desktop-optimization/production-hardening-20261018`

- `execution-plan.json` / `task-results.json`：精确命令、每步源码链、范围及通过回执。
- `plan-audit-final.json` / `delivery.json`：最终当前源码的严格审计与分层交付判定；没有通过回执的项目不能计为 verified。
- `t2-baseline-load-*` / `t2-repair-load-metrics-*`：同一日志夹具的真实失败及修复后指标。`alive() == true`，不包含原生进程状态查询成本。
- `t3-exact-load-*`：完整轮次约 15.51 秒、P95 约 1.003 秒；包含共享存储的全部逐次操作，不是单 RPC 延迟。30 秒断言是完成耗时门槛，外层回执执行器有独立 600 秒超时。
- `converge-current-diagnostics-*`：官方构造与校验的原始状态范围拒绝、native coverage 未覆盖及实际工具清单；诊断命令退出 0 只表示成功收集诊断，**不是 native complete**。
- `coverage-tool-diagnostic-*`：临时小程序的 Rust profile 与系统工具不兼容实测；**不是应用覆盖率**。
- `planning-baseline-correction.json`：保留侦察起点及初版计划，仅将执行起点校正为已在首次业务写入前捕获、包含计划 Markdown 的 T1 起点；需求、路径和验证命令不变，历史回执不改写。

### 尚未覆盖，不能转为通过

1. 现有固定包及后台保持，候选没有做 GUI / TUI / IME / 原生通知与重启验收，也没有真实厂商调用。
2. Converge 的受管状态需要区分“原有脏基线”与“任务增量”；当前 schema 校验的缺陷无法靠扩大 allowed_paths 解决。本轮没有修改 Suite 或伪造受管状态。
3. 当前 Suite 没有 Node 原生测试 / coverage 适配，本机也没有匹配的 Rust coverage 工具；系统 LLVM 15 无法合并 Rust LLVM 22 的 profile。本轮不安装依赖、不新增无法执行的 coverage 配置。原生 TDD / coverage / mutation / 图谱完成绑定没有通过，不声称 Suite 全通过。
4. Claude Esc 外部终态仍为已知限制；Codex 补充失败回执仍只覆盖既有 macOS / 0.162.1 格式及受信 hooks。

以上是明确的验收边界。当前源码的确定性验证、隔离压力结果和计划审计，与受管机制、桌面启用及真实服务分别报告。
