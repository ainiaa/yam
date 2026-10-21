import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Executes the actual component with bounded hook seams.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';
import {FilePreviewController,textLineOffset,findText} from '../src/file-preview.ts';
function fixture(){
 const raw=readFileSync(new URL('../src/FilePreview.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('FilePreview.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[],calls=[],pending=[],selected=[];let at=0,queue=[],tree,updates=0;
 const textarea={focus(){selected.push('focus');},setSelectionRange(a,b){selected.push([a,b]);},scrollTop:0};
 const dialog={addEventListener(){},removeEventListener(){}};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=initial=>{const i=at++;return slots[i]??(slots[i]={current:initial});};
 const useState=initial=>{const i=at++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{updates++;slots[i]=typeof v==='function'?v(slots[i]):v;}];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const component=new Function('React','useRef','useState','useEffect','FilePreviewController','textLineOffset','findText','getComputedStyle',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return FilePreview;')(React,useRef,useState,useEffect,FilePreviewController,textLineOffset,findText,()=>({lineHeight:'20px'}));
 const props={scope:'A',invoke:(name,args)=>{calls.push([name,args]);if(name==='cancel_file_preview')return Promise.resolve();return new Promise((resolve,reject)=>pending.push({args,resolve,reject}));}};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const refresh=(flush=true)=>{at=0;tree=component(props);for(const n of nodes(tree))if(n.props?.ref)n.props.ref.current=n.type==='textarea'?textarea:{closest:()=>dialog};if(flush){const batch=queue;queue=[];batch.forEach(fn=>fn());}};
const resolve=(text='one\n中文 😀\n\nlast')=>{const p=pending.at(-1);p.resolve({query_token:p.args.query_token,session_id:p.args.session_id??null,root:'/repo',path:p.args.path??'/repo/chosen.html',read_at:1,bytes:new TextEncoder().encode(text).length,kind:'text',text});};
 refresh();return {props,calls,pending,selected,refresh,resolve,cleanup:()=>effects.forEach(e=>e?.cleanup?.()),nodes:()=>nodes(tree),button:label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.join('')===label),control:label=>nodes(tree).find(n=>n.props?.['aria-label']===label),get text(){return JSON.stringify(tree);},get updates(){return updates;}};
}
test('R2B component reads only after explicit choice and presents inert text with source and read time',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.ok(f.button('Choose file to preview'));f.button('Choose file to preview').props.onClick();assert.equal(f.calls[0][0],'choose_project_file_preview');f.resolve('<script>literal</script>\n![x](https://invalid/image)');await new Promise(r=>setImmediate(r));f.refresh();assert.match(f.text,/Current working tree/);assert.match(f.text,/Read at/);assert.equal(f.control('File preview text').props.readOnly,true);assert.match(f.control('File preview text').props.value,/<script>/);assert.equal(f.nodes().some(n=>['iframe','a','img','script'].includes(n.type)),false);f.cleanup();
});
test('R2B actual text controls locate lines and select literal matches without per-line DOM',async()=>{
 const f=fixture();f.button('Choose file to preview').props.onClick();f.resolve();await new Promise(r=>setImmediate(r));f.refresh();f.control('Preview line number').props.onChange({target:{value:'4'}});f.refresh();f.button('Go to line').props.onClick();assert.deepEqual(f.selected.at(-1),[11,11]);f.control('Find in file').props.onChange({target:{value:'中文'}});f.refresh();f.button('Find next').props.onClick();assert.deepEqual(f.selected.at(-1),[4,6]);f.control('Preview line number').props.onChange({target:{value:'999'}});f.refresh();f.button('Go to line').props.onClick();f.refresh();assert.match(f.text,/Line is outside this file/);f.cleanup();
});
test('R2B scope changes hide content before effects; close and unmount fence pending file results',async()=>{
 const f=fixture();f.button('Choose file to preview').props.onClick();f.resolve('PRIVATE_OLD_FILE');await new Promise(r=>setImmediate(r));f.refresh();assert.match(f.text,/PRIVATE_OLD_FILE/);f.props.scope='B';f.refresh(false);assert.doesNotMatch(f.text,/PRIVATE_OLD_FILE/);f.refresh();f.button('Choose file to preview').props.onClick();f.refresh();f.button('Close file preview').props.onClick();f.resolve('LATE');await new Promise(r=>setImmediate(r));f.refresh();assert.doesNotMatch(f.text,/LATE/);f.button('Choose file to preview').props.onClick();f.cleanup();const before=f.updates;f.resolve('UNMOUNTED');await new Promise(r=>setImmediate(r));assert.equal(f.updates,before);
});
test('R2B explicit Git preview request and safe failure retry use the same native reader',async()=>{
 const f=fixture();f.props.request={id:1,target:{sessionId:'s-one',path:'/repo/a'}};f.refresh();assert.deepEqual(f.calls[0][0],'read_project_file_preview');f.pending[0].reject('file_invalid_utf8');await new Promise(r=>setImmediate(r));f.refresh();assert.match(f.text,/file_invalid_utf8/);f.button('Retry file preview').props.onClick();f.resolve('');await new Promise(r=>setImmediate(r));f.refresh();assert.match(f.text,/Empty file/);f.cleanup();
});
test('R2B CRLF and CR text use the displayed textarea offsets for line and find',async()=>{
 const f=fixture();f.button('Choose file to preview').props.onClick();f.resolve('one\r\ntwo\rthree');await new Promise(r=>setImmediate(r));f.refresh();assert.equal(f.control('File preview text').props.value,'one\ntwo\nthree');
 f.control('Preview line number').props.onChange({target:{value:'2'}});f.refresh();f.button('Go to line').props.onClick();assert.deepEqual(f.selected.at(-1),[4,4]);f.control('Find in file').props.onChange({target:{value:'two'}});f.refresh();f.button('Find next').props.onClick();assert.deepEqual(f.selected.at(-1),[4,7]);f.cleanup();
});
function imageFixture(dimensions={width:2,height:3}){
 const raw=readFileSync(new URL('../src/FilePreview.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('FilePreview.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[],created=[],revoked=[];let at=0,queue=new Map(),tree;
 const useState=initial=>{const i=at++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];};const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.set(i,()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};const urls={createObjectURL:blob=>{assert.ok(blob instanceof Blob);created.push(blob);return `blob:fixture/${created.length}`;},revokeObjectURL:url=>revoked.push(url)};
 const useRef=initial=>{const i=at++;return slots[i]??(slots[i]={current:initial});};
 const component=new Function('React','useState','useEffect','useRef','URL',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return FileImage;')(React,useState,useEffect,useRef,urls);
 const data=readFileSync(new URL('fixtures/file-preview-2x3.png',import.meta.url));const image={kind:'image',mime:'image/png',...dimensions,data_base64:data.toString('base64'),query_token:'one'};const props={image};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];const refresh=(flush=true)=>{at=0;tree=component(props);for(const n of nodes(tree))if(n.type==='img'&&n.props.ref)n.props.ref.current={getBoundingClientRect:()=>({width:n.props.style.maxWidth==='100%'?Math.min(400,props.image.width):n.props.style.width})};if(flush){const batch=queue;queue=new Map();batch.forEach(fn=>fn());}};refresh();refresh();
 return {props,created,revoked,refresh,cleanup:()=>effects.forEach(e=>e?.cleanup?.()),nodes:()=>nodes(tree),button:label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.join('')===label),get image(){return nodes(tree).find(n=>n.type==='img');},get text(){return JSON.stringify(tree);}};
}
test('R2C actual image view fits, zooms, contains decode failures and releases 50 switched URLs',()=>{
 const f=imageFixture();assert.match(f.image.props.src,/^blob:/);assert.ok(f.button('Fit image'));f.button('Zoom in').props.onClick();f.refresh();assert.ok(f.image.props.style.width>2);f.button('Zoom out').props.onClick();f.refresh();f.button('Fit image').props.onClick();f.refresh();assert.equal(f.image.props.style.maxWidth,'100%');
 for(let n=1;n<50;n++){f.props.image={...f.props.image,query_token:String(n)};f.refresh(false);assert.equal(f.image,undefined,'old source hidden before effects');f.refresh();f.refresh();}
 f.image.props.onError();f.refresh();assert.match(f.text,/Cannot decode this static image/);assert.equal(f.image,undefined);f.cleanup();assert.equal(f.created.length,50);assert.equal(f.revoked.length,50);assert.equal(new Set(f.revoked).size,50);
});
test('R2C CSP adds blob only to image sources',()=>{
 const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 for(const policy of [config.app.security.csp,config.app.security.devCsp]){assert.match(policy,/(?:^|;)\s*img-src 'self' blob:/);for(const directive of policy.split(';'))if(!directive.trim().startsWith('img-src'))assert.equal(directive.includes('blob:'),false);assert.match(policy,/frame-src 'none'/);assert.match(policy,/object-src 'none'/);}
});
test('R2C zoom starts from actual fit size',()=>{
 const f=imageFixture({width:4000,height:4000});f.button('Zoom out').props.onClick();f.refresh();assert.equal(f.image.props.style.width,320);f.button('Fit image').props.onClick();f.refresh();f.button('Zoom in').props.onClick();f.refresh();assert.equal(f.image.props.style.width,500);
 f.cleanup();
});
test('R2C late image errors cannot hide the next file',()=>{
 const f=imageFixture();const oldError=f.image.props.onError;f.props.image={...f.props.image,query_token:'next'};f.refresh();f.refresh();oldError();f.refresh();assert.ok(f.image,'late old decode error must not hide a new image');f.cleanup();
});
