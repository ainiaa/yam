# YAM 职责拆分续作计划

作者：Jeff.Liu

基线：`b1a7b9d4d05c7af7d6929591dab13f4edabf9a0c`，保留全部既有工作区改动。机器计划见同目录 JSON。

1. 连接详情/端口检查：先迁移真实组件回归，再搬迁组件与 App 导入，验证快照、Escape、并发检查与错误路径。
2. 终端 Profile 编辑：先迁移动作回归，再抽取状态和动作 hook；保持相同 collection、存储键、原子持久化、草稿隔离和启动入口。
3. 跑前端完整无界面 coverage、构建，复核新旧实现与调用链。Rust 未修改，不重复 Rust 全量。
4. 构建唯一 debug YAM.app，签名校验；优雅退出 GUI，覆盖 /Applications/YAM.app，重开并核对单实例、ready 与原有会话数量。

不增加依赖，不改变 IPC/存储格式；不提交或推送。测试不启用桌面浏览器 opt-in。安装重启已由本轮用户明确授权。

## 本轮结果

两项职责拆分均已实现：`SessionConnection.tsx`、`ProviderPortCheck.tsx` 与 `use-terminal-profiles.ts`。App 使用导入组件及 hook；端口检查显式注入原窗口 RPC。既有 collection 在管理、启动和偏好刷新路径中继续共享。

先将既有真实入口测试绑定到新模块，观察缺失模块失败，再迁移实现。定向连接组件回归 34 passed / 1 skipped；Profile/启动/设置 106 passed；Codex 继承入口 4 passed。完整回归还捕获并修正一条读取旧 App 位置的标签断言；构建检查捕获并修正 hook 调用处提前引用 setError，最终使用延迟回调。

| 最终检查 | 退出码 / 结果 | 耗时 |
| --- | --- | --- |
| `pnpm --dir apps/desktop test:coverage` | 0；2912 passed / 5 skipped；行 99.81%、分支 94.04%、函数 96.46% | 49.468s |
| `pnpm --dir apps/desktop build` | 0；保留既有大 chunk 警告 | 3.942s |
| `git diff --check` | 0 | 0.032s |
| `pnpm tauri build --debug --bundles app`（apps/desktop） | 0；唯一固定 YAM.app | 24.192s |
| 签名校验、覆盖安装与重启 | 0；GUI PID 92475 → 23258，单实例 ready | 1.384s（安装重启） |

独立只读 spec、quality、integration 复核均 pass，无 findings；reviewer 未重跑检查或启动 GUI。产品与测试源码指纹：`ad4aaa55740a4b1673d929c9e38163476ce8eae02700daf22729f904a85e7461`（按冻结审查请求路径顺序、路径 NUL 和文件内容计算；不包含计划文档）。原始差异、基线副本、命令日志、命令退出码/耗时和规范复核记录保留在 `/tmp/yam-responsibility-20261112/`，临时证据可能被系统清理。

安装路径 `/Applications/YAM.app`，Bundle ID `com.yam.desktop`；构建包与安装包的主程序、helper、terminal runtime SHA-256 一致。重启前后均为 3 个活动会话 / 213 个总会话，后台上下文标识保持。已核对本轮范围以外的初始工作区文件未变化。

本轮只改前端，未重复 Rust 全量。测试未启用真实浏览器 opt-in，保留 5 项跳过；未进行完整 GUI 人工交互、中文输入或跨平台验收。未提交或推送。
