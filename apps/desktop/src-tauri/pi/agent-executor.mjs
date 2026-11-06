// Author: Jeff.Liu. Native CLIs own credentials and tools; YAM owns only these child processes.
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {mkdir,lstat,stat,writeFile,readFile,realpath,mkdtemp,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve,relative,sep,dirname} from 'node:path';
import {nativeError,withFailure,failureOf,projectFailure} from './failure.mjs';
export const isNativeSessionId=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const owned=new Map(),CLEANUP_GRACE_MS=250,CLEANUP_ATTEMPTS=2;
const WINDOWS_UNSUPPORTED='YAM Pi native execution on Windows is not supported until process-tree cleanup is available; no task started or backend fallback';
const kill=(child,signal)=>{const state=owned.get(child);if(!state||state.hardKilled||(state.closed&&state.uncertain))return;try{if(child.pid)process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH'){child.emit('error',e);throw e;}}if(signal==='SIGKILL'){state.hardKilled=true;if(state.closed&&!state.uncertain)owned.delete(child);}};
const stopOnExit=()=>{for(const child of owned.keys()){try{kill(child,'SIGKILL');}catch{}}};
process.once('exit',stopOnExit);
let hostSignalCleanup=null;
for(const signal of process.platform==='win32'?[]:['SIGTERM','SIGINT','SIGHUP']){
 const handle=()=>{
  const hasOtherListeners=process.listenerCount(signal)>1;
  const finish=()=>{if(!hasOtherListeners&&process.listenerCount(signal)===1){process.removeListener(signal,handle);process.kill(process.pid,signal);}};
  if(!hostSignalCleanup&&![...owned.values()].some(state=>state.gracefulInterrupt&&!state.closed&&!state.hardKilled)){stopOnExit();finish();return;}
  hostSignalCleanup??=stopAgents().catch(()=>stopOnExit()).finally(()=>{hostSignalCleanup=null;});
  void hostSignalCleanup.then(finish);
 };
 process.prependListener(signal,handle);
}
export function runProcess(file,args,{input='',cwd,env=process.env,signal,timeoutMs=600000,maxBytes=2*1024*1024,onLine,onSpawn,gracefulInterrupt=false}={}){
 if(signal?.aborted)return Promise.reject(nativeError('cancelled','Agent aborted',{stage:'dispatch'}));
 if(process.platform==='win32')return Promise.reject(nativeError('platform-unsupported',WINDOWS_UNSUPPORTED));
 return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd,env,shell:false,detached:true,stdio:['pipe','pipe','pipe']}),chunks={stdout:'',stderr:''},state={hardKilled:false,closed:false,uncertain:false,gracefulInterrupt:gracefulInterrupt===true};
  owned.set(child,state);
  let bytes=0,pending='',failure=null,failed=false,cleanupFailure=null,escalation,hardStopPromise;
  const signalChild=signal=>{try{kill(child,signal);return true;}catch(error){cleanupFailure??=error;return false;}};
  const hardStop=()=>hardStopPromise??=(async()=>{for(let attempt=0;attempt<CLEANUP_ATTEMPTS;attempt++){if(signalChild('SIGKILL'))return true;if(!attempt)await new Promise(r=>setTimeout(r,CLEANUP_GRACE_MS));}return false;})();
  const rememberFailure=error=>{if(!failed){failed=true;failure=error;}};
  const processError=stopped=>{
   const original=failed?failure:cleanupFailure,errors=failed?[failure]:[];if(cleanupFailure&&!errors.includes(cleanupFailure))errors.push(cleanupFailure);
   const unconfirmed=!stopped||state.uncertain;
   const error=unconfirmed||errors.length>1?Object.assign(new AggregateError(errors,(unconfirmed?'Native process cleanup failed; it may still be running. Inspect it before retrying. ':'')+String(original?.message??original)+(cleanupFailure&&cleanupFailure!==original?'; cleanup failed: '+cleanupFailure.message:''),{cause:original}),{code:cleanupFailure?.code??original?.code,mayBeRunning:unconfirmed||Boolean(original?.mayBeRunning)}):original;
   return withFailure(error,failureOf(error,{stage:child.pid?'execution':'dispatch',dispatch:child.pid?'started':'not-started'}));
  };
  const scheduleHardStop=()=>{escalation??=setTimeout(()=>{void (async()=>{if(gracefulInterrupt&&!state.closed){state.interruptUnconfirmed=true;signalChild('SIGTERM');await new Promise(r=>setTimeout(r,CLEANUP_GRACE_MS));}return hardStop();})().then(async stopped=>{
   if(stopped&&!state.closed)await new Promise(r=>setTimeout(r,CLEANUP_GRACE_MS));
   if(!stopped||!state.closed){state.uncertain=true;rememberFailure(cleanupFailure??Error('Native output pipes did not close; descendants may still be running'));clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(processError(false));child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();}
  });},gracefulInterrupt?2000:CLEANUP_GRACE_MS);};
  const stop=error=>{if(failed)return;rememberFailure(error);signalChild(gracefulInterrupt?'SIGINT':'SIGTERM');scheduleHardStop();};
  const abort=()=>stop(nativeError('cancelled','Agent aborted',{stage:'execution',dispatch:child.pid?'started':'not-started'}));
  const timer=setTimeout(()=>stop(nativeError('process-timeout','Agent timed out; execution was stopped, not retried',{stage:'execution',dispatch:child.pid?'started':'not-started'})),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  for(const name of ['stdout','stderr']){
   child[name].setEncoding('utf8');
   child[name].on('data',chunk=>{
    if(failed)return;
    bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes){stop(nativeError('output-limit','Agent output limit exceeded',{stage:'execution',dispatch:'started'}));return;}
    chunks[name]+=chunk;
    if(name==='stdout'&&onLine){
     pending+=chunk;
     for(let index;(index=pending.indexOf('\n'))>=0;){const line=pending.slice(0,index).replace(/\r$/,'');pending=pending.slice(index+1);try{if(line)onLine(line);}catch(e){stop(e);break;}}
    }
   });
  }
  child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop(e);});
  child.on('error',error=>{rememberFailure(child.pid?error:withFailure(error,{code:'spawn-failed',stage:'dispatch',dispatch:'not-started'}));scheduleHardStop();});
  child.on('exit',()=>{signalChild('SIGTERM');scheduleHardStop();});
  child.on('close',async(code,exitSignal)=>{
   state.closed=true;
   clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',abort);
   const stopped=await hardStop();state.uncertain||=!stopped||Boolean(state.interruptUnconfirmed);if((stopped||state.hardKilled)&&!state.uncertain)owned.delete(child);
   if(!stopped||failed||cleanupFailure||state.uncertain)reject(processError(stopped));else resolve({...chunks,code,signal:exitSignal});
  });
  if(child.pid&&onSpawn)try{onSpawn({pid:child.pid,pgid:child.pid});}catch(error){stop(error);}
  child.stdin.end(input);
 });
}
export async function stopAgents(){
 const children=[...owned],errors=[];
 for(const [child,state] of children)try{kill(child,state.gracefulInterrupt?'SIGINT':'SIGTERM');}catch(error){errors.push(error);}
 if(children.length)await new Promise(resolve=>setTimeout(resolve,children.some(([,state])=>state.gracefulInterrupt)?2000:CLEANUP_GRACE_MS));
 const draining=children.filter(([child,state])=>state.gracefulInterrupt&&owned.has(child)&&!state.closed);
 for(const [child,state] of draining){state.interruptUnconfirmed=true;try{kill(child,'SIGTERM');}catch(error){errors.push(error);}}
 if(draining.length)await new Promise(resolve=>setTimeout(resolve,CLEANUP_GRACE_MS));
 const remaining=new Set(children.map(([child])=>child).filter(child=>owned.has(child)));
 for(let attempt=0;attempt<CLEANUP_ATTEMPTS&&remaining.size;attempt++){
  for(const child of remaining){if(!owned.has(child)){remaining.delete(child);continue;}try{kill(child,'SIGKILL');remaining.delete(child);}catch(error){errors.push(error);}}
  if(remaining.size&&attempt+1<CLEANUP_ATTEMPTS)await new Promise(resolve=>setTimeout(resolve,CLEANUP_GRACE_MS));
 }
 if(children.some(([,state])=>!state.closed))await new Promise(resolve=>setTimeout(resolve,CLEANUP_GRACE_MS));
 const uncertain=children.filter(([child,state])=>remaining.has(child)||state.uncertain||!state.closed);
 if(uncertain.length){const error=Object.assign(Error('Native process cleanup is unconfirmed; execution may continue. Inspect it before retrying: '+(errors[0]?.message??'output pipes remain open')),{code:errors[0]?.code,cause:errors[0],mayBeRunning:true});for(const [child,state] of uncertain){state.uncertain=true;child.emit('error',error);}throw error;}
 if(errors.length)throw errors[0];
}

export const maxAgentPromptCharacters=128000;
export function validateAgentPrompt(prompt){
 if(typeof prompt!=='string'||!prompt.trim()||prompt.includes('\0'))throw nativeError('protocol-invalid','Invalid agent prompt');
 if(prompt.length>maxAgentPromptCharacters)throw nativeError('context-budget','Native handoff context exceeds the 128000 character budget; compact or split the task explicitly');
}
export function invocation(profile,{prompt,resume=null,sessionDirectory,imagePaths=[],imageSchema,images=[],mode='task',allowCollaboration=false}={}){
 validateAgentPrompt(prompt);
 if(!isAbsolute(profile.executable??''))throw Error('Agent executable must be an absolute installed path');
 if(resume!==null&&!isNativeSessionId(resume))throw nativeError('protocol-invalid','Invalid child session ID');
 const env={...process.env};
 for(const name of Object.keys(env))if(name.startsWith('YAM_'))delete env[name];
 env.YAM_AGENT_ROUTING_CHILD='1';
 let args=[],id=resume;
 if(profile.kind==='codex'){
  if(profile.auth!=='subscription')throw nativeError('subscription-required','Codex delegation requires a verified ChatGPT subscription login');
  for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[name];
  args=['exec','--json','--skip-git-repo-check','--sandbox',mode==='readonly'?'read-only':'workspace-write','-c','approval_policy="never"','-c','forced_login_method="chatgpt"','-c','model_provider="openai"'];
  if((mode==='readonly'||allowCollaboration===true)&&typeof profile.runtimeFeatures?.respect_system_proxy==='boolean')args.push('-c',`features.respect_system_proxy=${profile.runtimeFeatures.respect_system_proxy}`);
  if(mode!=='readonly'&&allowCollaboration===true){
   // Ignore role/provider overrides while retaining native authentication and default Skill discovery.
   args.push('--ignore-user-config','--enable','multi_agent','-c','agents.max_depth=1','-c','agents.max_concurrent_threads_per_session=3');
  }else args.push('--disable','multi_agent');
  if(mode==='readonly'){
   if(resume)throw Error('Read-only inference cannot resume a business session');
   args.push('--ignore-user-config','--ignore-rules','--ephemeral','-c','project_doc_max_bytes=0','-c','skills.max_context_tokens=1','-c','web_search="disabled"');
   for(const feature of ['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','image_generation','memories','goals','skill_mcp_dependency_install','view_image','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use'])args.push('--disable',feature);
  }
  if(profile.model)args.push('--model',profile.model);
  if(profile.thinking){
   const level=({off:'none',minimal:'minimal',low:'low',medium:'medium',high:'high',max:'max',xhigh:'xhigh',ultra:'ultra',none:'none'})[profile.thinking];
   if(!level)throw nativeError('capability-unavailable','Unsupported native Codex reasoning level');
   args.push('-c',`model_reasoning_effort=${JSON.stringify(level)}`);
  }
  if(resume)args.push('resume',resume);
  for(const path of imagePaths)args.push('--image',path);
  if(imageSchema)args.push('--output-schema',imageSchema);
  args.push('-');
 }else if(profile.kind==='claude'){
  args=['-p','--output-format','stream-json','--verbose','--permission-mode','default'];
  if(profile.model)args.push('--model',profile.model);
  if(profile.thinking)args.push('--effort',profile.thinking);
  if(resume)args.push('--resume',resume);
  if(images.length){args.push('--input-format','stream-json');prompt=JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt},...images.map(i=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.data}}))]}})+'\n';}
 }else if(profile.kind==='gemini'){
  args=['--prompt','Execute the task supplied on stdin.','--output-format','stream-json','--approval-mode','default'];
  if(profile.thinking)throw Error('Fixed reasoning is not verified for the Gemini adapter');
  if(profile.model)args.push('--model',profile.model);
  if(images.length)throw Error('Gemini image input is not verified for this adapter');
  if(resume)args.push('--resume',resume);
 }else if(profile.kind==='pi'){
  if(!isAbsolute(sessionDirectory??'')||typeof profile.model!=='string'||!profile.model.includes('/'))throw Error('Pi child requires its owned session directory and configured model');
  id??=randomUUID();
  args=['--print','--mode','json','--model',profile.model,'--session',join(sessionDirectory,id+'.jsonl')];
  if(profile.id==='pi-small')args.push('--no-tools','--no-extensions');
  else if(profile.tools)args.push('--tools',profile.tools.join(','));
  if(profile.thinking)args.push('--thinking',profile.thinking);
  if(profile.gateway){
   if(!isAbsolute(profile.extension??''))throw Error('Dynamic gateway child requires its staged provider extension');
   args.push('--extension',profile.extension,'--yam-gateway',profile.gateway);
  }
  args.push(...imagePaths.map(path=>'@'+path));
 }else throw Error('Unsupported agent executor');
 return {file:profile.executable,args,env,input:prompt,sessionId:id};
}
export function sessionIdFromEvent(kind,event){
 const value=kind==='codex'?(event.type==='thread.started'?event.thread_id:null):kind==='claude'?event.session_id:kind==='gemini'?(event.type==='init'?event.session_id:null):kind==='pi'?(event.type==='session'?event.id:null):null;
 if(value!==undefined&&value!==null&&!isNativeSessionId(value))throw nativeError('protocol-invalid','Invalid native session ID',{stage:'verification',dispatch:'started'});
 return value??null;
}
export function parseEvents(kind,stdout){
 let text='',finalText='',session=null,terminal=false,failed=false,usage=null;
 const items=[];
 for(const line of stdout.split('\n').filter(l=>l.trim())){
  let event;try{event=JSON.parse(line);}catch(error){throw withFailure(error,{code:'protocol-invalid',stage:'verification',dispatch:'started'});}session=sessionIdFromEvent(kind,event)??session;
  if(kind==='codex'){
   if(event.type==='item.completed'){items.push(event.item);if(event.item?.type==='agent_message'){finalText=event.item.text;text+=event.item.text+'\n';}}
   if(event.type==='turn.completed'){terminal=true;usage=event.usage??null;}
   if(event.type==='turn.failed'||event.type==='error')failed=true;
  }else if(kind==='claude'){
   if(event.type==='result'){terminal=true;failed||=event.is_error===true;usage=event.usage??null;text=event.result??'';}
  }else if(kind==='gemini'){
   if(event.type==='message'&&event.role==='assistant')text+=event.content??'';
   if(event.type==='error')failed=true;
   if(event.type==='result'){terminal=true;failed||=event.status!=='success';usage=event.stats??null;}
  }else if(kind==='pi'){
   if(event.type==='message_end'&&event.message?.role==='assistant'){
    const m=event.message;failed||=['error','aborted','length'].includes(m.stopReason);usage=m.usage??null;
    text=(m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
   }
   if(event.type==='agent_settled'){terminal=true;failed||=event.aborted===true;}
  }else throw Error('Unsupported agent protocol');
 }
 if(failed)throw nativeError('native-reported-error','Agent reported a failed task; no automatic retry or channel fallback',{stage:'execution',dispatch:'started'});
 if(!terminal)throw nativeError('protocol-invalid','Agent exited without a successful terminal event',{stage:'verification',dispatch:'started'});
 if(session!==null&&!isNativeSessionId(session))throw nativeError('protocol-invalid','Invalid native child session ID',{stage:'verification',dispatch:'started'});
 if(!text.trim())throw nativeError('answer-missing','Agent returned no final answer',{stage:'verification',dispatch:'started'});
 return {text:text.trim(),finalText:finalText||text.trim(),sessionId:session,usage,items};
}
export async function discoverAgents(executables,probe=runProcess,{onFailure}={}){
 if(process.platform==='win32')return [];
 const agents=[];
 if(executables.codex){
  try{
   const auth=await probe(executables.codex,['login','status'],{timeoutMs:3000,maxBytes:16384});
   if(auth.code===0&&/Logged in using ChatGPT/i.test(auth.stdout+auth.stderr)){
    const features=await probe(executables.codex,['features','list'],{timeoutMs:3000,maxBytes:65536});
    const proxyFeature=features.code===0?features.stdout.match(/^respect_system_proxy[ \t]+\S+(?:[ \t]+\S+)*[ \t]+(true|false)[ \t]*$/m):null;
    agents.push({id:'codex',kind:'codex',executable:executables.codex,auth:'subscription',...proxyFeature?{runtimeFeatures:{respect_system_proxy:proxyFeature[1]==='true'}}:{},capabilities:['text','files','image_input',...features.code===0&&/^image_generation[ \t]+\S+(?:[ \t]+\S+)*[ \t]+true[ \t]*$/m.test(features.stdout)?['image_generation']:[]]});
   }else onFailure?.('codex',projectFailure({code:auth.code===1&&auth.stdout===''&&auth.stderr==='Not logged in\n'?'not-logged-in':'native-unavailable',stage:'discovery',dispatch:'not-started'}));
  }catch{onFailure?.('codex',projectFailure({code:'native-unavailable',stage:'discovery',dispatch:'not-started'}));}
 }
 if(executables.claude){
  try{
   const auth=await probe(executables.claude,['auth','status','--json'],{timeoutMs:3000,maxBytes:16384}),data=JSON.parse(auth.stdout);
   const billing={'claude.ai':'subscription',oauth_token:'subscription',api_key:'api',api_key_helper:'api'}[data.authMethod];
   if(auth.code===0&&data.loggedIn===true&&billing)agents.push({id:'claude',kind:'claude',executable:executables.claude,auth:billing,capabilities:['text','files','image_input']});
  }catch{}
 }
 // Gemini exposes no verified status probe here; only an explicitly configured API-key channel is advertised.
 if(executables.gemini&&process.env.GEMINI_API_KEY)agents.push({id:'gemini',kind:'gemini',executable:executables.gemini,auth:'api',capabilities:['text','files']});
 return agents;
}
// Catalog snapshots may be stale for one minute; execution always checks the current login.
export function createAgentDiscovery({probe=runProcess,now=()=>performance.now(),ttlMs=60000,identity=async file=>{try{const m=await stat(file);return JSON.stringify([await realpath(file),m.ino,m.size,m.mtimeMs,m.ctimeMs]);}catch{return null;}}}={}){
 ttlMs=Math.min(ttlMs,60000);const entries=new Map();
 return async(executables,{execution=false,refresh=false,onFailure}={})=>(await Promise.all(Object.entries(executables).filter(([,file])=>file).map(async([kind,file])=>{
  const key=kind+':'+file,stamp=await identity(file);let entry=entries.get(key);
  if((!stamp&&!entry?.pending)||refresh||entry?.stamp!==stamp){entry={stamp,profile:null,expires:0,feature:null,pending:null};entries.set(key,entry);}
  if(!execution&&!refresh&&entry.profile&&now()<entry.expires)return structuredClone(entry.profile);
  const load=async()=>{
   let healthy=true,failure=null;
   const result=await discoverAgents({[kind]:file},async(f,args,options)=>{
    if(args[0]==='features'&&stamp&&entry.feature&&now()<entry.feature.expires)return entry.feature.result;
    const r=await probe(f,args,options);if(r.code!==0)healthy=false;
    if(args[0]==='features'&&r.code===0&&stamp)entry.feature={result:r,expires:now()+ttlMs};return r;
   },{onFailure:(_kind,value)=>{failure=value;}});
   entry.profile=healthy&&result.length?structuredClone(result):null;entry.expires=Math.min(now()+ttlMs,entry.feature?.expires??Infinity);return {profiles:result,failure};
  };
  const pending=execution||refresh?load():entry.pending??(entry.pending=load());
  try{const result=await pending;if(result.failure)onFailure?.(kind,structuredClone(result.failure));return structuredClone(result.profiles);}finally{if(entry.pending===pending)entry.pending=null;}
 }))).flat();
}
export async function executeAgent(profile,options,runner=runProcess){
 if(process.platform==='win32')throw nativeError('platform-unsupported',WINDOWS_UNSUPPORTED);
 const images=options.images??[];
 if(images.length>8||images.some(i=>!['image/png','image/jpeg','image/webp','image/gif'].includes(i.mimeType)||typeof i.data!=='string'||i.data.length>16*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(i.data)))throw nativeError('capability-unavailable','Invalid or oversized image attachment');
 let temporary,executionError,executionFailed=false,dispatched=false;
 let artifactDirectory;const allocatedDirectories=[];
 try{
 const extra={};
 if(options.mode==='readonly'){
  if(profile.kind!=='codex'||options.requires?.includes('image_generation'))throw nativeError('capability-unavailable','Read-only mode requires isolated native Codex inference');
  temporary=await mkdtemp(join(tmpdir(),'yam-codex-read-'));extra.cwd=temporary;
 }
 if(images.length||options.requires?.includes('image_generation')){
  if(!isAbsolute(options.sessionDirectory??''))throw Error('Images require an owned session directory');
  if(!temporary){await mkdir(options.sessionDirectory,{recursive:true,mode:0o700});temporary=await mkdtemp(join(options.sessionDirectory,'.input-'));}
  extra.imagePaths=[];
  for(const [index,image] of images.entries()){
   const path=join(temporary,`${index}.${{'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[image.mimeType]}`);
   await writeFile(path,Buffer.from(image.data,'base64'),{mode:0o600});extra.imagePaths.push(path);
  }
  if(options.requires?.includes('image_generation')){
   if(profile.kind!=='codex')throw Error('Image artifact verification requires the native Codex adapter');
   extra.imageSchema=join(temporary,'output-schema.json');
   let parent=await realpath(options.cwd);allocatedDirectories.push(await imageDirectoryIdentity(parent));
   for(const name of ['output','yam-images']){
    parent=join(parent,name);await mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    allocatedDirectories.push(await imageDirectoryIdentity(parent));
   }
   artifactDirectory=await mkdtemp(join(parent,'image-'));allocatedDirectories.push(await imageDirectoryIdentity(artifactDirectory));
   await writeFile(extra.imageSchema,JSON.stringify({type:'object',properties:{summary:{type:'string'},artifacts:{type:'array',minItems:1,items:{type:'string'}}},required:['summary','artifacts'],additionalProperties:false}),{mode:0o600});
  }
 }
 const job=invocation(profile,{...options,...extra,prompt:options.prompt+(extra.imageSchema?'\nUse the native image generation tool. Save freshly generated images in the image artifact directory. Return JSON with summary and artifacts listing canonical image paths without parent traversal. Do not replace image generation with SVG, placeholder files or API calls.\nImage artifact directory: '+JSON.stringify(artifactDirectory):'')});
 if(profile.kind==='pi'){
  await mkdir(options.sessionDirectory,{recursive:true,mode:0o700});
  if(options.resume){const meta=await lstat(join(options.sessionDirectory,options.resume+'.jsonl')).catch(()=>null);if(!meta?.isFile()||meta.isSymbolicLink())throw Error('Pi child session is missing; refusing to create a replacement');}
 }
 dispatched=true;
 const result=await runner(job.file,job.args,{...options,...extra,input:job.input,env:job.env,gracefulInterrupt:profile.kind==='codex'&&options.mode!=='readonly',onLine:line=>{
  let event;try{event=JSON.parse(line);}catch(error){throw withFailure(error,{code:'protocol-invalid',stage:'execution',dispatch:'started'});}
  const id=sessionIdFromEvent(profile.kind,event);
  if(options.resume&&id&&id!==options.resume)throw nativeError('native-session-mismatch',`Native agent resumed a different session (${id}); task stopped`,{stage:'verification',dispatch:'started'});
  options.onLine?.(line);
 }});
 if(result.code!==0)throw nativeError('process-exit',`Agent exit ${result.code??result.signal}; inspect its native session before retrying`,{stage:'execution',dispatch:'started'});
 const parsed=parseEvents(profile.kind,result.stdout);
 if(profile.kind==='codex'&&options.mode!=='readonly'&&!isNativeSessionId(parsed.sessionId))throw nativeError('native-session-missing','Native Codex returned no verified session identity; inspect its results before retrying',{stage:'verification',dispatch:'started'});
 if(options.resume&&parsed.sessionId&&parsed.sessionId!==options.resume)throw nativeError('native-session-mismatch','Native agent resumed a different session',{stage:'verification',dispatch:'started'});
 if(extra.imageSchema)Object.assign(parsed,await verifyImageArtifacts(parsed.finalText,{...options,artifactDirectory,allocatedDirectories}));
 return {...parsed,sessionId:parsed.sessionId??job.sessionId};
 }catch(error){executionError=withFailure(error,failureOf(error,{stage:dispatched?'execution':'preparation',dispatch:dispatched?'unknown':'not-started'}));executionFailed=true;throw executionError;}finally{if(temporary)try{await rm(temporary,{recursive:true,force:true});}catch(cleanupError){if(!executionFailed)throw withFailure(cleanupError,failureOf(cleanupError,{stage:'verification',dispatch:dispatched?'started':'not-started'}));const error=Object.assign(new AggregateError([executionError,cleanupError],String(executionError?.message??executionError)+'; temporary cleanup failed: '+String(cleanupError?.message??cleanupError),{cause:executionError}),{code:executionError?.code??cleanupError?.code,mayBeRunning:Boolean(executionError?.mayBeRunning)});throw withFailure(error,failureOf(error));}}
}

async function imageDirectoryIdentity(path){
 const meta=await lstat(path);if(!meta.isDirectory()||meta.isSymbolicLink())throw Error('Image output directory must stay inside the project without symlink ancestors');
 return {path,dev:meta.dev,ino:meta.ino,birthtime:meta.birthtimeMs};
}
async function verifyImageDirectories(directories){
 for(const expected of directories){const actual=await imageDirectoryIdentity(expected.path);if(actual.dev!==expected.dev||actual.ino!==expected.ino||actual.birthtime!==expected.birthtime)throw Error('Image allocation directory identity changed');}
}
async function verifyImageArtifacts(text,{cwd,artifactDirectory,validateImage,allocatedDirectories}){
 if(!Array.isArray(allocatedDirectories)||!allocatedDirectories.length)throw Error('Missing original image allocation identities');
 let output;try{output=JSON.parse(text);}catch{throw Error('Missing structured image artifact result');}
 if(typeof output.summary!=='string'||!Array.isArray(output.artifacts)||!output.artifacts.length||output.artifacts.length>16)throw Error('Missing image artifacts');
 const directories=[...allocatedDirectories],snapshots=[];await verifyImageDirectories(directories);
 const project=await realpath(cwd),root=resolve(artifactDirectory),location=relative(project,root),artifacts=[],files=[];
 if(!location||location==='..'||location.startsWith('..'+sep)||isAbsolute(location))throw Error('Image allocation directory is outside the project');
 let directory=project;await imageDirectoryIdentity(directory);for(const name of location.split(/[\\/]/)){directory=join(directory,name);await imageDirectoryIdentity(directory);}
 for(const path of output.artifacts){
  if(typeof path!=='string')throw Error('Invalid image artifact path');
  const original=resolve(project,path),full=await realpath(original).catch(()=>null),rel=full&&relative(project,full);
  if(!full||!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('Artifact is missing or outside the project');
  const meta=await lstat(full);if(!meta.isFile()||meta.size>50*1024*1024)throw Error('Invalid image artifact');
  const bytes=await readFile(full),header=bytes.subarray(0,12);
  const valid=header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||header[0]===255&&header[1]===216&&header[2]===255||header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP';
  files.push(full);snapshots.push({original,full,meta,digest:createHash('sha256').update(bytes).digest('hex')});
  // Combined tasks may return article, code and prompt sidecars alongside their images.
  if(!valid){if([path,full].some(p=>/\.(png|jpe?g|webp|gif|svg|bmp|tiff?|avif|heic)$/i.test(p)))throw Error('Image artifact cannot decode as a supported raster image');continue;}
  if(path.split(sep).includes('..'))throw Error('Image artifact paths must not contain parent traversal');
  const imageRel=relative(root,full);
  if(!imageRel||imageRel==='..'||imageRel.startsWith('..'+sep)||isAbsolute(imageRel))throw Error('Image artifact is outside the fresh image directory');
  if((await lstat(original)).isSymbolicLink())throw Error('Image artifact must not be a symlink');
  let parent=dirname(original);for(;;){directories.push(await imageDirectoryIdentity(parent));if(await realpath(parent)===project)break;const next=dirname(parent);if(next===parent)throw Error('Image artifact has no allocated ancestor');parent=next;}
  if(!validateImage||!await validateImage(bytes))throw Error('Image artifact cannot decode as a supported raster image');artifacts.push(full);
 }
 if(!artifacts.length)throw Error('Missing image artifacts');
 for(const {original,full,meta,digest} of snapshots){
  if(await realpath(original)!==full||await realpath(full)!==full)throw Error('Artifact path changed during image validation');
  const current=await lstat(full);
  if(!current.isFile()||['dev','ino','birthtimeMs','mtimeMs','ctimeMs','size'].some(key=>current[key]!==meta[key])||createHash('sha256').update(await readFile(full)).digest('hex')!==digest)throw Error('Artifact changed during image validation');
 }
 await verifyImageDirectories(directories);
 return {text:output.summary+'\n'+files.join('\n'),artifacts};
}
