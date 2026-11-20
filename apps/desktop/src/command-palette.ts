import {t} from "./i18n.ts";
import {terminalStatuses} from "./notifications.ts";
import type {HistoryCursor,HistoryItem,HistoryPage} from './history';
export type PaletteSession={id:string;title:string;status:string;project?:string;cwd?:string;agent?:string};
export type PaletteAction="clear-display"|"reopen"|"second-window"|"new"|"terminal"|"previous"|"search"|"logs"|"inbox"|"resume"|"diagnostics"|"appearance"|"settings"|"profiles"|"paste-settings"|"keyboard-shortcuts"|"pi-routing"|"updates"|"launch-settings"|"switch"|"larger"|"smaller"|"reset";
export type PaletteEntry={action:PaletteAction;sessionId?:string;label:string;detail?:string};
const commands:PaletteEntry[]=[{action:"appearance",label:"Language and appearance"},{action:"clear-display",label:"Clear terminal display"},{action:"second-window",label:"Second terminal window"},{action:"new",label:"New session"},{action:"previous",label:"Previous session"},{action:"search",label:"Search sessions"},{action:"logs",label:"Search session logs"},{action:"inbox",label:"Open inbox"},{action:"diagnostics",label:"Export diagnostics"},{action:"settings",label:"Terminal settings"},{action:"profiles",label:"Terminal profiles"},{action:"paste-settings",label:"Paste settings"},{action:"keyboard-shortcuts",label:"Keyboard shortcuts"},{action:"pi-routing",label:"Automatic routing"},{action:"updates",label:"Updates"},{action:"launch-settings",label:"Launch templates and defaults"},{action:"larger",label:"Terminal font: larger"},{action:"smaller",label:"Terminal font: smaller"},{action:"reset",label:"Terminal font: reset"}];
const validId=(id:string)=>/^s-[a-zA-Z0-9-]{1,126}$/.test(id);
export function paletteEntries(query:string,sessions:readonly PaletteSession[],canResume:boolean,hints:Partial<Record<PaletteAction,string>>={},canReopen=false):PaletteEntry[]{
 const entries:PaletteEntry[]=[...commands,...(canReopen?[{action:"reopen" as const,label:"Reopen last hidden session"}]:[]),...(canResume?[{action:"resume" as const,label:"Continue conversation (new process)"}]:[]),...sessions.map(s=>({action:"switch" as const,sessionId:s.id,label:s.title,detail:[s.project,s.cwd,s.agent,s.status].filter(Boolean).join(" · ")}))];
 const terms=query.trim().toLocaleLowerCase().split(/\s+/);
 return entries.map(entry=>entry.action==="switch"?entry:{...entry,label:t(entry.label)}).filter(entry=>terms.every(term=>(entry.label+" "+(entry.detail??"")).toLocaleLowerCase().includes(term))).slice(0,100).map(entry=>({...entry,label:entry.label+(hints[entry.action]?" · "+hints[entry.action]:"")}));
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

export class PaletteHistorySearch {
 items:(HistoryItem&{archived:boolean})[]=[];
 loading=false;
 error:string|null=null;
 query='';
 private version=0;
 private cursors:{history:HistoryCursor|null;archive:HistoryCursor|null}={history:null,archive:null};
 get hasMore(){return !!(this.cursors.history||this.cursors.archive);}
 cancel(){this.version++;this.loading=false;}
 async load(invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>,request:Record<string,unknown>,more=false){
  if(more&&(this.loading||!this.hasMore))return;
  const version=++this.version;
  if(!more){this.items=[];this.cursors={history:null,archive:null};this.query=String(request.query??'');}
  this.loading=true;this.error=null;
  try{
   const sources=[['history','list_session_summaries'],['archive','list_archived_sessions']] as const;
   const pages=await Promise.all(sources.filter(([key])=>!more||this.cursors[key]).map(async([key,command])=>({key,page:await invoke(command,{request:{...request,cursor:more?this.cursors[key]:null}}) as HistoryPage<HistoryItem>})));
   if(version!==this.version)return;
   const items=new Map(this.items.map(item=>[item.summary.session_id,item]));
   for(const {key,page} of pages){for(const item of page.items)if(!items.has(item.summary.session_id))items.set(item.summary.session_id,{...item,archived:key==='archive'});this.cursors[key]=page.next_cursor;}
   this.items=[...items.values()];
  }catch{if(version===this.version)this.error='Could not search all history. Retry to refresh the results.';}
  finally{if(version===this.version)this.loading=false;}
 }
}
