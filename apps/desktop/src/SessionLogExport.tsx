import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

export function SessionLogExport({sessionId,title,onClose}:{sessionId:string;title:string;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [raw,setRaw]=useState(false);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState<string|null>(null);
 const [error,setError]=useState<string|null>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 async function save() {
  setBusy(true);setError(null);setMessage(null);
  try{
   const path=await invoke<string|null>("export_session_log",{sessionId,title,raw});
   if(path)setMessage(`Saved to ${path}`);
  }catch(reason){setError(String(reason));}
  finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="app-dialog" aria-labelledby="log-export-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <form onSubmit={event=>{event.preventDefault();void save();}}>
   <header className="dialog-header"><h2 id="log-export-title">Export session log</h2><button type="button" disabled={busy} onClick={onClose}>Close</button></header>
   <div className="dialog-fields">
    <p>{title}</p>
    <label>Format<select aria-label="Log export format" disabled={busy} value={raw?"raw":"plain"} onChange={event=>setRaw(event.target.value==="raw")}><option value="plain">Plain text</option><option value="raw">Raw terminal output</option></select></label>
    <p className="log-note">Exports retained output and session metadata. Logs may contain sensitive information. Older output may have been removed. Choose a new file name; existing files are preserved.</p>
    {raw&&<p className="log-note">Raw output includes terminal control sequences. Open it in a text viewer when sharing or inspecting it.</p>}
    {error&&<p role="alert" className="dialog-error">{error}</p>}
    {message&&<p role="status">{message}</p>}
   </div>
   <footer className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Done</button><button type="submit" disabled={busy}>{busy?"Saving…":"Choose file and export"}</button></footer>
  </form>
 </dialog>;
}
