// Author: Jeff.Liu. Drop metadata and quoted text only, never file contents.
import {selectedFilePath} from './terminal-file-actions.ts';
import {inspectTerminalPaste,sameTerminalPasteTarget,type TerminalPasteTarget} from './terminal-paste.ts';
export type TerminalFileDropTarget<V=unknown,I=unknown>=TerminalPasteTarget<V,I>&{slot:string;epoch:number;generation:number};
function data(value:unknown,key:string):unknown {if(!value||typeof value!=="object")return undefined;const field=Object.getOwnPropertyDescriptor(value,key);return field&&"value" in field?field.value:undefined;}
export function inspectTerminalFileDrop(payload:unknown,dpr:number,rect:{left:number;top:number;right:number;bottom:number;width:number;height:number}):string|null {
 if(data(payload,"type")!=="drop")return null;
 const paths=data(payload,"paths"),position=data(payload,"position"),x=data(position,"x"),y=data(position,"y");
 if(!Array.isArray(paths)||paths.length!==1||typeof data(paths,"0")!=="string")throw Error("Drop exactly one local file.");
 const path=selectedFilePath(data(paths,"0") as string);
 if(typeof x!=="number"||typeof y!=="number"||!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(dpr)||dpr<=0||![rect.left,rect.top,rect.right,rect.bottom,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0||rect.right<=rect.left||rect.bottom<=rect.top)throw Error("File drop position is unavailable.");
 const left=x/dpr,top=y/dpr;return left>=rect.left&&left<rect.right&&top>=rect.top&&top<rect.bottom?path:null;
}
export function fileDropText(path:string):string {return inspectTerminalPaste("'"+selectedFilePath(path).replace(/'/g,"'\\''")+"'").text;}
export function sameTerminalFileDropTarget(a:TerminalFileDropTarget,b:TerminalFileDropTarget):boolean{return a.slot===b.slot&&a.epoch===b.epoch&&a.generation===b.generation&&sameTerminalPasteTarget(a,b);}
