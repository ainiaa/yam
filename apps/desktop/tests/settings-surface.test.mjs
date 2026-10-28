import {matchesSettingsPage} from '../src/settings-search.ts';
// Author: Jeff.Liu. A shared navigation surface preserves drafts and existing settings controllers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const read=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('all application settings pages receive the same navigation without moving terminal ownership',()=>{
 const source=read('App.tsx');
 for(const name of ['AppAppearance','TerminalSettingsDialog','TerminalProfiles','KeyboardShortcutSettings','UpdaterSettings','TerminalPasteSettings','ZshDirectoryReporting','ZshCommandReporting'])assert.match(source,new RegExp('<'+name+'[^>]*navigation='),name);
 assert.match(source,/function openSettingsSection\(/);
 const start=source.indexOf('function openSettingsSection('),end=source.indexOf('\n  }',start),body=source.slice(start,end);
 assert.doesNotMatch(body,/startNewSession|stopSession|kill|create_session|writeTerminal|terminalViews\.current\.(clear|retain)/);
 assert.match(body,/openMainSettings/);
});
test('navigation has a single narrow-window layout and one scrollable content column',()=>{
 const css=read('App.css');assert.match(css,/\.settings-surface/);assert.match(css,/\.settings-navigation/);assert.match(css,/max-width:\s*640px/);
});
function fixture(dirty){
 const text=read('SettingsNavigation.tsx'),source=ts.createSourceFile('SettingsNavigation.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const code=ts.transpileModule(source.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isTypeAliasDeclaration(n)).map(n=>n.getText(source).replace(/^export /,'')).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 let tree,stateIndex=0;const states=[];const calls=[],focusCalls=[],scrollCalls=[],refs=[],effects=[];let refIndex=0;
 const React={createElement:(type,props,...children)=>{const node={type,props:{...props,children:children.flat(Infinity)}};if(props?.ref)props.ref.current={focus:()=>focusCalls.push(children.flat(Infinity)[0]),scrollIntoView:()=>scrollCalls.push(children.flat(Infinity)[0])};return node;}};
 const run=new Function('React','useState','useRef','useEffect','t','matchesSettingsPage',code+';return SettingsNavigation')(React,initial=>{const i=stateIndex++;if(!(i in states))states[i]=initial;return [states[i],v=>states[i]=v];},()=>refs[refIndex++]??(refs[refIndex-1]={current:null}),effect=>effects.push(effect),s=>s,matchesSettingsPage);
 const nodes=n=>[n,...(n?.props?.children??[]).flatMap(c=>c&&typeof c==='object'?nodes(c):[])];
 const render=()=>{refIndex=0;stateIndex=0;tree=run({current:'appearance',dirty,onSelect:value=>calls.push(value)});for(const effect of effects.splice(0))effect();};render();
 return {calls,focusCalls,scrollCalls,search(value){nodes(tree).find(n=>n.type==='input').props.onChange({target:{value}});render();},click(label){const button=nodes(tree).find(n=>n.type==='button'&&n.props.children.includes(label));assert.ok(button,label);button.props.onClick({currentTarget:{focus:()=>focusCalls.push(label)}});render();},all:()=>nodes(tree)};
}
test('clean navigation changes only the selected settings page',()=>{const f=fixture(false);f.click('Terminal');assert.deepEqual(f.calls,['settings']);});
test('dirty navigation keeps drafts until explicit discard and supports staying',()=>{const f=fixture(true);f.click('Terminal');assert.deepEqual(f.calls,[]);assert.ok(f.all().some(n=>n.props.role==='alert'));f.click('Keep editing');assert.deepEqual(f.calls,[]);assert.ok(!f.all().some(n=>n.props.role==='alert'));f.click('Updates');f.click('Discard changes');assert.deepEqual(f.calls,['updates']);});
test('current page does not discard or reopen the same draft',()=>{const f=fixture(true);f.click('Appearance');assert.deepEqual(f.calls,[]);assert.ok(!f.all().some(n=>n.props.role==='alert'));});
test('embedded system settings does not duplicate its surrounding title',()=>{
 const text=read('SystemEntrySettings.tsx'),source=ts.createSourceFile('SystemEntrySettings.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const fn=source.statements.find(n=>ts.isFunctionDeclaration(n));const React={createElement:(type,props,...children)=>({type,props,children:children.flat(Infinity)})};const run=new Function('React','t',ts.transpileModule(fn.getText(source).replace('export default ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText+';return SystemEntrySettings;')(React,s=>s);const tree=run({showTitle:false,enabled:false,registered:false,available:true,busy:false,warning:'',onChange(){}});assert.ok(!tree.children.some(n=>n?.type==='h3'));
});
test('confirmed departure from profile settings resets its shared draft without starting a process',()=>{
 const text=read('App.tsx'),source=ts.createSourceFile('App.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='openSettingsSection')fn=n;ts.forEachChild(n,walk);}walk(source);
 for(const selectedId of [null,'saved']){const calls=[],bindings={isMainWindow:true,starting:false,systemEntryBusy:false,terminalProfilesOpen:true,terminalProfileCollection:{selectedId},selectTerminalProfile:id=>calls.push(['reset',id]),newTerminalProfile:()=>calls.push(['reset',null]),launchSettingsDialog:{current:{close(){}}},setLaunchDefaultsNotice(){},requestAnimationFrame(){},refreshSystemEntry(){},openMainSettings:assert.fail};
  for(const name of ['DataSettings','Appearance','TerminalSettings','TerminalProfiles','KeyboardShortcuts','PasteSettings','Updater','SystemEntry','DirectoryReporting','CommandReporting'])bindings['set'+name+'Open']=value=>{if(value)calls.push(name);};
  const run=new Function(...Object.keys(bindings),ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return openSettingsSection;')(...Object.values(bindings));run('appearance');assert.deepEqual(calls,[['reset',selectedId],'Appearance']);
 }
});

test('discard controls receive focus and enter the navigation viewport; staying restores the trigger',()=>{const f=fixture(true);f.click('Terminal');assert.equal(f.focusCalls.at(-1),'Keep editing');assert.equal(f.scrollCalls.at(-1),'Keep editing');f.click('Keep editing');assert.equal(f.focusCalls.at(-1),'Terminal');assert.deepEqual(f.calls,[]);});

test('settings grid bodies keep short content at its natural height',()=>{const css=read('App.css');assert.match(css,/settings-surface[^{]*>\s*:is\([^}]+align-content:\s*start/s);});

test('search filters actual settings navigation without discarding or selecting a page',()=>{const f=fixture(true);f.search('自动更新');assert.ok(f.all().some(n=>n.type==='button'&&n.props.children.includes('Updates')));assert.ok(!f.all().some(n=>n.type==='button'&&n.props.children.includes('Terminal')));assert.deepEqual(f.calls,[]);f.click('Updates');assert.ok(f.all().some(n=>n.props.role==='alert'));});

test('Escape in settings search clears a query, then requests dialog cancellation even on WebKit',()=>{
 const text=read('SettingsNavigation.tsx'),source=ts.createSourceFile('SettingsNavigation.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let input;function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='input')input=n;ts.forEachChild(n,visit);}visit(source);assert.ok(input);
 const handler=input.attributes.properties.find(a=>a.name?.getText(source)==='onKeyDown').initializer.expression;
 const code=ts.transpileModule('return ('+handler.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const scenario of ['empty','query','composition','other-key']){
  const calls=[],run=new Function('query','setQuery',code)(scenario==='query'?'font':'',value=>calls.push(['query',value]));
  run({key:scenario==='other-key'?'Tab':'Escape',nativeEvent:{isComposing:scenario==='composition'},preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop'),currentTarget:{closest:selector=>{assert.equal(selector,'dialog');return {dispatchEvent:event=>{assert.equal(event.type,'cancel');assert.equal(event.cancelable,true);calls.push('cancel');}};}}});
  assert.deepEqual(calls,scenario==='empty'?['prevent','stop','cancel']:scenario==='query'?['prevent','stop',['query','']]:[],scenario);
 }
});
