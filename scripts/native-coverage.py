#!/usr/bin/env python3
"""Author: Jeff.Liu. Compile once, isolate test groups, then enforce merged coverage."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time


WORKTREE = "worktree_manager::tests::"


def prepare_cache(target):
    # CI owns these empty directories before restoring cached build outputs.
    target = Path(target)
    target.mkdir()  # Refuse to label an existing directory as safe to clean.
    (target / "CACHEDIR.TAG").write_text("Signature: 8a477f597d28d172789f06886806bc55\n# YAM CI compilation cache.\n")


def parse_environment(output):
    values = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = shlex.split(line)
        if len(fields) != 1 or "=" not in fields[0]:
            raise ValueError("Invalid cargo-llvm-cov environment assignment")
        name, value = fields[0].split("=", 1)
        if not name.isidentifier() or name in values:
            raise ValueError("Invalid or duplicate coverage environment key")
        values[name] = value
    return values


def test_binaries(output):
    binaries = []
    for line in output.splitlines():
        message = json.loads(line)
        if message.get("reason") == "compiler-artifact" and message.get("profile", {}).get("test") and message.get("executable"):
            binaries.append(message["executable"])
    if not binaries or len(set(binaries)) != len(binaries):
        raise ValueError("Expected a unique inventory of freshly compiled test executables")
    return binaries


def test_names(output):
    names = set()
    for line in output.splitlines():
        if not line or re.fullmatch(r"\d+ tests?, \d+ benchmarks?", line):
            continue
        if not line.endswith(": test") or line[:-6] in names:
            raise ValueError("Unknown or duplicate test inventory entry")
        names.add(line[:-6])
    return names


def partition(binary, tests, ignored):
    if not ignored <= tests:
        raise ValueError("Ignored tests are absent from the complete inventory")
    worktree = {name for name in tests if WORKTREE in name}
    groups = []
    for label, names, arguments in [
        ("worktree", worktree, [WORKTREE, "--test-threads=1"]),
        ("remaining", tests - worktree, ["--skip", WORKTREE, "--test-threads=2"]),
    ]:
        if names or label == "remaining":
            groups.append((str(binary) + "/" + label, [str(binary), *arguments, "--format=pretty", "--color=never"], {name: name in ignored for name in names}))
    return groups


def audit_results(expected, output):
    actual = {}
    for name, status in re.findall(r"^test (\S+) \.\.\. (ok|FAILED|ignored(?:,.*)?)$", output, re.MULTILINE):
        if name in actual or status == "FAILED":
            raise ValueError("Duplicate or failed test result")
        actual[name] = status.startswith("ignored")
    summaries = re.findall(r"^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;", output, re.MULTILINE)
    counts = (len(expected) - sum(expected.values()), 0, sum(expected.values()))
    if actual != expected or len(summaries) != 1 or tuple(map(int, summaries[0])) != counts:
        raise ValueError("Executed tests or ignored status differ from the frozen inventory")


def run_groups(groups, env, timeout=600, *, cwd=None):
    active, lock, stopped = set(), threading.Lock(), threading.Event()

    def stop(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

    def worker(group):
        label, argv, expected = group
        started = time.monotonic()
        # Short private paths also avoid macOS Unix-socket path length limits.
        with tempfile.TemporaryDirectory(prefix="yam-native-", dir="/tmp") as directory:
            worker_env = dict(env, TMPDIR=directory, TMP=directory, TEMP=directory)
            with lock:
                if stopped.is_set():
                    raise RuntimeError("Test execution cancelled")
                process = subprocess.Popen(argv, cwd=cwd, env=worker_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
                active.add(process)
            try:
                output, _ = process.communicate(timeout=timeout)
                print(output, end="", flush=True)
                if process.returncode:
                    raise subprocess.CalledProcessError(process.returncode, argv)
                audit_results(expected, output)
                print(json.dumps({"group": label, "seconds": round(time.monotonic() - started, 3), "tests": len(expected), "ignored": sum(expected.values())}), flush=True)
            finally:
                stop(process)
                process.stdout.close()
                with lock:
                    active.remove(process)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(worker, group) for group in groups]
        try:
            for future in as_completed(futures):
                future.result()
        finally:
            with lock:
                stopped.set()
                running = list(active)
            for process in running:
                stop(process)


def run(manifest):
    manifest = Path(manifest).resolve()
    env = os.environ.copy()
    target = Path(env.setdefault("CARGO_LLVM_COV_TARGET_DIR", str(manifest.parent / "target/coverage"))).resolve()
    if target == (manifest.parent / "target").resolve():
        raise ValueError("Coverage requires an isolated target, not the ordinary application target")
    env["CARGO_LLVM_COV_TARGET_DIR"] = str(target)
    env["CARGO_TARGET_DIR"] = str(target)

    def cargo(arguments, capture=False):
        started = time.monotonic()
        cleaning = arguments[:2] == ["llvm-cov", "clean"]
        try:
            result = subprocess.run(["cargo", *arguments], cwd=manifest.parent, env=env, check=True, text=True, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if cleaning else None)
            if cleaning:
                sys.stderr.write(result.stderr)
                # cargo-llvm-cov 0.9.1 warns but returns zero when cargo clean fails.
                if "warning:" in result.stderr:
                    raise RuntimeError("Coverage cleanup emitted a warning; refusing stale build outputs")
            return result.stdout
        except subprocess.CalledProcessError as error:
            if cleaning and error.stderr:
                sys.stderr.write(error.stderr)
            raise
        finally:
            print(json.dumps({"phase": " ".join(arguments[:2]), "seconds": round(time.monotonic() - started, 3)}), flush=True)

    env.update(parse_environment(cargo(["llvm-cov", "show-env", "--no-cfg-coverage"], capture=True)))
    if "%p" not in env.get("LLVM_PROFILE_FILE", ""):
        raise ValueError("Parallel coverage profiles must contain a process ID")
    cargo(["llvm-cov", "clean", "--workspace", "--locked", "--color", "never"])
    binaries = test_binaries(cargo(["test", "--no-run", "--locked", "--message-format=json"], capture=True))
    listing_env = dict(env, LLVM_PROFILE_FILE=os.devnull)
    groups = []
    for binary in binaries:
        def inventory(*arguments):
            result = subprocess.run([binary, "--list", "--format=terse", *arguments], cwd=manifest.parent, env=listing_env, text=True, capture_output=True, check=True, timeout=30)
            return test_names(result.stdout)
        groups.extend(partition(binary, inventory(), inventory("--ignored")))
    print(json.dumps({"binaries": len(binaries), "groups": len(groups), "tests": sum(len(group[2]) for group in groups), "ignored": sum(sum(group[2].values()) for group in groups)}), flush=True)
    run_groups(groups, env, cwd=manifest.parent)
    cargo(["llvm-cov", "report", "--locked", "--fail-under-lines=85"])


if __name__ == "__main__":
    def cancelled(_signal, _frame):
        raise KeyboardInterrupt("Native coverage cancelled")
    signal.signal(signal.SIGTERM, cancelled)
    if len(sys.argv) > 1:
        if sys.argv[1] != "--prepare-cache" or len(sys.argv) < 3:
            raise SystemExit("Usage: native-coverage.py [--prepare-cache TARGET ...]")
        for directory in sys.argv[2:]:
            prepare_cache(directory)
    else:
        run(Path(__file__).resolve().parents[1] / "apps/desktop/src-tauri/Cargo.toml")
