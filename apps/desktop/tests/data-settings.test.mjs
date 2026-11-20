// Author: Jeff.Liu. Exercise real async dialog callbacks without opening a desktop app.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {parsePreferencesBackup} from '../src/preferences-backup.ts';
import {startupTimings,timingSamples,timingPercentile} from '../src/startup-timings.ts';
const source=ts.createSourceFile('DataSettings.tsx',readFileSync(new URL('../src/DataSettings.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,bindings){let fn;const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text===name)fn=n;ts.forEachChild(n,visit);};visit(source);return new Function(...Object.keys(bindings),ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+`;return ${name}`)(...Object.values(bindings));}
test('data import ignores a late file read after unmount and never applies it',async()=>{let resolve;const pending=[],messages=[],mounted={current:true};const choose=callback('choose',{intent:{current:0},mounted,setPending:v=>pending.push(v),setMessage:v=>messages.push(v),parsePreferencesBackup,props:{mac:true}});const read=choose({size:20,text:()=>new Promise(done=>resolve=done)});mounted.current=false;resolve('{"version":1,"settings":{},"connections":[]}');await read;assert.deepEqual(pending,[null]);assert.deepEqual(messages,[null]);});
test('preference dialog reports incomplete rollback explicitly but never echoes an unknown exception',async()=>{for(const detail of ['Import failed and rollback was incomplete. Keep the backup and review settings.','/private/secret key=private']){const messages=[];const run=callback('run',{working:{current:false},mounted:{current:true},setBusy(){},setMessage:v=>messages.push(v),setPending(){}});await run(async()=>{throw Error(detail);},'success');if(detail.startsWith('Import failed'))assert.equal(messages.at(-1),detail);else assert.ok(!messages.at(-1).includes('/private'));}});
test('preference dialog keeps the reviewed import for explicit synchronization retry',async()=>{
 const detail='Preferences were imported locally, but window synchronization is incomplete. Confirm import again to retry synchronization.';
 const messages=[],pending=[],busy=[];
 const run=callback('run',{working:{current:false},mounted:{current:true},setBusy:value=>busy.push(value),setMessage:value=>messages.push(value),setPending:value=>pending.push(value)});
 await run(async()=>{throw Error(detail);},'success');
 assert.equal(messages.at(-1),detail);
 assert.deepEqual(pending,[]);
 assert.deepEqual(busy,[true,false]);
 await run(async()=>{},'success');
 assert.equal(messages.at(-1),'success');
 assert.deepEqual(pending,[null]);
});

test('performance settings render switch samples with an explicit attachment-only boundary',()=>{
 const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='DataSettings'),React={createElement:(type,props,...children)=>({type,props,children:children.flat(Infinity)})};
 const values={React,useRef:value=>({current:value}),useState:value=>[value,()=>{}],useEffect(){},startupTimings,timingSamples,timingPercentile,performance:{getEntriesByType:()=>[{name:'yam.view.switch',duration:12},{name:'yam.view.switch',duration:30}]},t:x=>x};
 const render=new Function(...Object.keys(values),ts.transpile(fn.getText(source).replace('export default ',''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})+';return DataSettings;')(...Object.values(values));
 const nodes=n=>[n,...(n.children??[]).filter(c=>c&&typeof c==='object').flatMap(nodes)],view=render({navigation:()=>null}),all=nodes(view),row=all.find(n=>n.type==='tr'&&n.children.some(c=>c?.children?.includes('Switch session view')));
 assert.ok(row);assert.deepEqual(row.children.map(c=>c.children[0]),['Switch session view',2,12,30]);assert.ok(all.some(n=>n.type==='p'&&n.children.some(c=>typeof c==='string'&&c.includes('not keyboard-to-pixel latency'))));
});
