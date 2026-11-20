// Author: Jeff.Liu
import {createAssistantMessageEventStream,streamSimple} from '@oh-my-pi/pi-ai';
import {buildModel} from '@oh-my-pi/pi-catalog/build';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createChatgptProvider,PROVIDER} from './provider.mjs';
import {createSubprocessCredentialReader,createYamSubprocessCredentialReader,yamAuthDirectory} from './runtime.mjs';
import {lookup} from '@oh-my-pi/pi-coding-agent/config/registry';
import {installDesktopBridge} from './desktop.mjs';
import {readRoutingPolicy,magpieModels,installRouting} from './routing.mjs';

export default async function install(pi) {
  if(process.env.YAM_OMP_DESKTOP==='1')installDesktopBridge(pi);
  const packageDir=process.env.YAM_PI_PACKAGE_DIR;
  const source=process.env.YAM_OMP_AUTH_SOURCE??'yam';
  if(!['yam','pi'].includes(source)||!process.env.YAM_NODE_BINARY||source==='pi'&&!packageDir)throw Error('Use the OMP launcher to configure its authentication source and system proxy.');
  const readCredential=source==='pi'?createSubprocessCredentialReader({node:process.env.YAM_NODE_BINARY,packageDir,authPath:join(homedir(),'.pi','agent','auth.json')}):createYamSubprocessCredentialReader({node:process.env.YAM_NODE_BINARY,authDir:yamAuthDirectory()});
  const provider=createChatgptProvider({buildModel,readCredential,fetch:globalThis.fetch,stream:streamSimple,createStream:createAssistantMessageEventStream});
  pi.registerProvider(PROVIDER,{
    baseUrl:'https://api.openai.com/v1',api:'yam-chatgpt-responses',
    // Availability marker only; the selected credential helper owns authentication and refresh.
    apiKey:'yam-oauth-managed',models:await provider.models(),streamSimple:provider.stream,
  });
  if(process.env.YAM_OMP_ROUTING_POLICY){
    const policy=readRoutingPolicy(process.env.YAM_OMP_ROUTING_POLICY);
    if(!pi.pi?.settings)throw Error('OMP routing requires runtime settings capabilities.');
    for(const [id,value] of [['retry.modelFallback',false],['compaction.methodOrder',['soft']]]){
      const setting=lookup(id);
      if(typeof setting?.override!=='function')throw Error(`OMP routing requires runtime setting ${id}.`);
      setting.override(pi.pi.settings,value);
    }
    const subscription=(await provider.models()).map(m=>buildModel({...m,provider:PROVIDER,api:'yam-chatgpt-responses',baseUrl:'https://api.openai.com/v1'}));
    let gateway=[];
    const gatewayIds=new Set([policy.small,policy.medium,policy.strong,policy.classifier,policy.model,...policy.classifierFallbacks,...Object.values(policy.executionFallbacks).flat()].filter(k=>k?.startsWith('yam-magpie/')).map(k=>k.slice('yam-magpie/'.length)));
    if(policy.gateway&&gatewayIds.size){
      const response=await fetch(policy.gateway+'/v1/models',{signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.ok)throw Error(`Magpie catalog unavailable (${response.status}).`);
      const data=await response.json();
      if(!Array.isArray(data?.data))throw Error('Invalid Magpie model catalog');
      gateway=magpieModels({data:data.data.filter(m=>gatewayIds.has(m?.id))},policy.gateway,buildModel);
    }
    const stream=(model,context,options)=>model.provider===PROVIDER?provider.stream(model,context,options):streamSimple(model,context,{...options,apiKey:'yam-local-gateway'});
    installRouting(pi,policy,{models:[...subscription,...gateway],createStream:createAssistantMessageEventStream,run:(...args)=>stream(...args).result(),delegate:stream});
  }
}
