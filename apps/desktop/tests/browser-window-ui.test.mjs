import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
import './fixtures/i18n-test-init.mjs';
// Author: Jeff.Liu. Actual App/JSX seams; not native or ReactDOM acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync} from 'node:fs';
import ts from 'typescript';
import {BrowserControls} from '../src/browser-window.ts';
const raw=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('App.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
function actual(name,args){const declaration=app.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(declaration,`actual ${name} required`);return new Function(...Object.keys(args),ts.transpileModule(declaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText+`;return ${name};`)(...Object.values(args));}
test('C01a actual App main-only More actions Browser entry exists',()=>{
 const entries=[];function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='button'&&node.children.some(child=>ts.isJsxText(child)&&child.text.trim()==='Browser'))entries.push(node);ts.forEachChild(node,visit);}visit(app);
 assert.equal(entries.length,1);assert.match(entries[0].getText(source),/openBrowserDialog/);assert.match(entries[0].parent.getText(source),/isMainWindow/);
});
test('C01a browser plugin scope stays on exact trusted webviews with approved dialog permissions',()=>{
 const capability=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json',import.meta.url),'utf8'));
 assert.equal(capability.windows,undefined);assert.deepEqual(capability.webviews,['main','terminal-secondary']);assert.equal(capability.remote,undefined);
 assert.deepEqual(capability.permissions,['core:event:allow-listen','core:event:allow-unlisten','dialog:allow-open','dialog:allow-message',{identifier:'opener:allow-open-url',allow:[{url:'http://*'},{url:'https://*'}]}]);
});
test('C01a actual secondary Browser entry handler has zero invoke/open',async()=>{
 const calls=[];await actual('openBrowserDialog',{isMainWindow:false,setBrowserOpen:()=>calls.push('open'),browserControls:{current:{read:()=>calls.push('invoke')}},invoke(){},setBrowserVersion(){},browserMounted:{current:true}})();assert.deepEqual(calls,[]);
});
test('C01a actual App main controls status then native action and unmount suppresses late render',async()=>{
 const controller=new BrowserControls(),calls=[],renders=[];let finish;
 const args={isMainWindow:true,setBrowserOpen:()=>calls.push('dialog'),browserControls:{current:controller},invoke:async(name,payload)=>{calls.push([name,payload]);return {generation:0,phase:'closed',url:null,loading:false};},setBrowserVersion:value=>renders.push(value(0)),browserMounted:{current:true}};
 await actual('openBrowserDialog',args)();assert.deepEqual(calls,['dialog',['browser_status',undefined]]);
 args.invoke=(name,payload)=>{calls.push([name,payload]);return new Promise(resolve=>{finish=resolve;});};
 const pending=actual('browserAction',args)('open','https://example.test/');assert.deepEqual(calls.at(-1),['browser_open',{expected_generation:0,url:'https://example.test/'}]);
 const before=renders.length;args.browserMounted.current=false;controller.dispose();finish({generation:1,phase:'open',url:'https://example.test/',loading:false});await pending;
 assert.equal(renders.length,before);assert.equal(controller.snapshot.generation,0);
});
function dialogFixture(){
 const file=ts.createSourceFile('BrowserWindowDialog.tsx',readFileSync(new URL('../src/BrowserWindowDialog.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='BrowserWindowDialog');
 const js=ts.transpileModule(declaration.getText(file).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.React}}).outputText;
 const states=[],calls=[],effects=[];let index=0,closed=0;
 const React={createElement:(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})};
 const useState=initial=>{const at=index++;if(!(at in states))states[at]=initial;return [states[at],next=>states[at]=next];};
 const render=new Function('React','useState','useRef','useEffect',js+';return BrowserWindowDialog')(React,useState,()=>({current:{showModal:()=>calls.push('modal'),close:()=>calls.push('dialog-close')}}),fn=>effects.push(fn));
 const props={snapshot:{generation:1,phase:'open',url:'https://example.test/',loading:false},busy:false,error:null,onAction:(...args)=>calls.push(args),onRefresh:()=>calls.push('status'),onClose:()=>closed++};let tree;
 const refresh=()=>{index=0;tree=render(props);};refresh();
 const nodes=node=>[node,...(node?.props?.children??[]).flatMap(child=>child&&typeof child==='object'?nodes(child):[])];
 const button=text=>nodes(tree).find(n=>n.type==='button'&&n.props.children.includes(text));
 return {props,calls,refresh,button,effects,get closed(){return closed;},get input(){return nodes(tree).find(n=>n.type==='input');},get tree(){return tree;}};
}
test('C01a actual dialog controls preserve URL draft across errors and close only trusted controls',()=>{
 const f=dialogFixture();f.input.props.onChange({target:{value:'https://draft.test/?literal'}});f.refresh();f.button('Navigate').props.onClick();assert.deepEqual(f.calls.at(-1),['open','https://draft.test/?literal']);
 f.props.error='browser_navigation_failed';f.refresh();assert.equal(f.input.props.value,'https://draft.test/?literal');
 for(const [label,action] of [['Show','show'],['Reload','reload'],['Close browser','close']]){f.button(label).props.onClick();assert.deepEqual(f.calls.at(-1),[action,'https://draft.test/?literal']);}
 f.button('Retry status').props.onClick();assert.equal(f.calls.at(-1),'status');f.button('Close controls').props.onClick();assert.equal(f.closed,1);
 const cleanup=f.effects[0]();cleanup();assert.deepEqual(f.calls.slice(-2),['modal','dialog-close']);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='close').length,1);
});
test('C01a actual dialog busy and creating/closing disable replacement but allow status and Close',()=>{
 const f=dialogFixture();f.props.busy=true;f.refresh();for(const text of ['Navigate','Show','Reload','Close browser','Retry status'])assert.equal(f.button(text).props.disabled,true);
 f.props.busy=false;f.props.snapshot={generation:1,phase:'closing',url:null,loading:false};f.refresh();assert.equal(f.button('Open').props.disabled,true);assert.equal(f.button('Show').props.disabled,true);assert.equal(f.button('Close browser').props.disabled,false);assert.equal(f.button('Retry status').props.disabled,false);
});

const originalHandlers=["updater::updater_status", "updater::updater_check", "updater::updater_download", "updater::updater_cancel", "updater::updater_set_automatic_checks", "updater::updater_install", "desktop_windows::desktop_window_bootstrap", "desktop_windows::claim_terminal_view", "desktop_windows::release_terminal_view", "desktop_windows::prepare_terminal_move", "desktop_windows::query_terminal_move", "desktop_windows::reconcile_terminal_move", "desktop_windows::accept_terminal_move", "desktop_windows::complete_terminal_move", "desktop_windows::recover_terminal_move", "desktop_windows::reserve_terminal_start", "desktop_windows::open_terminal_window", "desktop_windows::open_main_settings", "desktop_windows::preview_terminal_file", "desktop_windows::reveal_terminal_file", "desktop_windows::terminal_input_focused", "desktop_windows::commit_window_preferences", "desktop_windows::request_main_terminal_zoom", "health_check", "memory_usage", "validate_project_directory", "list_adapters", "archive_session", "get_history_policy", "set_history_policy", "preview_archive_deletion", "cancel_archive_deletion_preview", "confirm_archive_deletion", "restore_archive", "list_archived_sessions", "get_launch_defaults", "get_git_context", "get_git_changes", "cancel_git_changes", "preview_worktree_create", "create_worktree", "list_managed_worktrees", "preview_worktree_cleanup", "cleanup_worktree", "set_launch_defaults", "preview_project_config", "trust_project_config", "desktop_windows::create_session", "provider_protocol_version", "desktop_windows::write_session", "desktop_windows::resize_session", "stop_session", "list_session_summaries", "get_session", "history_overview", "list_unread_receipts", "next_attention", "list_pending_notifications", "scan_history_capacity", "cancel_history_capacity", "notify_session", "acknowledge_notification", "get_notification_pause_state", "initialize_notification_pause", "set_notification_paused", "get_system_entry_status", "set_global_shortcut", "desktop_windows::set_agent_notification_context", "retry_agent_notifications", "read_agent_receipt", "pending_notification_selection", "acknowledge_notification_selection", "read_session_log", "search_session_logs", "cancel_log_search", "read_log_excerpt", "export_session_log", "export_diagnostics", "desktop_windows::read_session_snapshot", "desktop_windows::read_terminal_frame", "stop_all_and_quit", "desktop_windows::take_terminal_control", "desktop_windows::set_terminal_viewport"];
test("C01a actual generated registration preserves original commands and provider capability in order behind one gate",()=>{const lib=readFileSync(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");const body=lib.split("tauri::generate_handler![")[1].split("]")[0];const entries=body.split(",").map(value=>value.trim()).filter(Boolean);assert.deepEqual(entries.slice(0,originalHandlers.length),originalHandlers);assert.deepEqual(entries.slice(originalHandlers.length),["desktop_windows::navigate_reported_prompt","desktop_windows::clear_terminal_display","browser_window::browser_status","browser_window::browser_open","browser_window::browser_show","browser_window::browser_reload","browser_window::browser_close","provider_probe::probe_provider_endpoint","provider_probe::list_local_gateways","external_terminal::list_external_terminals","terminal_fonts::list_terminal_fonts","external_terminal::open_external_terminal","system_entry::confirm_stop_all","system_entry::confirm_template_reset","background::reconnect_background","provider_catalog::check_provider_gateway","provider_catalog::cancel_provider_gateway","provider_catalog::load_provider_models","file_preview::read_project_file_preview","file_preview::choose_project_file_preview","file_preview::cancel_file_preview","codex_conversation::read_codex_conversation","codex_conversation::cancel_codex_conversation","native_menu::native_menu_labels","desktop_windows::set_notification_locale","node_runtime::initialize_background"]);assert.match(lib,/browser_window::invoke_gate/);assert.match(lib,/invoke.message.webview_ref\(\)/);assert.equal((lib.match(/\.invoke_handler\(/g)||[]).length,1);});
