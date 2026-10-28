// Author: Jeff.Liu. These fields belong to Pi only; official CLI arguments never pass through this form.
export type PiDraft={gateway:string|null;small:string;strong:string;classifier:string;model:string;effort:string};
export type PiModel={key:string;name:string;levels:string[];context_window:number};
export type PiRoutingState={revision:number;generation:string;phase:'starting'|'idle'|'classifying'|'selected'|'working'|'error';config:{small:string;strong:string;classifier:string;gateway:string|null};preferences:{model:string;effort:string};target:{model:string;effort:string;reason:string}|null;actual:{model:string;effort:string;at:number}|null;error:string|null;pendingInput:boolean};
export type PiSnapshot={active:boolean;state:PiRoutingState|null};
export const piLevels=['low','medium','high','xhigh','max'] as const;
const owned=['--yam-small','--yam-strong','--yam-classifier','--yam-gateway','--yam-fixed-model','--yam-effort','--model','--thinking'];
function tokens(args:string):{value:string;raw:string}[]{
 const result=[];let i=0;
 while(i<args.length){while(/\s/.test(args[i]??'')&&i<args.length)i++;if(i===args.length)break;const start=i;let value='',quote='';
  while(i<args.length){const c=args[i++];if(!quote&&/\s/.test(c))break;
   if(c==='\\'&&quote!=="'"){if(i===args.length)throw Error('Invalid Pi argument escape');value+=args[i++];}
   else if(c===quote)quote='';else if(!quote&&(c==='"'||c==="'"))quote=c;else value+=c;
  }
  if(quote)throw Error('Unclosed Pi argument quote');result.push({value,raw:args.slice(start,i).trimEnd()});
 }
 return result;
}
function readArgs(args:string){
 const flags=new Map<string,string>(),extra:string[]=[];const items=tokens(args);
 for(let i=0;i<items.length;i++){
  const item=items[i],flag=item.value.split('=')[0];
  if(item.value==='--'){extra.push(...items.slice(i).map(v=>v.raw));break;}
  if(owned.includes(flag)){const inline=item.value.indexOf('=');const value=inline<0?items[++i]?.value:item.value.slice(inline+1);if(value===undefined)throw Error(`Missing Pi argument: ${flag}`);flags.set(flag,value);}
  else {extra.push(item.raw);if(item.value.startsWith('--')&&!item.value.includes('=')&&['--extension','--skill','--theme','--tools','--append-system-prompt','--system-prompt','--prompt-template','--provider','--export'].includes(item.value)&&items[i+1])extra.push(items[++i].raw);}
 }
 return {flags,extra};
}
export function parsePiDraft(args:string):PiDraft {
 const {flags}=readArgs(args);const native=flags.get('--model'),suffix=native?.split(':').slice(-1)[0],inline=suffix&&['off','minimal',...piLevels].includes(suffix)?suffix:undefined;
 const plain=native&&(inline?native.slice(0,-inline.length-1):native),model=plain&&plain!=='yam/auto'?plain:flags.get('--yam-fixed-model')??'auto';
 const explicitEffort=flags.get('--thinking')??inline;
 return {gateway:flags.get('--yam-gateway')??null,small:flags.get('--yam-small')??'',strong:flags.get('--yam-strong')??'',classifier:flags.get('--yam-classifier')??'',model,effort:explicitEffort!==undefined?explicitEffort:flags.get('--yam-effort')??'auto'};
}
export function buildPiArgs(args:string,draft:PiDraft):string {
 const {extra}=readArgs(args),pairs=[['--yam-small',draft.small],['--yam-strong',draft.strong],['--yam-classifier',draft.classifier],['--yam-gateway',draft.gateway],['--yam-fixed-model',draft.model],['--yam-effort',draft.effort]];
 const configured=pairs.filter(([,v])=>v!==null&&v!=='').flatMap(([k,v])=>[k,`'${v!.split("'").join("'\\''")}'`]);
 // Keep a literal prompt terminator last. Native Pi still owns prompt parsing.
 const end=extra.indexOf('--');return [...(end<0?extra:extra.slice(0,end)),...configured,...(end<0?[]:extra.slice(end))].join(' ');
}
export function validatePiDraft(draft:PiDraft,models:PiModel[]):string|null {
 if(draft.gateway!==null){try{const u=new URL(draft.gateway);if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol)||(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)))return 'Gateway requires HTTPS or loopback HTTP without credentials/query';}catch{return 'Invalid gateway URL';}}
 for(const key of [...(draft.model==='auto'?[draft.small,draft.strong,draft.classifier||draft.small]:draft.effort==='auto'?[draft.classifier||draft.small]:[]),...(draft.model==='auto'?[]:[draft.model])])if(!models.some(m=>m.key===key))return `Pi model unavailable: ${key||'—'}`;
 const level=draft.effort;
 if(level!=='auto'&&!['off','minimal',...piLevels].includes(level))return 'Unknown reasoning level';
 const target=models.find(m=>m.key===(draft.model==='auto'?draft.strong:draft.model));
 if(level!=='auto'&&!target?.levels.includes(level))return `Selected model cannot preserve reasoning ${level}`;
 return null;
}
