# macOS 正式签名与公证

作者：Jeff.Liu。

本地 ad-hoc 签名与 CI 测试包不能用于证明正式分发。正式产物必须依次通过 Developer ID Application 签名、Apple 公证、staple 及 Gatekeeper 检查。

## 前置条件

- 钥匙串已有有效的 Developer ID Application 证书及私钥。
- 已由持有人使用 `xcrun notarytool store-credentials` 在钥匙串中配置公证 profile。密码、API 私钥不得写进仓库或聊天。
- macOS 安装 Xcode Command Line Tools，产物是正式标识 `com.yam.desktop` 的 YAM.app。

`rtk proxy security find-identity -v -p codesigning` 列出可用证书。当前本机结果为 0，故不能实际正式签名；用户已选择先完成流程与检查，不申请证书、不发布。

## 执行

先运行现有构建命令，在 `apps/desktop` 中构建正式 `.app`。推荐在构建时通过 `APPLE_SIGNING_IDENTITY` 指定现有证书，Tauri 管理嵌套代码的签名顺序与打包；环境变量只填证书名称，不填私钥或密码。

对已经使用 Developer ID 签名的产物，显式执行：

```sh
rtk proxy python3 scripts/macos-release.py notarize /absolute/path/YAM.app --identity 'Developer ID Application: NAME (TEAMID)' --notary-profile yam-notary
```

对当前没有嵌套代码的 YAM.app，也可使用 `sign-notarize` 模式完成本地签名后公证。有 framework、dylib、嵌套 app 或 xpc 的包会明确拒绝此模式，必须使用 Tauri 构建签名，不递归猜测签名顺序或 entitlements。

脚本以字面参数调用系统工具；只接受正式 bundle；签名检查通过后才上传临时 ZIP 给 Apple 公证，只有 `Accepted` 才 staple。API 失败、拒绝或超时均返回非零，绝不自动发布。上传属于显式 `notarize` / `sign-notarize` 操作，`check` 不上传或修改产物。

最终只读检查：

```sh
rtk proxy python3 scripts/macos-release.py check /absolute/path/YAM.app
```

验证签名完整性、Developer ID、hardened runtime、stapled 公证票据与 Gatekeeper。将通过检查的 `.app` 再进行 ZIP/DMG 打包，并记录 SHA-256；如果之后修改包内容，必须重新签名、公证和验证。此流程只覆盖 macOS `.app`，不宣称 Windows 签名或 Linux 安装验收完成。

## 回归

```sh
rtk proxy python3 -m unittest discover -s scripts -p test_macos_release.py
```

使用系统命令 mock 验证步骤顺序、字面路径、证书缺失、公证拒绝、命令失败、嵌套 bundle 拒绝与只读检查。该回归不伪称实际签名、公证或 Gatekeeper 通过。
