# YAM 活动 SGR 原生分配归因与修复续轮

作者：Jeff.Liu

## 起点和约束

继续同一内存优化事项。起点源码为e8b4fdcc…，HEAD b1a7b9d4…及188项既有脏文件不覆盖。上一轮完整8小时40.7秒增长检查通过，但五项物理门槛、短长测包字节绑定及16测试视图覆盖未通过；不撤销这些失败。上次日志启动166.9秒，仅取得8.79M有栈分配，147.1M仍无栈，未执行活动SGR对照。

沿用Converge Plan/Converge/Ponytail的普通手工证据流程，不伪称受托管Single State/Review v3。唯一规范YAM.app、com.yam.desktop，不复制App、不改安全/辅助功能权限、不安装依赖、不提交/推送/发布。用户已授权CLI临时日志启动及本轮活动对照；不重复申请同一启动授权。

## 先后顺序

1. 冻结当前源码/包、所有旧证据和本轮对照。先写并运行诊断脚本的红绿测试，覆盖正常、重复/缺失PID、异常报告、负载失败和通知清场。
2. 正常退出空闲GUI，用临时MallocStackLogging=1及__XPC_MallocStackLogging=1启动同一规范包。预先修复诊断专用的进程关联方式：CLI缺coalition时，以唯一规范GUI、唯一新YAM Web Content、可执行文件、启动身份和调用前后身份约束目标，不放宽产品内存采样器。
3. 一个窗口内记录三个阶段：冷启动无新负载；单个owned视图填满2200条种子后暂停输出；同一视图释放60秒一行/秒的完整SGR。各阶段记录同PID的精确footprint、vmmap、heap及malloc_history调用栈/无栈摘要。真实桌面核对owned会话和输出变化，窗口/DPR/保留行不降级；不打开Inspector或强制GC污染测量。
4. 每次日志启动最多180秒，标准模式只跑一次。若无栈大块仍妨碍归因，且已核对本机/上游机制，仅允许一个不同的lite模式诊断窗口。lite会影响分配器选择，单独记录，不能当作产品收益或与正常模式作物理性能放行。
5. 比较冷启动、暂停、活动的有栈/无栈增量，区分启动池、输出暂存、渲染/图形、分配器保留与真实对象增长。没有分配栈的部分明确未覆盖，不武断归为系统必需内存或泄漏。
6. 仅在证实可复现业务根因后，先失败测试，再最小修复；检查调用者、取消/失败/恢复和Unicode/VT/选择/滚动边界。若根因落到冻结范围外，先更新范围与验证计划，不猜改。
7. 按影响面运行必要回归、规范打包与独立复核；不重复不受影响的Rust全量。使用最终同一个正常包验证原物理门槛，保留失败不选最小值。生产代码或最终包变化后再跑完整8小时，真实16视图前置条件和可见性要有记录。
8. 精确结束owned负载，恢复原始通知策略和普通LaunchServices启动。核对无诊断进程/日志环境遗留、唯一GUI、active_sessions=0、历史/未读未破坏、源码包及已安装版本。最终正式审计只按实际通过证据判定，未覆盖或未达标保持PARTIAL。

## 诊断机制参考

WebKit当前Environment.cpp对MallocStackLogging=lite有切换系统堆的分支，需以本机实测确认，不能把上游实现当成本机成功证据：
https://github.com/WebKit/WebKit/blob/main/Source/bmalloc/bmalloc/Environment.cpp

本轮原始证据位于.artifacts/native-sgr-20261115/；旧8小时封存继续保留。机器Plan v6见该目录plan.json。

## 分配栈后的有界补查

标准和lite各一次已完成，不重跑取最小值。lite将无栈分配降到34K；大块实际来自JSC LocalAllocator，活动阶段还增加span/Text和样式分配。堆块不是逐个JS存活对象，原生栈中的JIT地址也不能直接当成业务源码行。

新增一次不同方法的180秒普通环境诊断：只创建本轮owned SGR任务，用至多32个WeakRef和标量MutationObserver统计行节点替换；暂停、活动后分别采样，结束后仅作一次Inspector诊断GC并检查弱引用是否释放。观察器不得强持有节点，不导出对象内容，清除观察器和全局临时变量；原始通知策略写盘并恢复。Inspector/GC产生的数值只解释生命周期，不作正常产品内存收益。该补查不新增日志启动窗口，不重建或修改产品包，不替代原五项门槛、16视图或8小时验收。

## 实测结果和归因

标准模式完整窗口131.63秒，正常退出；lite完整窗口177.03秒，取得三个阶段后，由finally对精确owned GUI执行SIGTERM退出（退出码−15），未触发180秒watchdog。两次都没有错误、包漂移或清场错误。标准窗口的CUA在输出16至38时看到了运行中彩色输出；lite的种子视图得到实际核对，活动55号输出和同实例/尺寸由RPC证实，但活动截图取得时任务已停止，不伪称其CUA运行中验收通过。

标准模式精确physical footprint（MiB；每阶段先采指标，再顺序执行工具，非原子快照）：

| 角色 | 冷启动 | 种子后暂停 | 活动60秒后 |
| --- | ---: | ---: | ---: |
| GUI | 50.61 | 52.25 | 52.25 |
| 页面 | 140.66 | 198.30 | 221.36 |
| GPU进程 | 66.81 | 67.61 | 69.53 |

冷启动阶段仍在初始化，稍后的vmmap已经到208.4M，不能把冷启动工具数值当成同一时刻的稳定基线。页面活动增量23.06MiB；这是日志诊断包的观察，不是优化前后收益，也不是GPU硬件忙碌率。

标准模式malloc_history的活动阶段只有9.48M/25113笔有栈，149.5M/463312笔仍无栈。lite活动阶段155M/365258笔有栈，只有34K/1327笔malloc无栈；因而补齐了大部分原生分配来源的可见性。M/K均保留工具原始单位，不混称精确字节。lite改变分配器和日志开销，不能与标准模式比较内存收益。

调用树分析使用叶子分配归组，父/子累计字节绝不相加。6个报告的叶子数加内部未归组分配数均等于原生根计数；lite活动365258笔中365203笔归入互斥叶子，55笔内部余额明确保留。归组算法先红后绿，覆盖重复符号、递归、通用分配器、bytes/K单位、计数不一致和缺失树。

lite同一进程暂停→活动的近似归组结果（基于已四舍五入的原生输出）：

| 分配调用点 | 暂停 | 活动 | 增量 |
| --- | ---: | ---: | ---: |
| JSC LocalAllocator | 78.46MiB | 82.63MiB | 4.17MiB |
| JSC resolveRope 字符串展开 | 0.26MiB | 1.80MiB | 1.54MiB |
| Gigacage tryAlignedMalloc | 12.22MiB | 12.22MiB | 无变化 |

LocalAllocator是JSC堆块分配路径，包含堆块及其管理分配；分配笔数不是JS对象数，也不能把这些字节称为泄漏对象大小。其调用者包括activation、object、array和function等，部分中间JIT地址仍显示???，尚不能映射到具体业务持有链。WebKit上游LocalAllocator/MarkedBlock源码支持其分块分配机制，但不能替代本机版本的逐行符号证明：

- https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/LocalAllocator.cpp
- https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/MarkedBlock.cpp

原生heap分类另见HTMLSpanElement 314→3388（+3074）、Text 709→3786（+3077），伴随样式、字体、字符串分配增长。已安装xterm6.0.0的DomRenderer.renderRows逐行createRow/replaceChildren，RowFactory会创建span并逐单元格生成装饰回调。它解释了真实的渲染分配来源；尚未将某个JIT闭包栈唯一符号化为该源码行，不能把所有function增量归给它。没有直接修改node_modules、替换渲染器、降画质或强制回收。

标准模式活动vmmap另显示：总malloc allocated154.8M、dirty+swap碎片26.0M、图形owned unmapped dirty32.4M；这些口径与进程footprint有包含关系，不能累加成新的YAM总内存。剩余占用并非全部属于JS可达对象。

## 节点生命周期补查的失败与补充证据

普通环境的owned任务确实产生55号及后续SGR输出。控制器在170.07秒因Observation deadline退出1，已精确清场并恢复all策略（原始策略已保存）；失败文件保留。CUA再次打开检查器时已超过观察窗口，故不把后续读数追认为该窗口通过。

后续Console实际读到added783、removed733、sampled32；另一条只读表达式读到32个WeakRef全部失效、connected0、当前终端span70。没有点击Collect garbage：抽样节点已经自然释放，不需要再作诊断GC。观察器已disconnect、临时全局已delete并读到typeof undefined。样本只覆盖最早32个移除节点，Inspector停靠改变视口，不能证明全堆无泄漏或持续正常尺寸渲染。一次自动补全拼接anchor导致SyntaxError，原始失败保留；改用AX setValue和Command-Return后读到真实结果。

## 当前结论和未完成项

本轮完成了活动SGR的原生分配来源对照，发现主要是JSC堆块/编译相关分配、字符串与DOM/样式分配，以及原生碎片和图形表面。抽样节点能够自然释放，未证实其被业务持续强引用。尚未取得从剩余大块到应用源码的唯一分配/持有链，不能安全选择业务补丁；本轮业务代码未改，不能宣称修复完成。

原五项物理门槛仍全部失败，短长测包字节绑定、16测试视图及连续可见性/GPU硬件利用率的旧缺口仍保留。旧完整8小时原始封存重新校验成功；没有对未改变的业务代码和包重复8小时取较好结果。后续真正候选改变后，仍须同包短测、16视图前置核对和完整8小时。

下一次有意义的修复前置是：取得JSC分配的JS源码符号与保留路径，区分仍可达对象、引擎堆块保留及回收后的碎片；再对已证实的应用入口写失败测试。现有窗口额度已用完，未重复标准/lite或把检查器/重启后的下降算成优化。

## 清场和审计

诊断辅助测试9项、调用树分析6项、验收边界2项均有实际红绿记录。18次原生工具调用均退出0并记录argv/耗时/SHA。两组原始证据103文件已本地SHA封存；这不是外部签名或托管Review v3。

所有3个本轮owned任务已停止或成功结束，通知策略均恢复，未读仍116。已关闭检查器、移除临时观察器，正常退出并经CUA从唯一规范路径重新启动；恢复后GUI单实例、后台active_sessions0，GUI/后台/Node未携带日志环境。规范包和已安装版本哈希与前置一致。重启后的337.5MiB只用于恢复核对，不作优化收益。

自动审计按原门槛返回incomplete/退出1，R2保持PARTIAL，不发布。原生归因的进展不代替未完成的根因修复和产品验收。详细检查及原始失败见.artifacts/native-sgr-20261115/audit.json、retention/result.json和supplemental-ui.json。
