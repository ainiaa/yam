// Author: Jeff.Liu. Closed ended-session groups must not allocate row trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import ts from 'typescript';
const path=new URL('../src/EndedSessions.tsx',import.meta.url);
function fixture(children){
 const text=existsSync(path)?readFileSync(path,'utf8'):'';
 const source=ts.createSourceFile('EndedSessions.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='EndedSessions');
 assert.ok(fn,'EndedSessions must defer its row factory until expansion');
 let value=false;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useState=()=>[value,next=>{value=typeof next==='function'?next(value):next;}];
 const render=new Function('React','useState',ts.transpileModule(fn.getText(source).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText+';return EndedSessions')(React,useState);
 return {render:(label='Ended sessions (100)')=>render({label,children}),toggle(tree,open,nested=false){const currentTarget={open};tree.props.onToggle({currentTarget,target:nested?{}:currentTarget});}};
}
test('collapsed groups do not create 100 rows; opening creates current rows and closing releases them',()=>{
 let rows=Array.from({length:100},(_,id)=>({type:'row',props:{id}})),calls=0;
 const h=fixture(()=>{calls++;return rows;}),closed=h.render();assert.equal(calls,0);assert.equal(closed.type,'details');assert.equal(closed.props.className,'project-ended-sessions');assert.equal(closed.props.children[0].type,'summary');
 h.toggle(closed,true);const opened=h.render();assert.equal(calls,1);assert.equal(opened.props.children.filter(x=>x?.type==='row').length,100);
 rows=[{type:'row',props:{id:'new'}}];assert.equal(h.render().props.children.find(x=>x?.type==='row').props.id,'new');
 h.toggle(opened,false);const after=h.render();assert.equal(calls,2);assert.equal(after.props.children.some(x=>x?.type==='row'),false);
});
test('bubbling nested-menu toggles do not collapse rows; empty and failed row factories are not evaluated while closed',()=>{
 let fail=false;const h=fixture(()=>{if(fail)throw Error('row failure');return [];});const closed=h.render('Ended sessions (0)');h.toggle(closed,true,true);fail=true;assert.doesNotThrow(()=>h.render());
 h.toggle(closed,true);assert.throws(()=>h.render(),/row failure/);fail=false;const opened=h.render();h.toggle(opened,false,true);fail=true;assert.throws(()=>h.render(),/row failure/);h.toggle(opened,false);assert.doesNotThrow(()=>h.render());
});
test('actual App supplies a deferred factory with the existing grouping, count and row actions',()=>{
 const text=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let node;
 function walk(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(tree)==='EndedSessions')node=n;ts.forEachChild(n,walk);}walk(tree);assert.ok(node,'App must use the deferred group');
 const children=node.children.filter(ts.isJsxExpression);assert.equal(children.length,1);assert.ok(ts.isArrowFunction(children[0].expression),'factory must not eagerly map rows');
 const factory=new Function('grouped','renderSession','return '+children[0].expression.getText(tree));let calls=0;const rows=[{id:1},{id:2}],render=factory({ended:rows},row=>{calls++;return row;});assert.equal(calls,0);assert.deepEqual(render(),rows);assert.equal(calls,2);
});
