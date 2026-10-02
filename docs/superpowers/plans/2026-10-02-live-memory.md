# YAM 实时内存显示实施计划

作者：Jeff.Liu

目标：状态栏每 5 秒显示当前 YAM 内存，包含 GUI、WebKit、后台 owner 和终端解析器；PTY/Agent 工作负载单独统计。macOS 使用 physical footprint，Linux 使用 RSS，Windows 使用 working set；提示说明逐进程相加、不去重共享页。异常或归属不完整不显示完整总量。

1. 先添加正常、边界、采样失败和轮询取消测试。
2. 实现原生进程采样及认证后台进程归属，限制时间、输出和进程数量。
3. 状态栏接入单请求轮询，隐藏时停止采样，清理后禁止更新。
4. 执行前后端回归、构建和原生采样验收。
5. 审查变更并记录实际结果与无法验收项。

不增加依赖、系统权限或全局配置。既有 Converge coverage provider 未配置，preflight 如实返回 uncovered；实际可执行测试仍为交付门禁。

## 验证记录

- 先运行新增测试，确认不存在采样/显示实现而失败；实现后前端 81 项、macOS Rust 164 项通过。
- 真实 LaunchServices 启动的隔离 macOS 应用：三次完整 native 采样通过，包含 WebKit、owner、parser 与实际 PTY 工作负载。直接 Popen 启动没有显式 coalition membership，正确显示不可用，不能当成全量总数。
- native 测试数据：

```json
{
  "samples": [
    {
      "application_bytes": 228350768,
      "workload_bytes": 852160,
      "metric": "physical footprint",
      "sampled_at": 1790908300117
    },
    {
      "application_bytes": 122624816,
      "workload_bytes": 852160,
      "metric": "physical footprint",
      "sampled_at": 1790908306972
    },
    {
      "application_bytes": 114039600,
      "workload_bytes": 852160,
      "metric": "physical footprint",
      "sampled_at": 1790908312570
    }
  ],
  "owner_and_workload_attribution": true,
  "native_webkit_included": true
}
```

- 新增 native fixture 测试需要活跃隔离应用，普通回归中明确 ignored，本次已单独执行三次通过。
- 独立 spec review 发现旧数值过期后可能保留至下一轮刷新；先加失败回归，再补独立到期清理，spec 复核与 quality review 通过。
- 前端生产构建、macOS app 打包及 Clippy 通过；Windows native 模块单独 cross-check 编译通过，完整跨平台原生检查交 CI。
- CUA 读取测试界面超时，未声称完成可见 UI 验收。Converge coverage provider 与正式 Review v3 runner 仍未配置，不声称已具备对应机器回执。

## 最终自动化结果

实现、回归、native 采样、独立审查及三平台打包生命周期检查已完成。可见 UI 验收因 CUA 超时除外，未标记为已验收。

源代码提交：`585edb3d7729d6a4747cc4cc472551188b45b33c`。
[三平台 CI 36956464177](https://github.com/ainiaa/yam/actions/runs/36956464177) 全部成功。

- desktop (macos-latest, app, macos/YAM-macos.zip, src-tauri/target/debug/bundle/macos/YAM.app/Cont...: success; 2026-10-02T02:41:40.9967280Z test result: ok. 164 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 9.66s
- desktop (ubuntu-22.04, deb, deb, src-tauri/target/ci-installed/usr/bin/yam-desktop): success; 2026-10-02T02:41:15.4909078Z test result: ok. 162 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 7.60s
- desktop (windows-latest, nsis, nsis, src-tauri/target/debug/yam-desktop.exe): success; 2026-10-02T02:42:59.3361178Z test result: ok. 143 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 10.27s

生产身份 YAM 已启动，确认一个 GUI 和认证 owner 正常连接；native 采样 application_bytes=110893536，workload_bytes=0。测试用隔离应用与后台均已关闭。
