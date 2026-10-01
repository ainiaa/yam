# YAM 后续可靠性优化计划

基线：`b8176a289fceabbd46da4d406dc4afb89b910df4`。按既有修复计划顺序推进，先复现、先测试、再修复、再复核。作者：Jeff.Liu。

本轮范围为前次列出的六项优化。源码修复可直接执行；真实桌面和正式签名的验收依赖可用环境，缺失时保持未覆盖。沿用当前分支与依赖，不合并、不发布，不申请额外系统权限。

## 执行任务

### R1：通知失败可操作且不会无限频繁重试

范围：`apps/desktop/src/notifications.ts`、`apps/desktop/src/App.tsx`、`apps/desktop/tests/notifications.test.mjs`

- [ ] 权限关闭与桌面不支持分别提示解决动作，自动重试暂停，手动重试可恢复
- [ ] 暂时错误按15秒到5分钟退避；重复状态事件不能绕过退避
- [ ] 发送成功而回执失败时仅重试回执，不重复发送

验证：`pnpm --dir apps/desktop test`；`pnpm --dir apps/desktop build`

### R2：崩溃后重试使用稳定通知身份

范围：`apps/desktop/src-tauri/src/windows_notifications.rs`、`apps/desktop/src-tauri/src/mac_notifications.rs`、`apps/desktop/src-tauri/src/linux_notifications.rs`、`apps/desktop/src-tauri/src/lib.rs`

- [ ] 系统发送成功但回执尚未写入时，重启保留pending并可重试
- [ ] macOS identifier、Linux notification id和Windows group/tag对同一会话保持稳定
- [ ] 不同会话身份不冲突，非法标识拒绝；不承诺恰好一次横幅

验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`

### R3：遗留通知未跳转有可核查归因

范围：`apps/desktop/src-tauri/src/mac_notifications.rs`、`docs/notification-acceptance.md`

- [ ] 读取遗留YAM通知请求标识，核对当前路由及历史会话
- [ ] 有目标会话的当前通知运行中/冷启动均准确路由
- [ ] 无法识别目标的历史实验通知不得按标题猜测会话，记录样本与限制

验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`

### R4：安装与移动后的身份注册可验证

范围：`apps/desktop/src-tauri/src/windows_notifications.rs`、`apps/desktop/src-tauri/src/linux_notifications.rs`、`apps/desktop/src-tauri/tauri.conf.json`、`docs/notification-acceptance.md`、`.github/workflows/ci.yml`

- [ ] 现有SDK和协议注册沿用com.yam.desktop
- [ ] 检查本地签名身份及三平台打包能力，包内协议配置完整
- [ ] 正式签名安装/升级/移动后点击只能凭实测勾选；没有证书则保持未验收

验证：`pnpm --dir apps/desktop tauri build --debug --bundles app`

### R5：跨平台桌面验收有独立证据

范围：`.github/workflows/ci.yml`、`docs/notification-acceptance.md`

- [ ] Windows/Linux通知点击、退出后唤醒、目录取消/选择和退出进程清理逐项记录
- [ ] 可用桌面执行实测，无桌面不把编译单测当点击验收
- [ ] 三平台CI持续运行测试、构建、fmt、clippy

验证：`pnpm --dir apps/desktop test`

### R6：核心测试覆盖缺口可量化

范围：`apps/desktop/package.json`、`apps/desktop/tests/notifications.test.mjs`、`apps/desktop/tests/session-stream.test.mjs`、`apps/desktop/tests/workspaces.test.mjs`、`apps/desktop/src-tauri/src/lib.rs`、`.github/workflows/ci.yml`、`docs/notification-acceptance.md`

- [ ] 使用已有Node覆盖率工具统计实际执行模块
- [ ] 探测Rust覆盖率工具兼容性，能运行则统计核心模块，否则记录具体限制
- [ ] 只为实际分支缺口补测试，正常/边界/异常有断言

验证：`pnpm --dir apps/desktop test`；`pnpm --dir apps/desktop build`；`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked`

## 已知环境与验证限制

- 本机为macOS；当前未连接Windows/Linux交互桌面。先探测，CI不替代真实点击。
- `security find-identity -v -p codesigning`结果为0 valid identities；正式Developer ID签名和公证仍需正式证书环境。
- Converge preflight结果为uncovered：没有CodeGraph索引、未配置覆盖率。不会擅自建索引；实际测试继续执行。
- 原生通知与历史回执之间没有跨系统原子事务，稳定标识只能减少通知中心重复，无法保证横幅恰好一次。

## 分步结果

计划JSON保持冻结pending；本节记录真实执行进度及证据，不修改冻结定义。

### R1 已完成

新增3项正常/边界/异常回归，先观察缺失notificationFailure导出红灯，再实现分类、暂停、15秒至5分钟退避及手动重试。前端初次16/16测试和生产构建通过；复审补充真实App协调函数回归后24/24通过。回执保存失败后手动重试保留已发送去重记录。独立通知错误提示不覆盖其他业务错误。

### R2 已完成源码、回归与三平台CI

Windows补充稳定Group/Tag，相同会话重试替换同一身份；Tag使用固定FNV-1a 64-bit映射，不使用跨版本未承诺稳定的DefaultHasher，不用于安全校验。Tag保持16个字符以兼容原始Windows限制（[Microsoft Tag文档](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.tag)）。64-bit摘要存在理论碰撞边界，不承诺无限会话数学唯一性。新增稳定值、同/异会话、最长ID及非法ID回归。

新增磁盘故障测试：终态pending写入后阻塞临时文件，模拟系统已接收但回执失败；内存与重新打开的历史均保留pending，移除故障后确认并再次重开为false。本地Rust47/47通过，Clippy -D warnings通过。macOS请求identifier与Linuxnotification id沿用session ID，稳定身份不会保证横幅恰好一次。

### R3 部分完成，遗留样本未覆盖

旧notify-rust链路及其NSUserNotification UUID/进程内回调已核实；当前持久协议路由修复不变。独立临时SDK探针返回空列表，不足以取得实际遗留通知标识；已在notification-acceptance.md保留证据边界。没有用标题猜测路由，也没有重新扩大辅助功能权限。

### R4/R5 已补打包与验收清单，环境验收未覆盖

本地重新打包YAM.app成功，Info.plist核实com.yam.desktop、yam协议及最低系统10.14。CI新增app/deb/nsis打包与7天保留的测试产物；macOS测试包使用ad-hoc身份并以ditto压缩保留执行权限，不作为Developer ID或公证产物。跨平台真实桌面、正式签名安装/升级及移动位置仍待环境验证；逐项步骤已写入notification-acceptance.md。

R6开始前补充范围：apps/desktop/src/session-stream.ts。工具边界检查发现缓存上限未拒绝NaN/Infinity，可能使上限比较失效；将先写非法数值回归，复现后补齐正整数校验。新增范围仍属于本轮核心工具测试与边界修复。

### R6 本地完成，Rust覆盖率未覆盖

新增输出游标、chunk offset、缓存上限的非法数值及清空边界测试；先观察非法游标红灯，再最小修复安全非负整数游标与正整数缓存上限。补齐精确状态筛选回归。前端最终24/24通过，三个已执行工具模块行覆盖率100%、分支99.17%、函数100%；不是React页面或原生SDK覆盖率。新增test:coverage命令及CI闸门：行95%、分支90%、函数95%。生产构建通过。

Rust覆盖率探测实证：rustc1.98.1使用LLVM22.1.8；已安装Apple LLVM15.0.0。独立instrument-coverage探针编译与执行成功，但llvm-profdata merge失败：raw profile format version10、工具expected8；rustup未安装匹配llvm-tools组件，cargo-llvm-cov与Homebrew LLVM也不可用。不安装额外工具来伪造门禁通过，Rust覆盖率保持未覆盖。

代码026102e的CI36813191803三平台success，证明Windows新增SetGroup/SetTag SDK调用编译、Clippy及测试通过。572928d的CI36814180042三平台success，新增覆盖率闸门、app/deb/nsis打包与测试产物上传全部通过。最新复审修复等待下一次CI。


### 最终复审修复

独立只读复审发现并闭环修复：Linux的portal/GNOME暂时超时不能被误判为永久不支持；macOS未安装包及Windows/Linux权限错误有可操作提示。使用GLib原生DBus错误域/码区分缺失服务和暂时故障，Linux专属测试交由CI执行。

实际提取App的notifySession函数并mock IPC，验证重复旧attention、同会话不同状态发送竞争、发送成功回执失败、延迟history绕过退避。先观察断言失败，再增加会话发送gate、旧attention重试清理及await后重查退避。后端历史锁内校验required expected_status，防止查询后终态改变时旧ACK清掉新pending；磁盘回归验证旧状态回执保留pending、正确状态可确认。

Converge外部CLI复审未覆盖：Codex CLI缺少@openai/codex-darwin-arm64；Claude CLI provider缺少base_url（HTTP400）。未安装或改写用户CLI/provider。补充独立原生审查agent复核，不将其冒称正式Converge外部审查门禁。

最终本地验证：前端24/24、Rust49/49、生产构建、fmt与Clippy -D warnings通过。独立原生复审再次运行通知12项及旧回执Rust回归，确认既有发现已关闭、未发现新的明确规格或质量缺陷。
