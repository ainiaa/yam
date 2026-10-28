import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {supportsProvider,providerPreset,providerChoice} from "../src/provider-config.ts";
import * as providerConfig from "../src/provider-config.ts";
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isLaunchDefaults} from '../src/project-config.ts';
import {projectLaunchFields,createLaunchTemplate,encodeLaunchTemplates,decodeLaunchTemplates} from '../src/launch-templates.ts';
import ts from 'typescript';
import {readFileSync as rawReadFileSync} from 'node:fs';
import * as layout from '../src/terminal-layout.ts';

const provider={id:'deepseek',model:'deepseek-flash',base_url:'https://api.deepseek.com',api_key_env:'DEEPSEEK_API_KEY'};
const launch={adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null};

test('DeepSeek presets choose an explicit CLI and keep the legacy Codex connection',()=>{
 const codex=providerPreset('deepseek'),claude=providerPreset('deepseek-claude');
 assert.deepEqual(codex,{adapter:'codex',provider});
 assert.deepEqual(claude,{adapter:'claude',provider:{...provider,base_url:'https://api.deepseek.com/anthropic'}});
 assert.equal(providerChoice(codex.adapter,codex.provider),'deepseek');
 assert.equal(providerChoice(claude.adapter,claude.provider),'deepseek-claude');
 for(const adapter of ['codex','claude'])assert.equal(supportsProvider(adapter,provider),true,adapter);
 for(const adapter of ['gemini','opencode','shell','custom'])assert.equal(supportsProvider(adapter,provider),false,adapter);
});

test('both DeepSeek connections survive defaults and template round trips without migration',()=>{
 for(const adapter of ['codex','claude']){
  const connection={...provider,base_url:adapter==='claude'?'https://api.deepseek.com/anthropic':provider.base_url};
  const fields={...launch,adapter,provider:connection};
  assert.equal(isLaunchDefaults(fields),true,adapter);
  assert.deepEqual(projectLaunchFields(fields),fields);
  const template=createLaunchTemplate(adapter,fields,()=> '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(decodeLaunchTemplates(encodeLaunchTemplates([template])),[template]);
  assert.equal(providerChoice(adapter,decodeLaunchTemplates(encodeLaunchTemplates([template]))[0].provider),adapter==='claude'?'deepseek-claude':'deepseek');
 }
});

test('the launch form offers both DeepSeek executors explicitly',()=>{
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(source,/<option value="deepseek">DeepSeek<\/option>/);
 assert.match(source,/<option value="deepseek-claude">DeepSeek<\/option>/);
});

function changeActualCli(adapter,provider,target,previousEdits={}) {
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declarations=[];let callback;
 function visit(node){
  if(ts.isFunctionDeclaration(node)&&['editLaunch','changeProviderFields','changeAdapter'].includes(node.name?.text))declarations.push(node.getText(source));
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='div'&&node.openingElement.attributes.properties.some(attr=>attr.name?.getText(source)==='aria-label'&&attr.initializer?.text==='Startup program')){
   function choice(child){if(ts.isJsxElement(child)&&child.openingElement.tagName.getText(source)==='button')callback=child.openingElement.attributes.properties.find(attr=>attr.name?.getText(source)==='onClick').initializer.expression.getText(source);ts.forEachChild(child,choice);}choice(node);
  }
  ts.forEachChild(node,visit);
 }
 visit(source);assert.ok(callback,'actual CLI button callback');
 const selected={adapter,provider,edits:previousEdits};
 const formLaunch={adapter,provider,mode:'interactive',extra_args:'--verbose',prompt:'keep prompt'};
 const bindings={adapter:{id:target},useProjectSettings:false,launchWorktreeAttempt:undefined,launchDirectoryOverride:"/project",formLaunch,formAdapter:adapter,providerPreset,providerChoice,supportsProvider,setError:value=>selected.error=value,setLaunchDraft:update=>{const next=update({adapter:selected.adapter,provider:selected.provider});selected.adapter=next.adapter;selected.provider=next.provider;},setProjectLaunchEdits:update=>selected.edits=update(selected.edits)};
 const change=new Function(...Object.keys(bindings),ts.transpile(declarations.join('\n')+'\nreturn ('+callback+');',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
 change();return selected;
}

test('explicit CLI switching follows the DeepSeek default protocol in both directions',()=>{
 for(const [from,to] of [['codex','claude'],['claude','codex']]){
  const original={...providerPreset(from==='claude'?'deepseek-claude':'deepseek').provider,model:'selected-model',api_key_env:'SELECTED_KEY_REF'};
  const saved=structuredClone(original),result=changeActualCli(from,original,to);
  const endpoint=providerPreset(to==='claude'?'deepseek-claude':'deepseek').provider.base_url;
  assert.equal(result.adapter,to);assert.deepEqual(result.provider,{...original,base_url:endpoint});
  assert.deepEqual(original,saved,'selection must not mutate saved input');
  assert.deepEqual(result.edits,{adapter:to,provider:result.provider});
 }
});

test('CLI switching preserves manual endpoints, native mode and other Provider selections',()=>{
 const customEndpoint={...provider,base_url:'https://gateway.example.test/custom'};
 const customProvider={...provider,id:'custom'};
 for(const [from,current,to] of [['codex',customEndpoint,'claude'],['codex',customProvider,'claude'],['codex',null,'claude'],['codex',provider,'codex']]){
  const result=changeActualCli(from,current,to);
  assert.equal(result.adapter,to);assert.equal(result.provider,current);
  assert.deepEqual(result.edits,{adapter:to});
 }
});

test('CLI switching merges trusted project edits without resetting model, prompt or arguments',()=>{
 const original={...provider,model:'project-model',api_key_env:'PROJECT_KEY_REF'};
 const edits={prompt:'project prompt',extra_args:'--verbose',mode:'interactive',env_refs:{CUSTOM:'CUSTOM_REF'},provider:original};
 const result=changeActualCli('codex',original,'claude',edits);
 assert.deepEqual(result.edits,{...edits,adapter:'claude',provider:{...original,base_url:providerPreset('deepseek-claude').provider.base_url}});
 assert.equal(edits.provider,original);assert.equal(edits.provider.base_url,'https://api.deepseek.com');
});

test('provider connection remains separate from CLI and survives a saved template',()=>{
 const fields={...launch,provider};
 assert.equal(isLaunchDefaults(fields),true);
 assert.deepEqual(projectLaunchFields(fields),fields);
 const template=createLaunchTemplate('DeepSeek',fields,()=> '11111111-1111-4111-8111-111111111111');
 const raw=encodeLaunchTemplates([template]);
 assert.deepEqual(decodeLaunchTemplates(raw),[template]);
 assert.deepEqual(decodeLaunchTemplates(raw)[0].provider,provider);
 assert.equal(raw.includes('DEEPSEEK_API_KEY'),true);
});

test('provider connection rejects invalid endpoints, credentials, and unknown fields',()=>{
 for(const invalid of [
  {...provider,base_url:'http://example.com'},
  {...provider,base_url:'https://user:password@example.com'},
  {...provider,base_url:'https://example.com?key=plain-secret'},
  {...provider,base_url:'https://example.com#secret'},
  {...provider,model:''},
  {...provider,api_key_env:'sk-plain-secret'},
  {...provider,api_key_env:null},
  {...provider,api_key:'plain-secret'},
  {...provider,id:'unknown'},
 ])assert.equal(isLaunchDefaults({...launch,provider:invalid}),false);
});

test('provider local gateway can hold the upstream key outside YAM',()=>{
 assert.equal(isLaunchDefaults({...launch,provider:{...provider,model:'deepseek/deepseek-flash',base_url:'http://127.0.0.1:3425/v1',api_key_env:null}}),true);
});

test('legacy templates retain their original exact shape',()=>{
 assert.equal(isLaunchDefaults(launch),true);
 assert.deepEqual(projectLaunchFields(launch),launch);
});

test('actual App launch submits a separate DeepSeek connection snapshot',async()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let body;const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='startSession')body=node.getText(source);ts.forEachChild(node,visit);};visit(source);assert.ok(body);
 const calls=[],errors=[];
 const bindings={formLaunch:{codex:{image_mode:"native"}},supportsProvider,...layout,isMainWindow:true,desktopWindow:{restore_blocked:false},cancelLayoutRestore(){},starting:false,creatingSession:{current:false},terminalLayoutRef:{current:layout.createTerminalLayout()},terminalViews:{current:{canOpen:true,reserveAdmission:()=>true,releaseAdmission(){}}},useProjectSettings:false,projectConfigBusy:false,projectPreview:null,projectTemplate:'',projectLaunchEdits:{},adapters:[{id:'codex',label:'Codex',available:true}],selectedAdapter:'codex',providerConfig:provider,isProviderConfig:()=>true,command:'',cwd:'/project',prompt:'',adapterArgs:'',launchMode:'interactive',setError:v=>{if(v)errors.push(v);},setStarting(){},setActiveProject(){},setCollapsedProjects(){},setSessionTitles(){},setSshOpen(){},localStorage:{setItem(){}},projectToolsDialog:{current:null},launchDialog:{current:null},openHistory:async()=>{},refreshHistory:async()=>{},invoke:async(name,args)=>{calls.push({name,args});return {session_id:'s-provider',cwd:'/project',command:null,status:'running',launch:args.launch};}};
 const start=new Function(...Object.keys(bindings),ts.transpile(body,{target:ts.ScriptTarget.ES2022})+';return startSession;')(...Object.values(bindings));
 await start();assert.deepEqual(errors,[]);assert.equal(calls.length,1);assert.equal(calls[0].name,'create_session');
 assert.deepEqual(calls[0].args.launch,{adapter:'codex',mode:'interactive',extra_args:'',prompt:null,provider,codex:{image_mode:'native'}});
});

test('history exposes previous execution logs within a continued conversation',()=>{const src=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.match(src,/record\.previous_runs\.map/);assert.match(src,/onClick=\{\(\)=>void openSession\(id,undefined,undefined,true\)\}/);});

test('Claude and Gemini API snapshots retain the chosen native runner',()=>{for(const [id,adapter] of [['claude','claude'],['gemini','gemini'],['gemini','claude']]){const v={...launch,adapter,provider:{id,model:'editable-model',base_url:'http://127.0.0.1:3425',api_key_env:null}};assert.equal(isLaunchDefaults(v),true,`${id}/${adapter}`);assert.deepEqual(decodeLaunchTemplates(encodeLaunchTemplates([createLaunchTemplate(id,v,()=>"11111111-1111-4111-8111-111111111111")]))[0].provider,v.provider);}});

test('source presets select Codex, Claude and Gemini native CLIs and explicit gateway mapping',()=>{for(const [choice,adapter,managed] of [['codex','codex',false],['claude','claude',false],['gemini','gemini',false],['deepseek','codex',true],['claude-api','claude',true],['gemini-api','gemini',true],['gemini-claude','claude',true]]){const value=providerPreset(choice);assert.equal(value.adapter,adapter);assert.equal(!!value.provider,managed);assert.equal(providerChoice(adapter,value.provider),choice);if(managed)assert.equal(supportsProvider(adapter,value.provider),true);}});

test('actual App connection selection keeps the selected runner and edits only provider settings',()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const functions=[];function walk(n){if(ts.isFunctionDeclaration(n)&&['editLaunch','changeProvider'].includes(n.name?.text))functions.push(n.getText(source));ts.forEachChild(n,walk);}walk(source);
 let draft={...launch,adapter:'claude',extra_args:'--verbose',prompt:'keep'},edits={};const bindings={formLaunch:draft,providerPreset,supportsProvider,formAdapter:'claude',setError:assert.fail,setLaunchDraft:fn=>draft=fn(draft),setProjectLaunchEdits:fn=>edits=fn(edits)};
 const change=new Function(...Object.keys(bindings),ts.transpile(functions.join('\n'),{target:ts.ScriptTarget.ES2022})+';return changeProvider;')(...Object.values(bindings));
 change('gemini-claude');assert.equal(draft.adapter,'claude','connection selection does not choose the runner');assert.equal(draft.provider.id,'gemini');assert.equal(draft.extra_args,'--verbose');assert.equal(draft.prompt,'keep');assert.deepEqual(Object.keys(edits),['provider']);
 change('inherited');assert.equal(draft.provider,null);
});

test('actual desktop facade rejects old native app before reserving or creating a provider session',async()=>{const {desktopInvoke}=await import('../src/window-context.ts');for(const args of [{launch:{...launch,provider}},{resumeFrom:'old-managed-session'},{projectConfig:{root:'/project'}}]){const calls=[];await assert.rejects(desktopInvoke(async name=>{calls.push(name);throw Error('unknown command');},{slot:'main',epoch:1},'create_session',args),/updated YAM|provider isolation/i);assert.deepEqual(calls,['provider_protocol_version']);}const calls=[];await desktopInvoke(async name=>{calls.push(name);return name==='provider_protocol_version'?1:name==='reserve_terminal_start'?2:{};},{slot:'main',epoch:1},'create_session',{launch:{...launch,provider}});assert.deepEqual(calls,['provider_protocol_version','reserve_terminal_start','create_session']);});

test('provider capability rejects wrong versions and maps old owner refusal without retry',async()=>{const {desktopInvoke}=await import('../src/window-context.ts');for(const version of [0,2,'1',null]){const calls=[];await assert.rejects(desktopInvoke(async name=>{calls.push(name);return version;},{slot:'main',epoch:1},'create_session',{resumeFrom:'stored'}),/updated YAM/);assert.deepEqual(calls,['provider_protocol_version']);}const calls=[];await assert.rejects(desktopInvoke(async name=>{calls.push(name);if(name==='provider_protocol_version')return 1;if(name==='reserve_terminal_start')return 2;throw 'Invalid background command arguments';},{slot:'main',epoch:1},'create_session',{launch:{...launch,provider}}),/updated YAM/);assert.deepEqual(calls,['provider_protocol_version','reserve_terminal_start','create_session']);});

test('continued history puts previous runs below its title and pin controls',()=>{
 const css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
 assert.match(css,/\.session-item\s*\{[^}]*flex-wrap:\s*wrap/);
 assert.match(css,/\.session-runs\s*\{[^}]*flex(?:-basis)?:[^;}]*100%/);
});

test('T3 native connection details describe inherited configuration without claiming an account or model',()=>{
 assert.equal(typeof providerConfig.connectionDetails,'function','connection details must use saved launch metadata');
 for(const adapter of ['codex','claude','gemini','opencode']){
  const details=providerConfig.connectionDetails({adapter,extra_args:'--model current-cli-choice'});
  assert.equal(details.cli,adapter);assert.match(details.source,/inherited CLI configuration/i);assert.equal(details.model,'Unknown');assert.equal(details.endpoint,'Unknown');
  assert.doesNotMatch(JSON.stringify(details),/subscription|official|native login|current-cli-choice/i);
 }
});

test('T3 managed API and gateway details show only known startup settings',()=>{
 assert.equal(typeof providerConfig.connectionDetails,'function');
 for(const saved of [provider,{id:'custom',model:'provider/model',base_url:'http://127.0.0.1:3425/v1',api_key_env:null}]){
  const details=providerConfig.connectionDetails({adapter:'codex',provider:saved});
  assert.equal(details.cli,'codex');assert.match(details.source,/YAM isolated API configuration/);assert.equal(details.model,saved.model);assert.equal(details.endpoint,new URL(saved.base_url).href);
  assert.equal(JSON.stringify(details).includes('DEEPSEEK_API_KEY'),false);assert.equal(Object.hasOwn(details,'api_key_env'),false);
 }
});

test('T3 incomplete history and credential-bearing legacy URLs cannot leak secret components',()=>{
 assert.equal(typeof providerConfig.connectionDetails,'function');
 for(const launch of [undefined,null,{}, {adapter:'codex',provider:{model:'partial'}}]){
  const details=providerConfig.connectionDetails(launch);assert.equal(details.model,'Unknown');assert.equal(details.endpoint,'Unknown');assert.match(details.source,/unknown|inherited/i);
 }
 const details=providerConfig.connectionDetails({adapter:'codex',provider:{...provider,base_url:'https://USER_SENTINEL:PASSWORD_SENTINEL@example.test/v1?key=QUERY_SENTINEL#FRAGMENT_SENTINEL',api_key:'KEY_SENTINEL'}});
 assert.equal(details.endpoint,'https://example.test/v1');assert.match(details.source,/unknown/i);
 for(const text of ['USER_SENTINEL','PASSWORD_SENTINEL','QUERY_SENTINEL','FRAGMENT_SENTINEL','KEY_SENTINEL'])assert.equal(JSON.stringify(details).includes(text),false);
 for(const base_url of ['not a URL','javascript:SECRET_SENTINEL','data:text/plain,SECRET_SENTINEL','https://'+'x'.repeat(2100)])assert.equal(providerConfig.connectionDetails({adapter:'codex',provider:{...provider,base_url}}).endpoint,'Unknown');
});

test('CC Switch preset uses the existing custom provider schema and CLI-specific local paths',()=>{
 for(const adapter of ['codex','claude','gemini']){
  const next=providerPreset('cc-switch',adapter);
  assert.equal(next.adapter,adapter);assert.equal(next.provider.id,'custom');assert.equal(next.provider.model,'');
  assert.equal(next.provider.base_url,`http://127.0.0.1:15721${adapter==='codex'?'/v1':''}`);assert.equal(next.provider.api_key_env,null);
  assert.equal(providerChoice(adapter,{...next.provider,model:'chosen/model'}),'cc-switch');
 }
});

test('EchoBird presets retain isolated custom snapshots and compatible local API paths',()=>{
 for(const adapter of ['codex','claude']){
  const next=providerPreset('echobird',adapter);assert.equal(next.adapter,adapter);assert.equal(next.provider.id,'custom');assert.equal(next.provider.model,'');
  assert.equal(next.provider.base_url,`http://127.0.0.1:53683${adapter==='codex'?'/v1':''}`);assert.equal(next.provider.api_key_env,null);
  assert.equal(providerChoice(adapter,{...next.provider,model:'chosen/model'}),'echobird');
 }
});
test('installed service presets are conditional and EchoBird is not offered as a native Gemini API',()=>{
 const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');const ast=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let select;
 function visit(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='Select'&&n.openingElement.attributes.properties.some(p=>p.name?.getText(ast)==='aria-label'&&p.initializer?.text==='Service preset'))select=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(select);
 const React={createElement:(type,props,...children)=>({type,props,children:children.flat(Infinity)})};
 const render=new Function('React','installedGateways','formAdapter','formLaunch','providerChoice','changeProvider','const Select="select";'+ts.transpile('return ('+select.getText(ast)+');',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}));
 const options=(installed,adapter)=>{const tree=render(React,installed,adapter,{provider:providerPreset('custom').provider},providerChoice,()=>{});return tree.children.filter(n=>n&&typeof n==='object').flatMap(n=>n.type==='option'?[n.props.value]:n.children?.filter(c=>c?.type==='option').map(c=>c.props.value)??[]);};
 assert.equal(options([],'codex').includes('cc-switch'),false);assert.equal(options([],'codex').includes('echobird'),false);
 assert.ok(options(['cc-switch','echobird'],'codex').includes('cc-switch'));assert.ok(options(['cc-switch','echobird'],'codex').includes('echobird'));
 assert.equal(options(['echobird'],'gemini').includes('echobird'),false);
});

test('local gateway CLI changes migrate only default protocol paths and retain the selected model and key reference',()=>{
 for(const [preset,from,to] of [
  ['cc-switch','codex','claude'],['cc-switch','claude','codex'],['cc-switch','codex','gemini'],['cc-switch','gemini','codex'],
  ['echobird','codex','claude'],['echobird','claude','codex']
 ]){
  const original={...providerPreset(preset,from).provider,model:'chosen/model',api_key_env:'KEY_REFERENCE'};const saved=structuredClone(original);
  const result=changeActualCli(from,original,to,{prompt:'keep prompt',extra_args:'--verbose'});
  assert.equal(result.adapter,to);assert.deepEqual(result.provider,{...original,base_url:providerPreset(preset,to).provider.base_url});
  assert.equal(providerChoice(to,result.provider),preset);assert.deepEqual(original,saved);
  assert.equal(result.edits.prompt,'keep prompt');assert.equal(result.edits.extra_args,'--verbose');
 }
});
test('local gateway manual URLs remain literal when changing native CLI',()=>{
 for(const preset of ['cc-switch','echobird']){
  const original={...providerPreset(preset,'codex').provider,model:'chosen/model',base_url:'http://127.0.0.1:49999/custom/v1',api_key_env:'KEY_REFERENCE'};
  const result=changeActualCli('codex',original,'claude');assert.equal(result.adapter,'claude');assert.equal(result.provider,original);
 }
});
test('known EchoBird connection refuses Gemini before changing any draft fields',()=>{
 for(const from of ['codex','claude']){
  const original={...providerPreset('echobird',from).provider,model:'chosen/model'};const edits={prompt:'keep prompt'};
  const result=changeActualCli(from,original,'gemini',edits);
  assert.equal(result.adapter,from);assert.equal(result.provider,original);assert.equal(result.edits,edits);assert.match(result.error,/EchoBird.*Gemini/);
 }
});
