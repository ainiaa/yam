import {englishUiRead} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import {terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation} from '../src/terminal-frame.ts';
import assert from 'node:assert/strict';import {test} from 'node:test';import fs from 'node:fs';import ts from 'typescript';
const source=englishUiRead(fs.readFileSync,new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(name,bindings){let text;function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)text=n.getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(text);return new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(bindings));}
test('A06 actual polling permits search-owned selection and pauses manual selection',async()=>{
 for(const manual of [false,true]){let calls=0;const view={projection:true,dirty:true,instance:{hasSelection:()=>true},find:{blocksProjection:()=>manual},frameInstance:'a',viewportRevision:0,attachVersion:0};const poll=actual('pollTerminalFrames',{terminalPaneVisible:()=>true,terminalMounted:{current:true},document:{hidden:false},terminalLayoutRef:{current:{panes:['s-a']}},terminalViews:{current:{get:()=>view}},invoke:async()=>{calls++;return null;},renderFrame:()=>{}});poll();await Promise.resolve();await Promise.resolve();assert.equal(calls,manual?0:1);}
});
test('A06 actual parsed frame invalidates find before reset and refreshes after current identity',async()=>{
 const events=[],view={instance:{},frameRevision:1,frameInstance:'owner',ready:true,live:true,disposed:false,lifecycleRevision:0,viewportRevision:3,element:{},find:{beforeFrame:()=>events.push('before'),afterFrame:async current=>{assert.equal(current(),true);events.push('after');}}};let release,valid=true;
 const render=actual('renderFrame',{terminalMounted:{current:true},ownerConnectionAvailable:{current:{version:0}},terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,validateTerminalFrame:()=>{},applyTerminalFrame:()=>{events.push('reset');return new Promise(r=>release=r);},setRecoveryRevision:()=>{},terminalStatuses:new Set(),createTerminalScroll:()=>({}),refreshTerminalScroll:()=>{},terminalPaneVisible:()=>true,terminalViews:{current:{get:id=>id==='s-a'?view:undefined,setRunning:()=>{}}},sessionId:{current:null},outputCursor:{current:null},setSessionStatus:()=>{},setTerminalNotice:()=>{}});
 const frame={projection:{revision:2,instance:'owner'},status:'running',end_offset:9};const pending=render(view,'s-a',frame,0,()=>valid);assert.deepEqual(events,['before','reset']);release();await pending;assert.deepEqual(events,['before','reset','after']);assert.equal(view.frameRevision,2);
 events.length=0;await render(view,'s-a',frame,0,()=>valid);assert.deepEqual(events,[],'Unchanged frames do not reset find');
 frame.projection.revision=3;const stale=render(view,'s-a',frame,0,()=>valid);valid=false;release();await stale;assert.deepEqual(events,['before','reset']);
});
