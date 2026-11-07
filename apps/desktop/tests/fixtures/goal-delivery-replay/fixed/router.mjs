// Author: Jeff.Liu.
import {connect} from 'node:net';
import {isChatGPT} from './native-codex.mjs';
import {basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serveControls} from './control.mjs';
import {efforts,guardCapacity,preferCachedModel,weakReadOnlyReply,resolveEffort,splitModel,textOf,publicExcerpt,launchOption} from './policy.mjs';
import {defaultRules,defaultTierRules,validateRules,rulesVersion,routeFacts,classifierPrompt} from './task-rules.mjs';
const configType='yam.routing.config.v1',preferencesType='yam.routing.preferences.v1';
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
export default async function install(pi,supportedLevels,Text,native) {
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
  const m=event.message;
  if(m?.role!=='assistant'||!Array.isArray(m.content)||!m.content.some(b=>b.type==='text'&&typeof b.text==='string'&&b.text.trim()))return;
  return {entries:[{type:'custom',customType:replyType,data:{messageId:event.messageEntryId,model:clean(m.provider)&&clean(m.model)?`${clean(m.provider)}/${clean(m.model)}`:null,effort:replyEffort(m.thinkingLevel)}}]};
 });
 for(const name of ['yam-small','yam-medium','yam-strong','yam-classifier','yam-gateway','yam-fixed-model','yam-effort','yam-rules','yam-billing','yam-setup-model'])pi.registerFlag(name,{description:`YAM routing ${name.slice(4)}`,type:'string'});
 let taskRules=validateRules(defaultRules),preview=null,decision=null,rulesError=false;
 const restoreRules=ctx=>{const branch=ctx.sessionManager.getBranch(),index=branch.findLastIndex(e=>e.type==='custom'&&e.customType===rulesType),saved=branch[index];taskRules=validateRules(saved?saved.data:(pi.getFlag('yam-rules')?JSON.parse(pi.getFlag('yam-rules')):(config(ctx).medium?defaultTierRules:defaultRules)));
  if(saved&&!branch.slice(index+1).some(e=>e.type==='custom'&&e.customType===rulesSchemaType)){const legacy=structuredClone(defaultRules);legacy.rules.find(r=>r.task==='review').effort='max';if(JSON.stringify(taskRules)===JSON.stringify(legacy)){taskRules=validateRules(defaultRules);pi.appendEntry(rulesType,taskRules);}}
  if(!saved)pi.appendEntry(rulesType,taskRules);if(!saved||!branch.slice(index+1).some(e=>e.type==='custom'&&e.customType===rulesSchemaType))pi.appendEntry(rulesSchemaType,{});preview=null;};
 pi.registerFlag('yam-catalog-probe',{description:'YAM read-only model catalog',type:'boolean'});
 let turn=null,lastError=false,gatewayError=null,selectionError=null,restoringSelection=false,context=null,channel=null,changing=false;
 let runtimeError=null,blockedPreferences=null,pendingUserInput=null;
 let replyRequest=null,toolsUsed=false,replyUpgraded=false;
 let costMessages=new WeakSet(),streamedModel=null;
 const saveDecision=()=>{if(decision)pi.appendEntry('yam.routing.decision.v1',structuredClone(decision));};
 const totalCost=()=>{if(decision)decision.totalCost=['classifierCost','executionCost','correctionCost'].every(k=>decision[k]!==null)?decision.classifierCost+decision.executionCost+decision.correctionCost:null;};
 const recordCost=(m,kind)=>{if(!decision||costMessages.has(m))return;costMessages.add(m);const cost=observedCost(m,context?.modelRegistry.find(m.provider,m.model));decision[kind]=decision[kind]===null||cost===null?null:decision[kind]+cost;totalCost();};
 let pricedGatewayModels=new Set();
 const internalThinking=new Set();
 const thinkingId=ctx=>ctx.sessionManager.getBranch().findLast(e=>e.type==='thinking_level_change')?.id;
 const markThinking=(ctx,before)=>{const id=thinkingId(ctx);if(id&&id!==before){internalThinking.add(id);if(internalThinking.size>64)internalThinking.delete(internalThinking.values().next().value);}};
 let revision=0,phase='starting',target=null,actual=null,pendingInput=false,preferences=null,execution=null;
 const changed=()=>{revision++;channel?.publish();};
 const savedPreferences=ctx=>{
  const branch=ctx.sessionManager.getBranch(),index=branch.findLastIndex(e=>e.type==='custom'&&e.customType===preferencesType),saved=branch[index]?.data;
  if(!saved)return saved;
  const later=branch.slice(index+1),thinking=later.findLast(e=>e.type==='thinking_level_change');
  // A later standalone native selection may survive a crash before its extension callback commits.
  return thinking&&!later.some(e=>e.type==='model_change')?{...saved,effort:thinking.thinkingLevel}:saved;
 };
 const currentPreferences=()=>blockedPreferences??(context?.model&&context.model.provider!=='yam'?{model:`${context.model.provider}/${context.model.id}`,effort:pi.getThinkingLevel()}:preferences??{model:'auto',effort:pi.getThinkingLevel()==='off'?'auto':pi.getThinkingLevel()});
 const snapshot=()=>({revision,generation:process.env.YAM_PI_GENERATION??'',phase,config:{small:(context?readConfig(context).small:undefined)??pi.getFlag('yam-small')??'',medium:(context?readConfig(context).medium:undefined)??pi.getFlag('yam-medium')??null,strong:(context?readConfig(context).strong:undefined)??pi.getFlag('yam-strong')??'',classifier:(context?readConfig(context).classifier:undefined)??pi.getFlag('yam-classifier')??pi.getFlag('yam-small')??'',gateway:launchOption('--yam-gateway')??null},diagnostics:{configSource:context&&Object.keys(readConfig(context)).length?'session':'launch',billing:pi.getFlag('yam-billing')==='subscription'?'subscription':'configured',execution},nativeRecovery:native?.getRecovery?.(context)??null,preferences:currentPreferences(),rules:taskRules,ruleVersion:rulesVersion(taskRules),preview,decision,target,actual,error:selectionError?.message??runtimeError,gatewayError:gatewayError?.message??null,pendingInput});
 const readConfig=ctx=>ctx.sessionManager.getBranch().filter(e=>e.type==='custom'&&e.customType===configType).at(-1)?.data??{};
 const notify=async(kind,ctx)=>{try{await deliver(kind,ctx,turn);}catch{ctx.ui.notify('YAM event connection unavailable; task and native session remain in Pi.','warning');}};
 const config=ctx=>{
  const saved=Object.keys(readConfig(ctx)).length?readConfig(ctx):null;
  const result=saved??{small:pi.getFlag('yam-small'),...(pi.getFlag('yam-medium')?{medium:pi.getFlag('yam-medium')}:{}),strong:pi.getFlag('yam-strong'),classifier:pi.getFlag('yam-classifier')??pi.getFlag('yam-small')};
  return result;
 };
 const billingPolicy=()=>{const policy=pi.getFlag('yam-billing')??'configured';if(!['configured','subscription'].includes(policy))throw Error('Invalid billing policy');return policy;};
 const forbiddenGateway=m=>m?.provider==='yam-gateway'&&/^(codex|openai-codex|chatgpt)\//i.test(m.id);
 const find=(ctx,key)=>{
  const [provider,id]=splitModel(key);
  if(provider==='yam-gateway'&&gatewayError)throw gatewayError;
  let m=ctx.modelRegistry.find(provider,id);
  if(forbiddenGateway(m)||provider==='yam-gateway'&&/^(codex|openai-codex|chatgpt)\//i.test(id))throw Error('ChatGPT subscription gateway routes are disabled; select official Codex CLI');
  if(m&&isChatGPT(ctx,m)){
   if(!native)throw Error('Official Codex execution adapter unavailable; no subscription HTTP fallback');
   m=native.resolveModel(ctx,m);
  }
  if(billingPolicy()==='subscription'&&!isChatGPT(ctx,m))throw Error('Subscription-only billing policy forbids API or gateway inference');
  if(!m||m.api==='pi-virtual'||!ctx.modelRegistry.hasConfiguredAuth(m))throw Error(`Routing model unavailable: ${key}. Configure Pi credentials or gateway; no fallback to another model.`);
  return m;
 };
 const effort=(m,desired,selected)=>resolveEffort({...m,thinkingLevelMap:Object.fromEntries(supportedLevels(m).map(v=>[v,v]))},desired,selected);
 const workingEffort=(m,desired,selected)=>{
  if(preferences?.effort!=='off')return effort(m,desired,selected);
  if(!supportedLevels(m).includes('off'))throw Error(`Reasoning off is unsupported by ${m.id}; no silent downgrade`);
  return 'off';
 };
 const available=(ctx,key)=>{try{return find(ctx,key);}catch(e){if(gatewayError&&key?.startsWith('yam-gateway/'))return null;throw e;}};
 const validate=ctx=>{const c=config(ctx);for(const key of ['small',...c.medium?['medium']:[],'strong','classifier'])available(ctx,c[key]);return c;};
 const connection=model=>{
  if(model?.provider==='yam-codex')return {source:'chatgpt-subscription',billing:'subscription'};
  if(model?.provider==='yam-gateway')return {source:'magpie',billing:'gateway'};
  const oauth=model&&context?.modelRegistry.isUsingOAuth?.(model);
  return {source:oauth&&['openai','openai-codex'].includes(model.provider)?'chatgpt-subscription':'pi-native',billing:oauth?'subscription':model?'api':'unknown'};
 };
 const actualReply=m=>({model:`${m.provider}/${m.model}`,effort:m.thinkingLevel??'unknown',at:m.timestamp??Date.now(),...connection(context?.modelRegistry.find(m.provider,m.model)??{provider:m.provider}),...(m.usage?{usage:Object.fromEntries(['input','output','cacheRead','cacheWrite'].filter(k=>Number.isFinite(m.usage[k])&&m.usage[k]>=0).map(k=>[k,m.usage[k]]))}:{})});
 const checkSelection=(ctx,p=currentPreferences())=>{
  const c=p.model==='auto'?validate(ctx):p.effort==='auto'?config(ctx):null;
  if(p.model!=='auto'&&p.effort==='auto')find(ctx,c.classifier);
  const m=p.model==='auto'?available(ctx,c.strong):find(ctx,p.model);
  if(!m)return null;
  if(p.effort==='off'){if(!supportedLevels(m).includes('off'))throw Error('Reasoning off is unsupported');}
  else if(p.effort!=='auto')effort(m,p.effort,p.effort);
  return m;
 };
 const catalog=()=>{
  if(!context)return [];
  const models=context.modelRegistry.getAvailable?.()??[];
  return models.filter(m=>!forbiddenGateway(m)&&m.api!=='pi-virtual'&&!(gatewayError&&m.provider==='yam-gateway')).map(m=>({key:`${m.provider}/${m.id}`,name:m.name??m.id,levels:supportedLevels(m),context_window:m.contextWindow,...connection(m)}));
 };
 async function applyPreferences(ctx,next,persist=true){
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
  preferences={model:next.model,effort:next.effort};blockedPreferences=null;if(persist||requestedKey!==next.model)pi.appendEntry(preferencesType,preferences);
  selectionError=null;runtimeError=null;phase='idle';target=null;decision=null;preview=null;changed();
 }
 async function control(request){
  const ctx=context;if(!ctx)throw Error('Pi session is starting');
  if(request.revision!==revision)throw Error('Routing state changed; refresh and try again');
  if(request.action==='native-recovery'){if(request.data!==undefined)throw Error('Invalid native recovery request');return;}
  if(changing||!ctx.isIdle())throw Error('Wait for the current task to finish before changing routing');
  changing=true;
  try{
   if(request.action==='native-reset'){if(!native?.reset)throw Error('Native recovery unavailable');native.reset(ctx,request.data);runtimeError=null;changed();}
   else if(request.action==='set')await applyPreferences(ctx,request.data);
   else if(request.action==='reset')await applyPreferences(ctx,{model:'auto',effort:'auto'});
   else if(request.action==='rules'){
    const next=validateRules(request.data),recovering=rulesError,restore=blockedPreferences??preferences??savedPreferences(ctx)??currentPreferences();
    if(recovering)checkSelection(ctx,restore);
    pi.appendEntry(rulesType,next);pi.appendEntry(rulesSchemaType,{});taskRules=next;preview=null;decision=null;
    if(recovering){rulesError=false;try{await applyPreferences(ctx,restore,!savedPreferences(ctx));}catch(e){blockedPreferences=restore;await stopSelection(ctx,String(e.message),restore.effort);throw e;}}
    changed();
   }
   else if(request.action==='preview'){
    const data=request.data;if(!data||typeof data.text!=='string'||!data.text.trim()||data.text.length>4000||Object.keys(data).some(k=>!['text','rules'].includes(k)))throw Error('Invalid preview input');
    const rules=validateRules(data.rules),result=await classify(ctx,[{role:'user',content:data.text}],null,rules);
    const decision=routeFacts(result.answer,rules);preview={...decision,latencyMs:result.latencyMs,cost:result.cost};changed();
   }
   else if(request.action==='retry'){
    await refreshGateway();await ctx.modelRegistry.refresh?.();await native?.initialize?.(ctx);const restore=blockedPreferences??preferences??savedPreferences(ctx)??currentPreferences();
    try{await applyPreferences(ctx,restore,false);}catch(e){await stopSelection(ctx,String(e.message),restore.effort);throw e;}
   }else throw Error('Unknown Pi control action');
  }finally{changing=false;}
 }
 async function classify(ctx,messages,previous,rules,requestSignal,classifierKey){
  const started=Date.now(),text=textOf(messages.findLast(m=>m.role==='user'));let answer=null,cost=null;
  if(text.length>16000)return {answer,latencyMs:Date.now()-started,cost};
  const classifier=find(ctx,classifierKey??config(ctx).classifier);
  try{
   const signal=requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(isChatGPT(ctx,classifier)?45000:15000)]):AbortSignal.timeout(isChatGPT(ctx,classifier)?45000:15000);
   const result=await (isChatGPT(ctx,classifier)?native.stream.bind(native):ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry))(classifier,{systemPrompt:classifierPrompt(rules),messages:[{role:'user',content:JSON.stringify({request:text,previousTask:previous?.task,recent:publicExcerpt(messages),truncated:messages.length>6||messages.some(m=>textOf(m).length>1200)}),timestamp:Date.now()}]},{signal,maxTokens:512,reasoning:effort(classifier,'medium','off'),toolChoice:'none'}).result();
   cost=observedCost(result,classifier);
   if(signal.aborted||result.stopReason&&result.stopReason!=='stop')throw Error('Classification incomplete');
   answer=JSON.parse(textOf(result).replace(/^```(?:json)?\s*|\s*```$/g,''));
   if(connection(classifier).billing==='subscription'&&!routeFacts(answer,rules).valid)throw Error('Invalid subscription classification');
  }catch(e){
   if(requestSignal?.aborted||gatewayError&&config(ctx).classifier?.startsWith('yam-gateway/'))throw e;
   if(connection(classifier).billing==='subscription')throw Error('ChatGPT subscription classification unavailable. Check official Codex login, quota and model support; no switch to another channel.');
  }
  return {answer,latencyMs:Date.now()-started,cost};
 }
 function observedCost(message,model){
  if(connection(model).billing==='subscription')return null;
  const keys=['input','output','cacheRead','cacheWrite'],quoted=model?.provider==='yam-gateway'?pricedGatewayModels.has(model.id):model?.cost&&keys.every(k=>Number.isFinite(model.cost[k])&&model.cost[k]>=0),u=message?.usage?.cost;
  return quoted&&u&&keys.every(k=>Number.isFinite(u[k])&&u[k]>=0)?keys.reduce((sum,k)=>sum+u[k],0):null;
 }
 async function setupGateway(endpoint) {
  if(!endpoint)return;
  const url=new URL(endpoint);
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Gateway requires HTTPS or loopback HTTP without credentials/query');
  const response=await fetch(endpoint.replace(/\/$/,'')+'/v1/models',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`Gateway catalog unavailable (${response.status})`);
  const catalog=await response.json();
  // A missing quote is unknown, not a free cache hit. Keep the native model catalog compatible.
  pricedGatewayModels=new Set((catalog.data??[]).filter(m=>['prompt','completion','input_cache_read'].every(key=>{
   const value=m.pricing?.[key];return ['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
  })).map(m=>m.id));
  // Subscription routes belong to the official CLI; this optional catalog is for API routes.
  const models=(catalog.data??[]).filter(m=>!forbiddenGateway({provider:'yam-gateway',id:m.id})&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=512&&Number.isFinite(m.context_window)&&m.context_window>0&&Number.isFinite(m.max_output_tokens)&&m.max_output_tokens>0&&(!m.modalities?.input||m.modalities.input.includes('text'))).map(m=>({
   id:m.id,name:m.display_name??m.id,api:'openai-completions',reasoning:m.reasoning===true,input:m.modalities?.input??['text'],contextWindow:m.context_window,maxTokens:m.max_output_tokens,
   cost:{input:Number(m.pricing?.prompt??0)*1e6,output:Number(m.pricing?.completion??0)*1e6,cacheRead:Number(m.pricing?.input_cache_read??0)*1e6,cacheWrite:0},
   thinkingLevelMap:{off:m.reasoning===true?['none','off'].find(v=>(m.reasoning_levels??[]).includes(v))??null:'off',...Object.fromEntries(['minimal',...efforts].map(v=>[v,(m.reasoning_levels??[]).includes(v)?v:null]))}
  }));
  if(!models.length)throw Error('Gateway has no compatible text models');
  pi.registerProvider('yam-gateway',{baseUrl:endpoint.replace(/\/$/,'')+'/v1',api:'openai-completions',apiKey:'yam-local-gateway',models});
 }
 async function refreshGateway(){
  try{await setupGateway(launchOption('--yam-gateway'));gatewayError=null;}catch{pricedGatewayModels=new Set();gatewayError=Error('Magpie gateway model catalog unavailable. Check the gateway; Pi native models remain available.');}
 }
 async function stopSelection(ctx,message,requested) {
  selectionError={message,effort:requested};phase='error';changed();const beforeEntry=thinkingId(ctx);restoringSelection=true;
  try {
   const automatic=ctx.modelRegistry.find('yam','auto');
   if(automatic)await pi.setModel(automatic);
   if(efforts.includes(requested))pi.setThinkingLevel(requested);
  } finally {markThinking(ctx,beforeEntry);restoringSelection=false;}
  ctx.ui.notify(message,'error');
 }
 const rememberSelection=(ctx,model)=>{context=ctx;preferences={model:model.provider==='yam'&&model.id==='auto'?'auto':`${model.provider}/${model.id}`,effort:pi.getThinkingLevel()};pi.appendEntry(preferencesType,preferences);blockedPreferences=null;selectionError=null;phase='idle';target=null;changed();};
 pi.on('thinking_level_select',(event,ctx)=>{if(!restoringSelection&&!internalThinking.has(thinkingId(ctx))&&pi.getThinkingLevel()===event.level){context=ctx;const prior=ctx.model?.provider==='yam'?(savedPreferences(ctx)??{model:'auto'}):{model:`${ctx.model.provider}/${ctx.model.id}`};const next={...prior,effort:event.level};preferences=next;pi.appendEntry(preferencesType,next);selectionError=null;changed();}});
 pi.on('model_select',async(event,ctx)=>{
  if(restoringSelection||event.source==='restore'||!event.previousModel)return;
  if(isChatGPT(ctx,event.model)||billingPolicy()==='subscription'||forbiddenGateway(event.model)){
   try{await applyPreferences(ctx,{model:`${event.model.provider}/${event.model.id}`,effort:pi.getThinkingLevel()});}
   catch(e){blockedPreferences={model:`${event.model.provider}/${event.model.id}`,effort:pi.getThinkingLevel()};await stopSelection(ctx,String(e.message),blockedPreferences.effort);}
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
  if(selectionError||changing||gatewayError&&ctx.model?.provider==='yam-gateway'){
  pendingUserInput={text:event.text,images:event.images};
  if(event.source==='interactive'&&event.text&&!ctx.ui.getEditorText?.())ctx.ui.setEditorText?.(event.text);
  pendingInput=true;changed();ctx.ui.notify(selectionError?.message??(ctx.model?.provider==='yam-gateway'?gatewayError?.message:null)??'Routing configuration is being refreshed. Input remains in the editor.','error');return {action:'handled'};
 }else if(pendingUserInput?.images?.length&&pendingUserInput.text===event.text&&!event.images?.length){const images=pendingUserInput.images;pendingUserInput=null;return {action:'transform',text:event.text,images};}else pendingUserInput=null;
 });
 pi.on('session_before_compact',(_event,ctx)=>selectionError||gatewayError&&(ctx??context)?.model?.provider==='yam-gateway'?{cancel:true}:undefined);
 // YAM's history owns one native file; cross-file transitions must use the host's new/continue actions.
 for(const event of ['session_before_switch','session_before_fork'])pi.on(event,(_event,ctx)=>{
  if(process.env.YAM_AGENT_ADDRESS){ctx.ui.notify('Use YAM New session or Continue to change conversations. The current native session is preserved.','warning');return {cancel:true};}
 });
 pi.on('session_start',async(_event,ctx)=>{
  context=ctx;
  native?.beginTurn?.(ctx);
  if(pi.getFlag('yam-catalog-probe')===true){
   const missing=[[pi,['appendEntry','getThinkingLevel','setThinkingLevel','setModel']],[ctx.modelRegistry,['find','getAvailable','hasConfiguredAuth','streamSimple']],[ctx.sessionManager,['getBranch','getSessionFile','buildSessionProjection']]].flatMap(([api,names])=>names.filter(name=>typeof api?.[name]!=='function'));
   if(missing.length){ctx.ui.notify(JSON.stringify({type:'yam_catalog',error:`Pi routing requires APIs: ${missing.join(', ')}`}), 'info');return;}
  }
  await native?.initialize?.(ctx);
  const originalConfig=config(ctx),migratedConfig={...originalConfig};
  for(const key of ['small','medium','strong','classifier']){
   if(!originalConfig[key])continue;
   const model=ctx.modelRegistry.find(...splitModel(originalConfig[key]));
   if(model&&isChatGPT(ctx,model)&&native){const resolved=native.resolveModel(ctx,model);migratedConfig[key]=`${resolved.provider}/${resolved.id}`;}
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
  if(candidate){try{await applyPreferences(ctx,candidate,!saved);}catch(e){blockedPreferences=candidate;await stopSelection(ctx,String(e.message),candidate.effort);}}
  else preferences=null;
  const last=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider&&e.message.model&&!['error','aborted','length'].includes(e.message.stopReason)).at(-1)?.message;
  if(last)actual={model:`${last.provider}/${last.model}`,effort:last.thinkingLevel??'unknown',at:last.timestamp??0};
  if(!selectionError)phase='idle';changed();
  try{checkSelection(ctx);const p=currentPreferences();ctx.ui.setStatus('yam-route',`${p.model==='auto'?'自动模型':p.model} · ${p.effort==='auto'?'自动推理':p.effort} · /yam-route`);}
  catch(e){ctx.ui.notify(String(e.message),'error');ctx.ui.setStatus('yam-route','路由配置不可用 · 请检查模型和连接');await stopSelection(ctx,String(e.message));}
  const inline=launchOption('--model')?.split(':').at(-1);
  const requested=launchOption('--thinking')??(['off','minimal',...efforts].includes(inline)?inline:undefined);
  if(!saved&&requested!==undefined&&pi.getThinkingLevel()!==requested)await stopSelection(ctx,`Requested reasoning ${requested} is unsupported; inference stopped until the selection is corrected.`,requested);
  changed();await notify('SessionStart',ctx);
 });
 pi.on('session_tree',async(_event,ctx)=>{context=ctx;native?.beginTurn?.(ctx);const saved=savedPreferences(ctx);preferences=null;blockedPreferences=null;target=null;actual=null;execution=null;selectionError=null;
  try{
   const projected=saved?null:ctx.sessionManager.buildSessionProjection(),m=projected?.model;
   const restore=saved??{model:m&&!(m.provider==='yam'&&m.modelId==='auto')?`${m.provider}/${m.modelId}`:'auto',effort:projected.thinkingLevel};
   blockedPreferences=restore;
   try{restoreRules(ctx);rulesError=false;}catch(e){rulesError=true;throw e;}
   await applyPreferences(ctx,restore,!saved);
   checkSelection(ctx);phase='idle';}catch(e){await stopSelection(ctx,String(e.message),saved?.effort);}
  const last=ctx.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider&&e.message.model&&!['error','aborted','length'].includes(e.message.stopReason)).at(-1)?.message;
  if(last)actual={model:`${last.provider}/${last.model}`,effort:last.thinkingLevel??'unknown',at:last.timestamp??0};changed();
 });
 pi.registerCommand('yam-route',{description:'自动路由：auto | effort auto/high/max | models <small> <strong> [classifier]',handler:async(args,ctx)=>{
  if(!ctx.isIdle())throw Error('Wait for the current task to finish before changing routing');
  context=ctx;const parts=args.trim().split(/\s+/);let action=parts[0];
  if(!args.trim())action=await ctx.ui.select('YAM 自动路由',['auto','effort auto',...efforts.map(v=>'effort '+v),'manual']);
  if(!action)return;
  const cmd=action.includes(' ')?action.split(' '):parts;
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
   const c={...config(ctx),small:cmd[1],strong:cmd[2],classifier:cmd[3]??cmd[1]};for(const k of Object.keys(c))find(ctx,c[k]);pi.appendEntry(configType,c);selectionError=null;runtimeError=null;phase='idle';changed();
  } else if(cmd[0]==='manual'){ctx.ui.notify('Use native /model to select and lock a physical model. /yam-route auto returns to routing.','info');return;}
  else throw Error('Unknown routing command');
  ctx.ui.notify('Routing preference saved in this native session.','info');
 }});
 pi.registerVirtualModel({provider:'yam',id:'auto',name:'YAM 自动路由',thinkingLevels:['off','minimal',...efforts],async route(request,ctx){
  try{
  if(request.signal?.aborted)throw Error('Routing aborted');
  context=ctx;
  if(rulesError)throw Error('Invalid task rules; restore valid session rules first');
  if(selectionError)throw Error(selectionError.message);
  const images=request.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='image'));
  const compatible=model=>{if(images&&!model.input?.includes('image'))throw Error('Selected model cannot accept image context; choose a compatible strong model');return model;};
  const sticky=request.failed??request.previous;
  if(request.reason!=='user'&&request.reason!=='direct'&&sticky){if(sticky.model.provider==='yam-gateway'&&gatewayError)throw gatewayError;return {model:compatible(find(ctx,`${sticky.model.provider}/${sticky.model.id}`)),thinkingLevel:sticky.thinkingLevel};}
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):null;
  if(request.reason==='direct'){const m=fixed??find(ctx,config(ctx).strong);return {model:m.provider==='yam-codex'?{...compatible(m),yamNativeMode:'readonly'}:compatible(m),thinkingLevel:workingEffort(m,'high',request.thinkingLevel)};}
  const c=fixed?(preferences.effort==='auto'?config(ctx):{}):validate(ctx),strong=fixed??available(ctx,c.strong),small=fixed??available(ctx,c.small),regular=fixed??(taskRules.v===2&&c.medium?available(ctx,c.medium):strong);
  if(fixed&&preferences.effort!=='auto'){
   native?.setRoute?.({intent:undefined,requires:[],roles:executionProfiles(ctx)});
   const level=workingEffort(fixed,'high',request.thinkingLevel),reason='用户固定模型与推理档位';compatible(fixed);ctx.ui.setStatus('yam-route',`${fixed.provider}/${fixed.id} · ${level} · 固定模型与推理`);target={model:`${fixed.provider}/${fixed.id}`,effort:level,reason};decision={rule:'fixed',ruleVersion:rulesVersion(taskRules),classificationMs:0,classifierCost:0,executionCost:0,correctionCost:0,totalCost:0};saveDecision();phase='selected';changed();
   return {model:fixed,thinkingLevel:level,state:{v:1,model:fixed===small?'small':'strong',effort:level,task:textOf(request.messages.filter(m=>m.role==='user').at(-1)).slice(0,4000),reason}};
  }
  phase='classifying';target=null;changed();
  const text=textOf(request.messages.findLast(m=>m.role==='user'));
  const classified=await classify(ctx,request.messages,request.state,taskRules,request.signal),answer=classified.answer;
  const policy=routeFacts(answer,taskRules,request.state);
  const needs=answer?.requires??[];if(!Array.isArray(needs)||needs.some(c=>!['text','files','image_input','image_generation'].includes(c)))throw Error('Invalid classified native capability requirements');
  const intent=taskRules.v===2?policy.intent:answer?.intent;
  const continuing=taskRules.v===2&&request.state?.v===2&&intent!=='new';
  const userContent=request.messages.findLast(m=>m.role==='user')?.content;
  const imageInput=needs.includes('image_input')&&Array.isArray(userContent)&&userContent.some(c=>c.type==='image');
  const attachedRead=answer?.action==='none'&&answer.readOnly===true&&imageInput&&needs.every(c=>['text','image_input'].includes(c));
  const localTools=answer?.action==='read'&&!needs.includes('image_generation')&&(needs.includes('files')||imageInput)||answer?.action==='write'&&answer.readOnly===false;
  const readonlyPhase=!fixed&&continuing&&(request.state.model==='small'||request.state.mode==='readonly'||request.state.reason==='只读回答质量不足，升档一次');
  const phaseHandoff=readonlyPhase&&policy.valid&&answer?.intent==='continue'&&answer.uncertain===false&&answer.context!=='insufficient'&&(localTools||attachedRead);
  const phaseSource=phaseHandoff&&request.state.model!=='small'?regular:small;
  // The text-only phase owns no business session; never resume an older medium task for this new tool phase.
  let next=phaseHandoff?{model:'medium',effort:taskRules.fallback.effort}:{...policy.selection};
  if(continuing&&(next.model==='small'||readonlyPhase)&&!phaseHandoff&&(images||needs.some(c=>c!=='text')||answer?.action!=='none'))throw Error('Continued lightweight task requires new capabilities; main session preserved, choose a capable execution path.');
  const uncached=next.model;
  if(taskRules.v===1&&!fixed&&small&&strong&&[small,strong].every(m=>connection(m).billing!=='subscription'&&(m.provider!=='yam-gateway'||pricedGatewayModels.has(m.id))))next.model=preferCachedModel(next.model,request.messages,small,strong);
  const cached=uncached!==next.model;
  if(next.model==='small'){
   const capability=small??ctx.modelRegistry.find(...splitModel(c.small));
   if(!capability&&!images)find(ctx,c.small);
   const guarded=guardCapacity(next.model,request.messages,capability,regular??capability);
   if(continuing&&guarded!=='small')throw Error('Continued task exceeds its model capacity; main session preserved.');
   next.model=taskRules.v===2&&guarded==='strong'?'medium':guarded;
  }
  let model=fixed??find(ctx,next.model==='small'?c.small:next.model==='medium'?c.medium:c.strong),capabilityAdjusted=false;
  const required=[...new Set(['text',...needs,...images?['image_input']:[]])];
  const supports=(candidate,tier)=>required.every(capability=>{
   if(capability==='image_input'&&!candidate.input?.includes('image'))return false;
   if(tier==='small'&&['files','image_generation'].includes(capability))return false;
   const runtime=isChatGPT(ctx,candidate)?native?.capabilities?.():null;
   return !runtime||runtime.includes(capability);
  });
  if(!fixed&&taskRules.v===2&&(!continuing||phaseHandoff)){
   const anchor=phaseHandoff?phaseSource:model,tiers=['small','medium','strong'];
   let selected;
   for(const tier of tiers.slice(tiers.indexOf(next.model))){
    const key=c[tier];if(!key)continue;
    const candidate=available(ctx,key);if(!candidate)continue;
    if(connection(anchor).billing==='subscription'&&connection(candidate).billing!=='subscription')continue;
    if(supports(candidate,tier)){selected={model:candidate,tier};break;}
   }
   if(!selected)throw Error('No configured model has the required capabilities within the authorized subscription/billing path; no API or gateway fallback.');
   capabilityAdjusted=next.model!==selected.tier;model=selected.model;next.model=selected.tier;
  }
  if(phaseHandoff&&connection(phaseSource).billing==='subscription'&&connection(model).billing!=='subscription')throw Error('Continued subscription task cannot transfer to an API or gateway model.');
  try{next.effort=workingEffort(model,next.effort,request.thinkingLevel);}catch(e){if(continuing||fixed||next.model!=='small'||connection(model).billing==='subscription'&&connection(regular).billing!=='subscription')throw e;model=regular;next.model=taskRules.v===2?'medium':'strong';next.effort=workingEffort(model,next.effort,request.thinkingLevel);}
  compatible(model);
  if(!supports(model,next.model))throw Error('Selected main model lacks required capabilities; main session preserved.');
  const mode=!fixed&&(next.model==='small'||readonlyPhase&&!phaseHandoff)?'readonly':'task';
  native?.setRoute?.({intent:phaseHandoff?'new':intent,mode,requires:needs,roles:executionProfiles(ctx)});
  const reason=capabilityAdjusted?'所需能力优先，选择同计费授权的兼容模型':phaseHandoff?'只读任务转入中档工具执行阶段':cached?'保留近期缓存，预计成本更低':policy.rule==='fallback'?(taskRules.v===2?'分类或上下文不足，选择中档主模型':'分类或上下文不足，保守选择强模型'):`任务规则：${policy.rule}`;
  decision={rule:policy.rule,ruleVersion:policy.version,classificationMs:classified.latencyMs,classifierCost:classified.cost,executionCost:0,correctionCost:0,totalCost:classified.cost,planned:policy.selection,selected:{model:next.model,effort:next.effort},cacheRetained:cached};saveDecision();
  ctx.ui.setStatus('yam-route',`${model.provider}/${model.id} · ${next.effort} · ${preferences?.effort==='off'||request.thinkingLevel!=='off'?'固定推理':'自动推理'} · ${reason}`);
  phase='selected';target={model:`${model.provider}/${model.id}`,effort:next.effort,reason};changed();
  const state={v:taskRules.v,...next,...taskRules.v===2?{mode}:{},rule:policy.rule,ruleVersion:policy.version,task:intent==='continue'&&request.state?.task?request.state.task:text.slice(0,4000),reason};
  replyRequest=!fixed&&small&&regular&&!(connection(small).billing==='subscription'&&connection(regular).billing!=='subscription')&&policy.valid&&answer?.readOnly===true&&answer.uncertain===false&&answer.action==='none'&&answer.context==='independent'&&['transform','answer'].includes(answer.task)&&next.model==='small'&&small.provider+'/'+small.id!==regular.provider+'/'+regular.id?{request,small,strong:regular,state}:null;
  return {model,thinkingLevel:next.effort,state};
  }catch(e){runtimeError=String(e.message).slice(0,1000);phase='error';changed();throw e;}
 }});
 pi.on('before_agent_start',async(_event,ctx)=>{context=ctx;native?.beginTurn?.(ctx);replyRequest=null;toolsUsed=false;replyUpgraded=false;costMessages=new WeakSet();streamedModel=null;turn=randomUUID();lastError=false;runtimeError=null;pendingInput=false;decision=ctx.model&&ctx.model.provider!=='yam'?{rule:'fixed',ruleVersion:rulesVersion(taskRules),classificationMs:0,classifierCost:0,executionCost:0,correctionCost:0,totalCost:0}:null;preview=null;await notify('UserPromptSubmit',ctx);});
 const recordReply=(m,kind='executionCost')=>{
  recordCost(m,kind);
  lastError=['error','length','aborted'].includes(m.stopReason);
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
    const level=workingEffort(strong,'high',request.thinkingLevel),reason='只读回答质量不足，升档一次';
    target={model:`${strong.provider}/${strong.id}`,effort:level,reason};phase='selected';changed();ctx.ui.setStatus('yam-route',`${target.model} · ${level} · ${reason}`);
    // Native message_end replacement is persisted before turn_end; this call never declares or executes tools.
    const signal=request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
    const messages=request.messages.map(message=>message.role==='system'?{...message,toolsAdded:[],toolsRemoved:[]}:message);
    const result=await (isChatGPT(ctx,strong)?native.stream.bind(native):ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry))(strong,{messages},{signal,reasoning:level,toolChoice:'none'}).result();
    recordCost(result,'correctionCost');
    correctionReceived=true;
    if(signal.aborted)throw Error('Answer correction aborted');
    if(result.role!=='assistant'||result.provider!==strong.provider||result.model!==strong.id||result.stopReason!=='stop'||!textOf(result).trim()||result.content.some(b=>b.type==='toolCall'))throw Error('Answer correction incomplete');
    const replacement={...result,thinkingLevel:level};
    pi.appendEntry('pi.virtual-model-state',{provider:'yam',modelId:'auto',state:{...state,model:state.v===2?'medium':'strong',effort:level,reason}});
    if(decision){decision.corrected=true;decision.selected={model:state.v===2?'medium':'strong',effort:level};}costMessages.add(replacement);recordReply(replacement,'correctionCost');return {message:replacement};
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
 pi.on('agent_settled',async(event,ctx)=>{saveDecision();if(turn)await notify(event.aborted?'Interrupt':lastError?'TurnFailed':'TurnComplete',ctx);turn=null;if(event.aborted){phase='error';runtimeError='Task interrupted. Review the terminal before explicitly retrying work.';}else if(!lastError)phase='idle';changed();});
 await refreshGateway();
 const executionProfiles=ctx=>{
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):ctx.model?.provider!=='yam'?ctx.model:null,c=config(ctx);
  const selectedThinking=currentPreferences().effort==='auto'?undefined:currentPreferences().effort;
  const choices=fixed?[['fixed',`${fixed.provider}/${fixed.id}`]]:[['small',c.small],...c.medium?[['medium',c.medium]]:[],['strong',c.strong]];
  return choices.flatMap(([role,key])=>{
   try{
    const m=find(ctx,key),thinking=!selectedThinking&&!m.reasoning?'off':workingEffort(m,role==='small'?'medium':'high',selectedThinking??'off');
    return [{id:`pi-${role}`,kind:'pi',model:`${m.provider}/${m.id}`,thinking,auth:connection(m).billing==='subscription'?'subscription':m.provider==='yam-gateway'?'gateway':'api',capabilities:['text',...role==='small'?[]:['files'],...m.input?.includes('image')?['image_input']:[]]}];
   }catch(error){if(fixed)throw error;return [];}
  });
 };
 const agentRoutingContext=ctx=>{
  if(selectionError||rulesError)throw Error(selectionError?.message??'Invalid task rules');
  const fixed=preferences?.model&&preferences.model!=='auto'?find(ctx,preferences.model):ctx.model?.provider!=='yam'?ctx.model:null,c=config(ctx);
  const classifier=find(ctx,c.classifier??(fixed?`${fixed.provider}/${fixed.id}`:c.small));
  if(!fixed)find(ctx,c.strong);
  const selectedThinking=currentPreferences().effort==='auto'?undefined:currentPreferences().effort;
  return {classifier,thinking:classifier.reasoning?effort(classifier,'medium','off'):'off',fixedModel:fixed,selectedThinking,rules:taskRules,gateway:launchOption('--yam-gateway'),profiles:executionProfiles(ctx)};
 };
 native?.observeExecution?.(value=>{execution=value;changed();});
 return {snapshot,control,catalog,agentRoutingContext,billingPolicy};
}
