"""Author: Jeff.Liu. Mutation campaigns fail closed on stale or incomplete evidence."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name("project_mutation.py")


class ProjectMutationTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "the project mutation runner is missing")
        spec = importlib.util.spec_from_file_location("project_mutation", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "crate/src").mkdir(parents=True)
        (self.root / "crate/Cargo.toml").write_text("[package]\nname='fixture'\nversion='0.1.0'\n")
        (self.root / "crate/src/lib.rs").write_text("pub fn allowed() -> bool { true }\n")
        self.name = "src/lib.rs:1:28: replace allowed -> bool with false"
        self.campaign = {"schema_version": 1, "tool_version": "27.1.0", "manifest": "crate/Cargo.toml",
                         "selector": "tests::", "mutants": [{"name": self.name,
                         "source_sha256": hashlib.sha256((self.root / "crate/src/lib.rs").read_bytes()).hexdigest(),
                         "criterion": "a forbidden result cannot pass"}]}
        self.path = self.root / "campaign.json"
        self.path.write_text(json.dumps(self.campaign))
        scope = self.root / "docs/00_standards/rust-mutations.diff"
        scope.parent.mkdir(parents=True)
        scope.write_text(self.module.scope_text(self.root, self.campaign))

    def test_command_preserves_the_frozen_scope_and_safe_execution(self):
        campaign = self.module.load_campaign(self.root, self.path)
        argv = self.module.command(campaign, self.root / "output")
        self.assertEqual(argv[:4], ["cargo", "mutants", "--manifest-path", "crate/Cargo.toml"])
        for flag in ["--no-config", "--all-logs", "--caught", "--cargo-arg=--locked", "--cargo-arg=--offline"]:
            self.assertIn(flag, argv)
        self.assertEqual(argv[-5:], ["--", "--lib", "tests::", "--", "--test-threads=2"])
        self.assertNotIn("--in-place", argv)
        self.assertNotIn("--iterate", argv)

    def test_command_applies_the_frozen_line_filter_to_every_mutant_genre(self):
        argv = self.module.command(self.campaign, self.root / "output")
        self.assertIn("--in-diff", argv)
        diff = Path(argv[argv.index("--in-diff") + 1])
        self.assertTrue(diff.is_absolute())
        self.assertEqual(diff.name, "rust-mutations.diff")

    def test_workspace_command_and_report_use_package_relative_mutant_names(self):
        name = "crate/" + self.name
        argv = self.module.command(self.campaign, self.root / "output",
                                   self.campaign["manifest"], self.root / "diff")
        pattern = argv[argv.index("--re") + 1]
        self.assertIsNotNone(re.fullmatch(pattern, name))
        self.assertIsNone(re.fullmatch(pattern, "other/" + self.name))
        report = self.report()
        report["outcomes"][1]["scenario"]["Mutant"]["name"] = name
        self.assertEqual(self.module.check_report(self.root, report, self.campaign)["killed"], 1)

    def test_disposable_workspace_keeps_package_resources_and_uses_workspace_diff_paths(self):
        package = self.root / "crate"
        (package / "Cargo.lock").write_text("frozen lockfile")
        for relative in ["codex-auto-route.mjs", "codex-route-app-server.mjs", "codex-native-routing.mjs",
                         "node-runtime-checksums.json"]:
            path = self.root / "scripts" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative)
        output = self.root / "out"
        output.mkdir()
        workspace, diff = self.module.disposable_workspace(self.root, output, self.campaign)
        self.assertTrue((workspace / "crate/Cargo.toml").is_file())
        self.assertEqual((workspace / "Cargo.lock").read_text(), "frozen lockfile")
        self.assertIn("--- a/crate/src/lib.rs", diff.read_text())
        self.assertEqual(diff.read_text(), self.module.scope_text(self.root, self.campaign).replace(
            "--- a/src/lib.rs", "--- a/crate/src/lib.rs"
        ).replace("+++ b/src/lib.rs", "+++ b/crate/src/lib.rs"))

    def test_disposable_workspace_keeps_omp_compile_time_sources(self):
        extension = self.root / "extensions/omp-chatgpt"
        extension.mkdir(parents=True)
        for name in ["run.mjs", "index.mjs", "auth.mjs", "yam-auth-helper.mjs"]:
            (extension / name).write_text("// fixture " + name)
        output = self.root / "output-with-extensions"
        output.mkdir()
        workspace, _ = self.module.disposable_workspace(self.root, output, self.campaign)
        for source in extension.glob("*.mjs"):
            self.assertEqual((workspace / "extensions/omp-chatgpt" / source.name).read_bytes(), source.read_bytes())

    def test_stale_empty_duplicate_and_escaping_campaigns_are_rejected(self):
        cases = []
        for field, value in [("mutants", []), ("schema_version", 0), ("tool_version", "old"),
                             ("manifest", "../Cargo.toml"), ("selector", "--ignored")]:
            data = copy.deepcopy(self.campaign); data[field] = value; cases.append(data)
        data = copy.deepcopy(self.campaign); data["mutants"] *= 2; cases.append(data)
        data = copy.deepcopy(self.campaign); data["mutants"][0]["source_sha256"] = "0" * 64; cases.append(data)
        for data in cases:
            with self.subTest(data=data):
                self.path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    self.module.load_campaign(self.root, self.path)

    def test_line_filter_cannot_drift_from_the_frozen_mutation_locations(self):
        (self.root / "docs/00_standards/rust-mutations.diff").write_text("unrelated diff\n")
        with self.assertRaisesRegex(ValueError, "line filter"):
            self.module.load_campaign(self.root, self.path)

    def test_frozen_line_filter_marks_current_source_lines_as_changed(self):
        self.assertIn("-__YAM_MUTATION_SCOPE__\n+pub fn allowed() -> bool { true }", self.module.scope_text(self.root, self.campaign))

    def report(self):
        log = self.root / "log"; log.mkdir()
        (log / "baseline.log").write_text("test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n")
        (log / "mutant.log").write_text("test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n")
        def row(scenario, summary, name, status):
            return {"scenario": scenario, "summary": summary, "log_path": "log/" + name,
                    "phase_results": [{"phase": "Build", "process_status": "Success", "argv": ["cargo", "test", "--no-run"]},
                    {"phase": "Test", "process_status": status, "argv": ["cargo", "test", "--lib", "tests::", "--", "--test-threads=2"]}]}
        return {"cargo_mutants_version": "27.1.0", "total_mutants": 1, "caught": 1,
                "missed": 0, "timeout": 0, "unviable": 0, "success": 0, "end_time": "finished",
                "outcomes": [row("Baseline", "Success", "baseline.log", "Success"),
                row({"Mutant": {"name": self.name}}, "CaughtMutant", "mutant.log", {"Failure": 101})]}

    def test_report_requires_the_baseline_and_every_required_mutant(self):
        report = self.report()
        self.assertEqual(self.module.check_report(self.root, report, self.campaign),
                         {"selector": "tests::", "generated": 1, "killed": 1, "tests": 2})
        for key in ["missed", "timeout", "unviable", "success"]:
            bad = copy.deepcopy(report); bad[key] = 1
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.module.check_report(self.root, bad, self.campaign)
        bad = copy.deepcopy(report); bad["outcomes"].pop(0)
        with self.assertRaises(ValueError):
            self.module.check_report(self.root, bad, self.campaign)
        (self.root / "log/baseline.log").write_text("test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.01s\n")
        with self.assertRaises(ValueError):
            self.module.check_report(self.root, report, self.campaign)

    def test_mutation_child_overrides_packaging_resources_without_changing_parent_environment(self):
        process = Mock(returncode=0)
        process.communicate.return_value = (b"done", b"")
        before = dict(self.module.os.environ)
        with patch.object(self.module.subprocess, "Popen", return_value=process) as popen:
            self.assertEqual(self.module.run_command(["cargo", "mutants", "--version"], 10), (0, b"done", b""))
        self.assertEqual(json.loads(popen.call_args.kwargs.get("env", {}).get("TAURI_CONFIG", "{}")),
                         {"bundle": {"resources": []}})
        environment = popen.call_args.kwargs.get("env", {})
        self.assertEqual(environment.get("CARGO_TARGET_DIR"), str(Path(environment["TMPDIR"]) / "target"))
        self.assertEqual(dict(self.module.os.environ), before)

    def test_disposable_crate_can_resolve_the_real_sibling_compile_time_fixtures(self):
        fixture = self.root / "apps/desktop/tests/fixtures/fixture.png"
        fixture.parent.mkdir(parents=True)
        fixture.write_bytes(b"real compilation fixture")
        for relative in ["codex-auto-route.mjs", "codex-route-app-server.mjs", "codex-native-routing.mjs",
                         "node-runtime-checksums.json"]:
            path = self.root / "scripts" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative)
        observed = []
        process = Mock(returncode=0)
        def spawned(*args, **kwargs):
            scratch = Path(kwargs.get("env", {}).get("TMPDIR", "/missing"))
            paths = [scratch / "tests/fixtures/fixture.png"] + [scratch / "scripts" / name for name in [
                "codex-auto-route.mjs", "codex-route-app-server.mjs", "codex-native-routing.mjs",
                "node-runtime-checksums.json"]]
            observed.extend(path.read_bytes() if path.is_file() else None for path in paths)
            process.communicate.return_value = (b"done", b"")
            return process
        with patch.object(self.module, "ROOT", self.root), patch.object(self.module.subprocess, "Popen", side_effect=spawned):
            self.module.run_command(["cargo", "mutants", "--version"], 10)
        self.assertEqual(observed, [b"real compilation fixture", b"codex-auto-route.mjs",
                                    b"codex-route-app-server.mjs", b"codex-native-routing.mjs",
                                    b"node-runtime-checksums.json"])

    def test_timeout_reaps_only_the_owned_child_process_group(self):
        process = Mock(returncode=-9, pid=12345)
        process.communicate.side_effect = [self.module.subprocess.TimeoutExpired(["cargo"], 1), (b"", b"")]
        with patch.object(self.module.subprocess, "Popen", return_value=process), patch.object(self.module.os, "killpg") as kill:
            with self.assertRaises(self.module.subprocess.TimeoutExpired):
                self.module.run_command(["cargo", "mutants", "--version"], 1)
        kill.assert_called_once_with(12345, self.module.signal.SIGKILL)
        self.assertEqual(process.communicate.call_count, 2)


if __name__ == "__main__":
    unittest.main()
