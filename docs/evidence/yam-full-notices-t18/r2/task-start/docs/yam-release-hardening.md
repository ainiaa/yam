# Desktop configuration hardening — T18 partial slice

Author: Jeff.Liu

This slice changes only Tauri CSP/capability configuration and Cargo package
metadata. Rust handlers, App/Vite/frontend code, plugin initialization, dependency
requirements/features, package version and Cargo.lock remain unchanged. It does
not complete release signing, licensing, notices or native security acceptance.

Production CSP has `default-src 'self'`, strict `script-src 'self'`, local IPC
`connect-src ipc: http://ipc.localhost`, self-only images/fonts, and no frames,
objects, base URL replacement or form submission. It adds no wildcard origin,
remote development host, script `unsafe-inline` or `unsafe-eval`. Existing Tauri
asset CSP modification remains enabled; its bundled hash/nonce handling is not
replaced by a new framework.

Production `style-src 'self' 'unsafe-inline'` is a limited compatibility choice:
the installed xterm6 DOM renderer and viewport create runtime style elements
without assigning nonces. This exception is for styles, not production scripts.
Actual native rendering, fonts and resulting CSP enforcement still require an
owned-package test.

A separate development CSP retains the same finite policy except that it allows
inline **development scripts** for the installed React Refresh inline module
preamble, and connects to the default localhost Vite/HMR endpoints1420/1421.
It allows no eval, wildcard websocket scheme or arbitrary remote host. Development
React script-inline and production xterm style-inline are separate exceptions.
Default localhost startup/HMR was not run during this configuration-only task.
For a developer-supplied `TAURI_DEV_HOST`, supply an explicit Tauri `--config`
override for `app.security.devCsp` with that exact trusted origin/ports. Vite is
unchanged; neither a custom-host launch nor its CSP compatibility is claimed.
Do not expand production CSP to accommodate development hosts.

The main-window capability grants only `core:event:allow-listen`,
`core:event:allow-unlisten` and `dialog:allow-open`, matching frontend event
subscriptions/disposers and the single-directory picker. It adds no remote
origins or additional windows/webviews. Removing unused `core:default`,
`opener:default` and `deep-link:default` is a consumer-based narrowing, not a claim
that the old defaults were a demonstrated vulnerability. Custom app commands
and Rust internal deep-link parsing/get-current/on-open routes are unchanged;
plugin bootstrap remains intact. Real dialog/listener/OS protocol acceptance
is pending.

Cargo authors is `Jeff.Liu`, with description `YAM desktop terminal workspace
for local agent sessions`. No SPDX license or rights-holder decision is inferred.
The approved Rust updater SDK stays at requirement2/resolved2.13.1 with the exact
same locked graph; updater registration/configuration/installation is not added.

All eight planned host checks ran: configuration8/8, Rust402passed/2ignored,
Node252passed, Python93passed, standard frontend build, fmt, locked clippy and
diff, all exit0. The finite source-set test oracle rejects invalid policy strings;
it does not emulate a browser or establish WebKit enforcement. Existing URI and
session-ID parser tests ran unchanged. Utility TypeScript coverage is100%lines/
functions and95.08%branches; it does not cover React/native enforcement.

Native WebKit startup, terminal styles/fonts, IPC/listeners/dialogs, rejected
unapproved scripts/resources, default/custom-host HMR and OS deep-link/unknown-ID
routing remain pending. No real GUI, user owner, Agent, signing, publication or
frozen T06 package/data was used. Third-party-notice completeness, project
license and three-platform release/install acceptance are outside this slice.
See [bounded evidence](evidence/yam-release-hardening-t18/README.md).

## Release CLI error rendering — T19 sourceflow partial slice

Author: Jeff.Liu. The release helper now reports fixed timeout, subprocess,
tool/file-operation and bundle/signature/notarization-rejection categories,
instead of formatting exception text containing arguments, identity/profile
values, paths or dynamic messages. Captured stdout/stderr non-disclosure is
preserved, not a reproduced prior stream leak. This rendering applies only to
operation exceptions caught by main; argparse diagnostics are unchanged.
Parser, exit status, success text, delivery ordering
and acceptance policy are unchanged. `check()` is verified by a mock to call
exactly codesign verify/details, stapler validate and spctl assessment; no signing,
identity lookup, submit/upload or staple call is included. This exact-sequence
assertion was direct-green on the original source, not a newly failing test.

Four actual main-error fixtures first failed on artificial nonsecret sentinels;
the repaired target suite passes10/10. The explicit host fixture wrapper runs97
cases:96pass and one named native runtime-build/codesign test skipped. That is
fixture-only validation, not unfiltered Python or native release acceptance.
Real certificate/profile readiness, Apple service, signed production stapling/
Gatekeeper and Windows/Linux signed-package/native install acceptance remain
blocked/excluded pending a separate authorized capable-machine run. Nothing is
signed, uploaded or published in this slice. See [sourceflow evidence](evidence/yam-release-sourceflow-t19/README.md).

## Five frontend notice sources — T18 partial follow-up

Author: Jeff.Liu. The existing runtime notice assembler now includes separate
package/version headings and original package-owned LICENSE bodies for react
19.3.0, react-dom19.3.0, lucide-react0.468.0, @xterm/xterm6.0.0 and
@xterm/addon-fit0.11.0. Versions are fixed against the recorded pnpm lock and
installed metadata; missing/mismatched metadata or invalid LICENSE sources fail
before SEA/final publication. Strict UTF-8 byte decoding and byte output preserve
original CRLF and whitespace. Node/headless/serializer source assembly remains.

Actual main fixtures use an isolated temporary repository, local synthetic
archive, denied URL access, mocked subprocesses and a non-Darwin target. Normal
and thirteen invalid-source subcases pass; filtered host fixtures run99 with
98pass and one explicit native runtime-build/codesign skip. The fixture checks
preexisting final binary/notices preservation, not a full builder transaction.
No real runtime build, download, signing, package or T06 asset was used.

Coverage is limited to these five direct frontend package texts. Tauri JS/API/
plugins, Cargo/Rust, transitive and full bundled inventory remain unresolved;
no project license or full notice-completeness claim is made. Actual packaged
resource/native visibility and release/install acceptance remain pending.
See [frontend notice evidence](evidence/yam-frontend-notices-t18/README.md).


## Offline notice gate (T18 source)

The [notice integrity inventory](THIRD_PARTY_NOTICES.md) and content-addressed original bodies replace sample/count-only readiness. Developer builds explicitly emit incomplete developer notices and a non-release-eligible report. Formal builds use a tiny release override and deny gaps, stale locks, unqualified or corrupt bodies, and missing Node aggregate material before runtime fetch/SEA. macOS check/deliver validates exact packaged notice/report/runtime bytes before signing or notarization tools. Reports publish last; mixed output after promotion failure is rejected, without claiming multi-file atomicity. Current real inventory has 515 gaps and is not release-ready. Unit fixtures use synthetic binaries and mocked native release tools; no signing, network collection, publication, or native packaged license acceptance ran.

Current R1 source candidate passed independent Root and Astra source reviews. The five fresh host checks and first-candidate failures are preserved in [T18 source evidence](evidence/yam-full-notices-t18/README.md). This closes the collector/render/release-gate source slice; 32 qualified identities and 515 material gaps remain, so full notices, legal and signed/native release readiness are not complete.
