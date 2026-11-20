// Author: Jeff.Liu
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultRules} from '../src-tauri/pi/task-rules.mjs';
import {readRoutingPolicy,magpieModels,installRouting,launcherArgs} from '../../../extensions/omp-chatgpt/routing.mjs';

class Events {
 values=[];waiters=[];ended=false;
 push(e){const r=this.waiters.shift();if(r)r({value:e,done:false});else this.values.push(e);}
 end(){this.ended=true;for(const r of this.waiters.splice(0))r({done:true});}
 async result(){const all=await collect(this),last=all.at(-1);return last.message??last.error;}
 [Symbol.asyncIterator](){return {next:()=>this.values.length?Promise.resolve({value:this.values.shift(),done:false}):this.ended?Promise.resolve({done:true}):new Promise(r=>this.waiters.push(r))};}
}
const model=(provider,id)=>({provider,id,api:'fake',reasoning:true,thinking:{efforts:['low','medium','high']},input:['text'],contextWindow:64000,maxTokens:4096,cost:{input:1,output:2,cacheRead:0,cacheWrite:0}});
const models=[model('yam-chatgpt','gpt-6-luna'),model('yam-magpie','compay-ai/qwen3.7-plus')];
const facts={intent:'new',task:'transform',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true,requires:['text']};
const tick=()=>new Promise(r=>setImmediate(r));
async function collect(s){const a=[];for await(const e of s)a.push(e);return a;}
function setup(overrides={}){
 const handlers={},entries=[],status=[],calls=[],classifications=[];let registered;
 const pi={registerProvider:(_name,c)=>registered=c,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),on:(n,fn)=>handlers[n]=fn,registerCommand:()=>{}};
 const ctx={cwd:'/test',sessionManager:{getBranch:()=>entries,getSessionId:()=> 'session'},ui:{setStatus:(key,value)=>status.push(value)}};
 const run=async(m,c,o)=>{classifications.push({m,c,o});return {stopReason:'stop',content:[{type:'text',text:JSON.stringify(facts)}]};};
 const delegate=(m,c,o)=>{calls.push({m,c,o});return (async function*(){yield {type:'done',reason:'stop',message:{role:'assistant',provider:m.provider,model:m.id,content:[{type:'text',text:'OK'}],usage:{input:9,output:2,cost:{total:.1}},stopReason:'stop'}};})();};
 const policy=overrides.policy??readRoutingPolicy();const deps={models,createStream:()=>new Events(),run,delegate,...overrides};
 installRouting(pi,policy,deps);handlers.session_start({},ctx);
 const stream=(messages,signal)=>registered.streamSimple({provider:'yam',id:'auto'},{messages},{sessionId:'session',signal});
 return {handlers,entries,status,calls,classifications,ctx,stream,registered};
}
const user=(text='Translate hello',timestamp=1)=>({role:'user',content:text,timestamp});

test('default and exported Pi policy reuse rules, normalize connection aliases and validate trust boundaries',()=>{
 const p=readRoutingPolicy();assert.equal(p.classifier,'yam-chatgpt/gpt-6-luna');assert.equal(p.strong,'yam-magpie/compay-ai/qwen3.7-plus');assert.deepEqual(p.rules,defaultRules);
 const saved={gateway:'http://127.0.0.1:3425',small:'yam-codex/gpt-6-luna',strong:'yam-gateway/compay-ai/qwen3.7-plus',classifier:'openai/gpt-6-luna',rules:defaultRules};
 assert.equal(readRoutingPolicy(JSON.stringify(saved)).small,p.small);
 assert.equal(readRoutingPolicy(JSON.stringify({id:'saved',name:'Saved Pi',adapter:'pi',setup:JSON.stringify(saved)})).strong,p.strong);
 for(const value of [{...saved,gateway:'http://remote/v1'},{...saved,rules:{}},{...saved,small:'yam/auto'},{...saved,billing:'subscription'}, {...saved,extra:true}])assert.throws(()=>readRoutingPolicy(JSON.stringify(value)));
 assert.throws(()=>readRoutingPolicy('x'.repeat(65537)));assert.throws(()=>readRoutingPolicy('{'));
});
test('OMP rejects policies whose normalized model aliases exceed the execution rules budget',()=>{
 const rules={...structuredClone(defaultRules),executionRules:[{enabled:true,when:{task:'answer'},use:{model:'yam-codex/gpt-6-luna'}}]};
 const bytes=()=>Buffer.byteLength(JSON.stringify(rules));
 for(const rule of rules.rules){
  rule.description+='x'.repeat(Math.min(600-rule.description.length,5999-bytes()));
  while(rule.examples.length<4&&bytes()+4<5999)rule.examples.push('x'.repeat(Math.min(160,5999-bytes()-3)));
  if(bytes()>=5999)break;
 }
 assert.equal(bytes(),5999);
 assert.throws(()=>readRoutingPolicy(JSON.stringify({rules})),/6000 bytes/);
});
test('gateway discovery uses advertised Messages protocol and capabilities, never a subscription gateway alias',()=>{
 const row={id:'compay-ai/qwen3.7-plus',reasoning:true,reasoning_levels:['none','low','high'],context_window:1000000,max_output_tokens:64000,native_endpoints:['/v1/messages'],pricing:{prompt:'0.000001',completion:'0.000002'},modalities:{input:['text','image']}};
 const m=magpieModels({data:[row]},'http://127.0.0.1:3425',s=>s)[0];assert.equal(m.api,'anthropic-messages');assert.equal(m.thinking.mode,'anthropic-adaptive');assert.deepEqual(m.thinking.efforts,['low','high']);assert.equal(m.cost.input,1);
 assert.throws(()=>magpieModels({data:[{...row,id:'codex/gpt-6-luna'}]},'http://127.0.0.1:3425',s=>s));
 assert.throws(()=>magpieModels({data:[{...row,context_window:0}]},'http://127.0.0.1:3425',s=>s));
});
test('launcher defaults to auto and owns authentication, model overrides and the immutable policy snapshot',()=>{
 const r=launcherArgs(['--yam-policy','/tmp/policy.json','--mode','rpc','--no-ui']);assert.equal(r.policyPath,'/tmp/policy.json');assert.ok(r.args.includes('yam/auto'));
 assert.ok(launcherArgs(['--model','yam-chatgpt/gpt-6-luna']).args.includes('yam-chatgpt/gpt-6-luna'));
 for(const args of [['--yam-policy'],['--yam-policy','a','--yam-policy','b'],['--extension','other'],['--api-key=secret'],['--profile=other'],['--yam-policy','a','--model','other']])assert.throws(()=>launcherArgs(args));
});
test('launcher defaults to YAM identity with explicit Pi backup and literal argument handling',()=>{
 assert.equal(launcherArgs([]).authSource,'yam');assert.equal(launcherArgs(['--yam-auth','pi']).authSource,'pi');assert.equal(launcherArgs(['--yam-auth=yam','--yam-login']).login,true);
 assert.equal(launcherArgs(['--append-system-prompt','--yam-auth','--','--yam-auth','pi']).authSource,'yam');
 for(const args of [['--yam-auth'],['--yam-auth','other'],['--yam-auth','yam','--yam-auth','pi']])assert.throws(()=>launcherArgs(args));
});
test('routing-off resume preserves the native model while new launches and routed resumes keep their defaults',()=>{
 const resumed=launcherArgs([],{defaultRouting:false,resuming:true});assert.equal(resumed.routing,false);assert.deepEqual(resumed.args,[]);
 assert.deepEqual(launcherArgs([],{defaultRouting:false}).args,['--model','yam-chatgpt/gpt-6-luna']);
 assert.deepEqual(launcherArgs([],{defaultRouting:true,resuming:true}).args,['--model','yam/auto']);
 assert.deepEqual(launcherArgs(['--model','yam-chatgpt/explicit'],{defaultRouting:false,resuming:true}).args,['--model','yam-chatgpt/explicit']);
});
test('selection records actual identity, usage and effort; tool continuation and retry classify only once',async()=>{
 const x=setup(),u=user();const a=await collect(x.stream([u]));const m=a.at(-1).message;assert.equal(m.provider,'yam-chatgpt');assert.equal(m.model,'gpt-6-luna');assert.equal(m.thinkingLevel,'medium');assert.equal(m.usage.cost.total,.1);
 await collect(x.stream([u,m,{role:'toolResult',content:'tool marker'}]));await collect(x.stream([u]));assert.equal(x.classifications.length,1);assert.equal(x.calls.length,3);assert.equal(x.calls[1].c.messages.at(-1).content,'tool marker');assert.match(x.status.at(-1),/ChatGPT.*gpt-6-luna.*medium/);
 const y=setup();y.entries.push(...x.entries);y.handlers.session_start({},y.ctx);await collect(y.stream([u]));assert.equal(y.classifications.length,0);
});
test('new independent input reclassifies and selects the appropriate model',async()=>{
 let deep=false;const x=setup({run:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify(deep?{...facts,task:'review',depth:'deep',context:'dependent',readOnly:false}:facts)}]})});
 deep=true;await collect(x.stream([user('Review concurrency')]));assert.equal(x.calls[0].m.provider,'yam-magpie');deep=false;
 await collect(x.stream([user('Explain a new independent word',2)]));assert.equal(x.calls[1].m.provider,'yam-chatgpt');assert.equal(x.calls.length,2);
});
test('late classifier cancellation does not persist or dispatch, and next task is independent',async()=>{
 let finish;const waiting=new Promise(r=>finish=r);const x=setup({run:()=>waiting});const abort=new AbortController();const pending=collect(x.stream([user()],abort.signal));await tick();abort.abort();finish({stopReason:'stop',content:[{type:'text',text:JSON.stringify(facts)}]});const result=await pending;assert.equal(result.at(-1).reason,'aborted');assert.equal(x.entries.length,0);assert.equal(x.calls.length,0);
});
test('cancellation is propagated during execution and failures cannot execute an old model',async()=>{
 let signal;const x=setup({delegate:(m,c,o)=>{signal=o.signal;return (async function*(){await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));throw Error('cancelled');})();}});const c=new AbortController(),pending=collect(x.stream([user()],c.signal));await tick();c.abort();assert.equal((await pending).at(-1).reason,'aborted');assert.equal(signal,c.signal);
 const bad=setup({run:async()=>({stopReason:'error',content:[]})});assert.equal((await collect(bad.stream([user()]))).at(-1).type,'error');assert.equal(bad.calls.length,0);
});
test('unsupported effort, image context and unavailable models stop before dispatch',async()=>{
 const missing=setup({models:[models[0]]});assert.equal((await collect(missing.stream([user('review')]))).at(-1).type,'error');assert.equal(missing.calls.length,0);
 const img=setup();const r=await collect(img.stream([{...user(),content:[{type:'image',data:'x',mimeType:'image/png'}]}]));assert.equal(r.at(-1).type,'error');assert.equal(img.calls.length,0);
});
test('session tree changes replace cached state and bounded receipts do not replay arbitrary model identities',async()=>{
 const x=setup();await collect(x.stream([user()]));x.entries.length=0;x.handlers.session_tree({},x.ctx);await collect(x.stream([user()]));assert.equal(x.classifications.length,2);
 const y=setup();y.entries.push({type:'custom',customType:'yam.omp.route.v1',data:{key:'bad',provider:'external',id:'secret'}});assert.doesNotThrow(()=>y.handlers.session_start({},y.ctx));
});
test('entry and launcher use system proxy and runtime settings capabilities rather than version equality',()=>{
 const entry=readFileSync(new URL('../../../extensions/omp-chatgpt/index.mjs',import.meta.url),'utf8');assert.match(entry,/installRouting/);assert.match(entry,/override/);assert.doesNotMatch(entry,/version\s*!==|18\.16\.0|1\.5\.0/);
 const run=readFileSync(new URL('../../../extensions/omp-chatgpt/run.mjs',import.meta.url),'utf8');assert.match(run,/launcherArgs/);assert.match(run,/YAM_OMP_ROUTING_POLICY/);
});

test('entry installs capability-gated session overrides, discovers both providers and dispatches through the routing provider',async()=>{
 for(const authSource of ['yam','pi']){
 const source=readFileSync(new URL('../../../extensions/omp-chatgpt/index.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async function install','return async function install');
 const registrations=[],overrides=[],handlers={},calls=[];let authLoaded;
 const done=(m,text)=>{const s=new Events();s.push({type:'done',reason:'stop',message:{role:'assistant',provider:m.provider,model:m.id,stopReason:'stop',content:[{type:'text',text}],usage:{input:1,output:1}}});s.end();return s;};
 const provider={models:async()=>[{...models[0],id:'gpt-6-luna'}],stream:(m,c,o)=>{calls.push({m,c,o});return done(m,c.systemPrompt?.startsWith('Classify')?JSON.stringify(facts):'OK');}};
 const env={createAssistantMessageEventStream:()=>new Events(),streamSimple:(m,c,o)=>done(m,'OK'),buildModel:s=>s,homedir:()=>'/home/test',join:(...a)=>a.join('/'),createChatgptProvider:()=>provider,PROVIDER:'yam-chatgpt',createSubprocessCredentialReader:()=>{assert.equal(authSource,'pi');authLoaded='pi';return async()=>{};},createYamSubprocessCredentialReader:options=>{assert.equal(authSource,'yam');assert.equal(options.authDir,'/yam-auth');authLoaded='yam';return async()=>{};},yamAuthDirectory:()=>'/yam-auth',lookup:id=>({override:(scope,value)=>overrides.push({id,value})}),readRoutingPolicy,magpieModels,installRouting,fetch:async()=>Response.json({data:[{id:'compay-ai/qwen3.7-plus',reasoning:true,reasoning_levels:['medium','high'],native_endpoints:['/v1/messages'],context_window:128000,max_output_tokens:4096},{id:'unrelated/incomplete-model',context_window:128000}]}),process:{env:{YAM_OMP_AUTH_SOURCE:authSource,YAM_NODE_BINARY:'/node',...(authSource==='pi'?{YAM_PI_PACKAGE_DIR:'/pi'}:{}),YAM_OMP_ROUTING_POLICY:JSON.stringify(readRoutingPolicy())}},globalThis:{fetch:async()=>{throw Error('unused');}}};
 const install=new Function(...Object.keys(env),source)(...Object.values(env));
 const pi={pi:{settings:{}},registerProvider:(id,c)=>registrations.push({id,c}),registerCommand:()=>{},appendEntry:()=>{},on:(e,fn)=>handlers[e]=fn};
 await install(pi);assert.equal(authLoaded,authSource);assert.deepEqual(overrides.map(x=>[x.id,x.value]),[['retry.modelFallback',false],['compaction.methodOrder',['soft']]]);
 assert.deepEqual(registrations.map(x=>x.id),['yam-chatgpt','yam']);handlers.session_start({}, {cwd:'/tmp',sessionManager:{getBranch:()=>[]},ui:{setStatus:()=>{}}});
 const events=await collect(registrations[1].c.streamSimple({}, {messages:[user()]},{sessionId:'s'}));assert.equal(events.at(-1).message.model,'gpt-6-luna');assert.equal(calls.length,2);
 await assert.rejects(install({...pi,pi:{}}),/runtime settings/);
 }
});

test('invalid classifier JSON, malformed policy candidates, unsupported workflows and mismatched subscription channels fail closed',async()=>{
 for(const patch of [{classifierFallbacks:42},{executionFallbacks:[]},{executionFallbacks:{small:42}},{executionFallbacks:{wrong:[]}},{classifierFallbacks:['yam-chatgpt/gpt-6-luna']},{v:3},{classifierBilling:'paid'},{effort:'auto-secret'},{rules:{...defaultRules,v:2}}])assert.throws(()=>readRoutingPolicy(JSON.stringify(patch)));
 const x=setup({run:async()=>({stopReason:'stop',content:[{type:'text',text:'not JSON'}]})});assert.equal((await collect(x.stream([user()]))).at(-1).reason,'error');assert.equal(x.calls.length,0);
 const p=readRoutingPolicy(JSON.stringify({gateway:null,strong:'yam-chatgpt/gpt-6-luna',billing:'subscription'}));assert.equal(p.gateway,null);
 const raw={...readRoutingPolicy(),rules:{...defaultRules,executionRules:[{enabled:true,when:{task:'transform'},use:{workflow:'team'}}]}};
 const base=setup();const handlers={};let reg;installRouting({on:(n,fn)=>handlers[n]=fn,registerProvider:(_n,c)=>reg=c,appendEntry:()=>{},registerCommand:()=>{}},readRoutingPolicy(JSON.stringify(raw)),{models,createStream:()=>new Events(),run:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify(facts)}]}),delegate:()=>{throw Error('must not dispatch');}});handlers.session_start({},base.ctx);assert.equal((await collect(reg.streamSimple({}, {messages:[user()]},{}))).at(-1).type,'error');
});

test('large input bounds classifier payload and keeps a conservative execution tier',async()=>{
 const x=setup();await collect(x.stream([user('x'.repeat(20000))]));const c=JSON.parse(x.classifications[0].c.messages[0].content);assert.equal(c.request.length,16000);assert.equal(c.truncated,true);assert.equal(x.calls[0].m.provider,'yam-magpie');
});
test('saved execution rules normalize Pi gateway model keys',()=>{
 const p=readRoutingPolicy(JSON.stringify({rules:{...defaultRules,executionRules:[{enabled:true,when:{task:'coding'},use:{model:'yam-gateway/compay-ai/qwen3.7-plus'}}]}}));assert.equal(p.rules.executionRules[0].use.model,'yam-magpie/compay-ai/qwen3.7-plus');
});

test('launcher treats advanced argument values and prompt terminators literally',()=>{
 assert.ok(launcherArgs(['--append-system-prompt','--model','--','--yam-policy','literal']).args.includes('yam/auto'));
 for(const args of [['--hook','other.mjs'],['--plugin-dir','other']])assert.throws(()=>launcherArgs(args));
});

test('continuation preserves a strong floor and unavailable primaries only use same-channel backups',async()=>{
 let continuation=false;
 const x=setup({run:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify(continuation?{...facts,intent:'continue',context:'dependent'}:{...facts,task:'review',depth:'deep'})}]})});
 await collect(x.stream([user('Analyze concurrency')]));continuation=true;await collect(x.stream([user('Continue',2)]));assert.equal(x.calls[1].m.provider,'yam-magpie');assert.equal(x.calls[1].o.reasoning,'high');
 const p=readRoutingPolicy(JSON.stringify({small:'yam-chatgpt/missing',executionFallbacks:{small:['yam-magpie/compay-ai/qwen3.7-plus','yam-chatgpt/gpt-6-luna']}}));
 const y=setup({policy:p});await collect(y.stream([user()]));assert.equal(y.calls[0].m.provider,'yam-chatgpt');
});
test('unexpected stream termination preserves visible partial output and usage, sanitizes its error and never retries another channel',async()=>{
 const partial={role:'assistant',provider:models[0].provider,model:models[0].id,content:[{type:'text',text:'partial answer'}],usage:{input:7,output:3,cost:{total:.2}}};
 for(const throws of [true,false]){
  let calls=0;const x=setup({delegate:()=>{calls++;return(async function*(){yield {type:'text_delta',partial,delta:'partial answer'};if(throws)throw Error('private detail');})();}});
  const last=(await collect(x.stream([user()]))).at(-1);assert.equal(last.error.content[0]?.text,'partial answer');assert.equal(last.error.usage.input,7);assert.doesNotMatch(last.error.errorMessage,/private detail/);assert.equal(calls,1);
 }
});
test('native session picker flags remain optional and value flags preserve literal input',()=>{
 for(const args of [['--resume'],['-r'],['--restore'],['--resume','--no-ui']])assert.doesNotThrow(()=>launcherArgs(args));
 assert.ok(launcherArgs(['--goal','--model']).routing);
});

test('launcher snapshots policy files, clears inherited routing on native override and rejects oversized files before spawn',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const dir=await mkdtemp(join(tmpdir(),'yam-omp-launcher-'));
 try{
  await writeFile(join(dir,'policy.json'),JSON.stringify({strong:'yam-chatgpt/gpt-6-luna'}));await writeFile(join(dir,'large.json'),' '.repeat(65537));
  for(const mode of ['policy','native','oversized']){
   const code=`
    import {mock} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {open} from 'node:fs/promises';
    const mode=${JSON.stringify(mode)},dir=${JSON.stringify(dir)};
    process.env.YAM_OMP_ROUTING_POLICY='untrusted inherited value';
    process.argv=['node','run','--yam-auth','pi',...(mode==='native'?['--model','yam-chatgpt/gpt-6-luna']:['--yam-policy',dir+'/'+(mode==='oversized'?'large.json':'policy.json')])];
    mock.module('node:fs/promises',{namedExports:{access:async()=>{},open}});
    mock.module('node:child_process',{namedExports:{execFileSync:()=> 'proxy',spawn:(file,args,{env})=>{
     assert.notEqual(mode,'oversized');if(mode==='native')assert.equal(env.YAM_OMP_ROUTING_POLICY,undefined);else {const p=JSON.parse(env.YAM_OMP_ROUTING_POLICY);assert.equal(p.strong,'yam-chatgpt/gpt-6-luna');assert.ok(args.includes('yam/auto'));}
     assert.equal(env.HTTPS_PROXY,'http://localhost:7897');const child=new EventEmitter();child.kill=()=>{};setImmediate(()=>child.emit('exit',0));console.log('snapshot-ok');return child;
    }}});
    mock.module(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/runtime.mjs',import.meta.url).href)},{namedExports:{yamAuthDirectory:()=>'/fake-yam-auth',createYamSubprocessCredentialReader:()=>{throw Error('YAM reader must not run in Pi backup fixture');},findPiPackage:async()=>'/fake-pi',parseSystemProxy:()=> 'http://localhost:7897',launchEnvironment:()=>({HTTPS_PROXY:'http://localhost:7897',YAM_OMP_ROUTING_POLICY:process.env.YAM_OMP_ROUTING_POLICY})}});
    await import(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/run.mjs',import.meta.url).href)});
   `;
   if(mode==='oversized')await assert.rejects(promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code]),e=>e.code===1&&/Invalid OMP routing policy/.test(e.stderr));
   else assert.match((await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code])).stdout,/snapshot-ok/);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('primary YAM launcher reads its own authorization using the system proxy and never locates Pi',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const code=`import {mock} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
 process.argv=['node','run'];delete process.env.YAM_OMP_DESKTOP;
 const env={HTTPS_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost,127.0.0.1,::1'};let read=false;
 mock.module('node:fs/promises',{namedExports:{access:async path=>assert.equal(path.endsWith('/pi'),false),open:()=>{throw Error('unused');}}});
 mock.module('node:child_process',{namedExports:{execFileSync:()=> 'proxy',spawn:(file,args,options)=>{assert.ok(read);assert.equal(options.env,env);assert.equal(env.YAM_OMP_AUTH_SOURCE,'yam');assert.equal(env.YAM_OMP_AUTH_DIR,'/private/yam-auth');const child=new EventEmitter();child.kill=()=>{};setImmediate(()=>child.emit('exit',0));console.log('yam-primary-ok');return child;}}});
 mock.module(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/runtime.mjs',import.meta.url).href)},{namedExports:{yamAuthDirectory:()=>'/private/yam-auth',createYamSubprocessCredentialReader:options=>async()=>{assert.equal(options.env,env);read=true;},findPiPackage:()=>{throw Error('Pi must not be loaded');},parseSystemProxy:()=> 'http://127.0.0.1:7897',launchEnvironment:()=>env}});
 await import(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/run.mjs',import.meta.url).href)});`;
 assert.match((await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code])).stdout,/yam-primary-ok/);
});

test('login cancellation returns immediately while the detached helper safely finishes accepted authorization',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const code=`import {mock} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
 process.argv=['node','run','--yam-login'];delete process.env.YAM_OMP_DESKTOP;let detached=false,unref=false,killed=false,spawned=0;
 mock.module('node:fs/promises',{namedExports:{access:async()=>{},open:()=>{throw Error('unused');}}});
 mock.module('node:child_process',{namedExports:{execFileSync:()=> 'proxy',spawn:(file,args,options)=>{assert.equal(++spawned,1);assert.equal(args.at(-1),'login');detached=options.detached;const child=new EventEmitter();child.kill=sig=>{assert.equal(sig,'SIGINT');killed=true;};child.unref=()=>unref=true;setImmediate(()=>process.emit('SIGINT'));setTimeout(()=>child.emit('exit',0),350).unref();return child;}}});
 mock.module(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/runtime.mjs',import.meta.url).href)},{namedExports:{yamAuthDirectory:()=>'/private/yam-auth',createYamSubprocessCredentialReader:()=>{throw Error('explicit login must not read');},findPiPackage:()=>{throw Error('no Pi');},parseSystemProxy:()=> 'http://127.0.0.1:7897',launchEnvironment:()=>({})}});
 const started=Date.now();await import(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/run.mjs',import.meta.url).href)});assert.ok(Date.now()-started<200);assert.ok(detached&&unref&&killed);assert.equal(process.exitCode,1);process.exitCode=0;console.log('cancel-with-owned-save-ok');`;
 assert.match((await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code])).stdout,/cancel-with-owned-save-ok/);
});

test('exported fixed-model policies accept empty unused tiers and skip classification only when model and effort are locked',async()=>{
 const raw={gateway:null,small:'',strong:'',classifier:'',model:'yam-codex/gpt-6-luna',effort:'high',billing:'subscription',rules:defaultRules};
 const policy=readRoutingPolicy(JSON.stringify(raw)),x=setup({policy});await collect(x.stream([user()]));assert.equal(x.classifications.length,0);assert.equal(x.calls[0].m.provider,'yam-chatgpt');assert.equal(x.calls[0].o.reasoning,'high');assert.equal(x.entries[0].data.classificationSource,'fixed');
 const y=setup({policy:readRoutingPolicy(JSON.stringify({...raw,effort:'auto'}))});assert.equal((await collect(y.stream([user()]))).at(-1).type,'error');assert.equal(y.classifications.length,0);assert.equal(y.calls.length,0);
 for(const patch of [{model:'auto'},{classifierFallbacks:['yam-chatgpt/gpt-6-luna']},{executionFallbacks:{small:['yam-chatgpt/gpt-6-luna']}}])assert.throws(()=>readRoutingPolicy(JSON.stringify({...raw,...patch})));
 const rules={...defaultRules,executionRules:[{enabled:true,when:{task:'transform'},use:{workflow:'team'}}]};const z=setup({policy:readRoutingPolicy(JSON.stringify({...raw,rules}))});assert.equal((await collect(z.stream([user()]))).at(-1).type,'error');assert.equal(z.calls.length,0);
});
