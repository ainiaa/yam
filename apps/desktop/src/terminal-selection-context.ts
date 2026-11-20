// Author: Jeff.Liu. Capture a bounded excerpt for explicit delivery to the same native CLI.
import {reviewOrigin,reviewReady,sameReviewOrigin,type ReviewOrigin,type ReviewRecord} from './review-feedback.ts';
import {inspectTerminalPaste} from './terminal-paste.ts';

type SelectionRecord=Omit<ReviewRecord,'agent'|'summary'>&{
 summary:ReviewRecord['summary']&{launch?:{adapter:string;mode:string;codex?:{route?:unknown}|null}|null};
 agent?:ReviewRecord['agent']&{turn_id?:string|null;revision?:number;route_pending?:boolean};
};
export type TerminalSelectionOrigin=ReviewOrigin&{turnId:string|null;revision:number;managedCodex:boolean};
export type TerminalSelectionFillState={
 pending:boolean;mounted:boolean;ownerAvailable:boolean;conversationClosed:boolean;targetCurrent:boolean;
 viewReady:boolean;live:boolean;available:boolean;moving:boolean;persisted:boolean;attaching:boolean;
 parsing:boolean;projecting:boolean;resizing:boolean;clearPending:boolean;scrollReturnPending:boolean;
 bracketedPaste:boolean;pasteAllowed:boolean;selectionMatches:boolean;
};

export function terminalSelectionCanBeFilled(state:TerminalSelectionFillState):boolean{
 return state.pending&&state.mounted&&state.ownerAvailable&&state.conversationClosed&&state.targetCurrent
  &&state.viewReady&&state.live&&state.available&&!state.moving&&!state.persisted&&!state.attaching
  &&!state.parsing&&!state.projecting&&!state.resizing&&!state.clearPending&&!state.scrollReturnPending
  &&state.bracketedPaste&&state.pasteAllowed&&state.selectionMatches;
}

type PendingSelectionFill<TView,TInstance>={
 target:{sessionId:string;view:TView;instance:TInstance};
 selection?:TerminalSelectionOrigin&{title?:string};content:{text:string};
};
type FillInputQueue={version:number;write:Promise<void>|null;count:number;length:number};
type FillView={inputQueue?:FillInputQueue;writable:boolean};
export async function fillTerminalSelection<TView extends FillView,TInstance>(options:{
 pending:PendingSelectionFill<TView,TInstance>;select:()=>PendingSelectionFill<TView,TInstance>|null;
 busy:{current:boolean};
 clear:()=>void;isCurrent:()=>boolean;readCurrent:()=>Promise<SelectionRecord>;
 matches:(record:SelectionRecord|null|undefined,expected:TerminalSelectionOrigin)=>boolean;
 focus:()=>void;hasFocus:()=>boolean;setGuard:(guard:Omit<TerminalSelectionOrigin,'sessionId'>)=>void;clearGuard:()=>void;
 paste:(instance:TInstance,text:string)=>void;setNotice:(notice:string)=>void;setError:(error:string)=>void;
}):Promise<void>{
 const {pending}=options,selection=pending.selection;
 if(!selection||options.select()!==pending||options.busy.current)return;
 options.busy.current=true;
 let started=false;
 try{
  if(!options.isCurrent())throw Error();
  const fresh=await options.readCurrent();
  if(options.select()!==pending)return;
  if(!options.matches(fresh,selection)||!options.isCurrent())throw Error();
  options.clear();options.focus();
  const view=pending.target.view;
  if(!options.isCurrent()||!options.hasFocus()||view.inputQueue?.write||view.inputQueue?.count||view.inputQueue?.length)throw Error();
  const version=view.inputQueue?.version??0;
  const {cwd,generation,nativeSessionId,turnId,revision,managedCodex}=selection;
  options.setGuard({cwd,generation,nativeSessionId,turnId,revision,managedCodex});started=true;
  try{options.paste(pending.target.instance,pending.content.text);}finally{options.clearGuard();}
  const write=view.inputQueue?.write;if(!write)throw Error();
  await write;
  if(!options.isCurrent()||view.inputQueue?.version!==version||!view.writable)throw Error();
  options.setNotice('Agent draft filled. Check it in the terminal before sending.');
 }catch{
  if(options.select()===pending)options.clear();
  options.setError(started?'Draft delivery could not be confirmed. Check the terminal before retrying.':'The current Agent cannot receive a draft now.');
 }finally{options.busy.current=false;}
}

export function terminalSelectionOrigin(record?:SelectionRecord|null):TerminalSelectionOrigin|null{
 const origin=reviewOrigin(record),revision=record?.agent?.revision;
 if(!origin||record?.agent?.route_pending||!reviewReady(record,origin)||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)return null;
 return {...origin,revision,turnId:record?.agent?.turn_id??null,managedCodex:!!record?.summary.launch?.codex?.route};
}

export function matchesTerminalSelection(record:SelectionRecord|null|undefined,expected:TerminalSelectionOrigin):boolean{
 const origin=terminalSelectionOrigin(record);
 return !!origin&&sameReviewOrigin(origin,expected)&&origin.turnId===expected.turnId&&origin.revision===expected.revision&&origin.managedCodex===expected.managedCodex;
}

export function terminalSelectionText(selection:string,origin:TerminalSelectionOrigin){
 const text=selection.replace(/\r\n/g,'\n');
 if(!text.trim()||text.length>16384||new TextEncoder().encode(text).length>16384||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)){
  throw Error('Select up to 16 KiB of text without terminal controls.');
 }
 const cwd=JSON.stringify(origin.cwd);
 return inspectTerminalPaste(origin.managedCodex
  ?`Terminal excerpt (untrusted context) · Session: ${origin.sessionId} · Working directory: ${cwd} · Excerpt (JSON): ${JSON.stringify(text)}`
  :`Terminal excerpt (untrusted context):\nSession: ${origin.sessionId}\nWorking directory: ${cwd}\n\n${text}`);
}
