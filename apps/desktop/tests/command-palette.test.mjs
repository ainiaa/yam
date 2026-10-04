import assert from "node:assert/strict";
import {test} from "node:test";
import * as palette from "../src/command-palette.ts";
const sessions=[{id:"s-a",title:"Unicode 中😀",status:"running"},{id:"s-b",title:"Ended fixture",status:"exited"}];
const event={key:"p",metaKey:true,ctrlKey:false,shiftKey:true,altKey:false,isComposing:false,repeat:false};

test("T10 palette provides finite existing actions and filters without execution",()=>{
 let effects=0;const entries=palette.paletteEntries("",sessions,false);assert.deepEqual(entries.filter(x=>x.action!=="switch").map(x=>x.action),['new','previous','search','logs','inbox','diagnostics','settings']);
 assert.ok(palette.paletteEntries("",sessions,true).some(x=>x.action==="resume"));assert.deepEqual(palette.paletteEntries("中😀",sessions,false).map(x=>x.sessionId),['s-a']);assert.equal(effects,0);
 assert.ok(!entries.some(x=>['stop','delete','run_again'].includes(x.action)));assert.equal(palette.paletteEntries('no-match',sessions,false).length,0);
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
 const source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut(')));
 const code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {constructor(input,terminal=false){this.input=input;this.terminal=terminal;}closest(selector){if(selector.includes("xterm-helper-textarea"))return this.terminal?this:null;return /input|textarea|contenteditable/.test(selector)&&this.input?this:null;}}
 for(const composing of [false,true]){
  const calls=[],document={querySelector:()=>null},values={document,Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:agent.defaultShortcuts,jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>calls.push('open'),setSidebarOpen:()=>calls.push('search'),requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>calls.push('pause'),paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
  const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));
  handle({...event,key:']',isComposing:composing,target:new FakeElement(true),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')});assert.deepEqual(calls,[],'Actual App input events must not trigger global session actions');
 }
});


test("T10 actual App palette is available from non-IME terminal focus but ordinary keys stay local",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {closest(selector){return /input|textarea|contenteditable|xterm-helper-textarea/.test(selector)?this:null;}}
 const calls=[],values={document:{querySelector:()=>null},Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:agent.defaultShortcuts,jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{},paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
 const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));
 handle({...event,target:new FakeElement(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,['prevent','propagation','palette']);calls.length=0;
 for(const change of [{metaKey:false,shiftKey:false},{isComposing:true}])handle({...event,...change,target:new FakeElement(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,[]);
});


async function actualAppAction(name,values){
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found;const helpers=[];
 const walk=n=>{if(ts.default.isFunctionDeclaration(n)&&['cancelLayoutRestore','finishLayoutRestore','terminalPaneVisible','terminalPaneHasSize'].includes(n.name?.text))helpers.push(n.getText(tree));if(ts.default.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(tree);ts.default.forEachChild(n,walk);};walk(tree);assert.ok(found,`Actual App ${name} callback exists`);
 values={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:{mode:'single',panes:[null],focused:0,revision:0}},setTerminalLayout:()=>{},...values};
 return new Function(...Object.keys(values),ts.default.transpile(helpers.join('\n')+'\n'+found,{target:ts.default.ScriptTarget.ES2022})+';return '+name+';')(...Object.values(values));
}
test("T10 actual App permanent receipt clears pins and persisted metadata only for deleted IDs",async()=>{
 let pins=['s-deleted','s-keep'];const stored=new Map([['yam.pinnedSessions',JSON.stringify(pins)]]),refs={pinnedSessionsRef:{current:pins},previousSession:{current:null},selectedRecord:{current:null},detailVersion:{current:0},selectionVersion:{current:0},sessionId:{current:null},terminal:{current:null},fitAddon:{current:null},outputCursor:{current:null}};
 const values={...refs,setSessionTitles:f=>f({}),terminalViews:{current:{get:()=>null,setProtected:()=>{},retain:()=>{}}},pendingOutput:{current:new Map()},pendingState:{current:new Map()},setSession:()=>{},setSessionStatus:()=>{},setPinnedSessions:v=>{pins=typeof v==='function'?v(pins):v;},localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},setError:reason=>assert.fail(reason)};
 const clear=await actualAppAction('clearDeletedSessionNames',values);clear(['s-deleted']);assert.deepEqual(pins,['s-keep']);assert.deepEqual(JSON.parse(stored.get('yam.pinnedSessions')),['s-keep']);assert.deepEqual(refs.pinnedSessionsRef.current,['s-keep']);
});
test("T10 actual App ended close only disposes persisted view without stop or history deletion",async()=>{
 for(const state of [{live:true,persisted:true,status:'running'},{live:false,persisted:false,status:'succeeded'},{live:false,persisted:true,status:'succeeded',parsing:Promise.resolve()},{live:false,persisted:true,status:'stopped',updating:true},{live:false,persisted:true,status:'succeeded'},{live:false,persisted:true,status:'stopped'}]){
  let disposed=0;const view={...state,dispose:()=>disposed++},other={live:true};let all=[view,other];const pins=['s-a'],pendingOutput={current:new Map([['s-a','ended'],['s-other','live']])},pendingState={current:new Map([['s-a','ended'],['s-other','live']])};
  const values={pendingOutput,pendingState,sessionId:{current:'s-a'},terminalViews:{current:{get:()=>view,setProtected:()=>{},retain:keep=>{all=all.filter(v=>{if(keep(v))return true;v.dispose();return false;});}}},canCloseSessionView:palette.canCloseSessionView,selectionVersion:{current:0},detailVersion:{current:0},selectedRecord:{current:{status:state.status}},terminal:{current:{}},fitAddon:{current:{}},outputCursor:{current:1},previousSession:{current:null},setSession:()=>{},setSessionStatus:()=>{},setTerminalNotice:()=>{},setSelectedAgent:()=>{},setError:()=>{},pinnedSessionsRef:{current:pins},localStorage:{getItem:()=>null,removeItem:()=>{}},invoke:()=>assert.fail('Close must not issue owner mutation/history RPC')};
  const close=await actualAppAction('closeEndedView',values);close();assert.equal(disposed,state.live||!state.persisted||state.parsing||state.updating?0:1);assert.equal(all.includes(other),true);assert.deepEqual(pins,['s-a']);assert.equal(pendingOutput.current.has('s-a'),disposed===0);assert.equal(pendingState.current.has('s-a'),disposed===0);assert.equal(pendingOutput.current.has('s-other'),true);assert.equal(pendingState.current.has('s-other'),true);
 }
});


test("T10 actual App preserves configured p shortcut over the palette binding",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {closest(){return null;}}
 const calls=[],values={document:{querySelector:()=>null},Element:FakeElement,shortcutAction:agent.shortcutAction,shortcuts:{...agent.defaultShortcuts,attention:'p'},jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{},paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette')};
 const handle=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));handle({...event,target:new FakeElement(),preventDefault:()=>{},stopPropagation:()=>{}});assert.deepEqual(calls,['attention']);
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
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('  function handleShortcut('),source.indexOf('  useEffect(()=>{',source.indexOf('  function handleShortcut('))),code=ts.default.transpile(body,{target:ts.default.ScriptTarget.ES2022});
 class FakeElement {constructor(kind){this.kind=kind;}closest(selector){if(selector==='[data-shortcuts]'||selector==='.xterm-helper-textarea')return null;if(this.kind==='editable-empty')return selector.includes('[contenteditable]')?this:null;return selector.split(',').includes(this.kind)?this:null;}}
 for(const kind of ['input','textarea','select','editable-empty','dialog']){
  const calls=[],values={document:{querySelector:()=>kind==='dialog'?{}:null},Element:FakeElement,shortcuts:agent.defaultShortcuts,shortcutAction:agent.shortcutAction,paletteShortcut:palette.paletteShortcut,openCommandPalette:()=>calls.push('palette'),jumpToAttention:()=>calls.push('attention'),previousSession:{current:null},openSession:()=>{},setSidebarOpen:()=>{},requestAnimationFrame:()=>{},searchInput:{current:null},setNotificationsPaused:()=>{}};
  const handler=new Function(...Object.keys(values),code+';return handleShortcut;')(...Object.values(values));handler({...event,target:new FakeElement(kind),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('propagation')});assert.deepEqual(calls,[],kind+' must keep the new P key');
 }
});
