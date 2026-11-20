// Author: Jeff.Liu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as routing from '../src/routing-policies.ts';
import {isLaunchDefaults} from '../src/project-config.ts';
import {duplicateSessionDraft} from '../src/session-actions.ts';
import {defaultRules} from '../src-tauri/pi/task-rules.mjs';
const policy={id:'existing',name:'Existing Pi strategy',adapter:'pi',setup:JSON.stringify({gateway:'http://127.0.0.1:3425',small:'yam-codex/gpt-6-luna',strong:'yam-gateway/compay-ai/qwen3.7-plus',classifier:'yam-codex/gpt-6-luna',rules:defaultRules})};
test('OMP skips Pi strategies its runtime rejects while preserving them for Pi',()=>{
 const model='anthropic/claude-sonnet-4-6';
 const incompatible={...policy,id:'api',name:'API',setup:JSON.stringify({gateway:null,small:model,strong:model,classifier:model,classifierBilling:'api'})};
 const rows=routing.readRoutingPolicies(JSON.stringify([incompatible,policy]),null);
 assert.deepEqual(routing.compatibleRoutingPolicies(rows,'pi'),rows);
 assert.deepEqual(routing.compatibleRoutingPolicies(rows,'omp'),[policy]);
 assert.equal(routing.initialRoutingPolicy('omp','',rows),policy.id);
 assert.equal(routing.initialRoutingPolicy('omp','',[incompatible]),'');
 assert.equal(routing.ompRoutingLaunch(incompatible.id,rows),null);
 assert.equal(routing.compatibleOmpPolicy(incompatible.setup),false);
 assert.equal(routing.compatibleOmpPolicy(policy.setup),true);
 assert.equal(routing.compatibleOmpPolicy(null),true);
});
test('OMP selects existing Pi strategies and freezes their setup without changing the library',()=>{
 assert.equal(routing.supportsDesktopRouting('omp'),true);const rows=[policy],before=JSON.stringify(rows);assert.deepEqual(routing.compatibleRoutingPolicies(rows,'omp'),rows);
 assert.equal(routing.initialRoutingPolicy('omp','',rows),'existing');assert.deepEqual(routing.ompRoutingLaunch('existing',rows),{policy:policy.setup});assert.equal(routing.ompRoutingLaunch('',rows).policy,null);assert.equal(routing.ompRoutingLaunch('missing',rows),null);assert.equal(JSON.stringify(rows),before);
});
test('OMP authentication source survives strategy selection, settings, templates and copies',async()=>{
 const {createLaunchTemplate,encodeLaunchTemplates,decodeLaunchTemplates}=await import('../src/launch-templates.ts');
 for(const auth of ['yam','pi']){
  const options=routing.ompRoutingLaunch('existing',[policy],auth);assert.equal(options.auth,auth);assert.equal(options.policy,policy.setup);
  const fields={adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,omp:options};assert.equal(isLaunchDefaults(fields),true);
  const template=createLaunchTemplate('OMP',fields,()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');assert.equal(decodeLaunchTemplates(encodeLaunchTemplates([template]))[0].omp.auth,auth);
  assert.equal(duplicateSessionDraft({cwd:'/tmp',command:null,launch:fields}).draft.omp.auth,auth);
 }
 assert.equal(isLaunchDefaults({adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,omp:{policy:null,auth:'unknown'}}),false);
 assert.equal(duplicateSessionDraft({cwd:'/tmp',command:null,launch:{adapter:'omp',mode:'interactive',extra_args:'',prompt:null,omp:{policy:null}}}).draft.omp.auth,'pi');
});
test('OMP launch defaults and copies retain policy but drop native conversation identity and prompt',()=>{
 const launch={adapter:'omp',mode:'interactive',extra_args:'',prompt:'old prompt',omp:{policy:policy.setup,session:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}};
 const copied=duplicateSessionDraft({cwd:'/tmp',command:null,launch});assert.deepEqual(copied.draft.omp,{policy:policy.setup,auth:'pi'});assert.equal(copied.draft.prompt,null);assert.equal(isLaunchDefaults(copied.draft),true);
 assert.equal(isLaunchDefaults({...copied.draft,adapter:'pi'}),false);assert.equal(isLaunchDefaults({...copied.draft,omp:{policy:policy.setup,session:'injected'}}),false);
});
test('App includes OMP strategy choice, managed launch payload and actual Provider runtime embedding',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.match(app,/ompRoutingLaunch/);assert.match(app,/\["pi","codex","omp"\]\.includes\(formAdapter\)/);assert.match(app,/omp:ompRoute/);
 const native=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');assert.match(native,/\("omp", "OMP", Some\("omp"\)\)/);assert.match(native,/omp_router::command/);
});
test('OMP launch templates keep policy and cannot persist native session identities',async()=>{
 const {createLaunchTemplate,decodeLaunchTemplates}=await import('../src/launch-templates.ts');
 const template=createLaunchTemplate('OMP',{adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,omp:{policy:policy.setup}},()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');assert.equal(template.omp.policy,policy.setup);assert.deepEqual(decodeLaunchTemplates(JSON.stringify({version:1,templates:[template]})),[template]);
});
test('actual App save callbacks persist selected OMP policy or routing-off rather than stale form state',async()=>{
 const ts=await import('typescript'),app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),functions={};
 const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name)functions[n.name.text]=n.getText(tree);ts.forEachChild(n,visit);};visit(tree);
 for(const selected of [{policy:policy.setup},{policy:null}])for(const name of ['saveLaunchTemplate','updateLaunchTemplate','saveLaunchDefaults']){
  let captured;const bindings={isMainWindow:true,formLaunch:{adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,omp:{policy:'stale'}},ompRoute:selected,launchTemplateName:'OMP',launchTemplateCollection:{selectedId:'id',save:(_n,v)=>captured=v,update:(_id,_n,v)=>captured=v},setLaunchTemplateActionError(){},refreshLaunchTemplateUi(){},handleLaunchTemplateError:e=>{throw e;},projectLaunchFields:v=>v,invoke:async(_n,{defaults})=>captured=defaults,setGlobalLaunchDefaults(){},rememberConnection(){},localStorage:{setItem(){}},setLaunchDefaultsNotice(){}};
  await new Function(...Object.keys(bindings),ts.transpile(functions[name]+';return '+name+';',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings))();assert.deepEqual(captured.omp,selected,name);
 }
});
test('OMP policy survives the actual template encoder and reload',async()=>{
 const {createLaunchTemplate,decodeLaunchTemplates,encodeLaunchTemplates}=await import('../src/launch-templates.ts');
 const template=createLaunchTemplate('OMP',{adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,omp:{policy:policy.setup}},()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');assert.deepEqual(decodeLaunchTemplates(encodeLaunchTemplates([template]))[0].omp,template.omp);
});
test('reopening saved OMP routing-off settings stays off instead of showing an automatic strategy',async()=>{
 const ts=await import('typescript'),app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
 const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='launchPolicy')expression=n.initializer.getText(tree);ts.forEachChild(n,visit);};visit(tree);
 for(const [omp,expected]of [[{policy:null},''],[{policy:policy.setup},routing.launchRoutingPolicy],[undefined,'existing']]){
  const bindings={formAdapter:'omp',formLaunch:{omp,extra_args:''},sessionCopy:null,launchRoutingPolicy:routing.launchRoutingPolicy,initialRoutingPolicy:routing.initialRoutingPolicy,routingPolicyLibrary:{rows:[policy]}};
  const actual=new Function(...Object.keys(bindings),'return ('+expression+');')(...Object.values(bindings));assert.equal(actual,expected);
 }
});
test('new-session callback drops OMP-only defaults when the remembered CLI differs and keeps the OMP policy otherwise',async()=>{
 const ts=await import('typescript'),app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='newSession')callback=n.getText(tree);ts.forEachChild(n,visit);};visit(tree);
 for(const selected of ['pi','codex','shell','omp'])for(const saved of [{policy:policy.setup},{policy:null}]){
  let captured;const noop=()=>{},bindings={sessionCopyIntent:{current:0},setSessionCopy:noop,setCopyName:noop,ordinaryLaunchSnapshot:{},cancelLayoutRestore:noop,setError:noop,setRoutingPolicySelection:noop,setRoutingPolicyLibrary:noop,loadRoutingPolicyLibrary:()=>({rows:[policy]}),setLaunchDirectoryOverride:noop,setLaunchTerminalProfile:noop,setLaunchWorktreeAttempt:noop,setLaunchWorkspace:noop,cancelProjectPreview:noop,setProjectLaunchEdits:noop,globalLaunchDefaults:{adapter:'omp',mode:'interactive',extra_args:'',prompt:null,command:null,provider:null,omp:saved},adapters:[{id:selected,available:true}],readPreference:()=>selected,readLastConnection:()=>null,localStorage:{},supportsProvider:()=>false,setLaunchDraft:v=>captured=v,defaultPiArgs:'',isMainWindow:true,currentProject:null,session:null,activeProject:'/tmp',terminalDirectory:()=>'/tmp',setCwd:noop,launchDialog:{current:{querySelectorAll:()=>[],showModal:noop}}};
  new Function(...Object.keys(bindings),ts.transpile(callback+';return newSession;',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings))();
  assert.equal(captured.adapter,selected);assert.deepEqual(captured.omp,selected==='omp'?saved:undefined);assert.equal(isLaunchDefaults(captured),true);
 }
});
test('applying a launch template replaces a manual OMP strategy and clears foreign OMP fields',async()=>{
 const ts=await import('typescript'),app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='applyLaunchTemplate')callback=n.getText(tree);ts.forEachChild(n,visit);};visit(tree);
 const other=JSON.stringify({...JSON.parse(policy.setup),strong:'yam-codex/gpt-6-luna'});
 for(const template of [{adapter:'omp',omp:{policy:other}},{adapter:'omp',omp:{policy:null}},{adapter:'omp'},{adapter:'pi'}]){
  let choice='existing',draft={adapter:'omp',omp:{policy:policy.setup}};const bindings={setError:e=>{throw Error(e);},projectLaunchFields:v=>v,editLaunch:fields=>draft={...draft,...fields},setRoutingPolicySelection:v=>choice=v,launchSettingsDialog:{current:null},launchDialog:{current:null}};
  new Function(...Object.keys(bindings),ts.transpile(callback+';return applyLaunchTemplate;',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings))({...template,mode:'interactive',extra_args:'',prompt:null,command:null});
  assert.equal(choice,null);assert.deepEqual(draft.omp,template.adapter==='omp'?template.omp:undefined);
 }
});
