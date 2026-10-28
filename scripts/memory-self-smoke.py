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


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Self-coalition sampling smoke requires macOS")
    root = pathlib.Path(__file__).resolve().parent.parent
    deps = root / "apps/desktop/src-tauri/target/debug/deps"
    binaries = [p for p in deps.glob("yam_desktop_lib-*") if p.is_file() and p.stat().st_mode & 0o111]
    if not binaries:
        raise SystemExit("Run cargo test before native self-sampling smoke")
    binary = max(binaries, key=lambda p: p.stat().st_mtime)
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
            log = pathlib.Path(folder) / "log.txt"
            owner = {"pid": os.getpid(), "runtime_pid": parser.pid, "workloads": []}
            subprocess.run([
                "/usr/bin/open", "-n", "-g",
                "--env", "YAM_MEMORY_TEST_OWNER=" + json.dumps(owner),
                "--env", "YAM_MEMORY_TEST_RESULT=" + str(result),
                "--stdout", str(log), "--stderr", str(log), str(app), "--args",
                "memory::tests::native_application_self_sampling", "--ignored", "--nocapture",
            ], check=True)
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
