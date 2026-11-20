// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as policies from '../src/routing-policies.ts';
import * as pi from '../src/pi-routing.ts';
import {defaultTierRules} from '../src-tauri/pi/task-rules.mjs';
import {readCodexPolicy} from '../src-tauri/pi/codex-route-config.mjs';
import {classifyNativeTurn,createCodexTurnRouter} from '../../../scripts/codex-auto-route.mjs';

const draft={gateway:null,small:'p/light',medium:'p/regular',strong:'p/deep',classifier:'p/classifier',model:'p/old-fixed',effort:'max',rules:JSON.stringify(defaultTierRules)};
const config={connections:{p:{billing:'subscription',native:true}},classifiers:['p/classifier'],executionGroups:[{small:draft.small,medium:draft.medium,strong:draft.strong}],model:draft.model,effort:draft.effort,rules:defaultTierRules};
const answer={intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']};

test('desktop automatic policies discard legacy global overrides when edited, launched or switched',()=>{
 const row={id:'auto',name:'Automatic',adapter:'codex',setup:JSON.stringify(config)};
 const loaded=policies.codexRoutingDraft(row.setup);
 assert.equal(loaded.model,'auto');assert.equal(loaded.effort,'auto');
 const built=JSON.parse(policies.buildCodexRoutingConfig(row.setup,{...loaded,model:draft.model,effort:'max'}));
 assert.equal(built.model,undefined);assert.equal(built.effort,undefined);
 assert.deepEqual(built.executionGroups,config.executionGroups);
 const launched=JSON.parse(policies.codexRoutingLaunch('auto',[row]).config);
 assert.equal(launched.model,undefined);assert.equal(launched.effort,undefined);
 const saved=JSON.stringify(pi.piSetupMapping(draft,''));
 assert.equal(JSON.parse(saved).model,'auto');assert.equal(JSON.parse(saved).effort,'auto');
 const payload=policies.routingPolicyPayload({...row,adapter:'pi',setup:JSON.stringify({...draft,rules:defaultTierRules})});
 assert.equal(payload.model,'auto');assert.equal(payload.effort,'auto');
 const restored=readCodexPolicy(row.setup,{automatic:true});
 assert.equal(restored.model,undefined);assert.equal(restored.effort,undefined);
 assert.throws(()=>readCodexPolicy(JSON.stringify({...config,executionGroups:[{}]}),{automatic:true}),/execution model/);
});

test('classifier reasoning survives Codex and Pi settings, launch and portable backup without locking execution',()=>{
 const selected={...draft,model:'auto',effort:'auto',classifierEffort:'high'};
 const raw=policies.buildCodexRoutingConfig(JSON.stringify(config),selected);
 assert.equal(readCodexPolicy(raw).classifierEffort,'high');
 assert.equal(policies.codexRoutingDraft(raw).classifierEffort,'high');
 const args=pi.buildPiArgs('',selected),mapping=pi.piSetupMapping(selected,args);
 assert.equal(pi.parsePiDraft(args).classifierEffort,'high');
 assert.equal(pi.portablePiRoutingPolicy(JSON.stringify(mapping)).classifierEffort,'high');
 assert.equal(pi.parsePiDraft(pi.restorePiSetup('',JSON.stringify(mapping))).classifierEffort,'high');
 assert.equal(pi.portablePiRoutingPolicy(pi.importPiRoutingPolicy(pi.portablePiRoutingPolicy(JSON.stringify(mapping)))).classifierEffort,'high');
 for(const classifierEffort of ['',null,'auto','bogus']){
  assert.throws(()=>readCodexPolicy(JSON.stringify({...config,classifierEffort})),/classifier reasoning/i);
  assert.match(pi.validatePiDraft({...selected,classifierEffort}),/classifier reasoning/i);
 }
});

test('native classifier receives only its own reasoning and automatic execution follows the task rules',async()=>{
 const seen=[];
 await classifyNativeTurn({policy:{...config,classifierEffort:'low'},prompt:'Explain 404',previousPrompt:''},process.execPath,'/tmp','/tmp/routing-mode-test',{
  classify:async request=>{seen.push(request.effort);return JSON.stringify(answer);},
 });
 assert.deepEqual(seen,['low']);
 const row={id:'auto',name:'Automatic',adapter:'codex',setup:JSON.stringify(config)};
 const automatic=JSON.parse(policies.codexRoutingLaunch('auto',[row]).config);
 let classified=0;
 const router=createCodexTurnRouter({config:automatic,connectionName:'p',models:[draft.small,draft.medium,draft.strong].map(key=>({key,levels:['medium','high','max'],input:['text']})),initial:{threadId:'main'},classify:async()=>{classified++;return {answer,source:'A'};}});
 const request={id:1,method:'turn/start',params:{threadId:'main',input:[{type:'text',text:'Explain 404'}]}};
 const routed=await router.request(request);
 assert.equal(routed.params.model,'light');assert.equal(routed.params.effort,'medium');assert.equal(classified,1);
 const disabled=createCodexTurnRouter({config:automatic,connectionName:'p',models:[],initial:{threadId:'main',enabled:false},classify:async()=>{classified++;throw Error('must not classify');}});
 assert.equal(await disabled.request(request),request);assert.equal(classified,1);
});

test('automatic settings expose classification reasoning and execution rules without routing preferences',()=>{
 const source=readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8');
 const settings=source.slice(source.indexOf('export function PiRoutingConfig('),source.indexOf('export function RoutingPolicyChoice('));
 assert.doesNotMatch(settings,/Routing preferences|Reasoning selection|Model selection/);
 assert.match(settings,/Classifier reasoning/);
 assert.match(source,/export function NativeModelDefaults/);
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/!routingChoice[\s\S]{0,180}<NativeModelDefaults/);
});

test('routing-off defaults preserve advanced literals and prompt terminators for both CLIs',()=>{
 assert.equal(typeof pi.buildNativeModelArgs,'function');
 for(const adapter of ['pi','codex']){
  const args='--append-system-prompt "literal $HOME `date` --model" -- --model prompt';
  const saved=pi.buildNativeModelArgs(adapter,args,{model:'vendor/model',effort:'high'});
  assert.deepEqual(pi.parseNativeModelDefaults(adapter,saved),{model:'vendor/model',effort:'high'});
  assert.ok(saved.includes('--append-system-prompt "literal $HOME `date` --model"'));
  assert.ok(saved.endsWith('-- --model prompt'));
  const replaced=pi.buildNativeModelArgs(adapter,saved,{model:'',effort:''});
  assert.deepEqual(pi.parseNativeModelDefaults(adapter,replaced),{model:'',effort:''});
  assert.throws(()=>pi.buildNativeModelArgs(adapter,'',{model:'bad;model',effort:'high'}),/model/i);
  assert.throws(()=>pi.buildNativeModelArgs(adapter,'',{model:'ok',effort:'auto'}),/reasoning/i);
  assert.throws(()=>pi.parseNativeModelDefaults(adapter,'--model'),/Missing/);
  assert.throws(()=>pi.parseNativeModelDefaults(adapter,'--model "unterminated'),/quote/i);
 }
 assert.deepEqual(pi.parseNativeModelDefaults('codex','-m old -c model_reasoning_effort="low" --model=new --config=model_reasoning_effort="high"'),{model:'new',effort:'high'});
 assert.deepEqual(pi.parseNativeModelDefaults('pi','--model p/model:high'),{model:'p/model',effort:'high'});
 for(const model of ['p/model@2026','p/模型'])assert.equal(pi.parseNativeModelDefaults('pi',pi.buildNativeModelArgs('pi','',{model,effort:'high'})).model,model);
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(app,/buildNativeModelArgs\("codex",launch.extra_args,\{model:"",effort:""\}\)/);
});

test('routing-off model picker lists only models accepted by the native executor',async()=>{
 const ts=(await import('typescript')).default;
 const source=ts.createSourceFile('PiRouting.tsx',readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='NativeModelDefaults');
 const code=ts.transpileModule(fn.getText(source).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React}}).outputText;
 for(const adapter of ['pi','codex']){
  const slots=[],effects=[];let index=0,args='';
  const models=[{key:'p/native',name:'Native',levels:['high']},{key:'yam-codex/subscription',levels:['high']},{key:'yam-gateway/paid',levels:['high']}];
  const env={...pi,...policies,useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>slots[i]=value];},useEffect:fn=>effects.push(fn),t:text=>text,Select:'select',RoutingModelPicker:'model-picker',React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
  const component=new Function(...Object.keys(env),code+';return NativeModelDefaults;')(...Object.values(env));
  const render=()=>{index=0;return component({adapter,args,cwd:'/tmp',invoke:async()=>({models}),onChange:value=>args=value});};
  const all=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(all)];
  render();const cleanup=effects.shift()();await new Promise(resolve=>setImmediate(resolve));
  const picker=all(render()).find(node=>node.type==='model-picker');
  if(adapter==='pi')assert.deepEqual(picker.props.models.map(model=>model.key),['p/native']);
  const model=adapter==='pi'?'p/native':'yam-codex/subscription';
  picker.props.onChange({target:{value:model}});
  all(render()).find(node=>node.props['aria-label']==='Default reasoning').props.onChange({target:{value:'high'}});
  assert.deepEqual(pi.parseNativeModelDefaults(adapter,args),{model:adapter==='pi'?model:'subscription',effort:'high'});
  cleanup();
 }
});
