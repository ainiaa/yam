import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import {FilePreviewController,isFilePreview,textLineOffset,findText} from '../src/file-preview.ts';
const token='12345678-1234-4234-8234-123456789abc';
const reply=(args,extra={})=>({query_token:args.query_token,session_id:args.session_id??null,root:'/repo',path:args.path??'/repo/chosen.txt',read_at:1,bytes:5,kind:'text',text:'hello',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('R2B validates exact bounded native file projection and UTF8 byte counts',()=>{
 assert.ok(isFilePreview(reply({query_token:token})));
 for(const extra of [{secret:'PRIVATE'},{bytes:4},{text:'x'.repeat(1048577),bytes:1048577},{path:'/outside/file'},{path:'/repo/.git/config'},{path:'/repo/../escape'},{path:'/repo/link\nname'},{session_id:42},{read_at:-1},{query_token:'bad'}])assert.equal(isFilePreview(reply({query_token:token},extra)),false,JSON.stringify(extra).slice(0,100));
 assert.ok(isFilePreview(reply({query_token:token},{text:'中文😀',bytes:10})));
 assert.ok(isFilePreview(reply({query_token:token},{text:'',bytes:0})));
});
test('R2B line and literal find handle blank lines, unicode, bounds and wrapping',()=>{
 const text='one\n中文 😀\n\nlast';assert.equal(textLineOffset(text,1),0);assert.equal(textLineOffset(text,3),10);assert.equal(textLineOffset(text,4),11);
 for(const n of [0,-1,1.5,5,NaN,Infinity])assert.equal(textLineOffset(text,n),-1);
 assert.deepEqual(findText(text,'中文',0),{start:4,end:6});assert.deepEqual(findText(text,'one',4),{start:0,end:3});assert.equal(findText(text,'missing',0),null);assert.equal(findText(text,'',0),null);
});
test('R2B actual controller is explicit and sends session authority or native chooser without frontend root',async()=>{
 const c=new FilePreviewController(()=>token),calls=[],updates=[];c.select('scope');
 await c.load(async(name,args)=>{calls.push([name,args]);return reply(args);},v=>updates.push(v),{sessionId:'s-one',path:'/repo/a'});
 assert.deepEqual(calls,[['read_project_file_preview',{query_token:token,session_id:'s-one',path:'/repo/a'}]]);assert.equal(updates.at(-1).kind,'ready');
 await c.load(async(name,args)=>{calls.push([name,args]);return reply(args);},v=>updates.push(v));assert.deepEqual(calls.at(-1),['choose_project_file_preview',{query_token:token}]);
});
test('R2B controller suppresses late success errors and cleanup across close or scope changes',async()=>{
 for(const fail of [false,true]){const c=new FilePreviewController(()=>token),p=deferred(),calls=[],updates=[];c.select('A');const operation=c.load((name,args)=>{calls.push([name,args]);return name==='cancel_file_preview'?Promise.resolve():p.promise;},v=>updates.push(v),{sessionId:'s-one',path:'/repo/a'});c.select('B');if(fail)p.reject(Error('PRIVATE'));else p.resolve(reply(calls[0][1]));await operation;assert.equal(updates.filter(v=>v.kind==='ready'||v.kind==='unavailable').length,0);assert.equal(calls.at(-1)[0],'cancel_file_preview');}
});
test('R2B controller keeps at most one native request and one latest user choice',async()=>{
 let n=0;const c=new FilePreviewController(()=>`12345678-1234-4234-8234-${String(++n).padStart(12,'0')}`),p=deferred(),calls=[],updates=[];c.select('A');
 const invoke=(name,args)=>{calls.push([name,args]);return name==='cancel_file_preview'?Promise.resolve():calls.filter(x=>x[0]!=='cancel_file_preview').length===1?p.promise:Promise.resolve(reply(args));};
 const a=c.load(invoke,v=>updates.push(v),{sessionId:'s-one',path:'/repo/a'});c.load(invoke,v=>updates.push(v),{sessionId:'s-one',path:'/repo/b'});c.load(invoke,v=>updates.push(v),{sessionId:'s-one',path:'/repo/c'});
 assert.equal(calls.filter(x=>x[0]!=='cancel_file_preview').length,1);p.resolve(reply(calls[0][1]));await a;await new Promise(r=>setImmediate(r));assert.equal(calls.filter(x=>x[0]!=='cancel_file_preview').length,2);assert.equal(updates.at(-1).value.path,'/repo/c');
});
test('R2B mismatched token session path and arbitrary errors fail closed without leaking content',async()=>{
 for(const extra of [{query_token:'00000000-0000-0000-0000-000000000000'},{session_id:'s-other'},{path:'/repo/other'}]){const c=new FilePreviewController(()=>token),u=[];c.select('A');await c.load(async(_name,args)=>reply(args,extra),v=>u.push(v),{sessionId:'s-one',path:'/repo/a'});assert.deepEqual(u.at(-1),{kind:'unavailable',code:'file_invalid_response'});}
 for(const reason of ['file_busy','file_cancelled',Error('SECRET'),'SECRET']){const c=new FilePreviewController(()=>token),u=[];c.select('A');await c.load(async()=>{throw reason;},v=>u.push(v));assert.equal(u.at(-1).code,typeof reason==='string'&&reason.startsWith('file_')?reason:'file_unavailable');}
});
test('R2C image DTO admits only bounded static formats with pixel and base64 identity',()=>{
 for(const [ext,mime] of [['png','image/png'],['jpg','image/jpeg'],['webp','image/webp']]){
  const data=readFileSync(new URL(`fixtures/file-preview-2x3.${ext}`,import.meta.url));const {text,...base}=reply({query_token:token});const value={...base,kind:'image',mime,width:2,height:3,bytes:data.length,data_base64:data.toString('base64')};assert.ok(isFilePreview(value),mime);
  for(const extra of [{text:'mixed'},{mime:'image/svg+xml'},{mime:'text/html'},{width:0},{width:16000001},{height:NaN},{bytes:data.length+1},{data_base64:'<svg>'},{data_base64:Buffer.from('<svg>literal</svg>').toString('base64')},{bytes:5242881}])assert.equal(isFilePreview({...value,...extra}),false,JSON.stringify(extra));
 }
 const {text,...base}=reply({query_token:token});const bytes=Buffer.alloc(5242880);Buffer.from('\x89PNG\r\n\x1a\n','latin1').copy(bytes);const value={...base,kind:'image',mime:'image/png',width:4000,height:4000,bytes:bytes.length,data_base64:bytes.toString('base64')};assert.equal(isFilePreview(value),true,'exact 5 MiB DTO must validate without regex stack exhaustion');
});
