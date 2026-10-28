// Author: Jeff.Liu. Keep CodeMirror outside the startup bundle and dispose every file view.
import {useLayoutEffect,useRef,useState} from 'react';
import {t} from './i18n';
import type {FileEditorHandle,FileEditorSnapshot} from './file-editor';
type Props={focusRequest?:number;focusOrigin?:Element|null;memory?:{snapshot?:FileEditorSnapshot};value:string;filename:string;disabled:boolean;onChange:(text:string)=>void;onSave:()=>void;onInvalid:(code:string)=>void;location?:{id:number;line:number}};
export function ProjectTextEditor({focusRequest,focusOrigin,memory,value,filename,disabled,onChange,onSave,onInvalid,location}:Props){
 const host=useRef<HTMLDivElement|null>(null),editor=useRef<FileEditorHandle|null>(null);
 const latest=useRef({value,disabled,onChange,onInvalid,location,focusOrigin});latest.current={value,disabled,onChange,onInvalid,location,focusOrigin};
 const located=useRef<number|null>(null);const [notice,setNotice]=useState("");
 const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
 useLayoutEffect(()=>{
  let disposed=false;setReady(false);setFailed(false);
  void import('./file-editor').then(async api=>{
   const language=await api.syntaxForPath(filename);if(disposed||!host.current)return;
   const current=latest.current;
   editor.current=api.mountFileEditor(host.current,{snapshot:memory?.snapshot,text:current.value,language,disabled:current.disabled,label:t('Project file text'),onChange:text=>{if(!disposed)latest.current.onChange(text);},onInvalid:code=>{if(!disposed)latest.current.onInvalid(code);}});
   setReady(true);

  }).catch(()=>{if(!disposed)setFailed(true);});
  return()=>{disposed=true;if(editor.current&&memory)memory.snapshot=editor.current.snapshot();editor.current?.destroy();editor.current=null;};
 },[filename,memory]);
 useLayoutEffect(()=>{
  editor.current?.sync(value,disabled);
  if(ready&&location&&located.current!==location.id&&editor.current){
   located.current=location.id;const exact=editor.current.revealLine(location.line,(document.activeElement===latest.current.focusOrigin||!!host.current?.contains(document.activeElement))&&!host.current?.closest('[hidden]'));
   setNotice(exact?"Position refers to the current draft; compare it with the displayed diff snapshot.":"The snapshot line is beyond the current draft. Located the last available line.");
   host.current?.scrollIntoView({block:"nearest"});
  }
 },[value,disabled,location?.id,ready]);
 useLayoutEffect(()=>{
  const workspace=host.current?.closest('.project-workspace');
  if(ready&&!disabled&&workspace&&!host.current?.closest('[hidden]')&&workspace.contains(document.activeElement)&&document.activeElement===latest.current.focusOrigin)editor.current?.focus();
 },[ready,disabled,focusRequest]);
 return <div className="project-code-editor" onKeyDownCapture={event=>{
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='s'){
   event.preventDefault();event.stopPropagation();if(!disabled&&!event.nativeEvent.isComposing)onSave();
  }
 }}>
  {notice&&<p role="status">{t(notice)}</p>}
  {!ready&&!failed&&<p role="status">{t('Loading code editor…')}</p>}
  <div ref={host} hidden={!ready}/>
  {failed&&<><p role="alert">{t('Code editor unavailable. Basic text editing and safe saving remain available.')}</p><textarea aria-label={t('Project file text')} spellCheck={false} wrap="off" rows={20} disabled={disabled} value={value} onChange={event=>onChange(event.target.value)}/></>}
 </div>;
}
