# YAM 通知与安装验收记录

作者：Jeff.Liu。基线：b8176a2。源码测试、CI、系统点击和正式安装验收分别记录。

## 遗留通知

- 早前的notification-live-smoke系统通知点击未切换会话；其具体生成版本未确认。
- 已核对2a145ba的旧notify-rust链路：session ID只存在进程内wait_for_response闭包，退出后闭包丢失；mac-notification-sys旧NSUserNotification请求identifier是UUID，没有持久会话路由。当前已替换为UNUserNotificationCenter与yam://session/<id>请求标识。
- 当前版本新通知运行中点击及发送后退出点击已直接验证；不能外推为旧实验通知兼容。
- 临时只读SDK探针使用同bundle identifier的独立调试包读取UN和旧NS请求；返回空列表。独立包身份与真实发通知进程不构成同一来源证明，结果不能用于判定遗留样本不存在或归因。
- 遗留样本请求标识仍未取得，保持未覆盖；不按通知标题猜测会话，不申请额外系统权限、不清除用户通知。

## 平台桌面验收矩阵

| 检查 | macOS当前调试包 | Windows | Linux |
|---|---|---|---|
| 后台完成后点击定位 | 已实测 | 待真实桌面 | 待真实桌面 |
| 退出后保留通知唤醒 | 已实测 | 待真实桌面 | 待真实桌面 |
| 目录取消保留值 | 已实测 | 待真实桌面 | 待真实桌面 |
| 目录选择保存 | 已实测 | 待真实桌面 | 待真实桌面 |
| 退出清理后台会话 | 已实测 | 单测/CI，不等价实机 | 单测/CI，不等价实机 |
| 正式签名安装与升级 | 缺Developer ID证书 | 待正式包环境 | 待安装环境 |
| 移动安装位置后通知路由 | 待实测 | 待实测 | 待实测 |

Linux退出后通知唤醒要求GNOME或提供host-app Registry的通知portal。generic freedesktop服务明确返回错误；前端停止自动重试并提示兼容条件。

## 可复用手工验收步骤

1. 用正式包安装启动YAM，记录版本、系统版本、包签名、安装路径和Linux通知服务。
2. 创建只输出验收标记的短会话，切换到另一历史会话并将YAM置于后台；完成后点击系统通知，核对会话ID、终态和日志，确认仅一个YAM进程。
3. 再创建独立短会话，等待通知后退出YAM并确认进程不存在；点击保留通知，核对新进程与目标会话ID，确认无手动启动。
4. 关闭通知权限后重复后台任务，确认有权限提示、pending保留且不会每15秒重复请求；恢复权限并点Retry notifications，确认发送后pending清除。
5. 验证目录选择取消不改值，选择目录后重启仍保存；运行带后台子进程的测试会话，退出后核对进程树已清理。
6. 升级并按平台允许的方式移动安装位置，启动新版，再复核新通知及退出后点击；只记录实际运行结果。

## 正式签名环境

security find-identity -v -p codesigning返回0 valid identities，本机无法完成Developer ID签名与公证。当前ad-hoc包仅用于本地SDK测试，不作为正式签名验收。

## 覆盖率证据

本地Node原生覆盖率：24项测试；notifications.ts与session-stream.ts行/分支/函数均100%，workspaces.ts行/函数100%、分支97.22%，合计行100%、分支99.17%、函数100%。统计仅包含实际执行的三个工具模块，未包含App.tsx和平台SDK，不声称仓库整体100%。

Rust覆盖率工具不兼容：rustc LLVM22生成profraw格式10，已安装Apple LLVM15的llvm-profdata只接受格式8，merge实测失败。缺少匹配llvm-tools组件，当前没有可信Rust覆盖率数字。


## CI测试包证据

[CI 36814180042](https://github.com/ainiaa/yam/actions/runs/36814180042)在572928d上三平台成功，包含覆盖率闸门、Rust测试/Clippy、app/deb/nsis打包和7天保留测试产物。此证据证明可构建与测试，不替代上表真实桌面、正式签名及遗留样本验收。


最终代码9affe4a的[CI36815933487](https://github.com/ainiaa/yam/actions/runs/36815933487)三平台全部success，包含最新并发回执修复和Linux原生DBus错误回归。macOS app、Linux deb及Windows nsis测试产物均已保存；这是本轮最终源码CI证据。没有执行正式发布。

## 2026-10-01 本阶段补充证据

隔离 com.yam.validation 原生包、本机 Codex 0.159.3：持续 CLI 的两次后台 response_finished 获得独立 accepted 回执，前台抑制仍未读；具体收件箱点击只读对应 revision，真实 Esc 中断独立记录。用户授权只开启隔离包通知，测试后 4 个临时 Helper 信任全部撤销。accepted 不证明横幅可见或点击完成；CUA 仍无法读取真实通知列表，点击/退出后唤醒继续未覆盖。

主动 resume 的后端校验、重复占用/清理释放及原生上下文续答通过；模式记忆和主要导航快捷键通过 macOS 原生验证。详见 yam-next-stage-execution.md。Windows/Linux 真桌面、正式签名/公证、旧通知/安装路径迁移、cmux 同场景性能对照仍未验收；本轮 CI 包也只用于测试，不属于正式分发。


## 2026-10-01 — 本次真实 macOS 激活验收

隔离 com.yam.validation 本地 ad-hoc 包：

- 运行中点击真实系统通知 7213108C-518F-49BD-A5DB-0ED59A5C06F4，目标 s-1a0f74bedcb-0 被选中；收件箱仍未读，导航不代替确认。
- 同一构建退出后，先确认 yam-desktop 不存在，再点击 E52B866F-4E34-4CFC-A104-5F01B068D5D7；系统启动新进程并选中 s-1a0f755f649-0，17 条历史、0 个运行会话，未自动重放任务。该通知为退出时更新的 Stopped 通知。
- 跨构建旧通知 550AF452-4FB6-4C2A-96CC-1D4B8CB5E7FB 点击后未启动应用。usernoted 明确报告无法找到与旧 source UUID FE3CA26B-4B20-46E3-8662-BFC5973BACA0 匹配的应用。现有 ad-hoc 重建包无法证明正式升级后旧通知身份稳定性；仍需 Developer ID 签名升级验收。

以上为实际通知卡片点击，不以堆叠展开、URL 手动打开或 accepted 回执替代。Windows/Linux 真桌面、安装位置迁移及正式签名升级仍未验证。
