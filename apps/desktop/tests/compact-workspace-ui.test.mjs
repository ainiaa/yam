import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Keep presentation changes away from terminal host lifetimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
test('compact theme defines the existing UI tokens and keeps native windows dark',()=>{
 const css=read('../src/App.css');
 for(const token of ['--accent:','--bg:','--bg-hover:','--text-muted:'])assert.ok(css.includes(token),token);
 const config=JSON.parse(read('../src-tauri/tauri.conf.json'));
 assert.equal(config.app.windows[0].theme,'Dark');assert.equal(config.identifier,'com.yam.desktop');assert.equal(config.productName,'YAM');
 assert.match(read('../src-tauri/src/desktop_windows.rs'),/\.theme\(Some\(tauri::Theme::Dark\)\)/);
});
test('model menu and pane titles have bounded, consistent visual states',()=>{
 const css=read('../src/App.css');
 for(const selector of ['.unified-select-menu','.unified-select-menu > button','.unified-select-menu > button[data-active="true"]','.pane-focused .terminal-pane-session','.workspace-footer'])assert.ok(css.includes(selector),selector);
 assert.match(css,/\.unified-select-menu\s*\{[^}]*overflow:\s*auto/s);
 assert.match(css,/\.terminal-layout-toolbar\s*\{[^}]*position:\s*absolute/s);
 assert.match(read('../src/TerminalLayout.tsx'),/aria-label="Terminal layout" title="Layout and split controls"/);
});

test('pane titles truncate and layout controls reuse the existing viewbar without scrolling terminals',()=>{
 const layout=read('../src/TerminalLayout.tsx'),app=read('../src/App.tsx'),css=read('../src/App.css');
 assert.ok(layout.includes('createPortal(toolbar,toolbarHost)'));assert.ok(app.includes('className="workspace-layout-slot"'));assert.ok(app.includes('toolbarHost={layoutMenuHost}'));
 assert.doesNotMatch(layout,/role="tablist"|role="tab"|scrollIntoView|strip.scrollLeft/);
 assert.match(css,/\.terminal-pane-session > span:last-child\s*\{[^}]*text-overflow:ellipsis/s);
 assert.match(css,/\.workspace-layout-slot \.terminal-layout-toolbar\s*\{[^}]*position:static/s);
});
