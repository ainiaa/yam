import type {AgentReceipt} from "./agent-events";
import type {Project} from "./workspaces";
export type HistoryItem={summary:{session_id:string;cwd:string;title:string;adapter:string|null;mode:string|null};status:string;started_at:number;ended_at:number|null;agent:{phase:string;integration:string;unread_count:number}};
export type HistoryCursor={revision:string;offset:number;context:string};
export type HistoryPage<T>={revision:string;items:T[];next_cursor:HistoryCursor|null};
export type HistoryOverview={total:number;active:number;unread_receipts:number;failed_receipts:number;attention_sessions:number;metadata_bytes:number|null;latest_deletion?:DeletionResult|null};
export type InboxItem={session:HistoryItem;receipt:AgentReceipt};
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
