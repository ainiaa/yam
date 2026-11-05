"""Author: Jeff.Liu. CI impact routing and selected-route admission fail closed."""
import itertools
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import ci_impact


FIXTURE = "apps/desktop/tests/fixtures/provider_api.py"
PRODUCTION = "apps/desktop/src/App.tsx"


class RoutingTests(unittest.TestCase):
    def test_only_explicit_ordinary_modified_files_can_be_quick(self):
        for path in ci_impact.QUICK_PATHS:
            self.assertEqual(ci_impact.classify([("M", "100644", "100644", path)]), "quick")
        self.assertEqual(ci_impact.classify([
            ("M", "100644", "100644", path) for path in ci_impact.QUICK_PATHS
        ]), "quick")
        for changes in [[], [("M", "100644", "100644", PRODUCTION)],
                        [("M", "100644", "100644", FIXTURE), ("M", "100644", "100644", PRODUCTION)],
                        [("M", "100644", "100644", "scripts/new_fixture.py")],
                        [("M", "100644", "100644", "scripts/ci_impact.py")],
                        [("M", "100644", "100644", ".github/workflows/ci.yml")]]:
            with self.subTest(changes=changes):
                self.assertEqual(ci_impact.classify(changes), "full")

    def test_file_type_mode_and_status_changes_require_full(self):
        for status, old, new in [("A", "000000", "100644"), ("D", "100644", "000000"),
                                 ("R100", "100644", "100644"), ("C100", "100644", "100644"),
                                 ("T", "100644", "120000"), ("M", "100644", "100755"),
                                 ("M", "120000", "120000"), ("U", "100644", "100644")]:
            with self.subTest(status=status, old=old, new=new):
                self.assertEqual(ci_impact.classify([(status, old, new, FIXTURE)]), "full")

    def test_whitelist_matching_never_accepts_prefixes_or_path_injection(self):
        for path in ["./" + FIXTURE, "../" + FIXTURE, FIXTURE + ".bak", FIXTURE + "\nroute=quick"]:
            self.assertEqual(ci_impact.classify([("M", "100644", "100644", path)]), "full")

    def test_raw_diff_must_be_complete_and_well_formed(self):
        header = b":100644 100644 " + b"a" * 40 + b" " + b"b" * 40 + b" M"
        self.assertEqual(ci_impact.parse_changes(header + b"\0" + FIXTURE.encode() + b"\0"),
                         [("M", "100644", "100644", FIXTURE)])
        for raw in [header, header + b"\0" + FIXTURE.encode(), b"garbage\0path\0",
                    header + b"\0\xff\0", header + b"\0\0", b"\0"]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                ci_impact.parse_changes(raw)

    def test_missing_refs_git_failure_and_non_pr_events_never_select_quick(self):
        for event, base, head in [("push", "a" * 40, "b" * 40), ("pull_request", "", "b" * 40),
                                  ("pull_request", "--bad", "b" * 40), ("unknown", "a" * 40, "b" * 40)]:
            with mock.patch.object(ci_impact.subprocess, "run") as run:
                self.assertEqual(ci_impact.plan(event, base, head)["route"], "full")
                run.assert_not_called()
        for error in [OSError("git unavailable"), subprocess.CalledProcessError(1, ["git"]),
                      subprocess.TimeoutExpired(["git"], 15), ValueError("malformed diff")]:
            with mock.patch.object(ci_impact, "read_changes", side_effect=error):
                self.assertEqual(ci_impact.plan("pull_request", "a" * 40, "b" * 40),
                                 {"route": "full", "exercise_quick": "false"})

    def test_ci_policy_changes_exercise_quick_without_replacing_full_checks(self):
        with mock.patch.object(ci_impact, "read_changes", return_value=[
            ("M", "100644", "100644", ".github/workflows/ci.yml"),
            ("M", "100644", "100644", FIXTURE),
        ]):
            self.assertEqual(ci_impact.plan("pull_request", "a" * 40, "b" * 40),
                             {"route": "full", "exercise_quick": "true"})

    def test_git_warning_does_not_turn_an_ambiguous_diff_into_quick_admission(self):
        raw = b":100644 100644 " + b"a" * 40 + b" " + b"b" * 40 + b" M\0" + FIXTURE.encode() + b"\0"
        result = subprocess.CompletedProcess(["git"], 0, stdout=raw, stderr=b"warning: multiple merge bases")
        with mock.patch.object(ci_impact.subprocess, "run", return_value=result):
            self.assertEqual(ci_impact.plan("pull_request", "a" * 40, "b" * 40)["route"], "full")


class GitRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "--quiet")
        for name, value in [("user.name", "Jeff.Liu"), ("user.email", "ci-fixture@example.test"),
                            ("commit.gpgsign", "false"), ("core.hooksPath", str(self.root / "no-hooks")),
                            ("core.autocrlf", "false"), ("core.filemode", "true")]:
            self.git("config", name, value)
        for path in [FIXTURE, PRODUCTION]:
            p = self.root / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("before\n")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", "-c", "init.templateDir=", "-c", "core.fsmonitor=false", *args],
                                       cwd=self.root, text=True).strip()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_real_git_diff_includes_every_commit_in_the_pr(self):
        (self.root / FIXTURE).write_text("quick fixture\n")
        quick = self.commit()
        self.assertEqual(ci_impact.plan("pull_request", self.base, quick, self.root)["route"], "quick")
        (self.root / PRODUCTION).write_text("production change\n")
        self.commit()
        (self.root / FIXTURE).write_text("another fixture change\n")
        head = self.commit()
        self.assertEqual(ci_impact.plan("pull_request", self.base, head, self.root)["route"], "full")
        self.assertEqual(ci_impact.plan("pull_request", "f" * 40, head, self.root)["route"], "full")

    def test_real_renames_deletes_and_executable_changes_are_full(self):
        for change in ["rename", "delete", "executable", "symlink"]:
            with self.subTest(change=change):
                self.git("reset", "--hard", self.base)
                p = self.root / FIXTURE
                if change == "rename":
                    p.rename(p.with_name("moved.py"))
                elif change == "delete":
                    p.unlink()
                elif change == "executable":
                    p.chmod(0o755)
                else:
                    p.unlink()
                    p.symlink_to("other.py")
                head = self.commit()
                self.assertEqual(ci_impact.plan("pull_request", self.base, head, self.root)["route"], "full")

    def test_local_git_configuration_cannot_hide_a_mixed_gitlink_change(self):
        self.git("update-index", "--add", "--cacheinfo", "160000," + self.base + ",module")
        self.git("commit", "--quiet", "-m", "with gitlink")
        base = self.git("rev-parse", "HEAD")
        (self.root / FIXTURE).write_text("fixture edit\n")
        self.git("add", FIXTURE)
        self.git("update-index", "--cacheinfo", "160000," + base + ",module")
        self.git("commit", "--quiet", "-m", "mixed edit")
        head = self.git("rev-parse", "HEAD")
        self.git("config", "diff.ignoreSubmodules", "all")
        self.assertEqual(ci_impact.plan("pull_request", base, head, self.root)["route"], "full")


class GateTests(unittest.TestCase):
    def test_every_job_state_combination_requires_the_exact_selected_route(self):
        states = ["success", "failure", "cancelled", "skipped", ""]
        for route, exercise in [("quick", "false"), ("full", "false"), ("full", "true"),
                                ("quick", "true"), ("", "false"), ("quick", ""), ("full", "bad")]:
            for plan, quick, front, native, package in itertools.product(states, repeat=5):
                expected = plan == "success" and (
                    (route, exercise) == ("quick", "false") and quick == "success" and
                    (front, native, package) == ("skipped",) * 3 or
                    route == "full" and (front, native, package) == ("success",) * 3 and
                    ((exercise == "false" and quick == "skipped") or (exercise == "true" and quick == "success"))
                )
                self.assertEqual(ci_impact.admit(route, exercise, plan, quick, front, native, package), expected,
                                 (route, exercise, plan, quick, front, native, package))

    def test_real_gate_command_returns_failure_instead_of_masking_skipped_work(self):
        script = Path(__file__).with_name("ci_impact.py")
        env = {**os.environ, "ROUTE": "quick", "EXERCISE_QUICK": "false", "PLAN_RESULT": "success",
               "QUICK_RESULT": "success", "FRONTEND_RESULT": "skipped", "NATIVE_RESULT": "skipped", "PACKAGE_RESULT": "skipped"}
        for quick, expected in [("success", 0), ("skipped", 1), ("cancelled", 1)]:
            result = subprocess.run([sys.executable, str(script), "gate"], env={**env, "QUICK_RESULT": quick}, capture_output=True)
            self.assertEqual(result.returncode, expected)
