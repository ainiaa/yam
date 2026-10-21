import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Keep presentation changes away from terminal host lifetimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
test('compact theme defines the existing UI tokens and keeps native windows dark',()=>{
 const css=read('../src/App.css');
 for(const token of ['--accent:','--bg:','--bg-hover:','--text-muted:'])assert.ok(css.includes(token),token);
 const config=JSON.parse(read('../src-tauri/tauri.conf.json'));
 assert.equal(config.app.windows[0].theme,'Dark');assert.equal(config.identifier,'com.yam.desktop');assert.equal(config.productName,'YAM');
 assert.match(read('../src-tauri/src/desktop_windows.rs'),/\.theme\(Some\(tauri::Theme::Dark\)\)/);
});
test('model menu and terminal tabs have bounded, consistent visual states',()=>{
 const css=read('../src/App.css');
 for(const selector of ['.unified-select-menu','.unified-select-menu > button','.unified-select-menu > button[data-active="true"]','.terminal-pane-tab:has([aria-selected="true"])','.workspace-footer'])assert.ok(css.includes(selector),selector);
 assert.match(css,/\.unified-select-menu\s*\{[^}]*overflow:\s*auto/s);
 assert.match(css,/\.terminal-layout-toolbar\s*\{[^}]*position:\s*absolute/s);
 assert.match(read('../src/TerminalLayout.tsx'),/aria-label="Terminal layout" title="Layout and split controls"/);
});

test('active tabs reveal within their own tab strip after selection, title hydration and resize',()=>{
 const source=ts.createSourceFile('TerminalLayout.tsx',read('../src/TerminalLayout.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback,deps;
 function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('aria-selected')){callback=node.arguments[0].getText(source);deps=node.arguments[1].getText(source);}ts.forEachChild(node,visit);}visit(source);assert.ok(callback);assert.match(deps,/tabNames/);
 let observer,disconnected=false;const observed=[],outerScroll=[],strips=[{scrollLeft:140,left:20,right:220,tabLeft:10,tabRight:150},{scrollLeft:0,left:250,right:450,tabLeft:430,tabRight:530},{scrollLeft:0,left:500,right:580,tabLeft:510,tabRight:730}];
 const tabs=strips.map(strip=>({scrollIntoView:o=>outerScroll.push(o),parentElement:null,getBoundingClientRect:()=>({left:strip.tabLeft,right:strip.tabRight,width:strip.tabRight-strip.tabLeft})}));
 for(const [i,strip] of strips.entries()){strip.querySelector=()=>tabs[i];strip.getBoundingClientRect=()=>({left:strip.left,right:strip.right,width:strip.right-strip.left});tabs[i].parentElement=tabs[i];tabs[i].closest=()=>strip;}
 class ResizeObserver{constructor(fn){observer=fn;}observe(strip){observed.push(strip);}disconnect(){disconnected=true;}}
 const tabSurface={current:{querySelectorAll:selector=>selector.includes('aria-selected')?tabs:strips}};
 const action=new Function('tabSurface','ResizeObserver',ts.transpile('return ('+callback+');',{target:ts.ScriptTarget.ES2022}))(tabSurface,ResizeObserver);const cleanup=action();
 assert.equal(outerScroll.length,0,'tab reveal must not scroll terminal panes or the application');
 assert.deepEqual(strips.map(s=>s.scrollLeft),[130,80,10]);assert.deepEqual(observed,strips,'observe tab strip width changes');
 strips[1].tabLeft=240;strips[1].tabRight=340;observer();assert.equal(strips[1].scrollLeft,70,'shrinking a pane re-reveals its selected tab');
 cleanup();assert.equal(disconnected,true);tabSurface.current=null;action();
});
