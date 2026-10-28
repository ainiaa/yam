// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePiDraft,buildPiArgs,validatePiDraft} from '../src/pi-routing.ts';
const models=[{key:'p/small',name:'Small',levels:['medium','high'],context_window:10000},{key:'p/strong',name:'Strong',levels:['medium','high','max'],context_window:100000}];
const draft={gateway:null,small:'p/small',strong:'p/strong',classifier:'',model:'auto',effort:'auto'};
test('Pi form roundtrips roles and independent model/effort without changing literal advanced arguments',()=>{
 const args='--tools read,bash --append-system-prompt "literal $HOME `date`" --yam-small p/old --yam-strong p/strong';
 const saved=buildPiArgs(args,{...draft,model:'p/strong',effort:'auto'});
 assert.deepEqual(parsePiDraft(saved),{...draft,model:'p/strong',effort:'auto'});
 assert.ok(saved.includes('--append-system-prompt "literal $HOME `date`"'));
 assert.equal((saved.match(/--yam-small /g)||[]).length,1);
});
test('Pi form preserves legacy physical model suffix and thinking selections',()=>{
 const d=parsePiDraft('--model p/strong:high --yam-small p/small --yam-strong p/strong');
 assert.equal(d.model,'p/strong');assert.equal(d.effort,'high');
 const e=parsePiDraft('--model p/strong --thinking max --yam-small p/small --yam-strong p/strong');assert.equal(e.effort,'max');
});
test('Pi preflight refuses missing models and unsupported locked effort but allows strong-model fallback',()=>{
 assert.equal(validatePiDraft(draft,models),null);
 assert.equal(validatePiDraft({...draft,effort:'max'},models),null);
 assert.ok(validatePiDraft({...draft,model:'p/small',effort:'max'},models));
 assert.ok(validatePiDraft({...draft,small:'unknown/model'},models));
 assert.ok(validatePiDraft({...draft,gateway:'http://other-host'},models));
 assert.throws(()=>parsePiDraft('--yam-small "unterminated'),/argument|quote/i);
});
test('Pi form does not reinterpret an explicit physical off selection as automatic reasoning',()=>{
 const physical=parsePiDraft('--yam-small p/small --yam-strong p/strong --model p/strong --thinking off');assert.equal(physical.effort,'off');
 assert.equal(parsePiDraft(buildPiArgs('',physical)).effort,'off');
 const automatic=parsePiDraft('--yam-small p/small --yam-strong p/strong --model yam/auto --thinking off');assert.equal(automatic.effort,'off');
});
test('Explicit native Pi model and reasoning arguments override older graphical defaults',()=>{
 const d=parsePiDraft('--yam-small p/small --yam-strong p/strong --yam-fixed-model auto --yam-effort auto --model p/strong --thinking high');assert.equal(d.model,'p/strong');assert.equal(d.effort,'high');
 assert.equal(parsePiDraft('--model yam/auto:high').model,'auto');
});

test('Pi fixed model and fixed reasoning preflight does not require unused routing roles',()=>{assert.equal(validatePiDraft({...draft,small:'',strong:'',classifier:'',model:'p/strong',effort:'high'},models),null);});

test('Pi status clears recovered polling errors while retaining a rejected control action',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingBar');
 const slots=[],refs=[],effects=[],timers=[];let index=0,refIndex=0,reads=0,first=true,controlError=false,active=true;
 const healthy={revision:1,generation:'g',phase:'idle',config:{small:'p/small',strong:'p/strong',classifier:'p/small',gateway:null},preferences:{model:'auto',effort:'auto'},target:null,actual:null,error:null,pendingInput:false};
 const invoke=async name=>{if(name==='get_pi_routing'){if(++reads===1)throw Error('previous generation');return {active:true,state:healthy};}if(controlError)throw Error('unsupported selection');return {state:healthy};};
 const dependencies={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useEffect:fn=>{if(first)effects.push(fn);},Select:()=>null,ModelOptions:()=>null,piLevels:['high','max'],t:(s)=>s,React:{createElement:(type,props,...children)=>({type,props:props??{},children})},document:{visibilityState:'visible'},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(dependencies),code+';return PiRoutingBar;')(...Object.values(dependencies));
 const render=()=>{index=refIndex=0;return component({sessionId:'s-pi',generation:'g',active,available:true,invoke});};
 function nodes(root){if(!root||typeof root!=='object')return[];return[root,...(root.children??[]).flat(Infinity).flatMap(nodes)];}
 const alerts=tree=>nodes(tree).filter(n=>n.props.role==='alert').flatMap(n=>n.children).join('');
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 render();first=false;const cleanup=effects[0]();await tick();assert.match(alerts(render()),/previous generation/);
 timers.shift()();await tick();assert.equal(alerts(render()),'');
 controlError=true;nodes(render()).find(n=>n.type==='button'&&n.children.includes('Refresh connection')).props.onClick();await tick();assert.match(alerts(render()),/unsupported selection/);
 timers.shift()();await tick();assert.match(alerts(render()),/unsupported selection/);healthy.phase='working';active=false;const ended=nodes(render()).flatMap(n=>n.children).filter(v=>typeof v==='string');assert.ok(ended.includes('Session ended'));assert.ok(!ended.includes('Pi task in progress'));cleanup();
});

test('Pi form retains a prompt-template value that looks like a managed option',()=>{const raw='--prompt-template --yam-small --yam-small p/small --yam-strong p/strong';assert.equal(parsePiDraft(raw).small,'p/small');assert.ok(buildPiArgs(raw,draft).includes('--prompt-template --yam-small'));});

async function routingBarFixture(invoke,options={}){
 const fs=await import('node:fs'),ts=(await import('typescript')).default,ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingBar');
 const slots=[],refs=[],dependencies=[],pending=[],timers=[];let index=0,refIndex=0,effectIndex=0;
 const env={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useEffect:(fn,deps)=>{const i=effectIndex++,old=dependencies[i];if(!old||deps.some((v,j)=>v!==old[j])){dependencies[i]=deps;pending.push(fn);}},Select:()=>null,ModelOptions:()=>null,piLevels:['high','max'],t:s=>s,React:{createElement:(type,props,...children)=>({type,props:props??{},children})},document:{visibilityState:options.visibility??'visible'},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingBar;')(...Object.values(env));let tree;
 const render=()=>{index=refIndex=effectIndex=0;tree=component({sessionId:'s-pi',generation:'g',active:options.active??true,available:true,invoke});return tree;};
 const all=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(all)];
 const tick=()=>new Promise(r=>setImmediate(r));
 const flush=async()=>{for(let i=0;i<3;i++){render();for(const effect of pending.splice(0))effect();await tick();}render();};
 await flush();return {visible:value=>env.document.visibilityState=value,flush,poll:async()=>{timers.shift()?.();await flush();},select:label=>all(tree).find(n=>n.props['aria-label']===label),button:text=>all(tree).find(n=>n.type==='button'&&n.children.includes(text)),tree:()=>tree,text:()=>all(tree).flatMap(n=>n.children).filter(v=>typeof v==='string').join(' ')};
}
const barState=()=>({revision:1,generation:'g',phase:'idle',config:{small:'p/small',strong:'p/strong',classifier:'p/small',gateway:null},preferences:{model:'p/small',effort:'high'},target:null,actual:null,error:null,pendingInput:false});
test('Pi model/effort transitions apply together without sending an incompatible intermediate selection',async()=>{
 let state=barState();const writes=[];
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes.push(args.request);state={...state,revision:state.revision+1,preferences:args.request.data};return {state};});
 f.select('Pi model selection').props.onChange({target:{value:'p/strong'}});await f.flush();f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();assert.equal(writes.length,0);
 assert.ok(f.button('Apply routing selection'));assert.equal(f.button('Apply routing selection').props.disabled,false);f.button('Apply routing selection').props.onClick();await f.flush();assert.equal(writes.length,1);assert.deepEqual(writes[0].data,{model:'p/strong',effort:'max'});
 f.select('Pi reasoning selection').props.onChange({target:{value:'off'}});await f.flush();f.button('Cancel selection').props.onClick();await f.flush();assert.equal(writes.length,1);assert.equal(f.select('Pi reasoning selection').props.value,'max');
});
test('Pi an older in-flight status read cannot revert a newly applied selection',async()=>{
 let state=barState(),release;const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing'){if(release===undefined&&state.revision===2)return new Promise(r=>release=r);return {active:true,state};}if(args.request.action==='catalog')return {models:[]};state={...state,revision:state.revision+1,preferences:args.request.data};return {state};});
 f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();if(f.button('Apply routing selection')){f.button('Apply routing selection').props.onClick();await f.flush();}
 const old=structuredClone(state);await f.poll();assert.ok(release);
 f.select('Pi reasoning selection').props.onChange({target:{value:'off'}});await f.flush();if(f.button('Apply routing selection')){f.button('Apply routing selection').props.onClick();await f.flush();}
 release({active:true,state:old});await f.flush();assert.equal(f.select('Pi reasoning selection').props.value,'off');
});
test('Pi stale unsaved choices are not silently submitted over a native settings change',async()=>{
 let state=barState(),writes=0;const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes++;return {state};});
 f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();state={...state,revision:2,preferences:{model:'auto',effort:'off'}};await f.poll();assert.ok(f.button('Apply routing selection')?.props.disabled);assert.equal(writes,0);f.button('Cancel selection').props.onClick();await f.flush();assert.equal(f.select('Pi reasoning selection').props.value,'off');
});

test('Pi routing starts with a compact policy summary and expansion never submits a preference',async()=>{
 let writes=0;const state={...barState(),preferences:{model:'auto',effort:'high'},phase:'working',target:{model:'p/strong',effort:'high',reason:'complex'},actual:{model:'p/small',effort:'medium',at:1}};
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes++;return {state};});
 const adjust=f.button('Adjust routing');assert.ok(adjust);assert.equal(adjust.props['aria-expanded'],false);assert.match(f.text(),/Automatic model/);assert.match(f.text(),/Fixed reasoning/);
 adjust.props.onClick();await f.flush();assert.equal(f.button('Adjust routing').props['aria-expanded'],true);assert.equal(writes,0);
 f.button('Adjust routing').props.onClick();await f.flush();assert.equal(f.button('Adjust routing').props['aria-expanded'],false);assert.equal(writes,0);
});

test('Pi graphical routing uses Tauri camelCase argument names for reads, catalog and controls',async()=>{
 const calls=[];let state=barState();
 const f=await routingBarFixture(async(name,args)=>{
  calls.push({name,args});assert.equal(args.sessionId,'s-pi','Tauri requires sessionId');assert.equal('session_id' in args,false);
  if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};
  state={...state,revision:state.revision+1,preferences:args.request.data??state.preferences};return {state};
 });
 assert.ok(calls.length);assert.equal(calls[0].args.sessionId,'s-pi');assert.ok(f.select('Pi reasoning selection'));
 f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();f.button('Apply routing selection').props.onClick();await f.flush();
 assert.equal(calls.find(v=>v.args.request?.action==='set')?.args.sessionId,'s-pi');assert.equal(calls.find(v=>v.args.request?.action==='catalog')?.args.sessionId,'s-pi');
});

test('ended Pi summaries recover after an initial hidden document or transient read failure',async()=>{
 for(const hidden of [true,false]){let reads=0;const state=barState();
  const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing'){reads++;if(!hidden&&reads===1)throw Error('temporary read');return {active:false,state};}return {models:[]};},{active:false,visibility:hidden?'hidden':'visible'});
  f.visible('visible');await f.poll();assert.ok(f.select('Pi reasoning selection'),'ended conversation must eventually show saved reasoning');assert.ok(reads>=1);
 }
});
test('Pi model catalogue failure is visible and existing reconnect recovers without sending a task',async()=>{
 let fail=true;const actions=[],state=barState();const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};actions.push(args.request.action);if(args.request.action==='catalog'){if(fail)throw Error('catalogue temporarily unavailable');return {models:[]};}return {state};});
 assert.match(f.text(),/catalogue temporarily unavailable/);f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();f.button('Apply routing selection').props.onClick();await f.flush();assert.match(f.text(),/catalogue temporarily unavailable/,'saving an unrelated preference cannot hide the missing catalogue');fail=false;f.button('Refresh connection').props.onClick();await f.flush();assert.doesNotMatch(f.text(),/catalogue temporarily unavailable/);assert.deepEqual(actions,['catalog','set','retry','catalog']);
});

function visibleRoutingText(node){
 if(!node||typeof node!=='object')return typeof node==='string'?node:'';
 if(node.props.hidden)return '';
 const children=(node.children??[]).flat(Infinity);
 return (node.type==='details'&&!node.props.open?children.filter(child=>child?.type==='summary'):children).map(visibleRoutingText).join(' ');
}
test('Pi default bar hides execution history and reasoning details while routing errors stay visible',async()=>{
 let writes=0;const state={...barState(),preferences:{model:'auto',effort:'high'},phase:'working',target:{model:'p/strong',effort:'high',reason:'complex'},actual:{model:'p/small',effort:'medium',at:1}};
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes++;return {state};});
 assert.match(visibleRoutingText(f.tree()),/Automatic model/);assert.doesNotMatch(visibleRoutingText(f.tree()),/Fixed reasoning|Last actual|Selected for this turn/);
 f.button('Adjust routing').props.onClick();await f.flush();assert.match(visibleRoutingText(f.tree()),/Last actual/);assert.match(visibleRoutingText(f.tree()),/Selected for this turn/);assert.equal(writes,0);
 f.button('Adjust routing').props.onClick();await f.flush();state.phase='error';state.error='routing failed';await f.poll();assert.match(visibleRoutingText(f.tree()),/routing failed/);assert.ok(f.button('Refresh connection'));assert.equal(writes,0);
});
