import {t} from "./i18n";
// Author: Jeff.Liu. Explicit main-window SSH connection, no storage/config reads.
import {useEffect,useRef,useState} from "react";
import {parseSshDestination,type SshLaunch} from "./ssh-launch";
export function SshLaunchDialog({busy,error,cwd,onConnect,onClose}:{busy:boolean;error:string|null;cwd:string;onConnect:(value:SshLaunch)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[destination,setDestination]=useState(""),[port,setPort]=useState(""),[validation,setValidation]=useState<string|null>(null);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="app-dialog" aria-labelledby="ssh-launch-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
 <header className="dialog-header"><h2 id="ssh-launch-title">{t("Connect SSH")}</h2></header>
 <form onSubmit={event=>{event.preventDefault();if(busy)return;try{const value=parseSshDestination(destination,port);setValidation(null);onConnect(value);}catch{setValidation("Enter an alias, host or IPv6 literal, optional user@, and a separate port 1–65535.");}}}>
 <section className="dialog-fields"><p>{t("Uses macOS OpenSSH and your existing SSH configuration. Aliases, proxy commands and remote commands follow that configuration. Enter passwords and host-key confirmations in the terminal.")}</p><p>{t("IPv6 accepts bare or bracketed addresses. Use the separate port field; a final address group is not a port. Zone identifiers and SSH URIs are unsupported.")}</p><p>{t("Local directory:")+" "}{cwd||t("current owner directory")}</p>
 <label>{t("Destination")}<input value={destination} onChange={event=>setDestination(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} placeholder={t("user@alias-or-host")}/></label>
 <label>{t("Port (optional)")}<input value={port} onChange={event=>setPort(event.target.value)} disabled={busy} autoComplete="off" inputMode="numeric"/></label>
 {(validation||error)&&<p role="alert">{t(validation||error||"")}</p>}</section><footer className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button type="submit" disabled={busy}>{t("Connect")}</button></footer></form></dialog>;
}
