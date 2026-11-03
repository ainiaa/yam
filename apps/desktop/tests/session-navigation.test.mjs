// Author: Jeff.Liu. Sidebar selection replaces a pane view; legacy saved sessions remain readable.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import * as ops from '../src/terminal-layout.ts';
import {encodeTerminalLayout,decodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
test('sidebar can switch through more than sixteen sessions without accumulating hidden tabs',()=>{
 let layout=ops.createTerminalLayout();for(let i=0;i<40;i++){layout=ops.assignTerminalPane(layout,0,`s-a-${i+1}`,true);assert.deepEqual(ops.terminalMembers(layout),[`s-a-${i+1}`]);}assert.deepEqual(layout.panes,['s-a-40']);
});
test('sidebar replaces the focused pane while other visible sessions and input identity stay unique',()=>{
 let layout=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');layout=ops.assignTerminalPane(layout,0,'s-a-1',true);layout=ops.assignTerminalPane(layout,1,'s-b-2',true);
 layout=ops.assignTerminalPane(layout,1,'s-c-3',true);assert.deepEqual(layout.panes,['s-a-1','s-c-3']);assert.equal(layout.focused,1);
 layout=ops.assignTerminalPane(layout,1,'s-a-1',true);assert.deepEqual(layout.panes,['s-a-1','s-c-3']);assert.equal(layout.focused,0);
});
test('legacy multi-tab layouts decode without mutation and sidebar selection removes only inactive layout membership',()=>{
 let old=ops.assignTerminalPane(ops.createTerminalLayout(),0,'s-a-1');old=ops.assignTerminalPane(old,0,'s-b-2');const raw=encodeTerminalLayout(old,50),saved=JSON.stringify(old),decoded=decodeTerminalLayout(raw);
 assert.ok(decoded);assert.deepEqual(ops.terminalMembers(decoded.layout),['s-a-1','s-b-2']);const selected=ops.assignTerminalPane(decoded.layout,0,'s-c-3',true);assert.deepEqual(ops.terminalMembers(selected),['s-c-3']);assert.equal(JSON.stringify(old),saved);
});
test('sidebar selection rejects invalid pane targets before changing layout',()=>{const layout=ops.createTerminalLayout(),before=JSON.stringify(layout);for(const index of [-1,1,NaN])assert.throws(()=>ops.assignTerminalPane(layout,index,'s-a-1',true));assert.equal(JSON.stringify(layout),before);});
test('actual app opens sidebar sessions in replacement mode and preserves file tabs',()=>{
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.match(source,/assignTerminalPane\(baseLayout,target,id,replaceView\|\|firstAttachment\)/);
 const files=readFileSync(new URL('../src/ProjectFiles.tsx',import.meta.url),'utf8');assert.ok(files.includes('project-file-tabs'));
});
