// Author: Jeff.Liu. Local recovery copies never replace source files or silently evict drafts.
import test from 'node:test';import assert from 'node:assert/strict';
import {DraftStorage,DRAFT_STORAGE_KEY} from '../src/file-drafts.ts';
import {createPreferencesBackup} from '../src/preferences-backup.ts';
const revision='a'.repeat(64);
function memory(){const values=new Map([['other-setting','keep']]);return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
test('drafts are scoped to the project and file and survive a new controller instance',()=>{
 const storage=memory(),cache=new DraftStorage(storage);cache.write('/one','src/a.ts',revision,'mine');cache.write('/two','src/a.ts',revision,'other');
 const restored=new DraftStorage(storage);assert.equal(restored.get('/one','src/a.ts').draft,'mine');assert.equal(restored.list('/one').length,1);
 restored.remove('/one','src/a.ts',restored.get('/one','src/a.ts').token);assert.equal(restored.get('/one','src/a.ts'),null);assert.equal(restored.get('/two','src/a.ts').draft,'other');assert.equal(storage.values.get('other-setting'),'keep');
});
test('malformed or future recovery data is preserved and never overwritten',()=>{
 for(const raw of ['{broken',JSON.stringify({version:99,drafts:[]}),JSON.stringify({version:1,drafts:[{root:'/r',path:'../escape',revision,draft:'secret'}]})]){
  const storage=memory();storage.values.set(DRAFT_STORAGE_KEY,raw);const cache=new DraftStorage(storage);
  assert.throws(()=>cache.write('/r','a',revision,'new'),error=>error==='files_draft_storage');assert.equal(storage.values.get(DRAFT_STORAGE_KEY),raw);
  cache.clear();assert.equal(storage.values.has(DRAFT_STORAGE_KEY),false);
 }
});
test('count, text and aggregate bounds do not evict older unsaved work',()=>{
 const storage=memory(),cache=new DraftStorage(storage);for(let n=0;n<16;n++)cache.write('/r',String(n),revision,'draft');
 const old=storage.values.get(DRAFT_STORAGE_KEY);assert.throws(()=>cache.write('/r','extra',revision,'new'),error=>error==='files_draft_limit');assert.equal(storage.values.get(DRAFT_STORAGE_KEY),old);
 assert.throws(()=>cache.write('/r','0',revision,'中'.repeat(400000)),error=>error==='file_too_large');assert.throws(()=>cache.write('/r','0',revision,'a\0b'),error=>error==='files_binary');
 assert.equal(storage.values.get(DRAFT_STORAGE_KEY),old);
 const other=memory(),large=new DraftStorage(other);large.write('/r','first',revision,'x'.repeat(1048576));const before=other.values.get(DRAFT_STORAGE_KEY);
 assert.throws(()=>large.write('/r','second',revision,'y'.repeat(1048576)),error=>error==='files_draft_limit');assert.equal(other.values.get(DRAFT_STORAGE_KEY),before);
});
test('quota failure keeps the previous serialized cache and can be recovered explicitly',()=>{
 const storage=memory(),cache=new DraftStorage(storage);cache.write('/r','a',revision,'first');const before=storage.values.get(DRAFT_STORAGE_KEY);
 storage.setItem=()=>{throw Error('quota');};assert.throws(()=>cache.write('/r','a',revision,'second',cache.get('/r','a').token),error=>error==='files_draft_storage');assert.equal(storage.values.get(DRAFT_STORAGE_KEY),before);
 cache.clear();assert.equal(storage.values.has(DRAFT_STORAGE_KEY),false);
});

test('existing preference backup never reads or exports file recovery contents',()=>{
 const storage=memory(),cache=new DraftStorage(storage);cache.write('/r','a',revision,'private recovery text');const reads=[];
 const raw=createPreferencesBackup(key=>{reads.push(key);return storage.getItem(key);},[],true);
 assert.equal(reads.includes(DRAFT_STORAGE_KEY),false);assert.doesNotMatch(raw,/private recovery text|projectFileDrafts/);
});
