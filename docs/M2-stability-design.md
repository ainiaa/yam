# M2 稳定性底座设计

## 持久化

会话数据保存在 Tauri 的应用数据目录 `sessions/` 下：

- `sessions.json` 保存会话摘要、状态、退出码、原因和时间戳。
- `<session-id>.log` 按 PTY 原始输出追加写入，达到 8 MiB 后截断并保留最新输出，前端可通过 `read_session_log` 读取。
- 元数据通过临时文件再 rename 写入，避免进程退出时留下半份 JSON。

应用第一次访问会话历史时，会把上次退出时仍为 `starting` 或 `running` 的记录标记为 `needs_attention`，并保留原日志供排查。

## 监督与状态

读取线程独立于等待线程。每次收到输出或用户输入都会刷新活动时间；无输出时间超过 `YAM_SESSION_IDLE_TIMEOUT_SECS`（默认 15 分钟）时终止子进程并发送一次 `needs_attention` 终态事件。用户停止仍归类为 `stopped`，自然退出按退出码归类为 `succeeded` 或 `failed`。

终态写入历史前会检查当前状态，确保同一会话只更新和发送一次终态事件。

## IPC

- `list_sessions()` 返回倒序历史记录。
- `read_session_log(session_id)` 返回指定会话的日志内容。
- 原有 `create_session`、`write_session`、`resize_session`、`stop_session` 契约保持不变。
