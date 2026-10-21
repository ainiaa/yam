import type {ShellLaunch} from "./shell-launch";
const KEY="yam.zsh-directory-reporting.v1";
export function loadZshDirectoryReporting(read:()=>string|null):{enabled:boolean;error:string|null}{
 try{const raw=read();if(raw===null)return{enabled:false,error:null};const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="enabled,version"||(value as {version:unknown}).version!==1||typeof(value as {enabled:unknown}).enabled!=="boolean")throw Error();return{enabled:(value as {enabled:boolean}).enabled,error:null};}catch{return{enabled:false,error:"Could not load Zsh directory reporting settings."};}
}
export function saveZshDirectoryReporting(write:(key:string,value:string)=>void,enabled:boolean){if(typeof enabled!=="boolean")throw Error("Invalid Zsh directory reporting settings.");try{write(KEY,JSON.stringify({version:1,enabled}));}catch{throw Error("Could not save Zsh directory reporting settings.");}}
export function zshDirectoryReportingEligible(enabled:boolean,shell:ShellLaunch|null|undefined,windows:boolean):boolean{return enabled&&!windows&&(shell?.program==null||(shell.program.startsWith("/")&&shell.program.split("/").pop()==="zsh"));}
