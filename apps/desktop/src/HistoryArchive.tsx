import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {HistoryItem,HistoryCursor,HistoryPage,HistoryPolicy,DeletionPreview,DeletionResult} from "./history";

type Props={titleFor:(summary:HistoryItem["summary"])=>string;history:HistoryItem[];onClose:()=>void;onChanged:()=>Promise<void>;onSelect:(id:string)=>Promise<void>;onDeleted:(ids:string[])=>void};
export function HistoryArchive({history,onClose,onChanged,onSelect,titleFor,onDeleted}:Props) {
 const dialog=useRef<HTMLDialogElement>(null);
 const busyRef=useRef(false);
 const archiveRequestVersion=useRef(0);
 const deleteRequestVersion=useRef(0);
 const policyRequestVersion=useRef(0);
 const deletionPreviewRef=useRef<DeletionPreview|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [archives,setArchives]=useState<HistoryItem[]>([]);
 const [archiveCursor,setArchiveCursor]=useState<HistoryCursor|null>(null);
 const [autoArchive,setAutoArchive]=useState(false);
 const [selectedArchiveIds,setSelectedArchiveIds]=useState<string[]>([]);
 const [deletionPreview,setDeletionPreview]=useState<DeletionPreview|null>(null);
 async function loadRetentionPolicy() {
  const version=++policyRequestVersion.current;
  try{const policy=await invoke<HistoryPolicy>("get_history_policy");if(version===policyRequestVersion.current)setAutoArchive(policy.auto_archive_30_days);}
  catch(reason){if(version===policyRequestVersion.current){setAutoArchive(false);setError(String(reason));}}
 }
 async function saveRetentionPolicy(enabled:boolean) {
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError(null);
  const version=++policyRequestVersion.current;
  try{await invoke("set_history_policy",{autoArchive30Days:enabled});if(version===policyRequestVersion.current)setAutoArchive(enabled);}
  catch(reason){if(version===policyRequestVersion.current)setError(String(reason));}
  finally{busyRef.current=false;setBusy(false);}
 }
 async function previewDeletion(ids:string[]=selectedArchiveIds) {
  if(busyRef.current||deletionPreviewRef.current)return;const version=++deleteRequestVersion.current;setError(null);
  try{
   const preview=await invoke<DeletionPreview>("preview_archive_deletion",{sessionIds:ids});
   if(version!==deleteRequestVersion.current){void invoke("cancel_archive_deletion_preview",{previewId:preview.preview_id}).catch(()=>{});return;}
   deletionPreviewRef.current=preview;setDeletionPreview(preview);
  }catch(reason){if(version===deleteRequestVersion.current)setError(String(reason));}
 }
 async function cancelDeletion() {
  if(busyRef.current)return;deleteRequestVersion.current++;
  const preview=deletionPreviewRef.current;deletionPreviewRef.current=null;setDeletionPreview(null);
  if(preview)try{await invoke("cancel_archive_deletion_preview",{previewId:preview.preview_id});}catch(reason){setError(String(reason));}
 }
 async function confirmDeletion() {
  const preview=deletionPreviewRef.current;if(busyRef.current||!preview)return;
  busyRef.current=true;setBusy(true);setError(null);deleteRequestVersion.current++;
  try{
   let result=await invoke<DeletionResult>("confirm_archive_deletion",{previewId:preview.preview_id});
   if(result.deleted_ids.length){onDeleted(result.deleted_ids);setSelectedArchiveIds(ids=>ids.filter(id=>!result.deleted_ids.includes(id)));}
   await loadArchives();
   if(!result.complete){
    // Listing recovers a pending transaction. Read the same token once for its final actual IDs.
    result=await invoke<DeletionResult>("confirm_archive_deletion",{previewId:preview.preview_id});
    if(result.deleted_ids.length){onDeleted(result.deleted_ids);setSelectedArchiveIds(ids=>ids.filter(id=>!result.deleted_ids.includes(id)));}
   }
   if(result.complete){deletionPreviewRef.current=null;setDeletionPreview(null);}
   await onChanged();
   if(!result.complete)setError(result.issues.join("; ")||"Deletion remains pending; reopen history to recover.");
  }catch(reason){setError(String(reason));}
  finally{busyRef.current=false;setBusy(false);}
 }
 async function loadArchives(cursor:HistoryCursor|null=null) {
  const version=++archiveRequestVersion.current;setLoading(true);setError(null);
  try {
   const page=await invoke<HistoryPage<HistoryItem>>("list_archived_sessions",{request:{page_size:100,cursor}});
   if(version!==archiveRequestVersion.current)return;
   setArchives(cursor?current=>[...current,...page.items]:page.items);setArchiveCursor(page.next_cursor);
  }catch(reason){if(version===archiveRequestVersion.current)setError(String(reason));}
  finally{if(version===archiveRequestVersion.current)setLoading(false);}
 }
 async function mutateArchive(action:"archive_session"|"restore_archive",id:string) {
  if(busyRef.current)return;
  busyRef.current=true;setBusy(true);setError(null);
  try{await invoke(action,{sessionId:id});if(action==="restore_archive")setSelectedArchiveIds(ids=>ids.filter(selected=>selected!==id));await loadArchives();await onChanged();}
  catch(reason){setError(String(reason));}
  finally{busyRef.current=false;setBusy(false);}
 }
 function closeArchive() {if(busyRef.current)return;archiveRequestVersion.current++;onClose();}
 useEffect(()=>{dialog.current?.showModal();void loadArchives();void loadRetentionPolicy();return()=>{archiveRequestVersion.current++;policyRequestVersion.current++;void cancelDeletion();};},[]);
 return <dialog ref={dialog} className="app-dialog history-archive-dialog" aria-labelledby="archive-title" onCancel={event=>{event.preventDefault();closeArchive();}}>
  <header className="dialog-header"><h2 id="archive-title">Archived sessions</h2><button disabled={busy} onClick={closeArchive} aria-label="Close archived sessions">Close</button></header>
  <p>Archive completed sessions to free history metadata space. Logs, saved terminal scenes, and native conversation IDs stay available. Permanent deletion is always manual.</p>
  <label><input type="checkbox" checked={autoArchive} disabled={busy} onChange={event=>void saveRetentionPolicy(event.target.checked)}/>Automatically archive read sessions older than 30 days when the background is idle</label>
  {error&&<p role="alert">{error}</p>}
  <section aria-label="Sessions available to archive"><h3>Current history page</h3><ul>{history.filter(record=>["succeeded","failed","stopped"].includes(record.status)).map(record=><li key={record.summary.session_id}><span>{titleFor(record.summary)}</span><button disabled={busy||record.agent.unread_count>0} onClick={()=>void mutateArchive("archive_session",record.summary.session_id)}>Archive</button></li>)}</ul></section>
  <section aria-label="Archived history"><h3>Archived history</h3>{loading&&<p role="status">Loading archives…</p>}<ul>{archives.map(record=><li key={record.summary.session_id}><input type="checkbox" aria-label={`Select ${titleFor(record.summary)} for deletion`} disabled={busy||(!selectedArchiveIds.includes(record.summary.session_id)&&selectedArchiveIds.length>=20)} checked={selectedArchiveIds.includes(record.summary.session_id)} onChange={event=>{void cancelDeletion();setSelectedArchiveIds(ids=>event.target.checked?[...ids,record.summary.session_id]:ids.filter(id=>id!==record.summary.session_id));}}/><button disabled={busy} onClick={()=>void onSelect(record.summary.session_id).catch(reason=>setError(String(reason)))}>{titleFor(record.summary)}</button><span>{record.status}</span><button disabled={busy} onClick={()=>void mutateArchive("restore_archive",record.summary.session_id)}>Restore</button></li>)}</ul>{!loading&&!archives.length&&<p>No archived sessions on this page.</p>}{archiveCursor&&<button disabled={busy||loading} onClick={()=>void loadArchives(archiveCursor)}>Load more archives</button>}</section>
  <button disabled={busy||!selectedArchiveIds.length} onClick={()=>void previewDeletion()}>Preview permanent deletion</button>
  {deletionPreview&&<section aria-label="Permanent deletion preview" className="deletion-preview"><h3>Review permanent deletion</h3><p>{deletionPreview.count} sessions · {deletionPreview.bytes} bytes</p><p>{deletionPreview.earliest_ended_at===null?"Unknown":new Date(deletionPreview.earliest_ended_at*1000).toLocaleString()} – {deletionPreview.latest_ended_at===null?"Unknown":new Date(deletionPreview.latest_ended_at*1000).toLocaleString()}</p><p>{deletionPreview.scope}</p><p>This cannot be undone. Existing forensic backups are retained and are not automatic recovery sources.</p><button disabled={busy} onClick={()=>void confirmDeletion()}>Confirm permanent deletion</button><button disabled={busy} onClick={()=>void cancelDeletion()}>Cancel permanent deletion</button></section>}
 </dialog>;
}
