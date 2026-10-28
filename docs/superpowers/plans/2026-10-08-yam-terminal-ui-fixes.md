# YAM 终端界面五项修复

作者：Jeff.Liu。

用户已明确授权本批修改，沿用 gpt-6.1-sol 实现与独立审核。不新增依赖，不变更后端架构。自动更新继续暂停。

| 用户要求 | 当前实现 |
|---|---|
| 查找内容高亮 | 金色背景、深色文字，采用 xterm 顶层 decoration；当前匹配被选中后仍保留查找颜色。关闭后重开已有查询时立即刷新高亮，不等待下一次后台画面 |
| Font family 下拉和输入 | 预设 SFMono-Regular、Menlo、Monaco、Consolas、monospace；保留字体及 fallback 列表手动输入。预设不是本机已安装字体枚举 |
| Font size 下拉和输入 | 提供10–24预设，允许直接编辑，包括临时清空；保存仍校验整数10–24，非法值和保存失败保留对话框并提示 |
| Project icon 随展开状态变化 | 使用 FolderOpen／Folder，并与 `aria-expanded` 和会话列表的实际展开状态共用同一个判断，包括搜索强制展开 |
| 查询入口与头部菜单 | 当前终端有明确的 Find in terminal 按钮；Cmd/Ctrl+F 从工具栏或普通非编辑位置也能查找当前可见、已就绪面板。日志查询和命令面板移入 More actions；保留原有快捷键。菜单选择动作后关闭，Escape 关闭并恢复到菜单入口焦点 |

普通输入框、select、模态对话框、IME、repeat 与非法组合键保护保留；字号快捷键和终端写入仍使用既有焦点／owner 规则。手动选择与查找选区的生命周期保持原契约。

## 验证

先取得实际组件／App 回调与 controller→安装版 xterm renderer 的语义 RED，再改生产代码。设置预设、输入关联标签和重新打开查询的补充 RED 均单独保留。

- 定向组合70项通过；最终前端595项通过。
- 项目 coverage595项通过：lines99.61%、branches92.18%、functions95.99%。既有命令只计 `src/*.ts`，不计 TSX；TSX 由实际转译组件与事件测试执行，不能称原生 GUI 覆盖率。
- 独立审核145项影响面测试通过；八文件源码哈希在审核前后匹配，无可执行 finding。
- TypeScript／Vite 构建通过；离线、锁依赖的隔离 debug app 构建成功，identifier `com.yam.ui-validation-20261008`。
- 强化 ANSI 保留断言时曾误读 renderer 的 class 属性位置，失败记录保留；核对安装版源码后修正测试 fixture，最终完整测试与 coverage 重验通过，没有为此放宽生产逻辑或 Worker deadline。

**原生 GUI 验收未覆盖。** CUA `getState` 30秒超时并重置 kernel；未使用其他 UI 自动化绕过。隔离构建包未启动。不能据本批源码测试宣布原生 Cmd+F、菜单、字体选择与高亮全部实机通过，也不能宣布已全面对齐 cmux。

本批原始证据在 `/tmp/yam-terminal-ui-20261008/`，日志和 JSON 不加入 Git。验收包位于 `apps/desktop/src-tauri/target/debug/bundle/macos/YAM UI Validation 20261008.app`。本批未提交、推送或发布。
