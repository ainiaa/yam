// Author: Jeff.Liu.
import {buildPiArgs,disablePiRouting,hasPiLaunchRouting,hasPiRoutingSelection,isPiRoutingOff,parsePiDraft,portablePiRoutingPolicy,restorePiSetup,validatePiDraft,type PiRoutingPolicy,type PiDraft,type PiModel} from './pi-routing.ts';
import {readCodexPolicy,validateCodexModelCatalog,type CodexPolicy} from '../src-tauri/pi/codex-route-config.mjs';
import {defaultTierRules} from '../src-tauri/pi/task-rules.mjs';
import {readRoutingPolicy as readOmpRoutingPolicy} from '../../../extensions/omp-chatgpt/routing-policy.mjs';

export function codexRoutingConfig(raw:string):CodexPolicy{
 const config:CodexPolicy=raw?JSON.parse(raw):{connections:{'yam-codex':{billing:'subscription',native:true}},classifiers:[],executionGroups:[{},{},{}],rules:defaultTierRules};
 // Legacy fixed selections belong to routing-off sessions, never to an automatic strategy.
 delete config.model;delete config.effort;return config;
}
export function codexRoutingDraft(raw:string):PiDraft{
 const config=codexRoutingConfig(raw),primary=config.executionGroups[0]??{};
 return {gateway:null,small:primary.small??'',medium:primary.medium??'',strong:primary.strong??'',classifier:config.classifiers[0]??'',
  classifierFallbacks:config.classifiers.slice(1),classifierBilling:config.connections[config.classifiers[0]?.split('/')[0]]?.billing==='paid'?'api':'subscription',
  executionFallbacks:Object.fromEntries(['small','medium','strong'].map(tier=>[tier,config.executionGroups.slice(1).map(group=>group[tier]??'')])),
  classifierEffort:config.classifierEffort,model:'auto',effort:'auto',rules:JSON.stringify(config.rules??defaultTierRules)};
}
export function buildCodexRoutingConfig(raw:string,draft:PiDraft):string{
 const config=codexRoutingConfig(raw),tiers=['small','medium','strong'] as const;
 const count=Math.max(config.executionGroups.length,1,...tiers.map(tier=>1+(draft.executionFallbacks?.[tier]?.length??0)));
 return JSON.stringify({...config,classifiers:[draft.classifier||draft.small,...draft.classifierFallbacks??[]].filter(Boolean),
  executionGroups:Array.from({length:count},(_,index)=>Object.fromEntries(tiers.flatMap(tier=>{
   const value=index===0?draft[tier]:draft.executionFallbacks?.[tier]?.[index-1];return value?[[tier,value]]:[];
  }))),classifierEffort:draft.classifierEffort,rules:JSON.parse(draft.rules??JSON.stringify(defaultTierRules))});
}
export function codexQuickSetupConfig(raw:string,piArgs:string,models:PiModel[]){
 if(hasPiRoutingSelection(codexRoutingDraft(raw)))return {args:raw,fixedEffort:false};
 let draft=parsePiDraft(piArgs);draft={...draft,medium:draft.medium||draft.small,rules:JSON.stringify(codexRoutingConfig(raw).rules??defaultTierRules)};
 let args=buildCodexRoutingConfig(raw,draft),fixedEffort=false;
 if(validateCodexDraft(args,models)){
  const rules=JSON.parse(draft.rules!);
  rules.rules=rules.rules.map((rule:Record<string,unknown>)=>({...rule,effort:'high'}));rules.fallback.effort='high';
  draft={...draft,rules:JSON.stringify(rules)};args=buildCodexRoutingConfig(raw,draft);fixedEffort=true;
 }
 const issue=validateCodexDraft(args,models);if(issue)throw Error(issue);
 return {args,fixedEffort};
}
export function validateCodexDraft(raw:string,models?:PiModel[],checkedConnections?:readonly string[]):string|null{
 try{
  const config=readCodexPolicy(JSON.stringify(codexRoutingConfig(raw)));
  if(models)validateCodexModelCatalog(config,models,checkedConnections);
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
 return {...policy,model:'auto',effort:'auto',id:row.id,name:row.name,gateway:JSON.parse(row.setup).gateway};
}
export function supportsDesktopRouting(adapter:string){return adapter==='pi'||adapter==='codex'||adapter==='omp';}

export function compatibleOmpPolicy(policy:string|null){
 if(policy===null)return true;
 try{readOmpRoutingPolicy(policy);return true;}catch{return false;}
}

export function compatibleRoutingPolicies(rows:RoutingPolicy[],adapter:string){
 if(adapter==='omp')return rows.filter(row=>row.adapter==='pi'&&compatibleOmpPolicy(row.setup));
 return supportsDesktopRouting(adapter)?rows.filter(row=>row.adapter===adapter):[];
}

export function initialRoutingPolicy(adapter:string,args:string,rows:RoutingPolicy[]=[]){
 if(adapter==='omp')return compatibleRoutingPolicies(rows,adapter)[0]?.id??'';
 if(adapter!=='pi'||isPiRoutingOff(args))return '';
 if(hasPiLaunchRouting(args))return launchRoutingPolicy;
 const migrated=rows.find(row=>row.id===migratedId&&row.adapter==='pi');
 return migrated&&restorePiSetup(args,migrated.setup)?migrated.id:'';
}

export function routingPolicyArgs(adapter:string,args:string,choice:string,rows:RoutingPolicy[]):string|null{
 if(adapter!=='pi')return choice?null:args;
 try{
  if(!choice)return disablePiRouting(args);
  if(choice===launchRoutingPolicy){const draft={...parsePiDraft(args),model:'auto',effort:'auto'};return hasPiLaunchRouting(args)&&!validatePiDraft(draft,undefined,args)?buildPiArgs(args,draft):null;}
  const policy=compatibleRoutingPolicies(rows,adapter).find(row=>row.id===choice);
  const restored=policy?restorePiSetup(args,policy.setup,true):null;
  if(restored===null)return null;
  const draft={...parsePiDraft(restored),model:'auto',effort:'auto'};
  return validatePiDraft(draft,undefined,restored)?null:buildPiArgs(restored,draft);
 }catch{return null;}
}

export function codexRoutingLaunch(choice:string,rows:RoutingPolicy[]):CodexRoutingLaunch|null|undefined{
 if(!choice)return undefined;
 const row=compatibleRoutingPolicies(rows,'codex').find(policy=>policy.id===choice);
 const config=row?JSON.stringify(codexRoutingConfig(row.setup)):'';
 return row&&validSetup('codex',config)?{name:row.name,config}:null;
}

export type OmpRoutingLaunch={policy:string|null;auth?:'yam'|'pi'};
export function ompRoutingLaunch(choice:string,rows:RoutingPolicy[],auth?:'yam'|'pi'):OmpRoutingLaunch|null{
 if(!choice)return {policy:null,...auth?{auth}:{}};
 const row=compatibleRoutingPolicies(rows,'omp').find(row=>row.id===choice);
 return row&&portablePiRoutingPolicy(row.setup)?{policy:row.setup,...auth?{auth}:{}}:null;
}
