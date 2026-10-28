# New session 与外部终端人工验收

作者：Jeff.Liu · 更新：2026-10-19

适用本机当前 YAM 调试版。只操作本清单新建的测试会话，不操作已有任务；不重启后台、不更换 App、不调用真实厂商。未亲自观察的项目填写“未验收”，不能用自动化单测结果代替。

## 1. 此前的窗口读取问题（已恢复）

2026-10-19 完整重启后，已重新通过应用名及 bundle identifier 读取 YAM；界面树与截图合并读取约 0.11 秒。YAM 界面验收已恢复，最新逐项结果见 [本轮验收记录](new-session-ui-acceptance-20261019.md)。

以下是重启前保留的诊断证据，不代表当前仍在超时：

- 用户确认 YAM 主窗口可见，能正常操作；切到前台后，电脑控制工具读取它仍返回 `-10005 timeoutReached`。
- 同一工具能读取“系统设置”的原生窗口；没有证据表明全局辅助功能访问完全不可用。
- Launch Services 中有两个同名、同路径、同 identifier 的进程：后台 owner 17717 为 `UIElement`，GUI 85039 为 `Foreground`。这是同一 App 的后台与界面，不是两个 GUI 实例。
- GUI 登记为 ready、未隐藏；GUI 和 WebContent 的短时只读采样均在事件循环等待，没有看到可确认的死锁。采样不等于完整交互验收。
- 启动门禁与原生重新唤起共 16 项定向测试通过。

**定位边界：** 当前问题集中在电脑控制工具连接 YAM 窗口这一层。工具在 macOS 上公开的 App 入口没有 PID 参数，不能明确绑定 GUI PID；误选无窗口 owner 是合理怀疑，但尚未取得工具内部的进程选择证据，不能当作已确认根因。没有因此修改产品代码、重启后台、重置权限或修改应用标识。

iTerm2 的另一项限制是工具明确返回 `Computer Use is not allowed to use the app 'com.googlecode.iterm2' for safety reasons.`。本轮系统终端也明确返回相同限制，目标为 `com.apple.Terminal`；不能用改名称或其他自动化方式绕过。外部实际窗口项目仍按下面步骤人工验证。

## 2. 准备：约 2 分钟

1. 使用已经运行的 YAM。当前 App 路径是：

   `/Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app`

2. 在你自己的新终端标签页运行以下命令。它们只读取 YAM 状态，并创建本轮独立的临时测试目录：

   ```sh
   YAM_BIN='/Users/liuwenyuan/www/tools/yam/apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app/Contents/MacOS/yam-desktop'
   YAM_ACCEPT_DIR="$(mktemp -d /tmp/yam-manual-acceptance.XXXXXX)"
   "$YAM_BIN" status --json > "$YAM_ACCEPT_DIR/status-before.json"
   "$YAM_BIN" sessions list --json > "$YAM_ACCEPT_DIR/sessions-before.json"
   printf '测试目录：%s\n' "$YAM_ACCEPT_DIR"
   ```

3. 记下打印出的实际目录。下面每次新建都把 **Project directory** 指向该目录。
4. 记录原有运行中会话及其 ID；以你开始时的快照为准。本轮自动化验收开始时为 57 个历史会话、1 个运行中。

不要使用“Stop all tasks and quit”。若某项失败，保留该测试会话并记录它的 ID，不要连续重试新建。

## 3. 新建入口、取消和普通终端

| 编号 | 操作 | 通过标准 |
|---|---|---|
| N01 | 分别从侧栏 New session、项目旁的新建按钮、终端工具栏的新建按钮进入；每次检查后 Cancel | 都进入同一个 New session 对话框；取消不创建会话 |
| N02 | 检查主表单及 Advanced options | 主表单有 Project directory、Startup program、Open in；没有单独的 Model source 或 Run mode 主选项；高级字段展开后可操作，不挤出底部按钮 |
| N03 | Browse directory，先取消，再选测试目录 | 取消保留原目录；确认选择后显示实际测试目录 |
| N04 | Startup program 选 Terminal，Open in 选 YAM，Custom command 留空，Start session | 新增一个普通终端；沿用已有终端配置，不启动模型 CLI |

若 Terminal 被独立模型连接禁用，先在 Advanced options → Model connection 选 **Use existing CLI configuration**，再切 Terminal。

在 N04 **新建的测试终端**内输入：

```sh
pwd
printf 'YAM-MANUAL-普通终端-中文\n'
printf 'TASK_PID=%s\n' "$$"
```

核对目录为测试目录、中文没有乱码，记录该测试会话 ID 与 `TASK_PID`。检查 shell、字体、颜色、滚动设置与原配置一致。不要对原有任务输入这些命令。

另新建一次测试终端，快速双击 Start session。**通过标准：只创建一个会话**；如果出现两个，分别记录 ID 后停止测试。

## 4. System Terminal 与 iTerm2：各执行一轮

先做 **System Terminal**，再做 **iTerm2**；每轮只新建一个测试会话。

1. New session → 测试目录 → Startup program **Terminal** → Open in 选择本轮终端 → Custom command 留空 → Start session。
2. 若 macOS 弹出“YAM 控制 Terminal／iTerm2”的授权提示，按你的授权意愿选择。拒绝或未决定时，该项记为“权限未满足”，不要反复点击 Start session。YAM 中已创建的会话应仍可找到。
3. 确认外部窗口真实出现，而不只是 YAM 提示已发送打开请求。
4. 在外部窗口输入：

   ```sh
   printf 'YAM-MANUAL-外部终端-中文\n'
   printf 'TASK_PID=%s\n' "$$"
   pwd
   ```

5. 回到 YAM，找到**同一个测试会话**，核对相同目录、中文输出和 PID；历史中只有一个对应会话。
6. 调整外部窗口大小，确认没有明显截断或持续重绘；在外部窗口连续输入一行文字，再退格删除，确认没有重复字符。不要同时在 YAM 和外部窗口打字。
7. 在外部窗口按 **Ctrl+]**，确认外部视图结束或显示进程结束，但 YAM 中该测试会话仍运行。
8. 回到 YAM 的同一测试会话；若提示输入控制权，使用界面的接管操作，然后再次执行 `printf 'TASK_PID=%s\n' "$$"`。PID 应与第 4 步相同。
9. 另建一个同类型测试会话，记录 PID 后只关闭它的**外部测试窗口**。回到 YAM 核对会话仍运行、PID 未变。已有外部窗口不能用于此项。

**通过标准：** 两种终端都能真实承载输入／输出；分离或关外部窗口不结束后台任务；回到 YAM 后仍是原会话、原 PID。外部应用使用自己的字体和主题，不要求与 YAM 配色相同。

当前 UI 在新建时选择外部承载窗口；这里验证关闭后从 YAM 历史回到原会话，不把“现有会话一键重开外部窗口”当作已有 UI 功能。

### 外部打开失败时

- 若提示 `The session was created in YAM, but the external terminal could not be opened`，先到 YAM 历史找到已创建的测试会话，核对只有一个、仍可操作。
- 若提示 macOS Automation 权限问题，在“系统设置 → 隐私与安全性 → 自动化”查看 YAM 对本轮终端的状态。是否允许由你决定；不需要停止后台加载这项授权。
- 若提示打开超时，先检查是否已经出现窗口。不要通过再次新建来重试同一个任务。
- 记录原文、会话 ID、终端名称和时间；不能把错误提示本身算作“成功打开”。

## 5. Model 下拉与绿色／红色反馈：只用本地静态夹具

以下夹具只返回固定 JSON，不转发请求、不支持推理。它模拟 Magpie 身份响应，**不是真实 Magpie 产品**。全程不要点击 Start session。

在准备步骤的同一新终端标签页执行：

```sh
YAM_GATEWAY_DIR="$(mktemp -d /tmp/yam-manual-gateway.XXXXXX)"
mkdir -p "$YAM_GATEWAY_DIR/api" "$YAM_GATEWAY_DIR/v1"
printf '%s\n' '{"name":"magpie","version":"manual-fixture"}' > "$YAM_GATEWAY_DIR/api/hello"
printf '%s\n' '{"object":"list","has_more":false,"data":[{"id":"manual/model-a"},{"id":"manual/model-b"}]}' > "$YAM_GATEWAY_DIR/v1/models"
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$YAM_GATEWAY_DIR"
```

它会打印 `Serving HTTP on 127.0.0.1 port NNNNN`。记下实际端口，保留该标签页运行。

| 编号 | 操作 | 通过标准 |
|---|---|---|
| M01 | New session → Startup program Codex → Advanced options → Configure API / gateway for this session → Custom API / Magpie gateway；URL 填 `http://127.0.0.1:实际端口`；API key environment variable 留空 | Model 可手填；没有自动发起推理；未安装的 CLI 显示 unavailable 时不要继续启动 |
| M02 | 手填 `manual/keep`，点击 Load gateway models | 显示绿色 `✓ 2 models loaded`；Model 位置出现包含 `manual/model-a` 与 `manual/model-b` 的下拉；原手填模型保留到你明确选择 |
| M03 | 从 Model 下拉选 `manual/model-b`，再选 Enter a model manually…，填 `manual/custom` | 模型值随明确选择变化；可继续手填，不强制丢弃手工值 |
| M04 | 展开 Connection checks → Check local port、Check Magpie identity | 端口结果为绿色 ✓；身份结果显示绿色 `Magpie manual-fixture identified`，清楚说明未验证上游 |
| M05 | 改 URL 为 `http://127.0.0.1:实际端口/v1`，再加载 | 上一地址的结果立即失效／隐藏；新结果来自当前地址，不能带着旧绿色标识直接冒充已检查 |

然后回到静态服务标签页按 Ctrl+C，**只结束这个夹具服务**。返回尚未提交的 New session，保持原 URL，分别点击 Load gateway models 和 Check local port。

**通过标准：** 出现红色 ✕ 及明确错误文字；Model 中的手填值仍保留；没有无限等待、静默成功或新建任务。最后 Cancel。

## 6. 本地网关预设与 CLI 切换

只检查表单，不执行网关请求或 Start session。

1. 新建 → Codex → 独立连接 → Service preset。当前本机应能看到 CC Switch；EchoBird 未安装时不应伪装为可用预设。
2. 选择 CC Switch，Codex 默认地址应为 `http://127.0.0.1:15721/v1`。
3. 在 Model 手填 `manual/selected`，切换 Startup program 到 Claude；默认地址应转为 `http://127.0.0.1:15721`，模型值保留。
4. 切回 Codex，应恢复 `/v1`。
5. 手工把 URL 改成 `http://127.0.0.1:49999/custom/v1`，再切 Claude；这次 URL 应完整保留，不自动改写手工地址。
6. Cancel。EchoBird 的实际安装集成留作对应环境验收；不要为此安装新产品或修改共享 CLI 配置。

## 7. 外部任务完成 → 通知 → 定位原会话

1. New session → 测试目录 → Terminal → Open in 选 System Terminal 或 iTerm2。
2. 展开 Advanced options，在 **Custom command (optional)** 填入：

   ```sh
   python3 -u -c 'import os,time; print("YAM-MANUAL-NOTIFY PID="+str(os.getpid()),flush=True); time.sleep(40); print("YAM-MANUAL-NOTIFY DONE",flush=True)'
   ```

3. Start session，仅点一次；记下新测试会话 ID。看到 PID 后将 YAM 置于后台，并切到其他应用，使该会话不再持有 YAM 的输入焦点。
4. 等待约 40 秒，观察 YAM 测试会话结束以及系统通知是否真实出现。只看见 YAM 内部回执或“已发送”不能算横幅／通知点击通过。
5. 点击该条测试通知。应唤起已有 YAM GUI，定位到相同测试会话，能看到 `YAM-MANUAL-NOTIFY DONE`；不应重新运行命令或增加重复会话。
6. 在另一种终端重复一轮，以分别取得两种承载窗口的证据。

若通知暂停、系统未允许 YAM 通知、处于专注模式，先记录实际状态；是否调整由你决定。若终端打开失败，先处理第 4 节的已有会话，不重复创建。若缺少 python3，记录环境缺口，不改后台 PATH 或重启 owner。

本项只证明普通有限命令的生命周期通知。原生 CLI 的逐轮／子代理通知仍需真实 CLI 加本地模拟 API 的专用验收，不能用本项替代，也不要通过真实模型请求补测。

## 8. 收尾与结果记录

1. 仅对本清单创建的交互式测试终端输入 `exit`，或使用该会话自己的停止操作；不要停止任何基线中的运行会话。有限通知测试命令会自行结束。
2. 在准备步骤的终端执行：

   ```sh
   "$YAM_BIN" status --json > "$YAM_ACCEPT_DIR/status-after.json"
   "$YAM_BIN" sessions list --json > "$YAM_ACCEPT_DIR/sessions-after.json"
   ```

3. 对照 before／after：原会话 ID、运行状态应保留，基线中的运行任务不能因测试被停止；总历史数会因新测试会话增加，这本身不是重复创建。基线后出现但不属于测试目录的任务也应保留，不要擅自认定它是测试残留。
4. 临时夹具停止后保留 JSON 快照和测试截图；不清理现有历史或真实系统通知。无需重启 YAM 或后台。

| 项目 | 结果：通过／失败／未验收 | 测试会话 ID | 时间／截图／原始错误 |
|---|---|---|---|
| N01–N03 入口与取消 | | | |
| N04 普通终端与原配置 | | | |
| 双击仅创建一次 | | | |
| System Terminal 输入、分离和关窗 | | | |
| iTerm2 输入、分离和关窗 | | | |
| M01–M05 模型选择与绿色反馈 | | | |
| 断开夹具后的红色错误 | | | |
| CC Switch 默认／手工路径切换 | | | |
| System Terminal 通知与定位 | | | |
| iTerm2 通知与定位 | | | |
| 原有任务保全 | | | |

EchoBird 安装集成、真实厂商鉴权／计费、正式签名／公证及跨平台桌面行为不在这份本机无厂商请求清单的通过范围内。
