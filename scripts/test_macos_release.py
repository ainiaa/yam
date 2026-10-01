"""Author: Jeff.Liu. Checks release ordering without signing or uploading."""
import importlib.util
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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
        for output in ["Signature=adhoc\nTeamIdentifier=not set", "Authority="+self.identity+"\nTeamIdentifier=ABCDEFGHIJ"]:
            with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([],0,output,"")):
                with self.assertRaises(ValueError):
                    release.check(self.app)

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
