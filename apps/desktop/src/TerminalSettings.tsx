import {useEffect,useRef,useState} from "react";
import {isTerminalSettings,type TerminalSettings as Preferences} from "./terminal-settings";
import type {PaletteEntry} from "./command-palette";

export function TerminalSettings({settings,onApply,onClose}:{settings:Preferences;onApply:(settings:Preferences)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState<Preferences>({...settings}),[error,setError]=useState<string|null>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} className="app-dialog terminal-settings-dialog" aria-labelledby="terminal-settings-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="terminal-settings-title">Terminal settings</h2></header>
  <form className="dialog-fields" onSubmit={event=>{event.preventDefault();try{if(!isTerminalSettings(draft))throw Error("Use a font of 1–200 characters without control characters, a whole size of 10–24, and a built-in theme.");onApply(draft);onClose();}catch(reason){setError(String(reason));}}}>
   <label>Font family<input aria-label="Font family" maxLength={200} value={draft.fontFamily} onChange={event=>setDraft(value=>({...value,fontFamily:event.target.value}))}/></label>
   <label>Font size<input aria-label="Font size" type="number" min={10} max={24} step={1} value={draft.fontSize} onChange={event=>setDraft(value=>({...value,fontSize:Number(event.target.value)}))}/></label>
   <label>Theme<select aria-label="Terminal theme" value={draft.theme} onChange={event=>setDraft(value=>({...value,theme:event.target.value as Preferences["theme"]}))}>{["dark","light","solarized"].map(theme=><option key={theme} value={theme}>{theme}</option>)}</select></label>
   {error&&<p role="alert">{error}</p>}
   <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save terminal settings</button></div>
  </form>
 </dialog>;
}

export function CommandPalette({query,onQuery,entries,onChoose,onClose}:{query:string;onQuery:(value:string)=>void;entries:PaletteEntry[];onChoose:(entry:PaletteEntry)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),composing=useRef(false),[selected,setSelected]=useState(0);
 useEffect(()=>{dialog.current?.showModal();input.current?.focus();},[]);
 useEffect(()=>setSelected(0),[query]);
 const index=Math.min(selected,entries.length-1);
 return <dialog ref={dialog} className="app-dialog command-palette-dialog" aria-labelledby="command-palette-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="command-palette-title">Command palette</h2><button type="button" onClick={onClose}>Close</button></header>
  <form className="dialog-fields" onSubmit={event=>{event.preventDefault();if(!composing.current&&entries[index])onChoose(entries[index]);}}>
   <label>Find an action or loaded session<input ref={input} aria-label="Command query" maxLength={256} value={query} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onChange={event=>onQuery(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setSelected(value=>Math.max(0,Math.min(entries.length-1,value+(event.key==="ArrowDown"?1:-1))));}}}/></label>
   <ul className="command-palette-results" aria-label="Commands">{entries.map((entry,i)=><li key={`${entry.action}:${entry.sessionId??""}`}><button type="button" className={i===index?"selected":""} onClick={()=>onChoose(entry)}>{entry.label}</button></li>)}</ul>
   {!entries.length&&<p role="status">No matching action or loaded session.</p>}
   <p className="log-note">Filtering performs no action. Choose a result to run it. Session results use the loaded history page.</p>
  </form>
 </dialog>;
}
