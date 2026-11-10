// Author: Jeff.Liu. Existing launch-template storage is also the connection library.
import {isProviderConfig,copyProviderConfig,supportsProvider,type ProviderConfig} from './provider-config.ts';
import type {LaunchDefaults} from './project-config.ts';
export function connectionTemplate(adapter:string,provider:ProviderConfig):LaunchDefaults{
 if(!isProviderConfig(provider)||!supportsProvider(adapter,provider))throw Error('Choose a compatible CLI and valid provider settings.');
 return {adapter,mode:'interactive',extra_args:'',prompt:null,command:null,provider:copyProviderConfig(provider)};
}
export function readLastConnection(storage:Pick<Storage,'getItem'>,adapter:string,fallback:ProviderConfig|null):ProviderConfig|null{
 if(!['codex','claude','gemini'].includes(adapter))return fallback;
 try{
  const raw=storage.getItem(`yam.lastConnection.${adapter}`);if(raw===null||raw.length>65536)return fallback;
  const value:unknown=JSON.parse(raw);
  return value===null?null:isProviderConfig(value)&&supportsProvider(adapter,value)?copyProviderConfig(value):fallback;
 }catch{return fallback;}
}
export function rememberConnection(storage:Pick<Storage,'setItem'>,adapter:string,provider:ProviderConfig|null){
 if(!['codex','claude','gemini'].includes(adapter))return;
 const value=provider===null?null:connectionTemplate(adapter,provider).provider;
 storage.setItem(`yam.lastConnection.${adapter}`,JSON.stringify(value));
}
