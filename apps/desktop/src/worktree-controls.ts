// Author: Jeff.Liu. Finite creation preview and explicit launch selection.
export type CleanupSummary={phase:"prepared"|"quarantined"|"unregistered"|"trashing"|"trashed";recovery_needed:boolean;retained_path:string;returned_path:string|null;reason:string|null};
export type CleanupPreview={attempt:string;preview:string;target:string;branch:string;commit:string;action:"trash"};
export type ManagedWorktree={attempt:string;session_id:string;repository:string;common_dir:string;target:string;branch:string;commit:string;state:"creating"|"created"|"failed"|"removing"|"removed";checkout_complete:boolean;session_claimed:boolean;cleanup?:CleanupSummary};
export type WorktreeCreatePreview=ManagedWorktree&{reference:string;revision:number};
export type WorktreeCreateRequest={root:string;target:string;reference:string;branch:string|null};
type Invoke=(name:string,args:Record<string,unknown>)=>Promise<unknown>;

const recordKeys=["attempt","session_id","repository","common_dir","target","branch","commit","state","checkout_complete","session_claimed"];
export function isManagedWorktree(value:unknown):value is ManagedWorktree {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const record=value as Record<string,unknown>;
 return Object.keys(record).every(key=>recordKeys.includes(key)||key==="cleanup") && recordKeys.every(key=>key in record)
  && typeof record.attempt==="string"&&/^[a-fA-F0-9]{64}$/.test(record.attempt)
  && typeof record.commit==="string"&&/^[a-fA-F0-9]{40}$/.test(record.commit)
  && ["session_id","repository","common_dir","target","branch"].every(key=>typeof record[key]==="string"&&(record[key] as string).length>0&&(record[key] as string).length<=4096&&!/[\x00-\x1f\x7f]/.test(record[key] as string))
  && ["creating","created","failed","removing","removed"].includes(String(record.state))
  && typeof record.checkout_complete==="boolean"&&typeof record.session_claimed==="boolean"
  && (record.state!=="created"||record.checkout_complete===true)
  && (record.cleanup===undefined||isCleanupSummary(record.cleanup,record.state));
}
export function canStartWorktree(record:ManagedWorktree):boolean {return isManagedWorktree(record)&&record.state==="created"&&record.checkout_complete&&!record.session_claimed;}
export function canRemoveWorktree(record:ManagedWorktree):boolean {return isManagedWorktree(record)&&record.state==="created"&&record.checkout_complete&&!record.cleanup;}
export function cleanupUnavailableReason():string {return "Move to Trash is supported on macOS only. Other platforms are unavailable. Recovery-needed records retain files for manual recovery; branches are never deleted.";}
function isPreview(value:unknown):value is WorktreeCreatePreview {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const {reference,revision,...record}=value as Record<string,unknown>;
 return isManagedWorktree(record)&&typeof reference==="string"&&reference.length>0&&reference.length<=4096&&Number.isSafeInteger(revision)&&(revision as number)>=0;
}
function operationError(reason:unknown):string {
 return typeof reason==="string"&&/^worktree_[a-z_]+$/.test(reason)&&reason.length<=80?reason:"worktree_operation_failed";
}
export class WorktreeSelection {
 preview:WorktreeCreatePreview|null=null;
 cleanupPreview:CleanupPreview|null=null;
 cleanupRecord:ManagedWorktree|null=null;
 private cleanupSubject:ManagedWorktree|null=null;
 record:ManagedWorktree|null=null;
 error:string|null=null;
 busy=false;
 private repository="";
 private owner="";
 private generation=0;
 select(repository:string,owner:string):void {
  if(repository===this.repository&&owner===this.owner)return;
  this.repository=repository;this.owner=owner;this.cancel();
 }
 cancel():void {this.generation++;this.preview=null;this.record=null;this.cleanupPreview=null;this.cleanupRecord=null;this.cleanupSubject=null;this.error=null;}
 async previewCreate(input:WorktreeCreateRequest,invoke:Invoke):Promise<void> {
  if(this.busy)return;
  const generation=++this.generation;this.preview=null;this.record=null;this.error=null;this.busy=true;
  try {
   const result=await invoke("preview_worktree_create",input);
   if(generation!==this.generation)return;
   if(!isPreview(result)||result.repository!==this.repository)throw "worktree_invalid_response";
   this.preview=result;
  } catch(reason) {if(generation===this.generation)this.error=operationError(reason);}
  finally {this.busy=false;}
 }
 async confirmCreate(invoke:Invoke):Promise<ManagedWorktree|null> {
  if(this.busy||!this.preview)return null;
  const preview=this.preview,generation=this.generation;this.error=null;this.busy=true;
  try {
   const result=await invoke("create_worktree",{attempt:preview.attempt});
   if(generation!==this.generation)return null;
   if(!isManagedWorktree(result)||result.attempt!==preview.attempt||result.session_id!==preview.session_id||result.target!==preview.target||result.repository!==preview.repository||result.commit!==preview.commit||result.branch!==preview.branch)throw "worktree_invalid_response";
   this.record=result;return result;
  } catch(reason) {if(generation===this.generation)this.error=operationError(reason);return null;}
  finally {this.busy=false;}
 }
 async previewCleanup(record:ManagedWorktree,invoke:Invoke):Promise<void> {
  if(this.busy||!canRemoveWorktree(record))return;
  const generation=++this.generation;
  this.cleanupPreview=null;this.cleanupRecord=null;this.cleanupSubject=record;this.error=null;this.busy=true;
  try {
   const result=await invoke("preview_worktree_cleanup",{attempt:record.attempt});
   if(generation!==this.generation)return;
   if(!isCleanupPreview(result)||result.attempt!==record.attempt||result.target!==record.target||result.branch!==record.branch)throw "worktree_invalid_response";
   this.cleanupPreview=result;
  } catch(reason){if(generation===this.generation)this.error=operationError(reason);}
  finally {this.busy=false;}
 }
 async confirmCleanup(invoke:Invoke):Promise<ManagedWorktree|null> {
  if(this.busy||!this.cleanupPreview||!this.cleanupSubject)return null;
  const preview=this.cleanupPreview,subject=this.cleanupSubject,generation=this.generation;
  this.error=null;this.busy=true;
  try {
   const result=await invoke("cleanup_worktree",{attempt:preview.attempt,preview:preview.preview});
   if(generation!==this.generation)return null;
   if(!isManagedWorktree(result)||!result.cleanup||!(["removing","removed"].includes(result.state))||["attempt","session_id","repository","common_dir","target","branch","commit"].some(key=>result[key as keyof ManagedWorktree]!==subject[key as keyof ManagedWorktree]))throw "worktree_invalid_response";
   this.cleanupRecord=result;this.cleanupPreview=null;return result;
  }catch(reason){if(generation===this.generation)this.error=operationError(reason);return null;}
  finally{this.busy=false;}
 }

}

function boundedPath(value:unknown):value is string {
 return typeof value==="string"&&value.length>0&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value);
}
function isCleanupSummary(value:unknown,state:unknown):value is CleanupSummary {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const summary=value as Record<string,unknown>,keys=["phase","recovery_needed","retained_path","returned_path","reason"];
 return Object.keys(summary).length===keys.length&&keys.every(key=>key in summary)
  && ["prepared","quarantined","unregistered","trashing","trashed"].includes(String(summary.phase))
  && boundedPath(summary.retained_path)&&(summary.returned_path===null||boundedPath(summary.returned_path))
  && (summary.reason===null||(typeof summary.reason==="string"&&/^worktree_[a-z_]{1,60}$/.test(summary.reason)))
  && (summary.phase==="trashed" ? state==="removed"&&summary.recovery_needed===false&&summary.reason===null : state==="removing"&&summary.recovery_needed===true);
}
function isCleanupPreview(value:unknown):value is CleanupPreview {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const preview=value as Record<string,unknown>,keys=["attempt","preview","target","branch","commit","action"];
 return Object.keys(preview).length===keys.length&&keys.every(key=>key in preview)
  && ["attempt","preview"].every(key=>typeof preview[key]==="string"&&/^[a-fA-F0-9]{64}$/.test(preview[key] as string))
  && typeof preview.commit==="string"&&/^[a-fA-F0-9]{40}$/.test(preview.commit)
  && boundedPath(preview.target)&&boundedPath(preview.branch)&&preview.action==="trash";
}
