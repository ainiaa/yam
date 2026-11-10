// Author: Jeff.Liu. Exercise the actual sidebar callbacks and JSX.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {englishUiRead} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import * as workspaces from '../src/workspaces.ts';
const source=englishUiRead(fs.readFileSync,new URL('../src/App.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),functions=new Map(),buttons=[];
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(tree));if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='button')buttons.push(node);ts.forEachChild(node,visit);}visit(tree);
function actual(name,bindings){assert.ok(functions.has(name),`missing ${name}`);return new Function(...Object.keys(bindings),ts.transpile(functions.get(name),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(bindings));}
test('project creation passes the clicked directory rather than the selected project',()=>{
 const button=buttons.find(node=>node.getText(tree).includes('newSession(project.path)'));assert.ok(button,'project session button');
 const paths=[];const render=new Function('Plus','React','project','newSession','starting','t',ts.transpile('return ('+button.getText(tree)+')',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}));
 const view=render("Plus",{createElement:(type,props)=>({type,props})},{name:'Other',path:'/other'},path=>paths.push(path),false,x=>x);view.props.onClick();assert.deepEqual(paths,['/other']);
});
test('removed projects remain hidden even when history reloads, without losing history',()=>{
 const sessions=[{summary:{cwd:'/gone/'}},{summary:{cwd:'/keep'}}];
 assert.deepEqual(workspaces.groupProjects([{path:'/gone',name:'Gone',hidden:true}],sessions).map(p=>p.path),['/keep']);
 assert.equal(sessions.length,2);
 assert.equal(workspaces.isProjects([{path:'/gone',name:'Gone',hidden:'yes'}]),false);
 assert.equal(workspaces.isProjects([{path:'/gone',name:'Gone',hidden:true}]),true);
 assert.equal(workspaces.groupProjects([{path:'/gone',name:'Restored'}],sessions)[0].sessions.length,1);
});
test('project order skips removed groups and re-adding a directory restores it',async()=>{
 const hidden={path:'/gone',name:'Gone',hidden:true},one={path:'/one',name:'One'},two={path:'/two',name:'Two'};
 assert.deepEqual(workspaces.moveProjectAdjacent([one,hidden,two],'/one','down'),[two,hidden,one]);
 let rows=[hidden];
 await actual('saveProject',{isMainWindow:true,projectPath:'/gone',newProjectName:'Restored',projectName:workspaces.projectName,projectKey:workspaces.projectKey,invoke:async()=>{},projectsRef:{current:rows},commitProjects:next=>rows=next,setProjectError:assert.fail,setActiveProject(){},setCollapsedProjects(){},projectDialog:{current:{close(){}}}})();
 assert.equal(rows[0].hidden,false);assert.equal(workspaces.groupProjects(rows,[]).length,1);
});
function projectDeletionFixture(){
 const intent={path:'/one',name:'One'},other={path:'/two',name:'Two'},errors=[],deleted=[];let rows=[intent,other],closed=0;
 const bindings={...workspaces,isMainWindow:true,projectDeleteRef:{current:intent},projectDeleteBusyRef:{current:false},sessionDeleteBusyRef:{current:false},projectsRef:{current:rows},setProjectDeleteBusy(){},setProjectDeleteError:e=>errors.push(e),setError:e=>errors.push(e),commitProjects:next=>{rows=next;bindings.projectsRef.current=next;},closeProjectDeletion:()=>closed++,setActiveProject(){},activeProject:'/one',collectProjectDeletionTargets:async()=>[],deleteSessionTarget:async target=>deleted.push(target.id),refreshHistory:async()=>{}};
 return {intent,other,bindings,errors,deleted,get rows(){return rows;},get closed(){return closed;},run:()=>actual('confirmProjectDeletion',bindings)(intent)};
}
test('project deletion removes the entry only after all sessions are permanently deleted',async()=>{
 const h=projectDeletionFixture();let scans=0;h.bindings.collectProjectDeletionTargets=async()=>scans++?[]:[{id:'running'},{id:'ended'},{id:'archived'}];
 h.bindings.deleteSessionTarget=async target=>{assert.equal(h.rows.length,2);h.deleted.push(target.id);};
 await h.run();assert.deepEqual(h.deleted,['running','ended','archived']);assert.deepEqual(h.rows,[h.other]);assert.equal(h.closed,1);
});
test('project deletion failures retain the project and reject duplicate or stale confirmation',async()=>{
 const h=projectDeletionFixture();h.bindings.collectProjectDeletionTargets=async()=>[{id:'failed'}];h.bindings.deleteSessionTarget=async()=>{throw Error('disk error');};
 await h.run();assert.equal(h.rows.length,2);assert.equal(h.closed,0);assert.ok(h.errors.some(Boolean));assert.equal(h.bindings.projectDeleteBusyRef.current,false);
 h.bindings.projectDeleteBusyRef.current=true;await h.run();h.bindings.projectDeleteBusyRef.current=false;
 h.bindings.projectsRef.current=[{...h.intent,name:'Renamed'}];await h.run();assert.equal(h.closed,0);
});
test('a session created during project deletion keeps the project available for another confirmation',async()=>{
 const h=projectDeletionFixture();h.bindings.collectProjectDeletionTargets=async()=>[{id:'new'}];await h.run();assert.equal(h.rows.length,2);assert.equal(h.closed,0);
});
test('project deletion enumerates every page, previous run and archive using exact directory identity',async()=>{
 const item=(id,cwd,previous_runs=[])=>({summary:{session_id:id,cwd},previous_runs});const calls=[];
 const targets=await actual('collectProjectDeletionTargets',{projectKey:workspaces.projectKey,invoke:async(name,args)=>{calls.push([name,args]);if(name==='get_session')return item(args.sessionId,args.sessionId==='old'?'/one':'/else');if(name==='list_session_summaries')return args.request.cursor?{items:[item('two','/one-other')],next_cursor:null}:{items:[item('one','/one/',['old','else'])],next_cursor:{offset:100}};return args.request.cursor?{items:[item('archive','/one')],next_cursor:null}:{items:[],next_cursor:{offset:100}};}})('/one');
 assert.deepEqual(targets.map(t=>[t.id,t.archived]),[['one',false],['old',false],['archive',true]]);assert.equal(calls.filter(([n])=>n==='list_archived_sessions').length,2);
});
function deletionFixture(invoke){const target={id:'s-one',title:'One',archived:false,previewId:null};const calls=[],deleted=[],errors=[];let closed=0;
 const bindings={sessionDeleteRef:{current:target},sessionDeleteBusyRef:{current:false},projectDeleteBusyRef:{current:false},isMainWindow:true,setSessionDeleteBusy(){},setTimeout:callback=>callback(),setSessionDeleteError:e=>errors.push(e),invoke:async(name,args)=>{calls.push([name,args]);if(name==='get_session'){const value=await invoke(name,args);return value??{summary:{session_id:args.sessionId},status:'succeeded',agent:{inbox:[]}};}return invoke(name,args);},clearDeletedSessionNames:ids=>deleted.push(...ids),refreshHistory:async()=>calls.push(['refresh']),closeSessionDeletion:()=>closed++};
 bindings.deleteSessionTarget=target=>actual('deleteSessionTarget',bindings)(target);return {target,bindings,calls,deleted,errors,get closed(){return closed;},run:()=>actual('confirmSessionDeletion',bindings)()};}
test('session deletion uses the captured ID, confirms its exact preview, and cleans actual IDs only',async()=>{
 const h=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?{deleted_ids:['s-one'],complete:true,issues:[]}:null);
 await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.closed,1);assert.deepEqual(h.calls.filter(([name])=>name!=='get_session').slice(0,3),[['archive_session',{sessionId:'s-one'}],['preview_archive_deletion',{sessionIds:['s-one']}],['confirm_archive_deletion',{previewId:'token'}]]);
});
test('partial deletion retains the token for retry and never removes undeleted sessions',async()=>{
 let complete=false;const h=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?{deleted_ids:complete?['s-one']:[],complete,issues:['pending']}:null);
 await h.run();assert.deepEqual(h.deleted,[]);assert.equal(h.closed,0);assert.equal(h.target.previewId,'token');complete=true;await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.calls.filter(([name])=>name==='archive_session').length,1);
});
test('archive failure, unrelated preview and reentrant clicks cannot delete another session',async()=>{
 for(const mode of ['archive','preview']){const h=deletionFixture(async name=>{if(name==='get_session')return null;if(mode==='archive')throw Error('Session has pending notifications');return {preview_id:'wrong',session_ids:['s-other']};});await h.run();assert.deepEqual(h.deleted,[]);assert.equal(h.closed,0);assert.equal(h.calls.some(([name])=>name==='confirm_archive_deletion'),false);assert.ok(h.errors.some(Boolean));}
 const h=deletionFixture(()=>assert.fail('busy'));h.bindings.sessionDeleteBusyRef.current=true;await h.run();assert.deepEqual(h.calls,[]);
});
test('delete dialogs are mounted before showModal and project deletion includes derived groups',()=>{
 const dialogs=[];function scan(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='dialog'&&/ref=\{(?:projectDeleteDialog|sessionDeleteDialog)\}/.test(node.getText(tree)))dialogs.push(node);ts.forEachChild(node,scan);}scan(tree);
 assert.equal(dialogs.length,2);for(const dialog of dialogs)assert.ok(!ts.isBinaryExpression(dialog.parent));
 const button=buttons.find(node=>node.getText(tree).includes('deleteProject(project)'));assert.ok(!ts.isBinaryExpression(button.parent));
});
test('running sessions open a confirmation and cancellation never mutates history',()=>{
 const shown=[],errors=[];const state={isMainWindow:true,sessionDeleteBusyRef:{current:false},projectDeleteBusyRef:{current:false},selectedRecord:{current:null},setError:e=>errors.push(e),sessionDeleteRef:{current:null},setSessionDelete:v=>shown.push(v),setSessionDeleteError(){},sessionDeleteDialog:{current:{showModal(){}}},titleFor:()=> 'One'};
 actual('beginSessionDeletion',state)({summary:{session_id:'s-one'},status:'running'});assert.equal(shown.length,1);assert.equal(shown[0].stopBeforeDelete,true);assert.equal(errors.length,0);
 actual('beginSessionDeletion',state)({summary:{session_id:'s-one'},status:'stopped'});assert.equal(shown.length,2);assert.equal(shown[1].stopBeforeDelete,false);
 const commands=[];actual('closeSessionDeletion',{...state,setSessionDelete:()=>{},sessionDeleteDialog:{current:{close(){}}},invoke:async name=>commands.push(name)})();assert.equal(state.sessionDeleteRef.current,null);assert.deepEqual(commands,[]);
});
test('lost deletion reply retries the same token and rejects unrelated result IDs',async()=>{
 let attempts=0;const h=deletionFixture(async name=>{if(name==='preview_archive_deletion')return {preview_id:'token',session_ids:['s-one']};if(name==='confirm_archive_deletion'){if(attempts++===0)throw Error('connection lost');return {deleted_ids:['s-one'],complete:true,issues:[]};}});
 await h.run();assert.equal(h.target.previewId,'token');await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.calls.filter(([name])=>name==='preview_archive_deletion').length,1);
 const wrong=deletionFixture(async name=>name==='get_session'?null:name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:{deleted_ids:['s-other'],complete:true,issues:[]});await wrong.run();assert.deepEqual(wrong.deleted,[]);assert.equal(wrong.closed,0);
});
test('session actions live in a context menu instead of inline buttons',()=>{
 assert.ok(source.includes('onContextMenu={event=>{event.preventDefault();'));
 assert.ok(source.includes('role="menu"'));
 assert.ok(!source.includes('className="session-pin"'));
});
test('delete confirmation has dedicated spacing and an accessible description',()=>{
 assert.ok(source.includes('className="app-dialog session-delete-dialog confirmation-dialog"'));
 assert.ok(source.includes('aria-describedby="session-delete-description"'));
 assert.ok(source.includes('className="dialog-body"'));
});
test('session context menu stays inside the window and focuses its first action',()=>{
 let focused=0;const actions={style:{},offsetWidth:180,offsetHeight:90,querySelector:()=>({focus:()=>focused++})};
 const menu={open:false,querySelector:()=>actions},row={parentElement:{querySelector:()=>menu}};
 const open=actual('openSessionMenu',{window:{innerWidth:800,innerHeight:600}});
 open(row,795,595);assert.equal(menu.open,true);assert.deepEqual(actions.style,{left:'612px',top:'502px'});assert.equal(focused,1);
 open(row,-10,-10);assert.deepEqual(actions.style,{left:'8px',top:'8px'});
 open({parentElement:null},10,10);menu.querySelector=()=>null;open(row,10,10);assert.equal(focused,2);
});


test('project and workspace action menus stay in the window and open above a bottom anchor',()=>{
 for(const [anchor,expectedTop] of [[{top:100,bottom:128,right:220},134],[{top:700,bottom:728,right:220},434]]){
  const actions={offsetWidth:232,offsetHeight:260,style:{}};
  actual('positionProjectMenu',{window:{innerWidth:800,innerHeight:760}})({open:true,getBoundingClientRect:()=>anchor,querySelector:()=>actions});
  assert.equal(actions.style.left,'8px');assert.equal(actions.style.top,expectedTop+'px');
 }
});

function activeDeletionFixture(options={}){
 let reads=0,archives=0;
 const h=deletionFixture(async(name,args)=>{
  if(name==='get_session'){reads++;return {summary:{session_id:'s-one'},status:options.neverStops?'running':reads<3?'running':'stopped',notification_pending:!!options.pending,agent:{inbox:options.agent?[{id:'receipt-one',revision:7,read:false,delivery:'pending'}]:[]}};}
  if(name==='stop_session'&&options.stopFailure)throw Error('Stop failed');
  if(name==='read_agent_receipt')options.agent=false;
  if(name==='archive_session'){if(options.agent)throw Error('Session has pending notifications');archives++;if(options.finalizing&&archives===1)throw 'Session is still finalizing';}
  if(name==='acknowledge_notification'&&options.ackFailure)throw Error('Acknowledgement failed');
  if(name==='preview_archive_deletion')return {preview_id:'token',session_ids:['s-one']};
  if(name==='confirm_archive_deletion')return {deleted_ids:['s-one'],complete:true,issues:[]};
 });h.target.stopBeforeDelete=true;return h;
}
test('confirmed active deletion stops only the captured session and waits before archiving',async()=>{
 const h=activeDeletionFixture({finalizing:true,pending:true});await h.run();
 assert.equal(h.closed,1);assert.deepEqual(h.deleted,['s-one']);
 assert.deepEqual(h.calls.filter(([n])=>n==='stop_session'),[['stop_session',{sessionId:'s-one'}]]);
 assert.ok(h.calls.findIndex(([n])=>n==='stop_session')<h.calls.findIndex(([n])=>n==='archive_session'));
 assert.equal(h.calls.filter(([n])=>n==='archive_session').length,2);
 assert.deepEqual(h.calls.find(([n])=>n==='acknowledge_notification'),['acknowledge_notification',{sessionId:'s-one',expectedStatus:'stopped'}]);
});
test('stop failure or stop timeout preserves the session without archive or deletion',async()=>{
 for(const options of [{stopFailure:true},{neverStops:true},{pending:true,ackFailure:true}]){
  const h=activeDeletionFixture(options);await h.run();assert.equal(h.closed,0);assert.deepEqual(h.deleted,[]);assert.equal(h.target.archived,false);assert.ok(h.errors.some(Boolean));assert.equal(h.calls.some(([n])=>n==='archive_session'||n==='confirm_archive_deletion'),false);assert.equal(h.bindings.sessionDeleteBusyRef.current,false);
 }
});
test('natural completion before confirmation skips stopping and double clicks share one deletion',async()=>{
 const h=activeDeletionFixture();const previous=h.bindings.invoke;h.bindings.invoke=async(name,args)=>name==='get_session'?{summary:{session_id:'s-one'},status:'succeeded'}:previous(name,args);
 const first=h.run();await h.run();await first;assert.equal(h.closed,1);assert.equal(h.calls.some(([n])=>n==='stop_session'),false);assert.equal(h.calls.filter(([n])=>n==='confirm_archive_deletion').length,1);
});
test('active deletion is enabled in the sidebar and warns before stopping',()=>{
 const button=buttons.find(node=>node.getText(tree).includes('beginSessionDeletion(record)'));assert.ok(button);const render=new Function('React','record','beginSessionDeletion','t','Trash2',ts.transpile('return ('+button.getText(tree)+')',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}));
 for(const status of ['starting','running','stopped'])assert.equal(render({createElement:(type,props)=>({type,props})},{status},()=>{},x=>x,'Trash2').props.disabled,false);
 assert.match(source,/Stop and delete/);assert.match(source,/will be stopped before/);
});

test('confirmed deletion acknowledges only its own unread Agent receipts before archiving',async()=>{
 const h=activeDeletionFixture({agent:true});await h.run();assert.equal(h.closed,1);
 assert.deepEqual(h.calls.find(([n])=>n==='read_agent_receipt'),['read_agent_receipt',{sessionId:'s-one',receipt:'receipt-one',revision:7}]);
});

test('ended session deletion clears unread receipts and pending notification before archive',async()=>{
 const h=deletionFixture(async name=>name==='get_session'?{summary:{session_id:'s-one'},status:'succeeded',notification_pending:true,agent:{inbox:[{id:'unread',revision:4,read:false,delivery:'pending'}]}}:name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?{deleted_ids:['s-one'],complete:true}:null);
 await h.run();assert.equal(h.closed,1);assert.ok(h.calls.findIndex(([n])=>n==='read_agent_receipt')<h.calls.findIndex(([n])=>n==='archive_session'));assert.ok(h.calls.some(([n])=>n==='acknowledge_notification'));
});

test('expired deletion preview can be regenerated on retry',async()=>{
 let attempts=0;const h=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?(attempts++===0?Promise.reject('Deletion preview expired; preview again'):{deleted_ids:['s-one'],complete:true}):null);
 await h.run();assert.equal(h.target.previewId,null);await h.run();assert.equal(h.closed,1);assert.equal(h.calls.filter(([n])=>n==='preview_archive_deletion').length,2);
});
test('project deletion retry keeps completed targets and failed target preview',async()=>{
 const h=projectDeletionFixture();let scans=0,attempts=0;
 h.bindings.collectProjectDeletionTargets=async()=>scans++?[]:[{id:'a',archived:true},{id:'b',archived:true}];
 h.bindings.invoke=async(name,args)=>name==='preview_archive_deletion'?{preview_id:args.sessionIds[0],session_ids:args.sessionIds}:args.previewId==='b'&&attempts++===0?{deleted_ids:[],complete:false}:{deleted_ids:[args.previewId],complete:true};
 h.bindings.clearDeletedSessionNames=ids=>h.deleted.push(...ids);
 h.bindings.deleteSessionTarget=target=>actual('deleteSessionTarget',h.bindings)(target);
 await h.run();assert.deepEqual(h.deleted,['a']);assert.equal(h.closed,0);await h.run();assert.deepEqual(h.deleted,['a','b']);assert.equal(h.closed,1);
});
test('project storage failure preserves retry and cancel while deleting keeps intent',async()=>{
 const h=projectDeletionFixture();h.bindings.commitProjects=()=>{throw Error('storage');};await h.run();assert.equal(h.closed,0);assert.equal(h.rows.length,2);
 const ref={current:h.intent};let closed=0;
 const bindings={projectDeleteBusyRef:{current:true},projectDeleteRef:ref,setProjectDelete(){},projectDeleteDialog:{current:{close:()=>closed++}}};
 actual('closeProjectDeletion',bindings)();assert.equal(ref.current,h.intent);bindings.projectDeleteBusyRef.current=false;actual('closeProjectDeletion',bindings)();assert.equal(ref.current,null);assert.equal(closed,1);
});
