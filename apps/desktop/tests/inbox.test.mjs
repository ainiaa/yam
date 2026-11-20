// Author: Jeff.Liu. Filters only change presentation of loaded, unread receipts.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {groupInbox} from '../src/history.ts';import {projectKey} from '../src/workspaces.ts';
const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
const compile=s=>ts.transpile(s,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022});
const src=ts.createSourceFile('SessionInbox.tsx',readFileSync(new URL('../src/SessionInbox.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=src.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='SessionInbox');
const Inbox=new Function('React','t','groupInbox','projectKey','AttentionCard',compile(fn.getText(src).replace(/^export /,''))+';return SessionInbox;')(React,s=>s,groupInbox,projectKey,'AttentionCard');
const nodes=x=>Array.isArray(x)?x.flatMap(nodes):x&&typeof x==='object'?[x,...nodes(x.children??[])]:[];
const text=x=>Array.isArray(x)?x.map(text).join(''):typeof x==='string'?x:text(x?.children??[]);
const item=(id,cwd,kind='response_finished',current=false)=>({session:{summary:{session_id:id,cwd,title:id},status:kind==='failed'?'failed':'running',agent:{unread_count:1}},receipt:{id:id+'-receipt',revision:1,kind,read:false},current});
const entries=[item('a','/repo/a/'),item('b','/repo/b','needs_permission',true),item('old','/repo/a','failed',false)];
function render(extra={}){const calls=[];return {calls,tree:Inbox({items:entries,titleFor:s=>s.session_id,selectedId:null,onOpen:()=>calls.push('open'),onMarkRead:()=>calls.push('read'),...extra})};}
const ids=tree=>nodes(tree).filter(n=>n.type==='section').map(n=>n.props['aria-label']);
test('default preserves all loaded unread groups and does not acknowledge',()=>{const r=render();assert.equal(ids(r.tree).length,3);assert.deepEqual(r.calls,[]);});
test('project filtering normalizes only trailing separators, never matches a sibling prefix',()=>{assert.deepEqual(ids(render({project:'/repo/a',projectOnly:true}).tree),['old','a']);assert.deepEqual(ids(render({project:'/repo',projectOnly:true}).tree),[]);});
test('current actionable excludes historical failures despite their priority',()=>{assert.deepEqual(ids(render({actionableOnly:true}).tree),['b']);});
test('filters combine without mutating receipts or unread state',()=>{const before=JSON.stringify(entries);assert.deepEqual(ids(render({project:'/repo/a',projectOnly:true,actionableOnly:true}).tree),[]);assert.equal(JSON.stringify(entries),before);});
test('project becomes unavailable while enabled: show no matches, never global data',()=>{assert.deepEqual(ids(render({project:null,projectOnly:true}).tree),[]);});
test('zero matches explicitly refers to loaded notices',()=>{assert.match(text(render({project:'/missing',projectOnly:true}).tree),/No matching loaded notices/);});
test('selected live agent advancing overrides stale owner-current permission proof',()=>{const entry=item('b','/repo/b','needs_permission',true);const agent={generation:'g',turn_id:'t',revision:1,phase:'working',integration:'connected',inbox:[entry.receipt]};assert.deepEqual(ids(render({items:[entry],selectedId:'b',currentAgent:agent,actionableOnly:true}).tree),[]);});
test('App controls preserve the global pagination path and expose loaded scope',()=>{
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),app=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let controls;function visit(n){if(ts.isJsxElement(n)&&n.openingElement.getText(app).includes('className="inbox-filters"'))controls=n;ts.forEachChild(n,visit)}visit(app);assert.ok(controls,'inbox has filter controls');
 const calls=[],bindings={React,t:(s,args)=>args?s.replace('{{project}}',args.project):s,inboxProjectOnly:false,inboxActionableOnly:false,setInboxProjectOnly:v=>calls.push(['project',v]),setInboxActionableOnly:v=>calls.push(['actionable',v]),currentProject:{path:'/repo/a'},activeProject:'/repo/a'};
 const tree=new Function(...Object.keys(bindings),compile('return ('+controls.getText(app)+')'))(...Object.values(bindings));const inputs=nodes(tree).filter(n=>n.type==='input');assert.equal(inputs.length,2);inputs[0].props.onChange({currentTarget:{checked:true}});inputs[1].props.onChange({currentTarget:{checked:true}});assert.deepEqual(calls,[['project',true],['actionable',true]]);assert.match(text(tree),/loaded/i);assert.match(source,/\{inboxCursor&&<button[^\n]+refreshInbox\(true\)/);
});
