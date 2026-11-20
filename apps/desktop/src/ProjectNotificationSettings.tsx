// Author: Jeff.Liu. The background owner persists project notification policy.
import {useEffect,useRef,useState} from 'react';
import {Select} from './Select';
import {t} from './i18n';
type Policy='all'|'important'|'muted';
type Snapshot={project:string;policy:Policy;revision:number};
function ProjectNotificationSettings({project,invoke}:{project:string|null;invoke:<T=unknown>(name:string,args?:Record<string,unknown>)=>Promise<T>}){
 const identity=useRef({project,version:0,mounted:true,pending:false});
 if(identity.current.project!==project)identity.current={project,version:identity.current.version+1,mounted:true,pending:false};
 const token=identity.current;
 const [state,setState]=useState<{token:typeof token;value:Snapshot|null;busy:boolean;error:string|null}>({token,value:null,busy:false,error:null});
 const current=state.token===token?state:{token,value:null,busy:false,error:null};
 const valid=()=>identity.current===token&&token.mounted;
 function snapshot(value:Snapshot){if(!value||typeof value.project!=='string'||!['all','important','muted'].includes(value.policy)||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('Invalid project policy');return value;}
 async function load(){if(!project||token.pending)return;token.pending=true;setState({token,value:null,busy:true,error:null});try{const value=snapshot(await invoke<Snapshot>('project_notification_policy',{request:{action:'get',project}}));if(valid())setState({token,value,busy:false,error:null});}catch{if(valid())setState({token,value:null,busy:false,error:'Project notification settings are unavailable. Reload before changing them.'});}finally{token.pending=false;}}
 useEffect(()=>{token.mounted=true;void load();const focus=()=>void load();window.addEventListener('focus',focus);return()=>{token.mounted=false;window.removeEventListener('focus',focus);};},[project]);
 async function change(value:string){if(!current.value||token.pending||!project||!['all','important','muted'].includes(value))return;token.pending=true;setState({...current,busy:true,error:null});try{const saved=snapshot(await invoke<Snapshot>('project_notification_policy',{request:{action:'set',project,policy:value,expected_revision:current.value.revision}}));if(valid())setState({token,value:saved,busy:false,error:null});}catch{if(valid())setState({token,value:null,busy:false,error:'Project notification settings changed or could not be saved. Reload and choose again.'});}finally{token.pending=false;}}
 return <div className="project-notification-settings"><h4>{t('Project notification policy')}</h4><p>{project??t('Select a project to change its notification policy.')}</p><label>{t('Notifications for this project')}<Select aria-label={t('Notifications for this project')} disabled={!project||!current.value||current.busy} value={current.value?.policy??'loading'} onChange={event=>change(event.target.value)}><option value="loading" disabled>{t('Not loaded')}</option><option value="all">{t('All notifications')}</option><option value="important">{t('Permission requests and failures only')}</option><option value="muted">{t('Mute project notifications')}</option></Select></label><button type="button" disabled={!project||current.busy} onClick={load}>{t('Reload project policy')}</button><p>{t('Saved immediately by the background owner. Inbox records and unread counts are preserved. Global notification pause still applies. Test notifications bypass project policy.')}</p>{current.error&&<p role="alert">{t(current.error)}</p>}</div>;
}
export {ProjectNotificationSettings};
