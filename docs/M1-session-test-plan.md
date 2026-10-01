# M1 单会话测试计划

## Rust 单元测试

- Unix 和 Windows 的 shell 命令构造使用正确的可执行文件和参数。
- 会话 ID 非空且每次创建唯一。
- 用户停止标记只允许终态归类为 `stopped`。
- 输出按 UTF-8 损坏字节安全转换，不发生 panic。

## Rust 集成测试夹具

- 启动 `printf`/`echo` 并收集输出事件。
- 启动退出码为 7 的命令并断言 `failed` 与退出码。
- 启动长命令后调用停止并断言 `stopped`。
- 使用不存在的 cwd 断言返回错误。

## 前端验证

- 创建按钮进入运行态并显示会话 ID。
- 终端接收 `session-output`，输入通过 `write_session` 发回 Rust。
- 终态徽标与事件一致，停止按钮只允许点击一次。
- 监听器在组件卸载时解除，不重复订阅。

## M1 通过条件

Rust 单元测试、TypeScript 检查、前端生产构建和 Tauri debug 构建全部通过；至少执行一次真实 shell 会话手工验证。

## 本轮结果

- Rust 测试：11 passed，包含真实 PTY 输出、非零退出、停止和工作目录校验夹具。
- TypeScript 检查和 Vite 生产构建：通过。
- Tauri macOS debug `.app` / `.dmg`：构建通过。
