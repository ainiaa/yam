// Author: Jeff.Liu.
export type SelectOption={value:string;label:string;disabled:boolean;group?:string;detail?:string;search?:string};
export function nextSelectIndex(options:SelectOption[],current:number,direction:"next"|"previous"|"first"|"last"):number {
 const enabled=options.flatMap((option,index)=>option.disabled?[]:[index]);
 if(!enabled.length)return -1;
 if(direction==="first")return enabled[0];if(direction==="last")return enabled[enabled.length-1];
 const at=enabled.indexOf(current);
 return enabled[Math.max(0,Math.min(enabled.length-1,at+(direction==="next"?1:-1)))];
}
export function typeaheadSelectIndex(options:SelectOption[],current:number,query:string):number {
 for(let offset=1;offset<=options.length;offset++){
  const index=(Math.max(-1,current)+offset)%options.length,option=options[index];
  if(!option.disabled&&option.label.toLowerCase().startsWith(query.toLowerCase()))return index;
 }
 return options.length?current:-1;
}
export function selectMenuGeometry(rect:{left:number;right:number;top:number;bottom:number;width:number},viewportWidth:number,viewportHeight:number,minWidth=180) {
 const width=Math.min(Math.max(minWidth,Math.round(rect.width)),Math.max(0,viewportWidth-24));
 const below=Math.max(0,viewportHeight-rect.bottom-18),above=Math.max(0,rect.top-18);
 const up=below<Math.min(220,above);
 return {position:"fixed" as const,left:Math.max(12,Math.min(Math.round(rect.left),viewportWidth-width-12)),width,
  top:up?undefined:Math.round(rect.bottom)+6,bottom:up?viewportHeight-Math.round(rect.top)+6:undefined,maxHeight:Math.floor(Math.min(280,up?above:below))};
}
