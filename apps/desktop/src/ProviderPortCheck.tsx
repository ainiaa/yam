// Author: Jeff.Liu. Explicit local port diagnostics; the caller supplies its window-scoped RPC.
import {useRef,useState} from "react";
import {t} from "./i18n";
function ProviderPortCheck({endpoint,invoke}:{endpoint:string;invoke:<T=unknown>(name:string,args?:Record<string,unknown>)=>Promise<T>}) {
 const pending=useRef(false);
 const [result,setResult]=useState<{endpoint:string;status:string}|null>(null);
 async function check(){
  if(pending.current)return;pending.current=true;setResult({endpoint,status:"checking"});
  try{const reply=await invoke<string>("probe_provider_endpoint",{endpoint});setResult({endpoint,status:["reachable","unreachable","timed_out","unsupported"].includes(reply)?reply:"unavailable"});}
  catch{setResult({endpoint,status:"unavailable"});}
  finally{pending.current=false;}
 }
 const messages:Record<string,string>={checking:"Checking local port…",reachable:"Port is reachable. Authentication and model are not verified.",unreachable:"Cannot connect to this local port.",timed_out:"Local port check timed out (2 seconds maximum).",unsupported:"This check only supports local gateways at localhost, 127.0.0.1 or ::1 using HTTP or HTTPS.",unavailable:"Check unavailable. Try again manually."};
 return <div><button type="button" disabled={pending.current} onClick={check}>{t("Check local port")}</button><small>{t("TCP port check only; authentication and model are not verified. No model request is sent.")}</small>{result?.endpoint===endpoint&&<p className={`connection-result ${result.status==="checking"?"pending":result.status==="reachable"?"success":"error"}`} role={result.status==="checking"||result.status==="reachable"?"status":"alert"}>{result.status==="checking"?"":result.status==="reachable"?"✓ ":"✕ "}{t(messages[result.status])}</p>}</div>;
}

export {ProviderPortCheck};
