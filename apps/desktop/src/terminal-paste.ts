// Author: Jeff.Liu. Clipboard text stays in one bounded in-memory preview.
export type TerminalPasteMode="risky"|"always"|"never";
export const TERMINAL_PASTE_STORAGE_KEY="yam.terminal-paste.v1";
const invalidPolicy="Paste settings are unavailable or invalid. Every paste will be previewed until valid settings are saved.";
export function loadTerminalPaste(read:()=>string|null):{mode:TerminalPasteMode;error:string|null}{
 try{const raw=read();if(raw===null)return{mode:"risky",error:null};if(typeof raw!=="string"||raw.length>128)throw Error();const value=JSON.parse(raw);if(!value||Array.isArray(value)||Object.keys(value).length!==2||!Object.keys(value).every(key=>key==="version"||key==="mode")||value.version!==1||!["risky","always","never"].includes(value.mode))throw Error();return{mode:value.mode,error:null};}catch{return{mode:"always",error:invalidPolicy};}
}
export function saveTerminalPaste(write:(key:string,raw:string)=>void,mode:TerminalPasteMode):void{
 if(!["risky","always","never"].includes(mode))throw Error("Invalid paste policy.");try{write(TERMINAL_PASTE_STORAGE_KEY,JSON.stringify({version:1,mode}));}catch{throw Error("Could not save paste settings.");}
}
export type TerminalPasteText={text:string;display:string;bytes:number;lines:number;controls:number;truncated:boolean;risky:boolean};
export function inspectTerminalPaste(text:string):TerminalPasteText{
 if(text.length>131072)throw Error("Pasted text exceeds the 128 KiB limit. Nothing was sent.");
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw Error("Pasted text contains invalid Unicode. Nothing was sent.");}else if(c>=0xdc00&&c<=0xdfff)throw Error("Pasted text contains invalid Unicode. Nothing was sent.");}
 const bytes=new TextEncoder().encode(text).length;if(bytes>131072)throw Error("Pasted text exceeds the 128 KiB limit. Nothing was sent.");const points=[...text];const controls=(text.match(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g)??[]).length;
 return{text,display:points.slice(0,4096).join(""),bytes,lines:text===""?0:(text.match(/\r\n|\r|\n/g)??[]).length+1,controls,truncated:points.length>4096,risky:controls>0};
}
export function terminalPasteInputEligible(view:{disposed:boolean;availability?:string;live:boolean;projection:boolean;cursor:number|null;ready:boolean;firstAttachment:boolean},available:boolean):boolean{return !view.disposed&&available&&view.availability!=="owner_unavailable"&&view.live&&(view.projection||(view.cursor!==null&&(view.ready||view.firstAttachment)));}
export type TerminalPasteTarget<V=unknown,I=unknown>={sessionId:string;view:V;instance:I;frameInstance:string|null;attachVersion:number|undefined;lifecycleRevision:number;connectionVersion:number;paneId:string;selectionVersion:number;layoutRevision:number};
export type PendingTerminalPaste<V=unknown,I=unknown>={target:TerminalPasteTarget<V,I>;content:TerminalPasteText};
export function sameTerminalPasteTarget(a:TerminalPasteTarget,b:TerminalPasteTarget):boolean{return a.sessionId===b.sessionId&&a.view===b.view&&a.instance===b.instance&&a.frameInstance===b.frameInstance&&a.attachVersion===b.attachVersion&&a.lifecycleRevision===b.lifecycleRevision&&a.connectionVersion===b.connectionVersion&&a.paneId===b.paneId&&a.selectionVersion===b.selectionVersion&&a.layoutRevision===b.layoutRevision;}
