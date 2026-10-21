// Author: Jeff.Liu. Pure node geometry and persistence; not native DOM layout.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resizeTerminalNode,terminalNodeMinimum,terminalResizeBounds,terminalMembers} from '../src/terminal-layout.ts';
import {loadTerminalLayout,saveTerminalLayout} from '../src/terminal-layout-persistence.ts';
const leaf=(id)=>({kind:'pane',paneId:id,sessionId:id,tabs:[id,id+'-hidden']});
const tree=()=>({kind:'split',nodeId:'root',axis:'horizontal',ratio:50,first:{kind:'split',nodeId:'inner',axis:'vertical',ratio:50,first:leaf('a'),second:leaf('b')},second:leaf('c')});
const state=()=>({mode:'custom',panes:['a','b','c'],focused:1,revision:4,root:tree()});
test('node resize changes target and ancestors only, keeps members and focus',()=>{
 const old=state(),next=resizeTerminalNode(old,'inner',70);assert.equal(next.root.first.ratio,70);assert.equal(next.root.ratio,50);assert.equal(next.root.second,old.root.second);assert.equal(next.root.first.first,old.root.first.first);assert.equal(next.root.first.second,old.root.first.second);assert.equal(next.panes,old.panes);assert.equal(next.focused,1);assert.equal(next.revision,5);assert.deepEqual(terminalMembers(next),terminalMembers(old));assert.equal(resizeTerminalNode(next,'inner',70),next);
 for(const ratio of [20,80])assert.equal(resizeTerminalNode(old,'root',ratio).root.ratio,ratio);
});
test('strict refusal never defaults malformed node or ratio to root',()=>{
 const old=state();for(const ratio of [NaN,Infinity,-Infinity,19,81,50.5,null,'50'])assert.throws(()=>resizeTerminalNode(old,'inner',ratio));for(const id of ['', 'absent','a'])assert.throws(()=>resizeTerminalNode(old,id,50));assert.equal(old.root.first.ratio,50);
});
test('ratio aware minimum preserves every leaf at nested 20 and 80 percent',()=>{
 for(const ratio of [20,50,80]){
  const root=tree();root.ratio=ratio;root.first.ratio=ratio;const min=terminalNodeMinimum(root),inner=terminalNodeMinimum(root.first),fraction=ratio/100;
  assert.ok((min.width-6)*fraction>=inner.width);assert.ok((min.width-6)*(1-fraction)>=240);
  assert.ok((inner.height-6)*fraction>=180);assert.ok((inner.height-6)*(1-fraction)>=180);assert.equal(min.height,inner.height);
 }
 const vertical={...tree(),axis:'vertical'};assert.equal(terminalNodeMinimum(vertical).height,738);
});
test('pixel bounds use content after real separator and never exchange disjoint bounds',()=>{
 const node=tree().first;assert.deepEqual(terminalResizeBounds(node,606),{lower:30,upper:70,disabled:false});assert.deepEqual(terminalResizeBounds(node,610,10),{lower:30,upper:70,disabled:false});
 const conflict=terminalResizeBounds(node,200);assert.ok(conflict.lower>conflict.upper);assert.equal(conflict.disabled,true);
 for(const size of [0,6,-1,NaN,Infinity])assert.equal(terminalResizeBounds(node,size).disabled,true);
 const wide={...node,axis:'horizontal'};assert.deepEqual(terminalResizeBounds(wide,606),{lower:40,upper:60,disabled:false});
});
test('local ratio round trip stays strict v4 and preserves tabs',()=>{
 const original=state();let index=0;function valid(node){if(node.kind==='pane'){node.paneId=`p-${index}`;node.sessionId=`s-a-${index}`;node.tabs=[node.sessionId,`s-b-${index++}`];}else{node.nodeId=node.nodeId==='root'?'n-0':'n-1';valid(node.first);valid(node.second);}}valid(original.root);original.panes=['s-a-0','s-a-1','s-a-2'];const layout=resizeTerminalNode(original,'n-1',70);let saved;assert.equal(saveTerminalLayout(layout,value=>saved=value,50),null);assert.equal(JSON.parse(saved).version,4);const loaded=loadTerminalLayout(()=>saved);assert.equal(loaded.layout.root.first.ratio,70);assert.deepEqual(terminalMembers(loaded.layout),terminalMembers(layout));
});

// R2: exact integer bounds must not lose a valid percentage to subtractive rounding.
test('R2 nested legal 22 percent remains inside pixel bounds at its computed minimum',()=>{
 let node=leaf('p-4');for(const [index,ratio] of [[3,40],[2,34],[1,28],[0,22]])node={kind:'split',nodeId:`n-${index}`,axis:'vertical',ratio,first:leaf(`p-${index}`),second:node};
 const minimum=terminalNodeMinimum(node);assert.equal(minimum.height,1256);assert.equal(terminalNodeMinimum(node.second).height,975);
 assert.deepEqual(terminalResizeBounds(node,minimum.height),{lower:20,upper:22,disabled:false});
 assert.equal(terminalResizeBounds(node,minimum.height-0.001).upper,21,'real fractional shortage must stay forbidden');
});
test('R2 exact lower and upper integer boundaries across ratios and both axes',()=>{
 for(const axis of ['horizontal','vertical'])for(let ratio=20;ratio<=80;ratio++)for(const scale of [1,7,29]){
  const minimum=axis==='horizontal'?240:180,node={kind:'split',nodeId:'n-0',axis,ratio,first:leaf('a'),second:leaf('b')};
  const content=minimum*100*scale,limit=terminalResizeBounds(node,content+6);
  assert.equal(limit.lower,20);assert.equal(limit.upper,80);
  // Synthetic integer subtree minima create every exact boundary without relaxing leaf minima.
  const side=axis==='horizontal'?'width':'height';
  const child=(desired)=>{let n=leaf('base');for(let i=0;i<desired-1;i++)n={kind:'split',nodeId:`n-${i+1}`,axis,ratio:50,first:leaf(`a-${i}`),second:n};return n;};
  const first=child(scale===29?3:1),second=child(scale===29?2:1),boundaryNode={...node,first,second};
  const firstMin=terminalNodeMinimum(first)[side],secondMin=terminalNodeMinimum(second)[side];
  const firstContent=firstMin*100/ratio,secondContent=secondMin*100/(100-ratio);
  if(Number.isInteger(firstContent)&&firstContent>=firstMin+secondMin){assert.equal(terminalResizeBounds(boundaryNode,firstContent+6).lower,ratio);assert.equal(terminalResizeBounds(boundaryNode,firstContent+6-0.001).lower,ratio+1);}
  if(Number.isInteger(secondContent)&&secondContent>=firstMin+secondMin){assert.equal(terminalResizeBounds(boundaryNode,secondContent+6).upper,ratio);assert.equal(terminalResizeBounds(boundaryNode,secondContent+6-0.001).upper,ratio-1);}
 }
});
