import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Executes the actual reader component with bounded React hook seams.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';import ts from 'typescript';
import {ConversationController} from '../src/conversation-view.ts';
const tick=()=>new Promise(r=>setImmediate(r));
const item=(id,kind='agent',extra={})=>({id,turn_id:'turn',kind,text:`text-${id}`,paths:[],truncated:false,...extra});
function fixture(measureLayout=false){
 const raw=readFileSync(new URL('../src/ConversationView.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('ConversationView.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[],calls=[],pending=[];let at=0,queue=new Map(),tree,updates=0,focused=0;
 const panel={scrollTop:120,scrollHeight:500,clientHeight:200,focus(){focused++;},contains(node){return node?.inPanel===true;}};
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=initial=>{const i=at++;return slots[i]??(slots[i]={current:initial});};const useState=initial=>{const i=at++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{updates++;slots[i]=typeof v==='function'?v(slots[i]):v;}];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.set(i,()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 function FilePreview(){}
 const component=new Function('React','useRef','useState','useEffect','ConversationController','FilePreview','document',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return ConversationView;')(React,useRef,useState,useEffect,ConversationController,FilePreview,{activeElement:null});
 const props={scope:'A',visible:false,available:true,target:{sessionId:'s-one',threadId:'native-one',generation:'g'},invoke:(name,args)=>{calls.push([name,args]);return name==='cancel_codex_conversation'?Promise.resolve():new Promise((resolve,reject)=>pending.push({args,resolve,reject}));}};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 function refresh(flush=true){at=0;tree=component(props);for(const n of nodes(tree))if(n.props?.ref)n.props.ref.current=panel;if(panel.focusControl)panel.focusControl.disabled=nodes(tree).find(n=>n.type==='button'&&n.props.children.join('')==='Load older messages')?.props.disabled;if(flush){const q=queue;queue=new Map();q.forEach(fn=>fn());}}
 function resolve(items=[item('two'),item('one','user')],extra={}){const p=pending.at(-1);p.resolve({query_token:p.args.query_token,session_id:p.args.session_id,thread_id:props.target.threadId,generation:props.target.generation,read_at:1,direction:'desc',items,next_cursor:'next',...extra});}
 if(measureLayout)Object.defineProperty(panel,'scrollHeight',{get:()=>300+nodes(tree).filter(n=>n.type==='article').length*100+(nodes(tree).some(n=>n.type==='p'&&n.props.children.join('')==='Loading conversation…')?24:0)});
 refresh();return {props,calls,pending,panel,FilePreview,resolve,refresh,cleanup:()=>effects.forEach(e=>e?.cleanup?.()),nodes:()=>nodes(tree),button:label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.join('')===label),get text(){return JSON.stringify(tree);},get updates(){return updates;},get focused(){return focused;}};
}
test('R3B actual reader is explicit, read only and renders chronological inert messages with collapsed tools',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);f.props.visible=true;f.refresh();f.refresh();assert.match(f.text,/Loading conversation/);f.resolve([item('f','file',{paths:['/repo/changed.ts']}),item('t','tool',{text:'<script>literal</script>',truncated:true}),item('a','agent'),item('u','user'),item('x','unknown')]);await tick();f.refresh();
 const articles=f.nodes().filter(n=>n.type==='article');assert.deepEqual(articles.map(n=>n.props['data-item-id']),['x','u','a','t','f']);assert.match(f.text,/Read.only history/);assert.match(f.text,/Read at/);assert.match(f.text,/Unsupported record/);assert.match(f.text,/64 KiB/);assert.ok(f.nodes().some(n=>n.type==='details'&&!n.props.open));assert.equal(f.nodes().some(n=>['iframe','img','a','script','textarea'].includes(n.type)||n.props?.dangerouslySetInnerHTML),false);
 f.button('Preview /repo/changed.ts').props.onClick();f.refresh();const preview=f.nodes().find(n=>n.type===f.FilePreview);assert.deepEqual(preview.props.request.target,{sessionId:'s-one',path:'/repo/changed.ts'});assert.equal('root' in preview.props.request.target,false);f.cleanup();
});
test('R3B load more preserves content and scroll anchor, toggle keeps position, stale scope never flashes',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();f.panel.scrollTop=80;f.panel.scrollHeight=500;f.button('Load older messages').props.onClick();f.refresh();assert.match(f.text,/text-one/);assert.equal(f.panel.scrollTop,80);f.resolve([item('zero')],{next_cursor:null});await tick();f.panel.scrollHeight=650;f.refresh();assert.equal(f.panel.scrollTop,230);
 f.props.visible=false;f.refresh();assert.equal(f.nodes()[0].props.hidden,true);f.props.visible=true;f.refresh();assert.equal(f.panel.scrollTop,230);assert.ok(f.focused>0);
 f.props.scope='B';f.props.target={sessionId:'s-other',threadId:'other',generation:'g2'};f.refresh(false);assert.doesNotMatch(f.text,/text-one/);f.refresh();f.cleanup();
});
test('R3B empty, unavailable, disconnected and unsupported histories preserve terminal guidance',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.resolve([],{next_cursor:null});await tick();f.refresh();assert.match(f.text,/No saved messages/);f.props.scope='unsupported';f.refresh();f.pending.at(-1).reject('conversation_unsupported');await tick();f.refresh();assert.match(f.text,/conversation_unsupported/);assert.match(f.text,/Terminal/);assert.ok(f.button('Retry conversation'));f.props.available=false;f.refresh();assert.match(f.text,/Background connection unavailable/);f.props.available=true;f.props.target=null;f.refresh();assert.match(f.text,/verified local Codex/);f.cleanup();
});
test('R3B close and unmount cancel reading and fence late component updates',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.props.visible=false;f.refresh();assert.ok(f.calls.some(c=>c[0]==='cancel_codex_conversation'));f.resolve([item('late')]);await tick();f.refresh();assert.doesNotMatch(f.text,/text-late/);f.props.visible=true;f.refresh();f.cleanup();const before=f.updates;f.resolve();await tick();assert.equal(f.updates,before);
});
test('R3B App keeps TerminalLayout mounted and separates input from the reader',()=>{
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');assert.match(source,/<ConversationView\s/);assert.match(source,/hidden=\{conversationOpen\}/);assert.match(source,/inert=\{conversationOpen\}/);assert.match(source,/if\(focusInput&&!conversationOpenRef.current/);assert.match(source,/aria-pressed=\{conversationOpen\}/);
 const ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let layout;function walk(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)==='TerminalLayout')layout=n;ts.forEachChild(n,walk);}walk(ast);assert.ok(layout);for(let n=layout.parent;n&&!ts.isReturnStatement(n);n=n.parent)assert.equal(ts.isConditionalExpression(n)||ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken,false);
});
test('R3B App reads the latest authenticated agent identity and hides terminal find while reading',()=>{
 const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');const reader=source.slice(source.indexOf('<ConversationView '),source.indexOf('invoke={invoke}/>',source.indexOf('<ConversationView ')));
 assert.match(reader,/currentAgent\?\.generation/);assert.match(reader,/currentAgent\.agent_session_id/);assert.doesNotMatch(reader,/record\?\.agent/);assert.match(source,/!conversationOpen&&scrollView\?\.find/);
});
test('R3B reopening during cancelled pagination retains all loaded records and last reader focus',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();f.button('Load older messages').props.onClick();f.resolve([item('zero')],{next_cursor:'older'});await tick();f.refresh();
 let focus=0;const focused={inPanel:true,disabled:false,focus(){if(!this.disabled)focus++;}};f.panel.focusControl=focused;f.nodes()[0].props.onFocusCapture({target:focused});f.button('Load older messages').props.onClick();const reads=f.pending.length;f.props.visible=false;f.refresh();assert.equal(focused.disabled,true);f.resolve([item('late')]);await tick();f.props.visible=true;f.refresh();f.refresh();assert.equal(focus,1);assert.equal(f.pending.length,reads);assert.match(f.text,/text-zero/);assert.match(f.text,/text-two/);assert.doesNotMatch(f.text,/text-late/);f.cleanup();
});
test('R3C explicit refresh merges latest messages without moving a reader who scrolls during loading',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();f.panel.scrollTop=50;f.button('Refresh conversation').props.onClick();f.refresh();f.panel.scrollTop=30;f.resolve([item('three'),item('two')],{next_cursor:'fresh'});await tick();f.refresh();assert.equal(f.panel.scrollTop,30);assert.match(f.text,/text-one/);assert.match(f.text,/text-three/);f.cleanup();
});
test('R3C visible trusted revisions refresh once, hidden and older notifications do not poll',async()=>{
 const f=fixture();f.props.roundRevision=4;f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();assert.equal(f.pending.length,1);
 f.props.roundRevision=5;f.refresh();assert.equal(f.pending.length,2);f.props.roundRevision=4;f.refresh();f.props.roundRevision=5;f.refresh();assert.equal(f.pending.length,2);f.resolve();await tick();f.refresh();f.props.visible=false;f.refresh();f.props.roundRevision=10;f.refresh();assert.equal(f.pending.length,2);f.props.visible=true;f.refresh();assert.equal(f.pending.length,3);f.cleanup();
 const source=readFileSync(new URL('../src/ConversationView.tsx',import.meta.url),'utf8');assert.doesNotMatch(source,/setInterval|setTimeout/);
});
test('I1 reader always exposes Terminal fallback even after the selected view disappears',()=>{
 const f=fixture();let terminal=0;f.props.visible=true;f.props.target=null;f.props.onTerminal=()=>terminal++;f.refresh();assert.ok(f.button('Open Terminal'));f.button('Open Terminal').props.onClick();assert.equal(terminal,1);f.cleanup();
});
test('I1 focusing the reader section itself never replaces its last focused descendant',async()=>{
 const f=fixture();f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();let restored=0;const control={inPanel:true,focus(){restored++;}};f.nodes()[0].props.onFocusCapture({target:control,currentTarget:f.panel});f.nodes()[0].props.onFocusCapture({target:f.panel,currentTarget:f.panel});f.props.visible=false;f.refresh();f.props.visible=true;f.refresh();f.refresh();assert.equal(restored,1);f.cleanup();
});

test('followup loading layout keeps the same message anchor while older messages prepend',async()=>{
 const f=fixture(true);f.props.visible=true;f.refresh();f.resolve();await tick();f.refresh();f.panel.scrollTop=80;
 const before=f.panel.scrollHeight;f.button('Load older messages').props.onClick();f.refresh();assert.equal(f.panel.scrollHeight,before,'loading status must not insert layout above saved messages');
 f.panel.scrollTop=60;f.resolve([item('zero')],{next_cursor:'older'});await tick();f.refresh();assert.equal(f.panel.scrollTop,160,'preserve the reader position reached during loading plus the new article height');f.cleanup();
});
