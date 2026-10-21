import {englishUiRead} from './fixtures/english-ui-source.mjs';
import './fixtures/i18n-test-init.mjs';
import {nativeSettings} from './fixtures/native-settings.mjs';
import {componentFunction} from './fixtures/component-function.mjs';
import {defaultTerminalLineHeight,parseTerminalLineHeight} from '../src/terminal-line-height.ts';
import {TERMINAL_SCROLLBACK_LINES} from '../src/terminal-frame.ts';
import {terminalCursorOptions,defaultTerminalCursor} from '../src/terminal-cursor.ts';
import * as windowContext from '../src/window-context.ts';
// Author: Jeff.Liu. Synthetic native events execute the actual view factory and ordinary onData.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import * as paste from '../src/terminal-paste.ts';
import * as layout from '../src/terminal-layout.ts';
const tree=ts.createSourceFile('App.tsx',englishUiRead(fs.readFileSync,new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function code(name){let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);return found??'';}
const clipboard=ts.createSourceFile('Clipboard.ts',englishUiRead(fs.readFileSync,new URL('../node_modules/@xterm/xterm/src/browser/Clipboard.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const clipboardFns=clipboard.statements.filter(n=>ts.isFunctionDeclaration(n)&&['prepareTextForTerminal','bracketTextForPaste','paste'].includes(n.name?.text)).map(n=>n.getText(clipboard).replace('export ',''));
const installedPaste=componentFunction(ts.transpile(clipboardFns.join('\n'),{target:ts.ScriptTarget.ES2022})+';return paste')();
let factory;function find(n){if(ts.isBinaryExpression(n)&&n.left.getText(tree)==='createView.current'&&ts.isArrowFunction(n.right))factory=n.right.getText(tree);ts.forEachChild(n,find);}find(tree);assert.ok(factory);
export function harness(extra={}){
 const sends=[],entries=[],order=[],elements=[];const document={activeElement:null,hasFocus:()=>true,createElement(){const e={className:'',style:{},dataset:{},listeners:new Map(),append(){},remove(){},contains:t=>t===e.textarea,addEventListener:(name,fn,capture)=>e.listeners.set(name,{fn,capture}),removeEventListener:(name)=>e.listeners.delete(name)};elements.push(e);return e;}};
 class Terminal{constructor(){this.modes={mouseTrackingMode:'none'};this.cols=80;this.rows=24;this.bracketed=false;}loadAddon(){}open(e){this.element=e;this.textarea={value:'',matches:s=>s==='textarea.xterm-helper-textarea'||s==='.xterm-helper-textarea'};e.textarea=this.textarea;}onData(fn){this.data=fn;return{dispose(){}};}onScroll(){return{dispose(){}};}dispose(){}focus(){order.push('focus');document.activeElement=this.textarea;}paste(text){entries.push(text);installedPaste(text,this.textarea,{decPrivateModes:{bracketedPasteMode:this.bracketed},triggerDataEvent:data=>this.data(data)},{rawOptions:{ignoreBracketedPasteMode:false}});}}
 const refs={fileDropPending:{current:null},fileDropDialog:{current:{close(){}}},pastePending:{current:null},pasteDialog:{current:{close(){order.push('close');document.activeElement=null;}}},pasteModeRef:{current:'risky'},ownerConnectionAvailable:{current:{available:true,version:0}},terminalLayoutRef:{current:{mode:'single',panes:['s-a'],focused:0,revision:0}},selectionVersion:{current:0},sessionId:{current:'s-a'},zoomedPaneIdRef:{current:null},terminalViews:{current:{get:()=>view}},terminalSettingsRef:{current:{}},terminalHost:{current:{append(){}}},terminalMounted:{current:true}};
 let preview=null;const errors=[];const bindings={terminalReopen:{current:null},terminalWindowClaim:windowContext.terminalWindowClaim,isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),installTerminalLinks:()=>({dispose(){}}),shortcutMac:false,...layout,...paste,...refs,document,window:{addEventListener(){},removeEventListener(){}},Terminal,FitAddon:class{},terminalLineHeightRef:{current:defaultTerminalLineHeight},terminalCursorRef:{current:defaultTerminalCursor},TERMINAL_SCROLLBACK_LINES,terminalCursorOptions,terminalSystemThemeRef:{current:"dark"},terminalOptions:()=>({}),syncViewSize(){},handleTerminalScroll(){},setRecoveryRevision(){},setError:e=>errors.push(e),setFileDropPreview(){},setPastePreview:v=>preview=v,invoke:async(name,args)=>{if(name==='release_terminal_view')return;sends.push([name,args]);if(extra.reject)throw Error('Another desktop currently controls this terminal');},...extra.bindings};
 const functions=['cancelTerminalFileDrop','terminalPaneVisible','terminalHasInputFocus','terminalPasteTarget','terminalPasteCurrent','cancelTerminalPaste','confirmTerminalPaste','captureTerminalPaste','validatePendingTerminalPaste'].map(code).filter(Boolean).join('\n');
 const run=componentFunction(...Object.keys(bindings),ts.transpile(functions+'\nconst factory='+factory,{target:ts.ScriptTarget.ES2022})+';return {factory,confirm:typeof confirmTerminalPaste==="function"?confirmTerminalPaste:null,cancel:typeof cancelTerminalPaste==="function"?cancelTerminalPaste:null,validate:typeof validatePendingTerminalPaste==="function"?validatePendingTerminalPaste:null}')(...Object.values(bindings));
 const view=run.factory('s-a');view.cursor=0;view.live=true;view.firstAttachment=true;Object.assign(view,extra.view);document.activeElement=view.instance.textarea;
 function native(text,target=view.instance.textarea,types=['text/plain']){const ev={target,clipboardData:{types,getData:()=>text},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};view.element.listeners.get('paste')?.fn(ev);if(!ev.stopped)view.instance.paste(text);return ev;}
 return{...refs,document,view,sends,entries,errors,order,native,...run,get preview(){return preview;}};
}
for(const [name,text] of [['multiline','one\ntwo'],['control','safe\x1b[31m'],['oversize','x'.repeat(131073)]])test('A04a actual capture stops '+name+' before xterm can send',()=>{const h=harness();const event=h.native(text);assert.equal(event.stopped,true,'native capture must stop xterm before its bubble handler');assert.equal(event.prevented,true);assert.equal(h.sends.length,0);});

test('A04a confirm closes restores actual focus and sends original once through installed paste and ordinary onData',async()=>{for(const state of [{frameInstance:null,writable:false},{ready:true,firstAttachment:false,writable:false},{projection:true,cursor:null,firstAttachment:false,frameInstance:'parser',writable:false}]){const h=harness({view:state}),text='空 格\r\nline\n';const event=h.native(text);assert.equal(h.sends.length,0);assert.equal(event.prevented,true);assert.equal(h.view.element.listeners.get('paste').capture,true);h.document.activeElement={dialog:true};h.view.instance.bracketed=true;h.confirm();h.confirm();await new Promise(setImmediate);assert.deepEqual(h.order,['close','focus']);assert.deepEqual(h.entries,[text]);assert.deepEqual(h.sends,[['write_session',{desktopGeneration:0,sessionId:'s-a',data:'\x1b[200~空 格\rline\r\x1b[201~'}]]);assert.equal(h.view.writable,true);assert.equal(h.pastePending.current,null);}});
test('A04a pending cannot be overwritten and cancel disposes plaintext without sending',()=>{const h=harness();h.native('first\n');const first=h.pastePending.current;h.native('second\n');assert.equal(h.pastePending.current,first);h.cancel();assert.equal(h.pastePending.current,null);assert.equal(h.preview,null);assert.equal(h.sends.length,0);assert.equal(h.entries.length,0);});
test('A04a each observed identity eligibility and focus change refuses confirmation',()=>{for(const change of [h=>h.view.disposed=true,h=>h.view.live=false,h=>h.view.availability='owner_unavailable',h=>h.view.cursor=null,h=>{h.view.ready=false;h.view.firstAttachment=false;},h=>h.ownerConnectionAvailable.current.available=false,h=>h.ownerConnectionAvailable.current.version++,h=>h.view.frameInstance='changed',h=>h.view.attachVersion=1,h=>h.view.lifecycleRevision++,h=>h.sessionId.current='other',h=>h.selectionVersion.current++,h=>h.terminalLayoutRef.current.revision++,h=>h.terminalLayoutRef.current.panes=['other'],h=>h.terminalViews.current.get=()=>({...h.view}),h=>h.view.instance={...h.view.instance},h=>h.document.hasFocus=()=>false,h=>h.view.instance.focus=()=>{}]){const h=harness();h.native('text\n');h.document.activeElement={dialog:true};change(h);h.confirm();assert.equal(h.sends.length,0);assert.equal(h.entries.length,0);assert.equal(h.pastePending.current,null);}});
test('A04a safe and never paste use unchanged bubble path while empty and invalid text send zero',async()=>{const h=harness();const safe=h.native('one line 空格');assert.equal(safe.stopped,undefined);assert.equal(h.sends.length,1);h.pasteModeRef.current='never';h.native('next\n');await new Promise(setImmediate);assert.equal(h.sends.length,2);for(const text of ['', '\ud800','x'.repeat(131073)]){const ev=h.native(text);assert.equal(ev.stopped,true);assert.equal(h.sends.length,2);}const other={matches:()=>false};const ev=h.native('one\ntwo',other);assert.equal(ev.stopped,undefined);const absent=h.native('one\ntwo',h.view.instance.textarea,['image/png']);assert.equal(absent.stopped,undefined);});
test('A04a view disposal removes capture listener and clears pending without replay',()=>{const h=harness();h.native('pending\n');h.view.dispose();assert.equal(h.view.element.listeners.has('paste'),false);assert.equal(h.pastePending.current,null);assert.equal(h.sends.length,0);});
test('A04a backend-only ownership conflict attempts ordinary write once without control or retry',async()=>{const h=harness({reject:true});h.native('command\n');h.document.activeElement={dialog:true};h.confirm();await new Promise(setImmediate);assert.deepEqual(h.sends.map(x=>x[0]),['write_session']);assert.equal(h.view.writable,false);assert.equal(h.errors.at(-1),'Error: Another desktop currently controls this terminal. Pending terminal input was discarded; check the prompt before typing again.');assert.equal(h.pastePending.current,null);h.confirm();assert.equal(h.sends.length,1);});

function nodes(root){const all=[];function visit(n){if(n&&typeof n==='object'){all.push(n);for(const c of n.children??[])Array.isArray(c)?c.forEach(visit):visit(c);}}visit(root);return all;}
function component(name,hooks={}){const text=englishUiRead(fs.readFileSync,new URL('../src/TerminalPastePreview.tsx',import.meta.url),'utf8'),parsed=ts.createSourceFile('TerminalPastePreview.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(fn);return componentFunction('React','useRef','useEffect','useState',ts.transpile(fn.getText(parsed).replace('export ',''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})+';return '+name)({createElement:(type,props,...children)=>({type,props:props??{},children})},()=>({current:null}),()=>{},hooks.state??(initial=>[initial,()=>{}]));}
test('A04a actual preview Cancel Escape composition repeat and Enter never confirm automatically',()=>{let confirms=0,cancels=0;const render=component('TerminalPastePreview'),all=nodes(render({content:paste.inspectTerminalPaste('text\n'),dialog:{current:null},onConfirm:()=>confirms++,onCancel:()=>cancels++})),dialog=all.find(n=>n.type==='dialog');for(const change of [{key:'Enter'},{key:'Enter',isComposing:true},{key:'Enter',repeat:true},{key:'x',keyCode:229}]){let prevented=0;dialog.props.onKeyDown({...change,preventDefault:()=>prevented++,stopPropagation(){}});assert.equal(prevented,1);assert.equal(confirms,0);}dialog.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(cancels,1);dialog.props.onCancel({preventDefault(){}});assert.equal(cancels,2);all.find(n=>n.type==='button'&&n.children[0]==='Cancel').props.onClick();assert.equal(cancels,3);const confirm=all.find(n=>n.type==='button'&&n.children[0]==='Confirm paste');assert.equal(confirm.props.type,'button');confirm.props.onClick();assert.equal(confirms,1);const field=all.find(n=>n.type==='textarea');assert.equal(field.props.readOnly,true);assert.equal(field.props.value,'text\n');});
test('A04a actual settings preserve draft on write failure and apply does not send pending input',()=>{const states=[];let index=0;const render=component('TerminalPasteSettings',{state:initial=>{const n=index++%2;if(!(n in states))states[n]=initial;return[states[n],v=>states[n]=v];}}),applied=[];let fail=true;const props={mode:'risky',error:null,onApply:mode=>{if(fail)throw Error('SYNTHETIC_PRIVATE');applied.push(mode);},onClose:()=>{}};let all=nodes(render(props));all.find(n=>n.type==='select').props.onChange({target:{value:'never'}});all=nodes(render(props));all.find(n=>n.type==='button'&&n.children[0]==='Save paste settings').props.onClick();all=nodes(render(props));assert.equal(all.find(n=>n.type==='select').props.value,'never');assert.equal(all.find(n=>n.props.role==='alert').children[0],'Could not save paste settings.');assert.deepEqual(applied,[]);fail=false;all.find(n=>n.type==='button'&&n.children[0]==='Save paste settings').props.onClick();assert.deepEqual(applied,['never']);});
test('A04a actual App preference applies only after storage success and never consumes pending text',()=>{const pending={current:{synthetic:'pending'}},mode={current:'risky'},updates=[];const bindings={terminalWindowClaim:windowContext.terminalWindowClaim,isMainWindow:true,desktopWindow:{slot:"main",epoch:1,main_epoch:1,restore_blocked:false,requested_session:null,owned_ids:[]},windowPreferenceKey:name=>windowContext.windowPreferenceKey("main",name),saveTerminalPaste:paste.saveTerminalPaste,localStorage:{setItem(){assert.equal(mode.current,'risky');throw Error('quota');}},pasteModeRef:mode,setPasteMode:v=>updates.push(v),setPastePolicyError:()=>{},pastePending:pending,invoke:()=>assert.fail('policy cannot send')};const apply=componentFunction(...Object.keys(bindings),ts.transpile(code('applyPastePolicy'),{target:ts.ScriptTarget.ES2022})+';return applyPastePolicy')(...Object.values(bindings));assert.throws(()=>apply('never'),/Could not save/);assert.equal(mode.current,'risky');assert.deepEqual(updates,[]);assert.deepEqual(pending.current,{synthetic:'pending'});bindings.localStorage.setItem=()=>assert.equal(mode.current,'risky');apply('never');assert.equal(mode.current,'never');assert.deepEqual(pending.current,{synthetic:'pending'});});
test('A04a observed invalidation clears pending and projected protocol responses remain suppressed',()=>{const h=harness();h.native('pending\n');h.view.lifecycleRevision++;h.validate();assert.equal(h.pastePending.current,null);assert.equal(h.preview,null);assert.deepEqual(h.order,['close']);const projected=harness({view:{projection:true,cursor:null,firstAttachment:false}});projected.native('\x1b[1;1R');projected.document.activeElement={dialog:true};projected.confirm();assert.equal(projected.entries.length,1);assert.equal(projected.sends.length,0);});

test('A04a bad paste settings expose a visible bounded error outside management dialogs',()=>{let notice;function visit(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(tree)==='role'&&a.initializer?.text==='alert')&&n.children.some(c=>ts.isJsxExpression(c)&&['pastePolicyError','t(pastePolicyError)'].includes(c.expression?.getText(tree))))notice=n;ts.forEachChild(n,visit);}visit(tree);assert.ok(notice,'corrupt paste preference must have an always-visible error notice');});

test('A04a native clipboard read failure is bounded and cannot expose thrown content',()=>{const h=harness(),event={target:h.view.instance.textarea,clipboardData:{types:['text/plain'],getData(){throw Error('SYNTHETIC_PRIVATE_CLIPBOARD');}},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};h.view.element.listeners.get('paste').fn(event);assert.equal(event.stopped,true);assert.deepEqual(h.errors,['Pasted text is invalid. Nothing was sent.']);assert.equal(h.sends.length,0);assert.equal(h.pastePending.current,null);});

test('A04a actual frame timer observes stale pending and clears it before polling',()=>{let timer;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='window.setInterval'&&n.arguments[0].getText(tree).includes('validatePendingTerminalPaste'))timer=n.arguments[0].getText(tree);ts.forEachChild(n,visit);}visit(tree);assert.ok(timer);const h=harness();h.native('stale\n');h.ownerConnectionAvailable.current.version++;let polls=0;const callback=componentFunction('validatePendingTerminalPaste','pollTerminalFrames',ts.transpile('const callback='+timer,{target:ts.ScriptTarget.ES2022})+';return callback')(h.validate,()=>{assert.equal(h.pastePending.current,null);polls++;});callback();assert.equal(polls,1);assert.equal(h.preview,null);assert.equal(h.sends.length,0);assert.equal(h.entries.length,0);assert.deepEqual(h.order,['close']);});

test('paste settings remain available through the guarded native settings menu',()=>{const h=nativeSettings();h.run('paste-settings');assert.deepEqual(h.calls,[['paste-settings',true]]);const blocked=nativeSettings({document:{querySelector:()=>({})}});blocked.run('paste-settings');assert.deepEqual(blocked.calls,[]);});

test('terminal input waits for each write before dispatching subsequent text, deletion and Enter',async()=>{
 const received=[],pending=[];
 const h=harness({bindings:{invoke:(name,args)=>{assert.equal(name,'write_session');return new Promise(resolve=>pending.push(()=>{received.push(args.data);resolve();}));}}});
 for(const data of ['abcX','\x7f','\r'])h.view.instance.data(data);
 assert.equal(pending.length,1,'only the first write may be in flight');
 for(let i=0;i<3;i++){assert.equal(pending.length,i+1);pending[i]();await new Promise(setImmediate);}
 assert.deepEqual(received,['abcX','\x7f','\r']);
 assert.equal(h.view.writable,true);
});

test('terminal write failure drops queued input without retry and accepts a later explicit keystroke',async()=>{
 const sent=[];let rejectFirst;
 const h=harness({bindings:{invoke:(name,args)=>{assert.equal(name,'write_session');sent.push(args.data);return sent.length===1?new Promise((_,reject)=>{rejectFirst=reject;}):Promise.resolve();}}});
 h.view.instance.data('command');h.view.instance.data('\r');rejectFirst(Error('write result unknown'));
 await new Promise(setImmediate);
 assert.deepEqual(sent,['command']);assert.equal(h.view.writable,false);assert.match(h.errors.at(-1),/discarded/i);
 h.view.instance.data('x');await new Promise(setImmediate);assert.deepEqual(sent,['command','x']);
});

test('queued terminal input cannot outlive its view, owner, attachment or window generation',async()=>{
 for(const change of [h=>h.view.disposed=true,h=>h.view.moving=true,h=>h.view.desktopGeneration++,h=>h.view.moveListenerRevision=1,h=>h.view.live=false,h=>h.ownerConnectionAvailable.current.available=false,h=>h.ownerConnectionAvailable.current.version++,h=>h.view.frameInstance='replacement',h=>h.view.attachVersion=1]){
  const sent=[];let finish;
  const h=harness({bindings:{invoke:(name,args)=>{if(name==='release_terminal_view')return Promise.resolve();sent.push(args.data);return new Promise(resolve=>{finish=resolve;});}}});
  h.view.instance.data('a');h.view.instance.data('\r');change(h);finish();await new Promise(setImmediate);
  assert.deepEqual(sent,['a']);
 }
});

test('terminal pending input is bounded and overflowing input never sends a queued Enter',async()=>{
 const sent=[];let finish;
 const h=harness({bindings:{invoke:(name,args)=>{sent.push(args.data);return new Promise(resolve=>{finish=resolve;});}}});
 h.view.instance.data('a'.repeat(131072));h.view.instance.data('b'.repeat(131072));h.view.instance.data('\r');
 assert.match(h.errors.at(-1),/pending terminal input|input queue/i);finish();await new Promise(setImmediate);
 assert.equal(sent.length,1);assert.equal(sent[0].length,131072);
});

test('terminal pending write count is bounded and a drained queue accepts fresh input',async()=>{
 const sent=[];let finish;
 const h=harness({bindings:{invoke:(name,args)=>{sent.push(args.data);return sent.length===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve();}}});
 for(let i=0;i<256;i++)h.view.instance.data('x');
 assert.equal(h.errors.length,0);h.view.instance.data('\r');assert.match(h.errors.at(-1),/discarded/);
 finish();await new Promise(setImmediate);assert.deepEqual(sent,['x']);
 assert.equal(h.view.inputQueue.count,0);assert.equal(h.view.inputQueue.length,0);
 h.view.instance.data('fresh');await new Promise(setImmediate);assert.deepEqual(sent,['x','fresh']);
});

test('one stalled terminal does not hold another terminal input queue',async()=>{
 const sent=[];let finish;
 const blocked=harness({bindings:{invoke:()=>new Promise(resolve=>{finish=resolve;})}}),ready=harness({bindings:{invoke:async(name,args)=>{sent.push(args.data);}}});
 blocked.view.instance.data('slow');ready.view.instance.data('independent');await new Promise(setImmediate);
 assert.deepEqual(sent,['independent']);assert.notEqual(blocked.view.inputQueue,ready.view.inputQueue);finish();await new Promise(setImmediate);
});
