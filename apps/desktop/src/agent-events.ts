export type AgentReceipt = {id:string;revision:number;turn_id:string;kind:string;delivery:string;read:boolean;error:string|null};
export type AgentState = {phase:string;integration:string;agent_session_id:string|null;inbox:AgentReceipt[]};
export function unreadCount(agent?:AgentState):number{return agent?.inbox.filter(entry=>!entry.read).length??0;}
export function agentLabel(agent?:AgentState,status="running"):string{
 if(!agent||agent.integration.startsWith('unavailable'))return 'Integration unavailable';
 if(agent.integration==='connecting')return 'Awaiting trusted hook';
 if(agent.phase==='working'&&!['starting','running'].includes(status))return 'Round interrupted';
 return ({idle:'Ready',working:'Working',response_finished:'Response finished',needs_permission:'Permission required',interrupted:'Round interrupted'} as Record<string,string>)[agent.phase]??'Round status unknown';
}
export function nextAttention<T extends {summary:{session_id:string};status:string;agent?:AgentState}>(records:T[],current:string|null):T|undefined{
 const priority=(record:T)=>record.agent?.inbox.some(entry=>!entry.read&&entry.kind==='needs_permission')?0:
  record.status==='failed'||record.status==='needs_attention'||record.agent?.inbox.some(entry=>!entry.read&&entry.kind==='interrupted')?1:2;
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
