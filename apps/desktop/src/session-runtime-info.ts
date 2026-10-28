// Author: Jeff.Liu. Display recorded facts without parsing native CLI arguments a second time.
import {isProviderConfig} from './provider-config.ts';
const fact=(value:unknown,limit=4096):string=>typeof value==='string'&&value.trim()&&value.length<=limit&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)?value:'Unknown';
export function sessionRuntimeInfo(launch?:{adapter?:string;provider?:unknown}|null,agent?:{cli_path?:unknown;agent_session_id?:unknown;integration?:unknown}|null){
 const native=fact(agent?.agent_session_id,256),provider=launch?.provider;
 return {
  executable:fact(agent?.cli_path),
  nativeSession:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(native)&&native!=='Unknown'?native:'Unknown',
  effectiveModel:launch?.adapter==='pi'?'Reported in Pi routing status':'Not confirmed by the CLI',
  reasoning:launch?.adapter==='pi'?'Reported in Pi routing status':launch?.adapter&&['codex','claude','gemini','opencode'].includes(launch.adapter)?'Resolved by the official CLI from its arguments and configuration':'Unknown',
  credentialSource:launch?.adapter==='pi'?'Resolved by Pi for this session connection':provider==null&&launch?.adapter?'Inherited CLI authentication':isProviderConfig(provider)?provider.api_key_env??'Local gateway placeholder':'Unknown',
  hooks:agent?.integration==='connected'?'Trusted callback received':agent?.integration==='connecting'?'Waiting for a trusted callback':'Trusted hook integration unavailable',
 };
}
