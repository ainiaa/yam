// Author: Jeff.Liu. Cache compiled text, never a scene's mutable execution context.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cachedCompilation,componentFunction} from './fixtures/component-function.mjs';

test('fixture compilation reuses complete source and invalidates changed source',()=>{
 const inputs=[];
 const compile=cachedCompilation(source=>{inputs.push(source);return source;});
 assert.equal(compile('return value;'),'return value;');
 assert.equal(compile('return value;'),'return value;');
 assert.equal(compile('return value + 1;'),'return value + 1;');
 assert.equal(compile(''),'');assert.equal(compile(''),'');
 assert.deepEqual(inputs,['return value;','return value + 1;','']);
});

test('failed fixture compilation is not cached and compiler instances stay independent',()=>{
 let attempts=0;
 const compile=cachedCompilation(source=>{if(++attempts===1)throw Error('invalid source');return source;});
 assert.throws(()=>compile('source'),/invalid source/);
 assert.equal(compile('source'),'source');assert.equal(compile('source'),'source');
 assert.equal(attempts,2);
 assert.equal(cachedCompilation(()=> 'other compiler')('source'),'other compiler');
});

test('cached fixture code creates separate closures refs storage and pending replies',async()=>{
 let compilations=0;
 const compile=cachedCompilation(source=>{compilations++;return source;});
 const source='let count=0;return {next(){ref.current++;storage.push(++count);return pending.then(value=>value+count);}};';
 const scene=()=>{
  let resolve;const pending=new Promise(done=>resolve=done),ref={current:0},storage=[];
  const callbacks=componentFunction('ref','storage','pending',compile(source))(ref,storage,pending);
  return {ref,storage,resolve,...callbacks};
 };
 const first=scene(),second=scene();
 const a=first.next();first.resolve(10);assert.equal(await a,11);
 assert.equal(second.ref.current,0);assert.deepEqual(second.storage,[]);
 const b=second.next();second.resolve(20);assert.equal(await b,21);
 assert.deepEqual(first.storage,[1]);assert.deepEqual(second.storage,[1]);
 assert.equal(compilations,1);
});
