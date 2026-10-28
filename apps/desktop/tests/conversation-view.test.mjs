// Author: Jeff.Liu.
import test from 'node:test';import assert from 'node:assert/strict';
import {ConversationController,isConversationPage} from '../src/conversation-view.ts';
const token='12345678-1234-4234-8234-123456789abc';
const item=(id,extra={})=>({id,turn_id:'turn',kind:'agent',text:'<script>literal</script>',paths:[],truncated:false,...extra});
const reply=(a,extra={})=>({query_token:a.query_token,session_id:a.session_id,thread_id:'native-one',generation:'g',read_at:1,direction:a.direction??'desc',items:[item('two'),item('one')],next_cursor:'opaque-next',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
test('R3A native DTO accepts only bounded display projections, ordered IDs and opaque cursors',()=>{
 const r=reply({query_token:token,session_id:'s-one'});assert.ok(isConversationPage(r));
 for(const extra of [{secret:'HIDDEN'},{items:[item('one',{secret:'HIDDEN'})]},{items:[item('one',{kind:'reasoning'})]},{items:[item('one',{text:'x'.repeat(65537)})]},{items:[item('one'),item('one')]},{items:Array.from({length:51},(_,i)=>item(String(i)))},{next_cursor:'x'.repeat(8193)},{query_token:'bad'},{read_at:-1},{thread_id:''},{direction:'bad'},{items:[item('one',{paths:['bad\npath']})]}])assert.equal(isConversationPage({...r,...extra}),false,JSON.stringify(extra).slice(0,120));
 assert.ok(isConversationPage({...r,items:[],next_cursor:null}));assert.ok(isConversationPage({...r,items:[item('utf8',{text:'😀'.repeat(16384),truncated:true})]}));
});
test('R3A controller requests only YAM identity and reverses descending native order for reading',async()=>{
 const c=new ConversationController(()=>token),calls=[];c.select('owner-scope','s-one','native-one','g');
 await c.load(async(n,a)=>{calls.push([n,a]);return reply(a)},()=>{});
 assert.deepEqual(calls,[['read_codex_conversation',{session_id:'s-one',query_token:token,cursor:null,limit:50,direction:'desc'}]]);
 assert.equal(c.snapshot.kind,'ready');assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['one','two']);
 await c.load(async(n,a)=>{calls.push([n,a]);return reply(a,{items:[item('zero')],next_cursor:null})},()=>{},true);
 assert.equal(calls.at(-1)[1].cursor,'opaque-next');assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['zero','one','two']);
});
test('R3A controller suppresses late results after close session native generation or owner change',async()=>{
 for(const fail of [false,true]){const c=new ConversationController(()=>token),p=deferred(),calls=[];let changed=0;c.select('A','s-one','native-one','g');const a=c.load((n,args)=>{calls.push([n,args]);return n==='cancel_codex_conversation'?Promise.resolve():p.promise},()=>changed++);c.select('B','s-other','native-two','g2');if(fail)p.reject('PRIVATE');else p.resolve(reply(calls[0][1]));await a;assert.equal(c.snapshot.kind,'idle');assert.equal(calls.at(-1)[0],'cancel_codex_conversation');assert.equal(changed,1);}
});
test('R3A controller has one active request and one latest pending action',async()=>{
 let n=0;const c=new ConversationController(()=>`12345678-1234-4234-8234-${String(++n).padStart(12,'0')}`),p=deferred(),calls=[];c.select('A','s-one','native-one','g');
 const invoke=(name,args)=>{calls.push([name,args]);return name==='cancel_codex_conversation'?Promise.resolve():calls.filter(x=>x[0]==='read_codex_conversation').length===1?p.promise:Promise.resolve(reply(args,{next_cursor:null}))};
 const a=c.load(invoke,()=>{});c.load(invoke,()=>{});c.load(invoke,()=>{});assert.equal(calls.filter(x=>x[0]==='read_codex_conversation').length,1);p.resolve(reply(calls[0][1]));await a;assert.equal(calls.filter(x=>x[0]==='read_codex_conversation').length,2);assert.equal(c.snapshot.kind,'ready');
});
test('R3A mismatched identity, duplicate pages and arbitrary errors fail closed',async()=>{
 for(const extra of [{query_token:'00000000-0000-0000-0000-000000000000'},{session_id:'s-other'},{thread_id:'other'},{generation:'other'},{direction:'asc'}]){const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');await c.load(async(n,a)=>reply(a,extra),()=>{});assert.equal(c.snapshot.code,'conversation_invalid_response');}
 const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');await c.load(async(n,a)=>reply(a),()=>{});await c.load(async(n,a)=>reply(a),()=>{},true);assert.equal(c.snapshot.code,'conversation_invalid_response');
 for(const reason of ['PRIVATE',Error('PRIVATE'),'conversation_cancelled']){const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');await c.load(async()=>{throw reason},()=>{});assert.equal(c.snapshot.code,reason==='conversation_cancelled'?reason:'conversation_unavailable');}
});
test('R3A loaded view stops at 500 without silently dropping history',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');let page=0,calls=0;const invoke=async(n,a)=>{calls++;return reply(a,{items:Array.from({length:50},(_,i)=>item(`${page}-${i}`)),next_cursor:`page-${++page}`})};
 await c.load(invoke,()=>{});for(let i=0;i<9;i++)await c.load(invoke,()=>{},true);assert.equal(c.snapshot.value.items.length,500);await c.load(invoke,()=>{},true);assert.equal(calls,10);assert.equal(c.snapshot.value.items.length,500);
});

test('R3A partial pages leave the last request only the remaining view budget',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');let calls=0;
 const invoke=async(n,a)=>reply(a,{items:Array.from({length:Math.min(a.limit,calls===0?49:50)},(_,i)=>item(`${calls}-${i}`)),next_cursor:`p-${++calls}`});
 await c.load(invoke,()=>{});for(let i=0;i<9;i++)await c.load(invoke,()=>{},true);assert.equal(c.snapshot.value.items.length,499);
 await c.load(invoke,()=>{},true);assert.equal(c.snapshot.value.items.length,500);
});

test('R3B pagination keeps already read content during loading and a safe failure',async()=>{
 const c=new ConversationController(()=>token);c.select('A','s-one','native-one','g');await c.load(async(n,a)=>reply(a),()=>{});
 const p=deferred(),loading=c.load(()=>p.promise,()=>{},true);assert.equal(c.snapshot.kind,'loading');assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['one','two']);
 p.reject('conversation_timed_out');await loading;assert.equal(c.snapshot.code,'conversation_timed_out');assert.deepEqual(c.snapshot.value.items.map(i=>i.id),['one','two']);
 c.select('B','s-two','other','g2');assert.equal('value' in c.snapshot,false);
});
