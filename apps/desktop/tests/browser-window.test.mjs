// Author: Jeff.Liu. Actual controller with fake native invoke; no browser or remote request.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {BrowserControls} from '../src/browser-window.ts';
const snapshot=(generation=1,phase='open',url='https://example.test/')=>({generation,phase,url,loading:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('C01a controller opens once with captured generation then Show Reload Close exact commands',async()=>{
 const c=new BrowserControls(),calls=[];const invoke=async(name,args)=>{calls.push([name,args]);return snapshot();};
 await c.action('open','https://example.test/',invoke);assert.deepEqual(calls,[['browser_open',{url:'https://example.test/',expected_generation:0}]]);assert.equal(c.snapshot.generation,1);
 for(const action of ['show','reload','close'])await c.action(action,'ignored draft',invoke);
 assert.deepEqual(calls.slice(1),['show','reload','close'].map(action=>[`browser_${action}`,{expected_generation:1}]));
});
test('C01a controller serializes busy preserves draft errors and accepts only exact responses',async()=>{
 const c=new BrowserControls(),d=deferred(),calls=[];const pending=c.action('open','https://example.test/',async(...args)=>{calls.push(args);return d.promise;});
 assert.equal(c.busy,true);await c.action('open','https://second.test/',async()=>assert.fail('duplicate invoke'));assert.equal(calls.length,1);
 d.reject('raw URL secret query');await pending;assert.equal(c.busy,false);assert.equal(c.error,'browser_unavailable');assert.equal(c.snapshot.phase,'closed');
 await c.read(async()=>snapshot());assert.equal(c.snapshot.generation,1);await c.read(async()=>({...snapshot(),generation:-1}));assert.equal(c.error,'browser_response_invalid');assert.equal(c.snapshot.generation,1);
 let getter=0;await c.read(async()=>({...snapshot(),get generation(){getter++;return 2;}}));assert.equal(getter,0);assert.equal(c.snapshot.generation,1);
});
test('C01a controller URL empty credentials controls protocol and bytes reject without invoke',async()=>{
 for(const value of ['', 'file:///tmp/a','javascript:1','https://u:p@example.test/','https://@example.test/','https://example.test/\n',`https://example.test/${'é'.repeat(2100)}`]){
  const c=new BrowserControls();await c.action('open',value,async()=>assert.fail('invalid URL must not invoke'));assert.equal(c.error,'browser_url_invalid');
 }
});
test('C01a disposed and stale responses do not replace current state or retry native operations',async()=>{
 const c=new BrowserControls(),d=deferred();let calls=0;const pending=c.read(async()=>{calls++;return d.promise;});c.dispose();d.resolve(snapshot());await pending;
 assert.equal(c.snapshot.phase,'closed');assert.equal(calls,1);await c.action('open','https://example.test/',async()=>assert.fail('disposed'));
 c.activate();await c.read(async()=>snapshot(2));assert.equal(c.snapshot.generation,2);
 await c.action('reload','',async()=>{throw 'browser_stale';});assert.equal(c.error,'browser_stale');assert.equal(c.snapshot.generation,2);
});
