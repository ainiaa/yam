# Pi 自动路由实现与安装验收

作者：Jeff.Liu

日期：2026-10-27

已实现并安装到 `/Applications/YAM.app`（0.1.10，本机调试构建、ad-hoc 签名）。仍只使用 `com.yam.desktop` 和维护中的 `target/debug/bundle/macos/YAM.app`，没有额外验收 App。主程序、后台 helper 代码及终端解析器一致，签名验证通过。

## 使用

新建会话选择 **Pi 自动路由**。默认预填本机 Magpie 的明确 Codex 路由；在高级选项编辑角色或网关参数。也可删除网关参数并指定 Pi 自己配置的 `provider/model`。

- `/yam-route`：打开原生选择菜单。
- `/yam-route effort high` 或 `max`：锁定档位，先检查能力，再回读原生设置，不支持时停止。
- `/yam-route effort auto`：在 YAM Auto 模型中自动调整推理；不会把已锁定物理模型的推理关闭。
- `/model`：原生选择物理模型，即锁定模型。
- `/yam-route auto`：回到自动选模型，保留现有高档位锁定；需要自动档位时再选 effort auto。
- `/yam-route models provider/small provider/strong [provider/classifier]`：修改会话角色并保存到原生分支。

Pi footer 显示实际模型、档位和简短选择原因。简单独立任务默认 medium，编码 high，高风险 max；分类失败时保守回退。继续、工具调用和重试保持实际选择，容量/图片保护避免降级导致额外压缩或丢失图像。

## 已完成的真实验证

| 检查 | 结果 |
|---|---|
| 自动选择读取 → 编码 | Luna · medium → Sol · high |
| 手动 max 后切换模型 | 实际执行保留 max |
| 强制 SIGKILL 后恢复 | 原 JSONL、随机事实及 max 均保留 |
| 手动物理模型后重启 | Sol · high 精确恢复 |
| 安装后 YAM 后台启动 Pi | 可信 SessionStart、UserPromptSubmit、TurnComplete 正常 |
| 安装后终端内锁定并历史继续 | 删除事实文件后仍能回忆随机 token；实际推理为 max |
| 普通终端 | 安装后真实执行及输出正常 |
| 新扩展定向测试 | 16 通过，行覆盖 99.32%（策略 100%） |
| 前端完整回归 | 1950 通过，3 个需显式启用的浏览器检查跳过，0 失败 |
| Rust 完整单元回归 | 1049 通过，25 个原有 opt-in 检查跳过，0 失败 |
| 安装后 Rust 定向检查 | 5 通过 |
| 独立只读审查 | 两个问题补红绿测试修复；定向复审无遗留 finding |
| 安装签名、主/后台代码及解析器一致性 | 通过 |

测试使用自有临时项目和随机事实，没有读取凭据、修改全局 Git 忽略配置或重写官方 CLI 配置。测试结束后自有历史已归档，回合通知已确认，活跃任务回到 0，正常历史数量回到安装前的 156。没有将用户的原会话归档或终止。

## 修复过的实际边界

- Pi 原生 JSONL 的普通文件权限：由 YAM 私有 0700 目录保护，使用不跟随软链的有界读取校验项目。
- `/tmp` 与 `/private/tmp` 等别名：按物理项目路径恢复，拒绝不同项目、软链会话文件、缺失或损坏会话。
- 恢复时不重放启动 model/thinking 默认值；网关物理模型在原生恢复选择解析前注册。
- `thinkingLevelMap` 未声明档位必须显式为 null，防止 Pi 按默认能力补齐。
- 手动设置前验证、设置后回读；意外原生 clamp 时恢复原值并报错。
- 中间请求失败、重试最终成功时，回合通知按最终结果报告。

## 未覆盖与限制

- 全仓 `cargo clippy --all-targets -- -D warnings` 当前仍有 5 处报错，位于本轮未修改逻辑的 `agent_bridge::claude_settings_args`、`codex_context`、`git_context`、`node_runtime`。没有抑制这些 lint；详情在 evidence/strict-clippy.log。
- 全仓格式检查也包含既有未格式化片段；本轮保留其他未提交改动，没有为消除格式噪声批量重排。
- 未开启上述 3 项浏览器/25 项原生 opt-in 检查，未宣称所有 UI 视觉和所有外部 CLI/认证组合均已实测。
- 当前绑定已验证的 Pi 1.4.0。其他版本明确报错，需要后续适配验证。
- 原生压缩是摘要，私有推理无法保证跨模型迁移；同名档位不表示跨厂商等量计算。Pi 工具以本机用户权限运行，不等同于官方 CLI 的 OS 沙箱。
- 不转换官方 CLI 既有会话；用户仍可继续原有官方 CLI 模式。

证据保存在本目录 evidence/；source-sha256.json 记录本轮最终代码。只读审查没有执行真实调用，其未验证部分由随后真实 Pi 和已安装 YAM 测试补齐。
