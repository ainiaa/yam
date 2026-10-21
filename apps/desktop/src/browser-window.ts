// Author: Jeff.Liu. Trusted controls for a separate untrusted native window.
export type BrowserSnapshot={generation:number;phase:"closed"|"creating"|"open"|"closing";url:string|null;loading:boolean};
export type BrowserAction="open"|"show"|"reload"|"close";
export type BrowserInvoke=(name:string,args?:Record<string,unknown>)=>Promise<unknown>;
function response(value:unknown):BrowserSnapshot{
 if(!value||typeof value!=="object"||Array.isArray(value))throw "browser_response_invalid";
 const record=value as Record<string,unknown>,keys=["generation","phase","url","loading"],descriptors=Object.getOwnPropertyDescriptors(record);
 if(Object.keys(descriptors).length!==keys.length||!keys.every(key=>descriptors[key]&&"value"in descriptors[key]))throw "browser_response_invalid";
 if(!Number.isSafeInteger(record.generation)||(record.generation as number)<0||!["closed","creating","open","closing"].includes(String(record.phase))||typeof record.loading!=="boolean"||(record.url!==null&&(typeof record.url!=="string"||new TextEncoder().encode(record.url).length>4096||/[\x00-\x1f\x7f-\x9f]/.test(record.url))))throw "browser_response_invalid";
 return {...record} as BrowserSnapshot;
}
function inputURL(value:string):void{
 if(!value||new TextEncoder().encode(value).length>4096||/[\x00-\x1f\x7f-\x9f]/.test(value))throw "browser_url_invalid";
 let url:URL;try{url=new URL(value);}catch{throw "browser_url_invalid";}
 if(!["http:","https:"].includes(url.protocol)||!url.hostname||url.username||url.password||value.split("://")[1]?.split(/[/?#]/)[0]?.includes("@")||new TextEncoder().encode(url.href).length>4096)throw "browser_url_invalid";
}
function errorCode(reason:unknown):string{return typeof reason==="string"&&/^browser_[a-z_]{1,40}$/.test(reason)?reason:"browser_unavailable";}
export class BrowserControls {
 snapshot:BrowserSnapshot={generation:0,phase:"closed",url:null,loading:false};busy=false;error:string|null=null;
 private revision=0;private disposed=false;
 activate(){this.disposed=false;}
 dispose(){this.disposed=true;this.revision++;this.busy=false;}
 private async request(name:string,args:Record<string,unknown>|undefined,invoke:BrowserInvoke):Promise<void>{
  if(this.disposed||this.busy)return;const revision=++this.revision;this.busy=true;this.error=null;
  try{const next=response(await invoke(name,args));if(!this.disposed&&revision===this.revision)this.snapshot=next;}
  catch(reason){if(!this.disposed&&revision===this.revision)this.error=errorCode(reason);}
  finally{if(revision===this.revision)this.busy=false;}
 }
 async read(invoke:BrowserInvoke):Promise<void>{await this.request("browser_status",undefined,invoke);}
 async action(action:BrowserAction,url:string,invoke:BrowserInvoke):Promise<void>{
  if(this.disposed||this.busy)return;
  if(action==="open"){try{inputURL(url);}catch(reason){this.error=errorCode(reason);return;}}
  const args:Record<string,unknown>={expected_generation:this.snapshot.generation};if(action==="open")args.url=url;
  await this.request(`browser_${action}`,args,invoke);
 }
}
