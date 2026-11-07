// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {runProcess} from '../src-tauri/pi/agent-executor.mjs';
const api=await import('../../../scripts/goal-delivery-calibration.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('/scripts/goal-delivery-calibration.mjs'))return {};throw error;});
const manifest=JSON.parse(await readFile(new URL('./fixtures/goal-delivery-calibration.json',import.meta.url),'utf8'));
const normalize="export function normalizeTitle(value){if(typeof value!=='string')throw new TypeError();const result=value.trim().replace(/\\s+/g,' ');if(!result||[...result].length>80)throw new RangeError();return result;}\n";
const parse="export function parseLimit(value){if(value===undefined)return 20;if(typeof value!=='string')throw new TypeError();const s=value.trim(),n=Number(s);if(!/^\\d+$/.test(s)||!Number.isInteger(n)||n<1||n>100)throw new RangeError();return n;}\n";
const titleAnswer=JSON.stringify({items:[{id:1,title:'中文 测试'},{id:2,title:'Build carefully'},{id:3,title:'Ship now'}]});
const logAnswer=JSON.stringify({cause:'permission-denied',evidence:['L2','L3'],completed:false,safeNextStep:'inspect-permissions'});
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'yam-calibration-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function present(name){assert.equal(typeof api[name],'function',`${name} behavior must exist`);}
const verificationOptions={executable:'/fixture/codex',runner:async(_file,args,options)=>{assert.equal(args[0],'sandbox');const command=args.slice(args.indexOf('--')+1);return runProcess(command[0],command.slice(1),options);}};

test('calibration is an explicit opt-in runner with a frozen four-pair synthetic corpus',()=>{
 present('runCalibration');present('validateManifest');
 assert.equal(api.validateManifest(manifest),manifest);
 assert.equal(manifest.cases.length,4);assert.equal(manifest.cases.flatMap(c=>c.arms).length,8);
 for(const change of [m=>m.cases.pop(),m=>m.cases[1].id='C1',m=>m.cases[0].arms[0].model='paid/model',m=>m.cases[0].files['../escape']='x',m=>m.cases[0].mode='task']){const copy=structuredClone(manifest);change(copy);assert.throws(()=>api.validateManifest(copy));}
});
test('text judges require exact independent business answers and reject fabricated success',()=>{
 present('judgeText');assert.equal(api.judgeText('C1',titleAnswer).passed,true);assert.equal(api.judgeText('C2',logAnswer).passed,true);
 for(const [id,text] of [['C1','{}'],['C1',titleAnswer.replace('中文 测试','中文测试')],['C2',logAnswer.replace('false','true')],['C2',logAnswer.replace('L2','L1')],['C2','```json\n'+logAnswer+'\n```']])assert.equal(api.judgeText(id,text).passed,false);
});
test('hidden code acceptance accepts correct behavior and rejects Unicode length and parseInt baseline bugs',async t=>{
 present('judgeCode');const base=await temporary(t),root=join(base,'work'),hidden=join(base,'hidden');await mkdir(root);await mkdir(hidden);
 for(const [id,file,good,bad] of [['C3','normalize-title.mjs',normalize,normalize.replace('[...result].length','result.length')],['C4','parse-limit.mjs',parse,manifest.cases[3].files['parse-limit.mjs']]]){
  await writeFile(join(root,file),good);assert.equal((await api.judgeCode(id,root,hidden,verificationOptions)).passed,true);
  await writeFile(join(root,file),bad);assert.equal((await api.judgeCode(id,root,hidden,verificationOptions)).passed,false);
 }
});
test('runCalibration refuses missing opt-in and writes a subscription preflight failure without executing',async t=>{
 present('runCalibration');const base=await temporary(t);let calls=0;
 await assert.rejects(api.runCalibration({receiptPath:join(base,'no.json'),discover:async()=>{calls++;return [];}}),/opt-in/);assert.equal(calls,0);
 const report=await api.runCalibration({runNative:true,receiptPath:join(base,'failed.json'),discover:async()=>[],sourceSnapshot:async()=>({fingerprint:'frozen'})});
 assert.equal(report.runs.length,8);assert.ok(report.runs.every(r=>r.status==='not-run'));assert.match(report.preflight.error,/subscription/);assert.equal(report.defaultsChanged,false);
});

async function mockRun(t,{failAt=-1,uncertain=false,invalidChild=false,missingTrace=false,unsafeOwnTest=false,missingSession=false,artifactMutation,sourceCleanupFailure=false}={}){
 const base=await temporary(t),calls=[],traces=new Map();let active=0,maxActive=0,sourceSnapshots=0;
 const runner=async(file,args,options)=>{
  if(args[0]==='sandbox')return verificationOptions.runner(file,args,options);
  const index=calls.length;calls.push({file,args:[...args],cwd:options.cwd,input:options.input});active++;maxActive=Math.max(maxActive,active);
  try{
   const id=randomUUID(),caseId=index<2?'C1':index<4?'C2':index<6?'C3':'C4',isCollab=args.includes('multi_agent')&&args[args.indexOf('multi_agent')-1]==='--enable';
   const hasSession=!(missingSession&&index>=4);if(hasSession)options.onLine?.(JSON.stringify({type:'thread.started',thread_id:id}));
   const model=args[args.indexOf('--model')+1],childId=randomUUID(),main={id,provider:'openai',models:[model],parent:null,depth:0,spawnCalls:isCollab?[{model:'gpt-6-luna',fork_turns:'none',reasoning_effort:'low'}]:[],toolActivity:[]};
   traces.set(id,{main,children:isCollab?[{id:childId,provider:'openai',models:[invalidChild?'gpt-6-astra':'gpt-6-luna'],parent:id,depth:1,spawnCalls:[],toolActivity:[]}]:[]});
   if(index===failAt)throw Object.assign(Error(uncertain?'cleanup unconfirmed':'Timed out'),{mayBeRunning:uncertain});
   if(caseId==='C3'){await writeFile(join(options.cwd,'normalize-title.mjs'),normalize);await writeFile(join(options.cwd,'normalize-title.test.mjs'),unsafeOwnTest?`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(base,'outside.txt'))},'outside');import {test} from 'node:test';import assert from 'node:assert/strict';test('assertion',()=>assert.equal(1,1));`:"import {test} from 'node:test';import assert from 'node:assert/strict';test('assertion',()=>assert.equal(1,1));");}
   if(caseId==='C3'&&artifactMutation==='independent')await writeFile(join(options.cwd,'normalize-title.mjs'),normalize+`import {writeFileSync} from 'node:fs';process.on('exit',()=>writeFileSync(new URL('./normalize-title.mjs',import.meta.url),'export function normalizeTitle(){return "wrong";}'));`);
   if(caseId==='C3'&&artifactMutation==='model')await writeFile(join(options.cwd,'normalize-title.test.mjs'),`import {writeFileSync} from 'node:fs';import {test} from 'node:test';import assert from 'node:assert/strict';writeFileSync(new URL('./normalize-title.mjs',import.meta.url),'export function normalizeTitle(){return "wrong";}');test('assertion',()=>assert.equal(1,1));`);
   if(caseId==='C4'){await writeFile(join(options.cwd,'parse-limit.mjs'),parse);await writeFile(join(options.cwd,'parse-limit.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';test('assertion',()=>assert.equal(1,1));");}
   const answer=caseId==='C1'?titleAnswer:caseId==='C2'?logAnswer:'Implemented and tests passed.';
   const terminal=[{type:'item.completed',item:{type:'agent_message',text:answer}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:3}}],events=[...(hasSession?[{type:'thread.started',thread_id:id}]:[]),...terminal];
   for(const e of terminal)options.onLine?.(JSON.stringify(e));
   return {code:0,stdout:events.map(e=>JSON.stringify(e)).join('\n'),stderr:''};
  }finally{active--;}
 };
 const report=await api.runCalibration({runNative:true,receiptPath:join(base,'receipt.json'),discover:async()=>[{kind:'codex',auth:'subscription',executable:'/fixture/codex',runtimeFeatures:{respect_system_proxy:true}}],isolationProbe:async()=>({passed:true}),runner,traceReader:async id=>{if(missingTrace)throw Error('Trace unavailable');return traces.get(id);},sourceSnapshot:async()=>{if(sourceCleanupFailure&&++sourceSnapshots===3)throw Error('Source snapshot ENOENT');return {fingerprint:'frozen'};}});
 return {report,calls,maxActive,base};
}
test('eight arms execute sequentially with matched isolation and independently verified results',async t=>{
 present('runCalibration');const {report,calls,maxActive}=await mockRun(t);assert.equal(calls.length,8);assert.equal(maxActive,1);assert.ok(report.runs.every(r=>r.taskPassed===true));
 for(const call of calls){assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('web_search="disabled"'));for(const name of ['hooks','apps','plugins','browser_use','computer_use'])assert.ok(call.args.some((v,i)=>v==='--disable'&&call.args[i+1]===name));}
 for(const call of calls.slice(4)){assert.ok(call.args.includes('features.respect_system_proxy=true'));assert.ok(call.args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));assert.ok(call.args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));const collab=call.args.some((a,i)=>a==='--enable'&&call.args[i+1]==='multi_agent');assert.deepEqual(call.args.filter(a=>a.startsWith('agents.max_concurrent_threads_per_session=')),collab?['agents.max_concurrent_threads_per_session=1']:[]);}
 assert.equal(report.runs[0].actualModel,null);assert.equal(report.runs[0].modelEvidence,'argv-only');assert.equal(report.runs[4].actualModel,'gpt-6.1-sol');
 assert.equal(report.runs[5].collaboration.readOnlyEnforcement,'not-verified');assert.equal(report.runs[5].usage.total,null);assert.equal(report.runs[5].totalCost,null);assert.equal(report.defaultsChanged,false);
 assert.ok(report.runs.every(r=>r.promptHash&&r.inputHash&&r.validatorHash));
});
test('bounded task failures remain in the denominator and are not retried',async t=>{
 present('runCalibration');const {report,calls}=await mockRun(t,{failAt:1});assert.equal(calls.length,8);assert.equal(report.runs[1].status,'failed');assert.equal(report.runs[1].taskPassed,false);assert.equal(report.summary.attempted,8);assert.equal(report.summary.passed,7);
});
test('optional collaboration has one effective concurrency limit instead of a later override',async t=>{
 present('runCalibration');const {calls}=await mockRun(t);for(const call of [calls[5],calls[6]])assert.deepEqual(call.args.filter(a=>a.startsWith('agents.max_concurrent_threads_per_session=')),['agents.max_concurrent_threads_per_session=1']);
});
test('uncertain cleanup immediately stops subsequent arms and preserves unknown usage',async t=>{
 present('runCalibration');const {report,calls}=await mockRun(t,{failAt:4,uncertain:true});assert.equal(calls.length,5);assert.ok(report.runs.slice(5).every(r=>r.status==='not-run'));assert.equal(report.runs[4].needsInspection,true);assert.equal(report.runs[4].usage.total,null);
});
test('failed native tasks retain known family evidence and missing traces remain unknown',async t=>{
 present('runCalibration');const known=await mockRun(t,{failAt:5,uncertain:true});assert.equal(known.report.runs[5].children?.length,1);assert.equal(known.report.runs[5].status,'failed');
 const unknown=await mockRun(t,{failAt:4,uncertain:true,missingTrace:true});assert.equal(unknown.report.runs[4].children,null);assert.equal(unknown.report.runs[4].nativeEvidenceStatus,'partial');
});
test('successful task output without a native session identity cannot pass calibration',async t=>{
 present('runCalibration');const {report}=await mockRun(t,{missingSession:true});
 for(const row of report.runs.slice(4)){assert.equal(row.acceptance,undefined);assert.equal(row.modelTests,undefined);assert.equal(row.status,'failed');assert.equal(row.taskPassed,false);assert.equal(row.sessionId,null);assert.equal(row.children,null);assert.equal(row.nativeEvidenceStatus,'partial');assert.match(row.error,/session identity/);}
});
test('independent acceptance denies outside writes, network and child execution without inheriting secrets',async t=>{
 present('judgeCode');const base=await temporary(t),root=join(base,'work'),hidden=join(base,'hidden'),outside=join(base,'outside.txt');await mkdir(root);await mkdir(hidden);
 const previous=process.env.YAM_CALIBRATION_TEST_SECRET;process.env.YAM_CALIBRATION_TEST_SECRET='not-for-fixture';t.after(()=>{if(previous===undefined)delete process.env.YAM_CALIBRATION_TEST_SECRET;else process.env.YAM_CALIBRATION_TEST_SECRET=previous;});
 const probe=`import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {connect} from 'node:net';import {execFileSync} from 'node:child_process';assert.equal(process.env.YAM_CALIBRATION_TEST_SECRET,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.throws(()=>writeFileSync(${JSON.stringify(outside)},'outside'),{code:'ERR_ACCESS_DENIED'});await assert.rejects(new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:9});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve();});}),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>execFileSync('/bin/true'),{code:'ERR_ACCESS_DENIED'});`;
 await writeFile(join(root,'normalize-title.mjs'),probe+normalize);assert.equal((await api.judgeCode('C3',root,hidden,verificationOptions)).passed,true);assert.equal(existsSync(outside),false);
});
test('model-authored tests cannot escape the fixture filesystem during host verification',async t=>{
 present('runCalibration');const {report,base}=await mockRun(t,{unsafeOwnTest:true});assert.equal(report.runs[4].taskPassed,false);assert.equal(existsSync(join(base,'outside.txt')),false);assert.match(report.runs[4].modelTests.stderr+report.runs[4].modelTests.stdout,/ERR_ACCESS_DENIED/);
});
test('independent verification rejects modules that replace themselves after their assertions pass',async t=>{
 present('runCalibration');const {report}=await mockRun(t,{artifactMutation:'independent'});
 for(const row of report.runs.slice(4,6)){assert.equal(row.acceptance.passed,true);assert.equal(row.taskPassed,false);assert.match(row.error,/artifacts changed during independent verification/i);assert.equal(row.modelTests,undefined);}
});
test('model tests cannot replace a module after independent acceptance passed',async t=>{
 present('runCalibration');const {report}=await mockRun(t,{artifactMutation:'model'});
 for(const row of report.runs.slice(4,6)){assert.equal(row.acceptance.passed,true);assert.equal(row.modelTests.passed,true);assert.equal(row.taskPassed,false);assert.match(row.error,/artifacts changed during model tests/i);}
});
test('source snapshot errors during cleanup persist a failed arm and stop later execution',async t=>{
 present('runCalibration');const {report,calls,base}=await mockRun(t,{sourceCleanupFailure:true}),saved=JSON.parse(await readFile(join(base,'receipt.json'),'utf8'));
 assert.equal(calls.length,1);assert.equal(report.runs[0].status,'failed');assert.equal(report.runs[0].taskPassed,false);assert.match(report.runs[0].sourceEvidenceError,/Source snapshot ENOENT/);assert.match(report.runs[0].error,/Source snapshot ENOENT/);assert.match(report.stopReason,/source.*snapshot/i);assert.ok(report.runs.slice(1).every(row=>row.status==='not-run'));assert.deepEqual(saved,report);assert.ok(saved.finishedAt);assert.equal(saved.runs[0].exitCode,0);assert.equal(saved.runs[0].acceptance.passed,true);assert.equal(saved.summary.failed,1);assert.equal(saved.summary.notRun,7);
});
test('wrong helper model fails collaboration evidence despite correct artifacts',async t=>{
 present('runCalibration');const {report}=await mockRun(t,{invalidChild:true});assert.equal(report.runs[5].taskPassed,false);assert.match(report.runs[5].error,/helper/);
});
test('single-model evidence rejects spawn and collaboration evidence rejects missing or nested children',()=>{
 present('verifyCalibrationTrace');const main={id:'parent',provider:'openai',models:['gpt-6.1-sol'],spawnCalls:[]},arm=manifest.cases[2].arms[0];
 assert.equal(api.verifyCalibrationTrace({main,children:[]},arm).children,0);
 assert.throws(()=>api.verifyCalibrationTrace({main:{...main,spawnCalls:[{}]},children:[]},arm));
 const collab=manifest.cases[2].arms[1],spawn={model:'gpt-6-luna',fork_turns:'none'};
 assert.throws(()=>api.verifyCalibrationTrace({main:{...main,spawnCalls:[spawn]},children:[]},collab));
 assert.throws(()=>api.verifyCalibrationTrace({main:{...main,spawnCalls:[spawn]},children:[{parent:'parent',depth:2,models:['gpt-6-luna'],provider:'openai',spawnCalls:[]}]},collab));
 assert.throws(()=>api.verifyCalibrationTrace({main:{...main,spawnCalls:[spawn]},children:[{parent:'parent',depth:1,models:['gpt-6-luna'],provider:'openai',spawnCalls:[],toolActivity:[{name:'apply_patch'}]}]},collab));
});
test('calibration preserves existing evidence and rejects repository output paths',async t=>{
 present('runCalibration');const root=await temporary(t),receiptPath=join(root,'existing.json');await writeFile(receiptPath,'original evidence');
 const options={runNative:true,discover:async()=>[],sourceSnapshot:async()=>({fingerprint:'frozen'})};
 await assert.rejects(api.runCalibration({...options,receiptPath}),/exist/i);assert.equal(await readFile(receiptPath,'utf8'),'original evidence');
 await assert.rejects(api.runCalibration({...options,receiptPath:new URL('../../../calibration-must-not-write.json',import.meta.url).pathname}),/outside/);
});

test('repository replay corpus is bounded, reconstructed and keeps its frozen source hashes',async()=>{
 present('loadReplayManifest');present('validateReplayManifest');const replay=await api.loadReplayManifest();assert.equal(replay.origin,'repository-defect-reconstructed-replay');assert.deepEqual(replay.cases.map(c=>c.id),['R1','R2']);assert.equal(replay.cases.flatMap(c=>c.arms).length,4);assert.equal(Object.keys(replay.cases[0].files).length,7);
 for(const change of [m=>m.cases[0].files['escape.mjs']='x',m=>m.cases[0].files['router.mjs']='x'.repeat(128*1024+1),m=>m.cases[1].arms[0].effort='low',m=>m.cases[0].targets.push('agent-executor.mjs')]){const copy=structuredClone(replay);change(copy);assert.throws(()=>api.validateReplayManifest(copy));}
});
test('repository replay hidden oracles reject reconstructed defects and accept frozen fixed modules',async t=>{
 present('loadReplayManifest');const replay=await api.loadReplayManifest(),base=await temporary(t);
 for(const item of replay.cases){const root=join(base,item.id),hidden=join(base,item.id+'-hidden');await mkdir(root);await mkdir(hidden);for(const [name,content] of Object.entries(item.files))await writeFile(join(root,name),content);const broken=await api.judgeCode(item.id,root,hidden,verificationOptions);assert.equal(broken.passed,false,broken.stdout+broken.stderr);for(const name of item.targets)await writeFile(join(root,name),await readFile(new URL('./fixtures/goal-delivery-replay/fixed/'+name,import.meta.url)));const fixed=await api.judgeCode(item.id,root,hidden,verificationOptions);assert.equal(fixed.passed,true,fixed.error??fixed.stdout+fixed.stderr);}
});
function replayFamily(){
 const stamp=n=>`2026-11-06T00:00:0${n}.000Z`,spawn={model:'gpt-6-luna',reasoning_effort:'medium',fork_turns:'none',task_name:'review',message:'Analyze supplied native-codex.mjs code: function register(m){...}. No tools.',at:stamp(1)};
 const main={id:'parent',parent:null,depth:0,provider:'openai',models:['gpt-6.1-sol'],efforts:['high'],spawnCalls:[spawn],imageCalls:[],toolActivity:[{name:'wait_agent',at:stamp(4),output:{timed_out:false}},{name:'exec',at:stamp(5)}],finalText:'Done',finalAt:stamp(6),completedAt:stamp(7),failed:false};
 const child={id:'child',parent:'parent',depth:1,taskName:'/root/review',provider:'openai',models:['gpt-6-luna'],efforts:['medium'],spawnCalls:[],imageCalls:[],toolActivity:[],finalText:JSON.stringify({findings:[]}),finalAt:stamp(2),completedAt:stamp(3),failed:false};return {main,children:[child]};
}
test('required collaboration needs actual successful tool-free child, exact effort and waited integration',()=>{
 present('verifyReplayTrace');const arm={model:'gpt-6.1-sol',effort:'high',collaboration:true},integration={task_name:'review',findings:[],tests:'node --test replay.test.mjs passed'};assert.equal(api.verifyReplayTrace(replayFamily(),arm,integration).children,1);
 for(const change of [f=>f.children=[],f=>f.children[0].efforts=['low'],f=>f.children[0].toolActivity=[{name:'read'}],f=>f.children[0].completedAt=null,f=>f.children[0].finalText='',f=>f.children[0].failed=true,f=>f.main.toolActivity=[],f=>f.children[0].parent='other',f=>f.main.spawnCalls[0].fork_turns='all',f=>f.main.spawnCalls[0].reasoning_effort='low']){const family=replayFamily();change(family);assert.throws(()=>api.verifyReplayTrace(family,arm,integration));}
 assert.throws(()=>api.verifyReplayTrace(replayFamily(),arm,{...integration,task_name:'other'}));
 const finding=replayFamily();finding.children[0].finalText=JSON.stringify({findings:[{id:'F1',file:'native-codex.mjs',detail:'stale metadata'}]});assert.throws(()=>api.verifyReplayTrace(finding,arm,integration));
});
async function mockReplay(t,{dependencyMutation=false,failAt=-1,uncertain=false,opaqueMaterial=false,traceStall=false,traceDefect,evidenceWriter}={}){
 const base=await temporary(t),calls=[],families=new Map(),replay=await api.loadReplayManifest();
 const runner=async(file,args,options)=>{
  if(args[0]==='sandbox')return verificationOptions.runner(file,args,options);
  const index=calls.length,item=replay.cases[Math.floor(index/2)],arm=item.arms[index%2],id=randomUUID();calls.push({args,timeoutMs:options.timeoutMs,input:options.input});options.onSpawn?.({pid:40000+index,pgid:40000+index});options.onLine(JSON.stringify({type:'thread.started',thread_id:id}));
  const family=replayFamily();family.main.id=id;family.children[0].parent=id;if(!arm.collaboration){family.main.spawnCalls=[];family.children=[];}if(opaqueMaterial&&arm.collaboration)family.main.spawnCalls[0].message='gAAAA'+'encrypted'.repeat(20);families.set(id,family);
  if(index===failAt)throw Object.assign(Error('Mock native failure'),{mayBeRunning:uncertain});
  for(const name of item.targets)await writeFile(join(options.cwd,name),await readFile(new URL('./fixtures/goal-delivery-replay/fixed/'+name,import.meta.url)));
  if(dependencyMutation)await writeFile(join(options.cwd,'policy.mjs'),'// changed dependency');
  await writeFile(join(options.cwd,'replay.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';test('fixed native module exports its adapter',async()=>assert.equal(typeof (await import('./native-codex.mjs')).createNativeCodex,'function'));");
  if(arm.collaboration)await writeFile(join(options.cwd,'review-integration.json'),JSON.stringify({task_name:'review',findings:[],tests:'node --test replay.test.mjs passed'}));
  const events=[{type:'item.completed',item:{type:'agent_message',text:'Fixed repository replay.'}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:4}}];for(const event of events)options.onLine(JSON.stringify(event));return {code:0,stdout:[{type:'thread.started',thread_id:id},...events].map(JSON.stringify).join('\n'),stderr:''};
 };
 const report=await api.runCalibration({runNative:true,suite:'repository-replay',receiptPath:join(base,'receipt.json'),discover:async()=>[{kind:'codex',auth:'subscription',executable:'/fixture/codex'}],isolationProbe:async()=>({passed:true}),sourceSnapshot:async()=>({fingerprint:'frozen'}),runner,evidenceWriter,traceReader:async id=>{if(traceStall)return new Promise(()=>{});const family=families.get(id);if(traceDefect==='missing-family')throw Error('Native trace missing');if(traceDefect==='missing-main-terminal')family.main.completedAt=null;if(family.children.length){if(traceDefect==='missing-child-terminal')family.children[0].completedAt=null;if(traceDefect==='missing-child-trace')family.children=[];if(traceDefect==='nested-spawn')family.children[0].spawnCalls=[{}];if(traceDefect==='completed-wrong-effort')family.children[0].efforts=['low'];}return family;}});return {report,calls,base};
}
test('repository replay runs four bounded arms through the existing safe loop and preserves dependencies',async t=>{
 const {report,calls}=await mockReplay(t);assert.equal(report.summary.planned,4);assert.equal(report.summary.passed,4);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.timeoutMs===540000));assert.equal(report.limits.timeoutMs,600000);assert.deepEqual(report.runs.map(r=>r.children.length),[0,1,1,0]);assert.ok(report.runs.every(r=>r.totalCost===null&&r.usage.total===null));assert.equal(report.defaultsChanged,false);
 const changed=await mockReplay(t,{dependencyMutation:true});assert.equal(changed.report.summary.passed,0);assert.ok(changed.report.runs.every(r=>/Frozen dependency changed/.test(r.error)));
});
test('repository replay retains failed collaboration evidence without retry and stops uncertain cleanup',async t=>{
 const opaque=await mockReplay(t,{opaqueMaterial:true});assert.equal(opaque.calls.length,4);assert.equal(opaque.report.summary.passed,2);for(const row of opaque.report.runs.filter(r=>r.arm==='sol-luna-required')){assert.equal(row.nativeEvidenceStatus,'partial');assert.match(row.error,/encrypted/i);}
 const failed=await mockReplay(t,{failAt:1,uncertain:true});assert.equal(failed.calls.length,2);assert.equal(failed.report.runs[1].status,'failed');assert.ok(failed.report.runs.slice(2).every(r=>r.status==='not-run'));assert.match(failed.report.stopReason,/cleanup/);
});
test('repository replay deadline also bounds native trace collection and persists the failed terminal',async t=>{
 const original=setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>original(callback,(ms>290000&&ms<=300000||ms>590000&&ms<=600000)?1000:ms,...args));
 const {report,calls}=await mockReplay(t,{traceStall:true});assert.equal(calls.length,1);assert.equal(report.runs[0].modelTests.passed,true);assert.match(report.runs[0].nativeEvidenceError,/deadline/);assert.equal(report.runs[0].status,'failed');assert.ok(report.finishedAt);assert.equal(report.summary.notRun,3);
});
test('native calibration event inspection records actual effort, terminal, tools and helper materials',()=>{
 present('inspectCalibrationEvents');const id=randomUUID(),message='Analyze supplied native-codex.mjs: export function test() {}. No tools.',events=[{type:'session_meta',payload:{id,model_provider:'openai',source:{subagent:{thread_spawn:{parent_thread_id:'parent',depth:1,agent_path:'/root/review'}}}}},{type:'turn_context',payload:{model:'gpt-6-luna',effort:'medium'}},{timestamp:'2026-11-06T00:00:01Z',type:'response_item',payload:{type:'function_call',name:'spawn_agent',arguments:JSON.stringify({message}),call_id:'spawn'}},{timestamp:'2026-11-06T00:00:02Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'{"findings":[]}'}]}},{timestamp:'2026-11-06T00:00:03Z',type:'event_msg',payload:{type:'task_complete'}}];
 const trace=api.inspectCalibrationEvents(events);assert.deepEqual(trace.efforts,['medium']);assert.equal(trace.taskName,'/root/review');assert.equal(trace.toolActivity.length,1);assert.equal(trace.completedAt,events.at(-1).timestamp);assert.equal(trace.spawnCalls[0].message,message);assert.equal(trace.spawnCalls[0].materialHash,createHash('sha256').update(message).digest('hex'));assert.equal(trace.spawnCalls[0].materialEncoding,'plaintext');assert.equal(trace.failed,false);assert.equal(api.inspectCalibrationEvents([...events,{type:'event_msg',payload:{type:'turn_aborted'}}]).failed,true);
});
test('replay missing family or main terminal stops immediately without inventing child absence',async t=>{
 for(const traceDefect of ['missing-family','missing-main-terminal']){const {report,calls}=await mockReplay(t,{traceDefect});assert.equal(calls.length,1);assert.equal(report.runs[0].needsInspection,true);assert.equal(report.runs[0].status,'failed');assert.equal(report.summary.notRun,3);if(traceDefect==='missing-family')assert.equal(report.runs[0].children,null);}
});
test('replay missing child terminal or trace and nested spawn stop before the next arm',async t=>{
 for(const traceDefect of ['missing-child-terminal','missing-child-trace','nested-spawn']){const {report,calls}=await mockReplay(t,{traceDefect});assert.equal(calls.length,2);assert.equal(report.runs[1].needsInspection,true);assert.equal(report.runs[1].status,'failed');assert.equal(report.summary.notRun,2);}
 const completed=await mockReplay(t,{traceDefect:'completed-wrong-effort'});assert.equal(completed.calls.length,4);assert.equal(completed.report.summary.failed,2);assert.ok(completed.report.runs.every(row=>!row.needsInspection));assert.equal(completed.report.stopReason,undefined);
});
test('replay slow successful receipt cannot outlive the deadline or overwrite the failed flush',async t=>{
 const original=setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>original(callback,(ms>290000&&ms<=300000||ms>590000&&ms<=600000)?700:ms,...args));let slowWritten;const late=new Promise(resolve=>slowWritten=resolve);let delayed=false;
 const evidenceWriter=async(path,data,options)=>{let value;try{value=JSON.parse(data);}catch{}if(!delayed&&value?.runs?.[0]?.status==='passed'){delayed=true;await new Promise(resolve=>original(resolve,1000));await writeFile(path,data,{mode:0o600});slowWritten();return;}return writeFile(path,data,options);};
 const {report,calls,base}=await mockReplay(t,{evidenceWriter});assert.equal(calls.length,1);assert.equal(report.runs[0].status,'failed');assert.match(report.runs[0].error,/deadline/);assert.ok(report.runs[0].elapsedMs>=650);await late;await new Promise(resolve=>original(resolve,30));const saved=JSON.parse(await readFile(join(base,'receipt.json'),'utf8'));assert.equal(saved.runs[0].status,'failed');assert.equal(saved.summary.notRun,3);
});
test('replay failure receipt flush is separately bounded when evidence storage stalls',async t=>{
 const original=setTimeout;t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>original(callback,(ms>290000&&ms<=300000||ms>590000&&ms<=600000)?700:ms===1000?100:ms,...args));
 const evidenceWriter=async(path,data,options)=>{let value;try{value=JSON.parse(data);}catch{}if(value?.runs?.[0]?.status==='passed'||value?.runs?.[0]?.status==='failed')return new Promise(()=>{});return writeFile(path,data,options);};
 const {report,calls}=await mockReplay(t,{evidenceWriter});assert.equal(calls.length,1);assert.equal(report.runs[0].status,'failed');assert.match(report.failureFlushError,/deadline|abort/i);assert.equal(report.summary.notRun,3);
});

test('recovery native content-block outputs preserve one JSON result and reject ambiguous or malformed results',()=>{
 const id=randomUUID(),base=[{type:'session_meta',payload:{id,model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'high'}},{timestamp:'2026-11-06T00:00:01Z',type:'response_item',payload:{type:'function_call',name:'wait_agent',arguments:'{}',call_id:'wait'}}];
 for(const value of [[{type:'input_text',text:'Script completed'},{type:'input_text',text:'{"timed_out":false}'}],JSON.stringify([{type:'text',text:'{"timed_out":false}'}])]){const trace=api.inspectCalibrationEvents([...base,{timestamp:'2026-11-06T00:00:03Z',type:'response_item',payload:{type:'function_call_output',call_id:'wait',output:value}}]);assert.deepEqual(trace.toolActivity[0].output,{timed_out:false});}
 for(const value of [[{type:'text',text:'not json'}],[{type:'text',text:'{"timed_out":false}'},{type:'text',text:'{"timed_out":true}'}]])assert.equal(api.inspectCalibrationEvents([...base,{type:'response_item',payload:{type:'function_call_output',call_id:'wait',output:value}}]).toolActivity[0].output,null);
});
test('recovery encrypted dispatch needs exact child-final source and test witnesses, never opaque self-report',()=>{
 const family=replayFamily(),arm={model:'gpt-6.1-sol',effort:'high',collaboration:true},integration={task_name:'review',findings:[],tests:'node --test replay.test.mjs passed'},sources={'native-codex.mjs':"export function register(model){return {...model,input:[...model.input],contextWindow:model.contextWindow};}",'replay.test.mjs':"test('model metadata is refreshed without changing identity',()=>assert.deepEqual(register(model).input,model.input));"};family.main.spawnCalls[0].message='gAAAA'+'encrypted'.repeat(20);
 const review={findings:[],reviewedSources:Object.entries(sources).map(([file,quote])=>({file,quote}))};family.children[0].finalText=JSON.stringify(review);const result=api.verifyReplayTrace(family,arm,integration,sources);assert.equal(result.materialEncoding,'child-final-source-quotes');assert.ok(result.materialHash);
 for(const edit of [value=>value.reviewedSources.pop(),value=>value.reviewedSources[0].quote='export function fabricatedRefresh(model){return {...model,neverActuallyPresentInTheSource:true,contextWindow:123456};}',value=>value.reviewedSources[0].file='../native-codex.mjs',value=>value.reviewedSources.push(value.reviewedSources[0])]){const value=structuredClone(review);edit(value);const copy=structuredClone(family);copy.children[0].finalText=JSON.stringify(value);assert.throws(()=>api.verifyReplayTrace(copy,arm,integration,sources));}
 assert.throws(()=>api.verifyReplayTrace(family,arm,integration));
 const reviewedBeforeFix={...sources,'native-codex.mjs':['// frozen input\n'+sources['native-codex.mjs']+'\n// end','export function updated(){return null;}']};assert.equal(api.verifyReplayTrace(family,arm,integration,reviewedBeforeFix).materialEncoding,'child-final-source-quotes');
});
test('recovery replay freezes a new budget, explicit isolated instructions and actual process identities',async t=>{
 const {report,calls}=await mockReplay(t);assert.equal(report.limits.timeoutMs,600000);assert.equal(report.limits.modelTimeoutMs,540000);assert.equal(report.limits.retries,0);assert.ok(calls.every(call=>call.args.includes('project_doc_max_bytes=0')&&call.args.includes('skills.max_context_tokens=1')&&call.input.includes('Isolated synthetic calibration')&&call.input.includes('Do not compute hashes')));assert.ok(report.runs.every((row,index)=>row.process.pid===40000+index&&row.process.pgid===row.process.pid));
});
