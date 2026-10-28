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
test('delete project persists before closing and handles stale targets and failed writes',()=>{
 const project={path:'/one',name:'One'},other={path:'/two',name:'Two'},intent={...project};let rows=[project,other],closed=0;const errors=[];
 const bindings={...workspaces,isMainWindow:true,projectDeleteRef:{current:intent},projectsRef:{current:rows},commitProjects:next=>{rows=next;},closeProjectDeletion:()=>closed++,setError:e=>errors.push(e),setActiveProject(){},activeProject:'/one'};
 actual('confirmProjectDeletion',bindings)(intent);assert.equal(rows.find(p=>p.path==='/one').hidden,true);assert.equal(rows[1],other);assert.equal(closed,1);
 bindings.commitProjects=()=>{throw Error('storage');};actual('confirmProjectDeletion',bindings)(intent);assert.equal(closed,1);assert.equal(errors.length,1);
 bindings.projectDeleteRef.current=null;actual('confirmProjectDeletion',bindings)(intent);assert.equal(errors.length,1);
 bindings.projectDeleteRef.current=intent;bindings.isMainWindow=false;actual('confirmProjectDeletion',bindings)(intent);assert.equal(errors.length,1);
});
function deletionFixture(invoke){const target={id:'s-one',title:'One',archived:false,previewId:null};const calls=[],deleted=[],errors=[];let closed=0;
 const bindings={sessionDeleteRef:{current:target},sessionDeleteBusyRef:{current:false},isMainWindow:true,setSessionDeleteBusy(){},setSessionDeleteError:e=>errors.push(e),invoke:async(name,args)=>{calls.push([name,args]);return invoke(name,args);},clearDeletedSessionNames:ids=>deleted.push(...ids),refreshHistory:async()=>calls.push(['refresh']),closeSessionDeletion:()=>closed++};
 return {target,bindings,calls,deleted,errors,get closed(){return closed;},run:()=>actual('confirmSessionDeletion',bindings)()};}
test('session deletion uses the captured ID, confirms its exact preview, and cleans actual IDs only',async()=>{
 const h=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?{deleted_ids:['s-one'],complete:true,issues:[]}:null);
 await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.closed,1);assert.deepEqual(h.calls.slice(0,3),[['archive_session',{sessionId:'s-one'}],['preview_archive_deletion',{sessionIds:['s-one']}],['confirm_archive_deletion',{previewId:'token'}]]);
});
test('partial deletion retains the token for retry and never removes undeleted sessions',async()=>{
 let complete=false;const h=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:name==='confirm_archive_deletion'?{deleted_ids:complete?['s-one']:[],complete,issues:['pending']}:null);
 await h.run();assert.deepEqual(h.deleted,[]);assert.equal(h.closed,0);assert.equal(h.target.previewId,'token');complete=true;await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.calls.filter(([name])=>name==='archive_session').length,1);
});
test('archive failure, unrelated preview and reentrant clicks cannot delete another session',async()=>{
 for(const mode of ['archive','preview']){const h=deletionFixture(async name=>{if(mode==='archive')throw Error('Session has pending notifications');return {preview_id:'wrong',session_ids:['s-other']};});await h.run();assert.deepEqual(h.deleted,[]);assert.equal(h.closed,0);assert.equal(h.calls.some(([name])=>name==='confirm_archive_deletion'),false);assert.ok(h.errors.some(Boolean));}
 const h=deletionFixture(()=>assert.fail('busy'));h.bindings.sessionDeleteBusyRef.current=true;await h.run();assert.deepEqual(h.calls,[]);
});
test('delete dialogs are mounted before showModal and project deletion includes derived groups',()=>{
 const dialogs=[];function scan(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='dialog'&&/ref=\{(?:projectDeleteDialog|sessionDeleteDialog)\}/.test(node.getText(tree)))dialogs.push(node);ts.forEachChild(node,scan);}scan(tree);
 assert.equal(dialogs.length,2);for(const dialog of dialogs)assert.ok(!ts.isBinaryExpression(dialog.parent));
 const button=buttons.find(node=>node.getText(tree).includes('deleteProject(project)'));assert.ok(!ts.isBinaryExpression(button.parent));
});
test('running sessions and cancelled confirmations never mutate history',()=>{
 const shown=[],errors=[];const state={isMainWindow:true,sessionDeleteBusyRef:{current:false},selectedRecord:{current:null},setError:e=>errors.push(e),sessionDeleteRef:{current:null},setSessionDelete:v=>shown.push(v),setSessionDeleteError(){},sessionDeleteDialog:{current:{showModal(){}}},titleFor:()=> 'One'};
 actual('beginSessionDeletion',state)({summary:{session_id:'s-one'},status:'running'});assert.equal(shown.length,0);assert.equal(errors.length,1);
 actual('beginSessionDeletion',state)({summary:{session_id:'s-one'},status:'stopped'});assert.equal(shown.length,1);
 const commands=[];actual('closeSessionDeletion',{...state,setSessionDelete:()=>{},sessionDeleteDialog:{current:{close(){}}},invoke:async name=>commands.push(name)})();assert.equal(state.sessionDeleteRef.current,null);assert.deepEqual(commands,[]);
});
test('deleted project intent uses its own full path for derived groups and rejects renamed targets',()=>{
 const intent={path:'/first/api',name:'API'},other={path:'/second/api',name:'API'},ref={current:intent};let saved=null;const errors=[];
 const bindings={...workspaces,isMainWindow:true,projectDeleteRef:ref,projectsRef:{current:[other]},commitProjects:next=>saved=next,activeProject:'',setActiveProject(){},closeProjectDeletion(){},setError:error=>errors.push(error)};
 actual('confirmProjectDeletion',bindings)(intent);assert.equal(saved[0],other);assert.equal(saved[1].path,intent.path);assert.equal(saved[1].hidden,true);assert.equal(typeof saved[1].hiddenBefore,'number');
 bindings.projectsRef.current=[{...intent,name:'Renamed'},other];saved=null;actual('confirmProjectDeletion',bindings)(intent);assert.equal(saved,null);assert.equal(errors.length,1);
});
test('lost deletion reply retries the same token and rejects unrelated result IDs',async()=>{
 let attempts=0;const h=deletionFixture(async name=>{if(name==='preview_archive_deletion')return {preview_id:'token',session_ids:['s-one']};if(name==='confirm_archive_deletion'){if(attempts++===0)throw Error('connection lost');return {deleted_ids:['s-one'],complete:true,issues:[]};}});
 await h.run();assert.equal(h.target.previewId,'token');await h.run();assert.deepEqual(h.deleted,['s-one']);assert.equal(h.calls.filter(([name])=>name==='preview_archive_deletion').length,1);
 const wrong=deletionFixture(async name=>name==='preview_archive_deletion'?{preview_id:'token',session_ids:['s-one']}:{deleted_ids:['s-other'],complete:true,issues:[]});await wrong.run();assert.deepEqual(wrong.deleted,[]);assert.equal(wrong.closed,0);
});
test('session actions live in a context menu instead of inline buttons',()=>{
 assert.ok(source.includes('onContextMenu={event=>{event.preventDefault();'));
 assert.ok(source.includes('role="menu"'));
 assert.ok(!source.includes('className="session-pin"'));
});
test('delete confirmation has dedicated spacing and an accessible description',()=>{
 assert.ok(source.includes('className="app-dialog session-delete-dialog"'));
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
