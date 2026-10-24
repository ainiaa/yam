import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {defaultTerminalLineHeight,parseTerminalLineHeight} from '../src/terminal-line-height.ts';
import {TERMINAL_SCROLLBACK_LINES} from '../src/terminal-frame.ts';
import {terminalCursorOptions,defaultTerminalCursor} from '../src/terminal-cursor.ts';
import {readSavedWindowPreference,windowPreferenceKey,terminalWindowClaim,publishWindowPreference,terminalMoveReply} from '../src/window-context.ts';
import {terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation} from '../src/terminal-frame.ts';
// Author: Jeff.Liu. Actual App effects/callbacks; in-memory IPC and DOM, not native GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {TerminalViews} from '../src/terminal-views.ts';
import * as layoutOperations from '../src/terminal-layout.ts';
import {createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,isTerminalProtocolResponse,clampSplitPercent,swapTerminalPanes} from '../src/terminal-layout.ts';
import {loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
import {createTerminalScroll,updateTerminalScroll} from '../src/terminal-scroll.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {queueTerminalResize,saveTerminalSettings} from '../src/terminal-settings.ts';

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

function fixture(raw,{last=null,pending=null,readError=false,writeError=false,rpc,parserPending=false,appearanceBindings={}}={}){
 const calls=[],errors=[],storageReads=[],storageWrites=[],listeners=new Map(),raf=[],parsers=[],state={recoveryRevision:0};let nextFrame=0;
 const storage=new Map();if(raw!==null)storage.set('yam.terminalLayout',raw);if(last)storage.set('yam.lastSession',JSON.stringify(last));
 const ref=value=>({current:value});
 const refs={conversationOpenRef:ref(false),titlesRef:ref({}),terminalReopen:ref(null),terminalReopenFlight:ref(null),terminalMoveTaskRef:ref(null),terminalMoveIncomingRef:ref(null),terminalMoveOperationRef:ref(false),pendingViewClaims:ref(new Map()),viewClaimSelection:ref(0),paneClaimSelection:ref(new Map()),fileDropPending:ref(null),pastePending:ref(null),zoomedPaneIdRef:ref(null),terminalPaneZoomIntent:ref(0),ownerConnectionAvailable:ref({available:true,version:0}),terminalViews:ref(new TerminalViews(16)),terminalMounted:ref(false),paneHosts:ref(new Map()),terminalHost:ref({append(e){e.parentElement=this;}}),createView:ref(null),creatingSession:ref(false),sessionId:ref(null),previousSession:ref(null),terminal:ref(null),fitAddon:ref(null),outputCursor:ref(null),selectedRecord:ref(null),detailVersion:ref(0),selectionVersion:ref(0),layoutVersion:ref(0),agentOutputWindow:ref(''),pendingState:ref(new Map()),pendingOutput:ref({drain:()=>[],push(){},delete(){},clear(){}}),pausedRef:ref(false),notificationContextVersion:ref(0),notificationContextFlight:ref({sending:false,pending:null}),terminalSettingsRef:ref({fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"dark"}),retryNotifications:ref(new Map()),pinnedSessionsRef:ref([]),projectConfigVersion:ref(0),projectSelection:ref({cancel(){}}),launchDialog:ref({close(){},showModal(){},querySelectorAll(){return [];}}),projectDialog:ref({close(){}}),renameDialog:ref({close(){}})};
 const document={body:{},activeElement:null,hasFocus:()=>false,addEventListener(){},removeEventListener(){},createElement(){return {style:{},dataset:{},parentElement:null,inert:true,contains:()=>false,getBoundingClientRect:()=>({width:600,height:400}),addEventListener(){},removeEventListener(){},remove(){}};}};document.activeElement=document.body;
 class Terminal {
  constructor(options){this.cols=100;this.rows=40;this.options={...options};this.textarea={};this.modes={mouseTrackingMode:'none'};this._core={_inputHandler:{_activeBuffer:{x:0}}};}
  loadAddon(){}open(){}onData(fn){this.data=fn;return {dispose(){}};}onScroll(){return {dispose(){}};}reset(){}resize(){}refresh(start,end){this.refreshes??=[];this.refreshes.push([start,end]);}scrollToLine(){}hasSelection(){return false;}focus(){document.activeElement=this.textarea;}dispose(){}write(data,done){if(parserPending&&done)parsers.push(done);else done?.();}writeln(){}
 }
 const localStorage={getItem(key){storageReads.push(key);if(readError&&key==='yam.terminalLayout')throw Error('SECRET_STORAGE_PATH');return storage.get(key)??null;},removeItem:key=>storage.delete(key),setItem(key,value){if(writeError&&key==='yam.window.main.terminalLayout')throw Error('SECRET_STORAGE_WRITE');storageWrites.push({key,value});storage.set(key,value);}};
 const desktopWindow={slot:"main",epoch:1,main_epoch:1,owned_ids:[],conflict:false,restore_blocked:false,requested_session:null,preference:readSavedWindowPreference(localStorage,"main")};
 const args={isSessionPreferenceKey:()=>false,sessionCopyIntent:{current:0},setSessionCopy(){},setCopyName(){},ordinaryLaunchSnapshot:{current:undefined},currentProject:null,terminalProfileCollection:{profiles:[],defaultId:null,loadError:null},terminalProfileStart:()=>({cwd:""}),shellLaunchRef:{current:null},shellWindows:false,setLaunchDirectoryOverride(){},setLaunchTerminalProfile(){},setLaunchWorktreeAttempt(){},setConversationOpen(){},providerConfig:null,setProviderConfig(){},TERMINAL_SCROLLBACK_LINES,desktopWindow,isMainWindow:true,windowPreferenceKey:name=>windowPreferenceKey("main",name),terminalWindowClaim:()=>1,installTerminalLinks:()=>({dispose(){}}),shortcutMac:false,setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision:update=>{state.recoveryRevision=typeof update==='function'?update(state.recoveryRevision):update;},...refs,document,localStorage,Terminal,FitAddon:class{fit(){}},ResizeObserver:class{observe(){}disconnect(){}},window:{addEventListener(){},removeEventListener(){},setInterval(){return 1;},clearInterval(){}},requestAnimationFrame:fn=>{const id=++nextFrame;fn.rafId=id;raf.push(fn);return id;},cancelAnimationFrame:id=>{const index=raf.findIndex(fn=>fn.rafId===id);if(index>=0)raf.splice(index,1);},createTerminalLayout,assignTerminalPane,removeTerminalPane,changeTerminalLayout,swapTerminalPanes,clampSplitPercent,isTerminalProtocolResponse,loadTerminalLayout,saveTerminalLayout,decodeTerminalLayout,encodeTerminalLayout,queueTerminalResize,applyTerminalFrame,terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,validateTerminalFrame,terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},terminalCursorOptions,terminalSystemThemeRef:{current:"dark"},terminalOptions:()=>({}),terminalStatuses:new Set(['succeeded','failed','stopped','needs_attention']),replayOutput:value=>({data:value.data??'',nextOffset:value.end_offset??0}),consumeOutput(){},refreshHistory(){},notifySession(){},updateAgentPhase(){},readPreference(key,fallback,valid){try{const value=JSON.parse(localStorage.getItem(key));return valid(value)?value:fallback;}catch{return fallback;}},listen:async(name,callback)=>{listeners.set(name,callback);return ()=>listeners.delete(name);},invoke:async(name,parameters)=>{calls.push({name,...parameters});const custom=rpc?.(name,parameters);if(custom!==undefined)return custom;if(name==='claim_terminal_view')return 1;if(name==='pending_notification_selection')return pending;if(name==='get_session')return record(parameters.sessionId);if(name==='read_terminal_frame')return frame(parameters.sessionId);return null;},setError:value=>{state.error=value;if(value)errors.push(value);},setSession:value=>state.session=value,setActiveProject(){},setSessionStatus(){},setSelectedAgent:value=>state.agent=value,setTerminalNotice:value=>state.notice=value,setAgentPhase(){},setPinnedSessions:next=>state.pins=typeof next==='function'?next(state.pins??[]):next,setSessionTitles:next=>state.titles=typeof next==='function'?next(state.titles??{}):next,setCollapsedProjects(){},setStarting:value=>state.starting=value,canCloseSessionView:status=>['succeeded','failed','stopped','needs_attention'].includes(status),starting:false,adapters:[],selectedAdapter:'shell',command:'',cwd:'',prompt:'',adapterArgs:'',useProjectSettings:false,projectPreview:null,projectConfigBusy:false,launchMode:'interactive',projectTemplate:'',projectLaunchEdits:{},projectKey:value=>value,setCwd(){},setProjectPreview(){},setUseProjectSettings(){},setProjectConfigBusy(){},setProjectConfigError(){},setProjectLaunchEdits(){},setLaunchDraft(){},setSelectedAdapter(){},setLaunchMode(){},setCommand(){},setPrompt(){},setAdapterArgs(){},activeProject:'',session:null,globalLaunchDefaults:{adapter:'shell',mode:'task',extra_args:'',prompt:null,command:null},useRef:ref,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],...appearanceBindings};
 // Actual declarations initialize the layout and any narrowly scoped restore state.
 const names=initializers.map(n=>n.name.getText(source));
 const declared=new Set(initializers.filter(n=>ts.isIdentifier(n.name)).map(n=>n.name.text));
 const context=Object.fromEntries(Object.entries(args).filter(([name])=>!declared.has(name)));
 const init=initializers.map(n=>`let ${n.getText(source)};`).join('\n');
 const stateBindings=initializers.filter(n=>ts.isArrayBindingPattern(n.name)&&n.name.elements.length===2).map(n=>{const [value,setter]=n.name.elements.map(e=>e.name?.getText(source));return `${setter}=next=>{${value}=typeof next==='function'?next(${value}):next;};`;}).join('\n');
 const getters=names.map(name=>ts.isIdentifier(initializers[names.indexOf(name)].name)?name:name.slice(1,-1).split(',')[0].trim());
 const code=init+'\n'+stateBindings+'\n'+declarations.map(n=>n.getText(source)).join('\n')+`\nconst setup=${setupText};\nconst persist=()=>{${persistenceText.map(text=>`(${text})();`).join('\n')}};\nreturn {setup,persist,get retrySavedLayout(){return retrySavedLayout;},commitTerminalAppearance,receiveWindowPreference,${getters.map(name=>`get ${name}(){return ${name}}`).join(',')},restoreTerminalSurface,refreshSelectedAgent,openReceipt,showConversation,applyTerminalPreferences,migrateTerminalMetadata,applyTerminalTabMove,disposeMoveSource,openSession,openHistory,selectTerminalTab,reopenTerminalTab,canReopenTerminalTab,closeTerminalTab,focusTerminalPane,changeLayoutMode,splitFocusedTerminalPane,closeTerminalPane,commitTerminalSplit,newSession,startSession,clearDeletedSessionNames,closeEndedView};`;
 const actual=new Function(...Object.keys(context),transpile(code))(...Object.values(context));
 return {actual,desktopWindow,refs,document,state,calls,errors,storage,storageReads,storageWrites,listeners,raf,parsers,localStorage,async mount(){this.cleanup=actual.setup();await settle();},emit(name,payload){listeners.get(name)?.({payload});},layout:()=>actual.terminalLayoutRef.current,save:()=>actual.persist(),async flush(){await settle();while(raf.length)raf.shift()();await settle();}};
}
const forbidden=['create_session','resume_session','stop_session','write_session','take_terminal_control','resize_session'];
function noTaskMutation(h){assert.deepEqual(h.calls.filter(call=>forbidden.includes(call.name)),[]);}
function assertStored(h,expected){
 const writes=h.storageWrites.filter(w=>w.key==='yam.window.main.terminalLayout');assert.ok(writes.length,'actual App persistence writes the layout');
 const saved=JSON.parse(writes.at(-1).value);assert.equal(saved.version,5);assert.deepEqual(Object.keys(saved).sort(),['appearances','focusedPane','root','version']);
 const result=decodeTerminalLayout(writes.at(-1).value);assert.equal(result.warning,null);assert.deepEqual(result.layout.panes,expected.panes);assert.equal(result.layout.mode,expected.mode);
 assert.equal(result.layout.panes[result.layout.focused],expected.selected);assert.equal(result.layout.focused,h.layout().focused,'exact empty pane identity persists');
 if(expected.mode==='horizontal'||expected.mode==='vertical')assert.equal(result.splitPercent,expected.splitPercent??50);
}

test('F2 owner error revokes an in-flight attachment busy state through the real App listener',async()=>{
 const pending=[];const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>pending.push({id:args.sessionId,resolve})):undefined});await h.mount();await settle();
 const view=h.refs.terminalViews.current.get(ids[0]);assert.ok(view);view.attaching=true;const before=h.state.recoveryRevision;
 h.emit('session-error',{session_id:'',data:'Owner unavailable'});
 assert.equal(view.attaching,false,'owner epoch change revokes a pending flag synchronously');assert.ok(h.state.recoveryRevision>before,'the existing actual React revision setter rerenders the toolbar');assert.equal(view.availability,'owner_unavailable');
 for(const entry of pending)entry.resolve(frame(entry.id));await h.flush();
});
test('T15 actual App restores two existing IDs in their saved panes and focus',async()=>{
 const h=fixture(snapshot('horizontal',ids.slice(0,2),ids[1]));await h.mount();await h.flush();
 assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),ids.slice(0,2));
 assert.deepEqual(h.layout().panes,ids.slice(0,2));assert.equal(h.refs.sessionId.current,ids[1]);
 for(const id of ids.slice(0,2)){const view=h.refs.terminalViews.current.get(id);assert.ok(view);assert.equal(view.ready,true);assert.equal(view.writable,false);assert.equal(view.firstAttachment,false);}noTaskMutation(h);
});
for(const action of ['startup','select','reopen','close-tab','close-pane','move','remove'])test('ended history stays read-only during '+action,async()=>{
 let layout=changeTerminalLayout(createTerminalLayout(),'horizontal');layout=assignTerminalPane(layout,0,ids[0]);layout=assignTerminalPane(layout,0,ids[1]);layout=assignTerminalPane(layout,1,ids[2]);
 const ended=id=>({...record(id),status:'stopped'});
 const h=fixture(action==='select'?null:encodeTerminalLayout(layout),{rpc:(name,args)=>name==='get_session'?Promise.resolve(ended(args.sessionId)):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();await h.flush();
 if(action==='select')await h.actual.openSession(ids[0]);
 if(action==='reopen'){h.actual.closeTerminalTab(0,ids[1]);await h.actual.reopenTerminalTab();}
 if(action==='close-tab')h.actual.closeTerminalTab(0,ids[1]);
 if(action==='close-pane')h.actual.closeTerminalPane(0);
 if(action==='move')h.actual.applyTerminalTabMove(layoutOperations.moveTerminalTab(h.layout(),ids[1],1),ids[1]);
 if(action==='remove')h.actual.clearDeletedSessionNames([ids[1]]);
 await h.flush();noTaskMutation(h);for(const view of h.refs.terminalViews.current.all){assert.equal(view.live,false);assert.equal(view.recordedOnly,true);}h.cleanup();
});

test('ended history keeps its identity, title and pin at the sixteen-view limit',async()=>{
 const members=Array.from({length:16},(_,i)=>`s-19aa2b3-${(i+1).toString(16)}`);let saved=createTerminalLayout();for(const id of members)saved=assignTerminalPane(saved,0,id);
 const h=fixture(encodeTerminalLayout(saved),{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:'stopped'}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();await h.flush();h.refs.titlesRef.current={[members[0]]:'Named history'};h.refs.pinnedSessionsRef.current=[members[0]];
 assert.equal(await h.actual.openSession(members[0]),true);await h.flush();noTaskMutation(h);assert.equal(h.refs.sessionId.current,members[0]);assert.equal(h.refs.terminalViews.current.size,16);assert.equal(h.refs.titlesRef.current[members[0]],'Named history');assert.deepEqual(h.refs.pinnedSessionsRef.current,[members[0]]);h.cleanup();
});

test('late ended-history frame cannot steal a newer live selection',async()=>{
 const wait=deferred(),h=fixture(null,{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:args.sessionId===ids[0]?'stopped':'running'}):name==='read_terminal_frame'&&args.sessionId===ids[0]?wait.promise:undefined});await h.mount();
 const old=h.actual.openSession(ids[0]);await settle();await h.actual.openSession(ids[1]);wait.resolve({...frame(ids[0]),status:'stopped',persisted:true});await old;await h.flush();noTaskMutation(h);assert.equal(h.refs.sessionId.current,ids[1]);h.cleanup();
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
 await h.mount();h.save();assert.equal(h.storage.get('yam.terminalLayout'),raw);assert.equal(h.storageWrites.filter(w=>w.key==='yam.window.main.terminalLayout').length,0);
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
 assert.equal(h.refs.sessionId.current,notificationId);assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),[notificationId,notificationId]);assert.deepEqual(h.calls.filter(c=>c.name==='acknowledge_notification_selection').map(c=>c.sessionId),[notificationId]);h.save();assertStored(h,{version:1,mode:'single',panes:[notificationId],selected:notificationId});noTaskMutation(h);
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
 const d=deferred(),h=fixture(snapshot('horizontal',ids.slice(0,2),ids[0]),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[0]?d.promise:undefined});await h.mount();h.cleanup();d.resolve(record(ids[0]));await h.flush();assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.terminalViews.current.all.length,0);assert.equal(h.storageWrites.filter(w=>w.key==='yam.window.main.terminalLayout').length,0);assert.deepEqual(h.errors,[]);
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
test('ended and archived visible tabs restore only their readable saved scene',async()=>{
 for(const archived of [false,true]){
  const h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:'stopped',archived}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
  await h.mount();await h.flush();noTaskMutation(h);assert.equal(h.refs.sessionId.current,ids[0]);assert.equal(h.refs.terminalViews.current.get(ids[0]).ready,true);assert.equal(h.refs.terminalViews.current.get(ids[0]).live,false);h.cleanup();
 }
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
async function actualRefresh(h,deletedIds,items=[]){
 const refresh=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='refreshHistory');
 const args={refreshSelectedAgent:h.actual.refreshSelectedAgent,isMainWindow:true,migrateTerminalMetadata:h.actual.migrateTerminalMetadata,TERMINAL_SCROLLBACK_LINES,setRecoveryRevision(){},historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({}),setHistoryLoading(){},setHistory(){},setHistoryCursor(){},setHistoryOverview(){},deletionReceiptKey:{current:''},clearDeletedSessionNames:h.actual.clearDeletedSessionNames,refreshInbox(){},refreshPendingNotifications(){},selectedRecord:h.refs.selectedRecord,setSelectedAgent(){},setError:e=>h.errors.push(e),invoke:async name=>name==='list_session_summaries'?{items,next_cursor:null}:name==='history_overview'?{latest_deletion:{preview_id:'historical-deletion',deleted_ids:deletedIds}}:null};
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
 assert.deepEqual(h.layout().panes,[ids[2],ids[1]]);assert.deepEqual(layoutOperations.terminalMembers(h.layout()),[ids[2],ids[3],ids[1]]);assert.equal(h.refs.sessionId.current,ids[1]);assert.equal(h.refs.terminalViews.current.get(ids[1])?.ready,true);assert.equal(h.refs.terminalViews.current.get(ids[0])?.element.style.visibility,'hidden');assert.ok(frames.length<=7,'bounded first four plus all three retained members');noTaskMutation(h);
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


test('B02a actual App restores nested v3 tree and exact empty focused identity after validating all members',async()=>{
 let saved=changeTerminalLayout(createTerminalLayout(),'horizontal');saved=assignTerminalPane(saved,0,ids[0]);saved=assignTerminalPane(saved,1,ids[1]);saved=layoutOperations.splitTerminalPane({...saved,focused:1},'vertical');
 const raw=encodeTerminalLayout(saved),h=fixture(raw);await h.mount();await h.flush();
 assert.deepEqual(h.layout().root,decodeTerminalLayout(encodeTerminalLayout(saved)).layout.root);assert.equal(h.layout().focused,2);assert.equal(h.refs.sessionId.current,null);
 assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),ids.slice(0,2));
 const firstAttach=h.calls.findIndex(c=>c.name==='read_terminal_frame');assert.ok(h.calls.slice(0,firstAttach).filter(c=>c.name==='get_session').length===2);noTaskMutation(h);
 h.save();const latest=JSON.parse(h.storageWrites.filter(w=>w.key==='yam.window.main.terminalLayout').at(-1).value);assert.deepEqual({...latest,version:4,appearances:undefined},{...JSON.parse(raw),appearances:undefined});
});
test('B02a actual App missing v3 member discards whole tree without attaching or task mutation',async()=>{
 let saved=changeTerminalLayout(createTerminalLayout(),'horizontal');saved=assignTerminalPane(saved,0,ids[0]);saved=assignTerminalPane(saved,1,ids[1]);saved=layoutOperations.splitTerminalPane({...saved,focused:1},'vertical');
 const h=fixture(encodeTerminalLayout(saved),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[1]?Promise.resolve(null):undefined});await h.mount();await h.flush();
 assert.deepEqual(h.layout(),createTerminalLayout());assert.equal(h.calls.some(c=>c.name==='read_terminal_frame'),false);noTaskMutation(h);
});
test('B02a actual user split cancels pending v3 verification and late reply cannot overwrite empty tree',async()=>{
 const wait=deferred(),saved=assignTerminalPane(createTerminalLayout(),0,ids[0]);
 const h=fixture(encodeTerminalLayout(saved),{rpc:name=>name==='get_session'?wait.promise:undefined});await h.mount();
 assert.equal(h.storageWrites.filter(w=>w.key==='yam.window.main.terminalLayout').length,0);
 h.actual.splitFocusedTerminalPane('vertical');const root=structuredClone(h.layout().root);wait.resolve(record(ids[0]));await h.flush();
 assert.deepEqual(h.layout().root,root);assert.deepEqual(h.layout().panes,[null,null]);assert.equal(h.layout().focused,1);assert.equal(h.refs.sessionId.current,null);assert.equal(h.refs.terminalViews.current.size,0);noTaskMutation(h);
});

test('B02b actual startup verifies and attaches every hidden member while preserving order active and empty focus',async()=>{
 let layout=layoutOperations.splitTerminalPane(createTerminalLayout(),'horizontal');layout=assignTerminalPane(layout,0,ids[0]);layout=assignTerminalPane(layout,0,ids[1]);layout={...layout,focused:1};
 const h=fixture(encodeTerminalLayout(layout));await h.mount();await h.flush();h.save();
 assert.deepEqual(h.calls.filter(c=>c.name==='get_session').map(c=>c.sessionId),ids.slice(0,2));assert.deepEqual(h.layout().panes,[ids[1],null]);assert.equal(h.layout().focused,1);assert.equal(h.refs.sessionId.current,null);
 for(const id of ids.slice(0,2))assert.equal(h.refs.terminalViews.current.get(id).ready,true);assert.equal(h.refs.terminalViews.current.get(ids[0]).element.inert,true);assert.equal(h.refs.terminalViews.current.get(ids[1]).element.style.visibility,'visible');
 assert.deepEqual(layoutOperations.terminalMembers(decodeTerminalLayout(h.storage.get('yam.window.main.terminalLayout')).layout),ids.slice(0,2));noTaskMutation(h);
});
test('B02b invalid hidden owner member makes the complete saved layout unavailable before attachment',async()=>{
 let layout=assignTerminalPane(createTerminalLayout(),0,ids[0]);layout=assignTerminalPane(layout,0,ids[1]);
 const h=fixture(encodeTerminalLayout(layout),{rpc:(name,args)=>name==='get_session'&&args.sessionId===ids[0]?null:undefined});await h.mount();await h.flush();
 assert.deepEqual(h.layout().panes,[null]);assert.equal(h.refs.terminalViews.current.size,0);assert.equal(h.calls.some(c=>c.name==='read_terminal_frame'),false);noTaskMutation(h);assert.ok(h.errors.some(e=>/Saved terminal layout is unavailable/.test(e)));
});

// Independent B05a review reproduction promoted unchanged in behavior to the actual restore fixture.
for(const failure of ['owner-rejection','mismatched-record','null-record'])test(`B05a post-bootstrap ${failure} preserves namespaced raw and persistence gate`,async()=>{
 const raw=snapshot('horizontal',ids.slice(0,2),ids[0]);
 const h=fixture(raw,{rpc:(name,args)=>name==='get_session'?(failure==='owner-rejection'?Promise.reject(Error('temporary owner failure')):Promise.resolve(failure==='null-record'?null:record(notificationId))):undefined});
 h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();await h.flush();h.save();h.save();
 assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.storageWrites.filter(row=>row.key==='yam.window.main.terminalLayout').length,0);assert.ok(h.errors.some(error=>/Saved terminal layout is unavailable/.test(error)));assert.equal(h.refs.terminalViews.current.size,0);noTaskMutation(h);
});
test('B05a post-bootstrap successful records permit normal settled persistence',async()=>{const raw=snapshot('horizontal',ids.slice(0,2),ids[1]),h=fixture(raw);h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();await h.flush();h.save();assertStored(h,{mode:'horizontal',panes:ids.slice(0,2),selected:ids[1]});noTaskMutation(h);});
test('B05a post-bootstrap pending selection owner error preserves raw without retry or spawn',async()=>{const raw=snapshot('horizontal',ids.slice(0,2),ids[0]),h=fixture(raw,{rpc:name=>name==='pending_notification_selection'?Promise.reject(Error('owner unavailable')):undefined});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();await h.flush();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.storageWrites.length,0);assert.ok(h.errors.length);noTaskMutation(h);});

function retrySaved(h){let button;function walk(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='button'&&node.children.some(child=>ts.isJsxText(child)&&child.text.trim()==='Retry saved layout'))button=node;ts.forEachChild(node,walk);}walk(source);assert.ok(button,'actual restore error must expose Retry saved layout');const props=button.openingElement.attributes.properties;assert.ok(props.some(prop=>prop.name?.text==='disabled'),'busy retry is disabled');return h.actual.retrySavedLayout();}
test('B05a actual restore error retry succeeds without spawn and reuses warm renderer',async()=>{let failing=true;const raw=snapshot('horizontal',ids.slice(0,2),ids[0]),h=fixture(raw,{rpc:name=>name==='get_session'&&failing?Promise.reject(Error('temporary')):undefined});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);failing=false;await h.actual.openHistory(record(ids[0]));const warm=h.refs.terminalViews.current.get(ids[0]);await retrySaved(h);await h.flush();h.save();assert.equal(h.refs.terminalViews.current.get(ids[0]),warm);assertStored(h,{mode:'horizontal',panes:ids.slice(0,2),selected:ids[0]});noTaskMutation(h);});
test('B05a actual duplicate retry clicks share one recovery and failed retry preserves raw',async()=>{let mode='fail',reads=0;const wait=deferred(),raw=snapshot('horizontal',ids.slice(0,2),ids[0]),h=fixture(raw,{rpc:(name,args)=>{if(name!=='get_session')return;if(mode==='fail')return Promise.reject(Error('temporary'));reads++;return args.sessionId===ids[0]?wait.promise:record(args.sessionId);}});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();await retrySaved(h);h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);mode='wait';const first=retrySaved(h),duplicate=retrySaved(h);await settle();assert.equal(reads,1);assert.equal(h.actual.layoutRestoreRetrying,true);wait.resolve(record(ids[0]));await Promise.all([first,duplicate]);await h.flush();h.save();assertStored(h,{mode:'horizontal',panes:ids.slice(0,2),selected:ids[0]});noTaskMutation(h);});
test('B05a actual later layout intent defeats late retry without overwriting selection',async()=>{let failing=true;const wait=deferred(),raw=snapshot('horizontal',ids.slice(0,2),ids[0]),h=fixture(raw,{rpc:name=>name==='get_session'?(failing?Promise.reject(Error('temporary')):wait.promise):undefined});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();failing=false;const retry=retrySaved(h);await settle();h.actual.changeLayoutMode('grid');h.actual.focusTerminalPane(2,false);const current={panes:[...h.layout().panes],focus:h.layout().focused};wait.resolve(record(ids[0]));await retry;await h.flush();assert.deepEqual({panes:h.layout().panes,focus:h.layout().focused},current);assert.equal(h.refs.terminalViews.current.size,0);h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);noTaskMutation(h);});

test('B05a actual New intent rejects late retry error without replacing current state',async()=>{let failing=true;const wait=deferred(),raw=snapshot('horizontal',ids.slice(0,2),ids[0]),h=fixture(raw,{rpc:name=>name==='get_session'?(failing?Promise.reject(Error('temporary')):wait.promise):undefined});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();failing=false;const retry=retrySaved(h);await settle();h.actual.newSession('/fixture/new');const current={panes:[...h.layout().panes],focus:h.layout().focused,error:h.state.error};wait.reject(Error('late retry rejection'));await retry;await h.flush();assert.deepEqual({panes:h.layout().panes,focus:h.layout().focused,error:h.state.error},current);h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.actual.layoutRestoreRetrying,false);noTaskMutation(h);});

// Author: Jeff.Liu. Preserve raw invalid preference through actual setup -> finish -> persistence.
for(const raw of ['{invalid raw',JSON.stringify({version:999,secret:'PRIVATE'}),JSON.stringify({version:4,root:{type:'leaf',id:'bad'},focusedPane:'bad'})])test('invalid saved-layout warning keeps raw across actual persistence '+raw.slice(0,20),async()=>{const h=fixture(raw);h.storage.set('yam.window.main.terminalLayout',raw);h.desktopWindow.preference=readSavedWindowPreference(h.localStorage,'main');await h.mount();await h.flush();h.save();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.storageWrites.filter(x=>x.key==='yam.window.main.terminalLayout').length,0);assert.equal(h.desktopWindow.restore_blocked,true);await h.actual.retrySavedLayout();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.calls.filter(c=>['get_session','claim_terminal_view'].includes(c.name)).length,0);assert.ok(h.errors.length);noTaskMutation(h);});
test('unreadable saved-layout warning never overwrites raw on persistence rerun',async()=>{const raw='PRIVATE_UNREADABLE',h=fixture(raw,{readError:true});await h.mount();await h.flush();h.save();h.save();assert.equal(h.storage.get('yam.terminalLayout'),raw);assert.equal(h.storageWrites.length,0);assert.equal(h.desktopWindow.restore_blocked,true);noTaskMutation(h);});
test('explicit new terminal start retains existing invalid-layout unblock escape',async()=>{const h=fixture('{invalid',{rpc:name=>name==='create_session'?Promise.reject(Error('controlled create rejection')):undefined});await h.mount();assert.equal(h.desktopWindow.restore_blocked,true);const promise=h.actual.startSession({cwd:'/fixture',command:'fixture'});await promise;assert.equal(h.desktopWindow.restore_blocked,false);assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);});

test('invalid raw survives actual appearance Save and subsequent layout persistence effect',async()=>{const raw='{invalid appearance raw',h=fixture(raw,{appearanceBindings:{saveTerminalSettings,publishWindowPreference,nativeInvoke:async()=>null,setTerminalSettings(){},setTerminalSettingsError(){}}});h.storage.set('yam.window.main.terminalLayout',raw);h.desktopWindow.preference=readSavedWindowPreference(h.localStorage,'main');await h.mount();h.actual.applyTerminalPreferences({fontFamily:'monospace',fontSize:14,theme:'dark'});await h.flush();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.storageWrites.filter(x=>x.key==='yam.window.main.terminalLayout').length,0);assert.equal(h.storageWrites.filter(x=>x.key==='yam.terminalSettings').length,1);noTaskMutation(h);});

const restoreAppearance={fontFamily:'Saved Profile',fontSize:22,theme:'system'};
test('v5 actual fresh restore uses saved appearance while cached renderer and global fallback preserve precedence',async()=>{const settings=await import('../src/terminal-settings.ts');const saved=assignTerminalPane(createTerminalLayout(),0,ids[0]),raw=encodeTerminalLayout(saved,undefined,{[ids[0]]:restoreAppearance});const h=fixture(raw,{appearanceBindings:{terminalSettingsRef:{current:settings.defaultTerminalSettings},terminalOptions:value=>settings.terminalOptions(value,'light')}});await h.mount();await h.flush();const view=h.refs.terminalViews.current.get(ids[0]);assert.deepEqual(view.appearance,restoreAppearance);assert.equal(view.instance.options.fontSize,22);assert.equal(view.instance.options.theme.background,'#fafafa');h.save();assert.deepEqual(decodeTerminalLayout(h.storage.get('yam.window.main.terminalLayout')).appearances[ids[0]],restoreAppearance);noTaskMutation(h);});
test('v5 invalid annotation follows preserved-raw gate with zero session/claim reads',async()=>{const core=JSON.parse(encodeTerminalLayout(assignTerminalPane(createTerminalLayout(),0,ids[0])));const raw=JSON.stringify({...core,version:5,appearances:{[ids[0]]:{...restoreAppearance,fontSize:9}}});const h=fixture(raw);h.storage.set('yam.window.main.terminalLayout',raw);h.desktopWindow.preference=readSavedWindowPreference(h.localStorage,'main');await h.mount();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);assert.equal(h.desktopWindow.restore_blocked,true);assert.equal(h.calls.filter(c=>['get_session','claim_terminal_view'].includes(c.name)).length,0);noTaskMutation(h);});

test('v5 hidden layout tabs retain distinct appearance and cached views ignore old restored annotation',async()=>{const settings=await import('../src/terminal-settings.ts');let layout=assignTerminalPane(createTerminalLayout(),0,ids[0]);layout=assignTerminalPane(layout,0,ids[1]);const second={fontFamily:'Hidden',fontSize:10,theme:'solarized'},raw=encodeTerminalLayout(layout,undefined,{[ids[0]]:restoreAppearance,[ids[1]]:second});const h=fixture(raw,{appearanceBindings:{terminalSettingsRef:{current:settings.defaultTerminalSettings},terminalOptions:settings.terminalOptions}});await h.mount();await h.flush();assert.deepEqual(h.refs.terminalViews.current.get(ids[0]).appearance,restoreAppearance);const view=h.refs.terminalViews.current.get(ids[1]);assert.deepEqual(view.appearance,second);await h.actual.openHistory(record(ids[1]),false,undefined,undefined,undefined,restoreAppearance);assert.equal(h.refs.terminalViews.current.get(ids[1]),view);assert.deepEqual(view.appearance,second);h.save();assert.deepEqual(decodeTerminalLayout(h.storage.get('yam.window.main.terminalLayout')).appearances,{[ids[0]]:restoreAppearance,[ids[1]]:second});noTaskMutation(h);});
test('v5 late claim from obsolete owner cannot create an annotated renderer',async()=>{const wait=deferred(),raw=encodeTerminalLayout(assignTerminalPane(createTerminalLayout(),0,ids[0]),undefined,{[ids[0]]:restoreAppearance}),h=fixture(raw,{rpc:name=>name==='claim_terminal_view'?wait.promise:undefined});await h.mount();h.refs.ownerConnectionAvailable.current.version++;wait.resolve(1);await h.flush();assert.equal(h.refs.terminalViews.current.size,0);noTaskMutation(h);});
test('v5 failed layout write keeps applied appearance and original raw; explicit Apply retries snapshot',async()=>{const settings=await import('../src/terminal-settings.ts'),saved=assignTerminalPane(createTerminalLayout(),0,ids[0]),raw=encodeTerminalLayout(saved,undefined,{[ids[0]]:restoreAppearance});const h=fixture(raw,{appearanceBindings:{saveTerminalSettings,publishWindowPreference,nativeInvoke:async()=>null,setTerminalSettings(){},setTerminalSettingsError(){},terminalSettingsRef:{current:settings.defaultTerminalSettings},terminalOptions:settings.terminalOptions}});await h.mount();await h.flush();h.save();const old=h.storage.get('yam.window.main.terminalLayout'),write=h.localStorage.setItem;h.localStorage.setItem=(key,value)=>{if(key==='yam.window.main.terminalLayout')throw Error('quota');write(key,value);};const next={fontFamily:'Applied',fontSize:19,theme:'light'};h.actual.applyTerminalPreferences(next);h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),old);assert.deepEqual(h.refs.terminalViews.current.get(ids[0]).appearance,next);assert.ok(h.errors.some(error=>error.includes('save terminal layout')));h.localStorage.setItem=write;h.actual.applyTerminalPreferences(next);h.save();assert.deepEqual(decodeTerminalLayout(h.storage.get('yam.window.main.terminalLayout')).appearances[ids[0]],next);noTaskMutation(h);});

test('v5 valid saved appearance survives owner rejection and explicit Retry; missing annotation uses global',async()=>{const settings=await import('../src/terminal-settings.ts');for(const annotated of [true,false]){let failing=true;const raw=encodeTerminalLayout(assignTerminalPane(createTerminalLayout(),0,ids[0]),undefined,annotated?{[ids[0]]:restoreAppearance}:{}),h=fixture(raw,{rpc:name=>name==='get_session'&&failing?Promise.reject(Error('owner unavailable')):undefined,appearanceBindings:{terminalSettingsRef:{current:settings.defaultTerminalSettings},terminalOptions:settings.terminalOptions}});h.storage.set('yam.window.main.terminalLayout',raw);await h.mount();h.save();assert.equal(h.storage.get('yam.window.main.terminalLayout'),raw);failing=false;await retrySaved(h);await h.flush();assert.deepEqual(h.refs.terminalViews.current.get(ids[0]).appearance,annotated?restoreAppearance:settings.defaultTerminalSettings);noTaskMutation(h);}});
test('v5 actual secondary appearance commit saves only its own annotated layout with zero shared echo',async()=>{const settings=await import('../src/terminal-settings.ts'),context=await import('../src/window-context.ts'),raw=encodeTerminalLayout(assignTerminalPane(createTerminalLayout(),0,ids[0]),undefined,{[ids[0]]:restoreAppearance});let echo=0;const h=fixture(raw,{appearanceBindings:{isMainWindow:false,windowPreferenceKey:name=>windowPreferenceKey('terminal-secondary',name),preferenceRevision:{current:0},acceptWindowPreferenceCommit:context.acceptWindowPreferenceCommit,publishWindowPreference:()=>{echo++;return Promise.resolve();},saveTerminalSettings:()=>assert.fail('secondary global write'),setTerminalSettings(){},setTerminalSettingsError(){},terminalSettingsRef:{current:settings.defaultTerminalSettings},terminalOptions:settings.terminalOptions}});h.desktopWindow.slot='terminal-secondary';await h.mount();await h.flush();const next={fontFamily:'Shared',fontSize:16,theme:'light'};h.actual.receiveWindowPreference({source_epoch:1,revision:1,key:'yam.terminalSettings',value:JSON.stringify(next),appearance_action:'apply'});h.save();assert.deepEqual(decodeTerminalLayout(h.storage.get('yam.window.terminal-secondary.terminalLayout')).appearances[ids[0]],next);assert.equal(echo,0);assert.equal(h.storageWrites.filter(x=>x.key==='yam.terminalSettings').length,0);assert.equal(h.storageWrites.filter(x=>x.key==='yam.window.main.terminalLayout').length,0);noTaskMutation(h);});

// A native dialog close may restore focus after the next window-claim await.
test('provider desktop start attaches new view before modal focus restoration',async()=>{
 const h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name)=>name==='create_session'?{...record(ids[1]).summary,status:'running'}:undefined});
 await h.mount();await h.flush();
 const old=h.refs.terminalViews.current.get(ids[0]);assert.equal(old.element.inert,false);
 let closed=0;
 const origin={tagName:"TEXTAREA"};h.document.activeElement=origin;
 h.refs.launchDialog.current.open=true;h.refs.launchDialog.current.contains=element=>element===origin;
 h.refs.launchDialog.current.close=()=>{h.refs.launchDialog.current.open=false;closed++;queueMicrotask(()=>{if(!old.element.inert)h.actual.focusTerminalPane(h.layout().focused);});};
 await h.actual.startSession({cwd:'/fixture',command:'',launch:null});await h.flush();
 assert.deepEqual(h.errors,[]);assert.equal(closed,1);
 assert.equal(h.refs.sessionId.current,ids[1],'modal focus restoration must not cancel the explicit new-session attachment');
 assert.equal(h.refs.terminalViews.current.get(ids[1]).ready,true);
 assert.equal(h.refs.terminal.current,h.refs.terminalViews.current.get(ids[1]).instance);
 assert.equal(h.document.activeElement,h.refs.terminalViews.current.get(ids[1]).instance.textarea);
});

for(const action of ['direct terminal','continue','closed modal'])test('desktop delayed start preserves newer search focus: '+action,async()=>{
 const wait=deferred(),h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name,args)=>name==='create_session'?{...record(ids[1]).summary,status:'running'}:name==='read_terminal_frame'&&args.sessionId===ids[1]?wait.promise:undefined});
 await h.mount();await h.flush();
 const dialog=h.refs.launchDialog.current;dialog.open=action==='closed modal';dialog.contains=()=>true;
 const start=h.actual.startSession(action==='continue'?{resumeFrom:ids[0]}:{cwd:'/fixture',command:'',launch:null});await settle();
 assert.equal(h.refs.terminalViews.current.get(ids[1]).ready,false,'attachment must be pending before the new focus intent');
 dialog.open=false;
 const search={tagName:'INPUT',isConnected:true};h.document.activeElement=search;
 wait.resolve(frame(ids[1]));await start;await h.flush();
 assert.deepEqual(h.errors,[]);assert.equal(h.refs.terminalViews.current.get(ids[1]).ready,true);
 assert.equal(h.document.activeElement,search,'late attachment must not redirect newer input to the terminal');
});

for(const via of ['tab','pane','sidebar','reader','terminal'])test('followup warm '+via+' refreshes hidden authoritative conversation identity without restarting',async()=>{
 let latest=false;const fresh={generation:'g',agent_session_id:'native-after-hidden',phase:'waiting',last_receipt:{revision:7}};
 const h=fixture(via==='pane'?snapshot('horizontal',ids.slice(0,2),ids[1]):null,{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),agent:latest&&args.sessionId===ids[0]?fresh:{phase:'working'}}):undefined});await h.mount();
 if(via!=='pane'){await h.actual.openSession(ids[0]);await h.actual.openSession(ids[1]);}await h.flush();const a=h.refs.terminalViews.current.get(ids[0]),version=a.attachVersion;
 latest=true;h.refs.conversationOpenRef.current=!['reader','terminal'].includes(via);
 if(via==='sidebar')await h.actual.openSession(ids[0]);else if(via==='pane')h.actual.focusTerminalPane(0);else {h.actual.selectTerminalTab(0,ids[0]);await h.flush();if(via==='reader')h.actual.showConversation(true);}
 await h.flush();assert.deepEqual(h.state.agent,fresh);assert.deepEqual(a.record.agent,fresh);assert.equal(a.attachVersion,version);noTaskMutation(h);h.cleanup();
});

for(const invalidation of ['selection','owner','attachment','disposed','mismatched','rejection','newer-request','same-focus'])test('followup selected agent refresh fences '+invalidation,async()=>{
 const wait=deferred();let refresh=false;const fresh={generation:'new',agent_session_id:'native-new',phase:'waiting'};
 const h=fixture(null,{rpc:(name,args)=>name==='get_session'&&refresh?wait.promise:undefined});await h.mount();await h.actual.openSession(ids[0]);await h.flush();const view=h.refs.terminalViews.current.get(ids[0]);
 refresh=true;h.actual.showConversation(true);await settle();assert.ok(h.calls.filter(c=>c.name==='get_session').length>=2,'opening reader must refresh the current authenticated record');
 if(invalidation==='selection'){h.actual.changeLayoutMode('horizontal');h.actual.focusTerminalPane(1);assert.equal(h.refs.sessionId.current,null);}
 if(invalidation==='owner')h.refs.ownerConnectionAvailable.current.version++;
 if(invalidation==='attachment')view.attachVersion++;
 if(invalidation==='disposed')view.disposed=true;
 if(invalidation==='newer-request'||invalidation==='same-focus'){refresh=false;if(invalidation==='same-focus')h.actual.focusTerminalPane(0);else h.actual.showConversation(true);await settle();}
 const before=structuredClone({agent:h.state.agent,selected:h.refs.selectedRecord.current,record:view.record});
 if(invalidation==='rejection')wait.reject(Error('unavailable'));else wait.resolve({...record(invalidation==='mismatched'?ids[1]:ids[0]),agent:fresh});await h.flush();
 assert.deepEqual({agent:h.state.agent,selected:h.refs.selectedRecord.current,record:view.record},before);noTaskMutation(h);h.cleanup();
});

test('followup pending warm claim cannot overwrite a newer selected agent record',async()=>{
 const claim=deferred();let delayed=false,latest=false;
 const fresh={generation:'g-new',agent_session_id:'native-new',phase:'waiting',last_receipt:{revision:8}};
 const h=fixture(null,{rpc:(name,args)=>name==='claim_terminal_view'&&delayed?claim.promise:name==='get_session'?Promise.resolve({...record(args.sessionId),agent:latest?fresh:{phase:'working'}}):undefined});await h.mount();await h.actual.openSession(ids[0]);await h.flush();h.refs.conversationOpenRef.current=true;
 const view=h.refs.terminalViews.current.get(ids[0]),version=view.attachVersion;delayed=true;const opening=h.actual.openHistory(view.record);await settle();latest=true;await h.actual.refreshSelectedAgent();assert.deepEqual(view.record.agent,fresh);
 claim.resolve(1);await opening;await h.flush();assert.deepEqual(view.record.agent,fresh);assert.deepEqual(h.state.agent,fresh);assert.equal(view.attachVersion,version);noTaskMutation(h);h.cleanup();
});

for(const reading of [false,true])test('P1 actual Inbox ended card keeps original process read-only reading='+reading,async()=>{
 const {captureAttention,isCurrentAttention}=await import('../src/attention-actions.ts');
 const entry={id:'g:t:PermissionRequest',revision:3,turn_id:'t',kind:'needs_permission',delivery:'accepted',read:false,error:null},agent={generation:'g',turn_id:'t',revision:3,phase:'needs_permission',integration:'connected',inbox:[entry]};
 const ended={...record(ids[0]),status:'stopped',agent};
 const h=fixture(null,{rpc:(name,args)=>name==='get_session'?Promise.resolve(ended):name==='read_terminal_frame'?Promise.resolve({...frame(ids[0]),status:'stopped',persisted:true}):undefined,appearanceBindings:{captureAttention,isCurrentAttention,attentionOperation:{current:0}}});await h.mount();h.refs.conversationOpenRef.current=reading;
 await h.actual.openReceipt(ended,entry,agent);await h.flush();assert.equal(h.refs.sessionId.current,ids[0]);assert.equal(h.refs.terminalViews.current.get(ids[0]).recordedOnly,true);assert.equal(h.refs.conversationOpenRef.current,false);noTaskMutation(h);assert.equal(h.calls.some(c=>c.name==='read_agent_receipt'),false);h.cleanup();
});

test('P1 actual live Inbox card opens Terminal and acknowledges before deferred focus restoration',async()=>{
 const {captureAttention,isCurrentAttention}=await import('../src/attention-actions.ts');const entry={id:'g:t:PermissionRequest',revision:3,turn_id:'t',kind:'needs_permission',delivery:'accepted',read:false,error:null},agent={generation:'g',turn_id:'t',revision:3,phase:'needs_permission',integration:'connected',inbox:[entry]},live={...record(ids[0]),agent};
 const h=fixture(null,{rpc:name=>name==='get_session'?Promise.resolve(live):undefined,appearanceBindings:{captureAttention,isCurrentAttention,attentionOperation:{current:0}}});await h.mount();h.refs.conversationOpenRef.current=true;await h.actual.openReceipt(live,entry,agent);await h.flush();assert.equal(h.refs.conversationOpenRef.current,false);assert.equal(h.calls.filter(c=>c.name==='read_agent_receipt').length,1);assert.equal(h.refs.terminalViews.current.get(ids[0]).live,true);noTaskMutation(h);h.cleanup();
});

for(const transition of ['newer input focus','process exit'])test('P1 actual delayed Inbox navigation preserves '+transition,async()=>{
 const {captureAttention,isCurrentAttention}=await import('../src/attention-actions.ts'),wait=deferred();let reads=0;
 const entry={id:'g:t:PermissionRequest',revision:3,turn_id:'t',kind:'needs_permission',delivery:'accepted',read:false,error:null},agent={generation:'g',turn_id:'t',revision:3,phase:'needs_permission',integration:'connected',inbox:[entry]},live={...record(ids[0]),agent};
 const h=fixture(null,{rpc:name=>name==='get_session'?(++reads>1?wait.promise:Promise.resolve(live)):undefined,appearanceBindings:{captureAttention,isCurrentAttention,attentionOperation:{current:0}}});await h.mount();h.refs.conversationOpenRef.current=true;const opening=h.actual.openReceipt(live,entry,agent);await settle();assert.ok(reads>=3);
 const search={tagName:'INPUT',isConnected:true};if(transition==='newer input focus')h.document.activeElement=search;else{const view=h.refs.terminalViews.current.get(ids[0]);view.live=false;view.status='stopped';view.record.status='stopped';}
 wait.resolve(transition==='process exit'?{...live,status:'stopped'}:live);await opening;await h.flush();assert.equal(h.refs.conversationOpenRef.current,false);if(transition==='newer input focus')assert.equal(h.document.activeElement,search);assert.equal(h.calls.filter(c=>c.name==='read_agent_receipt').length,transition==='process exit'?0:1);noTaskMutation(h);h.cleanup();
});

test('new-session modal closes after view selection without waiting for the first frame',async()=>{
 const wait=deferred(),h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name,args)=>name==='create_session'?{...record(ids[1]).summary,status:'running'}:name==='read_terminal_frame'&&args.sessionId===ids[1]?wait.promise:undefined});
 await h.mount();await h.flush();
 const origin={tagName:'BUTTON'},dialog=h.refs.launchDialog.current;h.document.activeElement=origin;dialog.open=true;dialog.contains=element=>element===origin;let closed=0;
 dialog.close=()=>{if(dialog.open){closed++;dialog.open=false;}};
 const pending=h.actual.startSession({cwd:'/fixture',command:'',launch:null});await settle();
 assert.equal(dialog.open,false,'created session must reveal its terminal while the first frame is pending');
 assert.equal(closed,1);assert.equal(h.refs.sessionId.current,ids[1]);assert.equal(h.refs.terminalViews.current.get(ids[1]).ready,false);
 await h.actual.startSession({cwd:'/fixture',command:'',launch:null});assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);
 const search={tagName:'INPUT'};h.document.activeElement=search;dialog.open=true;dialog.contains=()=>true;wait.resolve(frame(ids[1]));await pending;
 assert.equal(h.document.activeElement,search,'late frame must not steal newer focus');
 origin.closest=()=>dialog;h.document.activeElement=origin;await h.flush();
 assert.equal(h.document.activeElement,origin,'queued fit must not focus a terminal behind a reopened modal');assert.equal(h.refs.terminalViews.current.get(ids[1]).ready,true);assert.equal(closed,1);assert.equal(dialog.open,true,'late frame must not close a newly opened modal');assert.deepEqual(h.errors,[]);h.cleanup();
});

test('new-session creation failure retains its modal and does not create a terminal view',async()=>{
 const h=fixture(null,{rpc:name=>name==='create_session'?Promise.reject(Error('controlled create failure')):undefined});await h.mount();
 const dialog=h.refs.launchDialog.current;dialog.open=true;dialog.close=()=>{dialog.open=false;};
 await h.actual.startSession({cwd:'/fixture',command:'',launch:null});await h.flush();
 assert.equal(dialog.open,true);assert.equal(h.refs.terminalViews.current.size,0);assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);assert.ok(h.errors.length);h.cleanup();
});


test('window wake repaints a retained terminal at unchanged dimensions without resetting its buffer',async()=>{
 const h=fixture(snapshot('single',[ids[0]],ids[0]));await h.mount();await h.flush();
 const view=h.refs.terminalViews.current.get(ids[0]),original=view.instance;
 original.rows=40;original.refreshes=[];let resets=0,writes=0;original.reset=()=>resets++;original.write=()=>writes++;
 const calls=h.calls.length;h.actual.restoreTerminalSurface();await h.flush();
 assert.deepEqual(original.refreshes,[[0,39]],'same-size fit must still repaint the retained xterm renderer');
 assert.equal(view.instance,original);assert.equal(resets,0);assert.equal(writes,0);
 assert.deepEqual(h.calls.slice(calls).filter(call=>forbidden.includes(call.name)),[]);h.cleanup();
});

test('window wake does not repaint a zero-size or hidden terminal and preserves a newer input focus',async()=>{
 const h=fixture(snapshot('single',[ids[0]],ids[0]));await h.mount();await h.flush();
 const view=h.refs.terminalViews.current.get(ids[0]),search={tagName:'INPUT'},rect=view.element.getBoundingClientRect;
 h.document.hasFocus=()=>true;h.document.activeElement=search;view.instance.refreshes=[];
 view.element.getBoundingClientRect=()=>({width:0,height:0});h.actual.restoreTerminalSurface();await h.flush();
 assert.deepEqual(view.instance.refreshes,[]);assert.equal(h.document.activeElement,search);
 view.element.getBoundingClientRect=rect;h.document.hidden=true;h.actual.restoreTerminalSurface();await h.flush();
 assert.deepEqual(view.instance.refreshes,[]);h.document.hidden=false;h.actual.restoreTerminalSurface();await h.flush();
 assert.deepEqual(view.instance.refreshes,[[0,39]]);assert.equal(h.document.activeElement,search);h.cleanup();
});


test('pending creation immediately reports progress and repeated clicks never launch another CLI',async()=>{
 const pending=deferred(),h=fixture(null,{rpc:name=>name==='create_session'?pending.promise:undefined});await h.mount();
 const first=h.actual.startSession({cwd:'/fixture',command:'',launch:null});await settle();
 assert.equal(h.state.starting,true);assert.equal(h.refs.creatingSession.current,true);
 await h.actual.startSession({cwd:'/fixture',command:'',launch:null});
 assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);
 pending.resolve({...record(ids[0]).summary,status:'running'});await first;await h.flush();
 assert.equal(h.state.starting,false);assert.equal(h.refs.creatingSession.current,false);h.cleanup();
});

test('unknown creation outcome is not retried automatically and progress is released',async()=>{
 const h=fixture(null,{rpc:name=>name==='create_session'?Promise.reject(Error('terminal_start_outcome_unknown')):undefined});await h.mount();
 await h.actual.startSession({cwd:'/fixture',command:'',launch:null});await h.flush();
 assert.equal(h.calls.filter(c=>c.name==='create_session').length,1);assert.equal(h.state.starting,false);
 assert.ok(h.errors.some(message=>message.includes('outcome unknown')));assert.equal(h.refs.terminalViews.current.size,0);h.cleanup();
});


for(const adapter of ['shell','codex','claude','gemini','command'])test('passive restore and history selection never starts an ended '+adapter+' process',async()=>{
 const ended=id=>({...record(id),summary:{...record(id).summary,command:adapter==='command'?'echo once':null,launch:adapter==='command'||adapter==='shell'?null:{adapter,mode:'interactive',extra_args:''}},status:'stopped'});
 const h=fixture(snapshot('single',[ids[0]],ids[0]),{rpc:(name,args)=>name==='get_session'?Promise.resolve(ended(args.sessionId)):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();await h.flush();noTaskMutation(h);assert.equal(h.refs.sessionId.current,ids[0]);assert.equal(h.refs.terminalViews.current.get(ids[0]).recordedOnly,true);
 await h.actual.openSession(ids[1]);await h.flush();noTaskMutation(h);assert.equal(h.refs.sessionId.current,ids[1]);assert.equal(h.refs.terminalViews.current.get(ids[1]).live,false);h.cleanup();
});

test('main history refresh repairs metadata after a missed secondary-window recovery event',async()=>{
 const old=ids[0],next=ids[1],h=fixture(null);await h.mount();
 h.refs.titlesRef.current={[old]:'Keep this name'};h.refs.pinnedSessionsRef.current=[old];
 await actualRefresh(h,[],[{...record(next),previous_runs:[old]}]);
 assert.equal(JSON.parse(h.storage.get('yam.sessionTitles'))[next],'Keep this name');assert.deepEqual(JSON.parse(h.storage.get('yam.pinnedSessions')),[next]);h.cleanup();
});


test('explicit previous-run inspection keeps ended output read-only without a recovery request',async()=>{
 const h=fixture(null,{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:'stopped'}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();assert.equal(await h.actual.openSession(ids[0],undefined,undefined,true),true);await h.flush();
 assert.equal(h.refs.terminalViews.current.get(ids[0]).live,false);assert.equal(h.calls.some(c=>c.name==='create_session'),false);
 await h.actual.openSession(ids[1],undefined,undefined,true);h.actual.selectTerminalTab(0,ids[0]);await h.flush();assert.equal(h.calls.some(c=>c.name==='create_session'),false,'selecting a previous-run log remains read-only');h.cleanup();
});


test('I1 selecting ended history while reading Conversation never resumes its process',async()=>{
 const h=fixture(null,{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),status:'stopped'}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();h.refs.conversationOpenRef.current=true;assert.equal(await h.actual.openSession(ids[0]),true);await h.flush();noTaskMutation(h);assert.equal(h.refs.terminalViews.current.get(ids[0]).recordedOnly,true);h.cleanup();
});


test('I1 startup keeps ended Codex panes, native identities and recorded-only history without resume',async()=>{
 const launch={adapter:'codex',mode:'interactive'},h=fixture(snapshot('horizontal',ids.slice(0,2),ids[1]),{rpc:(name,args)=>name==='get_session'?Promise.resolve({...record(args.sessionId),summary:{...record(args.sessionId).summary,launch},status:'stopped',agent:{generation:'g',agent_session_id:'native'}}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();await h.flush();noTaskMutation(h);assert.deepEqual(h.layout().panes,ids.slice(0,2));for(const id of ids.slice(0,2)){const view=h.refs.terminalViews.current.get(id);assert.equal(view.live,false);assert.equal(view.recordedOnly,true);assert.equal(view.record.agent.agent_session_id,'native');}h.cleanup();
});


test('I1 reader intent stays read-only when Terminal is selected before the history lookup finishes',async()=>{
 const pending=deferred(),h=fixture(null,{rpc:(name,args)=>name==='get_session'?pending.promise:name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});await h.mount();h.refs.conversationOpenRef.current=true;const opening=h.actual.openSession(ids[0]);h.refs.conversationOpenRef.current=false;pending.resolve({...record(ids[0]),status:'stopped'});assert.equal(await opening,true);await h.flush();noTaskMutation(h);h.cleanup();
});


test('readonly historical intent survives reclaiming a cached view with a new native generation',async()=>{
 const old=ids[0];let generation=1;
 const h=fixture(null,{appearanceBindings:{terminalWindowClaim:()=>generation},rpc:(name,args)=>name==='claim_terminal_view'?Promise.resolve(generation):name==='get_session'?Promise.resolve({...record(args.sessionId),status:'stopped'}):name==='read_terminal_frame'?Promise.resolve({...frame(args.sessionId),status:'stopped',persisted:true}):undefined});
 await h.mount();await h.actual.openSession(old,undefined,undefined,true);await h.flush();generation=2;
 h.actual.selectTerminalTab(0,old);await h.flush();assert.equal(h.refs.terminalViews.current.get(old)?.desktopGeneration,2);
 assert.equal(h.refs.terminalViews.current.get(old)?.recordedOnly,true);assert.equal(h.calls.some(c=>c.name==='create_session'),false);h.cleanup();
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
