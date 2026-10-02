"""Author: Jeff.Liu. Native asynchronous startup regression for the WebKit gate."""
import importlib.util
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

    def test_delayed_ipc_can_finish_after_footer_first_appears(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace(
            'invoke:(command)=>Promise.resolve(',
            'invoke:(command)=>new Promise(resolve=>setTimeout(()=>resolve(',
        ).replace('[]:null)};', '[]:null),2000))};')
        module.main()

    def test_javascript_errors_still_reject_a_rendered_footer(self):
        module = self.smoke()
        module.SWIFT = module.SWIFT.replace('window.__yamErrors=[];', 'window.__yamErrors=["fixture startup error"];')
        with self.assertRaises(subprocess.CalledProcessError):
            module.main()


if __name__ == '__main__':
    unittest.main()
