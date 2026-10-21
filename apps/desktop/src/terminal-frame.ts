// Author: Jeff.Liu. Render a validated full projection; the background remains the parser owner.
export const TERMINAL_SCROLLBACK_LINES=2000;
export type ReportedPromptNavigation={version:1;previous:boolean;next:boolean};
export type ReportedCommand={sequence:number;phase:"unknown"|"prompt"|"input"|"running"|"complete";last_exit:number|null};
export type ReportedCwd={path:string|null;sequence:number};
export type TerminalFrame = {clear_display_version?:1|null;projection: {version:number;instance:string;session:string;terminal_version:string;serialize_version:string;revision:number;data:string;cols:number;rows:number;cursorX:number;viewport:number;buffer:string;retained_lines?:number};end_offset:number;status:string;persisted?:boolean;reported_prompt_navigation?:ReportedPromptNavigation|null;reported_command?:ReportedCommand|null;reported_cwd?:ReportedCwd|null};
type Target = {options:{scrollback?:number};resize(cols:number,rows:number):void;write(data:string,callback:()=>void):void;scrollToLine(line:number):void};
export function terminalFrameRetention(projection:TerminalFrame["projection"]):number{
 const descriptor=Object.getOwnPropertyDescriptor(projection,"retained_lines");if(!descriptor)return TERMINAL_SCROLLBACK_LINES;
 if(!("value" in descriptor)||!Number.isSafeInteger(descriptor.value)||descriptor.value<200||descriptor.value>TERMINAL_SCROLLBACK_LINES)throw Error("Terminal frame retention contract is invalid");
 return descriptor.value;
}
export function validateTerminalFrame(frame:TerminalFrame,session:string):TerminalFrame {
 const p=frame?.projection;
 if(!p || p.version!==1 || p.session!==session || p.terminal_version!=="6.0.0" || p.serialize_version!=="0.14.0"
  || typeof p.instance!=="string" || !/^[a-fA-F0-9]{64}$/.test(p.instance)
  || !Number.isSafeInteger(p.revision) || p.revision<0 || typeof p.data!=="string" || p.data.length>8*1024*1024
  || !Number.isSafeInteger(p.cols) || p.cols<2 || p.cols>500 || !Number.isSafeInteger(p.rows) || p.rows<2 || p.rows>200
  || !Number.isSafeInteger(p.cursorX) || p.cursorX<0 || p.cursorX>p.cols || !Number.isSafeInteger(p.viewport) || p.viewport<0 || p.viewport>terminalFrameRetention(p)
  || !["normal","alternate"].includes(p.buffer) || !Number.isSafeInteger(frame.end_offset) || frame.end_offset<0 || typeof frame.status!=="string"
  || (frame.persisted!==undefined && typeof frame.persisted!=="boolean")) throw Error("Terminal frame identity or version contract is invalid");
 return frame;
}
export async function applyTerminalFrame(terminal:Target,frame:TerminalFrame,session:string):Promise<void> {
 const p=validateTerminalFrame(frame,session).projection;
 const core=terminal as unknown as {_core:{_inputHandler:{_activeBuffer:{x:number}};_viewport?:{_isSyncing:boolean;_sync():void}}};
 if(!core._core?._inputHandler?._activeBuffer) throw Error("Terminal renderer version contract is unavailable");
 const viewport=core._core._viewport;
 if(viewport&&(typeof viewport._isSyncing!=="boolean"||typeof viewport._sync!=="function"))throw Error("Terminal viewport version contract is unavailable");
 const syncing=viewport?._isSyncing;
 // xterm 6 synchronizes scrollbars during reset/replay; publish only the final buffer dimensions.
 if(viewport)viewport._isSyncing=true;
 try{
  terminal.options.scrollback=terminalFrameRetention(p);
  terminal.resize(p.cols,p.rows);
  // Reset inside the same parser write so a cleared scene cannot paint before its replacement.
  await new Promise<void>(resolve=>terminal.write("\x1bc"+p.data,resolve));
  // xterm 6 pins this private field: serialization alone loses the pending-wrap cursor at cols.
  core._core._inputHandler._activeBuffer.x=p.cursorX;
 }finally{
  if(viewport){viewport._isSyncing=syncing!;viewport._sync();}
 }
 terminal.scrollToLine(p.viewport);
}

// Optional stdout metadata cannot make a valid terminal scene unavailable.
export function terminalReportedCwd(frame:TerminalFrame):ReportedCwd|null {
 const outer=Object.getOwnPropertyDescriptor(frame,"reported_cwd");
 if(!outer||!("value" in outer)||!outer.value||typeof outer.value!=="object"||Array.isArray(outer.value))return null;
 const report=outer.value;
 if(Reflect.ownKeys(report).length!==2)return null;
 const path=Object.getOwnPropertyDescriptor(report,"path"),sequence=Object.getOwnPropertyDescriptor(report,"sequence");
 if(!path||!("value" in path)||!sequence||!("value" in sequence)||!Number.isSafeInteger(sequence.value)||sequence.value<0)return null;
 if(path.value!==null&&(typeof path.value!=="string"||new TextEncoder().encode(path.value).length>4096||/[\u0000-\u001f\u007f-\u009f]/.test(path.value)))return null;
 if(sequence.value===Number.MAX_SAFE_INTEGER&&path.value!==null)return null;
 return {path:path.value,sequence:sequence.value};
}

export function terminalReportedCommand(frame:TerminalFrame):ReportedCommand|null {
 const outer=Object.getOwnPropertyDescriptor(frame,"reported_command");if(!outer||!("value" in outer)||!outer.value||typeof outer.value!=="object"||Array.isArray(outer.value))return null;
 const report=outer.value,proto=Object.getPrototypeOf(report);if(proto!==Object.prototype&&proto!==null)return null;
 if(Reflect.ownKeys(report).length!==3)return null;
 const fields=["sequence","phase","last_exit"].map(key=>Object.getOwnPropertyDescriptor(report,key));if(fields.some(field=>!field||!("value" in field)))return null;
 const [sequence,phase,last_exit]=fields.map(field=>field!.value);
 if(!Number.isSafeInteger(sequence)||sequence<0||sequence>=Number.MAX_SAFE_INTEGER||!["unknown","prompt","input","running","complete"].includes(phase))return null;
 if(last_exit!==null&&(!Number.isInteger(last_exit)||last_exit<0||last_exit>255))return null;
 if((phase==="unknown"||phase==="running")&&last_exit!==null)return null;
 return {sequence,phase,last_exit};
}

export function terminalReportedPromptNavigation(frame:TerminalFrame):ReportedPromptNavigation|null{
 const outer=Object.getOwnPropertyDescriptor(frame,"reported_prompt_navigation");if(!outer||!("value" in outer)||!outer.value||typeof outer.value!=="object"||Array.isArray(outer.value))return null;
 const report=outer.value,proto=Object.getPrototypeOf(report);if(proto!==Object.prototype&&proto!==null||Reflect.ownKeys(report).length!==3)return null;
 const fields=["version","previous","next"].map(key=>Object.getOwnPropertyDescriptor(report,key));if(fields.some(field=>!field||!("value" in field)))return null;
 const [version,previous,next]=fields.map(field=>field!.value);return version===1&&typeof previous==="boolean"&&typeof next==="boolean"?{version:1,previous,next}:null;
}

// Service-generated support scalar; optional malformed metadata never invalidates a scene.
export function terminalClearDisplayVersion(frame:TerminalFrame):1|null{const value=Object.getOwnPropertyDescriptor(frame,"clear_display_version");return value&&"value" in value&&value.value===1?1:null;}
