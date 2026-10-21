// Author: Jeff.Liu. A clean checkout must satisfy the same prerequisites as local tests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

const root=new URL('../../../',import.meta.url);
test('CI generates native permission schemas before frontend tests in every platform job',()=>{
 const workflow=readFileSync(new URL('.github/workflows/ci.yml',root),'utf8');
 const runtime=workflow.indexOf('- run: pnpm build:terminal');
 const schema=workflow.indexOf('- run: cargo check --manifest-path src-tauri/Cargo.toml --locked');
 const tests=workflow.indexOf('- run: pnpm test:coverage');
 assert.ok(runtime>=0&&schema>runtime&&tests>schema,'build runtime and native schema before frontend tests');
 assert.equal(workflow.match(/- run: pnpm build:terminal/g)?.length,1,'build runtime once');
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
