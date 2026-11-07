// Author: Jeff.Liu
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogModels, createChatgptProvider, validateCredential } from '../../../extensions/omp-chatgpt/provider.mjs';
import { createPiCredentialReader, parseSystemProxy, launchEnvironment, findPiPackage, createSubprocessCredentialReader, loadPiCredentialReader } from '../../../extensions/omp-chatgpt/runtime.mjs';

const credential = () => ({type:'oauth',access:'test-oauth-access',refresh:'never-copy-refresh',clientId:'oaiapp_test',scopes:['chatgpt.tokens.use.direct'],expires:Date.now()+3600000});
const catalog = () => ({models:[{slug:'test-primary',display_name:'Primary',visibility:'list',context_window:128000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'ultra'}]},{slug:'test-worker',display_name:'Worker',visibility:'list',context_window:64000,input_modalities:['text'],supported_reasoning_levels:[]},{slug:'hidden',visibility:'hide'}]});
class Events {
 values=[];waiters=[];ended=false;
 push(e){if(this.waiters.length)this.waiters.shift()({value:e,done:false});else this.values.push(e);}
 end(){this.ended=true;for(const w of this.waiters.splice(0))w({done:true});}
 [Symbol.asyncIterator](){return {next:()=>this.values.length?Promise.resolve({value:this.values.shift(),done:false}):this.ended?Promise.resolve({done:true}):new Promise(r=>this.waiters.push(r))};}
}
const done = {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'OK'}],stopReason:'stop'}};
function setup(overrides={}) {
 const calls=[];const native=[];
 const fetch=async (url,init)=>{calls.push({url:String(url),init});return Response.json(catalog());};
 const stream=(model,context,options)=>{native.push({model,context,options});return (async function*(){yield done;})();};
 const deps={buildModel:s=>s,readCredential:async()=>credential(),fetch,stream,createStream:()=>new Events(),...overrides};
 return {deps,calls,native,provider:createChatgptProvider(deps)};
}
async function collect(s){const events=[];for await(const e of s)events.push(e);return events;}

test('credential accepts only unexpired newer subscription OAuth',()=>{
 assert.equal(validateCredential(credential()).access,'test-oauth-access');
 for(const patch of [{type:'api_key'},{access:''},{clientId:undefined},{scopes:[]},{expires:0},{expires:NaN}])assert.throws(()=>validateCredential({...credential(),...patch}),/ChatGPT/);
 assert.throws(()=>validateCredential(null),/ChatGPT/);
});
test('catalog preserves server model order, limits, media and supported OMP efforts; hides unavailable entries',()=>{
 const models=catalogModels(catalog());assert.deepEqual(models.map(x=>x.id),['test-primary','test-worker']);
 assert.equal(models[0].contextWindow,128000);assert.deepEqual(models[0].thinking.efforts,['low','high']);assert.deepEqual(models[0].input,['text','image']);assert.equal(models[1].reasoning,false);
 assert.equal(models[0].cost.input,0);
});
test('catalog refuses malformed, duplicate, empty and invalid limits instead of inventing models',()=>{
 for(const value of [{},{models:[]},{models:[{...catalog().models[0],slug:'https://evil'}]},{models:[{...catalog().models[0],context_window:0}]},{models:[catalog().models[0],catalog().models[0]]}])assert.throws(()=>catalogModels(value),/catalog/);
});
test('catalog is authenticated using Pi only, ignores API key strings and coalesces concurrent discovery',async()=>{
 const x=setup();const [a,b]=await Promise.all([x.provider.models(),x.provider.models()]);
 assert.deepEqual(a,b);assert.equal(x.calls.length,1);assert.equal(x.calls[0].url,'https://api.openai.com/v1/models');
 assert.equal(x.calls[0].init.headers.Authorization,'Bearer test-oauth-access');assert.equal(x.calls[0].init.redirect,'error');
});
test('a new Pi token invalidates account catalog and failed discovery has no fallback',async()=>{
 let token='a';const x=setup({readCredential:async()=>({...credential(),access:token})});await x.provider.models();token='b';await x.provider.models();assert.equal(x.calls.length,2);
 const y=setup({fetch:async()=>Response.json({error:{code:'subscription_sharing_usage_unavailable'}},{status:403})});
 await assert.rejects(y.provider.models(),/catalog.*403/);assert.equal(y.native.length,0);
});
test('model authentication failure is sanitized and never invokes inference',async()=>{
 const x=setup({readCredential:async()=>{throw Error('SECRET_REFRESH_ACCESS');}});
 const e=await collect(x.provider.stream({id:'test-primary'},{}));assert.equal(e.at(-1).type,'error');assert.equal(x.native.length,0);assert.doesNotMatch(JSON.stringify(e),/SECRET_REFRESH_ACCESS/);
});
test('unknown model and unsupported reasoning fail before sending inference',async()=>{
 for(const [model,options] of [[{id:'unavailable'},{}],[{id:'test-primary'},{reasoning:'ultra'}]]){
  const x=setup();const e=await collect(x.provider.stream(model,{},options));assert.equal(e.at(-1).type,'error');assert.equal(x.native.length,0);
 }
});
test('inference uses built-in Responses with fixed endpoint, Pi token, SSE and no server-side storage',async()=>{
 const x=setup();const e=await collect(x.provider.stream({id:'test-primary',baseUrl:'https://evil',headers:{Authorization:'api-key'}},{messages:[]},{apiKey:'paid-key',headers:{Authorization:'paid'},statefulResponses:true,preferWebsockets:true,reasoning:'low'}));
 assert.equal(e.at(-1).type,'done');const {model,options}=x.native[0];
 assert.equal(model.api,'openai-responses');assert.equal(model.baseUrl,'https://api.openai.com/v1');assert.deepEqual(model.headers,{});assert.equal(options.apiKey,'test-oauth-access');
 assert.equal(options.preferWebsockets,false);assert.equal(options.statefulResponses,false);assert.equal(options.storeResponses,false);assert.deepEqual(options.headers,{});
});
test('guarded fetch forces subscription token and payload controls, forbids redirects and foreign endpoints',async()=>{
 const x=setup();await collect(x.provider.stream({id:'test-primary'},{}));const send=x.native[0].options.fetch;
 const input={model:'test-primary',store:true,stream:false,previous_response_id:'old',input:[]};
 await send('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer paid-key','OpenAI-Project':'paid-project'},body:JSON.stringify(input)});
 const last=x.calls.at(-1);const request=last.url;assert.equal(request,'https://api.openai.com/v1/responses');
 assert.equal(last.init.headers.get('authorization'),'Bearer test-oauth-access');assert.equal(last.init.headers.has('OpenAI-Project'),false);assert.equal(last.init.redirect,'error');
 const body=JSON.parse(last.init.body);assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.previous_response_id,undefined);
 for(const url of ['https://evil/v1/responses','https://api.openai.com/v1/chat/completions','https://api.openai.com/v1/responses?redirect=1'])await assert.rejects(send(url,{method:'POST',body:JSON.stringify(input)}),/endpoint/);
 await assert.rejects(send('https://api.openai.com/v1/responses',{method:'GET'}),/endpoint/);
 await assert.rejects(send('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({...input,model:'other'})}),/model/);
});
test('cancellation before auth causes no model request; midstream retains abort signal',async()=>{
 const c=new AbortController();c.abort();const x=setup();const e=await collect(x.provider.stream({id:'test-primary'},{},{signal:c.signal}));assert.equal(e.at(-1).error.stopReason,'aborted');assert.equal(x.calls.length,0);
 const active=new AbortController();const y=setup();await collect(y.provider.stream({id:'test-primary'},{},{signal:active.signal}));assert.equal(y.native[0].options.signal,active.signal);
});
test('incomplete stream and native errors cannot become success or leak credentials',async()=>{
 const empty=setup({stream:()=> (async function*(){yield {type:'text_delta',delta:'partial'};})()});assert.equal((await collect(empty.provider.stream({id:'test-primary'},{}))).at(-1).type,'error');
 const failed=setup({stream:()=> (async function*(){yield {type:'error',error:{stopReason:'error',errorMessage:'test-oauth-access never-copy-refresh'}};})()});const e=await collect(failed.provider.stream({id:'test-primary'},{}));assert.equal(e.at(-1).type,'error');assert.doesNotMatch(JSON.stringify(e),/test-oauth-access|never-copy-refresh/);
});
test('Pi reader uses native locked refresh only for openai, preserves canonical store and returns no refresh token',async()=>{
 let current=credential(),calls=0;const store={};
 const read=createPiCredentialReader({store,oauth:{name:'new-chatgpt'},refresh:async(s,id,oauth,needs,signal)=>{assert.equal(s,store);assert.equal(id,'openai');assert.equal(oauth.name,'new-chatgpt');assert.equal(needs(current),false);calls++;return current;}});
 const c=await read();assert.equal(c.access,current.access);assert.equal(c.refresh,undefined);assert.equal(calls,1);
});
test('Pi reader refreshes near expiry, rejects legacy credentials and sanitizes refresh errors',async()=>{
 const c={...credential(),expires:Date.now()+1000};const read=createPiCredentialReader({store:{},oauth:{},refresh:async(s,id,o,needs)=>{assert.equal(needs(c),true);return credential();}});assert.ok((await read()).access);
 const bad=createPiCredentialReader({store:{},oauth:{},refresh:async()=>{throw Error('secret=abc');}});await assert.rejects(bad(),e=>e.message.includes('Pi')&&!e.message.includes('secret'));
 const legacy=createPiCredentialReader({store:{},oauth:{},refresh:async()=>({...credential(),clientId:undefined})});await assert.rejects(legacy(),/ChatGPT/);
});
test('system proxy parser uses HTTPS then HTTP and rejects PAC, disabled or invalid proxies',()=>{
 assert.equal(parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'),'http://127.0.0.1:7897');
 assert.equal(parseSystemProxy('HTTPEnable : 1\nHTTPProxy : proxy.local\nHTTPPort : 8080'),'http://proxy.local:8080');
 for(const s of ['', 'ProxyAutoConfigEnable : 1','HTTPSEnable : 1\nHTTPSProxy : evil/user\nHTTPSPort : 0','HTTPSEnable : 0\nHTTPSProxy : proxy\nHTTPSPort : 80'])assert.throws(()=>parseSystemProxy(s),/proxy/);
});
test('launcher overrides inherited proxy bypass and provider proxy overrides; protects API-key environment',()=>{
 const e=launchEnvironment({HOME:'/home/u',PATH:'/bin',OPENAI_API_KEY:'paid',PI_PROXY_OPENAI:'wrong',HTTPS_PROXY:'wrong',NO_PROXY:'*'},'http://127.0.0.1:7897','/pi');
 assert.equal(e.PI_PROXY,'http://127.0.0.1:7897');assert.equal(e.HTTPS_PROXY,e.PI_PROXY);assert.equal(e.NO_PROXY,'localhost,127.0.0.1,::1');assert.equal(e.OPENAI_API_KEY,undefined);assert.equal(e.PI_PROXY_OPENAI,undefined);assert.equal(e.YAM_PI_PACKAGE_DIR,'/pi');assert.equal(e.HOME,'/home/u');
});
test('Pi package discovery finds installed package by executable and rejects unknown layout',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yam-pi-discovery-'));
 try{
  await mkdir(join(root,'dist/bundle'),{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.5.0'}));await writeFile(join(root,'dist/bundle/cli.js'),'');
  assert.equal(await findPiPackage(join(root,'dist/bundle/cli.js')),await realpath(root));
  await writeFile(join(root,'package.json'),'{}');await assert.rejects(findPiPackage(join(root,'dist/bundle/cli.js')),/Pi/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('cancel returns promptly while a canonical Pi refresh finishes independently',async()=>{
 let finish;const pending=new Promise(r=>{finish=r;});const c=new AbortController();
 const x=setup({readCredential:()=>pending});const result=collect(x.provider.stream({id:'test-primary'},{},{signal:c.signal}));
 c.abort();const outcome=await Promise.race([result,new Promise(r=>setTimeout(()=>r('timeout'),80))]);
 finish(credential());assert.notEqual(outcome,'timeout');assert.equal(outcome.at(-1).error.stopReason,'aborted');assert.equal(x.calls.length,0);
});
test('cancel during catalog wait returns promptly without cancelling another reader',async()=>{
 let finish;const pending=new Promise(r=>{finish=r;});const c=new AbortController();
 const x=setup({fetch:()=>pending});const models=x.provider.models();await new Promise(r=>setImmediate(r));
 const result=collect(x.provider.stream({id:'test-primary'},{},{signal:c.signal}));await new Promise(r=>setImmediate(r));c.abort();
 const outcome=await Promise.race([result,new Promise(r=>setTimeout(()=>r('timeout'),80))]);finish(Response.json(catalog()));await models;
 assert.notEqual(outcome,'timeout');assert.equal(outcome.at(-1).error.stopReason,'aborted');assert.equal(x.native.length,0);
});

test('native transport model is built after selecting subscription endpoint and catalog fields',async()=>{
 let spec;const x=setup({buildModel:s=>{spec=s;return {...s,compat:{officialEndpoint:true}};},stream:(m)=>{assert.equal(m.compat.officialEndpoint,true);return (async function*(){yield done;})();}});
 const events=await collect(x.provider.stream({id:'test-primary',compat:{unsafe:true}},{}));
 assert.equal(events.at(-1).type,'done');assert.equal(spec.api,'openai-responses');assert.equal(spec.baseUrl,'https://api.openai.com/v1');assert.equal(spec.compat,undefined);
});


test('Node auth helper uses installed Pi API, coalesces reads, excludes refresh tokens and sanitizes failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yam-fake-pi-'));
 const files={
  'package.json':JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.5.0',type:'module'}),
  'dist/core/auth-storage.js':"export const AuthStorage={create:path=>({path})};",
  'node_modules/@earendil-works/pi-ai/package.json':JSON.stringify({type:'module'}),
  'node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js':"export const openaiChatGPTOAuth={name:'new-chatgpt'};",
  'node_modules/@earendil-works/pi-ai/dist/auth/resolve.js':`import {readFile,appendFile} from 'node:fs/promises';export async function refreshStoredOAuthCredential(store,id,oauth){if(id!=='openai'||oauth.name!=='new-chatgpt')throw Error('wrong provider');await appendFile(store.path+'.calls','x');return JSON.parse(await readFile(store.path,'utf8'));}`,
 };
 try{
  for(const [path,data] of Object.entries(files)){await mkdir(join(dir,path,'..'),{recursive:true});await writeFile(join(dir,path),data);}
  const authPath=join(dir,'synthetic.json');await writeFile(authPath,JSON.stringify(credential()));
  const read=createSubprocessCredentialReader({node:process.execPath,packageDir:dir,authPath});
  const a=read(),b=read();assert.equal(a,b);const result=await a;assert.equal(result.access,'test-oauth-access');assert.equal(result.refresh,undefined);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(authPath+'.calls','utf8'),'x');
  await writeFile(authPath,'SECRET malformed');await assert.rejects(read(),e=>!/SECRET/.test(e.message)&&/helper failed/.test(e.message));
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'unknown'}));
  await assert.rejects(loadPiCredentialReader(dir,authPath),/Pi 1.5.0/);
  await assert.rejects(createSubprocessCredentialReader({node:join(dir,'missing'),packageDir:dir,authPath})(),/helper failed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('native failures and truncation retain partial output and usage while sanitizing diagnostics',async()=>{
 for(const type of ['error','done']){
  const partial={...done.message,content:[{type:'text',text:'partial answer'}],usage:{input:10,output:2,totalTokens:12},errorMessage:'SECRET',stopReason:type==='error'?'error':'length'};
  const x=setup({stream:()=> (async function*(){yield type==='error'?{type,reason:'error',error:partial}:{type,reason:'length',message:partial};})()});
  const result=(await collect(x.provider.stream({id:'test-primary'},{}))).at(-1);
  assert.deepEqual(result.error.content,partial.content);assert.deepEqual(result.error.usage,partial.usage);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 }
});
