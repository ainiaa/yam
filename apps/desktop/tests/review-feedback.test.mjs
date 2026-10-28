// Author: Jeff.Liu. Review input is scoped to the original verified CLI; no auto-submit.
import test from 'node:test';import assert from 'node:assert/strict';
import {reviewOrigin,reviewReady,formatReviewFeedback,combineReviewComments,deliverReviewFeedback} from '../src/review-feedback.ts';
const record=()=>({summary:{session_id:'s-one',cwd:'/repo',status:'running',launch:{adapter:'codex',mode:'interactive'}},status:'running',agent:{generation:'generation-one',agent_session_id:'native-one',integration:'connected',phase:'response_finished'}});
const location={sessionId:'s-one',path:'src/a.ts',line:3,side:'new',basis:'worktree'};
test('feedback retains file and side context while rejecting terminal controls, invalid Unicode and oversized input',()=>{
 const origin=reviewOrigin(record());assert.ok(origin);const text=formatReviewFeedback(origin,location,'请修复边界条件\n再检查错误处理');assert.match(text,/src\/a.ts/);assert.match(text,/new.*3/);assert.match(text,/请修复/);assert.doesNotMatch(text,/\x1b/);
 for(const body of ['', 'bad\x1b[201~\rwhoami','bad\0text','\ud800','x'.repeat(16385)])assert.throws(()=>formatReviewFeedback(origin,location,body));
 for(const path of ['../outside','/absolute','.git/config','bad\nname'])assert.throws(()=>formatReviewFeedback(origin,{...location,path},'comment'));
 assert.throws(()=>formatReviewFeedback(origin,{...location,sessionId:'other'},'comment'));
 assert.throws(()=>formatReviewFeedback(origin,{...location,line:0},'comment'));
});
test('readiness requires the original native identity and a connected running interactive agent',()=>{
 const origin=reviewOrigin(record());assert.equal(reviewReady(record(),origin),true);
 for(const phase of ['working','needs_permission','needs_attention','unknown']){const value=record();value.agent.phase=phase;assert.equal(reviewReady(value,origin),false);}
 for(const edit of [v=>v.status='stopped',v=>v.agent.integration='unavailable',v=>v.agent.generation='another',v=>v.agent.agent_session_id='another',v=>v.summary.cwd='/different',v=>v.summary.launch.adapter='shell',v=>v.summary.ssh={}]){const value=record();edit(value);assert.equal(reviewReady(value,origin),false);}
 const legacy=record();delete legacy.agent.generation;assert.equal(reviewOrigin(legacy),null);
});
test('delivery checks fresh native state and invokes only the explicit paste callback',async()=>{
 const origin=reviewOrigin(record()),pasted=[];await deliverReviewFeedback(origin,location,'comment',async()=>record(),async text=>pasted.push(text));assert.equal(pasted.length,1);assert.equal(pasted[0].endsWith('\r'),false);
 const changed=record();changed.agent.generation='other';await assert.rejects(deliverReviewFeedback(origin,location,'comment',async()=>changed,async()=>{throw Error('cannot paste');}),error=>error==='review_target_unavailable');
 await assert.rejects(deliverReviewFeedback(origin,location,'comment',async()=>{throw Error('secret detail');},async()=>{}),error=>error==='review_target_unavailable');
});

import {readFileSync} from 'node:fs';import ts from 'typescript';
import {sameReviewOrigin} from '../src/review-feedback.ts';
function feedbackFixture(){
 const raw=readFileSync(new URL('../src/ReviewFeedback.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('ReviewFeedback.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[];let at=0,queue=[],tree;const fills=[];
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=value=>{const i=at++;return slots[i]??(slots[i]={current:value});};
 const useState=value=>{const i=at++;if(!(i in slots))slots[i]=value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const component=new Function('React','useRef','useState','useEffect','sameReviewOrigin','formatReviewFeedback','combineReviewComments','t',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return ReviewFeedback;')(React,useRef,useState,useEffect,sameReviewOrigin,formatReviewFeedback,combineReviewComments,v=>v);
 const props={active:true,origin:reviewOrigin(record()),ready:true,location,onFill:async(...args)=>fills.push(args)};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const render=()=>{at=0;tree=component(props);const batch=queue;queue=[];batch.forEach(fn=>fn());};
 const button=label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.filter(c=>typeof c==='string').join('')===label);
 const settle=async()=>{await new Promise(r=>setImmediate(r));render();};
 render();return{props,fills,render,settle,button,field:()=>nodes(tree).find(n=>n.type==='textarea'),text:()=>JSON.stringify(tree),cleanup:()=>effects.forEach(e=>e?.cleanup?.())};
}
test('actual feedback UI requires explicit fill, retains text and prevents duplicate delivery',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'review this'}});f.render();assert.equal(f.fills.length,0);
 const fill=f.button('Fill original CLI input');assert.equal(fill.props.disabled,false);fill.props.onClick();fill.props.onClick();await f.settle();assert.equal(f.fills.length,1);assert.equal(f.fills[0][0].nativeSessionId,'native-one');assert.equal(f.field().props.value,'review this');assert.equal(f.button('Fill original CLI input').props.disabled,true);f.cleanup();
});
test('changing the native target keeps the draft and blocks delivery until deliberate rebinding',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'keep this'}});f.render();f.props.origin={...f.props.origin,generation:'changed',nativeSessionId:'native-other'};f.render();
 assert.equal(f.button('Fill original CLI input').props.disabled,true);assert.equal(f.field().props.value,'keep this');assert.equal(f.fills.length,0);
 f.button('Bind current native session').props.onClick();f.render();assert.equal(f.button('Fill original CLI input').props.disabled,false);f.cleanup();
});

function appPasteFixture(){
 const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='fillReviewInOriginalTerminal')fn=node;ts.forEachChild(node,visit);};visit(source);assert.ok(fn,'actual existing-terminal adapter must be wired');
 const pasted=[],notices=[],errors=[];let focus=false,closed=false,current=true,unknown=false;
 const owner={current:{available:true}},mounted={current:true},selected={current:'s-one'};
 const view={ready:true,moving:false,persisted:false,attaching:false,parsing:null,updating:false,projecting:false,resizing:false,clearPending:false,disposed:false,writable:true,instance:{modes:{bracketedPasteMode:true},focus(){focus=true;},paste(text){pasted.push(text);const queue=view.inputQueue??={write:null,version:0,length:0,count:0};queue.write=Promise.resolve().then(()=>{if(unknown)queue.version++;view.writable=!unknown;queue.write=null;});}}};
 const values={isMainWindow:true,terminalMounted:mounted,terminalViews:{current:new Map([['s-one',view]])},sessionId:selected,terminalPasteTarget:()=>({sessionId:'s-one',view}),deliverReviewFeedback,invoke:async(name,args)=>{assert.equal(name,'get_session');assert.equal(args.sessionId,'s-one');return record();},inspectTerminalPaste:text=>({text}),terminalPasteCurrent:()=>current&&owner.current.available&&selected.current==='s-one',ownerConnectionAvailable:owner,pastePending:{current:null},fileDropPending:{current:null},setProjectToolsOpen(){closed=true;},terminalHasInputFocus:()=>focus,setTerminalNotice:value=>notices.push(value),setError:value=>errors.push(value)};
 const render=new Function(...Object.keys(values),ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+';return fillReviewInOriginalTerminal;')(...Object.values(values));
 return{view,pasted,notices,errors,owner,selected,run:()=>render(reviewOrigin(record()),location,'comment'),closed:()=>closed,stale:()=>current=false,uncertain:()=>unknown=true};
}
test('actual App fills through the original terminal paste path without Enter and rejects unsafe target states',async()=>{
 const good=appPasteFixture();await good.run();assert.equal(good.pasted.length,1);assert.equal(good.pasted[0].endsWith('\r'),false);assert.equal(good.closed(),true);assert.equal(good.notices.length,1);
 for(const change of [f=>f.view.instance.modes.bracketedPasteMode=false,f=>f.owner.current.available=false,f=>f.selected.current='other',f=>f.view.moving=true,f=>f.view.parsing=Promise.resolve(),f=>f.view.inputQueue={write:Promise.resolve(),version:0,length:1,count:1}]){
  const f=appPasteFixture();change(f);await assert.rejects(f.run(),error=>error==='review_target_unavailable');assert.equal(f.pasted.length,0);
 }
 const uncertain=appPasteFixture();uncertain.uncertain();await assert.rejects(uncertain.run(),error=>error==='review_delivery_unknown');assert.equal(uncertain.pasted.length,1);
});
test('actual App revalidates target and focus after the fresh native read',async()=>{
 const stale=appPasteFixture();const pending=stale.run();stale.stale();await assert.rejects(pending,error=>error==='review_target_unavailable');assert.equal(stale.pasted.length,0);
 const noFocus=appPasteFixture();noFocus.view.instance.focus=()=>{};await assert.rejects(noFocus.run(),error=>error==='review_target_unavailable');assert.equal(noFocus.pasted.length,0);
});
import {createRequire} from 'node:module';
test('native terminal snapshot serialization preserves bracketed paste mode without any desktop launch',async()=>{
 const require=createRequire(import.meta.url),{Terminal}=require('@xterm/headless'),{SerializeAddon}=require('@xterm/addon-serialize');
 const original=new Terminal({allowProposedApi:true}),restored=new Terminal({allowProposedApi:true}),addon=new SerializeAddon();original.loadAddon(addon);
 try{await new Promise(resolve=>original.write('\x1b[?2004h',resolve));await new Promise(resolve=>restored.write(addon.serialize(),resolve));assert.equal(restored.modes.bracketedPasteMode,true);}finally{original.dispose();restored.dispose();}
});

test('multiple locations collect into one bounded original-session input',async()=>{
 const {combineReviewComments}=await import('../src/review-feedback.ts');const origin=reviewOrigin(record());
 const text=combineReviewComments(origin,[{location,text:'first'},{location:{...location,path:'b.ts',line:8},text:'second'}]);assert.match(text,/src\/a.ts/);assert.match(text,/b.ts/);assert.match(text,/second/);
 assert.throws(()=>combineReviewComments(origin,[]));assert.throws(()=>combineReviewComments(origin,Array.from({length:21},()=>({location,text:'a'}))));assert.throws(()=>combineReviewComments(origin,[{location:{...location,sessionId:'other'},text:'bad'}]));assert.throws(()=>combineReviewComments(origin,[{location,text:'a'.repeat(9000)},{location,text:'b'.repeat(9000)}]));
});
test('feedback UI retains comments at separate locations and fills them once',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'first'}});f.render();f.button('Add comment').props.onClick();f.render();assert.equal(f.field().props.value,'');assert.equal(f.fills.length,0);
 f.props.location={...location,path:'b.ts',line:8};f.render();f.button('Use selected diff location').props.onClick();f.render();f.field().props.onChange({target:{value:'second'}});f.render();f.button('Fill original CLI input').props.onClick();await f.settle();assert.equal(f.fills.length,1);assert.match(f.fills[0][2],/first/);assert.match(f.fills[0][2],/b.ts/);assert.match(f.fills[0][2],/second/);f.cleanup();
});

test('queue budget rejects oversized framing before clearing the draft and explains changed queued targets',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'x'.repeat(16300)}});f.render();assert.equal(f.button('Add comment').props.disabled,true);assert.equal(f.field().props.value.length,16300);
 f.field().props.onChange({target:{value:'kept'}});f.render();f.button('Add comment').props.onClick();f.render();f.props.origin={...f.props.origin,generation:'changed'};f.render();assert.match(f.text(),/native target changed/);assert.equal(f.button('Bind current native session').props.disabled,true);assert.equal(f.button('Fill original CLI input').props.disabled,true);f.cleanup();
});
