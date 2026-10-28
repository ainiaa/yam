// Author: Jeff.Liu. A finite allowlist keeps task state and credentials outside backups.
import {APP_PREFERENCES_KEY,isAppPreferences} from './app-preferences.ts';
import {APP_SHORTCUT_KEY,decodeAppShortcuts} from './app-shortcuts.ts';
import {isTerminalSettings} from './terminal-settings.ts';
import {isTerminalCursor} from './terminal-cursor.ts';
import {decodeTerminalLineHeight} from './terminal-line-height.ts';
import {connectionTemplate} from './saved-connections.ts';
import {encodeLaunchTemplates,LAUNCH_TEMPLATE_STORAGE_KEY,type LaunchTemplate} from './launch-templates.ts';
import type {ProviderConfig} from './provider-config.ts';
const KEYS=[APP_PREFERENCES_KEY,APP_SHORTCUT_KEY,'yam.terminalSettings','yam.terminalCursor.v1','yam.terminalLineHeight.v1'] as const;
type Connection={name:string;adapter:string;provider:ProviderConfig};
export type PreferencesBackup={version:1;settings:Record<string,unknown>;connections:Connection[]};
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(value,k));}
function setting(key:string,value:unknown,mac:boolean):unknown {
 if(key===APP_PREFERENCES_KEY){if(!isAppPreferences(value))throw Error('Invalid appearance backup.');return {...value,background:null};}
 if(key===APP_SHORTCUT_KEY){decodeAppShortcuts(JSON.stringify(value),mac);return value;}
 if(key==='yam.terminalSettings'&&isTerminalSettings(value))return value;
 if(key==='yam.terminalCursor.v1'&&isTerminalCursor(value))return value;
 if(key==='yam.terminalLineHeight.v1')return decodeTerminalLineHeight(JSON.stringify(value));
 throw Error('Unsupported or invalid preference backup.');
}
function connection(value:unknown):Connection {
 if(!exact(value,['name','adapter','provider'])||typeof value.name!=='string'||!value.name.trim()||[...value.name].length>80||/[\x00-\x1f\x7f]/.test(value.name)||typeof value.adapter!=='string')throw Error('Invalid saved connection backup.');
 const launch=connectionTemplate(value.adapter,value.provider as ProviderConfig);return {name:value.name,adapter:launch.adapter,provider:launch.provider!};
}
export function parsePreferencesBackup(raw:string,mac:boolean):PreferencesBackup{
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>1048576)throw Error('Preference backup exceeds 1 MiB.');
 const value:unknown=JSON.parse(raw);
 if(!exact(value,['version','settings','connections'])||value.version!==1||!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings)||!Array.isArray(value.connections)||value.connections.length>32)throw Error('Invalid preference backup.');
 const settings:Record<string,unknown>={};for(const [key,v]of Object.entries(value.settings)){if(!(KEYS as readonly string[]).includes(key))throw Error('Unsupported preference backup key.');settings[key]=setting(key,v,mac);}
 return {version:1,settings,connections:value.connections.map(connection)};
}
export function createPreferencesBackup(read:(key:string)=>string|null,templates:readonly LaunchTemplate[],mac:boolean):string{
 const settings:Record<string,unknown>={};for(const key of KEYS){const raw=read(key);if(raw!==null)settings[key]=setting(key,JSON.parse(raw),mac);}
 const connections=templates.filter(row=>row.provider).map(row=>connection({name:row.name,adapter:row.adapter,provider:row.provider}));
 return JSON.stringify({version:1,settings,connections},null,2);
}
export function preferencesImportWrites(backup:PreferencesBackup,templates:readonly LaunchTemplate[],makeId=()=>crypto.randomUUID(),loadError:string|null=null,currentAppearance:unknown=null):Record<string,string>{
 if(loadError&&backup.connections.length)throw Error('Existing saved connections are unavailable. Recover their storage before importing connections.');
 const checked=parsePreferencesBackup(JSON.stringify(backup),true),writes:Record<string,string>={};
 for(const [key,value]of Object.entries(checked.settings))writes[key]=JSON.stringify(key===APP_PREFERENCES_KEY&&isAppPreferences(currentAppearance)?{...(value as Record<string,unknown>),background:currentAppearance.background}:value);
 const merged=[...templates];
 for(const row of checked.connections){
  if(merged.some(old=>old.adapter===row.adapter&&JSON.stringify(old.provider)===JSON.stringify(row.provider)))continue;
  let name=row.name;for(let i=2;merged.some(old=>old.name===name);i++)name=[...row.name].slice(0,70).join('')+` (${i})`;
  merged.push({id:makeId(),name,...connectionTemplate(row.adapter,row.provider)});
 }
 if(checked.connections.length)writes[LAUNCH_TEMPLATE_STORAGE_KEY]=encodeLaunchTemplates(merged);
 return writes;
}
export function applyPreferencesImport(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,writes:Record<string,string>){
 const previous=Object.fromEntries(Object.keys(writes).map(key=>[key,storage.getItem(key)]));
 try{for(const [key,value]of Object.entries(writes))storage.setItem(key,value);}
 catch{let failed=false;for(const [key,value]of Object.entries(previous))try{if(value===null)storage.removeItem(key);else storage.setItem(key,value);}catch{failed=true;}throw Error(failed?'Import failed and rollback was incomplete. Keep the backup and review settings.':'Import failed. Previous preferences were restored.');}
}
