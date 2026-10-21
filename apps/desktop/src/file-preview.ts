// Author: Jeff.Liu. Native file authorization stays outside the webview.
type PreviewSource={query_token:string;session_id:string|null;root:string;path:string;read_at:number;bytes:number};
export type PreviewImage=PreviewSource&{kind:"image";mime:"image/png"|"image/jpeg"|"image/webp";width:number;height:number;data_base64:string};
export type FilePreview = PreviewSource&({kind:"text";text:string}|{kind:"image";mime:PreviewImage["mime"];width:number;height:number;data_base64:string});
export type FilePreviewState = {kind:"loading"}|{kind:"ready";value:FilePreview}|{kind:"unavailable";code:string};
export type PreviewTarget = {sessionId:string;path:string};
export type PreviewInvoke = (name:string,args?:Record<string,unknown>)=>Promise<unknown>;
const tokenPattern=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const pathValid=(path:unknown):path is string=>typeof path==="string"&&path.startsWith("/")&&path.length<=4096&&!/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(path)&&!path.split("/").some(p=>p===".."||p==="."||p.toLowerCase()===".git");
export function isFilePreview(value:unknown):value is FilePreview {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 const common=typeof v.query_token==="string"&&tokenPattern.test(v.query_token)
  &&(v.session_id===null||typeof v.session_id==="string"&&/^s-[a-z\d-]{1,128}$/i.test(v.session_id))&&pathValid(v.path)&&pathValid(v.root)
  &&v.path.startsWith(v.root==="/"?"/":v.root+"/")&&v.path!==v.root&&Number.isSafeInteger(v.read_at)&&Number(v.read_at)>=0
  &&Number.isSafeInteger(v.bytes)&&Number(v.bytes)>=0;
 if(!common)return false;
 if(v.kind==="text")return Object.keys(v).sort().join(",")==="bytes,kind,path,query_token,read_at,root,session_id,text"&&typeof v.text==="string"&&Number(v.bytes)<=1048576&&new TextEncoder().encode(v.text).length===v.bytes;
 if(v.kind!=="image"||Object.keys(v).sort().join(",")!=="bytes,data_base64,height,kind,mime,path,query_token,read_at,root,session_id,width"||!["image/png","image/jpeg","image/webp"].includes(String(v.mime))||!Number.isSafeInteger(v.width)||!Number.isSafeInteger(v.height)||Number(v.width)<1||Number(v.height)<1||Number(v.width)*Number(v.height)>16000000||Number(v.bytes)>5242880||typeof v.data_base64!=="string"||v.data_base64.length>6990508||v.data_base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data_base64))return false;
 try{const bytes=atob(v.data_base64);return bytes.length===v.bytes&&(v.mime==="image/png"?bytes.startsWith("\x89PNG\r\n\x1a\n"):v.mime==="image/jpeg"?bytes.startsWith("\xff\xd8\xff"):bytes.startsWith("RIFF")&&bytes.slice(8,12)==="WEBP");}catch{return false;}
}
export function textLineOffset(text:string,line:number):number {
 if(!Number.isSafeInteger(line)||line<1)return -1;
 let at=0;for(let n=1;n<line;n++){const next=text.indexOf("\n",at);if(next<0)return -1;at=next+1;}return at;
}
export function findText(text:string,query:string,from:number):{start:number;end:number}|null {
 if(!query)return null;const start=text.indexOf(query,Math.max(0,from));const at=start<0?text.indexOf(query):start;
 return at<0?null:{start:at,end:at+query.length};
}
type Load={generation:number;invoke:PreviewInvoke;changed:(value:FilePreviewState)=>void;target?:PreviewTarget};
const errors=new Set(["file_unavailable","file_cancelled","file_busy","file_invalid_request","file_invalid_path","file_outside_root","file_not_regular","file_too_large","file_invalid_utf8","file_changed","file_session_unavailable","file_session_changed","file_platform_unavailable","file_invalid_image","file_animated_image","file_image_pixel_limit"]);
export class FilePreviewController {
 scope="";private generation=0;private active:{token:string;invoke:PreviewInvoke;cancelled:boolean}|null=null;private pending:Load|null=null;
 private token:()=>string;
 constructor(token:()=>string=()=>crypto.randomUUID()){this.token=token;}
 select(scope:string){if(scope!==this.scope){this.cancel();this.scope=scope;}}
 cancel(){this.generation++;this.pending=null;this.cancelActive();}
 private cancelActive(){if(this.active&&!this.active.cancelled){this.active.cancelled=true;void this.active.invoke("cancel_file_preview",{query_token:this.active.token}).catch(()=>{});}}
 async load(invoke:PreviewInvoke,changed:(value:FilePreviewState)=>void,target?:PreviewTarget){
  const load={generation:++this.generation,invoke,changed,target};this.pending=null;this.cancelActive();changed({kind:"loading"});
  if(this.active){this.pending=load;return;}await this.run(load);
 }
 private async run(load:Load):Promise<void>{
  if(load.generation!==this.generation)return;
  const token=this.token(),active={token,invoke:load.invoke,cancelled:false};this.active=active;
  const args:Record<string,unknown>={query_token:token};if(load.target){args.session_id=load.target.sessionId;args.path=load.target.path;}
  try {
   const value=await load.invoke(load.target?"read_project_file_preview":"choose_project_file_preview",args);
   if(load.generation!==this.generation)return;
   if(!isFilePreview(value)||value.query_token!==token||value.session_id!==(load.target?.sessionId??null)||(load.target&&value.path!==load.target.path))load.changed({kind:"unavailable",code:"file_invalid_response"});
   else load.changed({kind:"ready",value});
  }catch(reason){if(load.generation===this.generation)load.changed({kind:"unavailable",code:typeof reason==="string"&&errors.has(reason)?reason:"file_unavailable"});}
  finally {if(this.active===active)this.active=null;const pending=this.pending;this.pending=null;if(pending&&pending.generation===this.generation)await this.run(pending);}
 }
}
