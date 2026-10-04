import type {LaunchTemplate} from "./launch-templates";

type Props={
 templates:LaunchTemplate[];
 selectedId:string|null;
 name:string;
 writeError:string|null;
 actionError:string|null;
 starting:boolean;
 onNameChange:(name:string)=>void;
 onSelect:(id:string)=>void;
 onSave:()=>void;
 onUpdate:()=>void;
 onDuplicate:()=>void;
 onDelete:()=>void;
 onApply:(template:LaunchTemplate)=>void;
};

export function LaunchTemplates({templates,selectedId,name,writeError,actionError,starting,onNameChange,onSelect,onSave,onUpdate,onDuplicate,onDelete,onApply}:Props){
 const selected=templates.find(item=>item.id===selectedId)??null;
 return <section className="launch-templates" aria-label="Launch templates">
  <h3>Launch templates</h3>
  <p className="launch-template-disclosure">Saved templates are stored as plain text on this device. Prompts, custom commands, and CLI arguments are not encrypted.</p>
  <label><span>Template name</span><input value={name} maxLength={320} disabled={starting} onChange={event=>onNameChange(event.target.value)}/></label>
  <ul>{templates.map(template=><li key={template.id}>
   <button type="button" aria-label="Select template" aria-pressed={template.id===selectedId} disabled={starting} onClick={()=>onSelect(template.id)}>{template.name}</button>
   <button type="button" aria-label={`Apply ${template.name}`} disabled={starting} onClick={()=>onApply(template)}>Apply</button>
  </li>)}</ul>
  <div className="launch-template-actions">
   <button type="button" disabled={starting} onClick={onSave}>Save current</button>
   <button type="button" disabled={starting||!selected} onClick={onUpdate}>Update selected</button>
   <button type="button" disabled={starting||!selected} onClick={onDuplicate}>Duplicate selected</button>
   <button type="button" disabled={starting||!selected} onClick={onDelete}>Delete selected</button>
   <button type="button" disabled={starting||!selected} onClick={()=>selected&&onApply(selected)}>Apply selected</button>
  </div>
  {writeError&&<p role="alert">{writeError}</p>}{actionError&&<p role="alert">{actionError}</p>}
 </section>;
}
