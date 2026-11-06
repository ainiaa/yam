# OMP 新版 ChatGPT OAuth 桥接扩展

作者：Jeff.Liu

独立验证扩展，不修改 YAM 的默认 Pi 引擎。OMP 使用原生 Responses 流处理；登录与刷新由已安装 Pi 的原生认证存储锁统一管理。OMP 不保存刷新令牌，`yam-chatgpt` Provider 不回退到 API Key。启动器仍允许用户显式选择 OMP 的其他 Provider，本扩展不改变其认证行为。

## 前提与启动

本轮核验环境：macOS、Node 25.9.0、Pi 1.5.0、OMP 18.16.0。`pi`、`omp` 须在 PATH 中；Pi 已完成新版 ChatGPT 登录（`~/.pi/agent/auth.json` 的 `openai` 身份）。启动器读取 macOS 已启用的 HTTP/HTTPS 系统代理，仅给子进程配置代理；暂不支持 PAC、SOCKS 或带认证的代理。Pi/OMP 版本固定，升级后需要重新验证。

在仓库根目录启动独立交互会话：

```sh
node extensions/omp-chatgpt/run.mjs --model yam-chatgpt/gpt-6.1-sol --thinking low
```

这条命令启动终端交互界面；自动验证使用 `--mode rpc --no-ui`。启动器固定隔离配置 `yam-chatgpt-validation`，会话保存在 `~/.omp/profiles/yam-chatgpt-validation/`。可加 `--resume <sessionFile>` 恢复该配置内的会话。模型由当前订阅的官方目录发现，示例模型须在你的目录中可用。

`auth.mjs` 是私有管道辅助程序，不能作为交互命令直接执行：其标准输出包含短期访问令牌，父进程只在内存中接收。刷新令牌仅留在 Pi 存储中。取消模型请求不会中断正在轮换令牌的 Pi 刷新，以便完成安全写回。

## 请求边界

- 模型目录与推理限定为官方 `https://api.openai.com/v1/models` 和 `/responses`，推理禁用重定向，强制 `store:false` 与 SSE。
- 每次推理读取 Pi 当前身份，目录在同一访问令牌下最多缓存 60 秒。凭据变化重新发现；订阅拒绝、额度不足或未知模型直接失败。
- 使用 OMP 原生模型构建器及流处理器，不另写 SSE 协议。仅暴露 OMP 能表达的 reasoning effort；上游 `ultra` 不伪装为 `max`。
- UI 成本字段为 0 表示没有 API 单价估算，**不代表订阅额度不消耗**。
- 无新增依赖。辅助进程依赖 Pi 1.5.0 安装内的认证接口，版本变化需重新核验。

## 离线检查

```sh
node --test --experimental-test-coverage '--test-coverage-include=extensions/omp-chatgpt/*.mjs' apps/desktop/tests/omp-chatgpt.test.mjs
```

测试只用假凭据与 Node 子进程，不启动桌面应用、不访问真实订阅。覆盖率统计包含实际载入的 `provider.mjs`、`runtime.mjs`、`auth.mjs`；OMP 入口 `index.mjs` 与 macOS 启动器 `run.mjs` 由真实 CLI 验证，不能把前述覆盖率称为整个扩展的覆盖率。
