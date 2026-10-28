// Author: Jeff.Liu. Native IDs, bounded refresh queues and owner/run isolation.
import test from 'node:test';import assert from 'node:assert/strict';import * as conversation from '../src/conversation-view.ts';
const {ConversationController}=conversation;
const token='12345678-1234-4234-8234-123456789abc';
const item=(id,text=id)=>({id,turn_id:'turn',kind:'agent',text,paths:[],truncated:false});
const page=(args,items,extra={})=>({query_token:args.query_token,session_id:args.session_id,thread_id:'native',generation:'g',read_at:1,direction:'desc',items,next_cursor:'older',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
test('R3C refresh updates native IDs, appends new messages and retains older page cursor',async()=>{
 const c=new ConversationController(()=>token);c.select('owner','s-one','native','g');await c.load(async(n,a)=>page(a,[item('b'),item('a')]),()=>{});
 await c.load(async(n,a)=>page(a,[item('zero')],{next_cursor:'oldest'}),()=>{},true);
 await c.load(async(n,a)=>page(a,[item('c'),item('b','updated'),item('a')],{next_cursor:'fresh-cursor'}),()=>{});
 assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['zero','a','b','c']);assert.equal(c.snapshot.value.items.find(i=>i.id==='b').text,'updated');assert.equal(c.snapshot.value.next_cursor,'oldest');
 await c.load(async(n,a)=>page(a,[item('zero')],{next_cursor:null}),()=>{},true);assert.equal(c.snapshot.kind,'ready');assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['zero','a','b','c']);assert.equal(c.snapshot.value.next_cursor,null);
});
test('R3C refresh never silently discards read history at 500 or bridges a missing page',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native','g');let serial=0;
 const read=async(n,a)=>page(a,Array.from({length:a.limit},(_,i)=>item(`${serial}-${i}`)),{next_cursor:String(++serial)});
 await c.load(read,()=>{});for(let i=0;i<9;i++)await c.load(read,()=>{},true);const before=c.snapshot.value;
 await c.load(async(n,a)=>page(a,[item('new'),item('0-0')]),()=>{});assert.equal(c.snapshot.kind,'unavailable');assert.equal(c.snapshot.code,'conversation_view_limit');assert.deepEqual(c.snapshot.value,before);
 const d=new ConversationController(()=>token);d.select('A','s-one','native','g');await d.load(async(n,a)=>page(a,[item('old')]),()=>{});await d.load(async(n,a)=>page(a,Array.from({length:50},(_,i)=>item(`new-${i}`))),()=>{});assert.equal(d.snapshot.code,'conversation_history_gap');assert.equal(d.snapshot.value.items[0].id,'old');
});
test('R3C only authenticated completed round revisions create refresh signals',()=>{
 assert.equal(typeof conversation.conversationRoundRevision,'function');const valid={generation:'g',agent_session_id:'native',turn_id:'turn',phase:'response_finished',integration:'connected',revision:10};
 assert.equal(conversation.conversationRoundRevision(valid),10);for(const phase of ['needs_permission','needs_attention','interrupted','failed'])assert.equal(conversation.conversationRoundRevision({...valid,phase}),10);
 for(const extra of [{phase:'working'},{phase:'idle'},{integration:'connecting'},{integration:'unavailable'},{turn_id:null},{generation:''},{agent_session_id:null},{revision:-1},{revision:NaN},{revision:1.2}])assert.equal(conversation.conversationRoundRevision({...valid,...extra}),null);assert.equal(conversation.conversationRoundRevision(undefined),null);
});
test('R3C trusted duplicate and out-of-order events coalesce into one latest refresh without cancelling the current page',async()=>{
 const c=new ConversationController(()=>token),p=deferred(),calls=[];c.select('owner','s-one','native','g',4);
 const invoke=(n,a)=>{calls.push([n,a]);return n==='cancel_codex_conversation'?Promise.resolve():calls.filter(x=>x[0]==='read_codex_conversation').length===1?p.promise:Promise.resolve(page(a,[item('b'),item('a')],{next_cursor:null}));};
 const first=c.load(invoke,()=>{});for(const revision of [4,5,5,3,9,8,10])c.observe(invoke,()=>{},revision);
 assert.equal(calls.length,1);p.resolve(page(calls[0][1],[item('a')],{next_cursor:null}));await first;assert.equal(calls.length,2);assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['a','b']);await c.observe(invoke,()=>{},9);assert.equal(calls.length,2);
});
test('R3C queued round refresh merges an in-flight older page and close clears its pending action',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native','g');await c.load(async(n,a)=>page(a,[item('a')]),()=>{});
 const p=deferred(),calls=[];const invoke=(n,a)=>{calls.push([n,a]);return n==='cancel_codex_conversation'?Promise.resolve():calls.length===1?p.promise:Promise.resolve(page(a,[item('b'),item('a')]));};
 const older=c.load(invoke,()=>{},true);c.observe(invoke,()=>{},3);p.resolve(page(calls[0][1],[item('zero')],{next_cursor:null}));await older;assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['zero','a','b']);
 const q=deferred();const pending=c.load((n,a)=>n==='cancel_codex_conversation'?Promise.resolve():q.promise,()=>{});c.observe(invoke,()=>{},4);const count=calls.length;c.cancel();q.resolve(page({session_id:'s-one',query_token:token},[item('late')]));await pending;assert.equal(calls.length,count);assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['zero','a','b']);
});
test('R3C two Continue runs and owner reconnect rebind YAM run while preserving native thread',async()=>{
 const c=new ConversationController(()=>token),calls=[];for(let run=1;run<=3;run++){c.select(`owner-${run}`,`s-${run}`,'native',`g-${run}`);assert.equal(c.snapshot.kind,'idle');await c.load(async(n,a)=>{calls.push([n,a]);return page(a,[item('a')],{generation:`g-${run}`});},()=>{});assert.equal(c.snapshot.value.session_id,`s-${run}`);}
 c.select('reconnected','s-3','native','g-3');assert.equal(c.snapshot.kind,'idle');assert.deepEqual(calls.map(c=>c[0]),['read_codex_conversation','read_codex_conversation','read_codex_conversation']);
});
test('R3C an empty history refreshed to more than one page keeps the new cursor',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native','g');await c.load(async(n,a)=>page(a,[],{next_cursor:null}),()=>{});await c.load(async(n,a)=>page(a,Array.from({length:50},(_,i)=>item(`fresh-${i}`)),{next_cursor:'more-history'}),()=>{});assert.equal(c.snapshot.value.next_cursor,'more-history');
});
test('R3C cancelling an observed revision does not acknowledge unseen messages',async()=>{
 for(const queued of [false,true]){const c=new ConversationController(()=>token);c.select('A','s-one','native','g');await c.load(async(n,a)=>page(a,[item('a')]),()=>{});const p=deferred(),calls=[];
 const invoke=(n,a)=>{calls.push([n,a]);return n==='cancel_codex_conversation'?Promise.resolve():p.promise;};
 const active=queued?c.load(invoke,()=>{},true):c.observe(invoke,()=>{},7);if(queued)c.observe(invoke,()=>{},7);c.cancel();p.resolve(page(calls[0][1],[item('late')]));await active;
 const before=calls.length;await c.observe(async(n,a)=>{calls.push([n,a]);return page(a,[item('b'),item('a')]);},()=>{},7);assert.equal(calls.length,before+1);assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['a','b']);}
});
