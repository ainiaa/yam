// Author: Jeff.Liu. Desktop lifecycle only; Provider routing owns model selection.
import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {isAbsolute,dirname,resolve} from 'node:path';
export function desktopLaunch(env){
 if(env.YAM_OMP_DESKTOP!=='1')return null;
 const dir=env.YAM_OMP_SESSION_DIR,resume=env.YAM_OMP_RESUME;
 if(!dir||!isAbsolute(dir)||resume&&(!isAbsolute(resume)||dirname(resolve(resume))!==resolve(dir)))throw Error('Invalid managed OMP session directory');
 return {policy:env.YAM_OMP_POLICY||undefined,args:['--session-dir',dir,...resume?['--resume',resume]:[]]};
}
async function send(event){
 const address=process.env.YAM_AGENT_ADDRESS,token=process.env.YAM_AGENT_TOKEN;
 if(!/^127\.0\.0\.1:\d+$/.test(address??'')||!/^[a-f0-9]{64}$/.test(token??''))throw Error('Desktop event connection is unavailable');
 const [host,port]=address.split(':');
 await new Promise((resolve,reject)=>{
  const socket=connect({host,port:Number(port)}),chunks=[];socket.setTimeout(1000,()=>socket.destroy(Error('Desktop event timeout')));socket.on('error',reject);
  socket.on('data',b=>{chunks.push(b);if(Buffer.concat(chunks).length>128)socket.destroy(Error('Invalid desktop acknowledgement'));});
  socket.on('end',()=>{try{if(JSON.parse(Buffer.concat(chunks).toString()).accepted!==true)throw Error('Desktop event rejected');resolve();}catch(e){reject(e);}});
  socket.on('connect',()=>socket.end(JSON.stringify({version:1,token,run:process.env.YAM_AGENT_RUN,event})+'\n'));
 });
}
export function installDesktopBridge(pi,{send:deliver=send}={}){
 let native,turn;
 for(const event of ['session_before_switch','session_before_branch'])pi.on(event,(_e,ctx)=>{
  if(!native)return;
  try{ctx.ui?.notify?.('请在 YAM 中新建或继续会话，以保留原生会话身份。','warning');}catch{}
  return {cancel:true};
 });
 const emit=(kind,ctx)=>deliver({kind,agent_session_id:native??ctx.sessionManager.getSessionId(),turn_id:turn??null}).catch(()=>ctx.ui?.setStatus('yam-desktop','YAM 会话状态连接不可用'));
 pi.on('session_start',(_e,ctx)=>{native=ctx.sessionManager.getSessionId();turn=undefined;return emit('SessionStart',ctx);});
 pi.on('agent_start',(_e,ctx)=>{turn=randomUUID();return emit('UserPromptSubmit',ctx);});
 pi.on('tool_execution_end',(_e,ctx)=>emit('ToolProgress',ctx));
 pi.on('agent_end',(e,ctx)=>{const last=e.messages?.filter(m=>m.role==='assistant').at(-1);return emit(last?.stopReason==='aborted'?'Interrupt':last?.stopReason==='error'?'TurnFailed':'TurnComplete',ctx);});
}
