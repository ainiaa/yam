// Author: Jeff.Liu. Project tools share one inset scrolling body below a fixed header.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let dialog;function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='ProjectWorkspace')dialog=node;ts.forEachChild(node,visit);}visit(source);
test('project tools keep the title and close button outside the single scrolling content body',()=>{
 assert.ok(dialog);const children=dialog.children.filter(ts.isJsxElement);
 assert.ok(children[0]);
 const body=children.find(n=>n.openingElement.attributes.getText(source).includes('className="project-tools-body"'));assert.ok(body,'all tools need a shared content inset');
 assert.doesNotMatch(body.getText(source),/Close project tools/);
 for(const component of ['RunChanges','ProjectFiles','GitChanges','WorktreeControls','ReviewFeedback'])assert.match(body.getText(source),new RegExp('<'+component+'\\b'));
});
test('project tools have shared horizontal gutters, shrinkable body scrolling and a narrow-window inset',()=>{
 const rule=selector=>{const start=css.indexOf(selector+' {');assert.ok(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);};
 assert.match(rule('.project-workspace'),/overflow:\s*hidden/);
 const body=rule('.project-tools-body');assert.match(body,/padding:\s*4px 22px 20px/);assert.match(body,/overflow-y:\s*auto/);assert.match(body,/min-height:\s*0/);assert.match(body,/gap:\s*20px/);
 assert.match(css,/@media\s*\(max-width:\s*700px\)\s*\{\s*\.project-tools-body\s*\{[^}]*padding:\s*4px 16px 16px/);
 assert.match(css,/\.project-tools-body > \.project-files\s*\{[^}]*padding:\s*0/);
 assert.match(css,/\.project-tools-body > \.dialog-fields\s*\{[^}]*padding:\s*0[^}]*overflow:\s*visible/);
});

 test('workspace navigation selects panels without unmounting drafts or feedback',()=>{
  assert.match(app,/projectToolsTab/);
  for(const name of ['files','changes','worktrees'])assert.match(app,new RegExp('project-tools-'+name));
  assert.match(app,/setProjectToolsTab\("files"\)/);
  assert.match(app,/setProjectToolsTab\("changes"\)/);
  assert.match(css,/\.project-tools-panel\[hidden\]/);
  assert.match(app,/role="tablist"/);assert.match(app,/aria-controls/);
 });

test('Git review entry always opens Changes after visiting other panels',()=>{
 const start=app.indexOf('className="workspace-changes"');const end=app.indexOf('</button>',start);const entry=app.slice(start,end);assert.match(entry,/setProjectToolsTab\("changes"\)/);
});

 test('project tool tabs expose arrow and Home/End keyboard navigation',()=>{
  assert.match(app,/tabIndex=\{projectToolsTab===tab\?0:-1\}/);
  for(const key of ['ArrowLeft','ArrowRight','Home','End'])assert.ok(app.includes('"'+key+'"'));
 });

test('closing the workspace keeps Git review mounted while pausing its background reads',()=>{
 let target;function find(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='GitChanges')target=node;ts.forEachChild(node,find);}find(source);assert.ok(target);
 assert.match(target.attributes.getText(source),/active=\{projectToolsOpen&&projectToolsTab==="changes"\}/);
 for(let parent=target.parent;parent&&parent!==dialog;parent=parent.parent)assert.ok(!(ts.isBinaryExpression(parent)&&parent.left.getText(source)==='projectToolsOpen'),'closing must not unmount the selected diff');
});
