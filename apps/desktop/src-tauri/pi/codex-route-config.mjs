// Author: Jeff.Liu. Validate the Codex projection without reading files or credentials.
import {defaultTierRules,validateRules} from './task-rules.mjs';

const tiers=['small','medium','strong'];
const keyPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/;
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

export function validateCodexPolicy(config){
 if(!shape(config,['connections','classifiers','executionGroups','rules','respectSystemProxy','model','effort'])||(config.respectSystemProxy!==undefined&&typeof config.respectSystemProxy!=='boolean')||
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

export function readCodexPolicy(raw,{allowIncomplete=false}={}){
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>48000)throw Error('Invalid Codex routing configuration');
 const config=JSON.parse(raw);
 const {rules}=validateCodexPolicy(config);
 if(!allowIncomplete&&(!config.model||config.model==='auto')){
  const reachable=new Set([...rules.rules.map(rule=>rule.model),rules.fallback.model,'strong']);
  for(const tier of reachable)if(!config.executionGroups.some(group=>group[tier]))throw Error('Configure an execution model for the '+tier+' tier');
 }
 return config;
}

export function codexModelRequirements(config){
 const {candidate,rules}=validateCodexPolicy(config),requirements=new Map();
 const requireEffort=(key,effort)=>{
  const efforts=requirements.get(key)??new Set();
  efforts.add(effort);requirements.set(key,efforts);
 };
 const fixed=config.model&&config.model!=='auto'?config.model:null;
 const fixedEffort=config.effort&&config.effort!=='auto'?config.effort:null;
 for(const key of config.classifiers)requireEffort(key,candidate(key).billing==='paid'?'high':'medium');
 if(fixed&&fixedEffort)requireEffort(fixed,fixedEffort);
 else for(const selection of [...rules.rules,rules.fallback,{model:'strong',effort:rules.rules.find(rule=>rule.task==='review').effort}]){
  for(const key of fixed?[fixed]:config.executionGroups.map(group=>group[selection.model]).filter(Boolean))requireEffort(key,fixedEffort??selection.effort);
 }
 return requirements;
}

export function validateCodexModelCatalog(config,models,checkedConnections){
 const requirements=codexModelRequirements(config);
 for(const [key,efforts] of requirements){
  const model=models.find(row=>row.key===key);
  if(!model){
   const name=key.split('/',1)[0];
   if(checkedConnections&&!checkedConnections.includes(name))throw Error('Codex model catalog unavailable: '+name);
   throw Error('Codex model unavailable: '+key);
  }
  for(const effort of efforts)if(!model.levels.includes(effort))throw Error(`${key}: unsupported reasoning ${effort}`);
 }
}
