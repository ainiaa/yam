import {sessionActionBindings} from './fixtures/session-action-bindings.mjs';
import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. External views attach to exactly one existing managed launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(bindings){bindings={...sessionActionBindings(),...bindings};let fn;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='startNewSession')fn=n;ts.forEachChild(n,visit);}visit(source);return new Function(...Object.keys(bindings),ts.transpile(fn.getText(source),{target:ts.ScriptTarget.ES2022})+';return startNewSession;')(...Object.values(bindings));}
function fixture(terminal='iterm2',result={session_id:'s-1-2',launch:null}){
 const calls=[],errors=[];return {calls,errors,start:actual({sessionTerminal:terminal,isMainWindow:true,formAdapter:'shell',formLaunch:{command:null,provider:null},useProjectSettings:false,launchWorktreeAttempt:undefined,launchDirectoryOverride:'/fixture',launchTerminalProfile:undefined,newTerminal:async(...args)=>{calls.push(['start',...args]);return result;},invoke:async(name,args)=>{calls.push([name,args]);if(terminal==='failed')throw Error('SECRET');},setLaunchWorktreeAttempt(){},localStorage:{setItem(){}},setError:e=>errors.push(e)})};
}
test('external selection creates once through the unchanged profile launcher then attaches to that exact ID',async()=>{
 const f=fixture();await f.start();assert.deepEqual(f.calls,[['start','/fixture',undefined],['open_external_terminal',{sessionId:'s-1-2',terminal:'iterm2'}]]);assert.deepEqual(f.errors,[]);
});
test('YAM selection and failed session creation never invoke the external launcher',async()=>{
 for(const f of [fixture('yam'),fixture('iterm2',null)]){await f.start();assert.equal(f.calls.length,1);}
});
test('external open failure keeps the original managed session and reports a safe fallback',async()=>{
 const f=fixture('failed');await f.start();assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.match(f.errors.join(' '),/session.*YAM/i);assert.doesNotMatch(f.errors.join(' '),/SECRET/);
});
test('new session offers an external terminal selector without replacing the startup program',()=>{
 assert.match(source.text,/aria-label="Open session in"/);assert.match(source.text,/aria-label="Startup program"/);assert.match(source.text,/list_external_terminals/);
});
