// Author: Jeff.Liu. Offline evidence checks; no model or GUI is started.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const api=await import('../../../scripts/goal-delivery-acceptance.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const root='01234567-1234-1234-1234-0123456789ab',child='11234567-1234-1234-1234-0123456789ab';
function trace(id,model,parent){return [
 {type:'session_meta',payload:{id,model_provider:'openai',...parent?{parent_thread_id:parent,source:{subagent:{thread_spawn:{parent_thread_id:parent,depth:1}}}}:{}}},
 {type:'turn_context',payload:{model}},
];}
test('goal delivery exports offline evidence checks without running live inference',()=>{for(const key of ['inspectNativeTrace','verifyTraceFamily','checkGoalArtifacts','runGoalDelivery'])assert.equal(typeof api[key],'function',key);});
test('native collaboration evidence binds actual models, provider and parent session instead of claimed text',()=>{
 const main=trace(root,'main');main.push({type:'response_item',payload:{type:'function_call',name:'spawn_agent',arguments:JSON.stringify({model:'helper',fork_turns:'none',task_name:'review'})}});
 const a=api.inspectNativeTrace(main),b=api.inspectNativeTrace(trace(child,'helper',root));assert.equal(api.verifyTraceFamily(a,[b],{main:'main',helper:'helper'}),true);
 for(const change of ['provider','model','parent','depth','recursion']){
  const c=structuredClone(b);if(change==='provider')c.provider='paid';if(change==='model')c.models=['main'];if(change==='parent')c.parent='foreign';if(change==='depth')c.depth=2;if(change==='recursion')c.spawnCalls=[{model:'another'}];
  assert.throws(()=>api.verifyTraceFamily(a,[c],{main:'main',helper:'helper'}),undefined,change);
 }
 assert.throws(()=>api.verifyTraceFamily({...a,spawnCalls:[]},[b],{main:'main',helper:'helper'}));
});
test('malformed native spawn arguments and model-free claims cannot become collaboration evidence',()=>{
 assert.throws(()=>api.inspectNativeTrace([...trace(root,'main'),{type:'response_item',payload:{type:'function_call',name:'spawn_agent',arguments:'not JSON'}}]));
 const a=api.inspectNativeTrace([...trace(root,'main'),{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'I called helper'}]}}]);assert.equal(a.spawnCalls.length,0);
});
test('portable PRD checks require real local image references and reject traversal or missing files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'yam-goal-test-'));
 try{
  await mkdir(join(directory,'assets'));await writeFile(join(directory,'assets/board.png'),Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  const document='# PRD\n标题必填，最多80字符。\n'+Array.from({length:6},(_,i)=>'AC-'+(i+1)).join(' ')+'\n![board](assets/board.png)';await writeFile(join(directory,'PRD.md'),document);
  const result=await api.checkGoalArtifacts(directory,'PRD.md',async()=>true);assert.equal(result.image,'assets/board.png');
  await assert.rejects(api.checkGoalArtifacts(directory,'PRD.md',async()=>false));
  for(const path of ['../outside.png','assets/missing.png']){await writeFile(join(directory,'PRD.md'),document.replace('assets/board.png',path));await assert.rejects(api.checkGoalArtifacts(directory,'PRD.md',async()=>true));}
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('real goal delivery requires explicit opt-in before loading the SDK or issuing model requests',async()=>{
 const {spawnSync}=await import('node:child_process');const result=spawnSync(process.execPath,[new URL('../../../scripts/goal-delivery-acceptance.mjs',import.meta.url).pathname],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/explicit --run-native/);assert.ok(!result.stdout.includes('goal delivery:'));
});

test('cancel evidence accepts conservative unknown only with stopped owned processes and replay protection',async()=>{
 const stopped={heartbeatStable:true,childAbsent:true,rootGroupAbsent:true,childGroupAbsent:true};
 for(const status of ['failed','running']){
  const report={cancel:{status,model:'yam-codex/main'},heartbeat:{pid:102,pgid:102},heartbeatAncestors:[102,101],cancelOwnedProcess:{pid:101,pgid:101},jobs:[{mode:'task',error:status==='running'?'Native process cleanup failed; it may still be running. Agent aborted':'Agent aborted'}]};
  const result=await api.checkCancellationEvidence(report,async()=>stopped);assert.equal(result.needsInspection,status==='running');assert.equal(await api.verifyNoReplay(report.cancel),true);
  for(const key of Object.keys(stopped))await assert.rejects(api.checkCancellationEvidence(report,async()=>({...stopped,[key]:false})),undefined,key);
  await assert.rejects(api.checkCancellationEvidence({...report,cancel:{status:'completed'}},async()=>stopped));
  if(status==='running')await assert.rejects(api.checkCancellationEvidence({...report,jobs:[{mode:'task',error:'model says cancelled'}]},async()=>stopped));
 }
});
test('image provenance requires distinct native cache outputs and the actual original edit input',async()=>{
 const {createHash}=await import('node:crypto'),digest=bytes=>createHash('sha256').update(bytes).digest('hex'),directory=await mkdtemp(join(tmpdir(),'yam-image-proof-'));
 try{
  const cache=join(directory,'cache',root);await mkdir(cache,{recursive:true});await writeFile(join(directory,'first.png'),'first native bytes');await writeFile(join(directory,'second.png'),'second native bytes');await writeFile(join(cache,'native-first.png'),'first native bytes');await writeFile(join(cache,'native-second.png'),'second native bytes');
  const first={image:'first.png',imageHash:digest('first native bytes')},second={image:'second.png',imageHash:digest('second native bytes')},trace={id:root,imageCalls:[{callId:'generate',outputCallId:'generate',outputPaths:[join(cache,'native-first.png')],referencedImagePaths:null,input:'await tools.image_gen__imagegen({prompt});'},{callId:'edit',outputCallId:'edit',outputPaths:[join(cache,'native-second.png')],referencedImagePaths:[join(directory,'first.png')],input:'await tools.image_gen__imagegen({referenced_image_paths:'+JSON.stringify([join(directory,'first.png')])+'});'}]};
  const result=await api.verifyImageProvenance(directory,first,second,trace,{cacheRoot:join(directory,'cache')});assert.equal(result.editInputVerified,true);
  await assert.rejects(api.verifyImageProvenance(directory,first,first,trace,{cacheRoot:join(directory,'cache')}));
  await assert.rejects(api.verifyImageProvenance(directory,first,second,{...trace,imageCalls:[]},{cacheRoot:join(directory,'cache')}));
  const wrong={...trace,imageCalls:[trace.imageCalls[0],{...trace.imageCalls[1],referencedImagePaths:[join(directory,'second.png')],input:trace.imageCalls[1].input.replace('first.png','second.png')}]};await assert.rejects(api.verifyImageProvenance(directory,first,second,wrong,{cacheRoot:join(directory,'cache')}));
  for(const edit of [{...trace.imageCalls[1],outputCallId:'foreign'},{...trace.imageCalls[1],outputPaths:[join(cache,'native-first.png')]}])await assert.rejects(api.verifyImageProvenance(directory,first,second,{...trace,imageCalls:[trace.imageCalls[0],edit]},{cacheRoot:join(directory,'cache')}));
  await rm(join(cache,'native-second.png'));await assert.rejects(api.verifyImageProvenance(directory,first,second,trace,{cacheRoot:join(directory,'cache')}));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('simple native reply evidence uses actual final text',()=>{
 const a=api.inspectNativeTrace([...trace(root,'small'),{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'HELLO WORLD'}]}}]);assert.equal(a.finalText,'HELLO WORLD');
});

test('independent business assertions reject a self-consistent but incorrect generated implementation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'yam-code-contract-'));
 try{
  for(const valid of [false,true]){
   const work=join(directory,valid?'valid':'invalid');await mkdir(work);await writeFile(join(work,'normalize-title.test.mjs'),'// synthetic test artifact');
   await writeFile(join(work,'normalize-title.mjs'),valid?"export function normalizeTitle(value){if(typeof value!=='string')throw new TypeError();const title=value.trim().replace(/\\s+/gu,' ');if(!title||[...title].length>80)throw new RangeError();return title;}":"export function normalizeTitle(value){return String(value).trim();}");
   if(valid)assert.equal((await api.checkIndependentCode(work)).assertions,9);else await assert.rejects(api.checkIndependentCode(work));
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('image proof parses bounded top-level awaited calls and ignores code-shaped documentation',()=>{
 const call='await tools.image_gen__imagegen({referenced_image_paths:["/original.png"]});',event=input=>({type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'image',input}});
 for(const input of [call,'const result = '+call])assert.equal(api.inspectNativeTrace([...trace(root,'main'),event(input)]).imageCalls.length,1);
 const output=id=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:[{type:'input_text',text:'Generated images are saved to /native/cache as /native/cache/output.png by default.'}]}});
 const matched=api.inspectNativeTrace([...trace(root,'main'),event(call),output('image')]).imageCalls[0];assert.equal(matched.outputCallId,'image');assert.deepEqual(matched.outputPaths,['/native/cache/output.png']);
 const wrong=api.inspectNativeTrace([...trace(root,'main'),event(call),output('other')]).imageCalls[0];assert.equal(wrong.outputCallId,null);assert.deepEqual(wrong.outputPaths,[]);
 for(const input of ['// '+call,'const documentation = `'+call+'`;','async function unused(){'+call+'}','const unused=async()=>{'+call+'};','if(false){'+call+'}','await evil.tools.image_gen__imagegen({});'])assert.equal(api.inspectNativeTrace([...trace(root,'main'),event(input)]).imageCalls.length,0,input);
 for(const input of [call+'\n'+call,'await tools.image_gen__imagegen(input);','await tools.image_gen__imagegen({referenced_image_paths:paths});'])assert.throws(()=>api.inspectNativeTrace([...trace(root,'main'),event(input)]),/manual|unsupported|ambiguous/i);
});

test('release live acceptance supplies the same SDK context budget contract as the production entry',async()=>{
 const {readFile}=await import('node:fs/promises'),source=await readFile(new URL('../../../scripts/goal-delivery-acceptance.mjs',import.meta.url),'utf8');
 assert.match(source,/moduleAt\('node_modules\/@earendil-works\/pi-ai\/dist\/utils\/estimate\.js'\)/);
 assert.match(source,/install\(api,getSupportedThinkingLevels,Text,bridge,\{estimateMessageTokens,getReserveTokens:model=>SettingsManager\.inMemory\(pi\.getSettings\(\)\)\.getCompactionReserveTokens\(model\)\}\)/);
});
test('release readonly acceptance uses captured native output without a persisted business receipt',()=>{
 assert.equal(typeof api.checkReadonlyReply,'function');
 const job={mode:'readonly',model:'gpt-6-luna',allowCollaboration:false,exitCode:0,argv:['codex','exec','--model','gpt-6-luna','--ephemeral'],finalText:'HELLO WORLD',events:[{type:'thread.started'},{type:'item.completed',itemType:'agent_message'},{type:'turn.completed'}]};
 const message={role:'assistant',provider:'yam-codex',model:'gpt-6-luna',stopReason:'stop',content:[{type:'text',text:'HELLO WORLD'}]};
 const proof=api.checkReadonlyReply(message,job);assert.equal(proof.finalText,'HELLO WORLD');assert.equal(proof.modelEvidence,'native-cli-argv');assert.equal(proof.businessReceiptRequired,false);
 for(const patch of [{mode:'task'},{allowCollaboration:true},{exitCode:1},{finalText:'wrong'},{events:[{type:'thread.started'}]},{events:[...job.events,{type:'error'}]},{events:[...job.events,{type:'item.completed',itemType:'command_execution'}]},{argv:['gpt-6-luna','--ephemeral']}])assert.throws(()=>api.checkReadonlyReply(message,{...job,...patch}));
 assert.throws(()=>api.checkReadonlyReply({...message,model:'other'},job));assert.throws(()=>api.checkReadonlyReply({...message,stopReason:'error'},job));assert.throws(()=>api.checkReadonlyReply(message,{...job,argv:['codex','exec']}));
});
