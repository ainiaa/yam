// Author: Jeff.Liu. Source-language keys preserve diagnostics and stable action IDs.
import i18next from 'i18next';
import {initReactI18next} from 'react-i18next';
import {zh} from './translations.zh.ts';
export const i18n=i18next.createInstance();
void i18n.use(initReactI18next).init({lng:'en',fallbackLng:'en',initAsync:false,resources:{en:{translation:{}},'zh-CN':{translation:zh}},keySeparator:false,nsSeparator:false,interpolation:{escapeValue:false},returnEmptyString:false,react:{useSuspense:false}});
// Legacy error state contains formatted text. Match only reviewed single-value UI templates.
const formattedMessages=Object.keys(zh).flatMap(key=>{
 const match=key.match(/^(.*?)\{\{(value\d+)\}\}(.*?)$/s);
 return match&&!match[1].includes('{{')&&!match[3].includes('{{')&&match[1].length+match[3].length>=8?[{key,prefix:match[1],parameter:match[2],suffix:match[3]}]:[];
}).sort((a,b)=>(b.prefix.length+b.suffix.length)-(a.prefix.length+a.suffix.length));
export function t(source:string,values?:Record<string,unknown>):string{
 if(typeof source!=="string")return "";
 const key=source.startsWith("Error: ")?source.slice(7):source;
 if(i18n.exists(key))return i18n.t(key,{...values,defaultValue:source});
 if(!values)for(const candidate of key===source?[source]:[source,key])for(const template of formattedMessages){
  if(candidate.startsWith(template.prefix)&&candidate.endsWith(template.suffix)&&candidate.length>=template.prefix.length+template.suffix.length&&i18n.exists(template.key)){
   const value=candidate.slice(template.prefix.length,template.suffix.length?candidate.length-template.suffix.length:undefined);
   return i18n.t(template.key,{[template.parameter]:value,defaultValue:source});
  }
 }
 return i18n.t(source,{...values,defaultValue:source});
}
export function setLocale(locale:'en'|'zh-CN'){if(typeof document!=='undefined')document.documentElement.lang=locale;if(i18n.language!==locale)void i18n.changeLanguage(locale);}
export function formatDate(value:number|Date,options?:Intl.DateTimeFormatOptions):string{return new Intl.DateTimeFormat(i18n.language,options).format(value);}
