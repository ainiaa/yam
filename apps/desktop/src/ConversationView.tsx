import {i18n} from "./i18n";
import {t} from "./i18n";
// Author: Jeff.Liu.
import {useEffect,useRef,useState} from "react";
import {ConversationController,type ConversationState,type ConversationInvoke} from "./conversation-view";
import {FilePreview} from "./FilePreview";
type ConversationTarget={sessionId:string;threadId:string;generation:string};
export function ConversationView({scope,visible,available,target,invoke,onTerminal,roundRevision=null}:{scope:string;visible:boolean;available:boolean;target:ConversationTarget|null;invoke:ConversationInvoke;onTerminal:()=>void;roundRevision?:number|null}){
 const controller=useRef(new ConversationController()),mounted=useRef(false),current=useRef({scope,visible,available}),panel=useRef<HTMLElement|null>(null);
 current.current={scope,visible,available};
 const [snapshot,setSnapshot]=useState<{scope:string;state:ConversationState}|null>(null),[file,setFile]=useState<{id:number;target:{sessionId:string;path:string}}|undefined>(undefined);
 const anchor=useRef<{scope:string;top:number;height:number;prepend:boolean}|null>(null),focus=useRef<HTMLElement|null>(null),restoreFocus=useRef(false);
 const state=snapshot?.scope===scope?snapshot.state:null,value=state&&state.kind!=="idle"?state.value:null;
 function changed(more=false){if(mounted.current&&current.current.scope===scope&&current.current.visible){const next=controller.current.snapshot;if(next.kind==="ready"&&value&&panel.current)anchor.current={scope,top:panel.current.scrollTop,height:panel.current.scrollHeight,prepend:more};setSnapshot({scope,state:next});}}
 function load(more=false){
  if(!mounted.current||!current.current.visible||!current.current.available||current.current.scope!==scope||!target)return;
  void controller.current.load(invoke,()=>changed(more),more,roundRevision??0);
 }
 useEffect(()=>{
  mounted.current=true;controller.current.select(scope,target?.sessionId??"",target?.threadId??"",target?.generation??"",roundRevision??0);setSnapshot(null);setFile(undefined);anchor.current=null;focus.current=null;
  return()=>{mounted.current=false;controller.current.cancel();};
 },[scope,target?.sessionId,target?.threadId,target?.generation]);
 useEffect(()=>{
  if(visible){restoreFocus.current=true;if(available&&(controller.current.snapshot.kind==="idle"||controller.current.snapshot.kind==="loading"))load();else setSnapshot({scope,state:controller.current.snapshot});}
  return()=>{controller.current.cancel();anchor.current=null;setFile(undefined);};
 },[visible,available,scope,target?.sessionId,target?.threadId,target?.generation]);
 useEffect(()=>{if(visible&&available&&target&&roundRevision!==null)void controller.current.observe(invoke,()=>changed(),roundRevision);},[visible,available,scope,roundRevision]);
 useEffect(()=>{if(!visible||!restoreFocus.current||state?.kind==="loading")return;restoreFocus.current=false;const last=focus.current;if(last&&panel.current?.contains(last))last.focus({preventScroll:true});else panel.current?.focus({preventScroll:true});},[visible,state]);
 useEffect(()=>{const saved=anchor.current;anchor.current=null;if(saved?.scope===scope&&panel.current)panel.current.scrollTop=saved.top+(saved.prepend?panel.current.scrollHeight-saved.height:0);},[value]);
 function preview(path:string){if(current.current.scope===scope&&current.current.visible&&target)setFile({id:Date.now(),target:{sessionId:target.sessionId,path}});}
 return <section className="conversation-view" aria-label={t("Conversation")} tabIndex={-1} ref={panel} hidden={!visible} onFocusCapture={event=>{if(event.target!==event.currentTarget)focus.current=event.target as HTMLElement;}}>
  <h2>{t("Conversation")}</h2><button type="button" onClick={onTerminal}>{t("Open Terminal")}</button><p>{t("Read-only history. Use Terminal for input, approvals and stopping tasks. Saved messages are not a live token stream.")}</p>
  {!available?<p role="alert">{t("Background connection unavailable. Reconnect using the existing recovery controls.")}</p>:!target?<p role="status">{t("History requires a verified local Codex conversation. Continue using Terminal.")}</p>:<>
   <button type="button" disabled={state?.kind==="loading"||!!value&&value.items.length>=500} onClick={()=>load()}>{t("Refresh conversation")}</button>
   <p role="status" style={{visibility:!state||state.kind==="loading"?"visible":"hidden"}}>{t("Loading conversation…")}</p>
   {state?.kind==="unavailable"&&<div role="alert"><p>{t("Conversation unavailable (")}{state.code}{t("). Continue using Terminal.")}</p>{state.code==="conversation_view_limit"?<p>{t("500 record limit reached. Loaded history is preserved.")}</p>:state.code==="conversation_history_gap"?<p>{t("The latest page no longer overlaps this view. Select another session and return to read a fresh page.")}</p>:<button type="button" onClick={()=>load()}>{t("Retry conversation")}</button>}</div>}
   {value&&<>
    <p className="conversation-source">{t("Source: Codex")+" "}{value.thread_id} {t("· Read at")+" "}{new Date(value.read_at).toLocaleString(i18n.language)} · {value.items.length}{t("/500 records")}</p>
    {!value.items.length&&<p>{t("No saved messages.")}</p>}
    {value.items.length>=500?<p role="status">{t("500 record limit reached. Loaded history is preserved.")}</p>:value.next_cursor&&<button type="button" disabled={state?.kind==="loading"} onClick={()=>load(true)}>{t("Load older messages")}</button>}
    <div className="conversation-messages">{value.items.map(item=><article key={JSON.stringify([item.turn_id,item.id])} data-item-id={item.id} className={`conversation-message conversation-${item.kind}`}>
     <h3>{item.kind==="user"?t("User"):item.kind==="agent"?t("Agent"):item.kind==="tool"?t("Tool"):item.kind==="file"?t("File changes"):t("Unsupported record")}</h3>
     {item.kind==="unknown"?<p>{t("Unsupported record. Read its original output in Terminal.")}</p>:item.kind==="tool"?<details><summary>{t("Tool details")}</summary><pre>{item.text}</pre></details>:<pre>{item.text}</pre>}
     {item.truncated&&<p>{t("Display truncated at 64 KiB. Full output remains in Terminal.")}</p>}
     {item.paths.map(path=><button type="button" key={path} onClick={()=>preview(path)}>{t("Preview")+" "}{path}</button>)}
    </article>)}</div>
   </>}
  </>}
  <FilePreview scope={`${scope}:${visible&&available?"open":"closed"}`} invoke={invoke} request={visible&&available&&snapshot?.scope===scope?file:undefined}/>
 </section>;
}
