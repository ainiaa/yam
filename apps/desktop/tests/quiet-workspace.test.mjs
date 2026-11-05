// Author: Jeff.Liu. Presentation changes retain receipt identity and existing lifecycle actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as history from '../src/history.ts';
import {captureAttention} from '../src/attention-actions.ts';
import {t,setLocale} from '../src/i18n.ts';
setLocale('en');
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
function item(id,revision,options={}){return {session:{summary:{session_id:id,title:id,cwd:'/fixture'},status:'running',agent:{unread_count:options.count??1}},receipt:{id:options.receiptId??id+'-'+revision,revision,turn_id:'turn-'+revision,kind:'response_finished',read:false,delivery:'accepted',error:null,...options.receipt}};}
function group(items){assert.equal(typeof history.groupInbox,'function');return history.groupInbox(items);}
test('inbox groups by session, keeps latest revision first and preserves all originals',()=>{
 const items=[item('one',1,{count:3}),item('two',2),item('one',4,{count:3}),item('one',3,{count:3})],before=JSON.stringify(items),groups=group(items);
 assert.equal(groups.length,2);assert.equal(groups[0].session.summary.session_id,'one');assert.deepEqual(groups[0].receipts.map(r=>r.revision),[4,3,1]);assert.equal(groups[0].unreadCount,3);assert.equal(JSON.stringify(items),before);
});
test('empty inbox, duplicates across pages and read receipts do not create extra groups',()=>{
 assert.deepEqual(group([]),[]);const old=item('one',1,{receiptId:'same'}),newer=item('one',2,{receiptId:'same'});assert.equal(group([old,newer,newer])[0].receipts.length,1);assert.equal(group([old,newer])[0].receipts[0].revision,2);assert.deepEqual(group([item('one',1,{receipt:{read:true}})]),[]);
});
test('partial inbox pages show authoritative unread totals without claiming every notice was loaded',()=>{
 const groups=group([item('one',1,{count:150}),item('one',2,{count:150})]);assert.equal(groups[0].unreadCount,150);assert.equal(groups[0].receipts.length,2);
});
function compile(file,name,bindings){assert.ok(existsSync(new URL('../src/'+file,import.meta.url)),file);const raw=readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)fn=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(fn,name);return new Function(...Object.keys(bindings),ts.transpile(fn.replace(/^export\s+/,''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})+';return '+name)(...Object.values(bindings));}
test('grouped inbox renders one latest card per session and older receipts in a closed disclosure',()=>{
 const Card=compile('AttentionCard.tsx','AttentionCard',{React,t,captureAttention}),Inbox=compile('SessionInbox.tsx','SessionInbox',{React,t,groupInbox:history.groupInbox,AttentionCard:Card});let opened=0;
 const markup=renderToStaticMarkup(React.createElement(Inbox,{items:[item('one',1,{count:3}),item('one',3,{count:3}),item('one',2,{count:3}),item('two',1)],titleFor:s=>s.title,selectedId:null,currentAgent:undefined,onOpen:()=>opened++}));
 assert.equal((markup.match(/class="inbox-session-group"/g)||[]).length,2);assert.ok(markup.includes('<details'));assert.ok(!markup.includes('<details open'));assert.equal(opened,0);assert.equal((markup.match(/class="attention-card"/g)||[]).length,4);
});
test('session ellipsis is keyboard reachable and uses the existing menu with two group separators',()=>{
 const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let menu;function visit(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='details'&&n.openingElement.getText(ast).includes('session-context-menu'))menu=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(menu);const raw=menu.getText(ast);assert.match(raw,/session-menu-trigger/);assert.match(raw,/Actions for session/);assert.doesNotMatch(raw,/tabIndex=\{-1\}/);assert.match(raw,/desktop-menu/);assert.equal((raw.match(/role="separator"/g)||[]).length,2);assert.match(raw,/beginSessionDeletion\(record\)/);assert.match(css,/session-item:focus-within/);assert.match(css,/session-menu-trigger[^}]*opacity/);
});
test('project and session confirmations share structure and deletion recovery is collapsed',()=>{
 assert.equal((source.match(/confirmation-dialog/g)||[]).length,2);assert.match(source,/aria-describedby="project-delete-description"/);assert.match(source,/<details className="confirmation-details">/);assert.match(css,/\.confirmation-dialog \.dialog-actions/);assert.match(source,/<SessionInbox items=\{inbox\}/);
});

test('compact notice keeps explanations in a closed disclosure and performs no action on render',()=>{
 const Card=compile('AttentionCard.tsx','AttentionCard',{React,t,captureAttention});let opened=0;const entry=item('one',1);
 const markup=renderToStaticMarkup(React.createElement(Card,{record:entry.session,entry:entry.receipt,title:'One',hideTitle:true,compact:true,onOpen:()=>opened++}));
 assert.match(markup,/<details class="attention-notice-details">/);assert.ok(!markup.includes('<details open'));assert.ok(markup.includes('View this round in the terminal'));assert.equal(opened,0);
});
test('historical inbox notice exposes a separate explicit read action with exact identity',()=>{
 const Card=compile('AttentionCard.tsx','AttentionCard',{React,t,captureAttention}),Inbox=compile('SessionInbox.tsx','SessionInbox',{React,t,groupInbox:history.groupInbox,AttentionCard:Card}),calls=[];
 const entry=item('old',1),tree=Inbox({items:[entry],titleFor:s=>s.title,selectedId:'other',onOpen:()=>assert.fail('must not navigate'),onMarkRead:(record,receipt)=>calls.push([record.summary.session_id,receipt.id,receipt.revision])});
 const card=tree.props.children[0].props.children[1];const rendered=Card(card.props);const buttons=React.Children.toArray(rendered.props.children).filter(child=>child?.type==='button');
 assert.equal(buttons.length,2);assert.equal(buttons[1].props.children,'Mark as read');buttons[1].props.onClick();assert.deepEqual(calls,[['old','old-1',1]]);
});

test('latest and earlier notice actions retain exact receipt identity and selected-session proof',()=>{
 const Card=()=>null,Inbox=compile('SessionInbox.tsx','SessionInbox',{React,t,groupInbox:history.groupInbox,AttentionCard:Card}),calls=[],agent={generation:'current'};
 const props={items:[item('one',1),item('one',3),item('one',2)],titleFor:s=>s.title,selectedId:'one',currentAgent:agent,onOpen:(record,receipt,proof)=>calls.push([record.summary.session_id,receipt.id,proof])};
 const section=Inbox(props).props.children[0],latest=section.props.children[1],older=section.props.children[2].props.children[1];
 assert.equal(calls.length,0);latest.props.onOpen();older[1].props.onOpen();assert.deepEqual(calls,[['one','one-3',agent],['one','one-1',agent]]);
 const historical=Inbox({...props,selectedId:'other'}).props.children[0].props.children[1];assert.equal(historical.props.agent,undefined);
});
