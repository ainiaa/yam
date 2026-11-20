// Author: Jeff.Liu. Read-only launch checks never send credentials or create tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {isProviderConfig} from '../src/provider-config.ts';
const source=ts.createSourceFile('LaunchPreflight.tsx',readFileSync(new URL('../src/LaunchPreflight.tsx',import.meta.url),'utf8'),99,true,4);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='LaunchPreflight');
const React={createElement:(type,props,...children)=>({type,props,children})};
function fixture(){let refs=[],states=[],index=0,effects=[];const calls=[],pending=[];
 const Component=new Function('React','useRef','useState','useEffect','t','isProviderConfig',ts.transpile(fn.getText(source),{jsx:2,target:9})+';return LaunchPreflight;')(React,v=>{const n=index++;return refs[n]??(refs[n]={current:v});},(v)=>{const n=index++;if(!(n in states))states[n]=v;return[states[n],v=>states[n]=v];},()=>{},v=>v,isProviderConfig);
 return {calls,pending,render(props){index=0;return Component({adapter:{id:'codex',label:'Codex',available:true,executable:'/bin/codex'},cwd:'/project',provider:null,invoke:(...args)=>{calls.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}));},...props});}};
}
function nodes(n){return n&&typeof n==='object'?[n,...(n.children??[]).flat(Infinity).flatMap(nodes)]:[];}
function text(n){return typeof n==='string'?n:(n?.children??[]).flat(Infinity).map(text).join(' ');}
test('missing CLI is explained and explicit directory check dispatches only safe directory validation',async()=>{const f=fixture();let tree=f.render({adapter:{id:'codex',label:'Codex',available:false,executable:null}});assert.match(text(tree),/not detected/);const button=nodes(tree).find(n=>n.type==='button');const checking=button.props.onClick();assert.deepEqual(f.calls,[['validate_project_directory',{path:'/project'}]]);f.pending[0].resolve();await checking;assert.match(text(f.render({})),/Directory exists/);});
test('invalid credential configuration and failed directory checks never reveal raw error or values',async()=>{const f=fixture();let tree=f.render({provider:{api_key_env:'sk-secret'}});assert.match(text(tree),/Invalid connection/);assert.doesNotMatch(text(tree),/sk-secret/);const checking=nodes(tree).find(n=>n.type==='button').props.onClick();f.pending[0].reject(Error('sensitive'));await checking;assert.match(text(f.render({})),/unavailable/);assert.doesNotMatch(text(f.render({})),/sensitive/);});
test('a result for an old directory is hidden after edits',async()=>{const f=fixture();const checking=nodes(f.render({})).find(n=>n.type==='button').props.onClick();f.pending[0].resolve();await checking;assert.doesNotMatch(text(f.render({cwd:'/other'})),/Directory exists/);});
