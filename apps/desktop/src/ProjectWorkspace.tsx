// Author: Jeff.Liu. Presentation only; the existing tools keep their state and native owners.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {t} from './i18n';
import {workspaceWidth,resizeWorkspace} from './project-workspace';
const storageKey='yam.projectWorkspaceWidth.v1';
export function ProjectWorkspace({open,onClose,onResize,children}:{open:boolean;onClose:()=>void;onResize:()=>void;children:ReactNode}){
 const root=useRef<HTMLElement|null>(null),close=useRef<HTMLButtonElement|null>(null),drag=useRef<{pointer:number;x:number;width:number}|null>(null);
 const [width,setWidth]=useState(()=>{try{return workspaceWidth(window.localStorage.getItem(storageKey));}catch{return 560;}});
 const latest=useRef(onResize);latest.current=onResize;
 useEffect(()=>{latest.current();if(open)close.current?.focus();},[open]);
 useEffect(()=>{if(open)latest.current();},[width]);
 function save(value:number){try{window.localStorage.setItem(storageKey,String(value));}catch{/* An unavailable layout preference does not block the workspace. */}}
 function finish(){if(drag.current){drag.current=null;save(width);latest.current();}}
 return <aside ref={root} className="project-workspace" aria-labelledby="project-tools-title" hidden={!open} style={{width}} onKeyDown={event=>{
  if(event.key==='Escape'&&!event.nativeEvent.isComposing&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}
 }}>
  <div className="project-workspace-resizer" role="separator" aria-label={t('Resize project workspace')} aria-orientation="vertical" aria-valuemin={360} aria-valuemax={900} aria-valuenow={width} tabIndex={0}
   onPointerDown={event=>{if(event.button!==0)return;drag.current={pointer:event.pointerId,x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}}
   onPointerMove={event=>{const d=drag.current;if(d?.pointer===event.pointerId)setWidth(resizeWorkspace(d.width,d.x,event.clientX));}}
   onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
   onKeyDown={event=>{const next=event.key==='ArrowLeft'?width+24:event.key==='ArrowRight'?width-24:event.key==='Home'?360:event.key==='End'?900:null;if(next===null)return;event.preventDefault();event.stopPropagation();const value=workspaceWidth(String(next));setWidth(value);save(value);}}/>
  <header className="project-workspace-header"><h2 id="project-tools-title">{t('Project workspace')}</h2><button ref={close} type="button" onClick={onClose} aria-label={t('Close project tools')}>{t('Return to terminal')}</button></header>
  {children}
 </aside>;
}
