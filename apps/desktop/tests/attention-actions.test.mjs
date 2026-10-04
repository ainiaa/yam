import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {replayOutput} from '../src/session-stream.ts';
import {assignTerminalPane} from '../src/terminal-layout.ts';
import {captureAttention,isCurrentAttention} from '../src/attention-actions.ts';
const receipt=()=>({id:'generation:turn:PermissionRequest',revision:3,turn_id:'turn',kind:'needs_permission',delivery:'accepted',read:false,error:null});
const record=()=>({summary:{session_id:'s-one',cwd:'/repo',title:'Recorded title'},status:'running',agent:{generation:'generation',turn_id:'turn',revision:3,phase:'needs_permission',integration:'connected',agent_session_id:'native',inbox:[receipt()]}});
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function functions(names){const found=[];function visit(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))found.push(n.getText(source));ts.forEachChild(n,visit)}visit(source);assert.equal(found.length,names.length);return ts.transpileModule(found.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(setImmediate);
function harness(options={}){
 const calls=[],errors=[],writes=[],views=new Map();
 const detailVersion={current:0},layoutRestore={current:{version:0}},sessionId={current:null},selectedRecord={current:null},ownerConnectionAvailable={current:{available:true,version:0}},terminalMounted={current:true},attentionOperation={current:0};
 const view={ready:true,cursor:16,attachVersion:0,disposed:false,availability:'available',live:true,status:'running'};
 const parserCallbacks=[];
 const h={calls,errors,writes,views,view,parserCallbacks,detailVersion,layoutRestore,sessionId,selectedRecord,ownerConnectionAvailable,terminalMounted,attentionOperation};
 const bindings={captureAttention,isCurrentAttention,detailVersion,layoutRestore,sessionId,selectedRecord,ownerConnectionAvailable,terminalMounted,attentionOperation,terminalViews:{current:views},setError:e=>errors.push(e),cancelLayoutRestore(){layoutRestore.current.version++},async openHistory(r){views.set(r.summary.session_id,view);view.attachVersion++;detailVersion.current++;layoutRestore.current.version++;sessionId.current=r.summary.session_id;selectedRecord.current=r;if(options.attach)await options.attach.promise;return view;},async invoke(command,args){calls.push({command,args});if(options.invoke)return options.invoke(command,args,h);if(command==='get_session')return record();},async refreshHistory(valid){if(options.refresh)return options.refresh(valid,h);if(!valid||valid())writes.push('refresh');}};
 if(options.realAttach){
  Object.assign(view,{live:true,status:'running',record:null,attaching:false,lifecycleRevision:0,projection:true,element:{dataset:{sessionId:'s-one'}},fit:{fit(){}},instance:{focus(){}}});
  Object.assign(bindings,{outputCursor:{current:16},setSessionStatus:value=>writes.push({status:value}),assignTerminalPane,terminalLayoutRef:{current:{mode:'single',panes:[null],focused:0}},creatingSession:{current:false},document:{activeElement:null,body:{}},createTerminalView:()=>view,setError:e=>errors.push(e),setTerminalLayout:()=>{},showTerminalLayout:()=>{},focusTerminalPane(){sessionId.current='s-one';selectedRecord.current=view.record;},setRecoveryRevision:()=>{},renderFrame:async()=>{await options.attach.promise;view.ready=true;view.cursor=16;},pendingOutput:{current:{delete(){}}},pendingState:{current:new Map()},terminalPaneVisible:()=>true,requestAnimationFrame:()=>{},terminalPaneHasSize:()=>true,syncViewSize:()=>{}});
  bindings.terminalViews.current={get:id=>views.get(id),setProtected(){},open(id,_live,factory){if(!views.has(id))views.set(id,factory());return views.get(id)},retain(){},setRunning(){}};
  h.actualViews=bindings.terminalViews;
  delete bindings.openHistory;
  if(options.realFocus){delete bindings.focusTerminalPane;Object.assign(bindings,{selectionVersion:{current:0},previousSession:{current:null},terminal:{current:null},fitAddon:{current:null},setSession:()=>{},setSelectedAgent:()=>{},setActiveProject:()=>{},setTerminalNotice:()=>{},syncNotificationContext:()=>{}});}
  if(options.realFrame){delete bindings.renderFrame;Object.assign(bindings,{validateTerminalFrame,applyTerminalFrame:()=>options.attach.promise,setTerminalNotice:()=>writes.push('notice'),terminalStatuses:new Set(['succeeded','failed','stopped'])});}
  if(options.realRaw){Object.assign(view,{cursor:null,ready:false,projection:false,replayVersion:0,instance:{reset(){writes.push('reset')},write(_data,done){parserCallbacks.push(done)},focus(){}}});Object.assign(bindings,{replayOutput,setTerminalNotice:()=>writes.push('notice'),terminalStatuses:new Set(['succeeded','failed','stopped']),setAgentPhase:value=>writes.push({phase:value}),agentOutputWindow:{current:''},updateAgentPhase:()=>writes.push('parsed-phase')});bindings.pendingOutput.current.drain=()=>[];}
 }
 Object.assign(h,new Function(...Object.keys(bindings),functions(options.realAttach?[...(options.realFocus?['focusTerminalPane']:[]),...(options.realFrame?['renderFrame']:[]),'openHistory','openSession','openReceipt']:['openSession','openReceipt'])+';return {openSession,openReceipt}')(...Object.values(bindings)));
 return h;
}
test('F5 captures complete original provenance and fixed permission guidance',()=>{
 const r=record(),e=receipt(),a=captureAttention(r,e,r.agent);assert.equal(a.state,'current');assert.equal(a.generation,'generation');assert.equal(a.turnId,'turn');assert.match(a.explanation,/terminal/i);assert.equal(isCurrentAttention(a,r),true);
 e.revision=99;assert.equal(a.receipt.revision,3);
});
for(const [name,change] of [
 ['missing generation',r=>delete r.agent.generation],['missing turn',r=>delete r.agent.turn_id],['invalid revision',r=>r.agent.inbox[0].revision=-1],['phase advanced',r=>r.agent.phase='working'],['turn advanced',r=>r.agent.turn_id='new'],['generation advanced',r=>r.agent.generation='new'],['ended',r=>r.status='stopped'],['integration unavailable',r=>r.agent.integration='unavailable'],['unsupported kind',r=>r.agent.inbox[0].kind='mystery']
])test('F5 provenance rejects '+name,()=>{const original=record(),a=captureAttention(original,receipt(),original.agent),fresh=record();change(fresh);assert.equal(isCurrentAttention(a,fresh),false)});
test('F5 missing card proof remains unknown and does not infer generation from receipt text',()=>{const r=record();assert.equal(captureAttention(r,receipt()).state,'unknown');});
test('F5 actual App historical card navigates without any receipt ACK',async()=>{const h=harness();await h.openReceipt(record(),receipt());assert.equal(h.sessionId.current,'s-one');assert.deepEqual(h.calls.filter(c=>c.command==='read_agent_receipt'),[])});
test('F5 actual App current card requires postattachment fresh get_session before exact ACK',async()=>{const h=harness();const r=record();await h.openReceipt(r,receipt(),r.agent);assert.deepEqual(h.calls.map(c=>c.command),['get_session','get_session','read_agent_receipt']);assert.deepEqual(h.calls[2].args,{sessionId:'s-one',receipt:receipt().id,revision:3});assert.deepEqual(h.writes,['refresh']);});
test('F5 actual App fresh phase advancement preserves original and newer unread',async()=>{let n=0;const h=harness({invoke:async command=>{if(command==='get_session'){const r=record();if(++n===2){r.agent.phase='working';r.agent.turn_id='new';r.agent.inbox.push({...receipt(),id:'generation:new:TurnComplete',revision:4,turn_id:'new'});}return r;}}});const r=record();await h.openReceipt(r,receipt(),r.agent);assert.equal(n,2);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);});
for(const transition of ['away-back','same-id-attach','owner-error','unmount','disposed'])test('F5 actual App pending freshness fences '+transition,async()=>{
 const gate=deferred();let n=0;const h=harness({invoke:async command=>command==='get_session'?(++n===2?gate.promise:record()):undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();
 if(transition==='away-back')h.detailVersion.current+=2;
 if(transition==='same-id-attach')h.view.attachVersion++;
 if(transition==='owner-error'){h.ownerConnectionAvailable.current.version++;h.ownerConnectionAvailable.current.available=false;}
 if(transition==='unmount')h.terminalMounted.current=false;
 if(transition==='disposed')h.view.disposed=true;
 gate.resolve(record());await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);assert.deepEqual(h.errors,[]);assert.deepEqual(h.writes,[]);
});
test('F5 actual App failed stale navigation never acknowledges existing same-ID view',async()=>{const gate=deferred();const h=harness({invoke:async()=>gate.promise});h.views.set('s-one',h.view);h.sessionId.current='s-one';const r=record();const running=h.openReceipt(r,receipt(),r.agent);h.detailVersion.current++;gate.resolve(r);await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);});
test('F5 actual App stale read rejection cannot overwrite newer selection error',async()=>{const gate=deferred();const h=harness({invoke:async command=>command==='get_session'?record():gate.promise});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();h.detailVersion.current++;gate.reject(Error('old receipt error'));await running;assert.deepEqual(h.errors,[])});
test('F5 actual refreshHistory fences delayed page, selected record, error and finally internally',async()=>{
 const page=deferred(),loading=[],writes=[],errors=[];let valid=true;
 const bindings={historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),invoke:c=>c==='history_overview'?Promise.resolve({}):page.promise,setHistoryLoading:v=>loading.push(v),setHistory:v=>writes.push(v),setHistoryCursor:()=>writes.push('cursor'),setHistoryOverview:()=>writes.push('overview'),refreshInbox:()=>writes.push('inbox'),refreshPendingNotifications:()=>writes.push('notifications'),selectedRecord:{current:null},setSelectedAgent:()=>writes.push('agent'),setError:e=>errors.push(e),clearDeletedSessionNames:()=>writes.push('delete'),deletionReceiptKey:{current:''}};
 const refresh=new Function(...Object.keys(bindings),functions(['refreshHistory'])+';return refreshHistory')(...Object.values(bindings));const running=refresh(()=>valid);valid=false;page.resolve({items:[],next_cursor:null});await running;assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(loading,[false]);
});
test('F5 actual AttentionCard permission renders only explicit terminal action and recorded title',()=>{
 const path=new URL('../src/AttentionCard.tsx',import.meta.url);const js=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const require=createRequire(import.meta.url),module={exports:{}};new Function('require','module','exports',js)(id=>id.includes('attention-actions')?{captureAttention,isCurrentAttention}:require(id),module,module.exports);
 let calls=0;const r=record(),tree=module.exports.AttentionCard({record:r,entry:receipt(),agent:r.agent,title:'Recorded title',onOpen:()=>calls++});
 const nodes=[];function walk(x){if(!x||typeof x!=='object')return;nodes.push(x);const c=x.props?.children;(Array.isArray(c)?c:[c]).forEach(walk)}walk(tree);
 const buttons=nodes.filter(x=>x.type==='button');assert.equal(buttons.length,1);assert.match(JSON.stringify(tree),/Recorded title/);assert.match(JSON.stringify(tree),/Permission required/);assert.doesNotMatch(JSON.stringify(tree),/Approve|Reject/);buttons[0].props.onClick();assert.equal(calls,1);
});

for(const kind of ['needs_permission','needs_attention','response_finished','failed','interrupted'])test('F5 distinct current '+kind+' receipt keeps original action',()=>{
 const r=record();r.agent.phase=kind;r.agent.inbox[0].kind=kind;const a=captureAttention(r,r.agent.inbox[0],r.agent);assert.equal(a.state,'current');assert.equal(isCurrentAttention(a,r),true);
});
for(const [name,change] of [['duplicate receipt',r=>r.agent.inbox.push({...r.agent.inbox[0]})],['session mismatch',r=>r.summary.session_id='other'],['read already',r=>r.agent.inbox[0].read=true],['sameID changed revision',r=>r.agent.inbox[0].revision++],['unsafe integer',r=>r.agent.revision=Infinity]])test('F5 exact identity rejects '+name,()=>{const r=record(),a=captureAttention(r,receipt(),r.agent);change(r);assert.equal(isCurrentAttention(a,r),false);});
test('F5 inherited object keys are not recognized receipt kinds',()=>{const r=record();r.agent.phase='constructor';r.agent.inbox[0].kind='constructor';const a=captureAttention(r,r.agent.inbox[0],r.agent);assert.equal(a.state,'unknown');});
for(const settle of ['resolve','reject'])test('F5 actual App pending attachment '+settle+' after new selection has no stale effects',async()=>{
 const gate=deferred(),h=harness({attach:gate});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();h.detailVersion.current++;h.sessionId.current='s-two';gate[settle](settle==='reject'?Error('old attach'):undefined);await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);assert.deepEqual(h.errors,[]);assert.deepEqual(h.writes,[]);
});
test('F5 scoped history refresh never strands an existing ordinary loading operation',async()=>{
 const pages=[],loading=[],writes=[];let valid=true;
 const bindings={historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),invoke:c=>c==='history_overview'?Promise.resolve({}):new Promise(resolve=>pages.push(resolve)),setHistoryLoading:v=>loading.push(v),setHistory:v=>writes.push(v),setHistoryCursor:()=>{},setHistoryOverview:()=>{},refreshInbox:()=>{},refreshPendingNotifications:()=>{},selectedRecord:{current:null},setSelectedAgent:()=>{},setError:()=>{},clearDeletedSessionNames:()=>{},deletionReceiptKey:{current:''}};
 const refresh=new Function(...Object.keys(bindings),functions(['refreshHistory'])+';return refreshHistory')(...Object.values(bindings));
 const ordinary=refresh(),scoped=refresh(()=>valid);valid=false;pages[1]({items:[],next_cursor:null});await scoped;pages[0]({items:[],next_cursor:null});await ordinary;assert.equal(loading.at(-1),false);
});
for(const stage of ['page-success','page-error','selected-success','selected-error'])test('F5 actual scoped refresh '+stage+' after cancel does not update selected/global UI',async()=>{
 const gate=deferred(),errors=[],writes=[],loading=[];let valid=true;
 const bindings={historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),invoke:c=>c==='history_overview'?Promise.resolve({}):c==='get_session'||stage.startsWith('page')?gate.promise:Promise.resolve({items:[],next_cursor:null}),setHistoryLoading:v=>loading.push(v),setHistory:v=>writes.push('history'),setHistoryCursor:()=>writes.push('cursor'),setHistoryOverview:()=>writes.push('overview'),refreshInbox:()=>{},refreshPendingNotifications:()=>assert.fail('scoped read must not fan out notification mutation'),selectedRecord:{current:record()},setSelectedAgent:()=>writes.push('agent'),setError:e=>errors.push(e),clearDeletedSessionNames:()=>{},deletionReceiptKey:{current:''}};
 const refresh=new Function(...Object.keys(bindings),functions(['refreshHistory'])+';return refreshHistory')(...Object.values(bindings));const running=refresh(()=>valid);await tick();const before=[...writes];valid=false;if(stage.endsWith('error'))gate.reject(Error('stale failure'));else gate.resolve(stage.startsWith('page')?{items:[],next_cursor:null}:record());await running;assert.deepEqual(writes,before);assert.deepEqual(errors,[]);assert.deepEqual(loading,[false]);
});
for(const settle of ['resolve','reject'])test('F5 actual scoped inbox '+settle+' cannot replace new unread rows or busy owner',async()=>{
 const pending=[],writes=[],errors=[],inboxLoading={current:false},inboxVersion={current:0};let valid=true;
 const bindings={inboxVersion,inboxLoading,inboxCursor:null,invoke:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),setInbox:v=>writes.push(v),setInboxCursor:()=>{},setError:e=>errors.push(e)};
 const refresh=new Function(...Object.keys(bindings),functions(['refreshInbox'])+';return refreshInbox')(...Object.values(bindings));const old=refresh(false,()=>valid),newer=refresh();valid=false;pending[0][settle](settle==='resolve'?{items:[],next_cursor:null}:Error('old inbox'));await old;assert.equal(inboxLoading.current,true);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);pending[1].resolve({items:['new unread'],next_cursor:null});await newer;assert.equal(inboxLoading.current,false);assert.equal(writes.length,1);
});

test('F5 actual openHistory waits for projection parser then fresh owner read before ACK',async()=>{
 const gate=deferred();let n=0;const h=harness({realAttach:true,attach:gate,invoke:async command=>command==='get_session'?(n++,record()):command==='read_terminal_frame'?{kind:'projection'}:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();assert.equal(n,1);assert.equal(h.view.attaching,true);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);gate.resolve();await running;assert.equal(n,2);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,1);assert.equal(h.view.attaching,false);
});
for(const transition of ['reattach','owner-error','away-back'])test('F5 actual openHistory parser pending '+transition+' cannot authorize receipt',async()=>{
 const gate=deferred();const h=harness({realAttach:true,attach:gate,invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?{kind:'projection'}:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();if(transition==='reattach')h.view.attachVersion++;if(transition==='owner-error'){h.ownerConnectionAvailable.current.version++;h.ownerConnectionAvailable.current.available=false;}if(transition==='away-back')h.detailVersion.current+=2;gate.resolve();await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);assert.deepEqual(h.errors,[]);
});
test('F5 actual App inbox renders AttentionCard with current selected proof and real openReceipt callback',async()=>{
 let expression;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='inbox.map')expression=n.getText(source);ts.forEachChild(n,visit)}visit(source);assert.ok(expression);
 const require=createRequire(import.meta.url),runtime=require('react/jsx-runtime');
 const code=ts.transpileModule('const cards='+expression+';', {compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const h=harness(),r=record(),inbox=[{session:r,receipt:receipt()}];h.sessionId.current='s-one';
 const args={inbox,sessionId:h.sessionId,currentAgent:r.agent,titleFor:()=>r.summary.title,AttentionCard:()=>{},openReceipt:h.openReceipt};
 const cards=new Function('require','exports',...Object.keys(args),code+';return cards')(id=>id==='react/jsx-runtime'?runtime:require(id),{},...Object.values(args));
 assert.equal(cards.length,1);assert.equal(cards[0].type,args.AttentionCard);assert.equal(cards[0].props.agent,r.agent);assert.equal(cards[0].props.entry.id,receipt().id);cards[0].props.onOpen();await tick();assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,1);
 h.sessionId.current='other';const old=new Function('require','exports',...Object.keys(args),code+';return cards')(id=>id==='react/jsx-runtime'?runtime:require(id),{},...Object.values(args));assert.equal(old[0].props.agent,undefined);
});

test('F5 fresh reply from before terminal end cannot acknowledge the ended attachment',async()=>{
 const gate=deferred();let n=0;const h=harness({invoke:async command=>command==='get_session'?(++n===2?gate.promise:record()):undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();h.view.live=false;h.view.status='stopped';gate.resolve(record());await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);
});

test('F5 receipt refresh supersedes pending ordinary page without clearing newer unread state',async()=>{
 const pages=[],applied=[],loading=[];const bindings={historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),invoke:c=>c==='history_overview'?Promise.resolve({}):new Promise(resolve=>pages.push(resolve)),setHistoryLoading:v=>loading.push(v),setHistory:v=>applied.push(v),setHistoryCursor:()=>{},setHistoryOverview:()=>{},refreshInbox:()=>{},refreshPendingNotifications:()=>{},selectedRecord:{current:null},setSelectedAgent:()=>{},setError:()=>{},clearDeletedSessionNames:()=>{},deletionReceiptKey:{current:''}};
 const refresh=new Function(...Object.keys(bindings),functions(['refreshHistory'])+';return refreshHistory')(...Object.values(bindings));const old=refresh(),current=refresh(()=>true);pages[1]({items:['current'],next_cursor:null});await current;pages[0]({items:['old'],next_cursor:null});await old;assert.deepEqual(applied,[['current']]);assert.equal(loading.at(-1),false);
});

function supersede(h,transition){if(transition==='away-back'){h.layoutRestore.current.version+=2;h.detailVersion.current+=2;}else if(transition==='new-receipt')h.attentionOperation.current++;else if(transition==='owner-error'){h.ownerConnectionAvailable.current.version++;h.ownerConnectionAvailable.current.available=false;}else if(transition==='unmount')h.terminalMounted.current=false;}
for(const transition of ['away-back','new-receipt'])for(const settle of ['resolve','reject'])test('F5 R1 actual openHistory old frame '+settle+' after '+transition+' has no inner effects',async()=>{
 const gate=deferred();const h=harness({realAttach:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?gate.promise:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();const before={cursor:h.view.cursor,availability:h.view.availability,status:h.view.status};supersede(h,transition);gate[settle](settle==='resolve'?null:Error('old frame failure'));await running;assert.deepEqual(h.errors,[]);assert.deepEqual(h.writes,[]);assert.deepEqual({cursor:h.view.cursor,availability:h.view.availability,status:h.view.status},before);assert.equal(h.view.attaching,false);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);
});
for(const transition of ['away-back','new-receipt'])for(const settle of ['resolve','reject'])test('F5 R1 actual openHistory old raw snapshot '+settle+' after '+transition+' has no inner effects',async()=>{
 const gate=deferred();const h=harness({realAttach:true,realRaw:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?null:command==='read_session_snapshot'?gate.promise:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();const before=h.writes.length;supersede(h,transition);gate[settle](settle==='resolve'?{data:'old',offset:0,end_offset:3,status:'stopped'}:Error('old snapshot'));await tick();const parserCount=h.parserCallbacks.length;h.parserCallbacks.forEach(done=>done());await running;assert.deepEqual(h.errors,[]);assert.equal(h.writes.length,before);assert.equal(parserCount,0);assert.equal(h.view.cursor,null);assert.equal(h.view.attaching,false);
});
for(const transition of ['away-back','new-receipt','owner-error','unmount'])test('F5 R1 actual raw parser callback after '+transition+' never revives old readiness or focus',async()=>{
 const h=harness({realAttach:true,realRaw:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?null:command==='read_session_snapshot'?{data:'raw',offset:0,end_offset:3,status:'running'}:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();assert.equal(h.parserCallbacks.length,1);const before=h.writes.length;supersede(h,transition);h.parserCallbacks[0]();await running;assert.equal(h.view.ready,false);assert.equal(h.writes.length,before);assert.deepEqual(h.errors,[]);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,0);assert.equal(h.view.attaching,false);assert.equal(h.view.parsing,null);
});
test('F5 R1 current raw parser completes attachment and permits exact current receipt once',async()=>{
 const h=harness({realAttach:true,realRaw:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?null:command==='read_session_snapshot'?{data:'raw',offset:0,end_offset:3,status:'running'}:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();h.parserCallbacks[0]();await running;assert.equal(h.view.ready,true);assert.equal(h.view.attaching,false);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,1);
});

test('F5 R1 scoped replacement serializes old raw parser then recovers the latest same-ID attachment',async()=>{
 const h=harness({realAttach:true,realRaw:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?null:command==='read_session_snapshot'?{data:'raw',offset:0,end_offset:3,status:'running'}:undefined});const r=record();const old=h.openReceipt(r,receipt(),r.agent);await tick();assert.equal(h.parserCallbacks.length,1);
 const latest=h.openReceipt(r,receipt(),r.agent);await tick();assert.equal(h.parserCallbacks.length,1,'new replay waits for the old parser');h.parserCallbacks[0]();await old;await tick();assert.equal(h.view.ready,false,'old scoped parser cannot publish readiness');assert.equal(h.view.attaching,true,'old finally must not clear replacement attachment');assert.equal(h.parserCallbacks.length,2);h.parserCallbacks[1]();await latest;assert.equal(h.view.ready,true);assert.equal(h.view.attaching,false);assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,1);assert.deepEqual(h.errors,[]);
});

test('F5 R1 actual nested focus cancellation freezes scope after setup and does not invalidate its own attachment',async()=>{
 const h=harness({realAttach:true,realRaw:true,realFocus:true,attach:deferred(),invoke:async command=>command==='get_session'?record():command==='read_terminal_frame'?null:command==='read_session_snapshot'?{data:'raw',offset:0,end_offset:3,status:'running'}:undefined});const r=record();const running=h.openReceipt(r,receipt(),r.agent);await tick();assert.ok(h.layoutRestore.current.version>=3);assert.equal(h.parserCallbacks.length,1);h.parserCallbacks[0]();await running;assert.equal(h.calls.filter(c=>c.command==='read_agent_receipt').length,1);assert.equal(h.view.ready,true);assert.deepEqual(h.errors,[]);
});
