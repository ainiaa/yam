import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(invoke) {
 let callback;
 function visit(node) {if(ts.isFunctionDeclaration(node)&&node.name?.text==='exportDiagnostics')callback=node.getText(ast);ts.forEachChild(node,visit);}
 visit(ast);
 assert.ok(callback,'diagnostics export action must exist');
 const busy={current:false}, states=[], messages=[];
 const js=ts.transpileModule(callback,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const run=new Function('invoke','diagnosticsBusy','setDiagnosticsExporting','setDiagnosticsMessage',js+';return exportDiagnostics;')(invoke,busy,v=>states.push(v),v=>messages.push(v));
 return {run,busy,states,messages};
}

test('diagnostics export succeeds without session data and uses only the native export command',async()=>{
 const calls=[];const h=handler(async(...args)=>{calls.push(args);return true;});
 await h.run();assert.deepEqual(calls,[['export_diagnostics']]);
 assert.deepEqual(h.states,[true,false]);assert.equal(h.busy.current,false);
 assert.equal(h.messages.at(-1),'Diagnostics saved.');
});

test('diagnostics cancellation has no saved message and releases the busy state',async()=>{
 const h=handler(async()=>false);await h.run();
 assert.equal(h.messages.at(-1),'Export cancelled.');assert.equal(h.busy.current,false);
});

test('diagnostics errors show fixed labels and never echo paths or secret error text',async()=>{
 for(const [reason,message] of [['destination_exists','File already exists. Choose a new file name.'],['destination_unwritable','Cannot save diagnostics. Choose a writable folder.'],['secret /private/path prompt bearer credential','Diagnostics export failed.']]){
  const h=handler(async()=>{throw reason;});await h.run();
  assert.equal(h.messages.at(-1),message);assert.equal(h.busy.current,false);
 }
});

test('diagnostics blocks overlapping dialog requests until the current export finishes',async()=>{
 let resolve,calls=0;const h=handler(()=>{calls++;return new Promise(r=>resolve=r);});
 const first=h.run();await h.run();assert.equal(calls,1);resolve(true);await first;
 const second=h.run();assert.equal(calls,2);resolve(false);await second;
});

test('diagnostics button stays available without any session and announces results accessibly',()=>{
 let button;
 function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='button'&&node.openingElement.attributes.properties.some(p=>p.name?.getText(ast)==='aria-label'&&p.initializer?.getText(ast)==='"Export diagnostics"'))button=node;ts.forEachChild(node,visit);}
 visit(ast);assert.ok(button,'always-visible diagnostics button is required');
 const disabled=button.openingElement.attributes.properties.find(p=>p.name?.getText(ast)==='disabled');
 assert.equal(disabled?.initializer?.getText(ast),'{diagnosticsExporting}');
 for(let node=button.parent;node;node=node.parent) {
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken)assert.ok(!node.left.getText(ast).includes('session'));
 }
 assert.ok(source.includes('role="status">{diagnosticsMessage}'));
});
