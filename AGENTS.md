# YAM 本机开发约定

- GUI 必须保持单实例，重复启动应唤起已有实例；复用已有 Tauri single-instance 机制。
- 本机 macOS 调试构建只维护 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`，固定 `productName = YAM`、`identifier = com.yam.desktop`。
- 桌面验收按顺序复用此应用。未经用户明确授权，不修改应用名称或 identifier 另建可并行运行的验收 App，不在构建目录遗留多份验收包。
