// Author: Jeff.Liu. Atomic layout and actual CSS-pixel edge geometry; not native DOM.
import {test} from 'node:test';import assert from 'node:assert/strict';import * as ops from '../src/terminal-layout.ts';import {encodeTerminalLayout,decodeTerminalLayout} from '../src/terminal-layout-persistence.ts';
const a='s-a-1',b='s-b-2',c='s-c-3';
function layout(){let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');state=ops.assignTerminalPane(state,0,a);state=ops.assignTerminalPane(state,0,b);state=ops.assignTerminalPane(state,1,c);return ops.resizeTerminalNode(state,'n-0',65);}
for(const edge of ['left','right','top','bottom'])for(const source of [a,b,c])test(`atomic ${edge} edge with ${source} preserves old ratios and adjacent/empty source`,()=>{
 const old=layout(),snapshot=JSON.stringify(old),target='p-1',next=ops.splitAndMoveTerminalTab(old,source,target,edge),leaves=ops.terminalLeaves(next.root),newLeaf=leaves[next.focused],original=leaves.find(p=>p.paneId===target);
 assert.equal(JSON.stringify(old),snapshot);assert.equal(next.revision,old.revision+1);assert.equal(next.panes.length,3);assert.equal(newLeaf.sessionId,source);assert.deepEqual(ops.terminalTabs(newLeaf),[source]);assert.equal(next.root.ratio,65);assert.deepEqual(ops.terminalMembers(next).sort(),ops.terminalMembers(old).sort());
 const split=next.root.second;assert.equal(split.axis,edge==='left'||edge==='right'?'horizontal':'vertical');assert.equal(split.ratio,50);assert.equal(split[edge==='left'||edge==='top'?'first':'second'].paneId,newLeaf.paneId);assert.equal(original.sessionId,source===c?null:c);
 const oldSource=leaves.find(p=>p.paneId==='p-0');assert.deepEqual(ops.terminalTabs(oldSource),source===a?[b]:source===b?[a]:[a,b]);assert.equal(oldSource.sessionId,source===b?a:b);
 const loaded=decodeTerminalLayout(encodeTerminalLayout(next));assert.equal(loaded.warning,null);assert.equal(encodeTerminalLayout(loaded.layout),encodeTerminalLayout(next));assert.equal(ops.terminalPaneId(loaded.layout,loaded.layout.focused),newLeaf.paneId);
});
test('same-source edge retains last empty leaf and stable unique identities',()=>{
 const old=ops.assignTerminalPane(ops.createTerminalLayout(),0,a),next=ops.splitAndMoveTerminalTab(old,a,'p-0','left');assert.deepEqual(next.panes,[a,null]);assert.equal(next.focused,0);assert.equal(next.root.second.paneId,'p-0');assert.deepEqual(ops.terminalTabs(next.root.second),[]);
});
test('16 existing members may move to new leaf but 16 leaf/depth cannot be bypassed by empty source',()=>{
 let state=ops.createTerminalLayout();for(let i=0;i<16;i++)state=ops.assignTerminalPane(state,0,`s-a-${i.toString(16)}`);const moved=ops.splitAndMoveTerminalTab(state,'s-a-0','p-0','bottom');assert.equal(ops.terminalMembers(moved).length,16);assert.equal(moved.panes.length,2);
 let deep=ops.assignTerminalPane(ops.createTerminalLayout(),0,a);for(let i=0;i<14;i++)deep=ops.splitTerminalPane(deep,'vertical');assert.equal(deep.panes.length,15);const target=ops.terminalPaneId(deep,deep.focused),last=ops.splitAndMoveTerminalTab(deep,a,target,'right');assert.equal(last.panes.length,16);
 const before=JSON.stringify(last);assert.throws(()=>ops.splitAndMoveTerminalTab(last,a,ops.terminalPaneId(last,last.focused),'left'));assert.equal(JSON.stringify(last),before);
 const invalid=layout();invalid.root.first.tabs=Array.from({length:17},(_,i)=>`s-a-${i.toString(16)}`);assert.throws(()=>ops.splitAndMoveTerminalTab(invalid,'s-a-0','p-1','left'));
});
test('invalid edge/member/target are refused without any model mutation',()=>{
 const old=layout(),snapshot=JSON.stringify(old);for(const [id,pane,edge] of [[a,'p-1','diagonal'],[a,'p-1',null],[a,'missing','top'],['missing','p-1','left'],['','p-1','right']])assert.throws(()=>ops.splitAndMoveTerminalTab(old,id,pane,edge));assert.equal(JSON.stringify(old),snapshot);assert.throws(()=>ops.splitTerminalPane(old,'horizontal',50,'invalid'));
});
test('edge geometry uses32 maximum and20percent cap, corner CSSpx tie order and strict outside refusal',()=>{
 const rect={left:100,top:200,width:400,height:200};for(const [x,y,edge] of [[132,300,'left'],[468,300,'right'],[300,232,'top'],[300,368,'bottom'],[110,210,'left'],[490,210,'right'],[130,205,'top'],[130,398,'bottom'],[300,300,null],[132.001,300,null]])assert.equal(ops.terminalPaneDropEdge(rect,x,y),edge);
 assert.equal(ops.terminalPaneDropEdge({left:0,top:0,width:100,height:100},20,50),'left');assert.equal(ops.terminalPaneDropEdge({left:0,top:0,width:100,height:100},20.001,50),null);
 for(const point of [[99,300],[501,300],[300,199],[300,401],[NaN,300],[300,Infinity]])assert.equal(ops.terminalPaneDropEdge(rect,...point),null);for(const bad of [{...rect,width:0},{...rect,height:-1},{...rect,left:NaN}])assert.equal(ops.terminalPaneDropEdge(bad,100,200),null);
});
