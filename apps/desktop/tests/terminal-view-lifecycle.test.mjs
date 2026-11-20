// Author: Jeff.Liu.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';

const lifecycle=await import('../src/terminal-view-lifecycle.ts');

test('terminal view construction preserves explicit dimensions and composes settings in order',()=>{
 const linkHandler={allowNonHttpProtocols:false,activate(){}};
 assert.deepEqual(lifecycle.terminalViewConstruction({scrollback:2000,lineHeight:1.2,
  cursor:{cursorStyle:'bar',cursorBlink:true},appearance:{theme:'dark',lineHeight:1.4},linkHandler}),
  {scrollback:2000,allowProposedApi:true,convertEol:true,cursorStyle:'bar',cursorBlink:true,lineHeight:1.4,theme:'dark',linkHandler});
});

test('terminal view teardown releases ownership before disposing parser and DOM resources',()=>{
 const calls=[];
 lifecycle.disposeTerminalViewParts(Object.fromEntries(['release','clearMetadata','disposeFind','markDisposed',
  'clearAttachment','finishReplay','disposeData','disposeScroll','disposeTerminal','removeElement']
  .map(name=>[name,()=>calls.push(name)])));
 assert.deepEqual(calls,['release','clearMetadata','disposeFind','markDisposed','clearAttachment',
  'finishReplay','disposeData','disposeScroll','disposeTerminal','removeElement']);
});

test('App terminal factory uses the lifecycle module for construction and teardown',async()=>{
 const {readFileSync}=await import('node:fs');
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/terminalViewConstruction\(/);
 assert.match(app,/disposeTerminalViewParts\(/);
 assert.doesNotMatch(app,/allowProposedApi:\s*true,\s*convertEol:\s*true/);
});

const replayView=()=>({replayVersion:0,ready:true,firstAttachment:true,disposed:false,finishReplay:null,parsing:null,
 instance:{reset(){},write(_data,done){this.complete=done;}}});

test('raw replay settles its predecessor and publishes readiness only after current parsing completes',async()=>{
 const view=replayView();let previous=0,ready=0;view.finishReplay=()=>previous++;
 const version=lifecycle.beginTerminalReplay(view);assert.equal(previous,1);assert.equal(view.ready,false);assert.equal(view.finishReplay,null);
 const parsing=lifecycle.parseTerminalReplay(view,version,'raw',()=>true,()=>ready++);
 assert.ok(view.parsing);assert.equal(ready,0);view.instance.complete();await parsing;
 assert.equal(view.ready,true);assert.equal(view.firstAttachment,false);assert.equal(view.finishReplay,null);assert.equal(view.parsing,null);assert.equal(ready,1);
});

test('obsolete, disposed and invalid raw replay completions cannot publish readiness or clear a newer parse',async()=>{
 for(const invalidate of [view=>view.replayVersion++,view=>view.disposed=true,()=>{}]){
  const view=replayView(),version=lifecycle.beginTerminalReplay(view);let valid=true,ready=0;
  const parsing=lifecycle.parseTerminalReplay(view,version,'',()=>valid,()=>ready++);invalidate(view);if(!view.disposed&&view.replayVersion===version)valid=false;
  const newer=Promise.resolve();view.parsing=newer;view.instance.complete();await parsing;
  assert.equal(view.ready,false);assert.equal(view.firstAttachment,true);assert.equal(ready,0);assert.equal(view.parsing,newer);
 }
});

test('raw replay parser failure propagates to the attachment error boundary',async()=>{
 const view=replayView();view.instance.write=()=>{throw Error('parse failed');};
 await assert.rejects(lifecycle.parseTerminalReplay(view,lifecycle.beginTerminalReplay(view),'',()=>true,()=>assert.fail('ready')),/parse failed/);
 assert.equal(view.ready,false);
});
