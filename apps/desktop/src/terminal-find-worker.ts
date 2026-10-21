// Author: Jeff.Liu. Arbitrary regex executes only in the disposable find worker.
export type FindScan={matches:[number,number][];overflow:boolean;error?:string};
export function scanFindText(text:string,query:string,regex:boolean,caseSensitive:boolean):FindScan {
 const matches:[number,number][]=[];if(!query)return {matches,overflow:false};
 if(!regex){
  const value=caseSensitive?text:text.toLowerCase(),term=caseSensitive?query:query.toLowerCase();let offset=0,index:number;
  // Lowercasing İ expands its UTF16 length. Keep only expansion boundaries, not a per-character map.
  const expansions:{start:number;end:number;originalStart:number;originalEnd:number;delta:number}[]=[];
  if(value.length!==text.length){let original=0,folded=0;while(original<text.length){const character=String.fromCodePoint(text.codePointAt(original)!),width=character.length,foldWidth=character.toLowerCase().length;if(width!==foldWidth)expansions.push({start:folded,end:folded+foldWidth,originalStart:original,originalEnd:original+width,delta:folded+foldWidth-original-width});original+=width;folded+=foldWidth;}}
  const originalOffset=(position:number,end:boolean)=>{let low=0,high=expansions.length;while(low<high){const mid=(low+high)>>>1;if(expansions[mid].start<=position)low=mid+1;else high=mid;}const expansion=expansions[low-1];if(expansion&&position<expansion.end)return end?expansion.originalEnd:expansion.originalStart;return position-(expansion?.delta??0)+(end?1:0);};
  while((index=value.indexOf(term,offset))>=0){offset=index+1;if(!term.replace(/\n/g,""))continue;const start=originalOffset(index,false),end=originalOffset(index+term.length-1,true);if(matches.some(match=>match[0]===start&&match[1]===end))continue;if(matches.length===200)return {matches,overflow:true};matches.push([start,end]);}
  return {matches,overflow:false};
 }
 const expression=new RegExp(query,caseSensitive?"gu":"giu");let match:RegExpExecArray|null;
 while((match=expression.exec(text))){
  if(!match[0].length){expression.lastIndex=match.index+(text.codePointAt(match.index)!>0xffff?2:1);continue;}
  if(!match[0].replace(/\n/g,""))continue;
  if(matches.length===200)return {matches,overflow:true};
  matches.push([match.index,match.index+match[0].length]);
 }
 return {matches,overflow:false};
}
const scope=globalThis as unknown as {document?:unknown;postMessage?:(value:unknown)=>void;onmessage?:(event:{data:{id:number;text:string;query:string;regex:boolean;caseSensitive:boolean}})=>void};
if(typeof scope.postMessage==="function"&&!scope.document)scope.onmessage=({data})=>{
 try{scope.postMessage!({id:data.id,...scanFindText(data.text,data.query,data.regex,data.caseSensitive)});}
 catch(reason){scope.postMessage!({id:data.id,matches:[],overflow:false,error:String(reason)});}
};
