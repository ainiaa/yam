// Author: Jeff.Liu.
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export function decide(answer, previous) {
 const valid=answer&&['new','continue'].includes(answer.intent)&&['simple','complex','critical'].includes(answer.difficulty)&&typeof answer.uncertain==='boolean';
 if(!valid||answer.uncertain)return {model:'strong',effort:efforts.indexOf(previous?.effort)>2?previous.effort:'high'};
 if(answer.intent==='continue'&&previous?.v===1&&['small','strong'].includes(previous.model)&&efforts.includes(previous.effort))return {model:previous.model,effort:previous.effort};
 return {model:answer.difficulty==='simple'?'small':'strong',effort:answer.difficulty==='simple'?'medium':answer.difficulty==='critical'?'max':'high'};
}
export function resolveEffort(model, desired, selected) {
 const supported=model?.reasoning?['minimal',...efforts].filter(level=>model.thinkingLevelMap?.[level]!=null):[];
 if(selected!=='off') {
  if(!supported.includes(selected))throw Error(`Requested reasoning ${selected} is unsupported by ${model?.id??'model'}; no silent downgrade`);
  return selected;
 }
 // Auto maps upward within a provider's advertised vocabulary; names across providers are not equivalent budgets.
 const exact=supported.find(level=>efforts.indexOf(level)>=efforts.indexOf(desired));
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
export const textOf=m=>typeof m?.content==='string'?m.content:(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export const publicExcerpt=messages=>messages.filter(m=>['user','assistant','toolResult'].includes(m.role)).slice(-6).map(m=>({role:m.role,text:textOf(m).slice(0,1200)}));
export function splitModel(value) {
 const i=value?.indexOf('/');
 if(!(i>0)||i===value.length-1||value.length>512||/[\x00-\x20]/.test(value))throw Error('Use provider/model for each routing role');
 return [value.slice(0,i),value.slice(i+1)];
}
export function launchOption(name,argv=process.argv) {
 const valued=new Set(['--extension','-e','--session','--session-dir','--model','--thinking','--provider','--yam-small','--yam-strong','--yam-classifier','--yam-gateway','--yam-fixed-model','--yam-effort','--tools','--skill','--append-system-prompt','--system-prompt','--prompt-template','--theme']);
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
