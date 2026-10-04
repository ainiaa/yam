import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalViews} from "../src/terminal-views.ts";
import * as config from "../src/project-config.ts";

const globalDefaults={adapter:"codex",mode:"interactive",extra_args:"--global",prompt:null,command:null};
const project={adapter:"claude",extra_args:"--project"};

test("T09 launch defaults use UI > trusted project > application defaults without mutation",()=>{
 const baseline=structuredClone(globalDefaults),approved=structuredClone(project);
 assert.deepEqual(config.resolveLaunchDefaults(globalDefaults,project,{extra_args:"",prompt:"literal $(echo x); 中😀"}),{...globalDefaults,...project,extra_args:"",prompt:"literal $(echo x); 中😀"});
 assert.deepEqual(globalDefaults,baseline);assert.deepEqual(project,approved);
 assert.deepEqual(config.resolveLaunchDefaults(globalDefaults,null,{}),globalDefaults);
});
test("T09 private global defaults reject corrupt fields and retain explicit empty overrides",()=>{
 assert.equal(config.isLaunchDefaults(globalDefaults),true);
 for(const value of [null,[],{...globalDefaults,adapter:"unknown"},{...globalDefaults,adapter:["codex"]},{...globalDefaults,mode:["interactive"]},{...globalDefaults,mode:"fast"},{...globalDefaults,extra_args:3},{...globalDefaults,env:{KEY:"SECRET"}},{...globalDefaults,unexpected:true}])assert.equal(config.isLaunchDefaults(value),false);
 assert.equal(config.resolveLaunchDefaults(globalDefaults,project,{extra_args:""}).extra_args,"");
});
test("T09 preview never launches and trust requires separate explicit confirmation",async()=>{
 const events=[],preview={root:"/one/api",identity:"device:inode",source:"{version:1}",config:{version:1,defaults:project,templates:[]},trusted:false};
 const state=new config.ProjectConfigSelection();
 await state.load(()=>Promise.resolve(preview));
 assert.equal(state.approved,null);assert.deepEqual(events,[]);
 await state.approve(async p=>{events.push(p);return {...p,trusted:true};});
 assert.deepEqual(state.approved,project);assert.deepEqual(events,[preview]);
});
test("T09 preview cancel preserves global defaults and performs no trust or launch",async()=>{
 const state=new config.ProjectConfigSelection(),trust=[];
 await state.load(async()=>({root:"/one/api",identity:"one",source:"one",config:{version:1,defaults:project,templates:[]},trusted:false}));
 state.cancel();assert.equal(state.preview,null);assert.equal(state.approved,null);assert.deepEqual(trust,[]);
 assert.deepEqual(config.resolveLaunchDefaults(globalDefaults,state.approved,{}),globalDefaults);
});
test("T09 changed bytes, same basename different root, and replaced physical root revoke approval",async()=>{
 const state=new config.ProjectConfigSelection();
 const a={root:"/one/api",identity:"inode1",source:"first",config:{version:1,defaults:project,templates:[]},trusted:true};
 await state.load(async()=>a);assert.deepEqual(state.approved,project);
 for(const next of [{...a,source:"changed",trusted:false},{...a,root:"/two/api",identity:"inode2",trusted:false},{...a,identity:"replacement",trusted:false}]){await state.load(async()=>next);assert.equal(state.approved,null);}
});
test("T09 stale preview and trust replies cannot approve a newer project",async()=>{
 const state=new config.ProjectConfigSelection(),a={root:"/one/api",identity:"one",source:"a",config:{version:1,defaults:project,templates:[]},trusted:false};
 await state.load(async()=>a);
 let finish;const old=state.approve(()=>new Promise(resolve=>{finish=resolve;}));
 await state.load(async()=>({...a,root:"/two/api",identity:"two",source:"b"}));
 finish({...a,trusted:true});await old;assert.equal(state.approved,null);assert.equal(state.preview.root,"/two/api");
 let resolveOld;const oldLoad=state.load(()=>new Promise(resolve=>{resolveOld=resolve;}));
 await state.load(async()=>a);resolveOld({...a,root:"/stale/api"});await oldLoad;assert.equal(state.preview.root,"/one/api");
});
test("T09 preview errors fail closed without changing application CLI defaults",async()=>{
 const state=new config.ProjectConfigSelection();
 await assert.rejects(state.load(async()=>{throw Error("project_config_version");}),/project_config_version/);
 assert.equal(state.approved,null);assert.deepEqual(globalDefaults,{adapter:"codex",mode:"interactive",extra_args:"--global",prompt:null,command:null});
});
test("T09 malicious custom command is preview text until trust and a later launch action",async()=>{
 const state=new config.ProjectConfigSelection();
 const malicious={adapter:"custom",command:"touch /never-run; $(echo secret); ${TOKEN}",mode:"interactive"};
 await state.load(async()=>({root:"/fixture",identity:"fixture",source:"bytes",trusted:false,config:{version:1,defaults:malicious,templates:[]}}));
 assert.equal(state.approved,null);assert.equal(state.preview.config.defaults.command,malicious.command);
});

test("T09 cancel invalidates pending preview and trust success or failure",async()=>{
 for(const phase of ["load","approve"])for(const fails of [false,true]){
  const state=new config.ProjectConfigSelection(),p={root:"/one/api",identity:"one",source:"a",config:{version:1,defaults:project,templates:[]},trusted:false};
  if(phase==="approve")await state.load(async()=>p);
  let finish,fail;const delayed=()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  const old=phase==="load"?state.load(delayed):state.approve(delayed);state.cancel();
  if(fails)fail(Error("late cancelled error"));else finish({...p,trusted:true});
  await old;assert.equal(state.preview,null);assert.equal(state.approved,null);
 }
});

test("T09 actual App start sends only explicit edits, so trusted project defaults reach owner",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript");
 const app=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
 const body=app.slice(app.indexOf("  async function startSession("),app.indexOf("  async function stopSession("));
 assert.ok(body.includes("async function startSession"));
 const code=ts.default.transpile(app.slice(app.indexOf("  function cancelLayoutRestore("),app.indexOf("  function terminalPaneVisible("))+body,{target:ts.default.ScriptTarget.ES2022});
 for(const edits of [{},{extra_args:"",prompt:"explicit input"}]){
  const calls=[],preview={root:"/trusted/project",identity:"root",source:"exact",trusted:true,config:{version:1,defaults:{adapter:"claude",extra_args:"--project"},templates:[]}};
  const values={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},starting:false,creatingSession:{current:false},terminalViews:{current:new TerminalViews(16)},setError:()=>{},adapters:[],selectedAdapter:"shell",command:"",cwd:"/trusted/project",prompt:"",adapterArgs:"--global",launchMode:"interactive",setStarting:()=>{},invoke:async(...args)=>{calls.push(args);throw Error("captured before actual launch");},terminal:{current:null},projectPreview:preview,projectLaunchEdits:edits,projectTemplate:"",useProjectSettings:true,projectConfigBusy:false};
  const start=new Function(...Object.keys(values),code+";return startSession;")(...Object.values(values));await start();
  assert.equal(calls.length,1);assert.equal(calls[0][0],"create_session");
  assert.deepEqual(calls[0][1].projectConfig,{root:preview.root,template:null,overrides:edits});
  assert.equal(calls[0][1].launch,null);assert.equal(calls[0][1].command,null);
 }
});

test("T09 actual preview component presents trust and cancel without a launch action",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript");let source="";
 try{source=await fs.readFile(new URL("../src/ProjectConfigPreview.tsx",import.meta.url),"utf8");}catch{}
 const tree=ts.default.createSourceFile("ProjectConfigPreview.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let found;
 const visit=n=>{if(ts.default.isFunctionDeclaration(n)&&n.name?.text==="ProjectConfigPreview")found=n.getText(tree);ts.default.forEachChild(n,visit);};visit(tree);
 const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
 const render=found?new Function("React",ts.default.transpile(found.replace("export ",""),{jsx:ts.default.JsxEmit.React,target:ts.default.ScriptTarget.ES2022})+";return ProjectConfigPreview;")(React):()=>null;
 const calls=[],p={root:"/fixture",identity:"device:inode",source:"bytes",trusted:false,config:{version:1,defaults:{adapter:"custom",command:"touch never-execute",env:{TARGET:"OWNER_REFERENCE"}},templates:[]}};
 const nodes=[];const walk=n=>{if(n&&typeof n==="object"){nodes.push(n);for(const child of n.children??[])if(Array.isArray(child))child.forEach(walk);else walk(child);}};
 walk(render({preview:p,busy:false,error:null,template:"",onTemplate:()=>{},onPreview:()=>calls.push("preview"),onTrust:()=>calls.push("trust"),onCancel:()=>calls.push("cancel")}));
 const text=n=>(n?.children??[]).map(x=>typeof x==="string"?x:text(x)).join("");
 const trust=nodes.find(n=>n.type==="button"&&text(n).includes("Trust"));assert.ok(trust,"Actual UI offers explicit trust");assert.deepEqual(calls,[]);trust.props.onClick();
 const cancel=nodes.find(n=>n.type==="button"&&text(n).includes("Cancel"));assert.ok(cancel);cancel.props.onClick();assert.deepEqual(calls,["trust","cancel"]);
 assert.ok(!nodes.some(n=>n.type==="button"&&/Start|Launch/.test(text(n))));
});

test("T09 actual App title uses the owner project command instead of stale manual defaults",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript"),app=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
 const body=app.slice(app.indexOf("  async function startSession("),app.indexOf("  async function stopSession("));const code=ts.default.transpile(app.slice(app.indexOf("  function cancelLayoutRestore("),app.indexOf("  function terminalPaneVisible("))+body,{target:ts.default.ScriptTarget.ES2022});let titles={};
 const preview={root:"/trusted/project",identity:"root",source:"exact",trusted:true,config:{version:1,defaults:{adapter:"custom",command:"new"},templates:[]}};
 const next={session_id:"s-project",cwd:preview.root,status:"running",command:"new",launch:null};
 const values={layoutRestore:{current:{version:0,pending:false}},setLayoutRestoreReady(){},starting:false,creatingSession:{current:false},terminalViews:{current:new TerminalViews(16)},setError:()=>{},adapters:[{id:"codex",label:"Codex",available:true}],selectedAdapter:"codex",command:"old",cwd:preview.root,prompt:"",adapterArgs:"",launchMode:"interactive",setStarting:()=>{},invoke:async()=>next,terminal:{current:null},projectPreview:preview,projectLaunchEdits:{},projectTemplate:"",useProjectSettings:true,projectConfigBusy:false,setActiveProject:()=>{},setCollapsedProjects:()=>{},projectKey:v=>v,setSessionTitles:f=>{titles=f(titles);},launchDialog:{current:{close:()=>{}}},openHistory:async()=>{},refreshHistory:async()=>{}};
 const start=new Function(...Object.keys(values),code+";return startSession;")(...Object.values(values));await start();assert.equal(titles["s-project"],"new");
});


async function actualProjectCallbacksHarness(){
 const fs=await import("node:fs/promises"),ts=await import("typescript"),source=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8");
 const tree=ts.default.createSourceFile("App.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let app;
 for(const node of tree.statements)if(ts.default.isFunctionDeclaration(node)&&node.name?.text==="App")app=node;
 assert.ok(app?.body);
 const functions=app.body.statements.filter(n=>ts.default.isFunctionDeclaration(n)&&["cancelProjectPreview","readProjectConfig","approveProjectConfig"].includes(n.name?.text)).map(n=>n.getText(tree));
 const cwdEffect=app.body.statements.find(n=>ts.default.isExpressionStatement(n)&&ts.default.isCallExpression(n.expression)&&n.expression.expression.getText(tree)==="useEffect"&&n.expression.arguments[1]?.getText(tree)==="[cwd]");
 assert.ok(cwdEffect,"Actual cwd cancellation effect is exercised");
 const code=ts.default.transpile(functions.join("\n")+"\nconst changeCwd="+cwdEffect.expression.arguments[0].getText(tree)+";",{target:ts.default.ScriptTarget.ES2022});
 const selection={current:new config.ProjectConfigSelection()},generation={current:0},state={preview:null,use:false,template:"",busy:false,error:null},writes=[];
 const queue=[];const invoke=(name,args)=>new Promise((resolve,reject)=>queue.push({name,args,resolve,reject}));
 const bind=cwd=>{const values={cwd,projectSelection:selection,projectConfigVersion:generation,setProjectPreview:v=>{state.preview=v;writes.push(["preview",v]);},setUseProjectSettings:v=>{state.use=v;writes.push(["use",v]);},setProjectTemplate:v=>{state.template=v;writes.push(["template",v]);},setProjectConfigBusy:v=>{state.busy=v;writes.push(["busy",v]);},setProjectConfigError:v=>{state.error=v;writes.push(["error",v]);},invoke};return new Function(...Object.keys(values),code+";return {readProjectConfig,approveProjectConfig,cancelProjectPreview,changeCwd};")(...Object.values(values));};
 const preview=root=>({root,identity:root,source:root,trusted:true,config:{version:1,templates:[{name:"Chosen",adapter:"shell"}]}});
 return {state,writes,queue,bind,preview,selection};
}

test("T09 actual App read callback ignores stale success, error and finally across cwd and cancel",async t=>{
 for(const outcome of ["success","error"])await t.test(outcome,async()=>{
  const h=await actualProjectCallbacksHarness(),a=h.bind("/A"),old=a.readProjectConfig();assert.equal(h.queue[0].args.cwd,"/A");
  const b=h.bind("/B");b.changeCwd();const next=b.readProjectConfig();h.queue[1].resolve(h.preview("/B"));await next;
  h.state.template="Chosen";h.state.use=false;const before=h.writes.length;
  if(outcome==="success")h.queue[0].resolve(h.preview("/A"));else h.queue[0].reject(Error("late A failure"));await old;
  assert.deepEqual({template:h.state.template,use:h.state.use,root:h.state.preview?.root,error:h.state.error},{template:"Chosen",use:false,root:"/B",error:null});
  assert.equal(h.writes.length,before,"Stale read success/error/finally must make no App state writes");
 });
 await t.test("cancel retains newer busy state",async()=>{
  const h=await actualProjectCallbacksHarness(),a=h.bind("/A"),old=a.readProjectConfig();a.cancelProjectPreview();const b=h.bind("/B"),next=b.readProjectConfig();
  h.queue[0].reject(Error("late canceled error"));await old;assert.equal(h.state.busy,true,"Old finally cannot clear a newer pending read");assert.equal(h.state.preview,null);assert.equal(h.state.error,null);
  h.queue[1].resolve(h.preview("/B"));await next;assert.equal(h.state.preview.root,"/B");
 });
});

test("T09 actual App approve callback shares cancellation generation with reads and cwd",async t=>{
 for(const outcome of ["success","error"])await t.test(outcome,async()=>{
  const h=await actualProjectCallbacksHarness(),a=h.bind("/A"),initial=a.readProjectConfig();h.queue[0].resolve(h.preview("/A"));await initial;
  const old=a.approveProjectConfig();assert.equal(h.queue[1].name,"trust_project_config");a.cancelProjectPreview();const b=h.bind("/B");b.changeCwd();const next=b.readProjectConfig();const before=h.writes.length;
  if(outcome==="success")h.queue[1].resolve(h.preview("/A"));else h.queue[1].reject(Error("late approval failure"));await old;
  assert.equal(h.state.busy,true,"Old approve finally cannot clear newer read busy");assert.equal(h.state.preview,null);assert.equal(h.state.error,null);assert.equal(h.writes.length,before,"Canceled approval must make no App state writes");assert.equal(h.selection.current.approved,null);
  h.queue[2].resolve(h.preview("/B"));await next;assert.equal(h.state.preview.root,"/B");
 });
});
