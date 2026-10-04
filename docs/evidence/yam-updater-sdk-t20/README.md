# T20SDK — approved Rust dependency only

Author: Jeff.Liu

The user approved only the Rust updater SDK; authorization（原始文件已归档） leaves other configuration pending. The exact reviewed patch（原始文件已归档） adds `tauri-plugin-updater = "2"` only under the macOS/Windows/Linux desktop cfg. No existing direct requirement, feature or Cargo author metadata changed. There is no JS SDK, plugin registration, updater permission, public key, endpoint, update check, install, key creation or publication. This slice is not the complete T20 updater feature.

The initial semantic red（原始文件已归档） ran five executable stdlib configuration tests: two AssertionErrors for the missing desktop requirement and missing lockfile package, with three directgreen boundary checks. There was no import/compiler harness failure. Root red（原始文件已归档） independently reproduced the same result at stable hashes. The boundary checks verify no frontend SDK, service/key configuration, updater permission or runtime registration/call. All five passed after the actual dependency resolution: author green（原始文件已归档）.

One unlocked `cargo metadata` invocation resolved **tauri-plugin-updater 2.13.1** from crates.io, checksum `3cb0b2ea3e85ca287990d3859a29cc5cb18024240fd78f62e027fb7963670f18`. The resolution receipt（原始文件已归档）, raw stderr（原始文件已归档）, bounded package receipt（原始文件已归档） and dependency diff（原始文件已归档） preserve that evidence. The complete 2,772,219-byte metadata graph remains at `/tmp/yam-t20-sdk-cargo-resolution-metadata.json`, SHA256 `0746013bad85d8c268e6410c3868291b913d551d6699558a688656bd65ea783b`; it is not duplicated in the repository. This temporary path is host evidence, not a portable source artifact. No second unlocked resolution was run.

Cargo added 35 packages, removed none and changed dependency entries of 10 existing packages. Independent Astra review confirmed every added package is reachable from the SDK and all existing package versions/checksums remain unchanged. The application directly depends on the resolved SDK. Subsequent Cargo test/clippy use `--locked`.

Actual author checks: configuration5/5, host Rust402passed/2ignored (79.81s execution,119.470s wall including first SDK compilation), Python85passed (10.707s execution,10.843s wall), fmt0.253s, clippy20.289s and diff0.019s, all exit0. Exact argv/times/hashes are in validation（原始文件已归档） and the individual raw logs. This plan requires these six checks; no frontend build, packaged App, real owner, Agent, GUI, Hook, signing service or frozen T06 assets were used.

Current code freeze（原始文件已归档） binds the manifest, lockfile and test. Root frozen green（原始文件已归档） independently passed5/5 with three hashes unchanged; Root review（原始文件已归档） confirms the exact manifest scope. Astra review（原始文件已归档） independently passed5/5 and locked offline metadata, verified50 application/frontend/config/JS paths unchanged and found no remaining confirmed P0/P1/P2 in this dependency-only scope. Reviewer full Rust/clippy results are references to author evidence, not independent reruns. Native multi-model review is not execution of official provider gates.

Feed address, verification key/key-holder, distribution formats, service deployment and signing/publication still require supplied configuration and separate implementation. Host compilation does not prove Windows/Linux packaged behavior or native update installation. Native three-platform acceptance and official provider gates were not executed. See [updater scope](../../yam-updater.md).

Final index（原始文件已归档）, document checks（原始文件已归档） and bounded end receipt（原始文件已归档） bind this slice. Root separately audits the full workspace delta before lease release. No source or documentation writes follow the final seal.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
