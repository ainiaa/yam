import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryLabel, startMemoryPolling} from '../src/memory.ts';

test('default clock calls browser timers with their Window receiver through start, refresh and disposal',async()=>{
 const keys=['setInterval','clearInterval','setTimeout','clearTimeout'];
 const originals=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));const calls=[];
 try {
  for(const key of keys)globalThis[key]=function(){assert.equal(this,globalThis,`${key} requires Window`);calls.push(key);return 1;};
  const stop=startMemoryPolling(()=>Promise.resolve({application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:Date.now()}),()=>{},()=>true);
  await new Promise(setImmediate);stop();
  assert.deepEqual(calls,['setInterval','setTimeout','clearInterval','clearTimeout']);
 } finally {for(const key of keys)globalThis[key]=originals[key];}
});

test('memory label separates application/workloads and refuses incomplete or invalid totals',()=>{
 const sample={application_bytes:104857600,workload_bytes:52428800,metric:'physical footprint',sampled_at:1000};
 assert.equal(memoryLabel(sample,2000),'YAM 100.0 MiB · Tasks 50.0 MiB');
 assert.equal(memoryLabel({...sample,workload_bytes:0},2000),'YAM 100.0 MiB');
 for(const value of [null,{...sample,application_bytes:null},{...sample,application_bytes:-1},{...sample,workload_bytes:NaN},{...sample,metric:'unknown'},{...sample,sampled_at:3000}]) assert.equal(memoryLabel(value,2000),'Memory unavailable');
 assert.equal(memoryLabel(sample,12000),'Memory unavailable');
});

test('polling avoids overlap, clears stale/hidden samples, handles rejection, and disposes pending updates',async()=>{
 let tick,now=1000,visible=true,calls=0,resolve,reject;const values=[];
 const clock={now:()=>now,setInterval:fn=>{tick=fn;return 1;},clearInterval:id=>assert.equal(id,1),setTimeout:()=>2,clearTimeout:()=>{}};
 const stop=startMemoryPolling(()=>{calls++;return new Promise((ok,no)=>{resolve=ok;reject=no;});},v=>values.push(v),()=>visible,clock);
 tick();assert.equal(calls,1);
 resolve({application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:now});await new Promise(setImmediate);assert.equal(values.at(-1).application_bytes,1);
 tick();assert.equal(calls,2);now=12001;tick();assert.equal(values.at(-1),null);assert.equal(calls,2);
 reject(new Error('denied'));await new Promise(setImmediate);assert.equal(values.at(-1),null);
 visible=false;tick();assert.equal(calls,2);visible=true;tick();assert.equal(calls,3);
 stop();const count=values.length;resolve({application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:now});await new Promise(setImmediate);assert.equal(values.length,count);tick();assert.equal(calls,3);
});

test('a hung refresh expires the displayed total without waiting for the next polling boundary',async()=>{
 let now=100,tick,expire,delay,call=0;const values=[];
 const sample={application_bytes:1,workload_bytes:0,metric:'RSS',sampled_at:100};
 const clock={now:()=>now,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout:(fn,ms)=>{expire=fn;delay=ms;return 2;},clearTimeout:()=>{}};
 const stop=startMemoryPolling(()=>++call===1?Promise.resolve(sample):new Promise(()=>{}),v=>values.push(v),()=>true,clock);
 await new Promise(setImmediate);assert.equal(values.at(-1),sample);assert.equal(delay,10001);
 now=5000;tick();now=10000;tick();assert.equal(values.at(-1),sample);
 now=10101;expire();assert.equal(values.at(-1),null);assert.equal(call,2);stop();
});

 test('memory stays visible in the persistent status bar with or without a selected session',async()=>{
 const {readFileSync}=await import('node:fs');const ts=(await import('typescript')).default;
 const text=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 const tree=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let memory;const parents=[];function visit(node,ancestors=[]){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==='MemoryUsage'){memory=node;parents.push(...ancestors);}
  ts.forEachChild(node,child=>visit(child,[...ancestors,node]));
 }visit(tree);assert.ok(memory);
 assert.ok(!parents.some(node=>ts.isJsxElement(node)&&node.openingElement.getText(tree).includes('session-diagnostics')));
 assert.ok(parents.some(node=>ts.isJsxElement(node)&&node.openingElement.getText(tree).includes('workspace-footer')));
 assert.ok(!parents.some(node=>ts.isJsxElement(node)&&node.openingElement.getText(tree).includes('diagnostics-details')));
 assert.ok(!parents.some(node=>ts.isBinaryExpression(node)&&node.left.getText(tree)==='session'&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken),'diagnostics survives empty selection');
 });

// Author: Jeff.Liu. Sampling must update the status leaf, never the workspace state owner.
test('memory sampling owns state in the footer leaf instead of rerendering the workspace',async()=>{
 const {readFileSync}=await import('node:fs');const ts=(await import('typescript')).default;
 const text=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const functions=new Map();let footer;
 function scan(n){if(ts.isFunctionDeclaration(n)&&n.name)functions.set(n.name.text,n);if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(tree)==='footer'&&n.openingElement.getText(tree).includes('workspace-footer'))footer=n;ts.forEachChild(n,scan);}scan(tree);
 assert.ok(functions.has('MemoryUsage'),'memory updates need their own component state owner');
 assert.ok(ts.isSourceFile(functions.get('MemoryUsage').parent),'stable component identity preserves the polling effect across parent renders');
 const {t,setLocale,i18n}=await import('../src/i18n.ts');setLocale('en');
 assert.doesNotMatch(functions.get('App').getText(tree),/startMemoryPolling\(/,'periodic sampling must not update the App state');
 assert.match(footer.getText(tree),/<MemoryUsage\s*\//,'memory remains in the persistent footer');
 const effects=[],calls=[];let value=null,stop=0,scope;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
 const render=new Function('React','useState','useEffect','startMemoryPolling','invoke','memoryLabel','t','useTranslation','i18n',ts.transpile(functions.get('MemoryUsage').getText(tree),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})+';return MemoryUsage')(React,()=>[value,next=>value=next],(fn,deps)=>{assert.deepEqual(deps,[]);effects.push(fn);},(read,publish,visible)=>{scope={read,publish,visible};return()=>stop++;},async name=>{calls.push(name);return {application_bytes:1048576,workload_bytes:0,metric:'RSS',sampled_at:Date.now()};},memoryLabel,t,(_,{i18n:instance})=>assert.equal(instance,i18n),i18n);
 const originalDocument=globalThis.document;
 try{globalThis.document={visibilityState:'visible',documentElement:{lang:'en'}};
  let node=render();assert.equal(node.type,'span');assert.equal(node.props.className,'memory-usage');assert.match(node.props.children[0],/unavailable/);
  const dispose=effects.shift()();assert.equal(scope.visible(),true);globalThis.document.visibilityState='hidden';assert.equal(scope.visible(),false);
  scope.publish(await scope.read());assert.deepEqual(calls,['memory_usage']);node=render();assert.equal(node.props.children[0],'YAM 1.0 MiB');assert.match(node.props.title,/physical|WebKit/);
  scope.publish({...value,workload_bytes:2097152});assert.equal(render().props.children[0],'YAM 1.0 MiB · Tasks 2.0 MiB');
  setLocale('zh-CN');assert.equal(render().props.children[0],memoryLabel(value,Date.now(),t));assert.ok(!render().props.children[0].includes('Tasks'));
  scope.publish(null);assert.equal(render().props.children[0],t('Memory unavailable'));dispose();assert.equal(stop,1);
 }finally{setLocale('en');if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;}
});

test('selection release refreshes current controls once without a periodic App render',async()=>{
 const {readFileSync}=await import('node:fs');const ts=(await import('typescript')).default;
 const text=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 function scan(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='finishSelection')callback=n.initializer;ts.forEachChild(n,scan);}scan(tree);assert.ok(callback);
 for(const options of [{selected:true,live:true,refreshes:1},{selected:false,live:true,refreshes:0},{selected:true,live:false,refreshes:0}]){
  const view={selecting:true,disposed:!options.live,moving:false};let refreshes=0;
  const release=new Function('view','id','sessionId','terminalMounted','setRecoveryRevision',ts.transpile('return ('+callback.getText(tree)+');',{target:ts.ScriptTarget.ES2022}))(view,'selected',{current:options.selected?'selected':'other'},{current:true},update=>{assert.equal(update(4),5);refreshes++;});
  release();assert.equal(view.selecting,false);assert.equal(refreshes,options.refreshes);release();assert.equal(refreshes,options.refreshes,'an unrelated pointerup must not rerender');
 }
});
