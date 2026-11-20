// Author: Jeff.Liu
import {createHash} from 'node:crypto';
import {classifierPrompt,classifyCandidates,classifyWithRules,routeFacts,selectExecutionRule,orderedExecutionCandidates,needsWorkflowClassification} from '../../apps/desktop/src-tauri/pi/task-rules.mjs';
import {gateway,levels} from './routing-policy.mjs';
export {readRoutingPolicy} from './routing-policy.mjs';

const receiptType='yam.omp.route.v1';
const billing=model=>model?.provider==='yam-chatgpt'?'subscription':model?.provider==='yam-magpie'?'gateway':null;
const keyBilling=k=>k?.startsWith('yam-chatgpt/')?'subscription':k?.startsWith('yam-magpie/')?'gateway':null;
const text=message=>typeof message?.content==='string'?message.content:(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');
const identity=model=>model.provider+'/'+model.id;
export function launcherArgs(argv,{defaultRouting=true,resuming=false,defaultAuth='yam'}={}){
 const args=[];let policyPath,explicit=false,authSource=defaultAuth,authExplicit=false,login=false;
 if(!['yam','pi'].includes(authSource))throw Error('Invalid OMP authentication source');
 const takesValue=new Set(['--system-prompt','--system-prompt-template','--append-system-prompt','--config','--cwd','--add-dir','--mode','--session-dir','--goal','--export','--alias','--models','--thinking','--service-tier','--tools','--skills','--smol','--slow','--plan','--prewalk-into','--plan-yolo-into','--max-time','--max-cost','--warn-cost','--spinner-interval','--max-fps','--motion','--approval-mode']);
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--'){args.push(...argv.slice(i));break;}
  if(/^--(?:profile|api-key|extension|hook|plugin-dir|provider)(?:=|$)/.test(a)||a==='-e')throw Error('This launcher owns the profile, extension and authentication');
  if(a==='--yam-auth'||a.startsWith('--yam-auth=')){
   const source=a.includes('=')?a.slice(a.indexOf('=')+1):argv[++i];
   if(authExplicit||!['yam','pi'].includes(source))throw Error('Choose --yam-auth yam or pi once');
   authSource=source;authExplicit=true;
  }else if(a==='--yam-login'){login=true;
  }else if(a==='--yam-policy'||a.startsWith('--yam-policy=')){
   const path=a.includes('=')?a.slice(a.indexOf('=')+1):argv[++i];
   if(policyPath||!path||path.startsWith('-'))throw Error('Use --yam-policy <exported-policy.json> once');
   policyPath=path;
  }else{
   args.push(a);
   if(a==='--model'||a==='-m'||a.startsWith('--model='))explicit=true;
   if(['--resume','-r','--restore'].includes(a)){
    if(argv[i+1]&&!argv[i+1].startsWith('-'))args.push(argv[++i]);
   }else if(a==='--model'||a==='-m'||takesValue.has(a)){
    if(i+1>=argv.length)throw Error('Missing option value');
    args.push(argv[++i]);
   }
  }
 }
 if(policyPath&&explicit)throw Error('Choose a routing policy or a native --model, not both');
 const routing=!explicit&&(defaultRouting||!!policyPath);
 if(!explicit&&(routing||!resuming))args.unshift('--model',routing?'yam/auto':'yam-chatgpt/gpt-6-luna');
 return {args,policyPath,routing,authSource,login};
}

export function magpieModels(data,endpoint,buildModel){
 gateway(endpoint);
 const rows=data?.data;
 if(!Array.isArray(rows))throw Error('Invalid Magpie model catalog');
 const seen=new Set();
 const result=rows.filter(m=>typeof m?.id==='string'&&!/^(?:codex|openai-codex|chatgpt)\//i.test(m.id)).map(m=>{
  if(!m.id||m.id.length>450||/[\s\p{Cc}]/u.test(m.id)||seen.has(m.id)||!Number.isSafeInteger(m.context_window)||m.context_window<=0||!Number.isSafeInteger(m.max_output_tokens)||m.max_output_tokens<=0)throw Error('Invalid Magpie model catalog');
  seen.add(m.id);
  const api=m.native_endpoints?.includes('/v1/messages')?'anthropic-messages':'openai-completions';
  const efforts=(m.reasoning_levels??[]).filter(e=>levels.includes(e)&&e!=='off');
  const cost=Object.fromEntries([['input','prompt'],['output','completion'],['cacheRead','input_cache_read'],['cacheWrite','input_cache_write']].map(([k,v])=>{const n=Number(m.pricing?.[v]??0);if(!Number.isFinite(n)||n<0)throw Error('Invalid Magpie pricing');return [k,n*1e6];}));
  return buildModel({provider:'yam-magpie',id:m.id,name:m.display_name??m.id,api,baseUrl:endpoint+'/v1',reasoning:m.reasoning===true,...m.reasoning?{thinking:{mode:api==='anthropic-messages'?'anthropic-adaptive':'effort',efforts}}:{},input:m.modalities?.input?.includes('image')?['text','image']:['text'],contextWindow:m.context_window,maxTokens:m.max_output_tokens,cost});
 });
 if(!result.length)throw Error('Magpie has no compatible text models');
 return result;
}

export function installRouting(pi,policy,{models,createStream,run,delegate}){
 for(const name of ['registerProvider','appendEntry','on','registerCommand'])if(typeof pi[name]!=='function')throw Error('OMP routing requires '+name);
 const lookup=k=>models.find(m=>identity(m)===k);
 const keys=tier=>[policy[tier],...(policy.executionFallbacks[tier]??[])].filter(Boolean);
 const executions=[...new Set([...(policy.model==='auto'?['small',...(policy.medium?['medium']:[]),'strong'].flatMap(keys):[policy.model])])].map(lookup).filter(Boolean);
 if(!executions.length)throw Error('Routing execution models unavailable');
 let context,previous=null,generation=0,activeKey=null;
 const receipts=new Map();
 const status=value=>context?.ui.setStatus('yam-route',value);
 const restore=(_e,ctx)=>{
  context=ctx;generation++;receipts.clear();previous=null;activeKey=null;
  for(const entry of ctx.sessionManager.getBranch())if(entry.type==='custom'&&entry.customType===receiptType){
   const r=entry.data;
   if(r?.policy!==JSON.stringify(policy)||typeof r.key!=='string'||!/^[a-f0-9]{64}$/.test(r.key)||!executions.some(m=>identity(m)===r.model)||!levels.includes(r.effort)||!['small','medium','strong'].includes(r.tier))continue;
   receipts.set(r.key,r);previous={v:policy.rules.v,model:r.tier,effort:r.effort};
  }
  status('自动路由 · 等待任务 · 费用以实际连接为准');
 };
 for(const event of ['session_start','session_tree','session_switch','session_branch'])pi.on(event,restore);
 pi.registerCommand('yam-route',{description:'查看实际路由模型与推理强度',handler:async()=>context?.ui.notify(receipts.size?JSON.stringify([...receipts.values()].at(-1),null,2):'自动路由尚未执行任务','info')});
 pi.registerProvider('yam',{baseUrl:'https://routing.invalid',apiKey:'routing-managed',api:'yam-omp-routing',models:[{id:'auto',name:'YAM 自动路由',reasoning:true,thinking:{mode:'effort',efforts:levels.filter(x=>x!=='off')},input:executions.every(m=>m.input?.includes('image'))?['text','image']:['text'],contextWindow:Math.min(...executions.map(m=>m.contextWindow)),maxTokens:Math.min(...executions.map(m=>m.maxTokens)),cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(_model,ctx,options={}){
  const out=createStream();let chosen,receipt,token,partial;
  void(async()=>{
   try{
    options.signal?.throwIfAborted();
    if(!context)throw Error('Routing session is not initialized');
    const epoch=generation,user=ctx.messages.filter(m=>m.role==='user').at(-1);
    if(!user)throw Error('Routing requires user context');
    const requestKey=createHash('sha256').update(JSON.stringify([options.sessionId,user.timestamp,user.content])).digest('hex');
    token=requestKey;activeKey=requestKey;
    const check=()=>{options.signal?.throwIfAborted();if(epoch!==generation)throw Error('Routing session changed');};
    for(const tier of policy.model==='auto'?['small',...(policy.medium?['medium']:[]),'strong']:[])if(!keys(tier).some(k=>lookup(k)))throw Error('Configured execution tier is unavailable');
    const images=ctx.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='image'));
    receipt=receipts.get(requestKey);
    if(!receipt){
     let classified,decision,execution;
     if(policy.model!=='auto'&&policy.effort!=='auto'&&!needsWorkflowClassification(policy.rules,context.cwd)){
      classified={source:'fixed'};decision={rule:'fixed'};execution={selection:{model:policy.rules.fallback.model,effort:policy.effort},workflow:'single'};
     }else{
     status('自动路由 · 正在分类');
     const prompt=text(user),recent=ctx.messages.slice(-6).map(m=>({role:m.role,content:text(m).slice(0,1200)})),truncated=prompt.length>16000||ctx.messages.length>6;
     classified=await classifyWithRules({rules:policy.rules,prompt,firstTextTurn:!previous,signal:options.signal},task=>classifyCandidates({keys:[policy.classifier,...policy.classifierFallbacks],channel:policy.classifierBilling??keyBilling(policy.classifier),rules:policy.rules,requestSignal:options.signal,classificationBudget:45000,maxAttemptBudget:45000,
      resolve(k){const m=lookup(k);return m?{model:m,billing:billing(m),identity:k}:null;},
      run(candidate,signal){return run(candidate.model,{systemPrompt:classifierPrompt(policy.rules,task),messages:[{role:'user',content:JSON.stringify({request:prompt.slice(0,16000),recent,truncated,images}),timestamp:Date.now()}]},{signal,maxTokens:768,reasoning:policy.classifierEffort??'medium',toolChoice:'none'});},
      readResult(r){return r.stopReason==='stop'?{text:text(r)}:{status:'provider-error'};}
     }));
     check();if(!classified.answer)throw Error('Task classification unavailable; no execution was started');
     if(prompt.length>16000)classified.answer={...classified.answer,uncertain:true};
     decision=routeFacts(classified.answer,policy.rules,previous);
     execution=selectExecutionRule(policy.rules,classified.answer,decision.selection,{cwd:context.cwd,modelLocked:policy.model!=='auto',effortLocked:policy.effort!=='auto',continuing:classified.answer.intent==='continue',configuredKeys:keys});
     }
     if(execution.workflow!=='single')throw Error('This collaboration workflow requires Pi');
     const tier=execution.selection.model,candidates=policy.model!=='auto'?[policy.model]:execution.modelKey?[execution.modelKey]:keys(tier),channel=keyBilling(candidates[0]);
     const effort=policy.effort==='auto'?execution.selection.effort:policy.effort;
     chosen=[...orderedExecutionCandidates(candidates[0],candidates.slice(1),lookup,billing,channel)].map(r=>r.model).find(m=>m&&(!images||m.input?.includes('image'))&&(effort==='off'?!m.reasoning:m.thinking?.efforts.includes(effort)));
     if(!chosen)throw Error('No execution candidate supports the requested model, context or reasoning');
     receipt={key:requestKey,policy:JSON.stringify(policy),model:identity(chosen),effort,tier,rule:decision.rule,classificationSource:classified.source};
     check();pi.appendEntry(receiptType,receipt);receipts.set(requestKey,receipt);previous={v:policy.rules.v,model:tier,effort};
     // Keep memory bounded; session receipts remain the source for branch/resume restoration.
     if(receipts.size>128)receipts.delete(receipts.keys().next().value);
    }
    chosen=lookup(receipt.model);if(!chosen||images&&!chosen.input?.includes('image')||receipt.effort!=='off'&&!chosen.thinking?.efforts.includes(receipt.effort))throw Error('Saved execution model or reasoning is unavailable');
    check();status(`${billing(chosen)==='subscription'?'ChatGPT 订阅':'Magpie'} · ${chosen.id} · ${receipt.effort}`);
    let terminal=false;
    const inner=delegate(chosen,ctx,{...options,reasoning:receipt.effort,maxTokens:Math.min(options.maxTokens??chosen.maxTokens,chosen.maxTokens)});
    for await(const event of inner){
     for(const m of [event.partial,event.message,event.error])if(m?.role==='assistant')m.thinkingLevel=receipt.effort;
     partial=event.partial??event.message??event.error??partial;
     if(event.type==='done'||event.type==='error')terminal=true;
     out.push(event);
    }
    if(!terminal)throw Error('Execution stream ended without a terminal response');
   }catch{
    const aborted=options.signal?.aborted;
    if(activeKey===token)status(aborted?'自动路由 · 已取消':'自动路由 · 执行已停止，请检查模型、策略或连接');
    out.push({type:'error',reason:aborted?'aborted':'error',error:{role:'assistant',content:partial?.content??[],api:chosen?.api??'yam-omp-routing',provider:chosen?.provider??'yam',model:chosen?.id??'auto',thinkingLevel:receipt?.effort,usage:partial?.usage??{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?'aborted':'error',timestamp:Date.now(),errorMessage:aborted?'Routing cancelled.':'Routing could not execute safely; check strategy, model capabilities and connection. No alternate billing connection was used.'}});
   }finally{out.end();}
  })();return out;
 }});
}
