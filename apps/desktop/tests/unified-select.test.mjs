import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu. Selection semantics remain the same across all app dropdowns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
const options=[{value:'a',label:'Alpha',disabled:false},{value:'b',label:'Beta',disabled:true},{value:'c',label:'Charlie',disabled:false},{value:'d',label:'Cloud',disabled:false}];
const load=()=>import('../src/select-options.ts');
test('select navigation skips disabled choices, clamps boundaries and handles empty lists',async()=>{
 const {nextSelectIndex:next}=await load();
 assert.equal(next(options,0,'next'),2);assert.equal(next(options,2,'previous'),0);assert.equal(next(options,3,'next'),3);assert.equal(next(options,0,'previous'),0);
 assert.equal(next(options,2,'first'),0);assert.equal(next(options,0,'last'),3);assert.equal(next(options,-1,'next'),0);assert.equal(next([],0,'next'),-1);assert.equal(next([{...options[0],disabled:true}],0,'last'),-1);
});
test('select typeahead searches labels, wraps and never chooses a disabled entry',async()=>{
 const {typeaheadSelectIndex:find}=await load();assert.equal(find(options,0,'c'),2);assert.equal(find(options,2,'C'),3);assert.equal(find(options,3,'a'),0);assert.equal(find(options,0,'b'),0);assert.equal(find([],0,'a'),-1);assert.equal(find(options,0,'char'),2);
});
test('select menus fit the viewport above or below without scrolling dialog ancestors',async()=>{
 const {selectMenuGeometry:position}=await load();
 let p=position({left:20,right:220,top:20,bottom:56,width:200},800,600);assert.equal(p.left,20);assert.equal(p.top,62);assert.equal(p.bottom,undefined);assert.ok(p.maxHeight<=280);
 p=position({left:700,right:900,top:560,bottom:596,width:200},800,600);assert.ok(p.left+p.width<=788);assert.equal(p.top,undefined);assert.equal(p.bottom,46);assert.ok(p.maxHeight<=280);
 p=position({left:-20,right:80,top:20,bottom:56,width:100},120,100);assert.equal(p.left,12);assert.ok(p.width<=96);assert.ok(p.maxHeight>=0);
});
test('all existing app selects use one shared dropdown, including settings and profiles',()=>{
 for(const file of ['App','GitChanges','KeyboardShortcutSettings','ProjectConfigPreview','SessionLogExport','SessionLogSearch','TerminalPastePreview','TerminalProfiles','TerminalSettings']){
  const source=readFileSync(new URL('../src/'+file+'.tsx',import.meta.url),'utf8');assert.doesNotMatch(source,/<select(?:\s|>)/,file+' still uses a platform-specific menu');assert.match(source,/<Select(?:\s|>)/);assert.match(source,/import.*Select.*from ["']\.\/Select/);
 }
});
