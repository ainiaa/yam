import {sessionRuntimeInfo} from '../src/session-runtime-info.ts';
import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {resolveAppShortcut,defaultAppShortcuts,loadAppShortcuts,validateAppShortcuts,saveAppShortcuts} from '../src/app-shortcuts.ts';
import {terminalZoomShortcut} from "../src/terminal-settings.ts";
import {sessionRecovery} from '../src/session-recovery.ts';
import {paletteShortcut} from '../src/command-palette.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unreadCount,agentLabel,nextAttention,defaultShortcuts,isShortcuts,shortcutAction,isLaunchMode} from '../src/agent-events.ts';
import ts from 'typescript';
import {readFileSync as rawReadFileSync} from 'node:fs';
import {connectionDetails} from '../src/provider-config.ts';
const agent=(phase='response_finished')=>({phase,integration:'connected',agent_session_id:'native-main',inbox:[{id:'g:one:TurnComplete',revision:3,turn_id:'one',kind:'response_finished',delivery:'accepted',read:false,error:null}]});
test('OS acceptance and foreground suppression remain unread until explicitly read',()=>{
 const a=agent();assert.equal(unreadCount(a),1);a.inbox[0].delivery='suppressed';assert.equal(unreadCount(a),1);
 a.inbox[0].read=true;assert.equal(unreadCount(a),0);assert.equal(unreadCount(),0);
});
test('round labels never imply the whole task succeeded or a stopped process is working',()=>{
 assert.equal(agentLabel(agent()),'Response finished');assert.equal(agentLabel(agent('needs_permission')),'Permission required');
 assert.equal(agentLabel(agent('working'),'stopped'),'Round interrupted');assert.equal(agentLabel(agent('unknown')),'Round status unknown');
 assert.equal(agentLabel(), 'Integration unavailable');
 assert.equal(agentLabel(agent('failed')),'Round failed');
 assert.equal(agentLabel(agent('needs_attention')),'Response ready · may continue');
 assert.equal(agentLabel({...agent(),integration:'connecting'},'stopped'),'Integration not connected');
});
test('attention navigation wraps through separate sessions without swallowing later rounds',()=>{
 const records=['a','b','c'].map(id=>({summary:{session_id:id},status:'running',agent:agent()}));
 records[1].agent.inbox[0].read=true;
 assert.equal(nextAttention(records,null).summary.session_id,'a');assert.equal(nextAttention(records,'a').summary.session_id,'c');assert.equal(nextAttention(records,'c').summary.session_id,'a');
 records[0].agent.inbox[0].read=true;records[2].agent.inbox[0].read=true;assert.equal(nextAttention(records,'a'),undefined);assert.equal(nextAttention([],null),undefined);
 records[0].agent.inbox.push({...agent().inbox[0],id:'g:two:TurnComplete',turn_id:'two',revision:5});assert.equal(unreadCount(records[0].agent),1);
});
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
test('primary Agent connection disclosure makes native round receipt limits visible',()=>{
 let code;const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='SessionConnection')code=node.getText(source);ts.forEachChild(node,visit);};visit(source);assert.ok(code);
 const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
 const Component=new Function('React','connectionDetails','ChevronDown','sessionRuntimeInfo',ts.transpile(code,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022})+';return SessionConnection;')(React,connectionDetails,()=>null,sessionRuntimeInfo);
 const text=node=>typeof node==='string'?node:(node?.children??[]).flat(Infinity).map(text).join('');
 const claude=text(Component({launch:{adapter:'claude',mode:'interactive'}}));
 assert.match(claude,/Esc.*external.*receipt.*not guaranteed/i);assert.match(claude,/native terminal/i);
 const codex=text(Component({launch:{adapter:'codex',mode:'interactive'}}));
 assert.match(codex,/0\.162\.1.*macOS/);assert.match(codex,/not a CLI version whitelist/i);assert.match(codex,/Unknown structures do not synthesize failure/);
 assert.doesNotMatch(text(Component({launch:{adapter:'shell'}})),/0\.162\.1|Esc/);
 assert.doesNotMatch(text(Component({launch:{adapter:'claude',mode:'task'}})),/Esc/);
});
let refreshSource;
function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='refreshHistory')refreshSource=node.getText(source);ts.forEachChild(node,find)}find(source);
const refreshJs=ts.transpileModule(refreshSource,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
test('older history responses and errors cannot replace the newest visible round state',async()=>{
 const pending=[];let history=[];const errors=[];
 const bindings={refreshSelectedAgent:async()=>{},isMainWindow:true,migrateTerminalMetadata:()=>{},invoke:command=>command==='history_overview'?Promise.resolve({}):new Promise((resolve,reject)=>pending.push({resolve:items=>resolve({items,next_cursor:null}),reject})),setHistory:records=>history=records,setError:error=>errors.push(error),notifySession:()=>{},historyRefreshVersion:{current:0},setHistoryLoading:()=>{},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({page_size:100}),setHistoryCursor:()=>{},setHistoryOverview:()=>{},refreshInbox:()=>{},refreshPendingNotifications:()=>{},selectedRecord:{current:null},setSelectedAgent:()=>{}};
 const refresh=new Function(...Object.keys(bindings),refreshJs+';return refreshHistory')(...Object.values(bindings));
 const older=refresh();const newer=refresh();
 pending[1].resolve([{agent:agent(),notification_pending:false}]);await newer;
 pending[0].resolve([{agent:agent('working'),notification_pending:false}]);await older;
 assert.equal(history[0].agent.phase,'response_finished');
 const oldFailure=refresh();const fresh=refresh();pending[3].resolve([{agent:agent(),notification_pending:false}]);await fresh;
 pending[2].reject(Error('stale disk failure'));await oldFailure;assert.deepEqual(errors,[]);
 const currentFailure=refresh();pending[4].reject(Error('current disk failure'));await currentFailure;
 assert.deepEqual(errors,['current disk failure']);assert.equal(history[0].agent.phase,'response_finished');
});

test('attention prioritizes intervention while retaining round navigation and unread counts',()=>{
 const records=['done','permission','interrupted','error'].map(id=>({summary:{session_id:id},status:'running',agent:agent()}));
 records[1].agent.inbox[0].kind='needs_permission'; records[2].agent.inbox[0].kind='interrupted'; records[3].status='failed';
 assert.equal(nextAttention(records,null).summary.session_id,'permission');
 assert.equal(nextAttention(records,'permission').summary.session_id,'interrupted');
 assert.equal(nextAttention(records,'error').summary.session_id,'done');
 records[1].agent.inbox[0].read=true; assert.equal(nextAttention(records,null).summary.session_id,'interrupted');
 records[2].agent.inbox[0].read=true; records[3].status='running'; records[3].agent.inbox[0].kind='failed';
 assert.equal(nextAttention(records,null).summary.session_id,'error');
});
test('shortcut preferences reject malformed, conflicting and extra keys',()=>{
 assert.equal(isShortcuts(defaultShortcuts),true);
 for(const value of [null,[],{}, {...defaultShortcuts,search:']'}, {...defaultShortcuts,search:'Enter'}, {...defaultShortcuts,search:' '}, {...defaultShortcuts,extra:'x'}, {attention:']',previous:'[',search:'k',constructor:'m'}])assert.equal(isShortcuts(value),false);
 assert.equal(isShortcuts({...defaultShortcuts,search:'J'}),true);
 assert.equal(isLaunchMode('task'),true);assert.equal(isLaunchMode('interactive'),true);assert.equal(isLaunchMode('unknown'),false);
});
test('shortcuts require platform modifier plus shift and never consume IME, repeats or dialog input',()=>{
 const event={key:']',metaKey:true,ctrlKey:false,shiftKey:true,altKey:false,isComposing:false,repeat:false};
 assert.equal(shortcutAction(event,defaultShortcuts,false),'attention');
 assert.equal(shortcutAction({...event,key:'K'},defaultShortcuts,false),'search');
 assert.equal(shortcutAction({...event,key:'m',metaKey:false,ctrlKey:true},defaultShortcuts,false),'pause');
 assert.equal(shortcutAction({...event,key:'['},defaultShortcuts,false),'previous');
 for(const patch of [{shiftKey:false},{metaKey:false},{altKey:true},{isComposing:true},{repeat:true},{key:'x'}])assert.equal(shortcutAction({...event,...patch},defaultShortcuts,false),null);
 assert.equal(shortcutAction(event,defaultShortcuts,true),null);
});

test('actual keyboard coordinator shares selection, defers search focus and skips modal or preference editing',()=>{
 let code;
 function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleShortcut')code=node.getText(source);ts.forEachChild(node,find)}find(source);
 assert.ok(code);const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 let modal=false,editing=false,sidebar=false,paused=false,focused=0,selected=0,attention=0;const opened=[],frames=[];
 class Element {closest(){return editing?{}:null}}
 const args={resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(true)},navigator:{platform:"MacIntel"},terminalZoomShortcut,paletteShortcut,openCommandPalette:()=>assert.fail('existing shortcut actions must not open palette'),document:{querySelector(){return modal?{}:null}},Element,shortcuts:defaultShortcuts,shortcutAction,jumpToAttention(){attention++},history:[{summary:{session_id:'a'}}],previousSession:{current:'a'},openSession(id){if(id==='a')opened.push(id)},setSidebarOpen(value){sidebar=value},requestAnimationFrame(fn){frames.push(fn)},searchInput:{current:{focus(){focused++},select(){selected++}}},setNotificationsPaused(fn){paused=fn(paused)},toggleNotificationPause(){paused=!paused}};
 const handler=new Function(...Object.keys(args),js+';return handleShortcut')(...Object.values(args));
 const event=key=>({key,metaKey:true,shiftKey:true,target:new Element(),preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true}});
 for(const key of [']','[','k','m']){const e=event(key);handler(e);assert.equal(e.prevented,true);assert.equal(e.stopped,true)}
 assert.equal(attention,1);assert.deepEqual(opened,['a']);assert.equal(paused,true);assert.equal(sidebar,true);assert.equal(focused,0);frames[0]();assert.equal(focused,1);assert.equal(selected,1);
 modal=true;let e=event(']');handler(e);assert.equal(e.prevented,undefined);modal=false;editing=true;e=event('m');handler(e);assert.equal(e.prevented,undefined);assert.equal(paused,true);
 args.previousSession.current='missing';editing=false;handler(event('['));assert.deepEqual(opened,['a']);
});

test('native resume is an explicit action passing only the YAM history identity',()=>{
 const functions=[];
 function find(node){if(ts.isFunctionDeclaration(node)&&['selectedRecovery','resumeSelectedSession'].includes(node.name?.text))functions.push(node.getText(source));ts.forEachChild(node,find)}find(source);assert.equal(functions.length,2);
 const js=ts.transpileModule(functions.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const calls=[];
 const record={summary:{session_id:'source',command:null,launch:{adapter:'codex',mode:'interactive',extra_args:''}},status:'stopped',agent:{generation:'trusted-generation',agent_session_id:'01a0f6ec-5463-78c3-a404-5a7ad3b933fa'}};
 const bindings={ownerConnectionAvailable:{current:{available:true,version:0}},session:{session_id:'source',cwd:'/repo',command:'must not run'},selectedRecord:{current:record},sessionId:{current:'source'},sessionStatus:'stopped',starting:false,terminalViews:{current:{get:()=>undefined}},sessionRecovery,startSession:args=>calls.push(args)};
 const handler=new Function(...Object.keys(bindings),js+';return resumeSelectedSession')(...Object.values(bindings));handler();assert.deepEqual(calls,[{resumeFrom:'source'}]);
 new Function(...Object.keys(bindings),js+';return resumeSelectedSession')(...Object.values({...bindings,session:null,startSession:()=>assert.fail('no selection')}))();
});


test('unknown or disconnected integration cannot advertise a ready or working CLI',()=>{
 for(const integration of ['unknown','disconnected','future-state',''])for(const phase of ['idle','working','needs_permission']){
  assert.equal(agentLabel({...agent(phase),integration}),'Integration unavailable');
 }
 assert.equal(agentLabel({...agent('idle'),integration:'connected'}),'Ready');
 assert.equal(agentLabel({...agent('idle'),integration:'connecting'}),'Awaiting trusted hook');
});


test('ended sidebar tooltips qualify historical events while rows keep only titles',()=>{
 let row;function visit(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.getText(source).includes('className={`session-row'))row=n;ts.forEachChild(n,visit);}visit(source);assert.ok(row);
 const title=row.openingElement.attributes.properties.find(n=>n.name?.getText(source)==='title').initializer.expression;
 const render=new Function('t','agentLabel','record','titleFor','statusLabels',ts.transpileModule('return ('+title.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText);
 for(const status of ['stopped','failed','succeeded'])assert.match(render(s=>s,agentLabel,{status,summary:{mode:'interactive'},agent:{phase:'needs_permission',integration:'connected'}},()=> 'Task',{stopped:'Stopped',failed:'Failed',succeeded:'Completed'}),/Last event: Permission required$/);
 assert.doesNotMatch(render(s=>s,agentLabel,{status:'running',summary:{mode:'interactive'},agent:{phase:'needs_permission',integration:'connected'}},()=> 'Task',{running:'Running'}),/Last event/);
 assert.doesNotMatch(row.getText(source),/<small|<time/);
});
