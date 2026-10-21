# YAM：shared shortcut resolver 未知方向键边界修复

作者：Jeff.Liu。

方向路由现在只接受精确 ArrowLeft/ArrowRight/ArrowUp/ArrowDown，保留 macOS Command+Option 和其他平台 Ctrl+Alt+Shift 的既有组合。未知 synthetic event.key 返回 null，不抛错、不消费事件、不执行方向动作。八项可编辑绑定、存储、Find/font/scroll 路由和 App 业务保持不变。

root 初次诊断仅实际执行 mac toString，发现旧 literal lookup 返回继承属性。作者随后分别运行两平台×toString/constructor/__proto__×resolver/实际 App handler 共12个独立 semantic RED；App assert.doesNotThrow 先失败，RED未执行其后的传播断言，GREEN才确认零消费/零动作。最小修复只有四个显式 Arrow 相等比较，不用 caller catch 或新框架。

1生产+2既有测试/3owned，145source。101定向/1052完整前端通过，coverage99.72/93.50/96.12、build/diff通过；每finalcheck前后map精确绑定最终源码，Rustprefix25字节不变未重跑。独立gpt-6.1-sol spec/quality PASS无finding，82定向及原probe1通过，root方向finding CLOSED_VERIFIED。此前A05a2 scroll-map与retention历史回执保持原样。

这验证synthetic边界与actual AST callbacks，不证明物理键能产生原型名称，也不是真实ReactDOM/native传播。nativeOS/键盘/TUI/FormalSuite仍未验；原debug138包不含此修复，updater继续暂停。

外部归档：`/Users/liuwenyuan/.local/share/yam/development-archives/20261009-cmux-shortcut-key-boundary/evidence.tar.gz`，保留原RED、全部maps/原始日志、独立审核、root核验、租约及before/after/delta。tar内member-manifest.json排除自身，外部manifest按path/bytes/SHA逐成员重开核实。最终source aggregate：`2cb7eb9ae37f7764e146c11dac493e69dde0be5b90b29a1cf1ace007de97d8b9`。
