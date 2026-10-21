import {englishUiReadAsync} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import {componentFunction} from './fixtures/component-function.mjs';
import {defaultTerminalLineHeight,parseTerminalLineHeight} from '../src/terminal-line-height.ts';
import {defaultTerminalRetention,saveTerminalRetention} from '../src/terminal-retention.ts';
import {TERMINAL_SCROLLBACK_LINES} from '../src/terminal-frame.ts';
import {defaultTerminalCursor,isTerminalCursor,terminalCursorOptions,saveTerminalCursor} from '../src/terminal-cursor.ts';
import * as windowContext from '../src/window-context.ts';
import {resolveAppShortcut,defaultAppShortcuts,loadAppShortcuts,validateAppShortcuts,saveAppShortcuts} from '../src/app-shortcuts.ts';
import assert from "node:assert/strict";
import {test} from "node:test";
import * as settings from "../src/terminal-settings.ts";
const base={fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"dark"};

test("T10 terminal settings accept bounded font, sizes and finite themes",()=>{
 for(const fontSize of [10,13,24])for(const theme of ["dark","light","solarized"])assert.equal(settings.isTerminalSettings({...base,fontSize,theme,fontFamily:"等宽字体, monospace"}),true);
 assert.equal(settings.isTerminalSettings({...base,fontFamily:"x".repeat(200)}),true);
});
test("T10 terminal settings reject type, control, size and unknown fields",()=>{
 for(const value of [null,[],{}, {...base,fontFamily:""},{...base,fontFamily:"x".repeat(201)},...['\n','\0','\x1b','\x7f','\x85','\u2028'].map(c=>({...base,fontFamily:'mono'+c})),{...base,fontSize:9},{...base,fontSize:25},{...base,fontSize:NaN},{...base,fontSize:Infinity},{...base,fontSize:"13"},{...base,fontSize:13.5},{...base,theme:"remote"},{...base,extra:true}])assert.equal(settings.isTerminalSettings(value),false);
});
test("T10 preferences persist through reload and no-value defaults without warning",()=>{
 let stored=null;assert.deepEqual(settings.loadTerminalSettings(()=>stored),{settings:settings.defaultTerminalSettings,error:null});
 const custom={fontFamily:"Monaco, monospace",fontSize:24,theme:"light"};settings.saveTerminalSettings(custom,value=>{stored=value;});
 assert.deepEqual(JSON.parse(stored),custom);assert.deepEqual(settings.loadTerminalSettings(()=>stored),{settings:custom,error:null});assert.deepEqual(base,{fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"dark"});
});
test("T10 malformed and inaccessible preferences fall back with visible error",()=>{
 for(const read of [()=>'{',()=>JSON.stringify({...base,fontSize:40}),()=>{throw Error('storage blocked');}]){
  const value=settings.loadTerminalSettings(read);assert.deepEqual(value.settings,settings.defaultTerminalSettings);assert.equal(typeof value.error,"string");assert.ok(value.error.length>0);
 }
 let writes=0;assert.throws(()=>settings.saveTerminalSettings({...base,fontSize:0},()=>writes++));assert.equal(writes,0);assert.throws(()=>settings.saveTerminalSettings(base,()=>{throw Error('quota');}),/quota/);
});
test("T10 xterm preferences update all views then fit and synchronize current dimensions",()=>{
 const events=[],view=()=>({instance:{options:{},cols:100,rows:40},fit:{fit(){events.push('fit');}},cursor:1,writable:true,viewportRevision:0});const a=view(),b=view();
 settings.applyTerminalSettings({...base,fontSize:20,theme:"light"},[a,b],v=>{assert.equal(v.instance.options.fontSize,20);events.push([v.instance.cols,v.instance.rows]);});
 assert.deepEqual(events,['fit',[100,40],'fit',[100,40]]);assert.equal(a.viewportRevision,1);assert.equal(b.viewportRevision,1);assert.equal(a.instance.options.fontFamily,base.fontFamily);assert.ok(a.instance.options.theme.background);assert.notEqual(a.instance.options.theme.background,'#202020');
 let sync=0;assert.throws(()=>settings.applyTerminalSettings({...base,fontSize:99},[a],()=>sync++));assert.equal(sync,0);
});


test("T10 owner resize requests are single flight and coalesce latest dimensions",async()=>{
 const calls=[],wait=[],view={instance:{cols:100,rows:40},cursor:1,writable:true,resizePending:null,resizing:false,disposed:false,dirty:false};
 const resize=(cols,rows)=>new Promise(resolve=>{calls.push([cols,rows]);wait.push(resolve);});
 const drain=settings.queueTerminalResize(view,resize,()=>assert.fail('unexpected resize error')).catch(reason=>reason);
 view.instance.cols=120;void settings.queueTerminalResize(view,resize,()=>{}).catch(()=>{});view.instance.cols=140;view.instance.rows=45;void settings.queueTerminalResize(view,resize,()=>{}).catch(()=>{});
 assert.deepEqual(calls,[[100,40]]);wait[0]();await Promise.resolve();await Promise.resolve();assert.deepEqual(calls,[[100,40],[140,45]]);wait[1]();await drain;assert.equal(view.dirty,true);assert.equal(view.resizing,false);
});
test("T10 resize ignores unattached, disposed or zero-size views and reports owner failure",async()=>{
 for(const view of [{instance:{cols:100,rows:40},cursor:null},{instance:{cols:0,rows:40},cursor:1},{instance:{cols:100,rows:40},cursor:1,writable:true,disposed:true}]){let calls=0;await settings.queueTerminalResize(view,()=>{calls++;return Promise.resolve();},()=>{});assert.equal(calls,0);}
 const errors=[],view={instance:{cols:100,rows:40},cursor:1,writable:true,resizing:false,resizePending:null,disposed:false};await settings.queueTerminalResize(view,()=>Promise.reject(Error('lease rejected')),e=>errors.push(String(e)));assert.deepEqual(errors,['Error: lease rejected']);assert.equal(view.resizing,false);
});
test("T10 actual App xterm constructor receives current preferences without recreation",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8');
 const tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let options;
 const walk=n=>{if(ts.default.isNewExpression(n)&&n.expression.getText(tree)==='Terminal')options=n.arguments[0].getText(tree);ts.default.forEachChild(n,walk);};walk(tree);assert.ok(options);
 const chosen={...base,fontSize:20,theme:'light'},values={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),appearance:chosen,terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},TERMINAL_SCROLLBACK_LINES,terminalCursorOptions,terminalSystemThemeRef:{current:"dark"},terminalSettingsRef:{current:chosen},terminalOptions:()=>({fontFamily:chosen.fontFamily,fontSize:20,theme:{background:'#fafafa'}})};
 const actual=componentFunction(...Object.keys(values),ts.default.transpile('const x='+options,{target:ts.default.ScriptTarget.ES2022})+';return x;')(...Object.values(values));
 assert.equal(actual.fontSize,20);assert.equal(actual.theme.background,'#fafafa');assert.equal(actual.fontFamily,chosen.fontFamily);assert.equal(actual.lineHeight,1.35,'Existing xterm line height is retained');
});


test("T10 actual settings component offers bounded fields and cancel never saves",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript');let source='';try{source=await englishUiReadAsync(fs.readFile,new URL('../src/TerminalSettings.tsx',import.meta.url),'utf8');}catch{}
 const tree=ts.default.createSourceFile('TerminalSettings.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found;for(const n of tree.statements)if(ts.default.isFunctionDeclaration(n)&&n.name?.text==='TerminalSettings')found=n.getText(tree);assert.ok(found,'Actual settings UI exists');
 const React={createElement:(type,props,...children)=>({type,props:props??{},children})},values={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),React,defaultTerminalRetention,saveTerminalRetention,defaultTerminalLineHeight,parseTerminalLineHeight,defaultTerminalCursor,isTerminalCursor,useState:initial=>[initial,()=>{}],useRef:()=>({current:null}),useEffect:()=>{},isTerminalSettings:settings.isTerminalSettings};
 const render=componentFunction(...Object.keys(values),ts.default.transpile(found.replace('export ',''),{target:ts.default.ScriptTarget.ES2022,jsx:ts.default.JsxEmit.React})+';return TerminalSettings;')(...Object.values(values));
 const calls=[],nodes=[],walk=n=>{if(n&&typeof n==='object'){nodes.push(n);for(const c of n.children??[])Array.isArray(c)?c.forEach(walk):walk(c);}};walk(render({settings:base,onApply:()=>calls.push('save'),onClose:()=>calls.push('cancel')}));
 assert.deepEqual(calls,[]);const size=nodes.find(n=>n.type==='input'&&n.props['aria-label']==='Font size');assert.equal(size.props.min,10);assert.equal(size.props.max,24);const family=nodes.find(n=>n.type==='input'&&n.props['aria-label']==='Font family');assert.equal(family.props.maxLength,200);
 const cancel=nodes.find(n=>n.type==='button'&&n.children.includes('Cancel'));assert.ok(cancel);cancel.props.onClick();assert.deepEqual(calls,['cancel']);
});


test("T10 queued resize drops pending work after disposal or detach during await and can retry failure",async()=>{
 for(const invalidate of ['disposed','cursor','owner','writable']){
  const calls=[],wait=[],errors=[],view={instance:{cols:100,rows:40},cursor:1,writable:true,disposed:false,resizing:false,resizePending:null,dirty:false,frameInstance:'owner-a'};
  const resize=(cols,rows)=>new Promise(resolve=>{calls.push([cols,rows]);wait.push(resolve);});const running=settings.queueTerminalResize(view,resize,e=>errors.push(e));view.instance.cols=120;void settings.queueTerminalResize(view,resize,e=>errors.push(e));
  if(invalidate==='disposed')view.disposed=true;else if(invalidate==='cursor')view.cursor=null;else if(invalidate==='owner')view.frameInstance='owner-b';else view.writable=false;
  wait[0]();await Promise.resolve();await Promise.resolve();if(wait[1])wait[1]();await running;assert.deepEqual(calls,[[100,40]],'Detached/disposed view cannot send queued resize');assert.equal(view.dirty,false);assert.equal(view.resizing,false);assert.equal(view.resizePending,null);assert.deepEqual(errors,[]);
 }
 const view={instance:{cols:100,rows:40},cursor:1,writable:true,disposed:false,resizing:false,resizePending:null},calls=[];
 await settings.queueTerminalResize(view,()=>Promise.reject(Error('old owner')),()=>{});view.instance.cols=130;await settings.queueTerminalResize(view,async(cols,rows)=>calls.push([cols,rows]),()=>{});assert.deepEqual(calls,[[130,40]]);assert.equal(view.resizing,false);
});


test("T10 preferences cannot acquire an input lease from a read-only view",async()=>{
 const view={instance:{cols:100,rows:40},cursor:1,writable:false,resizing:false,resizePending:null};let calls=0;
 await settings.queueTerminalResize(view,async()=>{calls++;},()=>{});assert.equal(calls,0);
});

// A08 frozen YAM palette: local dark/light choices and Solarized-inspired additions.
const frozenThemes={
 dark:{background:'#202020',foreground:'#e5e5e5',cursor:'#e5e5e5',selectionBackground:'#484848',black:'#202020',brightBlack:'#969696',green:'#83c99a',brightGreen:'#a3dfb5',red:'#e06c75',yellow:'#e5c07b',blue:'#61afef',magenta:'#c678dd',cyan:'#56b6c2',white:'#d5d5d5',brightRed:'#f08a92',brightYellow:'#f2d49a',brightBlue:'#8bc6f4',brightMagenta:'#d9a0e8',brightCyan:'#7acbd3',brightWhite:'#ffffff',cursorAccent:'#202020',selectionForeground:'#e5e5e5',selectionInactiveBackground:'#484848'},
 light:{background:'#fafafa',foreground:'#242424',cursor:'#242424',selectionBackground:'#c8d9ec',black:'#242424',brightBlack:'#666666',green:'#26753b',brightGreen:'#338c47',red:'#a12635',yellow:'#806000',blue:'#245a9b',magenta:'#80358f',cyan:'#176b75',white:'#555555',brightRed:'#b52b3b',brightYellow:'#927000',brightBlue:'#326db3',brightMagenta:'#9743a8',brightCyan:'#23808a',brightWhite:'#242424',cursorAccent:'#fafafa',selectionForeground:'#242424',selectionInactiveBackground:'#c8d9ec'},
 solarized:{background:'#002b36',foreground:'#839496',cursor:'#93a1a1',selectionBackground:'#073642',black:'#073642',brightBlack:'#586e75',green:'#859900',brightGreen:'#b7c36c',red:'#dc322f',yellow:'#b58900',blue:'#268bd2',magenta:'#d33682',cyan:'#2aa198',white:'#eee8d5',brightRed:'#cb4b16',brightYellow:'#657b83',brightBlue:'#839496',brightMagenta:'#6c71c4',brightCyan:'#93a1a1',brightWhite:'#fdf6e3',cursorAccent:'#002b36',selectionForeground:'#839496',selectionInactiveBackground:'#073642'},
};
const ansiSlots=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
const controlSlots=['background','foreground','cursor','cursorAccent','selectionBackground','selectionForeground','selectionInactiveBackground'];
for(const theme of Object.keys(frozenThemes))test('A08 '+theme+' has full frozen ANSI and cursor/selection palette with preserved anchors',()=>{
 const options=settings.terminalOptions({...base,theme});for(const slot of [...ansiSlots,...controlSlots]){assert.ok(Object.hasOwn(options.theme,slot),theme+' owns '+slot);assert.match(options.theme[slot],/^#[0-9a-f]{6}$/);}
 assert.deepEqual(options.theme,frozenThemes[theme]);assert.equal(options.fontFamily,base.fontFamily);assert.equal(options.fontSize,base.fontSize);
});
test('A08 repeated palette cycle applies every owned color to every existing view',()=>{
 const events=[];const views=['a','b'].map(id=>({id,instance:{options:{theme:{unowned:'old'}},cols:100,rows:40},fit:{fit(){events.push(['fit',id]);}},viewportRevision:0}));const identities=views.map(v=>v.instance);
 for(const [index,theme]of ['dark','light','solarized','dark'].entries()){
  settings.applyTerminalSettings({...base,theme},views,v=>events.push(['sync',v.id]));
  for(const [i,view]of views.entries()){assert.equal(view.instance,identities[i]);assert.equal(view.viewportRevision,index+1);assert.deepEqual(view.instance.options.theme,frozenThemes[theme]);assert.equal(view.instance.options.fontSize,13);assert.equal(view.instance.options.fontFamily,base.fontFamily);}
  assert.notEqual(views[0].instance.options.theme,views[1].instance.options.theme);
 }
 assert.deepEqual(events,Array.from({length:4},()=>[['fit','a'],['sync','a'],['fit','b'],['sync','b']]).flat());
});
test('A08 fresh options and view palette copies isolate mutation and retain font boundaries',()=>{
 for(const theme of Object.keys(frozenThemes))for(const fontSize of [10,24]){
  const chosen={...base,theme,fontSize,fontFamily:'等宽字体, monospace'},a=settings.terminalOptions(chosen),b=settings.terminalOptions(chosen);assert.notEqual(a.theme,b.theme);a.theme.red='#000000';assert.deepEqual(b.theme,frozenThemes[theme]);assert.deepEqual(settings.terminalOptions(chosen).theme,frozenThemes[theme]);assert.equal(b.fontFamily,chosen.fontFamily);assert.equal(b.fontSize,fontSize);
 }
 const views=[0,1].map(()=>({instance:{options:{}},fit:{fit(){}},viewportRevision:0}));settings.applyTerminalSettings(base,views,()=>{});views[0].instance.options.theme.cursorAccent='#ffffff';assert.equal(views[1].instance.options.theme.cursorAccent,'#202020');assert.equal(settings.terminalOptions(base).theme.cursorAccent,'#202020');
 let callbacks=0;settings.applyTerminalSettings(base,[],()=>callbacks++);assert.equal(callbacks,0);
});
test('A08 invalid settings fail before palette, revision, fit, sync or storage mutation',()=>{
 const invalid=[null,[],{}, {...base,theme:'remote'},{fontFamily:base.fontFamily,fontSize:13},{...base,extra:true},{...base,fontFamily:''},{...base,fontFamily:'bad\nfont'},{...base,fontSize:9},{...base,fontSize:25},{...base,fontSize:NaN}];
 for(const value of invalid){
  let effects=0;const original={fontFamily:'existing',fontSize:20,theme:{red:'#112233'}},view={instance:{options:structuredClone(original)},fit:{fit(){effects++;}},viewportRevision:7};assert.throws(()=>settings.terminalOptions(value),/Invalid terminal preferences/);assert.throws(()=>settings.applyTerminalSettings(value,[view],()=>effects++),/Invalid terminal preferences/);assert.throws(()=>settings.saveTerminalSettings(value,()=>effects++),/Invalid terminal preferences/);assert.deepEqual(view.instance.options,original);assert.equal(view.viewportRevision,7);assert.equal(effects,0);
 }
});


test('A08 zoom changes one bounded step and reset retains family and theme',()=>{
 for(const fontSize of [10,13,24])for(const action of ['larger','smaller','reset']){
  const original={...base,fontSize,theme:'solarized',fontFamily:'Monaco'};
  const next=settings.zoomTerminalSettings(original,action);
  assert.deepEqual(next,{...original,fontSize:action==='reset'?13:Math.max(10,Math.min(24,fontSize+(action==='larger'?1:-1)))});
  assert.equal(original.fontSize,fontSize);
 }
 for(const invalid of [null,{}, {...base,fontSize:25},{...base,fontSize:NaN}])assert.throws(()=>settings.zoomTerminalSettings(invalid,'larger'),/Invalid terminal preferences/);
 for(const action of [null,'other',1])assert.throws(()=>settings.zoomTerminalSettings(base,action),/Invalid terminal zoom/);
});
test('A08 zoom shortcut matches platform modifiers and only sensible shifted plus',()=>{
 const baseEvent={key:'=',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false,isComposing:false,repeat:false};
 for(const mac of [true,false]){
  const event={...baseEvent,metaKey:mac,ctrlKey:!mac};
  for(const [key,action]of [['=','larger'],['+','larger'],['-','smaller'],['0','reset']])assert.equal(settings.terminalZoomShortcut({...event,key},mac),action);
  assert.equal(settings.terminalZoomShortcut({...event,key:'+',shiftKey:true},mac),'larger');
  assert.equal(settings.terminalZoomShortcut({...event,shiftKey:true},mac),'larger');
  for(const change of [{metaKey:!mac,ctrlKey:mac},{metaKey:true,ctrlKey:true},{metaKey:false,ctrlKey:false},{altKey:true},{repeat:true},{isComposing:true},{key:'a'},{key:'-',shiftKey:true},{key:'0',shiftKey:true}])assert.equal(settings.terminalZoomShortcut({...event,...change},mac),null);
 }
});
async function zoomAppCallbacks(values){values={isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1},nativeInvoke:async()=>{},publishWindowPreference:windowContext.publishWindowPreference,...values};
 const fs=await import('node:fs/promises'),ts=await import('typescript'),agent=await import('../src/agent-events.ts'),palette=await import('../src/command-palette.ts');
 const source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX),names=['fitTerminalAppearanceViews','applyTerminalCursor','applyTerminalSystemTheme','commitTerminalAppearance','applyTerminalPreferences','zoomTerminal','handleShortcut','choosePaletteEntry'];const found=[];
 const walk=n=>{if(ts.default.isFunctionDeclaration(n)&&names.includes(n.name?.text))found.push(n.getText(tree));ts.default.forEachChild(n,walk);};walk(tree);
 class FakeElement {constructor(kind='terminal'){this.kind=kind;}closest(selector){if(selector==='.xterm-helper-textarea')return this.kind==='terminal'?this:null;if(selector==='[data-shortcuts]')return this.kind==='blocked'?this:null;return this.kind==='input'&&selector.includes('input')?this:null;}}
 let layoutRevision=0;const calls=[],view={ready:true,disposed:false,appearance:{...(values?.terminalSettingsRef?.current??base)},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'s-a'}}},ref={current:{...base}},stored=[];
 const context={setTerminalLayoutAppearanceRevision:update=>{layoutRevision=typeof update==='function'?update(layoutRevision):update;},resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:'MacIntel'},document:{querySelector:()=>null},Element:FakeElement,shortcuts:agent.defaultShortcuts,shortcutAction:agent.shortcutAction,paletteShortcut:palette.paletteShortcut,terminalZoomShortcut:settings.terminalZoomShortcut,zoomTerminalSettings:settings.zoomTerminalSettings,saveTerminalSettings:settings.saveTerminalSettings,sessionId:{current:'s-a'},terminalViews:{current:{get:()=>view,all:[view]}},terminalHasInputFocus:()=>true,terminalOptions:settings.terminalOptions,terminalCursorOptions,saveTerminalCursor,terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},setTerminalCursor(){},setTerminalCursorError(){},terminalSystemThemeRef:{current:"dark"},ownerConnectionAvailable:{current:{version:0}},terminalMounted:{current:true},fitTerminalViews:()=>{},terminalSettingsRef:ref,localStorage:{setItem:(key,value)=>stored.push([key,JSON.parse(value)])},setTerminalSettings:next=>calls.push(['state',next.fontSize]),setTerminalSettingsError:error=>calls.push(['error',error]),paletteVersion:{current:1},paletteOpen:true,executePaletteEntry:palette.executePaletteEntry,closeCommandPalette:()=>calls.push('close'),setError:error=>calls.push(['app-error',error]),newSession(){},newTerminal(){},previousSession:{current:null},openSession(){},setSidebarOpen(){},requestAnimationFrame(){},searchInput:{current:null},setLogSearchOpen(){},setInboxOpen(){},canContinue:false,resumeSelectedSession(){},exportDiagnostics(){},setTerminalSettingsOpen(){},openCommandPalette:()=>calls.push('palette'),jumpToAttention:()=>calls.push('attention'),toggleNotificationPause(){},...values};
 const callbacks=componentFunction(...Object.keys(context),ts.default.transpile(found.join('\n'),{target:ts.default.ScriptTarget.ES2022})+';return {applyTerminalCursor,applyTerminalSystemTheme,applyTerminalPreferences,zoomTerminal:typeof zoomTerminal==="function"?zoomTerminal:null,handleShortcut,choosePaletteEntry};')(...Object.values(context));
 context.shortcutsRef.current=defaultAppShortcuts(/Mac|iPhone|iPad|iPod/.test(context.navigator.platform));
 const fire=(change={})=>callbacks.handleShortcut({key:'=',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false,isComposing:false,repeat:false,target:new FakeElement(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop'),...change});
 return{...callbacks,fire,calls,view,ref,stored,FakeElement,context,get layoutRevision(){return layoutRevision;}};
}
test('A08 actual App ready terminal keyboard zoom persists fresh rapid steps and reset',async()=>{
 const app=await zoomAppCallbacks();app.fire();app.fire();assert.equal(app.ref.current.fontSize,15);assert.deepEqual(app.stored.map(x=>x[1].fontSize),[14,15]);assert.equal(app.calls.filter(x=>x==='prevent').length,2);
 app.fire({key:'-'});app.fire({key:'0'});assert.equal(app.ref.current.fontSize,13);assert.deepEqual(app.stored.map(x=>x[1].fontSize),[14,15,14,13]);
 const linux=await zoomAppCallbacks({navigator:{platform:'Linux'}});linux.fire({metaKey:false,ctrlKey:true});assert.equal(linux.ref.current.fontSize,14);
});
test('A08 actual App zoom ignores inputs modal IME repeat unfocused unready and ordinary TUI keys',async()=>{
 for(const scenario of ['input','modal','ime','repeat','unfocused','unready','disposed','no-session','ordinary','wrong-platform','alt']){
  const view={ready:scenario!=='unready',disposed:scenario==='disposed'};
  const app=await zoomAppCallbacks({terminalViews:{current:{get:()=>view,all:[view]}},sessionId:{current:scenario==='no-session'?null:'s-a'},terminalHasInputFocus:()=>scenario!=='unfocused',document:{querySelector:()=>scenario==='modal'?{}:null}});
  app.fire({target:new app.FakeElement(scenario==='input'?'input':'terminal'),isComposing:scenario==='ime',repeat:scenario==='repeat',metaKey:scenario!=='ordinary'&&scenario!=='wrong-platform',ctrlKey:scenario==='wrong-platform',altKey:scenario==='alt'});
  assert.deepEqual(app.calls,[],scenario);assert.deepEqual(app.stored,[],scenario);
 }
 assert.throws(()=>validateAppShortcuts({...defaultAppShortcuts(true),attention:{key:'=',shift:true}},true));const configured=await zoomAppCallbacks();configured.fire({shiftKey:true});assert.equal(configured.ref.current.fontSize,14);assert.equal(configured.calls.includes('attention'),false);
});
test('A08 actual App palette zoom shares persistence and reports failed writes without mutation',async()=>{
 const app=await zoomAppCallbacks();await app.choosePaletteEntry({action:'larger'});assert.equal(app.ref.current.fontSize,14);assert.equal(app.stored.length,1);
 await app.choosePaletteEntry({action:'smaller'});await app.choosePaletteEntry({action:'reset'});assert.equal(app.ref.current.fontSize,13);
 const broken=await zoomAppCallbacks({localStorage:{setItem(){throw Error('quota');}}});broken.fire();assert.equal(broken.ref.current.fontSize,13);assert.ok(broken.calls.some(x=>Array.isArray(x)&&x[0]==='error'&&/quota/.test(x[1])));assert.ok(!broken.calls.some(x=>Array.isArray(x)&&x[0]==='state'));
 const invalid=await zoomAppCallbacks();assert.throws(()=>invalid.applyTerminalPreferences({...base,fontSize:99}),/Invalid terminal preferences/);assert.deepEqual(invalid.stored,[]);assert.deepEqual(invalid.calls,[]);assert.equal(invalid.ref.current.fontSize,13);
});

test('A08 actual App bounded zoom avoids redundant writes and invalid current settings stay untouched',async()=>{
 for(const [fontSize,key]of [[10,'-'],[24,'='],[13,'0']]){
  const app=await zoomAppCallbacks({terminalSettingsRef:{current:{...base,fontSize}}});app.fire({key});assert.deepEqual(app.stored,[]);assert.ok(!app.calls.some(x=>Array.isArray(x)&&x[0]==='state'));
 }
 const ref={current:{...base,fontSize:NaN}},app=await zoomAppCallbacks({terminalSettingsRef:ref});app.fire();assert.ok(Number.isNaN(ref.current.fontSize));assert.deepEqual(app.stored,[]);assert.ok(app.calls.some(x=>Array.isArray(x)&&x[0]==='error'&&/Invalid terminal preferences/.test(x[1])));
 for(const change of [{ready:false},{disposed:true}]){const app=await zoomAppCallbacks({terminalViews:{current:{get:()=>({ready:true,disposed:false,...change})}}});await app.choosePaletteEntry({action:'larger'});assert.deepEqual(app.stored,[]);assert.equal(app.ref.current.fontSize,13);}
 const stale=await zoomAppCallbacks({paletteOpen:false});await stale.choosePaletteEntry({action:'larger'});assert.deepEqual(stale.stored,[]);
});

test('A02c1 actual global zoom uses each view size and preserves its family and theme',async()=>{
 const views=[20,13].map((size,i)=>({ready:true,disposed:false,appearance:{fontFamily:'Profile '+i,fontSize:size,theme:i?'light':'solarized'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'v'+i}}}));
 const app=await zoomAppCallbacks({terminalViews:{current:{all:views,get:id=>views.find(v=>v.element.dataset.sessionId===id)}},sessionId:{current:'v0'}});app.fire();assert.deepEqual(views.map(v=>v.appearance.fontSize),[21,14]);assert.deepEqual(views.map(v=>v.appearance.theme),['solarized','light']);assert.equal(app.ref.current.fontSize,14);
});

test('A02c1 global boundary still commits per-view changes and denied write is atomic',async()=>{
 for(const fail of [false,true]){const view={ready:true,disposed:false,appearance:{...base,fontSize:10,theme:'light'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'s-a'}}},writes=[];const app=await zoomAppCallbacks({terminalSettingsRef:{current:{...base,fontSize:24}},terminalViews:{current:{all:[view],get:()=>view}},localStorage:{setItem:(k,v)=>{writes.push(JSON.parse(v));if(fail)throw Error('quota');}}});app.fire();assert.equal(writes.length,1);assert.equal(writes[0].fontSize,24);assert.equal(app.context.terminalSettingsRef.current.fontSize,24);assert.equal(view.appearance.fontSize,fail?10:11);assert.equal(view.appearanceRevision,fail?0:1);assert.equal(view.appearance.theme,'light');if(fail)assert.deepEqual(view.instance.options,{});}
});
test('A02c1 global Save and delayed font callbacks only touch captured current instances and revisions',async()=>{
 let fontReady;const fonts=new Promise(r=>fontReady=r),frames=[],fits=[],view=id=>({ready:true,disposed:false,appearance:{...base,fontSize:20,theme:'solarized'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:id}}}),a=view('s-a'),views=[a],mounted={current:true};
 const app=await zoomAppCallbacks({terminalMounted:mounted,document:{querySelector:()=>null,fonts:{ready:fonts}},terminalViews:{current:{get:id=>views.find(v=>v.element.dataset.sessionId===id),get all(){return [...views];}}},requestAnimationFrame:fn=>frames.push(fn),fitTerminalViews:targets=>fits.push(...targets)});
 app.applyTerminalPreferences({...base,fontSize:18,theme:'light'});assert.equal(a.appearance.fontSize,18);assert.equal(a.appearance.theme,'light');assert.equal(fits.length,1);const late=view('late');views.push(late);frames[0]();app.applyTerminalPreferences({...base,fontSize:17});fontReady();await Promise.resolve();assert.equal(a.appearance.fontSize,17);assert.equal(late.appearance.fontSize,17);assert.equal(fits.length,3,'superseded first callback performs zero fit');
 const newer=view('newer');views.push(newer);frames[1]();await Promise.resolve();assert.equal(newer.appearance.fontSize,20);assert.equal(newer.appearance.theme,'solarized');
 app.applyTerminalPreferences({...base,fontSize:16});a.disposed=true;const replacement=view('s-a');views[0]=replacement;frames[2]();await Promise.resolve();assert.equal(replacement.appearance.fontSize,20);const count=fits.length;mounted.current=false;frames[2]();await Promise.resolve();assert.equal(fits.length,count);
});

test('A08b symbolic system roundtrip and explicit local dark light palette resolution',()=>{const next={...base,theme:'system'};assert.equal(settings.isTerminalSettings(next),true);let raw;settings.saveTerminalSettings(next,v=>raw=v);assert.deepEqual(settings.loadTerminalSettings(()=>raw),{settings:next,error:null});assert.deepEqual(settings.terminalOptions(next,'light').theme,settings.terminalOptions({...base,theme:'light'}).theme);assert.deepEqual(settings.terminalOptions(next,'dark').theme,settings.terminalOptions(base).theme);assert.deepEqual(settings.terminalOptions(next).theme,settings.terminalOptions(base).theme);});
test('A08b finite own theme names and fresh palettes preserve legacy settings',()=>{for(const theme of ['__proto__','constructor','toString','unknown',null,12])assert.equal(settings.isTerminalSettings({...base,theme}),false);for(const theme of ['dark','light','solarized'])assert.deepEqual(settings.loadTerminalSettings(()=>JSON.stringify({...base,theme})).settings,{...base,theme});const next={...base,theme:'system'},a=settings.terminalOptions(next,'light'),b=settings.terminalOptions(next,'light');a.theme.background='bad';assert.notEqual(b.theme.background,'bad');assert.equal(settings.isTerminalSettings({...next,extra:true}),false);});

test('A08b settings require exactly the three own keys, including nonenumerable and symbol extras',()=>{const inherited=Object.assign(Object.create({fontFamily:'mono',fontSize:13}),{theme:'system',other:1,extra:2});assert.equal(settings.isTerminalSettings(inherited),false);const symbol={...base};symbol[Symbol('extra')]=true;assert.equal(settings.isTerminalSettings(symbol),false);const hidden={...base};Object.defineProperty(hidden,'extra',{value:true});assert.equal(settings.isTerminalSettings(hidden),false);});

test('A08b actual pending font fit finishes after OS palette change without restoring old palette',async()=>{let ready;const fonts=new Promise(resolve=>ready=resolve),frames=[],fits=[],writes=[],view={ready:true,disposed:false,appearance:{...base,theme:'system'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'s-a'}}};const local={current:'dark'};const app=await zoomAppCallbacks({terminalSystemThemeRef:local,terminalViews:{current:{all:[view],get:()=>view}},document:{fonts:{ready:fonts},querySelector:()=>null},requestAnimationFrame:fn=>frames.push(fn),fitTerminalViews:views=>fits.push(views),localStorage:{setItem:(...args)=>writes.push(args)}});app.applyTerminalPreferences({...base,fontSize:19,theme:'system'});assert.equal(view.instance.options.theme.background,'#202020');const revision=view.appearanceRevision;app.applyTerminalSystemTheme('light');assert.equal(view.instance.options.theme.background,'#fafafa');assert.equal(view.appearanceRevision,revision);assert.equal(fits.length,1);assert.equal(writes.length,1);frames[0]();ready();await Promise.resolve();assert.equal(fits.length,2);assert.equal(view.instance.options.theme.background,'#fafafa');assert.equal(view.instance.options.fontSize,19);assert.equal(writes.length,1);});
test('A08b actual system Save failure leaves view and symbolic preferences unchanged',async()=>{const app=await zoomAppCallbacks({localStorage:{setItem(){throw Error('quota');}},terminalSystemThemeRef:{current:'light'}});const before={...app.view.appearance};assert.throws(()=>app.applyTerminalPreferences({...base,theme:'system'}),/quota/);assert.deepEqual(app.view.appearance,before);assert.deepEqual(app.view.instance.options,{});assert.equal(app.ref.current.theme,'dark');});
test('A08b actual xterm constructor resolves captured Profile system locally',async()=>{const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await englishUiReadAsync(fs.readFile,new URL('../src/App.tsx',import.meta.url),'utf8');const tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let options;const walk=n=>{if(ts.default.isNewExpression(n)&&n.expression.getText(tree)==='Terminal')options=n.arguments[0].getText(tree);ts.default.forEachChild(n,walk);};walk(tree);for(const resolved of ['dark','light']){const appearance={...base,fontSize:18,theme:'system'},args={appearance,terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},TERMINAL_SCROLLBACK_LINES,terminalCursorOptions,terminalSystemThemeRef:{current:resolved},terminalOptions:settings.terminalOptions};const value=componentFunction(...Object.keys(args),ts.default.transpile('const options='+options,{target:ts.default.ScriptTarget.ES2022})+';return options;')(...Object.values(args));assert.equal(value.theme.background,resolved==='light'?'#fafafa':'#202020');assert.equal(appearance.theme,'system');assert.equal(value.fontSize,18);}});

test('A08c actual cursor Save preserves pending font fit and system palette; appearance Save leaves cursor',async()=>{let ready;const frames=[],fits=[],fonts=new Promise(resolve=>ready=resolve),view={ready:true,disposed:false,appearance:{...base,theme:'system'},appearanceRevision:0,instance:{options:{}},element:{dataset:{sessionId:'s-a'}}};const app=await zoomAppCallbacks({terminalViews:{current:{all:[view],get:()=>view}},document:{querySelector:()=>null,fonts:{ready:fonts}},requestAnimationFrame:fn=>frames.push(fn),fitTerminalViews:views=>fits.push(views)});app.applyTerminalPreferences({...base,fontSize:19,theme:'system'});const revision=view.appearanceRevision;app.applyTerminalCursor({shape:'bar',blink:false});assert.equal(view.appearanceRevision,revision);assert.equal(fits.length,1);app.applyTerminalSystemTheme('light');assert.equal(view.instance.options.cursorStyle,'bar');assert.equal(view.instance.options.cursorBlink,false);frames[0]();ready();await Promise.resolve();assert.equal(fits.length,2);assert.equal(view.instance.options.theme.background,'#fafafa');assert.equal(view.instance.options.cursorStyle,'bar');app.applyTerminalPreferences({...base,fontSize:18,theme:'solarized'});assert.equal(view.instance.options.cursorStyle,'bar');assert.equal(view.instance.options.cursorBlink,false);});

test('v5 actual appearance Apply and rapid zoom trigger layout annotation revision only after successful commit',async()=>{const app=await zoomAppCallbacks();app.applyTerminalPreferences({...base,fontSize:18});assert.equal(app.layoutRevision,1);app.fire();app.fire();assert.equal(app.view.appearance.fontSize,20);assert.equal(app.layoutRevision,3);const failing=await zoomAppCallbacks({localStorage:{setItem(){throw Error('quota');}}});assert.throws(()=>failing.applyTerminalPreferences({...base,fontSize:18}));assert.equal(failing.layoutRevision,0);assert.deepEqual(failing.view.appearance,base);});

test('v5 zoom boundary and OS palette changes do not trigger appearance snapshot revision',async()=>{const app=await zoomAppCallbacks({terminalSettingsRef:{current:{...base,fontSize:24,theme:'system'}}});app.fire();assert.equal(app.layoutRevision,0);app.applyTerminalSystemTheme('light');assert.equal(app.layoutRevision,0);});
