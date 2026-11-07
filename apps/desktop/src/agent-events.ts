export type AgentReceipt = {id:string;revision:number;turn_id:string;kind:string;delivery:string;read:boolean;error:string|null};
export type AgentState = {cli_path?:string|null;cli_version?:string|null;cli_platform?:string|null;generation?:string;process_run?:string|null;turn_id?:string|null;revision?:number;phase:string;integration:string;agent_session_id:string|null;inbox:AgentReceipt[]};
export function unreadCount(agent?:AgentState):number{return agent?.inbox.filter(entry=>!entry.read).length??0;}
export function taskDeliveryNotice(agent?:AgentState,status='running'):string|null{
 if(status==='succeeded')return 'Process ended. Tests and task acceptance are not verified by YAM.';
 if(['failed','stopped','needs_attention'].includes(status))return 'Task status recorded. Tests and task acceptance are not verified by YAM.';
 if(!['starting','running'].includes(status))return null;
 const outcomes=['response_finished','needs_attention','failed','interrupted'];
 let outcome=agent?.integration==='connected'?agent.phase:undefined;
 if(agent?.phase==='shell'&&agent.generation&&agent.turn_id){
  const prefix=`${agent.generation}:${agent.turn_id}:`;
  for(let i=agent.inbox.length-1;i>=0;i--){
   const receipt=agent.inbox[i];
   if(receipt.turn_id===agent.turn_id&&receipt.id.startsWith(prefix)&&outcomes.includes(receipt.kind)){outcome=receipt.kind;break;}
  }
 }
 if(outcome==='response_finished'||outcome==='needs_attention')return 'Agent response available. Tests and task acceptance are not verified by YAM.';
 if(outcome==='failed'||outcome==='interrupted')return 'Agent turn failed or was interrupted. Tests and task acceptance are not verified by YAM.';
 return null;
}
export function agentLabel(agent?:AgentState,status="running"):string{
 if(agent?.phase==='shell')return ['starting','running'].includes(status)?'Shell · waiting for input':'Agent exited';
 if(!agent||agent.integration.startsWith('unavailable'))return 'Integration unavailable';
 if(agent.integration==='connecting')return ['starting','running'].includes(status)?'Awaiting trusted hook':'Integration not connected';
 if(agent.integration!=='connected')return 'Integration unavailable';
 if(agent.phase==='working'&&!['starting','running'].includes(status))return 'Round interrupted';
 return ({idle:'Ready',working:'Working',response_finished:'Response finished',needs_permission:'Permission required',interrupted:'Round interrupted',failed:'Round failed',needs_attention:'Response ready · may continue'} as Record<string,string>)[agent.phase]??'Round status unknown';
}
export function nextAttention<T extends {summary:{session_id:string};status:string;agent?:AgentState}>(records:T[],current:string|null):T|undefined{
 const priority=(record:T)=>record.agent?.inbox.some(entry=>!entry.read&&entry.kind==='needs_permission')?0:
  record.status==='failed'||record.status==='needs_attention'||record.agent?.inbox.some(entry=>!entry.read&&['interrupted','failed'].includes(entry.kind))?1:2;
 const pending=records.filter(record=>unreadCount(record.agent)>0||record.status==='needs_attention').sort((a,b)=>priority(a)-priority(b));
 if(!pending.length)return undefined;
 return pending[(pending.findIndex(record=>record.summary.session_id===current)+1)%pending.length];
}

export type Shortcuts = {attention:string;previous:string;search:string;pause:string};
export const defaultShortcuts:Shortcuts={attention:']',previous:'[',search:'k',pause:'m'};
export function isShortcuts(value:unknown):value is Shortcuts {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const entries=Object.entries(value);
 return entries.length===4&&entries.every(([key,value])=>Object.keys(defaultShortcuts).includes(key)&&typeof value==='string'&&/^[a-z\[\]]$/i.test(value))&&new Set(entries.map(([,value])=>value.toLowerCase())).size===4;
}
export function isLaunchMode(value:unknown):value is 'task'|'interactive' {return value==='task'||value==='interactive';}
export function shortcutAction(event:Pick<KeyboardEvent,'key'|'metaKey'|'ctrlKey'|'shiftKey'|'altKey'|'isComposing'|'repeat'>,shortcuts:Shortcuts,dialogOpen:boolean):keyof Shortcuts|null {
 if(dialogOpen||event.isComposing||event.repeat||event.altKey||!event.shiftKey||!(event.metaKey||event.ctrlKey))return null;
 return (Object.keys(shortcuts) as (keyof Shortcuts)[]).find(action=>shortcuts[action].toLowerCase()===event.key.toLowerCase())??null;
}
