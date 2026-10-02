import {test} from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import service from '../terminal-service.cjs';
import {applyTerminalFrame,validateTerminalFrame} from '../src/terminal-frame.ts';
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
   const invalid=structuredClone(good);invalid.projection[key]=value;let resets=0;
   await assert.rejects(applyTerminalFrame({reset(){resets++;}},invalid,'s-one'));assert.equal(resets,0);
  }
 }finally{source.dispose();}
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
