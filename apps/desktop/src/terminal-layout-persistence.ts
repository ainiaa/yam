// Author: Jeff.Liu. ID-only layout preference data; no owner or automatic restore behavior.
import type {TerminalLayoutMode,TerminalLayoutState} from "./terminal-layout";
export type TerminalLayoutPreference = {layout:TerminalLayoutState;splitPercent:number;warning:string|null};
type SnapshotV1 = {version:1;mode:TerminalLayoutMode;panes:(string|null)[];selected:string|null};
type SnapshotV2 = {version:2;mode:TerminalLayoutMode;panes:(string|null)[];selected:string|null;splitPercent:number};
const slotCounts:Record<TerminalLayoutMode,number>={single:1,horizontal:2,vertical:2,grid:4};
// The bound is JavaScript string code units, checked before JSON parsing.
// Valid serialized snapshots use ASCII IDs and are much smaller than 4096 units.
const maximumRawLength=4096;
const invalidWarning="Invalid terminal layout preferences. Using a single pane.";
function fallback(warning:string|null):TerminalLayoutPreference {
 return {layout:{mode:"single",panes:[null],focused:0,revision:0},splitPercent:50,warning};
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
export function decodeTerminalLayout(raw:string|null):TerminalLayoutPreference {
 if(raw===null)return fallback(null);
 if(typeof raw!=="string"||raw.length>maximumRawLength)return fallback(invalidWarning);
 try{
  const value:unknown=JSON.parse(raw);
  if(isSnapshotV1(value)||isSnapshotV2(value))return {
   layout:{mode:value.mode,panes:[...value.panes],focused:value.panes.indexOf(value.selected),revision:0},
   splitPercent:value.version===1?50:value.splitPercent,
   warning:null,
  };
 }catch{/* Invalid data never reaches App or owner restore paths. */}
 return fallback(invalidWarning);
}
export function encodeTerminalLayout(layout:TerminalLayoutState,splitPercent=50):string {
 if(!hasKeys(layout,["mode","panes","focused","revision"])||!isMode(layout.mode)
  ||!validPanes(layout.panes,slotCounts[layout.mode])||!Number.isSafeInteger(layout.focused)
  ||typeof layout.focused!=="number"||layout.focused<0||layout.focused>=layout.panes.length
  ||typeof layout.revision!=="number"||!Number.isSafeInteger(layout.revision)||layout.revision<0
  ||!Number.isInteger(splitPercent)||splitPercent<20||splitPercent>80)throw Error("Invalid terminal layout");
 const snapshot:SnapshotV2={version:2,mode:layout.mode,panes:[...layout.panes],selected:layout.panes[layout.focused],splitPercent};
 return JSON.stringify(snapshot);
}
export function loadTerminalLayout(read:()=>string|null):TerminalLayoutPreference {
 try{return decodeTerminalLayout(read());}
 catch{return fallback("Terminal layout preferences unavailable. Using a single pane.");}
}
export function saveTerminalLayout(layout:TerminalLayoutState,write:(value:string)=>void,splitPercent=50):string|null {
 try{write(encodeTerminalLayout(layout,splitPercent));return null;}
 catch{return "Unable to save terminal layout preferences.";}
}
