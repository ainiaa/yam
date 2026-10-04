import assert from "node:assert/strict";
import {test} from "node:test";
import * as git from "../src/git-context.ts";
const clean={kind:"repository",branch:"fixture",dirty:false,root:"/one/api",common_dir:"/one/api/.git"};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test("T12 context validates finite states and never labels an unavailable result clean",()=>{
 assert.equal(git.isGitContext(clean),true);
 for(const value of [null,{...clean,dirty:"false"},{...clean,kind:"unknown"},{...clean,extra:"secret"}])assert.equal(git.isGitContext(value),false);
 assert.equal(git.isGitContext({kind:"unavailable",code:"git_attributes_unsupported",branch:null,dirty:null,root:null,common_dir:null}),true);
 assert.equal(git.gitContextLabel({...clean,dirty:true}),"fixture · dirty");
 assert.match(git.gitContextLabel({kind:"unavailable",code:"git_timeout",branch:null,dirty:null,root:null,common_dir:null}),/unavailable/i);
});
test("T12 polling waits five seconds and updates only changed values",async()=>{
 const poll=new git.GitContextPolling(),updates=[],calls=[];poll.select("/one/api","owner-a");
 const request=async p=>{calls.push(p);return clean;};
 await poll.poll(0,request,v=>updates.push(v));await poll.poll(4999,request,v=>updates.push(v));
 await poll.poll(5000,request,v=>updates.push(v));assert.equal(calls.length,2);assert.equal(updates.length,1);
 await poll.poll(10000,async()=>({...clean,dirty:true}),v=>updates.push(v));assert.equal(updates.length,2);
});
test("T12 one query in flight across repeated ticks",async()=>{
 const poll=new git.GitContextPolling(),pending=deferred(),updates=[],calls=[];poll.select("/one/api","a");
 const first=poll.poll(0,p=>{calls.push(p);return pending.promise;},v=>updates.push(v));
 await poll.poll(5000,async()=>{calls.push("duplicate");return clean;},v=>updates.push(v));
 pending.resolve(clean);await first;assert.deepEqual(calls,["/one/api"]);assert.equal(updates.length,1);
});
test("T12 project owner and cancel invalidate old successful and failed responses",async()=>{
 for(const action of ["project","owner","cancel"])for(const error of [false,true]){
  const poll=new git.GitContextPolling(),pending=deferred(),updates=[];poll.select("/one/api","a");
  const old=poll.poll(0,()=>pending.promise,v=>updates.push(v));
  if(action==="cancel")poll.cancel();else poll.select(action==="project"?"/two/api":"/one/api",action==="owner"?"b":"a");
  if(error)pending.reject(Error("private raw error"));else pending.resolve(clean);
  await old;assert.deepEqual(updates,[]);
 }
});
test("T12 query errors become fixed unavailable state without raw error disclosure",async()=>{
 const poll=new git.GitContextPolling(),updates=[];poll.select("/one/api","a");
 await poll.poll(0,async()=>{throw Error("private /absolute/path token");},v=>updates.push(v));
 assert.equal(updates.length,1);assert.equal(updates[0].kind,"unavailable");assert.equal(updates[0].dirty,null);
 assert.ok(!JSON.stringify(updates).includes("private"));
});
test("T12 actual App Git effect wires active project owner cancellation and interval",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript");
 const source=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
 const tree=ts.default.createSourceFile("App.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);
 let effect;const visit=n=>{if(ts.default.isCallExpression(n)&&n.expression.getText(tree)==="useEffect"&&n.arguments[0]?.getText(tree).includes("get_git_context"))effect=n.arguments[0].getText(tree);ts.default.forEachChild(n,visit);};visit(tree);
 assert.ok(effect,"actual App Git polling effect must exist");
 const callbacks=[],updates=[],calls=[],state=new git.GitContextPolling();
 const values={gitProjectPath:"/one/api",gitOwner:"owner-a",gitPolling:{current:state},setGitContext:v=>updates.push(v),invoke:async(name,args)=>{calls.push([name,args]);return clean;},setInterval:(fn,ms)=>{assert.ok(ms>=5000);callbacks.push(fn);return 1;},clearInterval:()=>{},performance:{now:()=>0}};
 const run=new Function(...Object.keys(values),ts.default.transpile("const effect = "+effect,{target:ts.default.ScriptTarget.ES2022})+";return effect;")(...Object.values(values));
 const cleanup=run();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[["get_git_context",{path:"/one/api"}]]);assert.equal(updates.length,1);assert.equal(callbacks.length,1);
 cleanup();await callbacks[0]();assert.equal(calls.length,1);
});

test("T12 A B A and owner changes keep old finally from releasing a new request",async()=>{
 const poll=new git.GitContextPolling(),old=deferred(),current=deferred(),updates=[],calls=[];
 poll.select("/one/api","owner-a");const first=poll.poll(0,p=>{calls.push(p);return old.promise;},v=>updates.push(v));
 poll.select("/two/api","owner-a");poll.select("/one/api","owner-b");
 await poll.poll(5000,async()=>{calls.push("forbidden-overlap");return clean;},v=>updates.push(v));
 assert.deepEqual(calls,["/one/api"]);old.resolve(clean);await first;assert.deepEqual(updates,[]);
 const second=poll.poll(10000,p=>{calls.push(p);return current.promise;},v=>updates.push(v));
 await poll.poll(15000,async()=>{calls.push("forbidden-finally");return clean;},v=>updates.push(v));
 current.resolve(clean);await second;assert.deepEqual(calls,["/one/api","/one/api"]);assert.equal(updates.length,1);
});
test("T12 failure and cancel retain per-path minimum interval and invalid responses unavailable",async()=>{
 const poll=new git.GitContextPolling(),calls=[],updates=[];poll.select("/one/api","owner-a");
 await poll.poll(0,async()=>{calls.push(0);throw Error("secret");},v=>updates.push(v));
 poll.cancel();poll.select("/one/api","owner-b");
 await poll.poll(4999,async()=>{calls.push(4999);return clean;},v=>updates.push(v));
 await poll.poll(5000,async()=>{calls.push(5000);return {...clean,dirty:"wrong"};},v=>updates.push(v));
 assert.deepEqual(calls,[0,5000]);assert.equal(updates.at(-1).kind,"unavailable");
});

test("T12 actual App selection owner and unmount cancel late success error and interval",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript");
 const source=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
 const tree=ts.default.createSourceFile("App.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);
 let effect;const visit=n=>{if(ts.default.isCallExpression(n)&&n.expression.getText(tree)==="useEffect"&&n.arguments[0]?.getText(tree).includes("get_git_context"))effect=n.arguments[0].getText(tree);ts.default.forEachChild(n,visit);};visit(tree);
 assert.ok(effect,"actual Git effect exists");
 for(const change of ["project","owner","unmount"])for(const fails of [false,true]){
  const state=new git.GitContextPolling(),old=deferred(),updates=[],calls=[],callbacks=[];let now=0;
  const build=(path,owner)=>{const values={gitProjectPath:path,gitOwner:owner,gitPolling:{current:state},setGitContext:v=>updates.push(v),invoke:async(name,args)=>{calls.push([name,args]);return calls.length===1?old.promise:clean;},setInterval:fn=>{callbacks.push(fn);return callbacks.length;},clearInterval:()=>{},performance:{now:()=>now}};return new Function(...Object.keys(values),ts.default.transpile("const effect = "+effect,{target:ts.default.ScriptTarget.ES2022})+";return effect;")(...Object.values(values))();};
  const cancel=build("/one/api","a");cancel();
  const next=change==="unmount"?null:build(change==="project"?"/two/api":"/one/api",change==="owner"?"b":"a");
  assert.equal(calls.length,1);if(fails)old.reject(Error("secret"));else old.resolve(clean);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(updates,[]);
  now=5000;await callbacks[0]();assert.equal(calls.length,1);
  if(next){await callbacks[1]();assert.equal(calls.length,2);assert.equal(updates.length,1);next();}
 }
});
