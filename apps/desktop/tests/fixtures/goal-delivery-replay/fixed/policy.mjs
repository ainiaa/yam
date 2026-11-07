// Author: Jeff.Liu.
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export function decide(answer, previous) {
 const valid=answer&&['new','continue'].includes(answer.intent)&&['simple','complex','critical'].includes(answer.difficulty)&&typeof answer.uncertain==='boolean';
 if(!valid||answer.uncertain)return {model:'strong',effort:efforts.indexOf(previous?.effort)>2?previous.effort:'high'};
 const next={model:answer.difficulty==='simple'?'small':'strong',effort:answer.difficulty==='simple'?'medium':answer.difficulty==='critical'?'max':'high'};
 if(answer.intent==='continue'&&previous?.v===1&&['small','strong'].includes(previous.model)&&['off','minimal',...efforts].includes(previous.effort)){
  // Continuing work may become harder; a simple follow-up does not reset its safety floor.
  return {model:previous.model==='strong'?'strong':next.model,effort:efforts[Math.max(efforts.indexOf(previous.effort),efforts.indexOf(next.effort))]};
 }
 return next;
}
export function resolveEffort(model, desired, selected) {
 const supported=model?.reasoning?['minimal',...efforts].filter(level=>model.thinkingLevelMap?.[level]!=null):[];
 if(selected!=='off') {
  if(!supported.includes(selected))throw Error(`Requested reasoning ${selected} is unsupported by ${model?.id??'model'}; no silent downgrade`);
  return selected;
 }
 // Auto maps upward within a provider's advertised vocabulary; names across providers are not equivalent budgets.
 const exact=supported.find(level=>efforts.indexOf(level)>=efforts.indexOf(desired)&&(efforts.indexOf(desired)>efforts.indexOf('high')||efforts.indexOf(level)<=efforts.indexOf('high')));
 if(!exact)throw Error(`Automatic reasoning ${desired} is unsupported by ${model?.id??'model'}; choose a compatible model`);
 return exact;
}
export function guardCapacity(role,messages,small,strong) {
 if(role!=='small')return role;
 if(!small?.contextWindow||!strong?.contextWindow)return 'strong';
 const images=messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='image'));
 const bytes=new TextEncoder().encode(JSON.stringify(messages)).length;
 const reserve=Math.min(small.maxTokens??8192,Math.floor(small.contextWindow/4));
 return images||bytes+reserve>small.contextWindow?'strong':'small';
}
export function preferCachedModel(role,messages,small,strong,now=Date.now()) {
 if(role!=='small')return role;
 const index=messages.findLastIndex(m=>m.role==='assistant'),last=messages[index],u=last?.usage;
 if(last?.provider!==strong?.provider||last?.model!==strong?.id||last.stopReason!=='stop'||!Number.isFinite(last.timestamp)||now-last.timestamp<0||now-last.timestamp>300000)return role;
 if(!u||!['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(u[k])&&u[k]>=0)||!u.cacheRead)return role;
 if(![small,strong].every(m=>m?.cost&&['input','output','cacheRead'].every(k=>Number.isFinite(m.cost[k])&&m.cost[k]>=0))||!small.cost.input||!strong.cost.input)return role;
 if(!Number.isFinite(strong.contextWindow)||strong.contextWindow<=0||guardCapacity('small',messages,strong,strong)!=='small')return role;
 // shortcut: last observed cache hit is a five-minute hint, not a guarantee; require a 10% margin.
 const fresh=u.input+u.cacheWrite+u.output+new TextEncoder().encode(JSON.stringify(messages.slice(index+1))).length;
 const warm=fresh*strong.cost.input+u.cacheRead*strong.cost.cacheRead+u.output*strong.cost.output;
 const cold=(fresh+u.cacheRead)*small.cost.input+u.output*small.cost.output;
 return warm<cold*.9?'strong':role;
}
export function weakReadOnlyReply(message,prompt='') {
 if(message?.role!=='assistant'||!['stop','length'].includes(message.stopReason)||!Array.isArray(message.content)||message.content.some(b=>b.type==='toolCall'))return false;
 const text=textOf(message).trim();
 const literal=/翻译|译成|译为|原样|逐字|复述|重复|引用|\b(?:translate|translation|verbatim|repeat|quote)\b/i.test(prompt);
 return message.stopReason==='length'||!text||!literal&&text.length<=600&&/^(?:sorry[,.! ]*|抱歉[，,。 ]*)?(?:I need (?:a )?(?:stronger|more capable) model|(?:this (?:task|question) (?:is |requires .*?))?(?:beyond|exceeds) (?:my|this model['’]?s) (?:reasoning|capabilit)|(?:我)?需要更强(?:大)?(?:的)?模型|(?:这[个一]?(?:问题|任务))?超出(?:我|当前模型)(?:的)?(?:推理|能力))/i.test(text);
}
export const textOf=m=>typeof m?.content==='string'?m.content:(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export const publicExcerpt=messages=>messages.filter(m=>['user','assistant','toolResult'].includes(m.role)).slice(-6).map(m=>({role:m.role,text:textOf(m).slice(0,1200)}));
export function splitModel(value) {
 const i=value?.indexOf('/');
 if(!(i>0)||i===value.length-1||value.length>512||/[\x00-\x20]/.test(value))throw Error('Use provider/model for each routing role');
 return [value.slice(0,i),value.slice(i+1)];
}
export function launchOption(name,argv=process.argv) {
 const valued=new Set(['--extension','-e','--session','--session-dir','--model','--thinking','--provider','--yam-small','--yam-medium','--yam-strong','--yam-classifier','--yam-gateway','--yam-fixed-model','--yam-effort','--yam-rules','--tools','--skill','--append-system-prompt','--system-prompt','--prompt-template','--theme']);
 let result;
 for(let i=0;i<argv.length;i++) {
  const arg=argv[i];if(arg==='--')break;
  const equals=arg.indexOf('='),key=equals<0?arg:arg.slice(0,equals);
  if(!valued.has(key))continue;
  const value=equals<0?argv[++i]:arg.slice(equals+1);
  if(key===name)result=value;
 }
 return result;
}
