#!/usr/bin/env node
// Author: Jeff.Liu. Run explicitly in a terminal; this uses the real Codex login/quota.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,open,stat,writeFile} from 'node:fs/promises';
import {createNativeRelay} from './codex-native-routing.mjs';

assert.ok(process.stdin.isTTY&&process.stdout.isTTY,'Run this real-model acceptance check explicitly in a terminal');
const root=await mkdtemp('/tmp/yam-native-smoke-'),executable=process.env.YAM_CODEX_EXECUTABLE||'codex';
const env={...process.env,TERM:process.env.TERM==='dumb'?'xterm-256color':process.env.TERM};
for(const key of Object.keys(env))if(key.startsWith('YAM_')||key.startsWith('CODEX_')&&key!=='CODEX_HOME')delete env[key];
const log=await open(`${root}/server.log`,'wx',0o600),events=[];
const server=spawn(executable,['app-server','--listen',`unix://${root}/server.sock`],{cwd:root,env,stdio:['ignore',log.fd,log.fd]});
const serverExit=once(server,'exit');let relay,ui,success=false;const textByItem=new Map();
const stop=()=>{ui?.kill('SIGTERM');server.kill('SIGTERM');};
process.on('SIGTERM',stop);process.on('SIGHUP',stop);
try{
 for(let i=0;i<200;i++){
  if(server.exitCode!==null)throw Error('Codex App Server exited; see '+root+'/server.log');
  if(await stat(`${root}/server.sock`).then(info=>info.isSocket(),()=>false))break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 relay=await createNativeRelay({socketPath:`${root}/relay.sock`,backendPath:`${root}/server.sock`,
  onRequest:async message=>{events.push({direction:'client',method:message.method??'response',id:message.id,keys:Object.keys(message.params??{}),threadId:message.params?.threadId,ephemeral:message.params?.ephemeral});return message;},
  onEvent:message=>{
   if(message.method)events.push({direction:'server',method:message.method,id:message.id,status:message.params?.turn?.status,threadId:message.params?.threadId??message.params?.thread?.id});
   if(message.method==='item/agentMessage/delta'){
    const id=message.params?.itemId,text=(textByItem.get(id)??'')+(message.params?.delta??'');
    textByItem.set(id,text.slice(-1024));if(text.includes('YAM_NATIVE_SMOKE_OK'))success=true;
   }
  }});
 console.log('Native Codex acceptance: skip unrelated hooks, wait for YAM_NATIVE_SMOKE_OK, then /exit. Evidence: '+root);
 ui=spawn(executable,['--remote',`unix://${root}/relay.sock`,'--no-alt-screen','-C',root,
  'Reply exactly YAM_NATIVE_SMOKE_OK. Do not use tools or modify files.'],{cwd:root,env,stdio:'inherit'});
 const [code]=await once(ui,'exit');
 await writeFile(`${root}/events.json`,JSON.stringify(events,null,2),{mode:0o600});
 assert.equal(code,0,'Native TUI exited successfully');
 assert.ok(success,'Observed the real streamed model response');
 assert.ok(events.some(event=>event.method==='turn/completed'&&event.status==='completed'),'Observed completed native turn');
 console.log('PASS: official TUI, relay, App Server, streamed model response; evidence '+root);
}finally{
 ui?.kill('SIGTERM');await relay?.close();server.kill('SIGTERM');await serverExit;await log.close();
 process.off('SIGTERM',stop);process.off('SIGHUP',stop);
}
