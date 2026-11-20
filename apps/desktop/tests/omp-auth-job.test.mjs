// Author: Jeff.Liu. No real credentials, desktop apps or external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const credential={type:'oauth',access:'owner-access',expires:Date.now()+3600000,clientId:'oaiapp_fixture',scopes:['resource.invoke','chatgpt.tokens.use.direct']};
const helper=new URL('../../../extensions/omp-chatgpt/yam-auth-helper.mjs',import.meta.url).pathname;
async function listen(handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s;}
const address=s=>'127.0.0.1:'+s.address().port;
const frame=v=>{const body=Buffer.from(JSON.stringify(v)),head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);};
test('desktop credential helper uses an authenticated owner job instead of refreshing inside the terminal tree',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yam-auth-job-'));let ownerCalls=0;
 const job=await listen(socket=>socket.once('data',data=>{const q=JSON.parse(String(data));assert.equal(q.token,'c'.repeat(64));assert.equal(q.operation,'read');socket.end(JSON.stringify({result:credential})+'\n');}));
 const owner=await listen(socket=>{let bytes=Buffer.alloc(0);socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(bytes.length<4||bytes.length<4+bytes.readUInt32BE())return;const q=JSON.parse(bytes.subarray(4));ownerCalls++;assert.equal(q.command,'start_omp_auth');assert.deepEqual(q.args,{session_id:'s-1-1',generation:'g'.repeat(64)});socket.end(frame({version:q.version,instance:q.instance,client:q.client,id:q.id,result:{Ok:{address:address(job),token:'c'.repeat(64)}}}));});});
 try{
  const descriptor=join(root,'connection.json');await writeFile(descriptor,JSON.stringify({version:2,address:address(owner),token:'a'.repeat(64),instance:'b'.repeat(64)}),{mode:0o600});
  await writeFile(join(root,'auth.json'),JSON.stringify({version:1,hostId:'urn:uuid:00000000-0000-0000-0000-000000000000',registration:{clientId:'oaiapp_fixture'},credential:{...credential,access:'terminal-local-access',refresh:'fake-refresh'}}),{mode:0o600});
  const {stdout}=await promisify(execFile)(process.execPath,[helper,root],{env:{...process.env,YAM_OMP_DESKTOP:'1',YAM_OMP_AUTH_OWNER_DESCRIPTOR:descriptor,YAM_OMP_TERMINAL:'s-1-1',YAM_OMP_GENERATION:'g'.repeat(64)}});
  assert.equal(JSON.parse(stdout).access,'owner-access');assert.equal(ownerCalls,1);
 }finally{owner.close();job.close();await rm(root,{recursive:true,force:true});}
});

test('owner credential handoff rejects shared descriptors and mismatched RPC identity',async()=>{
 const {ownerAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs');const {chmod}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'yam-auth-handoff-'));let calls=0;
 const owner=await listen(socket=>{let bytes=Buffer.alloc(0);socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(bytes.length<4||bytes.length<4+bytes.readUInt32BE())return;const q=JSON.parse(bytes.subarray(4));calls++;socket.end(frame({version:2,instance:q.instance,client:'wrong-client',id:q.id,result:{Ok:{address:'127.0.0.1:12345',token:'c'.repeat(64)}}}));});});
 try{
  const path=join(root,'connection.json');await writeFile(path,JSON.stringify({version:2,address:address(owner),instance:'b'.repeat(64),token:'a'.repeat(64)}),{mode:0o600});
  const env={YAM_OMP_AUTH_OWNER_DESCRIPTOR:path,YAM_OMP_TERMINAL:'s-1-1',YAM_OMP_GENERATION:'generation'};
  await chmod(path,0o644);await assert.rejects(ownerAuthentication(env,'read'));assert.equal(calls,0);
  await chmod(path,0o600);await assert.rejects(ownerAuthentication(env,'read'),e=>e.code==='YAM_AUTH_OWNER');assert.equal(calls,1);
 }finally{owner.close();await rm(root,{recursive:true,force:true});}
});

test('authentication worker rejects an unknown capability and accepts only one request',async()=>{
 const {serveAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs');const {connect}=await import('node:net');let ready,calls=0;
 const listening=new Promise(r=>ready=r),serving=serveAuthentication({read:async()=>{calls++;return credential;}},{onReady:ready});const job=await listening;
 const ask=token=>new Promise((resolve,reject)=>{const s=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});let text='';s.on('connect',()=>s.write(JSON.stringify({token,operation:'read'})+'\n'));s.on('data',b=>text+=b);s.on('end',()=>resolve(text));s.on('error',reject);});
 assert.equal(await ask('d'.repeat(64)),'');assert.equal(calls,0);const result=JSON.parse(await ask(job.token));await serving;assert.equal(result.result.access,'owner-access');assert.equal(calls,1);
 await assert.rejects(ask(job.token));
});

test('malformed unauthenticated JSON cannot crash an authentication worker',async()=>{
 const {spawn}=await import('node:child_process'),{connect}=await import('node:net');
 const source=String.raw`import {serveAuthentication} from ${JSON.stringify(new URL('../../../extensions/omp-chatgpt/auth-job.mjs',import.meta.url).href)};await serveAuthentication({read:async()=>(${JSON.stringify(credential)})},{idleMs:3000});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});const exited=new Promise(r=>child.once('exit',r));
 try{
  const job=await new Promise((resolve,reject)=>{child.stdout.once('data',b=>resolve(JSON.parse(String(b))));child.once('error',reject);});
  await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});s.on('connect',()=>s.write('null\n'));s.on('error',()=>{});s.on('close',resolve);});
  await new Promise(r=>setTimeout(r,80));assert.equal(child.exitCode,null,'Malformed JSON must not terminate the worker');
  const result=await new Promise((resolve,reject)=>{const s=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});let data='';s.on('connect',()=>s.write(JSON.stringify({token:job.token,operation:'read'})+'\n'));s.on('data',b=>data+=b);s.on('end',()=>resolve(JSON.parse(data)));s.on('error',reject);});assert.equal(result.result.access,'owner-access');await exited;
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;}
});

test('worker idle deadline closes unclaimed sockets even while they send incomplete data',async()=>{
 const {serveAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs'),{connect}=await import('node:net');let ready;const listening=new Promise(r=>ready=r);
 const serving=serveAuthentication({read:()=>{throw Error('Unauthenticated request must not execute');}},{idleMs:80,onReady:ready});const job=await listening,socket=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});socket.on('error',()=>{});socket.on('connect',()=>socket.write('{'));
 const trickle=setInterval(()=>{if(!socket.destroyed)socket.write(' ');},10);
 try{assert.equal(await Promise.race([serving.then(()=>true),new Promise(r=>setTimeout(()=>r(false),250))]),true,'Idle worker must exit on its absolute deadline');}
 finally{clearInterval(trickle);socket.destroy();await serving;}
});
