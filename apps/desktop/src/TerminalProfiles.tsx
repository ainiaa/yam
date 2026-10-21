import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
import {EditableCombo} from "./EditableCombo";
import {Select} from "./Select";
// Author: Jeff.Liu. Managing a profile never starts a terminal.
import {useEffect,useRef,useState} from "react";
import {profileEnvRefsFromRows} from "./terminal-profiles";
import type {TerminalProfile,TerminalProfileDraft,ProfileCwd} from "./terminal-profiles";
type Props={fonts?:string[];fontError?:string|null;profiles:TerminalProfile[];selectedId:string|null;defaultId:string|null;draft:TerminalProfileDraft;windows:boolean;starting:boolean;error:string|null;onDraftChange:(draft:TerminalProfileDraft)=>void;onSelect:(id:string)=>void;onNew:()=>void;onSave:()=>void;onUpdate:()=>void;onDuplicate:()=>void;onDelete:()=>void;onDefault:(id:string|null)=>void;onStart:()=>void;onWithoutProfile:()=>void;onClose:()=>void;navigation?:SettingsNavigationRenderer};
export function TerminalProfiles({fonts=["SFMono-Regular","Menlo","Monaco","Consolas","monospace"],fontError=null,profiles,selectedId,defaultId,draft,windows,starting,error,onDraftChange,onSelect,onNew,onSave,onUpdate,onDuplicate,onDelete,onDefault,onStart,onWithoutProfile,onClose,navigation}:Props){
 const [envRows,setEnvRows]=useState(()=>Object.entries(draft.envRefs).map(([target,source])=>({target,source}))),[envError,setEnvError]=useState<string|null>(null);
 useEffect(()=>{setEnvRows(Object.entries(draft.envRefs).map(([target,source])=>({target,source})));setEnvError(null);},[draft.envRefs]);
 function changeEnvRows(rows:{target:string;source:string}[]){setEnvRows(rows);try{const envRefs=profileEnvRefsFromRows(rows);setEnvError(null);onDraftChange({...draft,envRefs});}catch(reason){setEnvError(reason instanceof Error?reason.message:"Invalid environment references.");}}
 const initialDraft=useRef(JSON.stringify(draft));
 const dialog=useRef<HTMLDialogElement>(null),nameInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{dialog.current?.showModal();nameInput.current?.focus();},[]);
 const selected=profiles.find(row=>row.id===selectedId),selection=draft.shell===null?"current":draft.shell.program===null?"system":"explicit";
 return <dialog ref={dialog} className={"app-dialog terminal-settings-dialog"+(navigation?" settings-surface":"")} aria-labelledby="terminal-profiles-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="terminal-profiles-title">{t("Terminal profiles")}</h2></header>
   {navigation?.(!!envError||JSON.stringify(envRows)!==JSON.stringify(Object.entries(draft.envRefs).map(([target,source])=>({target,source})))||(selected?JSON.stringify([draft.name,draft.shell,draft.cwd,draft.envRefs,draft.appearance])!==JSON.stringify([selected.name,selected.shell,selected.cwd,selected.envRefs,selected.appearance]):JSON.stringify(draft)!==initialDraft.current))}
  <section className="dialog-fields">
   {fontError&&<p role="status">{t(fontError)}</p>}
   <p>{t("Profiles are stored on this device. Saving and selecting do not start a process. A default profile applies only to new ordinary terminals.")}</p>
   <ul aria-label={t("Saved terminal profiles")}>{profiles.map(row=><li key={row.id}><button type="button" aria-label={t("Select {{value0}}", {value0:row.name})} aria-pressed={row.id===selectedId} disabled={starting} onClick={()=>onSelect(row.id)}>{row.name}{row.id===defaultId?t(" (default)"):""}</button></li>)}</ul>
   <button type="button" disabled={starting} onClick={onNew}>{t("New profile")}</button>
   <label htmlFor="terminal-profile-name">{t("Profile name")}<input ref={nameInput} id="terminal-profile-name" aria-label={t("Profile name")} maxLength={320} value={draft.name} disabled={starting} onChange={event=>onDraftChange({...draft,name:event.target.value})}/></label>
   <label>{t("Shell selection")}<Select aria-label={t("Profile shell selection")} value={selection} disabled={starting} onChange={event=>onDraftChange({...draft,shell:event.target.value==="current"?null:{program:event.target.value==="explicit"?draft.shell?.program??"":null,login:windows?null:typeof draft.shell?.login==="boolean"?draft.shell.login:true}})}><option value="current">{t("Current default (legacy)")}</option><option value="system">{t("System default with explicit options")}</option><option value="explicit">{t("Explicit executable")}</option></Select></label>
   {selection==="explicit"&&<label htmlFor="terminal-profile-shell">{t("Shell executable")}<input id="terminal-profile-shell" aria-label={t("Shell executable")} maxLength={4096} value={draft.shell?.program??""} disabled={starting} onChange={event=>onDraftChange({...draft,shell:{program:event.target.value,login:draft.shell!.login}})}/></label>}
   {!windows&&draft.shell!==null&&<label><input type="checkbox" aria-label={t("Profile login shell")} checked={draft.shell.login===true} disabled={starting} onChange={event=>onDraftChange({...draft,shell:{program:draft.shell!.program,login:event.target.checked}})}/>{t("Login shell")}</label>}
   <p>{windows?t("Explicit shell options support cmd.exe with no login option."):t("Explicit shell options support bash, zsh and fish.")} {t("Profiles saved for another platform stay unchanged; choose compatible options before starting.")}</p>
   <label>{t("Starting directory")}<Select aria-label={t("Profile directory strategy")} value={draft.cwd.mode} disabled={starting} onChange={event=>onDraftChange({...draft,cwd:event.target.value==="explicit"?{mode:"explicit",path:draft.cwd.path??""}:{mode:event.target.value as "home"|"context",path:null}})}><option value="context">{t("Current project or selected session")}</option><option value="home">{t("Home directory")}</option><option value="explicit">{t("Explicit directory")}</option></Select></label>
   {draft.cwd.mode==="explicit"&&<label htmlFor="terminal-profile-directory">{t("Directory")}<input id="terminal-profile-directory" aria-label={t("Profile directory")} maxLength={4096} value={draft.cwd.path} disabled={starting} onChange={event=>onDraftChange({...draft,cwd:{mode:"explicit",path:event.target.value} as ProfileCwd})}/></label>}
   <p>{t("Explicit directories must be absolute, without surrounding whitespace. Home is resolved by the terminal owner. Project configuration is not applied.")}</p>
   <fieldset disabled={starting}><legend>{t("Environment references")}</legend><p>{t("Enter variable names only. Values are resolved by the terminal owner when starting.")+" "}{windows?t("USERPROFILE and PATHEXT targets are unavailable on Windows."):t("The SHELL target is unavailable on this platform.")}</p>
    {envRows.map((row,index)=><div key={index}><label>{t("Target name")}<input aria-label={t("Environment target {{value0}}", {value0:index+1})} value={row.target} maxLength={128} onChange={event=>changeEnvRows(envRows.map((r,n)=>n===index?{...r,target:event.target.value}:r))}/></label><label>{t("Source name")}<input aria-label={t("Environment source {{value0}}", {value0:index+1})} value={row.source} maxLength={128} onChange={event=>changeEnvRows(envRows.map((r,n)=>n===index?{...r,source:event.target.value}:r))}/></label><button type="button" onClick={()=>changeEnvRows(envRows.filter((_,n)=>n!==index))}>{t("Remove reference")+" "}{index+1}</button></div>)}
    <button type="button" disabled={starting||envRows.length>=32} onClick={()=>changeEnvRows([...envRows,{target:"",source:""}])}>{t("Add environment reference")}</button>
    {envError&&<p role="alert">{t(envError)}</p>}
   </fieldset>
   <fieldset disabled={starting}><legend>{t("Initial appearance")}</legend>
    <label>{t("Initial appearance")}<Select aria-label={t("Profile initial appearance")} value={draft.appearance===null?"global":"custom"} onChange={event=>onDraftChange({...draft,appearance:event.target.value==="global"?null:{fontFamily:"SFMono-Regular, Menlo, Consolas, monospace",fontSize:13,theme:"dark"}})}><option value="global">{t("Global settings at launch")}</option><option value="custom">{t("Profile settings")}</option></Select></label>
    {draft.appearance!==null&&<><label>{t("Font family")}<EditableCombo options={fonts} aria-label={t("Profile font family")} maxLength={200} value={draft.appearance.fontFamily} onChange={event=>onDraftChange({...draft,appearance:{...draft.appearance!,fontFamily:event.target.value}})}/></label><label>{t("Font size")}<EditableCombo options={Array.from({length:15},(_,index)=>String(index+10))} aria-label={t("Profile font size")} inputMode="numeric" min={10} max={24} step={1} value={String(draft.appearance.fontSize)} onChange={event=>onDraftChange({...draft,appearance:{...draft.appearance!,fontSize:Number(event.target.value)}})}/></label><label>{t("Theme")}<Select aria-label={t("Profile theme")} value={draft.appearance.theme} onChange={event=>onDraftChange({...draft,appearance:{...draft.appearance!,theme:event.target.value as "app"|"dark"|"light"|"solarized"|"system"}})}><option value="app">{t("Follow app theme")}</option><option value="dark">{t("Dark")}</option><option value="light">{t("Light")}</option><option value="solarized">{t("Solarized")}</option><option value="system">{t("System")}</option></Select></label></>}
    <p>{t("Initial appearance applies to new terminals. Global appearance changes also affect open terminals. Tabs in the saved layout restore their saved appearance after an app restart; reopened history outside the saved layout uses global settings.")}</p>
   </fieldset>
   {error&&<><p role="alert">{t(error)}</p><p>{t("Save valid profile settings to repair storage, or explicitly start without a profile. Saved data is not changed by starting.")}</p></>}
   <div className="dialog-actions">
    <button type="button" disabled={starting||envError!==null} onClick={onSave}>{t("Save profile")}</button>
    <button type="button" disabled={starting||!selected||envError!==null} onClick={onUpdate}>{t("Update selected")}</button>
    <button type="button" disabled={starting||!selected} onClick={onDuplicate}>{t("Duplicate selected")}</button>
    <button type="button" disabled={starting||!selected} onClick={onDelete}>{t("Delete selected")}</button>
    <button type="button" disabled={starting||!selected} onClick={()=>selected&&onDefault(selected.id)}>{t("Set as default")}</button>
    <button type="button" disabled={starting||defaultId===null} onClick={()=>onDefault(null)}>{t("Clear default")}</button>
    <button type="button" disabled={starting||!selected} onClick={onStart}>{t("Start selected profile")}</button>
    <button type="button" disabled={starting} onClick={onWithoutProfile}>{t("Start without profile")}</button>
   </div>
  </section><footer className="dialog-actions"><button type="button" onClick={onClose}>{t("Close")}</button></footer>
 </dialog>;
}
