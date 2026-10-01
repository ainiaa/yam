# Agent 能力证据
作者：Jeff.Liu。2026-10-01；macOS 本机；本阶段尚未形成正式支持声明。

| CLI | 实测结果 | 接入结论 |
|---|---|---|
| Codex 0.159.3 | SessionStart、UserPromptSubmit、Stop 携带可靠主 session/turn ID；连续双轮成功；Stop 续跑保持同一 turn，两次 Stop，仅最终回复触发 notify | 用主 SessionStart/Prompt 身份过滤 notify；Stop 本身不发送确定完成横幅 |
| Codex notify | 标题生成线程也触发 agent-turn-complete；线程身份与主会话不同 | 禁止“第一次 notify 就绑定主会话”的实现 |
| Claude Code 2.1.286 | 会话参数 --settings 的 SessionStart/Prompt Hook 执行，无 turn ID；本机正常回应未获得 | 保持普通交互终端；不宣称可靠每轮完成/resume 已验证 |
| 通用 CLI | 已有 PTY/退出状态/空闲提醒 | 无可信交互轮次完成证据 |

探针没有使用绕过信任参数。用户明确批准后，在 Codex Hook 审核界面逐项只信任 4 个临时 capture.py 定义，未信任两个已有未审核 Hook。Claude 仅临时信任 YAM 目录。结束后删除 4 个新增 Codex session-flags trust 条目，并恢复 Claude 项目的 hasTrustDialogAccepted；CLI 自己的界面/运行 bookkeeping 更新被保留，不能声称整个全局配置逐字不变。没有改 Hook 定义、审批或沙箱策略。

Codex 会合并独立 Hook 文件的定义；实测用户已有 Ponytail Hook 继续执行。但不能把这个结论推广到 config.toml 的同名 Hook 数组：本机 0.159.3 的隔离配置/只读 config/read 查询证实，命令行 -c hooks.Stop=… 会替换配置文件中的 Stop 数组。YAM 现检测四类拟注入的事件配置；存在既有非空数组或非法结构时安全降级，保留普通 CLI、原 Hook 与 notify，不安装 YAM Hook。其他事件和空数组不妨碍接入。此次查询未执行 Hook、模型请求或变更用户配置。

全局配置逐字比较的严格验收尚未全部通过；非 YAM 外部终端隔离、异常/权限/中断、Windows/Linux CLI 与完整 resume 待后续验证。用户先前选择保留新 Rust Helper 的真实双轮缺口，随后明确授权执行，并允许 4 项临时信任、测试后撤销。最新结果见下文，不以旧 capture.py 探针替代。

## Rust Helper 真实双轮（2026-10-01）
使用当前源码重建 com.yam.validation 隔离 .app，实际运行其中的 yam-desktop Helper。逐项只信任 SessionStart/UserPromptSubmit/Stop/Interrupt 的会话参数定义，另两个既有未审核 Hook 未信任。原生终端在 CUA 画面中空白、键盘焦点不稳定；审核时误关闭的一项原有 Hook 已立即恢复并核对。随后改用受控 PTY，沿用隔离 YAM 已注册的地址/凭据和相同 Helper 参数，将真实 CLI 事件提交到活跃 YAM Bridge/HistoryStore；因此本次证明核心链路，不证明完整原生启动/输入体验已通过。

Codex 0.159.3 PID 69140、主线程 01a0f6c3-833c-7092-85cf-5a8e6b68b832 连续回答 YAM_HELPER_ONE/TWO。两个 turn 分别为 01a0f6c3-f50d-7613-8227-329bd49c49a0、01a0f6c5-3102-77a1-9546-ed6fecefe687；进程在第二轮持久化后仍存活，YAM 状态 running。HistoryStore 产生两条不同身份/revision 的 response_finished 回执，第一条在第二轮后保持不变；界面展示 2 条未读和两个收件箱条目。

后台发送两次均得到明确 macOS permission denied；没有横幅/点击验收。失败记录仍未读，选择目标会话后转为 suppressed 也没有清除未读。结束后两项测试 CLI 及隔离应用均退出，历史状态 stopped、两条未读仍保留。精确删除 4 个新增会话信任条目，hooks.state 与测试前快照完全一致；CLI 自己的其他 bookkeeping 更新未回滚，不宣称整个配置文件逐字一致。脱敏验收回执位于 /tmp/yam-helper-live-evidence.json（临时证据，不含桥接凭据）。

复查冻结的脱敏事件记录：`rtk proxy python3 scripts/agent-hook-smoke.py --check`。这是历史探针断言，不会启动 CLI，不可充当新的真实冒烟。

官方语义：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)。当前实现使用会话限定 Hook + 最终 notify；已验证既有 notify 原 payload 转发与错误隔离，同名 config Hook 数组冲突时降级。通信已选标准库 IPv4 loopback TCP、单次启动认证、编译后非 UI Helper；不会通过激活 UI 的单实例入口上报事件。

## 最新原生验收与 resume（2026-10-01）

本次再次逐项授权 4 个 Rust Helper Hook，原生 YAM 终端真实完成多轮输入。主 ID 01a0f6ec-5463-78c3-a404-5a7ad3b933fe，两轮后台完成分别 accepted/revision 10、13；接受发送仍保留未读，点击收件箱只读具体 revision。实际 Esc 中断生成 interrupted/revision 15。测试后撤销 4 项，原有 15 项信任状态一致。macOS 通知中心点击仍未覆盖，不能把 accepted 写成用户看到通知。

仅已测 Codex 0.159.3 支持主动 resume。后端查可信历史 UUID、只读 thread/read 校验原目录/provider，清除旧 prompt；不自动恢复任务或回退新对话。真实原生续聊显示旧回复，并从旧上下文回答未含标签的问题，返回 YAM_NATIVE_THREE。未新增 Hook 信任时保持集成未连接提示，续聊与轮次通知能力分别验收。Claude、自定义 CLI 参数、缺失目录/ID/provider、未测版本不声明可续聊；失效项明确报错。

具体进度与回执见 yam-next-stage-execution.md 的最新段落，早期探针段落为历史证据。
