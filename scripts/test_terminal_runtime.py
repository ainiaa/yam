"""Author: Jeff.Liu. Runtime trust and packaging regression checks."""
import importlib.util,pathlib,tempfile,unittest,hashlib
path=pathlib.Path(__file__).with_name('build-terminal-runtime.py')
spec=importlib.util.spec_from_file_location('terminal_runtime',path);runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
class RuntimeTests(unittest.TestCase):
 def test_supported_native_targets_and_unknown_platform_fail_closed(self):
  self.assertEqual(runtime.platform_name('Darwin','arm64'),'darwin-arm64')
  self.assertEqual(runtime.platform_name('Windows','AMD64'),'win-x64')
  self.assertEqual(runtime.platform_name('Linux','aarch64'),'linux-arm64')
  with self.assertRaises(ValueError):runtime.platform_name('Darwin','universal')
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
