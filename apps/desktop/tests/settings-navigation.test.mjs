import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Exercise the actual cross-window settings seam.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
test('secondary settings preserves the requested page in the native RPC',async()=>{
 const fn=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='openMainSettings'),calls=[];
 const run=new Function('invoke','setError',ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return openMainSettings;')((...v)=>{calls.push(v);return Promise.resolve();},assert.fail);
 for(const target of ['settings','profiles','keyboard-shortcuts','updates','paste-settings','system-entry'])run(target);
 assert.deepEqual(calls.map(x=>x[1]?.target),['settings','profiles','keyboard-shortcuts','updates','paste-settings','system-entry']);
});
test('the native settings bridge validates a finite target and retains epoch admission',()=>{const text=readFileSync(new URL('../src-tauri/src/desktop_windows.rs',import.meta.url),'utf8');const body=text.slice(text.indexOf('pub(super) fn open_main_settings'),text.indexOf('pub(super) fn set_agent_notification_context'));assert.match(body,/target:/);assert.match(body,/settings_target/);assert.match(body,/desktop_epoch/);assert.doesNotMatch(body,/"terminal-main-settings", \(\)/);});
