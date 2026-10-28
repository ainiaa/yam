import {englishUiReadAsync} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import {componentFunction} from './fixtures/component-function.mjs';
import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import ts from "typescript";
import {parseUnifiedDiff,findDiffLine} from '../src/git-diff-navigation.ts';

test("F3 actual App exposes a read-only Git changes entry bound to current directory and owner", async () => {
  const source = await englishUiReadAsync(fs.readFile,new URL("../src/App.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements = [];
  const visit = node => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "GitChanges") elements.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  assert.equal(elements.length, 1, "actual App must render the Git changes component");
  const attrs = new Map(elements[0].attributes.properties.map(x => [x.name?.getText(tree), x.initializer?.getText(tree)]));
  assert.equal(attrs.get("path"), "{projectToolsPath}");
  assert.equal(attrs.get("owner"), "{gitOwner}");
  assert.equal(attrs.get("sessionId"), "{session&&!session.ssh?session.session_id:null}");
});

import * as git from "../src/git-context.ts";
const token = "12345678-1234-4234-8234-123456789abc";
const row = {path:"file.txt",staged:"M",worktree:"M",untracked:false,unsupported:false};
const result = (args, extra={}) => ({query_token:args.query_token,path:args.path,root:"/repo",rows:[row],patch:null,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test("F3 bounded DTO accepts separate roles and rejects unknown or excessive content",()=>{
  const value=result({path:"/repo",query_token:token});
  assert.equal(git.isGitChanges(value),true);
  for(const bad of [{...value,secret:"PRIVATE"},{...value,rows:Array(4097).fill(row)},{...value,rows:[{...row,path:"../escape"}]},{...value,patch:{path:"file.txt",side:"worktree",kind:"text",text:"x".repeat(262145)}}]) assert.equal(git.isGitChanges(bad),false);
});
test("F3 actual controller sends literal paired selection and validates root before display",async()=>{
  const controller=new git.GitChangesController(()=>token),updates=[],calls=[];controller.select("/repo","owner-a");
  await controller.load(async args=>{calls.push(args);return result(args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"+literal"}});},async()=>{},v=>updates.push(v),{path:"file.txt",side:"staged"},"/repo");
  assert.deepEqual(calls,[{path:"/repo",query_token:token,selected_path:"file.txt",side:"staged"}]);
  assert.equal(updates.at(-1).kind,"ready");assert.equal(updates.at(-1).value.patch.text,"+literal");
});
test("F3 actual controller cancels old scope and retains one in-flight until latest context settles",async()=>{
  for(const fail of [false,true]){
    let seq=0;const controller=new git.GitChangesController(()=>`12345678-1234-4234-8234-${String(++seq).padStart(12,"0")}`),old=deferred(),updates=[],calls=[],cancelled=[];
    controller.select("/A","one");const first=controller.load(args=>{calls.push(args);return old.promise;},async t=>cancelled.push(t),v=>updates.push(v));
    controller.select("/B","two");const latest=controller.load(async args=>{calls.push(args);return result(args,{root:"/B"});},async t=>cancelled.push(t),v=>updates.push(v));
    assert.equal(calls.length,1);assert.deepEqual(cancelled,[calls[0].query_token]);
    if(fail)old.reject(Error("PRIVATE"));else old.resolve(result(calls[0],{root:"/A"}));
    await first;await latest;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,2);assert.equal(updates.at(-1).value.path,"/B");assert.ok(!updates.some(v=>v.kind==="ready"&&v.value.path==="/A"));
  }
});
test("F3 actual controller close invalidates old success error and pending finally",async()=>{
  for(const fail of [false,true]){const c=new git.GitChangesController(()=>token),p=deferred(),updates=[];c.select("/repo","a");const old=c.load(()=>p.promise,async()=>{},v=>updates.push(v));c.cancel();if(fail)p.reject(Error("SECRET"));else p.resolve(result({path:"/repo",query_token:token}));await old;assert.equal(updates.filter(v=>v.kind!=="loading").length,0);}
});
test("F3 actual controller busy exposes explicit retry without automatically repeating",async()=>{
 const c=new git.GitChangesController(()=>token),updates=[];let calls=0;c.select("/repo","a");
 const request=async()=>{calls++;throw "git_busy";};await c.load(request,async()=>{},v=>updates.push(v));
 assert.equal(calls,1);assert.deepEqual(updates.at(-1),{kind:"unavailable",code:"git_busy"});
});

async function componentHarness() {
 const source=await englishUiReadAsync(fs.readFile,new URL("../src/GitChanges.tsx",import.meta.url),"utf8");
 const tree=ts.createSourceFile("GitChanges.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="GitChanges");assert.ok(fn);
 let refreshAction;const slots=[],refs=[],effects=[];let i=0,j=0,k=0;let props={path:"/repo",owner:1},nodes;
 const values={watchProjectRefresh:action=>{refreshAction=action;return()=>{refreshAction=null;};},GitChangesController:git.GitChangesController,GitPatchView:"GitPatchView",FilePreview:"FilePreview",invoke:null,React:{createElement:(tag,props,...children)=>({tag,props:props??{},children:children.flat(Infinity)})},useCallback:fn=>fn,
 useState:initial=>{const n=i++;if(!(n in slots))slots[n]=initial;return [slots[n],v=>{slots[n]=typeof v==="function"?v(slots[n]):v;}];},
 useRef:initial=>{const n=j++;return refs[n]??(refs[n]={current:initial});},
 useEffect:(fn,deps)=>{const n=k++,key=JSON.stringify(deps);if(effects[n]?.key!==key){effects[n]={key,fn,pending:true,cleanup:effects[n]?.cleanup};}}};
 const calls=[],pending=[];
 values.invoke=(name,args)=>{calls.push([name,args]);if(name==="cancel_git_changes")return Promise.resolve({});const d=deferred();pending.push({args,...d});return d.promise;};
 const code=ts.transpileModule(fn.getText(tree).replace("export function","function"),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText+";return GitChanges;";
 const component=componentFunction(...Object.keys(values),code)(...Object.values(values));
 const render=(next,flush=true)=>{if(next)props=next;i=j=k=0;nodes=component(props);if(flush)for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup?.();effect.cleanup=effect.fn();}return nodes;};
 const buttons=()=>{const all=[];const walk=n=>{if(!n||typeof n!=="object")return;if(n.tag==="button")all.push(n);for(const child of n.children??[])walk(child);};walk(nodes);return all;};
 const unmount=()=>effects.forEach(e=>e.cleanup?.());
 return {render,buttons,unmount,calls,pending,slots,refresh:()=>refreshAction?.()};
}
test("F3 actual component opens list and selected-side request then cancels on close",async()=>{
 const h=await componentHarness();h.render();assert.equal(h.calls.length,0);
 const open=h.buttons().find(b=>b.children.includes("Git changes"));assert.ok(open,"visible explicit entry");open.props.onClick();h.render();
 assert.equal(h.calls[0][0],"get_git_changes");const p=h.pending[0];p.resolve(result(p.args));await new Promise(r=>setImmediate(r));h.render();
 const staged=h.buttons().find(b=>b.props["aria-label"]==="Staged changes for file.txt");assert.ok(staged);staged.props.onClick();
 assert.equal(h.pending[1].args.side,"staged");assert.equal(h.pending[1].args.selected_path,"file.txt");
 h.buttons().find(b=>b.children.includes("Close Git changes")).props.onClick();h.render();
 assert.equal(h.calls.at(-1)[0],"cancel_git_changes");
 h.pending[1].resolve(result(h.pending[1].args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"+old"}}));await new Promise(r=>setImmediate(r));h.render();
 assert.ok(!JSON.stringify(h.slots).includes("+old"));h.unmount();
});

async function patchHarness(patch,callbacks={}) {
 const raw=await englishUiReadAsync(fs.readFile,new URL('../src/GitChanges.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('GitChanges.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='GitPatchView');assert.ok(fn,'actual diff navigation component required');
 const slots=[],focused=[];let i=0,tree;const root={querySelector:selector=>({focus:()=>focused.push(selector),scrollIntoView(){}})};
 const values={parseUnifiedDiff,findDiffLine,useMemo:fn=>fn(),useRef:()=>({current:root}),useState:initial=>{const at=i++;if(!(at in slots))slots[at]=initial;return [slots[at],value=>slots[at]=typeof value==='function'?value(slots[at]):value];},React:{createElement:(tag,props,...children)=>({tag,props:props??{},children:children.flat(Infinity)})}};
 const render=componentFunction(...Object.keys(values),ts.transpileModule(fn.getText(source).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ESNext}}).outputText+';return GitPatchView;')(...Object.values(values));
 const nodes=node=>[node,...(node?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child):[])];
 const refresh=()=>{i=0;tree=render({patch,...callbacks});};refresh();
 return {refresh,focused,rows:()=>nodes(tree).filter(node=>node.props?.["data-diff-row"]!==undefined),updatePatch:next=>{patch=next;refresh();},button:label=>nodes(tree).find(node=>node.tag==='button'&&node.children.join('')===label),control:label=>nodes(tree).find(node=>node.props?.['aria-label']===label),get text(){return nodes(tree).flatMap(node=>node.children??[]).filter(child=>typeof child==='string').join(' ');}};
}

test('R2B Git untracked names require separate preview; stale row callbacks cannot cross scope',async()=>{
 const h=await componentHarness();h.render({path:'/repo',owner:1,sessionId:'s-one'});h.buttons().find(b=>b.children.includes('Git changes')).props.onClick();h.render();const p=h.pending[0];p.resolve(result(p.args,{rows:[{path:'untracked.html',staged:' ',worktree:' ',untracked:true,unsupported:false}]}));await new Promise(r=>setImmediate(r));h.render();
 const nodes=n=>[n,...(n?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 assert.equal(h.calls.length,1);const button=h.buttons().find(b=>b.props['aria-label']==='Preview current file untracked.html');assert.ok(button);button.props.onClick();let preview=nodes(h.render()).find(n=>n.tag==='FilePreview');assert.deepEqual(preview.props.request.target,{sessionId:'s-one',path:'/repo/untracked.html'});
 const switched=h.render({path:'/other',owner:2,sessionId:'s-two'},false);assert.equal(nodes(switched).find(n=>n.tag==='FilePreview').props.request,undefined);button.props.onClick();preview=nodes(h.render()).find(n=>n.tag==='FilePreview');assert.equal(preview.props.request,undefined);h.unmount();
});
test('R2B Git close and reopen do not replay prior file request or remount its serializer',async()=>{
 const h=await componentHarness();h.render({path:'/repo',owner:1,sessionId:'s-one'});h.buttons().find(b=>b.children.includes('Git changes')).props.onClick();h.render();let p=h.pending[0];p.resolve(result(p.args));await new Promise(r=>setImmediate(r));h.render();h.buttons().find(b=>b.props['aria-label']==='Preview current file file.txt').props.onClick();
 const nodes=n=>[n,...(n?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 let preview=nodes(h.render()).find(n=>n.tag==='FilePreview');assert.ok(preview.props.request);const key=preview.props.key;
 h.buttons().find(b=>b.children.includes('Close Git changes')).props.onClick();h.render();h.buttons().find(b=>b.children.includes('Git changes')).props.onClick();preview=nodes(h.render()).find(n=>n.tag==='FilePreview');assert.equal(preview.props.request,undefined);assert.equal(key,undefined,'serializer must survive scope switches');h.unmount();
});

test('R2A actual diff component exposes keyboard buttons, both line sides and bounded row focus',async()=>{
 const h=await patchHarness({path:'a name.txt',side:'staged',kind:'text',text:'@@ -1 +1 @@\n-old\n+new\n@@ -8 +8 @@\n-before\n+after\n'});
 assert.match(h.text,/HEAD/);assert.match(h.text,/index/);assert.equal(h.button('Previous change').props.disabled,true);assert.equal(h.button('Next change').props.disabled,false);
 h.button('Next change').props.onClick();h.refresh();assert.equal(h.button('Next change').props.disabled,true);assert.ok(h.focused.at(-1).includes('3'));
 h.control('Diff line number').props.onChange({target:{value:'1'}});h.refresh();h.control('Diff line side').props.onChange({target:{value:'old'}});h.refresh();h.button('Go to line').props.onClick();h.refresh();assert.ok(h.focused.at(-1).includes('1'));
 h.control('Diff line number').props.onChange({target:{value:'4'}});h.refresh();h.button('Go to line').props.onClick();h.refresh();assert.match(h.text,/not included/);
});

test('R2A actual diff component keeps malformed text literal and labels working tree separately',async()=>{
 const h=await patchHarness({path:'<script>.txt',side:'worktree',kind:'text',text:'@@ malformed\n<script>literal</script>'});assert.match(h.text,/working tree/i);assert.match(h.text,/<script>literal<\/script>/);assert.equal(h.button('Next change'),undefined);assert.match(h.text,/Line navigation unavailable/);
 const empty=await patchHarness({path:'mode.txt',side:'staged',kind:'text',text:'old mode 100644\nnew mode 100755\n'});assert.match(empty.text,/No change blocks/);
});
test("F3 actual component owner change and unmount fence late success and errors",async()=>{
 for(const failed of [false,true]){
  const h=await componentHarness();h.render();h.buttons().find(b=>b.children.includes("Git changes")).props.onClick();h.render();
  const old=h.pending[0];h.render({path:"/other",owner:2});assert.equal(h.pending.length,1);
  if(failed)old.reject(Error("SECRET"));else old.resolve(result(old.args));await new Promise(r=>setImmediate(r));
  assert.equal(h.pending.length,2);const current=h.pending[1];h.unmount();current.resolve(result(current.args,{root:"/other"}));await new Promise(r=>setImmediate(r));
  assert.ok(!h.slots.some(v=>v?.kind==="ready"));
 }
});

// Tauri's default argument case is camelCase. The actual component uses the fixed
// snake_case semantic RPC DTO, so both public adapters explicitly preserve it.
test("F3 actual Tauri adapters preserve the component's snake_case argument contract", async () => {
  const source = await englishUiReadAsync(fs.readFile,new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const name of ["get_git_changes", "cancel_git_changes"]) {
    const declaration = source.match(new RegExp('#\\[tauri::command(?:\\([^\\)]*\\))?\\]\\s*async fn ' + name + '\\('));
    assert.ok(declaration, `actual async adapter ${name}`);
    assert.ok(declaration[0].includes('rename_all = "snake_case"'), `${name} must read the exact component argument names`);
  }
});

test("F3 actual component hides every old scope state before passive effects and resumes the latest query", async () => {
  for (const phase of ["ready", "error", "loading"]) {
    for (const next of [{path:"/other",owner:1}, {path:"/repo",owner:2}]) {
      const h = await componentHarness();h.render();h.buttons().find(b=>b.children.includes("Git changes")).props.onClick();h.render();
      const old = h.pending[0];
      if (phase === "ready") old.resolve(result(old.args,{patch:null}));
      if (phase === "error") old.reject("git_missing");
      if (phase !== "loading") await new Promise(r=>setImmediate(r));
      h.render();
      if (phase === "ready") {
        h.buttons().find(b=>b.props["aria-label"]==="Staged changes for file.txt").props.onClick();
        const patch=h.pending[1];patch.resolve(result(patch.args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"OLD_SCOPE_PATCH"}}));
        await new Promise(r=>setImmediate(r));h.render();
      }
      const switched = h.render(next,false);
      assert.equal(JSON.stringify(switched).includes("OLD_SCOPE_PATCH"),false);
      assert.equal(h.buttons().some(b=>b.props["aria-label"]?.includes("file.txt")),false);
      assert.equal(JSON.stringify(switched).includes("git_missing"),false);
      assert.equal(JSON.stringify(switched).includes("Reading Git changes"),false);
      h.render();
      if (phase === "loading") old.resolve(result(old.args));
      await new Promise(r=>setImmediate(r));
      const fresh=h.pending.at(-1);assert.notEqual(fresh,old,"latest query must eventually start");
      fresh.resolve(result(fresh.args,{root:next.path}));await new Promise(r=>setImmediate(r));
      assert.ok(JSON.stringify(h.render()).includes("file.txt"));h.unmount();
    }
  }
});

test("F3 actual component close and reopen same scope never revives the previous generation", async () => {
  const h=await componentHarness();h.render();h.buttons().find(b=>b.children.includes("Git changes")).props.onClick();h.render();
  const old=h.pending[0];h.buttons().find(b=>b.children.includes("Close Git changes")).props.onClick();h.render();
  h.buttons().find(b=>b.children.includes("Git changes")).props.onClick();h.render();
  assert.equal(h.pending.length,1,"retain one flight while its cancellation settles");
  old.resolve(result(old.args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"OLD_ABA_PATCH"}}));
  await new Promise(r=>setImmediate(r));assert.equal(h.pending.length,2);
  assert.equal(JSON.stringify(h.render()).includes("OLD_ABA_PATCH"),false);
  const fresh=h.pending[1];fresh.resolve(result(fresh.args));await new Promise(r=>setImmediate(r));
  assert.ok(JSON.stringify(h.render()).includes("file.txt"));h.unmount();
});

function largeValidChanges() {
  return result({path:"/repo",query_token:token},{rows:Array.from({length:4096},(_,i)=>({
    path:String(i).padStart(4,"0")+"x".repeat(156), staged:"?",worktree:"?",untracked:true,unsupported:false,
  }))});
}
test("F3 actual validator and controller accept all legal 4096 rows within the exact JSON cap", async () => {
  const value=largeValidChanges();assert.equal(Buffer.byteLength(JSON.stringify(value)),970858);
  const accepted=git.isGitChanges(value);
  const c=new git.GitChangesController(()=>token),updates=[];c.select("/repo","owner");
  await c.load(async()=>value,async()=>{},state=>updates.push(state));
  assert.deepEqual({accepted,kind:updates.at(-1).kind},{accepted:true,kind:"ready"});
  assert.equal(updates.at(-1).value.rows.length,4096);
});
test("F3 actual frontend validator accepts exactly 1 MiB and rejects one additional byte", () => {
  const equal=largeValidChanges();let remaining=1048576-Buffer.byteLength(JSON.stringify(equal));
  for(const row of equal.rows){const n=Math.min(remaining,4096-Buffer.byteLength(row.path));row.path+="y".repeat(n);remaining-=n;}
  assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(equal)),1048576);
  const above=structuredClone(equal);above.rows.at(-1).path+="z";
  assert.equal(Buffer.byteLength(JSON.stringify(above)),1048577);assert.equal(git.isGitChanges(above),false);
  assert.equal(git.isGitChanges(equal),true);
});

test('review actions bind the selected snapshot and staged rows never claim a live editor line',async()=>{
 const patch={path:'a.txt',kind:'text',side:'worktree',text:'@@ -1 +1 @@\n-before\n+after\n'},edited=[],reviewed=[];
 const h=await patchHarness(patch,{onEditLine:line=>edited.push(line),onReviewLine:(side,line)=>reviewed.push([side,line])});
 h.rows().find(row=>row.props['data-kind']==='add').props.onClick();h.refresh();h.button('Edit current line').props.onClick();assert.deepEqual(edited,[1]);
 h.rows().find(row=>row.props['data-kind']==='remove').props.onClick();h.refresh();h.button('Use line for feedback').props.onClick();assert.deepEqual(reviewed,[['old',1]]);assert.equal(h.button('Edit current line'),undefined);
 h.updatePatch({...patch,text:'@@ -4 +4 @@\n-old\n+new\n'});assert.equal(h.button('Use line for feedback'),undefined);
 h.updatePatch({...patch,side:'staged'});h.rows().find(row=>row.props['data-kind']==='add').props.onClick();h.refresh();assert.equal(h.button('Edit current line'),undefined);
});

 test('background Git refresh keeps the displayed patch mounted during the read and pauses when inactive',async()=>{
  const h=await componentHarness();h.render();h.buttons().find(b=>b.children.includes("Git changes")).props.onClick();h.render();let p=h.pending[0];p.resolve(result(p.args));await new Promise(r=>setImmediate(r));h.render();
  h.buttons().find(b=>b.props["aria-label"]==="Staged changes for file.txt").props.onClick();p=h.pending[1];p.resolve(result(p.args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"+current"}}));await new Promise(r=>setImmediate(r));
  const contains=n=>n&&typeof n==='object'&&(n.tag==='GitPatchView'||(n.children??[]).some(contains));
  assert.equal(contains(h.render()),true);const flight=h.refresh();assert.equal(contains(h.render()),true);p=h.pending[2];p.resolve(result(p.args,{patch:{path:"file.txt",side:"staged",kind:"text",text:"+current"}}));await flight;assert.equal(contains(h.render()),true);
  h.render({path:"/repo",owner:1,active:false});const count=h.pending.length;await h.refresh();assert.equal(h.pending.length,count);h.unmount();
 });

test('workspace hide and reopen retain the selected Git file and comparison side',async()=>{
 for(const side of ['staged','worktree']){
  const h=await componentHarness();h.render();h.buttons().find(b=>b.children.includes('Git changes')).props.onClick();h.render();
  h.pending[0].resolve(result(h.pending[0].args));await new Promise(r=>setImmediate(r));h.render();
  h.buttons().find(b=>b.props['aria-label']===`${side==='staged'?'Staged':'Worktree'} changes for file.txt`).props.onClick();
  const chosen=h.pending.at(-1);chosen.resolve(result(chosen.args,{patch:{path:'file.txt',side,kind:'text',text:'+selected-proof'}}));await new Promise(r=>setImmediate(r));h.render();
  h.render({path:'/repo',owner:1,active:false});assert.ok(JSON.stringify(h.slots).includes('+selected-proof'),'hiding must keep the reviewed comparison');
  h.render({path:'/repo',owner:1,active:true});const reload=h.pending.at(-1);assert.equal(reload.args.selected_path,'file.txt');assert.equal(reload.args.side,side);
  reload.resolve(result(reload.args,{patch:{path:'file.txt',side,kind:'text',text:'+fresh-proof'}}));await new Promise(r=>setImmediate(r));h.render();assert.ok(JSON.stringify(h.slots).includes('+fresh-proof'));h.unmount();
 }
});
