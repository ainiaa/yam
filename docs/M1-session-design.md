# M1 单会话纵向切片设计

## 目标

让用户从 YAM 界面启动一个本地 shell/CLI 会话，在内置终端中看到实时输出、发送输入，并能主动停止会话。

## 事件契约

### `session-output`

```json
{
  "session_id": "s-...",
  "data": "命令输出或终端回显"
}
```

### `session-state`

```json
{
  "session_id": "s-...",
  "status": "starting | running | succeeded | failed | stopped",
  "exit_code": 0,
  "reason": "自然退出、用户停止或启动失败"
}
```

`exit_code` 可为空。状态事件按会话顺序发送，终态只发送一次。

## IPC 命令

- `create_session(cwd?, command?)`：创建 PTY，返回会话摘要并发送 `starting`/`running`。
- `write_session(session_id, data)`：向 PTY 写入用户输入。
- `resize_session(session_id, cols, rows)`：同步终端尺寸。
- `stop_session(session_id)`：请求终止进程树，最终发送 `stopped`。

## 进程策略

- Unix 默认使用 `$SHELL`，没有设置时回退到 `/bin/sh`。
- Windows 默认使用 `ComSpec`，没有设置时回退到 `cmd.exe`。
- 有命令时通过登录 shell 执行命令；无命令时启动交互 shell。
- 读取线程和等待线程独立运行；读输出失败不能阻塞状态收敛。
- 用户停止通过原子标记与等待线程协调，避免 `stopped` 被错误覆盖为 `failed`。

## 验收标准

1. 启动会话后 2 秒内显示 `running`，并能看到 shell 首次输出。
2. 输入 `printf 'hello\\n'` 或等价命令时，终端能显示 `hello`。
3. 正常退出为 `succeeded`，非零退出为 `failed`，用户点击停止为 `stopped`。
4. 同一会话只产生一个终态事件。
5. 不存在的工作目录或无法启动的命令返回可读错误，不导致应用退出。
6. 调整窗口尺寸后，PTY 能收到新的列数和行数。
