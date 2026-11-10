// Author: Jeff.Liu.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import ts from 'typescript';
import * as history from '../src/history.ts';

const source=ts.createSourceFile('SessionInbox.tsx',readFileSync(new URL('../src/SessionInbox.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='SessionInbox');
const {outputText}=ts.transpileModule(declaration.getText(source).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React}});
const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props,children})};
const SessionInbox=new Function('React','t','groupInbox','AttentionCard',outputText+';return SessionInbox;')(
 React,value=>value,history.groupInbox,'AttentionCard');
const nodes=node=>node&&typeof node==='object'?[node,...(node.children??[]).flat(Infinity).flatMap(nodes)]:[];
const receipt=(kind,revision,turn_id='turn')=>({id:kind+revision,kind,revision,turn_id,read:false});
const item=(id,entry,phase=entry.kind,status='running')=>({session:{summary:{session_id:id},status,agent:{phase,integration:'connected',unread_count:1}},receipt:entry});

test('inbox shows waiting and failed sessions first while preserving click provenance',()=>{
 const entries=[item('completed',receipt('response_finished',10)),item('old',receipt('needs_permission',6,'old'),'needs_permission'),
  item('failed',receipt('failed',8),'failed','failed'),{...item('waiting',receipt('needs_permission',2)),current:true}];
 const calls=[];
 const tree=nodes(SessionInbox({items:entries,titleFor:summary=>summary.session_id,selectedId:null,onOpen:(...args)=>calls.push(args),onMarkRead(){}}));
 assert.deepEqual(tree.filter(node=>node.props?.className==='inbox-session-group').map(node=>node.props['aria-label']),['waiting','failed','completed','old']);
 assert.ok(tree.some(node=>node.children?.includes('Needs your attention')));
 const waiting=tree.find(node=>node.type==='AttentionCard'&&node.props.title==='waiting');
 waiting.props.onOpen();
 assert.deepEqual(calls[0],[entries[3].session,entries[3].receipt,undefined,true]);
});

test('selected live identity supersedes a stale summary and promotes only the current receipt',()=>{
 const current=receipt('needs_permission',2),historical=receipt('failed',3,'older');
 const waiting=item('waiting',current),older=item('waiting',historical);
 const agent={phase:'needs_permission',generation:'g',turn_id:'turn',revision:3,integration:'connected',inbox:[current,historical]};
 const args={items:[older,waiting],titleFor:summary=>summary.session_id,selectedId:'waiting',onOpen(){},onMarkRead(){}};
 const selected=nodes(SessionInbox({...args,currentAgent:agent}));
 assert.equal(selected.find(node=>node.type==='AttentionCard').props.entry,current);
 const working=nodes(SessionInbox({...args,currentAgent:{...agent,phase:'working'}}));
 assert.ok(!working.some(node=>node.children?.includes('Needs your attention')));
 assert.equal(working.find(node=>node.type==='AttentionCard').props.entry,historical);
});

test('a read newer approval prevents the older approval in the same turn from becoming current',()=>{
 const old=receipt('needs_permission',1),current={...receipt('needs_permission',2),read:true};
 const waiting=item('waiting',old);
 const agent={phase:'needs_permission',generation:'g',turn_id:'turn',revision:2,integration:'connected',inbox:[old,current]};
 const [group]=history.groupInbox([waiting],'waiting',agent);
 assert.equal(group.priority,2);
});

test('an active earlier approval keeps priority after another same-turn approval resolves',()=>{
 const active={...receipt('needs_permission',1),permission_key:'active'};
 const resolved={...receipt('needs_permission',2),permission_key:'resolved'};
 const entries=[{...item('waiting',resolved),current:false},{...item('waiting',active),current:true}];
 const agent={phase:'needs_permission',generation:'g',turn_id:'turn',revision:3,integration:'connected',
  permission_keys:['active'],inbox:[active,resolved]};
 const [group]=history.groupInbox(entries,'waiting',agent);
 assert.equal(group.priority,0);
 assert.equal(group.receipts[0],active);
});

test('owner-confirmed completion keeps click proof in the ordinary section',()=>{
 const complete={...item('completed',receipt('response_finished',1)),current:true};
 const calls=[];
 const tree=nodes(SessionInbox({items:[complete],titleFor:summary=>summary.session_id,selectedId:null,onOpen:(...args)=>calls.push(args),onMarkRead(){}}));
 assert.ok(tree.some(node=>node.children?.includes('Other unread rounds')));
 tree.find(node=>node.type==='AttentionCard').props.onOpen();
 assert.equal(calls[0][3],true);
});
