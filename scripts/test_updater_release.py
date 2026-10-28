"""Author: Jeff.Liu. Release metadata cannot publish a mismatched or unsigned update."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import tomllib
SPEC=importlib.util.spec_from_file_location('updater_release',Path(__file__).with_name('updater_release.py'))
class ReleaseTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.artifact=self.root/'YAM.app.tar.gz';fixture=Path(__file__).resolve().parents[1]/'apps/desktop/tests/fixtures';self.artifact.write_bytes((fixture/'updater-artifact.txt').read_bytes());self.signature=(fixture/'updater-artifact.txt.sig').read_text().strip();self.artifact.with_suffix('.gz.sig').write_text(self.signature);config=self.root/'apps/desktop/src-tauri/tauri.conf.json';config.parent.mkdir(parents=True);config.write_text(json.dumps({'plugins':{'updater':{'pubkey':(fixture/'updater-public.key').read_text().strip()}}}))
 def tearDown(self):self.temp.cleanup()
 def module(self):
  module=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(module);module.ROOT=self.root;return module
 def test_manifest_binds_platform_version_and_release_url(self):
  value=self.module().manifest('7.8.9',{'darwin-aarch64':self.artifact},'Release notes')
  self.assertEqual(value['version'],'7.8.9');self.assertEqual(value['platforms']['darwin-aarch64']['signature'],self.signature);self.assertEqual(value['platforms']['darwin-aarch64']['url'],'https://github.com/ainiaa/yam/releases/download/v7.8.9/YAM.app.tar.gz')
 def test_unsigned_missing_malformed_wrong_version_and_unknown_platform_are_rejected(self):
  module=self.module()
  for target in ['darwin-arm64','unknown','../../escape']:
   with self.assertRaises(ValueError):module.manifest('7.8.9',{target:self.artifact},'')
  for version in ['0.1.2','../0.1.1','v0.1.1','']:
   with self.assertRaises(ValueError):module.manifest(version,{'darwin-aarch64':self.artifact},'')
  self.artifact.with_suffix('.gz.sig').write_text('invalid')
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
  self.artifact.with_suffix('.gz.sig').unlink()
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
 def test_asset_and_signature_names_must_be_unique_across_targets_and_metadata(self):
  other=self.root/'x64';other.mkdir();duplicate=other/self.artifact.name;duplicate.write_bytes(b'other architecture');Path(str(duplicate)+'.sig').write_text(self.signature)
  with self.assertRaises(ValueError):self.module().manifest('7.8.9',{'darwin-aarch64':self.artifact,'darwin-x86_64':duplicate},'')
  for name in ['latest.json','SHA256SUMS',self.artifact.name+'.sig']:
   candidate=other/name;candidate.write_bytes(b'owned artifact');Path(str(candidate)+'.sig').write_text(self.signature)
   with self.assertRaises(ValueError):self.module().manifest('7.8.9',{'darwin-aarch64':self.artifact,'darwin-x86_64':candidate},'')
 def test_release_rejects_modified_bytes_forged_comment_wrong_key_and_fake_packets(self):
  module=self.module();original=self.artifact.read_bytes();self.artifact.write_bytes(original+b'changed')
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
  self.artifact.write_bytes(original);sig=Path(str(self.artifact)+'.sig');decoded=base64.b64decode(self.signature).decode();sig.write_text(base64.b64encode(decoded.replace('untrusted comment: signature from tauri secret key','untrusted comment: '+'x'*9000).encode()).decode())
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
  sig.write_text(base64.b64encode(decoded.replace('version:7.8.9','version:0.1.1').encode()).decode())
  with self.assertRaises(ValueError):module.manifest('0.1.1',{'darwin-aarch64':self.artifact},'')
  sig.write_text(base64.b64encode(b'untrusted comment: fake\nNOT_A_SIGNATURE\ntrusted comment: version:7.8.9\nNOT_A_SIGNATURE\n').decode())
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
  sig.write_text(self.signature);real=Path(__file__).resolve().parents[1]/'apps/desktop/src-tauri/tauri.conf.json';(self.root/'apps/desktop/src-tauri/tauri.conf.json').write_bytes(real.read_bytes())
  with self.assertRaises(ValueError):module.manifest('7.8.9',{'darwin-aarch64':self.artifact},'')
 def test_release_configuration_uses_our_source_signed_version_and_no_downgrades(self):
  root=Path(__file__).resolve().parents[1];config=json.loads((root/'apps/desktop/src-tauri/tauri.conf.json').read_text());updater=config['plugins']['updater'];self.assertEqual(updater['endpoints'],['https://github.com/ainiaa/yam/releases/latest/download/latest.json']);self.assertTrue(updater['requireSignedVersion']);self.assertFalse(updater['allowDowngrades']);self.assertIn('untrusted comment:',base64.b64decode(updater['pubkey']).decode());release=json.loads((root/'apps/desktop/src-tauri/tauri.release.conf.json').read_text());self.assertTrue(release['bundle']['createUpdaterArtifacts'])
 def test_release_allows_unwinding_so_backup_recovery_can_catch_installer_panics(self):
  root=Path(__file__).resolve().parents[1];value=tomllib.loads((root/'apps/desktop/src-tauri/Cargo.toml').read_text());self.assertEqual(value['profile']['release']['panic'],'unwind')
if __name__=='__main__':unittest.main()
