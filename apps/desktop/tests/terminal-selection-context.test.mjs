// Author: Jeff.Liu.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';

const context=await import('../src/terminal-selection-context.ts').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
const record=()=>({summary:{session_id:'s-one',cwd:'/work/tree',launch:{adapter:'pi',mode:'interactive'}},status:'running',
 agent:{generation:'g1',agent_session_id:'native',turn_id:'turn1',revision:8,integration:'connected',phase:'response_finished'}});
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function appFunction(name,bindings){
 let declaration;
 function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)declaration=node;ts.forEachChild(node,visit);}
 visit(source);
 assert.ok(declaration,name);
 const body=ts.transpileModule(declaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 return new Function(...Object.keys(bindings),body+';return '+name)(...Object.values(bindings));
}
test('terminal selection is bounded, control-safe and carries the verified local origin',()=>{
 assert.equal(typeof context.terminalSelectionOrigin,'function');
 const origin=context.terminalSelectionOrigin(record());
 const content=context.terminalSelectionText('error: missing\r\n\tfile',origin);
 assert.match(content.text,/Session: s-one\nWorking directory: "\/work\/tree"\n/);
 assert.match(content.text,/error: missing\n\tfile/);
 assert.ok(!/[\x00\x1b\r]/.test(content.text));
 for(const value of [' ', '\x1b[201~', 'a\rb', 'x\u202ey', '中'.repeat(6000), '\ud800'])assert.throws(()=>context.terminalSelectionText(value,origin));
 for(const change of [r=>r.summary.ssh={},r=>r.agent.phase='working',r=>r.agent.integration='unavailable',r=>delete r.agent.revision]) {
  const r=record();change(r);assert.equal(context.terminalSelectionOrigin(r),null);
 }
});

test('managed Codex selection preserves the excerpt as a single plain line and fences launch-mode changes',()=>{
 const r=record();r.summary.launch={adapter:'codex',mode:'interactive',codex:{route:{config:'fixture'}}};
 const origin=context.terminalSelectionOrigin(r);
 const content=context.terminalSelectionText('error\n\tsecond line',origin);
 assert.equal(content.risky,false);
 assert.equal(content.lines,1);
 assert.match(content.text,/error\\n\\tsecond line/);
 assert.equal(context.matchesTerminalSelection(r,origin),true);
 delete r.summary.launch.codex.route;
 assert.equal(context.matchesTerminalSelection(r,origin),false);
});

function fixture(){
 const original=record(),origin=context.terminalSelectionOrigin?.(original);
 const pasted=[],guards=[],errors=[],notices=[],calls=[];
 const view={inputQueue:{write:null,version:1},writable:true};
 const instance={focus(){calls.push('focus');},paste(text){pasted.push(text);guards.push(view.draftInputGuard);view.inputQueue.write=Promise.resolve();}};
 const pending={target:{sessionId:'s-one',view,instance},selection:{...origin,title:'Build'},content:{text:'excerpt'}};
 let reply=async()=>original,valid=true,focused=true;
 const pastePending={current:pending},selectionFillBusy={current:false};
 const confirm=appFunction('fillTerminalSelectionContext',{...context,pastePending,selectionFillBusy,terminalSelectionCurrent:()=>valid,
  terminalHasInputFocus:()=>focused,invoke:async(name,args)=>{calls.push([name,args]);return reply();},
  cancelTerminalPaste:()=>{pastePending.current=null;},setError:error=>errors.push(error),setTerminalNotice:notice=>notices.push(notice)});
 return {confirm:()=>confirm(pending),reply:value=>{reply=value;},stale:()=>{valid=false;},noFocus:()=>{focused=false;},cancel:()=>{pastePending.current=null;},pasted,guards,errors,notices,calls};
}
test('selection confirmation fills only once using ordinary paste and a fresh agent identity',async()=>{
 const f=fixture();await Promise.all([f.confirm(),f.confirm()]);
 assert.deepEqual(f.pasted,['excerpt']);
 assert.deepEqual(f.guards,[{generation:'g1',nativeSessionId:'native',turnId:'turn1',revision:8,cwd:'/work/tree',managedCodex:false}]);
 assert.deepEqual(f.calls,[['get_session',{sessionId:'s-one'}],'focus']);
 assert.equal(f.notices.length,1);
});
test('busy agent, changed turn, cancellation and failed focus all refuse selection delivery',async()=>{
 for(const mutate of [f=>f.reply(async()=>{const r=record();r.agent.phase='working';return r;}),
  f=>f.reply(async()=>{const r=record();r.agent.turn_id='turn2';return r;}),
  f=>f.reply(async()=>{f.stale();return record();}),
  f=>f.reply(async()=>{f.cancel();return record();}),f=>f.noFocus()]){
  const f=fixture();mutate(f);await f.confirm();assert.deepEqual(f.pasted,[]);assert.deepEqual(f.notices,[]);
 }
});
