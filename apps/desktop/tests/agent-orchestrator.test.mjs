import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
const api=await import('../src-tauri/pi/agent-orchestrator.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const uuid='01234567-1234-1234-1234-0123456789ab';
const task=(id,executor,dependsOn=[])=>({id,executor,goal:id,requires:['text'],dependsOn,resume:null});
const plan=tasks=>({version:1,intent:'new',billing:'configured',reason:'Use native capabilities',clarification:null,tasks});
function fixture(answer=plan([task('article','pi-small'),task('cover','codex',['article'])])){
 const entries=[],calls=[],requests=[];let classifications=0;
 const catalog=[{id:'pi-small',kind:'pi',model:'p/small',auth:'api',capabilities:['text','files']},{id:'codex',kind:'codex',auth:'subscription',capabilities:['text','files','image_generation']}];
 const controller=api.createOrchestrator({catalog:async()=>catalog,classify:async request=>{requests.push(request);classifications++;return typeof answer==='function'?answer(request,classifications):answer;},execute:async(agent,options)=>{calls.push({agent,options});return {sessionId:uuid,text:agent.id==='pi-small'?'Article text':'Created cover',usage:null};},append:(type,data)=>entries.push({type:'custom',customType:type,data}),status:()=>{}});
 return {controller,entries,calls,requests,catalog,get classifications(){return classifications;}};
}
test('agent orchestration exports a working controller and Pi integration',()=>{assert.equal(typeof api.createOrchestrator,'function');assert.equal(typeof api.installAgents,'function');});
test('model plan dispatches sequentially with dependencies and durable native receipts',{skip:!api.createOrchestrator},async()=>{
 const f=fixture();const r=await f.controller.run({prompt:'Write article and cover',cwd:'/repo',sessionDirectory:'/owned/children'});
 assert.equal(r.error,null);assert.equal(f.classifications,1);assert.deepEqual(f.calls.map(c=>c.agent.id),['pi-small','codex']);
 assert.ok(f.calls[1].options.prompt.includes('Article text'));assert.ok(f.calls[1].options.prompt.includes('untrusted'));
 const receipts=f.entries.filter(e=>e.customType==='yam.agent-task.v1');assert.deepEqual(receipts.map(r=>r.data.status),['running','completed','running','completed']);
 assert.equal(receipts[1].data.sessionId,uuid);assert.equal(r.results.length,2);
});
test('invalid model plan gets one correction and no unvalidated execution',{skip:!api.createOrchestrator},async()=>{
 const f=fixture(()=>({...plan([task('bad','shell')])}));const r=await f.controller.run({prompt:'task',cwd:'/repo'});
 assert.match(r.error,/Executor/);assert.equal(f.classifications,2);assert.equal(f.calls.length,0);assert.ok(f.requests[1].validationError.includes('Executor'));
 const good=fixture((_,n)=>plan([task('a',n===1?'shell':'codex')]));assert.equal((await good.controller.run({prompt:'task',cwd:'/repo'})).error,null);assert.equal(good.classifications,2);assert.equal(good.calls.length,1);
});
test('classification failure and clarification never fall back to task execution',{skip:!api.createOrchestrator},async()=>{
 const f=fixture(()=>{throw Error('quota exhausted');});assert.match((await f.controller.run({prompt:'task',cwd:'/repo'})).error,/quota/);assert.equal(f.classifications,1);assert.equal(f.calls.length,0);
 const q=fixture({...plan([]),clarification:'Which file?'});const r=await q.controller.run({prompt:'change it',cwd:'/repo'});assert.equal(r.plan.clarification,'Which file?');assert.equal(q.calls.length,0);
});
test('malformed JSON is corrected once and reset boundaries survive restoration',{skip:!api.createOrchestrator},async()=>{
 const f=fixture((_,n)=>n===1?'not JSON':JSON.stringify(plan([task('ok','codex')])));
 assert.equal((await f.controller.run({prompt:'task',cwd:'/repo'})).error,null);assert.equal(f.classifications,2);
 const g=fixture();g.controller.restore([{type:'custom',customType:'yam.agent-task.v1',data:{planId:'old',taskId:'a',status:'running'}},{type:'custom',customType:'yam.agent-reset.v1',data:{}}]);
 assert.equal((await g.controller.run({prompt:'new task',cwd:'/repo'})).error,null);
});
test('image attachments and prior goals reach the selected native task',{skip:!api.createOrchestrator},async()=>{
 const f=fixture(plan([task('describe','codex')])),images=[{type:'image',mimeType:'image/png',data:'base64'}];f.catalog[1].capabilities.push('image_input');
 assert.equal((await f.controller.run({prompt:'Describe this screenshot',cwd:'/repo',images})).error,null);
 assert.deepEqual(f.calls[0].options.images,images);
});
test('execution failure stops dependent tasks and cannot replay on another backend',{skip:!api.createOrchestrator},async()=>{
 const entries=[],calls=[];const c=api.createOrchestrator({catalog:async()=>[{id:'codex',kind:'codex',auth:'subscription',capabilities:['text']}],classify:async()=>plan([task('a','codex'),task('b','codex',['a'])]),execute:async()=>{calls.push(1);throw Error('native quota');},append:(t,d)=>entries.push({type:'custom',customType:t,data:d}),status(){}});
 assert.match((await c.run({prompt:'task',cwd:'/repo'})).error,/native quota/);assert.equal(calls.length,1);assert.equal(entries.at(-1).data.status,'failed');
});
test('recovery blocks unknown children, and explicit reset is separate from execution',{skip:!api.createOrchestrator},async()=>{
 const f=fixture();f.controller.restore([{type:'custom',customType:'yam.agent-task.v1',data:{planId:'old',taskId:'a',status:'running',executor:'codex'}}]);
 assert.match((await f.controller.run({prompt:'continue',cwd:'/repo'})).error,/unknown|unfinished/i);assert.equal(f.classifications,0);assert.equal(f.calls.length,0);
});
test('follow-ups resume the same successful child and reject a changed model identity',{skip:!api.createOrchestrator},async()=>{
 const f=fixture(plan([task('old','pi-small')]));await f.controller.run({prompt:'write',cwd:'/repo'});
 const saved=f.entries.slice();const follow=fixture(plan([{...task('next','pi-small'),resume:'old'}]));
 const answer=plan([{...task('next','pi-small'),resume:'old'}]);answer.intent='continue';
 const calls=[];const c=api.createOrchestrator({catalog:async()=>follow.catalog,classify:async()=>answer,execute:async(a,o)=>{calls.push(o);return {sessionId:uuid,text:'continued'};},append(){},status(){}});c.restore(saved);
 assert.equal((await c.run({prompt:'continue',cwd:'/repo'})).error,null);assert.equal(calls[0].resume,uuid);
 follow.catalog[0].model='p/different';c.restore(saved);assert.match((await c.run({prompt:'continue',cwd:'/repo'})).error,/identity|model/i);assert.equal(calls.length,1);
});
test('every resume target is checked before the first task can have side effects',{skip:!api.createOrchestrator},async()=>{
 const f=fixture(plan([task('old','pi-small')]));await f.controller.run({prompt:'write',cwd:'/repo'});
 const p=plan([task('first','codex'),{...task('next','pi-small'),resume:'old'}]);p.intent='continue';let executions=0;
 const c=api.createOrchestrator({catalog:async()=>[{...f.catalog[0],model:'changed'},f.catalog[1]],classify:async()=>p,execute:async()=>{executions++;return {text:'done'};},append(){},status(){}});c.restore(f.entries);
 assert.match((await c.run({prompt:'continue',cwd:'/repo'})).error,/identity/);assert.equal(executions,0);
});
test('Pi runtime stages the new modules and only its YAM entry enables agent orchestration',{skip:!api.installAgents},()=>{
 const entry=readFileSync(new URL('../src-tauri/pi/entry.ts',import.meta.url),'utf8'),native=readFileSync(new URL('../src-tauri/src/pi_router.rs',import.meta.url),'utf8');
 assert.ok(entry.includes('installAgents'));for(const file of ['agent-plan.mjs','agent-executor.mjs','agent-orchestrator.mjs','native-codex.mjs','handoff-context.mjs'])assert.ok(native.includes(`include_str!("../pi/${file}")`),file);
});
function hostFixture({failure=false,restricted=false}={}){
 const handlers={},entries=[],tools={},dispatched=[],commands={},notices=[];
 const native={id:'codex',kind:'codex',executable:'/native/codex',auth:'subscription',capabilities:['text','files','image_generation']};
 const pi={getFlag:()=>false,getActiveTools:()=>restricted?['read']:['read','bash','edit','write'],on:(name,fn)=>handlers[name]=fn,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),registerCommand:(n,c)=>commands[n]=c,registerTool:t=>tools[t.name]=t};
 const ctx={cwd:'/repo',isIdle:()=>false,ui:{notify:v=>notices.push(v),setStatus(){}},sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/owned/parent.jsonl'},modelRegistry:{streamSimple:()=>{throw Error('Extra planner inference is forbidden');}}};
 const routing={agentRoutingContext:()=>({fixedModel:null,profiles:[]})};
 api.installAgents(pi,routing,{discover:async()=>[native],execute:async(agent,options)=>{dispatched.push({agent,options});if(failure)throw Error('Native child failed');return {text:'Native result',sessionId:uuid,usage:{input_tokens:4}};}});
 handlers.before_agent_start?.({messageType:'user',prompt:'Original user authorized native task',images:[]},ctx);
 return {handlers,entries,tools,ctx,dispatched,routing,commands,notices};
}
test('installing native delegation leaves ordinary Pi execution intact and adds verified capability context',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);
 const context=await f.handlers.before_agent_start({messageType:'user',prompt:'ordinary work',systemPrompt:'Original system rules'},f.ctx);assert.ok(context.systemPrompt.startsWith('Original system rules'));assert.ok(context.systemPrompt.includes('image_generation'));assert.ok(context.systemPrompt.includes('subscription'));assert.ok(!context.systemPrompt.includes('Only summarize'));assert.equal(f.handlers.tool_call,undefined);
 assert.equal(f.dispatched.length,0);assert.ok(f.tools.yam_delegate);
});
test('explicit model tool call delegates once without a second planner or forced summary',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);
 const result=await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'Create the article and cover',requires:['text','image_generation']},undefined,undefined,f.ctx);
 assert.equal(f.dispatched.length,1);assert.match(result.content[0].text,/Native result/);
 assert.equal(result.details.results[0].sessionId,uuid);assert.equal(result.details.error,null);
 assert.equal(f.entries.filter(e=>e.customType==='yam.agent-task.v1').at(-1).data.status,'completed');
 assert.equal(f.handlers.tool_call,undefined);
});
test('explicit delegation fails closed without blocking subsequent ordinary Pi tools',async()=>{
 const f=hostFixture({failure:true});f.handlers.session_start({},f.ctx);
 const result=await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'native task',requires:['text']},undefined,undefined,f.ctx);
 assert.match(result.details.error,/Native child failed/);assert.equal(f.dispatched.length,1);assert.equal(f.handlers.tool_call,undefined);
});
test('parent tool restrictions prevent native delegation and no Pi child is offered',async()=>{
 const f=hostFixture({restricted:true});f.handlers.session_start({},f.ctx);
 const result=await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'write files',requires:['files']},undefined,undefined,f.ctx);
 assert.equal(f.dispatched.length,0);assert.match(result.details.error,/Executor|restric/i);
 const g=hostFixture();g.handlers.session_start({},g.ctx);
 const invalid=await g.tools.yam_delegate.execute('call',{executor:'pi-small',goal:'task',requires:['text']},undefined,undefined,g.ctx);
 assert.equal(g.dispatched.length,0);assert.match(invalid.details.error,/Executor/);
});

test('native delegation preserves the complete real user authorization separately from the model goal',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);
 const prompt='Write the article. '+ 'context '.repeat(400)+'Only edit draft.md. Do not publish.';
 f.handlers.before_agent_start({messageType:'user',prompt,images:[]},f.ctx);
 await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'Write and improve the article',requires:['text']},undefined,undefined,f.ctx);
 const input=f.dispatched[0].options.prompt;assert.ok(input.includes('Only edit draft.md. Do not publish.'));
 const data=JSON.parse(input.slice(input.indexOf('\n')+1));assert.equal(data.originalRequest,prompt);assert.equal(data.goal,'Write and improve the article');
});
test('native delegation failure prevents another backend attempt within the same Pi turn',async()=>{
 const f=hostFixture({failure:true});f.handlers.session_start({},f.ctx);
 await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'task',requires:['text']},undefined,undefined,f.ctx);
 const next=await f.tools.yam_delegate.execute('call',{executor:'claude',goal:'retry task',requires:['text']},undefined,undefined,f.ctx);
 assert.equal(f.dispatched.length,1);assert.match(next.details.error,/stopped|failed|fallback/i);
});
test('delegation preserves historical constraints beyond both excerpt boundaries and final system instructions',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);
 const prior='context '.repeat(250)+'Only edit allowed.md; never publish.';
 f.entries.push({type:'message',message:{role:'user',content:prior}},...Array.from({length:8},(_,i)=>({type:'message',message:{role:'assistant',content:'History '+i}})));
 await f.handlers.before_agent_start({messageType:'user',prompt:'Proceed',systemPrompt:'Earlier system'},f.ctx);
 f.ctx.getSystemPrompt=()=> 'FINAL_DYNAMIC_SCOPE: no external network';
 const result=await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'Update draft',requires:['text']},undefined,undefined,f.ctx);
 assert.equal(result.details.error,null);assert.equal(f.dispatched.length,1);
 assert.ok(f.dispatched[0].options.prompt.includes('Only edit allowed.md; never publish.'));assert.ok(f.dispatched[0].options.prompt.includes('FINAL_DYNAMIC_SCOPE: no external network'));
});
test('too-long delegated context stops instead of silently discarding authorization',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);f.entries.push({type:'message',message:{role:'user',content:'x'.repeat(130000)+'Do not publish.'}});
 await f.handlers.before_agent_start({messageType:'user',prompt:'Proceed'},f.ctx);
 const result=await f.tools.yam_delegate.execute('call',{executor:'codex',goal:'Update draft',requires:['text']},undefined,undefined,f.ctx);
 assert.match(result.details.error,/context|budget|long/i);assert.equal(f.dispatched.length,0);
});
test('rejected resume keeps prior successful tasks resumable after a controller restart',async()=>{
 const first=fixture(plan([task('old','pi-small')]));await first.controller.run({prompt:'first',cwd:'/repo'});
 const follow={...plan([{...task('follow','pi-small'),resume:'old'}]),intent:'continue'};
 const changed=fixture(follow);changed.catalog[0].model='p/other';changed.controller.restore(first.entries);
 const rejected=await changed.controller.run({prompt:'continue',cwd:'/repo'});assert.match(rejected.error,/identity/);
 const restarted=fixture(follow);restarted.controller.restore([...first.entries,...changed.entries]);
 const result=await restarted.controller.run({prompt:'continue',cwd:'/repo'});assert.equal(result.error,null);assert.equal(restarted.calls[0].options.resume,uuid);
});
test('multiple native goals can each resume their successful session across restart',async()=>{
 const f=fixture(request=>request.request==='first'?plan([task('first','pi-small')]):plan([task('second','codex')]));
 await f.controller.run({prompt:'first',cwd:'/repo'});await f.controller.run({prompt:'second',cwd:'/repo'});
 const again=fixture({...plan([{...task('next','pi-small'),resume:'first'}]),intent:'continue'});again.controller.restore(f.entries);
 const result=await again.controller.run({prompt:'continue first goal',cwd:'/repo'});assert.equal(result.error,null);assert.equal(again.calls[0].options.resume,uuid);
});
test('delegated native session IDs are persisted before a failure and exposed in status',async()=>{
 const entries=[],native={id:'codex',kind:'codex',auth:'subscription',capabilities:['text']};
 const controller=api.createOrchestrator({catalog:async()=>[native],classify:async()=>plan([task('running','codex')]),append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){},execute:async(_agent,o)=>{
  o.onLine(JSON.stringify({type:'thread.started',thread_id:uuid}));assert.equal(entries.at(-1).data.sessionId,uuid);assert.equal(controller.getTasks().at(-1).sessionId,uuid);throw Error('interrupted');
 }});
 const result=await controller.run({prompt:'task',cwd:'/repo'});assert.match(result.error,/interrupted/);assert.equal(entries.at(-1).data.status,'failed');assert.equal(entries.at(-1).data.sessionId,uuid);assert.equal(controller.getTasks().at(-1).sessionId,uuid);
});

test('native delegation status is readable while execution is busy but state changes remain blocked',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);
 await f.commands['yam-agents'].handler('status',f.ctx);assert.ok(f.notices.length);
 await assert.rejects(f.commands['yam-agents'].handler('reset',f.ctx),/Wait/);
});
test('new delegated sessions receive historical image context without duplicate current attachments',async()=>{
 const f=fixture(plan([task('cover','codex')])),image={type:'image',mimeType:'image/png',data:'aGVsbG8='};f.catalog[1].capabilities.push('image_input');
 const result=await f.controller.run({prompt:'Use the earlier image',cwd:'/repo',recent:[{role:'user',content:[{type:'text',text:'This is the reference'},image]}],images:[image]});
 assert.equal(result.error,null);assert.deepEqual(f.calls[0].options.images,[image]);
 const historical=fixture(plan([task('cover','codex')]));historical.catalog[1].capabilities.push('image_input');await historical.controller.run({prompt:'Use the earlier image',cwd:'/repo',recent:[{role:'user',content:[image]}]});assert.deepEqual(historical.calls[0].options.images,[image]);
});
test('resumed delegated sessions receive current images without replaying historical attachments',async()=>{
 const old={type:'image',mimeType:'image/png',data:'b2xk'},current={type:'image',mimeType:'image/png',data:'bmV3'};
 const f=fixture(plan([task('first','codex')]));f.catalog[1].capabilities.push('image_input');await f.controller.run({prompt:'initial',cwd:'/repo',images:[old]});
 const next=fixture({...plan([{...task('next','codex'),resume:'first'}]),intent:'continue'});next.catalog[1].capabilities.push('image_input');next.controller.restore(f.entries);
 const result=await next.controller.run({prompt:'continue',cwd:'/repo',recent:[{role:'user',content:[old]}],images:[current]});assert.equal(result.error,null);assert.deepEqual(next.calls[0].options.images,[current]);
});
test('historical images cannot be silently dropped for an incapable executor',async()=>{
 const f=fixture(plan([task('describe','codex')]));const result=await f.controller.run({prompt:'Describe the earlier image',cwd:'/repo',recent:[{role:'user',content:[{type:'image',mimeType:'image/png',data:'eA=='}]}]});
 assert.match(result.error,/image|attachment/i);assert.equal(f.calls.length,0);
});

test('dependent tasks receive complete results and stop before dispatch when the full handoff exceeds budget',async()=>{
 for(const size of [30000,130000]){
  const entries=[],calls=[],text='x'.repeat(size)+'END_OF_DEPENDENCY';
  const controller=api.createOrchestrator({catalog:async()=>[{id:'codex',kind:'codex',auth:'subscription',capabilities:['text']}],classify:async()=>plan([task('first','codex'),{...task('second','codex'),dependsOn:['first']}]),append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){},execute:async(_a,o)=>{calls.push(o);return {text,sessionId:uuid};}});
  const result=await controller.run({prompt:'Use the complete first result',cwd:'/repo'});
  if(size<128000){assert.equal(result.error,null);assert.ok(calls[1].prompt.includes('END_OF_DEPENDENCY'));}else{assert.match(result.error,/budget/);assert.equal(calls.length,1);}
 }
});

test('failed process cleanup keeps delegated execution unknown and blocks fresh delegation after restart',async()=>{
 const entries=[],calls=[];const make=()=>api.createOrchestrator({catalog:async()=>[{id:'codex',kind:'codex',auth:'subscription',capabilities:['text']}],classify:async()=>plan([task('goal','codex')]),append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){},execute:async()=>{calls.push(true);throw Object.assign(Error('Native process may still be running'),{mayBeRunning:true});}});
 const first=make();await first.run({prompt:'Task',cwd:'/repo'});assert.equal(entries.at(-1).data.status,'running');const restored=make();restored.restore(entries);const next=await restored.run({prompt:'Another goal',cwd:'/repo'});assert.match(next.error,/unfinished|unknown/i);assert.equal(calls.length,1);
});

test('classification thrown values remain visible without dispatch or unhandled rejection',async()=>{
 for(const value of ['classifier failed',null]){let calls=0;const controller=api.createOrchestrator({catalog:async()=>[],classify:async()=>{throw value;},execute:async()=>{calls++;},append(){},status(){}});const result=await controller.run({prompt:'Task',cwd:'/repo'});assert.equal(result.error,String(value));assert.equal(calls,0);}
});

test('the advertised delegation goal boundary is accepted and its successor rejected',async()=>{
 const f=hostFixture();f.handlers.session_start({},f.ctx);const tool=f.tools.yam_delegate,max=tool.parameters.properties.goal.maxLength;
 const accepted=await tool.execute('goal-max',{executor:'codex',goal:'a'.repeat(max),requires:['text']},null,null,f.ctx);assert.equal(accepted.details.error,null);assert.equal(f.dispatched.length,1);
 const rejected=await tool.execute('goal-too-long',{executor:'codex',goal:'a'.repeat(max+1),requires:['text']},null,null,f.ctx);assert.ok(rejected.details.error);assert.equal(f.dispatched.length,1);
});
