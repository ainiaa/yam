// Author: Jeff.Liu. Execute shared menu policy with document event boundaries.
import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {installActionMenus} from '../src/action-menus.ts';
function fixture(){
 const path=new URL('../src/action-menus.ts',import.meta.url);assert.ok(existsSync(path),'shared action menu policy exists');
 const listeners=new Map(),menus=[];const doc={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),querySelectorAll:()=>menus.filter(m=>m.open)};
 const policy=installActionMenus;
 function menu(){const m={open:false,focused:false,matches:s=>s==='details.toolbar-more',contains:n=>n===m||n?.menu===m,querySelector:()=>({focus:()=>m.focused=true}),closest:()=>m};menus.push(m);return m;}
 const stop=policy(doc);return{menu,listeners,stop,emit:(name,event)=>listeners.get(name)?.(event)};
}
test('menus dismiss outside pointer and focus; disclosure sections are untouched',()=>{const f=fixture(),a=f.menu();a.open=true;f.emit('pointerdown',{target:{}});assert.equal(a.open,false);a.open=true;f.emit('focusin',{target:{}});assert.equal(a.open,false);f.stop();assert.equal(f.listeners.size,0);});
test('opening one menu closes previous menu and inside pointer leaves it open',()=>{const f=fixture(),a=f.menu(),b=f.menu();a.open=b.open=true;f.emit('toggle',{target:b});assert.equal(a.open,false);f.emit('pointerdown',{target:{menu:b}});assert.equal(b.open,true);});
test('enabled actions close their menu, disabled actions do not, Escape restores trigger focus',()=>{const f=fixture(),a=f.menu();a.open=true;f.emit('click',{target:{closest:()=>({disabled:true,closest:()=>a})}});assert.equal(a.open,true);f.emit('click',{target:{closest:()=>({disabled:false,closest:()=>a})}});assert.equal(a.open,false);a.open=true;let handled=0;f.emit('keydown',{key:'Escape',defaultPrevented:false,preventDefault:()=>handled++,stopPropagation(){}});assert.equal(a.open,false);assert.equal(a.focused,true);assert.equal(handled,1);});

test('select triggers inside action menus stay open while choosing, then close on native selection',()=>{const f=fixture(),a=f.menu();a.open=true;f.emit('click',{target:{closest:()=>({disabled:false,getAttribute:()=>"combobox",closest:()=>a})}});assert.equal(a.open,true);f.emit('change',{target:{tagName:'SELECT',closest:()=>a}});assert.equal(a.open,false);});

test('non-menu disclosures, inside focus, non-action clicks and handled Escape retain state',()=>{const f=fixture(),a=f.menu();a.open=true;f.emit('toggle',{target:{matches:()=>false,open:true}});f.emit('focusin',{target:{menu:a}});f.emit('click',{target:{}});f.emit('change',{target:{tagName:'INPUT'}});f.emit('keydown',{key:'Tab'});f.emit('keydown',{key:'Escape',defaultPrevented:true});assert.equal(a.open,true);a.open=false;f.emit('keydown',{key:'Escape',defaultPrevented:false});f.stop();assert.equal(f.listeners.size,0);});

function navigationFixture(){
 const listeners=new Map(),doc={activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),querySelectorAll:()=>menu.open?[menu]:[]};
 const menu={open:false,contains:node=>node?.menu===menu,matches:()=>true,querySelector:()=>summary,querySelectorAll:()=>items};
 const summary={menu,tagName:'SUMMARY',parentElement:menu,focus(){doc.activeElement=this;},closest(selector){return selector==='details.toolbar-more'?menu:selector==='summary'?this:null;}};
 const button=(name,disabled=false,visible=true)=>({name,menu,tagName:'BUTTON',disabled,getClientRects:()=>visible?[{}]:[],focus(){doc.activeElement=this;},closest(selector){return selector==='details.toolbar-more'?menu:selector==='button'?this:null;}});
 const items=[button('first'),button('disabled',true),button('hidden',false,false),button('last')];doc.activeElement=summary;installActionMenus(doc);
 const key=(key,extra={})=>{let prevented=false;listeners.get('keydown')({key,target:doc.activeElement,defaultPrevented:false,preventDefault(){prevented=true;},stopPropagation(){},...extra});return prevented;};
 return {doc,menu,summary,items,key};
}
test('keyboard menu navigation opens from its summary, skips unavailable actions and wraps',()=>{
 const f=navigationFixture();assert.equal(f.key('ArrowDown'),true);assert.equal(f.menu.open,true);assert.equal(f.doc.activeElement,f.items[0]);f.key('ArrowDown');assert.equal(f.doc.activeElement,f.items[3]);f.key('ArrowDown');assert.equal(f.doc.activeElement,f.items[0]);f.key('ArrowUp');assert.equal(f.doc.activeElement,f.items[3]);f.key('Home');assert.equal(f.doc.activeElement,f.items[0]);f.key('End');assert.equal(f.doc.activeElement,f.items[3]);f.key('Escape');assert.equal(f.menu.open,false);assert.equal(f.doc.activeElement,f.summary);
});
test('arrow-up opens at the last action and composition, modifiers and form controls retain their keys',()=>{
 const f=navigationFixture();assert.equal(f.key('ArrowUp'),true);assert.equal(f.doc.activeElement,f.items[3]);assert.equal(f.key('Escape',{isComposing:true}),false);assert.equal(f.menu.open,true);assert.equal(f.key('Home',{ctrlKey:true}),false);
 const input={menu:f.menu,closest:selector=>selector==='details.toolbar-more'?f.menu:selector.includes('input')?input:null};f.doc.activeElement=input;assert.equal(f.key('ArrowDown'),false);assert.equal(f.doc.activeElement,input);
});
