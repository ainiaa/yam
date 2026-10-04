# T18 npm accepted-source bridge

Author: Jeff.Liu
Status: concise read-only synthesis for Root; the new tarball receipt is still subject to Root/Astra independent verification. This does not change the frozen old seed or claim legal approval / `license_ready`.

## Bind the inputs first

- Preserve `/tmp/yam-t18-npm-lock-seed.json` byte-for-byte at SHA-256 `feab5c9b375421b8c27e853f7232a37b4993097efef6982e757d6cd32224cc77`. It holds the manually reviewed 12 raw pnpm resolution fragments, exact `(name, version, peer locator, SRI)` mapping, package source/body references, graph summary, and the historically accurate unresolved SRI-to-source note. Do not overwrite it to make its earlier status appear current.
- Read `/tmp/yam-t18-npm-tarball-provenance.json` at SHA-256 `c5527c96d6a26c5b10d3bbed60c3c73b48a28c136bd26f213fb678c4d36818bf`. Its declared input seed SHA is the same old seed hash; pnpm lock SHA is `e17abb847e2c95b7ad8965ee8d08daa26338a74d0774369385a5498961b6b48a`; canonical root dependency-declarations digest is `97a26697e985746ddbfafef6c2229b71263aeddb2b622633fa6a1464f761faeb`.
- Only compose the evidence after Root/Astra verify the artifact hash, all 12 identity/SRI/URL joins, and the recorded member/installed byte comparisons. Its stated preparation time is 7.051 seconds; no packages were installed or executed, and it reports no workspace edits or network fallback. This note relies on the receipt; it did not repeat archive hashing.

## Joining the evidence into T18

For each of the seed's 12 identities, join exactly on package name + version and compare the seed's lock SRI to `records[].lock_sri`; use the tarball receipt's `source_url`, `archive_sha256`, `archive_bytes`, `sri_verified`, `package_identity_match`, `package_json_sha256`, and `installed_package_json_byte_equal` as the archive provenance fields. This upgrades the seed's canonical URL candidates to observed tarball URLs with SRI-verified archive evidence, once the independent review accepts the receipt. Keep the pnpm raw block and whole-lock digest as the provenance for the locked request; the tarball receipt confirms the package archive bytes selected by that lock.

Map each `records[].members[]` entry into the package body's source table by its exact `member` path and SHA-256, retaining byte count and `metadata_only` classification. A non-metadata `package/LICENSE*` member with `installed_byte_equal: true` can replace the old installed-path-only body reference with an archive-member + installed-byte-equality reference. Preserve the raw body bytes by hash; keep independent identity/license-file mappings even where several packages share identical text. `package.json` member equality is package identity corroboration, not itself license text provenance.

- For `@tauri-apps/api`, the tarball supplies both full-text Apache and MIT bodies, and both match installed files byte-for-byte.
- For `@xterm/addon-fit`, `@xterm/xterm`, `lucide-react`, `react`, `react-dom`, and `scheduler`, archive LICENSE members match their installed full-text body hashes. `scheduler` remains a distinct transitive identity under `react-dom`, with its own SRI and archive record.
- The `@xterm/headless` and `@xterm/addon-serialize` tarballs have no LICENSE member in this receipt. Keep their existing per-identity mapping to the shared `apps/desktop/terminal-licenses/XTERM-LICENSE` source. The same body SHA is independently present as `@xterm/xterm`'s archive LICENSE and current renderer license; do not claim it is a member of the headless/serializer archives.
- `@tauri-apps/plugin-dialog`'s npm archive also carries only SPDX metadata, so continue to use the existing immutable full-text source receipts: `d4835d0e947179bac24a383212792d74be3ebe4f`, `plugins/dialog/LICENSE_APACHE-2.0` and `LICENSE_MIT`, with their prior body hashes. The existing npm packument receipt supplies the matching version's `gitHead`; the new archive receipt separately verifies tarball SRI and package identity. Do not replace those full texts with the archive's `LICENSE.spdx` declaration.
- `@tauri-apps/plugin-deep-link` and `@tauri-apps/plugin-opener` remain unresolved full-text gaps. Their tarballs prove the package identity and the exact installed SPDX metadata bytes, but those 888-byte SPDX files are not full license bodies. Do not copy the dialog package's body/revision across sibling plugins.

## Resulting acceptance state

The tarball receipt closes the earlier *mechanical npm archive-integrity-to-installed-package* gap for the 12 lock identities if independent review passes. It does not close the two full-text gaps for deep-link/opener. Reports must retain those identity-specific gaps, and formal release stays incomplete until they receive acceptable exact full-text evidence or an explicit release-owner policy disposition. A successful 12/12 SRI check is not a blanket npm `license_ready` or legal compatibility conclusion.

The old seed's general “no SRI-to-source-byte binding” note describes the evidence available when it was authored; retain it unchanged. In the assembled current evidence, cite this bridge plus the separate verified tarball receipt as its dated supplement rather than editing history.
