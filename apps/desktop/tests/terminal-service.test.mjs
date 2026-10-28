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

test('restored terminal output is text only and cannot send old queries to the new shell',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'restore',cols:40,rows:8});
 const restored=await call({op:'restore',session:'restore',data:data('旧输出\r\n\x1b]7;file:///untrusted\x07\x1b[6n\x1b[?1003hLAST')});
 assert.equal(restored.ok,true);assert.ok(restored.data.text.includes('旧输出'));assert.ok(restored.data.text.includes('LAST'));
 assert.ok(!restored.data.text.includes('\x1b'));assert.deepEqual(inputs,[]);
 let frame=(await call({op:'snapshot',session:'restore'})).data;
 assert.equal(frame.buffer,'normal');assert.equal(frame.cwd_report.uri,null);assert.equal(frame.command_report.phase,'unknown');
 assert.equal((await call({op:'restore',session:'restore',data:data('duplicate')})).ok,false);
 await call({op:'write',session:'restore',data:data('NEW PROMPT\x1b[6n')});
 frame=(await call({op:'snapshot',session:'restore'})).data;assert.ok(frame.data.includes('旧输出'));assert.ok(frame.data.includes('NEW PROMPT'));assert.equal(inputs.length,1);
}));

test('history restoration streams the full retained log without leaking queries or inheriting old modes',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'stream-restore',cols:40,rows:8});
 const output=Buffer.from('FIRST RETAINED\r\n\x1b]0;'+('x'.repeat(600000))+'\x07LAST RETAINED\x1b[6n');
 for(let start=0;start<output.length;start+=256*1024){const reply=await call({op:'restore',session:'stream-restore',data:output.subarray(start,start+256*1024).toString('base64'),final:false});assert.equal(reply.ok,true);assert.equal(reply.data,null);}
 assert.equal((await call({op:'write',session:'stream-restore',data:data('too early')})).ok,false);
 const reply=await call({op:'restore',session:'stream-restore',data:'',final:true});assert.equal(reply.ok,true);assert.match(reply.data.text,/FIRST RETAINED/);assert.match(reply.data.text,/LAST RETAINED/);assert.deepEqual(inputs,[]);
 const before=(await call({op:'snapshot',session:'stream-restore'})).data;
 assert.equal((await call({op:'restore',session:'stream-restore',data:'',final:'yes'})).ok,false);
 assert.deepEqual((await call({op:'snapshot',session:'stream-restore'})).data,before);
}));

test('isolated history parsers share the aggregate terminal memory budget',async()=>fixture(async({call,greeting})=>{
 await greeting;for(const session of ['one','two','three'])assert.equal((await call({op:'create',session,cols:500,rows:200})).ok,true);
 assert.equal((await call({op:'restore',session:'one',data:data('old'),final:false})).ok,false);
 assert.equal((await call({op:'close',session:'three'})).ok,true);
 assert.equal((await call({op:'restore',session:'one',data:data('old'),final:false})).ok,true);
 assert.equal((await call({op:'create',session:'three',cols:500,rows:200})).ok,false);
 assert.equal((await call({op:'restore',session:'one',data:'',final:true})).ok,true);
 assert.equal((await call({op:'create',session:'three',cols:500,rows:200})).ok,true);
}));

test('persistent native parser preserves split UTF-8, CSI, alternate screen, query output and viewport across snapshots',async()=>fixture(async({call,greeting,inputs})=>{
 assert.deepEqual(await greeting,{type:'ready',version:1,instance:'d'.repeat(64),terminal_version:'6.0.0',serialize_version:'0.14.0',node_version:process.versions.node,node_arch:process.arch,node_platform:process.platform});
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

test('A05 bottom intent resolves owner current base after intervening output and preserves absolute callers',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'scroll',cols:20,rows:3});await call({op:'write',session:'scroll',data:data('L0\r\nL1\r\nL2\r\nL3\r\nL4\r\n')});
 await call({op:'viewport',session:'scroll',line:1});const before=(await call({op:'snapshot',session:'scroll'})).data;assert.equal(before.viewport,1);
 await call({op:'write',session:'scroll',data:data('L5\r\nL6\r\n')});assert.equal((await call({op:'snapshot',session:'scroll'})).data.viewport,1);
 const result=await call({op:'viewport',session:'scroll',line:0,bottom:true});assert.equal(result.ok,true);assert.equal(result.data,null);const live=(await call({op:'snapshot',session:'scroll'})).data;assert.ok(live.viewport>before.viewport);
 await call({op:'write',session:'scroll',data:data('L7\r\n')});assert.equal((await call({op:'snapshot',session:'scroll'})).data.viewport,live.viewport+1);
 await call({op:'viewport',session:'scroll',line:2,bottom:false});assert.equal((await call({op:'snapshot',session:'scroll'})).data.viewport,2);const stable=(await call({op:'snapshot',session:'scroll'})).data;
 for(const extra of [{bottom:'true'},{bottom:null},{bottom:1},{bottom:true,line:-1},{bottom:true,line:4294967296},{line:999999},{bottom:true,data:'input'}])assert.equal((await call({op:'viewport',session:'scroll',line:0,...extra})).ok,false);
 assert.deepEqual((await call({op:'snapshot',session:'scroll'})).data,stable);assert.deepEqual(inputs,[]);
}));

test('A07a actual OSC7 fragmented BEL/ST snapshots isolate sessions and clear oversized latest reports',async()=>fixture(async({call,greeting})=>{
 await greeting;for(const session of ['cwd-one','cwd-two'])await call({op:'create',session,cols:20,rows:8});
 const put=async(s,value)=>{assert.equal((await call({op:'write',session:s,data:data(value)})).ok,true);};
 const snap=async(s)=>(await call({op:'snapshot',session:s})).data;
 await put('cwd-one','\x1b]7;file://localhost/tmp/');assert.equal((await snap('cwd-one')).cwd_report?.uri??null,null);
 await put('cwd-one',[0xe4,0xb8]);await put('cwd-one',[0xad]);await put('cwd-one','\x07');
 assert.deepEqual((await snap('cwd-one')).cwd_report,{uri:'file://localhost/tmp/中',sequence:1});
 assert.equal((await snap('cwd-two')).cwd_report?.uri??null,null);
 await put('cwd-two','\x1b]7;file:///second\x1b');await put('cwd-two','\\');assert.deepEqual((await snap('cwd-two')).cwd_report,{uri:'file:///second',sequence:1});
 await put('cwd-one','\x1b]7;'+('é'.repeat(2049))+'\x07');assert.deepEqual((await snap('cwd-one')).cwd_report,{uri:null,sequence:2});
 assert.equal((await snap('cwd-two')).cwd_report.uri,'file:///second');
 await call({op:'close',session:'cwd-one'});await call({op:'create',session:'cwd-one',cols:20,rows:8});assert.equal((await snap('cwd-one')).cwd_report?.uri??null,null);
}));

test('A07a report acceptance UTF8 boundary and saturating sequence stay metadata-only',async()=>{
 const {nextCwdReport}=await import('../terminal-service.cjs');
 const uri='file:///'+('é'.repeat(2044));assert.equal(Buffer.byteLength(uri),4096);
 assert.deepEqual(nextCwdReport({uri:null,sequence:0},uri),{uri,sequence:1});
 assert.deepEqual(nextCwdReport({uri,sequence:1},uri+'x'),{uri:null,sequence:2});
 assert.deepEqual(nextCwdReport({uri,sequence:Number.MAX_SAFE_INTEGER-1},'file:///latest'),{uri:null,sequence:Number.MAX_SAFE_INTEGER});
 assert.deepEqual(nextCwdReport({uri:null,sequence:Number.MAX_SAFE_INTEGER},'file:///again'),{uri:null,sequence:Number.MAX_SAFE_INTEGER});
});

for(const retained of [200,500,2000,null,undefined])test('A05a3 actual parser captures retention '+retained,async()=>fixture(async({call})=>{
 const request={op:'create',session:'retention',cols:20,rows:8};if(retained!==undefined)request.retained_lines=retained;const created=await call(request);assert.equal(created.ok,true);const effective=retained??2000;
 await call({op:'write',session:'retention',data:Buffer.from('row\r\n'.repeat(2200)).toString('base64')});let f=(await call({op:'snapshot',session:'retention'})).data;assert.equal(f.retained_lines,effective);assert.equal(f.viewport,effective);
 assert.equal((await call({op:'resize',session:'retention',cols:21,rows:9})).ok,true);f=(await call({op:'snapshot',session:'retention'})).data;assert.equal(f.retained_lines,effective);await call({op:'write',session:'retention',data:Buffer.from('\x1b[?1049hALT').toString('base64')});assert.equal((await call({op:'snapshot',session:'retention'})).data.retained_lines,effective);assert.equal((await call({op:'close',session:'retention'})).ok,true);
}));
test('A05a3 parser invalid retained values reject without creating entry',async()=>fixture(async({call})=>{for(const retained_lines of [199,2001,1.5,'500',true,{}]){assert.equal((await call({op:'create',session:'invalid',cols:20,rows:8,retained_lines})).ok,false);assert.equal((await call({op:'snapshot',session:'invalid'})).ok,false);}assert.equal((await call({op:'create',session:'invalid',cols:20,rows:8})).ok,true);}));

test('A05a3 smaller capacity never buys parser cells admission',async()=>fixture(async({call,greeting})=>{
 await greeting;for(let i=0;i<3;i++)assert.equal((await call({op:'create',session:'small-'+i,cols:500,rows:200,retained_lines:200})).ok,true);assert.equal((await call({op:'create',session:'fourth',cols:500,rows:200,retained_lines:200})).ok,false);await call({op:'close',session:'small-0'});assert.equal((await call({op:'create',session:'replacement',cols:500,rows:200,retained_lines:200})).ok,true);
}));


test('A07c1 actual parser reports fragmented OSC133 normal lifecycle without input or scene changes',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'command',cols:20,rows:8});
 const snapshot=async()=> (await call({op:'snapshot',session:'command'})).data;
 const originalScene=(await snapshot()).data;assert.deepEqual((await snapshot()).command_report,{sequence:0,phase:'unknown',last_exit:null});
 for(const [bytes,phase,code] of [['A','prompt',null],['B','input',null],['C','running',null],['D;255','complete',255],['A','prompt',255],['C','running',null],['D','complete',null]]){
  for(const byte of Buffer.from('\x1b]133;'+bytes+'\x1b\\'))await call({op:'write',session:'command',data:data([byte])});
  const f=await snapshot();assert.equal(f.command_report.phase,phase);assert.equal(f.command_report.last_exit,code);assert.equal(f.data,originalScene);
 }
 const before=(await snapshot()).command_report;await call({op:'write',session:'command',data:data('\x1b]133;D\x07')});assert.deepEqual((await snapshot()).command_report,before);assert.deepEqual(inputs,[]);
 await call({op:'create',session:'other',cols:20,rows:8});assert.equal((await call({op:'snapshot',session:'other'})).data.command_report.phase,'unknown');
}));

test('A07c1 invalid reports clear state and public reset/alternate observers preserve built-in terminal behavior',async()=>fixture(async({call,greeting})=>{
 await greeting;await call({op:'create',session:'command',cols:20,rows:8});
 const write=async text=>call({op:'write',session:'command',data:data(text)});const report=async()=> (await call({op:'snapshot',session:'command'})).data.command_report;
 const osc=text=>'\x1b]133;'+text+'\x07';
 for(const bad of ['B','D;01','D;256','D;-1','D;0;extra','A;extra','é','x'.repeat(33)]){
  await write(osc('C')+osc(bad));assert.deepEqual({...await report(),sequence:0},{sequence:0,phase:'unknown',last_exit:null},bad);
 }
 for(const reset of ['\x1bc','\x1b[2J','\x1b[3J','\x1b[?47h\x1b[?47l','\x1b[?1047h\x1b[?1047l','\x1b[?1049h\x1b[?1049l']){
  await write(osc('A')+reset);assert.equal((await report()).phase,'unknown',JSON.stringify(reset));
 }
 await write(osc('A')+'\x1b[H\x1b[31m');await call({op:'resize',session:'command',cols:30,rows:10});assert.equal((await report()).phase,'prompt');
 await write('\x1b[?1049h'+osc('C')+'ALT');assert.equal((await report()).phase,'unknown');assert.equal((await call({op:'snapshot',session:'command'})).data.buffer,'alternate');await write('\x1b[?1049l');assert.equal((await report()).phase,'unknown');
}));


test('A07c1 public observers fall through to installed baseline scenes and saturated reports stay unavailable',async()=>{
 const {default:headless}=await import('@xterm/headless');const {default:serialize}=await import('@xterm/addon-serialize');const {default:service}=await import('../terminal-service.cjs');
 await fixture(async({call,greeting})=>{
  await greeting;await call({op:'create',session:'compare',cols:20,rows:8});const term=new headless.Terminal({cols:20,rows:8,scrollback:2000,allowProposedApi:true}),addon=new serialize.SerializeAddon();term.loadAddon(addon);
  try{for(const bytes of ['TEXT\x1b]133;A\x07','\x1b[2J','MORE\x1b[3J','\x1b[?47;1003hALT\x1b[?47;1003l','\x1b[?1047;1003hALT\x1b[?1047;1003l','\x1b[?1049;1003hALT\x1b[?1049;1003l','\x1bc']){
   await new Promise(resolve=>term.write(bytes,resolve));await call({op:'write',session:'compare',data:data(bytes)});const frame=(await call({op:'snapshot',session:'compare'})).data;
   const scene=service.projection(term,addon);for(const key of Object.keys(scene))assert.deepEqual(frame[key],scene[key],key);
  }}finally{term.dispose();}
 });
 const max=Number.MAX_SAFE_INTEGER;let report=service.nextCommandReport({sequence:max-1,phase:'prompt',last_exit:7},'C');assert.deepEqual(report,{sequence:max,phase:'unknown',last_exit:null});for(const payload of ['A','C','D;0',null])assert.deepEqual(service.nextCommandReport(report,payload),report);
 const completed={sequence:5,phase:'complete',last_exit:0};assert.equal(service.nextCommandReport(completed,'D;0'),completed);assert.deepEqual(service.nextCommandReport(completed,'D;1'),{sequence:6,phase:'unknown',last_exit:null});
});


test('A07c3 actual public markers expose strict previous next and stale navigation without input',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'prompts',cols:20,rows:3});
 const put=async value=>call({op:'write',session:'prompts',data:data(value)});
 const snap=async()=>(await call({op:'snapshot',session:'prompts'})).data;
 assert.deepEqual((await snap()).prompt_navigation,{version:1,previous:false,next:false});
 await put('\x1b]133;A\x07p0\r\nL\r\n\x1b]133;A\x07p2\r\nL\r\nL\r\n');
 assert.deepEqual((await snap()).prompt_navigation,{version:1,previous:true,next:false});
 const nav=direction=>call({op:'navigate_prompt',session:'prompts',direction,expected_instance:'d'.repeat(64)});
 assert.deepEqual((await nav('previous')).data,{status:'moved'});assert.equal((await snap()).viewport,2);
 assert.deepEqual((await nav('previous')).data,{status:'moved'});assert.equal((await snap()).viewport,0);
 assert.deepEqual((await nav('previous')).data,{status:'unavailable'});
 assert.deepEqual((await nav('next')).data,{status:'moved'});assert.equal((await snap()).viewport,2);
 assert.deepEqual((await call({op:'navigate_prompt',session:'prompts',direction:'next',expected_instance:'e'.repeat(64)})).data,{status:'stale'});
 assert.equal((await call({op:'navigate_prompt',session:'prompts',direction:'other',expected_instance:'d'.repeat(64)})).ok,false);
 await put('\x1b[?1049h');assert.deepEqual((await nav('previous')).data,{status:'unavailable'});
 await put('\x1b[?1049l');assert.deepEqual((await snap()).prompt_navigation,{version:1,previous:false,next:false});assert.deepEqual(inputs,[]);
}));

test('A07c3 actual marker ring keeps only 100 distinct positions and clamps destinations',async()=>fixture(async({call,greeting,inputs})=>{
 await greeting;await call({op:'create',session:'ring',cols:20,rows:3});
 for(let i=0;i<101;i++)await call({op:'write',session:'ring',data:data('\x1b]133;A\x07\x1b]133;A\x07p'+i+'\r\n')});
 await call({op:'write',session:'ring',data:data('tail\r\n'.repeat(4))});
 let moved=0;while(moved<102){const reply=await call({op:'navigate_prompt',session:'ring',direction:'previous',expected_instance:'d'.repeat(64)});if(reply.data.status==='unavailable')break;assert.equal(reply.data.status,'moved');moved++;}
 assert.equal(moved,100);assert.equal((await call({op:'snapshot',session:'ring'})).data.viewport,1);
 await call({op:'write',session:'ring',data:data('\x1b[2J')});assert.deepEqual((await call({op:'snapshot',session:'ring'})).data.prompt_navigation,{version:1,previous:false,next:false});
 await call({op:'close',session:'ring'});await call({op:'create',session:'ring',cols:20,rows:3});assert.deepEqual((await call({op:'snapshot',session:'ring'})).data.prompt_navigation,{version:1,previous:false,next:false});assert.deepEqual(inputs,[]);
}));

test('Clear parser capability and current-row authoritative clear preserve identity modes reports and offsets',async()=>fixture(async({call,greeting,inputs})=>{await greeting;await call({op:'create',session:'clear',cols:20,rows:8});await call({op:'write',session:'clear',data:data('\x1b]7;file:///tmp\x07\x1b]133;C\x07'+('OLD-CLEAR\r\n'.repeat(20))+'\x1b[31m中CURRENT')});const before=(await call({op:'snapshot',session:'clear'})).data;assert.equal(before.clear_display_version,1);const reply=await call({op:'clear_display',session:'clear',expected_instance:'d'.repeat(64)});assert.equal(reply.ok,true);assert.deepEqual(reply.data,{status:'cleared'});const after=(await call({op:'snapshot',session:'clear'})).data;assert.doesNotMatch(after.data,/OLD-CLEAR/);assert.match(after.data,/中CURRENT/);assert.equal(after.cursorX,before.cursorX);assert.equal(after.cols,before.cols);assert.equal(after.rows,before.rows);assert.equal(after.retained_lines,before.retained_lines);assert.equal(after.revision,before.revision+1);assert.equal(after.viewport,0);assert.deepEqual(after.cwd_report,before.cwd_report);assert.deepEqual(after.command_report,before.command_report);assert.deepEqual(after.prompt_navigation,{version:1,previous:false,next:false});assert.deepEqual(inputs,[]);}));
test('Clear accepted after manual review follows subsequent output without replaying old viewport',async()=>fixture(async({call,greeting})=>{await greeting;await call({op:'create',session:'follow',cols:20,rows:8});await call({op:'write',session:'follow',data:data('old\r\n'.repeat(30)+'current')});await call({op:'viewport',session:'follow',line:0});assert.equal((await call({op:'clear_display',session:'follow',expected_instance:'d'.repeat(64)})).data?.status,'cleared');await call({op:'write',session:'follow',data:data('\r\nnext\r\n'.repeat(20))});const frame=(await call({op:'snapshot',session:'follow'})).data;assert.ok(frame.viewport>0,'accepted clear follows live output after previous user review');await call({op:'viewport',session:'follow',line:0});const review=(await call({op:'snapshot',session:'follow'})).data;assert.equal(review.viewport,0,'a later explicit manual intent remains authoritative');assert.doesNotMatch(review.data,/old/);}));
test('Clear rejects alternate stale malformed and unknown requests without mutating buffers',async()=>fixture(async({call,greeting})=>{await greeting;await call({op:'create',session:'clear',cols:20,rows:8});await call({op:'write',session:'clear',data:data('normal\x1b[?1049hALT')});const before=(await call({op:'snapshot',session:'clear'})).data;assert.deepEqual((await call({op:'clear_display',session:'clear',expected_instance:'d'.repeat(64)})).data,{status:'unavailable'});assert.deepEqual((await call({op:'clear_display',session:'clear',expected_instance:'a'.repeat(64)})).data,{status:'stale'});for(const request of [{op:'clear_display',session:'clear'},{op:'clear_display',session:'clear',expected_instance:'BAD'},{op:'clear_display',session:'clear',expected_instance:'d'.repeat(64),extra:true},{op:'clear_display',session:'missing',expected_instance:'d'.repeat(64)}])assert.equal((await call(request)).ok,false);assert.deepEqual((await call({op:'snapshot',session:'clear'})).data,before);}));

test('Clear invalidates actual owned prompt markers including no-op and preserves other sessions',async()=>fixture(async({call,greeting,inputs})=>{await greeting;for(const session of ['markers','other'])await call({op:'create',session,cols:20,rows:8});await call({op:'write',session:'markers',data:data('\x1b]133;A\x07first\r\n'+('line\r\n'.repeat(20))+'\x1b]133;A\x07second')});await call({op:'write',session:'other',data:data('OTHER')});const other=(await call({op:'snapshot',session:'other'})).data;assert.equal((await call({op:'snapshot',session:'markers'})).data.prompt_navigation.previous,true);await call({op:'clear_display',session:'markers',expected_instance:'d'.repeat(64)});let frame=(await call({op:'snapshot',session:'markers'})).data;assert.deepEqual(frame.prompt_navigation,{version:1,previous:false,next:false});const revision=frame.revision;await call({op:'clear_display',session:'markers',expected_instance:'d'.repeat(64)});frame=(await call({op:'snapshot',session:'markers'})).data;assert.equal(frame.revision,revision+1);await call({op:'resize',session:'markers',cols:30,rows:10});assert.doesNotMatch((await call({op:'snapshot',session:'markers'})).data.data,/first/);assert.deepEqual((await call({op:'snapshot',session:'other'})).data,other);assert.deepEqual(inputs,[]);}));

// Author: Jeff.Liu. A serialized screen cannot preserve a half-parsed VT/UTF-8 token.
test('stream snapshot refuses partial parser tokens and succeeds after their completion',async()=>fixture(async({call,greeting})=>{
 await greeting;await call({op:'create',session:'handoff',cols:40,rows:8});
 assert.equal((await call({op:'stream_snapshot',session:'handoff'})).ok,true);
 for(const [prefix,suffix] of [['\x1b[31','mRED'],['\x1b]0;title','\x07'],['\x1bP$q','m\x1b\\'],[[0xe4,0xb8],[0xad]]]) {
  await call({op:'write',session:'handoff',data:data(prefix)});
  const denied=await call({op:'stream_snapshot',session:'handoff'});
  assert.equal(denied.ok,false);assert.match(denied.error,/incomplete/);
  await call({op:'write',session:'handoff',data:data(suffix)});
  const ready=await call({op:'stream_snapshot',session:'handoff'});
  assert.equal(ready.ok,true);assert.equal(ready.data.session,'handoff');
 }
}));
