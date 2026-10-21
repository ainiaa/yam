// Author: Jeff.Liu. Global terminal spacing, independent of profiles and font settings.
export type TerminalLineHeight={lineHeight:number};
export const defaultTerminalLineHeight:TerminalLineHeight=Object.freeze({lineHeight:1.35});
const KEY="yam.terminalLineHeight.v1",INVALID="Invalid terminal line height.";
const DECIMAL=/^(?:1(?:\.\d{1,2})?|2(?:\.0{1,2})?)$/;
export function parseTerminalLineHeight(text:string):TerminalLineHeight{if(typeof text!=="string"||!DECIMAL.test(text))throw Error(INVALID);return {lineHeight:Number(text)};}
function checked(value:unknown):TerminalLineHeight{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error(INVALID);
 const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value),field=Object.getOwnPropertyDescriptor(value,"lineHeight");
 if((prototype!==Object.prototype&&prototype!==null)||keys.length!==1||keys[0]!=="lineHeight"||!field||!Object.prototype.hasOwnProperty.call(field,"value")||typeof field.value!=="number"||!Number.isFinite(field.value)||!DECIMAL.test(String(field.value)))throw Error(INVALID);
 return {lineHeight:field.value};
}
export function decodeTerminalLineHeight(raw:string|null):TerminalLineHeight{if(raw===null)return {...defaultTerminalLineHeight};try{if(typeof raw!=="string"||new TextEncoder().encode(raw).length>256)throw Error();return checked(JSON.parse(raw));}catch{throw Error(INVALID);}}
export function loadTerminalLineHeight(read:()=>string|null):{lineHeight:TerminalLineHeight;error:string|null}{try{return {lineHeight:decodeTerminalLineHeight(read()),error:null};}catch{return {lineHeight:{...defaultTerminalLineHeight},error:"Could not load terminal line height. Saved data was preserved."};}}
export function saveTerminalLineHeight(write:(key:string,raw:string)=>void,value:TerminalLineHeight){const next=checked(value);try{write(KEY,JSON.stringify(next));}catch{throw Error("Could not save terminal line height.");}}
export function terminalLineHeightOptions(value:TerminalLineHeight){return checked(value);}
