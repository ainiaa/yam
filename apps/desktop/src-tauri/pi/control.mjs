// Author: Jeff.Liu. This channel carries controls and public status, never conversation contents.
import {createServer} from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
export async function serveControls(path,generation,snapshot,control,catalog) {
 if(!path)return {publish(){},close:async()=>{}};
 if(!/^[a-f0-9]{64}$/.test(generation??''))throw Error('Invalid Pi control generation');
 const token=randomBytes(32).toString('hex');let port=0,connections=0;
 const publish=()=>{
  const temporary=`${path}.${randomBytes(6).toString('hex')}`;
  try{writeFileSync(temporary,JSON.stringify({v:1,port,token,state:snapshot()}),{flag:'wx',mode:0o600});renameSync(temporary,path);}
  catch(e){try{unlinkSync(temporary);}catch{}throw e;}
 };
 const server=createServer({allowHalfOpen:true},socket=>{
  if(++connections>4){connections--;socket.destroy();return;}
  let raw='';socket.setEncoding('utf8');socket.setTimeout(1500,()=>socket.destroy());socket.on('error',()=>{});socket.once('close',()=>connections--);
  socket.on('data',chunk=>{raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)socket.destroy();});
  socket.on('end',async()=>{
   try{
    const request=JSON.parse(raw);
    if(typeof request.token!=='string'||request.token.length!==token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(request.token))||request.generation!==generation)throw Error('Pi control authentication failed');
    if(Object.keys(request).some(k=>!['token','generation','revision','action','data'].includes(k)))throw Error('Invalid Pi control request');
    socket.setTimeout(20000,()=>socket.destroy());
    if(request.action==='catalog')socket.end(JSON.stringify({ok:true,state:snapshot(),models:catalog()}));
    else {await control(request);socket.end(JSON.stringify({ok:true,state:snapshot()}));}
   }catch(e){socket.end(JSON.stringify({ok:false,error:String(e.message).slice(0,1000)}));}
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 port=server.address().port;try{publish();}catch(e){server.close();throw e;}server.unref();
 return {publish,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();})};
}
