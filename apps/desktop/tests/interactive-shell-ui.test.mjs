// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {agentLabel} from '../src/agent-events.ts';
const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(predicate(node))result=node;ts.forEachChild(node,visit);}visit(source);return result;}
function condition(node){return new Function('session','currentAgent',`return (${node.getText(source)});`);}
test('live Shell has its own label while ended terminals cannot advertise readiness',()=>{
 const shell={phase:'shell',integration:'disconnected',agent_session_id:'previous',inbox:[]};
 assert.equal(agentLabel(shell,'running'),'Shell · waiting for input');
 assert.equal(agentLabel(shell,'stopped'),'Agent exited');
 assert.equal(agentLabel({...shell,phase:'idle',integration:'connected'},'running'),'Ready');
});
test('actual Pi controls disappear in Shell and return when a new Pi run starts',()=>{
 const bar=find(n=>ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='PiRoutingBar');assert.ok(bar);
 assert.ok(ts.isBinaryExpression(bar.parent));const visible=condition(bar.parent.left);
 const session={launch:{adapter:'pi'}},shell={phase:'shell'};
 assert.equal(Boolean(visible(session,shell)),false);
 assert.equal(Boolean(visible(session,{phase:'idle'})),true);
 assert.equal(Boolean(visible({launch:{adapter:'codex'}},{phase:'idle'})),false);
});
test('workspace CLI badge shows Shell after Pi exits',()=>{
 const badge=find(n=>ts.isJsxElement(n)&&n.openingElement.attributes.getText(source).includes('className="session-agent"'));assert.ok(badge);
 const expression=badge.children.find(ts.isJsxExpression)?.expression;assert.ok(expression);
 const render=condition(expression);const session={launch:{adapter:'pi'}};
 assert.equal(render(session,{phase:'shell'}),'Shell');assert.equal(render(session,{phase:'idle'}),'pi');
});
