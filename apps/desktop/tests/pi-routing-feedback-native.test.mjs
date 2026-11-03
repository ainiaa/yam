// Author: Jeff.Liu. Headless native persistence acceptance; no provider traffic or personal profile.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import install from '../src-tauri/pi/router.mjs';
const sdk=process.env.YAM_PI_SDK_DIR??join(homedir(),'.npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
test('Pi native replacement persists the upgraded answer, physical model, label and continuation floor together', {skip:!existsSync(join(sdk,'dist/index.js'))},async()=>{
 const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import(pathToFileURL(join(sdk,'dist/index.js')));
 const cwd=mkdtempSync(join(tmpdir(),'yam-feedback-native-')),agentDir=join(cwd,'agent');
 let session,route,ctx,calls=0;const requests=[];
 const models=['small','strong'].map(id=>({id,name:id,reasoning:true,input:['text'],contextWindow:128000,maxTokens:1000,cost:{input:1,output:1,cacheRead:.1,cacheWrite:1},thinkingLevelMap:{medium:'medium',high:'high',max:'max'}}));
 const settingsManager=SettingsManager.inMemory({packages:[],extensions:[],skills:[],prompts:[],themes:[],retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:false});
 try{
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,disabledBuiltinExtensions:['mcp'],extensionFactories:[async pi=>{
   pi.registerProvider('fixture',{baseUrl:'http://127.0.0.1:1',api:'openai-responses',apiKey:'test-only',models});
   pi.on('session_start',(_event,context)=>ctx=context);
   const observed=new Proxy(pi,{get(target,key){return key==='registerVirtualModel'?definition=>{route=definition.route;target.registerVirtualModel(definition);}:Reflect.get(target,key);}});
   await install(observed,m=>Object.keys(m.thinkingLevelMap??{}),class Text{});
  }]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const manager=SessionManager.create(cwd,join(cwd,'sessions'));manager.appendCustomEntry('yam.routing.config.v1',{small:'fixture/small',strong:'fixture/strong',classifier:'fixture/small'});
  ({session}=await createAgentSession({cwd,agentDir,settingsManager,sessionManager:manager,resourceLoader:loader,model:{provider:'yam',id:'auto',api:'pi-virtual',reasoning:true,input:['text'],contextWindow:128000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} ,tools:[]}));
  await session.bindExtensions({});assert.ok(ctx);assert.ok(route);
  ctx.modelRegistry.complete=async(model,context)=>{
   calls++;requests.push(context);
   return {role:'assistant',provider:'fixture',api:'openai-responses',model:model.id,content:[{type:'text',text:model.id==='small'?JSON.stringify({intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true}):'HTTP 404 means the requested resource was not found.'}],stopReason:'stop',timestamp:Date.now(),usage:{input:12,output:15,cacheRead:0,cacheWrite:0,totalTokens:27,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  };
  ctx.modelRegistry.streamSimple=(...args)=>({result:()=>ctx.modelRegistry.complete(...args)});
  const user={role:'user',content:'What does HTTP 404 mean?',timestamp:Date.now()};await session._handleAgentEvent({type:'message_end',message:user});
  await route({reason:'user',thinkingLevel:'off',messages:[{role:'system',content:'Answer accurately.',toolsAdded:[{name:'write'}],timestamp:Date.now()},user]},ctx);
  const message={role:'assistant',provider:'fixture',model:'small',api:'openai-responses',thinkingLevel:'medium',content:[{type:'text',text:'I need a stronger model to answer this.'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
  await session._handleAgentEvent({type:'message_end',message});await session._dispatchTurnEndBoundary(message,[]);
  assert.equal(calls,2);assert.deepEqual(requests[1].messages[0].toolsAdded,[]);
  const entries=SessionManager.open(manager.getSessionFile()).getBranch(),saved=entries.find(e=>e.type==='message'&&e.message.role==='assistant'),label=entries.find(e=>e.type==='custom'&&e.customType==='yam.reply-model.v1');
  assert.equal(saved.message.model,'strong');assert.match(saved.message.content[0].text,/404/);assert.equal(label.data.messageId,saved.id);assert.equal(label.data.model,'fixture/strong');assert.equal(label.data.effort,'high');
  const state=entries.findLast(e=>e.type==='custom'&&e.customType==='pi.virtual-model-state').data.state;assert.equal(state.model,'strong');assert.equal(state.effort,'high');
  assert.equal(entries.filter(e=>e.type==='message'&&e.message.role==='assistant').length,1,'no duplicate weak reply in saved history');
 }finally{session?.dispose();rmSync(cwd,{recursive:true,force:true});}
});

test('Pi SDK merges native and Magpie identities and honors model-specific protocols and reasoning off',{skip:!existsSync(join(sdk,'dist/index.js'))},async()=>{
 const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import(pathToFileURL(join(sdk,'dist/index.js')));
 const {getSupportedThinkingLevels}=await import(pathToFileURL(join(sdk,'node_modules/@earendil-works/pi-ai/dist/models.js')));
 const cwd=mkdtempSync(join(tmpdir(),'yam-channel-native-')),agentDir=join(cwd,'agent'),argv=process.argv,fetch=globalThis.fetch;
 let session,ctx,runtime,route;
 process.argv=[...argv,'--yam-gateway','http://127.0.0.1:3425'];globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'vendor/text',reasoning:false,context_window:64000,max_output_tokens:2000},{id:'codex/legacy',reasoning:true,reasoning_levels:['medium','high'],context_window:128000,max_output_tokens:4000}]})});
 const settingsManager=SettingsManager.inMemory({packages:[],extensions:[],skills:[],prompts:[],themes:[],retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:false});
 try{
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,disabledBuiltinExtensions:['mcp'],extensionFactories:[async pi=>{
   pi.registerProvider('fixture',{baseUrl:'http://127.0.0.1:1',api:'openai-responses',apiKey:'test-only',models:[{id:'vendor/text',name:'Native',reasoning:true,input:['text'],contextWindow:128000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
   pi.on('session_start',(_event,context)=>ctx=context);
   const observed=new Proxy(pi,{get(target,key){if(key==='registerVirtualModel')return definition=>{route=definition.route;target.registerVirtualModel(definition);};if(key==='getFlag')return name=>['yam-small','yam-strong','yam-classifier'].includes(name)?'fixture/vendor/text':target.getFlag(name);return Reflect.get(target,key);}});
   runtime=await install(observed,getSupportedThinkingLevels,class Text{});
  }]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd,agentDir,settingsManager,sessionManager:SessionManager.create(cwd,join(cwd,'sessions')),resourceLoader:loader,model:{provider:'yam',id:'auto',api:'pi-virtual',reasoning:true,input:['text'],contextWindow:128000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}},tools:[]}));
  await session.bindExtensions({});
  const gateway=ctx.modelRegistry.find('yam-gateway','vendor/text'),legacy=ctx.modelRegistry.find('yam-gateway','codex/legacy');
  assert.equal(gateway.api,'openai-completions');assert.equal(legacy,undefined);assert.equal(gateway.reasoning,false);assert.deepEqual(getSupportedThinkingLevels(gateway),['off']);
  assert.ok(runtime.catalog().some(m=>m.key==='fixture/vendor/text'));assert.ok(runtime.catalog().some(m=>m.key==='yam-gateway/vendor/text'));
  await runtime.control({action:'set',revision:runtime.snapshot().revision,data:{model:'yam-gateway/vendor/text',effort:'off'}});
  const selected=await route({reason:'user',thinkingLevel:'off',messages:[{role:'user',content:'read only'}]},ctx);assert.equal(selected.model.provider,'yam-gateway');assert.equal(selected.model.id,'vendor/text');assert.equal(selected.thinkingLevel,'off');
 }finally{session?.dispose();process.argv=argv;globalThis.fetch=fetch;rmSync(cwd,{recursive:true,force:true});}
});

test('Pi gateway serializes an advertised off value and rejects unadvertised off without losing active effort',{skip:!existsSync(join(sdk,'dist/index.js'))},async()=>{
 const {ModelRuntime,ModelRegistry}=await import(pathToFileURL(join(sdk,'dist/index.js'))),{AuthStorage}=await import(pathToFileURL(join(sdk,'dist/core/auth-storage.js'))),{getSupportedThinkingLevels}=await import(pathToFileURL(join(sdk,'node_modules/@earendil-works/pi-ai/dist/models.js')));
 const argv=process.argv,fetch=globalThis.fetch,payloads=[];process.argv=[...argv,'--yam-gateway','http://127.0.0.1:3425'];
 globalThis.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url??input.href);assert.equal(url.origin,'http://127.0.0.1:3425');if(url.pathname==='/v1/models')return new Response(JSON.stringify({data:[{id:'vendor/none',reasoning:true,reasoning_levels:['none','low','high']},{id:'vendor/off',reasoning:true,reasoning_levels:['off','high']},{id:'vendor/required',reasoning:true,reasoning_levels:['low','high']},{id:'vendor/plain',reasoning:false,reasoning_levels:[]},{id:'codex/none',reasoning:true,reasoning_levels:['none','high']}].map(m=>({...m,context_window:128000,max_output_tokens:1000}))}),{headers:{'content-type':'application/json'}});payloads.push(JSON.parse(options.body));throw Error('Isolated request captured; no provider traffic');};
 try{
  const registry=new ModelRegistry(await ModelRuntime.create({modelsPath:null,credentials:AuthStorage.inMemory(),refreshOnCreate:false}));
  await install({registerEntryRenderer(){},registerFlag(){},on(){},registerCommand(){},registerVirtualModel(){},registerProvider:(...args)=>registry.registerProvider(...args)},getSupportedThinkingLevels,class Text{});
  const optional=registry.find('yam-gateway','vendor/none'),required=registry.find('yam-gateway','vendor/required'),plain=registry.find('yam-gateway','vendor/plain');
  assert.deepEqual(getSupportedThinkingLevels(required),['low','high']);assert.ok(getSupportedThinkingLevels(optional).includes('off'));assert.deepEqual(getSupportedThinkingLevels(plain),['off']);
  const send=async(id,reasoning)=>{await registry.streamSimple(registry.find('yam-gateway',id),{messages:[{role:'user',content:'test',timestamp:1}]},{reasoning}).result();return payloads.at(-1);};
  assert.equal((await send('vendor/none','off')).reasoning_effort,'none');assert.equal((await send('vendor/off','off')).reasoning_effort,'off');assert.equal((await send('vendor/none','high')).reasoning_effort,'high');assert.equal((await send('vendor/plain','off')).reasoning_effort,undefined);assert.equal(registry.find('yam-gateway','codex/none'),undefined);
 }finally{process.argv=argv;globalThis.fetch=fetch;}
});
