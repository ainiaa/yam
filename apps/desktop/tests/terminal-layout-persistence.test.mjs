// Author: Jeff.Liu. Pure ID-only preference tests; no App restore or native owner calls.
import {test} from "node:test";
import assert from "node:assert/strict";
import * as persistence from "../src/terminal-layout-persistence.ts";
import {createTerminalLayout} from "../src/terminal-layout.ts";

const a="s-19aa2b3-1",b="s-19aa2b3-2",c="s-19aa2b3-3",d="s-19aa2b3-4";
const legacy={version:1,mode:"grid",panes:[a,null,b,null],selected:b};
const payload={version:2,mode:"grid",panes:[a,null,b,null],selected:b,splitPercent:63};
const layout={mode:"grid",panes:[a,null,b,null],focused:2,revision:18};
const decode=value=>persistence.decodeTerminalLayout(JSON.stringify(value));
const withDefault=state=>({layout:state,splitPercent:50,warning:null});
function fallback(result){
 assert.deepEqual(result.layout,createTerminalLayout());
 assert.equal(typeof result.warning,"string");assert.ok(result.warning.length>0);
 assert.equal(result.warning.includes("SECRET"),false);
}

test("F2 v2 ratio round trips beside ID-only state without runtime fields",()=>{
 const raw=persistence.encodeTerminalLayout(layout,63);
 assert.deepEqual(JSON.parse(raw),payload);
 assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),["mode","panes","selected","splitPercent","version"]);
 assert.deepEqual(persistence.decodeTerminalLayout(raw),{layout:{...layout,revision:0},splitPercent:63,warning:null});
 assert.equal(layout.revision,18);assert.equal(layout.panes[2],b);
});
test("F2 v1 migrates to the default split and null preferences remain defaulted",()=>{
 assert.deepEqual(decode(legacy),{layout:{...layout,revision:0},splitPercent:50,warning:null});
 assert.deepEqual(persistence.decodeTerminalLayout(null),withDefault(createTerminalLayout()));
});
test("T15 pure empty slots and selected-empty pane use a finite default focus",()=>{
 assert.deepEqual(decode({version:2,mode:"horizontal",panes:[a,null],selected:null,splitPercent:50}),{layout:{mode:"horizontal",panes:[a,null],focused:1,revision:0},splitPercent:50,warning:null});
 assert.deepEqual(decode({version:2,mode:"grid",panes:[null,null,null,null],selected:null,splitPercent:50}),{layout:{mode:"grid",panes:[null,null,null,null],focused:0,revision:0},splitPercent:50,warning:null});
});
test("T15 pure all finite modes round trip one two four slots",()=>{
 for(const [mode,panes] of [["single",[a]],["horizontal",[a,b]],["vertical",[null,b]],["grid",[a,b,c,d]]]){
  const focused=panes.length-1,state={mode,panes,focused,revision:1};
  assert.deepEqual(persistence.decodeTerminalLayout(persistence.encodeTerminalLayout(state)),{layout:{...state,revision:0},splitPercent:50,warning:null});
 }
});
test("T15 pure schema rejects unknown versions modes missing keys and wrong types",()=>{
 for(const value of [null,[],{}, {...payload,version:3},{...payload,version:"2"},{...payload,mode:"freeform"},{...payload,panes:null},{...payload,selected:4},{version:2,mode:payload.mode,panes:payload.panes,selected:b}])fallback(decode(value));
});
test("T15 pure schema rejects runtime and sensitive extra keys without echoing them",()=>{
 for(const key of ["owner","instance","command","argv","prompt","launch","env","token","revision","focused","__proto__"]){
  fallback(decode({...payload,[key]:"SECRET"}));
 }
});
test("F2 v2 rejects out-of-range, fractional and malformed split ratios",()=>{
 for(const splitPercent of [19,81,20.5,null,"50"]){fallback(decode({...payload,splitPercent}));}
 for(const splitPercent of [20,80])assert.equal(decode({...payload,splitPercent}).splitPercent,splitPercent);
});
test("T15 pure schema rejects duplicates oversized and mismatched slot counts",()=>{
 for(const value of [{...payload,panes:[a,a,null,null]},{...payload,panes:[a,b,c,d,null]},{...payload,panes:[a,b]},{...payload,mode:"single"},{...payload,mode:"horizontal"},{...payload,panes:[]}])fallback(decode(value));
});
test("T15 pure selected ID must belong to a pane and null must identify an empty pane",()=>{
 fallback(decode({...payload,selected:c}));
 fallback(decode({...payload,panes:[a,b,c,d],selected:null}));
 assert.equal(decode({...payload,selected:a}).layout.focused,0);
});
test("T15 pure IDs are bounded ASCII session identifiers not paths or commands",()=>{
 for(const bad of ["", "a", "s-/tmp-1", "../s-1-2", "s-1-$(x)", "s-1-中", "s-1-2\n", 4,{},"s-"+"a".repeat(61)+"-b"]){
  fallback(decode({version:1,mode:"single",panes:[bad],selected:bad}));
 }
 const longest="s-"+"a".repeat(30)+"-"+"b".repeat(31);
 assert.equal(longest.length,64);assert.equal(decode({version:2,mode:"single",panes:[longest],selected:longest,splitPercent:50}).warning,null);
});
test("T15 pure malformed or over-limit raw JSON falls back with a fixed warning",()=>{
 for(const raw of ["", "{SECRET", " ".repeat(4097), JSON.stringify({...payload,prompt:"SECRET".repeat(900)})])fallback(persistence.decodeTerminalLayout(raw));
 assert.equal(persistence.decodeTerminalLayout(JSON.stringify(payload)+" ".repeat(4096-JSON.stringify(payload).length)).warning,null);
});
test("T15 pure decode returns independent mutable layouts rather than sharing defaults",()=>{
 const one=persistence.decodeTerminalLayout(null),two=persistence.decodeTerminalLayout(null);
 one.layout.panes[0]=a;assert.deepEqual(two.layout,createTerminalLayout());
 const valid=decode(payload);valid.layout.panes[0]=c;assert.equal(payload.panes[0],a);
});
test("T15 callback load reads once and unavailable storage falls back without raw secrets",()=>{
 let reads=0;assert.deepEqual(persistence.loadTerminalLayout(()=>{reads++;return JSON.stringify(payload);}),decode(payload));assert.equal(reads,1);
 fallback(persistence.loadTerminalLayout(()=>{throw Error("SECRET storage error");}));
});
test("T15 callback save writes one ID-only snapshot and reports storage failure safely",()=>{
 const writes=[];assert.equal(persistence.saveTerminalLayout(layout,value=>writes.push(value),63),null);assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0]),payload);
 const warning=persistence.saveTerminalLayout(layout,()=>{throw Error("SECRET quota");},63);assert.equal(typeof warning,"string");assert.ok(warning.length>0);assert.equal(warning.includes("SECRET"),false);
});
test("T15 invalid state never reaches preference write and encode uses fixed rejection",()=>{
 for(const state of [{...layout,focused:4},{...layout,focused:0.5},{...layout,revision:-1},{...layout,panes:[a,a,b,null]},{...layout,panes:[a,,b,null]},{...layout,command:"SECRET"},{...layout,mode:"unknown"}]){
  assert.throws(()=>persistence.encodeTerminalLayout(state),/^Error: Invalid terminal layout$/);
  let writes=0;const warning=persistence.saveTerminalLayout(state,()=>writes++,50);assert.equal(writes,0);assert.equal(typeof warning,"string");assert.equal(warning.includes("SECRET"),false);
 }
 for(const splitPercent of [19,81,20.5,NaN])assert.throws(()=>persistence.encodeTerminalLayout(layout,splitPercent),/^Error: Invalid terminal layout$/);
});
