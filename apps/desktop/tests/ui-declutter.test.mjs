import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Actual JSX hierarchy keeps secondary controls reachable in native disclosures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
function source(name) {return ts.createSourceFile(name,readFileSync(new URL('../src/'+name,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
const app=source('App.tsx'), layout=source('TerminalLayout.tsx');
function elements(file,predicate) {const result=[];function visit(node){if(ts.isJsxElement(node)&&predicate(node))result.push(node);ts.forEachChild(node,visit);}visit(file);return result;}
function tag(node) {return node.openingElement.tagName.getText();}
function disclosure(node) {for(let parent=node.parent;parent;parent=parent.parent)if(ts.isJsxElement(parent)&&tag(parent)==='details')return parent;}
for(const [file,labels] of [[layout,['Reopen last hidden tab','Split right','Split down','Move tab left']],[app,['Filter sessions by status','Browse archived sessions','Manage history capacity','Settings','Edit project','Pin project','Export diagnostics','Terminal-reported directory','Shell-reported phase']]]) {
 for(const label of labels)test(label+' is inside a closed, keyboard-accessible disclosure',()=>{
  const matches=elements(file,node=>['button','Select','span'].includes(tag(node))&&(label==='Settings'?/>Settings<\/button>/.test(node.getText(file)):node.getText(file).includes(label)));
  assert.ok(matches.length,label+' exists');
  for(const node of matches){const menu=disclosure(node);assert.ok(menu,label+' must not occupy default workspace');assert.ok(!menu.openingElement.attributes.properties.some(attr=>attr.name?.getText()==='open'),'closed by default');assert.ok(menu.children.some(child=>ts.isJsxElement(child)&&tag(child)==='summary'),'native summary is keyboard accessible');const actionMenu=menu.openingElement.getText(file).includes('toolbar-more')?menu:disclosure(menu);assert.match(actionMenu.openingElement.getText(file),/Escape/,'Escape restores action summary focus');}
 });
}
test('capacity guidance describes existing archive controls truthfully',()=>{assert.doesNotMatch(app.text,/Archive and restore controls will be added in the next stage/);assert.match(app.text,/No history is deleted automatically/);});

test('each actual disclosure Escape closes it and returns keyboard focus without invoking an action',()=>{
 for(const file of [app,layout])for(const menu of elements(file,node=>tag(node)==='details'&&node.openingElement.getText(file).includes('toolbar-more'))){
  const attribute=menu.openingElement.attributes.properties.find(item=>item.name?.getText()==='onKeyDown');
  assert.ok(attribute?.initializer?.expression,'disclosure keyboard handler');
  const js=ts.transpileModule('return ('+attribute.initializer.expression.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  const handler=new Function(js)();let focused=0,prevented=0,stopped=0;const target={open:true,querySelector:name=>{assert.equal(name,'summary');return {focus(){focused++;}}}};
  handler({key:'ArrowDown',currentTarget:target});assert.equal(target.open,true);assert.equal(focused,0);
  handler({key:'Escape',currentTarget:target,preventDefault(){prevented++},stopPropagation(){stopped++}});
  assert.equal(target.open,false);assert.equal(focused,1);assert.equal(prevented,1);assert.equal(stopped,1);
 }
});
