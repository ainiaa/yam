import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function coordinator(name) {
 let found,cancellation;const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==="cancelLayoutRestore")cancellation=node.getText(source);if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(source);ts.forEachChild(node,visit);};visit(source);
 assert.ok(found,`${name} exists`);
 return ts.transpileModule((cancellation??"")+"\n"+found,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
}
function refreshHarness(invoke) {
 const records=[];const errors=[];const overview=[];const cursor=[];
 const factory=new Function('invoke','historyRefreshVersion','setHistory','notifySession','setError','historyQuery','statusFilter','sessionTitles','projects','historyRequest','setHistoryCursor','setHistoryOverview','setHistoryLoading','refreshInbox','refreshPendingNotifications','selectedRecord','setSelectedAgent','historyPager','historyContext',`${coordinator('refreshHistory')};return refreshHistory;`);
 const context={current:{query:'',status:'all',titles:{},projects:[]}};
 const refresh=factory(invoke,{current:0},value=>records.push(value),()=>{},value=>errors.push(value),'','all',{},[],query=>({page_size:100,query}),value=>cursor.push(value),value=>overview.push(value),()=>{},()=>{},()=>{}, {current:null},()=>{}, {current:null},context);
 return {refresh,records,errors,overview,cursor,context};
}
test('initial history loads exactly one bounded summary page',async()=>{
 const calls=[];const items=[{summary:{session_id:'s-one',cwd:'/repo',title:'中文 😀'},status:'succeeded',agent:{unread_count:0}}];
 const h=refreshHarness(async(command,args)=>{calls.push({command,args});return command==='list_session_summaries'?{items,next_cursor:{offset:100},revision:'owner:1'}:{total:101,active:0,unread_receipts:1,attention_sessions:1};});
 await h.refresh();
 assert.equal(calls.filter(call=>call.command==='list_session_summaries').length,1);
 assert.equal(calls.some(call=>call.command==='list_sessions'),false);
 assert.deepEqual(h.records.at(-1),items);
});
test('a stale initial response cannot replace a later history refresh',async()=>{
 let release;let reads=0;
 const h=refreshHarness(async(command)=>{if(command==='history_overview')return {};if(++reads===1)return new Promise(resolve=>release=resolve);return {items:[{summary:{session_id:'s-new'}}],next_cursor:null};});
 const old=h.refresh();await h.refresh();release({items:[{summary:{session_id:'s-old'}}],next_cursor:null});await old;
 assert.equal(h.records.at(-1)[0].summary.session_id,'s-new');
});

test('notification metadata is loaded by ID, never by the current page',()=>{
 const body=coordinator('notifySession');
 assert.match(body,/get_session/);assert.doesNotMatch(body,/list_sessions/);
});

function runCoordinator(name,bindings){bindings={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},...bindings};return new Function(...Object.keys(bindings),`${coordinator(name)};return ${name};`)(...Object.values(bindings));}
test('next page appends once and expired cursor requests a fresh first page',async()=>{
 let records=[{summary:{session_id:'s-one'}}];let cursor={offset:100};let refreshed=0;let error;
 const bindings={historyCursor:cursor,historyLoading:false,historyRefreshVersion:{current:0},setHistoryLoading:()=>{},historyRequest:()=>({}),historyQuery:'',statusFilter:'all',sessionTitles:{},projects:[],historyContext:{current:{query:'',status:'all',titles:{},projects:[]}},setHistory:next=>records=typeof next==='function'?next(records):next,setHistoryCursor:next=>cursor=next,setError:next=>error=next,refreshHistory:()=>refreshed++};
 bindings.invoke=async()=>({items:[{summary:{session_id:'s-two'}}],next_cursor:null});
 await runCoordinator('loadMoreHistory',bindings)();assert.deepEqual(records.map(r=>r.summary.session_id),['s-one','s-two']);assert.equal(cursor,null);
 bindings.invoke=async()=>{throw Error('History cursor expired; reload history');};await runCoordinator('loadMoreHistory',bindings)();assert.equal(refreshed,1);assert.deepEqual(records,[]);assert.equal(error,undefined);
});
test('startup pending notifications advances stable keys after acknowledgement',async()=>{
 const requests=[];const seen=[];let page=0;
 const fn=runCoordinator('refreshPendingNotifications',{pendingLoading:{current:false},invoke:async(command,args)=>{requests.push({command,args});return ++page===1?{items:[{session_id:'s-old',status:'succeeded'}],next_key:{started_at:1,session_id:'s-old'}}:{items:[{session_id:'s-next',status:'failed'}],next_key:null};},notifySession:async event=>seen.push(event.session_id),setNotificationError:()=>{}});
 await fn();assert.deepEqual(seen,['s-old','s-next']);assert.deepEqual(requests[1].args.afterKey,{started_at:1,session_id:'s-old'});assert.equal(requests.every(r=>r.args.limit===100),true);
});
test('an older session detail cannot select after a later request',async()=>{
 let release;const opened=[];let reads=0;
 const fn=runCoordinator('openSession',{detailVersion:{current:0},invoke:async()=>++reads===1?new Promise(resolve=>release=resolve):{summary:{session_id:'s-new'}},openHistory:async r=>opened.push(r.summary.session_id),sessionId:{current:'s-new'},setError:()=>{}});
 const old=fn('s-old');await fn('s-new');release({summary:{session_id:'s-old'}});await old;assert.deepEqual(opened,['s-new']);
});

test('a retained event callback reads the latest search context',async()=>{
 let request;
 const h=refreshHarness(async(command,args)=>{if(command==='list_session_summaries'){request=args.request;return {items:[],next_cursor:null};}return {};});
 h.context.current.query='中文 😀';await h.refresh();assert.equal(request.query,'中文 😀');
});

import {historyRequest,capacityLevel} from '../src/history.ts';
test('history request keeps Unicode aliases, bounded payload and page identity',()=>{
 const titles={'s-old':'中文 😀 renamed','s-other':'Other'};const projects=[{path:'/project',name:'中文 Alias'},{path:'/other',name:'Other'}];
 assert.deepEqual(historyRequest('中文','attention',titles,projects).matched_session_ids,['s-old']);
 assert.deepEqual(historyRequest('中文','attention',titles,projects).matched_project_paths,['/project']);
 assert.deepEqual(historyRequest('  ','all',titles,projects).matched_session_ids,[]);
 const cursor={revision:'instance:1',offset:100,context:'query'};assert.equal(historyRequest('', 'all',{},[],cursor).cursor,cursor);
 const huge=Object.fromEntries(Array.from({length:6000},(_,i)=>[`${i}-${'x'.repeat(200)}`,'match']));
 assert.throws(()=>historyRequest('match','all',huge,[]),/1 MiB/);
});
test('capacity warnings use exact 24 and 32 MiB boundaries',()=>{
 assert.equal(capacityLevel(24*1024*1024-1),'normal');assert.equal(capacityLevel(24*1024*1024),'warning');assert.equal(capacityLevel(32*1024*1024-1),'warning');assert.equal(capacityLevel(32*1024*1024),'protected');
});

test('a delayed notification detail cannot replace a newer user selection',async()=>{
 let release;const opened=[];const version={current:0};
 const fn=runCoordinator('selectNotificationSession',{active:true,detailVersion:version,invoke:async command=>command==='get_session'?new Promise(resolve=>release=resolve):'s-old',launchDialog:{current:null},projectDialog:{current:null},renameDialog:{current:null},openHistory:async record=>opened.push(record.summary.session_id),sessionId:{current:'s-new'},outputCursor:{current:1},setError:()=>{}});
 const old=fn('s-old');version.current++;release({summary:{session_id:'s-old'}});await old;assert.deepEqual(opened,[]);
});

test('a delayed next-attention lookup cannot override a later manual selection',async()=>{
 let release;const opened=[];const version={current:0};
 const next=runCoordinator('jumpToAttention',{detailVersion:version,sessionId:{current:'s-initial'},invoke:async()=>new Promise(resolve=>release=resolve),openSession:async id=>opened.push(id),setError:()=>{}});
 const manual=runCoordinator('openSession',{detailVersion:version,sessionId:{current:'s-manual'},invoke:async()=>({summary:{session_id:'s-manual'}}),openHistory:async record=>opened.push(record.summary.session_id),setError:()=>{}});
 const pending=next();await manual('s-manual');release('s-attention');await pending;
 assert.deepEqual(opened,['s-manual']);
});
test('the actual retry button condition and handler include a failed delivery after the first 100 receipts',async()=>{
 let condition,handler;
 const visit=node=>{
  if(ts.isJsxOpeningElement(node)&&node.attributes.properties.some(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)==='aria-label'&&prop.initializer?.text==='Retry round notifications')){
   handler=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)==='onClick').initializer.expression.getText(source);
   let parent=node.parent;while(parent&&!ts.isJsxExpression(parent))parent=parent.parent;
   condition=parent.expression.left.getText(source);
  }
  ts.forEachChild(node,visit);
 };visit(source);assert.ok(condition);assert.ok(handler);
 const all=Array.from({length:101},(_,index)=>({receipt:{delivery:index===100?'failed':'sent'}}));
 const inbox=all.slice(0,100);assert.equal(inbox.some(item=>item.receipt.delivery==='failed'),false);
 const historyOverview={failed_receipts:all.filter(item=>item.receipt.delivery==='failed').length};
 const conditionJs=ts.transpileModule(`function visible(){return ${condition};}`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const visible=new Function('inbox','historyOverview',`${conditionJs};return visible();`)(inbox,historyOverview);
 assert.equal(Boolean(visible),true);
 const calls=[];const handlerJs=ts.transpileModule(`const retry=${handler};`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const retry=new Function('invoke','setError',`${handlerJs};return retry;`)(async command=>calls.push(command),()=>{});
 retry();await new Promise(setImmediate);assert.deepEqual(calls,['retry_agent_notifications']);
});

test('repeated attention requests reserve selection order before their asynchronous lookups',async()=>{
 const releases=[];const opened=[];const version={current:0};
 const next=runCoordinator('jumpToAttention',{detailVersion:version,sessionId:{current:'s-initial'},invoke:async()=>new Promise(resolve=>releases.push(resolve)),openSession:async id=>{version.current++;opened.push(id);},setError:()=>{}});
 const older=next();const newer=next();assert.equal(version.current,2);
 releases[1]('s-new-attention');await newer;releases[0]('s-old-attention');await older;assert.deepEqual(opened,['s-new-attention']);
});
