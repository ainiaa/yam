// Author: Jeff.Liu. Actual App JSX/effects and updater callbacks; no native network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const appSource=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
const compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
function allNodes(node,result=[]){result.push(node);ts.forEachChild(node,child=>{allNodes(child,result);});return result;}
test('T20 actual App exposes a visible Updates settings action with explicit open callback',()=>{
 const buttons=allNodes(app).filter(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='button');
 const button=buttons.find(n=>n.children.some(child=>ts.isJsxText(child)&&child.text.trim()==='Updates'));
 assert.ok(button,'real App must render a visible Updates entry');
 const React={createElement:(type,props,...children)=>({type,props,children})};
 const writes=[];
 const actual=new Function('React','setUpdaterOpen',compile('const view='+button.getText(source))+';return view;')(React,value=>writes.push(value));
 actual.props.onClick();assert.deepEqual(writes,[true]);
});

async function module(){return import('../src/updater.ts');}
const snapshot=(state='idle',generation=0)=>({generation,state,current_version:'0.1.0',configured:true,automatic_checks:true,release:['available','downloading','verified'].includes(state)?{version:'0.2.0',notes:'plain <notes>',published:null}:null,progress:null,reason:null,install_allowed:false,install_blocked_reason:'install_unavailable'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('T20 DTO whitelist rejects secrets and inconsistent state without echo',async()=>{
 const {parseUpdaterSnapshot}=await module();assert.deepEqual(parseUpdaterSnapshot(snapshot()),snapshot());
 for(const value of [{...snapshot(),pubkey:'SECRET'},{...snapshot(),generation:NaN},{...snapshot(),state:'installing'},{...snapshot(),release:{version:'x',notes:'x',published:null}},{...snapshot('verified'),install_allowed:true},{...snapshot('available'),release:{version:'x',notes:'x'.repeat(8193),published:null}}]){assert.throws(()=>parseUpdaterSnapshot(value),/^Error: updater_status_invalid$/);}
});
test('T20 preference only stores exact version and boolean, default enabled, failures opt out',async()=>{
 const {loadUpdaterPreference,saveUpdaterPreference}=await module();assert.deepEqual(loadUpdaterPreference(()=>null),{automatic:true,error:null});
 assert.deepEqual(loadUpdaterPreference(()=>'{"version":1,"automatic_checks":false}'),{automatic:false,error:null});
 for(const raw of ['bad','{"version":2,"automatic_checks":true}','{"version":1,"automatic_checks":true,"token":"SECRET"}'])assert.deepEqual(loadUpdaterPreference(()=>raw),{automatic:false,error:'updater_preference_invalid'});
 assert.deepEqual(loadUpdaterPreference(()=>{throw Error('SECRET')}),{automatic:false,error:'updater_preference_unavailable'});
 let raw;assert.equal(saveUpdaterPreference((value)=>raw=value,false),null);assert.equal(raw,'{"version":1,"automatic_checks":false}');assert.equal(saveUpdaterPreference(()=>{throw Error('SECRET')},true),'updater_preference_unavailable');
});
test('T20 configured GUI startup reads opt out before once-only check, reopen cannot duplicate',async()=>{
 const {UpdaterController}=await module();for(const [configured,automatic,checks] of [[true,true,1],[true,false,0],[false,true,0]]){
  const controller=new UpdaterController(),calls=[];const invoke=async(name,args)=>{calls.push({name,args});return {...snapshot(name==='updater_check'?'checking':'idle',name==='updater_check'?1:0),configured,state:configured?(name==='updater_check'?'checking':'idle'):'unconfigured',automatic_checks:automatic};};
  await Promise.all([controller.load(invoke),controller.load(invoke)]);await Promise.all([controller.startup(invoke,automatic),controller.startup(invoke,automatic)]);await controller.startup(invoke,automatic);
  assert.equal(calls.filter(c=>c.name==='updater_status').length,1);assert.equal(calls.filter(c=>c.name==='updater_check').length,checks);assert.equal(calls.some(c=>c.name==='updater_download'||c.name==='updater_install'),false);
 }
});
test('T20 controller cancellation fences old status and failure, verified never invokes install',async()=>{
 const {UpdaterController}=await module();const controller=new UpdaterController();await controller.load(async()=>snapshot('available',1));
 const pending=deferred();const first=controller.action(()=>pending.promise,'download');await new Promise(setImmediate);
 const cancelling=controller.action(async(name,args)=>{assert.equal(name,'updater_cancel');assert.equal(args.expected_generation,1);return snapshot('cancelled',2)},'cancel');await cancelling;pending.resolve(snapshot('verified',2));assert.equal(await first,null);assert.equal(controller.snapshot.state,'cancelled');
 assert.equal(controller.accept(snapshot('checking',1)),false);controller.cancel();const late=deferred();const waiting=controller.refresh(()=>late.promise);controller.cancel();late.reject(Error('SECRET'));assert.equal(await waiting,null);
});
test('T20 completed same-generation snapshot cannot regress to pending command acknowledgement',async()=>{const {UpdaterController}=await module();const controller=new UpdaterController();assert.equal(controller.accept(snapshot('available',1)),true);assert.equal(controller.accept(snapshot('checking',1)),false);assert.equal(controller.snapshot.state,'available');});
test('T20 actual settings renders finite controls/plain notes and always-disabled install',async()=>{
 const text=readFileSync(new URL('../src/UpdaterSettings.tsx',import.meta.url),'utf8');const exports={},React={createElement:(type,props,...children)=>({type,props:props||{},children})};
 const boundary=await module();new Function('exports','React','require',compile(text))(exports,React,name=>name==='react'?{__esModule:true,default:React}:boundary);
 for(const state of ['unconfigured','available','downloading','cancelling','verified']){
  const calls=[],view=exports.default({snapshot:{...snapshot(state),configured:state!=='unconfigured'},automatic:false,busy:false,error:null,onAutomatic:value=>calls.push(value),onAction:value=>calls.push(value),onClose:()=>calls.push('close')});
  const nodes=[];function walk(v){if(v&&typeof v==='object'){nodes.push(v);v.children?.flat(Infinity).forEach(walk);}}walk(view);
  const buttons=nodes.filter(n=>n.type==='button'),install=buttons.find(n=>n.children.includes('Install'));assert.ok(install);assert.equal(install.props.disabled,true);assert.equal(nodes.some(n=>n.props.dangerouslySetInnerHTML),false);
  const check=buttons.find(n=>n.children.includes('Check for updates'));assert.equal(check.props.disabled,state==='unconfigured'||state==='downloading'||state==='cancelling');
  buttons.find(n=>n.children.includes('Close')).props.onClick();assert.deepEqual(calls,['close']);
 }
});

function appFunction(name,args){const declaration=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(declaration,`actual App ${name} callback must be connected`);return new Function(...Object.keys(args),compile(declaration.getText(source))+`;return ${name};`)(...Object.values(args));}
function updaterEffect(){const effect=app.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect'&&n.expression.arguments[1]?.getText(source)==='[]'&&n.expression.arguments[0].getText(source).includes('updaterController'));assert.ok(effect,'actual App must initialize updater through mounted startup effect');return effect.expression.arguments[0];}
test('T20 actual App startup effect reads persisted opt-out and StrictMode replay checks at most once',async()=>{
 const {UpdaterController}=await module();for(const automatic of [true,false]){
  const gate=deferred(),calls=[],writes=[],args={updaterController:{current:new UpdaterController()},updaterMounted:{current:false},updaterIntent:{current:0},updaterAutomaticRef:{current:automatic},updaterPreferenceLoad:{error:null},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError(){},invoke:async(name)=>{calls.push(name);if(name==='updater_status')return gate.promise;return snapshot(name==='updater_check'?'checking':'idle',name==='updater_check'?1:0)}};
  const setup=new Function(...Object.keys(args),compile('const setup='+updaterEffect().getText(source))+';return setup;')(...Object.values(args));
  const first=setup();first();const second=setup();gate.resolve(snapshot());await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(calls.filter(n=>n==='updater_check').length,automatic?1:0);assert.ok(writes.length>0);second();
 }
});
test('T20 actual App startup unmount before pending status prevents automatic SDK command and UI writes',async()=>{
 const {UpdaterController}=await module(),gate=deferred(),calls=[],writes=[],args={updaterController:{current:new UpdaterController()},updaterMounted:{current:false},updaterIntent:{current:0},updaterAutomaticRef:{current:true},updaterPreferenceLoad:{error:null},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError:v=>writes.push(v),invoke:async(name)=>{calls.push(name);return gate.promise}};
 const setup=new Function(...Object.keys(args),compile('const setup='+updaterEffect().getText(source))+';return setup;')(...Object.values(args));const cleanup=setup();cleanup();gate.resolve(snapshot());await new Promise(setImmediate);assert.deepEqual(calls,['updater_status']);assert.deepEqual(writes,[]);
});
test('T20 actual App action close/unmount suppresses old success error and finally',async()=>{
 for(const reject of [false,true]){const pending=deferred(),writes=[],args={updaterController:{current:{action:()=>pending.promise}},updaterMounted:{current:true},updaterIntent:{current:0},invoke(){},setUpdaterBusy:v=>writes.push(['busy',v]),setUpdaterSnapshot:v=>writes.push(['snapshot',v]),setUpdaterError:v=>writes.push(['error',v])};const actual=appFunction('runUpdaterAction',args);const waiting=actual('download');args.updaterIntent.current++;args.updaterMounted.current=false;pending[reject?'reject':'resolve'](reject?Error('SECRET'):snapshot('verified',2));await waiting;assert.deepEqual(writes,[['busy',true]]);}
});
test('T20 actual App settings close invalidates callbacks without installer or auto-download',()=>{const calls=[],args={updaterIntent:{current:0},updaterController:{current:{cancel:()=>calls.push('fence')}},setUpdaterBusy:()=>calls.push('busy'),setUpdaterOpen:value=>calls.push(value)};appFunction('closeUpdaterSettings',args)();assert.deepEqual(calls,['fence','busy',false]);assert.equal(args.updaterIntent.current,1);});

test('T20 actual mounted settings refreshes completed hidden operation once and bounds busy polling',async()=>{
 const effect=app.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect'&&n.expression.arguments[1]?.getText(source).includes('updaterOpen'));
 assert.ok(effect);for(const state of ['idle','checking']){
  const timers=[],writes=[],calls=[];const args={updaterOpen:true,updaterSnapshot:snapshot(state),updaterBusy:(value)=>['checking','downloading','cancelling'].includes(value),updaterController:{current:{snapshot:snapshot(state),refresh:async()=>{calls.push('status');return snapshot(state)}}},updaterMounted:{current:true},invoke(){},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError:v=>writes.push(v),setTimeout:(fn,ms)=>{assert.equal(ms,500);timers.push(fn);return timers.length;},clearTimeout(){}};
  const setup=new Function(...Object.keys(args),compile('const setup='+effect.expression.arguments[0].getText(source))+';return setup;')(...Object.values(args));const cleanup=setup();await new Promise(setImmediate);
  if(timers.length&&calls.length===0)await timers.shift()();assert.equal(calls.length,1,'opening an idle settings must read current completed operation');assert.equal(timers.length,state==='checking'?1:0);cleanup();
 }
});
test('T20 actual polling cleanup rejects late success and failure without new timer',async()=>{
 const effect=app.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect'&&n.expression.arguments[1]?.getText(source).includes('updaterOpen'));
 for(const reject of [false,true]){const gate=deferred(),timers=[],writes=[],args={updaterOpen:true,updaterSnapshot:snapshot('checking',1),updaterBusy:()=>true,updaterController:{current:{snapshot:snapshot('checking',1),refresh:()=>gate.promise}},updaterMounted:{current:true},invoke(){},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError:v=>writes.push(v),setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){}};const setup=new Function(...Object.keys(args),compile('const setup='+effect.expression.arguments[0].getText(source))+';return setup;')(...Object.values(args));const cleanup=setup();if(timers.length)void timers.shift()();cleanup();gate[reject?'reject':'resolve'](reject?Error('SECRET'):snapshot('available',1));await new Promise(setImmediate);assert.deepEqual(writes,[]);assert.equal(timers.length,0);}
});

test('T20 actual startup unmount during preference acknowledgement prevents later automatic check',async()=>{
 const {UpdaterController}=await module(),gate=deferred(),calls=[],writes=[],args={updaterController:{current:new UpdaterController()},updaterMounted:{current:false},updaterIntent:{current:0},updaterAutomaticRef:{current:true},updaterPreferenceLoad:{error:null},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError:v=>writes.push(v),invoke:async(name)=>{calls.push(name);return name==='updater_status'?snapshot():gate.promise}};
 const setup=new Function(...Object.keys(args),compile('const setup='+updaterEffect().getText(source))+';return setup;')(...Object.values(args));const cleanup=setup();await new Promise(setImmediate);assert.deepEqual(calls,['updater_status','updater_set_automatic_checks']);cleanup();const before=writes.length;gate.resolve(snapshot());await new Promise(setImmediate);assert.equal(calls.includes('updater_check'),false);assert.equal(writes.length,before);
});
test('T20 actual automatic preference write failure opts out without storing data or raw error',async()=>{
 const {saveUpdaterPreference}=await module(),calls=[],writes=[],args={updaterIntent:{current:0},saveUpdaterPreference,localStorage:{setItem(){throw Error('PRIVATE path')}},updaterAutomaticRef:{current:true},setUpdaterAutomatic:v=>writes.push(['auto',v]),setUpdaterError:v=>writes.push(['error',v]),updaterController:{current:{snapshot:snapshot(),accept(){}}},setUpdaterBusy(){},setUpdaterSnapshot(){},updaterMounted:{current:true},invoke:async(name,args)=>{calls.push({name,args});return {...snapshot(),automatic_checks:false}}};
 await appFunction('changeUpdaterAutomatic',args)(true);assert.equal(args.updaterAutomaticRef.current,false);assert.deepEqual(calls,[{name:'updater_set_automatic_checks',args:{expected_generation:0,enabled:false}}]);assert.deepEqual(writes,[['auto',false],['error','updater_preference_unavailable']]);
});

test('T20 actual App close and reopen during predecessor status RPC makes bounded fresh read',async()=>{
 const {UpdaterController,updaterBusy}=await module(),controller=new UpdaterController(),old=deferred(),calls=[],timers=[],writes=[];
 controller.accept(snapshot());
 const effect=app.body.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(source)==='useEffect'&&n.expression.arguments[1]?.getText(source).includes('updaterOpen'));
 const args={updaterOpen:true,updaterSnapshot:snapshot(),updaterBusy,updaterController:{current:controller},updaterMounted:{current:true},invoke:async(name)=>{calls.push(name);return calls.length===1?old.promise:snapshot('available',1);},setUpdaterSnapshot:v=>writes.push(v),setUpdaterError:v=>writes.push(v),setTimeout:(fn,ms)=>{assert.equal(ms,500);timers.push(fn);return timers.length;},clearTimeout(){}};
 const setup=new Function(...Object.keys(args),compile('const setup='+effect.expression.arguments[0].getText(source))+';return setup;')(...Object.values(args));
 const close=appFunction('closeUpdaterSettings',{updaterIntent:{current:0},updaterController:{current:controller},setUpdaterBusy(){},setUpdaterOpen(){}});
 const first=setup();await new Promise(setImmediate);close();first();const second=setup();await new Promise(setImmediate);
 assert.equal(calls.length,1,'no overlapping status RPC');
 old.resolve(snapshot('available',1));await new Promise(setImmediate);assert.deepEqual(writes,[],'old reply stays fenced');
 assert.equal(timers.length,1,'mounted reopen must reserve one bounded retry while predecessor is pending');
 await timers.shift()();await new Promise(setImmediate);
 assert.equal(calls.length,2);assert.equal(controller.snapshot.state,'available');assert.equal(writes.length,1);assert.equal(timers.length,0);second();
});
