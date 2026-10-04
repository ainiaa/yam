// Author: Jeff.Liu. Finite updater UI; installation is deliberately unavailable.
import {updaterBusy,type UpdaterSnapshot} from "./updater";
type Props={snapshot:UpdaterSnapshot|null;automatic:boolean;busy:boolean;error:string|null;onAutomatic:(value:boolean)=>void;onAction:(action:"check"|"download"|"cancel")=>void;onClose:()=>void};
export default function UpdaterSettings(props:Props) {
 const {snapshot,automatic,busy,error,onAutomatic,onAction,onClose}=props;
 const operation=snapshot?updaterBusy(snapshot.state):false;
 return <section className="terminal-settings" role="dialog" aria-modal="true" aria-label="Updates">
  <h2>Updates</h2>
  <p>Running version: {snapshot?.current_version??"Loading"}</p>
  <p>Status: {snapshot?.state??"Loading"}</p>
  {!snapshot?.configured&&<p>Update deployment is not configured. Checks and downloads are unavailable.</p>}
  <label><input type="checkbox" checked={automatic} disabled={busy||operation} onChange={event=>onAutomatic(event.target.checked)}/> Check once when YAM opens</label>
  {snapshot?.release&&<div><h3>{snapshot.release.version}</h3><p>{snapshot.release.published}</p><pre>{snapshot.release.notes}</pre></div>}
  {snapshot?.progress&&<p>Observed bytes: {snapshot.progress.observed}{snapshot.progress.total!==null?" / "+snapshot.progress.total:" (total unknown)"}</p>}
  {snapshot?.state==="cancelling"&&<p>Waiting for the update worker to finish cancelling.</p>}
  {snapshot?.state==="verified"&&<p>The SDK verified the downloaded artifact. Installation is unavailable.</p>}
  {(error||snapshot?.reason)&&<p role="alert">{error??snapshot?.reason}</p>}
  <button disabled={!snapshot?.configured||busy||operation} onClick={()=>onAction("check")}>Check for updates</button>
  <button disabled={busy||snapshot?.state!=="available"} onClick={()=>onAction("download")}>Download and verify</button>
  <button disabled={!operation||snapshot?.state==="cancelling"} onClick={()=>onAction("cancel")}>Cancel</button>
  <button disabled title="Installation requires release compatibility and backup support">Install</button>
  <p>Installation is not available in this version.</p>
  <button onClick={onClose}>Close</button>
 </section>;
}
