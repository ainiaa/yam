// Author: Jeff.Liu. Run actual component callbacks; native acceptance remains separate.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const file=new URL('../src/PiPlugins.tsx',import.meta.url);
const snapshot=()=>({revision:'a'.repeat(64),pi_available:true,packages:[],configured_names:[],other_count:0});
async function fixture(call){
 assert.ok(fs.existsSync(file),'Pi plugins settings component exists');const policy=await import('../src/pi-plugins.ts');
 const ast=ts.createSourceFile('PiPlugins.tsx',fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiPlugins');assert.ok(fn);
 const slots=[],refs=[],deps=[],effects=[];let i=0,r=0,e=0,tree;const busy=[];let closed=0;
 const env={...policy,Package:'svg',Search:'svg',RefreshCw:'svg',ExternalLink:'svg',Check:'svg',ChevronDown:'svg',useState:value=>{const n=i++;if(!(n in slots))slots[n]=value;return [slots[n],next=>slots[n]=typeof next==='function'?next(slots[n]):next];},useRef:value=>{const n=r++;return refs[n]??(refs[n]={current:value});},useEffect:(fn,values)=>{const n=e++;if(!deps[n]||values.some((v,j)=>v!==deps[n][j])){deps[n]=values;effects.push(fn);}},t:(s,v={})=>s.replace(/{{(\w+)}}/g,(_,key)=>v[key]??''),React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const js=ts.transpileModule(fn.getText(ast).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;const render=new Function(...Object.keys(env),js+';return PiPlugins;')(...Object.values(env));
 const props={invoke:call,navigation:()=>null,onClose:()=>closed++,onBusyChange:value=>busy.push(value),onOpenCatalog:async()=>{}};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 const refresh=()=>{i=r=e=0;tree=render(props);};const flush=async()=>{for(let n=0;n<4;n++){refresh();effects.splice(0).forEach(f=>f());await new Promise(setImmediate);}refresh();};await flush();
 return{flush,button:label=>all(tree).find(n=>n.type==='button'&&(n.props['aria-label']===label||n.children.flat(Infinity).includes(label))),field:label=>all(tree).find(n=>n.props['aria-label']===label),text:()=>all(tree).flatMap(n=>n.children).filter(v=>typeof v==='string').join(' '),tree:()=>tree,nodes:()=>all(tree),busy,get closed(){return closed;}};
}
const result={packages:[{name:'pi-test',version:'1.0.0',source:'npm:pi-test@1.0.0',description:'Test plugin'}]};
test('Pi market requires confirmation and applies only its frozen pinned source once',async()=>{
 let state=snapshot();const calls=[];let release;
 const f=await fixture(async(_name,{request})=>{calls.push(request);if(request.action==='list')return state;if(request.action==='search')return result;await new Promise(r=>release=r);state={...state,revision:'b'.repeat(64),configured_names:['pi-test'],packages:[{name:'pi-test',source:request.source}]};return state;});
 f.button('Install').props.onClick({currentTarget:{}});await f.flush();assert.equal(calls.filter(c=>c.action==='install').length,0);assert.match(f.text(),/Pi packages can run code/);
 f.button('Cancel').props.onClick();await f.flush();assert.equal(calls.filter(c=>c.action==='install').length,0);
 f.button('Install').props.onClick({currentTarget:{}});await f.flush();const confirm=f.button('Confirm installation');confirm.props.onClick();confirm.props.onClick();await f.flush();assert.equal(calls.filter(c=>c.action==='install').length,1);assert.deepEqual(calls.find(c=>c.action==='install'),{action:'install',source:'npm:pi-test@1.0.0',revision:'a'.repeat(64)});
 f.button('Close').props.onClick();assert.equal(f.closed,0);release();await f.flush();assert.ok(f.text().includes('Pi package installed'));assert.equal(f.busy.at(-1),false);
});
test('Pi failed mutations refresh state without automatic retry or duplicate installation',async()=>{
 const calls=[];const state=snapshot();let fail=false;const f=await fixture(async(_name,{request})=>{calls.push(request);if(request.action==='list')return state;if(request.action==='search')return result;if(fail)throw Error('operation timed out');return state;});
 fail=true;f.button('Install').props.onClick({currentTarget:{}});await f.flush();f.button('Confirm installation').props.onClick();await f.flush();assert.match(f.text(),/operation timed out/);assert.equal(calls.filter(c=>c.action==='install').length,1);assert.ok(calls.filter(c=>c.action==='list').length>=2);
});
test('Pi installed package removal uses its original source and requires explicit confirmation',async()=>{
 const calls=[];let state={...snapshot(),configured_names:['pi-test'],packages:[{name:'pi-test',source:'npm:pi-test@1.0.0'}]};const f=await fixture(async(_name,{request})=>{calls.push(request);if(request.action==='search')return result;if(request.action==='remove')state=snapshot();return state;});
 f.button('Installed').props.onClick();await f.flush();f.button('Remove').props.onClick({currentTarget:{}});await f.flush();assert.equal(calls.filter(c=>c.action==='remove').length,0);f.button('Confirm removal').props.onClick();await f.flush();assert.deepEqual(calls.find(c=>c.action==='remove'),{action:'remove',source:'npm:pi-test@1.0.0',revision:'a'.repeat(64)});
});

test('Pi plugins is reachable from settings search and both native-window routes',async()=>{
 const source=fs.readFileSync(new URL('../src/SettingsNavigation.tsx',import.meta.url),'utf8');assert.match(source,/'pi-plugins'/);
 const {matchesSettingsPage}=await import('../src/settings-search.ts');assert.ok(matchesSettingsPage('pi-plugins','Pi plugins','插件'));
 const {nativeSettings}=await import('./fixtures/native-settings.mjs');const changes=[];const main=nativeSettings({setPiPluginsOpen:v=>changes.push(v)});main.run('pi-plugins');assert.deepEqual(changes,[true]);
 const secondary=nativeSettings({isMainWindow:false});secondary.run('pi-plugins');assert.deepEqual(secondary.calls,[['main','pi-plugins']]);
});

test('a late discovery response cannot overwrite a newer explicit search',async()=>{
 let release;const f=await fixture(async(_name,{request})=>{if(request.action==='list')return snapshot();if(request.action==='search'&&!request.query)return new Promise(r=>release=r);return {packages:[{name:'pi-new',version:'1.0.0',source:'npm:pi-new@1.0.0',description:'new result'}]};});
 f.field('Search Pi plugins').props.onChange({target:{value:'new'}});await f.flush();const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];all(f.tree()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await f.flush();release(result);await f.flush();assert.match(f.text(),/pi-new/);assert.doesNotMatch(f.text(),/Test plugin/);
});
test('an invalid personal-state response disables installation without exposing its payload',async()=>{
 const calls=[];const f=await fixture(async(_name,{request})=>{calls.push(request);return request.action==='search'?result:{revision:'invalid',secret:'DO_NOT_EXPOSE'};});assert.ok(f.button('Install').props.disabled);assert.match(f.text(),/Invalid Pi package state/);assert.doesNotMatch(f.text(),/DO_NOT_EXPOSE/);assert.equal(calls.filter(c=>c.action==='install').length,0);
});

test('a CLI-managed range or tag remains protected against duplicate discovery installation',async()=>{
 const state={...snapshot(),configured_names:['pi-test'],other_count:1};const calls=[];const f=await fixture(async(_name,{request})=>{calls.push(request);return request.action==='search'?result:state;});assert.ok(f.button('Already installed').props.disabled);assert.equal(calls.filter(r=>r.action==='install').length,0);
});

test('Installed names CLI-managed npm packages without exposing opaque selectors or offering unsupported removal',async()=>{
 const state={...snapshot(),configured_names:['pi-test'],other_count:1};const f=await fixture(async(_name,{request})=>request.action==='search'?result:state);f.button('Installed').props.onClick();await f.flush();assert.match(f.text(),/pi-test/);assert.match(f.text(),/Managed through Pi CLI/);assert.equal(f.button('Remove'),undefined);assert.doesNotMatch(f.text(),/No npm Pi packages configured/);
});

test('Pi marketplace shows compact cards with expandable complete details and truthful installed reference count',async()=>{
 const state={...snapshot(),configured_names:['pi-installed','pi-cli'],packages:[{name:'pi-installed',source:'npm:pi-installed@2.0.0'}],other_count:2};
 const description='A long useful plugin description. '.repeat(12);const f=await fixture(async(_name,{request})=>request.action==='search'?{packages:[{...result.packages[0],description}]}:state);
 const installed=f.button('Installed');assert.ok(installed.children.flat(Infinity).some(n=>n?.props?.className==='pi-package-count'&&n.children.includes(3)),'counts exact and CLI references without double counting npm identities');
 const card=f.nodes().find(n=>n.type==='article');assert.equal(card.props.className,'pi-package-card');
 const details=f.nodes().find(n=>n.type==='details');assert.ok(details);assert.ok(f.nodes().some(n=>n.type==='p'&&n.props.className==='pi-package-description'&&n.children.includes(description)));assert.match(f.text(),/npm:pi-test@1.0.0/);
 assert.ok(f.nodes().some(n=>n.type==='summary'&&n.props['aria-label']==='Details for pi-test'));
 f.button('Installed').props.onClick();await f.flush();assert.equal(f.nodes().filter(n=>n.type==='article').length,2);assert.match(f.text(),/2.0.0/);assert.equal(f.nodes().filter(n=>n.type==='button'&&n.children.includes('Remove')).length,1);
});
test('Pi card discovery clearly announces loading, empty and error results without inventing package data',async()=>{
 let resolve;const f=await fixture(async(_name,{request})=>request.action==='list'?snapshot():new Promise(r=>resolve=r));assert.ok(f.nodes().some(n=>n.props.role==='status'));assert.match(f.text(),/Searching…/);
 resolve({packages:[]});await f.flush();assert.match(f.text(),/No matching Pi packages/);assert.equal(f.nodes().filter(n=>n.type==='article').length,0);
 const failed=await fixture(async(_name,{request})=>{if(request.action==='list')return snapshot();throw Error('market unavailable');});assert.ok(failed.nodes().some(n=>n.props.role==='alert'&&n.children.some(value=>typeof value==='string'&&value.includes('market unavailable'))));assert.doesNotMatch(failed.text(),/No matching Pi packages/);
});
test('cancelling removal restores keyboard focus to the installed list control',async()=>{
 const state={...snapshot(),configured_names:['pi-test'],packages:[{name:'pi-test',source:'npm:pi-test@1.0.0'}]};const f=await fixture(async(_name,{request})=>request.action==='search'?result:state);
 let focused=0;assert.ok(f.button('Installed').props.ref);f.button('Installed').props.ref.current={focus:()=>focused++};f.button('Installed').props.onClick();await f.flush();f.button('Remove').props.onClick({currentTarget:{}});await f.flush();f.button('Cancel').props.onClick();await f.flush();assert.equal(focused,1);
});
