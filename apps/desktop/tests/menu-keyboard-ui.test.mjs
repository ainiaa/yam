// Author: Jeff.Liu. Execute legacy inline seams so they cannot bypass shared menu behavior.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {defaultTerminalTitle} from '../src/workspaces.ts';
const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(n){if(predicate(n))result=n;ts.forEachChild(n,visit);}visit(source);assert.ok(result);return result;}
test('session context menu never consumes composition arrows before the shared handler',()=>{
 const menu=find(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='div'&&n.openingElement.attributes.properties.some(a=>a.name?.getText(source)==='aria-label'&&a.getText(source).includes('Session actions')));
 const attr=menu.openingElement.attributes.properties.find(a=>a.name?.getText(source)==='onKeyDown');
 if(!attr){assert.ok(raw.includes('installActionMenus(document)'));return;}
 const fn=new Function('document',ts.transpileModule('return ('+attr.initializer.expression.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)({activeElement:null});let prevented=0,focused=0;
 fn({key:'ArrowDown',keyCode:229,nativeEvent:{isComposing:true},preventDefault(){prevented++;},currentTarget:{querySelectorAll:()=>[{focus(){focused++;}}]}});assert.equal(prevented,0);assert.equal(focused,0);
});
test('an explicit shell launch gets a distinct default terminal name, not the generic adapter label',()=>{
 const fn=find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='startSession');let call;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='setSessionTitles')call=n;ts.forEachChild(n,visit);}visit(fn);assert.ok(call);
 const next={session_id:'s-1a181f2377e-1a',launch:{adapter:'shell',prompt:null},command:null,ssh:null};const values={next,overrides:{cwd:'/repo'},projectStart:false,adapter:{id:'shell',label:'System shell'},adapters:[{id:'shell',label:'System shell'}],t:x=>x,defaultTerminalTitle};
 const updater=new Function(...Object.keys(values),ts.transpileModule('return ('+call.arguments[0].getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(values));const names=updater({existing:'My task'});assert.equal(names.existing,'My task');assert.match(names[next.session_id],/^Terminal /);assert.notEqual(names[next.session_id],'System shell');
});
test('history titles remain verbatim even when they equal a former generated default',()=>{
 const node=find(n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='titleFor');const values={sessionTitles:{custom:'用户名称'},defaultTerminalTitle,t:x=>x,sshTitle:()=> 'SSH'};
 const title=new Function(...Object.keys(values),ts.transpileModule('return ('+node.initializer.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(values));
 assert.equal(title({session_id:'s-abc-1',title:'Interactive shell'}),'Interactive shell');assert.equal(title({session_id:'custom',title:'native'}),'用户名称');assert.match(title({session_id:'s-abc-1',command:null,launch:null}),/^Terminal /);
});
