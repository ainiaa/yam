// Author: Jeff.Liu. Bounded pane tabs and identity-only movement; node semantics.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/terminal-layout.ts';
import {encodeTerminalLayout,decodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
const a='s-a-1',b='s-b-2',c='s-c-3';
const tabs=(layout,index)=>ops.terminalLeaves(ops.terminalLayoutRoot(layout))[index].tabs??[layout.panes[index]].filter(Boolean);
const members=layout=>ops.terminalMembers?ops.terminalMembers(layout):layout.panes.filter(Boolean);
const move=(layout,id,target)=>ops.moveTerminalTab?ops.moveTerminalTab(layout,id,target):ops.assignTerminalPane(layout,target,id);
const hide=(layout,index,id)=>ops.removeTerminalTab?ops.removeTerminalTab(layout,index,id):ops.removeTerminalPane(layout,index);
test('B02b selecting sessions appends ordered tabs and activates only the selected one',()=>{
 let state=ops.assignTerminalPane(ops.createTerminalLayout(),0,a);state=ops.assignTerminalPane(state,0,b);
 assert.deepEqual(tabs(state,0),[a,b]);assert.deepEqual(state.panes,[b]);assert.deepEqual(members(state),[a,b]);
 state=ops.assignTerminalPane(state,0,a);assert.deepEqual(tabs(state,0),[a,b]);assert.deepEqual(state.panes,[a]);
});
test('B02b sidebar selection activates the original pane member without duplication',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');state=ops.assignTerminalPane(state,0,a);state=ops.assignTerminalPane(state,0,b);state=ops.assignTerminalPane(state,1,c);
 state=ops.assignTerminalPane(state,1,a);assert.equal(state.focused,0);assert.deepEqual(state.panes,[a,c]);assert.deepEqual(members(state),[a,b,c]);
});
test('B02b movement preserves membership order, chooses adjacent source tab, and follows focus',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');for(const id of [a,b])state=ops.assignTerminalPane(state,0,id);state=ops.assignTerminalPane(state,1,c);
 const before=JSON.stringify(state);const moved=move(state,b,1);assert.deepEqual(tabs(moved,0),[a]);assert.deepEqual(tabs(moved,1),[c,b]);assert.deepEqual(moved.panes,[a,b]);assert.equal(moved.focused,1);assert.equal(JSON.stringify(state),before);
});
test('B02b hiding an inactive tab preserves active; hiding final tab keeps empty leaf',()=>{
 let state=ops.assignTerminalPane(ops.createTerminalLayout(),0,a);state=ops.assignTerminalPane(state,0,b);
 state=hide(state,0,a);assert.deepEqual(tabs(state,0),[b]);assert.deepEqual(state.panes,[b]);
 state=hide(state,0,b);assert.deepEqual(tabs(state,0),[]);assert.deepEqual(state.panes,[null]);assert.equal(state.focused,0);
});
test('B02b presets merge every member in stable leaf order and preserve active identity',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'grid');state=ops.assignTerminalPane(state,0,a);state=ops.assignTerminalPane(state,2,b);state=ops.assignTerminalPane(state,2,c);
 state=ops.changeTerminalLayout(state,'single');assert.deepEqual(tabs(state,0),[a,b,c]);assert.deepEqual(state.panes,[c]);assert.equal(state.focused,0);
});
test('B02b v4 saves tab order, active identity and empty focused leaf',()=>{
 let state=ops.splitTerminalPane(ops.createTerminalLayout(),'horizontal');state=ops.assignTerminalPane(state,0,a);state=ops.assignTerminalPane(state,0,b);state={...state,focused:1};
 const raw=encodeTerminalLayout(state);assert.equal(JSON.parse(raw).version,4);const restored=decodeTerminalLayout(raw);assert.equal(restored.warning,null);assert.deepEqual(tabs(restored.layout,0),[a,b]);assert.deepEqual(restored.layout.panes,[b,null]);assert.equal(restored.layout.focused,1);
});
test('B02b global 16 member budget rejects append without mutating layout',()=>{
 let state=ops.createTerminalLayout();for(let i=0;i<16;i++)state=ops.assignTerminalPane(state,0,`s-a-${i.toString(16)}`);
 assert.equal(members(state).length,16);const before=JSON.stringify(state);assert.throws(()=>ops.assignTerminalPane(state,0,'s-b-ff'),/16/);assert.equal(JSON.stringify(state),before);
});

test('B02b maximum legal v4 layout fits UTF-8 budget including long identities and depth 16',()=>{
 let state=ops.createTerminalLayout();for(let i=1;i<16;i++)state=ops.splitTerminalPane(state,'horizontal');
 for(let i=0;i<16;i++)state=ops.assignTerminalPane(state,i,'s-'+'a'.repeat(30)+'-'+i.toString(16).padStart(31,'b'));
 let index=0;function ids(node){if(node.kind==='pane')return {...node,paneId:`p-${9999-index++}`};return {...node,nodeId:`n-${9999-index++}`,first:ids(node.first),second:ids(node.second)};}
 state=ops.layoutFromRoot(ids(state.root),'p-9998',0,'custom');state.focused=15;
 const raw=encodeTerminalLayout(state);assert.ok(Buffer.byteLength(raw)<=4096);const restored=decodeTerminalLayout(raw);assert.equal(restored.warning,null);assert.equal(members(restored.layout).length,16);assert.equal(restored.layout.focused,15);
});
test('B02b strict v4 rejects bad active identity, null/duplicate/17 members, extra keys and malformed shapes',()=>{
 let state=ops.assignTerminalPane(ops.createTerminalLayout(),0,a);state=ops.assignTerminalPane(state,0,b);const saved=JSON.parse(encodeTerminalLayout(state));
 for(const mutate of [v=>v.root.activeIndex=null,v=>v.root.activeIndex=2,v=>v.root.activeIndex=-1,v=>v.root.activeIndex=0.5,v=>v.root.tabs=[a,a],v=>v.root.tabs=[null],v=>v.root.tabs='bad',v=>v.root.tabs=Array.from({length:17},(_,i)=>`s-a-${i.toString(16)}`),v=>v.root.extra='SECRET',v=>v.root.sessionId=a,v=>v.focusedPane='p-9999',v=>v.extra=true]){
  const value=structuredClone(saved);mutate(value);const result=decodeTerminalLayout(JSON.stringify(value));assert.match(result.warning,/Invalid/);assert.deepEqual(result.layout,ops.createTerminalLayout());assert.equal(result.warning.includes('SECRET'),false);
 }
 const blank=JSON.parse(encodeTerminalLayout(ops.createTerminalLayout()));blank.root.activeIndex=0;assert.match(decodeTerminalLayout(JSON.stringify(blank)).warning,/Invalid/);
 const exact=encodeTerminalLayout(state);assert.equal(decodeTerminalLayout(exact+' '.repeat(4096-Buffer.byteLength(exact))).warning,null);assert.match(decodeTerminalLayout(exact+' '.repeat(4097-Buffer.byteLength(exact))).warning,/Invalid/);assert.match(decodeTerminalLayout(exact+'中'.repeat(1400)).warning,/Invalid/);
});

for(const focused of [0,1])test(`B02b R2 single preset gives merged members an active tab when empty focus ${focused} is retained or removed`,()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');state=ops.assignTerminalPane(state,focused===0?1:0,a);state={...state,focused};
 const next=ops.changeTerminalLayout(state,'single');assert.deepEqual(tabs(next,0),[a]);assert.deepEqual(next.panes,[a]);assert.equal(next.focused,0);const restored=decodeTerminalLayout(encodeTerminalLayout(next));assert.equal(restored.warning,null);assert.deepEqual(restored.layout.panes,[a]);
});
test('B02b R2 shrink merges multiple sources in order and picks first member only for empty active target',()=>{
 for(const target of ['single','horizontal']){
  let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'grid');for(const id of [a,b])state=ops.assignTerminalPane(state,2,id);state=ops.assignTerminalPane(state,3,c);state={...state,focused:0};
  const next=ops.changeTerminalLayout(state,target);assert.deepEqual(tabs(next,0),[a,b,c]);assert.equal(next.panes[0],a);assert.equal(next.focused,0);assert.equal(decodeTerminalLayout(encodeTerminalLayout(next)).warning,null);
 }
});
test('B02b R2 selected identity remains preferred while entirely empty presets remain empty',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'grid');state=ops.assignTerminalPane(state,2,a);state=ops.assignTerminalPane(state,3,b);
 const next=ops.changeTerminalLayout(state,'single');assert.deepEqual(tabs(next,0),[a,b]);assert.deepEqual(next.panes,[b]);assert.equal(decodeTerminalLayout(encodeTerminalLayout(next)).warning,null);
 for(const target of ['single','horizontal']){const blank=ops.changeTerminalLayout({...ops.changeTerminalLayout(ops.createTerminalLayout(),'grid'),focused:3},target);assert.ok(blank.panes.every(id=>id===null));assert.deepEqual(members(blank),[]);assert.equal(decodeTerminalLayout(encodeTerminalLayout(blank)).warning,null);}
});
test('B02b R2 maximum member merge preserves all sixteen and rejects a seventeenth',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'grid');for(let i=0;i<16;i++)state=ops.assignTerminalPane(state,2+i%2,`s-a-${i.toString(16)}`);state={...state,focused:0};
 const next=ops.changeTerminalLayout(state,'single');assert.equal(members(next).length,16);assert.equal(next.panes[0],tabs(next,0)[0]);assert.equal(decodeTerminalLayout(encodeTerminalLayout(next)).warning,null);assert.throws(()=>ops.assignTerminalPane(next,0,'s-b-ff'),/16/);
});

function reorder(layout,id,before=null){return ops.reorderTerminalTab?ops.reorderTerminalTab(layout,id,before):ops.moveTerminalTab(layout,id,ops.terminalSessionPane(layout,id));}
test('B02c same-pane reorder preserves active and focused identity and places before stable member',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');for(const id of [a,b,c])state=ops.assignTerminalPane(state,0,id);state={...state,focused:1};const original=JSON.stringify(state);
 const next=reorder(state,c,a);assert.deepEqual(tabs(next,0),[c,a,b]);assert.equal(next.panes[0],c);assert.equal(next.focused,1);assert.equal(JSON.stringify(state),original);
 const appended=reorder(next,a);assert.deepEqual(tabs(appended,0),[c,b,a]);assert.equal(appended.panes[0],c);assert.equal(appended.focused,1);assert.equal(decodeTerminalLayout(encodeTerminalLayout(appended)).warning,null);
});
test('B02c self and same-order drops are no-op while invalid stable before member is rejected',()=>{
 let state=ops.createTerminalLayout();for(const id of [a,b,c])state=ops.assignTerminalPane(state,0,id);
 assert.equal(reorder(state,a,a),state);assert.equal(reorder(state,b,c),state);assert.equal(reorder(state,c),state);assert.throws(()=>reorder(state,a,'s-ff-ff'),/Invalid/);
});
test('B02c cross-pane placement inserts before stable target, preserves source neighbor and member budget',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');for(const id of [a,b])state=ops.assignTerminalPane(state,0,id);state=ops.assignTerminalPane(state,1,c);
 const next=ops.moveTerminalTab(state,b,1,c);assert.deepEqual(tabs(next,0),[a]);assert.deepEqual(tabs(next,1),[b,c]);assert.equal(next.focused,1);assert.deepEqual(next.panes,[a,b]);assert.equal(members(next).length,3);
 assert.throws(()=>ops.moveTerminalTab(state,b,1,a),/Invalid/);
});
