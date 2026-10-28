import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
import {Select} from "./Select";
// Author: Jeff.Liu. Editing shortcuts never executes their actions.
import {useEffect,useRef,useState} from "react";
import {defaultAppShortcuts,shortcutActions,shortcutLabels,shortcutHint,type AppShortcuts} from "./app-shortcuts";
type Props={bindings:AppShortcuts;mac:boolean;warning:string|null;onSave:(draft:AppShortcuts)=>void;onClose:()=>void;navigation?:SettingsNavigationRenderer};
export function KeyboardShortcutSettings({bindings,mac,warning,onSave,onClose,navigation}:Props){
 const [draft,setDraft]=useState<AppShortcuts>(()=>Object.fromEntries(shortcutActions.map(action=>[action,bindings[action]===null?null:{...bindings[action]}])) as AppShortcuts),[error,setError]=useState<string|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),first=useRef<HTMLButtonElement>(null);
 useEffect(()=>{dialog.current?.showModal();first.current?.focus();},[]);
 return <dialog ref={dialog} className={"app-dialog terminal-settings-dialog"+(navigation?" settings-surface":"")} aria-labelledby="keyboard-shortcuts-title" data-shortcuts onCancel={event=>{event.preventDefault();onClose();}}>
 <header className="dialog-header"><h2 id="keyboard-shortcuts-title">{t("Keyboard shortcuts")}</h2></header>
   {navigation?.(JSON.stringify(draft)!==JSON.stringify(bindings))}
 <section className="dialog-fields"><p>{mac?t("Command"):t("Ctrl")} {t("shortcuts use logical keys. OS shortcuts and some keyboard layouts may intercept these keys.")}</p>
 {shortcutActions.map((action,index)=>{const chord=draft[action];return <fieldset key={action}><legend>{t(shortcutLabels[action])}</legend><label>{t("Key")}<Select ref={index===0?first:undefined} aria-label={t("{{value0}} key", {value0:t(shortcutLabels[action])})} value={chord?.key??"disabled"} onChange={event=>{const key=event.target.value;setDraft({...draft,[action]:key==="disabled"?null:{key,shift:chord?.shift??true}});}}><option value="disabled">{t("Disabled")}</option>{"abcdefghijklmnopqrstuvwxyz[]".split("").map(key=><option key={key} value={key}>{key.toUpperCase()}</option>)}</Select></label><label><input type="checkbox" aria-label={t("{{value0}} Shift", {value0:t(shortcutLabels[action])})} disabled={chord===null} checked={chord?.shift??false} onChange={event=>chord&&setDraft({...draft,[action]:{...chord,shift:event.target.checked}})}/>{t("Shift")}</label><p>{chord===null?t("Disabled"):shortcutHint(chord,mac)}</p></fieldset>;})}
 {warning&&<p role="status">{t(warning)}</p>}{error&&<p role="alert">{t(error)}</p>}
 </section><div className="dialog-actions"><button type="button" onClick={onClose}>{t("Cancel")}</button><button type="button" onClick={()=>{setDraft(defaultAppShortcuts(mac));setError(null);}}>{t("Reset draft to defaults")}</button><button type="button" onClick={()=>{try{onSave(draft);setError(null);}catch(reason){setError(reason instanceof Error?reason.message:"Could not save keyboard shortcuts.");}}}>{t("Save shortcuts")}</button></div></dialog>;
}
