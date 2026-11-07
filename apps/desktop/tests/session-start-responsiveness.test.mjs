// Author: Jeff.Liu. Owner RPC must never block the GUI event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const native=readFileSync(new URL('../src-tauri/src/desktop_windows.rs',import.meta.url),'utf8');
for(const name of ['create_session','read_terminal_frame','read_session_snapshot','write_session','resize_session'])test(`${name} dispatches blocking owner work away from the GUI thread`,()=>{
 const declaration=native.match(new RegExp('(#\\[tauri::command[^\\n]*\\]\\n(?:#\\[[^\\n]*\\]\\n)*)pub\\(super\\) fn '+name+'[<(]'));
 assert.ok(declaration,`missing production command ${name}`);
 assert.match(declaration[1],/#\[tauri::command\(async\)\]/);
});
test('stop_session dispatches blocking owner work away from the GUI thread',()=>{
 const source=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
 assert.match(source,/#\[tauri::command\(async\)\]\s*fn stop_session\(/);
});
