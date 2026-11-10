// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCodexPolicy,validateCodexModelCatalog} from '../src-tauri/pi/codex-route-config.mjs';
import {defaultTierRules} from '../src-tauri/pi/task-rules.mjs';

test('Codex validates every reachable tier, not only the fallback',()=>{
 const base={connections:{native:{billing:'subscription',native:true}},classifiers:['native/small'],executionGroups:[{medium:'native/medium'}]};
 assert.throws(()=>readCodexPolicy(JSON.stringify(base)),/small/);
 assert.throws(()=>readCodexPolicy(JSON.stringify({...base,executionGroups:[{small:'native/small',medium:'native/medium'}]})),/strong/);
 assert.doesNotThrow(()=>readCodexPolicy(JSON.stringify({...base,executionGroups:[{small:'native/small',medium:'native/medium',strong:'native/strong'}]})));
});

test('native routing preferences preserve fixed model and exact effort',()=>{
 const base={connections:{native:{billing:'subscription',native:true}},classifiers:[],executionGroups:[{}],model:'native/fixed',effort:'max'};
 assert.equal(readCodexPolicy(JSON.stringify(base)).effort,'max');
 assert.throws(()=>readCodexPolicy(JSON.stringify({...base,effort:'made-up'})),/reasoning|preference/i);
});

test('Codex catalog validates an enabled execution rule with an exact model and reasoning level',()=>{
 const executionRules=[{enabled:true,when:{task:'review'},use:{model:'native/strong',effort:'max'}}];
 const base={connections:{native:{billing:'subscription',native:true}},classifiers:['native/small'],
  executionGroups:[{small:'native/small',medium:'native/medium',strong:'native/strong'}],rules:{...defaultTierRules,executionRules}};
 const catalog=['small','medium','strong'].map(model=>({key:'native/'+model,levels:['medium','high']}));
 assert.throws(()=>validateCodexModelCatalog(base,catalog),/native\/strong: unsupported reasoning max/);
 catalog[2].levels.push('max');
 assert.doesNotThrow(()=>validateCodexModelCatalog(base,catalog));
 const modelOnly={...base,rules:{...defaultTierRules,executionRules:[
  {enabled:true,when:{task:'review'},use:{model:'native/missing'}},
 ]}};
 assert.throws(()=>validateCodexModelCatalog(modelOnly,catalog),/configured tier/);
 const lowBackup={...modelOnly,executionGroups:[...base.executionGroups,{strong:'native/low-backup'}],
  rules:{...defaultTierRules,executionRules:[{enabled:true,when:{task:'review',depth:'deep'},use:{model:'native/low-backup'}}]}};
 assert.throws(()=>validateCodexModelCatalog(lowBackup,[...catalog,{key:'native/low-backup',levels:['low']}]),
  /native\/low-backup: unsupported reasoning high/);
 const effortOnly={...base,rules:{...defaultTierRules,executionRules:[
  {enabled:true,when:{task:'review',depth:'deep'},use:{effort:'xhigh'}},
 ]}};
 assert.throws(()=>validateCodexModelCatalog(effortOnly,catalog),/unsupported reasoning xhigh/);
 const otherWorkspace={...base,rules:{...defaultTierRules,executionRules:[
  {enabled:true,when:{task:'review',workspace:'/other'},use:{model:'native/strong',effort:'xhigh'}},
 ]}};
 assert.doesNotThrow(()=>validateCodexModelCatalog(otherWorkspace,catalog,undefined,undefined,'/current'));
});

const facts={intent:'new',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:false,readOnly:false,requires:['files']};
async function fixture(t){
 const {routeCodex}=await import('../../../scripts/codex-auto-route.mjs');
 for(const key of ['YAM_A_KEY','YAM_C_KEY']){
  const before=process.env[key];
  process.env[key]='fixture-only';
  t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});
 }
 const root=await mkdtemp(join(tmpdir(),'yam-route-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const paths=Object.fromEntries(['project','sub','a','c'].map(key=>[key,join(root,key)]));
 await Promise.all(Object.values(paths).map(path=>mkdir(path,{mode:0o700})));
 const config={codex:process.execPath,connections:{
  sub:{billing:'subscription',home:paths.sub},
  a:{billing:'paid',home:paths.a,baseUrl:'https://a.example/v1',apiKeyEnv:'YAM_A_KEY'},
  c:{billing:'paid',home:paths.c,baseUrl:'https://c.example/v1',apiKeyEnv:'YAM_C_KEY'},
 },classifiers:['sub/fast','sub/backup'],executionGroups:[{medium:'a/model'}, {}, {medium:'c/model'}]};
 const session=join(root,'session'),seen=[];
 const deps={
  classify:async({model})=>{seen.push(model);return model==='fast'?'{}':JSON.stringify(facts);},
  open:async({model,connection,resume})=>{
   seen.push(connection.name+'/'+model);
   if(connection.name==='a')throw Error('Unavailable');
   return {threadId:resume??'55555555-5555-5555-5555-555555555555',close:async()=>{},run:async()=>{seen.push('dispatch');return {status:'completed',text:'done'};}};
  },
 };
 const options={config,cwd:paths.project,session,prompt:'Implement a feature'};
 return {routeCodex,options,deps,seen,session};
}

test('independent routing selects a same-channel sparse backup and resumes its physical connection',async t=>{
 const {routeCodex,options,deps,seen}=await fixture(t);
 const first=await routeCodex(options,deps);
 assert.equal(first.model,'c/model');
 assert.equal(first.effort,'high');
 assert.equal(first.group,'C');
 assert.equal(first.classification.source,'B');
 assert.deepEqual(seen,['fast','backup','a/model','c/model','dispatch']);
 seen.length=0;
 deps.classify=async({model})=>{seen.push(model);return JSON.stringify({...facts,intent:'continue'});};
 options.config.executionGroups=[{medium:'a/other'}];
 const next=await routeCodex(options,deps);
 assert.equal(next.threadId,first.threadId);
 assert.equal(next.model,'c/model');
 assert.deepEqual(seen,['fast','c/model','dispatch']);
});

test('headless Codex preserves fixed reasoning off across native thread resume',async t=>{
 const {routeCodex,options,deps}=await fixture(t);
 Object.assign(options.config,{model:'sub/regular',effort:'off'});
 const observed=[];
 deps.classify=async()=>{throw Error('Fixed settings do not need a classifier');};
 deps.open=async({resume})=>({threadId:resume??'55555555-5555-5555-5555-555555555555',close:async()=>{},
  run:async(_prompt,effort)=>{observed.push({resume,effort});return {status:'completed',text:'done'};}});
 const first=await routeCodex(options,deps);
 const second=await routeCodex(options,deps);
 assert.equal(first.effort,'off');
 assert.equal(second.threadId,first.threadId);
 assert.deepEqual(observed,[{resume:null,effort:'none'},{resume:first.threadId,effort:'none'}]);
});

test('a new task in an existing Codex thread is classified again and can change tier',async t=>{
 const {routeCodex,options,deps,seen}=await fixture(t);
 options.config.executionGroups=[{small:'sub/light',medium:'sub/regular',strong:'sub/deep'}];
 deps.classify=async()=>JSON.stringify(facts);
 const first=await routeCodex(options,deps);
 deps.classify=async()=>JSON.stringify({...facts,task:'answer',action:'none',readOnly:true,context:'independent'});
 const second=await routeCodex(options,deps);
 assert.equal(second.threadId,first.threadId);assert.equal(second.model,'sub/light');
 assert.equal(second.tier,'small');assert.equal(seen.filter(value=>value==='dispatch').length,2);
});

test('classifier failure cannot dispatch paid execution; local subscription and cancel work',async t=>{
 const {routeCodex,options,deps,seen}=await fixture(t);
 deps.classify=async()=>{throw Error('Subscription unavailable');};
 await assert.rejects(routeCodex(options,deps),/paid/i);
 assert.deepEqual(seen,[]);
 options.config.executionGroups=[{medium:'sub/regular'}];
 assert.equal((await routeCodex(options,deps)).classification.source,'local');
 assert.deepEqual(seen,['sub/regular','dispatch']);
 const controller=new AbortController();
 controller.abort();
 await assert.rejects(routeCodex({...options,signal:controller.signal},deps),/abort/i);
 assert.equal(seen.length,2);
});

test('a Codex policy can use the same custom rules as Pi',async t=>{
 const {defaultTierRules,routeFacts}=await import('../src-tauri/pi/task-rules.mjs');
 const {routeCodex,options,deps,seen}=await fixture(t);
 const rules=structuredClone(defaultTierRules),coding=rules.rules.find(rule=>rule.task==='coding');
 Object.assign(coding,{description:'Use the strong review model for implementation.',model:'strong',effort:'max'});
 options.config.rules=rules;
 options.config.executionGroups=[{medium:'sub/regular',strong:'sub/strong'}];
 let classifierPrompt;
 deps.classify=async({prompt})=>{
  classifierPrompt=prompt;
  return JSON.stringify(facts);
 };
 const result=await routeCodex(options,deps);
 assert.deepEqual({model:result.tier,effort:result.effort},routeFacts(facts,rules).selection);
 assert.ok(classifierPrompt.includes(coding.description));
 assert.equal(result.model,'sub/strong');
 assert.deepEqual(seen,['sub/strong','dispatch']);
});

test('invalid shared rules are rejected before touching the Codex session or connections',async t=>{
 const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');
 const {routeCodex,options,deps,seen,session}=await fixture(t);
 for(const rules of [null,{...defaultTierRules,fallback:{model:'small',effort:'high'}}]){
  options.config.rules=rules;
  await assert.rejects(routeCodex(options,deps),/task rule/i);
 }
 assert.deepEqual(seen,[]);
 await assert.rejects(readFile(join(session,'state.json')), {code:'ENOENT'});
});

test('unknown dispatch locks its owned session and does not retry or switch models',async t=>{
 const {routeCodex,options,deps,seen,session}=await fixture(t);
 const open=deps.open;
 deps.open=async values=>({...await open(values),run:async()=>{seen.push('dispatch');throw Error('unknown');}});
 await assert.rejects(routeCodex(options,deps),/unknown/i);
 assert.equal(JSON.parse(await readFile(join(session,'state.json'),'utf8')).status,'pending');
 await assert.rejects(routeCodex(options,deps),/pending|inspect/i);
 assert.equal(seen.filter(x=>x==='dispatch').length,1);
});

test('a concurrent invocation cannot dispatch in the same route session',async t=>{
 const {routeCodex,options,deps}=await fixture(t);
 const open=deps.open;
 let entered,release;
 const running=new Promise(resolve=>{entered=resolve;});
 const proceed=new Promise(resolve=>{release=resolve;});
 deps.open=async values=>({...await open(values),run:async()=>{entered();await proceed;return {status:'completed',text:'done'};}});
 const first=routeCodex(options,deps);
 try{
  await running;
  await assert.rejects(routeCodex(options,deps),/locked/);
 }finally{release();}
 await first;
});

test('standalone gateway classification receives its explicit connection',async t=>{
 const {routeCodex,options,deps}=await fixture(t);
 options.config.connections.local={billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'};options.config.classifiers=['local/deepseek/pro'];
 let connection;deps.classify=async args=>{connection=args.connection;return JSON.stringify(facts);};
 await routeCodex(options,deps);assert.equal(connection?.gateway,true);assert.equal(connection.billing,'paid');
});

test('standalone Codex retains the executed backup under legacy v1 continuation rules',async t=>{
 const {defaultRules}=await import('../src-tauri/pi/task-rules.mjs');
 const {routeCodex,options,deps}=await fixture(t);options.config.rules=defaultRules;
 options.config.executionGroups=[{small:'a/model',strong:'a/model'},{small:'c/model',strong:'c/model'}];
 deps.classify=async()=>JSON.stringify({...facts,intent:'new',task:'answer',context:'independent',action:'none',readOnly:true,requires:['text']});
 const first=await routeCodex(options,deps);assert.equal(first.model,'c/model');
 deps.classify=async()=>JSON.stringify({...facts,intent:'continue',task:'answer',context:'dependent',action:'none',readOnly:true,requires:['text']});
 options.config.executionGroups=[{small:'a/other',strong:'a/other'}];
 const next=await routeCodex(options,deps);assert.equal(next.model,first.model);assert.equal(next.tier,'small');
});

test('standalone legacy classifier outage preserves prior subscription effort',async t=>{
 const {defaultRules}=await import('../src-tauri/pi/task-rules.mjs');
 const {routeCodex,options,deps}=await fixture(t);options.config.rules=defaultRules;
 options.config.executionGroups=[{small:'sub/light',strong:'sub/deep'}];
 deps.classify=async()=>JSON.stringify({...facts,intent:'new',task:'answer',context:'independent',action:'none',readOnly:true,requires:['text']});
 const first=await routeCodex(options,deps);assert.equal(first.effort,'medium');
 deps.classify=async()=>{throw Error('classifier offline');};
 const next=await routeCodex(options,deps);assert.equal(next.model,first.model);assert.equal(next.effort,'medium');
 options.config.effort='high';assert.equal((await routeCodex(options,deps)).effort,'high');
});
