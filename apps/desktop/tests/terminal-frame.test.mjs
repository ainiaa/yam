import {test} from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import service from '../terminal-service.cjs';
import {applyTerminalFrame,validateTerminalFrame,terminalReportedCwd,terminalReportedCommand,terminalReportedPromptNavigation} from '../src/terminal-frame.ts';
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
const frame=(term,addon)=>({projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:4,...service.projection(term,addon)},end_offset:42,status:'running'});
test('full projection restores Unicode, alternate-screen and cursor state without replying to old queries',async()=>{
 const source=new headless.Terminal({cols:20,rows:8,allowProposedApi:true}),target=new headless.Terminal({cols:80,rows:24,allowProposedApi:true});
 const addon=new serialize.SerializeAddon();source.loadAddon(addon);const replies=[];target.onData(data=>replies.push(data));
 try{
  await write(source,'normal中\x1b[?1049h\x1b[31mALT\x1b[?1003h\x1b[?1006h\x1b[6n');
  const value=frame(source,addon);await applyTerminalFrame(target,value,'s-one');
  assert.equal(target.cols,20);assert.equal(target.rows,8);assert.equal(target.buffer.active.type,'alternate');
  assert.equal(target.buffer.active.getLine(0).translateToString(true),source.buffer.active.getLine(0).translateToString(true));assert.equal(target.buffer.active.cursorX,source.buffer.active.cursorX);
  assert.deepEqual(replies,[]);assert.equal(target.modes.mouseTrackingMode,'any');
  await write(source,'\x1b[?1049l\r'+('x'.repeat(20)));await applyTerminalFrame(target,frame(source,addon),'s-one');
  assert.equal(target.buffer.active.cursorX,20);assert.equal(target.buffer.active.getLine(0).translateToString(true),'x'.repeat(20));
 }finally{source.dispose();target.dispose();}
});
test('invalid identity, dimensions, versions and cursors cannot reset the visible terminal',async()=>{
 const source=new headless.Terminal({cols:20,rows:8,allowProposedApi:true});const addon=new serialize.SerializeAddon();source.loadAddon(addon);
 try{
  const good=frame(source,addon);assert.equal(validateTerminalFrame(good,'s-one'),good);
  assert.throws(()=>validateTerminalFrame(good,'s-other'));
  for(const [key,value] of [['version',2],['terminal_version','6.1.0'],['cols',0],['rows',201],['cursorX',21],['viewport',2001],['data',null]]){
   const invalid=structuredClone(good);invalid.projection[key]=value;const operations=[];
   await assert.rejects(applyTerminalFrame({resize(){operations.push('resize');},write(){operations.push('write');},scrollToLine(){operations.push('scroll');}},invalid,'s-one'));assert.deepEqual(operations,[]);
  }
 }finally{source.dispose();}
});

test('full scene replacement resets stale TUI modes and restores the authoritative viewport',async()=>{
 const source=new headless.Terminal({cols:20,rows:8,scrollback:500,allowProposedApi:true}),target=new headless.Terminal({cols:40,rows:12,allowProposedApi:true});
 const addon=new serialize.SerializeAddon();source.loadAddon(addon);
 const rows=terminal=>Array.from({length:terminal.buffer.active.length},(_,index)=>terminal.buffer.active.getLine(index).translateToString(true));
 try{
  await write(source,Array.from({length:40},(_,index)=>`row ${index}\r\n`).join('')+'\x1b[?1h\x1b[?2004h\x1b[?7l\x1b[6 q\x1b[?25l');
  source.scrollToLine(5);
  const hidden=frame(source,addon);assert.ok(hidden.projection.data.includes('\x1b[?25l'));
  await applyTerminalFrame(target,hidden,'s-one');
  assert.deepEqual(rows(target),rows(source));assert.equal(target.buffer.active.viewportY,5);
  assert.deepEqual(target.modes,source.modes);assert.equal(target._core.coreService.isCursorHidden,true);
  assert.equal(target._core.coreService.decPrivateModes.cursorStyle,'bar');
  await write(source,'\x1bc\x1b[?25hFresh normal scene');
  const visible=frame(source,addon);assert.ok(visible.projection.data.includes('\x1b[?25h'));
  await applyTerminalFrame(target,visible,'s-one');
  assert.deepEqual(rows(target),rows(source));assert.equal(target.buffer.active.viewportY,0);
  assert.deepEqual(target.modes,source.modes);assert.equal(target._core.coreService.isCursorHidden,false);
  assert.equal(target._core.coreService.decPrivateModes.cursorStyle,undefined);
 }finally{source.dispose();target.dispose();}
});

test('all frame budgets and numeric boundaries reject malformed payloads before any renderer operation',async()=>{
 const good={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:0,data:'',cols:20,rows:8,cursorX:20,viewport:0,buffer:'normal'},end_offset:0,status:'stopped'};
 assert.throws(()=>validateTerminalFrame(null,'s-one'));
 const cases=[['serialize_version','0.15.0'],['instance',null],['instance','z'.repeat(64)],['revision',-1],['revision',1.5],['data','x'.repeat(8*1024*1024+1)],['cols',1.5],['cols',501],['rows',0],['rows',1.5],['cursorX',-1],['cursorX',1.5],['viewport',-1],['viewport',1.5],['buffer','unknown']];
 for(const [key,value] of cases){const invalid=structuredClone(good);invalid.projection[key]=value;assert.throws(()=>validateTerminalFrame(invalid,'s-one'),undefined,key);}
 for(const [key,value] of [['end_offset',-1],['end_offset',1.5],['status',null],['persisted',null],['persisted','true']]){const invalid=structuredClone(good);invalid[key]=value;assert.throws(()=>validateTerminalFrame(invalid,'s-one'));}
 for(const persisted of [true,false])assert.equal(validateTerminalFrame({...good,persisted},'s-one').persisted,persisted);
 await assert.rejects(applyTerminalFrame({},good,'s-one'),/renderer version contract/);
});

test('A07a optional metadata is independently sanitized without rejecting valid screen',()=>{
 const good={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,data:'',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'},end_offset:0,status:'running'};
 assert.equal(terminalReportedCwd(good),null);
 assert.deepEqual(terminalReportedCwd({...good,reported_cwd:{path:'/tmp/中',sequence:2}}),{path:'/tmp/中',sequence:2});
 for(const reported_cwd of [null,[],{},'bad',{path:'/tmp',sequence:-1},{path:'/tmp',sequence:1.5},{path:'/tmp',sequence:Number.MAX_SAFE_INTEGER+1},{path:'bad\u0000',sequence:1},{path:'é'.repeat(2049),sequence:1},{path:'/tmp',sequence:1,extra:true},{path:'/tmp',sequence:Number.MAX_SAFE_INTEGER}]){
  const f={...good,reported_cwd};assert.equal(validateTerminalFrame(f,'s-one'),f);assert.equal(terminalReportedCwd(f),null);
 }
 assert.deepEqual(terminalReportedCwd({...good,reported_cwd:{path:null,sequence:Number.MAX_SAFE_INTEGER}}),{path:null,sequence:Number.MAX_SAFE_INTEGER});
 let getters=0;const reported_cwd={sequence:1,get path(){getters++;throw Error('getter');}};assert.equal(terminalReportedCwd({...good,reported_cwd}),null);assert.equal(getters,0);
});

test('A05a3 full validated frame restores authoritative retention before parsing and legacy defaults2000',async()=>{
 const source=new headless.Terminal({cols:20,rows:8,scrollback:500,allowProposedApi:true}),target=new headless.Terminal({cols:20,rows:8,scrollback:2000,allowProposedApi:true}),addon=new serialize.SerializeAddon();source.loadAddon(addon);
 try{await write(source,'row\r\n'.repeat(600));const current=frame(source,addon);current.projection.retained_lines=500;await applyTerminalFrame(target,current,'s-one');assert.equal(target.options.scrollback,500);assert.equal(target.buffer.active.baseY,source.buffer.active.baseY);delete current.projection.retained_lines;await applyTerminalFrame(target,current,'s-one');assert.equal(target.options.scrollback,2000);
 for(const capacity of [null,199,2001,1.5,'500',true]){const invalid={...current,projection:{...current.projection,retained_lines:capacity}};const before=target.options.scrollback;await assert.rejects(applyTerminalFrame(target,invalid,'s-one'));assert.equal(target.options.scrollback,before);}
 for(const retained_lines of [200,500,2000])assert.throws(()=>validateTerminalFrame({...current,projection:{...current.projection,retained_lines,viewport:retained_lines+1}},'s-one'));
 }finally{source.dispose();target.dispose();}
});


test('A07c1 command metadata strict own descriptors remain optional to valid scene',()=>{
 const good={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:1,data:'scene',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'},end_offset:0,status:'running'};
 assert.deepEqual(terminalReportedCommand({...good,reported_command:{sequence:1,phase:'complete',last_exit:255}}),{sequence:1,phase:'complete',last_exit:255});
 for(const report of [null,[],{},'bad',{sequence:-1,phase:'prompt',last_exit:null},{sequence:1,phase:'running',last_exit:0},{sequence:Number.MAX_SAFE_INTEGER,phase:'unknown',last_exit:null},{sequence:1,phase:'complete',last_exit:256},{sequence:1,phase:'complete',last_exit:null,extra:1},Object.create({sequence:1,phase:'prompt',last_exit:null})]){const value={...good,reported_command:report};assert.equal(validateTerminalFrame(value,'s-one'),value);assert.equal(terminalReportedCommand(value),null);}
 let called=0;const getter={sequence:1,phase:'prompt',get last_exit(){called++;throw Error('private')}};assert.equal(terminalReportedCommand({...good,reported_command:getter}),null);assert.equal(called,0);
});

test('A07c3 strict optional prompt descriptor rejects accessors prototypes and extra fields without breaking scenes',()=>{
 const scene={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:0,data:'',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'},end_offset:0,status:'running'};
 assert.equal(terminalReportedPromptNavigation(scene),null);
 for(const report of [{version:1,previous:true,next:false},Object.assign(Object.create(null),{version:1,previous:false,next:true})])assert.deepEqual(terminalReportedPromptNavigation({...scene,reported_prompt_navigation:report}),{...report});
 let getters=0;const getter={version:1,previous:true,get next(){getters++;return true;}};
 for(const report of [null,[],getter,{version:1,previous:true},{version:2,previous:true,next:true},{version:1,previous:1,next:true},{version:1,previous:true,next:false,extra:1},Object.assign(Object.create({}),{version:1,previous:true,next:false})]){const value={...scene,reported_prompt_navigation:report};assert.equal(terminalReportedPromptNavigation(value),null);assert.equal(validateTerminalFrame(value,'s-one'),value);}
 assert.equal(terminalReportedPromptNavigation({...scene,projection:{...scene.projection,prompt_navigation:{version:1,previous:true,next:true}}}),null);assert.equal(getters,0);
});

test('Clear outer scalar capability is optional strict own data and never inherited from projection',async()=>{const {terminalClearDisplayVersion}=await import('../src/terminal-frame.ts');const scene={projection:{clear_display_version:1},status:'running',end_offset:0};assert.equal(terminalClearDisplayVersion({...scene,clear_display_version:1}),1);for(const value of [undefined,null,0,2,true,'1',{},[]])assert.equal(terminalClearDisplayVersion({...scene,clear_display_version:value}),null);assert.equal(terminalClearDisplayVersion(scene),null);assert.equal(terminalClearDisplayVersion(Object.assign(Object.create({clear_display_version:1}),scene)),null);let gets=0;const getter={...scene,get clear_display_version(){gets++;throw Error('private');}};assert.equal(terminalClearDisplayVersion(getter),null);assert.equal(gets,0);});


test('browser viewport batches projection scroll changes and restores its guard even when parsing fails',async()=>{
 for(const failure of [null,'resize','write']){
  const operations=[];let target;
  const viewport={_isSyncing:false,_sync(){operations.push(['sync',this._isSyncing]);}};
  target={options:{},_core:{_inputHandler:{_activeBuffer:{x:0}},_viewport:viewport},resize(){operations.push(['resize',viewport._isSyncing]);if(failure==='resize')throw Error('resize failed');},write(data,done){operations.push(['write',viewport._isSyncing]);if(failure==='write')throw Error('write failed');done();},scrollToLine(line){operations.push(['scroll',viewport._isSyncing,line]);}};
  const scene={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:0,data:'scene',cols:20,rows:8,cursorX:5,viewport:3,buffer:'normal'},end_offset:0,status:'running'};
  if(failure)await assert.rejects(applyTerminalFrame(target,scene,'s-one'),new RegExp(failure+' failed'));
  else{await applyTerminalFrame(target,scene,'s-one');assert.equal(target._core._inputHandler._activeBuffer.x,5);assert.ok(operations.some(row=>row[0]==='scroll'&&row[2]===3));}
  assert.ok(operations.filter(row=>['resize','write'].includes(row[0])).every(row=>row[1]===true),'scrollbar synchronization must wait for the full projection');
  assert.equal(viewport._isSyncing,false,'errors cannot leave user scrolling suppressed');
  assert.deepEqual(operations.find(row=>row[0]==='sync'),['sync',false],'only the restored final buffer is synchronized');
  if(!failure){assert.deepEqual(operations.at(-1),['scroll',false,3]);assert.ok(operations.findIndex(row=>row[0]==='sync')<operations.findIndex(row=>row[0]==='scroll'),'scrolling uses the synchronized final dimensions');}
 }
});

test('an incompatible browser viewport fails before changing the existing scene',async()=>{
 const scene={projection:{version:1,instance:'a'.repeat(64),session:'s-one',terminal_version:'6.0.0',serialize_version:'0.14.0',revision:0,data:'scene',cols:20,rows:8,cursorX:0,viewport:0,buffer:'normal'},end_offset:0,status:'running'};
 for(const viewport of [{},{_isSyncing:false},{_isSyncing:null,_sync(){}},{_isSyncing:false,_sync:null}]){
  const operations=[];const target={options:{},_core:{_inputHandler:{_activeBuffer:{x:0}},_viewport:viewport},resize(){operations.push('resize');},write(data,done){operations.push('write');done();},scrollToLine(){operations.push('scroll');}};
  await assert.rejects(applyTerminalFrame(target,scene,'s-one'),/viewport version contract/);
  assert.deepEqual(operations,[]);assert.deepEqual(target.options,{});
 }
});
