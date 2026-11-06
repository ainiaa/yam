// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultRules} from '../src-tauri/pi/task-rules.mjs';
import {parsePiDraft,buildPiArgs,validatePiDraft,defaultPiArgs,selectPiSetupModel,restorePiSetup,verifyPiSetup,piSetupMapping} from '../src/pi-routing.ts';
const models=[{key:'p/small',name:'Small',levels:['medium','high'],context_window:10000},{key:'p/strong',name:'Strong',levels:['medium','high','max'],context_window:100000}];
const draft={gateway:null,small:'p/small',strong:'p/strong',classifier:'',model:'auto',effort:'auto'};
test('Pi setup chooses an available high-capability default and never overwrites explicit selections',()=>{
 assert.equal(selectPiSetupModel(models,'p/strong'),'p/strong');
 assert.equal(selectPiSetupModel(models,'p/missing'),'');
 assert.equal(selectPiSetupModel([models[0]],''),'p/small');
 assert.equal(selectPiSetupModel([{...models[0],levels:['medium']}],''),'');
 const saved=JSON.stringify({gateway:null,small:'p/small',strong:'p/strong',classifier:'p/small'});
 assert.equal(restorePiSetup(defaultPiArgs,saved),"--yam-small 'p/small' --yam-strong 'p/strong' --yam-classifier 'p/small' --yam-fixed-model 'auto' --yam-effort 'auto'");
 const withTools=restorePiSetup('--tools read,bash --append-system-prompt "hello world"',saved);assert.ok(withTools.includes('--tools read,bash'));assert.ok(withTools.includes('--append-system-prompt "hello world"'));assert.equal(parsePiDraft(withTools).strong,'p/strong');
 const withLiteral=restorePiSetup("--system-prompt '--provider' --tools read",saved);assert.ok(withLiteral.includes("--system-prompt '--provider'"));assert.equal(parsePiDraft(withLiteral).strong,'p/strong');
 assert.equal(restorePiSetup('--yam-small p/manual',saved),null);
 assert.equal(restorePiSetup('--model p/manual',saved),null);
 assert.equal(restorePiSetup('--thinking high',saved),null);
 assert.equal(restorePiSetup('--provider p',saved),null);
 assert.equal(restorePiSetup('--provider=p',saved),null);
 assert.equal(restorePiSetup('--yam-billing subscription',saved),null);
 const restricted=JSON.stringify({gateway:null,small:'yam-codex/sol',strong:'yam-codex/sol',classifier:'yam-codex/sol',billing:'subscription'});
 const restoredRestricted=restorePiSetup('--tools read',restricted);assert.match(restoredRestricted,/--yam-billing subscription/);assert.match(restoredRestricted,/--tools read/);
 assert.equal(restorePiSetup('',JSON.stringify({gateway:null,small:'p/api',strong:'p/api',classifier:'p/api',billing:'subscription'})),null);
 assert.equal(restorePiSetup('',JSON.stringify({gateway:null,small:'p/api',strong:'p/api',classifier:'p/api',billing:'invalid'})),null);
 assert.throws(()=>piSetupMapping(draft,'--yam-billing subscription'),/Subscription-only/);
 assert.equal(piSetupMapping({...draft,small:'yam-codex/sol',strong:'yam-codex/sol',classifier:'yam-codex/sol'},'--yam-billing subscription').billing,'subscription');
 assert.equal(restorePiSetup('--tools "unterminated',saved),null);
 assert.equal(restorePiSetup('', '{invalid'),null);
 assert.equal(restorePiSetup('',JSON.stringify({gateway:'https://user:secret@example.com',small:'p/small',strong:'p/strong',classifier:'p/small'})),null);
});
test('Pi setup accepts only a verified current model and never falls back on probe errors',async()=>{
 const calls=[],invoke=async(name,args)=>{calls.push({name,args});return {models,probe:{ok:true}};};
 const setup=await verifyPiSetup('', '/tmp/project', 'p/strong', invoke);
 assert.equal(setup.mapping.strong,'p/strong');assert.equal(parsePiDraft(setup.args).classifier,'p/strong');
 assert.equal(calls[0].args.probeModel,'p/strong');assert.equal(calls[0].args.gateway,null);
 await assert.rejects(()=>verifyPiSetup('','/tmp/project','p/strong',async()=>({models,probe:{ok:false}})));
 await assert.rejects(()=>verifyPiSetup('','/tmp/project','p/missing',invoke));
 await assert.rejects(()=>verifyPiSetup('','/tmp/project','p/strong',async()=>{throw Error('offline');}));
});
test('saved Pi setup retains custom task rules and fixed choices while legacy mappings remain readable',()=>{
 const rules=structuredClone(defaultRules);rules.rules.find(r=>r.task==='review').effort='max';const saved=piSetupMapping({...draft,model:'p/strong',effort:'max',rules:JSON.stringify(rules)},'');
 const restored=parsePiDraft(restorePiSetup('',JSON.stringify(saved)));assert.equal(restored.model,'p/strong');assert.equal(restored.effort,'max');assert.deepEqual(JSON.parse(restored.rules),rules);
});
test('explicitly applying imported defaults preserves unrelated arguments and the stricter billing policy',()=>{
 const saved=JSON.stringify(piSetupMapping({...draft,small:'yam-codex/sol',strong:'yam-codex/sol',classifier:'yam-codex/sol',rules:JSON.stringify(defaultRules)},'--yam-billing subscription'));
 const args=restorePiSetup('--yam-small p/manual --yam-strong p/manual --yam-billing configured --tools read --system-prompt "--yam-billing"',saved,true);
 assert.ok(args);assert.equal(parsePiDraft(args).small,'yam-codex/sol');assert.match(args,/--tools read/);assert.match(args,/--system-prompt "--yam-billing"/);assert.match(args,/--yam-billing subscription/);assert.ok(!args.includes('--yam-billing configured'));
 assert.equal(restorePiSetup('--yam-billing subscription',JSON.stringify(piSetupMapping(draft,'')),true),null);
 assert.equal(restorePiSetup('--yam-billing invalid',saved,true),null);
});
test('quoted and escaped prompt terminators keep generated routing flags outside the prompt',()=>{
 for(const terminator of ['--','"--"',"'--'",'\\--']){
  const args=buildPiArgs(`--system-prompt "--" ${terminator} hello --yam-small literal`,draft),parsed=parsePiDraft(args);
  assert.equal(parsed.small,'p/small',terminator);assert.equal(parsed.strong,'p/strong',terminator);assert.ok(args.endsWith(`${terminator} hello --yam-small literal`),terminator);assert.ok(args.startsWith('--system-prompt "--"'),terminator);
  const saved=JSON.stringify(piSetupMapping(draft,'')),restored=restorePiSetup(`${terminator} hello`,saved,true);assert.equal(parsePiDraft(restored).small,'p/small',terminator);assert.ok(restored.endsWith(`${terminator} hello`),terminator);
 }
});
test('Pi setup respects subscription-only billing before sending a probe',async()=>{
 let calls=0;const codex={...models[0],key:'yam-codex/gpt-6.1-sol',source:'chatgpt-subscription',billing:'subscription'};
 const invoke=async()=>{calls++;return {models:[codex],probe:{ok:true}};};
 await assert.rejects(()=>verifyPiSetup('--yam-billing subscription','/tmp','yam-gateway/api/model',invoke),/Subscription-only/);assert.equal(calls,0);
 await assert.rejects(()=>verifyPiSetup('--yam-billing=subscription','/tmp','p/small',invoke),/Subscription-only/);assert.equal(calls,0);
 await assert.rejects(()=>verifyPiSetup('--yam-billing invalid','/tmp',codex.key,invoke),/billing/i);assert.equal(calls,0);
 const result=await verifyPiSetup('--yam-billing subscription','/tmp',codex.key,invoke);assert.equal(result.mapping.strong,codex.key);assert.equal(result.mapping.billing,'subscription');assert.equal(calls,1);
 await verifyPiSetup("--system-prompt '--yam-billing'",'/tmp',codex.key,invoke);assert.equal(calls,2);
});
test('Pi launch validation rejects models forbidden by the explicit billing policy',()=>{
 const codex={...models[0],key:'yam-codex/sol',source:'chatgpt-subscription',billing:'subscription'},api={...models[1],key:'yam-gateway/api/model',source:'magpie',billing:'gateway'};
 const d={...draft,small:codex.key,strong:codex.key,classifier:codex.key};
 assert.equal(validatePiDraft(d,[codex,api],'--yam-billing subscription'),null);
 assert.match(validatePiDraft({...d,strong:api.key},[codex,api],'--yam-billing subscription'),/Subscription-only/);
 assert.match(validatePiDraft({...d,model:api.key,effort:'high'},[codex,api],'--yam-billing subscription'),/Subscription-only/);
 assert.equal(validatePiDraft({...d,model:codex.key,effort:'high',small:api.key,strong:api.key,classifier:api.key},[codex,api],'--yam-billing subscription'),null);
 assert.equal(validatePiDraft({...d,strong:api.key},[codex,api],'--yam-billing configured'),null);
 assert.match(validatePiDraft(d,[codex,api],'--yam-billing invalid'),/Invalid billing policy/);
});
test('Pi setup offers provider guidance only when discovery finds no usable models or fails',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],opened=[];let index=0,refIndex=0,result={models:[]},failed=false,nativeFailed=false,detected=[],gatewayWarning=false,cwd='/tmp',args='--yam-small p/small --yam-strong p/strong';
 const invoke=async(name,request)=>{if(name==='list_local_gateways')return detected;if(failed||nativeFailed&&!request.gateway)throw Error('offline');return request.gateway&&gatewayWarning?{...result,warning:'Magpie is offline'}:result;};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:()=>{},Select:'select',ModelOptions:()=>null,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupStorageKey:'setup',piLevels:['high'],t:s=>s,openUrl:async url=>opened.push(url),localStorage:{getItem:()=>null},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=gateways=>{index=refIndex=0;return component({args,cwd,invoke,onChange:()=>{},onValidity:()=>{},installedGateways:gateways});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 const scan=async gateways=>{all(render(gateways)).find(n=>n.type==='button'&&n.children.includes('Find available models')).props.onClick();await new Promise(r=>setImmediate(r));return render(gateways);};
 const quick=all(render([])).find(n=>n.type==='details'&&n.props.className==='pi-routing-advanced');assert.equal(quick.props.open,false);quick.props.onToggle({currentTarget:{open:true}});
 assert.doesNotMatch(JSON.stringify(render([])),/Get Magpie/);
 let tree=await scan([]);assert.equal(all(tree).find(n=>n.type==='details'&&n.props.className==='pi-routing-advanced').props.open,true);assert.match(JSON.stringify(tree),/Get Magpie/);assert.match(JSON.stringify(tree),/\/login/);
 assert.match(JSON.stringify(tree),/official Codex CLI/);
 assert.match(JSON.stringify(tree),/codex login/);
 assert.doesNotMatch(JSON.stringify(tree),/ChatGPT subscription models use Pi login directly/);
 const link=all(tree).find(n=>n.type==='button'&&n.children.includes('Get Magpie'));await link.props.onClick();assert.deepEqual(opened,['https://usemagpie.ai/']);
 const piGuide=all(tree).find(n=>n.type==='button'&&n.children.includes('Pi provider setup guide'));await piGuide.props.onClick();assert.equal(opened[1],'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md');
 detected=['magpie','cc-switch'];tree=await scan([]);assert.match(JSON.stringify(tree),/Magpie is installed/);assert.match(JSON.stringify(tree),/CC Switch is installed/);
 result={models};tree=await scan([]);assert.doesNotMatch(JSON.stringify(tree),/Get Magpie/);
 gatewayWarning=true;tree=await scan([]);assert.match(JSON.stringify(tree),/Magpie gateway model catalog unavailable/);assert.match(JSON.stringify(tree),/Verify and use this model/);gatewayWarning=false;
 failed=true;tree=await scan([]);assert.match(JSON.stringify(tree),/Magpie setup guide/);assert.doesNotMatch(JSON.stringify(tree),/Verify and use this model/);
 failed=false;result={models:[{...models[0],levels:['medium']}]};tree=await scan([]);assert.match(JSON.stringify(tree),/No discovered model supports high reasoning/);assert.match(JSON.stringify(tree),/Magpie setup guide/);assert.doesNotMatch(JSON.stringify(tree),/Verify and use this model/);
 nativeFailed=true;result={models:[{...models[0],key:'yam-gateway/test/model'}]};tree=await scan([]);assert.match(JSON.stringify(tree),/Verify and use this model/);assert.match(JSON.stringify(tree),/Pi native model catalog unavailable/);nativeFailed=false;
 cwd='/tmp/other';tree=render([]);assert.doesNotMatch(JSON.stringify(tree),/No discovered model supports high reasoning|Magpie setup guide/);
});
test('Pi quick setup verifies before saving and ignores stale completion',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],saved=new Map();let index=0,refIndex=0,args='',cwd='/tmp/project',release,fail=false;
 const invoke=async(_name,request)=>request.probeModel?fail?{models,probe:{ok:false}}:new Promise(r=>release=()=>r({models,probe:{ok:true}})):{models,preferred:'p/strong'};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:()=>{},Select:'select',ModelOptions:()=>null,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupStorageKey:'setup',piLevels:['low','medium','high','xhigh','max'],t:s=>s,localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=()=>{index=refIndex=0;return component({args,cwd,invoke,onChange:v=>args=v,onValidity:()=>{}});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 const button=text=>all(render()).find(n=>n.type==='button'&&n.children.includes(text));
 await button('Find available models').props.onClick();await new Promise(r=>setImmediate(r));render();
 args='--yam-gateway http://127.0.0.1:4567';assert.equal(button('Verify and use this model'),undefined);args='';render();
 const pending=button('Verify and use this model').props.onClick();await new Promise(r=>setImmediate(r));
 args='--yam-small p/manual';render();release();await pending;await new Promise(r=>setImmediate(r));assert.equal(args,'--yam-small p/manual');assert.equal(saved.size,0);
 args='';render();const stale=button('Verify and use this model').props.onClick();await new Promise(r=>setImmediate(r));cwd='/tmp/other';render();release();await stale;await new Promise(r=>setImmediate(r));assert.equal(saved.size,0);assert.equal(args,'');assert.equal(button('Verify and use this model'),undefined);
 cwd='/tmp/project';render();
 args='';fail=true;await button('Verify and use this model').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saved.size,0);assert.equal(args,'');assert.match(JSON.stringify(render()),/Pi provider setup guide/);
 args='--yam-billing subscription';render();await button('Verify and use this model').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saved.size,0);assert.match(JSON.stringify(render()),/Subscription-only billing requires a Codex subscription model/);
 args='';fail=false;const good=button('Verify and use this model').props.onClick();await new Promise(r=>setImmediate(r));release();await good;await new Promise(r=>setImmediate(r));assert.equal(parsePiDraft(args).strong,'p/strong');assert.equal(saved.size,1);
});
test('Pi initial connection check does not cancel an in-flight user scan',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],effects=[];let index=0,refIndex=0,timer,release,scans=0;
 const invoke=async(name,request)=>{if(name==='list_local_gateways')return [];if(++scans===1)return await new Promise(r=>release=()=>r({models,preferred:'p/strong'}));return {models,preferred:'p/strong'};};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:fn=>effects.push(fn),setTimeout:fn=>(timer=fn,1),clearTimeout:()=>{},Select:'select',ModelOptions:()=>null,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupStorageKey:'setup',piLevels:['high'],t:s=>s,localStorage:{getItem:()=>null},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=()=>{index=refIndex=0;effects.length=0;return component({args:'',cwd:'/tmp/project',invoke,onChange:()=>{},onValidity:()=>{}});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 render();effects[1]();render();effects[2]();
 all(render()).find(n=>n.type==='button'&&n.children.includes('Find available models')).props.onClick();await new Promise(r=>setImmediate(r));
 timer();await new Promise(r=>setImmediate(r));release();await new Promise(r=>setImmediate(r));
 assert.match(JSON.stringify(render()),/Verify and use this model/);assert.ok(scans>=3,'the normal connection check still runs after discovery');
});
test('Pi rule defaults roundtrip literal JSON and reject malformed rules before launch',async()=>{
 const {defaultRules}=await import('../src-tauri/pi/task-rules.mjs');const rules=JSON.stringify(defaultRules),saved=buildPiArgs('',{...draft,rules});
 assert.equal(parsePiDraft(saved).rules,rules);assert.equal(validatePiDraft({...draft,rules},models),null);
 assert.match(validatePiDraft({...draft,rules:'{}'},models),/rules/i);
 assert.throws(()=>parsePiDraft('--yam-rules'),/Missing/);
});
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
test('Pi preflight distinguishes unselected routing roles from unavailable models',()=>{
 assert.equal(validatePiDraft({...draft,small:''},models),'Choose a lightweight model');
 assert.equal(validatePiDraft({...draft,strong:''},models),'Choose a strong model');
 assert.equal(validatePiDraft({...draft,model:'p/strong',small:'',effort:'auto'},models),'Choose a lightweight model');
 assert.equal(validatePiDraft({...draft,small:'p/missing'},models),'Pi model unavailable: p/missing');
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
 const env={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useEffect:(fn,deps)=>{const i=effectIndex++,old=dependencies[i];if(!old||deps.some((v,j)=>v!==old[j])){dependencies[i]=deps;pending.push(fn);}},Select:()=>null,ModelOptions:()=>null,PiTaskRules:'task-rules',piLevels:['high','max'],t:(s,values={})=>s.replace(/{{(\w+)}}/g,(_,key)=>values[key]??''),React:{createElement:(type,props,...children)=>({type,props:props??{},children})},document:{visibilityState:options.visibility??'visible'},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingBar;')(...Object.values(env));let tree;
 const render=()=>{index=refIndex=effectIndex=0;tree=component({sessionId:options.sessionId??'s-pi',generation:options.generation??'g',active:options.active??true,available:options.available??true,invoke});return tree;};
 const all=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(all)];
 const tick=()=>new Promise(r=>setImmediate(r));
 const flush=async()=>{for(let i=0;i<3;i++){render();for(const effect of pending.splice(0))effect();await tick();}render();};
 await flush();return {visible:value=>env.document.visibilityState=value,flush,poll:async()=>{timers.shift()?.();await flush();},select:label=>all(tree).find(n=>n.props['aria-label']===label),button:text=>all(tree).find(n=>n.type==='button'&&n.children.includes(text)),catalogModels:()=>all(tree).find(n=>n.type===env.ModelOptions)?.props.models,rules:()=>all(tree).find(n=>n.type==='task-rules'),tree:()=>tree,text:()=>all(tree).flatMap(n=>n.children).filter(v=>typeof v==='string').join(' ')};
}
const barState=()=>({revision:1,generation:'g',phase:'idle',config:{small:'p/small',strong:'p/strong',classifier:'p/small',gateway:null},preferences:{model:'p/small',effort:'high'},target:null,actual:null,error:null,pendingInput:false});
test('routing diagnostics show observed stages and missing timings without exposing connection secrets',async()=>{
 const state={...barState(),diagnostics:{configSource:'session',billing:'subscription',execution:{stage:'failed',failedStage:'starting',discoveryMs:23,startupMs:null,firstResponseMs:null,executionMs:45}}};
 const f=await routingBarFixture(async(name,args)=>name==='get_pi_routing'?{active:true,state}:{models:[]});
 assert.match(f.text(),/Execution failed/);assert.match(f.text(),/Model discovery\s*:\s*23 ms/);assert.match(f.text(),/CLI startup\s*:\s*—/);assert.match(f.text(),/First reply event\s*:\s*—/);assert.match(f.text(),/Saved session configuration/);assert.match(f.text(),/Subscription only/);
});
test('long context diagnostics explain full handoff and recommend explicit compaction without replay',async()=>{
 const state={...barState(),diagnostics:{configSource:'launch',billing:'configured',execution:{stage:'failed',failedStage:'preparing',failure:'context-budget',discoveryMs:1,startupMs:null,firstResponseMs:null,executionMs:null,handoff:{mode:'full',reason:'identity-changed',messages:25,characters:130001,budget:128000}}}};let writes=0;
 const f=await routingBarFixture(async(name)=>{if(name==='get_pi_routing')return {active:true,state};writes++;return {models:[]};});const before=writes;
 assert.match(f.text(),/Full context/);assert.match(f.text(),/Native identity changed/);assert.ok(JSON.stringify(f.tree()).includes('130001'));assert.ok(JSON.stringify(f.tree()).includes('128000'));assert.match(f.text(),/\/compact/);assert.equal(writes,before);
});
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
test('Pi default bar shows native model and effort while configuration details stay collapsed',async()=>{
 let writes=0;const state={...barState(),preferences:{model:'auto',effort:'high'},phase:'working',target:{model:'p/strong',effort:'high',reason:'complex'},actual:{model:'p/small',effort:'medium',at:1}};
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes++;return {state};});
 assert.match(visibleRoutingText(f.tree()),/Automatic model/);assert.match(visibleRoutingText(f.tree()),/Actual model: p\/small · medium/);assert.doesNotMatch(visibleRoutingText(f.tree()),/Fixed reasoning|Latest reply used|Selected for this turn/);
 f.button('Adjust routing').props.onClick();await f.flush();assert.match(visibleRoutingText(f.tree()),/Latest reply used/);assert.match(visibleRoutingText(f.tree()),/Selected for this turn/);assert.equal(writes,0);
 f.button('Adjust routing').props.onClick();await f.flush();state.phase='error';state.error='routing failed';await f.poll();assert.match(visibleRoutingText(f.tree()),/routing failed/);assert.ok(f.button('Refresh connection'));assert.equal(writes,0);
});


test('Pi summary separates planned selection, native response, prior response and missing evidence',async()=>{
 let state={...barState(),preferences:{model:'auto',effort:'auto'},phase:'classifying',actual:{model:'p/old',effort:'medium',at:1}};
 const f=await routingBarFixture(async(name,args)=>name==='get_pi_routing'?{active:true,state}:{models:[]});
 const visible=()=>visibleRoutingText(f.tree());
 assert.equal(f.tree().children[0].children.flat(Infinity).find(n=>n?.props?.className==='pi-routing-model').props.role,'status');
 assert.match(visible(),/Choosing a model/);assert.match(visible(),/Latest reply used: p\/old · medium/);assert.doesNotMatch(visible(),/Actual model:/);
 state={...state,phase:'selected',target:{model:'p/new',effort:'max',reason:'critical'}};await f.poll();
 assert.match(visible(),/Selected for this turn: p\/new · max/);assert.doesNotMatch(visible(),/Actual model:|p\/old/);
 state={...state,phase:'working',actual:{model:'p/native',effort:'unknown',at:2}};await f.poll();
 assert.match(visible(),/Actual model: p\/native · Reasoning not confirmed/);assert.doesNotMatch(visible(),/p\/new|p\/old/);
 state={...state,phase:'idle'};await f.poll();assert.match(visible(),/Latest reply used: p\/native/);
 state={...state,phase:'error',error:'request failed'};await f.poll();assert.match(visible(),/Latest reply used: p\/native/);assert.match(visible(),/request failed/);
 state={...state,phase:'idle',actual:null,target:null,error:null};await f.poll();assert.match(visible(),/No native model response recorded yet/);assert.doesNotMatch(visible(),/Actual model:|Selected for this turn:/);
});
test('Pi ended and disconnected summaries never claim a current response or planned selection',async()=>{
 for(const ended of [false,true]){
  let fail=false;const state={...barState(),phase:'working',actual:{model:'p/native',effort:'high',at:1},target:{model:'p/next',effort:'max',reason:'critical'}};
  const f=await routingBarFixture(async(name)=>{if(name!=='get_pi_routing')return {models:[]};if(fail)throw Error('connection lost');return {state};},{active:!ended});
  if(!ended){fail=true;await f.poll();}
  const visible=visibleRoutingText(f.tree());assert.match(visible,/Latest reply used: p\/native · high/);assert.doesNotMatch(visible,/Actual model:|Selected for this turn:/);
 }
});

test('Pi native subscription status keeps controls usable during a Magpie warning and shows token usage',async()=>{
 const state={...barState(),gatewayError:'Magpie is offline',actual:{model:'openai/chat',effort:'high',at:1,source:'chatgpt-subscription',billing:'subscription',usage:{input:10,output:20,cacheRead:0,cacheWrite:0}},decision:{rule:'fixed',ruleVersion:'v1',classificationMs:0,totalCost:null}};
 const f=await routingBarFixture(async(name,args)=>name==='get_pi_routing'?{active:true,state}:args.request.action==='catalog'?{models:[]}:{state});
 const text=JSON.stringify(f.tree());assert.match(text,/ChatGPT subscription/);assert.match(text,/Magpie is offline/);assert.match(text,/Reply tokens/);assert.match(text,/10/);assert.match(text,/20/);assert.equal(f.button('Refresh connection').props.disabled,false);
});

test('T3 routing details identify local context estimates and explain rejected candidates',async()=>{
 const state={...barState(),decision:{rule:'answer',ruleVersion:'v2',classificationMs:0,totalCost:null,budget:{kind:'local-estimate',inputTokens:200,reserveTokens:20,contextWindow:300,maxOutputTokens:null,fits:true,reason:null},rejected:[{model:'p/small',reason:'context-limit'},{model:'p/medium',reason:'effort'}]}};
 const f=await routingBarFixture(async name=>name==='get_pi_routing'?{active:true,state}:{models:[]});
 f.button('Adjust routing').props.onClick();await f.flush();const text=visibleRoutingText(f.tree()),rendered=JSON.stringify(f.tree());assert.match(text,/Local context estimate/);assert.match(rendered,/200/);assert.match(rendered,/20/);assert.match(rendered,/300/);assert.match(text,/native accumulated context is not measured/);assert.match(text,/p\/small/);assert.match(text,/Reasoning level unsupported/);assert.doesNotMatch(text,/max output[^\n]*0/i);
});

test('Pi new defaults discover both channels without pinning a gateway subscription model',async()=>{
 const {defaultPiArgs}=await import('../src/pi-routing.ts'),draft=parsePiDraft(defaultPiArgs);
 assert.equal(draft.gateway,null);assert.equal(draft.small,'');assert.equal(draft.strong,'');assert.ok(validatePiDraft(draft,models));
});

test('Pi legacy gateway catalog options retain the gateway source label without new metadata',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default,ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ModelOptions');
 const code=ts.transpileModule(fn.getText(ast),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText,component=new Function('React','t',code+';return ModelOptions;')({createElement:(type,props,...children)=>({type,props,children})},s=>s);
 const text=JSON.stringify(component({models:[{key:'yam-gateway/codex/old',name:'Old',levels:['high'],context_window:1000}],value:''}));assert.match(text,/Magpie gateway/);assert.doesNotMatch(text,/Pi native/);
 const native=JSON.stringify(component({models:[{key:'api/a',name:'API',billing:'api',levels:['high'],context_window:1000},{key:'oauth/b',name:'OAuth',billing:'subscription',levels:['high'],context_window:1000}],value:''}));assert.match(native,/Pi native API/);assert.match(native,/Pi native subscription/);
});

test('Pi starts without an implicit Magpie dependency and preserves explicit subscription policy',()=>{
 assert.equal(defaultPiArgs,'');
 const args=buildPiArgs('--yam-billing subscription',{gateway:null,small:'yam-codex/a',strong:'yam-codex/b',classifier:'yam-codex/a',model:'auto',effort:'auto'});
 assert.ok(args.includes('--yam-billing subscription'));assert.ok(!args.includes('--yam-gateway'));
});

test('three-tier setup persists medium through args, policy and portable imports',async()=>{
 const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');
 const {portablePiRoutingPolicy,importPiRoutingPolicy}=await import('../src/pi-routing.ts');
 const d={...draft,medium:'p/medium',rules:JSON.stringify(defaultTierRules)};
 const args=buildPiArgs('',d);assert.equal(parsePiDraft(args).medium,'p/medium');
 const saved=JSON.stringify(piSetupMapping(d,args)),policy=portablePiRoutingPolicy(saved);
 assert.equal(policy.v,2);assert.equal(policy.medium,'p/medium');assert.equal(policy.rules.v,2);
 assert.equal(JSON.parse(importPiRoutingPolicy(policy)).medium,'p/medium');
 assert.equal(parsePiDraft(restorePiSetup('',saved)).medium,'p/medium');
 assert.match(validatePiDraft(d,models),/medium/);
 assert.throws(()=>piSetupMapping({...d,small:'yam-codex/a',strong:'yam-codex/b',classifier:'yam-codex/a'},'--yam-billing subscription'),/Subscription/);
});
test('three-tier rules require a medium role and reject cross-version or malformed portable policy',async()=>{
 const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');
 const {validatePiRoutingPolicy,portablePiRoutingPolicy}=await import('../src/pi-routing.ts');
 assert.match(validatePiDraft({...draft,rules:JSON.stringify(defaultTierRules)},models),/medium/);
 const old={v:1,small:'p/small',strong:'p/strong',classifier:'p/small',model:'auto',effort:'auto',billing:'configured',rules:defaultTierRules};assert.throws(()=>validatePiRoutingPolicy(old));
 for(const medium of [null,'',false,{},'p/two words'])assert.throws(()=>portablePiRoutingPolicy(JSON.stringify({...draft,medium,rules:defaultTierRules})));
});
test('three-tier verification preserves explicit custom v1 and v2 task rules',async()=>{
 const {verifyPiSetup}=await import('../src/pi-routing.ts');const {defaultTierRules}=await import('../src-tauri/pi/task-rules.mjs');
 for(const rules of [defaultRules,defaultTierRules]){
  const custom=structuredClone(rules);custom.rules[0].description='Keep my translation policy';
  const d={...draft,...rules.v===2?{medium:'p/strong'}:{},rules:JSON.stringify(custom)};
  const result=await verifyPiSetup(buildPiArgs('',d),'/tmp','p/strong',async()=>({models,probe:{ok:true}}));
  assert.deepEqual(result.mapping.rules,custom);assert.deepEqual(JSON.parse(parsePiDraft(result.args).rules),custom);
 }
});
test('three-tier new subscription setup probes exact available candidates and automatically fills roles',async()=>{
 const {verifyPiSetup}=await import('../src/pi-routing.ts');
 const catalog=['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'].map(id=>({key:'yam-codex/'+id,name:id,source:'chatgpt-subscription',billing:'subscription',levels:['medium','high'],context_window:100000}));
 const calls=[];const r=await verifyPiSetup('--yam-billing subscription','/tmp','yam-codex/gpt-6.1-sol',async(_name,args)=>{calls.push(args.probeModel);return {models:catalog,probe:{ok:true}};});
 assert.equal(r.mapping.small,'yam-codex/gpt-6-luna');assert.equal(r.mapping.medium,'yam-codex/gpt-6.1-sol');assert.equal(r.mapping.strong,'yam-codex/gpt-6-astra');assert.equal(r.mapping.classifier,r.mapping.small);
 assert.deepEqual(new Set(calls),new Set(catalog.map(m=>m.key)));assert.equal(calls.length,3);assert.equal(r.warning,null);
});
test('three-tier missing, paid or failed defaults fall back only to the verified subscription model',async()=>{
 const {verifyPiSetup}=await import('../src/pi-routing.ts');
 const main={key:'yam-codex/gpt-6.1-sol',name:'main',source:'chatgpt-subscription',billing:'subscription',levels:['medium','high'],context_window:100000};
 const catalog=[main,{...main,key:'yam-codex/gpt-6-luna'},{...main,key:'yam-codex/gpt-6-astra',billing:'api',source:'pi-native'}];const calls=[];
 const r=await verifyPiSetup('--yam-billing subscription','/tmp',main.key,async(_name,args)=>{calls.push(args.probeModel);return {models:catalog,probe:{ok:args.probeModel===main.key}};});
 assert.equal(r.mapping.small,main.key);assert.equal(r.mapping.medium,main.key);assert.equal(r.mapping.strong,main.key);assert.deepEqual(calls,[main.key,'yam-codex/gpt-6-luna']);assert.ok(r.warning);
});
test('three-tier new subscription setup does not guess missing model names or probe paid candidates',async()=>{
 const {verifyPiSetup}=await import('../src/pi-routing.ts');const main={key:'yam-codex/gpt-6.1-sol',name:'main',billing:'subscription',source:'chatgpt-subscription',levels:['medium','high'],context_window:100000};
 const catalog=[main,{...main,key:'yam-codex/gpt-6-luna-preview'},{...main,key:'yam-codex/gpt-6-astra',billing:'api'}];const probes=[];
 const r=await verifyPiSetup('--yam-billing subscription','/tmp',main.key,async(_name,args)=>{probes.push(args.probeModel);return {models:catalog,probe:{ok:true}};});
 assert.deepEqual(probes,[main.key]);assert.equal(r.mapping.small,main.key);assert.equal(r.mapping.strong,main.key);assert.ok(r.warning);
});
test('three-tier automatic defaults keep configured API and fixed setup within the existing verified selection',async()=>{
 const {verifyPiSetup}=await import('../src/pi-routing.ts');
 for(const [args,key,billing] of [['','p/api','api'],['--yam-fixed-model yam-codex/gpt-6.1-sol --yam-effort high','yam-codex/gpt-6.1-sol','subscription']]){
  const probes=[],catalog=[{key,name:'chosen',billing,levels:['medium','high'],context_window:100000}];
  const r=await verifyPiSetup(args,'/tmp',key,async(_name,a)=>{probes.push(a.probeModel);return {models:catalog,probe:{ok:true}};});
  assert.deepEqual(probes,[key]);assert.equal(r.mapping.medium,undefined);assert.equal(r.mapping.rules.v,1);assert.equal(r.warning,null);
 }
});

test('native recovery UI confirms the observed receipt explicitly and never submits a task',async()=>{
 let state={...barState(),phase:'error',nativeRecovery:{receiptId:'receipt-1',sessionId:'01234567-1234-1234-1234-0123456789ab',status:'failed',reason:'cleanup-unconfirmed',cleanup:'unconfirmed',inProgress:false,needsInspection:true}};const writes=[];
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes.push(args.request);if(args.request.action==='native-reset')state={...state,revision:state.revision+1,nativeRecovery:null};return {state};});
 assert.ok(f.button('View recovery information'));f.button('View recovery information').props.onClick();await f.flush();assert.equal(writes[0].action,'native-recovery');assert.match(f.text(),/Cleanup unconfirmed/);assert.match(f.text(),/Native Codex session/);assert.match(f.text(),/01234567-1234-1234-1234-0123456789ab/);assert.match(f.text(),/read its saved transcript/);assert.match(f.text(),/does not require resuming or resending/);
 f.button('Clear task block…').props.onClick();await f.flush();assert.equal(writes.length,1);assert.match(f.text(),/does not undo actions or resend a task/);f.button('Cancel recovery').props.onClick();await f.flush();assert.equal(writes.length,1);
 f.button('Clear task block…').props.onClick();await f.flush();f.button('I checked the old task; clear the block').props.onClick();await f.flush();assert.deepEqual(writes[1],{action:'native-reset',revision:1,data:{receiptId:'receipt-1',confirmed:true}});assert.equal(writes.length,2);assert.match(f.text(),/Task block cleared/);
});
test('native recovery UI permits busy inspection and preserves legacy blocking guidance',async()=>{
 const state={...barState(),phase:'working',nativeRecovery:{receiptId:null,status:'running',reason:'unknown',cleanup:'unknown',inProgress:true,needsInspection:false}};const writes=[];
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes.push(args.request);return {state};});
 assert.ok(f.button('View recovery information'));assert.equal(f.button('View recovery information').props.disabled,false);f.button('View recovery information').props.onClick();await f.flush();assert.equal(writes.length,1);assert.equal(writes[0].action,'native-recovery');assert.match(f.text(),/Native task running/);assert.match(f.text(),/yam-native reset/);assert.equal(f.button('Clear task block…').props.disabled,true);
});
test('native recovery confirmation cannot clear a newly observed receipt or revision',async()=>{
 let state={...barState(),phase:'error',nativeRecovery:{receiptId:'old',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true}};const writes=[];
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};writes.push(args.request);return {state};});f.button('View recovery information').props.onClick();await f.flush();f.button('Clear task block…').props.onClick();await f.flush();
 state={...state,revision:2,nativeRecovery:{...state.nativeRecovery,receiptId:'new'}};await f.poll();const confirm=f.button('I checked the old task; clear the block');assert.ok(!confirm||confirm.props.disabled);assert.equal(writes.filter(r=>r.action==='native-reset').length,0);
});

test('native recovery ignores a control reply after switching runtime generation',async()=>{
 const options={generation:'g'},old={...barState(),phase:'error',nativeRecovery:{receiptId:'old-receipt-sentinel',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true}};let state=old,release;
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};if(args.request.action==='native-recovery')return new Promise(r=>release=r);return {state};},options);f.button('View recovery information').props.onClick();await f.flush();options.generation='next';state={...barState(),generation:'next',revision:2,nativeRecovery:{...old.nativeRecovery,receiptId:'new'}};await f.flush();release({state:old});await f.flush();assert.doesNotMatch(f.text(),/old-receipt-sentinel/);assert.ok(f.button('View recovery information'));
});

test('native recovery success and confirmation belong to their runtime generation',async()=>{
 const options={generation:'g'};let state={...barState(),phase:'error',nativeRecovery:{receiptId:'receipt',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true}};
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};if(args.request.action==='native-reset')state={...state,revision:2,nativeRecovery:null};return {state};},options);f.button('View recovery information').props.onClick();await f.flush();f.button('Clear task block…').props.onClick();await f.flush();f.button('I checked the old task; clear the block').props.onClick();await f.flush();assert.match(f.text(),/Task block cleared/);options.generation='next';state={...barState(),generation:'next'};await f.flush();assert.doesNotMatch(f.text(),/Task block cleared/);
});

test('native recovery UI keeps missing native session IDs explicit without substituting receipt identifiers',async()=>{
 const state={...barState(),phase:'error',nativeRecovery:{receiptId:'receipt-only',sessionId:null,status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true}};
 const f=await routingBarFixture(async(name,args)=>name==='get_pi_routing'?{active:true,state}:args.request.action==='catalog'?{models:[]}:{state});f.button('View recovery information').props.onClick();await f.flush();assert.match(f.text(),/Native session ID unavailable/);assert.match(f.text(),/old terminal output/);assert.match(f.text(),/receipt-only/);assert.doesNotMatch(f.text(),/Native Codex session/);
});

test('T2 native failure UI shows safe reason stage and next step while retaining recovery confirmation',async()=>{
 const failure={category:'auth',stage:'discovery',code:'not-logged-in',dispatch:'not-started',nextAction:'check-login'},state={...barState(),phase:'error',failure};
 const f=await routingBarFixture(async name=>name==='get_pi_routing'?{active:true,state}:{models:[]});
 assert.match(f.text(),/Native login required/);assert.match(f.text(),/Checking native login/);assert.match(f.text(),/codex login/);assert.match(f.text(),/Business task not dispatched/);
});

test('T2 control result unknown keeps state and refreshes it read-only without replaying a late applied action',async()=>{
 for(const rejects of [false,true]){
  let state=barState(),writes=0,reads=0;const f=await routingBarFixture(async(name,args)=>{
   if(name==='get_pi_routing'){reads++;return {active:true,state};}if(args.request.action==='catalog')return {models:[]};
   writes++;state={...state,revision:2,preferences:{model:'auto',effort:'max'}};
   if(rejects)throw Error('Pi control worker failed');
   return {controlFailure:{category:'unknown',stage:'control',code:'control-result-unknown',dispatch:'unknown',nextAction:'refresh-state'}};
  });
  f.select('Pi reasoning selection').props.onChange({target:{value:'max'}});await f.flush();f.button('Apply routing selection').props.onClick();await f.flush();
  assert.match(f.text(),/Control result is unconfirmed/);assert.ok(f.select('Pi reasoning selection'));assert.equal(writes,1);
  const before=reads,refresh=f.button('Refresh current state');assert.ok(refresh);refresh.props.onClick();await f.flush();
  assert.equal(reads,before+1);assert.equal(writes,1);assert.match(f.text(),/Current state refreshed/);assert.doesNotMatch(f.text(),/Task block cleared/);assert.ok(f.button('Apply routing selection').props.disabled);
 }
});

test('T2 unknown recovery control does not report success and its refreshed receipt invalidates old confirmation',async()=>{
 let state={...barState(),phase:'error',nativeRecovery:{receiptId:'old',status:'failed',reason:'unknown',cleanup:'unknown',inProgress:false,needsInspection:true}},writes=0;
 const f=await routingBarFixture(async(name,args)=>{if(name==='get_pi_routing')return {active:true,state};if(args.request.action==='catalog')return {models:[]};if(args.request.action==='native-recovery')return {state};writes++;return {controlFailure:{category:'unknown',stage:'control',code:'control-result-unknown',dispatch:'unknown',nextAction:'refresh-state'}};});
 f.button('View recovery information').props.onClick();await f.flush();f.button('Clear task block…').props.onClick();await f.flush();f.button('I checked the old task; clear the block').props.onClick();await f.flush();assert.equal(writes,1);assert.doesNotMatch(f.text(),/Task block cleared/);
 state={...state,revision:2,nativeRecovery:{...state.nativeRecovery,receiptId:'new'}};f.button('Refresh current state').props.onClick();await f.flush();assert.ok(!f.button('I checked the old task; clear the block')||f.button('I checked the old task; clear the block').props.disabled);assert.equal(writes,1);
});

test('T2 repair unknown rule application retains the draft without claiming saved or not applied',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default,rulesApi=await import('../src-tauri/pi/task-rules.mjs');
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiTaskRules');
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 for(const rejects of [false,true]){
  let state={...barState(),rules:structuredClone(defaultRules)},writes=0;
  const f=await routingBarFixture(async(name,args)=>{
   if(name==='get_pi_routing')return {state};if(args.request.action==='catalog')return {models:[]};
   assert.equal(args.request.action,'rules');writes++;state={...state,revision:2,rules:args.request.data};
   if(rejects)throw Error('Worker disconnected after applying rules');
   return {controlFailure:{category:'unknown',stage:'control',code:'control-result-unknown',dispatch:'unknown',nextAction:'refresh-state'}};
  });
  const props=f.rules().props,slots=[];let index=0;
  const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useEffect(){},Select:'select',t:s=>s,React:{createElement:(type,props,...children)=>({type,props:props??{},children})},...rulesApi};
  const component=new Function(...Object.keys(env),code+';return PiTaskRules;')(...Object.values(env));
  const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
  const render=()=>{index=0;return all(component(props));};
  render().find(n=>n.props['aria-label']==='Rule description: transform').props.onChange({target:{value:'New rule already applied remotely'}});
  await render().find(n=>n.type==='button'&&n.children.includes('Apply task rules')).props.onClick();await f.flush();
  const nodes=render(),text=nodes.flatMap(n=>n.children).filter(v=>typeof v==='string').join(' ');
  assert.match(text,/Control result is unconfirmed/);assert.doesNotMatch(text,/Task rules were not applied/);assert.equal(writes,1);
  assert.equal(nodes.find(n=>n.type==='button'&&n.children.includes('Apply task rules')).props.disabled,false,'draft must not be marked saved');
  assert.equal(nodes.find(n=>n.props['aria-label']==='Rule description: transform').props.value,'New rule already applied remotely');
  f.button('Refresh current state').props.onClick();await f.flush();assert.equal(writes,1);assert.equal(f.rules().props.rules.rules[0].description,'New rule already applied remotely');
 }
});

for(const mode of ['not-started','unknown','rejected'])test(`T2 quality repair initial catalog ${mode} preserves a visible failure and refreshes read-only`,async()=>{
 let catalogs=0,reads=0;const state=barState();
 const f=await routingBarFixture(async(name,args)=>{
  if(name==='get_pi_routing'){reads++;return {state};}
  assert.equal(args.request.action,'catalog');catalogs++;
  if(mode==='rejected')throw Error('Initial catalog worker rejected');
  return {controlFailure:{category:mode==='not-started'?'connection':'unknown',stage:'control',code:mode==='not-started'?'control-unavailable':'control-result-unknown',dispatch:mode,nextAction:'refresh-state'}};
 });
 assert.match(f.text(),mode==='not-started'?/Control connection unavailable/:/Failure cause unconfirmed/);
 assert.match(f.text(),mode==='not-started'?/Control request not sent/:/Control result is unconfirmed/);
 assert.deepEqual(f.catalogModels(),[]);assert.equal(catalogs,1);
 assert.equal(f.select('Pi model selection').props.disabled,true);
 const before=reads;f.button('Refresh current state').props.onClick();await f.flush();
 assert.equal(reads,before+1);assert.equal(catalogs,1);assert.match(f.text(),/Current state refreshed/);
 await f.poll();assert.equal(catalogs,1);assert.match(f.text(),/Refresh current state/);
});

test('T2 quality repair initial catalog success fills models and explicit recovery clears catalog errors',async()=>{
 const state=barState();let catalogs=0,fail=true;const actions=[];
 const f=await routingBarFixture(async(name,args)=>{
  if(name==='get_pi_routing')return {state};actions.push(args.request.action);
  if(args.request.action==='catalog'){catalogs++;if(fail)throw Error('CATALOG_ERROR_SENTINEL');return {models};}
  assert.equal(args.request.action,'retry');return {state};
 });
 assert.match(f.text(),/CATALOG_ERROR_SENTINEL/);fail=false;
 const refresh=f.button('Refresh current state');assert.ok(refresh);refresh.props.onClick();await f.flush();assert.equal(catalogs,1);
 f.button('Refresh connection').props.onClick();await f.flush();
 assert.deepEqual(f.catalogModels(),models);assert.doesNotMatch(f.text(),/CATALOG_ERROR_SENTINEL|Control result is unconfirmed/);assert.deepEqual(actions,['catalog','retry','catalog']);
 const successful=await routingBarFixture(async name=>name==='get_pi_routing'?{state}:{models});
 assert.deepEqual(successful.catalogModels(),models);assert.doesNotMatch(successful.text(),/Control result is unconfirmed|Control connection unavailable/);
});
