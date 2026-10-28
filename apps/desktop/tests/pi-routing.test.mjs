import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decide, guardCapacity, resolveEffort} from '../src-tauri/pi/policy.mjs';

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

test('Pi is an independent launch choice with native configuration and no official connection migration',async()=>{
 const {isLaunchDefaults}=await import('../src/project-config.ts');
 const base={adapter:'pi',mode:'interactive',extra_args:'--yam-small native/small --yam-strong native/strong',prompt:null,command:null,provider:null};
 assert.equal(isLaunchDefaults(base),true);
 assert.equal(isLaunchDefaults({...base,provider:{id:'custom',model:'m',base_url:'http://127.0.0.1:3425',api_key_env:null}}),false);
});

import install from '../src-tauri/pi/router.mjs';
function fixture({answer={intent:'new',difficulty:'simple',uncertain:false,reason:'read only'},selected='off',state}={}) {
 const handlers={},commands={},flags={'yam-small':'p/small','yam-strong':'p/strong'},entries=[],statuses=[];
 const models=Object.fromEntries(['small','strong'].map(id=>[id,{provider:'p',id,reasoning:true,api:'openai-responses',contextWindow:100000,maxTokens:10000,input:['text','image'],thinkingLevelMap:Object.fromEntries(['off','low','medium','high','xhigh','max'].map(v=>[v,v]))}]));
 let classifierCalls=0,definition;
 const pi={on:(name,fn)=>handlers[name]=fn,registerCommand:(name,v)=>commands[name]=v,registerFlag(){},getFlag:n=>flags[n],registerVirtualModel:v=>{definition=v;models.auto={provider:v.provider,id:v.id,api:"pi-virtual",reasoning:true,thinkingLevelMap:Object.fromEntries(v.thinkingLevels.map(level=>[level,level]))};},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),setModel:async()=>true,setThinkingLevel:v=>selected=v,getThinkingLevel:()=>selected};
 const ready=install(pi,m=>Object.keys(m.thinkingLevelMap));
 const ctx={model:{api:'pi-virtual',provider:'yam',id:'auto'},isIdle:()=>true,ui:{setStatus:(...v)=>statuses.push(v),notify(){},select:async()=>null},sessionManager:{getBranch:()=>entries},modelRegistry:{find:(_p,id)=>models[id],hasConfiguredAuth:()=>true,complete:async()=>{classifierCalls++;if(answer instanceof Error)throw answer;return {content:[{type:'text',text:JSON.stringify(answer)}]};}}};
 const route=(extra={})=>definition.route({reason:'user',thinkingLevel:selected,messages:[{role:'user',content:'read a file'}],state,...extra},ctx);
 return {pi,route,ctx,handlers,commands,models,statuses,ready,flags,get calls(){return classifierCalls;},entries};
}
test('Pi native virtual routing actually chooses physical model and effort with persisted state',async()=>{
 const f=fixture(),r=await f.route();assert.equal(r.model.id,'small');assert.equal(r.thinkingLevel,'medium');assert.equal(r.state.v,1);assert.equal(f.calls,1);
 const next=await f.route({reason:'continuation',previous:r});assert.equal(next.model,r.model);assert.equal(next.thinkingLevel,'medium');assert.equal(f.calls,1);
 const retry=await f.route({reason:'retry',failed:r});assert.equal(retry.model,r.model);assert.equal(f.calls,1);
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
 globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'codex/model',reasoning:true,context_window:500000,max_output_tokens:128000,reasoning_levels:['low','medium','high','xhigh','max','ultra'],modalities:{input:['text','image']},pricing:{prompt:'0.000002',completion:'0.00001'}}]})});
 try {
  await install({registerFlag(){},on(){},registerCommand(){},registerVirtualModel(){},registerProvider:(id,config)=>providers.push({id,config})},()=>['high']);
  assert.equal(providers.length,1);assert.equal(providers[0].config.models[0].maxTokens,128000);assert.equal(providers[0].config.models[0].contextWindow,500000);
  assert.equal(providers[0].config.models[0].thinkingLevelMap.max,'max');assert.equal(providers[0].config.models[0].thinkingLevelMap.minimal,null);assert.equal(providers[0].config.api,'openai-responses');
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
  await install({on:(k,v)=>handlers[k]=v,registerFlag(){},registerCommand(){},registerVirtualModel:v=>definition=v,setModel:async m=>{selected=m;return true;},getThinkingLevel:()=> 'high',getFlag:()=>undefined},()=>['high']);
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
 assert.equal(f.entries.at(-1).customType,'yam.routing.preferences.v1');
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
 assert.deepEqual(runtime.snapshot().actual,{model:'p/small',effort:'medium',at:123});
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
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await send({token:'a'.repeat(64),generation,action:'reset',revision:1})).ok,false);assert.equal(calls,0);
  assert.equal((await send({token:descriptor.token,generation:'wrong',action:'reset',revision:1})).ok,false);assert.equal(calls,0);
  const catalog=await send({token:descriptor.token,generation,action:'catalog',revision:1});assert.equal(catalog.models[0].key,'p/strong');assert.ok(!JSON.stringify(catalog).includes(descriptor.token));assert.equal(calls,0);
  const applied=await send({token:descriptor.token,generation,action:'reset',revision:1});assert.equal(applied.state.revision,2);assert.equal(calls,1);assert.ok(!JSON.stringify(applied).includes(descriptor.token));
  assert.equal((await send({token:descriptor.token,generation,action:'reset',revision:2,unexpected:true})).ok,false);assert.equal(calls,1);
  await send({token:descriptor.token,generation,action:'set',revision:2,data:{model:'p/模型'}},true);assert.equal(seen.model,'p/模型');
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
 await f.commands['yam-route'].handler('effort off',f.ctx);assert.equal(runtime.snapshot().preferences.effort,'off');assert.equal((await f.route()).thinkingLevel,'off');assert.equal(f.entries.at(-1).data.effort,'off');
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
