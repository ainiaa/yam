import type {ProjectPreview} from "./project-config";

type Props={preview:ProjectPreview|null;busy:boolean;error:string|null;template:string;onTemplate:(name:string)=>void;onPreview:()=>void;onTrust:()=>void;onCancel:()=>void};
// Author: Jeff.Liu. Approval never starts a task.
export function ProjectConfigPreview({preview,busy,error,template,onTemplate,onPreview,onTrust,onCancel}:Props) {
 return <section className="project-config-preview" aria-label="Project launch configuration">
  <div className="dialog-actions"><button type="button" disabled={busy} onClick={onPreview}>Preview yam.json</button><button type="button" disabled={busy} onClick={onCancel}>Cancel preview</button></div>
  {busy&&<p role="status">Checking project configuration…</p>}
  {error&&<p role="alert">{error}</p>}
  {preview&&<><p>{preview.root}</p><p>{preview.config?preview.trusted?"Trusted exact configuration. Start session is a separate action.":"Untrusted configuration. Review before allowing it to affect a launch.":"No yam.json. Application defaults remain available."}</p>
   {preview.config&&<><pre>{JSON.stringify(preview.config,null,2)}</pre><p>Environment entries reference owner variables by name. Values are never shown. Custom commands use their explicit shell semantics.</p>
    {!preview.trusted&&<button type="button" disabled={busy} onClick={onTrust}>Trust this exact configuration</button>}
    <label>Task template<select value={template} disabled={busy||!preview.trusted} onChange={event=>onTemplate(event.target.value)}><option value="">Project defaults</option>{preview.config.templates?.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
   </>}
  </>}
 </section>;
}
