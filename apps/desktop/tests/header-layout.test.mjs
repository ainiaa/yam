import {sidebarSessions} from '../src/workspaces.ts';
import {sessionRuntimeInfo} from '../src/session-runtime-info.ts';
import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
import {componentFunction} from './fixtures/component-function.mjs';
// Author: Jeff.Liu. Browser geometry of the actual header JSX and stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync as rawReadFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as icons from 'lucide-react';
import ts from 'typescript';
import {agentLabel} from '../src/agent-events.ts';
import * as layoutOperations from '../src/terminal-layout.ts';
import {gitContextLabel} from '../src/git-context.ts';
import {connectionDetails} from '../src/provider-config.ts';

const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Headless Chrome can still display macOS keychain dialogs; installation is not test consent.
const chromeSkip = process.env.YAM_TEST_HEADLESS_CHROME !== '1'
  ? 'Set YAM_TEST_HEADLESS_CHROME=1 to explicitly run isolated local-browser tests'
  : !existsSync(chrome) && 'Set CHROME_BIN to an installed Chromium browser';
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let header, sidebar, creation, viewbar;
function visit(node) {
  if(ts.isVariableDeclaration(node)&&node.name.getText(source)==="newSessionButton")creation=node.initializer;
  if (ts.isJsxElement(node) && node.openingElement.getText(source) === '<header className="topbar">') header = node;
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "aside") sidebar = node;
  if (ts.isJsxElement(node) && node.openingElement.getText(source) === '<div className="workspace-viewbar">') viewbar = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(header, 'actual application header');
const code = ts.transpileModule('return (' + header.getText(source) + ');', {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText;
const connectionDeclaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='SessionConnection');
assert.ok(connectionDeclaration,'actual connection disclosure');
const connectionCode=ts.transpileModule(connectionDeclaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const SessionConnection=componentFunction('React','connectionDetails','ChevronDown','sessionRuntimeInfo',connectionCode+';return SessionConnection;')(React,connectionDetails,icons.ChevronDown,sessionRuntimeInfo);
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');

const layoutSource=ts.createSourceFile('TerminalLayout.tsx',readFileSync(new URL('../src/TerminalLayout.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=layoutSource.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='TerminalLayout');
const layoutCode=ts.transpileModule(declaration.getText(layoutSource).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function layoutElement() {
 const bindings={React,useRef:current=>({current}),useState:value=>[value,()=>{}],useEffect:()=>{},...layoutOperations};
 const component=componentFunction(...Object.keys(bindings),layoutCode+';return TerminalLayout;')(...Object.values(bindings));
 return component({layout:{mode:'single',panes:['fixture'],focused:0,revision:0},labels:['Terminal'],splitPercent:50,swapDisabled:false,canReopen:true,onHost(){},onMode(){},onFocus(){},onClose(){}});
}
function markup(interactive, collapsed, longPath, stopped=false) {
  const bindings = {React, SessionConnection, ...Object.fromEntries(Object.entries(icons).filter(([name]) => /^[A-Z]/.test(name))), gitProjectPath:'/work',sidebarOpen: !collapsed, currentProject: {name: 'YAM'},
    sidebarSessions,searchInput:{current:null},historyQuery:'',statusFilter:'all',unreadTotal:0,inboxOpen:false,shortcutError:null,history:[],historyCursor:null,historyLoading:false,capacityOpen:false,capacity:null,capacityError:null,capacityBusy:false,scanCapacity(){},jumpToAttention(){},addProject(){},endProjectDrag(){},
    visibleProjects:[{path:'/work',name:'Project',sessions:[{summary:{session_id:'fixture',mode:'command'},status:'stopped',started_at:0}]}],projectKey:path=>path,collapsedProjects:new Set(),normalizedQuery:'',projectColor:()=>'',canRenameProject:()=>true,canMoveProject:()=>false,pinnedSessions:[],
    session: {session_id: 'fixture', cwd:'/work', launch: interactive ? {mode: 'interactive',adapter:'codex'} : null},
    conversationOpen:false,showConversation(){},openTerminalFind(){},
    starting:false, titleFor: () => 'Codex interactive session', visibleGitContext: longPath ? {kind: 'repository', branch: 'feature/' + 'long-branch-'.repeat(30), dirty: true, root: '/work/' + 'long-directory/'.repeat(30), common_dir: '/repo/.git'} : {kind: 'unavailable'},
    gitContextLabel, isRunning: !stopped, currentAgent: {integration: 'connecting'}, agentLabel,
    agentPhase:"idle",sessionStatus: stopped?'stopped':'running', statusLabels: {running:'Running',stopped:'Stopped'}, notificationsPaused: false,
    historyOverview: {failed_receipts: 1,attention_sessions:0,total:1,active:1}, canNavigateReportedPrompt: () => false,
    shortcutMac: true, fileBusy: false, filePreview: null, canMoveTerminalTab: () => false,
    moveBusy: false, movePending: false, isMainWindow: true, stopAllBusy:false,
    updaterSnapshot:null,isMainWindow:true,health:{status:'ready',version:'0.1.0'}, memory:null, memoryLabel:()=> '100 MB', notificationTestBusy:{current:false},notificationTestStatus:null,openCommandPalette(){},diagnosticsExporting:false,diagnosticsMessage:null, notificationError:null,scrollView:null, ownerConnectionAvailable:{current:{available:true}},terminalPaneVisible:()=>true,canClearTerminalDisplay:()=>false, shortcuts: {}, shortcutHint: () => '',
    terminalViews: {current: new Map()}, recovery: {canRunAgain: false}, canContinue: false,
    closeEndedView() {}, rerunSelectedSession() {}, resumeSelectedSession() {}};
  assert.ok(creation,'actual shared new-session control');
  const creationCode=ts.transpileModule('return ('+creation.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  bindings.newSessionButton=componentFunction(...Object.keys(bindings),creationCode)(...Object.values(bindings));
  const element = componentFunction(...Object.keys(bindings), code)(...Object.values(bindings));
  const asideCode=ts.transpileModule('return ('+sidebar.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  const aside=componentFunction(...Object.keys(bindings),asideCode)(...Object.values(bindings));
  const viewCode=ts.transpileModule('return ('+viewbar.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  const view=componentFunction(...Object.keys(bindings),viewCode)(...Object.values(bindings));
  return `<div class="app-shell${collapsed ? ' sidebar-collapsed' : ''}">${renderToStaticMarkup(aside)}<main class="main-panel">${renderToStaticMarkup(element)}${renderToStaticMarkup(view)}<section class="terminal-area">${renderToStaticMarkup(layoutElement())}</section></main></div>`;
}

test('production workspace chrome renders shell, Agent, ended and collapsed states without a browser',()=>{
 for(const options of [[false,false,false],[true,false,false],[true,true,true],[true,false,true,true]]){
  const html=markup(...options);
  assert.match(html,/class="sidebar-footer"/);assert.match(html,/class="workspace-viewbar"/);
  assert.match(html,/aria-label="Session view"/);assert.doesNotMatch(html,/<time\b/);
 }
});

test('actual header keeps Git readable, terminal space, and actions reachable', {skip: chromeSkip}, async () => {
  const cases = [
    {name: 'normal shell', width: 1000, interactive: false},
    {name: 'awaiting trusted hook', width: 1180, interactive: true},
    {name: 'narrow agent', width: 800, interactive: true},
    {name: 'stopped session', width: 1000, stopped:true},
    {name: 'narrow sidebar agent', width: 540, interactive: true},
    {name: 'collapsed narrow agent with long Git paths', width: 400, interactive: true, collapsed: true, longPath: true},
  ];
  const directory = mkdtempSync(join(tmpdir(), 'yam-header-layout-'));
  try {
    const fixtures = cases.map(item => ({...item, html: `<style>${css}</style>${markup(item.interactive, item.collapsed, item.longPath,item.stopped)}`}));
    const script = `Promise.all(${JSON.stringify(fixtures)}.map(item => new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.style.cssText = 'border:0;width:' + item.width + 'px;height:760px';
      frame.onload = () => { const doc = frame.contentDocument, header = doc.querySelector('.topbar'), box = header.getBoundingClientRect();
        const git = doc.querySelector('.topbar > .git-context > span')?.getBoundingClientRect();
        const visible = node => !node.closest('details:not([open])') && node.getBoundingClientRect().height > 0;
        const defaultLayoutButtons=[...doc.querySelectorAll('.terminal-layout-toolbar button, .terminal-pane-header select')].filter(visible).length;
        const secondary = [...doc.querySelectorAll('.toolbar button')].filter(node => visible(node) && ['Export session log','Terminal settings','Rename session','Stop all tasks and quit YAM','Take control','Updates','System entry'].includes(node.getAttribute('aria-label') || node.textContent)).map(node => node.getAttribute('aria-label') || node.textContent);
        const controls = [...doc.querySelectorAll('.toolbar > button, .toolbar > details > summary')].filter(node => !node.disabled);
        const inaccessible = controls.filter(node => { const r = node.getBoundingClientRect(); return !r.width || !r.height || r.left < box.left || r.right > box.right + 1 || r.bottom > box.bottom + 1; }).map(node => node.getAttribute('aria-label') || node.textContent);
        resolve({name:item.name,height:box.height,gitHeight:git?.height ?? 0,gitWidth:git?.width ?? 0,secondary,inaccessible,defaultLayoutButtons,layoutHeight:doc.querySelector('.terminal-layout-toolbar').getBoundingClientRect().height,
          menus:[...doc.querySelectorAll('details.toolbar-more')].filter(menu=>!menu.closest('[inert]')).map(menu=>{menu.open=true;menu.querySelectorAll('details').forEach(child=>child.open=true);const panel=menu.querySelector('.toolbar-more-actions');const rect=panel.getBoundingClientRect();const controls=[...panel.querySelectorAll('button,select')];const textFailures=[], textButtons=[];
            const accessible=controls.every(control=>{control.scrollIntoView({block:'nearest'});const r=control.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.right<=item.width+1;});
            for(const button of controls.filter(control=>control.tagName==='BUTTON')) {
              button.scrollIntoView({block:'nearest'});
              const box=button.getBoundingClientRect(),next=button.nextElementSibling?.getBoundingClientRect(),label=button.getAttribute('aria-label')||button.textContent.trim();
              const walker=doc.createTreeWalker(button,4);let node;
              while(node=walker.nextNode())if(node.textContent.trim()) {
                const range=doc.createRange();range.selectNodeContents(node);
                for(const text of range.getClientRects())if(text.left<box.left-1||text.right>box.right+1||text.top<box.top-1||text.bottom>box.bottom+1||(next&&text.bottom>next.top+1))textFailures.push(label);
              }
              if(['Copy terminal output','Clear terminal display'].includes(label))textButtons.push({label,width:box.width,height:box.height});
            }
            menu.open=false;return {accessible,textFailures:[...new Set(textFailures)],textButtons,width:rect.width,height:rect.height,left:rect.left,right:rect.right};})}); };
      frame.srcdoc = item.html; document.body.append(frame);
    }))).then(results => { document.getElementById('result').textContent = JSON.stringify(results); });`;
    const file = join(directory, 'header.html');
    writeFileSync(file, `<pre id="result"></pre><script>${script}</script>`);
    const results = await new Promise((resolve, reject) => {
      const child = spawn(chrome, ['--headless', '--disable-gpu', '--disable-background-networking','--use-mock-keychain','--disable-features=DialMediaRouteProvider', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=1000', pathToFileURL(file).href], {stdio: ['ignore', 'pipe', 'pipe']});
      let output = '', completed, failure;
      const timeout = setTimeout(() => { failure = new Error('Chrome layout completion timed out'); child.kill('SIGKILL'); }, 15000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 4 * 1024 * 1024) { failure = new Error('Chrome output exceeded limit'); child.kill('SIGKILL'); return; }
        if (!completed && output.includes('</html>')) {
          try {
            completed = JSON.parse(output.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] ?? 'null');
            if (completed?.length !== cases.length) throw new Error('Incomplete browser layout results');
          } catch (error) { failure = error; }
          // The fixture owns this headless process; close only after a complete DOM report.
          child.kill('SIGTERM');
        }
      });
      child.stderr.resume();
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', () => { clearTimeout(timeout); if (failure || !completed) reject(failure ?? new Error('Chrome exited without layout results')); else resolve(completed); });
    });
    assert.equal(results?.length, cases.length, 'all browser fixtures rendered');
    console.log(JSON.stringify(results));
    for (const value of results) {
      assert.equal(value.defaultLayoutButtons,0,`${value.name}: no default layout button strip`);
      assert.ok(value.layoutHeight<=36,`${value.name}: compact layout summary`);
      assert.ok(value.menus.every(menu=>menu.accessible && menu.height<=560 && menu.left>=0 && menu.right<=cases.find(item=>item.name===value.name).width+1),`${value.name}: bounded menus ${JSON.stringify(value.menus)}`);
      assert.deepEqual(value.menus.flatMap(menu=>menu.textFailures),[],`${value.name}: menu text stays inside its button and clear of the next item`);
      const textButtons=value.menus.flatMap(menu=>menu.textButtons);
      assert.equal(textButtons.length,2,`${value.name}: both formerly small icon controls rendered`);
      assert.ok(textButtons.every(button=>button.width>=140),`${value.name}: text actions use menu width ${JSON.stringify(textButtons)}`);
      assert.deepEqual(value.secondary, [], `${value.name}: secondary actions belong in a closed menu`);
      assert.ok(value.height <= 120, `${value.name}: header takes ${value.height}px of 760px`);
      assert.ok(value.gitHeight <= 20 && (value.gitWidth === 0 || value.gitWidth >= 100), `${value.name}: Git collapsed to ${value.gitWidth} x ${value.gitHeight}`);
      assert.deepEqual(value.inaccessible, [], `${value.name}: controls remain visible inside header`);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
