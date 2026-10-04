// Author: Jeff.Liu. Fixed visible membership; parser ownership stays in TerminalViews.
export type TerminalLayoutMode = "single" | "horizontal" | "vertical" | "grid";
export type TerminalLayoutState = {mode:TerminalLayoutMode;panes:(string|null)[];focused:number;revision:number};
const counts:Record<TerminalLayoutMode,number>={single:1,horizontal:2,vertical:2,grid:4};
export function createTerminalLayout():TerminalLayoutState {return {mode:"single",panes:[null],focused:0,revision:0};}
export function changeTerminalLayout(layout:TerminalLayoutState,mode:TerminalLayoutMode):TerminalLayoutState {
 if(!Object.prototype.hasOwnProperty.call(counts,mode))throw Error("Unsupported terminal layout");
 const panes=Array.from({length:counts[mode]},(_,i)=>layout.panes[i]??null);
 const selected=layout.panes[layout.focused];let focused=Math.min(layout.focused,panes.length-1);
 if(selected&&!panes.includes(selected)){panes[focused]=selected;}
 return {mode,panes,focused,revision:layout.revision+1};
}
export function assignTerminalPane(layout:TerminalLayoutState,index:number,id:string):TerminalLayoutState {
 if(!Number.isSafeInteger(index)||index<0||index>=layout.panes.length||!id)throw Error("Invalid terminal pane");
 const duplicate=layout.panes.indexOf(id);
 if(duplicate>=0)return {...layout,focused:duplicate};
 const panes=[...layout.panes];panes[index]=id;
 return {...layout,panes,revision:layout.revision+1};
}
export function removeTerminalPane(layout:TerminalLayoutState,index:number):TerminalLayoutState {
 if(!Number.isSafeInteger(index)||index<0||index>=layout.panes.length)throw Error("Invalid terminal pane");
 const panes=[...layout.panes];panes[index]=null;
 const first=panes.findIndex(Boolean),focused=index===layout.focused&&first>=0?first:layout.focused;
 return {...layout,panes,focused,revision:layout.revision+1};
}
export function clampSplitPercent(value:unknown):number {
 if(typeof value!=="number"||!Number.isFinite(value))return 50;
 return Math.max(20,Math.min(80,Math.round(value)));
}
export function swapTerminalPanes(layout:TerminalLayoutState,from:number,to:number):TerminalLayoutState {
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<0||from>=layout.panes.length||to>=layout.panes.length||from===to)return layout;
 if(layout.panes[from]===layout.panes[to])return layout;
 const panes=[...layout.panes];[panes[from],panes[to]]=[panes[to],panes[from]];
 const focused=layout.focused===from?to:layout.focused===to?from:layout.focused;
 return {...layout,panes,focused,revision:layout.revision+1};
}
// xterm emits these finite terminal replies through onData too. They stay per-session,
// even for hidden live raw views; serialized projection replay never answers queries.
export function isTerminalProtocolResponse(data:string):boolean {
 return /^\x1b\[\??[0-9]+;[0-9]+R$/.test(data)
  || /^\x1b\[[?>]?[0-9]+(?:;[0-9]+)*c$/.test(data)
  || /^\x1b\[(?:0|3)n$/.test(data)
  || /^\x1b\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)$/.test(data);
}
