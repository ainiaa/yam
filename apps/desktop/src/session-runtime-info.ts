// Author: Jeff.Liu. Display recorded facts without parsing native CLI arguments a second time.
import {isProviderConfig} from './provider-config.ts';
const fact=(value:unknown,limit=4096):string=>typeof value==='string'&&value.trim()&&value.length<=limit&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)?value:'Unknown';
export function sessionRuntimeInfo(launch?:{adapter?:string;provider?:unknown;omp?:{auth?:unknown}}|null,agent?:{cli_path?:unknown;agent_session_id?:unknown;integration?:unknown;last_state_at?:unknown}|null,status='unknown',available=true){
 const native=fact(agent?.agent_session_id,256),provider=launch?.provider;
 const stage=!available
  ?{label:'Background connection unavailable',detail:'The current process state cannot be confirmed. Reconnect before deciding whether to start another task.',reconnect:true}
  :['succeeded','failed','stopped','needs_attention'].includes(status)
  ?{label:'Recorded session',detail:'This is recorded output. Continuing a conversation or running again requires an explicit action.',reconnect:false}
  :status==='starting'
  ?{label:'Starting CLI',detail:'The CLI has not yet been confirmed running. Do not submit the launch again.',reconnect:false}
  :status==='running'
  ?{label:agent?.integration==='connected'?'CLI running · trusted callback received':agent?.integration==='connecting'?'CLI running · waiting for a trusted callback':'CLI running · integration unavailable',detail:agent?.integration==='connected'?'A trusted callback was received for this session. It does not verify the current model or upstream connection.':'Check the native terminal for progress. Automatic Agent status is not yet confirmed.',reconnect:false}
  :{label:'Saved launch configuration',detail:'Saved settings do not confirm that a process or upstream connection is running.',reconnect:false};
 return {
  stage,
  lastStateAt:typeof agent?.last_state_at==='number'&&Number.isSafeInteger(agent.last_state_at)&&agent.last_state_at>0&&agent.last_state_at<=253402300799?new Date(agent.last_state_at*1000).toISOString():null,
  executable:fact(agent?.cli_path),
  nativeSession:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(native)&&native!=='Unknown'?native:'Unknown',
  effectiveModel:launch?.adapter==='pi'?'Reported in Pi routing status':'Not confirmed by the CLI',
  reasoning:launch?.adapter==='pi'?'Reported in Pi routing status':launch?.adapter&&['codex','claude','gemini','opencode'].includes(launch.adapter)?'Resolved by the official CLI from its arguments and configuration':'Unknown',
  credentialSource:launch?.adapter==='omp'?(launch.omp?.auth==='yam'?'YAM ChatGPT sign-in':launch.omp?.auth===undefined||launch.omp.auth==='pi'?'Pi sign-in (backup)':'Unknown'):launch?.adapter==='pi'?'Resolved by Pi for this session connection':provider==null&&launch?.adapter?'Inherited CLI authentication':isProviderConfig(provider)?provider.api_key_env??'Local gateway placeholder':'Unknown',
  hooks:!available?'Previous callbacks do not confirm the disconnected background state':agent?.integration==='connected'?'Trusted callback received':agent?.integration==='connecting'?'Waiting for a trusted callback':'Trusted hook integration unavailable',
 };
}
