import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Actual callbacks with DOM/hook doubles; native acceptance stays separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import * as policy from '../src/select-options.ts';
const source=ts.createSourceFile('Select.tsx',readFileSync(new URL('../src/Select.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Select');
const js=ts.transpileModule(fn.getText(source).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=n=>!n||typeof n!=='object'?[]:[n,...(n.props?.children??[]).flat(Infinity).flatMap(nodes)];
function fixture(extra={}){
 const cells=[],effects=[],pending=[],listeners=new Map(),changes=[],portalTargets=[],forwarded={current:null};let index=0,dirty=false,tree,props;
 const dialog={},trigger={focus(){this.focused=true;},closest:()=>dialog,contains:n=>n===trigger,getBoundingClientRect:()=>({left:20,right:220,top:20,bottom:56,width:200})};
 const menu={scrollTop:0,contains:n=>n===menu,querySelector:()=>({getBoundingClientRect:()=>({top:500,bottom:530})}),getBoundingClientRect:()=>({top:62,bottom:342})};
 const native={options:[],value:'a',selectedIndex:0,selectedOptions:[],matches:()=>!!props.disabled,dispatchEvent:event=>{changes.push({value:native.value,type:event.type,bubbles:event.bubbles});props.onChange?.({target:native});}};
 const useRef=value=>{const i=index++;return cells[i]??={current:value};};
 const useState=value=>{const i=index++;if(!(i in cells))cells[i]=value;return[cells[i],next=>{const v=typeof next==='function'?next(cells[i]):next;if(v!==cells[i]){cells[i]=v;dirty=true;}}];};
 const useEffect=(callback,deps)=>{const i=index++,old=effects[i];if(!old||!deps||deps.some((v,j)=>v!==old.deps[j])){effects[i]={deps,cleanup:old?.cleanup};pending.push(()=>{effects[i].cleanup?.();effects[i].cleanup=callback();});}};
 const dom={body:{},addEventListener:(type,callback)=>listeners.set('document:'+type,callback),removeEventListener:type=>listeners.delete('document:'+type)};
 const win={innerWidth:800,innerHeight:600,addEventListener:(type,callback)=>listeners.set('window:'+type,callback),removeEventListener:type=>listeners.delete('window:'+type)};
 const values={React:{createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})},...policy,useRef,useState,useEffect,useLayoutEffect:useEffect,useImperativeHandle:(ref,create)=>{index++;pending.push(()=>{if(ref)ref.current=create();});},useId:()=>{index++;return 'choices';},createPortal:(child,target)=>{portalTargets.push(target);return child;},document:dom,window:win};
 const render=new Function(...Object.keys(values),js+';return Select')(...Object.values(values));
 props={value:'a',ref:forwarded,'aria-label':'Choices',children:[['a','Alpha'],['b','Beta',true],['c','Charlie']].map(([value,label,disabled])=>({type:'option',props:{value,disabled,children:[label]}})),...extra};
 function refresh(next={}){Object.assign(props,next);let rounds=0;do{assert.ok(rounds++<15,'settles');dirty=false;index=0;native.options=props.children.map(n=>({value:n.props.value,label:n.props.children[0],disabled:!!n.props.disabled,parentElement:null}));native.value=props.value;native.selectedIndex=native.options.findIndex(o=>o.value===native.value);native.selectedOptions=native.options.filter(o=>o.value===native.value);tree=render(props);for(const n of nodes(tree)){if(n.props?.ref)n.props.ref.current=n.type==='select'?native:n.props.role==='combobox'?trigger:menu;}const jobs=pending.splice(0);jobs.forEach(f=>f());}while(dirty);return tree;}
 refresh();
 const button=()=>nodes(tree).find(n=>n.props?.role==='combobox');
 return{props,native,trigger,menu,changes,listeners,forwarded,portalTargets,dialog,refresh,button,choices:()=>nodes(tree).filter(n=>n.props?.role==='option'),open(){button().props.onClick();refresh();},key(key,extra={}){let prevented=false,stopped=false;button().props.onKeyDown({key,nativeEvent:{},preventDefault(){prevented=true;},stopPropagation(){stopped=true;},...extra});refresh();return{prevented,stopped};},unmount(){effects.forEach(e=>e?.cleanup?.());}};
}
test('emits one native change, preserves controlled reset and forwarded focus',()=>{const f=fixture({onChange:e=>assert.equal(e.target.value,'c')});f.open();assert.equal(f.button().props['aria-expanded'],true);assert.equal(f.choices()[1].props.disabled,true);f.choices()[2].props.onClick();f.refresh();assert.deepEqual(f.changes,[{value:'c',type:'change',bubbles:true}]);assert.equal(f.button().props.children[0].props.children[0],'Alpha');assert.equal(f.button().props['aria-expanded'],false);assert.equal(f.trigger.focused,true);assert.equal(f.forwarded.current,f.trigger);});
test('keyboard skips disabled choices and Enter cannot submit the dialog',()=>{const f=fixture();assert.deepEqual(f.key('Enter'),{prevented:true,stopped:true});f.key('ArrowDown');assert.equal(f.button().props['aria-activedescendant'],'choices-2');f.key('Enter');assert.equal(f.changes[0].value,'c');f.open();assert.deepEqual(f.key('Escape'),{prevented:true,stopped:true});assert.equal(f.changes.length,1);f.open();assert.deepEqual(f.key('Tab'),{prevented:false,stopped:false});assert.equal(f.button().props['aria-expanded'],false);});
test('disabled control and stale disabled choices cannot dispatch; IME stays native',()=>{const f=fixture({disabled:true});f.open();assert.equal(f.button().props['aria-expanded'],false);f.refresh({disabled:false});f.open();const choice=f.choices()[2];f.refresh({children:f.props.children.map(n=>({...n,props:{...n.props,disabled:true}}))});choice.props.onClick();f.refresh();assert.deepEqual(f.changes,[]);assert.deepEqual(f.key('a',{nativeEvent:{isComposing:true}}),{prevented:false,stopped:false});});
test('portal stays in current dialog, scrolls only its menu, cleans listeners',()=>{const f=fixture();f.open();assert.ok(f.portalTargets.every(target=>target===f.dialog));assert.ok(f.menu.scrollTop>0);assert.equal(f.listeners.size,3);f.listeners.get('document:pointerdown')({target:{}});f.refresh();assert.equal(f.listeners.size,0);f.open();f.unmount();assert.equal(f.listeners.size,0);});
test('closed typeahead chooses enabled labels; empty lists stay safe',()=>{const f=fixture();f.key('c');assert.equal(f.changes[0].value,'c');const g=fixture({children:[]});g.open();g.key('ArrowDown');g.key('Enter');assert.deepEqual(g.changes,[]);});
test('reselecting the current value and unmatched typeahead do not emit spurious changes',()=>{const f=fixture();f.key('z');assert.deepEqual(f.changes,[]);f.open();f.choices()[0].props.onClick();f.refresh();assert.deepEqual(f.changes,[]);assert.equal(f.button().props['aria-expanded'],false);});
