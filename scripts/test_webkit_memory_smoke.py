"""Author: Jeff.Liu. Native asynchronous startup regression for the WebKit gate."""
import importlib.util
import os
import pathlib
import subprocess
import sys
import unittest


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
