import {t} from "./i18n.ts";
import {terminalStatuses} from "./notifications.ts";
export type PaletteSession={id:string;title:string;status:string};
export type PaletteAction="clear-display"|"reopen"|"second-window"|"new"|"terminal"|"previous"|"search"|"logs"|"inbox"|"resume"|"diagnostics"|"appearance"|"settings"|"profiles"|"paste-settings"|"keyboard-shortcuts"|"switch"|"larger"|"smaller"|"reset";
export type PaletteEntry={action:PaletteAction;sessionId?:string;label:string};
const commands:PaletteEntry[]=[{action:"appearance",label:"Language and appearance"},{action:"clear-display",label:"Clear terminal display"},{action:"second-window",label:"Second terminal window"},{action:"new",label:"New session"},{action:"previous",label:"Previous session"},{action:"search",label:"Search sessions"},{action:"logs",label:"Search session logs"},{action:"inbox",label:"Open inbox"},{action:"diagnostics",label:"Export diagnostics"},{action:"settings",label:"Terminal settings"},{action:"profiles",label:"Terminal profiles"},{action:"paste-settings",label:"Paste settings"},{action:"keyboard-shortcuts",label:"Keyboard shortcuts"},{action:"larger",label:"Terminal font: larger"},{action:"smaller",label:"Terminal font: smaller"},{action:"reset",label:"Terminal font: reset"}];
const validId=(id:string)=>/^s-[a-zA-Z0-9-]{1,126}$/.test(id);
export function paletteEntries(query:string,sessions:readonly PaletteSession[],canResume:boolean,hints:Partial<Record<PaletteAction,string>>={},canReopen=false):PaletteEntry[]{
 const entries=[...commands,...(canReopen?[{action:"reopen" as const,label:"Reopen last hidden tab"}]:[]),...(canResume?[{action:"resume" as const,label:"Continue conversation (new process)"}]:[]),...sessions.map(s=>({action:"switch" as const,sessionId:s.id,label:s.title}))];
 const text=query.trim().toLocaleLowerCase();return entries.map(entry=>entry.action==="switch"?entry:{...entry,label:t(entry.label)}).filter(entry=>entry.label.toLocaleLowerCase().includes(text)).slice(0,100).map(entry=>({...entry,label:entry.label+(hints[entry.action]?" · "+hints[entry.action]:"")}));
}
export function paletteShortcut(event:Pick<KeyboardEvent,"key"|"metaKey"|"ctrlKey"|"shiftKey"|"altKey"|"isComposing"|"repeat">,dialogOpen:boolean,inputFocused:boolean):boolean{
 return !dialogOpen&&!inputFocused&&!event.isComposing&&!event.repeat&&!event.altKey&&event.shiftKey&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="p";
}
export async function executePaletteEntry(entry:PaletteEntry,actions:Partial<Record<PaletteAction,(id?:string)=>unknown>>,current:()=>boolean):Promise<boolean>{
 if(!current())return false;
 if(![...commands.map(c=>c.action),"resume","switch","reopen","terminal"].includes(entry.action)||!Object.prototype.hasOwnProperty.call(actions,entry.action)||typeof actions[entry.action]!=="function")throw Error("Command unavailable");
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
