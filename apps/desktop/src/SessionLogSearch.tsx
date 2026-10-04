import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {LatestLogRequest,formatRetainedRange,isSafeLogOffset,logHitPosition,type LogHit,type LogSearchPage,type LogSourceCursor} from "./session-logs";

type Props={sessions:{id:string;title:string;cwd:string}[];selected:string|null;onClose:()=>void;onSelect:(id:string)=>Promise<void>};

export function SessionLogSearch({sessions,selected,onClose,onSelect}:Props) {
 const dialog=useRef<HTMLDialogElement>(null);
 const queryInput=useRef<HTMLInputElement>(null);
 const requests=useRef(new LatestLogRequest());
 const previews=useRef(new LatestLogRequest());
 const [query,setQuery]=useState("");
 const [scope,setScope]=useState(selected??"");
 const [sensitive,setSensitive]=useState(false);
 const [page,setPage]=useState<LogSearchPage|null>(null);
 const [searched,setSearched]=useState("");
 const [skip,setSkip]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [hit,setHit]=useState<LogHit|null>(null);
 const [excerpt,setExcerpt]=useState<string|null>(null);
 useEffect(()=>{dialog.current?.showModal();queryInput.current?.focus();return()=>{
  requests.current.cancel();previews.current.cancel();
  void invoke("cancel_log_search").catch(()=>{});
 };},[]);
 async function search(next=0,sourceCursor:LogSourceCursor|null=null) {
  setBusy(true);setError(null);setHit(null);previews.current.cancel();
  try {
   const result=await requests.current.run(()=>invoke<LogSearchPage>("search_session_logs",{
    sessionId:scope||null,request:{query,case_sensitive:sensitive,skip:next,limit:50,source_cursor:sourceCursor}}));
   if(result===undefined)return;
   setPage(result);setSkip(next);setSearched(query);setBusy(false);
  }catch(reason){setError(String(reason));setBusy(false);}
 }
 async function cancel() {
  requests.current.cancel();
  try{await invoke("cancel_log_search");}catch(reason){setError(String(reason));}
  setBusy(false);
 }
 async function show(hit:LogHit) {
  setHit(hit);setExcerpt(null);setError(null);
  try{
   const text=await previews.current.run(async()=>{
    await onSelect(hit.session_id);
    if(!isSafeLogOffset(hit.offset))return "Recorded position unknown; excerpt unavailable";
    return invoke<string>("read_log_excerpt",{sessionId:hit.session_id,offset:hit.offset,column:hit.column});
   });
   if(text!==undefined)setExcerpt(text);
  }catch(reason){setError(String(reason));}
 }
 return <dialog ref={dialog} className="app-dialog log-search-dialog" aria-labelledby="log-search-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2 id="log-search-title">Search session logs</h2><button type="button" onClick={onClose} aria-label="Close log search">Close</button></header>
  <form className="dialog-fields" onSubmit={event=>{event.preventDefault();void search();}}>
   <label>Log content<input ref={queryInput} aria-label="Log content query" disabled={busy} maxLength={256} value={query} onChange={event=>{setQuery(event.target.value);setPage(null);setHit(null);previews.current.cancel();}}/></label>
   <label>Search scope<select aria-label="Log search scope" disabled={busy} value={scope} onChange={event=>{setScope(event.target.value);setPage(null);setHit(null);previews.current.cancel();}}>
    <option value="">All sessions</option>{scope&&!sessions.some(session=>session.id===scope)&&<option value={scope}>{scope}</option>}{sessions.map(session=><option key={session.id} value={session.id}>{session.title} · {session.cwd}</option>)}
   </select></label>
   <label className="log-checkbox"><input type="checkbox" checked={sensitive} disabled={busy} onChange={event=>{setSensitive(event.target.checked);setPage(null);setHit(null);previews.current.cancel();}}/>Match case</label>
   <div className="dialog-actions"><button type="submit" disabled={busy||!query.trim()}>{busy?"Searching…":"Search logs"}</button>{busy&&<button type="button" onClick={()=>void cancel()}>Cancel search</button>}</div>
  </form>
  <p className="log-note">Searches retained output only. Older output may have been removed. Each page scans the current records.</p>
  {error&&<p role="alert">{error}</p>}
  {page&&<section aria-label="Log search results">
   <p role="status">{page.hits.length} matching lines for “{searched}”{!page.complete?" · Partial results":""}</p>
   {page.scanned_ranges?.map(range=><p key={range.session_id} className="log-note">{sessions.find(s=>s.id===range.session_id)?.title??range.session_id} · {formatRetainedRange(range.range)} · {range.line_scan_complete?"Retained lines scanned":"Line scan incomplete"}</p>)}
   {page.issues.map((issue,index)=><p key={index} className="log-note">{issue}</p>)}
   <ul className="log-results">{page.hits.map(hit=><li key={`${hit.session_id}:${hit.offset}`}><button type="button" onClick={()=>void show(hit)}>
    <strong>{sessions.find(s=>s.id===hit.session_id)?.title??hit.session_id}</strong><span>{hit.cwd} · {logHitPosition(hit,page.scanned_ranges)}</span><pre>{hit.text}</pre>
   </button></li>)}</ul>
   <div className="dialog-actions">{skip>0&&<button disabled={busy} onClick={()=>void search(Math.max(0,skip-50),page.current_cursor??null)}>Previous results</button>}{page.has_more&&<button disabled={busy||skip>=5000} onClick={()=>void search(skip+50,page.current_cursor??null)}>Next results</button>}{page.next_cursor&&<button disabled={busy} onClick={()=>void search(0,page.next_cursor??null)}>Continue search</button>}</div>
  </section>}
  {hit&&<section aria-label="Recorded log location"><h3>Recorded output · {logHitPosition(hit,page?.scanned_ranges)}</h3><pre className="log-excerpt">{excerpt??hit.text}</pre><p className="log-note">Bounded text excerpt around the matching position. The selected terminal remains available after closing this dialog.</p></section>}
 </dialog>;
}
