import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
// Author: Jeff.Liu
import {useEffect,useRef,useState} from "react";
export function ZshCommandReporting({enabled,error,onApply,onClose,navigation}:{enabled:boolean;error:string|null;onApply:(enabled:boolean)=>void;onClose:()=>void;navigation?:SettingsNavigationRenderer}){
 const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState(enabled),[saveError,setSaveError]=useState<string|null>(error);
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} className={"app-dialog"+(navigation?" settings-surface":"")} aria-labelledby="zsh-command-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <form onSubmit={event=>{event.preventDefault();try{onApply(draft);onClose();}catch{setSaveError("Could not save Zsh command status reporting settings.");}}}>
  <header className="dialog-header"><h2 id="zsh-command-title">{t("Zsh command status reporting (experimental)")}</h2></header>
  {navigation?.(draft!==enabled)}
  <section className="dialog-fields">
   <p>{t("Applies to future ordinary Unix terminals and personal profiles using explicit Zsh or an owner-resolved Current/System default Zsh. Unsupported defaults keep their original startup with an unavailable warning. Existing terminals keep their settings.")}</p>
   <p>{t("Command activity and exit codes come from untrusted shell output and may be incomplete or inaccurate. They do not confirm process or Agent completion. Shell startup overrides or hook resets may leave reports unavailable. Shell startup files are not edited.")}</p>
   <label className="log-checkbox"><input type="checkbox" aria-label={t("Enable experimental Zsh command status reporting")} checked={draft} onChange={event=>setDraft(event.target.checked)}/>{t("Enable Zsh command status reporting")}</label>
   {saveError&&<p role="alert">{t(saveError)}</p>}
  </section>
   <div className="dialog-actions"><button type="button" onClick={onClose}>{t("Cancel")}</button><button type="submit">{t("Save command status reporting settings")}</button></div>
  </form>
 </dialog>;
}
