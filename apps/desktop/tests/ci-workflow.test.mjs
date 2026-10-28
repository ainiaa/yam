// Author: Jeff.Liu. A clean checkout must satisfy the same prerequisites as local tests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

const root=new URL('../../../',import.meta.url);
test('CI generates native permission schemas before macOS frontend tests',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
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
 for(const command of ['pnpm test:coverage','cargo test --manifest-path','cargo llvm-cov --manifest-path','--fail-under-lines=85','--bundles app','background-platform-smoke.py --desktop','codesign --force --deep'])assert.ok(workflow.includes(command),command);
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
