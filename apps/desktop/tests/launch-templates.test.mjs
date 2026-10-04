import assert from "node:assert/strict";
import {test} from "node:test";
import * as templates from "../src/launch-templates.ts";
import {resolveLaunchDefaults} from "../src/project-config.ts";

const stored = (overrides={}) => ({id:"11111111-1111-4111-8111-111111111111",name:"My template",adapter:"codex",mode:"interactive",extra_args:"--safe",prompt:"hello",command:null,...overrides});
const defaults = {adapter:"codex",mode:"interactive",extra_args:"",prompt:null,command:null};
const memoryStorage = (initial=null, fail=false) => ({value:initial,fail,writes:[],getItem(){return this.value;},setItem(key,value){this.writes.push([key,value]);if(this.fail)throw Error("quota");this.value=value;}});

test("F4 real resolver projection strips trusted project secret env, cwd, names and runtime extras",()=>{
 const resolved=resolveLaunchDefaults(defaults,{adapter:"claude",mode:"interactive",extra_args:"",prompt:"project",command:null,env:{TOKEN:"SECRET_SENTINEL"},cwd:"/trusted/project",template_name:"runtime",runtime:{token:"extra"}},{});
 const projected=templates.projectLaunchFields(resolved);
 assert.deepEqual(projected,{adapter:"claude",mode:"interactive",extra_args:"",prompt:"project",command:null});
 const template=templates.createLaunchTemplate("  Exact Name  ",resolved,()=>"22222222-2222-4222-8222-222222222222");
 assert.deepEqual(template,stored({id:"22222222-2222-4222-8222-222222222222",name:"Exact Name",adapter:"claude",extra_args:"",prompt:"project"}));
 const raw=templates.encodeLaunchTemplates([template]);
 for(const secret of ["SECRET_SENTINEL","/trusted/project","runtime","TOKEN"])assert.equal(raw.includes(secret),false);
});

test("F4 exact version-1 collection schema round trips and rejects unknown, inherited, or malformed data",()=>{
 const record=stored({name:"My template"}),raw=JSON.stringify({version:1,templates:[record]});
 assert.deepEqual(templates.decodeLaunchTemplates(raw),[record]);
 for(const invalid of [
  JSON.stringify({version:2,templates:[record]}),
  JSON.stringify({version:1,templates:[{...record,cwd:"/secret"}]}),
  JSON.stringify({version:1,templates:[{...record,id:"UPPERCASE"}]}),
  JSON.stringify({version:1,templates:[{...record,name:"   "}]}),
  JSON.stringify({version:1,templates:[{...record,env:{TOKEN:"secret"}}]}),
  '{"version":1,"templates":[{"__proto__":{"polluted":true}}]}',
 ])assert.throws(()=>templates.decodeLaunchTemplates(invalid));
 assert.equal(templates.MAX_LAUNCH_TEMPLATES,32);
});

test("F4 codec rejects serialization hooks, prototypes, accessors, sparse arrays and extra array keys",()=>{
 const row=stored({name:"Valid"});
 const inherited=stored({name:"Inherited"});Object.setPrototypeOf(inherited,{toJSON(){return {...this,env:{TOKEN:"SYNTHETIC_BOUNDARY"}};}});
 const hidden=stored({name:"Hidden"});Object.defineProperty(hidden,"toJSON",{value(){return {...this,env:{TOKEN:"SYNTHETIC_BOUNDARY"}};}});
 const accessor=stored({name:"Accessor"});Object.defineProperty(accessor,"prompt",{enumerable:true,get(){return "SYNTHETIC_BOUNDARY";}});
 for(const malformed of [inherited,hidden,accessor])assert.throws(()=>templates.encodeLaunchTemplates([malformed]));
 const sparse=new Array(1);assert.throws(()=>templates.encodeLaunchTemplates(sparse));
 const arrayHook=[row];Object.defineProperty(arrayHook,"toJSON",{value(){return [{env:{TOKEN:"SYNTHETIC_BOUNDARY"}}];}});assert.throws(()=>templates.encodeLaunchTemplates(arrayHook));
 const customArrayPrototype=[row];Object.setPrototypeOf(customArrayPrototype,{toJSON(){return [null];}});assert.throws(()=>templates.encodeLaunchTemplates(customArrayPrototype));
 const extraArrayKey=[row];extraArrayKey.unexpected=true;assert.throws(()=>templates.encodeLaunchTemplates(extraArrayKey));
 const extraHidden=stored({name:"Hidden extra"});Object.defineProperty(extraHidden,"runtime",{value:"SYNTHETIC_BOUNDARY"});assert.throws(()=>templates.encodeLaunchTemplates([extraHidden]));
 const roundtrip=templates.encodeLaunchTemplates([row]);assert.deepEqual(templates.decodeLaunchTemplates(roundtrip),[row]);
});

test("F4 bounds raw storage before parsing and persisted UTF-16 fields at 65536 units",()=>{
 const tooLong="{".repeat(templates.MAX_LAUNCH_TEMPLATE_STORAGE_CODE_UNITS+1);
 assert.throws(()=>templates.decodeLaunchTemplates(tooLong),/size|large|limit/i);
 for(const field of ["extra_args","prompt","command"]){
  const value=stored({[field]:"x".repeat(65537)});
  assert.throws(()=>templates.encodeLaunchTemplates([value]),/length|size|limit/i);
 }
 assert.throws(()=>templates.encodeLaunchTemplates(Array.from({length:33},(_,i)=>stored({id:`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`,name:`name ${i}`}))));
});

test("F4 names trim outside whitespace, count Unicode codepoints, preserve case and exact interior text",()=>{
 const astral="😀".repeat(80);assert.equal([...templates.normalizeTemplateName(` ${astral} `)].length,80);
 assert.throws(()=>templates.normalizeTemplateName(" ".repeat(1)),/name/i);
 assert.throws(()=>templates.normalizeTemplateName("😀".repeat(81)),/name/i);
 assert.equal(templates.normalizeTemplateName("  Mixed Case  "),"Mixed Case");
 assert.notEqual(templates.normalizeTemplateName("Mixed Case"),templates.normalizeTemplateName("mixed case"));
});

test("F4 save and update enforce exact trimmed-name uniqueness and preserve existing records on invalid input",()=>{
 const first=stored({name:"First"}),second=stored({id:"22222222-2222-4222-8222-222222222222",name:"Second"});
 assert.throws(()=>templates.saveTemplate([first,second]," First ",defaults,()=>"33333333-3333-4333-8333-333333333333"),/name/i);
 assert.throws(()=>templates.updateTemplate([first,second],"missing","Renamed",defaults),/selected|missing|template/i);
 const next=templates.updateTemplate([first,second],second.id,"  Renamed  ",defaults);
 assert.equal(next[0],first);assert.equal(next[1].name,"Renamed");
});

test("F4 create rejects duplicate canonical UUID without dropping saved entries",()=>{
 const first=stored({name:"First"});
 assert.throws(()=>templates.saveTemplate([first],"Second",defaults,()=>first.id),/id|collision/i);
 assert.deepEqual([first],[first]);
});

test("F4 duplicate allocates a unique UUID and bounded codepoint-safe copy suffix",()=>{
 const source=stored({name:"😀".repeat(80)}),occupied=stored({id:"22222222-2222-4222-8222-222222222222",name:`${"😀".repeat(73)} (copy)`});let tries=0;
 const copies=templates.duplicateTemplate([source,occupied],source.id,()=>{tries++;return "33333333-3333-4333-8333-333333333333";});
 assert.equal(tries,1);assert.equal(copies.length,3);assert.notEqual(copies[2].id,source.id);assert.equal([...copies[2].name].length,80);assert.match(copies[2].name,/\(copy 2\)$/);
});

test("F4 duplicate enforces max-count without dropping records",()=>{
 const full=Array.from({length:32},(_,i)=>stored({id:`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`,name:`name ${i}`}));
 assert.throws(()=>templates.duplicateTemplate(full,full[0].id,()=>"33333333-3333-4333-8333-333333333333"),/limit|32|maximum/i);
 assert.equal(full.length,32);
});

test("F4 stale selection and missing delete target cannot retarget or remove another row",()=>{
 const rows=[stored({name:"First"}),stored({id:"22222222-2222-4222-8222-222222222222",name:"Second"})];
 assert.throws(()=>templates.deleteTemplate(rows,"stale-id"),/selected|missing|template/i);
 assert.throws(()=>templates.updateTemplate(rows,"stale-id","Changed",defaults),/selected|missing|template/i);
 assert.deepEqual(rows.map(x=>x.name),["First","Second"]);
});

test("F4 collection mount handles missing/corrupt storage without autosaving",()=>{
 for(const raw of [null,"not-json",JSON.stringify({version:1,templates:[{...stored(),cwd:"/wrong"}]})]){
  const storage=memoryStorage(raw),collection=new templates.LaunchTemplateCollection(storage);
  collection.load();assert.equal(storage.writes.length,0);assert.deepEqual(collection.templates,[]);assert.equal(collection.selectedId,null);
 }
});

test("F4 persistence commits CRUD and selected identity only after setItem succeeds",()=>{
 let serial=2;const storage=memoryStorage(),collection=new templates.LaunchTemplateCollection(storage,()=>`${String(serial++).repeat(8).slice(0,8)}-3333-4333-8333-333333333333`);
 collection.load();const created=collection.save("Saved",defaults);assert.equal(collection.templates[0].id,created.id);assert.equal(collection.selectedId,created.id);assert.equal(collection.writeError,null);
 collection.update(created.id,"Updated",{...defaults,prompt:"new"});assert.equal(collection.templates[0].name,"Updated");
 collection.duplicate(created.id);assert.equal(collection.templates.length,2);
 collection.delete(collection.templates[1].id);assert.equal(collection.templates.length,1);assert.equal(collection.selectedId,null);
 assert.equal(storage.writes.length,4);
});

test("F4 write failure retains committed collection, selection and user form, and selection/apply retain error",()=>{
 const raw=templates.encodeLaunchTemplates([stored({name:"Committed"})]),storage=memoryStorage(raw,true),collection=new templates.LaunchTemplateCollection(storage,()=>"22222222-2222-4222-8222-222222222222");
 collection.load();collection.select("11111111-1111-4111-8111-111111111111");const before=collection.templates;
 assert.throws(()=>collection.save("New",{...defaults,prompt:"unsaved current form"}));
 assert.equal(collection.templates,before);assert.equal(collection.selectedId,"11111111-1111-4111-8111-111111111111");assert.equal(collection.writeError,"Could not save launch templates.");
 collection.select("11111111-1111-4111-8111-111111111111");assert.equal(collection.writeError,"Could not save launch templates.");
 collection.apply();assert.equal(collection.writeError,"Could not save launch templates.");
});

test("F4 only a successful explicit persistence clears a retained storage error",()=>{
 const storage=memoryStorage(null,true),collection=new templates.LaunchTemplateCollection(storage,()=>"33333333-3333-4333-8333-333333333333");collection.load();
 assert.throws(()=>collection.save("First",defaults));assert.ok(collection.writeError);storage.fail=false;
 collection.select(null);collection.apply();assert.ok(collection.writeError);
 const created=collection.save("First",defaults);assert.equal(collection.writeError,null);assert.equal(collection.selectedId,created.id);
});

test("F4 actual component exposes explicit non-submit CRUD and Apply buttons and disables them while starting",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript"),source=await fs.readFile(new URL("../src/LaunchTemplates.tsx",import.meta.url),"utf8");
 const tree=ts.default.createSourceFile("LaunchTemplates.tsx",source,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let component;
 for(const node of tree.statements)if(ts.default.isFunctionDeclaration(node)&&node.name?.text==="LaunchTemplates")component=node.getText(tree);
 assert.ok(component,"LaunchTemplates component exists");
 const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
 const render=new Function("React",ts.default.transpile(component.replace("export ",""),{jsx:ts.default.JsxEmit.React,target:ts.default.ScriptTarget.ES2022})+";return LaunchTemplates;")(React);
 for(const starting of [false,true]){
  const calls=[],tree=render({templates:[stored({name:"Visible"})],selectedId:stored().id,writeError:null,starting,onSelect:id=>calls.push(["select",id]),onSave:()=>calls.push(["save"]),onUpdate:()=>calls.push(["update"]),onDuplicate:()=>calls.push(["duplicate"]),onDelete:()=>calls.push(["delete"]),onApply:value=>calls.push(["apply",value.id])});
  const nodes=[];const walk=n=>{if(n&&typeof n==="object"){nodes.push(n);for(const child of n.children??[])if(Array.isArray(child))child.forEach(walk);else walk(child);}};walk(tree);
  for(const label of ["Select template","Save current","Update selected","Duplicate selected","Delete selected","Apply selected"]){const button=nodes.find(n=>n.type==="button"&&String(n.props["aria-label"]??n.children?.[0]??"").includes(label));assert.ok(button,`actual ${label} button exists`);assert.equal(button.props.type,"button");assert.equal(Boolean(button.props.disabled),starting);if(!starting)button.props.onClick();}
  const renderedText=n=>(n?.children??[]).map(child=>typeof child==="string"?child:Array.isArray(child)?child.map(renderedText).join(""):renderedText(child)).join("");
  assert.match(renderedText(tree),/stored as plain text on this device/i);assert.match(renderedText(tree),/Prompts, custom commands, and CLI arguments are not encrypted/i);
  if(!starting)assert.deepEqual(calls.map(x=>x[0]),["select","save","update","duplicate","delete","apply"]);else assert.deepEqual(calls,[]);
 }
});

test("F4 actual App Apply callback changes five launch fields and preserves cwd/project/environment state",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript"),app=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8"),tree=ts.default.createSourceFile("App.tsx",app,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let fn;
 const visit=n=>{if(ts.default.isFunctionDeclaration(n)&&n.name?.text==="applyLaunchTemplate")fn=n.getText(tree);ts.default.forEachChild(n,visit);};visit(tree);assert.ok(fn,"actual App Apply callback exists");
 const values={setSelectedAdapter:v=>state.adapter=v,setLaunchMode:v=>state.mode=v,setAdapterArgs:v=>state.extra_args=v,setPrompt:v=>state.prompt=v,setCommand:v=>state.command=v,setProjectLaunchEdits:update=>state.projectLaunchEdits=update(state.projectLaunchEdits)};const state={cwd:"/trusted/project",env:{TOKEN:"OWNER_SECRET"},projectPreview:{root:"/trusted/project"},useProjectSettings:true,projectLaunchEdits:{},adapter:"old",mode:"old",extra_args:"old",prompt:"old",command:"old"};
 new Function(...Object.keys(values),ts.default.transpile(fn,{target:ts.default.ScriptTarget.ES2022})+";return applyLaunchTemplate;")(...Object.values(values))(stored({command:""}));
 assert.deepEqual({adapter:state.adapter,mode:state.mode,extra_args:state.extra_args,prompt:state.prompt,command:state.command},{adapter:"codex",mode:"interactive",extra_args:"--safe",prompt:"hello",command:""});
 assert.equal(state.cwd,"/trusted/project");assert.deepEqual(state.env,{TOKEN:"OWNER_SECRET"});assert.deepEqual(state.projectPreview,{root:"/trusted/project"});assert.equal(state.useProjectSettings,true);
 assert.deepEqual(state.projectLaunchEdits,{adapter:"codex",mode:"interactive",extra_args:"--safe",prompt:"hello",command:""});
 const body=app.slice(app.indexOf("function applyLaunchTemplate("),app.indexOf("function ",app.indexOf("function applyLaunchTemplate(")+10));
 assert.doesNotMatch(body,/startSession|create_session|take_terminal_control|approveProjectConfig|trust_project_config|cancelProjectPreview|owner/i);
});

test("F4 actual App Save projects real resolved trusted defaults before storage and masks write failures",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript"),app=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8"),tree=ts.default.createSourceFile("App.tsx",app,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let save;
 const visit=n=>{if(ts.default.isFunctionDeclaration(n)&&n.name?.text==="saveLaunchTemplate")save=n.getText(tree);ts.default.forEachChild(n,visit);};visit(tree);assert.ok(save,"actual App Save callback exists");
 const resolved=resolveLaunchDefaults(defaults,{adapter:"claude",mode:"interactive",extra_args:"",prompt:"trusted",command:"",env:{TOKEN:"SAVE_SECRET"},cwd:"/project",template_name:"project-only"},{});
 assert.match(app,/<LaunchTemplates[^>]*templates=\{launchTemplateCollection\.templates\}[^>]*onApply=\{applyLaunchTemplate\}/s,"actual launch dialog wires persisted rows and Apply callback");
 assert.match(app,/onSave=\{saveLaunchTemplate\}[^>]*onUpdate=\{updateLaunchTemplate\}/s,"actual component wires explicit CRUD callbacks");
 const storage=memoryStorage(),collection=new templates.LaunchTemplateCollection(storage,()=>"22222222-2222-4222-8222-222222222222"),state={actionError:null,revision:0};
 const invokeSave=()=>new Function("launchTemplateCollection","launchTemplateName","formLaunch","setLaunchTemplateActionError","refreshLaunchTemplateUi",ts.default.transpile(save,{target:ts.default.ScriptTarget.ES2022})+";return saveLaunchTemplate;")(collection,"Trusted",resolved,value=>state.actionError=value,()=>state.revision++)();
 invokeSave();assert.deepEqual(collection.templates,[stored({id:"22222222-2222-4222-8222-222222222222",name:"Trusted",adapter:"claude",extra_args:"",prompt:"trusted",command:""})]);
 assert.equal(storage.value.includes("SAVE_SECRET"),false);assert.equal(storage.value.includes("/project"),false);assert.equal(storage.value.includes("project-only"),false);
 const failing=memoryStorage(null,true),failedCollection=new templates.LaunchTemplateCollection(failing,()=>"33333333-3333-4333-8333-333333333333"),failureState={actionError:null,revision:0};
 new Function("launchTemplateCollection","launchTemplateName","formLaunch","setLaunchTemplateActionError","refreshLaunchTemplateUi","handleLaunchTemplateError",ts.default.transpile(save,{target:ts.default.ScriptTarget.ES2022})+";return saveLaunchTemplate;")(failedCollection,"Trusted",resolved,value=>failureState.actionError=value,()=>failureState.revision++,reason=>{failureState.actionError=failedCollection.writeError?null:String(reason);failureState.revision++;})();
 assert.equal(failedCollection.templates.length,0);assert.equal(failedCollection.writeError,"Could not save launch templates.");assert.equal(failureState.actionError,null);
 const saveDefaults=app.slice(app.indexOf("async function saveLaunchDefaults()"),app.indexOf("const [session",app.indexOf("async function saveLaunchDefaults()")));
 assert.match(saveDefaults,/set_launch_defaults/);assert.doesNotMatch(saveDefaults,/yam\.launchTemplates|launchTemplateCollection/);
});

test("F4 actual App defers denied localStorage access and preserves state on explicit persistence failure",async()=>{
 const fs=await import("node:fs/promises"),ts=await import("typescript"),app=await fs.readFile(new URL("../src/App.tsx",import.meta.url),"utf8"),tree=ts.default.createSourceFile("App.tsx",app,ts.default.ScriptTarget.Latest,true,ts.default.ScriptKind.TSX);let initializer,update,errorHandler;
 const visit=n=>{
  if(ts.default.isVariableDeclaration(n)&&n.name.getText(tree)==="[launchTemplateCollection]"&&n.initializer&&ts.default.isCallExpression(n.initializer))initializer=n.initializer.arguments[0].getText(tree);
  if(ts.default.isFunctionDeclaration(n)&&n.name?.text==="updateLaunchTemplate")update=n.getText(tree);
  if(ts.default.isFunctionDeclaration(n)&&n.name?.text==="handleLaunchTemplateError")errorHandler=n.getText(tree);
  ts.default.forEachChild(n,visit);
 };visit(tree);assert.ok(initializer&&update&&errorHandler,"actual App initializer and persistence callbacks exist");
 const initialize=new Function("LaunchTemplateCollection",ts.default.transpile("const init="+initializer+";",{target:ts.default.ScriptTarget.ES2022})+";return init;")(templates.LaunchTemplateCollection);
 const previous=Object.getOwnPropertyDescriptor(globalThis,"localStorage");let getterCalls=0;
 Object.defineProperty(globalThis,"localStorage",{configurable:true,get(){getterCalls++;throw Error("denied");}});
 try{let collection;assert.doesNotThrow(()=>{collection=initialize();});assert.deepEqual(collection.templates,[]);assert.equal(collection.writeError,null);assert.equal(getterCalls,1,"only the read path is attempted during mount; no write occurs");}
 finally{if(previous)Object.defineProperty(globalThis,"localStorage",previous);else delete globalThis.localStorage;}
 const id="11111111-1111-4111-8111-111111111111",saved=stored({name:"Committed"}),storage=memoryStorage(templates.encodeLaunchTemplates([saved]),true),collection=new templates.LaunchTemplateCollection(storage);collection.load();collection.select(id);const oldRows=collection.templates,currentForm={adapter:"claude",mode:"task",extra_args:"typed",prompt:"form kept",command:null},state={actionError:null,revision:0},templateName="Edited";
 const handle=new Function("launchTemplateCollection","setLaunchTemplateActionError","refreshLaunchTemplateUi",ts.default.transpile(errorHandler,{target:ts.default.ScriptTarget.ES2022})+";return handleLaunchTemplateError;")(collection,value=>state.actionError=value,()=>state.revision++);
 new Function("launchTemplateCollection","launchTemplateName","formLaunch","setLaunchTemplateActionError","refreshLaunchTemplateUi","handleLaunchTemplateError",ts.default.transpile(update,{target:ts.default.ScriptTarget.ES2022})+";return updateLaunchTemplate;")(collection,templateName,currentForm,value=>state.actionError=value,()=>state.revision++,handle)();
 assert.equal(collection.templates,oldRows);assert.equal(collection.selectedId,id);assert.equal(collection.writeError,"Could not save launch templates.");assert.equal(state.actionError,null);assert.equal(templateName,"Edited");assert.deepEqual(currentForm,{adapter:"claude",mode:"task",extra_args:"typed",prompt:"form kept",command:null});
});
