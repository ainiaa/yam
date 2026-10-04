"""Author: Jeff.Liu. Runtime trust and packaging regression checks."""
import importlib.util,pathlib,tempfile,unittest,hashlib,io,sys,os
import contextlib,json,subprocess,tarfile
from unittest import mock
import third_party_notices as notices
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
   report=path.resolve().parents[1]/"apps/desktop/src-tauri/target/terminal-runtime/DEVELOPER-INCOMPLETE-NOTICES.report.json"
   self.assertFalse(json.loads(report.read_text())["release_eligible"])
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
 @contextlib.contextmanager
 def mocked_notice_main(self):
  # This oracle is independent of any production descriptor list.
  expected = [("react", "19.3.0"), ("react-dom", "19.3.0"),
              ("lucide-react", "0.468.0"), ("@xterm/xterm", "6.0.0"),
              ("@xterm/addon-fit", "0.11.0")]
  with tempfile.TemporaryDirectory(prefix="yam-notice-fixture-") as directory:
   repo = pathlib.Path(directory).resolve()
   scripts = repo / "scripts"; scripts.mkdir()
   script = scripts / "build-terminal-runtime.py"; script.write_text("fixture")
   desktop = repo / "apps/desktop"
   cache = desktop / "src-tauri/target/terminal-runtime"; cache.mkdir(parents=True)
   output = repo / "output/yam-terminal"; output.parent.mkdir()
   output.write_bytes(b"EXISTING_BINARY_FIXTURE")
   formal_notices = cache / "THIRD-PARTY-NOTICES.txt"
   formal_notices.write_bytes(b"EXISTING_NOTICES_FIXTURE")
   developer_notices = cache / "DEVELOPER-INCOMPLETE-NOTICES.txt"
   developer_notices.write_bytes(b"EXISTING_NOTICES_FIXTURE")
   archive = cache / "node-v26.10.0-linux-x64.tar.gz"
   with tarfile.open(archive, "w:gz") as bundle:
    for name, content in [("bin/node", b"SYNTHETIC_NODE_FIXTURE"),
                          ("LICENSE", b"NODE_LICENSE_FIXTURE\n")]:
     member = tarfile.TarInfo("node-v26.10.0-linux-x64/" + name)
     member.size = len(content); bundle.addfile(member, io.BytesIO(content))
   digest = hashlib.sha256(archive.read_bytes()).hexdigest()
   (scripts / "node-runtime-checksums.json").write_text(json.dumps({archive.name: digest}))
   for package, version, source in [
       ("@xterm/headless", "6.0.0", "lib-headless/xterm-headless.js"),
       ("@xterm/addon-serialize", "0.14.0", "lib/addon-serialize.js")]:
    module = desktop / "node_modules" / package; module.mkdir(parents=True)
    (module / "package.json").write_text(json.dumps({"name": package, "version": version}))
    sourcefile = module / source; sourcefile.parent.mkdir()
    sourcefile.write_text("module.exports = {};\n")
   common = desktop / "terminal-licenses/XTERM-LICENSE"; common.parent.mkdir()
   common.write_text("EXISTING_XTERM_LICENSE_FIXTURE\n", encoding="utf-8")
   (desktop / "terminal-service.cjs").write_text("require('@xterm/headless');require('@xterm/addon-serialize');\n")
   bodies = {}
   for package, version in expected:
    module = desktop / "node_modules" / package; module.mkdir(parents=True)
    (module / "package.json").write_text(json.dumps({"name": package, "version": version, "license": "MIT"}))
    body = "\r\n  ORIGINAL_" + package + "_LICENSE_FIXTURE 中文  \r\n\r\n"
    (module / "LICENSE").write_bytes(body.encode("utf-8")); bodies[package] = body
   (desktop / "package.json").write_text(json.dumps({"dependencies": {row["name"]: row["version"] for row in notices.NPM_EXPECTED}}))
   (desktop / "pnpm-lock.yaml").write_text("fixture frozen lock")
   (desktop / "src-tauri/Cargo.lock").write_text('version=4\n[[package]]\nname="yam-desktop"\nversion="0.1.0"\n')
   records=[]
   for row in notices.NPM_EXPECTED:
    body=bodies.get(row["name"], "EXISTING_XTERM_LICENSE_FIXTURE\n" if row["name"] in {"@xterm/headless", "@xterm/addon-serialize"} else "EXTRA_LICENSE_FIXTURE\n")
    records.append({"ecosystem":"npm", **row, "license":"MIT", "gap":None, "bodies":[body.encode("utf-8")], "supplemental":[]})
   qualifications={(row["ecosystem"],row["name"],row["version"],row["checksum"]):{hashlib.sha256(body).hexdigest() for body in row["bodies"]} for row in records}
   with mock.patch.object(notices,"NODE_BODY_SHA256",hashlib.sha256(b"NODE_LICENSE_FIXTURE\n").hexdigest()), mock.patch.object(notices,"QUALIFIED_BODIES",qualifications), mock.patch.object(notices,"NPM_INPUTS",{key:value for key,value in notices.inputs(repo).items() if key!="cargo_lock"}):
    manifest=notices.make_manifest(repo,records,additional=[{"name":"Node","version":"26.10.0","body":b"NODE_LICENSE_FIXTURE\n","provenance":{"kind":"fixture_archive"}}])
   manifestpath=repo/"scripts/third-party-notices/manifest.json"
   manifestpath.write_bytes(notices.canonical(manifest))
   sea_output=[]
   def fake_run(argv, **kwargs):
    if "--check" in argv:
     return subprocess.CompletedProcess(argv, 0, b"", b"")
    if "--build-sea" in argv:
     config = json.loads(pathlib.Path(argv[-1]).read_text())
     sea_output.append(pathlib.Path(config["output"]))
     sea_output[-1].write_bytes(b"BUILT_BINARY_FIXTURE")
     return subprocess.CompletedProcess(argv, 0, b"", b"")
    self.assertEqual(argv, [str(sea_output[-1])])
    frames = [{"ok": True}] * 3 + [{"data": {"data": "中文 😀", "instance": "e" * 64}}]
    return subprocess.CompletedProcess(argv, 0, "\n".join(json.dumps(f) for f in frames), "")
   with mock.patch.object(notices,"APPROVED_MANIFEST_SHA256",notices.digest(notices.canonical(manifest))), mock.patch.object(notices,"NODE_BODY_SHA256",hashlib.sha256(b"NODE_LICENSE_FIXTURE\n").hexdigest()), mock.patch.object(notices,"QUALIFIED_BODIES",qualifications), mock.patch.object(notices,"NPM_INPUTS",{key:value for key,value in notices.inputs(repo).items() if key!="cargo_lock"}), \
        mock.patch.object(runtime, "__file__", str(script)), \
        mock.patch.object(sys, "argv", [str(script), "--output", str(output)]), \
        mock.patch.object(runtime.platform, "system", return_value="Linux"), \
        mock.patch.object(runtime.platform, "machine", return_value="x86_64"), \
        mock.patch.object(runtime.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")) as url, \
        mock.patch.object(runtime.subprocess, "check_output", return_value="v26.10.0\n") as version, \
        mock.patch.object(runtime.subprocess, "run", side_effect=fake_run) as run, \
        contextlib.redirect_stdout(io.StringIO()):
    yield {"desktop": desktop, "output": output, "notices": developer_notices, "formal_notices": formal_notices, "manifest":manifestpath, "report": cache/"DEVELOPER-INCOMPLETE-NOTICES.report.json",
           "expected": expected, "bodies": bodies, "url": url, "run": run, "version": version}

 def test_mock_main_generated_notices_include_frontend_licenses(self):
  with self.mocked_notice_main() as fixture:
   runtime.main()
   content = fixture["notices"].read_bytes().decode("utf-8")
   self.assertTrue(content.startswith("DEVELOPER-INCOMPLETE"))
   self.assertIn("NODE_LICENSE_FIXTURE\n",content)
   for package, version in [("@xterm/headless", "6.0.0"), ("@xterm/addon-serialize", "0.14.0")]:
    self.assertIn(package + " " + version + "\nEXISTING_XTERM_LICENSE_FIXTURE\n", content)
   for package, version in fixture["expected"]:
    heading = package + " " + version + "\n"
    self.assertEqual(content.count(heading), 1)
    self.assertIn(heading + fixture["bodies"][package], content)
   self.assertEqual(fixture["output"].read_bytes(), b"BUILT_BINARY_FIXTURE")
   self.assertEqual(sum("--build-sea" in call.args[0] for call in fixture["run"].call_args_list), 1)
   fixture["url"].assert_not_called()

 def test_mock_main_rejects_invalid_frontend_notice_sources_before_sea(self):
  cases = ["version", "name", "metadata_missing", "metadata_malformed",
           "license_metadata_missing", "license_metadata_empty", "license_metadata_nonstring",
           "license_missing", "license_empty", "license_whitespace", "license_utf8",
           "license_directory", "license_unreadable"]
  for case in cases:
   with self.subTest(case=case), self.mocked_notice_main() as fixture:
    module = fixture["desktop"] / "node_modules/react"
    metadata = module / "package.json"; licensefile = module / "LICENSE"
    fields = json.loads(metadata.read_text())
    if case == "version": fields["version"] = "0.0.0"
    elif case == "name": fields["name"] = "wrong-package"
    elif case == "license_metadata_missing": fields.pop("license")
    elif case == "license_metadata_empty": fields["license"] = " \n"
    elif case == "license_metadata_nonstring": fields["license"] = ["MIT"]
    metadata.write_text(json.dumps(fields))
    if case == "metadata_missing": metadata.unlink()
    elif case == "metadata_malformed": metadata.write_text("{")
    elif case == "license_missing": licensefile.unlink()
    elif case == "license_empty": licensefile.write_bytes(b"")
    elif case == "license_whitespace": licensefile.write_bytes(b" \r\n\t")
    elif case == "license_utf8": licensefile.write_bytes(b"\xffinvalid")
    elif case == "license_directory": licensefile.unlink(); licensefile.mkdir()
    original_read = pathlib.Path.read_bytes
    def read_bytes(path):
     if case == "license_unreadable" and path == licensefile:
      raise PermissionError("Fixture unreadable license")
     return original_read(path)
    original_regular=notices.read_regular
    def read_regular(path,limit):
     if case == "license_unreadable" and path == licensefile:
      raise PermissionError("Fixture unreadable license")
     return original_regular(path,limit)
    with mock.patch.object(pathlib.Path, "read_bytes", read_bytes), mock.patch.object(notices,"read_regular",read_regular):
     with self.assertRaisesRegex(ValueError, "Invalid frontend notice source"):
      runtime.main()
    self.assertFalse(any("--build-sea" in call.args[0] for call in fixture["run"].call_args_list))
    self.assertEqual(fixture["output"].read_bytes(), b"EXISTING_BINARY_FIXTURE")
    self.assertEqual(fixture["notices"].read_bytes(), b"EXISTING_NOTICES_FIXTURE")
    fixture["url"].assert_not_called()

if __name__=='__main__':unittest.main()
