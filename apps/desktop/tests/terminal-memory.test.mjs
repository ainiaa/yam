// Author: Jeff.Liu. Ordinary text appends must not reset/replay retained terminal history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import service from '../terminal-service.cjs';
import {consumeOutput} from '../src/session-stream.ts';
import * as frames from '../src/terminal-frame.ts';
const {applyTerminalFrame}=frames;
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const write=(t,data)=>new Promise(resolve=>t.write(data,resolve));
function callback(name,bindings){let fn;function scan(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)fn=n;ts.forEachChild(n,scan);}scan(tree);assert.ok(fn,name);return new Function(...Object.keys(bindings),ts.transpile(fn.getText(tree),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(bindings));}
function fixture(instance,extra={}){
 const writes=[],scrolls=[],controlRefreshes=[],outputCursor={current:100},connection={current:{available:true,version:1}},mounted={current:true};let complete;const completions=[];
 instance??={cols:100,rows:24,buffer:{active:{type:'normal',baseY:2000,viewportY:2000,cursorX:0}},hasSelection:()=>false,write:(data,done)=>{writes.push(data);complete=done;completions.push(done);}};
 const view={instance,plainAppend:true,ready:true,live:true,projection:true,writable:true,controlRevision:0,frameSize:{cols:100,rows:24},cursor:100,dirty:false,updating:false,projecting:false,parsing:null,selecting:false,disposed:false,moving:false,attaching:false,resizing:false,resizePending:null,clearPending:false,scrollReturnPending:false,reportedPromptNavigation:null,frameInstance:'a'.repeat(64),attachVersion:1,lifecycleRevision:1,viewportRevision:1,desktopGeneration:1};
 const map=new Map([['s',view]]);let visible=true;
 const append=callback('appendProjectedOutput',{consumeOutput,refreshTerminalControls:view=>controlRefreshes.push(view),terminalTextAppendReady:t=>t._core?frames.terminalTextAppendReady(t):true,ownerConnectionAvailable:connection,terminalMounted:mounted,terminalPaneVisible:()=>visible,terminalViews:{current:map},refreshTerminalScroll:(v,offset)=>scrolls.push([v,offset]),handleTerminalScroll:()=>assert.fail('unexpected held scroll'),outputCursor,sessionId:{current:'s'},...extra});
 const chunk=data=>({session_id:'s',data,offset:view.cursor,end_offset:view.cursor+Buffer.byteLength(data),parser:{instance:'a'.repeat(64),control_revision:0}});
 return {view,map,writes,completions,scrolls,controlRefreshes,connection,mounted,outputCursor,append,chunk,complete:()=>complete(),hide:()=>visible=false};
}
test('the parser offers a fail-closed hint only at a safe ordinary-line boundary',async()=>{
 const t=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true}),a=new serialize.SerializeAddon();t.loadAddon(a);
 try{
  await write(t,Buffer.from('中文🙂\r\n'));assert.equal(service.projection(t,a).plain_append,true);
  for(const sequence of ['\x1b[?1049h','\x1b[4h','\x1b[?6h','\x1b[?7l','\x1b[?2026h','\x1b[2;20r','\x1b(0','\x0e','\x1b]8;;https://example.com\x07','x','\x1b[31']){
   await write(t,Buffer.from('\x1bc'+sequence));assert.equal(service.projection(t,a).plain_append,false,JSON.stringify(sequence));
  }
  await write(t,Buffer.from('\x1bc'));await write(t,Buffer.from([0xe4,0xb8]));assert.equal(service.projection(t,a).plain_append,false,'split UTF-8');
 }finally{t.dispose();}
});
test('ordinary Unicode output writes only new bytes and commits after parsing',async()=>{
 const h=fixture(),chunk=h.chunk('中文🙂\r\n');assert.equal(h.append(h.view,'s',chunk),true);assert.deepEqual(h.writes,[chunk.data]);assert.equal(h.view.projecting,true);assert.equal(h.outputCursor.current,100);h.complete();await new Promise(setImmediate);assert.equal(h.view.cursor,chunk.end_offset);assert.equal(h.outputCursor.current,chunk.end_offset);assert.equal(h.view.parsing,null);assert.equal(h.view.projecting,false);assert.equal(h.view.dirty,false);assert.deepEqual(h.scrolls,[[h.view,chunk.end_offset]]);
});
test('complex, incomplete controls, stale and interrupted views retain the authoritative frame path without writes',()=>{
 const changes=[h=>delete h.view.plainAppend,h=>h.view.controlRevision=undefined,h=>h.view.controlRevision=1,h=>h.view.frameSize=undefined,h=>h.view.instance.cols++,h=>h.view.instance.rows++,h=>h.view.plainAppend=false,h=>h.view.ready=false,h=>h.view.live=false,h=>h.view.dirty=true,h=>h.view.updating=true,h=>h.view.parsing=Promise.resolve(),h=>h.view.projecting=true,h=>h.view.selecting=true,h=>h.view.disposed=true,h=>h.view.moving=true,h=>h.view.attaching=true,h=>h.view.resizing=true,h=>h.view.resizePending={},h=>h.view.clearPending=true,h=>h.view.scrollReturnPending=true,h=>h.view.frameInstance=null,h=>h.view.reportedPromptNavigation={previous:true},h=>h.view.instance.hasSelection=()=>true,h=>h.view.instance.buffer.active.type='alternate',h=>h.connection.current.available=false,h=>h.mounted.current=false,h=>h.hide()];
 for(const change of changes){const h=fixture();change(h);assert.equal(h.append(h.view,'s',h.chunk('line\r\n')),false);assert.deepEqual(h.writes,[]);}
 for(const data of ['\n','line\r','\x1b[2Jred\r\n','back\b\r\n','\u0085\r\n','\ud800\r\n']){const h=fixture();assert.equal(h.append(h.view,'s',h.chunk(data)),false);assert.deepEqual(h.writes,[]);}
 for(const patch of [{session_id:'other'},{parser:undefined},{parser:{instance:'b'.repeat(64),control_revision:0}},{parser:{instance:'a'.repeat(64),control_revision:1}},{parser:{instance:'a'.repeat(64),control_revision:true}},{offset:101,end_offset:107},{offset:90,end_offset:106},{end_offset:NaN},{end_offset:true}]){const h=fixture();assert.equal(h.append(h.view,'s',{...h.chunk('line\r\n'),...patch}),false);assert.deepEqual(h.writes,[]);}
});
test('late callbacks cannot commit across lifecycle, owner, viewport, attachment or view replacement',async()=>{
 for(const mutate of [h=>h.view.lifecycleRevision++,h=>h.view.frameInstance='b'.repeat(64),h=>h.view.viewportRevision++,h=>h.view.attachVersion++,h=>h.view.desktopGeneration++,h=>h.connection.current.version++,h=>h.map.clear(),h=>h.view.instance={...h.view.instance},h=>h.view.disposed=true]){
  const h=fixture();assert.equal(h.append(h.view,'s',h.chunk('line\r\n')),true);mutate(h);h.complete();await new Promise(setImmediate);assert.equal(h.outputCursor.current,100);assert.deepEqual(h.scrolls,[]);
 }
});
test('incremental text preserves all retained rows, Unicode, style, cursor and scroll while avoiding full resets',async()=>{
 const owner=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true}),renderer=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true,convertEol:true}),addon=new serialize.SerializeAddon(),visible=new serialize.SerializeAddon();owner.loadAddon(addon);renderer.loadAddon(visible);
 try{
  const seed='\x1b[38;2;20;180;90;48;5;17;4m'+Array.from({length:2200},(_,i)=>`初始🙂 ${i}\r\n`).join('');await write(owner,Buffer.from(seed));const p=service.projection(owner,addon);assert.equal(p.plain_append,true);
  const frame={projection:{version:1,instance:'a'.repeat(64),session:'s',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,...p},end_offset:100,status:'running'};await applyTerminalFrame(renderer,frame,'s');renderer.hasSelection=()=>false;const active=renderer._core._inputHandler._activeBuffer,h=fixture(renderer);
  for(let i=0;i<100;i++){const data=`新增🙂 e\u0301 👩‍💻 ${i} ${'中'.repeat(i%55)}\r\n`;await write(owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true);await h.view.parsing;await new Promise(setImmediate);}
  assert.equal(renderer._core._inputHandler._activeBuffer,active,'append reuses the buffer instead of RIS reset');assert.equal(renderer.buffer.active.length,2024);assert.equal(visible.serialize(),addon.serialize());assert.equal(renderer.buffer.active.cursorX,owner.buffer.active.cursorX);assert.equal(renderer.buffer.active.viewportY,owner.buffer.active.viewportY);assert.ok(p.data.length>10000);
 }finally{owner.dispose();renderer.dispose();}
});

test('the actual projection event route keeps a safe append clean and marks every fallback dirty',async()=>{
 let listener;function scan(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='listen'&&n.arguments[0]?.getText(tree)==='"session-output"')listener=n.arguments[1];ts.forEachChild(n,scan);}scan(tree);assert.ok(listener);
 for(const safe of [true,false]){
  const h=fixture(),phases=[],bindings={active:true,terminalViews:{current:h.map},appendProjectedOutput:()=>safe,sessionId:{current:'s'},updateAgentPhase:data=>phases.push(data),consumeOutput:()=>assert.fail('projection must not enter legacy raw path'),pendingOutput:{current:{push:()=>assert.fail('no buffer')}},setError:()=>assert.fail('no error'),outputCursor:h.outputCursor};
  const route=new Function(...Object.keys(bindings),ts.transpile('return ('+listener.getText(tree)+');',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));route({payload:h.chunk('line\r\n')});assert.equal(h.view.dirty,!safe);assert.deepEqual(phases,['line\r\n']);
 }
});


test('renderer decoder, character set, modes and Unicode width version must also be safe',async()=>{
 assert.equal(typeof frames.terminalTextAppendReady,'function');
 const t=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true});
 try{await write(t,'ready\r\n');assert.equal(frames.terminalTextAppendReady(t),true);
  assert.equal(frames.terminalTextAppendReady({}),false);
  const other=Object.create(t);Object.defineProperty(other,'unicode',{value:{activeVersion:'15'}});assert.equal(frames.terminalTextAppendReady(other),false);
  for(const sequence of ['\x1b[4h','\x1b[?6h','\x1b[?7l','\x1b(0','\x1b[2;20r','\ud800']){await write(t,'\x1bc'+sequence);assert.equal(frames.terminalTextAppendReady(t),false,JSON.stringify(sequence));}
 }finally{t.dispose();}
});

test('an obsolete append cannot clear its successor parse ownership, and parse errors request a full frame',async()=>{
 const h=fixture();h.append(h.view,'s',h.chunk('line\r\n'));const successor=Promise.resolve();h.view.parsing=successor;h.view.projecting=true;h.complete();await new Promise(setImmediate);assert.equal(h.view.parsing,successor);assert.equal(h.view.projecting,true);assert.equal(h.outputCursor.current,100);assert.equal(h.view.dirty,true);
 const failed=fixture();failed.view.instance.write=()=>{throw Error('renderer write unavailable');};assert.equal(failed.append(failed.view,'s',failed.chunk('line\r\n')),true);await new Promise(setImmediate);assert.equal(failed.view.dirty,true);assert.equal(failed.view.plainAppend,false);assert.equal(failed.outputCursor.current,100);assert.equal(failed.view.parsing,null);assert.equal(failed.view.projecting,false);
});


test('control invalidation and attachment reads cannot erase a notification received while waiting',async()=>{
 const h=fixture(),invalidate=callback('invalidateTerminalProjection',{terminalViews:{current:h.map}});
 invalidate('other');assert.equal(h.view.dirty,false);invalidate('s');assert.equal(h.view.dirty,true);assert.equal(h.view.plainAppend,false);
 let seam;function scan(n){if(ts.isTryStatement(n)&&n.tryBlock.statements.some(s=>ts.isVariableStatement(s)&&s.getText(tree).includes('const frame=await invoke<TerminalFrame|null>("read_terminal_frame"')))seam=n.tryBlock;ts.forEachChild(n,scan);}scan(tree);assert.ok(seam);
 const statements=[...seam.statements];const end=statements.findIndex(s=>ts.isIfStatement(s)&&s.expression.getText(tree)==='frame');assert.ok(end>=0);
 const code=statements.slice(0,end+1).map(s=>s.getText(tree)).join('\n');let rendered=0;const view={dirty:true,lifecycleRevision:0,desktopGeneration:1};
 const run=new Function('view','id','invoke','attached','renderFrame','pendingOutput',ts.transpile('return (async()=>{'+code+'})();',{target:ts.ScriptTarget.ES2022}));
 await run(view,'s',async()=>{view.dirty=true;return {projection:{}};},()=>true,async()=>{rendered++;assert.equal(view.dirty,true,'notification must survive an older read reply');},{current:{delete(){}}});assert.equal(rendered,1);assert.equal(view.dirty,true);
});


test('a synchronized read-only view may render output without acquiring input or resize permission',async()=>{
 const h=fixture();h.view.writable=false;const chunk=h.chunk('read only\r\n');assert.equal(h.append(h.view,'s',chunk),true);h.complete();await new Promise(setImmediate);assert.equal(h.view.cursor,chunk.end_offset);assert.equal(h.view.writable,false);assert.deepEqual(h.writes,[chunk.data]);
});

test('controls refresh only if a committed render observed async busy, including a completion before commit',async()=>{
 const h=fixture();h.view.element={dataset:{sessionId:'s'}};let revisions=0;
 const bindings={terminalViews:{current:h.map},sessionId:{current:'s'},terminalMounted:h.mounted,setRecoveryRevision:update=>{assert.equal(update(0),1);revisions++;}};
 const busy=callback('terminalControlsBusy',{}),refresh=callback('refreshTerminalControls',{...bindings,terminalControlsBusy:busy});
 let commit;function scan(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useLayoutEffect'&&n.arguments[0]?.getText(tree).includes('controlsRenderedBusy'))commit=n.arguments[0];ts.forEachChild(n,scan);}scan(tree);assert.ok(commit);
 const record=(view,rendered)=>new Function('renderedControlView','renderedControlsBusy','refreshTerminalControls',ts.transpile('return ('+commit.getText(tree)+');',{target:ts.ScriptTarget.ES2022}))(view,rendered,refresh)();
 h.view.parsing=Promise.resolve();record(h.view,true);assert.equal(revisions,0);h.view.parsing=null;refresh(h.view);assert.equal(revisions,1);refresh(h.view);assert.equal(revisions,1);
 record(h.view,false);h.view.parsing=Promise.resolve();h.view.parsing=null;refresh(h.view);assert.equal(revisions,1,'ordinary unobserved writes do not rerender the workspace');
 record(h.view,true);assert.equal(revisions,2,'completion between render and commit must not strand disabled controls');
 for(const field of ['updating','resizing','selecting','attaching','clearPending','promptNavigationPending','scrollReturnPending']){h.view[field]=true;assert.equal(busy(h.view),true);h.view[field]=false;}assert.equal(busy(h.view),false);
});


test('append completion notifies controls only when their busy state was painted',async()=>{
 for(const painted of [false,true]){const h=fixture();h.view.controlsRenderedBusy=painted;assert.equal(h.append(h.view,'s',h.chunk('line\r\n')),true);h.complete();await new Promise(setImmediate);assert.equal(h.controlRefreshes.length,painted?1:0);}
});


test('ordinary PTY print fragments may continue at an already synchronized nonzero column',async()=>{
 const h=fixture();h.view.instance.buffer.active.cursorX=35;const part=h.chunk(' 中文🙂\r\n');assert.equal(h.append(h.view,'s',part),true);h.complete();await new Promise(setImmediate);assert.equal(h.view.cursor,part.end_offset);assert.deepEqual(h.writes,[part.data]);
});

test('fragmented text, combining characters, ZWJ and pending wrap preserve the exact owner scene',async()=>{
 const owner=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true}),renderer=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true,convertEol:true}),addon=new serialize.SerializeAddon(),visible=new serialize.SerializeAddon();owner.loadAddon(addon);renderer.loadAddon(visible);
 try{await write(owner,Buffer.from('\x1b[38;2;20;180;90;48;5;17;4m'+Array.from({length:2200},(_,i)=>`初始🙂 ${i}\r\n`).join('')));const p=service.projection(owner,addon);assert.equal(p.plain_append,true);await applyTerminalFrame(renderer,{projection:{version:1,instance:'a'.repeat(64),session:'s',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,...p},end_offset:100,status:'running'},'s');renderer.hasSelection=()=>false;const buffer=renderer._core._inputHandler._activeBuffer,h=fixture(renderer);
  for(let i=0;i<35;i++)for(const data of ['x'.repeat(100),'中','文 e','\u0301 👩','‍','💻',` ${i} 中文🙂\r\n`]){await write(owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true,JSON.stringify(data));await h.view.parsing;await new Promise(setImmediate);assert.equal(visible.serialize(),addon.serialize());assert.equal(renderer.buffer.active.cursorX,owner.buffer.active.cursorX);}
  assert.equal(renderer._core._inputHandler._activeBuffer,buffer);assert.equal(renderer.buffer.active.length,2024);assert.equal(renderer.buffer.active.viewportY,owner.buffer.active.viewportY);
 }finally{owner.dispose();renderer.dispose();}
});


test('one relay batch queues contiguous print fragments in FIFO without requesting a full frame',async()=>{
 const h=fixture();let offset=100;for(const data of ['YAM_MEMORY_0 ','1819',' 中文🙂\r\n']){const chunk={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',chunk),true);offset=chunk.end_offset;}assert.equal(h.view.cursor,100);assert.equal(h.view.projecting,true);assert.equal(h.writes.length,3);for(const done of h.completions)done();await new Promise(setImmediate);assert.equal(h.view.cursor,offset);assert.equal(h.outputCursor.current,offset);assert.equal(h.view.dirty,false);assert.equal(h.view.parsing,null);assert.equal(h.view.pendingAppend,undefined);assert.equal(h.view.projecting,false);assert.equal(h.scrolls.length,1);
});

test('a burst of fragmented ordinary output matches the real owner without a renderer reset',async()=>{
 const owner=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true}),renderer=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true,convertEol:true}),addon=new serialize.SerializeAddon(),visible=new serialize.SerializeAddon();owner.loadAddon(addon);renderer.loadAddon(visible);
 try{await write(owner,Buffer.from('\x1b[38;2;20;180;90;48;5;17;4m'+Array.from({length:2200},(_,i)=>`初始🙂 ${i}\r\n`).join('')));const p=service.projection(owner,addon);await applyTerminalFrame(renderer,{projection:{version:1,instance:'a'.repeat(64),session:'s',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,...p},end_offset:100,status:'running'},'s');renderer.hasSelection=()=>false;const active=renderer._core._inputHandler._activeBuffer,h=fixture(renderer);const pieces=Array.from({length:35},(_,i)=>['x'.repeat(100),'中','文 e','\u0301 👩','‍','💻',` ${i} 中文🙂\r\n`]).flat();await write(owner,Buffer.from(pieces.join('')));let offset=100;for(const data of pieces){const chunk={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',chunk),true,JSON.stringify(data));offset=chunk.end_offset;}await h.view.parsing;await new Promise(setImmediate);assert.equal(visible.serialize(),addon.serialize());assert.equal(renderer.buffer.active.cursorX,owner.buffer.active.cursorX);assert.equal(renderer.buffer.active.viewportY,owner.buffer.active.viewportY);assert.equal(renderer.buffer.active.length,2024);assert.equal(renderer._core._inputHandler._activeBuffer,active);assert.equal(h.view.cursor,offset);assert.equal(h.view.dirty,false);assert.equal(h.view.pendingAppend,undefined);
 }finally{owner.dispose();renderer.dispose();}
});

test('queued text is bounded and invalidation or foreign parser ownership cannot commit stale bytes',async()=>{
 for(const [parts,extra] of [[Array(256).fill('x'),'x'],[['x'.repeat(256*1024)],'x']]){const h=fixture();let offset=100;for(const data of parts){const c={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',c),true);offset=c.end_offset;}assert.equal(h.append(h.view,'s',{...h.chunk(extra),offset,end_offset:offset+1}),false);assert.equal(h.writes.length,parts.length);for(const done of h.completions)done();await new Promise(setImmediate);assert.equal(h.view.cursor,offset);assert.equal(h.view.pendingAppend,undefined);}
 for(const foreign of [false,true]){const h=fixture();let offset=100;for(const data of ['first',' second\r\n']){const c={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',c),true);offset=c.end_offset;}const successor=Promise.resolve();if(foreign){h.view.parsing=successor;h.view.projecting=true;}else{h.view.dirty=true;h.view.plainAppend=false;}for(const done of h.completions)done();await new Promise(setImmediate);assert.equal(h.view.cursor,100);assert.equal(h.outputCursor.current,100);assert.equal(h.view.pendingAppend,undefined);assert.equal(h.view.dirty,true);assert.equal(h.view.parsing,foreign?successor:null);assert.equal(h.view.projecting,foreign);}
});

test('closing an actual find controller restores safe append; reopening searches the latest buffer',async()=>{
 const {TerminalFindController}=await import('../src/terminal-find.ts');
 const renderer=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true});
 const scans=[];let controller;
 try{
  await write(renderer,'before\r\n');Object.assign(renderer,{hasSelection:()=>false,getSelectionPosition:()=>undefined,clearSelection(){},select(){},registerDecoration:()=>({dispose(){}})});
  controller=new TerminalFindController(renderer,{run:async text=>{scans.push(text);return {matches:[],overflow:false};},cancel(){},dispose(){}},()=>{});
  const h=fixture(renderer);h.view.find=controller;controller.open();await controller.setQuery('after');assert.equal(h.append(h.view,'s',h.chunk('\x1b[2Jcontrol while searching\r\n')),false,'cursor/screen controls retain authoritative full-frame search updates');
  controller.close();assert.equal(h.append(h.view,'s',h.chunk('after 中文🙂\r\n')),true,'closed controller cannot permanently disable incremental output');await h.view.parsing;await new Promise(setImmediate);assert.equal(h.view.dirty,false,'closed search also permits the parse commit');assert.equal(h.view.cursor,100+Buffer.byteLength('after 中文🙂\r\n'));
  controller.open();await controller.refresh();assert.match(scans.at(-1),/after 中文🙂/);
  controller.close();renderer.hasSelection=()=>true;assert.equal(h.append(h.view,'s',h.chunk('manual selection\r\n')),false,'manual selection still protects its scene');
 }finally{controller?.dispose();renderer.dispose();}
});


test('opening search while an incremental parse is pending requests an authoritative search refresh',async()=>{
 const h=fixture();h.view.find={state:{visible:false}};assert.equal(h.append(h.view,'s',h.chunk('pending\r\n')),true);h.view.find.state.visible=true;h.complete();await new Promise(setImmediate);assert.equal(h.view.dirty,true);assert.equal(h.view.cursor,100);assert.equal(h.outputCursor.current,100);assert.equal(h.view.parsing,null);assert.equal(h.view.projecting,false);
});

async function heldSearchFixture(){
 const {TerminalFindController}=await import('../src/terminal-find.ts'),{scanFindText}=await import('../src/terminal-find-worker.ts');
 const owner=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true}),renderer=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true,convertEol:true}),sourceAddon=new serialize.SerializeAddon(),visible=new serialize.SerializeAddon();owner.loadAddon(sourceAddon);renderer.loadAddon(visible);
 let controller;try{
  await write(owner,Buffer.from('\x1b[38;2;20;180;90m'+Array.from({length:2200},(_,i)=>`seed ${i} 中文🙂\r\n`).join('')));owner.scrollToLine(1500);const p=service.projection(owner,sourceAddon);assert.equal(p.plain_append,true,'safe ordinary parser hint is independent of a held viewport');
  await applyTerminalFrame(renderer,{projection:{version:1,instance:'a'.repeat(64),session:'s',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,...p},end_offset:100,status:'running'},'s');assert.equal(renderer.buffer.active.viewportY,1500);
  let selection;Object.assign(renderer,{hasSelection:()=>!!selection,getSelectionPosition:()=>selection,clearSelection(){selection=undefined;},select(col,row,size){selection={start:{x:col,y:row},end:{x:col+size,y:row}};},registerDecoration:()=>({dispose(){}})});
  controller=new TerminalFindController(renderer,{run:async(text,query,regex,sensitive)=>scanFindText(text,query,regex,sensitive),cancel(){},dispose(){}},()=>{});
  controller.open();await controller.setOptions({regex:true});const seed=owner.buffer.active.getLine(1505).translateToString(true).split(' ')[1];await controller.setQuery(`seed ${seed}|new`);assert.equal(controller.state.count,1);assert.equal(renderer.hasSelection(),true);assert.equal(controller.blocksProjection(),false);assert.equal(renderer.buffer.active.viewportY,owner.buffer.active.viewportY);
  const h=fixture(renderer),searches=[];h.view.find=controller;const original=controller.afterFrame.bind(controller);controller.afterFrame=current=>{const pending=original(current);searches.push(pending);return pending;};
  return {...h,owner,renderer,controller,sourceAddon,visible,searches,drain:async()=>{await h.view.parsing;await new Promise(setImmediate);await Promise.all(searches.splice(0));},dispose(){controller.dispose();owner.dispose();renderer.dispose();}};
 }catch(error){controller?.dispose();owner.dispose();renderer.dispose();throw error;}
}
test('100 active-search updates at a held viewport preserve the exact owner without any full-buffer reset',async()=>{
 const h=await heldSearchFixture();try{const buffer=h.renderer._core._inputHandler._activeBuffer;
  for(let i=0;i<100;i++){const data=`new ${i} 中文🙂 e\u0301\r\n`;await write(h.owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true);await h.drain();assert.equal(h.view.dirty,false);assert.equal(h.controller.state.count,i+2);assert.equal(h.controller.state.busy,false);assert.equal(h.controller.state.error,null);assert.equal(h.renderer.buffer.active.viewportY,h.owner.buffer.active.viewportY);}
  assert.equal(h.visible.serialize(),h.sourceAddon.serialize());assert.equal(h.renderer._core._inputHandler._activeBuffer,buffer);assert.equal(h.renderer.buffer.active.length,2024);assert.equal(h.view.pendingAppend,undefined);
 }finally{h.dispose();}
});
test('query changes during an active-search parse cannot commit an older snapshot',async()=>{
 const h=await heldSearchFixture();try{const data='second new 中文🙂\r\n';await write(h.owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true);const changed=h.controller.setQuery('second');await h.drain();await changed;assert.equal(h.controller.state.query,'second');assert.equal(h.controller.state.count,1);assert.equal(h.controller.state.busy,false);assert.equal(h.controller.state.error,null);assert.equal(h.view.dirty,false);}finally{h.dispose();}
});
test('active find owns only its own selection and refreshes once after a FIFO burst',async()=>{
 const h=fixture();let selected=true,before=0,after=0;h.view.instance.hasSelection=()=>selected;h.view.instance.buffer.active.viewportY=1500;h.view.instance.registerMarker=()=>({line:2000,dispose(){}});
 h.view.find={state:{visible:true},blocksProjection:()=>false,beforeFrame(){before++;selected=false;},afterFrame:async current=>{if(current())after++;}};
 let offset=100;for(const data of ['first ','中文🙂','\r\n']){const chunk={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',chunk),true);offset=chunk.end_offset;}for(const done of h.completions)done();await new Promise(setImmediate);assert.equal(before,3);assert.equal(after,1);assert.equal(h.view.cursor,offset);assert.equal(h.view.dirty,false);assert.equal(h.view.parsing,null);
 const manual=fixture();manual.view.instance.hasSelection=()=>true;manual.view.find={state:{visible:true},blocksProjection:()=>true,beforeFrame:()=>assert.fail('manual selection must be preserved')};assert.equal(manual.append(manual.view,'s',manual.chunk('blocked\r\n')),false);assert.deepEqual(manual.writes,[]);
});
test('find preparation errors fall back before writing and refresh errors request the authoritative frame',async()=>{
 const h=fixture();h.view.find={state:{visible:true},blocksProjection:()=>false,beforeFrame(){throw Error('selection unavailable');},afterFrame:async()=>{}};assert.equal(h.append(h.view,'s',h.chunk('line\r\n')),false);assert.deepEqual(h.writes,[]);
 const late=fixture();late.view.find={state:{visible:true},blocksProjection:()=>false,beforeFrame(){},afterFrame:async()=>{throw Error('refresh unavailable');}};assert.equal(late.append(late.view,'s',late.chunk('line\r\n')),true);late.complete();await new Promise(setImmediate);assert.equal(late.view.dirty,true);assert.equal(late.view.parsing,null);
});
test('ordinary held-view appends without search keep local and owner scroll in sync across trimming',async()=>{
 const h=await heldSearchFixture();try{h.controller.close();h.view.find=undefined;const buffer=h.renderer._core._inputHandler._activeBuffer;
  for(let i=0;i<40;i++){const data=`held 中文🙂 ${i}\r\n`;await write(h.owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true);await h.drain();assert.equal(h.view.dirty,false);assert.equal(h.renderer.buffer.active.viewportY,h.owner.buffer.active.viewportY);}
  assert.equal(h.renderer._core._inputHandler._activeBuffer,buffer);assert.equal(h.visible.serialize(),h.sourceAddon.serialize());
 }finally{h.dispose();}
});

test('active search in flight keeps new output on the bounded full-frame path instead of cancelling each chunk',()=>{
 const h=fixture();let restarted=0;h.view.find={state:{visible:true,busy:true},blocksProjection:()=>false,beforeFrame:()=>{restarted++;},afterFrame:async()=>{}};
 for(let i=0;i<20;i++)assert.equal(h.append(h.view,'s',h.chunk('fast output\r\n')),false);assert.equal(restarted,0);assert.deepEqual(h.writes,[]);
});
test('a real user scroll while parsing is synchronized at completion without echoing automatic scroll',async()=>{
 const sent=[];let h;h=fixture(undefined,{handleTerminalScroll(view,id,line){sent.push(line);view.viewportRevision++;}});assert.equal(h.append(h.view,'s',h.chunk('pending\r\n')),true);h.view.instance.buffer.active.viewportY=1500;h.complete();await new Promise(setImmediate);assert.deepEqual(sent,[1500]);assert.equal(h.view.dirty,true,'new viewport requires an authoritative scene');assert.equal(h.view.parsing,null);
 let disposed=0;const marker={line:2000,dispose(){disposed++;}},auto=fixture();auto.view.instance.registerMarker=()=>marker;auto.view.instance.buffer.active.viewportY=1500;assert.equal(auto.append(auto.view,'s',auto.chunk('trim\r\n')),true);marker.line=1999;auto.view.instance.buffer.active.viewportY=1499;auto.complete();await new Promise(setImmediate);assert.equal(auto.view.dirty,false,'matching owner trimming must not emit another viewport command');assert.equal(disposed,1);
 const unknown=fixture();unknown.view.instance.buffer.active.viewportY=1500;assert.equal(unknown.append(unknown.view,'s',unknown.chunk('unknown viewport\r\n')),false,'unknown marker support retains full replay');
});

test('held append falls back when marker creation throws and releases its marker if parsing fails',async()=>{
 const unavailable=fixture();unavailable.view.instance.buffer.active.viewportY=1500;unavailable.view.instance.registerMarker=()=>{throw Error('marker unavailable');};let accepted;assert.doesNotThrow(()=>{accepted=unavailable.append(unavailable.view,'s',unavailable.chunk('line\r\n'));});assert.equal(accepted,false);assert.deepEqual(unavailable.writes,[]);
 let disposed=0;const failed=fixture();failed.view.instance.buffer.active.viewportY=1500;failed.view.instance.registerMarker=()=>({line:2000,dispose(){disposed++;}});failed.view.instance.write=()=>{throw Error('write unavailable');};assert.equal(failed.append(failed.view,'s',failed.chunk('line\r\n')),true);await new Promise(setImmediate);assert.equal(failed.view.dirty,true);assert.equal(disposed,1);assert.equal(failed.view.parsing,null);
});

test('complete SGR styling appends without replaying retained history',async()=>{
 for(const data of ['\x1b[31mred\x1b[0m\r\n','\x1b[m','\x1b[1;3;4;38;2;20;180;90;48;5;17m中文🙂\x1b[0m\r\n','\x1b[4:3;38:2::20:180:90munderline\x1b[0m\r\n']){
  const h=fixture();assert.equal(h.append(h.view,'s',h.chunk(data)),true,JSON.stringify(data));h.complete();await new Promise(setImmediate);assert.deepEqual(h.writes,[data]);assert.equal(h.view.dirty,false);assert.equal(h.view.cursor,100+Buffer.byteLength(data));
 }
});
test('SGR admission never accepts partial, private, interleaved or other terminal controls',()=>{
 for(const data of ['\x1b[31','\x1b[31mred\x1b[','\x1b[?1m','\x1b[>4;2m','\x1b[1$m','\x1b[31\x1b[0m','\x1b[31m\n','\x1b[31m\r','\x1b[31m\x1b[2J','\x1b]8;;https://example.com\x07link','\x9b31mtext','\x1b[31m\ud800']){
  const h=fixture();assert.equal(h.append(h.view,'s',h.chunk(data)),false,JSON.stringify(data));assert.deepEqual(h.writes,[]);
 }
});
test('SGR output preserves real owner attributes, wrap, held viewport and active search without RIS',async()=>{
 for(const searching of [false,true]){
  const h=await heldSearchFixture();try{
   if(!searching){h.controller.close();h.view.find=undefined;}
   const buffer=h.renderer._core._inputHandler._activeBuffer;
   for(let i=0;i<25;i++)for(const data of [`\x1b[38;2;${i};180;90;48;5;17;4m`,'中'.repeat(50),'文 e\u0301 👩‍💻',` new ${i}\x1b[0m\r\n`]){
    await write(h.owner,Buffer.from(data));assert.equal(h.append(h.view,'s',h.chunk(data)),true,JSON.stringify(data));await h.drain();assert.equal(h.view.dirty,false);assert.equal(h.renderer.buffer.active.cursorX,h.owner.buffer.active.cursorX);assert.equal(h.renderer.buffer.active.viewportY,h.owner.buffer.active.viewportY);assert.equal(h.visible.serialize(),h.sourceAddon.serialize());
   }
   assert.equal(h.renderer._core._inputHandler._activeBuffer,buffer);assert.equal(h.renderer.buffer.active.length,2024);if(searching)assert.equal(h.controller.state.count,26);
  }finally{h.dispose();}
 }
});
test('complete SGR and text fragments share the bounded FIFO and one final commit',async()=>{
 const h=fixture();let offset=100;
 for(const data of ['\x1b[38;5;77m','colored 中文🙂','\x1b[0m','\r\n']){const chunk={...h.chunk(data),offset,end_offset:offset+Buffer.byteLength(data)};assert.equal(h.append(h.view,'s',chunk),true);offset=chunk.end_offset;}
 for(const done of h.completions)done();await new Promise(setImmediate);assert.equal(h.view.cursor,offset);assert.equal(h.view.dirty,false);assert.equal(h.view.parsing,null);assert.equal(h.scrolls.length,1);
});


test('task output never constructs an unused agent phase text window',()=>{
 const window={current:'unchanged'},selectedRecord={current:{summary:{launch:{mode:'task'}}}};
 const update=callback('updateAgentPhase',{selectedRecord,agentOutputWindow:window,inferAgentPhase:()=>assert.fail('task phase inference'),setAgentPhase:()=>assert.fail('task phase update')});
 for(const data of ['', '\x1b[31m中文🙂\x1b[0m', {replace(){assert.fail('task must not clean or flatten output');}}])update(data);
 assert.equal(window.current,'unchanged');
});
test('interactive agent phase output still cleans controls, bounds history and preserves idle phase',()=>{
 for(const record of [{summary:{launch:{mode:'interactive'}}},{summary:{}},null]){
  const window={current:'x'.repeat(4090)},calls=[],phases=[];
  const update=callback('updateAgentPhase',{selectedRecord:{current:record},agentOutputWindow:window,inferAgentPhase:text=>{calls.push(text);return text.endsWith('idle')?'idle':'working';},setAgentPhase:phase=>phases.push(phase)});
  update('\x1b]0;title\x07\x1b[31m中文🙂 ready\x1b[0m');
  assert.equal(window.current.length,4096);assert.equal(window.current,'x'.repeat(4096-'中文🙂 ready'.length)+'中文🙂 ready');assert.deepEqual(calls,[window.current]);assert.deepEqual(phases,['working']);
  update('idle');assert.equal(window.current.length,4096);assert.deepEqual(phases,['working']);assert.equal(calls.length,2);
 }
});
test('interactive cleaning and inference errors remain visible to their caller',()=>{
 const window={current:'before'},bindings={selectedRecord:{current:{summary:{launch:{mode:'interactive'}}}},agentOutputWindow:window,inferAgentPhase:()=>{throw Error('phase unavailable');},setAgentPhase:()=>assert.fail('no phase after error')};
 const update=callback('updateAgentPhase',bindings);
 assert.throws(()=>update({replace(){throw Error('input unavailable');}}),/input unavailable/);assert.equal(window.current,'before');
 assert.throws(()=>update('new'),/phase unavailable/);assert.equal(window.current,'beforenew');
});
