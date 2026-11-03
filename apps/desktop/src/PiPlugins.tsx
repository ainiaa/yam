// Author: Jeff.Liu. Browse npm Pi packages; Pi CLI remains the package manager.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Package,Search,RefreshCw,ExternalLink,Check,ChevronDown} from 'lucide-react';
import {t} from './i18n';
import {parsePiPackageState,parsePiPackageSearch,type PiPackageState,type PiMarketPackage} from './pi-plugins';
import type {SettingsNavigationRenderer} from './SettingsNavigation';
type Invoke=<T=unknown>(command:string,args?:Record<string,unknown>)=>Promise<T>;
type Pending={action:'install'|'remove';source:string;name:string;revision:string};
export function PiPlugins({invoke,navigation,onClose,onBusyChange,onOpenCatalog}:{invoke:Invoke;navigation:SettingsNavigationRenderer;onClose:()=>void;onBusyChange:(busy:boolean)=>void;onOpenCatalog:()=>Promise<unknown>}){
 const dialog=useRef<HTMLDialogElement>(null),mounted=useRef(false),working=useRef(false),readEpoch=useRef(0),searchEpoch=useRef(0),cancel=useRef<HTMLButtonElement>(null),searchInput=useRef<HTMLInputElement>(null),previousPending=useRef(false);
 const installedTab=useRef<HTMLButtonElement>(null);
 const [state,setState]=useState<PiPackageState|null>(null),[results,setResults]=useState<PiMarketPackage[]>([]),[query,setQuery]=useState(''),[tab,setTab]=useState<'discover'|'installed'>('discover');
 const [pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[searching,setSearching]=useState(false);
 const [error,setError]=useState<string|null>(null),[loadError,setLoadError]=useState<string|null>(null),[searchError,setSearchError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 async function refresh(){
  const epoch=++readEpoch.current;setReading(true);setLoadError(null);
  try{const result=parsePiPackageState(await invoke('pi_packages',{request:{action:'list'}}));if(mounted.current&&readEpoch.current===epoch)setState(result);}
  catch(e){if(mounted.current&&readEpoch.current===epoch){setState(null);setLoadError(String(e));}}
  finally{if(mounted.current&&readEpoch.current===epoch)setReading(false);}
 }
 async function search(text:string){
  const epoch=++searchEpoch.current;setSearching(true);setSearchError(null);setResults([]);
  try{const result=parsePiPackageSearch(await invoke('pi_packages',{request:{action:'search',query:text.trim()}}));if(mounted.current&&searchEpoch.current===epoch)setResults(result.packages);}
  catch(e){if(mounted.current&&searchEpoch.current===epoch)setSearchError(String(e));}
  finally{if(mounted.current&&searchEpoch.current===epoch)setSearching(false);}
 }
 useEffect(()=>{mounted.current=true;dialog.current?.showModal();void refresh();void search('');return()=>{mounted.current=false;readEpoch.current++;searchEpoch.current++;};},[]);
 useEffect(()=>{if(pending)cancel.current?.focus();else if(previousPending.current)(tab==='installed'?installedTab:searchInput).current?.focus();previousPending.current=!!pending;},[pending]);
 function choose(action:Pending['action'],source:string,name:string){if(!working.current&&state&&!reading&&!loadError)setPending({action,source,name,revision:state.revision});}
 async function confirm(){
  if(working.current||!pending||!state)return;const request=pending;working.current=true;readEpoch.current++;setBusy(true);onBusyChange(true);setError(null);setMessage(null);
  try{const next=parsePiPackageState(await invoke('pi_packages',{request:{action:request.action,source:request.source,revision:request.revision}}));if(mounted.current){setState(next);setMessage(request.action==='install'?'Pi package installed. Open a new or continued Pi session to use it.':'Pi package removed. Open a new or continued Pi session to apply the change.');}}
  catch(e){if(mounted.current)setError(String(e));}
  finally{await refresh();working.current=false;if(mounted.current){setBusy(false);setPending(null);}onBusyChange(false);}
 }
 function close(){if(working.current)return;if(pending)setPending(null);else onClose();}
 async function openCatalog(){try{await onOpenCatalog();}catch{if(mounted.current)setError('Could not open the Pi package catalog.');}}
 const canInstall=!!state?.pi_available&&!reading&&!loadError&&!busy;
 const installedCount=state?state.packages.length+state.other_count:null;
 const packageCard=(p:{name:string;source?:string;description?:string;version?:string},action:ReactNode,key=p.source??p.name)=><article className="pi-package-card" key={key}>
  <div className="pi-package-card-header"><span className="pi-package-icon" aria-hidden="true"><Package/></span><h3 title={p.name}>{p.name}</h3>{action}</div>
  {p.description!==undefined&&<p className="pi-package-description">{p.description||t('No description provided.')}</p>}
  {p.source?<details className="pi-package-details"><summary aria-label={t('Details for {{name}}',{name:p.name})}><span className="pi-package-meta">npm{p.version&&<span>v{p.version}</span>}</span><span>{t('Package details')}<ChevronDown aria-hidden="true"/></span></summary><div className="pi-package-details-body">{p.description&&<p>{p.description}</p>}<code>{p.source}</code></div></details>:<p className="pi-package-managed">{t('Managed through Pi CLI')}</p>}
 </article>;
 return <dialog ref={dialog} className="app-dialog settings-surface pi-plugins-dialog" aria-label={t('Pi plugins')} onCancel={e=>{e.preventDefault();close();}}>
  <header className="dialog-header"><h2>{t('Pi plugins')}</h2></header>{navigation(busy||!!pending)}
  <div className="settings-page-body">
   {pending?<section className="pi-package-confirmation" aria-label={t(pending.action==='install'?'Confirm installation':'Confirm removal')}>
    <h3>{t(pending.action==='install'?'Install {{name}}?':'Remove {{name}}?',{name:pending.name})}</h3><p><code>{pending.source}</code></p>
    <p>{t('Uses your personal Pi configuration, shared with other local Pi sessions.')}</p>
    <p>{t(pending.action==='install'?'Pi packages can run code on this Mac, including dependency installation scripts. Install only sources you trust.':'Pi removes the package from personal configuration. Your YAM conversation history is preserved.')}</p>
    <p className="settings-help">{t('Changes apply to new or continued Pi sessions. Running sessions are not restarted.')}</p>
    <div className="dialog-actions"><button ref={cancel} type="button" disabled={busy} onClick={()=>{if(!working.current)setPending(null);}}>{t('Cancel')}</button><button type="button" className={pending.action==='remove'?'pi-package-remove-confirm':'primary-button'} disabled={busy} onClick={()=>void confirm()}>{busy?t('Working…'):t(pending.action==='install'?'Confirm installation':'Confirm removal')}</button></div>
   </section>:<>
    <div className="pi-package-toolbar"><div className="pi-package-nav"><div className="pi-package-tabs" role="group" aria-label={t('Plugin lists')}><button type="button" aria-pressed={tab==='discover'} onClick={()=>setTab('discover')}>{t('Discover plugins')}</button><button ref={installedTab} type="button" aria-pressed={tab==='installed'} onClick={()=>setTab('installed')}>{t('Installed')}{installedCount!==null&&<span className="pi-package-count">{installedCount}</span>}</button></div><button type="button" className="pi-package-refresh" aria-label={t('Refresh')} title={t('Refresh')} disabled={reading||busy} onClick={()=>void refresh()}><RefreshCw aria-hidden="true"/></button></div>
     {tab==='discover'&&<form className="pi-package-search" onSubmit={e=>{e.preventDefault();if(!busy)void search(query);}}><input ref={searchInput} type="search" aria-label={t('Search Pi plugins')} placeholder={t('Search by name or purpose')} maxLength={200} value={query} onChange={e=>setQuery(e.target.value)}/><button type="submit" disabled={searching||busy}><Search aria-hidden="true"/>{searching?t('Searching…'):t('Search')}</button></form>}
    </div>
    <div className="pi-package-caption"><p className="settings-help">{t('Extensions, skills, prompts and themes for Pi.')}</p><button type="button" onClick={()=>void openCatalog()}>{t('Official Pi catalog')}<ExternalLink aria-hidden="true"/></button></div>
    {state&&!state.pi_available&&<p role="alert">{t('Pi executable unavailable')}</p>}
    {tab==='discover'?<>
     {searchError&&<p role="alert">{t(searchError)}</p>}
     {(searching||!searchError&&!results.length)&&<div className="pi-package-empty" role="status"><Package aria-hidden="true"/><p>{t(searching?'Searching…':'No matching Pi packages.')}</p></div>}
     <div className="pi-package-list" aria-busy={searching}>{results.map(p=>{const installed=state?.configured_names.includes(p.name);return packageCard(p,<button className="pi-package-install" data-installed={!!installed} type="button" disabled={!canInstall||installed} onClick={()=>choose('install',p.source,p.name)}>{installed&&<Check aria-hidden="true"/>}{t(installed?'Already installed':'Install')}</button>);})}</div>
    </>:<>
     {reading&&<p role="status">{t('Loading…')}</p>}
     {!reading&&state&&!state.packages.length&&!state.other_count&&<div className="pi-package-empty" role="status"><Package aria-hidden="true"/><p>{t('No npm Pi packages configured.')}</p></div>}
     <div className="pi-package-list" aria-busy={reading}>{state?.packages.map((p,i)=>packageCard({...p,version:p.source.slice(`npm:${p.name}`.length).replace(/^@/,'')},<button type="button" className="pi-package-remove" disabled={busy||reading||!state.pi_available||!!loadError} onClick={()=>choose('remove',p.source,p.name)}>{t('Remove')}</button>,`${p.source}:${i}`))}{state?.configured_names.filter(name=>!state.packages.some(p=>p.name===name)).map(name=>packageCard({name},null))}</div>
     {!!state?.other_count&&<p className="settings-help pi-package-cli-note">{t('{{count}} package references are managed through Pi CLI.',{count:state.other_count})}</p>}
    </>}
   </>}
   {loadError&&<p role="alert">{t(loadError)}</p>}{error&&<p role="alert">{t(error)}</p>}{message&&<p role="status">{t(message)}</p>}
  </div><footer className="dialog-footer"><button type="button" disabled={busy} onClick={close}>{t('Close')}</button></footer>
 </dialog>;
}
