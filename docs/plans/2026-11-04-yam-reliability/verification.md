# YAM 可靠性改进（2026-11-04）

作者：Jeff.Liu

## 范围与实现

1. PTY 测试 fixture 在 Unix 上固定使用 `/bin/sh -c`，避免读取机器的登录 Shell 配置。修正原先用 `exec /bin/sh` 掩盖启动行为的断言，观察到失败后再修改 fixture。13 项恢复回归通过；修改前按 CI 的 zsh/双线程环境重复 6 轮均通过。集成时实际复现 `Rust85Session::drop` 等待 PTY 子进程退出卡住：线程采样指向 `Child::wait`，父进程关闭 PTY 后子进程立即退出。增加饱和 PTY 输出的确定性回归，先观察约 3 秒后失败，再修改 fixture 为非阻塞排空输出并有界轮询回收，删除无限 `wait`。远端旧 CI 是否完全由同一原因引起，仍需新运行验证。
2. 复用 Pi 控制快照与路由栏，显示原生模型发现、上下文准备、CLI 启动、首个回复事件、执行结束与失败位置。首个回复事件是从 CLI 调用开始到首个非空 `agent_message` 完成事件的时间，不冒充首字延迟；无观测的数据为空。诊断仅含阶段、来源和数字，不复制任务内容、凭据或 CLI 错误原文；只有本轮真正拥有执行权的请求可以更新它，被拒绝的重复请求不覆盖执行中的观测。
3. 复用语义检查点：同一原生身份与已验证前缀才增量交接；模型、推理档位、目录或实际发现的执行文件身份变化发送完整上下文（包括未配置路径覆盖的默认发现路径）。显示交接原因、实际字符数和 128000 字符预算。超预算停止并提示显式 `/compact` 或拆分；不新增摘要调用、不截断、不自动重放。覆盖重启、身份切换、中途取消和晚到事件；切换分支清空旧诊断。
4. 偏好备份增加 v2 的 `piRouting` 字段，v1 继续可读。保存/迁移角色、固定选择、规则及计费约束；不携带 Pi 网关地址和登录凭据字段。导入保留本机网关，未知字段/非法策略先拒绝，全部存储写入沿用事务式回滚。本机已有的仅订阅约束不能被导入或应用策略降低。配置页可显式使用已保存策略，并通过既有模型可用性检查；现有会话不改写。参数重建按解码后的终止符位置插入路由参数，保留带引号或转义的 `--` 及其提示词原文。模型 ID 保留版本后缀（如 `@2026`）和 Unicode，前后端统一按 UTF-16 计算 512 长度上限，并拒绝空白、控制字符及非法 provider。

## 参考边界

- [Orca](https://github.com/stablyai/orca/tree/1f0e6b60b1cb31fc3aebaf573da5957297c8c613)：借鉴运行身份与晚到事件隔离；沿用 YAM 原生会话代次，未移植独立守护进程体系。
- [OpenCode](https://github.com/anomalyco/opencode/tree/8568952e77be2137289d12ecf264bdfca7809578)：借鉴上下文预算、持久记录和禁止含糊副作用重放；压缩仍归 Pi，不实现另一套摘要器。
- [CC Switch](https://github.com/farion1231/cc-switch/tree/98777515d512519209510bce6352ae1984988c81)：借鉴配置来源诊断；本轮只报告 YAM 能证明的启动/会话配置来源，不推断用户 Shell 中配置冲突，不修改代理或登录。

## 验证入口

- `npm --prefix apps/desktop test`
- `npm --prefix apps/desktop run test:coverage`
- `npm --prefix apps/desktop run build`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=2`
- `cargo llvm-cov --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --fail-under-lines=85 -- --test-threads=2`
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`

T1/T2/T3 的本机验证均已通过；T3 完整前端为 2335 通过、3 项 opt-in 跳过。独立审查发现前置检查失败时诊断时序字段未初始化，以及排队微任务可能借用下一轮代次；已分别补红灯测试，初始化准备阶段/显式空值，并在调用入口冻结代次，在分发前和异步准备后拒绝过期请求。轮次/分支切换会取消旧执行的自有信号，完成与异常回执均按冻结代次隔离；旧分支保留未确认的运行回执供人工核对，晚到结果不写进新分支。首次最终 Rust 全量因上述 PTY 析构卡住而人工停止（只终止测试进程），该失败回执保留。后续全量发现三个替代输出读取器的测试仍未消费真实 PTY，已保留故障注入并为真实数据添加独立排空。相关 19 项恢复边界回归通过，之后 Rust 全量为 1109 通过、28 项按既有约定忽略。最终生产源码变化继续按下列命令验证。最终集成检查及独立审查的真实结果以本次交付回复和 `/tmp/yam-reliability-*.log` / JSON 命令回执为准，不把本段计划当成最终通过凭证。

## 发布限制

用户已授权提交并推送现有 PR #2；最终提交的独立复核和远端 CI 结论以 PR 检查及交付回复为准。v0.1.11 仍为草稿，本轮不合并或正式发布。本轮无界面验证，不启动桌面测试或额外验收 App。Windows 原生执行仍不在支持范围内。

## 初始本机验收快照（2026-11-05）

- 前端：2352 项，2349 通过、3 项显式 opt-in 跳过；覆盖率行 99.74%、分支 94.45%、函数 96.41%，项目门槛通过。
- Rust：1109 通过、28 项按既有约定忽略；行覆盖率 87.15%，85% 门槛通过。Clippy（禁止 warning）、格式及 diff 检查通过。
- 原生桥接、配置迁移和界面定向测试：85 项全部通过。真实 Pi 1.5.0 + 本地假服务完成事件/持久化契约验证；真实 Pi SDK + 本地假 Codex CLI 完成进程/流式事件/诊断验证，无外部模型推理。
- 前端生产构建及 Tauri debug app 构建通过；仅生成固定的 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`，名称 YAM、identifier `com.yam.desktop`、版本 0.1.11，深度严格签名验证通过。未替换 `/Applications/YAM.app`，未做 GUI 交互验收。
- 四任务计划在初始验证源码快照上审计为 DONE，范围无漂移。初始只读审查 CLI 未给出最终结论；后续复核和 CI 在现有 PR #2 继续进行，初始记录不作为后续提交的放行证据。

命令回执位于 `/tmp/yam-reliability-*-verified.json`；生产代码验证快照为 `697ff41c17b2ea7c4227f0c0b5ef64fd5ca8edc99d1cdfb7958548cf3e0fcc58`。最后仅补写本节报告，未再修改执行代码。

## PR 跟进修复

追加边界检查复现了模型可通过启动校验、却无法保存和导出的不一致。前后端先补失败用例，再修正模型 ID 字符及长度检查；覆盖 `@` 后缀、Unicode、512/513 边界以及空白、控制字符和凭据 URL 拒绝。正式结果由最新提交的独立复核及 CI 验证。
