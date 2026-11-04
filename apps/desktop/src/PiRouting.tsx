// Author: Jeff.Liu. Pi remains the terminal and conversation owner.
import {useEffect,useRef,useState} from 'react';
import {openUrl} from '@tauri-apps/plugin-opener';
import {Select} from './Select';
import {t} from './i18n';
import {defaultRules,validateRules,rulesVersion,type TaskRules,type TaskRule} from '../src-tauri/pi/task-rules.mjs';
import {buildPiArgs,parsePiDraft,piLevels,piSetupMapping,piSetupStorageKey,restorePiSetup,selectPiSetupModel,validatePiDraft,verifyPiSetup,type PiDraft,type PiModel,type PiRoutingState,type PiSnapshot} from './pi-routing';
type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
function ModelOptions({models,value}:{models:PiModel[];value:string}){return <>{!models.some(m=>m.key===value)&&value&&<option value={value}>{value}</option>}{models.map(m=><option key={m.key} value={m.key}>{m.name} · {t(m.source==='chatgpt-subscription'?'ChatGPT subscription':m.source==='magpie'||m.key.startsWith('yam-gateway/')?'Magpie gateway':m.billing==='api'?'Pi native API':m.billing==='subscription'?'Pi native subscription':'Pi native')} · {m.key}</option>)}</>;}
export function PiRoutingConfig({args,cwd,invoke,onChange,onValidity,installedGateways=[]}:{args:string;cwd:string;invoke:Invoke;onChange:(args:string)=>void;onValidity:(state:{valid:boolean;scope:string})=>void;installedGateways?:string[]}){
 const root=useRef<HTMLFieldSetElement>(null),version=useRef(0),[visible,setVisible]=useState(false),[models,setModels]=useState<PiModel[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[warning,setWarning]=useState<string|null>(null);
 let draft:PiDraft|null=null,parseError:string|null=null;try{draft=parsePiDraft(args);}catch(e){parseError=String(e);}
 const [setupOpen,setSetupOpen]=useState(()=>!draft?.small&&!draft?.strong);
 let taskRules=null;try{taskRules=validateRules(draft?.rules?JSON.parse(draft.rules):defaultRules);}catch{}
 const gateway=draft?.gateway??null,scope=JSON.stringify([cwd,gateway]);
 const [verified,setVerified]=useState('');
 const [setupModels,setSetupModels]=useState<PiModel[]>([]),[setupModel,setSetupModel]=useState(''),[setupStatus,setSetupStatus]=useState(''),[setupGateway,setSetupGateway]=useState('http://127.0.0.1:3425');
 const [setupScope,setSetupScope]=useState(''),scopeRef=useRef(scope);scopeRef.current=scope;
 const [setupStatusScope,setSetupStatusScope]=useState(scope);
 const [setupGatewayWarning,setSetupGatewayWarning]=useState(false);
 const [setupNativeWarning,setSetupNativeWarning]=useState(false);
 const [freshGateways,setFreshGateways]=useState<string[]|null>(null),gateways=freshGateways??installedGateways;
 const argsRef=useRef(args);argsRef.current=args;
 useEffect(()=>{if(!visible)return;try{const restored=restorePiSetup(args,localStorage.getItem(piSetupStorageKey));if(restored)onChange(restored);}catch{}},[visible]);
 useEffect(()=>{const dialog=root.current?.closest('dialog');if(!dialog){setVisible(true);return;}const read=()=>setVisible(dialog.open);read();const observer=new MutationObserver(read);observer.observe(dialog,{attributes:true,attributeFilter:['open']});return()=>observer.disconnect();},[]);
 async function check(){const current=++version.current;setBusy(true);setError(null);setWarning(null);setVerified('');try{const result=await invoke<{models:PiModel[];warning?:string|null}>('pi_routing_catalog',{cwd,gateway});if(current===version.current){setModels(result.models);setWarning(result.warning??null);setVerified(scope);}}catch(e){if(current===version.current)setError(String(e));}finally{if(current===version.current)setBusy(false);}}
 useEffect(()=>{setModels([]);setVerified('');setSetupScope('');if(!visible){version.current++;setBusy(false);return;}const scheduledVersion=version.current;const timer=setTimeout(()=>{if(version.current===scheduledVersion)void check();},300);return()=>{clearTimeout(timer);version.current++;};},[scope,visible]);
 useEffect(()=>{if(setupStatusScope!==scope)setSetupStatus('');},[scope]);
 const issue=parseError??(verified===scope&&draft?validatePiDraft(draft,models,args):t('Check the connection and available Pi models.'));
 useEffect(()=>{onValidity({valid:!busy&&!issue&&visible,scope:JSON.stringify([cwd,args])});},[busy,issue,visible,args,cwd,onValidity]);
 function change(fields:Partial<PiDraft>){if(!draft)return;try{onChange(buildPiArgs(args,{...draft,...fields}));}catch(e){setError(String(e));}}
 async function discoverSetup(){
  if(!cwd.trim()||busy)return;const current=++version.current;setBusy(true);setSetupStatus('');setSetupStatusScope(scope);setSetupModels([]);setSetupModel('');setSetupScope(scope);setSetupGatewayWarning(false);setSetupNativeWarning(false);
  void invoke<string[]>('list_local_gateways').then(found=>{if(current===version.current&&Array.isArray(found)&&found.every(id=>['magpie','cc-switch','echobird'].includes(id)))setFreshGateways(found);}).catch(()=>{});
  try{
   let native:{models:PiModel[];preferred?:string|null}={models:[]},nativeFailed=false;try{native=await invoke<{models:PiModel[];preferred?:string|null}>('pi_routing_catalog',{cwd,gateway:null});}catch{nativeFailed=true;}
   const gateway=draft?.gateway??'http://127.0.0.1:3425';let gatewayModels:PiModel[]=[],gatewayFailed=false;try{const result=await invoke<{models:PiModel[];warning?:string|null}>('pi_routing_catalog',{cwd,gateway});gatewayModels=result.models.filter(m=>m.key.startsWith('yam-gateway/'));gatewayFailed=!!result.warning;}catch{gatewayFailed=true;}
   if(current!==version.current||scopeRef.current!==scope)return;const all=[...native.models,...gatewayModels];setSetupNativeWarning(nativeFailed&&all.length>0);setSetupGatewayWarning(gatewayFailed);setSetupGateway(gateway);setSetupModels(all);const choice=selectPiSetupModel(all,native.preferred??'');setSetupModel(choice);setSetupStatus(all.some(m=>m.levels.includes('high'))?'Choose a model to verify.':all.length?'No discovered model supports high reasoning. Select compatible models or configure fixed reasoning below.':nativeFailed?'Could not discover Pi models. Check Pi installation and login, then scan again.':'No compatible model found. Configure Pi login or add a provider, then scan again.');
  }catch{if(current===version.current&&scopeRef.current===scope)setSetupStatus('Could not discover Pi models. Check Pi installation and login, then scan again.');}
  finally{if(current===version.current){setBusy(false);if(verified!==scope)void check();}}
 }
 async function verifySetup(){
  if(!draft||!setupModel||busy||setupScope!==scope)return;const current=++version.current,original=args;setBusy(true);setSetupStatus('');
  try{
   const result=await verifyPiSetup(args,cwd,setupModel,invoke,setupGateway);
   if(current!==version.current||argsRef.current!==original||scopeRef.current!==scope)return;
   setSetupStatusScope(JSON.stringify([cwd,result.mapping.gateway]));
   try{localStorage.setItem(piSetupStorageKey,JSON.stringify(result.mapping));}catch{setSetupStatus('Model verified, but this device could not save the routing defaults.');onChange(result.args);return;}
   onChange(result.args);setSetupStatus('Model verified. The same model is selected for all three roles; you can change them below.');
  }catch(e){if(current===version.current&&scopeRef.current===scope)setSetupStatus(e instanceof Error&&['Invalid billing policy','Subscription-only billing requires a Codex subscription model.'].includes(e.message)?e.message:'Model verification failed. Check login, access and connection, or choose another model.');}
  finally{if(current===version.current)setBusy(false);}
 }
 function saveSetup(){
  if(!draft||busy||issue)return;
  setSetupStatusScope(scope);
  try{localStorage.setItem(piSetupStorageKey,JSON.stringify(piSetupMapping(draft,args)));setSetupStatus('Routing roles saved on this device.');}
  catch(e){setSetupStatus(e instanceof Error&&['Invalid billing policy','Subscription-only billing requires a Codex subscription model.'].includes(e.message)?e.message:'Could not save routing roles on this device.');}
 }
 function applySavedSetup(){
  setSetupStatusScope(scope);
  try{const restored=restorePiSetup(args,localStorage.getItem(piSetupStorageKey),true);if(!restored){setSetupStatus('Saved routing policy is unavailable or conflicts with the current billing policy.');return;}onChange(restored);setSetupStatus('Saved routing policy loaded. Check models and connection before starting.');}
  catch{setSetupStatus('Saved routing policy is unavailable or conflicts with the current billing policy.');}
 }
 return <fieldset className="pi-routing-config" ref={root}><legend>{t('Pi automatic routing')}</legend>
  <p className="settings-help">{t('Pi keeps the same native conversation and tools. Model and reasoning can be automatic or fixed independently.')}</p>
  <details className="pi-routing-advanced" open={setupOpen} onToggle={e=>setSetupOpen(e.currentTarget.open)}><summary>{t('Quick model setup')}</summary>
   <p className="settings-help">{t('Scan configured Pi, Codex and local Magpie models. Verification sends a short test request and may use your selected connection quota.')}</p>
   <button type="button" disabled={busy||!cwd.trim()} onClick={()=>void discoverSetup()}>{t('Find available models')}</button>
   <button type="button" disabled={busy} onClick={applySavedSetup}>{t('Use saved routing policy')}</button>
   {setupScope===scope&&setupModels.some(m=>m.levels.includes('high'))&&<><label><span>{t('Model to verify')}</span><Select aria-label={t('Model to verify')} value={setupModel} disabled={busy} onChange={e=>setSetupModel(e.target.value)}><option value="">{t('Choose a model')}</option><ModelOptions models={setupModels.filter(m=>m.levels.includes('high'))} value={setupModel}/></Select></label><button type="button" disabled={busy||!setupModel} onClick={()=>void verifySetup()}>{t('Verify and use this model')}</button></>}
   {setupStatus&&setupStatusScope===scope&&<p role="status">{t(setupStatus)}</p>}
   {setupScope===scope&&setupGatewayWarning&&(gateway!==null||gateways.includes('magpie'))&&<p className="settings-help" role="status">{t('Magpie gateway model catalog unavailable. Check the gateway; Pi native models remain available.')}</p>}
   {setupScope===scope&&setupNativeWarning&&<p className="settings-help" role="status">{t('Pi native model catalog unavailable. Gateway models are shown; check Pi and scan again.')}</p>}
   {draft?.small&&draft.strong&&<button type="button" disabled={busy||!!issue} onClick={saveSetup}>{t('Save routing roles on this device')}</button>}
   {setupStatusScope===scope&&(setupStatus==='No compatible model found. Configure Pi login or add a provider, then scan again.'||setupStatus==='No discovered model supports high reasoning. Select compatible models or configure fixed reasoning below.'||setupStatus==='Could not discover Pi models. Check Pi installation and login, then scan again.'||setupStatus==='Model verification failed. Check login, access and connection, or choose another model.')&&<div>
    <p className="settings-help">{t(gateways.includes('magpie')?'Magpie is installed. Configure a provider and start its local gateway, then scan again.':'Magpie can manage providers and expose models locally. Install and configure it, then return here and scan again.')}</p>
    <button type="button" onClick={()=>openUrl(gateways.includes('magpie')?'https://usemagpie.ai/docs/start':'https://usemagpie.ai/').catch(()=>setError('Could not open the link. Try again from the current terminal.'))}>{t(gateways.includes('magpie')?'Magpie setup guide':'Get Magpie')}</button>
    {gateways.includes('cc-switch')&&<p className="settings-help">{t('CC Switch is installed. Configure Pi through your existing tool if supported, then scan again. YAM does not read CC Switch models directly.')}</p>}
    {gateways.includes('echobird')&&<p className="settings-help">{t('EchoBird is installed. Configure Pi through your existing tool if supported, then scan again. YAM does not read EchoBird models directly.')}</p>}
    <p className="settings-help">{t('Prefer not to install another app? Run pi in a terminal and use /login, or configure a provider in Pi, then scan again.')}</p>
    <button type="button" onClick={()=>openUrl('https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md').catch(()=>setError('Could not open the link. Try again from the current terminal.'))}>{t('Pi provider setup guide')}</button>
   </div>}
  </details>
  {draft&&<><label><span>{t('Model connection')}</span><Select aria-label={t('Model connection')} value={gateway===null?'native':'gateway'} onChange={e=>change({gateway:e.target.value==='native'?null:'http://127.0.0.1:3425'})}><option value="native">{t('Pi native only')}</option><option value="gateway">{t('Pi native + Magpie')}</option></Select></label>
   <p className="settings-help">{t('ChatGPT subscription models use Pi login directly. Magpie adds other services. Choose each routing role explicitly; classifier, preview and correction use their configured channels. Subscription failures never trigger a paid channel fallback.')}</p>
   {gateway!==null&&<label><span>{t('Gateway URL')}</span><input value={gateway} onChange={e=>change({gateway:e.target.value})} placeholder="http://127.0.0.1:3425" autoComplete="off" spellCheck={false}/></label>}
   <div className="pi-routing-pair">{(['small','strong'] as const).map(role=><label key={role}><span>{t(role==='small'?'Lightweight model':'Strong model')}</span><Select aria-label={t(role==='small'?'Lightweight model':'Strong model')} value={draft![role]} onChange={e=>change({[role]:e.target.value})}><option value="">{t('Choose a model')}</option><ModelOptions models={models} value={draft![role]}/></Select></label>)}</div>
   <details className="pi-routing-advanced"><summary>{t('Routing preferences')}</summary><div className="pi-routing-pair"><label><span>{t('Model selection')}</span><Select aria-label={t('Model selection')} value={draft.model} onChange={e=>change({model:e.target.value})}><option value="auto">{t('Automatic by task')}</option><ModelOptions models={models} value={draft.model==='auto'?'':draft.model}/></Select></label><label><span>{t('Reasoning selection')}</span><Select aria-label={t('Reasoning selection')} value={draft.effort} onChange={e=>change({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label></div><label><span>{t('Classifier model')}</span><Select aria-label={t('Classifier model')} value={draft.classifier} onChange={e=>change({classifier:e.target.value})}><option value="">{t('Same as lightweight model')}</option><ModelOptions models={models} value={draft.classifier}/></Select></label><p className="settings-help">{t('A fixed reasoning level is preserved exactly. Unsupported selections stop with an explanation.')}</p></details>
   {taskRules?<PiTaskRules rules={taskRules} disabled={busy} onApply={rules=>change({rules:JSON.stringify(rules)})}/>:<button type="button" onClick={()=>change({rules:JSON.stringify(defaultRules)})}>{t('Restore default task rules')}</button>}
   <p className="settings-help">{t('These defaults apply to new sessions. Existing sessions keep their saved task rules; use Adjust routing to edit and preview them.')}</p>
  </>}
  {warning&&<p className="settings-help" role="status">{t(warning)}</p>}
  <div className="pi-routing-check"><button type="button" disabled={busy||!cwd.trim()||!!parseError} onClick={()=>void check()}>{busy?t('Checking Pi models…'):t('Check connection and models')}</button><span role="status">{busy?t('Reading Pi native model capabilities…'):error?t(error):issue?t(issue):t('Pi configuration checked')}</span></div>
 </fieldset>;
}
export function PiRoutingBar({sessionId,generation,active,available,invoke}:{sessionId:string;generation:string;active:boolean;available:boolean;invoke:Invoke}){
 const [state,setState]=useState<PiRoutingState|null>(null),[models,setModels]=useState<PiModel[]>([]);
 const [error,setError]=useState<string|null>(null),[readError,setReadError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [draft,setDraft]=useState<{model:string;effort:string;revision:number}|null>(null);
 const [expanded,setExpanded]=useState(false),[catalogError,setCatalogError]=useState<string|null>(null);
 const mounted=useRef(true),serial=useRef(false),readEpoch=useRef(0);
 useEffect(()=>{
  mounted.current=true;let stopped=false,needsRead=true;let timer:ReturnType<typeof setTimeout>;
  async function read(){
   if(stopped)return;const epoch=readEpoch.current;
   try{
    if(available&&document.visibilityState!=='hidden'){
     const next=await invoke<PiSnapshot>('get_pi_routing',{sessionId});
     if(!stopped&&epoch===readEpoch.current){needsRead=false;setReadError(null);setState(old=>JSON.stringify(old)===JSON.stringify(next.state)?old:next.state);}
    }
   }catch(e){if(!stopped&&epoch===readEpoch.current)setReadError(String(e));}
   finally{if(!stopped&&available&&(active||needsRead))timer=setTimeout(()=>void read(),1000);}
  }
  void read();return()=>{stopped=true;mounted.current=false;clearTimeout(timer);};
 },[sessionId,generation,active,available,invoke]);
 useEffect(()=>{
  if(!state||!active||!available||models.length)return;let stopped=false;
  void invoke<{models:PiModel[]}>('pi_routing_control',{sessionId,generation,request:{action:'catalog',revision:state.revision}})
   .then(result=>{if(!stopped){setModels(result.models??[]);setCatalogError(null);}}).catch(e=>{if(!stopped)setCatalogError(String(e));});
  return()=>{stopped=true;};
 },[!!state,active,available,sessionId,generation,invoke]);
 async function control(action:string,data?:unknown,revision=state?.revision){
  if(!state||serial.current)return;serial.current=true;readEpoch.current++;setBusy(true);setError(null);
  try{
   const result=await invoke<{state:PiRoutingState}>('pi_routing_control',{sessionId,generation,request:{action,revision,...(data?{data}:{})}});
   if(mounted.current){
    setReadError(null);setState(result.state);if(action==='set'||action==='reset')setDraft(null);
    if(action==='retry'){
     const next=await invoke<{models:PiModel[]}>('pi_routing_control',{sessionId,generation,request:{action:'catalog',revision:result.state.revision}});
     if(mounted.current){setModels(next.models??[]);setCatalogError(null);}
    }
    return result.state;
   }
  }catch(e){if(mounted.current)setError(String(e));return null;}
  finally{readEpoch.current++;serial.current=false;if(mounted.current)setBusy(false);}
 }
 const working=state&&['starting','classifying','selected','working'].includes(state.phase),disabled=!state||!active||!available||busy||!!working;
 const choice=draft??state?.preferences,dirty=!!(draft&&state&&(draft.model!==state.preferences.model||draft.effort!==state.preferences.effort));
 const stale=!!(draft&&state&&draft.revision!==state.revision);
 const live=active&&available&&!readError;
 const execution=state?.diagnostics?.execution;
 const executionStages={discovering:'Checking native login…',preparing:'Preparing context…',starting:'Starting native CLI…',executing:'Native task running',completed:'Native task completed',failed:'Execution failed',aborted:'Task interrupted'};
 const handoffReasons={'verified-prefix':'Verified context prefix','prefix-unverified':'Context checkpoint unavailable or changed','new-task':'New task requested','identity-changed':'Native identity changed','new-session':'New native session'};
 const selected=live&&state?.phase==='selected'?state.target:null;
 function choose(fields:Partial<{model:string;effort:string}>){if(state&&choice)setDraft({...choice,revision:draft?.revision??state.revision,...fields});}
 return <section className="pi-routing-bar" aria-label={t('Pi automatic routing')}>
  <div className="pi-routing-status"><strong>{t('Pi routing')}</strong>{(!available||!state||!active||state.phase==='error'||state.phase==='classifying')&&<span role="status">{!available?t('Background unavailable'):!state?t(active?'Waiting for Pi routing state…':'Routing state unavailable'):!active?t('Session ended'):t(state.phase==='classifying'?'Choosing a model…':'Routing needs attention')}</span>}
   {state&&<span className="pi-routing-model" role="status" title={selected?t('Selected for this turn; waiting for a native model response'):t('Recorded by the native Pi assistant message')}>{selected?t('Selected for this turn: {{value0}} · {{value1}}',{value0:selected.model,value1:selected.effort}):state.actual?t(live&&state.phase==='working'?'Actual model: {{value0}} · {{value1}}':'Latest reply used: {{value0}} · {{value1}}',{value0:state.actual.model,value1:state.actual.effort==='unknown'?t('Reasoning not confirmed'):state.actual.effort}):t('No native model response recorded yet')}</span>}
   {state?.actual?.source&&<span>{t(state.actual.source==='chatgpt-subscription'?'ChatGPT subscription':state.actual.source==='magpie'?'Magpie gateway':state.actual.billing==='subscription'?'Pi native subscription':'Pi native API')}</span>}
   {execution&&<span role="status">{t(executionStages[execution.stage])}</span>}
   {state&&<span className="pi-routing-policy">{state.preferences.model==='auto'?t('Automatic model'):t('Fixed model: {{value0}}',{value0:state.preferences.model})}</span>}
   <button type="button" aria-expanded={expanded} aria-controls={`pi-routing-controls-${sessionId}`} onClick={()=>setExpanded(value=>!value)}>{t('Adjust routing')}</button>
   {(error||readError||catalogError||state?.error||state?.gatewayError)&&<button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>}
  </div>
  {state&&choice&&<><div id={`pi-routing-controls-${sessionId}`} className="pi-routing-controls" hidden={!expanded}>
   <label><span>{t('Model')}</span><Select aria-label={t('Pi model selection')} value={choice.model} disabled={disabled} onChange={e=>choose({model:e.target.value})}><option value="auto">{t('Automatic by task')}</option><ModelOptions models={models} value={choice.model==='auto'?'':choice.model}/></Select></label>
   <label><span>{t('Reasoning')}</span><Select aria-label={t('Pi reasoning selection')} value={choice.effort} disabled={disabled} onChange={e=>choose({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label>
   <button type="button" disabled={disabled||!dirty||stale} onClick={()=>draft&&void control('set',{model:draft.model,effort:draft.effort},draft.revision)}>{t('Apply routing selection')}</button>
   {draft&&<button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('Cancel selection')}</button>}
   <button type="button" disabled={disabled||(!dirty&&state.preferences.model==='auto'&&state.preferences.effort==='auto')} onClick={()=>void control('reset')}>{t('Reset both to automatic')}</button>
   <button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>
   {state.rules&&<PiTaskRules rules={state.rules} disabled={disabled} onApply={async rules=>{if(!await control('rules',rules))throw Error(t('Task rules were not applied'));}} onPreview={async(text,rules)=>{const next=await control('preview',{text,rules}),p=next?.preview;if(!p)throw Error(t('Task rule preview failed'));return `${t('Matched task rule')}: ${t(p.rule)}\n${t(p.selection.model==='small'?'Lightweight model':'Strong model')} · ${p.selection.effort}\n${t('Classification time')}: ${p.latencyMs} ms\n${t('Model-reported cost')}: ${p.cost??t('Unknown cost')}\n${t('Policy preview only. Session locks, capacity and cache can change the final selection.')}`;}}/>}
   {state.decision&&<p className="settings-help">{t('Matched task rule')}: {t(state.decision.rule)} · {state.decision.ruleVersion}<br/>{t('Classification time')}: {state.decision.classificationMs} ms · {t('Model-reported cost so far')}: {state.decision.totalCost??t(state.actual?.billing==='subscription'?'Subscription usage; API cost unavailable':'Unknown cost')}</p>}
   {state.actual?.usage&&<p className="settings-help">{t('Reply tokens')}: {state.actual.usage.input??'—'} {t('input')} / {state.actual.usage.output??'—'} {t('output')}</p>}
   {state.diagnostics&&<p className="settings-help">{t(state.diagnostics.configSource==='session'?'Saved session configuration':'Launch configuration')} · {t(state.diagnostics.billing==='subscription'?'Subscription only':'Configured channels')}</p>}
   {execution&&<div className="settings-help" aria-label={t('Execution diagnostics')}>
    {execution.failedStage&&<p>{t('Failed stage')}: {t(executionStages[execution.failedStage as keyof typeof executionStages]??execution.failedStage)}</p>}
    {([['Model discovery',execution.discoveryMs],['CLI startup',execution.startupMs],['First reply event',execution.firstResponseMs],['Native execution',execution.executionMs]] as const).map(([label,value])=><p key={label}>{t(label)}: {value===null?'—':`${value} ms`}</p>)}
    <p>{t('First reply event is measured from native invocation; it is not a first-token estimate.')}</p>
    {execution.handoff&&<p>{t(execution.handoff.mode==='incremental'?'Incremental context':'Full context')} · {t(handoffReasons[execution.handoff.reason])} · {execution.handoff.characters} / {execution.handoff.budget} {t('characters')}</p>}
    {execution.failure==='context-budget'&&<p role="status">{t('Context was not sent. Use /compact in Pi or split the task, then explicitly retry. No task was replayed.')}</p>}
   </div>}
   <div className="pi-routing-details"><p>{state.preferences.effort==='auto'?t('Automatic reasoning'):t('Fixed reasoning: {{value0}}',{value0:state.preferences.effort})}</p><p>{state.config.gateway?t('Gateway: {{value0}}',{value0:state.config.gateway}):t('Existing Pi configuration')}</p>{state.target&&<p>{t('Selected for this turn: {{value0}} · {{value1}}',{value0:state.target.model,value1:state.target.effort})}<br/>{state.target.reason}</p>}{state.actual?<p title={t('Recorded by the native Pi assistant message')}>{t('Latest reply used: {{value0}} · {{value1}}',{value0:state.actual.model,value1:state.actual.effort==='unknown'?t('Reasoning not confirmed'):state.actual.effort})}</p>:<p>{t('No native model response recorded yet')}</p>}<p className="settings-help">{t('Refreshing never resends a task. Review the terminal before explicitly retrying work.')}</p></div>
  </div>
  {dirty&&<p className="settings-help" role="status">{stale?t('Routing changed. Cancel this selection and choose again from the current state.'):t('Selection is not applied. Apply model and reasoning together when ready.')}</p>}
  {state.gatewayError&&<p className="settings-help" role="status">{t(state.gatewayError)}</p>}
  {state.pendingInput&&<p className="settings-help" role="status">{t('Unsent input is preserved in the Pi terminal.')}</p>}
  {(error||readError||catalogError||state.error)&&<p className="pi-routing-error" role="alert">{t(error??readError??catalogError??state.error!)}</p>}</>}
  {!state&&(error||readError)&&<p className="pi-routing-error" role="alert">{t(error??readError!)}</p>}
 </section>;
}

export function PiTaskRules({rules,disabled,onApply,onPreview}:{rules:TaskRules;disabled:boolean;onApply:(rules:TaskRules)=>Promise<void>|void;onPreview?:(text:string,rules:TaskRules)=>Promise<string>}){
 const saved=JSON.stringify(rules);
 const [draft,setDraft]=useState(()=>({rules:validateRules(rules),base:saved})),[text,setText]=useState(''),[result,setResult]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const dirty=JSON.stringify(draft.rules)!==draft.base,stale=draft.base!==saved;
 useEffect(()=>{if(!dirty)setDraft({rules:validateRules(rules),base:saved});},[saved,dirty]);
 let issue='';try{validateRules(draft.rules);}catch(e){issue=String(e);}
 function change(task:TaskRule['task'],fields:Partial<TaskRule>){setDraft(old=>({...old,rules:{...old.rules,rules:old.rules.rules.map(r=>r.task===task?{...r,...fields}:r)}}));setResult('');}
 async function apply(){if(disabled||busy||stale||issue||!dirty)return;setBusy(true);setError('');try{const next=validateRules(draft.rules);await onApply(next);setDraft({rules:next,base:JSON.stringify(next)});setResult('');}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function preview(){if(!onPreview||disabled||busy||issue||!text.trim())return;setBusy(true);setError('');setResult('');try{setResult(await onPreview(text,validateRules(draft.rules)));}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <details className="pi-routing-advanced"><summary>{t('Task rules')} · {rulesVersion(rules)}</summary>
  <p className="settings-help">{t('Rules describe task types. Model locks and capability checks always apply. Changes require Apply.')}</p>
  <fieldset disabled={disabled||busy}>{draft.rules.rules.map(rule=><div key={rule.task}>
   <strong>{t(rule.task)}</strong>
   <label><span>{t('Task description')}</span><textarea aria-label={`Rule description: ${rule.task}`} maxLength={600} value={rule.description} onChange={e=>change(rule.task,{description:e.target.value})}/></label>
   <label><span>{t('Examples (one per line, up to four)')}</span><textarea aria-label={`Rule examples: ${rule.task}`} value={rule.examples.join('\n')} onChange={e=>change(rule.task,{examples:e.target.value.split('\n').filter(Boolean)})}/></label>
   <label><span>{t('Model')}</span><Select aria-label={`Rule model: ${rule.task}`} value={rule.model} onChange={e=>change(rule.task,{model:e.target.value as TaskRule['model']})}><option value="strong">{t('Strong model')}</option>{['transform','answer'].includes(rule.task)&&<option value="small">{t('Lightweight model')}</option>}</Select></label>
   <label><span>{t('Reasoning')}</span><Select aria-label={`Rule reasoning: ${rule.task}`} value={rule.effort} onChange={e=>change(rule.task,{effort:e.target.value as TaskRule['effort']})}>{(['transform','answer'].includes(rule.task)?['medium','high','xhigh','max']:['high','xhigh','max']).map(level=><option key={level} value={level}>{level}</option>)}</Select></label>
  </div>)}</fieldset>
  <label><span>{t('Fallback reasoning')}</span><Select aria-label="Fallback reasoning" disabled={disabled||busy} value={draft.rules.fallback.effort} onChange={e=>{setDraft(old=>({...old,rules:{...old.rules,fallback:{model:'strong',effort:e.target.value as TaskRules['fallback']['effort']}}}));setResult('');}}>{['high','xhigh','max'].map(level=><option key={level} value={level}>{level}</option>)}</Select></label>
  <button type="button" disabled={disabled||busy||!dirty||stale||!!issue} onClick={apply}>{t('Apply task rules')}</button>
  <button type="button" disabled={disabled||busy} onClick={()=>{setDraft(old=>({...old,rules:validateRules(defaultRules)}));setResult('');}}>{t('Restore default task rules')}</button>
  <button type="button" disabled={busy} onClick={()=>{setDraft({rules:validateRules(rules),base:saved});setResult('');setError('');}}>{t('Cancel rule changes')}</button>
  {stale&&dirty&&<p role="alert">{t('Task rules changed. Cancel edits and start from the current version.')}</p>}
  {onPreview&&<><label><span>{t('Preview request')}</span><textarea aria-label="Preview request" maxLength={4000} disabled={disabled||busy} value={text} onChange={e=>{setText(e.target.value);setResult('');}}/></label><p className="settings-help">{t('Preview classifies this text only. It does not execute or save the task. A classifier call may incur cost.')}</p><button type="button" disabled={disabled||busy||!!issue||!text.trim()} onClick={preview}>{t('Try task rules')}</button></>}
  {result&&<pre role="status">{result}</pre>}{(issue||error)&&<p role="alert">{issue||error}</p>}
 </details>;
}
