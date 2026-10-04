import {isLaunchDefaults} from "./project-config.ts";

export const LAUNCH_TEMPLATE_STORAGE_KEY="yam.launchTemplates.v1";
export const MAX_LAUNCH_TEMPLATES=32;
export const MAX_LAUNCH_TEMPLATE_NAME_CODEPOINTS=80;
export const MAX_LAUNCH_TEMPLATE_FIELD_CODE_UNITS=65536;
export const MAX_LAUNCH_TEMPLATE_STORAGE_CODE_UNITS=524288;
export const LAUNCH_TEMPLATE_WRITE_ERROR="Could not save launch templates.";

export type LaunchTemplateFields={adapter:string;mode:string;extra_args:string;prompt:string|null;command:string|null};
export type LaunchTemplate=LaunchTemplateFields&{id:string;name:string};

const templateKeys=["id","name","adapter","mode","extra_args","prompt","command"];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactDataRecord(value:unknown,keys:string[]):value is Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const ownKeys=Reflect.ownKeys(value);
 if(ownKeys.length!==keys.length||!keys.every(key=>ownKeys.includes(key)))return false;
 return keys.every(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return !!descriptor&&descriptor.enumerable&&Object.prototype.hasOwnProperty.call(descriptor,"value");
 });
}
function densePlainArray(value:unknown):value is unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return false;
 const ownKeys=Reflect.ownKeys(value);
 if(ownKeys.length!==value.length+1||!ownKeys.includes("length"))return false;
 for(let index=0;index<value.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
  if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,"value"))return false;
 }
 return true;
}
function validFields(value:unknown):value is LaunchTemplateFields{return isLaunchDefaults(value);}
function validTemplate(value:unknown):value is LaunchTemplate{
 if(!exactDataRecord(value,templateKeys))return false;
 const item=value as Record<string,unknown>;
 const fields={adapter:item.adapter,mode:item.mode,extra_args:item.extra_args,prompt:item.prompt,command:item.command};
 return typeof item.id==="string"&&uuid.test(item.id)&&typeof item.name==="string"&&item.name.length>0&&[...item.name].length<=MAX_LAUNCH_TEMPLATE_NAME_CODEPOINTS&&item.name===item.name.trim()&&validFields(fields)&&fieldLengthOk(fields);
}
function requireTarget(templates:LaunchTemplate[],id:string):number{
 const index=templates.findIndex(item=>item.id===id);
 if(index<0)throw new Error("Selected launch template is unavailable.");
 return index;
}
function requireUniqueName(templates:LaunchTemplate[],name:string,exceptId?:string):void{
 if(templates.some(item=>item.id!==exceptId&&item.name===name))throw new Error("Launch template name already exists.");
}
function requireUniqueId(templates:LaunchTemplate[],id:string):void{
 if(!uuid.test(id)||templates.some(item=>item.id===id))throw new Error("Launch template ID is invalid or already exists.");
}
function fieldLengthOk(fields:LaunchTemplateFields):boolean{return [fields.extra_args,fields.prompt,fields.command].every(value=>value===null||value.length<=MAX_LAUNCH_TEMPLATE_FIELD_CODE_UNITS);}

/** Pick only launch controls, before validation, so project metadata and secrets never enter storage. */
export function projectLaunchFields(value:unknown):LaunchTemplateFields{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Launch settings are invalid.");
 const source=value as Record<string,unknown>;
 const fields={adapter:source.adapter,mode:source.mode,extra_args:source.extra_args,prompt:source.prompt,command:source.command};
 if(!validFields(fields)||!fieldLengthOk(fields))throw new Error("Launch settings are invalid.");
 return fields;
}

export function normalizeTemplateName(value:string):string{
 if(typeof value!=="string")throw new Error("Launch template name is required.");
 const name=value.trim();
 if(name.length===0||[...name].length>MAX_LAUNCH_TEMPLATE_NAME_CODEPOINTS)throw new Error("Launch template name must contain 1–80 characters.");
 return name;
}

export function createLaunchTemplate(name:string,launch:unknown,makeId:()=>string=()=>crypto.randomUUID()):LaunchTemplate{
 const cleanName=normalizeTemplateName(name);
 const fields=projectLaunchFields(launch);
 const id=makeId();
 if(!uuid.test(id))throw new Error("Launch template ID is invalid.");
 return {id,name:cleanName,...fields};
}

export function decodeLaunchTemplates(raw:string|null):LaunchTemplate[]{
 if(raw===null)return [];
 if(typeof raw!=="string"||raw.length>MAX_LAUNCH_TEMPLATE_STORAGE_CODE_UNITS)throw new Error("Launch template storage exceeds the size limit.");
 let decoded:unknown;
 try{decoded=JSON.parse(raw);}catch{throw new Error("Launch template storage is invalid.");}
 if(!exactDataRecord(decoded,["version","templates"])||(decoded as {version?:unknown}).version!==1||!densePlainArray((decoded as {templates?:unknown}).templates)||(decoded as {templates:unknown[]}).templates.length>MAX_LAUNCH_TEMPLATES)throw new Error("Launch template storage is invalid.");
 const rows=(decoded as {templates:unknown[]}).templates;
 for(const row of rows)if(!validTemplate(row))throw new Error("Launch template storage is invalid.");
 const templates=rows as LaunchTemplate[];
 if(new Set(templates.map(item=>item.id)).size!==templates.length||new Set(templates.map(item=>item.name)).size!==templates.length)throw new Error("Launch template storage is invalid.");
 return templates;
}

export function encodeLaunchTemplates(templates:LaunchTemplate[]):string{
 if(!densePlainArray(templates)||templates.length>MAX_LAUNCH_TEMPLATES)throw new Error("Launch templates are invalid or exceed the limit.");
 const ids=new Set<string>(),names=new Set<string>(),serializedRows:Record<string,unknown>[]=[];
 for(const template of templates){
  if(!validTemplate(template)||ids.has(template.id)||names.has(template.name))throw new Error("Launch templates are invalid or exceed the limit.");
  ids.add(template.id);names.add(template.name);
  const clean=Object.create(null) as Record<string,unknown>;
  for(const key of templateKeys)clean[key]=(template as unknown as Record<string,unknown>)[key];
  serializedRows.push(clean);
 }
 const cleanRows=serializedRows;Object.setPrototypeOf(cleanRows,null);
 const envelope=Object.create(null) as Record<string,unknown>;
 envelope.version=1;envelope.templates=cleanRows;
 const raw=JSON.stringify(envelope);
 if(raw.length>MAX_LAUNCH_TEMPLATE_STORAGE_CODE_UNITS)throw new Error("Launch template storage exceeds the size limit.");
 return raw;
}

export function saveTemplate(templates:LaunchTemplate[],name:string,launch:unknown,makeId:()=>string=()=>crypto.randomUUID()):LaunchTemplate[]{
 if(templates.length>=MAX_LAUNCH_TEMPLATES)throw new Error("Launch template limit reached.");
 const candidate=createLaunchTemplate(name,launch,makeId);
 requireUniqueName(templates,candidate.name);requireUniqueId(templates,candidate.id);
 return [...templates,candidate];
}

export function updateTemplate(templates:LaunchTemplate[],id:string,name:string,launch:unknown):LaunchTemplate[]{
 const index=requireTarget(templates,id),candidate={id,name:normalizeTemplateName(name),...projectLaunchFields(launch)};
 requireUniqueName(templates,candidate.name,id);
 const next=[...templates];next[index]=candidate;return next;
}

function truncateCodepoints(value:string,max:number):string{return [...value].slice(0,max).join("");}
export function duplicateTemplate(templates:LaunchTemplate[],id:string,makeId:()=>string=()=>crypto.randomUUID()):LaunchTemplate[]{
 const source=templates[requireTarget(templates,id)];
 if(templates.length>=MAX_LAUNCH_TEMPLATES)throw new Error("Launch template limit reached.");
 const newId=makeId();requireUniqueId(templates,newId);
 for(let attempt=1;attempt<=33;attempt++){
  const suffix=attempt===1?" (copy)":` (copy ${attempt})`;
  const name=truncateCodepoints(source.name,MAX_LAUNCH_TEMPLATE_NAME_CODEPOINTS-[...suffix].length)+suffix;
  if(!templates.some(item=>item.name===name))return [...templates,{...source,id:newId,name}];
 }
 throw new Error("Could not find a unique launch template copy name.");
}

export function deleteTemplate(templates:LaunchTemplate[],id:string):LaunchTemplate[]{
 const index=requireTarget(templates,id);return templates.filter((_,row)=>row!==index);
}

export class LaunchTemplateCollection{
 templates:LaunchTemplate[]=[];
 selectedId:string|null=null;
 writeError:string|null=null;
 private readonly storage:Pick<Storage,"getItem"|"setItem">;
 private readonly makeId:()=>string;
 constructor(storage:Pick<Storage,"getItem"|"setItem">,makeId:()=>string=()=>crypto.randomUUID()){this.storage=storage;this.makeId=makeId;}
 load():void{
  try{this.templates=decodeLaunchTemplates(this.storage.getItem(LAUNCH_TEMPLATE_STORAGE_KEY));}
  catch{this.templates=[];}
  this.selectedId=null;
 }
 select(id:string|null):void{
  this.selectedId=id!==null&&this.templates.some(item=>item.id===id)?id:null;
 }
 apply():LaunchTemplate|null{return this.templates.find(item=>item.id===this.selectedId)??null;}
 private commit(candidate:LaunchTemplate[],selectedId:string|null):void{
  try{const raw=encodeLaunchTemplates(candidate);this.storage.setItem(LAUNCH_TEMPLATE_STORAGE_KEY,raw);}
  catch(reason){this.writeError=LAUNCH_TEMPLATE_WRITE_ERROR;throw reason;}
  this.templates=candidate;this.selectedId=selectedId;this.writeError=null;
 }
 save(name:string,launch:unknown):LaunchTemplate{
  const candidate=saveTemplate(this.templates,name,launch,this.makeId),created=candidate[candidate.length-1];this.commit(candidate,created.id);return created;
 }
 update(id:string,name:string,launch:unknown):LaunchTemplate{
  const candidate=updateTemplate(this.templates,id,name,launch),updated=candidate.find(item=>item.id===id)!;this.commit(candidate,id);return updated;
 }
 duplicate(id:string):LaunchTemplate{
  const candidate=duplicateTemplate(this.templates,id,this.makeId),copy=candidate[candidate.length-1];this.commit(candidate,copy.id);return copy;
 }
 delete(id:string):void{const candidate=deleteTemplate(this.templates,id);this.commit(candidate,null);}
}
