// Author: Jeff.Liu. Recovery actions must distinguish new shells from original Agent conversations.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {sessionRecovery} from '../src/session-recovery.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const record=()=>({summary:{session_id:'old',cwd:'/project',command:null,launch:null},status:'stopped',agent:{generation:'g',agent_session_id:'01a0f6ec-5463-78c3-a404-5a7ad3b933fa'}});
function find(predicate){let found;function visit(n){if(predicate(n))found=n;ts.forEachChild(n,visit);}visit(source);assert.ok(found);return found;}
function policy(r,availability='available',shown='old'){return sessionRecovery(r,'old',shown,r.status,false,availability);}
test('only ended, available, selected local sessions offer a new terminal',()=>{
 const r=record();assert.equal(policy(r).canOpenTerminal,true);assert.equal(policy(r).canContinue,false);
 assert.match(policy(r).notice,/new terminal/i);
 for(const change of [r=>r.status='running',r=>r.status='starting',r=>r.summary.ssh={host:'remote'}]){const r=record();change(r);assert.equal(policy(r).canOpenTerminal,false);}
 for(const state of ['owner_unavailable','terminal_unavailable'])assert.equal(policy(record(),state).canOpenTerminal,false);
 assert.equal(policy(record(),'available','other').canOpenTerminal,false);
});
test('ended Agent can open a shell independently of validated original conversation continuation',()=>{
 const r=record();r.summary.launch={adapter:'codex',mode:'interactive',extra_args:''};let p=policy(r);assert.equal(p.canOpenTerminal,true);assert.equal(p.canContinue,true);
 r.agent.agent_session_id='invalid';p=policy(r);assert.equal(p.canContinue,false);assert.equal(p.canOpenTerminal,true);
});
test('actual new-terminal action only opens a shell in the selected directory and rejects stale selection',()=>{
 const helpers=['selectedRecovery','openSelectedTerminal'].map(name=>find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(source)).join('\n');
 const r=record(),calls=[],sessionId={current:'old'};const values={session:r.summary,selectedRecord:{current:r},sessionId,sessionStatus:'stopped',starting:false,ownerConnectionAvailable:{current:{available:true}},terminalViews:{current:{get:()=>({availability:'available'})}},sessionRecovery,newTerminal:(...args)=>calls.push(args)};
 const run=new Function(...Object.keys(values),ts.transpileModule(helpers,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return openSelectedTerminal;')(...Object.values(values));
 run();assert.deepEqual(calls,[['/project',null]]);sessionId.current='other';run();assert.equal(calls.length,1);
});
test('ended shell notice offers a new terminal without a misleading old-task rerun button',()=>{
 const node=find(n=>ts.isJsxExpression(n)&&n.getText(source).includes('recoveryNotice &&')&&n.getText(source).includes('session-ended-actions'));
 const r=record(),recovery=policy(r),calls=[];const values={React:{createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})},t:s=>s,session:r.summary,isRunning:false,recovery,recoveryNotice:recovery.notice,canContinue:false,openSelectedTerminal:()=>calls.push('new'),resumeSelectedSession:()=>calls.push('resume'),rerunSelectedSession:()=>calls.push('rerun')};
 const rendered=new Function(...Object.keys(values),ts.transpileModule('return ('+node.expression.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText)(...Object.values(values));
 const nodes=n=>[n,...(n?.props?.children??[]).filter(v=>v&&typeof v==='object').flatMap(nodes)];const buttons=nodes(rendered).filter(n=>n?.type==='button');assert.equal(buttons.length,1);assert.ok(buttons[0].props.children.includes('Open new terminal'));buttons[0].props.onClick();assert.deepEqual(calls,['new']);
});

test('owner outage has one recovery banner while available scenes keep their contextual notice',()=>{
 const node=find(n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='recoveryNotice');
 const evaluate=available=>new Function('ownerConnectionAvailable','recovery','terminalNotice','return ('+node.initializer.getText(source)+')')({current:{available}},{notice:'Background unavailable'},'Saved scene');
 assert.equal(evaluate(false),null);assert.equal(evaluate(true),'Background unavailable');
});
