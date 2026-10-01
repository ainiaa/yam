"""Author: Jeff.Liu. Runtime trust and packaging regression checks."""
import importlib.util,pathlib,tempfile,unittest,hashlib,io,sys,os
from unittest import mock
path=pathlib.Path(__file__).with_name('build-terminal-runtime.py')
spec=importlib.util.spec_from_file_location('terminal_runtime',path);runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class RuntimeTests(unittest.TestCase):
 def test_cached_archive_verification_is_bounded_and_preserves_invalid_files(self):
  with tempfile.TemporaryDirectory() as directory:
   archive=pathlib.Path(directory)/'node.zip';content=b'valid cached archive';archive.write_bytes(content)
   with mock.patch.object(pathlib.Path,'read_bytes',side_effect=AssertionError('Unbounded cache read')):
    self.assertTrue(runtime.archive_verified(archive,hashlib.sha256(content).hexdigest(),limit=len(content)))
    self.assertFalse(runtime.archive_verified(archive,'0'*64,limit=len(content)))
    with self.assertRaisesRegex(ValueError,'budget'):runtime.archive_verified(archive,'0'*64,limit=len(content)-1)
    self.assertFalse(runtime.archive_verified(archive.with_name('missing'),'0'*64))
   self.assertEqual(archive.read_bytes(),content)
 def test_supported_native_targets_and_unknown_platform_fail_closed(self):
  self.assertEqual(runtime.platform_name('Darwin','arm64'),'darwin-arm64')
  self.assertEqual(runtime.platform_name('Windows','AMD64'),'win-x64')
  self.assertEqual(runtime.platform_name('Linux','aarch64'),'linux-arm64')
  with self.assertRaises(ValueError):runtime.platform_name('Darwin','universal')
 @unittest.skipUnless(any((path.resolve().parents[1]/'apps/desktop/src-tauri/target/terminal-runtime'/name).exists() for name in ['node','node.exe']), 'Packaged native runtime cache is required for the encoding smoke')
 def test_native_builder_preserves_unicode_with_legacy_default_encoding(self):
  original=io.open
  def legacy_open(file,mode='r',buffering=-1,encoding=None,errors=None,newline=None,closefd=True,opener=None):
   if 'b' not in mode and encoding in (None,'locale'):encoding='cp1252'
   return original(file,mode,buffering,encoding,errors,newline,closefd,opener)
  with tempfile.TemporaryDirectory() as directory:
   output=pathlib.Path(directory)/('terminal.exe' if os.name=='nt' else 'terminal')
   with mock.patch('io.open',legacy_open),mock.patch.object(sys,'argv',[str(path),'--output',str(output)]):
    runtime.main()
   self.assertTrue(output.is_file())
   self.assertGreater(output.stat().st_size,0)
 def test_checksum_failure_preserves_the_existing_archive(self):
  with tempfile.TemporaryDirectory() as directory:
   target=pathlib.Path(directory)/'runtime.tar.gz';target.write_bytes(b'old')
   with self.assertRaises(ValueError):runtime.download_verified(target,'0'*64,lambda:[b'bad'])
   self.assertEqual(target.read_bytes(),b'old');self.assertFalse(target.with_suffix('.partial').exists())
   runtime.download_verified(target,hashlib.sha256(b'new').hexdigest(),lambda:[b'new']);self.assertEqual(target.read_bytes(),b'new')
 def test_another_writers_partial_file_is_never_deleted(self):
  with tempfile.TemporaryDirectory() as directory:
   target=pathlib.Path(directory)/'node.zip';partial=target.with_suffix('.partial');partial.write_bytes(b'another writer')
   with self.assertRaises(FileExistsError):runtime.download_verified(target,'0'*64,lambda:[b'new'])
   self.assertEqual(partial.read_bytes(),b'another writer')
 def test_download_budget_and_failure_do_not_publish_partial_data(self):
  with tempfile.TemporaryDirectory() as directory:
   target=pathlib.Path(directory)/'node.zip'
   def interrupted():yield b'partial';raise OSError('network unavailable')
   with self.assertRaises(OSError):runtime.download_verified(target,'0'*64,interrupted)
   with self.assertRaises(ValueError):runtime.download_verified(target,'0'*64,lambda:[b'too much'],limit=2)
   self.assertFalse(target.exists());self.assertEqual(list(pathlib.Path(directory).iterdir()),[])
if __name__=='__main__':unittest.main()
