"""Author: Jeff.Liu. Preserve literal configuration through pnpm shell argument forwarding."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
SPEC=importlib.util.spec_from_file_location('build_release',Path(__file__).with_name('build-release.py'));module=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(module)
class BuildReleaseTests(unittest.TestCase):
 def test_public_macos_build_requires_identity_or_explicit_preview_before_spawning(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'release.json';path.write_text(json.dumps({'bundle':{'resources':[]}}))
   with patch.object(module.platform,'system',return_value='Darwin'),patch.dict(os.environ,{'APPLE_SIGNING_IDENTITY':''}),patch.object(module.subprocess,'call') as call:
    with self.assertRaisesRegex(ValueError,'preview'):module.main([str(path)])
    call.assert_not_called()
 def test_release_refuses_divergent_source_versions(self):
  with tempfile.TemporaryDirectory() as root:
   root=Path(root);desktop=root/'apps/desktop';native=desktop/'src-tauri';native.mkdir(parents=True)
   (desktop/'package.json').write_text('{"version":"0.1.2"}')
   (native/'tauri.conf.json').write_text('{"version":"0.1.1"}')
   (native/'Cargo.toml').write_text('[package]\nversion="0.1.2"\n')
   with self.assertRaisesRegex(ValueError,'version'):module.validate_versions(root)
 def test_lockfile_root_package_version_must_match_and_a_valid_release_is_returned(self):
  with tempfile.TemporaryDirectory() as root:
   root=Path(root);desktop=root/'apps/desktop';native=desktop/'src-tauri';native.mkdir(parents=True)
   (desktop/'package.json').write_text('{"version":"0.1.2"}');(native/'tauri.conf.json').write_text('{"version":"0.1.2"}');(native/'Cargo.toml').write_text('[package]\nversion="0.1.2"\n')
   lock=native/'Cargo.lock';lock.write_text('version=4\n[[package]]\nname="yam-desktop"\nversion="0.1.1"\n')
   with self.assertRaisesRegex(ValueError,'version'):module.validate_versions(root)
   lock.write_text(lock.read_text().replace('0.1.1','0.1.2'));self.assertEqual(module.validate_versions(root),'0.1.2')
 def test_config_is_closed_before_the_child_opens_it_and_removed_on_spawn_error(self):
  factory=module.tempfile.NamedTemporaryFile
  for fail in [False,True]:
   with tempfile.TemporaryDirectory() as root:
    config=Path(root)/'release.json';config.write_text(json.dumps({'bundle':{'resources':[]}}));opened=[];seen=[]
    def temporary(*args,**kwargs):
     item=factory(*args,**kwargs);opened.append(item);return item
    def call(argv):
     path=Path(argv[argv.index('--config')+1]);seen.append(path)
     self.assertTrue(all(item.closed for item in opened),'Windows child must not reopen a still-open temporary config')
     data=subprocess.check_output([sys.executable,'-c','import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())',str(path)],timeout=10)
     self.assertEqual(json.loads(data)['bundle']['resources'],[])
     if fail:raise OSError('owned spawn failure')
     return 7
    with patch.object(module.platform,'system',return_value='Linux'),patch.object(module.tempfile,'NamedTemporaryFile',side_effect=temporary),patch.object(module.subprocess,'call',side_effect=call):
     if fail:
      with self.assertRaisesRegex(OSError,'owned spawn failure'):module.main([str(config)])
     else:self.assertEqual(module.main([str(config)]),7)
    self.assertTrue(seen);self.assertFalse(seen[0].exists())
 def test_release_passes_a_file_so_schema_dollar_and_literal_commands_cannot_expand(self):
  for target,windows in [([],False),(['--target','x86_64-pc-windows-msvc'],True)]:
   with tempfile.TemporaryDirectory() as root:
    config=Path(root)/'release.json';config.write_text(json.dumps({'$schema':'literal $HOME $(danger)','build':{'beforeBuildCommand':'literal $value'},'bundle':{'resources':['target/terminal-runtime/yam-terminal','notice.txt']}}));seen=[]
    def call(argv):
     path=Path(argv[argv.index('--config')+1]);self.assertTrue(path.is_file());value=json.loads(path.read_text());seen.append(path);self.assertEqual(value['$schema'],'literal $HOME $(danger)');self.assertEqual(value['build']['beforeBuildCommand'],'literal $value');self.assertEqual(value['bundle']['resources'][0],'target/terminal-runtime/yam-terminal'+('.exe' if windows else ''));self.assertEqual(argv[-len(target):] if target else [],target);return 7
    with patch.object(module.platform,'system',return_value='Linux'),patch.object(module.subprocess,'call',side_effect=call):self.assertEqual(module.main([str(config),*target]),7)
    self.assertTrue(seen);self.assertFalse(seen[0].exists())
 def test_macos_bundle_is_explicitly_signed_and_uses_an_authorized_developer_identity_when_supplied(self):
  for identity in ['', 'Developer ID Application: Fixture']:
   with tempfile.TemporaryDirectory() as root:
    path=Path(root)/'release.json';path.write_text(json.dumps({'bundle':{'resources':[]}}))
    def call(argv):
     value=json.loads(Path(argv[argv.index('--config')+1]).read_text());self.assertEqual(value['bundle'].get('macOS',{}).get('signingIdentity'),identity or '-');return 0
    with patch.object(module.platform,'system',return_value='Darwin'),patch.dict(os.environ,{'APPLE_SIGNING_IDENTITY':identity}),patch.object(module.subprocess,'call',side_effect=call):self.assertEqual(module.main([str(path),*(['--preview'] if not identity else [])]),0)
if __name__=='__main__':unittest.main()
