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
 let stored=null;assert.deepEqual(settings.loadTerminalSettings(()=>stored),{settings:base,error:null});
 const custom={fontFamily:"Monaco, monospace",fontSize:24,theme:"light"};settings.saveTerminalSettings(custom,value=>{stored=value;});
 assert.deepEqual(JSON.parse(stored),custom);assert.deepEqual(settings.loadTerminalSettings(()=>stored),{settings:custom,error:null});assert.deepEqual(base,{fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"dark"});
});
test("T10 malformed and inaccessible preferences fall back with visible error",()=>{
 for(const read of [()=>'{',()=>JSON.stringify({...base,fontSize:40}),()=>{throw Error('storage blocked');}]){
  const value=settings.loadTerminalSettings(read);assert.deepEqual(value.settings,base);assert.equal(typeof value.error,"string");assert.ok(value.error.length>0);
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
 const fs=await import('node:fs/promises'),ts=await import('typescript'),source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 const tree=ts.default.createSourceFile('App.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let options;
 const walk=n=>{if(ts.default.isNewExpression(n)&&n.expression.getText(tree)==='Terminal')options=n.arguments[0].getText(tree);ts.default.forEachChild(n,walk);};walk(tree);assert.ok(options);
 const chosen={...base,fontSize:20,theme:'light'},values={terminalSettingsRef:{current:chosen},terminalOptions:()=>({fontFamily:chosen.fontFamily,fontSize:20,theme:{background:'#fafafa'}})};
 const actual=new Function(...Object.keys(values),ts.default.transpile('const x='+options,{target:ts.default.ScriptTarget.ES2022})+';return x;')(...Object.values(values));
 assert.equal(actual.fontSize,20);assert.equal(actual.theme.background,'#fafafa');assert.equal(actual.fontFamily,chosen.fontFamily);assert.equal(actual.lineHeight,1.35,'Existing xterm line height is retained');
});


test("T10 actual settings component offers bounded fields and cancel never saves",async()=>{
 const fs=await import('node:fs/promises'),ts=await import('typescript');let source='';try{source=await fs.readFile(new URL('../src/TerminalSettings.tsx',import.meta.url),'utf8');}catch{}
 const tree=ts.default.createSourceFile('TerminalSettings.tsx',source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found;for(const n of tree.statements)if(ts.default.isFunctionDeclaration(n)&&n.name?.text==='TerminalSettings')found=n.getText(tree);assert.ok(found,'Actual settings UI exists');
 const React={createElement:(type,props,...children)=>({type,props:props??{},children})},values={React,useState:initial=>[initial,()=>{}],useRef:()=>({current:null}),useEffect:()=>{},isTerminalSettings:settings.isTerminalSettings};
 const render=new Function(...Object.keys(values),ts.default.transpile(found.replace('export ',''),{target:ts.default.ScriptTarget.ES2022,jsx:ts.default.JsxEmit.React})+';return TerminalSettings;')(...Object.values(values));
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
