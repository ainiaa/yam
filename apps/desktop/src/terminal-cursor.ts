// Author: Jeff.Liu. Separate public xterm defaults; applications retain cursor-mode precedence.
export type TerminalCursor={shape:"block"|"underline"|"bar";blink:boolean};
export const defaultTerminalCursor:TerminalCursor=Object.freeze({shape:"block",blink:true});
const KEY="yam.terminalCursor.v1",INVALID="Invalid cursor defaults.";
function checked(value:unknown):TerminalCursor{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error(INVALID);
 const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);if((prototype!==Object.prototype&&prototype!==null)||keys.length!==2||!keys.every(key=>key==="shape"||key==="blink"))throw Error(INVALID);
 const shape=Object.getOwnPropertyDescriptor(value,"shape"),blink=Object.getOwnPropertyDescriptor(value,"blink");if(!shape||!blink||!Object.prototype.hasOwnProperty.call(shape,"value")||!Object.prototype.hasOwnProperty.call(blink,"value")||!["block","underline","bar"].includes(shape.value)||typeof blink.value!=="boolean")throw Error(INVALID);
 return {shape:shape.value,blink:blink.value};
}
export function isTerminalCursor(value:unknown):value is TerminalCursor{try{checked(value);return true;}catch{return false;}}
export function decodeTerminalCursor(raw:string|null):TerminalCursor{
 if(raw===null)return {...defaultTerminalCursor};
 try{if(typeof raw!=="string"||new TextEncoder().encode(raw).length>256)throw Error();return checked(JSON.parse(raw));}catch{throw Error(INVALID);}
}
export function loadTerminalCursor(read:()=>string|null):{cursor:TerminalCursor;error:string|null}{try{return {cursor:decodeTerminalCursor(read()),error:null};}catch{return {cursor:{...defaultTerminalCursor},error:"Could not load cursor defaults. Saved data was preserved."};}}
export function saveTerminalCursor(write:(key:string,raw:string)=>void,value:TerminalCursor){
 let next:TerminalCursor;try{next=checked(value);}catch{throw Error(INVALID);}
 try{write(KEY,JSON.stringify(Object.assign(Object.create(null),next)));}catch{throw Error("Could not save cursor defaults.");}
}
export function terminalCursorOptions(value:TerminalCursor){const next=checked(value);return {cursorStyle:next.shape,cursorBlink:next.blink};}
