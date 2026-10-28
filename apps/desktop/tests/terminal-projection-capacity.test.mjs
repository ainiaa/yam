import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {defaultTerminalLineHeight,parseTerminalLineHeight} from '../src/terminal-line-height.ts';
// Author: Jeff.Liu. Actual App factory and installed browser Terminal; DOM/open/Fit are finite fixture seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import * as frameModule from '../src/terminal-frame.ts';
import {terminalOptions,defaultTerminalSettings} from '../src/terminal-settings.ts';
import {terminalCursorOptions,defaultTerminalCursor} from '../src/terminal-cursor.ts';
const require=createRequire(import.meta.url),{Terminal:BrowserTerminal}=require('@xterm/xterm'),{Terminal:OwnerTerminal}=require('@xterm/headless'),{SerializeAddon}=require('@xterm/addon-serialize');
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let factory;
function walk(n){if(ts.isBinaryExpression(n)&&n.left.getText(source)==='createView.current'&&ts.isArrowFunction(n.right))factory=n.right.getText(source);ts.forEachChild(n,walk);}walk(source);assert.ok(factory);
function actualFactory(){
 const calls=[],elements=[];
 class Terminal extends BrowserTerminal{open(){}loadAddon(addon){if(!(addon instanceof FitAddon))super.loadAddon(addon);}}
 class FitAddon{}
 const element=()=>({style:{},isConnected:true,addEventListener(){},removeEventListener(){},remove(){this.isConnected=false;}});
 const args={terminalReopen:{current:null},Terminal,FitAddon,document:{createElement(){const e=element();elements.push(e);return e;}},window:{addEventListener(){},removeEventListener(){}},terminalHost:{current:{append(){}}},terminalSettingsRef:{current:defaultTerminalSettings},terminalSystemThemeRef:{current:'dark'},terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},terminalOptions,terminalCursorOptions,TERMINAL_SCROLLBACK_LINES:frameModule.TERMINAL_SCROLLBACK_LINES,terminalWindowClaim:()=>1,invoke:(command,args)=>{calls.push({command,args});return Promise.resolve(null);},setError(){},isTerminalProtocolResponse:()=>false,ownerConnectionAvailable:{current:{available:true,version:0}},terminalHasInputFocus:()=>false,syncViewSize(){},installTerminalLinks:()=>({dispose(){}}),terminalLinkIdentity:()=>null,openUrl(){},shortcutMac:true,captureTerminalPaste(){},handleTerminalScroll(){},fileDropPending:{current:null},pastePending:{current:null},cancelTerminalPaste(){},terminalMounted:{current:true},setRecoveryRevision(){}};
 const create=new Function(...Object.keys(args),ts.transpileModule('const create='+factory,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return create;')(...Object.values(args));return {view:create('s-1-1'),calls};
}
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
function frame(owner,addon,viewport){return {projection:{version:1,instance:'a'.repeat(64),session:'s-1-1',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,data:addon.serialize(),cols:40,rows:24,cursorX:owner.buffer.active.cursorX,viewport,buffer:'normal'},end_offset:1,status:'running'};}
function snapshot(term){const b=term.buffer.active;return {baseY:b.baseY,viewportY:b.viewportY,lines:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(false))};}
for(const count of [20,1100,1999,2120])test('actual factory browser projection retains owner buffer '+count,async()=>{
 const owner=new OwnerTerminal({cols:40,rows:24,scrollback:2000,allowProposedApi:true}),addon=new SerializeAddon();owner.loadAddon(addon);const h=actualFactory();
 try{
  await write(owner,Array.from({length:count},(_,i)=>'line-'+String(i).padStart(6,'0')+'\r\n').join(''));
  for(const more of [false,true]){
   if(more)await write(owner,'further-output\r\n'.repeat(37));
   for(const viewport of new Set([0,Math.floor(owner.buffer.active.baseY/2),owner.buffer.active.baseY])){
    owner.scrollToLine(viewport);await applyTerminalFrame(h.view.instance,frame(owner,addon,viewport),'s-1-1');
    assert.deepEqual(snapshot(h.view.instance),snapshot(owner),'factory retention must preserve retained cells and absolute viewport');
    h.view.instance.scrollPages(-1);owner.scrollToLine(h.view.instance.buffer.active.viewportY);assert.deepEqual(snapshot(h.view.instance),snapshot(owner),'forwarded absolute viewport has same content');
   }
  }
  assert.deepEqual(h.calls,[],'projection capacity does not dispatch PTY/resize/create/claim');
 }finally{h.view.moveDisposal=true;h.view.dispose();owner.dispose();}
});
test('actual production frame bound accepts2000 and rejects2001 before renderer mutation',async()=>{
 const owner=new OwnerTerminal({cols:40,rows:24,scrollback:2000,allowProposedApi:true}),addon=new SerializeAddon();owner.loadAddon(addon);const h=actualFactory();try{await write(h.view.instance,'unchanged');const good=frame(owner,addon,2000);assert.equal(validateTerminalFrame(good,'s-1-1'),good);const before=snapshot(h.view.instance);await assert.rejects(applyTerminalFrame(h.view.instance,{...good,projection:{...good.projection,viewport:2001}},'s-1-1'));assert.deepEqual(snapshot(h.view.instance),before);assert.deepEqual(h.calls,[]);}finally{h.view.moveDisposal=true;h.view.dispose();owner.dispose();}
});

for(const capacity of [200,500,2000])test('A05a3 actual factory browser follows immutable owner capacity '+capacity,async()=>{
 const owner=new OwnerTerminal({cols:40,rows:24,scrollback:capacity,allowProposedApi:true}),addon=new SerializeAddon();owner.loadAddon(addon);const h=actualFactory();try{
 for(const count of [20,capacity-20,capacity+50]){await write(owner,'bounded-line\r\n'.repeat(count));const f=frame(owner,addon,owner.buffer.active.baseY);f.projection.retained_lines=capacity;await applyTerminalFrame(h.view.instance,f,'s-1-1');assert.equal(h.view.instance.options.scrollback,capacity);assert.deepEqual(snapshot(h.view.instance),snapshot(owner));}
 owner.resize(45,25);await write(owner,'resize\r\n');let f=frame(owner,addon,owner.buffer.active.baseY);f.projection.cols=45;f.projection.rows=25;f.projection.retained_lines=capacity;await applyTerminalFrame(h.view.instance,f,'s-1-1');assert.deepEqual(snapshot(h.view.instance),snapshot(owner));
 await write(owner,'\x1b[?1049hALT');f=frame(owner,addon,0);f.projection.cols=45;f.projection.rows=25;f.projection.buffer='alternate';f.projection.retained_lines=capacity;await applyTerminalFrame(h.view.instance,f,'s-1-1');assert.deepEqual(snapshot(h.view.instance),snapshot(owner));assert.deepEqual(h.calls,[]);
 }finally{h.view.moveDisposal=true;h.view.dispose();owner.dispose();}
});
