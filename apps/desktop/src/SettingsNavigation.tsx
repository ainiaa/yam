// Author: Jeff.Liu. Navigation changes presentation only; each page retains its own save boundary.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {t} from './i18n';
export const settingsPages=[['appearance','Appearance'],['settings','Terminal'],['keyboard-shortcuts','Keyboard shortcuts'],['updates','Updates'],['profiles','Terminal profiles'],['paste-settings','Paste settings'],['system-entry','System entry'],['launch-settings','Launch templates and defaults'],['directory-reporting','Zsh directory reporting'],['command-reporting','Zsh command status reporting']] as const;
export type SettingsPage=typeof settingsPages[number][0];
export type SettingsNavigationRenderer=(dirty:boolean)=>ReactNode;
export function SettingsNavigation({current,dirty,onSelect,blocked=false}:{current:SettingsPage;dirty:boolean;onSelect:(page:SettingsPage)=>void;blocked?:boolean}){
 const [pending,setPending]=useState<SettingsPage|null>(null);
 const keep=useRef<HTMLButtonElement>(null),origin=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{if(pending){keep.current?.focus({preventScroll:true});keep.current?.scrollIntoView({block:'nearest'});}},[pending]);
 function item([id,label]:typeof settingsPages[number]){return <button type="button" key={id} disabled={blocked} aria-current={id===current?'page':undefined} onClick={event=>{if(id===current)return;if(dirty){origin.current=event.currentTarget;setPending(id);}else onSelect(id);}}>{t(label)}</button>;}
 return <aside className="settings-navigation"><nav aria-label={t('Settings sections')}>
  {settingsPages.slice(0,4).map(item)}
  <details open={settingsPages.slice(4).some(([id])=>id===current)||undefined}><summary>{t('Advanced options')}</summary>{settingsPages.slice(4).map(item)}</details>
 </nav>{pending&&<div role="alert" className="settings-discard"><p>{t('Discard unsaved changes?')}</p><button ref={keep} type="button" disabled={blocked} onClick={()=>{setPending(null);origin.current?.focus();}}>{t('Keep editing')}</button><button type="button" disabled={blocked} onClick={()=>{const page=pending;setPending(null);onSelect(page);}}>{t('Discard changes')}</button></div>}</aside>;
}
