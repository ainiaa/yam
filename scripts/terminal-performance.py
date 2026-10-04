#!/usr/bin/env python3
"""Author: Jeff.Liu. Isolated current-package owner RPC measurements; never GUI claims."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import plistlib
import secrets
import shlex
import shutil
import statistics
import re
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid finite nonnegative measurement")
    return value


def nearest_rank(values, percentile):
    if not values or type(percentile) not in (int, float) or not 0 < percentile <= 1:
        raise ValueError("Invalid percentile input")
    values = sorted(number(value) for value in values)
    return values[math.ceil(percentile * len(values)) - 1]


def cpu_delta(previous, current):
    elapsed = number(current["monotonic_seconds"]) - number(previous["monotonic_seconds"])
    if elapsed <= 0: raise ValueError("Nonmonotonic sample time")
    def processes(sample):
        rows = sample["application"]
        result = {row["pid"]: row for row in rows}
        if not result or len(result) != len(rows): raise ValueError("Missing or duplicate process")
        return result
    before, after = processes(previous), processes(current)
    if before.keys() != after.keys(): raise ValueError("CPU process membership changed")
    total = 0
    for pid, row in after.items():
        old = before[pid]
        if (old["started"], old["executable"]) != (row["started"], row["executable"]):
            raise ValueError("CPU process identity changed")
        delta = number(row["cpu_seconds"]) - number(old["cpu_seconds"])
        if delta < 0: raise ValueError("CPU clock rolled back")
        total += delta
    return total / elapsed


def summarize_samples(samples, required_phases):
    if not samples or not required_phases: raise ValueError("Missing measurement phase")
    phases = {}
    for phase, minimum in required_phases.items():
        if not phase or type(minimum) is not int or minimum < 1: raise ValueError("Invalid phase contract")
        values = [s for s in samples if s.get("phase") == phase]
        if len(values) < minimum: raise ValueError("Required phase is undersampled: " + phase)
        components = {}
        for s in values:
            if s.get("status") != "complete" or s.get("late") or s.get("missed_slots", 0):
                raise ValueError("Partial or late measurement")
            number(s["monotonic_seconds"]); number(s["phys_footprint_sum_bytes"]); number(s["rss_bytes"])
            if not s["application"]: raise ValueError("Missing application processes")
            totals = {}
            for row in s["application"]:
                number(row["cpu_seconds"])
                role = row["role"]
                totals[role] = totals.get(role, 0) + number(row["phys_footprint_bytes"])
            for role, value in totals.items(): components.setdefault(role, []).append(value)
        cpu = [cpu_delta(a, b) for a, b in zip(values, values[1:])]
        memory = [v["phys_footprint_sum_bytes"] for v in values]
        phases[phase] = {"samples": len(values), "memory_median_bytes": statistics.median(memory),
                         "memory_peak_bytes": max(memory), "cpu_cores_raw": cpu,
                         "cpu_cores_median": statistics.median(cpu) if cpu else None,
                         "components": {role: {"median_bytes": statistics.median(v), "peak_bytes": max(v)}
                                        for role, v in components.items()}}
    if any(s.get("phase") not in required_phases for s in samples): raise ValueError("Unrecognized phase")
    return {"complete_ratio": 1, "phases": phases, "raw_samples": samples}


def sample_completeness(samples, scheduled_slots):
    outside = sum(s.get("outside_phase_missed_slots", 0) for s in samples)
    missed = sum(s.get("missed_slots", 0) - s.get("outside_phase_missed_slots", 0) for s in samples)
    if any(type(s.get(key, 0)) is not int or s.get(key, 0) < 0 for s in samples
           for key in ("missed_slots", "outside_phase_missed_slots")) or any(
               s.get("outside_phase_missed_slots", 0) > s.get("missed_slots", 0) for s in samples):
        raise ValueError("Invalid missed sample count")
    if type(scheduled_slots) is not int or scheduled_slots < len(samples) + missed:
        raise ValueError("Invalid scheduled sample count")
    complete = sum(s.get("status") == "complete" and not s.get("late") for s in samples)
    return {"scheduled_slots": scheduled_slots, "observed_samples": len(samples),
            "missed_slots": missed, "outside_phase_missed_slots": outside,
            "complete_ratio": complete / scheduled_slots if scheduled_slots else 0}


def output_continuity(expected_ids, previous, current):
    try:
        frames = current["frames"]
        if set(frames) != set(expected_ids): raise ValueError("fixture_source_missing")
        for identity, frame in frames.items():
            if frame["status"] != "running": raise ValueError("fixture_not_running")
            if type(frame["end_offset"]) is not int or frame["end_offset"] < 0:
                raise ValueError("fixture_counter_invalid")
            if previous is not None and frame["end_offset"] <= previous["frames"][identity]["end_offset"]:
                raise ValueError("fixture_output_not_advancing")
        def identities(snapshot):
            rows = snapshot["workloads"]
            if len(rows) != len(expected_ids) or len({row["pid"] for row in rows}) != len(rows):
                raise ValueError("fixture_workload_membership")
            if any(type(row["pid"]) is not int or row["pid"] <= 0 or not row["started"] or not row["executable"] for row in rows):
                raise ValueError("fixture_workload_identity")
            return sorted((row["pid"], row["started"], row["executable"]) for row in rows)
        current_identity = identities(current)
        if previous is not None and identities(previous) != current_identity:
            raise ValueError("fixture_workload_changed")
    except (KeyError, TypeError, ValueError) as error:
        code = str(error) if isinstance(error, ValueError) else "fixture_continuity_unavailable"
        return {"status": "partial", "issues": [code]}
    return {"status": "complete", "issues": []}


def digest(path):
    path = pathlib.Path(path)
    if path.is_symlink(): raise ValueError("Linked evidence input")
    h = hashlib.sha256()
    if path.is_file():
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""): h.update(chunk)
    elif path.is_dir():
        for entry in sorted(path.rglob("*")):
            if entry.is_symlink(): raise ValueError("Linked package resource")
            if entry.is_file():
                h.update(entry.relative_to(path).as_posix().encode() + b"\0")
                h.update(bytes.fromhex(digest(entry)))
    else: raise ValueError("Missing evidence input")
    return h.hexdigest()


def evidence_binding(source_files, package, commit):
    if not source_files or not isinstance(commit, str) or len(commit) != 40:
        raise ValueError("Missing source identity")
    h = hashlib.sha256()
    files = sorted(map(pathlib.Path, source_files))
    base = ROOT if all(source.is_relative_to(ROOT) for source in files) else pathlib.Path(os.path.commonpath([str(source.parent) for source in files]))
    for source in files:
        h.update(source.relative_to(base).as_posix().encode() + b"\0" + bytes.fromhex(digest(source)))
    return {"commit": commit, "source_sha256": h.hexdigest(), "package_sha256": digest(package)}


def product_source_files():
    tracked = subprocess.check_output(["git", "ls-files", "-z", "apps/desktop"], cwd=ROOT)
    extra = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z", "apps/desktop"], cwd=ROOT)
    return sorted({ROOT / os.fsdecode(p) for p in (tracked + extra).split(b"\0") if p and (ROOT / os.fsdecode(p)).is_file()})


def product_source_sha256():
    h = hashlib.sha256()
    for source in product_source_files():
        h.update(source.relative_to(ROOT).as_posix().encode() + b"\0" + bytes.fromhex(digest(source)))
    return h.hexdigest()


def validate_package_receipt(app, receipt):
    app = pathlib.Path(app)
    info_path = app / "Contents/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    if info.get("CFBundleIdentifier") != "com.yam.performance-validation-t06" or receipt.get("identifier") != info["CFBundleIdentifier"]:
        raise ValueError("Package identity mismatch")
    if not re.fullmatch(r"[0-9a-f]{64}", receipt.get("product_source_fingerprint", "")):
        raise ValueError("Missing frozen product source receipt")
    if receipt.get("source_sha256") != product_source_sha256():
        raise ValueError("Frozen product source changed")
    actual = {"package_sha256": digest(app), "info_sha256": digest(info_path),
              "binary_sha256": digest(app / "Contents/MacOS" / info["CFBundleExecutable"]),
              "terminal_resource_sha256": digest(app / "Contents/Resources/target/terminal-runtime/yam-terminal")}
    if any(receipt.get(key) != value for key, value in actual.items()):
        raise ValueError("Frozen package hash mismatch")


def write_evidence(path, value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as destination:
        destination.write(data); destination.flush(); os.fsync(destination.fileno())


def cancel_fixture(owned_ids, requested_ids, stop):
    if len(requested_ids) != len(set(requested_ids)) or not set(requested_ids) <= set(owned_ids):
        raise ValueError("Refusing non-fixture cancellation")
    for identity in requested_ids: stop(identity)


def close_fixture_desktop(desktop, is_disconnected, pause):
    if desktop.poll() is None: desktop.terminate(); desktop.wait(timeout=10)
    if not is_disconnected(): raise ValueError("Fixture desktop is still connected")
    pause()


FIXTURE = r'''import sys,time
sys.stdout.reconfigure(encoding="utf-8")
sys.stdout.write("\x1b[?1049h\x1b[2J\x1b[H")
n=0
while True:
 n+=1
 sys.stdout.write("\x1b[HT06 synthetic 中文😀 %08d\r\n"%n+("x"*70+"\r\n")*3)
 sys.stdout.flush();time.sleep(.05)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument("--desktop-idle", action="store_true", help="Empty-history native GUI memory only; exit before creating any PTY")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--long-seconds", type=int, choices=[0, 1800], default=0)
    parser.add_argument("--interval", type=float, default=5)
    args = parser.parse_args()
    if args.rounds < 1 or args.interval != 5: parser.error("Rounds must be positive; frozen interval is 5 seconds")
    args.output.mkdir(parents=True, exist_ok=False)
    app = args.app.resolve(); info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    identifier = info["CFBundleIdentifier"]
    if identifier != "com.yam.performance-validation-t06": raise ValueError("Wrong isolated package identity")
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    binding = json.loads(args.receipt.read_text())
    validate_package_receipt(app, binding)
    run_receipt = dict(dimensions={"cols": 100, "rows": 40}, scrollback=2000,
                   frozen_build_receipt_sha256=digest(args.receipt), measurement_script_sha256=digest(__file__),
                   fixture_sha256=hashlib.sha256(FIXTURE.encode()).hexdigest(),
                   fixture_nominal_iterations_per_second=20,
                   fixture_nominal_bytes_per_iteration=len(("\x1b[HT06 synthetic 中文😀 %08d\r\n" % 1 + ("x" * 70 + "\r\n") * 3).encode()),
                   scope="native-background-owner-RPC", output_queue_telemetry="unmeasured",
                   gui_scenarios="empty cold-desktop memory only if requested; own GUI terminated before any PTY. Live GUI memory/input/normal CmdQ pending",
                   desktop_window_geometry={"configured_width":1180,"configured_height":760,"actual_geometry":"unverified; config default only"})
    write_evidence(args.output / "package-receipt.json", binding)
    write_evidence(args.output / "run-receipt.json", run_receipt)
    smoke, memory = load("performance_smoke", "background-smoke.py"), load("performance_memory", "yam-memory.py")
    data_root = pathlib.Path.home() / "Library/Application Support" / identifier
    all_ok = True
    for round_index in range(args.rounds):
        if data_root.exists(): raise ValueError("Refusing pre-existing validation data")
        data_root.mkdir(mode=0o700)
        token = secrets.token_hex(32); marker = data_root / ".t06-owned-fixture"
        marker.write_text(token); marker.chmod(0o600)
        owner = None; desktop = None; sessions = set(); descriptor = None; request_id = 0; client = secrets.token_hex(32)
        samples = []; required = {}; phase = "cold-owner"
        def call(command, arguments=None):
            nonlocal request_id
            request_id += 1
            return smoke.rpc(descriptor, client, request_id, command, arguments)
        def capture(phase_name, count):
            required[phase_name] = count
            output_before = {identity: call("read_terminal_frame", {"session_id": identity})["end_offset"] for identity in sorted(sessions)}
            phase_start = time.monotonic()
            slot = time.monotonic()
            final_slot = slot + (count - 1) * args.interval
            index = 0
            previous_output = None
            while slot <= final_slot:
                delay = slot - time.monotonic()
                if delay > 0: time.sleep(delay)
                started = time.monotonic()
                try:
                    value = memory.collect(identifier, data_root / "background/connection.json")
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    value = {"status":"partial", "issues":["measurement_unavailable",type(error).__name__],
                             "monotonic_seconds":time.monotonic(),"application":[],"agents":[],
                             "rss_bytes":None,"phys_footprint_sum_bytes":None}
                if sessions and phase_name.startswith("output-"):
                    try:
                        frames = {identity: call("read_terminal_frame", {"session_id": identity}) for identity in sorted(sessions)}
                    except (OSError, ValueError, AssertionError, subprocess.SubprocessError):
                        frames = {}
                    snapshot = {"frames": {identity: {"status": frame.get("status"), "end_offset": frame.get("end_offset")}
                                           for identity, frame in frames.items()},
                                "workloads": [{key: row.get(key) for key in ("pid", "started", "executable")}
                                              for row in value.get("agents", [])]}
                    continuity = output_continuity(sessions, previous_output, snapshot)
                    value["output_continuity"] = {**snapshot, **continuity}
                    if continuity["status"] != "complete":
                        value["status"] = "partial"
                        value.setdefault("issues", []).extend(continuity["issues"])
                    previous_output = snapshot
                ended = time.monotonic()
                value.update(memory.sample_timing(slot, started, ended, args.interval), phase=phase_name)
                remaining_phase_slots = max(0, round((final_slot - slot) / args.interval))
                value["outside_phase_missed_slots"] = max(0, value["missed_slots"] - remaining_phase_slots)
                samples.append(value)
                # Persist every raw sample immediately, including partial/late results.
                write_evidence(args.output / f"round-{round_index + 1}-{phase_name}-{index:04d}.json", value)
                if index % 12 == 0:
                    print(json.dumps({"round": round_index + 1, "phase": phase_name, "sample": index + 1,
                                      "status": value["status"], "late": value["late"]}), flush=True)
                slot += args.interval * (1 + value["missed_slots"])
                index += 1
            output_after = {identity: call("read_terminal_frame", {"session_id": identity})["end_offset"] for identity in sorted(sessions)}
            phase_elapsed = time.monotonic() - phase_start
            deltas = [output_after[identity] - output_before[identity] for identity in sorted(sessions)]
            if sessions and phase_name.startswith("output-") and any(delta <= 0 for delta in deltas):
                raise ValueError("Continuous-output fixture did not produce bytes")
            write_evidence(args.output / f"round-{round_index + 1}-{phase_name}-output.json",
                           {"elapsed_monotonic_seconds": phase_elapsed, "sessions": len(sessions),
                            "output_bytes_delta_per_session": deltas, "cumulative_output_bytes_total": sum(output_after.values()),
                            "observed_output_bytes_per_second_total": sum(deltas) / phase_elapsed,
                            "boundary": "actual native frame end_offset counters; sequential RPC snapshots at phase boundaries"})
        try:
            started = time.monotonic()
            owner = subprocess.Popen([str(executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            smoke.wait_until(lambda: (data_root / "background/connection.json").exists() or owner.poll() is not None, 20)
            if owner.poll() is not None: raise ValueError("Fixture owner failed to start")
            descriptor = memory.read_connection(data_root / "background/connection.json")
            status = call("background_status")
            if status["pid"] != owner.pid or status["desktop_connected"]: raise ValueError("Fixture owner identity mismatch")
            call("set_agent_notification_context", {"selected": None, "paused": True})
            write_evidence(args.output / f"round-{round_index + 1}-startup.json",
                           {"scope": "owner-RPC-ready", "elapsed_ms": (time.monotonic() - started) * 1000,
                            "empty_history": call("history_overview")["total"] == 0})
            with tempfile.TemporaryDirectory(prefix="yam-t06-output-fixture-") as temporary:
                folder = pathlib.Path(temporary); fixture = folder / "output.py"; fixture.write_text(FIXTURE)
                capture("cold-owner", 3)
                if args.desktop_idle:
                    if call("history_overview")["total"] != 0: raise ValueError("Unsafe nonempty GUI fixture")
                    desktop = subprocess.Popen([str(executable)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    smoke.wait_until(lambda: call("background_status")["desktop_connected"], 30)
                    time.sleep(3); capture("cold-desktop-empty", 3)
                    close_fixture_desktop(desktop,
                        lambda: smoke.wait_until(lambda: not call("background_status")["desktop_connected"], 15),
                        lambda: call("set_agent_notification_context", {"selected": None, "paused": True}))
                    desktop = None
                for count in [1, 4, 16]:
                    while len(sessions) < count:
                        command = " ".join(shlex.quote(str(value)) for value in [pathlib.Path(os.sys.executable), fixture])
                        summary = call("create_session", {"cwd": str(folder), "command": command})
                        identity = summary["session_id"]; sessions.add(identity)
                        call("resize_session", {"session_id": identity, "cols": 100, "rows": 40})
                    time.sleep(2)
                    capture(f"output-{count}", 3)
                if args.long_seconds:
                    capture("output-16-long", args.long_seconds // 5 + 1)
                cancel_fixture(sessions, sorted(sessions), lambda identity: call("stop_session", {"session_id": identity}))
                smoke.wait_until(lambda: call("background_status")["active_sessions"] == 0, 15)
                time.sleep(1); capture("stopped", 3)
                sessions.clear()
                call("shutdown"); owner.wait(timeout=10); owner = None
                owner = subprocess.Popen([str(executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                previous = descriptor["instance"]
                smoke.wait_until(lambda: (memory.read_connection(data_root / "background/connection.json")["instance"] != previous)
                                 if (data_root / "background/connection.json").exists() else False, 20)
                descriptor = memory.read_connection(data_root / "background/connection.json")
                call("set_agent_notification_context", {"selected": None, "paused": True})
                if call("background_status")["active_sessions"]: raise ValueError("Stopped fixture reran")
                capture("owner-reopen", 3)
            try:
                summary = summarize_samples(samples, required)
                summary["status"] = "complete"
            except ValueError as error:
                summary = {"status": "partial", "reason": str(error), "raw_samples": samples,
                           **sample_completeness(samples, sum(required.values()))}
                all_ok = False
            write_evidence(args.output / f"round-{round_index + 1}-summary.json", summary)
            validate_package_receipt(app, binding)
        finally:
            if desktop is not None and desktop.poll() is None:
                desktop.terminate(); desktop.wait(timeout=10)
                if descriptor:
                    smoke.wait_until(lambda: not call("background_status")["desktop_connected"], 15)
                    call("set_agent_notification_context", {"selected": None, "paused": True})
            if owner is not None and owner.poll() is None:
                try:
                    if descriptor:
                        cancel_fixture(sessions, sorted(sessions), lambda identity: call("stop_session", {"session_id": identity}))
                        call("shutdown"); owner.wait(timeout=10)
                    else: owner.terminate(); owner.wait(timeout=10)
                except (OSError, AssertionError, subprocess.TimeoutExpired): owner.kill(); owner.wait(timeout=5)
            # Only this exact namespace, created above, carrying this run's unguessable ownership marker.
            if data_root.is_symlink() or marker.is_symlink() or marker.read_text() != token:
                raise ValueError("Fixture ownership changed; refusing cleanup")
            shutil.rmtree(data_root)
    print(json.dumps({"status": "complete" if all_ok else "partial", "rounds": args.rounds}), flush=True)
    return 0 if all_ok else 2


if __name__ == "__main__": raise SystemExit(main())
