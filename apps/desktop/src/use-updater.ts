// Author: Jeff.Liu. React ownership of updater startup, polling and user actions.
import {useEffect,useRef,useState} from "react";
import {UpdaterController,loadUpdaterPreference,runUpdaterAction as performUpdaterAction,changeUpdaterAutomatic as persistUpdaterAutomatic,updaterAutomaticAction,UPDATE_CHECK_INTERVAL_MS,updaterBusy,type UpdaterSnapshot} from "./updater";
import type {UpdaterInvoke} from "./updater";

export function useUpdater({isMainWindow,localStorage,invoke,openMainSettings}:{isMainWindow:boolean;localStorage:Pick<Storage,"getItem"|"setItem">;invoke:UpdaterInvoke;openMainSettings:()=>void}){
  const [updaterPreferenceLoad]=useState(()=>loadUpdaterPreference(()=>localStorage.getItem("yam.updater.v1")));
  const updaterController=useRef(new UpdaterController());
  const updaterMounted=useRef(false);
  const updaterIntent=useRef(0);
  const [updaterOpen,setUpdaterOpen]=useState(false);
  const [updaterSnapshot,setUpdaterSnapshot]=useState<UpdaterSnapshot|null>(null);
  const [updaterAutomatic,setUpdaterAutomatic]=useState(updaterPreferenceLoad.automatic);
  const updaterAutomaticRef=useRef(updaterAutomatic);updaterAutomaticRef.current=updaterAutomatic;
  const [updaterError,setUpdaterError]=useState<string|null>(updaterPreferenceLoad.error);
  const [updaterBusyAction,setUpdaterBusy]=useState(false);
  useEffect(()=>{
    if(!isMainWindow)return;
    updaterMounted.current=true;let active=true;const intent=++updaterIntent.current;
    void (async()=>{
      try {
        const initial=await updaterController.current.load(invoke);
        if(!active||!updaterMounted.current||intent!==updaterIntent.current)return;
        setUpdaterSnapshot(initial);
        const next=await updaterController.current.startup(invoke,updaterAutomaticRef.current,()=>updaterMounted.current&&updaterAutomaticRef.current);
        if(active&&updaterMounted.current&&intent===updaterIntent.current&&next)setUpdaterSnapshot(next);
      } catch {if(active&&updaterMounted.current&&intent===updaterIntent.current)setUpdaterError("updater_unavailable");}
    })();
    return ()=>{active=false;updaterMounted.current=false;updaterIntent.current++;updaterController.current.cancel();};
  },[]);
  useEffect(()=>{
    if(!isMainWindow||(!updaterOpen&&!updaterAutomaticRef.current&&!updaterBusy(updaterSnapshot?.state??"idle")&&!["available","verified"].includes(updaterSnapshot?.state??"idle")))return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      let waitingForStatus=false;
      try {
        let next=await updaterController.current.refresh(invoke);waitingForStatus=next===null;
        if(active&&updaterMounted.current&&updaterAutomaticAction(next,updaterAutomaticRef.current))next=await updaterController.current.action(invoke,"download");
        if(active&&updaterMounted.current&&next)setUpdaterSnapshot(next);
      }
      catch {if(active&&updaterMounted.current)setUpdaterError("updater_unavailable");}
      // A closed predecessor can still own the single status RPC. Retry without overlap.
      if(active&&(waitingForStatus||(updaterController.current.snapshot&&(updaterBusy(updaterController.current.snapshot.state)||updaterController.current.snapshot.state==="verified"))))timer=setTimeout(poll,1000);
    }
    void poll();
    return ()=>{active=false;if(timer!==undefined)clearTimeout(timer);};
  },[updaterOpen||updaterAutomatic,updaterSnapshot?.state,updaterAutomatic]);
  useEffect(()=>{
    if(!isMainWindow||!updaterAutomatic)return;
    const timer=window.setInterval(()=>{
      const current=updaterController.current.snapshot;
      if(current?.configured&&!updaterBusy(current.state))void runUpdaterAction("check");
    },UPDATE_CHECK_INTERVAL_MS);
    return()=>window.clearInterval(timer);
  },[updaterAutomatic]);
  async function runUpdaterAction(action:"check"|"download"|"cancel"|"install") {
    if(!isMainWindow){openMainSettings();return;}
    const intent=++updaterIntent.current;
    await performUpdaterAction({controller:updaterController.current,action,invoke,intent,currentIntent:()=>updaterIntent.current,
      mounted:()=>updaterMounted.current,setBusy:setUpdaterBusy,setSnapshot:setUpdaterSnapshot,setError:setUpdaterError});
  }
  async function changeUpdaterAutomatic(enabled:boolean) {
    const intent=++updaterIntent.current;
    await persistUpdaterAutomatic({enabled,write:raw=>localStorage.setItem("yam.updater.v1",raw),invoke,snapshot:updaterController.current.snapshot,
      intent,currentIntent:()=>updaterIntent.current,mounted:()=>updaterMounted.current,controller:updaterController.current,
      setAutomatic:value=>{updaterAutomaticRef.current=value;setUpdaterAutomatic(value);},setError:setUpdaterError,
      setBusy:setUpdaterBusy,setSnapshot:setUpdaterSnapshot});
  }
  function closeUpdaterSettings(){setUpdaterOpen(false);}
  return {updaterController,updaterOpen,setUpdaterOpen,updaterSnapshot,updaterAutomatic,updaterError,updaterBusyAction,runUpdaterAction,changeUpdaterAutomatic,closeUpdaterSettings};
}
