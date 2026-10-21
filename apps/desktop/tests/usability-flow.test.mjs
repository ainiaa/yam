import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu. Keep common user actions visible and advanced configuration explicit.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync as rawReadFileSync} from 'node:fs';
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
test('session menu excludes global settings and destructive application quit',()=>{const menu=app.slice(app.indexOf('aria-label="More actions"'),app.indexOf('</details>',app.indexOf('aria-label="More actions"')));for(const label of ['Updates','System entry','Terminal settings','Terminal profiles','Paste settings','Stop all tasks and quit YAM'])assert.ok(!menu.includes('>'+label+'</button>')&&!menu.includes('aria-label="'+label+'"'),label);assert.match(menu,/<summary>Diagnostics<\/summary>/);});
test('ended view offers direct recovery actions and historical event labels',()=>{assert.match(app,/className="session-ended-actions"/);assert.match(app,/Last event: /);assert.match(app,/onClick=\{resumeSelectedSession\}/);assert.match(app,/onClick=\{rerunSelectedSession\}/);});
test('unsupported program selection explains the connection and offers a visible reset',()=>{assert.match(app,/Use existing CLI configuration to select any installed program/);assert.match(app,/changeProvider\("inherited"\)/);});
test('global preferences have a dedicated native settings menu',()=>{const text=readFileSync(new URL('../src-tauri/src/native_menu.rs',import.meta.url),'utf8');for(const label of ['Settings','Paste settings','System entry','Launch templates and defaults'])assert.ok(text.includes('"'+label+'"'),label);});
test('settings errors use the shared defined error color',()=>{const css=readFileSync(new URL('../src/App.css',import.meta.url),'utf8');assert.match(css,/terminal-settings-body > \[role="alert"\][^}]*color:var\(--error\)/);});
