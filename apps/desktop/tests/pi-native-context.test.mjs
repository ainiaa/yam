// Author: Jeff.Liu. Long context handoffs use fake execution, never paid models or GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../src-tauri/pi/handoff-context.mjs';
import {createNativeCodex} from '../src-tauri/pi/native-codex.mjs';
import {createOrchestrator} from '../src-tauri/pi/agent-orchestrator.mjs';
const id='01234567-1234-1234-1234-0123456789ab',old={role:'user',content:'OLD_HISTORY '+ 'x'.repeat(100000),timestamp:1};
const next=[{...old,timestamp:2,usage:{input:999}},{role:'assistant',content:'NEW_CONTEXT '+ 'y'.repeat(40000)},{role:'user',content:'Continue safely'}];
test('semantic checkpoints ignore timestamps but retain tool arguments, images, errors and current system scope',()=>{
 const messages=[{role:'system',content:'old system'},{role:'user',content:'scope',timestamp:1},{role:'assistant',content:[{type:'toolCall',id:'call',name:'write',arguments:{path:'a',content:'x'}}]},{role:'toolResult',toolCallId:'call',toolName:'write',isError:false,content:[{type:'text',text:'done'}]},{role:'user',content:[{type:'image',mimeType:'image/png',data:'eA=='}]}];
 const first=context.handoffContext(messages,null,'old system');const changed=structuredClone(messages);changed[1].timestamp=999;changed[2].usage={input:999};changed[2].content[0].arguments={content:'x',path:'a'};changed.push({role:'user',content:'next'});
 const follow=context.handoffContext(changed,first.checkpoint,'NEW_SCOPE');assert.equal(follow.mode,'incremental');assert.equal(follow.systemChanged,true);assert.equal(follow.messages.length,1);
 for(const edit of [m=>m[1].content='changed',m=>m[2].content[0].arguments.content='z',m=>m[3].isError=true,m=>m[4].content[0].data='eQ==']){const copy=structuredClone(changed);edit(copy);assert.equal(context.handoffContext(copy,first.checkpoint,'NEW_SCOPE').mode,'full');}
 assert.equal(context.handoffContext([{role:'user',content:'compacted'}],first.checkpoint,'scope').mode,'full');
 assert.equal(context.handoffContext(changed,{version:1,count:-1,digest:'invalid'},'scope').mode,'full');
});
test('native continuation sends only new semantic history and full current instructions across large transcripts',async()=>{
 const entries=[],calls=[],m={provider:'openai-codex',id:'model',input:['text'],reasoning:true};
 const pi={getActiveTools:()=>['read','bash','edit','write'],registerProvider(){},registerCommand(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
 const ctx={cwd:'/repo',ui:{setStatus(){}},sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/owned/session.jsonl'},modelRegistry:{getAll:()=>[m]}};
 const bridge=createNativeCodex(pi,{loadModels:async()=>[],getTools:c=>c.tools,getSystemPrompt:c=>c.systemPrompt,discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files']}],execute:async(_a,o)=>{calls.push(o);return {text:'Done',finalText:'Done',sessionId:id};},createStream:()=>{let done;const p=new Promise(r=>done=r);return {push:e=>{if(e.type==='done')done(e.message);if(e.type==='error')done(e.error);},end(){},result:()=>p};}});
 await bridge.initialize(ctx);const model=bridge.resolveModel(ctx,m);bridge.beginTurn(ctx);
 assert.equal((await bridge.stream(model,{messages:[old],systemPrompt:'OLD_SCOPE',tools:[{name:'read'}]},{reasoning:'high'}).result()).stopReason,'stop');
 bridge.beginTurn(ctx);const result=await bridge.stream(model,{messages:next,systemPrompt:'NEW_SCOPE: only allowed.txt',tools:[{name:'read'}]},{reasoning:'high'}).result();
 assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(calls[1].resume,id);assert.ok(!calls[1].prompt.includes('OLD_HISTORY'));assert.ok(calls[1].prompt.includes('NEW_CONTEXT'));assert.ok(calls[1].prompt.includes('NEW_SCOPE'));assert.ok(calls[1].prompt.length<50000);
 bridge.beginTurn(ctx);const changed=structuredClone(next);changed[0].content+='changed';const blocked=await bridge.stream(model,{messages:changed,systemPrompt:'scope',tools:[{name:'read'}]},{reasoning:'high'}).result();assert.equal(blocked.stopReason,'error');assert.match(blocked.errorMessage,/too long|budget/g);assert.equal(calls.length,2);assert.equal(blocked.failure?.category,'context');assert.equal(blocked.failure.dispatch,'not-started');assert.equal(blocked.failure.nextAction,'reduce-context');
});
test('delegated continuation survives restart with incremental history, full current scope and explicit budget failure',async()=>{
 const entries=[],calls=[],agent={id:'codex',kind:'codex',auth:'subscription',capabilities:['text','files','image_input']};let continuation=false;
 const make=()=>createOrchestrator({catalog:async()=>[agent],classify:async()=>({version:1,intent:continuation?'continue':'new',billing:'subscription',reason:'goal',clarification:null,tasks:[{id:continuation?'next':'first',executor:'codex',goal:'Do assigned goal',requires:['text'],dependsOn:[],resume:continuation?'first':null}]}),execute:async(_a,o)=>{calls.push(o);return {text:'Done',sessionId:id};},append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){}});
 let controller=make();assert.equal((await controller.run({prompt:'Initial',cwd:'/repo',recent:[old],systemPrompt:'OLD_SCOPE'})).error,null);continuation=true;controller=make();controller.restore(entries);
 const result=await controller.run({prompt:'Continue',cwd:'/repo',recent:next,systemPrompt:'NEW_SCOPE'});assert.equal(result.error,null);assert.equal(calls[1].resume,id);assert.ok(!calls[1].prompt.includes('OLD_HISTORY'));assert.ok(calls[1].prompt.includes('NEW_CONTEXT'));assert.ok(calls[1].prompt.includes('NEW_SCOPE'));
 const changed=structuredClone(next);changed[0].content+='changed';const blocked=await controller.run({prompt:'Continue',cwd:'/repo',recent:changed});assert.match(blocked.error,/too long|budget/g);assert.equal(calls.length,2);
});

test('delegation forwards new historical images and a compacted replacement without repeating a proven prefix',async()=>{
 const entries=[],calls=[],agent={id:'codex',kind:'codex',auth:'subscription',capabilities:['text','files','image_input']};let target=null,n=0;
 const controller=createOrchestrator({catalog:async()=>[agent],classify:async()=>({version:1,intent:target?'continue':'new',billing:'subscription',reason:'image',clarification:null,tasks:[{id:'t'+(++n),executor:'codex',goal:'Use reference',requires:['text'],dependsOn:[],resume:target}]}),execute:async(_a,o)=>{calls.push(o);return {text:'Done',sessionId:id};},append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){}});
 const image=data=>({type:'image',mimeType:'image/png',data}),a=image('YQ=='),b=image('Yg=='),c=image('Yw=='),first={role:'user',content:[{type:'text',text:'original reference'},a]};
 assert.equal((await controller.run({prompt:'First',cwd:'/repo',recent:[first],images:[a]})).error,null);assert.deepEqual(calls[0].images,[a]);target='t1';
 assert.equal((await controller.run({prompt:'Next',cwd:'/repo',recent:[first,{role:'user',content:[b]}]})).error,null);assert.deepEqual(calls[1].images,[b]);target='t2';
 assert.equal((await controller.run({prompt:'Compacted',cwd:'/repo',recent:[{role:'user',content:[{type:'text',text:'COMPACTED_SCOPE'},c]}]})).error,null);assert.deepEqual(calls[2].images,[c]);assert.ok(calls[2].prompt.includes('COMPACTED_SCOPE'));
});

test('moving reference instructions across image and tool blocks invalidates the semantic prefix',()=>{
 const a={type:'image',mimeType:'image/png',data:'YQ=='},b={type:'image',mimeType:'image/png',data:'Yg=='},text={type:'text',text:'Use the image below as replacement'};
 const original=[{role:'user',content:[a,text,b]}],point=context.handoffContext(original,null,'scope').checkpoint;
 const changed=[{role:'user',content:[a,b,text]},{role:'user',content:'Continue'}];assert.equal(context.handoffContext(changed,point,'scope').mode,'full');
 assert.deepEqual(context.handoffMessage(original[0]).content.map(b=>b.type),['image','text','image']);
});
test('delegated continuation rejects a changed executable before persisting a plan or dispatching',async()=>{
 const entries=[],calls=[],agent={id:'codex',kind:'codex',executable:'/installed/old-codex',auth:'subscription',capabilities:['text']};let resume=null;
 const controller=createOrchestrator({catalog:async()=>[agent],classify:async()=>({version:1,intent:resume?'continue':'new',billing:'subscription',reason:'goal',clarification:null,tasks:[{id:resume?'next':'first',executor:'codex',goal:'goal',requires:['text'],dependsOn:[],resume}]}),execute:async(_a,o)=>{calls.push(o);return {text:'Done',sessionId:id};},append:(customType,data)=>entries.push({type:'custom',customType,data}),status(){}});
 assert.equal((await controller.run({prompt:'First',cwd:'/repo'})).error,null);resume='first';agent.executable='/installed/new-codex';const count=entries.length;
 const result=await controller.run({prompt:'Continue',cwd:'/repo'});assert.match(result.error,/identity|project changed/);assert.equal(entries.length,count);assert.equal(calls.length,1);
});
