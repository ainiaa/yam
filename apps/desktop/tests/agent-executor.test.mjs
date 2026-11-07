import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,chmod,rm,mkdir,symlink,readdir,rename,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
const api=await import('../src-tauri/pi/agent-executor.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const uuid='01234567-1234-1234-1234-0123456789ab';
const failureApi=await import('../src-tauri/pi/failure.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
async function withCLI(source,run){const dir=await mkdtemp(join(tmpdir(),'yam-agent-'));try{const file=join(dir,'fake.mjs');await writeFile(file,`#!${process.execPath}\n${source}`);await chmod(file,0o755);return await run(file,dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function groupStopped(pid){for(let n=0;n<100;n++){try{process.kill(-pid,0);}catch(error){if(error.code==='ESRCH')return true;if(error.code!=='EPERM')throw error;}await new Promise(r=>setTimeout(r,20));}return false;}
test('agent executor exports process, protocol and discovery boundaries',()=>{for(const name of ['runProcess','invocation','parseEvents','discoverAgents','executeAgent'])assert.equal(typeof api[name],'function',name);});
test('recovery process observation captures the owned group and observer errors still clean it up',async()=>{
 await withCLI("console.log('ready');",async file=>{const seen=[];const result=await api.runProcess(file,[],{onSpawn:value=>seen.push(value)});assert.equal(result.code,0);assert.equal(seen.length,1);assert.ok(Number.isSafeInteger(seen[0].pid)&&seen[0].pid>0);assert.equal(seen[0].pgid,seen[0].pid);assert.equal(await groupStopped(seen[0].pid),true);});
 await withCLI('setInterval(()=>{},1000)',async file=>{let observed;await assert.rejects(api.runProcess(file,[],{timeoutMs:5000,onSpawn:value=>{observed=value;throw Error('observer failed');}}),/observer failed/);assert.ok(observed);assert.equal(await groupStopped(observed.pid),true);});
 let observed=false;await assert.rejects(api.runProcess('/not/exist',[],{onSpawn:()=>{observed=true;}}),/ENOENT|spawn/);assert.equal(observed,false);
});
test('T2 repair streaming malformed JSON is a protocol failure while caller callback errors stay unknown',async()=>{
 for(const malformed of [true,false])await withCLI(`process.stdout.write(${JSON.stringify('not-json\n')});`,async(file,dir)=>{
  if(!malformed)await writeFile(file,`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({type:'thread.started',thread_id:uuid})+'\n')});`);
  // Protocol assertions must allow coverage-instrumented child startup, as neighboring CLI fixtures do.
  await assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Inspect',cwd:dir,timeoutMs:5000,onLine:()=>{throw Error('Caller failed with quota text');}}),error=>{
   const failure=failureApi.failureOf(error);assert.equal(failure.code,malformed?'protocol-invalid':'unknown');assert.equal(failure.stage,'execution');assert.ok(['started','unknown'].includes(failure.dispatch));assert.equal(failure.nextAction,'inspect-task');return true;
  });
 });
});
test('native CLI invocation uses stdin, preserved sandboxes and explicit subscription channel',{skip:!api.invocation},()=>{
 const input='$(touch /tmp/not-allowed); `echo nope`';
 const p=api.invocation({id:'codex',kind:'codex',executable:'/native/codex',auth:'subscription'},{prompt:input,resume:uuid,sessionDirectory:'/owned/children'});
 assert.equal(p.file,'/native/codex');assert.equal(p.input,input);assert.ok(!p.args.includes(input));
 assert.ok(p.args.includes('forced_login_method="chatgpt"'));assert.ok(p.args.includes('model_provider="openai"'));assert.ok(p.args.includes('workspace-write'));assert.ok(p.args.includes(uuid));
 assert.ok(!p.args.some(x=>/dangerously|bypass/.test(x)));assert.equal(p.env.OPENAI_API_KEY,undefined);assert.equal(p.env.YAM_AGENT_TOKEN,undefined);assert.equal(p.env.YAM_AGENT_ROUTING_CHILD,'1');
 assert.ok(p.args.includes('--skip-git-repo-check'));
 assert.throws(()=>api.invocation({kind:'shell',executable:'/bin/sh'},{prompt:input}),/Unsupported/);
 assert.throws(()=>api.invocation({kind:'codex',executable:'/native/codex',auth:'api'},{prompt:input}),/subscription/);
 assert.throws(()=>api.invocation({kind:'codex',executable:'/native/codex',auth:'subscription'},{prompt:input,resume:'--last'}),/session/i);
});
test('native and Pi children preserve fixed model, reasoning and dynamic gateway registration',{skip:!api.invocation},()=>{
 for(const kind of ['codex','claude']){
  const args=api.invocation({kind,executable:'/native/'+kind,auth:'subscription',model:'explicit-model',thinking:'high'},{prompt:'task'}).args;
  assert.ok(args.includes('explicit-model'),kind);assert.ok(args.some(a=>a.includes('high')),kind);
 }
 assert.throws(()=>api.invocation({kind:'gemini',executable:'/native/gemini',thinking:'high'},{prompt:'task'}),/reasoning.*not verified/);
 assert.ok(api.invocation({kind:'gemini',executable:'/native/gemini',model:'explicit-model'},{prompt:'task'}).args.includes('explicit-model'));
 const args=api.invocation({kind:'pi',executable:'/native/pi',model:'yam-gateway/explicit',thinking:'max',gateway:'http://127.0.0.1:3425',extension:'/owned/entry.ts'},{prompt:'task',sessionDirectory:'/owned/children'}).args;
 for(const value of ['--thinking','max','--extension','/owned/entry.ts','--yam-gateway','http://127.0.0.1:3425'])assert.ok(args.includes(value),value);
 const small=api.invocation({id:'pi-small',kind:'pi',executable:'/native/pi',model:'p/small'},{prompt:'Translate text',sessionDirectory:'/owned/children'}).args;
 assert.ok(small.includes('--no-tools'));assert.ok(small.includes('--no-extensions'));
 const restricted=api.invocation({id:'pi-strong',kind:'pi',executable:'/native/pi',model:'p/strong',tools:['read','grep']},{prompt:'Inspect code',sessionDirectory:'/owned/children'}).args;
 assert.ok(restricted.includes('read,grep'));
});
test('process runner preserves Unicode JSONL and literal stdin without invoking a shell',{skip:!api.runProcess},async()=>{
 await withCLI(`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const v=JSON.stringify({input:s,args:process.argv.slice(2),text:'中\u2028文'});process.stdout.write(v.slice(0,10));setTimeout(()=>process.stdout.end(v.slice(10)+'\\n'),10);});`,async(file,dir)=>{
  const lines=[],input='$(echo unsafe)\n正文';const r=await api.runProcess(file,['literal;arg'],{cwd:dir,input,onLine:v=>lines.push(v)});
  assert.equal(r.code,0);assert.equal(JSON.parse(r.stdout).input,input);assert.deepEqual(JSON.parse(r.stdout).args,['literal;arg']);assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).text,'中\u2028文');
 });
});
test('process runner handles missing executable, timeout, cancellation and output limits',{skip:!api.runProcess},async()=>{
 await assert.rejects(api.runProcess('/not/exist',[],{}),/ENOENT|spawn/);
 await withCLI('setInterval(()=>{},1000)',async(file)=>{
  await assert.rejects(api.runProcess(file,[],{timeoutMs:40}),/timed out/);
  const abort=new AbortController();setTimeout(()=>abort.abort(),40);await assert.rejects(api.runProcess(file,[],{signal:abort.signal}),/abort/i);
  const already=new AbortController();already.abort();await assert.rejects(api.runProcess(file,[],{signal:already.signal}),/abort/i);
 });
 await withCLI("process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)",file=>assert.rejects(api.runProcess(file,[],{maxBytes:100}),/output limit/));
});
test('parent exit cleans a TERM-ignoring descendant without waiting for the task timeout',{skip:!api.runProcess||process.platform==='win32'},async()=>{
 const child="process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
 await withCLI(`import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>process.exit(0));`,async(file)=>{
  const start=Date.now();const result=await api.runProcess(file,[],{timeoutMs:5000});assert.equal(result.code,0);assert.ok(Date.now()-start<3000);
 });
});
test('native result requires a terminal event and rejects protocol-level failures',{skip:!api.parseEvents},()=>{
 const lines=items=>items.map(x=>JSON.stringify(x)).join('\n')+'\n';
 const result=api.parseEvents('codex',lines([{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:'Done'}},{type:'turn.completed',usage:{input_tokens:3}}]));
 assert.equal(result.text,'Done');assert.equal(result.sessionId,uuid);assert.deepEqual(result.usage,{input_tokens:3});
 assert.throws(()=>api.parseEvents('codex',lines([{type:'turn.failed',error:{message:'quota'}}])),/failed/i);
 assert.throws(()=>api.parseEvents('codex',lines([{type:'item.completed',item:{type:'agent_message',text:'Looks done'}}])),/terminal/i);
 assert.throws(()=>api.parseEvents('codex','not json\n'),/JSON/);
 assert.throws(()=>api.parseEvents('claude',lines([{type:'result',is_error:true,result:'denied'}])),/failed/i);
 const pi=api.parseEvents('pi',lines([{type:'session',id:uuid},{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'OK'}]}},{type:'agent_settled',aborted:false}]));assert.equal(pi.text,'OK');
 assert.throws(()=>api.parseEvents('pi',lines([{type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}},{type:'agent_settled',aborted:false}])),/failed/i);
});
test('catalog uses native auth status and declared image support without reading credentials',{skip:!api.discoverAgents},async()=>{
 const calls=[];const probe=async(file,args)=>{calls.push(args);return {code:0,stdout:args.includes('features')?'image_generation stable true\n':'',stderr:args.includes('status')?'Logged in using ChatGPT\n':''};};
 const list=await api.discoverAgents({codex:'/native/codex'},probe);assert.equal(list[0].auth,'subscription');assert.ok(list[0].capabilities.includes('image_generation'));assert.equal(calls.length,2);
 assert.deepEqual(await api.discoverAgents({codex:'/native/codex'},async()=>({code:1,stdout:'',stderr:''})),[]);
 assert.deepEqual(await api.discoverAgents({codex:'/native/codex'},async()=>({code:0,stdout:'Logged in using API key',stderr:''})),[]);
 const claude=await api.discoverAgents({claude:'/native/claude'},async()=>({code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai'}),stderr:''}));assert.equal(claude[0].kind,'claude');assert.equal(claude[0].auth,'subscription');
});
test('native task execution checks exit codes and never retries failures',{skip:!api.executeAgent},async()=>{
 let calls=0;const runner=async()=>{calls++;return {code:1,stdout:'',stderr:'not logged in'};};
 await assert.rejects(api.executeAgent({kind:'codex',executable:'/codex',auth:'subscription'},{prompt:'task'},runner),/exit/i);assert.equal(calls,1);
});

test('T2 failure facts trust owned codes rather than arbitrary authentication or quota messages',()=>{
 assert.equal(typeof failureApi.failureOf,'function');
 for(const message of ['quota exceeded','not logged in','context length exceeded','ECONNREFUSED']){
  const error=Object.assign(Error(message),{failure:{code:'not-logged-in',category:'auth',stage:'discovery',dispatch:'not-started',nextAction:'check-login'},stderr:'PRIVATE_STDERR'});
  assert.deepEqual(failureApi.failureOf(error,{stage:'execution',dispatch:'started'}),{category:'unknown',stage:'execution',code:'unknown',dispatch:'started',nextAction:'inspect-task'});
 }
 const original=failureApi.nativeError('context-budget','PRIVATE_PROMPT',{stage:'preparation',dispatch:'not-started'});
 const aggregate=Object.assign(new AggregateError([original,Error('PRIVATE_CLEANUP')],'PRIVATE_MESSAGE',{cause:original}),{mayBeRunning:true});
 assert.deepEqual(failureApi.failureOf(aggregate),{category:'context',stage:'preparation',code:'context-budget',dispatch:'unknown',nextAction:'inspect-task'});
 assert.doesNotMatch(JSON.stringify(failureApi.failureOf(aggregate)),/PRIVATE/);
 assert.deepEqual(failureApi.projectFailure({code:'untrusted-code',category:'quota',stage:'invented',dispatch:'none',nextAction:'retry',prompt:'PRIVATE'}),{category:'unknown',stage:'execution',code:'unknown',dispatch:'unknown',nextAction:'inspect-task'});
});

test('T2 discovery diagnoses only the verified complete login-status response without changing its array API',async()=>{
 for(const [result,expected] of [
  [{code:1,stdout:'',stderr:'Not logged in\n'},'not-logged-in'],
  [{code:0,stdout:'',stderr:'Not logged in\n'},'native-unavailable'],
  [{code:1,stdout:'prefix',stderr:'Not logged in\n'},'native-unavailable'],
  [{code:1,stdout:'',stderr:'quota exceeded; Not logged in\n'},'native-unavailable'],
  [{code:1,stdout:'',stderr:'Not logged in'},'native-unavailable'],
 ]){
  const failures=[],agents=await api.discoverAgents({codex:'/native/codex'},async()=>result,{onFailure:(kind,failure)=>failures.push({kind,failure})});
  assert.deepEqual(agents,[]);assert.equal(failures.length,1);assert.equal(failures[0].kind,'codex');assert.equal(failures[0].failure.code,expected);assert.equal(failures[0].failure.dispatch,'not-started');
  assert.equal(failures[0].failure.category,expected==='not-logged-in'?'auth':'unknown');assert.doesNotMatch(JSON.stringify(failures),/stderr|quota exceeded/);
 }
 const failures=[];await api.discoverAgents({codex:'/native/codex'},async()=>{throw Object.assign(Error('not logged in'),{code:'ENOENT'});},{onFailure:(_kind,value)=>failures.push(value)});
 assert.equal(failures[0].category,'unknown');assert.equal(failures[0].stage,'discovery');
});

test('T2 cached discovery preserves execution diagnostics and clears them on a verified login',async()=>{
 let loggedIn=false;const failures=[],discover=api.createAgentDiscovery({identity:async()=> 'installed',probe:async(_file,args)=>args[0]==='features'?{code:0,stdout:'',stderr:''}:loggedIn?{code:0,stdout:'Logged in using ChatGPT\n',stderr:''}:{code:1,stdout:'',stderr:'Not logged in\n'}});
 assert.deepEqual(await discover({codex:'/native/codex'},{execution:true,onFailure:(kind,value)=>failures.push({kind,value})}),[]);
 assert.equal(failures[0].value.code,'not-logged-in');loggedIn=true;
 assert.equal((await discover({codex:'/native/codex'},{execution:true,onFailure:()=>assert.fail('successful probe has no failure')}))[0].auth,'subscription');
});

test('T2 local process facts distinguish cancellation spawn timeout exit and unclassified protocol failures',async()=>{
 const before=new AbortController();before.abort();await assert.rejects(api.runProcess('/not/exist',[],{signal:before.signal}),e=>e.failure?.code==='cancelled'&&e.failure.dispatch==='not-started');
 await assert.rejects(api.runProcess('/not/exist',[]),e=>e.failure?.code==='spawn-failed'&&e.failure.category==='execution'&&e.failure.dispatch==='not-started');
 await withCLI('setInterval(()=>{},1000)',async file=>{
  await assert.rejects(api.runProcess(file,[],{timeoutMs:30}),e=>e.failure?.code==='process-timeout'&&e.failure.category==='execution'&&e.failure.dispatch==='started'&&e.failure.nextAction==='inspect-task');
  const abort=new AbortController();setTimeout(()=>abort.abort(),30);await assert.rejects(api.runProcess(file,[],{signal:abort.signal}),e=>e.failure?.code==='cancelled'&&e.failure.dispatch==='started');
 });
 await assert.rejects(api.executeAgent({kind:'codex',executable:'/native/codex',auth:'subscription'},{prompt:'task'},async()=>({code:1,stdout:'',stderr:'not logged in quota exceeded'})),e=>e.failure?.code==='process-exit'&&e.failure.category==='execution'&&e.failure.dispatch==='started');
 assert.throws(()=>api.parseEvents('codex',JSON.stringify({type:'turn.failed',error:{message:'quota exceeded',code:'invented_quota_code'}})),e=>e.failure?.category==='unknown'&&e.failure.code==='native-reported-error');
 assert.throws(()=>api.validateAgentPrompt('x'.repeat(api.maxAgentPromptCharacters+1)),e=>e.failure?.code==='context-budget'&&e.failure.dispatch==='not-started');
});

test('T2 persistent Codex execution requires a reported session even when a resume ID was supplied',async()=>{
 const profile={kind:'codex',executable:'/native/codex',auth:'subscription'},stdout=[{type:'item.completed',item:{type:'agent_message',text:'Done'}},{type:'turn.completed'}].map(JSON.stringify).join('\n');
 for(const resume of [null,uuid])await assert.rejects(api.executeAgent(profile,{prompt:'task',resume},async()=>({code:0,stdout,stderr:''})),e=>e.failure?.code==='native-session-missing'&&e.failure.stage==='verification'&&e.failure.dispatch==='started'&&e.failure.nextAction==='inspect-task');
 const readonly=await api.executeAgent(profile,{prompt:'summary',mode:'readonly'},async()=>({code:0,stdout,stderr:''}));assert.equal(readonly.sessionId,null);assert.equal(readonly.finalText,'Done');
});
test('image requests require actual image artifacts, not a fluent success claim',{skip:!api.executeAgent},async()=>{
 const stdout=[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:'I generated an image'}},{type:'turn.completed'}].map(JSON.stringify).join('\n');
 await withCLI('',async(file,dir)=>{
  await assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Make a cover',cwd:dir,sessionDirectory:dir,requires:['image_generation']},async()=>({code:0,stdout,stderr:''})),/artifact|image/i);
 });
});
test('image output accepts only fresh decodable artifacts and uses the final message',{skip:!api.executeAgent},async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 await withCLI('',async(file,dir)=>{
  let decodes=0;
  const runner=async(_file,_args,options)=>{
   const root=JSON.parse(options.input.match(/Image artifact directory: ("[^\n]+")/)[1]),path=join(root,'cover.png');await writeFile(path,png);
   return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:'Generating your image now'}},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Created cover',artifacts:[path]})}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
  };
  const profile={kind:'codex',executable:file,auth:'subscription'},options={prompt:'Make a cover',cwd:dir,sessionDirectory:join(dir,'children'),requires:['image_generation'],validateImage:async bytes=>{decodes++;return bytes.equals(png);}};
  const result=await api.executeAgent(profile,options,runner);assert.match(result.text,/Created cover/);assert.equal(result.artifacts.length,1);assert.equal(decodes,1);
  await assert.rejects(api.executeAgent(profile,{...options,validateImage:async()=>false},runner),/decode|raster/);
 });
});
test('image output refuses a symlinked ancestor before creating external files',{skip:!api.executeAgent||process.platform==='win32'},async()=>{
 await withCLI('',async(file,dir)=>{
  const cwd=join(dir,'repo'),outside=join(dir,'outside');await mkdir(cwd);await mkdir(outside);await symlink(outside,join(cwd,'output'));
  let calls=0;await assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Make a cover',cwd,sessionDirectory:join(dir,'children'),requires:['image_generation']},async()=>{calls++;return {code:0,stdout:''};}),/symlink|directory.*project/i);
  assert.equal(calls,0);assert.deepEqual(await readdir(outside),[]);
 });
});
test('combined output accepts project documents alongside fresh images but preserves image confinement',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 await withCLI('',async(file,dir)=>{
  const cwd=join(dir,'project');await mkdir(cwd);let mode='mixed',decoded=0;
  const runner=async(_f,_a,o)=>{
   const fresh=JSON.parse(o.input.match(/Image artifact directory: ("[^\n]+")/)[1]);
   const article=join(cwd,'article.md'),cover=join(fresh,'cover.png'),prompt=join(fresh,'prompt.txt'),outside=join(dir,'outside.md'),old=join(cwd,'old.png'),bad=join(fresh,'broken.png');
   await Promise.all([writeFile(article,'Article'),writeFile(cover,png),writeFile(prompt,'Native prompt'),writeFile(outside,'External'),writeFile(old,png),writeFile(bad,'not a raster')]);
   const artifacts={mixed:[article,cover,prompt],external:[outside,cover],stale:[old,cover],missing:[article,prompt],malformed:[bad,cover]}[mode];
   return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Combined deliverables',artifacts})}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
  };
  const profile={kind:'codex',executable:file,auth:'subscription'},options={prompt:'Article, code and cover',cwd,sessionDirectory:join(dir,'sessions'),requires:['image_generation'],validateImage:async b=>{decoded++;return b.equals(png);}};
  const result=await api.executeAgent(profile,options,runner);assert.equal(result.artifacts.length,1);assert.match(result.artifacts[0],/cover\.png$/);assert.match(result.text,/article\.md/);assert.equal(decoded,1);
  for(const [value,error] of [['external',/outside/],['stale',/fresh|outside/],['missing',/image artifacts/],['malformed',/decode|raster/]]){mode=value;await assert.rejects(api.executeAgent(profile,options,runner),error);}
 });
});
test('native classifier uses an isolated read-only CLI without user hooks, business tools or API credentials',async()=>{
 const job=api.invocation({kind:'codex',executable:'/native/codex',auth:'subscription',model:'gpt-test',thinking:'max'},{prompt:'Classify only',mode:'readonly'});
 assert.ok(job.args.includes('read-only'));assert.ok(!job.args.includes('workspace-write'));assert.ok(job.args.includes('--ignore-user-config'));assert.ok(job.args.includes('--ephemeral'));
 for(const flag of ['shell_tool','apps','plugins','hooks','multi_agent','image_generation','view_image','browser_use','computer_use'])assert.ok(job.args.includes(flag),flag);
 assert.ok(job.args.includes('model_reasoning_effort="max"'));assert.ok(job.args.includes('project_doc_max_bytes=0'));assert.ok(job.args.includes('skills.max_context_tokens=1'));
 for(const [i,arg] of job.args.entries())if(arg==='-c')assert.match(job.args[i+1],/^[A-Za-z_.]+=/);
 assert.throws(()=>api.invocation({kind:'codex',executable:'/native/codex',auth:'subscription',thinking:'invented'},{prompt:'task'}),/reasoning/i);
});
test('read-only native inference runs outside the project and removes its temporary directory',async()=>{
 await withCLI('',async(file,dir)=>{
  let isolated;
  await api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Summarize only',cwd:dir,mode:'readonly'},async(_file,_args,o)=>{
   isolated=o.cwd;assert.notEqual(isolated,dir);assert.deepEqual(await readdir(isolated),[]);
   return {code:0,stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:'summary'}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
  });
  await assert.rejects(readdir(isolated),/ENOENT/);
 });
});
test('shutdown escalates native processes that ignore TERM instead of waiting for task timeout',async()=>{
 await withCLI("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",async file=>{
  let ready,finished=false;const started=new Promise(r=>ready=r);const pending=api.runProcess(file,[],{timeoutMs:1800,onLine:()=>ready()}).then(()=>{finished=true;},()=>{finished=true;});
  await started;await api.stopAgents();await Promise.race([pending,new Promise(r=>setTimeout(r,500))]);
  try{assert.equal(finished,true);}finally{await pending;}
 });
});
test('session progress extraction validates IDs for all supported native protocols',()=>{
 for(const [kind,event] of [['codex',{type:'thread.started',thread_id:uuid}],['claude',{type:'system',session_id:uuid}],['gemini',{type:'init',session_id:uuid}],['pi',{type:'session',id:uuid}]])assert.equal(api.sessionIdFromEvent(kind,event),uuid);
 assert.equal(api.sessionIdFromEvent('codex',{type:'turn.started'}),null);assert.throws(()=>api.sessionIdFromEvent('codex',{type:'thread.started',thread_id:'invalid'}),/session ID/);
});
test('native resume rejects a different live session before forwarding subsequent work',async()=>{
 let continued=false;
 await assert.rejects(api.executeAgent({kind:'codex',executable:'/native/codex',auth:'subscription'},{prompt:'continue',resume:uuid},async(_file,_args,o)=>{
  o.onLine(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'}));continued=true;return {code:0,stdout:''};
 }),/different session/);assert.equal(continued,false);
});

test('a successful process-group hard kill is not repeated after its pipes close',{skip:process.platform==='win32'},async()=>{
 const original=process.kill;let hardKills=0;
 process.kill=function(pid,signal){if(pid<0&&signal==='SIGKILL'&&++hardKills>1)throw Object.assign(Error('kill EPERM after completed cleanup'),{code:'EPERM'});return original.call(process,pid,signal);};
 try{
  const child="process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  await withCLI(`import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>process.exit(0));`,async file=>assert.equal((await api.runProcess(file,[],{timeoutMs:5000})).code,0));
  assert.equal(hardKills,1);
 }finally{process.kill=original;}
});

test('native image validation rejects a replaced allocation even inside the project',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 for(const replacement of ['symlink','directory','ancestor'])await withCLI('',async(file,dir)=>{
  const old=join(dir,'old-images');await mkdir(old);await writeFile(join(old,'cover.png'),png);
  const runner=async(_f,_a,o)=>{
   const root=JSON.parse(o.input.match(/Image artifact directory: ("[^\n]+")/)[1]);
   if(replacement==='ancestor'){const parent=dirname(root);await rename(parent,parent+'-original');await mkdir(join(old,basename(root)));await writeFile(join(old,basename(root),'cover.png'),png);await symlink(old,parent);}else{await rename(root,root+'-original');if(replacement==='symlink')await symlink(old,root);else{await mkdir(root);await writeFile(join(root,'cover.png'),png);}}
   return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Image',artifacts:[join(root,'cover.png')]})}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
  };
  await assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Native image',cwd:dir,sessionDirectory:join(dir,'sessions'),requires:['image_generation'],validateImage:async()=>true},runner),/directory|allocation|symlink|changed/i);
 });
});
test('signal failures reject the caller without crashing the host and allow bounded cleanup',async()=>{
 const moduleUrl=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 for(const mode of ['term-once','kill-once','kill-always','protocol-once']){
  const source=`import {runProcess,stopAgents} from ${JSON.stringify(moduleUrl)};
const original=process.kill,groups=new Set();let failed=false;
process.on('exit',()=>{for(const pid of groups)try{original.call(process,pid,'SIGKILL');}catch{}});
process.kill=function(pid,signal){if(pid<0)groups.add(pid);const target=${JSON.stringify(mode)}.startsWith('term')?'SIGTERM':'SIGKILL';if(signal===target&&(!failed||${JSON.stringify(mode)}==='kill-always')){failed=true;throw Object.assign(Error('simulated signal permission failure'),{code:'EPERM'});}return original.call(process,pid,signal);};
const abort=new AbortController();try{await runProcess(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{signal:abort.signal,timeoutMs:5000,onLine:()=>{if(${JSON.stringify(mode)}==='protocol-once')throw Error('invalid native event');abort.abort();}});throw Error('Expected a signaling failure');}catch(e){if(e.code!=='EPERM')throw e;if(${JSON.stringify(mode)}==='protocol-once'&&!e.errors?.some(error=>error?.message==='invalid native event'))throw Error('Original protocol failure lost');if(${JSON.stringify(mode)}==='kill-always'&&e.mayBeRunning!==true)throw Error('Missing unknown execution state');console.log('handled signal failure');}finally{process.kill=original;await stopAgents().catch(e=>{if(!e.mayBeRunning)throw e;});}`;
  await withCLI(source,async file=>{const r=await api.runProcess(file,[],{timeoutMs:10000});assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/handled signal failure/);});
 }
});

test('shutdown attempts cleanup for every owned child even after one signaling error',async()=>{
 const url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import {runProcess,stopAgents} from ${JSON.stringify(url)};
const original=process.kill,groups=new Set(),signals=[];let failed=false;
process.on('exit',()=>{for(const pid of groups)try{original.call(process,pid,'SIGKILL');}catch{}});
process.kill=function(pid,signal){if(pid<0)groups.add(pid);signals.push({pid,signal});if(signal==='SIGTERM'&&!failed){failed=true;throw Object.assign(Error('first termination denied'),{code:'EPERM'});}return original.call(process,pid,signal);};
let one,two;const ready=[new Promise(r=>one=r),new Promise(r=>two=r)],script="process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
const pending=[runProcess(process.execPath,['-e',script],{onLine:()=>one(),timeoutMs:5000}),runProcess(process.execPath,['-e',script],{onLine:()=>two(),timeoutMs:5000})].map(p=>p.then(value=>({value}),error=>({error})));
try{await Promise.all(ready);await assert.rejects(stopAgents(),{code:'EPERM'});assert.equal(new Set(signals.filter(e=>e.signal==='SIGTERM').map(e=>e.pid)).size,2);const settled=await Promise.all(pending);assert.equal(settled.length,2);assert.ok(settled.some(r=>r.error?.code==='EPERM'));assert.ok(settled.every(r=>!r.error?.mayBeRunning));console.log('both children cleaned');}finally{process.kill=original;await stopAgents();await Promise.allSettled(pending);}`;
 await withCLI(source,async file=>{const result=await api.runProcess(file,[],{timeoutMs:10000});assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/both children cleaned/);});
});

test('temporary-file cleanup preserves execution failure and unknown-running metadata',{skip:process.platform==='win32'||process.getuid?.()===0},async()=>{
 await withCLI('',async(file,dir)=>{
  const sessions=join(dir,'sessions'),execution=Object.assign(Error('Native execution may still be running'),{code:'EPERM',mayBeRunning:true});
  try{
   await assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Image',cwd:dir,sessionDirectory:sessions,requires:['image_generation']},async()=>{await chmod(sessions,0o500);throw execution;}),error=>{assert.equal(error.mayBeRunning,true);assert.equal(error.cause,execution);assert.equal(error.errors[0],execution);assert.match(error.message,/cleanup|temporary/);return true;});
  }finally{await chmod(sessions,0o700);}
 });
});

test('Windows native execution fails closed before spawning or advertising agents',async()=>{
 const url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import {ChildProcess} from 'node:child_process';import {runProcess,discoverAgents,executeAgent} from ${JSON.stringify(url)};
const descriptor=Object.getOwnPropertyDescriptor(process,'platform'),spawn=ChildProcess.prototype.spawn;let spawns=0,probes=0;
Object.defineProperty(process,'platform',{value:'win32'});ChildProcess.prototype.spawn=function(){spawns++;throw Error('unexpected process spawn');};
try{await assert.rejects(runProcess(process.execPath,[]),/Windows.*not supported/i);await assert.rejects(executeAgent({kind:'codex',executable:'/codex',auth:'subscription'},{prompt:'No execution',cwd:process.argv[2],sessionDirectory:process.argv[2]+'/sessions',requires:['image_generation']},async()=>{spawns++;throw Error('unexpected executor');}),/Windows.*not supported/i);process.env.GEMINI_API_KEY='test-only';assert.deepEqual(await discoverAgents({codex:'/codex',claude:'/claude',gemini:'/gemini'},async()=>{probes++;throw Error('unexpected probe');}),[]);assert.equal(spawns,0);assert.equal(probes,0);console.log('Windows blocked before spawn');}finally{ChildProcess.prototype.spawn=spawn;Object.defineProperty(process,'platform',descriptor);}`;
 await withCLI(source,async(file,dir)=>{const r=await api.runProcess(file,[dir],{timeoutMs:5000});assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/Windows blocked before spawn/);});
});

test('fresh image subdirectories accept real directories and reject directory or file symlinks',{skip:process.platform==='win32'},async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 for(const mode of ['directory','document-link','directory-link','file-link','ancestor-link','parent-segment','image-named-doc-link'])await withCLI('',async(file,dir)=>{
  const runner=async(_f,_a,o)=>{const root=JSON.parse(o.input.match(/Image artifact directory: ("[^\n]+")/)[1]),real=join(root,'real');await mkdir(real);await writeFile(join(real,'cover.png'),png);let image=join(real,'cover.png');if(mode==='directory-link'){await symlink(real,join(root,'link'));image=join(root,'link','cover.png');}if(mode==='file-link'){image=join(root,'link.png');await symlink(join(real,'cover.png'),image);}if(mode==='ancestor-link'){await symlink(join(dir,'output'),join(dir,'alias'));image=join(dir,'alias','yam-images',basename(root),'real','cover.png');}if(mode==='parent-segment'){await writeFile(join(root,'cover.png'),png);const outside=join(dir,'elsewhere','child');await mkdir(outside,{recursive:true});await writeFile(join(dir,'elsewhere','cover.png'),'not the fresh cover');await symlink(outside,join(root,'link'));image=root+'/link/../cover.png';}const paths=[image];if(mode==='document-link'){await writeFile(join(dir,'article.md'),'# Article');await symlink(join(dir,'article.md'),join(dir,'article-link.md'));paths.push(join(dir,'article-link.md'));}if(mode==='image-named-doc-link'){await writeFile(join(dir,'article.md'),'# Article');const link=join(root,'broken-cover.png');await symlink(join(dir,'article.md'),link);paths.push(link);}return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Image',artifacts:paths})}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};};
  const result=api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Native image',cwd:dir,sessionDirectory:join(dir,'sessions'),requires:['image_generation'],validateImage:async()=>true},runner);
  if(['directory','document-link'].includes(mode))assert.equal((await result).artifacts.length,1);else await assert.rejects(result,/symlink|Invalid image|parent|traversal|decode|raster/i);
 });
});

test('shutdown alone settles pending executions when every POSIX signal fails',async()=>{
 const url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import {runProcess,stopAgents} from ${JSON.stringify(url)};
const signal=process.kill,groups=new Set();let ready;const started=new Promise(r=>ready=r);
process.kill=function(pid,s){if(pid<0){groups.add(pid);throw Object.assign(Error('signal denied'),{code:'EPERM'});}return signal.call(process,pid,s);};
const pending=runProcess(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{timeoutMs:10000,onLine:()=>ready()}).then(value=>({value}),error=>({error}));
try{await started;await assert.rejects(stopAgents(),e=>e.mayBeRunning===true);let deadline;const result=await Promise.race([pending,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('shutdown left execution pending')),1500))]).finally(()=>clearTimeout(deadline));assert.equal(result.error?.mayBeRunning,true);console.log('pending execution settled');}
finally{process.kill=signal;for(const group of groups)try{signal.call(process,group,'SIGKILL');}catch{}await new Promise(r=>setTimeout(r,30));await stopAgents().catch(e=>{if(!e.mayBeRunning)throw e;});await pending;}`;
 await withCLI(source,async file=>{const r=await api.runProcess(file,[],{timeoutMs:6000});assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/pending execution settled/);});
});

test('escaped descendants holding pipes cannot leave exit, abort, timeout or shutdown pending',{skip:process.platform==='win32'},async()=>{
 for(const mode of ['exit','abort','timeout','shutdown'])await withCLI(`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','inherit','inherit']});writeFileSync(process.argv[2],String(child.pid));child.unref();console.log('READY');${mode==='exit'?'':'setInterval(()=>{},1000);'}`,async(file,dir)=>{
  const pidFile=join(dir,'escaped.pid'),abort=new AbortController();let ready;const started=new Promise(r=>ready=r);let deadline;
  const pending=api.runProcess(file,[pidFile],{signal:abort.signal,timeoutMs:mode==='timeout'?1000:5000,onLine:()=>{ready();if(mode==='abort')abort.abort();}}).then(value=>({value}),error=>({error}));
  try{await Promise.race([started,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('CLI never became ready')),2500))]);clearTimeout(deadline);if(mode==='shutdown')await assert.rejects(api.stopAgents(),e=>e.mayBeRunning===true);const result=await Promise.race([pending,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('escaped pipe left invocation pending')),2500))]);assert.equal(result.error?.mayBeRunning,true,mode);await new Promise(r=>setTimeout(r,30));await assert.rejects(api.stopAgents(),e=>e.mayBeRunning===true);}finally{clearTimeout(deadline);try{process.kill(-Number(await (await import('node:fs/promises')).readFile(pidFile,'utf8')),'SIGKILL');}catch{}await pending;await api.stopAgents().catch(()=>{});}
 });
});

test('host termination signals clean detached native groups and preserve default termination',{skip:process.platform==='win32'},async()=>{
 const {spawn}=await import('node:child_process'),{readFile}=await import('node:fs/promises'),url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 for(const signal of ['SIGTERM','SIGINT','SIGHUP'])await withCLI(`import {runProcess} from ${JSON.stringify(url)};await runProcess(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));console.log('READY');setInterval(()=>{},1000)",process.argv[2]],{onLine:l=>console.log(l)});`,async(file,dir)=>{
  const pidFile=join(dir,'native.pid'),host=spawn(file,[pidFile],{stdio:['ignore','pipe','pipe']});let native,deadline;const exited=new Promise((resolve,reject)=>{host.on('exit',(code,signal)=>resolve({code,signal}));host.on('error',reject);});
  try{await Promise.race([new Promise(r=>host.stdout.once('data',r)),new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host not ready')),3000))]);clearTimeout(deadline);native=Number(await readFile(pidFile,'utf8'));host.kill(signal);const result=await Promise.race([exited,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host did not terminate')),2500))]);clearTimeout(deadline);assert.equal(result.signal,signal);assert.ok(await groupStopped(native),'detached group survived host termination: '+native);}finally{clearTimeout(deadline);if(native)try{process.kill(-native,'SIGKILL');}catch{}if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');await exited;}
 });
});

test('native signal cleanup preserves an existing host SIGINT handler',{skip:process.platform==='win32'},async()=>{
 const {spawn}=await import('node:child_process'),{readFile}=await import('node:fs/promises'),url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 await withCLI(`import {runProcess} from ${JSON.stringify(url)};setInterval(()=>{},1000);process.on('SIGINT',()=>console.log('HANDLED'));await runProcess(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));console.log('READY');setInterval(()=>{},1000)",process.argv[2]],{onLine:l=>console.log(l)});`,async(file,dir)=>{
  const pidFile=join(dir,'native.pid'),host=spawn(file,[pidFile],{stdio:['ignore','pipe','pipe']});let native,deadline;const exited=new Promise(r=>host.on('exit',r));
  try{await Promise.race([new Promise(r=>host.stdout.once('data',r)),new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host not ready')),3000))]);clearTimeout(deadline);native=Number(await readFile(pidFile,'utf8'));const handled=new Promise(r=>host.stdout.once('data',r));host.kill('SIGINT');assert.match(String(await Promise.race([handled,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host handler did not run')),1500))])),/HANDLED/);assert.ok(await groupStopped(native),'native group is not confirmed stopped: '+native);assert.equal(host.exitCode,null);assert.equal(host.signalCode,null);}finally{clearTimeout(deadline);if(native)try{process.kill(-native,'SIGKILL');}catch{}host.kill('SIGKILL');await exited;}
 });
});

test('host termination drains native independent tool groups before preserving signal behavior',{skip:process.platform==='win32'},async t=>{
 const {spawn}=await import('node:child_process'),{readFile}=await import('node:fs/promises'),url=new URL('../src-tauri/pi/agent-executor.mjs',import.meta.url).href;
 const tool="process.on('SIGTERM',()=>process.exit(0));process.send('READY');setInterval(()=>{},1000);";
 const nativeSource=`const {spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');let child,interrupts=0;const record=()=>writeFileSync(process.argv[1],JSON.stringify({native:process.pid,tool:child.pid,interrupts}));process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{interrupts++;record();process.kill(-child.pid,'SIGTERM');if(process.argv[2]!=='fallback')setTimeout(()=>process.exit(130),120);});child=spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{record();console.log('READY');});setInterval(()=>{},1000);`;
 for(const mode of ['SIGTERM','SIGINT','SIGHUP','listener','once-listener','mixed','repeated','fallback'])await t.test(mode,async()=>{
  const hasHandler=['listener','once-listener','mixed'].includes(mode),signal=hasHandler?'SIGINT':['repeated','fallback'].includes(mode)?'SIGTERM':mode;
  const listener=hasHandler?`setInterval(()=>{},1000);process.${mode==='listener'?'on':'once'}('SIGINT',()=>{console.log('HANDLED');${mode==='once-listener'?"setTimeout(()=>console.log('ALIVE'),2300);":''}});`:'';
  await withCLI(`import {runProcess} from ${JSON.stringify(url)};${listener}await runProcess(process.execPath,['-e',${JSON.stringify(nativeSource)},process.argv[2],${JSON.stringify(mode)}],{gracefulInterrupt:true,onLine:l=>console.log(l)}).catch(error=>{if(!error.mayBeRunning)throw error;});`,async(file,dir)=>{
   const pidFile=join(dir,'owned.json'),host=spawn(file,[pidFile],{stdio:['ignore','pipe','pipe']});let pids,deadline,repeated;
   const exited=new Promise((resolve,reject)=>{host.on('exit',(code,signal)=>resolve({code,signal}));host.on('error',reject);});
   try{
    await Promise.race([new Promise(r=>host.stdout.once('data',r)),new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host not ready')),3000))]);clearTimeout(deadline);pids=JSON.parse(await readFile(pidFile,'utf8'));
    const handled=hasHandler?new Promise(r=>host.stdout.once('data',r)):null,survived=mode==='once-listener'?new Promise(resolve=>host.stdout.on('data',chunk=>{if(String(chunk).includes('ALIVE'))resolve();})):null;
    host.kill(signal);if(['repeated','mixed'].includes(mode))repeated=setTimeout(()=>host.kill(mode==='mixed'?'SIGTERM':signal),25);
    if(handled){assert.match(String(await Promise.race([handled,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('existing handler did not run')),1500))])),/HANDLED/);clearTimeout(deadline);}
    if(survived){await Promise.race([survived,exited.then(()=>{throw Error('once listener host terminated after native cleanup');}),new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('once listener host did not remain active')),4000))]);clearTimeout(deadline);}
    if(!hasHandler||mode==='mixed'){const result=await Promise.race([exited,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('host did not terminate')),5000))]);clearTimeout(deadline);assert.equal(result.signal,mode==='mixed'?'SIGTERM':signal);}
    assert.ok(await groupStopped(pids.tool),'independent tool group survived host '+mode);assert.ok(await groupStopped(pids.native),'native group survived host '+mode);assert.equal(JSON.parse(await readFile(pidFile,'utf8')).interrupts,1,'native received duplicate interrupts');
    if(hasHandler&&mode!=='mixed'){assert.equal(host.exitCode,null);assert.equal(host.signalCode,null);}
   }finally{clearTimeout(deadline);clearTimeout(repeated);for(const pid of [pids?.tool,pids?.native].filter(Number.isInteger))try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');await exited;}
  });
 });
});

test('image validation rejects files and allocations replaced during asynchronous decoding',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 for(const mode of ['unchanged','symlink','directory','overwrite','earlier-image','document'])await withCLI('',async(file,dir)=>{
  let root,image,doc,decodes=0;const outside=dir+'-outside.png';await writeFile(outside,png);
  const runner=async(_f,_a,o)=>{root=JSON.parse(o.input.match(/Image artifact directory: ("[^\n]+")/)[1]);image=join(root,'cover.png');await writeFile(image,png);const paths=[image];if(mode==='earlier-image'){const next=join(root,'next.png');await writeFile(next,png);paths.push(next);}if(mode==='document'){doc=join(dir,'article.md');await writeFile(doc,'# Article');paths.unshift(doc);}return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:uuid},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Image',artifacts:paths})}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};};
  try{const result=api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'Native image',cwd:dir,sessionDirectory:join(dir,'sessions'),requires:['image_generation'],validateImage:async()=>{decodes++;if(mode==='symlink'){await unlink(image);await symlink(outside,image);}if(mode==='directory'){await rename(root,root+'-original');await mkdir(root);await writeFile(image,png);}if(mode==='overwrite'||mode==='earlier-image'&&decodes===2)await writeFile(image,'changed');if(mode==='document'){await unlink(doc);await symlink(outside,doc);}return true;}},runner);if(mode==='unchanged')assert.equal((await result).artifacts.length,1);else await assert.rejects(result,/changed|symlink|allocation|directory/i);}finally{await rm(outside,{force:true});}
 });
});

test('only explicitly enabled subscription main tasks get bounded native multi-agent configuration',()=>{
 const profile={kind:'codex',executable:'/native/codex',auth:'subscription',model:'gpt-main'};
 const main=api.invocation(profile,{prompt:'Complete and verify the goal',allowCollaboration:true});
 for(const argument of ['--ignore-user-config','agents.max_depth=1','agents.max_concurrent_threads_per_session=3','forced_login_method="chatgpt"','model_provider="openai"'])assert.ok(main.args.includes(argument),argument);
 assert.ok(main.args.some((v,i)=>v==='--enable'&&main.args[i+1]==='multi_agent'));
 assert.equal(main.env.OPENAI_API_KEY,undefined);assert.equal(main.env.CODEX_API_KEY,undefined);assert.equal(main.env.OPENAI_BASE_URL,undefined);
 for(const options of [{},{allowCollaboration:'true'},{mode:'readonly',allowCollaboration:true}]){
  const job=api.invocation(profile,{prompt:'Do only this assigned task',...options});
  assert.ok(job.args.some((v,i)=>v==='--disable'&&job.args[i+1]==='multi_agent'));
  assert.ok(!job.args.some((v,i)=>v==='--enable'&&job.args[i+1]==='multi_agent'));
 }
});

test('isolated native inference and collaboration retain only the observed system proxy feature value',async()=>{
 for(const value of [true,false,undefined]){
  const features='image_generation stable true\n'+(value===undefined?'':'respect_system_proxy under development '+value+'\n')+'unrelated_feature stable '+(!value)+'\n';
  const [profile]=await api.discoverAgents({codex:'/native/codex'},async(_file,args)=>({code:0,stdout:args[0]==='features'?features:'Logged in using ChatGPT',stderr:''}));
  for(const options of [{mode:'readonly'},{allowCollaboration:true}]){
   const job=api.invocation(profile,{prompt:'Isolated work',...options}),overrides=job.args.filter(s=>s.startsWith('features.respect_system_proxy='));
   assert.deepEqual(overrides,value===undefined?[]:['features.respect_system_proxy='+value]);
   assert.ok(!job.args.some(s=>s.startsWith('agents.')&&!['agents.max_depth=1','agents.max_concurrent_threads_per_session=3'].includes(s)));
  }
 }
});

test('native image capabilities cannot be inferred from a later feature line',async()=>{
 const [profile]=await api.discoverAgents({codex:'/native/codex'},async(_file,args)=>({code:0,stdout:args[0]==='features'?'image_generation stable false\nother_feature stable true\n':'Logged in using ChatGPT',stderr:''}));assert.ok(!profile.capabilities.includes('image_generation'));
});

test('native Codex cancellation interrupts gracefully so its separately grouped tool process is stopped',async()=>{
 const childSource="process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);";
 const source=`import {spawn} from 'node:child_process';let child;process.on('SIGTERM',()=>process.exit(143));process.on('SIGINT',()=>{if(child)process.kill(-child.pid,'SIGTERM');setTimeout(()=>process.exit(130),50);});process.stdin.resume();process.stdin.on('end',()=>{child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});console.log(JSON.stringify({type:'heartbeat_ready',pid:child.pid}));setInterval(()=>{},1000);});`;
 for(const mode of ['abort','shutdown'])await withCLI(source,async file=>{
  const abort=new AbortController();let pid,ready;const started=new Promise(resolve=>ready=resolve);
  try{
   const execution=assert.rejects(api.executeAgent({kind:'codex',executable:file,auth:'subscription'},{prompt:'cancel fixture',signal:abort.signal,onLine:line=>{const event=JSON.parse(line);if(event.type==='heartbeat_ready'){pid=event.pid;ready();if(mode==='abort')setTimeout(()=>abort.abort(),80);}}}),/aborted|exit/);
   await started;if(mode==='shutdown'){await new Promise(resolve=>setTimeout(resolve,80));await api.stopAgents().catch(error=>{if(!error.mayBeRunning)throw error;});}await execution;
   assert.ok(Number.isInteger(pid));assert.equal(await groupStopped(pid),true,'Native tool group survived '+mode);
  }finally{if(pid)try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
 });
});

test('forced fallback after an unacknowledged native interrupt stays uncertain and preserves replay protection',async()=>{
 await withCLI("process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000);",async file=>{
  const abort=new AbortController();let pid;
  await assert.rejects(api.runProcess(file,[],{gracefulInterrupt:true,signal:abort.signal,onLine:line=>{pid=Number(line);abort.abort();}}),error=>error.mayBeRunning===true);
  assert.equal(await groupStopped(pid),true,'Outer native process group was not hard stopped');
 });
});

test('graceful success exit cannot resolve after uncertain descendant pipe cleanup',async()=>{
 const descendant="process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.send('ready');setInterval(()=>{},1000);";
 for(const mode of ['exit','shutdown'])await withCLI(`import {spawn} from 'node:child_process';process.on('SIGINT',()=>process.exit(0));const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',()=>{console.log(JSON.stringify({root:process.pid,child:child.pid}));${mode==='exit'?'process.exit(0);':'setInterval(()=>{},1000);'}});`,async file=>{
  let ready,root;const started=new Promise(resolve=>ready=resolve),execution=api.runProcess(file,[],{gracefulInterrupt:true,timeoutMs:10000,onLine:line=>{root=JSON.parse(line).root;ready();}}).then(value=>({value}),error=>({error}));
  try{await started;if(mode==='shutdown')await api.stopAgents().catch(error=>{if(!error.mayBeRunning)throw error;});const result=await execution;assert.equal(result.error?.mayBeRunning,true,mode+' uncertainty became successful code '+result.value?.code);assert.equal(await groupStopped(root),true);}
  finally{if(root)try{process.kill(-root,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 });
});
