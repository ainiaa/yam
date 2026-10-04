"""Author: Jeff.Liu. T06 measurement validity and fixture ownership contracts."""
import copy
import hashlib
import importlib.util
import pathlib
import tempfile
import types
import unittest


def load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    if not path.exists():
        return types.SimpleNamespace()
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


performance = load("terminal_performance", "terminal-performance.py")


def sample(phase="idle", at=1.0, cpu=0.2):
    return {"phase": phase, "status": "complete", "monotonic_seconds": at,
            "rss_bytes": 100, "phys_footprint_sum_bytes": 90,
            "application": [{"pid": 10, "started": "fixture-start", "executable": "fixture",
                             "role": "desktop", "rss_bytes": 100,
                             "phys_footprint_bytes": 90, "cpu_seconds": cpu}], "agents": []}


class PerformanceTests(unittest.TestCase):
    def api(self, name):
        function = getattr(performance, name, None)
        self.assertTrue(callable(function), "T06 measurement API is missing: " + name)
        return function

    def test_t06_nearest_rank_uses_raw_values_without_rounding(self):
        percentile = self.api("nearest_rank")
        values = [float(i) + .000123 for i in range(1, 101)]
        self.assertEqual(percentile(values, .50), values[49])
        self.assertEqual(percentile(values, .95), values[94])
        self.assertEqual(percentile([9, 1, 4], .50), 4)
        self.assertEqual(percentile([2], .95), 2)

    def test_t06_percentile_rejects_empty_nan_infinite_negative_and_bad_percent(self):
        percentile = self.api("nearest_rank")
        for values, p in [([], .5), ([float("nan")], .5), ([float("inf")], .95),
                          ([-1], .5), ([True], .5), ([1], 0), ([1], 1.01)]:
            with self.subTest(values=values, p=p), self.assertRaises(ValueError):
                percentile(values, p)

    def test_t06_phase_summary_preserves_raw_samples_and_component_median_peak(self):
        summarize = self.api("summarize_samples")
        values = [sample(at=1), sample(at=2, cpu=.4)]
        values[1]["phys_footprint_sum_bytes"] = 110
        values[1]["application"][0]["phys_footprint_bytes"] = 110
        result = summarize(values, {"idle": 2})
        self.assertEqual(result["complete_ratio"], 1)
        self.assertEqual(result["phases"]["idle"]["memory_median_bytes"], 100)
        self.assertEqual(result["phases"]["idle"]["memory_peak_bytes"], 110)
        self.assertEqual(result["phases"]["idle"]["components"]["desktop"]["peak_bytes"], 110)
        self.assertEqual(result["raw_samples"], values)

    def test_t06_summary_rejects_missing_empty_or_undersampled_required_phase(self):
        summarize = self.api("summarize_samples")
        for values, phases in [([], {"idle": 1}), ([sample()], {"idle": 2}),
                               ([sample()], {"idle": 1, "stopped": 1}),
                               ([sample()], {"idle": 1, "reopen": 1})]:
            with self.subTest(phases=phases), self.assertRaises(ValueError):
                summarize(values, phases)

    def test_t06_summary_rejects_partial_nan_or_missing_samples_instead_of_filtering(self):
        summarize = self.api("summarize_samples")
        for change in [{"status": "partial"}, {"phys_footprint_sum_bytes": None},
                       {"phys_footprint_sum_bytes": float("nan")},
                       {"monotonic_seconds": float("nan")}, {"phase": ""},
                       {"missed_slots": 3}, {"late": True}]:
            broken = {**sample(at=2, cpu=.4), **change}
            with self.subTest(change=change), self.assertRaises(ValueError):
                summarize([sample(), broken], {"idle": 2})

    def test_t06_cpu_delta_is_elapsed_cpu_over_monotonic_wall_time(self):
        delta = self.api("cpu_delta")
        self.assertAlmostEqual(delta(sample(at=3, cpu=1), sample(at=5, cpu=2)), .5)

    def test_t06_cpu_rollback_pid_reuse_and_nonmonotonic_time_fail_closed(self):
        delta = self.api("cpu_delta")
        first = sample(at=3, cpu=1)
        for last in [sample(at=5, cpu=.9), sample(at=3, cpu=2), sample(at=2, cpu=2)]:
            with self.assertRaises(ValueError): delta(first, last)
        for field, value in [("started", "reused"), ("executable", "other"),
                             ("cpu_seconds", float("nan")), ("cpu_seconds", None)]:
            last = sample(at=5, cpu=2)
            last["application"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): delta(first, last)

    def test_t06_cpu_missing_process_does_not_become_zero_cost(self):
        delta = self.api("cpu_delta")
        last = sample(at=5, cpu=2)
        last["application"] = []
        with self.assertRaises(ValueError): delta(sample(at=3, cpu=1), last)

    def test_t06_multicomponent_cpu_sums_application_only_and_rejects_duplicate_pid(self):
        delta = self.api("cpu_delta")
        before, after = sample(at=1, cpu=1), sample(at=3, cpu=2)
        for value, cpu in [(before, 5), (after, 8)]:
            value["application"].append({**value["application"][0], "pid": 11, "role": "webkit", "cpu_seconds": cpu})
            value["agents"] = [{"pid": 90, "cpu_seconds": 10000}]
        self.assertEqual(delta(before, after), 2)
        after["application"].append(copy.deepcopy(after["application"][0]))
        with self.assertRaises(ValueError): delta(before, after)

    def test_t06_complete_ratio_counts_scheduled_missed_slots_in_denominator(self):
        completeness = self.api("sample_completeness")
        values = [sample(), {**sample(at=21, cpu=2), "late": True, "missed_slots": 3}]
        result = completeness(values, 5)
        self.assertEqual(result["scheduled_slots"], 5)
        self.assertEqual(result["observed_samples"], 2)
        self.assertEqual(result["missed_slots"], 3)
        self.assertEqual(result["complete_ratio"], .2)

    def test_t06_final_slot_late_preserves_partial_summary_and_outside_phase_spill(self):
        values = [sample(at=1), sample(at=6, cpu=.4),
                  {**sample(at=12, cpu=.6), "late": True, "missed_slots": 1,
                   "outside_phase_missed_slots": 1}]
        with self.assertRaises(ValueError): performance.summarize_samples(values, {"idle": 3})
        summary = {"status": "partial", "raw_samples": values,
                   **performance.sample_completeness(values, 3)}
        self.assertEqual(summary["complete_ratio"], 2 / 3)
        self.assertEqual(summary["missed_slots"], 0)
        self.assertEqual(summary["outside_phase_missed_slots"], 1)
        self.assertEqual(summary["raw_samples"][-1]["missed_slots"], 1)
        self.assertTrue(summary["raw_samples"][-1]["late"])

    def test_t06_inside_phase_missing_slot_still_reduces_completeness(self):
        values = [sample(at=1), {**sample(at=11, cpu=.6), "missed_slots": 1,
                                "outside_phase_missed_slots": 0}]
        result = performance.sample_completeness(values, 3)
        self.assertEqual(result["complete_ratio"], 2 / 3)
        self.assertEqual(result["missed_slots"], 1)

    def test_t06_each_output_slot_requires_all_running_sources_and_forward_counters(self):
        check = self.api("output_continuity")
        expected = {f"fixture-{index}" for index in range(16)}
        before = {"frames": {identity: {"status": "running", "end_offset": 100} for identity in expected},
                  "workloads": [{"pid": index + 100, "started": "same-start", "executable": "fixture"} for index in range(16)]}
        after = copy.deepcopy(before)
        for frame in after["frames"].values(): frame["end_offset"] = 200
        self.assertEqual(check(expected, None, before)["status"], "complete", "first slot establishes a live anchor")
        self.assertEqual(check(expected, before, after)["status"], "complete")
        for fault in ["ended", "stalled", "rollback", "missing", "pid-reuse", "pid-replaced"]:
            broken = copy.deepcopy(after)
            if fault == "ended": broken["frames"]["fixture-0"]["status"] = "completed"
            if fault == "stalled": broken["frames"]["fixture-0"]["end_offset"] = 100
            if fault == "rollback": broken["frames"]["fixture-0"]["end_offset"] = 99
            if fault == "missing": del broken["frames"]["fixture-0"]
            if fault == "pid-reuse": broken["workloads"][0]["started"] = "new-start"
            if fault == "pid-replaced": broken["workloads"][0]["pid"] = 999
            with self.subTest(fault=fault):
                self.assertEqual(check(expected, before, broken)["status"], "partial")
                self.assertTrue(check(expected, before, broken)["issues"])
        # A source may have produced bytes in its first second, then exit or stop
        # producing forever: total phase delta is positive but later slots fail.
        stopped = copy.deepcopy(after)
        self.assertEqual(check(expected, after, stopped)["status"], "partial")

    def test_t06_package_receipt_checks_actual_info_binary_and_all_resources(self):
        validate = self.api("validate_package_receipt")
        with tempfile.TemporaryDirectory() as folder:
            import plistlib
            app = pathlib.Path(folder) / "Fixture.app"
            binary = app / "Contents/MacOS/yam-desktop"; binary.parent.mkdir(parents=True)
            resource = app / "Contents/Resources/target/terminal-runtime/yam-terminal"; resource.parent.mkdir(parents=True)
            info = app / "Contents/Info.plist"
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.yam.performance-validation-t06", "CFBundleExecutable": "yam-desktop"}))
            binary.write_bytes(b"current"); resource.write_bytes(b"runtime")
            digest = self.api("digest")
            receipt = {"identifier": "com.yam.performance-validation-t06", "package_sha256": digest(app),
                       "binary_sha256": digest(binary), "terminal_resource_sha256": digest(resource),
                       "info_sha256": digest(info), "product_source_fingerprint": "a" * 64,
                       "source_sha256": self.api("product_source_sha256")()}
            validate(app, receipt)
            for field in ["package_sha256", "binary_sha256", "terminal_resource_sha256", "info_sha256", "product_source_fingerprint"]:
                bad = {**receipt, field: "missing"}
                with self.subTest(field=field), self.assertRaises(ValueError): validate(app, bad)
            resource.write_bytes(b"old-package-runtime")
            with self.assertRaises(ValueError): validate(app, receipt)

    def test_t06_evidence_binds_commit_source_bytes_and_exact_package_sha(self):
        binding = self.api("evidence_binding")
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source, package = root / "source.py", root / "app.bin"
            source.write_bytes(b"source-v1"); package.write_bytes(b"current-T05-package")
            before = binding([source], package, "a" * 40)
            self.assertEqual(before["commit"], "a" * 40)
            self.assertEqual(before["package_sha256"], hashlib.sha256(package.read_bytes()).hexdigest())
            self.assertNotIn(str(root), str(before))
            source.write_bytes(b"source-v2")
            self.assertNotEqual(binding([source], package, "a" * 40)["source_sha256"], before["source_sha256"])
            self.assertEqual(binding([source], package, "a" * 40)["package_sha256"], before["package_sha256"])

    def test_t06_evidence_never_overwrites_existing_file_or_follows_link(self):
        write = self.api("write_evidence")
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / "evidence.json"
            write(target, {"schema_version": 1})
            before = target.read_bytes()
            with self.assertRaises((ValueError, FileExistsError)): write(target, {"changed": True})
            self.assertEqual(target.read_bytes(), before)
            link = pathlib.Path(folder) / "link.json"; link.symlink_to(target)
            with self.assertRaises((ValueError, FileExistsError)): write(link, {"changed": True})
            self.assertEqual(target.read_bytes(), before)

    def test_t06_same_basename_in_different_source_directories_changes_source_hash(self):
        binding = self.api("evidence_binding")
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); (root / "a").mkdir(); (root / "b").mkdir()
            first, second, anchor, package = root / "a/config.json", root / "b/config.json", root / "z_anchor.py", root / "app.bin"
            for path in [first, second, anchor, package]: path.write_bytes(b"same-content")
            self.assertNotEqual(binding([first, anchor], package, "a" * 40)["source_sha256"],
                                binding([second, anchor], package, "a" * 40)["source_sha256"])

    def test_t06_frozen_receipt_rejects_wrong_current_product_source(self):
        validate = self.api("validate_package_receipt")
        import plistlib
        with tempfile.TemporaryDirectory() as folder:
            app = pathlib.Path(folder) / "Fixture.app"
            binary = app / "Contents/MacOS/yam-desktop"; binary.parent.mkdir(parents=True)
            resource = app / "Contents/Resources/target/terminal-runtime/yam-terminal"; resource.parent.mkdir(parents=True)
            info = app / "Contents/Info.plist"
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.yam.performance-validation-t06", "CFBundleExecutable": "yam-desktop"}))
            binary.write_bytes(b"old-package"); resource.write_bytes(b"runtime")
            digest = self.api("digest")
            receipt = {"identifier": "com.yam.performance-validation-t06", "package_sha256": digest(app),
                       "binary_sha256": digest(binary), "terminal_resource_sha256": digest(resource),
                       "info_sha256": digest(info), "product_source_fingerprint": "a" * 64,
                       "source_sha256": "0" * 64}
            with self.assertRaises(ValueError): validate(app, receipt)

    def test_t06_cancel_only_stops_explicitly_created_fixture_sessions(self):
        cancel = self.api("cancel_fixture")
        calls = []
        cancel({"s-fixture-a", "s-fixture-b"}, ["s-fixture-b"], calls.append)
        self.assertEqual(calls, ["s-fixture-b"])
        with self.assertRaises(ValueError):
            cancel({"s-fixture-a"}, ["s-real-user", "s-fixture-a"], calls.append)
        self.assertEqual(calls, ["s-fixture-b"], "validate all targets before any stop")

    def test_t06_empty_desktop_fixture_exits_before_pause_and_task_stop_can_begin(self):
        close = self.api("close_fixture_desktop")
        events = []
        class Child:
            def poll(self): return None
            def terminate(self): events.append("terminate-owned-gui")
            def wait(self, timeout): events.append("wait-owned-gui")
        close(Child(), lambda: events.append("confirmed-disconnected") or True, lambda: events.append("pause-owner"))
        self.assertEqual(events, ["terminate-owned-gui", "wait-owned-gui", "confirmed-disconnected", "pause-owner"])
        events.clear()
        with self.assertRaises(ValueError): close(Child(), lambda: False, lambda: events.append("pause-owner"))
        self.assertNotIn("pause-owner", events)


if __name__ == "__main__": unittest.main()
