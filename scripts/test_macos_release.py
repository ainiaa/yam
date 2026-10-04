"""Author: Jeff.Liu. Checks release ordering without signing or uploading."""
import hashlib
import contextlib
import importlib.util
import io
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import third_party_notices as notices

SPEC = importlib.util.spec_from_file_location("macos_release", pathlib.Path(__file__).with_name("macos-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = pathlib.Path(self.tmp.name) / "YAM.app"
        (self.app / "Contents" / "MacOS").mkdir(parents=True)
        (self.app / "Contents" / "MacOS" / "yam-desktop").write_text("fixture")
        (self.app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier":"com.yam.desktop", "CFBundleExecutable":"yam-desktop"}))
        self.identity = "Developer ID Application: Example (ABCDEFGHIJ)"
        root=pathlib.Path(self.tmp.name)/"source";desktop=root/"apps/desktop"; (desktop/"src-tauri").mkdir(parents=True)
        (desktop/"package.json").write_text('{"dependencies":{}}')
        (desktop/"pnpm-lock.yaml").write_text("private fixture lock")
        (desktop/"src-tauri/Cargo.lock").write_text('version=4\n[[package]]\nname="yam-desktop"\nversion="0.1.0"\n')
        patcher=patch.object(notices,"NPM_EXPECTED",[]);patcher.start();self.addCleanup(patcher.stop)
        patcher=patch.object(release,"NOTICE_ROOT",root);patcher.start();self.addCleanup(patcher.stop)
        patcher=patch.object(notices,"NPM_INPUTS",{key:value for key,value in notices.inputs(root).items() if key!="cargo_lock"});patcher.start();self.addCleanup(patcher.stop)
        node_body=b"NODE_AGGREGATE_FIXTURE"
        patcher=patch.object(notices,"NODE_BODY_SHA256",hashlib.sha256(node_body).hexdigest());patcher.start();self.addCleanup(patcher.stop)
        manifest=notices.make_manifest(root,[],additional=[{"name":"Node","version":"26.10.0","body":node_body,"provenance":{"kind":"fixture_archive"}}])
        approval=patch.object(notices,"APPROVED_MANIFEST_SHA256",notices.digest(notices.canonical(manifest)));approval.start();self.addCleanup(approval.stop)
        (root/"scripts/third-party-notices").mkdir(parents=True,exist_ok=True)
        (root/"scripts/third-party-notices/manifest.json").write_bytes(notices.canonical(manifest))
        self.notice_resources=self.app/"Contents/Resources/target/terminal-runtime"; self.notice_resources.mkdir(parents=True)
        binary=self.notice_resources/"yam-terminal";binary.write_bytes(b"synthetic runtime")
        content,report=notices.render(root,manifest,mode="release")
        (self.notice_resources/"THIRD-PARTY-NOTICES.txt").write_bytes(content)
        (self.notice_resources/"THIRD-PARTY-NOTICES.report.json").write_bytes(notices.canonical(notices.report_for_binary(report,binary)))

    def fake_run(self, args, **kwargs):
        out = ('1) ' + 'A' * 40 + ' "' + self.identity + '"\n1 valid identities found\n') if args[0] == "security" else ""
        if args[:3] == ["xcrun", "notarytool", "submit"]:
            out = '{"id":"receipt", "status":"Accepted"}'
        if args[:2] == ["codesign", "-dv"]:
            out = "Authority=" + self.identity + "\nTeamIdentifier=ABCDEFGHIJ\nflags=0x10000(runtime)\n"
        return subprocess.CompletedProcess(args, 0, out, "")

    def test_sign_then_notarize_staple_and_verify_literal_paths(self):
        with patch.object(release.subprocess, "run", side_effect=self.fake_run) as run:
            release.deliver(self.app, self.identity, "yam-notary", sign=True)
        commands = [call.args[0] for call in run.call_args_list]
        codesign = next(c for c in commands if c[:2] == ["codesign", "--force"])
        self.assertIn(self.identity, codesign)
        self.assertIn("--timestamp", codesign)
        self.assertIn("runtime", codesign)
        submit = next(c for c in commands if c[:3] == ["xcrun", "notarytool", "submit"])
        self.assertIn("--keychain-profile", submit)
        self.assertLess(commands.index(submit), next(i for i,c in enumerate(commands) if c[:3] == ["xcrun", "stapler", "staple"]))
        self.assertEqual(commands[-1][:3], ["spctl", "--assess", "--type"])
        self.assertTrue(all(not call.kwargs.get("shell", False) for call in run.call_args_list))

    def test_missing_identity_and_invalid_bundle_fail_before_mutation(self):
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([],0,"0 valid identities found", "")) as run:
            with self.assertRaisesRegex(ValueError, "certificate"):
                release.deliver(self.app, self.identity, "profile", sign=True)
            self.assertEqual(run.call_count, 1)
        (self.app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier":"com.yam.validation"}))
        with patch.object(release.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "bundle"):
                release.deliver(self.app, self.identity, "profile", sign=True)
            run.assert_not_called()

    def test_rejected_notarization_never_staples_or_claims_success(self):
        def rejected(args, **kwargs):
            if args[:3] == ["xcrun", "notarytool", "submit"]:
                return subprocess.CompletedProcess(args,0,'{"status":"Invalid","id":"rejected"}', "")
            return self.fake_run(args, **kwargs)
        with patch.object(release.subprocess, "run", side_effect=rejected) as run:
            with self.assertRaisesRegex(ValueError, "rejected"):
                release.deliver(self.app, self.identity, "profile", sign=True)
        self.assertFalse(any(c.args[0][:2] == ["xcrun","stapler"] for c in run.call_args_list))

    def test_existing_signature_must_match_requested_identity_before_upload(self):
        def other_identity(args, **kwargs):
            result = self.fake_run(args, **kwargs)
            if args[:2] == ["codesign", "-dv"]:
                result.stdout = result.stdout.replace(self.identity,"Developer ID Application: Another (ABCDEFGHIJ)")
            return result
        with patch.object(release.subprocess,"run",side_effect=other_identity) as run:
            with self.assertRaisesRegex(ValueError,"identity"):
                release.deliver(self.app,self.identity,"profile",sign=False)
        self.assertFalse(any(c.args[0][:3] == ["xcrun","notarytool","submit"] for c in run.call_args_list))

    def test_check_is_read_only_and_rejects_ad_hoc_or_missing_runtime(self):
        with patch.object(release.subprocess, "run", side_effect=self.fake_run) as run:
            release.check(self.app)
        self.assertFalse(any("--force" in c.args[0] or "staple" in c.args[0] for c in run.call_args_list))
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ["codesign", "--verify", "--deep", "--strict", str(self.app.resolve())],
            ["codesign", "-dv", "--verbose=4", str(self.app.resolve())],
            ["xcrun", "stapler", "validate", str(self.app.resolve())],
            ["spctl", "--assess", "--type", "execute", "--verbose=4", str(self.app.resolve())],
        ])
        for output in ["Signature=adhoc\nTeamIdentifier=not set", "Authority="+self.identity+"\nTeamIdentifier=ABCDEFGHIJ"]:
            with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([],0,output,"")):
                with self.assertRaises(ValueError):
                    release.check(self.app)

    def assert_main_failure_redacted(self, error, category):
        # All sentinels are hand-authored; no tool, identity or credential is read.
        sentinels = ["MANUAL_COMMAND_SENTINEL", "MANUAL_IDENTITY_SENTINEL",
                     "MANUAL_PROFILE_SENTINEL", "MANUAL_PATH_SENTINEL",
                     "MANUAL_MESSAGE_SENTINEL", "MANUAL_STDOUT_SENTINEL",
                     "MANUAL_STDERR_SENTINEL"]
        argv = ["macos-release.py", "notarize", "MANUAL_PATH_SENTINEL.app",
                "--identity", "MANUAL_IDENTITY_SENTINEL",
                "--notary-profile", "MANUAL_PROFILE_SENTINEL"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", argv), \
                patch.object(release, "deliver", side_effect=error) as deliver, \
                patch.object(release.subprocess, "run") as run, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = release.main()
        self.assertEqual(result, 1)
        deliver.assert_called_once_with(pathlib.Path("MANUAL_PATH_SENTINEL.app"),
                                        "MANUAL_IDENTITY_SENTINEL",
                                        "MANUAL_PROFILE_SENTINEL", sign=False)
        run.assert_not_called()
        output = stdout.getvalue() + stderr.getvalue()
        for sentinel in sentinels:
            self.assertNotIn(sentinel, output)
        self.assertEqual(stdout.getvalue(), "Release validation failed: " + category + "\n")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn("nothing published", output)

    def test_main_called_process_error_has_fixed_category_without_command_or_output(self):
        error = subprocess.CalledProcessError(
            1, ["MANUAL_COMMAND_SENTINEL", "MANUAL_IDENTITY_SENTINEL",
                "MANUAL_PROFILE_SENTINEL", "MANUAL_PATH_SENTINEL"],
            output="MANUAL_STDOUT_SENTINEL", stderr="MANUAL_STDERR_SENTINEL")
        self.assert_main_failure_redacted(error, "release command failed")

    def test_main_timeout_has_distinct_fixed_category_without_command_or_output(self):
        error = subprocess.TimeoutExpired(
            ["MANUAL_COMMAND_SENTINEL", "MANUAL_IDENTITY_SENTINEL",
             "MANUAL_PROFILE_SENTINEL", "MANUAL_PATH_SENTINEL"], 1200,
            output="MANUAL_STDOUT_SENTINEL", stderr="MANUAL_STDERR_SENTINEL")
        self.assert_main_failure_redacted(error, "release command timed out")

    def test_main_os_error_has_broad_fixed_tool_or_file_category(self):
        error = OSError(2, "MANUAL_MESSAGE_SENTINEL", "MANUAL_PATH_SENTINEL")
        self.assert_main_failure_redacted(error, "release tool or file operation failed")

    def test_main_value_error_has_fixed_validation_rejection_category(self):
        error = ValueError("MANUAL_MESSAGE_SENTINEL MANUAL_IDENTITY_SENTINEL "
                           "MANUAL_PROFILE_SENTINEL MANUAL_PATH_SENTINEL")
        self.assert_main_failure_redacted(error, "bundle, signature or notarization rejected")

    def test_command_failure_and_nested_bundles_fail_closed(self):
        with patch.object(release.subprocess,"run",side_effect=subprocess.CalledProcessError(1,["codesign"])):
            with self.assertRaises(subprocess.CalledProcessError):
                release.check(self.app)
        (self.app / "Contents" / "Frameworks" / "Nested.framework").mkdir(parents=True)
        with patch.object(release.subprocess,"run") as run:
            with self.assertRaisesRegex(ValueError,"nested"):
                release.deliver(self.app,self.identity,"profile",sign=True)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
