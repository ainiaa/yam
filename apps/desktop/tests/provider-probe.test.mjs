import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Real template reuse and manual loopback-check UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import * as providers from '../src/provider-config.ts';
import * as templates from '../src/launch-templates.ts';
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(name,bindings){let code;const visit=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text===name)code=n.getText(ast);ts.forEachChild(n,visit);};visit(ast);assert.ok(code,`real ${name} exists`);return new Function(...Object.keys(bindings),ts.transpile(code,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022})+`;return ${name};`)(...Object.values(bindings));}
const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
function nodes(tree){const result=[];const visit=n=>{if(n&&typeof n==='object'){result.push(n);for(const child of n.children??[])if(Array.isArray(child))child.forEach(visit);else visit(child);}};visit(tree);return result;}
function text(n){return(n?.children??[]).map(x=>typeof x==='string'?x:Array.isArray(x)?x.map(text).join(''):text(x)).join('');}
const provider={id:'custom',model:'gateway/model',base_url:'http://127.0.0.1:3425/v1',api_key_env:'GATEWAY_API_KEY'};
const template={id:'11111111-1111-4111-8111-111111111111',name:'Magpie',adapter:'claude',mode:'interactive',extra_args:'',prompt:null,command:null,provider};
test('T4 existing template can be applied repeatedly with only credential references',()=>{
 const saved=templates.decodeLaunchTemplates(templates.encodeLaunchTemplates([templates.createLaunchTemplate('Magpie',{...template,env:{GATEWAY_API_KEY:'SECRET_VALUE'}},()=>template.id)]))[0];
 let state={},edits={};const bindings={projectLaunchFields:templates.projectLaunchFields,launchSettingsDialog:{current:null},launchDialog:{current:null},editLaunch:fields=>{Object.assign(state,fields);Object.assign(edits,fields);}};
 const apply=actual('applyLaunchTemplate',bindings);apply(saved);apply(saved);
 assert.deepEqual(state.provider,provider);assert.deepEqual(edits.provider,provider);assert.equal(state.adapter,'claude');assert.equal(JSON.stringify(saved).includes('SECRET_VALUE'),false);
});
test('T4 template list shows sanitized CLI, model, endpoint and environment reference summary',()=>{
 const code=readFileSync(new URL('../src/LaunchTemplates.tsx',import.meta.url),'utf8');
 const Component=new Function('React','connectionDetails',ts.transpile(code.replace(/^import .*$/mg,'').replace('export function','function'),{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS})+';return LaunchTemplates;')(React,providers.connectionDetails);
 const props={templates:[template],selectedId:template.id,name:'Magpie',starting:false};
 const tree=Component(props);assert.match(text(tree),/claude/);assert.match(text(tree),/gateway\/model/);assert.match(text(tree),/127\.0\.0\.1:3425\/v1/);assert.match(text(tree),/GATEWAY_API_KEY/);assert.doesNotMatch(text(tree),/SECRET_VALUE/);
});
function probeHarness(){let state=null;const ref={current:false};let endpoint=provider.base_url;const calls=[],pending=[];
 const bindings={React,useRef:()=>ref,useState:()=>[state,v=>state=v],invoke:(name,args)=>{calls.push([name,args]);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
 const Component=actual('ProviderPortCheck',bindings);return{calls,pending,render:()=>Component({endpoint}),setEndpoint:v=>endpoint=v};}
test('T4 port check is explicit, suppresses duplicate clicks and ignores old endpoint results',async()=>{
 const h=probeHarness();let tree=h.render();assert.equal(h.calls.length,0);let button=nodes(tree).find(n=>n.type==='button');assert.match(text(button),/Check local port/);
 const first=button.props.onClick();button.props.onClick();assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0],['probe_provider_endpoint',{endpoint:provider.base_url}]);assert.equal(nodes(h.render()).find(n=>n.type==='button').props.disabled,true);
 h.setEndpoint('http://127.0.0.1:9999');h.pending[0].resolve('reachable');await first;assert.doesNotMatch(text(h.render()),/Port is reachable/);
 const next=nodes(h.render()).find(n=>n.type==='button').props.onClick();h.pending[1].resolve('reachable');await next;tree=h.render();assert.match(text(tree),/Port is reachable/);assert.match(text(tree),/authentication.*model.*not verified/i);
});
test('T4 unavailable, unsupported, refusal and timeout results never expose errors or alter launches',async()=>{
 const h=probeHarness();
 for(const [reply,expected] of [['unreachable',/Cannot connect/],['timed_out',/timed out/i],['unsupported',/only supports local gateways/i],['unexpected',/Check unavailable/]]){
  const promise=nodes(h.render()).find(n=>n.type==='button').props.onClick();h.pending.at(-1).resolve(reply);await promise;assert.match(text(h.render()),expected);
 }
 const promise=nodes(h.render()).find(n=>n.type==='button').props.onClick();h.pending.at(-1).reject(Error('SECRET_ERROR'));await promise;assert.match(text(h.render()),/Check unavailable/);assert.doesNotMatch(text(h.render()),/SECRET_ERROR/);
});
test('T4 native command runs blocking work outside the owner and terminal service',()=>{
 const lib=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');assert.ok(lib.includes('provider_probe::probe_provider_endpoint'),'probe command is registered');
 const rust=readFileSync(new URL('../src-tauri/src/provider_probe.rs',import.meta.url),'utf8');assert.match(rust,/spawn_blocking/);assert.match(rust,/Duration::from_secs\(2\)/);assert.match(app,/<ProviderPortCheck endpoint=\{formLaunch.provider.base_url\}/);
 const service=readFileSync(new URL('../terminal-service.cjs',import.meta.url),'utf8');assert.doesNotMatch(service,/probe_provider_endpoint|provider_probe/);
});

test('port results distinguish green reachability and red failures without relying on color alone',async()=>{
 const h=probeHarness();
 for(const [status,kind,role,icon] of [['reachable','success','status','✓'],['unreachable','error','alert','✕'],['timed_out','error','alert','✕']]){
  const promise=nodes(h.render()).find(n=>n.type==='button').props.onClick();h.pending.at(-1).resolve(status);await promise;
  const result=nodes(h.render()).find(n=>n.props.className===`connection-result ${kind}`);assert.ok(result);assert.equal(result.props.role,role);assert.match(text(result),new RegExp(icon));
 }
});
