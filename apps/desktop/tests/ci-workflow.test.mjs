// Author: Jeff.Liu. A clean checkout must satisfy the same prerequisites as local tests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {test} from 'node:test';

const root=new URL('../../../',import.meta.url);
function ciJob(name){
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8').replace(/\r\n/g,'\n');
 const marker=`\n  ${name}:\n`,start=workflow.indexOf(marker);
 assert.ok(start>=0,`missing CI job ${name}`);
 return workflow.slice(start+marker.length).split(/\n  [a-z][a-z-]*:\n/,1)[0];
}
test('desktop links only a Rust library and keeps local debug profiles unchanged',()=>{
 const manifest=readFileSync(new URL('apps/desktop/src-tauri/Cargo.toml',root),'utf8');
 const library=manifest.split('[lib]')[1]?.split(/\n\[/,1)[0];
 assert.match(library,/^crate-type = \["rlib"\]$/m);
 assert.doesNotMatch(manifest,/^\[profile\.(dev|test)(\.|\])/m);
});
test('only CI lowers dev and test debug information while preserving line tables',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 const environment=workflow.split(/^env:\n/m)[1]?.split(/^\S/m,1)[0];
 assert.ok(environment,'workflow-wide environment must reach every Cargo invocation');
 for(const profile of ['DEV','TEST'])assert.match(environment,new RegExp(`^  CARGO_PROFILE_${profile}_DEBUG: line-tables-only$`,'m'));
 assert.doesNotMatch(workflow,/CARGO_PROFILE_(?:DEV|TEST)_DEBUG: (?:0|false|none)|-C\s*debuginfo=0/);
});
test('CI generates native permission schemas before macOS frontend tests',()=>{
 const workflow=ciJob('frontend');
 const runtime=workflow.indexOf('- run: pnpm build:terminal');
 const schema=workflow.indexOf('- run: cargo check --manifest-path src-tauri/Cargo.toml --locked');
 const tests=workflow.indexOf('- run: pnpm test:coverage');
 assert.ok(runtime>=0&&schema>runtime&&tests>schema,'build runtime and native schema before frontend tests');
 assert.equal(workflow.match(/- run: pnpm build:terminal\r?\n/g)?.length,1,'build the native fixture runtime once');
 assert.equal(workflow.match(/- run: pnpm build:terminal --script-only --notice-mode developer\r?\n/g)?.length,1,'build the configured app script once');
 assert.ok(workflow.indexOf('- run: pnpm build:terminal --script-only')<schema,'script resources must exist before native schema generation');
 const step=workflow.slice(workflow.lastIndexOf('\n      -',schema),workflow.indexOf('\n      -',schema+1));
 assert.doesNotMatch(step,/\bif:/,'all CI platforms need their native schema');
});
test('Windows checkout keeps inspected Rust source LF and upstream notice bytes unconverted',()=>{
 const result=execFileSync('git',['check-attr','text','eol','--','apps/desktop/src-tauri/src/system_entry.rs','apps/desktop/src-tauri/src/lib.rs','scripts/third-party-notices/bodies/fixture'],{cwd:root,encoding:'utf8'});
 for(const file of ['system_entry.rs','lib.rs'])assert.match(result,new RegExp(file.replace('.','\\.')+': eol: lf'));
 assert.match(result,/bodies\/fixture: text: unset/);
});

test('CI pins a supported Python before checksum-bound runtime preparation',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 const python=workflow.indexOf('uses: actions/setup-python@v5');
 assert.ok(python>=0&&python<workflow.indexOf('- run: pnpm build:terminal'));
 assert.match(workflow.slice(python,workflow.indexOf('      - ',python)),/python-version: ['"]3\.12['"]/);
 for(const file of ['apps/desktop/src-tauri/Cargo.lock','apps/desktop/pnpm-lock.yaml']){
  const attrs=execFileSync('git',['check-attr','eol','--',file],{cwd:root,encoding:'utf8'});
  assert.match(attrs,/: eol: lf/,'hash-bound lockfile bytes must not change with Windows autocrlf');
 }
});

test('CI uses the validated Rust toolchain while retaining strict platform linting',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 assert.match(workflow,/uses: dtolnay\/rust-toolchain@1\.98\.1/);
 assert.match(workflow,/cargo clippy --manifest-path src-tauri\/Cargo.toml --all-targets -- -D warnings/);
 assert.doesNotMatch(workflow,/RUSTFLAGS:.*allow|clippy.*-A /);
});

test('MSVC test executables receive the same Common Controls v6 manifest as the application',()=>{
 const build=readFileSync(new URL('apps/desktop/src-tauri/build.rs',root),'utf8');
 const xml=readFileSync(new URL('apps/desktop/src-tauri/windows-app-manifest.xml',root),'utf8');
 assert.match(build,/CARGO_CFG_TARGET_OS/);assert.match(build,/CARGO_CFG_TARGET_ENV/);
 assert.match(build,/new_without_app_manifest/);
 assert.match(build,/cargo:rustc-link-arg=\/MANIFEST:EMBED/);
 assert.match(build,/cargo:rustc-link-arg=\/MANIFESTINPUT:/);
 assert.match(xml,/Microsoft\.Windows\.Common-Controls/);assert.match(xml,/version="6\.0\.0\.0"/);
});

test('CI supports macOS only while retaining coverage and package lifecycle checks',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 assert.match(workflow,/runs-on: macos-latest/);
 assert.doesNotMatch(workflow,/ubuntu-|windows-latest|matrix\.|apt-get|xvfb|--bundles nsis|--bundles deb/);
 for(const command of ['pnpm test:coverage','cargo llvm-cov --manifest-path','--fail-under-lines=85','--bundles app','background-platform-smoke.py --desktop','codesign --force --deep'])assert.ok(workflow.includes(command),command);
});
test('CI runs PRs once and cancels superseded checks',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8').replace(/\r\n/g,'\n');
 assert.match(workflow,/on:\n  push:\n    branches: \[main\]\n  pull_request:/);
 assert.match(workflow,/concurrency:[\s\S]*group:.*github\.event\.pull_request\.number.*github\.ref/);
 assert.match(workflow,/cancel-in-progress: true/);
});

test('native CI gives cold builds enough time and selects the Zsh fixture environment',()=>{const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');assert.match(workflow,/timeout-minutes: 45/);assert.match(workflow,/SHELL=\/bin\/zsh/);});

test('macOS cleanup fixture helper chain is compiled only where cleanup is supported',()=>{
 const source=readFileSync(new URL('apps/desktop/src-tauri/src/worktree_manager.rs',root),'utf8');
 for(const name of ['cleanup_preview','native_attribute_fixture','assert_native_attribute_cleanup']){
  assert.match(source,new RegExp('#\\[cfg\\(target_os = "macos"\\)\\]\\s+fn '+name+'\\('));
 }
});

test('macOS cleanup inert child and fault state share the test platform boundary',()=>{
 const source=readFileSync(new URL('apps/desktop/src-tauri/src/worktree_manager.rs',root),'utf8');
 for(const declaration of ['struct InertChild;','impl portable_pty::ChildKiller for InertChild','impl portable_pty::Child for InertChild','fn inert_session(']){
  const offset=source.indexOf(declaration);assert.ok(offset>0);
  assert.match(source.slice(Math.max(0,offset-100),offset),/#\[cfg\(target_os = "macos"\)\]/,declaration);
 }
 for(const declaration of ['enum CleanupFault','type CleanupAction','thread_local! {static CLEANUP_FAULT']){
  const offset=source.indexOf(declaration);assert.ok(offset>0);
  assert.match(source.slice(Math.max(0,offset-100),offset),/#\[cfg\(all\(test, target_os = "macos"\)\)\]/,declaration);
 }
});

test('impact selection covers the complete PR and full jobs depend on the plan',()=>{
 const plan=ciJob('plan');
 assert.match(plan,/fetch-depth: 0/);
 assert.ok(plan.includes('BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
 assert.ok(plan.includes('HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
 assert.ok(plan.includes('EVENT_NAME: ${{ github.event_name }}'));
 assert.match(plan,/python3 -m unittest scripts.test_ci_impact -v/);
 assert.match(plan,/python3 scripts\/ci_impact.py plan/);
 for(const name of ['frontend','native']){
  const job=ciJob(name);assert.match(job,/needs: \[plan\]/);
  assert.ok(job.includes("if: ${{ needs.plan.outputs.route == 'full' }}"));
 }
});
test('quick checks use only mapped fixtures and never bootstrap native builds or GUI',()=>{
 const quick=ciJob('quick');
 assert.match(quick,/needs: \[plan\]/);
 assert.ok(quick.includes("needs.plan.outputs.route == 'quick' || needs.plan.outputs.exercise_quick == 'true'"));
 assert.match(quick,/pnpm install --frozen-lockfile/);
 assert.doesNotMatch(quick,/pnpm build|build:terminal/);
 assert.match(quick,/python3 -m unittest scripts.test_loopback_fixtures scripts.test_terminal_latency_probe -v/);
 assert.doesNotMatch(quick,/cargo|rust-toolchain|swiftc|webkit-memory-smoke.py|background-platform-smoke|memory-self-smoke.py|upload-artifact/);
});
test('desktop always validates the selected route and all corresponding job results',()=>{
 const gate=ciJob('desktop');
 assert.match(gate,/needs: \[plan, quick, frontend, native, package\]/);
 assert.match(gate,/if: \$\{\{ always\(\) \}\}/);
 assert.match(gate,/python3 scripts\/ci_impact.py gate/);
 for(const name of ['plan','quick','frontend','native','package'])assert.ok(gate.includes(`${name.toUpperCase()}_RESULT: \${{ needs.${name}.result }}`));
 assert.ok(gate.includes('ROUTE: ${{ needs.plan.outputs.route }}'));
 assert.ok(gate.includes('EXERCISE_QUICK: ${{ needs.plan.outputs.exercise_quick }}'));
 for(const name of ['plan','quick','frontend','native','package','desktop'])assert.doesNotMatch(ciJob(name),/continue-on-error: true/);
 assert.ok(ciJob('package').includes('name: yam-test-package-macos-${{ github.run_attempt }}'));
});
test('native coverage runs the full suite once with ordinary cfg semantics and preserves normal linting',()=>{
 const native=ciJob('native');
 assert.equal(native.match(/run: cargo llvm-cov --manifest-path/g)?.length,1);
 assert.match(native,/--locked --no-cfg-coverage --fail-under-lines=85 -- --test-threads=2/);
 assert.doesNotMatch(native,/run: cargo test|--no-run|--no-clean|--ignore-filename-regex|--exclude|--lib\b|--test-name-pattern/);
 assert.match(native,/cargo clippy --manifest-path src-tauri\/Cargo.toml --all-targets -- -D warnings/);
 assert.ok(ciJob('frontend').includes('cargo check --manifest-path'));
 assert.ok(ciJob('package').includes('cargo test --doc --manifest-path src-tauri/Cargo.toml --locked'));
});
test('both CI workers prepare native resources and cache only reusable compilation outputs',()=>{
 for(const name of ['frontend','native']){
  const job=ciJob(name);
  for(const command of ['pnpm install --frozen-lockfile','pnpm build:terminal','pnpm build:terminal --script-only --notice-mode developer'])assert.ok(job.includes(command),`${name}: ${command}`);
  assert.ok(job.indexOf('pnpm build:terminal --script-only')<job.indexOf(name==='frontend'?'cargo check':'cargo fmt'));
  assert.match(job,/actions\/cache@v4/);assert.match(job,/runner.os/);assert.match(job,/runner.arch/);assert.match(job,/1.98.1/);assert.match(job,/Cargo.lock/);assert.match(job,/-v3-lines-/);
  assert.match(job,/target\/debug\/deps/);assert.doesNotMatch(job,/path:.*\.cargo\s*$/m);
 }
 const native=ciJob('native');
 assert.match(native,/target\/coverage\/debug\/deps/);
 const cache=native.slice(native.indexOf('      - name: Restore Rust compilation cache'),native.indexOf('      - name: Select native shell'));
 assert.doesNotMatch(cache,/^\s+.*target\/coverage\s*$/m);
 assert.ok(native.includes('test "$(cargo llvm-cov --version)" = "cargo-llvm-cov 0.9.1"'));
});

test('superseded packaging remains cancellable and the final desktop gate cannot mask its result',()=>{
 const packaged=ciJob('package'),gate=ciJob('desktop');
 assert.match(packaged,/needs: \[plan, frontend, native\]/);
 assert.ok(packaged.includes("!cancelled() && needs.plan.result == 'success' && needs.plan.outputs.route == 'full' && needs.frontend.result == 'success' && needs.native.result == 'success'"));
 assert.doesNotMatch(packaged,/always\(\)/);
 assert.match(gate,/PACKAGE_RESULT: \$\{\{ needs.package.result \}\}/);
 assert.doesNotMatch(gate,/pnpm|cargo|upload-artifact/,'the always-running gate must remain short');
 assert.match(gate,/timeout-minutes: 2/);
});
test('native self-sampling stays beside the freshly executed coverage test binary',()=>{
 const native=ciJob('native'),frontend=ciJob('frontend');
 assert.doesNotMatch(frontend,/memory-self-smoke.py/);
 assert.ok(native.indexOf('memory-self-smoke.py')>native.indexOf('cargo llvm-cov --manifest-path'));
 assert.match(native,/^    env:\n      CARGO_LLVM_COV_TARGET_DIR:.*target\/coverage/m);
 assert.match(frontend,/scripts.test_memory_self_smoke/,'fixture selection must be tested without starting an application');
});

test('Rust caches follow build inputs and avoid saving the same dependencies for every commit',()=>{
 for(const name of ['frontend','native','package']){
  const job=ciJob(name),cache=job.slice(job.indexOf('      - name: Restore Rust compilation cache'),job.indexOf('      - name: Select native shell'));
  const key=cache.match(/^\s+key: (.*)$/m)?.[1];assert.ok(key);
  assert.match(key,/-v3-lines-/);assert.match(key,/Cargo.lock/);assert.match(key,/Cargo.toml/);assert.match(key,/config.toml/);
  assert.doesNotMatch(key,/github.sha|workflows\/ci.yml/);
  assert.ok(cache.includes(`\${{ runner.os }}-\${{ runner.arch }}-rust-1.98.1-${name}-v3-lines-`),'restore previously validated dependency outputs, then let Cargo check fingerprints');
 }
});
