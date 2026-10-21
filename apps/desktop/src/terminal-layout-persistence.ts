// Author: Jeff.Liu. ID-only layout preference data; no owner or automatic restore behavior.
import type {TerminalLayoutMode,TerminalLayoutState,TerminalLayoutNode} from "./terminal-layout.ts";
import {terminalLayoutRoot,terminalLeaves,terminalPaneId,layoutFromRoot,createTerminalLayout,MAX_TERMINAL_PANES,MAX_TERMINAL_LAYOUT_DEPTH,terminalTabs,terminalMembers} from "./terminal-layout.ts";
import {isTerminalSettings,type TerminalSettings} from "./terminal-settings.ts";
export type TerminalLayoutPreference = {layout:TerminalLayoutState;splitPercent:number;warning:string|null;appearances?:Record<string,TerminalSettings>;recordedOnly?:string[]};
type SnapshotV1 = {version:1;mode:TerminalLayoutMode;panes:(string|null)[];selected:string|null};
type SnapshotV2 = {version:2;mode:TerminalLayoutMode;panes:(string|null)[];selected:string|null;splitPercent:number};
const slotCounts:Record<TerminalLayoutMode,number>={single:1,horizontal:2,vertical:2,grid:4};
// Strict UTF-8 byte budget applies before parsing and after serialization.
const maximumRawLength=4096,maximumAppearanceRawLength=32768;
const invalidWarning="Invalid terminal layout preferences. Using a single pane.";
function fallback(warning:string|null):TerminalLayoutPreference {
 return {layout:createTerminalLayout(),splitPercent:50,warning};
}
function hasKeys(value:unknown,keys:readonly string[]):value is Record<string,unknown> {
 return !!value&&typeof value==="object"&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}
function isMode(value:unknown):value is TerminalLayoutMode {
 return typeof value==="string"&&Object.prototype.hasOwnProperty.call(slotCounts,value);
}
function validPanes(value:unknown,count:number):value is (string|null)[] {
 if(!Array.isArray(value)||value.length!==count)return false;
 if(!Array.from(value).every(id=>id===null||(typeof id==="string"&&id.length<=64&&/^s-[a-f0-9]+-[a-f0-9]+$/.test(id))))return false;
 const ids=value.filter(id=>id!==null);
 return new Set(ids).size===ids.length;
}
function hasValidLayout(value:Record<string,unknown>):value is Record<string,unknown>&{mode:TerminalLayoutMode;panes:(string|null)[];selected:string|null} {
 if(!isMode(value.mode)||!validPanes(value.panes,slotCounts[value.mode]))return false;
 return value.selected===null?value.panes.includes(null):typeof value.selected==="string"&&value.panes.includes(value.selected);
}
function isSnapshotV1(value:unknown):value is SnapshotV1 {
 if(!hasKeys(value,["version","mode","panes","selected"])||value.version!==1||!isMode(value.mode))return false;
 return hasValidLayout(value);
}
function isSnapshotV2(value:unknown):value is SnapshotV2 {
 if(!hasKeys(value,["version","mode","panes","selected","splitPercent"])||value.version!==2||!hasValidLayout(value))return false;
 return typeof value.splitPercent==="number"&&Number.isInteger(value.splitPercent)&&value.splitPercent>=20&&value.splitPercent<=80;
}
function validTree(value:unknown,version=3):value is TerminalLayoutNode {
 const nodes=new Set<string>(),sessions=new Set<string>();let leaves=0,members=0;
 function visit(node:unknown,depth:number):boolean {
  if(depth>MAX_TERMINAL_LAYOUT_DEPTH||!node||typeof node!=="object")return false;
  const record=node as Record<string,unknown>,id=record.kind==="pane"?record.paneId:record.nodeId;
  if(typeof id!=="string"||!/^([pn])-[0-9]{1,4}$/.test(id)||nodes.has(id))return false;nodes.add(id);
  if(record.kind==="pane"){
   if(!id.startsWith("p-")||++leaves>MAX_TERMINAL_PANES)return false;
   if(version===3){
    if(!hasKeys(record,["kind","paneId","sessionId"])||!validPanes([record.sessionId],1))return false;
    if(record.sessionId!==null){if(sessions.has(record.sessionId as string))return false;sessions.add(record.sessionId as string);}return true;
   }
   if(!hasKeys(record,["kind","paneId","tabs","activeIndex"])||!Array.isArray(record.tabs)||!validPanes(record.tabs,record.tabs.length)||record.tabs.includes(null)||members+record.tabs.length>MAX_TERMINAL_PANES)return false;
   members+=record.tabs.length;
   if(record.tabs.length===0?record.activeIndex!==null:!Number.isSafeInteger(record.activeIndex)||(record.activeIndex as number)<0||(record.activeIndex as number)>=record.tabs.length)return false;
   for(const session of record.tabs as string[]){if(sessions.has(session))return false;sessions.add(session);}return true;
  }
  return record.kind==="split"&&hasKeys(record,["kind","nodeId","axis","ratio","first","second"])&&id.startsWith("n-")
   &&(record.axis==="horizontal"||record.axis==="vertical")&&typeof record.ratio==="number"&&Number.isInteger(record.ratio)&&record.ratio>=20&&record.ratio<=80
   &&visit(record.first,depth+1)&&visit(record.second,depth+1);
 }
 return visit(value,1);
}
type SavedPane={kind:"pane";paneId:string;tabs:string[];activeIndex:number|null};
type SavedNode=SavedPane|{kind:"split";nodeId:string;axis:"horizontal"|"vertical";ratio:number;first:SavedNode;second:SavedNode};
function fromSaved(node:SavedNode):TerminalLayoutNode{return node.kind==="pane"?{kind:"pane",paneId:node.paneId,...(node.tabs.length>1?{tabs:[...node.tabs]}:{}),sessionId:node.activeIndex===null?null:node.tabs[node.activeIndex]}:{...node,first:fromSaved(node.first),second:fromSaved(node.second)};}
function toSaved(node:TerminalLayoutNode,depth=1):SavedNode {
 if(depth>MAX_TERMINAL_LAYOUT_DEPTH||!node||typeof node!=="object")throw Error("Invalid terminal layout");
 if(node.kind==="pane"){
  if(!hasKeys(node,node.tabs===undefined?["kind","paneId","sessionId"]:["kind","paneId","sessionId","tabs"])||!Array.isArray(terminalTabs(node)))throw Error("Invalid terminal layout");
  const tabs=terminalTabs(node);if(tabs.length===0?node.sessionId!==null:!tabs.includes(node.sessionId!))throw Error("Invalid terminal layout");
  return {kind:"pane",paneId:node.paneId,tabs:[...tabs],activeIndex:node.sessionId===null?null:tabs.indexOf(node.sessionId)};
 }
 if(node.kind!=="split")throw Error("Invalid terminal layout");
 return {...node,first:toSaved(node.first,depth+1),second:toSaved(node.second,depth+1)};
}

function copyAppearances(value:unknown,members:string[]):Record<string,TerminalSettings> {
 if(!value||typeof value!=="object"||Array.isArray(value)||Reflect.ownKeys(value).length>16)throw Error("Invalid terminal appearances");
 const copied:Record<string,TerminalSettings>={};
 for(const key of Reflect.ownKeys(value)){
  if(typeof key!=="string"||!members.includes(key))throw Error("Invalid terminal appearances");
  const appearance=(value as Record<string,unknown>)[key];if(!isTerminalSettings(appearance))throw Error("Invalid terminal appearances");
  copied[key]={fontFamily:appearance.fontFamily,fontSize:appearance.fontSize,theme:appearance.theme};
 }
 return copied;
}
function copyRecordedOnly(value:unknown,members:string[]):string[] {
 if(!Array.isArray(value)||value.length>16||new Set(value).size!==value.length||!Array.from(value).every(id=>typeof id==="string"&&members.includes(id)))throw Error("Invalid recorded terminal tabs");
 return [...value];
}
export function decodeTerminalLayout(raw:string|null):TerminalLayoutPreference {
 if(raw===null)return fallback(null);
 if(typeof raw!=="string"||new TextEncoder().encode(raw).length>maximumAppearanceRawLength)return fallback(invalidWarning);
 try{
  const value:unknown=JSON.parse(raw);
  if((hasKeys(value,["version","root","focusedPane","appearances"])&&value.version===5)||(hasKeys(value,["version","root","focusedPane","appearances","recordedOnly"])&&value.version===6)){
   const core=JSON.stringify({version:4,root:value.root,focusedPane:value.focusedPane});
   if(new TextEncoder().encode(core).length>maximumRawLength)throw Error();
   const preference=decodeTerminalLayout(core);if(preference.warning)throw Error();
   const members=terminalMembers(preference.layout);
   return {...preference,appearances:copyAppearances(value.appearances,members),...(value.version===6?{recordedOnly:copyRecordedOnly(value.recordedOnly,members)}:{})};
  }
  if(new TextEncoder().encode(raw).length>maximumRawLength)throw Error();
  if(isSnapshotV1(value)||isSnapshotV2(value)){
   const ratio=value.version===1?50:value.splitPercent;
   const legacy={mode:value.mode,panes:[...value.panes],focused:value.panes.indexOf(value.selected),revision:0};
   const root=terminalLayoutRoot(legacy,ratio);
   return {layout:layoutFromRoot(root,terminalPaneId(legacy,legacy.focused),0,value.mode),splitPercent:ratio,warning:null};
  }
  if(hasKeys(value,["version","root","focusedPane"])&&(value.version===3||value.version===4)&&validTree(value.root,value.version)&&typeof value.focusedPane==="string"&&terminalLeaves(value.root).some(leaf=>leaf.paneId===value.focusedPane)){
   const root=value.version===4?fromSaved(value.root as unknown as SavedNode):value.root,leaves=terminalLeaves(root);
   const mode=leaves.length===1?"single":root.kind==="split"&&leaves.length===2?root.axis:root.kind==="split"&&root.axis==="vertical"&&root.first.kind==="split"&&root.second.kind==="split"&&root.first.axis==="horizontal"&&root.second.axis==="horizontal"&&leaves.length===4?"grid":"custom";
   return {layout:layoutFromRoot(root,value.focusedPane,0,mode),splitPercent:root.kind==="split"?root.ratio:50,warning:null};
  }
 }catch{/* Invalid data never reaches App or owner restore paths. */}
 return fallback(invalidWarning);
}
export function encodeTerminalLayout(layout:TerminalLayoutState,splitPercent?:number,appearances?:Record<string,TerminalSettings>,recordedOnly?:string[]):string {
 splitPercent??=layout.root?.kind==="split"?layout.root.ratio:50;
 const keys=layout.root?["mode","panes","focused","revision","root"]:["mode","panes","focused","revision"];
 if(!hasKeys(layout,keys)||(!isMode(layout.mode)&&layout.mode!=="custom")||!Number.isSafeInteger(layout.focused)||layout.focused<0||layout.focused>=layout.panes.length
  ||!Number.isSafeInteger(layout.revision)||layout.revision<0||!Number.isInteger(splitPercent)||splitPercent<20||splitPercent>80)throw Error("Invalid terminal layout");
 if(!Array.isArray(layout.panes)||(!layout.root&&(!isMode(layout.mode)||layout.panes.length!==slotCounts[layout.mode])))throw Error("Invalid terminal layout");
 const root=terminalLayoutRoot(layout,splitPercent);
 if(!validTree(toSaved(root),4)||terminalLeaves(root).some((leaf,index)=>leaf.sessionId!==layout.panes[index])||terminalLeaves(root).length!==layout.panes.length)throw Error("Invalid terminal layout");
 // The legacy two-pane resize control continues to update the root ratio only.
 const savedRoot=root.kind==="split"&&layout.panes.length===2?{...root,ratio:splitPercent}:root;
 const core={version:4,root:toSaved(savedRoot),focusedPane:terminalPaneId(layout,layout.focused)},raw=JSON.stringify(core);
 if(new TextEncoder().encode(raw).length>maximumRawLength)throw Error("Invalid terminal layout");
 if(appearances===undefined&&recordedOnly===undefined)return raw;
 const members=terminalMembers(layout);
 const recorded=recordedOnly===undefined?[]:copyRecordedOnly(recordedOnly,members);
 const full=JSON.stringify({...core,version:recorded.length?6:5,appearances:copyAppearances(appearances===undefined?{}:appearances,members),...(recorded.length?{recordedOnly:recorded}:{})});
 if(new TextEncoder().encode(full).length>maximumAppearanceRawLength)throw Error("Invalid terminal layout");return full;
}
export function loadTerminalLayout(read:()=>string|null):TerminalLayoutPreference {
 try{return decodeTerminalLayout(read());}
 catch{return fallback("Terminal layout preferences unavailable. Using a single pane.");}
}
export function saveTerminalLayout(layout:TerminalLayoutState,write:(value:string)=>void,splitPercent?:number,appearances?:Record<string,TerminalSettings>,recordedOnly?:string[]):string|null {
 try{write(encodeTerminalLayout(layout,splitPercent,appearances,recordedOnly));return null;}
 catch{return "Unable to save terminal layout preferences.";}
}
