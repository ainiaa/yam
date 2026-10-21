import type {SettingsNavigationRenderer} from "./SettingsNavigation";
import {t} from "./i18n";
// Author: Jeff.Liu. Checks and downloads may run during tasks; installation always needs explicit idle admission.
import {useEffect,useRef} from "react";
import {updaterBusy,type UpdaterSnapshot} from "./updater";
type Props={snapshot:UpdaterSnapshot|null;automatic:boolean;busy:boolean;error:string|null;onAutomatic:(value:boolean)=>void;onAction:(action:"check"|"download"|"cancel"|"install")=>void;onClose:()=>void;navigation?:SettingsNavigationRenderer};
const statusText:Record<string,string>={unconfigured:"Updates are not configured",unsupported:"Updates unavailable for this installation",idle:"Ready to check",checking:"Checking for updates…",upToDate:"YAM is up to date",available:"A new version is available",downloading:"Downloading and verifying…",cancelling:"Cancelling download…",verified:"Update ready to install",cancelled:"Download cancelled",error:"Could not complete the update",installing:"Installing update…",restarting:"Restarting YAM…"};
const reasonText:Record<string,string>={running_tasks:"Finish or stop all running sessions before installing. Your tasks can continue while the update waits.",owner_upgrade_required:"When all sessions are finished, use Stop all tasks and quit, then reopen YAM to upgrade its background service.",owner_unavailable:"The background service is unavailable. Reconnect or restart YAM, then try again.",manual_install_required:"This app location cannot be updated safely. Install the new version manually in Applications.",rollback_failed:"Automatic recovery failed. Do not restart. Restore YAM.app from the hidden .YAM-update-* backup folder beside the installed app.",manual_recovery_required:"Automatic recovery failed. Do not restart. Restore YAM.app from the hidden .YAM-update-* backup folder beside the installed app.",not_ready:"Download and verification must finish before installation.",configuration_invalid:"Update configuration is invalid.",platform_unsupported:"This installation does not support automatic updates.",updater_unavailable:"The update service is unavailable. Try again.",updater_operation_failed:"The update failed. Check your network and the published YAM release, then try again.",operation_failed:"The update could not be completed. Try again or install the release manually.",deadline_exceeded:"The update request timed out. Try again.",artifact_too_large:"The download exceeds the supported update size.",updater_preference_unavailable:"Could not save the automatic update preference.",updater_preference_invalid:"The automatic update preference is invalid. Automatic checks are off."};
export default function UpdaterSettings(props:Props) {
 const {snapshot,automatic,busy,error,onAutomatic,onAction,onClose,navigation}=props;
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 const operation=snapshot?updaterBusy(snapshot.state):false;
 const progress=snapshot?.progress,reason=error??snapshot?.reason;
 return <dialog ref={dialog} className={"app-dialog updater-settings"+(navigation?" settings-surface":"")} aria-label={t("Updates")} onCancel={event=>{event.preventDefault();onClose();}}>
  <header><h2>{t("YAM updates")}</h2></header>
  {navigation?.(false)}
  <div className="settings-page-body">
  <p className="muted">{t("Current version")+" "}{snapshot?.current_version??"…"}</p>
  <p className="update-status" role="status">{snapshot?t(statusText[snapshot.state]):t("Loading…")}</p>
  {!snapshot?.configured&&<p>{t("The update source is unavailable. Automatic checks and downloads are off for this installation.")}</p>}
  <label className="update-preference"><input type="checkbox" checked={automatic} disabled={busy||operation} onChange={event=>onAutomatic(event.target.checked)}/> {t("Automatically check and download updates")}</label>
  <p className="muted">{t("Checks at startup and every 6 hours. Installation always waits for your confirmation and an idle workspace.")}</p>
  {snapshot?.release&&<div className="update-release"><h3>{t("Version")+" "}{snapshot.release.version}</h3>{snapshot.release.published&&<p className="muted">{snapshot.release.published}</p>}{snapshot.release.notes&&<pre>{snapshot.release.notes}</pre>}</div>}
  {progress&&<div className="update-progress"><progress aria-label={t("Update download progress")} value={progress.total?progress.observed:undefined} max={progress.total??undefined}/><span>{(progress.observed/1024/1024).toFixed(1)} {t("MB")}{progress.total?" / "+(progress.total/1024/1024).toFixed(1)+" MB":t(" downloaded")}</span></div>}
  {snapshot?.state==="verified"&&<p>{snapshot.install_allowed?t("The signed download is verified. YAM will install it and restart when you choose below."):t(reasonText[snapshot.install_blocked_reason??"not_ready"])}</p>}
  {snapshot?.state==="installing"&&<p>{t("Installing the verified package. New sessions are temporarily paused.")}</p>}
  {reason&&<p role="alert">{t(reasonText[reason]??t("The update could not be completed. Please try again."))}</p>}
  </div>
  <div className="dialog-footer">
   <button type="button" disabled={!snapshot?.configured||busy||operation} onClick={()=>onAction("check")}>{t("Check for updates")}</button>
   {snapshot?.state==="available"&&<button type="button" disabled={busy} onClick={()=>onAction("download")}>{t("Download update")}</button>}
   {snapshot&&["checking","downloading","cancelling"].includes(snapshot.state)&&<button type="button" disabled={busy||snapshot.state==="cancelling"} onClick={()=>onAction("cancel")}>{t("Cancel")}</button>}
   {snapshot?.state==="verified"&&<button type="button" className="primary-button" disabled={busy||!snapshot.install_allowed} onClick={()=>onAction("install")}>{t("Install and restart")}</button>}
   <button type="button" onClick={onClose}>{t("Close")}</button>
  </div>
 </dialog>;
}
