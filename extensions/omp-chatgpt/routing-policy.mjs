// Author: Jeff.Liu. Shared by the desktop strategy selector and the OMP runtime.
import {defaultRules,defaultTierRules,validateRules,backupKeys} from '../../apps/desktop/src-tauri/pi/task-rules.mjs';

export const levels=['off','minimal','low','medium','high','xhigh','max'];
const key=value=>typeof value==='string'&&value.length<=512&&/^(?:yam-chatgpt|yam-magpie)\/[^\s\p{Cc}]+$/u.test(value);
const normalize=value=>typeof value==='string'?value.replace(/^(?:yam-codex|openai-codex|openai)\//,'yam-chatgpt/').replace(/^(?:yam-gateway|magpie)\//,'yam-magpie/'):value;
export function gateway(value){
 const url=new URL(value);
 if(value.length>2048||url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Gateway requires HTTPS or loopback HTTP without credentials or query');
 return value.replace(/\/$/,'');
}

export function readRoutingPolicy(raw){
 if(raw!==undefined&&(typeof raw!=='string'||new TextEncoder().encode(raw).length>65536))throw Error('Invalid OMP routing policy');
 let value;
 try{value=raw===undefined?{}:JSON.parse(raw);}catch{throw Error('Invalid OMP routing policy JSON');}
 if(value?.adapter==='pi'&&typeof value.setup==='string')return readRoutingPolicy(value.setup);
 const allowed=['v','gateway','small','medium','strong','classifier','classifierFallbacks','classifierBilling','classifierEffort','executionFallbacks','model','effort','billing','rules'];
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Invalid OMP routing policy');
 const p={v:value.medium?2:1,gateway:'http://127.0.0.1:3425',small:'yam-chatgpt/gpt-6-luna',strong:'yam-magpie/compay-ai/qwen3.7-plus',classifier:'yam-chatgpt/gpt-6-luna',model:'auto',effort:'auto',billing:'configured',...value};
 for(const field of ['small','medium','strong','classifier','model'])if(p[field]!==undefined)p[field]=normalize(p[field]);
 if(![1,2].includes(p.v)||p.v===2&&!key(p.medium)||p.v===1&&p.medium!==undefined||![p.small,p.strong,p.classifier].every(k=>key(k)||p.model!=='auto'&&k==='')||p.model!=='auto'&&!key(p.model)||!['auto',...levels].includes(p.effort)||!['configured','subscription'].includes(p.billing)||p.classifierBilling!==undefined&&!['subscription','gateway'].includes(p.classifierBilling)||p.classifierEffort!==undefined&&!levels.includes(p.classifierEffort))throw Error('Invalid OMP routing policy');
 if(p.classifierFallbacks!==undefined&&!Array.isArray(p.classifierFallbacks))throw Error('Invalid classifier candidates');
 p.classifierFallbacks=(p.classifierFallbacks??[]).map(normalize);
 if(p.classifierFallbacks.length&&!key(p.classifier)||backupKeys(p.classifier,p.classifierFallbacks).length!==p.classifierFallbacks.length)throw Error('Invalid classifier candidates');
 const fallbacks=p.executionFallbacks??{};
 if(!fallbacks||Array.isArray(fallbacks)||typeof fallbacks!=='object'||Object.keys(fallbacks).some(t=>!['small','medium','strong'].includes(t)))throw Error('Invalid execution candidates');
 p.executionFallbacks={};
 for(const [tier,rows] of Object.entries(fallbacks)){
  if(!Array.isArray(rows))throw Error('Invalid execution candidates');
  const normalized=rows.map(normalize);
  if(normalized.some(Boolean)&&!key(p[tier])||backupKeys(p[tier],normalized,true).length!==normalized.length)throw Error('Invalid execution candidates');
  p.executionFallbacks[tier]=normalized;
 }
 p.rules=validateRules(p.rules??(p.v===2?defaultTierRules:defaultRules));
 for(const rule of p.rules.executionRules??[])if(rule.use.model)rule.use.model=normalize(rule.use.model);
 p.rules=validateRules(p.rules);
 if(p.rules.v===2&&p.v!==2)throw Error('Three-tier rules require a medium model');
 const keys=[p.small,p.medium,p.strong,p.classifier,p.model==='auto'?null:p.model,...p.classifierFallbacks,...Object.values(p.executionFallbacks).flat()].filter(Boolean);
 if(p.billing==='subscription'&&(p.classifierBilling&&p.classifierBilling!=='subscription'||keys.some(k=>!k.startsWith('yam-chatgpt/'))))throw Error('Subscription-only strategy cannot use Magpie');
 if(p.gateway===null){if(keys.some(k=>k.startsWith('yam-magpie/')))throw Error('Magpie gateway is missing');}
 else p.gateway=gateway(p.gateway);
 return p;
}
