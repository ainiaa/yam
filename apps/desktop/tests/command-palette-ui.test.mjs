// Author: Jeff.Liu. Execute the actual palette with isolated hooks; never open an app.
import './fixtures/i18n-test-init.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {t} from '../src/i18n.ts';

const source=readFileSync(new URL('../src/TerminalSettings.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('TerminalSettings.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='CommandPalette');
const code=ts.transpileModule(declaration.getText(file).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const a={action:'switch',sessionId:'s-a',label:'修复登录',detail:'支付平台 · /work/billing · Codex · Running'};
const b={action:'switch',sessionId:'s-b',label:'修复登录',detail:'管理后台 · /work/admin · Claude · Running'};

function fixture(entries=[a,b]){
 const hooks=[],effects=[],calls=[],chosen=[];let cursor=0,tree;
 const props={query:'',entries,onQuery:value=>{props.query=value;},onChoose:entry=>chosen.push(entry),onClose:()=>calls.push('cancel')};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 function useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];}
 function useRef(initial){const i=cursor++;return hooks[i]??=({current:initial});}
 function useEffect(fn,deps){const i=cursor++,previous=hooks[i];if(!previous||deps.some((value,j)=>!Object.is(value,previous.deps[j]))){effects.push(()=>{previous?.cleanup?.();hooks[i]={deps,cleanup:fn()};});}}
 const render=new Function('React','useState','useRef','useEffect','t',code+';return CommandPalette;')(React,useState,useRef,useEffect,t);
 const nodes=node=>[node,...(node?.props?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child):[])];
 function refresh(next={}){Object.assign(props,next);cursor=0;tree=render(props);for(const node of nodes(tree))if(node.props?.ref)node.props.ref.current=node.type==='dialog'?{showModal:()=>calls.push('show'),close:()=>calls.push('restore focus'),querySelector:()=>({scrollIntoView:()=>calls.push('scroll')})}:{focus:()=>calls.push('focus')};while(effects.length)effects.shift()();}
 const find=type=>nodes(tree).find(node=>node.type===type);
 refresh();
 return{calls,chosen,refresh,nodes:()=>nodes(tree),get selected(){return nodes(tree).filter(node=>node.type==='button'&&node.props.className==='selected');},query(value){find('input').props.onChange({target:{value}});refresh();},key(key,isComposing=false){find('input').props.onKeyDown({key,nativeEvent:{isComposing},preventDefault(){}});refresh();},compose(active){find('input').props[active?'onCompositionStart':'onCompositionEnd']();},submit(){find('form').props.onSubmit({preventDefault(){}});refresh();},cancel(){find('dialog').props.onCancel({preventDefault(){}});},close(){nodes(tree).find(node=>node.type==='button'&&node.props.children.includes('Close')).props.onClick();}};
}

test('actual palette renders same-title context as text and only chooses an explicit result',()=>{
 const f=fixture();const texts=f.nodes().flatMap(node=>node.props?.children??[]);
 assert.ok(texts.includes(a.detail));assert.ok(texts.includes(b.detail));assert.deepEqual(f.chosen,[]);
 f.key('ArrowDown');f.submit();assert.equal(f.chosen[0].sessionId,'s-b');
});

test('actual palette keeps selected session identity across background reorder and status updates',()=>{
 const f=fixture();f.key('ArrowDown');f.refresh({entries:[{...b,detail:'Claude · Permission required'},a]});
 f.submit();assert.equal(f.chosen[0].sessionId,'s-b');assert.equal(f.chosen[0].detail,'Claude · Permission required');
 assert.ok(f.calls.includes('scroll'));
});

test('default highlighted result also retains its identity until the query changes',()=>{
 const f=fixture();f.refresh({entries:[b,a]});f.submit();assert.equal(f.chosen[0].sessionId,'s-a');
 const removed=fixture();removed.refresh({entries:[b]});removed.submit();assert.deepEqual(removed.chosen,[]);
});

test('removed selection cannot submit another session; keyboard or new query explicitly selects again',()=>{
 const f=fixture();f.key('ArrowDown');f.refresh({entries:[a]});f.submit();assert.deepEqual(f.chosen,[]);assert.equal(f.selected.length,0);
 f.key('ArrowDown');f.submit();assert.equal(f.chosen[0].sessionId,'s-a');
 f.refresh({entries:[a,b]});f.key('ArrowDown');f.query('支付平台');f.refresh({entries:[a]});f.submit();assert.equal(f.chosen.at(-1).sessionId,'s-a');
});

test('empty results and IME arrow/Enter never execute or move the selection',()=>{
 const empty=fixture([]);empty.key('ArrowDown');empty.key('ArrowUp');empty.submit();assert.deepEqual(empty.chosen,[]);assert.equal(empty.selected.length,0);
 const f=fixture();f.key('ArrowUp');f.compose(true);f.key('ArrowDown');f.submit();assert.deepEqual(f.chosen,[]);f.compose(false);f.submit();assert.equal(f.chosen[0].sessionId,'s-a');
 const native=fixture();native.key('ArrowDown',true);native.submit();assert.equal(native.chosen[0].sessionId,'s-a');
});

test('Escape and Close close the native dialog before dismissal to restore its original focus',()=>{
 for(const action of ['cancel','close']){const f=fixture();f.calls.length=0;f[action]();assert.deepEqual(f.calls,['restore focus','cancel']);assert.deepEqual(f.chosen,[]);}
});
