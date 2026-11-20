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

test('selection delivery requires a current writable terminal and matching agent target',()=>{
 assert.equal(typeof context.terminalSelectionCanBeFilled,'function');
 const ready={pending:true,mounted:true,ownerAvailable:true,conversationClosed:true,targetCurrent:true,
  viewReady:true,live:true,available:true,moving:false,persisted:false,attaching:false,parsing:false,
  projecting:false,resizing:false,clearPending:false,scrollReturnPending:false,bracketedPaste:true,
  pasteAllowed:true,selectionMatches:true};
 assert.equal(context.terminalSelectionCanBeFilled(ready),true);
 const mustBeTrue=Object.keys(ready).filter(field=>!['moving','persisted','attaching','parsing','projecting',
  'resizing','clearPending','scrollReturnPending'].includes(field));
 const mustBeFalse=['moving','persisted','attaching','parsing','projecting','resizing','clearPending','scrollReturnPending'];
 for(const field of mustBeTrue)assert.equal(context.terminalSelectionCanBeFilled({...ready,[field]:false}),false,field);
 for(const field of mustBeFalse)assert.equal(context.terminalSelectionCanBeFilled({...ready,[field]:true}),false,field);
});

test('selection fill claims once, refreshes agent identity and rejects stale post-write completion',async()=>{
 assert.equal(typeof context.fillTerminalSelection,'function');
 const events=[],view={inputQueue:{version:4,write:null,count:0,length:0},writable:true};
 const target={sessionId:'s-one',view,instance:{focus(){events.push('focus');},paste(text){events.push(['paste',text]);view.inputQueue.write=Promise.resolve();}}};
 const selection={...context.terminalSelectionOrigin(record()),cwd:'/work/tree'};
 const pending={target,selection,content:{text:'excerpt'}};let current=true,cleared=0,notice=0,error=null;
 const busy={current:false};const run=()=>context.fillTerminalSelection({pending,select:()=>pending,busy,clear:()=>{cleared++;},isCurrent:()=>current&&context.terminalSelectionCanBeFilled({pending:true,mounted:true,ownerAvailable:true,conversationClosed:true,targetCurrent:true,viewReady:true,live:true,available:true,moving:false,persisted:false,attaching:false,parsing:false,projecting:false,resizing:false,clearPending:false,scrollReturnPending:false,bracketedPaste:true,pasteAllowed:true,selectionMatches:context.matchesTerminalSelection(record(),selection)}),
  readCurrent:async()=>record(),matches:context.matchesTerminalSelection,focus:()=>events.push('focus'),hasFocus:()=>true,
  setGuard:value=>{view.draftInputGuard=value;},clearGuard:()=>{delete view.draftInputGuard;},paste:(_instance,text)=>target.instance.paste(text),
  setNotice:()=>notice++,setError:value=>error=value});
 await Promise.all([run(),run()]);
 assert.equal(events.filter(value=>Array.isArray(value)&&value[0]==='paste').length,1,error??'paste was not sent');
 assert.equal(cleared,1);assert.equal(notice,1);assert.equal(error,null);assert.equal(view.draftInputGuard,undefined);
 current=false;const stale={...pending,target:{...target,view:{...view,inputQueue:{version:4,write:null,count:0,length:0},writable:true},instance:{...target.instance}}};
 await context.fillTerminalSelection({pending:stale,select:()=>stale,busy:{current:false},clear(){},isCurrent:()=>false,readCurrent:async()=>record(),matches:context.matchesTerminalSelection,focus(){},
  hasFocus:()=>true,setGuard(){},clearGuard(){},paste(){assert.fail('stale selection must not be pasted');},setNotice(){},setError:value=>{error=value;}});
 assert.match(error,/cannot receive a draft/);
});

test('App paste confirmation is wired to the terminal selection module',()=>{
 assert.match(source.text,/fillTerminalSelection\(\{pending,select:.*busy:selectionFillBusy/s);
 assert.doesNotMatch(source.text,/function fillTerminalSelectionContext/);
});
