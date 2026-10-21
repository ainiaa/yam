import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Actual JSX pointer callbacks with deterministic DOM doubles; not React DOM/native.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';import * as ops from '../src/terminal-layout.ts';
const source=ts.createSourceFile('TerminalLayout.tsx',readFileSync(new URL('../src/TerminalLayout.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const body=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TerminalLayout').getText(source).replace(/^export /,'');
const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=(tree,predicate)=>[tree,...(tree?.props?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child,predicate):[])].filter(predicate);
const a='s-a-1',b='s-b-2',c='s-c-3';
function fixture(){
 let layout=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');layout=ops.assignTerminalPane(layout,0,a);layout=ops.assignTerminalPane(layout,0,b);layout=ops.assignTerminalPane(layout,1,c);
 const calls=[],listeners=new Map(),tokens=[],captures=[],refs=[],states=[];let hit=null,stateIndex=0,refIndex=0;const cleanups=[];
 const ownerDocument={elementFromPoint:()=>hit,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const root={contains:node=>!!node?.inside,querySelectorAll:()=>[]};
 const pane=(id,hidden=false)=>({inside:true,hidden,dataset:{paneId:id},closest:selector=>selector==='[data-pane-id]'?null:selector.includes('[hidden]')&&hidden?{}:null});
 const target=(paneId,tabId=null,{hidden=false,inside=true,blocked=false,bodyRect=null}={})=>{const leaf=pane(paneId,hidden),body=bodyRect?{getBoundingClientRect:()=>bodyRect}:null,tab=tabId?{dataset:{tabSessionId:tabId}}:null;leaf.closest=selector=>selector==='[data-pane-id]'?leaf:selector.includes('[hidden]')&&hidden?{}:null;return {inside,closest:selector=>selector==='[data-pane-id]'?leaf:selector==='[data-tab-drop-body]'?body:selector==='[data-tab-session-id]'?tab:selector.includes('[data-tab-drop-block]')&&blocked?{}:selector.includes('[hidden]')&&hidden?{}:null};};
 const props={layout,ownerVersion:1,zoomRevision:0,zoomedPaneId:null,labels:['B','C'],splitPercent:50,swapDisabled:false,onHost(){},onMode(){},onFocus:(...args)=>calls.push(['focus',...args]),onClose(){},onSplitChange(){},onSplitPreview(){},onSwap(){},onCancelFit(){},onTab:(...args)=>calls.push(['select',...args]),onMoveTab:(...args)=>calls.push(['menuMove',...args]),onReorderTab:(...args)=>calls.push(['order',...args]),onTabDragStart:(id,paneId)=>{const token={id,paneId};tokens.push(token);return token;},onTabDragCancel:token=>calls.push(['cancel',token]),onTabDrop:(...args)=>calls.push(['drop',...args])};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useState=initial=>{const i=stateIndex++;if(!(i in states))states[i]=initial;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];};const useRef=initial=>{const i=refIndex++;if(!(i in refs))refs[i]={current:initial};return refs[i];};
 const useEffect=effect=>{const cleanup=effect();if(cleanup)cleanups.push(cleanup);};
 const render=()=>{stateIndex=refIndex=0;const tree=new Function('React','useRef','useState','useEffect','document',...Object.keys(ops),'const Select="select";'+js+';return TerminalLayout')(React,useRef,useState,useEffect,ownerDocument,...Object.values(ops))(props);if(typeof tree.props.ref==="function")tree.props.ref(root);else if(tree.props.ref)tree.props.ref.current=root;return tree;};
 let tree=render();const title=id=>nodes(tree,n=>n.props?.role==='tab'&&(n.props['data-tab-session-id']===id||(id===a?n.props['aria-selected']===false:id===b?n.props['aria-selected']===true&&n.props.children[0]==='B':n.props.children[0]==='C')))[0];
 const host={ownerDocument,setPointerCapture:id=>captures.push(['set',id]),releasePointerCapture:id=>captures.push(['release',id])};
 const event=(change={})=>({pointerId:17,isPrimary:true,button:0,clientX:10,clientY:10,currentTarget:host,preventDefault(){},stopPropagation(){},...change});
 const invoke=(node,name,change={})=>node.props[name]?.(event(change));
 return {props,calls,listeners,captures,tokens,event,title,invoke,setHit:(...args)=>hit=target(...args),clearHit:()=>hit=null,rerender(change={}){Object.assign(props,change);tree=render();return tree;},tree:()=>tree,unmount(){cleanups.forEach(fn=>fn());}};
}
test('B02c actual pointer drag uses stable hit target, never activates hidden source, and suppresses only drag click',()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.setHit('p-1',c);f.invoke(title,'onPointerMove',{clientX:15});assert.deepEqual(f.calls,[],'candidate below6px is not a selection or model action');
 f.invoke(title,'onPointerMove',{clientX:16});assert.equal(f.calls.some(c=>c[0]==='select'||c[0]==='focus'),false);f.invoke(title,'onPointerUp',{clientX:16});
 assert.equal(f.calls.filter(c=>c[0]==='drop').length,1);assert.deepEqual(f.calls.find(c=>c[0]==='drop').slice(2),['p-1',c]);
 f.invoke(title,'onClick',{detail:1});assert.equal(f.calls.some(c=>c[0]==='select'),false);f.invoke(title,'onPointerDown');f.invoke(title,'onPointerUp');f.invoke(title,'onClick',{detail:1});assert.equal(f.calls.filter(c=>c[0]==='select').length,1);
});
test('B02c actual movement below threshold stays normal click and keyboard click survives suppressed pointer click',()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.invoke(title,'onPointerMove',{clientX:15.9});f.invoke(title,'onPointerUp',{clientX:15.9});f.invoke(title,'onClick',{detail:1});assert.equal(f.calls.filter(c=>c[0]==='select').length,1);assert.equal(f.calls.some(c=>c[0]==='drop'),false);
 const g=fixture(),other=g.title(a);g.invoke(other,'onPointerDown');g.setHit('p-1');g.invoke(other,'onPointerMove',{clientX:20});g.invoke(other,'onPointerCancel');g.invoke(other,'onClick',{detail:0});assert.equal(g.calls.filter(c=>c[0]==='select').length,1);assert.equal(g.calls.some(c=>c[0]==='drop'),false);
});
for(const kind of ['escape','cancel','lost','outside','unmount'])test(`B02c actual ${kind} cancels captured tab drag without a drop or generated click selection`,()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.setHit('p-1');f.invoke(title,'onPointerMove',{clientX:20});
 if(kind==='escape')f.listeners.get('keydown')?.({key:'Escape',preventDefault(){},stopPropagation(){}});if(kind==='cancel')f.invoke(title,'onPointerCancel');if(kind==='lost')f.invoke(title,'onLostPointerCapture');if(kind==='outside'){f.clearHit();f.invoke(title,'onPointerUp',{clientX:20});}if(kind==='unmount')f.unmount();
 if(kind!=='unmount')f.invoke(title,'onClick',{detail:1});assert.equal(f.calls.some(c=>c[0]==='drop'||c[0]==='select'||c[0]==='focus'),false);assert.equal(f.listeners.size,0);assert.ok(f.captures.some(c=>c[0]==='release'));
});
for(const kind of ['revision','owner','zoom'])test(`B02c actual ${kind} changes invalidate old callbacks and captured pointer drop`,()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.setHit('p-1');f.invoke(title,'onPointerMove',{clientX:20});
 f.rerender(kind==='revision'?{layout:{...f.props.layout,revision:1}}:kind==='owner'?{ownerVersion:2}:{zoomedPaneId:'p-0',zoomRevision:1});f.invoke(title,'onPointerUp',{clientX:20});assert.equal(f.calls.some(c=>c[0]==='drop'),false);assert.equal(f.listeners.size,0);
});
test('B02c no internal primary pointer means external drops and wrong pointers cannot commit or cancel a valid gesture',()=>{
 const f=fixture(),title=f.title(a);f.setHit('p-1');f.invoke(title,'onPointerMove',{clientX:20});f.invoke(title,'onPointerUp',{clientX:20});f.invoke(title,'onDrop',{dataTransfer:{getData:()=>a}});assert.equal(f.tokens.length,0);
 for(const change of [{button:2},{isPrimary:false},{clientX:NaN}])f.invoke(title,'onPointerDown',change);assert.equal(f.tokens.length,0);
 f.invoke(title,'onPointerDown');f.invoke(title,'onPointerMove',{clientX:20});f.invoke(title,'onPointerCancel',{pointerId:99});f.invoke(title,'onPointerUp',{pointerId:99,clientX:20});assert.equal(f.calls.some(c=>c[0]==='drop'),false);f.invoke(title,'onPointerUp',{clientX:20});assert.equal(f.calls.filter(c=>c[0]==='drop').length,1);
});

for(const [edge,x,y] of [['left',110,300],['right',490,300],['top',300,210],['bottom',300,390]])test(`B02d actual pointer ${edge} edge previews marker and extends same drop descriptor once`,()=>{
 const f=fixture(),title=f.title(a),bodyRect={left:100,top:200,width:400,height:200};f.invoke(title,'onPointerDown');f.setHit('p-1',null,{bodyRect});f.invoke(title,'onPointerMove',{clientX:x,clientY:y});const tree=f.rerender();const pane=nodes(tree,n=>n.props?.['data-pane-id']==='p-1')[0];assert.equal(pane.props['data-tab-drop-edge'],edge);assert.equal(f.calls.some(c=>c[0]==='drop'),false);f.invoke(f.title(a),'onPointerUp',{clientX:x,clientY:y});f.invoke(f.title(a),'onPointerUp',{clientX:x,clientY:y});assert.deepEqual(f.calls.find(c=>c[0]==='drop').slice(2),['p-1',null,edge]);assert.equal(f.calls.filter(c=>c[0]==='drop').length,1);
});
test('B02d actual body interior remains ordinary move and outside body refuses edge drop',()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.setHit('p-1',null,{bodyRect:{left:100,top:200,width:400,height:200}});f.invoke(title,'onPointerMove',{clientX:300,clientY:300});f.invoke(title,'onPointerUp',{clientX:300,clientY:300});assert.deepEqual(f.calls.find(c=>c[0]==='drop').slice(2),['p-1',null]);
 const g=fixture(),other=g.title(a);g.invoke(other,'onPointerDown');g.setHit('p-1',null,{bodyRect:{left:100,top:200,width:400,height:200}});g.invoke(other,'onPointerMove',{clientX:90,clientY:300});g.invoke(other,'onPointerUp',{clientX:90,clientY:300});assert.equal(g.calls.some(c=>c[0]==='drop'),false);
});
for(const cancel of ['Escape','pointercancel','lostcapture','zoom','owner','revision'])test(`B02d ${cancel} cancels edge preview without changing B02c click cleanup`,()=>{
 const f=fixture(),title=f.title(a);f.invoke(title,'onPointerDown');f.setHit('p-1',null,{bodyRect:{left:100,top:200,width:400,height:200}});f.invoke(title,'onPointerMove',{clientX:110,clientY:300});
 if(cancel==='Escape')f.listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});else if(cancel==='pointercancel')f.invoke(title,'onPointerCancel');else if(cancel==='lostcapture')f.invoke(title,'onLostPointerCapture');else f.rerender(cancel==='zoom'?{zoomRevision:1}:cancel==='owner'?{ownerVersion:2}:{layout:{...f.props.layout,revision:f.props.layout.revision+1}});
 f.invoke(title,'onPointerUp',{clientX:110,clientY:300});f.invoke(f.title(a),'onClick',{detail:1});assert.equal(f.calls.some(c=>c[0]==='drop'||c[0]==='select'),false);assert.equal(f.listeners.size,0);
});
