# Native output-stage diagnostics — finite receipt

作者：Jeff.Liu

2026-10-09：有限诊断源码与独立 GPT-6.1-sol spec/quality 复审通过。仅 debug/developer background owner 且显式 `YAM_OUTPUT_STAGE_DIAGNOSTICS=1` 开启；默认关闭，关闭时无额外观测时钟调用或累加器分配。专用 fixture.environment 固定设置该环境变量为 `1` 主动 opt-in，没有额外 CLI 开关。未构建或运行新的实际 native artifact/owner，4096 字节读缓冲保持；未实施 16 KiB 优化。

每个现有输出 worker 记录原始 read 次数/字节/min/max 与 1–256、257–1024、1025–2048、2049–4096 四桶，另记解码后 publish 次数/字节；两种字节单位不能等同。观测真实 log lock wait、parser output total、parser serial lock wait、成功入队至 reply、append 和 emit。parser total 包含嵌套 serial/reply 区间，不能相加；reply 区间含排队调度、管道及服务往返，并非纯 parser 时间；emit 不测 GUI 接收/渲染。统计为 worker 全生命周期 count/sum/max，不是分阶段或分位数。

原有完成顺序保留，在 output_done 后、所有业务锁之外输出一次固定数值摘要；摘要长度有界但 stderr 写入时间无界，可能保留 detached worker 资源，突然退出也可能丢失摘要。采集器继续有界排空，只保留最多两条匿名行，不推断 echo/flood 身份或唯一性；两条相同有效行仍允许，第三条、缺失/截断、溢出、异常与不一致字段都不能产生完整诊断。重复 JSON 字段在任意深度被拒绝；read 总量校验要求实际 min/max 见证。观测本身仍有开销。

验证：Rust 定向 12、Python 定向 9 通过；Rust library 全量 656 通过、3 项既有忽略；两套 Python helper 共 143 通过；两个所改 Rust 文件格式及 diff 检查通过。独立 Sol 再跑 Rust 12/Python 9，并验证原 false-complete probes 被拒绝、两条相同有效行仍完整，无剩余发现。保留 scaffold 编译失败与实际语义 RED，未将其混算；临时假服务使用独占创建、0700、write_all，冲突文件/符号链接保全，失败仅清理自身创建文件。184 文件最终源码 aggregate：`e75cfa38a2fb32700d0d7a22fd92c973d0bd0115124a35ffef5e04154fcd5a1d`；root 已核对修复冻结与实际 lease 释放。

本片不解释或修复历史 R9 原因，不证明 native 性能、GUI 无卡顿、完整 A11 或 Suite 验收。后续实际运行须另行授权并绑定新 artifact；updater 继续暂停。外部证据胶囊：`/tmp/yam-native-output-stage-scout-20261009`。
