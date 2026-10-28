// Author: Jeff.Liu. Production JSX wiring complements existing callback regressions.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),layout=readFileSync(new URL('../src/TerminalLayout.tsx',import.meta.url),'utf8');
test('experience status filter and session finder remain reachable beside search',()=>{assert.match(app,/className="sidebar-search"/);assert.match(app,/aria-label=\{t\("Filter sessions by status"\)\}/);assert.match(app,/onClick=\{openCommandPalette\}[^>]*>\{t\("Find session"\)\}/);});
test('experience unread tabs expose a visible and accessible attention indicator',()=>{assert.match(layout,/tabAttention\?\.\(tab\)/);assert.match(layout,/aria-label=\{t\("Unread activity"\)\}/);assert.match(app,/tabAttention=\{/);});

test('experience Git changes, selected-file tools and shared-directory warnings remain reachable',()=>{assert.match(app,/className="workspace-actions"/);assert.match(app,/setProjectToolsTab\("changes"\)/);assert.ok(app.includes('previewSelectedTerminalFile'));assert.ok(app.includes('Another loaded session uses this directory.'));});

test('experience data tools require preview and explicit confirmation before importing',()=>{const tools=readFileSync(new URL('../src/DataSettings.tsx',import.meta.url),'utf8');assert.ok(tools.includes('parsePreferencesBackup'));assert.ok(tools.includes('Confirm import'));assert.ok(tools.includes('onImport(pending)'));assert.ok(tools.includes('setPending(null)'));});

test('startup progress is outside the launch dialog on the visible workspace',()=>{const position=app.indexOf('className="session-start-progress"'),dialog=app.lastIndexOf('<dialog',position),main=app.lastIndexOf('<main',position);assert.ok(main>dialog&&position>main);});
test('notification navigation dismisses the data dialog before opening the target',()=>{const body=app.slice(app.indexOf('async function selectNotificationSession'),app.indexOf('void listen<string>("terminal-window-selection"'));assert.ok(body.indexOf('setDataSettingsOpen(false)')>0);assert.ok(body.indexOf('setDataSettingsOpen(false)')<body.indexOf('await openTerminal'));});
