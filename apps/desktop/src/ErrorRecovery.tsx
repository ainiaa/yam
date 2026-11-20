// Author: Jeff.Liu. Guidance never retries a task; actions reuse guarded existing entrypoints.
import {t} from './i18n';
type Props={message:string;busy?:boolean;onReviewLaunch?:()=>void;onReconnect?:()=>void;onDiagnostics:()=>void};
export function ErrorRecovery({message,busy=false,onReviewLaunch,onReconnect,onDiagnostics}:Props){
 const reason=message.replace(/^Error: /,'');
 const header=reason.split(':',1)[0];
 const kind=/^Working directory|^Directory unavailable|^The project directory is unavailable\./i.test(reason)?'directory'
  :/^Cannot save final terminal frame|^Final saving|^Session.*sav(e|ing).*fail/i.test(reason)?'save'
  :/background connection|background.*unavailable|owner.*unavailable/i.test(header)?'background'
  :/credentials?|authentication|API key|api_key_env/i.test(header)?'credentials'
  :/network|timed out|ECONNREFUSED|Cannot download Node/i.test(header)?'network':'unknown';
 const advice={background:'Reconnect the existing background to check its state. Tasks are not restarted.',directory:'Choose an existing project directory and review the launch draft before starting again.',credentials:'Review the selected connection and credential source. Sign in with the native CLI if needed; do not paste credentials into the error report.',save:'Keep the affected session open. Check disk space and folder access, then retry from that session’s saving notice. Do not restart the task.',network:'Check the network and endpoint, then explicitly retry the original operation. Running tasks are unchanged.',unknown:'Review the technical details or export diagnostics before retrying. Do not repeat a task whose result is uncertain.'}[kind];
 return <div className="error-recovery"><p>{t(advice)}</p><details><summary>{t('Technical details')}</summary><pre>{message}</pre></details><div className="error-recovery-actions">
  {(kind==='directory'||kind==='credentials')&&onReviewLaunch&&<button type="button" disabled={busy} onClick={onReviewLaunch}>{t('Review launch draft')}</button>}
  {kind==='background'&&onReconnect&&<button type="button" disabled={busy} onClick={onReconnect}>{t('Reconnect background')}</button>}
  <button type="button" disabled={busy} onClick={onDiagnostics}>{t('Export diagnostics')}</button>
 </div></div>;
}
