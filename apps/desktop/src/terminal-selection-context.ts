// Author: Jeff.Liu. Capture a bounded excerpt for explicit delivery to the same native CLI.
import {reviewOrigin,reviewReady,sameReviewOrigin,type ReviewOrigin,type ReviewRecord} from './review-feedback.ts';
import {inspectTerminalPaste} from './terminal-paste.ts';

type SelectionRecord=Omit<ReviewRecord,'agent'|'summary'>&{
 summary:ReviewRecord['summary']&{launch?:{adapter:string;mode:string;codex?:{route?:unknown}|null}|null};
 agent?:ReviewRecord['agent']&{turn_id?:string|null;revision?:number;route_pending?:boolean};
};
export type TerminalSelectionOrigin=ReviewOrigin&{turnId:string|null;revision:number;managedCodex:boolean};

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
