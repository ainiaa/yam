// Author: Jeff.Liu. Settings share one opener across pages and restore it without stealing newer focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function fixture(){
 let hook;function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useLayoutEffect'&&node.arguments[0]?.getText(source).includes('settingsOrigin'))hook=node;ts.forEachChild(node,visit);}visit(source);assert.ok(hook,'settings restore must run before child dialogs take focus');
 assert.equal(hook.arguments[1].getText(source),'[settingsOpen]','changing settings pages must preserve the original opener');
 const frames=new Map(),settingsOrigin={current:null};let next=0;
 const document={body:{},activeElement:null,querySelector:()=>null};
 class HTMLElement {isConnected=true;focused=0;focus(){this.focused++;document.activeElement=this;}}
 const origin=new HTMLElement();document.activeElement=origin;
 const env={HTMLElement,document,settingsOrigin,requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id)};
 const code=ts.transpileModule('return ('+hook.arguments[0].getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const effect=settingsOpen=>new Function('settingsOpen',...Object.keys(env),code)(settingsOpen,...Object.values(env))();
 const flush=()=>{for(const [id,frame] of frames){frames.delete(id);frame();}};
 return {effect,flush,document,origin,settingsOrigin,HTMLElement};
}

test('closing settings restores its opener after the dialog unmounts',()=>{
 const f=fixture();f.effect(true);f.document.activeElement=f.document.body;f.effect(false);f.flush();assert.equal(f.origin.focused,1);assert.equal(f.document.activeElement,f.origin);
});
for(const scenario of ['other-input','opener-removed','other-modal','reopened'])test('settings close leaves focus alone when '+scenario,()=>{
 const f=fixture();f.effect(true);f.document.activeElement=f.document.body;const cleanup=f.effect(false);
 if(scenario==='other-input')f.document.activeElement=new f.HTMLElement();
 if(scenario==='opener-removed')f.origin.isConnected=false;
 if(scenario==='other-modal')f.document.querySelector=()=>({});
 if(scenario==='reopened'){cleanup();f.effect(true);}
 f.flush();assert.equal(f.origin.focused,0);
});
test('opening settings without a focusable opener does not make the page body a return target',()=>{
 const f=fixture();f.document.activeElement=f.document.body;f.effect(true);assert.equal(f.settingsOrigin.current,null);assert.equal(f.effect(false),undefined);
});
