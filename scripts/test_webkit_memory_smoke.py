"""Author: Jeff.Liu. Native asynchronous startup regression for the WebKit gate."""
import importlib.util
import os
import pathlib
import subprocess
import tempfile
import sys
import unittest
from unittest import mock


@unittest.skipUnless(sys.platform == 'darwin', 'Requires native WebKit')
class WebKitStartup(unittest.TestCase):
    def smoke(self):
        path = pathlib.Path(__file__).with_name('webkit-memory-smoke.py')
        spec = importlib.util.spec_from_file_location('webkit_smoke', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_delayed_ipc_can_finish_after_diagnostics_first_appear(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace(
            'window.__yamDelayMs=0;', 'window.__yamDelayMs=2000;',
        )
        module.main(os.environ.get('YAM_WEBKIT_FIXTURE_DIST'))

    def test_real_react_settings_keep_and_discard_are_verified_before_success(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace(
            'print(text); exit(0)',
            'if value["settings_verified"] as? Bool != true { print("Settings flow was not verified"); exit(1) }; print(text); exit(0)',
        )
        module.main(os.environ.get('YAM_WEBKIT_FIXTURE_DIST'))

    def test_narrow_window_keeps_primary_controls_and_settings_close_reachable(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace('width:1180,height:760', 'width:720,height:600')
        module.SWIFT = module.SWIFT.replace(
            "const step=window.__yamSettingsStep??0;",
            """const step=window.__yamSettingsStep??0;
 if(step===2){
  const visible=n=>{for(let p=n.parentElement;p;p=p.parentElement){if(p.localName==='details'&&!p.open&&!p.querySelector(':scope > summary')?.contains(n))return false;}const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';};
  const inView=n=>{const r=n.getBoundingClientRect();return r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
  const controls=Array.from(document.querySelectorAll('.topbar button,.workspace-viewbar button,.sidebar-footer button,dialog[open] [data-settings-close]')).filter(visible);
  if(!controls.length||controls.some(n=>!inView(n)))window.__yamErrors.push('Narrow controls escaped the viewport: '+JSON.stringify(controls.filter(n=>!inView(n)).map(n=>({text:n.textContent,label:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON()}))));
  if(document.documentElement.scrollWidth>innerWidth)window.__yamErrors.push('Narrow workspace overflowed horizontally');
  const close=dialog?.querySelector('[data-settings-close]');if(!close)window.__yamErrors.push('Narrow settings close is missing');else{close.focus();if(document.activeElement!==close)window.__yamErrors.push('Narrow close could not receive focus');}
 }""",
        )
        module.main(os.environ.get('YAM_WEBKIT_FIXTURE_DIST'))

    def test_javascript_errors_reject_rendered_diagnostics_without_timeout(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace('window.__yamErrors=[];', 'window.__yamErrors=["fixture startup error"];')
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            module.main(os.environ.get('YAM_WEBKIT_FIXTURE_DIST'))
        self.assertEqual(raised.exception.returncode, 1, 'A timeout is not evidence that the JavaScript error guard works')


    def test_visible_startup_error_rejects_an_otherwise_successful_memory_render(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace('window.__yamErrors=[];', "window.__yamErrors=[];window.addEventListener('DOMContentLoaded',()=>{const banner=document.createElement('div');banner.className='error-banner';banner.textContent='fixture UI startup error';document.body.append(banner);});")
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            module.main(os.environ.get('YAM_WEBKIT_FIXTURE_DIST'))
        self.assertEqual(raised.exception.returncode, 1)

if __name__ == '__main__':
    unittest.main()

class WebKitBuildBudget(unittest.TestCase):
    def test_compile_budget_is_separate_from_browser_execution(self):
        module = WebKitStartup().smoke()
        with tempfile.TemporaryDirectory() as directory:
            dist = pathlib.Path(directory)
            (dist / 'index.html').write_text('fixture')
            with mock.patch.object(module.platform, 'system', return_value='Darwin'), mock.patch.object(module.subprocess, 'run') as run:
                module.main(dist)
            self.assertEqual(run.call_count, 2)
            compile_call, browser_call = run.call_args_list
            self.assertEqual(compile_call.args[0][0], '/usr/bin/swiftc')
            self.assertIn('-o', compile_call.args[0])
            self.assertEqual(compile_call.kwargs['timeout'], 120)
            self.assertEqual(browser_call.kwargs['timeout'], 30)
            self.assertEqual(browser_call.args[0][0], compile_call.args[0][-1])

    def test_periodic_ipc_does_not_keep_startup_pending(self):
        module = WebKitStartup().smoke()
        bootstrap = module.SWIFT.split('let bootstrap = """', 1)[1].split('"""', 1)[0]
        js = """globalThis.window=globalThis; globalThis.document={};
globalThis.addEventListener=()=>{}; const pending=[];
globalThis.setTimeout=fn=>pending.push(fn);
""" + bootstrap + """
window.__TAURI_INTERNALS__.invoke('memory_usage');
window.__TAURI_INTERNALS__.invoke('memory_usage');
if(window.__yamPending!==1)throw Error('Repeated polling counted as startup');
pending[0]();
if(window.__yamPending!==0)throw Error('First startup request did not settle');
"""
        subprocess.run(['node', '-e', js], check=True, capture_output=True, text=True, timeout=10)
