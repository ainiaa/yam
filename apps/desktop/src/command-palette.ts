import {terminalStatuses} from "./notifications.ts";
export type PaletteSession={id:string;title:string;status:string};
export type PaletteAction="new"|"previous"|"search"|"logs"|"inbox"|"resume"|"diagnostics"|"settings"|"switch";
export type PaletteEntry={action:PaletteAction;sessionId?:string;label:string};
const commands:PaletteEntry[]=[{action:"new",label:"New session"},{action:"previous",label:"Previous session"},{action:"search",label:"Search sessions"},{action:"logs",label:"Search session logs"},{action:"inbox",label:"Open inbox"},{action:"diagnostics",label:"Export diagnostics"},{action:"settings",label:"Terminal settings"}];
const validId=(id:string)=>/^s-[a-zA-Z0-9-]{1,126}$/.test(id);
export function paletteEntries(query:string,sessions:readonly PaletteSession[],canResume:boolean):PaletteEntry[]{
 const entries=[...commands,...(canResume?[{action:"resume" as const,label:"Continue conversation (new process)"}]:[]),...sessions.map(s=>({action:"switch" as const,sessionId:s.id,label:s.title}))];
 const text=query.trim().toLocaleLowerCase();return entries.filter(entry=>entry.label.toLocaleLowerCase().includes(text)).slice(0,100);
}
export function paletteShortcut(event:Pick<KeyboardEvent,"key"|"metaKey"|"ctrlKey"|"shiftKey"|"altKey"|"isComposing"|"repeat">,dialogOpen:boolean,inputFocused:boolean):boolean{
 return !dialogOpen&&!inputFocused&&!event.isComposing&&!event.repeat&&!event.altKey&&event.shiftKey&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="p";
}
export async function executePaletteEntry(entry:PaletteEntry,actions:Partial<Record<PaletteAction,(id?:string)=>unknown>>,current:()=>boolean):Promise<boolean>{
 if(!current())return false;
 if(![...commands.map(c=>c.action),"resume","switch"].includes(entry.action)||!Object.prototype.hasOwnProperty.call(actions,entry.action)||typeof actions[entry.action]!=="function")throw Error("Command unavailable");
 if(entry.action==="switch"&&(!entry.sessionId||!validId(entry.sessionId)))throw Error("Session unavailable");
 await actions[entry.action]!(entry.sessionId);return true;
}
export function isPinnedSessions(value:unknown):value is string[]{return Array.isArray(value)&&value.length<=100&&value.every(id=>typeof id==="string"&&validId(id))&&new Set(value).size===value.length;}
export function orderPinnedSessions<T extends {id:string}>(sessions:readonly T[],pinned:readonly string[]):T[]{return [...sessions].sort((a,b)=>Number(pinned.includes(b.id))-Number(pinned.includes(a.id)));}
export function togglePinnedSession(pinned:string[],id:string):string[]{
 if(!isPinnedSessions(pinned)||!validId(id))throw Error("Invalid pinned session");
 if(pinned.includes(id))return pinned.filter(value=>value!==id);
 if(pinned.length>=100)throw Error("Pinned session limit reached");return [...pinned,id];
}
export function canCloseSessionView(status:string):boolean{return terminalStatuses.has(status);}
