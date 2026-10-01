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
