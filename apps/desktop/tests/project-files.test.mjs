// Author: Jeff.Liu.
import test from 'node:test';import assert from 'node:assert/strict';
import {ProjectFilesController} from '../src/project-files.ts';
const revision='a'.repeat(64),reply=(text='old')=>({text,revision});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('browse and edit existing local text, explicit save uses original revision',async()=>{
 const c=new ProjectFilesController(),calls=[];c.select('s-one','/repo');
 const invoke=async(name,args)=>{calls.push([name,args]);return name==='list_project_files'?[{name:'src',directory:true},{name:'a',directory:false}]:reply(name==='save_project_text'?args.text:'old');};
 await c.browse(invoke,'');assert.equal(c.entries[0].name,'src');await c.open(invoke,'a');c.edit('中文\n');
 assert.equal(c.document.draft,'中文\n');assert.equal(calls.length,2);await c.save(invoke);
 assert.deepEqual(calls[2],['save_project_text',{session_id:'s-one',path:'a',revision,text:'中文\n'}]);assert.equal(c.document.text,'中文\n');assert.equal(c.document.saving,false);
});
test('conflicts keep drafts and file navigation and session switching retain unsaved changes',async()=>{
 const c=new ProjectFilesController();c.select('s-one','/repo');await c.open(async()=>reply(),'a');c.edit('mine');
 await c.save(async()=>{throw 'file_changed';});assert.equal(c.document.draft,'mine');assert.equal(c.document.text,'old');assert.equal(c.document.error,'file_changed');
 await c.open(async()=>reply('other'),'b');await c.open(async()=>{throw Error('must retain draft');},'a');assert.equal(c.document.draft,'mine');
 c.select('s-two','/other');assert.equal(c.document,undefined);c.select('s-one','/repo');await c.open(async()=>{throw Error();},'a');assert.equal(c.document.draft,'mine');
});
test('stale directory and file reads cannot replace a newer selection or closed scope',async()=>{
 const c=new ProjectFilesController();c.select('s-one','/repo');const a=deferred(),b=deferred();
 const old=c.browse(()=>a.promise,'');const fresh=c.browse(()=>b.promise,'src');b.resolve([{name:'fresh',directory:false}]);await fresh;a.resolve([{name:'old',directory:false}]);await old;assert.equal(c.entries[0].name,'fresh');
 const x=deferred(),y=deferred();const first=c.open(()=>x.promise,'a'),second=c.open(()=>y.promise,'b');y.resolve(reply('B'));await second;x.resolve(reply('A'));await first;assert.equal(c.document.text,'B');
 const late=deferred(),pending=c.open(()=>late.promise,'c');c.cancel();late.resolve(reply('late'));await pending;assert.equal(c.document,undefined);
});
test('invalid responses, binary and oversized drafts cannot be saved',async()=>{
 const c=new ProjectFilesController();c.select('s-one','/repo');await c.browse(async()=>[{name:'../escape',directory:false}],'');assert.equal(c.error,'files_invalid_response');
 await c.open(async()=>({text:'bad',revision:'wrong'}),'a');assert.equal(c.document,undefined);assert.equal(c.error,'files_invalid_response');
 await c.open(async()=>reply(''),'a');let called=false;const invoke=async()=>{called=true;return reply();};
 c.edit('x\0y');await c.save(invoke);assert.equal(called,false);assert.equal(c.document.error,'files_binary');
 c.edit('中'.repeat(400000));await c.save(invoke);assert.equal(called,false);assert.equal(c.document.error,'file_too_large');
 c.edit('ok');await c.save(invoke);assert.equal(called,true);
});
test('late saves stay bound to the original file and duplicate saves and edits are blocked in flight',async()=>{
 const c=new ProjectFilesController();c.select('s-one','/repo');await c.open(async()=>reply(),'a');c.edit('mine');const d=deferred();let calls=0;
 const saving=c.save(()=>{calls++;return d.promise;});c.edit('late edit');await c.save(()=>{calls++;return Promise.resolve(reply());});assert.equal(calls,1);
 await c.open(async()=>reply('B'),'b');d.resolve(reply('mine'));await saving;assert.equal(c.document.text,'B');await c.open(async()=>reply('mine'),'a');assert.equal(c.document.draft,'mine');
});
test('CRLF editing preserves the original line ending style and empty files are valid',async()=>{
 const c=new ProjectFilesController();c.select('s-one','/repo');await c.open(async()=>reply('one\r\ntwo\r\n'),'a');c.edit('one\nchanged\n');let text;
 await c.save(async(_name,args)=>{text=args.text;return reply(args.text);});assert.equal(text,'one\r\nchanged\r\n');assert.equal(c.document.text,text);
});

test('local drafts recover only after a fresh native read and stale recovery revisions cannot overwrite disk',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const first=new ProjectFilesController(storage);first.select('first','/repo');await first.open(async()=>reply(),'a');first.edit('mine');
 const second=new ProjectFilesController(storage);second.select('resumed','/repo');let reads=0;await second.open(async()=>{reads++;return reply();},'a');assert.equal(reads,1);assert.equal(second.document.draft,'mine');assert.equal(second.document.recovered,true);
 const stale=new ProjectFilesController(storage);stale.select('third','/repo');await stale.open(async()=>({text:'outside edit',revision:'b'.repeat(64)}),'a');
 assert.equal(stale.document.draft,'mine');assert.equal(stale.document.error,'file_changed');let saved=false;await stale.save(async()=>{saved=true;return reply('mine');});assert.equal(saved,false);
});
test('tabs share a project buffer across sessions and closing a dirty tab keeps its recovery copy',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const c=new ProjectFilesController(storage);c.select('one','/repo');await c.open(async()=>reply(),'a');c.edit('mine');await c.open(async()=>reply('B'),'b');assert.equal(c.tabs.length,2);
 c.select('two','/repo');await c.open(async()=>{throw Error('shared draft must survive');},'a');assert.equal(c.document.draft,'mine');assert.equal(c.close('a'),true);assert.equal(c.tabs.some(t=>t.path==='a'),false);assert.ok(c.recoverable.some(t=>t.path==='a'));
 await c.open(async()=>reply(),'a');assert.equal(c.document.draft,'mine');
});
test('external edits and failed discard retain the draft, while clean external changes can refresh safely',async()=>{
 const c=new ProjectFilesController();c.select('one','/repo');await c.open(async()=>reply(),'a');c.edit('mine');
 await c.checkDisk(async()=>({text:'outside',revision:'b'.repeat(64)}));assert.equal(c.document.draft,'mine');assert.equal(c.document.error,'file_changed');assert.equal(c.document.conflict,true);
 await c.discard(async()=>{throw 'file_unavailable';});assert.equal(c.document.draft,'mine');
 await c.discard(async()=>({text:'outside',revision:'b'.repeat(64)}));assert.equal(c.document.draft,'outside');assert.equal(c.document.conflict,false);
 await c.checkDisk(async()=>({text:'fresh',revision:'c'.repeat(64)}));assert.equal(c.document.draft,'fresh');
});

test('an unreadable recovered file can expose the local draft for copying but cannot save',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const first=new ProjectFilesController(storage);first.select('first','/repo');await first.open(async()=>reply(),'a');first.edit('keep this');
 const restored=new ProjectFilesController(storage);restored.select('next','/repo');await restored.open(async()=>{throw 'file_unavailable';},'a');assert.equal(restored.document?.draft,'keep this');assert.equal(restored.document.conflict,true);
 let called=false;await restored.save(async()=>{called=true;return reply();});assert.equal(called,false);
});

test('an empty recovered draft remains pending through an unreadable file and later revalidation',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const first=new ProjectFilesController(storage);first.select('first','/repo');await first.open(async()=>reply(),'a');first.edit('');
 const restored=new ProjectFilesController(storage);restored.select('next','/repo');await restored.open(async()=>{throw 'file_unavailable';},'a');
 assert.equal(restored.tabs[0].dirty,true);assert.equal(restored.close('a'),true);assert.equal(restored.recoverable[0]?.draft,'');
 await restored.open(async()=>{throw 'file_unavailable';},'a');await restored.checkDisk(async()=>reply());assert.equal(restored.document.draft,'');assert.equal(restored.document.text,'old');assert.equal(restored.document.conflict,false);
 let saved;await restored.save(async(_name,args)=>{saved=args.text;return reply(args.text);});assert.equal(saved,'');
});

test('closing a file during a pending reload cannot resurrect its tab',async()=>{
 const c=new ProjectFilesController();c.select('one','/repo');await c.open(async()=>reply(),'a');const pending=deferred();
 const opening=c.open(()=>pending.promise,'a');assert.equal(c.close('a'),true);pending.resolve(reply('late'));await opening;assert.equal(c.tabs.length,0);assert.equal(c.document,undefined);
});

test('a clean editor cannot remove another editors newer recovery copy on focus or save',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const a=new ProjectFilesController(storage),b=new ProjectFilesController(storage);for(const c of [a,b]){c.select('same','/repo');await c.open(async()=>reply(),'a');}
 a.edit('window A pending');await b.checkDisk(async()=>reply());assert.equal(b.recoverable[0]?.draft,'window A pending');
 b.edit('window B pending');assert.equal(a.recoverable[0]?.draft,'window A pending');assert.equal(b.document.draft,'window B pending');assert.equal(b.draftError,'files_draft_changed');
 await b.save(async(_name,args)=>reply(args.text));assert.equal(a.recoverable[0]?.draft,'window A pending');
});
test('discarding an older observed draft preserves a newer recovery revision',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const a=new ProjectFilesController(storage);a.select('same','/repo');await a.open(async()=>reply(),'a');a.edit('older');
 const b=new ProjectFilesController(storage);b.select('same','/repo');await b.open(async()=>reply(),'a');b.edit('newer');
 await a.discard(async()=>reply());assert.equal(a.document.draft,'old');assert.equal(a.recoverable[0]?.draft,'newer');
});

test('same-directory refresh retains visible entries while awaiting disk',async()=>{
 const {ProjectFilesController}=await import('../src/project-files.ts');const c=new ProjectFilesController();c.select('s-one','/repo');await c.browse(async()=>[{name:'a.txt',directory:false}],'');let release;const pending=c.browse(()=>new Promise(r=>release=r),'');assert.equal(c.entries[0].name,'a.txt');release([{name:'b.txt',directory:false}]);await pending;assert.equal(c.entries[0].name,'b.txt');
});
