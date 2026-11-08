// Author: Jeff.Liu. Review input is scoped to the original verified CLI; no auto-submit.
import test from 'node:test';import assert from 'node:assert/strict';
import {cachedCompilation} from './fixtures/component-function.mjs';
import * as review from '../src/review-feedback.ts';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewOrigin,reviewReady,formatReviewFeedback,combineReviewComments,deliverReviewFeedback} from '../src/review-feedback.ts';
const record=()=>({summary:{session_id:'s-one',cwd:'/repo',status:'running',launch:{adapter:'codex',mode:'interactive'}},status:'running',agent:{generation:'generation-one',agent_session_id:'native-one',integration:'connected',phase:'response_finished'}});
const location={sessionId:'s-one',path:'src/a.ts',line:3,side:'new',basis:'worktree'};
const anchoredLocation={...location,anchor:{root:'/repo',baselineId:null,fingerprint:'a'.repeat(64),context:'+original line',position:JSON.stringify([location.path,location.basis,location.side,location.line])}};
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
const compileFeedback=cachedCompilation(raw=>{
 const source=ts.createSourceFile('ReviewFeedback.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 return ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
});
function reviewStorage(){
 const entries=new Map();
 return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value)};
}
function feedbackFixture(storage=reviewStorage()){
 const body=compileFeedback(readFileSync(new URL('../src/ReviewFeedback.tsx',import.meta.url),'utf8'));
 const slots=[],effects=[];let at=0,queue=[],tree;const fills=[];
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=value=>{const i=at++;return slots[i]??(slots[i]={current:value});};
 const useState=value=>{const i=at++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const scope={React,useRef,useState,useEffect,...review,t:v=>v};
 const component=new Function(...Object.keys(scope),body+';return ReviewFeedback;')(...Object.values(scope));
 const props={active:true,origin:reviewOrigin(record()),ready:true,location:anchoredLocation,storage,onCheck:async(_origin,locations)=>locations.map(()=> 'current'),onFill:async(...args)=>fills.push(args)};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const render=()=>{at=0;tree=component(props);const batch=queue;queue=[];batch.forEach(fn=>fn());};
 const button=label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.filter(c=>typeof c==='string').join('')===label);
 const settle=async()=>{await new Promise(r=>setImmediate(r));render();};
 render();return{props,fills,render,settle,button,field:()=>nodes(tree).find(n=>n.type==='textarea'),text:()=>JSON.stringify(tree),cleanup:()=>effects.forEach(e=>e?.cleanup?.())};
}
test('reopening review restores queued notes and draft with the original session binding',()=>{
 const storage=reviewStorage(),first=feedbackFixture(storage);
 first.field().props.onChange({target:{value:'saved comment'}});first.render();
 first.button('Add comment').props.onClick();first.render();
 first.props.location={...anchoredLocation,path:'src/second.ts',anchor:{...anchoredLocation.anchor,context:'+second line'}};
 first.render();first.button('Use selected diff location').props.onClick();first.render();
 first.field().props.onChange({target:{value:'second comment'}});first.render();
 first.button('Add comment').props.onClick();first.render();
 first.field().props.onChange({target:{value:'unfinished draft'}});first.render();first.cleanup();
 const reopened=feedbackFixture(storage);
 assert.equal(reopened.field().props.value,'unfinished draft');
 assert.match(reopened.text(),/saved comment/);
 assert.match(reopened.text(),/second comment/);
 assert.match(reopened.text(),/original line/);
 reopened.props.origin={...reopened.props.origin,sessionId:'s-two',nativeSessionId:'native-two'};
 reopened.render();
 assert.match(reopened.text(),/native target changed/);
 assert.equal(reopened.button('Fill original CLI input').props.disabled,true);
 assert.deepEqual(reopened.fills,[]);
 reopened.cleanup();
});
test('a stale line disables fill while keeping the original comment visible',async()=>{
 const f=feedbackFixture();
 f.props.onCheck=async(_origin,locations)=>locations.map(point=>point===anchoredLocation?'stale':'current');
 f.field().props.onChange({target:{value:'keep this old note'}});f.render();
 f.button('Add comment').props.onClick();f.render();
 await f.settle();
 assert.match(f.text(),/Original diff location is stale/);
 assert.match(f.text(),/keep this old note/);
 assert.equal(f.button('Fill original CLI input').props.disabled,true);
 assert.match(f.text(),/original line/);
 f.props.location={...anchoredLocation,line:4,anchor:{...anchoredLocation.anchor,context:'+new line'}};
 f.render();f.button('Relocate comment to selected diff location').props.onClick();f.render();await f.settle();
 assert.match(f.text(),/new line/);
 assert.equal(f.button('Fill original CLI input').props.disabled,false);
 f.cleanup();
});
test('real Git insertion and deletion invalidate the original patch position',async()=>{
 assert.equal(typeof review.createReviewAnchor,'function');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'yam-review-diff-')));
 const file=join(root,'a.txt');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{
  encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'},
 });
 const origin={...reviewOrigin(record()),cwd:root};
 const point={...location,path:'a.txt',line:2};
 const original='top\nreview me\nbottom\n';
 try{
  git('init','-q');writeFileSync(file,'top\nold\nbottom\n');git('add','a.txt');
  writeFileSync(file,original);
  const diff=()=>git('diff','--no-ext-diff','--no-textconv','--no-color','--','a.txt');
  const invoke=async(name,args)=>{
   assert.equal(name,'get_git_changes');
   assert.equal(args.path,root);assert.equal(args.selected_path,'a.txt');assert.equal(args.side,'worktree');
   const patch=diff();
   if(!patch)throw 'git_context_changed';
   return {query_token:args.query_token,path:root,root,rows:[{path:'a.txt',staged:'A',worktree:'M',untracked:false,unsupported:false}],patch:{path:'a.txt',side:'worktree',kind:'text',text:patch}};
  };
  const anchor=await review.createReviewAnchor(point,{root,baselineId:null,text:diff()});
  assert.equal(anchor.context,'+review me');
  const saved={...point,anchor};
  assert.deepEqual(await review.checkReviewLocations(origin,[saved],invoke),['current']);
  assert.deepEqual(await review.checkReviewLocations(origin,[
   {...saved,line:999},
   {...saved,side:'old'},
   {...saved,anchor:{...anchor,context:'+wrong context'}},
  ],invoke),['stale','stale','stale']);
  writeFileSync(file,'top\ninserted\nreview me\nbottom\n');
  assert.deepEqual(await review.checkReviewLocations(origin,[saved],invoke),['stale']);
  writeFileSync(file,'top\nbottom\n');
  assert.deepEqual(await review.checkReviewLocations(origin,[saved],invoke),['stale']);
  assert.equal(saved.anchor.context,'+review me');
  writeFileSync(file,'top\nold\nbottom\n');
  assert.deepEqual(await review.checkReviewLocations(origin,[saved],invoke),['stale']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('round location requires its original baseline and reports unreadable diffs separately',async()=>{
 const origin=reviewOrigin(record());
 const point={...location,basis:'round',line:2};
 const patch='@@ -1,2 +1,2 @@\n top\n-old\n+new\n';
 const baseline={id:'baseline-one',root:'/repo',captured_at:1,files:1,skipped:0};
 const saved={...point,anchor:await review.createReviewAnchor(point,{root:'/repo',baselineId:baseline.id,text:patch})};
 const invoke=async(name,args)=>{
  assert.equal(args.session_id,origin.sessionId);
  if(name==='get_run_baseline_info')return baseline;
  assert.deepEqual([name,args.baseline_id,args.path],['compare_run_baseline',baseline.id,point.path]);
  return {baseline,rows:[{path:point.path,kind:'modified'}],skipped:0,patch:{path:point.path,text:patch}};
 };
 assert.deepEqual(await review.checkReviewLocations(origin,[saved],invoke),['current']);
 assert.deepEqual(await review.checkReviewLocations(origin,[saved],async()=>({...baseline,id:'baseline-two'})),['stale']);
 assert.deepEqual(await review.checkReviewLocations(origin,[saved],async()=>null),['stale']);
 assert.deepEqual(await review.checkReviewLocations(origin,[saved],async()=>{throw 'round_timeout';}),['unavailable']);
});
test('a line outside the durable location range cannot produce a review anchor',async()=>{
 const point={...location,line:1048577};
 const text='@@ -1048577 +1048577 @@\n-old\n+new\n';
 await assert.rejects(review.createReviewAnchor(point,{root:'/repo',baselineId:null,text}),reason=>reason==='review_location_unavailable');
 const storage=reviewStorage(),origin=reviewOrigin(record());
 const valid={origin,location:anchoredLocation,text:'keep previous',comments:[]};
 review.saveReviewDraft(valid,storage);
 assert.throws(()=>review.saveReviewDraft({...valid,location:{...anchoredLocation,line:point.line}},storage));
 assert.deepEqual(review.loadReviewDraft(storage).draft,valid);
});
test('a changed round baseline refreshes the panel status without losing the comment',async()=>{
 const f=feedbackFixture();
 f.props.location={...anchoredLocation,basis:'round',anchor:{...anchoredLocation.anchor,baselineId:'base-one'}};
 f.props.locationRevision=0;
 let status='current';
 f.props.onCheck=async()=>[status];
 f.render();
 f.field().props.onChange({target:{value:'round comment'}});f.render();await f.settle();
 assert.equal(f.button('Fill original CLI input').props.disabled,false);
 f.props.locationRevision=null;f.render();await f.settle();
 assert.equal(f.button('Fill original CLI input').props.disabled,true);
 status='stale';f.props.locationRevision=1;f.render();await f.settle();
 assert.match(f.text(),/Original diff location is stale/);
 assert.equal(f.field().props.value,'round comment');
 assert.equal(f.button('Fill original CLI input').props.disabled,true);
 f.cleanup();
});
test('invalid saved bytes are preserved and write failures keep editable text visible',()=>{
 const corrupt=reviewStorage();corrupt.setItem(review.REVIEW_DRAFT_KEY,'broken');
 const first=feedbackFixture(corrupt);
 assert.match(first.text(),/Saved feedback could not be read/);
 first.field().props.onChange({target:{value:'temporary'}});first.render();
 assert.equal(corrupt.getItem(review.REVIEW_DRAFT_KEY),'broken');
 first.button('New feedback').props.onClick();first.render();
 assert.equal(corrupt.getItem(review.REVIEW_DRAFT_KEY),'broken');
 first.button('Discard saved review batch').props.onClick();first.render();
 assert.equal(review.loadReviewDraft(corrupt).problem,null);
 first.cleanup();
 const failed=feedbackFixture({getItem:()=>null,setItem:()=>{throw new Error('quota');}});
 failed.field().props.onChange({target:{value:'still editable'}});failed.render();
 assert.match(failed.text(),/Feedback could not be saved/);
 assert.equal(failed.field().props.value,'still editable');failed.cleanup();
});
test('failed discard preserves the in-memory draft and reports the failed operation',()=>{
 const storage={getItem:()=>'corrupt',setItem:()=>{throw new Error('quota');}};
 const f=feedbackFixture(storage);
 f.field().props.onChange({target:{value:'keep this'}});f.render();
 f.button('New feedback').props.onClick();f.render();
 f.button('Discard saved review batch').props.onClick();f.render();
 assert.equal(f.field().props.value,'keep this');
 assert.match(f.text(),/Could not discard saved feedback/);
 f.cleanup();
});
test('a changed saved coordinate stays stale even when another line has identical text',async()=>{
 const origin=reviewOrigin(record()), point={...location,line:1};
 const text='@@ -0,0 +1,2 @@\n+same\n+same\n';
 const anchor=await review.createReviewAnchor(point,{root:'/repo',baselineId:null,text});
 const invoke=async(_name,args)=>({query_token:args.query_token,path:'/repo',root:'/repo',rows:[
  {path:point.path,staged:' ',worktree:'M',untracked:false,unsupported:false},
 ],patch:{path:point.path,side:'worktree',kind:'text',text}});
 assert.deepEqual(await review.checkReviewLocations(origin,[{...point,anchor},{...point,anchor,line:2}],invoke),['current','stale']);
});
test('relocation that exceeds the paste budget still preserves the saved batch',async()=>{
 const storage=reviewStorage(),f=feedbackFixture(storage);
 f.props.onCheck=async(_origin,locations)=>locations.map(point=>point===anchoredLocation?'stale':'current');
 for(const letter of ['a','b']){
  f.field().props.onChange({target:{value:letter.repeat(7650)}});f.render();
  f.button('Add comment').props.onClick();f.render();
 }
 await f.settle();
 const longPath=Array.from({length:20},()=> 'nested'.repeat(16)).join('/')+'/file.ts';
 f.props.location={...anchoredLocation,path:longPath,line:4};
 f.render();f.button('Relocate comment to selected diff location').props.onClick();f.render();
 f.cleanup();
 const reopened=feedbackFixture(storage);await reopened.settle();
 assert.match(reopened.text(),new RegExp(longPath));
 assert.match(reopened.text(),/bbbbbbbb/);
 assert.equal(reopened.button('Fill original CLI input').props.disabled,true);
 reopened.cleanup();
});
test('late location check after switching sessions cannot enable fill',async()=>{
 const f=feedbackFixture();let resolve;
 f.props.onCheck=()=>new Promise(done=>{resolve=done;});
 f.field().props.onChange({target:{value:'wrong session'}});f.render();
 f.props.origin={...f.props.origin,sessionId:'s-two',nativeSessionId:'native-two'};f.render();
 resolve(['current']);await f.settle();
 assert.equal(f.button('Fill original CLI input').props.disabled,true);
 f.button('Fill original CLI input').props.onClick();
 assert.deepEqual(f.fills,[]);f.cleanup();
});
test('actual feedback UI requires explicit fill, retains text and prevents duplicate delivery',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'review this'}});f.render();await f.settle();assert.equal(f.fills.length,0);
 const fill=f.button('Fill original CLI input');assert.equal(fill.props.disabled,false);fill.props.onClick();fill.props.onClick();await f.settle();assert.equal(f.fills.length,1);assert.equal(f.fills[0][0].nativeSessionId,'native-one');assert.equal(f.field().props.value,'review this');assert.equal(f.button('Fill original CLI input').props.disabled,true);f.cleanup();
});
test('changing the native target keeps the draft and blocks delivery until deliberate rebinding',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'keep this'}});f.render();f.props.origin={...f.props.origin,generation:'changed',nativeSessionId:'native-other'};f.render();
 assert.equal(f.button('Fill original CLI input').props.disabled,true);assert.equal(f.field().props.value,'keep this');assert.equal(f.fills.length,0);
 f.button('Bind current native session').props.onClick();f.render();await f.settle();assert.equal(f.button('Fill original CLI input').props.disabled,false);f.cleanup();
});

test('compiled feedback fixtures keep hook state and callbacks separate',()=>{
 const first=feedbackFixture(),second=feedbackFixture();
 first.field().props.onChange({target:{value:'first draft'}});first.render();second.render();
 assert.equal(first.field().props.value,'first draft');assert.equal(second.field().props.value,'');
 assert.notEqual(first.props,second.props);assert.notEqual(first.fills,second.fills);
 first.cleanup();second.cleanup();
});

const compileAppPaste=cachedCompilation(raw=>{
 const source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='fillReviewInOriginalTerminal')fn=node;ts.forEachChild(node,visit);};visit(source);assert.ok(fn,'actual existing-terminal adapter must be wired');
 return ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
});
function appPasteFixture(){
 const body=compileAppPaste(readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'));
 const pasted=[],notices=[],errors=[];let focus=false,closed=false,current=true,unknown=false;
 const owner={current:{available:true}},mounted={current:true},selected={current:'s-one'};
 const view={ready:true,moving:false,persisted:false,attaching:false,parsing:null,updating:false,projecting:false,resizing:false,clearPending:false,disposed:false,writable:true,instance:{modes:{bracketedPasteMode:true},focus(){focus=true;},paste(text){pasted.push(text);const queue=view.inputQueue??={write:null,version:0,length:0,count:0};queue.write=Promise.resolve().then(()=>{if(unknown)queue.version++;view.writable=!unknown;queue.write=null;});}}};
 let check=async()=>['current'],readRecord=async()=>record();
 const reviewBaselineFence={current:{version:0,pending:0}};
 const reviewAgentVersion={current:0};
 const reviewRecordRef={current:record()};
 const values={isMainWindow:true,terminalMounted:mounted,terminalViews:{current:new Map([['s-one',view]])},sessionId:selected,terminalPasteTarget:()=>({sessionId:'s-one',view}),sameTerminalPasteTarget:()=>current,checkOriginalReviewLocations:(...args)=>check(...args),deliverReviewFeedback,invoke:async(name,args)=>{assert.equal(name,'get_session');assert.equal(args.sessionId,'s-one');return readRecord();},inspectTerminalPaste:text=>({text}),terminalPasteCurrent:()=>current&&owner.current.available&&selected.current==='s-one',ownerConnectionAvailable:owner,pastePending:{current:null},fileDropPending:{current:null},setProjectToolsOpen(){closed=true;},terminalHasInputFocus:()=>focus,setTerminalNotice:value=>notices.push(value),setError:value=>errors.push(value),reviewBaselineFence,reviewReady,reviewRecordRef};
 values.reviewAgentVersion=reviewAgentVersion;
 const render=new Function(...Object.keys(values),body+';return fillReviewInOriginalTerminal;')(...Object.values(values));
 return{view,pasted,notices,errors,owner,selected,run:(point=anchoredLocation,locations=[point])=>render(reviewOrigin(record()),point,'comment',locations),closed:()=>closed,stale:()=>current=false,uncertain:()=>unknown=true,check:fn=>check=fn,read:fn=>readRecord=fn,reviewBaselineFence,reviewRecordRef,reviewAgentVersion};
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
test('actual App never pastes stale locations or a result returned after switching sessions',async()=>{
 const stale=appPasteFixture();stale.check(async()=>['stale']);
 await assert.rejects(stale.run(),reason=>reason==='review_location_stale');
 assert.deepEqual(stale.pasted,[]);assert.equal(stale.closed(),false);
 const unavailable=appPasteFixture();unavailable.check(async()=>['unavailable']);
 await assert.rejects(unavailable.run(),reason=>reason==='review_location_unavailable');
 assert.deepEqual(unavailable.pasted,[]);
 const switched=appPasteFixture();let finish;
 switched.check(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=switched.run();
 await new Promise(resolve=>setImmediate(resolve));
 switched.selected.current='s-two';finish(['current']);
 await assert.rejects(pending,reason=>reason==='review_target_unavailable');
 assert.deepEqual(switched.pasted,[]);
});
test('a round baseline mutation during the native session read stops the paste',async()=>{
 const f=appPasteFixture();
 let finish;
 f.read(()=>new Promise(resolve=>{finish=resolve;}));
 const point={...anchoredLocation,basis:'round',anchor:{...anchoredLocation.anchor,baselineId:'base-one'}};
 const pending=f.run(point);
 await new Promise(resolve=>setImmediate(resolve));
 f.reviewBaselineFence.current={version:2,pending:0};
 finish(record());
 await assert.rejects(pending,reason=>reason==='review_location_stale');
 assert.deepEqual(f.pasted,[]);
 assert.equal(f.closed(),false);
});
test('a Git change while the session read is pending is checked before the paste',async()=>{
 const f=appPasteFixture();
 let finish;
 f.read(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.run();
 await new Promise(resolve=>setImmediate(resolve));
 f.check(async()=>['stale']);
 finish(record());
 await assert.rejects(pending,reason=>reason==='review_location_stale');
 assert.deepEqual(f.pasted,[]);
});
test('a native agent that becomes busy while checking the diff cannot receive feedback',async()=>{
 const f=appPasteFixture();
 let finish;
 f.check(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.run();
 await new Promise(resolve=>setImmediate(resolve));
 f.reviewRecordRef.current.agent.phase='working';
 finish(['current']);
 await assert.rejects(pending,reason=>reason==='review_target_unavailable');
 assert.deepEqual(f.pasted,[]);
});
test('a received agent state event cancels an in-flight fill before the UI refresh',async()=>{
 const f=appPasteFixture();
 let finish;
 f.check(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.run();
 await new Promise(resolve=>setImmediate(resolve));
 f.reviewAgentVersion.current++;
 finish(['current']);
 await assert.rejects(pending,reason=>reason==='review_target_unavailable');
 assert.deepEqual(f.pasted,[]);
});
test('multi-file fill rechecks an earlier file after the initial batch read settles',async()=>{
 const f=appPasteFixture(), second={...anchoredLocation,path:'src/b.ts'};
 let checks=0;
 f.check(async(_origin,points)=>{
  checks++;
  return points.map(point=>checks>1&&point.path===anchoredLocation.path?'stale':'current');
 });
 await assert.rejects(f.run(anchoredLocation,[anchoredLocation,second]),reason=>reason==='review_location_stale');
 assert.equal(checks,2);
 assert.deepEqual(f.pasted,[]);
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
 f.props.location={...anchoredLocation,path:'b.ts',line:8};f.render();f.button('Use selected diff location').props.onClick();f.render();f.field().props.onChange({target:{value:'second'}});f.render();await f.settle();f.button('Fill original CLI input').props.onClick();await f.settle();assert.equal(f.fills.length,1);assert.match(f.fills[0][2],/first/);assert.match(f.fills[0][2],/b.ts/);assert.match(f.fills[0][2],/second/);assert.deepEqual(f.fills[0][3].map(point=>point.path),['src/a.ts','b.ts']);f.cleanup();
});

test('queue budget rejects oversized framing before clearing the draft and explains changed queued targets',async()=>{
 const f=feedbackFixture();f.field().props.onChange({target:{value:'x'.repeat(16300)}});f.render();assert.equal(f.button('Add comment').props.disabled,true);assert.equal(f.field().props.value.length,16300);
 f.field().props.onChange({target:{value:'kept'}});f.render();f.button('Add comment').props.onClick();f.render();f.props.origin={...f.props.origin,generation:'changed'};f.render();assert.match(f.text(),/native target changed/);assert.equal(f.button('Bind current native session').props.disabled,true);assert.equal(f.button('Fill original CLI input').props.disabled,true);f.cleanup();
});
