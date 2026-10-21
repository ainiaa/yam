# Native window identity：有限源码闭环

作者：Jeff.Liu。日期：2026-10-09。

多 Webview 窗口身份前提已交付并通过独立 spec/quality 审核。浏览器仍是独立窗口；本片没有新增同面板浏览器、前端能力或原生 GUI 验收。

## 行为与边界

26 个现有窗口命令改用真实注入 Webview，验证 exact main→main 或 terminal-secondary→terminal-secondary 身份后才访问命令状态或执行副作用。全局守卫与命令局部守卫共享同一身份判断；Ticket 的 epoch、generation、claim、Unknown 和 parser-uncertain 规则保留，包括已有 reported-prompt navigation。未声称逐一执行全部26个生产 IPC。

窗口存在、显示、激活、前台状态与几何查找使用父 Window；URL与ready脚本使用确切可信叶 Webview及其父身份。原 WebviewWindow.set_focus 本来只激活父 Window，该语义保持；没有把它升级成叶输入焦点证明。独立 browser-preview 的组合句柄与创建流程保留，无“第一个子 Webview”回退。

现有 Tauri 生产依赖必须启用 unstable 才公开 get_window/get_webview；最初仅测试配置启用该功能，正常生产编译出现真实 E0599。明确补充批准后，只给现有同版本 SDK 的生产功能数组追加 unstable。536个 name/version/source 包集合、Cargo.lock 与权限配置字节不变，无新 crate、默认功能或权限扩张。测试仍使用同一 Tauri 的 test/unstable 功能。

为复用真实配置且避免 macOS重复 _EMBED_INFO_PLIST，唯一 generate_context 宏位于极小 generic Context helper；原 app_context()->Context<Wry> 包装保持 CLI/background 调用兼容。没有泛化 App factory、运行 setup 或手工重建 ACL。

## 可复核证据

实际 SDK IPC 多子 Webview 拓扑先以旧 WebviewWindow 提取获得语义 RED，再以 Webview→Window 获得 GREEN。旧仅label的 Slot→Table.reserve 接缝也取得 RED；这是生产纯接缝测试，不是完整 Wry命令运行。后补 exact-pair/FileJob零分配和查找回归如实记录。公共 AsRef绑定、MoveReply返回类型、插件类型推断、重复宏与 Context推断属于 scaffold失败，未计作语义 RED；原生产 E0599及批准补充永久保留。

配置ACL测试直接复用真实 generate_context 与已生成权限：main/secondary事件监听正向控制，现有 opener/dialog权限下注册哨兵命令，无真实 OS调用；两父窗口下guest的app/local/loopback/remote请求被拒，custom IPC执行真实全局守卫。MockRuntime并非nativeGUI/焦点/绘制证明；不访问私有eval dispatcher。

作者全Rust串行640通过、0失败、3项既有ignored，106.54秒。三项分别是 memory::tests::native_application_self_sampling、memory::tests::native_running_desktop_fixture、tests::process_tree_without_path_probe（既有有界current-exe子测试入口）。全套包括既有test-owned native/PTY回归，不是用户owner启动。

全Rust执行后只变更Cargo生产功能数组；4个Rust文件最终字节完全相同，实际locked/offline metadata证明536包和dev-inclusive resolved feature union一致，旧全套按精确投影保留，未伪称最终whole-map重跑。最终正常 cargo check/build --lib --bins 已真实编译和链接通过，fmt、all-targets Clippy、diff通过；既有browser UI回归7通过，无新frontend全套或coverage。

独立审核分组：4项identity、33项window/Table、10项browser native、7项JS通过；存在重叠，不合并为unique总数。177文件绑定、5owned（4Rust+Cargo）、非owned漂移0。源码聚合 e91004973f2bf81cfd5c657f8c655c2a86bf81240a22c276dabf869c319af4a0；原始maps/日志/独立报告保存在外部capsule及闭环归档。

## 尚未验证

native GUI焦点/渲染、精确eval脚本观察、同pane/full C01与Suite仍open。Manager全局emit/AnyLabel不是任意native guest订阅的独立安全边界；本片保留既有事件语义，不作额外隔离承诺。未启动应用、owner、真实网络或GUI；自动更新继续暂停。历史R8/C3及旧包结论保持各自执行时归属。
