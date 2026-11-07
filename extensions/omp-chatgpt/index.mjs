// Author: Jeff.Liu
import {createAssistantMessageEventStream,streamSimple} from '@oh-my-pi/pi-ai';
import {buildModel} from '@oh-my-pi/pi-catalog/build';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createChatgptProvider,PROVIDER} from './provider.mjs';
import {createSubprocessCredentialReader} from './runtime.mjs';

export default async function install(pi) {
  const packageDir=process.env.YAM_PI_PACKAGE_DIR;
  if(!packageDir)throw Error('Use the omp-chatgpt/run.mjs launcher to locate Pi and configure the system proxy.');
  const readCredential=createSubprocessCredentialReader({node:process.env.YAM_NODE_BINARY,packageDir,authPath:join(homedir(),'.pi','agent','auth.json')});
  const provider=createChatgptProvider({buildModel,readCredential,fetch:globalThis.fetch,stream:streamSimple,createStream:createAssistantMessageEventStream});
  pi.registerProvider(PROVIDER,{
    baseUrl:'https://api.openai.com/v1',api:'yam-chatgpt-responses',
    // Availability marker only. The custom stream always obtains Pi OAuth itself.
    apiKey:'pi-oauth-managed',models:await provider.models(),streamSimple:provider.stream,
  });
}
