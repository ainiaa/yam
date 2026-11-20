// Author: Jeff.Liu. Validate the Codex projection without reading files or credentials.
import {defaultTierRules,matchesWorkspace,validateRules} from './task-rules.mjs';

const tiers=['small','medium','strong'];
const keyPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/;
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

export function validateCodexPolicy(config){
 if(!shape(config,['connections','classifiers','classifierEffort','executionGroups','rules','respectSystemProxy','model','effort'])||(config.respectSystemProxy!==undefined&&typeof config.respectSystemProxy!=='boolean')||
  !config.connections||typeof config.connections!=='object'||Object.keys(config.connections).length>64||
  Array.isArray(config.connections)||!Array.isArray(config.classifiers)||config.classifiers.length>8||
  !Array.isArray(config.executionGroups)||!config.executionGroups.length||config.executionGroups.length>8)
  throw Error('Invalid Codex routing configuration');
 const connections=new Map();
 for(const [name,value] of Object.entries(config.connections)){
  if(/^[A-Za-z0-9_.-]+$/.test(name)&&shape(value,['billing','native'])&&value.billing==='subscription'&&value.native===true){
   if([...connections.values()].some(connection=>connection.native))throw Error('Only one native Codex connection is allowed');
   connections.set(name,{name,billing:'subscription',native:true});continue;
  }
  if(value?.gateway===true){
   let endpoint;try{endpoint=new URL(value.baseUrl);}catch{throw Error('Invalid local Codex gateway');}
   if(!/^[A-Za-z0-9_.-]+$/.test(name)||!shape(value,['billing','gateway','baseUrl','apiKeyEnv'])||value.billing!=='paid'||
    !['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!['/','/v1','/v1/'].includes(endpoint.pathname)||
    value.apiKeyEnv!==undefined&&value.apiKeyEnv!==''&&(!/^YAM_[A-Z0-9_]+_KEY$/.test(value.apiKeyEnv)||value.apiKeyEnv==='YAM_PROVIDER_API_KEY'))throw Error('Invalid local Codex gateway');
   endpoint.pathname='/v1';connections.set(name,{name,billing:'paid',gateway:true,baseUrl:endpoint.href,...value.apiKeyEnv?{apiKeyEnv:value.apiKeyEnv}:{}});continue;
  }
  if(!/^[A-Za-z0-9_.-]+$/.test(name)||!shape(value,['billing','home',...(value?.billing==='paid'?['baseUrl','apiKeyEnv']:[])])||!['subscription','paid'].includes(value.billing)||
   typeof value.home!=='string'||!value.home.startsWith('/')||value.home.length>4096||/[\p{Cc}]/u.test(value.home))
   throw Error('Invalid Codex connection');
  const {billing,home}=value;
  if(billing==='subscription'){connections.set(name,{name,billing,home});continue;}
  let endpoint;
  try{if(typeof value.baseUrl!=='string')throw Error();endpoint=new URL(value.baseUrl);}catch{throw Error('Invalid paid Responses endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
   typeof value.apiKeyEnv!=='string'||!/^YAM_[A-Z0-9_]+_KEY$/.test(value.apiKeyEnv)||value.apiKeyEnv==='YAM_PROVIDER_API_KEY')
   throw Error('Paid Responses requires an HTTPS endpoint and a dedicated YAM_*_KEY environment variable');
  connections.set(name,{name,billing,home,baseUrl:endpoint.href,apiKeyEnv:value.apiKeyEnv});
 }
 const candidate=key=>{
  if(typeof key!=='string'||key.length>512||!keyPattern.test(key))throw Error('Invalid routing model reference');
  const slash=key.indexOf('/'),connection=connections.get(key.slice(0,slash));
  if(!connection)throw Error('Routing model references an unknown connection');
  return {identity:key,model:key.slice(slash+1),connection,billing:connection.billing,waitForCleanup:true};
 };
 if(config.classifierEffort!==undefined&&!['off','minimal','low','medium','high','xhigh','max'].includes(config.classifierEffort))throw Error('Invalid classifier reasoning level');
 const classifiers=config.classifiers.map(candidate);
 if(new Set(config.classifiers).size!==classifiers.length||classifiers.some(entry=>entry.billing!==classifiers[0].billing))
  throw Error('Codex classifier candidates must be distinct models in the same billing channel');
 for(const group of config.executionGroups){
  if(!group||typeof group!=='object'||Array.isArray(group)||Object.keys(group).some(key=>!tiers.includes(key)))
   throw Error('Invalid execution group');
  for(const value of Object.values(group))if(value!=='')candidate(value);
 }
 for(const tier of tiers){
  const filled=config.executionGroups.map(group=>group[tier]).filter(Boolean);
  if(new Set(filled).size!==filled.length)throw Error('Duplicate execution model in a tier');
 }
 const rules=config.rules===undefined?defaultTierRules:validateRules(config.rules);
 if(config.model!==undefined&&config.model!=='auto')candidate(config.model);
 if(config.effort!==undefined&&!['auto','off','minimal','low','medium','high','xhigh','max'].includes(config.effort))throw Error('Invalid routing reasoning preference');
 return {candidate,connections,rules};
}

export function readCodexPolicy(raw,{allowIncomplete=false,automatic=false}={}){
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>48000)throw Error('Invalid Codex routing configuration');
 const config=JSON.parse(raw);
 const {rules}=validateCodexPolicy(config);
 if(automatic){delete config.model;delete config.effort;}
 if(!allowIncomplete&&(!config.model||config.model==='auto')){
  const reachable=new Set([...rules.rules.map(rule=>rule.model),rules.fallback.model,'strong']);
  for(const tier of reachable)if(!config.executionGroups.some(group=>group[tier]))throw Error('Configure an execution model for the '+tier+' tier');
 }
 return config;
}

function* modelRequirements(config,cwd){
 const {candidate,rules}=validateCodexPolicy(config);
 const fixed=config.model&&config.model!=='auto'?config.model:null;
 const fixedEffort=config.effort&&config.effort!=='auto'?config.effort:null;
 if(fixed&&fixedEffort){yield {keys:[fixed],effort:fixedEffort,execution:true};return;}
 const tierKeys=tier=>{
  const keys=config.executionGroups.map(group=>group[tier]).filter(Boolean);
  if(!keys.length)return keys;
  const channel=candidate(keys[0]).billing;
  return keys.filter(key=>candidate(key).billing===channel);
 };
 const deep={model:'strong',effort:rules.rules.find(rule=>rule.task==='review').effort};
 function* ruleDefaults(when,includeFallback=true){
  if(when.depth!=='normal')yield deep;
  if(when.depth!=='deep')for(const rule of rules.rules){
   if(when.task&&when.task!==rule.task)continue;
   yield rule;
   if(includeFallback&&rule.model==='small')yield rules.fallback;
  }
 }
 if(config.classifiers.length)yield {keys:config.classifiers,effort:config.classifierEffort??(candidate(config.classifiers[0]).billing==='paid'?'high':'medium')};
 for(const selection of [...rules.rules,rules.fallback,deep]){
  const keys=fixed?[fixed]:tierKeys(selection.model);
  if(!keys.length)continue;
  yield {keys,effort:fixedEffort??selection.effort,execution:true};
 }
 for(const {enabled,when,use} of rules.executionRules??[]){
  if(!enabled||cwd!==undefined&&!matchesWorkspace(when.workspace,cwd)||!use.model&&!use.effort)continue;
  const effort=fixedEffort??use.effort;
  if(fixed){
   if(effort)yield {keys:[fixed],effort,execution:true};
  }else if(use.model){
   const keys=tiers.includes(use.model)?tierKeys(use.model):
    tiers.some(tier=>tierKeys(tier).includes(use.model))?[use.model]:[];
   if(!keys.length)throw Error('Execution rule requires a model in the configured tier billing channel');
   const levels=effort?[effort]:new Set(Array.from(ruleDefaults(when),selection=>selection.effort));
   for(const level of levels)yield {keys,effort:level,execution:true};
  }else if(!fixedEffort){
   const applicable=new Set(Array.from(ruleDefaults(when,effort!=='medium'),selection=>selection.model));
   for(const tier of applicable){
    const keys=tierKeys(tier);
    if(keys.length)yield {keys,effort,execution:true};
   }
  }
 }
}

export function codexModelRequirements(config,cwd){
 const requirements=new Map();
 for(const {keys,effort} of modelRequirements(config,cwd)){
  for(const key of keys){
   const efforts=requirements.get(key)??new Set();
   efforts.add(effort);
   requirements.set(key,efforts);
  }
 }
 return requirements;
}

export function validateCodexModelCatalog(config,models,checkedConnections,usableExecutionConnections,cwd){
 const catalog=new Map(models.map(model=>[model.key,model]));
 for(const {keys,effort,execution} of modelRequirements(config,cwd)){
  const usable=execution&&usableExecutionConnections?keys.filter(key=>usableExecutionConnections.includes(key.split('/',1)[0])):keys;
  if(!usable.length)throw Error('This strategy requires another Codex connection; start a new session');
  if(usable.some(key=>catalog.get(key)?.levels.includes(effort)))continue;
  const [key]=usable, name=key.split('/',1)[0];
  if(catalog.has(key))throw Error(`${key}: unsupported reasoning ${effort}`);
  if(checkedConnections&&!checkedConnections.includes(name))throw Error('Codex model catalog unavailable: '+name);
  throw Error('Codex model unavailable: '+key);
 }
}
