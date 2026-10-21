// Author: Jeff.Liu. One bottom dismissal action per commit dialog; sole-exit tool panels keep theirs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import ts from 'typescript';
const root=new URL('../src/',import.meta.url);
function elements(node,tag){const out=[];function walk(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText()==tag)out.push(n);ts.forEachChild(n,walk);}walk(node);return out;}
function attr(node,name){return node.openingElement.attributes.properties.find(p=>p.name?.getText()==name)?.initializer?.getText().replace(/^"|"$/g,'');}
const dialogs=readdirSync(root).filter(name=>name.endsWith('.tsx')).flatMap(name=>{const file=ts.createSourceFile(name,readFileSync(new URL(name,root),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);return elements(file,'dialog').map(node=>({name,node,id:attr(node,'aria-labelledby')}));});
const buttons=node=>elements(node,'button');
const actions=node=>[...elements(node,'footer'),...elements(node,'div').filter(n=>['dialog-actions','dialog-footer'].includes(attr(n,'className')))];
const exit=button=>/\bt\(['"](?:Cancel|Close|Done)['"]\)/.test(button.getText());
test('dialogs with bottom dismissal never duplicate it in the heading',()=>{let checked=0;for(const {name,node,id}of dialogs){if(!actions(node).flatMap(buttons).some(exit))continue;checked++;assert.equal(elements(node,'header').flatMap(buttons).filter(b=>/onClose|\.close\(|closeProjectRename/.test(b.getText())).length,0,name+' '+id);}assert.ok(checked>=10);});
for(const id of ['appearance-title','terminal-settings-title','keyboard-shortcuts-title','terminal-paste-settings-title','ssh-launch-title','launch-title','project-title','rename-project-title'])test(id+' has title-only header and one bottom Cancel',()=>{const dialog=dialogs.find(d=>d.id===id);assert.ok(dialog,id);assert.equal(elements(dialog.node,'header').flatMap(buttons).length,0);const bottom=actions(dialog.node).flatMap(buttons);assert.equal(bottom.filter(b=>/\bt\(['"]Cancel['"]\)/.test(b.getText())).length,1);assert.ok(bottom.some(b=>!/\bt\(['"]Cancel['"]\)/.test(b.getText())),'commit action retained');});
test('tool panels that have no bottom dismissal retain their only close action',()=>{for(const id of ['command-palette-title','log-search-title']){const dialog=dialogs.find(d=>d.id===id);assert.ok(dialog,id);assert.ok(elements(dialog.node,'header').flatMap(buttons).length>0,id);}});
test('shortcut dismissal and save stay outside the scrolling list',()=>{const dialog=dialogs.find(d=>d.id==='keyboard-shortcuts-title');const footer=dialog.node.children.find(n=>ts.isJsxElement(n)&&attr(n,'className')==='dialog-actions');assert.ok(footer,'fixed sibling of scrollable fields');assert.ok(buttons(footer).some(exit));});

test("profile settings dismisses at the bottom like other settings pages",()=>{const dialog=dialogs.find(d=>d.id==="terminal-profiles-title");assert.ok(actions(dialog.node).flatMap(buttons).some(exit));assert.equal(elements(dialog.node,"header").flatMap(buttons).length,0);});
