// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import * as routes from '../../../scripts/codex-auto-route.mjs';

const routingPolicy={connections:{native:{billing:'subscription',native:true}},classifiers:['native/classifier'],executionGroups:[{small:'native/light',medium:'native/regular',strong:'native/deep'}]};
const catalog=['classifier','light','regular','deep'].map(model=>({key:'native/'+model,levels:['medium','high','max'],input:['text','image']}));
const newAnswer={intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']};
const flashKey='local/auto/deepseek-v4-flash';
const mixedPolicy={...routingPolicy,connections:{...routingPolicy.connections,local:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}},executionGroups:[{...routingPolicy.executionGroups[0],medium:flashKey}]};
const mixedCatalog=[...catalog,{key:flashKey,levels:['high'],input:['text']}];
const coding={...newAnswer,task:'coding',action:'write',readOnly:false};
const workspaceSandbox={type:'workspaceWrite',writableRoots:['/tmp/approved'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
const nativeSettings={cwd:'/tmp/native',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:workspaceSandbox,runtimeWorkspaceRoots:['/tmp/native'],disabledPluginIds:['plugin-a']};

test('native null turn overrides preserve confirmed permissions before switching connections',async()=>{
 for(const permissions of [null,'restricted-project']){
  let answer=coding,switched;
  const collaborationMode={mode:'plan',settings:{model:'old',reasoning_effort:'high',developer_instructions:'keep plan'}};
  const router=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'local',models:mixedCatalog,
   classify:async()=>({answer,source:'A'}),switchConnection:async change=>{switched=change;}});
  await router.request({id:1,method:'thread/start',params:{}});
  await router.event({id:1,result:{thread:{id:'main'},modelProvider:'yam_route',...nativeSettings,
   activePermissionProfile:permissions?{id:permissions,extends:null}:null,collaborationMode,serviceTier:'fast'}});
  const inherited={cwd:null,runtimeWorkspaceRoots:null,approvalPolicy:null,approvalsReviewer:null,
   sandboxPolicy:null,permissions:null,disabledPluginIds:null,collaborationMode:null,serviceTier:null};
  const turn=id=>({id,method:'turn/start',params:{threadId:'main',input:[{type:'text',text:'independent task'}],...inherited}});
  await router.request(turn(2));
  await router.event({method:'turn/started',params:{threadId:'main',turn:{id:'first'}}});
  await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'first',status:'completed'}}});
  answer=newAnswer;
  const next=await router.request(turn(3));
  assert.equal(switched.connection.name,'native');
  assert.equal(switched.settings.cwd,nativeSettings.cwd);
  assert.equal(switched.settings.approvalPolicy,'on-request');
  assert.equal(switched.settings.approvalsReviewer,'user');
  assert.deepEqual(switched.settings.sandboxPolicy,workspaceSandbox);
  assert.equal(switched.settings.permissions,permissions);
  assert.deepEqual(next.params.runtimeWorkspaceRoots,nativeSettings.runtimeWorkspaceRoots);
  assert.deepEqual(next.params.disabledPluginIds,nativeSettings.disabledPluginIds);
  assert.equal(next.params.collaborationMode.mode,'plan');
  assert.equal(next.params.collaborationMode.settings.developer_instructions,'keep plan');
  assert.equal(next.params.collaborationMode.settings.model,'light');
  assert.equal(next.params.serviceTier,null);
  if(permissions)assert.equal(next.params.permissions,permissions);
  else assert.deepEqual(next.params.sandboxPolicy,workspaceSandbox);
 }
});

test('native routing still refuses switching without confirmed permission settings',async()=>{
 let switched=false;
 const router=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'local',models:mixedCatalog,
  classify:async()=>({answer:newAnswer,source:'A'}),switchConnection:async()=>{switched=true;}});
 await router.request({id:1,method:'thread/start',params:{}});
 await router.event({id:1,result:{thread:{id:'main'},modelProvider:'yam_route',cwd:'/tmp/native'}});
 await assert.rejects(router.request({id:2,method:'turn/start',params:{threadId:'main',input:[],sandboxPolicy:null}}),/permissions are unavailable/);
 assert.equal(switched,false);assert.equal(router.state.connectionSwitch,null);
});

test('native connection switches hide their internal close while forwarding normal thread closure',async()=>{
 let entered,release;
 const switching=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
 const router=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'local',models:mixedCatalog,
  classify:async()=>({answer:newAnswer,source:'A'}),switchConnection:async()=>{entered();await resume;}});
 const closed=threadId=>({method:'thread/closed',params:{threadId}});
 await router.request({id:1,method:'thread/start',params:{}});
 await router.event({id:1,result:{thread:{id:'main'},modelProvider:'yam_route',...nativeSettings}});
 assert.equal(router.filterEvent(closed('main')),true);
 const pending=router.request({id:2,method:'turn/start',params:{threadId:'main',input:[]}});
 await switching;
 try{
  assert.equal(router.filterEvent(closed('main')),false);
  assert.equal(router.filterEvent(closed('other')),true);
  const confirmedSettings={method:'thread/settings/updated',params:{threadId:'main',threadSettings:{model:'light',effort:'medium',sandboxPolicy:{type:'readOnly',networkAccess:false}}}};
  assert.equal(router.filterEvent(confirmedSettings),true);
  await router.event(confirmedSettings);
  assert.equal(router.filterEvent({id:'internal-resume',result:{thread:{id:'main'}}}),true);
  assert.equal(router.filterEvent({method:'turn/completed',params:{threadId:'main',turn:{id:'previous',status:'completed'}}}),true);
 }finally{release();const next=await pending;assert.deepEqual(next.params.sandboxPolicy,workspaceSandbox);}
 assert.equal(router.filterEvent(closed('main')),true);
});

test('native routing switches subscription to gateway and back on one thread after independent classification',async()=>{
 const selected=[],states=[],requests=[];
 let answer=newAnswer;
 const router=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'native',models:mixedCatalog,
  classify:async({policy})=>{assert.equal(policy.classifiers[0],'native/classifier');return {answer,source:'A'};},
  switchConnection:async change=>{selected.push(change.connection.name);assert.equal(change.threadId,'main');assert.equal(router.state.connectionSwitch.to,change.connection.name);},
  save:async state=>states.push(state)});
 await router.request({id:1,method:'thread/start',params:{}});
 await router.event({id:1,result:{thread:{id:'main'},modelProvider:'yam_route',...nativeSettings}});
 const updated={type:'readOnly',networkAccess:false};
 await router.event({method:'thread/settings/updated',params:{threadId:'main',threadSettings:{sandboxPolicy:updated,approvalPolicy:'untrusted',collaborationMode:{mode:'plan',settings:{model:'old',reasoning_effort:'max',developer_instructions:'keep plan'}}}}});
 const send=async(id,params={})=>{
  const input=[{type:'text',text:'new task '+id}],request={id,method:'turn/start',params:{threadId:'main',input,...params}};
  const next=await router.request(request);
  assert.equal(next.id,id);assert.equal(next.params.input,input);
  requests.push(next.params);
  await router.event({method:'turn/started',params:{threadId:'main',turn:{id:'turn-'+id}}});
  await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'turn-'+id,status:'completed'}}});
 };
 await send(2);answer=coding;await send(3,{cwd:'/tmp/explicit',approvalPolicy:'on-request'});answer=newAnswer;await send(4);
 assert.deepEqual(selected,['local','native']);
 assert.deepEqual(requests.map(row=>row.model),['light','auto/deepseek-v4-flash','light']);
 assert.equal(requests[1].cwd,'/tmp/explicit');assert.equal(requests[1].approvalPolicy,'on-request');
 assert.deepEqual(requests[1].sandboxPolicy,updated);assert.equal(requests[1].approvalsReviewer,'user');
 assert.deepEqual(requests[1].runtimeWorkspaceRoots,nativeSettings.runtimeWorkspaceRoots);
 assert.deepEqual(requests[1].disabledPluginIds,nativeSettings.disabledPluginIds);
 assert.deepEqual(requests[1].collaborationMode,{mode:'plan',settings:{model:'auto/deepseek-v4-flash',reasoning_effort:'high',developer_instructions:'keep plan'}});
 assert.deepEqual(states.filter(row=>row.status==='pending').map(row=>row.connectionName),['native','local','native']);
 assert.equal(router.state.threadId,'main');assert.equal(router.state.connectionName,'native');
});

test('failed or cancelled connection changes do not dispatch and a fresh process recovers the last confirmed connection',async()=>{
 for(const abort of [false,true]){
  let entered;
  const starting=new Promise(resolve=>entered=resolve),controller=new AbortController();
  const router=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'native',models:mixedCatalog,classify:async()=>({answer:coding,source:'A'}),
   switchConnection:async ({signal})=>{entered();if(!abort)throw Error('resume rejected');await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await router.request({id:1,method:'thread/start',params:{}});await router.event({id:1,result:{thread:{id:'main'},modelProvider:'yam_route',...nativeSettings}});
  const turn={id:2,method:'turn/start',params:{threadId:'main',input:[]}};
  const submission=router.request(turn,{signal:controller.signal});
  await starting;if(abort)controller.abort(Error('switch cancelled'));
  await assert.rejects(submission,/resume rejected|cancelled/);
  assert.equal(router.state.status,'unknown');assert.equal(router.state.connectionName,'native');assert.equal(router.state.connectionSwitch.to,'local');
  await assert.rejects(router.request(turn),/inspect|reopen/i);
  const reopened=routes.createCodexTurnRouter({config:mixedPolicy,connectionName:'native',models:mixedCatalog,initial:router.state,classify:async()=>({answer:newAnswer,source:'A'})});
  await reopened.request({id:3,method:'thread/resume',params:{threadId:'main'}});
  await reopened.event({id:3,result:{thread:{id:'main'},modelProvider:'yam_route',model:'light',reasoningEffort:'medium',...nativeSettings}});
  assert.equal(reopened.state.connectionSwitch,null);assert.equal(reopened.state.connectionName,'native');
  reopened.setEnabled(false);assert.equal(await reopened.request(turn),turn);
 }
});

test('mixed connection resume waits for unload, retains thread settings and replaces gateway authentication',async()=>{
 const {resumeCodexConnection}=await import('../../../scripts/codex-route-app-server.mjs');
 assert.equal(typeof resumeCodexConnection,'function');
 const connection={gateway:true,billing:'paid',baseUrl:'http://127.0.0.1:3425/v1'};
 const calls=[];
 const requestBackend=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/unsubscribe')return {status:'unsubscribed'};
  if(method==='thread/loaded/list')return {data:calls.length===2?['main']:[],nextCursor:null};
  return {thread:{id:'main'},modelProvider:'yam_route',model:params.model};
 };
 const args={threadId:'main',model:'auto/deepseek-v4-flash',effort:'high',connection,gatewayKey:'YAM_ROUTED_GATEWAY_1_KEY',settings:{...nativeSettings,sandboxPolicy:workspaceSandbox},requestBackend};
 await resumeCodexConnection(args);
 assert.deepEqual(calls.map(call=>call.method),['thread/unsubscribe','thread/loaded/list','thread/loaded/list','thread/resume']);
 const gateway=calls.at(-1).params;
 assert.equal(gateway.threadId,'main');assert.equal(gateway.modelProvider,'yam_route');assert.equal(gateway.approvalPolicy,'on-request');
 assert.deepEqual(gateway.runtimeWorkspaceRoots,nativeSettings.runtimeWorkspaceRoots);
 assert.deepEqual(gateway.config['model_providers.yam_route'],{name:'YAM local gateway',base_url:connection.baseUrl,wire_api:'responses',env_key:args.gatewayKey,requires_openai_auth:false,supports_websockets:false});
 await resumeCodexConnection({...args,connection:{native:true,billing:'subscription'},model:'gpt-6.1-sol'});
 const native=calls.at(-1).params.config['model_providers.yam_route'];
 assert.equal(native.requires_openai_auth,true);assert.equal(native.base_url,'https://chatgpt.com/backend-api/codex');assert.equal(native.env_key,undefined);
 let resumed=false;await assert.rejects(resumeCodexConnection({...args,signal:AbortSignal.timeout(50),requestBackend:async(method)=>{
  if(method==='thread/unsubscribe')return {status:'unsubscribed'};
  if(method==='thread/loaded/list')return {data:['main']};resumed=true;
 }}),/abort|timeout/i);assert.equal(resumed,false);
});

test('native per-turn routing shares Pi new/continue decisions and respects collaboration settings',async()=>{
 assert.equal(typeof routes.createCodexTurnRouter,'function');
 let answer=newAnswer,calls=0;const states=[];
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,classify:async()=>{calls++;return {answer,source:'A'};},save:async state=>states.push(structuredClone(state))});
 await router.request({id:1,method:'thread/start',params:{ephemeral:false}});
 await router.event({id:1,result:{thread:{id:'business'}}});
 const turn=()=>({id:3,method:'turn/start',params:{threadId:'business',input:[{type:'text',text:'question'}],collaborationMode:{mode:'default',settings:{model:'old',reasoning_effort:'max',developer_instructions:'keep'}},approvalPolicy:'on-request'}});
 let request=await router.request(turn());
 assert.equal(request.params.model,'light');assert.equal(request.params.effort,'medium');
 assert.deepEqual(request.params.collaborationMode.settings,{model:'light',reasoning_effort:'medium',developer_instructions:'keep'});
 await router.event({method:'turn/started',params:{threadId:'business',turn:{id:'one'}}});
 await router.event({method:'turn/completed',params:{threadId:'business',turn:{id:'one',status:'interrupted'}}});
 answer={...newAnswer,intent:'continue',task:'coding',action:'write',readOnly:false};
 request=await router.request(turn());assert.equal(request.params.model,'light');
 await router.event({method:'turn/completed',params:{threadId:'business',turn:{id:'two',status:'completed'}}});
 answer={...answer,intent:'new'};request=await router.request(turn());assert.equal(request.params.model,'regular');
 assert.equal(calls,3);assert.equal(request.params.approvalPolicy,'on-request');assert.equal(states.at(-1).status,'pending');
});
test('temporary native title tasks bypass routing and cannot overwrite the business thread',async()=>{
 assert.equal(typeof routes.createCodexTurnRouter,'function');
 let calls=0;const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,classify:async()=>{calls++;return {answer:newAnswer,source:'A'};}});
 await router.request({id:1,method:'thread/start',params:{ephemeral:false}});await router.event({id:1,result:{thread:{id:'main'}}});
 await router.request({id:2,method:'thread/start',params:{ephemeral:true}});await router.event({id:2,result:{thread:{id:'title'}}});
 const title={id:3,method:'turn/start',params:{threadId:'title',input:[]}};
 assert.equal(await router.request(title),title);assert.equal(calls,0);
});
test('native router refuses unsupported effort and cross-connection changes before dispatch',async()=>{
 assert.equal(typeof routes.createCodexTurnRouter,'function');
 for(const config of [{...routingPolicy,effort:'xhigh'},{...routingPolicy,connections:{...routingPolicy.connections,other:{billing:'subscription',home:'/private/other'}},model:'other/model'}]){
  const router=routes.createCodexTurnRouter({config,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed'},classify:async()=>({answer:newAnswer,source:'A'})});
  await assert.rejects(router.request({id:1,method:'turn/start',params:{threadId:'main',input:[{type:'text',text:'task'}]}}),/reasoning|connection/i);
 }
});
test('cancelling classification replies locally and never dispatches or poisons the next turn',async()=>{
 assert.equal(typeof routes.createCodexTurnRouter,'function');
 let entered;const started=new Promise(resolve=>entered=resolve),replies=[];
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed'},classify:({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const pending=router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});
 await started;
 assert.equal(await router.request({id:2,method:'turn/interrupt',params:{threadId:'main'}},{respond:reply=>replies.push(reply)}),null);
 await assert.rejects(pending,/cancelled/);
 assert.deepEqual(replies,[{id:2,result:{}}]);assert.equal(router.state.status,'completed');
});
test('a fixed native model and effort do not invoke an unused classifier',async()=>{
 const router=routes.createCodexTurnRouter({config:{...routingPolicy,model:'native/deep',effort:'max'},connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed'},classify:async()=>{throw Error('unused classifier');}});
 const request=await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});
 assert.equal(request.params.model,'deep');assert.equal(request.params.effort,'max');
});
test('native rejection clears only a rejected pending dispatch and rerouting is reported explicitly',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed'},classify:async()=>({answer:newAnswer,source:'A'})});
 const request={id:15,method:'turn/start',params:{threadId:'main',input:[]}};
 await router.request(request);assert.equal(router.state.dispatched,null);
 await router.event({id:15,error:{code:-32602,message:'invalid model'}});assert.equal(router.state.status,'failed');
 await router.request({...request,id:16});
 await router.event({method:'turn/started',params:{threadId:'main',turn:{id:'two'}}});
 assert.equal(router.state.dispatched.model,'native/light');
 await router.event({method:'model/rerouted',params:{threadId:'main',turnId:'two',toModel:'different',reason:'capacity'}});
 assert.equal(router.state.dispatched.model,'native/different');assert.equal(router.state.dispatched.rerouted,true);
 await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'two',status:'completed'}}});
 router.setEnabled(false);const raw={...request,id:17};assert.equal(await router.request(raw),raw);assert.equal(router.state.dispatched,null);
});
test('the desktop launcher exposes native Codex instead of a replacement readline chat',()=>{
 assert.equal(typeof routes.runNativeCodex,'function');
});
test('Codex catalog uses official model capabilities and reports inaccessible connections',async()=>{
 const result=await routes.codexCatalog({config:routingPolicy,codex:process.execPath,cwd:'/tmp'},
  {inspect:async options=>{assert.equal(options.catalogOnly,true);assert.equal(options.env.YAM_AGENT_TOKEN,undefined);return [{model:'regular',displayName:'Regular',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}];}});
 assert.deepEqual(result.models[0].levels,['medium','high']);assert.equal(result.models[0].key,'native/regular');
 const failed=await routes.codexCatalog({config:routingPolicy,codex:process.execPath,cwd:'/tmp'},{inspect:async()=>{throw Error('login missing');}});
 assert.equal(failed.models.length,0);assert.match(failed.warning,/login missing/);
});
test('independent Codex homes cannot overlap the canonical effective native home',async t=>{
 const root=await mkdtemp('/tmp/yam-home-isolation-'),previous=process.env.CODEX_HOME;
 t.after(async()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;await rm(root,{recursive:true,force:true});});
 const native=join(root,'native'),child=join(native,'child'),alias=join(root,'alias'),independent=join(root,'independent');
 await mkdir(native,{mode:0o700});await mkdir(child,{mode:0o700});await mkdir(independent,{mode:0o700});await symlink(native,alias);
 process.env.CODEX_HOME=alias;
 const available=[{model:'light',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
 for(const home of [native,child,root]){
  const config={...routingPolicy,connections:{...routingPolicy.connections,other:{billing:'subscription',home}},classifiers:['other/light']};
  const opened=[],classified=[];
  const listed=await routes.codexCatalog({config,codex:process.execPath,cwd:'/elsewhere'}, {inspect:async ({connection})=>{opened.push(connection.name);return available;}});
  const result=await routes.classifyNativeTurn({policy:config,prompt:'Test',previousPrompt:''},process.execPath,'/elsewhere','/session',{
   classify:async ({connection})=>{classified.push(connection.name);return JSON.stringify(newAnswer);},
  });
  assert.deepEqual(opened,['native']);assert.match(listed.warning,/separate CODEX_HOME/);
  assert.deepEqual(classified,[]);assert.equal(result.source,'local');
 }
 process.env.CODEX_HOME=join(alias,'missing');
 const config={...routingPolicy,connections:{...routingPolicy.connections,overlap:{billing:'paid',home:native,baseUrl:'https://example.com',apiKeyEnv:'YAM_ISOLATION_KEY'},other:{billing:'subscription',home:independent}}};
 const listed=await routes.codexCatalog({config,codex:process.execPath,cwd:'/elsewhere'}, {inspect:async()=>available});
 assert.deepEqual(listed.models.map(model=>model.key),['native/light','other/light']);
 assert.match(listed.warning,/overlap: Codex connection must use a separate CODEX_HOME/);
});

const runtime=await import('../../../scripts/codex-native-routing.mjs').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
const handshake='GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
const upgraded='HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
function frame(text,{mask=true,opcode=1,fin=true}={}){
 const data=Buffer.from(text),key=Buffer.from([1,2,3,4]);
 const extra=data.length<126?0:data.length<=65535?2:8,header=Buffer.alloc(2+extra);
 header[0]=(fin?128:0)|opcode;header[1]=(mask?128:0)|(extra===0?data.length:extra===2?126:127);
 if(extra===2)header.writeUInt16BE(data.length,2);
 if(extra===8)header.writeBigUInt64BE(BigInt(data.length),2);
 return Buffer.concat([header,mask?key:Buffer.alloc(0),mask?data.map((n,i)=>n^key[i%4]):data]);
}
async function setup(t,options={}){
 assert.equal(typeof runtime.createNativeRelay,'function','native Codex needs a bidirectional relay');
 const root=await mkdtemp('/tmp/yam-relay-test-');
 const server=net.createServer(),backend=join(root,'backend.sock');
 let relay,client,peer;
 t.after(async()=>{client?.destroy();peer?.destroy();await relay?.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 server.listen(options.redirectBackend?join(root,'owned.sock'):backend);await once(server,'listening');
 if(options.redirectBackend)await symlink(join(root,'owned.sock'),backend);
 relay=await runtime.createNativeRelay({socketPath:join(root,'front.sock'),backendPath:backend,...options});
 const accepted=once(server,'connection');
 client=net.connect(relay.socketPath);await once(client,'connect');
 [peer]=await accepted;
 const incoming=[],outgoing=[];
 peer.on('data',bytes=>incoming.push(bytes));client.on('data',bytes=>outgoing.push(bytes));
 const waitFor=async(check)=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'expected relay output');};
 client.write(handshake);await waitFor(()=>Buffer.concat(incoming).includes(Buffer.from('\r\n\r\n')));
 peer.write(upgraded);await waitFor(()=>Buffer.concat(outgoing).includes(Buffer.from('101 Switching')));
 incoming.length=0;outgoing.length=0;
 return {client,peer,incoming,outgoing,waitFor};
}
function firstRelayMessage(chunks){
 const frame=Buffer.concat(chunks),short=frame[1]&127,masked=!!(frame[1]&128);
 const offset=short<126?2:short===126?4:10,length=short<126?short:short===126?frame.readUInt16BE(2):Number(frame.readBigUInt64BE(2));
 const key=frame.subarray(offset,offset+4),bytes=frame.subarray(offset+(masked?4:0),offset+(masked?4:0)+length);
 return JSON.parse((masked?bytes.map((value,index)=>value^key[index%4]):bytes).toString());
}
test('relay isolates internal RPC responses and still forwards approval requests and business turns',async t=>{
 const events=[];
 const s=await setup(t,{onEvent:message=>events.push(message),onRequest:async(message,{requestBackend})=>{
  if(message.method==='turn/start')assert.deepEqual(await requestBackend('thread/loaded/list',{}),{data:[]});
  return message;
 }});
 const business={id:4,method:'turn/start',params:{threadId:'main',input:[]}};
 s.client.write(frame(JSON.stringify(business)));
 await s.waitFor(()=>s.incoming.length&&firstRelayMessage(s.incoming).method==='thread/loaded/list');
 const internal=firstRelayMessage(s.incoming);
 assert.equal(typeof internal.id,'string');assert.notEqual(internal.id,business.id);s.incoming.length=0;
 const approval={id:internal.id,method:'item/commandExecution/requestApproval',params:{}};
 s.peer.write(frame(JSON.stringify(approval),{mask:false}));
 s.peer.write(frame(JSON.stringify({id:internal.id,result:{data:[]}}),{mask:false}));
 await s.waitFor(()=>s.incoming.length&&s.outgoing.length);
 assert.deepEqual(firstRelayMessage(s.incoming),business);
 assert.deepEqual(Buffer.concat(s.outgoing),frame(JSON.stringify(approval),{mask:false}));
 assert.deepEqual(events,[approval]);
});
test('relay rejects outstanding internal requests on disconnect and discards late cancelled replies',async t=>{
 const events=[],finished=[];
 const s=await setup(t,{onEvent:message=>events.push(message),onRequest:async(message,{requestBackend})=>{
  try{await requestBackend('thread/loaded/list',{},{signal:message.params?.cancel?AbortSignal.timeout(100):undefined});}
  catch(error){finished.push(error);}
  return null;
 }});
 s.client.write(frame(JSON.stringify({id:1,method:'test',params:{cancel:true}})));
 await s.waitFor(()=>s.incoming.length||finished.length);
 const internal=firstRelayMessage(s.incoming);s.incoming.length=0;
 await s.waitFor(()=>finished.length===1);
 s.peer.write(frame(JSON.stringify({id:internal.id,result:{data:[]}}),{mask:false}));
 s.client.write(frame(JSON.stringify({id:2,method:'test'})));
 await s.waitFor(()=>s.incoming.length);
 s.peer.destroy();await s.waitFor(()=>finished.length===2);
 assert.deepEqual(events,[]);assert.match(finished[1].message,/disconnect|closed|abort/i);
});
test('native relay preserves both directions, approval requests, replies and stream events',async t=>{
 const s=await setup(t);
 const approval=frame(JSON.stringify({id:7,method:'item/commandExecution/requestApproval'}),{mask:false});
 const reply=frame(JSON.stringify({id:7,result:{decision:'accept'}}));
 s.peer.write(approval);s.client.write(reply);
 await s.waitFor(()=>s.incoming.length&&s.outgoing.length);
 assert.deepEqual(Buffer.concat(s.outgoing),approval);
 assert.deepEqual(Buffer.concat(s.incoming),reply);
});
test('native relay applies a per-turn decision without replacing native input or approvals',async t=>{
 const seen=[];
 const s=await setup(t,{onRequest:async message=>{seen.push(message);return message.method==='turn/start'?{...message,params:{...message.params,model:'small',effort:'medium'}}:message;}});
 const input={id:3,method:'turn/start',params:{threadId:'thread',input:[]}};
 s.client.write(frame(JSON.stringify(input)));
 await s.waitFor(()=>s.incoming.length);
 const received=Buffer.concat(s.incoming),length=received[1]&127,key=received.subarray(2,6);
 const decoded=JSON.parse(received.subarray(6,6+length).map((n,i)=>n^key[i%4]).toString());
 assert.deepEqual(decoded,{...input,params:{...input.params,model:'small',effort:'medium'}});
 assert.equal(seen.length,1);
});
test('native relay handles split and fragmented messages without duplicate dispatch',async t=>{
 let requests=0;
 const s=await setup(t,{onRequest:async message=>{requests++;return message;}});
 const first=frame('{"id":4,',{fin:false}),last=frame('"method":"turn/start","params":{}}',{opcode:0});
 s.client.write(first.subarray(0,3));s.client.write(first.subarray(3));s.client.write(last);
 await s.waitFor(()=>s.incoming.length);
 assert.equal(requests,1);
});
test('native relay preserves interrupt and the next turn without persisting a pending lock',async t=>{
 const seen=[];const s=await setup(t,{onRequest:async message=>{seen.push(message.method);return message;}});
 for(const method of ['turn/start','turn/interrupt','turn/start'])s.client.write(frame(JSON.stringify({id:seen.length+1,method,params:{}})));
 await s.waitFor(()=>seen.length===3);
 assert.deepEqual(seen,['turn/start','turn/interrupt','turn/start']);
});
test('native relay closes its own connection on malformed input instead of forwarding it',async t=>{
 const s=await setup(t);const closed=once(s.client,'close');
 s.client.write(frame('{invalid'));
 await closed;
 assert.equal(s.incoming.length,0);
});
test('native relay reports a callback fault once without logging protocol contents',async t=>{
 const diagnostics=[],s=await setup(t,{onError:reason=>diagnostics.push(reason),onEvent:()=>{throw Error('private-token-from-callback');}});
 const closed=once(s.client,'close');
 const message=frame(JSON.stringify({method:'thread/status/changed',params:{value:'private-payload'}}),{mask:false});
 s.peer.write(Buffer.concat([message,message]));
 await closed;
 assert.equal(diagnostics.length,1);
 assert.match(diagnostics[0],/Codex relay.*App Server event/);
 assert.doesNotMatch(diagnostics[0],/private-token|private-payload/);
 assert.equal(s.outgoing.length,0);
 const normal=await setup(t,{onError:reason=>diagnostics.push(reason)}),disconnected=once(normal.client,'close');
 normal.client.end();await disconnected;
 assert.equal(diagnostics.length,1);
});
test('native relay accepts the official owned private socket redirect',async t=>{
 const s=await setup(t,{redirectBackend:true});
 const message=frame('{"id":1,"method":"initialize","params":{}}');
 s.client.write(message);await s.waitFor(()=>s.incoming.length);
 assert.deepEqual(Buffer.concat(s.incoming),message);
});
test('native relay preserves extended length payloads and interleaved control frames',async t=>{
 const s=await setup(t);
 const messages=[126,65536].map(size=>frame(JSON.stringify({id:size,params:{text:'x'.repeat(size)}})));
 const ping=frame('ping',{opcode:9});
 s.client.write(Buffer.concat([ping,...messages]));
 const expected=Buffer.concat([ping,...messages]);
 await s.waitFor(()=>Buffer.concat(s.incoming).length===expected.length);
 assert.deepEqual(Buffer.concat(s.incoming),expected);
});
test('native relay forwards a valid 30 MiB App Server plugin catalog response',async t=>{
 const errors=[],seen=[],s=await setup(t,{onError:reason=>errors.push(reason),onEvent:message=>seen.push(message.result.plugins[0].description.length)});
 const description='x'.repeat(30*1024*1024),response=frame(JSON.stringify({id:'plugin-list-fixture',result:{plugins:[{description}]}}),{mask:false});
 s.peer.write(response.subarray(0,3));s.peer.write(response.subarray(3,11));s.peer.write(response.subarray(11));
 await s.waitFor(()=>errors.length||s.outgoing.reduce((length,chunk)=>length+chunk.length,0)===response.length);
 assert.deepEqual(errors,[]);assert.deepEqual(seen,[description.length]);
 assert.ok(Buffer.concat(s.outgoing).equals(response));
});
test('native relay enforces the App Server response ceiling from its frame header',async t=>{
 const errors=[],s=await setup(t,{onError:reason=>errors.push(reason)}),closed=once(s.client,'close');
 const header=Buffer.from([0x81,127,0,0,0,0,0,0,0,0]);
 header.writeBigUInt64BE(BigInt(128*1024*1024+1),2);
 s.peer.write(header);await closed;
 assert.equal(s.outgoing.length,0);assert.match(errors[0],/Oversized Codex frame/);
});
test('native relay preserves fragmented masked UTF-8 and rejects invalid UTF-8',async t=>{
 const seen=[],s=await setup(t,{onRequest:async message=>{seen.push(message);return message;}});
 const message={id:13,method:'thread/name/set',params:{name:'测试🧪'}},payload=Buffer.from(JSON.stringify(message));
 const split=payload.indexOf(Buffer.from('🧪'))+1;
 const start=frame(payload.subarray(0,split),{fin:false}),end=frame(payload.subarray(split),{opcode:0});
 const ping=frame('ping',{opcode:9});s.client.write(Buffer.concat([start,ping,end]));
 await s.waitFor(()=>seen.length&&Buffer.concat(s.incoming).length===start.length+ping.length+end.length);
 assert.deepEqual(seen,[message]);assert.deepEqual(Buffer.concat(s.incoming),Buffer.concat([ping,start,end]));
 const closed=once(s.client,'close');s.client.write(frame(Buffer.from([0xff])));await closed;
 assert.deepEqual(seen,[message]);
});
test('native relay bounds cumulative payload and header bytes of fragmented messages',async t=>{
 const errors=[],upstream=await setup(t,{onError:reason=>errors.push(reason)}),clientClosed=once(upstream.client,'close');
 const first=frame('x'.repeat(4*1024*1024),{fin:false}),continuation=Buffer.from([0x80,0xff,0,0,0,0,0,0,0,0]);
 continuation.writeBigUInt64BE(BigInt(4*1024*1024+1),2);
 upstream.client.write(first);upstream.client.write(continuation);await clientClosed;
 assert.equal(upstream.incoming.length,0);
 const downstream=await setup(t,{onError:reason=>errors.push(reason)}),serverClosed=once(downstream.client,'close');
 const emptyFragments=Buffer.alloc(64*1024+2);emptyFragments[0]=1;
 downstream.peer.write(emptyFragments);await serverClosed;
 assert.equal(downstream.outgoing.length,0);
 assert.deepEqual(errors,['Native Codex relay client message: Oversized Codex message','Native Codex relay App Server message: Oversized Codex message']);
});
test('native relay rejects unmasked clients, invalid fragments, oversized frames and callback failure',async t=>{
 for(const bytes of [frame('{}',{mask:false}),frame('{}',{opcode:0}),Buffer.from([0x81,0xff,0,0,0,0,0,0x80,0,1])]){
  await t.test('invalid frame '+bytes.toString('hex').slice(0,20),async sub=>{
   const s=await setup(sub);const closed=once(s.client,'close');s.client.write(bytes);await closed;
   assert.equal(s.incoming.length,0);
  });
 }
 await t.test('routing failure does not dispatch the request and returns a native RPC error',async sub=>{
  const s=await setup(sub,{onRequest:async()=>{throw Error('decision unavailable');}});
  s.client.write(frame('{"id":1,"method":"turn/start"}'));await s.waitFor(()=>s.outgoing.length);
  assert.equal(s.incoming.length,0);
  assert.match(Buffer.concat(s.outgoing).toString(),/decision unavailable/);
 });
});
test('interrupts pass while a native turn is waiting for classification',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve),seen=[];
 const s=await setup(t,{onRequest:async(message)=>{seen.push(message.method);if(message.method==='turn/start')await wait;return message;}});
 s.client.write(frame('{"id":1,"method":"turn/start"}'));
 s.client.write(frame('{"id":2,"method":"turn/interrupt"}'));
 try{await s.waitFor(()=>seen.includes('turn/interrupt'));}finally{release();}
});
test('native routing bar renders planned and dispatched models and switches Codex policies',async()=>{
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module');
 const {codexRoutingConfig,compatibleRoutingPolicies}=await import('../src/routing-policies.ts');
 const {piModelCatalogSource}=await import('../src/pi-routing.ts');
 const ts=createRequire(new URL('../package.json',import.meta.url))('typescript');
 const source=ts.createSourceFile('PiRouting.tsx',readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=source.statements.find(n=>n.name?.text==='NativeCodexRoutingBar');assert.ok(declaration);
 const state={generation:'g',revision:8,phase:'working',enabled:true,name:'Current',policyId:null,target:{model:'native/light',effort:'medium'},dispatched:{model:'native/light',effort:'medium'}};
 const slots=[state,null,false],React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};let at=0;const calls=[];
 const helper=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='routingModelPresentation');
 const component=new Function('React','useState','useEffect','useRef','Select','t','compatibleRoutingPolicies','codexRoutingConfig','piModelCatalogSource',ts.transpileModule(helper.getText(source)+'\n'+declaration.getText(source).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return NativeCodexRoutingBar;')(React,initial=>{const i=at++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>slots[i]=value];},()=>{},{},'select',(value,args)=>value.replace(/{{(.*?)}}/g,(_,key)=>args?.[key]??key),compatibleRoutingPolicies,codexRoutingConfig,piModelCatalogSource);
 const saved=JSON.stringify(routingPolicy);
 const render=(next=state,launchConfig)=>{at=0;slots[0]=next;return component({sessionId:'s',generation:'g',active:true,available:true,launchConfig,invoke:async(command,args)=>{calls.push({command,args});return {state};},policies:[{id:'c',name:'Codex policy',adapter:'codex',setup:saved},{id:'p',name:'Pi policy',adapter:'pi',setup:'{}'}]});};
 const tree=render();
 const all=n=>[n,...(n?.children??[]).filter(x=>x&&typeof x==='object').flatMap(all)];
 assert.match(JSON.stringify(tree),/Dispatched model: native\/light/);assert.doesNotMatch(JSON.stringify(tree),/Pi policy/);
 const gateway='yam-codex/auto/deepseek-v4-flash',launchConfig=JSON.stringify({...mixedPolicy,connections:{native:routingPolicy.connections.native,'yam-codex':mixedPolicy.connections.local},executionGroups:[{small:gateway,medium:gateway,strong:'native/deep'}]});
 const dispatched=JSON.stringify(render({...state,dispatched:{model:gateway,effort:'high'}},launchConfig));
 assert.match(dispatched,/Dispatched model: Local gateway · Automatic routing · deepseek-v4-flash · high/);
 assert.doesNotMatch(dispatched,/yam-codex/);
 const planned=JSON.stringify(render({...state,policyId:'c',dispatched:null}));
 assert.match(planned,/Selected for this turn: Codex native · ChatGPT subscription · light · medium/);
 await all(tree).find(n=>n.type==='select').props.onChange({target:{value:'c'}});
 assert.equal(calls[0].args.request.revision,8);assert.deepEqual(calls[0].args.request.data,{policy:{id:'c',name:'Codex policy',config:saved}});
});
test('local Codex gateway reads DeepSeek capabilities instead of the OpenAI catalog',async t=>{
 const {createServer}=await import('node:http');let requests=0;
 const server=createServer((request,response)=>{requests++;assert.equal(request.url,'/v1/models');assert.equal(request.headers.authorization,undefined);response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{id:'deepseek/deepseek-v4-pro',display_name:'DeepSeek V4 Pro',reasoning:true,reasoning_levels:['none','low','high','max'],modalities:{input:['text']},context_window:1048576}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const config={...routingPolicy,connections:{...routingPolicy.connections,local:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:'+server.address().port}}};
 const result=await routes.codexCatalog({config,codex:process.execPath,cwd:'/tmp'}, {inspect:async()=>[]});
 assert.equal(requests,1);assert.equal(result.models[0].key,'local/deepseek/deepseek-v4-pro');assert.deepEqual(result.models[0].levels,['off','low','high','max']);assert.equal(result.models[0].cli,'codex');
 const {readCodexPolicy}=await import('../src-tauri/pi/codex-route-config.mjs');
 for(const baseUrl of ['http://192.168.1.1:3425','http://127.0.0.1:3425/?token=bad','http://user:secret@localhost:3425'])assert.throws(()=>readCodexPolicy(JSON.stringify({...config,connections:{...config.connections,local:{billing:'paid',gateway:true,baseUrl}}})),/gateway/i);
});
test('an explicit gateway classifier is allowed but never mixed with subscription fallback billing',async()=>{
 const {readCodexPolicy}=await import('../src-tauri/pi/codex-route-config.mjs');
 const config={connections:{local:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}},classifiers:['local/deepseek/pro'],executionGroups:[{small:'local/deepseek/pro',medium:'local/deepseek/pro',strong:'local/deepseek/pro'}],effort:'high'};
 assert.equal(readCodexPolicy(JSON.stringify(config)).classifiers[0],'local/deepseek/pro');
 assert.throws(()=>readCodexPolicy(JSON.stringify({...config,connections:{...config.connections,...routingPolicy.connections},classifiers:['local/deepseek/pro','native/classifier']})),/billing|channel/);
});
test('a native turn with routing off clears the earlier routed continuation choice',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,classify:async()=>({answer:newAnswer,source:'A'}),initial:{threadId:'thread',status:'completed',previous:{v:2,model:'strong',effort:'high',identity:'native/deep'},previousPrompt:'old task'}});
 router.setEnabled(false);const message={id:1,method:'turn/start',params:{threadId:'thread',model:'regular',input:[{type:'text',text:'another task'}]}};
 assert.deepEqual(await router.request(message),message);await router.event({method:'turn/started',params:{threadId:'thread',turn:{id:'off'}}});assert.equal(router.state.previous,null);assert.equal(router.state.previousPrompt,'');
});

test('resume reconciles a persisted working turn using paginated native turn history',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',turnId:'lost',status:'working'},classify:async()=>({answer:newAnswer,source:'A'})});
 await router.request({id:1,method:'thread/resume',params:{threadId:'main'}});await router.event({id:1,result:{thread:{id:'main',turns:[]}}});
 await router.request({id:2,method:'thread/turns/list',params:{threadId:'other'}});await router.event({id:2,result:{data:[{id:'lost',status:'completed'}]}});assert.equal(router.state.status,'working');
 await router.request({id:3,method:'thread/turns/list',params:{threadId:'main'}});await router.event({id:3,result:{data:[{id:'different',status:'completed'},{id:'lost',status:'interrupted'}]}});
 assert.equal(router.state.status,'interrupted');assert.equal((await router.request({id:4,method:'turn/start',params:{threadId:'main',input:[]}})).params.model,'light');
});
test('rejected native submissions retain the last accepted continuation model and prompt',async()=>{
 let answer=newAnswer;const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed',previous:{v:2,model:'small',effort:'medium',identity:'native/light'},previousPrompt:'accepted question'},classify:async()=>({answer,source:'A'})});
 answer={...newAnswer,task:'coding',action:'write',readOnly:false};await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[{type:'text',text:'rejected change'}]}});await router.event({id:1,error:{code:-32602}});
 assert.equal(router.state.previous.identity,'native/light');assert.equal(router.state.previousPrompt,'accepted question');answer={...answer,intent:'continue'};
 assert.equal((await router.request({id:2,method:'turn/start',params:{threadId:'main',input:[]}})).params.model,'light');
});
test('reopen pins the persisted native connection even when policy defaults change after routing off',()=>{
 assert.equal(typeof routes.nativeSessionConnection,'function');
 const native={name:'native',billing:'subscription',native:true},gateway={name:'local',billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425/v1'},connections=new Map([['native',native],['local',gateway]]);
 assert.equal(routes.nativeSessionConnection(connections,{v:2,threadId:'main',connectionName:'native',previous:null},gateway),native);
 assert.equal(routes.nativeSessionConnection(connections,null,gateway),gateway);
 assert.throws(()=>routes.nativeSessionConnection(new Map([['local',gateway]]),{v:2,threadId:'main',connectionName:'native'},gateway),/connection/i);
});
test('native classifier timeout waits for cleanup then uses its same-billing backup',async()=>{
 assert.equal(typeof routes.classifyNativeTurn,'function');
 const config={...routingPolicy,classifiers:['native/classifier','native/deep']};
 for(const mayBeRunning of [false,true]){
  const seen=[];const result=await routes.classifyNativeTurn({policy:config,prompt:'task',previousPrompt:''},process.execPath,'/tmp','/tmp/session',{
   timeout:ms=>AbortSignal.timeout(ms===45000?10:1000),
   classify:async({model,signal})=>{seen.push(model);if(model==='deep')return JSON.stringify(newAnswer);await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,15);});throw Object.assign(Error('cancelled'),{mayBeRunning});},
  });
  assert.deepEqual(seen,mayBeRunning?['classifier']:['classifier','deep']);assert.equal(result.source,mayBeRunning?'local':'B');
 }
});

test('a fresh native gateway terminal bootstraps its selected model before routing is disabled',async()=>{
 const {codexConnectionArgs}=await import('../../../scripts/codex-route-app-server.mjs');
 const connection={billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425/v1'};
 const args=codexConnectionArgs(connection,undefined,{model:'deepseek/deepseek-v4-pro',effort:'high'});
 assert.ok(args.includes('model="deepseek/deepseek-v4-pro"'));assert.ok(args.includes('model_reasoning_effort="high"'));
 assert.equal(codexConnectionArgs(connection).some(value=>value.startsWith('model=')),false);
});

test('saved native policy identity is independent of JSON key order but detects endpoint changes',()=>{
 assert.equal(typeof routes.sameNativeConnection,'function');assert.equal(typeof routes.nativeConnectionBinding,'function');
 const a={...routingPolicy,connections:{native:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}}};
 const b={...a,connections:{native:{baseUrl:'http://127.0.0.1:3425',gateway:true,billing:'paid'}}};
 assert.equal(routes.sameNativeConnection(a,b,'native'),true);
 assert.equal(routes.sameNativeConnection(a,{...b,connections:{native:{...b.connections.native,baseUrl:'http://127.0.0.1:3426'}}},'native'),false);
 const left={name:'native',...a.connections.native},right={...b.connections.native,name:'native'};
 assert.equal(routes.nativeConnectionBinding('/codex','/tmp',left,'/home'),routes.nativeConnectionBinding('/codex','/tmp',right,'/home'));
 assert.notEqual(routes.nativeConnectionBinding('/codex','/tmp',left,'/home'),routes.nativeConnectionBinding('/codex','/other',left,'/home'));
});

test('native accepted response and authoritative idle recovery resolve an uncorrelated pending submission without replay',async()=>{
 const make=initial=>routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial,classify:async()=>({answer:newAnswer,source:'A'})});
 const router=make({threadId:'main',status:'completed',turnId:'old'});
 await router.request({id:9,method:'turn/start',params:{threadId:'main',input:[]}});
 await router.event({id:9,result:{turn:{id:'accepted',status:'inProgress'}}});
 assert.equal(router.state.turnId,'accepted');assert.equal(router.state.status,'working');
 await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'accepted',status:'completed'}}});
 const recovered=make({threadId:'main',status:'pending',requestId:9,turnId:null,pendingAfterTurnId:'old',pendingRoute:{previous:{identity:'native/deep'}}});
 await recovered.request({id:9,method:'thread/resume',params:{threadId:'main'}});
 await recovered.event({id:9,result:{thread:{id:'main',status:{type:'idle'},turns:[{id:'finished',status:'completed'}]},model:'regular',reasoningEffort:'high'}});
 assert.equal(recovered.state.status,'completed');assert.equal(recovered.state.turnId,'finished');assert.equal(recovered.state.pendingRoute,null);
 assert.equal(recovered.state.previous,null,'do not attribute an uncorrelated historical turn to a planned route');
 assert.deepEqual(recovered.state.nativeModel,{model:'regular',effort:'high'});
 await recovered.request({id:10,method:'turn/start',params:{threadId:'main',input:[]}});
 const empty=make({threadId:'main',status:'pending',turnId:null});
 await empty.request({id:1,method:'thread/resume',params:{threadId:'main'}});await empty.event({id:1,result:{thread:{id:'main',status:{type:'idle'},turns:[]}}});
 assert.equal(empty.state.status,'failed');assert.match(empty.state.error,/history/i);
 const active=make({threadId:'main',status:'pending',turnId:null});
 await active.request({id:1,method:'thread/resume',params:{threadId:'main'}});await active.event({id:1,result:{thread:{id:'main',status:{type:'active'},turns:[]}}});
 await assert.rejects(active.request({id:2,method:'turn/start',params:{threadId:'main',input:[]}}),/Inspect/);
});

test('native model snapshot follows accepted manual settings and never a rejected or rerouted guess',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed',nativeModel:{model:'light',effort:'medium'}}});router.setEnabled(false);
 await router.request({id:1,method:'turn/start',params:{threadId:'main',model:'regular',effort:'high',input:[]}});
 assert.deepEqual(router.state.nativeModel,{model:'light',effort:'medium'});
 await router.event({id:1,error:{code:-32602}});assert.equal(router.state.nativeModel.model,'light');
 await router.request({id:2,method:'turn/start',params:{threadId:'main',collaborationMode:{settings:{model:'deep',reasoning_effort:'max'}},input:[]}});
 await router.event({method:'turn/started',params:{threadId:'main',turn:{id:'turn'}}});assert.deepEqual(router.state.nativeModel,{model:'deep',effort:'max'});
 await router.event({method:'model/rerouted',params:{threadId:'main',turnId:'turn',toModel:'other'}});assert.deepEqual(router.state.nativeModel,{model:'other',effort:null});
});

test('native lifecycle retries completion and reconciles history idempotently before the next turn',async()=>{
 assert.equal(typeof routes.createNativeLifecycleBridge,'function');const sent=[];let failures=2;
 const bridge=routes.createNativeLifecycleBridge({deliver:async(kind,thread,turn)=>{sent.push([kind,thread,turn]);if(kind==='TurnComplete'&&failures-->0)throw Error('offline');},wait:async()=>{}});
 const state={threadId:'main',turnId:'done',status:'completed'};await bridge.sync(state);await bridge.sync(state);
 assert.equal(sent.filter(x=>x[0]==='TurnComplete').length,3);assert.equal(sent.filter(x=>x[0]==='UserPromptSubmit').length,1);
 await bridge.sync({...state,turnId:'next',status:'working'});assert.equal(sent.at(-1)[0],'UserPromptSubmit');
 const broken=routes.createNativeLifecycleBridge({deliver:async()=>{throw Error('offline');},wait:async()=>{}});await assert.rejects(broken.sync(state),/offline/);
 const reopened=[];const recovered=routes.createNativeLifecycleBridge({deliver:async(...args)=>reopened.push(args)});await recovered.sync(state);assert.deepEqual(reopened.map(x=>x[0]),['SessionStart','UserPromptSubmit','TurnComplete']);
});

test('disabled copy bootstrap validates the exact native model and effort without catalog substitution',()=>{
 assert.equal(typeof routes.nativeInitialModel,'function');const connection={name:'native'};
 assert.deepEqual(routes.nativeInitialModel({connection,selected:{connection,model:'light'},effort:'medium',snapshot:{model:'deep',effort:'max'},models:catalog}),{model:'deep',effort:'max'});
 for(const snapshot of [{model:'missing',effort:'high'},{model:'deep',effort:'unknown'},{model:'deep',effort:null}])assert.throws(()=>routes.nativeInitialModel({connection,selected:{connection,model:'light'},effort:'medium',snapshot,models:catalog}),/unavailable|unsupported/i);
 assert.throws(()=>routes.nativeInitialModel({connection,selected:{connection:{name:'other'},model:'light'},effort:'medium',models:catalog}),/original.*model/i);
});

test('idle resume with paginated history reconciles its latest completed turn only before a new request',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'pending',turnId:null,pendingAfterTurnId:'old'},classify:async()=>({answer:newAnswer,source:'A'})});
 await router.request({id:1,method:'thread/resume',params:{threadId:'main'}});await router.event({id:1,result:{thread:{id:'main',status:{type:'idle'},turns:[]},turnsBackwardsCursor:'latest'}});
 await router.request({id:2,method:'thread/turns/list',params:{threadId:'main',cursor:'older'}});await router.event({id:2,result:{data:[{id:'old',status:'completed'}]}});assert.equal(router.state.turnId,null);
 await router.request({id:3,method:'thread/turns/list',params:{threadId:'main',cursor:'latest'}});await router.event({id:3,result:{data:[{id:'latest-turn',status:'completed'}]}});assert.equal(router.state.turnId,'latest-turn');assert.equal(router.state.status,'completed');
});

test('uncorrelated pending recovery never attributes the older completed turn to an unsent prompt',async()=>{
 const initial={threadId:'main',status:'pending',turnId:null,pendingAfterTurnId:'old'};
 const make=()=>routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial});
 for(const withAnchor of [true,false]){
  const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:withAnchor?initial:{...initial,pendingAfterTurnId:undefined}});
  await router.request({id:1,method:'thread/resume',params:{threadId:'main'}});await router.event({id:1,result:{thread:{id:'main',status:{type:'idle'},turns:[{id:'old',status:'completed'}]}}});
  assert.equal(router.state.status,'failed');assert.equal(router.state.turnId,null);assert.match(router.state.error,/history/i);
 }
 const router=make();await router.request({id:1,method:'thread/resume',params:{threadId:'main'}});await router.event({id:1,result:{thread:{id:'main',status:{type:'active'},turns:[]}}});
 await router.request({id:2,method:'thread/turns/list',params:{threadId:'main'}});await router.event({id:2,result:{data:[{id:'new',status:'completed'}]}});assert.equal(router.state.status,'completed');assert.equal(router.state.turnId,'new');
});

test('native pending retains its prior turn anchor and terminal-first acceptance records actual dispatch',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed',turnId:'old'},classify:async()=>({answer:newAnswer,source:'A'})});
 await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});assert.equal(router.state.pendingAfterTurnId,'old');
 await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'new',status:'completed'}}});assert.deepEqual(router.state.dispatched,{model:'native/light',effort:'medium'});
});

test('changing native strategy clears only the old continuation binding',async()=>{
 const router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'completed',turnId:'old',previous:{v:2,model:'small',effort:'medium',identity:'native/light'},previousPrompt:'old'},classify:async()=>({answer:{...newAnswer,intent:'continue'},source:'A'})});
 router.setPolicy({...routingPolicy,executionGroups:[{small:'native/deep',medium:'native/deep',strong:'native/deep'}]});
 const next=await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});assert.equal(next.params.model,'deep');assert.equal(router.state.threadId,'main');
});

test('legacy Codex continuation retains the actual backup and version like Pi',async()=>{
 const {defaultRules}=await import('../src-tauri/pi/task-rules.mjs');let answer=newAnswer;
 const config={...routingPolicy,rules:defaultRules,executionGroups:[{small:'native/missing',strong:'native/deep'},{small:'native/light'}]};
 const router=routes.createCodexTurnRouter({config,connectionName:'native',models:catalog,initial:{threadId:'main',status:'idle'},classify:async()=>({answer,source:'A'})});
 assert.equal((await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}})).params.model,'light');
 await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'one',status:'completed'}}});assert.equal(router.state.previous.v,1);
 answer={...newAnswer,intent:'continue',context:'dependent'};assert.equal((await router.request({id:2,method:'turn/start',params:{threadId:'main',input:[]}})).params.model,'light');
});

test('native lifecycle restores acknowledged outcomes without requesting another inbox receipt',async()=>{
 let saved;const sent=[],state={threadId:'main',turnId:'done',status:'completed'};
 const first=routes.createNativeLifecycleBridge({deliver:async(...args)=>sent.push(args),acknowledge:async marker=>{saved=marker;}});await first.sync(state);assert.deepEqual(saved,{threadId:'main',turnId:'done',status:'completed'});
 const reopened=[];const second=routes.createNativeLifecycleBridge({initial:saved,deliver:async(...args)=>reopened.push(args)});await second.sync(state);await second.sync(state);assert.deepEqual(reopened.map(x=>x[0]),['SessionStart','UserPromptSubmit','TurnComplete']);assert.equal(reopened.at(-1)[4],'codex-resume');
 await second.sync({...state,turnId:'new'});assert.equal(reopened.at(-1)[0],'TurnComplete');
});

test('rejected submissions preserve the history anchor through a subsequent crash with routing on or off',async()=>{
 for(const enabled of [true,false]){
  const make=initial=>routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial,classify:async()=>({answer:newAnswer,source:'A'})});
  const router=make({threadId:'main',status:'completed',turnId:'accepted'});router.setEnabled(enabled);
  for(const id of [1,2]){
   await router.request({id,method:'turn/start',params:{threadId:'main',input:[]}});
   await router.event({id,error:{code:-32602}});
  }
  await router.request({id:3,method:'turn/start',params:{threadId:'main',input:[]}});
  assert.equal(router.state.pendingAfterTurnId,'accepted');
  const reopened=make(router.state);
  await reopened.request({id:4,method:'thread/resume',params:{threadId:'main'}});
  await reopened.event({id:4,result:{thread:{id:'main',status:{type:'idle'},turns:[{id:'accepted',status:'completed'}]}}});
  assert.equal(reopened.state.turnId,null);assert.equal(reopened.state.status,'failed');assert.match(reopened.state.error,/history/i);
 }
});

test('legacy native local continuation preserves accepted effort unless explicitly overridden',async()=>{
 const {defaultRules}=await import('../src-tauri/pi/task-rules.mjs');
 for(const override of [undefined,'high']){
  const router=routes.createCodexTurnRouter({config:{...routingPolicy,rules:defaultRules,...override?{effort:override}:{}},connectionName:'native',models:catalog.map(x=>({...x,levels:override?['medium','high']:['medium']})),initial:{threadId:'main',status:'completed',turnId:'old',previous:{v:1,model:'small',effort:'medium',identity:'native/light'}},classify:async()=>({answer:null,source:'local'})});
  const next=await router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});
  assert.equal(next.params.model,'light');assert.equal(next.params.effort,override??'medium');
 }
});

test('acknowledged failed and interrupted outcomes restore once per runtime and retry failed delivery',async()=>{
 for(const [status,kind] of [['failed','TurnFailed'],['interrupted','Interrupt']]){
  const state={threadId:'main',turnId:'old',status},sent=[];let fail=true;
  const bridge=routes.createNativeLifecycleBridge({initial:state,wait:async()=>{},deliver:async(...args)=>{sent.push(args);if(args[0]===kind&&fail){fail=false;throw Error('offline');}}});
  await bridge.sync(state);await bridge.sync(state);
  const terminal=sent.filter(x=>x[0]===kind);assert.equal(terminal.length,2);assert.ok(terminal.every(x=>x[4]==='codex-resume'));
 }
});

test('queued native policy persists and settles when a turn ends, including terminal history recovery',async()=>{
 for(const status of ['completed','interrupted','failed']){
  let settled=0;const saved=[];let router;
  router=routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,initial:{threadId:'main',status:'working',turnId:'one'},save:async s=>saved.push(s),onSettled:async()=>{if(router.state.pendingPolicy){settled++;await router.queuePolicy(null);}}});
  await router.queuePolicy({});assert.deepEqual(saved.at(-1).pendingPolicy,{});assert.equal(settled,0);
  await router.event({method:'turn/completed',params:{threadId:'main',turn:{id:'one',status}}});assert.equal(settled,1);assert.equal(router.state.pendingPolicy,null);
 }
});

test('persisted native pending policy validates the original connection and survives cancelled classification',async()=>{
 const make=extra=>routes.createCodexTurnRouter({config:routingPolicy,connectionName:'native',models:catalog,...extra});
 assert.throws(()=>make({initial:{pendingPolicy:{name:'bad',id:'x',config:'{}'}}}),/routing|configuration/i);
 const wrong={...routingPolicy,connections:{native:{billing:'paid',gateway:true,baseUrl:'http://localhost:3425'}}};
 const idle=make({initial:{threadId:'main',status:'idle'}});await assert.rejects(idle.queuePolicy({name:'wrong',id:'x',config:JSON.stringify(wrong)}),/connection/i);
 let entered;const ready=new Promise(resolve=>entered=resolve);const router=make({initial:{threadId:'main',status:'completed'},classify:({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})});
 const pending=router.request({id:1,method:'turn/start',params:{threadId:'main',input:[]}});await ready;await router.queuePolicy({});await router.request({id:2,method:'turn/interrupt',params:{threadId:'main'}},{respond:()=>{}});await assert.rejects(pending,/cancelled/);assert.deepEqual(router.state.pendingPolicy,{});
});
