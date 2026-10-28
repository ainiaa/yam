// Author: Jeff.Liu. Exercise production JSX without launching desktop applications.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {gitContextLabel} from '../src/git-context.ts';
import {agentLabel} from '../src/agent-events.ts';
const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const elements=[];
function walk(node){if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node))elements.push(node);ts.forEachChild(node,walk);}walk(source);
const opening=node=>ts.isJsxElement(node)?node.openingElement:node;
const tag=node=>opening(node).tagName.getText(source);
const attribute=(node,name)=>opening(node).attributes.properties.find(p=>p.name?.getText(source)===name);
const hasClass=(node,name)=>attribute(node,'className')?.initializer?.text?.split(' ').includes(name);
const findClass=name=>{const node=elements.find(node=>hasClass(node,name));assert.ok(node,name);return node;};
function inside(node,parent){for(let n=node.parent;n;n=n.parent)if(n===parent)return true;return false;}
function inDisclosure(node){for(let n=node.parent;n;n=n.parent)if(ts.isJsxElement(n)&&tag(n)==='details')return n;}
const t=(text,args={})=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>args[key]);
const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
const nodes=node=>[node,...(node?.props?.children??[]).filter(child=>child&&typeof child==='object').flatMap(nodes)];
function render(node,bindings={}){return new Function('React','t',...Object.keys(bindings),ts.transpileModule('return ('+node.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText)(React,t,...Object.values(bindings));}

test('search owns a closed status filter while Settings stays directly reachable at the bottom',()=>{
 const search=findClass('sidebar-search'),filter=elements.find(node=>attribute(node,'aria-label')?.getText(source).includes('Filter sessions by status')&&tag(node)==='Select');
 assert.ok(filter);assert.ok(inside(filter,search));assert.ok(inDisclosure(filter));assert.ok(!attribute(inDisclosure(filter),'open'));
 const settings=elements.find(node=>tag(node)==='button'&&node.getText(source).includes('openSettingsSection("appearance")'));
 assert.ok(inside(settings,findClass('sidebar-footer')));assert.equal(inDisclosure(settings),undefined);
 assert.doesNotMatch(findClass('sidebar').getText(source),/<time\b|<small\b/);
 assert.ok(elements.some(node=>tag(node)==='button'&&node.getText(source).includes('openCommandPalette')&&inDisclosure(node)),'session finder remains reachable');
});

test('header shows one primary status and keeps launch connection and process details in its menu',()=>{
 const header=findClass('topbar');
 assert.ok(!elements.some(node=>inside(node,header)&&hasClass(node,'round-status')));
 const connection=elements.find(node=>tag(node)==='SessionConnection');assert.ok(inDisclosure(connection));
 const status=elements.find(node=>attribute(node,'className')?.getText(source).includes('`session-status'));
 assert.ok(status);
 for(const scenario of [
  {launch:{mode:'interactive'},isRunning:true,phase:'needs_permission',integration:'connected',expected:'Permission required'},
  {launch:{mode:'interactive'},isRunning:true,phase:'working',integration:'connected',expected:'Working'},
  {launch:{mode:'interactive'},isRunning:true,phase:'working',integration:'connecting',expected:'Awaiting trusted hook'},
  {launch:{mode:'interactive'},isRunning:true,phase:'working',integration:'unavailable',expected:'Integration unavailable'},
  {launch:{mode:'interactive'},isRunning:false,phase:'working',integration:'connected',expected:'Stopped'},
  {launch:null,isRunning:true,phase:'unknown',integration:'unavailable',expected:'Running'},
  {launch:null,isRunning:true,agentPhase:'waiting',phase:'unknown',integration:'unavailable',expected:'Waiting for input'},
 ]){
  const tree=render(status,{session:{launch:scenario.launch},isRunning:scenario.isRunning,currentAgent:{phase:scenario.phase,integration:scenario.integration},agentLabel,agentPhase:scenario.agentPhase??"idle",sessionStatus:scenario.isRunning?'running':'stopped',statusLabels:{running:'Running',stopped:'Stopped'}});
  assert.ok(nodes(tree).some(node=>node.props.children.includes(scenario.expected)),JSON.stringify(tree));
  assert.equal(tree.props['data-integration'],scenario.isRunning&&scenario.launch?.mode==='interactive'?scenario.integration:undefined);
 }
});

test('view controls switch the same conversation surface and project actions select their intended panel',()=>{
 const calls=[],bindings={gitContextLabel,session:{session_id:'s',cwd:'/repo',launch:{adapter:'claude',mode:'interactive'}},conversationOpen:false,showConversation:value=>calls.push(['view',value]),openTerminalFind:()=>calls.push(['find']),scrollView:{ready:true},Search:'search',visibleGitContext:{kind:'repository',root:'/repo',branch:'main',dirty:true},isMainWindow:true,gitProjectPath:'/repo',openMainSettings:()=>calls.push(['main']),setProjectToolsTab:value=>calls.push(['tab',value]),setProjectToolsPath:value=>calls.push(['root',value]),setProjectToolsOpen:value=>calls.push(['open',value])};
 const view=render(findClass('workspace-viewbar'),bindings),buttons=nodes(view).filter(node=>node.type==='button');
 buttons.find(node=>node.props.children.includes('Terminal')).props.onClick();buttons.find(node=>node.props.children.includes('Conversation')).props.onClick();
 assert.deepEqual(calls.splice(0),[['view',false],['view',true]]);
 const actions=render(findClass('workspace-actions'),bindings);
 for(const label of ['Files','Changes'])nodes(actions).find(node=>node.type==='button'&&node.props.children.includes(label)).props.onClick();
 assert.deepEqual(calls,[['tab','files'],['root','/repo'],['open',true],['tab','changes'],['root','/repo'],['open',true]]);
 assert.equal(nodes(render(findClass('workspace-actions'),{...bindings,session:null,visibleGitContext:null})).filter(node=>node.type==='button').length,0);
 const unavailable=render(findClass('workspace-viewbar'),{...bindings,scrollView:null});assert.equal(nodes(unavailable).find(node=>node.props['aria-label']==='Find in terminal').props.disabled,true);
});

test('persistent status bar keeps directory and memory visible for empty, active and ended sessions',()=>{
 const footer=findClass('workspace-footer');assert.equal(tag(footer),'footer');
 assert.ok(!ts.isBinaryExpression(footer.parent),'footer must not depend on scroll or shared sessions');
 for(const session of [null,{cwd:'/repo',status:'running'},{cwd:'/repo',status:'stopped'}]){
  const tree=render(footer,{session,currentProject:null,history:[],health:{status:'ready'},visibleGitContext:null,showScrollControl:false,memory:null,memoryLabel:()=> 'YAM 120 MiB',Folder:'folder',GitBranch:'branch'});
  assert.ok(nodes(tree).some(node=>node.props.children.includes('YAM 120 MiB')));
  if(session)assert.ok(nodes(tree).some(node=>node.props.title==='/repo'));
 }
 const menu=elements.find(node=>hasClass(node,'toolbar-more-actions')&&node.getText(source).includes('Session details'));
 assert.match(menu.getText(source),/previewSelectedTerminalFile/);
});

test('project and workspace menus use consistent icon rows and separate dangerous actions',()=>{
 for(const name of ['project-more','sidebar-more']){
  const menu=findClass(name),panel=elements.find(node=>inside(node,menu)&&hasClass(node,'desktop-menu'));assert.ok(panel,name);
  const buttons=elements.filter(node=>inside(node,panel)&&tag(node)==='button');assert.ok(buttons.length>=4);
  assert.ok(buttons.every(node=>elements.some(child=>inside(child,node)&&/^[A-Z]/.test(tag(child)))),'all menu actions have an icon');
  assert.ok(buttons.at(-1).getText(source).includes('menu-danger'),'dangerous action is last');
  assert.ok(!elements.some(node=>inside(node,panel)&&['details','section','dl'].includes(tag(node))),'no nested settings in an action menu');
 }
 assert.ok(elements.some(node=>tag(node)==='dialog'&&node.getText(source).includes('History capacity management')),'capacity has a dedicated dialog');
});

test('capacity dialog shows useful totals and incomplete-scan guidance with standard dialog actions',()=>{
 const dialog=findClass('history-capacity-dialog');
 for(const complete of [true,false]){
  const capacity={metadata_bytes:1024,log_bytes:2048,scene_bytes:0,backup_bytes:0,archive_bytes:0,other_bytes:0,complete,scanned_entries:2,issues:complete?[]:['skipped_entry']};
  const tree=render(dialog,{capacityDialog:{current:null},setCapacityOpen(){},X:'x',history:[],historyOverview:{total:0,active:0},historyCursor:null,capacity,capacityError:null,capacityBusy:false,scanCapacity(){},cancelCapacity(){},setArchiveOpen(){}});
  const all=nodes(tree);assert.ok(all.some(n=>n.props.children.includes(complete?'Complete scan':'Partial scan')));
  assert.ok(all.some(n=>n.props.className==='dialog-actions'));
  assert.ok(!all.some(n=>n.props.children.includes('skipped entry')));
  if(!complete)assert.ok(all.some(n=>n.props.children.includes('Some entries could not be scanned. Totals may be incomplete.')));
 }
});

test('capacity dialog reserves its header and actions while its content scrolls in short windows',()=>{
 const css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
 assert.match(css,/\.history-capacity-dialog\[open\][^{]*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
 assert.match(css,/\.history-capacity-dialog > \.history-capacity-controls\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
});
