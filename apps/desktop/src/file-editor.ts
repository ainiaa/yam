// Author: Jeff.Liu. CodeMirror owns editing, history, search and syntax parsing.
import {EditorState,Compartment,Transaction,StateEffect,type Extension} from '@codemirror/state';
import {EditorView,basicSetup} from 'codemirror';
import {StreamLanguage,HighlightStyle,syntaxHighlighting} from '@codemirror/language';
import {tags} from '@lezer/highlight';
const colors=syntaxHighlighting(HighlightStyle.define([
 {tag:tags.keyword,color:'var(--accent)',fontWeight:'bold'},
 {tag:[tags.string,tags.regexp],color:'var(--accent)'},
 {tag:tags.comment,color:'var(--muted)',fontStyle:'italic'},
 {tag:[tags.number,tags.bool,tags.atom],fontWeight:'bold'},
]));
export async function syntaxForPath(path:string):Promise<Extension>{
 const ext=path.toLowerCase().split('.').pop();
 switch(ext){
  case 'ts':case 'tsx':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).typescript);
  case 'js':case 'jsx':case 'mjs':case 'cjs':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).javascript);
  case 'json':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).json);
  case 'rs':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/rust')).rust);
  case 'py':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/python')).python);
  case 'java':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).java);
  case 'sql':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/sql')).standardSQL);
  case 'sh':case 'bash':case 'zsh':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
  case 'yaml':case 'yml':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/yaml')).yaml);
  case 'toml':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
  case 'css':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/css')).css);
  case 'html':case 'xml':return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/xml')).xml);
  default:return [];
 }
}
type StateOptions={state?:EditorState;language?:Extension;readOnly?:boolean;onInvalid?:(code:string)=>void;extensions?:Extension};
const invalid=(text:string)=>text.includes('\0')?'files_binary':new TextEncoder().encode(text).length>1048576?'file_too_large':null;
export function createFileEditorState(text:string,options:StateOptions={}):EditorState{
 const error=invalid(text);if(error)throw error;
 const extensions:Extension=[basicSetup,colors,options.language??[],options.readOnly?EditorState.readOnly.of(true):[],options.extensions??[],EditorState.changeFilter.of(transaction=>{
  if(!transaction.docChanged)return true;const error=invalid(transaction.newDoc.toString());if(error)options.onInvalid?.(error);return error===null;
 })];
 return options.state?.doc.toString()===text?options.state.update({effects:StateEffect.reconfigure.of(extensions)}).state:EditorState.create({doc:text,extensions});
}
export type FileEditorSnapshot={state:EditorState;scroll?:ReturnType<EditorView["scrollSnapshot"]>};
export type FileEditorHandle={snapshot:()=>FileEditorSnapshot;sync:(text:string,disabled:boolean)=>void;revealLine:(line:number,focus?:boolean)=>boolean;focus:()=>void;destroy:()=>void};
export function mountFileEditor(parent:HTMLElement,options:{snapshot?:FileEditorSnapshot;text:string;language:Extension;disabled:boolean;label:string;onChange:(text:string)=>void;onInvalid:(code:string)=>void},createView:(config:ConstructorParameters<typeof EditorView>[0])=>EditorView=config=>new EditorView(config)):FileEditorHandle{
 const lock=new Compartment();let syncing=false,disabled=options.disabled;
 const editable=(value:boolean)=>[EditorState.readOnly.of(value),EditorView.editable.of(!value)];
 const build=(text:string,locked:boolean,previous?:EditorState)=>createFileEditorState(text,{state:previous,language:options.language,onInvalid:options.onInvalid,extensions:[lock.of(editable(locked)),EditorView.contentAttributes.of({'aria-label':options.label}),EditorView.theme({'&':{backgroundColor:'transparent',color:'var(--text)'},'.cm-gutters':{backgroundColor:'var(--surface)',color:'var(--muted)',borderColor:'var(--border)'},'.cm-scroller':{fontFamily:'var(--font-mono, monospace)'},'.cm-content':{caretColor:'var(--text)'},'.cm-cursor, .cm-dropCursor':{borderLeftColor:'var(--text)'}}),EditorView.updateListener.of(update=>{if(update.docChanged&&!syncing)options.onChange(update.state.doc.toString());})]});
 const state=build(options.text,disabled,options.snapshot?.state);
 const view=createView({state,parent,scrollTo:options.snapshot?.state.doc.toString()===options.text?options.snapshot.scroll:undefined});
 return {
  snapshot(){return{state:view.state,scroll:view.scrollSnapshot?.()};},
  sync(text,nextDisabled){
   const changed=view.state.doc.toString()!==text,effects=nextDisabled===disabled?[]:[lock.reconfigure(editable(nextDisabled))];
   disabled=nextDisabled;if(!changed&&!effects.length)return;
   syncing=true;try{if(changed)view.setState(build(text,nextDisabled));else view.dispatch({effects,annotations:Transaction.addToHistory.of(false)});}finally{syncing=false;}
  },
  focus(){view.focus();},
  revealLine(line,focus=true){
   if(!Number.isSafeInteger(line)||line<1)return false;
   const target=view.state.doc.line(Math.min(line,view.state.doc.lines));
   view.dispatch({selection:{anchor:target.from},scrollIntoView:true});if(focus)view.focus();return line<=view.state.doc.lines;
  },
  destroy(){view.destroy();},
 };
}
