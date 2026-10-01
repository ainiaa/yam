# YAM 持续会话总内存测量

作者：Jeff.Liu。日期：2026-10-02。

Apple M5、16 GiB、macOS 26.6.2、ARM64；本地 debug / ad-hoc 包 YAM Platform Validation，业务源码 6666b61，包 178.52 MiB。终端内核为已批准的 Node 26.10.0 SEA、xterm 6.0.0、serialize 0.14.0。后续平台退出和阻塞读帧修复不在此测量包中；不要把这份测量冒充最后源码的完整验收。

复用旧基线 /tmp/yam-continuity-output-fixture.py：每会话每 10ms 输出一行含中文/emoji、96 个 x 的文本，最长一小时。16 会话滚动预算均为 2000 行；实际尺寸为 1 个 111×28、15 个 100×24。没有完成快速切换的人工验收，窗口锁定期间仍保持后台及 WebKit 采样。

collector 使用 LaunchServices coalition 归属 WebKit，并用私有认证连接绑定 owner 和同包 terminal-service；逐次核对 PID 启动身份，测试负载独立统计，不采集 argv/env。下表是每进程物理 footprint 求和，包含共享记账，不是系统去重占用，不与 RSS 相加。

| 场景 | 完整样本 | footprint 中位数 MiB | 范围 MiB |
|---|---:|---:|---:|
| idle | 1 | 109.27 | 109.27–109.27 |
| one | 6 | 136.66 | 133.55–140.57 |
| four | 6 | 192.06 | 174.51–206.95 |
| sixteen | 344 | 337.98 | 262.87–393.75 |
| stopped | 13 | 349.79 | 342.98–426.92 |
| desktop-exited | 6 | 182.51 | 182.51–182.51 |

16 会话长测 1800.07 秒，所有样本都有 16 个负载；5–10 分钟均值 340.12 MiB，最后 5 分钟 340.81 MiB。未出现持续线性增长；不能证明没有任何泄漏。

16 会话的组件中位数：

- desktop：23.69 MiB。
- webkit：136.49 MiB。
- background-owner：12.67 MiB。
- terminal-service：163.97 MiB。

组件中位数不能直接相加得到合计中位数。停止后所有测试负载已消失，但运行时保留峰值分配，footprint 没有立即回到冷启动水平。退出 GUI 后样本只包含后台与解析器，所有任务已停止；这是空后台成本，不是 16 个活跃任务在 GUI 退出后的成本。最后显式 shutdown 已释放测试后台。该成本应向用户明确，不通过强制 GC 或未测量的缓存策略掩盖。

旧基线 16 会话中位数 459.38 MiB、停止末次 447.63 MiB；本次对应中位数 337.98 MiB、停止末次 347.79 MiB。夹具相同，但构建、窗口/终端尺寸、桌面锁定和同时编译的干扰未严格控制；这些数值只提供方向参考，不能据此承诺固定降幅，也没有 cmux 对照。idle 只有一次诊断样本。

原始样本位于 /tmp（临时保存），SHA256：

- `/tmp/yam-continuity-new-idle-20261002.jsonl`：`7f2995dfd2d7ed357bbfb5ee9ac05f9759a2272255dce970837abf3608976dc3`。
- `/tmp/yam-continuity-new-one-20261002.jsonl`：`19afb5d1e966a707f7412ac963a2dc342c332e3191881cc4e53f665aa268ec4d`。
- `/tmp/yam-continuity-new-four-20261002.jsonl`：`33bd53e73e4d5563308710f57cf434f970114b95ffc77d030b1487d53354193e`。
- `/tmp/yam-continuity-new-sixteen-20261002.jsonl`：`d7f8c3093a7570ae02dc18b5130381050ba792deae35e519568879f7e1aa6cc9`。
- `/tmp/yam-continuity-new-stopped-20261002.jsonl`：`b82a5607814652db4cf02fde6b36c6fda9ce2212798058ff8cb99fbb3b7833e7`。
- `/tmp/yam-continuity-new-desktop-exited-20261002.jsonl`：`2569a04498c2804ec24c830d16e61c78e6995ecd8d9b62ef53bf0f510b6117df`。

## 当前源码的活跃任务退出补测

400f5ba 重新打包为隔离 YAM Final Validation（com.yam.final-validation），相同 Node/xterm 与 178.52 MiB debug 包。16 个相同合成负载、100×24 终端；通过后台 RPC 创建，未执行原生快速切换，不能与上面的已选终端长测直接比较。每阶段 60 秒，通知暂停，没有新增系统权限或 CLI 信任。

| 场景 | 完整样本/总样本 | footprint 中位数 MiB | 范围 MiB |
|---|---:|---:|---:|
| 16 活跃任务、GUI 存活 | 13/13 | 281.03 | 205.18–286.21 |
| 16 活跃任务、GUI 已退出 | 13/13 | 166.84 | 163.78–168.72 |
| 16 活跃任务、GUI 重开 | 12/13 | 281.57（仅完整样本） | 263.68–288.05（仅完整样本） |

退出 GUI 使用 SIGTERM，仅作用于隔离测试 GUI。退出阶段每个样本仍有 16 个负载，后台 PID 不变，WebKit/GUI 已不在归属中；它补齐此前只有空后台成本的缺口。重开后的 RPC 核对确认同一后台、16 个活跃且唯一的历史会话。重开采集有一次 `Coalition membership changed during measurement`，采集器保持 fail closed 并退出 2，整轮为 partial，不能把完整子样本的统计写成整轮通过。测试后台、负载和 GUI 已关闭。

本次短测不替代 30 分钟趋势证据，也不关闭当前源码长测、原生快速切换及键盘/鼠标/缩放验收。

- `/tmp/yam-final-sixteen-desktop-20261002.jsonl`：`120abb911a93e3ec5f6d19ccceac02a35b50165cf20326f3a70d8c814e0a2907`。
- `/tmp/yam-final-sixteen-desktop-exited-20261002.jsonl`：`cae008a1793b6fec9e16601cf346f39213cbbca92b72c08d69d3094fc890b98b`。
- `/tmp/yam-final-sixteen-desktop-reopened-20261002.jsonl`：`d212ec64515293898864d2e3375fe22b40fb8876c116a3e9ec1d169b1866c4f2`。
