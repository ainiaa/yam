// Author: Jeff.Liu. Explicit local export/import; no session launch or authentication changes.
import {useEffect,useRef,useState} from 'react';
import {t} from './i18n';
import type {SettingsNavigationRenderer} from './SettingsNavigation';
import {parsePreferencesBackup,type PreferencesBackup} from './preferences-backup';
import {startupTimings,timingPercentile} from './startup-timings';
type Props={navigation:SettingsNavigationRenderer;mac:boolean;onClose:()=>void;onExport:()=>Promise<boolean>;onImport:(backup:PreferencesBackup)=>Promise<void>;onDiagnostics:()=>void;diagnosticsStatus:string|null;diagnosticsBusy:boolean;onNotification:()=>void;notificationStatus:string|null;canNotify:boolean};
export default function DataSettings(props:Props){
 const dialog=useRef<HTMLDialogElement>(null),intent=useRef(0),mounted=useRef(false),working=useRef(false);
 const [pending,setPending]=useState<PreferencesBackup|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 const timings=startupTimings(performance.getEntriesByType('measure'));
 useEffect(()=>{mounted.current=true;dialog.current?.showModal();return()=>{mounted.current=false;intent.current++;};},[]);
 async function choose(file:File|undefined){
  const version=++intent.current;setPending(null);setMessage(null);if(!file)return;
  try{if(file.size>1048576)throw Error();const backup=parsePreferencesBackup(await file.text(),props.mac);if(mounted.current&&version===intent.current)setPending(backup);}
  catch{if(mounted.current&&version===intent.current)setMessage('Invalid preference backup. Nothing was changed.');}
 }
 async function run(action:()=>Promise<unknown>,success:string){if(working.current)return;working.current=true;setBusy(true);setMessage(null);try{const result=await action();if(mounted.current){setMessage(result===false?'Export cancelled.':success);setPending(null);}}catch(reason){if(mounted.current)setMessage(reason instanceof Error&&['Import failed and rollback was incomplete. Keep the backup and review settings.','Import failed. Previous preferences were restored.'].includes(reason.message)?reason.message:'Could not complete the preference operation. Review settings and keep your backup.');}finally{working.current=false;if(mounted.current)setBusy(false);}}
 return <dialog ref={dialog} className="app-dialog settings-surface data-settings" aria-label={t('Data and diagnostics')} onCancel={event=>{event.preventDefault();if(!busy)props.onClose();}}>
  <header className="dialog-header"><h2>{t('Data and diagnostics')}</h2></header>{props.navigation(!!pending||busy)}
  <div className="settings-page-body">
   <section><h3>{t('Preference backup')}</h3><p>{t('Back up appearance, terminal defaults, shortcuts and connection references. Credentials, conversations, layouts and background images are excluded.')}</p>
    <button type="button" disabled={busy} onClick={()=>void run(props.onExport,'Preferences exported.')}>{t('Export preferences')}</button>
    <label>{t('Import preference backup')}<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{void choose(event.target.files?.[0]);event.target.value='';}}/></label>
    {pending&&<div role="status"><p>{t('Review import')}: {Object.keys(pending.settings).length} {t('settings')} · {pending.connections.length} {t('saved connections')}</p><p>{t('Existing task processes and conversation history will remain unchanged.')}</p><button type="button" disabled={busy} onClick={()=>void run(()=>props.onImport(pending),'Preferences imported. Terminal defaults apply to new views.')}>{t('Confirm import')}</button><button type="button" disabled={busy} onClick={()=>{intent.current++;setPending(null);}}>{t('Cancel')}</button></div>}
   </section>
   <section><h3>{t('Diagnostics')}</h3><p>{t('Save version, connection and aggregate counts; excludes session content and paths')}</p><button type="button" disabled={props.diagnosticsBusy||busy} onClick={props.onDiagnostics}>{t('Export diagnostics')}</button>{props.diagnosticsStatus&&<p role="status">{t(props.diagnosticsStatus)}</p>}</section>
   <section><h3>{t('Startup observations')}</h3><p>{t('Creation and view attachment include local dispatch overhead. They do not measure native CLI permission waits or prove that input is ready.')}</p><table><thead><tr><th>{t('Stage')}</th><th>{t('Samples')}</th><th>P50 ms</th><th>P95 ms</th></tr></thead><tbody>{([['Create session',timings.create_ms],['Attach terminal view',timings.view_ready_ms]] as const).map(([label,samples])=><tr key={label}><td>{t(label)}</td><td>{samples.length}</td><td>{timingPercentile(samples,.5)??'—'}</td><td>{timingPercentile(samples,.95)??'—'}</td></tr>)}</tbody></table></section>
   <section><h3>{t('Notifications')}</h3><p>{t('If a test reaches Notification Center but no banner appears, check system notification style, Focus, and notification permission while screen sharing. YAM does not change these system settings.')}</p><button type="button" disabled={!props.canNotify||busy} onClick={props.onNotification}>{t('Send test notification')}</button>{!props.canNotify&&<p>{t('Select a session to test notification navigation.')}</p>}{props.notificationStatus&&<p role="status">{t(props.notificationStatus)}</p>}</section>
   {message&&<p role="status">{t(message)}</p>}
  </div><footer className="dialog-footer"><button type="button" disabled={busy} onClick={props.onClose}>{t('Close')}</button></footer>
 </dialog>;
}
