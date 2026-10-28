import {validateSessionTitle} from "./workspaces.ts";
// Author: Jeff.Liu. Session copies carry configuration references, never conversation identity.
import {isLaunchDefaults,type LaunchDefaults} from './project-config.ts';
import {isShellLaunch,type ShellLaunch} from './shell-launch.ts';
import {isTerminalSettings,type TerminalSettings} from './terminal-settings.ts';
export type SessionLaunchSettings={terminal:'yam'|'terminal'|'iterm2';envRefs?:Record<string,string>;appearance?:TerminalSettings;ordinary?:{shell?:ShellLaunch;envRefs?:Record<string,string>;retainedLines?:number;appearance?:TerminalSettings;directoryReporting?:boolean;commandReporting?:boolean}};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const refs=(v:unknown)=>object(v)&&Object.keys(v).length<=32&&Object.entries(v).every(([key,value])=>/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)&&!key.startsWith('YAM_')&&typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)&&!value.startsWith('YAM_'));
export function isSessionPreferenceKey(key:string){return /^yam\.session(?:Launch|Name)\.s-[a-zA-Z0-9-]{1,120}$/.test(key);}
function keyFor(kind:'Launch'|'Name',id:string){const key=`yam.session${kind}.${id}`;if(!isSessionPreferenceKey(key))throw Error('Invalid session ID.');return key;}
export function isSessionLaunchSettings(value:unknown):value is SessionLaunchSettings {
 if(!object(value)||!['yam','terminal','iterm2'].includes(value.terminal as string)||Object.keys(value).some(k=>!['terminal','ordinary','envRefs','appearance'].includes(k))||value.envRefs!==undefined&&!refs(value.envRefs)||value.appearance!==undefined&&!isTerminalSettings(value.appearance))return false;
 const v=value.ordinary;if(v===undefined)return true;
 return object(v)&&Object.keys(v).every(k=>['shell','envRefs','retainedLines','appearance','directoryReporting','commandReporting'].includes(k))&&(v.shell===undefined||isShellLaunch(v.shell,object(v.shell)&&v.shell.login===null))&&(v.envRefs===undefined||refs(v.envRefs))&&(v.appearance===undefined||isTerminalSettings(v.appearance))&&(v.retainedLines===undefined||Number.isInteger(v.retainedLines)&&Number(v.retainedLines)>=200&&Number(v.retainedLines)<=2000)&&['directoryReporting','commandReporting'].every(k=>v[k]===undefined||typeof v[k]==='boolean');
}
export function saveSessionLaunchSettings(storage:Pick<Storage,'setItem'>,id:string,value:SessionLaunchSettings){if(!isSessionLaunchSettings(value))throw Error('Invalid saved session configuration.');storage.setItem(keyFor('Launch',id),JSON.stringify(value));}
export function readSessionLaunchSettings(storage:Pick<Storage,'getItem'>,id:string):SessionLaunchSettings|null {const raw=storage.getItem(keyFor('Launch',id));if(raw===null)return null;if(raw.length>65536)throw Error('Invalid saved session configuration.');const value:unknown=JSON.parse(raw);if(!isSessionLaunchSettings(value))throw Error('Invalid saved session configuration.');return value;}
export function duplicateSessionDraft(source:unknown,saved?:SessionLaunchSettings|null):{cwd:string;draft:LaunchDefaults;settings:SessionLaunchSettings;reviewCommand:boolean;warning:string|null} {
 if(!object(source)||typeof source.cwd!=='string'||!source.cwd.trim()||source.cwd.length>4096||/[\x00-\x1f]/.test(source.cwd)||source.ssh)throw Error('This session cannot be copied.');
 if(saved!==undefined&&saved!==null&&!isSessionLaunchSettings(saved))throw Error('Invalid saved session configuration.');
 const settings:SessionLaunchSettings=saved?JSON.parse(JSON.stringify(saved)):{terminal:'yam'};
 const launch=source.launch;
 const command=source.command??null;if(command!==null&&typeof command!=='string')throw Error('Invalid saved session configuration.');
 let draft:LaunchDefaults={adapter:command?'custom':'shell',mode:'interactive',extra_args:'',prompt:null,command:command as string|null,provider:null};
 let warning:string|null=null;
 if(launch!==undefined&&launch!==null){
  if(!object(launch))throw Error('Invalid saved session configuration.');
  if(typeof launch.extra_args!=='string'||new TextEncoder().encode(launch.extra_args).length>65536||launch.extra_args.includes('\0'))throw Error('Invalid saved CLI arguments.');
  draft={adapter:launch.adapter as string,mode:'interactive',extra_args:'',prompt:null,command:null,provider:launch.provider?JSON.parse(JSON.stringify(launch.provider)):null,...(launch.codex&&object(launch.codex)?{codex:{image_mode:launch.codex.image_mode as 'native'|'gateway_api'}}:{})};
  if(launch.env_refs!==undefined){if(!refs(launch.env_refs))throw Error('Invalid saved environment references.');settings.envRefs={...launch.env_refs};}
  if(launch.extra_args.trim())warning='CLI arguments were cleared, including any prompt or resume options. Review Advanced options to add the arguments you need.';
 }
 if(!isLaunchDefaults(draft))throw Error('Invalid saved session configuration.');
 if(command)warning='This custom command will run again. Review it before starting the copy.';
 if(draft.adapter==='shell'&&!settings.ordinary)warning='Saved shell settings are unavailable. The copy will use current terminal defaults.';
 return{cwd:source.cwd,draft,settings,reviewCommand:!!command,warning};
}
export function saveSessionName(storage:Pick<Storage,'setItem'>,id:string,title:string|null){
 const name=title===null?null:validateSessionTitle(title);storage.setItem(keyFor('Name',id),JSON.stringify(name));return name;
}
export function readSessionName(storage:Pick<Storage,'getItem'>,id:string,legacy:string|null=null):string|null {
 const raw=storage.getItem(keyFor('Name',id));if(raw===null)return legacy;const name:unknown=JSON.parse(raw);
 if(name!==null&&(typeof name!=='string'||!name.trim()||[...name].length>200||/[\x00-\x1f\x7f]/.test(name)))throw Error('Invalid saved session name.');return name as string|null;
}
export function loadSessionNames(storage:Pick<Storage,'getItem'|'key'|'length'>,legacy:Record<string,string>){
 const result={...legacy};for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith('yam.sessionName.')||!isSessionPreferenceKey(key))continue;const id=key.slice('yam.sessionName.'.length),name=readSessionName(storage,id);if(name===null)delete result[id];else result[id]=name;}return result;
}
