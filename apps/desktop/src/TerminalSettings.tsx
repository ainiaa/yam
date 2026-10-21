import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
import {EditableCombo} from "./EditableCombo";
import {Select} from "./Select";
import {defaultTerminalLineHeight,parseTerminalLineHeight,type TerminalLineHeight} from "./terminal-line-height";
import {defaultTerminalRetention,saveTerminalRetention,type TerminalRetention} from "./terminal-retention";
import {defaultTerminalCursor,isTerminalCursor,type TerminalCursor} from "./terminal-cursor";
import {useEffect,useRef,useState} from "react";
import {isTerminalSettings,type TerminalSettings as Preferences} from "./terminal-settings";
import {isShellLaunch,type ShellLaunch} from "./shell-launch";
import type {PaletteEntry} from "./command-palette";

export function TerminalSettings({fonts=["SFMono-Regular","Menlo","Monaco","Consolas","monospace"],fontError=null,settingsError=null,lineHeight=defaultTerminalLineHeight,lineHeightError=null,onLineHeightApply,retention=defaultTerminalRetention,retentionError=null,onRetentionApply,settings,onApply,onClose,shell=null,shellWindows=false,onShellApply,shellError,cursor=defaultTerminalCursor,cursorError=null,onCursorApply,navigation}:{fonts?:string[];fontError?:string|null;settingsError?:string|null;lineHeight?:TerminalLineHeight;lineHeightError?:string|null;onLineHeightApply?:(value:TerminalLineHeight)=>void;retention?:TerminalRetention;retentionError?:string|null;onRetentionApply?:(value:TerminalRetention)=>void;cursor?:TerminalCursor;cursorError?:string|null;onCursorApply?:(cursor:TerminalCursor)=>void;settings:Preferences;onApply:(settings:Preferences)=>void;onClose:()=>void;shell?:ShellLaunch|null;shellWindows?:boolean;onShellApply?:(shell:ShellLaunch|null)=>void;shellError?:string|null;onDirectoryReporting?:()=>void;onCommandReporting?:()=>void;navigation?:SettingsNavigationRenderer}){
 const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState<Preferences>({...settings}),[sizeText,setSizeText]=useState(String(settings.fontSize)),[error,setError]=useState<string|null>(null);
 const [retentionText,setRetentionText]=useState(String(retention.retainedLines)),[lineHeightText,setLineHeightText]=useState(String(lineHeight.lineHeight)),[cursorDraft,setCursorDraft]=useState({...cursor});
 const [shellSelection,setShellSelection]=useState(shell===null?"current":shell.program===null?"system":"explicit"),[shellProgram,setShellProgram]=useState(shell?.program??""),[shellLogin,setShellLogin]=useState(shell?.login??true);
 useEffect(()=>{dialog.current?.showModal();},[]);
 function save(event:{preventDefault():void}){
  event.preventDefault();
  let validated=false;
  try{
   const appearance={...draft,fontSize:Number(sizeText)};
   if(!isTerminalSettings(appearance))throw Error("Use a font of 1–200 characters without control characters and a whole size of 10–24.");
   const lines={version:1 as const,retainedLines:Number(retentionText)};if(onRetentionApply)saveTerminalRetention(()=>{},lines);
   const height=onLineHeightApply?parseTerminalLineHeight(lineHeightText):lineHeight;
   if(onCursorApply&&!isTerminalCursor(cursorDraft))throw Error("Invalid cursor defaults.");
   const nextShell=shellSelection==="current"?null:{program:shellSelection==="explicit"?shellProgram:null,login:shellWindows?null:shellLogin};
   if(onShellApply&&nextShell!==null&&!isShellLaunch(nextShell,shellWindows))throw Error("Use an absolute shell executable path of at most 4096 UTF-8 bytes without control characters.");
   validated=true;
   // Validate the whole draft before the first write; failed writes leave all fields available to retry.
   if(settingsError||JSON.stringify(appearance)!==JSON.stringify(settings))onApply(appearance);
   if(retentionError||lines.retainedLines!==retention.retainedLines)onRetentionApply?.(lines);
   if(lineHeightError||height.lineHeight!==lineHeight.lineHeight)onLineHeightApply?.(height);
   if(cursorError||JSON.stringify(cursorDraft)!==JSON.stringify(cursor))onCursorApply?.(cursorDraft);
   if(shellError||JSON.stringify(nextShell)!==JSON.stringify(shell))onShellApply?.(nextShell);
   onClose();
  }catch(reason){setError(validated?"Could not save all settings. Your drafts are kept; some settings may already be saved. Try saving again.":reason instanceof Error?reason.message:String(reason));}
 }
 return <dialog ref={dialog} className={"app-dialog terminal-settings-dialog terminal-preferences"+(navigation?" settings-surface":"")} aria-labelledby="terminal-settings-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <form onSubmit={save}>
   <header className="dialog-header"><h2 id="terminal-settings-title">{t("Terminal settings")}</h2></header>
   {navigation?.(JSON.stringify(draft)!==JSON.stringify(settings)||sizeText!==String(settings.fontSize)||retentionText!==String(retention.retainedLines)||lineHeightText!==String(lineHeight.lineHeight)||JSON.stringify(cursorDraft)!==JSON.stringify(cursor)||JSON.stringify(shellSelection==="current"?null:{program:shellSelection==="explicit"?shellProgram:null,login:shellWindows?null:shellLogin})!==JSON.stringify(shell))}
   <div className="terminal-settings-body">
    <section className="dialog-fields" aria-label={t("Appearance")}>
     {fontError&&<p role="status">{t(fontError)}</p>}
     <div><label htmlFor="terminal-font-family">{t("Font family")}</label><EditableCombo id="terminal-font-family" aria-label={t("Font family")} value={draft.fontFamily} options={fonts} maxLength={200} onChange={event=>setDraft(value=>({...value,fontFamily:event.target.value}))}/></div>
     <div><label htmlFor="terminal-font-size">{t("Font size")}</label><EditableCombo id="terminal-font-size" aria-label={t("Font size")} value={sizeText} options={Array.from({length:15},(_,index)=>String(index+10))} inputMode="numeric" min={10} max={24} onChange={event=>setSizeText(event.target.value)}/></div>
     <label>{t("Theme")}<Select aria-label={t("Terminal theme")} value={draft.theme} onChange={event=>setDraft(value=>({...value,theme:event.target.value as Preferences["theme"]}))}>{["app","dark","light","solarized","system"].map(theme=><option key={theme} value={theme}>{t(theme)}</option>)}</Select></label>
    </section>
    {onRetentionApply&&<section className="dialog-fields" aria-label={t("Terminal retention")}><h3>{t("Retained terminal lines")}</h3><p>{t("New ordinary terminals only. Existing terminals and saved history keep their limits.")}</p><label>{t("Retained lines")}<input type="number" min={200} max={2000} step={1} aria-label={t("Retained lines")} value={retentionText} onChange={event=>setRetentionText(event.target.value)}/></label></section>}
    {onLineHeightApply&&<section className="dialog-fields" aria-label={t("Line height")}><h3>{t("Terminal line height")}</h3><p>{t("Applies to all terminal views.")}</p><label htmlFor="terminal-line-height">{t("Line height")}</label><EditableCombo id="terminal-line-height" aria-label={t("Terminal line height")} value={lineHeightText} options={["1.00","1.15","1.35","1.50","1.75","2.00"]} inputMode="decimal" onChange={event=>setLineHeightText(event.target.value)}/></section>}
    {onCursorApply&&<section className="dialog-fields" aria-label={t("Cursor defaults")}><h3>{t("Default cursor")}</h3><p>{t("Terminal applications may override these defaults.")}</p><label>{t("Shape")}<Select aria-label={t("Default cursor shape")} value={cursorDraft.shape} onChange={event=>setCursorDraft(value=>({...value,shape:event.target.value as TerminalCursor["shape"]}))}><option value="block">{t("Block")}</option><option value="underline">{t("Underline")}</option><option value="bar">{t("Bar")}</option></Select></label><label className="log-checkbox"><input type="checkbox" aria-label={t("Blink by default")} checked={cursorDraft.blink} onChange={event=>setCursorDraft(value=>({...value,blink:event.target.checked}))}/>{t("Blink by default")}</label></section>}
    {onShellApply&&<section className="dialog-fields" aria-labelledby="terminal-shell-title"><h3 id="terminal-shell-title">{t("Shell for new terminals")}</h3>
     <p id="terminal-shell-scope">{t("New ordinary terminals only. Existing terminals and Agent launches keep their settings.")}</p>
     <label>{t("Shell selection")}<Select aria-label={t("Shell selection")} aria-describedby="terminal-shell-scope terminal-shell-support" value={shellSelection} onChange={event=>setShellSelection(event.target.value)}><option value="current">{t("Current default")}</option><option value="system">{t("System default with explicit options")}</option><option value="explicit">{t("Explicit executable")}</option></Select></label>
     <p id="terminal-shell-support">{shellWindows?t("Explicit selection supports cmd.exe."):t("Explicit options support bash, zsh and fish.")} {t("Other shells can use Current default.")}</p>
     {shellSelection==="explicit"&&<label htmlFor="terminal-shell-program">{t("Shell executable")}<input id="terminal-shell-program" aria-label={t("Shell executable")} value={shellProgram} maxLength={4096} placeholder={shellWindows?t("C:\\Windows\\System32\\cmd.exe"):t("/bin/zsh")} onChange={event=>setShellProgram(event.target.value)}/></label>}
     {!shellWindows&&shellSelection!=="current"&&<label className="log-checkbox"><input type="checkbox" aria-label={t("Login shell")} checked={shellLogin} onChange={event=>setShellLogin(event.target.checked)}/>{t("Login shell")}</label>}
    </section>}
    {(error||settingsError||retentionError||lineHeightError||cursorError||shellError)&&<p role="alert">{t(error||settingsError||retentionError||lineHeightError||cursorError||shellError||"")}</p>}
   </div>
   <footer className="dialog-actions"><button type="button" onClick={onClose}>{t("Cancel")}</button><button type="submit" className="primary-button">{t("Save settings")}</button></footer>
  </form>
 </dialog>;
}

export function CommandPalette({query,onQuery,entries,onChoose,onClose}:{query:string;onQuery:(value:string)=>void;entries:PaletteEntry[];onChoose:(entry:PaletteEntry)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),composing=useRef(false),[selected,setSelected]=useState(0);
 useEffect(()=>{dialog.current?.showModal();input.current?.focus();},[]);
 useEffect(()=>setSelected(0),[query]);
 const index=Math.min(selected,entries.length-1);
 return <dialog ref={dialog} className="app-dialog command-palette-dialog" aria-labelledby="command-palette-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="command-palette-title">{t("Command palette")}</h2><button type="button" onClick={onClose}>{t("Close")}</button></header>
  <form className="dialog-fields" onSubmit={event=>{event.preventDefault();if(!composing.current&&entries[index])onChoose(entries[index]);}}>
   <label>{t("Find an action or loaded session")}<input ref={input} aria-label={t("Command query")} maxLength={256} value={query} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onChange={event=>onQuery(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setSelected(value=>Math.max(0,Math.min(entries.length-1,value+(event.key==="ArrowDown"?1:-1))));}}}/></label>
   <ul className="command-palette-results" aria-label={t("Commands")}>{entries.map((entry,i)=><li key={`${entry.action}:${entry.sessionId??""}`}><button type="button" className={i===index?"selected":""} onClick={()=>onChoose(entry)}>{entry.label}</button></li>)}</ul>
   {!entries.length&&<p role="status">{t("No matching action or loaded session.")}</p>}
   <p className="log-note">{t("Filtering performs no action. Choose a result to run it. Session results use the loaded history page.")}</p>
  </form>
 </dialog>;
}
