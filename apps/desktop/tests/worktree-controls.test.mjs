// Author: Jeff.Liu. No test starts a real agent or operates a user repository.
import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalViews} from "../src/terminal-views.ts";
import * as worktree from "../src/worktree-controls.ts";
const record={attempt:"a".repeat(64),session_id:"s-123-1",repository:"/fixture/repo",common_dir:"/fixture/repo/.git",target:"/fixture/worktree",branch:"codex/yam/s-123-1",commit:"b".repeat(40),state:"created",checkout_complete:true,session_claimed:false};
const preview={...record,state:"creating",checkout_complete:false,reference:"refs/heads/main",revision:1};
const request={root:record.repository,target:record.target,reference:"refs/heads/main",branch:null};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test("T13 finite records enforce checkout completion and prospective ID branch",()=>{
 assert.equal(worktree.isManagedWorktree(record),true);
 for(const value of [null,{...record,state:"unknown"},{...record,extra:"command"},{...record,checkout_complete:"true"}])assert.equal(worktree.isManagedWorktree(value),false);
 assert.equal(worktree.canStartWorktree(record),true);
 for(const value of [{...record,state:"creating",checkout_complete:false},{...record,state:"failed"},{...record,session_claimed:true}])assert.equal(worktree.canStartWorktree(value),false);
});
test("T13 preview and explicit create use only opaque attempt and never launch",async()=>{
 const flow=new worktree.WorktreeSelection(),calls=[];flow.select(record.repository,"owner-a");
 const invoke=async(name,args)=>{calls.push([name,args]);return name==="preview_worktree_create"?preview:record;};
 await flow.previewCreate(request,invoke);assert.deepEqual(calls,[["preview_worktree_create",request]]);assert.equal(flow.record,null);
 await flow.confirmCreate(invoke);assert.deepEqual(calls.at(-1),["create_worktree",{attempt:record.attempt}]);assert.deepEqual(flow.record,record);
 assert.ok(calls.every(([name])=>name!=="create_session"));
});
test("T13 cancel owner change and late success error do not reopen or start",async()=>{
 for(const mode of ["cancel","owner"])for(const fail of [false,true]){
  const flow=new worktree.WorktreeSelection(),old=deferred(),calls=[];flow.select(record.repository,"owner-a");
  const pending=flow.previewCreate(request,async(name,args)=>{calls.push([name,args]);return old.promise;});
  if(mode==="cancel")flow.cancel();else flow.select(record.repository,"owner-b");
  if(fail)old.reject(Error("private source"));else old.resolve(preview);await pending;
  assert.equal(flow.preview,null);assert.equal(flow.record,null);assert.equal(flow.error,null);assert.equal(calls.length,1);
 }
});
test("T13 dropped create response retries the same attempt not a new operation",async()=>{
 const flow=new worktree.WorktreeSelection(),calls=[];flow.select(record.repository,"owner-a");
 await flow.previewCreate(request,async()=>preview);
 await flow.confirmCreate(async(name,args)=>{calls.push([name,args]);throw Error("response lost");});
 assert.equal(flow.preview.attempt,record.attempt);assert.equal(flow.record,null);
 await flow.confirmCreate(async(name,args)=>{calls.push([name,args]);return record;});
 assert.deepEqual(calls,[["create_worktree",{attempt:record.attempt}],["create_worktree",{attempt:record.attempt}]]);
});
test("T13 cleanup eligibility is explicit and unfinished records cannot remove",()=>{
 assert.match(worktree.cleanupUnavailableReason(),/unavailable/i);
 assert.equal(worktree.canRemoveWorktree(record),true);
 for(const state of ["creating","failed","removing","removed"])assert.equal(worktree.canRemoveWorktree({...record,state}),false);
});
async function actualFunction(name,values,sourcePath="../src/App.tsx"){
 const fs=await import("node:fs/promises"),ts=await import("typescript");
 const source=await fs.readFile(new URL(sourcePath,import.meta.url),"utf8");
 const tree=ts.default.createSourceFile("App.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found,cancellation;
 const visit=node=>{if(ts.default.isFunctionDeclaration(node)&&node.name?.text==="cancelLayoutRestore")cancellation=node.getText(tree);if(ts.default.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(tree);ts.default.forEachChild(node,visit);};visit(tree);
 assert.ok(found,`actual App ${name} callback must exist`);
 values={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},...values};
 return new Function(...Object.keys(values),ts.default.transpile((cancellation??"")+"\n"+found,{target:ts.default.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(values));
}
test("T13 actual App created callback changes root cancels old trust and does not start",async()=>{
 const calls=[];const callback=await actualFunction("worktreeCreated",{cancelProjectPreview:()=>calls.push("cancel-parent-trust"),setCwd:v=>calls.push(["cwd",v]),setActiveProject:v=>calls.push(["project",v]),setProjectTemplate:v=>calls.push(["template",v]),setSelectedWorktree:v=>calls.push(["selected",v]),startSession:()=>calls.push("forbidden-start")});
 await callback(record);assert.ok(calls.includes("cancel-parent-trust"));assert.ok(calls.some(v=>Array.isArray(v)&&v[0]==="cwd"&&v[1]===record.target));assert.ok(!calls.includes("forbidden-start"));
});
test("T13 actual App explicit managed start preserves normal owner create path",async()=>{
 const calls=[];const callback=await actualFunction("startManagedWorktree",{cwd:record.target,startSession:async(...args)=>calls.push(args),setError:v=>calls.push(["error",v])});
 await callback(record);assert.deepEqual(calls,[[undefined,record.attempt]]);
});

test("T13 actual App renders explicit managed controls without an automatic launch",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript");const source=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");const tree=ts.default.createSourceFile("App.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let element;
 const visit=node=>{if(ts.default.isJsxSelfClosingElement(node)&&node.tagName.getText(tree)==="WorktreeControls")element=node;ts.default.forEachChild(node,visit);};visit(tree);
 assert.ok(element,"actual App must render worktree controls");const attributes=Object.fromEntries(element.attributes.properties.filter(ts.default.isJsxAttribute).map(item=>[item.name.text,item.initializer?.getText(tree)]));
 assert.equal(attributes.onCreated,"{worktreeCreated}");assert.equal(attributes.onStart,"{startManagedWorktree}");assert.equal(attributes.selected,"{selectedWorktree}");assert.match(attributes.root,/gitProjectPath/);
});

test("T13 actual App rejects created callback from an old project or owner",async()=>{
 for(const changed of [{root:"/B",owner:1},{root:record.repository,owner:2}]){
  const calls=[],worktreeContextRef={current:changed};const callback=await actualFunction("worktreeCreated",{worktreeContextRef,cancelProjectPreview:()=>calls.push("cancel"),setProjectTemplate:()=>calls.push("template"),setCwd:()=>calls.push("cwd"),setActiveProject:()=>calls.push("project"),setSelectedWorktree:()=>calls.push("selected")});
  callback(record,record.repository,1);assert.deepEqual(calls,[]);
 }
});

test("T13 actual visible component ignores late create success error and finally",async()=>{
 for(const mode of ["cancel","project","owner","unmount"])for(const fail of [false,true]){
  const selection=new worktree.WorktreeSelection();selection.select(record.repository,"1");await selection.previewCreate(request,async()=>preview);
  const pending=deferred(),calls=[],context={current:{root:record.repository,owner:1,version:0,alive:true}},flow={current:selection};
  const values={context,flow,root:record.repository,owner:1,invoke:async()=>pending.promise,setBusy:value=>calls.push(["busy",value]),setError:value=>calls.push(["error",value]),setPreview:value=>calls.push(["preview",value]),setCleanupPreview:()=>{},setCleanupResult:()=>{},setRecords:value=>calls.push(["records",value]),onCreated:()=>calls.push("forbidden-created")};
  const create=await actualFunction("create",values,"../src/WorktreeControls.tsx");const completion=create();
  if(mode==="cancel"){const cancel=await actualFunction("cancel",values,"../src/WorktreeControls.tsx");cancel();}
  else {context.current.version++;if(mode==="unmount"){context.current.alive=false;selection.cancel();}else if(mode==="project"){context.current.root="/B";selection.select("/B","1");}else{context.current.owner=2;selection.select(record.repository,"2");}}
  const before=structuredClone(calls);if(fail)pending.reject(Error("private error"));else pending.resolve(record);await completion;assert.deepEqual(calls,before);
 }
});

test("T13 actual App owner arguments preserve manual and trusted project paths with opaque attempt",async()=>{
 for(const useProjectSettings of [false,true]){
  const calls=[],projectPreview={root:record.target,trusted:true},values={starting:false,creatingSession:{current:false},terminalViews:{current:new TerminalViews(16)},setError:()=>{},adapters:[],selectedAdapter:"shell",command:"echo literal",cwd:record.target,prompt:"",adapterArgs:"",launchMode:"interactive",setStarting:()=>{},invoke:async(...args)=>{calls.push(args);throw Error("captured before actual launch");},terminal:{current:null},projectPreview,projectLaunchEdits:{prompt:""},projectTemplate:"",useProjectSettings,projectConfigBusy:false};
  const start=await actualFunction("startSession",values);await start(undefined,record.attempt);assert.equal(calls.length,1);assert.equal(calls[0][0],"create_session");assert.equal(calls[0][1].worktreeAttempt,record.attempt);
  if(useProjectSettings)assert.deepEqual(calls[0][1].projectConfig,{root:record.target,template:null,overrides:{prompt:""}});else assert.equal(calls[0][1].cwd,record.target);
 }
});

async function renderManaged(props, records=[], states={}){
 const {readFile}=await import("node:fs/promises"),ts=(await import("typescript")).default;
 const source=await readFile(new URL("../src/WorktreeControls.tsx",import.meta.url),"utf8"),exports={};let cursor=0;
 const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useRef:value=>({current:value}),useEffect(){},useState(value){const index=cursor++;return [index in states?states[index]:index===4?records:value,()=>{}]}};
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
 new Function("exports","require","React",compiled)(exports,name=>name==="react"?React:name.includes("worktree-controls")?worktree:{invoke:async()=>records},React);
 return exports.WorktreeControls(props);
}
function elements(tree){const result=[];function visit(node){if(node&&typeof node==="object"){result.push(node);node.children?.flat(Infinity).forEach(visit)}}visit(tree);return result;}
test("T13 cleanup actual component offers preview and explicit Trash confirmation only",async()=>{
 const calls=[],tree=await renderManaged({root:record.repository,owner:1,selected:record,onCreated(){calls.push("created")},onStart(){calls.push("start")}},[record]);
 const buttons=elements(tree).filter(item=>item.type==="button");
 assert.ok(buttons.some(item=>item.children.flat(Infinity).join("")==="Preview cleanup"&&!item.props.disabled),"eligible managed record must offer a real preview action");
 assert.ok(!buttons.some(item=>item.children.flat(Infinity).join("")==="Move to Trash"),"confirmation is not visible before preview");
 assert.deepEqual(calls,[]);
});
test("T13 cleanup actual component refuses stale Created selection after current record Removing or Removed",async()=>{
 for(const state of ["removing","removed"]){const tree=await renderManaged({root:record.repository,owner:1,selected:record,onCreated(){},onStart:()=>assert.fail("stale selected record must never start")},[{...record,state}]);const button=elements(tree).find(item=>item.type==="button"&&item.children.flat(Infinity).join("")==="Start first session");assert.ok(!button||button.props.disabled,`${state} latest record must override stale parent selection`);}
});

const cleanupPreview={attempt:record.attempt,preview:"c".repeat(64),target:record.target,branch:record.branch,commit:record.commit,action:"trash"};
const removed={...record,state:"removed",cleanup:{phase:"trashed",recovery_needed:false,retained_path:"/fixture/private-q/worktree",returned_path:"/fixture/mock-Trash/collision 中",reason:null}};
test("T13 cleanup flow uses preview then exact explicit token and validates durable result",async()=>{
 const flow=new worktree.WorktreeSelection(),calls=[];flow.select(record.repository,"1");
 const invoke=async(name,args)=>{calls.push([name,args]);return name==="preview_worktree_cleanup"?cleanupPreview:removed;};
 await flow.previewCleanup(record,invoke);assert.deepEqual(calls,[["preview_worktree_cleanup",{attempt:record.attempt}]]);assert.equal(flow.cleanupRecord,null);
 const result=await flow.confirmCleanup(invoke);assert.deepEqual(calls[1],["cleanup_worktree",{attempt:record.attempt,preview:cleanupPreview.preview}]);assert.deepEqual(result,removed);
 assert.ok(!calls.some(([name])=>name==="create_session"));
 for(const bad of [{...removed,cleanup:{...removed.cleanup,phase:"unknown"}},{...removed,cleanup:{...removed.cleanup,secret:"error"}},{...removed,cleanup:{...removed.cleanup,recovery_needed:true}}])assert.equal(worktree.isManagedWorktree(bad),false);
});
test("T13 cleanup actual callbacks cancel owner root unmount and double click without late UI updates",async()=>{
 for(const phase of ["preview","confirm"])for(const mode of ["cancel","root","owner","unmount"])for(const fail of [false,true]){
  const selection=new worktree.WorktreeSelection();selection.select(record.repository,"1");
  if(phase==="confirm")await selection.previewCleanup(record,async()=>cleanupPreview);
  const wait=deferred(),calls=[],context={current:{root:record.repository,owner:1,version:0,alive:true}};
  const callback=await actualFunction(phase==="preview"?"prepareCleanup":"confirmCleanup",{context,flow:{current:selection},invoke:async()=>wait.promise,setBusy:v=>calls.push(["busy",v]),setError:v=>calls.push(["error",v]),setCleanupPreview:v=>calls.push(["preview",v]),setCleanupResult:v=>calls.push(["result",v]),setRecords:v=>calls.push(["records",v]),onCreated:()=>calls.push("forbidden-create"),onStart:()=>calls.push("forbidden-start")},"../src/WorktreeControls.tsx");
  const pending=callback(record);context.current.version++;if(mode==="unmount")context.current.alive=false;else if(mode==="owner")context.current.owner=2;else if(mode==="root")context.current.root="/other";selection.cancel();const before=structuredClone(calls);
  if(fail)wait.reject(Error("sensitive"));else wait.resolve(phase==="preview"?cleanupPreview:removed);await pending;assert.deepEqual(calls,before);
 }
});

test("T13 cleanup actual target-root callbacks show confirmation and never start or switch project",async()=>{
 const selection=new worktree.WorktreeSelection();selection.select(record.target,"1");const calls=[],context={current:{root:record.target,owner:1,version:0,alive:true}};
 let shown=null,result=null,records=[record];
 const values={context,flow:{current:selection},invoke:async(name,args)=>{calls.push([name,args]);return name==="preview_worktree_cleanup"?cleanupPreview:removed;},setBusy(){},setError:value=>assert.equal(value,null),setCleanupPreview:value=>{shown=value;},setCleanupResult:value=>{result=value;},setRecords:update=>{records=update(records);},onCreated:()=>assert.fail("must not select project"),onStart:()=>assert.fail("must not start")};
 const prepare=await actualFunction("prepareCleanup",values,"../src/WorktreeControls.tsx");await prepare(record);assert.deepEqual(shown,cleanupPreview);
 const confirmation=await renderManaged({root:record.target,owner:1,selected:record,onCreated(){},onStart(){}},records,{7:shown});
 assert.ok(elements(confirmation).some(item=>item.type==="button"&&item.children.flat(Infinity).join("")==="Move to Trash"));
 const confirm=await actualFunction("confirmCleanup",values,"../src/WorktreeControls.tsx");await confirm();assert.deepEqual(result,removed);assert.deepEqual(records,[removed]);assert.equal(shown,null);
 const final=await renderManaged({root:record.target,owner:1,selected:record,onCreated(){},onStart:()=>assert.fail("stale start")},records,{8:result});
 assert.ok(!elements(final).some(item=>item.type==="button"&&item.children.flat(Infinity).join("")==="Preview cleanup"));
 assert.ok(elements(final).filter(item=>item.type==="p").some(item=>item.children.flat(Infinity).join("").includes("Moved to Trash; branch retained")));
 assert.deepEqual(calls,[["preview_worktree_cleanup",{attempt:record.attempt}],["cleanup_worktree",{attempt:record.attempt,preview:cleanupPreview.preview}]]);
});

test("T13 cleanup operation errors are visible outside collapsed creation details",async()=>{
 const tree=await renderManaged({root:record.target,owner:1,selected:record,onCreated(){},onStart(){}},[record],{6:"worktree_not_clean"});
 const direct=tree.children.flat(Infinity).filter(item=>item&&item.type==="p"&&item.props.role==="alert");
 assert.equal(direct.length,1,"cleanup rejection must have one visible section-level alert");assert.equal(direct[0].children.join(""),"worktree_not_clean");
 const creation=tree.children.flat(Infinity).find(item=>item?.type==="details");
 assert.equal(elements(creation).filter(item=>item.type==="p"&&item.props.role==="alert").length,0,"shared alert must not be hidden in create details");
});

test("T13 cleanup recovery reports returned path or unknown location without claiming retained files",async()=>{
 for(const returned_path of [null,"/fixture/mock-Trash/verified"]){
  const recovery={...record,state:"removing",cleanup:{phase:"trashing",recovery_needed:true,retained_path:"/fixture/private-q/worktree",returned_path,reason:"worktree_native_result_unknown"}};
  const tree=await renderManaged({root:record.target,owner:1,selected:record,onCreated(){},onStart(){}},[recovery],{8:recovery});
  const messages=elements(tree).filter(item=>item.type==="p").map(item=>item.children.flat(Infinity).join("")).join("\n");
  assert.ok(!messages.includes("Files are retained where verified"));
  if(returned_path)assert.ok(messages.includes(returned_path));else assert.match(messages,/location.*unknown/i);
 }
});
