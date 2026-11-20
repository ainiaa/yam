// Author: Jeff.Liu. The background owner, outside the terminal tree, owns accepted grants.
import {createServer,connect} from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
const local=value=>typeof value==='string'&&/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)&&Number(value.split(':')[1])<=65535;
const token=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const error=()=>Object.assign(Error('YAM authentication owner is unavailable; fully quit and reopen the updated App.'),{code:'YAM_AUTH_OWNER'});
const frame=value=>{const body=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);};
function exchange(address,request,{signal,framed=false,timeoutMs=650000}={}){
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();const socket=connect({host:'127.0.0.1',port:Number(address.split(':')[1])});let bytes=Buffer.alloc(0),settled=false;
  const finish=(e,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);socket.destroy();e?reject(e):resolve(value);};
  const cancel=()=>finish(signal.reason);signal?.addEventListener('abort',cancel,{once:true});
  socket.setTimeout(timeoutMs,()=>finish(error()));socket.on('error',()=>finish(error()));socket.on('end',()=>{if(!settled)finish(error());});
  socket.on('connect',()=>socket.write(framed?frame(request):JSON.stringify(request)+'\n'));
  socket.on('data',chunk=>{
   bytes=Buffer.concat([bytes,chunk]);if(bytes.length>65540)return finish(error());
   let body;if(framed){if(bytes.length<4)return;const n=bytes.readUInt32BE();if(n<1||n>65536)return finish(error());if(bytes.length<4+n)return;body=bytes.subarray(4,4+n);}else{const i=bytes.indexOf(10);if(i<0)return;body=bytes.subarray(0,i);}
   try{finish(null,JSON.parse(body));}catch{finish(error());}
  });
 });
}
export async function ownerAuthentication(env,operation,signal){
 const f=await open(env.YAM_OMP_AUTH_OWNER_DESCRIPTOR,constants.O_RDONLY|constants.O_NOFOLLOW);
 let d;try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.uid!==process.getuid()||s.size>4096)throw error();d=JSON.parse(await f.readFile('utf8'));}finally{await f.close();}
 if(d.version!==2||!local(d.address)||!token(d.token)||!token(d.instance)||!['read','login'].includes(operation)||!/^s-[a-zA-Z0-9-]+$/.test(env.YAM_OMP_TERMINAL??'')||!/^[-a-zA-Z0-9]{1,256}$/.test(env.YAM_OMP_GENERATION??''))throw error();
 const client=randomBytes(32).toString('hex'),id=1;
 const reply=await exchange(d.address,{version:2,instance:d.instance,token:d.token,client,id,command:'start_omp_auth',args:{session_id:env.YAM_OMP_TERMINAL,generation:env.YAM_OMP_GENERATION}},{signal,framed:true,timeoutMs:10000});
 const job=reply.result?.Ok;
 if(reply.version!==2||reply.instance!==d.instance||reply.client!==client||reply.id!==id||!local(job?.address)||!token(job?.token))throw error();
 const response=await exchange(job.address,{token:job.token,operation},{signal});
 if(response.error)throw Object.assign(Error(response.error.message),{code:response.error.code});
 if(!response.result)throw error();return response.result;
}
export async function serveAuthentication(auth,{onAuth,idleMs=15000,onReady=info=>process.stdout.write(JSON.stringify(info)+'\n')}={}){
 const secret=randomBytes(32).toString('hex'),pending=new Set();let claimed=false,finished;const operationDone=new Promise(r=>finished=r);
 const server=createServer(socket=>{
  let bytes=Buffer.alloc(0);const cancel=new AbortController(),deadline=setTimeout(()=>socket.destroy(),2000);pending.add(socket);socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(deadline);pending.delete(socket);cancel.abort();});
  socket.on('data',async chunk=>{
   if(claimed)return socket.destroy();bytes=Buffer.concat([bytes,chunk]);if(bytes.length>1024)return socket.destroy();const i=bytes.indexOf(10);if(i<0)return;
   let q;try{q=JSON.parse(bytes.subarray(0,i));}catch{return socket.destroy();}
   if(!q||typeof q!=='object'||Array.isArray(q)||!token(q.token)||!timingSafeEqual(Buffer.from(q.token),Buffer.from(secret))||!['read','login'].includes(q.operation))return socket.destroy();
   claimed=true;clearTimeout(idle);clearTimeout(deadline);pending.delete(socket);for(const peer of pending)peer.destroy();server.close();
   try{const result=await auth[q.operation]({signal:cancel.signal,onAuth});if(!socket.destroyed)socket.end(JSON.stringify({result})+'\n');}
   catch(e){if(!socket.destroyed)socket.end(JSON.stringify({error:{code:e.code?.startsWith('YAM_')?e.code:'YAM_AUTH_FAILED',message:e.code?.startsWith('YAM_')?e.message:'YAM ChatGPT authorization could not finish; check authorization and the system proxy.'}})+'\n');}
   finally{finished();}
  });
 });
 const idle=setTimeout(()=>{for(const socket of pending)socket.destroy();server.close();},idleMs);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 onReady({address:'127.0.0.1:'+server.address().port,token:secret});
 await new Promise(resolve=>server.once('close',resolve));if(claimed)await operationDone;
}
