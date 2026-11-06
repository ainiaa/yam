// Author: Jeff.Liu. Only local CLI status/features probes; no model or GUI invocation.
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as executor from '../apps/desktop/src-tauri/pi/agent-executor.mjs';
import {createNativeCodex} from '../apps/desktop/src-tauri/pi/native-codex.mjs';
export async function profileNative({executable=process.env.YAM_CODEX_EXECUTABLE??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',rounds=5}={}){
 const results=[];
 for(let i=0;i<rounds;i++){
  const probes=[],registrations=[];const probe=async(f,a,o)=>{const t=performance.now(),r=await executor.runProcess(f,a,o);probes.push({kind:a[0],ms:performance.now()-t,code:r.code});return r;};
  const discover=executor.createAgentDiscovery?.({probe})??(e=>executor.discoverAgents(e,probe));
  const pi={registerCommand(){},registerProvider:(_p,c)=>registrations.push(c.models.length)};
  const native=createNativeCodex(pi,{discover,executable}),start=performance.now();
  await native.initialize({modelRegistry:{getAll:()=>[]}});
  await discover({codex:executable});
  for(let j=0;j<2;j++)if(!(await discover({codex:executable},{execution:true})).some(a=>a.auth==='subscription'))throw Error('ChatGPT login unavailable');
  results.push({ms:performance.now()-start,probes,registrations:registrations.length,registeredModelEntries:registrations.reduce((a,b)=>a+b,0)});
 }
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 return {scenario:'initialize + delegation catalog + classifier auth + task auth; local probes only',rounds,medianMs:median(results.map(r=>r.ms)),probeCount:results[0].probes.length,providerRegistrations:results[0].registrations,registeredModelEntries:results[0].registeredModelEntries,results};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]!=='--real-probes')throw Error('Use --real-probes for headless local CLI probes');
 console.log(JSON.stringify(await profileNative(),null,2));
}
