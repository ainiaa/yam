// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';

const runner=fileURLToPath(new URL('../../../scripts/codex-auto-route.mjs',import.meta.url));
const threadId='11111111-1111-1111-1111-111111111111',turnId='22222222-2222-2222-2222-222222222222';
const fakeCodex=String.raw`#!/usr/bin/env node
const {appendFileSync,readFileSync}=require('node:fs');
const {createInterface}=require('node:readline');
const args=process.argv.slice(2),env=process.env;
const record=data=>appendFileSync(env.ROUTING_TEST_LOG,JSON.stringify(data)+'\n');
let output=message=>console.log(JSON.stringify(message));
const send=(id,result)=>output({id,result});
const event=(method,params)=>output({method,params});
const threadId='11111111-1111-1111-1111-111111111111',turnId='22222222-2222-2222-2222-222222222222';
const finish=status=>event('turn/completed',{threadId,turn:{id:turnId,status}});
function encode(message,masked=false){
 const data=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(data.length<126?2:4);header[0]=129;header[1]=(masked?128:0)|(data.length<126?data.length:126);if(data.length>=126)header.writeUInt16BE(data.length,2);
 return Buffer.concat([header,...masked?[Buffer.alloc(4)]:[],data]);
}
function frames(socket,onMessage){
 let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=2){let n=buffer[1]&127,h=2;if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);h=4;}const mask=!!(buffer[1]&128);if(buffer.length<h+(mask?4:0)+n)return;const key=buffer.subarray(h,h+4);if(mask)h+=4;const data=buffer.subarray(h,h+n);buffer=buffer.subarray(h+n);onMessage(JSON.parse((mask?data.map((v,i)=>v^key[i%4]):data).toString()));}});
}

if(args[0]==='login'){console.log('Logged in using ChatGPT');}
else if(args[0]==='features'){console.log('respect_system_proxy stable true');}
else if(args.includes('--remote')){
 (async()=>{
  const socket=require('node:net').connect(args[args.indexOf('--remote')+1].slice(7));await new Promise(resolve=>socket.once('connect',resolve));
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise(resolve=>socket.once('data',resolve));let seq=0;const waiters=new Map(),completions=[];
  frames(socket,message=>{if(message.id!==undefined){const waiter=waiters.get(message.id);if(!waiter&&env.ROUTING_TEST_CASE==='mixed')record({method:'unexpected-internal-response'});if(message.error){console.log(message.error.message);waiter.reject(Error(message.error.message));}else waiter?.resolve(message.result);}if(message.method==='turn/completed')completions.shift()?.();if(message.params?.status?.type==='notLoaded')record({method:'unexpected-thread-unload'});});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;waiters.set(id,{resolve,reject});socket.write(encode({id,method,params},true));});
  await rpc('initialize',{});const resume=args.includes('resume');await rpc(resume?'thread/resume':'thread/start',resume?{threadId}:{ephemeral:false});
  let input='';for await(const chunk of process.stdin)input+=chunk;
  for(const prompt of input.trim().split('\n')){if(prompt==='/exit')break;let completed;const done=new Promise(resolve=>completed=resolve);completions.push(completed);try{await rpc('turn/start',{threadId,input:[{type:'text',text:prompt}]});await done;}catch{completions.pop();}}
  socket.end();
 })().catch(error=>{console.error(error);process.exit(1);});
}else if(args[0]==='exec'){
 const model=args[args.indexOf('--model')+1],schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 record({method:'classify',model,home:env.CODEX_HOME,paid:Boolean(env.YAM_PROVIDER_API_KEY||env.YAM_TEST_API_KEY||env.OPENAI_API_KEY),
  hostContext:Boolean(env.CODEX_APP_TOOLS_PIPE_PATH||env.CODEX_SQLITE_HOME),readonly:args.includes('read-only')&&args.includes('--ephemeral')&&args.includes('--ignore-user-config')&&args.includes('forced_login_method="chatgpt"'),
  isolated:process.cwd()!==env.ROUTING_TEST_PROJECT,proxy:args.includes('features.respect_system_proxy=true'),schema:schema.additionalProperties===false&&schema.required.includes('requires')});
 let input='';process.stdin.setEncoding('utf8').on('data',chunk=>input+=chunk);
 process.stdin.on('end',()=>{
  if(model==='timeout'){setInterval(()=>{},1000);return;}
  if(model==='offline'||env.ROUTING_TEST_CASE==='auth'){process.exitCode=1;return;}
  const facts={intent:'new',task:'coding',context:'dependent',action:'write',depth:env.ROUTING_TEST_CASE==='mixed'&&JSON.parse(input.split('\n').at(-1)).request.startsWith('Deep')?'deep':'normal',uncertain:false,readOnly:false,requires:['files']};
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(facts)}}));
  console.log(JSON.stringify({type:'turn.completed'}));
 });
}else if(args[0]==='app-server'){
 record({method:'server',home:env.CODEX_HOME,paid:env.YAM_PROVIDER_API_KEY==='fixture-key',routedGateway:env.YAM_ROUTED_GATEWAY_1_KEY==='fixture-key',hostContext:Boolean(env.CODEX_APP_TOOLS_PIPE_PATH||env.CODEX_SQLITE_HOME),overrides:args.slice(1)});
 let loaded=false;
 const handle=({id,method,params})=>{
  if(method==='account/read')send(id,{account:{type:'chatgpt'}});
  if(method==='model/list')send(id,{data:['offline','fast','deepseek-v4-pro','deepseek-v4-flash'].map(model=>({model,supportedReasoningEfforts:['medium','high','max'].map(reasoningEffort=>({reasoningEffort}))})),nextCursor:null});
  if(method==='initialize')send(id,{userAgent:'fake-codex'});
  if(method==='thread/start'||method==='thread/resume'){
   loaded=true;
   record({method,params});
   send(id,{thread:{id:threadId},model:params.model,modelProvider:params.modelProvider,reasoningEffort:'high',cwd:env.ROUTING_TEST_PROJECT,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
  }
  if(method==='thread/unsubscribe'){record({method,params});loaded=false;event('thread/status/changed',{threadId,status:{type:'notLoaded'}});send(id,{status:'unsubscribed'});}
  if(method==='thread/loaded/list'){record({method,params});send(id,{data:loaded?[threadId]:[],nextCursor:null});}
  if(method==='turn/start'){
   record({method,params});
   if(env.ROUTING_TEST_CASE==='unknown'){process.exit(0);return;}
   if(['interrupt','cancel-race','double-interrupt'].includes(env.ROUTING_TEST_CASE)){
    event('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
    send(id,{turn:{id:turnId,status:'inProgress'}});
    process.stderr.write('waiting\n');
    return;
   }
   event('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
   if(env.ROUTING_TEST_CASE==='rerouted')event('model/rerouted',{threadId,turnId,fromModel:params.model,toModel:'unexpected',reason:'fallback'});
   event('item/completed',{threadId,turnId,item:{type:'agentMessage',text:'fixture response'}});
   finish('completed');
   send(id,{turn:{id:turnId,status:'inProgress'}});
  }
  if(method==='turn/interrupt'){
   record({method,params});
   if(env.ROUTING_TEST_CASE==='double-interrupt'){
    setTimeout(()=>{send(id,{});finish('interrupted');},350);
    return;
   }
   send(id,{});
   finish(env.ROUTING_TEST_CASE==='cancel-race'?'completed':'interrupted');
  }
 };
 if(args.includes('stdio://'))createInterface({input:process.stdin}).on('line',line=>handle(JSON.parse(line)));
 else require('node:net').createServer(socket=>{socket.once('data',()=>{socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');output=message=>socket.write(encode(message));frames(socket,handle);});}).listen(args[args.indexOf('--listen')+1].slice(7));
}
`;

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'yam-route-protocol-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const paths=Object.fromEntries(['global','subscription','paid-a','paid-c','project'].map(key=>[key,join(root,key)]));
 await Promise.all(Object.values(paths).map(path=>mkdir(path,{mode:0o700})));
 const globalConfig=join(paths.global,'config.toml'),sentinel=Buffer.from('# existing global user configuration\nmodel = "sentinel"\n');
 await writeFile(globalConfig,sentinel);
 const executable=join(root,'fake-codex');
 await writeFile(executable,fakeCodex,{mode:0o700});
 const config={codex:executable,respectSystemProxy:true,connections:{
  sub:{billing:'subscription',home:paths.subscription},
  a:{billing:'paid',home:paths['paid-a'],baseUrl:'https://api.deepseek.com',apiKeyEnv:'YAM_MISSING_API_KEY'},
  c:{billing:'paid',home:paths['paid-c'],baseUrl:'https://api.deepseek.com',apiKeyEnv:'YAM_TEST_API_KEY'},
 },classifiers:['sub/offline','sub/fast'],executionGroups:[{small:'a/deepseek-v4-flash',medium:'a/deepseek-v4-flash',strong:'a/deepseek-v4-flash'}, {}, {small:'c/deepseek-v4-pro',medium:'c/deepseek-v4-pro',strong:'c/deepseek-v4-pro'}]};
 const configPath=join(root,'route.json'),session=join(root,'session'),log=join(root,'events.jsonl');
 const injector=join(root,'cancel-during-commit.mjs');
 await writeFile(injector,String.raw`import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout} from 'node:timers/promises';
fs.appendFileSync(process.env.ROUTING_TEST_LOG,JSON.stringify({method:'commit-injector-loaded'})+'\n');
const rename=fs.promises.rename;
fs.promises.rename=async(source,target)=>{
 if(JSON.parse(fs.readFileSync(source,'utf8')).status==='completed'){
  fs.appendFileSync(process.env.ROUTING_TEST_LOG,JSON.stringify({method:'asynchronous-commit'})+'\n');
  process.kill(process.pid,'SIGINT');
  await setTimeout(50);
 }
 return rename(source,target);
};
syncBuiltinESMExports();
`);
 const timeoutProbe=join(root,'scaled-classification-timeout.mjs');
 await writeFile(timeoutProbe,String.raw`import {appendFileSync} from 'node:fs';
const timeout=AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout=ms=>{
 appendFileSync(process.env.ROUTING_TEST_LOG,JSON.stringify({method:'classification-timer',ms})+'\n');
 return timeout(Math.ceil(ms/20));
};
`);
 await writeFile(log,'');
 async function run(mode='',onDispatch){
  await writeFile(configPath,JSON.stringify(config));
  const priorDispatches=onDispatch?(await events()).filter(event=>event.method==='turn/start').length:0;
  const preload=mode==='cancel-during-commit'?injector:mode==='scaled-classification-timeout'?timeoutProbe:null;
  const cliArgs=preload?['--import',preload]:[];
  const child=spawn(process.execPath,[...cliArgs,runner,'--config',configPath,'--session',session,'--cwd',paths.project],{
   env:{...process.env,CODEX_HOME:paths.global,OPENAI_API_KEY:'global-fixture',YAM_TEST_API_KEY:'fixture-key',YAM_MISSING_API_KEY:'',
    CODEX_APP_TOOLS_PIPE_PATH:'desktop-fixture',CODEX_SQLITE_HOME:paths.global,
    ROUTING_TEST_LOG:log,ROUTING_TEST_CASE:mode,ROUTING_TEST_PROJECT:paths.project},
   stdio:['pipe','pipe','pipe'],
  });
  const output={stdout:'',stderr:''};
  for(const key of ['stdout','stderr'])child[key].setEncoding('utf8').on('data',data=>{output[key]+=data;});
  const closed=once(child,'close');
  const guard=setTimeout(()=>child.kill('SIGKILL'),12000);
  child.stdin.end('Implement fixture');
  let monitor,afterDispatch;
  try{
   if(onDispatch){
    afterDispatch=new Promise((resolve,reject)=>{
     monitor=setInterval(async()=>{
      try{
       if((await events()).filter(event=>event.method==='turn/start').length<=priorDispatches)return;
       if(!monitor)return;
       clearInterval(monitor);monitor=null;
       try{await onDispatch(child);resolve();}catch(error){reject(error);}finally{child.kill('SIGINT');}
      }catch(error){reject(error);}
     },20);
    });
    await Promise.race([afterDispatch,closed]);
   }
   const [code]=await closed;
   return {code,...output};
  }finally{clearTimeout(guard);clearInterval(monitor);}
 }
 async function events(){return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
 async function desktop(prompts,mode=''){
  const {codex,...policy}=config;
  const child=spawn(process.execPath,[runner,'--interactive','--session',session,'--codex',codex],{
   cwd:paths.project,env:{...process.env,CODEX_HOME:paths.global,YAM_TEST_API_KEY:'fixture-key',
    YAM_CODEX_ROUTE_CONFIG:JSON.stringify(policy),ROUTING_TEST_CASE:mode,ROUTING_TEST_LOG:log,ROUTING_TEST_PROJECT:paths.project},stdio:['pipe','pipe','pipe'],
  });
  const output={stdout:'',stderr:''};
  for(const key of ['stdout','stderr'])child[key].setEncoding('utf8').on('data',data=>{output[key]+=data;});
  const closed=once(child,'close'),guard=setTimeout(()=>child.kill('SIGKILL'),12000);
  child.stdin.end(prompts.join('\n')+'\n');
  try{const [code]=await closed;return {code,...output};}finally{clearTimeout(guard);}
 }
 return {config,run,events,paths,globalConfig,sentinel,desktop,session};
}

test('managed mixed Codex starts on a gateway then dispatches one turn per source change and reopens the current connection',async t=>{
 const {config,desktop,events,session}=await fixture(t);
 const model='auto/deepseek-v4-flash';
 const gateway=createServer((_request,response)=>response.end(JSON.stringify({data:[{id:model,reasoning_levels:['high'],modalities:{input:['text']}}]})));
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');t.after(()=>new Promise(resolve=>gateway.close(resolve)));
 config.connections={native:{native:true,billing:'subscription'},local:{gateway:true,billing:'paid',baseUrl:'http://127.0.0.1:'+gateway.address().port,apiKeyEnv:'YAM_TEST_API_KEY'}};
 config.classifiers=['native/fast'];config.executionGroups=[{small:'native/fast',medium:'local/'+model,strong:'native/fast'}];config.effort='high';
 const first=await desktop(['Code on gateway','Deep on native','Code on gateway again','/exit'],'mixed');
 assert.equal(first.code,0,first.stderr);assert.equal(first.stdout,'');
 const state=JSON.parse(await readFile(join(session,'state.json'),'utf8'));
 assert.deepEqual([state.threadId,state.connectionName,state.provider,state.nativeModel.model],[threadId,'local','yam_route',model]);
 const reopened=await desktop(['Code after reopen','/exit'],'mixed');assert.equal(reopened.code,0,reopened.stderr);
 const records=await events(),business=records.filter(row=>['thread/start','thread/resume','thread/unsubscribe','thread/loaded/list','turn/start'].includes(row.method));
 assert.deepEqual(business.map(row=>row.method),['thread/start','turn/start','thread/unsubscribe','thread/loaded/list','thread/resume','turn/start','thread/unsubscribe','thread/loaded/list','thread/resume','turn/start','thread/resume','turn/start']);
 assert.deepEqual(business.filter(row=>row.method==='turn/start').map(row=>[row.params.threadId,row.params.model]),[[threadId,model],[threadId,'fast'],[threadId,model],[threadId,model]]);
 assert.ok(records.filter(row=>row.method==='classify').every(row=>row.model==='fast'&&!row.paid));
 assert.ok(records.filter(row=>row.method==='server'&&row.overrides.includes('model_provider="yam_route"')).every(row=>row.routedGateway&&!row.paid&&row.overrides.includes('forced_login_method="chatgpt"')));
 assert.ok(!records.some(row=>row.method.startsWith('unexpected-')));
});

test('desktop terminal dispatches through the selected route and reopens the same thread',async t=>{
 const {desktop,events}=await fixture(t);
 const first=await desktop(['Implement fixture','Follow-up','/exit']);
 assert.equal(first.code,0,first.stderr);
 const reopened=await desktop(['After reopening','/exit']);
 assert.equal(reopened.code,0,reopened.stderr);
 const requests=await events();
 assert.equal(requests.filter(event=>event.method==='thread/start').length,1);
 assert.equal(requests.filter(event=>event.method==='thread/resume').length,1);
 const turns=requests.filter(event=>event.method==='turn/start');
 assert.equal(turns.length,3);
 assert.equal(new Set(turns.map(event=>event.params.threadId)).size,1);
 assert.ok(turns.every(event=>event.params.model==='deepseek-v4-pro'&&event.params.effort==='high'));
 assert.deepEqual(turns.map(event=>event.params.input[0].text),['Implement fixture','Follow-up','After reopening']);
});

test('desktop terminal preserves the no-paid-dispatch guard when subscription classification fails',async t=>{
 const {desktop,events}=await fixture(t);
 const result=await desktop(['Implement fixture','/exit'],'auth');
 assert.equal(result.code,0,result.stderr);
 assert.match(result.stdout,/automatic paid dispatch is disabled/);
 assert.equal((await events()).filter(event=>event.method==='turn/start').length,0);
});

test('protocol routes isolated subscription classification to explicit DeepSeek and resumes the same thread',async t=>{
 const {config,run,events,paths,globalConfig,sentinel}=await fixture(t);
 const result=await run();
 assert.equal(result.code,0,result.stderr);
 const routed=JSON.parse(result.stdout);
 assert.equal(routed.classification.source,'B');
 assert.equal(routed.model,'c/deepseek-v4-pro');
 assert.equal(routed.group,'C');
 assert.equal(routed.text,'fixture response');
 let records=await events();
 assert.deepEqual(records.map(record=>record.method),['classify','classify','server','thread/start','turn/start']);
 for(const record of records.slice(0,2)){
  assert.equal(record.home,await realpath(paths.subscription));
  assert.equal(record.paid,false);
  assert.equal(record.hostContext,false);
  assert.ok(record.readonly&&record.isolated&&record.schema&&record.proxy);
 }
 assert.equal(records[2].paid,true);
 assert.equal(records[2].hostContext,false);
 assert.ok(records[2].overrides.includes('features.respect_system_proxy=true'));
 assert.match(records[2].overrides.join(' '),/base_url = "https:\/\/api\.deepseek\.com\/".*wire_api = "responses"/);
 assert.equal(records[3].params.modelProvider,'yam_api');
 assert.equal(records[4].params.effort,'high');
 config.executionGroups=[{medium:'sub/other'}];
 const rejected=await run();assert.equal(rejected.code,1);assert.match(rejected.stderr,/connection/);
 config.executionGroups=[{medium:'c/deepseek-v4-pro'}];
 const continued=await run();
 assert.equal(continued.code,0,continued.stderr);
 assert.equal(JSON.parse(continued.stdout).model,'c/deepseek-v4-pro');
 records=await events();
 assert.equal(records.filter(record=>record.method==='classify').length,6);
 assert.equal(records.filter(record=>record.method==='turn/start').length,2);
 assert.equal(records.find(record=>record.method==='thread/resume').params.threadId,threadId);
 assert.deepEqual(await readFile(globalConfig),sentinel);
});

test('auth failure blocks paid dispatch and allows an explicitly selected local subscription tier',async t=>{
 const {config,run,events}=await fixture(t);
 assert.match((await run('auth')).stderr,/paid dispatch is disabled/);
 assert.deepEqual((await events()).map(record=>record.method),['classify','classify']);
 config.executionGroups=[{medium:'sub/regular'}];
 const result=await run('auth');
 assert.equal(result.code,0,result.stderr);
 const routed=JSON.parse(result.stdout);
 assert.equal(routed.classification.source,'local');
 assert.equal(routed.tier,'medium');
 assert.equal(routed.effort,'high');
 assert.equal((await events()).find(record=>record.method==='thread/start').params.modelProvider,'openai');
});

test('timed-out subscription classification settles before a backup is used',async t=>{
 const {config,run,events}=await fixture(t);
 config.classifiers=['sub/timeout','sub/fast'];
 const result=await run('scaled-classification-timeout');
 assert.deepEqual((await events()).filter(record=>record.method==='classification-timer').map(record=>record.ms),[135000,45000,45000]);
 assert.equal(result.code,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout).classification.attempts.map(a=>a.result),['timeout','selected']);
});

test('unknown dispatch retains the thread and blocks any further execution',async t=>{
 const {run,events}=await fixture(t);
 const unknown=await run('unknown');
 assert.equal(unknown.code,1);
 assert.match(unknown.stderr,/outcome unknown/);
 assert.match((await run()).stderr,/pending/);
 assert.equal((await events()).filter(record=>record.method==='turn/start').length,1);
});

test('SIGINT interrupts the exact accepted turn and prevents replay',async t=>{
 const {run,events}=await fixture(t);
 const aborted=await run('interrupt',async()=>{});
 assert.equal(aborted.code,1,aborted.stderr);
 assert.match(aborted.stderr,/turn interrupted/);
 const next=await run();assert.equal(next.code,0,next.stderr);
 const records=await events();
 assert.equal(records.filter(record=>record.method==='turn/start').length,2);
 assert.deepEqual(records.find(record=>record.method==='turn/interrupt').params,{threadId,turnId});
});

test('a provider-side model reroute cannot be recorded as a pinned completed turn',async t=>{
 const {run,events}=await fixture(t);
 const result=await run('rerouted');
 assert.equal(result.code,1);
 assert.match((await run()).stderr,/pending/);
 assert.equal((await events()).filter(record=>record.method==='turn/start').length,1);
});

test('confirmed success racing with cancellation permits an explicit next turn without replay',async t=>{
 const {run,events}=await fixture(t);
 const result=await run('cancel-race',async()=>{});
 assert.equal(result.code,0,result.stderr);
 assert.equal((await run()).code,0);
 assert.deepEqual((await events()).filter(record=>record.method==='turn/start'||record.method==='turn/interrupt').map(record=>record.method),['turn/start','turn/interrupt','turn/start']);
});

test('two standalone CLI processes cannot dispatch in the same route session',async t=>{
 const {run,events}=await fixture(t);
 let overlapping;
 const first=await run('interrupt',async()=>{overlapping=await run();});
 assert.equal(first.code,1);
 assert.ok(overlapping);
 assert.match(overlapping.stderr,/locked/);
 assert.equal((await events()).filter(record=>record.method==='turn/start').length,1);
});

test('a cancellation observed during state publication cannot leave a completed session',async t=>{
 const {run,events}=await fixture(t);
 const result=await run('cancel-during-commit');
 const records=await events();
 assert.ok(records.some(record=>record.method==='commit-injector-loaded'));
 if(records.some(record=>record.method==='asynchronous-commit')){
  assert.equal(result.code,1,'abort was observed before the async state replacement');
  assert.match((await run()).stderr,/pending/);
 }else{
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).threadId,threadId);
 }
});

test('repeated SIGINT waits for the original interrupt and releases the session lock',async t=>{
 const {run,events}=await fixture(t);
 const first=await run('double-interrupt',async child=>{
  child.kill('SIGINT');
  await delay(100);
 });
 assert.equal(first.code,1,first.stderr);
 const next=await run();
 assert.equal(next.code,0,next.stderr);
 assert.equal((await events()).filter(record=>record.method==='turn/interrupt').length,1);
});

test('isolated classification inherits the official native proxy feature when policy has no override',async t=>{
 const {config,run,events}=await fixture(t);delete config.respectSystemProxy;
 const result=await run();assert.equal(result.code,0,result.stderr);
 assert.ok((await events()).filter(event=>event.method==='classify').every(event=>event.proxy));
});
