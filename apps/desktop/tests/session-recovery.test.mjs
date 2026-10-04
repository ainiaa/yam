// Author: Jeff.Liu
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {sessionRecovery} from '../src/session-recovery.ts';
import {TerminalViews} from '../src/terminal-views.ts';
import {createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,clampSplitPercent,swapTerminalPanes,isTerminalProtocolResponse} from '../src/terminal-layout.ts';
import {loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {queueTerminalResize} from '../src/terminal-settings.ts';
import {paletteEntries} from '../src/command-palette.ts';
import {inferAgentPhase} from '../src/notifications.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const uuid='01a0f6ec-5463-78c3-a404-5a7ad3b933fa';
const record=(status='needs_attention')=>({summary:{session_id:'s-a',cwd:'/repo',command:null,launch:{adapter:'codex',mode:'interactive',extra_args:'',prompt:'secret-prompt'}},status,reason:'The application closed while this session was running',agent:{generation:'trusted-generation',agent_session_id:uuid,phase:'needs_attention',integration:'unavailable',inbox:[]}});
function find(predicate){let result;function visit(n){if(predicate(n))result=n;ts.forEachChild(n,visit)}visit(source);assert.ok(result,'actual App node must exist');return result;}
const js=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
function declarations(name){return find(n=>ts.isVariableDeclaration(n)&&n.name.getText(source)===name);}
function body(name){return find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(source);}
function actions(rec=record(),current='s-a',shown='s-a',status=rec.status,availability='available'){
 const calls=[];const selectedRecord={current:rec},sessionId={current},view={availability};
 const bindings={setRecoveryRevision(){},ownerConnectionAvailable:{current:{available:true,version:0}},session:{...rec.summary,session_id:shown},selectedRecord,sessionId,sessionStatus:status,starting:false,terminalViews:{current:{get:()=>view}},sessionRecovery,startSession:args=>calls.push(args)};
 // Baseline has no policy function; final candidate executes the actual shared function.
 let policy='';function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='selectedRecovery')policy=n.getText(source);ts.forEachChild(n,visit)}visit(source);
 const code=js(policy+'\n'+body('resumeSelectedSession')+'\n'+body('rerunSelectedSession'));
 return {calls,bindings,...new Function(...Object.keys(bindings),code+';return {resume:resumeSelectedSession,rerun:rerunSelectedSession};')(...Object.values(bindings))};
}
function policy(rec=record(),status=rec.status,availability='available',selected='s-a',shown='s-a',starting=false){return sessionRecovery(rec,selected,shown,status,starting,availability);}
test('F1 pure ended trusted Codex and Claude are structural Continue candidates, never native verification',()=>{
 for(const adapter of ['codex','claude']){const r=record('stopped');r.summary.launch.adapter=adapter;const p=policy(r);assert.equal(p.canContinue,true);assert.equal(p.canRunAgain,true);}
});
test('F1 pure invalid identity provenance and launch boundaries never offer Continue',()=>{
 for(const mutate of [r=>r.agent.generation='',r=>r.agent.agent_session_id='--last',r=>r.agent.agent_session_id=null,r=>r.summary.command='secret',r=>r.summary.launch.mode='task',r=>r.summary.launch.adapter='opencode',r=>r.summary.launch.extra_args='--unknown']){const r=record();mutate(r);assert.equal(policy(r).canContinue,false);}
 for(const status of ['running','starting','unknown','unavailable'])assert.equal(policy(record(status)).canContinue,false);
 assert.equal(policy(record(),'needs_attention','owner_unavailable').canContinue,false);
 assert.equal(policy(record(),'needs_attention','terminal_unavailable').canContinue,false);
 assert.equal(policy(record(),'needs_attention','available','s-b').canContinue,false);
 assert.equal(policy(record(),'needs_attention','available','s-a','s-b').canContinue,false);
 assert.equal(policy(record(),'needs_attention','available','s-a','s-a',true).canContinue,false);
});
test('F1 fixed lifecycle reason is separate from Agent attention and never exposes raw secret text',()=>{
 const old=policy();assert.match(old.notice,/background owner/i);assert.match(old.notice,/cannot be reattached/i);
 const r=record('running');assert.equal(policy(r).notice,null);r.status='needs_attention';r.reason='secret-error SECRET_NATIVE command-value';assert.equal(policy(r).notice,'This task needs attention. Review its recorded output and choose an explicit action.');
 assert.equal(policy(record(),'needs_attention','owner_unavailable').notice,'Background connection unavailable. The current process state cannot be confirmed here.');
 assert.equal(policy(record(),'needs_attention','terminal_unavailable').notice,'This terminal state is unavailable. The previous terminal state cannot be restored here.');
});
test('F1 actual App Continue eligibility rejects malformed ID rather than any nonempty string',()=>{
 const r=record();r.agent.agent_session_id='SECRET_UNTRUSTED';
 const bindings={setRecoveryRevision(){},session:r.summary,sessionStatus:r.status,starting:false,isRunning:false,selectedAgent:r.agent,selectedRecovery:()=>policy(r),recovery:policy(r)};
 const value=new Function(...Object.keys(bindings),'return ('+declarations('canContinue').initializer.getText(source)+');')(...Object.values(bindings));assert.equal(value,false);
});
test('F1 actual Continue and Run again reject a stale selected record',()=>{
 const a=actions(record(),'s-b');a.resume();a.rerun();assert.deepEqual(a.calls,[]);
});
test('F1 actual Continue sends only history identity and Run again explicitly sends stored launch',()=>{
 const a=actions(record('stopped'));a.resume();assert.deepEqual(a.calls,[{resumeFrom:'s-a'}]);a.rerun();assert.deepEqual(a.calls[1],{cwd:'/repo',command:'',launch:a.bindings.session.launch});
});
test('F1 actual callbacks do not start while owner is unavailable or start is already pending',()=>{
 const a=actions(record(),'s-a','s-a','needs_attention','owner_unavailable');a.resume();a.rerun();assert.deepEqual(a.calls,[]);
});
test('F1 actual terminal notice render displays lifecycle recovery even with no parser notice',()=>{
 const node=find(n=>ts.isJsxExpression(n)&&n.getText(source).includes('className="terminal-notice"'));
 const r=record();const bindings={setRecoveryRevision(){},React:{createElement:(tag,props,...children)=>({tag,props,children})},terminalNotice:null,recoveryNotice:"The background owner restarted; the previous terminal process cannot be reattached."};
 const code=js('const rendered='+node.expression.getText(source));const rendered=new Function(...Object.keys(bindings),code+';return rendered;')(...Object.values(bindings));assert.ok(rendered);assert.match(JSON.stringify(rendered),/background owner/i);
});
function pollHarness(recoveryChanged=()=>{}){
 const pending=[],errors=[],statuses=[],notices=[];const view={projection:true,dirty:true,updating:false,selecting:false,disposed:false,instance:{hasSelection:()=>false},lifecycleRevision:0,viewportRevision:0,frameInstance:'owner-a',attachVersion:1,availability:'available',ready:true};
 const layout={current:{panes:['s-a']}},selected={current:'s-a'};const bindings={setRecoveryRevision:recoveryChanged,ownerConnectionAvailable:{current:{available:true,version:0}},terminalMounted:{current:true},document:{hidden:false},terminalLayoutRef:layout,terminalViews:{current:{get:id=>id==='s-a'?view:undefined}},sessionId:selected,invoke:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),renderFrame:async()=>{},setError:e=>errors.push(e),setSessionStatus:s=>statuses.push(s),setTerminalNotice:n=>notices.push(n)};
 const poll=new Function(...Object.keys(bindings),js(body('pollTerminalFrames'))+';return pollTerminalFrames;')(...Object.values(bindings));return {poll,pending,view,layout,selected,errors,statuses,notices};
}
test('F1 actual current frame failure reports unavailable without declaring process ended',async()=>{
 const h=pollHarness();h.poll();h.pending[0].reject(Error('secret parser problem'));await new Promise(setImmediate);assert.equal(h.view.availability,'terminal_unavailable');assert.equal(h.view.ready,true);assert.deepEqual(h.statuses,['unavailable']);assert.deepEqual(h.notices,['This terminal state is unavailable. The previous terminal state cannot be restored here.']);
});
test('F1 actual obsolete frame failure never changes another selection or availability',async()=>{
 const h=pollHarness();h.poll();h.layout.current.panes=['s-b'];h.selected.current='s-b';h.pending[0].reject(Error('late A'));await new Promise(setImmediate);assert.deepEqual(h.errors,[]);assert.deepEqual(h.statuses,[]);assert.equal(h.view.availability,'available');assert.equal(h.view.updating,false);
});
test('F1 actual owner-error listener only marks local availability and never launches tasks',()=>{
 const array=find(n=>ts.isArrayLiteralExpression(n)&&n.elements[0]?.getText(source)==='"session-error"');const callback=array.elements[1];const views=[{availability:'available'},{availability:'available'}],errors=[];const bindings={setRecoveryRevision(){},ownerConnectionAvailable:{current:{available:true,version:0}},cancelLayoutRestore(){},setError:e=>errors.push(e),terminalViews:{current:{all:views}},sessionId:{current:'s-a'},setSessionStatus(){},setTerminalNotice(){}};
 const listener=new Function(...Object.keys(bindings),js('const listener='+callback.getText(source))+';return listener;')(...Object.values(bindings));listener({session_id:'',data:'owner gone'});assert.ok(views.every(v=>v.availability==='owner_unavailable'));assert.deepEqual(errors,['owner gone']);
});

test('F1 selection policy preserves Claude candidate arguments but default Codex rejects overrides',()=>{
 const r=record('failed');r.summary.launch.adapter='claude';r.summary.launch.extra_args='--model sonnet';assert.equal(policy(r).canContinue,true);
 r.summary.launch.adapter='codex';assert.equal(policy(r).canContinue,false);
 assert.deepEqual(sessionRecovery(null,null,null,'idle',false,'available'),{canContinue:false,canRunAgain:false,notice:null});
});
test('F1 actual pending start cannot be duplicated by explicit recovery callbacks',()=>{
 const a=actions(record());a.bindings.starting=true;
 // Rebuild actual callback closure with starting already true.
 const bindings={setRecoveryRevision(){},...a.bindings,starting:true};const code=js(body('selectedRecovery')+'\n'+body('resumeSelectedSession')+'\n'+body('rerunSelectedSession'));
 const handlers=new Function(...Object.keys(bindings),code+';return [resumeSelectedSession,rerunSelectedSession];')(...Object.values(bindings));handlers.forEach(fn=>fn());assert.deepEqual(a.calls,[]);
});

function connectionHarness(recoveryChanged=()=>{}){
 const pending=[],calls=[],status=[];
 const rec=record('stopped');
 const view={availability:'available',attachVersion:1,disposed:false,frameInstance:'owner-a',frameRevision:1,live:false,ready:true,parsing:null,instance:{},element:{},lifecycleRevision:0};
 const ownerConnectionAvailable={current:{available:true,version:0}},terminalMounted={current:true},sessionId={current:'s-a'};
 const pool={all:[view],get:id=>id==='s-a'?view:undefined,setRunning(){}};
 const bindings={setRecoveryRevision:recoveryChanged,terminalViews:{current:pool},terminalMounted,ownerConnectionAvailable,sessionId,session:rec.summary,selectedRecord:{current:rec},sessionStatus:'stopped',starting:false,sessionRecovery,startSession:x=>calls.push(x),validateTerminalFrame(){},applyTerminalFrame:()=>new Promise(resolve=>pending.push(resolve)),terminalStatuses:new Set(['stopped']),terminalPaneVisible:()=>true,outputCursor:{current:null},setSessionStatus:x=>status.push(x),setTerminalNotice(){},cancelLayoutRestore(){},setError(){},createView:{current:()=>({element:{dataset:{}},availability:'available'})}};
 const listener=find(n=>ts.isArrayLiteralExpression(n)&&n.elements[0]?.getText(source)==='"session-error"').elements[1].getText(source);
 const code=js(body('renderFrame')+'\n'+body('selectedRecovery')+'\n'+body('resumeSelectedSession')+'\n'+body('createTerminalView')+'\nconst ownerError='+listener);
 const functions=new Function(...Object.keys(bindings),code+';return {renderFrame,selectedRecovery,resumeSelectedSession,createTerminalView,ownerError};')(...Object.values(bindings));
 return {view,pending,calls,status,bindings,pool,...functions};
}
const endedFrame={projection:{instance:'owner-a',revision:2},persisted:true,status:'stopped',end_offset:10};
test('F1 repair actual pending parser cannot revive Continue after owner error',async()=>{
 const h=connectionHarness();const old=h.renderFrame(h.view,'s-a',endedFrame,0);
 h.ownerError({session_id:'',data:'owner unavailable'});h.pending.shift()();await old;
 assert.equal(h.view.availability,'owner_unavailable');h.resumeSelectedSession();assert.deepEqual(h.calls,[]);assert.equal(h.bindings.ownerConnectionAvailable.current.available,false);
});
test('F1 repair actual new view and selection inherit known global offline until fresh authenticated completion',async()=>{
 const h=connectionHarness();h.ownerError({session_id:'',data:'owner unavailable'});
 const newView=h.createTerminalView('s-new');assert.equal(newView.availability,'owner_unavailable');
 h.view.availability='available';assert.equal(h.selectedRecovery().canContinue,false);
 h.view.availability='owner_unavailable';const fresh=h.renderFrame(h.view,'s-a',endedFrame,0);h.pending.shift()();await fresh;
 assert.equal(h.view.availability,'available');assert.equal(h.selectedRecovery().canContinue,true);
});
test('F1 repair actual old parser completion after unmount does not update availability or readiness',async()=>{
 const h=connectionHarness();h.view.ready=false;const old=h.renderFrame(h.view,'s-a',endedFrame,0);h.bindings.terminalMounted.current=false;
 h.pending.shift()();await old;assert.equal(h.view.ready,false);assert.deepEqual(h.status,[]);
});
test('F1 repair fresh B success never revalidates owner-invalidated A',async()=>{
 const h=connectionHarness();const old=h.renderFrame(h.view,'s-a',endedFrame,0);h.ownerError({session_id:'',data:'owner unavailable'});
 const b={...h.view,attachVersion:1,parsing:null,availability:'owner_unavailable',element:{}};
 const fresh=h.renderFrame(b,'s-b',endedFrame,0);h.pending[1]();await fresh;h.pending[0]();await old;
 assert.equal(b.availability,'available');assert.equal(h.view.availability,'owner_unavailable');h.resumeSelectedSession();assert.deepEqual(h.calls,[]);
});
test('F1 repair actual poll old authenticated success and error stay invalid after owner error',async()=>{
 for(const outcome of ['resolve','reject']){
  const h=pollHarness();const connection={current:{available:true,version:0}};const listener=find(n=>ts.isArrayLiteralExpression(n)&&n.elements[0]?.getText(source)==='"session-error"').elements[1].getText(source);
  const onError=new Function('terminalViews','ownerConnectionAvailable','cancelLayoutRestore','setError','setRecoveryRevision',js('const listener='+listener)+';return listener;')({current:{all:[h.view]}},connection,()=>{},()=>{},()=>{});
  h.poll();onError({session_id:'',data:'offline'});h.pending[0][outcome](outcome==='reject'?Error('late'):endedFrame);await new Promise(setImmediate);
  assert.equal(h.view.availability,'owner_unavailable');assert.deepEqual(h.errors,[]);assert.deepEqual(h.statuses,[]);
 }
});

function snapshotHarness(reactState=()=>{}){
 const pending=[],writes=[],errors=[];const rec=record('stopped');
 const view={availability:'available',attachVersion:0,cursor:null,ready:false,firstAttachment:false,replayVersion:0,parsing:null,live:false,status:'stopped',disposed:false,element:{dataset:{sessionId:'s-a'}},instance:{reset(){},write(_data,done){writes.push(done);}}};
 const pool={all:[view],get:()=>view,open:()=>view,setProtected(){},setRunning(){},retain(){}};
 const ownerConnectionAvailable={current:{available:true,version:0}},terminalMounted={current:true},sessionId={current:'s-a'};
 const layout={current:{mode:'single',panes:['s-a'],focused:0}};
 const bindings={setRecoveryRevision(){},ownerConnectionAvailable,terminalMounted,terminalViews:{current:pool},sessionId,terminalLayoutRef:layout,layoutRestore:{current:{version:0,pending:false}},creatingSession:{current:false},detailVersion:{current:0},assignTerminalPane:(l,_slot,id)=>({...l,panes:[id]}),cancelLayoutRestore(){},document:{activeElement:{},body:{}},setError:e=>errors.push(e),setTerminalLayout:l=>layout.current=l,showTerminalLayout(){},focusTerminalPane(){},createTerminalView:()=>view,pendingOutput:{current:{delete(){},drain:()=>[]}},pendingState:{current:new Map()},selectedRecord:{current:rec},outputCursor:{current:null},agentOutputWindow:{current:''},terminalStatuses:new Set(['stopped']),terminalPaneVisible:()=>true,terminalPaneHasSize:()=>false,setSessionStatus:value=>reactState(value),setTerminalNotice:value=>reactState(value),setAgentPhase:value=>reactState(value),setRecoveryRevision:next=>reactState(next),inferAgentPhase,requestAnimationFrame(){},applyStateEvent(){},syncViewSize(){},replayOutput:s=>({data:s.data,nextOffset:s.end_offset}),renderFrame:async()=>assert.fail('null frame must use existing snapshot path'),invoke:name=>new Promise((resolve,reject)=>pending.push({name,resolve,reject}))};
 const listener=find(n=>ts.isArrayLiteralExpression(n)&&n.elements[0]?.getText(source)==='"session-error"').elements[1].getText(source);
 const code=js(body('updateAgentPhase')+'\n'+body('openHistory')+'\nconst ownerError='+listener);
 const functions=new Function(...Object.keys(bindings),code+';return {openHistory,ownerError};')(...Object.values(bindings));
 return {view,pending,writes,errors,bindings,rec,...functions};
}
test('F1 repair actual old snapshot success cannot restore availability after owner error',async()=>{
 const h=snapshotHarness();const old=h.openHistory(h.rec);h.pending.shift().resolve(null);await new Promise(setImmediate);
 assert.equal(h.pending[0].name,'read_session_snapshot');h.ownerError({session_id:'',data:'offline'});
 h.pending.shift().resolve({data:'old',offset:0,end_offset:3,status:'stopped'});await new Promise(setImmediate);
 for(const done of h.writes.splice(0))done();await old;
 assert.equal(h.view.availability,'owner_unavailable');assert.equal(h.view.ready,false);assert.equal(h.writes.length,0);
});
test('F1 repair actual old raw replay callback never revives readiness after owner error',async()=>{
 const h=snapshotHarness();const old=h.openHistory(h.rec);h.pending.shift().resolve(null);await new Promise(setImmediate);
 h.pending.shift().resolve({data:'old',offset:0,end_offset:3,status:'stopped'});await new Promise(setImmediate);
 assert.equal(h.writes.length,1);h.ownerError({session_id:'',data:'offline'});h.writes.shift()();await old;
 assert.equal(h.view.ready,false);assert.equal(h.view.availability,'owner_unavailable');assert.equal(h.bindings.ownerConnectionAvailable.current.available,false);
});
test('F1 repair actual fresh snapshot and completed parser restore known availability only after completion',async()=>{
 const h=snapshotHarness();h.ownerError({session_id:'',data:'offline'});const fresh=h.openHistory(h.rec);
 h.pending.shift().resolve(null);await new Promise(setImmediate);h.pending.shift().resolve({data:'fresh',offset:0,end_offset:5,status:'stopped'});await new Promise(setImmediate);
 assert.equal(h.bindings.ownerConnectionAvailable.current.available,false);h.writes.shift()();await fresh;
 assert.equal(h.bindings.ownerConnectionAvailable.current.available,true);assert.equal(h.view.availability,'available');assert.equal(h.view.ready,true);
});

// Reuse the existing actual App setup fixture by AST extraction; never copy a controller.
function setupFixture(options={}){
 const fixtureSource=ts.createSourceFile('fixture.mjs',readFileSync(new URL('./terminal-layout-restore.test.mjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const fixture=fixtureSource.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='fixture');assert.ok(fixture);
 const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
 const declarations=app.body.statements.filter(ts.isFunctionDeclaration).filter(n=>!['refreshHistory','notifySession','updateAgentPhase'].includes(n.name?.text));
 const effects=app.body.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect').map(n=>n.expression.arguments[0].getText(source));
 const initializers=app.body.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).filter(n=>/terminalLayout|layoutRestore|layoutBoot|layoutPreference|restoreLayout|restoreVersion|restoreGeneration/i.test(n.name.getText(source))||n.initializer?.getText(source).includes('loadTerminalLayout'));
 const args={source,ts,declarations,initializers,setupText:effects.find(text=>text.includes('createView.current =')&&text.includes('pending_notification_selection')),persistenceText:effects.filter(text=>text.includes('saveTerminalLayout')||text.includes('yam.terminalLayout')),transpile:js,settle:async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);},TerminalViews,createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,clampSplitPercent,swapTerminalPanes,isTerminalProtocolResponse,loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout,queueTerminalResize,applyTerminalFrame,validateTerminalFrame,record:id=>({...record('running'),summary:{...record('running').summary,session_id:id}}),frame:()=>assert.fail('test supplies explicit frame'),sessionRecovery};
 return new Function(...Object.keys(args),js(fixture.getText(fixtureSource))+';return fixture;')(...Object.values(args))(null,options);
}
const settleInput=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
test('F1 repair3 actual setup revokes startup protocol and writable synchronously on owner error',async()=>{
 const h=setupFixture({parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',offset:0,end_offset:4,status:'running'}):undefined});await h.mount();
 const old=h.actual.openHistory({...record('running')},true);await settleInput();const view=h.refs.terminalViews.current.get('s-a');
 assert.equal(view.firstAttachment,true);assert.equal(h.parsers.length,1);view.writable=true;
 h.emit('session-error',{session_id:'',data:'offline'});assert.equal(view.firstAttachment,false);assert.equal(view.writable,false);
 view.instance.data('\x1b[1;1R');await settleInput();h.parsers.shift()();await old;view.instance.data('\x1b[1;1R');await settleInput();
 assert.deepEqual(h.calls.filter(c=>c.name==='write_session'),[]);assert.equal(view.writable,false);h.cleanup();
});
test('F1 repair3 actual pending write success or rejection cannot grant writable or overwrite owner error',async()=>{
 for(const outcome of ['resolve','reject']){
  let finish;const h=setupFixture({rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'ready',offset:0,end_offset:5,status:'running'}):name==='write_session'?new Promise((resolve,reject)=>finish=outcome==='resolve'?resolve:()=>reject(Error('late write'))):undefined});await h.mount();await h.actual.openHistory(record('running'),true);const view=h.refs.terminalViews.current.get('s-a');
  h.refs.sessionId.current='s-a';view.instance.data('\x1b[1;1R');await settleInput();assert.equal(typeof finish,'function');
  h.emit('session-error',{session_id:'',data:'offline'});finish();await settleInput();assert.equal(view.writable,false);assert.equal(h.state.error,'offline');assert.equal(h.calls.filter(c=>c.name==='resize_session').length,0);h.cleanup();
 }
});
test('F1 repair3 actual raw reselect after owner error waits for old parser then reads a fresh snapshot',async()=>{
 let reads=0;const h=setupFixture({parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:++reads===1?'old':'fresh',offset:0,end_offset:5,status:'running'}):undefined});await h.mount();
 const old=h.actual.openHistory(record('running'),true);await settleInput();h.emit('session-error',{session_id:'',data:'offline'});
 const fresh=h.actual.openHistory(record('running'));await settleInput();assert.equal(reads,1);assert.equal(h.parsers.length,1);
 h.parsers.shift()();await old;await settleInput();assert.equal(reads,2);assert.equal(h.parsers.length,1);
 h.parsers.shift()();await fresh;const view=h.refs.terminalViews.current.get('s-a');assert.equal(view.ready,true);assert.equal(view.availability,'available');assert.equal(view.firstAttachment,false);assert.equal(view.writable,false);h.cleanup();
});

test('F1 repair3 fresh explicit creator snapshot permits hidden startup replies after owner error',async()=>{
 const h=setupFixture({parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',offset:0,end_offset:4,status:'starting'}):undefined});await h.mount();
 h.emit('session-error',{session_id:'',data:'offline'});
 const creatorRecord={...record('running'),summary:{...record('running').summary,session_id:'s-new'}};
 const pending=h.actual.openHistory(creatorRecord,true);await settleInput();const view=h.refs.terminalViews.current.get('s-new');
 assert.equal(view.firstAttachment,true);assert.equal(view.ready,false);view.instance.data('\x1b[1;1R');await settleInput();
 assert.deepEqual(h.calls.filter(c=>c.name==='write_session').map(c=>c.sessionId),['s-new']);
 h.emit('session-error',{session_id:'',data:'offline again'});view.instance.data('\x1b[1;1R');await settleInput();assert.equal(h.calls.filter(c=>c.name==='write_session').length,1);
 h.parsers.shift()();await pending;assert.equal(view.ready,false);assert.equal(view.writable,false);h.cleanup();
});
test('F1 repair3 fresh cold history snapshot never authorizes replayed startup replies',async()=>{
 const h=setupFixture({parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',offset:0,end_offset:4,status:'running'}):undefined});await h.mount();h.emit('session-error',{session_id:'',data:'offline'});
 const pending=h.actual.openHistory(record('running'),false);await settleInput();const view=h.refs.terminalViews.current.get('s-a');view.instance.data('\x1b[1;1R');await settleInput();assert.equal(h.calls.filter(c=>c.name==='write_session').length,0);
 assert.equal(h.refs.ownerConnectionAvailable.current.available,false);h.parsers.shift()();await pending;assert.equal(view.ready,true);h.cleanup();
});

test('F1 repair3 actual pending resize failure cannot overwrite owner error or send a queued size',async()=>{
 let rejectResize;const h=setupFixture({rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'ready',offset:0,end_offset:5,status:'running'}):name==='resize_session'?new Promise((_,reject)=>rejectResize=reject):undefined});await h.mount();await h.actual.openHistory(record('running'),true);await h.flush();const view=h.refs.terminalViews.current.get('s-a');
 assert.equal(typeof rejectResize,'function');view.resizePending={cols:80,rows:20};h.emit('session-error',{session_id:'',data:'offline'});rejectResize(Error('late resize'));await settleInput();
 assert.equal(view.writable,false);assert.equal(view.resizePending,null);assert.equal(h.calls.filter(c=>c.name==='resize_session').length,1);assert.equal(h.state.error,'offline');h.cleanup();
});

test('F1 repair4 actual raw parser availability transition refreshes toolbar and palette render props',async()=>{
 let rerender=()=>{},changes=0;const h=snapshotHarness(()=>{changes++;queueMicrotask(()=>rerender());});
 const bindings={setRecoveryRevision(){},...h.bindings,session:h.rec.summary,sessionStatus:'stopped',starting:false,sessionRecovery,React:{createElement:(tag,props,...children)=>({tag,props,children})},Play:()=>null,paletteEntries,paletteQuery:'',orderedHistory:[],titleFor:()=>'',resumeSelectedSession(){}};
 const button=find(n=>ts.isJsxElement(n)&&n.openingElement.getText(source).includes('aria-label="Continue conversation"'));
 const renderNow=()=>new Function(...Object.keys(bindings),js(body('selectedRecovery')+'\nconst recovery=selectedRecovery();\nconst canContinue=recovery.canContinue;\nconst commandEntries='+declarations('commandEntries').initializer.getText(source)+';\nconst toolbar='+button.getText(source)+';')+'return {toolbar,commandEntries};')(...Object.values(bindings));
 let displayed=renderNow();rerender=()=>displayed=renderNow();h.ownerError({session_id:'',data:'offline'});
 const pending=h.openHistory(h.rec);h.pending.shift().resolve(null);await new Promise(setImmediate);h.pending.shift().resolve({data:'ordinary saved output',offset:0,end_offset:21,status:'stopped'});await new Promise(setImmediate);
 assert.equal(displayed.toolbar.props.disabled,true);assert.equal(displayed.commandEntries.some(e=>e.action==='resume'),false);changes=0;
 h.writes.shift()();await pending;
 assert.ok(changes>0,'actual valid parser completion must notify React');assert.equal(displayed.toolbar.props.disabled,false);assert.equal(displayed.commandEntries.some(e=>e.action==='resume'),true);
});

test('F1 repair4 actual projection and owner error notify only on availability transitions',async()=>{
 let changes=0;const h=connectionHarness(()=>changes++);h.view.availability='owner_unavailable';h.bindings.ownerConnectionAvailable.current.available=false;
 const fresh=h.renderFrame(h.view,'s-a',endedFrame,0);h.pending.shift()();await fresh;assert.equal(changes,1);
 await h.renderFrame(h.view,'s-a',endedFrame,0);assert.equal(changes,1,'unchanged projection ticks must not refresh React');
 h.ownerError({session_id:'',data:'offline'});assert.equal(changes,2);h.ownerError({session_id:'',data:'offline'});assert.equal(changes,2);
});
test('F1 repair4 actual terminal read failures notify only on availability transitions',async()=>{
 let changes=0;const h=pollHarness(()=>changes++);h.poll();h.pending.shift().reject(Error('unavailable'));await new Promise(setImmediate);assert.equal(changes,1);
 h.view.dirty=true;h.poll();h.pending.shift().reject(Error('unavailable'));await new Promise(setImmediate);assert.equal(changes,1);
});
