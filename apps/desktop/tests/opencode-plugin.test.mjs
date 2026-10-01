import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import Plugin from '../src-tauri/src/opencode-plugin.mjs';

test('native main message IDs bind turns; idle, children, old completion and repeated events cannot fabricate replies',async()=>{
 const events=[];const server=net.createServer(socket=>{let raw='';socket.on('data',b=>{raw+=b;if(!raw.endsWith('\n'))return;const wire=JSON.parse(raw);assert.equal(wire.version,1);assert.equal(wire.token,'a'.repeat(64));events.push(wire.event);socket.end(JSON.stringify({accepted:true}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const oldAddress=process.env.YAM_AGENT_ADDRESS,oldToken=process.env.YAM_AGENT_TOKEN;
 process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='a'.repeat(64);
 try{
  const hooks=await Plugin({client:{session:{get:async({path})=>({data:{id:path.id,...(path.id==='child'?{parentID:'main'}:{})}})}}});
  const event=(type,p)=>hooks.event({event:{type,properties:p}});
  const chat=(sessionID,id)=>hooks['chat.message']({sessionID},{message:{id,role:'user'},parts:[{text:'private prompt'}]});
  await event('session.idle',{sessionID:'main'});assert.equal(events.length,0);
  await chat('child','msg_child');assert.equal(events.length,0);
  await chat('main','msg_one');assert.deepEqual(events.map(e=>e.kind),['SessionStart','UserPromptSubmit']);
  await event('session.idle',{sessionID:'main'});assert.equal(events.length,2);
  await event('message.updated',{info:{id:'reply',role:'assistant',sessionID:'main',parentID:'msg_one',finish:'stop',time:{completed:1},message:'private'}});
  await event('session.idle',{sessionID:'child'});assert.equal(events.length,2);
  await event('session.idle',{sessionID:'main'});await event('session.idle',{sessionID:'main'});
  assert.equal(events.filter(e=>e.kind==='TurnComplete').length,1);
  await chat('main','msg_two');
  await event('message.updated',{info:{id:'old',role:'assistant',sessionID:'main',parentID:'msg_one',finish:'stop',time:{completed:2}}});
  await event('session.idle',{sessionID:'main'});assert.equal(events.filter(e=>e.kind==='TurnComplete').length,1);
  await event('permission.asked',{sessionID:'main',id:'request',patterns:['private command']});
  await event('permission.replied',{sessionID:'main',requestID:'request'});
  await event('session.error',{sessionID:'main',error:{name:'MessageAbortedError',data:{message:'private'}}});
  await event('session.idle',{sessionID:'main'});
  assert.deepEqual(events.slice(-3).map(e=>[e.kind,e.turn_id,e.permission_key]),[['PermissionRequest','msg_two','request'],['ToolProgress','msg_two','request'],['Interrupt','msg_two',undefined]]);
  await chat('main','msg_denied');
  await event('permission.asked',{sessionID:'main',id:'denied_request'});
  await event('permission.replied',{sessionID:'main',requestID:'denied_request',reply:'reject'});
  await event('session.idle',{sessionID:'main'});
  assert.equal(events.at(-1).kind,'Interrupt');
  await chat('main','msg_abort');
  await event('message.updated',{info:{role:'assistant',sessionID:'main',parentID:'msg_abort',error:{name:'MessageAbortedError'}}});
  assert.equal(events.at(-1).kind,'Interrupt');
  await chat('another_root','msg_newroot');
  assert.equal(events.at(-1).kind,'IntegrationUnavailable');
  assert.equal(events.at(-1).agent_session_id,'main');
  assert.equal(events.at(-1).turn_id,'msg_abort');
  const before=events.length;await chat('main','msg_afterrootchange');assert.equal(events.length,before);
  assert.ok(events.every(e=>e.source==='opencode'));assert.ok(!JSON.stringify(events).includes('private'));
 }finally{
  if(oldAddress===undefined)delete process.env.YAM_AGENT_ADDRESS;else process.env.YAM_AGENT_ADDRESS=oldAddress;
  if(oldToken===undefined)delete process.env.YAM_AGENT_TOKEN;else process.env.YAM_AGENT_TOKEN=oldToken;
  await new Promise(r=>server.close(r));
 }
});

test('a lost acknowledgement retries the same native event before starting its turn',async()=>{
 const received=[];const server=net.createServer(socket=>{let raw='';socket.on('data',b=>{raw+=b;if(!raw.endsWith('\n'))return;received.push(JSON.parse(raw).event);socket.end(JSON.stringify({accepted:received.length>1}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='b'.repeat(64);
 try {
  const hooks=await Plugin({client:{session:{get:async()=>({data:{id:'main'}})}}});
  await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_retry',role:'user'}});
  assert.deepEqual(received.map(e=>e.kind),['SessionStart','SessionStart','UserPromptSubmit']);
  assert.deepEqual(received[0],received[1]);
 }finally {delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;await new Promise(r=>server.close(r));}
});
test('invalid addresses and credentials fail before opening an external connection',async()=>{
 process.env.YAM_AGENT_TOKEN='a'.repeat(64);
 try{for(const address of ['remote.example:80','127.0.0.1:0','127.0.0.1:65536']){process.env.YAM_AGENT_ADDRESS=address;await assert.rejects(Plugin({client:{}}),/credentials/);}}
 finally{delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;}
});


test('failed prompt acknowledgement is retained and replayed before completion after reconnect',async()=>{
 const received=[];let accepting=true;const server=net.createServer(socket=>{let raw='';socket.on('data',b=>{raw+=b;if(!raw.endsWith('\n'))return;const event=JSON.parse(raw).event;received.push(event);socket.end(JSON.stringify({accepted:accepting}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='c'.repeat(64);
 try{
  const hooks=await Plugin({client:{session:{get:async()=>({data:{id:'main'}})}}});
  await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_first',role:'user'}});
  accepting=false;await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_recover',role:'user'}});
  accepting=true;
  await hooks.event({event:{type:'message.updated',properties:{info:{role:'assistant',sessionID:'main',parentID:'msg_recover',finish:'stop',time:{completed:1}}}}});
  await hooks.event({event:{type:'session.idle',properties:{sessionID:'main'}}});
  assert.equal(received.at(-1).kind,'TurnComplete');assert.equal(received.at(-1).turn_id,'msg_recover');
  assert.equal(received.at(-2).kind,'UserPromptSubmit');assert.equal(received.at(-2).turn_id,'msg_recover');
 }finally{delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;await new Promise(r=>server.close(r));}
});


test('disconnect bursts have bounded retained events and report unavailable instead of false completion',async()=>{
 let accepting=false;const received=[];const server=net.createServer(socket=>{let raw='';socket.on('data',b=>{raw+=b;if(!raw.endsWith('\n'))return;const event=JSON.parse(raw).event;if(accepting)received.push(event);socket.end(JSON.stringify({accepted:accepting}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='f'.repeat(64);
 try{
  const hooks=await Plugin({client:{session:{get:async()=>({data:{id:'main'}})}}});
  await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_seed',role:'user'}});
  await Promise.all(Array.from({length:200},(_,i)=>hooks['chat.message']({sessionID:'main'},{message:{id:'msg_burst'+i,role:'user'}})));
  accepting=true;await hooks.event({event:{type:'session.idle',properties:{sessionID:'main'}}});
  assert.ok(received.filter(e=>e.kind==='UserPromptSubmit').length<=127);
  assert.equal(received.at(-1).kind,'IntegrationUnavailable');assert.ok(!received.some(e=>e.kind==='TurnComplete'));
 }finally{delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;await new Promise(r=>server.close(r));}
});


test('a stalled native session lookup is aborted, releases ordering, and cannot establish identity late',async(t)=>{
 const events=[];const server=net.createServer(socket=>{let raw='';socket.on('data',bytes=>{raw+=bytes;if(!raw.endsWith('\n'))return;events.push(JSON.parse(raw).event);socket.end('{"accepted":true}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='d'.repeat(64);
 t.mock.timers.enable({apis:['setTimeout']});let late,signal,pending,finished=false,calls=0;
 try{
  const hooks=await Plugin({client:{session:{get:({path,signal:requestSignal})=>{
   calls++;if(calls===1){signal=requestSignal;return new Promise(resolve=>{late=resolve;});}
   return Promise.resolve({data:{id:path.id}});
  }}}});
  pending=hooks['chat.message']({sessionID:'late_root'},{message:{id:'msg_late',role:'user'}}).then(()=>{finished=true;});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.ok(signal instanceof AbortSignal);
  t.mock.timers.tick(1000);for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(signal.aborted,true);assert.equal(finished,true);assert.equal(events.length,0);
  late({data:{id:'late_root'}});await Promise.resolve();
  await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_recovered',role:'user'}});
  assert.deepEqual(events.map(e=>[e.kind,e.agent_session_id]),[['SessionStart','main'],['UserPromptSubmit','main']]);
 }finally{
  t.mock.timers.reset();late?.({data:{id:'late_root'}});if(pending)await pending;
  delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;await new Promise(resolve=>server.close(resolve));
 }
});


test('native callback bursts are bounded independently of the socket outbox',async()=>{
 const events=[];const server=net.createServer(socket=>{let raw='';socket.on('data',b=>{raw+=b;if(!raw.endsWith('\n'))return;events.push(JSON.parse(raw).event);socket.end('{"accepted":true}');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.YAM_AGENT_ADDRESS='127.0.0.1:'+server.address().port;process.env.YAM_AGENT_TOKEN='e'.repeat(64);
 try{
  const hooks=await Plugin({client:{session:{get:async()=>({data:{id:'main'}})}}});
  await hooks['chat.message']({sessionID:'main'},{message:{id:'msg_seed',role:'user'}});
  await Promise.all(Array.from({length:500},()=>hooks.event({event:{type:'session.idle',properties:{sessionID:'main'}}})));
  assert.deepEqual(events.map(e=>e.kind),['SessionStart','UserPromptSubmit','IntegrationUnavailable']);
  assert.equal(events.at(-1).turn_id,'msg_seed');
 }finally{delete process.env.YAM_AGENT_ADDRESS;delete process.env.YAM_AGENT_TOKEN;await new Promise(r=>server.close(r));}
});
