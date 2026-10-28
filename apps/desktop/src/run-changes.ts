// Author: Jeff.Liu. Explicit baseline controls, scoped to the selected local session.
import type {FilesInvoke} from './project-files.ts';
export type BaselineInfo={id:string;root:string;captured_at:number;files:number;skipped:number};
export type RunRow={path:string;kind:'modified'|'deleted'|'restored'|'unrecorded'|'untracked'|'untracked_removed'|'unavailable'};
export type RunReport={baseline:BaselineInfo;rows:RunRow[];skipped:number;patch:{path:string;text:string}|null};
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string)=>Object.keys(v).sort().join(',')===names;
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(v);
const path=(v:unknown):v is string=>safe(v)&&!v.startsWith('/')&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='.git');
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=2048;
const info=(v:unknown):v is BaselineInfo=>plain(v)&&keys(v,'captured_at,files,id,root,skipped')&&typeof v.id==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(v.id)&&safe(v.root)&&v.root.startsWith('/')&&Number.isSafeInteger(v.captured_at)&&(v.captured_at as number)>=0&&count(v.files)&&count(v.skipped)&&(v.skipped as number)<=(v.files as number);
const kinds=new Set(['modified','deleted','restored','unrecorded','untracked','untracked_removed','unavailable']);
const errors=new Set(['round_limit','round_storage_full','round_capture_changed','round_context_changed','round_baseline_changed','round_comparison_unavailable','round_busy','round_timeout','round_invalid_response','round_unavailable','file_platform_unavailable','file_session_unavailable','git_busy','git_missing','git_timeout','git_output_limit','git_external_filter','git_not_repository','git_conversion_unsupported','git_attributes_unsupported','git_submodule_unavailable','git_context_changed']);
function report(v:unknown,baseline:BaselineInfo,selected:string|null):v is RunReport {
 if(!plain(v)||!keys(v,'baseline,patch,rows,skipped')||!info(v.baseline)||!count(v.skipped)||!Array.isArray(v.rows)||v.rows.length>2048)return false;
 if(Object.entries(baseline).some(([key,value])=>Reflect.get(v.baseline as object,key)!==value))return false;
 if(!v.rows.every(row=>plain(row)&&keys(row,'kind,path')&&path(row.path)&&typeof row.kind==='string'&&kinds.has(row.kind))||new Set(v.rows.map(row=>row.path)).size!==v.rows.length)return false;
 if(selected===null)return v.patch===null;
 return plain(v.patch)&&keys(v.patch,'path,text')&&v.patch.path===selected&&v.rows.some(row=>row.path===selected&&['modified','deleted','restored'].includes(row.kind))&&typeof v.patch.text==='string'&&!v.patch.text.includes('\0')&&new TextEncoder().encode(v.patch.text).length<=262144;
}
export class RunChangesController {
 scope='';sessionId='';baseline:BaselineInfo|null=null;report:RunReport|null=null;busy=false;error:string|null=null;private generation=0;
 select(sessionId:string|null,root:string):void{const scope=JSON.stringify([sessionId,root]);if(scope===this.scope)return;this.cancel();this.scope=scope;this.sessionId=sessionId??'';this.baseline=null;this.report=null;this.error=null;}
 cancel():void{this.generation++;this.busy=false;}
 private async request(invoke:FilesInvoke,name:string,args:Record<string,unknown>,accept:(value:unknown)=>void):Promise<void>{
  if(this.busy||!this.sessionId)return;const generation=this.generation;this.busy=true;this.error=null;
  try{const value=await invoke(name,{session_id:this.sessionId,...args});if(generation===this.generation)accept(value);}
  catch(reason){if(generation===this.generation)this.error=typeof reason==='string'&&errors.has(reason)?reason:'round_unavailable';}
  finally{if(generation===this.generation)this.busy=false;}
 }
 async load(invoke:FilesInvoke):Promise<void>{await this.request(invoke,'get_run_baseline_info',{},value=>{if(value!==null&&!info(value))throw 'round_invalid_response';this.baseline=value;this.report=null;});}
 async capture(invoke:FilesInvoke):Promise<void>{await this.request(invoke,'capture_run_baseline',{expected_id:this.baseline?.id??null},value=>{if(!info(value))throw 'round_invalid_response';this.baseline=value;this.report=null;});}
 async compare(invoke:FilesInvoke,selected:string|null=null):Promise<void>{const baseline=this.baseline;if(!baseline)return;await this.request(invoke,'compare_run_baseline',{baseline_id:baseline.id,path:selected},value=>{if(!report(value,baseline,selected))throw 'round_invalid_response';this.report=value;});}
 async clear(invoke:FilesInvoke):Promise<void>{const baseline=this.baseline;if(!baseline)return;await this.request(invoke,'clear_run_baseline',{baseline_id:baseline.id},value=>{if(value!==null)throw 'round_invalid_response';this.baseline=null;this.report=null;});}
}
