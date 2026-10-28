// Author: Jeff.Liu. Existing launch-template storage is also the connection library.
import {isProviderConfig,copyProviderConfig,supportsProvider,type ProviderConfig} from './provider-config.ts';
import type {LaunchDefaults} from './project-config.ts';
export function connectionTemplate(adapter:string,provider:ProviderConfig):LaunchDefaults{
 if(!isProviderConfig(provider)||!supportsProvider(adapter,provider))throw Error('Choose a compatible CLI and valid provider settings.');
 return {adapter,mode:'interactive',extra_args:'',prompt:null,command:null,provider:copyProviderConfig(provider)};
}
