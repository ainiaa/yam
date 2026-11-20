// Author: Jeff.Liu
import test from 'node:test';import assert from 'node:assert/strict';
import {installDesktopBridge,desktopLaunch} from '../../../extensions/omp-chatgpt/desktop.mjs';
test('managed desktop launch uses only its owned session directory and explicit routing snapshot',()=>{
 const e={YAM_OMP_DESKTOP:'1',YAM_OMP_POLICY:'{}',YAM_OMP_SESSION_DIR:'/private/sessions',YAM_OMP_RESUME:'/private/sessions/a.jsonl'};
 assert.deepEqual(desktopLaunch(e),{policy:'{}',args:['--session-dir','/private/sessions','--resume','/private/sessions/a.jsonl']});assert.equal(desktopLaunch({}),null);assert.throws(()=>desktopLaunch({...e,YAM_OMP_SESSION_DIR:''}));
});
test('OMP lifecycle reports trusted native identity and turn boundaries without changing the model',async()=>{
 const handlers={},events=[],pi={on:(n,fn)=>handlers[n]=fn};installDesktopBridge(pi,{send:async e=>events.push(e)});
 const ctx={sessionManager:{getSessionId:()=> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}};await handlers.session_start({},ctx);await handlers.agent_start({},ctx);await handlers.tool_execution_end({},ctx);await handlers.agent_end({messages:[{role:'assistant',stopReason:'aborted'}]},ctx);
 assert.deepEqual(events.map(x=>x.kind),['SessionStart','UserPromptSubmit','ToolProgress','Interrupt']);assert.equal(events[0].agent_session_id,ctx.sessionManager.getSessionId());assert.equal(events[1].turn_id,events[3].turn_id);
});
test('managed OMP blocks native cross-file switching after initialization to preserve trusted history',async()=>{
 const handlers={},pi={on:(n,fn)=>handlers[n]=fn};installDesktopBridge(pi,{send:async()=>{}});const ctx={sessionManager:{getSessionId:()=> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},ui:{notify(){}}};
 assert.equal(handlers.session_before_switch?.({},ctx),undefined);await handlers.session_start({},ctx);
 for(const name of ['session_before_switch','session_before_branch'])assert.deepEqual(await handlers[name]({},ctx),{cancel:true});
});
test('actual managed launcher preserves a saved native model only when resuming with routing off',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 for(const mode of ['resume-off','resume-route','new-off']){
  const code=`
   import {mock} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {open} from 'node:fs/promises';
   const mode=${JSON.stringify(mode)};Object.assign(process.env,{YAM_OMP_AUTH_SOURCE:'pi',YAM_OMP_DESKTOP:'1',YAM_OMP_EXECUTABLE:'/fake/omp',YAM_OMP_SESSION_DIR:'/private/sessions',YAM_OMP_POLICY:mode==='resume-route'?'{}':''});
   delete process.env.YAM_OMP_RESUME;if(mode.startsWith('resume'))process.env.YAM_OMP_RESUME='/private/sessions/saved.jsonl';process.argv=['node','run'];
   mock.module('node:fs/promises',{namedExports:{access:async()=>{},open}});
   mock.module('node:child_process',{namedExports:{execFileSync:()=> 'proxy',spawn:(file,args)=>{
    if(mode==='resume-off')assert.equal(args.includes('--model'),false);else assert.equal(args[args.indexOf('--model')+1],mode==='resume-route'?'yam/auto':'yam-chatgpt/gpt-6-luna');
    assert.equal(args.includes('--resume'),mode.startsWith('resume'));const child=new EventEmitter();child.kill=()=>{};setImmediate(()=>child.emit('exit',0));console.log('managed-model-ok');return child;
   }}});
   mock.module(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/runtime.mjs',import.meta.url).href)},{namedExports:{yamAuthDirectory:()=>'/fake-yam-auth',createYamSubprocessCredentialReader:()=>{throw Error('YAM reader must not run in Pi backup fixture');},findPiPackage:async()=>'/fake-pi',parseSystemProxy:()=> 'http://localhost:7897',launchEnvironment:e=>({...e})}});
   await import(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/run.mjs',import.meta.url).href)});
  `;
  assert.match((await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code])).stdout,/managed-model-ok/);
 }
});
