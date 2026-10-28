// Author: Jeff.Liu. Personal preference for future ordinary terminals; parser frames remain authoritative.
export type TerminalRetention={version:1;retainedLines:number};
export const defaultTerminalRetention:TerminalRetention=Object.freeze({version:1,retainedLines:2000});
const INVALID="Invalid terminal retention.";
function checked(value:unknown):TerminalRetention{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error(INVALID);
 const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);if((prototype!==Object.prototype&&prototype!==null)||keys.length!==2||!keys.every(key=>key==="version"||key==="retainedLines"))throw Error(INVALID);
 const version=Object.getOwnPropertyDescriptor(value,"version"),lines=Object.getOwnPropertyDescriptor(value,"retainedLines");if(!version||!lines||!version.enumerable||!lines.enumerable||!("value" in version)||!("value" in lines)||version.value!==1||!Number.isSafeInteger(lines.value)||lines.value<200||lines.value>2000)throw Error(INVALID);
 return {version:1,retainedLines:lines.value};
}
export function decodeTerminalRetention(raw:string|null):TerminalRetention{
 if(raw===null)return {...defaultTerminalRetention};
 try{if(typeof raw!=="string"||new TextEncoder().encode(raw).length>256)throw Error();return checked(JSON.parse(raw));}catch{throw Error(INVALID);}
}
export function loadTerminalRetention(read:()=>string|null):{retention:TerminalRetention;error:string|null}{try{return {retention:decodeTerminalRetention(read()),error:null};}catch{return {retention:{...defaultTerminalRetention},error:"Could not load terminal retention. Saved data was preserved."};}}
export function saveTerminalRetention(write:(key:string,raw:string)=>void,value:TerminalRetention){const next=checked(value);try{write("yam.terminalRetention.v1",JSON.stringify(next));}catch{throw Error("Could not save terminal retention.");}}
