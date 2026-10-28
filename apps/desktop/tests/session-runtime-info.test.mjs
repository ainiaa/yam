// Author: Jeff.Liu. Runtime facts must never be inferred from saved launch defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionRuntimeInfo} from '../src/session-runtime-info.ts';

test('native session facts are distinct from configured model and no arguments or credentials escape',()=>{
 const launch={adapter:'codex',extra_args:'-m actual -c model_reasoning_effort=xhigh --config token=do-not-show',provider:{id:'custom',model:'default-model',base_url:'http://127.0.0.1:3425',api_key_env:'TEST_KEY'}};
 const before=structuredClone(launch),facts=sessionRuntimeInfo(launch,{cli_path:'/usr/local/bin/codex',cli_version:'codex-cli 0.163.0',agent_session_id:'native-1',integration:'connected'});
 assert.equal(facts.executable,'/usr/local/bin/codex');assert.equal(facts.nativeSession,'native-1');assert.equal(facts.hooks,'Trusted callback received');assert.equal(facts.credentialSource,'TEST_KEY');assert.equal(facts.effectiveModel,'Not confirmed by the CLI');assert.equal(facts.reasoning,'Resolved by the official CLI from its arguments and configuration');
 assert.doesNotMatch(JSON.stringify(facts),/do-not-show|actual|xhigh/);assert.deepEqual(launch,before);
});
test('legacy history and malformed runtime facts remain unknown rather than substituted from current discovery',()=>{
 const facts=sessionRuntimeInfo(undefined,undefined);assert.equal(facts.executable,'Unknown');assert.equal(facts.nativeSession,'Unknown');assert.equal(facts.hooks,'Trusted hook integration unavailable');
 for(const value of ['',123,'a\nspoof','\u202espoof','x'.repeat(9000)]){
  const bad=sessionRuntimeInfo(null,{cli_path:value,agent_session_id:value,integration:'unavailable: secret=do-not-show'});
  assert.equal(bad.executable,'Unknown');assert.equal(bad.nativeSession,'Unknown');assert.doesNotMatch(JSON.stringify(bad),/do-not-show/);
 }
});
test('authentication source reports inheritance or local gateway placeholder without claiming auth succeeded',()=>{
 assert.equal(sessionRuntimeInfo({adapter:'claude'},{}).credentialSource,'Inherited CLI authentication');
 assert.equal(sessionRuntimeInfo({adapter:'codex',provider:{id:'custom',model:'m',base_url:'http://127.0.0.1:3425',api_key_env:null}},{}).credentialSource,'Local gateway placeholder');
 assert.equal(sessionRuntimeInfo({adapter:'codex',provider:{api_key_env:'value=secret'}},{}).credentialSource,'Unknown');
 assert.equal(sessionRuntimeInfo(null,{integration:'connecting'}).hooks,'Waiting for a trusted callback');
});

test('degraded integration does not deny a previous trusted native callback',()=>{
 const facts=sessionRuntimeInfo({adapter:'opencode'},{integration:'unavailable',agent_session_id:'previously-bound'});
 assert.equal(facts.hooks,'Trusted hook integration unavailable');assert.equal(facts.nativeSession,'previously-bound');
});

test('Pi diagnostics point to native routing state and do not mislabel a gateway as inherited authentication',()=>{const facts=sessionRuntimeInfo({adapter:'pi'},{integration:'connected'});assert.equal(facts.effectiveModel,'Reported in Pi routing status');assert.equal(facts.credentialSource,'Resolved by Pi for this session connection');});
