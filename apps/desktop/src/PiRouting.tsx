// Author: Jeff.Liu. Pi remains the terminal and conversation owner.
import {useEffect,useRef,useState} from 'react';
import {Select} from './Select';
import {t} from './i18n';
import {buildPiArgs,parsePiDraft,piLevels,validatePiDraft,type PiDraft,type PiModel,type PiRoutingState,type PiSnapshot} from './pi-routing';
type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
function ModelOptions({models,value}:{models:PiModel[];value:string}){return <>{!models.some(m=>m.key===value)&&value&&<option value={value}>{value}</option>}{models.map(m=><option key={m.key} value={m.key}>{m.name} · {m.key.split('/')[0]}</option>)}</>;}
export function PiRoutingConfig({args,cwd,invoke,onChange,onValidity}:{args:string;cwd:string;invoke:Invoke;onChange:(args:string)=>void;onValidity:(state:{valid:boolean;scope:string})=>void}){
 const root=useRef<HTMLFieldSetElement>(null),version=useRef(0),[visible,setVisible]=useState(false),[models,setModels]=useState<PiModel[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 let draft:PiDraft|null=null,parseError:string|null=null;try{draft=parsePiDraft(args);}catch(e){parseError=String(e);}
 const gateway=draft?.gateway??null,scope=JSON.stringify([cwd,gateway]);
 const [verified,setVerified]=useState('');
 useEffect(()=>{const dialog=root.current?.closest('dialog');if(!dialog){setVisible(true);return;}const read=()=>setVisible(dialog.open);read();const observer=new MutationObserver(read);observer.observe(dialog,{attributes:true,attributeFilter:['open']});return()=>observer.disconnect();},[]);
 async function check(){const current=++version.current;setBusy(true);setError(null);setVerified('');try{const result=await invoke<{models:PiModel[]}>('pi_routing_catalog',{cwd,gateway});if(current===version.current){setModels(result.models);setVerified(scope);}}catch(e){if(current===version.current)setError(String(e));}finally{if(current===version.current)setBusy(false);}}
 useEffect(()=>{setModels([]);setVerified('');if(!visible){version.current++;setBusy(false);return;}const timer=setTimeout(()=>void check(),300);return()=>{clearTimeout(timer);version.current++;};},[scope,visible]);
 const issue=parseError??(verified===scope&&draft?validatePiDraft(draft,models):t('Check the connection and available Pi models.'));
 useEffect(()=>{onValidity({valid:!busy&&!issue&&visible,scope:JSON.stringify([cwd,args])});},[busy,issue,visible,args,cwd,onValidity]);
 function change(fields:Partial<PiDraft>){if(!draft)return;try{onChange(buildPiArgs(args,{...draft,...fields}));}catch(e){setError(String(e));}}
 return <fieldset className="pi-routing-config" ref={root}><legend>{t('Pi automatic routing')}</legend>
  <p className="settings-help">{t('Pi keeps the same native conversation and tools. Model and reasoning can be automatic or fixed independently.')}</p>
  {draft&&<><label><span>{t('Model connection')}</span><Select aria-label={t('Model connection')} value={gateway===null?'native':'gateway'} onChange={e=>change({gateway:e.target.value==='native'?null:'http://127.0.0.1:3425'})}><option value="native">{t('Existing Pi configuration')}</option><option value="gateway">{t('Magpie gateway')}</option></Select></label>
   {gateway!==null&&<label><span>{t('Gateway URL')}</span><input value={gateway} onChange={e=>change({gateway:e.target.value})} placeholder="http://127.0.0.1:3425" autoComplete="off" spellCheck={false}/></label>}
   <div className="pi-routing-pair">{(['small','strong'] as const).map(role=><label key={role}><span>{t(role==='small'?'Lightweight model':'Strong model')}</span><Select aria-label={t(role==='small'?'Lightweight model':'Strong model')} value={draft![role]} onChange={e=>change({[role]:e.target.value})}><option value="">{t('Choose a model')}</option><ModelOptions models={models} value={draft![role]}/></Select></label>)}</div>
   <details className="pi-routing-advanced"><summary>{t('Routing preferences')}</summary><div className="pi-routing-pair"><label><span>{t('Model selection')}</span><Select aria-label={t('Model selection')} value={draft.model} onChange={e=>change({model:e.target.value})}><option value="auto">{t('Automatic by task')}</option><ModelOptions models={models} value={draft.model==='auto'?'':draft.model}/></Select></label><label><span>{t('Reasoning selection')}</span><Select aria-label={t('Reasoning selection')} value={draft.effort} onChange={e=>change({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label></div><label><span>{t('Classifier model')}</span><Select aria-label={t('Classifier model')} value={draft.classifier} onChange={e=>change({classifier:e.target.value})}><option value="">{t('Same as lightweight model')}</option><ModelOptions models={models} value={draft.classifier}/></Select></label><p className="settings-help">{t('A fixed reasoning level is preserved exactly. Unsupported selections stop with an explanation.')}</p></details>
  </>}
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
   }
  }catch(e){if(mounted.current)setError(String(e));}
  finally{readEpoch.current++;serial.current=false;if(mounted.current)setBusy(false);}
 }
 const working=state&&['starting','classifying','selected','working'].includes(state.phase),disabled=!state||!active||!available||busy||!!working;
 const choice=draft??state?.preferences,dirty=!!(draft&&state&&(draft.model!==state.preferences.model||draft.effort!==state.preferences.effort));
 const stale=!!(draft&&state&&draft.revision!==state.revision);
 function choose(fields:Partial<{model:string;effort:string}>){if(state&&choice)setDraft({...choice,revision:draft?.revision??state.revision,...fields});}
 return <section className="pi-routing-bar" aria-label={t('Pi automatic routing')}>
  <div className="pi-routing-status"><strong>{t('Pi routing')}</strong>{(!available||!state||!active||state.phase==='error'||state.phase==='classifying')&&<span role="status">{!available?t('Background unavailable'):!state?t(active?'Waiting for Pi routing state…':'Routing state unavailable'):!active?t('Session ended'):t(state.phase==='classifying'?'Choosing a model…':'Routing needs attention')}</span>}
   {state&&<span className="pi-routing-policy">{state.preferences.model==='auto'?t('Automatic model'):t('Fixed model: {{value0}}',{value0:state.preferences.model})}</span>}
   <button type="button" aria-expanded={expanded} aria-controls={`pi-routing-controls-${sessionId}`} onClick={()=>setExpanded(value=>!value)}>{t('Adjust routing')}</button>
   {(error||readError||catalogError||state?.error)&&<button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>}
  </div>
  {state&&choice&&<><div id={`pi-routing-controls-${sessionId}`} className="pi-routing-controls" hidden={!expanded}>
   <label><span>{t('Model')}</span><Select aria-label={t('Pi model selection')} value={choice.model} disabled={disabled} onChange={e=>choose({model:e.target.value})}><option value="auto">{t('Automatic by task')}</option><ModelOptions models={models} value={choice.model==='auto'?'':choice.model}/></Select></label>
   <label><span>{t('Reasoning')}</span><Select aria-label={t('Pi reasoning selection')} value={choice.effort} disabled={disabled} onChange={e=>choose({effort:e.target.value})}><option value="auto">{t('Automatic by task')}</option>{['off','minimal',...piLevels].map(level=><option key={level} value={level}>{level==='off'?t('Reasoning off (fixed)'):level}</option>)}</Select></label>
   <button type="button" disabled={disabled||!dirty||stale} onClick={()=>draft&&void control('set',{model:draft.model,effort:draft.effort},draft.revision)}>{t('Apply routing selection')}</button>
   {draft&&<button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('Cancel selection')}</button>}
   <button type="button" disabled={disabled||(!dirty&&state.preferences.model==='auto'&&state.preferences.effort==='auto')} onClick={()=>void control('reset')}>{t('Reset both to automatic')}</button>
   <button type="button" disabled={disabled} onClick={()=>void control('retry')}>{busy?t('Applying…'):t('Refresh connection')}</button>
   <div className="pi-routing-details"><p>{state.preferences.effort==='auto'?t('Automatic reasoning'):t('Fixed reasoning: {{value0}}',{value0:state.preferences.effort})}</p><p>{state.config.gateway?t('Gateway: {{value0}}',{value0:state.config.gateway}):t('Existing Pi configuration')}</p>{state.target&&<p>{t('Selected for this turn: {{value0}} · {{value1}}',{value0:state.target.model,value1:state.target.effort})}<br/>{state.target.reason}</p>}{state.actual?<p title={t('Recorded by the native Pi assistant message')}>{t('Last actual: {{value0}} · {{value1}}',{value0:state.actual.model,value1:state.actual.effort==='unknown'?t('Reasoning not confirmed'):state.actual.effort})}</p>:<p>{t('No native model response recorded yet')}</p>}<p className="settings-help">{t('Refreshing never resends a task. Review the terminal before explicitly retrying work.')}</p></div>
  </div>
  {dirty&&<p className="settings-help" role="status">{stale?t('Routing changed. Cancel this selection and choose again from the current state.'):t('Selection is not applied. Apply model and reasoning together when ready.')}</p>}
  {state.pendingInput&&<p className="settings-help" role="status">{t('Unsent input is preserved in the Pi terminal.')}</p>}
  {(error||readError||catalogError||state.error)&&<p className="pi-routing-error" role="alert">{t(error??readError??catalogError??state.error!)}</p>}</>}
  {!state&&(error||readError)&&<p className="pi-routing-error" role="alert">{t(error??readError!)}</p>}
 </section>;
}
