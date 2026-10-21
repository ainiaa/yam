import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {resolveAppShortcut,defaultAppShortcuts,loadAppShortcuts,validateAppShortcuts,saveAppShortcuts} from '../src/app-shortcuts.ts';
// Author: Jeff.Liu. Local split behavior, stable identity and bounded persistence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/terminal-layout.ts';
import {decodeTerminalLayout,encodeTerminalLayout,saveTerminalLayout} from '../src/terminal-layout-persistence.ts';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
const a='s-a-1',b='s-b-2';
function split(layout,axis){return ops.splitTerminalPane?ops.splitTerminalPane(layout,axis):ops.changeTerminalLayout(layout,axis==='horizontal'?'horizontal':'vertical');}
test('B02a focused split keeps sibling and target session and focuses a new empty leaf',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'horizontal');
 state=ops.assignTerminalPane(state,0,a);state=ops.assignTerminalPane(state,1,b);state={...state,focused:1};
 state=split(state,'vertical');
 assert.deepEqual(state.panes,[a,b,null]);assert.equal(state.focused,2);
 assert.equal(state.root.first.sessionId,a);assert.equal(state.root.second.axis,'vertical');
});
test('B02a empty focused pane identity survives v3 round trip',()=>{
 let state=ops.changeTerminalLayout(ops.createTerminalLayout(),'grid');state={...state,focused:3};
 const raw=encodeTerminalLayout(state);assert.equal(JSON.parse(raw).version,4);
 const restored=decodeTerminalLayout(raw);assert.equal(restored.warning,null);assert.equal(restored.layout.focused,3);
});
test('B02a v3 per-node ratios round trip without a global ratio overwriting them',()=>{
 let state=split(ops.createTerminalLayout(),'horizontal');state.root.ratio=63;
 const restored=decodeTerminalLayout(encodeTerminalLayout(state));assert.equal(restored.layout.root.ratio,63);
});
test('B02a compatible two-pane preset retains the committed ratio before another local split',()=>{
 const original=split(ops.createTerminalLayout(),'horizontal');original.root.ratio=63;
 const preset=ops.changeTerminalLayout(original,'vertical',63);assert.equal(preset.root.ratio,63);
 const nested=ops.splitTerminalPane({...preset,focused:1},'horizontal');assert.equal(nested.root.ratio,63);
});
test('B02a 16 leaves with 64-character session IDs fit the strict byte budget and reject a seventeenth',()=>{
 let state=ops.createTerminalLayout();for(let i=1;i<16;i++)state=split(state,i%2?'horizontal':'vertical');
 for(let i=0;i<16;i++)state=ops.assignTerminalPane(state,i,'s-'+'a'.repeat(30)+'-'+i.toString(16).padStart(31,'b'));
 const raw=encodeTerminalLayout(state);assert.ok(Buffer.byteLength(raw)<=4096);assert.equal(decodeTerminalLayout(raw).warning,null);
 const before=JSON.stringify(state);assert.throws(()=>split(state,'vertical'),/at most 16/);assert.equal(JSON.stringify(state),before);
});
test('B02a v1/v2 migration preserves every preset ordering and selected identity',()=>{
 for(const version of [1,2])for(const [mode,panes]of [['single',[a]],['horizontal',[a,null]],['vertical',[null,b]],['grid',[a,null,b,null]]]){
  const value={version,mode,panes,selected:mode==='single'?a:null,...(version===2?{splitPercent:63}:{})};
  const restored=decodeTerminalLayout(JSON.stringify(value));assert.equal(restored.warning,null);assert.deepEqual(restored.layout.panes,panes);
  assert.equal(restored.layout.focused,panes.indexOf(value.selected));assert.equal(restored.layout.mode,mode);
  if(mode==='horizontal'||mode==='vertical')assert.equal(restored.layout.root.ratio,version===1?50:63);
  if(mode==='grid'){assert.equal(restored.layout.root.axis,'vertical');assert.equal(restored.layout.root.first.axis,'horizontal');assert.equal(restored.layout.root.ratio,50);}
 }
});
test('B02a strict v3 rejects duplicate identities, unknown fields, invalid axes/ratios/focus and malicious nodes',()=>{
 const state=split(ops.createTerminalLayout(),'horizontal'),valid={version:3,root:ops.terminalLayoutRoot(state),focusedPane:ops.terminalPaneId(state,state.focused)};
 const change=mutate=>{const value=structuredClone(valid);mutate(value);return value;};
 const values=[change(v=>v.extra='SECRET'),change(v=>v.focusedPane='p-9999'),change(v=>v.root.extra='SECRET'),change(v=>v.root.axis='diagonal'),change(v=>v.root.ratio=NaN),change(v=>v.root.ratio=81),change(v=>v.root.ratio=20.5),change(v=>v.root.first.extra='SECRET'),change(v=>v.root.second.paneId=v.root.first.paneId),change(v=>{v.root.first.sessionId=a;v.root.second.sessionId=a;}),change(v=>v.root.first.sessionId='../SECRET'),change(v=>v.root.first.paneId='n-1'),change(v=>v.root.nodeId='p-3'),change(v=>v.root.second=null),change(v=>v.root.nodeId='n-12345'),change(v=>v.root.kind='plugin')];
 for(const value of values){const result=decodeTerminalLayout(JSON.stringify(value));assert.deepEqual(result.layout,ops.createTerminalLayout());assert.match(result.warning,/Invalid terminal layout/);assert.equal(result.warning.includes('SECRET'),false);}
 for(const axis of ['diagonal',null])assert.throws(()=>ops.splitTerminalPane(state,axis),/Invalid terminal split/);
 assert.throws(()=>ops.splitTerminalPane({...state,focused:-1},'horizontal'),/Invalid terminal pane/);
});
test('B02a v3 depth, leaf and UTF-8 budgets reject before any storage write',()=>{
 let root={kind:'pane',paneId:'p-0',sessionId:null};
 for(let i=1;i<=16;i++)root={kind:'split',nodeId:`n-${i}`,axis:'horizontal',ratio:50,first:root,second:{kind:'pane',paneId:`p-${i}`,sessionId:null}};
 const tooDeep={version:3,root,focusedPane:'p-0'};assert.match(decodeTerminalLayout(JSON.stringify(tooDeep)).warning,/Invalid/);
 let state=split(ops.createTerminalLayout(),'horizontal');state.root.first.sessionId=a;state.root.second.sessionId=a;
 let writes=0;assert.equal(typeof (saveTerminalLayout(state,()=>writes++)),'string');assert.equal(writes,0);
 const valid=encodeTerminalLayout(split(ops.createTerminalLayout(),'vertical'));assert.equal(decodeTerminalLayout(valid+' '.repeat(4096-Buffer.byteLength(valid))).warning,null);
 assert.match(decodeTerminalLayout(valid+' '.repeat(4097-Buffer.byteLength(valid))).warning,/Invalid/);
 assert.match(decodeTerminalLayout(valid+'中'.repeat(1400)).warning,/Invalid/);
});
test('B02a actual shortcut splits empty leaves on each platform and suppresses editing/modal/IME/repeat',()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let body;function walk(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleShortcut')body=node.getText(source);ts.forEachChild(node,walk);}walk(source);
 class Target {constructor(editing=false,terminal=false){this.editing=editing;this.terminal=terminal;}closest(selector){return selector==='.xterm-helper-textarea'?this.terminal?this:null:this.editing&&selector.includes('input')?this:null;}}
 for(const platform of ['MacIntel','Win32','Linux']){
  const calls=[],bindings={Element:Target,resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(platform==='MacIntel')},navigator:{platform},document:{querySelector:()=>null},splitFocusedTerminalPane:axis=>calls.push(axis),shortcutAction:()=>null,paletteShortcut:()=>false,terminalZoomShortcut:()=>null,shortcuts:{}};
  const handler=new Function(...Object.keys(bindings),ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return handleShortcut;')(...Object.values(bindings));
  const event={key:'d',metaKey:platform==='MacIntel',ctrlKey:platform!=='MacIntel',shiftKey:platform!=='MacIntel',altKey:false,isComposing:false,repeat:false,target:new Target(false,true),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')};
  handler(event);handler({...event,key:platform==='MacIntel'?'d':'e',shiftKey:true});assert.deepEqual(calls,['prevent','stop','horizontal','prevent','stop','vertical']);
  calls.length=0;for(const change of [{isComposing:true},{repeat:true},{altKey:true},{metaKey:true,ctrlKey:true},{metaKey:false,ctrlKey:false},{metaKey:platform!=='MacIntel',ctrlKey:platform==='MacIntel'},{target:new Target(true)},...(platform==='MacIntel'?[]:[{shiftKey:false},{key:'e',shiftKey:false}])])handler({...event,...change});
  bindings.document.querySelector=()=>({});handler(event);assert.deepEqual(calls,[]);
 }
});
test('B02a non-Mac terminal Ctrl+D reaches xterm without prevention, propagation blocking or a split',()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let body;function walk(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleShortcut')body=node.getText(source);ts.forEachChild(node,walk);}walk(source);
 class Target {closest(selector){return selector.includes('input')||selector==='.xterm-helper-textarea'?this:null;}}
 for(const platform of ['Win32','Linux']){
  const calls=[],bindings={Element:Target,resolveAppShortcut,shortcutsRef:{current:defaultAppShortcuts(platform==='MacIntel')},navigator:{platform},document:{querySelector:()=>null},splitFocusedTerminalPane:axis=>calls.push(axis),shortcutAction:()=>null,paletteShortcut:()=>false,terminalZoomShortcut:()=>null,shortcuts:{}};
  const handler=new Function(...Object.keys(bindings),ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return handleShortcut;')(...Object.values(bindings));
  handler({key:'d',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false,isComposing:false,repeat:false,target:new Target(),preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')});
  assert.deepEqual(calls,[],`${platform} Ctrl+D must remain a terminal input key`);
 }
});

// A02c2 actual codec optional appearances; legacy call shapes stay unchanged.
const appearance={fontFamily:'Profile 中',fontSize:24,theme:'system'};
const appearedLayout=()=>ops.assignTerminalPane(ops.createTerminalLayout(),0,a);
test('v5 explicit appearances roundtrip while legacy and fallback own shape stays absent',()=>{const layout=appearedLayout(),raw=encodeTerminalLayout(layout,undefined,{[a]:appearance});assert.equal(JSON.parse(raw).version,5);const decoded=decodeTerminalLayout(raw);assert.equal(decoded.warning,null);assert.deepEqual(decoded.appearances,{[a]:appearance});assert.notEqual(decoded.appearances[a],appearance);assert.equal(JSON.parse(encodeTerminalLayout(layout)).version,4);for(const value of [null,encodeTerminalLayout(layout),'bad',JSON.stringify({version:1,mode:'single',panes:[a],selected:a})])assert.equal(Object.hasOwn(decodeTerminalLayout(value),'appearances'),false);assert.deepEqual(decodeTerminalLayout(encodeTerminalLayout(layout,undefined,{})).appearances,{});});
test('v5 malformed appearance rejects whole layout and invalid encode has zero writes',()=>{const layout=appearedLayout(),root=JSON.parse(encodeTerminalLayout(layout));for(const map of [null,[],{[b]:appearance},{[a]:{...appearance,fontSize:9}},{[a]:{...appearance,theme:'bad'}},{[a]:{...appearance,extra:true}}]){const raw=JSON.stringify({...root,version:5,appearances:map});assert.ok(decodeTerminalLayout(raw).warning);let writes=0;assert.ok(saveTerminalLayout(layout,()=>writes++,undefined,map));assert.equal(writes,0);}assert.ok(decodeTerminalLayout(JSON.stringify({...root,version:5,appearances:{},extra:true})).warning);});
test('v5 maximal legal sixteen-font annotations survive canonical UTF8 roundtrip',()=>{const ids=Array.from({length:16},(_,i)=>'s-'+('a'.repeat(59))+i.toString(16)+'-1');assert.equal(ids[0].length,64);let node=0;const tree=(start,end)=>end-start===1?{kind:'pane',paneId:'p-'+(start+1),sessionId:ids[start]}:{kind:'split',nodeId:'n-'+(++node),axis:'horizontal',ratio:80,first:tree(start,(start+end)/2),second:tree((start+end)/2,end)};const layout=ops.layoutFromRoot(tree(0,16),'p-16',0,'custom');for(const family of ['中'.repeat(200),'\ud800'.repeat(200),'"\\'.repeat(100),'😀'.repeat(100)]){const map=Object.fromEntries(ids.map(id=>[id,{fontFamily:family,fontSize:24,theme:'solarized'}]));const raw=encodeTerminalLayout(layout,undefined,map);assert.ok(Buffer.byteLength(raw)<=32768);assert.equal(decodeTerminalLayout(raw).warning,null);assert.deepEqual(decodeTerminalLayout(raw).appearances,map);}});
test('v5 raw total and legacy raw budgets are distinct and invalid full raw preserves fallback shape',()=>{const layout=appearedLayout(),raw=encodeTerminalLayout(layout,undefined,{[a]:appearance});const padded=raw+' '.repeat(5000);assert.equal(decodeTerminalLayout(padded).warning,null);assert.ok(decodeTerminalLayout(raw+' '.repeat(32768)).warning);assert.ok(decodeTerminalLayout(encodeTerminalLayout(layout)+' '.repeat(4096)).warning);});

test('v5 exact accepted size/theme settings and bad core reject before write',()=>{const layout=appearedLayout();for(const fontSize of [10,24])for(const theme of ['dark','light','solarized','system']){const map={[a]:{fontFamily:'"\\中😀',fontSize,theme}};assert.deepEqual(decodeTerminalLayout(encodeTerminalLayout(layout,undefined,map)).appearances,map);}const root=JSON.parse(encodeTerminalLayout(layout));assert.ok(decodeTerminalLayout(JSON.stringify({...root,version:5,root:{...root.root,extra:' '.repeat(5000)},appearances:{}})).warning);});
