# Authoritative Clear terminal display — finite closure

作者：Jeff.Liu。2026-10-09。

现有按钮改为 **Clear terminal display**。当前受支持的运行中普通、Agent、command 或 SSH 终端，在 normal buffer 中清除旧显示行并保留当前光标行；保存日志不删除，不发送输入，不停止或重新启动进程。结束/保存场景、alternate buffer、旧或不可用 parser 不执行 renderer-only fallback。

清除发生在已有权威 parser，使用公开 clear()/scrollToBottom()，处理自己的提示符 marker ring并保留目录/命令报告、模式、尺寸和容量。一次 pending 操作隔离旧viewport请求；期间手动滚动不发旧absolute viewport RPC，完成后正常poll投影新权威场景。新选择和新附件不被晚回调清除。

源码/测试与独立有限spec、quality通过：6生产、3feature测试路径、7机械绑定路径，181源文件。当前冻结字节 fresh1225全前端及build通过，执行前后maps均精确匹配；fmt/clippy/diff通过。作者native定向5项为4项Clear相关及1项既有无关回归。独立37项JS、20项相邻JS、4项相关+1项无关Rust、4个外部actualApp probe按分组记录，不加总为唯一测试数。

实际test-first RED包括旧生产Clear→onScroll→权威scene重现旧内容、native live scalar缺失、public clear-only之后未following；后续owner不可用capability残留与legacy undefined/null额外availability通知也真实RED→GREEN。AST factory/missing export属于scaffold；首全量27失败、marker设置与异步等待属于夹具/合法注册更新，原ASSERT保留。全部原始失败证据外置。

旧full/build执行时App SHA早于一次trailing-whitespace清理，未保存pretrim字节副本，不能证明旧规范化projection；此缺口已用当前冻结字节freshfull/build闭合，未补造旧afterimage。未重跑fullRust或coverage。公开browser open/Fit生命周期stub、AST与service测试不代表原生GUI/真实owner/ReactDOM、完整parity或Suite验收。自动更新保持暂停。NEXT B05仅计划，不新增能力声明。

证据胶囊：`/tmp/yam-terminal-authoritative-clear-20261009`。源码map为`all-source-hashes.json`（相对路径→SHA256对象），aggregate `9d2b16e2413c57b06ecd23b82a9dc558fcab1ffa7d1efd2dae9f9b8889d50e98`，算法为按path排序的UTF-8 compact JSON、无末尾换行再SHA256。源码与文档租约均实际释放后外置逐成员归档；不含应用包、私有HOME、认证或用户数据。
