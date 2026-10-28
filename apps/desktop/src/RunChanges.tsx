// Author: Jeff.Liu. A local read-only baseline never starts or blocks the official CLI.
import {useEffect,useRef,useState} from 'react';
import {invoke as nativeInvoke} from '@tauri-apps/api/core';
import {t} from './i18n';
import {RunChangesController} from './run-changes';
import type {FilesInvoke} from './project-files';
import {GitPatchView} from './GitChanges';
import type {DiffTarget} from './git-diff-navigation';
const labels={modified:'Text modified',deleted:'Text deleted',restored:'Text restored',unrecorded:'No recorded text baseline',untracked:'New untracked name',untracked_removed:'Untracked name removed',unavailable:'Text comparison unavailable'};
function runError(code:string):string {
 switch(code){
  case 'round_limit':return t('Snapshot limit reached. Choose a smaller project directory. The previous baseline is kept.');
  case 'round_storage_full':return t('Baseline storage is full. Clear an unused baseline before recording another.');
  case 'round_capture_changed':case 'git_context_changed':return t('Files changed during capture. Retry when edits settle; the previous baseline is kept.');
  case 'round_context_changed':return t('The project directory changed. Record a new baseline before comparing.');
  case 'round_baseline_changed':return t('The baseline changed. Reload its information before continuing.');
  case 'git_not_repository':return t('A Git repository is required to identify tracked files.');
  case 'file_platform_unavailable':return t('Local baseline comparison is not supported on this platform.');
  case 'round_busy':case 'git_busy':return t('Another snapshot or Git read is in progress. Retry shortly.');
  case 'git_external_filter':case 'git_conversion_unsupported':case 'git_attributes_unsupported':return t('This Git configuration cannot be safely read for a baseline. Native CLI use is unaffected.');
  default:return t('Baseline comparison is unavailable. Retry or reload baseline information.');
 }
}
export function RunChanges({sessionId,root,active,invoke=nativeInvoke,onOpenFile,onReview}:{sessionId:string|null;root:string;active:boolean;invoke?:FilesInvoke;onOpenFile?:(target:DiffTarget)=>void;onReview?:(target:DiffTarget)=>void}) {
 const controller=useRef(new RunChangesController()),mounted=useRef(false);
 const [,refresh]=useState(0),[replace,setReplace]=useState<string|null>(null);
 const c=controller.current,scope=JSON.stringify([sessionId,root]),ready=!!sessionId&&c.scope===scope;
 const baseline=ready?c.baseline:null,report=ready?c.report:null;
 function act(path:string,line:number|null,side:'old'|'new',action:((target:DiffTarget)=>void)|undefined){if(action&&sessionId&&c.scope===scope&&baseline&&c.baseline?.id===baseline.id)action({sessionId,absolutePath:`${baseline.root.replace(/\/$/,'')}/${path}`,line,side,basis:'round'});}
 function run(action:()=>Promise<void>){const pending=action();refresh(v=>v+1);void pending.finally(()=>{if(mounted.current)refresh(v=>v+1);});}
 useEffect(()=>{mounted.current=true;if(active&&sessionId){c.select(sessionId,root);run(()=>c.load(invoke));}return()=>{mounted.current=false;c.cancel();};},[sessionId,root,active,invoke]);
 if(!active)return null;
 return <section className="run-changes" aria-label={t('Run changes')}>
  <h3>{t('Run changes')}</h3>
  <p>{t('Record before starting a task. Differences include human and concurrent edits; authorship is not verified.')}</p>
  {!sessionId?<p>{t('Select a local session to record a baseline.')}</p>:<>
   <div className="project-files-controls">
    <button type="button" disabled={!ready||c.busy} onClick={()=>{if(baseline)setReplace(`${scope}:${baseline.id}`);else run(()=>c.capture(invoke));}}>{baseline?t('Replace baseline'):t('Record baseline')}</button>
    <button type="button" disabled={!baseline||c.busy} onClick={()=>run(()=>c.compare(invoke))}>{t('Compare since baseline')}</button>
    <button type="button" disabled={!ready||c.busy} onClick={()=>run(()=>c.load(invoke))}>{t('Reload baseline information')}</button>
    {baseline&&<button type="button" disabled={c.busy} onClick={()=>{setReplace(null);run(()=>c.clear(invoke));}}>{t('Clear baseline')}</button>}
   </div>
   {baseline&&<p>{t('Baseline recorded')}: {new Date(baseline.captured_at*1000).toLocaleString()} · {baseline.files} {t('tracked paths')} · {baseline.skipped} {t('unavailable text files')}</p>}
   {baseline&&replace===`${scope}:${baseline.id}`&&<div className="project-files-controls"><p>{t('Replace this comparison baseline? Project files will not be changed.')}</p><button type="button" disabled={c.busy} onClick={()=>{setReplace(null);run(()=>c.capture(invoke));}}>{t('Confirm new baseline')}</button><button type="button" onClick={()=>setReplace(null)}>{t('Keep baseline')}</button></div>}
   {ready&&c.busy&&<p role="status">{t('Reading local snapshot…')}</p>}
   {ready&&c.error&&<p role="alert">{runError(c.error)}</p>}
   <p>{t('Tracked working-tree text only. Untracked files compare names only. Index-only changes are not included.')}</p>
   <p>{t('Up to 2048 tracked paths and 16 MiB per baseline; 32 MiB total. Baselines are kept only while this YAM window is open.')}</p>
   {report&&<>
    {report.rows.length===0&&<p role="status">{t('No comparable text changes since baseline.')}</p>}
    {report.skipped>0&&<p role="status">{report.skipped} {t('files could not be compared; binary, large, linked or unreadable files may have changed.')}</p>}
    <ul>{report.rows.map(row=><li key={row.path}><span>{row.path}</span> <small>{t(labels[row.kind])}</small>{['modified','deleted','restored'].includes(row.kind)&&<button type="button" disabled={c.busy} aria-label={t('Compare {{value0}}',{value0:row.path})} onClick={()=>run(()=>c.compare(invoke,row.path))}>{t('View round diff')}</button>}{onOpenFile&&<button type="button" onClick={()=>act(row.path,null,'new',onOpenFile)}>{t('Edit current file')}</button>}{onReview&&<button type="button" onClick={()=>act(row.path,null,'new',onReview)}>{t('Review this file')}</button>}</li>)}</ul>
    {report.patch&&<><h4>{report.patch.path}</h4><GitPatchView key={`${baseline?.id}:${report.patch.path}`} patch={{path:report.patch.path,kind:'text',side:'worktree',text:report.patch.text}} description={t('Round comparison · old: recorded baseline · new: refreshed working-tree snapshot.')} onEditLine={onOpenFile?line=>act(report.patch!.path,line,'new',onOpenFile):undefined} onReviewLine={onReview?(side,line)=>act(report.patch!.path,line,side,onReview):undefined}/></>}
   </>}
  </>}
 </section>;
}
