import {t} from "./i18n";
// Author: Jeff.Liu. Stable pane hosts and node-local accessible split controls.
import {useEffect,useRef,useState} from "react";
import type {CSSProperties} from "react";
import type {TerminalLayoutMode,TerminalLayoutState,TerminalLayoutNode,TerminalSplit,TerminalPaneDirection,TerminalPaneEdge} from "./terminal-layout";
import {terminalLayoutRoot,terminalLeaves,terminalTabs,terminalNodeMinimum,terminalResizeBounds,terminalPaneDropEdge} from "./terminal-layout";

type Props={onRenameTab?:(id:string,title:string)=>Promise<void>;onDuplicateTab?:(id:string)=>void;canReopen?:boolean;onReopen?:()=>void;ownerVersion?:number;onTabDragStart?:(id:string,paneId:string)=>object|null;onTabDragCancel?:(token:object)=>void;onTabDrop?:(token:object,paneId:string,before:string|null,edge?:TerminalPaneEdge)=>void;onReorderTab?:(id:string,direction:"left"|"right")=>void;zoomedPaneId?:string|null;zoomRevision?:number;onDirection?:(direction:TerminalPaneDirection)=>void;onZoom?:()=>void;layout:TerminalLayoutState;labels:(string|null)[];splitPercent:number;swapDisabled:boolean|((target:number)=>boolean);tabLabel?:(id:string)=>string;onTab?:(pane:number,id:string)=>void;onHideTab?:(pane:number,id:string)=>void;onMoveTab?:(id:string,target:number)=>void;onMode:(mode:TerminalLayoutMode)=>void;onFocus:(pane:number,focusInput?:boolean)=>void;onClose:(pane:number)=>void;onHost:(pane:string,host:HTMLDivElement|null)=>void;onSplit?:(axis:"horizontal"|"vertical")=>void;onSplitChange:(percent:number)=>void;onSplitPreview:(percent:number)=>void;onSwap:(target?:number)=>void;onCancelFit:()=>void;onNodeSplitChange?:(nodeId:string,percent:number)=>void};
type TabDrag={pointerId:number;id:string;paneId:string;key:string;token:object;x:number;y:number;started:boolean;target:HTMLButtonElement};
type TabDrop={paneId:string;before:string|null;edge?:TerminalPaneEdge};
type Drag={pointerId:number;nodeId:string;node:TerminalSplit;token:string;start:number;axis:"x"|"y";left:number;top:number;size:number;separator:number;target:HTMLDivElement};

export function TerminalLayout({onRenameTab,onDuplicateTab,canReopen=false,onReopen,ownerVersion=0,onTabDragStart,onTabDragCancel,onTabDrop,onReorderTab,zoomedPaneId=null,zoomRevision=0,onDirection,onZoom,layout,labels,tabLabel,onTab,onHideTab,onMoveTab,splitPercent,swapDisabled,onMode,onFocus,onClose,onHost,onSplit,onSplitChange,onSplitPreview,onSwap,onCancelFit,onNodeSplitChange}:Props){
 const [editing,setEditing]=useState<{id:string;title:string}|null>(null),[nameError,setNameError]=useState<string|null>(null);
 const nameBusy=useRef(false),nameComposing=useRef(false);
 function editTabName(id:string){nameComposing.current=false;setNameError(null);setEditing({id,title:tabLabel?.(id)??id});}
 async function saveTabName(){
  if(!editing||!onRenameTab||nameBusy.current)return;nameBusy.current=true;
  try{await onRenameTab(editing.id,editing.title);setEditing(null);setNameError(null);}
  catch{setNameError("Could not save the session name. Use 1–200 characters and try again.");}
  finally{nameBusy.current=false;}
 }
 function openTabMenu(target:HTMLElement,x:number,y:number){const menu=target.closest(".terminal-pane-tab")?.querySelector<HTMLDetailsElement>("details.tab-context-menu"),body=menu?.querySelector<HTMLElement>('[role="menu"]');if(!menu||!body)return;menu.open=true;body.style.left=Math.max(8,Math.min(x,window.innerWidth-body.offsetWidth-8))+"px";body.style.top=Math.max(8,Math.min(y,window.innerHeight-body.offsetHeight-8))+"px";body.querySelector<HTMLButtonElement>("button")?.focus();}
 // React calls changed callback refs with null and then the same host on every commit.
 // Keep pane refs stable so Find state updates cannot schedule another terminal fit.
 const onHostRef=useRef(onHost),hostRefs=useRef(new Map<string,(host:HTMLDivElement|null)=>void>());
 onHostRef.current=onHost;
 function paneHostRef(paneId:string){let ref=hostRefs.current.get(paneId);if(!ref){ref=host=>onHostRef.current(paneId,host);hostRefs.current.set(paneId,ref);}return ref;}
 const [preview,setPreviewState]=useState<{nodeId:string;ratio:number}|null>(null);
 const previewRef=useRef<{nodeId:string;ratio:number}|null>(null),drag=useRef<Drag|null>(null);
 const cancelFitRef=useRef(onCancelFit),previewCallbackRef=useRef(onSplitPreview);
 cancelFitRef.current=onCancelFit;previewCallbackRef.current=onSplitPreview;
 const [,setGeometryVersion]=useState(0);
 const nodeHosts=useRef(new Map<string,HTMLDivElement>());
 const root=terminalLayoutRoot(layout,splitPercent),leaves=terminalLeaves(root);
 const isSplit=(layout.mode==="horizontal"||layout.mode==="vertical")&&layout.panes.length===2;
 function structure(node:TerminalLayoutNode):string{return node.kind==="pane"?`${node.paneId}:${terminalTabs(node).join(",")}:${node.sessionId}`:`${node.nodeId}:${node.axis}:${node.ratio}(${structure(node.first)})(${structure(node.second)})`;}
 const geometryKey=`${zoomRevision}:${zoomedPaneId??""}:${structure(root)}`,geometryRef=useRef(geometryKey);geometryRef.current=geometryKey;
 const previousGeometry=useRef(geometryKey);
 const escapeCleanup=useRef<(()=>void)|null>(null);
 function removeDragEscape(){escapeCleanup.current?.();escapeCleanup.current=null;}
 function captureDragEscape(target:HTMLDivElement){
  const owner=target.ownerDocument??(typeof document!=="undefined"?document:null);if(!owner)return;
  const listener=(event:KeyboardEvent)=>{
   if(event.key!=="Escape"||!drag.current)return;
   event.preventDefault();event.stopPropagation();cancelActiveDrag();
  };
  owner.addEventListener("keydown",listener,true);
  escapeCleanup.current=()=>owner.removeEventListener("keydown",listener,true);
 }
 function cancelActiveDrag(){
  const current=drag.current;if(!current||geometryKey!==geometryRef.current)return;
  removeDragEscape();drag.current=null;previewRef.current=null;setPreviewState(null);onCancelFit?.();onSplitPreview(current.start);
  try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* Capture can already have ended. */}
 }
 useEffect(()=>{
  const current=drag.current;
  function find(node:TerminalLayoutNode):TerminalSplit|null{return node.kind==="pane"?null:node.nodeId===current?.nodeId?node:find(node.first)??find(node.second);}
  const target=current?find(root):null;
  if(current&&(previousGeometry.current!==geometryKey||!target||target.ratio!==current.start))cancelActiveDrag();
  previousGeometry.current=geometryKey;
 },[geometryKey,layout.revision,splitPercent]);
 useEffect(()=>{
  if(!nodeHosts.current.size)return;
  setGeometryVersion(version=>version+1);
  if(typeof ResizeObserver==="undefined")return;
  const observer=new ResizeObserver(()=>setGeometryVersion(version=>version+1));
  nodeHosts.current.forEach(host=>observer.observe(host));return ()=>observer.disconnect();
 },[geometryKey]);
 useEffect(()=>()=>{
  const current=drag.current;removeDragEscape();drag.current=null;previewRef.current=null;cancelFitRef.current?.();
  if(current){previewCallbackRef.current(current.start);try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* Detached capture. */}}
 },[]);
 const tabSurface=useRef<HTMLDivElement|null>(null),tabDrag=useRef<TabDrag|null>(null),tabEscape=useRef<(()=>void)|null>(null);
 const tabNames=leaves.flatMap(leaf=>terminalTabs(leaf).map(tab=>tabLabel?.(tab)??tab)).join("\0");
 useEffect(()=>{
  const strips=Array.from(tabSurface.current?.querySelectorAll<HTMLElement>('.terminal-pane-tabs')??[]);
  const reveal=()=>{for(const strip of strips){const tab=strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.parentElement;if(!tab)continue;
   const bounds=strip.getBoundingClientRect(),rect=tab.getBoundingClientRect();if(!bounds.width||!rect.width)continue;
   const delta=rect.left<bounds.left||rect.width>bounds.width?rect.left-bounds.left:Math.max(0,rect.right-bounds.right);if(delta)strip.scrollLeft+=delta;
  }};
  reveal();if(typeof ResizeObserver==="undefined")return;
  const observer=new ResizeObserver(reveal);strips.forEach(strip=>observer.observe(strip));return()=>observer.disconnect();
 },[geometryKey,tabNames]);
 const suppressTabClick=useRef<string|null>(null);
 const [tabDrop,setTabDrop]=useState<TabDrop|null>(null);
 const tabGestureKey=`${layout.revision}:${ownerVersion}:${zoomRevision}:${zoomedPaneId??""}:${geometryKey}`;
 const tabGestureKeyRef=useRef(tabGestureKey);tabGestureKeyRef.current=tabGestureKey;
 const cancelTabRef=useRef(onTabDragCancel);cancelTabRef.current=onTabDragCancel;
 function finishTabGesture(cancel=true,suppress=true){
  const current=tabDrag.current;if(!current)return;
  tabDrag.current=null;tabEscape.current?.();tabEscape.current=null;setTabDrop(null);
  if(suppress)suppressTabClick.current=current.id;
  if(cancel)cancelTabRef.current?.(current.token);
  try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* Capture may already have ended. */}
 }
 useEffect(()=>{if(tabDrag.current&&tabDrag.current.key!==tabGestureKey)finishTabGesture();},[tabGestureKey]);
 useEffect(()=>()=>{
  const current=tabDrag.current;tabDrag.current=null;tabEscape.current?.();tabEscape.current=null;
  if(current){cancelTabRef.current?.(current.token);try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* Detached tab. */}}
 },[]);
 function tabTarget(event:React.PointerEvent<HTMLButtonElement>):TabDrop|null {
  if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return null;
  const hit=event.currentTarget.ownerDocument.elementFromPoint(event.clientX,event.clientY);
  if(!hit||!tabSurface.current?.contains(hit)||hit.closest("[data-tab-drop-block]")||hit.closest("[hidden], [inert]"))return null;
  const pane=hit.closest<HTMLElement>("[data-pane-id]"),paneId=pane?.dataset.paneId;
  const leaf=leaves.find(item=>item.paneId===paneId);
  if(!leaf||(zoomedPaneId&&zoomedPaneId!==paneId))return null;
  const tab=hit.closest<HTMLElement>("[data-tab-session-id]"),before=tab?.dataset.tabSessionId??null;
  if(before!==null&&!terminalTabs(leaf).includes(before))return null;
  const body=hit.closest<HTMLElement>("[data-tab-drop-body]");
  if(body){
   const rect=body.getBoundingClientRect();
   if(![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0||event.clientX<rect.left||event.clientY<rect.top||event.clientX>rect.left+rect.width||event.clientY>rect.top+rect.height)return null;
   const edge=terminalPaneDropEdge(rect,event.clientX,event.clientY);
   if(edge)return {paneId:leaf.paneId,before:null,edge};
  }
  return {paneId:leaf.paneId,before};
 }
 function startTabGesture(event:React.PointerEvent<HTMLButtonElement>,id:string,paneId:string){
  event.stopPropagation();
  if(tabGestureKey!==tabGestureKeyRef.current||tabDrag.current||drag.current||!event.isPrimary||event.button!==0||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
  suppressTabClick.current=null;event.preventDefault();
  const token=onTabDragStart?.(id,paneId);if(!token)return;
  tabDrag.current={pointerId:event.pointerId,id,paneId,key:tabGestureKey,token,x:event.clientX,y:event.clientY,started:false,target:event.currentTarget};
  const owner=event.currentTarget.ownerDocument;
  const escape=(key:KeyboardEvent)=>{if(key.key!=="Escape"||!tabDrag.current)return;key.preventDefault();key.stopPropagation();finishTabGesture();};
  owner.addEventListener("keydown",escape,true);tabEscape.current=()=>owner.removeEventListener("keydown",escape,true);
  try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{finishTabGesture();}
 }
 function moveTabGesture(event:React.PointerEvent<HTMLButtonElement>,id:string){
  if(tabGestureKey!==tabGestureKeyRef.current)return;
  const current=tabDrag.current;if(!current||current.id!==id||current.pointerId!==event.pointerId)return;
  if(current.key!==tabGestureKeyRef.current||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)||(event.buttons!==undefined&&(event.buttons&1)===0)){finishTabGesture();return;}
  if(!current.started&&Math.hypot(event.clientX-current.x,event.clientY-current.y)<6)return;
  current.started=true;event.preventDefault();event.stopPropagation();setTabDrop(tabTarget(event));
 }
 function endTabGesture(event:React.PointerEvent<HTMLButtonElement>,id:string){
  if(tabGestureKey!==tabGestureKeyRef.current)return;
  const current=tabDrag.current;if(!current||current.id!==id||current.pointerId!==event.pointerId)return;
  if(current.key!==tabGestureKeyRef.current){finishTabGesture();return;}
  if(!current.started){finishTabGesture(true,false);return;}
  event.preventDefault();event.stopPropagation();const target=tabTarget(event);
  finishTabGesture(!target,true);if(target){if(target.edge)onTabDrop?.(current.token,target.paneId,target.before,target.edge);else onTabDrop?.(current.token,target.paneId,target.before);}
 }
 function cancelTabPointer(event:React.PointerEvent<HTMLButtonElement>,id:string){
  if(tabGestureKey!==tabGestureKeyRef.current)return;
  if(tabDrag.current?.id===id&&tabDrag.current.pointerId===event.pointerId)finishTabGesture();
 }
 function ratio(node:TerminalSplit){return preview?.nodeId===node.nodeId?preview.ratio:(!layout.root&&isSplit?splitPercent:node.ratio);}
 function bounds(node:TerminalSplit,target?:HTMLDivElement){
  const host=nodeHosts.current.get(node.nodeId)??target?.parentElement;
  if(!host)return {lower:20,upper:80,disabled:false};
  const rect=host.getBoundingClientRect(),bar=target?.getBoundingClientRect(),size=node.axis==="horizontal"?rect.width:rect.height;
  const separator=bar?(node.axis==="horizontal"?bar.width:bar.height):6;
  return terminalResizeBounds(node,size,separator>0&&separator<size?separator:6);
 }
 function commit(node:TerminalSplit,value:number){
  if(onNodeSplitChange)onNodeSplitChange(node.nodeId,value);else if(root.kind==="split"&&root.nodeId===node.nodeId)onSplitChange(value);
 }
 function resetNode(node:TerminalSplit,target?:HTMLDivElement){cancelActiveDrag();const limit=bounds(node,target);if(!limit.disabled)commit(node,Math.max(limit.lower,Math.min(limit.upper,50)));}
 function isSwapDisabled(target:number){return typeof swapDisabled==="function"?swapDisabled(target):swapDisabled;}
 function pointerValue(event:React.PointerEvent<HTMLDivElement>,current:Drag){
  if(current.token!==geometryRef.current)return null;
  const offset=(current.axis==="x"?event.clientX-current.left:event.clientY-current.top)-current.separator/2;
  const limit=terminalResizeBounds(current.node,current.size+current.separator,current.separator);
  if(!Number.isFinite(offset)||current.size<=0||limit.disabled)return null;
  return Math.max(limit.lower,Math.min(limit.upper,Math.round(offset/current.size*100)));
 }
 function setPreview(node:TerminalSplit,value:number){
  if(previewRef.current?.nodeId===node.nodeId&&previewRef.current.ratio===value)return;
  previewRef.current={nodeId:node.nodeId,ratio:value};setPreviewState(previewRef.current);onSplitPreview(value);
 }
 function separator(node:TerminalSplit){const value=ratio(node),limit=bounds(node);return <div key={`separator-${node.nodeId}`} data-node-id={node.nodeId} role="separator" hidden={!!zoomedPaneId} tabIndex={0} aria-label={t("Resize terminal split {{value0}}", {value0:node.nodeId})} aria-orientation={node.axis==="horizontal"?"vertical":"horizontal"} aria-valuemin={limit.disabled?value:limit.lower} aria-valuemax={limit.disabled?value:limit.upper} aria-valuenow={value} aria-disabled={limit.disabled} className={`terminal-layout-splitter ${node.axis==="horizontal"?"splitter-x":"splitter-y"}`}
  onDoubleClick={event=>resetNode(node,event.currentTarget)} onKeyDown={event=>{
   if(event.key==="Escape"){if(drag.current){event.preventDefault();event.stopPropagation?.();cancelActiveDrag();}return;}
   let next:number|undefined;
   const currentBounds=bounds(node,event.currentTarget);
   if(event.key==="Home")next=currentBounds.lower;else if(event.key==="End")next=currentBounds.upper;
   else if(event.key===(node.axis==="horizontal"?"ArrowLeft":"ArrowUp"))next=value-5;
   else if(event.key===(node.axis==="horizontal"?"ArrowRight":"ArrowDown"))next=value+5;
   if(next===undefined)return;event.preventDefault();cancelActiveDrag();if(!currentBounds.disabled)commit(node,Math.max(currentBounds.lower,Math.min(currentBounds.upper,next)));
  }} onPointerDown={event=>{
   if(geometryKey!==geometryRef.current||drag.current||(event.button!==undefined&&event.button!==0))return;
   const host=nodeHosts.current.get(node.nodeId)??event.currentTarget.parentElement,rect=host?.getBoundingClientRect()??event.currentTarget.getBoundingClientRect();
   const bar=event.currentTarget.getBoundingClientRect(),axis=node.axis==="horizontal"?"x":"y",size=axis==="x"?rect.width:rect.height;
   const raw=axis==="x"?bar.width:bar.height,separatorSize=raw>0&&raw<size?raw:6;
   if(terminalResizeBounds(node,size,separatorSize).disabled)return;
   cancelActiveDrag();event.preventDefault();drag.current={pointerId:event.pointerId,nodeId:node.nodeId,node,token:geometryKey,start:value,axis,left:rect.left,top:rect.top,size:size-separatorSize,separator:separatorSize,target:event.currentTarget};
   captureDragEscape(event.currentTarget);
   try{event.currentTarget.setPointerCapture?.(event.pointerId);}catch{/* Continue with normal pointer events. */}
  }} onPointerMove={event=>{if(geometryKey!==geometryRef.current)return;const current=drag.current;if(!current||current.nodeId!==node.nodeId||event.pointerId!==current.pointerId)return;if(current.token!==geometryRef.current){cancelActiveDrag();return;}const next=pointerValue(event,current);if(next!==null)setPreview(node,next);}}
  onPointerUp={event=>{if(geometryKey!==geometryRef.current)return;const current=drag.current;if(!current||current.nodeId!==node.nodeId||event.pointerId!==current.pointerId)return;if(current.token!==geometryRef.current){cancelActiveDrag();return;}const next=pointerValue(event,current)??previewRef.current?.ratio??current.start;removeDragEscape();drag.current=null;previewRef.current=null;setPreviewState(null);commit(node,next);try{current.target.releasePointerCapture?.(current.pointerId);}catch{/* Capture may end before up. */}}}
  onPointerCancel={event=>{if(drag.current?.nodeId===node.nodeId&&drag.current.pointerId===event.pointerId)cancelActiveDrag();}} onLostPointerCapture={event=>{if(drag.current?.nodeId===node.nodeId&&drag.current.pointerId===event.pointerId)cancelActiveDrag();}} />;}
 function nearestSplit(node:TerminalLayoutNode,paneId:string):TerminalSplit|null {
  if(node.kind==="pane")return null;
  const child=terminalLeaves(node.first).some(leaf=>leaf.paneId===paneId)?node.first:node.second;
  return nearestSplit(child,paneId)??node;
 }
 const resetTarget=root.kind==="split"?nearestSplit(root,leaves[layout.focused]?.paneId??""):null;
 const style={"--split-first":`${root.kind==="split"?ratio(root):50}fr`,"--split-second":`${root.kind==="split"?100-ratio(root):50}fr`} as CSSProperties;
  function renderPane(index:number){const id=layout.panes[index],paneId=leaves[index].paneId,tabs=terminalTabs(leaves[index]),activePosition=id?tabs.indexOf(id):-1;return <section key={paneId} hidden={!!zoomedPaneId&&zoomedPaneId!==paneId} data-pane-id={paneId} className={`terminal-pane ${layout.focused===index?"pane-focused":""}${tabDrop?.paneId===paneId&&tabDrop.before===null&&!tabDrop.edge?" tab-drop-append":""}`} data-tab-drop-edge={tabDrop?.paneId===paneId?tabDrop.edge:undefined} aria-label={t("Terminal pane {{value0}}", {value0:index+1})} onPointerDown={()=>onFocus(index)} onFocusCapture={()=>onFocus(index)}>
    <div className="terminal-pane-header">
     <div className="terminal-pane-tabs" role="tablist" aria-label={t("Pane {{value0}} sessions", {value0:index+1})}>
      {tabs.map(tab=><div className={`terminal-pane-tab${tabDrop?.paneId===paneId&&tabDrop.before===tab?" tab-drop-before":""}`} key={tab}>
       {editing?.id===tab?<div className="tab-name-editor"><input autoFocus aria-label={t("Session name")} value={editing.title} maxLength={200} onChange={event=>setEditing({...editing,title:event.target.value})} onPointerDown={event=>event.stopPropagation()} onCompositionStart={()=>{nameComposing.current=true;}} onCompositionEnd={()=>{nameComposing.current=false;}} onKeyDown={async event=>{event.stopPropagation();if(event.nativeEvent?.isComposing||event.keyCode===229||nameComposing.current)return;if(event.key==="Enter"){event.preventDefault();await saveTabName();}else if(event.key==="Escape"&&!nameBusy.current){event.preventDefault();setEditing(null);setNameError(null);}}}/></div>:<button type="button" role="tab" data-tab-session-id={tab} aria-selected={id===tab} className="terminal-pane-title"
        onDoubleClick={event=>{event.preventDefault();event.stopPropagation();if(onRenameTab)editTabName(tab);}} onContextMenu={event=>{event.preventDefault();openTabMenu(event.currentTarget,event.clientX,event.clientY);}} onKeyDown={event=>{if(event.key==="ContextMenu"||event.shiftKey&&event.key==="F10"){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();openTabMenu(event.currentTarget,rect.left,rect.bottom);}}}
        onPointerDown={event=>startTabGesture(event,tab,paneId)} onPointerMove={event=>moveTabGesture(event,tab)} onPointerUp={event=>endTabGesture(event,tab)} onPointerCancel={event=>cancelTabPointer(event,tab)} onLostPointerCapture={event=>cancelTabPointer(event,tab)}
        onClick={event=>{event?.stopPropagation();if(event?.detail!==0&&suppressTabClick.current===tab){suppressTabClick.current=null;event.preventDefault();return;}onTab?onTab(index,tab):onFocus(index,true);}}>{tabLabel?.(tab)??(id===tab?labels[index]:tab)??tab}</button>}
       {(onRenameTab||onDuplicateTab)&&<details className="toolbar-more tab-context-menu" onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;const target=event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[role="tab"]')??event.currentTarget.querySelector("summary");target?.focus();}}}><summary className="sr-only" tabIndex={-1}>{t("Session actions")}</summary><div className="toolbar-more-actions" role="menu" aria-label={t("Session actions")}>
        <button type="button" role="menuitem" onClick={()=>onDuplicateTab?.(tab)}>{t("Duplicate session…")}</button><button type="button" role="menuitem" onClick={()=>editTabName(tab)}>{t("Rename session")}</button>
       </div></details>}
       <button type="button" data-tab-drop-block aria-label={t("Hide tab {{value0}}", {value0:tabLabel?.(tab)??tab})} title={t("Hide this tab; keep the session running")} onClick={event=>{event.stopPropagation();onHideTab?onHideTab(index,tab):onClose(index);}}>×</button>
      </div>)}
     </div>
     {!id&&<button type="button" className="terminal-pane-title" aria-label={t("Focus pane {{value0}}", {value0:index+1})} onClick={()=>onFocus(index,true)}>{t("Pane {{value0}}: select a session", {value0:index+1})}</button>}
     {id&&<details className="toolbar-more pane-more" data-tab-drop-block onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}><summary aria-label={t("Pane {{value0}} actions", {value0:index+1})} title={t("Pane actions")}>⋯</summary><div className="toolbar-more-actions">{onDuplicateTab&&<button type="button" onClick={()=>onDuplicateTab(id)}>{t("Duplicate session…")}</button>}{onRenameTab&&<button type="button" onClick={()=>editTabName(id)}>{t("Rename session")}</button>}<button type="button" disabled={activePosition<=0} onClick={()=>onReorderTab?.(id,"left")}>{t("Move tab left")}</button>
      <button type="button" disabled={activePosition<0||activePosition>=tabs.length-1} onClick={()=>onReorderTab?.(id,"right")}>{t("Move tab right")}</button>
      {layout.panes.map((_,target)=>target!==index&&<button type="button" key={leaves[target].paneId} onClick={()=>onMoveTab?.(id,target)}>{t("Move to pane")+" "}{target+1}</button>)}</div></details>}
    </div>
    <div data-tab-drop-body className="terminal-pane-host" ref={paneHostRef(paneId)} />
    {!id&&<div data-tab-drop-body className="terminal-pane-empty">{t("Focus this pane, then choose a session from the sidebar.")}</div>}
   </section>;}

 function renderNode(node:TerminalLayoutNode):React.ReactNode {
  if(node.kind==="pane")return renderPane(leaves.findIndex(leaf=>leaf.paneId===node.paneId));
  const value=ratio(node),minimum=terminalNodeMinimum({...node,ratio:value});
  return <div key={node.nodeId} ref={host=>{if(host)nodeHosts.current.set(node.nodeId,host);else nodeHosts.current.delete(node.nodeId);}} className={`terminal-layout-node node-${node.axis}`} style={{minWidth:minimum.width,minHeight:minimum.height,gridTemplateColumns:node.axis==="horizontal"?`${value}fr 6px ${100-value}fr`:undefined,gridTemplateRows:node.axis==="vertical"?`${value}fr 6px ${100-value}fr`:undefined}}>{renderNode(node.first)}{separator(node)}{renderNode(node.second)}</div>;
 }
 return <div className="terminal-layout-shell" ref={tabSurface}>
  <div className="terminal-layout-toolbar" aria-label={t("Terminal layout")}>
   <details className="toolbar-more layout-more" onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}><summary aria-label={t("Terminal layout")} title={t("Layout and split controls")}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor"/><path d="M12 4v16" stroke="currentColor"/></svg></summary><div className="toolbar-more-actions">
   <strong>{t("Pane actions")}</strong>
   <button type="button" aria-label={t("Reopen last hidden tab")} disabled={!canReopen} onClick={()=>{if(canReopen)onReopen?.();}}>{t("Reopen last hidden tab")}</button>
   {(["left","right","up","down"] as const).map(direction=><button key={direction} type="button" aria-label={t("Focus pane {{value0}}", {value0:t(direction)})} title={t("Focus pane {{value0}} (macOS: Cmd+Option+Arrow; Windows/Linux: Ctrl+Alt+Shift+Arrow)", {value0:t(direction)})} onClick={()=>onDirection?.(direction)}>{t("Focus {{value0}}", {value0:t(direction)})}</button>)}
   <button type="button" aria-label={zoomedPaneId?t("Restore terminal panes"):t("Maximize terminal pane")} aria-pressed={!!zoomedPaneId} title={t("Maximize / restore pane (Cmd/Ctrl+Shift+Enter)")} onClick={()=>onZoom?.()}>{zoomedPaneId?t("Restore panes"):t("Maximize pane")}</button>
   <button type="button" title={t("Split right (macOS: Cmd+D; Windows/Linux: Ctrl+Shift+D)")} onClick={()=>onSplit?.("horizontal")} disabled={layout.panes.length>=16}>{t("Split right")}</button>
   <button type="button" title={t("Split down (macOS: Cmd+Shift+D; Windows/Linux: Ctrl+Shift+E)")} onClick={()=>onSplit?.("vertical")} disabled={layout.panes.length>=16}>{t("Split down")}</button>
   <strong>{t("Arrangement")}</strong>
   {([ ["single","Single"],["horizontal","Side by side"],["vertical","Stacked"],["grid","Four panes"] ] as const).map(([mode,label])=>
    <button key={mode} type="button" aria-pressed={layout.mode===mode} onClick={()=>onMode(mode)}>{t(label)}</button>)}
   {isSplit&&<>
    <button type="button" aria-label={t("Swap panes")} disabled={isSwapDisabled(layout.focused===0?1:0)} onClick={()=>onSwap(layout.focused===0?1:0)}>{t("Swap panes")}</button>

   </>}
   {layout.mode==="grid"&&layout.panes.length===4&&layout.panes.map((_,index)=>index!==layout.focused&&<button key={`swap-${index}`} type="button" aria-label={t("Swap focused pane with pane {{value0}}", {value0:index+1})} disabled={isSwapDisabled(index)} onClick={()=>onSwap(index)}>{t("Swap with pane")+" "}{index+1}</button>)}
   {resetTarget&&<button type="button" aria-label={t("Reset split to 50 percent")} title={t("Reset split {{value0}} nearest the focused pane", {value0:resetTarget.nodeId})} onClick={()=>resetNode(resetTarget)}>{t("Reset split")}</button>}
   </div></details>
  </div>
  {nameError&&<div className="terminal-notice tab-name-error" role="alert">{t(nameError)}</div>}
  <div className={`terminal-layout${zoomedPaneId?" layout-zoomed":""} layout-${layout.mode}${root.kind==="split"?" layout-tree":""}`} style={style}>
   {root.kind==="split"?renderNode(root):renderPane(0)}
  </div>
 </div>;
}
