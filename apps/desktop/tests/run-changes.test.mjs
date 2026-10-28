// Author: Jeff.Liu. Baseline controls never mutate project files or start a CLI.
import test from 'node:test';import assert from 'node:assert/strict';
import {RunChangesController} from '../src/run-changes.ts';
const info={id:'base-one',root:'/repo',captured_at:1,files:1,skipped:0};
const report={baseline:info,skipped:0,rows:[{path:'a.txt',kind:'modified'}],patch:null};
test('explicit capture, comparison and replacement use the original session and exact baseline token',async()=>{
 const c=new RunChangesController(),calls=[];c.select('session-one','/repo');
 const invoke=async(name,args)=>{calls.push([name,args]);return name==='get_run_baseline_info'?null:name==='capture_run_baseline'?info:name==='clear_run_baseline'?null:report;};
 await c.load(invoke);assert.equal(c.baseline,null);assert.deepEqual(calls.map(([n])=>n),['get_run_baseline_info']);
 await c.capture(invoke);await c.compare(invoke);assert.equal(c.report.rows[0].path,'a.txt');
 assert.deepEqual(calls.at(-1),['compare_run_baseline',{session_id:'session-one',baseline_id:'base-one',path:null}]);
 await c.capture(invoke);assert.equal(calls.at(-1)[1].expected_id,'base-one');await c.clear(invoke);assert.equal(c.baseline,null);assert.equal(c.report,null);
 assert.equal(calls.some(([n])=>/write|save|start_session|git.*stage/.test(n)),false);
});
test('capture failure keeps the existing baseline and hides unknown backend errors',async()=>{
 const c=new RunChangesController();c.select('s','/repo');await c.load(async()=>info);
 await c.capture(async()=>{throw 'round_limit';});assert.equal(c.error,'round_limit');assert.equal(c.baseline.id,'base-one');
 await c.compare(async()=>{throw 'secret=do-not-show';});assert.equal(c.error,'round_unavailable');
});
test('late responses cannot move a comparison or baseline into another selected session',async()=>{
 const c=new RunChangesController();c.select('first','/repo');await c.load(async()=>info);
 let finish;const pending=c.compare(()=>new Promise(r=>finish=r));c.select('second','/another');
 const next={...info,id:'base-two',root:'/another'};await c.load(async()=>next);finish(report);await pending;
 assert.equal(c.baseline.id,'base-two');assert.equal(c.report,null);assert.equal(c.busy,false);
});
test('invalid or oversized IPC data cannot be rendered as a trusted comparison',async()=>{
 for(const value of [{...info,files:-1},{...info,root:'bad\nroot'},{...info,unexpected:true}]){
  const c=new RunChangesController();c.select('s','/repo');await c.load(async()=>value);assert.equal(c.error,'round_invalid_response');assert.equal(c.baseline,null);
 }
 for(const value of [{...report,baseline:{...info,id:'different'}},{...report,rows:[{path:'../secret',kind:'modified'}]},{...report,patch:{path:'a.txt',text:'x'.repeat(262145)}}]){
  const c=new RunChangesController();c.select('s','/repo');await c.load(async()=>info);await c.compare(async()=>value,value.patch?'a.txt':null);assert.equal(c.error,'round_invalid_response');assert.equal(c.report,null);
 }
});

test('selected patch accepts equivalent baseline metadata regardless of JSON property order',async()=>{
 const c=new RunChangesController();c.select('s','/repo');await c.load(async()=>info);
 const reordered={skipped:0,files:1,captured_at:1,root:'/repo',id:'base-one'};
 await c.compare(async()=>({...report,baseline:reordered,patch:{path:'a.txt',text:'@@ -1 +1 @@\n-old\n+new\n'}}),'a.txt');
 assert.equal(c.error,null);assert.match(c.report.patch.text,/\+new/);
});
