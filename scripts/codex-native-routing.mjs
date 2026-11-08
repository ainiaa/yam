// Author: Jeff.Liu. Keep the official TUI and App Server as the protocol owners.
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {chmod,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';

const maxMessage=8*1024*1024,maxHeader=32*1024;
const utf8=new TextDecoder('utf-8',{fatal:true});

function encode(text,masked){
 const data=Buffer.from(text),size=data.length;
 if(size>maxMessage)throw Error('Codex protocol message exceeds relay limit');
 const length=size<126?0:size<=65535?2:8;
 const header=Buffer.alloc(2+length+(masked?4:0));
 header[0]=0x81;header[1]=(masked?128:0)|(length===0?size:length===2?126:127);
 if(length===2)header.writeUInt16BE(size,2);
 if(length===8)header.writeBigUInt64BE(BigInt(size),2);
 if(masked){const key=randomBytes(4);key.copy(header,2+length);for(let i=0;i<size;i++)data[i]^=key[i%4];}
 return Buffer.concat([header,data]);
}

function frames(masked,onMessage,onControl){
 let buffer=Buffer.alloc(0),parts=[],original=[],total=0,fragmented=false;
 return chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=2){
   const first=buffer[0],opcode=first&15,fin=!!(first&128),mask=!!(buffer[1]&128);
   let length=buffer[1]&127,offset=2;
   if(first&0x70||mask!==masked||![0,1,8,9,10].includes(opcode))throw Error('Unsupported Codex WebSocket frame');
   if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}
   else if(length===127){if(buffer.length<10)return;const value=buffer.readBigUInt64BE(2);if(value>BigInt(maxMessage))throw Error('Oversized Codex frame');length=Number(value);offset=10;}
   if(length>maxMessage||opcode>=8&&(!fin||length>125))throw Error('Invalid Codex frame size');
   const end=offset+(mask?4:0)+length;
   if(buffer.length<end)return;
   const raw=buffer.subarray(0,end);buffer=buffer.subarray(end);
   if(opcode>=8){onControl(raw);continue;}
   if(opcode===0&&!fragmented||opcode===1&&fragmented)throw Error('Invalid Codex message fragments');
   const key=raw.subarray(offset,offset+4),data=Buffer.from(raw.subarray(offset+(mask?4:0)));
   if(mask)for(let i=0;i<data.length;i++)data[i]^=key[i%4];
   total+=data.length;if(total>maxMessage)throw Error('Oversized Codex message');
   parts.push(data);original.push(raw);fragmented=!fin;
   if(fin){const text=utf8.decode(Buffer.concat(parts)),wire=Buffer.concat(original);parts=[];original=[];total=0;onMessage(text,wire);}
  }
  if(buffer.length>maxMessage+14)throw Error('Codex frame buffer exceeded');
 };
}

function upgrade(masked,write,onMessage){
 let header=Buffer.alloc(0),ready=false;
 const readFrames=frames(masked,onMessage,write);
 return chunk=>{
  if(ready){readFrames(chunk);return;}
  header=Buffer.concat([header,chunk]);
  const index=header.indexOf('\r\n\r\n');
  if(index<0){if(header.length>maxHeader)throw Error('Oversized Codex handshake');return;}
  if(index>maxHeader)throw Error('Oversized Codex handshake');
  const head=header.subarray(0,index+4).toString('latin1');
  // No compression is negotiated: routing inspects complete UTF-8 JSON messages.
  if(masked)write(Buffer.from(head.replace(/^Sec-WebSocket-Extensions:[^\r\n]*\r\n/gim,''),'latin1'));
  else{
   write(header.subarray(0,index+4));
   if(!/^HTTP\/1\.[01] 101 /.test(head))throw Error('Codex rejected the WebSocket handshake');
   if(/^Sec-WebSocket-Extensions:/im.test(head))throw Error('Unexpected Codex WebSocket extension');
  }
  ready=true;const tail=header.subarray(index+4);header=Buffer.alloc(0);if(tail.length)readFrames(tail);
 };
}

export async function createNativeRelay({socketPath,backendPath,onRequest=async message=>message,onEvent=()=>{},filterEvent=()=>true}){
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
  const write=(to,from)=>bytes=>{
   if(to.destroyed)return;
   if(to.writableLength+bytes.length>maxMessage*2)throw Error('Codex relay output queue exceeded');
   if(!to.write(bytes)){from.pause();to.once('drain',()=>from.resume());}
  };
  const upstream=write(peer,client),downstream=write(client,peer);
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
  const requests=upgrade(true,upstream,(text,wire)=>{
   const message=JSON.parse(text);queued+=wire.length;
   if(queued>maxMessage*2)throw Error('Codex relay request queue exceeded');
   void (async()=>{
    if(controller.signal.aborted)return;
    const next=await onRequest(message,{signal:controller.signal,respond,requestBackend});
    if(controller.signal.aborted)return;
    if(next===null)return;
    upstream(next===message?wire:encode(JSON.stringify(next),true));
   })().catch(error=>{
    if(message.id===undefined){close();return;}
    respond({id:message.id,error:{code:-32000,message:String(error.message??'Routing unavailable').replace(/[\p{Cc}]/gu,' ').slice(0,1024)}});
   }).finally(()=>{queued-=wire.length;}).catch(close);
  });
  const events=upgrade(false,downstream,(text,wire)=>{
   const message=JSON.parse(text);
   if(!message.method&&typeof message.id==='string'&&message.id.startsWith(internalPrefix)){internal.get(message.id)?.(message);return;}
   if(!filterEvent(message))return;
   eventBytes+=wire.length;
   if(eventBytes>maxMessage*2)throw Error('Codex relay event queue exceeded');
   eventsPending=eventsPending.then(async()=>{if(controller.signal.aborted)return;await onEvent(message);downstream(wire);}).finally(()=>{eventBytes-=wire.length;}).catch(close);
  });
  client.on('data',chunk=>{try{requests(chunk);}catch{close();}});
  peer.on('data',chunk=>{try{events(chunk);}catch{close();}});
  for(const socket of [client,peer]){socket.on('error',close);socket.on('close',close);}
 });
 server.listen(socketPath);
 try{await once(server,'listening');await chmod(socketPath,0o600);}catch(error){server.close();throw error;}
 return {socketPath,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
