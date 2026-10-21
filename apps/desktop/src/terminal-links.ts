// Author: Jeff.Liu. Bounded visible HTTP(S) links; OSC8 associations remain unsupported.
import {t} from "./i18n.ts";
import type {IBuffer,IBufferRange,Terminal} from "@xterm/xterm";
export function terminalLinkUrl(text:string):string|null{
 if(text.length>4096||!/^https?:\/\/[^/?#]+/i.test(text)||/^https?:\/\/[^/?#]*@/i.test(text)||/[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/u.test(text)||/%(?![0-9a-f]{2})/i.test(text))return null;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return null;}else if(c>=0xdc00&&c<=0xdfff)return null;}
 if(new TextEncoder().encode(text).length>4096)return null;
 try{const url=new URL(text);return(url.protocol==="http:"||url.protocol==="https:")&&url.hostname&&!url.username&&!url.password&&url.href.length<=4096?url.href:null;}catch{return null;}
}
type TerminalLinkCandidate={url:string;text:string;range:IBufferRange;signature:string;buffer:IBuffer;row:number};
export function terminalLinkCandidates(buffer:IBuffer,row:number,cols:number):TerminalLinkCandidate[]{
 if(!Number.isInteger(row)||row<1||row>buffer.length||!Number.isInteger(cols)||cols<1||cols>8192)return[];
 let first=row-1,last=first;
 while(buffer.getLine(first)?.isWrapped){if(first===0||last-first>=15)return[];first--;}
 while(last+1<buffer.length&&buffer.getLine(last+1)?.isWrapped){if(last-first>=15)return[];last++;}
 if((last-first+1)*cols>8192)return[];
 let text="",units=0;const map:{start:number;end:number;x:number;y:number;width:number;hidden:boolean}[]=[];
 for(let y=first;y<=last;y++){const line=buffer.getLine(y);if(!line)return[];for(let x=0;x<cols;x++){const cell=line.getCell(x);if(!cell)return[];const width=cell.getWidth();if(width===0)continue;const chars=cell.getChars()||" ";if(chars.length>8192-units)return[];const hidden=!!cell.isInvisible();map.push({start:units,end:units+chars.length,x:x+1,y:y+1,width,hidden});units+=chars.length;text+=hidden?"\0".repeat(chars.length):chars;}}
 const signature=JSON.stringify([first,last,cols,text,map.map(c=>[c.start,c.end,c.x,c.y,c.width,c.hidden])]);
 const links:TerminalLinkCandidate[]=[];let count=0;const tokens=/[^\s"'<>]+/gu;let match;
 while((match=tokens.exec(text))){if(!/^https?:\/\//i.test(match[0]))continue;if(++count>32)return[];const url=terminalLinkUrl(match[0]);if(!url)continue;const start=map.find(c=>c.start===match!.index),end=map.find(c=>c.end===match!.index+match![0].length);if(!start||!end||start.y>row||end.y<row)continue;links.push({url,text:match[0],range:{start:{x:start.x,y:start.y},end:{x:end.x+end.width-1,y:end.y}},signature,buffer,row});}
 return links;
}
export function installTerminalLinks(terminal:Terminal,element:HTMLElement,current:()=>string|null,open:(url:string)=>Promise<unknown>,error:()=>void,mac:boolean):{dispose():void}{
 let disposed=false,busy=false,last:TerminalLinkCandidate[]=[];
 let gesture:{pointer:number;x:number;y:number;identity:string;signature:string;buffer:IBuffer;complete:boolean}|null=null;
 const win=element.ownerDocument.defaultView!;
 const chord=(event:MouseEvent)=>event.button===0&&!event.altKey&&!event.shiftKey&&(mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey);
 const eligible=()=>!disposed&&terminal.modes.mouseTrackingMode==="none"&&!terminal.hasSelection()&&current()!==null;
 const fresh=(link:TerminalLinkCandidate)=>terminal.buffer.active===link.buffer&&terminalLinkCandidates(terminal.buffer.active,link.row,terminal.cols).some(next=>next.signature===link.signature&&next.url===link.url&&JSON.stringify(next.range)===JSON.stringify(link.range));
 const cancel=()=>{gesture=null;};
 const down=(event:Event)=>{const e=event as PointerEvent;cancel();const identity=current();if(!chord(e)||!eligible()||identity===null||!last.length||!fresh(last[0]))return;gesture={pointer:e.pointerId,x:e.clientX,y:e.clientY,identity,signature:last[0].signature,buffer:terminal.buffer.active,complete:false};};
 const move=(event:Event)=>{const e=event as PointerEvent;if(gesture&&(e.pointerId!==gesture.pointer||Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>4||!eligible()||current()!==gesture.identity))cancel();};
 const up=(event:Event)=>{const e=event as PointerEvent;move(event);if(!gesture)return;if(!element.contains(e.target as Node)||!chord(e))cancel();else gesture.complete=true;};
 const selection=terminal.onSelectionChange(()=>{if(terminal.hasSelection())cancel();});
 element.addEventListener("pointerdown",down,true);element.addEventListener("dragstart",cancel,true);win.addEventListener("pointermove",move,true);win.addEventListener("pointerup",up,true);win.addEventListener("pointercancel",cancel,true);win.addEventListener("blur",cancel);
 const provider=terminal.registerLinkProvider({provideLinks(row,callback){if(!eligible()){last=[];callback(undefined);return;}const identity=current();last=terminalLinkCandidates(terminal.buffer.active,row,terminal.cols);callback(last.map(link=>({text:link.text,range:link.range,activate(event){
   const accepted=gesture;cancel();if(!accepted||!accepted.complete||busy||!chord(event)||!eligible()||identity===null||current()!==identity||accepted.identity!==identity||accepted.buffer!==link.buffer||accepted.signature!==link.signature||Math.hypot(event.clientX-accepted.x,event.clientY-accepted.y)>4||!fresh(link))return;
   busy=true;const failed=()=>{if(!disposed&&current()===identity)error();};try{void Promise.resolve(open(link.url)).catch(failed).finally(()=>{busy=false;});}catch{busy=false;failed();}
 },hover(){if(eligible()&&current()===identity&&fresh(link))element.title=`${link.url}\n${t("{{modifier}}+click to open",{modifier:mac?"Command":"Ctrl"})}`;},leave(){element.title="";}})));}});
 return{dispose(){if(disposed)return;disposed=true;cancel();last=[];provider.dispose();selection.dispose();element.title="";element.removeEventListener("pointerdown",down,true);element.removeEventListener("dragstart",cancel,true);win.removeEventListener("pointermove",move,true);win.removeEventListener("pointerup",up,true);win.removeEventListener("pointercancel",cancel,true);win.removeEventListener("blur",cancel);}};
}
