// Author: Jeff.Liu. A response or process exit never proves acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskDeliveryNotice} from '../src/agent-events.ts';

test('a native response offers review without claiming tests passed',()=>{
 for(const phase of ['response_finished','needs_attention']){
  const message=taskDeliveryNotice({phase,integration:'connected',inbox:[]},'running');
  assert.match(message,/response available/);assert.match(message,/not verified by YAM/);
 }
 assert.match(taskDeliveryNotice({generation:'gen-current',turn_id:'turn-1',phase:'shell',integration:'disconnected',inbox:[{id:'gen-current:turn-1:TurnComplete',turn_id:'turn-1',kind:'response_finished'}]},'running'),/response available/);
});
test('failed and stopped processes remain distinguishable from an agent response',()=>{
 for(const status of ['succeeded','failed','stopped','needs_attention']){
  const message=taskDeliveryNotice(undefined,status);
  if(status==='succeeded')assert.match(message,/Process ended/);else assert.doesNotMatch(message,/Process ended/);
  assert.match(message,/not verified by YAM/);
 }
 for(const phase of ['working','needs_permission','unknown'])assert.equal(taskDeliveryNotice({phase,integration:'connected',inbox:[]},'running'),null);
 assert.equal(taskDeliveryNotice({phase:'response_finished',integration:'unavailable',inbox:[]},'running'),null);
 assert.equal(taskDeliveryNotice(undefined,'unavailable'),null);
});

test('delivery evidence buttons open the current task files, changes and recorded log',async()=>{
 const {readFileSync}=await import('node:fs');
 const {default:ts}=await import('typescript');
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const buttons=[];
 function visit(node){
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='button'){
   const text=node.children.map(child=>child.getText(ast)).join('');
   if(/Review task changes|View task files|Review recorded output/.test(text))buttons.push(node);
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);assert.equal(buttons.length,3);
 const calls=[];
 for(const button of buttons){
  const click=button.openingElement.attributes.properties.find(attr=>attr.name?.getText(ast)==='onClick');
  const js=ts.transpileModule(`const action=${click.initializer.expression.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  const names=['session','setProjectToolsTab','setProjectToolsPath','setProjectToolsOpen','setLogSearchOpen'];
  const action=Function(...names,`${js};return action;`)({cwd:'/task'},...names.slice(1).map(name=>value=>calls.push([name,value])));
  action();
 }
 assert.deepEqual(calls,[['setProjectToolsTab','changes'],['setProjectToolsPath','/task'],['setProjectToolsOpen',true],['setProjectToolsTab','files'],['setProjectToolsPath','/task'],['setProjectToolsOpen',true],['setLogSearchOpen',true]]);
});

test('a new run with no result cannot borrow an earlier generation or turn receipt',()=>{
 const old={id:'gen-old:turn-1:TurnComplete',turn_id:'turn-1',kind:'response_finished'};
 const current={generation:'gen-current',phase:'shell',integration:'disconnected',inbox:[old]};
 assert.equal(taskDeliveryNotice(current,'running'),null);
 assert.equal(taskDeliveryNotice({...current,turn_id:'turn-1'},'running'),null);
 assert.equal(taskDeliveryNotice({...current,turn_id:'turn-2',inbox:[{...old,id:'gen-current:turn-1:TurnComplete'}]},'running'),null);
});

test('failed and interrupted current turns still expose evidence with a live shell',()=>{
 for(const [kind,native] of [['failed','TurnFailed'],['interrupted','Interrupt']]){
  assert.match(taskDeliveryNotice({phase:kind,integration:'connected',inbox:[]},'running'),/Agent turn failed or was interrupted/);
  const receipt={id:`gen-current:turn-2:${native}`,turn_id:'turn-2',kind};
  assert.match(taskDeliveryNotice({phase:'shell',integration:'disconnected',generation:'gen-current',turn_id:'turn-2',inbox:[receipt]},'running'),/not verified by YAM/);
 }
});
