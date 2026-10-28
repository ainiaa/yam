# M2 稳定性底座设计

## 持久化

会话数据保存在 Tauri 的应用数据目录 `sessions/` 下：

- `sessions.json` 保存会话摘要、状态、退出码、原因和时间戳。
- `<session-id>.log` 按增量解码后的 UTF-8 输出追加写入，达到 8 MiB 后截断并保留最新输出，前端通过 `read_session_snapshot` 读取字节偏移快照并与实时输出去重。
- 元数据通过临时文件再 rename 写入，写入并 sync 后替换，保存上一版备份；损坏主文件保留证据后从有效备份恢复；没有有效备份则报错。

应用第一次访问会话历史时，会把上次退出时仍为 `starting` 或 `running` 的记录标记为 `needs_attention`，并保留原日志供排查。

## 监督与状态

读取线程独立于等待线程。每次收到输出或用户输入都会刷新活动时间；无输出时间超过 `YAM_SESSION_IDLE_TIMEOUT_SECS`（默认 15 分钟）时只发送一次 `session-attention` 提醒，保持进程运行；新活动会重新启用下一次提醒。用户停止仍归类为 `stopped`，shell自然退出按退出码分类；Agent单任务模式还必须有结构化结果，否则归类为 `needs_attention`。

终态写入历史前会检查当前状态，确保同一会话只更新和发送一次终态事件。

## IPC

- `list_sessions()` 返回倒序历史记录。
- `read_session_log(session_id)` 返回指定会话的日志内容。
- `create_session` 增加可选 `launch`；结构化提示词以 argv 传入，旧 shell/custom command 入口保留。
- `read_session_snapshot` 返回 data、offset、end_offset、status。
- `notify_session` 返回OS授权与发送错误；`acknowledge_notification` 仅在发送成功后持久化回执。
- 通知激活：macOS持有UNUserNotificationCenter delegate，Windows使用yam协议toast，Linux使用兼容portal/GNOME持久化action与D-Bus启动服务；不支持冷启动的Linux通知后端明确报错。
- 原生通知代理在Builder.build插件初始化阶段注册。`pending_notification_selection` 在前端就绪前保留点击目标，`acknowledge_notification_selection` 只清除同一目标；链接仅选择已有会话，不能执行命令。
- 系统目录选择结果复用`validate_project_directory`；取消不修改现值。
- `write_session`、`resize_session`、`stop_session` 保留原有参数。
