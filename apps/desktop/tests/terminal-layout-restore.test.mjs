// Author: Jeff.Liu. Actual App effects/callbacks; in-memory IPC and DOM, not native GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {TerminalViews} from '../src/terminal-views.ts';
import {createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,isTerminalProtocolResponse,clampSplitPercent,swapTerminalPanes} from '../src/terminal-layout.ts';
import {loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {queueTerminalResize} from '../src/terminal-settings.ts';

const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
assert.ok(app);
const declarations=app.body.statements.filter(ts.isFunctionDeclaration).filter(n=>!["refreshHistory","notifySession","updateAgentPhase"].includes(n.name?.text));
const effects=app.body.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect').map(n=>n.expression.arguments[0].getText(source));
const setupText=effects.find(text=>text.includes('createView.current =')&&text.includes('pending_notification_selection'));
assert.ok(setupText,'existing actual terminal setup effect');
const persistenceText=effects.filter(text=>text.includes('saveTerminalLayout')||text.includes('yam.terminalLayout'));
const initializers=app.body.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
 .filter(n=>/terminalLayout|layoutRestore|layoutBoot|layoutPreference|restoreLayout|restoreVersion|restoreGeneration|splitPercent/i.test(n.name.getText(source))||n.initializer?.getText(source).includes('loadTerminalLayout'));
const transpile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const tick=()=>new Promise(setImmediate);
async function settle(){for(let i=0;i<8;i++)await tick();}
const ids=['s-19aa2b3-1','s-19aa2b3-2','s-19aa2b3-3','s-19aa2b3-4'];
const notificationId='s-19aa2b3-9';
const record=id=>({summary:{session_id:id,cwd:'/fixture',command:'SECRET_COMMAND'},status:'running',agent:{phase:'working'}});
const snapshot=(mode,panes,selected=panes[0])=>JSON.stringify({version:1,mode,panes,selected});
function frame(id){return {projection:{version:1,session:id,instance:'a'.repeat(64),terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,data:'fixture output',cols:100,rows:40,cursorX:1,viewport:0,buffer:'normal'},end_offset:10,status:'running',persisted:false};}
function deferred(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no});return {promise,resolve,reject};}

function fixture(raw,{last=null,pending=null,readError=false,writeError=false,rpc,parserPending=false}={}){
 const calls=[],errors=[],storageReads=[],storageWrites=[],listeners=new Map(),raf=[],parsers=[],state={recoveryRevision:0};let nextFrame=0;
 const storage=new Map();if(raw!==null)storage.set('yam.terminalLayout',raw);if(last)storage.set('yam.lastSession',JSON.stringify(last));
 const ref=value=>({current:value});
 const refs={ownerConnectionAvailable:ref({available:true,version:0}),terminalViews:ref(new TerminalViews(16)),terminalMounted:ref(false),paneHosts:ref(new Map()),terminalHost:ref({append(e){e.parentElement=this;}}),createView:ref(null),creatingSession:ref(false),sessionId:ref(null),previousSession:ref(null),terminal:ref(null),fitAddon:ref(null),outputCursor:ref(null),selectedRecord:ref(null),detailVersion:ref(0),selectionVersion:ref(0),layoutVersion:ref(0),agentOutputWindow:ref(''),pendingState:ref(new Map()),pendingOutput:ref({drain:()=>[],push(){},delete(){},clear(){}}),pausedRef:ref(false),notificationContextVersion:ref(0),notificationContextFlight:ref({sending:false,pending:null}),terminalSettingsRef:ref({}),retryNotifications:ref(new Map()),pinnedSessionsRef:ref([]),projectConfigVersion:ref(0),projectSelection:ref({cancel(){}}),launchDialog:ref({close(){},showModal(){}}),projectDialog:ref({close(){}}),renameDialog:ref({close(){}})};
 const document={body:{},activeElement:null,hasFocus:()=>false,addEventListener(){},removeEventListener(){},createElement(){return {style:{},dataset:{},parentElement:null,inert:true,contains:()=>false,getBoundingClientRect:()=>({width:600,height:400}),addEventListener(){},remove(){}};}};document.activeElement=document.body;
 class Terminal {
  constructor(){this.cols=100;this.rows=40;this.options={};this.textarea={};this.modes={mouseTrackingMode:'none'};this._core={_inputHandler:{_activeBuffer:{x:0}}};}
  loadAddon(){}open(){}onData(fn){this.data=fn;return {dispose(){}};}onScroll(){return {dispose(){}};}reset(){}resize(){}scrollToLine(){}hasSelection(){return false;}focus(){document.activeElement=this.textarea;}dispose(){}write(data,done){if(parserPending&&done)parsers.push(done);else done?.();}writeln(){}
 }
 const localStorage={getItem(key){storageReads.push(key);if(readError&&key==='yam.terminalLayout')throw Error('SECRET_STORAGE_PATH');return storage.get(key)??null;},removeItem:key=>storage.delete(key),setItem(key,value){if(writeError&&key==='yam.terminalLayout')throw Error('SECRET_STORAGE_WRITE');storageWrites.push({key,value});storage.set(key,value);}};
 const args={setRecoveryRevision:update=>{state.recoveryRevision=typeof update==='function'?update(state.recoveryRevision):update;},...refs,document,localStorage,Terminal,FitAddon:class{fit(){}},ResizeObserver:class{observe(){}disconnect(){}},window:{addEventListener(){},removeEventListener(){},setInterval(){return 1;},clearInterval(){}},requestAnimationFrame:fn=>{const id=++nextFrame;fn.rafId=id;raf.push(fn);return id;},cancelAnimationFrame:id=>{const index=raf.findIndex(fn=>fn.rafId===id);if(index>=0)raf.splice(index,1);},createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,swapTerminalPanes,clampSplitPercent,isTerminalProtocolResponse,loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout,queueTerminalResize,applyTerminalFrame,validateTerminalFrame,terminalOptions:()=>({}),terminalStatuses:new Set(['succeeded','failed','stopped','needs_attention']),replayOutput:value=>({data:value.data??'',nextOffset:value.end_offset??0}),consumeOutput(){},refreshHistory(){},notifySession(){},updateAgentPhase(){},readPreference(key,fallback,valid){try{const value=JSON.parse(localStorage.getItem(key));return valid(value)?value:fallback;}catch{return fallback;}},listen:async(name,callback)=>{listeners.set(name,callback);return ()=>listeners.delete(name);},invoke:async(name,parameters)=>{calls.push({name,...parameters});const custom=rpc?.(name,parameters);if(custom!==undefined)return custom;if(name==='pending_notification_selection')return pending;if(name==='get_session')return record(parameters.sessionId);if(name==='read_terminal_frame')return frame(parameters.sessionId);return null;},setError:value=>{state.error=value;if(value)errors.push(value);},setSession:value=>state.session=value,setActiveProject(){},setSessionStatus(){},setSelectedAgent(){},setTerminalNotice:value=>state.notice=value,setAgentPhase(){},setPinnedSessions(){},setSessionTitles(){},setCollapsedProjects(){},setStarting(){},canCloseSessionView:status=>['succeeded','failed','stopped','needs_attention'].includes(status),starting:false,adapters:[],selectedAdapter:'shell',command:'',cwd:'',prompt:'',adapterArgs:'',useProjectSettings:false,projectPreview:null,projectConfigBusy:false,launchMode:'interactive',projectTemplate:'',projectLaunchEdits:{},projectKey:value=>value,setCwd(){},setProjectPreview(){},setUseProjectSettings(){},setProjectConfigBusy(){},setProjectConfigError(){},setProjectLaunchEdits(){},setSelectedAdapter(){},setLaunchMode(){},setCommand(){},setPrompt(){},setAdapterArgs(){},activeProject:'',session:null,globalLaunchDefaults:{adapter:'shell',mode:'task',extra_args:'',prompt:null,command:null},useRef:ref,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]};
 // Actual declarations initialize the layout and any narrowly scoped restore state.
 const names=initializers.map(n=>n.name.getText(source));
 const declared=new Set(initializers.filter(n=>ts.isIdentifier(n.name)).map(n=>n.name.text));
 const context=Object.fromEntries(Object.entries(args).filter(([name])=>!declared.has(name)));
 const init=initializers.map(n=>`let ${n.getText(source)};`).join('\n');
 const stateBindings=initializers.filter(n=>ts.isArrayBindingPattern(n.name)&&n.name.elements.length===2).map(n=>{const [value,setter]=n.name.elements.map(e=>e.name?.getText(source));return `${setter}=next=>{${value}=typeof next==='function'?next(${value}):next;};`;}).join('\n');
 const getters=names.map(name=>ts.isIdentifier(initializers[names.indexOf(name)].name)?name:name.slice(1,-1).split(',')[0].trim());
 const code=init+'\n'+stateBindings+'\n'+declarations.map(n=>n.getText(source)).join('\n')+`\nconst setup=${setupText};\nconst persist=()=>{${persistenceText.map(text=>`(${text})();`).join('\n')}};\nreturn {setup,persist,${getters.map(name=>`get ${name}(){return ${name}}`).join(',')},openSession,openHistory,focusTerminalPane,changeLayoutMode,closeTerminalPane,commitTerminalSplit,newSession,startSession,clearDeletedSessionNames,closeEndedView};`;
 const actual=new Function(...Object.keys(context),transpile(code))(...Object.values(context));
 return {actual,refs,state,calls,errors,storage,storageReads,storageWrites,listeners,raf,parsers,localStorage,async mount(){this.cleanup=actual.setup();await settle();},emit(name,payload){listeners.get(name)?.({payload});},layout:()=>actual.terminalLayoutRef.current,save:()=>actual.persist(),async flush(){await settle();while(raf.length)raf.shift()();await settle();}};
}
const forbidden=['create_session','resume_session','stop_session','write_session','take_terminal_control','resize_session'];
function noTaskMutation(h){assert.deepEqual(h.calls.filter(call=>forbidden.includes(call.name)),[]);}
function assertStored(h,expected){const writes=h.storageWrites.filter(w=>w.key==='yam.terminalLayout');assert.ok(writes.length,'actual App persistence writes the layout');assert.deepEqual(JSON.parse(writes.at(-1).value),expected.version===1?{...expected,version:2,splitPercent:50}:expected);}

test('T15 actual App restores two existing IDs in their saved panes and focus',async()=>{
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[1]));await h.mount();await h.flush();
 assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),ids.slice(0,2));
 assert.deepEqual(h.layout().panes,ids.slice(0,2));assert.equal(h.refs.sessionId.current,ids[1]);
 for(const id of ids.slice(0,2)){const view=h.refs.terminalViews.current.get(id);assert.ok(view);assert.equal(view.ready,true);assert.equal(view.writable,false);assert.equal(view.firstAttachment,false);}noTaskMutation(h);
});
test('F2 owner error revokes an in-flight attachment busy state through the real App listener',async()=>{
 const pending=[];const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>pending.push({id:args.sessionId,resolve})):undefined});await h.mount();await settle();
 const view=h.refs.terminalViews.current.get(ids[0]);assert.ok(view);view.attaching=true;const before=h.state.recoveryRevision;
 h.emit('session-error',{session_id:'',data:'Owner unavailable'});
 assert.equal(view.attaching,false,'owner epoch change revokes a pending flag synchronously');assert.ok(h.state.recoveryRevision>before,'the existing actual React revision setter rerenders the toolbar');assert.equal(view.availability,'owner_unavailable');
 for(const entry of pending)entry.resolve(frame(entry.id));await h.flush();
});
test('T15 actual App restores grid with selected empty slot without resurrecting lastSession',async()=>{
 const panes=[ids[0],null,ids[2],ids[3]],h=fixture(snapshot('grid',panes,null),{last:notificationId});await h.mount();await h.flush();
 assert.deepEqual(h.layout().panes,panes);assert.equal(h.layout().mode,'grid');assert.equal(h.layout().focused,1);assert.equal(h.refs.sessionId.current,null);noTaskMutation(h);
});
test('T15 actual App preserves intentional all-empty layout and does not use legacy fallback',async()=>{
 const h=fixture(snapshot('grid',[null,null,null,null],null),{last:notificationId});await h.mount();
 assert.deepEqual(h.layout().panes,[null,null,null,null]);assert.equal(h.layout().mode,'grid');assert.deepEqual(h.calls.filter(c=>c.name==='get_session'),[]);
});
test('T15 actual App suppresses first persistence while verification waits, then saves settled layout',async()=>{
 const d=deferred(),raw=snapshot('vertical',ids.slice(0,2),ids[0]);const h=fixture(raw,{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[0]?d.promise:undefined});
 await h.mount();h.save();assert.equal(h.storage.get('yam.terminalLayout'),raw);assert.equal(h.storageWrites.filter(w=>w.key==='yam.terminalLayout').length,0);
 d.resolve(record(ids[0]));await h.flush();h.save();assertStored(h,{version:1,mode:'vertical',panes:ids.slice(0,2),selected:ids[0]});
});
test('F2 App persists only the committed bounded split ratio beside existing ID state',async()=>{
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]));await h.mount();await h.flush();h.actual.commitTerminalSplit(63);h.save();
 assertStored(h,{version:2,mode:'horizontal',panes:ids.slice(0,2),selected:ids[0],splitPercent:63});
});
test('T15 actual App invalid schema and sensitive fields use fixed single-empty warning',async()=>{
 for(const raw of ['SECRET_BAD_JSON',snapshot('grid',[null,null,null,null],null).replace('"version":1','"version":9'),JSON.stringify({version:1,mode:'single',panes:[ids[0]],selected:ids[0],owner:'SECRET_OWNER'}),'x'.repeat(4097)]){
  const h=fixture(raw,{last:notificationId});await h.mount();assert.equal(h.layout().mode,'single');assert.deepEqual(h.layout().panes,[null]);assert.deepEqual(h.calls.filter(c=>c.name==='get_session'),[]);assert.ok(h.errors.length||h.state.notice,'fixed visible warning');assert.ok(!JSON.stringify(h.errors).includes('SECRET'));noTaskMutation(h);
 }
});
test('T15 actual App storage read failure is sanitized and does not resurrect legacy session',async()=>{
 const h=fixture('anything',{last:notificationId,readError:true});await h.mount();assert.deepEqual(h.calls.filter(c=>c.name==='get_session'),[]);assert.ok(h.errors.length||h.state.notice);assert.ok(!JSON.stringify(h.errors).includes('SECRET'));noTaskMutation(h);
});
test('T15 actual App any unknown, rejected or mismatched saved ID discards entire layout',async()=>{
 for(const kind of ['unknown','mismatch','rejected']){
  const result=kind==='unknown'?null:kind==='mismatch'?record(notificationId):null;
  const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[1]?(kind==='rejected'?Promise.reject(Error('SECRET_UNKNOWN_PATH')):Promise.resolve(result)):undefined});await h.mount();await h.flush();
  assert.equal(h.layout().mode,'single');assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.terminalViews.current.all.length,0);assert.ok(h.errors.length||h.state.notice);assert.ok(!JSON.stringify(h.errors).includes('SECRET'));noTaskMutation(h);
 }
});
test('T15 actual App pending startup notification bypasses saved IDs and is acknowledged after attachment',async()=>{
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{pending:notificationId});await h.mount();await h.flush();
 assert.equal(h.refs.sessionId.current,notificationId);assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),[notificationId]);assert.deepEqual(h.calls.filter(c=>c.name==='acknowledge_notification_selection').map(c=>c.sessionId),[notificationId]);h.save();assertStored(h,{version:1,mode:'single',panes:[notificationId],selected:notificationId});noTaskMutation(h);
});
test('T15 actual App user mode and empty focus during pending restore beat late success and failure',async()=>{
 for(const reject of [false,true]){const d=deferred(),h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:name=>name==='get_session'?d.promise:undefined});await h.mount();h.actual.changeLayoutMode('grid');h.actual.focusTerminalPane(2,false);h.save();
  if(reject)d.reject(Error('SECRET_LATE_FAILURE'));else d.resolve(record(ids[0]));await h.flush();h.save();assert.deepEqual(h.layout().panes,[null,null,null,null]);assert.equal(h.layout().focused,2);assert.ok(!JSON.stringify(h.errors).includes('SECRET'));assertStored(h,{version:1,mode:'grid',panes:[null,null,null,null],selected:null});noTaskMutation(h);
 }
});
test('T15 actual App deferred notification read invalidates saved verification before its reply',async()=>{
 const saved=deferred(),click=deferred();let currentPending=null;
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='pending_notification_selection'?Promise.resolve(currentPending):name==='get_session'?(args.sessionId===notificationId?click.promise:saved.promise):undefined});await h.mount();currentPending=notificationId;h.emit('session-notification-click',notificationId);saved.resolve(record(ids[0]));await settle();click.resolve(record(notificationId));await h.flush();
 assert.equal(h.refs.sessionId.current,notificationId);assert.deepEqual(h.layout().panes,[notificationId]);h.save();assertStored(h,{version:1,mode:'single',panes:[notificationId],selected:notificationId});noTaskMutation(h);
});
test('T15 actual App owner gap or fatal error prevents old restore success and error from applying',async()=>{
 for(const name of ['background-gap','session-error']){const d=deferred(),h=fixture(snapshot('grid',ids,ids[0]),{rpc:n=>n==='get_session'?d.promise:undefined});await h.mount();h.emit(name,name==='background-gap'?{missing_events:false}:{session_id:'',data:'Owner unavailable'});d.resolve(record(ids[0]));await h.flush();assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.sessionId.current,null);assert.equal(h.refs.terminalViews.current.all.length,0);noTaskMutation(h);}
});
test('T15 actual App unmount and repeated setup invalidate prior restore finalizers',async()=>{
 const d=deferred(),h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[0]?d.promise:undefined});await h.mount();h.cleanup();d.resolve(record(ids[0]));await h.flush();assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.terminalViews.current.all.length,0);assert.equal(h.storageWrites.filter(w=>w.key==='yam.terminalLayout').length,0);assert.deepEqual(h.errors,[]);
 await h.mount();await h.flush();assert.deepEqual(h.layout().panes,ids.slice(0,2));noTaskMutation(h);
});
test('T15 actual App later mode close and focus mutations save exact ID-only data',async()=>{
 const h=fixture(null);await h.mount();h.actual.changeLayoutMode('grid');h.save();assertStored(h,{version:1,mode:'grid',panes:[null,null,null,null],selected:null});await h.actual.openSession(ids[0]);h.actual.closeTerminalPane(0);h.save();assertStored(h,{version:1,mode:'grid',panes:[null,null,null,null],selected:null});assert.ok(!JSON.stringify(h.storageWrites).includes('SECRET_COMMAND'));
});
test('T15 actual App persistence error does not destroy views or leak storage exception',async()=>{
 const h=fixture(snapshot('single',[ids[0]],ids[0]),{writeError:true});await h.mount();await h.flush();h.save();assert.ok(h.refs.terminalViews.current.get(ids[0]));assert.ok(h.errors.length||h.state.notice);assert.ok(!JSON.stringify(h.errors).includes('SECRET'));noTaskMutation(h);
});


test('T15 actual App validates every saved ID before attaching any pane',async()=>{
 const d=deferred(),h=fixture(snapshot('grid',ids,ids[0]),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[3]?d.promise:undefined});await h.mount();
 assert.ok(h.calls.some(c=>c.name==='get_session'&&c.sessionId===ids[3]),'current owner validates last saved ID');assert.equal(h.refs.terminalViews.current.size,0);assert.deepEqual(h.calls.filter(c=>c.name==='read_terminal_frame'),[]);
 d.resolve(null);await h.flush();assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.terminalViews.current.size,0);
});
test('T15 actual App existing ended and archived owner records restore without resume or control',async()=>{
 const h=fixture(snapshot('vertical',ids.slice(0,2),ids[1]),{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:'succeeded',archived:true}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'succeeded',persisted:true}):undefined});await h.mount();await h.flush();assert.deepEqual(h.layout().panes,ids.slice(0,2));for(const id of ids.slice(0,2)){assert.equal(h.refs.terminalViews.current.get(id).live,false);assert.equal(h.refs.terminalViews.current.get(id).writable,false);}noTaskMutation(h);
});
for(const action of ['same-focus','empty-focus','close','new','start','delete','close-ended'])test(`T15 actual App ${action} intent cancels pending saved validation`,async()=>{
 const d=deferred(),created=deferred(),h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:name=>name==='get_session'?d.promise:name==='create_session'?created.promise:undefined});await h.mount();
 assert.ok(h.calls.some(c=>c.name==='get_session'),'real restore is pending before user action');
 let starting;
 if(action==='same-focus')h.actual.focusTerminalPane(0,false);
 if(action==='empty-focus'){h.actual.changeLayoutMode('grid');h.actual.focusTerminalPane(2,false);}
 if(action==='close')h.actual.closeTerminalPane(0);
 if(action==='new')h.actual.newSession('/fixture');
 if(action==='start')starting=h.actual.startSession({cwd:'/fixture',command:'fixture'});
 if(action==='delete')h.actual.clearDeletedSessionNames([ids[0]]);
 if(action==='close-ended')h.actual.closeEndedView();
 d.resolve(record(ids[0]));await h.flush();assert.ok(!h.layout().panes.includes(ids[0]),'old restore does not steal newer intent');
 if(starting){created.resolve({...record(notificationId).summary,status:'running'});await starting;await h.flush();assert.equal(h.refs.sessionId.current,notificationId);assert.equal(h.refs.creatingSession.current,false);assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);}
});
test('T15 actual App late restored frame or parser and RAF cannot steal notification focus',async()=>{
 for(const stage of ['frame','parser','raf']){
  const d=deferred();let pending=null;const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{parserPending:stage==='parser',rpc:(name,args)=>name==='pending_notification_selection'?Promise.resolve(pending):name==='read_terminal_frame'&&args.sessionId===ids[0]?(stage==='frame'?d.promise:stage==='parser'?Promise.resolve(null):undefined):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',end_offset:10,status:'running'}):undefined});await h.mount();
  assert.ok(h.calls.some(c=>c.name==='read_terminal_frame'&&c.sessionId===ids[0]),'restore attached before delay');
  pending=notificationId;h.emit('session-notification-click',notificationId);await settle();
  const newerPanes=[...h.layout().panes];
  d.resolve(frame(ids[0]));while(h.parsers.length)h.parsers.shift()();await h.flush();while(h.parsers.length)h.parsers.shift()();await h.flush();
  assert.equal(h.refs.sessionId.current,notificationId);assert.deepEqual(h.layout().panes,newerPanes);noTaskMutation(h);
 }
});
test('T15 actual App cold restored raw queries never send protocol replies',async()=>{
 const h=fixture(snapshot('single',[ids[0]],ids[0]),{parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',end_offset:10,status:'running'}):undefined});await h.mount();const view=h.refs.terminalViews.current.get(ids[0]);assert.ok(view);assert.equal(view.firstAttachment,false);view.instance.data('\x1b[1;1R');await settle();assert.deepEqual(h.calls.filter(c=>c.name==='write_session'),[]);while(h.parsers.length)h.parsers.shift()();await h.flush();assert.equal(view.ready,true);noTaskMutation(h);
});


test('T15 actual App same-ID focus during restored frame wait attaches a current usable view',async()=>{
 const frames=[];const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'&&args.sessionId===ids[0]?new Promise(resolve=>frames.push(resolve)):undefined});await h.mount();assert.equal(frames.length,1);const view=h.refs.terminalViews.current.get(ids[0]);assert.ok(view);assert.equal(view.ready,false);
 h.actual.focusTerminalPane(0,false);frames[0](frame(ids[0]));await settle();if(frames[1])frames[1](frame(ids[0]));await h.flush();
 assert.equal(h.refs.sessionId.current,ids[0]);assert.equal(view.ready,true,'newer user-selected pane must not remain permanently unready');assert.equal(view.element.inert,false);assert.equal(view.writable,false);noTaskMutation(h);
});


test('T15 actual App newer empty-pane user intent defeats a deferred notification success and failure',async()=>{
 for(const fails of [false,true]){
  const saved=deferred(),clicked=deferred();let pending=null;
  const h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name,args)=>name==='pending_notification_selection'?Promise.resolve(pending):name==='get_session'?(args.sessionId===notificationId?clicked.promise:saved.promise):undefined});await h.mount();pending=notificationId;h.emit('session-notification-click',notificationId);await settle();h.actual.changeLayoutMode('grid');h.actual.focusTerminalPane(2,false);const previousErrors=[...h.errors];
  if(fails)clicked.reject(Error('SECRET_OLD_CLICK'));else clicked.resolve(record(notificationId));saved.resolve(record(ids[0]));await h.flush();assert.equal(h.refs.sessionId.current,null);assert.deepEqual(h.layout().panes,[null,null,null,null]);assert.equal(h.layout().focused,2);assert.deepEqual(h.errors,previousErrors);noTaskMutation(h);
 }
});


// Actual refreshHistory body calls the actual App deletion reconciler; only inbox IO is inert.
async function actualRefresh(h,deletedIds){
 const refresh=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='refreshHistory');
 const args={setRecoveryRevision(){},historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),setHistoryLoading(){},setHistory(){},setHistoryCursor(){},setHistoryOverview(){},deletionReceiptKey:{current:''},clearDeletedSessionNames:h.actual.clearDeletedSessionNames,refreshInbox(){},refreshPendingNotifications(){},selectedRecord:h.refs.selectedRecord,setSelectedAgent(){},setError:e=>h.errors.push(e),invoke:async name=>name==='list_session_summaries'?{items:[],next_cursor:null}:name==='history_overview'?{latest_deletion:{preview_id:'historical-deletion',deleted_ids:deletedIds}}:null};
 await new Function(...Object.keys(args),transpile(refresh.getText(source))+';return refreshHistory;')(...Object.values(args))();
 return args;
}
for(const action of ['mode','second-focus','close-other','delete-unrelated'])test(`T15 repair actual App ${action} adopts all retained verified panes`,async()=>{
 const frames=[];const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'&&args.sessionId===ids[0]?new Promise(resolve=>frames.push(resolve)):undefined});await h.mount();
 assert.equal(frames.length,1);const view=h.refs.terminalViews.current.get(ids[0]);assert.ok(view);assert.equal(view.ready,false);
 if(action==='mode')h.actual.changeLayoutMode('grid');
 if(action==='second-focus')h.actual.focusTerminalPane(1,false);
 if(action==='close-other')h.actual.closeTerminalPane(1);
 if(action==='delete-unrelated')h.actual.clearDeletedSessionNames([notificationId]);
 await settle();for(const resolve of frames)resolve(frame(ids[0]));await h.flush();
 for(const id of h.layout().panes.filter(Boolean)){const retained=h.refs.terminalViews.current.get(id);assert.ok(retained,'every retained verified ID has an attachment');assert.equal(retained.ready,true,'latest visible intent must remain usable');assert.equal(retained.writable,false);assert.equal(retained.firstAttachment,false);}
 assert.equal(h.refs.sessionId.current,action==='second-focus'?ids[1]:ids[0]);assert.equal(view.element.inert,false);noTaskMutation(h);
});
test('T15 repair actual refreshHistory ignores unrelated persisted deletion during verification',async()=>{
 const d=deferred(),raw=snapshot('horizontal',ids.slice(0,2),ids[0]);const h=fixture(raw,{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[0]?d.promise:undefined});await h.mount();
 await actualRefresh(h,[notificationId]);h.save();assert.equal(h.storage.get('yam.terminalLayout'),raw);assert.equal(h.actual.layoutRestore.current.pending,true);
 d.resolve(record(ids[0]));await h.flush();assert.deepEqual(h.layout().panes,ids.slice(0,2));assert.deepEqual(h.errors,[]);noTaskMutation(h);
});
test('T15 repair actual refreshHistory rejects intersecting pending hints as a whole once',async()=>{
 const d=deferred(),h=fixture(snapshot('grid',ids,ids[0]),{rpc:name=>name==='get_session'?d.promise:undefined});await h.mount();
 const refresh=await actualRefresh(h,[ids[2]]);d.resolve(record(ids[0]));await h.flush();h.save();
 assert.deepEqual(h.layout().panes,[null]);assert.equal(h.layout().mode,'single');assert.equal(h.refs.terminalViews.current.size,0);assert.equal(h.errors.filter(e=>e==='Saved terminal layout is unavailable. Using a single pane.').length,1);assert.ok(refresh.deletionReceiptKey.current);noTaskMutation(h);
});
test('T15 repair multiple same-turn intents coalesce to final membership and focus',async()=>{
 const frames=[];const h=fixture(snapshot('grid',ids,ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>frames.push({id:args.sessionId,resolve})):undefined});await h.mount();
 h.actual.changeLayoutMode('horizontal');h.actual.closeTerminalPane(0);h.actual.focusTerminalPane(1,false);await settle();
 for(const entry of frames)entry.resolve(frame(entry.id));await h.flush();
 assert.deepEqual(h.layout().panes,[null,ids[1]]);assert.equal(h.refs.sessionId.current,ids[1]);assert.equal(h.refs.terminalViews.current.get(ids[1])?.ready,true);assert.equal(h.refs.terminalViews.current.get(ids[0])?.element.style.visibility,'hidden');assert.ok(frames.length<=5,'bounded first four plus retained one');noTaskMutation(h);
});
for(const invalidation of ['notification','owner','gap','unmount'])test(`T15 repair ${invalidation} supersedes queued adoption and its late callbacks`,async()=>{
 const frames=[];let pending=null;const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='pending_notification_selection'?Promise.resolve(pending):name==='read_terminal_frame'&&args.sessionId!==notificationId?new Promise(resolve=>frames.push({id:args.sessionId,resolve})):undefined});await h.mount();
 h.actual.changeLayoutMode('grid');h.actual.focusTerminalPane(1,false);
 if(invalidation==='notification'){pending=notificationId;h.emit('session-notification-click',notificationId);}
 if(invalidation==='owner')h.emit('session-error',{session_id:'',data:'Owner unavailable'});
 if(invalidation==='gap')h.emit('background-gap',{missing_events:false});
 if(invalidation==='unmount')h.cleanup();
 await settle();const intent={panes:[...h.layout().panes],focused:h.layout().focused,id:h.refs.sessionId.current,errors:[...h.errors]};
 for(const entry of frames)entry.resolve(frame(entry.id));await h.flush();
 assert.deepEqual({panes:h.layout().panes,focused:h.layout().focused,id:h.refs.sessionId.current,errors:h.errors},intent);for(const view of h.refs.terminalViews.current.all)assert.equal(view.writable,false);noTaskMutation(h);
});

test('T15 repair raw parser completion from cancelled attachment cannot enable the old generation',async()=>{
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{parserPending:true,rpc:name=>name==='read_terminal_frame'?Promise.resolve(null):name==='read_session_snapshot'?Promise.resolve({data:'\x1b[6n',end_offset:10,status:'running'}):undefined});await h.mount();
 const views=ids.slice(0,2).map(id=>h.refs.terminalViews.current.get(id));assert.ok(views.every(Boolean));assert.equal(h.parsers.length,2);
 h.actual.changeLayoutMode('vertical');h.actual.focusTerminalPane(1,false);await settle();
 const old=h.parsers.splice(0);for(const finish of old)finish();assert.ok(views.every(view=>!view.ready),'old raw parser completion stays stale');await settle();
 for(let round=0;round<4;round++){while(h.parsers.length)h.parsers.shift()();await h.flush();}
 assert.ok(views.every(view=>view.ready&&!view.writable&&!view.firstAttachment));assert.equal(h.refs.sessionId.current,ids[1]);noTaskMutation(h);
});
test('T15 repair explicit start suppresses queued boot adoption before admission',async()=>{
 const frames=[],created=deferred();const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>frames.push({id:args.sessionId,resolve})):name==='create_session'?created.promise:undefined});await h.mount();
 h.actual.changeLayoutMode('grid');const starting=h.actual.startSession({cwd:'/fixture',command:'fixture'});await settle();assert.equal(frames.length,2,'start does not schedule an old readonly attachment');
 created.resolve({...record(notificationId).summary,status:'running'});await settle();for(const entry of frames)entry.resolve(frame(entry.id));await starting;await h.flush();assert.equal(h.refs.sessionId.current,notificationId);assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);
});


test('T15 repair2 passive unrelated receipt preserves pending startup notification detail fence',async()=>{
 const clicked=deferred();const h=fixture(snapshot('single',[ids[0]],ids[0]),{pending:notificationId,rpc:(name,args)=>name==='get_session'&&args.sessionId===notificationId?clicked.promise:undefined});await h.mount();
 const detail=h.refs.detailVersion.current,selection=h.refs.selectionVersion.current;await actualRefresh(h,[ids[3]]);
 assert.equal(h.refs.detailVersion.current,detail);assert.equal(h.refs.selectionVersion.current,selection);
 clicked.resolve(record(notificationId));await h.flush();assert.equal(h.refs.sessionId.current,notificationId);assert.equal(h.calls.filter(c=>c.name==='acknowledge_notification_selection').length,1);noTaskMutation(h);
});
test('T15 repair2 current user history selection survives internal retained-pane adoption',async()=>{
 const frames=[],clicked=deferred();const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'&&args.sessionId!==notificationId?new Promise(resolve=>frames.push({id:args.sessionId,resolve})):name==='get_session'&&args.sessionId===notificationId?clicked.promise:undefined});await h.mount();
 const selecting=h.actual.openSession(notificationId);await settle();clicked.resolve(record(notificationId));await selecting;for(const entry of frames)entry.resolve(frame(entry.id));await h.flush();
 assert.equal(h.refs.sessionId.current,notificationId);assert.ok(h.refs.terminalViews.current.get(notificationId)?.ready);noTaskMutation(h);
});
for(const action of ['focus','mode','notification','owner'])for(const reject of [false,true])test(`T15 repair2 newer ${action} intent defeats history query ${reject?'failure':'success'}`,async()=>{
 const frames=[],clicked=deferred();let pending=null;
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='pending_notification_selection'?Promise.resolve(pending):name==='read_terminal_frame'&&ids.slice(0,2).includes(args.sessionId)?new Promise(resolve=>frames.push({id:args.sessionId,resolve})):name==='get_session'&&args.sessionId===notificationId?clicked.promise:undefined});await h.mount();const selecting=h.actual.openSession(notificationId);await settle();
 if(action==='focus')h.actual.focusTerminalPane(1,false);
 if(action==='mode')h.actual.changeLayoutMode('vertical');
 if(action==='notification'){pending=ids[3];h.emit('session-notification-click',ids[3]);}
 if(action==='owner')h.emit('session-error',{session_id:'',data:'Owner unavailable'});
 await settle();const intent={panes:[...h.layout().panes],id:h.refs.sessionId.current,errors:[...h.errors]};
 if(reject)clicked.reject(Error('SECRET_OLD_HISTORY_FAILURE'));else clicked.resolve(record(notificationId));await selecting;
 for(const entry of frames)entry.resolve(frame(entry.id));await h.flush();
 assert.deepEqual({panes:h.layout().panes,id:h.refs.sessionId.current,errors:h.errors},intent);noTaskMutation(h);
});
