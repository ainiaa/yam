import {t} from "./i18n";
import {Select} from "./Select";
import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {formatRetainedRange,normalizeLogExport} from "./session-logs";

export function SessionLogExport({sessionId,title,onClose}:{sessionId:string;title:string;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const identity=useRef({sessionId,title,version:0,mounted:true,request:0});
 // Render-time fencing also covers the interval before passive effects and same-ID ABA.
 if(identity.current.sessionId!==sessionId||identity.current.title!==title){
  identity.current={...identity.current,sessionId,title,version:identity.current.version+1};
 }
 const version=identity.current.version;
 const [raw,setRaw]=useState(false);
 const [state,setState]=useState<{version:number;busy:boolean;message:ReturnType<typeof normalizeLogExport>;error:string|null}>({version,busy:false,message:null,error:null});
 const current=state.version===version?state:{version,busy:false,message:null,error:null};
 const {busy,message,error}=current;
 useEffect(()=>{identity.current.mounted=true;setState(value=>({...value,busy:false}));dialog.current?.showModal();return()=>{identity.current.mounted=false;identity.current.request++;};},[]);
 async function save() {
  if(!identity.current.mounted||identity.current.version!==version||busy)return;
  const request=++identity.current.request;
  const valid=()=>identity.current.mounted&&identity.current.version===version&&identity.current.request===request;
  setState({version,busy:true,error:null,message:null});
  try{
   const receipt=normalizeLogExport(await invoke<unknown>("export_session_log",{sessionId,title,raw}));
   if(valid())setState({version,busy:false,error:null,message:receipt});
  }catch(reason){if(valid())setState({version,busy:false,error:String(reason),message:null});}
  finally{if(valid())setState(value=>({...value,busy:false}));}
 }
 return <dialog ref={dialog} className="app-dialog" aria-labelledby="log-export-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <form onSubmit={event=>{event.preventDefault();void save();}}>
   <header className="dialog-header"><h2 id="log-export-title">{t("Export session log")}</h2></header>
   <div className="dialog-fields">
    <p>{title}</p>
    <label>{t("Format")}<Select aria-label={t("Log export format")} disabled={busy} value={raw?"raw":"plain"} onChange={event=>setRaw(event.target.value==="raw")}><option value="plain">{t("Plain text")}</option><option value="raw">{t("Raw terminal output")}</option></Select></label>
    <p className="log-note">{t("Exports retained output and session metadata. Logs may contain sensitive information. Older output may have been removed. Choose a new file name; existing files are preserved.")}</p>
    {raw&&<p className="log-note">{t("Raw output includes terminal control sequences. Open it in a text viewer when sharing or inspecting it.")}</p>}
    {error&&<p role="alert" className="dialog-error">{t(error)}</p>}
    {message&&<p role="status">{t("Saved to {{path}}",{path:message.path})} · {formatRetainedRange(message.range,t)}</p>}
   </div>
   <footer className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t("Done")}</button><button type="submit" disabled={busy}>{busy?t("Saving…"):t("Choose file and export")}</button></footer>
  </form>
 </dialog>;
}
