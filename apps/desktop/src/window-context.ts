import {isTerminalSettings,type TerminalSettings} from "./terminal-settings.ts";
// Author: Jeff.Liu. Fixed-slot bootstrap before React mount; no process launch during restore.
import {decodeTerminalLayout,type TerminalLayoutPreference} from "./terminal-layout-persistence.ts";
import {terminalMembers,removeTerminalTab,terminalSessionPane,createTerminalLayout} from "./terminal-layout.ts";
export type WindowSlot="main"|"terminal-secondary";
export type WindowContext={slot:WindowSlot;epoch:number;main_epoch:number;owned_ids:string[];conflict:boolean;restore_blocked:boolean;requested_session:string|null;preference:TerminalLayoutPreference&{present:boolean}};
type StorageRead={getItem(key:string):string|null};
type Call=<T>(name:string,args?:Record<string,unknown>)=>Promise<T>;
let context:WindowContext|null=null;
const claims=new Map<string,number>();
export function terminalWindowClaim(id:string){return claims.get(id)??0;}
export function setWindowContext(value:WindowContext){context=value;}
export function getWindowContext():WindowContext {if(!context)throw Error("Terminal window bootstrap is unavailable.");return context;}
export function windowPreferenceKey(slot:WindowSlot,name:string){return `yam.window.${slot}.${name}`;}
export function readWindowPreference(storage:StorageRead,slot:WindowSlot,name:string):string|null {const value=storage.getItem(windowPreferenceKey(slot,name));return value===null&&slot==="main"?storage.getItem(`yam.${name}`):value;}
export function readSavedWindowPreference(storage:StorageRead,slot:WindowSlot){let raw:string|null=null;try{raw=readWindowPreference(storage,slot,"terminalLayout");const preference=decodeTerminalLayout(raw);if(raw===null){const last=readWindowPreference(storage,slot,"lastSession");let id:unknown=null;try{id=last===null?null:JSON.parse(last);}catch{/* malformed last-session hint is not authority */}if(typeof id==="string"&&/^s-[a-f0-9]+-[a-f0-9]+$/.test(id)&&id.length<=64)return {...preference,layout:{...createTerminalLayout(),panes:[id]},present:true};}return {...preference,present:raw!==null};}catch{return{...decodeTerminalLayout(null),present:true,warning:"Terminal window preferences unavailable. Saved data was preserved."};}}
type NativeReadySurface={__YAM_DESKTOP_EPOCH__?:number;addEventListener(name:string,listener:()=>void):void;removeEventListener(name:string,listener:()=>void):void};
type ReadyClock={setTimeout(callback:()=>void,milliseconds:number):unknown;clearTimeout(handle:never):void};
export function waitNativeWindowEpoch(surface:NativeReadySurface,clock:ReadyClock=globalThis):Promise<number>{
 const valid=()=>Number.isSafeInteger(surface.__YAM_DESKTOP_EPOCH__)&&surface.__YAM_DESKTOP_EPOCH__!>=1;
 if(valid())return Promise.resolve(surface.__YAM_DESKTOP_EPOCH__!);
 return new Promise((resolve,reject)=>{let timer:unknown;const cleanup=()=>{surface.removeEventListener("yam-native-window-ready",ready);if(timer!==undefined)clock.clearTimeout(timer as never);};const ready=()=>{if(valid()){const epoch=surface.__YAM_DESKTOP_EPOCH__!;cleanup();resolve(epoch);}};surface.addEventListener("yam-native-window-ready",ready);timer=clock.setTimeout(()=>{cleanup();reject(Error("Native window bootstrap is unavailable. Retry when the native window is ready."));},5000);ready();});
}
export async function initializeDesktopWindow(call:Call,storage:StorageRead,expectedEpoch:number):Promise<WindowContext>{
 if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<1)throw Error("Native window bootstrap is unavailable.");
 const main=readSavedWindowPreference(storage,"main"),secondary=readSavedWindowPreference(storage,"terminal-secondary");
 const reply=await call<Omit<WindowContext,"preference">>("desktop_window_bootstrap",{mainIds:terminalMembers(main.layout),secondaryIds:terminalMembers(secondary.layout),expectedEpoch});
 if(!reply||(reply.slot!=="main"&&reply.slot!=="terminal-secondary")||!Number.isSafeInteger(reply.epoch)||reply.epoch<1||!Array.isArray(reply.owned_ids)||reply.owned_ids.length>16||reply.owned_ids.some(id=>typeof id!=="string")||new Set(reply.owned_ids).size!==reply.owned_ids.length)throw Error("Terminal window bootstrap is invalid.");
 let preference=reply.slot==="main"?main:secondary;
 if(reply.restore_blocked)preference={...decodeTerminalLayout(null),present:true,warning:"Saved windows exceed the 16-view limit. Saved data was preserved; start a new terminal to use a blank workspace."};
 else {let layout=preference.layout;for(const id of terminalMembers(layout)){if(!reply.owned_ids.includes(id)){const pane=terminalSessionPane(layout,id);layout=removeTerminalTab(layout,pane,id);}}preference={...preference,layout,...(preference.appearances===undefined?{}:{appearances:Object.fromEntries(Object.entries(preference.appearances).filter(([id])=>terminalMembers(layout).includes(id)))}),...(preference.recordedOnly===undefined?{}:{recordedOnly:preference.recordedOnly.filter(id=>terminalMembers(layout).includes(id))})};}
 return {...reply,preference};
}
export type TerminalMoveReceipt={token:number;session_id:string;source:WindowSlot;source_epoch:number;source_generation:number;target:WindowSlot;target_epoch:number;target_generation:number;appearance:TerminalSettings;phase:"awaiting_source"|"awaiting_target"|"completed";source_destroyed:boolean;target_destroyed:boolean;accepted:boolean};
export type TerminalMoveReply={status:"pending"|"completed";receipt:TerminalMoveReceipt}|{status:"resume";generation:number}|{status:"unavailable"|"busy"|"stale"};
export function terminalMoveReply(value:unknown):TerminalMoveReply{
 const bad=()=>{throw Error("Terminal move response is unavailable. Check/Continue move to reconcile it.");};
 if(!value||typeof value!=="object"||Array.isArray(value))return bad();
 const v=value as Record<string,unknown>,integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;
 const own=(v:object,keys:string[])=>{const proto=Object.getPrototypeOf(v);return (proto===Object.prototype||proto===null)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d&&Object.prototype.hasOwnProperty.call(d,"value");});};
 const status=Object.getOwnPropertyDescriptor(v,"status");if(!status||!Object.prototype.hasOwnProperty.call(status,"value"))return bad();
 if(["unavailable","busy","stale"].includes(status.value)&&own(v,["status"]))return v as TerminalMoveReply;
 if(status.value==="resume"&&own(v,["status","generation"])&&integer(v.generation))return v as TerminalMoveReply;
 if(!["pending","completed"].includes(status.value)||!own(v,["status","receipt"]))return bad();
 const r=v.receipt as TerminalMoveReceipt;
 if(!r||typeof r!=="object"||Array.isArray(r)||!own(r,["token","session_id","source","source_epoch","source_generation","target","target_epoch","target_generation","appearance","phase","source_destroyed","target_destroyed","accepted"]))return bad();
 if(!integer(r.token)||!integer(r.source_epoch)||!integer(r.source_generation)||!integer(r.target_epoch)||!["main","terminal-secondary"].includes(r.source)||!["main","terminal-secondary"].includes(r.target)||r.source===r.target||typeof r.session_id!=="string"||!/^s-[a-zA-Z0-9-]+$/.test(r.session_id)||r.session_id.length>128||!["awaiting_source","awaiting_target","completed"].includes(r.phase)||typeof r.source_destroyed!=="boolean"||typeof r.target_destroyed!=="boolean"||typeof r.accepted!=="boolean")return bad();
 if((r.phase==="awaiting_source"?r.target_generation!==0:!integer(r.target_generation))||(status.value==="completed")!==(r.phase==="completed"))return bad();
 if(!r.appearance||typeof r.appearance!=="object"||!own(r.appearance,["fontFamily","fontSize","theme"])||!isTerminalSettings(r.appearance))return bad();
 return {...v,receipt:{...r,appearance:{...r.appearance}}} as TerminalMoveReply;
}
const guarded=new Set(["read_terminal_frame","read_session_snapshot","write_session","resize_session","set_terminal_viewport","take_terminal_control","set_notification_locale","set_agent_notification_context","claim_terminal_view","release_terminal_view","open_terminal_window","open_main_settings","terminal_input_focused","request_main_terminal_zoom","preview_terminal_file","reveal_terminal_file","prepare_terminal_move","query_terminal_move","reconcile_terminal_move","accept_terminal_move","complete_terminal_move","recover_terminal_move"]);
export async function desktopInvoke<T>(call:Call,snapshot:Pick<WindowContext,"slot"|"epoch">,name:string,args:Record<string,unknown>={}):Promise<T>{
 const epoch=snapshot.epoch;
 if(name==="claim_terminal_view"){const generation=await call<number|null>(name,{...args,desktopEpoch:epoch});if(generation!==null&&(!Number.isSafeInteger(generation)||generation<1))throw Error("Terminal view claim is invalid.");if(generation!==null)claims.set(String(args.sessionId),generation);return generation as T;}
 if(name==="create_session") {
  const launch=args.launch as {provider?:unknown;env_refs?:Record<string,string>}|null|undefined;
  const provider=!!(launch?.provider||launch?.env_refs&&Object.keys(launch.env_refs).length||args.resumeFrom||args.projectConfig);
  const upgrade="Provider sessions require the updated YAM app and background owner. Fully quit and reopen YAM.";
  if(provider){let version:unknown;try{version=await call("provider_protocol_version");}catch{throw Error(upgrade);}if(version!==1)throw Error(upgrade);}
  const reservation=await call<number>("reserve_terminal_start",{desktopEpoch:epoch,...(typeof args.resumeFrom==="string"?{resumeFrom:args.resumeFrom}:{})});
  try{return await call<T>(name,{...args,desktopEpoch:epoch,desktopReservation:reservation});}catch(error){if(provider&&/Invalid background (command arguments|launch fields)/.test(String(error)))throw Error(upgrade);throw error;}
 }
 if(name==="release_terminal_view") {const result=await call<T>(name,{...args,desktopEpoch:epoch});const id=String(args.sessionId);if(args.moveToken!==undefined){const reply=terminalMoveReply(result);if(reply.status==="pending"||reply.status==="completed"){const r=reply.receipt;if(r.token!==args.moveToken||r.session_id!==id||r.source!==snapshot.slot||r.source_epoch!==epoch||r.source_generation!==args.desktopGeneration)throw Error("Terminal move acknowledgment is stale.");if(r.phase!=="awaiting_source"&&claims.get(id)===args.desktopGeneration)claims.delete(id);}return reply as T;}if(claims.get(id)===args.desktopGeneration)claims.delete(id);return result;}
 if(["prepare_terminal_move","query_terminal_move","reconcile_terminal_move","accept_terminal_move","complete_terminal_move","recover_terminal_move"].includes(name)){
  const reply=terminalMoveReply(await call<unknown>(name,{...args,desktopEpoch:epoch}));
  if(name==="query_terminal_move"&&(reply.status==="pending"||reply.status==="completed")){const r=reply.receipt;if(r.source===snapshot.slot&&r.source_epoch===epoch&&r.phase!=="awaiting_source"&&claims.get(r.session_id)===r.source_generation)claims.delete(r.session_id);}
  if(name==="reconcile_terminal_move"&&reply.status==="resume"){const id=String(args.sessionId);if(claims.get(id)!==args.desktopGeneration)throw Error("Terminal move generation changed.");claims.set(id,reply.generation);}
  if(name==="accept_terminal_move"&&(reply.status==="pending"||reply.status==="completed")){const r=reply.receipt;if(r.token!==args.token||r.target!==snapshot.slot||r.target_epoch!==epoch||r.phase==="awaiting_source"||!r.accepted)throw Error("Terminal move target is stale.");if((claims.get(r.session_id)??0)>r.target_generation)throw Error("Terminal move generation changed.");claims.set(r.session_id,r.target_generation);}
  return reply as T;
 }
 return call<T>(name,guarded.has(name)?{...args,desktopEpoch:epoch}:args);
}

type WindowStorage={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void};
export function createWindowStorage(storage:WindowStorage,snapshot:Pick<WindowContext,"slot"|"epoch">,publish:(key:string,value:string|null)=>void):WindowStorage {
 const own=`yam.window.${snapshot.slot}.`;
 const writable=(key:string)=>{if(key.startsWith("yam.window.")&&!key.startsWith(own))throw Error("Other window preferences are unavailable.");if(snapshot.slot!=="main"&&!key.startsWith(own))throw Error("Shared preferences must be changed in the main window.");};
 return {getItem:key=>storage.getItem(key),setItem(key,value){writable(key);storage.setItem(key,value);if(!key.startsWith(own)&&key!=="yam.terminalSettings")publish(key,value);},removeItem(key){writable(key);storage.removeItem(key);if(!key.startsWith(own))publish(key,null);}};
}
let preferenceFlight=Promise.resolve();
export function publishWindowPreference(call:Call,snapshot:Pick<WindowContext,"slot"|"epoch">,key:string,value:string|null,appearanceAction:string|null=null):Promise<void>{
 if(snapshot.slot!=="main")return Promise.reject(Error("Shared preferences must be changed in the main window."));
 const args={desktopEpoch:snapshot.epoch,key,value,appearanceAction};
 const next=preferenceFlight.then(()=>call<void>("commit_window_preferences",args));preferenceFlight=next.catch(()=>{});return next;
}
export type WindowPreferenceCommit={source_epoch:number;revision:number;key:string;value:string|null;appearance_action:"apply"|"larger"|"smaller"|"reset"|null};
export function acceptWindowPreferenceCommit(value:unknown,mainEpoch:number,lastRevision:number):value is WindowPreferenceCommit {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const row=value as WindowPreferenceCommit;return row.source_epoch===mainEpoch&&Number.isSafeInteger(row.revision)&&row.revision>lastRevision&&typeof row.key==="string"&&row.key.startsWith("yam.")&&!row.key.startsWith("yam.window.")&&(row.value===null||typeof row.value==="string")&&(row.appearance_action===null||["apply","larger","smaller","reset"].includes(row.appearance_action));
}
