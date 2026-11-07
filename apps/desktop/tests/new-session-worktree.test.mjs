// Author: Jeff.Liu. Exercise actual launch callbacks without Git mutation or GUI startup.
import './fixtures/i18n-test-init.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {isGitContext} from '../src/git-context.ts';
import {canStartWorktree} from '../src/worktree-controls.ts';
import {selectProjectDirectory} from '../src/workspaces.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(predicate,root=source){const result=[];function walk(node){if(predicate(node))result.push(node);ts.forEachChild(node,walk);}walk(root);return result;}
function actual(name,values){const fn=nodes(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)[0];assert.ok(fn,`actual ${name} exists`);return new Function(...Object.keys(values),ts.transpile(fn.getText(source),{target:ts.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(values));}
const context={kind:'repository',root:'/repo',branch:'main',dirty:false,common_dir:'/repo/.git'};
const record={attempt:'a'.repeat(64),session_id:'s-reserved',repository:'/repo',common_dir:'/repo/.git',target:'/repo-worktrees/task-1234abcd',branch:'codex/task-1234abcd',commit:'b'.repeat(40),state:'created',checkout_complete:true,session_claimed:false};
function fixture(extra={}){
 const calls=[],values={isMainWindow:true,starting:false,creatingSession:{current:false},cwd:'/repo/subdir',launchWorkspace:null,launchWorktreeAttempt:undefined,selectedWorktree:null,gitOwner:1,sessionCopyIntent:{current:0},ownerConnectionAvailable:{current:{available:true,version:1}},launchDialog:{current:{open:true}},isGitContext,canStartWorktree,cancelProjectPreview:()=>calls.push('cancel trust'),setProjectTemplate:value=>calls.push(['template',value]),setLaunchWorkspace:value=>calls.push(['workspace',value]),setLaunchWorktreeAttempt:value=>calls.push(['attempt',value]),setLaunchDirectoryOverride:value=>calls.push(['override',value]),setCwd:value=>calls.push(['cwd',value]),setSelectedWorktree:value=>calls.push(['selected',value]),setError:value=>calls.push(['error',value]),invoke:async(name,args)=>{calls.push([name,args]);return context;},...extra};return{calls,values,run:name=>actual(name,values)};
}

test('isolated choice resolves the selected directory to its repository without creating or starting',async()=>{
 const f=fixture();await f.run('selectLaunchWorkspace')(true);
 assert.deepEqual(f.calls.filter(call=>Array.isArray(call)&&call[0]==='get_git_context'),[['get_git_context',{path:'/repo/subdir'}]]);
 const workspace=f.calls.filter(call=>call[0]==='workspace').at(-1)[1];assert.equal(workspace.root,'/repo');assert.equal(workspace.intent,1);assert.equal(workspace.owner,1);
 assert.ok(!f.calls.some(call=>['cwd','selected','create_worktree','create_session'].includes(call[0])));
});

test('current-directory choice reuses the displayed created directory without a new worktree or reserved attempt',async()=>{
 const f=fixture({cwd:record.target,launchWorkspace:{source:'/repo/subdir',root:'/repo',intent:0,owner:1},launchWorktreeAttempt:record.attempt});await f.run('selectLaunchWorkspace')(false);
 assert.ok(f.calls.includes('cancel trust'),'switching back cannot retain trusted settings from the isolated directory');
 assert.ok(f.calls.some(call=>call[0]==='override'&&call[1]===record.target));assert.ok(!f.calls.some(call=>call[0]==='cwd'));assert.ok(f.calls.some(call=>call[0]==='workspace'&&call[1]===null));assert.ok(f.calls.some(call=>call[0]==='attempt'&&call[1]===undefined));assert.ok(!f.calls.some(call=>['create_session','create_worktree','cleanup_worktree'].includes(call[0])));
});

test('cancellation, owner replacement and a new draft fence late repository lookup results',async()=>{
 for(const change of ['cancel','owner','closed'])for(const fail of [false,true]){
  let settle;const wait=new Promise((resolve,reject)=>{settle=fail?reject:resolve;}),f=fixture({invoke:()=>wait});const pending=f.run('selectLaunchWorkspace')(true);
  if(change==='owner')f.values.ownerConnectionAvailable.current.version++;else if(change==='closed')f.values.launchDialog.current.open=false;else f.values.sessionCopyIntent.current++;
  const before=structuredClone(f.calls);settle(fail?Error('private'):context);await pending;assert.deepEqual(f.calls,before);
 }
});

test('invalid or unavailable repositories remain blocked until Current directory or a fresh selection',async()=>{
 for(const result of [null,{kind:'not_repository',branch:null,dirty:null,root:null,common_dir:null}]){const f=fixture({invoke:async()=>result});await f.run('selectLaunchWorkspace')(true);assert.ok(f.calls.some(call=>call[0]==='error'&&typeof call[1]==='string'));assert.ok(!f.calls.some(call=>call[0]==='create_worktree'||call[0]==='create_session'));}
});
test('offline isolation selection reports unavailable without issuing a repository request',async()=>{
 const f=fixture({ownerConnectionAvailable:{current:{available:false,version:1}}});await f.run('selectLaunchWorkspace')(true);assert.ok(f.calls.some(call=>call[0]==='error'&&typeof call[1]==='string'));assert.ok(!f.calls.some(call=>call[0]==='get_git_context'||call[0]==='workspace'));
});
test('stale or disconnected worktree drafts hide creation and offer an explicit recovery path',()=>{
 const control=nodes(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='WorktreeControls'&&node.attributes.properties.some(attr=>attr.name?.text==='creationOnly'))[0];assert.ok(control);let expression=control.parent;while(expression&&!ts.isJsxExpression(expression))expression=expression.parent;assert.ok(expression);
 const render=owner=>{const values={launchWorkspace:{root:'/repo',owner:1,intent:2},launchWorktreeAttempt:undefined,ownerConnectionAvailable:{current:owner},gitOwner:2,error:null,launchWorktreeCreated(){},WorktreeControls:'WorktreeControls',t:value=>value,React:{createElement:(tag,props,...children)=>({tag,props,children})}};return new Function(...Object.keys(values),ts.transpileModule('return '+expression.expression.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText)(...Object.values(values));};
 assert.ok(JSON.stringify(render({available:true,version:1})).includes('WorktreeControls'));
 for(const owner of [{available:true,version:2},{available:false,version:1}]){const view=JSON.stringify(render(owner));assert.ok(!view.includes('WorktreeControls'));assert.match(view,/Current directory/);}
});

test('created worktree is bound to the same open draft and only prepares its existing reserved start',()=>{
 const workspace={source:'/repo/subdir',root:'/repo',owner:1,intent:2},f=fixture({launchWorkspace:workspace,sessionCopyIntent:{current:2}});f.run('launchWorktreeCreated')(record,'/repo',1);
 for(const [name,value] of [['attempt',record.attempt],['cwd',record.target],['override',record.target]])assert.ok(f.calls.some(call=>call[0]===name&&call[1]===value));
 assert.ok(!f.calls.some(call=>['create_session','create_worktree'].includes(call[0])));
 for(const extra of [{sessionCopyIntent:{current:3}},{launchDialog:{current:{open:false}}},{ownerConnectionAvailable:{current:{available:true,version:2}}},{gitOwner:2}]){const stale=fixture({launchWorkspace:workspace,sessionCopyIntent:{current:2},...extra});stale.run('launchWorktreeCreated')(record,'/repo',1);assert.deepEqual(stale.calls,[]);}
 const failed=fixture({launchWorkspace:workspace,sessionCopyIntent:{current:2}});failed.run('launchWorktreeCreated')({...record,state:'failed'},'/repo',1);assert.deepEqual(failed.calls,[]);
});

test('Start cannot fall back to the source directory while isolated creation is incomplete',async()=>{
 const f=fixture({launchWorkspace:{root:'/repo',source:'/repo/subdir',owner:1,intent:0},formAdapter:'codex',formLaunch:{},sessionTerminal:'yam',useProjectSettings:false,startSession:()=>assert.fail('must not launch source'),newTerminal:()=>assert.fail('must not launch source')});await f.run('startNewSession')();assert.ok(f.calls.some(call=>call[0]==='error'&&typeof call[1]==='string'));
});

test('a directory pick still being validated cannot overwrite a newer isolated-workspace selection',async()=>{
 for(const fail of [false,true]){
  let finish,started;const waiting=new Promise((resolve,reject)=>{finish=fail?reject:resolve;}),validationStarted=new Promise(resolve=>{started=resolve;});
  const f=fixture({selectProjectDirectory,openDirectoryDialog:async()=>'/different/repo',invoke:async(name)=>{if(name==='validate_project_directory'){started();return waiting;}return context;}});
  const pick=f.run('chooseDirectory')('launch');await validationStarted;await f.run('selectLaunchWorkspace')(true);const before=structuredClone(f.calls);
  finish(fail?Error('obsolete directory failure'):undefined);await pick;assert.deepEqual(f.calls,before);
 }
});

test('new-session markup reuses the creation-only worktree control and keeps Start separate',()=>{
 const dialog=nodes(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='dialog'&&node.openingElement.attributes.properties.some(attr=>attr.name?.text==='aria-labelledby'&&attr.initializer?.text==='launch-title'))[0];assert.ok(dialog);
 const controls=nodes(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='WorktreeControls',dialog);assert.equal(controls.length,1);assert.match(controls[0].getText(source),/creationOnly/);assert.match(controls[0].getText(source),/onCreated=\{launchWorktreeCreated\}/);
 const text=dialog.getText(source);assert.match(text,/Current directory/);assert.match(text,/Isolated worktree/);assert.match(text,/launchWorkspace.*!launchWorktreeAttempt/);
});
