// Author: Jeff.Liu. Terminal view construction defaults and teardown ordering.
export type TerminalViewConstruction={
 scrollback:number;lineHeight:number;cursor:Record<string,unknown>;appearance:Record<string,unknown>;
 linkHandler:{allowNonHttpProtocols:boolean;activate:(event:{preventDefault:()=>void})=>void};
};

export function terminalViewConstruction({scrollback,lineHeight,cursor,appearance,linkHandler}:TerminalViewConstruction){
 return {scrollback,linkHandler,allowProposedApi:true,convertEol:true,...cursor,lineHeight,...appearance};
}

export function disposeTerminalViewParts(parts:{release?:()=>void;clearMetadata:()=>void;disposeFind:()=>void;
 markDisposed:()=>void;clearAttachment:()=>void;finishReplay:()=>void;disposeData:()=>void;
 disposeScroll:()=>void;disposeTerminal:()=>void;removeElement:()=>void}):void{
 parts.release?.();parts.clearMetadata();parts.disposeFind();parts.markDisposed();parts.clearAttachment();
 parts.finishReplay();parts.disposeData();parts.disposeScroll();parts.disposeTerminal();parts.removeElement();
}

type ReplayView={replayVersion:number;ready:boolean;firstAttachment:boolean;disposed:boolean;
 finishReplay:(()=>void)|null;parsing:Promise<void>|null;
 instance:{write:(data:string,done:()=>void)=>void}};

export function beginTerminalReplay(view:ReplayView){
 const version=view.replayVersion=(view.replayVersion??0)+1;
 view.finishReplay?.();view.finishReplay=null;view.ready=false;
 return version;
}

export async function parseTerminalReplay(view:ReplayView,version:number,data:string,valid:()=>boolean,onReady:()=>void){
 const parsing=new Promise<void>(resolve=>{
  view.finishReplay=resolve;
  view.instance.write(data,()=>{
   if(valid()&&view.replayVersion===version&&!view.disposed){
    view.ready=true;view.firstAttachment=false;view.finishReplay=null;onReady();
   }
   resolve();
  });
 });
 view.parsing=parsing;
 await parsing;
 if(view.parsing===parsing)view.parsing=null;
}
