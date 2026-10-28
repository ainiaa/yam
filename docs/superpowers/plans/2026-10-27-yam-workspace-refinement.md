# YAM 工作区优化计划

作者：Jeff.Liu

官方 CLI 启动、网关、配置、推理参数与会话恢复实现保持不变；不新增依赖。按以下顺序测试先行、最小实现、回归验证。

1. CLI 配置、推理与恢复兼容性保护。验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml fidelity_ -- --test-threads=2`。
2. 项目工具按文件、变更、工作树分区，保持留白。验证：`node --test apps/desktop/tests/project-tools-layout.test.mjs`。
3. 仅可见项目自动刷新，保留脏草稿和比较基线。验证：`node --test apps/desktop/tests/project-refresh.test.mjs apps/desktop/tests/project-files-ui.test.mjs`。
4. 切换文件保留编辑器撤销、选择及滚动状态。验证：`node --test apps/desktop/tests/file-editor.test.mjs apps/desktop/tests/project-files-ui.test.mjs`。
5. 多条评审意见通过原会话安全回填。验证：`node --test apps/desktop/tests/review-feedback.test.mjs`。
6. 集成回归、视觉检查及单实例安装重启验收。验证：`pnpm --dir apps/desktop test`。

刷新只读且限于可见面板；不自动记录或替换基线，不覆盖脏草稿。评审只填入原生会话输入，不代替用户提交。编辑器继续复用 CodeMirror。最终核对 CLI 核心文件摘要，构建并验证主程序和后台 helper；安装保持 YAM / com.yam.desktop 单实例。GUI 实测若受工具限制必须列为未验证。

机器可读计划与源基线：`/tmp/yam-workspace-refinement-20261027/`。

实施补充：文件与 Git 自动刷新仅在页面可见且窗口有焦点时运行，每次读取结束后等待 5 秒；本轮变更仍由用户明确记录、比较。保留最多 16 个文件的 CodeMirror 原生状态，磁盘文本替换后丢弃旧撤销历史。评审最多 20 条，整体含上下文受 16 KiB 限制，会话身份检查与“不自动提交”不变。
