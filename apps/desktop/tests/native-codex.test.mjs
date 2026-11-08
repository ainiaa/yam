import assert from 'node:assert/strict';
import {test} from 'node:test';
const api=await import('../src-tauri/pi/native-codex.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const id='01234567-1234-1234-1234-0123456789ab';
function fixture({error,restricted=false,notice,persistAt=Infinity,now,onDiscover,onExecute,discovery,configuredExecutable='/native/codex',extraModels=[],loadModels=async()=>[]}={}){
 const entries=[],calls=[],providers=[],commands={};let writes=0;
 const original={provider:'openai',id:'gpt-test',api:'openai-responses',reasoning:true,input:['text','image'],contextWindow:100000,maxTokens:10000,thinkingLevelMap:{off:'none',medium:'medium',high:'high',max:'xhigh'}};
 const profile={id:'codex',kind:'codex',executable:'/native/codex',auth:'subscription',capabilities:['text','files','image_input','image_generation']};
 const pi={getActiveTools:()=>restricted?['read']:['read','bash','edit','write'],registerProvider:(...v)=>providers.push(v),appendEntry:(customType,data)=>{if(++writes>=persistAt)throw Error('receipt disk write failed');entries.push({type:'custom',customType,data});},registerCommand:(n,c)=>commands[n]=c};
 const ctx={cwd:'/repo',ui:{setStatus(){},notify(){},confirm:async()=>true},isIdle:()=>true,sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/owned/parent.jsonl'},modelRegistry:{isUsingOAuth:()=>true,getAll:()=>[original,...extraModels]}};
 const createStream=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {events:[],push(e){this.events.push(e);if(e.type==='done')resolve(e.message);if(e.type==='error')resolve(e.error);},end(){},result:()=>promise};};
 const bridge=api.createNativeCodex?.(pi,{now,createStream,getTools:c=>c.tools??[],getSystemPrompt:c=>c.systemPrompt??c.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),loadModels,executable:configuredExecutable,discover:discovery??(async()=>{onDiscover?.();return [profile];}),execute:async(a,o)=>{calls.push({a,o});if(onExecute)return onExecute(o);o.onLine?.(JSON.stringify({type:'thread.started',thread_id:id}));if(notice)o.onLine?.(JSON.stringify({type:'item.completed',item:{type:notice}}));if(error)throw typeof error==='string'?Error(error):error;return {text:'native commentary\nFinal answer',finalText:'Final answer',sessionId:id,usage:{input_tokens:20,cached_input_tokens:5,output_tokens:4}};}});
 return {bridge,entries,calls,providers,commands,ctx,original,profile};
}
const context={messages:[{role:'user',content:'Write the article with a cover'}],tools:[{name:'read'}]};
test('native execution diagnostics distinguish discovery, startup, first reply and completion without task content',async()=>{
 let clock=0;const observed=[],f=fixture({now:()=>clock,onDiscover:()=>clock=20,onExecute:o=>{clock=60;o.onLine(JSON.stringify({type:'thread.started',thread_id:id}));clock=90;o.onLine(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PRIVATE_REPLY'}}));clock=100;return {finalText:'Done',sessionId:id};}});
 await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);clock=0;
 assert.equal((await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result()).stopReason,'stop');
 const last=observed.at(-1);assert.equal(last.stage,'completed');assert.equal(last.discoveryMs,20);assert.equal(last.startupMs,40);assert.equal(last.firstResponseMs,70);assert.equal(last.executionMs,80);
 assert.ok(observed.some(v=>v?.stage==='discovering'));assert.ok(observed.some(v=>v?.stage==='starting'));assert.ok(observed.some(v=>v?.stage==='executing'));assert.ok(!JSON.stringify(observed).includes('PRIVATE_'));
 const count=observed.length;f.calls[0].o.onLine(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));assert.equal(observed.length,count);
 await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{messages:context.messages},{toolChoice:'none'}).result();assert.equal(observed.length,count);
});
test('native diagnostics preserve the failed stage and do not invent a first response',async()=>{
 const observed=[],f=fixture({error:'PRIVATE_TOKEN provider failure'});await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);
 assert.equal((await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result()).stopReason,'error');
 const last=observed.at(-1);assert.equal(last.stage,'failed');assert.equal(last.failedStage,'executing');assert.equal(last.firstResponseMs,null);assert.ok(!JSON.stringify(observed).includes('PRIVATE_TOKEN'));
 f.bridge.beginTurn(f.ctx);assert.equal(observed.at(-1),null);
});
test('native preflight failures report preparation with explicit unknown timings before discovery or spawn',async()=>{
 const observed=[],f=fixture({restricted:true});await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);
 assert.equal((await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result()).stopReason,'error');const last=observed.at(-1);
 assert.equal(last.failedStage,'preparing');for(const key of ['discoveryMs','startupMs','firstResponseMs','executionMs'])assert.equal(last[key],null,key);assert.equal(f.calls.length,0);
});
test('native task preflight reports aborted and invalid transport requests before starting discovery',async()=>{
 for(const kind of ['abort','transport']){
  const observed=[],f=fixture();await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);const abort=new AbortController();abort.abort();
  await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,kind==='abort'?{signal:abort.signal}:{headers:{authorization:'PRIVATE_SECRET'}}).result();const last=observed.at(-1);
  assert.equal(last.failedStage,'preparing');for(const key of ['discoveryMs','startupMs','firstResponseMs','executionMs'])assert.equal(last[key],null);assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(observed).includes('PRIVATE_SECRET'));
 }
});
test('a queued native stream cannot adopt a newer turn or publish its diagnostics',async()=>{
 const observed=[],f=fixture();await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);
 const pending=f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{});f.bridge.beginTurn(f.ctx);const result=await pending.result();
 assert.equal(result.stopReason,'aborted');assert.match(result.errorMessage,/turn changed/i);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);assert.equal(observed.at(-1),null);
});
test('a superseded native execution aborts its owned signal and never writes a late result into another branch',async()=>{
 for(const outcome of ['resolve','reject']){
  let finish,fail,started;const ready=new Promise(r=>started=r),pending=new Promise((resolve,reject)=>{finish=resolve;fail=reject;}),f=fixture({onExecute:o=>{o.onLine(JSON.stringify({type:'thread.started',thread_id:id}));started();return pending;}}),observed=[];
  await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);const stream=f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{});await ready;
  const oldReceipt=structuredClone(f.entries.at(-1));f.entries.length=0;f.entries.push({type:'custom',customType:'foreign-branch',data:{}});f.bridge.beginTurn(f.ctx);assert.equal(f.calls[0].o.signal.aborted,true);
  if(outcome==='resolve')finish({finalText:'STALE_PRIVATE_REPLY',sessionId:id});else fail(Error('Late execution failure'));
  const result=await stream.result();assert.equal(result.stopReason,'aborted');assert.ok(!stream.events.some(e=>e.type==='done'));assert.equal(f.entries.length,1);assert.equal(f.entries[0].customType,'foreign-branch');assert.equal(oldReceipt.data.status,'running');assert.equal(observed.at(-1),null);
 }
});
test('a rejected duplicate stream cannot overwrite the active native execution diagnostics',async()=>{
 let finish,started;const ready=new Promise(r=>started=r),pending=new Promise(r=>finish=r),observed=[],f=fixture({onExecute:o=>{o.onLine(JSON.stringify({type:'thread.started',thread_id:id}));started();return pending;}});
 await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original),first=f.bridge.stream(model,context,{});await ready;
 const running=structuredClone(observed.at(-1));assert.equal((await f.bridge.stream(model,context,{}).result()).stopReason,'error');assert.deepEqual(observed.at(-1),running);
 finish({finalText:'Done',sessionId:id});assert.equal((await first.result()).stopReason,'stop');const last=observed.at(-1);assert.equal(last.stage,'completed');assert.equal(last.failedStage,undefined);assert.notEqual(last.discoveryMs,null);assert.notEqual(last.startupMs,null);
});
test('native context diagnostics explain verified continuation and identity changes without retaining prompts',async()=>{
 const observed=[],f=fixture();await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));const model=f.bridge.resolveModel(f.ctx,f.original);
 const first={...context,messages:[{role:'user',content:'PRIVATE_SCOPE: edit only allowed.md'}]};f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,first,{reasoning:'high'}).result();
 assert.equal(observed.at(-1).handoff.reason,'new-session');
 const next={...first,messages:[...first.messages,{role:'user',content:'Continue'}]};f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,next,{reasoning:'high'}).result();
 assert.equal(observed.at(-1).handoff.mode,'incremental');assert.equal(observed.at(-1).handoff.reason,'verified-prefix');assert.equal(f.calls[1].o.resume,id);
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,next,{reasoning:'medium'}).result();assert.equal(f.calls[2].o.resume,null);assert.ok(f.calls[2].o.prompt.includes('PRIVATE_SCOPE'));assert.equal(observed.at(-1).handoff.reason,'identity-changed');
 assert.ok(!JSON.stringify(observed).includes('PRIVATE_SCOPE'));
});
test('oversized native handoffs report the exact budget and actionable failure before any process starts',async()=>{
 const observed=[],f=fixture();await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(structuredClone(value)));f.bridge.beginTurn(f.ctx);
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{...context,messages:[{role:'user',content:'x'.repeat(130000)}]},{}).result();
 assert.equal(result.stopReason,'error');const last=observed.at(-1);assert.equal(last.failure,'context-budget');assert.equal(last.failedStage,'preparing');assert.equal(last.handoff.budget,128000);assert.ok(last.handoff.characters>last.handoff.budget);assert.equal(last.startupMs,null);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);
});
test('restored receipts resume only the same model, reasoning, directory and executable identity',async()=>{
 for(const change of ['model','reasoning','cwd','executable']){
  const f=fixture();await f.bridge.initialize(f.ctx);let model=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,context,{reasoning:'high'}).result();
  if(change==='model')model=f.bridge.resolveModel(f.ctx,{...f.original,id:'other-model'});
  if(change==='cwd')f.ctx.cwd='/different';
  if(change==='executable'){const latest=f.entries.at(-1).data,identity=JSON.parse(latest.identity);identity.executable='/old/codex';latest.identity=JSON.stringify(identity);}
  f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,{...context,messages:[...context.messages,{role:'user',content:'Continue'}]},{reasoning:change==='reasoning'?'medium':'high'}).result();
  assert.equal(f.calls[1].o.resume,null,change);assert.ok(f.calls[1].o.prompt.includes('Write the article'),change);
 }
});
test('native continuation uses the discovered executable identity when no override is configured',async()=>{
 const f=fixture({configuredExecutable:null});await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,context,{reasoning:'high'}).result();
 f.profile.executable='/new-install/codex';f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,{...context,messages:[...context.messages,{role:'user',content:'Continue'}]},{reasoning:'high'}).result();
 assert.equal(f.calls[1].o.resume,null);assert.ok(f.calls[1].o.prompt.includes('Write the article'));assert.equal(JSON.parse(f.entries.at(-1).data.identity).executable,'/new-install/codex');
});
test('a restarted bridge restores a verified checkpoint while mid-flight cancellation never replays execution',async()=>{
 const first=fixture();await first.bridge.initialize(first.ctx);first.bridge.beginTurn(first.ctx);await first.bridge.stream(first.bridge.resolveModel(first.ctx,first.original),context,{reasoning:'high'}).result();
 const restored=fixture();restored.entries.push(...structuredClone(first.entries));await restored.bridge.initialize(restored.ctx);restored.bridge.beginTurn(restored.ctx);
 await restored.bridge.stream(restored.bridge.resolveModel(restored.ctx,restored.original),{...context,messages:[...context.messages,{role:'user',content:'Continue after restart'}]},{reasoning:'high'}).result();
 assert.equal(restored.calls[0].o.resume,id);assert.ok(!restored.calls[0].o.prompt.includes('Write the article'));assert.ok(restored.calls[0].o.prompt.includes('Continue after restart'));
 const abort=new AbortController(),cancelled=fixture({onExecute:o=>{o.onLine(JSON.stringify({type:'thread.started',thread_id:id}));abort.abort();return {finalText:'Late response',sessionId:id};}});await cancelled.bridge.initialize(cancelled.ctx);const model=cancelled.bridge.resolveModel(cancelled.ctx,cancelled.original);cancelled.bridge.beginTurn(cancelled.ctx);
 assert.equal((await cancelled.bridge.stream(model,context,{signal:abort.signal}).result()).stopReason,'aborted');cancelled.bridge.beginTurn(cancelled.ctx);assert.equal((await cancelled.bridge.stream(model,context,{}).result()).stopReason,'error');assert.equal(cancelled.calls.length,1);
});
test('native prompt budget accepts the boundary and rejects empty, NUL and oversized context',async()=>{
 const {validateAgentPrompt,maxAgentPromptCharacters}=await import('../src-tauri/pi/agent-executor.mjs');assert.equal(maxAgentPromptCharacters,128000);assert.doesNotThrow(()=>validateAgentPrompt('x'.repeat(maxAgentPromptCharacters)));
 for(const prompt of ['',null,'a\0b','x'.repeat(maxAgentPromptCharacters+1)])assert.throws(()=>validateAgentPrompt(prompt));
});
test('official Codex execution bridge is available',()=>assert.equal(typeof api.createNativeCodex,'function'));
test('official Codex catalog excludes registry and saved aliases after refresh or failed login',async()=>{
 let cached=[],login=true;
 const f=fixture({loadModels:async()=>cached,discovery:async()=>login?[f.profile]:[]});
 cached=[{...f.original,id:'listed'}];await f.bridge.initialize(f.ctx);
 assert.equal(f.bridge.resolveModel(f.ctx,f.original).id,'gpt-test');
 assert.deepEqual(f.bridge.catalogModels().map(model=>model.id),['listed']);
 cached=[];await f.bridge.initialize(f.ctx);
 assert.deepEqual(f.bridge.catalogModels(),[]);
 cached=[{...f.original,id:'new-listed'}];await f.bridge.initialize(f.ctx);
 assert.deepEqual(f.bridge.catalogModels().map(model=>model.id),['new-listed']);
 login=false;await f.bridge.initialize(f.ctx);
 assert.deepEqual(f.bridge.catalogModels(),[]);
});
test('subscription model resolves to CLI execution while API models keep Pi transport',{skip:!api.createNativeCodex},async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);
 assert.equal(model.provider,'yam-codex');assert.equal(model.id,'gpt-test');assert.equal(f.providers.at(-1)[1].api,'yam-native-codex');
 f.ctx.modelRegistry.isUsingOAuth=()=>false;assert.equal(f.bridge.resolveModel(f.ctx,f.original),f.original);
});
test('native subscription execution returns the final result directly and records actual session and unknown cost',{skip:!api.createNativeCodex},async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);
 const result=await f.bridge.stream(model,context,{reasoning:'max'}).result();
 assert.equal(result.stopReason,'stop');assert.equal(result.content[0].text,'Final answer');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].a.model,'gpt-test');assert.equal(f.calls[0].a.thinking,'xhigh');assert.equal(f.calls[0].o.mode,'task');assert.equal(f.calls[0].o.cwd,'/repo');
 assert.equal(f.entries.at(-1).data.sessionId,id);assert.equal(f.entries.at(-1).data.status,'completed');assert.equal(f.entries.at(-1).data.cost,null);
 assert.equal(result.usage.cacheRead,5);
});
test('classification and compaction run isolated read-only native inference instead of business execution',{skip:!api.createNativeCodex},async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original);
 for(const c of [{systemPrompt:'Classify only',messages:context.messages},{systemPrompt:'Summarize only',messages:context.messages}]){
  const r=await f.bridge.stream(m,c,{toolChoice:'none'}).result();assert.equal(r.stopReason,'stop');
 }
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.o.mode==='readonly'&&c.o.resume===null));assert.equal(f.entries.length,0);
 assert.ok(f.calls[0].o.prompt.includes('Classify only'));
});
test('follow-up resumes the same successful native session; a branch without its receipt starts fresh',{skip:!api.createNativeCodex},async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original);
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(m,context,{}).result();
 f.bridge.beginTurn(f.ctx);f.bridge.setRoute({intent:'continue'});await f.bridge.stream(m,{...context,messages:[...context.messages,{role:'assistant',content:'Final answer'},{role:'user',content:'Improve it'}]},{}).result();
 assert.equal(f.calls[1].o.resume,id);
 f.entries.length=0;f.bridge.beginTurn(f.ctx);await f.bridge.stream(m,context,{}).result();assert.equal(f.calls[2].o.resume,null);
});
test('failed native execution blocks implicit replay and never retries on another channel',{skip:!api.createNativeCodex},async()=>{
 const f=fixture({error:'quota exhausted'});await f.bridge.initialize(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);
 const r=await f.bridge.stream(m,context,{}).result();assert.equal(r.stopReason,'error');assert.match(r.errorMessage,/quota/);
 assert.equal(f.entries.at(-1).data.sessionId,id);assert.equal(f.entries.at(-1).data.status,'failed');
 f.bridge.beginTurn(f.ctx);const retry=await f.bridge.stream(m,context,{}).result();assert.equal(retry.stopReason,'error');assert.match(retry.errorMessage,/reset|unknown|inspect/i);assert.equal(f.calls.length,1);
});
test('unknown restored receipt, revoked login, restricted tools and cancellation prevent native side effects',{skip:!api.createNativeCodex},async()=>{
 for(const kind of ['unknown','auth','restricted','abort']){
  const f=fixture({restricted:kind==='restricted'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original),abort=new AbortController();
  if(kind==='unknown')f.entries.push({type:'custom',customType:'yam.native-codex.v1',data:{status:'running',cwd:'/repo'}});
  if(kind==='auth')f.profile.auth='api';if(kind==='abort')abort.abort();
  const r=await f.bridge.stream(m,context,{signal:abort.signal}).result();assert.ok(['error','aborted'].includes(r.stopReason),kind);assert.equal(f.calls.length,0,kind);
 }
});
test('native image requirements and attachments are passed only to a verified capable executor',{skip:!api.createNativeCodex},async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);f.bridge.setRoute({requires:['image_generation']});const m=f.bridge.resolveModel(f.ctx,f.original),image={type:'image',mimeType:'image/png',data:'aGVsbG8='};
 await f.bridge.stream(m,{...context,messages:[{role:'user',content:[{type:'text',text:'draw a cover'},image]}]},{}).result();
 assert.deepEqual(f.calls[0].o.images,[image]);assert.ok(f.calls[0].o.requires.includes('image_generation'));
 const g=fixture();g.profile.capabilities=['text','files'];await g.bridge.initialize(g.ctx);g.bridge.beginTurn(g.ctx);g.bridge.setRoute({requires:['image_generation']});
 const result=await g.bridge.stream(g.bridge.resolveModel(g.ctx,g.original),context,{}).result();assert.equal(result.stopReason,'error');assert.equal(g.calls.length,0);
});
test('Pi SDK empty request metadata is accepted while transport overrides are rejected',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);
 assert.equal((await f.bridge.stream(m,context,{headers:{},env:{}}).result()).stopReason,'stop');
 const blocked=await f.bridge.stream(m,{messages:context.messages},{headers:{authorization:'untrusted'}}).result();assert.equal(blocked.stopReason,'error');assert.equal(f.calls.length,1);
});
test('compacted or changed transcript prefixes still deliver the full current user follow-up',async()=>{
 for(const changed of [false,true]){
  const f=fixture();await f.bridge.initialize(f.ctx);const m=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);
  const original=[...Array.from({length:12},(_,i)=>({role:'user',content:'prior '+i})),{role:'user',content:'first task'}];
  await f.bridge.stream(m,{...context,messages:original},{}).result();f.bridge.beginTurn(f.ctx);f.bridge.setRoute({intent:'continue'});
  const messages=changed?original.map((v,i)=>i===0?{...v,content:'compacted summary'}:v):[{role:'user',content:'Compacted context'},{role:'user',content:'UNIQUE_LATEST_FOLLOWUP'}];
  if(changed)messages.push({role:'user',content:'UNIQUE_LATEST_FOLLOWUP'});
  await f.bridge.stream(m,{...context,messages},{}).result();assert.ok(f.calls[1].o.prompt.includes('UNIQUE_LATEST_FOLLOWUP'));assert.equal(f.calls[1].o.resume,id);
 }
});
test('read-only compaction never inherits image generation requirements from a pending task',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.setRoute({intent:'new',requires:['image_generation']});
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{messages:context.messages},{toolChoice:'none'}).result();assert.equal(result.stopReason,'stop');assert.deepEqual(f.calls[0].o.requires,['text']);
});
test('read-only native error notices are not mistaken for business tool execution',async()=>{
 const f=fixture({notice:'error'});await f.bridge.initialize(f.ctx);
 // Native warning/error items may precede a successful final response.
 const original=f.bridge.stream;assert.equal(typeof original,'function');
 const r=await original(f.bridge.resolveModel(f.ctx,f.original),{messages:context.messages},{toolChoice:'none'}).result();assert.equal(r.stopReason,'stop');
});
test('native model metadata preserves supported max reasoning instead of silently lowering it',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.original.thinkingLevelMap.max='max';f.bridge.beginTurn(f.ctx);
 const m=f.bridge.resolveModel(f.ctx,{...f.original,id:'native-max'});await f.bridge.stream(m,context,{reasoning:'max'}).result();assert.equal(f.calls[0].a.thinking,'max');
});
test('Codex model catalog reads native metadata, preserves effort limits and rejects unusable entries',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'yam-native-models-')),path=join(dir,'models.json');
 try{
  assert.deepEqual(await api.readNativeModels(join(dir,'missing')),[]);
  await writeFile(path,JSON.stringify({models:[{slug:'native-model',display_name:'Native',visibility:'list',context_window:500000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'xhigh'},{effort:'max'}]},{slug:'broken',visibility:'list',context_window:0}]}));
  const models=await api.readNativeModels(path);assert.equal(models.length,1);assert.equal(models[0].id,'native-model');assert.equal(models[0].thinkingLevelMap.max,'max');assert.equal(models[0].thinkingLevelMap.off,null);assert.equal(models[0].maxTokens,0);
  await writeFile(path,'not JSON');assert.deepEqual(await api.readNativeModels(path),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('native off-to-none metadata survives the bridge and actual CLI argument builder',async()=>{
 const {invocation}=await import('../src-tauri/pi/agent-executor.mjs');const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
 const model=f.bridge.resolveModel(f.ctx,f.original);await f.bridge.stream(model,context,{reasoning:'off'}).result();
 assert.equal(f.calls[0].a.thinking,'none');const job=invocation(f.calls[0].a,{prompt:'Read-only text task'});assert.ok(job.args.includes('model_reasoning_effort="none"'));
});
test('native task execution preserves parent system instructions from both context forms',async()=>{
 for(const system of ['shorthand','message']){
  const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
  const c={...context,...system==='shorthand'?{systemPrompt:'UNIQUE_PARENT_SCOPE: only edit allowed.md'}:{messages:[{role:'system',content:'UNIQUE_PARENT_SCOPE: only edit allowed.md'},...context.messages]}};
  const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),c,{}).result();assert.equal(result.stopReason,'stop');assert.ok(f.calls[0].o.prompt.includes('UNIQUE_PARENT_SCOPE: only edit allowed.md'),system);
 }
});
test('oversized native handoff fails before starting business execution or persisting a running receipt',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{...context,messages:[{role:'user',content:'x'.repeat(130000)}]},{}).result();
 assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/context|budget|long/i);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);
});

test('native main execution status stays readable while a turn is busy',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);f.ctx.isIdle=()=>false;
 await f.commands['yam-native'].handler('status',f.ctx);
 await assert.rejects(f.commands['yam-native'].handler('reset',f.ctx),/Wait/);
});

test('legacy completed receipts require one full handoff before semantic incremental delivery',async()=>{
 const {createHash}=await import('node:crypto'),f=fixture(),initial={...context,messages:[{role:'user',content:'LEGACY_SCOPE: only edit draft.md'}]};await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,initial,{}).result();const last=f.entries.at(-1).data;delete last.contextCheckpoint;last.messageCount=initial.messages.length;last.contextFingerprint=createHash('sha256').update(JSON.stringify(initial.messages)).digest('hex');
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,{...initial,messages:[...initial.messages,{role:'user',content:'Continue'}]},{}).result();assert.ok(f.calls[1].o.prompt.includes('LEGACY_SCOPE'));assert.equal(f.entries.at(-1).data.handoff.mode,'full');
});

test('a native process that could not be stopped keeps an unfinished receipt and blocks replay',async()=>{
 const f=fixture({error:Object.assign(Error('Native process may still be running'),{mayBeRunning:true})});await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);f.bridge.beginTurn(f.ctx);
 assert.equal((await f.bridge.stream(model,context,{}).result()).stopReason,'error');assert.equal(f.entries.at(-1).data.status,'running');
 f.bridge.beginTurn(f.ctx);assert.equal((await f.bridge.stream(model,context,{}).result()).stopReason,'error');assert.equal(f.calls.length,1);
});

test('payload hook thrown values return a useful native error without leaving the stream pending',async()=>{
 for(const value of ['hook failed',null]){const f=fixture();await f.bridge.initialize(f.ctx);const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{messages:context.messages},{toolChoice:'none',onPayload:()=>{throw value;}}).result();assert.equal(result.stopReason,'error');assert.equal(result.errorMessage,String(value));assert.equal(f.calls.length,0);}
});

test('receipt write failures settle native streams before execution, at start and after completion',async()=>{
 for(const persistAt of [1,2,3]){const f=fixture({persistAt});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const result=await Promise.race([f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result(),new Promise((_,reject)=>setTimeout(()=>reject(Error('native stream stuck')),1000))]);assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/receipt disk write failed/);assert.equal(f.calls.length,persistAt===1?0:1);}
});

test('Windows native bridge rejects before execution while API model identity is preserved',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original),descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 try{Object.defineProperty(process,'platform',{value:'win32'});for(const transcript of [context,{messages:context.messages,tools:[]}]){const result=await f.bridge.stream(model,transcript,{}).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/Windows.*not supported/i);}assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);f.ctx.modelRegistry.isUsingOAuth=()=>false;assert.equal(f.bridge.resolveModel(f.ctx,f.original),f.original);}finally{Object.defineProperty(process,'platform',descriptor);}
});

test('modified native payloads require a full unmodified handoff before incremental checkpoints resume',async()=>{
 const f=fixture(),first={...context,systemPrompt:'PARENT_SCOPE',messages:[{role:'user',content:'ORIGINAL'}]};await f.bridge.initialize(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);
 f.bridge.beginTurn(f.ctx);assert.equal((await f.bridge.stream(model,first,{onPayload:p=>({...p,prompt:p.prompt.replace('ORIGINAL','REDACTED')})}).result()).stopReason,'stop');assert.ok(f.calls[0].o.prompt.includes('REDACTED'));assert.equal(f.entries.at(-1).data.contextCheckpoint,null);
 const next={...first,messages:[...first.messages,{role:'user',content:'Continue'}]};f.bridge.beginTurn(f.ctx);assert.equal((await f.bridge.stream(model,next,{}).result()).stopReason,'stop');assert.equal(f.calls[1].o.resume,id);assert.ok(f.calls[1].o.prompt.includes('ORIGINAL'));assert.equal(f.entries.at(-1).data.handoff.mode,'full');assert.ok(f.entries.at(-1).data.contextCheckpoint);
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,{...next,messages:[...next.messages,{role:'user',content:'Again'}]},{onPayload:p=>({...p})}).result();assert.equal(f.entries.at(-1).data.handoff.mode,'incremental');assert.ok(!f.calls[2].o.prompt.includes('ORIGINAL'));assert.ok(f.entries.at(-1).data.contextCheckpoint);
});
test('payload hooks cannot remove mandatory native scope in task or read-only inference',async()=>{
 for(const readonly of [false,true]){const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{...context,systemPrompt:'PARENT_SCOPE'},{...readonly?{toolChoice:'none'}:{},onPayload:p=>({...p,prompt:'Replacement without parent scope'})}).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/scope/i);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);}
});

const collaborationRoles=[
 {id:'pi-small',model:'yam-codex/gpt-helper',auth:'subscription',thinking:'low'},
 {id:'pi-medium',model:'yam-codex/gpt-test',auth:'subscription',thinking:'medium'},
 {id:'pi-strong',model:'yam-codex/gpt-helper',auth:'subscription',thinking:'high'}
];
test('native main task receives only known subscription model roles and owns collaboration closure',async()=>{
 const f=fixture({extraModels:[{provider:'openai-codex',id:'gpt-helper',input:['text'],reasoning:true}]});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
 f.bridge.setRoute({intent:'new',roles:[...collaborationRoles,{id:'pi-strong',model:'other/paid',auth:'api',thinking:'high'},{id:'pi-strong',model:'yam-codex/unknown',auth:'subscription',thinking:'high'}]});
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),{...context,systemPrompt:'USER_FORBIDS_PUBLISHING'},{}).result();
 assert.equal(result.stopReason,'stop');const options=f.calls[0].o;
 assert.equal(options.allowCollaboration,true);assert.match(options.prompt,/Automatic native collaboration/);assert.match(options.prompt,/fork_turns=none/);assert.match(options.prompt,/wait.*sub.*(?:task|agent)/i);assert.match(options.prompt,/verify.*(?:result|artifact)/i);
 assert.ok(options.prompt.includes('gpt-helper'));assert.ok(options.prompt.includes('USER_FORBIDS_PUBLISHING'));assert.ok(!options.prompt.includes('other/paid'));assert.ok(!options.prompt.includes('yam-codex/unknown'));
 assert.equal(f.calls[0].a.model,'gpt-test');
});
test('read-only, fixed, single-model and delegated execution cannot enable native collaboration',async()=>{
 for(const kind of ['readonly','fixed','single','child','unavailable']){
  const f=fixture({extraModels:[{provider:'openai-codex',id:'gpt-helper',input:['text'],reasoning:true}]});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
  const roles=kind==='fixed'?[{...collaborationRoles[1],id:'pi-fixed'}]:kind==='single'?[collaborationRoles[1],{...collaborationRoles[1],id:'pi-small'}]:kind==='unavailable'?[collaborationRoles[1],{...collaborationRoles[0],model:'openai/gpt-paid',auth:'api'}]:collaborationRoles;
  f.bridge.setRoute({roles});const previous=process.env.YAM_AGENT_ROUTING_CHILD;
  try{if(kind==='child')process.env.YAM_AGENT_ROUTING_CHILD='1';await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,kind==='readonly'?{toolChoice:'none'}:{}).result();}
  finally{if(previous===undefined)delete process.env.YAM_AGENT_ROUTING_CHILD;else process.env.YAM_AGENT_ROUTING_CHILD=previous;}
  assert.equal(f.calls[0].o.allowCollaboration,false,kind);assert.ok(!f.calls[0].o.prompt.includes('Automatic native collaboration'),kind);
 }
});

test('native helper reasoning follows the same metadata mapping as its parent and rejects unsupported levels',async()=>{
 for(const desired of ['max','off','high']){
  const f=fixture({extraModels:[{provider:'openai-codex',id:'gpt-helper',input:['text'],reasoning:true,thinkingLevelMap:{max:'xhigh',off:'none',high:null}}]});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
  f.bridge.setRoute({roles:[collaborationRoles[1],{...collaborationRoles[0],thinking:desired}]});
  await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{reasoning:desired}).result();
  const call=f.calls[0];assert.equal(call.a.thinking,desired==='max'?'xhigh':desired==='off'?'none':'high');
  if(desired==='high'){assert.equal(call.o.allowCollaboration,false);assert.ok(!call.o.prompt.includes('Automatic native collaboration'));}
  else{assert.equal(call.o.allowCollaboration,true);assert.ok(call.o.prompt.includes(JSON.stringify({role:'small',model:'gpt-helper',reasoning:desired==='max'?'xhigh':'none'})));}
 }
});

test('native capability snapshot is read-only and execution rechecks revoked runtime abilities',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);assert.deepEqual(f.bridge.capabilities(),f.profile.capabilities);
 const copy=f.bridge.capabilities();copy.length=0;assert.ok(f.bridge.capabilities().includes('image_generation'));
 f.profile.capabilities=['text','files','image_input'];f.bridge.beginTurn(f.ctx);f.bridge.setRoute({intent:'new',requires:['image_generation']});
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/capability/);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);
 await f.bridge.initialize(f.ctx);assert.deepEqual(f.bridge.capabilities(),f.profile.capabilities);
});

// C2: recovery is a status/control seam, never an execution retry.
test('native recovery exposes only branch-local facts and survives restore without replay',async()=>{
 const f=fixture({error:Object.assign(Error('PRIVATE_STDERR'),{mayBeRunning:true})});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
 await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();
 assert.equal(typeof f.bridge.getRecovery,'function');
 const recovery=f.bridge.getRecovery(f.ctx);assert.equal(recovery.sessionId,id);assert.equal(recovery.status,'running');assert.equal(recovery.reason,'cleanup-unconfirmed');assert.equal(recovery.needsInspection,true);assert.equal(recovery.inProgress,false);
 assert.deepEqual(Object.keys(recovery).sort(),['cleanup','failure','inProgress','needsInspection','reason','receiptId','sessionId','status']);assert.doesNotMatch(JSON.stringify(recovery),/PRIVATE|identity|cwd|prompt|stderr/);
 const restored=fixture();restored.entries.push(...structuredClone(f.entries));await restored.bridge.initialize(restored.ctx);restored.bridge.beginTurn(restored.ctx);assert.deepEqual(restored.bridge.getRecovery(restored.ctx),recovery);
 const branch=restored.entries.splice(0);assert.equal(restored.bridge.getRecovery(restored.ctx),null);restored.entries.push(...branch);assert.deepEqual(restored.bridge.getRecovery(restored.ctx),recovery);assert.equal(restored.calls.length,0);
});
test('native recovery treats legacy receipts conservatively, including missing identifiers',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);assert.equal(typeof f.bridge.getRecovery,'function');
 for(const status of ['failed','running']){f.entries.length=0;f.entries.push({type:'custom',customType:'yam.native-codex.v1',data:{status,identity:'PRIVATE',cwd:'/PRIVATE'}});assert.deepEqual(f.bridge.getRecovery(f.ctx),{receiptId:null,sessionId:null,status,reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true});assert.throws(()=>f.bridge.reset(f.ctx,{receiptId:null,confirmed:true}),/receipt|identif/i);}
 f.entries[0].id='legacy-entry';assert.equal(f.bridge.getRecovery(f.ctx).receiptId,'legacy-entry');
});
test('native recovery reset requires current receipt, idle and confirmation and only writes a marker',async()=>{
 const f=fixture({error:'quota exhausted'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);await f.bridge.stream(model,context,{}).result();
 assert.equal(typeof f.bridge.reset,'function');const receiptId=f.bridge.getRecovery(f.ctx).receiptId,before=f.entries.length;
 for(const data of [{receiptId},{receiptId,confirmed:false},{receiptId:'stale',confirmed:true},{receiptId,confirmed:true,extra:1}])assert.throws(()=>f.bridge.reset(f.ctx,data),/confirm|receipt|Invalid/i);
 f.ctx.isIdle=()=>false;assert.throws(()=>f.bridge.reset(f.ctx,{receiptId,confirmed:true}),/Wait|stop/i);f.ctx.isIdle=()=>true;
 f.bridge.reset(f.ctx,{receiptId,confirmed:true});assert.equal(f.entries.length,before+1);assert.equal(f.entries.at(-1).customType,'yam.native-codex-reset.v1');assert.equal(f.entries.at(-1).data.receiptId,receiptId);assert.equal(f.bridge.getRecovery(f.ctx),null);assert.equal(f.calls.length,1);
 f.bridge.beginTurn(f.ctx);await f.bridge.stream(model,context,{}).result();assert.equal(f.calls.length,2);assert.equal(f.calls[1].o.resume,null);
});
test('native reset persistence failure leaves the unfinished receipt blocked',async()=>{
 const f=fixture({error:'failed',persistAt:4});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();assert.equal(typeof f.bridge.getRecovery,'function');const before=f.bridge.getRecovery(f.ctx);
 assert.throws(()=>f.bridge.reset(f.ctx,{receiptId:before.receiptId,confirmed:true}),/disk/);assert.deepEqual(f.bridge.getRecovery(f.ctx),before);assert.equal(f.calls.length,1);
});
test('native recovery can be viewed during execution but cannot clear an active receipt',async()=>{
 let release,started;const ready=new Promise(r=>started=r),f=fixture({onExecute:()=>{started();return new Promise(r=>release=r);}});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const pending=f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();await ready;
 assert.equal(typeof f.bridge.getRecovery,'function');const current=f.bridge.getRecovery(f.ctx);assert.equal(current.inProgress,true);assert.equal(current.needsInspection,false);assert.throws(()=>f.bridge.reset(f.ctx,{receiptId:current.receiptId,confirmed:true}),/Wait|stop/i);
 release({finalText:'Done',sessionId:id});await pending;assert.equal(f.bridge.getRecovery(f.ctx),null);assert.equal(f.calls.length,1);
});
test('CLI reset confirmation binds the branch and refreshes recovery without executing',async()=>{
 const f=fixture({error:'failed'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();let release;f.ctx.ui.confirm=()=>new Promise(r=>release=r);const before=f.entries.length;
 const pending=f.commands['yam-native'].handler('reset',f.ctx);f.bridge.beginTurn(f.ctx);release(true);await assert.rejects(pending,/changed|refresh/i);assert.equal(f.entries.length,before);assert.equal(f.calls.length,1);
 f.ctx.ui.confirm=async()=>false;await f.commands['yam-native'].handler('reset',f.ctx);assert.equal(f.entries.length,before);
 let updates=0;f.bridge.observeExecution(()=>updates++);f.ctx.ui.confirm=async()=>true;await f.commands['yam-native'].handler('reset',f.ctx);assert.equal(updates,1);assert.equal(f.calls.length,1);assert.equal(f.bridge.getRecovery(f.ctx),null);
});

test('CLI recovery preserves empty, completed and identifier-free manual resets',async()=>{
 for(const kind of ['empty','completed','legacy']){const f=fixture();await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);if(kind==='completed')await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();if(kind==='legacy')f.entries.push({type:'custom',customType:'yam.native-codex.v1',data:{status:'failed'}});const calls=f.calls.length;await f.commands['yam-native'].handler('reset',f.ctx);assert.equal(f.entries.at(-1).customType,'yam.native-codex-reset.v1',kind);assert.equal(f.bridge.getRecovery(f.ctx),null);assert.equal(f.calls.length,calls);}
});
test('CLI confirmation rejects a replaced receipt even when its logical identifier stays the same',async()=>{
 const f=fixture({error:'failed'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();let release;f.ctx.ui.confirm=()=>new Promise(r=>release=r);const pending=f.commands['yam-native'].handler('reset',f.ctx);f.entries.push(structuredClone(f.entries.at(-1)));release(true);await assert.rejects(pending,/changed|receipt/i);assert.notEqual(f.entries.at(-1).customType,'yam.native-codex-reset.v1');
});
test('native cancellation persists a conservative recovery reason and never restarts work',async()=>{
 const abort=new AbortController(),f=fixture({onExecute:()=>{abort.abort();throw Error('aborted');}});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{signal:abort.signal}).result();const recovery=f.bridge.getRecovery(f.ctx);assert.equal(recovery.reason,'cancelled');assert.equal(recovery.cleanup,'unknown');assert.equal(recovery.needsInspection,true);assert.equal(f.calls.length,1);
});

test('native recovery status exposes only a strictly validated Codex session UUID for inspection',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);const notices=[];f.ctx.ui.notify=raw=>notices.push(JSON.parse(raw));
 for(const sessionId of [id,id.toUpperCase(),null,undefined,'PRIVATE_SESSION','../PRIVATE',' '+id,id+'\n',id+'; PRIVATE',id.replaceAll('-',''),123,{id}]){
  f.entries.length=0;f.entries.push({type:'custom',customType:'yam.native-codex.v1',data:{id:'receipt',status:'failed',sessionId,identity:'PRIVATE_IDENTITY',cwd:'/PRIVATE_CWD',prompt:'PRIVATE_PROMPT',stderr:'PRIVATE_STDERR'}});
  const expected=typeof sessionId==='string'&&[id,id.toUpperCase()].includes(sessionId)?sessionId:null,recovery=f.bridge.getRecovery(f.ctx);assert.equal(recovery.sessionId,expected);await f.commands['yam-native'].handler('status',f.ctx);assert.deepEqual(notices.at(-1),recovery);assert.doesNotMatch(JSON.stringify(recovery),/PRIVATE|identity|cwd|prompt|stderr/);assert.equal(recovery.needsInspection,true);
 }
 assert.equal(f.calls.length,0);
});

test('native recovery rejects control characters in receipt and legacy entry identifiers without trimming',async()=>{
 const f=fixture();await f.bridge.initialize(f.ctx);
 for(const suffix of ['\n','\r','\r\n','\u2028','\u2029','\x00']){
  f.entries.length=0;f.entries.push({type:'custom',customType:'yam.native-codex.v1',id:'entry'+suffix,data:{id:'receipt'+suffix,status:'failed',sessionId:id}});const recovery=f.bridge.getRecovery(f.ctx);assert.equal(recovery.receiptId,null,JSON.stringify(suffix));assert.equal(recovery.sessionId,id);assert.equal(recovery.needsInspection,true);assert.throws(()=>f.bridge.reset(f.ctx,{receiptId:'receipt',confirmed:true}),/receipt|identif/i);
 }
});

test('native refresh replaces same-id model metadata and republishes the physical catalog',async()=>{
 const model={provider:'openai-codex',id:'same',input:['text'],contextWindow:1000,thinkingLevelMap:{high:'high'}};let current=model;const providers=[];
 const bridge=api.createNativeCodex({registerCommand(){},registerProvider:(_p,v)=>providers.push(v)},{loadModels:async()=>[current],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files','image_input']}]});
 const ctx={modelRegistry:{getAll:()=>[]}};await bridge.initialize(ctx);
 for(const patch of [{input:['text','image'],contextWindow:2000,thinkingLevelMap:{high:null}},{input:['text'],contextWindow:500,thinkingLevelMap:{high:'high'}}]){
  current={...model,...patch};await bridge.initialize(ctx);const resolved=bridge.resolveModel(ctx,model);
  assert.deepEqual(resolved.input,current.input);assert.equal(resolved.contextWindow,current.contextWindow);assert.deepEqual(resolved.thinkingLevelMap,current.thinkingLevelMap);assert.deepEqual(providers.at(-1).models.find(m=>m.id==='same'),resolved);
 }
 const count=providers.length;await bridge.initialize(ctx);assert.equal(providers.length,count,'unchanged discovery does not republish the catalog');
});

test('native fallback refresh ignores its own wrapped catalog and keeps fresh OAuth metadata',async()=>{
 let source={provider:'openai',id:'same',name:'Model',input:['text'],contextWindow:1000};const providers=[];
 const ctx={modelRegistry:{getAll:()=>[source,...providers.at(-1)?.models??[]],isUsingOAuth:m=>m.provider==='openai'}};
 const bridge=api.createNativeCodex({registerCommand(){},registerProvider:(_p,v)=>providers.push(v)},{loadModels:async()=>[],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files','image_input']}]});
 await bridge.initialize(ctx);source={...source,input:['text','image']};await bridge.initialize(ctx);const resolved=bridge.resolveModel(ctx,source);
 assert.deepEqual(resolved.input,['text','image']);assert.equal(resolved.name,'Codex CLI · Model');const count=providers.length;await bridge.initialize(ctx);assert.equal(providers.length,count);
});

test('T2 native preflight failures carry safe facts without replacing the legacy context-budget diagnostic',async()=>{
 for(const kind of ['context','capability','cancel']){
  const observed=[],f=fixture();await f.bridge.initialize(f.ctx);f.bridge.observeExecution(value=>observed.push(value));f.bridge.beginTurn(f.ctx);
  const abort=new AbortController();if(kind==='cancel')abort.abort();if(kind==='capability')f.profile.capabilities=['text'];
  const transcript=kind==='context'?{...context,messages:[{role:'user',content:'PRIVATE '+ 'x'.repeat(128000)}]}:context;
  const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),transcript,{signal:abort.signal}).result();
  assert.equal(result.failure?.category,kind==='cancel'?'cancelled':kind);assert.equal(result.failure.dispatch,'not-started');assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);assert.doesNotMatch(JSON.stringify(result.failure),/PRIVATE|prompt|cwd|stderr/);
  if(kind==='context')assert.equal(observed.at(-1).failure,'context-budget');
 }
});

test('T2 native login failure survives initialization and execution discovery without guessing an empty catalog',async()=>{
 const {createAgentDiscovery}=await import('../src-tauri/pi/agent-executor.mjs');
 const discovery=createAgentDiscovery({identity:async()=> 'installed',probe:async()=>({code:1,stdout:'',stderr:'Not logged in\n'})}),f=fixture({discovery});
 await f.bridge.initialize(f.ctx);assert.equal(f.bridge.discoveryFailure?.()?.code,'not-logged-in');f.bridge.beginTurn(f.ctx);
 const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();
 assert.equal(result.failure?.category,'auth');assert.equal(result.failure.stage,'discovery');assert.equal(result.failure.dispatch,'not-started');assert.equal(f.entries.length,0);assert.equal(f.calls.length,0);
 const unknown=fixture({discovery:async()=>[]});await unknown.bridge.initialize(unknown.ctx);unknown.bridge.beginTurn(unknown.ctx);const fallback=await unknown.bridge.stream(unknown.bridge.resolveModel(unknown.ctx,unknown.original),context,{}).result();assert.equal(fallback.failure?.category,'unknown');
});

test('T2 native missing session is a failed inspected receipt and cannot be silently resumed or replayed',async()=>{
 const f=fixture({onExecute:()=>({finalText:'Done',sessionId:null})});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const model=f.bridge.resolveModel(f.ctx,f.original);
 const result=await f.bridge.stream(model,context,{}).result();assert.equal(result.stopReason,'error');assert.equal(result.failure?.code,'native-session-missing');assert.equal(result.failure.dispatch,'started');
 const recovery=f.bridge.getRecovery(f.ctx);assert.equal(recovery.status,'failed');assert.equal(recovery.failure.code,'native-session-missing');assert.equal(recovery.failure.nextAction,'inspect-task');assert.equal(recovery.sessionId,null);
 f.bridge.beginTurn(f.ctx);await f.bridge.initialize(f.ctx);assert.equal((await f.bridge.stream(model,context,{}).result()).stopReason,'error');assert.equal(f.calls.length,1);
 const readonly=await f.bridge.stream(model,{messages:context.messages},{toolChoice:'none'}).result();assert.equal(readonly.stopReason,'stop');assert.equal(f.entries.at(-1).data.status,'failed');
});

test('T2 receipt failure projection is allowlisted and legacy receipts remain conservative',async()=>{
 const f=fixture({error:'quota exceeded PRIVATE_STDERR'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();
 assert.equal(result.failure?.category,'unknown');assert.equal(result.failure.dispatch,'started');assert.equal(f.bridge.getRecovery(f.ctx).failure.nextAction,'inspect-task');
 const latest=f.entries.at(-1).data;latest.failure.prompt='PRIVATE_PROMPT';latest.failure.stderr='PRIVATE_STDERR';latest.failure.cwd='/PRIVATE';latest.failure.nextAction='retry';
 const restored=fixture();restored.entries.push(...structuredClone(f.entries));await restored.bridge.initialize(restored.ctx);restored.bridge.beginTurn(restored.ctx);
 assert.doesNotMatch(JSON.stringify(restored.bridge.getRecovery(restored.ctx)),/PRIVATE|retry|prompt|stderr|cwd/);
 delete restored.entries.at(-1).data.failure;assert.equal(restored.bridge.getRecovery(restored.ctx).reason,'execution-failed');assert.equal(restored.bridge.getRecovery(restored.ctx).failure,undefined);
});

test('T2 dispatched cancellation and receipt persistence retain inspection requirements',async()=>{
 for(const reported of [true,false]){
  const abort=new AbortController(),f=fixture({onExecute:o=>{if(reported)o.onLine(JSON.stringify({type:'thread.started',thread_id:id}));abort.abort();throw Error('cancelled');}});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);
  const result=await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{signal:abort.signal}).result();assert.equal(result.failure?.category,'cancelled');assert.equal(result.failure.dispatch,reported?'started':'unknown');assert.equal(f.bridge.getRecovery(f.ctx).failure.nextAction,'inspect-task');
 }
 const disk=fixture({persistAt:3});await disk.bridge.initialize(disk.ctx);disk.bridge.beginTurn(disk.ctx);const failed=await disk.bridge.stream(disk.bridge.resolveModel(disk.ctx,disk.original),context,{}).result();assert.equal(failed.failure?.code,'receipt-persistence');assert.equal(failed.failure.stage,'persistence');assert.equal(failed.failure.nextAction,'inspect-task');assert.ok(disk.bridge.getRecovery(disk.ctx));
});

test('release recovery accepts fresh callback contexts for the same session manager after CLI status',async()=>{
 const f=fixture({error:'failed'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();
 const recovery=f.bridge.getRecovery(f.ctx),before=f.entries.length,commandContext={...f.ctx};await f.commands['yam-native'].handler('status',commandContext);
 f.bridge.reset(f.ctx,{receiptId:recovery.receiptId,confirmed:true});assert.equal(f.entries.length,before+1);assert.equal(f.bridge.getRecovery(f.ctx),null);assert.equal(f.calls.length,1);
});
test('release recovery still rejects a foreign session manager with a copied receipt identifier',async()=>{
 const f=fixture({error:'failed'});await f.bridge.initialize(f.ctx);f.bridge.beginTurn(f.ctx);await f.bridge.stream(f.bridge.resolveModel(f.ctx,f.original),context,{}).result();const recovery=f.bridge.getRecovery(f.ctx),before=f.entries.length;
 const foreign={...f.ctx,sessionManager:{...f.ctx.sessionManager,getBranch:()=>structuredClone(f.entries)}};
 assert.throws(()=>f.bridge.reset(foreign,{receiptId:recovery.receiptId,confirmed:true}),/changed|refresh/i);assert.equal(f.entries.length,before);assert.equal(f.calls.length,1);
});
