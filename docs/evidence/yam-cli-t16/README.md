# T16 finite CLI evidence

Author: Jeff.Liu.

The [CLI contract](../../yam-cli.md) is implemented through the existing authenticated background channel. The same executable has a non-UI parser, fixed metadata/error DTOs, one-send Start with an owner-lifetime request key, read-only queries, an existing Stop path and desktop-local queued Focus. No AppBuilder, dependency, listener, App change or generic RPC framework was added. Native three-platform packaged acceptance remains pending.

## Candidate and checks

code-freeze.json（原始文件已归档） contains the four frozen Rust paths and SHA256 values. validation.json（原始文件已归档） records the exact seven sequential commands, elapsed times, exits and source hashes. All seven exited 0: Rust378passed/2ignored (76.26s test execution;84.689s command wall), frontend252passed, Python80passed, standard frontend build, fmt, clippy with denied warnings and diff check. Python and SEA/frontend builds ran sequentially. The four prohibited early `tsc -b` outputs remain absent.

Frontend utility coverage was100% lines/functions and95.08% branches; it does not measure React or Rust. The two ignored native fixtures did not execute. These are actual author checks; the independent Root/Astra second-candidate results are recorded separately below. Formal provider coverage/gates were not executed or substituted with model review.

## Test-first receipts

| Stage | Actual observation | Receipt |
| --- | --- | --- |
| Initial parser/prompt/DTO/cache/focus scaffold |16tests:6directgreen/10semantic failures, compiled and executed |initial red（原始文件已归档） |
| Client wire, entry, owner boundary and process group |25tests:16pass/9semantic failures before wiring |entry red（原始文件已归档） |
| Native directory and actual readonly sender |30tests:27pass/3semantic failures |path red（原始文件已归档） |
| Owner namespace, concurrent wire and shared focus |36tests:30pass/6semantic failures |namespace red（原始文件已归档） |
| Final caller-cwd and replacement no-send cases |38/38passed; the last two were directgreen verification of existing sender behavior |final targeted（原始文件已归档） |
| Existing GUI wire behavior |37/37passed, including original framing/identity and exact-wire retry assertions |wire regression（原始文件已归档） |

The actual256-entry refusal assertion was reached after the cache implementation; it is not inferred from the initial fixed-error scaffold. Same-key sequential and concurrent authenticated fresh-client fixtures prove one allocation within one owner lifetime. Replacement keys fail before sending Start; absent namespace reports the fixed compatibility class. DTO tests execute real shared owner bodies and exclude stored prompt/command/environment/credential fields. Allocation-marker tests exercise actual owner preflight ordering but return before native allocation; they are not real PTY/Agent acceptance. Unix process-group tests spawn only a harmless owned fixture and kill/wait only that PID.

Import/compiler/fixture setup failures remain in their harness logs and are not counted as semantic product red. Root's second-red source drift guard failed while two entry tests were added; that receipt is a verification-boundary failure. The subsequent third-red same-source independent run is the valid25-test proof. Original point-in-time logs are preserved.

Root stage receipts（原始文件已归档） and additional receipts（原始文件已归档） preserve the independent red runs and controlled native-path/key-context amendments. D11 is an implementation contract decision: a public random namespace separate from credentials, initialized once, authenticated and exposed in status, with no durable lifetime ledger or replacement retry.

## Harmless executable boundary

Debug entry green（原始文件已归档） runs the debug executable with only invalid UTF-8 and unknown arguments. Both returned2, empty stdout and exactly`invalid_arguments`; the prior real panic is retained in debug entry red（原始文件已归档）. These arguments abort before native-directory discovery, owner or GUI launch. Debug build（原始文件已归档） succeeded. This is not packaged application stdout or GUI/Agent acceptance.

## Limits

No real user namespace, owner, Agent, GUI, Hook, permission, performance-validation package or its populated data was used. Windows/Linux native path APIs and packaged console output have not run on their platforms. Windows GUI subsystem settings are unchanged. Focus`queued` is accepted relay delivery, not confirmed native window focus; disconnect races do not start a GUI. Status/List/Show do not poll desktop events or mutate notification/input context. Existing T09/T13 preflight and backend input authority remain in their pipelines. Events/T17 and T15 cross-reopen restore are outside this stage.

## Independent review and fixture isolation

The first frozen source hashes matched both independent reviewers. Root observed36pass/2fail and Astra37pass/1fail because test roots used a millisecond session ID plus a process-local counter without a PID. Concurrent cargo processes could therefore share a root, and the production owner lock correctly refused it. Their original actual101 logs and first candidate freeze/checks remain in first-candidate（原始文件已归档）. This was a test isolation failure; no production bypass was added.

Only seven T16 test-root formats changed to include the process PID. Two concurrent independent cargo processes each passed38/38 (1.93s and1.91s execution); concurrent receipt（原始文件已归档） records both runs. A temporary private-helper scope compile failure is retained as harness evidence, not semantic red. Root then independently passed38/38 in1.90s execution, with four source hashes unchanged before/after; root frozen receipt（原始文件已归档） is separate from author checks. Astra independently passed38/38 in1.91s execution and verified four source hashes plus precisely seven test-only PID path edits with unchanged business/oracles; Astra final receipt（原始文件已归档） preserves the raw proof. Finite review found no confirmed remaining P0/P1/P2. Author second-source Rust378passed/2ignored (74.40s execution/75.319s wall), fmt0.213s, clippy1.746s and diff0.019s all exited0. Node/Python/frontend-build receipts remain actual same-input first-candidate checks and are not claimed as reruns.


## Final seal

The second source freeze remains unchanged. End receipt（原始文件已归档）, document/integrity check（原始文件已归档） and evidence index（原始文件已归档） record the finite source/docs/artifacts; the index excludes its own hash. First-candidate history and actual failure logs remain untouched. Final sealing completes host code/evidence review only; native three-platform and official provider gates remain pending.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
