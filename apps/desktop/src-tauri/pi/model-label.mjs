// Author: Jeff.Liu. Shared by the desktop model picker and the Pi extension.
export const zhModelLabels={
 'Pi native':'Pi 原生',
 'Codex native':'Codex 原生',
 'Local gateway':'本地网关',
 'ChatGPT subscription':'ChatGPT 订阅',
 'Automatic routing':'自动路由',
 'Model not recorded':'模型未记录',
 'Reasoning unconfirmed':'推理尚未确认',
};

export function piModelCatalogSource(key){
 return key.startsWith('magpie/')?'magpie-pi':key.startsWith('yam-gateway/')?'magpie-direct':'pi';
}

export function modelPresentation(key,model,connections,t){
 const provider=key.split('/',1)[0],id=key.slice(key.indexOf('/')+1),catalog=piModelCatalogSource(key);
 const connection=connections&&Object.prototype.hasOwnProperty.call(connections,provider)?connections[provider]:null;
 const gateway=connection?'gateway' in connection:!connections&&catalog!=='pi';
 const magpie=model?.source==='magpie'||!connections&&catalog==='magpie-pi';
 const source=t(gateway?magpie?'Magpie':'Local gateway':connections?connection&&'native' in connection?'Codex native':'Codex':'Pi native');
 let modelId=id,supplier='';
 if(gateway){
  const separator=id.indexOf('/');
  if(separator>0){
   const route=id.slice(0,separator);
   supplier=route==='auto'?t('Automatic routing'):route==='codex'?'Codex':route;
   modelId=id.slice(separator+1);
  }
 }else if(connection?.billing==='subscription'||!connections&&(model?.source==='chatgpt-subscription'||model?.legacy_alias||provider==='openai-codex'||provider==='yam-codex'&&model?.billing!=='api')){
  supplier=t('ChatGPT subscription');
 }else if(connection?.billing==='paid'){
  try{supplier=new URL(connection.baseUrl??'').hostname;}catch{supplier=t('API');}
 }else if(!connections){
  supplier=provider==='openai'?'OpenAI':['yam-codex','yam-gateway'].includes(provider)?model?.billing==='api'?t('API'):'':provider;
 }
 return {source,label:[source,supplier,modelId].filter(Boolean).join(' · ')};
}
