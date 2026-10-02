
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TerminalViews} from '../src/terminal-views.ts';

test('switching reuses the exact active terminal and preserves its state',()=>{
 const pool=new TerminalViews(2);let created=0,disposed=0;
 const make=()=>({cursor:42,viewport:50,alternate:true,dispose(){disposed++}});
 const a=pool.open('a',true,()=>{created++;return make()});
 pool.open('b',true,make);
 assert.equal(pool.open('a',true,make),a);
 assert.equal(pool.all.length,2);
 assert.equal(created,1);assert.equal(disposed,0);
 assert.deepEqual([a.cursor,a.viewport,a.alternate],[42,50,true]);
});
test('budget never evicts a live TUI; only stopped least recently used views may be freed',()=>{
 const pool=new TerminalViews(2);let disposed=0;
 const make=()=>({dispose(){disposed++}});
 pool.open('a',true,make);pool.open('b',true,make);
 assert.throws(()=>pool.open('c',true,make),/limit/i);
 assert.equal(pool.size,2);assert.equal(disposed,0);
 pool.setRunning('a',false);
 pool.open('c',true,make);
 assert.equal(pool.get('a'),undefined);assert.equal(pool.size,2);assert.equal(disposed,1);
 pool.clear();assert.equal(disposed,3);assert.equal(pool.size,0);
});
test('invalid limits and failed creation cannot consume capacity',()=>{
 for(const limit of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>new TerminalViews(limit));
 const pool=new TerminalViews(1);
 assert.throws(()=>pool.open('',true,()=>{}),/session/i);
 assert.throws(()=>pool.open('a',true,()=>{throw Error('open failed')}),/open failed/);
 assert.equal(pool.size,0);assert.equal(pool.canOpen,true);
 pool.open('a',true,()=>({dispose(){}}));
 assert.equal(pool.canOpen,false);pool.setRunning('missing',false);
 pool.setRunning('a',false);assert.equal(pool.canOpen,true);
});

test('retaining selected values disposes excluded renderers once, including recoverable live views',()=>{
 const pool=new TerminalViews(2),disposed=[];
 const a=pool.open('a',true,()=>({dispose(){disposed.push('a')}}));
 const b=pool.open('b',true,()=>({dispose(){disposed.push('b')}}));
 pool.retain(value=>value===b);
 assert.equal(pool.get('a'),undefined);assert.equal(pool.get('b'),b);
 assert.equal(pool.size,1);assert.deepEqual(disposed,['a']);
 pool.retain(value=>value===b);assert.deepEqual(disposed,['a']);
 pool.clear();assert.deepEqual(disposed,['a','b']);
});

import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let code,renderCode;
function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='openHistory')code=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text==='renderFrame')renderCode=node.getText(source);ts.forEachChild(node,find)}
find(source);
const js=ts.transpileModule(renderCode+'\n'+code,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function harness(invoke, delayWrite=false, fullFrame=()=>Promise.resolve(null)){
 const refs={previousSession:{current:null},creatingSession:{current:false},selectionVersion:{current:0},sessionId:{current:null},selectedRecord:{current:null},outputCursor:{current:null},terminal:{current:null},fitAddon:{current:null},agentOutputWindow:{current:''},pendingOutput:{current:{drain:()=>[],delete(){}}},pendingState:{current:new Map()},terminalViews:{current:new TerminalViews(2)}};
 let resets=0,focus=0;const frames=[],writes=[];
 const make=id=>{const element={dataset:{sessionId:id},style:{},inert:true};return {instance:{_core:{_inputHandler:{_activeBuffer:{x:0}}},resize(cols,rows){this.cols=cols;this.rows=rows;},scrollToLine(){},reset(){resets++},write(_s,done){if(delayWrite)writes.push(done);else done?.()},focus(){if(!element.inert)focus++},cols:100,rows:30},fit:{fit(){}},element,cursor:null,ready:false,dispose(){}}};
 refs.terminal.current=make().instance;refs.fitAddon.current=make().fit;
 const args={...refs,invoke:(command,args)=>command==='read_terminal_frame'?fullFrame(args):invoke(command,args),applyTerminalFrame,validateTerminalFrame,createTerminalView:make,setSession(){},setActiveProject(){},setSessionStatus(){},setTerminalNotice(){},setAgentPhase(){},updateAgentPhase(){},setError(){},document:{activeElement:{}},terminalStatuses:new Set(['succeeded','failed','stopped']),replayOutput:(s)=>({data:s.data,nextOffset:s.end_offset}),requestAnimationFrame:fn=>frames.push(fn),applyStateEvent(){}};
 const open=new Function(...Object.keys(args),js+';return openHistory')(...Object.values(args));
 return {open,refs,frames,writes,document:args.document,get resets(){return resets},get focus(){return focus}};
}
const record=id=>({summary:{session_id:id,cwd:'/repo'},status:'running'});
test('actual selection coordinator warm-switches without replay/reset and preserves terminal ownership',async()=>{
 let reads=0;
 const h=harness(async()=>{reads++;return {data:'中文😀',offset:0,end_offset:10}});
 await h.open(record('a'));const a=h.refs.terminal.current;
 await h.open(record('b'));const b=h.refs.terminal.current;
 await h.open(record('a'));
 assert.equal(h.refs.terminal.current,a);assert.notEqual(a,b);assert.equal(reads,2);
 assert.equal(h.resets,2);
 for(const frame of h.frames)frame();
 assert.equal(h.focus,1);
});
test('slow snapshot from old selection cannot write into the newly selected terminal',async()=>{
 let release;
 const h=harness(async()=>({data:'B',offset:0,end_offset:1}),false,args=>args.sessionId==='a'?new Promise(r=>release=r):Promise.resolve(null));
 const first=h.open(record('a'));await h.open(record('b'));const b=h.refs.terminal.current;
 release(null);await first;
 assert.equal(h.refs.terminal.current,b);assert.equal(h.refs.sessionId.current,'b');assert.equal(h.resets,1);
 for(const frame of h.frames)frame();assert.equal(h.focus,1);
});

test('a delayed selection does not steal focus after the user starts searching',async()=>{
 const h=harness(async()=>({data:'B',offset:0,end_offset:1}));
 await h.open(record('b'));h.document.activeElement={name:'search'};
 for(const frame of h.frames)frame();
 assert.equal(h.focus,0);
});

test('refused admission leaves the previous in-flight selection able to complete',async()=>{
 let release;
 const h=harness(async()=>new Promise(r=>release=r));
 h.refs.terminalViews.current=new TerminalViews(1);
 const first=h.open(record('a'));await h.open(record('b'));
 release({data:'A',offset:0,end_offset:1});await first;
 assert.equal(h.refs.sessionId.current,'a');assert.equal(h.refs.outputCursor.current,1);
});

let inputCode;
function findInput(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='onData')inputCode=node.initializer.arguments[0].getText(source);ts.forEachChild(node,findInput)}
findInput(source);
const inputJs=ts.transpileModule('const handler='+inputCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
test('hidden live terminal protocol answers return to their own PTY',async()=>{
 const writes=[];
 const handler=new Function('sessionId','view','invoke','id','setError',inputJs+';return handler')({current:'b'},{cursor:10,ready:true,live:true},async(name,args)=>writes.push({name,...args}),'a',()=>{});
 handler('\x1b[1;1R');await new Promise(setImmediate);
 assert.deepEqual(writes,[{name:'write_session',sessionId:'a',data:'\x1b[1;1R'}]);
});

test('old protocol queries replayed from a cold snapshot never inject input',async()=>{
 const writes=[];
 const handler=new Function('sessionId','view','invoke','id','setError',inputJs+';return handler')({current:'a'},{cursor:10,ready:false,live:true},async(name,args)=>writes.push({name,...args}),'a',()=>{});
 handler('\x1b[1;11R');await new Promise(setImmediate);
 assert.deepEqual(writes,[]);
});
test('cold focus waits for parsing; a user focus change still wins',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}),true);
 const loading=h.open(record('a'));await new Promise(setImmediate);
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,0);
 h.writes.shift()();await loading;
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,1);
 const other=h.open(record('b'));await new Promise(setImmediate);
 h.document.activeElement={name:'search'};h.writes.shift()();await other;
 for(const frame of h.frames)frame();assert.equal(h.focus,1);
});
test('the first attachment of a newly spawned PTY answers its pending startup query',async()=>{
 const h=harness(async()=>({data:'\x1b[6n',offset:0,end_offset:4}),true);
 const loading=h.open(record('a'),true);await new Promise(setImmediate);
 const writes=[];const view=h.refs.terminalViews.current.get('a');
 const handler=new Function('sessionId','view','invoke','id','setError',inputJs+';return handler')({current:'a'},view,async(name,args)=>writes.push({name,...args}),'a',()=>{});
 handler('\x1b[1;1R');await new Promise(setImmediate);
 assert.deepEqual(writes,[{name:'write_session',sessionId:'a',data:'\x1b[1;1R'}]);
 h.writes.shift()();await loading;assert.equal(view.firstAttachment,false);
});
test('reselecting the same view waits for its pending parse before focus',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}),true);
 const first=h.open(record('a'));await new Promise(setImmediate);
 const second=h.open(record('b'));await new Promise(setImmediate);
 const again=h.open(record('a'));await new Promise(setImmediate);
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,0);
 h.writes[0]();await Promise.all([first,again]);
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,1);
 h.writes[1]();await second;
});
test('newer buffered lifecycle wins over an old running snapshot and releases capacity',async()=>{
 let release;const h=harness(async()=>new Promise(resolve=>release=resolve));h.refs.terminalViews.current=new TerminalViews(1);
 const loading=h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 h.refs.pendingState.current.set('a',{session_id:'a',status:'stopped'});view.live=false;h.refs.terminalViews.current.setRunning('a',false);
 await new Promise(setImmediate);release({data:'A',offset:0,end_offset:1,status:'running'});await loading;
 assert.equal(view.live,false);assert.equal(h.refs.terminalViews.current.canOpen,true);
});
test('warm selection cannot revive a stopped view from stale history',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}));h.refs.terminalViews.current=new TerminalViews(1);
 await h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 view.live=false;view.status='stopped';h.refs.terminalViews.current.setRunning('a',false);
 await h.open(record('a'));
 assert.equal(view.live,false);assert.equal(h.refs.terminalViews.current.canOpen,true);
 assert.equal(h.refs.selectedRecord.current.status,'stopped');
});
test('switching away before the initial snapshot keeps startup query authorization',async()=>{
 const pending=[];const h=harness(async(_name,args)=>args.sessionId==='a'?new Promise(resolve=>pending.push(resolve)):({data:'B',offset:0,end_offset:1}),true);
 const first=h.open(record('a'),true);await new Promise(setImmediate);
 const other=h.open(record('b'));await new Promise(setImmediate);h.writes.shift()();await other;
 const again=h.open(record('a'));await new Promise(setImmediate);
 const view=h.refs.terminalViews.current.get('a');assert.equal(view.firstAttachment,true);
 pending[0]({data:'old',offset:0,end_offset:3});await first;
 pending[1]({data:'\x1b[6n',offset:0,end_offset:4});await new Promise(setImmediate);
 const writes=[];const handler=new Function('sessionId','view','invoke','id','setError',inputJs+';return handler')({current:'a'},view,async(name,args)=>writes.push({name,...args}),'a',()=>{});
 handler('\x1b[1;1R');await new Promise(setImmediate);assert.equal(writes.length,1);
 h.writes.shift()();await again;assert.equal(view.firstAttachment,false);
});
let stateCode;
function findState(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='listen'&&node.arguments[0]?.text==='session-state')stateCode=node.arguments[1].getText(source);ts.forEachChild(node,findState)}
findState(source);
const stateJs=ts.transpileModule('const handler='+stateCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
let outputCode;
function findOutput(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='listen'&&node.arguments[0]?.text==='session-output')outputCode=node.arguments[1].getText(source);ts.forEachChild(node,findOutput)}findOutput(source);
const outputJs=ts.transpileModule('const handler='+outputCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
test('a newer stop during replay cannot be replaced by an older buffered running event',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}),true);h.refs.terminalViews.current=new TerminalViews(1);
 h.refs.pendingState.current.set('a',{session_id:'a',status:'running'});
 const loading=h.open(record('a'));await new Promise(setImmediate);
 const args={...h.refs,active:true,notifySession(){},refreshHistory(){},terminalStatuses:new Set(['stopped']),applyStateEvent(_term,event){h.refs.selectedRecord.current.status=event.status;}};
 const handler=new Function(...Object.keys(args),stateJs+';return handler')(...Object.values(args));
 handler({payload:{session_id:'a',status:'stopped'}});
 h.writes.shift()();await loading;
 assert.equal(h.refs.terminalViews.current.get('a').live,false);
 assert.equal(h.refs.terminalViews.current.canOpen,true);
 assert.equal(h.refs.selectedRecord.current.status,'stopped');
});
test('an older parse callback cannot enable protocol input during a new cold replay',async()=>{
 let reload;let reads=0;const h=harness(async()=>++reads===1?({data:'A',offset:0,end_offset:1}):new Promise(resolve=>reload=resolve),true);
 const first=h.open(record('a'),true);await new Promise(setImmediate);const view=h.refs.terminalViews.current.get('a');
 h.refs.pendingOutput.current.push=()=>{};
 const args={...h.refs,active:true,consumeOutput(){throw Error('gap');},updateAgentPhase(){},setError(){}};
 const output=new Function(...Object.keys(args),outputJs+';return handler')(...Object.values(args));
 output({payload:{session_id:'a',offset:2,end_offset:3,data:'X'}});
 const second=h.open(record('a'));await new Promise(setImmediate);
 h.writes.shift()();await first;
 reload({data:'\x1b[6n',offset:0,end_offset:4});await new Promise(setImmediate);
 const writes=[];const handler=new Function('view','invoke','id','setError',inputJs+';return handler')(view,async(name,args)=>writes.push({name,...args}),'a',()=>{});
 handler('\x1b[1;1R');await new Promise(setImmediate);assert.deepEqual(writes,[]);assert.equal(view.ready,false);
 h.writes.shift()();await second;assert.equal(view.ready,true);
});
let startCode;
function findStart(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='startSession')startCode=node.getText(source);ts.forEachChild(node,findStart)}findStart(source);
const startJs=ts.transpileModule(startCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
test('a pending launch keeps its final slot while existing warm terminals remain selectable',async()=>{
 let release;const h=harness(async()=>({data:'A',offset:0,end_offset:1}));
 await h.open(record('warm'));
 const args={...h.refs,starting:false,adapters:[],selectedAdapter:'shell',command:'',cwd:'/repo',prompt:'',adapterArgs:'',launchMode:'interactive',setStarting(){},setError(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(){},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:h.open,invoke:()=>new Promise(resolve=>release=resolve)};
 const start=new Function(...Object.keys(args),startJs+';return startSession')(...Object.values(args));
 const loading=start({cwd:'/repo',command:'test'});
 await h.open(record('warm'));assert.equal(h.refs.sessionId.current,'warm');
 await h.open(record('other'));
 release({session_id:'new',cwd:'/repo',status:'running'});await loading;
 assert.ok(h.refs.terminalViews.current.get('new'));
 assert.equal(h.refs.terminalViews.current.get('other'),undefined);
 assert.equal(h.refs.sessionId.current,'new');assert.equal(h.refs.creatingSession.current,false);
});

test('first selection focuses the terminal when its empty-state launch button was removed',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}));
 h.document.activeElement={isConnected:false};
 await h.open(record('a'),true);
 h.document.body={name:'body'};h.document.activeElement=h.document.body;
 for(const frame of h.frames)frame();
 assert.equal(h.focus,1);
});
test('removing the launch button still cannot steal focus from a search field',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}));
 h.document.activeElement={isConnected:false};
 await h.open(record('a'),true);
 h.document.body={name:'body'};h.document.activeElement={name:'search'};
 for(const frame of h.frames)frame();
 assert.equal(h.focus,0);
});

test('a connected launch control losing focus to the page does not authorize refocusing',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}));
 h.document.activeElement={isConnected:true};
 await h.open(record('a'));
 h.document.body={name:'body'};h.document.activeElement=h.document.body;
 for(const frame of h.frames)frame();
 assert.equal(h.focus,0);
});

test('previous session records successful navigation only and does not overwrite on reselect or capacity refusal',async()=>{
 const h=harness(async()=>({data:'B',offset:0,end_offset:1}));
 await h.open(record('a'));assert.equal(h.refs.previousSession.current,null);
 await h.open(record('b'));assert.equal(h.refs.previousSession.current,'a');
 await h.open(record('b'));assert.equal(h.refs.previousSession.current,'a');
 await h.open(record('c'));assert.equal(h.refs.previousSession.current,'a');assert.equal(h.refs.sessionId.current,'b');
 await h.open(record('a'));assert.equal(h.refs.previousSession.current,'b');
});

test('rerun titles use the actual agent and prompt instead of the open dialog selection',async()=>{
 for(const [launch,expected] of [[{adapter:'claude',mode:'interactive',prompt:null},'Claude Code'],[{adapter:'codex',mode:'task',prompt:'Original task'},'Original task'],[null,'Interactive shell']]){
  let titles={};const args={starting:false,creatingSession:{current:false},terminalViews:{current:{canOpen:true}},adapters:[{id:'shell',label:'System shell'},{id:'claude',label:'Claude Code'},{id:'codex',label:'OpenAI Codex'}],selectedAdapter:'shell',command:'',cwd:'/repo',prompt:'Unsubmitted draft',adapterArgs:'',launchMode:'interactive',setStarting(){},setError(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(update){titles=update({})},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:async()=>{},terminal:{current:null},invoke:async()=>({session_id:'new',cwd:'/repo',status:'running',command:null,launch})};
  const start=new Function(...Object.keys(args),startJs+';return startSession')(...Object.values(args));
  await start({cwd:'/repo',command:'',launch});assert.equal(titles.new,expected);
 }
});

const full=id=>({projection:{version:1,instance:'a'.repeat(64),session:id,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:4,data:'FULL',cols:20,rows:8,cursorX:20,viewport:0,buffer:'normal'},end_offset:42,status:'running'});
test('actual coordinator restores a full scene without reading a log or answering its old protocol',async()=>{
 const h=harness(async command=>{if(command==='read_session_snapshot')throw Error('log replay is forbidden for a full scene');return null;},false,async args=>full(args.sessionId));
 await h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 assert.equal(view.projection,true);assert.equal(view.instance.cols,20);assert.equal(view.instance.rows,8);assert.equal(view.instance._core._inputHandler._activeBuffer.x,20);assert.equal(view.cursor,42);assert.equal(view.notice,null);
 await h.open(record('a'));assert.equal(h.resets,1);
});

test('successful full-scene selection releases ended hidden renderers and reconstructs on return',async()=>{
 const h=harness(async()=>{throw Error('full scene must not replay logs')},false,async args=>({...full(args.sessionId),status:'stopped',persisted:true}));
 await h.open(record('a'));const a=h.refs.terminal.current;
 await h.open(record('b'));assert.equal(h.refs.terminalViews.current.size,1);
 assert.equal(h.refs.terminalViews.current.get('a'),undefined);
 await h.open(record('c'));assert.equal(h.refs.sessionId.current,'c');
 await h.open(record('a'));assert.notEqual(h.refs.terminal.current,a);
 assert.equal(h.refs.terminalViews.current.size,1);
 assert.equal(h.refs.terminal.current._core._inputHandler._activeBuffer.x,20);
 assert.equal(h.refs.outputCursor.current,42);
});

test('live projections stay cached and receive every window resize, including a pending size reversal',async()=>{
 const h=harness(async()=>null,false,async args=>full(args.sessionId));
 await h.open(record('a'));await h.open(record('b'));
 assert.ok(h.refs.terminalViews.current.get('a'));
 let resizeCode;
 function findResize(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='resize')resizeCode=node.initializer.getText(source);ts.forEachChild(node,findResize)}
 findResize(source);assert.ok(resizeCode);
 const calls=[];h.refs.terminal.current.resize(100,30);
 const args={...h.refs,invoke:async(name,value)=>calls.push({name,...value})};
 const resize=new Function(...Object.keys(args),ts.transpileModule('const resize='+resizeCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return resize')(...Object.values(args));
 h.refs.terminalViews.current.get('a').instance.resize(100,30);
 resize();assert.ok(calls.some(call=>call.sessionId==='a'&&call.cols===100&&call.rows===30));
 h.refs.terminal.current.resize(20,8);h.refs.terminalViews.current.get('a').instance.resize(20,8);
 resize();assert.ok(calls.some(call=>call.sessionId==='a'&&call.cols===20&&call.rows===8));
 const a=h.refs.terminalViews.current.get('a');await h.open(record('a'));
 assert.equal(h.refs.terminalViews.current.get('a'),a);
});

test('hidden legacy, parsing and updating views remain retained',async()=>{
 for(const state of [{projection:false},{projection:true,parsing:Promise.resolve()},{projection:true,updating:true}]){
  const h=harness(async()=>null,false,async args=>({...full(args.sessionId),status:'stopped',persisted:true}));
  await h.open(record('a'));const a=h.refs.terminalViews.current.get('a');Object.assign(a,state);
  await h.open(record('b'));assert.equal(h.refs.terminalViews.current.get('a'),a);
 }
});

test('an ended renderer without a verified saved frame remains the full-scene fallback',async()=>{
 for(const persisted of [undefined,false]){
  let saved=true,logs=0;
  const h=harness(async()=>{logs++;return {data:'incomplete log',offset:0,end_offset:42}},false,async args=>
   args.sessionId==='a'&&!saved?null:{...full(args.sessionId),status:'stopped',persisted});
  await h.open(record('a'));const a=h.refs.terminalViews.current.get('a');saved=false;
  await h.open(record('b'));assert.equal(h.refs.terminalViews.current.get('a'),a);
  await h.open(record('a'));assert.equal(h.refs.terminal.current,a.instance);assert.equal(logs,0);
 }
});

test('failed or stale frame selection cannot discard the current renderer',async()=>{
 let reject,release;
 const h=harness(async()=>null,false,args=>args.sessionId==='b'?new Promise((resolve,fail)=>{release=resolve;reject=fail}):Promise.resolve(full(args.sessionId)));
 await h.open(record('a'));const a=h.refs.terminalViews.current.get('a');
 const failed=h.open(record('b'));reject(Error('offline'));await failed;
 assert.equal(h.refs.terminalViews.current.get('a'),a);
 const stale=h.open(record('b'));await h.open(record('a'));release(full('b'));await stale;
 assert.equal(h.refs.sessionId.current,'a');assert.equal(h.refs.terminalViews.current.get('a'),a);
});
test('a late running projection cannot revive a newer stopped lifecycle',async()=>{
 let release;const h=harness(async()=>null,false,()=>new Promise(resolve=>release=resolve));
 const loading=h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 view.lifecycleRevision=1;view.status='stopped';view.live=false;
 release(full('a'));await loading;
 assert.equal(view.live,false);assert.equal(view.status,'stopped');
});


test('actual background recovery invalidates old frames without claiming a buffer overflow',()=>{
 let callback;
 function locate(node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='listen'&&node.arguments[0]?.text==='background-gap')callback=node.arguments[1].getText(source);
  ts.forEachChild(node,locate);
 }
 locate(source);assert.ok(callback);
 const callbackJs=ts.transpileModule('const callback='+callback,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 for(const missing of [false,true]){
  const view={cursor:9,ready:true,firstAttachment:true,dirty:false,lifecycleRevision:4,viewportRevision:2};
  let clears=0,refreshes=0,reopens=0;const errors=[];
  const args={terminalViews:{current:{all:[view]}},outputCursor:{current:9},pendingOutput:{current:{clear(){clears++}}},setError:message=>errors.push(message),refreshHistory(){refreshes++},selectedRecord:{current:{id:'a'}},openHistory(){reopens++}};
  const onGap=new Function(...Object.keys(args),callbackJs+';return callback')(...Object.values(args));
  onGap({payload:{missing_events:missing}});
  assert.equal(view.cursor,null);assert.equal(view.ready,false);assert.equal(view.dirty,true);
  assert.equal(view.lifecycleRevision,5);assert.equal(view.viewportRevision,3);
  assert.equal(args.outputCursor.current,null);assert.equal(clears,1);assert.equal(refreshes,1);assert.equal(reopens,1);
  assert.equal(errors.length,missing?1:0);
 }
});
