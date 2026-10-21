import {applyAppThemeDocument} from "./app-themes";
import {loadAppPreferences,resolveLocale,APP_PREFERENCES_KEY} from "./app-preferences";
import {setLocale,t} from "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {initializeDesktopWindow,setWindowContext,waitNativeWindowEpoch} from "./window-context";
import App from "./App";
// Author: Jeff.Liu. No App, storage write or owner dispatch before ID-bound native readiness.
setLocale(resolveLocale(loadAppPreferences(()=>localStorage.getItem(APP_PREFERENCES_KEY)).value.language,navigator.languages));
try{applyAppThemeDocument(loadAppPreferences(()=>localStorage.getItem(APP_PREFERENCES_KEY)).value,window.matchMedia("(prefers-color-scheme: dark)").matches,document.documentElement);}catch{/* UI can initialize even if OS appearance is unavailable. */}
let initializing=false,mounted=false;
async function initializeWindow(){
  if(initializing||mounted)return;initializing=true;
  const root=document.getElementById("root");
  try {
    if(root)root.textContent=t("Waiting for native terminal window…");
    const epoch=await waitNativeWindowEpoch(window);
    const context=await initializeDesktopWindow(invoke,localStorage,epoch);
    setWindowContext(context);mounted=true;window.removeEventListener("yam-native-window-ready",retryReady);
    ReactDOM.createRoot(root as HTMLElement).render(<React.StrictMode><App /></React.StrictMode>);
  }catch {
    if(root){root.textContent=t("Terminal window bootstrap unavailable. Saved layouts and running tasks were preserved. ");const retry=document.createElement("button");retry.textContent=t("Retry initialization");retry.onclick=()=>void initializeWindow();root.append(retry);}
  }finally {initializing=false;}
}
const retryReady=()=>{void initializeWindow();};
window.addEventListener("yam-native-window-ready",retryReady);
void initializeWindow();
