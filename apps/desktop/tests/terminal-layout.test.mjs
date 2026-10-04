// Author: Jeff.Liu. Actual App callbacks with deterministic terminal/IPC fixtures; not native GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {TerminalViews} from '../src/terminal-views.ts';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
import {queueTerminalResize} from '../src/terminal-settings.ts';
import {assignTerminalPane,removeTerminalPane,changeTerminalLayout,isTerminalProtocolResponse} from '../src/terminal-layout.ts';
import * as layoutOperations from '../src/terminal-layout.ts';

const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const layoutCss=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
const functions=new Map();let input,timer,notificationEffect;
function visit(node){
 if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(source));
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='onData')input=node.initializer.arguments[0].getText(source);
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='frameTimer')timer=node.initializer.arguments[0].getText(source);
 if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&(node.arguments[0]?.getText(source).includes('set_agent_notification_context')||(node.arguments[0]?.getText(source).includes('syncNotificationContext()')&&node.arguments[1]?.getText(source).includes('notificationsPaused'))))notificationEffect=node.arguments[0].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);
const transpile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function actual(name,args){
 assert.ok(functions.has(name),`Actual App ${name} callback is required`);
 const dependencies=['cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes'];
 const text=[...new Set(dependencies.filter(n=>functions.has(n)).concat(name))].map(n=>functions.get(n)).join('\n');
 return new Function(...Object.keys(args),transpile(text)+`;return ${name}`)(...Object.values(args));
}
function callback(text,args){assert.ok(text,'Actual App callback is required');const deps=['cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes'].filter(n=>functions.has(n)).map(n=>functions.get(n)).join('\n');return new Function(...Object.keys(args),transpile(deps+`\nconst callback=${text}`)+';return callback')(...Object.values(args));}
function actualWithLegacy(name,args,legacy){
 const dependencies=['cancelLayoutRestore','finishLayoutRestore','syncViewSize','fitTerminalViews','terminalPaneVisible','terminalPaneHasSize','terminalHasInputFocus','syncNotificationContext','showTerminalLayout','focusTerminalPane','pollTerminalFrames','renderFrame','requestTerminalLayoutFit','cancelTerminalLayoutFit','canSwapTerminalPanes'].filter(n=>functions.has(n)).map(n=>functions.get(n)).join('\n');
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
 const refs={ownerConnectionAvailable:{current:{available:true,version:0}},terminalLayoutRef:{current:layout},terminalLayoutFitFrame:{current:null},terminalLayoutFitIntent:{current:0},layoutRestore:{current:{version:0,pending:false,adoptable:false,queued:false}},layoutVersion:{current:0},detailVersion:{current:0},selectionVersion:{current:0},creatingSession:{current:false},previousSession:{current:null},sessionId:{current:ids[0]},selectedRecord:{current:record(ids[0])},terminalViews:{current:new TerminalViews(16)},terminal:{current:null},fitAddon:{current:null},outputCursor:{current:null},agentOutputWindow:{current:''},pendingState:{current:new Map()},pendingOutput:{current:{drain:()=>[],delete(){},clear(){}}}};
 const document={hidden:false,activeElement:{name:'form'},body:{},hasFocus:()=>true};
 const make=id=>{
  const textarea={id},element={dataset:{sessionId:id},style:{},inert:false,contains:node=>node===textarea,getBoundingClientRect:()=>({width:600,height:400})};
  const instance={_core:{_inputHandler:{_activeBuffer:{x:0}}},cols:100,rows:40,textarea,hasSelection:()=>false,reset(){},resize(cols,rows){this.cols=cols;this.rows=rows;},scrollToLine(){},write(data,done){writes.push({id,data});done?.()},focus(){document.activeElement=textarea;}};
  return {record:record(id),element,instance,fit:{fit(){}},cursor:null,ready:false,writable:false,firstAttachment:false,replayVersion:0,parsing:null,finishReplay:null,live:true,status:'running',projection:false,frameInstance:null,frameRevision:-1,lifecycleRevision:0,viewportRevision:0,dirty:true,updating:false,selecting:false,projecting:false,persisted:false,disposed:false,resizing:false,resizePending:null,dispose(){this.disposed=true;}};
 };
 const args={setRecoveryRevision(){},layoutRestore:{current:{version:0,pending:false,adoptable:false,queued:false}},setLayoutRestoreReady(){},layoutPreferenceLoad:{present:false,splitPercent:50,layout:{mode:"single",panes:[null],focused:0,revision:0},warning:null},splitPercent:50,setSplitPercent(){},...refs,document,window:{},active:true,paneHosts:{current:new Map()},terminalHost:{current:null},pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},assignTerminalPane,removeTerminalPane,changeTerminalLayout,swapTerminalPanes:layoutOperations.swapTerminalPanes,isTerminalProtocolResponse,queueTerminalResize,applyTerminalFrame,validateTerminalFrame,invoke:async(name,args)=>{calls.push({name,...args});return invoke(name,args);},createTerminalView:make,setTerminalLayout(next){refs.terminalLayoutRef.current=typeof next==='function'?next(refs.terminalLayoutRef.current):next;},setSession(){},setActiveProject(){},setSessionStatus(){},setSelectedAgent(){},setTerminalNotice(){},setAgentPhase(){},updateAgentPhase(){},setError:reason=>errors.push(reason),terminalStatuses:new Set(['succeeded','failed','stopped','needs_attention']),replayOutput:s=>({data:s.data??'',nextOffset:s.end_offset??0}),requestAnimationFrame:fn=>raf.push(fn),cancelAnimationFrame(){},applyStateEvent(){}};
 return {refs,args,document,calls,errors,writes,raf,make,open:actual('openHistory',args),add(id){return refs.terminalViews.current.open(id,true,()=>make(id));}};
}

test('T14 actual App independently loads two visible panes without hiding or cancelling the first',async()=>{
 const pending=new Map();const h=harness(['a','b'],(name,args)=>name==='read_terminal_frame'?new Promise(resolve=>pending.set(args.sessionId,resolve)):null);
 const a=h.open(record('a'),false,0),b=h.open(record('b'),false,1);
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
 const args={setRecoveryRevision(){},...h.args,pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},retryNotifications:{current:new Map()},notifications:{current:{canRetry:()=>true,suppress:k=>suppressed.push(k),clearFailure(){},deliver:async(k,send)=>{delivered.push(k);await send();return true},recordFailure:()=>''}},titlesRef:{current:{}},discardAttentionRetries:()=>[],setNotificationError(){},projectName:()=> 'Fixture',statusLabels:{succeeded:'Done'}};
 await actual('notifySession',args)({session_id:'a',status:'succeeded'});
 assert.deepEqual(suppressed,[]);assert.deepEqual(delivered,['a:succeeded']);
});
test('T14 actual App notification context sends null when terminal does not own DOM focus',async()=>{
 const h=harness();const args={setRecoveryRevision(){},...h.args,session:{session_id:'a'},notificationsPaused:false,localStorage:{setItem(){}}};
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
test('F2 four-pane component offers accessible focused-to-target swaps without a divider',()=>{
 const targets=[],tree=layoutTree({layout:{mode:'grid',panes:['a','b','c','d'],focused:1,revision:0},labels:['A','B','C','D'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap:target=>targets.push(target),swapDisabled:false,onCancelFit(){}});
 const swaps=nodes(tree,n=>n.type==='button'&&n.props?.['aria-label']?.startsWith('Swap focused pane'));
 assert.deepEqual(swaps.map(button=>button.props['aria-label']),['Swap focused pane with pane 1','Swap focused pane with pane 3','Swap focused pane with pane 4']);
 assert.equal(nodes(tree,n=>n.props?.role==='separator').length,0,'grid keeps its fixed geometry');swaps.forEach(button=>button.props.onClick());assert.deepEqual(targets,[0,2,3]);
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
 const first=h.open(record('a'),false,0),second=h.open(record('b'),false,0),third=h.open(record('a'),false,0);
 pending[0].resolve(frame('a',1));pending[1].reject(Error('old B'));pending[2].resolve(frame('a',3));await Promise.all([first,second,third]);
 assert.deepEqual(h.writes.map(v=>v.data),['a:中文:3']);assert.deepEqual(h.errors,[]);assert.equal(h.refs.sessionId.current,'a');
 const duplicate=h.open(record('a'),false,1);pending[3].resolve(frame('a',3));await duplicate;
 assert.equal(h.refs.terminalLayoutRef.current.panes.filter(id=>id==='a').length,1);
 const loading=h.open(record('b'),false,1);actual('closeTerminalPane',h.args)(1);pending[4].resolve(frame('b',4));await loading;
 assert.equal(h.refs.terminalLayoutRef.current.panes[1],null);assert.equal(h.refs.terminalViews.current.get('b').ready,false);assert.deepEqual(h.errors,[]);
});
test('F2 actual App keeps swap busy through attachment and clears the current attachment',async()=>{
 let release;const h=harness(['a','b'],name=>name==='read_terminal_frame'?new Promise(resolve=>release=resolve):null);
 const attaching=h.open(record('a'),false,0),view=h.refs.terminalViews.current.get('a');
 assert.equal(view.attaching,true,'openHistory publishes attachment readiness before its owner read');
 release(frame('a'));await attaching;assert.equal(view.attaching,false);
});
test('F2 an old attachment finally cannot clear a newer attachment busy state',async()=>{
 const pending=[];const h=harness(['a','b'],name=>name==='read_terminal_frame'?new Promise(resolve=>pending.push(resolve)):null);
 const old=h.open(record('a'),false,0),view=h.refs.terminalViews.current.get('a');
 const current=h.open(record('a'),false,0);assert.equal(pending.length,2);
 pending[0](frame('a',1));await old;assert.equal(view.attaching,true,'old attachVersion must not clear the replacement');
 pending[1](frame('a',2));await current;assert.equal(view.attaching,false);
});
test('T14 actual App changed owner while polling drops its old instance response',async()=>{
 let release;const h=harness(['a','b'],()=>new Promise(resolve=>release=resolve));const view=h.add('a');Object.assign(view,{projection:true,ready:true,cursor:10,frameInstance:'a'.repeat(64)});
 callback(timer,h.args)();view.frameInstance='b'.repeat(64);view.lifecycleRevision++;view.status='stopped';view.live=false;
 release(frame('a',4));await turn();await turn();assert.equal(view.frameInstance,'b'.repeat(64));assert.equal(view.frameRevision,-1);assert.equal(view.status,'stopped');assert.deepEqual(h.writes,[]);
});
function layoutTree(props,hookState={states:[],refs:[]}){
 const file=ts.createSourceFile('TerminalLayout.tsx',readFileSync(new URL('../src/TerminalLayout.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TerminalLayout');assert.ok(declaration);
 const js=ts.transpileModule(declaration.getText(file).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 let stateIndex=0,refIndex=0;const cleanups=[];
 const useState=value=>{const index=stateIndex++;if(!(index in hookState.states))hookState.states[index]=typeof value==='function'?value():value;return [hookState.states[index],next=>{hookState.states[index]=typeof next==='function'?next(hookState.states[index]):next;}];};
 const useRef=current=>{const index=refIndex++;if(!(index in hookState.refs))hookState.refs[index]={current};return hookState.refs[index];};
 const useEffect=effect=>{const cleanup=effect();if(typeof cleanup==='function')cleanups.push(cleanup);};
 const tree=new Function('React','useState','useRef','useEffect','clampSplitPercent',js+';return TerminalLayout')(React,useState,useRef,useEffect,layoutOperations.clampSplitPercent)(props);
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
test('F2 actual component exposes an accessible draggable separator only for two-pane modes',()=>{
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
 assert.deepEqual(preview,[80]);separator.props.onPointerCancel({pointerId:7,currentTarget});
 assert.deepEqual(commits,[],'cancel never persists a preview');assert.deepEqual(preview,[80,50]);assert.ok(fits.length>=2);assert.deepEqual(capture,[7,-7]);
 separator.props.onPointerDown({pointerId:9,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:9,clientX:220,clientY:20,currentTarget});separator.props.onLostPointerCapture({pointerId:9,currentTarget});
 assert.deepEqual(commits,[],'lost capture also discards an uncommitted preview');assert.equal(preview.at(-1),50);
 separator.props.onPointerDown({pointerId:8,button:0,clientX:310,clientY:20,currentTarget,preventDefault(){}});
 separator.props.onPointerMove({pointerId:8,clientX:190,clientY:20,currentTarget});separator.props.onPointerUp({pointerId:8,clientX:190,clientY:20,currentTarget});
 separator.props.onKeyDown({key:'ArrowRight',preventDefault(){}});separator.props.onKeyDown({key:'Home',preventDefault(){}});separator.props.onKeyDown({key:'End',preventDefault(){}});reset.props.onClick();
 assert.deepEqual(commits,[30,55,20,80,50]);
 const vertical=layoutTree({layout:{mode:'vertical',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onFit(){}});
 assert.equal(nodes(vertical,n=>n.props?.role==='separator')[0].props['aria-orientation'],'horizontal');
 assert.deepEqual(calls,[]);
 let cleanupCount=0;const mounted=layoutTree({layout:{mode:'horizontal',panes:['a','b'],focused:0,revision:0},labels:['A','B'],splitPercent:50,onFocus(){},onMode(){},onClose(){},onHost(){},onSplitChange(){},onSplitPreview(){},onSwap(){},swapDisabled:false,onCancelFit(){cleanupCount++;}});mounted.cleanups.forEach(cleanup=>cleanup());assert.equal(cleanupCount,1,'unmount cancels a queued geometry fit');
});
test('F2 App fit scheduling coalesces frames and cancels stale mode intents',()=>{
 let next=0,fits=0;const scheduled=new Map(),cancelled=[],layout={mode:'horizontal',panes:['a','b'],focused:0,revision:1};
 const view={element:{dataset:{sessionId:'a'},getBoundingClientRect:()=>({width:600,height:400})},fit:{fit(){fits++;}},viewportRevision:0,resizePending:null,live:false,ready:false,writable:false,cursor:null,disposed:false};
 const args={terminalLayoutFitFrame:{current:null},terminalLayoutFitIntent:{current:0},terminalLayoutRef:{current:layout},terminalMounted:{current:true},terminalViews:{current:{all:[view]}},requestAnimationFrame:callback=>{const id=++next;scheduled.set(id,callback);return id;},cancelAnimationFrame:id=>{cancelled.push(id);scheduled.delete(id);}};
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
 const args={setRecoveryRevision(){},...h.args,pausedRef:{current:false},notificationContextVersion:{current:0},notificationContextFlight:{current:{sending:false,pending:null}},terminalMounted:{current:true},retryNotifications:{current:new Map()},notifications:{current:{canRetry:()=>true,suppress:k=>suppressed.push(k),clearFailure(){},deliver:async(k,send)=>{delivered.push(k);await send();return true},recordFailure:()=>''}},titlesRef:{current:{}},discardAttentionRetries:()=>[],setNotificationError(){},projectName:()=> 'Fixture',statusLabels:{succeeded:'Done'}};
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
 const args={setRecoveryRevision(){},...h.args,pinnedSessionsRef:{current:[]},setPinnedSessions(){},setSessionTitles:update=>update({}),localStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
 actual('clearDeletedSessionNames',args)(['s-one']);
 assert.deepEqual(h.refs.terminalLayoutRef.current.panes,[null,'s-two',null,'s-other']);assert.equal(h.refs.terminalLayoutRef.current.revision,5);
});

test('T14 review hidden raw replay completion stays ready on close and reopen without replaying',async()=>{
 let release,snapshots=0;const h=harness(['a','b'],async name=>{if(name==='read_terminal_frame')return null;if(name==='read_session_snapshot'){snapshots++;return {data:'live raw fixture',offset:0,end_offset:16,status:'running'};}return null;});
 const loading=h.open(record('a'),true,0),view=h.refs.terminalViews.current.get('a');
 view.instance.write=(_data,done)=>{release=done;};await turn();assert.equal(view.ready,false);assert.equal(view.firstAttachment,true);
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
 for(let i=0;i<3;i++)h.refs.terminalViews.current.get('ended'+i).persisted=false;
 const loading=actual('startSession',launchArgs(h))({cwd:'/fixture',command:'fixture'});assert.equal(h.calls.filter(v=>v.name==='create_session').length,1);
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
 const args={setRecoveryRevision(){},...h.args,notificationsPaused:true,pausedRef:{current:true},session:null,terminalMounted:{current:false},notificationContextFlight:{current:{sending:false,pending:null}},localStorage:{setItem(){}},terminalHost:{current:{}},createView:{current:null},window:{addEventListener(){},removeEventListener(){},setInterval(){return 1},clearInterval(){}},document:{...h.document,addEventListener(){},removeEventListener(){}},ResizeObserver:class{observe(){}disconnect(){}},listen:async()=>()=>{},readPreference:()=>null,refreshHistory(){}};
 callback(notificationEffect,args)();assert.equal(h.calls.length,0,'Pre-mount notification effect cannot dispatch');
 callback(setup,args)();await turn();await turn();
 assert.equal(args.terminalMounted.current,true);
 assert.deepEqual(h.calls.filter(v=>v.name==='set_agent_notification_context').map(({name,...parameters})=>parameters),[{selected:null}]);
 assert.deepEqual(h.errors,[]);
});
