import {t} from "./i18n";
import {Select} from "./Select";
import type {ProjectPreview} from "./project-config";

type Props={preview:ProjectPreview|null;busy:boolean;error:string|null;template:string;onTemplate:(name:string)=>void;onPreview:()=>void;onTrust:()=>void;onCancel:()=>void};
// Author: Jeff.Liu. Approval never starts a task.
export function ProjectConfigPreview({preview,busy,error,template,onTemplate,onPreview,onTrust,onCancel}:Props) {
 return <section className="project-config-preview" aria-label={t("Project launch configuration")}>
  <div className="dialog-actions"><button type="button" disabled={busy} onClick={onPreview}>{t("Preview yam.json")}</button><button type="button" disabled={busy} onClick={onCancel}>{t("Cancel preview")}</button></div>
  {busy&&<p role="status">{t("Checking project configuration…")}</p>}
  {error&&<p role="alert">{t(error)}</p>}
  {preview&&<><p>{preview.root}</p><p>{preview.config?preview.trusted?t("Trusted exact configuration. Start session is a separate action."):t("Untrusted configuration. Review before allowing it to affect a launch."):t("No yam.json. Application defaults remain available.")}</p>
   {preview.config&&<><pre>{JSON.stringify(preview.config,null,2)}</pre><p>{t("Environment entries reference owner variables by name. Values are never shown. Custom commands use their explicit shell semantics.")}</p>
    {!preview.trusted&&<button type="button" disabled={busy} onClick={onTrust}>{t("Trust this exact configuration")}</button>}
    <label>{t("Task template")}<Select aria-label={t("Project launch template")} value={template} disabled={busy||!preview.trusted} onChange={event=>onTemplate(event.target.value)}><option value="">{t("Project defaults")}</option>{preview.config.templates?.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</Select></label>
   </>}
  </>}
 </section>;
}
