// Author: Jeff.Liu. Typed metadata only; never reads SSH configuration or keys.
import {isTerminalSettings,type TerminalSettings} from './terminal-settings.ts';
export type SshLaunch={host:string;user:string|null;port:number|null};
function name(value:unknown,max:number):value is string{return typeof value==="string"&&value.length>=1&&value.length<=max&&/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);}
function isIpv6Host(value:unknown):value is string{
 if(typeof value!=="string"||value.length<1||value.length>253||!value.includes(':')||!/^[0-9A-Fa-f:.]+$/.test(value))return false;
 try{const parsed=new URL(`http://[${value}]/`);return parsed.hostname.startsWith('[')&&parsed.hostname.endsWith(']');}catch{return false;}
}
export function isSshLaunch(value:unknown):value is SshLaunch{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const keys=Reflect.ownKeys(value);if(keys.length!==3||!keys.every(k=>k==="host"||k==="user"||k==="port"))return false;
 const d=Object.getOwnPropertyDescriptors(value);if(keys.some(k=>typeof k!=="string"||!("value" in d[k])))return false;
 return (name(d.host.value,253)||isIpv6Host(d.host.value))&&(d.user.value===null||name(d.user.value,64))&&(d.port.value===null||(Number.isInteger(d.port.value)&&d.port.value>=1&&d.port.value<=65535));
}
export function parseSshDestination(destination:string,portText:string):SshLaunch{
 const parts=destination.trim().split('@');const text=portText.trim();
 let host=parts[parts.length-1]??'';
 if(host.startsWith('[')&&host.endsWith(']')&&isIpv6Host(host.slice(1,-1)))host=host.slice(1,-1);
 const value={host,user:parts.length===2?parts[0]:null,port:text===''?null:/^[0-9]+$/.test(text)?Number(text):NaN};
 if(parts.length>2||!isSshLaunch(value))throw Error('Enter a supported SSH destination and port (1–65535).');return value;
}
export function sshTitle(value:SshLaunch):string{if(!isSshLaunch(value))throw Error('Invalid SSH connection metadata');return `SSH ${value.user===null?'':value.user+'@'}${value.host.includes(':')?'['+value.host+']':value.host}${value.port===null?'':':'+value.port}`;}
export function snapshotSshSettings(retainedLines:number,appearance:TerminalSettings):{retainedLines:number;initialAppearance:TerminalSettings}{
 if(!Number.isInteger(retainedLines)||retainedLines<200||retainedLines>2000||!isTerminalSettings(appearance))throw Error('Terminal preferences unavailable');
 return {retainedLines,initialAppearance:{fontFamily:appearance.fontFamily,fontSize:appearance.fontSize,theme:appearance.theme}};
}
