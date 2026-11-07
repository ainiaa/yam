// Author: Jeff.Liu. Explicit opt-in subscription calibration; never changes routing defaults.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,readdir,lstat,realpath,open,rm} from 'node:fs/promises';
import {createReadStream,renameSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {tmpdir,homedir} from 'node:os';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {discoverAgents,executeAgent,runProcess} from '../apps/desktop/src-tauri/pi/agent-executor.mjs';
import {inspectNativeTrace} from './goal-delivery-acceptance.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifestPath=join(repository,'apps/desktop/tests/fixtures/goal-delivery-calibration.json');
const replayManifestPath=join(repository,'apps/desktop/tests/fixtures/goal-delivery-collaboration-calibration.json');
const replayDirectory=join(repository,'apps/desktop/tests/fixtures/goal-delivery-replay');
const replayModules=['router.mjs','native-codex.mjs','agent-executor.mjs','handoff-context.mjs','control.mjs','policy.mjs','task-rules.mjs'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceFiles=['scripts/goal-delivery-calibration.mjs','apps/desktop/tests/goal-delivery-calibration.test.mjs','apps/desktop/tests/fixtures/goal-delivery-calibration.json','scripts/goal-delivery-acceptance.mjs','apps/desktop/src-tauri/pi/agent-executor.mjs','apps/desktop/src-tauri/pi/native-codex.mjs','apps/desktop/src-tauri/pi/failure.mjs'];
const disabled=['hooks','apps','plugins','remote_plugin','image_generation','memories','goals','skill_mcp_dependency_install','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use'];
const sandboxConfig=['-c','sandbox_mode="workspace-write"','-c','sandbox_workspace_write.exclude_tmpdir_env_var=true','-c','sandbox_workspace_write.exclude_slash_tmp=true','-c','sandbox_workspace_write.network_access=false'];
const rootInstructions='Author: Jeff.Liu. Isolated synthetic calibration. Work only in this directory. Test first. No GUI, browser, server, network requests, image generation, publishing, messaging, dependency installation, paid API or external agent CLI. Do not inspect parent directories, other tasks, home directories, hidden validators or YAM repository. Preserve AGENTS.md. Native helpers, when permitted by the task, must only read this fixture and report; leaves must not delegate.\n';
const singleInstruction='Do not invoke any other agent. Complete and verify this task yourself.';
const collaborationInstruction='Only if useful, you may ask at most ONE native gpt-6-luna helper (fork_turns="none", reasoning_effort="low") for independent READ-ONLY review of this fixture. Give it the fixture path and explicitly forbid all file writes and further delegation. Do not delegate merely to use multiple models. Wait for any helper, integrate confirmed findings and run your tests yourself.';
const requiredCollaborationInstruction='This isolated experiment explicitly REQUIRES exactly ONE native gpt-6-luna helper with fork_turns="none", reasoning_effort="medium", task_name="replay_review". First write focused regression tests and repair the specified bugs, then supply actual relevant FINAL source and test code IN ITS MESSAGE, not only file paths. Forbid ALL tools, filesystem operations and further delegation; it must analyze only the supplied text and return plain JSON {"findings":[{"id":"F1","file":"...","detail":"specific issue and counterexample"}],"reviewedSources":[{"file":"native-codex.mjs","quote":"exact unmodified source excerpt"}]} (findings may be empty). reviewedSources must have exactly one 80–6000-character verbatim code quote for EACH allowed target module and replay.test.mjs, with file basenames only. Quotes must be copied from the supplied code, with no ellipses or escaping beyond ordinary JSON. The host checks these against frozen input or final artifacts because the CLI encrypts dispatch messages at rest. Wait for successful completion, inspect its final findings, integrate confirmed issues, then run your tests. Save review-integration.json as {"task_name":"replay_review","findings":[{"id":"F1","decision":"accepted or rejected","evidence":"specific code/test justification"}],"tests":"actual command and result"}. Do not compute hashes yourself. This experimental requirement does not change production collaboration defaults.';

export function validateReplayManifest(value){
 assert.equal(value?.version,1);assert.equal(value.origin,'repository-defect-reconstructed-replay');assert.deepEqual(Object.keys(value.files).sort(),[...replayModules].sort());assert.deepEqual(value.cases.map(c=>c.id),['R1','R2']);
 for(const [index,item] of value.cases.entries()){
  assert.equal(item.mode,'task');assert.ok(item.source&&item.prompt&&item.prompt.length<20000);assert.deepEqual(item.targets,index===0?['router.mjs','native-codex.mjs']:['native-codex.mjs']);assert.deepEqual(Object.keys(item.files).sort(),[...replayModules].sort());
  let bytes=0;for(const [name,content] of Object.entries(item.files)){assert.equal(typeof content,'string');bytes+=Buffer.byteLength(content);assert.ok(Buffer.byteLength(content)<=128*1024);assert.equal(hash(content),item.brokenHashes[name]);}assert.ok(bytes<=512*1024);
  assert.deepEqual(item.arms.map(a=>a.id),index===0?['sol-single','sol-luna-required']:['sol-luna-required','sol-single']);for(const arm of item.arms){assert.equal(arm.model,'gpt-6.1-sol');assert.equal(arm.effort,'high');assert.equal(arm.collaboration,arm.id==='sol-luna-required');}
 }
 return value;
}
export async function loadReplayManifest(){
 const value=JSON.parse(await readFile(replayManifestPath,'utf8')),fixed={};
 assert.deepEqual(Object.keys(value.files).sort(),[...replayModules].sort());
 for(const name of replayModules){fixed[name]=await readFile(join(replayDirectory,'fixed',name),'utf8');assert.equal(hash(fixed[name]),value.files[name],'Frozen replay source changed');}
 for(const item of value.cases){item.files={...fixed};for(const patch of item.patches){assert.ok(item.targets.includes(patch.file));assert.equal(item.files[patch.file].split(patch.fixed).length,2,'Ambiguous replay inverse patch');item.files[patch.file]=item.files[patch.file].replace(patch.fixed,patch.broken);}assert.equal(hash(await readFile(join(replayDirectory,`oracle-${item.id.toLowerCase()}.mjs`))),item.oracleHash,'Frozen oracle changed');}
 return validateReplayManifest(value);
}

export function validateManifest(value){
 assert.equal(value?.version,1);assert.equal(value.origin,'existing-task-derived-synthetic-variants');assert.equal(value.cases?.length,4);
 const expected=[['luna-single','sol-single'],['sol-single','luna-single'],['sol-single','sol-optional-luna'],['sol-optional-luna','sol-single']];
 for(const [index,item] of value.cases.entries()){
  assert.equal(item.id,`C${index+1}`);assert.equal(item.mode,index<2?'readonly':'task');assert.ok(typeof item.source==='string'&&item.source.length);assert.ok(typeof item.prompt==='string'&&item.prompt.length&&item.prompt.length<20000);
  assert.ok(item.files&&typeof item.files==='object'&&!Array.isArray(item.files));
  for(const [name,content] of Object.entries(item.files)){assert.match(name,/^[a-z][a-z0-9.-]*\.mjs$/);assert.ok(typeof content==='string'&&content.length<20000);}
  assert.deepEqual(item.arms.map(a=>a.id),expected[index]);
  for(const arm of item.arms){assert.equal(arm.model,arm.id.startsWith('luna')?'gpt-6-luna':'gpt-6.1-sol');assert.equal(arm.collaboration,arm.id==='sol-optional-luna');assert.equal(arm.effort,index<2?'medium':'high');}
 }
 return value;
}

const textAnswers={C1:{items:[{id:1,title:'中文 测试'},{id:2,title:'Build carefully'},{id:3,title:'Ship now'}]},C2:{cause:'permission-denied',evidence:['L2','L3'],completed:false,safeNextStep:'inspect-permissions'}};
export function judgeText(id,text){
 try{assert.ok(Object.hasOwn(textAnswers,id));assert.deepEqual(JSON.parse(text),textAnswers[id]);return {passed:true,assertions:1};}
 catch(error){return {passed:false,error:String(error.message)};}
}
async function validatorSource(id,root){
 if(['R1','R2'].includes(id))return (await readFile(join(replayDirectory,`oracle-${id.toLowerCase()}.mjs`),'utf8')).replace('__FIXTURE_URL__',JSON.stringify(pathToFileURL(root+sep).href));
 const file=id==='C3'?'normalize-title.mjs':'parse-limit.mjs';assert.ok(['C3','C4'].includes(id));
 const checks=id==='C3'?`assert.equal(fn('  中文\\t\\n测试  '),'中文 测试');assert.equal(fn('a'.repeat(80)),'a'.repeat(80));assert.equal(fn('😀'.repeat(80)),'😀'.repeat(80));assert.equal(fn(' a\\t b '),'a b');assert.throws(()=>fn('😀'.repeat(81)),RangeError);assert.throws(()=>fn('a'.repeat(81)),RangeError);assert.throws(()=>fn(' \\t\\n '),RangeError);for(const value of [null,undefined,0,{},[]])assert.throws(()=>fn(value),TypeError);`:
 `assert.equal(fn(undefined),20);for(const [input,expected] of [['1',1],['100',100],[' 12 ',12],['001',1]])assert.equal(fn(input),expected);for(const value of ['', ' ', '0', '101', '-1', '+1', '1.5', '1e1', '12x', '1 2', '９', '9'.repeat(400)])assert.throws(()=>fn(value),RangeError);for(const value of [null,12,{},[],true])assert.throws(()=>fn(value),TypeError);`;
 return `// Author: Jeff.Liu. Independent frozen business assertions, not model-written tests.\nimport {test} from 'node:test';import assert from 'node:assert/strict';import {${id==='C3'?'normalizeTitle':'parseLimit'} as fn} from ${JSON.stringify(pathToFileURL(join(root,file)).href)};test(${JSON.stringify(id+' independent business acceptance')},()=>{${checks}});\n`;
}
async function restrictedTests(root,path,{executable,runner=runProcess,signal}={}){
 assert.ok(isAbsolute(executable??''),'Verification requires the discovered native sandbox executable');
 const cwd=await realpath(root),testPath=await realpath(path),env={PATH:process.env.PATH??'/usr/bin:/bin',LANG:process.env.LANG??'en_US.UTF-8',TZ:process.env.TZ??'UTC',TMPDIR:cwd,TMP:cwd,TEMP:cwd};
 // Direct node:test entry avoids --test's ancestor-directory glob reads and subprocess isolation.
 const args=['sandbox',...sandboxConfig,'--',process.execPath,'--permission','--no-addons',`--allow-fs-read=${cwd}`,`--allow-fs-read=${testPath}`,`--allow-fs-write=${cwd}`,'--test-isolation=none',testPath];
 const result=await runner(executable,args,{cwd,signal,env,timeoutMs:15000,maxBytes:128*1024}),count=label=>Number(result.stdout.match(new RegExp(`^(?:#|ℹ)\\s+${label}\\s+(\\d+)\\s*$`,'m'))?.[1]??-1),executed=count('tests');
 return {...result,passed:result.code===0&&executed>0&&count('pass')>0&&count('fail')===0,executed,argv:[executable,...args],environmentKeys:Object.keys(env)};
}
export async function judgeCode(id,root,hiddenDirectory,options={}){
 const source=await validatorSource(id,await realpath(root)),path=join(hiddenDirectory,`${id}.test.mjs`);await writeFile(path,source,{mode:0o600});
 try{const result=await restrictedTests(root,path,options);return {passed:result.passed,exitCode:result.code,executed:result.executed,stdout:result.stdout,stderr:result.stderr,argv:result.argv,environmentKeys:result.environmentKeys,validatorPath:path,validatorHash:hash(source)};}
 catch(error){return {passed:false,error:String(error.message),needsInspection:Boolean(error.mayBeRunning),validatorPath:path,validatorHash:hash(source)};}
}

export async function verifyIsolation(executable,base){
 const result={passed:false,nodeVersion:process.version};
 try{
  const version=await runProcess(executable,['--version'],{timeoutMs:3000,maxBytes:16384});result.cliVersion={exitCode:version.code,stdout:version.stdout,stderr:version.stderr};
  const cwd=join(base,'isolation-work'),hidden=join(base,'isolation-hidden');await mkdir(cwd);await mkdir(hidden);
  const outside=join(base,'native-outside.txt'),nativeProbe=`const fs=require('node:fs'),assert=require('node:assert/strict');fs.writeFileSync('inside.txt','inside');assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'outside'),e=>['EPERM','EACCES'].includes(e.code));assert.equal(fs.existsSync(${JSON.stringify(outside)}),false);const socket=require('node:net').connect({host:'127.0.0.1',port:9});socket.once('error',error=>{assert.ok(['EPERM','EACCES'].includes(error.code),'Network must be denied, not merely refused');console.log('native cwd write passed; outside write and network denied');});socket.once('connect',()=>{socket.destroy();assert.fail('Native sandbox allowed network');});`;
  const args=['sandbox',...sandboxConfig,'--',process.execPath,'-e',nativeProbe];result.native={...await runProcess(executable,args,{cwd,timeoutMs:15000,maxBytes:65536}),argv:[executable,...args]};assert.equal(result.native.code,0,'Native sandbox isolation probe failed');
  const nodeOutside=join(base,'node-outside.txt'),probe=join(hidden,'permissions.test.mjs');
  await writeFile(probe,`import {test} from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,readFileSync} from 'node:fs';import {connect} from 'node:net';import {execFileSync} from 'node:child_process';test('verification permissions',async()=>{writeFileSync('allowed.txt','allowed');assert.equal(readFileSync('allowed.txt','utf8'),'allowed');assert.throws(()=>writeFileSync(${JSON.stringify(nodeOutside)},'outside'),{code:'ERR_ACCESS_DENIED'});await assert.rejects(new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:9});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve();});}),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>execFileSync('/bin/true'),{code:'ERR_ACCESS_DENIED'});assert.equal(process.env.NODE_OPTIONS,undefined);});`);
  result.node=await restrictedTests(cwd,probe,{executable});assert.equal(result.node.passed,true,'Node permission isolation probe failed');result.verified={native:['cwd-write','outside-write-denied','network-denied'],node:['cwd-read-write','outside-write-denied','network-denied','child-execution-denied','environment-filtered']};result.passed=true;
 }catch(error){result.error=String(error.message);result.needsInspection=Boolean(error.mayBeRunning);}
 return result;
}

export function verifyCalibrationTrace(family,arm){
 const {main,children}=family;assert.equal(main.provider,'openai');assert.deepEqual(main.models,[arm.model]);
 assert.ok(main.spawnCalls.length<=(arm.collaboration?1:0),'Unexpected spawn in calibration arm');
 assert.equal(children.length,main.spawnCalls.length,'Missing or unexpected helper trace');
 for(const call of main.spawnCalls){assert.equal(call.model,'gpt-6-luna','Unexpected helper model');assert.equal(call.fork_turns,'none');}
 assert.equal(main.imageCalls?.length??0,0,'Unexpected image generation');
 for(const child of children){assert.equal(child.provider,'openai');assert.equal(child.parent,main.id);assert.equal(child.depth,1);assert.deepEqual(child.models,['gpt-6-luna'],'Unexpected helper model');assert.equal(child.spawnCalls.length,0,'Helper delegated again');assert.equal(child.imageCalls?.length??0,0,'Helper generated an image');assert.ok(!(child.toolActivity??[]).some(call=>/(?:^|[._])(?:apply_patch|write_file|edit_file)$/.test(call.name??'')),'Helper used a known mutation tool');}
 return {children:children.length,requestedReadOnly:arm.collaboration,readOnlyEnforcement:arm.collaboration?'not-verified':'not-applicable',toolEvidence:arm.collaboration?'partial':'not-applicable'};
}
export function verifyReplayTrace(family,arm,integration,materialSources){
 verifyCalibrationTrace(family,arm);const {main,children}=family;
 assert.equal(main.parent,null);assert.equal(main.depth,0);assert.deepEqual(main.efforts,['high']);assert.ok(main.finalText?.trim()&&main.completedAt&&!main.failed,'Main success terminal evidence missing');
 if(!arm.collaboration){assert.equal(children.length,0);return {children:0,readOnlyEnforcement:'not-applicable',toolEvidence:'complete-native-trace'};}
 assert.equal(children.length,1,'Explicit collaboration requires exactly one successful helper');const child=children[0],spawn=main.spawnCalls[0];
 assert.equal(spawn.reasoning_effort,'medium');assert.deepEqual(child.efforts,['medium']);assert.equal(child.toolActivity.length,0,'Helper used tools');assert.ok(child.finalText?.trim()&&child.completedAt&&!child.failed,'Helper success terminal evidence missing');assert.equal(child.taskName?.split('/').at(-1),spawn.task_name);
 assert.ok(typeof spawn.message==='string'&&spawn.message.length>=40,'Missing supplied helper materials');const encrypted=/^gAAAA/.test(spawn.message);
 if(!encrypted){assert.match(spawn.message,/\.mjs/);assert.match(spawn.message,/(?:function |=>|export )/,'Supply actual code in helper message');}
 const time=value=>{const n=Date.parse(value);assert.ok(Number.isFinite(n),'Missing native event timestamp');return n;};
 assert.ok(time(child.finalAt)<=time(child.completedAt));assert.ok(time(main.finalAt)<=time(main.completedAt));assert.ok(main.toolActivity.some(call=>/(?:^|\.)wait_agent$/.test(call.name??'')&&call.output?.timed_out===false&&time(call.at)>=time(child.completedAt)&&time(call.at)<time(main.finalAt)),'Main did not wait for helper completion before final delivery');
 const review=JSON.parse(child.finalText);assert.ok(Array.isArray(review.findings));let materialHash=hash(spawn.message);
 if(encrypted){
  assert.ok(materialSources&&Object.keys(materialSources).length>=2,'Encrypted helper material requires actual source witnesses');assert.ok(Array.isArray(review.reviewedSources),'Encrypted helper material requires child-final quotes');
  assert.deepEqual(review.reviewedSources.map(value=>value.file).sort(),Object.keys(materialSources).sort(),'Missing or duplicate child source witnesses');
  for(const value of review.reviewedSources){assert.ok(typeof value.quote==='string'&&value.quote.length>=80&&value.quote.length<=6000&&/(?:function |=>|export |test\()/.test(value.quote),'Invalid child source witness');assert.ok((Array.isArray(materialSources[value.file])?materialSources[value.file]:[materialSources[value.file]]).some(source=>source.includes(value.quote)),'Child source witness does not match actual artifact');}
  materialHash=hash(JSON.stringify(review.reviewedSources));
 }
 assert.equal(integration?.task_name,spawn.task_name);assert.ok(typeof integration.tests==='string'&&integration.tests.includes('replay.test.mjs'));assert.ok(Array.isArray(integration.findings));
 assert.deepEqual(integration.findings.map(f=>f.id).sort(),review.findings.map(f=>f.id).sort(),'Unintegrated helper findings');assert.equal(new Set(review.findings.map(f=>f.id)).size,review.findings.length);
 for(const finding of integration.findings)assert.ok(['accepted','rejected'].includes(finding.decision)&&typeof finding.evidence==='string'&&finding.evidence.trim().length>10,'Missing integration justification');
 return {children:1,requestedReadOnly:true,readOnlyEnforcement:'observed-zero-tools-not-platform-enforced',toolEvidence:'complete-native-trace',materialHash,materialEncoding:encrypted?'child-final-source-quotes':'plaintext',helperTask:spawn.task_name};
}
function nativeOutput(value){
 try{
  value=typeof value==='string'?JSON.parse(value):value;
  if(!Array.isArray(value))return value&&typeof value==='object'?value:null;
  const results=value.filter(part=>['input_text','text'].includes(part?.type)).flatMap(part=>{try{const parsed=JSON.parse(part.text);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?[parsed]:[];}catch{return [];}});
  return results.length===1?results[0]:null;
 }catch{return null;}
}
export function inspectCalibrationEvents(events){
 const trace=inspectNativeTrace(events),outputs=new Map(events.filter(e=>e.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(e.payload?.type)).map(e=>[e.payload.call_id,e]));
 const toolActivity=events.filter(e=>e.type==='response_item'&&['function_call','custom_tool_call'].includes(e.payload?.type)).map(e=>{const output=outputs.get(e.payload.call_id);return {name:e.payload.name,callId:e.payload.call_id,inputHash:hash(e.payload.arguments??e.payload.input??''),at:output?.timestamp??e.timestamp,output:nativeOutput(output?.payload.output)};});
 const spawnEvents=events.filter(e=>e.type==='response_item'&&e.payload?.type==='function_call'&&/(?:^|\.)spawn_agent$/.test(e.payload.name??''));
 const final=events.findLast(e=>e.type==='response_item'&&e.payload?.type==='message'&&e.payload.role==='assistant'&&e.payload.phase==='final_answer'),completed=events.findLast(e=>e.type==='event_msg'&&e.payload?.type==='task_complete');
 return {...trace,toolActivity,spawnCalls:spawnEvents.map(e=>{const call=JSON.parse(e.payload.arguments);return {...call,at:e.timestamp,materialHash:hash(call.message??''),materialEncoding:/^gAAAA/.test(call.message??'')?'opaque-encrypted':'plaintext'};}),efforts:[...new Set(events.filter(e=>e.type==='turn_context').map(e=>e.payload.effort))],taskName:events.find(e=>e.type==='session_meta')?.payload?.source?.subagent?.thread_spawn?.agent_path??null,finalAt:final?.timestamp??null,completedAt:completed?.timestamp??null,failed:events.some(e=>e.type==='event_msg'&&['task_failed','turn_aborted','error'].includes(e.payload?.type))};
}
async function readTrace(path,{signal}={}){
 const bytes=await readFile(path,{signal}),events=bytes.toString().split('\n').filter(Boolean).map(JSON.parse),trace=inspectCalibrationEvents(events);
 const tokenEvents=events.filter(e=>e.type==='event_msg'&&e.payload?.type==='token_count'&&e.payload.info);
 return {...trace,path,sha256:hash(bytes),reportedCumulativeUsage:tokenEvents.at(-1)?.payload.info.total_token_usage??null};
}
async function nativeFamily(id,{signal}={}){
 assert.match(id,/^[a-f0-9-]{36}$/i);const sessions=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions');
 const files=(await readdir(sessions,{recursive:true})).filter(p=>p.endsWith('.jsonl'));let main;const children=[];
 for(const name of files.filter(p=>p.includes(id))){signal?.throwIfAborted();const candidate=await readTrace(join(sessions,name),{signal});if(candidate.id===id){main=candidate;break;}}
 assert.ok(main,'Native parent trace missing');
 for(const name of files){
  signal?.throwIfAborted();
  const path=join(sessions,name),stream=createReadStream(path),lines=createInterface({input:stream,crlfDelay:Infinity});let header;
  try{for await(const line of lines){header=JSON.parse(line);break;}}finally{lines.close();stream.destroy();}
  if(header?.payload?.parent_thread_id===id||header?.payload?.source?.subagent?.thread_spawn?.parent_thread_id===id)children.push(await readTrace(path,{signal}));
 }
 return {main,children};
}
async function snapshotSource({signal,suite}={}){
 const head=await runProcess('git',['rev-parse','HEAD'],{cwd:repository,signal}),diff=await runProcess('git',['diff','--binary'],{cwd:repository,signal,maxBytes:16*1024*1024});assert.equal(head.code,0);assert.equal(diff.code,0);
 const names=[...sourceFiles,...suite==='repository-replay'?['apps/desktop/tests/fixtures/goal-delivery-collaboration-calibration.json',...replayModules.map(n=>'apps/desktop/tests/fixtures/goal-delivery-replay/fixed/'+n),...['r1','r2'].map(n=>`apps/desktop/tests/fixtures/goal-delivery-replay/oracle-${n}.mjs`)]:[]];
 const files=Object.fromEntries(await Promise.all(names.map(async name=>[name,hash(await readFile(join(repository,name),{signal}))])));
 const source={commit:head.stdout.trim(),diffHash:hash(diff.stdout),files};return {...source,fingerprint:hash(JSON.stringify(source))};
}
async function snapshotArtifacts(root,allowed){
 const entries=await readdir(root,{withFileTypes:true}),result={};
 for(const entry of entries){assert.ok(entry.isFile()&&allowed.includes(entry.name),`Unexpected fixture artifact: ${entry.name}`);const path=join(root,entry.name),stat=await lstat(path);assert.ok(stat.size<=1024*1024,'Oversized fixture artifact');result[entry.name]=hash(await readFile(path));}
 return result;
}
function isolatedArgs(args,profile,mode,collaboration,replay){
 const result=[];for(let i=0;i<args.length;i++){if(args[i]==='-c'&&args[i+1]?.startsWith('agents.max_concurrent_threads_per_session=')){i++;continue;}result.push(args[i]);}if(!result.includes('--ignore-user-config'))result.splice(1,0,'--ignore-user-config');
 const additions=['-c','web_search="disabled"'];
 if(mode==='task')additions.push(...sandboxConfig.slice(2));
 if(typeof profile.runtimeFeatures?.respect_system_proxy==='boolean')additions.push('-c',`features.respect_system_proxy=${profile.runtimeFeatures.respect_system_proxy}`);
 if(mode==='task'&&collaboration)additions.push('-c','agents.max_depth=1','-c','agents.max_concurrent_threads_per_session=1');
 if(replay)additions.push('-c','project_doc_max_bytes=0','-c','skills.max_context_tokens=1');
 for(const feature of disabled)additions.push('--disable',feature);result.splice(1,0,...additions);return result;
}
async function withinSignal(action,signal){
 if(!signal)return action();signal.throwIfAborted();let abort;
 try{return await Promise.race([action(),new Promise((_,reject)=>{abort=()=>reject(Error('Calibration arm deadline exceeded'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
}

export async function runCalibration({runNative=false,receiptPath,suite='baseline',executable=process.env.YAM_CODEX_EXECUTABLE??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',discover=discoverAgents,runner=runProcess,traceReader=nativeFamily,sourceSnapshot=snapshotSource,isolationProbe=verifyIsolation,evidenceWriter=writeFile,onPair=()=>{}}={}){
 assert.equal(runNative,true,'Real subscription calibration requires explicit opt-in --run-native');assert.ok(isAbsolute(receiptPath??''),'Receipt path must be absolute');
 assert.ok(['baseline','repository-replay'].includes(suite),'Unknown calibration suite');const replay=suite==='repository-replay',timeoutMs=replay?600000:180000;
 const requestedRelative=relative(repository,resolve(receiptPath));assert.ok(requestedRelative==='..'||requestedRelative.startsWith('..'+sep),'Run evidence must be outside the repository');
 await mkdir(dirname(receiptPath),{recursive:true});const destination=await realpath(dirname(receiptPath)),repo=await realpath(repository),rel=relative(repo,destination);assert.ok(rel==='..'||rel.startsWith('..'+sep),'Run evidence must be outside the repository');
 const receiptFile=await open(receiptPath,'wx',0o600);await receiptFile.close();
 const manifest=replay?await loadReplayManifest():validateManifest(JSON.parse(await readFile(manifestPath))),manifestBytes=replay?Buffer.from(JSON.stringify(manifest)):await readFile(manifestPath);
 const evidenceRoot=await mkdtemp(join(destination,'calibration-')),workRoot=await mkdtemp(join(tmpdir(),'yam-calibration-work-')),hiddenRoot=await mkdtemp(join(tmpdir(),'yam-calibration-hidden-'));
 const source=await sourceSnapshot({suite}),report={version:1,suite,origin:manifest.origin,billing:'subscription',defaultsChanged:false,source,corpusHash:hash(manifestBytes),evidenceRoot,workRoot,hiddenRoot,startedAt:new Date().toISOString(),limits:{arms:replay?4:8,concurrency:1,timeoutMs,modelTimeoutMs:replay?540000:180000,retries:0},isolation:'Explicit calibration isolation, not a claim about production default tools or permissions',runs:manifest.cases.flatMap(item=>item.arms.map(arm=>({caseId:item.id,arm:arm.id,plannedModel:arm.model,effort:arm.effort,status:'not-run',taskPassed:null,totalCost:null,humanInterventions:[],usage:{total:null,scope:'unknown'}})))};
 await writeFile(join(evidenceRoot,'corpus.json'),manifestBytes,{mode:0o600});
 let receiptRevision=0;
 const persistEvidence=(path,data,signal)=>replay?withinSignal(()=>evidenceWriter(path,data,{mode:0o600,signal}),signal):writeFile(path,data,{mode:0o600});
 const save=async(signal=replay?AbortSignal.timeout(1000):undefined)=>{
  report.summary={planned:report.runs.length,attempted:report.runs.filter(r=>r.status!=='not-run').length,passed:report.runs.filter(r=>r.taskPassed===true).length,failed:report.runs.filter(r=>r.taskPassed===false).length,notRun:report.runs.filter(r=>r.status==='not-run').length};const data=JSON.stringify(report,null,2)+'\n';
  if(!replay)return writeFile(receiptPath,data,{mode:0o600});const revision=++receiptRevision,temporary=receiptPath+`.${revision}.tmp`;
  return withinSignal(async()=>{try{await evidenceWriter(temporary,data,{mode:0o600,signal});signal.throwIfAborted();assert.equal(revision,receiptRevision,'Receipt write superseded');renameSync(temporary,receiptPath);}finally{void rm(temporary,{force:true}).catch(()=>{});}},signal);
 };
 await save();let stopped=false,profile;
 try{
  const profiles=await discover({codex:executable});profile=profiles.find(p=>p.kind==='codex'&&p.auth==='subscription');assert.ok(profile,'Verified ChatGPT subscription login unavailable; no fallback');
  report.preflight={passed:true,executable:profile.executable,auth:profile.auth,features:profile.runtimeFeatures??null,modelAvailability:'Not inferred from authentication; each actual arm may fail without fallback'};
  report.preflight.isolation=await isolationProbe(profile.executable,evidenceRoot);assert.equal(report.preflight.isolation.passed,true,'Calibration isolation preflight failed');
 }catch(error){report.preflight={...report.preflight,passed:false,error:String(error.message)};report.finishedAt=new Date().toISOString();await save();return report;}
 let index=0;
 for(const item of manifest.cases){
  for(const arm of item.arms){
   const row=report.runs[index++];if(stopped)continue;const started=performance.now();
   const armDirectory=join(evidenceRoot,`${item.id}-${arm.id}`),cwd=join(workRoot,`${item.id}-${arm.id}`),hidden=join(hiddenRoot,`${item.id}-${arm.id}`);await mkdir(armDirectory);await mkdir(cwd);await mkdir(hidden);
   const prompt=[...replay?[rootInstructions,'Keep tests focused on the specified regressions and their existing interfaces. Preserve the v1 state schema; the fresh first-write tool stage is a v2 policy. Do not build a new framework or inspect unrelated behaviors. Do not compute hashes; the host already freezes and verifies them.']:[],item.prompt,arm.collaboration?(replay?requiredCollaborationInstruction:collaborationInstruction):singleInstruction].join('\n\n');await writeFile(join(armDirectory,'prompt.txt'),prompt,{mode:0o600});await writeFile(join(cwd,'AGENTS.md'),rootInstructions+(replay?'Confirmed repository-defect RECONSTRUCTED REPLAY, not an unprocessed online business task. Preserve all supplied dependency modules; only the explicitly named targets, replay.test.mjs and review-integration.json may change. Helpers must analyze only supplied message text, with NO tools whatsoever.\n':''),{mode:0o600});
   for(const [file,content] of Object.entries(item.files))await writeFile(join(cwd,file),content,{mode:0o600});
   const initial=await snapshotArtifacts(cwd,['AGENTS.md',...Object.keys(item.files)]),validator=item.mode==='readonly'?JSON.stringify(textAnswers[item.id]):await validatorSource(item.id,'/fixture');
   Object.assign(row,{status:'running',startedAt:new Date().toISOString(),cwd,promptHash:hash(prompt),inputHash:hash(JSON.stringify(item.files)),initialArtifacts:initial,validatorHash:hash(validator),mode:item.mode,modelEvidence:'argv-only',actualModel:null,sessionId:null,children:null,nativeEvidenceStatus:'partial',classificationMs:0,classification:'not-performed-fixed-arm',usage:{reported:null,total:null,scope:'unknown'}});await save();
   const lines=[],abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.max(0,timeoutMs-(performance.now()-started)));let result;
   try{
    assert.equal((await sourceSnapshot({suite,signal:abort.signal})).fingerprint,source.fingerprint,'Calibration source changed');
    result=await executeAgent({...profile,model:arm.model,thinking:arm.effort},{cwd,mode:item.mode,prompt,signal:abort.signal,allowCollaboration:arm.collaboration,timeoutMs:report.limits.modelTimeoutMs,maxBytes:2*1024*1024,onSpawn:process=>{row.process={...process,startedAt:new Date().toISOString()};},onLine:line=>{lines.push(line);const event=JSON.parse(line);if(event.type==='thread.started')row.sessionId=event.thread_id;}},async(file,args,options)=>{
     const actualArgs=isolatedArgs(args,profile,item.mode,arm.collaboration,replay);row.argv=[file,...actualArgs];row.processStartedAt=new Date().toISOString();
     try{const output=await runner(file,actualArgs,options);row.exitCode=output.code;await persistEvidence(join(armDirectory,'stderr.txt'),output.stderr??'',replay?abort.signal:undefined);return output;}catch(error){row.exitCode=null;throw error;}
    });
    row.executionMs=Math.round(performance.now()-started);row.sessionId=result.sessionId;row.usage={reported:result.usage,total:null,scope:'partial-parent-reported-semantics-unverified'};row.finalText=result.finalText;
    const outputFile=join(armDirectory,'final.txt');await persistEvidence(outputFile,result.finalText,replay?abort.signal:undefined);row.finalHash=hash(result.finalText);
    if(item.mode==='readonly'){row.acceptance=judgeText(item.id,result.finalText);row.children=[];row.collaboration={children:0,requestedReadOnly:false,readOnlyEnforcement:'not-applicable',toolEvidence:'ephemeral-tools-disabled-by-argv'};}
    else{
     const testFile=replay?'replay.test.mjs':item.id==='C3'?'normalize-title.test.mjs':'parse-limit.test.mjs',allowed=replay?['AGENTS.md',...replayModules,testFile,'review-integration.json']:['AGENTS.md',item.id==='C3'?'normalize-title.mjs':'parse-limit.mjs',testFile];
     row.artifacts=await snapshotArtifacts(cwd,allowed);assert.equal(row.artifacts['AGENTS.md'],initial['AGENTS.md'],'Fixture instructions changed');
     if(replay)for(const name of replayModules.filter(n=>!item.targets.includes(n)))assert.equal(row.artifacts[name],initial[name],`Frozen dependency changed: ${name}`);
     row.acceptance=await judgeCode(item.id,cwd,hidden,{signal:abort.signal,executable:profile.executable,runner});if(row.acceptance.needsInspection)throw Object.assign(Error('Independent verification cleanup unconfirmed'),{mayBeRunning:true});
     assert.deepEqual(await snapshotArtifacts(cwd,allowed),row.artifacts,'Fixture artifacts changed during independent verification');
     const ownTests=await restrictedTests(cwd,join(cwd,testFile),{signal:abort.signal,executable:profile.executable,runner});row.modelTests={exitCode:ownTests.code,passed:ownTests.passed,executed:ownTests.executed,stdout:ownTests.stdout,stderr:ownTests.stderr,argv:ownTests.argv,environmentKeys:ownTests.environmentKeys};
     assert.deepEqual(await snapshotArtifacts(cwd,allowed),row.artifacts,'Fixture artifacts changed during model tests');
    }
    assert.ok(!abort.signal.aborted,'Calibration arm deadline exceeded');row.taskPassed=row.acceptance.passed&&(!row.modelTests||row.modelTests.passed);row.status=row.taskPassed?'passed':'failed';
   }catch(error){row.status='failed';row.taskPassed=false;row.error=String(error.message);row.needsInspection||=Boolean(error.mayBeRunning);}
   finally{
    try{
    if(!replay)clearTimeout(timer);row.elapsedMs=Math.round(performance.now()-started);row.finishedAt=new Date().toISOString();row.eventsPath=join(armDirectory,'events.jsonl');const raw=lines.join('\n')+'\n';
    try{await persistEvidence(row.eventsPath,raw,replay?abort.signal:undefined);row.eventsHash=hash(raw);}catch(error){if(!replay)throw error;row.evidencePersistenceError=String(error.message);row.error=[row.error,row.evidencePersistenceError].filter(Boolean).join('; ');row.status='failed';row.taskPassed=false;stopped=true;report.stopReason='Calibration evidence persistence failed';}
    if(item.mode==='task'){
     try{assert.match(row.sessionId??'',/^[a-f0-9-]{36}$/i,'Missing native session identity');const family=await withinSignal(()=>traceReader(row.sessionId,{signal:replay?abort.signal:undefined}),replay?abort.signal:undefined);row.nativeEvidence=family;row.children=family.children.map(c=>({id:c.id,parent:c.parent,models:c.models,reportedCumulativeUsage:c.reportedCumulativeUsage??null}));row.nativeEvidenceStatus='complete';const integration=replay&&arm.collaboration?JSON.parse(await readFile(join(cwd,'review-integration.json'),'utf8')):null,materialSources=replay&&arm.collaboration?Object.fromEntries(await Promise.all([...item.targets,'replay.test.mjs'].map(async name=>[name,[...(item.files[name]?[item.files[name]]:[]),await readFile(join(cwd,name),{encoding:'utf8',signal:abort.signal})]]))):undefined;row.collaboration=replay?verifyReplayTrace(family,arm,integration,materialSources):verifyCalibrationTrace(family,arm);row.actualModel=family.main.models[0];row.modelEvidence='native-turn-context';}
     catch(error){row.nativeEvidenceStatus='partial';row.nativeEvidenceError=String(error.message);row.error=[row.error,row.nativeEvidenceError].filter(Boolean).join('; ');row.status='failed';row.taskPassed=false;}
    }
    if(replay){const family=row.nativeEvidence,main=family?.main,children=family?.children;const confirmed=main?.completedAt&&Array.isArray(main.spawnCalls)&&Array.isArray(children)&&main.spawnCalls.length===children.length&&children.every(child=>child.parent===main.id&&child.depth===1&&child.completedAt&&Array.isArray(child.spawnCalls)&&child.spawnCalls.length===0);if(!confirmed){row.needsInspection=true;if(!main?.completedAt)row.children=null;}}
    if(row.needsInspection){stopped=true;report.stopReason='Native process cleanup unconfirmed; inspect before any further task';}
    try{if((await withinSignal(()=>sourceSnapshot({suite,signal:replay?abort.signal:undefined}),replay?abort.signal:undefined)).fingerprint!==source.fingerprint){stopped=true;report.stopReason='Calibration source changed';row.sourceChanged=true;row.taskPassed=false;row.status='failed';}}
    catch(error){stopped=true;report.stopReason??='Calibration source snapshot failed; inspect before any further task';row.sourceEvidenceError=String(error.message);row.error=[row.error,row.sourceEvidenceError].filter(Boolean).join('; ');row.taskPassed=false;row.status='failed';}
    if(replay&&abort.signal.aborted){stopped=true;report.stopReason??='Calibration arm deadline exceeded';row.error=[row.error,'Calibration arm deadline exceeded'].filter(Boolean).join('; ');row.taskPassed=false;row.status='failed';}row.elapsedMs=Math.round(performance.now()-started);row.finishedAt=new Date().toISOString();
    try{if(replay&&(stopped||index===report.runs.length))report.finishedAt=new Date().toISOString();await save(replay?abort.signal:undefined);row.elapsedMs=Math.round(performance.now()-started);if(replay){abort.signal.throwIfAborted();assert.ok(row.elapsedMs<timeoutMs,'Calibration arm deadline exceeded');}}
    catch(error){if(!replay)throw error;stopped=true;report.stopReason??='Calibration receipt persistence failed or deadline exceeded';row.error=[row.error,String(error.message)].filter(Boolean).join('; ');row.status='failed';row.taskPassed=false;row.elapsedMs=Math.round(performance.now()-started);row.finishedAt=report.finishedAt=new Date().toISOString();try{await save(AbortSignal.timeout(1000));}catch(flushError){report.failureFlushError=String(flushError.message);}}
    }finally{clearTimeout(timer);}
   }
  }
  await onPair(item.id,report.runs.filter(row=>row.caseId===item.id));
 }
 if(!replay){report.finishedAt=new Date().toISOString();await save();}return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!['--run-native','--run-native-replay'].includes(process.argv[2])||process.argv.length!==4){console.error('Usage: node scripts/goal-delivery-calibration.mjs --run-native|--run-native-replay /absolute/outside-repository/receipt.json');process.exitCode=1;}
 else try{const report=await runCalibration({runNative:true,suite:process.argv[2]==='--run-native-replay'?'repository-replay':'baseline',receiptPath:process.argv[3],onPair:(caseId,rows)=>console.log(JSON.stringify({caseId,runs:rows.map(r=>({arm:r.arm,status:r.status,elapsedMs:r.elapsedMs,children:r.children?.length,error:r.error}))}))});console.log(JSON.stringify({receipt:process.argv[3],summary:report.summary,stopReason:report.stopReason??null}));if(report.summary.passed!==report.summary.planned)process.exitCode=1;}
 catch(error){console.error(error.stack);process.exitCode=1;}
}
