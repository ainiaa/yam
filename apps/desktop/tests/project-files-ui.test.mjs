// Author: Jeff.Liu. Executes the component without launching a desktop app.
import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {ProjectFilesController,relativeProjectFile} from '../src/project-files.ts';
function fixture(){
 const raw=readFileSync(new URL('../src/ProjectFiles.tsx',import.meta.url),'utf8'),source=ts.createSourceFile('ProjectFiles.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n');
 const slots=[],effects=[],calls=[];let at=0,queue=[],tree,refreshAction;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useRef=value=>{const i=at++;return slots[i]??(slots[i]={current:value});};
 const useState=value=>{const i=at++;if(!(i in slots))slots[i]=value;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];};
 const useEffect=(fn,deps)=>{const i=at++;if(!effects[i]||deps.some((v,k)=>v!==effects[i].deps[k]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const component=new Function('React','useRef','useState','useEffect','ProjectFilesController','watchProjectRefresh','nativeInvoke','t','ProjectTextEditor','relativeProjectFile',ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText+';return ProjectFiles;')(React,useRef,useState,useEffect,ProjectFilesController,action=>{refreshAction=action;return()=>{refreshAction=null;};},()=>{},v=>v,'project-editor',relativeProjectFile);
 let disk='one\n',conflict=false;const invoke=async(name,args)=>{calls.push([name,args]);if(name==='list_project_files')return [{name:'src',directory:true},{name:'a.txt',directory:false}];if(name==='save_project_text'){if(conflict)throw 'file_changed';disk=args.text;}return {text:disk,revision:createHash('sha256').update(disk).digest('hex')};};
 const props={sessionId:'s-one',root:'/repo',active:true,invoke};
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const render=(flush=true)=>{at=0;tree=component(props);if(flush){const batch=queue;queue=[];batch.forEach(fn=>fn());}};
 const settle=async()=>{await new Promise(r=>setImmediate(r));render();};
 const button=label=>nodes(tree).find(n=>n.type==='button'&&n.props.children.filter(v=>typeof v==='string').join('').trim()===label);
 render();return {props,calls,render,settle,button,refresh:()=>refreshAction?.(),nodes:()=>nodes(tree),text:()=>JSON.stringify(tree),editor:()=>nodes(tree).find(n=>n.type==='project-editor'),conflict:()=>conflict=true,disk:value=>disk=value,cleanup:()=>effects.forEach(e=>e?.cleanup?.())};
}
test('actual file panel browses directories, edits inert text and wires the explicit editor save action',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();assert.equal(f.editor().props.value,'one\n');
 f.editor().props.onChange('<script>literal</script>\n');f.render();assert.match(f.text(),/Unsaved changes/);assert.equal(f.calls.filter(([n])=>n==='save_project_text').length,0);
 f.editor().props.onSave();await f.settle();assert.match(f.text(),/Saved/);assert.equal(f.nodes().some(n=>['script','iframe'].includes(n.type)),false);
 f.button('src').props.onClick();await f.settle();assert.equal(f.calls.at(-1)[1].path,'src');f.button('Parent directory').props.onClick();await f.settle();assert.equal(f.calls.at(-1)[1].path,'');f.cleanup();
});
test('conflict retains draft, reloading requires explicit discard and closing panel retains edits',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();f.editor().props.onChange('mine');f.render();
 f.conflict();f.button('Save file').props.onClick();await f.settle();assert.match(f.text(),/changed on disk/);assert.equal(f.editor().props.value,'mine');
 f.props.active=false;f.render();f.props.active=true;f.render();await f.settle();f.button('a.txt').props.onClick();await f.settle();assert.equal(f.editor().props.value,'mine');
 f.disk('AI changed');f.button('Reload from disk').props.onClick();f.render();assert.equal(f.editor().props.value,'mine');f.button('Keep editing').props.onClick();f.render();assert.equal(f.button('Discard draft and reload'),undefined);
 f.button('Reload from disk').props.onClick();f.render();f.button('Discard draft and reload').props.onClick();await f.settle();assert.equal(f.editor().props.value,'AI changed');f.cleanup();
});
test('scope change hides the old view before effects and revalidates shared project buffers',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();f.props.sessionId='s-other';f.render(false);assert.equal(f.editor(),undefined);f.render();await f.settle();assert.equal(f.editor().props.value,'one\n');
 const before=f.calls.length;f.props.sessionId=null;f.render();await f.settle();assert.equal(f.calls.length,before);assert.match(f.text(),/Select a local session/);f.cleanup();
});
test('file panel and native commands are wired into existing project tools and accessible outside Git repositories',()=>{
 const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),native=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
 assert.match(app,/<ProjectFiles\s/);assert.match(app,/t\("Files"\)/);assert.match(app,/<GitChanges\s/);
 for(const name of ['list_project_files','read_project_text','save_project_text'])assert.match(native,new RegExp(`project_files::${name}`));
});

test('file tabs close safely and external modification checks retain unsaved text',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();f.editor().props.onChange('mine');f.render();
 assert.ok(f.nodes().some(n=>n.props?.['aria-label']==='Open project files'));
 f.disk('outside');f.button('Check external changes').props.onClick();await f.settle();assert.match(f.text(),/External conflict/);assert.equal(f.editor().props.value,'mine');assert.equal(f.button('Save file').props.disabled,true);f.cleanup();
});

test('an explicit diff request opens its original session file and does not repeat on unrelated renders',async()=>{
 const f=fixture();await f.settle();f.props.request={id:1,sessionId:'s-one',path:'a.txt',line:2};f.render();await f.settle();
 assert.equal(f.editor().props.filename,'a.txt');assert.equal(f.editor().props.location.line,2);const count=f.calls.length;f.render();await f.settle();assert.equal(f.calls.length,count);
 f.props.request={id:2,sessionId:'different',path:'a.txt',line:1};f.render();await f.settle();assert.equal(f.calls.length,count);f.cleanup();
});
test('a late same-file diff request cannot restore its older line after a newer request completed',async()=>{
 const f=fixture();await f.settle();let release,reads=0;
 f.props.invoke=async name=>{if(name==='list_project_files')return [];if(++reads===1)return await new Promise(resolve=>release=resolve);return {text:'current\n',revision:'a'.repeat(64)};};
 f.props.request={id:1,sessionId:'s-one',path:'a.txt',line:2};f.render();
 f.props.request={id:2,sessionId:'s-one',path:'a.txt',line:20};f.render();await f.settle();await f.settle();assert.equal(f.editor().props.location.id,2);
 release({text:'older\n',revision:'b'.repeat(64)});await f.settle();await f.settle();assert.equal(f.editor().props.location.id,2);f.cleanup();
});
test('unsupported native platform is explained and repeated refresh is disabled',async()=>{
 const f=fixture();await f.settle();f.props.invoke=async()=>{throw 'file_platform_unavailable';};f.render();await f.settle();assert.match(f.text(),/Local file browsing and editing are not supported on this platform/);assert.equal(f.button('Refresh files').props.disabled,true);f.cleanup();
});

 test('background file refresh retains dirty text, detects disk conflicts and stops when hidden',async()=>{
  const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();f.editor().props.onChange('my draft');f.render();f.disk('AI changed disk');await f.refresh();f.render();assert.equal(f.editor().props.value,'my draft');assert.equal(f.button('Save file').props.disabled,true);assert.match(f.text(),/External conflict/);
  f.props.active=false;f.render();const count=f.calls.length;await f.refresh();assert.equal(f.calls.length,count);f.cleanup();
 });
 test('file tabs and panel hiding retain editor memory, while explicit close starts a fresh memory',async()=>{
  const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();const memory=f.editor().props.memory;
  f.props.active=false;f.render();f.props.active=true;f.render();await f.settle();assert.equal(f.editor().props.memory,memory);
  const close=f.nodes().find(n=>n.props?.['aria-label']==='Close file {{value0}}');close.props.onClick();f.render();f.button('a.txt').props.onClick();await f.settle();assert.notEqual(f.editor().props.memory,memory);f.cleanup();
 });

test('file-scoped close shortcut closes the current clean file and exposes the same native close target',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();
 const close=f.nodes().find(n=>n.props?.['data-close-active-file']===true);assert.ok(close,'native menu must use the active editor close action');
 const root=f.nodes().find(n=>n.props?.className==='project-files');assert.equal(typeof root.props.onKeyDownCapture,'function');
 let prevented=0,stopped=0;root.props.onKeyDownCapture({key:'w',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false,nativeEvent:{isComposing:false},preventDefault(){prevented++;},stopPropagation(){stopped++;}});f.render();assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(f.editor(),undefined);f.cleanup();
});

function visibleFileText(node){
 if(!node||typeof node!=="object")return typeof node==='string'?node:'';
 if(node.props?.hidden)return '';
 const children=node.type==='details'&&!node.props.open?node.props.children.filter(child=>child?.type==='summary'):node.props.children;
 return children.map(visibleFileText).join(' ');
}
test('file panel starts with one title, explicit save and closed maintenance/help disclosures',async()=>{
 const f=fixture();await f.settle();f.button('a.txt').props.onClick();await f.settle();
 assert.equal(f.nodes().filter(node=>node.type==='h3').length,0);
 const root=f.nodes()[0],visible=visibleFileText(root);
 assert.match(visible,/Save file/);assert.doesNotMatch(visible,/Reload from disk|Check external changes|up to 16 drafts and 2 MiB/);
 assert.ok(f.button('Reload from disk'));assert.ok(f.button('Check external changes'));
 f.editor().props.onChange('keep mine');f.render();f.disk('outside');await f.refresh();f.render();
 assert.match(visibleFileText(f.nodes()[0]),/External conflict/);assert.match(visibleFileText(f.nodes()[0]),/Reload from disk/);
 assert.equal(f.button('Save file').props.disabled,true);assert.equal(f.editor().props.value,'keep mine');f.cleanup();
});
