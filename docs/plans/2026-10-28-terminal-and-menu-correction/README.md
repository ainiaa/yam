# 终端输入、状态栏与三点菜单修复验收

作者：Jeff.Liu

日期：2026-10-28

## 修复范围

- 已结束的本地终端原先仍显示保存的 shell 提示符，但普通输入被 `view.live` 判断直接丢弃。现在用户实际输入时，在原工作目录建立一个普通交互 shell，缓存并发送本次输入；旧终端记录保留，旧命令、Agent 启动参数和历史提示词不会自动重放。
- 继续复用原有输入队列、终端数量限制、所有权检查、粘贴预览和 SSH 显式重连流程。焦点转移、启动失败、输入超限时不向其他会话发送缓存内容，并显示未发送提示。
- 恢复常驻状态栏，显示引擎状态、目录、可用 Git 分支和内存；窄窗口缩略长路径，保留内存数值。
- 项目和设置旁的工作区菜单共用相同的图标、左对齐行、间距、圆角、分组线及危险操作样式。菜单按可用空间向上或向下展开，不遮挡底部入口。
- 容量统计从菜单移至独立对话框，补齐中文标签、标准按钮和不完整扫描提示。短窗口中间内容滚动，标题和底部操作保持可见。
- 已不存在的通知会话会清除对应失败重试项；其他通知错误仍保留重试和错误提示。

## 自动验证

- 先记录失败测试，再修改实现；输入恢复、通知竞态、状态栏、菜单布局和短窗口对话框均有对应回归。
- 最终 `pnpm --dir apps/desktop test`：2041 项，2038 通过、0 失败、3 项浏览器显式启动测试跳过。
- `pnpm --dir apps/desktop tauri build --debug --bundles app` 成功。
- 构建包和 `/Applications/YAM.app` 均通过 `verify-yam-bundle.py --version 0.1.10`：identifier 为 `com.yam.desktop`，主程序与后台 helper 一致，签名校验通过。
- `git diff --check` 通过。本次未新增依赖或修改 Rust 实现。

## macOS 实机验证

使用同一份 YAM.app 和系统辅助功能/真实键盘事件，未另建应用或启动浏览器。

1. 在已结束会话中按普通空格键，只创建一个新 shell；随后通过真实粘贴和回车执行标记命令，后台日志证明输入已到达原目录的新 shell，旧命令没有重放。
2. 另建具有唯一标记的 shell，确认它被选中后停止进程，等待已结束提示，再输入命令并回车。后台日志确认已停止的终端恢复输入，历史启动命令没有重跑。
3. 检查 1180×760 和最小支持尺寸 640×440 的布局、菜单边界、状态栏内存可见性、长路径省略。
4. 项目/工作区菜单中 Tab、Escape 正常；Escape 返回对应三点入口。容量窗口 Escape 关闭后返回原入口。终端 Tab 保持终端输入焦点。
5. 窄窗口容量对话框的两个底部操作均在窗口可见范围，内容独立滚动。
6. 本次测试会话均按专属目录和 ID 核对后停止、归档，隐藏测试标签页；没有停止或归档用户会话。

中途系统锁屏使辅助功能和截图暂时不可用；用户明确解锁后，已重新完成最终版本的界面验收。

## 证据和限制

证据位于仓库忽略目录 `.artifacts/terminal-ui-correction-20261028/`：

- `frontend-tests-final.log`、`bundle-final.log`、`verify-built-final.log`、`verify-installed-final.log`
- `native-input-proof-final.json`、`native-stopped-shell-proof.json`
- `native-ui-acceptance-final.json`、`capacity-short-native-proof.json`
- `project-menu-final-wide.png`、`workspace-menu-final-wide.png`、`workspace-menu-final-narrow.png`
- `terminal-final-narrow.png`、`capacity-dialog-final.png`、`capacity-dialog-final-narrow.png`
- `cleanup.json`、`cleanup-final.json`

未执行 Windows/Linux 原生界面验收，也未建立真实 SSH 连接。断开的 SSH 仍需显式重连；本地后台不可用或达到现有 16 终端限制时保留已有保护和错误提示。
