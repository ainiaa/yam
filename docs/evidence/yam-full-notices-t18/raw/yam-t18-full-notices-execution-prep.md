# T18 Full Third-Party Notices: Offline Execution Prep

Author: Jeff.Liu
Status: read-only preparation. This is an execution capsule proposal, not an implementation, legal approval, or release-ready declaration. Implement only after T13 is closed and Root authorizes T18. No workspace files, dependencies, builds, SEA outputs, or package publication were changed here.

## Frozen inputs to rebind after T13

The currently inspected Cargo lock is apps/desktop/src-tauri/Cargo.lock, SHA-256 1199afff7359e06c065cd5192658637d020a0fbe333e536a2b14cd4739676df6. It contains 535 registry packages and the first-party path package yam-desktop 0.1.0. Key each registry identity by name, version, source, and checksum; exclude only yam-desktop by exact identity. Reject any unexpected git/path source, duplicate identity, or lock drift. Recompute the lock digest at T18 start rather than assuming this observation is still final.

The frontend lock is apps/desktop/pnpm-lock.yaml, SHA-256 e17abb847e2c95b7ad8965ee8d08daa26338a74d0774369385a5498961b6b48a. It has 69 package records total, including development/build tools and optional platform packages; its root production importer has 11 direct dependencies and the dependency closure is 12 exact package instances. Use that production closure because these packages feed the shipped UI or the embedded terminal runtime; do not include Vite/Tauri CLI/typescript development tools unless future packaging actually redistributes them. Bind collection to the whole lock hash plus the exact closure, and validate each installed package name/version. Closure:

- @tauri-apps/api 2.12.0
- @tauri-apps/plugin-deep-link 2.6.1
- @tauri-apps/plugin-dialog 2.8.1
- @tauri-apps/plugin-opener 2.7.0
- @xterm/addon-fit 0.11.0
- @xterm/addon-serialize 0.14.0
- @xterm/headless 6.0.0
- @xterm/xterm 6.0.0
- lucide-react 0.468.0 (lock peer instance with react 19.3.0)
- react 19.3.0
- react-dom 19.3.0 (lock peer instance with react 19.3.0)
- scheduler 0.28.0 (resolved from react-dom’s installed sibling dependency)

Rebind both exact lock snapshots, package.json, and installed package graph before implementation; never resolve or upgrade packages in this feature.

## Existing builder behavior and accepted evidence

CodeGraph located the current test seam in scripts/test_terminal_runtime.py and existing build/use callers. The Python builder itself is not indexed, so its current source was read directly at scripts/build-terminal-runtime.py. It extracts the pinned Node 26.10.0 distribution license, reads terminal-licenses/XTERM-LICENSE for @xterm/headless and @xterm/addon-serialize, and reads LICENSE bodies for React, React DOM, lucide-react, @xterm/xterm, and @xterm/addon-fit. It validates those five package names, versions, and nonempty license metadata/body. It currently builds/probes SEA before replacing the binary and writing THIRD-PARTY-NOTICES.txt; T18 must compute and validate a complete notice payload before any SEA build or final output replacement.

Existing offline source evidence to carry forward, without repeating the already verified 42 archive hashes:

- /tmp/yam-t18-remaining-license-manifest.json, SHA-256 95c4b71377cd6272cad2b4693c87537a29d7e16187b6994bd3b298eb208860df.
- /tmp/yam-t18-root-remaining-license-verification.json: 42 archives and 32 body references checked; issues empty. Its documented early archive-member path-harness mistake is not a body/hash finding.
- /tmp/yam-t18-final-origin-followup.json: the original manifest SHA is unchanged. It binds libappindicator-sys 0.9.0 to tauri-apps/libappindicator-rs at eafd1e3682a1247f595410266091e9684021cb6f by byte-identical Cargo.toml.orig -> sys/Cargo.toml and src/lib.rs -> sys/src/lib.rs; exact-revision LICENSE-APACHE and LICENSE-MIT bodies are stored and hashed under /tmp/yam-t18-final-origin-bodies/. Keep both winapi records as gaps because all compared source files at the candidate tag failed byte binding.
- /tmp/yam-full-notices-feature-contract-draft.md and /tmp/yam-full-notices-next-source-inventory.json contain the earlier scope and frontend source findings. For plugin-dialog, use only its already recorded npm gitHead/source evidence d4835d0e947179bac24a383212792d74be3ebe4f and its two full body files under /tmp/yam-notices-primary/, after the collector validates the relevant npm package lock integrity. Deep-link and opener currently have SPDX metadata only; do not copy dialog’s revision across sibling packages. No new network source lookup is in this preparation.

The old first-eight review still applies: alloc-stdlib, defmt-parser, dlopen2, dlopen2_derive, and jni have exact full-text sources; block2, dispatch2, and cesu8 still lack a collected complete legal body. Existing package/source records and all prior SEA notice sections must remain identity-mapped and preserved.

## Exact unresolved-source gates

The current 42-package remaining manifest has 23 gaps after the libappindicator exact-source follow-up. Add the three earlier first-eight gaps for 26 currently known Cargo gaps:

- 18 objc2-family records whose exact-revision LICENSE.md is only an option/declaration/link and Apple SDK derivation note, not complete grant text: objc2 0.6.4; objc2-app-kit, objc2-cloud-kit, objc2-core-data, objc2-core-foundation, objc2-core-graphics, objc2-core-image, objc2-core-location, objc2-core-text, objc2-foundation, objc2-io-surface, objc2-osa-kit, objc2-quartz-core, objc2-ui-kit, objc2-user-notifications, objc2-web-kit (all 0.3.2); objc2-encode 4.1.0; objc2-exception-helper 0.1.1.
- winapi-i686-pc-windows-gnu 0.4.0 and winapi-x86_64-pc-windows-gnu 0.4.0: candidate release source did not match cached Cargo.toml.orig/src/build bytes; keep the gap.
- r-efi 5.3.0 and 6.0.0, selectors 0.38.0: exact VCS trees had no full-text candidate.
- block2 0.6.2 and dispatch2 0.3.1: links/declarations only; cesu8 1.1.0: no complete crate license body collected.

The npm production closure adds two known missing full-text sources: @tauri-apps/plugin-deep-link 2.6.1 and @tauri-apps/plugin-opener 2.7.0. Their installed SPDX files are metadata, not full texts. plugin-dialog has source-bound full texts; @tauri-apps/api has both supplied bodies; scheduler resolves through react-dom; preserve the existing Xterm attribution source for headless/serializer while recording the individual package identities.

These counts reflect a bounded gap audit, not a full count of absent license files among all 535 registry packages. The remaining packages still require exact archive/checksum validation and candidate-body coverage during collection. Mark every confirmed gap by package identity and source evidence; do not declare license_ready or substitute standard license text solely from an SPDX expression.

## Minimal owned paths

- scripts/build-terminal-runtime.py: call the validator/renderer before SEA and publish only a validated complete payload.
- scripts/third_party_notices.py: one small stdlib-only source collector/manifest validator and deterministic offline renderer. Use tomllib for Cargo.lock, tarfile with strict member/path/size/type limits for .crate bodies, json/hashlib/pathlib; do not add Python, Rust, or npm dependencies.
- scripts/test_third_party_notices.py: isolated temporary fixtures for parser, source/hash validation, gap reporting, and deterministic rendering.
- scripts/test_terminal_runtime.py: focused mocked integration asserting notice validation happens before --check/--build-sea/final replacement and existing node/headless/serializer/frontend sections remain present.
- scripts/third-party-notices/manifest.json and scripts/third-party-notices/bodies/<sha256>.txt: lock-bound identities, provenance, original exact body bytes, and explicit unresolved records; identical body bytes may be stored once but every package identity maps to its source/body.
- docs/THIRD_PARTY_NOTICES.md: scope, coverage status, reproducible offline invocation, known gaps and release gate.

Do not edit Cargo.toml/Cargo.lock, pnpm lock, app UI, Tauri permissions, product license, or dependency lists.

## Test-first implementation sequence

Add failing temporary-fixture tests before changing the builder:

1. Normal coverage: checksum-valid synthetic .crate archives with a top-level license, nested license-file, multiple versions of one name, two packages sharing byte-identical text, a package with distinct LICENSE and NOTICE, and a matching 12-instance synthetic frontend manifest. Assert exact locked identity coverage, retained per-package mapping, stable sort, UTF-8 output, and preservation of CRLF/Unicode/leading and trailing body bytes.
2. Boundaries: archive and member byte limits, allowed regular-file members only, safe normalized in-package paths, license-file path resolution, duplicate lock/manifest identities, unlisted body, optional same-name versions, shared body hashing, and maximum frontend package bounds.
3. Errors: missing/corrupt archive, checksum mismatch, invalid/missing/empty license-file, malformed Cargo metadata, traversal path, symlink/device member, invalid UTF-8, metadata-only SPDX, missing package body, stale Cargo/pnpm lock hash, unexpected nonregistry dependency, wrong installed npm name/version, absent react-dom sibling scheduler, corrupt source hash, and unsafe external-source path. Patch all downloader/network entry points to fail if called.
4. Builder integration: with an unresolved record, assert sorted explicit package+version diagnostics; no SEA subprocess call; existing binary and notices bytes untouched. With complete fixtures, assert notices are validated before SEA, then old Node/Xterm/five frontend sections plus every new identity/body occur exactly once and remain deterministic. Inject SEA/probe/write failures and assert existing output is preserved as far as the existing single-output replacement model permits.

Run the focused Python unit commands first, then existing scripts/test_terminal_runtime.py, then frontend tests only if touched by the helper integration. Do not run native GUI, owner, Agent or an actual Node SEA in the unit matrix.

## Offline collection, render and release behavior

Collection must consume only the frozen exact Cargo.lock, frozen exact frontend graph/lock, checksum-verified local .crate archives, installed frontend files, and already source-bound bodies listed in these receipts. No network access in collection or rendering. For a new lock/source gap, emit its identity and a bounded reason into the collection report; do not guess or download text under this task.

A future deterministic offline render command after the helper exists:

    python3 scripts/third_party_notices.py render --cargo-lock apps/desktop/src-tauri/Cargo.lock --pnpm-lock apps/desktop/pnpm-lock.yaml --manifest scripts/third-party-notices/manifest.json --output /tmp/yam-THIRD-PARTY-NOTICES.txt --offline

It must validate full Cargo registry-set equality, checksum and lock digests, exact frontend lock/installed identity set, all source hashes, and zero unresolved entries before writing. Render original notice/license body bytes with identity headings in stable order. Do not normalize or SPDX-generate text. A build-time invocation has no network fallback.

Because there are known unresolved Cargo and frontend identities, the first authorized T18 implementation should remain fail-closed: normal SEA build prints the bounded sorted gap list and stops before Node --check, --build-sea, final binary replacement, or notices replacement. Do not emit a partial THIRD-PARTY-NOTICES.txt as if complete. The optional preparation report may describe known gaps separately from the bundle; it must be labeled incomplete and never named license_ready. Final bundle-visible notices and a release-ready claim remain blocked until every selected identity has an exact full-body source or an explicit release-owner policy decision backed by source evidence. This feature does not choose YAM’s project license or make a legal compatibility conclusion.
