# YAM 本机开发约定

- GUI 必须保持单实例，重复启动应唤起已有实例；复用已有 Tauri single-instance 机制。
- 本机 macOS 调试构建只维护 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`，固定 `productName = YAM`、`identifier = com.yam.desktop`。
- 桌面验收按顺序复用此应用。未经用户明确授权，不修改应用名称或 identifier 另建可并行运行的验收 App，不在构建目录遗留多份验收包。

## 提交与复核

- 按 `docs/00_standards/delivery-checks.md` 在推送前集中检查相关边界、运行定向测试并完成独立复核；新问题集中修复后再推送稳定提交。
- 测试执行时记录源码提交/差异、实际命令、退出码、耗时和跳过项，随复核请求一次提供；源码审查不以尚未完成的远端 CI 为前提。
- Rust 单元/集成全量由覆盖率命令执行一次；普通构建保留 Clippy、doctest、打包及生命周期验收，不额外重复全量 `cargo test`。最终放行核对 PR HEAD 与 CI 提交一致。
