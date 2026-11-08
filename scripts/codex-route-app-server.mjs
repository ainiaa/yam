// Author: Jeff.Liu.
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {isNativeSessionId} from '../apps/desktop/src-tauri/pi/agent-executor.mjs';

const RPC_MS=15000;
const TURN_MS=30*60*1000;
const MAX_LINE_BYTES=2*1024*1024;
export const mixedCodexProvider='yam_route';
const mixedProviderKey='model_providers.'+mixedCodexProvider;
const gatewayShellPolicy='shell_environment_policy.ignore_default_excludes';

function mixedProviderConfig(connection,gatewayKey){
 if(connection.native)return {name:'YAM Codex subscription',base_url:'https://chatgpt.com/backend-api/codex',wire_api:'responses',requires_openai_auth:true,supports_websockets:false};
 if(!connection.gateway||!gatewayKey)throw Error('Local gateway connection is unavailable');
 return {name:'YAM local gateway',base_url:connection.baseUrl,wire_api:'responses',env_key:gatewayKey,requires_openai_auth:false,supports_websockets:false};
}

export function codexConnectionArgs(connection,respectSystemProxy,initial,mixed){
 const provider=mixed?mixedCodexProvider:connection.billing==='subscription'?'openai':'yam_api';
 const overrides={model_provider:provider};
 if(initial?.model)overrides.model=initial.model;
 if(initial?.effort)overrides.model_reasoning_effort=initial.effort==='off'?'none':initial.effort;
 if(typeof respectSystemProxy==='boolean')overrides['features.respect_system_proxy']=respectSystemProxy;
 if(mixed){
  overrides.forced_login_method='chatgpt';
  overrides[mixedProviderKey]=mixedProviderConfig(connection,mixed.gatewayKey);
  overrides.thread_unload_delay_secs=0;
  overrides[gatewayShellPolicy]=false;
 }else if(provider==='openai')overrides.forced_login_method='chatgpt';
 else{
  overrides.forced_login_method='api';
  overrides['model_providers.yam_api']={name:'YAM explicit API',base_url:connection.baseUrl,wire_api:'responses',
   env_key:'YAM_PROVIDER_API_KEY',requires_openai_auth:false,supports_websockets:false};
  overrides['shell_environment_policy.exclude']=['YAM_PROVIDER_API_KEY'];
 }
 const toml=value=>Array.isArray(value)?JSON.stringify(value):typeof value==='object'
  ?'{ '+Object.entries(value).map(([key,item])=>key+' = '+JSON.stringify(item)).join(', ')+' }':JSON.stringify(value);
 return Object.entries(overrides).flatMap(([key,value])=>['-c',key+'='+toml(value)]);
}

export async function resumeCodexConnection({threadId,model,effort,connection,gatewayKey,settings,requestBackend,signal}){
 const providerConfig=mixedProviderConfig(connection,gatewayKey);
 const unloadSignal=AbortSignal.any([AbortSignal.timeout(5000),...signal?[signal]:[]]);
 const unsubscribed=await requestBackend('thread/unsubscribe',{threadId},{signal:unloadSignal});
 if(!['unsubscribed','notLoaded'].includes(unsubscribed?.status))throw Error('Codex thread could not be unsubscribed');
 for(;;){
  unloadSignal.throwIfAborted();
  let cursor=null,loaded=false;const seen=new Set();
  do{
   const page=await requestBackend('thread/loaded/list',cursor?{cursor}:{},{signal:unloadSignal});
   if(!Array.isArray(page?.data))throw Error('Codex could not confirm the thread was unloaded');
   loaded=page.data.includes(threadId);cursor=page.nextCursor??null;
   if(cursor&&(typeof cursor!=='string'||seen.has(cursor)||seen.size>=100))throw Error('Invalid Codex loaded thread cursor');
   seen.add(cursor);
  }while(cursor&&!loaded);
  if(!loaded)break;
  await delay(100,undefined,{signal:unloadSignal});
 }
 signal?.throwIfAborted();
 const {cwd,runtimeWorkspaceRoots,approvalPolicy,approvalsReviewer,permissions}=settings;
 const result=await requestBackend('thread/resume',{threadId,model,modelProvider:mixedCodexProvider,excludeTurns:true,
  cwd,runtimeWorkspaceRoots,approvalPolicy,approvalsReviewer,permissions,
  config:{[mixedProviderKey]:providerConfig,[gatewayShellPolicy]:false,model_reasoning_effort:effort==='off'?'none':effort}},{signal});
 if(result?.thread?.id!==threadId||result.modelProvider!==mixedCodexProvider||result.model!==model)throw Error('Codex resumed a different thread, model or provider');
}

export async function openCodexThread({executable,env,cwd,model,connection,resume,signal,respectSystemProxy,catalogOnly=false,readOnly=false,outputSchema}){
 signal?.throwIfAborted();
 const provider=connection.billing==='subscription'?'openai':'yam_api';
 const temporary=readOnly?await mkdtemp('/tmp/yam-codex-classify-'):null;
 if(temporary){cwd=temporary;env={...env,CODEX_HOME:temporary};}
 const args=['app-server','--listen','stdio://',...codexConnectionArgs(connection,respectSystemProxy),...readOnly?['-c','project_doc_max_bytes=0','-c','web_search="disabled"',...['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','image_generation','memories','goals','view_image','browser_use','computer_use'].flatMap(feature=>['--disable',feature])]:[]];
 const child=spawn(executable,args,{cwd,env,detached:true,stdio:['pipe','pipe','ignore']});
 const kill=()=>{
  if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 };
 const stopOnExit=()=>{try{kill();}catch{}};
 process.once('exit',stopOnExit);
 const closed=new Promise(resolve=>child.once('close',()=>{
  process.removeListener('exit',stopOnExit);
  resolve();
 }));
 const pending=new Map();
 let nextId=0,failed,buffer='',onEvent=()=>{};
 const fail=()=>{
  failed??=Error('Codex App Server connection or protocol failed');
  for(const request of pending.values())request.reject(failed);
  onEvent(null);
 };
 const send=message=>{
  if(failed||!child.stdin.writable)throw failed??Error('Codex App Server input unavailable');
  child.stdin.write(JSON.stringify(message)+'\n');
 };
 const request=(method,params,abort,ms=RPC_MS)=>{
  abort?.throwIfAborted();
  const id=++nextId;
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);pending.delete(id);abort?.removeEventListener('abort',interrupt);};
   const rejectRequest=error=>{cleanup();reject(error);};
   const interrupt=()=>rejectRequest(abort.reason);
   const timer=setTimeout(()=>rejectRequest(Error('Codex App Server request timed out')),ms);
   pending.set(id,{method,resolve:value=>{cleanup();resolve(value);},reject:rejectRequest});
   abort?.addEventListener('abort',interrupt,{once:true});
   try{send({id,method,params});}catch(error){rejectRequest(error);}
  });
 };
 child.on('error',fail);
 child.stdin.on('error',fail);
 child.stdout.on('error',fail);
 child.on('close',fail);
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  buffer+=chunk;
  try{
   let newline;
   while((newline=buffer.indexOf('\n'))!==-1){
    if(newline>MAX_LINE_BYTES)throw Error('Oversized App Server response');
    const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
    if(!line.trim())continue;
    const message=JSON.parse(line);
    if(message.method&&message.id!==undefined){
     // Approval and tool callbacks are unavailable in this standalone host.
     send({id:message.id,error:{code:-32601,message:'Client request unsupported'}});
    }else if(message.id!==undefined){
     const waiter=pending.get(message.id);
     if(message.error)waiter?.reject(Error('Codex App Server rejected '+waiter.method));
     else waiter?.resolve(message.result);
    }else onEvent(message);
   }
   if(buffer.length>MAX_LINE_BYTES)throw Error('Oversized App Server response');
  }catch{fail();}
 });
 const close=async()=>{
  fail();
  kill();
  await closed;if(temporary)await rm(temporary,{recursive:true,force:true});
 };
 try{
  await request('initialize',{clientInfo:{name:'yam_route',title:'YAM Auto Route',version:'1.0.0'}},signal);
  send({method:'initialized'});
  if(catalogOnly){
   try{
    const account=await request('account/read',{refreshToken:false},signal);
    if(connection.billing==='subscription'&&account?.account?.type!=='chatgpt')throw Error('Sign in to this Codex connection with ChatGPT');
    let cursor=null;const models=[];
    do{
     const page=await request('model/list',{includeHidden:false,limit:100,cursor},signal);
     if(!Array.isArray(page?.data)||models.length+page.data.length>1000)throw Error('Invalid Codex model catalog');
     models.push(...page.data);cursor=page.nextCursor??null;
     if(cursor&&page.data.length===0)throw Error('Invalid Codex catalog cursor');
    }while(cursor);
    return models;
   }finally{await close();}
  }
  const thread=await request(resume?'thread/resume':'thread/start',{
   ...resume?{threadId:resume,excludeTurns:true}:{ephemeral:readOnly},cwd,model,modelProvider:provider,
   approvalPolicy:'never',sandbox:readOnly?'read-only':'workspace-write',
  },signal);
  const threadId=thread?.thread?.id;
  if(!isNativeSessionId(threadId)||(resume&&resume!==threadId)||thread.model!==model||thread.modelProvider!==provider)
   throw Error('Codex App Server returned a different thread, model or provider');
  return {threadId,close,async run(prompt,effort){
   signal?.throwIfAborted();
   let turnId,terminal,rerouted,text='',interrupting=false,finish,failTurn;
   const completion=new Promise((resolve,reject)=>{finish=resolve;failTurn=reject;});
   const interrupt=()=>{
    if(!turnId||interrupting||terminal)return;
    interrupting=true;
    void request('turn/interrupt',{threadId,turnId}).catch(failTurn);
   };
   const cancelled=()=>{
    interrupt();
    clearTimeout(timer);
    timer=setTimeout(()=>failTurn(Error('Codex turn interruption is unconfirmed')),RPC_MS);
   };
   let timer=setTimeout(()=>{interrupt();failTurn(Error('Codex turn timed out'));},TURN_MS);
   onEvent=message=>{
    if(!message){failTurn(failed);return;}
    const data=message.params;
    if(data?.threadId!==threadId)return;
    if(message.method==='turn/started'&&isNativeSessionId(data.turn?.id)){
     if(turnId&&turnId!==data.turn.id){failTurn(Error('Codex turn identity changed'));return;}
     turnId=data.turn.id;
     if(signal?.aborted||turnId===rerouted)interrupt();
    }
    if(message.method==='model/rerouted'&&data.toModel!==model){
     rerouted=data.turnId;
     if(turnId===rerouted)interrupt();
    }
    if(message.method==='item/completed'&&data.turnId===turnId&&data.item?.type==='agentMessage')
     text=typeof data.item.text==='string'?data.item.text.slice(0,256000):'';
    if(message.method==='turn/completed'&&isNativeSessionId(data.turn?.id)){
     if(turnId&&turnId!==data.turn.id){failTurn(Error('Codex turn identity changed'));return;}
     terminal=data.turn;
     finish(terminal);
    }
   };
   signal?.addEventListener('abort',cancelled,{once:true});
   try{
    const started=request('turn/start',{threadId,input:[{type:'text',text:prompt}],model,effort,...outputSchema?{outputSchema}:{}});
    const acknowledged=started.then(reply=>{
     const id=reply?.turn?.id;
     if(!isNativeSessionId(id)||(turnId&&turnId!==id))throw Error('Codex turn identity unverified');
     turnId=id;
     if(signal?.aborted||turnId===rerouted)interrupt();
    });
    const [,turn]=await Promise.all([acknowledged,completion]);
    if(turn.id!==turnId||rerouted===turnId)throw Error('Codex completion model or turn identity unverified');
    return {status:turn.status,turnId,text};
   }finally{
    clearTimeout(timer);
    signal?.removeEventListener('abort',cancelled);
    onEvent=()=>{};
   }
  }};
 }catch(error){await close();throw error;}
}
