"""Author: Jeff.Liu. Parallel coverage must preserve the complete test gate."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("native_coverage", Path(__file__).with_name("native-coverage.py"))
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class NativeCoverageTests(unittest.TestCase):
    def test_environment_preserves_quoted_values_without_executing_shell(self):
        values = coverage.parse_environment("LLVM_PROFILE_FILE='/tmp/a b-%p.profraw'\nRUSTFLAGS='$(never-execute)'\n")
        self.assertEqual(values["LLVM_PROFILE_FILE"], "/tmp/a b-%p.profraw")
        self.assertEqual(values["RUSTFLAGS"], "$(never-execute)")
        for invalid in ["not an assignment", "A=1 B=2", "A='unfinished"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                coverage.parse_environment(invalid)

    def test_build_inventory_includes_every_test_executable_once(self):
        messages = [
            {"reason": "compiler-artifact", "profile": {"test": True}, "executable": "/tmp/lib"},
            {"reason": "compiler-artifact", "profile": {"test": True}, "executable": "/tmp/bin"},
            {"reason": "compiler-artifact", "profile": {"test": False}, "executable": "/tmp/build-script"},
            {"reason": "build-finished", "success": True},
        ]
        self.assertEqual(coverage.test_binaries("\n".join(map(json.dumps, messages))), ["/tmp/lib", "/tmp/bin"])
        for values in [[], messages[:1] * 2]:
            with self.assertRaises(ValueError):
                coverage.test_binaries("\n".join(map(json.dumps, values)))

    def test_partition_is_disjoint_exhaustive_and_preserves_ignored_tests(self):
        tests = {"worktree_manager::tests::cleanup", "history::tests::page", "gui::ignored"}
        groups = coverage.partition("/tmp/lib", tests, {"gui::ignored"})
        self.assertEqual(len(groups), 2)
        self.assertFalse(set(groups[0][2]) & set(groups[1][2]))
        self.assertEqual(set(groups[0][2]) | set(groups[1][2]), tests)
        self.assertTrue(groups[1][2]["gui::ignored"])
        self.assertIn("--test-threads=1", groups[0][1])
        self.assertIn("--test-threads=2", groups[1][1])
        self.assertEqual(len(coverage.partition("/tmp/bin", set(), set())), 1)
        with self.assertRaises(ValueError):
            coverage.partition("/tmp/lib", tests, {"missing"})

    def test_test_inventory_rejects_duplicates_and_unknown_output(self):
        self.assertEqual(coverage.test_names("a: test\nb: test\n"), {"a", "b"})
        for invalid in ["a: test\na: test", "unknown output"]:
            with self.assertRaises(ValueError):
                coverage.test_names(invalid)

    def test_result_audit_rejects_missing_duplicate_unexpected_or_activated_ignored_tests(self):
        expected = {"a": False, "b": True}
        good = "test a ... ok\ntest b ... ignored, GUI opt-in\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s\n"
        coverage.audit_results(expected, good)
        for bad in [good.replace("test a ... ok\n", ""), good + "test a ... ok\n", good.replace("test a", "test other"), good.replace("ignored, GUI opt-in", "ok"), good.replace("1 passed", "2 passed"), good.replace("result: ok", "result: FAILED")]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                coverage.audit_results(expected, bad)

    def test_workers_overlap_and_remove_their_private_temporary_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            code = """import os,pathlib,time
p=pathlib.Path(os.environ['BARRIER']);p.joinpath(NAME).touch()
end=time.monotonic()+3
while len(list(p.iterdir()))<2:
 if time.monotonic()>end:raise SystemExit(9)
 time.sleep(.01)
print('PRIVATE_TMP='+os.environ['TMPDIR'])
print('test '+NAME+' ... ok')
print('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s')
"""
            groups = [(name, [sys.executable, "-c", "NAME=" + repr(name) + "\n" + code], {name: False}) for name in ["a", "b"]]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                coverage.run_groups(groups, dict(os.environ, BARRIER=directory), timeout=5)
            paths = [line.partition("=")[2] for line in output.getvalue().splitlines() if line.startswith("PRIVATE_TMP=")]
            self.assertEqual(len(set(paths)), 2)
            self.assertTrue(all(not Path(path).exists() for path in paths))

    def test_failure_timeout_and_incomplete_success_fail_the_gate(self):
        for code, error in [("raise SystemExit(3)", subprocess.CalledProcessError), ("import time;time.sleep(5)", subprocess.TimeoutExpired), ("print('test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s')", ValueError)]:
            with self.subTest(code=code), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(error):
                coverage.run_groups([("failing", [sys.executable, "-c", code], {"a": False})], os.environ.copy(), timeout=.15)

    def test_worker_keeps_the_package_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory).resolve()
            code = f"import os;assert os.getcwd()=={str(package)!r};print('test cwd ... ok');print('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s')"
            with contextlib.redirect_stdout(io.StringIO()):
                coverage.run_groups([("cwd", [sys.executable, "-c", code], {"cwd": False})], os.environ.copy(), cwd=package)

    def test_peer_failure_cancels_the_running_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            waiting = Path(directory) / "waiting"
            delayed = Path(directory) / "must-not-survive"
            wait_code = f"import pathlib,time;pathlib.Path({str(waiting)!r}).touch();time.sleep(1);pathlib.Path({str(delayed)!r}).touch();time.sleep(5)"
            fail_code = f"import pathlib,time\np=pathlib.Path({str(waiting)!r})\nwhile not p.exists():time.sleep(.01)\nraise SystemExit(4)"
            groups = [("waiting", [sys.executable, "-c", wait_code], {}), ("failure", [sys.executable, "-c", fail_code], {})]
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(subprocess.CalledProcessError):
                coverage.run_groups(groups, os.environ.copy(), timeout=3)
            self.assertTrue(waiting.exists())
            # wait() confirms the sibling is gone before returning, not merely signalled.
            self.assertFalse(delayed.exists())

    def test_cache_initialization_marks_only_new_owned_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            coverage.prepare_cache(target)
            self.assertTrue((target / "CACHEDIR.TAG").read_text().startswith("Signature: 8a477f597d28d172789f06886806bc55"))
            sentinel = target / "keep"
            sentinel.write_text("untouched")
            with self.assertRaises(FileExistsError):
                coverage.prepare_cache(target)
            self.assertEqual(sentinel.read_text(), "untouched")
            with self.assertRaises(FileExistsError):
                coverage.prepare_cache(target / "CACHEDIR.TAG")

    def test_clean_warning_with_success_status_blocks_compilation(self):
        for status, stderr in [(0, "warning: process didn't exit successfully: cargo clean (exit status: 101)"), (101, "error: cannot clean")]:
            def command(argv, **kwargs):
                if "show-env" in argv:
                    return subprocess.CompletedProcess(argv, 0, "LLVM_PROFILE_FILE='/tmp/coverage-%p.profraw'\n")
                if "clean" in argv:
                    self.assertEqual(kwargs["stderr"], subprocess.PIPE)
                    self.assertEqual(argv[-2:], ["--color", "never"])
                    if status:
                        raise subprocess.CalledProcessError(status, argv, stderr=stderr)
                    return subprocess.CompletedProcess(argv, 0, "", stderr)
                self.fail("Compilation or reporting ran after failed cleanup")
            with self.subTest(status=status), mock.patch.object(coverage.subprocess, "run", side_effect=command), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                coverage.run(Path("/tmp/package/Cargo.toml"))

    def test_compile_once_and_report_only_after_audited_groups_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = []
            def command(argv, **kwargs):
                commands.append(argv)
                self.assertEqual(kwargs["cwd"], Path(directory).resolve())
                self.assertEqual(kwargs["env"]["CARGO_TARGET_DIR"], kwargs["env"]["CARGO_LLVM_COV_TARGET_DIR"])
                if argv[:3] == ["cargo", "llvm-cov", "show-env"]:
                    output = "LLVM_PROFILE_FILE='/tmp/coverage-%p.profraw'\n"
                elif argv[:2] == ["cargo", "test"]:
                    output = json.dumps({"reason": "compiler-artifact", "profile": {"test": True}, "executable": "/tmp/lib"})
                elif argv[0] == "/tmp/lib":
                    self.assertEqual(kwargs["env"]["LLVM_PROFILE_FILE"], os.devnull)
                    output = "" if "--ignored" in argv else "a: test\n"
                else:
                    output = ""
                return subprocess.CompletedProcess(argv, 0, output, "")
            with mock.patch.object(coverage.subprocess, "run", side_effect=command), mock.patch.object(coverage, "run_groups") as execute, contextlib.redirect_stdout(io.StringIO()):
                coverage.run(Path(directory) / "Cargo.toml")
                self.assertEqual(sum(argv[:2] == ["cargo", "test"] for argv in commands), 1)
                self.assertIn(["cargo", "llvm-cov", "clean", "--workspace", "--locked", "--color", "never"], commands)
                self.assertEqual(commands[-1], ["cargo", "llvm-cov", "report", "--locked", "--fail-under-lines=85"])
                execute.side_effect = ValueError("missing result")
                commands.clear()
                with self.assertRaises(ValueError):
                    coverage.run(Path(directory) / "Cargo.toml")
                self.assertFalse(any(argv[:3] == ["cargo", "llvm-cov", "report"] for argv in commands))


if __name__ == "__main__":
    unittest.main()
