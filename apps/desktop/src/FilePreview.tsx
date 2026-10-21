import {i18n} from "./i18n";
import {t} from "./i18n";
// Author: Jeff.Liu.
import {useEffect,useRef,useState} from "react";
import {FilePreviewController,textLineOffset,findText,type PreviewTarget,type PreviewInvoke,type FilePreviewState,type PreviewImage} from "./file-preview";

export function FileImage({image}:{image:PreviewImage}){
 const element=useRef<HTMLImageElement|null>(null),latest=useRef(image);latest.current=image;
 const [resource,setResource]=useState<{image:PreviewImage;url:string}|null>(null),[fit,setFit]=useState(true),[scale,setScale]=useState(1),[failed,setFailed]=useState(false);
 useEffect(()=>{
  const data=Uint8Array.from(atob(image.data_base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([data],{type:image.mime}));
  setResource({image,url});setFit(true);setScale(1);setFailed(false);
  return()=>URL.revokeObjectURL(url);
 },[image]);
 const src=resource?.image===image?resource.url:null;
 function zoom(factor:number){const measured=fit?element.current?.getBoundingClientRect().width:undefined;const base=measured?measured/image.width:scale;setFit(false);setScale(Math.max(1/Math.max(image.width,image.height),Math.min(4,base*factor)));}
 return <div className="file-preview-image">
  <div className="file-preview-controls"><button type="button" onClick={()=>setFit(true)}>{t("Fit image")}</button><button type="button" disabled={!src||failed} onClick={()=>zoom(.8)}>{t("Zoom out")}</button><button type="button" disabled={!src||failed} onClick={()=>zoom(1.25)}>{t("Zoom in")}</button><span>{image.width} × {image.height} · {fit?t("Fit"):`${Math.round(scale*100)}%`}</span></div>
  {src&&(failed?<p role="alert">{t("Cannot decode this static image.")}</p>:<div className="file-preview-image-scroll"><img ref={element} src={src} alt={t("Selected project file")} onError={()=>{if(latest.current===image)setFailed(true);}} style={fit?{maxWidth:"100%",maxHeight:"50vh",width:"auto",height:"auto",objectFit:"contain"}:{width:Math.max(1,Math.round(image.width*scale)),height:"auto",maxWidth:"none"}}/></div>)}
 </div>;
}

export function FilePreview({scope,invoke,request}:{scope:string;invoke:PreviewInvoke;request?:{id:number;target?:PreviewTarget}}){
 const controller=useRef(new FilePreviewController()),mounted=useRef(false),current=useRef(scope),root=useRef<HTMLDivElement|null>(null),content=useRef<HTMLTextAreaElement|null>(null);
 current.current=scope;
 const [snapshot,setSnapshot]=useState<{scope:string;state:FilePreviewState}|null>(null),[line,setLine]=useState(""),[query,setQuery]=useState(""),[notice,setNotice]=useState("");
 const lastTarget=useRef<PreviewTarget|undefined>(undefined),matchEnd=useRef(0);
 const state=snapshot?.scope===scope?snapshot.state:null,value=state?.kind==="ready"?state.value:null;
 const displayText=value?.kind==="text"?value.text.replace(/\r\n?/g,"\n"):"";
 function close(){controller.current.cancel();setSnapshot(null);setNotice("");}
 function load(target?:PreviewTarget){
  if(!mounted.current||current.current!==scope)return;
  controller.current.select(scope);
  lastTarget.current=target;matchEnd.current=0;setNotice("");
  void controller.current.load(invoke,state=>{if(mounted.current&&current.current===scope)setSnapshot({scope,state});},target);
 }
 useEffect(()=>{
  mounted.current=true;controller.current.select(scope);setSnapshot(null);setLine("");setQuery("");setNotice("");
  const dialog=root.current?.closest("dialog");const onClose=()=>close();dialog?.addEventListener("close",onClose);
  return()=>{mounted.current=false;controller.current.cancel();dialog?.removeEventListener("close",onClose);};
 },[scope]);
 useEffect(()=>{if(request)load(request.target);},[request?.id,scope]);
 function select(start:number,end:number){
  const textarea=content.current;if(!textarea||!value)return;
  textarea.focus();textarea.setSelectionRange(start,end);
  const row=displayText.slice(0,start).split("\n").length-1;
  textarea.scrollTop=row*(parseFloat(getComputedStyle(textarea).lineHeight)||20);setNotice("");
 }
 function jump(){const at=value&&/^\d+$/.test(line)?textLineOffset(displayText,Number(line)):-1;if(at<0)setNotice("Line is outside this file.");else select(at,at);}
 function find(){const match=value?findText(displayText,query,matchEnd.current):null;if(!match)setNotice("Text not found.");else{matchEnd.current=match.end;select(match.start,match.end);}}
 return <div className="file-preview" ref={root}>
  <button type="button" onClick={()=>load()}>{t("Choose file to preview")}</button>
  {state&&<section aria-label={t("Read-only file preview")}>
   <div className="file-preview-heading"><h4>{t("File preview")}</h4><button type="button" onClick={close}>{t("Close file preview")}</button></div>
   {state.kind==="loading"&&<p role="status">{t("Reading selected file…")+" "}{!lastTarget.current&&t("Complete or cancel the native file chooser to continue.")}</p>}
   {state.kind==="unavailable"&&<div role="alert"><p>{t("File preview unavailable (")}{state.code}).</p><button type="button" onClick={()=>load(lastTarget.current)}>{t("Retry file preview")}</button></div>}
   {value&&<>
    <p className="file-preview-path">{value.path}</p><p>{t("Current working tree · read only ·")+" "}{value.bytes} {t("bytes. Read at")+" "}{new Date(value.read_at).toLocaleString(i18n.language)}.</p>
    <p>{t("Source:")+" "}{value.session_id?t("session directory {{value0}}", {value0:value.root}):t("native file selection ({{value0}})", {value0:value.root})}{t(". File contents do not identify which agent changed them.")}</p>
    {value.kind==="image"?<FileImage image={value}/>:<>
    <div className="file-preview-controls">
     <label>{t("Line")+" "}<input aria-label={t("Preview line number")} type="number" min="1" step="1" value={line} onChange={e=>setLine(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();jump();}}}/></label><button type="button" onClick={jump}>{t("Go to line")}</button>
     <label>{t("Find")+" "}<input aria-label={t("Find in file")} value={query} onChange={e=>{setQuery(e.target.value);matchEnd.current=0;}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();find();}}}/></label><button type="button" onClick={find} disabled={!query}>{t("Find next")}</button>
    </div>
    {notice&&<p role="status">{t(notice)}</p>}{!displayText&&<p>{t("Empty file")}</p>}
    <textarea ref={content} aria-label={t("File preview text")} readOnly wrap="off" rows={18} spellCheck={false} value={displayText}/>
    </>}
   </>}
  </section>}
 </div>;
}
