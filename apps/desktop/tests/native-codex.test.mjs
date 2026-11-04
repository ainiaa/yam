import assert from 'node:assert/strict';
import {test} from 'node:test';
const api=await import('../src-tauri/pi/native-codex.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const id='01234567-1234-1234-1234-0123456789ab';
function fixture({error,restricted=false,notice,persistAt=Infinity,now,onDiscover,onExecute,configuredExecutable='/native/codex'}={}){
 const entries=[],calls=[],providers=[],commands={};let writes=0;
 const original={provider:'openai',id:'gpt-test',api:'openai-responses',reasoning:true,input:['text','image'],contextWindow:100000,maxTokens:10000,thinkingLevelMap:{off:'none',medium:'medium',high:'high',max:'xhigh'}};
 const profile={id:'codex',kind:'codex',executable:'/native/codex',auth:'subscription',capabilities:['text','files','image_input','image_generation']};
 const pi={getActiveTools:()=>restricted?['read']:['read','bash','edit','write'],registerProvider:(...v)=>providers.push(v),appendEntry:(customType,data)=>{if(++writes>=persistAt)throw Error('receipt disk write failed');entries.push({type:'custom',customType,data});},registerCommand:(n,c)=>commands[n]=c};
 const ctx={cwd:'/repo',ui:{setStatus(){},notify(){},confirm:async()=>true},isIdle:()=>true,sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/owned/parent.jsonl'},modelRegistry:{isUsingOAuth:()=>true,getAll:()=>[original]}};
 const createStream=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {events:[],push(e){this.events.push(e);if(e.type==='done')resolve(e.message);if(e.type==='error')resolve(e.error);},end(){},result:()=>promise};};
 const bridge=api.createNativeCodex?.(pi,{now,createStream,getTools:c=>c.tools??[],getSystemPrompt:c=>c.systemPrompt??c.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),loadModels:async()=>[],executable:configuredExecutable,discover:async()=>{onDiscover?.();return [profile];},execute:async(a,o)=>{calls.push({a,o});if(onExecute)return onExecute(o);o.onLine?.(JSON.stringify({type:'thread.started',thread_id:id}));if(notice)o.onLine?.(JSON.stringify({type:'item.completed',item:{type:notice}}));if(error)throw typeof error==='string'?Error(error):error;return {text:'native commentary\nFinal answer',finalText:'Final answer',sessionId:id,usage:{input_tokens:20,cached_input_tokens:5,output_tokens:4}};}});
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
