// Author: Jeff.Liu. Guard the Tauri dispatch policy on the startup IPC path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const native=readFileSync(new URL('../src-tauri/src/desktop_windows.rs',import.meta.url),'utf8');
for(const name of ['create_session','read_terminal_frame','read_session_snapshot'])test(`${name} dispatches blocking owner work away from the GUI thread`,()=>{
 const declaration=native.match(new RegExp('(#\\[tauri::command[^\\n]*\\]\\n(?:#\\[[^\\n]*\\]\\n)*)pub\\(super\\) fn '+name+'[<(]'));
 assert.ok(declaration,`missing production command ${name}`);
 assert.match(declaration[1],/#\[tauri::command\(async\)\]/);
});
