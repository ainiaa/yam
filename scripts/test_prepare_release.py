"""Author: Jeff.Liu. Publish only the inspected bundle and make preview status explicit."""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

class PrepareReleaseTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  spec=importlib.util.spec_from_file_location('prepare_release',Path(__file__).with_name('prepare-release.py'))
  self.module=importlib.util.module_from_spec(spec)
  if spec.loader:spec.loader.exec_module(self.module)
  self.app=self.root/'YAM.app';(self.app/'Contents/MacOS').mkdir(parents=True)
  (self.app/'Contents/MacOS/yam-desktop').write_bytes(b'fixture')
  (self.app/'Contents/MacOS/yam-desktop').chmod(0o755)
  runtime=self.app/'Contents/Resources/target/terminal-runtime/yam-terminal'
  runtime.parent.mkdir(parents=True);runtime.write_bytes(b'runtime');runtime.chmod(0o755)
  self.info={'CFBundleIdentifier':'com.yam.desktop','CFBundleExecutable':'yam-desktop','CFBundleShortVersionString':'0.1.2','CFBundleVersion':'0.1.2'}
  (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps(self.info));self.archive=self.root/'YAM-aarch64.app.tar.gz';self.pack()
  Path(str(self.archive)+'.sig').write_text('fixture signature')
  self.notes=self.root/'notes.md';self.notes.write_text('Changes');self.output=self.root/'release'
  self.addCleanup(patch.stopall)
  patch.object(self.module,'validate_versions',return_value='0.1.2').start()
  patch.object(self.module.macos.notices,'validate_packaged').start()
  self.check=patch.object(self.module.macos,'check').start()
  self.run=patch.object(self.module.macos,'run',return_value=subprocess.CompletedProcess([],0,'arm64','')).start()
  self.manifest=patch.object(self.module.updater,'manifest',return_value={'version':'0.1.2','platforms':{'darwin-aarch64':{'url':'fixture'}}}).start()
 def pack(self):
  with tarfile.open(self.archive,'w:gz') as archive:archive.add(self.app,arcname='YAM.app')
 def prepare(self,preview=True):
  return self.module.prepare('0.1.2','darwin-aarch64',self.app,self.archive,self.notes,self.output,preview=preview)
 def test_preview_stages_complete_assets_and_explicit_status(self):
  self.prepare();self.check.assert_not_called();self.assertIn(['codesign','--verify','--deep','--strict',str(self.app.resolve())],[c.args[0] for c in self.run.call_args_list])
  receipt=json.loads((self.output/'release.json').read_text());self.assertEqual(receipt['distribution'],'unnotarized-preview')
  self.assertEqual((self.output/self.archive.name).read_bytes(),self.archive.read_bytes())
  sums=(self.output/'SHA256SUMS').read_text();self.assertIn('latest.json',sums);self.assertIn('release.json',sums);self.assertIn('RELEASE_NOTES.md',sums)
 def test_official_preparation_requires_gatekeeper_and_notary_verification(self):
  self.prepare(False);self.check.assert_called_once_with(self.app.resolve())
  self.assertEqual(json.loads((self.output/'release.json').read_text())['distribution'],'notarized')
 def test_bundle_version_identity_architecture_and_archive_mismatch_fail_without_output(self):
  for field,value in [('CFBundleShortVersionString','0.1.1'),('CFBundleIdentifier','com.other.app')]:
   info={**self.info,field:value};(self.app/'Contents/Info.plist').write_bytes(plistlib.dumps(info));self.pack()
   with self.assertRaises(ValueError):self.prepare()
   self.assertFalse(self.output.exists())
  (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps(self.info));self.pack()
  (self.app/'Contents/MacOS/yam-desktop').write_bytes(b'different bytes')
  with self.assertRaisesRegex(ValueError,'archive'):self.prepare()
  self.assertFalse(self.output.exists())
 def test_wrong_architecture_signature_and_existing_output_are_rejected(self):
  self.run.return_value=subprocess.CompletedProcess([],0,'x86_64','')
  with self.assertRaisesRegex(ValueError,'architecture'):self.prepare()
  self.run.return_value=subprocess.CompletedProcess([],0,'arm64','');self.manifest.side_effect=ValueError('signature')
  with self.assertRaisesRegex(ValueError,'signature'):self.prepare()
  self.assertFalse(self.output.exists());self.output.mkdir();(self.output/'keep').write_text('keep')
  with self.assertRaises(FileExistsError):self.prepare()
  self.assertEqual((self.output/'keep').read_text(),'keep')
 def test_invalid_target_and_versions_fail_before_native_commands(self):
  with self.assertRaises(ValueError):self.module.prepare('0.1.2','windows-x86_64',self.app,self.archive,self.notes,self.output,preview=True)
  self.run.assert_not_called()
 def test_reserved_metadata_names_cannot_replace_a_verified_artifact(self):
  reserved=self.root/'release.json';reserved.write_bytes(self.archive.read_bytes());Path(str(reserved)+'.sig').write_text('fixture')
  with self.assertRaises(ValueError):self.module.prepare('0.1.2','darwin-aarch64',self.app,reserved,self.notes,self.output,preview=True)
  self.assertFalse(self.output.exists())
 def test_archive_permissions_and_directory_structure_must_match_bundle(self):
  for name in ['YAM.app/Contents/MacOS/yam-desktop','YAM.app/Contents/Resources/target/terminal-runtime/yam-terminal','YAM.app/Contents/MacOS']:
   with self.subTest(name=name):
    def strip_permissions(member):
     if member.name==name:member.mode=0o644
     return member
    with tarfile.open(self.archive,'w:gz') as archive:archive.add(self.app,arcname='YAM.app',filter=strip_permissions)
    with self.assertRaisesRegex(ValueError,'permissions'):self.prepare()
    self.assertFalse(self.output.exists())
  for directory in ['YAM.app/Contents/MacOS','YAM.app/unexpected']:
   with self.subTest(directory=directory):
    with tarfile.open(self.archive,'w:gz') as archive:
     archive.add(self.app,arcname='YAM.app',filter=lambda m:None if m.name==directory else m)
     if directory.endswith('unexpected'):
      member=tarfile.TarInfo(directory);member.type=tarfile.DIRTYPE;archive.addfile(member)
    with self.assertRaisesRegex(ValueError,'archive'):self.prepare()
    self.assertFalse(self.output.exists())

if __name__=='__main__':unittest.main()
