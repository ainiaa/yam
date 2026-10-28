// Author: Jeff.Liu. Spatial DOM geometry only; no array navigation or tree-coordinate fallback.
import {test} from 'node:test';import assert from 'node:assert/strict';import * as ops from '../src/terminal-layout.ts';
const state={mode:'custom',panes:['a','b',null,'d','e'],focused:0,revision:2};
const rect=(left,top,width=100,height=100)=>({left,top,width,height});
const geometry=()=>new Map([['p-0',rect(0,100)],['p-1',rect(100,0)],['p-2',rect(100,100)],['p-3',rect(0,0)],['p-4',rect(0,200)]]);
// Baseline has no directional action, so missing implementation retains focus.
const move=(s,d,g,z=null)=>ops.terminalDirectionPane?.(s,d,g,z)??null;
test('spatial direction ignores array neighbor and can target empty leaf',()=>{assert.equal(move(state,'right',geometry()),2);assert.equal(move(state,'up',geometry()),3);assert.equal(move(state,'down',geometry()),4);assert.equal(move(state,'left',geometry()),null);assert.equal(state.focused,0);});
test('overlap outranks closer diagonal then edge gap, orthogonal distance and stable leaf order',()=>{
 const s={...state,panes:['a','b','c','d','e']};const g=geometry();g.set('p-1',rect(105,101));g.set('p-2',rect(105,101));g.set('p-3',rect(101,-5));g.set('p-4',rect(105,140));assert.equal(move(s,'right',g),1);
 g.set('p-1',rect(150,100));assert.equal(move(s,'right',g),2);g.set('p-2',rect(105,150));assert.equal(move(s,'right',g),4);
});
test('complete valid geometry required, no wrapping or mixing fallback coordinates',()=>{
 for(const bad of [null,rect(100,100,0),rect(NaN,100),rect(100,Infinity),rect(100,100,-1)]){const g=geometry();if(bad)g.set('p-1',bad);else g.delete('p-1');assert.equal(move(state,'right',g),null);}
 assert.equal(move({...state,focused:2},'right',geometry()),null);assert.equal(move(state,'right',geometry(),'p-0'),null);assert.equal(move(state,'right',new Map()),null);assert.equal(move({...state,focused:99},'up',geometry()),null);assert.equal(move(state,'bad',geometry()),null);
});
