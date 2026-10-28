// Author: Jeff.Liu. Pane identity is independent of the terminal session and parser.
export type TerminalLayoutMode = "single" | "horizontal" | "vertical" | "grid";
export type TerminalPane = {kind:"pane";paneId:string;sessionId:string|null;tabs?:string[]};
export type TerminalSplit = {kind:"split";nodeId:string;axis:"horizontal"|"vertical";ratio:number;first:TerminalLayoutNode;second:TerminalLayoutNode};
export type TerminalLayoutNode = TerminalPane|TerminalSplit;
export type TerminalLayoutState = {mode:TerminalLayoutMode|"custom";panes:(string|null)[];focused:number;revision:number;root?:TerminalLayoutNode};
export const MAX_TERMINAL_PANES=16,MAX_TERMINAL_LAYOUT_DEPTH=16;
const counts:Record<TerminalLayoutMode,number>={single:1,horizontal:2,vertical:2,grid:4};
export function terminalLeaves(root:TerminalLayoutNode):TerminalPane[]{return root.kind==="pane"?[root]:[...terminalLeaves(root.first),...terminalLeaves(root.second)];}
function pane(index:number,sessionId:string|null):TerminalPane{return {kind:"pane",paneId:`p-${index}`,sessionId};}
function branch(nodeId:string,axis:TerminalSplit["axis"],first:TerminalLayoutNode,second:TerminalLayoutNode,ratio=50):TerminalSplit{return {kind:"split",nodeId,axis,ratio,first,second};}
export function terminalLayoutRoot(layout:TerminalLayoutState,ratio=50):TerminalLayoutNode {
 if(layout.root)return layout.root;
 const leaves=layout.panes.map((id,index)=>pane(index,id));
 if(layout.mode==="single"||leaves.length===1)return leaves[0];
 if(layout.mode==="grid")return branch("n-0","vertical",branch("n-1","horizontal",leaves[0],leaves[1]),branch("n-2","horizontal",leaves[2],leaves[3]));
 return branch("n-0",layout.mode as TerminalSplit["axis"],leaves[0],leaves[1],ratio);
}
export function terminalPaneId(layout:TerminalLayoutState,index:number):string{return layout.root?terminalLeaves(layout.root)[index]?.paneId??"":index>=0&&index<layout.panes.length?`p-${index}`:"";}
export function terminalPaneIndex(layout:TerminalLayoutState,paneId:string):number{return layout.root?terminalLeaves(layout.root).findIndex(leaf=>leaf.paneId===paneId):layout.panes.findIndex((_,index)=>`p-${index}`===paneId);}
export function layoutFromRoot(root:TerminalLayoutNode,focusedPane:string,revision=0,mode:TerminalLayoutState["mode"]="custom"):TerminalLayoutState {
 const leaves=terminalLeaves(root);return {mode,panes:leaves.map(leaf=>leaf.sessionId),focused:leaves.findIndex(leaf=>leaf.paneId===focusedPane),revision,root};
}
export function createTerminalLayout():TerminalLayoutState {return {mode:"single",panes:[null],focused:0,revision:0};}
export function terminalTabs(leaf:TerminalPane):string[]{return leaf.tabs??(leaf.sessionId?[leaf.sessionId]:[]);}
export function terminalMembers(layout:TerminalLayoutState):string[]{return terminalLeaves(terminalLayoutRoot(layout)).flatMap(terminalTabs);}
export function terminalSessionPane(layout:TerminalLayoutState,id:string):number{return terminalLeaves(terminalLayoutRoot(layout)).findIndex(leaf=>terminalTabs(leaf).includes(id));}
function replaceLeaves(root:TerminalLayoutNode,leaves:TerminalPane[]):TerminalLayoutNode {let i=0;function visit(node:TerminalLayoutNode):TerminalLayoutNode{return node.kind==="pane"?leaves[i++]:{...node,first:visit(node.first),second:visit(node.second)};}return visit(root);}
function updateLeaves(layout:TerminalLayoutState,leaves:TerminalPane[],focused=layout.focused):TerminalLayoutState {
 const panes=leaves.map(leaf=>leaf.sessionId);
 if(!layout.root&&leaves.every(leaf=>terminalTabs(leaf).length<=1))return {...layout,panes,focused,revision:layout.revision+1};
 const root=replaceLeaves(terminalLayoutRoot(layout),leaves);return layoutFromRoot(root,leaves[focused].paneId,layout.revision+1,layout.mode);
}
export function changeTerminalLayout(layout:TerminalLayoutState,mode:TerminalLayoutMode,ratio=50):TerminalLayoutState {
 if(!Object.prototype.hasOwnProperty.call(counts,mode))throw Error("Unsupported terminal layout");
 const old=terminalLeaves(terminalLayoutRoot(layout)),count=counts[mode],selected=layout.panes[layout.focused];
 const focused=Math.min(layout.focused,count-1);
 const leaves=Array.from({length:count},(_,i)=>({...pane(i,old[i]?.sessionId??null),tabs:[...(old[i]?terminalTabs(old[i]):[])]}));
 for(const leaf of old.slice(count))leaves[focused].tabs.push(...terminalTabs(leaf));
 if(selected)leaves[focused].sessionId=selected;
 if(leaves[focused].sessionId===null)leaves[focused].sessionId=leaves[focused].tabs[0]??null;
 // A retained leaf can own the selected member only once; its source becomes inactive.
 for(let i=0;i<leaves.length;i++)if(i!==focused&&leaves[i].tabs.includes(selected!)){leaves[i].tabs=leaves[i].tabs.filter(id=>id!==selected);leaves[i].sessionId=leaves[i].tabs[0]??null;}
 const next={mode,panes:leaves.map(leaf=>leaf.sessionId),focused,revision:layout.revision+1};
 return {...next,root:replaceLeaves(terminalLayoutRoot(next,ratio),leaves)};
}
export function assignTerminalPane(layout:TerminalLayoutState,index:number,id:string):TerminalLayoutState {
 if(!Number.isSafeInteger(index)||index<0||index>=layout.panes.length||!id)throw Error("Invalid terminal pane");
 const leaves=terminalLeaves(terminalLayoutRoot(layout)),duplicate=terminalSessionPane(layout,id),target=duplicate>=0?duplicate:index;
 if(duplicate<0&&terminalMembers(layout).length>=MAX_TERMINAL_PANES)throw Error("Terminal layout supports at most 16 sessions.");
 const leaf=leaves[target],tabs=terminalTabs(leaf);leaves[target]={...leaf,tabs:tabs.includes(id)?[...tabs]:[...tabs,id],sessionId:id};
 return updateLeaves(layout,leaves,target);
}
export function replaceTerminalSession(layout:TerminalLayoutState,previous:string,next:string):TerminalLayoutState {
 if(typeof next!=="string"||!next)throw Error("Invalid terminal session");
 if(previous===next||!terminalMembers(layout).includes(previous))return layout;
 const duplicate=terminalMembers(layout).includes(next);
 return updateLeaves(layout,terminalLeaves(terminalLayoutRoot(layout)).map(leaf=>{
  const tabs=terminalTabs(leaf).flatMap(id=>id===previous?(duplicate?[]:[next]):[id]);
  return {...leaf,tabs,sessionId:leaf.sessionId===previous?(duplicate?tabs[0]??null:next):leaf.sessionId};
 }));
}
export function removeTerminalTab(layout:TerminalLayoutState,index:number,id:string):TerminalLayoutState {
 if(!Number.isSafeInteger(index)||index<0||index>=layout.panes.length)throw Error("Invalid terminal pane");
 const leaves=terminalLeaves(terminalLayoutRoot(layout)),leaf=leaves[index],old=terminalTabs(leaf),position=old.indexOf(id);if(position<0)return layout;
 const tabs=old.filter(member=>member!==id),active=leaf.sessionId===id?tabs[Math.min(position,tabs.length-1)]??null:leaf.sessionId;
 leaves[index]={...leaf,tabs,sessionId:active};return updateLeaves(layout,leaves);
}
export function removeTerminalPane(layout:TerminalLayoutState,index:number):TerminalLayoutState {
 if(!Number.isSafeInteger(index)||index<0||index>=layout.panes.length)throw Error("Invalid terminal pane");
 const id=layout.panes[index];if(!id)return layout;const next=removeTerminalTab(layout,index,id);
 const first=next.panes.findIndex(Boolean);return index===layout.focused&&!next.panes[index]&&first>=0?{...next,focused:first}:next;
}
export function reorderTerminalTab(layout:TerminalLayoutState,id:string,before:string|null=null):TerminalLayoutState {
 const index=terminalSessionPane(layout,id);if(index<0)throw Error("Invalid terminal tab");
 const leaves=terminalLeaves(terminalLayoutRoot(layout)),leaf=leaves[index],old=terminalTabs(leaf);
 if(before!==null&&!old.includes(before))throw Error("Invalid terminal tab position");if(before===id)return layout;
 const tabs=old.filter(member=>member!==id);tabs.splice(before===null?tabs.length:tabs.indexOf(before),0,id);
 if(tabs.every((member,i)=>member===old[i]))return layout;
 leaves[index]={...leaf,tabs};return updateLeaves(layout,leaves);
}
export function moveTerminalTab(layout:TerminalLayoutState,id:string,to:number,before:string|null=null):TerminalLayoutState {
 if(!Number.isSafeInteger(to)||to<0||to>=layout.panes.length)throw Error("Invalid terminal pane");
 const from=terminalSessionPane(layout,id);if(from<0)throw Error("Invalid terminal tab");if(from===to)return reorderTerminalTab(layout,id,before);
 const oldTarget=terminalLeaves(terminalLayoutRoot(layout))[to];
 if(before!==null&&!terminalTabs(oldTarget).includes(before))throw Error("Invalid terminal tab position");
 const removed=removeTerminalTab(layout,from,id),leaves=terminalLeaves(terminalLayoutRoot(removed)),target=leaves[to],tabs=[...terminalTabs(target)];
 tabs.splice(before===null?tabs.length:tabs.indexOf(before),0,id);
 leaves[to]={...target,tabs,sessionId:id};return updateLeaves(layout,leaves,to);
}
export function clampSplitPercent(value:unknown):number {if(typeof value!=="number"||!Number.isFinite(value))return 50;return Math.max(20,Math.min(80,Math.round(value)));}
export function swapTerminalPanes(layout:TerminalLayoutState,from:number,to:number):TerminalLayoutState {
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<0||from>=layout.panes.length||to>=layout.panes.length||from===to)return layout;
 const leaves=terminalLeaves(terminalLayoutRoot(layout)),a=leaves[from],b=leaves[to];
 if(!terminalTabs(a).length&&!terminalTabs(b).length)return layout;
 leaves[from]={...a,sessionId:b.sessionId,tabs:[...terminalTabs(b)]};leaves[to]={...b,sessionId:a.sessionId,tabs:[...terminalTabs(a)]};
 return updateLeaves(layout,leaves,layout.focused===from?to:layout.focused===to?from:layout.focused);
}
export function splitTerminalPane(layout:TerminalLayoutState,axis:TerminalSplit["axis"],ratio=50,placement:"before"|"after"="after"):TerminalLayoutState {
 if((axis!=="horizontal"&&axis!=="vertical")||(placement!=="before"&&placement!=="after"))throw Error("Invalid terminal split");
 if(layout.panes.length>=MAX_TERMINAL_PANES)throw Error("Terminal layout supports at most 16 panes.");
 const root=terminalLayoutRoot(layout,ratio),target=terminalPaneId(layout,layout.focused),used=new Set<string>();
 function collect(node:TerminalLayoutNode){used.add(node.kind==="pane"?node.paneId:node.nodeId);if(node.kind==="split"){collect(node.first);collect(node.second);}}collect(root);
 function nextId(prefix:string){let i=0;while(used.has(`${prefix}-${i}`))i++;const id=`${prefix}-${i}`;used.add(id);return id;}
 const newPane=pane(0,null);newPane.paneId=nextId("p");let found=false;
 function visit(node:TerminalLayoutNode,depth:number):TerminalLayoutNode {
  if(node.kind==="pane") {if(node.paneId!==target)return node;if(depth>=MAX_TERMINAL_LAYOUT_DEPTH)throw Error("Terminal layout depth limit reached.");found=true;return placement==="before"?branch(nextId("n"),axis,newPane,node):branch(nextId("n"),axis,node,newPane);}
  const first=visit(node.first,depth+1),second=visit(node.second,depth+1);return first===node.first&&second===node.second?node:{...node,first,second};
 }
 const next=visit(root,1);if(!found)throw Error("Invalid terminal pane");return layoutFromRoot(next,newPane.paneId,layout.revision+1,layout.panes.length===1?axis:"custom");
}
// xterm emits these finite terminal replies through onData too. They stay per-session,
// even for hidden live raw views; serialized projection replay never answers queries.
export function isTerminalProtocolResponse(data:string):boolean {
 return /^\x1b\[\??[0-9]+;[0-9]+R$/.test(data)
  || /^\x1b\[[?>]?[0-9]+(?:;[0-9]+)*c$/.test(data)
  || /^\x1b\[(?:0|3)n$/.test(data)
  || /^\x1b\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)$/.test(data);
}

// Resize changes only the addressed split and its ancestors; membership and focus stay intact.
export function resizeTerminalNode(layout:TerminalLayoutState,nodeId:string,ratio:number):TerminalLayoutState {
 if(!nodeId||!Number.isInteger(ratio)||ratio<20||ratio>80)throw Error("Invalid terminal split ratio");
 let found=false;
 function visit(node:TerminalLayoutNode):TerminalLayoutNode {
  if(node.kind==="pane")return node;
  if(node.nodeId===nodeId){found=true;return node.ratio===ratio?node:{...node,ratio};}
  const first=visit(node.first),second=visit(node.second);return first===node.first&&second===node.second?node:{...node,first,second};
 }
 const root=terminalLayoutRoot(layout),next=visit(root);if(!found)throw Error("Invalid terminal split node");
 return next===root?layout:{...layout,root:next,revision:layout.revision+1};
}
export function terminalNodeMinimum(node:TerminalLayoutNode,separator=6):{width:number;height:number} {
 if(node.kind==="pane")return {width:240,height:180};
 const first=terminalNodeMinimum(node.first,separator),second=terminalNodeMinimum(node.second,separator),fraction=node.ratio/100;
 return node.axis==="horizontal"?{width:Math.ceil(Math.max(first.width/fraction,second.width/(1-fraction)))+separator,height:Math.max(first.height,second.height)}:{width:Math.max(first.width,second.width),height:Math.ceil(Math.max(first.height/fraction,second.height/(1-fraction)))+separator};
}
export function terminalResizeBounds(node:TerminalSplit,size:number,separator=6):{lower:number;upper:number;disabled:boolean} {
 const first=terminalNodeMinimum(node.first),second=terminalNodeMinimum(node.second),content=size-separator;
 if(!Number.isFinite(content)||content<=0)return {lower:20,upper:80,disabled:true};
 const lower=Math.max(20,Math.ceil((node.axis==="horizontal"?first.width:first.height)*100/content));
 const upper=Math.min(80,Math.floor((content-(node.axis==="horizontal"?second.width:second.height))*100/content));
 return {lower,upper,disabled:lower>upper};
}

export type TerminalPaneDirection="left"|"right"|"up"|"down";
export type TerminalPaneRect={left:number;top:number;width:number;height:number};
// DOM rectangles share one viewport coordinate space. Partial geometry is deliberately a no-op.
export function terminalDirectionPane(layout:TerminalLayoutState,direction:TerminalPaneDirection,rects:ReadonlyMap<string,TerminalPaneRect>,zoomedPaneId:string|null=null):number|null {
 if(!["left","right","up","down"].includes(direction))return null;
 const currentId=terminalPaneId(layout,layout.focused),ids=layout.panes.map((_,index)=>terminalPaneId(layout,index)).filter(id=>!zoomedPaneId||id===zoomedPaneId);
 if(!ids.includes(currentId))return null;
 const geometry=new Map<string,{left:number;top:number;right:number;bottom:number;x:number;y:number}>();
 for(const id of ids){
  const rect=rects.get(id);if(!rect||![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0)return null;
  const right=rect.left+rect.width,bottom=rect.top+rect.height,x=rect.left+rect.width/2,y=rect.top+rect.height/2;
  if(![right,bottom,x,y].every(Number.isFinite))return null;geometry.set(id,{...rect,right,bottom,x,y});
 }
 const current=geometry.get(currentId)!,horizontal=direction==="left"||direction==="right",positive=direction==="right"||direction==="down";
 const axis=horizontal?"x":"y",orthogonal=horizontal?"y":"x";let best:number[]|null=null,target:number|null=null;
 for(const id of ids){
  if(id===currentId)continue;const rect=geometry.get(id)!,forward=(rect[axis]-current[axis])*(positive?1:-1);if(forward<=0)continue;
  const overlap=horizontal?Math.min(current.bottom,rect.bottom)-Math.max(current.top,rect.top):Math.min(current.right,rect.right)-Math.max(current.left,rect.left);
  const gap=horizontal?(positive?rect.left-current.right:current.left-rect.right):(positive?rect.top-current.bottom:current.top-rect.bottom);
  const index=terminalPaneIndex(layout,id),score=[overlap>0?0:1,Math.max(0,gap),Math.abs(rect[orthogonal]-current[orthogonal]),Math.hypot(rect.x-current.x,rect.y-current.y),index];
  if(!best||score.some((value,i)=>value!==best![i]&&score.slice(0,i).every((part,j)=>part===best![j])&&value<best![i])){best=score;target=index;}
 }
 return target;
}

export type TerminalPaneEdge="left"|"right"|"top"|"bottom";
export function splitAndMoveTerminalTab(layout:TerminalLayoutState,id:string,paneId:string,edge:TerminalPaneEdge):TerminalLayoutState {
 if(!["left","right","top","bottom"].includes(edge))throw Error("Invalid terminal pane edge");
 const target=terminalPaneIndex(layout,paneId),members=terminalMembers(layout);
 if(target<0||!id||terminalSessionPane(layout,id)<0||members.length>MAX_TERMINAL_PANES)throw Error("Invalid terminal tab target");
 const split=splitTerminalPane({...layout,focused:target},edge==="left"||edge==="right"?"horizontal":"vertical",50,edge==="left"||edge==="top"?"before":"after");
 const next=moveTerminalTab(split,id,split.focused);
 return {...next,revision:layout.revision+1};
}
export function terminalPaneDropEdge(rect:{left:number;top:number;width:number;height:number},x:number,y:number):TerminalPaneEdge|null {
 const {left,top,width,height}=rect;
 if(![left,top,width,height,x,y].every(Number.isFinite)||width<=0||height<=0||x<left||y<top||x>left+width||y>top+height)return null;
 const distances:[TerminalPaneEdge,number,number][]=[["left",x-left,width],["right",left+width-x,width],["top",y-top,height],["bottom",top+height-y,height]];
 let edge:TerminalPaneEdge|null=null,nearest=Infinity;
 for(const [candidate,distance,dimension] of distances)if(distance<=Math.min(32,dimension*0.2)&&distance<nearest){edge=candidate;nearest=distance;}
 return edge;
}
