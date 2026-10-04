"""Author: Jeff.Liu. Offline notices and real release-entry regression fixtures."""
import contextlib
import hashlib
import io
import json
import pathlib
import os
import tempfile
import tarfile
import sys
import unittest
from unittest import mock

import third_party_notices as notices
import test_terminal_runtime as runtime_tests
runtime = runtime_tests.runtime
import test_macos_release as release_tests
release = release_tests.release


class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.patch = mock.patch.object(notices, "NPM_EXPECTED", [{"name": "sample", "version": "1.0.0", "source": "https://registry.npmjs.org/sample/-/sample-1.0.0.tgz", "checksum": "sha512-fixture"}])
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.raw_make_manifest = notices.make_manifest
        approval = mock.patch.object(notices, "APPROVED_MANIFEST_SHA256", notices.APPROVED_MANIFEST_SHA256)
        approval.start(); self.addCleanup(approval.stop)
        def assemble_private_fixture(*args, **kwargs):
            result = self.raw_make_manifest(*args, **kwargs)
            notices.APPROVED_MANIFEST_SHA256 = notices.digest(notices.canonical(result))
            return result
        factory = mock.patch.object(notices, "make_manifest", side_effect=assemble_private_fixture)
        factory.start(); self.addCleanup(factory.stop)

    def fixture(self, root):
        desktop = root / "apps/desktop"
        (desktop / "src-tauri").mkdir(parents=True)
        (desktop / "src-tauri/Cargo.lock").write_text('version = 4\n[[package]]\nname="yam-desktop"\nversion="0.1.0"\n[[package]]\nname="example"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + 'a' * 64 + '"\n')
        (desktop / "pnpm-lock.yaml").write_text("fixture lock bytes\n")
        (desktop / "package.json").write_text(json.dumps({"dependencies": {"sample": "1.0.0"}}))
        patch = mock.patch.object(notices, "NPM_INPUTS", {key: value for key, value in notices.inputs(root).items() if key != "cargo_lock"})
        patch.start(); self.addCleanup(patch.stop)
        body = "\r\n ORIGINAL 中文 license \r\n".encode()
        records = [
            {"ecosystem": "cargo", "name": "example", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "checksum": "a" * 64, "license": "MIT", "gap": None, "bodies": [body], "supplemental": []},
            {"ecosystem": "npm", "name": "sample", "version": "1.0.0", "source": "https://registry.npmjs.org/sample/-/sample-1.0.0.tgz", "checksum": "sha512-fixture", "license": "MIT", "gap": None, "bodies": [body], "supplemental": []},
        ]
        qualifications={(row["ecosystem"],row["name"],row["version"],row["checksum"]):{hashlib.sha256(body).hexdigest()} for row in records}
        patch=mock.patch.object(notices,"QUALIFIED_BODIES",qualifications)
        patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(notices,"NODE_BODY_SHA256",hashlib.sha256(body).hexdigest());patch.start();self.addCleanup(patch.stop)
        return records, body

    def test_normal_shared_body_deterministic_and_cache_free_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, body = self.fixture(root)
            manifest = notices.make_manifest(root, records, additional=[])
            with mock.patch("subprocess.run", side_effect=AssertionError("render must not execute")):
                rendered, report = notices.render(root, manifest, mode="release")
                again, _ = notices.render(root, manifest, mode="release")
            self.assertEqual(rendered, again)
            self.assertEqual(rendered.count(body), 2)
            self.assertTrue(report["complete"])
            self.assertEqual(report["selected"], 2)

    def test_gap_developer_truthful_and_release_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, _ = self.fixture(root)
            records[1]["gap"] = "full_text_unavailable"
            records[1]["bodies"] = []
            manifest = notices.make_manifest(root, records, additional=[])
            content, report = notices.render(root, manifest, mode="developer")
            self.assertIn(b"DEVELOPER-INCOMPLETE", content)
            self.assertFalse(report["complete"])
            self.assertNotIn("license_ready", report)
            self.assertEqual(len(report["gaps"]), 1)
            with self.assertRaisesRegex(ValueError, "notice"):
                notices.render(root, manifest, mode="release")

    def test_unqualified_body_cannot_be_declared_complete_by_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,_=self.fixture(root)
            manifest=notices.make_manifest(root,rows,additional=[])
            descriptor=notices.store_body(root,b"SPDX-License-Identifier: MIT\n",{"kind":"unqualified_declaration"})
            manifest["records"][0]["bodies"]=[descriptor]
            manifest["records"][0]["gap"]=None
            with self.assertRaises(ValueError):notices.render(root,manifest,mode="release")

    def test_qualified_record_cannot_omit_required_second_body(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,_=self.fixture(root)
            second=b"SECOND ORIGINAL SOURCE BODY"
            rows[0]["bodies"].append(second)
            key=("cargo","example","1.0.0","a"*64)
            notices.QUALIFIED_BODIES[key].add(hashlib.sha256(second).hexdigest())
            manifest=notices.make_manifest(root,rows,additional=[])
            manifest["records"][0]["bodies"].pop()
            with self.assertRaises(ValueError):notices.render(root,manifest,mode="release")

    def test_equal_count_identity_substitution_and_lock_drift_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, _ = self.fixture(root)
            manifest = notices.make_manifest(root, records, additional=[])
            wrong = json.loads(json.dumps(manifest))
            wrong["records"][0]["version"] = "2.0.0"
            with self.assertRaises(ValueError):
                notices.render(root, wrong, mode="developer")
            (root / "apps/desktop/pnpm-lock.yaml").write_text("changed")
            with self.assertRaises(ValueError):
                notices.render(root, manifest, mode="developer")

    def test_changed_npm_input_cannot_be_reapproved_by_regenerating_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, _ = self.fixture(root)
            original = notices.inputs(root)
            with mock.patch.object(notices, "NPM_INPUTS", {key: original[key] for key in ["pnpm_lock", "declarations"]}, create=True):
                (root / "apps/desktop/pnpm-lock.yaml").write_text("new unreviewed lock")
                with self.assertRaises(ValueError):
                    notices.make_manifest(root, records, additional=[])

    def test_actual_archive_checks_identity_checksum_members_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / "example.crate"
            body = b"\r\n Permission is hereby granted FIXTURE\r\n"
            with tarfile.open(archive, "w:gz") as tar:
                for name, data in [("Cargo.toml", b'[package]\nname="example"\nversion="1.0.0"\nlicense-file="LICENSE"\n'), ("LICENSE", body)]:
                    member = tarfile.TarInfo("example-1.0.0/" + name)
                    member.size = len(data)
                    tar.addfile(member, io.BytesIO(data))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            record = notices.archive_record(archive, name="example", version="1.0.0", checksum=digest)
            self.assertEqual(record["bodies"], [body])
            with self.assertRaises(ValueError):
                notices.archive_record(archive, name="example", version="2.0.0", checksum=digest)
            with self.assertRaises(ValueError):
                notices.archive_record(archive, name="example", version="1.0.0", checksum="0" * 64)

    def test_archive_link_or_traversal_and_spdx_only_never_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            for bad in ["../LICENSE", "link"]:
                archive = pathlib.Path(directory) / "bad.crate"
                with tarfile.open(archive, "w:gz") as tar:
                    member = tarfile.TarInfo("example-1.0.0/" + bad)
                    member.type = tarfile.SYMTYPE; member.linkname = "/outside"
                    tar.addfile(member)
                with self.assertRaises(ValueError):
                    notices.archive_record(archive, name="example", version="1.0.0", checksum=hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_publisher_license_file_declaration_only_is_still_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory)/"spdx.crate"
            with tarfile.open(archive,"w:gz") as tar:
                for relative,data in [("Cargo.toml",b'[package]\nname="example"\nversion="1.0.0"\nlicense-file="LICENSE"\n'),("LICENSE",b"SPDX-License-Identifier: MIT\n")]:
                    member=tarfile.TarInfo("example-1.0.0/"+relative);member.size=len(data);tar.addfile(member,io.BytesIO(data))
            record=notices.archive_record(archive,name="example",version="1.0.0",checksum=hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(record["bodies"],[])
            self.assertIsNotNone(record["gap"])

    def test_packaged_report_recomputed_not_trusted_and_mixed_bytes_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, body = self.fixture(root)
            manifest = notices.make_manifest(root, records, additional=[{"name":"Node","version":"26.10.0","body":body,"provenance":{"kind":"fixture_archive"}}])
            path = root / "scripts/third-party-notices/manifest.json"
            path.write_bytes(notices.canonical(manifest))
            resources = root / "resources"; resources.mkdir()
            binary = resources / "yam-terminal"; binary.write_bytes(b"fixture runtime")
            content, report = notices.render(root, manifest, mode="release")
            notice = resources / "THIRD-PARTY-NOTICES.txt"; notice.write_bytes(content)
            reportfile = resources / "THIRD-PARTY-NOTICES.report.json"
            reportfile.write_bytes(notices.canonical(notices.report_for_binary(report, binary)))
            self.assertTrue(notices.validate_packaged(root, resources)["complete"])
            binary.write_bytes(b"mixed new runtime")
            with self.assertRaises(ValueError):
                notices.validate_packaged(root, resources)
            binary.write_bytes(b"fixture runtime")
            report["complete"] = False
            reportfile.write_bytes(notices.canonical(notices.report_for_binary(report, binary)))
            with self.assertRaises(ValueError):
                notices.validate_packaged(root, resources)

    def test_graph_reader_enforces_real_byte_and_time_budgets(self):
        result = notices.graph_output([sys.executable, "-c", "print('[]')"], limit=100, timeout=1)
        self.assertEqual(json.loads(result), [])
        with self.assertRaises(ValueError):
            notices.graph_output([sys.executable, "-c", "print('x'*10000)"], limit=100, timeout=1)
        with self.assertRaises(ValueError):
            notices.graph_output([sys.executable, "-c", "import time;time.sleep(2)"], limit=100, timeout=.05)

    def test_body_corrupt_symlink_oversize_and_npm_identity_or_sri_splitbrain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records, _ = self.fixture(root)
            manifest = notices.make_manifest(root, records, additional=[])
            for key, value in [("name", "development-only"), ("checksum", "sha512-wrong"), ("source", "https://wrong.example/package.tgz")]:
                wrong = json.loads(json.dumps(manifest)); wrong["records"][1][key] = value
                with self.assertRaises(ValueError): notices.render(root, wrong, mode="developer")
            path = notices.body_path(root, manifest["records"][0]["bodies"][0]["sha256"])
            path.write_bytes(b"corrupted")
            with self.assertRaises(ValueError): notices.render(root, manifest, mode="developer")

    def test_npm_archive_sri_metadata_and_original_body(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "sample.tgz"
            body = b"Permission is hereby granted\r\nORIGINAL\r\n"
            with tarfile.open(path, "w:gz") as tar:
                for membername, data in [("package/package.json", b'{"name":"sample","version":"1.0.0","license":"MIT"}'), ("package/LICENSE", body)]:
                    member = tarfile.TarInfo(membername); member.size = len(data); tar.addfile(member, io.BytesIO(data))
            import base64
            sri = "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
            entry = {"name":"sample", "version":"1.0.0", "source":"https://registry.npmjs.org/sample.tgz", "checksum":sri}
            record = notices.npm_archive_record(path, entry)
            self.assertEqual(record["bodies"], [body])
            with self.assertRaises(ValueError): notices.npm_archive_record(path, {**entry, "checksum":"sha512-wrong"})
            with self.assertRaises(ValueError): notices.npm_archive_record(path, {**entry, "version":"2.0.0"})

    def test_actual_collection_requires_exact_independent_installed_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            rows, _ = self.fixture(root)
            bridge = {"cargo":{"identities":[{"identity":{key:rows[0][key] for key in ["name","version","source","checksum"]}, "archive":{"path":"declared.crate"}, "body_candidates":[]}]}, "npm":{"identities":[]}}
            with mock.patch.object(notices, "graph_output", return_value='[{"dependencies":{"development-only":{"version":"1.0.0"}}}]'):
                with self.assertRaises(ValueError): notices.collect(root, bridge, {"records":[]}, [])
            bridge["npm"]["identities"] = [{"identity":{"name":"sample", "version":"1.0.0"}, "body_sources":[]}]
            installed = root / "apps/desktop/node_modules/transitive/sample"; installed.mkdir(parents=True); (installed / "package.json").write_text('{"name":"sample","version":"1.0.0"}')
            receipt = {"records":[{"name":"sample", "version":"1.0.0", "archive":"declared.tgz"}]}
            qualified=root/"qualified-LICENSE";qualified.write_bytes(b"QUALIFIED ORIGINAL SOURCE")
            sha=hashlib.sha256(qualified.read_bytes()).hexdigest()
            bridge["cargo"]["identities"][0]["body_candidates"]=[{"source_path":str(qualified),"sha256":sha,"bytes":qualified.stat().st_size,"upstream_url":"https://example.invalid/fixedcommit/LICENSE","revision":"f"*40}]
            rows[1]["_metadata_sha256"]=hashlib.sha256((installed/"package.json").read_bytes()).hexdigest()
            rows[1]["provenance"]={"bodies":[{"kind":"fixture_source"}],"supplemental":[]}
            rows[0]["bodies"]=[];rows[0]["gap"]="full_text_source_classification_unresolved";rows[0]["provenance"]={"bodies":[],"supplemental":[]}
            with mock.patch.object(notices,"QUALIFIED_BODIES",{**notices.QUALIFIED_BODIES,("cargo","example","1.0.0","a"*64):{sha}},create=True), mock.patch.object(notices, "graph_output", return_value=json.dumps([{"dependencies":{"sample":{"version":"1.0.0", "path":str(installed)}}}])), mock.patch.object(notices, "archive_record", return_value=rows[0]), mock.patch.object(notices, "npm_archive_record", return_value=rows[1]):
                manifest = notices.collect(root, bridge, receipt, [])
                self.assertEqual(len(manifest["records"]), 2)
                self.assertIsNone(manifest["records"][0]["gap"])
                self.assertEqual(manifest["records"][0]["bodies"][0]["sha256"],sha)
            wrong_graph=[{"dependencies":{"sample":{"version":"1.0.0","path":str(installed),"resolved":"https://wrong.invalid/sample.tgz"}}}]
            with mock.patch.object(notices,"graph_output",return_value=json.dumps(wrong_graph)),mock.patch.object(notices,"archive_record",return_value=rows[0]),mock.patch.object(notices,"npm_archive_record",return_value=rows[1]),mock.patch.object(notices,"QUALIFIED_BODIES",{**notices.QUALIFIED_BODIES,("cargo","example","1.0.0","a"*64):{sha}}):
                with self.assertRaises(ValueError):notices.collect(root,bridge,receipt,[])

    def test_actual_render_cli_and_verified_node_additional(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); records,body=self.fixture(root)
            manifest=notices.make_manifest(root,records,additional=[{"name":"Node","version":"26.10.0","body":body,"provenance":{"kind":"fixture_archive"}}]); path=root/"scripts/third-party-notices/manifest.json";path.write_bytes(notices.canonical(manifest))
            (root/"scripts/third_party_notices.py").write_bytes(pathlib.Path(notices.__file__).read_bytes())
            output=root/"developer.txt"
            with mock.patch.object(notices,"__file__",str(root/"scripts/third_party_notices.py")), mock.patch.object(sys,"argv",["notices","render","--notice-mode","developer","--output",str(output)]):
                notices.main()
            self.assertIn(b"DEVELOPER-INCOMPLETE",output.read_bytes())
            archive=root/"node-v26.10.0-fixture.tar.gz"
            with tarfile.open(archive,"w:gz") as tar:
                body=b"NODE ORIGINAL\r\n";member=tarfile.TarInfo("node-v26.10.0-fixture/LICENSE");member.size=len(body);tar.addfile(member,io.BytesIO(body))
            checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
            (root/"scripts/node-runtime-checksums.json").write_text(json.dumps({archive.name:checksum}))
            self.assertEqual(notices.node_additional(root,archive)["body"],body)
            archive.write_bytes(b"changed")
            with self.assertRaises(ValueError):notices.node_additional(root,archive)

    def test_private_body_symlink_fifo_size_and_selected_budgets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,body=self.fixture(root)
            manifest=notices.make_manifest(root,rows,additional=[])
            path=notices.body_path(root,manifest["records"][0]["bodies"][0]["sha256"])
            original=path.read_bytes();target=root/"original-body";target.write_bytes(original)
            path.unlink();path.symlink_to(target)
            with self.assertRaises(ValueError):notices.render(root,manifest,mode="developer")
            path.unlink()
            if hasattr(os,"mkfifo"):
                os.mkfifo(path)
                with self.assertRaises(ValueError):notices.render(root,manifest,mode="developer")
                path.unlink()
            path.write_bytes(original)
            with mock.patch.object(notices,"BODY_LIMIT",len(original)-1):
                with self.assertRaises(ValueError):notices.render(root,manifest,mode="developer")
            with mock.patch.object(notices,"SELECTED_LIMIT",len(original)):
                with self.assertRaises(ValueError):notices.render(root,manifest,mode="developer")
            with mock.patch.object(notices,"IDENTITY_LIMIT",1):
                with self.assertRaises(ValueError):notices.make_manifest(root,rows,additional=[])
            for key,value in [("schema",True),("additional",None),("records",None)]:
                wrong=json.loads(json.dumps(manifest));wrong[key]=value
                with self.assertRaises(ValueError):notices.render(root,wrong,mode="developer")
            wrong=json.loads(json.dumps(manifest));wrong["extra_sensitive"]=True
            with self.assertRaises(ValueError):notices.render(root,wrong,mode="developer")
        with self.assertRaises(ValueError):notices.graph_output([sys.executable,"-c","import sys;print('x'*120,file=sys.stderr)"],limit=100,timeout=1)

    def repair_archives(self, root, cargo_body=b"CARGO ORIGINAL", npm_body=b"Permission is hereby granted NPM ORIGINAL", extra_npm=()):
        cargo_metadata=b'[package]\nname="example"\nversion="1.0.0"\nlicense-file="LICENSE"\n'.replace(b"\\n",b"\n")
        npm_metadata=b'{"name":"sample","version":"1.0.0","license":"MIT"}'
        paths=[]
        for prefix, metadata_name, metadata, body, extras in [("example-1.0.0","Cargo.toml",cargo_metadata,cargo_body,()),("package","package.json",npm_metadata,npm_body,extra_npm)]:
            path=root/("sample.crate" if metadata_name=="Cargo.toml" else "sample.tgz")
            with tarfile.open(path,"w:gz") as archive:
                for name,data in [(metadata_name,metadata),("LICENSE",body),*extras]:
                    member=tarfile.TarInfo(prefix+"/"+name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
            paths.append(path)
        import base64
        cargo_sha=hashlib.sha256(paths[0].read_bytes()).hexdigest()
        entry={"name":"sample","version":"1.0.0","source":"https://registry.npmjs.org/sample/-/sample-1.0.0.tgz","checksum":"sha512-"+base64.b64encode(hashlib.sha512(paths[1].read_bytes()).digest()).decode()}
        return paths,cargo_sha,entry,[cargo_metadata,npm_metadata]

    def test_r1_archive_budget_checked_before_next_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); paths,sha,entry,metadata=self.repair_archives(root)
            for index,read in [(0,lambda:notices.archive_record(paths[0],name="example",version="1.0.0",checksum=sha)),(1,lambda:notices.npm_archive_record(paths[1],entry))]:
                size=len(metadata[index])+len(b"CARGO ORIGINAL" if index==0 else b"Permission is hereby granted NPM ORIGINAL")
                with self.subTest(reader=index),mock.patch.object(notices,"SELECTED_LIMIT",size):
                    self.assertEqual(len(read()["bodies"]),1)
                original=tarfile.TarFile.extractfile; extracted=[]
                def extract(archive,member):
                    extracted.append(member.name);return original(archive,member)
                with self.subTest(reader=index),mock.patch.object(notices,"SELECTED_LIMIT",size-1),mock.patch.object(tarfile.TarFile,"extractfile",new=extract):
                    with self.assertRaises(ValueError):read()
                    self.assertFalse(any(name.endswith('/LICENSE') for name in extracted),extracted)

    def test_r1_collection_cumulative_records_additional_and_hints_pre_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,_=self.fixture(root);paths,sha,entry,metadata=self.repair_archives(root)
            lock=root/"apps/desktop/src-tauri/Cargo.lock";lock.write_text(lock.read_text().replace('a'*64,sha))
            installed=root/"apps/desktop/node_modules/sample";installed.mkdir(parents=True);(installed/"package.json").write_bytes(metadata[1])
            bridge={"cargo":{"identities":[{"identity":{"name":"example","version":"1.0.0","source":rows[0]["source"],"checksum":sha},"archive":{"path":str(paths[0])},"body_candidates":[]}]},"npm":{"identities":[{"identity":{"name":"sample","version":"1.0.0"},"body_sources":[]}]}}
            receipt={"records":[{"name":"sample","version":"1.0.0","archive":str(paths[1])}]}
            graph=json.dumps([{"dependencies":{"sample":{"version":"1.0.0","path":str(installed)}}}])
            rawsum=sum(map(len,metadata))+len(b"CARGO ORIGINAL")+len(b"Permission is hereby granted NPM ORIGINAL")
            qualifications={("cargo","example","1.0.0",sha):{notices.digest(b"CARGO ORIGINAL")},("npm","sample","1.0.0",entry["checksum"]):{notices.digest(b"Permission is hereby granted NPM ORIGINAL")}}
            with mock.patch.object(notices,"NPM_EXPECTED",[entry]),mock.patch.object(notices,"QUALIFIED_BODIES",qualifications),mock.patch.object(notices,"NPM_INPUTS",{k:v for k,v in notices.inputs(root).items() if k!='cargo_lock'}),mock.patch.object(notices,"graph_output",return_value=graph):
                with mock.patch.object(notices,"SELECTED_LIMIT",rawsum):
                    self.assertEqual(len(notices.collect(root,bridge,receipt,[])["records"]),2)
                with self.subTest(case="cross_record"),mock.patch.object(notices,"SELECTED_LIMIT",rawsum-1):
                    with self.assertRaises(ValueError):notices.collect(root,bridge,receipt,[])
                extra={"name":"Node","version":"26.10.0","body":b"N"*rawsum,"provenance":{"kind":"fixture"}}
                original=tarfile.TarFile.extractfile;extracted=[]
                def extract(archive,member):extracted.append(member.name);return original(archive,member)
                with self.subTest(case="additional"),mock.patch.object(notices,"SELECTED_LIMIT",rawsum),mock.patch.object(tarfile.TarFile,"extractfile",new=extract):
                    with self.assertRaises(ValueError):notices.collect(root,bridge,receipt,[extra])
                    self.assertEqual(extracted,[])
                hint=root/"hint";hint.write_bytes(b"H"*rawsum)
                bridge["cargo"]["identities"][0]["body_candidates"]=[{"source_path":str(hint),"bytes":rawsum,"sha256":notices.digest(hint.read_bytes()),"upstream_url":"https://example.invalid/fixed/LICENSE"}]
                original_read=notices.read_regular;read_hints=[]
                def read(path,limit):
                    if pathlib.Path(path)==hint:read_hints.append(True)
                    return original_read(path,limit)
                with self.subTest(case="hint"),mock.patch.object(notices,"SELECTED_LIMIT",rawsum),mock.patch.object(notices,"read_regular",side_effect=read):
                    with self.assertRaises(ValueError):notices.collect(root,bridge,receipt,[])
                    self.assertEqual(read_hints,[])

    def test_r1_validation_repeated_mapping_budget_before_body_io(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,body=self.fixture(root);manifest=notices.make_manifest(root,rows,additional=[])
            original=notices.read_regular;reads=[]
            def read(path,limit):
                if 'bodies' in pathlib.Path(path).parts:reads.append(path)
                return original(path,limit)
            with mock.patch.object(notices,"SELECTED_LIMIT",2*len(body)),mock.patch.object(notices,"read_regular",side_effect=read):
                notices.validate(root,manifest);self.assertEqual(len(reads),2)
            reads.clear()
            with mock.patch.object(notices,"SELECTED_LIMIT",2*len(body)-1),mock.patch.object(notices,"read_regular",side_effect=read):
                with self.assertRaises(ValueError):notices.validate(root,manifest)
                self.assertEqual(reads,[])

    def test_r1_render_total_output_equal_and_over_packaged_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);rows,body=self.fixture(root)
            manifest=notices.make_manifest(root,rows,additional=[{"name":"Node","version":"26.10.0","body":body,"provenance":{"kind":"fixture"}}])
            (root/"scripts/third-party-notices/manifest.json").write_bytes(notices.canonical(manifest))
            resources=root/"resources";resources.mkdir();binary=resources/"yam-terminal";binary.write_bytes(b"fixture runtime")
            for mode in ["developer","release"]:
                content,report=notices.render(root,manifest,mode=mode)
                with self.subTest(mode=mode),mock.patch.object(notices,"SELECTED_LIMIT",len(content)):
                    self.assertEqual(notices.render(root,manifest,mode=mode)[0],content)
                    if mode=="release":
                        (resources/"THIRD-PARTY-NOTICES.txt").write_bytes(content)
                        (resources/"THIRD-PARTY-NOTICES.report.json").write_bytes(notices.canonical(notices.report_for_binary(report,binary)))
                        self.assertTrue(notices.validate_packaged(root,resources)["complete"])
                with self.subTest(mode=mode),mock.patch.object(notices,"SELECTED_LIMIT",len(content)-1):
                    with self.assertRaises(ValueError):notices.render(root,manifest,mode=mode)

    def test_r1_icon_code_excluded_real_supplemental_document_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            extras=[("dist/esm/icons/copyright.js",b"export const icon = 'copyright';"),("dist/esm/icons/copyright.js.map",b'{"sources":["icon.ts"]}'),("COPYRIGHT",b"Original supplemental attribution")]
            paths,_,entry,_=self.repair_archives(root,extra_npm=extras)
            record=notices.npm_archive_record(paths[1],entry)
            self.assertEqual(record["supplemental"],[b"Original supplemental attribution"])
            self.assertEqual(record["provenance"]["supplemental"][0]["member"],"package/COPYRIGHT")

    def test_r2_complete_material_inventory_bound_once_in_both_modes_and_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            rows, body = self.fixture(root)
            shared = b"COPYRIGHT original shared notice\r\n"
            for row in rows:
                row["supplemental"] = [shared, b"SPDX-License-Identifier: MIT\n"]
            trusted = notices.make_manifest(root, rows, additional=[{"name":"Node", "version":"26.10.0", "body":body, "provenance":{"kind":"fixture_archive"}}])
            approved = notices.digest(notices.canonical(trusted))
            resources = root / "resources"; resources.mkdir()
            binary = resources / "yam-terminal"; binary.write_bytes(b"fixture runtime")
            manifest_path = root / "scripts/third-party-notices/manifest.json"
            # One approval of the independent synthetic starting inventory, never of a mutated input.
            with mock.patch.object(notices, "APPROVED_MANIFEST_SHA256", approved, create=True):
                for mode in ["developer", "release"]:
                    content, report = notices.render(root, trusted, mode=mode)
                    self.assertEqual(content.count(shared), 2)
                    self.assertEqual(report["covered"], 2)
                manifest_path.write_bytes(notices.canonical(trusted))
                content, report = notices.render(root, trusted, mode="release")
                (resources / "THIRD-PARTY-NOTICES.txt").write_bytes(content)
                (resources / "THIRD-PARTY-NOTICES.report.json").write_bytes(notices.canonical(notices.report_for_binary(report, binary)))
                self.assertTrue(notices.validate_packaged(root, resources)["complete"])
                for case in ["missing", "extra", "move", "duplicate", "declaration", "provenance"]:
                    changed = json.loads(json.dumps(trusted))
                    first, second = changed["records"]
                    if case == "missing": first["supplemental"].pop(0)
                    elif case == "extra": first["supplemental"].append(notices.store_body(root,b"NEW valid but unapproved notice",{"kind":"fixture_new"}))
                    elif case == "move": second["supplemental"].append(first["supplemental"].pop(0))
                    elif case == "duplicate": first["supplemental"].append(first["supplemental"][0])
                    elif case == "declaration": first["supplemental"][1] = notices.store_body(root,b"SPDX-License-Identifier: Apache-2.0\n",{"kind":"fixture_declaration"})
                    else: first["supplemental"][0]["provenance"]["kind"] = "different_source_claim"
                    for mode in ["developer", "release"]:
                        with self.subTest(case=case, mode=mode):
                            with self.assertRaises(ValueError): notices.render(root, changed, mode=mode)
                    # An honest newly rendered/report-bound packet cannot approve the edited inventory.
                    with self.subTest(case=case, mode="packaged"):
                        try:
                            content, report = notices.render(root, changed, mode="release")
                        except ValueError:
                            continue
                        manifest_path.write_bytes(notices.canonical(changed))
                        (resources / "THIRD-PARTY-NOTICES.txt").write_bytes(content)
                        (resources / "THIRD-PARTY-NOTICES.report.json").write_bytes(notices.canonical(notices.report_for_binary(report,binary)))
                        with self.assertRaises(ValueError): notices.validate_packaged(root, resources)

    def test_r2_freshly_report_bound_packet_missing_notice_rejected_at_package_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); rows, body = self.fixture(root)
            notice = b"COPYRIGHT original required notice\r\n"
            rows[0]["supplemental"] = [notice]
            trusted = notices.make_manifest(root, rows, additional=[{"name":"Node","version":"26.10.0","body":body,"provenance":{"kind":"fixture_archive"}}])
            approved = notices.digest(notices.canonical(trusted))
            resources = root/"resources"; resources.mkdir(); binary = resources/"yam-terminal"; binary.write_bytes(b"fixture runtime")
            with mock.patch.object(notices,"APPROVED_MANIFEST_SHA256",approved):
                original, report = notices.render(root,trusted,mode="release")
                changed = json.loads(json.dumps(trusted)); changed["records"][0]["supplemental"] = []
                # This malicious packet honestly hashes the omitted-text bytes and edited inventory.
                omitted = original.replace(notice+b"\n",b"",1)
                self.assertEqual(len(original)-len(omitted),len(notice)+1)
                report = {**report,"manifest_sha256":notices.digest(notices.canonical(changed)),"notices_sha256":notices.digest(omitted)}
                (root/"scripts/third-party-notices/manifest.json").write_bytes(notices.canonical(changed))
                (resources/"THIRD-PARTY-NOTICES.txt").write_bytes(omitted)
                (resources/"THIRD-PARTY-NOTICES.report.json").write_bytes(notices.canonical(notices.report_for_binary(report,binary)))
                with self.assertRaises(ValueError):notices.validate_packaged(root,resources)
                self.assertEqual(notices.APPROVED_MANIFEST_SHA256,approved)

    def test_r2_gapped_cohort_material_is_bound_and_approval_not_recomputed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); rows, _ = self.fixture(root)
            rows[0]["gap"] = "unreviewed_candidate"
            rows[0]["supplemental"] = [b"SPDX-License-Identifier: MIT\n"]
            trusted = notices.make_manifest(root, rows, additional=[])
            approved = notices.digest(notices.canonical(trusted))
            with mock.patch.object(notices, "APPROVED_MANIFEST_SHA256", approved, create=True):
                self.assertFalse(notices.render(root, trusted, mode="developer")[1]["complete"])
                for case in ["missing", "extra", "identity_move", "provenance", "gap"]:
                    changed = json.loads(json.dumps(trusted))
                    if case == "missing": changed["records"][0]["supplemental"] = []
                    elif case == "extra": changed["records"][0]["supplemental"].append(changed["records"][1]["bodies"][0])
                    elif case == "identity_move": changed["records"][1]["supplemental"] = changed["records"][0]["supplemental"]; changed["records"][0]["supplemental"] = []
                    elif case == "provenance": changed["records"][0]["supplemental"][0]["provenance"]["revision"] = "new_unapproved_revision"
                    else: changed["records"][0]["gap"] = "different_unapproved_classification"
                    with self.subTest(case=case):
                        with self.assertRaises(ValueError): notices.render(root, changed, mode="developer")
                    self.assertEqual(notices.APPROVED_MANIFEST_SHA256, approved)

    def test_r2_actual_collector_cannot_approve_added_material(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); rows, _ = self.fixture(root)
            paths, sha, entry, metadata = self.repair_archives(root)
            lock = root / "apps/desktop/src-tauri/Cargo.lock"; lock.write_text(lock.read_text().replace("a"*64,sha))
            installed = root / "apps/desktop/node_modules/sample"; installed.mkdir(parents=True); (installed/"package.json").write_bytes(metadata[1])
            bridge = {"cargo":{"identities":[{"identity":{"name":"example","version":"1.0.0","source":rows[0]["source"],"checksum":sha},"archive":{"path":str(paths[0])},"body_candidates":[]}]},"npm":{"identities":[{"identity":{"name":"sample","version":"1.0.0"},"body_sources":[]}]}}
            receipt = {"records":[{"name":"sample","version":"1.0.0","archive":str(paths[1])}]}
            graph = json.dumps([{"dependencies":{"sample":{"version":"1.0.0","path":str(installed)}}}])
            cargo = notices.archive_record(paths[0],name="example",version="1.0.0",checksum=sha)
            npm = notices.npm_archive_record(paths[1],entry)
            qualifications = {("cargo","example","1.0.0",sha):{notices.digest(cargo["bodies"][0])},("npm","sample","1.0.0",entry["checksum"]):{notices.digest(npm["bodies"][0])}}
            with mock.patch.object(notices,"NPM_EXPECTED",[entry]),mock.patch.object(notices,"QUALIFIED_BODIES",qualifications),mock.patch.object(notices,"NPM_INPUTS",{k:v for k,v in notices.inputs(root).items() if k!="cargo_lock"}),mock.patch.object(notices,"graph_output",return_value=graph):
                trusted = notices.make_manifest(root,[cargo,npm],additional=[])
                approved = notices.digest(notices.canonical(trusted))
                with mock.patch.object(notices,"APPROVED_MANIFEST_SHA256",approved,create=True), mock.patch.object(notices,"make_manifest",self.raw_make_manifest):
                    self.assertEqual(notices.collect(root,bridge,receipt,[]),trusted)
                    hint = root/"unapproved-NOTICE"; hint.write_bytes(b"NEW NOTICE original valid bytes")
                    bridge["cargo"]["identities"][0]["body_candidates"] = [{"source_path":str(hint),"bytes":hint.stat().st_size,"sha256":notices.digest(hint.read_bytes()),"upstream_url":"https://example.invalid/fixed/NOTICE"}]
                    with self.assertRaises(ValueError):notices.collect(root,bridge,receipt,[])
                    self.assertEqual(notices.APPROVED_MANIFEST_SHA256,approved)

    def test_real_locked_inputs_are_bound_to_reviewed_npm_seed(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        found = notices.inputs(root)
        self.assertEqual(found["pnpm_lock"], "e17abb847e2c95b7ad8965ee8d08daa26338a74d0774369385a5498961b6b48a")
        self.assertEqual(found["declarations"], "97a26697e985746ddbfafef6c2229b71263aeddb2b622633fa6a1464f761faeb")


class ApprovedInventoryTests(unittest.TestCase):
    def test_r2_real_547_manifest_material_binding_includes_unqualified_cohort(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        trusted = notices.read_json(root/"scripts/third-party-notices/manifest.json")
        approved = "5ac6bbac9a05d4ae000487e98abf9f5f7db1ef42f58e1bd6d481615e688b654e"
        self.assertEqual(notices.digest(notices.canonical(trusted)),approved)
        with mock.patch.object(notices,"APPROVED_MANIFEST_SHA256",approved,create=True):
            content, report = notices.render(root,trusted,mode="developer")
            self.assertEqual((report["selected"],report["covered"],len(report["gaps"])),(547,47,500))
            self.assertEqual(len(content),4773378)
            for cohort in ["qualified", "unqualified"]:
                changed = json.loads(json.dumps(trusted))
                record = next(row for row in changed["records"] if bool(row["gap"]) == (cohort=="unqualified") and row["supplemental"])
                record["supplemental"].pop()
                with self.subTest(cohort=cohort):
                    with self.assertRaises(ValueError):notices.render(root,changed,mode="developer")



class ActualEntryTests(unittest.TestCase):
    def test_default_builder_does_not_publish_formal_notices(self):
        helper = runtime_tests.RuntimeTests()
        with helper.mocked_notice_main() as fixture:
            runtime.main()
            developer = fixture["notices"].with_name("DEVELOPER-INCOMPLETE-NOTICES.txt")
            self.assertTrue(developer.is_file(), "default build needs explicit developer artifact")
            self.assertEqual(fixture["formal_notices"].read_bytes(), b"EXISTING_NOTICES_FIXTURE")

    def test_actual_builder_rejects_symlink_frontend_body_before_processes(self):
        helper=runtime_tests.RuntimeTests()
        with helper.mocked_notice_main() as fixture:
            body=fixture["desktop"]/"node_modules/react/LICENSE"
            target=body.with_name("original-body");target.write_bytes(body.read_bytes());body.unlink();body.symlink_to(target)
            with self.assertRaisesRegex(ValueError,"frontend notice"):
                runtime.main()
            fixture["run"].assert_not_called();fixture["version"].assert_not_called();fixture["url"].assert_not_called()
            self.assertEqual(fixture["output"].read_bytes(),b"EXISTING_BINARY_FIXTURE")

    def test_r1_whole_builder_output_overhead_rejected_before_promotion(self):
        helper = runtime_tests.RuntimeTests()
        with helper.mocked_notice_main() as fixture:
            content, _ = notices.prepare(fixture["desktop"].parents[1], "release")
            paths = [fixture["output"], fixture["formal_notices"], fixture["report"]]
            fixture["report"].write_bytes(b"EXISTING_REPORT")
            old = [path.read_bytes() for path in paths]
            with mock.patch.object(notices, "SELECTED_LIMIT", len(content)-1), mock.patch.object(sys, "argv", [runtime.__file__, "--notice-mode", "release"]):
                with self.assertRaises(ValueError):
                    runtime.main()
            fixture["run"].assert_not_called()
            fixture["version"].assert_not_called()
            fixture["url"].assert_not_called()
            self.assertEqual([path.read_bytes() for path in paths], old)

    def test_r2_actual_builder_rejects_missing_or_extra_notice_before_all_side_effects(self):
        helper = runtime_tests.RuntimeTests()
        for case in ["missing", "extra"]:
            with self.subTest(case=case), helper.mocked_notice_main() as fixture:
                root = fixture["desktop"].parents[1]
                trusted = notices.read_json(fixture["manifest"])
                descriptor = notices.store_body(root,b"ORIGINAL COPYRIGHT NOTICE\r\n",{"kind":"fixture_original_notice"})
                trusted["records"][0]["supplemental"].append(descriptor)
                approved = notices.digest(notices.canonical(trusted))
                changed = json.loads(json.dumps(trusted))
                if case == "missing": changed["records"][0]["supplemental"] = []
                else: changed["records"][1]["supplemental"].append(descriptor)
                fixture["manifest"].write_bytes(notices.canonical(changed))
                fixture["report"].write_bytes(b"EXISTING REPORT")
                paths = [fixture["output"],fixture["formal_notices"],fixture["report"]]
                old = [path.read_bytes() for path in paths]
                with mock.patch.object(notices,"APPROVED_MANIFEST_SHA256",approved,create=True),mock.patch.object(sys,"argv",[runtime.__file__,"--notice-mode","release"]):
                    with self.assertRaises(ValueError): runtime.main()
                fixture["run"].assert_not_called();fixture["version"].assert_not_called();fixture["url"].assert_not_called()
                self.assertEqual([path.read_bytes() for path in paths],old)

    def test_missing_node_additional_rejected_before_any_cache_fetch(self):
        helper=runtime_tests.RuntimeTests()
        with helper.mocked_notice_main() as fixture:
            manifest=notices.read_json(fixture["manifest"]);manifest["additional"]=[];fixture["manifest"].write_bytes(notices.canonical(manifest))
            with mock.patch.object(runtime,"archive_verified",return_value=False),mock.patch.object(runtime,"download_verified",side_effect=AssertionError("preflight must precede fetch")) as fetch, mock.patch.object(sys,"argv",[runtime.__file__,"--notice-mode","release"]):
                with self.assertRaises(ValueError):runtime.main()
                fetch.assert_not_called()
            fixture["run"].assert_not_called();fixture["url"].assert_not_called()

    def test_whole_builder_release_preflight_blocks_gaps_stale_and_corruption(self):
        helper = runtime_tests.RuntimeTests()
        for case in ["gap", "stale", "body", "forged_complete"]:
            with self.subTest(case=case), helper.mocked_notice_main() as fixture:
                manifest = notices.read_json(fixture["manifest"])
                report = fixture["report"]; report.write_bytes(b"OLD_REPORT")
                if case in {"gap", "forged_complete"}:
                    manifest["records"][0]["gap"] = "missing_text"
                    fixture["manifest"].write_bytes(notices.canonical(manifest))
                    if case == "forged_complete": report.write_text('{"complete":true}')
                elif case == "stale": manifest["inputs"]["cargo_lock"] = "0"*64; fixture["manifest"].write_bytes(notices.canonical(manifest))
                else: notices.body_path(fixture["desktop"].parents[1], manifest["records"][0]["bodies"][0]["sha256"]).write_bytes(b"CORRUPT")
                old = [path.read_bytes() for path in [fixture["output"], fixture["formal_notices"], report]]
                foreign = fixture["output"].with_name("foreign.building"); foreign.write_bytes(b"OTHER_WRITER")
                with mock.patch.object(sys, "argv", [runtime.__file__, "--output",str(fixture["output"]),"--notice-mode","release"]):
                    with self.assertRaises(ValueError): runtime.main()
                fixture["run"].assert_not_called(); fixture["version"].assert_not_called(); fixture["url"].assert_not_called()
                self.assertEqual([path.read_bytes() for path in [fixture["output"],fixture["formal_notices"],report]],old)
                self.assertEqual(foreign.read_bytes(),b"OTHER_WRITER")

    def test_owned_binary_temp_is_cleaned_if_sea_config_setup_fails(self):
        helper=runtime_tests.RuntimeTests()
        with helper.mocked_notice_main() as fixture:
            original=runtime.tempfile.mkstemp;calls=0
            def temporary(*args,**kwargs):
                nonlocal calls
                calls+=1
                if calls==2:raise OSError("owned config setup fixture failure")
                return original(*args,**kwargs)
            foreign=fixture["output"].with_name("another-writer.building");foreign.write_bytes(b"OTHER_WRITER")
            with mock.patch.object(runtime.tempfile,"mkstemp",side_effect=temporary):
                with self.assertRaises(OSError):runtime.main()
            self.assertEqual(list(fixture["output"].parent.glob("yam-terminal.building-*")),[])
            self.assertEqual(foreign.read_bytes(),b"OTHER_WRITER")
            self.assertEqual(fixture["output"].read_bytes(),b"EXISTING_BINARY_FIXTURE")

    def test_pre_promotion_failure_preserves_outputs_and_mixed_publication_rejected(self):
        helper = runtime_tests.RuntimeTests()
        for phase in ["probe", "report"]:
            with self.subTest(phase=phase), helper.mocked_notice_main() as fixture:
                report = fixture["formal_notices"].with_name("THIRD-PARTY-NOTICES.report.json"); report.write_bytes(b"OLD_REPORT")
                output=fixture["output"]
                if phase=="report":
                    output=fixture["formal_notices"].with_name("yam-terminal");output.write_bytes(fixture["output"].read_bytes())
                    content,expected=notices.prepare(fixture["desktop"].parents[1],"release")
                    fixture["formal_notices"].write_bytes(content);report.write_bytes(notices.canonical(notices.report_for_binary(expected,output)))
                    self.assertTrue(notices.validate_packaged(fixture["desktop"].parents[1],output.parent)["complete"])
                old = [p.read_bytes() for p in [output,fixture["formal_notices"],report]]
                real_atomic = notices.atomic_write
                def write(path,data):
                    if phase == "report" and str(path).endswith(".report.json"): raise OSError("owned fixture promotion failed")
                    return real_atomic(path,data)
                run = fixture["run"]; original = run.side_effect
                def execute(argv,**kwargs):
                    if phase == "probe" and "--check" not in argv and "--build-sea" not in argv: raise OSError("owned probe failed")
                    return original(argv,**kwargs)
                run.side_effect = execute
                with mock.patch.object(notices,"atomic_write",side_effect=write), mock.patch.object(sys,"argv",[runtime.__file__,"--output",str(output),"--notice-mode","release"]):
                    with self.assertRaises(OSError): runtime.main()
                if phase == "probe": self.assertEqual([p.read_bytes() for p in [output,fixture["formal_notices"],report]],old)
                else:
                    self.assertNotEqual(notices.read_json(report)["runtime_sha256"],hashlib.sha256(output.read_bytes()).hexdigest())
                    with self.assertRaises(ValueError): notices.validate_packaged(fixture["desktop"].parents[1],output.parent)
                self.assertEqual(list(fixture["output"].parent.glob("yam-terminal.building-*")),[])

    def test_actual_macos_check_missing_report_rejects_before_any_tool(self):
        helper = release_tests.ReleaseTests()
        helper.setUp()
        try:
            (helper.notice_resources / "THIRD-PARTY-NOTICES.report.json").unlink()
            with mock.patch.object(release.subprocess, "run", side_effect=helper.fake_run) as run:
                with self.assertRaisesRegex(ValueError, "notice"):
                    release.check(helper.app)
                run.assert_not_called()
        finally:
            helper.doCleanups()

    def test_actual_macos_check_and_deliver_stale_corrupt_forged_before_tools(self):
        for case in ["stale", "binary", "complete"]:
            helper = release_tests.ReleaseTests(); helper.setUp()
            try:
                report = helper.notice_resources / "THIRD-PARTY-NOTICES.report.json"
                data = notices.read_json(report)
                if case == "stale": data["inputs"]["cargo_lock"] = "0"*64
                elif case == "complete": data["complete"] = False
                else: (helper.notice_resources / "yam-terminal").write_bytes(b"MIXED")
                report.write_bytes(notices.canonical(data))
                with mock.patch.object(release.subprocess,"run",side_effect=AssertionError("no tool")) as run:
                    with self.assertRaises(ValueError): release.check(helper.app)
                    with self.assertRaises(ValueError): release.deliver(helper.app, "Fixture Identity", "Fixture Profile")
                    run.assert_not_called()
            finally: helper.doCleanups()

    def test_actual_config_developer_and_explicit_release_overlay(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        config = json.loads((root / "apps/desktop/src-tauri/tauri.conf.json").read_text())
        self.assertIn("--notice-mode developer", config["build"]["beforeBuildCommand"])
        self.assertTrue(any("DEVELOPER-INCOMPLETE-NOTICES" in str(p) for p in config["bundle"]["resources"]))
        overlay = json.loads((root / "apps/desktop/src-tauri/tauri.release.conf.json").read_text())
        self.assertEqual(set(overlay) - {"$schema"}, {"build", "bundle"})
        self.assertEqual(set(overlay["build"]), {"beforeBuildCommand"})
        self.assertEqual(set(overlay["bundle"]), {"resources"})
        self.assertIn("--notice-mode release", overlay["build"]["beforeBuildCommand"])
        package = json.loads((root / "apps/desktop/package.json").read_text())
        self.assertIn("tauri.release.conf.json", package["scripts"]["build:release"])


# Author: Jeff.Liu — append only after ContractReady and writer lease grant.
class MaterialBatch01Tests(unittest.TestCase):
    EXPECTED = [{'name': 'anyhow',
      'version': '1.0.104',
      'checksum': '330a5ed07fa54e4702c9d6c4174f74427fc0ef6e214bbd677ae50a5099946470',
      'main': ['62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'arbitrary',
      'version': '1.4.2',
      'checksum': 'c3d036a3c4ab069c7b410a2ce876bd74808d2d0888a82667669f8e783a898bf1',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '15656cc11a8331f28c0986b8ab97220d3e76f98e60ed388b5ffad37dfac4710c'],
      'supp': []},
     {'name': 'async-broadcast',
      'version': '0.7.2',
      'checksum': '435a87a52755b8f27fcf321ac4f04b2802e337c8c4872923137471ec39c37532',
      'main': ['e4705ddab847449a2cdcb3c88b005ea10330aa249d9148ca2eef9c84c5d29895',
               '24e5860bf589d8501643e6ea51ffb3df66db2867492b09033d486183efbfa970'],
      'supp': []},
     {'name': 'async-channel',
      'version': '2.5.0',
      'checksum': '924ed96dd52d1b75e9c1a3e6275715fd320f5f9439fb5a4a11fa51f4221158d2',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-executor',
      'version': '1.14.0',
      'checksum': 'c96bf972d85afc50bf5ab8fe2d54d1586b4e0b46c97c50a0c9e71e2f7bcd812a',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-io',
      'version': '2.6.0',
      'checksum': '456b8a8feb6f42d237746d4b3e9a178494627745c3c56c6ea55d92ba50d026fc',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-lock',
      'version': '3.4.2',
      'checksum': '290f7f2596bd5b78a9fec8088ccd89180d7f9f55b94b0576823bbbdc72ee8311',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-process',
      'version': '2.5.0',
      'checksum': 'fc50921ec0055cdd8a16de48773bfeec5c972598674347252c0399676be7da75',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-recursion',
      'version': '1.1.1',
      'checksum': '3b43422f69d8ff38f95f1b2bb76517c91589a924d1559a0e935d7c8ce0274c11',
      'main': ['769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb',
               '30fefc3a7d6a0041541858293bcbea2dde4caa4c0a5802f996a7f7e8c0085652'],
      'supp': []},
     {'name': 'async-signal',
      'version': '0.2.14',
      'checksum': '52b5aaafa020cf5053a01f2a60e8ff5dccf550f0f77ec54a4e47285ac2bab485',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-task',
      'version': '4.7.1',
      'checksum': '8b75356056920673b02621b35afd0f7dda9306d03c79a30f5c56c44cf256e3de',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'async-trait',
      'version': '0.1.92',
      'checksum': '82f6aeea286b8eb4dd3431a1be1b59d290ace00f5bfd8e2a159bc2a05e2c1667',
      'main': ['62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': []},
     {'name': 'atomic-waker',
      'version': '1.1.2',
      'checksum': '1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'],
      'supp': ['6226d0632e2e1a80c23597e964da9812ae193c535fe058154afb034e94167aa5']},
     {'name': 'autocfg',
      'version': '1.5.1',
      'checksum': 'f2032f911046de80f0a198e0901378627c33f59ea0ac00e363d481118bd70a53',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               '27995d58ad5c1145c1a8cd86244ce844886958a35eb2b78c6b772748669999ac'],
      'supp': []},
     {'name': 'jni',
      'version': '0.21.1',
      'checksum': '1a87aa2bb7d2af34197c04845522473242e1aa17c12f4935d5856491a7fb8c97',
      'main': ['a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
               'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'],
      'supp': []}]
    APPROVED = '5ac6bbac9a05d4ae000487e98abf9f5f7db1ef42f58e1bd6d481615e688b654e'

    def _current(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        trusted = notices.read_json(root/'scripts/third-party-notices/manifest.json')
        return root, trusted

    def _raw_record(self, root, trusted, item):
        source = next(r for r in trusted['records'] if r['name']==item['name'] and r['version']==item['version'])
        pairs = [(d, d['provenance']) for d in source['bodies']+source['supplemental']]
        return {'ecosystem':'cargo','name':source['name'],'version':source['version'],
            'checksum':source['checksum'],'bodies':[],
            'supplemental':[(root/'scripts/third-party-notices/bodies'/d['sha256']).read_bytes() for d,_ in pairs],
            'provenance':{'bodies':[], 'supplemental':[provenance for _,provenance in pairs]},
            'gap':'archive_body_classification_unreviewed'}

    def test_material_batch01_fifteen_exact_main_and_supplemental_bindings(self):
        root, trusted = self._current()
        for item in self.EXPECTED:
            with self.subTest(name=item['name'], version=item['version']):
                record = self._raw_record(root,trusted,item)
                notices.qualify_record(record)
                self.assertEqual({notices.digest(b) for b in record['bodies']},set(item['main']))
                self.assertIsNone(record['gap'])
                self.assertEqual({notices.digest(b) for b in record['supplemental']},set(item['supp']))
                if item['name']=='atomic-waker':
                    self.assertEqual(len(record['supplemental'][0]),1849)

    def test_material_batch01_android_retains_both_branch_material_and_explicit_gap(self):
        root, trusted = self._current()
        key = ('cargo', 'android_system_properties', '0.1.6', 'ae221649c9976a6f6c56ae1facf410f3ddb33cc661c4b7b61020a912d4237fbc')
        self.assertIn(key,notices.KNOWN_SOURCE_GAPS)
        self.assertNotIn(key,notices.QUALIFIED_BODIES)
        row = next(r for r in trusted['records'] if r['name']=='android_system_properties' and r['version']=='0.1.6')
        self.assertEqual(row['gap'],'known_exact_source_or_full_text_gap')
        self.assertEqual(row['bodies'],[])
        self.assertEqual({(d['sha256'],d['bytes']) for d in row['supplemental']},
            {('216486f29671a4262efe32af6d84a75bef398127f8c5f369b5c8305983887a06',554),
             ('80f275e90d799911ed3830a7f242a2ef5a4ade2092fe0aa07bfb2d2cf2f2b95e',1080)})

    def test_material_batch01_public_approved_inventory_and_deterministic_developer(self):
        root, trusted = self._current()
        self.assertEqual(notices.digest(notices.canonical(trusted)),self.APPROVED)
        self.assertEqual(notices.APPROVED_MANIFEST_SHA256,self.APPROVED)
        first, report = notices.render(root,trusted,mode='developer')
        second, again = notices.render(root,trusted,mode='developer')
        self.assertEqual(first,second)
        self.assertEqual(report,again)
        self.assertEqual((report['selected'],report['covered'],len(report['gaps'])),(547,47,500))
        self.assertEqual(sum(r['gap']=='archive_body_classification_unreviewed' for r in trusted['records']),469)
        self.assertEqual(sum(r['gap'] not in [None,'archive_body_classification_unreviewed'] for r in trusted['records']),31)
        self.assertEqual(len(trusted['additional']),1)
        self.assertFalse(report['release_eligible'])
        with self.assertRaises(ValueError): notices.render(root,trusted,mode='release')

    def test_material_batch01_wrong_identity_cannot_qualify(self):
        root, trusted = self._current()
        for field, value in [('version','0.0.0-invalid'),('checksum','0'*64)]:
            with self.subTest(field=field):
                record=self._raw_record(root,trusted,self.EXPECTED[0]);record[field]=value
                notices.qualify_record(record)
                self.assertEqual(record['bodies'],[])
                self.assertIsNotNone(record['gap'])

    def test_material_batch01_public_gate_rejects_missing_main_and_atomic_supplemental(self):
        root, trusted = self._current()
        for removed in [self.EXPECTED[0]['main'][0],self.EXPECTED[0]['main'][1],
                        '6226d0632e2e1a80c23597e964da9812ae193c535fe058154afb034e94167aa5']:
            with self.subTest(removed=removed):
                changed=json.loads(json.dumps(trusted))
                name='atomic-waker' if removed.startswith('6226d063') else 'anyhow'
                row=next(r for r in changed['records'] if r['name']==name)
                group=next(group for group in ['bodies','supplemental'] if any(d['sha256']==removed for d in row[group]))
                row[group]=[d for d in row[group] if d['sha256']!=removed]
                for mode in ['developer','release']:
                    with self.assertRaises(ValueError):notices.render(root,changed,mode=mode)

    def test_material_batch01_public_gate_rejects_changed_atomic_supplemental(self):
        root, trusted = self._current();changed=json.loads(json.dumps(trusted))
        row=next(r for r in changed['records'] if r['name']=='atomic-waker')
        notice=next(d for d in row['supplemental'] if d['sha256']=='6226d0632e2e1a80c23597e964da9812ae193c535fe058154afb034e94167aa5')
        notice['bytes']=1848
        with self.assertRaises(ValueError):notices.validate(root,changed)

    def test_material_batch01_qualified_record_requires_each_reviewed_main_body(self):
        root, trusted = self._current()
        for item in self.EXPECTED:
            key=('cargo',item['name'],item['version'],item['checksum'])
            for missing in item['main']:
                with self.subTest(name=item['name'],missing=missing):
                    record=self._raw_record(root,trusted,item)
                    pairs=list(zip(record['supplemental'],record['provenance']['supplemental']))
                    pairs=[(body,source) for body,source in pairs if notices.digest(body)!=missing]
                    record['supplemental']=[body for body,_ in pairs]
                    record['provenance']['supplemental']=[source for _,source in pairs]
                    # Fixture qualification comes from the independent reviewed literal map.
                    # The separate normal test verifies the actual production map; no auto approval.
                    with mock.patch.dict(notices.QUALIFIED_BODIES,{key:set(item['main'])}):
                        with self.assertRaises(ValueError):notices.qualify_record(record)


if __name__ == "__main__":
    unittest.main()
