# OMP 独立启动器与 Provider 路由

作者：Jeff.Liu

默认选择 `yam/auto`，在 Provider 请求层复用 Pi/Codex 的任务分类、执行规则与续接下限；不通过 Hook 修改会话模型。默认由 GPT-6 Luna 分类，轻任务使用 ChatGPT 订阅 GPT-6 Luna，其他任务使用 Magpie Qwen3.7 Plus。ChatGPT 认证默认使用 YAM 自身注册的应用身份与官方新版授权；Pi 登录保留为显式备用来源，不回退到 API Key。

## 从 YAM App 启动

新建会话 → 启动程序 **OMP** → ChatGPT 认证，默认选择 **YAM ChatGPT 登录**，也可显式选择 **Pi 登录（备用）**。路由策略直接选择已有的 Pi 格式策略，无须复制策略。认证来源随策略快照保存，继续会话保留来源；旧版未记录来源的历史继续使用 Pi。选择“不启用路由”时，新会话默认使用订阅 Luna，继续会话保留原生模型，不发分类请求。自动路由的实际连接、模型与推理强度显示在 OMP 终端状态行，`/yam-route` 查看本轮选择。

App 安装包包含同一套 Provider 与分类规则，按内容摘要暂存到私有目录，不依赖本仓库路径。每个新会话分配独立原生会话目录；继续会话会核对原生 ID 与工作目录，不重放旧提示。App 管理的 OMP 通过 YAM 新建/继续会话；原生跨文件切换与分支操作会被阻止，以保持身份一致。复制会话保留策略快照、清除原生会话身份。系统代理由启动器读取，Pi/OMP 版本按运行时能力检查。

## 前提与启动

`omp` 与支持环境代理、SQLite 的 Node 须可用；选择 Pi 备用时才要求 PATH 中的 `pi` 及其新版 ChatGPT 登录。本机 Magpie 默认地址为 `http://127.0.0.1:3425`。启动器读取 macOS 已启用的 HTTP/HTTPS 系统代理，认证、刷新、模型目录与推理使用同一代理环境；本机网关直连。暂不支持 PAC、SOCKS 或带认证的系统代理。不限制 Node/Pi/OMP 的具体版本号，按实际接口检查。缺少接口、模型或认证时明确停止。

在仓库根目录启动独立交互会话：

```sh
node extensions/omp-chatgpt/run.mjs
```

首次交互启动会打开本机授权页，点击 **Continue with ChatGPT**，在 OpenAI 页面核对应用名为 **YAM** 并授权订阅用量。可用 `--yam-login` 显式重新授权，或 `--yam-auth pi` 选择 Pi 备用。无界面 RPC 不会自动打开浏览器。两个来源互不读取对方凭据，不自动降级。

YAM 授权记录保存于 `~/Library/Application Support/com.yam.desktop/sessions/omp-auth/auth.json`（目录 0700、文件 0600），独立于 Pi 和 OMP 原生认证库。稳定 host/client、身份与轮换令牌原子保存；重启复用同一注册，不重复注册。OIDC 校验签名、issuer、audience、nonce、过期时间和账户身份，授权回调使用 state/PKCE。刷新遵守 `earliest_refresh_at`，使用进程间 SQLite 事务互斥；进程退出自动释放锁。 App 管理的授权和刷新由后台所有者启动一次性认证进程，位于终端进程树之外。停止会话会断开等待：授权尚未接收时取消登录，已接收的授权或刷新继续安全保存后退出。终端的普通子进程清理规则保持不变。

这条命令启动终端交互界面；自动验证使用 `--mode rpc --no-ui`。启动器固定隔离配置 `yam-chatgpt-validation`，会话保存在 `~/.omp/profiles/yam-chatgpt-validation/`。可加 `--resume <sessionFile>` 恢复该配置内的会话。模型由当前订阅的官方目录发现，示例模型须在你的目录中可用。

TUI 的路由状态显示本轮实际连接、模型和推理强度；`/yam-route` 查看本会话最近的路由记录。原生模型栏继续显示逻辑模型 `yam/auto`。回复历史保留实际 Provider、模型、推理强度与用量。

使用现有 Pi 导出的策略 JSON，或单条 `{adapter:"pi", setup:"..."}` 策略记录：

```sh
node extensions/omp-chatgpt/run.mjs --yam-policy /absolute/path/policy.json
```

策略在启动时读取为快照；支持两档/三档、分类候选、同计费渠道执行候选、任务规则和单代理执行规则。`yam-codex/`、`openai-codex/`、`openai/` 订阅键映射到 `yam-chatgpt/`；`yam-gateway/`、`magpie/` 映射到 `yam-magpie/`。协作工作流仍由 Pi 执行，OMP 遇到匹配的协作策略会停止，不静默降级。

显式原生模型保留原桥接行为，不启用自动路由；不能同时指定策略文件：

```sh
node extensions/omp-chatgpt/run.mjs --model yam-chatgpt/gpt-6-luna --thinking low
```

## 路由边界

- 分类使用现有 `classifierPrompt`、`classifyCandidates`、`routeFacts` 和 `selectExecutionRule`。默认订阅分类预算 45 秒；失败或非法结果停止执行。超长新输入只发送有界分类摘要，并使用保守执行档。
- 每条用户输入的路由记录绑定策略快照与输入摘要。重试、工具续步和原生会话恢复复用记录；新输入重新分类。历史分支变化会重载当前分支记录。取消信号覆盖分类与执行，迟到分类不会提交记录。
- 模型和推理能力来自实时目录。Magpie 按声明的原生协议选择 Messages 或 Chat Completions；Qwen 使用 Messages 的自适应推理配置。执行候选只能在原配置的计费渠道内选择，不因服务失败偷偷切换到其他渠道。
- 路由模式仅在本会话关闭 OMP 原生模型 fallback，避免绕过策略；采用可跨连接读取的 `soft` 文本压缩。逻辑模型使用候选模型中保守的窗口/输出上限，压缩和上下文恢复仍由 OMP 管理，不修改全局设置。

此前验证中的 503 是未使用系统代理导致的。启动器接入系统代理后，ChatGPT 订阅 GPT-6 Luna 与 Magpie Qwen3.7 Plus 的真实请求均已验证成功；该问题已解决，不再作为订阅重试遗留问题。

`yam-auth-helper.mjs` 与 Pi 备用的 `auth.mjs` 是私有管道辅助程序，不能直接用于交互：读取模式的标准输出包含短期访问令牌，父进程只在内存中接收。刷新令牌与身份令牌不传给 OMP。取消模型请求立即结束本轮，正在轮换的刷新由辅助进程完成并写回；取消尚未接收授权码的登录会关闭监听器，不保存凭据。已接收授权码后完成安全写回，但取消的启动不会继续启动 OMP。

## 请求边界

- 模型目录与推理限定为官方 `https://api.openai.com/v1/models` 和 `/responses`，推理禁用重定向，强制 `store:false` 与 SSE。
- 每次推理读取选定来源的当前身份，目录在同一访问令牌下最多缓存 60 秒。凭据变化重新发现；订阅拒绝、额度不足或未知模型直接失败。
- 使用 OMP 原生模型构建器及流处理器，不另写 SSE 协议。仅暴露 OMP 能表达的 reasoning effort；上游 `ultra` 不伪装为 `max`。
- UI 成本字段为 0 表示没有 API 单价估算，**不代表订阅额度不消耗**。
- 无新增包依赖。YAM 认证使用 Node 标准库；只有 Pi 备用依赖已安装 Pi 的原生认证接口，不使用版本白名单。

## 离线检查

```sh
node --test --experimental-test-coverage '--test-coverage-include=extensions/omp-chatgpt/*.mjs' apps/desktop/tests/omp-*.test.mjs
```

离线测试只用假凭据与隔离子进程，不启动桌面应用、不访问真实订阅；覆盖策略导入、请求身份和用量、续步/重试复用、分支恢复、取消、失败阻断、系统代理和能力检查。入口另用注入依赖验证，真实 OMP 导入、网络连接、压缩和 TUI 应使用隔离配置进行无桌面窗口的 RPC/PTY 验收；源码覆盖率不能代替真实连接结果。
