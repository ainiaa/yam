import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LatestLogRequest} from '../src/session-logs.ts';

test('current log requests return values and expose actual read failures',async()=>{
 const requests=new LatestLogRequest();
 assert.deepEqual(await requests.run(async()=>({hits:[]})),{hits:[]});
 await assert.rejects(requests.run(async()=>{throw Error('read failed');}),/read failed/);
});

test('late results and errors never replace a newer search',async()=>{
 const requests=new LatestLogRequest();let resolve,reject;
 const first=requests.run(()=>new Promise(r=>resolve=r));
 assert.equal(await requests.run(async()=> 'new'),'new');
 resolve('old');assert.equal(await first,undefined);
 const oldFailure=requests.run(()=>new Promise((_,r)=>reject=r));
 assert.equal(await requests.run(async()=> 'latest'),'latest');
 reject(Error('stale'));assert.equal(await oldFailure,undefined);
});

test('closing or cancelling a search invalidates an outstanding response',async()=>{
 const requests=new LatestLogRequest();let resolve;
 const outstanding=requests.run(()=>new Promise(r=>resolve=r));
 requests.cancel();resolve('cancelled');assert.equal(await outstanding,undefined);
 assert.equal(await requests.run(async()=> 'next'),'next');
});

import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as logPolicy from '../src/session-logs.ts';

const knownRange=(start,end,bytes,truncation='truncated')=>({start_offset:start,end_offset_exclusive:end,retained_bytes:bytes,truncation});
test('F6 exact decimal ranges retain u64 precision and UTF8 byte budgets',()=>{
 const range=knownRange('18446744073709551611','18446744073709551615',4);
 assert.deepEqual(logPolicy.normalizeRetainedRange(range),range);
 assert.match(logPolicy.formatRetainedRange(range),/18446744073709551611.*18446744073709551615/);
 assert.deepEqual(logPolicy.normalizeRetainedRange(knownRange('0','0',0,'complete')),knownRange('0','0',0,'complete'));
});
test('F6 malformed missing and legacy ranges stay unknown',()=>{
 for(const range of [undefined,null,{},knownRange('01','2',1),knownRange('0','18446744073709551616',1),knownRange('3','2',1),knownRange('0','2',3),knownRange('0','2',2,'truncated'),knownRange('1','2',1,'complete'),knownRange('0','8388609',8388609)]){
  assert.equal(logPolicy.normalizeRetainedRange(range).truncation,'unknown');
 }
 assert.equal(logPolicy.normalizeRetainedRange({start_offset:null,end_offset_exclusive:null,retained_bytes:4,truncation:'unknown'}).retained_bytes,4);
});
test('F6 saved receipts preserve legacy string and null without casting objects',()=>{
 assert.equal(logPolicy.normalizeLogExport(null),null);
 assert.equal(logPolicy.normalizeLogExport('/legacy.txt').path,'/legacy.txt');
 assert.equal(logPolicy.normalizeLogExport('/legacy.txt').range.truncation,'unknown');
 assert.deepEqual(logPolicy.normalizeLogExport({path:'/new.txt',range:knownRange('0','4',4,'complete')}).range,knownRange('0','4',4,'complete'));
 assert.throws(()=>logPolicy.normalizeLogExport({path:42,range:{}}));
});

function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};}
function componentHarness(filename,invoke) {
 const source=readFileSync(new URL('../src/'+filename,import.meta.url),'utf8');
 const cells=[],effects=[];let index=0,pending=[],writes=[];
 const React={
  useRef(value){const i=index++;return cells[i]??=( {current:value} );},
  useState(value){const i=index++;if(!(i in cells))cells[i]=value;return[cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;writes.push([i,cells[i]]);}];},
  useEffect(callback,deps){const i=index++;const old=effects[i];if(!old||!deps||deps.some((d,j)=>d!==old.deps[j])){effects[i]={deps,cleanup:old?.cleanup,callback};pending.push(()=>{effects[i].cleanup?.();effects[i].cleanup=callback();});}}
 };
 const jsx=(type,props)=>({type,props});const exports={};
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','exports',js)(name=>name==='react'?React:name==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'fragment'}:name==='@tauri-apps/api/core'?{invoke}:name==='./session-logs'?logPolicy:(()=>{throw Error('Unexpected import '+name);})(),exports);
 const component=exports[filename.replace('.tsx','')];
 return{render(props,flush=true){index=0;const tree=component(props);if(flush)this.flush();return tree;},flush(){const jobs=pending;pending=[];jobs.forEach(f=>f());},clear(){writes=[];},get writes(){return writes;},replayEffects(){effects.forEach(e=>{if(e){e.cleanup?.();e.cleanup=e.callback();}});},unmount(){effects.forEach(e=>e?.cleanup?.());},cells};
}
function nodes(tree,predicate){const result=[];function visit(x){if(!x)return;if(Array.isArray(x)){x.forEach(visit);return;}if(typeof x==='object'){if(predicate(x))result.push(x);visit(x.props?.children);}}visit(tree);return result;}
const exportProps=(id='A',title=id)=>({sessionId:id,title,onClose:()=>{}});
const save=tree=>nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});

test('F6 actual export current receipt renders captured exact range',async()=>{
 const h=componentHarness('SessionLogExport.tsx',async()=>({path:'/saved',range:knownRange('9007199254740993','9007199254740997',4)}));
 save(h.render(exportProps()));await new Promise(r=>setImmediate(r));
 const text=JSON.stringify(h.render(exportProps()));assert.match(text,/Saved to \/saved/);assert.match(text,/9007199254740993/);assert.doesNotMatch(text,/\[object Object\]/);
});
for(const outcome of ['success','error'])test('F6 actual export A late '+outcome+' cannot write B before passive effects',async()=>{
 const d=deferred(),calls=[];const h=componentHarness('SessionLogExport.tsx',(name,args)=>{calls.push(args);return d.promise;});
 save(h.render(exportProps()));h.render(exportProps('B'),false);h.clear();outcome==='success'?d.resolve('/old'):d.reject(Error('old error'));await new Promise(r=>setImmediate(r));
 assert.deepEqual(h.writes,[]);assert.equal(calls.length,1);assert.equal(calls[0].sessionId,'A');h.flush();assert.doesNotMatch(JSON.stringify(h.render(exportProps('B'))),/old|Saving/);
});
for(const transition of ['ABA','unmount','title'])test('F6 actual export old finally fenced after '+transition,async()=>{
 const d=deferred();const h=componentHarness('SessionLogExport.tsx',()=>d.promise);save(h.render(exportProps()));
 if(transition==='unmount')h.unmount();else if(transition==='ABA'){h.render(exportProps('B'),false);h.render(exportProps('A'),false);}else h.render(exportProps('A','new title'),false);
 h.clear();d.resolve('/old');await new Promise(r=>setImmediate(r));assert.deepEqual(h.writes,[]);
});
test('F6 actual export stale A callback cannot dispatch a save after B render',()=>{
 const calls=[];const h=componentHarness('SessionLogExport.tsx',async(n,a)=>{calls.push(a);return null;});const old=h.render(exportProps());h.render(exportProps('B'),false);save(old);assert.deepEqual(calls,[]);
});
test('F6 actual export latest save owns busy across old finalizer',async()=>{
 const a=deferred(),b=deferred();const h=componentHarness('SessionLogExport.tsx',(n,x)=>x.sessionId==='A'?a.promise:b.promise);save(h.render(exportProps()));save(h.render(exportProps('B')));h.clear();a.resolve('/old');await new Promise(r=>setImmediate(r));assert.deepEqual(h.writes,[]);assert.match(JSON.stringify(h.render(exportProps('B'))),/Saving/);b.resolve(null);await new Promise(r=>setImmediate(r));assert.doesNotMatch(JSON.stringify(h.render(exportProps('B'))),/Saving|Saved/);
});
test('F6 actual search unsafe numeric offset selects session but never requests excerpt',async()=>{
 const calls=[],selected=[];const h=componentHarness('SessionLogSearch.tsx',async(n,a)=>{calls.push([n,a]);return {hits:[{session_id:'A',cwd:'/a',offset:9007199254740992,column:0,text:'hit'}],has_more:false,complete:true,issues:[]};});
 const props={sessions:[],selected:'A',onClose(){},async onSelect(id){selected.push(id);}};
 let tree=h.render(props);const input=nodes(tree,n=>n.type==='input'&&n.props['aria-label']==='Log content query')[0];input.props.onChange({target:{value:'hit'}});tree=h.render(props);nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setImmediate(r));tree=h.render(props);const li=nodes(tree,n=>n.type==='li')[0];li.props.children.props.onClick();await new Promise(r=>setImmediate(r));
 assert.deepEqual(selected,['A']);assert.equal(calls.filter(([n])=>n==='read_log_excerpt').length,0);assert.match(JSON.stringify(h.render(props)),/position unknown/i);
});
test('opening log search focuses the query after the native modal opens',()=>{
 const source=readFileSync(new URL('../src/SessionLogSearch.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('search.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let effect;
 function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect')effect=node.arguments[0].getText(ast);ts.forEachChild(node,visit);}
 visit(ast);assert.ok(effect);
 const calls=[];
 // Evaluate the actual effect callback, with observable native modal/focus operations.
 const js=ts.transpileModule('const effect='+effect,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
 const run=new Function('dialog','queryInput','requests','previews','invoke',js+';return effect;');
 const cleanup=run({current:{showModal:()=>calls.push('modal')}},{current:{focus:()=>calls.push('query')}},{current:{cancel:()=>{}}},{current:{cancel:()=>{}}},()=>Promise.resolve())();
 assert.deepEqual(calls,['modal','query']);cleanup();
});

for(const result of [null,'/legacy'])test('F6 actual export current cancel/legacy '+String(result),async()=>{
 const h=componentHarness('SessionLogExport.tsx',async()=>result);save(h.render(exportProps()));await new Promise(r=>setImmediate(r));const text=JSON.stringify(h.render(exportProps()));assert.doesNotMatch(text,/Saving/);if(result===null)assert.doesNotMatch(text,/Saved/);else assert.match(text,/Saved to \/legacy.*range unknown/);
});
test('F6 actual export current rejection stays visible and releases busy',async()=>{
 const h=componentHarness('SessionLogExport.tsx',async()=>{throw Error('cannot save');});save(h.render(exportProps()));await new Promise(r=>setImmediate(r));assert.match(JSON.stringify(h.render(exportProps())),/cannot save/);assert.doesNotMatch(JSON.stringify(h.render(exportProps())),/Saving/);
});
test('F6 actual export render hides previous receipt before identity passive effects',async()=>{
 const h=componentHarness('SessionLogExport.tsx',async()=>'/old');save(h.render(exportProps()));await new Promise(r=>setImmediate(r));assert.match(JSON.stringify(h.render(exportProps())),/Saved/);assert.doesNotMatch(JSON.stringify(h.render(exportProps('B'),false)),/Saved|old/);
});
test('F6 position labels require safe legacy numbers and known absolute provenance',()=>{
 const hit={session_id:'A',offset:0};assert.match(logPolicy.logHitPosition(hit),/Retained-log position 0/);
 assert.match(logPolicy.logHitPosition(hit,[{session_id:'A',range:knownRange('0','4',4,'complete')}]),/Output byte position 0/);
 for(const offset of [-1,Infinity,NaN,1.5,9007199254740992])assert.equal(logPolicy.isSafeLogOffset(offset),false);
 assert.equal(logPolicy.isSafeLogOffset(0),true);
});

test('F6 actual export effect setup-cleanup-setup permits current save but fences prior flight',async()=>{
 const old=deferred(),calls=[];const h=componentHarness('SessionLogExport.tsx',(n,a)=>{calls.push(a);return calls.length===1?old.promise:Promise.resolve(null);});
 const tree=h.render(exportProps());h.replayEffects();save(tree);assert.equal(calls.length,1);
 h.replayEffects();h.clear();old.resolve('/old');await new Promise(r=>setImmediate(r));assert.deepEqual(h.writes,[]);
 save(h.render(exportProps()));assert.equal(calls.length,2);await new Promise(r=>setImmediate(r));
});

test('F6 R1 absent or invalid retained byte metadata remains unknown',()=>{
 for(const value of [undefined,null,{}, {retained_bytes:null}, {retained_bytes:-1}, {retained_bytes:NaN}, {retained_bytes:Infinity}, {retained_bytes:1.5}, {retained_bytes:8388609}, {retained_bytes:'0'}]) {
  assert.equal(logPolicy.normalizeRetainedRange(value).retained_bytes,null);
  assert.match(logPolicy.formatRetainedRange(value),/retained byte count unknown/);
  assert.doesNotMatch(logPolicy.formatRetainedRange(value),/0 retained bytes/);
 }
 for(const range of [knownRange('0','0',0,'complete'),{retained_bytes:0,truncation:'unknown'}]) {
  assert.equal(logPolicy.normalizeRetainedRange(range).retained_bytes,0);
  assert.match(logPolicy.formatRetainedRange(range),/0 retained bytes/);
 }
});
test('F6 R1 actual legacy or missing range export does not fabricate empty bytes',async()=>{
 for(const result of ['/legacy-nonempty.txt',{path:'/missing-range.txt'},{path:'/invalid-bytes.txt',range:{retained_bytes:'0'}}]) {
  const h=componentHarness('SessionLogExport.tsx',async()=>result);
  save(h.render(exportProps()));await new Promise(r=>setImmediate(r));
  const text=JSON.stringify(h.render(exportProps()));assert.match(text,/Saved to/);
  assert.match(text,/retained byte count unknown/);assert.doesNotMatch(text,/0 retained bytes/);
 }
});
test('F6 R1 actual authoritative empty export retains zero byte label',async()=>{
 for(const range of [knownRange('0','0',0,'complete'),{retained_bytes:0,truncation:'unknown'}]) {
  const h=componentHarness('SessionLogExport.tsx',async()=>({path:'/empty.txt',range}));
  save(h.render(exportProps()));await new Promise(r=>setImmediate(r));
  assert.match(JSON.stringify(h.render(exportProps())),/0 retained bytes/);
 }
});
