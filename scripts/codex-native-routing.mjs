// Author: Jeff.Liu. Keep the official TUI and App Server as the protocol owners.
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {chmod,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';

const maxRequest=8*1024*1024,maxHeader=32*1024,maxFragmentHeaders=64*1024;
// Match the native Codex remote client's receive limit for catalogs and history.
const maxResponse=128*1024*1024,maxRequestQueue=maxRequest*2,maxResponseQueue=maxResponse+maxRequestQueue;
class RelayProtocolError extends Error {}

function encode(text,masked){
 const data=Buffer.from(text),size=data.length;
 if(size>maxRequest)throw new RelayProtocolError('Codex protocol message exceeds relay limit');
 const length=size<126?0:size<=65535?2:8;
 const header=Buffer.alloc(2+length+(masked?4:0));
 header[0]=0x81;header[1]=(masked?128:0)|(length===0?size:length===2?126:127);
 if(length===2)header.writeUInt16BE(size,2);
 if(length===8)header.writeBigUInt64BE(BigInt(size),2);
 if(masked){const key=randomBytes(4);key.copy(header,2+length);for(let i=0;i<size;i++)data[i]^=key[i%4];}
 return Buffer.concat([header,data]);
}

function frames(masked,limit,onMessage,onControl){
 const header=Buffer.allocUnsafe(10),utf8=new TextDecoder('utf-8',{fatal:true});
 let headerSize=2,headerBytes=0,frame=null,frameBytes=0;
 let parts=[],original=[],messageBytes=0,fragmentHeaderBytes=0;
 return chunk=>{
  let position=0;
  while(position<chunk.length){
   if(!frame){
    const count=Math.min(headerSize-headerBytes,chunk.length-position);
    chunk.copy(header,headerBytes,position,position+count);position+=count;headerBytes+=count;
    if(headerBytes<headerSize)continue;
    const first=header[0],opcode=first&15,fin=!!(first&128),mask=!!(header[1]&128),marker=header[1]&127;
    if(first&0x70||mask!==masked||![0,1,8,9,10].includes(opcode))throw new RelayProtocolError('Unsupported Codex WebSocket frame');
    headerSize=marker===126?4:marker===127?10:2;
    if(headerBytes<headerSize)continue;
    const length=marker===127?Number(header.readBigUInt64BE(2)):marker===126?header.readUInt16BE(2):marker;
    if(length>limit)throw new RelayProtocolError('Oversized Codex frame');
    const payloadOffset=headerSize+(masked?4:0);
    if(opcode>=8){
     if(!fin||length>125)throw new RelayProtocolError('Invalid Codex frame size');
    }else{
     if((opcode===0)!==(original.length>0))throw new RelayProtocolError('Invalid Codex message fragments');
     messageBytes+=length;fragmentHeaderBytes+=payloadOffset;
     if(messageBytes>limit||fragmentHeaderBytes>maxFragmentHeaders)throw new RelayProtocolError('Oversized Codex message');
    }
    frame=Buffer.allocUnsafe(payloadOffset+length);
    header.copy(frame,0,0,headerSize);frameBytes=headerSize;
   }
   const count=Math.min(frame.length-frameBytes,chunk.length-position);
   chunk.copy(frame,frameBytes,position,position+count);position+=count;frameBytes+=count;
   if(frameBytes<frame.length)continue;
   const raw=frame,opcode=raw[0]&15,fin=!!(raw[0]&128),offset=headerSize+(masked?4:0);
   frame=null;headerBytes=0;headerSize=2;
   if(opcode>=8){onControl(raw);continue;}
   let data=raw.subarray(offset);
   if(masked){data=Buffer.from(data);for(let i=0;i<data.length;i++)data[i]^=raw[offset-4+i%4];}
   const text=utf8.decode(data,{stream:!fin});
   if(!fin){parts.push(text);original.push(raw);continue;}
   const message=parts.length?parts.concat(text).join(''):text,wire=original.length?Buffer.concat(original.concat(raw)):raw;
   parts=[];original=[];messageBytes=0;fragmentHeaderBytes=0;
   onMessage(message,wire);
  }
 };
}

function upgrade(masked,limit,write,onMessage){
 let header=Buffer.alloc(0),ready=false;
 const readFrames=frames(masked,limit,onMessage,write);
 return chunk=>{
  if(ready){readFrames(chunk);return;}
  header=Buffer.concat([header,chunk]);
  const index=header.indexOf('\r\n\r\n');
  if(index<0){if(header.length>maxHeader)throw new RelayProtocolError('Oversized Codex handshake');return;}
  if(index>maxHeader)throw new RelayProtocolError('Oversized Codex handshake');
  const head=header.subarray(0,index+4).toString('latin1');
  // No compression is negotiated: routing inspects complete UTF-8 JSON messages.
  if(masked)write(Buffer.from(head.replace(/^Sec-WebSocket-Extensions:[^\r\n]*\r\n/gim,''),'latin1'));
  else{
   write(header.subarray(0,index+4));
   if(!/^HTTP\/1\.[01] 101 /.test(head))throw new RelayProtocolError('Codex rejected the WebSocket handshake');
   if(/^Sec-WebSocket-Extensions:/im.test(head))throw new RelayProtocolError('Unexpected Codex WebSocket extension');
  }
  ready=true;const tail=header.subarray(index+4);header=Buffer.alloc(0);if(tail.length)readFrames(tail);
 };
}

export async function createNativeRelay({socketPath,backendPath,onRequest=async message=>message,onEvent=()=>{},filterEvent=()=>true,onError=console.error}){
 if(!isAbsolute(socketPath??'')||!isAbsolute(backendPath??'')||socketPath===backendPath)
  throw Error('Native Codex relay requires separate absolute Unix socket paths');
 backendPath=await realpath(backendPath);
 for(const path of [socketPath,backendPath]){
  const parent=await lstat(dirname(path));
  if(!parent.isDirectory()||(parent.mode&0o077)||parent.uid!==process.getuid())throw Error('Native Codex sockets require an owned private directory');
 }
 const backend=await lstat(backendPath);
 if(!backend.isSocket()||backend.uid!==process.getuid())throw Error('Native Codex backend socket is unavailable');
 const sockets=new Set();
 const server=net.createServer(client=>{
  const peer=net.connect(backendPath),controller=new AbortController();
  sockets.add(client);sockets.add(peer);
  const close=()=>{controller.abort(Error('Native Codex relay disconnected'));client.destroy();peer.destroy();sockets.delete(client);sockets.delete(peer);};
  const fail=(stage,error)=>{
   if(controller.signal.aborted)return;
   const reason=error instanceof RelayProtocolError?error.message:error instanceof SyntaxError?'invalid JSON':error instanceof TypeError?'unexpected data or callback type':'callback or transport error';
   try{onError(`Native Codex relay ${stage}: ${reason}`);}catch{}
   close();
  };
  const write=(to,from,limit)=>bytes=>{
   if(to.destroyed)return;
   if(to.writableLength+bytes.length>limit)throw new RelayProtocolError('Codex relay output queue exceeded');
   if(!to.write(bytes)){from.pause();to.once('drain',()=>from.resume());}
  };
  const upstream=write(peer,client,maxRequestQueue),downstream=write(client,peer,maxResponseQueue);
  let eventsPending=Promise.resolve(),queued=0,eventBytes=0;
  const respond=message=>downstream(encode(JSON.stringify(message),false));
  const internalPrefix='yam-relay-'+randomBytes(16).toString('hex')+'-',internal=new Map();let sequence=0;
  const requestBackend=(method,params,{signal}={})=>{
   const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000),...signal?[signal]:[]]);
   requestSignal.throwIfAborted();
   const id=internalPrefix+(++sequence);
   return new Promise((resolve,reject)=>{
    const finish=(callback,value)=>{internal.delete(id);requestSignal.removeEventListener('abort',cancel);callback(value);};
    const cancel=()=>finish(reject,requestSignal.reason);
    requestSignal.addEventListener('abort',cancel,{once:true});
    internal.set(id,message=>message.error?finish(reject,Error('Codex App Server rejected '+method)):finish(resolve,message.result));
    try{upstream(encode(JSON.stringify({id,method,params}),true));}catch(error){finish(reject,error);}
   });
  };
  const requests=upgrade(true,maxRequest,upstream,(text,wire)=>{
   const message=JSON.parse(text);queued+=wire.length;
   if(queued>maxRequestQueue)throw new RelayProtocolError('Codex relay request queue exceeded');
   void (async()=>{
    if(controller.signal.aborted)return;
    const next=await onRequest(message,{signal:controller.signal,respond,requestBackend});
    if(controller.signal.aborted)return;
    if(next===null)return;
    upstream(next===message?wire:encode(JSON.stringify(next),true));
   })().catch(error=>{
    if(message.id===undefined){fail('client notification',error);return;}
    respond({id:message.id,error:{code:-32000,message:String(error.message??'Routing unavailable').replace(/[\p{Cc}]/gu,' ').slice(0,1024)}});
   }).finally(()=>{queued-=wire.length;}).catch(error=>fail('client reply',error));
  });
  const events=upgrade(false,maxResponse,downstream,(text,wire)=>{
   const message=JSON.parse(text);
   if(!message.method&&typeof message.id==='string'&&message.id.startsWith(internalPrefix)){internal.get(message.id)?.(message);return;}
   if(!filterEvent(message))return;
   eventBytes+=wire.length;
   if(eventBytes>maxResponseQueue)throw new RelayProtocolError('Codex relay event queue exceeded');
   eventsPending=eventsPending.then(async()=>{if(controller.signal.aborted)return;await onEvent(message);downstream(wire);}).finally(()=>{eventBytes-=wire.length;}).catch(error=>fail('App Server event',error));
  });
  client.on('data',chunk=>{try{requests(chunk);}catch(error){fail('client message',error);}});
  peer.on('data',chunk=>{try{events(chunk);}catch(error){fail('App Server message',error);}});
  client.on('error',error=>fail('client socket',error));peer.on('error',error=>fail('App Server socket',error));
  for(const socket of [client,peer])socket.on('close',close);
 });
 server.listen(socketPath);
 try{await once(server,'listening');await chmod(socketPath,0o600);}catch(error){server.close();throw error;}
 return {socketPath,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
