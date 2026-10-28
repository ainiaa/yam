# Pi 自动路由体验优化验收

作者：Jeff.Liu
计划开始：2026-10-27；安装验收完成：2026-10-28。

## 交付结果

四项均已实现并验收：

| 项目 | 当前行为 |
| --- | --- |
| 配置表单 | 选择现有 Pi 配置或 Magpie 网关，读取 Pi 原生可用模型及推理能力，配置轻量、强模型和分类模型；启动前检查参数与能力。高级参数保留字面值。 |
| 真实状态栏 | 显示任务判断、候选选择、来自 Pi 原生助手消息的实际模型/推理、连接错误和已结束状态。候选与实际响应分开；恢复后从原生分支重建上次实际信息。 |
| 故障重试 | 同一 Pi 进程重新读取目录、检查配置和恢复选择。不会重发任务或工具调用；未发送文字留在编辑器，同一条显式重发可保留附件。不同新任务不会携带旧附件。 |
| 独立控制 | 模型自动/固定、推理自动/固定分别设置；支持全部恢复自动。high/max/off 等显式选择严格保存，模型不支持时明确拒绝。界面和 `/yam-route effort …` 共用保存路径。 |

界面使用 YAM 现有 Select、主题和对话框；表单内边距 16px，窄屏不横向溢出。只有选中 Pi 会话时显示路由栏。

## 复用与影响边界

- Pi 1.4.0 继续负责执行循环、工具、完整工作上下文、会话树、压缩和原生 JSONL。路由仅返回模型、推理档位和原生路由状态。
- 推理能力直接使用 Pi AI 的 `getSupportedThinkingLevels`。工作模型的上下文和输出限制沿用原生目录数据。
- 偏好通过 Pi 原生分支 custom entry 保存，没有另建对话存储或截断工作上下文。
- 新增控制通道仅监听 loopback，使用私有目录/文件、随机凭据、运行代次、状态版本、空闲校验和读写大小/超时限制。凭据不返回前端。
- 原有官方 CLI 启动、连接隔离、参数与恢复路径保持独立；没有新增依赖或修改全局 Git 配置。
- 只读预检不会执行用户扩展；实际 Pi 会话仍按原有方式加载扩展，运行中模型目录来自该会话。

## 验证

| 验证 | 结果 |
| --- | --- |
| 路由、控制协议、表单与状态专项 | 48 项通过，覆盖正常、非法/过期请求、断连、中断、原生选择与命令、重启、UTF-8 分包和附件保留边界 |
| 前端全量 | 1983 通过，3 项既有 opt-in 检查跳过 |
| Rust 全量/覆盖率 | 1056 通过，25 项既有 opt-in 检查跳过；行覆盖率 87.18%，高于项目 85% 门槛 |
| 严格 Clippy | `--all-targets -- -D warnings` 通过，零告警 |
| TypeScript / Vite / Tauri | 构建通过 |
| 浏览器交互 | 实际 Pi 控制通道下，配置检查、独立选择、恢复自动、故障刷新通过；1050px 和 430px 均无横向溢出、无页面错误 |
| 安装包 | `com.yam.desktop` / YAM 0.1.10；签名严格校验通过；主程序与后台 helper 代码一致；安装包嵌入的 4 个 Pi 扩展文件与当前源码逐字节相符 |

只读审查发现的启动 off 混淆、中断后控件禁用、原生 off 事件、恢复后的旧轮询错误及命令入口持久化遗漏均已补回归并修复。最后一项由定向只读复核确认关闭；审查器未代替执行测试，实际结果见日志。

## 安装后真实验收

使用 `/Applications/YAM.app` 的真实后台 owner、Pi 和临时项目：

1. 读取 8 个原生可用模型；普通 Shell 执行正常。
2. 固定 GPT-6.1-Sol，推理自动：实际 medium。
3. 模型自动，推理锁定 max：实际 GPT-6-Luna / max。
4. 固定 GPT-6-Luna / high 后停止并恢复同一原生会话；删除事实文件后仍能从会话召回内容，选择和上次实际状态保持。
5. 模型目录故障后原地恢复；原生消息条数未增加，没有自动重发。
6. `/yam-route effort off` 写入原生偏好；恢复全部自动后延迟回调不会覆盖自动模式。
7. 从原生 `--thinking off` 参数启动：实际 GPT-6-Luna / off，没有解释成自动推理。
8. 对比 `~/.codex/config.toml`、`~/.claude/settings.json`、`~/.pi/agent/settings.json`、`~/.gitconfig`、`~/.config/git/ignore` 的存在性和内容哈希，全部保持不变。

验收仅使用自建临时会话。4 个测试会话已归档，正常历史从 156 恢复为 156，活动会话为 0。测试期间的 4 条 Agent 通知均为 suppressed，通知暂停状态已恢复为 false。GUI 保持单实例，后台 owner 单实例；未创建其他名称或 identifier 的验收 App。

原包备份：`/tmp/yam-before-pi-routing-ux-install.zip`。没有提交或发布版本。

## 证据与限制

- [安装后结果](evidence/installed-acceptance.json)、[清理结果](evidence/installed-cleanup.json)、[安装包校验](evidence/bundle-verification.json)
- [专项测试](evidence/targeted-tests.log)、[前端回归](evidence/frontend-tests.log)、[Rust 覆盖率](evidence/native-coverage.log)、[Clippy](evidence/clippy.log)
- [配置截图](evidence/ui-config-dark.png)、[窄屏配置](evidence/ui-config-narrow.png)、[状态栏](evidence/ui-state-dark.png)、[窄屏状态栏](evidence/ui-state-narrow.png)
- [最终源码哈希](evidence/final-sha256.json)、[最后一项定向复核](evidence/review-command-closure.txt)

自动判断仍可能误判，不代表每次都选出最优模型；可以独立固定模型和推理档位。本轮未重跑所有供应商的真实登录/授权，也未覆盖全部第三方扩展组合。浏览器交互验收与安装后真实 IPC/Pi 验收分别记录，不将其称为所有 macOS 界面的人工逐项验收。
