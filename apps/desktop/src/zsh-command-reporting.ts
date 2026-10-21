// Author: Jeff.Liu
import type {ShellLaunch} from "./shell-launch";
const KEY="yam.zsh-command-reporting.v1";
export function loadZshCommandReporting(read:()=>string|null):{enabled:boolean;error:string|null}{
 try{const raw=read();if(raw===null)return{enabled:false,error:null};const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="enabled,version"||(value as {version:unknown}).version!==1||typeof(value as {enabled:unknown}).enabled!=="boolean")throw Error();return{enabled:(value as {enabled:boolean}).enabled,error:null};}catch{return{enabled:false,error:"Could not load Zsh command reporting settings."};}
}
export function saveZshCommandReporting(write:(key:string,value:string)=>void,enabled:boolean){if(typeof enabled!=="boolean")throw Error("Invalid Zsh command reporting settings.");try{write(KEY,JSON.stringify({version:1,enabled}));}catch{throw Error("Could not save Zsh command reporting settings.");}}
export function zshCommandReportingEligible(enabled:boolean,shell:ShellLaunch|null|undefined,windows:boolean):boolean{return enabled&&!windows&&(shell?.program==null||(shell.program.startsWith("/")&&shell.program.split("/").pop()==="zsh"));}
