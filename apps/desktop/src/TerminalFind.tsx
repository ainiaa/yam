import {t} from "./i18n";
// Author: Jeff.Liu.
import {useEffect,useRef,useState} from "react";
import type {TerminalFindController} from "./terminal-find";
export function TerminalFindBar({controller,onClose,onLogSearch}:{controller:TerminalFindController;onClose:()=>void;onLogSearch:()=>void}){
 const state=controller.state,input=useRef<HTMLInputElement>(null),composing=useRef(false);
 const [draft,setDraft]=useState(state.query);
 useEffect(()=>{input.current?.focus();input.current?.select();},[controller,state.focusRevision]);
 const result=state.error?t(state.error):state.busy?t("Searching…"):state.overflow?t("200+ matches (first 200 retained)"):state.count===0?t("No matches"):state.index<0?t("{{count}} matches",{count:state.count}):t("{{index}} of {{count}}",{index:state.index+1,count:state.count});
 return <div className="terminal-find" role="search" aria-label={t("Terminal buffer search")}>
  <input ref={input} aria-label={t("Find in terminal")} autoCorrect="off" autoCapitalize="none" spellCheck={false} value={draft} placeholder={t("Find in retained terminal buffer")} onChange={event=>{setDraft(event.target.value);if(!composing.current)void controller.setQuery(event.target.value);}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;setDraft(event.currentTarget.value);void controller.setQuery(event.currentTarget.value);}} onKeyDown={event=>{
   if(event.nativeEvent?.isComposing||event.keyCode===229||composing.current||event.repeat)return;
   if(event.key==="Enter"||event.key==="Escape"){event.preventDefault();event.stopPropagation();if(event.key==="Escape")onClose();else if(!state.busy)void controller.navigate(event.shiftKey?-1:1);}
  }}/>
  <button type="button" aria-label={t("Match case")} aria-pressed={state.caseSensitive} onClick={()=>void controller.setOptions({caseSensitive:!state.caseSensitive})}>{t("Aa")}</button>
  <button type="button" aria-label={t("Regular expression")} aria-pressed={state.regex} title={t("JavaScript Unicode regex. Empty and newline-only matches are skipped. 100 ms deadline.")} onClick={()=>void controller.setOptions({regex:!state.regex})}>.*</button>
  <button type="button" aria-label={t("Previous match")} disabled={state.busy||!state.count} onClick={()=>void controller.navigate(-1)}>↑</button>
  <button type="button" aria-label={t("Next match")} disabled={state.busy||!state.count} onClick={()=>void controller.navigate(1)}>↓</button>
  <span role={state.error?"alert":"status"}>{t(result)}</span>
  {state.highlightUnavailable&&<span className="terminal-find-note">{t("Active match selection only")}</span>}
  <button type="button" onClick={onLogSearch}>{t("Search saved logs")}</button>
  <button type="button" aria-label={t("Close terminal find")} onClick={onClose}>×</button>
 </div>;
}
