// Author: Jeff.Liu. Search state and ownership belong to one terminal view.
import type {FindScan} from "./terminal-find-worker";
type Disposable={dispose():void};
type Cell={getChars():string;getWidth():number};
type Line={isWrapped:boolean;length:number;getCell(column:number):Cell|undefined};
type Selection={start:{x:number;y:number};end:{x:number;y:number}};
export type FindTerminal={cols:number;rows:number;buffer:{active:{length:number;baseY:number;cursorY:number;viewportY:number;type:string;getLine(row:number):Line|undefined}};hasSelection():boolean;getSelectionPosition():Selection|undefined;clearSelection():void;select(col:number,row:number,size:number):void;scrollToLine(line:number):void;registerMarker(offset:number):Disposable|undefined;registerDecoration(options:object):Disposable|undefined;onSelectionChange?:(callback:()=>void)=>Disposable};
export type FindSnapshot={text:string;cells:{start:number;end:number;row:number;col:number;width:number;cellChars:number;cellWidth:number}[]};
export type FindRange={col:number;row:number;size:number};
function appendSnapshotRow(snapshot:FindSnapshot,terminal:FindTerminal,row:number){
 const buffer=terminal.buffer.active,line=buffer.getLine(row);if(!line)return;
 const next=buffer.getLine(row+1),wrapped=!!next?.isWrapped;let rowText="",cells:FindSnapshot["cells"]=[];
 for(let col=0;col<Math.min(line.length,terminal.cols);col++){
  const cell=line.getCell(col);if(!cell||cell.getWidth()===0)continue;
  const chars=cell.getChars();
  if(wrapped&&col===terminal.cols-1&&!chars&&next?.getCell(0)?.getWidth()===2)continue;
  const value=chars||" ",start=snapshot.text.length+rowText.length,cellWidth=cell.getWidth(),previous=cells[cells.length-1];
  if(previous&&previous.cellChars===value.length&&previous.cellWidth===cellWidth&&previous.col+previous.width===col){previous.end+=value.length;previous.width+=cellWidth;}
  else cells.push({start,end:start+value.length,row,col,width:cellWidth,cellChars:value.length,cellWidth});
  rowText+=value;
 }
 if(!wrapped){rowText=rowText.trimEnd();const end=snapshot.text.length+rowText.length;cells=cells.filter(cell=>cell.start<end);const last=cells[cells.length-1];if(last&&last.end>end){last.width=Math.ceil((end-last.start)/last.cellChars)*last.cellWidth;last.end=end;}}
 snapshot.cells.push(...cells);snapshot.text+=rowText;if(!wrapped&&row<buffer.length-1)snapshot.text+="\n";
}
export function snapshotTerminal(terminal:FindTerminal):FindSnapshot {
 const snapshot:FindSnapshot={text:"",cells:[]};for(let row=0;row<terminal.buffer.active.length;row++)appendSnapshotRow(snapshot,terminal,row);return snapshot;
}
export async function snapshotTerminalAsync(terminal:FindTerminal,current:()=>boolean,yieldFrame:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))):Promise<FindSnapshot>{
 const snapshot:FindSnapshot={text:"",cells:[]},length=terminal.buffer.active.length;let sliceStart=performance.now(),sliceRows=0;
 for(let row=0;row<length;row++){
  if(!current())throw Error("Terminal find cancelled");appendSnapshotRow(snapshot,terminal,row);
  sliceRows++;if(row<length-1&&(sliceRows>=128||performance.now()-sliceStart>=4)){await yieldFrame();sliceStart=performance.now();sliceRows=0;}
 }
 if(!current())throw Error("Terminal find cancelled");return snapshot;
}
export function findCellRange(snapshot:FindSnapshot,start:number,end:number,cols:number):FindRange|null {
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>snapshot.text.length||cols<1)return null;
 const cells=snapshot.cells;const at=(offset:number)=>{let low=0,high=cells.length;while(low<high){const mid=(low+high)>>>1;if(cells[mid].end<=offset)low=mid+1;else high=mid;}return cells[low];};
 let low=0,high=cells.length;while(low<high){const mid=(low+high)>>>1;if(cells[mid].start<end)low=mid+1;else high=mid;}
 const first=at(start),last=cells[low-1];if(!first||!last||first.start>=end)return null;
 const col=first.col+Math.floor(Math.max(0,start-first.start)/first.cellChars)*first.cellWidth,lastCol=last.col+Math.min(last.width,Math.ceil((end-last.start)/last.cellChars)*last.cellWidth);
 return {col,row:first.row,size:(last.row-first.row)*cols+lastCol-col};
}
export function terminalFindShortcut(event:Pick<KeyboardEvent,"key"|"metaKey"|"ctrlKey"|"shiftKey"|"altKey"|"isComposing"|"repeat"|"keyCode">,mac:boolean):boolean {
 return event.key.toLowerCase()==="f"&&!event.isComposing&&event.keyCode!==229&&!event.repeat&&!event.altKey&&!event.shiftKey&&(mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey);
}
export type FindWorkerPort={postMessage(value:unknown):void;terminate():unknown;onmessage:((event:MessageEvent<FindScan&{id:number}>)=>unknown)|null;onerror:((event:ErrorEvent)=>unknown)|null};
export function createFindWorker():FindWorkerPort {return new Worker(new URL("./terminal-find-worker.ts",import.meta.url),{type:"module"});}
export interface FindRunner{run(text:string,query:string,regex:boolean,caseSensitive:boolean):Promise<FindScan>;cancel():void;dispose():void}
export class FindWorker implements FindRunner {
 private pending:{port:FindWorkerPort;timer:ReturnType<typeof setTimeout>;reject:(reason:Error)=>void}|null=null;
 private sequence=0;private disposed=false;
 private create:()=>FindWorkerPort;private deadline:number;
 constructor(create:()=>FindWorkerPort,deadline=100){this.create=create;this.deadline=deadline;}
 run(text:string,query:string,regex:boolean,caseSensitive:boolean):Promise<FindScan>{
  this.cancel();if(this.disposed)return Promise.reject(Error("Terminal find disposed"));
  return new Promise((resolve,reject)=>{
   let port:FindWorkerPort;try{port=this.create();}catch{reject(Error("Terminal find worker unavailable"));return;}
   const id=++this.sequence;
   const finish=()=>{if(this.pending?.port!==port)return false;clearTimeout(this.pending.timer);this.pending=null;port.onmessage=null;port.onerror=null;void port.terminate();return true;};
   const timer=setTimeout(()=>{if(finish())reject(Error("Terminal regex search timed out (100 ms). Change the pattern or use literal search."));},this.deadline);
   this.pending={port,timer,reject};
   port.onmessage=({data})=>{if(data.id!==id)return;if(finish()){if(data.error)reject(Error(data.error));else resolve(data);}};
   port.onerror=()=>{if(finish())reject(Error("Terminal find worker failed"));};
   try{port.postMessage({id,text,query,regex,caseSensitive});}catch{if(finish())reject(Error("Terminal find worker unavailable"));}
  });
 }
 cancel(){const pending=this.pending;if(!pending)return;this.pending=null;clearTimeout(pending.timer);pending.port.onmessage=null;pending.port.onerror=null;void pending.port.terminate();pending.reject(Error("Terminal find cancelled"));}
 dispose(){this.disposed=true;this.cancel();}
}
type LiteralAddon={findNext(query:string,options:{regex:false;caseSensitive:boolean}):boolean;findPrevious(query:string,options:{regex:false;caseSensitive:boolean}):boolean;dispose():void};
export type TerminalFindState={visible:boolean;query:string;caseSensitive:boolean;regex:boolean;count:number;index:number;overflow:boolean;busy:boolean;error:string|null;highlightUnavailable:boolean;focusRevision:number};
export class TerminalFindController {
 readonly state:TerminalFindState={visible:false,query:"",caseSensitive:false,regex:false,count:0,index:-1,overflow:false,busy:false,error:null,highlightUnavailable:false,focusRevision:0};
 private ranges:FindRange[]=[];private terms:string[]=[];private resultVersion=-1;private anchor:FindRange|null=null;private owned:Selection|undefined;private operating=false;private version=0;private disposed=false;private decorations:Disposable[]=[];
 private selectionListener:Disposable|undefined;private terminal:FindTerminal;private addon:()=>LiteralAddon;private runner:FindRunner;private changed:()=>void;
 constructor(terminal:FindTerminal,addon:()=>LiteralAddon,runner:FindRunner,changed:()=>void){this.terminal=terminal;this.addon=addon;this.runner=runner;this.changed=changed;this.selectionListener=terminal.onSelectionChange?.(()=>this.selectionChanged());}
 open(){if(this.disposed)return;this.state.visible=true;this.state.focusRevision++;this.changed();if(this.state.query)void this.search(false);}
 async setQuery(query:string){if(this.disposed)return;this.state.query=query;this.anchor=null;this.clearOwned();this.state.index=-1;await this.search(true);}
 async setOptions(options:Partial<Pick<TerminalFindState,"caseSensitive"|"regex">>){if(this.disposed)return;Object.assign(this.state,options);this.anchor=null;this.clearOwned();this.state.index=-1;await this.search(true);}
 private ownsSelection(){return !!this.owned&&JSON.stringify(this.owned)===JSON.stringify(this.terminal.getSelectionPosition());}
 blocksProjection(){return this.terminal.hasSelection()&&!this.ownsSelection();}
 selectionChanged(){if(!this.operating)this.manualSelection();}
 manualSelection(){if(this.disposed||this.operating)return;this.owned=undefined;this.anchor=null;this.state.index=-1;this.invalidate();this.changed();}
 private clearHighlights(){for(const decoration of this.decorations)decoration.dispose();this.decorations=[];}
 private clearOwned(){if(this.ownsSelection()){this.operating=true;try{this.terminal.clearSelection();}finally{this.operating=false;}}this.owned=undefined;}
 private invalidate(){this.version++;this.resultVersion=-1;this.runner.cancel();this.clearHighlights();this.state.busy=false;}
 beforeFrame(){this.invalidate();this.clearOwned();this.ranges=[];}
 async afterFrame(current:()=>boolean){if(current())await this.search(false,current);}
 async refresh(){await this.search(false);}
 private async search(explicit:boolean,current=()=>true){
  this.invalidate();const version=this.version;
  if(this.disposed||!this.state.visible||(!explicit&&this.blocksProjection()))return;
  if(!this.state.query){this.clearOwned();this.ranges=[];Object.assign(this.state,{count:0,index:-1,overflow:false,error:null});this.changed();return;}
  if(explicit&&this.blocksProjection()){this.state.error="Clear the terminal selection to search.";this.changed();return;}
  this.state.busy=true;this.state.error=null;this.changed();
  try{
   const snapshot=await snapshotTerminalAsync(this.terminal,()=>!this.disposed&&version===this.version&&current());
   const result=await this.runner.run(snapshot.text,this.state.query,this.state.regex,this.state.caseSensitive);
   if(this.disposed||version!==this.version||!current()||this.blocksProjection())return;
      this.ranges=[];this.terms=[];
   for(const [start,end]of result.matches){const range=findCellRange(snapshot,start,end,this.terminal.cols);if(range){this.ranges.push(range);this.terms.push(snapshot.text.slice(start,end));}}
   this.resultVersion=version;
   this.state.count=this.ranges.length;this.state.overflow=result.overflow;this.state.index=this.anchor?this.ranges.findIndex(range=>range.col===this.anchor!.col&&range.row===this.anchor!.row&&range.size===this.anchor!.size):-1;this.state.highlightUnavailable=false;
   this.highlight();this.state.busy=false;if(explicit)await this.navigate(1);
  }catch(reason){if(!this.disposed&&version===this.version&&current()){this.ranges=[];Object.assign(this.state,{count:0,index:-1,overflow:false,error:String(reason)});}}
  finally{if(!this.disposed&&version===this.version){this.state.busy=false;this.changed();}}
 }
 private highlight(){
  for(const range of this.ranges){let row=range.row,col=range.col,left=range.size;while(left>0){const width=Math.min(this.terminal.cols-col,left);let marker:Disposable|undefined;try{marker=this.terminal.registerMarker(row-this.terminal.buffer.active.baseY-this.terminal.buffer.active.cursorY);if(marker){this.decorations.push(marker);const decoration=this.terminal.registerDecoration({marker,x:col,width,backgroundColor:"#facc15",foregroundColor:"#171717",layer:"top"});if(decoration)this.decorations.push(decoration);else this.state.highlightUnavailable=true;}else this.state.highlightUnavailable=true;}catch{marker?.dispose();this.state.highlightUnavailable=true;}left-=width;row++;col=0;}}
 }
 async navigate(direction:number){
  if(this.disposed||this.state.busy||this.resultVersion!==this.version||!this.state.visible||!this.ranges.length||this.blocksProjection())return;
  const next=this.state.index<0?(direction<0?this.ranges.length-1:0):(this.state.index+(direction<0?-1:1)+this.ranges.length)%this.ranges.length;
  this.operating=true;
  try{
   const range=this.ranges[next];
   if(!this.state.regex){
    // The worker chooses the original-coordinate span. Seed a fresh addon with that span;
    // exact-case localization avoids the addon's expanding case-fold offsets and cached-history reset.
    this.terminal.select(range.col,range.row,range.size);
    const addon=this.addon();try{addon.findNext(this.terms[next],{regex:false,caseSensitive:true});}finally{addon.dispose();}
   }
   const selection=this.terminal.getSelectionPosition();
   if(!selection||selection.start.x!==range.col||selection.start.y!==range.row||(selection.end.y-selection.start.y)*this.terminal.cols+selection.end.x-selection.start.x!==range.size)this.terminal.select(range.col,range.row,range.size);
   const buffer=this.terminal.buffer.active;if(range.row<buffer.viewportY||range.row>=buffer.viewportY+this.terminal.rows)this.terminal.scrollToLine(Math.max(0,range.row-Math.floor(this.terminal.rows/2)));
   this.owned=this.terminal.getSelectionPosition();this.state.index=next;
   if(this.state.index>=0)this.anchor={...this.ranges[this.state.index]};
  }catch(reason){this.state.error=String(reason);}finally{this.operating=false;this.changed();}
 }
 close(){if(this.disposed)return;this.invalidate();this.clearOwned();this.state.visible=false;this.changed();}
 dispose(){if(this.disposed)return;this.invalidate();this.clearOwned();this.runner.dispose();this.selectionListener?.dispose();this.disposed=true;}
}
