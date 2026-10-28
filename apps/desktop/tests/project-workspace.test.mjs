// Author: Jeff.Liu.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workspaceWidth,resizeWorkspace} from '../src/project-workspace.ts';
test('workspace width restores valid preferences and rejects corrupt or out-of-range storage',()=>{
 for(const raw of [null,'','bad','null','{}','"600"','NaN'])assert.equal(workspaceWidth(raw),560);
 assert.equal(workspaceWidth('620'),620);assert.equal(workspaceWidth('100'),360);assert.equal(workspaceWidth('99999'),900);
});
test('workspace pointer resizing grows leftwards and stays bounded',()=>{
 assert.equal(resizeWorkspace(560,500,460),600);assert.equal(resizeWorkspace(560,500,600),460);
 assert.equal(resizeWorkspace(560,500,2000),360);assert.equal(resizeWorkspace(560,500,-2000),900);
 assert.equal(resizeWorkspace(560,500,NaN),560);
});
test('project tools are a persistent nonmodal workspace with shared inset and local keyboard scope',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),component=readFileSync(new URL('../src/ProjectWorkspace.tsx',import.meta.url),'utf8'),css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');
 assert.match(app,/<ProjectWorkspace\b/);assert.doesNotMatch(app,/projectToolsDialog/);
 assert.match(component,/<aside\b/);assert.match(component,/hidden=\{!open\}/);assert.doesNotMatch(component,/showModal|aria-modal/);
 assert.match(component,/role="separator"/);assert.match(component,/setPointerCapture/);assert.match(component,/ArrowLeft/);
 assert.match(css,/\.project-workspace\[hidden\]/);assert.match(css,/\.project-workspace\s*\{[^}]*min-width:\s*0/);
});

test('closing workspace restores the same terminal only while focus and selection still belong to that action',async()=>{
 const ts=(await import('typescript')).default;
 const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let declaration;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='closeProjectTools')declaration=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(declaration);
 for(const scenario of ['same','other-input','other-session','modal','reopened']){
  const origin={},document={activeElement:origin,body:{},querySelector:()=>scenario==='modal'?{}:null},sessionId={current:'s-one'},frames=[],calls=[];
  const projectToolsOpenRef={current:false};const env={projectToolsOpenRef,sessionId,document,setProjectToolsOpen:v=>calls.push(['open',v]),requestAnimationFrame:fn=>frames.push(fn),requestTerminalLayoutFit:()=>calls.push(['fit']),showConversation:v=>calls.push(['conversation',v]),focusTerminalPane:(...args)=>calls.push(['focus',...args]),terminalLayoutRef:{current:{focused:0}}};
  const run=new Function(...Object.keys(env),ts.transpileModule(declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return closeProjectTools;')(...Object.values(env));run();
  if(scenario==='reopened')projectToolsOpenRef.current=true;if(scenario==='other-input')document.activeElement={};if(scenario==='other-session')sessionId.current='s-other';frames[0]();assert.equal(calls.some(v=>v[0]==='focus'),scenario==='same');
 }
});

test('native close uses only the visible file target and otherwise returns from the workspace',async()=>{
 const ts=(await import('typescript')).default,raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let fn;function find(n){if(ts.isBinaryExpression(n)&&n.left.getText(ast)==='nativeMenuHandler.current')fn=n.right;ts.forEachChild(n,find);}find(ast);assert.ok(fn);
 for(const hasFile of [true,false]){let closed=0,files=0;const root={querySelector:selector=>{assert.match(selector,/not\(\[hidden\]\)/);return hasFile?{click(){files++;}}:null;}};const env={document:{querySelector:()=>null,activeElement:{closest:()=>root}},closeProjectTools:()=>closed++};
 const action=new Function(...Object.keys(env),ts.transpileModule('const action='+fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return action;')(...Object.values(env));action('hide');assert.equal(files,hasFile?1:0);assert.equal(closed,hasFile?0:1);}
});
