import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryLabel, startMemoryPolling} from '../src/memory.ts';

test('memory label separates application/workloads and refuses incomplete or invalid totals',()=>{
 const sample={application_bytes:104857600,workload_bytes:52428800,metric:'physical footprint',sampled_at:1000};
 assert.equal(memoryLabel(sample,2000),'YAM 100.0 MiB · Tasks 50.0 MiB');
 assert.equal(memoryLabel({...sample,workload_bytes:0},2000),'YAM 100.0 MiB');
 for(const value of [null,{...sample,application_bytes:null},{...sample,application_bytes:-1},{...sample,workload_bytes:NaN},{...sample,metric:'unknown'},{...sample,sampled_at:3000}]) assert.equal(memoryLabel(value,2000),'Memory unavailable');
 assert.equal(memoryLabel(sample,12000),'Memory unavailable');
});

test('polling avoids overlap, clears stale/hidden samples, handles rejection, and disposes pending updates',async()=>{
 let tick,now=1000,visible=true,calls=0,resolve,reject;const values=[];
 const clock={now:()=>now,setInterval:fn=>{tick=fn;return 1;},clearInterval:id=>assert.equal(id,1),setTimeout:()=>2,clearTimeout:()=>{}};
 const stop=startMemoryPolling(()=>{calls++;return new Promise((ok,no)=>{resolve=ok;reject=no;});},v=>values.push(v),()=>visible,clock);
 tick();assert.equal(calls,1);
 resolve({application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:now});await new Promise(setImmediate);assert.equal(values.at(-1).application_bytes,1);
 tick();assert.equal(calls,2);now=12001;tick();assert.equal(values.at(-1),null);assert.equal(calls,2);
 reject(new Error('denied'));await new Promise(setImmediate);assert.equal(values.at(-1),null);
 visible=false;tick();assert.equal(calls,2);visible=true;tick();assert.equal(calls,3);
 stop();const count=values.length;resolve({application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:now});await new Promise(setImmediate);assert.equal(values.length,count);tick();assert.equal(calls,3);
});

test('a hung refresh expires the displayed total without waiting for the next polling boundary',async()=>{
 let now=100,tick,expire,delay,call=0;const values=[];
 const sample={application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:100};
 const clock={now:()=>now,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout:(fn,ms)=>{expire=fn;delay=ms;return 2;},clearTimeout:()=>{}};
 const stop=startMemoryPolling(()=>++call===1?Promise.resolve(sample):new Promise(()=>{}),v=>values.push(v),()=>true,clock);
 await new Promise(setImmediate);assert.equal(values.at(-1),sample);assert.equal(delay,10001);
 now=5000;tick();now=10000;tick();assert.equal(values.at(-1),sample);
 now=10101;expire();assert.equal(values.at(-1),null);assert.equal(call,2);stop();
});
