// Author: Jeff.Liu. Owner-validated previews never execute a launch.
export type LaunchDefaults = {adapter:string;mode:string;extra_args:string;prompt:string|null;command:string|null};
export type ProjectSettings = Partial<LaunchDefaults> & {cwd?:string;env?:Record<string,string>};
export type ProjectPreview = {root:string;identity:string;source:string;config:{version:1;defaults?:ProjectSettings;templates?:({name:string}&ProjectSettings)[]}|null;trusted:boolean};
export function resolveLaunchDefaults(global:LaunchDefaults,trusted:ProjectSettings|null,ui:Partial<LaunchDefaults>):LaunchDefaults {return {...global,...trusted,...ui};}
export function isLaunchDefaults(value:unknown):value is LaunchDefaults {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).every(k=>["adapter","mode","extra_args","prompt","command"].includes(k))&&typeof v.adapter==="string"&&["shell","custom","codex","claude","opencode"].includes(v.adapter)&&typeof v.mode==="string"&&["task","interactive"].includes(v.mode)&&typeof v.extra_args==="string"&&v.extra_args.length<=65536&&(v.prompt===null||typeof v.prompt==="string")&&(v.command===null||typeof v.command==="string");
}
export class ProjectConfigSelection {
 preview:ProjectPreview|null=null;
 approved:ProjectSettings|null=null;
 private version=0;
 async load(read:()=>Promise<ProjectPreview>):Promise<void> {
  const version=++this.version;this.preview=null;this.approved=null;
  try {const next=await read();if(version!==this.version)return;this.preview=next;this.approved=next.trusted?next.config?.defaults??{}:null;}
  catch(reason){if(version===this.version)throw reason;}
 }
 async approve(trust:(preview:ProjectPreview)=>Promise<ProjectPreview>):Promise<void> {
  const preview=this.preview;if(!preview)throw Error("No configuration preview to trust");const version=++this.version;
  try {const next=await trust(preview);if(version!==this.version)return;if(next.root!==preview.root||next.identity!==preview.identity||next.source!==preview.source||!next.trusted)throw Error("Project configuration changed; preview again");this.preview=next;this.approved=next.config?.defaults??{};}
  catch(reason){if(version===this.version)throw reason;}
 }
 cancel():void {this.version++;this.preview=null;this.approved=null;}
}
