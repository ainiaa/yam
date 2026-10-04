// Author: Jeff.Liu. Fixed pane membership plus an accessible two-pane split control.
import {useEffect,useRef,useState} from "react";
import type {CSSProperties} from "react";
import type {TerminalLayoutMode,TerminalLayoutState} from "./terminal-layout";
import {clampSplitPercent} from "./terminal-layout";

type Props={layout:TerminalLayoutState;labels:(string|null)[];splitPercent:number;swapDisabled:boolean|((target:number)=>boolean);onMode:(mode:TerminalLayoutMode)=>void;onFocus:(pane:number,focusInput?:boolean)=>void;onClose:(pane:number)=>void;onHost:(pane:number,host:HTMLDivElement|null)=>void;onSplitChange:(percent:number)=>void;onSplitPreview:(percent:number)=>void;onSwap:(target?:number)=>void;onCancelFit:()=>void};
type Drag={pointerId:number;axis:"x"|"y";left:number;top:number;width:number;height:number;target:HTMLDivElement};

export function TerminalLayout({layout,labels,splitPercent,swapDisabled,onMode,onFocus,onClose,onHost,onSplitChange,onSplitPreview,onSwap,onCancelFit}:Props){
 const [previewPercent,setPreviewPercent]=useState<number|null>(null);
 const previewRef=useRef<number|null>(null),drag=useRef<Drag|null>(null),cancelFitRef=useRef(onCancelFit);
 cancelFitRef.current=onCancelFit;
 const isSplit=(layout.mode==="horizontal"||layout.mode==="vertical")&&layout.panes.length===2;
 const currentPercent=previewPercent??splitPercent;
 const geometryKey=`${layout.mode}:${layout.panes.join("|")}`;
 const previousGeometry=useRef(geometryKey);
 useEffect(()=>{
  if(previousGeometry.current!==geometryKey&&drag.current){drag.current=null;previewRef.current=null;setPreviewPercent(null);}
  previousGeometry.current=geometryKey;
 },[geometryKey]);
 useEffect(()=>()=>{drag.current=null;previewRef.current=null;cancelFitRef.current();},[]);

 function setPreview(value:number|null){
  if(previewRef.current===value)return;
  previewRef.current=value;setPreviewPercent(value);onSplitPreview(value??splitPercent);
 }
 function isSwapDisabled(target:number){return typeof swapDisabled==="function"?swapDisabled(target):swapDisabled;}
 function cancelActiveDrag(){
  const current=drag.current;if(!current)return;
  drag.current=null;previewRef.current=null;setPreviewPercent(null);onSplitPreview(splitPercent);
  try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* The pointer may already have been released. */}
 }
 function resetSplit(){cancelActiveDrag();onSplitChange(50);}
 function pointerValue(event:React.PointerEvent<HTMLDivElement>,current:Drag){
  const size=current.axis==="x"?current.width:current.height;
  const offset=current.axis==="x"?event.clientX-current.left:event.clientY-current.top;
  if(!Number.isFinite(size)||size<=0||!Number.isFinite(offset))return null;
  return clampSplitPercent(offset/size*100);
 }
 function cancelPointer(event?:React.PointerEvent<HTMLDivElement>){
  const current=drag.current;if(!current||event&&event.pointerId!==current.pointerId)return;
  cancelActiveDrag();
 }
 function commitPointer(event:React.PointerEvent<HTMLDivElement>){
  const current=drag.current;if(!current||event.pointerId!==current.pointerId)return;
  const value=pointerValue(event,current);if(value!==null)setPreview(value);
  const committed=previewRef.current??splitPercent;
  drag.current=null;previewRef.current=null;setPreviewPercent(null);onSplitChange(committed);
  try{event.currentTarget.releasePointerCapture?.(current.pointerId);}catch{/* Pointer capture can end before pointerup. */}
 }
 function adjustSplit(event:React.KeyboardEvent<HTMLDivElement>){
  let value:number|undefined;
  if(event.key==="Home")value=20;
  else if(event.key==="End")value=80;
  else if(layout.mode==="horizontal"&&event.key==="ArrowLeft")value=splitPercent-5;
  else if(layout.mode==="horizontal"&&event.key==="ArrowRight")value=splitPercent+5;
  else if(layout.mode==="vertical"&&event.key==="ArrowUp")value=splitPercent-5;
  else if(layout.mode==="vertical"&&event.key==="ArrowDown")value=splitPercent+5;
  if(value===undefined)return;
  event.preventDefault();cancelActiveDrag();onSplitChange(clampSplitPercent(value));
 }
 const style={"--split-first":`${currentPercent}fr`,"--split-second":`${100-currentPercent}fr`} as CSSProperties;
 return <div className="terminal-layout-shell">
  <div className="terminal-layout-toolbar" aria-label="Terminal layout">
   {([ ["single","Single"],["horizontal","Side by side"],["vertical","Stacked"],["grid","Four panes"] ] as const).map(([mode,label])=>
    <button key={mode} type="button" aria-pressed={layout.mode===mode} onClick={()=>onMode(mode)}>{label}</button>)}
   {isSplit&&<>
    <button type="button" aria-label="Swap panes" disabled={isSwapDisabled(layout.focused===0?1:0)} onClick={()=>onSwap(layout.focused===0?1:0)}>Swap panes</button>
    <button type="button" aria-label="Reset split to 50 percent" onClick={resetSplit}>Reset split</button>
   </>}
   {layout.mode==="grid"&&layout.panes.length===4&&layout.panes.map((_,index)=>index!==layout.focused&&<button key={`swap-${index}`} type="button" aria-label={`Swap focused pane with pane ${index+1}`} disabled={isSwapDisabled(index)} onClick={()=>onSwap(index)}>Swap with pane {index+1}</button>)}
  </div>
  <div className={`terminal-layout layout-${layout.mode}${isSplit?" split-two":""}`} style={style}>
   {layout.panes.map((id,index)=><section key={index} className={`terminal-pane ${layout.focused===index?"pane-focused":""}`} aria-label={`Terminal pane ${index+1}`} onPointerDown={()=>onFocus(index)} onFocusCapture={()=>onFocus(index)}>
    <div className="terminal-pane-header">
     <button type="button" className="terminal-pane-title" aria-label={`Focus pane ${index+1}${labels[index]?`: ${labels[index]}`:""}`} onClick={()=>onFocus(index,true)}>{labels[index]??`Pane ${index+1}: select a session`}</button>
     {id&&<button type="button" aria-label={`Hide pane ${index+1}`} title="Hide this pane; keep the session running" onClick={event=>{event.stopPropagation();onClose(index);}}>×</button>}
    </div>
    <div className="terminal-pane-host" ref={host=>onHost(index,host)} />
    {!id&&<div className="terminal-pane-empty">Focus this pane, then choose a session from the sidebar.</div>}
   </section>)}
   {isSplit&&<div role="separator" tabIndex={0} aria-label="Resize terminal panes" aria-orientation={layout.mode==="horizontal"?"vertical":"horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={currentPercent} className={`terminal-layout-splitter ${layout.mode==="horizontal"?"splitter-x":"splitter-y"}`} onKeyDown={adjustSplit} onPointerDown={event=>{
    if(event.button!==undefined&&event.button!==0)return;
    const axis=layout.mode==="horizontal"?"x":"y",host=event.currentTarget.parentElement?.getBoundingClientRect(),rect=host??event.currentTarget.getBoundingClientRect();
    const size=axis==="x"?rect.width:rect.height;if(!Number.isFinite(size)||size<=0)return;
    event.preventDefault();drag.current={pointerId:event.pointerId,axis,left:rect.left,top:rect.top,width:rect.width,height:rect.height,target:event.currentTarget};
    previewRef.current=splitPercent;setPreviewPercent(splitPercent);
    try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{/* Continue with pointer events if capture is unavailable. */}
   }} onPointerMove={event=>{const current=drag.current;if(!current||event.pointerId!==current.pointerId)return;const value=pointerValue(event,current);if(value!==null)setPreview(value);}} onPointerUp={commitPointer} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} />}
  </div>
 </div>;
}
