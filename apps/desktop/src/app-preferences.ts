// Author: Jeff.Liu. Appearance is local UI state, never an Agent launch setting.
export type AppLocale='system'|'zh-CN'|'en';
export type AppTheme='system'|'dark'|'light'|'mocha'|'nord';
export type AppPreferences={language:AppLocale;theme:AppTheme;background:string|null;backgroundStrength:number};
export const APP_PREFERENCES_KEY='yam.appAppearance.v1';
export const defaultAppPreferences:AppPreferences={language:'system',theme:'system',background:null,backgroundStrength:12};
export function resolveLocale(language:AppLocale,languages:readonly string[]):'zh-CN'|'en'{
 if(language!=='system')return language;
 const preferred=languages.find(value=>/^(zh|en)(?:-|$)/i.test(value));return preferred&&/^zh(?:-|$)/i.test(preferred)?'zh-CN':'en';
}
export function isAppPreferences(value:unknown):value is AppPreferences{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===4&&['system','zh-CN','en'].includes(v.language as string)&&['system','dark','light','mocha','nord'].includes(v.theme as string)&&Number.isInteger(v.backgroundStrength)&&Number(v.backgroundStrength)>=0&&Number(v.backgroundStrength)<=30&&(v.background===null||typeof v.background==='string'&&v.background.length<=700000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.background)&&v.background.slice(v.background.indexOf(",")+1).length%4===0);
}
export function loadAppPreferences(read:()=>string|null):{value:AppPreferences;error:string|null}{
 try{const raw=read();if(raw===null)return{value:{...defaultAppPreferences},error:null};const value:unknown=JSON.parse(raw);if(isAppPreferences(value))return{value:{...value},error:null};}catch{/* Report a safe fallback without replacing the stored value. */}
 return{value:{...defaultAppPreferences},error:'Language and appearance settings are unavailable. Using defaults.'};
}
export function saveAppPreferences(value:AppPreferences,write:(raw:string)=>void){if(!isAppPreferences(value))throw Error('Invalid language or appearance settings');write(JSON.stringify(value));}
