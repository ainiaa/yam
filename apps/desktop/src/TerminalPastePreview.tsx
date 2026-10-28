import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
import {Select} from "./Select";
// Author: Jeff.Liu. Native dialogs display synthetic-safe plain text and never send input themselves.
import {useEffect,useRef,useState,type RefObject} from "react";
import type {TerminalPasteMode,TerminalPasteText} from "./terminal-paste";
export function TerminalPastePreview({content,dialog,onConfirm,onCancel}:{content:TerminalPasteText;dialog:RefObject<HTMLDialogElement|null>;onConfirm:()=>void;onCancel:()=>void}){
 useEffect(()=>{dialog.current?.showModal();},[dialog]);
 return <dialog ref={dialog} className="app-dialog terminal-paste-dialog" aria-labelledby="terminal-paste-title" onCancel={event=>{event.preventDefault();onCancel();}} onKeyDown={event=>{if(event.key==="Enter"||event.keyCode===229){event.preventDefault();event.stopPropagation();}else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onCancel();}}}>
  <header className="dialog-header"><h2 id="terminal-paste-title">{t("Preview terminal paste")}</h2></header>
  <section className="dialog-fields"><p>{content.bytes} {t("UTF-8 bytes ·")+" "}{content.lines} {t("logical lines ·")+" "}{content.controls} {t("control characters (including line breaks, excluding tabs).")}</p><textarea className="terminal-paste-preview" aria-label={t("Paste preview")} readOnly value={content.display}/>{content.truncated&&<p>{t("Only the first 4096 characters are shown. Confirm pastes the full text.")}</p>}<p>{t("Confirm uses the terminal’s ordinary input permissions. Another desktop controlling it can refuse this paste. Text is sent without application edits; the terminal handles line endings and bracketed paste.")}</p></section>
  <footer className="dialog-actions"><button type="button" autoFocus onClick={onCancel}>{t("Cancel")}</button><button type="button" onClick={onConfirm}>{t("Confirm paste")}</button></footer>
 </dialog>;
}
export function TerminalPasteSettings({mode,error,onApply,onClose,navigation}:{mode:TerminalPasteMode;error:string|null;onApply:(mode:TerminalPasteMode)=>void;onClose:()=>void;navigation?:SettingsNavigationRenderer}){
 const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState(mode),[failure,setFailure]=useState(error);
 useEffect(()=>{dialog.current?.showModal();},[]);
 function save(){try{onApply(draft);setFailure(null);}catch{setFailure("Could not save paste settings.");}}
 return <dialog ref={dialog} className={"app-dialog"+(navigation?" settings-surface":"")} aria-labelledby="terminal-paste-settings-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="terminal-paste-settings-title">{t("Paste settings")}</h2></header>
  {navigation?.(draft!==mode)}
  <section className="dialog-fields"><label>{t("Paste preview")}<Select aria-label={t("Paste preview policy")} value={draft} onChange={event=>setDraft(event.target.value as TerminalPasteMode)}><option value="risky">{t("Line breaks or control characters")}</option><option value="always">{t("Every paste")}</option><option value="never">{t("No preview")}</option></Select></label><p>{t("The default previews any CR or LF, including a trailing newline, and control characters other than tabs. This does not detect every dangerous command. All modes reject text over 128 KiB or invalid Unicode.")}</p>{failure&&<p role="alert">{t(failure)}</p>}</section>
  <footer className="dialog-actions"><button type="button" onClick={onClose}>{t("Cancel")}</button><button type="button" onClick={save}>{t("Save paste settings")}</button></footer>
 </dialog>;
}
