
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

import ts from 'typescript';
import {readFileSync} from 'node:fs';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let code;
function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='openHistory')code=node.getText(source);ts.forEachChild(node,find)}
find(source);
const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function harness(invoke, delayWrite=false){
 const refs={previousSession:{current:null},creatingSession:{current:false},selectionVersion:{current:0},sessionId:{current:null},selectedRecord:{current:null},outputCursor:{current:null},terminal:{current:null},fitAddon:{current:null},agentOutputWindow:{current:''},pendingOutput:{current:{drain:()=>[]}},pendingState:{current:new Map()},terminalViews:{current:new TerminalViews(2)}};
 let resets=0,focus=0;const frames=[],writes=[];
 const make=()=>{const element={style:{},inert:true};return {instance:{reset(){resets++},write(_s,done){if(delayWrite)writes.push(done);else done?.()},focus(){if(!element.inert)focus++},cols:100,rows:30},fit:{fit(){}},element,cursor:null,ready:false,dispose(){}}};
 refs.terminal.current=make().instance;refs.fitAddon.current=make().fit;
 const args={...refs,invoke,createTerminalView:make,setSession(){},setActiveProject(){},setSessionStatus(){},setTerminalNotice(){},setAgentPhase(){},updateAgentPhase(){},setError(){},document:{activeElement:{}},terminalStatuses:new Set(['succeeded','failed','stopped']),replayOutput:(s)=>({data:s.data,nextOffset:s.end_offset}),requestAnimationFrame:fn=>frames.push(fn),applyStateEvent(){}};
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
 const h=harness(async(_command,args)=>args.sessionId==='a'?new Promise(r=>release=r):({data:'B',offset:0,end_offset:1}));
 const first=h.open(record('a'));await h.open(record('b'));const b=h.refs.terminal.current;
 release({data:'A',offset:0,end_offset:1});await first;
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
 release({data:'A',offset:0,end_offset:1,status:'running'});await loading;
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
