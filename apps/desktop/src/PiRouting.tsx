// Author: Jeff.Liu. Pi remains the terminal and conversation owner.
import {useEffect,useRef,useState} from 'react';
import {openUrl} from '@tauri-apps/plugin-opener';
import {Select} from './Select';
import type {SettingsNavigationRenderer} from './SettingsNavigation';
import {t} from './i18n';
import {codexQuickSetupConfig,codexRoutingConfig,codexRoutingDraft,buildCodexRoutingConfig,validateCodexDraft,compatibleRoutingPolicies,launchRoutingPolicy,routingPolicyPayload,supportsDesktopRouting,type LiveRoutingPolicy,type RoutingPolicy} from './routing-policies';
import {defaultRules,defaultTierRules,validateRules,rulesVersion,type TaskRules,type TaskRule} from '../src-tauri/pi/task-rules.mjs';
import {buildPiArgs,hasPiRoutingSelection,knownClassifierBilling,maxPiBackupModels,parsePiDraft,piExecutionTiers,piLevels,piModelCatalogSource,piSetupMapping,piSetupStorageKey,portablePiRoutingPolicy,piSubscriptionCatalog,piSubscriptionOnly,probePiSetupModel,restorePiSetup,selectPiSetupModel,validatePiDraft,verifyPiSetup,type NativeFailure,type PiDraft,type PiModel,type PiRoutingState,type PiSessionRoutingMode,type PiSnapshot} from './pi-routing';
type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
type CodexConnections=ReturnType<typeof codexRoutingConfig>['connections'];
function routingModelPresentation(key:string,model:PiModel|undefined,connections?:CodexConnections|null){
 const provider=key.split('/',1)[0],id=key.slice(key.indexOf('/')+1),catalog=piModelCatalogSource(key);
 const connection=connections&&Object.prototype.hasOwnProperty.call(connections,provider)?connections[provider]:null;
 const gateway=connection?'gateway' in connection:!connections&&catalog!=='pi';
 const magpie=model?.source==='magpie'||!connections&&catalog==='magpie-pi';
 const source=t(gateway?magpie?'Magpie':'Local gateway':connections?connection&&'native' in connection?'Codex native':'Codex':'Pi native');
 let modelId=id,supplier='';
 if(gateway){
  const separator=id.indexOf('/');
  if(separator>0){
   const route=id.slice(0,separator);
   supplier=route==='auto'?t('Automatic routing'):route==='codex'?'Codex':route;
   modelId=id.slice(separator+1);
  }
 }else if(connection?.billing==='subscription'||!connections&&(model?.source==='chatgpt-subscription'||model?.legacy_alias||provider==='yam-codex'&&model?.billing!=='api')){
  supplier=t('ChatGPT subscription');
 }else if(connection?.billing==='paid'){
  try{supplier=new URL(connection.baseUrl??'').hostname;}catch{supplier=t('API');}
 }else if(!connections){
  supplier=provider==='openai'?'OpenAI':['yam-codex','yam-gateway'].includes(provider)?model?.billing==='api'?t('API'):'':provider;
 }
 return {source,label:[source,supplier,modelId].filter(Boolean).join(' · ')};
}
function codexConnectionLabels(connections:CodexConnections,models:PiModel[]=[]){
 const labels=Object.entries(connections).map(([key,connection])=>{
  const gateway='gateway' in connection,native='native' in connection;
  const source=native?`${t('Codex native')} · ${t('ChatGPT subscription')}`:gateway?
   t(models.some(model=>model.key.startsWith(key+'/')&&model.source==='magpie')?'Magpie':'Local gateway'):
   t(connection.billing==='subscription'?'Separate subscription connection':'Explicit paid Responses connection');
  const alias=/^(?:yam-codex|connection-\d+|local-gateway(?:-\d+)?)$/.test(key)?'':key;
  let endpoint='';
  if(!native&&connection.baseUrl)try{endpoint=new URL(connection.baseUrl).host;}catch{}
  const home=!native&&!gateway?connection.home.split('/').filter(Boolean).slice(-2).join('/'):'';
  return [key,[source,alias||endpoint||home].filter(Boolean).join(' · ')] as const;
 });
 return new Map(labels.map(([key,label],index)=>{
  const matches=labels.filter(([,name])=>name===label);
  return [key,matches.length===1?label:`${label} · ${t('Connection {{number}}',{number:labels.slice(0,index+1).filter(([,name])=>name===label).length})}`];
 }));
}
function RoutingModelPicker({label,models,value,connections,emptyValue='',emptyLabel='Choose a model',disabled,onChange,onBrowse}:{label:string;models:PiModel[];value:string;connections?:CodexConnections|null;emptyValue?:string;emptyLabel?:string;disabled?:boolean;onChange:React.ChangeEventHandler<HTMLSelectElement>;onBrowse?:()=>void}){
 const connectionOf=(key:string)=>key.split('/',1)[0];
 const saved=value!==emptyValue?value:'';
 const savedConnection=saved?connectionOf(saved):'';
 const [browsing,setBrowsing]=useState<{saved:string;connection:string}|null>(null);
 const options=connections?codexConnectionLabels(connections,models):new Map<string,string>();
 if(!connections)for(const model of models){
  if(model.legacy_alias&&model.key!==saved)continue;
  const key=connectionOf(model.key),source=piModelCatalogSource(model.key);
  const kind=source==='magpie-direct'?model.source==='magpie'?'Magpie direct':'Local gateway':source==='magpie-pi'?'Magpie via Pi':key==='yam-codex'&&model.billing!=='api'?'Native Codex login':model.billing==='subscription'||model.source==='chatgpt-subscription'?'Pi native subscription':model.billing==='api'?'Pi native API':'Pi native';
  const identity=['yam-codex','yam-gateway','magpie'].includes(key)?'':key;
  if(!options.has(key))options.set(key,[t(kind),identity].filter(Boolean).join(' · '));
 }
 if(savedConnection&&!options.has(savedConnection))options.set(savedConnection,t('Saved connection unavailable'));
 const connection=browsing?.saved===saved&&(!browsing.connection||options.has(browsing.connection))?browsing.connection:savedConnection;
 const configured=(key:string)=>!connections||Object.prototype.hasOwnProperty.call(connections,key);
 const available=configured(connection)?models.filter(model=>!model.legacy_alias&&connectionOf(model.key)===connection):[];
 const current=configured(savedConnection)&&models.some(model=>model.key===saved);
 const pending=!!saved&&connection!==savedConnection;
 const savedLabel=saved?routingModelPresentation(saved,models.find(model=>model.key===saved),connections).label:'';
 const groups=new Map<string,{model:PiModel;label:string}[]>();
 for(const model of available){
  const {source,label}=routingModelPresentation(model.key,model,connections),rows=groups.get(source)??[];
  rows.push({model,label});groups.set(source,rows);
 }
 return <div className="pi-model-picker" role="group" aria-label={label}>
  <span>{label}</span>
  <label><span>{t('Connection')}</span><Select aria-label={`${label} · ${t('Connection')}`} value={connection} disabled={disabled||!options.size} onChange={event=>{
   setBrowsing({saved:onBrowse?'':saved,connection:event.target.value});onBrowse?.();
  }}><option value="">{t('Choose a connection')}</option>{Array.from(options,([key,name])=><option key={key} value={key}>{name}</option>)}</Select></label>
  <label><span>{t('Model')}</span><Select aria-label={label} searchLabel={t('Search models')} value={pending?'pending':value} disabled={disabled||!connection&&!saved} onChange={event=>{
   setBrowsing(null);onChange(event);
  }}>
   {pending&&<option value="pending" disabled>{t('Choose a model')}</option>}
   <option value={emptyValue}>{t(emptyLabel)}</option>
   {!pending&&saved&&!available.some(model=>model.key===saved)&&<option value={saved} disabled>{t(current?'Current selection':'Saved model unavailable')} · {savedLabel}</option>}
   {Array.from(groups,([source,rows])=><optgroup key={source} label={source}>{rows.map(({model,label})=><option key={model.key} value={model.key} data-search={`${model.name} ${model.key}`}>{label}</option>)}</optgroup>)}
  </Select></label>
  {pending&&<span className="settings-help">{t(current?'Current selection':'Saved model unavailable')} · {savedLabel}</span>}
 </div>;
}
function CodexRoutingConnections({raw,onChange}:{raw:string;onChange:(raw:string)=>void}){
 const config=codexRoutingConfig(raw);
 const labels=codexConnectionLabels(config.connections);
 const change=(connections:typeof config.connections)=>onChange(JSON.stringify({...config,connections}));
 function addConnection(gateway=false){
  const base=gateway?'local-gateway':'connection';let index=1,name=gateway?base:`${base}-${index}`;
  while(config.connections[name])name=`${base}-${++index}`;
  change({...config.connections,[name]:gateway?{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}:{billing:'subscription',home:''}});
 }
 return <details className="pi-routing-advanced"><summary>{t('Codex connections')}</summary>
  <p className="settings-help">{t('The native connection uses your existing Codex login and configuration. Add a local gateway as a separate connection to use both in one strategy.')}</p>
  {Object.entries(config.connections).map(([name,connection])=>{
   const native='native' in connection,gateway='gateway' in connection,kind=native?'native':gateway?'gateway':connection.billing;
   return <fieldset key={name} className="pi-routing-config"><legend>{labels.get(name)}</legend>
    <label><span>{t('Connection type')}</span><Select value={kind} onChange={event=>change({...config.connections,[name]:event.target.value==='native'?{billing:'subscription',native:true}:event.target.value==='gateway'?{billing:'paid',gateway:true,baseUrl:'http://127.0.0.1:3425'}:{billing:event.target.value as 'subscription'|'paid',home:native?'':connection.home??'',...event.target.value==='paid'?{baseUrl:'',apiKeyEnv:''}:{}}})}>
     <option value="native">{t('Native Codex login')}</option><option value="gateway">{t('Local gateway (Magpie or compatible)')}</option><option value="subscription">{t('Separate subscription connection')}</option><option value="paid">{t('Explicit paid Responses connection')}</option>
    </Select></label>
    {!native&&!gateway&&<label><span>CODEX_HOME</span><input value={connection.home} onChange={event=>change({...config.connections,[name]:{...connection,home:event.target.value}})}/></label>}
    {!native&&connection.billing==='paid'&&<>
     <label><span>{t(gateway?'Local gateway URL':'Responses endpoint')}</span><input value={connection.baseUrl??''} placeholder={gateway?'http://127.0.0.1:3425':undefined} onChange={event=>change({...config.connections,[name]:{...connection,baseUrl:event.target.value}})}/></label>
     <label><span>{t(gateway?'API key environment variable (optional)':'API key environment variable')}</span><input value={connection.apiKeyEnv??''} placeholder="YAM_PROVIDER_NAME_KEY" autoComplete="off" onChange={event=>change({...config.connections,[name]:{...connection,apiKeyEnv:event.target.value}})}/></label>
    </>}
    <button type="button" onClick={()=>change(Object.fromEntries(Object.entries(config.connections).filter(([key])=>key!==name)))}>{t('Remove connection')}</button>
   </fieldset>;
  })}
  <button type="button" onClick={()=>addConnection()}>{t('Add connection')}</button>
  <button type="button" onClick={()=>addConnection(true)}>{t('Add local gateway')}</button>
 </details>;
}
export function PiRoutingConfig({args,cwd,invoke,onChange,onValidity,onSaved,installedGateways=[],adapter='pi'}:{adapter?:'pi'|'codex';args:string;cwd:string;invoke:Invoke;onChange:(args:string)=>void;onValidity?:(state:{valid:boolean;scope:string})=>void;onSaved?:(args:string,raw:string)=>void;installedGateways?:string[]}){
 const defaultMagpieGateway='http://127.0.0.1:3425';
 const root=useRef<HTMLFieldSetElement>(null),version=useRef(0),[visible,setVisible]=useState(false),[models,setModels]=useState<PiModel[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[warning,setWarning]=useState<string|null>(null);
 let draft:PiDraft|null=null,parseError:string|null=null;try{draft=adapter==='codex'?codexRoutingDraft(args):parsePiDraft(args);}catch(e){parseError=String(e);}
 const [setupOpen,setSetupOpen]=useState(()=>!draft?.small&&!draft?.strong);
 let taskRules=null;try{taskRules=validateRules(draft?.rules?JSON.parse(draft.rules):draft?.medium?defaultTierRules:defaultRules);}catch{}
 const gateway=draft?.gateway??null,connections=adapter==='codex'&&draft?codexRoutingConfig(args).connections:null,scope=JSON.stringify([cwd,gateway,adapter,connections]);
 const [verified,setVerified]=useState('');
 const [setupModels,setSetupModels]=useState<PiModel[]>([]),[setupModel,setSetupModel]=useState(''),[setupStatus,setSetupStatus]=useState(''),[setupGateway,setSetupGateway]=useState<string|null>(null);
 const [setupScope,setSetupScope]=useState(''),scopeRef=useRef(scope);scopeRef.current=scope;
 const [setupStatusScope,setSetupStatusScope]=useState(scope);
 const [setupGatewayWarning,setSetupGatewayWarning]=useState(false);
 const [setupDefaultDirectory,setSetupDefaultDirectory]=useState(false);
 const [freshGateways,setFreshGateways]=useState<string[]|null>(null),gateways=freshGateways??installedGateways;
 const [classifierSlots,setClassifierSlots]=useState(2);
 const [executionGroupCount,setExecutionGroupCount]=useState(3);
 const visibleExecutionGroups=Math.max(executionGroupCount,...piExecutionTiers.map(tier=>1+(draft?.executionFallbacks?.[tier]?.length??0)));
 const classifierFallbacks=draft?.classifierFallbacks??[];
 const classifierSlotCount=Math.max(classifierSlots,classifierFallbacks.length);
 const scanned=setupScope===scope;
 const subscriptionOnly=piSubscriptionOnly(args);
 const roleModels=subscriptionOnly?piSubscriptionCatalog(models):adapter==='pi'&&gateway===null?models.filter(model=>piModelCatalogSource(model.key)!=='magpie-direct'):models;
 const setupSourceModels=(subscriptionOnly?piSubscriptionCatalog(setupModels):setupModels).filter(model=>!model.legacy_alias);
 const setupChoices=setupSourceModels.filter(model=>model.levels.includes('high'));
 const setupSelection=setupChoices.some(model=>model.key===setupModel)?setupModel:'';
 const configured=!!draft&&hasPiRoutingSelection(draft);
 const argsRef=useRef(args);argsRef.current=args;
 useEffect(()=>{if(!visible||onSaved)return;try{const restored=restorePiSetup(args,localStorage.getItem(piSetupStorageKey));if(restored)onChange(restored);}catch{}},[visible]);
 useEffect(()=>{const dialog=root.current?.closest('dialog');if(!dialog){setVisible(true);return;}const read=()=>setVisible(dialog.open);read();const observer=new MutationObserver(read);observer.observe(dialog,{attributes:true,attributeFilter:['open']});return()=>observer.disconnect();},[]);
 const invokeCatalog=(params:Record<string,unknown>)=>invoke<{models:PiModel[];preferred?:string|null;used_default_directory?:boolean;warning?:string|null;probe?:{ok:boolean}}>(adapter==='codex'?'codex_routing_catalog':'pi_routing_catalog',adapter==='codex'?{cwd,config:JSON.stringify(codexRoutingConfig(args)),probeModel:params.probeModel??null}:params);
 async function check(){const current=++version.current;setBusy(true);setError(null);setWarning(null);setVerified('');setSetupScope('');setSetupModel('');if(scanned)setSetupStatus('');try{const result=await invokeCatalog({cwd,gateway});if(current===version.current){setModels(result.models);setWarning(result.warning??null);setVerified(scope);}}catch(e){if(current===version.current)setError(String(e));}finally{if(current===version.current)setBusy(false);}}
 useEffect(()=>{setModels([]);setVerified('');setSetupScope('');if(!visible){version.current++;setBusy(false);return;}const scheduledVersion=version.current;const timer=setTimeout(()=>{if(version.current===scheduledVersion)void check();},300);return()=>{clearTimeout(timer);version.current++;};},[scope,visible]);
 useEffect(()=>{if(setupStatusScope!==scope)setSetupStatus('');},[scope]);
 const issue=parseError??(adapter==='codex'?validateCodexDraft(args||JSON.stringify(codexRoutingConfig(''))):draft?validatePiDraft(draft,undefined,args):null);
 const catalogIssue=verified===scope&&draft?(adapter==='codex'?validateCodexDraft(args,models):validatePiDraft(draft,models,args)):null;
 useEffect(()=>{onValidity?.({valid:!issue&&visible,scope:JSON.stringify([cwd,args])});},[issue,visible,args,cwd,onValidity]);
 function change(fields:Partial<PiDraft>){
  if(!draft)return;
  const next={...draft,...fields},primary=next.classifier||next.small,changedPrimary=primary!==(draft.classifier||draft.small);
  if(changedPrimary&&next.classifierFallbacks)next.classifierFallbacks=next.classifierFallbacks.filter(key=>key!==primary);
  if(changedPrimary||!next.classifierBilling&&fields.classifierFallbacks?.length&&!primary.startsWith('openai/')){
   next.classifierBilling=verified===scope?knownClassifierBilling(models.find(model=>model.key===primary)):undefined;
  }
  try{onChange(adapter==='codex'?buildCodexRoutingConfig(args,next):buildPiArgs(args,next));}catch(e){setError(String(e));}
 }
 async function discoverSetup(){
  if(busy)return;const current=++version.current;setBusy(true);setSetupStatus('');setSetupStatusScope(scope);setSetupModels([]);setSetupModel('');setSetupScope(scope);setSetupGatewayWarning(false);setSetupDefaultDirectory(false);
  try{
   const detected=adapter==='codex'?[]:await invoke<string[]>('list_local_gateways').catch(()=>null);
   if(current!==version.current||scopeRef.current!==scope)return;
   const installed=Array.isArray(detected)&&detected.every(id=>typeof id==='string')?detected:gateways;
   setFreshGateways(installed);
   const scanGateway=adapter==='codex'?null:gateway??(installed.includes('magpie')?defaultMagpieGateway:null);
   const result=await invokeCatalog({cwd,gateway:scanGateway});
   if(current!==version.current||scopeRef.current!==scope)return;
   const piModels=adapter==='codex'?result.models:result.models.filter(model=>piModelCatalogSource(model.key)!=='magpie-direct');
   const all=scanGateway===null?piModels:result.models;
   setModels(gateway===null?piModels:all);setVerified(scope);setError(null);setWarning(null);
   setSetupDefaultDirectory(result.used_default_directory===true);
   setSetupGatewayWarning(!!result.warning);setSetupGateway(scanGateway);setSetupModels(all);
   const eligible=subscriptionOnly?piSubscriptionCatalog(all):all;
   setSetupModel(selectPiSetupModel(eligible.filter(model=>!model.legacy_alias),result.preferred??''));
   if(!all.length)setSetupStatus(adapter==='codex'?'No Codex models found. Check the selected connection and official CLI login.':'No compatible model found. Configure Pi login or add a provider, then scan again.');
  }catch{if(current===version.current&&scopeRef.current===scope)setSetupStatus(adapter==='codex'?'Could not discover Codex models. Check the background version, connection and official CLI login.':'Could not discover Pi models. Check Pi installation and login, then scan again.');}
  finally{if(current===version.current)setBusy(false);}
 }
 async function verifySetup(){
  if(!draft||!setupSelection||busy||setupDefaultDirectory||!scanned)return;const current=++version.current,original=args;setBusy(true);setSetupStatus('');
  try{
   const probeArgs=adapter==='codex'?'':args,probe=adapter==='codex'?async <T,>(_name:string,params?:Record<string,unknown>)=>await invokeCatalog(params??{}) as T:invoke;
   if(configured){
    await probePiSetupModel(probeArgs,cwd,setupSelection,probe,setupGateway,adapter);
    if(current===version.current&&argsRef.current===original&&scopeRef.current===scope)setSetupStatus('Model verified. Your routing roles and reasoning are unchanged.');
    return;
   }
   const result=await verifyPiSetup(probeArgs,cwd,setupSelection,probe,setupGateway,adapter);
   if(current!==version.current||argsRef.current!==original||scopeRef.current!==scope)return;
   setSetupStatusScope(JSON.stringify([cwd,result.mapping.gateway,adapter,adapter==='codex'?codexRoutingConfig(args).connections:null]));
   const raw=JSON.stringify(result.mapping);
   if(!onSaved)try{localStorage.setItem(piSetupStorageKey,raw);}catch{setSetupStatus('Model verified, but this device could not save the routing defaults.');onChange(result.args);return;}
   let nextArgs=result.args,fixedGateway=false;
   if(adapter==='codex'){
    const setup=codexQuickSetupConfig(args,result.args,models);nextArgs=setup.args;fixedGateway=setup.fixedEffort;
   }
   onChange(nextArgs);setSetupStatus(fixedGateway?'Model verified. High reasoning is fixed because this model does not support every default reasoning level.':result.warning??(adapter==='codex'||result.mapping.medium?'Model verified. Routing uses three execution tiers; you can change their models below.':'Model verified. The same model is selected for all three roles; you can change them below.'));
  }catch(e){if(current===version.current&&argsRef.current===original&&scopeRef.current===scope)setSetupStatus(e instanceof Error&&['Invalid billing policy','Subscription-only billing requires a Codex subscription model.'].includes(e.message)?e.message:'Model verification failed. Check login, access and connection, or choose another model.');}
  finally{if(current===version.current)setBusy(false);}
 }
 function saveSetup(){
  if(!draft||busy||issue||adapter==='codex'&&(!!catalogIssue||verified!==scope))return;
  setSetupStatusScope(scope);
  try{const raw=adapter==='codex'?buildCodexRoutingConfig(args,draft):JSON.stringify(piSetupMapping(draft,args,models));if(onSaved)onSaved(args,raw);else localStorage.setItem(piSetupStorageKey,raw);setSetupStatus('Routing roles saved on this device.');}
  catch(e){setSetupStatus(e instanceof Error&&['Invalid billing policy','Subscription-only billing requires a Codex subscription model.'].includes(e.message)?e.message:'Could not save routing roles on this device.');}
 }
 function applySavedSetup(){
  setSetupStatusScope(scope);
  try{const restored=restorePiSetup(args,localStorage.getItem(piSetupStorageKey),true);if(!restored){setSetupStatus('Saved routing policy is unavailable or conflicts with the current billing policy.');return;}onChange(restored);setSetupStatus('Saved routing policy loaded. Check models and connection before starting.');}
  catch{setSetupStatus('Saved routing policy is unavailable or conflicts with the current billing policy.');}
 }
 return <fieldset className="pi-routing-config" ref={root}><legend>{t(adapter==='codex'?'Codex automatic routing':'Pi automatic routing')}</legend>
  <p className="settings-help">{t(adapter==='codex'?'Codex keeps its native terminal, history, approvals, Skills and tools. Routing chooses the model and reasoning for each new task.':'Pi keeps this chat history. ChatGPT subscription tasks use the official Codex CLI with its default native Skills and tools. Model and reasoning can be automatic or fixed independently.')}</p>
  <details className="pi-routing-advanced" open={setupOpen} onToggle={e=>setSetupOpen(e.currentTarget.open)}><summary>{t('Quick model setup')}</summary>
   <p className="settings-help">{t(adapter==='codex'?'Read the models available to the official Codex CLI. Verification sends a short request using the selected connection quota.':'Scan the providers available to Pi, the official Codex CLI, and the direct gateway when configured or detected. Verification sends a short test request and may use your selected connection quota.')}</p>
   <button type="button" disabled={busy} onClick={()=>void discoverSetup()}>{t('Find available models')}</button>
   {!onSaved&&<button type="button" disabled={busy} onClick={applySavedSetup}>{t('Use saved routing policy')}</button>}
   {scanned&&setupSourceModels.length>0&&<p className="settings-help">{setupChoices.length?t('Quick setup shows {{available}} of {{total}} models with high reasoning.',{available:setupChoices.length,total:setupSourceModels.length}):t('No discovered model supports high reasoning. Select compatible models or configure fixed reasoning below.')}</p>}
   {scanned&&setupChoices.length>0&&<><RoutingModelPicker label={t('Model to verify')} models={setupChoices} value={setupSelection} connections={connections} disabled={busy} onChange={e=>setSetupModel(e.target.value)} onBrowse={()=>setSetupModel('')}/><button type="button" disabled={busy||!setupSelection||setupDefaultDirectory} onClick={()=>void verifySetup()}>{t(configured?'Verify model':'Verify and initialize routing roles')}</button></>}
   {setupStatus&&setupStatusScope===scope&&(!onSaved||setupStatus!=='Routing roles saved on this device.')&&<p role="status">{t(setupStatus)}</p>}
   {setupScope===scope&&setupGatewayWarning&&(gateway!==null||gateways.includes('magpie'))&&<p className="settings-help" role="status">{t('Magpie gateway model catalog unavailable. Check the gateway; Pi native models remain available.')}</p>}
   {setupScope===scope&&setupDefaultDirectory&&<p className="settings-help" role="status">{t(adapter==='codex'?'The project directory is unavailable. Models were scanned using the local Codex configuration.':'The project directory is unavailable. Models were scanned using the local Pi configuration.')} {t('Choose an existing project directory to verify a model.')}</p>}
   {adapter==='pi'&&gateways.includes('cc-switch')&&<p className="settings-help">{t('CC Switch is installed. Enable a provider in its Pi tab, then scan again. Enabled models appear under Pi native.')}</p>}
   {adapter==='pi'&&gateways.includes('echobird')&&<p className="settings-help">{t('EchoBird is installed. Configure its provider in Pi, then scan again.')}</p>}
   {!onSaved&&draft?.small&&draft.strong&&<button type="button" disabled={busy||!!issue} onClick={saveSetup}>{t('Save routing roles on this device')}</button>}
   {adapter==='pi'&&setupStatusScope===scope&&((scanned&&setupSourceModels.length>0&&!setupChoices.length)||setupStatus==='No compatible model found. Configure Pi login or add a provider, then scan again.'||setupStatus==='Could not discover Pi models. Check Pi installation and login, then scan again.'||setupStatus==='Model verification failed. Check login, access and connection, or choose another model.')&&<div>
    <p className="settings-help">{t(gateways.includes('magpie')?'Magpie is installed. Configure a provider and start its local gateway, then scan again.':'Magpie can manage providers and expose models locally. Install and configure it, then return here and scan again.')}</p>
    <button type="button" onClick={()=>openUrl(gateways.includes('magpie')?'https://usemagpie.ai/docs/start':'https://usemagpie.ai/').catch(()=>setError('Could not open the link. Try again from the current terminal.'))}>{t(gateways.includes('magpie')?'Magpie setup guide':'Get Magpie')}</button>
    <p className="settings-help">{t('For ChatGPT subscriptions, sign in to the official Codex CLI with codex login. For other Pi providers, use pi /login or configure their credentials, then scan again.')}</p>
    <button type="button" onClick={()=>openUrl('https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md').catch(()=>setError('Could not open the link. Try again from the current terminal.'))}>{t('Pi provider setup guide')}</button>
   </div>}
  </details>
  {draft&&<>{adapter==='pi'&&<label><span>{t('Model connection')}</span><Select aria-label={t('Model connection')} value={gateway===null?'native':'gateway'} onChange={e=>change({gateway:e.target.value==='native'?null:defaultMagpieGateway})}><option value="native">{t('Pi connections')}</option><option value="gateway">{t('Pi with direct gateway')}</option></Select></label>}
   <p className="settings-help">{t('ChatGPT subscription tasks require the official Codex CLI login. Automatic setup detects routing tiers; you can override their models below. Classifier, preview and correction use their configured channels. Subscription failures never trigger a paid channel fallback.')}</p>
   {gateway!==null&&<label><span>{t('Gateway URL')}</span><input value={gateway} onChange={e=>change({gateway:e.target.value})} placeholder="http://127.0.0.1:3425" autoComplete="off" spellCheck={false}/></label>}
   <fieldset className="pi-routing-config"><legend>{t('Execution models')}</legend>
   <p className="settings-help">{t('Group A sets the primary model for each tier. Empty backup slots are skipped.')}</p>
   {Array.from({length:visibleExecutionGroups},(_,group)=>{
    const groupLabel=t('Execution group {{value0}}',{value0:String.fromCharCode(65+group)});
    return <fieldset key={group} className="pi-routing-config pi-execution-group" aria-label={groupLabel}>
     <legend>{groupLabel}</legend>
     {piExecutionTiers.map(role=>{
      const label=t(role==='small'?'Lightweight model':role==='medium'?'Standard model':'Strong model');
      const primary=draft[role]??'',backups=draft.executionFallbacks?.[role]??[];
      const value=group===0?primary:backups[group-1]??'';
      return <RoutingModelPicker key={role} label={group===0?label:`${groupLabel} · ${label}`} models={roleModels} value={value} connections={connections} emptyLabel={group===0?'Choose a model':'No execution backup'} disabled={group>0&&!primary} onChange={event=>{
       const selected=event.target.value;
       if(group===0){
        change({[role]:selected,executionFallbacks:{...draft.executionFallbacks,[role]:selected?backups.map(key=>key===selected?'':key):[]}});
       }else{
        const slots=Array.from({length:Math.max(backups.length,group)},(_,index)=>index===group-1?selected:backups[index]??'');
        change({executionFallbacks:{...draft.executionFallbacks,[role]:slots}});
       }
      }}/>;
     })}
    </fieldset>;
   })}
   {visibleExecutionGroups<=maxPiBackupModels&&<button type="button" onClick={()=>setExecutionGroupCount(visibleExecutionGroups+1)}>{t('Add execution group')}</button>}
   </fieldset>
   <fieldset className="pi-routing-config" aria-label={t('Classification models')}><legend>{t('Classification models')}</legend>
   <RoutingModelPicker label={t('Primary classifier A')} models={roleModels} value={draft.classifier} connections={connections} emptyLabel="Same as lightweight model" onChange={e=>change({classifier:e.target.value})}/>
   {Array.from({length:classifierSlotCount},(_,index)=>{
    const label=t('Backup classifier {{value0}}',{value0:String.fromCharCode(66+index)});
    return <RoutingModelPicker key={index} label={label} models={roleModels} value={classifierFallbacks[index]??''} connections={connections} emptyLabel="No backup classifier" disabled={index>classifierFallbacks.length} onChange={event=>{
     const next=[...classifierFallbacks];next[index]=event.target.value;change({classifierFallbacks:next.filter(Boolean)});
    }}/>;
   })}
   {classifierSlotCount<maxPiBackupModels&&<button type="button" disabled={classifierFallbacks.length<classifierSlotCount} onClick={()=>setClassifierSlots(classifierSlotCount+1)}>{t('Add classifier backup')}</button>}
   {adapter==='pi'&&!!draft.classifierFallbacks?.length&&<label><span>{t('Classifier billing channel')}</span>
    <Select aria-label={t('Classifier billing channel')} value={draft.classifierBilling??''} onChange={event=>change({classifierBilling:(event.target.value||undefined) as PiDraft['classifierBilling']})}>
     <option value="">{t('Detect from primary classifier')}</option><option value="subscription">{t('Subscription')}</option><option value="api">{t('Pi native API')}</option><option value="gateway">{t('Magpie gateway')}</option>
    </Select>
    <span className="settings-help">{t('When the primary classifier is missing from the catalog, choose its existing billing channel to enable backups.')}</span>
   </label>}
   <p className="settings-help">{t('If all configured classifiers fail, local routing rules are used.')}</p>
   </fieldset>
   {onSaved&&<><button type="button" disabled={busy||!!issue||adapter==='codex'&&(!!catalogIssue||verified!==scope)} onClick={saveSetup}>{t('Save routing roles on this device')}</button>
   {setupStatusScope===scope&&setupStatus==='Routing roles saved on this device.'&&<p role="status">{t(setupStatus)}</p>}</>}
   <details className="pi-routing-advanced"><summary>{t('Routing preferences')}</summary><div className="pi-routing-pair"><RoutingModelPicker label={t('Model selection')} models={roleModels} value={draft.model} connections={connections} emptyValue="auto" emptyLabel="Automatic by task" onChange={e=>change({model:e.target.value})}/><label><span>{t('Reasoning selection')}</span><Select aria-label={t('Reasoning selection')} value={draft.effort} onChange={e=>change({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label></div>
   <p className="settings-help">{t('A fixed reasoning level is preserved exactly. Unsupported selections stop with an explanation.')}</p></details>
   {taskRules?<PiTaskRules rules={taskRules} disabled={busy} onApply={rules=>change({rules:JSON.stringify(rules)})}/>:<button type="button" onClick={()=>change({rules:JSON.stringify(defaultRules)})}>{t('Restore default task rules')}</button>}
   <p className="settings-help">{t(adapter==='codex'?'Saved rules apply to new sessions. Select a saved strategy in the session to apply it at the next safe turn boundary.':'These defaults apply to new sessions. Existing sessions keep their saved task rules; use Adjust routing to edit and preview them.')}</p>
  </>}
  {warning&&<p className="settings-help" role="status">{t(warning)}</p>}
  <div className="pi-routing-check"><button type="button" disabled={busy||!!parseError} onClick={()=>void check()}>{busy?t('Checking models…'):t('Check connection and models')}</button><span role="status">{issue?t(issue):busy?t('Reading model capabilities…'):error?t(error):catalogIssue?t(catalogIssue):verified===scope?t('Routing configuration checked'):t('Check the connection and available models.')}</span></div>
 </fieldset>;
}
export function RoutingPolicyChoice({adapter,policies,choice,launchPolicy,invalid,onChange,onManage,codexAvailable=true}:{adapter:string;policies:RoutingPolicy[];choice:string;launchPolicy:boolean;invalid:boolean;onChange:(id:string)=>void;onManage:()=>void;codexAvailable?:boolean}){
 const supported=supportsDesktopRouting(adapter)&&(adapter!=='codex'||codexAvailable),available=supported?compatibleRoutingPolicies(policies,adapter):[],selected=available.find(row=>row.id===choice);
 const policy=selected?.adapter==='pi'?portablePiRoutingPolicy(selected.setup):null;
 return <div className="dialog-fields">
  <label><span>{t('Routing strategy')}</span><Select aria-label={t('Routing strategy')} value={choice} disabled={!supported} onChange={event=>onChange(event.target.value)}>
   <option value="">{t('Do not enable routing')}</option>
   {supported&&(launchPolicy||choice===launchRoutingPolicy)&&<option value={launchRoutingPolicy}>{t('Current launch policy')}</option>}
   {available.map(row=><option key={row.id} value={row.id}>{row.name==='Previous Pi policy'?t(row.name):row.name}</option>)}
   {supported&&choice&&choice!==launchRoutingPolicy&&!selected&&<option value={choice} disabled>{t('Saved strategy unavailable')}</option>}
  </Select></label>
  {!supported&&<p className="settings-help">{t('Automatic routing is not yet available for this CLI in the desktop app.')}</p>}
  {policy&&<p className="settings-help">{t('{{count}} classifier candidates · {{tiers}} execution tiers',{count:1+(policy.classifierFallbacks?.length??0),tiers:policy.medium?3:2})}</p>}
  {supported&&adapter==='codex'&&<p className="settings-help">{t(selected?'This strategy starts a YAM-managed Codex terminal.':'Save a Codex strategy in settings to use it here.')}</p>}
  {invalid&&<p role="alert">{t('Choose a valid routing strategy or disable routing.')}</p>}
  <button type="button" onClick={onManage}>{t('Manage routing strategies')}</button>
 </div>;
}

export function PiRoutingSettings({cwd,invoke,installedGateways,navigation,onClose,policies,loadError,onSave,initialAdapter='pi'}:{cwd:string;invoke:Invoke;installedGateways:string[];navigation:SettingsNavigationRenderer;onClose:()=>void;policies:RoutingPolicy[];loadError:string|null;onSave:(policy:RoutingPolicy)=>void;initialAdapter?:RoutingPolicy['adapter']}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [selected,setSelected]=useState(policies.find(row=>row.adapter===initialAdapter)?.id??'');
 const stored=policies.find(row=>row.id===selected);
 const [adapter,setAdapter]=useState(stored?.adapter??initialAdapter);
 const [name,setName]=useState(stored?.name??'');
 const saved=stored?.adapter==='codex'?stored.setup:restorePiSetup('',stored?.setup??null)??'';
 const [args,setArgs]=useState(saved);
 const [saveError,setSaveError]=useState('');
 const dirty=args!==saved||name!==(stored?.name??'');
 useEffect(()=>{dialog.current?.showModal();},[]);
 function edit(id:string){
  const next=policies.find(row=>row.id===id);
  if(next)setAdapter(next.adapter);
  setSelected(id);setName(next?.name??'');setArgs(next?.adapter==='codex'?next.setup:restorePiSetup('',next?.setup??null)??'');setSaveError('');
 }
 function save(_next:string,setup:string){
  try{
   const id=selected||crypto.randomUUID();
   onSave({id,name,adapter,setup});
   setSelected(id);setName(name.trim());setArgs(adapter==='codex'?setup:restorePiSetup('',setup)??'');setSaveError('');
  }catch(error){setSaveError(error instanceof Error?error.message:'Could not save routing strategy.');throw error;}
 }
 return <dialog ref={dialog} className="app-dialog settings-surface" aria-label={t('Automatic routing')} onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="dialog-header"><h2>{t('Automatic routing')}</h2></header>
  {navigation(dirty)}
  <div className="settings-page-body dialog-fields">
   {loadError?<p role="alert">{t(loadError)}</p>:<>
    <label><span>{t('Saved routing strategy')}</span><Select aria-label={t('Saved routing strategy')} value={selected} disabled={dirty} onChange={event=>edit(event.target.value)}>
     <option value="">{t('New routing strategy')}</option>
     {policies.map(row=><option key={row.id} value={row.id}>{row.adapter==='codex'?'Codex · ':''}{row.name==='Previous Pi policy'?t(row.name):row.name}</option>)}
    </Select></label>
    {!selected&&<label><span>{t('CLI')}</span><Select value={adapter} onChange={event=>{setAdapter(event.target.value as RoutingPolicy['adapter']);setArgs('');setSaveError('');}}><option value="pi">Pi</option><option value="codex">Codex</option></Select></label>}
    <label><span>{t('Strategy name')}</span><input aria-label={t('Strategy name')} value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label>
    {dirty&&<button type="button" onClick={()=>edit(selected)}>{t('Discard changes')}</button>}
    {saveError&&<p role="alert">{t(saveError)}</p>}
    {adapter==='codex'&&<CodexRoutingConnections raw={args} onChange={setArgs}/>}
    <PiRoutingConfig key={selected+adapter} adapter={adapter} args={args} cwd={cwd} invoke={invoke} installedGateways={installedGateways} onChange={setArgs} onSaved={save}/>
   </>}
  </div>
  <footer className="dialog-actions"><button type="button" onClick={onClose}>{t('Close')}</button></footer>
 </dialog>;
}
type LiveRoutingChange={policy:LiveRoutingPolicy|null;nativeModel?:string}|{cancel:true};
export function LiveRoutingControls({mode,policies,models,disabled,onSwitch}:{mode:PiSessionRoutingMode;policies:RoutingPolicy[];models:PiModel[];disabled:boolean;onSwitch:(request:LiveRoutingChange)=>void}){
 const [nativeModel,setNativeModel]=useState('');
 const current=mode.enabled?mode.policyId??'launch-config':'';
 const requested=mode.pendingPolicyId??current;
 const available=compatibleRoutingPolicies(policies,'pi');
 const explicitNative=models.filter(model=>!/^yam(?:-codex|-gateway)?\//.test(model.key));
 const named=available.some(row=>row.id===requested);
 function change(id:string){
  if(!id){onSwitch({policy:null,...(nativeModel?{nativeModel}:{})});return;}
  const policy=available.find(row=>row.id===id);
  if(policy)onSwitch({policy:routingPolicyPayload(policy)});
 }
 return <div className="pi-routing-controls">
  <label><span>{t('Session routing strategy')}</span><Select aria-label={t('Session routing strategy')} value={requested} onChange={event=>change(event.target.value)} disabled={disabled}>
   <option value="">{t('Do not enable routing')}</option>
   {requested&&!named&&<option value={requested} disabled>{mode.pending??mode.policyName??t('Current launch policy')}</option>}
   {available.map(row=><option key={row.id} value={row.id}>{row.name==='Previous Pi policy'?t(row.name):row.name}</option>)}
  </Select></label>
  {mode.enabled&&<p>{t('Active routing strategy: {{value0}}',{value0:t(mode.policyName??'Current launch policy')})}</p>}
  {mode.pending&&<><p role="status">{t('Routing change queued: {{value0}}',{value0:t(mode.pending)})}</p><button type="button" disabled={disabled} onClick={()=>onSwitch({cancel:true})}>{t('Cancel pending routing change')}</button></>}
  {mode.error&&<p role="alert">{t(mode.error)}</p>}
  {(mode.enabled||mode.error)&&!!explicitNative.length&&(!mode.nativeModel||!!mode.error)&&<label>
   <span>{t('Native model when routing is off')}</span><Select aria-label={t('Native model when routing is off')} disabled={disabled} value={nativeModel} onChange={event=>setNativeModel(event.target.value)}>
    <option value="">{t('Use current Pi defaults')}</option>
    {explicitNative.map(model=><option key={model.key} value={model.key}>{model.key}</option>)}
   </Select>
   {!mode.enabled&&nativeModel&&<button type="button" disabled={disabled} onClick={()=>change('')}>{t('Use native Pi model')}</button>}
  </label>}
 </div>;
}

export function PiRoutingBar({sessionId,generation,active,available,invoke,policies=[]}:{sessionId:string;generation:string;active:boolean;available:boolean;invoke:Invoke;policies?:RoutingPolicy[]}){
 const [state,setState]=useState<PiRoutingState|null>(null),[models,setModels]=useState<PiModel[]>([]);
 const [error,setError]=useState<string|null>(null),[readError,setReadError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [draft,setDraft]=useState<{model:string;effort:string;revision:number}|null>(null);
 const [expanded,setExpanded]=useState(false),[catalogError,setCatalogError]=useState<string|null>(null);
 const [recoveryOpen,setRecoveryOpen]=useState(false),[recoveryConfirmation,setRecoveryConfirmation]=useState<{receiptId:string;revision:number;generation:string}|null>(null),[recoveryMessage,setRecoveryMessage]=useState(false);
 const [controlFailure,setControlFailure]=useState<NativeFailure|null>(null),[stateRefreshed,setStateRefreshed]=useState(false);
 const mounted=useRef(true),serial=useRef(false),readEpoch=useRef(0),controlScope=useRef('');controlScope.current=JSON.stringify([sessionId,generation]);
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
  if(!state||!active||!available||!state.mode&&models.length)return;let stopped=false;
  void invoke<{models:PiModel[];controlFailure?:NativeFailure}>('pi_routing_control',{sessionId,generation,request:{action:'catalog',revision:state.revision}})
   .then(result=>{if(!stopped){if(result.controlFailure){setControlFailure(result.controlFailure);setStateRefreshed(false);return;}setModels(result.models??[]);setCatalogError(null);}})
   .catch(e=>{if(!stopped){setCatalogError(String(e));setControlFailure({category:'unknown',stage:'control',code:'control-result-unknown',dispatch:'unknown',nextAction:'refresh-state'});setStateRefreshed(false);}});
  return()=>{stopped=true;};
 },[!!state,active,available,sessionId,generation,invoke,state?.mode?.policyId,state?.mode?.enabled,state?.config.gateway]);
 useEffect(()=>{setRecoveryOpen(false);setRecoveryConfirmation(null);setRecoveryMessage(false);setControlFailure(null);setStateRefreshed(false);},[sessionId,generation]);
 async function refreshState(){
  if(serial.current)return;const scope=controlScope.current;serial.current=true;readEpoch.current++;setBusy(true);setStateRefreshed(false);
  try{
   const next=await invoke<PiSnapshot>('get_pi_routing',{sessionId});
   if(mounted.current&&scope===controlScope.current){
    if(next.state&&next.state.generation!==generation)throw Error('Pi runtime changed');
    setState(next.state);setReadError(null);setStateRefreshed(true);
   }
  }catch(e){if(mounted.current&&scope===controlScope.current)setReadError(String(e));}
  finally{readEpoch.current++;serial.current=false;if(mounted.current&&scope===controlScope.current)setBusy(false);}
 }
 async function control(action:string,data?:unknown,revision=state?.revision){
  if(!state||serial.current)return;const scope=controlScope.current;serial.current=true;readEpoch.current++;setBusy(true);setError(null);setControlFailure(null);setStateRefreshed(false);
  try{
   const result=await invoke<{state:PiRoutingState;controlFailure?:NativeFailure}>('pi_routing_control',{sessionId,generation,request:{action,revision,...(data?{data}:{})}});
   if(mounted.current&&scope===controlScope.current){
    if(result.controlFailure){setControlFailure(result.controlFailure);return null;}
    setReadError(null);setState(result.state);if(action==='set'||action==='reset'||action==='mode')setDraft(null);
    if(action==='native-reset'){setRecoveryConfirmation(null);setRecoveryMessage(true);}
    if(action==='retry'){
     const next=await invoke<{models:PiModel[];controlFailure?:NativeFailure}>('pi_routing_control',{sessionId,generation,request:{action:'catalog',revision:result.state.revision}});
     if(mounted.current&&scope===controlScope.current){if(next.controlFailure)setControlFailure(next.controlFailure);else{setModels(next.models??[]);setCatalogError(null);}}
    }
    return result.state;
   }
  }catch(e){if(mounted.current&&scope===controlScope.current){setError(String(e));setControlFailure({category:'unknown',stage:'control',code:'control-result-unknown',dispatch:'unknown',nextAction:'refresh-state'});}return null;}
  finally{readEpoch.current++;serial.current=false;if(mounted.current)setBusy(false);}
 }
 const routingOff=state?.mode?.enabled===false;
 const working=state&&['starting','classifying','selected','working'].includes(state.phase),disabled=!state||!active||!available||busy||!!working||!!controlFailure&&!stateRefreshed;
 const choice=draft??state?.preferences,dirty=!!(draft&&state&&(draft.model!==state.preferences.model||draft.effort!==state.preferences.effort));
 const subscriptionOnly=state?.diagnostics?.billing==='subscription';
 const roleModels=subscriptionOnly?piSubscriptionCatalog(models):models;
 const stale=!!(draft&&state&&draft.revision!==state.revision);
 const live=active&&available&&!readError;
 const execution=state?.diagnostics?.execution,recovery=state?.nativeRecovery;
 const failure=controlFailure??state?.failure??recovery?.failure;
 const failureReasons={auth:'Native login required',quota:'Native quota unavailable',context:'Context budget unavailable or exceeded',capability:'Required capability unavailable',connection:'Control connection unavailable',cancelled:'Task interrupted',execution:'Native execution failed',unknown:'Failure cause unconfirmed'};
 const budgetReasons:Record<string,string>={unavailable:'Model connection unavailable',billing:'Billing path incompatible',capability:'Required capability unavailable',effort:'Reasoning level unsupported','context-unknown':'Context window unknown','context-limit':'Context budget unavailable or exceeded','estimate-unavailable':'Context estimate unavailable','reserve-unavailable':'Context reserve unavailable'};
 const failureStages={discovery:'Checking native login…',preparation:'Preparing context…',dispatch:'Starting native CLI…',execution:'Native task running',verification:'Verifying native result',persistence:'Saving native receipt',control:'Applying routing control'};
 const failureActions={'check-login':'Check official Codex login with codex login, then refresh connection.','check-quota':'Check the current subscription quota in Codex. No paid channel will be selected.','reduce-context':'Explicitly compact or split the task before submitting new work.','check-capability':'Check the configured model, tools and native CLI capabilities before submitting new work.','refresh-state':'Refresh current state before deciding on another action. The previous action will not be resent.','inspect-task':'Inspect the native task, file changes and external actions before deciding what to do next. No task is resent.'};
 const recoveryStale=!!(recoveryConfirmation&&(recoveryConfirmation.revision!==state?.revision||recoveryConfirmation.generation!==generation||recoveryConfirmation.receiptId!==recovery?.receiptId));
 const recoveryReasons={'execution-failed':'Execution failed',cancelled:'Task interrupted','cleanup-unconfirmed':'Cleanup unconfirmed',unknown:'Execution outcome unknown'};
 const executionStages={discovering:'Checking native login…',preparing:'Preparing context…',starting:'Starting native CLI…',executing:'Native task running',completed:'Native task completed',failed:'Execution failed',aborted:'Task interrupted'};
 const handoffReasons={'verified-prefix':'Verified context prefix','prefix-unverified':'Context checkpoint unavailable or changed','new-task':'New task requested','identity-changed':'Native identity changed','new-session':'New native session'};
 const selected=live&&state?.phase==='selected'?state.target:null;
 function choose(fields:Partial<{model:string;effort:string}>){if(state&&choice)setDraft({...choice,revision:draft?.revision??state.revision,...fields});}
 return <section className="pi-routing-bar" aria-label={t('Pi automatic routing')}>
  <div className="pi-routing-status"><strong>{t('Pi routing')}</strong>{routingOff&&<span>{t('Routing is off')}</span>}{(!available||!state||!active||state.phase==='error'||state.phase==='classifying')&&<span role="status">{!available?t('Background unavailable'):!state?t(active?'Waiting for Pi routing state…':'Routing state unavailable'):!active?t('Session ended'):t(state.phase==='classifying'?'Choosing a model…':'Routing needs attention')}</span>}
   {state&&<span className="pi-routing-model" role="status" title={selected?t('Selected for this turn; waiting for a native model response'):t('Recorded by the native Pi assistant message')}>{selected?t('Selected for this turn: {{value0}} · {{value1}}',{value0:selected.model,value1:selected.effort}):state.actual?t(live&&state.phase==='working'?'Actual model: {{value0}} · {{value1}}':'Latest reply used: {{value0}} · {{value1}}',{value0:state.actual.model,value1:state.actual.effort==='unknown'?t('Reasoning not confirmed'):state.actual.effort}):t('No native model response recorded yet')}</span>}
   {state?.actual?.source&&<span>{t(state.actual.source==='chatgpt-subscription'?'ChatGPT subscription':state.actual.source==='magpie'?'Magpie gateway':state.actual.billing==='subscription'?'Pi native subscription':'Pi native API')}</span>}
   {execution&&<span role="status">{t(executionStages[execution.stage])}</span>}
   {state&&!routingOff&&<span className="pi-routing-policy">{state.preferences.model==='auto'?t('Automatic model'):t('Fixed model: {{value0}}',{value0:state.preferences.model})}</span>}
   {!routingOff&&<button type="button" aria-expanded={expanded} aria-controls={`pi-routing-controls-${sessionId}`} onClick={()=>setExpanded(value=>!value)}>{t('Adjust routing')}</button>}
   {recovery&&<button type="button" disabled={!active||!available||busy} aria-expanded={recoveryOpen} onClick={()=>{setRecoveryOpen(true);void control('native-recovery');}}>{t('View recovery information')}</button>}
   {!routingOff&&(error||readError||catalogError||state?.error||state?.gatewayError)&&<button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>}
  </div>
  {state?.mode&&<LiveRoutingControls mode={state.mode} policies={policies} models={models} disabled={!active||!available||busy||!!controlFailure&&!stateRefreshed} onSwitch={data=>void control('mode',data)}/>}
  {recoveryMessage&&<p role="status">{t('Task block cleared. Describe the next work explicitly; no task was resent.')}</p>}
  {failure&&<div className="settings-help" role="status">
   <p>{t(failureReasons[failure.category]??failureReasons.unknown)} · {t(failureStages[failure.stage]??failureStages.execution)}</p>
   <p>{t(failure.stage==='control'?(failure.dispatch==='not-started'?'Control request not sent':'Control result is unconfirmed. It may have been applied.'):(failure.dispatch==='not-started'?'Business task not dispatched':'Native work may have changed files or external state. Inspect before retrying.'))}</p>
   <p>{t(failureActions[failure.nextAction]??failureActions['inspect-task'])}</p>
   {controlFailure&&<><button type="button" disabled={!available||busy} onClick={()=>void refreshState()}>{t('Refresh current state')}</button>{stateRefreshed&&<p>{t('Current state refreshed. This does not confirm whether the previous action succeeded or failed.')}</p>}</>}
  </div>}
  {recoveryOpen&&recovery&&<div className="settings-help" aria-label={t('Native task recovery')}>
   <p role="status">{t(recovery.inProgress?'Native task running':recoveryReasons[recovery.reason])}</p>
   <p>{t('Inspect the old native task and its results before clearing the block. This does not undo actions or resend a task.')}</p>
   {recovery.receiptId?<p>{t('Native receipt')}: <code>{recovery.receiptId}</code></p>:<p>{t('This legacy task has no stable receipt identifier. Inspect it with /yam-native status, then use /yam-native reset in Pi after checking the old task.')}</p>}
   {recovery.sessionId?<><p>{t('Native Codex session')}: <code>{recovery.sessionId}</code></p><p>{t('Find this ID in Codex session history and read its saved transcript. Check file changes and external actions; stop the old task before clearing. Viewing does not require resuming or resending it.')}</p></>:<p>{t('Native session ID unavailable. Review the old terminal output, file changes and external actions before clearing; no native session has been inferred.')}</p>}
   <button type="button" disabled={disabled||!!readError||!recovery.needsInspection||!recovery.receiptId} onClick={()=>{if(state&&recovery.receiptId)setRecoveryConfirmation({receiptId:recovery.receiptId,revision:state.revision,generation});}}>{t('Clear task block…')}</button>
   {recoveryConfirmation&&<section aria-label={t('Confirm native recovery')}>
    <p>{t('Confirm that you stopped the old Codex task and checked files and external actions. Clearing does not undo actions or resend a task.')}</p>
    {recoveryStale&&<p role="status">{t('Native task changed. Cancel and inspect the current recovery information.')}</p>}
    <button type="button" disabled={busy} onClick={()=>setRecoveryConfirmation(null)}>{t('Cancel recovery')}</button>
    <button type="button" disabled={disabled||!!readError||recoveryStale||!recovery.needsInspection} onClick={()=>{if(!recoveryStale)void control('native-reset',{receiptId:recoveryConfirmation.receiptId,confirmed:true},recoveryConfirmation.revision);}}>{t('I checked the old task; clear the block')}</button>
   </section>}
  </div>}
  {state&&choice&&<><div id={`pi-routing-controls-${sessionId}`} className="pi-routing-controls" hidden={!expanded}>
   <RoutingModelPicker label={t('Pi model selection')} models={roleModels} value={choice.model} emptyValue="auto" emptyLabel="Automatic by task" disabled={disabled} onChange={e=>choose({model:e.target.value})}/>
   <label><span>{t('Reasoning')}</span><Select aria-label={t('Pi reasoning selection')} value={choice.effort} disabled={disabled} onChange={e=>choose({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label>
   <button type="button" disabled={disabled||!dirty||stale} onClick={()=>draft&&void control('set',{model:draft.model,effort:draft.effort},draft.revision)}>{t('Apply routing selection')}</button>
   {draft&&<button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('Cancel selection')}</button>}
   <button type="button" disabled={disabled||(!dirty&&state.preferences.model==='auto'&&state.preferences.effort==='auto')} onClick={()=>void control('reset')}>{t('Reset both to automatic')}</button>
   <button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>
   {state.rules&&<PiTaskRules rules={state.rules} disabled={disabled} onApply={async rules=>{if(!await control('rules',rules))throw Error(t('Control result is unconfirmed. It may have been applied.'));}} onPreview={async(text,rules)=>{const next=await control('preview',{text,rules}),p=next?.preview;if(!p)throw Error(t('Task rule preview failed'));return `${t('Matched task rule')}: ${t(p.rule)}\n${t(p.selection.model==='small'?'Lightweight model':p.selection.model==='medium'?'Standard model':'Strong model')} · ${p.selection.effort}\n${t('Classification time')}: ${p.latencyMs} ms\n${t('Model-reported cost')}: ${p.cost??t('Unknown cost')}\n${t('Policy preview only. Session locks, capacity and cache can change the final selection.')}`;}}/>}
   {state.decision&&<p className="settings-help">{t('Matched task rule')}: {t(state.decision.rule)} · {state.decision.ruleVersion}<br/>{state.decision.classificationSource&&<>{t('Classification source')}: {state.decision.classificationSource==='local'?t('Local routing rules'):state.decision.classificationSource} · </>}{t('Classification time')}: {state.decision.classificationMs} ms · {t('Model-reported cost so far')}: {state.decision.totalCost??t(state.actual?.billing==='subscription'?'Subscription usage; API cost unavailable':'Unknown cost')}</p>}
   {state.decision?.budget&&<p className="settings-help">{t('Local context estimate')}: {state.decision.budget.inputTokens??'—'} + {state.decision.budget.reserveTokens??'—'} {t('local reserve')} / {state.decision.budget.contextWindow??'—'} {t('context window')}<br/>{t('Local estimate only; native accumulated context is not measured.')}</p>}
   {!!state.decision?.rejected?.length&&<ul className="settings-help">{state.decision.rejected.map((item,index)=><li key={index}>{item.model}: {t(budgetReasons[item.reason]??'Context estimate unavailable')}</li>)}</ul>}
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
   <label><span>{t('Model')}</span><Select aria-label={`Rule model: ${rule.task}`} value={rule.model} onChange={e=>change(rule.task,{model:e.target.value as TaskRule['model']})}><option value="strong">{t('Strong model')}</option>{draft.rules.v===2&&<option value="medium">{t('Standard model')}</option>}{['transform','answer'].includes(rule.task)&&<option value="small">{t('Lightweight model')}</option>}</Select></label>
   <label><span>{t('Reasoning')}</span><Select aria-label={`Rule reasoning: ${rule.task}`} value={rule.effort} onChange={e=>change(rule.task,{effort:e.target.value as TaskRule['effort']})}>{(['transform','answer'].includes(rule.task)?['medium','high','xhigh','max']:['high','xhigh','max']).map(level=><option key={level} value={level}>{level}</option>)}</Select></label>
  </div>)}</fieldset>
  <label><span>{t('Fallback reasoning')}</span><Select aria-label="Fallback reasoning" disabled={disabled||busy} value={draft.rules.fallback.effort} onChange={e=>{setDraft(old=>({...old,rules:{...old.rules,fallback:{model:old.rules.fallback.model,effort:e.target.value as TaskRules['fallback']['effort']}}}));setResult('');}}>{['high','xhigh','max'].map(level=><option key={level} value={level}>{level}</option>)}</Select></label>
  <button type="button" disabled={disabled||busy||!dirty||stale||!!issue} onClick={apply}>{t('Apply task rules')}</button>
  <button type="button" disabled={disabled||busy} onClick={()=>{setDraft(old=>({...old,rules:validateRules(rules.v===2?defaultTierRules:defaultRules)}));setResult('');}}>{t('Restore default task rules')}</button>
  <button type="button" disabled={busy} onClick={()=>{setDraft({rules:validateRules(rules),base:saved});setResult('');setError('');}}>{t('Cancel rule changes')}</button>
  {stale&&dirty&&<p role="alert">{t('Task rules changed. Cancel edits and start from the current version.')}</p>}
  {onPreview&&<><label><span>{t('Preview request')}</span><textarea aria-label="Preview request" maxLength={4000} disabled={disabled||busy} value={text} onChange={e=>{setText(e.target.value);setResult('');}}/></label><p className="settings-help">{t('Preview classifies this text only. It does not execute or save the task. A classifier call may incur cost.')}</p><button type="button" disabled={disabled||busy||!!issue||!text.trim()} onClick={preview}>{t('Try task rules')}</button></>}
  {result&&<pre role="status">{result}</pre>}{(issue||error)&&<p role="alert">{issue||error}</p>}
 </details>;
}

type NativeCodexRoutingState={generation:string;revision:number;phase:string;enabled:boolean;name:string;policyId:string|null;pending?:{id:string|null;name:string}|null;target?:{model:string;effort:string}|null;dispatched?:{model:string;effort:string;rerouted?:boolean}|null;error?:string|null};
export function NativeCodexRoutingBar({sessionId,generation,active,available,invoke,policies=[]}:{sessionId:string;generation:string;active:boolean;available:boolean;invoke:Invoke;policies?:RoutingPolicy[]}){
 const [state,setState]=useState<NativeCodexRoutingState|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let stopped=false;let timer:ReturnType<typeof setTimeout>;
  async function read(){
   try{if(available){const result=await invoke<{state:NativeCodexRoutingState|null}>('get_pi_routing',{sessionId});if(!stopped){if(result.state&&result.state.generation!==generation)throw Error('Routing runtime changed');setState(result.state);setError(null);}}}
   catch(error){if(!stopped)setError(String(error));}
   finally{if(!stopped&&active&&available)timer=setTimeout(()=>void read(),1000);}
  }
  void read();return()=>{stopped=true;clearTimeout(timer);};
 },[sessionId,generation,active,available,invoke]);
 const choices=compatibleRoutingPolicies(policies,'codex'),current=state?.pending?(state.pending.id??''):state?.enabled?(state.policyId??'launch-config'):'';
 async function control(data:unknown){
  if(!state||busy)return;setBusy(true);setError(null);
  try{const result=await invoke<{state:NativeCodexRoutingState;controlFailure?:unknown}>('pi_routing_control',{sessionId,generation,request:{action:'mode',revision:state.revision,data}});if(result.controlFailure)throw Error('Routing result unknown; refresh state before retrying');setState(result.state);}
  catch(error){setError(String(error));}finally{setBusy(false);}
 }
 return <section className="pi-routing-bar" aria-label={t('Codex automatic routing')}>
  <div className="pi-routing-status"><strong>{t('Codex routing')}</strong>
   <span role="status">{t(!available?'Background unavailable':!active?'Session ended':!state?'Waiting for routing state…':!state.enabled?'Routing is off':state.phase==='classifying'?'Choosing a model…':'Native Codex session')}</span>
   {state?.dispatched?<span>{t('Dispatched model: {{value0}} · {{value1}}',{value0:state.dispatched.model,value1:state.dispatched.effort==='unknown'?t('Reasoning not confirmed'):state.dispatched.effort})}{state.dispatched.rerouted&&` · ${t('Changed by the model service')}`}</span>:state?.target&&<span>{t('Selected for this turn: {{value0}} · {{value1}}',{value0:state.target.model,value1:state.target.effort})}</span>}
  </div>
  <label><span>{t('Session routing strategy')}</span><Select aria-label={t('Session routing strategy')} value={current} disabled={!state||!active||!available||busy||!!error} onChange={event=>{const policy=choices.find(row=>row.id===event.target.value);return control({policy:policy?{id:policy.id,name:policy.name,config:policy.setup}:null});}}>
   <option value="">{t('Do not enable routing')}</option>
   {current&&!choices.some(row=>row.id===current)&&<option value={current} disabled>{state?.pending?.name??state?.name??t('Current launch policy')}</option>}
   {choices.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
  </Select></label>
  {state?.pending&&<p role="status">{t('Routing change queued: {{value0}}',{value0:state.pending.name})} <button type="button" disabled={busy||!active||!available} onClick={()=>void control({cancel:true})}>{t('Cancel pending routing change')}</button></p>}
  {(error||state?.error)&&<p role="alert">{t(error??state?.error??'')}</p>}
 </section>;
}
