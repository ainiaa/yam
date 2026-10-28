// Author: Jeff.Liu
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as layout from '../src/terminal-layout.ts';
import {encodeTerminalLayout,decodeTerminalLayout} from '../src/terminal-layout-persistence.ts';

test('reopening replaces one tab in place while keeping pane identity, tab order and focus',()=>{
 let before=layout.assignTerminalPane(layout.createTerminalLayout(),0,'old');
 before=layout.assignTerminalPane(before,0,'other');
 before=layout.changeTerminalLayout(before,'horizontal');
 before=layout.assignTerminalPane(before,1,'right');
 const after=layout.replaceTerminalSession(before,'old','new');
 assert.deepEqual(layout.terminalMembers(after),['new','other','right']);
 assert.deepEqual(after.panes,['other','right']);assert.equal(after.focused,before.focused);
 assert.equal(layout.terminalPaneId(after,0),layout.terminalPaneId(before,0));
 assert.deepEqual(layout.terminalMembers(before),['old','other','right']);
 const selected=layout.replaceTerminalSession(after,'right','next');assert.deepEqual(selected.panes,['other','next']);
 const duplicate=layout.replaceTerminalSession(selected,'new','next');assert.deepEqual(layout.terminalMembers(duplicate),['other','next']);
 assert.equal(layout.replaceTerminalSession(before,'missing','new'),before);
 for(const id of ['',null,undefined])assert.throws(()=>layout.replaceTerminalSession(before,'old',id));
});

test('saved recorded-only tabs are bounded, unique layout members and keep legacy layouts compatible',()=>{
 const id='s-123-1',other='s-123-2',before=layout.assignTerminalPane(layout.createTerminalLayout(),0,id);
 const encoded=encodeTerminalLayout(before,50,{},[id]);
 assert.deepEqual(decodeTerminalLayout(encoded).recordedOnly,[id]);
 assert.equal(decodeTerminalLayout(encoded).warning,null);
 assert.equal(decodeTerminalLayout(encodeTerminalLayout(before,50,{})).warning,null);
 assert.equal(decodeTerminalLayout(encodeTerminalLayout(before)).warning,null);
 for(const value of [[other],[id,id],[null],'bad',{},Array(17).fill(id),Array(1)]){
  assert.throws(()=>encodeTerminalLayout(before,50,{},value));
  assert.ok(decodeTerminalLayout(JSON.stringify({...JSON.parse(encoded),recordedOnly:value})).warning);
 }
});
