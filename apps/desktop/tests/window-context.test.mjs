import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {nativeSettings} from './fixtures/native-settings.mjs';
// Author: Jeff.Liu. Actual App seams with mock IPC; no native windows or owner process.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
const compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function actual(name,args){const declaration=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(declaration,`actual ${name} required`);return new Function(...Object.keys(args),compile(declaration.getText(source))+`;return ${name};`)(...Object.values(args));}
test('B05a secondary updater mutation routes to main with zero owner mutation',async()=>{
 const calls=[],routes=[];const args={desktopWindow:{slot:'terminal-secondary',epoch:1},isMainWindow:false,openMainSettings:()=>routes.push('main'),updaterIntent:{current:0},setUpdaterBusy(){},updaterMounted:{current:true},updaterController:{current:{action:async(...values)=>{calls.push(values);return null;}}},invoke(){},setUpdaterSnapshot(){},setUpdaterError(){}};
 await actual('runUpdaterAction',args)('check');assert.deepEqual(calls,[]);assert.deepEqual(routes,['main']);
});
test('B05a secondary automatic mount collection effect does not overwrite shared prefs',()=>{
 const effect=app.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect'&&n.expression.arguments[1]?.getText(source)==='[sidebarOpen, sessionTitles]');assert.ok(effect);
 const writes=[];const args={isMainWindow:false,desktopWindow:{slot:'terminal-secondary',epoch:1},windowPreferenceKey:name=>'yam.window.terminal-secondary.'+name,localStorage:{setItem:(...row)=>writes.push(row)},projects:[],sidebarOpen:true,sessionTitles:{},setError(){}};
 new Function(...Object.keys(args),compile('const effect='+effect.expression.arguments[0].getText(source))+';effect();')(...Object.values(args));
 assert.equal(writes.some(([key])=>key==='yam.projects'||key==='yam.sessionTitles'),false);assert.deepEqual(writes,[['yam.window.terminal-secondary.sidebar','true']]);
});

test('B05a actual bootstrap precedes App mount and any layout persistence',async()=>{
 const text=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');const file=ts.createSourceFile('main.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const body=file.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(file)).join('\n');
 const events=[];const React={StrictMode:'StrictMode',createElement:(...args)=>args};const args={React,ReactDOM:{createRoot:()=>({render:()=>events.push('render')})},App(){},document:{getElementById:()=>({textContent:''})},initializeDesktopWindow:async()=>{events.push('bootstrap');},waitNativeWindowEpoch:async()=>1,window:{addEventListener(){},removeEventListener(){}},invoke(){},localStorage:{getItem:()=>null},setWindowContext(){}};
 new Function(...Object.keys(args),ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText)(...Object.values(args));await new Promise(setImmediate);assert.deepEqual(events,['bootstrap','render']);
});

test('B05a namespaces read legacy only for missing main keys and preserve bad new raw',async()=>{
 const {windowPreferenceKey,readWindowPreference}=await import('../src/window-context.ts');const values=new Map([['yam.terminalLayout','legacy'],['yam.window.main.terminalLayout','bad-new']]);
 assert.equal(windowPreferenceKey('terminal-secondary','terminalLayout'),'yam.window.terminal-secondary.terminalLayout');assert.equal(readWindowPreference({getItem:key=>values.get(key)??null},'main','terminalLayout'),'bad-new');values.delete('yam.window.main.terminalLayout');assert.equal(readWindowPreference({getItem:key=>values.get(key)??null},'main','terminalLayout'),'legacy');assert.equal(readWindowPreference({getItem:key=>values.get(key)??null},'terminal-secondary','terminalLayout'),null);
});
test('B05a bootstrap collects hidden tabs from both namespaces before IPC and never creates',async()=>{
 const {initializeDesktopWindow}=await import('../src/window-context.ts');const main=JSON.stringify({version:4,root:{kind:'pane',paneId:'p-1',tabs:['s-a-1','s-b-1'],activeIndex:0},focusedPane:'p-1'}),secondary=JSON.stringify({version:4,root:{kind:'pane',paneId:'p-1',tabs:['s-c-1'],activeIndex:0},focusedPane:'p-1'});const calls=[],writes=[];
 const context=await initializeDesktopWindow(async(name,args)=>{calls.push({name,args});return {slot:'main',epoch:1,owned_ids:['s-a-1','s-b-1'],conflict:false,restore_blocked:false,requested_session:null};},{getItem:key=>key==='yam.window.main.terminalLayout'?main:key==='yam.window.terminal-secondary.terminalLayout'?secondary:null,setItem:(...row)=>writes.push(row)},1);assert.deepEqual(calls,[{name:'desktop_window_bootstrap',args:{mainIds:['s-a-1','s-b-1'],secondaryIds:['s-c-1'],expectedEpoch:1}}]);assert.deepEqual(writes,[]);assert.equal(context.slot,'main');
});
test('bootstrap retains readonly flags only for tabs owned by this window',async()=>{
 const {initializeDesktopWindow}=await import('../src/window-context.ts');
 const raw=JSON.stringify({version:6,root:{kind:'pane',paneId:'p-1',tabs:['s-a-1','s-b-1'],activeIndex:0},focusedPane:'p-1',appearances:{},recordedOnly:['s-a-1','s-b-1']});
 const context=await initializeDesktopWindow(async()=>({slot:'main',epoch:1,owned_ids:['s-a-1'],conflict:false,restore_blocked:false,requested_session:null}),{getItem:key=>key==='yam.window.main.terminalLayout'?raw:null},1);
 assert.deepEqual(context.preference.recordedOnly,['s-a-1']);
});
test('B05a exact six renderer invokes capture native epoch and create reservation before create',async()=>{
 const {desktopInvoke}=await import('../src/window-context.ts');const calls=[];const context={slot:'main',epoch:7};const call=async(name,args)=>{calls.push({name,args});return name==='reserve_terminal_start'?4:undefined;};
 for(const name of ['read_terminal_frame','read_session_snapshot','write_session','resize_session','set_terminal_viewport','take_terminal_control'])await desktopInvoke(call,context,name,{sessionId:'s-a-1'});
 assert.ok(calls.every(row=>row.args.desktopEpoch===7));calls.length=0;await desktopInvoke(call,context,'create_session',{cwd:null});assert.deepEqual(calls,[{name:'reserve_terminal_start',args:{desktopEpoch:7}},{name:'create_session',args:{cwd:null,desktopEpoch:7,desktopReservation:4}}]);
});

test('B05a actual foreign open requests native owner slot with zero renderer/frame',async()=>{
 const calls=[],allocations=[];const bindings={desktopWindow:{slot:'terminal-secondary',epoch:1},isMainWindow:false,claimWindowView:async id=>{calls.push(id);return false;},cancelLayoutRestore(){},ownerConnectionAvailable:{current:{available:true,version:0}},layoutRestore:{current:{version:0}},terminalMounted:{current:true},viewClaimSelection:{current:0},pendingViewClaims:{current:new Map()},paneClaimSelection:{current:new Map()},detailVersion:{current:0},document:{activeElement:null},terminalViews:{current:{get(){},setProtected(){},open(){allocations.push(1);throw Error('should not render');}}},creatingSession:{current:false},terminalLayoutRef:{current:{mode:'single',panes:[null],focused:0,revision:0}},terminalMembers:()=>[],terminalPaneIndex:()=>0,assignTerminalPane:layout=>({...layout,panes:['s-a-1']}),terminalSessionPane:()=>0,terminalPaneId:()=> 'p-1',zoomedPaneIdRef:{current:null},setTerminalPaneZoom(){},setError(){}};
 await actual('openHistory',bindings)({summary:{session_id:'s-a-1'},status:'running'});assert.deepEqual(calls,['s-a-1']);assert.deepEqual(allocations,[]);
});

test('recovery reservation identifies the saved terminal before the backend creates its successor',async()=>{
 const {desktopInvoke}=await import('../src/window-context.ts');const calls=[];
 await desktopInvoke(async(name,args)=>{calls.push({name,args});return name==='provider_protocol_version'?1:name==='reserve_terminal_start'?4:{session_id:'s-b-1'};},{slot:'main',epoch:7},'create_session',{resumeFrom:'s-a-1',cwd:null,command:null,launch:null});
 assert.deepEqual(calls.find(c=>c.name==='reserve_terminal_start').args,{desktopEpoch:7,resumeFrom:'s-a-1'});
 assert.equal(calls.at(-1).name,'create_session');assert.equal(calls.at(-1).args.desktopReservation,4);
});

test('B05a secondary pending notification loop consumes zero owner receipts',async()=>{
 const calls=[];const args={isMainWindow:false,pendingLoading:{current:false},invoke:async(name,args)=>{calls.push({name,args});return{items:[],next_key:null};},notifySession(){},setNotificationError(){}};await actual('refreshPendingNotifications',args)();assert.deepEqual(calls,[]);
});

test('B05a actual main missing native epoch dispatches nothing before ready',async()=>{
 const text=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('main.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),body=file.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(file)).join('\n');let ready;const events=[];const root={textContent:''};const args={React:{StrictMode:'strict',createElement(){return null;}},ReactDOM:{createRoot:()=>({render:()=>events.push('render')})},App(){},document:{getElementById:()=>root},window:{addEventListener(){},removeEventListener(){}},waitNativeWindowEpoch:()=>new Promise(resolve=>ready=resolve),initializeDesktopWindow:async()=>{events.push('bootstrap');return{};},invoke(){},localStorage:{getItem:()=>null},setWindowContext(){}};
 new Function(...Object.keys(args),ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText)(...Object.values(args));await new Promise(setImmediate);assert.deepEqual(events,[]);ready(2);await new Promise(setImmediate);assert.deepEqual(events,['bootstrap','render']);
});
test('B05a native ready before listener and timeout followed by retry preserve captured epoch',async()=>{
 const {waitNativeWindowEpoch}=await import('../src/window-context.ts');const listeners=new Set();let timer;const surface={__YAM_DESKTOP_EPOCH__:3,addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};const clock={setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){}};assert.equal(await waitNativeWindowEpoch(surface,clock),3);surface.__YAM_DESKTOP_EPOCH__=undefined;const failed=waitNativeWindowEpoch(surface,clock);timer();await assert.rejects(failed,/native window/);assert.equal(listeners.size,0);surface.__YAM_DESKTOP_EPOCH__=4;assert.equal(await waitNativeWindowEpoch(surface,clock),4);
});

test('secondary profiles request preserves destination without mounting an editor locally',()=>{const h=nativeSettings({isMainWindow:false});h.run('profiles');assert.deepEqual(h.calls,[['main','profiles']]);});

test('B05a secondary storage refuses shared writes while own layout remains local',async()=>{
 const {createWindowStorage}=await import('../src/window-context.ts');const writes=[];const store={getItem:()=>null,setItem:(key,value)=>writes.push([key,value]),removeItem:key=>writes.push([key,null])};const wrapped=createWindowStorage(store,{slot:'terminal-secondary',epoch:2},()=>assert.fail('no secondary publish'));
 assert.throws(()=>wrapped.setItem('yam.terminalSettings','{}'),/main window/);wrapped.setItem('yam.window.terminal-secondary.terminalLayout','{}');assert.deepEqual(writes,[['yam.window.terminal-secondary.terminalLayout','{}']]);
});
test('B05a preference publication serializes rapid captured zoom commits',async()=>{
 const {publishWindowPreference}=await import('../src/window-context.ts');let complete;const calls=[];const call=async(name,args)=>{calls.push(args);if(calls.length===1)await new Promise(resolve=>complete=resolve);};const context={slot:'main',epoch:1};const first=publishWindowPreference(call,context,'yam.terminalSettings','first','larger');const second=publishWindowPreference(call,context,'yam.terminalSettings','second','larger');await Promise.resolve();assert.equal(calls.length,1);complete();await Promise.all([first,second]);assert.deepEqual(calls.map(x=>[x.value,x.appearanceAction]),[['first','larger'],['second','larger']]);
});

test('B05a actual secondary font zoom routes main without shared storage mutation',async()=>{
 const {zoomTerminalSettings}=await import('../src/terminal-settings.ts');const calls=[],commits=[];const view={ready:true,disposed:false,appearance:{fontSize:16,fontFamily:'monospace',theme:'dark'}};const bindings={isMainWindow:false,invoke:async(name,args)=>calls.push([name,args]),sessionId:{current:'s-1-1'},terminalViews:{current:{get:()=>view,all:[view]}},terminalSettingsRef:{current:{...view.appearance}},zoomTerminalSettings,commitTerminalAppearance:(...args)=>commits.push(args),setTerminalSettingsError:()=>{}};await actual('zoomTerminal',bindings)('larger');await Promise.resolve();assert.equal(commits.length,0);assert.deepEqual(calls,[['request_main_terminal_zoom',{action:'larger'}]]);
});

function admissionFixture({factoryError=false,releaseError=false}={}){
 const releases=[],errors=[],pending=[],pool=new Map();
 const bindings={...{cancelLayoutRestore(){},ownerConnectionAvailable:{current:{available:true,version:0}},layoutRestore:{current:{version:0}},terminalMounted:{current:true},viewClaimSelection:{current:0},pendingViewClaims:{current:new Map()},paneClaimSelection:{current:new Map()},detailVersion:{current:0},document:{activeElement:null},creatingSession:{current:false},terminalLayoutRef:{current:{mode:'single',panes:[null],focused:0,revision:0}},terminalMembers:()=>[],terminalPaneIndex:()=>0,assignTerminalPane:layout=>({...layout,panes:['s-a-1']}),terminalSessionPane:()=>0,terminalPaneId:()=> 'p-1',zoomedPaneIdRef:{current:null},setTerminalPaneZoom(){},setTerminalLayout(){},showTerminalLayout(){},focusTerminalPane(){},requestTerminalLayoutFit(){}},terminalViews:{current:{get:id=>pool.get(id),setProtected(){},open(){assert.ok(factoryError);throw Error('fixture factory failure');}}},claimWindowView:()=>new Promise(resolve=>pending.push(resolve)),invoke:async(name,args)=>{assert.equal(name,'release_terminal_view');releases.push(args);if(releaseError)throw Error('release unknown');},setError:value=>errors.push(value)};
 return {bindings,pending,pool,releases,errors,open:actual('openHistory',bindings),record:{summary:{session_id:'s-a-1'},status:'running'}};
}
test('B05a cancelled successful admission without renderer releases captured generation',async()=>{const h=admissionFixture();const opening=h.open(h.record);h.bindings.terminalMounted.current=false;h.pending.shift()(7);await opening;assert.deepEqual(h.releases,[{sessionId:'s-a-1',desktopGeneration:7}]);assert.equal(h.bindings.pendingViewClaims.current.size,0);});
test('B05a renderer factory failure releases admission and reports failure',async()=>{const h=admissionFixture({factoryError:true});const opening=h.open(h.record);h.pending.shift()(8);await opening;assert.deepEqual(h.releases,[{sessionId:'s-a-1',desktopGeneration:8}]);assert.match(h.errors[0],/factory failure/);});
test('B05a same-ID pending peer and warm renderer preserve admission when old intent cancels',async()=>{const h=admissionFixture();let valid=true;const first=h.open(h.record,false,undefined,undefined,()=>valid);const second=h.open(h.record);valid=false;h.pending.shift()(9);await first;assert.deepEqual(h.releases,[]);const view={desktopGeneration:9,ready:true,attaching:false,availability:'available',attachVersion:1,live:true};h.pool.set('s-a-1',view);h.pending.shift()(9);await second;assert.deepEqual(h.releases,[]);assert.equal(h.bindings.pendingViewClaims.current.size,0);});
test('B05a obsolete generation cleanup uses old token and failed release remains visible',async()=>{const h=admissionFixture({releaseError:true});const opening=h.open(h.record);h.bindings.terminalMounted.current=false;h.pending.shift()(3);await opening;assert.deepEqual(h.releases,[{sessionId:'s-a-1',desktopGeneration:3}]);assert.match(h.errors.at(-1),/release unknown/);});

test('B05a claim cache removes only a successfully released matching generation',async()=>{
 const {desktopInvoke,terminalWindowClaim}=await import('../src/window-context.ts');const snapshot={slot:'main',epoch:1},id='s-cache-1';
 await desktopInvoke(async()=>7,snapshot,'claim_terminal_view',{sessionId:id});await desktopInvoke(async()=>null,snapshot,'release_terminal_view',{sessionId:id,desktopGeneration:6});assert.equal(terminalWindowClaim(id),7);
 await assert.rejects(desktopInvoke(async()=>{throw Error('unknown');},snapshot,'release_terminal_view',{sessionId:id,desktopGeneration:7}));assert.equal(terminalWindowClaim(id),7);
 await desktopInvoke(async()=>null,snapshot,'release_terminal_view',{sessionId:id,desktopGeneration:7});assert.equal(terminalWindowClaim(id),0);
});

test('A04b2 file preview and reveal capture native epoch instead of caller spoof',async()=>{
 const {desktopInvoke}=await import('../src/window-context.ts');const calls=[];
 for(const name of ['preview_terminal_file','reveal_terminal_file'])await desktopInvoke(async(name,args)=>calls.push({name,args}),{slot:'terminal-secondary',epoch:17},name,{path:'/tmp/example',desktopEpoch:999});
 assert.deepEqual(calls.map(row=>row.args.desktopEpoch),[17,17]);
});

test('A08b actual secondary appearance commit keeps symbolic system and resolves own light palette',async()=>{const settings=await import('../src/terminal-settings.ts');const calls=[],view={disposed:false,appearance:{fontFamily:'Profile',fontSize:18,theme:'system'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'s-a'}}};const bindings={isMainWindow:false,desktopWindow:{slot:'terminal-secondary',epoch:2,main_epoch:1},preferenceRevision:{current:0},acceptWindowPreferenceCommit:()=>true,terminalOptions:settings.terminalOptions,terminalSystemThemeRef:{current:'light'},terminalViews:{current:{all:[view],get:()=>view}},terminalSettingsRef:{current:settings.defaultTerminalSettings},setTerminalSettings:next=>calls.push(next),setTerminalLayoutAppearanceRevision(){},setTerminalSettingsError(){},saveTerminalSettings(){assert.fail('secondary must not store');},publishWindowPreference(){assert.fail('secondary must not publish');},terminalMounted:{current:true},fitTerminalViews(){},requestAnimationFrame(){},setError:()=>assert.fail('valid commit')};bindings.ownerConnectionAvailable={current:{version:0}};bindings.fitTerminalAppearanceViews=(...args)=>actual('fitTerminalAppearanceViews',bindings)(...args);bindings.commitTerminalAppearance=(...args)=>actual('commitTerminalAppearance',bindings)(...args);actual('receiveWindowPreference',bindings)({source_epoch:1,revision:1,key:'yam.terminalSettings',value:JSON.stringify({...settings.defaultTerminalSettings,theme:'system'}),appearance_action:'apply'});assert.equal(view.appearance.theme,'system');assert.equal(view.instance.options.theme.background,'#fafafa');assert.equal(calls[0].theme,'system');});

 test('A07c2 independent preference actual facade publishes once and secondary refresh performs zero writes',async()=>{
 const {createWindowStorage}=await import('../src/window-context.ts');const {saveZshCommandReporting,loadZshCommandReporting}=await import('../src/zsh-command-reporting.ts');const writes=[],published=[],states=[],ref={current:false};let raw=null;
 const store={getItem:()=>raw,setItem:(key,value)=>{raw=value;writes.push([key,value]);},removeItem:()=>assert.fail()};const wrapped=createWindowStorage(store,{slot:'main',epoch:1},(key,value)=>published.push([key,value]));
 actual('applyCommandReporting',{saveZshCommandReporting,localStorage:wrapped,commandReportingRef:ref,setCommandReporting:v=>states.push(v),setCommandReportingError:()=>{}})(true);
 assert.equal(writes.length,1);assert.equal(published.length,1);assert.equal(published[0][0],'yam.zsh-command-reporting.v1');assert.equal(ref.current,true);
 const secondary={current:false};actual('receiveWindowPreference',{isMainWindow:false,desktopWindow:{main_epoch:1},preferenceRevision:{current:0},acceptWindowPreferenceCommit:()=>true,loadZshCommandReporting,localStorage:{getItem:()=>raw,setItem:()=>assert.fail('no echo')},commandReportingRef:secondary,setCommandReporting:v=>states.push(v),setCommandReportingError:()=>{},setError:()=>assert.fail('valid preference')})({source_epoch:1,revision:1,key:'yam.zsh-command-reporting.v1',value:raw,appearance_action:null});
 assert.equal(secondary.current,true);assert.equal(writes.length,1);assert.equal(published.length,1);
 });

test('v5 bootstrap only sends IDs and filters annotations to owner accepted members',async()=>{const {initializeDesktopWindow}=await import('../src/window-context.ts');const appearance={fontFamily:'Saved',fontSize:18,theme:'dark'},raw=JSON.stringify({version:5,root:{kind:'pane',paneId:'p-1',tabs:['s-a-1','s-b-1'],activeIndex:0},focusedPane:'p-1',appearances:{'s-a-1':appearance,'s-b-1':appearance}});const calls=[];const context=await initializeDesktopWindow(async(name,args)=>{calls.push({name,args});return{slot:'main',epoch:1,owned_ids:['s-a-1'],restore_blocked:false};},{getItem:key=>key==='yam.window.main.terminalLayout'?raw:null},1);assert.deepEqual(calls[0].args,{mainIds:['s-a-1','s-b-1'],secondaryIds:[],expectedEpoch:1});assert.deepEqual(context.preference.appearances,{'s-a-1':appearance});});
