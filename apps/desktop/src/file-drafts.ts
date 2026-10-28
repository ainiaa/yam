// Author: Jeff.Liu. Bounded local recovery copies; source files are never written here.
export const DRAFT_STORAGE_KEY='yam.projectFileDrafts.v1';
export type DraftStorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type StoredDraft={root:string;path:string;revision:string;draft:string;token:string};
const size=(text:string)=>new TextEncoder().encode(text).length;
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(v);
function valid(value:unknown):value is StoredDraft {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='draft,path,revision,root,token')return false;
 const v=value as StoredDraft;return typeof v.token==='string'&&/^[a-f0-9-]{36}$/.test(v.token)&&safe(v.root)&&v.root.startsWith('/')&&safe(v.path)&&!v.path.startsWith('/')&&v.path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='.git')&&typeof v.revision==='string'&&/^[a-f0-9]{64}$/.test(v.revision)&&typeof v.draft==='string'&&!v.draft.includes('\0')&&size(v.draft)<=1048576;
}
export class DraftStorage {
 private storage:DraftStorageLike;
 constructor(storage:DraftStorageLike){this.storage=storage;}
 private read():{raw:string|null;drafts:StoredDraft[]}{
  try{
   const raw=this.storage.getItem(DRAFT_STORAGE_KEY);if(raw===null)return {raw,drafts:[]};
   if(size(raw)>2097152)throw 'files_draft_storage';
   const value=JSON.parse(raw);
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='drafts,version'||value.version!==1||!Array.isArray(value.drafts)||value.drafts.length>16||!value.drafts.every(valid)||new Set(value.drafts.map((v:StoredDraft)=>JSON.stringify([v.root,v.path]))).size!==value.drafts.length)throw 'files_draft_storage';
   return {raw,drafts:value.drafts};
  }catch{throw 'files_draft_storage';}
 }
 get(root:string,path:string):StoredDraft|null{return this.read().drafts.find(v=>v.root===root&&v.path===path)??null;}
 list(root:string):StoredDraft[]{return this.read().drafts.filter(v=>v.root===root);}
 private publish(drafts:StoredDraft[],observed:string|null):void {
  const raw=JSON.stringify({version:1,drafts});if(drafts.length>16||size(raw)>2097152)throw 'files_draft_limit';
  // The editor is main-window only; detect changed recovery state before publishing.
  let current;try{current=this.storage.getItem(DRAFT_STORAGE_KEY);}catch{throw "files_draft_storage";}
  if(current!==observed)throw "files_draft_changed";
  try{if(drafts.length)this.storage.setItem(DRAFT_STORAGE_KEY,raw);else this.storage.removeItem(DRAFT_STORAGE_KEY);}catch{throw 'files_draft_storage';}
 }
 write(root:string,path:string,revision:string,draft:string,expectedToken:string|null=null):string {
  if(size(draft)>1048576)throw 'file_too_large';if(draft.includes('\0'))throw 'files_binary';
  const entry={root,path,revision,draft,token:crypto.randomUUID()};if(!valid(entry))throw 'files_draft_storage';
  const {raw,drafts}=this.read(),current=drafts.find(v=>v.root===root&&v.path===path);
  if(current?.draft===draft&&current.revision===revision)return current.token;
  if(current&&current.token!==expectedToken)throw 'files_draft_changed';
  this.publish([...drafts.filter(v=>v.root!==root||v.path!==path),entry],raw);return entry.token;
 }
 remove(root:string,path:string,expectedToken:string):boolean{
  const {raw,drafts}=this.read(),current=drafts.find(v=>v.root===root&&v.path===path);if(!current)return true;
  if(current.token!==expectedToken)return false;
  this.publish(drafts.filter(v=>v.root!==root||v.path!==path),raw);return true;
 }
 clear():void{try{this.storage.removeItem(DRAFT_STORAGE_KEY);}catch{throw 'files_draft_storage';}}
}
