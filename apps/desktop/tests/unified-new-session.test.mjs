import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. All generic entry points prepare one dialog; terminal starts retain the existing path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {paletteEntries} from '../src/command-palette.ts';
import {shortcutLabels,defaultAppShortcuts,resolveAppShortcut} from '../src/app-shortcuts.ts';
import {terminalProfileStart} from '../src/terminal-profiles.ts';
import {supportsProvider} from '../src/provider-config.ts';
import {selectProjectDirectory} from '../src/workspaces.ts';
import {zshDirectoryReportingEligible} from '../src/zsh-directory-reporting.ts';
import {zshCommandReportingEligible} from '../src/zsh-command-reporting.ts';

const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(predicate,root=source){const found=[];function visit(n){if(predicate(n))found.push(n);ts.forEachChild(n,visit);}visit(root);return found;}
function actual(name,bindings){bindings={sessionTerminal:"yam",setLaunchWorktreeAttempt(){},...bindings};const fn=nodes(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)[0];assert.ok(fn,name);return new Function(...Object.keys(bindings),ts.transpile(fn.getText(source),{target:ts.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(bindings));}

test('the primary new-session button opens the same session dialog',()=>{
 const buttons=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='button');
 assert.equal(buttons.filter(n=>n.getText(source).includes('newTerminal(')).length,0,'no generic button starts a shell directly');
 const entries=buttons.filter(n=>n.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='onClick'&&a.initializer?.getText(source).includes('newSession(')));
 assert.equal(entries.length,1,'one visible primary entry');
 for(const entry of entries){
  const click=entry.openingElement.attributes.properties.find(a=>a.name?.getText(source)==='onClick').initializer.expression;
  const calls=[];new Function('newSession','project',ts.transpile('return ('+click.getText(source)+');',{target:ts.ScriptTarget.ES2022}))(path=>calls.push(path),{path:'/project'})();
  assert.deepEqual(calls,[entry.getText(source).includes('project.path')?'/project':undefined]);assert.match(entry.getText(source),/New session/);
 }
 assert.equal(buttons.filter(n=>n.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='className'&&a.initializer?.text==='new-session-button')).length,1);
 assert.equal(source.text.includes('New Agent / command'),false);
});

test('command palette exposes one new-session command and keeps the existing shortcut storage identity',()=>{
 const entries=paletteEntries('New',[],false);assert.deepEqual(entries.map(row=>[row.action,row.label]),[['new','New session']]);
 assert.equal(shortcutLabels.terminal,'New session');
 assert.equal(resolveAppShortcut({key:'n',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false,isComposing:false,repeat:false},defaultAppShortcuts(true),true),'terminal');
 const handler=nodes(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleShortcut')[0].getText(source);
 assert.match(handler,/action==="terminal"\)\s*(?:void )?newSession\(/);assert.equal(handler.includes('newTerminal('),false);
});

test('Terminal uses the existing terminal launcher, while Agent and explicit project/custom starts keep their contracts',async()=>{
 for(const kind of ['terminal','agent','command','project','worktree']){
  const calls=[];const formLaunch={adapter:kind==='agent'?'codex':'shell',command:kind==='command'?'echo custom':null,provider:null};
  await actual('startNewSession',{isMainWindow:true,formAdapter:formLaunch.adapter,formLaunch,useProjectSettings:kind==='project',launchWorktreeAttempt:kind==='worktree'?'attempt-1':undefined,launchDirectoryOverride:'/explicit',launchTerminalProfile:undefined,cwd:'/explicit',newTerminal:async(...args)=>{calls.push(['terminal',...args]);return {launch:null};},startSession:async(...args)=>{calls.push(['managed',...args]);return {launch:kind==='agent'?{adapter:'codex'}:null};},localStorage:{setItem(){}},setError:assert.fail})();
  assert.equal(calls.length,1);assert.equal(calls[0][0],kind==='terminal'?'terminal':'managed');
  if(kind==='terminal')assert.deepEqual(calls[0].slice(1),['/explicit',undefined]);
  if(kind==='worktree')assert.deepEqual(calls[0].slice(1),[undefined,'attempt-1']);
 }
});

function preparation({path,preferred='shell',profileMode='explicit',secondary=false,profileId,defaults={}}={}){
 const state={cwd:null,override:'old',profile:'old',attempt:'old',draft:null,errors:[],opens:0};
 const profile={id:'11111111-1111-4111-8111-111111111111',name:'Default',shell:{program:'/bin/zsh',login:false},cwd:{mode:profileMode,path:profileMode==='explicit'?'/profile':null},envRefs:{},appearance:null};
 const bindings={isMainWindow:!secondary,currentProject:{path:'/context'},activeProject:'/active',session:{cwd:'/session'},globalLaunchDefaults:{adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null,...defaults},adapters:[{id:'shell',available:true},{id:'codex',available:true}],readPreference:()=>preferred,supportsProvider,cancelLayoutRestore(){},cancelProjectPreview(){},setProjectLaunchEdits(){},setCwd:v=>state.cwd=v,setLaunchDirectoryOverride:v=>state.override=v,setLaunchTerminalProfile:v=>state.profile=v,setLaunchWorktreeAttempt:v=>state.attempt=v,setLaunchDraft:v=>state.draft=v,setError:v=>{if(v)state.errors.push(v);},launchDialog:{current:{querySelectorAll:()=>[],showModal(){state.opens++;}}},terminalProfileCollection:{profiles:[profile],defaultId:profile.id,loadError:null},terminalProfileStart,shellLaunchRef:{current:null},shellWindows:false,terminalSettingsRef:{current:{fontFamily:'Global',fontSize:13,theme:'dark'}}};
 bindings.terminalDirectory=actual('terminalDirectory',bindings);
 actual('newSession',bindings)(path,profileId);return state;
}

test('Terminal dialog shows profile directory for generic entries and project directory for project entries',()=>{
 assert.equal(preparation().cwd,'/profile');assert.equal(preparation({path:'/project'}).cwd,'/project');
 assert.equal(preparation({profileMode:'home'}).cwd,'');assert.equal(preparation({profileMode:'context'}).cwd,'/context');
 assert.equal(preparation().override,undefined);assert.equal(preparation({path:'/project'}).override,'/project');
});

test('explicit terminal profile or profile bypass opens the common dialog with Terminal selected',()=>{
 const selected=preparation({preferred:'codex',profileId:'11111111-1111-4111-8111-111111111111'});assert.equal(selected.draft.adapter,'shell');assert.equal(selected.profile,'11111111-1111-4111-8111-111111111111');assert.equal(selected.cwd,'/profile');
 const bypass=preparation({preferred:'codex',profileId:null});assert.equal(bypass.draft.adapter,'shell');assert.equal(bypass.profile,null);assert.equal(bypass.cwd,'/context');
});

test('secondary window preserves the available CLI selection without redirecting',()=>{
 const result=preparation({secondary:true,preferred:'codex'});assert.equal(result.draft.adapter,'codex');assert.equal(result.opens,1);assert.deepEqual(result.errors,[]);
});

test('startup control uses a program label that includes Terminal',()=>{
 const select=nodes(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='div'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='aria-label'&&a.initializer?.text==='Startup program'))[0];assert.ok(select);assert.match(select.getText(source),/Terminal/);
});

test('directory picker records an explicit override so profile defaults cannot replace the selection',async()=>{
 const calls=[];
 await actual('chooseDirectory',{selectProjectDirectory,invoke:async()=>'/chosen',cwd:'/old',projectPath:'',openDirectoryDialog:async()=>'/chosen',setCwd:value=>calls.push(['cwd',value]),setLaunchDirectoryOverride:value=>calls.push(['override',value]),setError:assert.fail})('launch');
 assert.deepEqual(calls,[['cwd','/chosen'],['override','/chosen']]);
});

test('secondary ordinary start does not try to write shared last-program settings',async()=>{
 const errors=[];let launches=0;
 await actual('startNewSession',{isMainWindow:false,formAdapter:'shell',formLaunch:{command:null,provider:null},useProjectSettings:false,launchWorktreeAttempt:undefined,launchDirectoryOverride:undefined,launchTerminalProfile:undefined,newTerminal:async()=>{launches++;return {launch:null};},localStorage:{setItem(){throw Error('Shared settings are read-only');}},setError:v=>errors.push(v)})();
 assert.equal(launches,1);assert.deepEqual(errors,[]);
});

test('selected profile first opens the common dialog; explicit Start retains shell, references, appearance, retention and reporting',async()=>{
 const profile={id:'11111111-1111-4111-8111-111111111111',name:'Selected',shell:{program:'/bin/zsh',login:false},cwd:{mode:'explicit',path:'/profile'},envRefs:{TARGET:'SOURCE'},appearance:{fontFamily:'Menlo',fontSize:16,theme:'dark'}};
 const collection={profiles:[profile],defaultId:null,selectedId:profile.id,loadError:null};
 const sends=[],opened=[],errors=[];
 const bindings={isMainWindow:true,currentProject:{path:'/context'},session:null,activeProject:'',terminalProfileCollection:collection,terminalProfileStart,shellLaunchRef:{current:null},shellWindows:false,terminalSettingsRef:{current:{fontFamily:'Global',fontSize:13,theme:'light'}},terminalRetentionRef:{current:{retainedLines:500}},directoryReportingRef:{current:true},commandReportingRef:{current:true},zshDirectoryReportingEligible,zshCommandReportingEligible,setError:v=>errors.push(v),startSession:async snapshot=>{sends.push(snapshot);return {launch:null};},setTerminalProfilesOpen:value=>assert.equal(value,false),setTerminalProfileActionError:v=>{if(v)errors.push(v);},newSession:(...args)=>opened.push(args)};
 bindings.terminalDirectory=actual('terminalDirectory',bindings);
 await actual('startSelectedTerminalProfile',bindings)();assert.deepEqual(sends,[]);assert.deepEqual(opened,[[undefined,profile.id]]);
 const newTerminal=actual('newTerminal',bindings);
 await actual('startNewSession',{...bindings,newTerminal,formAdapter:'shell',formLaunch:{command:null,provider:null},useProjectSettings:false,launchWorktreeAttempt:undefined,launchDirectoryOverride:opened[0][0],launchTerminalProfile:opened[0][1],localStorage:{setItem(){}}})();
 assert.deepEqual(errors,[]);assert.equal(sends.length,1);
 assert.deepEqual(sends[0],{cwd:'/profile',command:'',launch:null,shell:profile.shell,envRefs:profile.envRefs,appearance:profile.appearance,retainedLines:500,directoryReporting:true,commandReporting:true});
 assert.notEqual(sends[0].shell,profile.shell);assert.notEqual(sends[0].envRefs,profile.envRefs);assert.notEqual(sends[0].appearance,profile.appearance);
});

test('cancelled directory selection cannot override the profile directory',async()=>{
 const calls=[];await actual('chooseDirectory',{selectProjectDirectory,invoke:assert.fail,openDirectoryDialog:async()=>null,setCwd:()=>calls.push('cwd'),setLaunchDirectoryOverride:()=>calls.push('override'),setError:assert.fail})('launch');assert.deepEqual(calls,[]);
});

test('successful worktree launch releases its draft reservation so later drafts cannot reuse it',async()=>{
 for(const result of [undefined,{launch:{adapter:'codex'}}]){
  const cleared=[],calls=[];await actual('startNewSession',{isMainWindow:true,formAdapter:'codex',formLaunch:{command:null,provider:null},useProjectSettings:false,launchWorktreeAttempt:'reserved',startSession:async(...args)=>{calls.push(args);return result;},setLaunchWorktreeAttempt:value=>cleared.push(value),localStorage:{setItem(){}},setError:assert.fail})();
  assert.deepEqual(calls,[[undefined,'reserved']]);assert.deepEqual(cleared,result?[undefined]:[]);
 }
});

test('auxiliary ordinary Terminal retains its existing no-hidden-command launch behavior',()=>{const shell=preparation({secondary:true,preferred:'shell',defaults:{command:'echo hidden command'}});assert.equal(shell.draft.adapter,'shell');assert.equal(shell.draft.command,null);const cli=preparation({secondary:true,preferred:'codex',defaults:{extra_args:'--existing-cli-arg',prompt:'existing initial message'}});assert.equal(cli.draft.extra_args,'--existing-cli-arg');assert.equal(cli.draft.prompt,'existing initial message');});
