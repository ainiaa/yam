import assert from 'node:assert/strict';
import {test} from 'node:test';
const api=await import('../src-tauri/pi/native-codex.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const id='01234567-1234-1234-1234-0123456789ab';
function fixture({error,restricted=false,notice,persistAt=Infinity}={}){
 const entries=[],calls=[],providers=[],commands={};let writes=0;
 const original={provider:'openai',id:'gpt-test',api:'openai-responses',reasoning:true,input:['text','image'],contextWindow:100000,maxTokens:10000,thinkingLevelMap:{off:'none',medium:'medium',high:'high',max:'xhigh'}};
 const profile={id:'codex',kind:'codex',executable:'/native/codex',auth:'subscription',capabilities:['text','files','image_input','image_generation']};
 const pi={getActiveTools:()=>restricted?['read']:['read','bash','edit','write'],registerProvider:(...v)=>providers.push(v),appendEntry:(customType,data)=>{if(++writes>=persistAt)throw Error('receipt disk write failed');entries.push({type:'custom',customType,data});},registerCommand:(n,c)=>commands[n]=c};
 const ctx={cwd:'/repo',ui:{setStatus(){},notify(){},confirm:async()=>true},isIdle:()=>true,sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/owned/parent.jsonl'},modelRegistry:{isUsingOAuth:()=>true,getAll:()=>[original]}};
 const createStream=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {events:[],push(e){this.events.push(e);if(e.type==='done')resolve(e.message);if(e.type==='error')resolve(e.error);},end(){},result:()=>promise};};
 const bridge=api.createNativeCodex?.(pi,{createStream,getTools:c=>c.tools??[],getSystemPrompt:c=>c.systemPrompt??c.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),loadModels:async()=>[],executable:'/native/codex',discover:async()=>[profile],execute:async(a,o)=>{calls.push({a,o});o.onLine?.(JSON.stringify({type:'thread.started',thread_id:id}));if(notice)o.onLine?.(JSON.stringify({type:'item.completed',item:{type:notice}}));if(error)throw typeof error==='string'?Error(error):error;return {text:'native commentary\nFinal answer',finalText:'Final answer',sessionId:id,usage:{input_tokens:20,cached_input_tokens:5,output_tokens:4}};}});
 return {bridge,entries,calls,providers,commands,ctx,original,profile};
}
const context={messages:[{role:'user',content:'Write the article with a cover'}],tools:[{name:'read'}]};
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
