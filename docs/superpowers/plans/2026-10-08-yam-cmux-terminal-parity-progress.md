# YAM 终端对齐：2026-10-08 执行记录

2026-10-09：[B01d 项目颜色与内置图标](2026-10-09-yam-cmux-b01d.md)源码与独立审核通过：main 已保存项目的唯一 Edit project… 入口同时编辑名称、六种固定颜色与 folder/terminal/play 三种内置图标；保旧改名、只读目录与200 Unicode字符限制。Default删除own字段，Reset仅改草稿；视觉字段陈旧拒绝保存，Pin/重排保最新metadata，Add-await保外观且使用显式新名称，secondary零echo。49定向/1312全前端/build/diff精确184绑定，独立49与3actual probe分组。不是任意emoji/图片/图标、完整B01或GUI/ReactDOM验收；未跑Rust/cov/Suite，updater暂停。

> **范围修订（2026-10-09，用户确认）**：本轮目标收敛为“舒适、易用地使用 AI Agent”。cmux 全功能对标和原 A–F 清单不再是当前待办或完成门槛。后续只收口项目内启动 Agent、并行会话管理、可信状态/通知、会话恢复、可靠终端交互和精确停止六条核心流程。tmux/Zellij 互操作、Mosh/远程转发、可配置 Dock、移动端、Cloud、企业策略、浏览器自动化和通用插件列为本轮排除项。历史切片记录保留作追溯，不代表全项目完成。


2026-10-09：[B01c 项目置顶](2026-10-09-yam-cmux-b01c.md)源码与独立审核通过：main 已保存项目可 Pin／Unpin，旧记录 absent pinned 视为 false；稳定置顶组在前，Pin 加入组末，Unpin 不记旧位，↑/↓ 仅同组相邻移动。先写后生效，失败保原数据，Add-await 保最新 metadata 与显式新名称，改名保标记，secondary 刷新零 echo。65定向/1305全前端/build/diff精确184绑定，独立65与3actual probe分组；未跑Rust/cov/GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[A02c2 v5 布局成员外观恢复](2026-10-09-yam-cmux-a02c2.md)源码与独立审核通过：仅已核实当前owner的新renderer恢复成员字体/字号/symbolic theme，cached保实际外观，pending注释保留；旧v1–v4形状及成功恢复autosave保持，App保存v5≤16成员/core4KiB/full32KiB。现有Apply/zoom/secondary触发own布局保存，失败raw保留/current外观不假回滚；无效整体拒绝沿既有gate。350定向/1296全前端/build/diff精确184绑定，独立350与2probe分组；未跑Rust/cov/GUI/ReactDOM/fullA02/Suite，updater暂停。

2026-10-09：[A02c2a 无效布局原始数据保留](2026-10-09-yam-cmux-a02c2a.md)源码与独立审核通过：损坏/读取失败警告后保原raw，自动保存与外观Apply不覆盖；无效布局Retry不可用，显式新建终端沿原路径解除保留。正常有效恢复/owner失败Retry/global16不变；实际覆盖RED→一行既有gate修复，optional appearance fixture 六ReferenceError历史保留。266定向/1280全前端/build/diff精确184绑定，独立266与2callback分组；未跑Rust/cov/GUI/ReactDOM/v5/fullA02/Suite，updater暂停。

2026-10-09：[B01b 项目上移／下移](2026-10-09-yam-cmux-b01b.md)源码与独立审核通过：main 侧栏已保存唯一目录项目 ↑/↓ 相邻移动，边界禁用，derived/secondary 无入口；保目录/名称/当前项目/折叠/会话/进程，最新集合先写后生效，Add-await 保重排，secondary 零 echo。68定向/1274全前端/build/diff精确184绑定，独立68与3callback分组；UI语义RED、missing helper scaffold和夹具失败分列。未跑Rust/cov/GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[B01a 项目直接改名](2026-10-09-yam-cmux-b01a.md)源码与独立审核通过：main 侧栏手动项目 Rename project…，只读目录、1–200 Unicode code point 显示名；保目录/顺序/折叠/当前项目/进程，derived-only 与 secondary 无入口。先写后生效，Add 异步验证后保最新集合；57定向/1263全前端/build/diff精确184绑定，独立57及3callback分组。真实入口/写失败RED与夹具失败分列；未重跑Rust/cov、无GUI/ReactDOM/fullB01/Suite，updater暂停。

2026-10-09：[A11 R9 current-at-run隔离实测](2026-10-09-yam-cmux-a11-r9.md)一次300/300，提交→parser P95 25.780542ms、3693844bytes exact drain；high630441.974B/s（nominal60.1236%）、4932.079ms stall，非1MiB达标。echo STOP ACK/flood server-rejected未知原因原stop_failed保留，shutdown在parser signal后ACK，fallback=true/graceful=false；root四PID None/私有namespace移除。513product/183selected及独立F7/bundle/gate审核通过，保留唯一R9app但无GUI/no-hang/cmux/fullA11/Suite结论。empty[] plist历史澄清与失败断言保留；本次docs更新使旧current-source gate过期，updater暂停。

2026-10-09：[B04b Clear入口](2026-10-09-yam-cmux-b04b.md)源码/独立审核闭环：palette及第九可编辑快捷键，fresh mac Command+K/其他Ctrl+Shift+L；旧8/4与损坏/读取失败保持Clear=null，Save先写后生效。焦点/完整守卫先于键盘拦截；面板关闭提交后consume-first effect按身份/版本执行一次，closed forged/新modal/stale为0RPC，Reopen第五参数保留。79target/1247full/build/diff精确183绑定，独立58+21及5App分组不重复加总；无Rust/cov/GUI/IME/ReactDOM/fullB04/Suite，updater暂停。R9新隔离包仅计划。

2026-10-09：[B05c 重新打开隐藏标签](2026-10-09-yam-cmux-b05c.md)源码/独立审核闭环：工具栏与palette、最后空tab仍可达；每window一个memory-only cached记录，同renderer原pane/当前focused fallback，零输入/历史重放/进程启动/控制权获取。live→ended失效，已ended同cached可readonly；不是关闭进程或持久undo/fullB05。166target/1236full/build/diff精确182绑定，独立166+5App分组不加总；无Rust/cov/GUI/ReactDOM/TUI/Suite，updater暂停。当时下一Clear入口仅候选（现B04b已源码交付）。

2026-10-09：[权威 Clear terminal display](2026-10-09-yam-terminal-authoritative-clear.md)源码/独立审核闭环：运行中 normal buffer 保留当前行，旧显示不被权威scene恢复，日志不删除/零输入/不重启；普通、Agent、command、SSH均适用，saved/alternate/old-cap不可用。pending手动意图0viewport RPC，完成后正常poll刷新；公开clear+bottom/marker ring。fresh1225full/build精确181绑定闭合旧pretrim证据缺口，fmt/clippy/diff通过；无fullRust/cov/GUI/ReactDOM/真实owner/fullparity/Suite，updater暂停。NEXT B05仅计划。

2026-10-09：[A08d 独立终端行高](2026-10-09-yam-cmux-a08d.md)源码与独立审核闭环：默认1.35，1–2最多两位小数，独立输入/预设/Save，当前及未来视图共享全局设置，不改变Profile或移动schema。同值Save仅重试仍有效的未完成fit，P2真实RED已闭环；52定向/1213全前端/build/diff通过，独立52+三个App分组及原探针通过（不加总唯一数）。本片未重跑coverage/Rust；AST非GUI，full A08/native/Suite待验，updater暂停。


2026-10-09：[Native window identity前提](2026-10-09-yam-cmux-native-window-identity.md)源码/独立审核闭环：26个可信叶/父身份守卫保留epoch/claim/Unknown，父窗口激活与叶URL/eval查找区分；浏览器仍独立窗口，非同pane/full C01。现有SDK生产unstable必要补充、536包/lock/cap不变。640Rust/3既有ignored按仅Cargo变更的精确投影保留，最终normal check/link/fmt/clippy/diff及7JS通过；独立4identity/33window/10browser/7JS分组不加总。nativeGUI/Suite待验、updater暂停。

2026-10-09：[A07c3 上报提示符位置导航](2026-10-09-yam-cmux-a07c3.md)源码/独立审核闭环：普通运行中本地终端 More actions→Previous/Next reported prompt，仅滚动有界100位置、不发送输入、不循环，不保证精确PS1；上报状态仍不可信。两项parser失败/替换导航残留P2真实RED→GREEN并独立关闭。r2 1193full/11UI/build/diff；Rust字节未变，native5/fmt/clippy与独立r1 84front+5native按投影保留，r2 11UI+两个原probe分组；无新coverage/fullRust、GUI/ReactDOM/fullA07/Suite验收，updater暂停。

2026-10-09：[A07c2 可选Zsh命令状态报告](2026-10-09-yam-cmux-a07c2.md)已源码/独立审核闭环：独立默认OFF、未来普通Unix Zsh/Profile，单包装四模式自动A/C/D与0–255退出码；不修改RC、不重注入现会话、cwd偏好独立。状态是不可信Shell报告而非进程/Agent完成证明，P2帮助说明遗漏已实际RED→GREEN闭环。r1 final1179/build/diff；coverage历史r0 99.73/93.76/96.33未重跑。独立r0 109前端/8native/14cwd，r1 18UI+1外部组件probe分组保留；native GUI/owner、Ctrl-C/jobcontrol、完整A07/Suite待验；当时提示符跳转尚未实现（后续A07c3已交付），updater暂停。

2026-10-09：[A07c1 Shell-reported状态接收](2026-10-09-yam-cmux-a07c1.md)有限源码与测试审核通过：普通本地终端显示有界当前phase/last exit，缺标记显示Not reported，非可信进程/Agent真值。当时自动Zsh发射器尚未实现（后续A07c2已交付）、当时提示符跳转尚未实现（后续A07c3已交付）；1152 full/cov/build/native2+cwd6与独立66项前端、2项native receiver及1个外部actualApp synthetic probe通过，GUI/fullA07/Suite未验，updater暂停。

2026-10-09：[A11 r8隔离实测](2026-10-09-yam-cmux-a11-r8.md)300/300，提交→parser P95 26.165334ms，3689748bytes exact drain；两次STOP ACK，最终direct wait/PID None/cleanup complete。fallback=true、graceful=false；高档629626.241B/s（nominal的60.0458%），非1MiB达标/GUI/cmux/fullA11或跨源码性能提升。构建current-at-run，文档更新后旧receipt/gate不改；r7历史拒绝不追认根因，updater暂停。

2026-10-09：[Unix process-tree lookup](2026-10-09-yam-terminal-stop-ps.md)移除PATH依赖，固定系统ps缺失明确失败。真实无PATH RED→GREEN、两隔离子probe、选择器边界与7项既有生命周期测试及独立审核通过；Windows/身份/恢复流程保持。未证明r7 stop拒绝原因，原结果保留；fresh packaged r8、GUI/Suite仍待，updater暂停。

2026-10-09：[A11 r7隔离实测](2026-10-09-yam-cmux-a11-r7.md)：300/300，提交→parser P95 30.454875ms，非UI延迟；3408148bytes exact drain。高档仅577438B/s（offered的55.07%）。两次stop拒绝后fallback清理完成、direct wait/四PID absence成立，graceful=false，拒绝原因未证实。无完整A11/cmux/原生GUI结论；本次文档更新使旧构建后续current-source gate过期，updater暂停。

2026-10-09：[A11有限owner响应实跑](2026-10-09-yam-cmux-a11-fixture.md)r6 exit0：300/300，submission→parser P95 30.329208ms（非ACK→parser/paint），writeRPC P95 15.197292ms，3251476bytes exact drain；cleanup wait/verified exits成立，原recoverable错误保留。高档offered1MiB/s仅达544755.82B/s、stall4.938s，不能声称达到目标吞吐或优于cmux。r0–r5失败与有限fixture修复证据保留，最终134 helper/独立sol通过；nativeGUI/ReactDOM/cmux/RSS/full A11/Suite仍待验，updater暂停。

2026-10-09：[C01a独立浏览器窗口](2026-10-09-yam-cmux-c01a.md)源码/测试与独立sol spec/quality PASS：main More actions提供URL与Show/Reload/Close控制，固定单独窗口，非同pane/full C01。6生产+3tests，151源码/安全配置绑定；60target/1073front、599Rust+2原ignored/10target，coverage99.72/93.57/96.20及build/fmt/clippy/diff通过，独立60+10。前端full/target仅124文件frontend/security精确投影绑定，不冒旧whole-map相同。native iframe/plugin/render/ReactDOM/跨平台/no-orphan/Suite仍未验；旧debug138不含，updater暂停。

作者：Jeff.Liu。

## 当前状态

2026-10-09：[D03b IPv6字面地址](2026-10-09-yam-cmux-d03b.md)有限源码/测试与独立审核通过。UI bare/一对[]输入，typed bare保原拼写、title[]不入argv；zone/CIDR/URI/bracket:port拒绝，原SSH配置/Unknown隔离/global retention保留。1138 full、51前端/20Rust定向及独立33离线语法对照通过；无新coverage/fullRust或真实SSH/network/GUI/downgrade/fullD03/Suite验收，updater暂停。

2026-10-09：[A11b1有界fixture诊断](2026-10-09-yam-cmux-a11b1.md)源码/测试及独立审核通过，128 Python tests；最多三清理RPC诊断与三档数据/marker分离，保留原预算/安全清理/性能定义。假进程探针不代表实际负载；r6历史不变，旧artifact非current，未来须fresh binding。无新性能/产品根因结论，GUI/fullA11/Suite待验、updater暂停。

2026-10-09：[A09a单文件拖放路径确认](2026-10-09-yam-cmux-a09a.md)源码/测试与独立审核通过。单个普通本地文件（含图片文件）确认后向原活动终端插入完整引用路径，一次 paste、不附 Enter、不读取或上传内容。1126 full、独立154及公开SDK接线探针通过，部分订阅泄漏P2已关闭；coverage绑定r0。真实Finder/file RPC/ReactDOM/GUI/fullA09/Suite待验，旧debug未含、updater暂停。

2026-10-09：[D03a显式SSH连接](2026-10-09-yam-cmux-d03a.md)有限源码/测试及独立spec/quality通过。main More→Connect SSH，mac固定系统SSH与原生配置；typed历史→显式Reconnect捕获当前全局设置。Unknown同窗口暂停新启动、查看现会话，无可信自动解除；成功reply保留SSH元数据。两独立P2真实RED闭环，1084front/616Rust+2原ignored、独立140+17+返回probe；原失败与maps保留。实际SSH/GUI/ReactDOM/host/IPv6/CLI扩展/fullD03/Suite仍open，旧debug未含，updater暂停。

2026-10-09最新补充：[A07b2默认Zsh可选目录报告](2026-10-09-yam-cmux-a07b2.md) 源码及独立sol spec/quality PASS无finding：默认OFF，未来ordinary/Profile的Current/System default可请求，owner实际raw argv0绝对basename zsh才注入，最终SHELL不影响判断；unsupported默认原builder一次/0assets/warning。legacy[-l]与System[-i/login]不变，Save不改现会话、click snapshot保留行数共存。4生产+4实际tests/8owned、145source，53target/1062full、coverage99.72/93.51/96.12/build；18target/589serialRust+2原ignored/fmt/clippy/diff，独立57+18通过，所有finalcheck实际前后maps精确绑定。私有portablePTY legacy-l baseline/integrated验证首提示/RC顺序/status/pipestatus；/tmp↔/private/tmp首失败为fixture期望，业务前GREEN如实，不冒新请求RED。lib/background业务prefix及脚本不变；nativeGUI/owner/ReactDOM/defaultShell安装选择/完整A07/Suite仍未验，旧debug138不含本片，updater暂停。

2026-10-09有限可靠性补充：[shared shortcut未知方向键边界](2026-10-09-yam-cmux-shortcut-boundary.md) 修复旧direction literal继承属性：仅四Arrow显式比较，两平台三prototype×resolver/App共12独立RED→GREEN；根诊断原只toString，RED App先throw未执行后续传播断言如实。1生产+2tests/145source，101target/1052full、coverage99.72/93.50/96.12/build/diff，Rust25未变未重跑；独立sol spec/quality PASS、82+1通过，finding关闭。原A05a2/retention回执不改写，native/ReactDOM/物理键/OS/TUI/Suite未验，旧debug138不含、updater暂停。

2026-10-09最新补充：[A05a3未来普通终端保留行数](2026-10-09-yam-cmux-a05a3.md) 源码与独立sol spec/quality PASS无finding：200–2000整数/default2000，独立write-first Save只影响之后ordinary/Profile启动，0当前view变更；恢复/cache/move以recorded full frame容量为准，legacy缺字段2000，default create省略兼容旧strict端点，非默认拒绝不重试/重启。9生产（含GUIwrapper必要forward）+12测试/21owned、145source，321target/1038full、coverage99.72/93.54/96.12/build/diff；Rust7target/585serial+2原ignored/fmt/clippy。实际bundle33请求，独立93front+7Rust+bundle33通过，原短overlap及fresh串行纠正回执保留。每finalcheck前后map精确绑定，49fixture/scaffold/真实RED与后补回归分列。native/ReactDOM/fullA05/memory/OS/Suite未验，updater暂停，旧debug138不含本片。

2026-10-09最新补充：[A05a2固定键盘滚动](2026-10-09-yam-cmux-a05a2.md) r1源码/独立sol spec/quality PASS：mac Command、其他Ctrl+Shift的PageUp/PageDown/End，focused/current/normal/mouse-none与Find/selection/modal/IME/moving守卫；先consume再publicpage一次，onScroll单RPC、live bottom:true权威路径。2生产+2测试/4owned、142source，55target/1019full、coverage99.72/93.45/96.08/build/diff；Rust25未变未重跑。独立91+12+1通过，r0原型键P2以12 actual RED→GREEN关闭，首独立probe仅toString如实保留。nativeDOM/TUI/OS/fullA05/Suite未验；排除键保底库Shift-page行为，不称零滚动/PTY；旧debug138不含新片，updater暂停。

2026-10-09最新补充：[A05a1固定缓冲区对齐](2026-10-09-yam-cmux-a05a1.md) 源码及独立sol spec/quality PASS无finding：实际factory/browserTerminal/applyFrame复现默认1000与owner2000失配，新view显式2000并复用frame上限，1100/1999/2120实际RED→GREEN；不迁移live、不改owner/global16预算。2生产+7测试/9owned、141source、50target/168bindings/998full、coverage99.72/93.41/96.08/build/diff；独立95+151通过，Rustprefix25字节不变未重跑。fixture52失败与最初allowProposedApi错误保留。DOM/open/Fitstub/ASCII非fullcells/native/memorybench/Suite；键盘未实现、旧debug包不含本片，updater暂停。

2026-10-09最新补充：[B05b同GUI两窗口标签移动](2026-10-09-yam-cmux-b05b.md) 源码及独立sol spec/quality PASS无finding：main↔secondary原session显式移动，暂停源view→真实dispose→token ACK→目标ready complete；pending Check/Continue/Open显式恢复，未知保隔离，旧generation/旧completed token失效，全程一个global16预算，不spawn/restart。4生产+6测试/10owned、140source、227target/993full、coverage99.72/93.41/96.08/build；Rust11target/578serial+2原ignored/fmt/clippy/diff。独立34+193front/2actualprobes/11Rust通过，最终Rust-only变动以前端精确投影绑定原maps，旧577证据保留。native/ReactDOM/PID/CrossGUI/Suite仍gap；不是镜像/drag/fullB05，旧138-source debug包不含B05b，updater暂停。外部逐成员归档保全部RED/原始回执。

2026-10-09当前验收包构建记录：隔离 debug `YAM Terminal Parity Validation 20261009.app` 构建 exit0，identifier `com.yam.terminal-parity-validation-20261009`，无URL schemes；6个包文件合计218371121 bytes，138源码哈希与A08c冻结完全相同，包含B05两窗口、A04b2 Finder preview/reveal、A08b System配色和A08c默认光标。此包使用developer notices，不是release；未安装、启动GUI/owner/Shell/Finder，native **NOT RUN**。构建成功不等于Suite或cmux同机验证，既有原生/ReactDOM缺口保持。元数据、日志、源码哈希归档于 `/Users/liuwenyuan/.local/share/yam/development-archives/20261009-cmux-terminal-current-package/`，不复制218MB bundle或用户数据。

2026-10-09最新补充：[A08c默认光标](2026-10-09-yam-cmux-a08c.md) 源码与独立sol spec/quality PASS无finding：独立Save选择block/underline/bar与blink，legacy默认block/true，raw保留、write-first，main一次publish/secondary零echo，Profile schema不变，程序可覆默认；不fit/resize/PTY/焦点。3生产+8测试/11owned，94target/127fixtures/980full，coverage99.71/93.85/96.24/build/diff；Rustprefix25字节不变未重跑。独立66+2actualfacade probes/138source/183证据匹配。49fixture及hasOwn编译失败保留，r1全量绑定与作者最终字节声明如实；native/ReactDOM/DECSCUSRvisual/inactive/fullA08/Suite待验，updater暂停。

2026-10-09最新补充：[A08b System终端配色](2026-10-09-yam-cmux-a08b.md) 源码与独立sol spec/quality PASS无finding：global/Profile保存symbolic system，三字段/Profilev3不变、defaultdark，每window本地解析，仅当前自身system view palette跟随，不fit/resize/write/广播/焦点；font-ready fit保留且不恢复旧palette。4生产+8测试/12owned、120target/967full、coverage99.56/93.75/95.78/build/diff；Rust24.rs及prefix25files不变，本片未重跑。独立120+2actual App probes/135hash/182证据匹配；49fixturefail绑定修正保全部断言，安装后latestmatches实际RED→GREEN，后补回归如实。nativeOS/ReactDOM/Suite/chrome/cursor/完整A08未验，updater暂停。

2026-10-09最新补充：[A04b2 macOS选中文件Finder显示](2026-10-09-yam-cmux-a04b2.md) 源码与独立sol spec/quality PASS无finding：More actions → Show selected file in Finder…，精确绝对选区→原始/canonical本机路径预览→显式确认，再核实regular与native epoch。每fixedslot一个真实worker，取消不提前释放；零内容read/PTY/write/default执行。7生产+3测试/10owned，952front、Rust8target/567serial+2原ignored、coverage99.56/93.65/95.77/build/fmt/clippy/diff通过；Rustfull绑定仅test初始化修正前字节，业务相同，finaltarget/clippy现字节。独立front30+HTTP/paste29+Rust8与2actual App probes通过，135source/186证据匹配。nativeFinder/ReactDOM/window、OS/Suite、真实非UTF8filesystem fixture EILSEQ及完整TOCTOU仍uncovered；不称完整A04/editor/OSC8，自动更新暂停。

2026-10-09最新补充：[B05a 固定两窗口](2026-10-08-yam-cmux-b05a.md) 源码与独立sol spec/quality二审通过：main+terminal-secondary、独立新建/原窗口聚焦、global16 views/pending/draining、main唯一设置/通知与main隐藏/显式Quit原样；保存双namespace恢复不spawn，owner读取失败保raw，显式Retry成功再解除gate。writer941前端/256定向、coverage99.56/93.69/95.76/build，Rust12定向/559串行+2原ignored、fmt/clippy；独立首轮360front+12Rust，r1独立220及两项各1probe。恢复raw覆写finding已关闭，130source/32owned/75raw/10checks/root哈希匹配，355成员归档逐字节验证。Retry按钮缺失RED与实现后细回调验证诚实分列；native/ReactDOM/cross-GUI共有恢复屏障、B05b移动源码见新回执，镜像、原生与完整B05未验，自动更新暂停。

2026-10-09跨日补充：[A07b1 默认OFF可选Zsh emitter](2026-10-08-yam-cmux-a07b1.md) 源码/独立spec与quality通过：7生产+3前端测试+1Rust fixture binding-only，前端85定向/912全量、coverage99.70/94.08/96.82/build，Rust14定向/547串行与2原有ignored/fmt/clippy/diff；独立85+14及真实first-prompt/pipeline probe通过。仅Unix明确program为zsh的新普通/Profile终端，独立write-first偏好、Profile环境覆盖后raw ZDOTDIR捕获、私有顶层trampoline/追加precmd、缓存一次与单spawn fallback。empty不注入保原builder固定warning；非Unicode命名RC、host system RC任意等价、崩溃残留、native owner/GUI/ReactDOM/跨平台及完整A07/B05待验。127指纹/11owned/40raw/9回执匹配，220成员逐一归档，自动更新暂停。

A07a DirectoryValidation隔离debug包build0、独立ID/无URLs/122旧源码匹配；root及review实际packaged parser各6checks/14requests通过，21成员归档SHA `71bc6dcf00d851de5cae5ee5fbf5abea3988bb0d7afef60a40afaee6a6800ca3`。不含A07b1，不能代替owner/GUI/Shell验收；旧root adapter未知PID清理仍uncovered，详见A07b1收据。

最新补充：[A07a OSC7目录报告接收](2026-10-08-yam-cmux-a07a.md) 源码与独立spec/quality通过：5生产+8测试/13owned，前端83定向/897全量、Rust6定向/533串行及2原有ignored，fmt/clippy/diff通过。895-era coverage99.70/94.12/96.79/build与最终前端business字节一致；后补两测试已最终验证，不冒称coverage897。独立294前端+6Rust及actual watermark probe通过，122源码/23raw/9checks匹配，207成员逐一归档。可选坏metadata不损frame、live serde/proxy保报告、历史outer+raw剥离、运行期纯文本label；不自动cd/hooks、不中断/重跑owner、不赋予reported cwd信任权威。packaged parser有限证明见跨日补充；真实owner/GUI/ReactDOM/Windows、默认并行Rust及完整A07仍待验。

最新补充：[A04b1 可见HTTP(S)链接](2026-10-08-yam-cmux-a04b1.md) 3生产+4测试、writer定向124/全量885/coverage99.70/94.07/96.79/build/diff及独立spec/quality通过；独立94项与ended/readOnly、旧token、listeners probe通过。精确Cmd/Ctrl主键、4px抖动/选择与TUI守卫、绑定当前view/cell signature、窄main HTTP(S) opener；121文件含capability/18raw匹配，168成员逐一归档。当前包原生、OSC8关联/priority shadow、文件路径/editor与完整A04仍未覆盖。

控制器新LinksValidation隔离debug包已构建exit0，ID `com.yam.terminal-links-validation-20261008`、无deep link、121源码/capability指纹一致；外部回执 `/tmp/yam-terminal-links-validation-20261008/receipt.json`。未安装/启动，GUI/native未运行；原B04 TerminalValidation包仍独立保留，不把打包成功记为原生PASS。

最新补充：[B04a 八项应用快捷键](2026-10-08-yam-cmux-b04a.md) 源码/865项完整前端/coverage/build及独立spec/quality通过；writer定向108，独立138项及160个actual handler矩阵probe通过。统一逻辑键注册表、精确平台修饰、null禁用、draft原子Save与缺新key才内存迁移；4生产+9测试/117源码与16回执hash匹配，81成员归档逐字节核实。原生WebView/xterm/键盘布局/IME/AltGr/OS及Windows/Linux仍未覆盖，不称完整B04或OS全局快捷键；自动更新暂停。

控制器另已成功构建包含当前B04a/粘贴/Profile/布局的隔离TerminalValidation包（唯一bundle ID、无deep link），117源码仍与冻结一致；这是打包证明，尚未运行当前包原生验收，不包含后续A04b链接片。构建回执保留在 `/tmp/yam-terminal-current-validation-20261008/receipt.json`。

最新补充：[A04a 粘贴预览](2026-10-08-yam-cmux-a04a.md) 源码/849项完整前端/coverage/build与独立spec/quality通过；独立262项及17项补充fixture probe通过。原生textarea事件、单pending、128 KiB预算、完整原串确认与失效零发送沿普通onData/claim语义；113文件/11owned及14原始日志hash匹配并逐成员归档。真实ReactDOM/当前包剪贴板/IME/TUI、GUI焦点、owner/PTY及Windows/Linux仍未覆盖，不称完整A04。后续窗口事项另片，自动更新暂停。

最新补充：[A02c1 Profile初始外观](2026-10-08-yam-cmux-a02c1.md) 源码/827项完整前端/coverage/build与独立spec/quality通过。字体字号主题在点击时取新view快照，字号按each有效大小变化且保family/theme，存储失败零改变，旧字体回调不覆晚创建view。独立124及补充probe、109文件hash匹配。运行期缓存/重连保持，冷恢复fallback global已明确；可信项目Profile/显示恢复/完整A08尚待，真实ReactDOM/原生仍未覆盖，继续高频输入粘贴及窗口主线。

最新补充：[A02b 个人Profile环境引用](2026-10-08-yam-cmux-a02b.md) 源码与独立spec/quality通过；前端817、Rust正式串行527/2原有忽略、coverage/build/fmt/clippy通过。引用名称存储、owner临时解析、幂等首次dispatch、固定失败reason及平台目标保护已交付；独立Rust12/前端57/A01影响面17/T09 entry3与补充probe通过。整套Rust默认并行存在既有全局计数/CLI fixture失败，保留未覆盖；当前包原生/真实ReactDOM仍待验。继续A02c1初始外观，不称完整A02或整个cmux对齐。

最新补充：[A02a 命名普通终端 Profile](2026-10-08-yam-cmux-a02a.md) 源码、804项完整前端回归、coverage/build及独立 gpt-6.1-sol spec/quality闭环。支持名字、Shell/login、context/home/explicit目录、CRUD/default/selected启动；损坏数据保留并提供显式无Profile恢复，foreign-platform显式目录启动零执行。独立58项、旧Agent模板18及补充安全/原子性探针通过，8文件hash无漂移；原生/真实ReactDOM仍未覆盖。继续个人Profile环境引用与外观，不称完整A02/S1或cmux已全部对齐。

最新补充：[A01b 普通 Shell 与登录模式](2026-10-08-yam-cmux-a01b.md) 源码、完整回归及独立spec/quality闭环。Unix首批Bash/Zsh/Fish显式interactive/login，Windows cmd.exe `/D`且无Unixlogin控件；未改偏好保持legacy omit，独立保存仅影响之后普通新建。前端最终772项，Rust515通过/2原有忽略，独立Rust9/前端42及13项实际App失败回调探针通过；root补查的原型同名错误映射问题已真实RED后修复。原生/真实ReactDOM/跨平台待验；继续A02a命名Profile，不称完整A01/S1。

最新补充：[A01a 普通终端默认 home](2026-10-08-yam-cmux-a01a.md) 源码及独立spec/quality通过。普通缺省目录由 owner 解析现有 Tauri home，非法 home 在分配前拒绝；项目/Agent/resume/worktree 规则保持。Rust 完整506通过/2原有忽略，前端755项与构建/Clippy通过；独立8+20+52项回归通过，测试并发的目录碰撞与全局资源隔离问题均真实RED后修复，最终独立默认并行8项通过、生产和断言不变。原生/真实ReactDOM未覆盖，继续普通Shell/login及Profile，不能称完整A01/S1已对齐。

布局组合审核：B02b/B03a/B03b/B02c/B02d 当前源码的有限集成复核通过。独立 gpt-6.1-sol 验证370项影响面测试、4403个模型/迁移组合状态、8项实际App跨切片回调探针；82个源码/测试文件审前审后与冻结一致，无 finding。指纹 `84fec2561bddf49566f1f44c2be6bf9c7543a82fe40b54f355f4206650cbbaf1`。完整755项、coverage和build来自当前冻结writer日志，未称独立整套重跑。真实ReactDOM/原生GUI/正式Suite coverage仍未覆盖，不能称整个S2完成。

38个集成证据文件已逐成员核实并归档 `/Users/liuwenyuan/.local/share/yam/development-archives/20261008-cmux-layout-integration/evidence.tar.gz`，SHA-256 `b12f3c969b1ec3a43d14e19fcb54940bd4cdd543ca43da381eb1736ca18c622a`。基线沿用已归档B02b前像；原始日志和JSON不进Git。

最新补充：[B02d 四边缘原子拆分移出](2026-10-08-yam-cmux-b02d.md) 源码、755项完整测试、构建、独立spec/quality通过；219项影响面、2423模型/几何检查、4项延迟挂载守卫及7文件哈希复核通过。接着本轮布局切片间有限集成复核，再推进home/Shell/Profile。CUA本次明确Mac锁定，已请求手动解锁，独立源码工作继续；真实ReactDOM/原生未覆盖，跨窗口、多窗口和其他S2项仍未实现，不能称整个B02/S2完成。

最新补充：[B02c 标签拖拽](2026-10-08-yam-cmux-b02c.md) 同面板排序/跨现有面板拖动及键盘替代菜单源码交付，706项完整测试、构建、独立spec/quality通过；145项影响面及7项补充probe、81文件哈希复核通过。继续B02d四边缘原子拆分移出；真实ReactDOM/原生仍未覆盖，整体B02/S2未改为完成。

最新补充：[B03b 方向焦点与最大化/还原](2026-10-08-yam-cmux-b03b.md) 源码交付，684项完整测试、构建、独立gpt-6.1-sol spec/quality通过。保持完整挂载树/标签/视图，统一可见性与旧resize回调隔离；独立331项影响面和两组各1200次几何检查通过。真实ReactDOM/原生仍未覆盖；接着B02c标签拖动排序/跨现有面板，再B02d边缘拆分。

最新补充：[B03a 嵌套节点 resize](2026-10-08-yam-cmux-b03a.md) 每个 split 的拖动、键盘调整和重置源码交付；669项完整测试、构建与独立 gpt-6.1-sol spec/quality复核通过。审核发现的Escape焦点路由与22%浮点边界问题均补失败回归后关闭。真实ReactDOM/原生仍未覆盖；继续B03b方向焦点/最大化，再补标签拖拽。

最新补充：[B02b 面板多标签与跨面板移动](2026-10-08-yam-cmux-b02b.md) 源码、641项完整测试与独立 gpt-6.1-sol 审核通过。关闭/删除标签后的画面协调、空面板缩减预设后的活动项两个 finding 已修复复核；v4恢复核实包括隐藏标签，保留16视图预算。真实 React DOM/原生仍未覆盖；标签拖拽、B03节点resize/方向焦点/最大化尚未完成。继续下一源码切片，不再因原生工具不可用停住整段实现。

最新补充：[B02a 嵌套分屏](2026-10-08-yam-cmux-b02a.md) 已交付稳定面板身份、局部分屏、v1/v2→v3 布局迁移与快捷键；612项完整测试和覆盖率测试、构建通过。独立 gpt-6.1-sol 审核发现的 Ctrl+D EOF 截获已按 TDD 修复，复核281项影响面及27项 handler probe 通过，冻结12文件哈希匹配。真实 React DOM 与原生验收未覆盖，面板多标签、嵌套节点 resize 和方向焦点尚未实现；不能把 B02/S2 改为完成。

此前补充：[终端界面五项修复](2026-10-08-yam-terminal-ui-fixes.md) 已完成源码实现、595项前端测试、独立145项影响面审核与隔离 debug app 构建。查找高亮／重开恢复、字体字号预设和输入、展开图标、当前终端 Find 入口及 More actions 菜单已交付源码；CUA 仍不可用，原生 GUI 验收未覆盖，不能将下述原生待验项改为完成。

用户已授权按 [方案](2026-10-04-yam-cmux-terminal-parity-proposal.md) 分切片实施，实施与独立审核均使用 gpt-6.1-sol。自动更新暂停；新增的官方 `@xterm/addon-search` 0.16.0 已单独获批，未提交或发布本轮变更。

2026-10-08 15:12 的续做状态：Mac 已解锁，原生验收已推进。以下早期测试数字保留为对应切片的证据，不代表最新整体验收结论。

| 续做项目 | 已证实结果 | 未闭环部分 |
|---|---|---|
| A08 字号快捷操作 | Cmd/Ctrl 放大、缩小、重置和命令面板源码交付；独立审核通过，前端 545/545。原生 Cmd+= 设置显示14，Cmd+- 显示13，放大后 Cmd+0 重置到13 | 命令面板、跨平台及原生 resize 仍需验证 |
| A06 当前终端查找 | 大小写、Worker 正则、匹配导航、Unicode 映射、输出/选择生命周期源码交付；三项审核 finding 经 TDD 修复，二次独立审核通过；前端570/570 | 原生发现高耗时正则持续显示 Searching。额外根因修复见下一行；原生高亮、导航和修复后超时尚未判定通过 |
| 原生反馈循环根因修复 | Find 重绘让 pane inline ref 解绑/重绑，继而 fit→owner resize/frame→搜索重启→重绘。实际连续重绘测试先 RED（50次挂载回调，预期2次），稳定 indexed ref 后60项定向通过；独立审核161项影响面测试、1项实际组件 lifecycle fixture通过；四文件冻结哈希匹配；修复后 debug app 离线构建成功 | 首轮前端571/572：普通替换 Worker 在并行负载下超过100ms，保留失败。未改源码的复跑及 coverage均572通过，未放宽deadline。原生连接中断，修复后的超时/导航/回看复验未覆盖 |
| A06 原生局部验证 | 隔离 identifier `com.yam.find-validation-20261008` 的 debug app 构建成功；Cmd+F、普通匹配、大小写开关、普通正则、非法正则错误、Escape 恢复输入焦点有效 | 局部结果不能替代整项完成；超时、动态输出、选择及导航需在修复后重验 |
| 依赖与许可证打包 | 官方 search 依赖精确锁版本；完整 collector 逐字重现独立批准的548项候选；55项 notices/runtime、23项相关测试通过；独立审核通过；实际 developer runtime 构建成功 | 库存48项覆盖、500项既有缺口；release render 仍拒绝，不具备发布资格。并行缓存构建曾 SIGKILL，顺序通过，未证明其根因 |
| A05 原生回看 | 回看提示与返回实时底部入口实机可用；后台和 headless 输出保留 viewport | 偶发延迟跳底尚未关闭。只读事件捕获 projecting=false 的滚动链、期间无 onData；缺少对应 wheel/focus/resize 证据，不能归因 |

续做原始证据保留在 `/tmp/yam-cmux-continue-20261008/`，不加入 Git。覆盖率仍只覆盖 `src/*.ts`，不是 TSX/React 原生覆盖率；原生验收未完成时不声明整个 S1 完成。

续做241个证据文件已归档到 `/Users/liuwenyuan/.local/share/yam/development-archives/20261008-cmux-terminal-find-closure/evidence.tar.gz`，逐成员 SHA-256 校验通过；archive SHA-256 为 `2a43ef8efc30c648d30a03dd23f0354afc0d1bfa6aa22d306077e3765e9a6af9`。原始日志、JSON 和 archive 不进 Git，新增的依赖清单与许可证正文属于必要源码。

原生工具故障：CUA native pipe closed，之后两次 `getState` 都30秒超时并重置 kernel。未绕过工具执行 UI 自动化。两个隔离 owner 的认证 shutdown 均成功；仅向精确验收 bundle 进程发 TERM，核实剩余0个，用户其他应用及 owner 未操作。临时诊断随验收进程退出清理。

S0 已完成冻结版本的源码/文档映射，原生同机验收仍未完成。A01 的独立可验证部分先行实施，不把这一切片视为整个 S1 或 A01 全部交付。

| 项目 | 结果 | 仍需完成 |
|---|---|---|
| B05a 固定两窗口 | main+secondary独立会话/原窗口聚焦、global16、双namespace恢复、错误保raw与显式Retry；941前端/559串行Rust+2ignored及独立二审通过 | 仅source；native窗口路由/事件/close/Quit、真实ReactDOM/cross-GUI未知屏障、move/镜像与完整B05待验 |
| A07b1 可选Zsh emitter | 默认OFF、Unix显式Zsh ordinary/Profile、私有trampoline与OSC7、cached once/单spawn fallback；912前端/547串行Rust及独立85+14/真实Zsh probe | empty不注入保原启动warning；非Unicode命名RC/host system等价/崩溃残留/native/完整A07与B05待验 |
| A07a OSC7仅接收 | 纯文本不可信目录报告、owner可选字段容错、live serde保留/终态双剥离、watermark及缓存失效；897前端/533串行Rust和独立294+6审核通过 | 仅receiver；A07b1可选Zsh源码已交付且不自动cd。packaged parser有限证明通过，native owner/GUI/ReactDOM/跨平台及完整A07另片；历史coverage/build为895-era相同business源码 |
| B04a 八项应用键 | 四项既有动作+New/Palette/两种split可编辑或禁用；统一route、缺新key才迁移、draft先成功写再生效；865全量/coverage/build与独立spec/quality通过 | 真实WebView/xterm、键盘布局/IME/AltGr/OS及Windows/Linux；完整B04/任意when/keytable另片 |
| S0 能力映射 | 47 个 ID 已对照冻结 tag；标明稳定、Beta 和待核实的细项 | 实机操作、同机响应/压力基线、遗漏能力的验收范围细化 |
| A01 快速新建 | 主按钮、项目加号、空项目入口及命令面板直接创建 Shell；macOS Cmd+N，其他平台 Ctrl+N；保留高级 Agent/command 入口 | 原生验收尚不完整；登录/非登录 Shell 与 Profile 选择另行切片 |
| A01 TDD | 修改业务代码前 6 个语义失败、1 个边界通过；修改后定向 29/29、完整前端 517/517 | 不以自动化通过替代原生验收 |
| A01 独立审核 | 第二个 gpt-6.1-sol 核实五文件 SHA，规格与代码质量审核通过；独立定向测试 29/29 | Suite 规范化审核回执未生成，不能称为正式 Suite pass |
| A01 普通覆盖率 | lines 99.78%、branches 92.79%、functions 97.44%；前端构建通过 | 覆盖率命令仅包含 `src/*.ts`，不包含 `App.tsx`；实际回调/JSX 的转译测试不能证明 React 挂载与原生路由 |
| A05 回看/返回实时底部 | 按已确认 end_offset 显示 New output；当前视图有 Return to live，结束的保存画面用 Return to bottom；后台处理 bottom 意图时决定当前位置，保留普通绝对滚动 | 原生滚动/高输出/选择验收；键盘滚动和可配置保留预算另行切片 |
| A05 审核修复 | 独立审核发现 resize 与返回请求并发导致按钮一直禁用；先写测试复现成功/失败两种情况，再以独立操作 intent 修复；二次独立规格/质量审核通过，定向 75/75 | 手动选择时既有的暂停画面轮询策略仍保留，不宣称已改善 |
| A05 自动验证 | 修复后前端 531/531，覆盖率 99.78/92.90/97.45%，构建/diff/fmt 通过；Rust 串行 498 通过、2 既有忽略 | 首轮 Rust 并行 495 通过、3 个共享 SESSION_COUNTER 断言竞态失败；保留失败证据，未改断言，串行运行同套测试通过。不是并行测试全通过 |
| A08 配色 | 三套主题补齐 16 ANSI 色位和光标字色、活动/非活动选区颜色；保留原有八项颜色，不改设置格式、字号、生命周期或依赖 | 原生色板/光标/选区外观待验收；CSS 既有背景覆盖未改，不声称已完成所有外观能力 |
| A08 TDD 与审核 | 先语义 RED 5 失败，再定向 17/17；最终完整前端 537/537，覆盖率 99.78/92.91/97.45%，构建/diff 通过；独立规格/质量审核通过，定向 190/190，两文件哈希匹配 | 仍称 Solarized-inspired，不宣称既有颜色锚点等同标准 Solarized |

本轮原始测试、构建、文件哈希和执行记录位于 `/tmp/yam-cmux-20261008/`，不加入 Git。构建有既有的 bundle 大小提示；这不是响应性能验收结果。

另已将 108 个证据文件归档到 `/Users/liuwenyuan/.local/share/yam/development-archives/20261008-cmux-terminal-s1/evidence.tar.gz`，对应 manifest 逐文件校验 SHA-256 通过；官方 DMG 单独保留在临时 baseline 目录，不放入证据归档或 Git。

原生局部验收：使用独立 identifier `com.yam.a01-validation-20261008` 的 debug bundle，核实 backend history/owner 路径均由 app_data_dir 隔离。主按钮一击创建 Shell，Cmd+N 创建第二个 Shell；第一条原生输入命令已在隔离 PTY 日志中完整执行并输出 `YAM_A01_NATIVE_OK` 和 cwd `/`。现有未指定目录的后台默认是进程 cwd，不是已经实现的 home/profile 策略。

画面中的“终端代理已关闭”已追溯至用户 `.zshrc` 启动输出，与 YAM 后台关闭无关，不登记成产品故障。第二条粘贴在日志中出现重复未提交文本，之后 CUA 报告窗口变化与两次 timeout；未判定为应用缺陷或通过。完整焦点、粘贴、原生高级入口、项目入口及 Windows/Linux 键盘验收仍待补齐。验收后仅向独立 owner 发送认证 shutdown，回复成功，并核实本轮 owner/parser/两个 Shell PID 已退出。

三个切片合并后的最新原生验收包已离线构建成功：`apps/desktop/src-tauri/target/debug/bundle/macos/YAM S1 Validation 20261008.app`，identifier 为 `com.yam.s1-validation-20261008`；核实 Info.plist 与 A05/A08 的 14 个冻结文件一致。尝试启动验收时，CUA 明确返回 Mac 锁定且不能自动解锁；已请求用户手动解锁。没有绕过锁屏，合并版输入、滚动提示、配色原生验收仍待进行。

## 当前收口计划（2026-10-09 范围修订）

原方案列出的后续切片路线已停止派生新功能任务。按以下顺序收口：

1. 汇总当前源码中六条核心流程的入口、状态来源和已有测试，列出缺少的真实桌面验收项。
2. 用包含当前源码的桌面构建验收：项目启动多个 Agent、切换并行会话、状态/通知定位、旧输出回看、关闭重开恢复、单独停止目标会话。
3. 只修复会阻塞这些流程的可复现问题；每项先补回归用例，再最小修复并重验。
4. 更新简明使用说明，按“已在真实桌面验收 / 源码已交付但体验待验 / 本轮不支持”报告结果。

当前主要验收缺口：历史记录中大量切片停留在源码/自动化/独立审核闭环，当前桌面构建尚未完成整体原生验收。性能实验可以帮助定位高输出下的用户阻塞；不再单独追求 1 MiB/s 吞吐或宣称超过 cmux，除非核心工作流实际证明其必要。

## 原 cmux 基线与隔离结果（仅历史参考）


冻结 [官方 v0.64.25](https://github.com/manaflow-ai/cmux/releases/tag/v0.64.25)，tag commit：`b685a275c2e411799857155e37264daf84f7e4d6`。能力映射只使用该 tag，不用移动主分支认定稳定能力。

用户已批准下载官方 DMG 并在隔离条件下验收。官方 DMG 已下载，下载脚本和根控制器分别核实大小 `225832896` bytes 与公布 SHA-256 `0afb2f8ff9bfef10f03e61ff12e65ce02dbca5c96cb9047118e13483ac5b08ad` 一致。收据保存于 `/tmp/yam-cmux-20261008/cmux-baseline/receipt.json`，状态 verified；DMG 仅存临时目录，未安装或启动。

**官方应用尚未启动。** [初始化代码](https://github.com/manaflow-ai/cmux/blob/v0.64.25/Sources/cmuxApp.swift) 会迁移并清理配置；Foundation 的真实账户 home 决定 `~/.config/cmux/cmux.json` 和 `~/.local/state/cmux`，更改 HOME 或单独修改 bundle ID 不能完整隔离。当前未找到官方 bundle 的完整重定向开关，因此同机性能比较保持未验收；未重签、重打包、改账户或改权限。

## 47 项映射的边界

“稳定基础”仅指冻结 tag 中有文档或实现入口，不代表整行目标已实机验证。“待核实”不能等同于上游缺少此能力。

| ID | 冻结上游的可证实基础与边界 |
|---|---|
| A01 | 普通终端创建与默认目录有入口 |
| A02 | Ghostty 配置/布局参数已有；命名、项目终端 Profile 的完整产品语义待核实 |
| A03 | 原生 libghostty 输入已有；IME/TUI 协议验收待测 |
| A04 | 复制、粘贴、链接和文件路径已有；危险粘贴预览待核实 |
| A05 | scrollback 与配置已有；新输出提示、预算契约待核实 |
| A06 | 查找与上一/下一已有；大小写/正则的具体行为待核实 |
| A07 | Bash/Zsh/Fish/Nushell shell integration；完整事件矩阵待核实 |
| A08 | Ghostty 字体、主题、光标、系统外观已有 |
| A09 | 图片粘贴/拖放上传已有；终端图像协议逐项待核实 |
| A10 | 窗口与会话布局已有；DPI/睡眠原生验收待测 |
| A11 | 响应延迟、隔离与压力指标必须实测 |
| B01 | 工作区分组/颜色已有；全部图标语义待核实 |
| B02 | 原生分屏/标签已有 |
| B03 | 焦点与键盘调整尺寸已有 |
| B04 | 可编辑组合键/when 条件；任意 key table 待核实 |
| B05 | 窗口/cwd/浏览器和尽力恢复 scrollback、关闭项基础；不能称作活进程 checkpoint |
| B06 | Git/PR/cwd/端口/自定义 metadata 已有 |
| C01 | 浏览器、开发工具与导航已有 |
| C02 | 浏览器自动化 CLI 已有 |
| C03 | 导入/profile/下载/URL allowlist；默认逐工作区存储隔离待核实 |
| C04 | 文件编辑、Markdown、diff 配置/实现入口已有 |
| C05 | Dock 已有 |
| C06 | 项目命令、布局、信任基础；完整导入导出 UX 待核实 |
| D01 | 显式 local-tmux 才有持续存活；普通终端不是持久 owner |
| D02 | local-tmux CLI；Zellij 对齐待核实 |
| D03 | SSH、Mosh 与 SSH config 已有 |
| D04 | Mosh/tmux 连接已有；原生 SSH tmux control-mode 布局镜像为 Beta |
| D05 | 远程网络浏览器/scp 基础已有 |
| D06 | SSH relay 通知/控制；重连安全验收待测 |
| E01 | Agent hooks/Vault 支持矩阵已有，需逐 Adapter 对照 |
| E02 | Claude/Codex Teams 已有；通用 fan-out 待核实 |
| E03 | Feed 按 Agent 支持决策；Codex hooks 仅遥测，Codex Teams app-server 才有可操作审批 |
| E04 | 通知环、面板、声音、Feed 内联动作已有 |
| E05 | Vault 转录搜索和部分 Agent fork；通用 checkpoint 待核实 |
| E06 | cmux top 任务归因已有 |
| E07 | CLI/socket/events 已有 |
| E08 | 自动化 notify/rpc/run/webhook/rate-limit/dry-run 已有 |
| E09 | skills 与文档已有 |
| E10 | cmux 原生桌面为 macOS；Windows/Linux 桌面对齐待核实 |
| F01 | 原生菜单、语言、keep awake 基础；完整可访问性待验收 |
| F02 | 签名 DMG/发行已有；三平台发行对齐待核实 |
| F03 | 上游 Sparkle 更新；YAM 更新继续暂停 |
| F04 | iOS 属于 Beta/TestFlight |
| F05 | Cloud 属于早期访问；完整团队/账户范围待核实 |
| F06 | Computer Use/Simulator 在冻结 tag 已有文档与入口；泛视频 Surface 待核实 |
| F07 | MDM 管理策略已有 |
| F08 | Custom Sidebars 为默认开启的 Beta；通用插件契约待核实 |

冻结来源：[README](https://github.com/manaflow-ai/cmux/blob/v0.64.25/README.md)、[Agent hooks](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/agent-hooks.md)、[Feed](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/feed.md)、[Vault](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/vault.md)、[local-tmux](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/local-tmux.md)、[Automations](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/automations.md)、[Custom Sidebars](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/custom-sidebars.md)、[Computer Use](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/computer-use.md)、[Simulator](https://github.com/manaflow-ai/cmux/blob/v0.64.25/docs/simulator-pane.md)。

另发现原目录未单独列出的能力：Canvas、Beta TextBox、Agent Hibernation、渲染器回收、工作区 AI 自动命名、文件编辑器与目录搜索。先登记并归入对应阶段，不能因此宣称原目录已经完整。

2026-10-09：[STOP安全拒绝诊断](2026-10-09-yam-terminal-stop-rejection-diagnostics.md)有限工具切片通过：新 diagnostics v2 严格保留三固定枚举，仅匹配请求/完整原生字符串分类，其他 outcome 为 null；不保留原始错误。6定向 RED→GREEN、134 helper 与独立 GPT-6.1-sol 134/spec/quality PASS（不重复加总），STOP顺序/预算/身份屏障/fallback/stop_failed保持。184源码map仅exact4变化；R9 v1及未知原因不变，无新native修复/性能结论/owner/GUI/build/全前端/fullA11/Suite验收，updater暂停。

2026-10-09：[Native输出阶段诊断](2026-10-09-yam-native-output-stage-diagnostics.md)有限源码切片及独立Sol复审通过：dev/debug background owner显式1开启，普通app默认关闭，专用fixture固定设置1主动开启（无额外CLI开关）；worker记录原始读长四桶及真实锁/serial/reply/append/emit阶段，嵌套区间不相加，reply非纯parser、GUI未测。Rust定向12/Python9、library656通过+3既有忽略、helpers143及fmt/diff通过；Sol12/9与false-complete回归通过，root核对修复冻结。仅两条匿名观测，不推断身份；stderr写入时间无界、可能丢失摘要且有观测开销。无新artifact实际run、无16KiB优化，不构成R9根因/修复、native性能、完整A11/Suite结论；updater暂停。


2026-10-09（作者：Jeff.Liu）：R10 隔离后台 owner/parser 实跑在当次冻结输入上通过有限结果审核：300/300 submission→parser projection marker，P95 26.164292ms；高档实际 622097.65B/s，不是 1MiB/s 达标。两条匿名阶段诊断不映射会话、不归因性能改善；两个 STOP 请求均 ACK，但 parser signal 先于 acknowledged owner shutdown，使用 fallback，不能称 graceful shutdown。Root 实查五个 PID 与 run root absent，Sol 独立结果审核通过。持久证据包位于 `~/.local/share/yam/development-archives/20261009-terminal-r10-stages/evidence.tar.gz`，SHA-256 `b8a296eee5ca7a33ee6c5188e5ce987d3f05aef1d1f258ad725df2c6137b1a98`；35成员为34列举证据加自排除的内部manifest。该结论仅为 current-at-run；后续源码及本次文档变化使旧R10 current gate不适用于当前工作树，原始receipt/gate保持不变。未验证 GUI paint/native GUI、cmux对齐或完整A11/Suite，也未交付性能修复；updater继续暂停。

2026-10-09（作者：Jeff.Liu）：启动/停止反馈有限修复已通过独立Sol源码与47项定向审核。启动失败与unknown仅保留既有UI错误及未知结果暂停指引，不向任何已有终端写入合成提示；admission释放、启动标志、成功history/refresh与未知结果禁止再次创建保持。停止RPC始终发送调用时捕获的ID；迟到失败仅在仍mounted、detailVersion及ID均未变时显示，覆盖A→B及A→B→A，双pending不重试。未承诺同一detail中新旧错误排序或重复stop串行化。实际callback/deferred RED后定向47/47、全前端1326/1326、标准build及diff check通过；只是Node依赖替身下的真实回调验证，非ReactDOM/native GUI/PTY验收。184源码集合仅App.tsx与terminal-launch.test.mjs变化，其余182完全一致；修复后聚合SHA-256 `ef87a1fd9b30c9fa19d5229e3f7c7c439d248f440bed2ca1271c4769824b116d`。固定证据归档见 `~/.local/share/yam/development-archives/20261009-session-operation-feedback/evidence.tar.gz`；历史阶段结论和未验范围不因此升级。


2026-10-09（作者：Jeff.Liu）：B01项目侧栏有限拖拽排序通过Sol独立源码/规格/质量审核。主窗口已保存且身份唯一的项目提供独立原生拖拽手柄，保留↑↓键盘操作；新纯函数仅在同一Pin组内移动到目标位置，保留其他组的槽位与项目对象。常量MIME标记不携带路径，授权来自同一renderer内存intent；任意成功列表替换使旧拖拽失效，drop再核对最新唯一ID、字面路径及Pin组，外部/File拖拽不消费intent。继续先保存再更新ref/state、成功发布一次，保存失败保持原状态。实际feature缺失RED后定向65/65、全前端1342/1342、标准build/diff check及Sol独立65项通过；184源码仅App.tsx、workspaces.ts及对应两测试变化，其余180一致，聚合SHA-256 `1532a58f4b8b1b7972a5d82b7f1d244024f7f5422637a5f6e2a693a0b72437a8`。证据归档：`~/.local/share/yam/development-archives/20261009-project-drag/evidence.tar.gz`。验证限于纯函数和Node实际回调/JSX替身，未验证ReactDOM/native GUI拖拽，不代表完整B01、项目层级或cmux全部对齐；updater继续暂停。


2026-10-10（作者：Jeff.Liu）：按最新核心体验计划启动收口，不再派生 cmux 扩展功能。已核实 R11 与当前 184 源码集合一致，新增[六条核心工作流操作与验收说明](../../yam-core-workflows.md)，明确真实 Agent、通知、恢复、IME/TUI 与精确停止的前提和判定。原生条件实查：辅助功能与屏幕录制未授权，会话在控制台但锁屏状态未知；未启动应用、付费 Agent 或修改权限。六条桌面流程均待验收，原生工具/权限缺口保持未覆盖，未用此前源码、回调或后台 RPC 证据升级为体验通过。已准备独立临时项目；接下来由人工验收或在实际权限可用后执行原生验收，只对可复现的核心阻塞项做 TDD 修复。


2026-10-10（作者：Jeff.Liu；原生验收后续，追加记录）：本日早期“辅助功能/屏幕录制未授权、未启动应用、六条均待验收”仅是当时快照。后续实查两项权限均可用，已运行独立 R11/R12；未修改系统权限、信任或登录配置，updater 继续暂停。R11 普通 Shell A/B 切换、显式 Move tab 到 pane 2 分屏、隐藏恢复均已观察；Cmd+F 标记黄色高亮及非法 regex `[` 提示、两行粘贴先取消后确认且各输出一次、200 行旧 viewport 保留与新输出提示、Return to live 已实际观察。IME、复制选区、clear、GUI 精确 Stop 仍未验收，不能升级为完整终端体验通过。

R11 主窗红叉使 GUI 退出，owner 与两个 Shell 存活，但 Finder 无法重开。仅在 lib.rs 补 macOS Reopen 路由，复用 owner guarded open 与 GUI show；不改变 close 语义。行为单测实际 RED 1 通过/3 失败，GREEN 4 通过，system_entry 22 通过、保活退出 1 通过、全 Rust 660 通过/3 既有忽略；Sol 精确增量审核 PASS。独立 R12 构建身份检查通过，Finder 重开后出现新 GUI 15017，原 owner 14305、原 A/B `s-1a123d2aeb3-1` / `s-1a123d2fe89-2` 保持，desktop_connected=true、active=2。CUA 误连 headless owner，原会话恢复后的界面 live 输入未闭环；后台重连不替代该项。之后 root 只对两份 fixture owner 使用正常 authenticated shutdown，11 个旧 PID 实查 absent；这是清理，不计 GUI 精确 Stop PASS。界面后来显示保存 A/B stopped 与 B 标记输出。

真实 Codex interactive CLI `s-1a123e0eb59-1` 已在临时 cwd 启动；当前 owner 19065、desktop_connected=true、active=1，adapter=codex、mode=interactive、extra_args 为空、prompt=null。CLI 停在 6 Hook review 的信任选择，agent.phase=unknown、integration=connecting，0 付费请求。等待用户手动信任、拒绝或暂缓的决定；未修改 trust/login，Continue、可信状态、通知未运行，系统通知界面显示 disabled。

Agent 原生页面另复现头部挤压：Git 状态逐字换行占去大部分终端。新增实际 App header JSX/App.css 的 Node + 已安装 Chromium 几何测试，不引依赖；未安装浏览器时明确 skip。完整 DOM 与全部 fixture 结果到齐后主动关闭本测试临时 profile 的 Chrome，独立 15 秒 deadline 触发即失败；早期 spawnSync 超时输出不计正式红绿。可靠 RED 下 Agent Git 8.97×270px、header 287px；最小 CSS 换行与 Git 省略、对应 title 后 GREEN：1180px Agent header 109px、800px 109px、540px 保留侧栏 168px、400px 折叠侧栏且超长 Git 路径 220px，Git 均15px单行、所有可用操作在头部内可见。修复后原生 WebView 仍待复验，不以 Chromium 几何代替。精确证据位于 `/tmp/yam-core-acceptance-20261010/reopen-repair` 和 `/tmp/yam-core-acceptance-20261010/header-repair`；[六条核心工作流说明](../../yam-core-workflows.md)逐项保持部分验证/未验收，禁止汇总六流程全通过。

本次头部修复后全前端测试 1343/1343 通过（含上述实际浏览器几何测试，0 skip），标准 TypeScript/Vite build 与 diff check 通过。临时 headless Chrome 专属进程及 profile 目录实查均无残留；lib.rs 与已审核 Reopen 修复后的 SHA-256 保持一致。头部修复与本次文档更新等待独立 Sol 审核及原生 WebView 复验。

同日补记：头部修复及文档已通过 gpt6.1-sol 独立有限审核；审核方单次真实 Chromium 几何 5 fixtures 通过、0 skip。R12 不含后续头部修复，新原生构建/WebView、真实 Agent Hook 信任后短回复/可信状态/Continue、IME 和 GUI 精确 Stop 保持未验收，自动更新继续暂停。


2026-10-10（作者：Jeff.Liu；Hook 信任与终端闪烁后续，追加记录）：先前“等待用户信任”仅代表当时快照。用户在操作时明确同意“信任这6个YAM Hook并继续验收”后，root 已对 R12 Codex 会话 `s-1a123e0eb59-1` 实际执行信任：Hook review warning 消失，active/installed 数一致，页脚变为 enter details / esc close。外部记录 `/tmp/yam-core-acceptance-20261010/agent-hook-followup/trust-20261010T035300Z.json` 确认累计 0 付费请求、Continue=false；后续 CUA 返回 Mac is locked，需人工解锁。短回复、可信事件/通知、Continue 和完整 Agent 任务往返仍未验收，不再把等待用户信任写作当前阻塞。

同次用户报告终端持续闪烁、无法使用。实际 Chromium/xterm 回归复现完整投影 reset 与异步 write 之间的空白绘制，RED 29 blank paint；最小源码将 RIS 与完整投影合为同一 write 后 GREEN 0 blank paint，覆盖接近 8 MB 场景并核对焦点/输入。最终全前端 1345/1345 PASS、0 skip，标准 TypeScript/Vite build 与 diff check PASS，gpt6.1-sol 独立有限源码/行为审核 PASS；root 冻结 SHA 核对 PASS。外部 reset 与 in-band RIS 都保留隐藏光标状态，serializer 显式写入 ?25h/l，兼容证据与精确五文件增量见 `/tmp/yam-terminal-flicker-20261010`。既有 Reopen/header 源码未改变。同尺寸 resize 无持续 loop 证据，未修。独立 R13 随后打包成功（exit 0，21.42 秒），冻结源码未变，产物隔离身份、空 URL schemes、启动前 namespace absent 及 executable/runtime 资源检查通过；`r13-build-result.json` 与 `r13-artifact-receipt.json` 记录 launches=0、native_webview_verified=false、release_eligible=false，属于仅供开发验收的未启动包；用户完整原生/WebView 闪烁与输入体验因 Mac locked 待验，不以浏览器通过替代。六核心流程仍保持部分验证/未验收，自动更新继续暂停。


2026-10-10（作者：Jeff.Liu；R13 解锁后原生有限验收，追加记录）：用户澄清闪烁发生在终端/Codex 内容。Mac 已实际解锁；root 仅用 CUA 首次启动独立 R13（累计 launches=1），新 namespace 历史为空、冻结源码未变。此前“锁屏待验、R13 未启动”仅代表当时状态。普通 Shell A `s-1a12413d329-1` 持续合成 TUI 在第 67、118 帧截图中固定内容可见，`abc123` 输入完整，退出标记为 `YAM_R13_TUI_EXIT typed='abc123' frames=136`；q 随外部 UI 变化被观察到，并非 root 发送。截图采样未见空白；返回 Shell 的 `YAM_R13_INPUT_OK` 可见，Cmd+F 查退出标记为 1 of 1、黄色高亮，关闭后恢复输入焦点。此为有限截图采样，没有逐帧原生 trace 或长稳压，不推断所有闪烁永久消失；空白中间帧源码修复已有实际浏览器 RED29→GREEN0、全前端1345/0skip及Sol PASS。

R13 普通 Shell 内实际启动 bare Codex CLI 0.162.0，cwd 为 `/private/tmp/yam-terminal-flicker-20261010/native-followup`，没有新增 YAM Agent Hook 注入/信任操作；Escape 跳过更新提示，未提交文本 `YAM_NATIVE_INPUT_ONLY` 完整可见，Ctrl+U 清除，slash 菜单 Down 从 /model 移至 /fast，未选择设置，Ctrl+C 返回 Shell。付费请求为 0，未据此验收 Agent 事件或 Continue。GUI Stop A 后 stopped 且 R13 活跃数 1，B `s-1a12416a959-2` 仍输出 `YAM_R13_B_STILL_RUNNING`；随后 GUI Stop B 后 stopped、活跃数 0，R12 已有会话 Stop 操作为 0。普通 Shell 精确停止有限通过，不升级为所有 Agent Stop 通过。证据见 `/tmp/yam-terminal-flicker-20261010/native-followup/native-observations.json`。R12 仍是此前二进制；真实付费回复、可信事件、Continue、通知、IME 仍未闭环，系统通知 disabled；六核心流程不汇总为全通过，自动更新继续暂停。


2026-10-10（作者：Jeff.Liu；低频控件收敛与 R14，追加记录）：按用户“不常用的东西都收缩到菜单里面”要求，有限调整 App/TerminalLayout 原生 details 和既有样式。默认保留标题、紧凑运行/停止状态、New terminal、Find、终端标签；More actions 收纳会话操作/设置/报告详情/诊断，Layout 收纳原整排布局操作，Manage workspace、Project actions、Pane actions 分别承载侧栏管理、项目编辑/Pin/排序与 Move tab。既有回调、禁用条件、16-pane 限制、稳定 terminal host、快捷键及所有权保护不变；未删功能或增加依赖。有效 Git branch 紧凑显示，Not reported/CWD/phase 与 memory/engine/version/session ID 不再常驻长栏；仅 notifications disabled 改为菜单内中性说明和 Retry，其他真实错误及 owner/move/paste/stopped 保护保留。容量文案去掉过时的“下阶段提供归档恢复”，改为已有归档入口指引，仍明确不自动删除历史。

实际 header/sidebar/TerminalLayout JSX + 全 CSS Chromium 六场景验证含 1000/800/540 宽度及折叠 400、Stopped、长 Git 路径；默认布局操作条缩为一个 31px summary，菜单按钮仍可达，实际 Escape handler 关闭菜单并回到 summary。测试先 RED 再 GREEN，全前端 1360/1360、0 skip，标准 TypeScript/Vite build 与 diff check 通过；gpt6.1-sol 独立有限审核冻结六文件及定向 19/19、0 skip PASS。审核明确几何测试覆盖横向边界/高度和 scrollIntoView，不覆盖底部项目/多 pane 菜单的 viewport 上下边界，也不替代原生 React/WebView 交互。

Root 已构建独立 developer-only R14，exit 0、六文件冻结 SHA 一致，六项产物哈希、独立 identifier、空 URL schemes 与启动前 namespace absent 检查通过；证据为 `/tmp/yam-ui-declutter-20261010/r14-build-result.json`、`r14-artifact.json`、`r14-source-before-launch.json` 和 `independent-review.json`。CUA 获取 R14 时返回 Mac is locked，尚未观察其原生界面，已请用户解锁；仅一次 getApp 尝试，不能确定应用已启动或未启动，已验证原生操作为 0，见 `r14-native-status.json`；菜单垂直屏幕边界、底部/分屏菜单、分屏输入/Find 等原生复验未完成。此前 R13 有限 TUI/Codex 输入、查找、普通 Shell Stop 事实保留，不外推为 R14 或全部体验通过；六核心流程仍为部分验证/未验收，真实回复/可信事件/Continue/通知/IME 未闭环，自动更新继续暂停。


2026-10-10（作者：Jeff.Liu；R14/R15 解锁后有限原生观察及菜单修复，追加记录）：前述 R14 单次 getApp 锁屏、启动未知、原生动作 0 仅代表当时快照；用户随后解锁，root 已实际观察 R14 默认低频入口折叠，普通 Shell `YAM_R14_INPUT_OK` 可见，Cmd+F 为 1 of 2/黄色高亮，Escape 返回输入焦点。More 滚动至 diagnostics、Escape 回 summary；Layout Split down 后第二 Shell 输出 `YAM_R14_PANE_B_OK`；Pane 2 Move tab → To pane 1 后 `YAM_R14_MOVED_B_OK` 可见。Manage workspace 修正容量文案、当前隔离项目菜单及 Escape 回 summary 可见；GUI Stop 两条测试 Shell 后 2 sessions、0 active。

R14 原生同时复现 More 的 Copy terminal output / Clear terminal display 窄宽换行重叠：`.icon-button.small` (0,2,0) 的 28×28 胜过 menu button (0,1,1)。先补真实 JSX/full CSS DOM Range 文字区域回归，RED 精确报告两项文字溢出及侵入相邻项；只给既有 menu 规则追加更高优先级 selector，GREEN 六场景均166×28且 textFailures 空，未改 callbacks/guards/host。全前端1360/1360、0skip，标准build/diffcheck通过；gpt6.1-sol独立有限审核PASS，重跑1项浏览器测试覆盖6fixtures、0skip，不能与全前端重复加总。源码和证据冻结于 `/tmp/yam-ui-declutter-native-20261010`。

Root 随后构建独立 developer-only R15，exit0，冻结源码、六项产物哈希与隔离身份检查通过。R15 原生截图中 Copy/Clear 文字及图标完整、不重叠；从 More 打开 Terminal settings，字体/字号输入和预设可见，Escape 关闭设置，再点 More summary 关闭菜单；回到终端后 `YAM_R15_AFTER_MENU_OK` 输出可见。会话 `s-1a1245149ea-1` 首次 AX Stop 点击没有可观察状态变化且仍 active，重试同一可见 Stop 后 Stopped；Manage workspace 为1session/0active，Escape回summary。只记最终停止，不能声称首次点击通过。

本轮既有R12/R13操作0、付费请求0；启动文本“❌终端代理已关闭”来源已核实为 `/Users/liuwenyuan/.zshrc:46`，属于Shell输出，未修改配置。实际证据为 `r14-native-observations.json` 和 `r15-native-observations.json`。锁屏当前已解除；结果限于当前窗口/项目、R14两pane和R15单pane，未验证大量项目viewport底部或16pane全部几何、完整Agent对话/Continue/通知/IME/持续高输出。R13先前有限结论保留，六核心流程仍为部分验证/未验收，updater继续暂停；未创建可发布产物。
