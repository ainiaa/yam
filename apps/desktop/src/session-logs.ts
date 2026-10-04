export class LatestLogRequest {
 private revision = 0;
 cancel() { this.revision++; }
 async run<T>(load: () => Promise<T>): Promise<T | undefined> {
  const revision = ++this.revision;
  try {
   const value = await load();
   return revision === this.revision ? value : undefined;
  } catch (error) {
   if (revision === this.revision) throw error;
   return undefined;
  }
 }
}

export type LogHit = {session_id:string;cwd:string;offset:number;column:number;text:string};
export type LogSourceCursor={source_offset:number;snapshot?:string|null};
export type LogSearchPage = {hits:LogHit[];has_more:boolean;complete:boolean;issues:string[];next_cursor?:LogSourceCursor|null;current_cursor?:LogSourceCursor|null;scanned_ranges?:ScannedLogRange[]};

export type RetainedLogRange = {start_offset:string|null;end_offset_exclusive:string|null;retained_bytes:number|null;truncation:"complete"|"truncated"|"unknown"};
export type ScannedLogRange = {session_id:string;range:RetainedLogRange|null;line_scan_complete:boolean};
export type LogExportReceipt = {path:string;range:RetainedLogRange};
const MAX_LOG_BYTES=8*1024*1024;
function decimal(value:unknown):value is string {
 return typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
}
export function normalizeRetainedRange(value:unknown):RetainedLogRange {
 const v=value as Partial<RetainedLogRange>|null|undefined;
 const bytes=typeof v?.retained_bytes==='number'&&Number.isSafeInteger(v.retained_bytes)&&v.retained_bytes>=0&&v.retained_bytes<=MAX_LOG_BYTES?v.retained_bytes:null;
 const unknown:RetainedLogRange={start_offset:null,end_offset_exclusive:null,retained_bytes:bytes,truncation:'unknown'};
 if(!v||bytes===null)return unknown;
 if(v.truncation==='unknown')return unknown;
 if(!decimal(v.start_offset)||!decimal(v.end_offset_exclusive))return unknown;
 const start=BigInt(v.start_offset),end=BigInt(v.end_offset_exclusive);
 if(start>end||end-start!==BigInt(bytes)||v.truncation!==(start===0n?'complete':'truncated'))return unknown;
 return {start_offset:v.start_offset,end_offset_exclusive:v.end_offset_exclusive,retained_bytes:bytes,truncation:v.truncation};
}
export function formatRetainedRange(value:unknown):string {
 const range=normalizeRetainedRange(value);
 const count=range.retained_bytes===null?'retained byte count unknown':`${range.retained_bytes} retained bytes`;
 return range.truncation==='unknown'?`Absolute byte range unknown · ${count}`:`Bytes [${range.start_offset}, ${range.end_offset_exclusive}) · ${range.truncation} · ${count}`;
}
export function normalizeLogExport(value:unknown):LogExportReceipt|null {
 if(value===null)return null;
 if(typeof value==='string'&&value)return {path:value,range:normalizeRetainedRange(null)};
 const v=value as Partial<LogExportReceipt>|null;
 if(!v||typeof v.path!=='string'||!v.path)throw Error('Invalid log export receipt');
 return {path:v.path,range:normalizeRetainedRange(v.range)};
}
export function isSafeLogOffset(offset:unknown):offset is number {return typeof offset==='number'&&Number.isSafeInteger(offset)&&offset>=0;}
export function logHitPosition(hit:LogHit,ranges?:ScannedLogRange[]):string {
 if(!isSafeLogOffset(hit.offset))return 'Recorded position unknown; excerpt unavailable';
 const range=normalizeRetainedRange(ranges?.find(r=>r.session_id===hit.session_id)?.range);
 return `${range.truncation==='unknown'?'Retained-log position':'Output byte position'} ${hit.offset}`;
}
