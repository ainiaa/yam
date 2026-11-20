# YAM 真实桌面与系统通知验收

作者：Jeff.Liu

## 范围与结论

本记录承接 [项目改进与流程审计](2026-11-13-project-resilience.md)。用户随后明确授权启动本机 YAM、结束指定旧测试会话并正常重启后台，以及使用 AppleScript / System Events 操作本轮通知卡片。未修改辅助功能、安全或自动化权限。未提交、推送、安装、签名、公证或发布。

实机验收发现一项 macOS 通知路由缺陷，已按测试先行修复；运行中点击和退出后点击唤起均重新验收通过。现有正式安装包保持原样。使用唯一固定调试包 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`，名称 `YAM`，identifier `com.yam.desktop`。

原始证据目录为 `.artifacts/project-resilience-desktop-20261113/`（本地忽略目录，交接时需一并保留）。CUA 工具对话是界面观察原始证据，`desktop-observations-final.json` 仅作控制器索引；不伪造界面命令回执。命令证据保存真实 argv、源码指纹、退出码、耗时与 stdout/stderr。早期失败、模糊结果与部分观察均保留，不能当成最终通过。

## 顺序执行与实机结果

| 项目 | 实际验收及结果 | 证据 |
| --- | --- | --- |
| 实例与旧后台 | 旧后台对新命令明确拒绝，未启动替代后台争抢所有权；正常退出 GUI 保留原任务。取得用户许可后，只停止指定旧 OMP 测试会话，历史保留，后台正常退出后启动新版 | baseline、进程与 owner 回执；CUA 观察 |
| 本地启动 | 原生文件选择器取消不改变表单；选择自建目录返回规范路径；预检展示程序与目录事实；通过 GUI 启动本地 shell，不调用外部模型 | CUA；`before-window-close.json` |
| 导出与恢复 | 原生保存/打开面板；含日志导出 564 字节、2 条历史和 2 份日志；预览确认后产生 2 条新只读记录，原记录保留；打开恢复布局不重跑命令；重启后结果仍可打开 | `export-file-receipt.json`、`restore-owner-proof.json`；CUA |
| 双窗口 | 选择其他窗口占有的任务唤起其窗口；显式移动任务到副窗再移回主窗；关闭副窗不停止任务；原有已结束记录保留 | CUA；窗口连续性回执 |
| 退出与重开 | Cmd+Q 后 GUI 消失，同一 owner / shell / sleep PID 继续存在；重开固定调试包恢复同一任务，启动标记仅出现一次，单一 GUI 进程 | `gui-quit-continuity.json`、`gui-reopen-continuity.json` |
| 窄窗口 | 原生系统半屏下 1516×1720 物理像素（758×860 逻辑尺寸），设置和核心操作可达；未取得原生精确 720×600 测量 | CUA 截图；精确 720×600 沿用前轮无窗口 WebKit 证据，不冒充实机 |
| 系统通知拒绝/重试 | 系统关闭当前 YAM 通知后，原生返回权限拒绝，GUI 显示可操作错误；恢复原开关后明确重试成功；保持原持久提醒和声音设置 | `permission-first-entry-test.json`；CUA |
| 手动测试通知 | 项目静音时仍允许手动测试；不将成功返回等同于系统卡片可见，另行观察真实卡片 | CUA；系统卡片原始记录 |
| 运行中点击 | 从成功会话 C 开始，点击唯一标题的失败会话 D 实际卡片，正确切换到 D | `fixed-warm-send.json`、`fixed-warm-activate.json`；CUA |
| 退出后点击 | 先选 C，再退出 GUI，进程检查证明 GUI 已消失；仅点击 D 卡片，系统唤起唯一固定调试 GUI 并选中 D，未手动启动 GUI | `cold-pre-click-gui-absent.json`、`fixed-cold-activate.json`、`cold-post-click-gui-process.json`；CUA |
| 项目 important | 成功卡片在 20 次系统 AX 观察中未出现；失败卡片实际出现并可点击 | `fixed-important-success-absent.json`、warm/cold 记录 |
| 项目 muted / all | muted 下失败卡片在 20 次 AX 观察中未出现；恢复 all 后成功对照卡片真实可见；最终项目策略恢复 all | `fixed-muted-absent.json`、`fixed-all-control-present.json`、最终 owner 证明；CUA |
| 全局暂停 | 用真实任务完成事件验收，未直接调用 notify_session 替代暂停规则；暂停期间失败记录保留 `notification_pending=true` 且完整标题卡片未出现；恢复后卡片可见，待送达标记变为 false | `global-pause-create.json`、`global-pause-full-title-absent.json`、`global-pause-resumed-present.json`、`global-pause-resumed-ack.json` |
| 收件箱与清场 | 原有 116 未读保留；测试任务均已结束，无自动重跑；系统通知恢复开启、全局暂停恢复 false、项目策略恢复 all；关闭验收打开的系统设置，保留可用的调试主窗口 | 最终 owner/进程证明；CUA |

`notification-running-click.json` 仅展开分组，不计作点击激活。最初 `global-pause-absent.json` 检查的是不完整标题，不能作为暂停结论；最终使用带 Session/失败的完整标题并验证恢复后的正向对照。

## 确认缺陷与最小修复

修改仅涉及 `apps/desktop/src-tauri/src/mac_notifications.rs`。修复前，实际单张通知卡片点击未定位，后台日志报 `Notification activation failed: Invalid session link`。场景字段 `targetContentIdentifier` 不能作为持久路由载体；它缺失时，回退得到的 threadIdentifier 已是项目分组键。

新增 `userInfo.yam_session_url` 保存经过既有校验的会话链接，回调优先读取并运行时校验字符串类型，继续使用原有会话 ID 校验。显式字段损坏时拒绝，不能回退到另一个会话。缺少新字段时保留旧 target/thread/request-ID 兼容路径。分组、十秒替换桶、权限回调、单实例和任务生命周期保持原行为；未增加依赖。

参考 Apple 官方契约：[userInfo](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/userinfo)、[targetContentIdentifier](https://developer.apple.com/documentation/usernotifications/unnotificationcontent/targetcontentidentifier)。已经投递且缺少有效路由的旧卡片不靠猜测补救，不清空用户通知。

新增三项真实 Foundation 对象测试，覆盖分组/非分组、系统场景目标缺失、载体复制、优先级、非法链接/非字符串、旧版回退和拒绝分组键。先观察 9 项测试中 2 项行为失败，再修改业务代码；11 项通过，3 个 notification_link mutation 全捕获。初次测试夹具编译失败单独保留，不冒充行为红灯。

## 验证与复核绑定

开始时 HEAD 为 `b1a7b9d4d05c7af7d6929591dab13f4edabf9a0c`，158 项既有脏文件，基线源码指纹 `860b6f7889a323135e55f41042ca1b6f1c60bf30beb09ff2e675b8b39e454665`。修复、打包、独立复核和原生最终检查绑定产品源码指纹 `b8b8ab79ae0034c694d058efef986b74260c2f07171ccf852006ec219026f1d7`；最终补记只增加本报告及原计划的指向链接，另用 source delta 核验没有改变产品字节。完整最终检查清单、耗时和源码收据见 `delivery-report.json`，以下为已实际取得的结果。

| 检查 | 命令/回执 | 结果与耗时 |
| --- | --- | --- |
| 行为红灯 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked activation_ -- --test-threads=2` | 7 通过、2 失败，退出 101；12.555 秒 |
| 修复定向 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked mac_notifications:: -- --test-threads=2`；`notification-payload-green.json` | 11 通过；15.581 秒 |
| Mutation | `notification-mutation.py`；`notification-mutation.json` | 3 生成、3 捕获；107.680 秒 |
| 原生全量与覆盖率 | `python3 scripts/native-coverage.py`；`final-native-coverage.json` | 1212 通过、30 既有忽略；行覆盖率 87.44%（门槛 85%）；125.169 秒 |
| Rust 静态检查 | `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过；27.127 秒 |
| 文档测试 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --doc` | 通过，0 项 doctest；28.675 秒 |
| 前端通知定向 | `node --test apps/desktop/tests/notifications.test.mjs apps/desktop/tests/project-notifications.test.mjs` | 18 通过、无跳过；0.769 秒 |
| 固定调试包 | `env APPLE_SIGNING_IDENTITY=- pnpm --dir apps/desktop exec tauri build --debug --bundles app --no-sign --ci` | 成功；52.221 秒；未签名、未安装 |
| 独立只读复核 | 原生 Codex CLI read-only / approval never；`review-notification.md`、`review-notification-command.json` | review pass，无确认残留缺陷；258.420 秒；reviewer 未运行测试或 GUI |

Clippy、doctest、最终差异/数据/包身份检查的实际结果亦保存在同目录的 `final-*.json` 和 `delivery-report.json`。Rust 全量只通过覆盖率执行一次，没有追加普通全量 cargo test；未打开既有实机/原生 CLI opt-in。前端代码未变，前轮完整 3040 项/覆盖率回执保留，本轮仅补通知相关回归。

## 未覆盖与保留项

- 未验证 Windows/Linux 实机、正式签名/公证、正式安装升级、远端 CI 和 PR HEAD；不构成发布放行。
- 原生精确 720×600 未测得；已有无窗口 WebKit 精确尺寸回归及原生半屏可用性观察，明确区分。
- 未调用外部模型执行真实 needs_permission hook；该分支以已有契约测试覆盖，实机策略对照使用本地成功/失败任务。
- 为可追溯保留自建测试项目、历史、备份和本轮系统卡片；未删除用户记录。GUI 最近使用的 CLI 因实际启动 shell 变为 shell，未通过保存整套默认值覆盖用户配置。
- 前轮审计和历史 PARTIAL 回执保持原样。本轮记录新增实机证据，不追认历史执行时序，也不声称签发受管 Single State / TDD Trace 认证。
