import {sessionActionBindings} from './fixtures/session-action-bindings.mjs';
import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Exercise real callbacks and JSX without spawning a CLI or contacting a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import * as providers from '../src/provider-config.ts';
import {resolveLaunchDefaults} from '../src/project-config.ts';
import * as layout from '../src/terminal-layout.ts';

const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(predicate,root=file){const result=[];function visit(n){if(predicate(n))result.push(n);ts.forEachChild(n,visit);}visit(root);return result;}
function attribute(n,name){return (n.openingElement??n).attributes.properties.find(a=>a.name?.getText(file)===name)?.initializer;}
const launchDialog=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='dialog'&&attribute(n,'aria-labelledby')?.text==='launch-title')[0];
function advanced(n){for(let p=n.parent;p&&p!==launchDialog;p=p.parent)if(ts.isJsxElement(p)&&p.openingElement.tagName.getText(file)==='details')return p;}
function callback(name,bindings){bindings={cwd:"",...sessionActionBindings(),...bindings};bindings={sessionTerminal:'yam',isMainWindow:true,currentProject:null,session:null,activeProject:'',formAdapter:'codex',formLaunch:{command:null,provider:null},useProjectSettings:false,launchWorktreeAttempt:undefined,launchDirectoryOverride:undefined,launchTerminalProfile:undefined,setCwd(){},setLaunchDirectoryOverride(){},setLaunchTerminalProfile(){},setLaunchWorktreeAttempt(){},...bindings};const fn=nodes(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)[0];assert.ok(fn,name);return new Function(...Object.keys(bindings),ts.transpile(fn.getText(file),{target:ts.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(bindings));}
const draft={adapter:'codex',mode:'interactive',extra_args:'--verbose',prompt:'keep message',command:null,provider:null};
function formFixture(initial=draft){
 const state={draft:structuredClone(initial),edits:{},errors:[]};
 const bindings={...providers,formAdapter:initial.adapter,formLaunch:state.draft,setLaunchDraft:fn=>state.draft=typeof fn==='function'?fn(state.draft):fn,setProjectLaunchEdits:fn=>state.edits=fn(state.edits),setError:v=>state.errors.push(v)};
 bindings.editLaunch=callback('editLaunch',bindings);
 return {state,bindings};
}

test('new session keeps directory, CLI and terminal target outside closed advanced options',()=>{
 assert.ok(launchDialog);
 const controls=nodes(n=>(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&(['input','Select','textarea'].includes((n.openingElement??n).tagName.getText(file))||attribute(n,'aria-label')?.text==='Startup program'),launchDialog);
 const primary=controls.filter(n=>!advanced(n)&&attribute(n,'value')?.expression?.getText(file)!=='copyName');
 assert.equal(primary.length,3,'directory, CLI and terminal target are primary inputs');
 assert.ok(primary.some(n=>attribute(n,'aria-label')?.text==='Startup program'));
 assert.doesNotMatch(launchDialog.getText(file),/Run mode|Model source|<GitChanges|<WorktreeControls|<LaunchTemplates|Save current fields as application defaults/);
 for(const detail of nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='details',launchDialog))assert.equal(attribute(detail,'open'),undefined);
});

test('connection choice has two meanings and stays inside advanced options',()=>{
 const select=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='Select'&&attribute(n,'aria-label')?.text==='Model connection',launchDialog)[0];
 assert.ok(select);assert.ok(advanced(select));
 const options=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='option',select);
 assert.deepEqual(options.map(n=>attribute(n,'value')?.text),['inherited','isolated']);
 assert.match(select.getText(file),/Use existing CLI configuration/);
});

test('connection toggles and presets preserve runner, arguments and message',()=>{
 const f=formFixture(),change=callback('changeProvider',f.bindings);
 change('isolated');assert.equal(f.state.draft.adapter,'codex');assert.equal(f.state.draft.extra_args,'--verbose');assert.equal(f.state.draft.prompt,'keep message');assert.equal(f.state.draft.provider.id,'custom');
 assert.deepEqual(Object.keys(f.state.edits),['provider']);
 change('inherited');assert.equal(f.state.draft.provider,null);assert.equal(f.state.draft.extra_args,'--verbose');
});

test('CLI changes preserve unrelated fields and reject incompatible providers before changing draft',()=>{
 const f=formFixture({...draft,provider:providers.providerPreset('claude-api').provider,adapter:'claude'});
 callback('changeAdapter',f.bindings)('codex');
 assert.equal(f.state.draft.adapter,'claude');assert.equal(f.state.draft.extra_args,'--verbose');assert.equal(f.state.errors.length,1);
 const native=formFixture();callback('changeAdapter',native.bindings)('gemini');assert.equal(native.state.draft.adapter,'gemini');assert.equal(native.state.draft.prompt,'keep message');
});

test('ordinary form forces interactive mode even with trusted task defaults',()=>{
 const declaration=nodes(n=>ts.isVariableDeclaration(n)&&n.name.getText(file)==='formLaunch')[0];
 const bindings={resolveLaunchDefaults,useProjectSettings:true,projectPreview:{trusted:true},globalLaunchDefaults:{...draft,mode:'task'},projectDefaults:{mode:'task'},projectLaunchEdits:{},launchDraft:draft};
 const result=new Function(...Object.keys(bindings),ts.transpile('return ('+declaration.initializer.getText(file)+');',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
 assert.equal(result.mode,'interactive');
});

test('task templates are retained but cannot be silently applied to ordinary new sessions',()=>{
 const f=formFixture();f.bindings.launchSettingsDialog={current:null};f.bindings.launchDialog={current:null};
 const template={...draft,id:'stored',name:'Automation',mode:'task'},before=structuredClone(template);
 callback('applyLaunchTemplate',f.bindings)(template);
 assert.deepEqual(template,before);assert.deepEqual(f.state.draft,draft);assert.match(f.state.errors.join(' '),/task|automation/i);
});

function startFixture(project=false,extra={}){
 const calls=[],errors=[];
 const bindings={...providers,...layout,isMainWindow:true,desktopWindow:{restore_blocked:false},cancelLayoutRestore(){},starting:false,creatingSession:{current:false},terminalLayoutRef:{current:layout.createTerminalLayout()},terminalViews:{current:{canOpen:true,reserveAdmission:()=>true,releaseAdmission(){}}},useProjectSettings:project,projectConfigBusy:false,projectPreview:{trusted:true,root:'/project'},projectTemplate:'',projectLaunchEdits:{},adapters:[{id:'codex',label:'Codex',available:true}],selectedAdapter:'codex',providerConfig:null,command:'',cwd:'/project',prompt:'',adapterArgs:'',launchMode:'task',formLaunch:draft,projectToolsDialog:{current:null},launchDialog:{current:null},localStorage:{setItem(){}},setError:v=>{if(v)errors.push(v);},setStarting(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(){},setSshOpen(){},openHistory:async()=>{},refreshHistory:async()=>{},invoke:async(name,args)=>{calls.push({name,args});return {session_id:'s',cwd:'/project',command:null,status:'running',launch:args.launch};},...extra};
 return {calls,errors,start:callback('startSession',bindings)};
}

test('ordinary submit sends interactive mode while explicit historical task replay preserves task mode',async()=>{
 const f=startFixture();await f.start();assert.deepEqual(f.errors,[]);assert.equal(f.calls[0].args.launch.mode,'interactive');
 const replay={adapter:'codex',mode:'task',extra_args:'',prompt:'original task'};await f.start({cwd:'/project',command:'',launch:replay});assert.deepEqual(f.calls[1].args.launch,replay);
});

test('trusted project submit overrides only mode without flattening or bypassing project trust',async()=>{
 const f=startFixture(true);await f.start();assert.deepEqual(f.errors,[]);assert.equal(f.calls[0].args.projectConfig.overrides.mode,'interactive');assert.equal(f.calls[0].args.launch,null);assert.equal(f.calls[0].args.projectConfig.root,'/project');
});

test('new session does not persist draft changes or inherit one-shot task prompt and command',()=>{
 const state={writes:[],draft:null,edits:null};
 const bindings={cancelLayoutRestore(){},setCwd(){},cancelProjectPreview(){},setProjectLaunchEdits:v=>state.edits=v,setLaunchDraft:v=>state.draft=v,globalLaunchDefaults:{...draft,mode:'task',prompt:'old task',command:'old command'},adapters:[{id:'codex',available:true}],readPreference:(key,fallback)=>fallback,localStorage:{setItem:(...args)=>state.writes.push(args)},setError(){},launchDialog:{current:{showModal(){},querySelectorAll(){return [];}}}};
 callback('newSession',bindings)('/project');assert.equal(state.draft.mode,'interactive');assert.equal(state.draft.prompt,null);assert.equal(state.draft.command,null);assert.deepEqual(state.writes,[]);
});

test('editing trusted fields keeps the effective draft rather than reviving hidden manual values',()=>{
 const effective={...draft,adapter:'claude',provider:providers.providerPreset('claude-api').provider};
 let manual={...draft,provider:null},edits={};
 callback('editLaunch',{formLaunch:effective,setLaunchDraft:fn=>manual=fn(manual),setProjectLaunchEdits:fn=>edits=fn(edits)})({prompt:'new message'});
 assert.equal(manual.adapter,'claude');assert.deepEqual(manual.provider,effective.provider);assert.equal(manual.prompt,'new message');assert.deepEqual(edits,{prompt:'new message'});
});

test('remembered CLI is saved only after success, and storage failure does not retry the launch',async()=>{
 for(const result of [undefined,{launch:{adapter:'claude'}}]){
  const calls=[],errors=[];
  const action=callback('startNewSession',{startSession:async()=>{calls.push('start');return result;},localStorage:{setItem:(key,value)=>calls.push([key,JSON.parse(value)])},setError:v=>errors.push(v)});
  await action();assert.deepEqual(errors,[]);assert.deepEqual(calls,result?['start',['yam.lastSessionCli','claude']]:['start']);
 }
 let starts=0;const errors=[];
 await callback('startNewSession',{startSession:async()=>{starts++;return {launch:{adapter:'codex'}};},localStorage:{setItem(){throw Error('quota');}},setError:v=>errors.push(v)})();
 assert.equal(starts,1);assert.match(errors.join(' '),/Session started/);
});

test('project management binds both Git and worktree controls to its own selected project',()=>{
 const tools=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='dialog'&&attribute(n,'aria-labelledby')?.text==='project-tools-title')[0];
 assert.ok(tools);
 for(const [tag,property] of [['GitChanges','path'],['WorktreeControls','root']]){
  const control=nodes(n=>ts.isJsxSelfClosingElement(n)&&n.tagName.getText(file)===tag,tools)[0];assert.ok(control);assert.equal(attribute(control,property).expression.getText(file),'projectToolsPath');
 }
});

test('a created task survives a GUI attachment error and external opening receives the same session ID',async()=>{
 const f=startFixture(false,{openHistory:async()=>{throw Error('PRIVATE_VIEW_ERROR');}});
 const external=[],released=[];
 const action=callback('startNewSession',{launchWorktreeAttempt:'reserved-attempt',sessionTerminal:'iterm2',startSession:f.start,invoke:async(name,args)=>external.push([name,args]),setLaunchWorktreeAttempt:value=>released.push(value),localStorage:{setItem(){}},setError:value=>f.errors.push(value)});
 await action();assert.equal(f.calls.filter(c=>c.name==='create_session').length,1);
 assert.deepEqual(external,[['open_external_terminal',{sessionId:'s',terminal:'iterm2'}]]);assert.deepEqual(released,[undefined]);
 assert.match(f.errors.join(' '),/created.*existing session/i);assert.doesNotMatch(f.errors.join(' '),/PRIVATE_VIEW_ERROR/);
});
test('concurrent native CLI starts admit one create request before its result is known',async()=>{
 let finish;const requests=[];const f=startFixture(false,{invoke:(name,args)=>{requests.push([name,args]);return new Promise(resolve=>finish=resolve);}});
 const first=f.start();const second=await f.start();assert.equal(second,undefined);assert.equal(requests.length,1);
 finish({session_id:'s',cwd:'/project',command:null,status:'running',launch:{adapter:'codex',mode:'interactive'}});
 assert.equal((await first).session_id,'s');assert.equal(requests.length,1);
});

test('startup buttons retain availability and provider compatibility equally in both windows',()=>{
 const group=nodes(n=>ts.isJsxElement(n)&&attribute(n,'aria-label')?.text==='Startup program',launchDialog)[0];
 const button=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(file)==='button',group)[0];assert.ok(button);
 const evaluate=(name,bindings)=>new Function(...Object.keys(bindings),ts.transpile('return ('+attribute(button,name).expression.getText(file)+');',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
 for(const [id,available,main,provider,disabled] of [
  ['shell',false,true,null,false],['shell',false,false,null,false],['codex',true,true,null,false],['codex',false,true,null,true],['codex',true,false,null,false],
  ['codex',true,true,providers.providerPreset('claude-api').provider,true],['claude',true,true,providers.providerPreset('claude-api').provider,false],
 ]){
  const calls=[],bindings={adapter:{id,available},isMainWindow:main,formAdapter:id,formLaunch:{provider},supportsProvider:providers.supportsProvider,changeAdapter:v=>calls.push(v)};
  assert.equal(evaluate('disabled',bindings),disabled,`${id}/${available}/${main}/${provider?.id}`);
  assert.equal(evaluate('aria-pressed',bindings),true);evaluate('onClick',bindings)();assert.deepEqual(calls,[id]);
 }
});


test('auxiliary window starts an available CLI with the same isolated provider payload exactly once',async()=>{
 const provider=providers.providerPreset('custom').provider;const redirected=[];
 const f=startFixture(false,{isMainWindow:false,providerConfig:provider,openMainSettings:()=>redirected.push(true)});
 await f.start();assert.deepEqual(redirected,[]);assert.deepEqual(f.errors,[]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'create_session');assert.deepEqual(f.calls[0].args.launch.provider,provider);assert.equal(f.calls[0].args.launch.adapter,'codex');
});
test('auxiliary CLI startup error does not retry or redirect',async()=>{
 const redirected=[],f=startFixture(false,{isMainWindow:false,openMainSettings:()=>redirected.push(true),invoke:async()=>{throw Error('terminal_start_outcome_unknown');}});
 await f.start();assert.deepEqual(redirected,[]);assert.match(f.errors.join(' '),/outcome unknown/i);
});

test('explicit custom commands remain visible and editable in either window, including copied sessions',()=>{
 const input=nodes(n=>ts.isJsxSelfClosingElement(n)&&n.tagName.getText(file)==='input'&&attribute(n,'aria-label')?.text==='Custom command')[0];assert.ok(input);
 let expression=input.parent;while(expression&&!ts.isJsxExpression(expression))expression=expression.parent;assert.ok(expression?.expression);
 const js=ts.transpile('return ('+expression.expression.getText(file)+');',{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
 for(const isMainWindow of [true,false])for(const formAdapter of ['shell','custom']){
  const element=new Function('React','t','formAdapter','isMainWindow','formLaunch','editLaunch',js)({createElement:(type,props,...children)=>({type,props,children})},s=>s,formAdapter,isMainWindow,{command:'printf reviewed'},()=>{});assert.ok(element,'the command cannot become a hidden launch argument');
 }
});
