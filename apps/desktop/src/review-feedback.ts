// Author: Jeff.Liu. Use native CLI input; never send an Enter key or start a process.
import {inspectTerminalPaste} from './terminal-paste.ts';
import {relativeProjectFile} from './project-files.ts';
export type ReviewOrigin={sessionId:string;cwd:string;generation:string;nativeSessionId:string};
export type ReviewLocation={sessionId:string;path:string;line:number|null;side:'old'|'new';basis:'staged'|'worktree'|'round'};
export type ReviewRecord={summary:{session_id:string;cwd:string;ssh?:unknown;launch?:{adapter:string;mode:string}|null};status:string;agent?:{generation?:string;agent_session_id:string|null;integration:string;phase:string}};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
export function reviewOrigin(record?:ReviewRecord|null):ReviewOrigin|null {
 const summary=record?.summary,agent=record?.agent;
 if(!summary||summary.ssh!=null||!['codex','claude','gemini','opencode','pi'].includes(summary.launch?.adapter??'')||summary.launch?.mode!=='interactive'||!id(summary.session_id)||!id(agent?.generation)||!id(agent?.agent_session_id)||typeof summary.cwd!=='string'||!summary.cwd.startsWith('/')||/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(summary.cwd)||summary.cwd.length>4096)return null;
 return{sessionId:summary.session_id,cwd:summary.cwd,generation:agent.generation,nativeSessionId:agent.agent_session_id};
}
export function sameReviewOrigin(a:ReviewOrigin|null,b:ReviewOrigin|null):boolean{return !!a&&!!b&&a.sessionId===b.sessionId&&a.cwd===b.cwd&&a.generation===b.generation&&a.nativeSessionId===b.nativeSessionId;}
export function reviewReady(record:ReviewRecord|null|undefined,origin:ReviewOrigin|null):boolean{return !!record&&sameReviewOrigin(reviewOrigin(record),origin)&&record.status==='running'&&record.agent?.integration==='connected'&&['idle','response_finished'].includes(record.agent.phase);}
export function formatReviewFeedback(origin:ReviewOrigin,location:ReviewLocation,text:string):string {
 if(location.sessionId!==origin.sessionId||relativeProjectFile(origin.cwd,`${origin.cwd.replace(/\/+$/,'')}/${location.path}`)!==location.path||!['old','new'].includes(location.side)||!['staged','worktree','round'].includes(location.basis)||location.line!==null&&(!Number.isSafeInteger(location.line)||location.line<1||location.line>1048576)||typeof text!=='string')throw 'review_invalid_feedback';
 const body=text.replace(/\r\n?/g,'\n').trim();
 if(!body||new TextEncoder().encode(body).length>16384||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body))throw 'review_invalid_feedback';
 const formatted=`Code review feedback (file location is snapshot context):\nPath: ${JSON.stringify(location.path)}\nComparison: ${location.basis}\n${location.side}-side line: ${location.line??'file-level'}\nComment:\n${body}`;
 try{return inspectTerminalPaste(formatted).text;}catch{throw 'review_invalid_feedback';}
}
export async function deliverReviewFeedback(origin:ReviewOrigin,location:ReviewLocation,text:string,current:()=>Promise<ReviewRecord>,paste:(text:string)=>Promise<void>):Promise<void>{
 const formatted=formatReviewFeedback(origin,location,text);let record:ReviewRecord;
 try{record=await current();}catch{throw 'review_target_unavailable';}
 if(!reviewReady(record,origin))throw 'review_target_unavailable';await paste(formatted);
}

export type ReviewComment={location:ReviewLocation;text:string};
export function combineReviewComments(origin:ReviewOrigin,comments:ReviewComment[]):string {
 if(!Array.isArray(comments)||comments.length<1||comments.length>20)throw 'review_invalid_feedback';
 const body=comments.map(item=>formatReviewFeedback(origin,item.location,item.text)).join('\n\n');
 // Validate the aggregate through the same bounded terminal-input path as a single comment.
 formatReviewFeedback(origin,comments[0].location,body);return body;
}
