import ts from 'typescript';
import {existsSync,readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TerminalViews} from '../src/terminal-views.ts';

function source(file) {
 const url=new URL(`../src/${file}`,import.meta.url);
 return ts.createSourceFile(file,existsSync(url)?readFileSync(url,'utf8'):'',ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
}
function coordinator(name,file='HistoryArchive.tsx') {
 const tree=source(file);let found,cancellation;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==="cancelLayoutRestore")cancellation=node.getText(tree);if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(tree);ts.forEachChild(node,visit);};visit(tree);
 assert.ok(found,`${file}: ${name} exists`);
 return ts.transpileModule((cancellation??"")+"\n"+found,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
}
function run(name,bindings,file) {bindings={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},...bindings};return new Function(...Object.keys(bindings),`${coordinator(name,file)};return ${name};`)(...Object.values(bindings));}

// A missing UI action is a no-op so red comes from its observable behavior, not a missing import.
function retentionAction(name,bindings,file='HistoryArchive.tsx') {
 bindings={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},...bindings};
 const tree=source(file);let found,cancellation;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==="cancelLayoutRestore")cancellation=node.getText(tree);if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(tree);ts.forEachChild(node,visit);};visit(tree);
 if(!found)return async()=>{};
 const js=ts.transpileModule((cancellation??"")+"\n"+found,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 return new Function(...Object.keys(bindings),`${js};return ${name};`)(...Object.values(bindings));
}
function cleanupState(extra={}) {
 return {terminalLayoutRef:{current:{mode:"single",panes:[null],focused:0,revision:0}},setTerminalLayout:()=>{},pinnedSessionsRef:{current:[]},setPinnedSessions:()=>{},terminalViews:{current:new TerminalViews(16)},previousSession:{current:null},selectedRecord:{current:null},pendingOutput:{current:{delete:()=>{}}},pendingState:{current:new Map()},detailVersion:{current:0},selectionVersion:{current:0},terminal:{current:null},fitAddon:{current:null},outputCursor:{current:null},setSession:()=>{},setSessionStatus:()=>{},...extra,localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{},...(extra.localStorage??{})}};
}
function deletionHarness(invoke,initial=null,extra={}) {
 const calls=[],deleted=[],errors=[];const deletionPreviewRef={current:initial},deleteRequestVersion={current:0},busyRef={current:false};
 let preview=initial,refreshed=0;
 const bindings={invoke:async(command,args)=>{calls.push({command,args});return invoke(command,args);},deletionPreviewRef,deleteRequestVersion,busyRef,setBusy:()=>{},setError:value=>errors.push(value),setDeletionPreview:value=>{preview=value;deletionPreviewRef.current=value;},onDeleted:ids=>deleted.push(ids),onChanged:async()=>refreshed++,loadArchives:async()=>{},selectedArchiveIds:['s-one','s-two'],setSelectedArchiveIds:()=>{},...extra};
 return {preview:retentionAction('previewDeletion',bindings),cancel:retentionAction('cancelDeletion',bindings),confirm:retentionAction('confirmDeletion',bindings),getPreview:()=>preview,calls,deleted,errors,refreshed:()=>refreshed,deletionPreviewRef,deleteRequestVersion,busyRef};
}
const exactPreview={preview_id:'s-preview',session_ids:['s-one','s-two'],count:2,earliest_ended_at:1,latest_ended_at:2,bytes:4096,scope:'YAM archived records, logs and saved terminal scenes; native CLI history is retained'};
test('T05 preview executes the actual action with exact selected IDs and no destructive request',async()=>{
 const h=deletionHarness(async()=>exactPreview);
 await h.preview(['s-one','s-two']);
 assert.deepEqual(h.calls,[{command:'preview_archive_deletion',args:{sessionIds:['s-one','s-two']}}]);
 assert.deepEqual(h.getPreview(),exactPreview);assert.deepEqual(h.deleted,[]);assert.equal(h.refreshed(),0);
});
test('T05 cancel clears the preview and never invokes permanent deletion',async()=>{
 const h=deletionHarness(async()=>null,exactPreview);await h.cancel();
 assert.equal(h.getPreview(),null);assert.deepEqual(h.calls,[{command:'cancel_archive_deletion_preview',args:{previewId:'s-preview'}}]);assert.deepEqual(h.deleted,[]);
});
test('T05 confirm passes only the frozen token and keeps incomplete recovery available',async()=>{
 const h=deletionHarness(async()=>({deleted_ids:['s-one'],complete:false,issues:['Deletion permission denied']}),exactPreview);
 await h.confirm();
 assert.ok(h.calls.every(call=>call.command==='confirm_archive_deletion'&&call.args.previewId==='s-preview'));
 assert.ok(h.deleted.every(ids=>ids.length===1&&ids[0]==='s-one'));assert.equal(h.refreshed(),1);assert.equal(h.getPreview().preview_id,'s-preview');
 assert.ok(h.errors.some(error=>String(error).includes('Deletion permission denied')),'partial completion remains visible');
});
test('T05 a rejected confirm preserves names and exposes the error for a fresh preview',async()=>{
 const h=deletionHarness(async()=>{throw Error('Deletion preview expired; preview again');},exactPreview);
 await h.confirm();assert.deepEqual(h.deleted,[]);assert.equal(h.refreshed(),0);assert.equal(h.busyRef.current,false);
 assert.ok(h.errors.some(error=>String(error).includes('expired')));
});
test('T05 repeated confirm clicks create exactly one mutation while the first awaits IPC',async()=>{
 let release;const h=deletionHarness(async()=>new Promise(resolve=>release=resolve),exactPreview);
 const pending=h.confirm();await h.confirm();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].command,'confirm_archive_deletion');
 release({deleted_ids:['s-one','s-two'],complete:true,issues:[]});await pending;assert.deepEqual(h.deleted,[['s-one','s-two']]);
});
test('T05 an older preview response cannot override a newer selected set',async()=>{
 const releases=[];const h=deletionHarness(async()=>new Promise(resolve=>releases.push(resolve)));
 const first=h.preview(['s-one']);const second=h.preview(['s-two']);
 assert.equal(h.calls.length,2);
 releases[1]({...exactPreview,preview_id:'s-new',session_ids:['s-two'],count:1});await second;
 releases[0]({...exactPreview,preview_id:'s-old',session_ids:['s-one'],count:1});await first;
 assert.equal(h.getPreview().preview_id,'s-new');
});
test('T05 preview UI displays actual count, local times, bytes, scope and separate confirmation',()=>{
 const tree=source('HistoryArchive.tsx');let panel;
 const visit=node=>{if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(tree)==='aria-label'&&prop.initializer?.text==='Permanent deletion preview'))panel=node;ts.forEachChild(node,visit);};visit(tree);
 assert.ok(panel,'the application exposes a reviewable permanent-deletion preview');
 const expressions=[];const walk=node=>{if(ts.isJsxExpression(node)&&node.expression)expressions.push(node.expression.getText(tree));ts.forEachChild(node,walk);};walk(panel);
 const values=expressions.filter(expression=>/deletionPreview\.(?:count|bytes|scope|earliest_ended_at|latest_ended_at)/.test(expression)).map(expression=>{
  const js=ts.transpileModule(`const value=${expression};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  return new Function('deletionPreview',`${js};return value;`)(exactPreview);
 });
 assert.ok(values.includes(2));assert.ok(values.includes(4096));assert.ok(values.includes(exactPreview.scope));
 assert.ok(values.includes(new Date(1000).toLocaleString()));assert.ok(values.includes(new Date(2000).toLocaleString()));
 assert.match(panel.getText(tree),/Confirm permanent deletion/);assert.match(panel.getText(tree),/cancelDeletion/);
});
test('T05 App cleans only actual deleted IDs from names and matching last-session preference',async()=>{
 let titles={'s-one':'First','s-two':'Keep','s-other':'Other'};const removed=[];
 const clear=retentionAction('clearDeletedSessionNames',cleanupState({setSessionTitles:update=>titles=update(titles),sessionId:{current:'s-other'},localStorage:{getItem:key=>key==='yam.lastSession'?JSON.stringify('s-one'):null,removeItem:key=>removed.push(key)}}),'App.tsx');
 await clear(['s-one']);assert.deepEqual(titles,{'s-two':'Keep','s-other':'Other'});assert.deepEqual(removed,['yam.lastSession']);
});
test('T05 retention policy is loaded explicitly and opting in never enables automatic deletion',async()=>{
 const calls=[],states=[];
 const bindings={invoke:async(command,args)=>{calls.push({command,args});return {auto_archive_30_days:false,auto_delete:false};},setAutoArchive:value=>states.push(value),setError:()=>{},busyRef:{current:false},setBusy:()=>{},policyRequestVersion:{current:0}};
 await retentionAction('loadRetentionPolicy',bindings)();
 await retentionAction('saveRetentionPolicy',bindings)(true);
 assert.deepEqual(calls,[{command:'get_history_policy',args:undefined},{command:'set_history_policy',args:{autoArchive30Days:true}}]);
 assert.equal(states[0],false);assert.ok(calls.every(call=>!Object.hasOwn(call.args??{},'autoDelete')));
});
test('T05 the actual confirmation and cancellation JSX handlers execute their separate actions',async()=>{
 const tree=source('HistoryArchive.tsx');const actions=[];const handlers=new Map();
 const visit=node=>{
  if(ts.isJsxOpeningElement(node)&&node.tagName.getText(tree)==='button') {
   const parent=node.parent;const label=parent.children.filter(ts.isJsxText).map(child=>child.text.trim()).join('');
   const handler=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(tree)==='onClick');
   if(handler&&['Confirm permanent deletion','Cancel permanent deletion'].includes(label))handlers.set(label,handler.initializer.expression.getText(tree));
  }ts.forEachChild(node,visit);
 };visit(tree);
 assert.equal(handlers.size,2,'two explicit application controls are required');
 for(const [label,expression] of handlers) {
  const js=ts.transpileModule(`const click=${expression};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  await new Function('confirmDeletion','cancelDeletion',`${js};return click;`)(()=>actions.push('confirm'),()=>actions.push('cancel'))();
 }
 assert.deepEqual(actions,['confirm','cancel']);
});
test('T05 cancel invalidates an outstanding preview and a late IPC response stays hidden',async()=>{
 let release;const h=deletionHarness(async command=>command==='preview_archive_deletion'?new Promise(resolve=>release=resolve):null);
 const pending=h.preview(['s-one']);assert.equal(h.calls.length,1);
 await h.cancel();release(exactPreview);await pending;
 assert.equal(h.getPreview(),null);assert.equal(h.calls.some(call=>call.command==='confirm_archive_deletion'),false);
});
test('T05 App does not clear unrelated last-session or title preferences on partial completion',async()=>{
 let titles={'s-one':'Deleted','s-two':'Still pending','s-other':'Selected'};const removed=[];
 const clear=retentionAction('clearDeletedSessionNames',cleanupState({setSessionTitles:update=>titles=update(titles),sessionId:{current:'s-other'},localStorage:{getItem:()=> 's-other',removeItem:key=>removed.push(key)}}),'App.tsx');
 await clear(['s-one']);assert.deepEqual(titles,{'s-two':'Still pending','s-other':'Selected'});assert.deepEqual(removed,[]);
 const tree=source('App.tsx');let onDeleted;
 const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='HistoryArchive')onDeleted=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(tree)==='onDeleted');ts.forEachChild(node,visit);};visit(tree);
 assert.ok(onDeleted,'the actual archive dialog propagates committed IDs to App');assert.equal(onDeleted.initializer.expression.getText(tree),'clearDeletedSessionNames');
});
test('T05 committed deletion disposes only its ended cached view and invalidates old selection',async()=>{
 const disposed=[];const state=cleanupState({setSessionTitles:update=>update({}),sessionId:{current:'s-deleted'},previousSession:{current:'s-deleted'},selectedRecord:{current:{summary:{session_id:'s-deleted'}}},localStorage:{getItem:()=>null,removeItem:()=>{}}});
 state.terminalViews.current.open('s-deleted',false,()=>({dispose:()=>disposed.push('s-deleted')}));
 state.terminalViews.current.open('s-live',true,()=>({dispose:()=>disposed.push('s-live')}));
 state.terminalViews.current.open('s-other',false,()=>({dispose:()=>disposed.push('s-other')}));
 await retentionAction('clearDeletedSessionNames',state,'App.tsx')(['s-deleted']);
 assert.deepEqual(disposed,['s-deleted']);assert.equal(state.terminalViews.current.size,2);assert.ok(state.terminalViews.current.get('s-live'));
 assert.equal(state.sessionId.current,null);assert.equal(state.previousSession.current,null);assert.equal(state.selectedRecord.current,null);assert.ok(state.detailVersion.current>0);assert.ok(state.selectionVersion.current>0);
});
test('T05 review F1 partial recovery uses the same token and cleans the final actual App IDs',async()=>{
 let recovered=false;let titles={'s-one':'First','s-two':'Second','s-other':'Keep'};const removed=[],disposed=[];
 const app=cleanupState({setSessionTitles:update=>titles=update(titles),sessionId:{current:'s-two'},previousSession:{current:'s-two'},selectedRecord:{current:{summary:{session_id:'s-two'}}},localStorage:{getItem:()=> 's-two',removeItem:key=>removed.push(key)}});
 app.terminalViews.current.open('s-two',false,()=>({dispose:()=>disposed.push('s-two')}));
 const cleanup=retentionAction('clearDeletedSessionNames',app,'App.tsx');
 const invoke=async command=>{
  if(command==='list_archived_sessions'){recovered=true;return {items:[],next_cursor:null};}
  assert.equal(command,'confirm_archive_deletion');return recovered?{deleted_ids:['s-one','s-two'],complete:true,issues:[]}:{deleted_ids:['s-one'],complete:false,issues:['Deletion storage operation failed']};
 };
 let h;const load=run('loadArchives',{invoke:async(command,args)=>{h.calls.push({command,args});return invoke(command,args);},setArchives:()=>{},setArchiveCursor:()=>{},setError:()=>{},setLoading:()=>{},archiveRequestVersion:{current:0}});
 h=deletionHarness(invoke,exactPreview,{loadArchives:load,onDeleted:cleanup});
 await h.confirm();
 assert.deepEqual(titles,{'s-other':'Keep'},'the final receipt must include recovery-completed B');
 assert.deepEqual(removed,['yam.lastSession']);assert.deepEqual(disposed,['s-two']);assert.equal(app.previousSession.current,null);assert.equal(app.selectedRecord.current,null);assert.equal(app.sessionId.current,null);
 assert.deepEqual(h.calls.map(call=>call.command),['confirm_archive_deletion','list_archived_sessions','confirm_archive_deletion']);
 assert.ok(h.calls.filter(call=>call.command==='confirm_archive_deletion').every(call=>call.args.previewId==='s-preview'));assert.equal(h.getPreview(),null);
});
test('T05 review F1 closing after a lost response lets the actual shared App refresh consume recovered IDs',async()=>{
 let closed=0;const commands=[];let titles={'s-one':'First','s-two':'Second','s-other':'Keep'};const disposed=[],removed=[];
 const app=cleanupState({setSessionTitles:update=>titles=update(titles),sessionId:{current:'s-two'},previousSession:{current:'s-two'},selectedRecord:{current:{summary:{session_id:'s-two'}}},localStorage:{getItem:()=> 's-two',removeItem:key=>removed.push(key)}});
 app.terminalViews.current.open('s-two',false,()=>({dispose:()=>disposed.push('s-two')}));
 const cleanup=retentionAction('clearDeletedSessionNames',app,'App.tsx');
 const h=deletionHarness(async command=>{commands.push(command);if(command==='confirm_archive_deletion')throw Error('committed response lost');return null;},exactPreview);
 await h.confirm();
 run('closeArchive',{busyRef:h.busyRef,archiveRequestVersion:{current:0},onClose:()=>closed++})();assert.equal(closed,1,'Close stays usable after IPC failure');
 const tree=source('HistoryArchive.tsx');let effect;
 const visit=node=>{if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]?.getText(tree).includes('showModal'))effect=node.arguments[0].getText(tree);ts.forEachChild(node,visit);};visit(tree);assert.ok(effect);
 const effectJs=ts.transpileModule(`const mount=${effect};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const unmount=new Function('dialog','loadArchives','loadRetentionPolicy','archiveRequestVersion','policyRequestVersion','cancelDeletion',`${effectJs};return mount();`)({current:null},()=>{},()=>{}, {current:0},{current:0},h.cancel);
 unmount();await new Promise(setImmediate);
 const refresh=retentionAction('refreshHistory',{invoke:async command=>{commands.push(command);if(command==='list_session_summaries')return {items:[],next_cursor:null};if(command==='history_overview')return {total:1,active:0,unread_receipts:0,attention_sessions:0,latest_deletion:{preview_id:'s-preview',deleted_ids:['s-one','s-two'],complete:true,issues:[]}};if(command==='get_session')return app.selectedRecord.current;throw Error(command);},deletionReceiptKey:{current:''},historyRefreshVersion:{current:0},historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},historyRequest:()=>({page_size:100}),setHistoryLoading:()=>{},setHistory:()=>{},setHistoryCursor:()=>{},setHistoryOverview:()=>{},refreshInbox:()=>{},refreshPendingNotifications:()=>{},selectedRecord:app.selectedRecord,setSelectedAgent:()=>{},setError:()=>{},clearDeletedSessionNames:cleanup},'App.tsx');
 await refresh();
 assert.deepEqual(titles,{'s-other':'Keep'});assert.deepEqual(disposed,['s-two']);assert.deepEqual(removed,['yam.lastSession']);assert.equal(app.previousSession.current,null);assert.equal(app.selectedRecord.current,null);assert.equal(app.sessionId.current,null);
 assert.equal(commands.filter(command=>command==='confirm_archive_deletion').length,1,'shared refresh only reads the committed receipt');
 assert.equal(commands.includes('get_session'),false,'the deleted selected record is cleared before detail refresh');
 const version=app.detailVersion.current;await refresh();assert.equal(app.detailVersion.current,version,'repeated receipt does not cancel a newer selection');
});
test('T05 review F1 a lost confirm response retains its token for idempotent retry',async()=>{
 let first=true;const h=deletionHarness(async()=>{if(first){first=false;throw Error('connection closed after committed response');}return {deleted_ids:['s-one','s-two'],complete:true,issues:[]};},exactPreview);
 await h.confirm();assert.equal(h.getPreview()?.preview_id,'s-preview');assert.deepEqual(h.deleted,[]);
 await h.confirm();assert.deepEqual(h.calls.map(call=>call.args),[{previewId:'s-preview'},{previewId:'s-preview'}]);assert.deepEqual(h.deleted,[['s-one','s-two']]);assert.equal(h.getPreview(),null);
});
test('T05 review F1 the actual App archive-close callback requests shared history refresh',async()=>{
 const tree=source('App.tsx');let expression;
 const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='HistoryArchive')expression=node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(tree)==='onClose').initializer.expression.getText(tree);ts.forEachChild(node,visit);};visit(tree);assert.ok(expression);
 let closed=false,refreshed=0;const js=ts.transpileModule(`const close=${expression};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 new Function('setArchiveOpen','refreshHistory',`${js};return close;`)(open=>closed=!open,async()=>refreshed++)();await new Promise(setImmediate);
 assert.equal(closed,true);assert.equal(refreshed,1);
});
function deletionSelectionDisabled(selectedArchiveIds,id) {
 const tree=source('HistoryArchive.tsx');let expression;
 const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='input'&&node.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(tree)==='aria-label'&&p.initializer?.getText(tree).includes('for deletion'))){expression=node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(tree)==='disabled').initializer.expression.getText(tree);}ts.forEachChild(node,visit);};visit(tree);
 assert.ok(expression);return new Function('selectedArchiveIds','record','busy',`return ${expression};`)(selectedArchiveIds,{summary:{session_id:id}},false);
}
test('T05 review F2 deleting twenty selected archives frees the actual checkbox limit',async()=>{
 let selected=Array.from({length:20},(_,i)=>`s-${i}`);const ids=[...selected];
 assert.equal(deletionSelectionDisabled(selected,'s-other'),true);
 const h=deletionHarness(async()=>({deleted_ids:ids,complete:true,issues:[]}),{...exactPreview,session_ids:ids,count:20},{setSelectedArchiveIds:update=>selected=update(selected)});
 await h.confirm();assert.deepEqual(selected,[]);assert.equal(deletionSelectionDisabled(selected,'s-other'),false);
});
test('T05 review F2 partial deletion removes only receipt IDs from selected archives',async()=>{
 let selected=['s-one','s-two','s-other'];const h=deletionHarness(async()=>({deleted_ids:['s-one'],complete:false,issues:['Deletion storage operation failed']}),exactPreview,{setSelectedArchiveIds:update=>selected=update(selected)});
 await h.confirm();assert.deepEqual(selected,['s-two','s-other']);assert.equal(h.getPreview()?.preview_id,'s-preview');
});
test('T05 review F2 only a successful restore removes its selected archive ID',async()=>{
 let selected=['s-one','s-two','s-other'];let fail=true;
 const mutate=run('mutateArchive',{invoke:async()=>{if(fail)throw Error('restore rejected');},busyRef:{current:false},setBusy:()=>{},setError:()=>{},loadArchives:async()=>{},onChanged:async()=>{},setSelectedArchiveIds:update=>selected=update(selected)});
 await mutate('restore_archive','s-one');assert.deepEqual(selected,['s-one','s-two','s-other']);
 fail=false;await mutate('restore_archive','s-one');assert.deepEqual(selected,['s-two','s-other']);
 await mutate('archive_session','s-two');assert.deepEqual(selected,['s-two','s-other']);
});
for(const fail of [false,true])test(`T05 review F3 a delayed initial policy ${fail?'error':'false response'} cannot overwrite a newer saved opt-in`,async()=>{
 let finish;let enabled=false;const errors=[];const policyRequestVersion={current:0};
 const bindings={policyRequestVersion,invoke:async command=>command==='get_history_policy'?new Promise((resolve,reject)=>finish=()=>fail?reject(Error('stale read error')):resolve({auto_archive_30_days:false,auto_delete:false})):undefined,setAutoArchive:value=>enabled=value,setError:value=>errors.push(value),busyRef:{current:false},setBusy:()=>{}};
 const loading=retentionAction('loadRetentionPolicy',bindings)();await retentionAction('saveRetentionPolicy',bindings)(true);assert.equal(enabled,true);
 finish();await loading;assert.equal(enabled,true);assert.ok(errors.every(error=>!String(error).includes('stale read error')));
});
function mutationHarness(invoke) {
 const busyRef={current:false};const errors=[];let changed=0,loaded=0;
 const mutate=run('mutateArchive',{invoke,busyRef,setBusy:()=>{},setError:e=>errors.push(e),setSelectedArchiveIds:()=>{},onChanged:async()=>changed++,loadArchives:async()=>loaded++});
 return {mutate,busyRef,errors,changed:()=>changed,loaded:()=>loaded};
}
test('archive and restore actions use selected IDs and refresh only after success',async()=>{
 const calls=[];const h=mutationHarness(async(command,args)=>calls.push({command,args}));
 await h.mutate('archive_session','s-中文');await h.mutate('restore_archive','s-中文');
 assert.deepEqual(calls,[{command:'archive_session',args:{sessionId:'s-中文'}},{command:'restore_archive',args:{sessionId:'s-中文'}}]);
 assert.equal(h.changed(),2);assert.equal(h.loaded(),2);assert.equal(h.busyRef.current,false);
});
test('canceling the archive dialog sends no native mutation',()=>{
 const calls=[];let closed=0;
 run('closeArchive',{invoke:command=>calls.push(command),busyRef:{current:false},archiveRequestVersion:{current:0},onClose:()=>closed++})();
 assert.equal(closed,1);assert.deepEqual(calls,[]);
});
test('an outstanding archive operation ignores repeated clicks',async()=>{
 let release;const calls=[];
 const h=mutationHarness(async command=>{calls.push(command);await new Promise(resolve=>release=resolve);});
 const first=h.mutate('archive_session','s-old');await h.mutate('archive_session','s-old');
 assert.deepEqual(calls,['archive_session']);release();await first;assert.equal(h.changed(),1);
});
test('a rejected restore leaves records unchanged and permits a later retry',async()=>{
 let reject=true;const h=mutationHarness(async()=>{if(reject)throw Error('Session history exceeds 32 MiB; archive more sessions before restoring');});
 await h.mutate('restore_archive','s-old');assert.equal(h.changed(),0);assert.equal(h.loaded(),0);
 assert.ok(h.errors.some(Boolean));assert.equal(h.busyRef.current,false);
 reject=false;await h.mutate('restore_archive','s-old');assert.equal(h.changed(),1);
});
test('archive pagination asks for one bounded page and never hot full-list history',async()=>{
 const calls=[];const rows=[];const cursor={revision:'archive:1',offset:100,context:'archive'};
 const load=run('loadArchives',{invoke:async(command,args)=>{calls.push({command,args});return {items:[{summary:{session_id:'s-archived'}}],next_cursor:cursor};},setArchives:value=>rows.push(value),setArchiveCursor:()=>{},setError:()=>{},setLoading:()=>{},archiveRequestVersion:{current:0}});
 await load();assert.equal(calls.length,1);assert.equal(calls[0].command,'list_archived_sessions');assert.equal(calls[0].args.request.page_size,100);
 assert.equal(rows.at(-1)[0].summary.session_id,'s-archived');
});
test('archive browser remains reachable when the hot history is empty',()=>{
 const app=source('App.tsx').text;assert.ok(/<HistoryArchive\b/.test(app),'archive component is connected to App');assert.ok(/aria-label="(?:Open |Browse )?archived sessions"/i.test(app),'archive browser has a permanent accessible entry');
});
test('global log continuation is sent even when an earlier bounded scan has no hits',async()=>{
 const calls=[];const cursor={source_offset:256};
 const search=run('search',{invoke:async(command,args)=>{calls.push({command,args});return {hits:[],has_more:false,complete:false,issues:[],next_cursor:cursor};},setBusy:()=>{},setError:()=>{},setHit:()=>{},previews:{current:{cancel:()=>{}}},requests:{current:{run:load=>load()}},scope:'',query:'中文 😀',sensitive:true,setPage:()=>{},setSkip:()=>{},setSearched:()=>{}},'SessionLogSearch.tsx');
 await search(0,cursor);assert.deepEqual(calls[0].args.request.source_cursor,cursor);assert.equal(calls[0].args.sessionId,null);
 const tree=source('SessionLogSearch.tsx');let continuation;
 const visit=node=>{if(ts.isJsxElement(node)&&node.children.some(child=>ts.isJsxText(child)&&/Continue (?:search|scan)/i.test(child.text)))continuation=node.getText(tree);ts.forEachChild(node,visit);};visit(tree);
 assert.ok(continuation,'partial global scans expose a continuation action even with zero hits');
});

function archiveRowLabel(section) {
 const tree=source('HistoryArchive.tsx');let area;
 const visit=node=>{if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(tree)==='aria-label'&&attribute.initializer?.text===section))area=node;ts.forEachChild(node,visit);};visit(tree);
 assert.ok(area,`${section} is rendered`);let label;
 const labels=node=>{if(ts.isJsxExpression(node)&&node.expression&&ts.isJsxElement(node.parent)&&['span','button'].includes(node.parent.openingElement.tagName.getText(tree))&&/record\.summary/.test(node.expression.getText(tree)))label=node.expression.getText(tree);ts.forEachChild(node,labels);};labels(area);
 assert.ok(label,`${section} renders a record label`);return label;
}
function actualAppTitleFor(titles) {
 const tree=source('App.tsx');let initializer;
 const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='titleFor')initializer=node.initializer.getText(tree);ts.forEachChild(node,visit);};visit(tree);
 assert.ok(initializer,'existing App titleFor is available');
 const js=ts.transpileModule(`const titleFor=${initializer};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 return new Function('sessionTitles',`${js};return titleFor;`)(titles);
}
for(const section of ['Sessions available to archive','Archived history'])test(`T04 review F3: ${section} uses the custom title in the actual JSX label`,()=>{
 const titleFor=actualAppTitleFor({'s-custom':'自定义任务 😀'});
 const record={summary:{session_id:'s-custom',title:'native fallback',cwd:'/repo'}};
 const expression=archiveRowLabel(section);
 const label=new Function('record','titleFor',`return ${expression};`)(record,titleFor);
 assert.equal(label,'自定义任务 😀');
 const fallback=new Function('record','titleFor',`return ${expression};`)({...record,summary:{...record.summary,session_id:'s-default'}},titleFor);
 assert.equal(fallback,'native fallback');
});
test('T04 review F3: App supplies its existing titleFor to the archive component',()=>{
 const tree=source('App.tsx');let bound;
 const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='HistoryArchive')bound=node.attributes.properties.find(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(tree)==='titleFor');ts.forEachChild(node,visit);};visit(tree);
 assert.ok(bound,'actual archive component receives App titleFor');assert.equal(bound.initializer.expression.getText(tree),'titleFor');
});
