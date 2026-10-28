import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Cross-feature regression through actual App callbacks; native UI is separate.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';
import {LaunchTemplateCollection,projectLaunchFields} from '../src/launch-templates.ts';import {connectionDetails} from '../src/provider-config.ts';import {TerminalViews} from '../src/terminal-views.ts';import * as layout from '../src/terminal-layout.ts';
import {ConversationController} from '../src/conversation-view.ts';
const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callbacks(names,bindings){const bodies=[];const visit=node=>{if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))bodies.push(node.getText(app));ts.forEachChild(node,visit);};visit(app);assert.equal(bodies.length,names.length);return new Function(...Object.keys(bindings),ts.transpile(bodies.join('\n'),{target:ts.ScriptTarget.ES2022})+`;return {${names.join(',')}};`)(...Object.values(bindings));}
const provider={id:'custom',model:'gateway/model',base_url:'http://127.0.0.1:3425/v1',api_key_env:'GATEWAY_API_KEY'};
const fields={adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null,provider};
test('R1B selected gateway model reaches the existing form and template as an unchanged ID',()=>{
 const form={provider:{...provider}},edits={current:{}};const original={...form.provider};
 const select=callbacks(['editLaunch','changeProviderFields'],{formLaunch:form,setLaunchDraft:update=>Object.assign(form,update()),setProjectLaunchEdits:update=>edits.current=update(edits.current)}).changeProviderFields;
 select({model:'provider/Exact.Model-2026'});assert.deepEqual(form.provider,{...original,model:'provider/Exact.Model-2026'});assert.deepEqual(edits.current.provider,form.provider);
 const c=collection(null);c.value.save('Selected gateway',{...fields,provider:form.provider});const saved=c.value.templates[0];assert.equal(saved.provider.model,'provider/Exact.Model-2026');assert.equal(saved.provider.base_url,original.base_url);assert.equal(saved.provider.api_key_env,original.api_key_env);assert.ok(!c.storage.value.includes('models'));
});
function collection(raw='{broken'){const storage={value:raw,writes:0,getItem(){return this.value;},setItem(_key,value){this.writes++;this.value=value;}};const value=new LaunchTemplateCollection(storage,()=> '11111111-1111-4111-8111-111111111111');value.load();return{storage,value};}
test('T6 corrupt templates stay protected through cancel, then explicit recovery reuses only saved connection references',async()=>{
 const c=collection();assert.ok(c.value.loadError);assert.throws(()=>c.value.save('Magpie',fields));assert.equal(c.storage.writes,0);
 let confirmed=false;const errors=[];const args={isMainWindow:true,invoke:async name=>{assert.equal(name,'confirm_template_reset');return confirmed;},launchTemplateCollection:c.value,setLaunchTemplateActionError(){},refreshLaunchTemplateUi(){},handleLaunchTemplateError:error=>errors.push(error)};
 const {resetLaunchTemplates}=callbacks(['resetLaunchTemplates'],args);await resetLaunchTemplates();assert.equal(c.storage.value,'{broken');confirmed=true;await resetLaunchTemplates();assert.equal(c.value.loadError,null);
 c.value.save('Magpie',{...fields,env:{GATEWAY_API_KEY:'SECRET_SENTINEL'}});c.value.select(c.value.templates[0].id);const saved=c.value.apply();assert.ok(saved);assert.equal(c.storage.value.includes('SECRET_SENTINEL'),false);
 const form={},launchEdits={current:{}};const setters={projectLaunchFields,formLaunch:form,launchSettingsDialog:{current:null},launchDialog:{current:null},setLaunchDraft:fn=>Object.assign(form,fn()),setProjectLaunchEdits:fn=>launchEdits.current=fn(launchEdits.current)};
 callbacks(['editLaunch','applyLaunchTemplate'],setters).applyLaunchTemplate(saved);callbacks(['editLaunch','applyLaunchTemplate'],setters).applyLaunchTemplate(saved);
 assert.deepEqual(form.provider,provider);assert.deepEqual(launchEdits.current.provider,provider);assert.deepEqual(connectionDetails(form),{cli:'codex',source:'YAM isolated API configuration',model:'gateway/model',endpoint:'http://127.0.0.1:3425/v1'});assert.deepEqual(errors,[]);
});
test('T6 saved connection and custom name survive two actual continuations, then cancelled global stop leaves them intact',async()=>{
 const c=collection(null);c.value.save('Magpie',fields);const saved=c.value.templates[0],launch={adapter:saved.adapter,mode:saved.mode,extra_args:saved.extra_args,prompt:saved.prompt,provider:saved.provider};
 const titlesRef={current:{'s-run-1':'Gateway review'}},pinnedSessionsRef={current:['s-run-1']},calls=[],opened=[],errors=[];let serial=1;
 const args={...layout,isMainWindow:true,desktopWindow:{restore_blocked:false},layoutRestore:{current:{version:0,pending:false,adoptable:false}},setLayoutRestoreReady(){},terminalLayoutRef:{current:layout.createTerminalLayout()},terminalViews:{current:new TerminalViews(16)},creatingSession:{current:false},starting:false,command:'',cwd:'/unsubmitted',selectedAdapter:'shell',adapters:[],setStarting(){},setError:v=>errors.push(v),setActiveProject(){},setCollapsedProjects(){},projectKey:v=>v,titlesRef,pinnedSessionsRef,setSessionTitles:fn=>titlesRef.current=typeof fn==='function'?fn(titlesRef.current):fn,setPinnedSessions:v=>pinnedSessionsRef.current=v,localStorage:{getItem(){return null},setItem(){}},openHistory:async record=>opened.push(record),refreshHistory(){},launchDialog:{current:null},stopAllPending:{current:false},setStopAllBusy(){},terminalMounted:{current:true},invoke:async(name,parameters)=>{calls.push({name,parameters});if(name==='confirm_stop_all')return false;assert.equal(name,'create_session');assert.deepEqual(parameters,{resumeFrom:`s-run-${serial}`,cwd:null,command:null,launch:null});return{session_id:`s-run-${++serial}`,cwd:'/original',command:null,status:'running',launch};}};
 const actions=callbacks(['startSession','migrateTerminalMetadata','cancelLayoutRestore','stopAllAndQuit'],args);
 await actions.startSession({resumeFrom:'s-run-1'});await actions.startSession({resumeFrom:'s-run-2'});await actions.stopAllAndQuit();
 assert.equal(titlesRef.current['s-run-3'],'Gateway review');assert.deepEqual(pinnedSessionsRef.current,['s-run-3']);assert.deepEqual(opened.map(record=>record.summary.launch),[launch,launch]);assert.equal(connectionDetails(opened[1].summary.launch).model,'gateway/model');assert.deepEqual(calls.map(call=>call.name),['create_session','create_session','confirm_stop_all']);assert.deepEqual(errors.filter(Boolean),[]);
 const reader=new ConversationController(()=> '12345678-1234-4234-8234-123456789abc'),reads=[];
 for(const record of opened){const run=record.summary.session_id,generation=`generation-${run}`;reader.select('same-owner',run,'same-native-thread',generation);await reader.load(async(name,args)=>{reads.push([name,args]);return{query_token:args.query_token,session_id:run,thread_id:'same-native-thread',generation,read_at:1,direction:'desc',items:[],next_cursor:null};},()=>{});assert.equal(reader.snapshot.value.thread_id,'same-native-thread');assert.equal(reader.snapshot.value.session_id,run);}
 assert.deepEqual(reads.map(([name,args])=>[name,args.session_id]),[['read_codex_conversation','s-run-2'],['read_codex_conversation','s-run-3']]);assert.equal(titlesRef.current['s-run-3'],'Gateway review');assert.deepEqual(pinnedSessionsRef.current,['s-run-3']);assert.deepEqual(launch.provider,provider);
});

test('T6 tray owner initializes the installed dialog plugin before invoking shared stop confirmation',()=>{
 const background=readFileSync(new URL('../src-tauri/src/background.rs',import.meta.url),'utf8');
 const builder=background.slice(background.indexOf('pub(super) fn run()'));
 assert.match(builder.split('.setup(')[0],/\.plugin\(tauri_plugin_dialog::init\(\)\)/);
});

test('T6 macOS application menu cancels before any stop RPC and shares the native confirmation',()=>{
 const lib=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
 const menu=lib.split('.on_menu_event(')[1].split('.on_window_event(')[0];
 assert.match(menu,/system_entry::confirm_stop_all\(app.clone\(\)\)\.await/);
 assert.match(menu,/if confirmation\.is_err\(\)\s*\{[^}]*return;/);
 assert.match(menu,/confirmed_action\(confirmation,\s*\|\|\s*\{?\s*stop_all_and_quit\(app.clone\(\)\)\s*\}?\)\s*\.await/);
 const native=readFileSync(new URL('../src-tauri/src/system_entry.rs',import.meta.url),'utf8');
 const guard=native.slice(native.indexOf('pub(super) async fn confirmed_action<'),native.indexOf('\n}\n',native.indexOf('pub(super) async fn confirmed_action<'))+3);
 assert.match(guard,/if confirmation\?\s*\{\s*action\(\)\.await\?;/);
 assert.doesNotMatch(menu,/stop_background_and_quit\(/);
});
test('I1 latest authenticated agent identity stays in the warm terminal cache across view toggles',async()=>{
 assert.match(readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),/view\.record=\{\.\.\.view\.record,status:snapshot\.status\}/);
 for(const stale of [null,'owner','view','attachment']){
  const record={summary:{session_id:'s-one'},agent:{generation:'g',agent_session_id:null}},updated={...record,agent:{generation:'g',agent_session_id:'native',revision:5}},view={record,attachVersion:1,disposed:false};const selectedRecord={current:record},terminalViews={current:{get:()=>view}},ownerConnectionAvailable={current:{available:true,version:1}};let finish;const result=new Promise(resolve=>finish=resolve),selected=[];
  const bindings={terminalMounted:{current:true},sessionId:{current:"s-one"},selectionVersion:{current:0},setSession(){},historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},setHistoryLoading(){},historyRequest:()=>({}),isMainWindow:true,migrateTerminalMetadata(){},setHistory(){},setHistoryCursor(){},setHistoryOverview(){},refreshInbox:async()=>{},refreshPendingNotifications:async()=>{},selectedRecord,terminalViews,ownerConnectionAvailable,setSelectedAgent:value=>selected.push(value),setError:assert.fail,invoke:async(name)=>name==='get_session'?result:name==='list_session_summaries'?{items:[],next_cursor:null}:{}};
  const refreshing=callbacks(['refreshHistory','refreshSelectedAgent'],bindings).refreshHistory();await new Promise(r=>setImmediate(r));if(stale==='owner')ownerConnectionAvailable.current.version++;if(stale==='view')terminalViews.current={get:()=>({...view})};if(stale==='attachment')view.attachVersion++;
  finish(updated);await refreshing;if(stale===null){assert.equal(view.record.agent.agent_session_id,'native');assert.deepEqual(selected,[updated.agent]);}else{assert.equal(view.record.agent.agent_session_id,null);assert.deepEqual(selected,[]);}
 }
});
