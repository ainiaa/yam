// Author: Jeff.Liu. Execute both real status surfaces with current connection facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const surfaces=[];let status;
function visit(node){
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='engineStatus')status=node.initializer;
 if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='className'&&['engine-details','statusbar-engine'].includes(a.initializer?.text)))surfaces.push(node);
 ts.forEachChild(node,visit);
}visit(source);assert.equal(surfaces.length,2);
const compile=code=>ts.transpile(code,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
function text(node){return typeof node==='string'?node:(node?.children??[]).map(text).join('');}
function active(node){return !!node&&typeof node==='object'&&(String(node.props?.className).includes('status-running')||(node.children??[]).some(active));}
function render(health,available,reconnecting){
 const bindings={React,health,ownerConnectionAvailable:{current:{available}},reconnecting,t:value=>value};
 if(status)bindings.engineStatus=new Function(...Object.keys(bindings),compile('return ('+status.getText(source)+')'))(...Object.values(bindings));
 return surfaces.map(surface=>new Function(...Object.keys(bindings),compile('return ('+surface.getText(source)+')'))(...Object.values(bindings)));
}
for(const [name,health,available,reconnecting,label,ready] of [
 ['initial',null,true,false,'Connecting...',false],
 ['ready',{status:'ready'},true,false,'Local engine ready',true],
 ['disconnected',{status:'ready'},false,false,'Background connection unavailable',false],
 ['reconnecting',{status:'ready'},false,true,'Reconnecting background…',false],
 ['reconnect failed',{status:'ready'},false,false,'Background connection unavailable',false],
 ['health unavailable',{status:'failed'},true,false,'Connecting...',false],
])test(`engine status agrees across surfaces: ${name}`,()=>{for(const view of render(health,available,reconnecting)){assert.ok(text(view).includes(label),`${name}: ${text(view)}`);assert.equal(active(view),ready);}});
test('a disconnect and explicit reconnect do not retain the previous ready presentation',()=>{
 for(const [available,reconnecting,label] of [[true,false,'Local engine ready'],[false,false,'Background connection unavailable'],[false,true,'Reconnecting background…'],[true,false,'Local engine ready']]){
  for(const view of render({status:'ready'},available,reconnecting))assert.ok(text(view).includes(label));
 }
});
