// Author: Jeff.Liu. GUI updater boundary: no secrets or SDK objects reach storage/UI.
export type UpdaterState = "unconfigured"|"unsupported"|"idle"|"checking"|"upToDate"|"available"|"downloading"|"cancelling"|"verified"|"cancelled"|"error";
export type UpdaterSnapshot = {generation:number;state:UpdaterState;current_version:string;configured:boolean;automatic_checks:boolean;release:{version:string;notes:string;published:string|null}|null;progress:{observed:number;total:number|null}|null;reason:string|null;install_allowed:false;install_blocked_reason:"install_unavailable"};
export type UpdaterInvoke=(name:string,args?:Record<string,unknown>)=>Promise<unknown>;
const states:UpdaterState[]=["unconfigured","unsupported","idle","checking","upToDate","available","downloading","cancelling","verified","cancelled","error"];
const reasons=["gui_only","platform_unsupported","configuration_invalid","sdk_unavailable","operation_failed","deadline_exceeded","artifact_too_large"];
const bytes=(text:string)=>new TextEncoder().encode(text).length;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,expected:string[])=>Object.keys(value).length===expected.length&&Object.keys(value).every(key=>expected.includes(key));
const text=(value:unknown,max:number,empty=true)=>typeof value==="string"&&(empty||value.length>0)&&bytes(value)<=max&&!/[\x00-\x1f\x7f]/.test(value);
const count=(value:unknown,max=Number.MAX_SAFE_INTEGER)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=max;
export const updaterBusy=(state:UpdaterState)=>["checking","downloading","cancelling"].includes(state);
export function parseUpdaterSnapshot(value:unknown):UpdaterSnapshot {
 const invalid=()=>{throw Error("updater_status_invalid");};
 if(!record(value)||!keys(value,["generation","state","current_version","configured","automatic_checks","release","progress","reason","install_allowed","install_blocked_reason"]))return invalid();
 if(!count(value.generation)||!states.includes(value.state as UpdaterState)||!text(value.current_version,128,false)||typeof value.configured!=="boolean"||typeof value.automatic_checks!=="boolean"||value.install_allowed!==false||value.install_blocked_reason!=="install_unavailable"||(value.reason!==null&&!reasons.includes(value.reason as string)))return invalid();
 const release=value.release;
 if(release!==null&&(!record(release)||!keys(release,["version","notes","published"])||!text(release.version,128,false)||typeof release.notes!=="string"||bytes(release.notes)>8192||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(release.notes)||(release.published!==null&&!text(release.published,64))))return invalid();
 const progress=value.progress;
 if(progress!==null&&(!record(progress)||!keys(progress,["observed","total"])||!count(progress.observed,256*1024*1024)||(progress.total!==null&&!count(progress.total,256*1024*1024))))return invalid();
 if(["available","downloading","verified"].includes(value.state as string)&&release===null)return invalid();
 if(release!==null&&!["available","downloading","verified","cancelling"].includes(value.state as string))return invalid();
 if(progress!==null&&!["downloading","verified","cancelling"].includes(value.state as string))return invalid();
 if(value.configured===false&&!["unconfigured","unsupported"].includes(value.state as string))return invalid();
 if(value.configured===true&&["unconfigured","unsupported"].includes(value.state as string))return invalid();
 return value as UpdaterSnapshot;
}
export function loadUpdaterPreference(read:()=>string|null):{automatic:boolean;error:string|null} {
 let raw:string|null;
 try{raw=read();}catch{return {automatic:false,error:"updater_preference_unavailable"};}
 if(raw===null)return {automatic:true,error:null};
 try{if(bytes(raw)>4096)throw Error();const value:unknown=JSON.parse(raw);if(!record(value)||!keys(value,["version","automatic_checks"])||value.version!==1||typeof value.automatic_checks!=="boolean")throw Error();return {automatic:value.automatic_checks,error:null};}
 catch{return {automatic:false,error:"updater_preference_invalid"};}
}
export function saveUpdaterPreference(write:(raw:string)=>void,automatic:boolean):string|null {
 try{write(JSON.stringify({version:1,automatic_checks:automatic}));return null;}catch{return "updater_preference_unavailable";}
}
export class UpdaterController {
 snapshot:UpdaterSnapshot|null=null;
 private version=0;
 private loading:Promise<UpdaterSnapshot>|null=null;
 private started:Promise<UpdaterSnapshot|null>|null=null;
 private refreshing=false;
 accept(value:unknown):boolean {
  const next=parseUpdaterSnapshot(value),current=this.snapshot;
  if(current&&(next.generation<current.generation||(next.generation===current.generation&&!updaterBusy(current.state)&&updaterBusy(next.state))))return false;
  this.snapshot=next;return true;
 }
 load(invoke:UpdaterInvoke):Promise<UpdaterSnapshot>{
  if(!this.loading)this.loading=invoke("updater_status",{}).then(value=>{this.accept(value);return this.snapshot!;}).catch(()=>{throw Error("updater_unavailable");});
  return this.loading;
 }
 startup(invoke:UpdaterInvoke,automatic:boolean,shouldCheck:()=>boolean=()=>true):Promise<UpdaterSnapshot|null>{
  if(!this.started)this.started=(async()=>{
   await this.load(invoke);const current=this.snapshot!;
   const value=await invoke("updater_set_automatic_checks",{enabled:automatic,expected_generation:current.generation});this.accept(value);
   if(automatic&&shouldCheck()&&this.snapshot?.configured)return this.action(invoke,"check");return this.snapshot;
  })().catch(()=>{throw Error("updater_unavailable");});
  return this.started;
 }
 async action(invoke:UpdaterInvoke,action:"check"|"download"|"cancel"):Promise<UpdaterSnapshot|null>{
  if(!this.snapshot)throw Error("updater_unavailable");
  const version=++this.version;
  try{const value=await invoke("updater_"+action,{expected_generation:this.snapshot.generation});if(version!==this.version)return null;this.accept(value);return this.snapshot;}
  catch{if(version!==this.version)return null;throw Error("updater_operation_failed");}
 }
 async refresh(invoke:UpdaterInvoke):Promise<UpdaterSnapshot|null>{
  if(this.refreshing)return null;const version=this.version;this.refreshing=true;
  try{const value=await invoke("updater_status",{});if(version!==this.version)return null;this.accept(value);return this.snapshot;}
  catch{if(version!==this.version)return null;throw Error("updater_unavailable");}
  finally{this.refreshing=false;}
 }
 cancel():void{this.version++;}
}
