# T18 npm lock/source seed review

Author: Jeff.Liu
Status: read-only seed and evidence-limit review for Root. No source or lock files were modified. No network request, dependency resolution, source fetch, Cargo build, or SEA build was run.

## Seed and bound inputs

`/tmp/yam-t18-npm-lock-seed.json` is the 12-identity npm seed. SHA-256: `feab5c9b375421b8c27e853f7232a37b4993097efef6982e757d6cd32224cc77` (31,024 bytes).

- Current `apps/desktop/pnpm-lock.yaml` full SHA-256: `e17abb847e2c95b7ad8965ee8d08daa26338a74d0774369385a5498961b6b48a`; lockfileVersion 9.0. Seed includes 12 literal package-resolution raw blocks, each with byte range and fragment SHA-256, for Root to independently rehash against this whole-file digest. The blocks were manually inspected from narrow `rtk rg` excerpts. This is not a general YAML parser or a claim that all of YAML was parsed.
- Current `apps/desktop/package.json` SHA-256: `c81c4b949dc573658f1a4e6149bd2b29b9213a7dafe8629b1e1ca1ee84824d0e`. Canonical SHA-256 of compact, recursively key-sorted UTF-8 JSON for exactly `{dependencies, optionalDependencies}`: `97a26697e985746ddbfafef6c2229b71263aeddb2b622633fa6a1464f761faeb`. This captures 11 direct declarations and zero optional direct declarations; `scheduler` is transitive under `react-dom`.
- Ran the requested installed graph command with `pnpm 9.15.1`: `pnpm list --prod --depth Infinity --json`. It exited 0 in under one second. A bounded stream reader enforced the 30-second deadline and 16 MiB combined stdout/stderr cap. Captured stdout was 5,948 bytes, stderr 0; stdout SHA-256 `75153ea9e2b63d2f6711d6cf7324ff68914a7713b23a78d89d601d1cf1f67226`. The graph contains exactly the expected 12 unique `(name, version)` identities, with `scheduler@0.28.0` physically under its pnpm package path and reached from `react-dom`. Raw graph text is intentionally omitted; the seed retains the bounded digest and sanitized identity/path summary.

The 12 frozen identities are: `@tauri-apps/api@2.12.0`, `@tauri-apps/plugin-deep-link@2.6.1`, `@tauri-apps/plugin-dialog@2.8.1`, `@tauri-apps/plugin-opener@2.7.0`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-serialize@0.14.0`, `@xterm/headless@6.0.0`, `@xterm/xterm@6.0.0`, `lucide-react@0.468.0(react@19.3.0)`, `react@19.3.0`, `react-dom@19.3.0(react@19.3.0)`, and `scheduler@0.28.0`.

## Source/body evidence carried into the seed

- Installed package name/version, `package.json` hashes, license expressions and repository URLs are captured for all 12. Original LICENSE body hashes and paths are captured for the current complete-text candidates. React/React DOM/scheduler point at byte-identical MIT body hashes; Xterm headless/serializer retain the existing shared Xterm attribution body mapping. The two plugin gaps retain their SPDX-only file/hash as metadata, not license text.
- `@tauri-apps/plugin-dialog` preserves the prior immutable Tauri plugins-workspace revision `d4835d0e947179bac24a383212792d74be3ebe4f` and both full-text license body hashes/paths. The existing npm packument receipt `/tmp/yam-notices-primary/tauri-dialog__2.8.1__npm.json` records its registry tarball URL, `gitHead`, and `dist.integrity`; that integrity equals the lock SRI. The actual `.tgz` bytes were not read or rehashed.
- Two full-text gaps remain explicit: `@tauri-apps/plugin-deep-link@2.6.1` and `@tauri-apps/plugin-opener@2.7.0`. Their installed artifacts have only the shared 888-byte `LICENSE.spdx` declaration blob.

## Proof limits that must survive Root review

The pnpm v9 lock entries record `resolution.integrity` but do not carry `resolution.tarball`. The seed therefore labels the URL value for 11 identities as a canonical npm-registry URL candidate derived from package name/version; this is not an observed lock fact. Plugin-dialog alone has a prior packument-recorded `dist.tarball` URL. Repository URLs are copied from installed `package.json` metadata and are mutable repository locations, not immutable npm release URLs.

For all 12 packages, no reviewed receipt independently hashes registry tarball bytes against the lock SRI and binds those same bytes to the installed LICENSE body. The pnpm `list` graph, installed package metadata hash, matching package name/version, repository field, and packument integrity metadata are corroboration only; none is stamped as SRI-to-source verification. Keep this as an additional provenance gap in the report/release decision even for entries with full-text candidate bodies. No SRI source verification or `license_ready` state is asserted in the seed.

Root should rehash the seed, the 12 included lock snippets, full lock/package digests, and all source body hashes before incorporating it. Re-run the bounded local pnpm graph only if an independently verifiable raw graph receipt is required; do not use a resolved path or repository URL as a substitute for tarball-byte evidence.
