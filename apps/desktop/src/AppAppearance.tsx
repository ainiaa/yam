import type {SettingsNavigationRenderer} from "./SettingsNavigation";
// Author: Jeff.Liu. A single draft/save boundary for application-owned language and appearance.
import {useEffect,useRef,useState} from 'react';
import {Select} from './Select';
import {t} from './i18n';
import {appThemes,backgroundObjectUrl} from './app-themes';
import {defaultAppPreferences,type AppPreferences} from './app-preferences';
export function AppAppearance({value,error,onSave,onClose,onTerminalSettings,navigation}:{value:AppPreferences;error:string|null;onSave:(value:AppPreferences)=>void;onClose:()=>void;onTerminalSettings:()=>void;navigation?:SettingsNavigationRenderer}){
 const language=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLDialogElement>(null),[draft,setDraft]=useState({...value}),[failure,setFailure]=useState<string|null>(null);
 const active=useRef(true),loadRevision=useRef(0),pendingUrl=useRef<string|null>(null),[reading,setReading]=useState(false);
 const [preview,setPreview]=useState<{raw:string;url:string}|null>(null);
 function cancelRead(){loadRevision.current++;setReading(false);if(pendingUrl.current)URL.revokeObjectURL(pendingUrl.current);pendingUrl.current=null;}
 useEffect(()=>{dialog.current?.showModal();language.current?.focus();active.current=true;return()=>{active.current=false;loadRevision.current++;if(pendingUrl.current)URL.revokeObjectURL(pendingUrl.current);pendingUrl.current=null;};},[]);
 useEffect(()=>{if(!draft.background){setPreview(null);return;}try{const url=backgroundObjectUrl(draft.background);setPreview({raw:draft.background,url});return()=>URL.revokeObjectURL(url);}catch{setPreview(null);setFailure('The background image could not be read.');}},[draft.background]);
 function background(file:File|undefined){
  cancelRead();const revision=loadRevision.current;if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>500000){setFailure('Choose a PNG, JPEG or WebP image smaller than 500 KB.');return;}
  setReading(true);setFailure(null);const reader=new FileReader();
  let url:string|null=null;const release=()=>{if(url){URL.revokeObjectURL(url);if(pendingUrl.current===url)pendingUrl.current=null;url=null;}};
  const fail=()=>{release();if(active.current&&revision===loadRevision.current){setReading(false);setFailure('The background image could not be read.');}};
  reader.onerror=fail;reader.onabort=fail;
  reader.onload=()=>{if(!active.current||revision!==loadRevision.current)return;const raw=reader.result;if(typeof raw!=='string'){fail();return;}try{url=backgroundObjectUrl(raw);pendingUrl.current=url;}catch{fail();return;}const image=new Image();image.onerror=fail;image.onload=()=>{release();if(!active.current||revision!==loadRevision.current)return;if(!image.naturalWidth||image.naturalWidth*image.naturalHeight>16000000){fail();return;}setDraft(value=>({...value,background:raw}));setReading(false);};image.src=url;};
  try{reader.readAsDataURL(file);}catch{fail();}
 }
 return <dialog ref={dialog} className={"app-dialog terminal-settings-dialog terminal-preferences appearance-dialog"+(navigation?" settings-surface":"")} aria-labelledby="appearance-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <form onSubmit={event=>{event.preventDefault();try{onSave(draft);onClose();}catch{setFailure('Could not save language and appearance. Your draft is kept.');}}}>
   <header className="dialog-header"><h2 id="appearance-title">{t('Language and appearance')}</h2></header>
   {navigation?.(JSON.stringify(draft)!==JSON.stringify(value)||reading)}
   <div className="terminal-settings-body"><section className="dialog-fields"><label>{t('Language')}<Select ref={language} aria-label={t('Language')} value={draft.language} onChange={event=>setDraft({...draft,language:event.target.value as AppPreferences['language']})}><option value="system">{t('Follow system')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></Select></label><p>{t('Changes apply to all YAM windows. Running tasks keep their configuration.')}</p></section>
   <section className="dialog-fields"><h3>{t('Theme')}</h3><div className="theme-grid" role="group" aria-label={t('Theme')}>
    {(['system','dark','light','mocha','nord'] as const).map(theme=>{const palette=appThemes[theme==='system'?'dark':theme];return <button type="button" key={theme} className="theme-card" aria-pressed={draft.theme===theme} onClick={()=>setDraft({...draft,theme})}>
      <span className="theme-swatch" aria-hidden="true" style={{background:palette.background,color:palette.text,borderColor:palette.accent}}><span style={{background:palette.sidebar}}/><span style={{color:palette.accent}}>Aa</span><span>❯ _</span></span>
      {t(theme==='system'?'Follow system':theme==='dark'?'YAM Dark':theme==='light'?'YAM Light':theme==='mocha'?'Catppuccin Mocha':'Nord')}
    </button>;})}
   </div><p>{t('Explicit terminal palettes stay unchanged. Choose Follow app theme in Terminal settings to match.')}</p>{!navigation&&<button type="button" onClick={onTerminalSettings}>{t('Terminal color settings')}</button>}</section>
   <section className="dialog-fields"><h3>{t('Background image')}</h3><p>{t('Optional local image for app panels. Terminal output stays opaque for readability.')}</p><label>{t('Choose image')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={reading} onChange={event=>{const file=event.target.files?.[0];event.target.value='';background(file);}}/></label>
    {draft.background&&<>{preview?.raw===draft.background&&<img className="background-preview" src={preview.url} alt={t('Background preview')}/>}<label>{t('Background strength')} · {draft.backgroundStrength}%<input type="range" min={0} max={30} step={1} aria-label={t('Background strength')} value={draft.backgroundStrength} onChange={event=>setDraft({...draft,backgroundStrength:Number(event.target.value)})}/></label><button type="button" onClick={()=>{cancelRead();setFailure(null);setDraft({...draft,background:null});}}>{t('Remove image')}</button></>}
    <button type="button" onClick={()=>{cancelRead();setFailure(null);setDraft({...defaultAppPreferences});}}>{t('Restore defaults')}</button>
   </section>
   {(failure||error)&&<p role="alert">{t(failure||error||'')}</p>}</div>
   <footer className="dialog-actions"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={reading} className="primary-button">{t('Save settings')}</button></footer>
  </form>
 </dialog>;
}
