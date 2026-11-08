// Author: Jeff.Liu.
import {connect} from 'node:net';
import {isChatGPT} from './native-codex.mjs';
import {basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serveControls} from './control.mjs';
import {efforts,guardCapacity,measureContextBudget,preferCachedModel,weakReadOnlyReply,resolveEffort,splitModel,textOf,publicExcerpt,launchOption} from './policy.mjs';
import {defaultRules,defaultTierRules,validateRules,rulesVersion,routeFacts,classifierPrompt,backupKeys,orderedExecutionCandidates,classifyCandidates} from './task-rules.mjs';
import {nativeError,withFailure,failureOf,projectFailure} from './failure.mjs';
const configType='yam.routing.config.v1',preferencesType='yam.routing.preferences.v1',modeType='yam.routing.mode.v1';
const executionTiers=['small','medium','strong'];
 const rulesType='yam.routing.rules.v1',rulesSchemaType='yam.routing.rules.default-high.v1';
export async function deliver(kind,ctx,turn) {
 const address=process.env.YAM_AGENT_ADDRESS,token=process.env.YAM_AGENT_TOKEN;
 if(!address||!token)return;
 if(!/^127\.0\.0\.1:\d+$/.test(address)||!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid YAM event connection');
 const id=basename(ctx.sessionManager.getSessionFile()??'','.jsonl');
 await new Promise((resolve,reject)=>{
  const socket=connect({host:'127.0.0.1',port:Number(address.split(':')[1])}),chunks=[];
  socket.setTimeout(1000,()=>socket.destroy(Error('YAM event timeout')));
  socket.on('error',reject);socket.on('data',b=>{chunks.push(b);if(Buffer.concat(chunks).length>128)socket.destroy(Error('Invalid YAM acknowledgement'));});
  socket.on('end',()=>{try{if(JSON.parse(Buffer.concat(chunks).toString()).accepted!==true)throw Error('YAM event not accepted');resolve();}catch(e){reject(e);}});
  socket.on('connect',()=>socket.end(JSON.stringify({version:1,token,run:process.env.YAM_AGENT_RUN,event:{kind,agent_session_id:id,turn_id:turn??null}})));
 });
}
function protectSession(pi){
 // YAM's history owns one native file; cross-file transitions use the host's new/continue actions.
 for(const event of ['session_before_switch','session_before_fork'])pi.on(event,(_event,ctx)=>{
  if(process.env.YAM_AGENT_ADDRESS){ctx.ui.notify('Use YAM New session or Continue to change conversations. The current native session is preserved.','warning');return {cancel:true};}
 });
}

function validateLivePolicy(value){
 const allowed=['id','name','v','gateway','small','medium','strong','classifier','classifierFallbacks','classifierBilling','executionFallbacks','model','effort','billing','rules'];
 const validKey=key=>typeof key==='string'&&key.length<=512&&/^[A-Za-z0-9_.-]+\/[^\s\p{Cc}]+$/u.test(key);
 const validateBackups=(primary,keys,allowEmpty=false)=>{
  if(keys!==undefined&&(!Array.isArray(keys)||keys.length>0&&(!validKey(primary)||backupKeys(primary,keys,allowEmpty).length!==keys.length)))throw Error('Invalid routing candidates');
 };
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))
  ||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value.id)||typeof value.name!=='string'||!value.name.trim()||[...value.name].length>80||/[\p{Cc}\p{Cf}]/u.test(value.name)
  ||![1,2].includes(value.v)||value.v===2&&!validKey(value.medium)||value.v===1&&value.medium!==undefined
  ||![value.small,value.strong,value.classifier].every(key=>validKey(key)||key===''&&value.model!=='auto')
  ||value.model!=='auto'&&!validKey(value.model)||!['auto','off','minimal',...efforts].includes(value.effort)
  ||!['configured','subscription'].includes(value.billing)||![undefined,'subscription','api','gateway'].includes(value.classifierBilling)
  ||value.gateway!==null&&typeof value.gateway!=='string')throw Error('Invalid session routing policy');
 validateBackups(value.classifier,value.classifierFallbacks);
 if(value.executionFallbacks!==undefined){
  if(!value.executionFallbacks||typeof value.executionFallbacks!=='object'||Array.isArray(value.executionFallbacks))throw Error('Invalid execution groups');
  for(const [tier,keys] of Object.entries(value.executionFallbacks)){
   if(!executionTiers.includes(tier))throw Error('Invalid execution tier');
   validateBackups(value[tier],keys,true);
  }
 }
 const keys=[value.model,value.small,value.medium,value.strong,value.classifier,...value.classifierFallbacks??[],...Object.values(value.executionFallbacks??{}).flat()].filter(key=>key&&key!=='auto');
 if(keys.some(key=>key.startsWith('yam/'))||!value.gateway&&keys.some(key=>key.startsWith('yam-gateway/')))throw Error('Invalid routing connection');
 if(value.gateway!==null)gatewayUrl(value.gateway);
 const rules=validateRules(value.rules);
 if(rules.v===2&&value.v!==2)throw Error('Three-tier rules require a medium model');
 return structuredClone({...value,rules});
}
function gatewayUrl(endpoint){
 const url=new URL(endpoint);
 if(endpoint.length>2048||url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Gateway requires HTTPS or loopback HTTP without credentials/query');
 return endpoint;
}
function readSessionMode(ctx){
 const entry=ctx.sessionManager.getBranch().findLast(row=>row.type==='custom'&&row.customType===modeType);
 if(!entry)return null;
 const mode=entry.data;
 if(!mode||typeof mode.enabled!=='boolean'||typeof mode.epoch!=='string'||!(/^[a-f0-9-]{36}$/i.test(mode.epoch))
  ||mode.enabled&&(!mode.policy||!mode.preferences)||mode.native!==null&&(!mode.native||typeof mode.native.model!=='string'||!['off','minimal',...efforts].includes(mode.native.effort)))
  throw Error('Saved routing mode is invalid; select a strategy or native model before sending a task');
 if(mode.native)splitModel(mode.native.model);
 return {...mode,policy:mode.policy===null?null:validateLivePolicy(mode.policy)};
}
export default async function install(pi,supportedLevels,Text,native,budgetDependencies) {
 const initiallyEnabled=!(budgetDependencies?.routingOff??(process.env.YAM_PI_ROUTING_OFF==='1'));
 let sessionMode=null,stagedMode=null,pendingMode=null,modeError=null,modeObserver=null,delegationBlock=null;
 const enabled=()=>sessionMode?.enabled??initiallyEnabled;
 const publishMode=()=>{try{modeObserver?.(enabled());}catch{/* Delegation remains gated by the mode if the active tool list cannot be changed. */}};
 const managedModel=model=>model&&['yam','yam-codex','yam-gateway'].includes(model.provider);
 const effectivePolicy=()=>stagedMode?.policy??sessionMode?.policy;
 const currentGateway=(includeStaged=true)=>{
  const staged=includeStaged?stagedMode:null;
  if(!staged&&!enabled())return null;
  const policy=staged?.policy??sessionMode?.policy;
  return policy?policy.gateway:launchOption('--yam-gateway')??null;
 };
 const scopedBranch=ctx=>{
  const branch=ctx.sessionManager.getBranch();
  return branch.slice(branch.findLastIndex(entry=>entry.type==='custom'&&entry.customType===modeType)+1);
 };
 const replyType='yam.reply-model.v1';
 const clean=value=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,256):'';
 const replyEffort=value=>['off','minimal',...efforts].includes(value)?value:'unknown';
 pi.registerEntryRenderer(replyType,(entry,_options,theme)=>{
  const data=entry.data;if(!data||typeof data.messageId!=='string')return;
  const model=clean(data.model)||'模型未记录',effort=replyEffort(data.effort);
  return new Text(theme.fg('dim',`${model} · ${effort==='unknown'?'推理尚未确认':effort}`),0,0);
 });
 // Native turn boundaries place the label after the saved response; custom entries never enter model context.
 pi.on('turn_end',event=>{
  if(!enabled())return;
  const m=event.message;
  if(m?.role!=='assistant'||!Array.isArray(m.content)||!m.content.some(b=>b.type==='text'&&typeof b.text==='string'&&b.text.trim()))return;
  return {entries:[{type:'custom',customType:replyType,data:{messageId:event.messageEntryId,model:clean(m.provider)&&clean(m.model)?`${clean(m.provider)}/${clean(m.model)}`:null,effort:replyEffort(m.thinkingLevel)}}]};
 });
 for(const name of ['yam-small','yam-medium','yam-strong','yam-classifier','yam-classifier-fallbacks','yam-classifier-billing','yam-execution-fallbacks','yam-gateway','yam-fixed-model','yam-effort','yam-rules','yam-billing','yam-setup-model'])pi.registerFlag(name,{description:`YAM routing ${name.slice(4)}`,type:'string'});
 let taskRules=validateRules(defaultRules),preview=null,decision=null,rulesError=false;
 const restoreRules=ctx=>{const branch=scopedBranch(ctx),index=branch.findLastIndex(e=>e.type==='custom'&&e.customType===rulesType),saved=branch[index];taskRules=validateRules(saved?saved.data:(effectivePolicy()?.rules??(pi.getFlag('yam-rules')?JSON.parse(pi.getFlag('yam-rules')):(config(ctx).medium?defaultTierRules:defaultRules))));
  if(saved&&!branch.slice(index+1).some(e=>e.type==='custom'&&e.customType===rulesSchemaType)){const legacy=structuredClone(defaultRules);legacy.rules.find(r=>r.task==='review').effort='max';if(JSON.stringify(taskRules)===JSON.stringify(legacy)){taskRules=validateRules(defaultRules);pi.appendEntry(rulesType,taskRules);}}
  if(!saved)pi.appendEntry(rulesType,taskRules);if(!saved||!branch.slice(index+1).some(e=>e.type==='custom'&&e.customType===rulesSchemaType))pi.appendEntry(rulesSchemaType,{});preview=null;};
 pi.registerFlag('yam-catalog-probe',{description:'YAM read-only model catalog',type:'boolean'});
 pi.registerFlag('yam-runtime-probe',{description:'YAM local routing API check',type:'boolean'});
 let turn=null,lastError=false,gatewayError=null,selectionError=null,restoringSelection=false,context=null,channel=null,changing=false;
 let runtimeError=null,blockedPreferences=null,pendingUserInput=null,failure=null;
 let replyRequest=null,toolsUsed=false,replyUpgraded=false;
 let costMessages=new WeakSet(),streamedModel=null;
 const saveDecision=()=>{if(decision)pi.appendEntry('yam.routing.decision.v1',structuredClone(decision));};
 const checkBudget=(model,messages,executionChained=false)=>{
  if(taskRules.v!==2&&!executionChained)return;
  const budget=measureContextBudget(model,messages,budgetDependencies);
  if(!budget.fits){
   decision??={rule:preferences?.model&&preferences.model!=='auto'?'fixed':'context-guard',ruleVersion:rulesVersion(taskRules),classificationMs:0,classifierCost:0,executionCost:0,correctionCost:0,totalCost:0};
   (decision.rejected??=[]).push({model:`${model.provider}/${model.id}`,reason:budget.reason,budget});saveDecision();
   throw nativeError('context-budget','Local context budget unavailable or exceeded; explicitly compact or split the task. The main model is preserved.');
  }
  return budget;
 };
 const totalCost=()=>{if(decision)decision.totalCost=['classifierCost','executionCost','correctionCost'].every(k=>decision[k]!==null)?decision.classifierCost+decision.executionCost+decision.correctionCost:null;};
 const recordCost=(m,kind)=>{if(!decision||costMessages.has(m))return;costMessages.add(m);const cost=observedCost(m,context?.modelRegistry.find(m.provider,m.model));decision[kind]=decision[kind]===null||cost===null?null:decision[kind]+cost;totalCost();};
 let pricedGatewayModels=new Set(),gatewayRegistered=false;
 const internalThinking=new Set();
 const thinkingId=ctx=>ctx.sessionManager.getBranch().findLast(e=>e.type==='thinking_level_change')?.id;
 const markThinking=(ctx,before)=>{const id=thinkingId(ctx);if(id&&id!==before){internalThinking.add(id);if(internalThinking.size>64)internalThinking.delete(internalThinking.values().next().value);}};
 let revision=0,phase='starting',target=null,actual=null,pendingInput=false,preferences=null,execution=null;
 const changed=()=>{revision++;channel?.publish();};
 const savedPreferences=ctx=>{
  const branch=scopedBranch(ctx),index=branch.findLastIndex(e=>e.type==='custom'&&e.customType===preferencesType),saved=branch[index]?.data??sessionMode?.preferences;
  if(!saved)return saved;
  const later=branch.slice(index+1),thinking=later.findLast(e=>e.type==='thinking_level_change');
  // A later standalone native selection may survive a crash before its extension callback commits.
  return thinking&&!later.some(e=>e.type==='model_change')?{...saved,effort:thinking.thinkingLevel}:saved;
 };
 const currentPreferences=()=>blockedPreferences??(context?.model&&context.model.provider!=='yam'?{model:`${context.model.provider}/${context.model.id}`,effort:pi.getThinkingLevel()}:preferences??{model:'auto',effort:pi.getThinkingLevel()==='off'?'auto':pi.getThinkingLevel()});
 const snapshot=()=>{
  const configured=context?config(context,false):{};
  return {revision,generation:process.env.YAM_PI_GENERATION??'',phase,mode:{
   enabled:enabled(),policyId:sessionMode?.policy?.id??null,policyName:sessionMode?.policy?.name??null,
   pending:pendingMode?(pendingMode.policy?.name??'Do not enable routing'):null,pendingPolicyId:pendingMode?.policy?.id??(pendingMode?'':null),error:modeError,
   nativeModel:sessionMode?.native?.model??(context?nativeSelection(context)?.model:null)??null,
  },config:{small:configured.small??pi.getFlag('yam-small')??'',medium:configured.medium??pi.getFlag('yam-medium')??null,
   strong:configured.strong??pi.getFlag('yam-strong')??'',classifier:configured.classifier??pi.getFlag('yam-classifier')??pi.getFlag('yam-small')??'',gateway:currentGateway(false)},
   diagnostics:{configSource:context&&(sessionMode?.policy||Object.keys(readConfig(context)).length)?'session':'launch',billing:pi.getFlag('yam-billing')==='subscription'||sessionMode?.policy?.billing==='subscription'?'subscription':'configured',execution},
   failure,nativeRecovery:native?.getRecovery?.(context)??null,preferences:currentPreferences(),rules:taskRules,ruleVersion:rulesVersion(taskRules),preview,decision,target,actual,
   error:selectionError?.message??runtimeError,gatewayError:gatewayError?.message??null,pendingInput};
 };
 const readConfig=ctx=>scopedBranch(ctx).findLast(e=>e.type==='custom'&&e.customType===configType)?.data??{};
 const notify=async(kind,ctx)=>{try{await deliver(kind,ctx,turn);}catch{ctx.ui.notify('YAM event connection unavailable; task and native session remain in Pi.','warning');}};
 const config=(ctx,includeStaged=true)=>{
  const stored=readConfig(ctx);
  const saved=(includeStaged?stagedMode?.policy:null)??(Object.keys(stored).length?stored:sessionMode?.policy);
  if(saved)return saved;
  const raw=pi.getFlag('yam-classifier-fallbacks');
  const executionRaw=pi.getFlag('yam-execution-fallbacks');
  let classifierFallbacks;
  if(raw!==undefined)try{classifierFallbacks=JSON.parse(raw);}catch{classifierFallbacks=null;}
  let executionFallbacks;
  if(executionRaw!==undefined)try{executionFallbacks=JSON.parse(executionRaw);}catch{executionFallbacks=null;}
  const classifierBilling=pi.getFlag('yam-classifier-billing');
  return {small:pi.getFlag('yam-small'),...(pi.getFlag('yam-medium')?{medium:pi.getFlag('yam-medium')}:{}),strong:pi.getFlag('yam-strong'),
   classifier:pi.getFlag('yam-classifier')??pi.getFlag('yam-small'),...(raw!==undefined?{classifierFallbacks}:{}),...(classifierBilling!==undefined?{classifierBilling}:{}),...(executionRaw!==undefined?{executionFallbacks}:{})};
 };
 const billingPolicy=()=>{const policy=pi.getFlag('yam-billing')==='subscription'?'subscription':effectivePolicy()?.billing??pi.getFlag('yam-billing')??'configured';if(!['configured','subscription'].includes(policy))throw Error('Invalid billing policy');return policy;};
 const forbiddenGateway=m=>m?.provider==='yam-gateway'&&/^(codex|openai-codex|chatgpt)\//i.test(m.id);
 const find=(ctx,key)=>{
  const [provider,id]=splitModel(key);
  if(provider==='yam-gateway'&&gatewayError)throw gatewayError;
  if(provider==='yam-gateway'&&effectivePolicy()&&!currentGateway())throw Error('Gateway is not configured for the current strategy');
  let m=ctx.modelRegistry.find(provider,id);
  if(forbiddenGateway(m)||provider==='yam-gateway'&&/^(codex|openai-codex|chatgpt)\//i.test(id))throw Error('ChatGPT subscription gateway routes are disabled; select official Codex CLI');
  if(m&&isChatGPT(ctx,m)){
   if(!native)throw Error('Official Codex execution adapter unavailable; no subscription HTTP fallback');
   const issue=native.discoveryFailure?.();if(issue)throw withFailure(Error('Official Codex subscription discovery unavailable; check native login and connection'),issue);
   m=native.resolveModel(ctx,m);
  }
  if(billingPolicy()==='subscription'&&!isChatGPT(ctx,m))throw Error('Subscription-only billing policy forbids API or gateway inference');
  if(!m||m.api==='pi-virtual'||!ctx.modelRegistry.hasConfiguredAuth(m))throw Error(`Routing model unavailable: ${key}. Configure Pi credentials or gateway; no fallback to another model.`);
  return m;
 };
 const effort=(m,desired,selected)=>{try{return resolveEffort({...m,thinkingLevelMap:Object.fromEntries(supportedLevels(m).map(v=>[v,v]))},desired,selected);}catch(error){throw withFailure(error,{code:'capability-unavailable',stage:'preparation',dispatch:'not-started'});}};
 const workingEffort=(m,desired,selected)=>{
  if(preferences?.effort!=='off')return effort(m,desired,selected);
  if(!supportedLevels(m).includes('off'))throw nativeError('capability-unavailable',`Reasoning off is unsupported by ${m.id}; no silent downgrade`);
  return 'off';
 };
 const available=(ctx,key)=>{try{return find(ctx,key);}catch{return null;}};
 const subscriptionKey=(ctx,key)=>{
  if(!key)return false;
  const [provider,id]=splitModel(key),model=ctx.modelRegistry.find(provider,id);
  return ['yam-codex','openai-codex'].includes(provider)||isChatGPT(ctx,model)
   ||!!model&&ctx.modelRegistry.isUsingOAuth?.(model)===true||provider==='openai'&&!model;
 };
 const executionConfig=ctx=>{
  const c=config(ctx),keys=[c.small,c.medium,c.strong].filter(Boolean);
  if(keys.some(key=>/^yam-gateway\/(?:codex|openai-codex|chatgpt)\//i.test(key)))throw Error('ChatGPT subscription gateway routes are disabled; select official Codex CLI');
  if(billingPolicy()==='subscription'&&keys.some(key=>!subscriptionKey(ctx,key)))throw Error('Subscription-only billing policy forbids API or gateway inference');
  return c;
 };
 const mainModel=(ctx,c)=>{
  const strong=firstExecutionModel(ctx,c,'strong');
  if(strong)return strong;
  const medium=taskRules.v===2&&c.medium?firstExecutionModel(ctx,c,'medium'):null;
  if(medium&&(!subscriptionKey(ctx,c.strong)||connection(medium).billing==='subscription'))return medium;
  return find(ctx,c.strong);
 };
 const connection=model=>{
  if(model?.provider==='yam-codex')return {source:'chatgpt-subscription',billing:'subscription'};
  if(model?.provider==='yam-gateway')return {source:'magpie',billing:'gateway'};
  const oauth=model&&context?.modelRegistry.isUsingOAuth?.(model);
  return {source:oauth&&['openai','openai-codex'].includes(model.provider)?'chatgpt-subscription':'pi-native',billing:oauth?'subscription':model?'api':'unknown'};
 };
 const actualReply=m=>({model:`${m.provider}/${m.model}`,effort:m.thinkingLevel??'unknown',at:m.timestamp??Date.now(),...connection(context?.modelRegistry.find(m.provider,m.model)??{provider:m.provider}),...(m.usage?{usage:Object.fromEntries(['input','output','cacheRead','cacheWrite'].filter(k=>Number.isFinite(m.usage[k])&&m.usage[k]>=0).map(k=>[k,m.usage[k]]))}:{})});
 const checkSelection=(ctx,p=currentPreferences())=>{
  const c=p.model==='auto'?executionConfig(ctx):null;
  if(c&&hasExecutionBackups(c))return null;
  const m=c?mainModel(ctx,c):find(ctx,p.model);
  if(!m)return null;
  if(p.effort==='off'){if(!supportedLevels(m).includes('off'))throw Error('Reasoning off is unsupported');}
  else if(p.effort!=='auto')effort(m,p.effort,p.effort);
  return m;
 };
 const catalog=()=>{
  if(!context)return [];
  const models=context.modelRegistry.getAvailable?.()??[];
  const listed=native?.catalogModels?.()??[];
  const official=new Map(listed.map(m=>[m.id,m]));
  const describe=m=>({key:`${m.provider}/${m.id}`,name:m.name??m.id,levels:supportedLevels(m),context_window:m.contextWindow,...connection(m)});
  return [...listed.map(describe),...models.flatMap(m=>{
   if(forbiddenGateway(m)||m.api==='pi-virtual'||m.provider==='yam-codex'||gatewayError&&m.provider==='yam-gateway')return [];
   if(!isChatGPT(context,m))return [describe(m)];
   // Preserve matching saved OAuth keys with official capabilities, without advertising another choice.
   const entry=official.get(m.id);
   return entry?[{...describe(entry),key:`${m.provider}/${m.id}`,legacy_alias:true}]:[];
  })];
 };
 async function applyPreferences(ctx,next,persist=true,publish=true){
  if(rulesError)throw Error('Invalid task rules; restore valid session rules first');
  if(!next||Object.keys(next).some(k=>!['model','effort'].includes(k))||typeof next.model!=='string'||!['auto','off','minimal',...efforts].includes(next.effort))throw Error('Invalid routing preferences');
  const requestedKey=next.model;
  checkSelection(ctx,next);
  if(next.model!=='auto'){const selected=find(ctx,next.model);if(selected.provider==='yam-codex')next={...next,model:`${selected.provider}/${selected.id}`};}
  const automatic=ctx.model?.provider==='yam'&&ctx.model.id==='auto'?ctx.model:ctx.modelRegistry.find('yam','auto');
  if(!automatic)throw Error('YAM router unavailable');
  const before=pi.getThinkingLevel(),beforeEntry=thinkingId(ctx);restoringSelection=true;
  try{
   if((ctx.model?.provider!=='yam'||ctx.model?.id!=='auto')&&!await pi.setModel(automatic))throw Error('YAM router unavailable');
   const level=next.effort==='auto'?'off':next.effort;if(pi.getThinkingLevel()!==level)pi.setThinkingLevel(level);
   if(pi.getThinkingLevel()!==level){pi.setThinkingLevel(before);throw Error('Native reasoning selection changed unexpectedly; the previous level was restored.');}
  }finally{markThinking(ctx,beforeEntry);restoringSelection=false;}
  preferences={model:next.model,effort:next.effort};blockedPreferences=null;if(publish&&(persist||requestedKey!==next.model))pi.appendEntry(preferencesType,preferences);
  selectionError=null;runtimeError=null;failure=null;phase='idle';target=null;decision=null;preview=null;if(publish)changed();
 }
 async function control(request){
  const ctx=context;if(!ctx)throw Error('Pi session is starting');
  if(request.revision!==revision)throw Error('Routing state changed; refresh and try again');
  if(request.action==='mode')return requestMode(ctx,request.data);
  if(request.action==='native-recovery'){if(request.data!==undefined)throw Error('Invalid native recovery request');return;}
  if(!enabled()&&request.action!=='native-reset')throw Error('Enable a routing strategy first');
  if(changing||!ctx.isIdle())throw Error('Wait for the current task to finish before changing routing');
  changing=true;
  try{
   if(request.action==='native-reset'){if(!native?.reset)throw Error('Native recovery unavailable');native.reset(ctx,request.data);runtimeError=null;failure=null;changed();}
   else if(request.action==='set')await applyPreferences(ctx,request.data);
   else if(request.action==='reset')await applyPreferences(ctx,{model:'auto',effort:'auto'});
   else if(request.action==='rules'){
    const next=validateRules(request.data),recovering=rulesError,restore=blockedPreferences??preferences??savedPreferences(ctx)??currentPreferences();
    if(recovering)checkSelection(ctx,restore);
    pi.appendEntry(rulesType,next);pi.appendEntry(rulesSchemaType,{});taskRules=next;preview=null;decision=null;
    if(recovering){rulesError=false;try{await applyPreferences(ctx,restore,!savedPreferences(ctx));}catch(e){blockedPreferences=restore;await stopSelection(ctx,e,restore.effort);throw e;}}
    changed();
   }
   else if(request.action==='preview'){
    const data=request.data;if(!data||typeof data.text!=='string'||!data.text.trim()||data.text.length>4000||Object.keys(data).some(k=>!['text','rules'].includes(k)))throw Error('Invalid preview input');
    const rules=validateRules(data.rules),result=await classify(ctx,[{role:'user',content:data.text}],null,rules);
    const decision=routeFacts(result.answer,rules);preview={...decision,classificationSource:result.source,classificationAttempts:result.attempts,latencyMs:result.latencyMs,cost:result.cost};changed();
   }
   else if(request.action==='retry'){
    await refreshGateway();await ctx.modelRegistry.refresh?.();await native?.initialize?.(ctx);const restore=blockedPreferences??preferences??savedPreferences(ctx)??currentPreferences();
    try{await applyPreferences(ctx,restore,false);}catch(e){await stopSelection(ctx,e,restore.effort);throw e;}
   }else throw Error('Unknown Pi control action');
  }finally{changing=false;}
 }
 function nativeModeIssue(ctx,model){
  if(managedModel(model))return 'Choose a native Pi model before sending a task with routing off';
  if(pi.getFlag('yam-billing')==='subscription'&&!isChatGPT(ctx,model))return 'Subscription-only launch cannot switch to an API model';
  return null;
 }
 const nativeSelection=ctx=>{
  const model=ctx.model;
  return model&&model.api!=='pi-virtual'&&!managedModel(model)
   ?{model:`${model.provider}/${model.id}`,effort:pi.getThinkingLevel()}:null;
 };
 async function setPhysicalSelection(ctx,model,level){
  const beforeEntry=thinkingId(ctx);
  restoringSelection=true;
  try{
   if(!await pi.setModel(model))throw Error('Selected Pi model is unavailable');
   if(pi.getThinkingLevel()!==level)pi.setThinkingLevel(level);
   if(pi.getThinkingLevel()!==level)throw Error('Selected Pi reasoning level is unavailable');
  }finally{markThinking(ctx,beforeEntry);restoringSelection=false;}
 }
 async function restoreNativeSelection(ctx,requested,remembered){
  const settings=pi.getSettings?.();
  const defaults=settings?.defaultProvider&&settings?.defaultModel?`${settings.defaultProvider}/${settings.defaultModel}`:null;
  const current=nativeModeIssue(ctx,ctx.model)?null:nativeSelection(ctx),selection=remembered??current;
  const key=requested??selection?.model??defaults;
  if(!key)throw Error('Choose a native Pi model before disabling routing');
  const [provider,id]=splitModel(key),model=ctx.modelRegistry.find(provider,id);
  if(!model||model.api==='pi-virtual'||['yam','yam-codex','yam-gateway'].includes(provider)||!ctx.modelRegistry.hasConfiguredAuth(model))
   throw Error('Native Pi model is unavailable; choose another model');
  if(pi.getFlag('yam-billing')==='subscription'&&!isChatGPT(ctx,model))throw Error('Subscription-only launch cannot switch to an API model');
  const levels=supportedLevels(model),desired=selection?.model===key?selection.effort:settings?.defaultThinkingLevel;
  if(selection?.model===key&&!levels.includes(desired))throw Error('Native Pi reasoning is unavailable; select another native model');
  const level=levels.includes(desired)?desired:levels.includes('off')?'off':levels[0];
  if(!level)throw Error('Native Pi model has no supported reasoning level');
  await setPhysicalSelection(ctx,model,level);
  return {model:key,effort:level};
 }
 function currentLivePolicy(ctx){
  const selected=currentPreferences(),configured=config(ctx),old=sessionMode?.policy;
  try{return validateLivePolicy({
   ...configured,id:old?.id??'session-launch',name:old?.name??'Current launch policy',v:configured.medium?2:1,
   small:configured.small??'',strong:configured.strong??'',classifier:configured.classifier??'',
   gateway:currentGateway(),rules:taskRules,model:selected.model,effort:selected.effort,billing:billingPolicy(),
  });}catch{return old??null;}
 }
 function ensureModeSafe(ctx){
  const recovery=native?.getRecovery?.(ctx);
  if(recovery?.inProgress||recovery?.needsInspection)throw Error('Inspect the previous native task before switching routing');
  if(delegationBlock?.())throw Error('Inspect the previous delegated task before switching routing');
 }
 function cancelPendingMode(){
  if(!pendingMode)return false;
  pendingMode=null;modeError=null;changed();return true;
 }
 async function requestMode(ctx,data){
  if(data?.cancel===true&&Object.keys(data).length===1){cancelPendingMode();return;}
  if(!data||Object.keys(data).some(key=>!['policy','nativeModel'].includes(key))||!Object.hasOwn(data,'policy')
   ||data.nativeModel!==undefined&&(data.policy!==null||typeof data.nativeModel!=='string'))throw Error('Invalid session routing mode');
  if(data.nativeModel!==undefined)splitModel(data.nativeModel);
  const request={policy:data.policy===null?null:validateLivePolicy(data.policy),nativeModel:data.nativeModel};
  if(changing)throw Error('Wait for the current routing change');
  if(turn||!ctx.isIdle()){pendingMode=request;modeError=null;changed();return;}
  await applyMode(ctx,request);
 }
 async function applyMode(ctx,request){
  changing=true;pendingMode=null;modeError=null;
  const before={mode:sessionMode,model:ctx.model,effort:pi.getThinkingLevel(),preferences,rules:taskRules,rulesError,selectionError,blockedPreferences,runtimeError,failure,phase,target,decision,preview,actual,gateway:currentGateway()};
  try{
   ensureModeSafe(ctx);
   const on=request.policy!==null;
   if(!on&&!enabled()&&!request.nativeModel){changed();return;}
   const remembered=sessionMode?.native??null,currentNative=nativeSelection(ctx);
   const next={enabled:on,policy:request.policy??currentLivePolicy(ctx),native:enabled()?remembered??currentNative:currentNative??remembered,epoch:randomUUID()};
   if(on){
    stagedMode=next;
    await native?.initialize?.(ctx);
    if(before.gateway!==currentGateway()||!enabled())await refreshGateway();
    const {policy}=next;
    const keys=[policy.small,policy.medium,policy.strong,policy.classifier,...policy.classifierFallbacks??[],...Object.values(policy.executionFallbacks??{}).flat(),policy.model==='auto'?null:policy.model].filter(Boolean);
    if(billingPolicy()==='subscription'&&keys.some(key=>!subscriptionKey(ctx,key)))throw Error('Subscription-only billing policy forbids API or gateway inference');
    taskRules=policy.rules;rulesError=false;
    await applyPreferences(ctx,{model:policy.model,effort:policy.effort},false,false);
    next.preferences=preferences;
   }else{
    next.native=await restoreNativeSelection(ctx,request.nativeModel,next.native);
    preferences=null;blockedPreferences=null;selectionError=null;runtimeError=null;failure=null;
   }
   pi.appendEntry(modeType,next);
   sessionMode=next;stagedMode=null;if(!on){clearGateway();gatewayError=null;}replyRequest=null;decision=null;preview=null;target=null;actual=null;execution=null;phase='idle';
  }catch(error){
   const gatewayChanged=before.gateway!==currentGateway();
   sessionMode=before.mode;stagedMode=null;
   ({preferences,rules:taskRules,rulesError,selectionError,blockedPreferences,runtimeError,failure,phase,target,decision,preview,actual}=before);
   if(gatewayChanged)await refreshGateway();
   if(before.model&&(ctx.model!==before.model||pi.getThinkingLevel()!==before.effort)){
    try{await setPhysicalSelection(ctx,before.model,before.effort);}
    catch{selectionError={message:'Previous model could not be restored; inspect the native selection before sending a task.'};phase='error';}
   }
   modeError=String(error.message??error).slice(0,1000);changed();throw error;
  }finally{changing=false;}
  publishMode();changed();
 }
 const classifierTimeout=budgetDependencies?.classifierTimeout??(ms=>AbortSignal.timeout(ms));
 const classifierFallbacks=configured=>backupKeys(configured.classifier,configured.classifierFallbacks);
 const executionBackups=(configured,tier)=>backupKeys(configured[tier],configured.executionFallbacks?.[tier],true);
 const hasExecutionBackups=configured=>executionTiers.some(tier=>executionBackups(configured,tier).some(Boolean));
 function classifierChannel(ctx,key,legacy=false){
  if(legacy&&key?.startsWith('openai/')||subscriptionKey(ctx,key))return 'subscription';
  if(key?.startsWith('yam-gateway/'))return 'gateway';
  if(!key)return null;
  const [provider,id]=splitModel(key),model=ctx.modelRegistry.find(provider,id);
  return model?connection(model).billing:null;
 }
 function* executionCandidates(ctx,configured,tier){
  const primary=configured[tier];
  if(!primary)return;
  const backups=executionBackups(configured,tier);
  const channel=backups.some(Boolean)?classifierChannel(ctx,primary):null;
  yield* orderedExecutionCandidates(primary,backups,key=>available(ctx,key),model=>connection(model).billing,channel);
 }
 function firstExecutionModel(ctx,configured,tier){
  for(const candidate of executionCandidates(ctx,configured,tier))if(candidate.model)return candidate.model;
  return null;
 }
 const executionKey=model=>model?`${model.provider}/${model.id}`:null;
 function boundModel(ctx,key,billing){
  const model=key?available(ctx,key):null;
  if(!model||executionKey(model)!==key)throw nativeError('capability-unavailable','Previous execution model unavailable; main session preserved.');
  const channel=billing??classifierChannel(ctx,key,true);
  if(channel&&connection(model).billing!==channel)throw nativeError('capability-unavailable','Previous execution model billing changed; main session preserved.');
  return model;
 }
 async function classify(ctx,messages,previous,rules,requestSignal,classifierKey){
  const started=Date.now(),text=textOf(messages.findLast(m=>m.role==='user'));
  const configured=config(ctx),primary=classifierKey??configured.classifier;
  const channel=billingPolicy()==='subscription'?'subscription':classifierKey===undefined
   ?configured.classifierBilling??classifierChannel(ctx,primary,true):classifierChannel(ctx,primary);
  const keys=classifierKey===undefined?[primary,...classifierFallbacks(configured)]:[primary];
  const costs=[];
  const transcript={systemPrompt:classifierPrompt(rules),messages:[{role:'user',content:JSON.stringify({
   request:text,previousTask:previous?.task,recent:publicExcerpt(messages),
   truncated:messages.length>6||messages.some(m=>textOf(m).length>1200)
  }),timestamp:Date.now()}]};
  const result=await classifyCandidates({
   keys:text.length>16000||!primary?[]:keys,channel,rules,requestSignal,timeout:classifierTimeout,
   resolve(key){
    const model=find(ctx,key);
    return {model,billing:connection(model).billing,identity:model.provider+'/'+model.id,waitForCleanup:isChatGPT(ctx,model)};
   },
   run(candidate,signal){
    const {model,waitForCleanup}=candidate;
    candidate.costIndex=costs.push(null)-1;
    const stream=waitForCleanup?native.stream.bind(native):ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry);
    return stream(model,transcript,{signal,maxTokens:512,reasoning:effort(model,'medium','off'),toolChoice:'none'}).result();
   },
   readResult(result,candidate){
    costs[candidate.costIndex]=observedCost(result,candidate.model);
    const category=result.failure?.category;
    return result.stopReason&&result.stopReason!=='stop'
     ?{status:category==='auth'||category==='quota'?category:'provider-error'}:{text:textOf(result)};
   },
  });
  return {...result,subscription:channel==='subscription',latencyMs:Date.now()-started,
   cost:costs.length&&costs.every(Number.isFinite)?costs.reduce((sum,cost)=>sum+cost,0):null};
 }
 function observedCost(message,model){
  if(connection(model).billing==='subscription')return null;
  const keys=['input','output','cacheRead','cacheWrite'],quoted=model?.provider==='yam-gateway'?pricedGatewayModels.has(model.id):model?.cost&&keys.every(k=>Number.isFinite(model.cost[k])&&model.cost[k]>=0),u=message?.usage?.cost;
  return quoted&&u&&keys.every(k=>Number.isFinite(u[k])&&u[k]>=0)?keys.reduce((sum,k)=>sum+u[k],0):null;
 }
 async function setupGateway(endpoint) {
  if(!endpoint)return;
  gatewayUrl(endpoint);
  const response=await fetch(endpoint.replace(/\/$/,'')+'/v1/models',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`Gateway catalog unavailable (${response.status})`);
  const catalog=await response.json();
  // A missing quote is unknown, not a free cache hit. Keep the native model catalog compatible.
  pricedGatewayModels=new Set((catalog.data??[]).filter(m=>['prompt','completion','input_cache_read'].every(key=>{
   const value=m.pricing?.[key];return ['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
  })).map(m=>m.id));
  // Subscription routes belong to the official CLI; this optional catalog is for API routes.
  const models=(catalog.data??[]).filter(m=>!forbiddenGateway({provider:'yam-gateway',id:m.id})&&typeof m.id==='string'&&m.id.length>0&&`yam-gateway/${m.id}`.length<=512&&Number.isFinite(m.context_window)&&m.context_window>0&&Number.isFinite(m.max_output_tokens)&&m.max_output_tokens>0&&(!m.modalities?.input||m.modalities.input.includes('text'))).map(m=>({
   id:m.id,name:m.display_name??m.id,api:'openai-completions',reasoning:m.reasoning===true,input:m.modalities?.input??['text'],contextWindow:m.context_window,maxTokens:m.max_output_tokens,
   cost:{input:Number(m.pricing?.prompt??0)*1e6,output:Number(m.pricing?.completion??0)*1e6,cacheRead:Number(m.pricing?.input_cache_read??0)*1e6,cacheWrite:0},
   thinkingLevelMap:{off:m.reasoning===true?['none','off'].find(v=>(m.reasoning_levels??[]).includes(v))??null:'off',...Object.fromEntries(['minimal',...efforts].map(v=>[v,(m.reasoning_levels??[]).includes(v)?v:null]))}
  }));
  if(!models.length)throw Error('Gateway has no compatible text models');
  pi.registerProvider('yam-gateway',{baseUrl:endpoint.replace(/\/$/,'')+'/v1',api:'openai-completions',apiKey:'yam-local-gateway',models});
  gatewayRegistered=true;
 }
 function clearGateway(){
  pricedGatewayModels=new Set();
  if(!gatewayRegistered)return;
  try{pi.unregisterProvider?.('yam-gateway');gatewayRegistered=false;}catch{/* A blocked gateway remains unavailable to routing. */}
 }
 async function refreshGateway(){
  try{
   const endpoint=currentGateway();
   if(endpoint)await setupGateway(endpoint);else clearGateway();
   gatewayError=null;
  }catch{
   clearGateway();
   gatewayError=Error('Magpie gateway model catalog unavailable. Check the gateway; Pi native models remain available.');
  }
 }
 async function stopSelection(ctx,message,requested) {
  failure=failureOf(message,{stage:'preparation',dispatch:'not-started'});message=String(message?.message??message);
  selectionError={message,effort:requested};phase='error';changed();const beforeEntry=thinkingId(ctx);restoringSelection=true;
  try {
   const automatic=ctx.modelRegistry.find('yam','auto');
   if(automatic)await pi.setModel(automatic);
   if(efforts.includes(requested))pi.setThinkingLevel(requested);
  } finally {markThinking(ctx,beforeEntry);restoringSelection=false;}
  ctx.ui.notify(message,'error');
 }
 const rememberSelection=(ctx,model)=>{context=ctx;preferences={model:model.provider==='yam'&&model.id==='auto'?'auto':`${model.provider}/${model.id}`,effort:pi.getThinkingLevel()};pi.appendEntry(preferencesType,preferences);blockedPreferences=null;selectionError=null;phase='idle';target=null;changed();};
 pi.on('thinking_level_select',(event,ctx)=>{if(enabled()&&!restoringSelection&&!internalThinking.has(thinkingId(ctx))&&pi.getThinkingLevel()===event.level){context=ctx;const prior=ctx.model?.provider==='yam'?(savedPreferences(ctx)??{model:'auto'}):{model:`${ctx.model.provider}/${ctx.model.id}`};const next={...prior,effort:event.level};preferences=next;pi.appendEntry(preferencesType,next);selectionError=null;changed();}});
 pi.on('model_select',async(event,ctx)=>{
  if(restoringSelection||event.source==='restore'||!event.previousModel)return;
  if(!enabled()){
   const issue=nativeModeIssue(ctx,event.model);
   if(issue){
    restoringSelection=true;
    try{await pi.setModel(event.previousModel);}finally{restoringSelection=false;}
    ctx.ui.notify(issue,'warning');
   }else selectionError=null;
   changed();return;
  }
  if(isChatGPT(ctx,event.model)||billingPolicy()==='subscription'||forbiddenGateway(event.model)){
   try{await applyPreferences(ctx,{model:`${event.model.provider}/${event.model.id}`,effort:pi.getThinkingLevel()});}
   catch(e){blockedPreferences={model:`${event.model.provider}/${event.model.id}`,effort:pi.getThinkingLevel()};await stopSelection(ctx,e,blockedPreferences.effort);}
   return;
  }
  if(event.model.provider==='yam-gateway'&&gatewayError){blockedPreferences={model:`${event.model.provider}/${event.model.id}`,effort:pi.getThinkingLevel()};await stopSelection(ctx,gatewayError.message,blockedPreferences.effort);return;}
  const branch=ctx.sessionManager.getBranch();
  const index=branch.findLastIndex(e=>e.type==='model_change');
  const beforeSwitch=branch.slice(0,index<0?0:index),prior=beforeSwitch.findLast(e=>e.type==='custom'&&e.customType===preferencesType)?.data;
  const locked=selectionError?.effort??beforeSwitch.findLast(e=>e.type==='thinking_level_change')?.thinkingLevel??(prior?.effort!=='auto'?prior?.effort:undefined);
  const explicitOff=locked==='off'&&(prior?.effort==='off'||event.previousModel.provider!=='yam');
  if(!['minimal',...efforts].includes(locked)&&!explicitOff){rememberSelection(ctx,event.model);return;}
  const beforeEntry=thinkingId(ctx);
  restoringSelection=true;
  try {
   if(supportedLevels(event.model).includes(locked)) {
    pi.setThinkingLevel(locked);
    if(pi.getThinkingLevel()===locked){rememberSelection(ctx,event.model);return;}
   }
   if(!await pi.setModel(event.previousModel))throw Error('Previous model unavailable');
   pi.setThinkingLevel(locked);
   if(pi.getThinkingLevel()!==locked)throw Error('Previous reasoning unavailable');
   preferences=prior??{model:event.previousModel.provider==='yam'?'auto':`${event.previousModel.provider}/${event.previousModel.id}`,effort:locked};pi.appendEntry(preferencesType,preferences);blockedPreferences=null;selectionError=null;phase='idle';changed();
   ctx.ui.notify(`Selected model cannot keep reasoning ${locked}; previous selection restored.`,'warning');
  }catch {restoringSelection=false;await stopSelection(ctx,'Model selection cannot preserve the reasoning lock; choose a compatible model.',locked);}
  finally {markThinking(ctx,beforeEntry);restoringSelection=false;}
 });
 const exitLocally=ctx=>{if(!ctx.isIdle())ctx.abort();ctx.shutdown();};
 pi.registerCommand('exit',{description:'退出 Pi 并返回终端 Shell',handler:async(args,ctx)=>{
  if(args.trim()){ctx.ui.notify('Use /exit without arguments.','warning');return;}
  exitLocally(ctx);
 }});
 pi.on('input',(event,ctx)=>{
  if(event.source==='interactive'&&!event.images?.length&&['exit','quit'].includes(event.text.trim().toLowerCase())){exitLocally(ctx);return {action:'handled'};}
  let issue=selectionError?.message;
  if(!issue&&!enabled())issue=nativeModeIssue(ctx,ctx.model);
  if(!issue&&!changing&&ctx.model?.provider==='yam')try{checkSelection(ctx);}catch(error){issue=error.message;}
  if(issue||changing||pendingMode||gatewayError&&ctx.model?.provider==='yam-gateway'){
  pendingUserInput={text:event.text,images:event.images};
  if(event.source==='interactive'&&event.text&&!ctx.ui.getEditorText?.())ctx.ui.setEditorText?.(event.text);
  pendingInput=true;changed();ctx.ui.notify(issue??(ctx.model?.provider==='yam-gateway'?gatewayError?.message:null)??'Routing configuration is being refreshed. Input remains in the editor.','error');return {action:'handled'};
 }else if(pendingUserInput?.images?.length&&pendingUserInput.text===event.text&&!event.images?.length){const images=pendingUserInput.images;pendingUserInput=null;return {action:'transform',text:event.text,images};}else pendingUserInput=null;
 });
 pi.on('session_before_compact',(_event,ctx)=>selectionError||gatewayError&&(ctx??context)?.model?.provider==='yam-gateway'?{cancel:true}:undefined);
 protectSession(pi);
 pi.on('session_start',async(_event,ctx)=>{
  context=ctx;
  native?.beginTurn?.(ctx);
  const runtimeProbe=pi.getFlag('yam-runtime-probe')===true;
  if(runtimeProbe||pi.getFlag('yam-catalog-probe')===true){
   const missing=[[pi,['appendEntry','getThinkingLevel','setThinkingLevel','setModel']],[ctx.modelRegistry,['find','getAvailable','hasConfiguredAuth','streamSimple']],[ctx.sessionManager,['getBranch','getSessionFile','buildSessionProjection']]].flatMap(([api,names])=>names.filter(name=>typeof api?.[name]!=='function'));
   if(missing.length){ctx.ui.notify(JSON.stringify({type:'yam_catalog',error:`Pi routing requires APIs: ${missing.join(', ')}`}), 'info');return;}
   if(runtimeProbe){ctx.ui.notify(JSON.stringify({type:'yam_catalog',runtime:1}),'info');return;}
  }
  try{sessionMode=readSessionMode(ctx);}catch(error){
   if(!channel)channel=await serveControls(process.env.YAM_PI_CONTROL_FILE,process.env.YAM_PI_GENERATION,snapshot,control,catalog);
   selectionError={message:String(error.message??error)};modeError=selectionError.message;phase='error';publishMode();changed();await notify('SessionStart',ctx);return;
  }
  publishMode();
  const probe=pi.getFlag('yam-catalog-probe')===true;
  if(!enabled()&&!probe){
   if(!channel)channel=await serveControls(process.env.YAM_PI_CONTROL_FILE,process.env.YAM_PI_GENERATION,snapshot,control,catalog);
   if(nativeModeIssue(ctx,ctx.model)){
    try{await restoreNativeSelection(ctx,undefined,sessionMode?.native);}
    catch(error){selectionError={message:String(error.message??error)};phase='error';}
   }
   if(!selectionError)phase='idle';
   changed();await notify('SessionStart',ctx);return;
  }
  await native?.initialize?.(ctx);
  if(sessionMode?.policy)await refreshGateway();
  const originalConfig=config(ctx),migratedConfig={...originalConfig};
  const migrateKey=key=>{
   if(!key)return key;
   const model=ctx.modelRegistry.find(...splitModel(key));
   if(!model||!isChatGPT(ctx,model)||!native)return key;
   try{const entry=native.resolveModel(ctx,model);return `${entry.provider}/${entry.id}`;}
   catch{return key;}
  };
  for(const key of ['small','medium','strong','classifier']){
   if(originalConfig[key])migratedConfig[key]=migrateKey(originalConfig[key]);
  }
  if(Array.isArray(originalConfig.classifierFallbacks)){
   const resolved=classifierFallbacks(originalConfig).map(migrateKey);
   migratedConfig.classifierFallbacks=[...new Set(resolved)].filter(key=>key!==migratedConfig.classifier);
  }
  if(originalConfig.executionFallbacks&&typeof originalConfig.executionFallbacks==='object'&&!Array.isArray(originalConfig.executionFallbacks)){
   migratedConfig.executionFallbacks={...originalConfig.executionFallbacks};
   for(const tier of executionTiers){
    const backups=executionBackups(originalConfig,tier);
    if(!backups.length)continue;
    const seen=new Set([migratedConfig[tier]]);
    migratedConfig.executionFallbacks[tier]=backups.map(key=>{
     const migrated=migrateKey(key);
     if(seen.has(migrated))return '';
     seen.add(migrated);return migrated;
    });
   }
  }
  if(JSON.stringify(originalConfig)!==JSON.stringify(migratedConfig))pi.appendEntry(configType,migratedConfig);
  if(pi.getFlag('yam-catalog-probe')===true){const key=pi.getFlag('yam-setup-model');let probe;
   if(key){try{const result=await classify(ctx,[{role:'user',content:'Explain HTTP 404 briefly.'}],null,defaultRules,undefined,key);const facts=result.answer;probe={ok:routeFacts(facts,defaultRules).valid&&Array.isArray(facts?.requires)&&facts.requires.every(c=>['text','files','image_input','image_generation'].includes(c))};}catch{probe={ok:false};}}
   const preferred=ctx.model&&ctx.model.api!=='pi-virtual'?`${isChatGPT(ctx,ctx.model)?'yam-codex':ctx.model.provider}/${ctx.model.id}`:null;
   ctx.ui.notify(JSON.stringify({type:'yam_catalog',runtime:1,models:catalog(),preferred,error:null,warning:gatewayError?.message??null,...(probe?{probe}:{})}),'info');return;}
  if(!channel)channel=await serveControls(process.env.YAM_PI_CONTROL_FILE,process.env.YAM_PI_GENERATION,snapshot,control,catalog);
  const saved=savedPreferences(ctx),fixed=pi.getFlag('yam-fixed-model'),level=pi.getFlag('yam-effort');
  let candidate=null;
  if(saved||fixed!==undefined||level!==undefined||process.env.YAM_PI_EXPLICIT_THINKING==='1'){
   const nativeModel=launchOption('--model'),inline=nativeModel?.split(':').at(-1),nativeEffort=launchOption('--thinking')??(['off','minimal',...efforts].includes(inline)?inline:undefined);
   const model=nativeModel&&nativeModel!=='yam/auto'&&ctx.model?.provider!=='yam'?`${ctx.model.provider}/${ctx.model.id}`:fixed??'auto';
   candidate=saved??{model,effort:nativeEffort!==undefined?(nativeEffort==='off'&&model==='auto'&&process.env.YAM_PI_EXPLICIT_THINKING!=='1'?'auto':nativeEffort):level??'auto'};
  }
  if(!candidate&&isChatGPT(ctx,ctx.model))candidate={model:`${ctx.model.provider}/${ctx.model.id}`,effort:pi.getThinkingLevel()};
  try{restoreRules(ctx);rulesError=false;}catch(e){rulesError=true;blockedPreferences=candidate??currentPreferences();await stopSelection(ctx,'Invalid task rules; correct the launch rules or restore valid session rules.',candidate?.effort);return;}
  if(candidate){try{await applyPreferences(ctx,candidate,!saved);}catch(e){blockedPreferences=candidate;await stopSelection(ctx,e,candidate.effort);}}
  else preferences=null;
  const last=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider&&e.message.model&&!['error','aborted','length'].includes(e.message.stopReason)).at(-1)?.message;
  if(last)actual={model:`${last.provider}/${last.model}`,effort:last.thinkingLevel??'unknown',at:last.timestamp??0};
  if(!selectionError)phase='idle';changed();
  try{checkSelection(ctx);const p=currentPreferences();ctx.ui.setStatus('yam-route',`${p.model==='auto'?'自动模型':p.model} · ${p.effort==='auto'?'自动推理':p.effort} · /yam-route`);}
  catch(e){ctx.ui.notify(String(e.message),'error');ctx.ui.setStatus('yam-route','路由配置不可用 · 请检查模型和连接');await stopSelection(ctx,e);}
  const inline=launchOption('--model')?.split(':').at(-1);
  const requested=launchOption('--thinking')??(['off','minimal',...efforts].includes(inline)?inline:undefined);
  if(!saved&&requested!==undefined&&pi.getThinkingLevel()!==requested)await stopSelection(ctx,`Requested reasoning ${requested} is unsupported; inference stopped until the selection is corrected.`,requested);
  changed();await notify('SessionStart',ctx);
 });
 pi.on('session_before_tree',(_event,ctx)=>{
  if(changing||turn||pendingMode){ctx.ui.notify('Wait for the current task and routing change before changing history branches.','warning');return {cancel:true};}
 });
 pi.on('session_tree',async(_event,ctx)=>{
  context=ctx;native?.beginTurn?.(ctx);changing=true;
  const wasEnabled=enabled(),previousGateway=currentGateway();
  preferences=null;blockedPreferences=null;target=null;actual=null;execution=null;selectionError=null;failure=null;runtimeError=null;modeError=null;
  let saved;
  try{
   sessionMode=readSessionMode(ctx);
   if(previousGateway!==currentGateway())await refreshGateway();
   if(!enabled()){
    rulesError=false;
    if(nativeModeIssue(ctx,ctx.model))await restoreNativeSelection(ctx,undefined,sessionMode?.native);
    phase='idle';return;
   }
   if(!wasEnabled)await native?.initialize?.(ctx);
   saved=savedPreferences(ctx);
   const projected=saved?null:ctx.sessionManager.buildSessionProjection(),m=projected?.model;
   const restore=saved??{model:m&&!(m.provider==='yam'&&m.modelId==='auto')?`${m.provider}/${m.modelId}`:'auto',effort:projected.thinkingLevel};
   blockedPreferences=restore;
   try{restoreRules(ctx);rulesError=false;}catch(error){rulesError=true;throw error;}
   await applyPreferences(ctx,restore,!saved);
   checkSelection(ctx);phase='idle';
   const last=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider&&e.message.model&&!['error','aborted','length'].includes(e.message.stopReason)).at(-1)?.message;
   if(last)actual={model:`${last.provider}/${last.model}`,effort:last.thinkingLevel??'unknown',at:last.timestamp??0};
  }catch(error){
   if(enabled())await stopSelection(ctx,error,saved?.effort);
   else {selectionError={message:String(error.message??error)};modeError=selectionError.message;phase='error';}
  }finally{changing=false;publishMode();changed();}
 });
 pi.registerCommand('yam-route',{description:'自动路由：on | off [native model] | auto | effort | models',handler:async(args,ctx)=>{
  context=ctx;const parts=args.trim().split(/\s+/);let action=parts[0];
  if(!args.trim())action=await ctx.ui.select('YAM 自动路由',enabled()?['off','auto','effort auto',...efforts.map(v=>'effort '+v),'manual']:['on']);
  if(!action)return;
  const cmd=action.includes(' ')?action.split(' '):parts[0]?parts:[action];
  if(cmd[0]==='on'&&enabled()){
   ctx.ui.notify(cancelPendingMode()?'Pending routing change cancelled.':'Routing is already enabled.','info');return;
  }
  if(cmd[0]==='off'||cmd[0]==='on'||cmd[0]==='auto'&&!enabled()){
   const policy=cmd[0]==='off'?null:sessionMode?.policy??currentLivePolicy(ctx);
   if(cmd[0]!=='off'&&!policy)throw Error('Choose a saved routing strategy in YAM to enable routing');
   await requestMode(ctx,{policy,...cmd[0]==='off'&&cmd[1]?{nativeModel:cmd[1]}:{}});
   ctx.ui.notify(pendingMode?'Routing change queued for the next task.':'Routing mode saved in this native session.','info');return;
  }
  if(!enabled())throw Error('Enable a routing strategy first');
  if(!ctx.isIdle())throw Error('Wait for the current task to finish before changing routing');
  if(cmd[0]==='auto') {await applyPreferences(ctx,{...currentPreferences(),model:'auto'});}
  else if(cmd[0]==='effort') {
   if(!['auto','off',...efforts].includes(cmd[1]))throw Error('Unknown effort');
   const automatic=ctx.model?.api==='pi-virtual'&&ctx.model?.provider==='yam';
   if(cmd[1]==='auto'&&!automatic)throw Error('Automatic effort requires YAM Auto; use /yam-route auto first. Physical model selection stays locked.');
   if(!automatic&&cmd[1]!=='off')effort(ctx.model,cmd[1],cmd[1]);
   await applyPreferences(ctx,{...currentPreferences(),effort:cmd[1]});
  }
  else if(cmd[0]==='models') {
   if(cmd.length<3||cmd.length>4)throw Error('Use /yam-route models provider/small provider/strong [provider/classifier]');
   const c={...config(ctx),small:cmd[1],strong:cmd[2],classifier:cmd[3]??cmd[1]};
   for(const key of [c.small,c.medium,c.strong].filter(Boolean))find(ctx,key);
   if(cmd[3]||c.classifier!==config(ctx).classifier)c.classifierBilling=classifierChannel(ctx,c.classifier)??undefined;
   if(c.classifierFallbacks)c.classifierFallbacks=c.classifierFallbacks.filter(key=>key!==c.classifier);
   if(c.executionFallbacks)c.executionFallbacks=Object.fromEntries(executionTiers.map(tier=>[tier,executionBackups(config(ctx),tier).map(key=>key===c[tier]?'':key)]));
   pi.appendEntry(configType,c);selectionError=null;runtimeError=null;phase='idle';changed();
  } else if(cmd[0]==='manual'){ctx.ui.notify('Use native /model to select and lock a physical model. /yam-route auto returns to routing.','info');return;}
  else throw Error('Unknown routing command');
  ctx.ui.notify('Routing preference saved in this native session.','info');
 }});
 pi.registerVirtualModel({provider:'yam',id:'auto',name:'YAM 自动路由',thinkingLevels:['off','minimal',...efforts],async route(request,ctx){
  try{
  if(request.signal?.aborted)throw nativeError('cancelled','Routing aborted');
  context=ctx;
  if(!enabled())throw Error('Enable a routing strategy before using YAM Auto');
  const epoch=sessionMode?.epoch;
  const newPolicy=!!epoch&&request.state?.routingEpoch!==epoch;
  if(newPolicy&&request.reason!=='user'&&request.reason!=='direct')throw nativeError('capability-unavailable','Previous task used a different routing strategy; submit new work explicitly');
  if(newPolicy&&request.reason==='user')request={...request,state:undefined,previous:undefined};
  if(rulesError)throw Error('Invalid task rules; restore valid session rules first');
  if(selectionError)throw Error(selectionError.message);
  const images=request.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='image'));
  const compatible=model=>{if(images&&!model.input?.includes('image'))throw nativeError('capability-unavailable','Selected model cannot accept image context; choose a compatible strong model');return model;};
  const sticky=request.reason==='retry'?request.failed:request.previous;
  if(request.reason==='retry'&&!sticky)throw nativeError('capability-unavailable','Previous execution model unavailable; retry requires the failed model.');
  if(request.reason!=='user'&&request.reason!=='direct'&&sticky){
   if(sticky.model.provider==='yam-gateway'&&gatewayError)throw gatewayError;
   const key=executionKey(sticky.model),model=compatible(boundModel(ctx,key,request.state?.executionModel===key?request.state.executionBilling:undefined));
   if(taskRules.v===2)workingEffort(model,sticky.thinkingLevel,sticky.thinkingLevel);
   checkBudget(model,request.messages,request.state?.executionChained);return {model,thinkingLevel:sticky.thinkingLevel};
  }
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):null;
  const c=fixed||request.reason==='direct'?config(ctx):executionConfig(ctx);
  const hasBackups=!fixed&&hasExecutionBackups(c);
  if(request.reason==='direct'){
   const readonly=m=>m.provider==='yam-codex'?{...m,yamNativeMode:'readonly'}:m;
   if(hasBackups){
    let overBudget=false;
    for(const {model} of executionCandidates(ctx,c,'strong')){
     if(!model)continue;
     const capabilities=isChatGPT(ctx,model)?native?.capabilities?.():null;
     if(images&&capabilities&&!capabilities.includes('image_input'))continue;
     if(!measureContextBudget(model,request.messages,budgetDependencies).fits){overBudget=true;continue;}
     try{return {model:readonly(compatible(model)),thinkingLevel:workingEffort(model,'high',request.thinkingLevel)};}catch{/* Check the next authorized candidate. */}
    }
    throw nativeError(overBudget?'context-budget':'capability-unavailable',overBudget?'No strong candidate fits the local context budget.':'No authorized strong candidate supports this direct request.');
   }
   const m=fixed??find(ctx,c.strong);
   checkBudget(m,request.messages);return {model:readonly(compatible(m)),thinkingLevel:workingEffort(m,'high',request.thinkingLevel)};
  }
  if(hasBackups&&request.reason!=='user')throw nativeError('capability-unavailable','Previous execution model unavailable; retry requires a known model.');
  const primaryStrong=fixed??available(ctx,c.strong),strong=primaryStrong??firstExecutionModel(ctx,c,'strong');
  const regularTier=taskRules.v===2&&c.medium?'medium':'strong';
  const primaryRegular=fixed??(regularTier==='medium'?available(ctx,c.medium):primaryStrong);
  const regular=primaryRegular??(regularTier==='medium'?firstExecutionModel(ctx,c,'medium'):strong);
  const small=fixed??firstExecutionModel(ctx,c,'small');
  if(!fixed&&!hasBackups&&!strong&&(taskRules.v!==2||!regular))find(ctx,c.strong);
  if(fixed&&preferences.effort!=='auto'){
   const level=workingEffort(fixed,'high',request.thinkingLevel),reason='用户固定模型与推理档位',budget=checkBudget(fixed,request.messages);compatible(fixed);
   native?.setRoute?.({intent:newPolicy?'new':undefined,requires:[],roles:executionProfiles(ctx)});
   ctx.ui.setStatus('yam-route',`${fixed.provider}/${fixed.id} · ${level} · 固定模型与推理`);target={model:`${fixed.provider}/${fixed.id}`,effort:level,reason};decision={rule:'fixed',ruleVersion:rulesVersion(taskRules),classificationMs:0,classifierCost:0,executionCost:0,correctionCost:0,totalCost:0,...budget?{budget}:{}};saveDecision();phase='selected';changed();
   return {model:fixed,thinkingLevel:level,state:{v:1,...(epoch?{routingEpoch:epoch}:{}),model:fixed===small?'small':'strong',executionModel:executionKey(fixed),executionBilling:connection(fixed).billing,effort:level,task:textOf(request.messages.filter(m=>m.role==='user').at(-1)).slice(0,4000),reason}};
  }
  phase='classifying';target=null;changed();
  const text=textOf(request.messages.findLast(m=>m.role==='user'));
  const classified=await classify(ctx,request.messages,request.state,taskRules,request.signal),answer=classified.answer;
  if(request.signal?.aborted)throw nativeError('cancelled','Routing aborted');
  const subscriptionFallback=classified.subscription&&classified.source!=='A'||!hasBackups&&!fixed&&!primaryStrong&&subscriptionKey(ctx,c.strong);
  const policy=routeFacts(answer,taskRules,request.state);
  const needs=answer?.requires??[];if(!Array.isArray(needs)||needs.some(c=>!['text','files','image_input','image_generation'].includes(c)))throw Error('Invalid classified native capability requirements');
  const legacyContinuation=!fixed&&!answer&&taskRules.v===1&&request.state?.v===1&&['small','strong'].includes(request.state.model);
  const legacyUnknown=request.state?.v===1&&answer?.intent==='unknown';
  const intent=taskRules.v===2?policy.intent:legacyContinuation||legacyUnknown?'continue':answer?.intent;
  const continuing=taskRules.v===2&&request.state?.v===2&&intent!=='new';
  const userContent=request.messages.findLast(m=>m.role==='user')?.content;
  const currentImage=Array.isArray(userContent)&&userContent.some(c=>c.type==='image');
  const imageInput=needs.includes('image_input')&&currentImage;
  const attachedRead=answer?.action==='none'&&answer.readOnly===true&&imageInput&&needs.every(c=>['text','image_input'].includes(c));
  const localTools=answer?.action==='read'&&!needs.includes('image_generation')&&(needs.includes('files')||imageInput)||answer?.action==='write'&&answer.readOnly===false;
  const readonlyPhase=!fixed&&continuing&&(request.state.model==='small'||request.state.mode==='readonly'||request.state.reason==='只读回答质量不足，升档一次');
  const phaseHandoff=readonlyPhase&&policy.valid&&answer?.intent==='continue'&&answer.uncertain===false&&answer.context!=='insufficient'&&(localTools||attachedRead);
  const legacyHandoff=taskRules.v===1&&request.state?.v===1&&request.state.model==='small'&&policy.valid&&answer?.intent==='continue'&&answer.uncertain===false&&(localTools||attachedRead);
  const handoff=phaseHandoff||legacyHandoff;
  const previousKey=request.state?.executionModel??executionKey(request.previous?.model)??actual?.model;
  const previousBilling=request.state?.executionBilling??(previousKey?classifierChannel(ctx,previousKey,true):null);
  const phaseSource=phaseHandoff&&request.state.model!=='small'?regular:small;
  const handoffBilling=handoff?(previousKey?previousBilling:connection(phaseSource).billing):null;
  if(handoff&&previousKey&&!handoffBilling)throw nativeError('capability-unavailable','Previous execution model billing is unknown; main session preserved.');
  // The text-only phase owns no business session; never resume an older medium task for this new tool phase.
  let next=phaseHandoff?{model:'medium',effort:taskRules.fallback.effort}:legacyContinuation?{model:request.state.model,effort:request.state.effort}:{...policy.selection};
  if(continuing&&(next.model==='small'||readonlyPhase)&&!phaseHandoff&&((answer?images:currentImage)||needs.some(c=>c!=='text')||answer&&answer.action!=='none'))throw nativeError('capability-unavailable','Continued lightweight task requires new capabilities; main session preserved, choose a capable execution path.');
  const localContinuation=!fixed&&!answer&&(legacyContinuation||continuing);
  const boundExecution=!fixed&&!handoff&&(continuing||legacyContinuation||request.state?.v===1&&intent==='continue')&&(previousKey||hasBackups);
  let retained=null;
  if(boundExecution){
   retained=boundModel(ctx,previousKey,previousBilling);
   if(executionTiers.includes(request.state.model))next.model=request.state.model;
  }else if(localContinuation){
   const current=next.model==='small'?small:next.model==='medium'?regular:strong;
   if(c[next.model]?.startsWith('openai/')&&connection(current).billing!=='subscription'){
    throw nativeError('capability-unavailable','Previous execution model unavailable; main session preserved, no automatic model or billing change.');
   }
  }
  const uncached=next.model;
  if(taskRules.v===1&&!fixed&&!hasBackups&&!legacyContinuation&&!boundExecution&&small&&strong&&[small,strong].every(m=>connection(m).billing!=='subscription'&&(m.provider!=='yam-gateway'||pricedGatewayModels.has(m.id))))next.model=preferCachedModel(next.model,request.messages,small,strong);
  const cached=uncached!==next.model;
  const subscriptionAdjusted=taskRules.v===1&&!fixed&&!boundExecution&&!legacyContinuation&&subscriptionFallback&&next.model==='small'
   &&connection(small).billing!=='subscription'&&connection(strong).billing==='subscription';
  if(subscriptionAdjusted)next={...routeFacts(null,taskRules,request.state).selection};
  const chooseBackups=hasBackups&&!boundExecution&&!legacyContinuation&&(!continuing||phaseHandoff);
  if(taskRules.v===1&&next.model==='small'&&!chooseBackups){
   const capability=retained??small??ctx.modelRegistry.find(...splitModel(c.small));
   if(!capability&&!images)find(ctx,c.small);
   const guarded=guardCapacity(next.model,request.messages,capability,regular??capability);
   if((continuing||legacyContinuation||boundExecution)&&guarded!=='small')throw nativeError('context-budget','Continued task exceeds its model capacity; main session preserved.');
   next.model=guarded;
  }
  const selectedKey=c[next.model],maySelectTier=chooseBackups||!fixed&&!boundExecution&&taskRules.v===2&&(!continuing||phaseHandoff);
  let model=fixed??retained??(maySelectTier?available(ctx,selectedKey):find(ctx,selectedKey)),capabilityAdjusted=subscriptionAdjusted,budget;
  if(subscriptionFallback&&!maySelectTier&&connection(model).billing!=='subscription')throw Error('Subscription classification unavailable; no API or gateway fallback.');
  const rejected=[];
  decision={rule:policy.rule,ruleVersion:policy.version,classificationSource:classified.source,classificationAttempts:classified.attempts,classificationMs:classified.latencyMs,classifierCost:classified.cost,executionCost:0,correctionCost:0,totalCost:classified.cost,planned:policy.selection,cacheRetained:cached,...(taskRules.v===2||hasBackups)?{rejected}:{}};
  const required=[...new Set(['text',...needs,...images?['image_input']:[]])];
  const supports=(candidate,tier)=>required.every(capability=>{
   if(capability==='image_input'&&!candidate.input?.includes('image'))return false;
   if(tier==='small'&&['files','image_generation'].includes(capability))return false;
   const runtime=isChatGPT(ctx,candidate)?native?.capabilities?.():null;
   return !runtime||runtime.includes(capability);
  });
  if(maySelectTier){
   const tiers=taskRules.v===2?executionTiers:['small','strong'];
   const anchorBilling=handoff?handoffBilling:connection(model).billing;
   const subscription=subscriptionFallback||anchorBilling==='subscription'||subscriptionKey(ctx,selectedKey);
   const channel=hasBackups?classifierChannel(ctx,selectedKey):null;
   let selected;
   for(const tier of tiers.slice(tiers.indexOf(next.model))){
    for(const {key,model:candidate,reason,index} of executionCandidates(ctx,c,tier)){
     if(request.signal?.aborted)throw nativeError('cancelled','Routing aborted');
     if(!candidate){if(hasBackups)rejected.push({model:key,tier,reason});continue;}
     const identity={model:`${candidate.provider}/${candidate.id}`,tier};
     const billing=connection(candidate).billing;
     if(subscription&&billing!=='subscription'||hasBackups&&(tier!==next.model||index>0)&&(!channel||channel!==billing)){rejected.push({...identity,reason:'billing'});continue;}
     if(!supports(candidate,tier)){rejected.push({...identity,reason:'capability'});continue;}
     let level;try{level=workingEffort(candidate,next.effort,request.thinkingLevel);}catch{rejected.push({...identity,reason:'effort'});continue;}
     const measured=taskRules.v===2||hasBackups?measureContextBudget(candidate,request.messages,budgetDependencies):null;
     if(measured&&!measured.fits){rejected.push({...identity,reason:measured.reason,budget:measured});continue;}
     if(taskRules.v===1&&tier==='small'&&guardCapacity(tier,request.messages,candidate,regular??candidate)!=='small'){rejected.push({...identity,reason:'context-limit'});continue;}
     selected={model:candidate,tier,effort:level,budget:measured,index};break;
    }
    if(selected)break;
   }
   if(!selected){saveDecision();const context=rejected.some(r=>r.budget);throw nativeError(context?'context-budget':'capability-unavailable',context?'No configured model fits the local context budget within the authorized billing path; explicitly compact or split the task.':'No configured model supports the required capabilities and reasoning within the authorized subscription/billing path; no API or gateway fallback.');}
   capabilityAdjusted=next.model!==selected.tier||selected.index>0;model=selected.model;next.model=selected.tier;next.effort=selected.effort;budget=selected.budget;
  }
  if(handoffBilling==='subscription'&&connection(model).billing!=='subscription')throw Error('Continued subscription task cannot transfer to an API or gateway model.');
  const chainedContinuation=Boolean(boundExecution&&(hasBackups||request.state?.executionChained));
  if(taskRules.v===2||chainedContinuation){if(!budget){next.effort=workingEffort(model,next.effort,request.thinkingLevel);budget=checkBudget(model,request.messages,chainedContinuation);}}
  else if(!maySelectTier)try{next.effort=workingEffort(model,next.effort,request.thinkingLevel);}catch(e){if(continuing||legacyContinuation||boundExecution||fixed||next.model!=='small'||connection(model).billing==='subscription'&&connection(regular).billing!=='subscription')throw e;model=regular;next.model='strong';next.effort=workingEffort(model,next.effort,request.thinkingLevel);}
  compatible(model);
  if(!supports(model,next.model))throw nativeError('capability-unavailable','Selected main model lacks required capabilities; main session preserved.');
  const mode=taskRules.v===2&&!fixed&&(next.model==='small'||readonlyPhase&&!phaseHandoff)?'readonly':'task';
  native?.setRoute?.({intent:phaseHandoff||newPolicy?'new':intent,mode,requires:needs,roles:executionProfiles(ctx,{tier:next.model,model})});
  const reason=capabilityAdjusted?'能力、推理与上下文预算匹配，选择同计费授权的兼容模型':phaseHandoff?'只读任务转入中档工具执行阶段':cached?'保留近期缓存，预计成本更低':policy.rule==='fallback'?(taskRules.v===2?'分类或上下文不足，选择中档主模型':'分类或上下文不足，保守选择强模型'):`任务规则：${policy.rule}`;
  Object.assign(decision,{selected:{model:next.model,effort:next.effort},...budget?{budget}:{}});saveDecision();
  ctx.ui.setStatus('yam-route',`${model.provider}/${model.id} · ${next.effort} · ${preferences?.effort==='off'||request.thinkingLevel!=='off'?'固定推理':'自动推理'} · ${reason}`);
  phase='selected';target={model:`${model.provider}/${model.id}`,effort:next.effort,reason};changed();
  const state={v:taskRules.v,...(epoch?{routingEpoch:epoch}:{}),...next,...taskRules.v===2?{mode}:{},executionModel:target.model,executionBilling:connection(model).billing,...(hasBackups||chainedContinuation)?{executionChained:true}:{},rule:policy.rule,ruleVersion:policy.version,task:intent==='continue'&&request.state?.task?request.state.task:text.slice(0,4000),reason};
  const correctionMustMatchBilling=!primaryRegular||state.executionBilling==='subscription';
  const correctionAuthorized=regular&&(!correctionMustMatchBilling||connection(regular).billing===state.executionBilling);
  replyRequest=!fixed&&correctionAuthorized&&policy.valid&&answer?.readOnly===true&&answer.uncertain===false&&answer.action==='none'&&answer.context==='independent'&&['transform','answer'].includes(answer.task)&&next.model==='small'&&executionKey(model)!==executionKey(regular)?{request,small:model,strong:regular,state,correctionMustMatchBilling}:null;
  return {model,thinkingLevel:next.effort,state};
  }catch(e){failure=failureOf(e,{stage:'preparation',dispatch:'not-started'});runtimeError=String(e.message).slice(0,1000);phase='error';changed();throw e;}
 }});
 pi.on('before_agent_start',async(_event,ctx)=>{context=ctx;native?.beginTurn?.(ctx);replyRequest=null;toolsUsed=false;replyUpgraded=false;costMessages=new WeakSet();streamedModel=null;turn=randomUUID();lastError=false;runtimeError=null;failure=null;pendingInput=false;decision=ctx.model&&ctx.model.provider!=='yam'?{rule:'fixed',ruleVersion:rulesVersion(taskRules),classificationMs:0,classifierCost:0,executionCost:0,correctionCost:0,totalCost:0}:null;preview=null;await notify('UserPromptSubmit',ctx);});
 const recordReply=(m,kind='executionCost')=>{
  recordCost(m,kind);
  lastError=['error','length','aborted'].includes(m.stopReason);
  failure=lastError?projectFailure(m.provider==='yam-codex'?m.failure:null,{stage:'execution',dispatch:'unknown'}):null;
  if(!lastError)runtimeError=null;
  const key=m.provider&&m.model?`${m.provider}/${m.model}`:null;
  if(key&&(!lastError||m.content?.length||streamedModel===key))actual=actualReply(m);
  streamedModel=null;
  if(!lastError&&key)phase='working';
  if(lastError){phase='error';runtimeError='Native model request failed or was interrupted. Check the terminal, refresh the connection if needed, then explicitly retry the task.';}
  changed();
 };
 for(const event of ['tool_call','tool_execution_start'])pi.on(event,()=>{toolsUsed=true;});
 pi.on('message_end',(event,ctx)=>{
  const m=event.message;if(m?.role!=='assistant')return;
  const pending=replyRequest;
  if(!pending||toolsUsed||replyUpgraded||pending.request.signal?.aborted||m.provider!==pending.small.provider||m.model!==pending.small.id||!weakReadOnlyReply(m,textOf(pending.request.messages.findLast(message=>message.role==='user')??{}))){recordReply(m);return;}
  replyUpgraded=true;
  recordCost(m,'executionCost');
  return (async()=>{
   const {request,strong,state}=pending;
   let correctionReceived=false;
   try{
    if(pending.correctionMustMatchBilling){
     const current=available(ctx,executionKey(strong));
     if(executionKey(current)!==executionKey(strong)||connection(current).billing!==state.executionBilling)throw Error('Correction billing channel changed');
    }
    const messages=request.messages.map(message=>message.role==='system'?{...message,toolsAdded:[],toolsRemoved:[]}:message);
    const level=workingEffort(strong,'high',request.thinkingLevel),reason='只读回答质量不足，升档一次',budget=checkBudget(strong,messages,state.executionChained);
    target={model:`${strong.provider}/${strong.id}`,effort:level,reason};phase='selected';changed();ctx.ui.setStatus('yam-route',`${target.model} · ${level} · ${reason}`);
    // Native message_end replacement is persisted before turn_end; this call never declares or executes tools.
    const signal=request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
    const result=await (isChatGPT(ctx,strong)?native.stream.bind(native):ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry))(strong,{messages},{signal,reasoning:level,toolChoice:'none'}).result();
    recordCost(result,'correctionCost');
    correctionReceived=true;
    if(signal.aborted)throw Error('Answer correction aborted');
    if(result.role!=='assistant'||result.provider!==strong.provider||result.model!==strong.id||result.stopReason!=='stop'||!textOf(result).trim()||result.content.some(b=>b.type==='toolCall'))throw Error('Answer correction incomplete');
    const replacement={...result,thinkingLevel:level};
    pi.appendEntry('pi.virtual-model-state',{provider:'yam',modelId:'auto',state:{...state,model:state.v===2?'medium':'strong',executionModel:executionKey(strong),executionBilling:connection(strong).billing,effort:level,reason}});
    if(decision){decision.corrected=true;decision.selected={model:state.v===2?'medium':'strong',effort:level};if(budget)decision.budget=budget;}costMessages.add(replacement);recordReply(replacement,'correctionCost');return {message:replacement};
   }catch{
    if(decision&&!correctionReceived){decision.correctionCost=null;totalCost();}
    if(request.signal?.aborted){const replacement={...m,stopReason:'aborted',errorMessage:'Answer correction interrupted'};costMessages.add(replacement);recordReply(replacement);return {message:replacement};}
    ctx.ui.notify('只读回答升档未完成，已保留原回复。','warning');recordReply(m);
   }
  })();
 });
 pi.on('message_update',(event)=>{const m=event.message;if(m?.role==='assistant'&&m.provider&&m.model&&m.content?.length){streamedModel=`${m.provider}/${m.model}`;if(phase!=='working'){actual=actualReply(m);phase='working';changed();}}});
 pi.on('session_shutdown',async()=>{await channel?.close();});
 pi.on('tool_execution_end',async(_event,ctx)=>{if(turn)await notify('ToolProgress',ctx);});
 pi.on('agent_settled',async(event,ctx)=>{
  saveDecision();if(turn)await notify(event.aborted?'Interrupt':lastError?'TurnFailed':'TurnComplete',ctx);turn=null;
  if(event.aborted){phase='error';runtimeError='Task interrupted. Review the terminal before explicitly retrying work.';}else if(!lastError)phase='idle';
  changed();
  if(pendingMode)try{await applyMode(ctx,pendingMode);}catch(error){ctx.ui.notify(String(error.message??error),'warning');}
 });
 if(enabled())await refreshGateway();
 const executionProfiles=(ctx,selected)=>{
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):ctx.model?.provider!=='yam'?ctx.model:null,c=config(ctx);
  const selectedThinking=currentPreferences().effort==='auto'?undefined:currentPreferences().effort;
  const choices=fixed?['fixed']:executionTiers.filter(tier=>c[tier]);
  return choices.flatMap(role=>{
   try{
    const m=selected?.tier===role?selected.model:fixed??firstExecutionModel(ctx,c,role);
    if(!m)return [];
    const thinking=!selectedThinking&&!m.reasoning?'off':workingEffort(m,role==='small'?'medium':'high',selectedThinking??'off');
    return [{id:`pi-${role}`,kind:'pi',model:`${m.provider}/${m.id}`,thinking,auth:connection(m).billing==='subscription'?'subscription':m.provider==='yam-gateway'?'gateway':'api',capabilities:['text',...role==='small'?[]:['files'],...m.input?.includes('image')?['image_input']:[]]}];
   }catch(error){if(fixed)throw error;return [];}
  });
 };
 const agentRoutingContext=ctx=>{
  if(!enabled())throw Error('Enable a routing strategy first');
  if(selectionError||rulesError)throw Error(selectionError?.message??'Invalid task rules');
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):ctx.model?.provider!=='yam'?ctx.model:null;
  const selectedThinking=currentPreferences().effort==='auto'?undefined:currentPreferences().effort;
  return {fixedModel:fixed,selectedThinking,rules:taskRules,gateway:currentGateway(),profiles:executionProfiles(ctx)};
 };
 native?.observeExecution?.(value=>{execution=value;changed();});
 return {snapshot,control,catalog,agentRoutingContext,billingPolicy,isEnabled:enabled,observeMode:observer=>{modeObserver=observer;},guardModeChange:guard=>{delegationBlock=guard;}};
}
