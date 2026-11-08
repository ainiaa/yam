// Author: Jeff.Liu.
import {disablePiRouting,hasPiLaunchRouting,hasPiRoutingSelection,isPiRoutingOff,parsePiDraft,portablePiRoutingPolicy,restorePiSetup,validatePiDraft,type PiRoutingPolicy,type PiDraft,type PiModel} from './pi-routing.ts';
import {readCodexPolicy,type CodexPolicy} from '../src-tauri/pi/codex-route-config.mjs';
import {defaultTierRules} from '../src-tauri/pi/task-rules.mjs';

export function codexRoutingConfig(raw:string):CodexPolicy{
 return raw?JSON.parse(raw):{connections:{'yam-codex':{billing:'subscription',native:true}},classifiers:[],executionGroups:[{},{},{}],rules:defaultTierRules};
}
export function codexRoutingDraft(raw:string):PiDraft{
 const config=codexRoutingConfig(raw),primary=config.executionGroups[0]??{};
 return {gateway:null,small:primary.small??'',medium:primary.medium??'',strong:primary.strong??'',classifier:config.classifiers[0]??'',
  classifierFallbacks:config.classifiers.slice(1),classifierBilling:config.connections[config.classifiers[0]?.split('/')[0]]?.billing==='paid'?'api':'subscription',
  executionFallbacks:Object.fromEntries(['small','medium','strong'].map(tier=>[tier,config.executionGroups.slice(1).map(group=>group[tier]??'')])),
  model:config.model??'auto',effort:config.effort??'auto',rules:JSON.stringify(config.rules??defaultTierRules)};
}
export function buildCodexRoutingConfig(raw:string,draft:PiDraft):string{
 const config=codexRoutingConfig(raw),tiers=['small','medium','strong'] as const;
 const count=Math.max(config.executionGroups.length,1,...tiers.map(tier=>1+(draft.executionFallbacks?.[tier]?.length??0)));
 return JSON.stringify({...config,classifiers:[draft.classifier||draft.small,...draft.classifierFallbacks??[]].filter(Boolean),
  executionGroups:Array.from({length:count},(_,index)=>Object.fromEntries(tiers.flatMap(tier=>{
   const value=index===0?draft[tier]:draft.executionFallbacks?.[tier]?.[index-1];return value?[[tier,value]]:[];
  }))),model:draft.model,effort:draft.effort,rules:JSON.parse(draft.rules??JSON.stringify(defaultTierRules))});
}
export function codexQuickSetupConfig(raw:string,piArgs:string,models:PiModel[]){
 if(hasPiRoutingSelection(codexRoutingDraft(raw)))return {args:raw,fixedEffort:false};
 let draft=parsePiDraft(piArgs);draft={...draft,medium:draft.medium||draft.small,rules:JSON.stringify(codexRoutingConfig(raw).rules??defaultTierRules)};
 let args=buildCodexRoutingConfig(raw,draft),fixedEffort=false;
 if(validateCodexDraft(args,models)){draft={...draft,effort:'high'};args=buildCodexRoutingConfig(raw,draft);fixedEffort=true;}
 const issue=validateCodexDraft(args,models);if(issue)throw Error(issue);
 return {args,fixedEffort};
}
export function validateCodexDraft(raw:string,models?:PiModel[]):string|null{
 try{
  const config=readCodexPolicy(raw),fixed=config.model&&config.model!=='auto'?config.model:null;
  if(models){
   const requirements=new Map<string,Set<string>>(),add=(key:string,effort:string)=>{const list=requirements.get(key)??new Set();list.add(effort);requirements.set(key,list);};
   const rules=config.rules??defaultTierRules;
   for(const key of config.classifiers)add(key,config.connections[key.slice(0,key.indexOf('/'))]?.billing==='paid'?'high':'medium');
   if(fixed&&config.effort&&config.effort!=='auto')add(fixed,config.effort);
   else for(const selection of [...rules.rules,rules.fallback,{model:'strong',effort:rules.rules.find(rule=>rule.task==='review')!.effort}]){
    for(const key of fixed?[fixed]:config.executionGroups.map(group=>group[selection.model]).filter(Boolean))add(key,config.effort&&config.effort!=='auto'?config.effort:selection.effort);
   }
   for(const [key,efforts] of requirements){const model=models.find(row=>row.key===key);if(!model)throw Error('Codex model unavailable: '+key);for(const effort of efforts)if(!model.levels.includes(effort))throw Error(`${key}: unsupported reasoning ${effort}`);}
  }
  return null;
 }catch(error){return error instanceof Error?error.message:'Invalid Codex routing configuration';}
}

export const routingPolicyStorageKey='yam.routingPolicies.v1';
export const launchRoutingPolicy='launch-config';
const migratedId='previous-pi';
const maxPolicies=16,maxStorageBytes=1024*1024;
export type RoutingPolicy={id:string;name:string;adapter:'pi'|'codex';setup:string};
export type CodexRoutingLaunch={name:string;config:string;enabled?:boolean;connection?:string;nativeModel?:{model:string;effort:string}};

function validSetup(adapter:RoutingPolicy['adapter'],setup:string,allowIncomplete=false){
 if(adapter==='pi')return !!portablePiRoutingPolicy(setup);
 try{readCodexPolicy(setup,{allowIncomplete});return true;}catch{return false;}
}

function validateRoutingPolicies(rows:unknown,allowIncomplete=false):RoutingPolicy[]{
 if(!Array.isArray(rows)||rows.length>maxPolicies)throw Error('Invalid saved routing policies.');
 const policies:RoutingPolicy[]=rows.map(row=>{
  if(!row||typeof row!=='object'||Object.keys(row).length!==4||!['pi','codex'].includes(row.adapter)||
   typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(row.id)||row.id===launchRoutingPolicy||
   typeof row.name!=='string'||!row.name.trim()||row.name!==row.name.trim()||
   [...row.name].length>80||/[\p{Cc}\p{Cf}]/u.test(row.name)||
   typeof row.setup!=='string'||!validSetup(row.adapter,row.setup,allowIncomplete))throw Error('Invalid saved routing policies.');
  return {id:row.id,name:row.name,adapter:row.adapter,setup:row.setup};
 });
 if(new Set(policies.map(row=>row.id)).size!==policies.length||
  new Set(policies.map(row=>row.name.toLowerCase())).size!==policies.length)throw Error('Routing policy names must be unique.');
 if(new TextEncoder().encode(JSON.stringify(policies)).length>maxStorageBytes)throw Error('Invalid saved routing policies.');
 return policies;
}

export function readRoutingPolicies(raw:string|null,previousPiSetup:string|null):RoutingPolicy[]{
 if(raw!==null){
  if(raw.length>maxStorageBytes)throw Error('Invalid saved routing policies.');
  return validateRoutingPolicies(JSON.parse(raw),true);
 }
 if(!previousPiSetup)return [];
 try{return validateRoutingPolicies([{id:migratedId,name:'Previous Pi policy',adapter:'pi',setup:previousPiSetup}]);}
 catch{return [];}
}

export function upsertRoutingPolicy(rows:RoutingPolicy[],policy:RoutingPolicy):RoutingPolicy[]{
 const updated={...policy,name:policy.name.trim()};
 if(!updated.name)throw Error('Enter a routing strategy name.');
 return validateRoutingPolicies(rows.some(row=>row.id===policy.id)?rows.map(row=>row.id===policy.id?updated:row):[...rows,updated]);
}

export function importPreviousPiPolicy(rows:RoutingPolicy[],setup:string,label:string,makeId=()=>crypto.randomUUID()):RoutingPolicy[]{
 const args=restorePiSetup('',setup);
 if(!args)throw Error('Invalid saved routing policies.');
 if(rows.some(row=>row.adapter==='pi'&&restorePiSetup('',row.setup)===args))return rows;
 const names=new Set(rows.map(row=>row.name.toLowerCase()));
 let name=label;
 for(let suffix=2;names.has(name.toLowerCase());suffix++)name=`${label} (${suffix})`;
 return upsertRoutingPolicy(rows,{id:makeId(),name,adapter:'pi',setup});
}

export type LiveRoutingPolicy=PiRoutingPolicy&{id:string;name:string;gateway:string|null};
export function routingPolicyPayload(row:RoutingPolicy):LiveRoutingPolicy{
 const policy=row.adapter==='pi'&&portablePiRoutingPolicy(row.setup);
 if(!policy)throw Error('Invalid saved routing policies.');
 return {...policy,id:row.id,name:row.name,gateway:JSON.parse(row.setup).gateway};
}
export function supportsDesktopRouting(adapter:string){return adapter==='pi'||adapter==='codex';}

export function compatibleRoutingPolicies(rows:RoutingPolicy[],adapter:string){
 return supportsDesktopRouting(adapter)?rows.filter(row=>row.adapter===adapter):[];
}

export function initialRoutingPolicy(adapter:string,args:string,rows:RoutingPolicy[]=[]){
 if(adapter!=='pi'||isPiRoutingOff(args))return '';
 if(hasPiLaunchRouting(args))return launchRoutingPolicy;
 const migrated=rows.find(row=>row.id===migratedId&&row.adapter==='pi');
 return migrated&&restorePiSetup(args,migrated.setup)?migrated.id:'';
}

export function routingPolicyArgs(adapter:string,args:string,choice:string,rows:RoutingPolicy[]):string|null{
 if(adapter!=='pi')return choice?null:args;
 try{
  if(!choice)return disablePiRouting(args);
  if(choice===launchRoutingPolicy)return hasPiLaunchRouting(args)&&!validatePiDraft(parsePiDraft(args),undefined,args)?args:null;
  const policy=compatibleRoutingPolicies(rows,adapter).find(row=>row.id===choice);
  return policy?restorePiSetup(args,policy.setup,true):null;
 }catch{return null;}
}

export function codexRoutingLaunch(choice:string,rows:RoutingPolicy[]):CodexRoutingLaunch|null|undefined{
 if(!choice)return undefined;
 const row=compatibleRoutingPolicies(rows,'codex').find(policy=>policy.id===choice);
 return row&&validSetup('codex',row.setup)?{name:row.name,config:row.setup}:null;
}
