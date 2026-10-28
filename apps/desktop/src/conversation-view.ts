// Author: Jeff.Liu. Native history is a read-only projection, separate from terminal input.
export type ConversationItem={id:string;turn_id:string;kind:"user"|"agent"|"tool"|"file"|"unknown";text:string;paths:string[];truncated:boolean};
export type ConversationPage={query_token:string;session_id:string;thread_id:string;generation:string;read_at:number;direction:"asc"|"desc";items:ConversationItem[];next_cursor:string|null};
export type ConversationState={kind:"idle"}|{kind:"loading";value?:ConversationPage}|{kind:"ready";value:ConversationPage}|{kind:"unavailable";code:string;value?:ConversationPage};
export type ConversationInvoke=(name:string,args?:Record<string,unknown>)=>Promise<unknown>;
export function conversationRoundRevision(agent?:{generation?:string;agent_session_id:string|null;turn_id?:string|null;phase:string;integration:string;revision?:number}):number|null{
 const revision=agent?.revision;
 return agent?.generation&&agent.agent_session_id&&agent.turn_id&&agent.integration==="connected"&&["response_finished","needs_permission","needs_attention","interrupted","failed"].includes(agent.phase)&&typeof revision==="number"&&Number.isSafeInteger(revision)&&revision>0?revision:null;
}
const bytes=(s:string)=>new TextEncoder().encode(s).length;
const identifier=(s:unknown):s is string=>typeof s==="string"&&s.length>0&&bytes(s)<=256&&!/\p{Cc}/u.test(s);
export function isConversationPage(value:unknown,maxItems=50):value is ConversationPage {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as ConversationPage;
 if(Object.keys(v).sort().join(",")!=="direction,generation,items,next_cursor,query_token,read_at,session_id,thread_id"||typeof v.query_token!=="string"||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v.query_token)||![v.session_id,v.thread_id,v.generation].every(identifier)||!Number.isSafeInteger(v.read_at)||v.read_at<0||!["asc","desc"].includes(v.direction)||!(v.next_cursor===null||typeof v.next_cursor==="string"&&v.next_cursor.length>0&&bytes(v.next_cursor)<=8192)||!Array.isArray(v.items)||v.items.length>maxItems)return false;
 const seen=new Set<string>();
 return v.items.every(item=>{
  if(!item||typeof item!=="object"||Object.keys(item).sort().join(",")!=="id,kind,paths,text,truncated,turn_id"||![item.id,item.turn_id].every(identifier)||!["user","agent","tool","file","unknown"].includes(item.kind)||typeof item.text!=="string"||bytes(item.text)>65536||typeof item.truncated!=="boolean"||!Array.isArray(item.paths)||item.paths.length>256||!item.paths.every(p=>typeof p==="string"&&p.length>0&&bytes(p)<=4096&&!/\p{Cc}/u.test(p)))return false;
  const key=JSON.stringify([item.turn_id,item.id]);if(seen.has(key))return false;seen.add(key);return true;
 });
}
const errors=new Set(["conversation_unavailable","conversation_unsupported","conversation_identity_changed","conversation_storage_unavailable","conversation_busy","conversation_cancelled","conversation_invalid_request","conversation_invalid_cursor","conversation_invalid_response","conversation_response_too_large","conversation_timed_out","conversation_view_limit","conversation_history_gap"]);
type Load={epoch:number;invoke:ConversationInvoke;changed:()=>void;more:boolean;previous:ConversationPage|null;coalesced?:boolean;revision?:number};
export class ConversationController {
 snapshot:ConversationState={kind:"idle"};scope="";
 private session="";private thread="";private generation="";private epoch=0;private revision=0;private requestedRevision=0;
 private active:{token:string;invoke:ConversationInvoke;cancelled:boolean}|null=null;private pending:Load|null=null;
 private token:()=>string;
 constructor(token:()=>string=()=>crypto.randomUUID()){this.token=token;}
 select(scope:string,session:string,thread:string,generation:string,revision=0){if(this.scope===scope&&this.session===session&&this.thread===thread&&this.generation===generation)return;this.cancel();this.scope=scope;this.session=session;this.thread=thread;this.generation=generation;this.revision=Number.isSafeInteger(revision)&&revision>0?revision:0;this.requestedRevision=this.revision;this.snapshot={kind:"idle"};}
 cancel(){this.epoch++;this.pending=null;this.cancelActive();this.requestedRevision=this.revision;if(this.snapshot.kind==="loading"&&this.snapshot.value)this.snapshot={kind:"ready",value:this.snapshot.value};}
 private cancelActive(){if(this.active&&!this.active.cancelled){this.active.cancelled=true;void this.active.invoke("cancel_codex_conversation",{query_token:this.active.token}).catch(()=>{});}}
 async load(invoke:ConversationInvoke,changed:()=>void,more=false,revision=0){
  const observed=!more&&Number.isSafeInteger(revision)&&revision>0?revision:0;if(observed>this.requestedRevision)this.requestedRevision=observed;
  const previous=this.snapshot.kind!=="idle"?this.snapshot.value??null:null;
  if(more&&(!previous?.next_cursor||previous.items.length>=500))return;
  const load={epoch:++this.epoch,invoke,changed,more,previous,revision:observed};this.pending=null;this.cancelActive();this.snapshot={kind:"loading",...(previous?{value:previous}:{})};changed();
  if(this.active){this.pending=load;return;}await this.run(load);
 }
 async observe(invoke:ConversationInvoke,changed:()=>void,revision:number){
  if(!Number.isSafeInteger(revision)||revision<=Math.max(this.revision,this.requestedRevision))return;this.requestedRevision=revision;
  const load:Load={epoch:this.epoch,invoke,changed,more:false,previous:null,coalesced:true,revision};
  if(this.active){this.pending=load;return;}await this.run(load);
 }
 private async run(load:Load):Promise<void>{
  if(load.epoch!==this.epoch)return;
  if(load.coalesced){load.previous=this.snapshot.kind!=="idle"?this.snapshot.value??null:null;this.snapshot={kind:"loading",...(load.previous?{value:load.previous}:{})};load.changed();}
  const token=this.token(),active={token,invoke:load.invoke,cancelled:false};this.active=active;
  const args={session_id:this.session,query_token:token,cursor:load.more?load.previous!.next_cursor:null,limit:load.more?Math.min(50,500-load.previous!.items.length):50,direction:"desc"};
  try{
   const reply=await load.invoke("read_codex_conversation",args);if(load.epoch!==this.epoch)return;
   if(!isConversationPage(reply)||reply.query_token!==token||reply.session_id!==this.session||reply.thread_id!==this.thread||reply.generation!==this.generation||reply.direction!=="desc")throw "conversation_invalid_response";
   const fresh=[...reply.items].reverse(),previous=load.previous;
   const key=(item:ConversationItem)=>JSON.stringify([item.turn_id,item.id]);
   const known=new Set(previous?.items.map(key)),latest=new Set(fresh.map(key));
   if(!load.more&&previous?.items.length&&fresh.length&&reply.next_cursor&&!fresh.some(item=>known.has(key(item))))throw "conversation_history_gap";
   const items=load.more?fresh.filter(item=>!known.has(key(item))).concat(previous!.items):previous?previous.items.filter(item=>!latest.has(key(item))).concat(fresh):fresh;
   if(items.length>500)throw "conversation_view_limit";
   const merged={...reply,items,next_cursor:!load.more&&previous?.items.length?previous.next_cursor:reply.next_cursor};if(!isConversationPage(merged,500)||load.more&&reply.next_cursor===previous!.next_cursor)throw "conversation_invalid_response";
   this.revision=Math.max(this.revision,load.revision??0);
   this.snapshot={kind:"ready",value:merged};
  }catch(reason){if(load.epoch===this.epoch)this.snapshot={kind:"unavailable",code:typeof reason==="string"&&errors.has(reason)?reason:"conversation_unavailable",...(load.previous?{value:load.previous}:{})};}
  finally{if(this.active===active)this.active=null;if(load.epoch===this.epoch)load.changed();const pending=this.pending;this.pending=null;if(pending&&pending.epoch===this.epoch)await this.run(pending);else this.requestedRevision=this.revision;}
 }
}
