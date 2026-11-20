// Author: Jeff.Liu. Report local facts without starting a process or resolving credentials.
import {useRef,useState} from 'react';
import {t} from './i18n';
import {isProviderConfig,type ProviderConfig} from './provider-config';
function LaunchPreflight({adapter,cwd,provider,invoke}:{adapter?:{id:string;label:string;available:boolean;executable?:string|null};cwd:string;provider?:ProviderConfig|null;invoke:<T=unknown>(name:string,args?:Record<string,unknown>)=>Promise<T>}){
 const pending=useRef(false);
 const [directory,setDirectory]=useState<{path:string;ok:boolean}|null>(null),[checking,setChecking]=useState(false);
 async function check(){
  if(pending.current)return;pending.current=true;setChecking(true);const path=cwd.trim();
  try{await invoke('validate_project_directory',{path});setDirectory({path,ok:true});}
  catch{setDirectory({path,ok:false});}
  finally{pending.current=false;setChecking(false);}
 }
 return <details className="launch-preflight"><summary>{t('Startup checks')}</summary>
  <p role="status">{adapter?.available||adapter?.id==='shell'?t('Program detected'):t('Program not detected. Install it or explicitly choose another program.')}{adapter?.available&&adapter.executable&&<> · <code>{adapter.executable}</code></>}</p>
  <button type="button" disabled={checking||!cwd.trim()} onClick={check}>{t(checking?'Checking…':'Check directory')}</button>
  {directory?.path===cwd.trim()&&<p role="status">{t(directory.ok?'Directory exists.':'Directory unavailable. Choose an existing absolute directory.')}</p>}
  <p>{t(!provider?'Using existing CLI credentials; authentication is not verified.':isProviderConfig(provider)?'Connection reference format is valid. Credential availability is checked by the background owner when starting; authentication is not verified.':'Invalid connection reference. Review the connection settings.')}</p>
 </details>;
}

export {LaunchPreflight};
