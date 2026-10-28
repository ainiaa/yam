// Author: Jeff.Liu. Exercise CodeMirror's real state API without creating a DOM view.
import test from 'node:test';import assert from 'node:assert/strict';
import {createFileEditorState,syntaxForPath,mountFileEditor} from '../src/file-editor.ts';
import {language} from '@codemirror/language';
import {EditorView} from 'codemirror';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const commands=await import(require.resolve('@codemirror/commands',{paths:[require.resolve('codemirror')]}));
test('native editor state handles inert text and common source language extensions',async()=>{
 for(const name of ['a.ts','a.js','a.rs','a.py','a.java','a.sql','a.sh','a.json','a.yaml','a.toml','README.md','a.css','a.html','unknown.bin']){
  const syntax=await syntaxForPath(name);const state=createFileEditorState('<script>literal</script>\n',{language:syntax});assert.equal(state.doc.toString(),'<script>literal</script>\n');assert.equal(state.facet(language)!==null,!['README.md','unknown.bin'].includes(name));
  const next=state.update({changes:{from:0,to:8,insert:'changed'}}).state;assert.match(next.doc.toString(),/^changed/);
 }
 assert.equal(createFileEditorState('read only',{readOnly:true}).readOnly,true);
});
test('oversized or binary edits are rejected without dropping existing text',()=>{
 const errors=[],state=createFileEditorState('kept',{onInvalid:code=>errors.push(code)});
 const large=state.update({changes:{from:0,to:4,insert:'中'.repeat(400000)}}).state;assert.equal(large.doc.toString(),'kept');assert.equal(errors.at(-1),'file_too_large');
 const binary=state.update({changes:{from:0,to:4,insert:'bad\0text'}}).state;assert.equal(binary.doc.toString(),'kept');assert.equal(errors.at(-1),'files_binary');
 assert.equal(state.update({changes:{from:4,insert:' safe'}}).state.doc.toString(),'kept safe');
});

test('actual editor wrapper handles save, locked state and IME without a browser',()=>{
 const raw=readFileSync(new URL('../src/ProjectTextEditor.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('ProjectTextEditor.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
 const component=new Function('React','useEffect','useLayoutEffect','useRef','useState','t',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return ProjectTextEditor;')(React,()=>{},()=>{},value=>({current:value}),value=>[value,()=>{}],v=>v);
 for(const [disabled,composing,expected] of [[false,false,1],[true,false,0],[false,true,0]]){
  let saves=0,prevented=0,stopped=0;const tree=component({value:'text',filename:'a.ts',disabled,onChange(){},onInvalid(){},onSave(){saves++;}});
  tree.props.onKeyDownCapture({ctrlKey:true,metaKey:false,altKey:false,key:'s',nativeEvent:{isComposing:composing},preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.equal(saves,expected);assert.equal(prevented,1);assert.equal(stopped,1);
 }
});

test('real state and view adapter separate user edits from controlled refresh and enforce lock facets',()=>{
 let view,destroyed=0,dispatches=0;const changes=[],errors=[],parent={};
 const handle=mountFileEditor(parent,{text:'base',language:[],disabled:false,label:'File text',onChange:text=>changes.push(text),onInvalid:code=>errors.push(code)},config=>{
  assert.equal(config.parent,parent);view={state:config.state,setState(state){this.state=state;dispatches++;},dispatch(spec){dispatches++;const transaction=this.state.update(spec);this.state=transaction.state;for(const listener of this.state.facet(EditorView.updateListener))listener({state:this.state,docChanged:transaction.docChanged});},destroy(){destroyed++;}};return view;
 });
 view.dispatch({changes:{from:4,insert:' edited'}});assert.deepEqual(changes,['base edited']);
 handle.sync('disk version',true);assert.equal(view.state.doc.toString(),'disk version');assert.equal(view.state.readOnly,true);assert.equal(view.state.facet(EditorView.editable),false);assert.deepEqual(changes,['base edited']);assert.equal(commands.undoDepth(view.state),0);
 const count=dispatches;handle.sync('disk version',true);assert.equal(dispatches,count);
 handle.sync('disk version',false);assert.equal(view.state.readOnly,false);assert.equal(view.state.facet(EditorView.editable),true);
 view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'bad\0text'}});assert.equal(errors.at(-1),'files_binary');assert.equal(view.state.doc.toString(),'disk version');
 handle.destroy();assert.equal(destroyed,1);
});
test('initial editor input obeys exact byte and binary limits',()=>{
 assert.equal(createFileEditorState('x'.repeat(1048576)).doc.length,1048576);
 assert.throws(()=>createFileEditorState('x'.repeat(1048577)),error=>error==='file_too_large');
 assert.throws(()=>createFileEditorState('\0'),error=>error==='files_binary');
});

test('line reveal uses the current editor document, clamps stale positions and never changes text',()=>{
 let view,focused=0;const handle=mountFileEditor({}, {text:'one\ntwo\nthree',language:[],disabled:false,label:'File',onChange(){},onInvalid(){}},config=>{view={state:config.state,dispatch(spec){this.state=this.state.update(spec).state;},focus(){focused++;},destroy(){}};return view;});
 assert.equal(handle.revealLine(2),true);assert.equal(view.state.selection.main.head,4);
 assert.equal(handle.revealLine(99),false);assert.equal(view.state.selection.main.head,8);
 const count=focused;assert.equal(handle.revealLine(0),false);assert.equal(focused,count);assert.equal(view.state.doc.toString(),'one\ntwo\nthree');handle.destroy();
});

test('editor snapshot restores selection and native history with fresh callbacks, but rejects stale text',()=>{
 let first,second;const options={text:'base',language:[],disabled:false,label:'File',onChange(){},onInvalid(){}};
 const nativeScroll={nativeScroll:true};const create=config=>{const view={state:config.state,scrollTo:config.scrollTo,scrollSnapshot:()=>nativeScroll,dispatch(spec){const tr=this.state.update(spec);this.state=tr.state;for(const listener of this.state.facet(EditorView.updateListener))listener({state:this.state,docChanged:tr.docChanged});},destroy(){}};return view;};
 const a=mountFileEditor({},options,c=>first=create(c));first.dispatch({changes:{from:4,insert:' edit'},selection:{anchor:2}});const snapshot=a.snapshot();a.destroy();
 assert.equal(commands.undoDepth(snapshot.state),1);
 const changes=[];const b=mountFileEditor({},{...options,text:'base edit',snapshot,onChange:text=>changes.push(text)},c=>second=create(c));assert.equal(second.state.selection.main.head,2);assert.equal(second.scrollTo,nativeScroll);assert.equal(commands.undoDepth(second.state),1);assert.equal(commands.undo({state:second.state,dispatch:tr=>second.dispatch(tr)}),true);assert.equal(second.state.doc.toString(),'base');
 second.dispatch({changes:{from:4,insert:'!'}});assert.deepEqual(changes,['base','base!']);
 const c=mountFileEditor({},{...options,text:'disk replaced',snapshot},create);assert.equal(c.snapshot().state.selection.main.head,0);assert.equal(c.snapshot().state.doc.toString(),'disk replaced');b.destroy();c.destroy();
});

 test('editor snapshot cleanup runs before React detaches the scrolling DOM',()=>{
  const source=readFileSync(new URL('../src/ProjectTextEditor.tsx',import.meta.url),'utf8');
  assert.match(source,/useLayoutEffect\(\(\)=>\{[\s\S]*?return\(\)=>\{disposed=true;[\s\S]*?snapshot\(\)/);
 });

test('revealing a delayed file location can retain focus in another input',()=>{
 let focus=0,view;const h=mountFileEditor({}, {text:'a\nb',language:[],disabled:false,label:'File',onChange(){},onInvalid(){}},config=>{view={state:config.state,dispatch(spec){this.state=this.state.update(spec).state;},focus(){focus++;},destroy(){}};return view;});
 assert.equal(h.revealLine(2,false),true);assert.equal(view.state.selection.main.head,2);assert.equal(focus,0);h.focus();assert.equal(focus,1);h.destroy();
});
