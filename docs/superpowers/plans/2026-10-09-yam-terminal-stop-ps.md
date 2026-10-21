# Unix process-tree lookup：固定系统 ps

作者：Jeff.Liu。

2026-10-09，有限修复移除 process_tree 对 owner PATH 的依赖，依次选择 /bin/ps、/usr/bin/ps 中存在、regular file 且有执行位的系统工具，允许系统symlink。两者不可用返回明确错误；已选择工具的启动或退出错误直接传播，不执行第二候选重试、不伪造空成功树。

真实 current-exe 隔离子进程在空PATH与无ps的私有目录PATH下验证生产 process_tree。旧bare ps实现实际失败，修复后两种环境通过。选择器正常/缺失/非文件/不可执行/symlink/选中后启动失败边界通过，7项既有test-owned PTY/子进程生命周期测试通过。独立审核9项exact cargo检查与两个子probe通过；fmt、clippy all-targets -D warnings、diff检查通过。Windows、ps argv/输出解析、SIGSTOP失败后的SIGCONT恢复与原身份生命周期逻辑保持。

过宽ps_筛选意外执行25项（24通过、1测试夹具失败）的原始日志保留；macOS无shebang文本可由shell fallback，不能以此断言spawn错误。夹具改为选中后删除自有文件，验证真实启动失败。metadata不可读按候选不可用处理，未将读取错误转换为成功进程树。

这是一般PATH依赖bug的源级实证，不证明历史r7两次stop拒绝的具体原因。r7原结果不修改，fresh packaged r8验收待授权。未重跑full Rust/frontend，未构建新应用或启动用户owner/GUI；原生GUI、完整Suite与跨平台验收仍待，updater暂停。
