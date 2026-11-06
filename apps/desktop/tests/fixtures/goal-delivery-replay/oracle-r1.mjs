// Author: Jeff.Liu. Frozen independent repository-replay oracle.
import assert from 'node:assert/strict';import {test} from 'node:test';
const fixtureUrl=__FIXTURE_URL__;
const api=await import(fixtureUrl+'native-codex.mjs');
const {default:install}=await import(fixtureUrl+'router.mjs');
function fixture({answer={intent:'new',difficulty:'simple',uncertain:false,readOnly:true,reason:'read only'},selected='off',state,raw=false,native}={}) {
 // Older policy test cases keep their difficulty shorthand; actual classifier mocks use task facts.
 if(!raw&&answer&&['simple','complex','critical'].includes(answer.difficulty))answer={...answer,task:answer.difficulty==='simple'?'answer':answer.difficulty==='critical'?'review':'coding',context:'independent',action:answer.readOnly===false?'write':'none',depth:answer.difficulty==='critical'?'deep':'normal',readOnly:answer.readOnly??false};
 const handlers={},commands={},renderers={},flags={'yam-small':'p/small','yam-strong':'p/strong'},entries=[],statuses=[];
 const models=Object.fromEntries(['small','strong'].map(id=>[id,{provider:'p',id,reasoning:true,api:'openai-responses',contextWindow:100000,maxTokens:10000,input:['text','image'],thinkingLevelMap:Object.fromEntries(['off','low','medium','high','xhigh','max'].map(v=>[v,v]))}]));
 let classifierCalls=0,definition;
 const pi={registerEntryRenderer:(name,fn)=>renderers[name]=fn,on:(name,fn)=>handlers[name]=fn,registerCommand:(name,v)=>commands[name]=v,registerFlag(){},getFlag:n=>flags[n],registerVirtualModel:v=>{definition=v;models.auto={provider:v.provider,id:v.id,api:"pi-virtual",reasoning:true,thinkingLevelMap:Object.fromEntries(v.thinkingLevels.map(level=>[level,level]))};},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),setModel:async()=>true,setThinkingLevel:v=>selected=v,getThinkingLevel:()=>selected};
 const nativeCalls=[];
 const adapter=native??{resolveModel:(_ctx,m)=>m,stream:(...args)=>{nativeCalls.push(args);return {result:()=>ctx.modelRegistry.complete(...args)};}};
 const ready=install(pi,m=>Object.keys(m.thinkingLevelMap),class Text {constructor(text){this.text=text;}},adapter);
 const ctx={model:{api:'pi-virtual',provider:'yam',id:'auto'},isIdle:()=>true,ui:{setStatus:(...v)=>statuses.push(v),notify(){},select:async()=>null},sessionManager:{getBranch:()=>entries,getSessionFile:()=>null,buildSessionProjection:()=>({})},modelRegistry:{find:(_p,id)=>models[id],getAvailable:()=>Object.values(models),hasConfiguredAuth:()=>true,complete:async()=>{classifierCalls++;if(answer instanceof Error)throw answer;return {content:[{type:'text',text:JSON.stringify(answer)}]};}}};
 ctx.modelRegistry.streamSimple=(...args)=>({result:()=>ctx.modelRegistry.complete(...args)});
 const route=(extra={})=>definition.route({reason:'user',thinkingLevel:selected,messages:[{role:'user',content:'read a file'}],state,...extra},ctx);
 return {pi,route,ctx,handlers,commands,renderers,models,statuses,ready,flags,nativeCalls,get calls(){return classifierCalls;},entries};
}test('routed lightweight native answers stay tool-free after physical catalog re-resolution',async()=>{
 const {createNativeCodex}=api;let bridge;const calls=[],catalog=[];
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
  const {createNativeCodex}=api;let bridge;const calls=[],catalog=[],state={v:2,model:'medium',effort:'high',task:'New explanation B',...marker};
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

test('corrected readonly phases cannot acquire tools from an uncertain continuation',async()=>{
 const routes=[],f=fixture({answer:{intent:'continue',task:'coding',context:'dependent',action:'write',depth:'normal',uncertain:true,readOnly:false,requires:['files']},raw:true,state:{v:2,model:'medium',mode:'readonly',effort:'high'},native:{resolveModel:(_c,m)=>m,setRoute:r=>routes.push(r)}});f.models.medium={...f.models.strong,id:'medium'};f.flags['yam-medium']='p/medium';await f.ready;await f.handlers.session_start({},f.ctx);
 await assert.rejects(f.route(),/capabil/i);assert.equal(routes.length,0);
});
