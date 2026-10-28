// Author: Jeff.Liu.
import {DraftStorage,type DraftStorageLike,type StoredDraft} from "./file-drafts.ts";
export type ProjectFileEntry={name:string;directory:boolean};
export type ProjectText={text:string;revision:string};
export type FileDraft=ProjectText&{draft:string;saving:boolean;error:string|null;conflict:boolean;recovered:boolean;recoveryToken:string|null};
const dirty=(doc:FileDraft)=>doc.recovered||doc.draft!==doc.text;
export type ProjectFileRequest={id:number;sessionId:string;path:string;line:number|null};
export type FilesInvoke=(name:string,args:Record<string,unknown>)=>Promise<unknown>;
const size=(text:string)=>new TextEncoder().encode(text).length;
const validText=(value:unknown):value is ProjectText=>{
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as ProjectText;return Object.keys(v).sort().join(",")==="revision,text"&&typeof v.text==="string"&&!v.text.includes("\0")&&size(v.text)<=1048576&&typeof v.revision==="string"&&/^[a-f0-9]{64}$/.test(v.revision);
};
const validName=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&!/[\/\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)&&![".","..",".git"].includes(value.toLowerCase());
const errors=new Set(["file_unavailable","file_invalid_path","file_outside_root","file_not_regular","file_too_large","file_invalid_utf8","file_changed","file_session_unavailable","file_platform_unavailable","files_binary","files_directory_too_large","files_save_failed","files_invalid_response","files_draft_storage","files_draft_limit","files_tabs_full","files_draft_changed"]);
const errorCode=(value:unknown)=>typeof value==="string"&&errors.has(value)?value:"file_unavailable";
export class ProjectFilesController {
 scope="";sessionId="";root="";directory="";entries:ProjectFileEntry[]=[];selected="";
 draftError:string|null=null;private cache:DraftStorage|null;private storageRequested:boolean;private checking=false;
 constructor(storage?:DraftStorageLike|null){this.cache=storage?new DraftStorage(storage):null;this.storageRequested=storage!==undefined;}
 loading=false;reading=false;error:string|null=null;
 private generation=0;private opening=0;private listing=0;private drafts=new Map<string,FileDraft>();
 select(sessionId:string,root:string):void {
  const scope=JSON.stringify([sessionId,root]);if(scope===this.scope)return;
  this.cancel();this.scope=scope;this.sessionId=sessionId;this.root=root;this.directory="";this.entries=[];this.selected=this.tabs.slice(-1)[0]?.path??"";this.error=null;
 }
 cancel():void {this.generation++;this.loading=false;this.reading=false;this.checking=false;}
 private key(path:string):string{return JSON.stringify([this.root,path]);}
 get document():FileDraft|undefined{return this.drafts.get(this.key(this.selected));}
 get tabs():{path:string;dirty:boolean;saving:boolean}[]{return [...this.drafts].filter(([key])=>JSON.parse(key)[0]===this.root).map(([key,doc])=>({path:JSON.parse(key)[1],dirty:dirty(doc),saving:doc.saving}));}
 get recoverable():StoredDraft[]{try{return this.cache?.list(this.root)??[];}catch{this.draftError="files_draft_storage";return [];}}
 private stored(path:string):StoredDraft|null{try{return this.cache?.get(this.root,path)??null;}catch{this.draftError="files_draft_storage";return null;}}
 private persist(root:string,path:string,doc:FileDraft):boolean {
  if(!this.cache){if(this.storageRequested)this.draftError="files_draft_storage";return false;}
  try{if(!dirty(doc)){if(doc.recoveryToken)this.cache.remove(root,path,doc.recoveryToken);doc.recoveryToken=null;}else doc.recoveryToken=this.cache.write(root,path,doc.revision,doc.draft,doc.recoveryToken);this.draftError=null;return true;}
  catch(reason){this.draftError=typeof reason==='string'&&errors.has(reason)?reason:"files_draft_storage";return false;}
 }
 close(path:string):boolean {
  const key=this.key(path),doc=this.drafts.get(key);if(!doc||doc.saving)return false;
  if(dirty(doc)&&!this.persist(this.root,path,doc)){this.draftError??="files_draft_storage";return false;}
  if(this.selected===path){this.opening++;this.reading=false;}this.drafts.delete(key);this.error=null;if(this.selected===path)this.selected=this.tabs.slice(-1)[0]?.path??"";return true;
 }
 clearStoredDrafts():void{try{if(!this.cache)throw "files_draft_storage";this.cache.clear();for(const doc of this.drafts.values())doc.recoveryToken=null;this.draftError=null;}catch{this.draftError="files_draft_storage";}}

 async browse(invoke:FilesInvoke,path:string):Promise<void>{
  const generation=this.generation,listing=++this.listing;if(this.directory!==path)this.entries=[];this.directory=path;this.loading=true;this.error=null;
  try{
   const value=await invoke("list_project_files",{session_id:this.sessionId,path});
   if(generation!==this.generation||listing!==this.listing)return;
   if(!Array.isArray(value)||value.length>2000||!value.every(v=>v&&typeof v==="object"&&Object.keys(v).sort().join(",")==="directory,name"&&validName(v.name)&&typeof v.directory==="boolean")||new Set(value.map(v=>v.name)).size!==value.length)throw "files_invalid_response";
   this.entries=value;
  }catch(reason){if(generation===this.generation&&listing===this.listing)this.error=errorCode(reason);}
  finally{if(generation===this.generation&&listing===this.listing)this.loading=false;}
 }
 async open(invoke:FilesInvoke,path:string,discard=false):Promise<void>{
  const key=this.key(path),cached=this.drafts.get(key);
  if(!cached&&this.drafts.size>=16){this.error="files_tabs_full";return;}
  const generation=this.generation,opening=++this.opening;this.selected=path;this.error=null;this.reading=false;
  if(cached&&(cached.saving||dirty(cached)&&!discard))return;
  const stored=discard?null:this.stored(path);this.reading=true;
  try{
   const value=await invoke("read_project_text",{session_id:this.sessionId,path});
   if(generation!==this.generation||opening!==this.opening)return;
   if(!validText(value))throw "files_invalid_response";
   const recovered=!!stored&&stored.draft!==value.text,conflict=recovered&&stored.revision!==value.revision;
   const doc:FileDraft={recoveryToken:discard?cached?.recoveryToken??null:stored?.token??null,text:value.text,revision:conflict?stored.revision:value.revision,draft:recovered?stored.draft:value.text,saving:false,error:conflict?"file_changed":null,conflict,recovered};
   this.drafts.set(key,doc);if(discard||stored&&!recovered)this.persist(this.root,path,doc);
  }catch(reason){if(generation===this.generation&&opening===this.opening){
   this.error=errorCode(reason);
   if(stored&&!cached)this.drafts.set(key,{recoveryToken:stored.token,text:"",revision:stored.revision,draft:stored.draft,saving:false,error:this.error,conflict:true,recovered:true});
  }}
  finally{if(generation===this.generation&&opening===this.opening)this.reading=false;}
 }
 edit(text:string):void {
  const doc=this.document;if(!doc||doc.saving||this.reading)return;
  const ending=doc.text.includes("\r\n")&&!doc.text.replace(/\r\n/g,"").includes("\n")?"\r\n":doc.text.includes("\r")&&!doc.text.includes("\n")?"\r":"\n";
  doc.draft=text.replace(/\r\n?/g,"\n").replace(/\n/g,ending);if(!doc.conflict&&doc.draft===doc.text)doc.recovered=false;doc.error=doc.conflict?"file_changed":null;this.persist(this.root,this.selected,doc);
 }
 async discard(invoke:FilesInvoke):Promise<void>{if(!this.document?.saving)await this.open(invoke,this.selected,true);}
 async checkDisk(invoke:FilesInvoke):Promise<void>{
  const doc=this.document;if(!doc||doc.saving||this.reading||this.checking)return;
  const generation=this.generation,path=this.selected,revision=doc.revision;this.checking=true;
  try{
   const value=await invoke("read_project_text",{session_id:this.sessionId,path});
   if(generation!==this.generation||this.document!==doc||doc.saving||doc.revision!==revision)return;
   if(!validText(value))throw "files_invalid_response";
   if(!dirty(doc)||doc.draft===value.text){doc.text=value.text;doc.draft=value.text;doc.revision=value.revision;doc.conflict=false;doc.recovered=false;doc.error=null;this.persist(this.root,path,doc);}
   else{if(doc.recovered)doc.text=value.text;doc.conflict=value.revision!==doc.revision;doc.error=doc.conflict?"file_changed":null;}
  }catch(reason){if(generation===this.generation&&this.document===doc&&!doc.saving&&doc.revision===revision){doc.error=errorCode(reason);doc.conflict=true;}}
  finally{if(generation===this.generation)this.checking=false;}
 }
 async save(invoke:FilesInvoke):Promise<void>{
  const doc=this.document;if(!doc||doc.saving||this.reading||!dirty(doc))return;
  if(doc.conflict){doc.error??="file_changed";return;}
  if(size(doc.draft)>1048576){doc.error="file_too_large";return;}
  if(doc.draft.includes("\0")){doc.error="files_binary";return;}
  const submitted=doc.draft,root=this.root,path=this.selected;doc.saving=true;doc.error=null;
  try{
   const value=await invoke("save_project_text",{session_id:this.sessionId,path:this.selected,revision:doc.revision,text:submitted});
   if(!validText(value)||value.text!==submitted)throw "files_invalid_response";
   doc.text=value.text;doc.revision=value.revision;doc.conflict=false;doc.recovered=false;this.persist(root,path,doc);
  }catch(reason){doc.error=errorCode(reason);if(doc.error==="file_changed")doc.conflict=true;}
  finally{doc.saving=false;}
 }
}

export function relativeProjectFile(root:string,absolute:string):string|null {
 const safe=(value:string)=>value.length>0&&value.length<=4096&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value);
 if(!safe(root)||!safe(absolute)||!root.startsWith('/')||!absolute.startsWith('/'))return null;
 const prefix=root.replace(/\/+$/,'')+'/',relative=absolute.startsWith(prefix)?absolute.slice(prefix.length):'';
 return relative&&relative.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git')?relative:null;
}
