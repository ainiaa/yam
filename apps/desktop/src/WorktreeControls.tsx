import {t} from "./i18n";
// Author: Jeff.Liu. Creation and session launch are separate explicit actions.
import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {WorktreeSelection,canStartWorktree,cleanupUnavailableReason,canRemoveWorktree,isManagedWorktree,type ManagedWorktree,type CleanupPreview,type WorktreeCreatePreview} from "./worktree-controls";

export function WorktreeControls({root,owner,selected,onCreated,onStart}:{root:string;owner:number;selected:ManagedWorktree|null;onCreated:(record:ManagedWorktree,root:string,owner:number)=>void;onStart:(record:ManagedWorktree)=>Promise<void>}) {
  const flow=useRef(new WorktreeSelection());
  const context=useRef({root,owner,version:0,alive:true});
  if(context.current.root!==root || context.current.owner!==owner) {
    context.current={root,owner,version:context.current.version+1,alive:true};
    flow.current.select(root,String(owner));
  }
  flow.current.select(root,String(owner));
  const [target,setTarget]=useState("");
  const [reference,setReference]=useState("HEAD");
  const [branch,setBranch]=useState("");
  const [preview,setPreview]=useState<WorktreeCreatePreview|null>(null);
  const [records,setRecords]=useState<ManagedWorktree[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [cleanupPreview,setCleanupPreview]=useState<CleanupPreview|null>(null);
  const [cleanupResult,setCleanupResult]=useState<ManagedWorktree|null>(null);
  useEffect(()=>{
    context.current.alive=true;
    setPreview(null);setCleanupPreview(null);setCleanupResult(null);setError(null);setBusy(false);setRecords([]);
    const version=context.current.version;
    void invoke<unknown>("list_managed_worktrees").then(value=>{
      if(context.current.alive && context.current.version===version && Array.isArray(value) && value.every(isManagedWorktree))setRecords(value);
    }).catch(()=>{if(context.current.alive && context.current.version===version)setError("Managed worktrees are unavailable.");});
    return ()=>{context.current.alive=false;context.current.version++;flow.current.cancel();};
  },[root,owner]);
  function cancel() {
    context.current.version++;flow.current.cancel();setPreview(null);setCleanupPreview(null);setCleanupResult(null);setError(null);setBusy(false);
  }
  async function prepare() {
    const version=context.current.version;setBusy(true);setError(null);
    await flow.current.previewCreate({root,target,reference,branch:branch.trim()||null},invoke);
    if(!context.current.alive || context.current.version!==version)return;
    setPreview(flow.current.preview);setError(flow.current.error);setBusy(false);
  }
  async function create() {
    const version=context.current.version,expectedRoot=root,expectedOwner=owner;setBusy(true);setError(null);
    const record=await flow.current.confirmCreate(invoke);
    if(!context.current.alive || context.current.version!==version)return;
    setError(flow.current.error);setBusy(false);
    if(record){setPreview(null);setRecords(old=>[...old.filter(item=>item.attempt!==record.attempt),record]);onCreated(record,expectedRoot,expectedOwner);}
  }
  async function prepareCleanup(record:ManagedWorktree) {
    const version=context.current.version;setBusy(true);setError(null);setCleanupResult(null);
    await flow.current.previewCleanup(record,invoke);
    if(!context.current.alive||context.current.version!==version)return;
    setCleanupPreview(flow.current.cleanupPreview);setError(flow.current.error);setBusy(false);
  }
  async function confirmCleanup() {
    const version=context.current.version;setBusy(true);setError(null);
    const record=await flow.current.confirmCleanup(invoke);
    if(!context.current.alive||context.current.version!==version)return;
    setError(flow.current.error);setBusy(false);
    if(record){setCleanupPreview(null);setCleanupResult(record);setRecords(old=>old.map(item=>item.attempt===record.attempt?record:item));}
  }
  const currentSelected=selected?(records.find(record=>record.attempt===selected.attempt)??selected):null;
  const available=currentSelected && (currentSelected.repository===root || currentSelected.target===root)?currentSelected:null;
  return <section className="worktree-controls" aria-label={t("Managed Git worktrees")}>
    <details>
      <summary>{t("Create a managed worktree")}</summary>
      <p>{t("Creates files from a confirmed local commit. Starting a session requires a separate action. Uncommitted changes are not copied.")}</p>
      <label>{t("New absolute directory")}<input value={target} disabled={busy} onChange={event=>{cancel();setTarget(event.target.value);}}/></label>
      <label>{t("Local reference")}<input value={reference} disabled={busy} onChange={event=>{cancel();setReference(event.target.value);}}/></label>
      <label>{t("New branch (optional)")}<input value={branch} disabled={busy} placeholder={t("codex/yam/&lt;first session id&gt;")} onChange={event=>{cancel();setBranch(event.target.value);}}/></label>
      <div className="worktree-actions"><button type="button" disabled={busy||!root||!target||!reference} onClick={()=>void prepare()}>{t("Preview creation")}</button><button type="button" onClick={cancel}>{t("Cancel preview")}</button></div>
      {preview&&<div role="status"><p>{t("Commit:")+" "}{preview.commit}</p><p>{t("Branch:")+" "}{preview.branch}</p><p>{t("Directory:")+" "}{preview.target}</p><button type="button" disabled={busy} onClick={()=>void create()}>{t("Create worktree only")}</button></div>}
    </details>
    {error&&<p role="alert">{t(error)}</p>}
    {available&&<p>{t("Created:")+" "}{available.target} <button type="button" disabled={busy||!canStartWorktree(available)} onClick={()=>void onStart(available)}>{t("Start first session")}</button></p>}
    {records.length>0&&<details><summary>{t("Managed records (")}{records.length})</summary><ul>{records.map(record=><li key={record.attempt}>{record.branch} — {t(record.state)}: {record.target}{canStartWorktree(record)&&<button type="button" disabled={busy} onClick={()=>onCreated(record,root,owner)}>{t("Select for first session")}</button>}
        {canRemoveWorktree(record)&&<button type="button" disabled={busy} onClick={()=>void prepareCleanup(record)}>{t("Preview cleanup")}</button>}
        {record.cleanup?.recovery_needed&&<p role="status">{t("Recovery needed.")+" "}{record.cleanup.returned_path ? t("Verified returned path: {{value0}}.", {value0:record.cleanup.returned_path}) : record.cleanup.reason === "worktree_native_result_unknown" ? t(t("File location is unknown; the quarantine path may no longer exist.")) : t("Files may remain at {{value0}}.", {value0:record.cleanup.retained_path})} {t("Review retained files manually; Git registration is not automatically restored.")}</p>}
        {record.cleanup?.phase==="trashed"&&<p role="status">{t("Moved to Trash; branch retained.")}</p>}</li>)}</ul></details>}
    {cleanupPreview&&<div role="status">
      <p>{t("Move this clean, inactive worktree to system Trash:")+" "}{cleanupPreview.target}</p>
      <p>{t("Branch retained:")+" "}{cleanupPreview.branch}{t(". Confirmed commit:")+" "}{cleanupPreview.commit}</p>
      <button type="button" disabled={busy} onClick={()=>void confirmCleanup()}>{t("Move to Trash")}</button>
      <button type="button" disabled={busy} onClick={cancel}>{t("Cancel cleanup")}</button>
    </div>}
    {cleanupResult&&<p role="status">{cleanupResult.cleanup?.phase==="trashed"?t("Moved to Trash; branch retained. Restoring files does not restore Git registration."):t("Recovery needed. {{value0}} Review files manually. This operation cannot be retried automatically.", {value0:cleanupResult.cleanup?.returned_path ? t("Verified returned path: {{value0}}.",{value0:cleanupResult.cleanup.returned_path}) : cleanupResult.cleanup?.reason === "worktree_native_result_unknown" ? t("File location is unknown; the quarantine path may no longer exist.") : t("Files may remain at {{value0}}.",{value0:cleanupResult.cleanup?.retained_path})})}</p>}
    <p className="log-note">{t(cleanupUnavailableReason())} {t("Failed or interrupted creation retains its directory and branch for manual review.")}</p>
  </section>;
}
