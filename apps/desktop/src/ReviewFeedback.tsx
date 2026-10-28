// Author: Jeff.Liu. Explicit original-session input, with a preview and no Enter key.
import {useEffect,useRef,useState} from 'react';
import {t} from './i18n';
import {combineReviewComments,formatReviewFeedback,sameReviewOrigin,type ReviewComment,type ReviewLocation,type ReviewOrigin} from './review-feedback';
type Props={active:boolean;origin:ReviewOrigin|null;ready:boolean;location:ReviewLocation|null;onFill:(origin:ReviewOrigin,location:ReviewLocation,text:string)=>Promise<void>};
export function ReviewFeedback({active,origin,ready,location,onFill}:Props){
 const mounted=useRef(false),flight=useRef(false),field=useRef<HTMLTextAreaElement|null>(null),seen=useRef<ReviewLocation|null>(null);
 const [draft,setDraft]=useState<{origin:ReviewOrigin|null;location:ReviewLocation|null;text:string;filled:string|null}>({origin:null,location:null,text:'',filled:null});
 const [comments,setComments]=useState<ReviewComment[]>([]);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(!location||seen.current===location)return;seen.current=location;if(active){field.current?.scrollIntoView({block:'nearest'});field.current?.focus();}},[location,active]);
 let preview:string|null=null,body=draft.text;
 const target=draft.location??comments[0]?.location;
 if(draft.origin&&target)try{if(comments.length)body=combineReviewComments(draft.origin,[...comments,...(draft.text.trim()?[{location:target,text:draft.text}]:[])]);preview=formatReviewFeedback(draft.origin,target,body);}catch{}
 let canAdd=false;
 if(draft.origin&&target&&draft.text.trim()&&comments.length<20)try{combineReviewComments(draft.origin,[...comments,{location:target,text:draft.text}]);canAdd=true;}catch{}
 const same=sameReviewOrigin(draft.origin,origin),canFill=!!preview&&same&&ready&&!busy&&draft.filled!==preview;
 async function fill(){
  if(!canFill||flight.current||!draft.origin||!target)return;
  flight.current=true;setBusy(true);setMessage(null);
  try{await onFill(draft.origin,target,body);if(mounted.current){setDraft(current=>current===draft?{...current,filled:preview}:current);setMessage('Feedback was filled into the original CLI. Check the input and press Enter there to submit.');}}
  catch(reason){if(mounted.current)setMessage(reason==='review_target_unavailable'?'The original CLI cannot receive this feedback now. Nothing was filled.':reason==='review_invalid_feedback'?'Choose a diff location and use up to 16 KiB of text without terminal controls.':'Delivery could not be confirmed. Check the original terminal before retrying.');}
  finally{flight.current=false;if(mounted.current)setBusy(false);}
 }
 if(!active)return null;
 const currentLocation=location&&origin&&location.sessionId===origin.sessionId?location:null;
 return <section className="review-feedback" aria-label={t('Review feedback')}>
  <h3>{t('Review feedback')}</h3>
  <p>{t('Opinions stay in this window. Record a fresh baseline first to compare the next round separately.')}</p>
  {draft.origin&&<p>{t('Original native session')}: <code>{draft.origin.nativeSessionId}</code></p>}
  {!same&&(draft.text||comments.length>0)&&<p role="status">{t('The native target changed or is not bound. The draft is kept; binding requires an explicit action.')}</p>}
  {!ready&&<p role="status">{t('Filling requires a connected, idle native CLI in the selected local session.')}</p>}
  <div className="project-files-controls">
   {origin&&!same&&<button type="button" disabled={busy||comments.length>0} onClick={()=>{setDraft(current=>({...current,origin,location:currentLocation,filled:null}));setMessage(null);}}>{t('Bind current native session')}</button>}
   {currentLocation&&<button type="button" disabled={busy||!same} onClick={()=>{setDraft(current=>({...current,location:currentLocation,filled:null}));setMessage(null);}}>{t('Use selected diff location')}</button>}
   <button type="button" disabled={busy} onClick={()=>{setComments([]);setDraft({origin,location:currentLocation,text:'',filled:null});setMessage(null);}}>{t('New feedback')}</button>
  </div>
  {draft.location&&<p>{draft.location.path} · {draft.location.basis} · {draft.location.side} · {draft.location.line??t('Whole file')}</p>}
  <textarea ref={field} aria-label={t('Review comment')} rows={5} maxLength={16384} disabled={busy} value={draft.text} onChange={event=>{
   if(flight.current)return;const text=event.target.value;
   setDraft(current=>{const bound=current.origin??origin;return{...current,text,origin:bound,location:current.location??(location&&bound&&location.sessionId===bound.sessionId?location:null),filled:null};});setMessage(null);
  }}/>
  <div className="project-files-controls"><button type="button" disabled={busy||!same||!canAdd} onClick={()=>{if(!draft.origin||!target||!canAdd||flight.current)return;setComments(current=>[...current,{location:target,text:draft.text}]);setDraft(current=>({...current,text:'',filled:null}));setMessage(null);}}>{t('Add comment')}</button><span>{comments.length} / 20 {t('Saved review comments')}</span></div>
  {draft.text&&!canAdd&&<p role="status">{t('Comments must fit in 16 KiB total including file context. Shorten the current comment or remove an earlier one.')}</p>}
  {!same&&comments.length>0&&<p role="status">{t('Queued comments stay bound to their original session. Return to that session, or remove the queued comments before rebinding.')}</p>}
  {comments.length>0&&<ol>{comments.map((item,index)=><li key={index}><strong>{item.location.path} · {item.location.side} · {item.location.line??t('Whole file')}</strong><p>{item.text}</p><button type="button" disabled={busy} onClick={()=>{if(flight.current)return;setComments(current=>current.filter((_,i)=>i!==index));setDraft(current=>({...current,filled:null}));}}>{t('Remove comment')}</button></li>)}</ol>}
  {preview?<details><summary>{t('Preview exact CLI input')}</summary><pre>{preview}</pre></details>:(draft.text||comments.length>0)&&<p role="status">{t('Choose a diff location and use up to 16 KiB of text without terminal controls.')}</p>}
  <button type="button" disabled={!canFill} onClick={()=>void fill()}>{busy?t('Filling…'):t('Fill original CLI input')}</button>
  {message&&<p role="status">{t(message)}</p>}
 </section>;
}
