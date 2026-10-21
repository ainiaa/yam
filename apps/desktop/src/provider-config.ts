// Author: Jeff.Liu. Connection snapshots contain references, never resolved credentials.
export type ProviderConfig={id:"codex"|"claude"|"gemini"|"deepseek"|"custom";model:string;base_url:string;api_key_env:string|null};
const keys=["id","model","base_url","api_key_env"];
export function isProviderConfig(value:unknown):value is ProviderConfig {
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const own=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
 if(own.length!==keys.length||!keys.every(key=>own.includes(key)&&descriptors[key].enumerable&&Object.prototype.hasOwnProperty.call(descriptors[key],"value")))return false;
 const v=value as ProviderConfig;
 if(!["codex","claude","gemini","deepseek","custom"].includes(v.id)||typeof v.model!=="string"||!v.model||v.model!==v.model.trim()||v.model.length>256||/[\s\u0000-\u001f\u007f]/.test(v.model))return false;
 if(typeof v.base_url!=="string"||v.base_url.length>2048||v.base_url!==v.base_url.trim()||/[\u0000-\u0020\u007f]/.test(v.base_url))return false;
 let url:URL;try{url=new URL(v.base_url);}catch{return false;}
 const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
 if(!url.hostname||url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||local&&url.protocol==="http:"))return false;
 return v.api_key_env===null?local:typeof v.api_key_env==="string"&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v.api_key_env)&&!v.api_key_env.toUpperCase().startsWith("YAM_");
}
export function copyProviderConfig(value:ProviderConfig):ProviderConfig {
 return{id:value.id,model:value.model,base_url:value.base_url,api_key_env:value.api_key_env};
}

export function supportsProvider(adapter:string,provider:ProviderConfig):boolean {return provider.id==="custom"?["codex","claude","gemini"].includes(adapter):provider.id==="gemini"?["gemini","claude"].includes(adapter):provider.id==="deepseek"?["codex","claude"].includes(adapter):adapter===provider.id;}

export function providerPreset(choice:string,adapter="codex"):{adapter:string;provider:ProviderConfig|null} {
 if(["codex","claude","gemini"].includes(choice))return{adapter:choice,provider:null};
 if(choice==="cc-switch")return{adapter,provider:{id:"custom",model:"",base_url:`http://127.0.0.1:15721${adapter==="codex"?"/v1":""}`,api_key_env:null}};
 if(choice==="echobird")return{adapter,provider:{id:"custom",model:"",base_url:`http://127.0.0.1:53683${adapter==="codex"?"/v1":""}`,api_key_env:null}};
 if(choice==="native")return{adapter:"shell",provider:null};
 if(choice==="deepseek")return{adapter:"codex",provider:{id:"deepseek",model:"deepseek-flash",base_url:"https://api.deepseek.com",api_key_env:"DEEPSEEK_API_KEY"}};
 if(choice==="deepseek-claude")return{adapter:"claude",provider:{id:"deepseek",model:"deepseek-flash",base_url:"https://api.deepseek.com/anthropic",api_key_env:"DEEPSEEK_API_KEY"}};
 if(choice==="claude-api")return{adapter:"claude",provider:{id:"claude",model:"sonnet",base_url:"https://api.anthropic.com",api_key_env:"ANTHROPIC_API_KEY"}};
 if(choice==="gemini-api")return{adapter:"gemini",provider:{id:"gemini",model:"gemini-3-flash-preview",base_url:"https://generativelanguage.googleapis.com",api_key_env:"GEMINI_API_KEY"}};
 if(choice==="gemini-claude")return{adapter:"claude",provider:{id:"gemini",model:"gemini/gemini-3-flash-preview",base_url:"http://127.0.0.1:3425",api_key_env:null}};
 return{adapter:"codex",provider:{id:"custom",model:"provider/model",base_url:"http://127.0.0.1:3425",api_key_env:null}};
}
export function providerChoice(adapter:string,provider?:ProviderConfig|null):string {
 if(!provider)return ["codex","claude","gemini"].includes(adapter)?adapter:"native";
 if(provider.id==="custom"){
  if(provider.base_url===`http://127.0.0.1:15721${adapter==="codex"?"/v1":""}`)return "cc-switch";
  if(["codex","claude"].includes(adapter)&&provider.base_url===`http://127.0.0.1:53683${adapter==="codex"?"/v1":""}`)return "echobird";
 }
 return provider.id==="deepseek"?(adapter==="claude"?"deepseek-claude":"deepseek"):provider.id==="claude"?"claude-api":provider.id==="gemini"?(adapter==="claude"?"gemini-claude":"gemini-api"):"custom";
}

export function connectionDetails(launch?:{adapter?:string;provider?:unknown}|null):{cli:string;source:string;model:string;endpoint:string} {
 const cli=typeof launch?.adapter==="string"&&launch.adapter.trim()?launch.adapter:"Unknown",provider=launch?.provider,managed=isProviderConfig(provider);
 let endpoint="Unknown";
 // Legacy history can predate endpoint validation; never render its credential components.
 const raw=provider&&typeof provider==="object"?Object.getOwnPropertyDescriptor(provider,"base_url")?.value:undefined;
 if(typeof raw==="string"&&raw.length<=2048)try{
  const url=new URL(raw);
  if(["http:","https:"].includes(url.protocol)&&url.hostname){url.username="";url.password="";url.search="";url.hash="";endpoint=url.href;}
 }catch{}
 return {cli,source:!launch||cli==="Unknown"?"Unknown (no saved CLI metadata)":provider==null?"Inherited CLI configuration":managed?"YAM isolated API configuration":"Unknown (incomplete saved connection)",model:managed?provider.model:"Unknown",endpoint};
}
