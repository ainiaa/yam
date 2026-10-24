import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import * as windowContext from '../src/window-context.ts';
import {terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,TERMINAL_SCROLLBACK_LINES} from '../src/terminal-frame.ts';
// Author: Jeff.Liu. Actual App callbacks with deterministic terminal/IPC fixtures; not native GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {TerminalViews} from '../src/terminal-views.ts';
import {createTerminalScroll,updateTerminalScroll} from '../src/terminal-scroll.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {queueTerminalResize} from '../src/terminal-settings.ts';
import {assignTerminalPane,removeTerminalPane,changeTerminalLayout,isTerminalProtocolResponse} from '../src/terminal-layout.ts';
import * as layoutOperations from '../src/terminal-layout.ts';

const source=ts.createSourceFile('App.tsx',readFileSync(process.env.YAM_B02A_APP_SOURCE??new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const layoutCss=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
const functions=new Map();let input,timer,notificationEffect;
function visit(node){
 if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(source));
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='bindData')input='(()=>{const instance={onData:handler=>handler};return ('+node.initializer.getText(source)+')();})()';
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='frameTimer')timer=node.initializer.arguments[0].getText(source);
 if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&(node.arguments[0]?.getText(source).includes('set_agent_notification_context')||(node.arguments[0]?.getText(source).includes('syncNotificationContext()')&&node.arguments[1]?.getText(source).includes('notificationsPaused'))))notificationEffect=node.arguments[0].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);
const transpile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function actual(name,args){args={sessionCopyIntent:{current:0},setSessionCopy(){},setCopyName(){},ordinaryLaunchSnapshot:{current:undefined},...args};args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),...args};
 assert.ok(functions.has(name),`Actual App ${name} callback is required`);
 const dependencies=['terminalReopenCurrent','rememberHiddenTerminal','recoverRevealedTerminals','claimWindowView','reconcileTerminalLayoutSelection','refreshTerminalScroll','cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','setTerminalPaneZoom','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes','applyTerminalTabMove','requestTerminalTabFocus'];
 const text=[...new Set(dependencies.filter(n=>functions.has(n)).concat(['moveTerminalSession','selectTerminalTab','commitTerminalTabDrag'].includes(name)?['claimWindowView','openHistory','openTerminal']:[],name))].map(n=>functions.get(n)).join('\n');
 return new Function(...Object.keys(args),transpile(text)+`;return ${name}`)(...Object.values(args));
}
function callback(text,args){args={sessionCopyIntent:{current:0},setSessionCopy(){},setCopyName(){},ordinaryLaunchSnapshot:{current:undefined},...args};args={validatePendingTerminalPaste(){},...args};assert.ok(text,'Actual App callback is required');const deps=['terminalReopenCurrent','rememberHiddenTerminal','recoverRevealedTerminals','claimWindowView','reconcileTerminalLayoutSelection','refreshTerminalScroll','cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','setTerminalPaneZoom','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes','applyTerminalTabMove','requestTerminalTabFocus'].filter(n=>functions.has(n)).map(n=>functions.get(n)).join('\n');return new Function(...Object.keys(args),transpile(deps+`\nconst callback=${text}`)+';return callback')(...Object.values(args));}
function actualWithLegacy(name,args,legacy){
 const dependencies=['terminalReopenCurrent','rememberHiddenTerminal','recoverRevealedTerminals','claimWindowView','reconcileTerminalLayoutSelection','refreshTerminalScroll','cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','setTerminalPaneZoom','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes','applyTerminalTabMove','requestTerminalTabFocus'].filter(n=>functions.has(n)).map(n=>functions.get(n)).join('\n');
 const body=functions.get(name)??legacy;return new Function(...Object.keys(args),transpile(dependencies+`\n${body};return ${name}`))(...Object.values(args));
}
const turn=()=>new Promise(setImmediate);
const record=id=>({summary:{session_id:id,cwd:'/fixture',command:'fixture'},status:'running'});
function frame(id,revision=1,status='running',instance='a'.repeat(64)){
 return {projection:{version:1,session:id,instance,terminal_version:'6.0.0',serialize_version:'0.14.0',revision,data:`${id}:中文:${revision}`,cols:100,rows:40,cursorX:1,viewport:0,buffer:'normal'},end_offset:revision*10,status,persisted:status!=='running'};
}
function harness(ids=['a','b'],invoke=async(name,args)=>name==='read_terminal_frame'?frame(args.sessionId):null){
 const calls=[],errors=[],writes=[],raf=[];
 const layout={mode:ids.length===4?'grid':'horizontal',panes:[...ids],focused:0,revision:0};
 const refs={conversationOpenRef:{current:false},terminalReopen:{current:null},terminalReopenFlight:{current:null},terminalMoveTaskRef:{current:null},terminalMoveIncomingRef:{current:null},terminalMoveOperationRef:{current:false},layoutRestoreRetry:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},ownerConnectionAvailable:{current:{available:true,version:0}},terminalLayoutRef:{current:layout},terminalLayoutFitFrame:{current:null},terminalLayoutFitIntent:{current:0},layoutRestore:{current:{version:0,pending:false,adoptable:false,queued:false}},layoutVersion:{current:0},viewClaimSelection:{current:0},pendingViewClaims:{current:new Map()},paneClaimSelection:{current:new Map()},detailVersion:{current:0},selectionVersion:{current:0},creatingSession:{current:false},previousSession:{current:null},sessionId:{current:ids[0]},selectedRecord:{current:record(ids[0])},terminalViews:{current:new TerminalViews(16)},terminal:{current:null},fitAddon:{current:null},outputCursor:{current:null},agentOutputWindow:{current:''},pendingState:{current:new Map()},pendingOutput:{current:{drain:()=>[],delete(){},clear(){}}}};
 const document={hidden:false,activeElement:{name:'form'},body:{},hasFocus:()=>true};
 const make=id=>{
  const textarea={id},element={dataset:{sessionId:id},style:{},inert:false,contains:node=>node===textarea,getBoundingClientRect:()=>({width:600,height:400})};
  const instance={options:{scrollback:TERMINAL_SCROLLBACK_LINES},_core:{_inputHandler:{_activeBuffer:{x:0}}},cols:100,rows:40,textarea,hasSelection:()=>false,reset(){},refresh(){},resize(cols,rows){this.cols=cols;this.rows=rows;},scrollToLine(){},write(data,done){writes.push({id,data});done?.()},focus(){document.activeElement=textarea;}};
  return {desktopGeneration:1,record:record(id),element,instance,fit:{fit(){}},cursor:null,ready:false,writable:false,firstAttachment:false,replayVersion:0,parsing:null,finishReplay:null,live:true,status:'running',projection:false,frameInstance:null,frameRevision:-1,lifecycleRevision:0,viewportRevision:0,dirty:true,updating:false,selecting:false,projecting:false,persisted:false,disposed:false,resizing:false,resizePending:null,dispose(){this.disposed=true;}};
 };
 const args={refreshSelectedAgent(){},isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false,adoptable:false,queued:false}},setLayoutRestoreReady(){},layoutPreferenceLoad:{present:false,splitPercent:50,layout:{mode:"single",panes:[null],focused:0,revision:0},warning:null},splitPercent:50,splitPercentRef:{current:50},setSplitPercent(){},...refs,document,window:{},active:true,paneHosts:{current:new Map()},terminalHost:{current:null},pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},terminalWindowClaim:()=>1,assignTerminalPane,removeTerminalPane,changeTerminalLayout,swapTerminalPanes:layoutOperations.swapTerminalPanes,isTerminalProtocolResponse,queueTerminalResize,applyTerminalFrame,terminalReportedCwd,terminalReportedCommand,terminalClearDisplayVersion,terminalReportedPromptNavigation,validateTerminalFrame,invoke:async(name,args)=>{calls.push({name,...args});return name==='claim_terminal_view'?1:name==='terminal_input_focused'?false:invoke(name,args);},createTerminalView:make,setTerminalLayout(next){refs.terminalLayoutRef.current=typeof next==='function'?next(refs.terminalLayoutRef.current):next;},setSession(){},setActiveProject(){},setSessionStatus(){},setSelectedAgent(){},setTerminalNotice(){},setAgentPhase(){},updateAgentPhase(){},setError:reason=>errors.push(reason),terminalStatuses:new Set(['succeeded','failed','stopped','needs_attention']),replayOutput:s=>({data:s.data??'',nextOffset:s.end_offset??0}),requestAnimationFrame:fn=>raf.push(fn),cancelAnimationFrame(){},applyStateEvent(){}};
 return {refs,args,document,calls,errors,writes,raf,make,open:actual('openHistory',args),add(id){return refs.terminalViews.current.open(id,true,()=>make(id));}};
}

test('T14 actual App independently loads two visible panes without hiding or cancelling the first',async()=>{
 const pending=new Map();const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>pending.set(args.sessionId,resolve)):null);
 const a=h.open(record('a'),false,0),b=h.open(record('b'),false,1);await turn();assert.ok(pending.has('a'),'concurrent native claims must retain both independent panes');
 pending.get('b')(frame('b'));await b;pending.get('a')(frame('a'));await a;
 const av=h.refs.terminalViews.current.get('a'),bv=h.refs.terminalViews.current.get('b');
 assert.equal(av.ready,true);assert.equal(bv.ready,true);assert.equal(av.element.style.visibility,'visible');assert.equal(bv.element.style.visibility,'visible');
 assert.deepEqual(h.writes.map(v=>v.id).sort(),['a','b']);
});
test('T14 actual App a nonfocused visible projection remains clickable',async()=>{
 const h=harness();const view=h.add('b');await actual('renderFrame',h.args)(view,'b',frame('b'),0);
 assert.equal(view.element.inert,false);
});
test('T14 actual App all four visible frames poll independently and singleflight',async()=>{
 const pending=new Map();const h=harness(['a','b','c','d'],(name,args)=>new Promise(resolve=>pending.set(args.sessionId,resolve)));
 for(const id of ['a','b','c','d']){const view=h.add(id);Object.assign(view,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});}
 const poll=callback(timer,h.args);poll();poll();
 assert.deepEqual(h.calls.map(v=>v.sessionId).sort(),['a','b','c','d']);
 for(const [id,resolve]of pending)resolve(frame(id,2));await turn();await turn();
 for(const id of ['a','b','c','d'])assert.equal(h.refs.terminalViews.current.get(id).frameRevision,2);
});
test('T14 actual App typing is blocked in an unfocused pane and while a form owns focus',async()=>{
 const h=harness();const view=h.add('a');Object.assign(view,{ready:true,cursor:10,projection:true});
 const handler=callback(input,{...h.args,view,id:'a'});
 handler('private input');await turn();assert.deepEqual(h.calls,[]);
 h.document.activeElement=view.instance.textarea;handler('focused input');await turn();
 assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>[v.sessionId,v.data]),[['a','focused input']]);
 h.refs.sessionId.current='b';handler('wrong pane');await turn();assert.equal(h.calls.filter(v=>v.name==='write_session').length,1);
});
test('T14 actual App projection parsing cannot answer old terminal queries',async()=>{
 const h=harness();const view=h.add('a');Object.assign(view,{ready:true,cursor:10,projection:true,projecting:true});h.document.activeElement=view.instance.textarea;
 callback(input,{...h.args,view,id:'a'})('\x1b[1;1R');await turn();assert.deepEqual(h.calls,[]);
});
test('T14 actual App fit ignores hidden and zero-sized panes and preserves independent revisions',async()=>{
 const h=harness();const a=h.add('a'),b=h.add('b'),hidden=h.add('hidden');const fits=[];
 for(const [id,view]of [['a',a],['b',b],['hidden',hidden]]){view.fit.fit=()=>fits.push(id);Object.assign(view,{live:true,ready:true,writable:true,cursor:10});}
 b.element.getBoundingClientRect=()=>({width:0,height:0});
 actual('fitTerminalViews',h.args)();await turn();
 assert.deepEqual(fits,['a']);assert.equal(a.viewportRevision,1);assert.equal(b.viewportRevision,0);assert.equal(hidden.viewportRevision,0);assert.deepEqual(h.calls.map(v=>v.sessionId),['a']);
});
for(const transition of ['unchanged','revision','mode','cancel','unmount'])test('layout fit coalescing preserves latest activation: '+transition,()=>{
 const h=harness(['a']),fits=[];
 for(const id of ['a','b'])h.add(id).fit.fit=()=>fits.push(id);
 let next=0;h.args.requestAnimationFrame=fn=>{h.raf.push(fn);return ++next;};
 const request=actual('requestTerminalLayoutFit',h.args);
 request();
 if(transition==='revision'||transition==='mode')h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,panes:['b'],revision:1,...(transition==='mode'?{mode:'vertical'}:{})};
 request();request();assert.equal(h.raf.length,1,'one fit per animation frame');
 if(transition==='cancel')actual('cancelTerminalLayoutFit',h.args)();
 if(transition==='unmount')h.args.terminalMounted.current=false;
 h.raf.shift()();
 assert.deepEqual(fits,transition==='cancel'||transition==='unmount'?[]:transition==='unchanged'?['a']:['b'],'the latest visible scene must fit without another tab switch');
 assert.equal(h.refs.terminalLayoutFitFrame.current,null);
 assert.deepEqual(h.calls,[],'layout fitting must not create, stop, write or take over a task');
});
test('T14 actual App close pane only hides membership; no stop, disposal or input takeover',()=>{
 const h=harness();const a=h.add('a'),b=h.add('b');actual('closeTerminalPane',h.args)(0);
 assert.equal(h.refs.terminalLayoutRef.current.panes[0],null);assert.equal(a.disposed,false);assert.equal(b.disposed,false);assert.deepEqual(h.calls.filter(v=>['stop_session','write_session','take_terminal_control','create_session'].includes(v.name)),[]);
});
test('T14 actual App visible ended scenes survive projection retain',async()=>{
 const h=harness();const a=h.add('a');Object.assign(a,{live:false,status:'succeeded',persisted:true,projection:true,ready:true,cursor:10});
 await h.open(record('b'),false,1);assert.equal(h.refs.terminalViews.current.get('a'),a);assert.equal(a.disposed,false);
});
test('T14 actual App form focus does not suppress a visible session notification',async()=>{
 const h=harness();const suppressed=[],delivered=[];
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.args,pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},retryNotifications:{current:new Map()},notifications:{current:{canRetry:()=>true,suppress:k=>suppressed.push(k),clearFailure(){},deliver:async(k,send)=>{delivered.push(k);await send();return true},recordFailure:()=>''}},titlesRef:{current:{}},discardAttentionRetries:()=>[],setNotificationError(){},projectName:()=> 'Fixture',statusLabels:{succeeded:'Done'}};
 await actual('notifySession',args)({session_id:'a',status:'succeeded'});
 assert.deepEqual(suppressed,[]);assert.deepEqual(delivered,['a:succeeded']);
});
test('T14 actual App notification context sends null when terminal does not own DOM focus',async()=>{
 const h=harness();const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.args,session:{session_id:'a'},notificationsPaused:false,localStorage:{setItem(){}}};
 callback(notificationEffect,args)();await turn();
 assert.deepEqual(h.calls.filter(v=>v.name==='set_agent_notification_context').map(v=>v.selected),[null]);
});

test('T14 visible ended pane is protected from cache victim selection',()=>{
 const pool=new TerminalViews(2),disposed=[];const make=id=>({dispose(){disposed.push(id)}});
 pool.open('a',false,()=>make('a'));pool.open('b',false,()=>make('b'));
 assert.equal(typeof pool.setProtected,'function','visible cache protection is required');
 pool.setProtected(['a']);pool.open('c',true,()=>make('c'));
 assert.ok(pool.get('a'));assert.deepEqual(disposed,['b']);
 pool.setProtected(['a','c']);assert.throws(()=>pool.open('d',true,()=>make('d')),/limit/i);
});
test('T14 actual App a closed slot rejects late success and does not render a replacement owner',async()=>{
 let release;const h=harness(['a','b'],()=>new Promise(resolve=>release=resolve));
 const old=h.add('a');Object.assign(old,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});
 const poll=callback(timer,h.args);poll();
 h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,panes:[null,'b'],revision:1};
 release(frame('a',2));await turn();await turn();assert.deepEqual(h.writes,[]);assert.equal(old.frameRevision,-1);
});
test('T14 actual App late error/finally from closed pane cannot change current error or replacement busy',async()=>{
 let reject;const h=harness(['a','b'],()=>new Promise((resolve,no)=>reject=no));
 const old=h.add('a');Object.assign(old,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});
 callback(timer,h.args)();
 h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,panes:[null,'b'],revision:1};h.refs.sessionId.current='b';
 const replacement=h.add('b');replacement.updating=true;
 reject(Error('old owner unavailable'));await turn();await turn();
 assert.deepEqual(h.errors,[]);assert.equal(replacement.updating,true);assert.equal(old.updating,false);
});
test('T14 actual App owner/lifecycle change during frame wait never revives stopped status',async()=>{
 let release;const h=harness(['a','b'],()=>new Promise(resolve=>release=resolve));
 const view=h.add('a');Object.assign(view,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});
 callback(timer,h.args)();view.lifecycleRevision++;view.live=false;view.status='stopped';
 release(frame('a',2));await turn();await turn();
 assert.equal(view.live,false);assert.equal(view.status,'stopped');assert.equal(view.updating,false);
});
test('T14 actual App hidden Unicode input is rejected while a live raw terminal protocol response stays routed',async()=>{
 const h=harness();const view=h.add('hidden');Object.assign(view,{ready:true,cursor:10,projection:false});
 const handler=callback(input,{...h.args,view,id:'hidden'});handler('中文😀');await turn();
 assert.deepEqual(h.calls,[]);
 handler('\x1b[1;1R');await turn();assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>[v.sessionId,v.data]),[['hidden','\x1b[1;1R']]);
});
test('T14 actual App lease rejection never broadcasts to another visible pane or invokes takeover',async()=>{
 const h=harness(['a','b'],async()=>{throw Error('input lease conflict')});const view=h.add('a');Object.assign(view,{ready:true,cursor:10,projection:true});h.document.activeElement=view.instance.textarea;
 callback(input,{...h.args,view,id:'a'})('one attempt');await turn();
 assert.equal(view.writable,false);assert.deepEqual(h.calls.map(v=>[v.name,v.sessionId]),[['write_session','a']]);
});

test('T14 bounded layout model supports horizontal vertical grid and unique membership',async()=>{
 const path=new URL('../src/terminal-layout.ts',import.meta.url);assert.ok((await import('node:fs')).existsSync(path),'layout module exists');
 const m=await import(path.href);let layout=m.createTerminalLayout();
 layout=m.changeTerminalLayout(layout,'grid');assert.equal(layout.panes.length,4);
 layout=m.assignTerminalPane(layout,0,'a');layout=m.assignTerminalPane(layout,1,'b');
 layout=m.assignTerminalPane(layout,2,'a');assert.deepEqual(layout.panes,['a','b',null,null]);assert.equal(layout.focused,0);
 layout=m.changeTerminalLayout({...layout,focused:1},'vertical');assert.deepEqual(layout.panes,['a','b']);
 const closed=m.removeTerminalPane(layout,0);assert.deepEqual(closed.panes,[null,'b']);assert.equal(closed.focused,1);
 assert.throws(()=>m.changeTerminalLayout(layout,'recursive'));assert.throws(()=>m.assignTerminalPane(layout,4,'x'));
});
test('F2 split ratio clamps finite values and uses 50 for invalid values',()=>{
 const clamp=layoutOperations.clampSplitPercent??(value=>value);
 assert.equal(clamp(10),20);assert.equal(clamp(20),20);assert.equal(clamp(53.7),54);
 assert.equal(clamp(80),80);assert.equal(clamp(99),80);assert.equal(clamp(Number.NaN),50);
 assert.equal(clamp(Number.POSITIVE_INFINITY),50);assert.equal(clamp('40'),50);
});
test('F2 pane swap moves focus with its identity and leaves unsafe swaps unchanged',()=>{
 const swap=layoutOperations.swapTerminalPanes??(layout=>layout);
 const state={mode:'horizontal',panes:['session-a',null],focused:0,revision:4};
 const swapped=swap(state,0,1);
 assert.deepEqual(swapped,{mode:'horizontal',panes:[null,'session-a'],focused:1,revision:5});
 assert.equal(state.panes[0],'session-a','the original layout stays immutable');
 assert.equal(swap(swapped,1,1),swapped);assert.equal(swap(swapped,-1,0),swapped);
 const nonfocused=swap({...state,focused:1},0,1);
 assert.deepEqual(nonfocused,{mode:'horizontal',panes:[null,'session-a'],focused:0,revision:5});
});
test('F2 four-pane component offers focused swaps with independent node dividers',()=>{
 const targets=[],tree=layoutTree({layout:{mode:'grid',panes:['a','b','c','d'],focused:1,revision:0},labels:['A','B','C','D'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap:target=>targets.push(target),swapDisabled:false,onCancelFit(){}});
 const swaps=nodes(tree,n=>n.type==='button'&&n.props?.['aria-label']?.startsWith('Swap focused pane'));
 assert.deepEqual(swaps.map(button=>button.props['aria-label']),['Swap focused pane with pane 1','Swap focused pane with pane 3','Swap focused pane with pane 4']);
 assert.equal(nodes(tree,n=>n.props?.role==='separator').length,3,'grid split nodes each have independent controls');swaps.forEach(button=>button.props.onClick());assert.deepEqual(targets,[0,2,3]);
});
test('F2 actual App JSX wires the swap guard with disabled polarity for split and grid',()=>{
 const verify=(ids,mode,focused,target,label)=>{
  const h=harness(ids);for(const id of ids){const view=h.add(id);Object.assign(view,{availability:'available',ready:true,attaching:false,parsing:null});}
  h.refs.terminalLayoutRef.current={mode,panes:[...ids],focused,revision:0};
  const canSwapTerminalPanes=actual('canSwapTerminalPanes',h.args);
  const swapDisabled=actualComponentProp('TerminalLayout','swapDisabled',{canSwapTerminalPanes});
  const onSwap=actual('swapTerminalPane',h.args);
  const render=()=>layoutTree({layout:h.refs.terminalLayoutRef.current,labels:ids,splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap,swapDisabled,onCancelFit(){}});
  const findSwap=tree=>nodes(tree,node=>node.type==='button'&&node.props?.['aria-label']===label)[0];
  const readyButton=findSwap(render());assert.equal(readyButton.props.disabled,false,`${mode} is enabled after all visible panes are ready`);
  readyButton.props.onClick();const expected=[...ids];[expected[focused],expected[target]]=[expected[target],expected[focused]];assert.deepEqual(h.refs.terminalLayoutRef.current.panes,expected,'the enabled component callback reaches the actual App swap');
  h.refs.terminalLayoutRef.current={mode,panes:[...ids],focused,revision:0};
  h.args.layoutRestore.current.pending=true;
  const restoreButton=findSwap(render());assert.equal(restoreButton.props.disabled,true,`${mode} is disabled during restore`);
  h.args.layoutRestore.current.pending=false;h.refs.creatingSession.current=true;
  assert.equal(findSwap(render()).props.disabled,true,`${mode} is disabled while creating a session`);
 };
 verify(['a','b'],'horizontal',0,1,'Swap panes');
 verify(['a','b','c','d'],'grid',1,3,'Swap focused pane with pane 4');
});
test('F2 swap callback preserves selected session and uses geometry-only membership change',()=>{
 const h=harness(['a','b']);
 for(const id of ['a','b'])h.add(id);
 for(const id of ['a','b'])Object.assign(h.refs.terminalViews.current.get(id),{availability:'available',ready:true,attaching:false,parsing:null});
 const selected=h.refs.selectedRecord.current,session=h.refs.sessionId.current;
 const swap=actual('swapTerminalPane',{...h.args,swapTerminalPanes:layoutOperations.swapTerminalPanes});
 swap();
 assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['b','a']);assert.equal(h.refs.terminalLayoutRef.current.focused,1);
 assert.equal(h.refs.sessionId.current,session);assert.equal(h.refs.selectedRecord.current,selected);
 assert.equal(h.calls.filter(call=>['create_session','stop_session','write_session','take_terminal_control'].includes(call.name)).length,0);
});
test('F2 four-pane App swaps focused identity with a valid target and preserves session/control state',()=>{
 const h=harness(['a','b','c','d']);for(const id of ['a','b','c','d'])h.add(id);
 for(const id of ['a','b','c','d'])Object.assign(h.refs.terminalViews.current.get(id),{availability:'available',ready:true,attaching:false,parsing:null,writable:true});
 h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,focused:1};h.refs.sessionId.current='b';
 const selected=h.refs.selectedRecord.current,view=h.refs.terminalViews.current.get('b'),canSwap=actual('canSwapTerminalPanes',h.args),swap=actual('swapTerminalPane',h.args);
 assert.equal(canSwap(3),true);assert.equal(canSwap(1),false);assert.equal(canSwap(4),false);
 swap(3);assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['a','d','c','b']);assert.equal(h.refs.terminalLayoutRef.current.focused,3);
 assert.equal(h.refs.sessionId.current,'b');assert.equal(h.refs.selectedRecord.current,selected);assert.equal(h.refs.terminalViews.current.get('b'),view);assert.equal(view.writable,true);
 assert.deepEqual(h.calls.filter(call=>['create_session','stop_session','write_session','take_terminal_control'].includes(call.name)),[]);
});
test('F2 swap guard rejects unsettled visible views but permits a stable in-flight poll',()=>{
 const h=harness(['a','b']);
 for(const id of ['a','b'])h.add(id);
 for(const id of ['a','b'])Object.assign(h.refs.terminalViews.current.get(id),{availability:'available',ready:true,attaching:false,parsing:null});
 const canSwap=actual('canSwapTerminalPanes',h.args);
 assert.equal(canSwap(),true);
 h.refs.terminalViews.current.get('b').updating=true;assert.equal(canSwap(),true,'ordinary poll is not a lasting blocker');
 for(const blocked of ['missing','disposed','not-ready','attaching','parsing','owner-unavailable']){
  const view=h.refs.terminalViews.current.get('b');
  if(blocked==='missing')h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,panes:['a','missing']};
  else if(blocked==='disposed')view.disposed=true;
  else if(blocked==='not-ready')view.ready=false;
  else if(blocked==='attaching')view.attaching=true;
  else if(blocked==='parsing')view.parsing=Promise.resolve();
  else if(blocked==='owner-unavailable')view.availability='owner_unavailable';
  assert.equal(canSwap(),false,blocked);
  h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,panes:['a','b']};Object.assign(view,{disposed:false,ready:true,attaching:false,parsing:null});
 }
 h.args.layoutRestore.current.pending=true;assert.equal(canSwap(),false,'restore pending');h.args.layoutRestore.current.pending=false;
 h.refs.creatingSession.current=true;assert.equal(canSwap(),false,'session creation');
});
test('T14 actual App mounts the controlled fixed layout component with per-pane callbacks',()=>{
 let component;function find(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='TerminalLayout')component=n;ts.forEachChild(n,find)}find(source);
 assert.ok(component,'App renders TerminalLayout');
 const names=component.attributes.properties.map(p=>p.name?.text);
 for(const name of ['layout','onMode','onFocus','onClose','onHost'])assert.ok(names.includes(name),`actual component ${name}`);
});
test('F2 App passes controlled split and guarded swap handlers to the actual component',()=>{
 let component;function find(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='TerminalLayout')component=n;ts.forEachChild(n,find)}find(source);
 assert.ok(component,'App renders TerminalLayout');
 const names=component.attributes.properties.map(p=>p.name?.text);
 for(const name of ['splitPercent','onSplitChange','onSplitPreview','onSwap','swapDisabled','onCancelFit'])assert.ok(names.includes(name),`actual component ${name}`);
});

test('T14 actual App focused Unicode and paste remain input while projection parsing is pending',async()=>{
 const h=harness();const view=h.add('a');Object.assign(view,{ready:true,cursor:10,projection:true,projecting:true});h.document.activeElement=view.instance.textarea;
 callback(input,{...h.args,view,id:'a'})('中文😀 pasted input');await turn();
 assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>v.data),['中文😀 pasted input']);
});

test('T14 actual App pending A B A and close isolate old success error and finally',async()=>{
 const pending=[];const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'?new Promise((resolve,reject)=>pending.push({id:args.sessionId,resolve,reject})):null);
 const first=h.open(record('a'),false,0);await turn();const second=h.open(record('b'),false,0);await turn();const third=h.open(record('a'),false,0);await turn();
 pending[0].resolve(frame('a',1));pending[1].reject(Error('old B'));pending[2].resolve(frame('a',3));await Promise.all([first,second,third]);
 assert.deepEqual(h.writes.map(v=>v.data),['\x1bca:中文:3']);assert.deepEqual(h.errors,[]);assert.equal(h.refs.sessionId.current,'a');
 const beforeReads=pending.length;await h.open(record('a'),false,1);assert.equal(pending.length,beforeReads,'warm duplicate selection reads no frame');
 assert.equal(h.refs.terminalLayoutRef.current.panes.filter(id=>id==='a').length,1);
 const loading=h.open(record('b'),false,1);await turn();actual('closeTerminalPane',h.args)(1);pending[3].resolve(frame('b',4));await loading;
 assert.equal(h.refs.terminalLayoutRef.current.panes[1],null);assert.equal(h.refs.terminalViews.current.get('b').ready,false);assert.deepEqual(h.errors,[]);
});
test('F2 actual App keeps swap busy through attachment and clears the current attachment',async()=>{
 let release;const h=harness(['a','b'],name=>name==='read_terminal_frame'?new Promise(resolve=>release=resolve):null);
 const attaching=h.open(record('a'),false,0);await turn();const view=h.refs.terminalViews.current.get('a');
 assert.equal(view.attaching,true,'openHistory publishes attachment readiness before its owner read');
 release(frame('a'));await attaching;assert.equal(view.attaching,false);
});
test('F2 an old attachment finally cannot clear a newer attachment busy state',async()=>{
 const pending=[];const h=harness(['a','b'],name=>name==='read_terminal_frame'?new Promise(resolve=>pending.push(resolve)):null);
 const old=h.open(record('a'),false,0);await turn();const view=h.refs.terminalViews.current.get('a');
 const current=h.open(record('a'),false,0);await turn();assert.equal(pending.length,2);
 pending[0](frame('a',1));await old;assert.equal(view.attaching,true,'old attachVersion must not clear the replacement');
 pending[1](frame('a',2));await current;assert.equal(view.attaching,false);
});
test('T14 actual App changed owner while polling drops its old instance response',async()=>{
 let release;const h=harness(['a','b'],()=>new Promise(resolve=>release=resolve));const view=h.add('a');Object.assign(view,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});
 callback(timer,h.args)();view.frameInstance='b'.repeat(64);view.lifecycleRevision++;view.status='stopped';view.live=false;
 release(frame('a',4));await turn();await turn();assert.equal(view.frameInstance,'b'.repeat(64));assert.equal(view.frameRevision,-1);assert.equal(view.status,'stopped');assert.deepEqual(h.writes,[]);
});
function layoutTree(props,hookState={states:[],refs:[]}){
 const file=ts.createSourceFile('TerminalLayout.tsx',readFileSync(process.env.YAM_B03A_LAYOUT_SOURCE??new URL('../src/TerminalLayout.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TerminalLayout');assert.ok(declaration);
 const js='const Select="select";'+ts.transpileModule(declaration.getText(file).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 let stateIndex=0,refIndex=0;const cleanups=[];
 const useState=value=>{const index=stateIndex++;if(!(index in hookState.states))hookState.states[index]=typeof value==='function'?value():value;return [hookState.states[index],next=>{hookState.states[index]=typeof next==='function'?next(hookState.states[index]):next;}];};
 const useRef=current=>{const index=refIndex++;if(!(index in hookState.refs))hookState.refs[index]={current};return hookState.refs[index];};
 const useEffect=effect=>{const cleanup=effect();if(typeof cleanup==='function')cleanups.push(cleanup);};
 const tree=new Function('React','useState','useRef','useEffect','document',...Object.keys(layoutOperations),js+';return TerminalLayout')(React,useState,useRef,useEffect,hookState.document,...Object.values(layoutOperations))(props);
 tree.cleanups=cleanups;tree.rerender=nextProps=>layoutTree(nextProps,hookState);return tree;
}
function actualComponentProp(componentName,propName,args){
 let expression;
 function find(node){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)===componentName){
   const attribute=node.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.getText(source)===propName);
   if(attribute?.initializer&&ts.isJsxExpression(attribute.initializer)&&attribute.initializer.expression)expression=attribute.initializer.expression.getText(source);
  }
  ts.forEachChild(node,find);
 }
 find(source);assert.ok(expression,`Actual ${componentName}.${propName} JSX prop is required`);
 return new Function(...Object.keys(args),transpile(`return (${expression});`))(...Object.values(args));
}
function nodes(tree,predicate){return [tree,...(tree?.props?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child,predicate):[])].filter(predicate);}
function startPointerThenDiscreteIntent(kind){
 let controlled=50;const commits=[];
 const props=()=>({layout:{mode:'horizontal',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:controlled,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange:value=>{controlled=value;commits.push(value);},onSplitPreview(){},onSwap(){},swapDisabled:false,onCancelFit(){}});
 let tree=layoutTree(props()),separator=nodes(tree,n=>n.props?.role==='separator')[0];
 const currentTarget={setPointerCapture(){},releasePointerCapture(){},getBoundingClientRect:()=>({left:10,top:20,width:600,height:400})};
 separator.props.onPointerDown({pointerId:22,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:22,clientX:430,clientY:20,currentTarget});
 separator.props.onPointerUp({pointerId:99,clientX:430,clientY:20,currentTarget});
 if(kind==='Home')separator.props.onKeyDown({key:'Home',preventDefault(){}});
 else if(kind==='End')separator.props.onKeyDown({key:'End',preventDefault(){}});
 else nodes(tree,n=>n.type==='button'&&n.props?.['aria-label']==='Reset split to 50 percent')[0].props.onClick();
 tree=tree.rerender(props());separator=nodes(tree,n=>n.props?.role==='separator')[0];
 return {commits,tree,separator,currentTarget,controlled};
}
for(const [intent,expected] of [['Home',20],['End',80],['reset',50]]){
 test(`F2 ${intent} during drag clears the old preview ARIA value`,()=>{
  const state=startPointerThenDiscreteIntent(intent);assert.equal(state.separator.props['aria-valuenow'],expected);
 });
 test(`F2 ${intent} during drag prevents its stale pointerup from committing`,()=>{
  const state=startPointerThenDiscreteIntent(intent);state.separator.props.onPointerUp({pointerId:22,clientX:430,clientY:20,currentTarget:state.currentTarget});assert.deepEqual(state.commits,[expected]);
 });
}
test('F2 actual component exposes a separator for a split and none for a single pane',()=>{
 const tree=layoutTree({layout:{mode:'horizontal',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onFit(){}});
 const separator=nodes(tree,n=>n.props?.role==='separator')[0];
 assert.ok(separator,'two-pane mode has a separator control');
 assert.equal(separator.props.tabIndex,0);assert.equal(separator.props['aria-valuemin'],20);assert.equal(separator.props['aria-valuemax'],80);assert.equal(separator.props['aria-valuenow'],50);
 const single=layoutTree({layout:{mode:'single',panes:['a'],focused:0,revision:0},labels:['A'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onFit(){}});
 assert.equal(nodes(single,n=>n.props?.role==='separator').length,0);
 assert.equal(nodes(single,n=>n.type==='button'&&n.props?.['aria-label']?.startsWith('Swap')).length,0,'single mode offers no pane swap');
});
test('F2 split CSS keeps both pane tracks outside the separator in either orientation',()=>{
 assert.match(layoutCss,/\.layout-horizontal\.split-two \.terminal-pane:nth-child\(1\)\s*\{\s*grid-column:1;\s*grid-row:1;\s*\}/);
 assert.match(layoutCss,/\.layout-horizontal\.split-two \.terminal-pane:nth-child\(2\)\s*\{\s*grid-column:3;\s*grid-row:1;\s*\}/);
 assert.match(layoutCss,/\.terminal-layout-splitter\.splitter-x\s*\{[^}]*grid-column:2;\s*grid-row:1;/);
 assert.match(layoutCss,/\.layout-vertical\.split-two \.terminal-pane:nth-child\(1\)\s*\{\s*grid-column:1;\s*grid-row:1;\s*\}/);
 assert.match(layoutCss,/\.layout-vertical\.split-two \.terminal-pane:nth-child\(2\)\s*\{\s*grid-column:1;\s*grid-row:3;\s*\}/);
 assert.match(layoutCss,/\.terminal-layout-splitter\.splitter-y\s*\{[^}]*grid-column:1;\s*grid-row:2;/);
});
test('F2 actual component clamps pointer drag, cancels to committed geometry and supports keyboard/reset',()=>{
 const preview=[],commits=[],fits=[];const calls=[];
 const tree=layoutTree({layout:{mode:'horizontal',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange:value=>commits.push(value),onSplitPreview:value=>{preview.push(value);fits.push(value);},onSwap(){calls.push('swap');},swapDisabled:false,onCancelFit(){}});
 const separator=nodes(tree,n=>n.props?.role==='separator')[0],reset=nodes(tree,n=>n.type==='button'&&n.props?.['aria-label']==='Reset split to 50 percent')[0];
 const capture=[];const currentTarget={setPointerCapture:id=>capture.push(id),releasePointerCapture:id=>capture.push(-id),getBoundingClientRect:()=>({left:10,top:20,width:600,height:400})};
 separator.props.onPointerDown({pointerId:7,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:7,clientX:610,clientY:20,currentTarget});
 assert.deepEqual(preview,[59]);separator.props.onPointerCancel({pointerId:7,currentTarget});
 assert.deepEqual(commits,[],'cancel never persists a preview');assert.deepEqual(preview,[59,50]);assert.ok(fits.length>=2);assert.deepEqual(capture,[7,-7]);
 separator.props.onPointerDown({pointerId:9,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:9,clientX:220,clientY:20,currentTarget});separator.props.onLostPointerCapture({pointerId:9,currentTarget});
 assert.deepEqual(commits,[],'lost capture also discards an uncommitted preview');assert.equal(preview.at(-1),50);
 separator.props.onPointerDown({pointerId:8,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:8,clientX:190,clientY:20,currentTarget});separator.props.onPointerUp({pointerId:8,clientX:190,clientY:20,currentTarget});
 separator.props.onKeyDown({key:'ArrowRight',preventDefault(){}});separator.props.onKeyDown({key:'Home',preventDefault(){}});separator.props.onKeyDown({key:'End',preventDefault(){}});reset.props.onClick();
 assert.deepEqual(commits,[41,55,20,80,50]);
 const vertical=layoutTree({layout:{mode:'vertical',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onFit(){}});
 assert.equal(nodes(vertical,n=>n.props?.role==='separator')[0].props['aria-orientation'],'horizontal');
 assert.deepEqual(calls,[]);
 let cleanupCount=0;const mounted=layoutTree({layout:{mode:'horizontal',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onCancelFit(){cleanupCount++;}});mounted.cleanups.forEach(cleanup=>cleanup());assert.equal(cleanupCount,1,'unmount cancels a queued geometry fit');
});
test('F2 App fit scheduling coalesces frames and cancels stale mode intents',()=>{
 let next=0,fits=0;const scheduled=new Map(),cancelled=[],layout={mode:'horizontal',panes:['a','b'],focused:0,revision:1};
 const view={instance:{rows:40,refresh(){}},element:{dataset:{sessionId:'a'},getBoundingClientRect:()=>({width:600,height:400})},fit:{fit(){fits++;}},viewportRevision:0,resizePending:null,live:false,ready:false,writable:false,cursor:null,disposed:false};
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalLayoutFitFrame:{current:null},terminalLayoutFitIntent:{current:0},terminalLayoutRef:{current:layout},terminalMounted:{current:true},terminalViews:{current:{all:[view]}},requestAnimationFrame:callback=>{const id=++next;scheduled.set(id,callback);return id;},cancelAnimationFrame:id=>{cancelled.push(id);scheduled.delete(id);}};
 const request=actual('requestTerminalLayoutFit',args),cancel=actual('cancelTerminalLayoutFit',args);
 request();request();assert.equal(scheduled.size,1,'pointer previews share one pending frame');
 const stale=scheduled.get(1);cancel();assert.deepEqual(cancelled,[1]);
 args.terminalLayoutRef.current={...layout,mode:'vertical',revision:2};request();request();assert.equal(scheduled.size,1,'new mode has one fresh fit frame');
 stale();assert.equal(fits,0,'cancelled geometry cannot fit later');scheduled.get(2)();assert.equal(fits,1,'latest geometry fits once');
});
test('T14 actual component pointer and keyboard focus update App selected session and input route',async()=>{
 const h=harness();const a=h.add('a'),b=h.add('b');for(const v of [a,b])Object.assign(v,{ready:true,cursor:10,projection:true});
 const focus=actual('focusTerminalPane',h.args),tree=layoutTree({layout:h.refs.terminalLayoutRef.current,labels:['A','B'],onFocus:focus,onMode(){},onClose(){},onHost(){}});
 const sections=nodes(tree,n=>n.type==='section');sections[1].props.onPointerDown();assert.equal(h.refs.sessionId.current,'b');assert.equal(h.refs.selectedRecord.current.summary.session_id,'b');
 const button=nodes(sections[1],n=>n.type==='button')[0];button.props.onClick();assert.equal(h.document.activeElement,b.instance.textarea);
 const ah=callback(input,{...h.args,view:a,id:'a'}),bh=callback(input,{...h.args,view:b,id:'b'});ah('A must not send');bh('B 中文');await turn();
 assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>[v.sessionId,v.data]),[['b','B 中文']]);
 h.document.activeElement={name:'form'};bh('form owns focus');await turn();assert.equal(h.calls.filter(v=>v.name==='write_session').length,1);
 assert.equal(sections.length,2);assert.equal(sections[1].props['aria-label'],'Terminal pane 2');
});
test('T14 actual App independently sends two sizes with latest reversal and collapse only hides',async()=>{
 let release;const h=harness(['a','b'],(name,args)=>name==='resize_session'&&args.sessionId==='a'&&!release?new Promise(resolve=>release=resolve):null);
 const a=h.add('a'),b=h.add('b');for(const v of [a,b])Object.assign(v,{ready:true,writable:true,cursor:10,projection:true});
 let dimsA=[80,20],dimsB=[40,10];a.fit.fit=()=>a.instance.resize(...dimsA);b.fit.fit=()=>b.instance.resize(...dimsB);
 const fit=actual('fitTerminalViews',h.args);fit();dimsA=[120,40];dimsB=[60,15];fit();release();await turn();await turn();
 assert.deepEqual(h.calls.filter(v=>v.name==='resize_session'&&v.sessionId==='a').map(v=>[v.cols,v.rows]),[[80,20],[120,40]]);
 assert.deepEqual(h.calls.filter(v=>v.name==='resize_session'&&v.sessionId==='b').map(v=>[v.cols,v.rows]),[[40,10],[60,15]]);
 const grid={mode:'grid',panes:['a','b','c','d'],focused:0,revision:1};h.refs.terminalLayoutRef.current=grid;const c=h.add('c'),d=h.add('d');
 actual('changeLayoutMode',h.args)('single');assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['a']);for(const v of [a,b,c,d])assert.equal(v.disposed,false);
 assert.equal(b.element.style.visibility,'hidden');assert.equal(c.element.style.visibility,'hidden');assert.equal(d.element.style.visibility,'hidden');
 actual('changeLayoutMode',h.args)('grid');await h.open(record('b'),false,1);assert.equal(h.refs.terminalViews.current.get('b'),b);
 assert.equal(h.calls.filter(v=>['stop_session','create_session','take_terminal_control'].includes(v.name)).length,0);
});
test('T14 actual App notification suppression requires focus A; visible B and blurred window still notify',async()=>{
 const h=harness();const a=h.add('a');Object.assign(a,{ready:true,cursor:10});h.document.activeElement=a.instance.textarea;const suppressed=[],delivered=[];
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.args,pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},retryNotifications:{current:new Map()},notifications:{current:{canRetry:()=>true,suppress:k=>suppressed.push(k),clearFailure(){},deliver:async(k,send)=>{delivered.push(k);await send();return true},recordFailure:()=>''}},titlesRef:{current:{}},discardAttentionRetries:()=>[],setNotificationError(){},projectName:()=> 'Fixture',statusLabels:{succeeded:'Done'}};
 const notify=actual('notifySession',args);await notify({session_id:'a',status:'succeeded'});await notify({session_id:'b',status:'succeeded'});
 h.document.hasFocus=()=>false;await notify({session_id:'a',status:'stopped'});
 assert.deepEqual(suppressed,['a:succeeded']);assert.deepEqual(delivered,['b:succeeded','a:stopped']);
});
for(const count of [2,4])test(`T14 ${count}-pane continuous output simulated fixture`,async t=>{
 const ids=['a','b','c','d'].slice(0,count),revision=new Map(ids.map(id=>[id,0]));
 const h=harness(ids,async(name,args)=>name==='read_terminal_frame'?frame(args.sessionId,revision.get(args.sessionId)):null);
 for(let i=0;i<count;i++)await h.open(record(ids[i]),false,i);
 let output;function find(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='listen'&&n.arguments[0]?.text==='session-output')output=n.arguments[1].getText(source);ts.forEachChild(n,find)}find(source);
 const onOutput=callback(output,h.args),poll=callback(timer,h.args);
 for(let tick=1;tick<=120;tick++){
  for(const id of ids){revision.set(id,tick);onOutput({payload:{session_id:id,data:`${id}:中文😀:${tick}`,offset:(tick-1)*10,end_offset:tick*10}});}
  poll();poll();await turn();await turn();
  for(const id of ids){const view=h.refs.terminalViews.current.get(id);assert.equal(view.frameRevision,tick);assert.equal(view.cursor,tick*10);assert.equal(view.updating,false);}
 }
 assert.equal(h.calls.filter(v=>v.name==='read_terminal_frame').length,count*121);
 const a=h.refs.terminalViews.current.get('a');a.selecting=true;for(const id of ids){revision.set(id,121);h.refs.terminalViews.current.get(id).dirty=true;}poll();await turn();await turn();
 assert.equal(h.calls.filter(v=>v.name==='read_terminal_frame'&&v.sessionId==='a').length,121);assert.equal(h.refs.terminalViews.current.get('b').frameRevision,121);assert.equal(a.frameRevision,120);assert.equal(h.calls.filter(v=>v.name==='read_terminal_frame'&&v.sessionId==='b').length,122);
 assert.equal(h.calls.filter(v=>['write_session','create_session','stop_session','take_terminal_control'].includes(v.name)).length,0);
 t.diagnostic(JSON.stringify({scope:'Node actual App callbacks and mocked terminal/IPC; not native GUI or PTY',panes:count,ticks:120,continuous_frame_requests:count*121,selection_check_extra_requests:count-1,continuous_end_offset:1200}));
});

test('T14 actual App hiding a pane during pending resize drops its queued size and late error',async()=>{
 for(const outcome of ['success','error']){
  let resolve,reject;const h=harness(['a','b'],(name,args)=>name==='resize_session'?new Promise((yes,no)=>{resolve=yes;reject=no}):null);
  const a=h.add('a');Object.assign(a,{ready:true,writable:true,cursor:10});
  const sync=actual('syncViewSize',h.args);sync(a);a.instance.cols=70;sync(a);
  actual('closeTerminalPane',h.args)(0);if(outcome==='success')resolve();else reject(Error('old hidden resize'));await turn();await turn();
  assert.equal(h.calls.filter(v=>v.name==='resize_session').length,1);assert.deepEqual(h.errors,[]);
 }
});

test('T14 actual App legal input pending before close cannot report its old error on another pane',async()=>{
 let reject;const h=harness(['a','b'],name=>name==='write_session'?new Promise((yes,no)=>reject=no):null);const a=h.add('a'),b=h.add('b');for(const v of [a,b])Object.assign(v,{ready:true,cursor:10,projection:true});h.document.activeElement=a.instance.textarea;
 callback(input,{...h.args,view:a,id:'a'})('legal A');actual('closeTerminalPane',h.args)(0);actual('focusTerminalPane',h.args)(1,true);reject(Error('old A input conflict'));await turn();await turn();
 assert.deepEqual(h.errors,[]);assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>v.sessionId),['a']);assert.equal(h.refs.sessionId.current,'b');
});
test('T14 actual App late notification context error cannot replace newer focused context',async()=>{
 const pending=[];const h=harness(['a','b'],name=>name==='set_agent_notification_context'?new Promise((resolve,reject)=>pending.push({resolve,reject})):null);
 const a=h.add('a'),b=h.add('b');for(const v of [a,b])Object.assign(v,{ready:true,cursor:10});h.document.activeElement=a.instance.textarea;
 actual('syncNotificationContext',h.args)();actual('focusTerminalPane',h.args)(1,true);assert.equal(pending.length,1);pending[0].reject(Error('old context'));await turn();await turn();assert.equal(pending.length,2);pending[1].resolve();await turn();assert.deepEqual(h.errors,[]);assert.equal(h.calls.filter(v=>v.name==='set_agent_notification_context').at(-1).selected,'b');
});

test('T14 actual App committed deletion removes only matching visible membership',()=>{
 const h=harness(['s-one','s-two','s-other']);h.refs.terminalLayoutRef.current={mode:'grid',panes:['s-one','s-two',null,'s-other'],focused:0,revision:4};
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.args,pinnedSessionsRef:{current:[]},setPinnedSessions(){},setSessionTitles:update=>update({}),localStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
 actual('clearDeletedSessionNames',args)(['s-one']);
 assert.deepEqual(h.refs.terminalLayoutRef.current.panes,[null,'s-two',null,'s-other']);assert.equal(h.refs.terminalLayoutRef.current.revision,5);
});

test('T14 review hidden raw replay completion stays ready on close and reopen without replaying',async()=>{
 let release,snapshots=0;const h=harness(['a','b'],async name=>{if(name==='read_terminal_frame')return null;if(name==='read_session_snapshot'){snapshots++;return {data:'live raw fixture',offset:0,end_offset:16,status:'running'};}return null;});
 h.args.createTerminalView=id=>{const view=h.make(id);view.instance.write=(_data,done)=>{release=done;};return view;};const loading=actual('openHistory',h.args)(record('a'),true,0);await turn();const view=h.refs.terminalViews.current.get('a');await turn();assert.equal(view.ready,false);assert.equal(view.firstAttachment,true);
 actual('closeTerminalPane',h.args)(0);release();await loading;
 assert.equal(view.cursor,16);assert.equal(view.ready,true);assert.equal(view.firstAttachment,false);assert.equal(view.finishReplay,null);assert.equal(view.element.inert,true);
 await h.open(record('a'),false,0);assert.equal(view.ready,true);assert.equal(view.element.inert,false);assert.equal(snapshots,1);
});

function launchArgs(h){return {...h.args,starting:false,adapters:[],selectedAdapter:'shell',command:'',cwd:'/fixture',prompt:'',adapterArgs:'',launchMode:'interactive',setStarting(){},setCollapsedProjects(){},setSessionTitles(){},projectKey:path=>path,launchDialog:{current:null},refreshHistory(){},openHistory:h.open};}
function fillCapacity(h){
 for(let i=0;i<13;i++)h.add('live'+i);
 for(let i=0;i<3;i++){const v=h.add('ended'+i);Object.assign(v,{live:false,status:'succeeded',persisted:true,projection:true,ready:true,cursor:10});h.refs.terminalViews.current.setRunning('ended'+i,false);}
 actual('showTerminalLayout',h.args)();
}
test('T14 review protected ended capacity refuses create before allocating an unattachable session',async()=>{
 const h=harness(['live0','ended0','ended1','ended2'],async(name,args)=>name==='create_session'?{session_id:'new',cwd:'/fixture',command:'fixture',status:'running'}:name==='read_terminal_frame'?frame(args.sessionId):null);fillCapacity(h);
 await actual('startSession',launchArgs(h))({cwd:'/fixture',command:'fixture'});
 assert.equal(h.calls.filter(v=>v.name==='create_session').length,0);assert.equal(h.refs.terminalViews.current.size,16);assert.equal(h.refs.terminalViews.current.get('new'),undefined);
});
test('T14 review pending legal start retains admission through ended selection layout and warm focus',async()=>{
 let release;const h=harness(['live0','live1','live2','ended0'],async(name,args)=>name==='create_session'?new Promise(resolve=>release=resolve):name==='read_terminal_frame'?{...frame(args.sessionId,1,args.sessionId.startsWith('ended')?'succeeded':'running'),persisted:false}:null);fillCapacity(h);
 for(let i=0;i<3;i++)h.refs.terminalViews.current.get('ended'+i).persisted=i===1;
 const loading=actual('startSession',launchArgs(h))({cwd:'/fixture',command:'fixture'});await turn();assert.equal(h.calls.filter(v=>v.name==='create_session').length,1);
 actual('changeLayoutMode',h.args)('horizontal');actual('changeLayoutMode',h.args)('grid');
 await h.open({...record('ended0'),status:'succeeded'},false,3);
 await h.open({...record('ended2'),status:'succeeded'},false,2);
 await h.open({...record('ended1'),status:'succeeded'},false,1);
 actual('focusTerminalPane',h.args)(0,false);assert.equal(h.refs.terminalLayoutRef.current.panes[1],'live1','reserved victim selection refuses before membership changes');
 release({session_id:'new',cwd:'/fixture',command:'fixture',status:'running'});await loading;
 assert.ok(h.refs.terminalViews.current.get('new'),'the original authorized process has an attached view');assert.equal(h.refs.sessionId.current,'new');
 assert.equal(h.calls.filter(v=>v.name==='create_session').length,1);for(let i=0;i<13;i++)assert.ok(h.refs.terminalViews.current.get('live'+i));
 assert.equal(h.refs.creatingSession.current,false);
});

test('T14 review failed owner and attachment factory release reservation without disposing the old scene',async()=>{
 for(const failure of ['owner','unknown','factory']){
  const h=harness(['live0'],async name=>{if(name==='create_session'){if(failure==='owner')throw Error('owner unavailable');if(failure==='unknown')return null;return {session_id:'new',cwd:'/fixture',command:'fixture',status:'running'};}return null;});fillCapacity(h);
  const old=h.refs.terminalViews.current.get('ended0');const args=launchArgs(h);
  if(failure==='factory')args.openHistory=actual('openHistory',{...h.args,createTerminalView(){throw Error('renderer open failed');}});
  await actual('startSession',args)({cwd:'/fixture',command:'fixture'});
  assert.equal(h.refs.creatingSession.current,false);assert.equal(h.refs.terminalViews.current.canOpen,true);assert.equal(h.refs.terminalViews.current.get('ended0'),old);assert.equal(old.disposed,false);
  assert.equal(h.calls.filter(v=>v.name==='create_session').length,1);assert.equal(h.refs.terminalViews.current.get('new'),undefined);
 }
});

function contextFixture(){
 const pending=[],owner={selected:null,paused:false};
 const h=harness(['a','b','c','d'],(name,args)=>name==='set_agent_notification_context'?new Promise((resolve,reject)=>pending.push({args,finish(){Object.assign(owner,args);resolve();},reject})):null);
 for(const id of ['a','b','c'])h.add(id);
 h.args.notificationContextFlight={current:{sending:false,pending:null}};
 const sync=actual('syncNotificationContext',h.args);
 function focus(id){h.refs.sessionId.current=id;h.refs.terminalLayoutRef.current.focused=['a','b','c','d'].indexOf(id);h.document.activeElement=h.refs.terminalViews.current.get(id).instance.textarea;sync();}
 return {h,pending,owner,sync,focus};
}
test('T14 actual App context owner ordering single-flights A B C and coalesces latest',async()=>{
 const f=contextFixture();f.focus('a');f.focus('b');f.focus('c');
 assert.equal(f.pending.length,1,'Only A may reach owner while A is in flight');
 f.pending[0].finish();await turn();await turn();assert.equal(f.pending.length,2);assert.equal(f.pending[1].args.selected,'c');
 f.pending[1].finish();await turn();assert.deepEqual(f.owner,{selected:'c',paused:false});
 assert.equal(f.h.errors.length,0);assert.equal(f.h.args.notificationContextFlight.current.sending,false);
});
test('T14/T11 actual App context latest blur survives old rejection without competing pause authority',async()=>{
 const f=contextFixture();f.focus('a');f.focus('b');f.h.document.activeElement={name:'form'};f.h.args.pausedRef.current=true;f.sync();
 assert.equal(f.pending.length,1);f.pending[0].reject(Error('old focus failure'));await turn();await turn();
 assert.equal(f.pending.length,2);assert.deepEqual(f.pending[1].args,{selected:null});assert.deepEqual(f.h.errors,[]);
 f.pending[1].finish();await turn();assert.deepEqual(f.owner,{selected:null,paused:false});
 f.h.document.hasFocus=()=>false;f.h.args.pausedRef.current=false;f.focus('b');assert.deepEqual(f.pending[2].args,{selected:null});
 f.pending[2].finish();await turn();assert.equal(f.h.args.notificationContextFlight.current.sending,false);
});
test('T14 actual App context unmount drops queued latest and old error/finally cannot send',async()=>{
 const f=contextFixture();f.focus('a');f.focus('b');assert.equal(f.pending.length,1);
 f.h.args.terminalMounted.current=false;f.pending[0].reject(Error('closed window'));await turn();await turn();f.sync();
 assert.equal(f.pending.length,1);assert.deepEqual(f.h.errors,[]);assert.equal(f.h.args.notificationContextFlight.current.sending,false);
 assert.equal(f.h.args.notificationContextFlight.current.pending,null);
});

test('T14/T11 actual initial notification and terminal setup effects send selection only once mounted',async()=>{
 let setup;
 function find(node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('terminalMounted.current=true'))setup=node.arguments[0].getText(source);
  ts.forEachChild(node,find);
 }
 find(source);assert.ok(setup);
 const h=harness([null]);h.refs.sessionId.current=null;
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,createTerminalScroll,updateTerminalScroll,setRecoveryRevision(){},...h.args,notificationsPaused:true,pausedRef:{current:true},session:null,terminalMounted:{current:false},notificationContextFlight:{current:{sending:false,pending:null}},localStorage:{setItem(){}},terminalHost:{current:{}},createView:{current:null},window:{addEventListener(){},removeEventListener(){},setInterval(){return 1},clearInterval(){}},document:{...h.document,addEventListener(){},removeEventListener(){}},ResizeObserver:class{observe(){}disconnect(){}},listen:async()=>()=>{},readPreference:()=>null,refreshHistory(){}};
 callback(notificationEffect,args)();assert.equal(h.calls.length,0,'Pre-mount notification effect cannot dispatch');
 callback(setup,args)();await turn();await turn();
 assert.equal(args.terminalMounted.current,true);
 assert.deepEqual(h.calls.filter(v=>v.name==='set_agent_notification_context').map(({name,...parameters})=>parameters),[{selected:null}]);
 assert.deepEqual(h.errors,[]);
});


test('Find state commits preserve actual pane host refs and do not schedule App fits',()=>{
 const h=harness(['a','b']);const mounted=[];
 const props=()=>({layout:h.refs.terminalLayoutRef.current,labels:['A','B'],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){},onHost:(...args)=>{mounted.push(args);actual('mountTerminalPane',h.args)(...args);}});
 let tree=layoutTree(props());let hosts=nodes(tree,n=>n.props?.className==='terminal-pane-host');
 const elements=[{append(){}},{append(){}}];hosts.forEach((node,index)=>node.props.ref(elements[index]));
 assert.equal(h.raf.length,1);h.raf.length=0;h.refs.terminalLayoutFitFrame.current=null;
 for(let commit=0;commit<12;commit++){
  const next=tree.rerender(props()),nextHosts=nodes(next,n=>n.props?.className==='terminal-pane-host');
  nextHosts.forEach((node,index)=>{if(node.props.ref!==hosts[index].props.ref){hosts[index].props.ref(null);node.props.ref(elements[index]);}});
  tree=next;hosts=nextHosts;
 }
 assert.equal(mounted.length,2,'unrelated Find notifications must not detach and reattach host elements');
 assert.equal(h.raf.length,0,'unchanged hosts must not trigger fit / search cancellation feedback');
 assert.equal(h.args.paneHosts.current.get("p-0"),elements[0]);
 hosts[1].props.ref(null);assert.equal(h.args.paneHosts.current.has("p-1"),false,'real detach still removes host');
});

test('stable pane host refs forward latest parent callback and genuine replacement',()=>{
 const calls=[];const props=onHost=>({layout:{mode:'single',panes:['a'],focused:0,revision:0},labels:['A'],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){},onHost});
 let tree=layoutTree(props((...args)=>calls.push(['old',...args])));
 const ref=nodes(tree,n=>n.props?.className==='terminal-pane-host')[0].props.ref;
 const original={};ref(original);
 tree=tree.rerender(props((...args)=>calls.push(['new',...args])));
 const next=nodes(tree,n=>n.props?.className==='terminal-pane-host')[0].props.ref;
 assert.equal(next,ref,'ref identity must survive changed onHost props');
 next(null);const replacement={};next(replacement);
 assert.deepEqual(calls,[['old','p-0',original],['new','p-0',null],['new','p-0',replacement]]);
});

test('B02a actual pending attachment follows its stable leaf when a preceding leaf is split',async()=>{
 const a='s-a-1',b='s-b-2';let release;
 const h=harness([a,b],(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>{release=resolve;}):null);
 const loading=h.open(record(b),false,1);await turn();const view=h.refs.terminalViews.current.get(b);
 const oldPane=layoutOperations.terminalPaneId(h.refs.terminalLayoutRef.current,1),host={append(element){element.parentElement=this;}};
 h.args.paneHosts.current.set(oldPane,host);
 h.refs.terminalLayoutRef.current=layoutOperations.splitTerminalPane({...h.refs.terminalLayoutRef.current,focused:0},'vertical');
 actual('showTerminalLayout',h.args)();release(frame(b));await loading;
 assert.equal(view.ready,true,'inserting another leaf must not strand this attachment');assert.equal(view.element.parentElement,host);
 assert.equal(h.refs.terminalViews.current.get(b),view);assert.equal(view.disposed,false);
 assert.equal(h.calls.some(call=>['create_session','stop_session','resume_session'].includes(call.name)),false);
});

test('B02a actual split focuses empty leaf and preserves warm views and input ownership',async()=>{
 const a='s-a-1',b='s-b-2';const h=harness([a,b]);h.args.splitPercentRef={current:50};
 await h.open(record(a),false,0);await h.open(record(b),false,1);actual('focusTerminalPane',h.args)(1,true);
 const av=h.refs.terminalViews.current.get(a),bv=h.refs.terminalViews.current.get(b),cursor=bv.cursor;
 actual('splitFocusedTerminalPane',h.args)('vertical');
 assert.deepEqual(h.refs.terminalLayoutRef.current.panes,[a,b,null]);assert.equal(h.refs.terminalLayoutRef.current.focused,2);assert.equal(h.refs.sessionId.current,null);
 assert.equal(h.refs.terminalViews.current.get(a),av);assert.equal(h.refs.terminalViews.current.get(b),bv);assert.equal(bv.cursor,cursor);assert.equal(bv.disposed,false);
 const write=callback(input,{...h.args,view:bv,id:b});write('wrong pane');await turn();assert.equal(h.calls.some(call=>call.name==='write_session'),false);
 assert.equal(h.calls.some(call=>['create_session','stop_session','resume_session'].includes(call.name)),false);
});

test('B02a committed root resize replaces a queued stale fit with a fresh frame',()=>{
 let next=0,fits=0;const scheduled=new Map();const state=layoutOperations.splitTerminalPane(layoutOperations.createTerminalLayout(),'horizontal');
 const view={instance:{rows:40,refresh(){}},element:{dataset:{sessionId:'a'},getBoundingClientRect:()=>({width:600,height:400})},fit:{fit(){fits++;}},viewportRevision:0,live:false,ready:false,disposed:false};state.panes[0]='a';state.root.first.sessionId='a';
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),terminalTabFocus:{current:null},zoomedPaneIdRef:{current:null},terminalPaneZoomIntent:{current:0},setZoomedPaneId(){},...layoutOperations,terminalLayoutFitFrame:{current:null},terminalLayoutFitIntent:{current:0},terminalLayoutRef:{current:state},terminalMounted:{current:true},terminalViews:{current:{all:[view]}},splitPercentRef:{current:50},setSplitPercent(){},setTerminalLayout(){},requestAnimationFrame:callback=>{const id=++next;scheduled.set(id,callback);return id;},cancelAnimationFrame:id=>scheduled.delete(id)};
 actual('requestTerminalLayoutFit',args)();const stale=scheduled.get(1);actual('commitTerminalSplit',args)(63);stale();
 const fresh=[...scheduled.entries()].filter(([id])=>id!==1);assert.equal(fresh.length,1,'root revision must schedule replacement fit');fresh[0][1]();assert.equal(fits,1);
});
test('B02a recursive component renders asymmetric three leaves and preserves sibling host callback',()=>{
 let layout=layoutOperations.changeTerminalLayout(layoutOperations.createTerminalLayout(),'horizontal');
 const props=()=>({layout,labels:['A','B',null],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onHost(){},onSplit(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){}});
 let tree=layoutTree(props()),hosts=nodes(tree,n=>n.props?.className==='terminal-pane-host'),sibling=hosts[1].props.ref;
 layout=layoutOperations.splitTerminalPane({...layout,focused:0},'vertical');tree=tree.rerender(props());hosts=nodes(tree,n=>n.props?.className==='terminal-pane-host');
 assert.equal(hosts.length,3);assert.equal(hosts[2].props.ref,sibling);
 const branches=nodes(tree,n=>n.props?.className?.startsWith('terminal-layout-node'));assert.equal(branches.length,2);
 assert.equal(branches[0].props.style.minWidth,486);assert.equal(branches[0].props.style.minHeight,366);
});

// B02b actual callbacks preserve warm member identity; these are not native GUI tests.
test('B02b actual hidden ended tab survives retain and remains cache protected',async()=>{
 const h=harness(['a','b']);const a=h.add('a');Object.assign(a,{live:false,status:'succeeded',persisted:true,projection:true,ready:true,cursor:10});h.refs.terminalViews.current.setRunning('a',false);
 await h.open(record('c'),false,0);await h.open(record('b'),false,1);
 assert.equal(h.refs.terminalViews.current.get('a'),a);assert.equal(a.disposed,false);assert.equal(a.element.style.visibility,'hidden');
 assert.deepEqual(layoutOperations.terminalMembers(h.refs.terminalLayoutRef.current),['a','c','b']);
});
test('B02b actual ready sidebar member activation performs no terminal reads or process operations',async()=>{
 const h=harness(['a','b']);await h.open(record('a'),false,0);await h.open(record('c'),false,0);h.calls.length=0;
 await h.open(record('a'),false,1);assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['a','b']);assert.equal(h.refs.terminalLayoutRef.current.focused,0);
 assert.deepEqual(h.calls.filter(c=>['read_terminal_frame','read_session_snapshot','create_session','stop_session','resume_session'].includes(c.name)),[]);
});
test('B02b actual hidden member attachment completes without changing saved active tab',async()=>{
 let release;const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'&&args.sessionId==='a'?new Promise(resolve=>release=resolve):name==='read_terminal_frame'?frame(args.sessionId):null);
 const loading=h.open(record('a'),false,0);await turn();const a=h.refs.terminalViews.current.get('a');await h.open(record('c'),false,0);release(frame('a'));await loading;
 assert.equal(a.ready,true);assert.equal(a.element.inert,true);assert.equal(h.refs.terminalLayoutRef.current.panes[0],'c');assert.equal(h.refs.sessionId.current,'c');
});

test('B02b actual committed deletion removes hidden membership and keeps siblings',()=>{
 const h=harness(['a','b']);h.refs.terminalLayoutRef.current=layoutOperations.assignTerminalPane(h.refs.terminalLayoutRef.current,0,'c');
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),...h.args,pinnedSessionsRef:{current:[]},setPinnedSessions(){},setSessionTitles:update=>update({}),localStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
 actual('clearDeletedSessionNames',args)(['a']);assert.deepEqual(layoutOperations.terminalMembers(h.refs.terminalLayoutRef.current),['c','b']);assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['c','b']);
});
test('B02b actual move warm active tab keeps view identity and routes input only to destination',async()=>{
 const h=harness(['a','b']);await h.open(record('a'),false,0);await h.open(record('c'),false,0);await h.open(record('b'),false,1);
 const view=h.refs.terminalViews.current.get('c'),cursor=view.cursor;h.calls.length=0;
 actual('moveTerminalSession',h.args)('c',1);assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['a','c']);assert.equal(h.refs.sessionId.current,'c');assert.equal(view.cursor,cursor);assert.equal(h.refs.terminalViews.current.get('c'),view);
 callback(input,{...h.args,view,id:'c'})('destination');callback(input,{...h.args,view:h.refs.terminalViews.current.get('a'),id:'a'})('wrong');await turn();
 assert.deepEqual(h.calls.filter(c=>c.name==='write_session').map(c=>c.sessionId),['c']);assert.deepEqual(h.calls.filter(c=>['read_terminal_frame','create_session','stop_session','resume_session'].includes(c.name)),[]);
});

test('B02b pending move rejects old source attachment and permits the explicit destination attachment',async()=>{
 const pending=[];const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'&&args.sessionId==='a'?new Promise(resolve=>pending.push(resolve)):name==='read_terminal_frame'?frame(args.sessionId):null);
 const old=h.open(record('a'),false,0);await turn();const view=h.refs.terminalViews.current.get('a');actual('moveTerminalSession',h.args)('a',1);await turn();
 assert.equal(pending.length,2);pending[0](frame('a',1));await old;assert.equal(view.ready,false);pending[1](frame('a',2));await turn();await turn();
 assert.equal(view.ready,true);assert.equal(view.frameRevision,2);assert.deepEqual(h.refs.terminalLayoutRef.current.panes,[null,'a']);assert.equal(h.refs.sessionId.current,'a');assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session'].includes(c.name)),[]);
});
test('B02b actual inactive tabs neither poll nor fit nor receive human input',async()=>{
 const h=harness(['a','b']);await h.open(record('a'),false,0);await h.open(record('c'),false,0);const hidden=h.refs.terminalViews.current.get('a'),active=h.refs.terminalViews.current.get('c');
 const fits=[];hidden.fit.fit=()=>fits.push('a');active.fit.fit=()=>fits.push('c');h.calls.length=0;
 actual('fitTerminalViews',h.args)();callback(timer,h.args)();h.document.activeElement=hidden.instance.textarea;callback(input,{...h.args,view:hidden,id:'a'})('hidden human');await turn();await turn();
 assert.equal(fits.includes('a'),false);assert.equal(fits.includes('c'),true);assert.equal(h.calls.some(c=>c.name==='read_terminal_frame'&&c.sessionId==='a'),false);assert.equal(h.calls.some(c=>c.name==='write_session'),false);
});

test('B02b explicit cold tab selection does not steal later form focus',async()=>{
 let release;const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'&&args.sessionId==='a'?new Promise(resolve=>release=resolve):name==='read_terminal_frame'?frame(args.sessionId):null);
 const a=h.add('a');a.record=record('a');actual('selectTerminalTab',h.args)(0,'a');const search={name:'search'};h.document.activeElement=search;await turn();release(frame('a'));await turn();await turn();
 assert.equal(h.document.activeElement,search);assert.equal(h.refs.sessionId.current,'a');
});

function removalArgs(h){return {...h.args,pinnedSessionsRef:{current:[]},setPinnedSessions(){},setSessionTitles:update=>update({}),localStorage:{getItem:()=>null,setItem(){},removeItem(){}},canCloseSessionView:status=>['succeeded','stopped','failed','needs_attention'].includes(status)};}
for(const entry of ['closeEndedView','clearDeletedSessionNames'])test(`B02b R1 ${entry} selects visible adjacent member without stealing form focus or creating processes`,async()=>{
 const h=harness(['a','c']);await h.open(record('a'),false,0);await h.open({...record('b'),status:'stopped'},false,0);const a=h.refs.terminalViews.current.get('a'),b=h.refs.terminalViews.current.get('b');Object.assign(b,{live:false,status:'stopped',persisted:true});
 const form={name:'form'};h.document.activeElement=form;h.calls.length=0;
 const action=actual(entry,removalArgs(h));entry==='closeEndedView'?action():action(['b']);
 assert.deepEqual(h.refs.terminalLayoutRef.current.panes,['a','c']);assert.equal(h.refs.sessionId.current,'a');assert.equal(h.refs.selectedRecord.current.summary.session_id,'a');assert.equal(h.refs.terminal.current,a.instance);assert.equal(h.refs.fitAddon.current,a.fit);assert.equal(h.refs.outputCursor.current,a.cursor);assert.equal(a.element.style.visibility,'visible');assert.equal(a.element.inert,false);assert.equal(h.document.activeElement,form);
 assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session','write_session'].includes(c.name)),[]);assert.equal(h.calls.filter(c=>c.name==='set_agent_notification_context').at(-1)?.selected,null);
 h.document.activeElement=a.instance.textarea;callback(input,{...h.args,view:a,id:'a'})('adjacent input');await turn();assert.deepEqual(h.calls.filter(c=>c.name==='write_session').map(c=>c.sessionId),['a']);
});
for(const removal of ['hidden','nonfocused','last'])test(`B02b R1 committed ${removal} removal preserves exact focus and clears final ghost references`,async()=>{
 const h=harness(['a','c']);await h.open(record('a'),false,0);await h.open({...record('b'),status:'stopped'},false,0);await h.open(record('c'),false,1);actual('focusTerminalPane',h.args)(removal==='nonfocused'?1:0,false);
 const selected=h.refs.sessionId.current,view=h.refs.terminal.current;const ids=removal==='hidden'?['a']:removal==='nonfocused'?['b']:['a','b'];
 actual('clearDeletedSessionNames',removalArgs(h))(ids);
 if(removal==='last'){assert.equal(h.refs.terminalLayoutRef.current.panes[0],null);for(const ref of ['sessionId','selectedRecord','terminal','fitAddon','outputCursor'])assert.equal(h.refs[ref].current,null);assert.equal(h.refs.terminalLayoutRef.current.focused,0);}
 else{assert.equal(h.refs.sessionId.current,selected);assert.equal(h.refs.terminal.current,view);assert.equal(h.refs.terminalLayoutRef.current.focused,removal==='nonfocused'?1:0);}
 assert.equal(h.calls.some(c=>['create_session','stop_session','resume_session'].includes(c.name)),false);
});

// B03a semantic RED: the real recursive component must expose the inner split.
test('B03a every nested split owns an independent accessible separator',()=>{
 const layout=layoutOperations.splitTerminalPane({...layoutOperations.changeTerminalLayout(layoutOperations.createTerminalLayout(),'horizontal'),focused:0},'vertical');
 const changes=[];const tree=layoutTree({layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){},onNodeSplitChange:(...args)=>changes.push(args)});
 const separators=nodes(tree,n=>n.props?.role==='separator');assert.equal(separators.length,2,'root and inner split each expose a separator');
 const inner=separators.find(n=>n.props['data-node-id']===layout.root.first.nodeId);assert.equal(inner.props['aria-orientation'],'horizontal');
 inner.props.onKeyDown({key:'ArrowDown',preventDefault(){}});assert.deepEqual(changes,[[layout.root.first.nodeId,55]]);
});

function resizeFixture(){
 let layout=layoutOperations.splitTerminalPane({...layoutOperations.assignTerminalPane(layoutOperations.changeTerminalLayout(layoutOperations.createTerminalLayout(),'horizontal'),1,'warm'),focused:0},'vertical');
 const changes=[],previews=[],cancelled=[],focus=[];
 const props=()=>({layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus:(...args)=>focus.push(args),onClose(){},onHost(){},onSplitChange(){},onSplitPreview:value=>previews.push(value),onSwap(){},onCancelFit:()=>cancelled.push(true),onNodeSplitChange:(id,value)=>{changes.push([id,value]);layout=layoutOperations.resizeTerminalNode(layout,id,value);}});
 let tree=layoutTree(props());const innerId=layout.root.first.nodeId;
 const host={getBoundingClientRect:()=>({left:100,top:200,width:400,height:606})};
 const target={parentElement:host,getBoundingClientRect:()=>({left:100,top:500,width:400,height:6}),setPointerCapture(){},releasePointerCapture(){}};
 const separator=()=>nodes(tree,n=>n.props?.['data-node-id']===innerId)[0];
 const event=(id=7,y=620)=>({pointerId:id,button:0,clientX:300,clientY:y,currentTarget:target,preventDefault(){}});
 return {changes,previews,cancelled,focus,innerId,target,event,separator,get layout(){return layout;},get tree(){return tree;},rerender(){tree=tree.rerender(props());},changeStructure(){layout=layoutOperations.splitTerminalPane({...layout,focused:0},'horizontal');tree=tree.rerender(props());}};
}
test('B03a local pointer geometry previews one inner ratio without saving, then commits once',()=>{
 const f=resizeFixture(),root=f.layout.root,sibling=root.second;f.separator().props.onPointerDown(f.event());f.separator().props.onPointerMove(f.event());
 assert.deepEqual(f.previews,[70]);assert.deepEqual(f.changes,[]);assert.equal(f.layout.root,root);
 f.rerender();assert.equal(f.separator().props['aria-valuenow'],70);
 f.separator().props.onPointerUp(f.event());f.separator().props.onPointerUp(f.event());
 assert.deepEqual(f.changes,[[f.innerId,70]]);assert.equal(f.layout.root.ratio,50);assert.equal(f.layout.root.second,sibling);assert.deepEqual(f.focus,[]);
});
for(const cancel of ['Escape','pointercancel','lostcapture','structure','unmount'])test(`B03a ${cancel} cancels inner drag and fences stale pointer commit`,()=>{
 const f=resizeFixture();const old=f.separator();old.props.onPointerDown(f.event());old.props.onPointerMove(f.event());
 if(cancel==='Escape')old.props.onKeyDown({key:'Escape',preventDefault(){}});
 else if(cancel==='pointercancel')old.props.onPointerCancel(f.event());
 else if(cancel==='lostcapture')old.props.onLostPointerCapture(f.event());
 else if(cancel==='structure')f.changeStructure();
 else f.tree.cleanups.forEach(fn=>fn());
 old.props.onPointerUp(f.event());assert.deepEqual(f.changes,[]);assert.equal(f.previews.at(-1),50);assert.ok(f.cancelled.length);assert.deepEqual(f.focus,[]);
});
test('B03a wrong pointer events and non-primary start cannot alter preview or commit',()=>{
 const f=resizeFixture(),s=f.separator();s.props.onPointerDown({...f.event(),button:2});s.props.onPointerMove(f.event());assert.deepEqual(f.previews,[]);
 s.props.onPointerDown(f.event());s.props.onPointerMove(f.event(9));s.props.onPointerCancel(f.event(9));s.props.onLostPointerCapture(f.event(9));s.props.onPointerUp(f.event(9));assert.deepEqual(f.previews,[]);assert.deepEqual(f.changes,[]);
 s.props.onPointerUp(f.event());assert.deepEqual(f.changes,[[f.innerId,70]]);
});
test('B03a mounted node pixel bounds disable impossible geometry and bound keyboard reset',()=>{
 const f=resizeFixture();const branch=nodes(f.tree,n=>n.props?.className==='terminal-layout-node node-vertical')[0];
 const small={getBoundingClientRect:()=>({left:0,top:0,width:400,height:200})};branch.props.ref(small);f.rerender();let s=f.separator();assert.equal(s.props['aria-disabled'],true);
 const target={...f.target,parentElement:small};s.props.onKeyDown({key:'End',currentTarget:target,preventDefault(){}});s.props.onPointerDown({...f.event(),currentTarget:target});assert.deepEqual(f.changes,[]);
 branch.props.ref({getBoundingClientRect:()=>({left:0,top:0,width:400,height:506})});f.rerender();s=f.separator();assert.equal(s.props['aria-valuemin'],36);assert.equal(s.props['aria-valuemax'],64);
 s.props.onKeyDown({key:'Home',currentTarget:f.target,preventDefault(){}});assert.deepEqual(f.changes,[[f.innerId,36]]);
 s.props.onDoubleClick({currentTarget:f.target});assert.equal(f.changes.at(-1)[1],50);
});
test('B03a toolbar reset addresses nearest split of focused pane',()=>{
 const f=resizeFixture();nodes(f.tree,n=>n.props?.['aria-label']==='Reset split to 50 percent')[0].props.onClick();assert.deepEqual(f.changes,[[f.innerId,50]]);
});

test('B03a actual App preview/cancel replaces stale RAF, commit saves once without changing views or focus',async()=>{
 const h=harness(['s-a-1','s-b-2']);h.refs.terminalLayoutRef.current=layoutOperations.splitTerminalPane({...h.refs.terminalLayoutRef.current,focused:0},'vertical');
 const original=h.refs.terminalLayoutRef.current,inner=original.root.first.nodeId,selected=h.refs.sessionId.current;
 const views=original.panes.filter(Boolean).map(id=>h.add(id));const fits=[];for(const view of views)view.fit.fit=()=>fits.push(view.record.summary.session_id);
 let sequence=0;const frames=new Map(),stored=[];let effect;
 function find(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('saveTerminalLayout(terminalLayout'))effect=node.arguments[0].getText(source);ts.forEachChild(node,find);}find(source);
 const persistence=await import('../src/terminal-layout-persistence.ts');
 const args={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),...h.args,requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),setTerminalLayout(next){h.refs.terminalLayoutRef.current=next;callback(effect,{...h.args,...persistence,terminalLayout:next,layoutRestoreReady:true,splitPercent:50,localStorage:{setItem:(key,value)=>stored.push([key,value])}})();}};
 const request=actual('requestTerminalLayoutFit',args),preview=actual('previewTerminalSplit',args),commit=actual('commitTerminalNodeSplit',args);request();const old=frames.get(1);preview();const oldPreview=frames.get(2);preview();old();oldPreview();assert.deepEqual(fits,[]);assert.deepEqual(stored,[]);assert.equal(h.refs.terminalLayoutRef.current,original);
 commit(inner,70);const fresh=frames.get(sequence);fresh();assert.deepEqual(fits,['s-a-1','s-b-2']);assert.equal(stored.length,1);assert.equal(JSON.parse(stored[0][1]).root.first.ratio,70);
 commit(inner,70);assert.equal(stored.length,1,'same ratio never writes twice');assert.equal(h.refs.sessionId.current,selected);assert.equal(h.refs.terminalLayoutRef.current.focused,original.focused);assert.deepEqual(layoutOperations.terminalMembers(h.refs.terminalLayoutRef.current),layoutOperations.terminalMembers(original));views.forEach((view,i)=>{assert.equal(h.refs.terminalViews.current.get(view.record.summary.session_id),views[i]);assert.equal(view.disposed,false);});assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session','write_session'].includes(c.name)),[]);
});
test('B03a actual App root resize persists current node ratio instead of legacy controlled value',async()=>{
 const h=harness(['s-a-1','s-b-2']);let effect;function find(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='useEffect'&&n.arguments[0]?.getText(source).includes('saveTerminalLayout(terminalLayout'))effect=n.arguments[0].getText(source);ts.forEachChild(n,find);}find(source);
 const saved=[],persistence=await import('../src/terminal-layout-persistence.ts');actual('commitTerminalNodeSplit',h.args)('n-0',65);
 callback(effect,{...h.args,...persistence,terminalLayout:h.refs.terminalLayoutRef.current,layoutRestoreReady:true,splitPercent:50,localStorage:{setItem:(key,value)=>saved.push(JSON.parse(value))}})();assert.equal(saved[0].root.ratio,65);assert.equal(saved[0].version,5);
});

function escapeRoutingFixture(focused='terminal-textarea'){
 const registrations=[],listeners=new Set(),delivered=[];const document={activeElement:{name:focused},addEventListener(type,listener,capture){assert.equal(type,'keydown');assert.equal(capture,true);registrations.push(['add',listener,capture]);listeners.add(listener);},removeEventListener(type,listener,capture){assert.equal(type,'keydown');assert.equal(capture,true);registrations.push(['remove',listener,capture]);listeners.delete(listener);}};
 let layout=layoutOperations.changeTerminalLayout(layoutOperations.createTerminalLayout(),'horizontal');const changes=[],previews=[],fits=[];
 const props=()=>({layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){throw Error('resize must not change pane focus');},onClose(){},onHost(){},onSplitChange(){},onSplitPreview:value=>previews.push(value),onSwap(){},onCancelFit:()=>fits.push('cancel'),onNodeSplitChange:(...args)=>changes.push(args)});
 let tree=layoutTree(props(),{states:[],refs:[],document});const separator=()=>nodes(tree,n=>n.props?.role==='separator')[0];
 const host={getBoundingClientRect:()=>({left:0,top:0,width:1006,height:400})};const target={ownerDocument:document,parentElement:host,getBoundingClientRect:()=>({left:500,top:0,width:6,height:400}),setPointerCapture(){},releasePointerCapture(){}};
 const pointer=(id=7)=>({pointerId:id,button:0,clientX:703,clientY:100,currentTarget:target,preventDefault(){}});
 function dispatch(key){const event={key,target:document.activeElement,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};for(const listener of [...listeners])listener(event);if(!event.stopped)delivered.push([document.activeElement.name,key]);return event;}
 return {document,listeners,registrations,changes,previews,fits,pointer,separator,dispatch,get tree(){return tree;},changeStructure(){layout=layoutOperations.splitTerminalPane({...layout,focused:0},'vertical');tree=tree.rerender(props());}};
}
for(const focused of ['terminal-textarea','search-form'])test(`B03a R1 focused ${focused} Escape follows actual capture registration and cancels drag`,()=>{
 const f=escapeRoutingFixture(focused),s=f.separator();const noDrag=f.dispatch('Escape');assert.equal(noDrag.prevented,false);assert.equal(noDrag.stopped,false);assert.equal(f.listeners.size,0);
 s.props.onPointerDown(f.pointer());s.props.onPointerMove(f.pointer());assert.equal(f.document.activeElement.name,focused);assert.deepEqual(f.previews,[70]);
 const escaped=f.dispatch('Escape');assert.equal(escaped.prevented,true,'capture Escape must prevent focused target TUI input');assert.equal(escaped.stopped,true);s.props.onPointerUp(f.pointer());assert.deepEqual(f.changes,[]);assert.equal(f.previews.at(-1),50);assert.equal(f.document.activeElement.name,focused);assert.equal(f.listeners.size,0);
 const after=f.dispatch('Escape');assert.equal(after.prevented,false);assert.equal(after.stopped,false);
});
for(const end of ['commit','pointercancel','lostcapture','unmount','structure'])test(`B03a R1 ${end} removes exact drag Escape capture listener`,()=>{
 const f=escapeRoutingFixture(),s=f.separator();s.props.onPointerDown(f.pointer());assert.equal(f.listeners.size,1);assert.equal(f.dispatch('ArrowDown').prevented,false);
 s.props.onPointerCancel(f.pointer(99));s.props.onLostPointerCapture(f.pointer(99));s.props.onPointerUp(f.pointer(99));assert.equal(f.listeners.size,1,'wrong pointer cannot remove active listener');
 if(end==='commit')s.props.onPointerUp(f.pointer());else if(end==='pointercancel')s.props.onPointerCancel(f.pointer());else if(end==='lostcapture')s.props.onLostPointerCapture(f.pointer());else if(end==='unmount')f.tree.cleanups.forEach(fn=>fn());else f.changeStructure();
 assert.equal(f.listeners.size,0);assert.equal(f.registrations.length,2);assert.equal(f.registrations[0][1],f.registrations[1][1]);assert.equal(f.dispatch('Escape').prevented,false);s.props.onPointerUp(f.pointer());assert.equal(f.changes.length,end==='commit'?1:0);
});

test('B03a R1 capture failures still permit focused Escape cancellation and exact cleanup',()=>{
 const f=escapeRoutingFixture(),s=f.separator(),event=f.pointer();event.currentTarget.setPointerCapture=()=>{throw Error('capture unavailable');};event.currentTarget.releasePointerCapture=()=>{throw Error('already released');};
 s.props.onPointerDown(event);s.props.onPointerMove(event);assert.equal(f.listeners.size,1);assert.equal(f.dispatch('Escape').prevented,true);s.props.onPointerUp(event);assert.equal(f.listeners.size,0);assert.deepEqual(f.changes,[]);assert.equal(f.previews.at(-1),50);
 let prevented=false;s.props.onKeyDown({key:'Escape',preventDefault(){prevented=true;}});assert.equal(prevented,false,'no-drag separator Escape is untouched');
});
test('B03a R1 refused pointer start never registers an Escape listener',()=>{
 const f=escapeRoutingFixture(),s=f.separator(),event=f.pointer();s.props.onPointerDown({...event,button:2});assert.equal(f.listeners.size,0);
 event.currentTarget.parentElement.getBoundingClientRect=()=>({left:0,top:0,width:200,height:400});s.props.onPointerDown(event);assert.equal(f.listeners.size,0);assert.equal(f.dispatch('Escape').prevented,false);
});

// B03b semantic RED uses actual visibility and JSX paths before production changes.
test('B03b zoom hides other active panes but protects every tab without disposing views',()=>{
 const h=harness(['a','b']);const a=h.add('a'),b=h.add('b');a.ready=b.ready=true;
 h.args.zoomedPaneIdRef={current:'p-0'};
 actual('showTerminalLayout',h.args)();
 assert.equal(a.element.style.visibility,'visible');assert.equal(b.element.style.visibility,'hidden');assert.equal(b.element.inert,true);assert.equal(b.disposed,false);
 assert.equal(actual('terminalHasInputFocus',h.args)('b'),false);
});
test('B03b real JSX offers four direction actions and maximizes only current pane while keeping stable hosts',()=>{
 const layout=layoutOperations.changeTerminalLayout(layoutOperations.createTerminalLayout(),'grid');const actions=[];
 const props={layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){},zoomedPaneId:'p-0',onDirection:d=>actions.push(d),onZoom:()=>actions.push('zoom')};
 const tree=layoutTree(props),sections=nodes(tree,n=>n.type==='section');assert.equal(sections.filter(n=>!n.props.hidden).length,1);
 for(const direction of ['left','right','up','down']){const button=nodes(tree,n=>n.props?.['aria-label']===`Focus pane ${direction}`)[0];assert.ok(button,`direction ${direction} is discoverable`);button.props.onClick();}
 const zoom=nodes(tree,n=>n.props?.['aria-label']==='Restore terminal panes')[0];assert.ok(zoom);assert.equal(zoom.props['aria-pressed'],true);zoom.props.onClick();assert.deepEqual(actions,['left','right','up','down','zoom']);
 assert.equal(nodes(tree,n=>n.props?.className==='terminal-pane-host').length,4,'hidden hosts stay mounted');
});

test('B03b actual zoom and restore preserve full tree, tabs, ratios, cursor and instances while replacing stale RAF',async()=>{
 const h=harness(['a','b']);await h.open(record('a'),false,0);await h.open(record('hidden'),false,0);await h.open(record('b'),false,1);actual('focusTerminalPane',h.args)(0,true);
 const original=h.refs.terminalLayoutRef.current,tree=original.root,saved=JSON.stringify(original),views=h.refs.terminalViews.current.all.map(v=>[v,v.cursor,v.instance]);
 const fits=[];for(const [v] of views)v.fit.fit=()=>fits.push(v.record.summary.session_id);
 let sequence=0;const frames=new Map(),cancelled=[];Object.assign(h.args,{requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>{cancelled.push(id);frames.delete(id);}});
 actual('requestTerminalLayoutFit',h.args)();const stale=frames.get(sequence);actual('toggleTerminalPaneZoom',h.args)();assert.equal(h.refs.zoomedPaneIdRef.current,'p-0');stale();assert.deepEqual(fits,[]);
 frames.get(sequence)();assert.deepEqual(fits,['hidden']);fits.length=0;
 await h.open(record('a'),false,0);assert.equal(h.refs.zoomedPaneIdRef.current,'p-0');assert.equal(h.refs.terminalLayoutRef.current.root.first.tabs.length,2);
 const preRestore=frames.get(sequence);actual('toggleTerminalPaneZoom',h.args)();preRestore();assert.deepEqual(fits,[]);frames.get(sequence)();assert.deepEqual(fits.sort(),['a','b']);
 assert.equal(h.refs.zoomedPaneIdRef.current,null);assert.deepEqual(h.refs.terminalLayoutRef.current.root,{...tree,first:{...tree.first,sessionId:'a'}});assert.equal(JSON.parse(saved).root.ratio,h.refs.terminalLayoutRef.current.root.ratio);
 views.forEach(([v,cursor,instance])=>{assert.equal(h.refs.terminalViews.current.get(v.record.summary.session_id),v);assert.equal(v.cursor,cursor);assert.equal(v.instance,instance);assert.equal(v.disposed,false);});assert.ok(cancelled.length);assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session','write_session'].includes(c.name)),[]);
});
test('B03b actual hidden zoom pane cannot receive input, fit, poll, Find or notification selected context while raw protocol replies remain',async()=>{
 const h=harness(['a','b']);const a=h.add('a'),b=h.add('b');for(const v of [a,b])Object.assign(v,{ready:true,cursor:10,projection:true,frameInstance:'a'.repeat(64)});
 h.refs.zoomedPaneIdRef.current='p-0';h.refs.sessionId.current='b';h.refs.terminalLayoutRef.current.focused=1;h.document.activeElement=b.instance.textarea;
 callback(input,{...h.args,view:b,id:'b'})('hidden human input');const fits=[];a.fit.fit=()=>fits.push('a');b.fit.fit=()=>fits.push('b');actual('fitTerminalViews',h.args)();actual('pollTerminalFrames',h.args)();actual('openTerminalFind',h.args)();actual('syncNotificationContext',h.args)();await turn();
 assert.deepEqual(fits,['a']);assert.equal(b.find,undefined);assert.deepEqual(h.calls.filter(c=>c.name==='write_session'),[]);assert.deepEqual(h.calls.filter(c=>c.name==='read_terminal_frame').map(c=>c.sessionId),['a']);assert.deepEqual(h.calls.filter(c=>c.name==='set_agent_notification_context').map(c=>c.selected),[null]);
 b.projection=false;callback(input,{...h.args,view:b,id:'b'})('\x1b[1;1R');await turn();assert.deepEqual(h.calls.filter(c=>c.name==='write_session').map(c=>c.data),['\x1b[1;1R']);
});
test('B03b actual direction reads section DOM rectangles and missing geometry leaves focus unchanged',()=>{
 const h=harness(['a','b','c','d']);h.refs.terminalLayoutRef.current.focused=0;const coordinates=[[0,100],[100,0],[100,100],[0,0]];
 for(let i=0;i<4;i++){const [left,top]=coordinates[i];h.args.paneHosts.current.set(`p-${i}`,{parentElement:{matches:s=>s==='section.terminal-pane',getBoundingClientRect:()=>({left,top,width:100,height:100})}});}
 actual('focusTerminalPaneDirection',h.args)('right');assert.equal(h.refs.terminalLayoutRef.current.focused,2);assert.equal(h.refs.sessionId.current,'c');actual('focusTerminalPaneDirection',h.args)('left');assert.equal(h.refs.terminalLayoutRef.current.focused,0);
 h.args.paneHosts.current.delete('p-1');actual('focusTerminalPaneDirection',h.args)('right');assert.equal(h.refs.terminalLayoutRef.current.focused,0);
});
test('B03b explicit crosspane selection restores before focus while same pane tab stays zoomed and preset clears zoom',async()=>{
 const h=harness(['a','b']);for(const id of ['a','b']){const v=h.add(id);Object.assign(v,{ready:true,cursor:10});}actual('toggleTerminalPaneZoom',h.args)();await h.open(record('b'),false,1);assert.equal(h.refs.zoomedPaneIdRef.current,null);assert.equal(h.refs.sessionId.current,'b');assert.equal(h.refs.terminalViews.current.get('b').element.style.visibility,'visible');
 actual('toggleTerminalPaneZoom',h.args)();actual('changeLayoutMode',h.args)('horizontal');assert.equal(h.refs.zoomedPaneIdRef.current,null);
 h.refs.zoomedPaneIdRef.current='p-99';actual('showTerminalLayout',h.args)();assert.equal(h.refs.zoomedPaneIdRef.current,null,'removed zoom leaf clears transient state');
});
test('B03b zoom/restore generations cancel pending resize and stale pointer cannot commit preserved ratio',()=>{
 const f=resizeFixture(),old=f.separator();old.props.onPointerDown(f.event());old.props.onPointerMove(f.event());
 const props={layout:f.layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview:v=>f.previews.push(v),onSwap(){},onCancelFit:()=>f.cancelled.push(true),onNodeSplitChange:(...a)=>f.changes.push(a),zoomedPaneId:layoutOperations.terminalPaneId(f.layout,f.layout.focused),zoomRevision:1};
 const zoom=f.tree.rerender(props);old.props.onPointerUp(f.event());assert.deepEqual(f.changes,[]);assert.equal(f.previews.at(-1),50);
 zoom.rerender({...props,zoomedPaneId:null,zoomRevision:2});old.props.onPointerUp(f.event());assert.deepEqual(f.changes,[]);assert.equal(f.layout.root.first.ratio,50);assert.ok(f.cancelled.length);
});

test('B03b pending Find after fit cannot search a pane hidden by later zoom',()=>{
 const h=harness(['a','b']);const a=h.add('a'),b=h.add('b');const valid=[];a.find={beforeFrame(){},afterFrame:fn=>valid.push(['a',fn])};b.find={beforeFrame(){},afterFrame:fn=>valid.push(['b',fn])};
 actual('fitTerminalViews',h.args)();h.refs.zoomedPaneIdRef.current='p-0';assert.equal(valid.find(([id])=>id==='a')[1](),true);assert.equal(valid.find(([id])=>id==='b')[1](),false);
});

test('B03b actual App old resize JSX callback cannot commit after zoom and restore before React rerender',()=>{
 const h=harness(['a','b']);const original=h.refs.terminalLayoutRef.current;
 const commit=actual('commitTerminalNodeSplit',h.args);const old=actualComponentProp('TerminalLayout','onNodeSplitChange',{commitTerminalNodeSplit:commit,paneZoomGeneration:h.args.terminalPaneZoomIntent.current});
 actual('toggleTerminalPaneZoom',h.args)();actual('toggleTerminalPaneZoom',h.args)();old('n-0',70);assert.equal(h.refs.terminalLayoutRef.current,original);assert.equal(h.refs.terminalLayoutRef.current.root,undefined,'cancelled preview cannot create a persisted ratio tree');
});

test('B03b late old resize cancel cannot erase a fresh drag after zoom restore',()=>{
 const f=resizeFixture(),old=f.separator();old.props.onPointerDown(f.event());old.props.onPointerMove(f.event());assert.equal(f.previews.at(-1),70);
 const props={layout:f.layout,labels:[],splitPercent:50,swapDisabled:false,onMode(){},onFocus(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview:v=>f.previews.push(v),onSwap(){},onCancelFit:()=>f.cancelled.push(true),onNodeSplitChange:(...a)=>f.changes.push(a)};
 const zoom=f.tree.rerender({...props,zoomedPaneId:'p-0',zoomRevision:1});const restored=zoom.rerender({...props,zoomedPaneId:null,zoomRevision:2});assert.equal(f.previews.at(-1),50);assert.deepEqual(f.changes,[]);
 const fresh=nodes(restored,n=>n.props?.['data-node-id']===f.innerId)[0];fresh.props.onPointerDown(f.event());fresh.props.onPointerMove(f.event(7,563));assert.equal(f.previews.at(-1),60);
 old.props.onPointerCancel(f.event());assert.equal(f.previews.at(-1),60,'old cancellation may not reset the fresh preview');old.props.onPointerMove(f.event());assert.equal(f.previews.at(-1),60,'old movement may not change the fresh preview');old.props.onPointerUp(f.event());assert.deepEqual(f.changes,[],'old up may not commit or consume the fresh drag');fresh.props.onPointerUp(f.event(7,563));assert.deepEqual(f.changes,[[f.innerId,60]]);assert.equal(props.layout.root.first.ratio,50,'fixture does not save a preview');
});
test('B03b old App preview and cancel JSX callbacks cannot replace the fresh fit after zoom restore',()=>{
 const h=harness(['a','b']);const preview=actual('previewTerminalSplit',h.args),cancel=actual('cancelTerminalLayoutFit',h.args);
 const oldPreview=actualComponentProp('TerminalLayout','onSplitPreview',{previewTerminalSplit:preview,paneZoomGeneration:0});const oldCancel=actualComponentProp('TerminalLayout','onCancelFit',{cancelTerminalLayoutFit:cancel,paneZoomGeneration:0});
 oldPreview(70);const original=h.refs.terminalLayoutRef.current;actual('toggleTerminalPaneZoom',h.args)();actual('toggleTerminalPaneZoom',h.args)();const intent=h.args.terminalLayoutFitIntent.current,frame=h.args.terminalLayoutFitFrame.current;
 oldCancel();oldPreview(50);assert.equal(h.args.terminalLayoutFitIntent.current,intent);assert.equal(h.args.terminalLayoutFitFrame.current,frame);assert.equal(h.refs.terminalLayoutRef.current,original);
});

// B02c real App token callbacks; fallback exposes the legacy direct move semantics for RED.
function dragHarness(){
 const h=harness(['a','c']);h.refs.terminalLayoutRef.current=layoutOperations.assignTerminalPane(h.refs.terminalLayoutRef.current,0,'b');
 for(const id of ['a','b','c'])Object.assign(h.add(id),{ready:true,writable:true,cursor:10});
 h.args.terminalTabDrag={current:null};h.args.moveTerminalSession=actual('moveTerminalSession',h.args);
 const begin=actualWithLegacy('beginTerminalTabDrag',h.args,'function beginTerminalTabDrag(id,paneId){const token={id,paneId};terminalTabDrag.current=token;return token}');
 const drop=actualWithLegacy('commitTerminalTabDrag',h.args,'function commitTerminalTabDrag(token,paneId,before){moveTerminalSession(token.id,terminalPaneIndex(terminalLayoutRef.current,paneId))}');
 return {...h,begin,drop};
}
test('B02c actual App same pane drop reorders without changing active selection or form focus',()=>{
 const h=dragHarness(),layout=h.refs.terminalLayoutRef.current,form=h.document.activeElement;
 const token=h.begin('b',layoutOperations.terminalPaneId(layout,0));h.drop(token,layoutOperations.terminalPaneId(layout,0),'a');
 assert.deepEqual(layoutOperations.terminalTabs(layoutOperations.terminalLeaves(layoutOperations.terminalLayoutRoot(h.refs.terminalLayoutRef.current))[0]),['b','a']);
 assert.equal(h.refs.terminalLayoutRef.current.panes[0],'b');assert.equal(h.document.activeElement,form);assert.deepEqual(h.calls,[]);
});
for(const stale of ['owner','revision','zoom','forged'])test(`B02c actual App ${stale} token cannot mutate layout or focus`,()=>{
 const h=dragHarness(),layout=h.refs.terminalLayoutRef.current,form=h.document.activeElement;let token=h.begin('a',layoutOperations.terminalPaneId(layout,0));
 if(stale==='owner')h.refs.ownerConnectionAvailable.current.version++;
 if(stale==='revision')h.refs.terminalLayoutRef.current={...layout,revision:layout.revision+1};
 if(stale==='zoom')h.refs.terminalPaneZoomIntent.current++;
 if(stale==='forged')token={...token};
 const before=h.refs.terminalLayoutRef.current;h.drop(token,layoutOperations.terminalPaneId(layout,1),null);
 assert.equal(h.refs.terminalLayoutRef.current,before);assert.equal(h.document.activeElement,form);assert.deepEqual(h.calls,[]);
});

test('B02c actual App cross pane drop preserves instance and inserts before stable member once',()=>{
 const h=dragHarness(),layout=h.refs.terminalLayoutRef.current,view=h.refs.terminalViews.current.get('a');
 const token=h.begin('a',layoutOperations.terminalPaneId(layout,0)),target=layoutOperations.terminalPaneId(layout,1);
 h.drop(token,target,'c');const next=h.refs.terminalLayoutRef.current;h.drop(token,target,null);
 assert.equal(h.refs.terminalLayoutRef.current,next);assert.equal(next.panes[1],'a');assert.equal(next.panes[0],'b');
 assert.deepEqual(layoutOperations.terminalTabs(layoutOperations.terminalLeaves(layoutOperations.terminalLayoutRoot(next))[1]),['a','c']);
 assert.equal(h.refs.terminalViews.current.get('a'),view);assert.equal(view.disposed,false);assert.equal(h.refs.sessionId.current,'a');
 assert.deepEqual(h.calls.filter(call=>['create_session','stop_session','read_terminal_frame'].includes(call.name)),[]);
});
test('B02c actual App invalid target member and cancelled token leave the layout untouched',()=>{
 const h=dragHarness(),layout=h.refs.terminalLayoutRef.current,target=layoutOperations.terminalPaneId(layout,1);
 let token=h.begin('a',layoutOperations.terminalPaneId(layout,0));h.drop(token,target,'missing');assert.equal(h.refs.terminalLayoutRef.current,layout);
 token=h.begin('a',layoutOperations.terminalPaneId(layout,0));actualWithLegacy('cancelTerminalTabDrag',h.args,'function cancelTerminalTabDrag(token){terminalTabDrag.current=null}')(token);h.drop(token,target,null);
 assert.equal(h.refs.terminalLayoutRef.current,layout);assert.deepEqual(h.calls,[]);
});
test('B02c actual App keyboard order menu preserves active and boundary no-op',()=>{
 const h=dragHarness(),layout=h.refs.terminalLayoutRef.current;
 const reorder=actualWithLegacy('reorderTerminalSession',h.args,'function reorderTerminalSession(){}');reorder('b','left');
 const next=h.refs.terminalLayoutRef.current;assert.deepEqual(layoutOperations.terminalTabs(layoutOperations.terminalLeaves(layoutOperations.terminalLayoutRoot(next))[0]),['b','a']);assert.equal(next.panes[0],'b');
 reorder('b','left');assert.equal(h.refs.terminalLayoutRef.current,next);reorder('b','right');assert.deepEqual(layoutOperations.terminalTabs(layoutOperations.terminalLeaves(layoutOperations.terminalLayoutRoot(h.refs.terminalLayoutRef.current))[0]),['a','b']);
});

test('B02d actual App left edge drop splits target and moves member in one revision',()=>{
 const h=dragHarness(),old=h.refs.terminalLayoutRef.current,target=layoutOperations.terminalPaneId(old,1),source=layoutOperations.terminalPaneId(old,0),token=h.begin('a',source);
 h.drop(token,target,null,'left');const next=h.refs.terminalLayoutRef.current;
 assert.equal(next.panes.length,3,'edge drop creates one new leaf instead of moving into existing pane');assert.equal(next.revision,old.revision+1);assert.equal(next.panes[next.focused],'a');
 const leaves=layoutOperations.terminalLeaves(next.root);assert.equal(leaves[1].sessionId,'a');assert.equal(leaves[2].paneId,target);assert.equal(next.panes[0],'b');
});

function edgeAppHarness(){
 const h=harness(['s-a-1','s-c-3']);h.refs.terminalLayoutRef.current=layoutOperations.assignTerminalPane(h.refs.terminalLayoutRef.current,0,'s-b-2');for(const id of ['s-a-1','s-b-2','s-c-3'])Object.assign(h.add(id),{ready:true,writable:true,cursor:10});h.args.terminalTabDrag={current:null};
 const mutations=[];h.args.setTerminalLayout=next=>{h.refs.terminalLayoutRef.current=next;mutations.push(next);};h.args.moveTerminalSession=actual('moveTerminalSession',h.args);
 return {...h,mutations,begin:actual('beginTerminalTabDrag',h.args),drop:actual('commitTerminalTabDrag',h.args)};
}
for(const edge of ['left','right','top','bottom'])test(`B02d actual App ${edge} commits once and retains input/view/parser without process operations`,()=>{
 const h=edgeAppHarness(),old=h.refs.terminalLayoutRef.current,view=h.refs.terminalViews.current.get('s-a-1'),cursor=view.cursor,instance=view.instance;
 const token=h.begin('s-a-1','p-0');h.drop(token,'p-1',null,edge);h.drop(token,'p-1',null,edge);const newId=layoutOperations.terminalPaneId(h.refs.terminalLayoutRef.current,h.refs.terminalLayoutRef.current.focused),host={append(element){element.parentElement=this;}};actual('mountTerminalPane',h.args)(newId,host);[...h.raf].forEach(fn=>fn());assert.equal(h.mutations.length,1);assert.equal(h.refs.terminalLayoutRef.current.revision,old.revision+1);assert.equal(h.refs.sessionId.current,'s-a-1');assert.equal(h.document.activeElement,instance.textarea);assert.equal(view.instance,instance);assert.equal(view.cursor,cursor);assert.equal(view.disposed,false);assert.equal(h.refs.terminalViews.current.get('s-a-1'),view);assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session','write_session','read_terminal_frame'].includes(c.name)),[]);
});
for(const reason of ['edge','target','member','view','budget','before','owner','revision','zoom','cancel'])test(`B02d refused ${reason} edge leaves tree focus zoom and storage unchanged`,()=>{
 const h=edgeAppHarness();h.args.zoomedPaneIdRef.current='p-0';let target='p-0',edge='left',before=null;
 if(reason==='budget'){let state=h.refs.terminalLayoutRef.current;for(let i=state.panes.length;i<16;i++)state=layoutOperations.splitTerminalPane(state,'horizontal');h.refs.terminalLayoutRef.current={...state,focused:0};}
 const token=h.begin('s-a-1','p-0');assert.ok(token);if(reason==='edge')edge='invalid';if(reason==='target')target='missing';if(reason==='before')before='s-b-2';if(reason==='member')h.refs.terminalLayoutRef.current=layoutOperations.removeTerminalTab(h.refs.terminalLayoutRef.current,0,'s-a-1');if(reason==='view')h.refs.terminalViews.current.retain(view=>view.record.summary.session_id!=='s-a-1');if(reason==='owner')h.refs.ownerConnectionAvailable.current.version++;if(reason==='revision')h.refs.terminalLayoutRef.current={...h.refs.terminalLayoutRef.current,revision:h.refs.terminalLayoutRef.current.revision+1};if(reason==='zoom')h.args.terminalPaneZoomIntent.current++;if(reason==='cancel')actual('cancelTerminalTabDrag',h.args)(token);
 const old=h.refs.terminalLayoutRef.current,focus=h.document.activeElement;h.drop(token,target,before,edge);assert.equal(h.refs.terminalLayoutRef.current,old);assert.equal(h.mutations.length,0);assert.equal(h.args.zoomedPaneIdRef.current,'p-0');assert.equal(h.document.activeElement,focus);assert.deepEqual(h.calls,[]);
});
test('B02d actual zoom edge computes full tree result first, then restores and focuses new pane with one saved v4',async()=>{
 const h=edgeAppHarness(),old=h.refs.terminalLayoutRef.current,saved=[];h.args.zoomedPaneIdRef.current='p-0';let effect;function find(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='useEffect'&&n.arguments[0]?.getText(source).includes('saveTerminalLayout(terminalLayout'))effect=n.arguments[0].getText(source);ts.forEachChild(n,find);}find(source);const persistence=await import('../src/terminal-layout-persistence.ts');
 h.args.setTerminalLayout=next=>{h.mutations.push(next);h.refs.terminalLayoutRef.current=next;callback(effect,{...h.args,...persistence,terminalLayout:next,layoutRestoreReady:true,splitPercent:50,localStorage:{setItem:(key,value)=>saved.push(JSON.parse(value))}})();};const drop=actual('commitTerminalTabDrag',h.args),token=h.begin('s-a-1','p-0');drop(token,'p-0',null,'top');
 const next=h.refs.terminalLayoutRef.current;const host={append(element){element.parentElement=this;}};actual('mountTerminalPane',h.args)(layoutOperations.terminalPaneId(next,next.focused),host);[...h.raf].forEach(fn=>fn());assert.equal(saved.length,1);assert.equal(saved[0].version,5);assert.equal(next.panes.length,3);assert.equal(h.args.zoomedPaneIdRef.current,null);assert.equal(h.refs.sessionId.current,'s-a-1');assert.equal(h.document.activeElement,h.refs.terminal.current.textarea);assert.equal(next.root.second,old.root.second,'target split preserves distant leaf reference through shared member transform');assert.deepEqual(layoutOperations.terminalMembers(next).sort(),layoutOperations.terminalMembers(old).sort());
});

test('B02d pending edge handoff rejects late source reply, completes same view in new stable pane and keeps later form focus',async()=>{
 const pending=[];const h=harness(['s-a-1','s-c-3'],(name,args)=>name==='read_terminal_frame'&&args.sessionId==='s-a-1'?new Promise(resolve=>pending.push(resolve)):name==='read_terminal_frame'?frame(args.sessionId):null);h.args.terminalTabDrag={current:null};h.args.moveTerminalSession=actual('moveTerminalSession',h.args);
 const old=h.open(record('s-a-1'),false,0);await turn();const view=h.refs.terminalViews.current.get('s-a-1');const token=actual('beginTerminalTabDrag',h.args)('s-a-1','p-0');actual('commitTerminalTabDrag',h.args)(token,'p-1',null,'top');await turn();assert.equal(pending.length,2);
 const form={name:'later form'};h.document.activeElement=form;pending[0](frame('s-a-1',1));await old;assert.equal(view.ready,false);pending[1](frame('s-a-1',2));await turn();await turn();assert.equal(view.ready,true);assert.equal(view.frameRevision,2);assert.equal(h.document.activeElement,form);assert.equal(h.refs.terminalViews.current.get('s-a-1'),view);assert.equal(h.refs.sessionId.current,'s-a-1');assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session'].includes(c.name)),[]);
});
for(const stale of ['owner','layout','zoom','form'])test(`B02d deferred new-pane input focus refuses stale ${stale} before host mount`,()=>{
 const h=edgeAppHarness(),token=h.begin('s-a-1','p-0'),origin=h.document.activeElement;h.drop(token,'p-1',null,'right');const next=h.refs.terminalLayoutRef.current,newId=layoutOperations.terminalPaneId(next,next.focused),host={append(element){element.parentElement=this;}};actual('mountTerminalPane',h.args)(newId,host);
 if(stale==='owner')h.refs.ownerConnectionAvailable.current.version++;if(stale==='layout')h.refs.terminalLayoutRef.current={...next,revision:next.revision+1};if(stale==='zoom')h.args.terminalPaneZoomIntent.current++;if(stale==='form')h.document.activeElement={name:'later form'};
 const focused=h.document.activeElement;[...h.raf].forEach(fn=>fn());assert.equal(h.document.activeElement,focused);if(stale!=='form')assert.equal(focused,origin);
});

test('B02d late new-pane host mount after first RAF still consumes pending input focus exactly once',()=>{
 const h=edgeAppHarness(),token=h.begin('s-a-1','p-0'),origin=h.document.activeElement;h.drop(token,'p-1',null,'left');const next=h.refs.terminalLayoutRef.current,newId=layoutOperations.terminalPaneId(next,next.focused);
 [...h.raf].forEach(fn=>fn());h.raf.length=0;assert.equal(h.document.activeElement,origin);
 const host={append(element){element.parentElement=this;}};actual('mountTerminalPane',h.args)(newId,host);[...h.raf].forEach(fn=>fn());assert.equal(h.document.activeElement,h.refs.terminalViews.current.get('s-a-1').instance.textarea,'mount must replay one pending focus intent rather than lose it at first RAF');
 const form={name:'user form'};h.document.activeElement=form;h.raf.length=0;actual('mountTerminalPane',h.args)(newId,host);[...h.raf].forEach(fn=>fn());assert.equal(h.document.activeElement,form,'consumed intent cannot steal later form focus');
});

test('Reopen actual toolbar remains reachable with last empty tab and guards disabled activation',()=>{const props={layout:{mode:'single',panes:[null],focused:0,revision:0},labels:[null],splitPercent:50,swapDisabled:false,onHost(){},onFocus(){},onClose(){},onMode(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){}};let calls=0;let tree=layoutTree({...props,onReopen:()=>calls++});let button=nodes(tree,n=>n.type==='button'&&n.props['aria-label']==='Reopen last hidden tab')[0];assert.ok(button);assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(calls,0);tree=layoutTree({...props,canReopen:true,onReopen:()=>calls++});button=nodes(tree,n=>n.type==='button'&&n.props['aria-label']==='Reopen last hidden tab')[0];assert.equal(button.props.disabled,false);button.props.onClick();assert.equal(calls,1);});

for(const state of ['ready','hidden','unmounted','form','owner'])test(`window surface restoration handles ${state} without task creation or focus theft`,()=>{
 const h=harness(['s-a-1']),view=h.add('s-a-1');let fits=0;
 Object.assign(view,{ready:true,projection:true,writable:false});view.fit.fit=()=>fits++;
 h.args.terminalTabFocus={current:null};h.document.activeElement=h.document.body;h.document.hidden=state==='hidden';h.document.hasFocus=()=>true;
 h.args.paneHosts.current.set('p-0',{append(element){element.parentElement=this;}});
 if(state==='unmounted')h.args.terminalMounted.current=false;
 if(state==='owner')h.refs.ownerConnectionAvailable.current.available=false;
 if(state==='form')h.document.activeElement={name:'settings input'};
 const origin=h.document.activeElement;actual('restoreTerminalSurface',h.args)();
 while(h.raf.length)h.raf.shift()();
 if(['hidden','unmounted','owner'].includes(state))assert.equal(fits,0);
 else assert.equal(fits,1,'a newly visible surface must fit its current pane');
 if(state==='ready')assert.equal(h.document.activeElement,view.instance.textarea);
 else assert.equal(h.document.activeElement,origin);
 assert.deepEqual(h.calls.filter(c=>['create_session','stop_session','resume_session','write_session'].includes(c.name)),[]);
});
test('surface restoration hooks are removed together on unmount',()=>{
 const text=source.getFullText();
 for(const [target,event]of [['window','focus'],['document','visibilitychange']]){
  assert.ok(text.includes(`${target}.addEventListener("${event}",surfaceChanged)`));
  assert.ok(text.includes(`${target}.removeEventListener("${event}",surfaceChanged)`));
 }
});

test('tab double-click edits its own title, Enter saves, Esc cancels, failed save retains input',async()=>{
 const layout=layoutOperations.assignTerminalPane(layoutOperations.createTerminalLayout(),0,'s-tab-1');
 const calls=[];let fail=false;const props={layout,labels:['Before'],tabLabel:()=> 'Before',onRenameTab:async(id,title)=>{if(fail)throw Error('storage');calls.push([id,title]);},onDuplicateTab:id=>calls.push(['copy',id]),onFocus(){},onHost(){},splitPercent:50,swapDisabled:false};
 let tree=layoutTree(props);let tab=nodes(tree,n=>n.props?.role==='tab')[0];assert.equal(typeof tab.props.onDoubleClick,'function');
 tab.props.onDoubleClick({preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);let input=nodes(tree,n=>n.type==='input'&&n.props['aria-label']==='Session name')[0];assert.ok(input);
 input.props.onChange({target:{value:'After'}});tree=tree.rerender(props);input=nodes(tree,n=>n.type==='input')[0];await input.props.onKeyDown({key:'Enter',preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);assert.deepEqual(calls,[['s-tab-1','After']]);assert.equal(nodes(tree,n=>n.type==='input').length,0);
 nodes(tree,n=>n.props?.role==='tab')[0].props.onDoubleClick({preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);await nodes(tree,n=>n.type==='input')[0].props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);assert.equal(nodes(tree,n=>n.type==='input').length,0);assert.equal(calls.length,1);
 nodes(tree,n=>n.props?.role==='tab')[0].props.onDoubleClick({preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);fail=true;await nodes(tree,n=>n.type==='input')[0].props.onKeyDown({key:'Enter',preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);assert.equal(nodes(tree,n=>n.type==='input').length,1);assert.equal(nodes(tree,n=>n.props?.role==='alert').length,1);const strip=nodes(tree,n=>n.props?.role==='tablist')[0];assert.equal(nodes(strip,n=>n.props?.role==='alert').length,0,'error stays outside the clipped tab strip');
});

test('inline rename leaves Enter and Escape to IME composition before saving the committed name',async()=>{
 const layout=layoutOperations.assignTerminalPane(layoutOperations.createTerminalLayout(),0,'s-ime-1'),calls=[];
 const props={layout,labels:['Before'],tabLabel:()=> 'Before',onRenameTab:async(id,title)=>calls.push([id,title]),onFocus(){},onHost(){},splitPercent:50,swapDisabled:false};
 let tree=layoutTree(props);nodes(tree,n=>n.props?.role==='tab')[0].props.onDoubleClick({preventDefault(){},stopPropagation(){}});tree=tree.rerender(props);
 let input=nodes(tree,n=>n.type==='input')[0];input.props.onChange({target:{value:'中文名称'}});tree=tree.rerender(props);input=nodes(tree,n=>n.type==='input')[0];
 for(const key of ['Enter','Escape'])for(const flags of [{nativeEvent:{isComposing:true}},{nativeEvent:{isComposing:false},keyCode:229}]){
  await input.props.onKeyDown({key,...flags,stopPropagation(){},preventDefault:()=>assert.fail('composition must retain its key')});tree=tree.rerender(props);input=nodes(tree,n=>n.type==='input')[0];assert.ok(input);assert.equal(input.props.value,'中文名称');assert.deepEqual(calls,[]);
 }
 assert.equal(typeof input.props.onCompositionStart,'function');input.props.onCompositionStart();
 for(const key of ['Enter','Escape'])await input.props.onKeyDown({key,nativeEvent:{isComposing:false},keyCode:13,stopPropagation(){},preventDefault:()=>assert.fail('active composition must retain its key')});
 input.props.onCompositionEnd();await input.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},keyCode:13,stopPropagation(){},preventDefault(){}});tree=tree.rerender(props);assert.deepEqual(calls,[['s-ime-1','中文名称']]);assert.equal(nodes(tree,n=>n.type==='input').length,0);
});

 test('native CLI exit input is forwarded unchanged and never creates a process',async()=>{
 const h=harness();const view=h.add('a');Object.assign(view,{ready:true,cursor:10,projection:true});h.document.activeElement=view.instance.textarea;
 const handler=callback(input,{...h.args,view,id:'a'});
 for(const data of ['\x03','\x04','/exit\r']){handler(data);await turn();}
 assert.deepEqual(h.calls.filter(v=>v.name==='write_session').map(v=>v.data),['\x03','\x04','/exit\r']);
 assert.equal(h.calls.some(v=>v.name==='create_session'),false);
 });
