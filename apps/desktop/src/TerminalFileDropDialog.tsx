import {t} from "./i18n";
// Author: Jeff.Liu. Complete plain-text path confirmation, independent of clipboard policy.
import {useEffect,type RefObject} from "react";
export type TerminalFileDropContent={path:string;canonical:string;text:string};
export function TerminalFileDropDialog({content,dialog,busy,onConfirm,onCancel}:{content:TerminalFileDropContent;dialog:RefObject<HTMLDialogElement|null>;busy:boolean;onConfirm:()=>void;onCancel:()=>void}){
 useEffect(()=>{dialog.current?.showModal();},[dialog]);
 return <dialog ref={dialog} className="app-dialog terminal-paste-dialog" aria-labelledby="terminal-file-drop-title" onCancel={event=>{event.preventDefault();onCancel();}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onCancel();}else if(event.key==="Enter"||event.keyCode===229){event.preventDefault();event.stopPropagation();}}}>
 <header className="dialog-header"><h2 id="terminal-file-drop-title">{t("Insert file path")}</h2></header>
 <section className="dialog-fields"><p>{t("Inserts text only. Review the command before running it.")}</p><label>{t("Dropped path")}<textarea readOnly value={content.path}/></label>{content.canonical!==content.path&&<label>{t("Canonical path")}<textarea readOnly value={content.canonical}/></label>}<label>{t("Text to insert")}<textarea className="terminal-paste-preview" aria-label={t("Text to insert")} readOnly value={content.text}/></label><p>{t("No file contents are read or uploaded. The path is checked again before insertion; files may still change. Quoting is for POSIX shells and does not determine how a running application interprets text.")}</p></section>
 <footer className="dialog-actions"><button type="button" autoFocus onClick={onCancel}>{t("Cancel")}</button><button type="button" disabled={busy} onClick={()=>{if(!busy)onConfirm();}}>{t("Insert file path")}</button></footer>
 </dialog>;
}
