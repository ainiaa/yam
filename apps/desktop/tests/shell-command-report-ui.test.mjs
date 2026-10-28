import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Actual App renderFrame callbacks; native DOM rendering remains separate.
import {test} from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync as rawReadFileSync} from 'node:fs';
import * as frameHelpers from '../src/terminal-frame.ts';import {createTerminalScroll} from '../src/terminal-scroll.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let fn;function scan(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='renderFrame')fn=n.getText(source);ts.forEachChild(n,scan)}scan(source);
function fixture(){
 let release,changes=0;const ownerConnectionAvailable={current:{version:1,available:true}},terminalMounted={current:true};
 const view={instance:{},element:{inert:false},desktopGeneration:1,attachVersion:1,lifecycleRevision:1,viewportRevision:0,frameRevision:-1,frameInstance:null,live:true,ready:false,disposed:false,moving:false,reportedCwd:null,reportedCwdSequence:-1,reportedCommand:null,reportedCommandSequence:-1,reportedCommandPair:null};
 const pool=new Map([['one',view]]);const args={...frameHelpers,createTerminalScroll,ownerConnectionAvailable,terminalMounted,terminalViews:{current:{get:id=>pool.get(id),setRunning(){}}},refreshTerminalScroll(){},terminalPaneVisible(){return true},setRecoveryRevision(){changes++},terminalStatuses:new Set(['stopped','failed','succeeded']),sessionId:{current:'one'},outputCursor:{current:null},setSessionStatus(){},setTerminalNotice(){},applyTerminalFrame:async()=>{if(release)await release.promise}};
 const run=new Function(...Object.keys(args),ts.transpileModule(fn+';return renderFrame',{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText)(...Object.values(args));
 const frame=(sequence,phase='complete',last_exit=7,revision=sequence+1)=>({projection:{version:1,instance:'a'.repeat(64),session:'one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision,data:'screen',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'},status:'running',end_offset:1,reported_command:{sequence,phase,last_exit}});
 return {view,pool,frame,run,ownerConnectionAvailable,changes:()=>changes,fail(){release={promise:Promise.reject(Error("parser unavailable"))};},delay(){let done;release={promise:new Promise(r=>done=r)};return done;}};
}
test('A07c1 actual App accepts command report after projection and keeps highwater through missing/conflicting/lower reports',async()=>{
 const f=fixture();await f.run(f.view,'one',f.frame(3),1);assert.deepEqual(f.view.reportedCommand,{sequence:3,phase:'complete',last_exit:7});
 const changes=f.changes();await f.run(f.view,'one',f.frame(3),1);assert.equal(f.changes(),changes);
 let missing=f.frame(4);delete missing.reported_command;await f.run(f.view,'one',missing,1);assert.equal(f.view.reportedCommand,null);assert.equal(f.view.reportedCommandSequence,3);
 await f.run(f.view,'one',f.frame(2,'complete',9,6),1);assert.equal(f.view.reportedCommand,null);
 await f.run(f.view,'one',f.frame(3,'complete',8,7),1);assert.equal(f.view.reportedCommand,null);
 await f.run(f.view,'one',f.frame(4,'prompt',7,8),1);assert.equal(f.view.reportedCommand.phase,'prompt');
 let ended=f.frame(5,"complete",7,9);ended.status='stopped';await f.run(f.view,'one',ended,1);assert.equal(f.view.reportedCommand,null);
});
for(const change of ['attachment','generation','connection','dispose','replacement','lifecycle','moving'])test('A07c1 late actual App callback rejects '+change,async()=>{
 const f=fixture(),done=f.delay();const pending=f.run(f.view,'one',f.frame(1),1);
 if(change==='attachment')f.view.attachVersion++;if(change==='generation')f.view.desktopGeneration++;if(change==='connection')f.ownerConnectionAvailable.current.version++;if(change==='dispose')f.view.disposed=true;if(change==='replacement')f.pool.set('one',{});if(change==='lifecycle')f.view.lifecycleRevision++;if(change==='moving')f.view.moving=true;
 done();await pending;assert.equal(f.view.reportedCommand,null);assert.equal(f.view.reportedCommandSequence,-1);
});

test('A07c1 actual App same-sequence cannot revive missing or conflicting metadata and cold/nonordinary scenes clear',async()=>{
 const f=fixture();await f.run(f.view,'one',f.frame(3),1);let missing=f.frame(4);delete missing.reported_command;await f.run(f.view,'one',missing,1);await f.run(f.view,'one',f.frame(3,'complete',7,6),1);assert.equal(f.view.reportedCommand,null);
 await f.run(f.view,'one',f.frame(4,'complete',7,7),1);f.view.record={summary:{ssh:{host:'remote'}}};await f.run(f.view,'one',f.frame(5,'complete',0,8),1);assert.equal(f.view.reportedCommand,null);
 delete f.view.record;let persisted=f.frame(6,'complete',0,9);persisted.persisted=true;persisted.status='stopped';await f.run(f.view,'one',persisted,1);assert.equal(f.view.reportedCommand,null);
});

test('A07c1 actual parser failure clears prior command display without fabricating a newer report',async()=>{
 const f=fixture();await f.run(f.view,'one',f.frame(3),1);f.fail();await assert.rejects(f.run(f.view,'one',f.frame(4),1),/parser unavailable/);assert.equal(f.view.reportedCommand,null);assert.equal(f.view.reportedCommandSequence,3);
});
