// Author: Jeff.Liu. Real recovery UI offers only explicit, context-valid actions.
import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';import ts from 'typescript';
const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
const code=text=>ts.transpile(text,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022});
const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(tree){return tree&&typeof tree==='object'?[tree,...(tree.children??[]).flat(Infinity).flatMap(nodes)]:[];}
function text(tree){return typeof tree==='string'?tree:(tree?.children??[]).flat(Infinity).map(text).join('');}
function find(predicate){let found;function visit(n){if(predicate(n))found=n;ts.forEachChild(n,visit);}visit(app);return found;}
function render(message,extra={}){
 const calls=[],handlers={onDiagnostics:()=>calls.push('diagnostics'),onReviewLaunch:()=>calls.push('launch'),...extra};
 const url=new URL('../src/ErrorRecovery.tsx',import.meta.url);let tree;
 if(existsSync(url)){
  const s=ts.createSourceFile('ErrorRecovery.tsx',readFileSync(url,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const fn=s.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ErrorRecovery');assert.ok(fn);
  tree=new Function('React','t',code(fn.getText(s).replace(/^export /,''))+';return ErrorRecovery;')(React,s=>s)({message,...handlers});
 }else{
  const n=find(n=>ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>a.name?.getText(app)==='className'&&a.initializer?.text==='error-banner')&&n.getText(app).includes('Dismiss error'));assert.ok(n);
  const bindings={React,error:message,t:s=>s,desktopWindow:{restore_blocked:false,preference:{}},setError(){},X:()=>null,layoutRestoreRetrying:false,retrySavedLayout(){}};
  tree=new Function(...Object.keys(bindings),code('return ('+n.getText(app)+')'))(...Object.values(bindings));
 }
 return {tree,calls,buttons:nodes(tree).filter(n=>n.type==='button'),text:text(tree)};
}
for(const [message,hint] of [
 ['Working directory does not exist or is not a directory: /fixture/missing','Choose an existing project directory'],
 ['The project directory is unavailable. Choose an existing directory and start the session again.','Choose an existing project directory'],
 ['Working directory does not exist or is not a directory: /tmp/background-unavailable','Choose an existing project directory'],
 ['Cannot save final terminal frame: /tmp/authentication','Keep the affected session open'],
 ['Authentication credentials unavailable','Review the selected connection and credential source'],
 ['Cannot download Node from nodejs.org; check the network and retry','Check the network and endpoint'],
 ['Cannot save final terminal frame: disk full','Keep the affected session open'],
 ['The original background connection is unavailable. Tasks were not restarted.','Reconnect the existing background'],
 ['Unrecognized failure 987','Export diagnostics'],
])test(`recovery explains the next step: ${message.split(':')[0]}`,()=>{const r=render(message);assert.match(r.text,new RegExp(hint));assert.deepEqual(r.calls,[]);assert.ok(r.buttons.every(n=>n.props.type==='button'));});
test('diagnostics and draft review are explicit; backend/save controls require matching context',()=>{
 const r=render('Working directory does not exist or is not a directory: /fixture/missing');
 r.buttons.find(n=>text(n)==='Review launch draft')?.props.onClick();assert.deepEqual(r.calls,['launch']);
 const unknown=render('Unknown');assert.ok(!unknown.buttons.some(n=>/Reconnect|Retry saving/.test(text(n))));unknown.buttons.find(n=>text(n)==='Export diagnostics')?.props.onClick();assert.deepEqual(unknown.calls,['diagnostics']);
});
test('the original technical message stays available without being rendered as markup',()=>{const r=render('Unknown <script>example</script>');const details=nodes(r.tree).find(n=>n.type==='details');assert.ok(details);assert.match(text(details),/<script>example<\/script>/);assert.ok(nodes(r.tree).every(n=>!n.props.dangerouslySetInnerHTML));});
test('recovery never runs actions on render and blocked actions are disabled',()=>{const r=render('Authentication credentials unavailable',{busy:true});assert.deepEqual(r.calls,[]);assert.ok(r.buttons.length>0&&r.buttons.every(n=>n.props.disabled));});
test('App reuses guarded recovery actions in the banner and launch dialog',()=>{
 const uses=[];function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(app)==='ErrorRecovery')uses.push(n);ts.forEachChild(n,visit);}visit(app);assert.ok(uses.length>=2,'both error entrypoints use the real recovery component');
 const generic=uses.find(n=>n.getText(app).includes('onReconnect'));assert.ok(generic);assert.match(generic.getText(app),/ownerConnectionAvailable/);assert.doesNotMatch(generic.getText(app),/onSave=/,'unscoped errors cannot save the selected session');assert.doesNotMatch(generic.getText(app),/create_session|startSession|write_session|saveLaunchDefaults/);
});

test('reconnect remains explicit and unscoped save errors cannot operate on another session',()=>{
 const calls=[];
 const reconnect=render('The background connection is unavailable',{onReconnect:()=>calls.push('reconnect')});
 reconnect.buttons.find(n=>text(n)==='Reconnect background').props.onClick();
 const save=render('Cannot save final terminal frame: disk full',{onSave:()=>calls.push('save')});
 assert.ok(!save.buttons.some(n=>text(n)==='Retry saving session'));
 assert.deepEqual(calls,['reconnect']);
 const other=render('Unrecognized failure',{onReconnect:()=>calls.push('wrong'),onSave:()=>calls.push('wrong')});
 assert.ok(!other.buttons.some(n=>/Reconnect|Retry saving/.test(text(n))));
});
