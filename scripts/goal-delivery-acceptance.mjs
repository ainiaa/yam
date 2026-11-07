// Author: Jeff.Liu. Explicit opt-in, headless acceptance of goal delivery through the existing native adapter.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,readdir,copyFile,realpath,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import install from '../apps/desktop/src-tauri/pi/router.mjs';
import {createNativeCodex} from '../apps/desktop/src-tauri/pi/native-codex.mjs';
import {discoverAgents,executeAgent,runProcess} from '../apps/desktop/src-tauri/pi/agent-executor.mjs';
import {snapshotBusiness,relativeArtifact} from './pi-native-acceptance.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sdk=process.env.YAM_PI_SDK_DIR??join(homedir(),'.npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const moduleAt=path=>import(pathToFileURL(join(sdk,path)).href);
const canonical=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
let typescript;
function nativeImageCall(input){
 const ts=typescript??=createRequire(new URL('../apps/desktop/package.json',import.meta.url))('typescript'),source=ts.createSourceFile('native-image-call.js',input,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),calls=[];
 const exact=node=>ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='tools'&&node.expression.name.text==='image_gen__imagegen';
 for(const statement of source.statements){
  const expressions=ts.isExpressionStatement(statement)?[statement.expression]:ts.isVariableStatement(statement)?statement.declarationList.declarations.map(d=>d.initializer).filter(Boolean):[];
  for(const expression of expressions)if(ts.isAwaitExpression(expression)&&exact(expression.expression))calls.push(expression.expression);
 }
 if(!calls.length)return null;
 let all=0;const count=node=>{if(exact(node))all++;ts.forEachChild(node,count);};count(source);
 assert.ok(calls.length===1&&all===1,'Ambiguous image calls require manual review');assert.equal(source.parseDiagnostics.length,0,'Unsupported image call syntax requires manual review');
 const call=calls[0];assert.ok(call.arguments.length===1&&ts.isObjectLiteralExpression(call.arguments[0]),'Dynamic image arguments require manual review');
 const properties=call.arguments[0].properties;assert.ok(properties.every(p=>!ts.isSpreadAssignment(p)&&!ts.isComputedPropertyName(p.name)),'Dynamic image properties require manual review');
 const references=properties.filter(p=>p.name?.text==='referenced_image_paths');assert.ok(references.length<=1,'Ambiguous image references require manual review');
 if(!references.length)return {referencedImagePaths:null};
 const reference=references[0];assert.ok(ts.isPropertyAssignment(reference)&&ts.isArrayLiteralExpression(reference.initializer)&&reference.initializer.elements.every(ts.isStringLiteral),'Dynamic image references require manual review');
 return {referencedImagePaths:reference.initializer.elements.map(e=>e.text)};
}
function generatedOutputPaths(output){
 const text=typeof output==='string'?output:Array.isArray(output)?output.filter(part=>part.type==='input_text'||part.type==='text').map(part=>part.text??'').join('\n'):'';
 return [...text.matchAll(/Generated images are saved to [^\r\n]*? as (\/[^\r\n]+?) by default\./g)].map(match=>match[1]);
}
export function inspectNativeTrace(events){
 const meta=events.find(e=>e.type==='session_meta')?.payload;assert.ok(canonical(meta?.id),'Missing native session metadata');
 const spawnCalls=[],imageCalls=[],outputs=new Map(events.filter(e=>e.type==='response_item'&&e.payload?.type==='custom_tool_call_output').map(e=>[e.payload.call_id,e.payload.output]));let finalText='';
 for(const e of events){
  const p=e.payload??{};
  if(e.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&p.phase==='final_answer')finalText=(p.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join('');
  if(e.type==='response_item'&&p.type==='function_call'&&/(?:^|\.)spawn_agent$/.test(p.name??'')){const {model,reasoning_effort,fork_turns,task_name}=JSON.parse(p.arguments);spawnCalls.push({model,reasoning_effort,fork_turns,task_name});}
  if(e.type==='response_item'&&p.type==='custom_tool_call'&&p.name==='exec'){const image=nativeImageCall(p.input??'');if(image)imageCalls.push({callId:p.call_id,input:p.input,...image,outputCallId:outputs.has(p.call_id)?p.call_id:null,outputPaths:generatedOutputPaths(outputs.get(p.call_id))});}
 }
 return {id:meta.id,provider:meta.model_provider,parent:meta.parent_thread_id??meta.source?.subagent?.thread_spawn?.parent_thread_id??null,depth:meta.source?.subagent?.thread_spawn?.depth??0,finalText,models:[...new Set(events.filter(e=>e.type==='turn_context').map(e=>e.payload?.model).filter(Boolean))],spawnCalls,imageCalls};
}
export function verifyTraceFamily(main,children,expected){
 assert.equal(main.provider,'openai');assert.ok(main.models.includes(expected.main));assert.ok(main.spawnCalls.some(c=>c.model===expected.helper&&c.fork_turns==='none'),'Missing explicit different-model native spawn');
 assert.ok(children.some(c=>c.models.includes(expected.helper)),'Missing actual helper model context');
 for(const child of children){assert.equal(child.provider,'openai');assert.equal(child.parent,main.id);assert.equal(child.depth,1);assert.equal(child.spawnCalls.length,0,'Native leaf delegated again');assert.ok(child.models.every(m=>m===expected.helper||m===expected.main),'Unexpected helper model');}
 return true;
}
export async function checkGoalArtifacts(root,document,decode){
 const project=await realpath(root),path=await realpath(resolve(root,document));assert.ok(!relative(project,path).startsWith('..')&&!isAbsolute(relative(project,path)));
 const text=await readFile(path,'utf8');assert.ok(text.includes('80'));assert.ok(new Set(text.match(/AC-\d+/g)).size>=6);
 const links=[...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]);assert.equal(links.length,1);
 const link=links[0];assert.ok(!isAbsolute(link)&&!link.split(/[\\/]/).includes('..'),'Nonportable image reference');
 const imagePath=await realpath(resolve(dirname(path),link));assert.ok(!relative(project,imagePath).startsWith('..'));
 const bytes=await readFile(imagePath);assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP');assert.equal(await decode(bytes),true,'Image is not decodable');
 return {document,image:relative(project,imagePath),documentHash:hash(Buffer.from(text)),imageHash:hash(bytes),bytes:bytes.length};
}
export async function verifyImageProvenance(root,first,second,trace,{cacheRoot=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'generated_images'),children=[]}={}){
 assert.notEqual(first.imageHash,second.imageHash,'Edited image must differ from the original');assert.ok(canonical(trace.id));assert.ok(trace.imageCalls.length>=2,'Missing native image calls');
 const sessions=[trace.id,...children.map(child=>{assert.equal(child.parent,trace.id);assert.equal(child.provider,'openai');assert.ok(canonical(child.id));return child.id;})],cache=[];
 for(const id of sessions){const directory=join(cacheRoot,id),files=await readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});for(const file of files)if(file.isFile()){const path=await realpath(join(directory,file.name));cache.push({path,hash:hash(await readFile(path))});}}
 const outputs=[];for(const [image,call] of [[first,trace.imageCalls[0]],[second,trace.imageCalls.at(-1)]]){assert.equal(hash(await readFile(resolve(root,image.image))),image.imageHash,'Image changed after validation');assert.equal(call.outputCallId,call.callId,'Image output belongs to a different tool call');assert.equal(call.outputPaths?.length,1,'Missing or ambiguous native tool output path requires manual review');const output=await realpath(call.outputPaths[0]),generated=cache.find(file=>file.hash===image.imageHash&&file.path===output);assert.ok(generated,'Image does not match this tool call output in its native session cache');outputs.push({...generated,callId:call.callId});}
 const edit=trace.imageCalls.at(-1),paths=edit.referencedImagePaths;
 assert.ok(Array.isArray(paths)&&paths.length===1&&typeof paths[0]==='string','Invalid original edit reference');assert.equal(await realpath(resolve(root,paths[0])),await realpath(resolve(root,first.image)),'Edit input is not the original image');
 return {editInputVerified:true,editCallId:edit.callId,editCallHash:hash(Buffer.from(edit.input)),originalImageHash:first.imageHash,editedImageHash:second.imageHash,nativeOutputs:outputs};
}
export async function verifyNoReplay(receipt){
 assert.ok(['failed','running'].includes(receipt?.status));let executions=0;const entries=[{type:'custom',customType:'yam.native-codex.v1',data:receipt}];
 const createStream=()=>{let settle;const result=new Promise(resolve=>settle=resolve);return {push:event=>{if(event.type==='error')settle(event.error);if(event.type==='done')settle(event.message);},end(){},result:()=>result};};
 const bridge=createNativeCodex({registerCommand(){},registerProvider(){},getActiveTools:()=>['read','bash','edit','write'],appendEntry(){assert.fail('Replay changed durable state');}},{createStream,getTools:()=>[{name:'read'}],getSystemPrompt:()=>'',discover:async()=>{assert.fail('Replay reached discovery');},execute:async()=>{executions++;assert.fail('Replay executed a task');}});
 const ctx={cwd:'/fixture',ui:{setStatus(){}},sessionManager:{getBranch:()=>entries,getSessionFile:()=>'/fixture/parent.jsonl'}};bridge.beginTurn(ctx);
 const result=await bridge.stream({provider:'yam-codex',id:receipt.model?.split('/').slice(1).join('/')??'main'},{messages:[{role:'user',content:'do not replay'}],tools:[{name:'read'}]},{}).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/unfinished native task/);assert.equal(executions,0);return true;
}
const absent=(id,group=false)=>{assert.ok(Number.isInteger(id)&&id>1);try{process.kill(group?-id:id,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
export async function checkCancellationEvidence(report,observe=async r=>{const path=join(r.fixtureRoot,'heartbeat.json'),before=await readFile(path);await new Promise(resolve=>setTimeout(resolve,600));return {heartbeatStable:before.equals(await readFile(path)),childAbsent:absent(r.heartbeat.pid),childGroupAbsent:absent(r.heartbeat.pgid,true),rootGroupAbsent:absent(r.cancelOwnedProcess.pgid,true)};}){
 const status=report.cancel?.status;assert.ok(['failed','running'].includes(status),'Cancelled work must not be completed');assert.ok(report.heartbeatAncestors?.[0]===report.heartbeat?.pid&&report.heartbeatAncestors.includes(report.cancelOwnedProcess?.pid),'Missing pre-cancel owned ancestry');
 if(status==='running'){const job=report.jobs.findLast(j=>j.mode==='task');assert.ok(job?.interruptUnconfirmed===true||job?.interruptUnconfirmed===undefined&&/cleanup.*(?:may.*running|unconfirmed)/i.test(job?.error??''),'Unknown lifecycle needs explicit cleanup uncertainty');}
 const observations=await observe(report);for(const key of ['heartbeatStable','childAbsent','childGroupAbsent','rootGroupAbsent'])assert.equal(observations[key],true,key);assert.equal(await verifyNoReplay(report.cancel),true);
 return {...observations,replayBlocked:true,receiptStatus:status,needsInspection:status==='running'};
}
export async function checkIndependentCode(root){
 const module=await import(pathToFileURL(join(root,'normalize-title.mjs')).href);assert.equal(typeof module.normalizeTitle,'function');const normalize=module.normalizeTitle;
 assert.equal(normalize('  中文\t\n测试  '),'中文 测试');assert.equal(normalize('😀'.repeat(80)),'😀'.repeat(80));assert.throws(()=>normalize('😀'.repeat(81)),RangeError);assert.throws(()=>normalize(' \t\n '),RangeError);for(const value of [null,undefined,0,{},[]])assert.throws(()=>normalize(value),TypeError);
 return {assertions:9,moduleHash:hash(await readFile(join(root,'normalize-title.mjs'))),testsHash:hash(await readFile(join(root,'normalize-title.test.mjs')))};
}
export function checkReadonlyReply(message,job){
 assert.equal(message?.provider,'yam-codex');assert.equal(message.model,'gpt-6-luna');assert.equal(message.stopReason,'stop');
 const text=(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('');assert.equal(text.trim(),'HELLO WORLD');assert.ok(message.content.every(p=>p.type==='text'));
 assert.equal(job?.mode,'readonly');assert.equal(job.model,message.model);assert.equal(job.allowCollaboration,false);assert.equal(job.exitCode,0);assert.equal(job.finalText?.trim(),text.trim());
 assert.ok(job.argv.includes('--ephemeral'));assert.ok(job.argv.includes('--model'));assert.equal(job.argv[job.argv.indexOf('--model')+1],message.model);
 for(const type of ['thread.started','item.completed','turn.completed'])assert.ok(job.events.some(e=>e.type===type),'Missing native event '+type);
 assert.ok(job.events.some(e=>e.type==='item.completed'&&e.itemType==='agent_message'));
 assert.ok(job.events.every(e=>!['error','turn.failed'].includes(e.type)&&(!e.itemType||['agent_message','reasoning'].includes(e.itemType))),'Readonly reply failed or executed a tool');
 return {kind:'readonly-native-reply',finalText:text.trim(),model:message.model,modelEvidence:'native-cli-argv',businessReceiptRequired:false,message,execution:job};
}
export async function verifySavedGoalDelivery(successPath,cancelPath){
 const report=JSON.parse(await readFile(successPath,'utf8')),cancel=JSON.parse(await readFile(cancelPath,'utf8')),{convertToPng}=await moduleAt('dist/index.js'),decode=async bytes=>Boolean(await convertToPng(bytes.toString('base64'),'application/octet-stream'));
 const readTrace=async saved=>{const bytes=await readFile(saved.path);assert.equal(hash(bytes),saved.sha256,'Native rollout changed');return {...inspectNativeTrace(bytes.toString().split('\n').filter(Boolean).map(JSON.parse)),path:saved.path,sha256:hash(bytes)};};
 const simple=report.simpleEvidence.kind==='readonly-native-reply'?checkReadonlyReply(report.simpleEvidence.message,report.simpleEvidence.execution):await readTrace(report.simpleEvidence.main);assert.equal(simple.finalText.trim(),'HELLO WORLD');if(simple.kind!=='readonly-native-reply'){assert.equal(simple.spawnCalls.length,0);assert.equal(report.simpleEvidence.children.length,0);}
 const development=await readTrace(report.developmentEvidence.main),children=await Promise.all(report.developmentEvidence.children.map(readTrace));verifyTraceFamily(development,children,{main:'gpt-6.1-sol',helper:'gpt-6-luna'});const code=await checkIndependentCode(report.fixtureRoot);
 const first=await checkGoalArtifacts(report.fixtureRoot,'PRD-v1.md',decode),second=await checkGoalArtifacts(report.fixtureRoot,'PRD-v2.md',decode);assert.deepEqual(first,report.prdV1);assert.deepEqual(second,report.prdV2);assert.equal(report.prd.sessionId,report.edit.sessionId);assert.equal(report.edit.handoff.mode,'incremental');
 const image=await readTrace(report.imageEvidence.main),images=await verifyImageProvenance(report.fixtureRoot,first,second,image,{children:report.imageEvidence.children});const cancellation=await checkCancellationEvidence(cancel);return {passed:true,simple:{model:simple.models??[simple.model],reply:simple.finalText},development:{main:development.models,helpers:children.map(c=>({id:c.id,model:c.models,provider:c.provider,depth:c.depth})),code},first,second,images,cancellation,source:report.source,cancelSource:cancel.source};
}
async function nativeFamily(id){
 assert.ok(canonical(id));const home=process.env.CODEX_HOME??join(homedir(),'.codex'),sessions=join(home,'sessions');
 const files=(await readdir(sessions,{recursive:true})).filter(p=>p.endsWith('.jsonl'));let main;
 for(const name of files.filter(p=>p.includes(id))){const path=join(sessions,name),bytes=await readFile(path),events=bytes.toString().split('\n').filter(Boolean).map(JSON.parse);if(events[0]?.payload?.id===id){main={...inspectNativeTrace(events),path,sha256:hash(bytes)};break;}}
 assert.ok(main,'Native rollout missing');const children=[];
 // Inspect session headers only until a direct child is found; unrelated conversation bodies are never parsed.
 const {createReadStream}=await import('node:fs'),{createInterface}=await import('node:readline');
 for(const name of files){
  const path=join(sessions,name),stream=createReadStream(path),lines=createInterface({input:stream,crlfDelay:Infinity});let first;
  try{for await(const line of lines){first=JSON.parse(line);break;}}finally{lines.close();stream.destroy();}
  if(first?.payload?.parent_thread_id!==id&&first?.payload?.source?.subagent?.thread_spawn?.parent_thread_id!==id)continue;
  const bytes=await readFile(path),events=bytes.toString().split('\n').filter(Boolean).map(JSON.parse);children.push({...inspectNativeTrace(events),path,sha256:hash(bytes)});
 }
 return {main,children};
}
async function processTable(){const r=await runProcess('/bin/ps',['-axo','pid=,ppid=,pgid=,command='],{timeoutMs:3000,maxBytes:2*1024*1024});assert.equal(r.code,0);return r.stdout.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?[{pid:Number(m[1]),ppid:Number(m[2]),pgid:Number(m[3]),command:m[4]}]:[];});}
async function waitFor(check,timeout=30000){const until=performance.now()+timeout;while(performance.now()<until){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out waiting for native acceptance evidence');}
export async function runGoalDelivery(receiptPath,{cancelOnly=false,fixtureRoot}={}){
 const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,convertToPng}=await moduleAt('dist/index.js');
 const {createAssistantMessageEventStream,getCurrentTools,getCurrentSystemPrompt,normalizeContext}=await moduleAt('node_modules/@earendil-works/pi-ai/dist/index.js');
 const {estimateMessageTokens}=await moduleAt('node_modules/@earendil-works/pi-ai/dist/utils/estimate.js');
 const {getSupportedThinkingLevels}=await moduleAt('node_modules/@earendil-works/pi-ai/dist/models.js'),{Text}=await moduleAt('node_modules/@earendil-works/pi-tui/dist/index.js');
 const root=cancelOnly?await realpath(fixtureRoot):await mkdtemp(join(tmpdir(),'yam-goal-delivery-')),jobs=[],phases=[],flags={'yam-small':'yam-codex/gpt-6-luna','yam-medium':'yam-codex/gpt-6.1-sol','yam-strong':'yam-codex/gpt-6-astra','yam-classifier':'yam-codex/gpt-6-luna','yam-billing':'subscription'};
 const executable=process.env.YAM_CODEX_EXECUTABLE??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 await mkdir(dirname(receiptPath),{recursive:true});
 await writeFile(join(root,'AGENTS.md'),'作者：Jeff.Liu\nIsolated synthetic acceptance. Work only in this directory except native session/image caches. Test first. No GUI, browser, server, publishing, external messaging, dependency installation, paid API or external agent CLI. Native Codex subagents are permitted for bounded independent work when useful; leaves must not delegate. Use native image tools only. Preserve completed artifacts.\n');
 let session,bridge,context,routing,cancelWatch=null;const decode=async bytes=>Boolean(await convertToPng(bytes.toString('base64'),'application/octet-stream'));
 const discover=executables=>discoverAgents(executables);
 const execute=async(profile,options)=>{let job;const result=await executeAgent(profile,options,async(file,args,o)=>{
  for(const feature of ['hooks','apps','plugins','remote_plugin','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use'])args.splice(1,0,'--disable',feature);
  job={model:profile.model,mode:options.mode,allowCollaboration:options.allowCollaboration??false,gracefulInterrupt:o.gracefulInterrupt===true,resume:options.resume,argv:[file,...args],events:[]};const started=performance.now();jobs.push(job);const original=o.onLine;
  o.onLine=line=>{const e=JSON.parse(line);job.events.push({type:e.type,itemType:e.item?.type,...e.item?.type==='error'?{message:String(e.item.message??e.item.text??'').slice(0,1500)}:{},...e.type==='error'?{message:String(e.message??e.error?.message??'').slice(0,1500)}:{}});original?.(line);if(e.type==='thread.started')void processTable().then(rows=>{const own=rows.find(p=>p.ppid===process.pid&&p.command.startsWith(file+' '));if(own)job.process={pid:own.pid,pgid:own.pgid,ppid:own.ppid};}).catch(error=>{job.processObservationError=String(error.message);});};
  try{const result=await runProcess(file,args,o);job.exitCode=result.code;return result;}catch(error){job.error=String(error.message);job.interruptUnconfirmed=Boolean(error.mayBeRunning);throw error;}finally{job.elapsedMs=Math.round(performance.now()-started);}
 });job.finalText=result.finalText;return result;};
 const settingsManager=SettingsManager.inMemory({packages:[],extensions:[],skills:[],prompts:[],themes:[],retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:false});
 const loader=new DefaultResourceLoader({cwd:root,agentDir:join(root,'pi-agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,disabledBuiltinExtensions:['mcp'],extensionFactories:[async pi=>{
  const api=new Proxy(pi,{get(target,key){return key==='getFlag'?name=>flags[name]??target.getFlag(name):Reflect.get(target,key);}});
  bridge=createNativeCodex(api,{createStream:createAssistantMessageEventStream,normalizeContext,getTools:c=>c.tools??getCurrentTools(c.messages),getSystemPrompt:c=>c.systemPrompt??getCurrentSystemPrompt(c.messages),executable,discover,execute,validateImage:decode});
  routing=await install(api,getSupportedThinkingLevels,Text,bridge,{estimateMessageTokens,getReserveTokens:model=>SettingsManager.inMemory(pi.getSettings()).getCompactionReserveTokens(model)});pi.on('session_start',(_e,ctx)=>{context=ctx;});
 }]});
 const sourceFiles=['apps/desktop/src-tauri/pi/router.mjs','apps/desktop/src-tauri/pi/native-codex.mjs','apps/desktop/src-tauri/pi/agent-executor.mjs','scripts/goal-delivery-acceptance.mjs'];
 const head=await runProcess('git',['rev-parse','HEAD'],{cwd:repository}),diff=await runProcess('git',['diff','--binary'],{cwd:repository,maxBytes:8*1024*1024});assert.equal(head.code,0);assert.equal(diff.code,0);
 const report={version:1,billing:'subscription',fixtureRoot:root,roles:flags,source:{commit:head.stdout.trim(),diffHash:hash(Buffer.from(diff.stdout)),files:Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,hash(await readFile(join(repository,p)))])))},command:[process.execPath,...process.argv.slice(1)],phases,jobs};
 const save=()=>writeFile(receiptPath,JSON.stringify(report,null,2)+'\n');
 const phase=async(name,prompt)=>{const start=performance.now();console.log('goal delivery: '+name);await session.prompt(prompt);const receipt=manager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='yam.native-codex.v1')?.data;phases.push({name,elapsedMs:Math.round(performance.now()-start),route:routing.snapshot().decision,receipt});await save();return receipt;};
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);const manager=SessionManager.create(root,join(root,'pi-sessions'));
 try{
  ({session}=await createAgentSession({cwd:root,agentDir:join(root,'pi-agent'),settingsManager,sessionManager:manager,resourceLoader:loader,thinkingLevel:'off',model:{provider:'yam',id:'auto',api:'pi-virtual',reasoning:true,input:['text','image'],contextWindow:500000,maxTokens:16000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}},tools:['read','bash','edit','write']}));await session.bindExtensions({});
  if(!cancelOnly){
  await phase('simple','新任务：把“ hello   world ”整理为大写HELLO WORLD，只回复整理结果。不读写文件，不用工具，不调用其他Agent。');assert.equal(phases.at(-1).route.selected.model,'small');
  report.simpleEvidence=checkReadonlyReply(session.messages.findLast(m=>m.role==='assistant'),jobs.at(-1));report.simple={mode:'readonly',model:report.simpleEvidence.model};await save();
  report.development=await phase('development','新任务：在当前隔离目录test first实现normalize-title.mjs及normalize-title.test.mjs。导出normalizeTitle：trim并把连续空白合成单个空格；非字符串抛TypeError；全空白抛RangeError；长度超过80个Unicode码点抛RangeError。测试正常、中文/emoji边界和非法输入，用node --test运行。为这次Unicode边界独立审查调用配置中的低档gpt-6-luna原生子Agent（fork_turns=none,reasoning_effort=low），子Agent只读检查，主模型必须等待结果，修正确认问题、再次运行测试后交付。不画图，不启动GUI，不安装或调用外部Agent CLI。');assert.equal(report.development?.status,'completed');assert.equal(phases.at(-1).route.selected.model,'medium');
  report.developmentEvidence=await nativeFamily(report.development.sessionId);verifyTraceFamily(report.developmentEvidence.main,report.developmentEvidence.children,{main:'gpt-6.1-sol',helper:'gpt-6-luna'});
  const test=await runProcess(process.execPath,['--test','normalize-title.test.mjs'],{cwd:root,env:{...process.env,NODE_TEST_CONTEXT:undefined},timeoutMs:15000});assert.equal(test.code,0,test.stdout+test.stderr);report.codeTests={exitCode:test.code,stdout:test.stdout};report.independentCode=await checkIndependentCode(root);
  report.prd=await phase('prd','新任务：完成虚构Flowboard的中文PRD-v1.md，单用户本地任务看板，无登录/计费，标题必填且最多80字符，写至少6项AC-01格式的可测试验收条件。使用你的imagegen Skill及原生图像工具生成真实横向UI图，深蓝Flowboard侧栏，TO DO/IN PROGRESS/DONE三列，各一张Plan/Build/Ship卡片，右上蓝色New task按钮。保存真实PNG/WebP并用项目相对路径嵌入PRD，读取检查图像。不要SVG、占位图、API或绘图代码。报告PRD和图片实际路径。');assert.equal(report.prd?.status,'completed');
  report.prdV1=await checkGoalArtifacts(root,'PRD-v1.md',decode);
  report.edit=await phase('image-edit','继续刚才同一个Flowboard任务。读取PRD-v1.md和它引用的真实原图，将原图作为native image_gen实际edit输入，仅把蓝色New task按钮改成绿色Add task，保留Flowboard、三列标签和Plan/Build/Ship卡片。保存新图和PRD-v2.md更新对应说明/验收，并使用项目相对图片引用；读取检查。原PRD-v1.md和原图逐字节保留。不从头重绘，不用绘图代码/API，不派无必要的帮手。');assert.equal(report.edit?.status,'completed');assert.equal(report.edit.sessionId,report.prd.sessionId);report.prdV2=await checkGoalArtifacts(root,'PRD-v2.md',decode);
  assert.equal(hash(await readFile(join(root,'PRD-v1.md'))),report.prdV1.documentHash);assert.equal(hash(await readFile(join(root,report.prdV1.image))),report.prdV1.imageHash);report.imageEvidence=await nativeFamily(report.prd.sessionId);assert.ok(report.imageEvidence.main.imageCalls.length>=2);report.imageProvenance=await verifyImageProvenance(root,report.prdV1,report.prdV2,report.imageEvidence.main,{children:report.imageEvidence.children});
  }
  // Cancel only after a native child has a live local process; an immediate parent-start abort is insufficient.
  let stopped=false;const heartbeat=join(root,'heartbeat.json');await rm(heartbeat,{force:true});await rm(heartbeat+'.tmp',{force:true});const initialSessionFiles=await realpath(manager.getSessionFile()).then(()=>[manager.getSessionFile()],error=>{if(error.code==='ENOENT')return [];throw error;}),beforeCancel=await snapshotBusiness(root,initialSessionFiles);cancelWatch=setInterval(()=>{void (async()=>{if(stopped)return;try{const data=JSON.parse(await readFile(heartbeat,'utf8'));if(Number.isInteger(data.pid)&&Number.isInteger(data.pgid)&&data.tick>=2){const native=jobs.findLast(j=>j.mode==='task')?.process;if(!native)return;const rows=await processTable(),live=rows.find(p=>p.pid===data.pid);assert.equal(live?.pgid,data.pgid,'Heartbeat PID/group mismatch');const ancestors=[];let current=live;while(current&&!ancestors.includes(current.pid)){ancestors.push(current.pid);if(current.pid===native.pid)break;current=rows.find(p=>p.pid===current.ppid);}assert.ok(ancestors.includes(native.pid),'Heartbeat is not a descendant of the owned native CLI');report.heartbeatAncestors=ancestors;stopped=true;clearInterval(cancelWatch);report.heartbeat=data;report.cancelOwnedProcess=native;await session.abort();}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)){report.cancelWatchError=String(error.message);stopped=true;clearInterval(cancelWatch);await session.abort();}}})();},200);
  report.cancel=await phase('active-child-cancel',`新任务：这是已授权的取消回归fixture，只在隔离目录操作。请调用配置低档gpt-6-luna原生子Agent（fork_turns=none,reasoning_effort=low），让它用本地python3启动前台heartbeat循环：每0.2秒原子写heartbeat.json，JSON字段pid=os.getpid(),pgid=os.getpgrp(),tick从0递增。不得detached/new-session，不得进一步委派，不读写其他业务文件。此循环需保持运行等待外部取消。主模型等待这个子Agent，不要自行写heartbeat或正常完成任务。`);assert.ok(['failed','running'].includes(report.cancel?.status),'Cancelled work must not be completed');assert.ok(report.heartbeat,report.cancelWatchError??'Cancellation happened without an active child');assert.equal(session.isStreaming,false);
  const before=await readFile(heartbeat,'utf8');await new Promise(r=>setTimeout(r,1200));assert.equal(await readFile(heartbeat,'utf8'),before,'Heartbeat survived cancellation');await waitFor(()=>{try{process.kill(-report.heartbeat.pgid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}},5000);
  report.cancelEvidence=await nativeFamily(report.cancel.sessionId);verifyTraceFamily(report.cancelEvidence.main,report.cancelEvidence.children,{main:'gpt-6.1-sol',helper:'gpt-6-luna'});
  const snapshot=await snapshotBusiness(root,[manager.getSessionFile()]),count=jobs.length;bridge.beginTurn(context);const blocked=await bridge.stream(context.modelRegistry.find('yam-codex','gpt-6.1-sol'),{messages:[{role:'user',content:'do not replay'}],tools:[{name:'read'}]},{reasoning:'high'}).result();assert.equal(blocked.stopReason,'error');assert.equal(jobs.length,count);assert.deepEqual(await snapshotBusiness(root,[manager.getSessionFile()]),snapshot);const afterCancel=await snapshotBusiness(root,[manager.getSessionFile()]);delete afterCancel['heartbeat.json'];delete afterCancel['heartbeat.json.tmp'];assert.deepEqual(afterCancel,beforeCancel,'Cancellation changed business artifacts');report.cancelChecks={...await checkCancellationEvidence(report),businessArtifactsUnchanged:true};
  if(!cancelOnly){const destination=join(dirname(receiptPath),'artifacts');await mkdir(destination,{recursive:true});for(const path of ['normalize-title.mjs','normalize-title.test.mjs','PRD-v1.md','PRD-v2.md',report.prdV1.image,report.prdV2.image]){const local=await relativeArtifact(root,join(root,path)),target=join(destination,local);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,path),target);}}report.passed=true;await save();return report;
 }catch(error){report.error=String(error.stack);report.snapshot=routing?.snapshot();await save();throw Error(error.message+'; evidence: '+receiptPath+'; fixture: '+root);}finally{clearInterval(cancelWatch);session?.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--verify-only'){assert.ok(process.argv[3]&&process.argv[4],'Saved success and cancellation receipts required');console.log(JSON.stringify(await verifySavedGoalDelivery(resolve(process.argv[3]),resolve(process.argv[4])),null,2));}else{
 assert.ok(['--run-native','--run-cancel'].includes(process.argv[2]),'Real subscription calls require explicit --run-native or --run-cancel');if(process.argv[2]==='--run-cancel')assert.ok(isAbsolute(process.argv[4]??''),'Cancellation verification requires the preserved fixture directory');const path=resolve(process.argv[3]??join(repository,'docs/plans/2026-11-06-goal-delivery/native-acceptance.json'));const start=performance.now();const result=await runGoalDelivery(path,{cancelOnly:process.argv[2]==='--run-cancel',fixtureRoot:process.argv[4]});console.log(JSON.stringify({passed:result.passed,receipt:path,elapsedMs:Math.round(performance.now()-start)}));
}
}
