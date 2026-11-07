// Author: Jeff.Liu. Checkpoints prove semantic prefixes; they never summarize or truncate history.
import {createHash} from 'node:crypto';
import {textOf} from './policy.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const imageFingerprint=image=>hash(image.mimeType+'\0'+image.data);
export const messageImages=messages=>messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='image'):[]);
export function handoffMessage(message){
 const blocks=Array.isArray(message.content)?message.content.filter(b=>b.type!=='thinking').map(b=>{
  if(b.type==='text')return {type:'text',text:b.text};
  if(b.type==='image')return {type:'image',mimeType:b.mimeType,fingerprint:imageFingerprint(b)};
  if(b.type==='toolCall')return {type:'toolCall',id:b.id,name:b.name,arguments:b.arguments};
  return b;
 }):[];
 const result=blocks.some(b=>b.type!=='text')?{role:message.role,content:blocks}:{role:message.role,text:textOf(message)};
 for(const key of ['toolCallId','toolName','isError'])if(message[key]!==undefined)result[key]=message[key];
 const images=messageImages([message]);if(images.length)result.images=images.map(imageFingerprint);
 if(['error','aborted'].includes(message.stopReason)){result.stopReason=message.stopReason;result.errorMessage=message.errorMessage;}
 return result;
}
export function handoffContext(messages,previous,systemPrompt=''){
 const history=messages.filter(m=>m.role!=='system'),semantic=history.map(handoffMessage),systemDigest=hash(systemPrompt??'');
 const matches=previous?.version===1&&Number.isInteger(previous.count)&&previous.count>=0&&previous.count<=history.length&&previous.digest===hash(stable(semantic.slice(0,previous.count)));
 return {messages:matches?history.slice(previous.count):history,mode:matches?'incremental':'full',systemChanged:Boolean(previous&&previous.systemDigest!==systemDigest),knownImageHashes:matches?[...new Set(semantic.slice(0,previous.count).flatMap(m=>m.images??[]))]:[],checkpoint:{version:1,count:history.length,digest:hash(stable(semantic)),systemDigest}};
}
