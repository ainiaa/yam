import {t} from "./i18n";
// Author: Jeff.Liu. Explicit confirmation displays paths as plain text, never as links.
import {useEffect,type RefObject} from "react";
import type {TerminalFilePreviewData} from "./terminal-file-actions";
export function TerminalFilePreview({content,dialog,onConfirm,onCancel}:{content:TerminalFilePreviewData;dialog:RefObject<HTMLDialogElement|null>;onConfirm:()=>void;onCancel:()=>void}){
 useEffect(()=>{dialog.current?.showModal();},[dialog]);
 return <dialog ref={dialog} className="app-dialog terminal-paste-dialog" aria-labelledby="terminal-file-title" onCancel={event=>{event.preventDefault();onCancel();}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onCancel();}else if(event.key==="Enter"||event.keyCode===229){event.preventDefault();event.stopPropagation();}}}>
 <header className="dialog-header"><h2 id="terminal-file-title">{t("Show selected file in Finder")}</h2></header>
 <section className="dialog-fields"><p>{t("This is a path on this Mac. Confirm shows the existing regular file in Finder without reading its contents.")}</p><label>{t("Selected path")}<textarea readOnly value={content.path}/></label><label>{t("Canonical path")}<textarea readOnly value={content.canonical}/></label><p>{t("The path is checked again on confirmation. Files can still change during the native operation.")}</p></section>
 <footer className="dialog-actions"><button type="button" autoFocus onClick={onCancel}>{t("Cancel")}</button><button type="button" onClick={onConfirm}>{t("Show in Finder")}</button></footer>
 </dialog>;
}
