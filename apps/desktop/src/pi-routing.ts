// Author: Jeff.Liu. These fields belong to Pi only; official CLI arguments never pass through this form.
import {defaultRules,validateRules,type TaskRules} from '../src-tauri/pi/task-rules.mjs';
export type PiDraft={gateway:string|null;small:string;strong:string;classifier:string;model:string;effort:string;rules?:string};
export const defaultPiArgs='';
export type PiConnection={source?:'chatgpt-subscription'|'magpie'|'pi-native';billing?:'subscription'|'gateway'|'api'|'unknown'};
export type PiModel=PiConnection&{key:string;name:string;levels:string[];context_window:number};
export type PiExecutionDiagnostics={stage:'discovering'|'preparing'|'starting'|'executing'|'completed'|'failed'|'aborted';failedStage?:string;failure?:'context-budget';handoff?:{mode:'incremental'|'full';reason:'verified-prefix'|'prefix-unverified'|'new-task'|'identity-changed'|'new-session';messages:number;characters:number;budget:number};discoveryMs:number|null;startupMs:number|null;firstResponseMs:number|null;executionMs:number|null};
export type PiRoutingState={diagnostics?:{configSource:'launch'|'session';billing:'configured'|'subscription';execution:PiExecutionDiagnostics|null};revision:number;generation:string;phase:'starting'|'idle'|'classifying'|'selected'|'working'|'error';config:{small:string;strong:string;classifier:string;gateway:string|null};preferences:{model:string;effort:string};rules?:TaskRules;ruleVersion?:string;preview?:{selection:{model:string;effort:string};rule:string;version:string;latencyMs:number;cost:number|null};decision?:{rule:string;ruleVersion:string;classificationMs:number;classifierCost:number|null;executionCost:number|null;correctionCost:number|null;totalCost:number|null};target:{model:string;effort:string;reason:string}|null;actual:PiConnection&{model:string;effort:string;at:number;usage?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number}}|null;gatewayError?:string|null;error:string|null;pendingInput:boolean};
export type PiSnapshot={active:boolean;state:PiRoutingState|null};
export const piLevels=['low','medium','high','xhigh','max'] as const;
export const piSetupStorageKey='yam.piRoutingSetup.v1';
export type PiRoutingPolicy={v:1;small:string;strong:string;classifier:string;model:string;effort:string;billing:'configured'|'subscription';rules:TaskRules};
export function validatePiRoutingPolicy(value:unknown):PiRoutingPolicy {
 const v=value as PiRoutingPolicy,keys=['v','small','strong','classifier','model','effort','billing','rules'];
 const model=(key:unknown)=>typeof key==='string'&&key.length<=512&&/^[A-Za-z0-9_.-]+\/[^\s\p{Cc}]+$/u.test(key);
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.prototype.hasOwnProperty.call(v,k))||v.v!==1||![v.small,v.strong,v.classifier].every(model)||v.model!=='auto'&&!model(v.model)||!['auto','off','minimal',...piLevels].includes(v.effort)||!['configured','subscription'].includes(v.billing))throw Error('Invalid Pi routing policy');
 if(v.billing==='subscription'&&[v.small,v.strong,v.classifier,...v.model==='auto'?[]:[v.model]].some(key=>!/^(?:yam-codex|openai-codex)\//.test(key)))throw Error('Subscription-only billing requires a Codex subscription model.');
 return {v:1,small:v.small,strong:v.strong,classifier:v.classifier,model:v.model,effort:v.effort,billing:v.billing,rules:validateRules(v.rules)};
}
function readPiSetup(raw:string){
 if(raw.length>16384)throw Error('Invalid Pi routing policy');
 const v=JSON.parse(raw),required=['gateway','small','strong','classifier'],allowed=[...required,'billing','model','effort','rules'];
 if(!v||typeof v!=='object'||Array.isArray(v)||!required.every(k=>Object.prototype.hasOwnProperty.call(v,k))||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Invalid Pi routing policy');
 if(['billing','model','effort','rules'].some(k=>Object.prototype.hasOwnProperty.call(v,k)&&v[k]===null))throw Error('Invalid Pi routing policy');
 const policy=validatePiRoutingPolicy({v:1,small:v.small,strong:v.strong,classifier:v.classifier,model:v.model??'auto',effort:v.effort??'auto',billing:v.billing??'configured',rules:v.rules??defaultRules});
 const draft:PiDraft={...policy,gateway:v.gateway,rules:JSON.stringify(policy.rules)},models=[policy.small,policy.strong,policy.classifier,policy.model].map(key=>({key,name:key,levels:['off','minimal',...piLevels],context_window:1}));
 if(validatePiDraft(draft,models))throw Error('Invalid Pi routing policy');
 return {gateway:v.gateway as string|null,policy,rulesPresent:v.rules!==undefined};
}
export function portablePiRoutingPolicy(raw:string|null):PiRoutingPolicy|null {return raw===null?null:readPiSetup(raw).policy;}
export function importPiRoutingPolicy(policy:PiRoutingPolicy,currentSetup:string|null=null):string {
 const current=currentSetup===null?null:readPiSetup(currentSetup),checked=validatePiRoutingPolicy({...policy,billing:current?.policy.billing==='subscription'?'subscription':policy.billing}),gateway=current?.gateway??null;
 return JSON.stringify({gateway,small:checked.small,strong:checked.strong,classifier:checked.classifier,model:checked.model,effort:checked.effort,rules:checked.rules,...checked.billing==='subscription'?{billing:'subscription'}:{}});
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
  const {gateway,policy,rulesPresent}=readPiSetup(raw),draft:PiDraft={...parsePiDraft(args),...policy,gateway,rules:rulesPresent?JSON.stringify(policy.rules):undefined};
  const billing=policy.billing==='subscription'||parsed.billing==='subscription'?'subscription':'configured';
  if(billing==='subscription')validatePiRoutingPolicy({...policy,billing});
  const base=replace?readArgs(args,true).extra.join(' '):args;
  return buildPiArgs(billing==='subscription'?`--yam-billing subscription ${base}`:base,draft);
 }catch{return null;}
}
export async function verifyPiSetup(args:string,cwd:string,model:string,invoke:<T>(name:string,args?:Record<string,unknown>)=>Promise<T>,gatewayUrl='http://127.0.0.1:3425'){
 const {billing}=readArgs(args);if(billing!==undefined&&!['configured','subscription'].includes(billing))throw Error('Invalid billing policy');
 if(billing==='subscription'&&!/^(?:yam-codex|openai-codex)\//.test(model))throw Error('Subscription-only billing requires a Codex subscription model.');
 const gateway=model.startsWith('yam-gateway/')?gatewayUrl:null;
 const result=await invoke<{models:PiModel[];probe?:{ok:boolean}}>('pi_routing_catalog',{cwd,gateway,probeModel:model});
 if(!result.probe?.ok||!result.models.some(m=>m.key===model&&m.levels.includes('high')))throw Error('Model verification failed');
 const draft={...parsePiDraft(args),gateway,small:model,strong:model,classifier:model},mapping=piSetupMapping(draft,args);
 const issue=validatePiDraft(draft,result.models);if(issue)throw Error(issue);
 return {args:buildPiArgs(args,draft),mapping};
}
export function piSetupMapping(draft:PiDraft,args:string){
 const {billing}=readArgs(args),mapping={gateway:draft.gateway,small:draft.small,strong:draft.strong,classifier:draft.classifier||draft.small};
 if(billing!==undefined&&!['configured','subscription'].includes(billing))throw Error('Invalid billing policy');
 if(billing==='subscription'&&![mapping.small,mapping.strong,mapping.classifier].every(key=>/^(?:yam-codex|openai-codex)\//.test(key)))throw Error('Subscription-only billing requires a Codex subscription model.');
 const policy=validatePiRoutingPolicy({v:1,small:mapping.small,strong:mapping.strong,classifier:mapping.classifier,model:draft.model,effort:draft.effort,rules:draft.rules===undefined?defaultRules:JSON.parse(draft.rules),billing:billing??'configured'});
 return {...mapping,model:policy.model,effort:policy.effort,rules:policy.rules,...(billing==='subscription'?{billing}: {})};
}
const owned=['--yam-small','--yam-strong','--yam-classifier','--yam-gateway','--yam-fixed-model','--yam-effort','--yam-rules','--model','--thinking'];
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
 const flags=new Map<string,string>(),extra:string[]=[];const items=tokens(args);let connectionExplicit=false,billing:string|undefined,terminator=-1;
 for(let i=0;i<items.length;i++){
  const item=items[i],flag=item.value.split('=')[0];
  if(item.value==='--'){terminator=extra.length;extra.push(...items.slice(i).map(v=>v.raw));break;}
  if(flag==='--provider'||flag==='--yam-billing')connectionExplicit=true;
  if(flag==='--yam-billing'){const inline=item.value.indexOf('=');billing=inline<0?items[i+1]?.value:item.value.slice(inline+1);if(billing===undefined)throw Error('Invalid billing policy');if(removeBilling){if(inline<0)i++;continue;}}
  if(owned.includes(flag)){const inline=item.value.indexOf('=');const value=inline<0?items[++i]?.value:item.value.slice(inline+1);if(value===undefined)throw Error(`Missing Pi argument: ${flag}`);flags.set(flag,value);}
  else {extra.push(item.raw);if(item.value.startsWith('--')&&!item.value.includes('=')&&['--extension','--skill','--theme','--tools','--append-system-prompt','--system-prompt','--prompt-template','--provider','--yam-billing','--export'].includes(item.value)&&items[i+1])extra.push(items[++i].raw);}
 }
 return {flags,extra,connectionExplicit,billing,terminator};
}
export function parsePiDraft(args:string):PiDraft {
 const {flags}=readArgs(args);const native=flags.get('--model'),suffix=native?.split(':').slice(-1)[0],inline=suffix&&['off','minimal',...piLevels].includes(suffix)?suffix:undefined;
 const plain=native&&(inline?native.slice(0,-inline.length-1):native),model=plain&&plain!=='yam/auto'?plain:flags.get('--yam-fixed-model')??'auto';
 const explicitEffort=flags.get('--thinking')??inline;
 return {gateway:flags.get('--yam-gateway')??null,small:flags.get('--yam-small')??'',strong:flags.get('--yam-strong')??'',classifier:flags.get('--yam-classifier')??'',model,effort:explicitEffort!==undefined?explicitEffort:flags.get('--yam-effort')??'auto',...(flags.has('--yam-rules')?{rules:flags.get('--yam-rules')}: {})};
}
export function buildPiArgs(args:string,draft:PiDraft):string {
 const {extra,terminator}=readArgs(args),pairs=[['--yam-small',draft.small],['--yam-strong',draft.strong],['--yam-classifier',draft.classifier],['--yam-gateway',draft.gateway],['--yam-fixed-model',draft.model],['--yam-effort',draft.effort],['--yam-rules',draft.rules??null]];
 const configured=pairs.filter(([,v])=>v!==null&&v!=='').flatMap(([k,v])=>[k,`'${v!.split("'").join("'\\''")}'`]);
 // Keep a literal prompt terminator last. Native Pi still owns prompt parsing.
 return [...(terminator<0?extra:extra.slice(0,terminator)),...configured,...(terminator<0?[]:extra.slice(terminator))].join(' ');
}
export function validatePiDraft(draft:PiDraft,models:PiModel[],args=''):string|null {
 if(draft.rules!==undefined){try{validateRules(JSON.parse(draft.rules));}catch{return 'Invalid task rules';}}
 if(draft.gateway!==null){try{const u=new URL(draft.gateway);if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol)||(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)))return 'Gateway requires HTTPS or loopback HTTP without credentials/query';}catch{return 'Invalid gateway URL';}}
 if((draft.model==='auto'||draft.effort==='auto')&&!draft.classifier&&!draft.small)return 'Choose a lightweight model';
 if(draft.model==='auto'&&!draft.small)return 'Choose a lightweight model';
 if(draft.model==='auto'&&!draft.strong)return 'Choose a strong model';
 const required=[...(draft.model==='auto'?[draft.small,draft.strong,draft.classifier||draft.small]:draft.effort==='auto'?[draft.classifier||draft.small]:[]),...(draft.model==='auto'?[]:[draft.model])];
 for(const key of required)if(!models.some(m=>m.key===key))return `Pi model unavailable: ${key||'—'}`;
 let billing;try{billing=readArgs(args).billing;}catch{return 'Invalid billing policy';}
 if(billing!==undefined&&!['configured','subscription'].includes(billing))return 'Invalid billing policy';
 if(billing==='subscription'&&required.some(key=>!/^(?:yam-codex|openai-codex)\//.test(key)&&!(key.startsWith('openai/')&&models.find(m=>m.key===key)?.source==='chatgpt-subscription')))return 'Subscription-only billing requires a Codex subscription model.';
 const level=draft.effort;
 if(level!=='auto'&&!['off','minimal',...piLevels].includes(level))return 'Unknown reasoning level';
 const target=models.find(m=>m.key===(draft.model==='auto'?draft.strong:draft.model));
 if(level!=='auto'&&!target?.levels.includes(level))return `Selected model cannot preserve reasoning ${level}`;
 return null;
}
