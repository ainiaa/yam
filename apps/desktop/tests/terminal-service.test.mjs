import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

async function fixture(run){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../terminal-service.cjs',import.meta.url))],{env:{...process.env,YAM_TERMINAL_INSTANCE:'d'.repeat(64)},stdio:['pipe','pipe','pipe']});
 const pending=new Map(),inputs=[];let sequence=0,stderr='';child.stderr.on('data',b=>stderr+=b);
 let ready;const greeting=new Promise((resolve,reject)=>{ready=resolve;child.once('exit',code=>{if(code)reject(Error('service exited '+code+': '+stderr));});});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);if(value.type==='ready')ready(value);else if(value.type==='input')inputs.push(value);else{pending.get(value.id)?.(value);pending.delete(value.id);}});
 const call=request=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('service request timeout'));},3000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({id,...request})+'\n');});
 try{await run({call,greeting,inputs,child});}finally{lines.close();child.kill();await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));}
}
const data=bytes=>Buffer.from(bytes).toString('base64');

test('persistent native parser preserves split UTF-8, CSI, alternate screen, query output and viewport across snapshots',async()=>fixture(async({call,greeting,inputs})=>{
 assert.deepEqual(await greeting,{type:'ready',version:1,instance:'d'.repeat(64),terminal_version:'6.0.0',serialize_version:'0.14.0'});
 assert.equal((await call({op:'create',session:'one',cols:20,rows:8})).ok,true);
 await call({op:'write',session:'one',data:data([0xe4,0xb8])});
 let frame=(await call({op:'snapshot',session:'one'})).data;assert.equal(frame.revision,1);assert.ok(!frame.data.includes('�'));
 await call({op:'write',session:'one',data:data([0xad])});
 await call({op:'write',session:'one',data:data('\x1b[31')});
 await call({op:'write',session:'one',data:data('mRED\x1b[6n')});
 frame=(await call({op:'snapshot',session:'one'})).data;assert.ok(frame.data.includes('中'));assert.ok(frame.data.includes('RED'));assert.equal(frame.revision,4);assert.equal(frame.instance,'d'.repeat(64));assert.ok(inputs.some(e=>e.session==='one'&&e.data.includes('R')));
 await call({op:'write',session:'one',data:data('\x1b[?1049hALT\x1b[?1003h\x1b[?1006h')});
 frame=(await call({op:'snapshot',session:'one'})).data;assert.ok(frame.data.includes('ALT'));assert.equal(frame.buffer,'alternate');assert.ok(frame.data.includes('\x1b[?1006h'));
 await call({op:'resize',session:'one',cols:30,rows:10});frame=(await call({op:'snapshot',session:'one'})).data;assert.equal(frame.cols,30);assert.equal(frame.rows,10);
 await call({op:'write',session:'one',data:data('\x1b[?1049l'+('line\r\n'.repeat(40)))});
 await call({op:'viewport',session:'one',line:5});frame=(await call({op:'snapshot',session:'one'})).data;assert.equal(frame.viewport,5);
 assert.equal((await call({op:'close',session:'one'})).ok,true);assert.equal((await call({op:'snapshot',session:'one'})).ok,false);
}));

test('invalid frames and dimensions fail without altering a valid session or exposing request content',async()=>fixture(async({call,greeting})=>{
 await greeting;await call({op:'create',session:'good',cols:20,rows:8});
 for(const request of [{op:'create',session:'bad',cols:0,rows:8},{op:'create',session:'bad',cols:501,rows:8},{op:'create',session:'bad',cols:20,rows:201},{op:'create',session:'../private',cols:20,rows:8},{op:'write',session:'good',data:'private-invalid-base64!'},{op:'write',session:'missing',data:data('test')},{op:'resize',session:'good',cols:1.5,rows:8},{op:'snapshot',session:'good',unexpected:'private'},{op:'execute',session:'good',command:'private'}]){
  const value=await call(request);assert.equal(value.ok,false);assert.ok(!JSON.stringify(value).includes('private'));
 }
 const frame=(await call({op:'snapshot',session:'good'})).data;assert.equal(frame.revision,0);assert.equal(frame.cols,20);
 assert.equal((await call({op:'create',session:'good',cols:20,rows:8})).ok,false);
}));


test('aggregate parser budget rejects growth without changing existing dimensions',async()=>fixture(async({call,greeting})=>{
 await greeting;
 for(let index=0;index<16;index++)assert.equal((await call({op:'create',session:'s'+index,cols:100,rows:40})).ok,true);
 assert.equal((await call({op:'resize',session:'s0',cols:500,rows:200})).ok,false);
 const frame=(await call({op:'snapshot',session:'s0'})).data;assert.equal(frame.cols,100);assert.equal(frame.revision,0);
 assert.equal((await call({op:'create',session:'too_large',cols:500,rows:200})).ok,false);
 await call({op:'close',session:'s0'});assert.equal((await call({op:'create',session:'replacement',cols:100,rows:40})).ok,true);
}));
