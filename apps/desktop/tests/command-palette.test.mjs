import {englishUiReadAsync} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import {windowPreferenceKey} from '../src/window-context.ts';
import {resolveAppShortcut,defaultAppShortcuts,loadAppShortcuts,validateAppShortcuts,saveAppShortcuts} from '../src/app-shortcuts.ts';
import * as layoutOperations from '../src/terminal-layout.ts';
import assert from "node:assert/strict";
import {test} from "node:test";
import {terminalZoomShortcut} from "../src/terminal-settings.ts";
import * as palette from "../src/command-palette.ts";
const sessions=[{id:"s-a",title:"Unicode 中😀",status:"running"},{id:"s-b",title:"Ended fixture",status:"exited"}];
const event={key:"p",metaKey:true,ctrlKey:false,shiftKey:true,altKey:false,isComposing:false,repeat:false};

test("T10 palette provides finite existing actions and filters without execution",()=>{
 let effects=0;const entries=palette.paletteEntries("",sessions,false);assert.deepEqual(entries.filter(x=>x.action!=="switch").map(x=>x.action),['appearance','clear-display','second-window','new','previous','search','logs','inbox','diagnostics','settings','profiles','paste-settings','keyboard-shortcuts','pi-routing','updates','launch-settings','larger','smaller','reset']);
 assert.ok(palette.paletteEntries("",sessions,true).some(x=>x.action==="resume"));assert.deepEqual(palette.paletteEntries("中😀",sessions,false).map(x=>x.sessionId),['s-a']);assert.equal(effects,0);
 assert.ok(!entries.some(x=>['stop','delete','run_again'].includes(x.action)));assert.equal(palette.paletteEntries('no-match',sessions,false).length,0);
});

test('global palette lookup queries hot and archived history independently of the loaded sidebar',async()=>{
 assert.equal(typeof palette.PaletteHistorySearch,'function','Global history search must be available');
 const search=new palette.PaletteHistorySearch(),calls=[],request={page_size:100,cursor:null,query:'old task',status:'all',matched_session_ids:[],matched_project_paths:[]};
 const invoke=async(command,args)=>{calls.push([command,args]);return {items:[{summary:{session_id:command==='list_session_summaries'?'s-old':'s-archive',title:'old task'}}],next_cursor:null};};
 await search.load(invoke,request);assert.deepEqual(search.items.map(x=>[x.summary.session_id,x.archived]),[['s-old',false],['s-archive',true]]);assert.equal(search.loading,false);assert.equal(search.error,null);assert.equal(search.hasMore,false);
 assert.deepEqual(calls.map(c=>c[0]),['list_session_summaries','list_archived_sessions']);assert.ok(calls.every(c=>c[1].request.query==='old task'));
});
test('global palette pages retain results, deduplicate IDs and do not hide matches beyond 100 entries',async()=>{
 assert.equal(typeof palette.PaletteHistorySearch,'function');const search=new palette.PaletteHistorySearch(),calls=[];
 const cursor={revision:'r',offset:100,context:'q'},request={page_size:100,cursor:null,query:'task',status:'all',matched_session_ids:[],matched_project_paths:[]};
 const invoke=async(command,{request})=>{calls.push([command,request.cursor]);return command==='list_archived_sessions'?{items:[],next_cursor:null}:request.cursor?{items:[{summary:{session_id:'s-0'}},{summary:{session_id:'s-next'}}],next_cursor:null}:{items:Array.from({length:100},(_,i)=>({summary:{session_id:'s-'+i}})),next_cursor:cursor};};
 await search.load(invoke,request);assert.equal(search.hasMore,true);await search.load(invoke,request,true);assert.equal(search.items.length,101);assert.equal(search.items.at(-1).summary.session_id,'s-next');assert.deepEqual(calls.map(c=>c[0]),['list_session_summaries','list_archived_sessions','list_session_summaries']);
});
test('global palette rejects old query responses and cancellation, and retries errors without executing tasks',async()=>{
 assert.equal(typeof palette.PaletteHistorySearch,'function');const search=new palette.PaletteHistorySearch();let release;
 const gate=new Promise(resolve=>{release=resolve;}),old=search.load(()=>gate,{query:'old'});search.cancel();const stopped=structuredClone(search.items);
 await search.load(async()=>{throw Error('offline');},{query:'new'});assert.match(search.error,/search/i);assert.equal(search.loading,false);
 await search.load(async()=>({items:[{summary:{session_id:'s-new'}}],next_cursor:null}),{query:'new'});assert.equal(search.error,null);assert.ok(search.items.every(x=>x.summary.session_id==='s-new'));assert.deepEqual(stopped,[]);
 release({items:[{summary:{session_id:'s-old'}}],next_cursor:null});await old;assert.ok(search.items.every(x=>x.summary.session_id==='s-new'));
});

test('actual palette merges remote archive results beyond the loaded-page cap and keeps saved names',async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let expression;
 const walk=n=>{if(ts.default.isVariableDeclaration(n)&&n.name.getText(tree)==='allCommandEntries')expression=n.initializer.getText(tree);ts.default.forEachChild(n,walk);};walk(tree);assert.ok(expression);
 const items=Array.from({length:105},(_,i)=>({summary:{session_id:'s-remote-'+i,cwd:'/project',title:'Old task',adapter:'codex'},status:'succeeded',archived:true}));
 const values={commandEntries:[{action:'new',label:'New session'}],paletteHistory:{query:'task',items},paletteQuery:'task',titleFor:summary=>summary.session_id==='s-remote-104'?'Saved alias':summary.title,projects:[],projectKey:x=>x,projectName:()=> 'Project',t:x=>x,statusLabels:{succeeded:'Completed'}};
 const run=()=>new Function(...Object.keys(values),ts.default.transpile('return '+expression,{target:ts.default.ScriptTarget.ES2022}))(...Object.values(values));
 assert.equal(run().length,106);assert.equal(run().at(-1).label,'Saved alias');assert.match(run().at(-1).detail,/Archived/);values.paletteQuery='changed';assert.equal(run().length,1);
});

test('palette settings commands reuse the settings navigation and never execute a session',async()=>{
 const calls=[],values={paletteOpen:true,paletteVersion:{current:0},executePaletteEntry:palette.executePaletteEntry,openSettingsSection:page=>calls.push(page),setError:assert.fail,closeCommandPalette:()=>{}};
 const choose=await actualAppAction('choosePaletteEntry',values);for(const action of ['pi-routing','updates','launch-settings'])await choose({action});assert.deepEqual(calls,['pi-routing','updates','launch-settings']);
});

test('a remote result arriving after an empty search is immediately keyboard-selectable',async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await englishUiReadAsync(fs.readFile,new URL('../src/TerminalSettings.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('TerminalSettings.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX),fn=tree.statements.find(n=>ts.default.isFunctionDeclaration(n)&&n.name?.text==='CommandPalette');
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})},values={React,useRef:()=>({current:null}),useEffect:()=>{},useState:()=>[{query:'old task',entry:undefined},()=>{}]};
 const render=new Function(...Object.keys(values),ts.default.transpile(fn.getText(tree).replace('export ',''),{target:ts.default.ScriptTarget.ES2022,jsx:ts.default.JsxEmit.React})+';return CommandPalette;')(...Object.values(values));
 const entry={action:'switch',sessionId:'s-old',label:'old task'},chosen=[],view=render({query:'old task',onQuery(){},entries:[entry],onChoose:value=>chosen.push(value),onClose(){}}),nodes=n=>[n,...(n.children??[]).filter(x=>x&&typeof x==='object').flatMap(nodes)];
 nodes(view).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.deepEqual(chosen,[entry]);
});

test('palette distinguishes same-title sessions and searches existing project, directory, agent and status',()=>{
 const records=[
  {id:'s-billing',title:'修复登录',project:'支付平台',cwd:'/work/billing',agent:'Codex',status:'Permission required'},
  {id:'s-admin',title:'修复登录',project:'管理后台',cwd:'C:\\work\\admin',agent:'Claude',status:'Running'},
 ];
 const entries=palette.paletteEntries('修复登录',records,false);
 assert.deepEqual(entries.map(entry=>entry.sessionId),['s-billing','s-admin']);
 assert.equal(entries[0].label,'修复登录');
 for(const text of ['支付平台','/work/billing','Codex','Permission required'])assert.ok(entries[0].detail.includes(text));
 for(const [query,id] of [['支付平台','s-billing'],['BILLING','s-billing'],['管理后台 claude','s-admin'],['C:\\work\\admin','s-admin'],['permission','s-billing']])assert.deepEqual(palette.paletteEntries(query,records,false).map(entry=>entry.sessionId),[id]);
 assert.deepEqual(palette.paletteEntries('支付平台 claude',records,false),[]);
 assert.equal(records[0].title,'修复登录');
});

test('palette metadata remains optional, preserves result bounds and never interprets markup',()=>{
 assert.equal(palette.paletteEntries('Unicode',sessions,false)[0].label,sessions[0].title);
 assert.equal(palette.paletteEntries('exited',sessions,false)[0].sessionId,'s-b');
 const records=Array.from({length:150},(_,i)=>({id:'s-'+i,title:'<script>literal</script>',cwd:'/中文/😀',status:'unknown'}));
 const entries=palette.paletteEntries('  中文  ',records,false);
 assert.equal(entries.length,100);assert.equal(entries[0].label,'<script>literal</script>');
 assert.ok(entries[0].detail.includes('unknown'));assert.deepEqual(palette.paletteEntries('not loaded',[],false),[]);
});

test('actual App supplies saved project names, directory, adapter and trustworthy status to palette',async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),{projectKey,projectName}=await import('../src/workspaces.ts'),{agentLabel}=await import('../src/agent-events.ts');
 const source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let expression;
 const walk=node=>{if(ts.default.isVariableDeclaration(node)&&node.name.getText(tree)==='commandEntries')expression=node.initializer.getText(tree);ts.default.forEachChild(node,walk);};walk(tree);assert.ok(expression);
 const values={paletteEntries:palette.paletteEntries,paletteQuery:'支付平台',orderedHistory:[{summary:{session_id:'s-a',cwd:'/work/billing',title:'修复登录',adapter:'codex',mode:'interactive'},status:'running',agent:{phase:'needs_permission',integration:'connected',unread_count:1}}],projects:[{path:'/work/billing/',name:'支付平台'}],projectKey,projectName,adapters:[{id:'codex',label:'Codex'}],titleFor:summary=>summary.title,statusLabels:{running:'Running'},agentLabel,t:value=>value,canContinue:false,shortcutHint:()=>'',shortcuts:{},shortcutMac:false,canReopenTerminalTab:()=>false};
 const execute=()=>new Function(...Object.keys(values),ts.default.transpile('return '+expression,{target:ts.default.ScriptTarget.ES2022}))(...Object.values(values));
 const entries=execute();assert.equal(entries[0]?.sessionId,'s-a');for(const text of ['支付平台','/work/billing','Codex','Permission required'])assert.ok(entries[0].detail.includes(text),text);
 values.paletteQuery='billing';values.projects=[];values.orderedHistory[0]={summary:{session_id:'s-a',cwd:'/work/billing',title:'修复登录',adapter:null,mode:null},status:'unknown',agent:{phase:'idle',integration:'unavailable',unread_count:0}};
 const terminal=execute()[0];assert.ok(terminal.detail.includes('Terminal'));assert.ok(terminal.detail.includes('unknown'));assert.ok(!terminal.detail.includes('Ready'));
});
test("T10 palette opening respects IME, input, dialog and modifier boundaries",()=>{
 assert.equal(palette.paletteShortcut(event,false,false),true);assert.equal(palette.paletteShortcut({...event,metaKey:false,ctrlKey:true},false,false),true);
 for(const change of [{isComposing:true},{repeat:true},{altKey:true},{shiftKey:false},{metaKey:false},{key:'k'}])assert.equal(palette.paletteShortcut({...event,...change},false,false),false);
 assert.equal(palette.paletteShortcut(event,true,false),false);assert.equal(palette.paletteShortcut(event,false,true),false);
});
test("T10 explicit palette choice reuses one action, cancel and stale selection do nothing",async()=>{
 const calls=[],actions={new:()=>calls.push('new'),search:()=>calls.push('search'),switch:id=>calls.push(id),resume:()=>calls.push('resume')};
 assert.equal(await palette.executePaletteEntry({action:'search'},actions,()=>true),true);assert.deepEqual(calls,['search']);
 assert.equal(await palette.executePaletteEntry({action:'switch',sessionId:'s-a'},actions,()=>true),true);assert.deepEqual(calls,['search','s-a']);
 assert.equal(await palette.executePaletteEntry({action:'resume'},actions,()=>false),false);assert.deepEqual(calls,['search','s-a']);
 await assert.rejects(()=>palette.executePaletteEntry({action:'stop'},actions,()=>true));await assert.rejects(()=>palette.executePaletteEntry({action:'switch'},actions,()=>true));assert.deepEqual(calls,['search','s-a']);
});
test("T10 pinned navigation stays stable and rejects corrupt preferences",()=>{
 assert.equal(palette.isPinnedSessions(['s-a','s-b']),true);for(const value of [null,{},['s-a','s-a'],['../private'],Array.from({length:101},(_,i)=>'s-'+i)])assert.equal(palette.isPinnedSessions(value),false);
 const pinned=['s-b'];assert.deepEqual(palette.orderPinnedSessions(sessions,pinned).map(x=>x.id),['s-b','s-a']);assert.deepEqual(pinned,['s-b']);assert.deepEqual(palette.togglePinnedSession(pinned,'s-a'),['s-b','s-a']);assert.deepEqual(palette.togglePinnedSession(pinned,'s-b'),[]);
 assert.throws(()=>palette.togglePinnedSession(pinned,'../private'));assert.equal(palette.canCloseSessionView('running'),false);assert.equal(palette.canCloseSessionView('starting'),false);for(const status of ['succeeded','failed','stopped','needs_attention'])assert.equal(palette.canCloseSessionView(status),true);assert.equal(palette.canCloseSessionView('unknown'),false);
});


test("T10 actual App shortcuts do not steal IME or text input",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts');
 const source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8'),body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut(')));
 const code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {constructor(input,terminal=false){this.input=input;this.terminal=terminal;}closest(selector){if(selector.includes("xterm-helper-textarea"))return this.terminal?this:null;return /input|textarea|contenteditable/.test(selector)&&this.input?this:null;}}
 for(const composing of [false,true]){
  const calls=[],document={querySelector:()=>null},values={resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:"MacIntel"},document,Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:agent.defaultShortcuts,jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>calls.push('open'),setSidebarOpen:()=>calls.push('search'),requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>calls.push('pause'),terminalZoomShortcut,paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
  const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));
  handle({...event,key:']',isComposing:composing,target:new FakeElement(true),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')});assert.deepEqual(calls,[],'Actual App input events must not trigger global session actions');
 }
});


test("T10 actual App palette is available from non-IME terminal focus but ordinary keys stay local",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {closest(selector){return /input|textarea|contenteditable|xterm-helper-textarea/.test(selector)?this:null;}}
 const calls=[],values={resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:"MacIntel"},document:{querySelector:()=>null},Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:agent.defaultShortcuts,jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{},terminalZoomShortcut,paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
 const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));
 handle({...event,target:new FakeElement(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,['prevent','propagation','palette']);calls.length=0;
 for(const change of [{metaKey:false,shiftKey:false},{isComposing:true}])handle({...event,...change,target:new FakeElement(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,[]);
});


async function actualAppAction(name,values){
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found;const helpers=[];
 const walk=n=>{if(ts.default.isFunctionDeclaration(n)&&['cancelLayoutRestore','finishLayoutRestore','terminalPaneVisible','terminalPaneHasSize','recoverRevealedTerminals'].includes(n.name?.text))helpers.push(n.getText(tree));if(ts.default.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(tree);ts.default.forEachChild(n,walk);};walk(tree);assert.ok(found,`Actual App ${name} callback exists`);
 values={zoomedPaneIdRef:{current:null},...layoutOperations,showTerminalLayout(){},reconcileTerminalLayoutSelection(){},layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:{mode:'single',panes:[values.sessionId?.current??null],focused:0,revision:0}},setTerminalLayout:()=>{},...values};
 return new Function(...Object.keys(values),ts.default.transpile(helpers.join('\n')+'\n'+found,{target:ts.default.ScriptTarget.ES2022})+';return '+name+';')(...Object.values(values));
}
test('cancelled palette navigation never opens a session after its pending lookup resolves',async()=>{
 for(const action of ['switch','previous']){
  let resolve;const record=new Promise(r=>{resolve=r;}),calls=[],values={paletteOpen:true,paletteVersion:{current:0},previousSession:{current:'s-next'},executePaletteEntry:palette.executePaletteEntry,detailVersion:{current:0},terminalStatuses:new Set(['succeeded']),invoke:()=>record,openHistory:async()=>{calls.push('opened');},openTerminal:async()=>{calls.push('opened');},setError:value=>calls.push(['error',value]),setPaletteOpen:value=>calls.push(['palette',value])};
  values.openSession=await actualAppAction('openSession',values);values.closeCommandPalette=await actualAppAction('closeCommandPalette',values);
  const choose=await actualAppAction('choosePaletteEntry',values),pending=choose({action,sessionId:'s-next'});values.closeCommandPalette();const before=structuredClone(calls);resolve({summary:{session_id:'s-next'},status:'succeeded'});await pending;assert.deepEqual(calls,before);
 }
});
test('explicit openSession validity is passed through to the attachment boundary',async()=>{
 for(const status of ['running','succeeded']){
  const captures=[],valid=()=>true,values={detailVersion:{current:0},terminalStatuses:new Set(['succeeded']),invoke:async()=>({summary:{session_id:'s-next'},status}),openHistory:async(...args)=>{captures.push(args[4]);},openTerminal:async(...args)=>{captures.push(args[3]);},setError:assert.fail};
  const open=await actualAppAction('openSession',values);await open('s-next',undefined,valid);assert.deepEqual(captures,[valid]);
 }
});

test('session switching records only a current ready attachment and never records failed navigation',async()=>{
 for(const ready of [true,false]){
  const measures=[],detailVersion={current:0},layoutRestore={current:{version:0,pending:false}},view={record:{summary:{session_id:'s-next'}},attachVersion:1,ready,disposed:false};
  const values={detailVersion,layoutRestore,terminalStatuses:new Set(['succeeded']),sessionId:{current:'s-next'},terminalViews:{current:{get:()=>view}},invoke:async()=>({summary:{session_id:'s-next'},status:'succeeded'}),openHistory:async()=>({view,attachment:1,detail:detailVersion.current,intent:layoutRestore.current.version}),openTerminal:assert.fail,setError:assert.fail,performance:{now:()=>10,getEntriesByName:()=>[],measure:(...args)=>measures.push(args),clearMeasures:assert.fail}};
  const open=await actualAppAction('openSession',values);await open('s-next');assert.equal(measures.length,ready?1:0);if(ready){assert.equal(measures[0][0],'yam.view.switch');assert.deepEqual(measures[0][1],{start:10,end:10});}
 }
});

test('successful switches retain exactly the latest 32 timings across the capacity boundary',async()=>{
 const samples=[],ticks=Array.from({length:40},(_,i)=>[(i+1)*100,(i+1)*101]).flat(),detailVersion={current:0},layoutRestore={current:{version:0,pending:false}},view={record:{summary:{session_id:'s-next'}},attachVersion:1,ready:true,disposed:false};
 const values={detailVersion,layoutRestore,terminalStatuses:new Set(['succeeded']),sessionId:{current:'s-next'},terminalViews:{current:{get:()=>view}},invoke:async()=>({summary:{session_id:'s-next'},status:'succeeded'}),openHistory:async()=>({view,attachment:1,detail:detailVersion.current,intent:layoutRestore.current.version}),openTerminal:assert.fail,setError:assert.fail,performance:{now:()=>ticks.shift(),getEntriesByName:name=>samples.filter(sample=>sample.name===name),measure:(name,{start,end})=>samples.push({name,startTime:start,duration:end-start}),clearMeasures:name=>{assert.equal(name,'yam.view.switch');samples.length=0;}}};
 const open=await actualAppAction('openSession',values);for(let i=0;i<40;i++)assert.equal(await open('s-next'),true);
 assert.equal(samples.length,32);assert.deepEqual(samples.map(sample=>sample.duration),Array.from({length:32},(_,i)=>i+9));assert.equal(ticks.length,0);
});
test('successful palette dismissal preserves the committed navigation for its queued fit callback',async()=>{
 let scope,open=true;const values={paletteOpen:true,paletteVersion:{current:0},previousSession:{current:null},executePaletteEntry:palette.executePaletteEntry,setError:assert.fail,setPaletteOpen:value=>{open=value;},openSession:async(_id,_attached,valid)=>{scope=valid;return true;}};
 values.closeCommandPalette=await actualAppAction('closeCommandPalette',values);await (await actualAppAction('choosePaletteEntry',values))({action:'switch',sessionId:'s-next'});assert.equal(open,false);assert.equal(scope(),true);
});
test("T10 actual App permanent receipt clears pins and persisted metadata only for deleted IDs",async()=>{
 let pins=['s-deleted','s-keep'];const stored=new Map([['yam.pinnedSessions',JSON.stringify(pins)]]),refs={pinnedSessionsRef:{current:pins},previousSession:{current:null},selectedRecord:{current:null},viewClaimSelection:{current:0},paneClaimSelection:{current:new Map()},detailVersion:{current:0},selectionVersion:{current:0},sessionId:{current:null},terminal:{current:null},fitAddon:{current:null},outputCursor:{current:null}};
 const values={windowPreferenceKey:name=>windowPreferenceKey("main",name),...refs,setSessionTitles:f=>f({}),terminalViews:{current:{get:()=>null,setProtected:()=>{},retain:()=>{}}},pendingOutput:{current:new Map()},pendingState:{current:new Map()},setSession:()=>{},setSessionStatus:()=>{},setPinnedSessions:v=>{pins=typeof v==='function'?v(pins):v;},localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},setError:reason=>assert.fail(reason)};
 const clear=await actualAppAction('clearDeletedSessionNames',values);clear(['s-deleted']);assert.deepEqual(pins,['s-keep']);assert.deepEqual(JSON.parse(stored.get('yam.pinnedSessions')),['s-keep']);assert.deepEqual(refs.pinnedSessionsRef.current,['s-keep']);
});
test("T10 actual App ended close only disposes persisted view without stop or history deletion",async()=>{
 for(const state of [{live:true,persisted:true,status:'running'},{live:false,persisted:false,status:'succeeded'},{live:false,persisted:true,status:'succeeded',parsing:Promise.resolve()},{live:false,persisted:true,status:'stopped',updating:true},{live:false,persisted:true,status:'succeeded'},{live:false,persisted:true,status:'stopped'}]){
  let disposed=0;const view={...state,dispose:()=>disposed++},other={live:true};let all=[view,other];const pins=['s-a'],pendingOutput={current:new Map([['s-a','ended'],['s-other','live']])},pendingState={current:new Map([['s-a','ended'],['s-other','live']])};
  const values={windowPreferenceKey:name=>windowPreferenceKey("main",name),pendingOutput,pendingState,sessionId:{current:'s-a'},terminalViews:{current:{get:()=>view,setProtected:()=>{},retain:keep=>{all=all.filter(v=>{if(keep(v))return true;v.dispose();return false;});}}},canCloseSessionView:palette.canCloseSessionView,selectionVersion:{current:0},viewClaimSelection:{current:0},paneClaimSelection:{current:new Map()},detailVersion:{current:0},selectedRecord:{current:{status:state.status}},terminal:{current:{}},fitAddon:{current:{}},outputCursor:{current:1},previousSession:{current:null},setSession:()=>{},setSessionStatus:()=>{},setTerminalNotice:()=>{},setSelectedAgent:()=>{},setError:()=>{},pinnedSessionsRef:{current:pins},localStorage:{getItem:()=>null,removeItem:()=>{}},invoke:()=>assert.fail('Close must not issue owner mutation/history RPC')};
  const close=await actualAppAction('closeEndedView',values);close();assert.equal(disposed,state.live||!state.persisted||state.parsing||state.updating?0:1);assert.equal(all.includes(other),true);assert.deepEqual(pins,['s-a']);assert.equal(pendingOutput.current.has('s-a'),disposed===0);assert.equal(pendingState.current.has('s-a'),disposed===0);assert.equal(pendingOutput.current.has('s-other'),true);assert.equal(pendingState.current.has('s-other'),true);
 }
});


test("B04a conflicting legacy P uses safe defaults and actual palette remains reachable",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {closest(){return null;}}
 const calls=[],values={resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:"MacIntel"},document:{querySelector:()=>null},Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:{...agent.defaultShortcuts,attention:'p'},shortcutsRef:{current:loadAppShortcuts(key=>key==='yam.shortcuts'?JSON.stringify({...agent.defaultShortcuts,attention:'p'}):null,true).bindings},jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{},terminalZoomShortcut,paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
 const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));handle({...event,target:new FakeElement(),preventDefault:()=>{},stopPropagation:()=>{}});assert.deepEqual(calls,['palette']);
});


test("T10 actual App resize only uses ready live writable attached views",async()=>{
 const defaults={live:true,ready:true,writable:true,cursor:1,disposed:false,instance:{cols:100,rows:40},element:{dataset:{sessionId:'s-a'},getBoundingClientRect:()=>({width:600,height:400})}};
 for(const change of [{writable:false},{ready:false},{live:false},{cursor:null},{disposed:true},{}]){
  const view={...defaults,...change},calls=[],settings=await import('../src/terminal-settings.ts');
  const sync=await actualAppAction('syncViewSize',{terminalLayoutRef:{current:{panes:['s-a']}},queueTerminalResize:settings.queueTerminalResize,invoke:async(...args)=>calls.push(args),setError:()=>{}});sync(view);await Promise.resolve();assert.equal(calls.length,Object.keys(change).length?0:1);
 }
});
test("T10 actual App explicit take control confirms only the originally selected view",async()=>{
 let resolve;const calls=[],view={live:true,writable:false,frameInstance:'owner-a',disposed:false},refs={sessionId:{current:'s-a'},terminalViews:{current:{get:()=>view}},terminal:{current:{focus:()=>calls.push('focus')}}};
 const take=await actualAppAction('takeTerminalControl',{...refs,invoke:()=>new Promise(r=>{resolve=r;}),setError:()=>{},syncViewSize:()=>calls.push('resize')});const pending=take();refs.sessionId.current='s-other';resolve();await pending;assert.equal(view.writable,false);assert.deepEqual(calls,[]);
});


test("T10 actual App new palette binding respects ordinary fields, empty contenteditable and dialogs",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {constructor(kind){this.kind=kind;}closest(selector){if(selector==='[data-shortcuts]'||selector==='.xterm-helper-textarea')return null;if(this.kind==='editable-empty')return selector.includes('[contenteditable]')?this:null;return selector.split(',').includes(this.kind)?this:null;}}
 for(const kind of ['input','textarea','select','editable-empty','dialog']){
  const calls=[],values={resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:"MacIntel"},document:{querySelector:()=>kind==='dialog'?{}:null},Element:FakeElement,shortcuts:agent.defaultShortcuts,shortcutAction:agent.shortcutAction,terminalZoomShortcut,paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette'),jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{}};
  const handler=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));handler({...event,target:new FakeElement(kind),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,[],kind+' must keep the new P key');
 }
});

test('A08 palette exposes explicit terminal font actions',()=>{assert.deepEqual(palette.paletteEntries('terminal font',[],false).map(x=>x.action),['larger','smaller','reset']);});

test('A02 profile palette action opens management without starting a terminal',async()=>{let opened=0,starts=0;assert.equal(palette.paletteEntries('Terminal profiles',[],false)[0]?.action,'profiles');await palette.executePaletteEntry({action:'profiles'},{profiles:()=>opened++,terminal:()=>starts++},()=>true);assert.equal(opened,1);assert.equal(starts,0);});

test('A04a paste settings palette action has no terminal side effects',async()=>{const calls=[];assert.equal(palette.paletteEntries('Paste settings',[],false)[0]?.action,'paste-settings');await palette.executePaletteEntry({action:'paste-settings'},{'paste-settings':()=>calls.push('settings'),terminal:()=>assert.fail('no terminal')},()=>true);assert.deepEqual(calls,['settings']);});

test('B05a palette discovers exactly one secondary-window action',()=>{assert.equal(palette.paletteEntries('Second terminal window',[],false).filter(x=>x.action==='second-window').length,1);});

test('Reopen palette availability is optional fifth argument and preserves hints',async()=>{assert.equal(palette.paletteEntries('reopen',sessions,false,{}).length,0);const entries=palette.paletteEntries('reopen',sessions,false,{new:'Hint'},true);assert.deepEqual(entries.map(x=>x.action),['reopen']);let count=0;await palette.executePaletteEntry(entries[0],{reopen:()=>count++},()=>true);assert.equal(count,1);assert.ok(palette.paletteEntries('new session',sessions,false,{new:'Hint'},true)[0].label.endsWith('Hint'));});

test('Clear display discoverable disabled or remapped while Reopen fifth argument remains intact',async()=>{const list=palette.paletteEntries('Clear terminal display',[],false,{},true);assert.equal(list.length,1);assert.equal(list[0].action,'clear-display');let calls=0;await palette.executePaletteEntry(list[0],{'clear-display':()=>calls++},()=>true);assert.equal(calls,1);});
