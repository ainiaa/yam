import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,TERMINAL_SCROLLBACK_LINES} from '../src/terminal-frame.ts';
import * as layoutOperations from '../src/terminal-layout.ts';
import {terminalPaneId,terminalPaneIndex} from '../src/terminal-layout.ts';

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TerminalViews} from '../src/terminal-views.ts';
import {createTerminalLayout,assignTerminalPane,isTerminalProtocolResponse} from '../src/terminal-layout.ts';

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
import {readFileSync as rawReadFileSync} from 'node:fs';
import {queueTerminalResize} from '../src/terminal-settings.ts';
import {createTerminalScroll,updateTerminalScroll} from '../src/terminal-scroll.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let code,renderCode,syncCode,fitCode;
const layoutHelpers=[];
function find(node){if(ts.isFunctionDeclaration(node)&&["claimWindowView","refreshTerminalScroll","cancelLayoutRestore","finishLayoutRestore","terminalPaneVisible","terminalPaneHasSize","terminalHasInputFocus","syncNotificationContext","showTerminalLayout","focusTerminalPane"].includes(node.name?.text))layoutHelpers.push(node.getText(source));if(ts.isFunctionDeclaration(node)&&node.name?.text==='syncViewSize')syncCode=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text==='fitTerminalViews')fitCode=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text==='openHistory')code=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text==='renderFrame')renderCode=node.getText(source);ts.forEachChild(node,find)}
find(source);
const js=ts.transpileModule(layoutHelpers.join('\n')+'\n'+syncCode+'\n'+renderCode+'\n'+code,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function harness(invoke, delayWrite=false, fullFrame=()=>Promise.resolve(null)){
 const refs={conversationOpenRef:{current:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},ownerConnectionAvailable:{current:{available:true,version:0}},terminalLayoutRef:{current:createTerminalLayout()},paneHosts:{current:new Map()},terminalHost:{current:null},pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},viewClaimSelection:{current:0},pendingViewClaims:{current:new Map()},paneClaimSelection:{current:new Map()},detailVersion:{current:0},previousSession:{current:null},creatingSession:{current:false},selectionVersion:{current:0},sessionId:{current:null},selectedRecord:{current:null},outputCursor:{current:null},terminal:{current:null},fitAddon:{current:null},agentOutputWindow:{current:''},pendingOutput:{current:{drain:()=>[],delete(){}}},pendingState:{current:new Map()},terminalViews:{current:new TerminalViews(2)}};
 let resets=0,focus=0,recoveryChanges=0;const frames=[],writes=[],dataWrites=[];
 const make=(id,appearance)=>{const element={dataset:{sessionId:id},style:{},inert:true,getBoundingClientRect:()=>({width:600,height:400}),contains:()=>false};return {desktopGeneration:1,appearance:appearance?{...appearance}:undefined,instance:{refresh(){},options:{scrollback:TERMINAL_SCROLLBACK_LINES},_core:{_inputHandler:{_activeBuffer:{x:0}}},resize(cols,rows){this.cols=cols;this.rows=rows;},scrollToLine(){},reset(){resets++},write(_s,done){dataWrites.push(_s);if(delayWrite)writes.push(done);else done?.()},focus(){if(!element.inert)focus++},cols:100,rows:30},fit:{fit(){}},element,cursor:null,ready:false,writable:false,disposed:false,resizePending:null,resizing:false,viewportRevision:0,dispose(){this.disposed=true;}}};
 refs.terminal.current=make().instance;refs.fitAddon.current=make().fit;
 const args={refreshSelectedAgent(){},isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){recoveryChanges++;},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},requestTerminalLayoutFit(){},...refs,assignTerminalPane,setTerminalLayout(next){refs.terminalLayoutRef.current=next;},queueTerminalResize,invoke:(command,args)=>command==='claim_terminal_view'?Promise.resolve(1):command==='release_terminal_view'?Promise.resolve(null):command==='set_agent_notification_context'?Promise.resolve(null):command==='read_terminal_frame'?fullFrame(args):invoke(command,args),applyTerminalFrame,terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,validateTerminalFrame,createTerminalView:make,setSession(){},setActiveProject(){},setSessionStatus(){},setTerminalNotice(){},setAgentPhase(){},setSelectedAgent(){},updateAgentPhase(){},setError(){},document:{activeElement:{},hasFocus:()=>true},terminalStatuses:new Set(['succeeded','failed','stopped']),replayOutput:(s)=>({data:s.data,nextOffset:s.end_offset}),requestAnimationFrame:fn=>frames.push(fn),applyStateEvent(){}};
 const open=new Function(...Object.keys(args),js+';return openHistory')(...Object.values(args));
 return {open,render:new Function(...Object.keys(args),js+';return renderFrame')(...Object.values(args)),args,refs,frames,writes,dataWrites,get recoveryChanges(){return recoveryChanges},document:args.document,get resets(){return resets},get focus(){return focus}};
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
 const first=h.open(record('a'));await new Promise(setImmediate);await h.open(record('b'));const b=h.refs.terminal.current;
 release(null);await first;
 assert.equal(h.refs.terminal.current,b);assert.equal(h.refs.sessionId.current,'b');assert.equal(h.resets,2);assert.equal(h.refs.terminalViews.current.get('a').ready,true,'hidden member may finish its own parser without changing selection');
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
 const first=h.open(record('a'));await new Promise(setImmediate);await h.open(record('b'));
 release({data:'A',offset:0,end_offset:1});await first;
 assert.equal(h.refs.sessionId.current,'a');assert.equal(h.refs.outputCursor.current,1);
});

let inputCode;
function findInput(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='bindData')inputCode='(()=>{const instance={onData:handler=>handler};return ('+node.initializer.getText(source)+')();})()';ts.forEachChild(node,findInput)}
findInput(source);
const inputJs=ts.transpileModule('const terminalHasInputFocus=()=>false;const terminalPaneVisible=()=>true;const terminalPaneHasSize=()=>true;const isTerminalProtocolResponse='+isTerminalProtocolResponse.toString()+';\n'+syncCode+'\nconst handler='+inputCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
test('hidden live terminal protocol answers return to their own PTY',async()=>{
 const writes=[];
 const handler=new Function('queueTerminalResize','sessionId','view','invoke','id','setError','ownerConnectionAvailable',inputJs+';return handler')(queueTerminalResize,{current:'b'},{cursor:10,ready:true,live:true,instance:{refresh(){},cols:0,rows:0},element:{dataset:{sessionId:'a'}}},async(name,args)=>{if(name!=="resize_session")writes.push({name,...args});},'a',()=>{},{current:{available:true,version:0}});
 handler('\x1b[1;1R');await new Promise(setImmediate);
 assert.deepEqual(writes,[{name:'write_session',desktopGeneration:undefined,sessionId:'a',data:'\x1b[1;1R'}]);
});

test('old protocol queries replayed from a cold snapshot never inject input',async()=>{
 const writes=[];
 const handler=new Function('queueTerminalResize','sessionId','view','invoke','id','setError','ownerConnectionAvailable',inputJs+';return handler')(queueTerminalResize,{current:'a'},{cursor:10,ready:false,live:true},async(name,args)=>{if(name!=="resize_session")writes.push({name,...args});},'a',()=>{},{current:{available:true,version:0}});
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
 const handler=new Function('queueTerminalResize','sessionId','view','invoke','id','setError','ownerConnectionAvailable',inputJs+';return handler')(queueTerminalResize,{current:'a'},view,async(name,args)=>{if(name!=="resize_session")writes.push({name,...args});},'a',()=>{},h.refs.ownerConnectionAvailable);
 handler('\x1b[1;1R');await new Promise(setImmediate);
 assert.deepEqual(writes,[{name:'write_session',desktopGeneration:1,sessionId:'a',data:'\x1b[1;1R'}]);
 h.writes.shift()();await loading;assert.equal(view.firstAttachment,false);
});
test('reselecting the same view waits for its pending parse before focus',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}),true);
 const first=h.open(record('a'));await new Promise(setImmediate);await new Promise(setImmediate);
 const second=h.open(record('b'));await new Promise(setImmediate);
 const again=h.open(record('a'));await new Promise(setImmediate);
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,0);
 h.writes[0]();await Promise.all([first,again]);
 for(const frame of h.frames.splice(0))frame();assert.equal(h.focus,1);
 h.writes[1]();await second;
});
test('newer buffered lifecycle wins over an old running snapshot and releases capacity',async()=>{
 let release;const h=harness(async()=>new Promise(resolve=>release=resolve));h.refs.terminalViews.current=new TerminalViews(1);
 const loading=h.open(record('a'));await new Promise(setImmediate);const view=h.refs.terminalViews.current.get('a');
 h.refs.pendingState.current.set('a',{session_id:'a',status:'stopped'});view.live=false;h.refs.terminalViews.current.setRunning('a',false);
 await new Promise(setImmediate);release({data:'A',offset:0,end_offset:1,status:'running'});await loading;
 assert.equal(view.live,false);assert.equal(h.refs.terminalViews.current.canOpen,false);h.refs.terminalLayoutRef.current.panes=[null];h.refs.terminalViews.current.setProtected([]);assert.equal(h.refs.terminalViews.current.canOpen,true);
});
test('warm selection cannot revive a stopped view from stale history',async()=>{
 const h=harness(async()=>({data:'A',offset:0,end_offset:1}));h.refs.terminalViews.current=new TerminalViews(1);
 await h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 view.live=false;view.status='stopped';h.refs.terminalViews.current.setRunning('a',false);
 await h.open(record('a'));
 assert.equal(view.live,false);assert.equal(h.refs.terminalViews.current.canOpen,false);h.refs.terminalLayoutRef.current.panes=[null];h.refs.terminalViews.current.setProtected([]);assert.equal(h.refs.terminalViews.current.canOpen,true);
 assert.equal(h.refs.selectedRecord.current.status,'stopped');
});
test('switching away before the initial snapshot keeps startup query authorization',async()=>{
 const pending=[];const h=harness(async(_name,args)=>args.sessionId==='a'?new Promise(resolve=>pending.push(resolve)):({data:'B',offset:0,end_offset:1}),true);
 const first=h.open(record('a'),true);await new Promise(setImmediate);await new Promise(setImmediate);
 const other=h.open(record('b'));await new Promise(setImmediate);h.writes.shift()();await other;
 const again=h.open(record('a'));await new Promise(setImmediate);
 const view=h.refs.terminalViews.current.get('a');assert.equal(view.firstAttachment,true);
 pending[0]({data:'old',offset:0,end_offset:3});await first;
 pending[1]({data:'\x1b[6n',offset:0,end_offset:4});await new Promise(setImmediate);
 const writes=[];const handler=new Function('queueTerminalResize','sessionId','view','invoke','id','setError','ownerConnectionAvailable',inputJs+';return handler')(queueTerminalResize,{current:'a'},view,async(name,args)=>{if(name!=="resize_session")writes.push({name,...args});},'a',()=>{},h.refs.ownerConnectionAvailable);
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
 const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.refs,active:true,notifySession(){},refreshHistory(){},terminalStatuses:new Set(['stopped']),applyStateEvent(_term,event){h.refs.selectedRecord.current.status=event.status;}};
 const handler=new Function(...Object.keys(args),stateJs+';return handler')(...Object.values(args));
 handler({payload:{session_id:'a',status:'stopped'}});
 h.writes.shift()();await loading;
 assert.equal(h.refs.terminalViews.current.get('a').live,false);
 assert.equal(h.refs.terminalViews.current.canOpen,false);h.refs.terminalLayoutRef.current.panes=[null];h.refs.terminalViews.current.setProtected([]);assert.equal(h.refs.terminalViews.current.canOpen,true);
 assert.equal(h.refs.selectedRecord.current.status,'stopped');
});
test('an older parse callback cannot enable protocol input during a new cold replay',async()=>{
 let reload;let reads=0;const h=harness(async()=>++reads===1?({data:'A',offset:0,end_offset:1}):new Promise(resolve=>reload=resolve),true);
 const first=h.open(record('a'),true);await new Promise(setImmediate);await new Promise(setImmediate);const view=h.refs.terminalViews.current.get('a');
 h.refs.pendingOutput.current.push=()=>{};
 const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.refs,active:true,consumeOutput(){throw Error('gap');},updateAgentPhase(){},setError(){}};
 const output=new Function(...Object.keys(args),outputJs+';return handler')(...Object.values(args));
 output({payload:{session_id:'a',offset:2,end_offset:3,data:'X'}});
 const second=h.open(record('a'));await new Promise(setImmediate);
 h.writes.shift()();await first;
 reload({data:'\x1b[6n',offset:0,end_offset:4});await new Promise(setImmediate);
 const writes=[];const handler=new Function('queueTerminalResize','view','invoke','id','setError','ownerConnectionAvailable',inputJs+';return handler')(queueTerminalResize,view,async(name,args)=>{if(name!=="resize_session")writes.push({name,...args});},'a',()=>{},h.refs.ownerConnectionAvailable);
 handler('\x1b[1;1R');await new Promise(setImmediate);assert.deepEqual(writes,[]);assert.equal(view.ready,false);
 h.writes.shift()();await second;assert.equal(view.ready,true);
});
let startCode,metadataCode;
function findStart(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='startSession')startCode=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text==='migrateTerminalMetadata')metadataCode=node.getText(source);ts.forEachChild(node,findStart)}findStart(source);
const startJs=ts.transpileModule(startCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function continuationHarness({titles={},pins=[],fail=false,nextId}={}){
 const titlesRef={current:{...titles}},pinnedSessionsRef={current:[...pins]},calls=[],opened=[],errors=[],writes=[];let serial=1;
 const provider={id:'custom',model:'provider/model',base_url:'http://127.0.0.1:3425',api_key_env:'MAGPIE_API_KEY'},launch={adapter:'codex',mode:'interactive',extra_args:'',prompt:null,provider};
 const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:layoutOperations.createTerminalLayout()},starting:false,creatingSession:{current:false},terminalViews:{current:new TerminalViews(16)},adapters:[{id:'shell',label:'System shell'},{id:'codex',label:'OpenAI Codex'}],selectedAdapter:'shell',command:'',cwd:'/unrelated/form',prompt:'Unsubmitted draft',adapterArgs:'',launchMode:'interactive',setStarting(){},setError:error=>errors.push(error),setActiveProject(){},setCollapsedProjects(){},setSessionTitles:update=>{titlesRef.current=typeof update==='function'?update(titlesRef.current):update;},setPinnedSessions:update=>{pinnedSessionsRef.current=update;},titlesRef,pinnedSessionsRef,localStorage:{getItem:()=>null,setItem:(key,value)=>writes.push([key,value])},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:async record=>{opened.push(record);},terminal:{current:null},invoke:async(name,parameters)=>{calls.push({name,parameters});if(fail)throw Error('Continuation failed');return {session_id:nextId??`run-${++serial}`,cwd:'/repo',status:'running',command:null,launch};}};
 const code=ts.transpileModule(layoutHelpers.join('\n')+'\n'+metadataCode+'\n'+startCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const start=new Function(...Object.keys(args),code+';return startSession;')(...Object.values(args));
 return {start,titlesRef,pinnedSessionsRef,calls,opened,errors,writes,launch};
}
test('T2 two explicit continuations preserve custom title and pin without a history-page migration',async()=>{
 const h=continuationHarness({titles:{'run-1':'Release review','other':'Keep other'},pins:['run-1','other']});
 await h.start({resumeFrom:'run-1'});
 assert.equal(h.titlesRef.current['run-2'],'Release review');assert.deepEqual(h.pinnedSessionsRef.current,['run-2','other']);
 await h.start({resumeFrom:'run-2'});
 assert.equal(h.titlesRef.current['run-3'],'Release review');assert.deepEqual(h.pinnedSessionsRef.current,['run-3','other']);assert.equal(h.titlesRef.current.other,'Keep other');
 assert.deepEqual(h.calls,[{name:'create_session',parameters:{resumeFrom:'run-1',cwd:null,command:null,launch:null}},{name:'create_session',parameters:{resumeFrom:'run-2',cwd:null,command:null,launch:null}}]);
 assert.deepEqual(h.opened.map(record=>record.summary.launch),[h.launch,h.launch]);assert.deepEqual(h.errors.filter(Boolean),[]);
});
test('T2 unnamed continuation gets a fallback while an existing next-run title remains authoritative',async()=>{
 const unnamed=continuationHarness();await unnamed.start({resumeFrom:'run-1'});assert.equal(unnamed.titlesRef.current['run-2'],'Continue codex');
 const named=continuationHarness({titles:{'run-1':'Old title','run-2':'Already attached title'},nextId:'run-2'});await named.start({resumeFrom:'run-1'});assert.equal(named.titlesRef.current['run-2'],'Already attached title');
 const reattach=continuationHarness({titles:{'run-1':'Current title'},pins:['run-1'],nextId:'run-1'});await reattach.start({resumeFrom:'run-1'});assert.equal(reattach.titlesRef.current['run-1'],'Current title');assert.deepEqual(reattach.pinnedSessionsRef.current,['run-1']);
});
test('T2 a failed continuation preserves names, pins and stored metadata',async()=>{
 const h=continuationHarness({titles:{'run-1':'Keep me'},pins:['run-1'],fail:true});await h.start({resumeFrom:'run-1'});
 assert.deepEqual(h.titlesRef.current,{'run-1':'Keep me'});assert.deepEqual(h.pinnedSessionsRef.current,['run-1']);assert.deepEqual(h.writes,[]);assert.deepEqual(h.opened,[]);assert.deepEqual(h.errors.filter(Boolean),['Continuation failed']);
});
test('a pending launch keeps its final slot while existing warm terminals remain selectable',async()=>{
 let release;const h=harness(async()=>({data:'A',offset:0,end_offset:1}));
 await h.open(record('warm'));
 const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},...h.refs,starting:false,adapters:[],selectedAdapter:'shell',command:'',cwd:'/repo',prompt:'',adapterArgs:'',launchMode:'interactive',setStarting(){},setError(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(){},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:h.open,invoke:()=>new Promise(resolve=>release=resolve)};
 const start=new Function(...Object.keys(args),ts.transpileModule(layoutHelpers.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+startJs+';return startSession')(...Object.values(args));
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
  let titles={};const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:layoutOperations.createTerminalLayout()},starting:false,creatingSession:{current:false},terminalViews:{current:new TerminalViews(16)},adapters:[{id:'shell',label:'System shell'},{id:'claude',label:'Claude Code'},{id:'codex',label:'OpenAI Codex'}],selectedAdapter:'shell',command:'',cwd:'/repo',prompt:'Unsubmitted draft',adapterArgs:'',launchMode:'interactive',setStarting(){},setError(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(update){titles=update({})},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:async()=>{},terminal:{current:null},invoke:async()=>({session_id:'new',cwd:'/repo',status:'running',command:null,launch})};
  const start=new Function(...Object.keys(args),ts.transpileModule(layoutHelpers.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+startJs+';return startSession')(...Object.values(args));
  await start({cwd:'/repo',command:'',launch});assert.equal(titles.new,expected);
 }
});

const full=id=>({projection:{version:1,instance:'a'.repeat(64),session:id,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:4,data:'FULL',cols:20,rows:8,cursorX:20,viewport:0,buffer:'normal'},end_offset:42,status:'running'});
test('actual coordinator restores a full scene without reading a log or answering its old protocol',async()=>{
 const h=harness(async command=>{if(command==='read_session_snapshot')throw Error('log replay is forbidden for a full scene');return null;},false,async args=>full(args.sessionId));
 await h.open(record('a'));const view=h.refs.terminalViews.current.get('a');
 assert.equal(view.projection,true);assert.equal(view.instance.cols,20);assert.equal(view.instance.rows,8);assert.equal(view.instance._core._inputHandler._activeBuffer.x,20);assert.equal(view.cursor,42);assert.equal(view.notice,null);
 assert.equal(h.dataWrites.length,1);await h.open(record('a'));assert.equal(h.dataWrites.length,1,'warm selection must not reapply the full scene');
});

test('successful full-scene selection retains ended member tabs and only reconstructs removed views',async()=>{
 const h=harness(async()=>{throw Error('full scene must not replay logs')},false,async args=>({...full(args.sessionId),status:'stopped',persisted:true}));
 await h.open(record('a'));const a=h.refs.terminal.current;
 await h.open(record('b'));assert.equal(h.refs.terminalViews.current.size,2);assert.equal(h.refs.terminalViews.current.get('a').instance,a);
 await h.open(record('c'));assert.equal(h.refs.sessionId.current,'b','all member views are protected at the fixture two-view budget');
 await h.open(record('a'));assert.equal(h.refs.terminal.current,a);
 h.refs.terminalLayoutRef.current=layoutOperations.removeTerminalTab(h.refs.terminalLayoutRef.current,0,'b');
 await h.open(record('c'));assert.equal(h.refs.sessionId.current,'c');assert.equal(h.refs.terminalViews.current.get('b'),undefined,'ended nonmember remains evictable');
 assert.equal(h.refs.terminalViews.current.size,2);assert.equal(h.refs.terminal.current._core._inputHandler._activeBuffer.x,20);assert.equal(h.refs.outputCursor.current,42);
});

test('visible live projections stay cached and receive every window resize, including a pending size reversal',async()=>{
 const h=harness(async()=>null,false,async args=>full(args.sessionId));
 await h.open(record('a'));await h.open(record('b'));
 assert.ok(h.refs.terminalViews.current.get('a'));
 let resizeCode;
 function findResize(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='resize')resizeCode=node.initializer.getText(source);ts.forEachChild(node,findResize)}
 findResize(source);assert.ok(resizeCode);
 const calls=[];h.refs.terminal.current.resize(100,30);
 h.refs.terminalLayoutRef.current={mode:'horizontal',panes:['a','b'],focused:1,revision:1};
 const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.refs,terminalPaneVisible:id=>h.refs.terminalLayoutRef.current.panes.includes(id),terminalPaneHasSize:view=>view.element.getBoundingClientRect().width>0,queueTerminalResize,setError:()=>{},invoke:async(name,value)=>calls.push({name,...value})};
 for(const view of h.refs.terminalViews.current.all)view.writable=true;
 const resize=new Function(...Object.keys(args),ts.transpileModule(layoutHelpers.join('\n')+'\n'+syncCode+'\n'+fitCode+'\nconst resize='+resizeCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return resize')(...Object.values(args));
 h.refs.terminalViews.current.get('a').instance.resize(100,30);
 resize();assert.ok(calls.some(call=>call.sessionId==='a'&&call.cols===100&&call.rows===30));
 h.refs.terminal.current.resize(20,8);h.refs.terminalViews.current.get('a').instance.resize(20,8);
 resize();await new Promise(setImmediate);assert.ok(calls.some(call=>call.sessionId==='a'&&call.cols===20&&call.rows===8));
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
 const failed=h.open(record('b'));await new Promise(setImmediate);reject(Error('offline'));await failed;
 assert.equal(h.refs.terminalViews.current.get('a'),a);
 const stale=h.open(record('b'));await new Promise(setImmediate);await h.open(record('a'));release(full('b'));await stale;
 assert.equal(h.refs.sessionId.current,'a');assert.equal(h.refs.terminalViews.current.get('a'),a);
});
test('a late running projection cannot revive a newer stopped lifecycle',async()=>{
 let release;const h=harness(async()=>null,false,()=>new Promise(resolve=>release=resolve));
 const loading=h.open(record('a'));await new Promise(setImmediate);const view=h.refs.terminalViews.current.get('a');
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
 const callbackJs=ts.transpileModule(layoutHelpers.join('\n')+'\nconst callback='+callback,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 for(const missing of [false,true]){
  const view={record:{id:'a'},cursor:9,ready:true,firstAttachment:true,dirty:false,lifecycleRevision:4,viewportRevision:2};
  let clears=0,refreshes=0,reopens=0;const errors=[];
  const args={isMainWindow:true,desktopWindow:{restore_blocked:false},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},setTerminalPaneZoom(){},...layoutOperations,terminalPaneId,terminalPaneIndex,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:{panes:['a']}},terminalViews:{current:{all:[view],get:()=>view}},outputCursor:{current:9},pendingOutput:{current:{clear(){clears++}}},setError:message=>errors.push(message),refreshHistory(){refreshes++},selectedRecord:{current:{id:'a'}},openHistory(){reopens++}};
  const onGap=new Function(...Object.keys(args),callbackJs+';return callback')(...Object.values(args));
  onGap({payload:{missing_events:missing}});
  assert.equal(view.cursor,null);assert.equal(view.ready,false);assert.equal(view.dirty,true);
  assert.equal(view.lifecycleRevision,5);assert.equal(view.viewportRevision,3);
  assert.equal(args.outputCursor.current,null);assert.equal(clears,1);assert.equal(refreshes,1);assert.equal(reopens,1);
  assert.equal(errors.length,missing?1:0);
 }
});


test('T10 explicit newly created or continued first attachment synchronizes its initial dimensions',async()=>{
 for(const launch of ['new','continue']){
  const calls=[],h=harness(async(name,args)=>{calls.push({name,...args});return null;},false,async args=>full(args.sessionId));
  await h.open(record('a'),true);for(const frame of h.frames)frame();await new Promise(setImmediate);
  assert.equal(h.refs.terminalViews.current.get('a').writable,true,launch+' owns its new first attachment');assert.ok(calls.some(call=>call.name==='resize_session'&&call.sessionId==='a'&&call.cols===20&&call.rows===8));
 }
});

test('A02c1 actual openHistory first factory consumes initial appearance and warm reuse does not overwrite it',async()=>{
 const h=harness(async()=>({data:'',offset:0,end_offset:0})),appearance={fontFamily:'Profile',fontSize:20,theme:'solarized'};
 await h.open(record('profile'),true,undefined,undefined,undefined,appearance);const first=h.refs.terminalViews.current.get('profile');assert.deepEqual(first.appearance,appearance);appearance.fontSize=10;assert.equal(first.appearance.fontSize,20);
 await h.open(record('profile'),false,undefined,undefined,undefined,{fontFamily:'Other',fontSize:13,theme:'light'});assert.equal(h.refs.terminalViews.current.get('profile'),first);assert.equal(first.appearance.fontSize,20);assert.equal(first.appearance.theme,'solarized');
 first.dispose();h.refs.terminalViews.current.clear();await h.open(record('profile'));assert.equal(h.refs.terminalViews.current.get('profile').appearance,undefined,'history cold factory has no stored profile argument');
});

test('A07a actual frame receiver caches live directory without changing launch cwd and clears persisted claims',async()=>{
 let frame={...full('a'),reported_cwd:{path:'/reported',sequence:1}};
 const h=harness(async()=>({data:'',offset:0,end_offset:0}),false,async()=>frame);
 await h.open(record('a'));const view=h.refs.terminalViews.current.get('a');assert.equal(view.reportedCwd,'/reported');
 assert.equal(h.refs.selectedRecord.current.summary.cwd,'/repo');
 await h.open(record('b'));await h.open(record('a'));assert.equal(h.refs.terminalViews.current.get('a'),view);assert.equal(view.reportedCwd,'/reported');
 frame={...full('a'),status:'stopped',persisted:true,reported_cwd:{path:'/obsolete',sequence:2}};
 await h.open({...record('a'),status:'stopped'},true);assert.equal(view.reportedCwd,null);
});

test('A07a actual callback rejects sequence regression, clears legacy/latest invalid and avoids repeated-path React refresh',async()=>{
 const h=harness(async()=>({data:'',offset:0,end_offset:0}),false,async()=>({...full('a'),reported_cwd:{path:'/first',sequence:4}}));await h.open(record('a'));const v=h.refs.terminalViews.current.get('a');let changes=h.recoveryChanges;
 await h.render(v,'a',{...full('a'),reported_cwd:{path:'/first',sequence:5}},0);assert.equal(h.recoveryChanges,changes);assert.equal(v.reportedCwdSequence,5);
 await h.render(v,'a',{...full('a'),reported_cwd:{path:'/stale',sequence:3}},0);assert.equal(v.reportedCwd,'/first');assert.equal(h.recoveryChanges,changes);
 await h.render(v,'a',{...full('a'),reported_cwd:{path:null,sequence:6}},0);assert.equal(v.reportedCwd,null);assert.equal(h.recoveryChanges,changes+1);
 await h.render(v,'a',{...full('a'),reported_cwd:{path:'/second',sequence:7}},0);assert.equal(v.reportedCwd,'/second');await h.render(v,'a',full('a'),0);assert.equal(v.reportedCwd,null);
 await h.render(v,'a',{...full('a'),reported_cwd:{path:'/third',sequence:8}},0);await h.render(v,'a',{...full('a'),reported_cwd:'bad'},0);assert.equal(v.reportedCwd,null);
});
test('A07a old frame/connection/view identity cannot publish and changed live owner clears claim',async()=>{
 const h=harness(async()=>({data:'',offset:0,end_offset:0}),false,async()=>({...full('a'),reported_cwd:{path:'/current',sequence:4}}));await h.open(record('a'));const v=h.refs.terminalViews.current.get('a');
 await h.render(v,'a',{...full('a'),projection:{...full('a').projection,revision:3},reported_cwd:{path:'/old',sequence:5}},0);assert.equal(v.reportedCwd,'/current');
 await assert.rejects(h.render(v,'a',{...full('a'),projection:{...full('a').projection,instance:'b'.repeat(64)},reported_cwd:{path:'/new-owner',sequence:1}},0),/owner changed/);assert.equal(v.reportedCwd,null);
});
test('A07a actual JSX reported-directory label is plain text and launch cwd remains separately rendered',()=>{
 let label;function scan(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='aria-label'&&a.initializer?.text==='Terminal-reported directory'))label=n.getText(source);ts.forEachChild(n,scan);}scan(source);assert.ok(label);
 const React={createElement:(type,props,...children)=>({type,props,children})};
 const render=(view)=>new Function('React','scrollView','ownerConnectionAvailable','terminalPaneVisible','session',ts.transpileModule('const tree='+label,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText+';return tree')(React,view,{current:{available:true}},()=>true,{session_id:'a',cwd:'/launch'});
 const live={ready:true,disposed:false,live:true,persisted:false,availability:'available',reportedCwd:'<a href="file:///claim">/claim</a>'};const tree=render(live);assert.equal(tree.type,'span');assert.equal(tree.props.onClick,undefined);assert.equal(tree.children[1],live.reportedCwd);assert.equal(render({...live,live:false}).children[1],'Not reported');assert.equal(render({...live,availability:'owner_unavailable'}).children[1],'Not reported');
 assert.match(source.text,/title=\{session.cwd\}/);
});

test('A07a actual renderer cannot publish a replacement view report',async()=>{
 const h=harness(async()=>({data:'',offset:0,end_offset:0}),false,async()=>full('a'));await h.open(record('a'));const old=h.refs.terminalViews.current.get('a');old.reportedCwd=null;
 const replacement={dispose(){}};h.refs.terminalViews.current.retain(()=>false);h.refs.terminalViews.current.open('a',true,()=>replacement);
 await h.render(old,'a',{...full('a'),reported_cwd:{path:'/wrong-view',sequence:1}},0);assert.equal(old.reportedCwd,null);assert.equal(replacement.reportedCwd,undefined);
});

test('A07a ending during actual asynchronous projection cannot restore a current directory claim',async()=>{
 const h=harness(async()=>({data:'',offset:0,end_offset:0}),false,async()=>({...full('a'),reported_cwd:{path:'/live',sequence:1}}));await h.open(record('a'));const v=h.refs.terminalViews.current.get('a');let release;v.instance.write=(_data,done)=>release=done;
 const pending=h.render(v,'a',{...full('a'),projection:{...full('a').projection,revision:5},reported_cwd:{path:'/late',sequence:2}},0);
 v.lifecycleRevision=1;v.live=false;v.status='stopped';v.reportedCwd=null;release();await pending;assert.equal(v.reportedCwd,null);assert.equal(v.status,'stopped');
});
test('A07a actual disposal clears runtime metadata alongside existing parser resources',()=>{
 let method;function scan(n){if(ts.isMethodDeclaration(n)&&n.name?.getText(source)==='dispose'&&n.getText(source).includes('view.find?.dispose'))method=n.getText(source);ts.forEachChild(n,scan);}scan(source);assert.ok(method);
 const disposed=[],view={reportedCwd:'/live',reportedCwdSequence:4,find:{dispose:()=>disposed.push('find')},attaching:false};
 const bindings={isMainWindow:true,desktopWindow:{restore_blocked:false},id:"s-a",invoke:async()=>{},setError(){},view,terminalMounted:{current:true},setRecoveryRevision(){},onData:{dispose:()=>disposed.push('input')},onScroll:{dispose:()=>disposed.push('scroll')},instance:{dispose:()=>disposed.push('terminal')},element:{remove:()=>disposed.push('element')}};
 const object=new Function(...Object.keys(bindings),ts.transpileModule('const object={'+method+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return object;')(...Object.values(bindings));object.dispose();assert.equal(view.reportedCwd,null);assert.equal(view.reportedCwdSequence,-1);assert.equal(view.disposed,true);assert.deepEqual(disposed,['find','input','scroll','terminal','element']);
});

test('T5 explicit reconnect reaches the real openHistory replay without invalidating its own layout scope',async()=>{
 let reads=0;const h=harness(async()=>{reads++;return {data:'LIVE',offset:0,end_offset:4};});
 await h.open(record('s-existing'));const view=h.refs.terminalViews.current.get('s-existing'),before=reads;
 view.ready=false;view.writable=false;view.availability='owner_unavailable';h.refs.ownerConnectionAvailable.current={available:false,version:1};
 let reconnectCode;const find=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='reconnectBackground')reconnectCode=n.getText(source);ts.forEachChild(n,find);};find(source);assert.ok(reconnectCode);
 const commands=[],errors=[],args={...h.args,reconnectPending:{current:false},setReconnecting(){},refreshHistory:async()=>{},setError:value=>errors.push(value),invoke:async(name)=>{commands.push(name);return name==='get_session'?record('s-existing'):undefined;},openHistory:h.open};
 const reconnect=new Function(...Object.keys(args),ts.transpileModule(reconnectCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return reconnectBackground;')(...Object.values(args));
 await reconnect();assert.deepEqual(commands,['reconnect_background','get_session']);assert.deepEqual(errors.filter(Boolean),[]);
 assert.equal(view.ready,true);assert.equal(view.availability,'available');assert.equal(reads,before+1);assert.equal(h.refs.terminalViews.current.size,1);assert.equal(h.refs.sessionId.current,'s-existing');
});

test('T5 reconnect restores every visible pane while preserving the selected pane',async()=>{
 const h=harness(async()=>({data:'LIVE',offset:0,end_offset:4}));
 await h.open(record('s-left'));await h.open(record('s-right'));
 h.refs.terminalLayoutRef.current={mode:'horizontal',panes:['s-left','s-right'],focused:0,revision:1};
 await h.open(record('s-left'),false,0,h.args.layoutRestore.current.version);
 for(const view of h.refs.terminalViews.current.all){view.ready=false;view.availability='owner_unavailable';}
 h.refs.ownerConnectionAvailable.current={available:false,version:1};
 let reconnectCode;const find=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='reconnectBackground')reconnectCode=n.getText(source);ts.forEachChild(n,find);};find(source);
 const args={...h.args,reconnectPending:{current:false},setReconnecting(){},refreshHistory:async()=>{},setError(){},invoke:async(name,parameters)=>name==='get_session'?record(parameters.sessionId):undefined,openHistory:h.open};
 await new Function(...Object.keys(args),ts.transpileModule(reconnectCode,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return reconnectBackground;')(...Object.values(args))();
 assert.equal(h.refs.terminalViews.current.get('s-left').ready,true);assert.equal(h.refs.terminalViews.current.get('s-right').ready,true);assert.equal(h.refs.sessionId.current,'s-left');assert.equal(h.refs.terminalLayoutRef.current.focused,0);
});


test('admission reserves the safe saved victim instead of an earlier unsaved ended view',()=>{
 const pool=new TerminalViews(2),disposed=[];
 const unsafe=pool.open('unsafe',false,()=>({saved:false,dispose(){disposed.push('unsafe')}}));
 pool.open('safe',false,()=>({saved:true,dispose(){disposed.push('safe')}}));
 assert.equal(pool.reserveAdmission(view=>view.saved),true);
 pool.open('new',true,()=>({saved:false,dispose(){}}));
 assert.equal(pool.get('unsafe'),unsafe);assert.deepEqual(disposed,['safe']);pool.releaseAdmission();
 assert.equal(pool.reserveAdmission(view=>view.saved),false);assert.equal(pool.size,2);
});
