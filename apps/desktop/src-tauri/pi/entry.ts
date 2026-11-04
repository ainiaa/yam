import {createAssistantMessageEventStream,getCurrentTools,getCurrentSystemPrompt,normalizeContext} from '@earendil-works/pi-ai';
import {createNativeCodex} from './native-codex.mjs';
// Author: Jeff.Liu. Pi supplies its own model capability and credential handling.
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai/models';
import {Text} from '@earendil-works/pi-tui';
import {convertToPng} from '@earendil-works/pi-coding-agent';
import install from './router.mjs';
import {installAgents} from './agent-orchestrator.mjs';
import {createAgentDiscovery} from './agent-executor.mjs';
export default async function(pi) {
 try {
 const validateImage=async bytes=>Boolean(await convertToPng(Buffer.from(bytes).toString('base64'),'application/octet-stream'));
 const discover=createAgentDiscovery();
 const native=createNativeCodex(pi,{discover,createStream:createAssistantMessageEventStream,normalizeContext,getTools:context=>context.tools??getCurrentTools(context.messages),getSystemPrompt:context=>context.systemPrompt??getCurrentSystemPrompt(context.messages),validateImage});
 const routing=await install(pi,getSupportedThinkingLevels,Text,native);
 installAgents(pi,routing,{validateImage,discover});
 return routing;
 } catch(error) {
  if(process.argv.includes('--yam-catalog-probe'))console.log(JSON.stringify({type:'yam_catalog',error:'Pi cannot load the required YAM routing extension APIs; update or configure Pi and retry'}));
  throw error;
 }
}
