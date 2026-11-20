// Author: Jeff.Liu. Preview the exact draft before it enters the CLI input buffer.
import {useEffect,type RefObject} from 'react';
import {t} from './i18n';
import type {TerminalPasteText} from './terminal-paste';
import type {TerminalSelectionOrigin} from './terminal-selection-context';

export function TerminalSelectionContext({content,source,dialog,onConfirm,onCancel}:{
 content:TerminalPasteText;source:TerminalSelectionOrigin&{title:string};dialog:RefObject<HTMLDialogElement|null>;
 onConfirm:()=>void;onCancel:()=>void;
}){
 useEffect(()=>{dialog.current?.showModal();},[dialog]);
 return <dialog ref={dialog} className="app-dialog terminal-paste-dialog" aria-labelledby="terminal-selection-context-title"
  onCancel={event=>{event.preventDefault();onCancel();}} onKeyDown={event=>{if(event.key==='Enter'||event.keyCode===229){event.preventDefault();event.stopPropagation();}}}>
  <header className="dialog-header"><h2 id="terminal-selection-context-title">{t('Preview Agent draft')}</h2></header>
  <section className="dialog-fields">
   <p>{t('Source session')}: {source.title}</p>
   <p>{t('Directory')}: {source.cwd}</p>
   <textarea className="terminal-paste-preview" aria-label={t('Agent draft')} readOnly value={content.text}/>
   {source.managedCodex&&<p>{t('Managed Codex uses a single line with line breaks preserved as JSON escapes.')}</p>}
   <p>{t('Confirm fills the Agent input. Press Enter in the terminal when you are ready to send.')}</p>
  </section>
  <footer className="dialog-actions">
   <button type="button" autoFocus onClick={onCancel}>{t('Cancel')}</button>
   <button type="button" onClick={onConfirm}>{t('Fill Agent draft')}</button>
  </footer>
 </dialog>;
}
