// Author: Jeff.Liu. Render a validated full projection; the background remains the parser owner.
export type TerminalFrame = {projection: {version:number;instance:string;session:string;terminal_version:string;serialize_version:string;revision:number;data:string;cols:number;rows:number;cursorX:number;viewport:number;buffer:string};end_offset:number;status:string};
type Target = {reset():void;resize(cols:number,rows:number):void;write(data:string,callback:()=>void):void;scrollToLine(line:number):void};
export function validateTerminalFrame(frame:TerminalFrame,session:string):TerminalFrame {
 const p=frame?.projection;
 if(!p || p.version!==1 || p.session!==session || p.terminal_version!=="6.0.0" || p.serialize_version!=="0.14.0"
  || typeof p.instance!=="string" || !/^[a-fA-F0-9]{64}$/.test(p.instance)
  || !Number.isSafeInteger(p.revision) || p.revision<0 || typeof p.data!=="string" || p.data.length>8*1024*1024
  || !Number.isSafeInteger(p.cols) || p.cols<2 || p.cols>500 || !Number.isSafeInteger(p.rows) || p.rows<2 || p.rows>200
  || !Number.isSafeInteger(p.cursorX) || p.cursorX<0 || p.cursorX>p.cols || !Number.isSafeInteger(p.viewport) || p.viewport<0 || p.viewport>2000
  || !["normal","alternate"].includes(p.buffer) || !Number.isSafeInteger(frame.end_offset) || frame.end_offset<0 || typeof frame.status!=="string") throw Error("Terminal frame identity or version contract is invalid");
 return frame;
}
export async function applyTerminalFrame(terminal:Target,frame:TerminalFrame,session:string):Promise<void> {
 const p=validateTerminalFrame(frame,session).projection;
 const core=terminal as unknown as {_core:{_inputHandler:{_activeBuffer:{x:number}}}};
 if(!core._core?._inputHandler?._activeBuffer) throw Error("Terminal renderer version contract is unavailable");
 terminal.reset();terminal.resize(p.cols,p.rows);
 await new Promise<void>(resolve=>terminal.write(p.data,resolve));
 // xterm 6 pins this private field: serialization alone loses the pending-wrap cursor at cols.
 core._core._inputHandler._activeBuffer.x=p.cursorX;
 terminal.scrollToLine(p.viewport);
}
