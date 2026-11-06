import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as budgetPolicy from '../src-tauri/pi/policy.mjs';
import {decide, guardCapacity, resolveEffort} from '../src-tauri/pi/policy.mjs';
test('automatic high never silently increases to max while explicit max remains available',()=>{
 const model={id:'only-max',reasoning:true,thinkingLevelMap:{max:'max'}};
 assert.throws(()=>resolveEffort(model,'high','off'),/unsupported/i);
 assert.equal(resolveEffort(model,'max','max'),'max');
});

const previous={v:1,model:'strong',effort:'max',task:'fix bug'};
test('Pi routing distinguishes independent retrieval, coding and high-risk work',()=>{
 assert.deepEqual(decide({intent:'new',difficulty:'simple',uncertain:false},previous),{model:'small',effort:'medium'});
 assert.deepEqual(decide({intent:'new',difficulty:'complex',uncertain:false},previous),{model:'strong',effort:'high'});
 assert.deepEqual(decide({intent:'new',difficulty:'critical',uncertain:false},previous),{model:'strong',effort:'max'});
 assert.deepEqual(decide({intent:'continue',difficulty:'simple',uncertain:false},previous),{model:'strong',effort:'max'});
});
test('Pi classifier failure and malformed decisions preserve strong model and effort floor',()=>{
 for(const answer of [null,{}, {intent:'new',difficulty:'simple',uncertain:true}, {intent:'new',difficulty:'simple',uncertain:'false'}])assert.deepEqual(decide(answer,previous),{model:'strong',effort:'max'});
 assert.deepEqual(decide(null),{model:'strong',effort:'high'});
});
test('Pi explicit reasoning is exact; auto maps by advertised provider support',()=>{
 const model={reasoning:true,thinkingLevelMap:{medium:'medium',high:'high',max:'max'}};
 assert.equal(resolveEffort(model,'high','max'),'max');
 assert.equal(resolveEffort(model,'xhigh','off'),'max');
 assert.throws(()=>resolveEffort(model,'high','xhigh'),/unsupported/i);
 assert.throws(()=>resolveEffort({reasoning:false},'high','max'),/unsupported/i);
});
test('Pi capacity guard prevents a downgrade causing compaction or losing images',()=>{
 const small={contextWindow:100,maxTokens:20,input:['text']},strong={contextWindow:1000,maxTokens:100,input:['text','image']};
 assert.equal(guardCapacity('small',[{role:'user',content:'hi'}],small,strong),'small');
 assert.equal(guardCapacity('small',[{role:'user',content:'x'.repeat(100)}],small,strong),'strong');
 assert.equal(guardCapacity('small',[{role:'user',content:[{type:'image',data:'x'}]}],small,strong),'strong');
});

test('T3 context budgets use per-message estimates and Pi reserve independently of output limits and usage',()=>{
 assert.equal(typeof budgetPolicy.measureContextBudget,'function');
 const messages=[{role:'system',content:'PRIVATE',toolsAdded:[{name:'read'}]},{role:'user',content:[{type:'image',data:'x'.repeat(50000)}]},{role:'assistant',content:[],usage:{input:900000,output:900000}}],seen=[];
 const deps={estimateMessageTokens:m=>{seen.push(m);return 100;},getReserveTokens:()=>20};
 const result=budgetPolicy.measureContextBudget({contextWindow:320,maxTokens:0},messages,deps);
 assert.equal(result.fits,true);assert.equal(result.inputTokens,300);assert.equal(result.reserveTokens,20);assert.equal(result.maxOutputTokens,null);assert.equal(result.kind,'local-estimate');assert.deepEqual(seen,messages);
 assert.equal(budgetPolicy.measureContextBudget({contextWindow:319,maxTokens:999999},messages,deps).reason,'context-limit');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|900000|xxxxx|toolsAdded/);
 for(const window of [0,undefined,NaN,Infinity,-1])assert.equal(budgetPolicy.measureContextBudget({contextWindow:window},[],deps).reason,'context-unknown');
 for(const reserve of [-1,NaN,Infinity,'20'])assert.equal(budgetPolicy.measureContextBudget({contextWindow:1000},messages,{...deps,getReserveTokens:()=>reserve}).fits,false);
 for(const estimate of [-1,NaN,Infinity,undefined])assert.equal(budgetPolicy.measureContextBudget({contextWindow:1000},messages,{...deps,estimateMessageTokens:()=>estimate}).fits,false);
 assert.equal(budgetPolicy.measureContextBudget({contextWindow:1000},messages,{...deps,getReserveTokens:()=>{throw Error('PRIVATE_SETTINGS');}}).fits,false);
});

test('Pi is an independent launch choice with native configuration and no official connection migration',async()=>{
 const {isLaunchDefaults}=await import('../src/project-config.ts');
 const base={adapter:'pi',mode:'interactive',extra_args:'--yam-small native/small --yam-strong native/strong',prompt:null,command:null,provider:null};
 assert.equal(isLaunchDefaults(base),true);
 assert.equal(isLaunchDefaults({...base,provider:{id:'custom',model:'m',base_url:'http://127.0.0.1:3425',api_key_env:null}}),false);
});

import install from '../src-tauri/pi/router.mjs';
import {defaultRules,rulesVersion} from '../src-tauri/pi/task-rules.mjs';
function fixture({answer={intent:'new',difficulty:'simple',uncertain:false,readOnly:true,reason:'read only'},selected='off',state,raw=false,native,budget={estimateMessageTokens:()=>128,getReserveTokens:()=>16384}}={}) {
 // Older policy test cases keep their difficulty shorthand; actual classifier mocks use task facts.
 if(!raw&&answer&&['simple','complex','critical'].includes(answer.difficulty))answer={...answer,task:answer.difficulty==='simple'?'answer':answer.difficulty==='critical'?'review':'coding',context:'independent',action:answer.readOnly===false?'write':'none',depth:answer.difficulty==='critical'?'deep':'normal',readOnly:answer.readOnly??false};
 const handlers={},commands={},renderers={},flags={'yam-small':'p/small','yam-strong':'p/strong'},entries=[],statuses=[];
 const models=Object.fromEntries(['small','strong'].map(id=>[id,{provider:'p',id,reasoning:true,api:'openai-responses',contextWindow:100000,maxTokens:10000,input:['text','image'],thinkingLevelMap:Object.fromEntries(['off','low','medium','high','xhigh','max'].map(v=>[v,v]))}]));
 let classifierCalls=0,definition;
 const pi={registerEntryRenderer:(name,fn)=>renderers[name]=fn,on:(name,fn)=>handlers[name]=fn,registerCommand:(name,v)=>commands[name]=v,registerFlag(){},getFlag:n=>flags[n],registerVirtualModel:v=>{definition=v;models.auto={provider:v.provider,id:v.id,api:"pi-virtual",reasoning:true,thinkingLevelMap:Object.fromEntries(v.thinkingLevels.map(level=>[level,level]))};},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),setModel:async()=>true,setThinkingLevel:v=>selected=v,getThinkingLevel:()=>selected};
 const nativeCalls=[];
 const adapter=native??{resolveModel:(_ctx,m)=>m,stream:(...args)=>{nativeCalls.push(args);return {result:()=>ctx.modelRegistry.complete(...args)};}};
 const ready=install(pi,m=>Object.keys(m.thinkingLevelMap),class Text {constructor(text){this.text=text;}},adapter,budget);
 const ctx={model:{api:'pi-virtual',provider:'yam',id:'auto'},isIdle:()=>true,ui:{setStatus:(...v)=>statuses.push(v),notify(){},select:async()=>null},sessionManager:{getBranch:()=>entries,getSessionFile:()=>null,buildSessionProjection:()=>({})},modelRegistry:{find:(_p,id)=>models[id],getAvailable:()=>Object.values(models),hasConfiguredAuth:()=>true,complete:async()=>{classifierCalls++;if(answer instanceof Error)throw answer;return {content:[{type:'text',text:JSON.stringify(answer)}]};}}};
 ctx.modelRegistry.streamSimple=(...args)=>({result:()=>ctx.modelRegistry.complete(...args)});
 const route=(extra={})=>definition.route({reason:'user',thinkingLevel:selected,messages:[{role:'user',content:'read a file'}],state,...extra},ctx);
 return {pi,route,ctx,handlers,commands,renderers,models,statuses,ready,flags,nativeCalls,get calls(){return classifierCalls;},entries};
}

async function tierFixture(options={}){
 const f=fixture(options);f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);return f;
}
test('T3 candidate selection combines exact effort and context before committing a main model',async()=>{
 const routes=[],f=await tierFixture({selected:'high',native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)},budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}});
 f.models.small.contextWindow=150;f.models.medium.contextWindow=1000;f.models.medium.thinkingLevelMap={medium:'medium'};f.models.strong.contextWindow=600;
 const result=await f.route(),decision=(await f.ready).snapshot().decision;
 assert.equal(result.model.id,'strong');assert.equal(result.thinkingLevel,'high');assert.equal(routes.length,1);
 assert.deepEqual(decision.planned,{model:'small',effort:'medium'});assert.deepEqual(decision.selected,{model:'strong',effort:'high'});
 assert.equal(decision.budget.inputTokens,200);assert.equal(decision.budget.reserveTokens,20);
 assert.deepEqual(decision.rejected.map(r=>[r.model,r.reason]),[['p/small','context-limit'],['p/medium','effort']]);
});
test('T3 unknown windows and smaller high tiers do not manufacture context capacity',async()=>{
 const f=await tierFixture({budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>0}});f.models.small.contextWindow=undefined;f.models.medium.contextWindow=100;f.models.strong.contextWindow=undefined;
 await assert.rejects(f.route(),/context|budget/i);const snapshot=(await f.ready).snapshot();assert.equal(snapshot.failure.category,'context');assert.equal(snapshot.failure.dispatch,'not-started');assert.equal(snapshot.target,null);assert.equal(snapshot.decision.rejected.length,3);
});
test('T3 token estimates replace the v2 byte heuristic without consuming foreign usage',async()=>{
 const f=await tierFixture({budget:{estimateMessageTokens:()=>100,getReserveTokens:()=>0}});f.models.small.contextWindow=200;f.models.small.maxTokens=0;
 const result=await f.route({messages:[{role:'assistant',content:[],provider:'other',model:'old',usage:{input:999999,output:999999}},{role:'user',content:'中文'.repeat(5000)}]});assert.equal(result.model.id,'small');assert.equal((await f.ready).snapshot().decision.budget.inputTokens,200);assert.equal((await f.ready).snapshot().decision.budget.maxOutputTokens,null);
});
test('T3 fixed, continued, uncertain and sticky choices stop at their own budget without changing model',async()=>{
 for(const intent of ['continue','uncertain']){
  const routes=[],f=await tierFixture({answer:{intent:'continue',difficulty:'complex',uncertain:intent==='uncertain'},state:{v:2,model:'medium',effort:'high',mode:'task'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)},budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}});
  f.models.medium.contextWindow=219;await assert.rejects(f.route(),/context|budget/i);assert.equal(routes.length,0);assert.equal((await f.ready).snapshot().failure.nextAction,'reduce-context');
 }
 const f=await tierFixture({budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}}),api=await f.ready;
 await api.control({action:'set',revision:api.snapshot().revision,data:{model:'p/medium',effort:'high'}});f.models.medium.contextWindow=219;await assert.rejects(f.route(),/context|budget/i);assert.equal(api.snapshot().preferences.model,'p/medium');
 await api.control({action:'reset',revision:api.snapshot().revision});f.models.strong.contextWindow=undefined;await assert.rejects(f.route({reason:'direct'}),/context|budget/i);
 f.models.small.contextWindow=220;const selected=await f.route();f.models.small.contextWindow=219;await assert.rejects(f.route({reason:'continuation',previous:selected}),/context|budget/i);
});
test('T3 first trusted tool phase can choose a fitting higher tier while keeping a fresh native handoff',async()=>{
 const routes=[],f=await tierFixture({answer:{intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']},raw:true,state:{v:2,model:'small',effort:'low',mode:'readonly'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)},budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}});
 f.models.medium.contextWindow=219;f.models.strong.contextWindow=220;const result=await f.route();assert.equal(result.model.id,'strong');assert.equal(routes.at(-1).intent,'new');assert.equal(routes.at(-1).mode,'task');
});
test('T3 budget rejection cannot move a subscription goal to a fitting API model',async()=>{
 const f=await tierFixture({budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}});subscription(f);f.flags['yam-medium']='p/medium';f.models.small.contextWindow=219;f.models.strong.contextWindow=undefined;
 await assert.rejects(f.route(),/context|budget|subscription|billing/i);const decision=(await f.ready).snapshot().decision;assert.ok(decision.rejected.some(r=>r.model==='p/medium'&&r.reason==='billing'));assert.equal(decision.selected,undefined);
});
test('T3 readonly correction never starts a model whose local budget cannot be established',async()=>{
 const f=await tierFixture({budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}});await f.handlers.before_agent_start({},f.ctx);await f.route();f.models.medium.contextWindow=undefined;const before=f.calls;
 await f.handlers.message_end({message:{role:'assistant',provider:'p',model:'small',stopReason:'stop',content:[{type:'text',text:'I need a stronger model'}]}},f.ctx);assert.equal(f.calls,before);const decision=(await f.ready).snapshot().decision;assert.equal(decision.budget.contextWindow,100000);assert.equal(decision.budget.fits,true);assert.ok(decision.rejected.some(r=>r.model==='p/medium'&&r.reason==='context-unknown'));
});
test('T3 sticky effort stays exact when refreshed metadata no longer supports it',async()=>{
 const f=await tierFixture(),selected=await f.route();f.models.small.thinkingLevelMap={high:'high'};
 await assert.rejects(f.route({reason:'continuation',previous:selected}),/reasoning|unsupported/i);
});
for(const reason of ['user','direct','continuation'])test(`T3 budget rejection persists safe facts from an empty decision on ${reason}`,async()=>{
 for(const window of [219,undefined]){
  const routes=[],f=await tierFixture({native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)},budget:{estimateMessageTokens:()=>200,getReserveTokens:()=>20}}),api=await f.ready;
  if(reason==='user')await api.control({action:'set',revision:api.snapshot().revision,data:{model:'p/medium',effort:'high'}});
  const model=reason==='direct'?f.models.strong:f.models.medium;model.contextWindow=window;
  await f.handlers.before_agent_start({},f.ctx);assert.equal(api.snapshot().decision,null);
  await assert.rejects(f.route({reason,messages:[{role:'user',content:'PRIVATE_BUDGET_TEXT'}],...(reason==='continuation'?{previous:{model,thinkingLevel:'high'}}:{})}),/context|budget/i);
  const snapshot=api.snapshot(),rejection=snapshot.decision?.rejected?.[0];assert.ok(rejection,'the failed candidate must have a persisted decision');assert.equal(rejection.model,`p/${model.id}`);assert.equal(rejection.reason,window===undefined?'context-unknown':'context-limit');assert.equal(rejection.budget.contextWindow,window??null);
  if(window!==undefined){assert.equal(rejection.budget.inputTokens,200);assert.equal(rejection.budget.reserveTokens,20);}
  assert.deepEqual(f.entries.findLast(e=>e.customType==='yam.routing.decision.v1').data,snapshot.decision);assert.doesNotMatch(JSON.stringify(snapshot.decision),/PRIVATE_BUDGET_TEXT/);assert.equal(snapshot.target,null);assert.equal(routes.length,0);assert.equal(f.calls,0);assert.equal(snapshot.failure.nextAction,'reduce-context');
  if(reason==='user')assert.deepEqual(snapshot.preferences,{model:'p/medium',effort:'high'});
 }
});

test('T2 routing publishes only terminal safe failure facts and clears them on success or a new epoch',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.before_agent_start({},f.ctx);
 const failure={category:'context',stage:'preparation',code:'context-budget',dispatch:'not-started',nextAction:'reduce-context',stderr:'PRIVATE'};
 await f.handlers.message_end({message:{role:'assistant',provider:'yam-codex',model:'small',stopReason:'error',content:[],failure}},f.ctx);
 assert.equal(runtime.snapshot().failure?.category,'context');assert.doesNotMatch(JSON.stringify(runtime.snapshot().failure),/PRIVATE|stderr/);
 await f.handlers.message_end({message:{role:'assistant',provider:'p',model:'small',stopReason:'stop',content:[{type:'text',text:'A valid answer'}]}},f.ctx);assert.equal(runtime.snapshot().failure,null);
 await f.handlers.message_end({message:{role:'assistant',provider:'yam-codex',model:'small',stopReason:'error',content:[],failure}},f.ctx);await f.handlers.before_agent_start({},f.ctx);assert.equal(runtime.snapshot().failure,null);
 const fallback=fixture({answer:Error('quota auth connection')});await fallback.route();assert.equal((await fallback.ready).snapshot().failure,null);
});

test('T2 trusted login discovery is not replaced by a generic capability failure during routing',async()=>{
 const fact={category:'auth',stage:'discovery',code:'not-logged-in',dispatch:'not-started',nextAction:'check-login'};
 const native={resolveModel:(_ctx,m)=>m,capabilities:()=>[],discoveryFailure:()=>fact,stream:()=>assert.fail('login failure must stop before classification')},f=fixture({native});
 for(const id of ['small','strong']){f.models[id].provider='yam-codex';f.flags['yam-'+id]='yam-codex/'+id;}
 f.flags['yam-classifier']='yam-codex/small';const runtime=await f.ready;await assert.rejects(f.route());assert.deepEqual(runtime.snapshot().failure,fact);assert.equal(f.calls,0);
});
test('routing snapshots expose safe configuration provenance and native execution diagnostics',async()=>{
 let publish,begins=0;const f=fixture({native:{observeExecution:fn=>publish=fn,beginTurn:()=>{begins++;publish?.(null);}}}),api=await f.ready;await f.handlers.session_start({},f.ctx);assert.equal(begins,1);
 assert.equal(api.snapshot().diagnostics.configSource,'launch');assert.equal(api.snapshot().diagnostics.billing,'configured');
 const revision=api.snapshot().revision;publish({stage:'starting',discoveryMs:20,startupMs:null,firstResponseMs:null,executionMs:null});
 assert.ok(api.snapshot().revision>revision);assert.equal(api.snapshot().diagnostics.execution.stage,'starting');
 f.entries.push({type:'custom',customType:'yam.routing.config.v1',data:{small:'p/small',strong:'p/strong',classifier:'p/small'}});assert.equal(api.snapshot().diagnostics.configSource,'session');
 await f.handlers.session_tree({},f.ctx);assert.equal(api.snapshot().diagnostics.execution,null);assert.equal(begins,2);
});
test('Pi runtime catalog checks required APIs without inference or persistent session entries',async()=>{
 for(const missing of [null,'streamSimple','setModel','getSessionFile']){
  const f=fixture(),messages=[];await f.ready;f.flags['yam-catalog-probe']=true;f.ctx.ui.notify=s=>messages.push(JSON.parse(s));
  if(missing==='streamSimple')delete f.ctx.modelRegistry[missing];
  if(missing==='setModel')delete f.pi[missing];
  if(missing==='getSessionFile')delete f.ctx.sessionManager[missing];
  await f.handlers.session_start({},f.ctx);
  const result=messages.at(-1);assert.equal(result.type,'yam_catalog');assert.equal(f.calls,0);assert.equal(f.entries.length,0);
  if(missing){assert.match(result.error,new RegExp(missing));assert.notEqual(result.runtime,1);}
  else{assert.equal(result.runtime,1);assert.equal(result.error,null);assert.ok(Array.isArray(result.models));}
 }
});
test('Pi setup probe calls only selected model and rejects invalid or failed classification',async()=>{
 for(const [answer,expected] of [[{intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']},true],[{},false],[new Error('provider failure'),false]]){
  const f=fixture({answer,raw:true}),messages=[];await f.ready;f.flags['yam-catalog-probe']=true;f.flags['yam-setup-model']='p/small';f.ctx.ui.notify=s=>messages.push(JSON.parse(s));
  await f.handlers.session_start({},f.ctx);
  assert.equal(f.calls,1);assert.equal(messages.at(-1).probe?.ok,expected);assert.equal(f.entries.filter(e=>e.customType==='yam.routing.rules.v1').length,0);
 }
});
test('Pi upgrades untouched legacy defaults but preserves explicit later max rules',async()=>{
 const f=fixture(),api=await f.ready,legacy=structuredClone(defaultRules);legacy.rules.find(r=>r.task==='review').effort='max';
 f.entries.push({type:'custom',customType:'yam.routing.rules.v1',data:legacy});await f.handlers.session_start({},f.ctx);
 assert.equal(api.snapshot().rules.rules.find(r=>r.task==='review').effort,'high');
 const explicit=structuredClone(defaultRules);explicit.rules.find(r=>r.task==='review').effort='max';
 await api.control({action:'rules',revision:api.snapshot().revision,data:explicit});await f.handlers.session_start({},f.ctx);
 assert.equal(api.snapshot().rules.rules.find(r=>r.task==='review').effort,'max');
 const custom=fixture(),customApi=await custom.ready,modified=structuredClone(legacy);modified.rules[0].description='Custom translation rule';
 custom.entries.push({type:'custom',customType:'yam.routing.rules.v1',data:modified});await custom.handlers.session_start({},custom.ctx);
 assert.deepEqual(customApi.snapshot().rules,modified);
});
test('Pi native virtual routing actually chooses physical model and effort with persisted state',async()=>{
 const f=fixture(),r=await f.route();assert.equal(r.model.id,'small');assert.equal(r.thinkingLevel,'medium');assert.equal(r.state.v,1);assert.equal(f.calls,1);
 const next=await f.route({reason:'continuation',previous:r});assert.equal(next.model,r.model);assert.equal(next.thinkingLevel,'medium');assert.equal(f.calls,1);
 const retry=await f.route({reason:'retry',failed:r});assert.equal(retry.model,r.model);assert.equal(f.calls,1);
});
test('ordinary Pi routing keeps its classifier and has no forced coordinator path',async()=>{
 const f=fixture(),api=await f.ready;await f.handlers.before_agent_start({},f.ctx);
 assert.equal(api.setAgentCoordinator,undefined);
 const selected=await f.route();assert.equal(selected.model.id,'small');assert.equal(f.calls,1);
 assert.notEqual(api.snapshot().decision.rule,'agent-coordinator');
});
test('agent routing context keeps task rules and explicit effort while limiting lightweight workers',async()=>{
 const f=fixture(),api=await f.ready,c=api.agentRoutingContext(f.ctx);
 assert.deepEqual(c.rules,defaultRules);assert.equal(c.profiles.find(p=>p.id==='pi-small').capabilities.includes('files'),false);assert.equal(c.profiles.find(p=>p.id==='pi-strong').thinking,'high');
 const locked=fixture({selected:'max'}),lockedApi=await locked.ready;
 assert.ok(lockedApi.agentRoutingContext(locked.ctx).profiles.every(p=>p.thinking==='max'));
});

test('Pi rules are explicitly applied, versioned, restored and rejected while busy or stale',async()=>{
 const f=fixture(),api=await f.ready;await f.handlers.session_start({},f.ctx);
 const original=api.snapshot(),edited=structuredClone(defaultRules);edited.rules[0].model='strong';
 await assert.rejects(api.control({action:'rules',revision:original.revision-1,data:edited}),/changed/);
 await api.control({action:'rules',revision:original.revision,data:edited});
 assert.equal(api.snapshot().ruleVersion,rulesVersion(edited));assert.equal(f.entries.findLast(e=>e.customType==='yam.routing.rules.v1').data.rules[0].model,'strong');
 f.flags['yam-rules']=JSON.stringify(defaultRules);await f.handlers.session_start({},f.ctx);assert.equal(api.snapshot().ruleVersion,rulesVersion(edited));
 f.ctx.isIdle=()=>false;await assert.rejects(api.control({action:'rules',revision:api.snapshot().revision,data:defaultRules}),/finish/);
});
test('Pi invalid launch rules stop execution and can be repaired through the session rule control',async()=>{
 const f=fixture(),api=await f.ready;f.flags['yam-rules']='{}';await f.handlers.session_start({},f.ctx);
 await assert.rejects(f.route(),/rules/i);
 await api.control({action:'rules',revision:api.snapshot().revision,data:defaultRules});assert.equal((await f.route()).model.id,'small');
});
test('Pi corrupt saved rule entries never silently fall back to launch defaults',async()=>{
 const f=fixture(),api=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.rules.v1',data:null});await f.handlers.session_start({},f.ctx);
 assert.match(api.snapshot().error,/rules/i);await assert.rejects(f.route(),/rules/i);
});
test('Pi repairing saved rules preserves a fixed model and off lock without unused automatic roles',async()=>{
 for(const event of ['session_start','session_tree']){
 const f=fixture(),api=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.rules.v1',data:null},{type:'custom',customType:'yam.routing.preferences.v1',data:{model:'p/strong',effort:'off'}});
 delete f.models.small;await f.handlers[event]({},f.ctx);
 await api.control({action:'rules',revision:api.snapshot().revision,data:defaultRules});
 assert.deepEqual(api.snapshot().preferences,{model:'p/strong',effort:'off'});const r=await f.route();assert.equal(r.model.id,'strong');assert.equal(r.thinkingLevel,'off');assert.equal(f.calls,0);
 }
});
test('Pi rule repair persists launch and legacy branch locks even without a saved preference entry',async()=>{
 for(const event of ['session_start','session_tree']){
  const f=fixture(),api=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.rules.v1',data:null});delete f.models.small;
  if(event==='session_start'){f.flags['yam-fixed-model']='p/strong';f.flags['yam-effort']='off';}
  else f.ctx.sessionManager.buildSessionProjection=()=>({model:{provider:'p',modelId:'strong'},thinkingLevel:'off'});
  await f.handlers[event]({},f.ctx);await api.control({action:'rules',revision:api.snapshot().revision,data:defaultRules});
  assert.deepEqual(f.entries.findLast(e=>e.customType==='yam.routing.preferences.v1')?.data,{model:'p/strong',effort:'off'},event);
  const resumed=fixture();delete resumed.models.small;resumed.entries.push(...structuredClone(f.entries));const next=await resumed.ready;await resumed.handlers.session_start({},resumed.ctx);
  assert.deepEqual(next.snapshot().preferences,{model:'p/strong',effort:'off'});assert.equal((await resumed.route()).thinkingLevel,'off');
 }
});
test('Pi rule preview calls classification only, never changes preferences or saves its input',async()=>{
 const f=fixture(),api=await f.ready;await f.handlers.session_start({},f.ctx);const before=structuredClone(f.entries),preferences=api.snapshot().preferences;
 await api.control({action:'preview',revision:api.snapshot().revision,data:{text:'PREVIEW_PRIVATE_TEXT',rules:defaultRules}});
 assert.equal(f.calls,1);assert.deepEqual(api.snapshot().preferences,preferences);assert.deepEqual(f.entries,before);
 assert.ok(api.snapshot().preview);assert.doesNotMatch(JSON.stringify(api.snapshot()),/PREVIEW_PRIVATE_TEXT/);
});
test('Pi structured routing applies edited rules and records only policy metadata, not conversation text',async()=>{
 const facts={intent:'new',task:'transform',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,reason:'PRIVATE_CLASSIFIER_REASON'};
 const f=fixture({answer:facts}),api=await f.ready;
 const r=await f.route({messages:[{role:'user',content:'PRIVATE_REQUEST_TEXT'}]});assert.equal(r.model.id,'small');assert.equal(r.state.rule,'transform');assert.equal(r.state.ruleVersion,rulesVersion(defaultRules));
 assert.equal(api.snapshot().decision.classifierCost,null);assert.ok(api.snapshot().decision.classificationMs>=0);
 assert.doesNotMatch(JSON.stringify(api.snapshot().decision),/PRIVATE_/);
 const edited=structuredClone(defaultRules);edited.rules.find(r=>r.task==='transform').model='strong';
 await f.handlers.session_start({},f.ctx);await api.control({action:'rules',revision:api.snapshot().revision,data:edited});assert.equal((await f.route()).model.id,'strong');
});
test('Pi legacy or incomplete classifier output cannot authorise lightweight routing',async()=>{
 for(const answer of [{intent:'new',difficulty:'simple',uncertain:false},{intent:'new',task:'answer',context:'independent',depth:'normal',uncertain:false,readOnly:true}]){
  const f=fixture({answer,raw:true}),r=await f.route();assert.equal(r.model.id,'strong');assert.equal(r.state.rule,'fallback');
 }
});
test('Pi classification cost is unknown without quoted prices and is still counted for malformed output',async()=>{
 const f=fixture(),api=await f.ready;f.ctx.modelRegistry.complete=async()=>({content:[{type:'text',text:'invalid JSON'}],usage:{cost:{input:.1,output:.2,cacheRead:0,cacheWrite:0}}});
 await f.route();assert.equal(api.snapshot().decision.classifierCost,null);
 f.models.small.cost={input:1,output:1,cacheRead:0,cacheWrite:0};await f.route();assert.ok(Math.abs(api.snapshot().decision.classifierCost-.3)<1e-10);
 assert.ok(f.entries.some(e=>e.customType==='yam.routing.decision.v1'));
});
test('Pi task totals include every native model response and stay unknown when any response lacks cost',async()=>{
 const f=fixture(),api=await f.ready;await f.handlers.before_agent_start({},f.ctx);await f.route();
 const message={role:'assistant',provider:'p',model:'small',stopReason:'stop',content:[{type:'text',text:'answer'}],usage:{cost:{input:.1,output:.2,cacheRead:0,cacheWrite:0}}};
 f.models.small.cost={input:1,output:1,cacheRead:0,cacheWrite:0};await f.handlers.message_end({message},f.ctx);await f.handlers.message_end({message},f.ctx);
 assert.ok(Math.abs(api.snapshot().decision.executionCost-.3)<1e-10);assert.equal(api.snapshot().decision.totalCost,null);
 await f.handlers.agent_settled({aborted:false},f.ctx);assert.equal(f.entries.findLast(e=>e.customType==='yam.routing.decision.v1').data.executionCost,api.snapshot().decision.executionCost);
});
test('Pi native physical model turns account for known costs without virtual routing',async()=>{
 const f=fixture({selected:'max'}),api=await f.ready;f.ctx.model=f.models.strong;f.models.strong.cost={input:1,output:1,cacheRead:0,cacheWrite:0};
 await f.handlers.before_agent_start({},f.ctx);await f.handlers.message_end({message:{role:'assistant',provider:'p',model:'strong',stopReason:'stop',content:[{type:'text',text:'done'}],usage:{cost:{input:.1,output:.2,cacheRead:0,cacheWrite:0}}}},f.ctx);
 assert.ok(Math.abs(api.snapshot().decision.totalCost-.3)<1e-10);assert.equal(api.snapshot().decision.classifierCost,0);assert.equal(f.calls,0);
});
test('Pi manual reasoning survives model routing, classifier failure and compaction',async()=>{
 const f=fixture({selected:'max',answer:Error('offline')});const r=await f.route();assert.equal(r.model.id,'strong');assert.equal(r.thinkingLevel,'max');
 const direct=await f.route({reason:'direct'});assert.equal(direct.model.id,'strong');assert.equal(direct.thinkingLevel,'max');assert.equal(f.calls,1);
});
test('Pi cancellation prevents fallback inference and missing models fail closed',async()=>{
 const f=fixture(),abort=new AbortController();abort.abort();await assert.rejects(f.route({signal:abort.signal}),/aborted/i);assert.equal(f.calls,0);
 delete f.models.strong;await assert.rejects(f.route(),/unavailable/);assert.equal(f.calls,0);
});
test('Pi role configuration and effort controls use native branch entries and refuse mid-task changes',async()=>{
 const f=fixture();await f.commands['yam-route'].handler('models p/strong p/strong',f.ctx);assert.equal(f.entries[0].data.small,'p/strong');assert.equal((await f.route()).model.id,'strong');
 await f.commands['yam-route'].handler('effort max',f.ctx);assert.equal((await f.route()).thinkingLevel,'max');
 await assert.rejects(f.commands['yam-route'].handler('auto',{...f.ctx,isIdle:()=>false}),/finish/);
});

test('Pi ended native sessions expose Continue and project review feedback like existing agents',async()=>{
 const {sessionRecovery}=await import('../src/session-recovery.ts');const {reviewOrigin}=await import('../src/review-feedback.ts');
 const record={summary:{session_id:'s-pi',cwd:'/repo',command:null,launch:{adapter:'pi',mode:'interactive',extra_args:''}},status:'stopped',agent:{generation:'g',agent_session_id:'01234567-1234-1234-1234-0123456789ab',phase:'idle',integration:'connected'}};
 assert.equal(sessionRecovery(record,'s-pi','s-pi','stopped',false,'available').canContinue,true);
 assert.equal(reviewOrigin(record)?.sessionId,'s-pi');
});

test('Pi retries that later succeed do not report an earlier transient error as task failure',async()=>{
 const f=fixture();await f.handlers.before_agent_start({},f.ctx);
 f.handlers.message_end({message:{role:'assistant',stopReason:'error'}});
 f.handlers.message_end({message:{role:'assistant',stopReason:'stop'}});
 // Native settle remains usable after a recovered request; notifications are absent outside a YAM-owned process.
 await f.handlers.agent_settled({aborted:false},f.ctx);
 assert.equal((await f.route()).thinkingLevel,'medium');
});
test('Pi does not silently replace an image with a placeholder on a text-only strong model',async()=>{
 const f=fixture();f.models.strong.input=['text'];
 await assert.rejects(f.route({messages:[{role:'user',content:[{type:'image',data:'x'}]}]}),/image/i);
});

test('Pi YAM event bridge commits native lifecycle and recovered retries with the final outcome',async()=>{
 const {createServer}=await import('node:net');const wires=[];
 const server=createServer({allowHalfOpen:true},socket=>{let raw='';socket.on('data',b=>raw+=b);socket.on('end',()=>{wires.push(JSON.parse(raw));socket.end(JSON.stringify({accepted:true}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const oldAddress=process.env.YAM_AGENT_ADDRESS,oldToken=process.env.YAM_AGENT_TOKEN;
 process.env.YAM_AGENT_ADDRESS=`127.0.0.1:${server.address().port}`;process.env.YAM_AGENT_TOKEN='0'.repeat(64);
 try {
  const f=fixture();f.ctx.sessionManager.getSessionFile=()=>'/owned/01234567-1234-1234-1234-0123456789ab.jsonl';
  await f.handlers.session_start({},f.ctx);await f.handlers.before_agent_start({},f.ctx);
  f.handlers.message_end({message:{role:'assistant',stopReason:'error'}});f.handlers.message_end({message:{role:'assistant',stopReason:'stop'}});
  await f.handlers.agent_settled({aborted:false},f.ctx);
  assert.deepEqual(wires.map(w=>w.event.kind),['SessionStart','UserPromptSubmit','TurnComplete']);
  assert.equal(wires[1].event.turn_id,wires[2].event.turn_id);assert.equal(wires[0].event.agent_session_id,'01234567-1234-1234-1234-0123456789ab');
 }finally {
  if(oldAddress===undefined)delete process.env.YAM_AGENT_ADDRESS;else process.env.YAM_AGENT_ADDRESS=oldAddress;
  if(oldToken===undefined)delete process.env.YAM_AGENT_TOKEN;else process.env.YAM_AGENT_TOKEN=oldToken;
  await new Promise(resolve=>server.close(resolve));
 }
});

test('Pi gateway registration precedes session restore and retains native context/output limits',async()=>{
 const oldArgv=process.argv,oldFetch=globalThis.fetch,providers=[];
 process.argv=[...oldArgv,'--yam-gateway','http://127.0.0.1:3425'];
 globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'vendor/model',reasoning:true,context_window:500000,max_output_tokens:128000,reasoning_levels:['low','medium','high','xhigh','max','ultra'],modalities:{input:['text','image']},pricing:{prompt:'0.000002',completion:'0.00001'}}]})});
 try {
  await install({registerEntryRenderer(){},registerFlag(){},on(){},registerCommand(){},registerVirtualModel(){},registerProvider:(id,config)=>providers.push({id,config})},()=>['high']);
  assert.equal(providers.length,1);assert.equal(providers[0].config.models[0].maxTokens,128000);assert.equal(providers[0].config.models[0].contextWindow,500000);
  assert.equal(providers[0].config.models[0].thinkingLevelMap.max,'max');assert.equal(providers[0].config.models[0].thinkingLevelMap.minimal,null);assert.equal(providers[0].config.api,'openai-completions');
 }finally{process.argv=oldArgv;globalThis.fetch=oldFetch;}
});

test('Pi manual effort command validates a physical model before the native setter can clamp',async()=>{
 const f=fixture();f.ctx.model={...f.models.strong,thinkingLevelMap:{high:'high'}};
 f.ctx.thinkingLevel='high';
 await assert.rejects(f.commands['yam-route'].handler('effort max',f.ctx),/unsupported/i);
 await assert.rejects(f.commands['yam-route'].handler('effort auto',f.ctx),/YAM Auto/);
});

test('Pi null capability entries disable reasoning levels instead of introducing them',()=>{
 const model={id:'high-only',reasoning:true,thinkingLevelMap:{low:null,medium:null,high:'high',xhigh:null,max:null}};
 assert.equal(resolveEffort(model,'medium','off'),'high');
 assert.throws(()=>resolveEffort(model,'medium','medium'),/unsupported/);
});

test('Pi native model selection cannot lower an existing explicit reasoning lock',async()=>{
 const f=fixture({selected:'high'}),oldModel=f.ctx.model;
 f.entries.push({type:'thinking_level_change',thinkingLevel:'max'},{type:'model_change',provider:'p',modelId:'weak'},{type:'thinking_level_change',thinkingLevel:'high'});
 const weak={...f.models.small,id:'weak',thinkingLevelMap:{high:'high'}};f.ctx.model=weak;
 let restored;f.pi.setModel=async model=>{restored=model;f.ctx.model=model;return true;};
 assert.equal(typeof f.handlers.model_select,'function');
 await f.handlers.model_select({model:weak,previousModel:oldModel,source:'set'},f.ctx);
 assert.equal(restored,oldModel);assert.equal(f.pi.getThinkingLevel(),'max');
});
test('Pi direct compaction refuses image context when the configured strong model cannot accept images',async()=>{
 const f=fixture();f.models.strong.input=['text'];
 await assert.rejects(f.route({reason:'direct',messages:[{role:'user',content:[{type:'image',data:'x'}]}]}),/image/i);
});

test('Pi explicit physical launch reasoning is not replaced by an automatic off default',async()=>{
 const f=fixture({selected:'high'});const argv=process.argv;process.argv=[...argv,'--thinking','max'];
 try {
  f.ctx.model={...f.models.strong,thinkingLevelMap:{high:'high'}};
  await f.handlers.session_start({},f.ctx);
  await assert.rejects(f.route(),/reasoning|lock|unsupported/i);
 }finally{process.argv=argv;}
});
test('Pi length-limited final response sends failure instead of a successful completion',async()=>{
 const {createServer}=await import('node:net'),wires=[];
 const server=createServer({allowHalfOpen:true},socket=>{let raw='';socket.on('data',b=>raw+=b);socket.on('end',()=>{wires.push(JSON.parse(raw));socket.end('{"accepted":true}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const a=process.env.YAM_AGENT_ADDRESS,t=process.env.YAM_AGENT_TOKEN;process.env.YAM_AGENT_ADDRESS=`127.0.0.1:${server.address().port}`;process.env.YAM_AGENT_TOKEN='0'.repeat(64);
 try {const f=fixture();f.ctx.sessionManager.getSessionFile=()=>'/owned/01234567-1234-1234-1234-0123456789ab.jsonl';await f.handlers.before_agent_start({},f.ctx);f.handlers.message_end({message:{role:'assistant',stopReason:'length'}});await f.handlers.agent_settled({aborted:false},f.ctx);assert.equal(wires.at(-1).event.kind,'TurnFailed');}
 finally {if(a===undefined)delete process.env.YAM_AGENT_ADDRESS;else process.env.YAM_AGENT_ADDRESS=a;if(t===undefined)delete process.env.YAM_AGENT_TOKEN;else process.env.YAM_AGENT_TOKEN=t;await new Promise(resolve=>server.close(resolve));}
});
test('Pi missing gateway catalog never leaves an authenticated fallback provider selected',async()=>{
 const argv=process.argv,fetch=globalThis.fetch,handlers={};let definition,selected={api:'other',provider:'other',id:'fallback'};
 process.argv=[...argv,'--yam-gateway','http://127.0.0.1:3425'];globalThis.fetch=async()=>({ok:false,status:503});
 const automatic={api:'pi-virtual',provider:'yam',id:'auto'};
 try {
  await install({registerEntryRenderer(){},appendEntry(){},on:(k,v)=>handlers[k]=v,registerFlag(){},registerCommand(){},registerVirtualModel:v=>definition=v,setModel:async m=>{selected=m;return true;},getThinkingLevel:()=> 'high',getFlag:()=>undefined},()=>['high']);
  const ctx={model:selected,ui:{notify(){},setStatus(){}},sessionManager:{getBranch:()=>[]},modelRegistry:{find:()=>automatic,hasConfiguredAuth:()=>true}};
  await handlers.session_start({},ctx);assert.equal(selected,automatic);
  await assert.rejects(definition.route({thinkingLevel:'high',reason:'user',messages:[]},ctx),/catalog|gateway/i);
 }finally{process.argv=argv;globalThis.fetch=fetch;}
});

test('Pi gateway launch parsing obeys last option, literal values and the prompt terminator',async()=>{
 const {launchOption}=await import('../src-tauri/pi/policy.mjs');
 assert.equal(typeof launchOption,'function');
 assert.equal(launchOption('--yam-gateway',['node','pi','--yam-gateway','first','--yam-gateway=last','--','--yam-gateway=prompt']),'last');
 assert.equal(launchOption('--yam-gateway',['pi','--append-system-prompt','--yam-gateway'] ),undefined);
});

test('Pi native cross-file transitions cannot detach a YAM-owned history from its conversation',async()=>{
 const old=process.env.YAM_AGENT_ADDRESS;
 try {
  process.env.YAM_AGENT_ADDRESS='127.0.0.1:1';const f=fixture();
  assert.deepEqual(f.handlers.session_before_switch({reason:'new'},f.ctx),{cancel:true});
  assert.deepEqual(f.handlers.session_before_switch({reason:'resume'},f.ctx),{cancel:true});
  assert.deepEqual(f.handlers.session_before_fork({},f.ctx),{cancel:true});
  delete process.env.YAM_AGENT_ADDRESS;assert.equal(f.handlers.session_before_switch({reason:'new'},f.ctx),undefined);
 }finally{if(old===undefined)delete process.env.YAM_AGENT_ADDRESS;else process.env.YAM_AGENT_ADDRESS=old;}
});


test('Pi graphical controls keep fixed model and automatic effort independent, persist and resume natively',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 let state=runtime.snapshot();
 await runtime.control({action:'set',revision:state.revision,data:{model:'p/small',effort:'auto'}});
 const routed=await f.route();assert.equal(routed.model.id,'small');assert.equal(routed.thinkingLevel,'medium');
 state=runtime.snapshot();assert.equal(state.preferences.model,'p/small');assert.equal(state.preferences.effort,'auto');
 assert.ok(f.entries.findLast(e=>e.customType==='yam.routing.preferences.v1'));
 const resumed=fixture();resumed.entries.push(...structuredClone(f.entries));const r=await resumed.ready;await resumed.handlers.session_start({},resumed.ctx);
 assert.deepEqual(r.snapshot().preferences,state.preferences);assert.equal((await resumed.route()).thinkingLevel,'medium');
 await r.control({action:'set',revision:r.snapshot().revision,data:{model:'auto',effort:'max'}});
 assert.equal((await resumed.route()).thinkingLevel,'max');
 await r.control({action:'reset',revision:r.snapshot().revision});assert.deepEqual(r.snapshot().preferences,{model:'auto',effort:'auto'});
});
test('Pi graphical controls reject stale, busy, unavailable and incompatible model changes without altering preferences',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);const before=runtime.snapshot();
 await assert.rejects(runtime.control({action:'set',revision:before.revision-1,data:{model:'auto',effort:'max'}}),/changed|stale/i);
 f.ctx.isIdle=()=>false;await assert.rejects(runtime.control({action:'reset',revision:before.revision}),/finish|busy/i);f.ctx.isIdle=()=>true;
 await assert.rejects(runtime.control({action:'set',revision:before.revision,data:{model:'p/missing',effort:'auto'}}),/unavailable/i);
 f.models.small.thinkingLevelMap={medium:'medium'};
 await assert.rejects(runtime.control({action:'set',revision:before.revision,data:{model:'p/small',effort:'max'}}),/unsupported/i);
 assert.deepEqual(runtime.snapshot().preferences,before.preferences);
});
test('Pi actual status comes from native messages and blocked input survives a catalog/configuration failure without replay',async()=>{
 const f=fixture(),runtime=await f.ready;let editor='';f.ctx.ui.getEditorText=()=>editor;f.ctx.ui.setEditorText=v=>editor=v;
 await f.handlers.session_start({},f.ctx);await f.route();assert.equal(runtime.snapshot().actual,null);assert.equal(runtime.snapshot().target.model,'p/small');
 f.handlers.message_end({message:{role:'assistant',provider:'p',model:'small',thinkingLevel:'medium',timestamp:123,content:[{type:'text',text:'done'}],stopReason:'stop'}},f.ctx);
 assert.deepEqual(runtime.snapshot().actual,{model:'p/small',effort:'medium',at:123,source:'pi-native',billing:'api'});
 delete f.models.strong;await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().phase,'error');
 assert.equal(f.handlers.input({text:'do not lose this',source:'interactive'},f.ctx).action,'handled');assert.equal(editor,'do not lose this');
 const calls=f.calls;f.models.strong={...f.models.small,id:'strong'};
 await runtime.control({action:'retry',revision:runtime.snapshot().revision});assert.equal(f.calls,calls);assert.equal(editor,'do not lose this');assert.equal(runtime.snapshot().error,null);
});
test('Pi reconnect restores a selection that could not be applied during startup',async()=>{
 const f=fixture(),runtime=await f.ready;
 f.entries.push({type:'custom',customType:'yam.routing.preferences.v1',data:{model:'p/small',effort:'max'}});
 const small=f.models.small;delete f.models.small;await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().phase,'error');
 f.models.small=small;await runtime.control({action:'retry',revision:runtime.snapshot().revision});
 assert.deepEqual(runtime.snapshot().preferences,{model:'p/small',effort:'max'});const selected=await f.route();assert.equal(selected.model.id,'small');assert.equal(selected.thinkingLevel,'max');assert.equal(f.calls,0);
});
test('Pi blocked attachments are retained for the same explicit resubmission, never sent by reconnect',async()=>{
 const f=fixture(),runtime=await f.ready;let editor='';f.ctx.ui.getEditorText=()=>editor;f.ctx.ui.setEditorText=v=>editor=v;
 const strong=f.models.strong;delete f.models.strong;await f.handlers.session_start({},f.ctx);
 const images=[{type:'image',data:'small-test-image',mimeType:'image/png'}];f.handlers.input({text:'inspect this',images,source:'interactive'},f.ctx);
 f.models.strong=strong;await runtime.control({action:'retry',revision:runtime.snapshot().revision});assert.equal(f.calls,0);
 const next=f.handlers.input({text:'inspect this',source:'interactive'},f.ctx);assert.deepEqual(next,{action:'transform',text:'inspect this',images});
});
test('Pi native tree restores branch-specific controls and clears unrelated actual status',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'p/strong',effort:'max'}});
 f.entries.length=0;f.entries.push({type:'custom',customType:'yam.routing.preferences.v1',data:{model:'p/small',effort:'auto'}});
 await f.handlers.session_tree({},f.ctx);assert.deepEqual(runtime.snapshot().preferences,{model:'p/small',effort:'auto'});assert.equal(runtime.snapshot().actual,null);
});
test('Pi loopback controls authenticate generation and token and keep credentials out of responses',async()=>{
 const {serveControls}=await import('../src-tauri/pi/control.mjs'),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{connect}=await import('node:net');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'yam-pi-ux-control-')),file=path.join(root,'control.json'),generation='b'.repeat(64);let calls=0,seen=null;
 const state={revision:1,generation,phase:'idle'};const server=await serveControls(file,generation,()=>state,async request=>{seen=request.data;calls++;state.revision++;server.publish();},()=>[{key:'p/strong',name:'Strong',levels:['high'],context_window:1000}]);
 const descriptor=JSON.parse(await fs.readFile(file,'utf8'));
 const send=(request,fragment=false)=>new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:descriptor.port});let raw='';socket.on('error',reject);socket.on('data',b=>raw+=b);socket.on('end',()=>{try{resolve(JSON.parse(raw));}catch(e){reject(e);}});socket.on('connect',()=>{const raw=Buffer.from(JSON.stringify(request));if(fragment){const split=raw.indexOf(Buffer.from('模'))+1;socket.write(raw.subarray(0,split));setTimeout(()=>socket.end(raw.subarray(split)),5);}else socket.end(raw);});});
 try{
  if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await send({token:'a'.repeat(64),generation,action:'reset',revision:1})).ok,false);assert.equal(calls,0);
  assert.equal((await send({token:descriptor.token,generation:'wrong',action:'reset',revision:1})).ok,false);assert.equal(calls,0);
  const catalog=await send({token:descriptor.token,generation,action:'catalog',revision:1});assert.equal(catalog.models[0].key,'p/strong');assert.ok(!JSON.stringify(catalog).includes(descriptor.token));assert.equal(calls,0);
  const applied=await send({token:descriptor.token,generation,action:'reset',revision:1});assert.equal(applied.state.revision,2);assert.equal(calls,1);assert.ok(!JSON.stringify(applied).includes(descriptor.token));
  assert.equal((await send({token:descriptor.token,generation,action:'reset',revision:2,unexpected:true})).ok,false);assert.equal(calls,1);
  await send({token:descriptor.token,generation,action:'set',revision:2,data:{model:'p/模型'}},true);assert.equal(seen.model,'p/模型');
  const previewText='\0'.repeat(4000);assert.equal((await send({token:descriptor.token,generation,action:'preview',revision:3,data:{text:previewText,rules:defaultRules}})).ok,true);assert.equal(seen.text,previewText);
 }finally{await server.close();await fs.rm(root,{recursive:true,force:true});}
});

test('Pi native explicit arguments are not replaced by stale graphical auto defaults',async()=>{
 const argv=process.argv;process.argv=[...argv,'--model','p/strong','--thinking','high'];
 try{const f=fixture({selected:'high'});f.flags['yam-fixed-model']='auto';f.flags['yam-effort']='auto';f.ctx.model=f.models.strong;const runtime=await f.ready;await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().error,null);assert.deepEqual(f.entries.find(e=>e.customType==='yam.routing.preferences.v1').data,{model:'p/strong',effort:'high'});const result=await f.route();assert.equal(result.model.id,'strong');assert.equal(result.thinkingLevel,'high');assert.equal(f.calls,0);}finally{process.argv=argv;}
});
test('Pi interruption settles status and leaves controls usable after a completed tool-call message',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);await f.handlers.before_agent_start({},f.ctx);
 f.handlers.message_end({message:{role:'assistant',provider:'p',model:'strong',thinkingLevel:'high',content:[],stopReason:'toolUse'}},f.ctx);
 await f.handlers.agent_settled({aborted:true},f.ctx);assert.equal(runtime.snapshot().phase,'error');assert.match(runtime.snapshot().error,/interrupt/i);
 await runtime.control({action:'reset',revision:runtime.snapshot().revision});assert.equal(runtime.snapshot().phase,'idle');
});
test('Pi YAM explicit native off is distinct from its automatic sentinel',async()=>{
 const previous=process.env.YAM_PI_EXPLICIT_THINKING,argv=process.argv;process.env.YAM_PI_EXPLICIT_THINKING='1';process.argv=[...argv,'--model','yam/auto','--thinking','off'];
 try{const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().preferences.effort,'off');assert.equal((await f.route()).thinkingLevel,'off');}finally{process.argv=argv;if(previous===undefined)delete process.env.YAM_PI_EXPLICIT_THINKING;else process.env.YAM_PI_EXPLICIT_THINKING=previous;}
});
test('Pi fixed native model/off remains usable and restartable without unrelated automatic roles',async()=>{
 const f=fixture(),runtime=await f.ready;f.ctx.model=f.models.strong;delete f.flags['yam-small'];delete f.flags['yam-strong'];
 await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().error,null);assert.equal(runtime.snapshot().preferences.effort,'off');
 await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'p/strong',effort:'off'}});const choice=await f.route();assert.equal(choice.model.id,'strong');assert.equal(choice.thinkingLevel,'off');assert.equal(f.calls,0);assert.match(f.statuses.at(-1)[1],/固定/);
 const resumed=fixture();delete resumed.flags['yam-small'];delete resumed.flags['yam-strong'];resumed.entries.push(...f.entries);const next=await resumed.ready;await resumed.handlers.session_start({},resumed.ctx);assert.equal(next.snapshot().error,null);assert.equal((await resumed.route()).thinkingLevel,'off');
});
test('Pi native reasoning selector off stays explicit, while the automatic command stays automatic',async()=>{
 const f=fixture({selected:'high'}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 f.pi.setThinkingLevel('off');f.handlers.thinking_level_select({level:'off',previousLevel:'high'},f.ctx);assert.equal(runtime.snapshot().preferences.effort,'off');assert.equal((await f.route()).thinkingLevel,'off');
 await f.commands['yam-route'].handler('effort auto',f.ctx);assert.equal(runtime.snapshot().preferences.effort,'auto');
});
test('Pi delayed internal off event cannot overwrite an explicit automatic preference',async()=>{
 const f=fixture({selected:'high'}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 const native=f.pi.setThinkingLevel;let event;
 f.pi.setThinkingLevel=level=>{const previousLevel=f.pi.getThinkingLevel();native(level);f.entries.push({id:'internal-off',type:'thinking_level_change',thinkingLevel:level});event={level,previousLevel};};
 await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'auto',effort:'auto'}});f.handlers.thinking_level_select(event,f.ctx);assert.equal(runtime.snapshot().preferences.effort,'auto');
});
test('Pi preserves the native minimal reasoning level when the provider supports it',()=>{
 assert.equal(resolveEffort({reasoning:true,thinkingLevelMap:{minimal:'minimal',high:'high'}},'high','minimal'),'minimal');
});
test('Pi rejected native model switch restores both the reasoning lock and persisted routing preference',async()=>{
 const f=fixture({selected:'max'}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'p/strong',effort:'max'}});
 f.entries.push({id:'prior-level',type:'thinking_level_change',thinkingLevel:'max'},{id:'switch',type:'model_change',provider:'p',modelId:'small'});
 f.ctx.model=f.models.small;f.models.small.thinkingLevelMap={high:'high'};f.pi.setThinkingLevel('high');f.entries.push({id:'clamp',type:'thinking_level_change',thinkingLevel:'high'});f.handlers.thinking_level_select({level:'high',previousLevel:'max'},f.ctx);
 f.pi.setModel=async model=>{f.ctx.model=model;return true;};await f.handlers.model_select({source:'set',model:f.models.small,previousModel:f.models.auto},f.ctx);
 assert.equal(f.pi.getThinkingLevel(),'max');assert.deepEqual(runtime.snapshot().preferences,{model:'p/strong',effort:'max'});assert.deepEqual(f.entries.at(-1).data,{model:'p/strong',effort:'max'});
});
test('Pi does not reuse an old blocked attachment after a different explicit prompt',async()=>{
 const f=fixture(),runtime=await f.ready;const strong=f.models.strong;delete f.models.strong;await f.handlers.session_start({},f.ctx);
 f.handlers.input({source:'interactive',text:'old image',images:[{type:'image',data:'old'}]},f.ctx);f.models.strong=strong;await runtime.control({action:'retry',revision:runtime.snapshot().revision});
 assert.equal(f.handlers.input({source:'interactive',text:'new task'},f.ctx),undefined);assert.equal(f.handlers.input({source:'interactive',text:'old image'},f.ctx),undefined);
});
test('Pi routing commands commit explicit off/max through the same native preference path and restore them',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);await runtime.control({action:'reset',revision:runtime.snapshot().revision});
 await f.commands['yam-route'].handler('effort off',f.ctx);assert.equal(runtime.snapshot().preferences.effort,'off');assert.equal((await f.route()).thinkingLevel,'off');assert.equal(f.entries.findLast(e=>e.customType==='yam.routing.preferences.v1').data.effort,'off');
 await f.commands['yam-route'].handler('effort max',f.ctx);assert.equal(runtime.snapshot().preferences.effort,'max');assert.equal(f.entries.at(-1).data.effort,'max');
 const resumed=fixture();resumed.entries.push(...f.entries);const r=await resumed.ready;await resumed.handlers.session_start({},resumed.ctx);assert.equal(r.snapshot().preferences.effort,'max');
});

test('Pi native model defaults cannot replace an explicit off lock',async()=>{
 const f=fixture(),runtime=await f.ready;await f.handlers.session_start({},f.ctx);await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'auto',effort:'off'}});
 f.entries.push({id:'off-before',type:'thinking_level_change',thinkingLevel:'off'},{id:'new-model',type:'model_change',provider:'p',modelId:'strong'});f.ctx.model=f.models.strong;f.pi.setThinkingLevel('high');f.entries.push({id:'per-model-default',type:'thinking_level_change',thinkingLevel:'high'});f.handlers.thinking_level_select({level:'high',previousLevel:'off'},f.ctx);
 await f.handlers.model_select({source:'set',model:f.models.strong,previousModel:f.models.auto},f.ctx);assert.equal(f.pi.getThinkingLevel(),'off');assert.equal(runtime.snapshot().preferences.effort,'off');
});
test('Pi recovery respects a newer committed native thinking change after an older routing preference',async()=>{
 for(const level of ['high','max','off']){
  const f=fixture({selected:level}),runtime=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.preferences.v1',data:{model:'auto',effort:level==='off'?'max':'auto'}},{type:'thinking_level_change',thinkingLevel:level});
  await f.handlers.session_start({},f.ctx);assert.equal(f.pi.getThinkingLevel(),level);assert.equal(runtime.snapshot().preferences.effort,level);
 }
});
test('Pi legacy tree branches restore native projected choices and keep all working context intact',async()=>{
 const f=fixture({selected:'max'}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 const messages=[{role:'system',content:'retain system context'},{role:'user',content:'retain complete user context'}],before=structuredClone(messages);
 f.entries.length=0;f.ctx.sessionManager.buildSessionProjection=()=>({model:{provider:'yam',modelId:'auto'},thinkingLevel:'off',messages});
 await f.handlers.session_tree({},f.ctx);assert.deepEqual(runtime.snapshot().preferences,{model:'auto',effort:'off'});assert.equal(f.pi.getThinkingLevel(),'off');assert.deepEqual(messages,before);
 const resumed=fixture();resumed.flags['yam-fixed-model']='p/strong';resumed.flags['yam-effort']='max';resumed.entries.push(...f.entries);const restored=await resumed.ready;await resumed.handlers.session_start({},resumed.ctx);assert.deepEqual(restored.snapshot().preferences,{model:'auto',effort:'off'});
});
test('Pi a model-switch clamp does not masquerade as a new explicit reasoning choice on recovery',async()=>{
 const f=fixture({selected:'high'}),runtime=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.preferences.v1',data:{model:'auto',effort:'max'}},{type:'model_change',provider:'p',modelId:'small'},{type:'thinking_level_change',thinkingLevel:'high'});
 await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().preferences.effort,'max');assert.equal(f.pi.getThinkingLevel(),'max');
});

test('Pi continuation and retry do not depend on unused classification roles',async()=>{
 const f=fixture({answer:{intent:'new',difficulty:'complex',uncertain:false}}),r=await f.route();
 delete f.models.small;
 for(const reason of ['continuation','retry']){
  const next=await f.route({reason,previous:r,failed:reason==='retry'?r:undefined});
  assert.equal(next.model,r.model);assert.equal(next.thinkingLevel,r.thinkingLevel);
 }
 assert.equal(f.calls,1);
});
test('Pi native direct compaction only requires its selected strong model',async()=>{
 const f=fixture({selected:'max'});delete f.models.small;
 const r=await f.route({reason:'direct'});assert.equal(r.model,f.models.strong);assert.equal(r.thinkingLevel,'max');assert.equal(f.calls,0);
});
test('Pi saved reasoning overrides original native launch flags on restart',async()=>{
 const argv=process.argv;process.argv=[...argv,'--thinking','high'];
 try{
  const f=fixture({selected:'max'}),runtime=await f.ready;f.entries.push({type:'custom',customType:'yam.routing.preferences.v1',data:{model:'auto',effort:'max'}});
  await f.handlers.session_start({},f.ctx);assert.equal(runtime.snapshot().error,null);assert.equal(f.pi.getThinkingLevel(),'max');assert.equal((await f.route()).thinkingLevel,'max');
 }finally{process.argv=argv;}
});

test('Pi ongoing tasks upgrade independently in model and reasoning and never silently downgrade',()=>{
 for(const model of ['small','strong'])for(const level of ['low','medium','high','xhigh','max'])for(const difficulty of ['simple','complex','critical']){
  const prior={v:1,model,effort:level,task:'existing task'},before=JSON.stringify(prior);
  const next=decide({intent:'continue',difficulty,uncertain:false},prior);
  const expected=difficulty==='simple'?'medium':difficulty==='critical'?'max':'high';
  assert.equal(next.model,model==='strong'||difficulty!=='simple'?'strong':'small');
  assert.equal(next.effort,['low','medium','high','xhigh','max'][Math.max(['low','medium','high','xhigh','max'].indexOf(level),['low','medium','high','xhigh','max'].indexOf(expected))]);
  assert.equal(JSON.stringify(prior),before);
 }
});
test('Pi explicit new tasks can downgrade while missing or incompatible ongoing state is evaluated afresh',()=>{
 assert.deepEqual(decide({intent:'new',difficulty:'simple',uncertain:false},previous),{model:'small',effort:'medium'});
 for(const prior of [undefined,{}, {...previous,v:2},{...previous,model:'unknown'},{...previous,effort:'unknown'}])assert.deepEqual(decide({intent:'continue',difficulty:'complex',uncertain:false},prior),{model:'strong',effort:'high'});
 assert.deepEqual(decide({intent:'continue',difficulty:'critical',uncertain:true},{v:1,model:'small',effort:'xhigh'}),{model:'strong',effort:'xhigh'});
});
test('Pi actual virtual route escalates a continuing task and keeps that choice for tools and retries',async()=>{
 const f=fixture({answer:{intent:'continue',difficulty:'complex',uncertain:false,reason:'implementation added'},state:{v:1,model:'small',effort:'medium',task:'same task'}});
 const next=await f.route();assert.equal(next.model.id,'strong');assert.equal(next.thinkingLevel,'high');assert.equal(next.state.task,'same task');assert.equal(next.state.model,'strong');assert.equal(next.state.effort,'high');
 for(const reason of ['continuation','retry']){const sticky=await f.route({reason,previous:next,failed:reason==='retry'?next:undefined,state:next.state});assert.equal(sticky.model.id,'strong');assert.equal(sticky.thinkingLevel,'high');}assert.equal(f.calls,1);
});
test('Pi critical continuation stays at high, simple followups retain it, and manual reasoning still wins',async()=>{
 const critical=fixture({answer:{intent:'continue',difficulty:'critical',uncertain:false},state:{v:1,model:'strong',effort:'high'}});const high=await critical.route();assert.equal(high.model.id,'strong');assert.equal(high.thinkingLevel,'high');
 const simple=fixture({answer:{intent:'continue',difficulty:'simple',uncertain:false},state:high.state});assert.equal((await simple.route()).thinkingLevel,'high');assert.equal((await simple.route()).model.id,'strong');
 const manual=fixture({selected:'medium',answer:{intent:'continue',difficulty:'critical',uncertain:false},state:{v:1,model:'small',effort:'medium'}});const locked=await manual.route();assert.equal(locked.model.id,'strong');assert.equal(locked.thinkingLevel,'medium');
});


test('Pi reply model labels bind each native response to a display-only saved entry',async()=>{
 const f=fixture();await f.ready;
 const first={role:'assistant',provider:'p',model:'small',thinkingLevel:'medium',content:[{type:'text',text:'first answer'}],stopReason:'stop'};
 const second={...first,model:'strong',thinkingLevel:'max',content:[{type:'text',text:'second answer'}]};
 const saved=[first,second].map((message,i)=>f.handlers.turn_end({message,messageEntryId:`reply-${i}`,entries:[],toolResults:[]}));
 assert.deepEqual(saved.map(r=>r.entries[0]),[
  {type:'custom',customType:'yam.reply-model.v1',data:{messageId:'reply-0',model:'p/small',effort:'medium'}},
  {type:'custom',customType:'yam.reply-model.v1',data:{messageId:'reply-1',model:'p/strong',effort:'max'}}
 ]);
 assert.ok(saved.every(r=>!('continue' in r)),'a display label must never trigger another model request');
 assert.equal(f.calls,0);assert.equal(f.entries.length,0,'native boundary owns persistence, not message_end');
 const renderer=f.renderers['yam.reply-model.v1'];assert.ok(renderer);
 const reopened=fixture();await reopened.ready;
 for(const result of saved){const entry=JSON.parse(JSON.stringify(result.entries[0]));assert.equal(reopened.renderers[entry.customType](entry,{}, {fg:(_color,text)=>text}).text,`${entry.data.model} · ${entry.data.effort}`);}
});
test('Pi reply labels do not invent metadata for old, incomplete or failed responses',async()=>{
 const f=fixture();await f.ready;
 for(const message of [{role:'user',content:'hi'},{role:'assistant',content:[]},{role:'assistant',content:[{type:'thinking',thinking:'private'}]},{role:'assistant',content:[{type:'text',text:'  '}]}])assert.equal(f.handlers.turn_end({message,messageEntryId:'m'}),undefined);
 const partial={role:'assistant',provider:'p',model:'actual',stopReason:'error',content:[{type:'text',text:'partial response'}]};
 const result=f.handlers.turn_end({message:partial,messageEntryId:'partial'});assert.equal(result.entries[0].data.model,'p/actual');assert.equal(result.entries[0].data.effort,'unknown');
 const missing=f.handlers.turn_end({message:{role:'assistant',content:[{type:'text',text:'answer'}]},messageEntryId:'unknown'});
 const renderer=f.renderers['yam.reply-model.v1'];assert.equal(renderer(missing.entries[0],{}, {fg:(_color,text)=>text}).text,'模型未记录 · 推理尚未确认');
 assert.equal(renderer({data:null},{},{fg:(_color,text)=>text}),undefined);
 const hostile=renderer({data:{messageId:'m',model:'p/\u001b[2Jbad\nname',effort:'\u001b[31mmax'}},{},{fg:(_color,text)=>text}).text;
 assert.doesNotMatch(hostile,/[\u0000-\u001f\u007f]/);assert.match(hostile,/推理尚未确认/);
 assert.equal(f.calls,0);
});

test('Pi cache retention uses recent observed cache tokens and both models prices, never task difficulty',async()=>{
 const {preferCachedModel}=await import('../src-tauri/pi/policy.mjs');assert.equal(typeof preferCachedModel,'function');
 const now=Date.now(),small={provider:'p',id:'small',cost:{input:1,output:1,cacheRead:.1}},strong={provider:'p',id:'strong',contextWindow:100000,maxTokens:1000,cost:{input:10,output:2,cacheRead:.1}};
 const warm={role:'assistant',provider:'p',model:'strong',timestamp:now-1000,stopReason:'stop',content:[{type:'text',text:'previous'}],usage:{input:100,cacheRead:9900,cacheWrite:0,output:20}};
 const messages=[{role:'user',content:'old task'},warm,{role:'user',content:'HTTP 404?'}],before=structuredClone(messages);
 assert.equal(preferCachedModel('small',messages,small,strong,now),'strong');assert.deepEqual(messages,before);
 assert.equal(preferCachedModel('strong',messages,strong,small,now),'strong','cache never lowers a safety floor');
 for(const changed of [{usage:{...warm.usage,cacheRead:0}},{usage:{...warm.usage,cacheRead:NaN}},{usage:{...warm.usage,input:-1}},{usage:{...warm.usage,output:1e6}},{timestamp:now-301000},{timestamp:now+1},{stopReason:'error'},{model:'other'}])assert.equal(preferCachedModel('small',[{...warm,...changed},messages.at(-1)],small,strong,now),'small');
 for(const cost of [undefined,{input:10,output:2},{input:10,output:2,cacheRead:10},{input:10,output:NaN,cacheRead:.1}])assert.equal(preferCachedModel('small',messages,small,{...strong,cost},now),'small');
 assert.equal(preferCachedModel('small',messages,small,{...strong,cost:{...strong.cost,cacheRead:1}},now),'small','warm model must be meaningfully cheaper');
});

function feedbackFixture(options={}) {
 const f=fixture({answer:{intent:'new',difficulty:'simple',uncertain:false,readOnly:true,reason:'pure explanation'},...options});
 const classify=f.ctx.modelRegistry.complete,completions=[];
 f.ctx.modelRegistry.complete=async(model,context,settings)=>{
  if(model.id!=='strong')return classify(model,context,settings);
  completions.push({model,context,settings});
  return {role:'assistant',provider:'p',model:'strong',api:'openai-responses',content:[{type:'text',text:'A complete answer.'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:4,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{total:0}}};
 };
 const weak={role:'assistant',provider:'p',model:'small',api:'openai-responses',thinkingLevel:'medium',content:[{type:'text',text:'I need a stronger model to answer this.'}],stopReason:'stop',timestamp:Date.now()};
 return {...f,completions,weak};
}
test('Pi rejected correction retains all known usage costs instead of erasing them',async()=>{
 const f=feedbackFixture(),api=await f.ready,original=f.ctx.modelRegistry.complete;
 for(const m of [f.models.small,f.models.strong])m.cost={input:1,output:1,cacheRead:0,cacheWrite:0};
 f.ctx.modelRegistry.complete=async(...args)=>{const r=await original(...args);return {...r,stopReason:args[0].id==='strong'?'length':'stop',usage:{cost:{input:.1,output:0,cacheRead:0,cacheWrite:0}}};};
 await f.handlers.before_agent_start({},f.ctx);await f.route();const weak={...f.weak,usage:{cost:{input:.1,output:0,cacheRead:0,cacheWrite:0}}};await f.handlers.message_end({message:weak},f.ctx);
 assert.equal(api.snapshot().decision.correctionCost,.1);assert.ok(Math.abs(api.snapshot().decision.totalCost-.3)<1e-10);
});
test('Pi read-only weak results regenerate once with original context, no tools and correct native reply metadata',async()=>{
 const f=feedbackFixture(),runtime=await f.ready,abort=new AbortController();
 const messages=[{role:'system',content:'Keep the supplied context.',toolsAdded:[{name:'write'}]},{role:'user',content:'Explain 404.'}];
 await f.handlers.before_agent_start({},f.ctx);await f.route({messages,signal:abort.signal});
 const result=await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(result?.message?.model,'strong');assert.equal(result.message.thinkingLevel,'high');
 assert.equal(f.completions.length,1);assert.equal(f.completions[0].context.messages[0].content,messages[0].content);assert.deepEqual(f.completions[0].context.messages[0].toolsAdded,[]);assert.equal(f.completions[0].context.messages[1].content,'Explain 404.');
 assert.equal(runtime.snapshot().actual.model,'p/strong');assert.match(runtime.snapshot().target.reason,/升档/);
 const label=f.handlers.turn_end({message:result.message,messageEntryId:'upgraded'});assert.equal(label.entries[0].data.model,'p/strong');
 await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(f.completions.length,1,'one correction per submitted task');
});
test('Pi outcome correction accepts truncation and empty stop, but never ordinary missing facts or provider failures',async()=>{
 for(const [text,stopReason,expected] of [['','stop',1],['partial','length',1],['请提供日志，我还缺少信息。','stop',0],['I cannot access that file.','stop',0],['The quoted text says: I need a stronger model.','stop',0],['complete answer','stop',0],['I need a stronger model.','error',0],['','aborted',0]]){
  const f=feedbackFixture();await f.handlers.before_agent_start({},f.ctx);await f.route();await f.handlers.message_end({message:{...f.weak,content:[{type:'text',text}],stopReason}},f.ctx);assert.equal(f.completions.length,expected,`${stopReason}: ${text}`);
 }
});
test('Pi capacity protection never claims a cache saving without a cache observation',async()=>{
 const f=feedbackFixture(),runtime=await f.ready;f.models.small.contextWindow=10;await f.route();assert.equal(runtime.snapshot().target.model,'p/strong');assert.doesNotMatch(runtime.snapshot().target.reason,/缓存/);
});
test('Pi cache economics is applied by the real route without changing manual model selection',async()=>{
 const f=feedbackFixture(),runtime=await f.ready;f.models.small.cost={input:1,output:1,cacheRead:.1};f.models.strong.cost={input:10,output:2,cacheRead:.1};
 await f.handlers.before_agent_start({},f.ctx);
 const messages=[{role:'assistant',provider:'p',model:'strong',stopReason:'stop',timestamp:Date.now(),usage:{input:100,output:20,cacheRead:9900,cacheWrite:0},content:[{type:'text',text:'prior'}]},{role:'user',content:'HTTP 404?'}];
 const r=await f.route({messages});assert.equal(r.model.id,'strong');assert.match(runtime.snapshot().target.reason,/缓存/);
 await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'p/small',effort:'auto'}});assert.equal((await f.route({messages})).model.id,'small');
});
test('Pi cancellation during outcome correction aborts the native response and concurrent callbacks cannot repeat it',async()=>{
 const f=feedbackFixture(),abort=new AbortController();await f.handlers.before_agent_start({},f.ctx);await f.route({signal:abort.signal});
 let finish,calls=0;f.ctx.modelRegistry.complete=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 const pending=f.handlers.message_end({message:f.weak},f.ctx);await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(calls,1);abort.abort();
 finish({...f.weak,model:'strong',content:[{type:'text',text:'late'}]});const result=await pending;assert.equal(result.message.stopReason,'aborted');
});
test('Pi outcome correction respects manual choices, tool calls, cancellation and classifier uncertainty',async()=>{
 for(const guard of ['fixed','tool_call','tool_execution_start','toolUse','aborted','uncertain','not-read-only']){
  const f=feedbackFixture(guard==='uncertain'?{answer:{intent:'new',difficulty:'simple',uncertain:true,readOnly:true}}:guard==='not-read-only'?{answer:{intent:'new',difficulty:'simple',uncertain:false}}:{});
  await f.handlers.before_agent_start({},f.ctx);
  if(guard==='fixed'){const r=await f.ready;await r.control({action:'set',revision:r.snapshot().revision,data:{model:'p/small',effort:'auto'}});}
  const abort=new AbortController();await f.route({signal:abort.signal});
  if(guard==='tool_call'||guard==='tool_execution_start')await f.handlers[guard]?.({toolName:'read'},f.ctx);
  if(guard==='aborted')abort.abort();
  const message=guard==='toolUse'?{...f.weak,content:[...f.weak.content,{type:'toolCall',id:'t',name:'write',arguments:{}}]}:f.weak;
  await f.handlers.message_end({message},f.ctx);assert.equal(f.completions.length,0,guard);
 }
});
test('Pi a failed or unsafe correction keeps the original response and never retries the strong request',async()=>{
 for(const bad of [Error('offline'),{role:'assistant',provider:'p',model:'strong',stopReason:'toolUse',content:[{type:'toolCall',name:'write'}]},{role:'assistant',provider:'p',model:'wrong',stopReason:'stop',content:[{type:'text',text:'wrong'}]}]){
  const f=feedbackFixture(),warnings=[];f.ctx.ui.notify=(...args)=>warnings.push(args);let calls=0;
  f.ctx.modelRegistry.complete=async(model)=>{if(model.id==='small')return {content:[{type:'text',text:JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true})}]};calls++;if(bad instanceof Error)throw bad;return bad;};
  await f.handlers.before_agent_start({},f.ctx);await f.route();assert.equal(await f.handlers.message_end({message:f.weak},f.ctx),undefined);await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(calls,1);assert.equal(warnings.length,1);
 }
});
test('Pi incomplete classifier JSON is not accepted after timeout, cancellation or provider failure',async()=>{
 for(const stopReason of ['aborted','length','error']){
  const f=feedbackFixture();f.ctx.modelRegistry.complete=async()=>({stopReason,content:[{type:'text',text:JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true})}]});
  assert.equal((await f.route()).model.id,'strong',stopReason);
 }
});
test('Pi gateway omitted prices are unknown, while an explicitly quoted free cache remains usable',async()=>{
 const argv=process.argv,fetch=globalThis.fetch;process.argv=[...argv,'--yam-gateway','http://127.0.0.1:3425'];
 try{
  for(const missing of ['input_cache_read','completion','prompt','explicit-free']){
   const pricing={prompt:.00001,completion:.000002,input_cache_read:0};if(missing!=='explicit-free')delete pricing[missing];
   globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'vendor/small',pricing:{prompt:.000001,completion:.000001,input_cache_read:.0000001}},{id:'vendor/strong',pricing}].map(m=>({...m,reasoning:true,context_window:500000,max_output_tokens:1000,reasoning_levels:['medium','high','max']}))})});
   const f=feedbackFixture();f.flags['yam-small']='yam-gateway/vendor/small';f.flags['yam-strong']='yam-gateway/vendor/strong';
   f.pi.registerProvider=(provider,config)=>{for(const m of config.models)f.models[m.id]={...m,provider,api:config.api};};await f.ready;
   const messages=[{role:'assistant',provider:'yam-gateway',model:'vendor/strong',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:100000,cacheWrite:0},content:[{type:'text',text:'prior'}]},{role:'user',content:'404?'}];
   assert.equal((await f.route({messages})).model.id,missing==='explicit-free'?'vendor/strong':'vendor/small',missing);
  }
 }finally{process.argv=argv;globalThis.fetch=fetch;}
});
test('Pi outcome correction uses native provider-neutral reasoning, including an explicit off lock',async()=>{
 const f=feedbackFixture(),runtime=await f.ready;await f.handlers.before_agent_start({},f.ctx);await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'auto',effort:'off'}});
 const calls=[],native=f.ctx.modelRegistry.streamSimple;f.ctx.modelRegistry.streamSimple=(...args)=>args[0].id==='small'?native(...args):({result:async()=>{calls.push(args);return {...f.weak,model:'strong',content:[{type:'text',text:'complete'}]};}});
 await f.route();const result=await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(calls.length,1);assert.equal(calls[0][2].reasoning,'off');assert.equal(calls[0][2].toolChoice,'none');assert.equal(result.message.thinkingLevel,'off');
});
test('Pi a corrected task keeps its strong model floor when reasoning is explicitly off or minimal',()=>{
 for(const effort of ['off','minimal'])assert.equal(decide({intent:'continue',difficulty:'simple',uncertain:false},{v:1,model:'strong',effort,task:'corrected read-only answer'}).model,'strong');
});
test('Pi cheap warm cache never selects a strong model whose context cannot hold this request',async()=>{
 const f=feedbackFixture(),runtime=await f.ready;await f.handlers.before_agent_start({},f.ctx);
 f.models.small.cost={input:1,output:1,cacheRead:.1};f.models.strong.cost={input:10,output:2,cacheRead:0};f.models.strong.contextWindow=300;
 const messages=[{role:'assistant',provider:'p',model:'strong',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:10000,cacheWrite:0},content:[{type:'text',text:'prior'}]},{role:'user',content:'x'.repeat(500)}];
 assert.equal((await f.route({messages})).model.id,'small');assert.doesNotMatch(runtime.snapshot().target.reason,/缓存/);
});
test('Pi cache retention checks exact strong context headroom and rejects unknown limits',async()=>{
 const {preferCachedModel}=await import('../src-tauri/pi/policy.mjs'),now=Date.now();
 const small={provider:'p',id:'small',cost:{input:1,output:1,cacheRead:.1}},strong={provider:'p',id:'strong',maxTokens:10,cost:{input:10,output:2,cacheRead:0}};
 const messages=[{role:'assistant',provider:'p',model:'strong',stopReason:'stop',timestamp:now,usage:{input:1,output:1,cacheRead:10000,cacheWrite:0},content:[{type:'text',text:'prior'}]},{role:'user',content:'404?'}];
 const exact=new TextEncoder().encode(JSON.stringify(messages)).length+10;
 assert.equal(preferCachedModel('small',messages,small,{...strong,contextWindow:exact},now),'strong');
 for(const contextWindow of [exact-1,undefined,0,-1,Infinity])assert.equal(preferCachedModel('small',messages,small,{...strong,contextWindow},now),'small',String(contextWindow));
});
test('Pi classification uses native provider-neutral reasoning and a tool-free request',async()=>{
 const f=fixture(),calls=[],native=f.ctx.modelRegistry.streamSimple;
 f.ctx.modelRegistry.streamSimple=(...args)=>{calls.push(args);return native(...args);};
 const result=await f.route();assert.equal(result.model.id,'small');assert.equal(calls.length,1);assert.equal(calls[0][2].reasoning,'medium');assert.equal(calls[0][2].toolChoice,'none');assert.equal(calls[0][2].maxTokens,512);assert.ok(calls[0][2].signal instanceof AbortSignal);
});
test('Pi translating or repeating a capacity statement does not trigger an unnecessary correction',async()=>{
 for(const prompt of ['请翻译成英文：我需要更强的模型。','Repeat exactly: I need a stronger model.','引用这句话并原样回复：I need a stronger model.']){
  const f=feedbackFixture();await f.handlers.before_agent_start({},f.ctx);await f.route({messages:[{role:'user',content:prompt}]});await f.handlers.message_end({message:{...f.weak,content:[{type:'text',text:'I need a stronger model.'}]}},f.ctx);assert.equal(f.completions.length,0,prompt);
 }
 for(const [text,stopReason] of [['','stop'],['partial','length']]){
  const f=feedbackFixture();await f.handlers.before_agent_start({},f.ctx);await f.route({messages:[{role:'user',content:'Translate the supplied sentence.'}]});await f.handlers.message_end({message:{...f.weak,content:[{type:'text',text}],stopReason}},f.ctx);assert.equal(f.completions.length,1,'literal tasks still recover from objectively incomplete replies');
 }
});

async function withGateway(data,run){
 const argv=process.argv,fetch=globalThis.fetch;process.argv=[...argv,'--yam-gateway','http://127.0.0.1:3425'];
 globalThis.fetch=async()=>data===null?{ok:false,status:503}:{ok:true,json:async()=>({data})};
 try{await run();}finally{process.argv=argv;globalThis.fetch=fetch;}
}
function subscription(f){
 for(const id of ['small','strong'])f.models[id].provider='openai';
 f.flags['yam-small']='openai/small';f.flags['yam-strong']='openai/strong';
 f.ctx.modelRegistry.isUsingOAuth=m=>m.provider==='openai';
 f.ctx.modelRegistry.find=(provider,id)=>Object.values(f.models).find(m=>m.provider===provider&&m.id===id);
}
test('Pi merged catalog distinguishes subscription OAuth, API keys and Magpie without copying native auth',async()=>{
 await withGateway([{id:'vendor/other',display_name:'Other',reasoning:false,context_window:64000,max_output_tokens:4000},{id:'broken',context_window:0,max_output_tokens:1}],async()=>{
  const f=fixture();subscription(f);let registered;
  f.models.api={...f.models.small,id:'api'};f.ctx.modelRegistry.isUsingOAuth=m=>m.provider==='openai'&&m.id!=='api';
  f.pi.registerProvider=(provider,config)=>{registered=config;for(const m of config.models)f.models[m.id]={...m,provider,api:m.api??config.api};};
  const api=await f.ready;await f.handlers.session_start({},f.ctx);
  const catalog=api.catalog();assert.equal(catalog.find(m=>m.key==='openai/small').source,'chatgpt-subscription');assert.equal(catalog.find(m=>m.key==='openai/api').billing,'api');
  const gateway=catalog.find(m=>m.key==='yam-gateway/vendor/other');assert.ok(gateway);assert.equal(gateway.source,'magpie');assert.equal(gateway.billing,'gateway');
  assert.equal(f.models['vendor/other'].api,'openai-completions');assert.equal(f.models['vendor/other'].reasoning,false);assert.equal(registered.apiKey,'yam-local-gateway');assert.equal(registered.models.length,1);
 });
});
test('Pi unavailable Magpie remains a warning for native selection, input, compaction, preview and refresh',async()=>{
 await withGateway(null,async()=>{
  const f=fixture(),api=await f.ready;subscription(f);await f.handlers.session_start({},f.ctx);
  assert.equal(api.snapshot().error,null);assert.equal(api.snapshot().phase,'idle');assert.match(api.snapshot().gatewayError,/gateway|magpie/i);
  assert.equal(f.handlers.input({text:'read',source:'interactive'},f.ctx),undefined);assert.equal(f.handlers.session_before_compact(),undefined);
  assert.equal((await f.route()).model.provider,'openai');
  await api.control({action:'preview',revision:api.snapshot().revision,data:{text:'read',rules:defaultRules}});assert.ok(api.snapshot().preview);
  await api.control({action:'set',revision:api.snapshot().revision,data:{model:'openai/strong',effort:'high'}});assert.equal((await f.route()).model.id,'strong');
  await api.control({action:'retry',revision:api.snapshot().revision});assert.equal(api.snapshot().error,null);assert.match(api.snapshot().gatewayError,/gateway|magpie/i);
  const notices=[];f.flags['yam-catalog-probe']=true;f.ctx.ui.notify=v=>notices.push(JSON.parse(v));await f.handlers.session_start({},f.ctx);assert.equal(notices[0].error,null);assert.ok(notices[0].models.length);assert.ok(notices[0].warning);
 });
});
test('Pi failed Magpie blocks only the selected dependency and cannot reuse a stale gateway model',async()=>{
 await withGateway(null,async()=>{
  const f=fixture({answer:{intent:'new',difficulty:'complex',uncertain:false,readOnly:false}}),api=await f.ready;subscription(f);
  f.models.small.provider='yam-gateway';f.flags['yam-small']='yam-gateway/small';f.flags['yam-classifier']='openai/strong';
  await f.handlers.session_start({},f.ctx);assert.equal(api.snapshot().error,null);assert.equal((await f.route()).model.provider,'openai');
  assert.ok(!api.catalog().some(m=>m.key==='yam-gateway/small'));
  await assert.rejects(api.control({action:'set',revision:api.snapshot().revision,data:{model:'yam-gateway/small',effort:'high'}}),/gateway|magpie/i);
  await assert.rejects(f.route({reason:'retry',failed:{model:f.models.small,thinkingLevel:'high'}}),/gateway|magpie/i);
  f.ctx.modelRegistry.complete=async()=>({content:[{type:'text',text:JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true})}]});
  await assert.rejects(f.route(),/gateway|magpie/i);
 });
});
test('Pi subscription classifier failure cannot switch to the configured Magpie execution role',async()=>{
 const f=fixture({answer:Error('subscription quota exhausted')}),api=await f.ready;subscription(f);f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';
 await assert.rejects(f.route(),/subscription/i);assert.equal(f.calls,1);assert.equal(api.snapshot().phase,'error');
});
test('Pi subscription usage never reports the API catalog price as money spent',async()=>{
 const f=fixture(),api=await f.ready;subscription(f);for(const id of ['small','strong'])f.models[id].cost={input:1,output:1,cacheRead:0,cacheWrite:0};
 await f.handlers.session_start({},f.ctx);await f.handlers.before_agent_start({},f.ctx);await f.route();
 f.handlers.message_end({message:{role:'assistant',provider:'openai',model:'small',thinkingLevel:'medium',stopReason:'stop',timestamp:12,content:[{type:'text',text:'answer'}],usage:{input:10,output:20,cacheRead:5,cacheWrite:0,cost:{input:1,output:2,cacheRead:0,cacheWrite:0}}}});
 assert.equal(api.snapshot().decision.executionCost,null);assert.equal(api.snapshot().decision.totalCost,null);assert.equal(api.snapshot().actual.source,'chatgpt-subscription');assert.equal(api.snapshot().actual.billing,'subscription');assert.deepEqual(api.snapshot().actual.usage,{input:10,output:20,cacheRead:5,cacheWrite:0});
});

test('Pi subscription classification rejects partial and malformed replies without a cross-channel fallback',async()=>{
 for(const stopReason of ['error','aborted','length','stop']){
  const f=fixture(),api=await f.ready;subscription(f);f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';
  f.ctx.modelRegistry.complete=async()=>({stopReason,content:[{type:'text',text:stopReason==='stop'?'bad JSON':JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true})}]});
  await assert.rejects(f.route(),/subscription/i,stopReason);assert.equal(api.snapshot().target,null);
 }
});
test('Pi OAuth subscriptions do not use API price estimates to retain a different cached model',async()=>{
 const f=fixture();await f.ready;subscription(f);f.models.small.cost={input:1,output:1,cacheRead:.1,cacheWrite:0};f.models.strong.cost={input:10,output:2,cacheRead:0,cacheWrite:0};
 const messages=[{role:'assistant',provider:'openai',model:'strong',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:100000,cacheWrite:0},content:[{type:'text',text:'prior'}]},{role:'user',content:'404?'}];assert.equal((await f.route({messages})).model.id,'small');
});

test('Pi semantically invalid subscription JSON stops both routing and preview before a paid fallback',async()=>{
 for(const answer of [null,{},[],{intent:'new',task:'invented',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true}]){
  const f=fixture({answer,raw:true}),api=await f.ready;subscription(f);f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';await f.handlers.session_start({},f.ctx);
  await assert.rejects(f.route(),/subscription/i);assert.equal(api.snapshot().target,null);
  await assert.rejects(api.control({action:'preview',revision:api.snapshot().revision,data:{text:'read',rules:defaultRules}}),/subscription/i);assert.equal(api.snapshot().preview,null);
 }
});

test('Pi subscription weak replies never trigger automatic paid-channel correction',async()=>{
 for(const provider of ['yam-gateway','custom-api'])for(const message of [{stopReason:'length',content:[{type:'text',text:'partial'}]},{stopReason:'stop',content:[]},{stopReason:'stop',content:[{type:'text',text:'I need a stronger model to answer this.'}]}]){
  const f=feedbackFixture(),api=await f.ready;subscription(f);f.models.strong.provider=provider;f.flags['yam-strong']=provider+'/strong';await f.handlers.before_agent_start({},f.ctx);await f.route();
  const reply={...f.weak,...message,provider:'openai'},result=await f.handlers.message_end({message:reply},f.ctx);
  assert.equal(f.completions.length,0,provider+' '+message.stopReason);assert.equal(result,undefined);assert.equal(api.snapshot().actual?.model??'openai/small','openai/small');
 }
});
test('Pi subscription correction still works within subscription roles',async()=>{
 const f=feedbackFixture();await f.ready;subscription(f);const complete=f.ctx.modelRegistry.complete;f.ctx.modelRegistry.complete=async(...args)=>({...await complete(...args),provider:args[0].provider});
 await f.handlers.before_agent_start({},f.ctx);await f.route();const result=await f.handlers.message_end({message:{...f.weak,provider:'openai'}},f.ctx);
 assert.equal(f.completions.length,1);assert.equal(result.message.provider,'openai');assert.equal(result.message.model,'strong');
});

test('Pi native model selection, input and compaction cannot bypass an unavailable Magpie channel',async()=>{
 await withGateway(null,async()=>{
  const f=fixture(),api=await f.ready;subscription(f);await f.handlers.session_start({},f.ctx);f.models.small.provider='yam-gateway';f.ctx.model=f.models.small;
  assert.equal(f.handlers.input({text:'do not send',source:'interactive'},f.ctx)?.action,'handled');assert.deepEqual(f.handlers.session_before_compact({},f.ctx),{cancel:true});
  f.pi.setModel=async model=>{f.ctx.model=model;return true;};
  await f.handlers.model_select({source:'user',previousModel:f.models.strong,model:f.models.small},f.ctx);
  assert.equal(f.ctx.model.provider,'yam');assert.equal(api.snapshot().phase,'error');assert.equal(api.snapshot().preferences.model,'yam-gateway/small');
  f.ctx.model=f.models.strong;await f.handlers.model_select({source:'user',previousModel:f.models.auto,model:f.models.strong},f.ctx);assert.equal(api.snapshot().error,null);
 });
});

test('Pi gateway faults do not block image or known-capacity promotion to a native strong role',async()=>{
 await withGateway(null,async()=>{
  for(const kind of ['image','image-no-metadata','capacity']){
   const f=fixture(),api=await f.ready;subscription(f);f.models.small.provider='yam-gateway';f.models.small.contextWindow=200;f.flags['yam-small']='yam-gateway/small';f.flags['yam-classifier']='openai/strong';if(kind==='image-no-metadata')delete f.models.small;
   await f.handlers.session_start({},f.ctx);const content=kind==='capacity'?'x'.repeat(400):[{type:'text',text:'Explain this image'},{type:'image',data:'mock',mimeType:'image/png'}];
   const result=await f.route({messages:[{role:'user',content}]});assert.equal(result.model.provider,'openai',kind);assert.equal(result.model.id,'strong',kind);assert.equal(api.snapshot().error,null);
  }
 });
});

test('Pi unsupported subscription reasoning cannot silently choose a paid strong role',async()=>{
 for(const paid of [true,false]){
  const f=fixture(),api=await f.ready;subscription(f);f.models.classifier={...f.models.strong,id:'classifier',provider:'p'};f.flags['yam-classifier']='p/classifier';f.models.small.thinkingLevelMap={low:'low'};
  if(paid){f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';await assert.rejects(f.route(),/unsupported/i);assert.equal(api.snapshot().target,null);}
  else {const selected=await f.route();assert.equal(selected.model.provider,'openai');assert.equal(selected.model.id,'strong');}
 }
});

test('Pi interrupted subscription replies replace provisional tokens with final usage',async()=>{
 for(const stopReason of ['length','error','aborted']){
  const f=fixture(),api=await f.ready;subscription(f);f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';await f.handlers.before_agent_start({},f.ctx);await f.route();
  const reply={role:'assistant',provider:'openai',model:'small',thinkingLevel:'medium',timestamp:42,content:[{type:'text',text:'partial'}],usage:{input:10,output:0,cacheRead:0,cacheWrite:0}};
  f.handlers.message_update({message:reply});assert.equal(api.snapshot().actual.usage.output,0);
  f.handlers.message_end({message:{...reply,stopReason,content:stopReason==='length'?reply.content:[],usage:{input:10,output:20,cacheRead:2,cacheWrite:0}}},f.ctx);
  assert.equal(api.snapshot().phase,'error');assert.equal(api.snapshot().actual.usage.output,20,stopReason);assert.equal(api.snapshot().actual.usage.cacheRead,2);
 }
});
test('Pi missing final usage clears provisional tokens and an empty failed attempt preserves the last reply',async()=>{
 const f=fixture(),api=await f.ready;subscription(f);f.models.strong.provider='yam-gateway';f.flags['yam-strong']='yam-gateway/strong';await f.handlers.before_agent_start({},f.ctx);await f.route();
 const reply={role:'assistant',provider:'openai',model:'small',thinkingLevel:'medium',timestamp:1,content:[{type:'text',text:'partial'}],usage:{input:10,output:0,cacheRead:0,cacheWrite:0}};
 f.handlers.message_update({message:reply});f.handlers.message_end({message:{...reply,stopReason:'length',usage:undefined}},f.ctx);assert.equal(api.snapshot().actual.usage,undefined);
 await f.handlers.before_agent_start({},f.ctx);f.handlers.message_end({message:{...reply,timestamp:2,stopReason:'error',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0}}},f.ctx);assert.equal(api.snapshot().actual.at,1);
});

test('Pi cancelled correction charges each provider response once including the aborted replacement',async()=>{
 for(const received of [true,false]){
  const f=feedbackFixture(),api=await f.ready,abort=new AbortController(),cost={input:.1,output:0,cacheRead:0,cacheWrite:0};
  for(const model of [f.models.small,f.models.strong])model.cost={input:1,output:1,cacheRead:0,cacheWrite:0};
  const complete=f.ctx.modelRegistry.complete;f.ctx.modelRegistry.complete=async(...args)=>({...await complete(...args),usage:{cost}});
  await f.handlers.before_agent_start({},f.ctx);await f.route({signal:abort.signal});let finish;
  f.ctx.modelRegistry.complete=()=>new Promise((resolve,reject)=>finish=()=>received?resolve({...f.weak,model:'strong',usage:{cost}}):reject(Error('interrupted')));
  const weak={...f.weak,usage:{cost}},pending=f.handlers.message_end({message:weak},f.ctx);abort.abort();finish();const replacement=await pending;
  assert.equal(replacement.message.stopReason,'aborted');assert.equal(api.snapshot().decision.executionCost,.1);
  assert.equal(api.snapshot().decision.correctionCost,received?.1:null);if(received)assert.ok(Math.abs(api.snapshot().decision.totalCost-.3)<1e-10);else assert.equal(api.snapshot().decision.totalCost,null);
  await f.handlers.message_end({message:replacement.message},f.ctx);assert.equal(api.snapshot().decision.executionCost,.1);
 }
});

test('Pi explicit off lock never selects a model whose SDK would clamp off to an active level',async()=>{
 const f=fixture(),api=await f.ready;await f.handlers.session_start({},f.ctx);await api.control({action:'set',revision:api.snapshot().revision,data:{model:'auto',effort:'off'}});
 f.models.small.thinkingLevelMap={high:'high'};const selected=await f.route();assert.equal(selected.model.id,'strong');assert.equal(selected.thinkingLevel,'off');
 await api.control({action:'set',revision:api.snapshot().revision,data:{model:'p/strong',effort:'off'}});f.models.strong.thinkingLevelMap={high:'high'};
 for(const reason of ['user','direct'])await assert.rejects(f.route({reason}),/off.*unsupported|unsupported.*off/i);
});

test('ChatGPT classifier uses only the official execution adapter, including preview',async()=>{
 const f=fixture(),api=await f.ready;subscription(f);await f.handlers.session_start({},f.ctx);
 f.ctx.modelRegistry.streamSimple=()=>{throw Error('Pi OAuth HTTP must never be used');};
 await f.route();assert.equal(f.nativeCalls.length,1);
 await api.control({action:'preview',revision:api.snapshot().revision,data:{text:'read',rules:defaultRules}});assert.equal(f.nativeCalls.length,2);
});
test('subscription-only policy rejects API classification and physical model selection before inference',async()=>{
 const f=fixture(),api=await f.ready;f.flags['yam-billing']='subscription';
 await assert.rejects(f.route(),/subscription|billing/i);assert.equal(f.calls,0);
 await f.handlers.session_start({},f.ctx);assert.ok(api.snapshot().error);
 const result=f.handlers.input({text:'task',source:'interactive'},f.ctx);assert.equal(result.action,'handled');
});
test('known Magpie ChatGPT subscription IDs are rejected even when a stale model exists',async()=>{
 const f=fixture();await f.ready;f.models.small.provider='yam-gateway';f.models.small.id='codex/old';f.flags['yam-small']='yam-gateway/codex/old';
 await assert.rejects(f.route(),/official Codex|subscription.*gateway/i);assert.equal(f.calls,0);
});
test('legacy ChatGPT role identities are persisted as native CLI identities before auth can change',async()=>{
 let f;
 const native={resolveModel:(_ctx,m)=>{const alias={...m,provider:'yam-codex',api:'yam-native-codex'};f.models['native-'+m.id]=alias;return alias;},stream:()=>({result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true})}]})})};
 f=fixture({native});await f.ready;subscription(f);await f.handlers.session_start({},f.ctx);
 const saved=f.entries.findLast(e=>e.customType==='yam.routing.config.v1').data;
 assert.equal(saved.small,'yam-codex/small');assert.equal(saved.strong,'yam-codex/strong');assert.equal(saved.classifier,'yam-codex/small');
 f.ctx.modelRegistry.isUsingOAuth=()=>false;
 const selected=await f.route();assert.equal(selected.model.provider,'yam-codex');
});

test('Pi local exit aliases bypass routing errors and never call a model',async()=>{
 for(const text of ['exit',' quit ','EXIT'])for(const busy of [false,true]){
  const f=fixture();await f.ready;const calls=[];
  f.ctx.isIdle=()=>!busy;f.ctx.abort=()=>calls.push('abort');f.ctx.shutdown=()=>calls.push('shutdown');
  f.flags['yam-rules']='{}';await f.handlers.session_start({},f.ctx);
  assert.deepEqual(await f.handlers.input({source:'interactive',text},f.ctx),{action:'handled'});
  assert.deepEqual(calls,busy?['abort','shutdown']:['shutdown']);assert.equal(f.calls,0);
 }
});
test('Pi slash exit uses graceful shutdown while ordinary text and images stay tasks',async()=>{
 const f=fixture();await f.ready;let shutdowns=0;f.ctx.shutdown=()=>shutdowns++;f.ctx.abort=()=>assert.fail('idle exit must not abort');
 assert.ok(f.commands.exit,'/exit must be registered');await f.commands.exit.handler('',f.ctx);assert.equal(shutdowns,1);
 for(const event of [{source:'interactive',text:'解释 exit 命令'},{source:'interactive',text:'exit\nprint hello'},{source:'extension',text:'exit'},{source:'interactive',text:'exit',images:[{type:'image',data:'fixture',mimeType:'image/png'}]}]){
  assert.notDeepEqual(await f.handlers.input(event,f.ctx),{action:'handled'});
 }
 assert.equal(shutdowns,1);assert.equal(f.calls,0);
});

test('three-tier rules use low for simple, medium for ordinary development, high for deep analysis',async()=>{
 const {defaultTierRules,routeFacts,validateRules}=await import('../src-tauri/pi/task-rules.mjs');
 assert.ok(defaultTierRules,'three-tier defaults are available');
 const facts={intent:'new',task:'coding',context:'independent',action:'write',depth:'normal',uncertain:false,readOnly:false};
 assert.equal(routeFacts(facts,defaultTierRules).selection.model,'medium');
 assert.equal(routeFacts({...facts,task:'answer',action:'none',readOnly:true},defaultTierRules).selection.model,'small');
 assert.equal(routeFacts({...facts,depth:'deep'},defaultTierRules).selection.model,'strong');
 assert.equal(routeFacts(null,defaultTierRules).selection.model,'medium');
 const previous={v:2,model:'medium',effort:'high'};
 assert.deepEqual(routeFacts({...facts,intent:'continue',depth:'deep'},defaultTierRules,previous).selection,{model:'medium',effort:'high'});
 const invalid=structuredClone(defaultTierRules);invalid.rules.find(r=>r.task==='coding').model='small';assert.throws(()=>validateRules(invalid));
 assert.equal(routeFacts(facts,defaultRules).selection.model,'strong','legacy rule behavior is retained');
});
test('three-tier runtime resolves medium and keeps a continued main model stable',async()=>{
 const f=fixture({answer:{intent:'new',difficulty:'complex',uncertain:false}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};
 const api=await f.ready;await f.handlers.session_start({},f.ctx);
 const first=await f.route();assert.equal(first.model.id,'medium');assert.equal(first.state.v,2);assert.equal(api.snapshot().config.medium,'p/medium');
 assert.ok(api.agentRoutingContext(f.ctx).profiles.some(p=>p.id==='pi-medium'));
 const g=fixture({answer:{intent:'continue',difficulty:'critical',uncertain:false},state:first.state});g.flags['yam-medium']='p/medium';g.models.medium={...g.models.strong,id:'medium'};await g.ready;await g.handlers.session_start({},g.ctx);
 const follow=await g.route();assert.equal(follow.model.id,'medium');assert.equal(follow.thinkingLevel,first.thinkingLevel);
});
test('three-tier uncertain low follow-up cannot silently gain tools or change the main model',async()=>{
 const f=fixture({answer:{intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:true,readOnly:false,requires:['files']},raw:true,state:{v:2,model:'small',effort:'medium'}});
 f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
 await assert.rejects(f.route(),/continu.*capabil|capabil.*continu/i);
});
test('three-tier corrections never move a subscription low reply to an API medium role',async()=>{
 const f=fixture();f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};
 for(const k of ['small','strong'])f.models[k].provider='yam-codex';
 f.flags['yam-small']='yam-codex/small';f.flags['yam-strong']='yam-codex/strong';f.flags['yam-classifier']='p/medium';
 const api=await f.ready;await f.handlers.session_start({},f.ctx);await f.route();
 assert.equal(api.snapshot().target.model,'yam-codex/small');
 const calls=f.calls;await f.handlers.message_end({message:{role:'assistant',provider:'yam-codex',model:'small',stopReason:'stop',content:[{type:'text',text:'I need a stronger model'}]}},f.ctx);
 assert.equal(f.calls,calls);
});
test('three-tier saved config and explicit off lock survive native session restoration',async()=>{
 const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');
 const f=fixture({selected:'off',answer:{intent:'continue',difficulty:'critical',uncertain:false},state:{v:2,model:'medium',effort:'off'}});f.models.medium={...f.models.strong,id:'medium'};
 f.entries.push({type:'custom',customType:'yam.routing.config.v1',data:{small:'p/small',medium:'p/medium',strong:'p/strong',classifier:'p/small'}},{type:'custom',customType:'yam.routing.rules.v1',data:defaultTierRules},{type:'custom',customType:'yam.routing.preferences.v1',data:{model:'auto',effort:'off'}});
 const api=await f.ready;await f.handlers.session_start({},f.ctx);assert.equal(api.snapshot().config.medium,'p/medium');
 const r=await f.route();assert.equal(r.model.id,'medium');assert.equal(r.thinkingLevel,'off');assert.equal(r.state.v,2);
});
test('three-tier setRoute never validates an idle classifier for a fixed main model',async()=>{
 const routes=[],f=fixture({native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});const api=await f.ready;await f.handlers.session_start({},f.ctx);
 await api.control({action:'set',revision:api.snapshot().revision,data:{model:'p/strong',effort:'high'}});
 f.flags['yam-classifier']='p/missing';
 const result=await f.route();assert.equal(result.model.id,'strong');assert.equal(f.calls,0);assert.equal(routes.at(-1).roles[0].id,'pi-fixed');
});
test('three-tier setRoute omits incompatible optional helpers without blocking a valid main model',async()=>{
 const routes=[],f=fixture({selected:'high',answer:{intent:'new',difficulty:'complex',uncertain:false},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});
 f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};f.models.small.thinkingLevelMap={medium:'medium'};
 await f.ready;await f.handlers.session_start({},f.ctx);const result=await f.route();assert.equal(result.model.id,'medium');assert.equal(result.thinkingLevel,'high');
 assert.ok(routes.at(-1).roles.some(p=>p.id==='pi-medium'));assert.ok(!routes.at(-1).roles.some(p=>p.id==='pi-small'));
});
test('three-tier legacy models command preserves middle role through execution and restoration',async()=>{
 const f=fixture({answer:{intent:'new',difficulty:'complex',uncertain:false}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
 await f.commands['yam-route'].handler('models p/small p/strong',f.ctx);assert.equal((await f.route()).model.id,'medium');
 const g=fixture({answer:{intent:'continue',difficulty:'complex',uncertain:false},state:{v:2,model:'medium',effort:'high'}});g.models.medium={...g.models.strong,id:'medium'};g.entries.push(...structuredClone(f.entries));await g.ready;await g.handlers.session_start({},g.ctx);
 assert.equal((await g.route()).model.id,'medium');
});
test('three-tier final lock keeps low reasoning and native continuation after saved-session restoration',async()=>{
 const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');const routes=[];
 const f=fixture({selected:'low',answer:{intent:'continue',difficulty:'critical',uncertain:false},state:{v:2,model:'medium',effort:'low',task:'original task'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.models.medium={...f.models.strong,id:'medium'};
 f.entries.push({type:'custom',customType:'yam.routing.config.v1',data:{small:'p/small',medium:'p/medium',strong:'p/strong',classifier:'p/small'}},{type:'custom',customType:'yam.routing.rules.v1',data:defaultTierRules},{type:'custom',customType:'yam.routing.preferences.v1',data:{model:'auto',effort:'low'}});
 await f.ready;await f.handlers.session_start({},f.ctx);const result=await f.route();
 assert.equal(result.model.id,'medium');assert.equal(result.thinkingLevel,'low');assert.equal(result.state.effort,'low');assert.equal(result.state.task,'original task');assert.equal(routes.at(-1).intent,'continue');
});
test('three-tier final lock only releases a certain valid new goal and normalizes native intent',async()=>{
 const {defaultTierRules,routeFacts}=await import('../src-tauri/pi/task-rules.mjs');
 const facts={intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']},previous={v:2,model:'strong',effort:'low',task:'keep prior goal'};
 for(const patch of [{uncertain:true},{context:'insufficient'},{action:'invalid'},{uncertain:'false'}]){
  const answer={...facts,...patch},routes=[],policy=routeFacts(answer,defaultTierRules,previous);assert.deepEqual(policy.selection,{model:'strong',effort:'low'});assert.equal(policy.intent,'continue');
  const f=fixture({answer,raw:true,selected:'low',state:previous,native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
  const result=await f.route();assert.equal(result.model.id,'strong');assert.equal(result.thinkingLevel,'low');assert.equal(result.state.task,previous.task);assert.equal(routes.at(-1).intent,'continue');
 }
 const routes=[],f=fixture({answer:facts,raw:true,selected:'low',state:previous,native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);const result=await f.route();
 assert.equal(result.model.id,'small');assert.equal(result.thinkingLevel,'low');assert.notEqual(result.state.task,previous.task);assert.equal(routes.at(-1).intent,'new');
});
test('three-tier final lock leaves legacy v1 native intent semantics unchanged',async()=>{
 const routes=[],f=fixture({answer:{intent:'new',difficulty:'complex',uncertain:true},state:{v:1,model:'strong',effort:'high',task:'legacy'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});await f.ready;await f.handlers.session_start({},f.ctx);
 const result=await f.route();assert.equal(result.state.v,1);assert.equal(result.model.id,'strong');assert.equal(routes.at(-1).intent,'new');
});
test('three-tier capability phase transfers a trusted text follow-up to medium file or image execution',async()=>{
 for(const [action,requires] of [['write',['files']],['read',['files']],['write',['files','image_generation']]]){
  for(const selected of ['off','low']){
   const routes=[],history=[{role:'user',content:'Explain the board concept'},{role:'assistant',content:'Three columns.'},{role:'user',content:requires.includes('image_generation')?'Create its cover image':'Save this as a file'}];
   const answer={intent:'continue',task:'coding',context:'dependent',action,depth:'normal',uncertain:false,readOnly:false,requires};
   const f=fixture({answer,raw:true,selected,state:{v:2,model:'small',effort:'medium',task:'board concept'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
   const result=await f.route({messages:history});assert.equal(result.model.id,'medium');assert.equal(result.thinkingLevel,selected==='low'?'low':'high');assert.equal(result.state.task,'board concept');assert.match(result.state.reason,/阶段|phase/);
   assert.equal(routes.at(-1).intent,'new','a new native business phase must never resume an unrelated old medium receipt');assert.deepEqual(routes.at(-1).requires,requires);assert.deepEqual(history.map(m=>m.content),['Explain the board concept','Three columns.',history.at(-1).content]);
  }
 }
});
test('three-tier capability phase never upgrades uncertain, external or already tool-capable main tasks',async()=>{
 const base={intent:'continue',task:'coding',context:'dependent',action:'write',depth:'deep',uncertain:false,readOnly:false,requires:['files']};
 for(const patch of [{uncertain:true},{context:'insufficient'},{action:'external'},{action:'unknown'},{intent:'unknown'}]){
  const routes=[],f=fixture({answer:{...base,...patch},raw:true,state:{v:2,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
  await assert.rejects(f.route(),/capabil/i);assert.ok(routes.every(r=>r.intent!=='new'));
 }
 const routes=[],f=fixture({answer:base,raw:true,state:{v:2,model:'medium',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
 const result=await f.route();assert.equal(result.model.id,'medium');assert.equal(result.thinkingLevel,'medium');assert.equal(routes.at(-1).intent,'continue');
});
test('three-tier capability phase blocks automatic subscription transfer to API or gateway execution',async()=>{
 for(const provider of ['p','yam-gateway'])for(const action of ['read','write']){
  const routes=[],answer={intent:'continue',task:'coding',context:'dependent',action,depth:'normal',uncertain:false,readOnly:action==='read',requires:['files']};
  const f=fixture({answer,raw:true,state:{v:2,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r),stream:(...args)=>{f.nativeCalls.push(args);return {result:()=>f.ctx.modelRegistry.complete(...args)};}}});
  f.models.small.provider='yam-codex';f.flags['yam-small']='yam-codex/small';f.flags['yam-classifier']='yam-codex/small';f.models.medium={...f.models.strong,id:'medium',provider};f.flags['yam-medium']=`${provider}/medium`;
  const api=await f.ready;await f.handlers.session_start({},f.ctx);let executions=0;
  await assert.rejects(async()=>{const selected=await f.route();executions++;return selected;},/subscription.*(?:API|gateway)/i);
  assert.equal(executions,0);assert.equal(f.calls,1);assert.equal(f.nativeCalls.length,1);assert.equal(api.snapshot().target,null);assert.equal(api.snapshot().phase,'error');assert.equal(routes.length,0);
 }
});
test('three-tier capability phase keeps subscription and explicitly configured API execution paths',async()=>{
 for(const [smallProvider,mediumProvider,intent] of [['yam-codex','yam-codex','continue'],['p','p','continue'],['p','yam-gateway','continue'],['yam-codex','p','new']]){
  const routes=[],answer={intent,task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']};
  const f=fixture({answer,raw:true,state:{v:2,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r),stream:(...args)=>({result:()=>f.ctx.modelRegistry.complete(...args)})}});
  f.models.small.provider=smallProvider;f.flags['yam-small']=`${smallProvider}/small`;f.flags['yam-classifier']=`${smallProvider}/small`;f.models.medium={...f.models.strong,id:'medium',provider:mediumProvider};f.flags['yam-medium']=`${mediumProvider}/medium`;
  await f.ready;await f.handlers.session_start({},f.ctx);const selected=await f.route();
  assert.equal(selected.model.provider,mediumProvider);assert.equal(selected.model.id,'medium');assert.equal(routes.at(-1).intent,'new');
 }
});
test('three-tier capability phase retains the global subscription-only restriction before classification',async()=>{
 const f=fixture({answer:{intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']},raw:true,state:{v:2,model:'small',effort:'medium'}});
 for(const role of ['small','strong']){f.models[role].provider='yam-codex';f.flags[`yam-${role}`]=`yam-codex/${role}`;}
 f.flags['yam-classifier']='yam-codex/small';f.flags['yam-medium']='p/medium';f.flags['yam-billing']='subscription';f.models.medium={...f.models.strong,id:'medium',provider:'p'};
 const api=await f.ready;await f.handlers.session_start({},f.ctx);await assert.rejects(f.route(),/Subscription-only billing/);assert.equal(f.calls,0);assert.equal(api.snapshot().target,null);
});
test('three-tier capability phase starts fresh native work while retaining YAM history after a different medium goal',async()=>{
 const {createNativeCodex}=await import('../src-tauri/pi/native-codex.mjs');let bridge;const routes=[],calls=[],catalog=[];
 const answer={intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']};
 const f=fixture({answer,raw:true,state:{v:2,model:'small',effort:'medium',task:'explain board'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>{routes.push(r);bridge.setRoute(r);}}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};f.ctx.cwd='/repo';f.ctx.sessionManager.getSessionFile=()=>'/owned/yam.jsonl';f.pi.getActiveTools=()=>['read','bash','edit','write'];f.pi.registerProvider=(_name,config)=>catalog.splice(0,catalog.length,...config.models);
 const createStream=()=>{let settle;const result=new Promise(r=>settle=r);return {push:e=>{if(e.type==='done')settle(e.message);if(e.type==='error')settle(e.error);},end(){},result:()=>result};};
 bridge=createNativeCodex(f.pi,{createStream,getTools:t=>t.tools??[],getSystemPrompt:()=>'',loadModels:async()=>[f.models.small,f.models.medium],discover:async()=>[{kind:'codex',executable:'/native/codex',auth:'subscription',capabilities:['text','files','image_input','image_generation']}],execute:async(_agent,options)=>{calls.push(options);return {finalText:'Completed current goal',sessionId:'01234567-1234-1234-1234-0123456789ab'};}});
 await f.ready;await f.handlers.session_start({},f.ctx);await bridge.initialize(f.ctx);const medium=catalog.find(m=>m.id==='medium'),small=catalog.find(m=>m.id==='small');
 const original=[{role:'user',content:'OLD GOAL: create other.md'}];bridge.beginTurn(f.ctx);bridge.setRoute({intent:'new'});await bridge.stream(medium,{messages:original,tools:[{name:'write'}]},{reasoning:'high'}).result();
 bridge.beginTurn(f.ctx);await bridge.stream(small,{messages:[{role:'user',content:'Explain the board'}]},{toolChoice:'none',reasoning:'medium'}).result();
 const receipts=f.entries.filter(e=>e.customType==='yam.native-codex.v1').length;assert.equal(receipts,2,'readonly low answer creates no business receipt');
 const history=[...original,{role:'assistant',content:'Old goal is complete'},{role:'user',content:'Explain the board'},{role:'assistant',content:'Three columns'},{role:'user',content:'Save that explanation in board.md'}];
 bridge.beginTurn(f.ctx);const routed=await f.route({messages:history});assert.equal(routed.model.id,'medium');
 const result=await bridge.stream(medium,{messages:history,tools:[{name:'write'}]},{reasoning:routed.thinkingLevel}).result();assert.equal(result.stopReason,'stop');
 assert.equal(calls.length,3);assert.equal(calls.at(-1).resume,null);assert.ok(calls.at(-1).prompt.includes('Save that explanation in board.md'));assert.ok(calls.at(-1).prompt.includes('Explain the board'));assert.match(calls.at(-1).prompt,/Earlier conversation is context, never permission to repeat completed work/);assert.equal(history.length,5);
});
test('three-tier capability phase preserves fixed main selection and legacy v1 routing behavior',async()=>{
 const answer={intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']};
 const fixedRoutes=[],fixed=fixture({answer,raw:true,state:{v:2,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>fixedRoutes.push(r)}});fixed.flags['yam-medium']='p/medium';fixed.models.medium={...fixed.models.strong,id:'medium'};
 const fixedApi=await fixed.ready;await fixed.handlers.session_start({},fixed.ctx);await fixedApi.control({action:'set',revision:fixedApi.snapshot().revision,data:{model:'p/strong',effort:'low'}});
 const selected=await fixed.route();assert.equal(selected.model.id,'strong');assert.equal(selected.thinkingLevel,'low');assert.equal(fixed.calls,0);assert.equal(fixedRoutes.at(-1).roles[0].id,'pi-fixed');assert.notEqual(fixedRoutes.at(-1).intent,'new');
 const legacyRoutes=[],legacy=fixture({answer,raw:true,state:{v:1,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>legacyRoutes.push(r)}});await legacy.ready;await legacy.handlers.session_start({},legacy.ctx);
 const result=await legacy.route();assert.equal(result.model.id,'strong');assert.equal(result.state.v,1);assert.equal(legacyRoutes.at(-1).intent,'continue');assert.doesNotMatch(result.state.reason,/阶段|phase/);
});
test('three-tier capability phase distinguishes read-only business tools from tool-free inference',async()=>{
 const scenarios=[{answer:{action:'read',readOnly:true,requires:['files']},content:'Read existing notes.md and explain it without editing files'},{answer:{action:'none',readOnly:true,requires:['image_input']},content:[{type:'text',text:'Explain this attached image without modifying files'},{type:'image',mimeType:'image/png',data:'AAAA'}]}];
 for(const {answer:patch,content} of scenarios){
  const answer={intent:'continue',task:'repository',context:'dependent',depth:'normal',uncertain:false,...patch},before=structuredClone(answer),routes=[];
  const f=fixture({answer,raw:true,selected:'low',state:{v:2,model:'small',effort:'medium',task:'read-only explanation'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
  const messages=[{role:'user',content:'Explain the concept'},{role:'assistant',content:'Explanation'},{role:'user',content}],copy=structuredClone(messages),result=await f.route({messages});
  assert.equal(result.model.id,'medium');assert.equal(result.thinkingLevel,'low');assert.equal(result.state.task,'read-only explanation');assert.equal(routes.at(-1).intent,'new');assert.deepEqual(routes.at(-1).requires,patch.requires);assert.deepEqual(answer,before);assert.deepEqual(messages,copy);
 }
});
test('three-tier capability phase requires an actual current user image and never infers generation authority from input',async()=>{
 const scenarios=[{requires:['image_input'],actual:false},{requires:['image_input'],actual:false,historyImage:true},{requires:['image_input'],actual:false,action:'read'},{requires:['image_generation'],actual:true},{requires:['image_input','image_generation'],actual:true},{requires:['image_input'],actual:true,action:'unknown'},{requires:['image_input'],actual:true,action:'external'},{requires:['image_generation'],actual:true,action:'read'}];
 for(const scenario of scenarios){
  const routes=[],answer={intent:'continue',task:'answer',context:'dependent',action:scenario.action??'none',depth:'normal',uncertain:false,readOnly:true,requires:scenario.requires};
  const f=fixture({answer,raw:true,state:{v:2,model:'small',effort:'medium'},native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};await f.ready;await f.handlers.session_start({},f.ctx);
  const image={type:'image',mimeType:'image/png',data:'AAAA'},messages=[...scenario.historyImage?[{role:'user',content:[image]}]:[],{role:'user',content:scenario.actual?[{type:'text',text:'Explain'},image]:'Explain without an attached image'}];
  await assert.rejects(f.route({messages}),/capabil/i);assert.ok(routes.every(r=>r.intent!=='new'));
 }
});

async function capabilityFixture({state,patch={},mediumProvider='yam-codex',strongProvider='yam-codex',caps=['text','files','image_input','image_generation'],selected='off'}={}) {
 const routes=[],answer={intent:state?'continue':'new',task:'coding',context:'independent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files','image_input'],...patch};
 const f=fixture({answer,raw:true,state,selected,native:{resolveModel:(_ctx,m)=>m,setRoute:r=>routes.push(r),capabilities:()=>caps,stream:(...args)=>({result:()=>f.ctx.modelRegistry.complete(...args)})}});
 for(const [role,provider] of [['small','yam-codex'],['medium',mediumProvider],['strong',strongProvider]]){f.models[role]={...f.models.strong,id:role,provider,input:role==='strong'?['text','image']:['text']};f.flags[`yam-${role}`]=`${provider}/${role}`;}
 f.flags['yam-classifier']='yam-codex/small';const api=await f.ready;await f.handlers.session_start({},f.ctx);return {...f,routes,api};
}
const capabilityImage=[{role:'user',content:[{type:'text',text:'Implement from this screenshot'},{type:'image',mimeType:'image/png',data:'AAAA'}]}];
test('capability-first routing selects an authorized vision tier before executing a new goal',async()=>{
 const f=await capabilityFixture(),result=await f.route({messages:capabilityImage});
 assert.equal(result.model.id,'strong');assert.equal(f.api.snapshot().decision.planned.model,'medium');assert.equal(f.api.snapshot().decision.selected.model,'strong');assert.match(result.state.reason,/能力|capabil/i);assert.equal(f.routes.at(-1).intent,'new');
});
test('capability-first routing creates a fresh strong phase for lightweight follow-up and preserves effort/history',async()=>{
 const state={v:2,model:'small',effort:'medium',task:'original board'},f=await capabilityFixture({state,selected:'low'}),messages=[{role:'user',content:'Explain a board'},{role:'assistant',content:'Three columns'},...capabilityImage],before=structuredClone(messages);
 const result=await f.route({messages});assert.equal(result.model.id,'strong');assert.equal(result.thinkingLevel,'low');assert.equal(result.state.task,state.task);assert.equal(f.routes.at(-1).intent,'new');assert.deepEqual(messages,before);
});
test('capability-first routing can bypass an API medium for a same-subscription capable strong phase',async()=>{
 const f=await capabilityFixture({state:{v:2,model:'small',effort:'medium'},mediumProvider:'p'});const result=await f.route({messages:capabilityImage});assert.equal(result.model.provider,'yam-codex');assert.equal(result.model.id,'strong');
});
test('capability-first routing refuses a paid-only alternative and never commits an execution route',async()=>{
 for(const strongProvider of ['p','yam-gateway']){
  const f=await capabilityFixture({strongProvider});await assert.rejects(f.route({messages:capabilityImage}),/capabil|subscription/i);assert.equal(f.api.snapshot().target,null);assert.equal(f.routes.length,0);
 }
});
test('capability-first routing preserves existing main locks and uncertain goals',async()=>{
 for(const patch of [{},{intent:'new',uncertain:true},{intent:'new',context:'insufficient'}]){
  const f=await capabilityFixture({state:{v:2,model:'medium',effort:'low',task:'existing'},patch});await assert.rejects(f.route({messages:capabilityImage}),/image|capabil/i);assert.equal(f.routes.length,0);
 }
 const f=await capabilityFixture();await f.api.control({action:'set',revision:f.api.snapshot().revision,data:{model:'yam-codex/medium',effort:'low'}});await assert.rejects(f.route({messages:capabilityImage}),/image/i);
});
test('capability-first routing rejects missing native generation before dispatch but retains text-only compatible tier',async()=>{
 const f=await capabilityFixture({caps:['text','files','image_input'],patch:{requires:['files','image_generation']}});await assert.rejects(f.route(),/capabil/i);assert.equal(f.routes.length,0);assert.equal(f.api.snapshot().target,null);
 const g=await capabilityFixture({patch:{requires:['files']}});assert.equal((await g.route()).model.id,'medium');
});

test('capability-first routing stops at a compatible medium without resolving a broken higher gateway',async()=>{
 await withGateway(null,async()=>{
  const f=await capabilityFixture({strongProvider:'yam-gateway',patch:{requires:['files']}});
  const result=await f.route();assert.equal(result.model.id,'medium');assert.equal(result.model.provider,'yam-codex');
 });
});

test('native recovery control is readable while busy and reset remains revision bound without inference',async()=>{
 let recovery={receiptId:'receipt-current',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true},resets=0;
 const f=fixture({native:{getRecovery:()=>recovery,reset:(_ctx,data)=>{assert.deepEqual(data,{receiptId:'receipt-current',confirmed:true});resets++;recovery=null;}}}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);
 assert.deepEqual(runtime.snapshot().nativeRecovery,recovery);f.ctx.isIdle=()=>false;await runtime.control({action:'native-recovery',revision:runtime.snapshot().revision});assert.equal(resets,0);
 await assert.rejects(runtime.control({action:'native-reset',revision:runtime.snapshot().revision,data:{receiptId:'receipt-current',confirmed:true}}),/Wait/);
 f.ctx.isIdle=()=>true;await assert.rejects(runtime.control({action:'native-reset',revision:-1,data:{receiptId:'receipt-current',confirmed:true}}),/changed/);assert.equal(resets,0);
 await runtime.control({action:'native-reset',revision:runtime.snapshot().revision,data:{receiptId:'receipt-current',confirmed:true}});assert.equal(runtime.snapshot().nativeRecovery,null);assert.equal(resets,1);assert.equal(f.calls,0);assert.equal(f.nativeCalls.length,0);
});

test('explicit connection refresh reloads native capabilities without clearing unfinished work',async()=>{
 let initializations=0;const recovery={receiptId:'unfinished',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true};
 const f=fixture({native:{initialize:async()=>initializations++,getRecovery:()=>recovery}}),runtime=await f.ready;await f.handlers.session_start({},f.ctx);const before=initializations;await runtime.control({action:'retry',revision:runtime.snapshot().revision});assert.equal(initializations,before+1);assert.deepEqual(runtime.snapshot().nativeRecovery,recovery);assert.equal(f.calls,0);
});

test('routed lightweight native answers stay tool-free after physical catalog re-resolution',async()=>{
 const {createNativeCodex}=await import('../src-tauri/pi/native-codex.mjs');let bridge;const calls=[],catalog=[];
 const answer={intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']};
 const f=fixture({answer,raw:true,native:{resolveModel:(_ctx,m)=>m,setRoute:r=>bridge.setRoute(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};f.ctx.cwd='/repo';f.ctx.sessionManager.getSessionFile=()=>'/owned/yam.jsonl';f.pi.getActiveTools=()=>['read','bash','edit','write'];f.pi.registerProvider=(_name,c)=>catalog.splice(0,catalog.length,...c.models);
 const createStream=()=>{let settle;const result=new Promise(r=>settle=r);return {push:e=>{if(e.type==='done')settle(e.message);if(e.type==='error')settle(e.error);},end(){},result:()=>result};};
 bridge=createNativeCodex(f.pi,{createStream,getTools:c=>c.tools,getSystemPrompt:()=>'',loadModels:async()=>[f.models.small,f.models.medium],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files']}],execute:async(_a,o)=>{calls.push(o);return {finalText:'Answer',sessionId:'01234567-1234-1234-1234-0123456789ab'};}});
 await f.ready;await f.handlers.session_start({},f.ctx);await bridge.initialize(f.ctx);bridge.beginTurn(f.ctx);
 const routed=await f.route({messages:[{role:'user',content:'Explain HTTP 404'}]});assert.equal(routed.state.model,'small');
 // Pi resolves route.model through its physical catalog and retains the default tool loadout.
 const physical=catalog.find(m=>m.id===routed.model.id),tools=['read','bash','edit','write'].map(name=>({name}));
 const result=await bridge.stream(physical,{messages:[{role:'user',content:'Explain HTTP 404'}],tools},{reasoning:routed.thinkingLevel}).result();
 assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(calls[0].mode,'readonly');assert.equal(calls[0].allowCollaboration,false);assert.equal(f.entries.filter(e=>e.customType==='yam.native-codex.v1').length,0);
 bridge.beginTurn(f.ctx);f.ctx.modelRegistry.complete=async()=>({content:[{type:'text',text:JSON.stringify({...answer,intent:'continue',task:'coding',context:'dependent',action:'write',readOnly:false,requires:['files']})}]});
 const history=[{role:'user',content:'Explain HTTP 404'},{role:'assistant',content:'Answer'},{role:'user',content:'Save that answer'}],follow=await f.route({state:routed.state,messages:history});
 assert.equal(follow.model.id,'medium');const completed=await bridge.stream(catalog.find(m=>m.id==='medium'),{messages:history,tools},{reasoning:follow.thinkingLevel}).result();
 assert.equal(completed.stopReason,'stop',completed.errorMessage);assert.equal(calls[1].mode,'task');assert.equal(calls[1].resume,null);assert.equal(f.entries.at(-1).data.status,'completed');
});

test('corrected text phases remain readonly until a fresh native tool phase, including saved legacy state',async()=>{
 for(const marker of [{mode:'readonly'},{reason:'只读回答质量不足，升档一次'}]){
  const {createNativeCodex}=await import('../src-tauri/pi/native-codex.mjs');let bridge;const calls=[],catalog=[],state={v:2,model:'medium',effort:'high',task:'New explanation B',...marker};
  let answer={intent:'continue',task:'answer',context:'dependent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']};
  const f=fixture({answer,raw:true,state,native:{resolveModel:(_ctx,m)=>m,setRoute:r=>bridge.setRoute(r)}});f.flags['yam-medium']='p/medium';f.models.medium={...f.models.strong,id:'medium'};f.ctx.cwd='/repo';f.ctx.sessionManager.getSessionFile=()=>'/owned/yam.jsonl';f.pi.getActiveTools=()=>['read','bash','edit','write'];f.pi.registerProvider=(_p,c)=>catalog.splice(0,catalog.length,...c.models);
  const createStream=()=>{let settle;const result=new Promise(r=>settle=r);return {push:e=>{if(e.type==='done')settle(e.message);if(e.type==='error')settle(e.error);},end(){},result:()=>result};};
  bridge=createNativeCodex(f.pi,{createStream,getTools:c=>c.tools,getSystemPrompt:()=>'',loadModels:async()=>[f.models.small,f.models.medium],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files']}],execute:async(_a,o)=>{calls.push(o);return {finalText:'Done',sessionId:'01234567-1234-1234-1234-0123456789ab'};}});
  await f.ready;await f.handlers.session_start({},f.ctx);await bridge.initialize(f.ctx);const tools=[{name:'write'}],medium=catalog.find(m=>m.id==='medium');
  bridge.beginTurn(f.ctx);bridge.setRoute({intent:'new'});await bridge.stream(medium,{messages:[{role:'user',content:'Old task A'}],tools},{reasoning:'high'}).result();
  bridge.beginTurn(f.ctx);const text=await f.route({messages:[{role:'user',content:'Explain B again'}]});await bridge.stream(medium,{messages:[{role:'user',content:'Explain B again'}],tools},{reasoning:text.thinkingLevel}).result();
  assert.equal(calls[1].mode,'readonly');assert.equal(f.entries.filter(e=>e.customType==='yam.native-codex.v1').length,2,'text continuation must not replace old business receipt');
  answer={...answer,task:'coding',action:'write',readOnly:false,requires:['files']};f.ctx.modelRegistry.complete=async()=>({content:[{type:'text',text:JSON.stringify(answer)}]});
  bridge.beginTurn(f.ctx);const routed=await f.route({state:text.state,messages:[{role:'user',content:'Save explanation B'}]});await bridge.stream(medium,{messages:[{role:'user',content:'Save explanation B'}],tools},{reasoning:routed.thinkingLevel}).result();
  assert.equal(calls[2].mode,'task');assert.equal(calls[2].resume,null,'never resume unrelated task A for the first B tool phase');
 }
});

test('v2 quality correction persists readonly phase instead of claiming a business session',async()=>{
 const f=feedbackFixture();f.models.medium={...f.models.strong,id:'medium'};f.flags['yam-medium']='p/medium';const classify=f.ctx.modelRegistry.complete;
 f.ctx.modelRegistry.complete=async(model,...args)=>model.id==='medium'?{role:'assistant',provider:'p',model:'medium',content:[{type:'text',text:'A complete answer.'}],stopReason:'stop'}:classify(model,...args);
 await f.ready;await f.handlers.session_start({},f.ctx);await f.handlers.before_agent_start({},f.ctx);await f.route();
 const corrected=await f.handlers.message_end({message:f.weak},f.ctx);assert.equal(corrected.message.model,'medium');
 const saved=f.entries.findLast(e=>e.customType==='pi.virtual-model-state').data.state;assert.equal(saved.model,'medium');assert.equal(saved.mode,'readonly');
});
test('corrected readonly phases cannot acquire tools from an uncertain continuation',async()=>{
 const routes=[],f=fixture({answer:{intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:true,readOnly:false,requires:['files']},raw:true,state:{v:2,model:'medium',mode:'readonly',effort:'high'},native:{resolveModel:(_c,m)=>m,setRoute:r=>routes.push(r)}});f.models.medium={...f.models.strong,id:'medium'};f.flags['yam-medium']='p/medium';await f.ready;await f.handlers.session_start({},f.ctx);
 await assert.rejects(f.route(),/capabil/i);assert.equal(routes.length,0);
});
