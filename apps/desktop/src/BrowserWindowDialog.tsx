import {t} from "./i18n";
// Author: Jeff.Liu. Trusted dialog controls a separate native browser window.
import {useEffect,useRef,useState} from "react";
import type {BrowserAction,BrowserSnapshot} from "./browser-window";
export function BrowserWindowDialog({snapshot,busy,error,onAction,onRefresh,onClose}:{snapshot:BrowserSnapshot;busy:boolean;error:string|null;onAction:(action:BrowserAction,url:string)=>void;onRefresh:()=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[url,setURL]=useState(snapshot.url??"");
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const open=snapshot.phase==="open",pending=snapshot.phase==="creating"||snapshot.phase==="closing";
 return <dialog ref={dialog} className="app-dialog" aria-labelledby="browser-window-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="browser-window-title">{t("Browser")}</h2><button type="button" onClick={onClose} aria-label={t("Close browser controls")}>{t("Close controls")}</button></header>
  <section className="dialog-fields"><p>{t("Opens one separate, private browser window. URLs are not saved. These controls stay in YAM.")}</p>
   <label>{t("HTTP(S) URL")}<input value={url} onChange={event=>setURL(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}/></label>
   {snapshot.url&&<p>{t("Last observed URL:")+" "}{snapshot.url}</p>}<p>{t("Window:")+" "}{snapshot.phase}. {snapshot.loading?t("Loading; success is not verified."):t("Page loading and HTTP success are not verified.")}</p>
   {pending&&<p>{t("The window remains reserved until its native operation completes. Retry status or Close.")}</p>}
   {error&&<p role="alert">{t("Browser operation unavailable (")}{t(error)}{t("). Your URL draft is preserved.")}</p>}
  </section>
  <footer className="dialog-actions"><button type="button" disabled={busy||pending} onClick={()=>onAction("open",url)}>{open?t("Navigate"):t("Open")}</button><button type="button" disabled={busy||!open} onClick={()=>onAction("show",url)}>{t("Show")}</button><button type="button" disabled={busy||!open} onClick={()=>onAction("reload",url)}>{t("Reload")}</button><button type="button" disabled={busy||snapshot.phase==="closed"} onClick={()=>onAction("close",url)}>{t("Close browser")}</button><button type="button" disabled={busy} onClick={onRefresh}>{t("Retry status")}</button></footer>
 </dialog>;
}
