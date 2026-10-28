import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Production resolver/capture/action callbacks; synthetic focus is not native DOM proof.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';
import {resolveAppShortcut,defaultAppShortcuts,shortcutActions} from '../src/app-shortcuts.ts';
import {createTerminalScroll,updateTerminalScroll} from '../src/terminal-scroll.ts';
const text=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),names=['handleShortcut','terminalKeyboardScrollView','scrollTerminalPage','refreshTerminalScroll','handleTerminalScroll','returnTerminalToLive'];const code=[];function walk(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))code.push(n.getText(source));ts.forEachChild(n,walk);}walk(source);
class Target{constructor(kind='terminal'){this.kind=kind;}closest(selector){if(selector==='.xterm-helper-textarea')return this.kind==='terminal'?this:null;if(selector==='[data-shortcuts]')return this.kind==='capture'?this:null;if(selector.includes('input'))return this.kind==='editor'?this:null;return null;}}
function fixture(mac=true){
 const calls=[],errors=[],buffer={type:'normal',baseY:200,viewportY:100},view={desktopGeneration:1,frameInstance:'owner',attachVersion:1,lifecycleRevision:1,viewportRevision:0,disposed:false,moving:false,ready:true,live:true,persisted:false,projection:true,scroll:createTerminalScroll(),element:{dataset:{sessionId:'s-a'},isConnected:true,inert:false,style:{visibility:'visible'}},instance:{buffer:{active:buffer},modes:{mouseTrackingMode:'none'},hasSelection:()=>false}};view.scroll.held=true;
 let pool=view,focused=true,visible=true,modal=false,pending=[];const refs={sessionId:{current:'s-a'},terminalViews:{current:{get:()=>pool}},ownerConnectionAvailable:{current:{available:true,version:1}},terminalMounted:{current:true},terminalTabDrag:{current:null},layoutRestore:{current:{pending:false}},terminalMoveTaskRef:{current:null},terminalMoveOperationRef:{current:false}};
 const bindings={...refs,Element:Target,navigator:{platform:mac?'MacIntel':'Linux'},document:{querySelector:()=>modal?{}:null},resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(mac)},terminalWindowClaim:()=>1,terminalHasInputFocus:()=>focused,terminalPaneVisible:()=>visible,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},setError:e=>errors.push(e),invoke:(name,args)=>{calls.push({name,args});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
 const api=new Function(...Object.keys(bindings),ts.transpileModule(code.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return {handleShortcut,handleTerminalScroll,returnTerminalToLive};')(...Object.values(bindings));
 view.instance.scrollPages=delta=>{calls.push('page:'+delta);const old=buffer.viewportY;buffer.viewportY=Math.max(0,Math.min(buffer.baseY,old+delta*23));if(old!==buffer.viewportY)api.handleTerminalScroll(view,'s-a',buffer.viewportY);};view.instance.scrollToBottom=()=>{calls.push('local-bottom');buffer.viewportY=buffer.baseY;};
 const event=(key='PageUp',extra={})=>({key,metaKey:mac,ctrlKey:!mac,shiftKey:!mac,altKey:false,keyCode:0,isComposing:false,repeat:false,defaultPrevented:false,target:new Target(),preventDefault(){calls.push('prevent');},stopPropagation(){calls.push('stop');},...extra});
 return {api,calls,errors,view,buffer,refs,pending,event,fire:(key,extra)=>api.handleShortcut(event(key,extra)),focus:v=>focused=v,visible:v=>visible=v,modal:v=>modal=v,replace:v=>pool=v};
}
test('A05a2 pure fixed routes exact both-platform modifier and exclusion matrix preserves eight editable actions',()=>{
 for(const mac of [true,false])for(const [key,route] of [['PageUp','scroll-page-up'],['PageDown','scroll-page-down'],['End','scroll-bottom']]){const h=fixture(mac),event=h.event(key);assert.equal(resolveAppShortcut(event,defaultAppShortcuts(mac),mac),route);for(const change of [{altKey:true},{metaKey:!mac},{ctrlKey:mac},{shiftKey:mac},{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true},{getModifierState:()=>true},{key:'pageup'},{key:'Dead'},{key:'Process'},{key:'Unidentified'},{key:''}])assert.equal(resolveAppShortcut({...event,...change},defaultAppShortcuts(mac),mac),null,JSON.stringify(change));}assert.equal(shortcutActions.length,9);
});
test('A05a2 actual capture consumes before one page and existing onScroll sends one viewport request',()=>{
 for(const mac of [true,false])for(const [key,delta] of [['PageUp',-1],['PageDown',1]]){const h=fixture(mac);h.fire(key);assert.deepEqual(h.calls.slice(0,3),['prevent','stop','page:'+delta]);assert.equal(h.calls.length,4);assert.equal(h.calls[3].name,'set_terminal_viewport');assert.equal(h.calls[3].args.line,100+delta*23);assert.equal(h.calls[3].args.bottom,undefined);}
});
test('A05a2 actual top bottom no-op accepts one public page but makes zero backend calls',()=>{
 for(const [key,line] of [['PageUp',0],['PageDown',200]]){const h=fixture();h.buffer.viewportY=line;h.fire(key);assert.deepEqual(h.calls,['prevent','stop','page:'+(key==='PageUp'?-1:1)]);}
});
test('A05a2 actual rejection leaves propagation untouched for each current-view Find selection transfer and modal guard',()=>{
 const mutations=[h=>h.view.ready=false,h=>h.view.desktopGeneration=2,h=>h.view.desktopGeneration=undefined,h=>h.view.disposed=true,h=>h.view.moving=true,h=>h.view.attaching=true,h=>h.view.parsing={},h=>h.view.updating=true,h=>h.view.projecting=true,h=>h.view.resizing=true,h=>h.view.scrollReturnPending=true,h=>h.view.selecting=true,h=>h.view.instance.hasSelection=()=>true,h=>h.view.instance.modes.mouseTrackingMode='x10',h=>h.buffer.type='alternate',h=>h.view.element.isConnected=false,h=>h.view.element.inert=true,h=>h.view.element.style.visibility='hidden',h=>h.view.find={state:{visible:true},blocksProjection:()=>false},h=>h.view.find={state:{visible:false},blocksProjection:()=>true},h=>h.view.availability='owner_unavailable',h=>h.view.availability='terminal_unavailable',h=>h.refs.ownerConnectionAvailable.current.available=false,h=>h.refs.terminalMounted.current=false,h=>h.refs.layoutRestore.current.pending=true,h=>h.refs.terminalTabDrag.current={},h=>h.refs.terminalMoveTaskRef.current={},h=>h.refs.terminalMoveOperationRef.current=true,h=>h.focus(false),h=>h.visible(false),h=>h.modal(true)];
 for(const mutate of mutations){const h=fixture();mutate(h);h.fire();assert.deepEqual(h.calls,[],mutate.toString());}for(const extra of [{target:new Target('editor')},{target:new Target('capture')},{isComposing:true},{repeat:true},{keyCode:229}]){const h=fixture();h.fire('PageUp',extra);assert.deepEqual(h.calls,[]);}const readonly=fixture();readonly.view.writable=false;readonly.fire();assert.equal(readonly.calls[2],'page:-1');
});
test('A05a2 actual bottom uses live authority without speculative unread clear and retained local only',async()=>{
 const live=fixture();live.view.scroll.newOutput=true;live.fire('End');assert.deepEqual(live.calls.slice(0,2),['prevent','stop']);assert.equal(live.calls[2].name,'set_terminal_viewport');assert.equal(live.calls[2].args.bottom,true);assert.equal(live.view.scroll.newOutput,true);assert.equal(live.buffer.viewportY,100);live.pending[0].resolve();await new Promise(setImmediate);assert.equal(live.view.dirty,true);
 const retained=fixture();retained.view.live=false;retained.view.persisted=true;retained.fire('End');assert.deepEqual(retained.calls,['prevent','stop','local-bottom']);assert.equal(retained.buffer.viewportY,200);const bottom=fixture();bottom.view.scroll.held=false;bottom.buffer.viewportY=200;bottom.fire('End');assert.deepEqual(bottom.calls,['prevent','stop']);
});
test('A05a2 synchronous page throw is bounded/current-only and consumed with no fallback',()=>{
 const h=fixture();h.view.instance.scrollPages=()=>{throw Error('PRIVATE_DETAIL');};h.fire();assert.deepEqual(h.calls,['prevent','stop']);assert.equal(h.errors.length,1);assert.doesNotMatch(h.errors[0],/PRIVATE_DETAIL/);
 const stale=fixture();stale.view.instance.scrollPages=()=>{stale.replace({...stale.view});throw Error('late');};stale.fire();assert.deepEqual(stale.errors,[]);
});
test('A05a2 late viewport/bottom failure after identity generation attachment connection or focus change does not alter new pane',async()=>{
 for(const key of ['PageUp','End'])for(const change of [h=>h.replace({...h.view}),h=>h.refs.sessionId.current='s-b',h=>h.view.desktopGeneration++,h=>h.view.attachVersion++,h=>h.refs.ownerConnectionAvailable.current.version++,h=>h.focus(false)]){const h=fixture();h.fire(key);assert.equal(h.pending.length,1);change(h);h.pending[0].reject(Error('late'));await new Promise(setImmediate);assert.deepEqual(h.errors,[],key+' '+change.toString());assert.notEqual(h.view.dirty,true);}
});

test('A05a2 installed browser public page API clamps rows2 and ordinary rows without input or selection changes',async()=>{
 const {createRequire}=await import('node:module'),{Terminal}=createRequire(import.meta.url)('@xterm/xterm');
 for(const rows of [2,24]){const terminal=new Terminal({cols:40,rows,scrollback:2000,allowProposedApi:true}),input=[];terminal.onData(data=>input.push(data));try{await new Promise(resolve=>terminal.write('retained\r\n'.repeat(1100),resolve));const before=Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i).translateToString(false));terminal.scrollToLine(0);terminal.scrollPages(-1);assert.equal(terminal.buffer.active.viewportY,0);terminal.scrollPages(1);assert.equal(terminal.buffer.active.viewportY,rows-1);terminal.scrollToLine(terminal.buffer.active.baseY);terminal.scrollPages(1);assert.equal(terminal.buffer.active.viewportY,terminal.buffer.active.baseY);assert.deepEqual(Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i).translateToString(false)),before);assert.equal(terminal.hasSelection(),false);assert.deepEqual(input,[]);}finally{terminal.dispose();}}
});

test('A05a2 retained bottom public throw is bounded and does not leave projecting stuck',async()=>{
 const h=fixture();h.view.live=false;h.view.persisted=true;h.view.instance.scrollToBottom=()=>{throw Error('PRIVATE_BOTTOM');};await h.api.returnTerminalToLive();assert.equal(h.view.projecting,false);assert.equal(h.errors.length,1);assert.doesNotMatch(h.errors[0],/PRIVATE_BOTTOM/);assert.deepEqual(h.calls,[]);
});

for(const mac of [true,false])for(const key of ['toString','constructor','__proto__']){
 test('A05a2 actual resolver rejects inherited key '+key+' mac='+mac,()=>{const h=fixture(mac);assert.equal(resolveAppShortcut(h.event(key),defaultAppShortcuts(mac),mac),null);});
 test('A05a2 actual capture preserves inherited key '+key+' mac='+mac,()=>{const h=fixture(mac);assert.doesNotThrow(()=>h.fire(key));assert.deepEqual(h.calls,[]);assert.deepEqual(h.errors,[]);});
}
