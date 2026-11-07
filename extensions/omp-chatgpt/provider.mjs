// Author: Jeff.Liu
export const PROVIDER = 'yam-chatgpt';
const BASE_URL = 'https://api.openai.com/v1';
const API = 'yam-chatgpt-responses';
const EFFORTS = new Set(['minimal','low','medium','high','xhigh','max']);

export function validateCredential(c) {
  if (c?.type !== 'oauth' || typeof c.access !== 'string' || !c.access ||
      typeof c.clientId !== 'string' || !c.clientId ||
      !Array.isArray(c.scopes) || !c.scopes.includes('chatgpt.tokens.use.direct') ||
      !Number.isFinite(c.expires) || c.expires <= Date.now()) {
    throw Error('ChatGPT subscription login is missing or expired; sign in through Pi.');
  }
  return c;
}

export function catalogModels(data) {
  if (!Array.isArray(data?.models)) throw Error('Invalid ChatGPT model catalog.');
  const seen = new Set();
  const models = data.models.filter(m => m?.visibility === 'list').map(m => {
    if (typeof m.slug !== 'string' || !/^[\w][\w.:-]{0,127}$/.test(m.slug) || seen.has(m.slug) ||
        !Number.isSafeInteger(m.context_window) || m.context_window <= 0) throw Error('Invalid ChatGPT model catalog.');
    seen.add(m.slug);
    const efforts = (m.supported_reasoning_levels ?? []).map(x => x.effort).filter(x => EFFORTS.has(x));
    return {
      id: m.slug, name: m.display_name || m.slug, reasoning: efforts.length > 0,
      ...(efforts.length ? {thinking:{mode:'effort',efforts}} : {}),
      input: m.input_modalities?.includes('image') ? ['text','image'] : ['text'],
      contextWindow: m.context_window, maxTokens: Math.min(16384,m.context_window),
      // Subscription cost is not a cash estimate; use reported usage and plan limits.
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
    };
  });
  if (!models.length) throw Error('Empty ChatGPT model catalog.');
  return models;
}

function failure(model, signal, cause, partial) {
  const aborted = signal?.aborted || cause?.name === 'AbortError';
  const known = String(cause?.message ?? '').match(/subscription_sharing_usage_(?:limit_exceeded|unavailable)|\b(?:401|403|429)\b/);
  return {type:'error',reason:aborted?'aborted':'error',error:{
    role:'assistant',content:partial?.content??[],api:API,provider:PROVIDER,model:model.id,
    usage:partial?.usage??{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    stopReason:aborted?'aborted':'error',timestamp:Date.now(),
    errorMessage:aborted?'ChatGPT request cancelled.':`ChatGPT request failed${known?` (${known[0]})`:''}; no API-key fallback.`,
  }};
}

async function abortable(promise,signal) {
  if(!signal)return promise;
  let cancel;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      cancel=()=>reject(signal.reason);
      signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted)cancel();
    })]);
  }finally{signal.removeEventListener('abort',cancel);}
}

export function createChatgptProvider({readCredential,fetch:fetchRequest,stream,createStream,buildModel}) {
  let cache;
  async function catalog(c, signal) {
    signal?.throwIfAborted();
    // Cache only within one process and one access token; account changes must rediscover.
    if (!cache || cache.token !== c.access || Date.now()-cache.time > 60000) {
      const entry={token:c.access,time:Date.now()};
      entry.promise=(async()=>{
        const r=await fetchRequest(`${BASE_URL}/models`,{
          headers:{Authorization:`Bearer ${c.access}`},redirect:'error',signal:AbortSignal.timeout(15000),
        });
        if (!r.ok) throw Error(`ChatGPT catalog HTTP ${r.status}.`);
        return catalogModels(await r.json());
      })();
      cache=entry;
      void entry.promise.catch(()=>{if(cache===entry)cache=undefined;});
    }
    const models=await abortable(cache.promise,signal);
    signal?.throwIfAborted();
    return models;
  }
  return {
    async models(){const c=validateCredential(await readCredential());return catalog(c);},
    stream(model,context,options={}) {
      const output=createStream();
      void (async()=>{
        try {
          options.signal?.throwIfAborted();
          const c=validateCredential(await abortable(readCredential(options.signal),options.signal));
          const models=await catalog(c,options.signal);
          const available=models.find(m=>m.id===model.id);
          if (!available || (options.reasoning && !available.thinking?.efforts.includes(options.reasoning))) throw Error('ChatGPT model or effort unavailable.');
          const guardedFetch=async(input,init)=>{
            const request=new Request(input,init);
            if (request.url!==`${BASE_URL}/responses` || request.method!=='POST') throw Error('ChatGPT endpoint rejected.');
            const body=JSON.parse(await request.text());
            if(body.model!==model.id)throw Error('ChatGPT model rejected.');
            body.store=false;body.stream=true;delete body.previous_response_id;
            const headers=new Headers(request.headers);
            headers.set('Authorization',`Bearer ${c.access}`);
            headers.delete('OpenAI-Project');headers.delete('OpenAI-Organization');
            return fetchRequest(request.url,{
              method:'POST',headers,body:JSON.stringify(body),redirect:'error',
              signal:AbortSignal.any([request.signal,AbortSignal.timeout(180000)]),
            });
          };
          const inner=stream(buildModel({...available,provider:PROVIDER,api:'openai-responses',baseUrl:BASE_URL,headers:{},requestModelId:model.id}),context,{
            ...options,apiKey:c.access,headers:{},fetch:guardedFetch,preferWebsockets:false,
            statefulResponses:false,storeResponses:false,includeEncryptedReasoning:true,
            extraBody:undefined,onPayload:undefined,
          });
          let terminal=false;
          for await(const event of inner) {
            if(event.type==='error'){
              output.push(failure(model,options.signal,new Error(event.error?.errorMessage),event.error));
              terminal=true;break;
            }
            if(event.type==='done'){
              if(!['stop','toolUse'].includes(event.reason)){
                output.push(failure(model,options.signal,new Error('ChatGPT response incomplete.'),event.message));
                terminal=true;break;
              }
              terminal=true;
            }
            output.push(event);
          }
          if(!terminal)throw Error('ChatGPT stream ended without completion.');
        } catch(e){output.push(failure(model,options.signal,e));}
        finally{output.end();}
      })();
      return output;
    },
  };
}
