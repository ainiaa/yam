// Author: Jeff.Liu. Session actions never execute or copy native conversation identity.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {duplicateSessionDraft,readSessionLaunchSettings,saveSessionLaunchSettings} from '../src/session-actions.ts';
const provider={id:'custom',model:'gateway/model',base_url:'http://127.0.0.1:3425',api_key_env:'GATEWAY_KEY'};
const source={session_id:'s-source-1',cwd:'/project 中文',command:null,launch:{adapter:'codex',mode:'interactive',extra_args:'--no-alt-screen',prompt:'do not repeat this task',codex:{image_mode:'gateway_api',context:'PRIVATE_OLD_ID'},provider,env_refs:{TOOLS_TOKEN:'TOOLS_TOKEN_SOURCE'}}};
test('duplicate takes a fresh CLI snapshot, provider references and image mode without old prompt or identity',()=>{
 const copy=duplicateSessionDraft(source);assert.equal(copy.cwd,source.cwd);assert.equal(copy.draft.adapter,'codex');assert.equal(copy.draft.mode,'interactive');assert.equal(copy.draft.prompt,null);assert.deepEqual(copy.draft.codex,{image_mode:'gateway_api'});assert.deepEqual(copy.draft.provider,provider);assert.deepEqual(copy.settings.envRefs,{TOOLS_TOKEN:'TOOLS_TOKEN_SOURCE'});assert.equal(JSON.stringify(copy).includes('PRIVATE_OLD_ID'),false);assert.equal('session_id' in copy,false);
 copy.draft.provider.model='changed';copy.settings.envRefs.TOOLS_TOKEN='changed';assert.equal(source.launch.provider.model,'gateway/model');assert.equal(source.launch.env_refs.TOOLS_TOKEN,'TOOLS_TOKEN_SOURCE');
});
test('native CLI duplication keeps native login and resets task prompt',()=>{
 for(const adapter of ['codex','claude','gemini','opencode']){const copy=duplicateSessionDraft({...source,launch:{adapter,mode:'task',extra_args:'',prompt:'old'}});assert.equal(copy.draft.adapter,adapter);assert.equal(copy.draft.provider,null);assert.equal(copy.draft.prompt,null);}
});
test('ordinary terminal duplicates saved shell and references with its own launch',()=>{
 const settings={terminal:'iterm2',ordinary:{shell:{program:'/bin/zsh',login:true},envRefs:{TOKEN:'TOKEN_SOURCE'},retainedLines:500,appearance:{fontFamily:'Menlo',fontSize:15,theme:'app'}}};
 const copy=duplicateSessionDraft({...source,launch:null},settings);assert.equal(copy.draft.adapter,'shell');assert.deepEqual(copy.settings,settings);copy.settings.ordinary.envRefs.TOKEN='other';assert.equal(settings.ordinary.envRefs.TOKEN,'TOKEN_SOURCE');
 const legacy=duplicateSessionDraft({...source,launch:null});assert.match(legacy.warning,/current terminal defaults/);
});
test('custom commands remain visible for explicit confirmation, native resume arguments cannot be replayed',()=>{
 const copy=duplicateSessionDraft({...source,command:'printf "review this command"',launch:null});assert.equal(copy.draft.adapter,'custom');assert.equal(copy.draft.command,'printf "review this command"');assert.equal(copy.reviewCommand,true);assert.match(copy.warning,/command.*run again/i);
 const fresh=duplicateSessionDraft({...source,launch:{...source.launch,extra_args:'resume --last'}});assert.equal(fresh.draft.extra_args,'');assert.match(fresh.warning,/resume/i);
});
test('invalid or remote launch metadata is refused instead of silently starting a different program',()=>{
 for(const value of [null,{}, {...source,cwd:''},{...source,ssh:{host:'remote'}},{...source,launch:{adapter:'unknown'}}])assert.throws(()=>duplicateSessionDraft(value));
});
test('saved launch settings contain only approved references and survive reloading',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 const settings={terminal:'yam',ordinary:{shell:{program:'/bin/zsh',login:false},envRefs:{TOKEN:'TOKEN_SOURCE'},retainedLines:2000}};
 saveSessionLaunchSettings(storage,'s-test-1',settings);assert.deepEqual(readSessionLaunchSettings(storage,'s-test-1'),settings);assert.equal(readSessionLaunchSettings(storage,'s-missing-1'),null);
 assert.throws(()=>saveSessionLaunchSettings(storage,'../escape',settings));assert.throws(()=>saveSessionLaunchSettings(storage,'s-test-1',{...settings,api_key:'SECRET'}));
 assert.throws(()=>saveSessionLaunchSettings(storage,'s-test-1',{terminal:'yam',ordinary:{envRefs:{TOKEN:'literal secret value'}}}));
 data.set('yam.sessionLaunch.s-test-1','broken');assert.throws(()=>readSessionLaunchSettings(storage,'s-test-1'));
});

import {readSessionName,saveSessionName} from '../src/session-actions.ts';
test('manual name is saved before use, reset overrides legacy automatic names, bad titles and storage failure retain previous state',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 assert.equal(readSessionName(storage,'s-test-1','Legacy'),'Legacy');saveSessionName(storage,'s-test-1','  My session  ');assert.equal(readSessionName(storage,'s-test-1','Legacy'),'My session');
 saveSessionName(storage,'s-test-1',null);assert.equal(readSessionName(storage,'s-test-1','Legacy'),null);
 for(const name of ['', 'x'.repeat(201),'bad\nname'])assert.throws(()=>saveSessionName(storage,'s-test-1',name));
 assert.throws(()=>saveSessionName({setItem(){throw Error('disk full')}},'s-test-1','New'),/disk full/);assert.equal(readSessionName(storage,'s-test-1','Legacy'),null);
});

import fs from 'node:fs';
import ts from 'typescript';
const appTree=ts.createSourceFile('App.tsx',fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(name,bindings){bindings={ordinaryLaunchSnapshot:{current:undefined},...bindings};let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n;ts.forEachChild(n,visit);}visit(appTree);assert.ok(found,`missing ${name}`);return new Function(...Object.keys(bindings),ts.transpile(found.getText(appTree),{target:ts.ScriptTarget.ES2022})+`;return ${name}`)(...Object.values(bindings));}
test('duplicate action captures the clicked session, prepares the unified dialog, and never starts a process',async()=>{
 const calls=[],state={},storage={getItem:()=>null};const bindings={terminalViews:{current:{get:()=>null}},setCopyName(){},titlesRef:{current:{}},t:s=>s,sessionCopyIntent:{current:0},starting:false,creatingSession:{current:false},terminalMounted:{current:true},invoke:async(name,args)=>{calls.push([name,args]);return {summary:source};},duplicateSessionDraft,readSessionLaunchSettings,localStorage:storage,newSession:cwd=>calls.push(['dialog',cwd]),setLaunchDraft:v=>state.draft=v,setCwd:v=>state.cwd=v,setSessionCopy:v=>state.copy=v,setSessionTerminal:v=>state.terminal=v,setError:v=>state.error=v,launchDialog:{current:{querySelector:()=>null}}};
 await actual('duplicateSession',bindings)(source.session_id);assert.deepEqual(calls,[['get_session',{sessionId:source.session_id}],['dialog',source.cwd]]);assert.equal(state.draft.prompt,null);assert.equal(state.copy.settings.terminal,'yam');
});
test('a late duplicate reply cannot replace a newer New session draft',async()=>{
 let resolve;const ref={current:0};const fn=actual('duplicateSession',{sessionCopyIntent:ref,starting:false,creatingSession:{current:false},terminalMounted:{current:true},invoke:()=>new Promise(r=>resolve=r),duplicateSessionDraft,readSessionLaunchSettings,newSession:()=>assert.fail('stale dialog'),localStorage:{getItem:()=>null},setError:assert.fail});
 const pending=fn(source.session_id);ref.current++;resolve({summary:source});await pending;
});
test('rename commits the captured ID before updating labels, failure retains the editor and title',()=>{
 let labels={},closed=0;const ref={current:'s-first-1'},data=new Map();const storage={setItem:(k,v)=>data.set(k,v)};
 const bindings={renameTarget:ref,renameTitle:'Renamed',saveSessionName,localStorage:storage,titlesRef:{current:{}},setSessionTitles:v=>{labels=typeof v==='function'?v(labels):v;},setRenameError:()=>{},renameDialog:{current:{close(){closed++;}}}};
 assert.equal(actual('saveRename',bindings)(),true);assert.equal(labels['s-first-1'],'Renamed');assert.equal(closed,1);assert.equal(data.get('yam.sessionName.s-first-1'),'"Renamed"');
 bindings.localStorage={setItem(){throw Error('disk full')}};assert.equal(actual('saveRename',bindings)(),false);assert.equal(closed,1);assert.equal(labels['s-first-1'],'Renamed');
});

test('history title migration respects explicit automatic-name reset and saved destination preferences',()=>{
 for(const raw of [null,'null','"Explicit destination"']){
  const titlesRef={current:{'s-old-1':'Manual name'}},pins={current:['s-old-1']},writes=[];
  const bindings={titlesRef,pinnedSessionsRef:pins,isMainWindow:true,localStorage:{getItem:k=>k==='yam.sessionName.s-next-1'?raw:null,setItem:(k,v)=>writes.push([k,v])},setSessionTitles:v=>{titlesRef.current=v},setPinnedSessions:v=>{pins.current=v},setError:assert.fail};
  actual('migrateTerminalMetadata',bindings)('s-old-1','s-next-1');
  assert.equal(titlesRef.current['s-next-1'],raw===null?'Manual name':undefined);assert.deepEqual(pins.current,['s-next-1']);assert.equal(writes.some(([k])=>k==='yam.sessionTitles'),raw===null);
 }
 const data=new Map(),titlesRef={current:{'s-old-1':'Manual name','s-next-1':'Manual name'}},pins={current:[]};let error;
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},setSessionTitles=v=>{titlesRef.current=v};
 actual('saveRename',{renameTarget:{current:'s-next-1'},renameTitle:'',saveSessionName,localStorage:storage,titlesRef,setSessionTitles,setRenameError:assert.fail,renameDialog:{current:{close(){}}}})(true);
 const bindings={titlesRef,pinnedSessionsRef:pins,isMainWindow:true,localStorage:storage,setSessionTitles,setPinnedSessions(){},setError:v=>{error=v}};
 actual('migrateTerminalMetadata',bindings)('s-old-1','s-next-1');assert.equal(titlesRef.current['s-next-1'],undefined);assert.equal(data.get('yam.sessionName.s-next-1'),'null');assert.equal(error,undefined);
 bindings.localStorage={getItem(){throw Error('storage unavailable')},setItem:assert.fail};actual('migrateTerminalMetadata',bindings)('s-old-1','s-other-1');assert.match(error,/could not be saved/);assert.equal(titlesRef.current['s-other-1'],undefined);
});

test('explicit copy Start sends fresh CLI arguments and persists reference-only launch settings with the new ID',async()=>{
 const sent=[],data=new Map(),snap={current:undefined};const copy=duplicateSessionDraft(source);
 const bindings={sessionCopy:copy,copyName:'Copy name',validateSessionTitle:(s)=>s,formAdapter:'codex',formLaunch:copy.draft,cwd:copy.cwd,useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',terminalSettingsRef:{current:{fontFamily:'Menlo',fontSize:13,theme:'app'}},ordinaryLaunchSnapshot:snap,startSession:async args=>{sent.push(args);return {session_id:'s-new-1',cwd:source.cwd,launch:args.launch};},localStorage:{setItem:(k,v)=>data.set(k,v)},saveSessionLaunchSettings,saveSessionName,setSessionTitles(){},isMainWindow:false,setError:assert.fail};
 await actual('startNewSession',bindings)();assert.equal(sent.length,1);assert.equal(sent[0].launch.prompt,null);assert.equal(sent[0].launch.codex.image_mode,'gateway_api');assert.equal('context' in sent[0].launch.codex,false);assert.deepEqual(sent[0].launch.env_refs,source.launch.env_refs);assert.equal(data.has('yam.sessionLaunch.s-new-1'),true);assert.equal(data.get('yam.sessionName.s-new-1'),'"Copy name"');assert.equal(data.has('yam.sessionLaunch.'+source.session_id),false);
});
test('invalid duplicate name never launches or retries a task',async()=>{
 let error;await actual('startNewSession',{sessionCopy:{},copyName:'bad\nname',validateSessionTitle:()=>{throw Error('invalid')},formAdapter:'shell',formLaunch:{},useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',startSession:assert.fail,setError:v=>error=v})();assert.match(error,/session name/);
});

test('ordinary copy applies current appearance while preserving its saved shell and references',async()=>{
 const original={shell:{program:'/bin/zsh',login:true},envRefs:{TOKEN:'TOKEN_SOURCE'},retainedLines:500,appearance:{fontFamily:'Menlo',fontSize:13,theme:'dark'}};
 for(const appearance of [{fontFamily:'Menlo',fontSize:22,theme:'light'},undefined]){
  const copy=duplicateSessionDraft({...source,launch:null},{terminal:'yam',ordinary:original,...(appearance?{appearance}:{})}),sent=[],data=new Map(),snapshot={current:undefined};
  const bindings={sessionCopy:copy,copyName:'',validateSessionTitle:s=>s,formAdapter:'shell',formLaunch:copy.draft,cwd:copy.cwd,useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',terminalSettingsRef:{current:original.appearance},ordinaryLaunchSnapshot:snapshot,startSession:async args=>{sent.push(args);return {session_id:'s-new-1',launch:null};},localStorage:{setItem:(k,v)=>data.set(k,v)},saveSessionLaunchSettings,saveSessionName,setSessionTitles(){},isMainWindow:false,setError:assert.fail};
  await actual('startNewSession',bindings)();
  assert.deepEqual(sent[0].appearance,appearance??original.appearance);assert.deepEqual(sent[0].shell,original.shell);assert.deepEqual(sent[0].envRefs,original.envRefs);assert.equal(sent[0].retainedLines,500);
  assert.deepEqual(snapshot.current.appearance,appearance??original.appearance);assert.deepEqual(JSON.parse(data.get('yam.sessionLaunch.s-new-1')).ordinary.appearance,appearance??original.appearance);
 }
 assert.equal(original.appearance.fontSize,13);
});

test('new ordinary profile persists its effective appearance for uncached copies',async()=>{
 const profile={fontFamily:'Menlo',fontSize:22,theme:'dark'},global={fontFamily:'Global',fontSize:13,theme:'light'},data=new Map(),snapshot={current:undefined};
 const bindings={sessionCopy:null,copyName:'',formAdapter:'shell',formLaunch:{command:null,provider:null},cwd:'/profile',useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',launchDirectoryOverride:'/profile',launchTerminalProfile:'chosen',terminalSettingsRef:{current:global},ordinaryLaunchSnapshot:snapshot,newTerminal:async()=>{snapshot.current={appearance:profile,shell:{program:'/bin/zsh',login:true}};return{session_id:'s-profile-1',launch:null};},localStorage:{setItem:(k,v)=>data.set(k,v)},saveSessionLaunchSettings,saveSessionName,setSessionTitles(){},isMainWindow:false,setError:assert.fail};
 await actual('startNewSession',bindings)();const saved=JSON.parse(data.get('yam.sessionLaunch.s-profile-1'));assert.deepEqual(saved.appearance,profile);assert.deepEqual(saved.ordinary.appearance,profile);
 const copy=duplicateSessionDraft({...source,launch:null},saved),sent=[];
 await actual('startNewSession',{...bindings,sessionCopy:copy,formLaunch:copy.draft,startSession:async args=>{sent.push(args);return {session_id:'s-copy-1',launch:null};}})();assert.deepEqual(sent[0].appearance,profile);
});

test('a legacy ordinary copy forwards its available current appearance into default shell creation',async()=>{
 const appearance={fontFamily:'Menlo',fontSize:22,theme:'light'},copy=duplicateSessionDraft({...source,launch:null},{terminal:'yam',appearance}),calls=[];
 await actual('startNewSession',{sessionCopy:copy,copyName:'',formAdapter:'shell',formLaunch:copy.draft,cwd:copy.cwd,useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',launchTerminalProfile:null,newTerminal:async(...args)=>{calls.push(args)},setError:assert.fail})();assert.deepEqual(calls,[[copy.cwd,null,appearance]]);
});

test('recovered IDs inherit saved launch settings once, preserving destination settings and storage errors',()=>{
 const settings={terminal:'iterm2',ordinary:{shell:{program:'/opt/homebrew/bin/fish',login:true},envRefs:{TOKEN:'TOKEN_SOURCE'},retainedLines:500,appearance:{fontFamily:'Menlo',fontSize:22,theme:'dark'}}};
 for(const destination of [undefined,JSON.stringify({terminal:'yam'}),'{corrupt']){
  const data=new Map([['yam.sessionLaunch.s-old-1',JSON.stringify(settings)]]),writes=[];if(destination!==undefined)data.set('yam.sessionLaunch.s-new-1',destination);
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>{writes.push([k,v]);data.set(k,v)}};
  const migrate=actual('migrateTerminalMetadata',{titlesRef:{current:{}},pinnedSessionsRef:{current:[]},isMainWindow:false,localStorage:storage,readSessionLaunchSettings,saveSessionLaunchSettings,setSessionTitles(){},setPinnedSessions(){},setError:assert.fail});migrate('s-old-1','s-new-1');migrate('s-old-1','s-new-1');
  assert.equal(data.get('yam.sessionLaunch.s-new-1'),destination??JSON.stringify(settings));assert.equal(writes.length,destination===undefined?1:0);assert.equal(data.get('yam.sessionLaunch.s-old-1'),JSON.stringify(settings));
 }
 for(const fail of ['corrupt','write']){
  let error;const storage={getItem:k=>k==='yam.sessionLaunch.s-old-1'?(fail==='corrupt'?'{bad':JSON.stringify(settings)):null,setItem(){throw Error('disk full')}};
  actual('migrateTerminalMetadata',{titlesRef:{current:{}},pinnedSessionsRef:{current:[]},isMainWindow:true,localStorage:storage,readSessionLaunchSettings,saveSessionLaunchSettings,setSessionTitles(){},setPinnedSessions(){},setError:v=>{error=v}})('s-old-1','s-new-1');assert.match(error,/could not be saved/);
 }
});

test('copy detects conversation selectors after native-compatible quoting and whitespace decoding',()=>{
 for(const args of ['"--resume" old-id',"'resume' old-id",'--re"su"me old-id','--session-id=old-id','--resume\u0085old-id','-rOLD_ID','-sOLD_ID']){
  const copy=duplicateSessionDraft({...source,launch:{...source.launch,extra_args:args}});assert.equal(copy.draft.extra_args,'',args);assert.match(copy.warning,/resume/);
 }
 for(const args of ['--no-alt-screen','-c model_reasoning_effort="high"'])assert.equal(duplicateSessionDraft({...source,launch:{...source.launch,extra_args:args}}).draft.extra_args,'');
 for(const args of ['bad\x00arg','x'.repeat(65537),null])assert.throws(()=>duplicateSessionDraft({...source,launch:{...source.launch,extra_args:args}}));
});

test('copy never replays opaque CLI arguments, including adapter-specific prompts and unknown future flags',()=>{
 for(const adapter of ['codex','claude','gemini','opencode'])for(const extra_args of ['--prompt "perform the previous task again"','-p old-task','old positional prompt','--future-task-option=old-task','--no-alt-screen','-c model_reasoning_effort="high"']){
  const copy=duplicateSessionDraft({...source,launch:{adapter,mode:'interactive',extra_args,prompt:null}});assert.equal(copy.draft.extra_args,'');assert.match(copy.warning,/arguments.*cleared/i);assert.equal(copy.draft.prompt,null);
 }
});


test('quick new reuses a safe CLI snapshot without opening the form or replaying the prompt',async()=>{
 const safe={...source,launch:{...source.launch,extra_args:''}},calls=[];
 const bindings={terminalViews:{current:{get:()=>null}},sessionCopyIntent:{current:0},starting:false,creatingSession:{current:false},terminalMounted:{current:true},invoke:async()=>({summary:safe}),duplicateSessionDraft,readSessionLaunchSettings,localStorage:{getItem:()=>null},startNewSession:async copy=>calls.push(copy),newSession:()=>assert.fail('safe quick action must not open the form'),setError:assert.fail};
 await actual('duplicateSession',bindings)(source.session_id,true);assert.equal(calls.length,1);assert.equal(calls[0].draft.prompt,null);assert.deepEqual(calls[0].draft.provider,provider);
});

test('quick new falls back to configuration when custom commands, cleared arguments or missing shell settings need review',async()=>{
 for(const summary of [source,{...source,launch:null,command:'echo review'},{...source,launch:null}]){
  let opened=0;const bindings={terminalViews:{current:{get:()=>null}},sessionCopyIntent:{current:0},starting:false,creatingSession:{current:false},terminalMounted:{current:true},invoke:async()=>({summary}),duplicateSessionDraft,readSessionLaunchSettings,localStorage:{getItem:()=>null},startNewSession:assert.fail,newSession:()=>opened++,setLaunchDraft(){},setCwd(){},setSessionCopy(){},setSessionTerminal(){},setCopyName(){},titlesRef:{current:{}},t:s=>s,launchDialog:{current:{querySelector:()=>null}},setError:assert.fail};
  await actual('duplicateSession',bindings)(source.session_id,true);assert.equal(opened,1);
 }
});

test('quick start uses captured directory, provider, shell and terminal despite unrelated form state',async()=>{
 for(const ordinary of [false,true]){
  const saved={terminal:'iterm2',...(ordinary?{ordinary:{shell:{program:'/bin/zsh',login:true},retainedLines:500}}:{})};
  const copy=duplicateSessionDraft(ordinary?{...source,launch:null}:{...source,launch:{...source.launch,extra_args:''}},saved),sent=[],opened=[],stored=new Map();
  const bindings={sessionCopy:null,copyName:'Unrelated name',formAdapter:'custom',formLaunch:{command:'do not execute',provider:null},cwd:'/wrong',useProjectSettings:true,launchWorktreeAttempt:'wrong',launchTerminalProfile:'wrong',sessionTerminal:'yam',ordinaryLaunchSnapshot:{current:undefined},terminalSettingsRef:{current:{fontFamily:'Menlo',fontSize:13,theme:'app'}},startSession:async args=>{sent.push(args);return {session_id:'s-new-1',launch:args.launch};},newTerminal:assert.fail,localStorage:{setItem:(k,v)=>stored.set(k,v)},saveSessionLaunchSettings,saveSessionName,setSessionTitles(){},isMainWindow:false,invoke:async(name,args)=>opened.push([name,args]),setError:assert.fail,setLaunchWorktreeAttempt:assert.fail};
  await actual('startNewSession',bindings)(copy);assert.equal(sent.length,1);assert.equal(sent[0].cwd,source.cwd);assert.equal(sent[0].command,'');
  if(ordinary){assert.deepEqual(sent[0].shell,saved.ordinary.shell);assert.equal(sent[0].retainedLines,500);}else{assert.deepEqual(sent[0].launch.provider,provider);assert.equal(sent[0].launch.prompt,null);}
  assert.deepEqual(opened,[['open_external_terminal',{sessionId:'s-new-1',terminal:'iterm2'}]]);assert.equal(JSON.parse(stored.get('yam.sessionLaunch.s-new-1')).terminal,'iterm2');assert.equal(stored.has('yam.sessionName.s-new-1'),false);
 }
});


test('pending ordinary copy retains its captured launch settings when another draft clears the shared snapshot',async()=>{
 let resolve;const data=new Map(),original={shell:{program:'/bin/zsh',login:true},retainedLines:500,appearance:{fontFamily:'Menlo',fontSize:15,theme:'app'}},copy=duplicateSessionDraft({...source,launch:null},{terminal:'yam',ordinary:original}),snapshot={current:undefined};
 const bindings={sessionCopy:null,copyName:'',formAdapter:'codex',formLaunch:{},cwd:'/other',useProjectSettings:false,launchWorktreeAttempt:undefined,sessionTerminal:'yam',ordinaryLaunchSnapshot:snapshot,terminalSettingsRef:{current:{fontFamily:'Other',fontSize:13,theme:'dark'}},startSession:()=>new Promise(r=>resolve=r),localStorage:{setItem:(k,v)=>data.set(k,v)},saveSessionLaunchSettings,saveSessionName,setSessionTitles(){},isMainWindow:false,setError:assert.fail};
 const pending=actual('startNewSession',bindings)(copy);snapshot.current=undefined;resolve({session_id:'s-new-1',launch:null});await pending;
 const saved=JSON.parse(data.get('yam.sessionLaunch.s-new-1'));assert.deepEqual(saved.ordinary,original);assert.deepEqual(saved.appearance,original.appearance);
});
