import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Exercise the real disclosure using saved session metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {providerChoice} from '../src/provider-config.ts';
import * as providers from '../src/provider-config.ts';

const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
function nodes(tree){const all=[];const visit=node=>{if(node&&typeof node==='object'){all.push(node);for(const child of node.children??[])if(Array.isArray(child))child.forEach(visit);else visit(child);}};visit(tree);return all;}
function text(node){return (node?.children??[]).map(child=>typeof child==='string'?child:Array.isArray(child)?child.map(text).join(''):text(child)).join('');}
function renderConnection(launch,agent){
 let component;const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='SessionConnection')component=node.getText(source);ts.forEachChild(node,visit);};visit(source);assert.ok(component,'actual session connection disclosure exists');
 return new Function('React','connectionDetails','ChevronDown',ts.transpile(component,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022})+';return SessionConnection;')(React,providers.connectionDetails,()=>null)({launch,agent});
}
test('T3 real connection disclosure shows the selected launch snapshot and unverified runtime boundary',()=>{
 const launch={adapter:'codex',provider:{id:'custom',model:'gateway/model',base_url:'http://127.0.0.1:3425',api_key_env:null}};
 const tree=renderConnection(launch),all=nodes(tree);
 assert.equal(tree.type,'details');assert.equal(Boolean(tree.props.open),false);assert.ok(all.some(node=>node.type==='summary'&&node.props['aria-label']==='Connection details'));
 assert.match(text(tree),/Launch connection/);assert.match(text(tree),/codex/);assert.match(text(tree),/gateway\/model/);assert.match(text(tree),/127\.0\.0\.1:3425/);assert.match(text(tree),/current.*model.*authentication.*billing.*upstream.*not verified/i);
 assert.doesNotMatch(text(renderConnection({adapter:'claude'})),/gateway\/model|127\.0\.0\.1/);
 assert.match(text(renderConnection(null)),/Unknown/);
 let focused=0,prevented=0,stopped=0;const target={open:true,querySelector:()=>({focus(){focused++;}})};
 tree.props.onKeyDown({key:'Escape',currentTarget:target,preventDefault(){prevented++;},stopPropagation(){stopped++;}});
 assert.equal(target.open,false);assert.equal(focused,1);assert.equal(prevented,1);assert.equal(stopped,1);
});
test('T3 App passes active session metadata rather than editable launch-form fields',()=>{
 let connection;const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='SessionConnection')connection=node;ts.forEachChild(node,visit);};visit(source);assert.ok(connection);
 const launch=connection.attributes.properties.find(attr=>attr.name?.getText(source)==='launch');assert.equal(launch.initializer.expression.getText(source),'session.launch');
});
test('T3 native launch options describe inherited CLI settings without subscription or login promises',()=>{
 let select;const visit=node=>{if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='Select'&&node.openingElement.attributes.properties.some(attr=>attr.name?.getText(source)==='aria-label'&&attr.initializer?.text==='Model connection'))select=node;ts.forEachChild(node,visit);};visit(source);assert.ok(select);
 const render=new Function('React','providerChoice','formAdapter','formLaunch','changeProvider','const Select="select";'+ts.transpile('return ('+select.getText(source)+');',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}));
 const options=nodes(render(React,providers.providerChoice,'codex',{},()=>{})).filter(node=>node.type==='option');
 for(const value of ['inherited']){
  const option=options.find(node=>node.props.value===value);assert.ok(option);assert.match(text(option),/CLI configuration/i);assert.doesNotMatch(text(option),/subscription|native login/i);
 }
});

test('primary agents provider form explains the actual protocol and safe owner environment refresh',()=>{
 let fieldset;const visit=node=>{if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='fieldset'&&node.children.some(child=>ts.isJsxElement(child)&&child.openingElement.tagName.getText(source)==='legend'&&child.getText(source).includes('Provider connection')))fieldset=node;ts.forEachChild(node,visit);};visit(source);assert.ok(fieldset);
 const render=new Function('React','formLaunch','formAdapter','changeProviderFields','ProviderPortCheck','ProviderCatalog','invoke','providerChoice',ts.transpile('return ('+fieldset.getText(source)+');',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}));
 for(const [adapter,protocol] of [['codex',/Responses API/],['claude',/Anthropic Messages API/]]){
  const tree=render(React,{provider:{model:'selected-model',base_url:'https://api.example.test',api_key_env:'PROVIDER_TOKEN'}},adapter,()=>{},()=>null,()=>null,()=>{},providerChoice);
  assert.match(text(tree),protocol);
  assert.match(text(tree),/reopening a window does not reload/);
  assert.match(text(tree),/Finish tasks before restarting the owner/);
  assert.doesNotMatch(text(tree),/restart YAM after changing/);
 }
});


test('launch-time CLI facts and receipt capability hints distinguish supported, unknown and disconnected sessions',()=>{
 const launch={adapter:'codex',mode:'interactive'};
 const supported=text(renderConnection(launch,{cli_version:'codex-cli 0.162.1',cli_platform:'macos',integration:'connected'}));
 assert.match(supported,/CLI version.*codex-cli 0\.162\.1/);
 assert.match(supported,/Launch platform.*macos/);
 assert.match(supported,/Failure fallback.*Supported format/);
 assert.match(supported,/does not prove.*receipt.*delivered/i);
 for(const agent of [undefined,{integration:'connected'},{cli_version:'codex-cli 99.0.0',cli_platform:'macos',integration:'connected'},{cli_version:'codex-cli 0.162.1',cli_platform:'linux',integration:'connected'}]){
  const info=text(renderConnection(launch,agent));assert.match(info,/Failure fallback.*Unverified/);assert.doesNotMatch(info,/Failure fallback.*Supported format/);
 }
 const disconnected=text(renderConnection(launch,{cli_version:'codex-cli 0.162.1',cli_platform:'macos',integration:'connecting'}));
 assert.match(disconnected,/Failure fallback.*Not connected/);
 const claude=text(renderConnection({adapter:'claude',mode:'interactive'},{cli_version:'2.1.302 (Claude Code)',cli_platform:'macos',integration:'connected'}));
 assert.match(claude,/2\.1\.302/);assert.match(claude,/Esc.*not guaranteed/);
});
test('capability disclosure receives current session agent metadata',()=>{
 let connection;const visit=node=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='SessionConnection')connection=node;ts.forEachChild(node,visit);};visit(source);
 const agent=connection.attributes.properties.find(attr=>attr.name?.getText(source)==='agent');assert.ok(agent,'current session metadata is passed');assert.equal(agent.initializer.expression.getText(source),'currentAgent');
 const bindings=ts.transpile('return ('+connection.getText(source)+');',{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022});
 const currentAgent={cli_version:'codex-cli 0.162.1',cli_platform:'macos',integration:'connected'};
 const rendered=new Function('React','SessionConnection','session','currentAgent',bindings)(React,()=>{}, {launch:{adapter:'codex',mode:'interactive'}},currentAgent);
 assert.equal(rendered.props.agent,currentAgent);
});


test('owner preparation reuses the executable resolved for the native launch',()=>{
 const rust=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
 const wrapper=rust.slice(rust.indexOf('fn create_session_owner_with_directory_reporting('),rust.indexOf('fn create_session_with_effects<'));
 assert.match(wrapper,/create_session_with_effects\(/);
 assert.equal((wrapper.match(/\bfind_executable\b/g)??[]).length,1,'the native entry supplies its executable resolver once');
 const start=rust.indexOf('fn create_session_with_effects<');
 const end=rust.indexOf('    let summary = SessionSummary {',start);
 assert.ok(start>=0&&end>start);
 const setup=rust.slice(start,end);
 assert.equal((setup.match(/lookup_executable\(&launch\.adapter\)/g)??[]).length,1,'one executable resolution is shared by launch and hook/version preparation');
});
