// Author: Jeff.Liu. Discovery actions must never install implicitly.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const file=new URL('../src/cli-setup.ts',import.meta.url);
test('installer definitions are explicit official commands and reject unknown programs',async()=>{
 assert.ok(fs.existsSync(file),'CLI installer definitions exist');const {cliInstaller}=await import(file.href);
 assert.match(cliInstaller('codex').command,/https:\/\/chatgpt.com\/codex\/install.sh/);
 assert.match(cliInstaller('claude').command,/https:\/\/claude.ai\/install.sh/);
 for(const id of ['codex','claude'])assert.match(cliInstaller(id).command,/pipefail/);
 assert.equal(cliInstaller('shell'),undefined);assert.equal(cliInstaller('custom; touch /tmp/unsafe'),undefined);assert.equal(cliInstaller('__proto__'),undefined);
});
test('npm-only installers declare the Node.js prerequisite on fresh machines',async()=>{
 const {cliInstaller}=await import(file.href);
 for(const id of ['gemini','opencode'])assert.equal(cliInstaller(id).requiresNode,true);
 for(const id of ['codex','claude'])assert.notEqual(cliInstaller(id).requiresNode,true);
});
const app=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');const ast=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,env){let fn;const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text===name)fn=n;ts.forEachChild(n,visit);};visit(ast);assert.ok(fn,`${name} callback exists`);return new Function(...Object.keys(env),ts.transpile(fn.getText(ast),{target:ts.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(env));}
test('missing programs remain selectable, while incompatible providers stay protected',()=>{
 let target;const visit=n=>{if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='button'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(ast)==='onClick'&&a.initializer?.getText(ast)==='{()=>changeAdapter(adapter.id)}'))target=n;ts.forEachChild(n,visit);};visit(ast);assert.ok(target);
 const disabled=target.openingElement.attributes.properties.find(a=>a.name?.getText(ast)==='disabled').initializer.expression.getText(ast);
 const evaluate=new Function('adapter','formLaunch','supportsProvider','starting','adapterInstalling',`return ${disabled}`);
 assert.equal(!!evaluate({id:'codex',available:false},{provider:null},()=>true,false,false),false);
 assert.equal(!!evaluate({id:'codex',available:true},{provider:{}},()=>false,false,false),true);
});
test('install action rechecks and never reinstalls an already discovered CLI',async()=>{
 const starts=[],installing=[];const base={cliInstallPending:{current:false},formAdapter:'codex',cliInstaller:()=>({name:'Codex CLI',command:'official-test-install'}),refreshAdapters:async()=>[{id:'codex',available:true}],setAdapterInstalling:v=>installing.push(v),startSession:async p=>starts.push(p),setError:()=>{},saveSessionName:()=>{},setSessionTitles:()=>{},localStorage:{},t:s=>s};
 await callback('installSelectedCli',base)();assert.equal(starts.length,0);assert.deepEqual(installing,[true,false]);assert.equal(base.cliInstallPending.current,false);
});
test('install action creates only one managed terminal and releases its lock after failure',async()=>{
 let resolve;const starts=[];const env={cliInstallPending:{current:false},formAdapter:'claude',cliInstaller:()=>({name:'Claude Code',command:'official-test-install'}),refreshAdapters:async()=>[{id:'claude',available:false}],setAdapterInstalling:()=>{},startSession:p=>{starts.push(p);return new Promise(r=>resolve=r);},setError:()=>{},saveSessionName:()=>{},setSessionTitles:()=>{},localStorage:{},t:s=>s};
 const install=callback('installSelectedCli',env);const first=install();await install();await new Promise(r=>setImmediate(r));assert.equal(starts.length,1);assert.deepEqual(starts[0],{cwd:'',command:'official-test-install',launch:null});resolve(undefined);await first;assert.equal(env.cliInstallPending.current,false);
 env.refreshAdapters=async()=>null;await callback('installSelectedCli',env)();assert.equal(starts.length,1,'failed discovery does not trigger installation');
});
test('discovery keeps only the newest read and reports errors without installing',async()=>{
 const reads=[],updates=[],errors=[],checking=[];const epoch={current:0};
 const refresh=callback('refreshAdapters',{adapterDiscoveryEpoch:epoch,setAdapterChecking:v=>checking.push(v),invoke:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),setAdapters:v=>updates.push(v),setError:v=>errors.push(v)});
 const old=refresh(),latest=refresh();reads[1].resolve([{id:'codex',available:true}]);assert.deepEqual(await latest,[{id:'codex',available:true}]);reads[0].resolve([{id:'codex',available:false}]);assert.equal(await old,null);assert.equal(updates.length,1);
 const failed=refresh();reads[2].reject(Error('discovery failed'));assert.equal(await failed,null);assert.deepEqual(errors,['discovery failed']);assert.equal(checking.at(-1),false);
 const unmounted=refresh();epoch.current++;reads[3].resolve([]);assert.equal(await unmounted,null);assert.equal(updates.length,1);
});
test('entering the new-session dialog checks again; moving focus inside it does not rescan',()=>{
 let dialog;const visit=n=>{if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='dialog'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(ast)==='aria-labelledby'&&a.initializer?.text==='launch-title'))dialog=n;ts.forEachChild(n,visit);};visit(ast);assert.ok(dialog);
 const handler=dialog.openingElement.attributes.properties.find(a=>a.name?.getText(ast)==='onFocusCapture').initializer.expression.getText(ast);let reads=0;
 const focus=new Function('refreshAdapters',ts.transpile(`return (${handler});`,{target:ts.ScriptTarget.ES2022}))(()=>reads++);
 focus({currentTarget:{contains:()=>false},relatedTarget:null});assert.equal(reads,1);focus({currentTarget:{contains:()=>true},relatedTarget:{}});assert.equal(reads,1);
});
test('missing CLI submission opens installation, while normal submission still starts a session',()=>{
 let form,primary;const visit=n=>{
  if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='form'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(ast)==='onSubmit'&&a.initializer?.getText(ast).includes('installSelectedCli')))form=n;
  ts.forEachChild(n,visit);
 };visit(ast);assert.ok(form);
 const submit=form.openingElement.attributes.properties.find(a=>a.name?.getText(ast)==='onSubmit').initializer.expression.getText(ast);
 for(const missing of [true,false]){
  const calls=[];const handler=new Function('launchWorkspace','launchWorktreeAttempt','selectedCliMissing','installSelectedCli','startNewSession',ts.transpile(`return (${submit});`,{target:ts.ScriptTarget.ES2022}))(null,undefined,missing,()=>calls.push('install'),()=>calls.push('session'));
  handler({preventDefault:()=>calls.push('prevent')});assert.deepEqual(calls,['prevent',missing?'install':'session']);
 }
 const buttons=n=>{if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='button'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(ast)==='type'&&a.initializer?.text==='submit'))primary=n;ts.forEachChild(n,buttons);};buttons(form);assert.ok(primary);
 const disabled=primary.openingElement.attributes.properties.find(a=>a.name?.getText(ast)==='disabled').initializer.expression.getText(ast);
 const state={launchWorkspace:null,launchWorktreeAttempt:undefined,starting:false,adapterInstalling:false,adapterChecking:false,adapters:[{id:'pi',available:false}],selectedCliMissing:true,selectedCliInstaller:{},formAdapter:'pi',piFormValid:false,projectConfigBusy:true,useProjectSettings:true,projectPreview:{trusted:false}};
 const evaluate=values=>new Function(...Object.keys(values),`return ${disabled};`)(...Object.values(values));
 assert.equal(evaluate(state),false,'installer does not require a model configuration or trusted project');assert.equal(evaluate({...state,adapterChecking:true}),true);assert.equal(evaluate({...state,adapterInstalling:true}),true);
});
