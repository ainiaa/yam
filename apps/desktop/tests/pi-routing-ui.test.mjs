import {hasPiRoutingSelection,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,probePiSetupModel} from '../src/pi-routing.ts';
// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as routingPolicies from '../src/routing-policies.ts';
test('Codex uses the shared editable roles without losing sparse groups or connection data',()=>{
 assert.equal(typeof routingPolicies.codexRoutingDraft,'function');
 const original={connections:{sub:{billing:'subscription',home:'/private/old-home'}},classifiers:['sub/a','sub/b'],executionGroups:[{small:'sub/small',medium:'sub/medium',strong:'sub/strong'},{},{medium:'sub/backup'}]};
 const draft=routingPolicies.codexRoutingDraft(JSON.stringify(original));
 assert.deepEqual(draft.executionFallbacks.medium,['','sub/backup']);
 const updated=JSON.parse(routingPolicies.buildCodexRoutingConfig(JSON.stringify(original),{...draft,effort:'high'}));
 assert.deepEqual(updated.connections,original.connections);
 assert.deepEqual(updated.executionGroups,original.executionGroups);
 assert.deepEqual(updated.classifiers,original.classifiers);
 assert.equal(updated.effort,'high');
 const empty=routingPolicies.codexRoutingDraft('');
 assert.equal(JSON.parse(empty.rules).v,2);
});
import {defaultRules} from '../src-tauri/pi/task-rules.mjs';
import {parsePiDraft,buildPiArgs,validatePiDraft,defaultPiArgs,selectPiSetupModel,restorePiSetup,verifyPiSetup,piSetupMapping,portablePiRoutingPolicy,importPiRoutingPolicy} from '../src/pi-routing.ts';
const models=[{key:'p/small',name:'Small',levels:['medium','high'],context_window:10000},{key:'p/strong',name:'Strong',levels:['medium','high','max'],context_window:100000}];
const draft={gateway:null,small:'p/small',strong:'p/strong',classifier:'',model:'auto',effort:'auto'};
test('Pi launch eligibility can be checked without any model catalog',()=>{
 const configured={...draft,classifier:'p/offline'};
 assert.equal(validatePiDraft(configured,undefined),null);
 assert.match(validatePiDraft(configured,models),/p\/offline/);
 assert.match(validatePiDraft({...configured,gateway:'https://user@example.com'},undefined),/Gateway/);
 assert.match(validatePiDraft(configured,undefined,'--yam-billing subscription'),/Subscription/);
});
test('Pi legacy classifier remains A and ordered B/C survive settings and launch args',()=>{
 const saved=JSON.stringify({gateway:null,small:'p/small',strong:'p/strong',classifier:'p/a'});
 const original=parsePiDraft(restorePiSetup('',saved));
 assert.equal(original.classifier,'p/a');assert.equal(original.classifierFallbacks,undefined);
 const configured={...original,classifierFallbacks:['p/b','p/c']};
 const args=buildPiArgs('',configured);
 assert.deepEqual(parsePiDraft(args).classifierFallbacks,['p/b','p/c']);
 assert.deepEqual(piSetupMapping(configured,args).classifierFallbacks,['p/b','p/c']);
 assert.deepEqual(parsePiDraft(restorePiSetup('',JSON.stringify(piSetupMapping(configured,args)))).classifierFallbacks,['p/b','p/c']);
 assert.throws(()=>buildPiArgs('',{...configured,classifierFallbacks:['p/a']}),/classifier/i);
});
test('Pi classifier candidate D round trips and the eight-candidate limit is enforced',()=>{
 const configured={...draft,classifier:'p/a',classifierFallbacks:['p/b','p/c','p/d']};
 const saved=JSON.stringify(piSetupMapping(configured,buildPiArgs('',configured)));
 assert.deepEqual(parsePiDraft(restorePiSetup('',saved)).classifierFallbacks,configured.classifierFallbacks);
 assert.deepEqual(portablePiRoutingPolicy(saved).classifierFallbacks,configured.classifierFallbacks);
 assert.throws(()=>buildPiArgs('',{...configured,classifierFallbacks:Array.from({length:8},(_,i)=>`p/backup-${i}`)}),/classifier/i);
});
test('Pi execution backups round trip per tier with no gateway and reject invalid policies',()=>{
 const executionFallbacks={small:['p/b','p/c','p/d'],strong:['q/last']},configured={...draft,executionFallbacks};
 const args=buildPiArgs('',configured),raw=JSON.stringify(piSetupMapping(configured,args));
 assert.deepEqual(parsePiDraft(args).executionFallbacks,executionFallbacks);
 const portable=portablePiRoutingPolicy(raw);
 assert.deepEqual(portable.executionFallbacks,executionFallbacks);
 const imported=restorePiSetup('',importPiRoutingPolicy(portable));
 assert.deepEqual(parsePiDraft(imported).executionFallbacks,executionFallbacks);
 assert.equal(parsePiDraft(imported).gateway,null);
 assert.equal(parsePiDraft(restorePiSetup(args,JSON.stringify(piSetupMapping(draft,'')),true)).executionFallbacks,undefined);
 for(const invalid of [{small:['p/small']},{small:['p/b','p/b']},{medium:['p/m']},{unknown:['p/m']},{strong:Array.from({length:8},(_,i)=>`p/b${i}`)}]){
  assert.throws(()=>buildPiArgs('',{...draft,executionFallbacks:invalid}),/execution fallbacks/i);
 }
 const subscription={...draft,small:'yam-codex/small',strong:'yam-codex/strong',executionFallbacks:{strong:['p/paid']}};
 assert.throws(()=>piSetupMapping(subscription,'--yam-billing subscription'),/subscription/i);
});
test('Pi execution groups keep a blank B tier and a populated C tier through save and import',()=>{
 const executionFallbacks={small:['p/b'],medium:['','p/medium-c'],strong:['p/strong-b','','p/strong-d']};
 const configured={...draft,medium:'p/medium',executionFallbacks};
 const args=buildPiArgs('',configured),raw=JSON.stringify(piSetupMapping(configured,args));
 assert.deepEqual(parsePiDraft(args).executionFallbacks,executionFallbacks);
 assert.deepEqual(parsePiDraft(restorePiSetup('',raw)).executionFallbacks,executionFallbacks);
 assert.deepEqual(parsePiDraft(restorePiSetup('',importPiRoutingPolicy(portablePiRoutingPolicy(raw)))).executionFallbacks,executionFallbacks);
 assert.throws(()=>buildPiArgs('',{...configured,classifierFallbacks:['','p/c']}),/classifier fallbacks/i);
});
test('Replacing Pi settings clears removed backups and billing overrides in an open draft',()=>{
 const open=buildPiArgs('--tools read',{...draft,classifier:'p/a',classifierFallbacks:['p/b','p/c'],classifierBilling:'api'});
 const saved=JSON.stringify(piSetupMapping({...draft,classifier:'p/a'},''));
 const args=restorePiSetup(open,saved,true);
 assert.ok(args.includes('--tools read'));
 const reloaded=parsePiDraft(args);
 assert.equal(reloaded.classifier,'p/a');
 assert.equal(reloaded.classifierFallbacks,undefined);
 assert.equal(reloaded.classifierBilling,undefined);
});
test('Pi keeps the selected classifier billing channel and subscription aliases through backup',()=>{
 const api={...draft,classifier:'p/a',classifierFallbacks:['p/b'],classifierBilling:'api'};
 const saved=JSON.stringify(piSetupMapping(api,buildPiArgs('',api)));
 assert.equal(parsePiDraft(restorePiSetup('',saved)).classifierBilling,'api');
 assert.equal(portablePiRoutingPolicy(saved).classifierBilling,'api');
 const restricted={...draft,small:'yam-codex/small',strong:'yam-codex/strong',classifier:'yam-codex/a',classifierFallbacks:['openai/b','yam-codex/c']};
 const args=buildPiArgs('--yam-billing subscription',restricted);
 const raw=JSON.stringify(piSetupMapping(restricted,args));
 assert.deepEqual(parsePiDraft(restorePiSetup('',raw)).classifierFallbacks,restricted.classifierFallbacks);
 assert.deepEqual(portablePiRoutingPolicy(raw).classifierFallbacks,restricted.classifierFallbacks);
 assert.throws(()=>piSetupMapping({...restricted,classifierFallbacks:['p/paid']},args),/subscription/i);
});
test('Pi exposes an explicit billing choice when backup classifiers are configured and A has no catalog billing',async()=>{
 const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'));
 assert.match(source,/aria-label=\{t\('Classifier billing channel'\)\}/);
 assert.match(source,/onChange=\{.*change\(\{classifierBilling:/);
});
test('Pi fixed execution with automatic reasoning can launch without a classifier',()=>{
 const fixed={...draft,model:'p/strong',small:'',strong:'',classifier:''};
 assert.equal(validatePiDraft(fixed,models),null);
 assert.equal(parsePiDraft(restorePiSetup('',JSON.stringify(piSetupMapping(fixed,'')))).model,'p/strong');
 assert.match(validatePiDraft({...fixed,classifierFallbacks:['p/b']},models),/classifier/i);
});
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
 await assert.rejects(()=>verifyPiSetup('','/tmp','yam-gateway/api/model',invoke),/Model verification failed/);assert.equal(calls,0);
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
test('Pi setup reports installed tools separately from discovered models and probes only detected or configured gateways',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],opened=[],stored=[],scannedGateways=[];let index=0,refIndex=0,result={models:[]},failed=false,detected=[],gatewayWarning=false,cwd='/tmp',args='--yam-small p/small --yam-strong p/strong';
 const invoke=async(name,request)=>{if(name==='list_local_gateways')return detected;scannedGateways.push(request.gateway);if(failed)throw Error('offline');return request.gateway&&gatewayWarning?{...result,warning:'Magpie is offline'}:result;};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:()=>{},Select:'select',RoutingModelPicker:'routing-model-picker',hasPiRoutingSelection,probePiSetupModel,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupMapping,piSetupStorageKey:'setup',piLevels:['high'],t:(s,v={})=>s.replace('{{value0}}',v.value0??''),openUrl:async url=>opened.push(url),localStorage:{getItem:()=>null,setItem:(_key,value)=>stored.push(value)},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=gateways=>{index=refIndex=0;return component({args,cwd,invoke,onChange:value=>args=value,onValidity:()=>{},installedGateways:gateways});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 const scan=async gateways=>{all(render(gateways)).find(n=>n.type==='button'&&n.children.includes('Find available models')).props.onClick();await new Promise(r=>setImmediate(r));return render(gateways);};
 assert.equal(all(render([])).find(n=>n.props.label==='Lightweight model').props.catalogChecked,false);
 const quick=all(render([])).find(n=>n.type==='details'&&n.props.className==='pi-routing-advanced');assert.equal(quick.props.open,false);quick.props.onToggle({currentTarget:{open:true}});
 assert.doesNotMatch(JSON.stringify(render([])),/Get Magpie/);
 let tree=await scan([]);assert.equal(all(tree).find(n=>n.type==='details'&&n.props.className==='pi-routing-advanced').props.open,true);assert.match(JSON.stringify(tree),/Get Magpie/);assert.match(JSON.stringify(tree),/\/login/);
 assert.equal(scannedGateways.at(-1),null);
 assert.match(JSON.stringify(tree),/official Codex CLI/);
 assert.match(JSON.stringify(tree),/codex login/);
 assert.doesNotMatch(JSON.stringify(tree),/ChatGPT subscription models use Pi login directly/);
 const link=all(tree).find(n=>n.type==='button'&&n.children.includes('Get Magpie'));await link.props.onClick();assert.deepEqual(opened,['https://usemagpie.ai/']);
 const piGuide=all(tree).find(n=>n.type==='button'&&n.children.includes('Pi provider setup guide'));await piGuide.props.onClick();assert.equal(opened[1],'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md');
 const originalArgs=args;args+=' --yam-gateway http://127.0.0.1:4311';await scan([]);
 assert.deepEqual(scannedGateways.splice(0),[null,'http://127.0.0.1:4311']);args=originalArgs;
 let finishDetection;detected=new Promise(resolve=>finishDetection=resolve);
 all(render([])).find(n=>n.type==='button'&&n.children.includes('Find available models')).props.onClick();
 cwd='/tmp/changed';render([]);finishDetection(['magpie']);await new Promise(r=>setImmediate(r));
 assert.deepEqual(scannedGateways,[]);cwd='/tmp';
 detected=['cc-switch'];result={models:[...models,{...models[1],key:'cc-custom/model'},{...models[1],key:'yam-gateway/stray'}]};tree=await scan([]);
 assert.doesNotMatch(JSON.stringify(tree),/Get Magpie/);
 assert.match(JSON.stringify(tree),/CC Switch is installed.*Enable a provider in its Pi tab/);
 assert.equal(scannedGateways.at(-1),null);
 assert.ok(all(tree).filter(n=>n.type===env.RoutingModelPicker).every(n=>!n.props.models.some(m=>m.key==='yam-gateway/stray')));
 assert.ok(all(tree).find(n=>n.type===env.RoutingModelPicker&&n.props.models.some(m=>m.key==='cc-custom/model')));
 assert.equal(all(tree).find(n=>n.props.label==='Lightweight model').props.catalogChecked,true);
 detected=['magpie','cc-switch'];tree=await scan([]);
 assert.equal(scannedGateways.at(-1),'http://127.0.0.1:3425');
 gatewayWarning=true;tree=await scan([]);assert.match(JSON.stringify(tree),/Magpie gateway model catalog unavailable/);assert.match(JSON.stringify(tree),/Verify model/);gatewayWarning=false;
 failed=true;tree=await scan([]);assert.match(JSON.stringify(tree),/Magpie setup guide/);assert.doesNotMatch(JSON.stringify(tree),/Verify model/);
 failed=false;result={models:[{...models[0],levels:['medium']}]};tree=await scan([]);assert.match(JSON.stringify(tree),/No discovered model supports high reasoning/);assert.match(JSON.stringify(tree),/Magpie setup guide/);assert.doesNotMatch(JSON.stringify(tree),/Verify model/);
 result={models:[{...models[0],key:'yam-gateway/test/model'}],used_default_directory:true};tree=await scan([]);
 assert.equal(all(tree).find(n=>n.props.label==='Model to verify').props.value,'yam-gateway/test/model');
 assert.deepEqual(all(tree).find(n=>n.props.label==='Lightweight model').props.models,[]);
 assert.equal(all(tree).find(n=>n.type==='button'&&n.children.includes('Verify model')).props.disabled,true);assert.match(JSON.stringify(tree),/Models were scanned using the local Pi configuration/);
 cwd='/tmp/other';tree=render([]);assert.doesNotMatch(JSON.stringify(tree),/No discovered model supports high reasoning|Magpie setup guide/);
 args=buildPiArgs('--yam-billing subscription',{...draft,small:'yam-codex/a',strong:'yam-codex/b',model:'openai/gpt-4'});
 result={models:[{...models[0],key:'openai/gpt-4',billing:'api'}]};
 const button=label=>all(render([])).find(n=>n.type==='button'&&n.children.includes(label));
 button('Check connection and models').props.onClick();await new Promise(r=>setImmediate(r));
 failed=true;button('Check connection and models').props.onClick();await new Promise(r=>setImmediate(r));
 button('Save routing roles on this device').props.onClick();
 assert.deepEqual(stored,[]);
 assert.match(JSON.stringify(render([])),/Subscription-only billing requires a Codex subscription model/);
 args=buildPiArgs('',{...draft,classifier:'p/a',classifierFallbacks:['p/b','p/c','p/d']});
 all(render([])).find(n=>n.props.label==='Primary classifier A').props.onChange({target:{value:'p/c'}});
 assert.deepEqual([parsePiDraft(args).classifier,...parsePiDraft(args).classifierFallbacks],['p/c','p/b','p/d']);
 args=buildPiArgs('',{...draft,classifierFallbacks:['p/b','p/c']});
 all(render([])).find(n=>n.props.label==='Lightweight model').props.onChange({target:{value:'p/b'}});
 assert.deepEqual([parsePiDraft(args).small,...parsePiDraft(args).classifierFallbacks],['p/b','p/c']);
 args=buildPiArgs('',{...draft,medium:'p/medium'});
 const groups=()=>all(render([])).filter(n=>n.type==='fieldset'&&/^Execution group /.test(n.props['aria-label']??''));
 assert.deepEqual(groups().map(n=>n.props['aria-label']),['Execution group A','Execution group B','Execution group C']);
 assert.ok(groups().every(n=>all(n).filter(child=>child.type===env.RoutingModelPicker).length===3));
 all(groups()[2]).find(n=>n.props.label==='Execution group C · Strong model').props.onChange({target:{value:'p/standby'}});
 assert.deepEqual(parsePiDraft(args).executionFallbacks,{strong:['','p/standby']});
});
test('Pi quick setup verifies before saving and ignores stale completion',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],saved=new Map();let index=0,refIndex=0,args='',cwd='/tmp/project',release,fail=false;
 const invoke=async(_name,request)=>request.probeModel?fail?{models,probe:{ok:false}}:new Promise(r=>release=()=>r({models,probe:{ok:true}})):{models,preferred:'p/strong'};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:()=>{},Select:'select',RoutingModelPicker:'routing-model-picker',hasPiRoutingSelection,probePiSetupModel,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupStorageKey:'setup',piLevels:['low','medium','high','xhigh','max'],t:s=>s,localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=()=>{index=refIndex=0;return component({args,cwd,invoke,onChange:v=>args=v,onValidity:()=>{}});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 const button=text=>all(render()).find(n=>n.type==='button'&&n.children.includes(text));
 await button('Find available models').props.onClick();await new Promise(r=>setImmediate(r));render();
 args='--yam-gateway http://127.0.0.1:4567';assert.equal(button('Verify and initialize routing roles'),undefined);args='';render();
 const pending=button('Verify and initialize routing roles').props.onClick();await new Promise(r=>setImmediate(r));
 args='--yam-small p/manual';render();release();await pending;await new Promise(r=>setImmediate(r));assert.equal(args,'--yam-small p/manual');assert.equal(saved.size,0);
 args='';render();const stale=button('Verify and initialize routing roles').props.onClick();await new Promise(r=>setImmediate(r));cwd='/tmp/other';render();release();await stale;await new Promise(r=>setImmediate(r));assert.equal(saved.size,0);assert.equal(args,'');assert.equal(button('Verify and initialize routing roles'),undefined);
 cwd='/tmp/project';render();
 args='';fail=true;await button('Verify and initialize routing roles').props.onClick();await new Promise(r=>setImmediate(r));assert.equal(saved.size,0);assert.equal(args,'');assert.match(JSON.stringify(render()),/Pi provider setup guide/);
 args='--yam-billing subscription';assert.equal(button('Verify and initialize routing roles'),undefined);assert.equal(saved.size,0);
 args='';fail=false;const good=button('Verify and initialize routing roles').props.onClick();await new Promise(r=>setImmediate(r));release();await good;await new Promise(r=>setImmediate(r));assert.equal(parsePiDraft(args).strong,'p/strong');assert.equal(saved.size,1);
});
test('Pi quick scan lists ChatGPT and native Magpie together with one catalog request',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='PiRoutingConfig');
 const slots=[],refs=[],effects=[];let index=0,refIndex=0,timer,release,scans=0;
 const magpie={...models[1],key:'magpie/provider/model',billing:'api'};
 const native={...models[1],key:'yam-codex/gpt-6-luna',source:'chatgpt-subscription',billing:'subscription'};
 const direct={...magpie,key:'yam-gateway/provider/model'};
 const invoke=async(name,request)=>{if(name==='list_local_gateways')return [];if(++scans===1)return await new Promise(r=>release=()=>r({models:[magpie,native,direct],preferred:native.key}));return {models,preferred:'p/strong'};};
 const env={useState:value=>{const i=index++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef:value=>{const i=refIndex++;return refs[i]??(refs[i]={current:value});},useEffect:fn=>effects.push(fn),setTimeout:fn=>(timer=fn,1),clearTimeout:()=>{},Select:'select',RoutingModelPicker:'routing-model-picker',hasPiRoutingSelection,probePiSetupModel,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,PiTaskRules:()=>null,defaultRules:{},validateRules:()=>({}),buildPiArgs,parsePiDraft,validatePiDraft,verifyPiSetup,selectPiSetupModel,restorePiSetup,piSetupStorageKey:'setup',piLevels:['high'],t:s=>s,localStorage:{getItem:()=>null},React:{createElement:(type,props,...children)=>({type,props:props??{},children})}};
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingConfig;')(...Object.values(env));
 const render=()=>{index=refIndex=0;effects.length=0;return component({args:'',cwd:'/tmp/project',invoke,onChange:()=>{},onValidity:()=>{}});};
 const all=n=>!n||typeof n!=='object'?[]:[n,...(n.children??[]).flat(Infinity).flatMap(all)];
 render();effects[1]();render();effects[2]();
 all(render()).find(n=>n.type==='button'&&n.children.includes('Find available models')).props.onClick();await new Promise(r=>setImmediate(r));
 timer();await new Promise(r=>setImmediate(r));release();await new Promise(r=>setImmediate(r));
 const tree=all(render());
 assert.match(JSON.stringify(tree),/Verify and initialize routing roles/);
 const quickOptions=tree.find(n=>n.props.label==='Model to verify');
 assert.equal(quickOptions.props.value,native.key);
 assert.deepEqual(quickOptions.props.models.map(model=>model.key),[magpie.key,native.key]);
 quickOptions.props.onBrowse();
 assert.equal(all(render()).find(n=>n.type==='button'&&n.children.includes('Verify and initialize routing roles')).props.disabled,true);
 assert.equal(scans,1,'manual discovery satisfies the pending directory check');
 tree.find(n=>n.type==='button'&&n.children.includes('Check connection and models')).props.onClick();
 await new Promise(r=>setImmediate(r));
 const refreshed=all(render());
 assert.doesNotMatch(JSON.stringify(refreshed),/Model to verify/);
});
test('automatic routing settings and launch strategy selection are separate',async()=>{
 const {readFileSync}=await import('node:fs'),read=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
 const {matchesSettingsPage}=await import('../src/settings-search.ts');
 assert.match(read('SettingsNavigation.tsx'),/\['pi-routing','Automatic routing'\]/);
 assert.equal(matchesSettingsPage('pi-routing','Pi routing','分类模型'),true);
 assert.match(read('App.tsx'),/<RoutingPolicyChoice[\s\S]*?openSettingsSection\("pi-routing"\)/);
 assert.doesNotMatch(read('App.tsx'),/<PiRoutingConfig/);
 assert.match(read('PiRouting.tsx'),/aria-label=\{t\('Classification models'\)\}/);
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
 const dependencies={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useEffect:fn=>{if(first)effects.push(fn);},Select:()=>null,RoutingModelPicker:'routing-model-picker',hasPiRoutingSelection,probePiSetupModel,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,piLevels:['high','max'],t:(s)=>s,React:{createElement:(type,props,...children)=>({type,props:props??{},children})},document:{visibilityState:'visible'},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 const presentation=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='routingModelPresentation');
 const code=ts.transpileModule(presentation.getText(ast)+'\n'+declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
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
 const env={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useEffect:(fn,deps)=>{const i=effectIndex++,old=dependencies[i];if(!old||deps.some((v,j)=>v!==old[j])){dependencies[i]=deps;pending.push(fn);}},Select:()=>null,RoutingModelPicker:'routing-model-picker',hasPiRoutingSelection,probePiSetupModel,maxPiBackupModels,piExecutionTiers,piModelCatalogSource,piSubscriptionCatalog,piSubscriptionOnly,PiTaskRules:'task-rules',piLevels:['high','max'],t:(s,values={})=>s.replace(/{{(\w+)}}/g,(_,key)=>values[key]??''),React:{createElement:(type,props,...children)=>({type,props:props??{},children})},document:{visibilityState:options.visibility??'visible'},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}};
 const presentation=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='routingModelPresentation');
 const code=ts.transpileModule(presentation.getText(ast)+'\n'+declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return PiRoutingBar;')(...Object.values(env));let tree;
 const render=()=>{index=refIndex=effectIndex=0;tree=component({sessionId:options.sessionId??'s-pi',generation:options.generation??'g',active:options.active??true,available:options.available??true,invoke});return tree;};
 const all=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(all)];
 const tick=()=>new Promise(r=>setImmediate(r));
 const flush=async()=>{for(let i=0;i<3;i++){render();for(const effect of pending.splice(0))effect();await tick();}render();};
 await flush();return {visible:value=>env.document.visibilityState=value,flush,poll:async()=>{timers.shift()?.();await flush();},select:label=>all(tree).find(n=>(n.props['aria-label']??n.props.label)===label),button:text=>all(tree).find(n=>n.type==='button'&&n.children.includes(text)),catalogModels:()=>all(tree).find(n=>n.type===env.RoutingModelPicker)?.props.models,rules:()=>all(tree).find(n=>n.type==='task-rules'),tree:()=>tree,text:()=>all(tree).flatMap(n=>n.children).filter(v=>typeof v==='string').join(' ')};
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
test('Pi live model labels match the picker for subscription and gateway roles',async()=>{
 const sol='yam-codex/gpt-6.1-sol',flash='magpie/auto/deepseek-v4-flash',rejected='yam-gateway/deepseek/other';
 let state={...barState(),phase:'selected',preferences:{model:sol,effort:'high'},
  target:{model:flash,effort:'high',reason:'answer'},actual:{model:sol,effort:'medium',at:2,source:'chatgpt-subscription',billing:'subscription'},
  decision:{rule:'answer',ruleVersion:'v2',classificationMs:0,totalCost:null,rejected:[{model:rejected,reason:'effort'}]}};
 const f=await routingBarFixture(async name=>name==='get_pi_routing'?{state}:{models:[{...models[0],key:rejected,source:'magpie',billing:'gateway'}]});
 const visible=()=>visibleRoutingText(f.tree());
 assert.match(visible(),/Selected for this turn: Magpie · Automatic routing · deepseek-v4-flash · high/);
 assert.match(visible(),/Fixed model: Pi native · ChatGPT subscription · gpt-6\.1-sol/);
 f.button('Adjust routing').props.onClick();await f.flush();
 assert.match(visible(),/Magpie · deepseek · other\s*:\s*Reasoning level unsupported/);
 assert.match(visible(),/Latest reply used: Pi native · ChatGPT subscription · gpt-6\.1-sol · medium/);
 state={...state,phase:'working'};await f.poll();
 assert.match(visible(),/Actual model: Pi native · ChatGPT subscription · gpt-6\.1-sol · medium/);
 assert.doesNotMatch(visible(),/yam-codex|yam-gateway|magpie\/auto\//);
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

test('routing model picker separates connections, preserves model paths and waits for explicit model selection',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='RoutingModelPicker');
 assert.ok(declaration,'each role has a connection and model picker');
 const config={connections:{native:{billing:'subscription',native:true},'yam-codex':{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'},separate:{billing:'subscription',home:'/tmp/codex'},paid:{billing:'paid',home:'/tmp/paid',baseUrl:'https://example.com'}}};
 const subscription='native/auto/deepseek-v4-flash',gateway='yam-codex/auto/deepseek-v4-flash';
 const catalog=[{...models[0],key:subscription},{...models[0],key:gateway},{...models[0],key:'yam-codex/codex/gpt-6.1-sol'}];
 const changes=[];
 let state;
 const react={createElement:(type,props,...children)=>({type,props:props??{},children})};
 const env={React:react,Select:'select',t:s=>s,useState:initial=>[state??initial,next=>state=next],piModelCatalogSource};
 const helpers=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&['routingModelPresentation','routingModelOptions','codexConnectionLabels'].includes(node.name?.text));
 const code=ts.transpileModule([...helpers,declaration].map(node=>node.getText(ast)).join('\n'),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const component=new Function(...Object.keys(env),code+';return RoutingModelPicker;')(...Object.values(env));
 const all=node=>node&&typeof node==='object'?[node,...(node.children??[]).flat(Infinity).flatMap(all)]:[];
 const render=(value=subscription,available=catalog,connections=config.connections,catalogChecked=true)=>{
  const tree=all(component({label:'Strong model',models:available,value,connections,catalogChecked,onChange:event=>changes.push(event.target.value)}));
  const [source,model]=tree.filter(node=>node.type==='select');
  return {source,model,text:JSON.stringify(tree)};
 };
 const initial=render();
 assert.equal(initial.source.props.value,'native');
 assert.equal(initial.model.props.value,subscription);
 const options=picker=>all(picker).filter(node=>node.type==='option');
 const connectionLabels=options(initial.source).map(node=>node.children.join(''));
 assert.match(connectionLabels.join(' '),/Codex native · ChatGPT subscription.*Local gateway · 127\.0\.0\.1:3425.*Separate subscription connection.*Explicit paid Responses connection/);
 assert.doesNotMatch(connectionLabels.join(' '),/yam-codex/);
 assert.equal(options(initial.model).find(node=>node.props.value===subscription).children.join(''),'Codex native · ChatGPT subscription · auto/deepseek-v4-flash');
 initial.source.props.onChange({target:{value:'yam-codex'}});
 assert.deepEqual(changes,[]);
 const pending=render();
 assert.equal(pending.source.props.value,'yam-codex');
 assert.notEqual(pending.model.props.value,gateway);
 assert.match(pending.text,/Current selection.*Codex native · ChatGPT subscription · auto\/deepseek-v4-flash/);
 const choice=options(pending.model).find(option=>option.props.value===gateway);
 assert.equal(choice.children.join(''),'Local gateway · Automatic routing · deepseek-v4-flash');
 assert.match(choice.props['data-search'],/yam-codex\/auto\/deepseek-v4-flash/);
 assert.equal(options(pending.model).find(node=>node.props.value==='yam-codex/codex/gpt-6.1-sol').children.join(''),'Local gateway · Codex · gpt-6.1-sol');
 assert.ok(all(pending.model).some(node=>node.type==='optgroup'&&node.props.label==='Local gateway'));
 pending.model.props.onChange({target:{value:gateway}});
 assert.deepEqual(changes,[gateway]);
 assert.equal(render(gateway).model.props.value,gateway);
 const unchecked=render(gateway,[],config.connections,false);
 assert.match(unchecked.text,/Current selection.*Local gateway · Automatic routing · deepseek-v4-flash/);
 assert.doesNotMatch(unchecked.text,/Saved model unavailable/);
 assert.match(render(gateway,[]).text,/Saved model unavailable.*Local gateway · Automatic routing · deepseek-v4-flash/);
 assert.match(render(gateway,[],{native:config.connections.native},false).text,/Saved connection unavailable.*Saved model unavailable/);
 assert.match(render(gateway,catalog,{native:config.connections.native}).text,/Saved model unavailable.*auto\/deepseek-v4-flash/);
 const pi=render('magpie/auto/deepseek-v4-flash',[{...models[0],key:'magpie/auto/deepseek-v4-flash'},{...models[0],key:'p/deepseek-v4-flash',billing:'api'}],null);
 assert.match(pi.text,/Magpie via Pi.*Pi native API/);
 assert.equal(pi.model.props.value,'magpie/auto/deepseek-v4-flash');
 assert.equal(options(pi.model).find(node=>node.props.value===pi.model.props.value).children.join(''),'Magpie · Automatic routing · deepseek-v4-flash');
 const native=render('yam-codex/gpt-6.1-sol',[{...models[0],key:'yam-codex/gpt-6.1-sol',billing:'subscription'}],null);
 assert.equal(options(native.model).find(node=>node.props.value===native.model.props.value).children.join(''),'Pi native · ChatGPT subscription · gpt-6.1-sol');
 const deepseek='magpie/deepseek/namespace/deepseek-v4-flash';
 const vendor=render(deepseek,[{...models[0],key:deepseek}],null);
 assert.equal(options(vendor.model).find(node=>node.props.value===deepseek).children.join(''),'Magpie · deepseek · namespace/deepseek-v4-flash');
});

test('adding a local gateway retains the native connection and both model identities on save',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='CodexRoutingConnections');
 const labels=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='codexConnectionLabels');
 const code=ts.transpileModule([labels,declaration].map(node=>node.getText(ast)).join('\n'),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const react={createElement:(type,props,...children)=>({type,props:props??{},children})};
 const component=new Function('React','t','Select','codexRoutingConfig',code+';return CodexRoutingConnections;')(react,s=>s,'select',routingPolicies.codexRoutingConfig);
 let raw='';
 const all=node=>node&&typeof node==='object'?[node,...(node.children??[]).flat(Infinity).flatMap(all)]:[];
 const add=()=>all(component({raw,onChange:next=>raw=next})).find(node=>node.type==='button'&&node.children.includes('Add local gateway')).props.onClick();
 add();add();
 assert.deepEqual(Object.keys(routingPolicies.codexRoutingConfig(raw).connections),['yam-codex','local-gateway','local-gateway-2']);
 const draft=routingPolicies.codexRoutingDraft(raw),id='auto/deepseek-v4-flash';
 const setup=routingPolicies.buildCodexRoutingConfig(raw,{...draft,small:`local-gateway/${id}`,medium:`yam-codex/${id}`,strong:'yam-codex/gpt-6.1-sol',classifier:'yam-codex/gpt-6-luna'});
 const [saved]=routingPolicies.readRoutingPolicies(JSON.stringify(routingPolicies.upsertRoutingPolicy([],{id:'mixed',name:'Mixed',adapter:'codex',setup})),null);
 assert.deepEqual(routingPolicies.codexRoutingDraft(saved.setup),routingPolicies.codexRoutingDraft(setup));
 assert.equal(routingPolicies.codexRoutingDraft(saved.setup).small,`local-gateway/${id}`);
 assert.equal(routingPolicies.codexRoutingDraft(saved.setup).medium,`yam-codex/${id}`);
 assert.equal(routingPolicies.codexRoutingConfig(saved.setup).connections['yam-codex'].native,true);
});

test('Pi cannot save an API-billed registry model as a subscription-only role',()=>{
 const key='openai/gpt-4',routing={...draft,small:'yam-codex/a',strong:'yam-codex/b',model:key};
 const paid={key,name:'GPT-4',billing:'api',levels:['high'],context_window:1000};
 assert.throws(()=>piSetupMapping(routing,'--yam-billing subscription',[paid]),/Subscription-only/);
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


test('named desktop policies retain explicit model references and offer only compatible choices',async()=>{
 const {readRoutingPolicies,upsertRoutingPolicy,compatibleRoutingPolicies,routingPolicyArgs}=await import('../src/routing-policies.ts');
 const legacy=JSON.stringify({gateway:null,small:'p/light',medium:'p/mid',strong:'p/strong',classifier:'p/classify',classifierFallbacks:['p/backup']});
 const migrated=readRoutingPolicies(null,legacy);
 assert.equal(migrated.length,1);
 const rows=upsertRoutingPolicy(migrated,{id:'development',name:'Development',adapter:'pi',setup:legacy});
 assert.deepEqual(readRoutingPolicies(JSON.stringify(rows),null),rows);
 assert.deepEqual(compatibleRoutingPolicies(rows,'codex'),[]);
 assert.deepEqual(compatibleRoutingPolicies(rows,'opencode'),[]);
 assert.deepEqual(compatibleRoutingPolicies(rows,'pi').map(row=>row.id),[migrated[0].id,'development']);
 assert.deepEqual(parsePiDraft(routingPolicyArgs('pi','--theme minimal','development',rows)).classifierFallbacks,['p/backup']);
 assert.equal(routingPolicyArgs('codex','--model codex-model','development',rows),null);
 assert.equal(routingPolicyArgs('pi','','missing',rows),null);
 assert.throws(()=>upsertRoutingPolicy(rows,{id:'other',name:'development',adapter:'pi',setup:legacy}));
 assert.throws(()=>readRoutingPolicies(JSON.stringify([{...rows[1],setup:'{}'}]),null));
});

test('explicit routing off preserves native Pi options and removes previous routing flags',async()=>{
 const {routingPolicyArgs,initialRoutingPolicy}=await import('../src/routing-policies.ts');
 const {isPiRoutingOff}=await import('../src/pi-routing.ts');
 const args="--model 'p/native' --thinking high --yam-small p/light --yam-strong p/strong --theme minimal";
 assert.equal(initialRoutingPolicy('pi',args),'launch-config');
 assert.equal(initialRoutingPolicy('pi','--model p/native'),'');
 assert.equal(initialRoutingPolicy('codex',args),'');
 const off=routingPolicyArgs('pi',args,'',[]);
 assert.equal(isPiRoutingOff(off),true);
 assert.equal(parsePiDraft(off).model,'p/native');
 assert.equal(parsePiDraft(off).effort,'high');
 assert.match(off,/--theme minimal/);
 assert.doesNotMatch(off,/--yam-small|--yam-strong/);
 assert.equal(routingPolicyArgs('codex','--model codex-model','',[]),'--model codex-model');
 assert.equal(routingPolicyArgs('pi',args,'launch-config',[]),args);
});

test('new session strategy selector offers saved Pi and Codex strategies and gates OpenCode',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const api=await import('../src/routing-policies.ts');
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='RoutingPolicyChoice');
 const code=ts.transpileModule(declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const env={Select:'select',t:text=>text,React:{createElement:(type,props,...children)=>({type,props:props??{},children})},...api,portablePiRoutingPolicy};
 const render=new Function(...Object.keys(env),code+';return RoutingPolicyChoice;')(...Object.values(env));
 const all=node=>node&&typeof node==='object'?[node,...(node.children??[]).flat(Infinity).flatMap(all)]:[];
 const legacy=api.readRoutingPolicies(null,JSON.stringify({gateway:null,small:'p/a',strong:'p/b',classifier:'p/c'}));
 const setup=JSON.stringify({connections:{sub:{billing:'subscription',home:'/tmp/isolated-codex'}},classifiers:['sub/classify'],executionGroups:[{small:'sub/light',medium:'sub/mid',strong:'sub/strong'},{},{}]});
 const policies=api.upsertRoutingPolicy(legacy,{id:'codex-local',name:'Local Codex',adapter:'codex',setup});
 assert.deepEqual(api.readRoutingPolicies(JSON.stringify(policies),null),policies);
 assert.deepEqual(api.codexRoutingLaunch('codex-local',policies),{name:'Local Codex',config:setup});
 assert.equal(api.codexRoutingLaunch(legacy[0].id,policies),null);
 assert.equal(api.codexRoutingLaunch('',policies),undefined);
 assert.throws(()=>api.upsertRoutingPolicy(policies,{id:'secret',name:'Secret',adapter:'codex',setup:setup.replace('"billing":"subscription"','"billing":"subscription","apiKey":"do-not-save"')}));
 let changed,manage=0;
 const props={policies,choice:'',launchPolicy:false,invalid:false,onChange:value=>changed=value,onManage:()=>manage++};
 const pi=all(render({...props,adapter:'pi'})),selector=pi.find(node=>node.type==='select');
 assert.equal(selector.props.disabled,false);
 assert.deepEqual(pi.filter(node=>node.type==='option').map(node=>node.props.value),['',policies[0].id]);
 assert.match(JSON.stringify(pi),/Choose a saved strategy to enable automatic routing/);
 selector.props.onChange({target:{value:policies[0].id}});
 assert.equal(changed,policies[0].id);
 pi.find(node=>node.type==='button').props.onClick();
 assert.equal(manage,1);
 const codex=all(render({...props,adapter:'codex'})),codexSelector=codex.find(node=>node.type==='select');
 assert.equal(codexSelector.props.disabled,false);
 assert.deepEqual(codex.filter(node=>node.type==='option').map(node=>node.props.value),['','codex-local']);
 assert.match(JSON.stringify(codex),/Choose a saved strategy to enable automatic routing/);
 assert.doesNotMatch(JSON.stringify(codex),/Save a Codex strategy/);
 assert.match(JSON.stringify(render({...props,adapter:'codex',policies:legacy})),/Save a Codex strategy/);
 assert.match(JSON.stringify(render({...props,adapter:'codex',policies:legacy,choice:api.launchRoutingPolicy,launchPolicy:true})),/This strategy starts a YAM-managed Codex terminal/);
 codexSelector.props.onChange({target:{value:'codex-local'}});
 assert.equal(changed,'codex-local');
 const opencode=all(render({...props,adapter:'opencode'}));
 assert.equal(opencode.find(node=>node.type==='select').props.disabled,true);
 assert.deepEqual(opencode.filter(node=>node.type==='option').map(node=>node.props.value),['']);
});

test('imported legacy Pi defaults remain selectable alongside named policies',async()=>{
 const {importPreviousPiPolicy}=await import('../src/routing-policies.ts');
 const setup=JSON.stringify({gateway:null,small:'p/light',strong:'p/strong',classifier:'p/classifier'});
 const rows=[{id:'existing',name:'Imported Pi policy',adapter:'pi',setup:JSON.stringify({...JSON.parse(setup),small:'p/old'})}];
 const imported=importPreviousPiPolicy(rows,setup,'Imported Pi policy',()=> 'new');
 assert.equal(imported[0].setup,rows[0].setup);
 assert.equal(imported[1].name,'Imported Pi policy (2)');
 assert.deepEqual(importPreviousPiPolicy(imported,setup,'Imported Pi policy',()=>assert.fail()),imported);
});

test('live route selector can enable a saved strategy from off and replace a pending choice while busy',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const api=await import('../src/routing-policies.ts');
 const ast=ts.createSourceFile('PiRouting.tsx',fs.readFileSync(new URL('../src/PiRouting.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='LiveRoutingControls');
 const helpers=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&['routingModelPresentation','routingModelOptions'].includes(node.name?.text));
 const code=ts.transpileModule(helpers.map(node=>node.getText(ast)).join('\n')+'\n'+declaration.getText(ast).replace(/^export /,''),{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020}}).outputText;
 const env={piModelCatalogSource,Select:'select',t:text=>text,useState:value=>[value,()=>{}],React:{createElement:(type,props,...children)=>({type,props:props??{},children})},...api};
 const render=new Function(...Object.keys(env),code+';return LiveRoutingControls;')(...Object.values(env));
 const all=node=>node&&typeof node==='object'?[node,...(node.children??[]).flat(Infinity).flatMap(all)]:[];
 const policies=api.readRoutingPolicies(null,JSON.stringify({gateway:null,small:'p/a',strong:'p/b',classifier:'p/c'})),calls=[];
 const mode={enabled:false,policyId:null,policyName:null,pending:null,pendingPolicyId:null,error:null,nativeModel:'p/native'};
 const options={policies,models:[],disabled:false,onSwitch:value=>calls.push(value)};
 const pick=overrides=>all(render({...options,mode:{...mode,...overrides}})).find(node=>node.type==='select'&&node.props['aria-label']==='Session routing strategy');
 pick().props.onChange({target:{value:policies[0].id}});
 assert.equal(calls[0].policy.classifier,'p/c');
 assert.equal(calls[0].policy.gateway,null);
 const pending=pick({pending:'Previous Pi policy',pendingPolicyId:policies[0].id});
 assert.equal(pending.props.disabled,false);
 assert.equal(pending.props.value,policies[0].id);
 pending.props.onChange({target:{value:''}});
 assert.deepEqual(calls[1],{policy:null});
 const subscription={...models[0],key:'openai-codex/gpt-6.1-sol',source:'chatgpt-subscription',billing:'subscription'};
 const gateway={...models[0],key:'yam-gateway/deepseek/flash',source:'magpie',billing:'gateway'};
 const nativePicker=all(render({...options,mode:{...mode,enabled:true,nativeModel:null},models:[subscription,gateway]})).find(node=>node.props['aria-label']==='Native model when routing is off');
 assert.equal(nativePicker.props.searchLabel,'Search models');
 assert.deepEqual(all(nativePicker).filter(node=>node.type==='optgroup').map(node=>node.props.label),['Pi native']);
 assert.deepEqual(all(nativePicker).filter(node=>node.type==='option').map(node=>[node.props.value,node.children.join('')]),[['','Use current Pi defaults'],[subscription.key,'Pi native · ChatGPT subscription · gpt-6.1-sol']]);
});

test('Codex gateway drafts retain the explicit API classifier billing channel',()=>{
 const config={connections:{local:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}},classifiers:['local/deepseek/pro'],executionGroups:[{small:'local/deepseek/pro',medium:'local/deepseek/pro',strong:'local/deepseek/pro'}],effort:'high'};
 assert.equal(routingPolicies.codexRoutingDraft(JSON.stringify(config)).classifierBilling,'api');
});

test('Codex gateway quick setup fills every tier and uses supported reasoning',async()=>{
 const model={key:'yam-codex/deepseek/pro',cli:'codex',billing:'api',levels:['low','high','max'],input:['text']};
 const raw=JSON.stringify({connections:{'yam-codex':{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}},classifiers:[],executionGroups:[{},{},{}]});
 const verified=await verifyPiSetup('', '/tmp', model.key,async()=>({models:[model],probe:{ok:true}}));
 const setup=routingPolicies.codexQuickSetupConfig(raw,verified.args,[model]);
 const config=JSON.parse(setup.args);assert.equal(config.executionGroups[0].medium,model.key);assert.equal(config.effort,'high');assert.equal(routingPolicies.validateCodexDraft(setup.args,[model]),null);
});

test('verifying a Codex gateway model preserves configured roles and reasoning on reload',async()=>{
 const flash={key:'local/auto/deepseek-v4-flash',cli:'codex',billing:'api',levels:['high']};
 const original={connections:{native:{billing:'subscription',native:true},local:{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}},
  classifiers:['native/a','local/auto/old-classifier','native/c'],executionGroups:[{small:'local/auto/deepseek-v4-flash',medium:'native/sol',strong:'native/astra'},{},{strong:'local/auto/old-strong'}],model:'auto',effort:'medium'};
 const raw=JSON.stringify(original);
 const verified=await verifyPiSetup('','/tmp',flash.key,async()=>({models:[flash],probe:{ok:true}}));
 const setup=routingPolicies.codexQuickSetupConfig(raw,verified.args,[flash]);
 assert.equal(setup.fixedEffort,false);
 assert.deepEqual(JSON.parse(setup.args),original);
 assert.deepEqual(routingPolicies.codexRoutingDraft(setup.args).executionFallbacks.strong,['','local/auto/old-strong']);
});

test('migrated Pi defaults retain their subscription constraint without overriding explicit choices',async()=>{
 const {readRoutingPolicies,initialRoutingPolicy,routingPolicyArgs}=await import('../src/routing-policies.ts');
 const {isPiRoutingOff,piSubscriptionOnly}=await import('../src/pi-routing.ts');
 const setup=JSON.stringify({gateway:null,small:'yam-codex/light',strong:'yam-codex/deep',classifier:'yam-codex/classifier',billing:'subscription'});
 const rows=readRoutingPolicies(null,setup),args='--theme minimal';
 const initial=initialRoutingPolicy('pi',args,rows);
 assert.equal(initial,'previous-pi');
 const restored=routingPolicyArgs('pi',args,initial,rows);
 assert.equal(piSubscriptionOnly(restored),true);
 assert.equal(parsePiDraft(restored).small,'yam-codex/light');assert.match(restored,/--theme minimal/);
 for(const explicit of ['--yam-routing-off','--model p/native','--provider custom'])assert.equal(initialRoutingPolicy('pi',explicit,rows),'');
 assert.equal(initialRoutingPolicy('pi',restored,rows),'launch-config');
 assert.equal(initialRoutingPolicy('codex','',rows),'');
 assert.equal(initialRoutingPolicy('pi','',[]),'');
 assert.equal(initialRoutingPolicy('pi','',rows.map(row=>({...row,id:'user-policy'}))),'');
 assert.equal(isPiRoutingOff(routingPolicyArgs('pi',args,'',rows)),true);
 const custom={id:'chosen',name:'Chosen',adapter:'pi',setup:JSON.stringify({gateway:null,small:'p/small',strong:'p/strong',classifier:'p/classifier'})};
 assert.equal(parsePiDraft(routingPolicyArgs('pi',args,custom.id,[...rows,custom])).small,'p/small');
});

test('launch dialog applies migrated Pi defaults only while routing selection is unset',async()=>{
 const fs=await import('node:fs'),ts=(await import('typescript')).default;
 const api=await import('../src/routing-policies.ts');
 const ast=ts.createSourceFile('App.tsx',fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const wanted=new Set(['launchPolicy','routingChoice','piLaunchArgs']),declarations=[];
 function visit(node){if(ts.isVariableDeclaration(node)&&wanted.has(node.name.getText(ast)))declarations.push('const '+node.getText(ast)+';');ts.forEachChild(node,visit);}visit(ast);
 assert.equal(declarations.length,3);
 const code=ts.transpileModule(declarations.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const setup=JSON.stringify({gateway:null,small:'yam-codex/light',strong:'yam-codex/deep',classifier:'yam-codex/classifier',billing:'subscription'}),rows=api.readRoutingPolicies(null,setup);
 const base={...api,formAdapter:'pi',sessionCopy:null,formLaunch:{extra_args:''},routingPolicyLibrary:{rows},routingPolicySelection:null};
 const render=selection=>{const bindings={...base,routingPolicySelection:selection};return new Function(...Object.keys(bindings),code+';return {routingChoice,piLaunchArgs};')(...Object.values(bindings));};
 const initial=render(null);assert.equal(initial.routingChoice,'previous-pi');assert.equal(piSubscriptionOnly(initial.piLaunchArgs),true);
 const off=render('');assert.equal(off.routingChoice,'');assert.match(off.piLaunchArgs,/--yam-routing-off/);
 const chosen=render('previous-pi');assert.equal(chosen.routingChoice,'previous-pi');assert.equal(piSubscriptionOnly(chosen.piLaunchArgs),true);
});
