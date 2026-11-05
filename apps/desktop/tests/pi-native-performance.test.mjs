// Author: Jeff.Liu. No model, network or GUI calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src-tauri/pi/agent-executor.mjs';
import {createNativeCodex} from '../src-tauri/pi/native-codex.mjs';
function fixture(){let time=0,stamp='v1',loggedIn=true,features=true,featureCode=0;const calls=[];
 const discover=api.createAgentDiscovery?.({now:()=>time,identity:async()=>stamp,ttlMs:100,probe:async(_f,args)=>{calls.push(args[0]);return args[0]==='features'?{code:featureCode,stdout:`image_generation stable ${features}\n`,stderr:''}:{code:loggedIn?0:1,stdout:loggedIn?'Logged in using ChatGPT':'',stderr:''};}});
 return {discover,calls,set(v){if('time'in v)time=v.time;if('stamp'in v)stamp=v.stamp;if('loggedIn'in v)loggedIn=v.loggedIn;if('features'in v)features=v.features;if('featureCode'in v)featureCode=v.featureCode;}};
}
test('shared discovery reuses catalog metadata but rechecks login before every execution',async()=>{
 assert.equal(typeof api.createAgentDiscovery,'function');const f=fixture(),e={codex:'/codex'};
 await f.discover(e);await f.discover(e);assert.deepEqual(f.calls,['login','features']);
 await f.discover(e,{execution:true});await f.discover(e,{execution:true});assert.deepEqual(f.calls,['login','features','login','login']);
 f.set({loggedIn:false});assert.deepEqual(await f.discover(e,{execution:true}),[]);assert.deepEqual(await f.discover(e),[]);
});
test('metadata expires, refreshes and invalidates when executable changes; failures are not cached',async()=>{
 assert.equal(typeof api.createAgentDiscovery,'function');const f=fixture(),e={codex:'/codex'};
 await f.discover(e);f.set({features:false});assert.ok((await f.discover(e))[0].capabilities.includes('image_generation'));
 assert.ok(!(await f.discover(e,{refresh:true}))[0].capabilities.includes('image_generation'));
 f.set({time:101,features:true});assert.ok((await f.discover(e))[0].capabilities.includes('image_generation'));
 f.set({stamp:'v2',features:false});assert.ok(!(await f.discover(e))[0].capabilities.includes('image_generation'));
 f.set({featureCode:1});await f.discover(e,{refresh:true});const n=f.calls.length;await f.discover(e);assert.ok(f.calls.length>n);
 f.set({featureCode:0,loggedIn:false});await f.discover(e,{refresh:true});f.set({loggedIn:true});assert.equal((await f.discover(e)).length,1);
});
test('concurrent catalog requests share a probe and return independent metadata',async()=>{
 assert.equal(typeof api.createAgentDiscovery,'function');const f=fixture(),e={codex:'/codex'};
 const [a,b]=await Promise.all([f.discover(e),f.discover(e)]);assert.deepEqual(f.calls,['login','features']);a[0].capabilities.length=0;assert.ok(b[0].capabilities.includes('text'));
});
test('native model initialization registers a full catalog once and execution requests fresh authentication',async()=>{
 const providers=[],discoveries=[],models=Array.from({length:20},(_,n)=>({id:'model-'+n,provider:'openai-codex'}));
 const pi={registerCommand(){},registerProvider:(_p,v)=>providers.push(v)};
 const bridge=createNativeCodex(pi,{loadModels:async()=>models,discover:async(_e,o)=>{discoveries.push(o);return [{kind:'codex',auth:'subscription',capabilities:['text']}];},execute:async()=>({finalText:'classified'}),createStream:()=>({push(){},end(){}}),getTools:()=>[],getSystemPrompt:()=>''});
 await bridge.initialize({cwd:'/fixture',ui:{setStatus(){}},sessionManager:{getSessionFile:()=>null},modelRegistry:{getAll:()=>[]}});assert.equal(providers.length,1);assert.equal(providers[0].models.length,20);
 bridge.stream(models[0],{messages:[]},{});await new Promise(r=>setImmediate(r));assert.equal(discoveries.at(-1)?.execution,true);
});

test('default native and delegation discovery remain compatible with execution refresh options',async()=>{
 const {mkdtemp,writeFile,chmod,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{installAgents}=await import('../src-tauri/pi/agent-orchestrator.mjs');
 const root=await mkdtemp(join(tmpdir(),'yam-default-discovery-')),file=join(root,'codex.mjs'),previous=process.env.YAM_CODEX_EXECUTABLE;
 try{
  await writeFile(file,`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='login')console.log('Logged in using ChatGPT');else if(a[0]==='features')console.log('image_generation stable true');else{process.stdin.resume();process.stdin.on('end',()=>{for(const e of [{type:'thread.started',thread_id:'01234567-1234-1234-1234-0123456789ab'},{type:'item.completed',item:{type:'agent_message',text:'Done'}},{type:'turn.completed'}])console.log(JSON.stringify(e));});}`);await chmod(file,0o755);
  const entries=[],handlers={},tools={},model={provider:'openai-codex',id:'model'},pi={getFlag:()=>false,getActiveTools:()=>['read','bash','edit','write'],registerProvider(){},registerCommand(){},registerTool:t=>tools[t.name]=t,on:(n,f)=>handlers[n]=f,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
  const ctx={cwd:root,ui:{setStatus(){}},modelRegistry:{getAll:()=>[model]},sessionManager:{getBranch:()=>entries,getSessionFile:()=>join(root,'parent.jsonl')}};
  const bridge=createNativeCodex(pi,{executable:file,loadModels:async()=>[],getTools:()=>[],getSystemPrompt:()=>'',createStream:()=>{let done;const promise=new Promise(r=>done=r);return {push:e=>{if(e.type==='done')done(e.message);if(e.type==='error')done(e.error);},end(){},result:()=>promise};}});
  await bridge.initialize(ctx);const result=await bridge.stream(bridge.resolveModel(ctx,model),{messages:[{role:'user',content:'Classify'}]},{}).result();assert.equal(result.stopReason,'stop',result.errorMessage);
  process.env.YAM_CODEX_EXECUTABLE=file;
  installAgents(pi,{agentRoutingContext:()=>({fixedModel:null}),billingPolicy:()=> 'subscription'},{execute:async()=>({text:'Native result',sessionId:'01234567-1234-1234-1234-0123456789ab'})});
  handlers.session_start({},ctx);await handlers.before_agent_start({messageType:'user',prompt:'Explicit native task',systemPrompt:'Scope',images:[]},ctx);
  const delegated=await tools.yam_delegate.execute('call',{executor:'codex',goal:'Native goal',requires:['text']},undefined,undefined,ctx);assert.equal(delegated.details.error,null);
 }finally{if(previous===undefined)delete process.env.YAM_CODEX_EXECUTABLE;else process.env.YAM_CODEX_EXECUTABLE=previous;await rm(root,{recursive:true,force:true});}
});

test('execution cannot extend the lifetime of older feature metadata',async()=>{
 const f=fixture(),e={codex:'/codex'};await f.discover(e);f.set({time:99});await f.discover(e,{execution:true});f.set({time:101,features:false});
 assert.ok(!(await f.discover(e))[0].capabilities.includes('image_generation'));
});

test('missing executable identities still coalesce pending failures without caching them',async()=>{
 let release,calls=0;const wait=new Promise(resolve=>release=resolve),discover=api.createAgentDiscovery({identity:async()=>null,probe:async()=>{calls++;await wait;return {code:1,stdout:'',stderr:'unavailable'};}}),executables={codex:'/missing'};
 const pending=[discover(executables),discover(executables)];await new Promise(r=>setImmediate(r));release();await Promise.all(pending);assert.equal(calls,1);await discover(executables);assert.equal(calls,2);
});
test('catalog and nested feature lifetimes cannot exceed sixty seconds',async()=>{
 let time=0,images=false;const discover=api.createAgentDiscovery({ttlMs:120000,now:()=>time,identity:async()=>'fixed',probe:async(_f,args)=>({code:0,stderr:'',stdout:args[0]==='login'?'Logged in using ChatGPT':'image_generation stable '+images})}),executables={codex:'/codex'};
 assert.ok(!(await discover(executables))[0].capabilities.includes('image_generation'));time=59999;await discover(executables,{execution:true});images=true;time=60001;assert.ok((await discover(executables))[0].capabilities.includes('image_generation'));
});
