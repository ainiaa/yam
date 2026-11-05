#!/usr/bin/env python3
"""Author: Jeff.Liu. Exercise sampling from inside its own LaunchServices coalition.

An isolated test application measures itself plus a driver-owned parser fixture.
No production application, history, permission or task is modified.
"""
import json
import os
import pathlib
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time


def native_test_binary(root, coverage_target=None):
    target = pathlib.Path(coverage_target) if coverage_target else root / "apps/desktop/src-tauri/target"
    deps = target / "debug/deps"
    binaries = [p for p in deps.glob("yam_desktop_lib-*") if p.is_file() and p.stat().st_mode & 0o111]
    if not binaries:
        raise SystemExit("Native self-sampling test executable is missing in the configured target")
    if coverage_target and len(binaries) != 1:
        raise SystemExit("Expected one current coverage test executable for self-sampling")
    return max(binaries, key=lambda p: p.stat().st_mtime)


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Self-coalition sampling smoke requires macOS")
    root = pathlib.Path(__file__).resolve().parent.parent
    binary = native_test_binary(root, os.environ.get("CARGO_LLVM_COV_TARGET_DIR"))
    parser = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        with tempfile.TemporaryDirectory(prefix="yam-self-memory-") as folder:
            app = pathlib.Path(folder) / "YAM Self Memory Validation.app"
            exe = app / "Contents/MacOS/probe"
            exe.parent.mkdir(parents=True)
            shutil.copy2(binary, exe)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.yam.self-memory-validation",
                "CFBundleExecutable": "probe", "CFBundleName": "YAM Self Memory Validation",
                "CFBundlePackageType": "APPL", "LSUIElement": True,
            }))
            result = pathlib.Path(folder) / "result.json"
            start = pathlib.Path(folder) / "start"
            log = pathlib.Path(folder) / "log.txt"
            owner = {"pid": os.getpid(), "runtime_pid": parser.pid, "workloads": []}
            subprocess.run([
                "/usr/bin/open", "-n", "-g",
                "--env", "YAM_MEMORY_TEST_OWNER=" + json.dumps(owner),
                "--env", "YAM_MEMORY_TEST_RESULT=" + str(result),
                "--env", "YAM_MEMORY_TEST_START=" + str(start),
                "--env", "LLVM_PROFILE_FILE=" + os.devnull,
                "--stdout", str(log), "--stderr", str(log), str(app), "--args",
                "memory::tests::native_application_self_sampling", "--ignored", "--nocapture",
            ], check=True)
            # open belongs to the measured owner tree; release sampling only after it exits.
            start.touch()
            for _ in range(100):
                if result.exists():
                    break
                time.sleep(.1)
            if not result.exists():
                raise AssertionError("Sampling fixture did not finish: " + (log.read_text() if log.exists() else "no log"))
            data = json.loads(result.read_text())
            assert "Ok" in data, "Internal sampling failed: " + str(data)
            assert data["Ok"]["application_bytes"] > 0
            print(json.dumps(data))
    finally:
        parser.terminate()
        parser.wait(timeout=5)


if __name__ == "__main__":
    main()
