// Author: Jeff.Liu. Personal ordinary-terminal profiles; storage never executes a launch.
import {isTerminalSettings,type TerminalSettings} from "./terminal-settings.ts";
import {isShellLaunch,type ShellLaunch} from "./shell-launch.ts";
export const TERMINAL_PROFILE_STORAGE_KEY="yam.terminalProfiles.v3";
export const TERMINAL_PROFILE_WRITE_ERROR="Could not save terminal profiles.";
const loadError="Terminal profiles are unavailable or invalid. Saved data has not been overwritten.";
const invalid="Terminal profiles are invalid.";
const utf8=new TextEncoder();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ProfileCwd={mode:"context"|"home";path:null}|{mode:"explicit";path:string};
export type TerminalProfileDraft={name:string;shell:ShellLaunch|null;cwd:ProfileCwd;envRefs:Record<string,string>;appearance:TerminalSettings|null};
export type TerminalProfile=TerminalProfileDraft&{id:string};
export type TerminalProfilesStore={version:3;profiles:TerminalProfile[];defaultId:string|null};
function exactDataRecord(value:unknown,keys:string[]):value is Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||!keys.every(key=>own.includes(key)))return false;
 return keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return !!d&&d.enumerable&&Object.prototype.hasOwnProperty.call(d,"value");});
}
function denseArray(value:unknown):value is unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return false;
 if(Reflect.ownKeys(value).length!==value.length+1)return false;
 for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!Object.prototype.hasOwnProperty.call(d,"value"))return false;}
 return true;
}
function validShell(value:unknown):value is ShellLaunch|null{return value===null||(exactDataRecord(value,["program","login"])&&(isShellLaunch(value,false)||isShellLaunch(value,true)));}
function profilePathAbsolute(path:string,windows:boolean):boolean{return windows?/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(path):path.startsWith("/");}
function validCwd(value:unknown):value is ProfileCwd{
 if(!exactDataRecord(value,["mode","path"]))return false;
 if(value.mode==="context"||value.mode==="home")return value.path===null;
 if(value.mode!=="explicit"||typeof value.path!=="string"||value.path!==value.path.trim())return false;
 return utf8.encode(value.path).length<=4096&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value.path)&&(profilePathAbsolute(value.path,false)||profilePathAbsolute(value.path,true));
}
export function normalizeProfileName(value:string):string{
 if(typeof value!=="string")throw Error("Terminal profile name is required.");
 const name=value.trim();if(!name||[...name].length>80)throw Error("Terminal profile name must contain 1–80 characters.");return name;
}
export function copyProfileEnvRefs(refs:Record<string,string>):Record<string,string>{
 const result:Record<string,string>={};for(const key of Object.keys(refs))Object.defineProperty(result,key,{value:refs[key],enumerable:true,writable:true,configurable:true});return result;
}
function validEnvRefs(value:unknown):value is Record<string,string>{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const keys=Reflect.ownKeys(value);if(keys.length>32)return false;const seen=new Set<string>();
 for(const key of keys){if(typeof key!=="string"||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)||key.toUpperCase().startsWith("YAM_")||seen.has(key.toUpperCase()))return false;seen.add(key.toUpperCase());const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.prototype.hasOwnProperty.call(d,"value")||typeof d.value!=="string"||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(d.value)||d.value.toUpperCase().startsWith("YAM_"))return false;}return true;
}
export function profileEnvRefsFromRows(rows:{target:string;source:string}[]):Record<string,string>{
 const refs:Record<string,string>={},seen=new Set<string>();for(const row of rows){const key=row.target.toUpperCase();if(seen.has(key))throw Error("Environment reference targets must be unique.");seen.add(key);Object.defineProperty(refs,row.target,{value:row.source,enumerable:true,writable:true,configurable:true});}if(!validEnvRefs(refs))throw Error("Use at most 32 environment references with valid variable names; YAM_ names are reserved.");return refs;
}
function validAppearance(value:unknown):value is TerminalSettings|null{return value===null||(exactDataRecord(value,["fontFamily","fontSize","theme"])&&isTerminalSettings(value));}
function validProfile(value:unknown):value is TerminalProfile{
 if(!exactDataRecord(value,["id","name","shell","cwd","envRefs","appearance"]))return false;
 return typeof value.id==="string"&&uuid.test(value.id)&&typeof value.name==="string"&&value.name===value.name.trim()&&value.name.length>0&&[...value.name].length<=80&&validShell(value.shell)&&validCwd(value.cwd)&&validEnvRefs(value.envRefs)&&validAppearance(value.appearance);
}
function validStore(value:unknown):value is TerminalProfilesStore{
 if(!exactDataRecord(value,["version","profiles","defaultId"])||value.version!==3||!denseArray(value.profiles)||value.profiles.length>32)return false;
 if(!value.profiles.every(validProfile))return false;
 const rows=value.profiles as TerminalProfile[];
 return new Set(rows.map(row=>row.id)).size===rows.length&&new Set(rows.map(row=>row.name)).size===rows.length&&(value.defaultId===null||(typeof value.defaultId==="string"&&rows.some(row=>row.id===value.defaultId)));
}
function copyProfile(row:TerminalProfile):TerminalProfile{return{id:row.id,name:row.name,shell:row.shell===null?null:{program:row.shell.program,login:row.shell.login},cwd:{...row.cwd},envRefs:copyProfileEnvRefs(row.envRefs),appearance:row.appearance===null?null:{...row.appearance}};}
export function decodeTerminalProfiles(raw:string|null):TerminalProfilesStore{
 if(raw===null)return{version:3,profiles:[],defaultId:null};
 if(typeof raw!=="string"||raw.length>524288)throw Error("Terminal profile storage exceeds the size limit.");
 let value:unknown;try{value=JSON.parse(raw);}catch{throw Error(invalid);}
 if(!validStore(value))throw Error(invalid);return{version:3,profiles:value.profiles.map(copyProfile),defaultId:value.defaultId};
}
function migrateTerminalProfiles(raw:string|null,version:1|2):TerminalProfilesStore{
 if(raw===null)return decodeTerminalProfiles(null);if(typeof raw!=="string"||raw.length>524288)throw Error(invalid);let value:unknown;try{value=JSON.parse(raw);}catch{throw Error(invalid);}
 if(!exactDataRecord(value,["version","profiles","defaultId"])||value.version!==version||!denseArray(value.profiles))throw Error(invalid);
 const rows=value.profiles.map(row=>{if(!exactDataRecord(row,version===1?["id","name","shell","cwd"]:["id","name","shell","cwd","envRefs"]))throw Error(invalid);return{...row,...(version===1?{envRefs:{}}:{}),appearance:null};});const migrated={version:3 as const,profiles:rows,defaultId:value.defaultId};if(!validStore(migrated))throw Error(invalid);return{version:3,profiles:migrated.profiles.map(copyProfile),defaultId:migrated.defaultId};
}
export function encodeTerminalProfiles(store:TerminalProfilesStore):string{
 if(!validStore(store))throw Error(invalid);
 // Null prototypes prevent inherited serialization hooks from running at any depth.
 const rows=store.profiles.map(row=>Object.assign(Object.create(null),{id:row.id,name:row.name,shell:row.shell===null?null:Object.assign(Object.create(null),{program:row.shell.program,login:row.shell.login}),cwd:Object.assign(Object.create(null),{mode:row.cwd.mode,path:row.cwd.path}),envRefs:Object.assign(Object.create(null),copyProfileEnvRefs(row.envRefs)),appearance:row.appearance===null?null:Object.assign(Object.create(null),{fontFamily:row.appearance.fontFamily,fontSize:row.appearance.fontSize,theme:row.appearance.theme})}));
 Object.setPrototypeOf(rows,null);
 const raw=JSON.stringify(Object.assign(Object.create(null),{version:3,profiles:rows,defaultId:store.defaultId}));
 if(raw.length>524288)throw Error("Terminal profile storage exceeds the size limit.");return raw;
}
function target(rows:TerminalProfile[],id:string):TerminalProfile{const row=rows.find(row=>row.id===id);if(!row)throw Error("Selected terminal profile is unavailable.");return row;}
function candidate(id:string,draft:TerminalProfileDraft):TerminalProfile{
 if(!exactDataRecord(draft,["name","shell","cwd","envRefs","appearance"]))throw Error(invalid);
 const row={id,name:normalizeProfileName(draft.name as string),shell:draft.shell,cwd:draft.cwd,envRefs:draft.envRefs,appearance:draft.appearance};
 if(!validProfile(row))throw Error("Use a valid shell and an absolute directory of at most 4096 UTF-8 bytes without control characters or surrounding whitespace.");
 return copyProfile(row);
}
export class TerminalProfileCollection{
 profiles:TerminalProfile[]=[];defaultId:string|null=null;selectedId:string|null=null;loadError:string|null=null;writeError:string|null=null;
 private readonly storage:Pick<Storage,"getItem"|"setItem">;private readonly makeId:()=>string;
 constructor(storage:Pick<Storage,"getItem"|"setItem">,makeId:()=>string=()=>crypto.randomUUID()){this.storage=storage;this.makeId=makeId;}
 load():void{try{const current=this.storage.getItem(TERMINAL_PROFILE_STORAGE_KEY);const old=current===null?this.storage.getItem("yam.terminalProfiles.v2"):null;const value=current!==null?decodeTerminalProfiles(current):old!==null?migrateTerminalProfiles(old,2):migrateTerminalProfiles(this.storage.getItem("yam.terminalProfiles.v1"),1);this.profiles=value.profiles;this.defaultId=value.defaultId;this.loadError=null;}catch{this.profiles=[];this.defaultId=null;this.loadError=loadError;}this.selectedId=null;}
 select(id:string|null):void{if(id!==null)target(this.profiles,id);this.selectedId=id;}
 private commit(rows:TerminalProfile[],defaultId:string|null,selectedId:string|null):void{
  try{this.storage.setItem(TERMINAL_PROFILE_STORAGE_KEY,encodeTerminalProfiles({version:3,profiles:rows,defaultId}));}catch{this.writeError=TERMINAL_PROFILE_WRITE_ERROR;throw Error(TERMINAL_PROFILE_WRITE_ERROR);}
  this.profiles=rows;this.defaultId=defaultId;this.selectedId=selectedId;this.writeError=null;this.loadError=null;
 }
 private unique(row:TerminalProfile,exceptId?:string):void{
  if(!uuid.test(row.id)||this.profiles.some(existing=>existing.id===row.id&&existing.id!==exceptId))throw Error("Terminal profile ID is invalid or already exists.");
  if(this.profiles.some(existing=>existing.name===row.name&&existing.id!==exceptId))throw Error("Terminal profile name already exists.");
 }
 save(draft:TerminalProfileDraft):TerminalProfile{
  if(this.profiles.length>=32)throw Error("Terminal profile limit reached.");const row=candidate(this.makeId(),draft);this.unique(row);this.commit([...this.profiles,row],this.defaultId,row.id);return copyProfile(row);
 }
 update(id:string,draft:TerminalProfileDraft):TerminalProfile{target(this.profiles,id);const row=candidate(id,draft);this.unique(row,id);this.commit(this.profiles.map(existing=>existing.id===id?row:existing),this.defaultId,id);return copyProfile(row);}
 duplicate(id:string):TerminalProfile{
  const source=target(this.profiles,id);if(this.profiles.length>=32)throw Error("Terminal profile limit reached.");const newId=this.makeId();
  if(!uuid.test(newId)||this.profiles.some(row=>row.id===newId))throw Error("Terminal profile ID is invalid or already exists.");
  for(let n=1;n<=33;n++){const suffix=n===1?" (copy)":` (copy ${n})`,name=[...source.name].slice(0,80-[...suffix].length).join("")+suffix;if(!this.profiles.some(row=>row.name===name)){const row=copyProfile({...source,id:newId,name});this.commit([...this.profiles,row],this.defaultId,newId);return copyProfile(row);}}
  throw Error("Could not find a unique terminal profile copy name.");
 }
 delete(id:string):void{target(this.profiles,id);this.commit(this.profiles.filter(row=>row.id!==id),this.defaultId===id?null:this.defaultId,null);}
 setDefault(id:string|null):void{if(id!==null)target(this.profiles,id);this.commit(this.profiles,id,this.selectedId);}
}
export function terminalProfileStart(store:TerminalProfilesStore,selectedId:string|null|undefined,path:string|undefined,context:string,preference:ShellLaunch|null,windows:boolean,globalAppearance?:TerminalSettings):{cwd:string;command:string;launch:null;shell?:ShellLaunch;envRefs?:Record<string,string>;appearance?:TerminalSettings}{
 if(selectedId!==null&&!validStore(store))throw Error("Selected terminal profile is unavailable.");
 const id=selectedId===null?null:selectedId===undefined?store.defaultId:selectedId,row=id===null?null:target(store.profiles,id);
 const shell=row?row.shell:preference;
 if(shell!==null&&(!exactDataRecord(shell,["program","login"])||!isShellLaunch(shell,windows)))throw Error("This terminal profile shell is unavailable on this platform. Choose a compatible profile or Current default.");
 if(path===undefined&&row?.cwd.mode==="explicit"&&!profilePathAbsolute(row.cwd.path,windows))throw Error("This terminal profile directory is unavailable on this platform. Choose a compatible absolute directory.");
 const refs=row?.envRefs;if(refs&&Object.keys(refs).length){if(shell===null)throw Error("Select System default or an explicit supported shell to use environment references.");if(Object.keys(refs).some(key=>windows?["USERPROFILE","PATHEXT"].includes(key.toUpperCase()):key==="SHELL"))throw Error("These environment reference targets are unavailable for this platform.");}
 const cwd=path!==undefined?path:row?.cwd.mode==="home"?"":row?.cwd.mode==="explicit"?row.cwd.path:context;
 const appearance=row?.appearance??globalAppearance;
 return{cwd,command:"",launch:null,...(appearance?{appearance:{...appearance}}:{}),...(shell===null?{}:{shell:{program:shell.program,login:shell.login}}),...(refs&&Object.keys(refs).length?{envRefs:copyProfileEnvRefs(refs)}:{})};
}
