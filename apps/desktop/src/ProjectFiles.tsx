// Author: Jeff.Liu.
import {useEffect,useRef,useState} from "react";
import {invoke as nativeInvoke} from "@tauri-apps/api/core";
import {t} from "./i18n";
import {ProjectFilesController,relativeProjectFile,type ProjectFileRequest,type FilesInvoke} from "./project-files";
import {watchProjectRefresh} from "./project-refresh";
import type {FileEditorSnapshot} from "./file-editor";
import {ProjectTextEditor} from "./ProjectTextEditor";
function localDraftStorage():Storage|null{try{return window.localStorage;}catch{return null;}}

function fileError(code:string):string {
 switch(code){
  case "file_platform_unavailable":return t("Local file browsing and editing are not supported on this platform. Use an external editor for this project.");
  case "file_changed":return t("The file changed on disk. Your draft is kept. Reload to review the latest version.");
  case "file_too_large":return t("This editor supports text files up to 1 MiB.");
  case "files_directory_too_large":return t("This directory has more than 2000 entries. Choose a smaller directory.");
  case "files_binary":case "file_invalid_utf8":return t("This file is not supported UTF-8 text. Its contents were not changed.");
  case "files_tabs_full":return t("Up to 16 files can stay open across projects. Close a file before opening another.");
  case "files_save_failed":return t("Could not save this file. Your draft is kept.");
  default:return t("This file or directory is unavailable. Refresh files or choose another entry.");
 }
}

export function ProjectFiles({sessionId,root,active,invoke=nativeInvoke,request}:{sessionId:string|null;root:string;active:boolean;invoke?:FilesInvoke;request?:ProjectFileRequest|null}) {
 const controller=useRef(new ProjectFilesController(localDraftStorage())),mounted=useRef(false);
 const [,refresh]=useState(0),[discard,setDiscard]=useState(""),[clearCache,setClearCache]=useState("");
 const rootElement=useRef<HTMLElement|null>(null),focusIntent=useRef<Element|null>(null),focusRequest=useRef(0);
 const editorMemory=useRef(new Map<string,{snapshot?:FileEditorSnapshot}>());
 const handled=useRef(0);const [location,setLocation]=useState<{scope:string;path:string;id:number;line:number}|null>(null);
 const c=controller.current,scope=JSON.stringify([sessionId,root]);
 const ready=!!sessionId&&c.scope===scope,doc=ready?c.document:undefined,selected=ready?c.selected:"";
 const discardKey=JSON.stringify([scope,selected,doc?.revision]);
 function run(action:()=>Promise<void>){const pending=action();refresh(v=>v+1);void pending.finally(()=>{if(mounted.current)refresh(v=>v+1);});}
 function closeFile(path:string){
  focusIntent.current=null;setDiscard("");if(!c.close(path)){refresh(v=>v+1);return;}
  editorMemory.current.delete(JSON.stringify([scope,path]));refresh(v=>v+1);
  if(typeof document!=='undefined'){
   const origin=document.activeElement;
   requestAnimationFrame(()=>{const root=rootElement.current;if(root&&c.scope===scope&&active&&!root.closest('[hidden]')&&(document.activeElement===origin||document.activeElement===document.body)){(root.querySelector<HTMLElement>('.project-file-tabs [aria-current="page"]')??root).focus();}});
  }
 }
 function openFile(path:string){focusRequest.current++;focusIntent.current=typeof document!=='undefined'?document.activeElement:null;setLocation(null);setDiscard("");setClearCache("");run(async()=>{await c.open(invoke,path);if(c.scope===scope&&c.selected===path&&c.document&&(c.document.recovered||c.document.draft!==c.document.text))await c.checkDisk(invoke);});}
 useEffect(()=>{
  let disposed=false;mounted.current=true;setDiscard("");setClearCache("");
  if(active&&sessionId){c.select(sessionId,root);run(async()=>{await c.browse(invoke,c.directory);if(!disposed)await c.checkDisk(invoke);});}
  const stop=active&&sessionId?watchProjectRefresh(async()=>{if(c.loading||c.reading||c.document?.saving)return;await c.browse(invoke,c.directory);if(!disposed)await c.checkDisk(invoke);if(!disposed)refresh(v=>v+1);}):()=>{};
  const check=()=>{if(active&&sessionId&&!disposed)run(()=>c.checkDisk(invoke));};
  if(active&&typeof window!=="undefined")window.addEventListener("focus",check);
  return()=>{disposed=true;stop();mounted.current=false;c.cancel();if(typeof window!=="undefined")window.removeEventListener("focus",check);};
 },[sessionId,root,active,invoke]);
 useEffect(()=>{
  if(!active||!request||!Number.isSafeInteger(request.id)||request.id<=handled.current)return;
  handled.current=request.id;
  if(request.sessionId!==sessionId||c.scope!==scope||relativeProjectFile(root,`${root.replace(/\/+$/,"")}/${request.path}`)!==request.path||request.line!==null&&(!Number.isSafeInteger(request.line)||request.line<1))return;
  const target=request;focusRequest.current++;focusIntent.current=typeof document!=='undefined'?document.activeElement:null;setDiscard("");setClearCache("");
  run(async()=>{await c.open(invoke,target.path);if(handled.current!==target.id||c.scope!==scope||c.selected!==target.path||!c.document)return;await c.checkDisk(invoke);if(handled.current===target.id&&c.scope===scope&&c.selected===target.path)setLocation(target.line===null?null:{scope,path:target.path,id:target.id,line:target.line});});
 },[request,sessionId,root,active,invoke]);
 const editorKey=JSON.stringify([scope,selected]);
 let memory=editorMemory.current.get(editorKey);
 if(doc&&!memory){memory={};editorMemory.current.set(editorKey,memory);if(editorMemory.current.size>16)editorMemory.current.delete(editorMemory.current.keys().next().value!);}
 if(!active)return null;
 const tabs=ready?c.tabs:[],recoverable=ready?c.recoverable.filter(item=>!tabs.some(tab=>tab.path===item.path)):[];
 return <section ref={rootElement} tabIndex={-1} className="project-files" aria-label={t("Project files")} onKeyDownCapture={event=>{
   if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='w'&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();if(selected)closeFile(selected);}
  }}>
  {!sessionId?<p>{t("Select a local session to browse and edit its project files.")}</p>:<>
   <p className="project-files-root" title={root}>{root.split(/[\\/]/).filter(Boolean).pop()||root}</p>
   <div className="project-files-layout">
    <nav aria-label={t("Project directory")}>
     <div className="project-files-controls"><button type="button" disabled={!ready||!c.directory||c.loading||c.error==="file_platform_unavailable"} onClick={()=>run(()=>c.browse(invoke,c.directory.split("/").slice(0,-1).join("/")))}>{t("Parent directory")}</button><button type="button" disabled={!ready||c.loading||c.error==="file_platform_unavailable"} onClick={()=>run(()=>c.browse(invoke,c.directory))}>{t("Refresh files")}</button></div>
     <p>{ready&&c.directory||"/"}</p>
     {ready&&c.loading&&<p role="status">{t("Loading files…")}</p>}
     {ready&&!c.loading&&c.entries.length===0&&!c.error&&<p>{t("Empty directory")}</p>}
     <ul>{ready&&c.entries.map(entry=>{const path=c.directory?`${c.directory}/${entry.name}`:entry.name;return <li key={entry.name}><button type="button" title={entry.name} aria-current={!entry.directory&&c.selected===path?"page":undefined} onClick={()=>{setDiscard("");if(entry.directory)run(()=>c.browse(invoke,path));else openFile(path);}}><span aria-hidden="true">{entry.directory?"▸":"·"}</span> {entry.name}</button></li>;})}</ul>
    </nav>
    <div className="project-file-editor">
     {tabs.length>0&&<div className="project-file-tabs" role="group" aria-label={t("Open project files")}>{tabs.map(tab=><span key={tab.path}><button type="button" aria-current={selected===tab.path?"page":undefined} title={tab.path} onClick={()=>openFile(tab.path)}>{tab.path}{tab.dirty?" *":""}</button><button type="button" aria-label={t("Close file {{value0}}",{value0:tab.path})} disabled={tab.saving} data-close-active-file={selected===tab.path} onClick={()=>closeFile(tab.path)}>×</button></span>)}</div>}
     {recoverable.length>0&&<details><summary>{t("Local unsaved drafts")}</summary><ul>{recoverable.map(item=><li key={item.path}><button type="button" onClick={()=>openFile(item.path)}>{item.path}</button></li>)}</ul></details>}
     {ready&&c.draftError&&<div role="alert"><p>{c.draftError==="files_draft_changed"?t("Another editor updated this recovery copy. Current text is kept in memory; save the file or compare the drafts before closing."):c.draftError==="files_draft_limit"?t("Recovery cache is limited to 16 drafts and 2 MiB. Save or clear unneeded drafts; current text is kept in memory."):t("Local draft recovery is unavailable. Save before closing the tab or window. Project files can still be saved manually.")}</p>{c.draftError!=="files_draft_changed"&&<button type="button" onClick={()=>setClearCache(scope)}>{t("Clear local recovery cache")}</button>}</div>}
     {clearCache===scope&&<div className="project-files-controls"><p>{t("Remove recovery copies for all projects? Open text stays in memory; closed unsaved drafts will lose their recovery copy.")}</p><button type="button" onClick={()=>{c.clearStoredDrafts();setClearCache("");refresh(v=>v+1);}}>{t("Confirm clear recovery cache")}</button><button type="button" onClick={()=>setClearCache("")}>{t("Keep recovery cache")}</button></div>}

     {ready&&c.reading&&<p role="status">{t("Reading selected file…")}</p>}
     {ready&&c.error&&<p role="alert">{fileError(c.error)}</p>}
     {!doc&&!c.reading&&<p>{t("Choose a text file to view or edit. UTF-8 files up to 1 MiB are supported.")}</p>}
     {doc&&<>
      <div className="project-files-controls project-file-actions"><span role="status">{doc.saving?t("Saving…"):doc.conflict?t("External conflict"):doc.text!==doc.draft?t("Unsaved changes"):t("Saved")}</span><button type="button" disabled={doc.saving||c.reading||doc.conflict||!doc.recovered&&doc.text===doc.draft} onClick={()=>run(()=>c.save(invoke))}>{t("Save file")}</button><details className="file-operations" open={doc.conflict||doc.recovered}>
        <summary>{t("File actions")}</summary>
        <button type="button" disabled={doc.saving||c.reading} onClick={()=>{if(doc.recovered||doc.text!==doc.draft)setDiscard(discardKey);else run(()=>c.open(invoke,c.selected));}}>{t("Reload from disk")}</button><button type="button" disabled={doc.saving||c.reading} onClick={()=>run(()=>c.checkDisk(invoke))}>{t("Check external changes")}</button>
      </details></div>
      {discard===discardKey&&<div className="project-files-controls"><p>{t("Discard this unsaved draft and reload the file?")}</p><button type="button" onClick={()=>{setDiscard("");run(()=>c.discard(invoke));}}>{t("Discard draft and reload")}</button><button type="button" onClick={()=>setDiscard("")}>{t("Keep editing")}</button></div>}
      {doc.error&&<p role="alert">{fileError(doc.error)}</p>}
      {doc.recovered&&<p role="status">{doc.conflict?t("Local draft recovered. Disk version is unverified or changed; saving is disabled until reviewed."):t("Local unsaved draft recovered. Save explicitly to update the file.")}</p>}
      <ProjectTextEditor focusRequest={focusRequest.current} focusOrigin={focusIntent.current} memory={memory} key={JSON.stringify([scope,selected])} filename={selected} location={location?.scope===scope&&location.path===selected?{id:location.id,line:location.line}:undefined} disabled={doc.saving||c.reading} value={doc.draft.replace(/\r\n?/g,"\n")} onChange={value=>{if(c.scope!==scope||c.selected!==selected)return;c.edit(value);refresh(v=>v+1);}} onSave={()=>{if(c.scope===scope&&c.selected===selected)run(()=>c.save(invoke));}} onInvalid={code=>{if(c.scope===scope&&c.document===doc){doc.error=code;refresh(v=>v+1);}}}/>
      <details className="file-recovery-help"><summary>{t("Draft recovery")}</summary><p>{t("Draft recovery copies stay on this computer, up to 16 drafts and 2 MiB. Returning to this window or checking external changes revalidates the disk version. Close tabs to keep recovery copies; save before closing if recovery is unavailable.")}</p></details>
     </>}
    </div>
   </div>
  </>}
 </section>;
}
