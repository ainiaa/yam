"""Author: Jeff.Liu. Keep project gates explicit and prevent coverage dilution."""
import json
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProjectQualityTests(unittest.TestCase):
    def test_native_policy_collects_the_whole_crate_and_enforces_85(self):
        path = ROOT / "docs/00_standards/test-commands.yml"
        content = path.read_text() if path.exists() else ""
        coverage = next((line.partition(":")[2].strip() for line in content.splitlines()
                         if line.startswith("coverage:")), "")
        self.assertEqual(shlex.split(coverage), [
            "cargo", "llvm-cov", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
            "--locked", "--fail-under-lines=85", "--", "--test-threads=2",
        ])

    def test_quality_target_is_explicit(self):
        path = ROOT / "docs/00_standards/quality-targets.yml"
        self.assertEqual(path.read_text().strip() if path.exists() else "", "coverage: 85")

    def test_existing_frontend_gates_are_preserved(self):
        config = json.loads((ROOT / "apps/desktop/package.json").read_text())
        argv = shlex.split(config["scripts"]["test:coverage"])
        for flag in ["--test-coverage-lines=95", "--test-coverage-branches=90",
                     "--test-coverage-functions=95", "--test-coverage-include=src/*.ts"]:
            self.assertIn(flag, argv)

    def test_ci_uses_fresh_native_coverage_with_an_isolated_target(self):
        content = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("cargo-llvm-cov --version 0.9.1 --locked", content)
        self.assertIn("llvm-tools-preview", content)
        self.assertIn("CARGO_LLVM_COV_TARGET_DIR:", content)
        self.assertIn("cargo llvm-cov --manifest-path src-tauri/Cargo.toml --locked --fail-under-lines=85 -- --test-threads=2", content)


if __name__ == "__main__":
    unittest.main()
