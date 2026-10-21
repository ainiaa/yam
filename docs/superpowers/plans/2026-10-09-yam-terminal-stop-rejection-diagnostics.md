# STOP rejection diagnostics — finite source/test receipt

作者：Jeff.Liu。日期：2026-10-09。

本片仅更新两个既有 Python 验收脚本与对应测试，给已有匹配响应保留安全拒绝类别。实现与 GPT-6.1-sol 独立 spec/quality 审核通过；它不是原生 STOP 修复或性能改进，也不是面向用户的新终端功能。

## 冻结行为

- 在已有 version/instance/request/client 匹配与字符串 Err 校验之后分类：`missing_session` 仅限 `stop_session` 且响应等于本请求 `session_id` 构造的完整 `Unknown session: …`；`owner_shutting_down` 仅限完整原生字符串 `Background is shutting down; reconnect`；其他字符串为 `other_server_rejection`。不做子串、errno 或原因推断。
- `ServerRejected` 保留固定异常文本与 allowlisted 枚举，不保留原始响应、token、路径或会话标识；无参数构造与显式 `error=True` 兼容行为保留。
- 新产出的 fixture diagnostics 使用严格 version 2：仅 `server_rejected` 允许且必须具有合法非空 `rejection_kind`，其他 outcome 必须为 null；未知枚举、缺失/额外字段和不一致关系被拒绝。
- 保留 STOP/STOP/shutdown 顺序、次数、预算、身份屏障、fallback 与清理继续执行；原 `stop_failed` 不改成成功。没有新增 RPC、轮询、重试、计时器、生产者或清理策略。

## 验证与边界

新增 6 项测试通过既有 synthetic socket seam 执行实际 `rpc` 与 `Run.close`，覆盖正常、错误会话/命令、未知敏感消息、畸形或不匹配响应、兼容构造、成功响应、严格 schema 与继续清理。首次运行 6 tests，1 failure/11 errors：v1≠v2 与实际 wire/close 缺少诊断字段属于行为 RED；单独构造器缺少属性属于 API 契约 RED，不能单独作为端到端语义证明。没有 import/syntax/fixture scaffold failure；原始日志保留。

实现后定向 6 项及两套共 134 项 helper 测试通过，diff 检查通过；GPT-6.1-sol 独立重跑 134 项并完成 spec/quality 审核，均 PASS、无 finding，两次 134 不累计为不同覆盖。既有 128 项断言保持，唯一旧预期行增加必需的 `rejection_kind: null`。

184 文件源码 map 的本轮变化恰好为下列四文件，当前 aggregate 为 `df2ddaa35db73ba435bbe24c2d8d5dbc262b9c7b26e5bedf8f238e369ac8119b`，文档不计入该源码 map：

- `scripts/background-smoke.py`
- `scripts/test_background_smoke.py`
- `scripts/terminal-owner-responsiveness.py`
- `scripts/test_terminal_owner_responsiveness.py`

未运行新 owner、PTY、网络负载、native/GUI、build、全前端或 benchmark；不构成 full A11/Suite 完成。R9 原 version 1 证据不可变，拒绝原因仍 UNKNOWN；本片不重新解释其 STOP、fallback、graceful 或吞吐结果。未来实测必须使用另行授权、当前源码新构建与新 gate，不能复用 R9 授权。updater 继续暂停。

源码 lease 在独立审核后已实际释放。contract、raw RED/GREEN、RED 分类澄清、独立审核、184 before/after maps、exact4 preimages/afterimages 及 lease 回执位于外部 capsule `/tmp/yam-terminal-stop-rejection-diagnostics-20261009`；四文档快照与 manifest 随有限归档保存到 `/Users/liuwenyuan/.local/share/yam/development-archives/20261009-terminal-stop-rejection-diagnostics/evidence.tar.gz`，成员 SHA 与重开校验由外部回执记录。原始日志、JSON 和归档不进入 Git。
