#!/usr/bin/env node
// Author: Jeff.Liu.
import {createHash,randomUUID} from 'node:crypto';
import {access,lstat,mkdir,mkdtemp,stat,open as openFile,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {constants,fsyncSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs,isDeepStrictEqual} from 'node:util';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {connect} from 'node:net';
import {createNativeRelay} from './codex-native-routing.mjs';
import {serveControls} from '../apps/desktop/src-tauri/pi/control.mjs';
import {discoverAgents,executeAgent,isNativeSessionId,runProcess,validateAgentPrompt} from '../apps/desktop/src-tauri/pi/agent-executor.mjs';
import {failureOf} from '../apps/desktop/src-tauri/pi/failure.mjs';
import {
 backupKeys,classifierPrompt,classifyCandidates,defaultTierRules,orderedExecutionCandidates,routeFacts,
} from '../apps/desktop/src-tauri/pi/task-rules.mjs';
import {openCodexThread,codexConnectionArgs,mixedCodexProvider,resumeCodexConnection} from './codex-route-app-server.mjs';
import {readCodexPolicy,validateCodexPolicy} from '../apps/desktop/src-tauri/pi/codex-route-config.mjs';

const tiers=['small','medium','strong'];
const enumerated=values=>({type:'string',enum:values});
const factProperties={
 intent:enumerated(['new','continue','unknown']),
 task:enumerated(defaultTierRules.rules.map(rule=>rule.task)),
 context:enumerated(['independent','dependent','insufficient']),
 action:enumerated(['none','read','write','external','unknown']),
 depth:enumerated(['normal','deep']),
 uncertain:{type:'boolean'},readOnly:{type:'boolean'},
 requires:{type:'array',items:enumerated(['text','files','image_input','image_generation'])},
};
const factsSchema={type:'object',properties:factProperties,required:Object.keys(factProperties),additionalProperties:false};
const stickyFields=['cwd','runtimeWorkspaceRoots','approvalPolicy','approvalsReviewer','sandboxPolicy','permissions','disabledPluginIds','serviceTier','summary','collaborationMode','environments'];
const canShareNativeHome=connection=>connection?.native||connection?.gateway;

// The same facts and continuation rule used by Pi; native Codex retains the thread.
export function createCodexTurnRouter({config,connectionName,models,classify,switchConnection,initial={},save=async()=>{},onSettled=async()=>{}}){
 let policy=readCodexPolicy(JSON.stringify(config)),state={v:2,status:'idle',...initial,connectionName},classifying=null,enabled=true;
 let recoveringSwitch=!!initial.connectionSwitch,pendingSettings=null;
 const settings={};
 function rememberSettings(source,patch=false){
  // Native turn requests use null to inherit; only serviceTier supports an explicit null reset.
  for(const key of stickyFields)if(Object.prototype.hasOwnProperty.call(source,key)&&(!patch||source[key]!=null||key==='serviceTier'&&source[key]===null))settings[key]=source[key];
  if(source.sandbox&&typeof source.sandbox==='object')settings.sandboxPolicy=source.sandbox;
  if(source.activePermissionProfile!==undefined)settings.permissions=source.activePermissionProfile?.id?.startsWith(':')?null:source.activePermissionProfile?.id??null;
  else if(source.sandboxPolicy&&!source.permissions)settings.permissions=null;
 }
 const acceptSettings=()=>{if(pendingSettings)rememberSettings(pendingSettings,true);pendingSettings=null;};
 const starts=new Map();let writes=Promise.resolve(),activeRequestId=null,recoveryHistory=null;
 const checkPending=next=>{
  if(next===null||next===undefined)return;
  if(!next||typeof next!=='object'||Array.isArray(next))throw Error('Invalid routing strategy');
  if(Object.keys(next).length===0)return;
  if(typeof next.config!=='string'||typeof next.name!=='string'||!next.name.trim()||next.name.length>80||typeof next.id!=='string'||Object.keys(next).some(key=>!['config','name','id'].includes(key)))throw Error('Invalid routing strategy');
  const checked=readCodexPolicy(next.config);
  if(!sameNativeConnection(policy,checked,connectionName)||switchConnection&&
   (!isDeepStrictEqual(policy.connections,checked.connections)||policy.respectSystemProxy!==checked.respectSystemProxy))throw Error('The strategy changes a prepared Codex connection; start a new session');
 };
 checkPending(state.pendingPolicy);
 const publish=async changes=>{state={...state,...changes};const snapshot=structuredClone(state);writes=writes.then(()=>save(snapshot));await writes;};
 const settle=async()=>{if(!['pending','working','classifying','unknown'].includes(state.status))await onSettled();};
 const recover=async turn=>{
  if(!turn||!['completed','interrupted','failed','inProgress'].includes(turn.status))return false;
  if(state.turnId&&turn.id===state.turnId){await publish({status:turn.status==='inProgress'?'working':turn.status});return true;}
  if(!state.turnId&&state.pendingAfterTurnId!==undefined&&turn.id!==state.pendingAfterTurnId){
   await publish({status:turn.status==='inProgress'?'working':turn.status,turnId:turn.id,requestId:null,pendingRoute:null,previous:null,previousPrompt:'',decision:null,dispatched:null,error:null});return true;
  }
  return false;
 };
 return {
  get state(){return structuredClone(state);},
  filterEvent(message){
   const params=message.params;
   return !state.connectionSwitch||params?.threadId!==state.threadId||
    !(message.method==='thread/closed'||message.method==='thread/settings/updated'||message.method==='thread/status/changed'&&['idle','notLoaded'].includes(params.status?.type));
  },
  setPolicy(next){const checked=readCodexPolicy(JSON.stringify(next));if(!isDeepStrictEqual(policy,checked))state={...state,previous:null,previousPrompt:''};policy=checked;},
  async queuePolicy(next){checkPending(next);await publish({pendingPolicy:next});await settle();},
  async acknowledgeLifecycle(marker){await publish({lifecycleAcknowledged:marker});},
  setEnabled(value){enabled=value===true;},
  async request(message,{signal,respond,requestBackend}={}){
   const params=message.params??{};
   if(['thread/start','thread/resume','thread/fork'].includes(message.method)&&params.ephemeral!==true){
    if(state.threadId&&(message.method!=='thread/resume'||params.threadId!==state.threadId))throw Error('Use YAM New session or Continue to change conversations. The current native session is preserved.');
    if(state.connectionSwitch&&!recoveringSwitch)throw Error('Reopen this Codex session after an unconfirmed connection change');
    starts.set(message.id,{method:message.method,threadId:params.threadId,params});return message;
   }
   if(message.method==='thread/turns/list'&&params.threadId===state.threadId){starts.set(message.id,{method:message.method,threadId:params.threadId,cursor:params.cursor??null,descending:params.sortDirection!=='asc'});return message;}
   if(message.method==='turn/interrupt'&&params.threadId===state.threadId&&classifying){
    classifying.abort(Error('Routing cancelled before task dispatch'));
    respond?.({id:message.id,result:{}});return null;
   }
   if(message.method!=='turn/start'||params.threadId!==state.threadId)return message;
   if(state.connectionSwitch||classifying||['pending','working','unknown'].includes(state.status))throw Error('Inspect the current Codex turn before starting another task');
   activeRequestId=message.id;recoveryHistory=null;
   const nativeModel={model:params.collaborationMode?.settings?.model??params.model??state.nativeModel?.model,effort:params.collaborationMode?.settings?.reasoning_effort??params.effort??state.nativeModel?.effort??null};
   if(nativeModel.effort==='none')nativeModel.effort='off';
   if(!enabled){await publish({status:'pending',requestId:message.id,pendingAfterTurnId:state.turnId??state.pendingAfterTurnId,turnId:null,decision:null,dispatched:null,pendingRoute:{previous:null,previousPrompt:'',nativeModel},error:null});pendingSettings=params;return message;}
   const current=structuredClone(policy),{candidate,connections,rules}=validateCodexPolicy(current),controller=new AbortController();
   classifying=controller;
   const requestSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
   const prompt=(params.input??[]).filter(item=>item.type==='text').map(item=>item.text??'').join('\n');
   const before=structuredClone(state),previous=state.previous;
   let changing=false,switched=false;
   try{
    requestSignal.throwIfAborted();
    await publish({status:'classifying'});
    const fixed=current.model&&current.model!=='auto'?current.model:null;
    const classification=fixed&&current.effort&&current.effort!=='auto'?{answer:null,source:'fixed'}:await classify({policy:current,prompt,previousPrompt:state.previousPrompt??'',previous,signal:requestSignal});
    requestSignal.throwIfAborted();
    const decision=routeFacts(classification.answer,rules,previous);
    const continued=!fixed&&nativeRouteIntent(decision,classification.answer,rules,previous)==='continue'&&previous?.identity;
    const tier=continued?previous.model:decision.selection.model;
    const keys=fixed?[fixed]:continued?[previous.identity]:current.executionGroups.map(group=>group[tier]).filter(Boolean);
    const primary=candidate(keys[0]);
    if(classification.source==='local'&&primary.billing==='paid')throw Error('Classification unavailable; automatic paid dispatch is disabled');
    const effort=current.effort&&current.effort!=='auto'?current.effort:continued&&rules.v===1&&!classification.answer?previous.effort:decision.selection.effort;
    let selected,issue='No compatible execution model';
    for(const option of orderedExecutionCandidates(primary.identity,keys.slice(1),candidate,entry=>entry.billing,primary.billing)){
     if(!option.model)continue;
     const entry=option.model;
     if(entry.connection.name!==connectionName&&(!switchConnection||!canShareNativeHome(connections.get(connectionName))||!canShareNativeHome(entry.connection))){issue='This task requires another Codex connection; the existing thread is preserved. Start a new routed session for that connection.';continue;}
     const available=models.find(model=>model.key===entry.identity);
     if(!available){issue='Codex model unavailable: '+entry.identity;continue;}
     if(!available.levels.includes(effort)){issue='Unsupported reasoning '+effort+' for '+entry.identity;continue;}
     if((params.input??[]).some(item=>['image','localImage'].includes(item.type))&&!available.input?.includes('image')){issue='Selected Codex model does not support image input';continue;}
     selected=entry;break;
    }
    if(!selected)throw Error(issue);
    const next={...params,model:selected.model,effort:effort==='off'?'none':effort};
    if(selected.connection.name!==connectionName){
     const sticky=structuredClone(settings);
     if(!sticky.cwd||sticky.approvalPolicy==null||!sticky.approvalsReviewer||!sticky.sandboxPolicy)throw Error('Codex thread permissions are unavailable; connection was not changed');
     for(const key of stickyFields)if(!['sandboxPolicy','permissions'].includes(key)&&next[key]==null&&(key!=='serviceTier'||next[key]===undefined)&&sticky[key]!==undefined)next[key]=sticky[key];
     if(params.permissions==null&&params.sandboxPolicy==null){
      if(sticky.permissions)next.permissions=sticky.permissions;
      else next.sandboxPolicy=sticky.sandboxPolicy;
     }
     await publish({connectionSwitch:{to:selected.connection.name}});
     requestSignal.throwIfAborted();
     changing=true;
     await switchConnection({threadId:state.threadId,connection:selected.connection,model:selected.model,effort,settings:sticky,requestBackend,signal:requestSignal});
     connectionName=selected.connection.name;switched=true;
     await publish({connectionName,connectionSwitch:null,nativeModel:{model:selected.model,effort}});
    }
    if(next.collaborationMode?.settings)next.collaborationMode={...next.collaborationMode,settings:{...next.collaborationMode.settings,model:selected.model,reasoning_effort:next.effort}};
    await publish({status:'pending',requestId:message.id,pendingAfterTurnId:state.turnId??state.pendingAfterTurnId,turnId:null,dispatched:null,error:null,pendingRoute:{nativeModel:{model:selected.model,effort},previousPrompt:prompt.slice(-4000),
     previous:{v:rules.v,model:tier,effort,identity:selected.identity}},decision:{...decision,model:selected.identity,effort,classificationSource:classification.source,classificationAttempts:classification.attempts??[]}});
    requestSignal.throwIfAborted();
    pendingSettings=next;
    return {...message,params:next};
   }catch(error){
    if(changing&&!switched)await publish({status:'unknown',requestId:null,error:'Codex connection change could not be confirmed. Reopen this session before sending another task.'});
    else if(state.status==='classifying'||state.status==='pending'&&state.requestId===message.id)await publish({...before,...switched?{connectionName,nativeModel:state.nativeModel}:{},connectionSwitch:null,pendingPolicy:state.pendingPolicy,requestId:null,error:error.message});
    throw error;
   }finally{classifying=null;}
  },
  async event(message){
   const start=starts.get(message.id);
   if(start){
    starts.delete(message.id);
    if(start.method==='thread/turns/list'&&start.threadId===state.threadId&&!state.connectionSwitch){
     if(recoveryHistory&&start.descending&&start.cursor===recoveryHistory.cursor){if(await recover(message.result?.data?.[0]))recoveryHistory=null;}
     else if(['pending','working','unknown'].includes(state.status))await recover(message.result?.data?.find(turn=>turn.id===state.turnId));
    }
    const thread=message.result?.thread;
    if(thread?.id){
     if(switchConnection&&message.result.modelProvider!==mixedCodexProvider)throw Error('Codex did not load the prepared mixed connection');
     const same=thread.id===state.threadId;
     rememberSettings(start.params,true);rememberSettings(message.result);
     await publish({threadId:thread.id,...typeof message.result.model==='string'?{nativeModel:{model:message.result.model,effort:message.result.reasoningEffort==='none'?'off':message.result.reasoningEffort??null}}:{},...same?{}:{previous:null,previousPrompt:'',status:'idle',turnId:null,pendingAfterTurnId:thread.turns?.at(-1)?.id??(start.method==='thread/start'?null:undefined)}});
     const last=thread.turns?.at(-1);
     if(same&&recoveringSwitch&&message.result.modelProvider===mixedCodexProvider){
      recoveringSwitch=false;
      await publish({status:'failed',connectionSwitch:null,error:'Codex connection restored. The interrupted submission was not dispatched.'});
     }else if(same&&!state.connectionSwitch&&['pending','working','unknown'].includes(state.status)){
      if(!state.turnId)recoveryHistory={cursor:message.result.turnsBackwardsCursor??null};
      if(await recover(last))recoveryHistory=null;
      else if(!state.turnId&&thread.status?.type==='idle')await publish({status:'failed',requestId:null,pendingRoute:null,previous:null,previousPrompt:'',decision:null,dispatched:null,error:'Codex is idle; check native history for the previous submission before sending again'});
     }
    }
   }
   if(message.id===activeRequestId&&message.error&&state.status==='pending'){pendingSettings=null;await publish({status:'failed',error:'Native Codex rejected this turn before starting',requestId:null,pendingRoute:null});}
   if(message.id===activeRequestId&&state.status==='pending'&&message.result?.turn?.id){
    acceptSettings();
    const turn=message.result.turn;await publish({...state.pendingRoute,pendingRoute:null,turnId:turn.id,status:['completed','interrupted','failed'].includes(turn.status)?turn.status:'working',dispatched:state.decision?{model:state.decision.model,effort:state.decision.effort}:null});
   }
   const params=message.params;
   if(params?.threadId!==state.threadId){await settle();return;}
   if(message.method==='thread/settings/updated'&&params.threadSettings&&!state.connectionSwitch)rememberSettings(params.threadSettings);
   if(message.method==='turn/started'){acceptSettings();await publish({...state.pendingRoute,pendingRoute:null,turnId:params.turn.id,status:'working',dispatched:state.decision?{model:state.decision.model,effort:state.decision.effort}:null});}
   if(message.method==='model/rerouted'&&params.turnId===state.turnId&&typeof params.toModel==='string')await publish({nativeModel:{model:params.toModel,effort:null},dispatched:{model:connectionName+'/'+params.toModel,effort:'unknown',rerouted:true}});
   if(message.method==='turn/completed'&&(!state.turnId||params.turn.id===state.turnId)){acceptSettings();await publish({...state.pendingRoute,...state.status==='pending'&&state.decision?{dispatched:{model:state.decision.model,effort:state.decision.effort}}:{},pendingRoute:null,turnId:params.turn.id,status:params.turn.status});}
   if(message.method==='thread/status/changed'&&params.status?.type==='idle'&&!state.turnId&&!state.connectionSwitch&&['pending','unknown'].includes(state.status))await publish({status:'failed',requestId:null,pendingRoute:null,error:'Codex is idle; check native history for the previous submission before sending again'});
   await settle();
  },
 };
}


function nativeRouteIntent(decision,answer,rules,previous){
 return rules.v===2?decision.intent:previous?.v===1&&(!answer||answer.intent==='unknown')?'continue':answer?.intent;
}

export function sameNativeConnection(config,next,name){
 const before=validateCodexPolicy(config).connections.get(name),after=validateCodexPolicy(next).connections.get(name);
 return !!before&&!!after&&isDeepStrictEqual(before,after);
}
export function nativeConnectionBinding(codex,cwd,connection,home,legacy=false){
 return createHash('sha256').update(JSON.stringify([codex,cwd,legacy?connection:Object.entries(connection).sort(([a],[b])=>a.localeCompare(b)),home])).digest('hex');
}

export function nativeSessionConnection(connections,prior,fallback,initialName){
 const name=prior?.v===2&&prior.threadId?prior.connectionName:initialName;
 if(!name&&!(prior?.v===2&&prior.threadId))return fallback;
 const connection=connections.get(name);
 if(!connection)throw Error('The original Codex connection is unavailable; its thread is preserved');
 return connection;
}

export function nativeInitialModel({connection,selected,effort,snapshot,models}){
 if(!snapshot&&selected.connection.name!==connection.name)throw Error('The original Codex model is unknown; reopen the source session before copying');
 const initial=snapshot??{model:selected.model,effort};
 const model=models.find(row=>row.key===connection.name+'/'+initial.model);
 if(!model)throw Error('The original Codex model is unavailable');
 if(!model.levels.includes(initial.effort))throw Error('The original Codex reasoning level is unsupported or unknown');
 return {model:initial.model,effort:initial.effort};
}

const overlaps=(left,right)=>left===right||left===sep||right===sep||left.startsWith(right+sep)||right.startsWith(left+sep);
async function canonicalOrResolved(path){
 try{return await realpath(path);}catch(error){
  const absolute=resolve(path),parent=dirname(absolute);
  if(error.code!=='ENOENT'||absolute===parent)throw error;
  return join(await canonicalOrResolved(parent),basename(absolute));
 }
}
const defaultCodexHome=()=>join(homedir(),'.codex');
const effectiveCodexHome=()=>process.env.CODEX_HOME??defaultCodexHome();
const protectedCodexHomes=()=>Promise.all([...new Set([defaultCodexHome(),effectiveCodexHome()].filter(Boolean))].map(canonicalOrResolved));
async function privateDirectory(path){
 const info=await lstat(path);
 if(!info.isDirectory()||(info.mode&0o077)||info.uid!==process.getuid?.())
  throw Error('Use an owned, private directory with mode 0700');
 return realpath(path);
}
async function profileEnvironment(connection,connections,protectedPaths=[],session=''){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^YAM_|^CODEX_|^OPENAI_(?:API_KEY|BASE_URL)$/.test(key))delete env[key];
 if(connection.native||connection.gateway){
  env.CODEX_HOME=effectiveCodexHome();
  if(connection.gateway){env.YAM_PROVIDER_API_KEY=connection.apiKeyEnv?process.env[connection.apiKeyEnv]:'yam-local-gateway';if(!env.YAM_PROVIDER_API_KEY)throw Error('Local gateway credential unavailable');}
  return env;
 }
 const home=await privateDirectory(connection.home);
 if([...await protectedCodexHomes(),...protectedPaths,session].some(path=>path&&overlaps(home,path)))
  throw Error('Codex connection must use a separate CODEX_HOME');
 for(const other of connections.values())if(other!==connection&&!other.native&&!other.gateway&&overlaps(home,await canonicalOrResolved(other.home)))
  throw Error('Codex connections must have separate homes');
 if((await readdir(home,{withFileTypes:true})).some(entry=>entry.isSymbolicLink()))
  throw Error('Codex connection home contains a redirected file or directory');
 env.CODEX_HOME=home;
 if(connection.billing==='paid'){
  const credential=process.env[connection.apiKeyEnv];
  if(!credential)throw Error('Explicit paid connection credential unavailable');
  env.YAM_PROVIDER_API_KEY=credential;
 }
 return env;
}

async function localGatewayModels(connection,signal){
 const headers={};if(connection.apiKeyEnv){const key=process.env[connection.apiKeyEnv];if(!key)throw Error('Local gateway credential unavailable');headers.Authorization='Bearer '+key;}
 const response=await fetch(connection.baseUrl+'/models',{headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Local gateway model catalog unavailable ('+response.status+')');
 let bytes=0,raw='';const decoder=new TextDecoder();
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw Error('Local gateway catalog exceeds size limit');raw+=decoder.decode(chunk,{stream:true});}
 const data=JSON.parse(raw+decoder.decode());if(!Array.isArray(data.data)||data.data.length>1000)throw Error('Invalid local gateway model catalog');
 return data.data.filter(row=>typeof row.id==='string'&&row.id.length<=450&&!/^(codex|openai-codex|chatgpt)\//i.test(row.id)).map(row=>({model:row.id,displayName:row.display_name??row.id,
  supportedReasoningEfforts:(Array.isArray(row.reasoning_levels)?row.reasoning_levels:row.reasoning===false?['off']:[]).filter(level=>['none','off','minimal','low','medium','high','xhigh','max','ultra'].includes(level)).map(reasoningEffort=>({reasoningEffort})),inputModalities:row.modalities?.input??['text']}));
}

export async function codexCatalog({config,codex,cwd,probeModel,signal},{inspect=openCodexThread,probe=executeAgent}={}){
 const {connections,candidate}=validateCodexPolicy(config),models=[],warnings=[];
 for(const connection of connections.values()){
  try{
   const env=await profileEnvironment(connection,connections,[cwd]);
   const rows=connection.gateway?await localGatewayModels(connection,signal):await inspect({executable:codex,env,cwd,connection,signal,catalogOnly:true,respectSystemProxy:config.respectSystemProxy});
   for(const row of rows){
    if(typeof row.model!=='string'||!Array.isArray(row.supportedReasoningEfforts))continue;
    const key=connection.name+'/'+row.model;candidate(key);
    models.push({key,cli:'codex',name:row.displayName??row.model,levels:row.supportedReasoningEfforts.map(item=>item.reasoningEffort==='none'?'off':item.reasoningEffort),input:row.inputModalities??['text'],context_window:0,billing:connection.billing==='subscription'?'subscription':'api',source:connection.billing==='subscription'?'chatgpt-subscription':undefined});
   }
  }catch(error){if(signal?.aborted)throw error;warnings.push(connection.name+': '+error.message);}
 }
 let verified;
 if(probeModel){
  const entry=candidate(probeModel),model=models.find(row=>row.key===probeModel);
  if(!model||!model.levels.includes('high'))throw Error('Codex model unavailable or high reasoning unsupported');
  const env=await profileEnvironment(entry.connection,connections,[cwd]);
  let result;
  if(entry.billing==='paid'){
   const thread=await inspect({executable:codex,env,cwd,model:entry.model,connection:entry.connection,signal,readOnly:true,respectSystemProxy:config.respectSystemProxy});
   try{const turn=await thread.run('Reply exactly YAM_MODEL_OK. Do not use tools.','high');result={finalText:turn.status==='completed'?turn.text:''};}finally{await thread.close();}
  }else result=await probe({kind:'codex',auth:'subscription',executable:codex,model:entry.model,thinking:'high',runtimeFeatures:await classifierFeatures(codex,env,config.respectSystemProxy)},
   {prompt:'Reply exactly YAM_MODEL_OK. Do not use tools.',mode:'readonly',signal},(file,args,options)=>runProcess(file,[...args.slice(0,-1),...codexConnectionArgs(entry.connection,config.respectSystemProxy),args.at(-1)],{...options,env}));
  verified={ok:result.finalText.trim()==='YAM_MODEL_OK'};
 }
 return {models,preferred:models.find(model=>model.key.endsWith('/gpt-6.1-sol'))?.key??models[0]?.key??null,warning:warnings.length?warnings.join('; '):null,...verified?{probe:verified}:{}};
}

export async function classifyNativeTurn({policy,prompt,previousPrompt,previous,signal},codex,cwd,session,{classify=classifyCodex,timeout}={}){
 const {candidate,connections,rules}=validateCodexPolicy(policy);
 const input=classifierPrompt(rules)+'\n'+JSON.stringify({request:prompt,previousRequest:previousPrompt,previousRoute:previous});
 return classifyCandidates({keys:prompt.length<=16000?policy.classifiers:[],channel:policy.classifiers.length?candidate(policy.classifiers[0]).billing:undefined,rules,requestSignal:signal,
  classificationBudget:135000,maxAttemptBudget:45000,timeout,resolve:candidate,readResult:text=>typeof text==='string'?{text}:text,
  run:async(entry,attemptSignal)=>{
   try{return await classify({executable:codex,model:entry.model,connection:entry.connection,prompt:input,env:await profileEnvironment(entry.connection,connections,[cwd],session),signal:attemptSignal,respectSystemProxy:policy.respectSystemProxy});}
   catch(error){if(attemptSignal.aborted&&!error.mayBeRunning)return {failure:failureOf(error,{dispatch:'not-started'})};throw error;}
  }});
}

async function classifierFeatures(executable,env,respectSystemProxy){
 if(typeof respectSystemProxy==='boolean')return {respect_system_proxy:respectSystemProxy};
 const [native]=await discoverAgents({codex:executable},(file,args,options)=>runProcess(file,args,{...options,env}));
 return native?.runtimeFeatures;
}

async function classifyCodex({executable,model,connection,prompt,env,signal,respectSystemProxy}){
 if(connection?.billing==='paid'){
  const thread=await openCodexThread({executable,model,connection,env,signal,readOnly:true,outputSchema:factsSchema,respectSystemProxy});
  try{const turn=await thread.run(prompt,'high');if(turn.status!=='completed')throw Error('Gateway classification failed');return turn.text;}finally{await thread.close();}
 }
 const result=await executeAgent({kind:'codex',auth:'subscription',executable,model,thinking:'medium',
  runtimeFeatures:await classifierFeatures(executable,env,respectSystemProxy)},
  {prompt,mode:'readonly',readonlySchema:factsSchema,signal},(file,args,options)=>runProcess(file,
   args,{...options,env}));
 return result.finalText;
}

async function writeState(session,state,signal){
 const temporary=join(session,'.state-'+randomUUID());
 let renamed=false;
 try{
  await writeFile(temporary,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600,flush:true});
  // Pending must survive a crash before native dispatch. A lost completion stays pending.
  const directory=state.status==='pending'||state.connectionSwitch?await openFile(session,'r'):null;
  try{
   // Cancellation and publication are ordered on the same event-loop turn.
   signal?.throwIfAborted();
   renameSync(temporary,join(session,'state.json'));
   renamed=true;
   if(directory)fsyncSync(directory.fd);
  }finally{if(directory)await directory.close();}
 }finally{if(!renamed)await rm(temporary,{force:true});}
}

export async function routeCodex({config,cwd,session,prompt,signal},{classify=classifyCodex,open=openCodexThread}={}){
 if(process.platform==='win32')throw Error('Codex routing requires POSIX process isolation');
 validateAgentPrompt(prompt);
 signal?.throwIfAborted();
 if(!isAbsolute(session??''))throw Error('Use an absolute path for the private routing session');
 const {codex,...policy}=config??{};
 if(typeof codex!=='string'||!isAbsolute(codex))throw Error('Invalid Codex executable');
 const {candidate,connections,rules}=validateCodexPolicy(policy);
 const executable=await realpath(codex);
 await access(executable,constants.X_OK);
 cwd=await realpath(cwd);
 if(!(await lstat(cwd)).isDirectory())throw Error('Invalid working directory');
 const protectedPaths=await protectedCodexHomes();
 // Resolve the parent before creating a directory, including when the parent is a symlink.
 session=join(await realpath(resolve(session,'..')),resolve(session).split(sep).at(-1));
 if([...protectedPaths,cwd].some(path=>overlaps(session,path)))throw Error('Use a private session directory outside Codex homes and the workspace');
 if(await Promise.all([...connections.values()].filter(connection=>!connection.native&&!connection.gateway).map(async connection=>overlaps(session,await canonicalOrResolved(connection.home)))).then(values=>values.some(Boolean)))
  throw Error('Use a session directory separate from connection homes');
 await mkdir(session,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 session=await privateDirectory(session);
 const lock=join(session,'.lock');
 await mkdir(lock,{mode:0o700}).catch(error=>{if(error.code==='EEXIST')throw Error('Routing session is locked; inspect the owning process before retrying');throw error;});
 const statePath=join(session,'state.json');
 let thread;
 try{
  const info=await lstat(statePath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(info&&(!info.isFile()||info.size>8192))throw Error('Invalid routing state file');
  const prior=info?JSON.parse(await readFile(statePath,'utf8')):null;
  if(info&&(!prior||prior.v!==1||!['completed','interrupted','failed'].includes(prior.status)||!isNativeSessionId(prior.threadId)||
   !tiers.includes(prior.tier)||!['medium','high','xhigh','max'].includes(prior.effort)||!Number.isInteger(prior.index)||prior.index<0||prior.index>7))
   throw Error('Routing session is pending or invalid; inspect its Codex thread before starting another task');
  const envFor=connection=>profileEnvironment(connection,connections,[cwd],session);
  const openCandidate=async(entry,resume,env)=>open({executable,env,cwd,model:entry.model,connection:entry.connection,resume,signal,
   respectSystemProxy:config.respectSystemProxy});
  const binding=(entry,env)=>createHash('sha256').update(JSON.stringify([executable,cwd,entry.identity,env.CODEX_HOME,
   entry.billing,entry.connection.baseUrl,entry.connection.apiKeyEnv])).digest('hex');
  let selected,classification,tier,effort,index,identity,previous;
  if(prior){
   previous=candidate(prior.model);
   const env=await envFor(previous.connection);
   if(prior.binding!==binding(previous,env)||prior.billing!==previous.billing)throw Error('Previous execution connection changed; Codex session preserved');
  }
   const classifierInput=classifierPrompt(rules)+'\n'+JSON.stringify({request:prompt,previousRequest:prior?.previousPrompt??'',previousRoute:prior?{tier:prior.tier,effort:prior.effort}:null});
   classification=await classifyCandidates({
    keys:prompt.length<=16000?config.classifiers:[],channel:policy.classifiers.length?candidate(policy.classifiers[0]).billing:undefined,rules,requestSignal:signal,
    classificationBudget:135000,maxAttemptBudget:45000,
    resolve:candidate,readResult:text=>typeof text==='string'?{text}:text,
    run:async(entry,attemptSignal)=>{
     try{
      const env=await envFor(entry.connection);
      return await classify({executable,env,model:entry.model,connection:entry.connection,prompt:classifierInput,signal:attemptSignal,
       respectSystemProxy:config.respectSystemProxy});
     }catch(error){
      const failure=failureOf(error,{dispatch:'not-started'});
      if(attemptSignal.aborted&&!error.mayBeRunning)return {failure};
      throw error;
     }
    },
   });
  const previousRoute=prior?{v:rules.v,model:prior.tier,effort:prior.effort}:undefined;
  const decision=routeFacts(classification.answer,rules,previousRoute);
  ({model:tier,effort}=decision.selection);
  if(config.effort&&config.effort!=='auto')effort=config.effort;
  const fixed=config.model&&config.model!=='auto'?config.model:null;
  const keep=prior&&nativeRouteIntent(decision,classification.answer,rules,previousRoute)==='continue'&&!fixed;
  if(keep)tier=prior.tier;
  if(keep&&rules.v===1&&!classification.answer&&(!config.effort||config.effort==='auto'))effort=prior.effort;
  const keys=fixed?[fixed]:keep?[prior.model]:config.executionGroups.map(group=>group[tier]??'');
  const first=keys.findIndex(Boolean);
  if(first===-1)throw Error('Configure an execution model for the '+tier+' tier');
  const primary=candidate(keys[first]);
  if(classification.source==='local'&&primary.billing==='paid')throw Error('Classification unavailable; automatic paid dispatch is disabled');
  const backups=backupKeys(primary.identity,keys.slice(first+1),true);
  for(const option of orderedExecutionCandidates(primary.identity,backups,candidate,entry=>entry.billing,primary.billing)){
   signal?.throwIfAborted();
   if(!option.model)continue;
   if(previous&&option.model.connection.name!==previous.connection.name)continue;
   try{
    const env=await envFor(option.model.connection);
    thread=await openCandidate(option.model,prior?.threadId??null,env);
    selected=option.model;identity=binding(selected,env);index=keep?prior.index:first+option.index;
    break;
   }catch{signal?.throwIfAborted();}
  }
  if(!thread)throw Error(previous?'The new task requires another connection; the Codex thread is preserved':'No available execution model in the configured '+tier+' billing channel');
  signal?.throwIfAborted();
  const state={v:1,status:'pending',threadId:thread.threadId,model:selected.identity,billing:selected.billing,binding:identity,tier,effort,index,previousPrompt:prompt.slice(-1000)};
  await writeState(session,state);
  try{signal?.throwIfAborted();}catch(error){
   if(prior)await writeState(session,prior);else await rm(statePath);
   throw error;
  }
  let result;
  try{result=await thread.run(prompt,effort);}
  catch{throw Error('Codex dispatch outcome unknown; inspect the owned thread before retrying');}
  if(!['completed','interrupted','failed'].includes(result.status))throw Error('Codex turn outcome unknown; inspect the owned thread before retrying');
  await thread.close();
  thread=null;
  await writeState(session,{...state,status:result.status,turnId:result.turnId});
  if(result.status!=='completed')throw Error('Codex turn '+result.status+'; the confirmed terminal state was saved');
  return {threadId:state.threadId,turnId:result.turnId,model:state.model,billing:state.billing,tier,effort,
   group:String.fromCharCode(65+index),classification:classification?{source:classification.source,attempts:classification.attempts}:null,text:result.text};
 }finally{
  try{await thread?.close();}finally{await rm(lock,{recursive:true});}
 }
}

// Lifecycle ingestion deduplicates by native turn ID; retries never resubmit a model request.
export function createNativeLifecycleBridge({deliver=deliverNative,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),initial=null,acknowledge=async()=>{}}={}){
 let threadId=null,turnId=null,terminal=null,acknowledged=initial,queue=Promise.resolve();
 const send=async(kind,thread,turn,restored=false)=>{
  for(let attempt=0;;attempt++)try{return await deliver(kind,thread,turn,...restored?[undefined,'codex-resume']:[]);}catch(error){if(attempt===2)throw error;await wait(150*(attempt+1));}
 };
 return {sync(state){
  const run=queue.catch(()=>{}).then(async()=>{
   if(!state.threadId)return;
   if(threadId!==state.threadId){await send('SessionStart',state.threadId);threadId=state.threadId;turnId=null;terminal=null;}
   if(!state.turnId||!['working','completed','interrupted','failed'].includes(state.status))return;
   const restored=acknowledged?.threadId===state.threadId&&acknowledged.turnId===state.turnId&&acknowledged.status===state.status;
   if(turnId!==state.turnId){await send('UserPromptSubmit',threadId,state.turnId);turnId=state.turnId;terminal=null;}
   const kind={completed:'TurnComplete',interrupted:'Interrupt',failed:'TurnFailed'}[state.status];
   if(kind&&terminal!==kind){await send(kind,threadId,turnId,restored);const marker={threadId,turnId,status:state.status};await acknowledge(marker);acknowledged=marker;terminal=kind;}
  });queue=run;return run;
 }};
}

async function deliverNative(kind,threadId,turnId,permissionKey,source){
 const address=process.env.YAM_AGENT_ADDRESS,token=process.env.YAM_AGENT_TOKEN;
 if(!address||!token)return;
 if(!/^127\.0\.0\.1:\d+$/.test(address)||!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid YAM event connection');
 await new Promise((resolve,reject)=>{
  const socket=connect({host:'127.0.0.1',port:Number(address.split(':')[1])});let bytes='';
  socket.setTimeout(1500,()=>socket.destroy(Error('YAM event timeout')));socket.on('error',reject);
  socket.on('data',chunk=>{bytes+=chunk;if(bytes.length>128)socket.destroy(Error('Invalid YAM acknowledgement'));});
  socket.on('end',()=>{try{if(JSON.parse(bytes).accepted!==true)throw Error('YAM event not saved');resolve();}catch(error){reject(error);}});
  socket.on('connect',()=>socket.end(JSON.stringify({version:1,token,run:process.env.YAM_AGENT_RUN,
   event:{kind,agent_session_id:threadId,turn_id:turnId??null,...permissionKey?{permission_key:permissionKey}:{},...source?{source}:{}}})));
 });
}

export async function runNativeCodex({codex,cwd,session,config,prompt}){
 config=readCodexPolicy(JSON.stringify(config));codex=await realpath(codex);cwd=await realpath(cwd);
 if(!isAbsolute(session??''))throw Error('Native routing requires an absolute session directory');
 await mkdir(session,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});session=await privateDirectory(session);
 const lock=join(session,'.native-lock');
 try{await mkdir(lock,{mode:0o700});}catch(error){
  if(error.code!=='EEXIST')throw error;
  const owner=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));
  if(!Number.isSafeInteger(owner.pid)||owner.pid<2)throw Error('Invalid routing session lock');
  try{process.kill(owner.pid,0);throw Error('This Codex routing session is already running');}catch(error){if(error.code!=='ESRCH')throw error;}
  await privateDirectory(lock);await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});
 }
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
 let runtime,server,ui,relay,controls,serverClosed,uiClosed,router,revision=0,enabled=true,name=process.env.YAM_CODEX_ROUTE_NAME??'',policyId=null,bridgeError=null;
 const controller=new AbortController(),stop=()=>{controller.abort();ui?.kill('SIGTERM');server?.kill('SIGTERM');};
 const ignoreInterrupt=()=>{};process.on('SIGINT',ignoreInterrupt);process.on('SIGTERM',stop);process.on('SIGHUP',stop);
 const killServer=()=>{if(server?.pid)try{process.kill(-server.pid,'SIGKILL');}catch{}};
 process.on('exit',killServer);
 try{
  const path=join(session,'state.json'),info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(info&&(!info.isFile()||(info.mode&0o077)||info.size>128000))throw Error('Invalid native routing state');
  const prior=info?JSON.parse(await readFile(path,'utf8')):null;
  if(prior&&![1,2].includes(prior.v))throw Error('Unsupported native routing state');
  if(prior&&((prior.threadId? !isNativeSessionId(prior.threadId):prior.status!=='idle')||!['idle','completed','interrupted','failed','pending','working','unknown','classifying'].includes(prior.status)))throw Error('Invalid native routing state identity');
  if(prior?.config)config=readCodexPolicy(JSON.stringify(prior.config));
  const {candidate,connections,rules}=validateCodexPolicy(config);
  const key=prior?.previous?.identity??prior?.model??(config.model&&config.model!=='auto'?config.model:config.executionGroups.map(group=>group[rules.fallback.model]).find(Boolean));
  const catalog=await codexCatalog({config,codex,cwd,signal:controller.signal});
  if(!catalog.models.length)throw Error(catalog.warning??'No native Codex models available');
  const initial=candidate(key),alternatives=config.model&&config.model!=='auto'?[key]:config.executionGroups.map(group=>group[rules.fallback.model]).filter(Boolean);
  let selected=prior?.threadId?initial:alternatives.map(candidate).find(entry=>entry.billing===initial.billing&&catalog.models.some(model=>model.key===entry.identity))??initial;
  const connection=nativeSessionConnection(connections,prior,selected.connection,process.env.YAM_CODEX_ROUTE_CONNECTION);
  const mixed=prior?.threadId?prior.provider===mixedCodexProvider:canShareNativeHome(connection)&&[...connections.values()].some(entry=>entry.native)&&[...connections.values()].some(entry=>entry.gateway);
  if(mixed&&!canShareNativeHome(connection))throw Error('The original Codex connection cannot be restored');
  const provider=mixed?mixedCodexProvider:connection.billing==='subscription'?'openai':'yam_api';
  const initialModel=prior?.threadId?mixed?prior.nativeModel:undefined:nativeInitialModel({connection,selected,models:catalog.models,
   effort:config.effort&&config.effort!=='auto'?config.effort:rules.fallback.effort,
   snapshot:process.env.YAM_CODEX_ROUTE_NATIVE_MODEL?JSON.parse(process.env.YAM_CODEX_ROUTE_NATIVE_MODEL):undefined});
  const env=await profileEnvironment(connection,connections,[cwd],session);
  const serverEnv={...env},gatewayKeys=new Map();
  if(mixed){
   delete env.YAM_PROVIDER_API_KEY;delete serverEnv.YAM_PROVIDER_API_KEY;
   for(const entry of connections.values())if(entry.gateway){
    const credential=entry.apiKeyEnv?process.env[entry.apiKeyEnv]:'yam-local-gateway';
    if(!credential)continue;
    const key=`YAM_ROUTED_GATEWAY_${gatewayKeys.size+1}_KEY`;
    gatewayKeys.set(entry.name,key);serverEnv[key]=credential;
   }
  }
  const binding=nativeConnectionBinding(codex,cwd,connection,env.CODEX_HOME);
  if(prior?.v===2&&![binding,nativeConnectionBinding(codex,cwd,connection,env.CODEX_HOME,true)].includes(prior.binding))throw Error('The Codex connection changed; its original thread is preserved');
  if(prior?.v===1){
   const legacy=createHash('sha256').update(JSON.stringify([codex,cwd,selected.identity,env.CODEX_HOME,selected.billing,connection.baseUrl,connection.apiKeyEnv])).digest('hex');
   if(prior.binding!==legacy)throw Error('The previous Codex connection changed; its original thread is preserved');
  }
  enabled=prior?.enabled??(process.env.YAM_CODEX_ROUTE_ENABLED!=='false');name=prior?.name??name;policyId=prior?.policyId??null;
  runtime=await mkdtemp('/tmp/yam-codex-');
  const socketPath=join(runtime,'server.sock');
  server=spawn(codex,['app-server','--listen','unix://'+socketPath,...codexConnectionArgs(connection,config.respectSystemProxy,initialModel,mixed?{gatewayKey:gatewayKeys.get(connection.name)}:undefined)],{cwd,env:serverEnv,detached:true,stdio:['ignore','ignore','ignore']});
  serverClosed=once(server,'close');void serverClosed.catch(()=>{});server.on('error',()=>{});
  for(let index=0;;index++){
   controller.signal.throwIfAborted();
   if(server.exitCode!==null||index>=300)throw Error('Native Codex App Server did not start');
   if(await stat(socketPath).then(value=>value.isSocket(),()=>false))break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const snapshot=()=>({generation:process.env.YAM_PI_GENERATION,revision,phase:router?.state.status??'starting',enabled,name,policyId,
   pending:router?.state.pendingPolicy==null?null:{name:router.state.pendingPolicy.name??'Routing off',id:router.state.pendingPolicy.id??null},target:router?.state.decision??null,dispatched:router?.state.dispatched??null,error:bridgeError??router?.state.error,threadId:router?.state.threadId??null});
  const save=async state=>{const current=connections.get(state.connectionName);await writeState(session,{...state,config,binding:nativeConnectionBinding(codex,cwd,current,env.CODEX_HOME),enabled,name,policyId,connectionHome:env.CODEX_HOME,provider});revision++;controls?.publish();};
  router=createCodexTurnRouter({config,connectionName:connection.name,models:catalog.models,
   switchConnection:mixed?change=>resumeCodexConnection({...change,gatewayKey:gatewayKeys.get(change.connection.name)}):undefined,
   initial:prior?.v===1?{threadId:prior.threadId,status:prior.status,turnId:prior.turnId,previous:{v:rules.v,model:prior.tier,effort:prior.effort,identity:prior.model}}:prior??{},
   classify:request=>classifyNativeTurn(request,codex,cwd,session),save,onSettled:()=>applyPending()});
  const applyPending=async()=>{
   const pendingPolicy=router.state.pendingPolicy;
   if(!pendingPolicy||['pending','working','classifying','unknown'].includes(router.state.status))return;
   if(pendingPolicy.config){config=readCodexPolicy(pendingPolicy.config);router.setPolicy(config);enabled=true;name=pendingPolicy.name;policyId=pendingPolicy.id;}
   else enabled=false;
   await router.queuePolicy(null);
  };
  controls=await serveControls(process.env.YAM_PI_CONTROL_FILE,process.env.YAM_PI_GENERATION,snapshot,async request=>{
   if(request.revision!==revision)throw Error('Routing changed; refresh before applying');
   if(request.action!=='mode')throw Error('Unsupported native routing control');
   if(request.data?.cancel===true){await router.queuePolicy(null);return;}
   const next=request.data?.policy;
   if(next!==null){
    if(!next||typeof next.config!=='string'||typeof next.name!=='string'||!next.name.trim()||next.name.length>80||typeof next.id!=='string')throw Error('Invalid routing strategy');
   }
   await router.queuePolicy(next===null?{}:{id:next.id,name:next.name,config:next.config});
  },()=>catalog.models);
  const permissions=new Map(),lifecycle=createNativeLifecycleBridge({initial:prior?.lifecycleAcknowledged,acknowledge:marker=>router.acknowledgeLifecycle(marker)});
  const syncLifecycle=async()=>{try{await lifecycle.sync(router.state);bridgeError=null;}catch(error){bridgeError=error.message;throw error;}finally{controls.publish();}};
  let starting=true;
  relay=await createNativeRelay({socketPath:join(runtime,'relay.sock'),backendPath:socketPath,
   filterEvent:message=>router.filterEvent(message),
   onRequest:async(message,context)=>{
    if(message.method==='turn/start'&&message.params?.threadId===router.state.threadId){
     if(mixed&&permissions.size)throw Error('Resolve the pending Codex approval before starting another turn');
     await syncLifecycle();await applyPending();router.setEnabled(enabled);
    }
    if(mixed&&starting&&['thread/start','thread/resume'].includes(message.method)&&message.params?.ephemeral!==true){
     starting=false;
     message={...message,params:{...message.params,modelProvider:provider,...initialModel?.model?{model:initialModel.model}:{}}};
    }
    if(!message.method&&permissions.has(message.id)){
     const permission=permissions.get(message.id);permissions.delete(message.id);
     try{await deliverNative('ToolProgress',router.state.threadId,permission.turnId,permission.key);}catch(error){bridgeError=error.message;controls.publish();}
    }
    try{return await router.request(message,context);}finally{await applyPending();}
   },
   onEvent:async message=>{
    await router.event(message);const state=router.state,params=message.params;
    try{
     await syncLifecycle();
     if(params?.threadId!==state.threadId)return;
     if(message.method==='turn/completed')for(const [id,permission] of permissions)if(permission.turnId===params.turn?.id)permissions.delete(id);
     if(message.id!==undefined&&/requestApproval$/.test(message.method??'')){
      const key='approval-'+String(message.id).replace(/[^A-Za-z0-9_-]/g,'').slice(0,100),turnId=params.turnId??state.turnId;
      permissions.set(message.id,{key,turnId});await deliverNative('PermissionRequest',state.threadId,turnId,key);
     }
    }catch(error){bridgeError=error.message;controls.publish();}
   }});
  const args=['--remote','unix://'+relay.socketPath,'--no-alt-screen','-C',cwd];
  if(prior?.threadId)args.push('resume',prior.threadId);
  if(prompt?.trim()&&!prior?.threadId)args.push(prompt);
  ui=spawn(codex,args,{cwd,env,stdio:'inherit'});uiClosed=once(ui,'close');void uiClosed.catch(()=>{});
  const [code,signal]=await uiClosed;
  if(code!==0)throw Error('Native Codex terminal exited'+(signal?' ('+signal+')':''));
 }finally{
  controller.abort();ui?.kill('SIGTERM');
  await relay?.close();await controls?.close();
  if(server){server.kill('SIGTERM');const timer=setTimeout(killServer,1500);await serverClosed.catch(()=>{});clearTimeout(timer);killServer();}
  if(uiClosed)await Promise.race([uiClosed,new Promise(resolve=>setTimeout(()=>{ui?.kill('SIGKILL');resolve();},1500))]);
  process.off('exit',killServer);process.off('SIGINT',ignoreInterrupt);process.off('SIGTERM',stop);process.off('SIGHUP',stop);
  if(runtime)await rm(runtime,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});
 }
}

async function interactive({codex,cwd,session}){
 const config=readCodexPolicy(process.env.YAM_CODEX_ROUTE_CONFIG),prompt=process.env.YAM_CODEX_ROUTE_PROMPT;
 delete process.env.YAM_CODEX_ROUTE_CONFIG;delete process.env.YAM_CODEX_ROUTE_PROMPT;
 return runNativeCodex({codex,cwd,session,config,prompt});
}

async function main(){
 const {values}=parseArgs({options:{config:{type:'string'},cwd:{type:'string',default:process.cwd()},session:{type:'string'},codex:{type:'string'},interactive:{type:'boolean'},catalog:{type:'boolean'},'probe-model':{type:'string'},help:{type:'boolean'}}});
 if(values.help){console.log('Usage: node scripts/codex-auto-route.mjs --config <json> --session <absolute-dir> [--cwd <project>] < prompt.txt');return;}
 if(values.catalog){
  if(!isAbsolute(values.codex??''))throw Error('Invalid Codex executable');
  const config=JSON.parse(process.env.YAM_CODEX_ROUTE_CONFIG);delete process.env.YAM_CODEX_ROUTE_CONFIG;
  const controller=new AbortController();for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.once(name,()=>controller.abort());
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(values['probe-model']?70000:25000)]);
  console.log(JSON.stringify(await codexCatalog({config,codex:values.codex,cwd:values.cwd,probeModel:values['probe-model'],signal})));return;
 }
 if(values.interactive){
  if(values.config||!isAbsolute(values.codex??'')||!isAbsolute(values.session??''))throw Error('Invalid managed Codex routing launch');
  return interactive(values);
 }
 if(!values.config||!values.session||process.stdin.isTTY)throw Error('Supply --config, --session and a prompt on stdin; use --help for usage');
 const controller=new AbortController();
 for(const name of ['SIGINT','SIGTERM','SIGHUP'])process.on(name,()=>controller.abort(Error('Routing aborted')));
 let prompt='';
 process.stdin.setEncoding('utf8');
 for await(const chunk of process.stdin){
  prompt+=chunk;
  if(prompt.length>128000)throw Error('Prompt exceeds the supported length');
 }
 const config=JSON.parse(await readFile(values.config,'utf8'));
 console.log(JSON.stringify(await routeCodex({config,cwd:values.cwd,session:values.session,prompt,signal:controller.signal})));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(error=>{console.error(error instanceof SyntaxError?'Invalid routing JSON':error.message);process.exitCode=1;});
