# T18FrontendNotices minimum contract (read-only preparation)

## Fresh-task boundary

This is a bounded follow-on task, not permission to edit or build now. Wait for T19 seal, then let Root create the new task's baseline and lease. T18 configuration and T20 SDK evidence are historical references; do not reopen or mutate their sealed files. No repository changes, package builds, downloads, native commands, or target/T06 writes were made for this preparation.

## Primary-source finding

`scripts/build-terminal-runtime.py` already assembles `target/terminal-runtime/THIRD-PARTY-NOTICES.txt`, and `apps/desktop/src-tauri/tauri.conf.json` already bundles that file as a resource. The current assembly includes the extracted Node LICENSE and headings/bodies for `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0, reusing `apps/desktop/terminal-licenses/XTERM-LICENSE`. This is a narrow existing integration point for adding source text to the generated notices file, without a new dependency or choosing a YAM project license.

The requested five direct frontend packages are verified from the installed `apps/desktop/node_modules/<package>/package.json`, their package-owned `LICENSE`, and the `apps/desktop/pnpm-lock.yaml` importer resolved version:

| Package | Installed = locked | Metadata license | Package-owned LICENSE |
|---|---:|---|---|
| `react` | 19.3.0 | MIT | present |
| `react-dom` | 19.3.0 | MIT | present |
| `lucide-react` | 0.468.0 | ISC | present |
| `@xterm/xterm` | 6.0.0 | MIT | present |
| `@xterm/addon-fit` | 0.11.0 | MIT | present |

Exact source paths, resolved installed paths, metadata/license hashes, lock importer locations, and byte-equality checks are recorded outside the repo in `/tmp/yam-t18-frontend-notices-provenance.json`. React and React DOM LICENSEs happen to be byte-identical; preserve separate package/version headings. The renderer LICENSE matches the existing `XTERM-LICENSE`; `@xterm/addon-fit` differs. For the five new sections, read each package's own installed LICENSE directly; do not use the old common xterm text as a substitute for fit or other packages.

Use a small explicit list of `(package name, expected version)` values matching the frozen pnpm lock and checked provenance inventory; validate installed package metadata name/version/license against those values. The build runs under the existing frozen-lockfile dependency-install contract. Do not add a pnpm YAML parser, generic dependency-discovery framework, new dependency, or runtime lockfile parser. Version mismatches are fail-closed; the task's provenance receipt and fixture assertions must retain the observed lockfile/package metadata correspondence.

`@tauri-apps/api` 2.12.0, `@tauri-apps/plugin-dialog` 2.8.1, `@tauri-apps/plugin-opener` 2.7.0, and `@tauri-apps/plugin-deep-link` 2.6.1 have license metadata and lock entries, but no package-root LICENSE file was found. Tauri JS/plugin text coverage therefore remains unresolved in this slice. Cargo/Rust and transitive/bundled dependency closure also remain unresolved. Do not claim a complete notice inventory, SPDX compliance, select a YAM project license, or invent Ghostty provenance.

## Minimal source behavior

Extend `scripts/build-terminal-runtime.py`'s current `licenses` assembly with five explicit frontend package descriptors and their expected versions. For each, require matching package name/version and a nonempty license metadata field; read its own regular `LICENSE` as bytes, decode strict UTF-8, reject invalid encoding and whitespace-only content, and append a package-name/version heading plus the original decoded body unchanged. Do not `.strip()` the body before output (use stripping only to test whether content is empty); keep existing Node/headless/serializer assembly unchanged. Missing package metadata or LICENSE, empty body, invalid UTF-8, or installed-version mismatch must fail closed before the SEA binary or notice file is replaced. Do not add actual upstream LICENSE copies to the repository; assembly reads them from the locked installed package tree.

## Semantic RED fixture: mock `main()`, never the real builder

`script/test_terminal_runtime.py` currently has no notice assembly test. Its optional `test_native_builder_preserves_unicode_with_legacy_default_encoding` is materially different: if a cached native runtime exists, it calls the real `runtime.main()`; on Darwin that path can invoke `/usr/bin/codesign --force --sign -`. Do not run it or execute the unfiltered Python suite and then claim no Apple command ran.

Add a deterministic test fixture that invokes the loaded `runtime.main()` only inside a fully isolated temporary repository. Point the module's `__file__` at `<temp>/scripts/build-terminal-runtime.py`; pass `--output <temp>/out/yam-terminal`; provide a tiny local Node tar archive, synthetic Node LICENSE, fake xterm source modules/service, fake package metadata/lock-derived expected versions, and small unmistakable `TEST FIXTURE LICENSE ONLY` bodies. Patch `archive_verified` to accept only that local archive; patch `platform_name` to a deterministic non-Darwin target; make `urllib.request.urlopen` fail if called; mock `subprocess.check_output` and every `subprocess.run`. The `--build-sea` mock may write only the configured placeholder executable under `<temp>`; the protocol-probe mock returns four synthetic frames that satisfy the existing contract. Assert all fixture writes remain beneath the temp root and no call reaches network or a real subprocess.

The first RED must run current `main()` to completion through those mocks, read the generated notices file, and fail output-content assertions because the five frontend package/version sections and their distinct fixture LICENSE bodies are absent. This is semantic output RED, not missing-helper/import/compiler failure. Keep synthetic license markers short and distinguishable; do not copy real package LICENSE text into the repository or logs.

Test normal fixture success plus installed-version mismatch, missing LICENSE, empty/whitespace-only LICENSE, and invalid UTF-8. For all invalid cases, assert a fixed failure and that preexisting temporary placeholder binary/notice files remain byte-identical; the `--build-sea` mock must not be reached. Validation occurs before the existing final output `replace()` and notice write.

## Verification constraints and completion language

Run the new test alone by its unittest test name under `PYTHONDONTWRITEBYTECODE=1 python3 -B`; it is safe because all script entry side effects are mocked and paths are temporary. For future full Python fixtures, use Root's `/tmp/yam-t19-sourceflow-host-fixtures.py`, which explicitly marks exactly `test_terminal_runtime.RuntimeTests.test_native_builder_preserves_unicode_with_legacy_default_encoding` skipped and asserts it found exactly one such test. Do not run `python3 -m unittest discover ...` unfiltered: with the target cache present the excluded test builds the runtime and may invoke codesign. Report the explicit skip, do not imply native acceptance.

Record package-name/version provenance and hashes from the actual installed metadata and lock; do not copy full LICENSE bodies into evidence. Keep generated notice output under the test's temporary repository. Do not run `build-terminal-runtime.py` unmocked, download dependencies, build SEA, codesign, mutate `src-tauri/target`, touch T06 assets, access credentials, or invoke native/CI/upload flows. Suitable completion language is: “five locked direct frontend package license sections are assembled from their package-owned LICENSE files in the bundled notices resource; Tauri JS/plugins and Cargo/transitive inventory remain unresolved.” This does not select a project license or prove package-level/native visibility.
