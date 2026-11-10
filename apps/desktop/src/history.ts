import type {AgentReceipt,AgentState} from "./agent-events";
import {captureAttention} from "./attention-actions.ts";
import type {Project} from "./workspaces";
export type HistoryItem={previous_runs?:string[];summary:{session_id:string;cwd:string;title:string;adapter:string|null;mode:string|null};status:string;started_at:number;ended_at:number|null;agent:{phase:string;integration:string;unread_count:number}};
export type HistoryCursor={revision:string;offset:number;context:string};
export type HistoryPage<T>={revision:string;items:T[];next_cursor:HistoryCursor|null};
export type HistoryOverview={total:number;active:number;unread_receipts:number;failed_receipts:number;attention_sessions:number;metadata_bytes:number|null;latest_deletion?:DeletionResult|null};
export type InboxItem={session:HistoryItem;receipt:AgentReceipt;current?:boolean};
export type PendingKey={started_at:number;session_id:string};
export type HistoryCapacity={metadata_bytes:number;log_bytes:number;scene_bytes:number;backup_bytes:number;archive_bytes:number;other_bytes:number;scanned_entries:number;complete:boolean;issues:string[]};
export type HistoryPolicy={auto_archive_30_days:boolean;auto_delete:false};
export type DeletionPreview={preview_id:string;session_ids:string[];count:number;earliest_ended_at:number|null;latest_ended_at:number|null;bytes:number;scope:string};
export type DeletionResult={preview_id:string;deleted_ids:string[];complete:boolean;issues:string[]};
export function historyRequest(query:string,status:string,titles:Record<string,string>,projects:Project[],cursor:HistoryCursor|null=null){
 const needle=query.trim().toLowerCase();
 const request={page_size:100,cursor,query,status,matched_session_ids:needle?Object.entries(titles).filter(([,title])=>title.toLowerCase().includes(needle)).map(([id])=>id):[],matched_project_paths:needle?projects.filter(project=>project.name.toLowerCase().includes(needle)).map(project=>project.path):[]};
 if(new TextEncoder().encode(JSON.stringify(request)).length>1024*1024)throw Error("History search aliases exceed the 1 MiB request budget; narrow the search");
 return request;
}
export function capacityLevel(bytes:number){return bytes>=32*1024*1024?"protected":bytes>=24*1024*1024?"warning":"normal";}

// Presentation only: retain receipt identities and unread state across loaded pages.
export function groupInbox(items:readonly InboxItem[],selectedId:string|null=null,currentAgent?:AgentState){
 const sessions=new Map<string,Map<string,InboxItem>>();
 for(const item of items){
  if(item.receipt.read)continue;
  const id=item.session.summary.session_id,receipts=sessions.get(id)??new Map<string,InboxItem>();
  const previous=receipts.get(item.receipt.id);
  if(!previous||item.receipt.revision>previous.receipt.revision)receipts.set(item.receipt.id,item);
  sessions.set(id,receipts);
 }
 return [...sessions.values()].map(items=>{
  const ordered=[...items.values()].sort((a,b)=>b.receipt.revision-a.receipt.revision),session=ordered[0].session;
  const receipts=ordered.map(item=>item.receipt);
  const agent=session.summary.session_id===selectedId?currentAgent:undefined;
  const hasOwnerEvidence=ordered.some(item=>item.current!==undefined);
  const currentIds=new Set(ordered.filter(({receipt,current})=>
    (!hasOwnerEvidence||current===true)&&(agent?captureAttention(session,receipt,agent).state==='current':current===true))
    .map(({receipt})=>receipt.id));
  const current=receipts.find(entry=>currentIds.has(entry.id)&&(entry.kind==='needs_permission'||entry.kind==='failed'));
  const recent=receipts[0];
  const phase=current?.kind;
  const priority=phase==='needs_permission'?0:phase==='failed'||session.status==='failed'&&recent.kind==='failed'?1:2;
  return {session,unreadCount:Math.max(session.agent.unread_count,ordered.length),agent,priority,
    ownerCurrentIds:hasOwnerEvidence?currentIds:undefined,receipts:current?[current,...receipts.filter(entry=>entry!==current)]:receipts};
 }).sort((first,second)=>first.priority-second.priority);
}
