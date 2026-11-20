import type {DataSettingsSection} from './DataSettings';
import {matchesSettingsPage} from './settings-search';
// Author: Jeff.Liu. Navigation changes presentation only; each page retains its own save boundary.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {t} from './i18n';
export const settingsPages=[['appearance','Appearance'],['settings','Terminal'],['keyboard-shortcuts','Keyboard shortcuts'],['updates','Updates'],['pi-routing','Automatic routing'],['profiles','Terminal profiles'],['paste-settings','Paste settings'],['system-entry','System entry'],['launch-settings','Launch templates and defaults'],['pi-plugins','Pi plugins'],['support','Data and diagnostics'],['directory-reporting','Zsh directory reporting'],['command-reporting','Zsh command status reporting']] as const;
export type SettingsPage=typeof settingsPages[number][0];
export type SettingsNavigationRenderer=(dirty:boolean,blocked?:boolean)=>ReactNode;
export function SettingsNavigation({current,dirty,onSelect,blocked=false}:{current:SettingsPage;dirty:boolean;onSelect:(page:SettingsPage,section?:DataSettingsSection)=>void;blocked?:boolean}){
 const [query,setQuery]=useState("");
 const [pending,setPending]=useState<{page:SettingsPage;section?:DataSettingsSection}|'close'|null>(null);
 const keep=useRef<HTMLButtonElement>(null),origin=useRef<HTMLButtonElement|null>(null),surface=useRef<HTMLElement>(null),closing=useRef(false),closeAction=useRef<(()=>void)|null>(null);
 useEffect(()=>{
  const dialog=surface.current?.closest('dialog');if(!dialog)return;
  const cancel=(event:Event)=>{
   if(closing.current||!dirty)return;
   event.preventDefault();event.stopImmediatePropagation();if(blocked)return;
   origin.current=(dialog.ownerDocument?.activeElement as HTMLButtonElement|null)??null;
   closeAction.current=()=>dialog.dispatchEvent(new Event('cancel',{cancelable:true}));setPending('close');
  };
  const click=(event:Event)=>{
   const button=(event.target as Element|null)?.closest<HTMLButtonElement>('[data-settings-close]');
   if(!button||closing.current||!dirty)return;
   event.preventDefault();event.stopImmediatePropagation();if(blocked)return;
   origin.current=button;closeAction.current=()=>button.click();setPending('close');
  };
  const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(event.isComposing||event.keyCode===229)){event.preventDefault();event.stopImmediatePropagation();}};
  dialog.addEventListener('cancel',cancel,true);dialog.addEventListener('click',click,true);dialog.addEventListener('keydown',keydown,true);
  return()=>{dialog.removeEventListener('cancel',cancel,true);dialog.removeEventListener('click',click,true);dialog.removeEventListener('keydown',keydown,true);};
 },[dirty,blocked]);
 useEffect(()=>{if(pending){keep.current?.focus({preventScroll:true});keep.current?.scrollIntoView({block:'nearest'});}},[pending]);
 function select(page:SettingsPage,event:{currentTarget:HTMLButtonElement},section?:DataSettingsSection){if(blocked||page===current&&!section)return;if(dirty&&page!==current){origin.current=event.currentTarget;setPending({page,section});}else onSelect(page,section);}
 function item([id,label]:typeof settingsPages[number]){return <button type="button" key={id} disabled={blocked} aria-current={id===current?'page':undefined} onClick={event=>select(id,event)}>{t(label)}</button>;}
 const sections:readonly [DataSettingsSection,string,string][]=[['preferences','Preference backup','偏好备份 偏好设置备份 preference backup'],['project-backup','Project backup','项目备份 备份 project backup'],['notifications','Project notifications','项目通知 通知 notifications notification'],['diagnostics','Diagnostics','诊断 diagnostics troubleshooting'],['performance','Performance observations','性能 观测 performance']];
 const sectionMatches=query.trim()?sections.filter(([,label,aliases])=>`${label} ${t(label)} ${aliases}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())):[];
 const matches=(row:typeof settingsPages[number])=>matchesSettingsPage(row[0],row[1]+" "+t(row[1]),query);
 return <aside ref={surface} className="settings-navigation"><nav aria-label={t('Settings sections')}>
  <input type="search" aria-label={t("Search settings")} placeholder={t("Search settings")} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key!=="Escape"||event.nativeEvent.isComposing)return;event.preventDefault();event.stopPropagation();if(query)setQuery("");else event.currentTarget.closest("dialog")?.dispatchEvent(new Event("cancel",{cancelable:true}));}}/>
  {settingsPages.slice(0,5).filter(matches).map(item)}
  <details open={!!query||settingsPages.slice(5).some(([id])=>id===current)||undefined}><summary>{t('Advanced options')}</summary>{settingsPages.slice(5).filter(matches).map(item)}</details>
 {sectionMatches.map(([section,label])=><button type="button" key={section} disabled={blocked} onClick={event=>select('support',event,section)}>{t(label)}</button>)}
 {!settingsPages.some(matches)&&!sectionMatches.length&&<p role="status">{t("No matching settings")}</p>}
 </nav>{pending&&<div role="alert" className="settings-discard"><p>{t('Discard unsaved changes?')}</p><button ref={keep} type="button" disabled={blocked} onClick={()=>{setPending(null);origin.current?.focus();}}>{t('Keep editing')}</button><button type="button" disabled={blocked} onClick={()=>{if(blocked)return;const target=pending;setPending(null);if(target!=='close'){onSelect(target.page,target.section);return;}closing.current=true;try{closeAction.current?.();}finally{closing.current=false;closeAction.current=null;}}}>{t('Discard changes')}</button></div>}</aside>;
}
