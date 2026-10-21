// Author: Jeff.Liu. Confirmed byte progress, independent of projection/resize revisions.
export type TerminalScrollState = {held:boolean;newOutput:boolean;endOffset:number|null};
type ScrollBuffer = {type:string;baseY:number;viewportY:number};
export function createTerminalScroll():TerminalScrollState {return {held:false,newOutput:false,endOffset:null};}
export function updateTerminalScroll(state:TerminalScrollState,buffer:ScrollBuffer,endOffset?:number):boolean {
 if(endOffset!==undefined && (!Number.isSafeInteger(endOffset)||endOffset<0||(state.endOffset!==null&&endOffset<state.endOffset)))return false;
 const held=buffer.type==="normal"&&buffer.viewportY<buffer.baseY;
 const progressed=endOffset!==undefined&&state.endOffset!==null&&endOffset>state.endOffset;
 const newOutput=held&&(state.newOutput||progressed);
 const changed=state.held!==held||state.newOutput!==newOutput;
 state.held=held;state.newOutput=newOutput;
 if(endOffset!==undefined)state.endOffset=endOffset;
 return changed;
}
