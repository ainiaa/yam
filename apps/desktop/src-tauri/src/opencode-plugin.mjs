// Author: Jeff.Liu. Injected only into a YAM-owned OpenCode launch.
import net from 'node:net';

export default async function Plugin({client}) {
 const address=/^127\.0\.0\.1:([0-9]+)$/.exec(process.env.YAM_AGENT_ADDRESS??'');
 const token=process.env.YAM_AGENT_TOKEN;
 if(!address||Number(address[1])<1||Number(address[1])>65535||!/^([a-f0-9]{64})$/.test(token??''))throw Error('Invalid YAM integration credentials');
 let main=null,active=null,chain=Promise.resolve(),retry=null,delivery=null,halted=false,reported=false,queued=0;
 const pending=[];
 function send(kind,turn,permission_key){
  if(pending.length>=128){halted=true;throw Error('YAM pending event capacity reached');}
  pending.push({kind,agent_session_id:main,turn_id:turn??null,source:'opencode',...(permission_key?{permission_key}:{})});
 }
 async function flush(){
  while(pending.length){
   for(let attempt=0;;attempt++){
    try{await sendOnce(pending[0]);break;}catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,50));}
   }
   pending.shift();
  }
  if(halted&&!reported&&active){
   await sendOnce({kind:'IntegrationUnavailable',agent_session_id:main,turn_id:active.id,source:'opencode'});reported=true;
  }
  if(retry){clearTimeout(retry);retry=null;}
 }
 function degraded(){
  if(!retry)console.error('[YAM] OpenCode integration degraded; pending native events will retry');
  if((pending.length||halted&&!reported)&&!retry){retry=setTimeout(()=>{retry=null;void ordered(()=>{});},2000);retry.unref?.();}
 }
 function deliver(){
  if(!delivery)delivery=flush().catch(degraded).finally(()=>{delivery=null;});
  return delivery;
 }
 function sendOnce(event){
  const wire=JSON.stringify({version:1,token,event});
  if(Buffer.byteLength(wire)>4096)return Promise.reject(Error('YAM event too large'));
  return new Promise((resolve,reject)=>{
   const socket=net.createConnection({host:'127.0.0.1',port:Number(address[1])});let reply='',done=false;
   const finish=error=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve();};
   socket.setTimeout(500,()=>finish(Error('YAM event timeout')));
   socket.on('connect',()=>socket.write(wire+'\n'));socket.on('error',finish);
   socket.on('data',bytes=>{reply+=bytes;if(Buffer.byteLength(reply)>128)finish(Error('Invalid YAM acknowledgement'));});
   socket.on('end',()=>{try{if(JSON.parse(reply).accepted!==true)throw Error('YAM event not committed');finish();}catch(error){finish(error);}});
  });
 }
 function ordered(operation){
  if(halted)return deliver();
  // ponytail: retain at most 128 native callbacks; overflow requires a new YAM process.
  if(queued>=128){halted=true;console.error('[YAM] OpenCode native callback capacity reached');return deliver();}
  queued++;
  // Keep native event processing independent of a slow/disconnected notification receiver.
  chain=chain.then(()=>{if(!halted)return operation();}).catch(degraded).finally(()=>{queued--;});
  return chain.then(deliver);
 }
 return {
  'chat.message':(input,output)=>ordered(async()=>{
   const id=output.message?.id;
   if(output.message?.role!=='user'||!/^msg_[a-zA-Z0-9]+$/.test(id??''))return;
   const controller=new AbortController();let timer,response;
   try{
    response=await Promise.race([
     client.session.get({path:{id:input.sessionID},signal:controller.signal}),
     new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('YAM native session lookup timed out'));},1000);}),
    ]);
    if(!response?.data||response.data.id!==input.sessionID)throw Error('Invalid OpenCode native session identity');
   }catch(error){if(main&&active)halted=true;throw error;}
   finally{clearTimeout(timer);}
   if(response.data.parentID)return;
   if(main&&main!==input.sessionID){
    // One YAM process is bound to one verified root. /new requires a new YAM session.
    halted=true;console.error('[YAM] OpenCode root session changed; reliable notifications are unavailable in this process');return;
   }
   if(!main){main=input.sessionID;send('SessionStart');}
   if(active?.id===id)return;
   await send('UserPromptSubmit',id);
   active={id,complete:false,terminal:false,rejected:false,permissions:new Set()};
  }),
  event:({event})=>{
   if(!['message.updated','session.idle','session.error','permission.asked','permission.replied'].includes(event.type))return;
   const p=event.properties??{},info=p.info??{};
   return ordered(async()=>{
    if(!active||(p.sessionID??info.sessionID)!==main)return;
    if(event.type==='message.updated'){
     if(info.role!=='assistant'||info.parentID!==active.id)return;
     if(info.error&&!active.terminal){await send(info.error.name==='MessageAbortedError'?'Interrupt':'TurnFailed',active.id);active.terminal=true;}
     else if(info.time?.completed&&['stop','length'].includes(info.finish))active.complete=true;
    }else if(event.type==='session.idle'){
     if(!active.terminal&&(active.complete||active.rejected)){await send(active.complete?'TurnComplete':'Interrupt',active.id);active.terminal=true;}
    }else if(event.type==='session.error'&&!active.terminal){
     await send(p.error?.name==='MessageAbortedError'?'Interrupt':'TurnFailed',active.id);active.terminal=true;
    }else if(event.type==='permission.asked'&&!active.terminal){
     if(!/^[a-zA-Z0-9_-]{1,128}$/.test(p.id??''))return;
     if(active.permissions.has(p.id))return;
     await send('PermissionRequest',active.id,p.id);active.permissions.add(p.id);
    }else if(event.type==='permission.replied'&&!active.terminal&&active.permissions.has(p.requestID)){
     await send('ToolProgress',active.id,p.requestID);active.permissions.delete(p.requestID);
     if(p.reply==='reject')active.rejected=true;
    }
   });
  }
 };
}
