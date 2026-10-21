import {t} from "./i18n";
import {connectionDetails} from "./provider-config";
import type {LaunchTemplate} from "./launch-templates";

type Props={
 templates:LaunchTemplate[];
 selectedId:string|null;
 name:string;
 writeError:string|null;
 loadError?:string|null;
 rawStorage?:string|null;
 actionError:string|null;
 starting:boolean;
 onNameChange:(name:string)=>void;
 onSelect:(id:string)=>void;
 onSave:()=>void;
 onUpdate:()=>void;
 onDuplicate:()=>void;
 onDelete:()=>void;
 onApply:(template:LaunchTemplate)=>void;
 onReset?:()=>void;
 onCopyOriginal?:()=>void;
};

export function LaunchTemplates({templates,selectedId,name,writeError,loadError,rawStorage,actionError,starting,onNameChange,onSelect,onSave,onUpdate,onDuplicate,onDelete,onApply,onReset,onCopyOriginal}:Props){
 const selected=templates.find(item=>item.id===selectedId)??null;
 return <section className="launch-templates" aria-label={t("Launch templates")}>
  <h3>{t("Launch templates")}</h3>
  <p className="launch-template-disclosure">{t("Saved templates are stored as plain text on this device. Prompts, custom commands, and CLI arguments are not encrypted.")}</p>
  {loadError&&<div>
   <p role="alert">{t(loadError)}</p>
   {rawStorage===null&&<p>{t("Original data could not be read. Reset discards any stored templates.")}</p>}
   <button type="button" disabled={starting||rawStorage==null} onClick={onCopyOriginal}>{t("Copy original data")}</button>
   <button type="button" disabled={starting} onClick={onReset}>{t("Reset templates")}</button>
  </div>}
  <label><span>{t("Template name")}</span><input value={name} maxLength={320} disabled={starting} onChange={event=>onNameChange(event.target.value)}/></label>
  <ul>{templates.map(template=>{const connection=connectionDetails(template);return <li key={template.id}>
   <button type="button" aria-label={t("Select template")} aria-pressed={template.id===selectedId} disabled={starting} onClick={()=>onSelect(template.id)}>{template.name}</button>
   <small>{[template.adapter,template.mode==="task"?t("Automation only"):null,connection.source,connection.model,connection.endpoint,template.provider?.api_key_env?t("Key variable: {{value0}}", {value0:template.provider.api_key_env}):null].filter(Boolean).join(" · ")}</small>
  </li>;})}</ul>
  <div className="launch-template-actions">
   <button type="button" disabled={starting||!!loadError} onClick={onSave}>{t("Save current")}</button>
   <button type="button" disabled={starting||!!loadError||!selected} onClick={onUpdate}>{t("Update selected")}</button>
   <button type="button" disabled={starting||!!loadError||!selected} onClick={onDuplicate}>{t("Duplicate selected")}</button>
   <button type="button" disabled={starting||!!loadError||!selected} onClick={onDelete}>{t("Delete selected")}</button>
   <button type="button" disabled={starting||!selected||selected.mode!=="interactive"} onClick={()=>selected&&onApply(selected)}>{t("Apply selected")}</button>
  </div>
  {writeError&&<p role="alert">{t(writeError)}</p>}{actionError&&<p role="alert">{t(actionError)}</p>}
 </section>;
}
