// Author: Jeff.Liu. Settings for future ordinary terminals; validation never launches a process.
export type ShellLaunch={program:string|null;login:boolean|null};
const utf8=new TextEncoder();
export function isShellLaunch(value:unknown,windows:boolean):value is ShellLaunch {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==2||!Object.prototype.hasOwnProperty.call(v,"program")||!Object.prototype.hasOwnProperty.call(v,"login")||(windows?v.login!==null:typeof v.login!=="boolean"))return false;
 if(v.program===null)return true;
 if(typeof v.program!=="string"||!v.program.trim()||utf8.encode(v.program).length>4096||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v.program))return false;
 return windows?/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(v.program):v.program.startsWith("/");
}
export function loadShellLaunch(read:()=>string|null,windows:boolean):{shell:ShellLaunch|null;error:string|null} {
 try {
  const raw=read();if(raw===null)return{shell:null,error:null};
  if(utf8.encode(raw).length>16384)throw Error("budget");
  const value:unknown=JSON.parse(raw);
  if(value&&typeof value==="object"&&!Array.isArray(value)) {
   const v=value as Record<string,unknown>;
   if(Object.keys(v).length===2&&v.version===1&&Object.prototype.hasOwnProperty.call(v,"shell")&&(v.shell===null||isShellLaunch(v.shell,windows)))return{shell:v.shell===null?null:{...v.shell},error:null};
  }
 } catch {return{shell:null,error:"Shell preferences unavailable. Using Current default."};}
 return{shell:null,error:"Shell preferences are invalid. Using Current default."};
}
export function saveShellLaunch(shell:ShellLaunch|null,windows:boolean,write:(raw:string)=>void):void {
 if(shell!==null&&!isShellLaunch(shell,windows))throw Error("Invalid shell settings. Use an absolute executable path and a supported login selection.");
 write(JSON.stringify({version:1,shell}));
}
export function shellStartError(reason:unknown):string {
 const message=reason instanceof Error?reason.message:String(reason);
 const errors:Record<string,string>={
  shell_unsupported:"Shell selection supports bash, zsh and fish on Unix, and cmd.exe on Windows. Choose a supported executable or Current default.",
  shell_invalid_combination:"Shell settings apply only to ordinary terminals. Agent, custom command, resume, project and managed worktree launches use their existing settings.",
  shell_invalid:"Invalid shell settings. Use an absolute executable path and the login option supported by your platform.",
  shell_unavailable:"The selected shell is unavailable or is not an executable file. Check its path or choose Current default.",
 };
 return Object.prototype.hasOwnProperty.call(errors,message)?errors[message]:`Shell selection could not be started: ${message.slice(0,600)}. The background owner may not support it. Choose Current default; existing sessions keep running.`;
}
