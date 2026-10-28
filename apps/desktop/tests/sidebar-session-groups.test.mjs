// Author: Jeff.Liu. Fold only read ended sessions without losing selection, pins, attention or search matches.
import test from 'node:test';import assert from 'node:assert/strict';import * as workspace from '../src/workspaces.ts';
const row=(id,status='stopped',unread=0)=>({summary:{session_id:id},status,agent:{unread_count:unread}});
test('project keeps active, selected, pinned and attention rows in their existing order',()=>{
 const rows=[row('old'),row('running','running'),row('selected'),row('pin'),row('failed','failed'),row('unread','succeeded',1),row('done','succeeded')];const original=JSON.stringify(rows);
 const grouped=workspace.sidebarSessions(rows,'selected',['pin']);assert.deepEqual(grouped.current.map(r=>r.summary.session_id),['running','selected','pin','failed','unread']);assert.deepEqual(grouped.ended.map(r=>r.summary.session_id),['old','done']);assert.equal(JSON.stringify(rows),original);
});
test('search and explicit filters reveal all matching sessions; empty and unknown states stay safe',()=>{
 const rows=[row('old'),row('done','succeeded'),row('unknown','unknown')];assert.deepEqual(workspace.sidebarSessions(rows,null,[],true),{current:rows,ended:[]});assert.deepEqual(workspace.sidebarSessions([],null,[]),{current:[],ended:[]});assert.deepEqual(workspace.sidebarSessions(rows,null,[]).current,[rows[2]]);
});
test('a selected task remains visible when it ends, and ordinary output never changes row order',()=>{
 const a=row('a','running'),b=row('b','running');assert.deepEqual(workspace.sidebarSessions([a,b],'a',[]).current,[a,b]);a.status='succeeded';assert.deepEqual(workspace.sidebarSessions([a,b],'a',[]).current,[a,b]);assert.deepEqual(workspace.sidebarSessions([a,b],'b',[]).ended,[a]);
});
test('default terminal labels are stable and distinguish starts without model calls or saved-name changes',()=>{
 const time=new Date(2026,9,28,15,42,0);const first=workspace.defaultTerminalTitle('s-abc-1','终端',time),second=workspace.defaultTerminalTitle('s-abc-2','终端',time);assert.equal(first,'终端 15:42 · 1');assert.notEqual(first,second);assert.equal(workspace.defaultTerminalTitle('s-abc-1','Terminal',new Date(NaN)),'Terminal · 1');assert.equal(workspace.defaultTerminalTitle('invalid','Terminal'),'Terminal');assert.equal(workspace.defaultTerminalTitle('s-1a181f2377e-1a','终端'),workspace.defaultTerminalTitle('s-1a181f2377e-1a','终端'));
});
