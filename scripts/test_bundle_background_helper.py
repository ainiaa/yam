"""Author: Jeff.Liu. Validate the production helper before any desktop launch."""
import importlib.util,json,os,plistlib,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',Path(__file__).with_name('bundle-background-helper.py'))
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
class HelperTests(unittest.TestCase):
 def fixture(self,root):
  root=Path(root);native=root/'apps/desktop/src-tauri';native.mkdir(parents=True)
  (native/'tauri.conf.json').write_text(json.dumps({'version':'0.1.10','identifier':'com.yam.desktop','bundle':{'macOS':{'minimumSystemVersion':'13.5'}}}))
  binary=native/'target/release/yam-desktop';binary.parent.mkdir(parents=True);binary.write_bytes(b'current binary');binary.chmod(0o755)
  resources=native/'target/terminal-runtime';resources.mkdir();(resources/'yam-terminal.cjs').write_text('current parser');(resources/'THIRD-PARTY-NOTICES.txt').write_text('notices')
  (native/'icons').mkdir();(native/'icons/icon.icns').write_bytes(b'icon')
  return native,binary
 def test_helper_has_distinct_identity_current_binary_resources_and_no_url_claim(self):
  with tempfile.TemporaryDirectory() as root:
   native,binary=self.fixture(root)
   (native/'target/terminal-runtime/node').write_bytes(b'old unused node runtime')
   with patch.object(helper.subprocess,'run') as run:
    app=helper.stage(native,binary,'-')
   info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
   self.assertEqual(info['CFBundleIdentifier'],'com.yam.desktop.background');self.assertTrue(info['LSUIElement'])
   self.assertEqual(info['CFBundleExecutable'],'yam-background');self.assertEqual(info['CFBundleShortVersionString'],'0.1.10');self.assertNotIn('CFBundleURLTypes',info)
   self.assertEqual((app/'Contents/MacOS/yam-background').read_bytes(),binary.read_bytes())
   self.assertEqual((app/'Contents/Resources/target/terminal-runtime/yam-terminal.cjs').read_text(),'current parser')
   self.assertFalse((app/'Contents/Resources/target/terminal-runtime/node').exists(),'Never bring a stale bundled Node runtime back into the app')
   self.assertTrue(any('--sign' in call.args[0] for call in run.call_args_list));self.assertIn('--verify',run.call_args_list[-1].args[0])
 def test_missing_or_symlink_binary_and_resources_fail_before_signing(self):
  for broken in ['missing','symlink','resources']:
   with self.subTest(broken=broken),tempfile.TemporaryDirectory() as root:
    native,binary=self.fixture(root)
    if broken=='missing':binary.unlink()
    elif broken=='symlink':binary.unlink();binary.symlink_to('/bin/ls')
    else:(native/'target/terminal-runtime/yam-terminal.cjs').unlink()
    with patch.object(helper.subprocess,'run') as run:
     with self.assertRaises((ValueError,FileNotFoundError)):helper.stage(native,binary,'-')
     run.assert_not_called()
 def test_current_stage_replaces_stale_helper_and_non_macos_hook_is_noop(self):
  with tempfile.TemporaryDirectory() as root:
   native,binary=self.fixture(root)
   with patch.object(helper.subprocess,'run'):
    app=helper.stage(native,binary,'-');binary.write_bytes(b'new');helper.stage(native,binary,'-')
   self.assertEqual((app/'Contents/MacOS/yam-background').read_bytes(),b'new')
  with patch.dict(os.environ,{'TAURI_ENV_PLATFORM':'linux'}),patch.object(helper,'stage') as stage:
   self.assertEqual(helper.main(),0);stage.assert_not_called()
class DirectBuildPathTests(unittest.TestCase):
 def test_direct_target_and_external_cargo_directory_and_ambiguity(self):
  with tempfile.TemporaryDirectory() as root:
   native=Path(root)/'native';native.mkdir();target=Path(root)/'external';triple='x86_64-apple-darwin'
   binary=target/triple/'debug/yam-desktop';binary.parent.mkdir(parents=True);binary.write_bytes(b'current')
   env={'TAURI_ENV_DEBUG':'true','TAURI_ENV_TARGET_TRIPLE':triple,'CARGO_TARGET_DIR':str(target)}
   self.assertEqual(helper.source_binary(native,env),binary)
   duplicate=target/'debug/yam-desktop';duplicate.parent.mkdir();duplicate.write_bytes(b'old')
   with self.assertRaisesRegex(ValueError,'ambiguous'):helper.source_binary(native,env)
   self.assertEqual(helper.source_binary(native,{**env,'YAM_BUILD_BINARY':str(binary)}),binary)
 def test_direct_native_and_relative_target_root(self):
  with tempfile.TemporaryDirectory() as root:
   native=Path(root);binary=native/'custom/release/yam-desktop';binary.parent.mkdir(parents=True);binary.write_bytes(b'current')
   self.assertEqual(helper.source_binary(native,{'CARGO_TARGET_DIR':'custom'}),binary)
   with self.assertRaises(ValueError):helper.source_binary(native,{})
if __name__=='__main__':unittest.main()
