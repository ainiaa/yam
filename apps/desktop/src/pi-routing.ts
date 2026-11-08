// Author: Jeff.Liu. These fields belong to Pi only; official CLI arguments never pass through this form.
import {defaultRules,defaultTierRules,validateRules,type TaskRules} from '../src-tauri/pi/task-rules.mjs';
export const piExecutionTiers=['small','medium','strong'] as const;
export type PiExecutionTier=typeof piExecutionTiers[number];
type PiExecutionFallbacks=Partial<Record<PiExecutionTier,string[]>>;
export type PiDraft={gateway:string|null;small:string;medium?:string;strong:string;classifier:string;classifierFallbacks?:string[];classifierBilling?:PiClassifierBilling;executionFallbacks?:PiExecutionFallbacks;model:string;effort:string;rules?:string};
export function hasPiRoutingSelection(draft:PiDraft):boolean {
 return !!(draft.small||draft.medium||draft.strong||draft.classifier||draft.classifierFallbacks?.length||draft.model!=='auto'||draft.effort!=='auto');
}
export const defaultPiArgs='';
export type PiConnection={source?:'chatgpt-subscription'|'magpie'|'pi-native';billing?:'subscription'|'gateway'|'api'|'unknown'};
type PiClassifierBilling=Exclude<PiConnection['billing'],'unknown'|undefined>;
export type PiModel=PiConnection&{cli?:'codex';key:string;name:string;levels:string[];context_window:number;legacy_alias?:boolean};
export type PiCatalogSource='magpie-pi'|'magpie-direct'|'pi';
export function piModelCatalogSource(key:string):PiCatalogSource {
 return key.startsWith('magpie/')?'magpie-pi':key.startsWith('yam-gateway/')?'magpie-direct':'pi';
}
export type NativeFailure={category:'auth'|'quota'|'context'|'capability'|'connection'|'cancelled'|'execution'|'unknown';stage:'discovery'|'preparation'|'dispatch'|'execution'|'verification'|'persistence'|'control';code:string;dispatch:'not-started'|'started'|'unknown';nextAction:'check-login'|'check-quota'|'reduce-context'|'check-capability'|'refresh-state'|'inspect-task'};
export type PiContextBudget={kind:'local-estimate';inputTokens:number|null;reserveTokens:number|null;contextWindow:number|null;maxOutputTokens:number|null;fits:boolean;reason:string|null};
export type PiExecutionDiagnostics={stage:'discovering'|'preparing'|'starting'|'executing'|'completed'|'failed'|'aborted';failedStage?:string;failure?:'context-budget';handoff?:{mode:'incremental'|'full';reason:'verified-prefix'|'prefix-unverified'|'new-task'|'identity-changed'|'new-session';messages:number;characters:number;budget:number};discoveryMs:number|null;startupMs:number|null;firstResponseMs:number|null;executionMs:number|null};
export type PiNativeRecovery={failure?:NativeFailure;receiptId:string|null;sessionId:string|null;status:'running'|'failed';reason:'execution-failed'|'cancelled'|'cleanup-unconfirmed'|'unknown';cleanup:'unconfirmed'|'unknown';inProgress:boolean;needsInspection:boolean};
export type PiClassificationSource='A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'local';
export type PiSessionRoutingMode={enabled:boolean;policyId:string|null;policyName:string|null;pending:string|null;pendingPolicyId:string|null;error:string|null;nativeModel:string|null};
export type PiRoutingState={mode?:PiSessionRoutingMode;failure?:NativeFailure|null;nativeRecovery?:PiNativeRecovery|null;diagnostics?:{configSource:'launch'|'session';billing:'configured'|'subscription';execution:PiExecutionDiagnostics|null};revision:number;generation:string;phase:'starting'|'idle'|'classifying'|'selected'|'working'|'error';config:{small:string;medium?:string|null;strong:string;classifier:string;gateway:string|null};preferences:{model:string;effort:string};rules?:TaskRules;ruleVersion?:string;preview?:{selection:{model:string;effort:string};rule:string;version:string;latencyMs:number;cost:number|null};decision?:{budget?:PiContextBudget;rejected?:{model:string;tier?:string;reason:string;budget?:PiContextBudget}[];planned?:{model:string;effort:string};selected?:{model:string;effort:string};rule:string;ruleVersion:string;classificationSource?:PiClassificationSource;classificationMs:number;classifierCost:number|null;executionCost:number|null;correctionCost:number|null;totalCost:number|null};target:{model:string;effort:string;reason:string}|null;actual:PiConnection&{model:string;effort:string;at:number;usage?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number}}|null;gatewayError?:string|null;error:string|null;pendingInput:boolean};
export type PiSnapshot={active:boolean;state:PiRoutingState|null};
export const piLevels=['low','medium','high','xhigh','max'] as const;
export const maxPiBackupModels=7;
export const piSetupStorageKey='yam.piRoutingSetup.v1';
export type PiRoutingPolicy={v:1|2;small:string;medium?:string;strong:string;classifier:string;classifierFallbacks?:string[];classifierBilling?:PiClassifierBilling;executionFallbacks?:PiExecutionFallbacks;model:string;effort:string;billing:'configured'|'subscription';rules:TaskRules};
const modelKey=(key:unknown):key is string=>typeof key==='string'&&key.length<=512&&/^[A-Za-z0-9_.-]+\/[^\s\p{Cc}]+$/u.test(key);
const subscriptionModel=(key:string)=>/^(?:yam-codex|openai-codex|openai)\//.test(key);
export function piSubscriptionOnly(args:string):boolean {
 try{return readArgs(args).billing==='subscription';}catch{return false;}
}
export function piSubscriptionCatalog(models:PiModel[]):PiModel[] {
 return models.filter(model=>subscriptionModel(model.key)&&model.billing!=='api'&&model.billing!=='gateway');
}
function validateClassifierBilling(value:unknown):PiClassifierBilling|undefined {
 if(value===undefined||value==='subscription'||value==='gateway'||value==='api')return value;
 throw Error('Invalid classifier billing channel');
}
export function knownClassifierBilling(model?:PiModel):PiClassifierBilling|undefined {
 return model?.billing==='unknown'?undefined:model?.billing;
}
function validateModelFallbacks(value:unknown,primary:string|undefined,error:string,allowEmpty=false):string[]|undefined {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>maxPiBackupModels||!value.every(key=>allowEmpty&&key===''||modelKey(key)))throw Error(error);
 const filled=allowEmpty?value.filter(Boolean):value;
 if(filled.length&&!primary||new Set([primary,...filled]).size!==1+filled.length)throw Error(error);
 if(!filled.length)return undefined;
 let end=value.length;
 while(value[end-1]==='')end--;
 return value.slice(0,end);
}
const validateClassifierFallbacks=(value:unknown,primary:string)=>validateModelFallbacks(value,primary,'Invalid classifier fallbacks');
function validateExecutionFallbacks(value:unknown,primaries:Pick<PiDraft,PiExecutionTier>):PiExecutionFallbacks|undefined {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid execution fallbacks');
 const result:PiExecutionFallbacks={};
 for(const [key,list] of Object.entries(value)){
  const tier=key as PiExecutionTier;
  if(!piExecutionTiers.includes(tier))throw Error('Invalid execution fallbacks');
  const backups=validateModelFallbacks(list,primaries[tier],'Invalid execution fallbacks',true);
  if(backups)result[tier]=backups;
 }
 return Object.keys(result).length?result:undefined;
}
export function validatePiRoutingPolicy(value:unknown):PiRoutingPolicy {
 const v=value as PiRoutingPolicy,keys=['v','small',...(v?.v===2?['medium']:[]),'strong','classifier','model','effort','billing','rules',...['classifierFallbacks','classifierBilling','executionFallbacks'].filter(key=>v&&Object.prototype.hasOwnProperty.call(v,key))];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.prototype.hasOwnProperty.call(v,k))||![1,2].includes(v.v)||v.v===2&&!modelKey(v.medium)||![v.small,v.strong,v.classifier].every(key=>modelKey(key)||v.model!=='auto'&&key==='')||v.model!=='auto'&&!modelKey(v.model)||!['auto','off','minimal',...piLevels].includes(v.effort)||!['configured','subscription'].includes(v.billing))throw Error('Invalid Pi routing policy');
 const classifierFallbacks=validateClassifierFallbacks(v.classifierFallbacks,v.classifier);
 const classifierBilling=validateClassifierBilling(v.classifierBilling),executionFallbacks=validateExecutionFallbacks(v.executionFallbacks,v);
 if(v.billing==='subscription'&&(classifierBilling&&classifierBilling!=='subscription'||[v.small,...v.v===2?[v.medium!]:[],v.strong,v.classifier,...classifierFallbacks??[],...Object.values(executionFallbacks??{}).flat(),...v.model==='auto'?[]:[v.model]].some(key=>key&&!subscriptionModel(key))))throw Error('Subscription-only billing requires a Codex subscription model.');
 if(v.v===1&&validateRules(v.rules).v===2)throw Error('Three-tier task rules require a medium model');
 return {v:v.v,small:v.small,...v.v===2?{medium:v.medium}:{},strong:v.strong,classifier:v.classifier,...classifierFallbacks?{classifierFallbacks}:{},...classifierBilling?{classifierBilling}:{},...executionFallbacks?{executionFallbacks}:{},model:v.model,effort:v.effort,billing:v.billing,rules:validateRules(v.rules)};
}
function readPiSetup(raw:string){
 if(raw.length>65536)throw Error('Invalid Pi routing policy');
 const v=JSON.parse(raw),required=['gateway','small','strong','classifier'],allowed=[...required,'classifierFallbacks','classifierBilling','executionFallbacks','medium','billing','model','effort','rules'];
 if(!v||typeof v!=='object'||Array.isArray(v)||!required.every(k=>Object.prototype.hasOwnProperty.call(v,k))||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Invalid Pi routing policy');
 if(['medium','billing','model','effort','rules'].some(k=>Object.prototype.hasOwnProperty.call(v,k)&&v[k]===null))throw Error('Invalid Pi routing policy');
 if(Object.prototype.hasOwnProperty.call(v,'medium')&&(typeof v.medium!=='string'||!v.medium))throw Error('Invalid Pi routing policy');
 const policy=validatePiRoutingPolicy({v:v.medium?2:1,small:v.small,...v.medium?{medium:v.medium}:{},strong:v.strong,classifier:v.classifier,classifierFallbacks:v.classifierFallbacks,classifierBilling:v.classifierBilling,executionFallbacks:v.executionFallbacks,model:v.model??'auto',effort:v.effort??'auto',billing:v.billing??'configured',rules:v.rules??(v.medium?defaultTierRules:defaultRules)});
 const draft:PiDraft={...policy,gateway:v.gateway,rules:JSON.stringify(policy.rules)},models=[policy.small,...policy.medium?[policy.medium]:[],policy.strong,policy.classifier,policy.model].map(key=>({key,name:key,levels:['off','minimal',...piLevels],context_window:1}));
 if(validatePiDraft(draft,models))throw Error('Invalid Pi routing policy');
 return {gateway:v.gateway as string|null,policy,rulesPresent:v.rules!==undefined};
}
export function portablePiRoutingPolicy(raw:string|null):PiRoutingPolicy|null {return raw===null?null:readPiSetup(raw).policy;}
export function importPiRoutingPolicy(policy:PiRoutingPolicy,currentSetup:string|null=null):string {
 const current=currentSetup===null?null:readPiSetup(currentSetup),checked=validatePiRoutingPolicy({...policy,billing:current?.policy.billing==='subscription'?'subscription':policy.billing}),gateway=current?.gateway??null;
 return JSON.stringify({gateway,small:checked.small,...checked.medium?{medium:checked.medium}:{},strong:checked.strong,classifier:checked.classifier,classifierFallbacks:checked.classifierFallbacks,classifierBilling:checked.classifierBilling,executionFallbacks:checked.executionFallbacks,model:checked.model,effort:checked.effort,rules:checked.rules,...checked.billing==='subscription'?{billing:'subscription'}:{}});
}
export function selectPiSetupModel(models:PiModel[],preferred:string):string {
 const compatible=models.filter(m=>m.levels.includes('high'));
 return compatible.find(m=>m.key===preferred)?.key??(compatible.length===1?compatible[0].key:'');
}
export function restorePiSetup(args:string,raw:string|null,replace=false):string|null {
 if(!raw)return null;
 try{
  const parsed=readArgs(args);if(!replace&&(parsed.flags.size||parsed.connectionExplicit))return null;
  if(parsed.billing!==undefined&&!['configured','subscription'].includes(parsed.billing))return null;
  const {gateway,policy,rulesPresent}=readPiSetup(raw),draft:PiDraft={...policy,gateway,rules:rulesPresent?JSON.stringify(policy.rules):undefined};
  const billing=policy.billing==='subscription'||parsed.billing==='subscription'?'subscription':'configured';
  if(billing==='subscription')validatePiRoutingPolicy({...policy,billing});
  const base=replace?readArgs(args,true).extra.join(' '):args;
  return buildPiArgs(billing==='subscription'?`--yam-billing subscription ${base}`:base,draft);
 }catch{return null;}
}
export async function probePiSetupModel(args:string,cwd:string,model:string,invoke:<T>(name:string,args?:Record<string,unknown>)=>Promise<T>,gatewayUrl:string|null=null,adapter:'pi'|'codex'='pi'){
 const {billing}=readArgs(args);if(billing!==undefined&&!['configured','subscription'].includes(billing))throw Error('Invalid billing policy');
 if(billing==='subscription'&&!/^(?:yam-codex|openai-codex)\//.test(model))throw Error('Subscription-only billing requires a Codex subscription model.');
 const direct=adapter==='pi'&&piModelCatalogSource(model)==='magpie-direct';
 if(direct&&!gatewayUrl)throw Error('Model verification failed');
 const gateway=direct?gatewayUrl:null;
 const result=await invoke<{models:PiModel[];probe?:{ok:boolean}}>('pi_routing_catalog',{cwd,gateway,probeModel:model});
 if(!result.probe?.ok||!result.models.some(m=>m.key===model&&m.levels.includes('high')))throw Error('Model verification failed');
 return {result,gateway};
}
export async function verifyPiSetup(args:string,cwd:string,model:string,invoke:<T>(name:string,args?:Record<string,unknown>)=>Promise<T>,gatewayUrl:string|null=null,adapter:'pi'|'codex'='pi'){
 const {result,gateway}=await probePiSetupModel(args,cwd,model,invoke,gatewayUrl,adapter);
 const existing=parsePiDraft(args),draft:PiDraft={...existing,gateway:gateway??existing.gateway,small:model,strong:model,classifier:model};
 let warning:string|null=null;
 const subscription=(m:PiModel)=>/^(?:yam-codex|openai-codex)\//.test(m.key)&&m.billing==='subscription';
 if(existing.model==='auto'&&!existing.rules&&!existing.small&&!existing.medium&&!existing.strong&&result.models.some(m=>m.key===model&&subscription(m))){
  // Defaults follow the current official catalog descriptions, not calibrated scores; update exact IDs when models change.
  const defaults={small:'gpt-6-luna',medium:'gpt-6.1-sol',strong:'gpt-6-astra'};
  const provider=model.slice(0,model.indexOf('/'));
  for(const role of ['small','medium','strong'] as const){
   const key=`${provider}/${defaults[role]}`,candidate=result.models.find(m=>m.key===key&&subscription(m)&&m.levels.includes('high'));
   let verified=key===model;
   if(candidate&&!verified){try{const probe=await invoke<{models:PiModel[];probe?:{ok:boolean}}>('pi_routing_catalog',{cwd,gateway:null,probeModel:key});verified=probe.probe?.ok===true&&probe.models.some(m=>m.key===key&&subscription(m)&&m.levels.includes('high'));}catch{verified=false;}}
   draft[role]=candidate&&verified?key:model;
   if(draft[role]!==key)warning='Some routing tiers use the verified model because their default candidate is unavailable.';
  }
  draft.classifier=draft.small;draft.rules=JSON.stringify(defaultTierRules);
 }
 if(draft.executionFallbacks)draft.executionFallbacks=Object.fromEntries(Object.entries(draft.executionFallbacks).map(([tier,backups])=>[tier,backups.map(key=>key===draft[tier as PiExecutionTier]?'':key)]));
 if(draft.classifierFallbacks)draft.classifierFallbacks=draft.classifierFallbacks.filter(key=>key!==draft.classifier);
 draft.classifierBilling=knownClassifierBilling(result.models.find(m=>m.key===draft.classifier));
 const mapping=piSetupMapping(draft,args,result.models);
 const issue=validatePiDraft(draft,result.models,args);if(issue)throw Error(issue);
 return {args:buildPiArgs(args,draft),mapping,warning};
}
export function piSetupMapping(draft:PiDraft,args:string,models?:PiModel[]){
 const {billing}=readArgs(args),classifier=draft.classifier||draft.small,classifierFallbacks=validateClassifierFallbacks(draft.classifierFallbacks,classifier);
 const classifierBilling=validateClassifierBilling(draft.classifierBilling),executionFallbacks=validateExecutionFallbacks(draft.executionFallbacks,draft);
 const mapping={gateway:draft.gateway,small:draft.small,...draft.medium?{medium:draft.medium}:{},strong:draft.strong,classifier,...classifierFallbacks?{classifierFallbacks}:{},...classifierBilling?{classifierBilling}:{},...executionFallbacks?{executionFallbacks}:{}};
 if(billing!==undefined&&!['configured','subscription'].includes(billing))throw Error('Invalid billing policy');
 const selected=[mapping.small,mapping.medium,mapping.strong,classifier,draft.model,...classifierFallbacks??[],...Object.values(executionFallbacks??{}).flat()];
 if(billing==='subscription'&&models?.some(model=>selected.includes(model.key)&&(model.billing==='api'||model.billing==='gateway')))throw Error('Subscription-only billing requires a Codex subscription model.');
 const policy=validatePiRoutingPolicy({v:mapping.medium?2:1,small:mapping.small,...mapping.medium?{medium:mapping.medium}:{},strong:mapping.strong,classifier:mapping.classifier,classifierFallbacks,classifierBilling,executionFallbacks,model:draft.model,effort:draft.effort,rules:draft.rules===undefined?(draft.medium?defaultTierRules:defaultRules):JSON.parse(draft.rules),billing:billing??'configured'});
 return {...mapping,model:policy.model,effort:policy.effort,rules:policy.rules,...(billing==='subscription'?{billing}: {})};
}
const routingOffFlag='--yam-routing-off';
const owned=['--yam-small','--yam-medium','--yam-strong','--yam-classifier','--yam-classifier-fallbacks','--yam-classifier-billing','--yam-execution-fallbacks','--yam-gateway','--yam-fixed-model','--yam-effort','--yam-rules','--model','--thinking'];
function tokens(args:string):{value:string;raw:string}[]{
 const result=[];let i=0;
 while(i<args.length){while(/\s/.test(args[i]??'')&&i<args.length)i++;if(i===args.length)break;const start=i;let value='',quote='';
  while(i<args.length){const c=args[i++];if(!quote&&/\s/.test(c))break;
   if(c==='\\'&&quote!=="'"){if(i===args.length)throw Error('Invalid Pi argument escape');value+=args[i++];}
   else if(c===quote)quote='';else if(!quote&&(c==='"'||c==="'"))quote=c;else value+=c;
  }
  if(quote)throw Error('Unclosed Pi argument quote');result.push({value,raw:args.slice(start,i).trimEnd()});
 }
 return result;
}
function readArgs(args:string,removeBilling=false){
 const flags=new Map<string,string>(),extra:string[]=[];const items=tokens(args);let connectionExplicit=false,routingOff=false,billing:string|undefined,terminator=-1;
 for(let i=0;i<items.length;i++){
  const item=items[i],flag=item.value.split('=')[0];
  if(item.value==='--'){terminator=extra.length;extra.push(...items.slice(i).map(v=>v.raw));break;}
  if(item.value===routingOffFlag){routingOff=true;continue;}
  if(flag==='--provider'||flag==='--yam-billing')connectionExplicit=true;
  if(flag==='--yam-billing'){const inline=item.value.indexOf('=');billing=inline<0?items[i+1]?.value:item.value.slice(inline+1);if(billing===undefined)throw Error('Invalid billing policy');if(removeBilling){if(inline<0)i++;continue;}}
  if(owned.includes(flag)){const inline=item.value.indexOf('=');const value=inline<0?items[++i]?.value:item.value.slice(inline+1);if(value===undefined)throw Error(`Missing Pi argument: ${flag}`);flags.set(flag,value);}
  else {extra.push(item.raw);if(item.value.startsWith('--')&&!item.value.includes('=')&&['--extension','--skill','--theme','--tools','--append-system-prompt','--system-prompt','--prompt-template','--provider','--yam-billing','--export'].includes(item.value)&&items[i+1])extra.push(items[++i].raw);}
 }
 return {flags,extra,connectionExplicit,routingOff,billing,terminator};
}
export function isPiRoutingOff(args:string):boolean {
 try{return readArgs(args).routingOff;}catch{return false;}
}
export function hasPiLaunchRouting(args:string):boolean {
 try{
  const {flags,routingOff,billing}=readArgs(args);
  return !routingOff&&(billing!==undefined||flags.get('--model')?.split(':')[0]==='yam/auto'||[...flags.keys()].some(key=>key.startsWith('--yam-')));
 }catch{return false;}
}
export function disablePiRouting(args:string):string {
 const {flags,extra}=readArgs(args,true);
 const nativeArgs=[['--model',flags.get('--model')],['--thinking',flags.get('--thinking')]]
  .filter(([,value])=>value&&value.split(':')[0]!=='yam/auto')
  .flatMap(([flag,value])=>[flag,`'${value!.split("'").join("'\\''")}'`]);
 return [routingOffFlag,...nativeArgs,...extra].join(' ');
}
export function parsePiDraft(args:string):PiDraft {
 const {flags}=readArgs(args);const native=flags.get('--model'),suffix=native?.split(':').slice(-1)[0],inline=suffix&&['off','minimal',...piLevels].includes(suffix)?suffix:undefined;
 const plain=native&&(inline?native.slice(0,-inline.length-1):native),model=plain&&plain!=='yam/auto'?plain:flags.get('--yam-fixed-model')??'auto';
 const explicitEffort=flags.get('--thinking')??inline;
 const small=flags.get('--yam-small')??'',classifier=flags.get('--yam-classifier')??'',raw=flags.get('--yam-classifier-fallbacks');
 const classifierFallbacks=raw===undefined?undefined:validateClassifierFallbacks(JSON.parse(raw),classifier||small);
 const classifierBilling=validateClassifierBilling(flags.get('--yam-classifier-billing'));
 const roles={small,...flags.has('--yam-medium')?{medium:flags.get('--yam-medium')}:{},strong:flags.get('--yam-strong')??''};
 const executionRaw=flags.get('--yam-execution-fallbacks'),executionFallbacks=executionRaw===undefined?undefined:validateExecutionFallbacks(JSON.parse(executionRaw),roles);
 return {gateway:flags.get('--yam-gateway')??null,...roles,classifier,...classifierFallbacks?{classifierFallbacks}:{},...classifierBilling?{classifierBilling}:{},...executionFallbacks?{executionFallbacks}:{},model,effort:explicitEffort!==undefined?explicitEffort:flags.get('--yam-effort')??'auto',...(flags.has('--yam-rules')?{rules:flags.get('--yam-rules')}: {})};
}
export function buildPiArgs(args:string,draft:PiDraft):string {
 const classifierFallbacks=validateClassifierFallbacks(draft.classifierFallbacks,draft.classifier||draft.small);
 const executionFallbacks=validateExecutionFallbacks(draft.executionFallbacks,draft);
 const {extra,terminator}=readArgs(args),pairs=[['--yam-small',draft.small],['--yam-medium',draft.medium??null],['--yam-strong',draft.strong],['--yam-classifier',draft.classifier],['--yam-classifier-fallbacks',classifierFallbacks?JSON.stringify(classifierFallbacks):null],['--yam-classifier-billing',validateClassifierBilling(draft.classifierBilling)??null],['--yam-execution-fallbacks',executionFallbacks?JSON.stringify(executionFallbacks):null],['--yam-gateway',draft.gateway],['--yam-fixed-model',draft.model],['--yam-effort',draft.effort],['--yam-rules',draft.rules??null]];
 const configured=pairs.filter(([,v])=>v!==null&&v!=='').flatMap(([k,v])=>[k,`'${v!.split("'").join("'\\''")}'`]);
 // Keep a literal prompt terminator last. Native Pi still owns prompt parsing.
 return [...(terminator<0?extra:extra.slice(0,terminator)),...configured,...(terminator<0?[]:extra.slice(terminator))].join(' ');
}
export function validatePiDraft(draft:PiDraft,models?:PiModel[],args=''):string|null {
 if(draft.rules!==undefined){try{if(validateRules(JSON.parse(draft.rules)).v===2&&!draft.medium&&draft.model==='auto')return 'Choose a medium model';}catch{return 'Invalid task rules';}}
 if(draft.gateway!==null){try{const u=new URL(draft.gateway);if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol)||(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)))return 'Gateway requires HTTPS or loopback HTTP without credentials/query';}catch{return 'Invalid gateway URL';}}
 if(draft.model==='auto'&&!draft.small)return 'Choose a lightweight model';
 if(draft.model==='auto'&&!draft.strong)return 'Choose a strong model';
 const classifier=draft.classifier||draft.small;
 const required=draft.model==='auto'?[draft.small,...draft.medium?[draft.medium]:[],draft.strong,classifier]:[draft.model,...draft.effort==='auto'&&classifier?[classifier]:[]];
 for(const key of required)if(!modelKey(key)||models&&!models.some(m=>m.key===key))return `Pi model unavailable: ${key||'—'}`;
 let fallbacks:string[]|undefined;
 try{fallbacks=validateClassifierFallbacks(draft.classifierFallbacks,draft.classifier||draft.small);}catch{return 'Invalid classifier fallbacks';}
 let executionFallbacks:PiExecutionFallbacks|undefined;
 try{executionFallbacks=validateExecutionFallbacks(draft.executionFallbacks,draft);}catch{return 'Invalid execution fallbacks';}
 let billing;try{billing=readArgs(args).billing;}catch{return 'Invalid billing policy';}
 if(billing!==undefined&&!['configured','subscription'].includes(billing))return 'Invalid billing policy';
 if(billing==='subscription'&&(draft.classifierBilling&&draft.classifierBilling!=='subscription'||[...required,...fallbacks??[],...Object.values(executionFallbacks??{}).flat().filter(Boolean)].some(key=>!subscriptionModel(key)||key.startsWith('openai/')&&models?.find(m=>m.key===key)?.billing==='api')))return 'Subscription-only billing requires a Codex subscription model.';
 const level=draft.effort;
 if(level!=='auto'&&!['off','minimal',...piLevels].includes(level))return 'Unknown reasoning level';
 const target=models?.find(m=>m.key===(draft.model==='auto'?draft.strong:draft.model));
 if(level!=='auto'&&models&&!target?.levels.includes(level))return `Selected model cannot preserve reasoning ${level}`;
 return null;
}
