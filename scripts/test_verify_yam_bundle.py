"""Author: Jeff.Liu. Read-only bundle validation; no desktop application launches."""
import importlib.util,plistlib,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('verify_bundle',Path(__file__).with_name('verify-yam-bundle.py'))
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class BundleTests(unittest.TestCase):
 def fixture(self,root):
  app=Path(root)/'YAM.app';helper=app/'Contents/Helpers/YAM Background.app'
  for path,identifier,exe in [(app,'com.yam.desktop','yam-desktop'),(helper,'com.yam.desktop.background','yam-background')]:
   contents=path/'Contents';(contents/'MacOS').mkdir(parents=True);binary=contents/'MacOS'/exe;binary.write_bytes(b'current binary');binary.chmod(0o755)
   (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier,'CFBundleExecutable':exe,'CFBundleVersion':'0.1.10','CFBundleShortVersionString':'0.1.10',**({'LSUIElement':True} if path==helper else {})}))
   runtime=contents/'Resources/target/terminal-runtime';runtime.mkdir(parents=True);(runtime/'yam-terminal.cjs').write_bytes(b'current parser')
  return app,helper
 def test_matching_main_helper_and_parser_require_signature_verification(self):
  with tempfile.TemporaryDirectory() as root,patch.object(v.subprocess,'run') as run:
   app,_=self.fixture(root);result=v.verify(app,'0.1.10');self.assertEqual(result['version'],'0.1.10');self.assertEqual(result['identifier'],'com.yam.desktop')
   self.assertTrue(any(call.args[0][:4]==['codesign','--verify','--deep','--strict'] for call in run.call_args_list));self.assertFalse(any('open' in call.args[0] for call in run.call_args_list))
 def test_stale_version_identity_code_parser_and_symlink_are_rejected(self):
  for issue in ['version','identity','code','parser','symlink','helper-mode']:
   with self.subTest(issue=issue),tempfile.TemporaryDirectory() as root,patch.object(v.subprocess,'run'):
    app,helper=self.fixture(root);plist=helper/'Contents/Info.plist';info=plistlib.loads(plist.read_bytes())
    if issue=='version':info['CFBundleVersion']='0.1.9'
    if issue=='identity':info['CFBundleIdentifier']='other'
    if issue=='helper-mode':info['LSUIElement']=False
    plist.write_bytes(plistlib.dumps(info))
    if issue=='code':(helper/'Contents/MacOS/yam-background').write_bytes(b'stale')
    if issue=='parser':(helper/'Contents/Resources/target/terminal-runtime/yam-terminal.cjs').write_bytes(b'stale')
    if issue=='symlink':binary=helper/'Contents/MacOS/yam-background';binary.unlink();binary.symlink_to(app/'Contents/MacOS/yam-desktop')
    with self.assertRaises(ValueError):v.verify(app,'0.1.10')
 def test_signature_failure_is_not_hidden(self):
  with tempfile.TemporaryDirectory() as root,patch.object(v.subprocess,'run',side_effect=RuntimeError('signature failed')):
   app,_=self.fixture(root)
   with self.assertRaises(RuntimeError):v.verify(app,'0.1.10')

class PackagingPathTests(unittest.TestCase):
 def test_fixture_layout_matches_the_tauri_helper_destination(self):
  import json
  config=json.loads((Path(__file__).resolve().parents[1]/'apps/desktop/src-tauri/tauri.conf.json').read_text())
  self.assertEqual(config['bundle']['macOS']['files']['Helpers/YAM Background.app'],'target/background-helper/YAM Background.app')
