"""Author: Jeff.Liu. Resolve native smoke fixtures without launching applications."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


@unittest.skipIf(os.name == "nt", "macOS executable permission fixtures")
class MemorySelfSmokeTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("memory-self-smoke.py")
        spec = importlib.util.spec_from_file_location("memory_self_smoke", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.assertTrue(callable(getattr(self.module, "native_test_binary", None)),
                        "native fixture resolution must support the actual coverage target")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.normal = self.root / "apps/desktop/src-tauri/target"
        self.coverage = self.root / "coverage target with spaces"

    def binary(self, target, name="current", executable=True):
        path = target / "debug/deps" / ("yam_desktop_lib-" + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic test fixture")
        path.chmod(0o700 if executable else 0o600)
        return path

    def test_explicit_coverage_target_ignores_an_unrelated_normal_binary(self):
        self.binary(self.normal, "stale")
        current = self.binary(self.coverage)
        self.binary(self.coverage, "metadata.d", executable=False)
        self.assertEqual(self.module.native_test_binary(self.root, self.coverage), current)

    def test_missing_coverage_binary_never_falls_back_to_normal_cache(self):
        self.binary(self.normal, "stale")
        with self.assertRaisesRegex(SystemExit, "missing"):
            self.module.native_test_binary(self.root, self.coverage)

    def test_ambiguous_coverage_binaries_are_rejected(self):
        self.binary(self.coverage, "one")
        self.binary(self.coverage, "two")
        with self.assertRaisesRegex(SystemExit, "one current"):
            self.module.native_test_binary(self.root, self.coverage)

    def test_nonexecutable_files_cannot_satisfy_the_smoke_prerequisite(self):
        self.binary(self.coverage, executable=False)
        with self.assertRaisesRegex(SystemExit, "missing"):
            self.module.native_test_binary(self.root, self.coverage)

    def test_ordinary_manual_mode_remains_available(self):
        current = self.binary(self.normal)
        self.assertEqual(self.module.native_test_binary(self.root), current)

    def test_main_uses_the_configured_target_before_starting_any_application(self):
        source = self.root / "scripts/memory-self-smoke.py"
        with patch.object(self.module, "__file__", str(source)), \
                patch.object(self.module.platform, "system", return_value="Darwin"), \
                patch.dict(os.environ, {"CARGO_LLVM_COV_TARGET_DIR": str(self.coverage)}), \
                patch.object(self.module, "native_test_binary", return_value=Path("fixture")) as resolve, \
                patch.object(self.module.subprocess, "Popen", side_effect=RuntimeError("stop before launch")), \
                patch.object(self.module.subprocess, "run") as launch:
            with self.assertRaisesRegex(RuntimeError, "stop before launch"):
                self.module.main()
            resolve.assert_called_once_with(self.root, str(self.coverage))
            launch.assert_not_called()

    def test_sampling_is_released_only_after_launcher_exits_and_failure_is_preserved(self):
        binary = self.binary(self.coverage)
        for outcome in [{"Ok": {"application_bytes": 1}}, {"Err": "membership changed"}, None]:
            parser = Mock(pid=123)
            paths = {}

            def launch(argv, **kwargs):
                self.assertTrue(kwargs["check"])
                env = dict(arg.split("=", 1) for index, arg in enumerate(argv)
                           if index and argv[index - 1] == "--env")
                self.assertIn("YAM_MEMORY_TEST_START", env,
                              "sampling must wait for the launcher to leave the owner tree")
                paths["start"] = Path(env["YAM_MEMORY_TEST_START"])
                paths["result"] = Path(env["YAM_MEMORY_TEST_RESULT"])
                self.assertFalse(paths["start"].exists(), "launcher is still alive")
                self.assertEqual(env["LLVM_PROFILE_FILE"], os.devnull)
                self.assertEqual(json.loads(env["YAM_MEMORY_TEST_OWNER"]),
                                 {"pid": os.getpid(), "runtime_pid": parser.pid, "workloads": []})

            def sample(_):
                self.assertTrue(paths["start"].is_file(), "launcher has exited before sampling")
                if outcome is not None:
                    paths["result"].write_text(json.dumps(outcome))

            with self.subTest(outcome=outcome), \
                    patch.object(self.module.platform, "system", return_value="Darwin"), \
                    patch.object(self.module, "native_test_binary", return_value=binary), \
                    patch.object(self.module.subprocess, "Popen", return_value=parser), \
                    patch.object(self.module.subprocess, "run", side_effect=launch), \
                    patch.object(self.module.time, "sleep", side_effect=sample), \
                    contextlib.redirect_stdout(io.StringIO()):
                if outcome is None:
                    with self.assertRaisesRegex(AssertionError, "did not finish"):
                        self.module.main()
                elif "Err" in outcome:
                    with self.assertRaisesRegex(AssertionError, "membership changed"):
                        self.module.main()
                else:
                    self.module.main()
                parser.terminate.assert_called_once_with()
                parser.wait.assert_called_once_with(timeout=5)
                self.assertFalse(paths["start"].parent.exists(), "fixture files are cleaned")


if __name__ == "__main__":
    unittest.main()
