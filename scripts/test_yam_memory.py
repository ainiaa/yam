"""Author: Jeff.Liu. Validate attribution and measurement failure boundaries."""
import importlib.util
import pathlib
import json
import os
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("yam_memory", pathlib.Path(__file__).with_name("yam-memory.py"))
memory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(memory)

APPS = '''1) "YAM Validation" ASN:0x0-0x1:
    bundleID="com.yam.validation"
    pid = 10 type="Foreground"
    coalition: 50 { 10 11 12 13 14 }
2) "Other" ASN:0x0-0x2:
    bundleID="com.other.app"
    pid = 20 type="Foreground"
    coalition: 51 { 20 21 }
'''
PROCESSES = '''10 1 100 Thu Oct 1 22:45:22 2026 /apps/YAM Validation.app/Contents/MacOS/yam-desktop
11 1 200 Thu Oct 1 22:45:22 2026 /x/com.apple.WebKit.WebContent
12 10 300 Thu Oct 1 22:45:22 2026 /usr/bin/claude
13 12 400 Thu Oct 1 22:45:22 2026 /usr/bin/node
14 1 50 Thu Oct 1 22:45:22 2026 /x/com.apple.audio.SandboxHelper
20 1 600 Thu Oct 1 22:45:22 2026 /apps/Other
21 1 700 Thu Oct 1 22:45:22 2026 /x/com.apple.WebKit.WebContent
'''


class MemoryTests(unittest.TestCase):
    def sample(self, apps=APPS, after=PROCESSES, footprint=None):
        before = memory.parse_processes(PROCESSES)
        return memory.attribute_sample("com.yam.validation", memory.parse_apps(apps), before,
            memory.parse_processes(after), footprint or {"unit":"byte", "processes":[
                {"pid":pid, "footprint":pid * 100, "auxiliary":{"phys_footprint":pid * 110}}
                for pid in [10,11,12,13,14,20,21]], "errors":[], "warnings":[]})

    def test_coalition_includes_parentless_webkit_excludes_other_app_and_agent_tree(self):
        sample = self.sample()
        self.assertEqual(sample["status"], "complete")
        self.assertEqual([p["pid"] for p in sample["application"]], [10,11,14])
        self.assertEqual([p["pid"] for p in sample["agents"]], [12,13])
        self.assertEqual(sample["rss_bytes"], 350 * 1024)
        self.assertEqual(sample["phys_footprint_sum_bytes"], (10+11+14)*110)
        self.assertEqual(sample["application"][1]["role"], "webkit")
        self.assertNotIn("arguments", str(sample))

    def test_missing_members_and_pid_reuse_are_not_complete(self):
        for after in [PROCESSES.replace('11 1 200 Thu Oct 1 22:45:22 2026 /x/com.apple.WebKit.WebContent\n',''),
                      PROCESSES.replace('11 1 200 Thu Oct 1 22:45:22','11 1 200 Thu Oct 1 22:46:22')]:
            sample = self.sample(after=after)
            self.assertEqual(sample["status"], "partial")
            self.assertTrue(sample["issues"])
            self.assertNotIn(11, [p["pid"] for p in sample["application"]])

    def test_authenticated_owner_and_terminal_are_included_after_reparenting(self):
        extra = "30 1 80 Thu Oct 1 22:45:22 2026 /apps/YAM Validation.app/Contents/MacOS/yam-desktop\n31 30 90 Thu Oct 1 22:45:22 2026 /apps/YAM Validation.app/Contents/Resources/yam-terminal\n32 30 60 Thu Oct 1 22:45:22 2026 /usr/bin/python3\n33 32 70 Thu Oct 1 22:45:22 2026 /usr/bin/node\n"
        rows = memory.parse_processes(PROCESSES + extra)
        owner = {"pid":30,"runtime_pid":31,"desktop_connected":True}
        footprint = {"unit":"byte","processes":[{"pid":pid,"auxiliary":{"phys_footprint":pid*110}} for pid in rows]}
        sample = memory.attribute_sample("com.yam.validation",memory.parse_apps(APPS),rows,rows,footprint,owner)
        self.assertEqual(sample["status"],"complete")
        self.assertEqual([r["pid"] for r in sample["application"]],[10,11,14,30,31])
        self.assertEqual([r["pid"] for r in sample["agents"]],[12,13,32,33])
        self.assertEqual(sample["application"][-2]["role"],"background-owner")
        self.assertEqual(sample["application"][-1]["role"],"terminal-service")
        sample = memory.attribute_sample("com.yam.validation",[],rows,rows,footprint,{**owner,"desktop_connected":False})
        self.assertEqual(sample["status"],"complete")
        self.assertEqual([r["pid"] for r in sample["application"]],[30,31])
        self.assertIsNone(sample["root_pid"])
        for bad in [{**owner,"pid":20},{**owner,"runtime_pid":33}]:
            with self.assertRaises(ValueError): memory.attribute_sample("com.yam.validation",memory.parse_apps(APPS),rows,rows,footprint,bad)
        with self.assertRaises(ValueError): memory.attribute_sample("com.yam.validation",[],rows,rows,footprint,owner)

    def test_connection_descriptor_is_private_bounded_and_loopback_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary)/'connection.json'
            descriptor = {"version":1,"address":"127.0.0.1:12345","token":"a"*64,"instance":"b"*64}
            path.write_text(json.dumps(descriptor)); path.chmod(0o600)
            self.assertEqual(memory.read_connection(path),descriptor)
            for change in [{"address":"example.com:12345"},{"token":"short"},{"version":2}]:
                path.write_text(json.dumps({**descriptor,**change}))
                with self.assertRaises(ValueError): memory.read_connection(path)
            path.write_text(json.dumps(descriptor)); path.chmod(0o644)
            with self.assertRaises(ValueError): memory.read_connection(path)
            path.chmod(0o600)
            link=pathlib.Path(temporary)/'link';link.symlink_to(path)
            with self.assertRaises((ValueError,OSError)):memory.read_connection(link)
            path.write_bytes(b'x'*4097)
            with self.assertRaises(ValueError):memory.read_connection(path)

    def test_ambiguous_roots_and_no_members_fail_closed(self):
        for apps in [APPS + APPS, APPS.replace('coalition: 50 { 10 11 12 13 14 }', 'coalition: 50')]:
            with self.assertRaises(ValueError): self.sample(apps=apps)
        with self.assertRaises(ValueError): self.sample(apps='')

    def test_denied_or_incomplete_footprint_keeps_rss_but_never_claims_total(self):
        for footprint in [{"unit":"byte", "processes":[], "errors":["denied"]},
                          {"unit":"page", "processes":[]},
                          {"unit":"byte", "processes":[{"pid":10,"footprint":-1}]}]:
            sample=self.sample(footprint=footprint)
            self.assertEqual(sample["status"], "partial")
            self.assertIsNone(sample["phys_footprint_sum_bytes"])
            self.assertEqual(sample["rss_bytes"], 350*1024)

    def test_process_parse_does_not_expose_command_arguments_and_rejects_bad_records(self):
        rows=memory.parse_processes(PROCESSES)
        self.assertEqual(rows[10]["executable"], '/apps/YAM Validation.app/Contents/MacOS/yam-desktop')
        for row in ['invalid', '1 0 -1 Thu Oct 1 22:45:22 2026 /app']:
            with self.assertRaises(ValueError): memory.parse_processes(row)

    def test_unknown_coalition_process_is_explicitly_attributed_not_silently_filtered(self):
        sample=self.sample()
        self.assertEqual(sample['application'][-1]['role'], 'application-service')
        self.assertEqual(sample['attribution'], 'LaunchServices coalition membership; process identity checked before and after')


if __name__ == '__main__': unittest.main()
