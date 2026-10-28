// Author: Jeff.Liu. Execute baseline UI without a browser or desktop process.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {RunChangesController} from '../src/run-changes.ts';
function fixture(){
 const raw=readFileSync(new URL('../src/RunChanges.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('RunChanges.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[];let at=0,queue=[],tree;const calls=[];
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=value=>{const i=at++;return slots[i]??(slots[i]={current:value});};
 const useState=value=>{const i=at++;if(!(i in slots))slots[i]=value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const component=new Function('React','useRef','useState','useEffect','RunChangesController','nativeInvoke','GitPatchView','t',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return RunChanges;')(React,useRef,useState,useEffect,RunChangesController,()=>{},()=>null,(v,args)=>v.replace(/\{\{(\w+)\}\}/g,(_,key)=>args?.[key]??''));
 const info={id:'base-one',root:'/repo',captured_at:1,files:1,skipped:0};let current=null;
 const invoke=async(name,args)=>{calls.push([name,args]);if(name==='capture_run_baseline')return current={...info,id:current?'base-two':'base-one'};if(name==='get_run_baseline_info')return current;if(name==='clear_run_baseline'){current=null;return null;}return{baseline:current,rows:[{path:'a.txt',kind:'modified'}],skipped:0,patch:args.path?{path:args.path,text:'@@ -1 +1 @@\n-before\n+after\n'}:null};};
 const props={sessionId:'s-one',root:'/repo',active:true,invoke};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const render=(flush=true)=>{at=0;tree=component(props);if(flush){const batch=queue;queue=[];batch.forEach(fn=>fn());}};
 const settle=async()=>{await new Promise(r=>setImmediate(r));render();};
 const button=label=>nodes(tree).find(n=>n.type==='button'&&(n.props['aria-label']===label||n.props.children.filter(v=>typeof v==='string').join('').trim()===label));
 render();return{props,calls,render,settle,button,text:()=>JSON.stringify(tree),cleanup:()=>effects.forEach(e=>e?.cleanup?.())};
}
test('recording is explicit and replacing a baseline uses inline confirmation without touching files',async()=>{
 const f=fixture();await f.settle();assert.deepEqual(f.calls.map(([name])=>name),['get_run_baseline_info']);
 f.button('Record baseline').props.onClick();await f.settle();f.button('Compare since baseline').props.onClick();await f.settle();
 assert.match(f.text(),/a.txt/);f.button('Compare a.txt').props.onClick();await f.settle();assert.match(f.text(),/\\n\+after/);
 const before=f.calls.filter(([name])=>name==='capture_run_baseline').length;
 f.button('Replace baseline').props.onClick();f.render();assert.equal(f.calls.filter(([name])=>name==='capture_run_baseline').length,before);
 f.button('Keep baseline').props.onClick();f.render();f.button('Replace baseline').props.onClick();f.render();f.button('Confirm new baseline').props.onClick();await f.settle();
 assert.equal(f.calls.at(-1)[1].expected_id,'base-one');assert.match(f.text(),/human and concurrent edits/);assert.match(f.text(),/Untracked files compare names only/);f.cleanup();
});
test('another selected session cannot display or confirm the previous baseline',async()=>{
 const f=fixture();await f.settle();f.button('Record baseline').props.onClick();await f.settle();f.button('Replace baseline').props.onClick();f.render();
 f.props.sessionId='different';f.render(false);assert.equal(f.button('Confirm new baseline'),undefined);assert.doesNotMatch(f.text(),/base-one/);
 f.props.active=false;f.render();f.props.sessionId=null;f.props.active=true;const before=f.calls.length;f.render();await f.settle();assert.equal(f.calls.length,before);f.cleanup();
});
test('baseline IPC commands and UI are reachable through existing project tools',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),native=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');assert.match(app,/<RunChanges\s/);
 for(const name of ['get_run_baseline_info','capture_run_baseline','compare_run_baseline','clear_run_baseline'])assert.match(native,new RegExp(`run_changes::${name}`));
});
