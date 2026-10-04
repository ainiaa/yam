#!/usr/bin/env python3
"""Author: Jeff.Liu. Exercise only an explicitly isolated macOS validation bundle."""
import argparse
import hashlib
import importlib.util
import stat
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import socket
import struct
import subprocess
import sys
import time
from xml.parsers.expat import ExpatError


def wait_until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Background acceptance timed out")


def app_data(identifier):
    return Path.home() / "Library/Application Support" / identifier


def current_product_source():
    spec = importlib.util.spec_from_file_location("f7_product_hash", Path(__file__).with_name("terminal-performance.py"))
    performance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(performance)
    base = Path(__file__).resolve().parent.parent
    files = set(performance.product_source_files())
    files.update(base / name for name in ("apps/desktop/pnpm-lock.yaml", "scripts/build-terminal-runtime.py", "scripts/third_party_notices.py", "scripts/node-runtime-checksums.json"))
    files.update(path for path in (base / "scripts/third-party-notices").rglob("*") if path.is_file() or path.is_symlink())
    manifest = {path.relative_to(base).as_posix(): performance.digest(path) for path in sorted(files)}
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return manifest, hashlib.sha256(encoded).hexdigest()


def unlinked(path):
    path = Path(path)
    if not path.is_absolute() or any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Linked or non-absolute F7 input")
    return path


def regular_bytes(path, limit=1024 * 1024):
    path = unlinked(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError("Invalid F7 input file")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Invalid F7 input file")
    return data


def validate_f7_run(app, identifier, receipt_path, *, first_start=True):
    if sys.flags.optimize:
        raise ValueError("Optimized Python cannot run F7 acceptance")
    if not isinstance(identifier, str) or not re.fullmatch(r"com\.yam\.functional-validation-f7-[0-9a-f]{32}", identifier) or receipt_path is None:
        raise ValueError("F7 requires a fresh identity and build receipt")
    try:
        app = unlinked(app)
        receipt = json.loads(regular_bytes(receipt_path))
        if not isinstance(receipt, dict) or type(receipt.get("schema_version")) is not int or receipt["schema_version"] != 1 or receipt.get("purpose") != "F7-current-source-developer-artifact":
            raise ValueError("Unsupported F7 build receipt")
        info_path = app / "Contents/Info.plist"
        info = plistlib.loads(regular_bytes(info_path))
        name = info.get("CFBundleExecutable")
        if not isinstance(name, str) or not name or Path(name).name != name or name in (".", ".."):
            raise ValueError("Invalid F7 executable declaration")
        executable = unlinked(app / "Contents/MacOS" / name)
        resource = unlinked(app / "Contents/Resources/target/terminal-runtime/yam-terminal")
        if not stat.S_ISREG(executable.lstat().st_mode) or not stat.S_ISREG(resource.lstat().st_mode):
            raise ValueError("F7 executable and runtime must be regular files")
        if info.get("CFBundleIdentifier") != identifier or receipt.get("identifier") != identifier or info.get("LSMinimumSystemVersion") != "13.5" or receipt.get("package_path") != str(app) or receipt.get("executable_path") != str(executable):
            raise ValueError("F7 package identity mismatch")
        spec = importlib.util.spec_from_file_location("f7_digest", Path(__file__).with_name("terminal-performance.py"))
        performance = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(performance)
        actual = {"package_sha256": performance.digest(app), "info_sha256": performance.digest(info_path), "binary_sha256": performance.digest(executable), "resources_sha256": performance.digest(app / "Contents/Resources"), "terminal_resource_sha256": performance.digest(resource)}
        if any(receipt.get(key) != value for key, value in actual.items()):
            raise ValueError("F7 package changed")
        manifest, source_sha = current_product_source()
        if receipt.get("source_manifest") != manifest or receipt.get("source_sha256") != source_sha:
            raise ValueError("F7 product source changed")
        build = receipt.get("build")
        if not isinstance(build, dict) or type(build.get("exit_code")) is not int or build["exit_code"] != 0 or build.get("source_before_sha256") != source_sha or build.get("source_after_sha256") != source_sha:
            raise ValueError("Missing successful current-source F7 build")
        config_path, log_path = build.get("config_path"), build.get("log_path")
        config_bytes = regular_bytes(config_path)
        config = json.loads(config_bytes)
        argv = build.get("argv")
        if not isinstance(config, dict) or config.get("identifier") != identifier or not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv) or not any(argv[i] == "--config" and argv[i + 1] == config_path for i in range(len(argv) - 1)):
            raise ValueError("F7 compiled configuration identity mismatch")
        if hashlib.sha256(config_bytes).hexdigest() != build.get("config_sha256") or hashlib.sha256(regular_bytes(log_path, 8 * 1024 * 1024)).hexdigest() != build.get("log_sha256"):
            raise ValueError("F7 build provenance changed")
        whole_bytes = regular_bytes(receipt.get("whole_source_receipt"), 16 * 1024 * 1024)
        whole = json.loads(whole_bytes)
        if not isinstance(whole, dict) or not re.fullmatch(r"[0-9a-f]{64}", receipt.get("whole_source_fingerprint", "")) or whole.get("source_fingerprint") != receipt["whole_source_fingerprint"] or hashlib.sha256(whole_bytes).hexdigest() != receipt.get("whole_source_receipt_sha256"):
            raise ValueError("F7 whole source receipt mismatch")
        root = unlinked(app_data(identifier))
        if root.name != identifier or first_start and root.exists() and (not root.is_dir() or any(root.iterdir())):
            raise ValueError("Refusing a pre-existing F7 namespace")
        return {"executable": executable, "root": root, "receipt": receipt}
    except (OSError, TypeError, KeyError, json.JSONDecodeError, plistlib.InvalidFileException, ExpatError):
        raise ValueError("Invalid F7 preflight input") from None


def confirm_f7_owner(owner, connection, client, request_id, previous_instance=None):
    if owner.poll() is not None:
        raise ValueError("F7 owned background exited")
    connection = unlinked(connection)
    if connection.stat().st_mode & 0o777 != 0o600:
        raise ValueError("Unsafe F7 descriptor mode")
    descriptor = json.loads(regular_bytes(connection, 16 * 1024))
    if not isinstance(descriptor, dict) or type(descriptor.get("version")) is not int or descriptor["version"] != PROTOCOL_VERSION:
        raise ValueError("Unsupported F7 background descriptor")
    address = descriptor.get("address")
    if not isinstance(address, str) or not re.fullmatch(r"127\.0\.0\.1:[0-9]{1,5}", address) or not 1 <= int(address.rsplit(":", 1)[1]) <= 65535:
        raise ValueError("Invalid F7 background address")
    if any(not isinstance(descriptor.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", descriptor[key]) for key in ("token", "instance")) or descriptor["instance"] == previous_instance:
        raise ValueError("Invalid or reused F7 background identity")
    ready = rpc(descriptor, client, request_id + 1, "ping")
    status = rpc(descriptor, client, request_id + 2, "background_status")
    if not isinstance(ready, dict) or ready.get("ready") is not True or not isinstance(status, dict) or type(status.get("pid")) is not int or status["pid"] != owner.pid or owner.poll() is not None:
        raise ValueError("F7 descriptor is not the retained background process")
    return descriptor, request_id + 2


PROTOCOL_VERSION = 2

def rpc(descriptor,client,request_id,command,arguments=None,*,error=False):
    wire_id=request_id
    address, port = descriptor["address"].rsplit(":", 1)
    assert address == "127.0.0.1"
    assert descriptor["version"] == PROTOCOL_VERSION, "Background protocol upgrade required"
    wire = json.dumps({"version": PROTOCOL_VERSION, "token": descriptor["token"], "instance": descriptor["instance"],
                       "client": client, "id": wire_id, "command": command, "args": arguments or {}}).encode()
    with socket.create_connection((address, int(port)), timeout=5) as stream:
        deadline=time.monotonic()+10
        stream.settimeout(10)
        stream.sendall(struct.pack("!I", len(wire)) + wire)

        def read(length):
            result = bytearray()
            while len(result) < length:
                remaining=deadline-time.monotonic()
                assert remaining>0,"Background response deadline reached"
                stream.settimeout(remaining)
                chunk = stream.recv(length - len(result))
                assert chunk, "Background closed connection before response"
                result.extend(chunk)
            return result

        length = struct.unpack("!I", read(4))[0]
        assert 0 < length <= 64 * 1024 * 1024
        result = json.loads(read(length))
        assert result["version"] == PROTOCOL_VERSION and result["instance"] == descriptor["instance"] and result["id"] == wire_id and result["client"] == client
        if error:
            assert isinstance(result["result"].get("Err"),str), "Background unexpectedly accepted an invalid command"
            return result["result"]["Err"]
        assert "Ok" in result["result"], "Background rejected validation command"
        return result["result"]["Ok"]


def main():
    if sys.flags.optimize:
        raise ValueError("Optimized Python cannot run F7 acceptance")
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--identifier", help="Exact fresh compiled F7 identifier")
    parser.add_argument("--receipt", type=Path, help="Current-source developer build receipt")
    parser.add_argument("--desktop", action="store_true", help="Launch the actual desktop, then exit and reopen it around a live task")
    parser.add_argument("--idle-check",action="store_true",help="Verify a connected idle desktop retains its owner for longer than the 60-second detach timeout")
    args = parser.parse_args()
    if args.idle_check and not args.desktop:
        raise ValueError("Idle check requires desktop")
    binding = validate_f7_run(args.app, args.identifier, args.receipt)
    executable, root = binding["executable"], binding["root"]
    connection = root / "background/connection.json"
    owner = subprocess.Popen([str(executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    desktop = None
    confirmed = False
    owned_sessions = set()
    session = None
    descriptor = None
    client = secrets.token_hex(32)
    request_id = 0

    def call(command, arguments=None, *, repeat_id=None, error=False):
        nonlocal request_id
        if not confirmed or descriptor is None:
            raise ValueError("F7 owner is not confirmed")
        current, request_id = confirm_f7_owner(owner, connection, client, request_id)
        if current != descriptor:
            raise ValueError("F7 owner was replaced")
        if command == "stop_session" and (arguments or {}).get("session_id") not in owned_sessions:
            raise ValueError("Refusing a non-fixture session stop")
        if repeat_id is None:
            request_id += 1
        wire_id = request_id if repeat_id is None else repeat_id
        value = rpc(descriptor, client, wire_id, command, arguments, error=error)
        if command == "create_session" and not error:
            owned_sessions.add(value["session_id"])
        return value

    def current_executable():
        return validate_f7_run(args.app, args.identifier, args.receipt, first_start=False)["executable"]

    def restart_owner(old_instance):
        nonlocal owner, descriptor, confirmed, client, request_id
        confirmed = False
        descriptor = None
        # Only this run's previously confirmed namespace may be populated here.
        if owner.poll() is None:
            raise ValueError("Previous owned background is still running")
        validated_executable = current_executable()
        owner = subprocess.Popen([str(validated_executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        client, request_id = secrets.token_hex(32), 0
        wait_until(lambda: owner.poll() is not None or connection.exists() and json.loads(regular_bytes(connection, 16 * 1024)).get("instance") != old_instance)
        descriptor, request_id = confirm_f7_owner(owner, connection, client, request_id, old_instance)
        confirmed = True

    def pause_notifications():
        state = call("get_notification_pause_state")
        if state.get("owner_instance") != descriptor["instance"] or type(state.get("revision")) is not int:
            raise ValueError("F7 pause owner mismatch")
        paused = call("set_notification_paused", {"paused": True, "expected_revision": state["revision"], "expected_owner_instance": descriptor["instance"]})
        if paused.get("owner_instance") != descriptor["instance"] or paused.get("paused") is not True:
            raise ValueError("F7 notification pause was not accepted")

    try:
        wait_until(lambda: connection.exists() or owner.poll() is not None)
        descriptor, request_id = confirm_f7_owner(owner, connection, client, request_id)
        confirmed = True
        pause_notifications()
        background_pid = owner.pid
        if args.desktop:
            desktop = subprocess.Popen([str(current_executable())], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_until(lambda: call("background_status")["desktop_connected"])
            if desktop.poll() is not None:
                raise ValueError("F7 desktop exited during initialization")
        probe = """import os,sys,time,tty,select
print('YAM_BG_PID='+str(os.getpid()),flush=True)
tty.setraw(sys.stdin.fileno())
os.write(1,b'\\x1b[?1049h\\x1b[HALT '+bytes([0xe4,0xb8])); time.sleep(.05); os.write(1,bytes([0xad]))
for index in range(2):
 if index: time.sleep(4)
 os.write(1,b'\\x1b[2;3H\\x1b[6n')
 response=b''; deadline=time.monotonic()+3
 while time.monotonic()<deadline and not response.endswith(b'R'):
  if select.select([0],[],[],.1)[0]: response+=os.read(0,1)
 extra=bool(select.select([0],[],[],.15)[0])
 result='PASSED' if response==b'\\x1b[2;3R' and not extra else 'FAILED'
 os.write(1,('\\r\\nYAM_QUERY_'+str(index+1)+'='+result+'\\r\\n').encode())
time.sleep(60)
"""
        command = shlex.join([sys.executable, "-u", "-c", probe if args.desktop else "import os,time; print('YAM_BG_PID='+str(os.getpid()),flush=True); time.sleep(60)"])
        created = call("create_session", {"cwd": str(root), "command": command})
        create_id = request_id
        session = created["session_id"]
        assert call("create_session", {"cwd": str(root), "command": command}, repeat_id=create_id)["session_id"] == session
        snapshot = wait_until(lambda: (value if "YAM_BG_PID=" in (value := call("read_session_snapshot", {"session_id": session}))["data"] else None))
        pid = int(re.search(r"YAM_BG_PID=(\d+)", snapshot["data"])[1])
        os.kill(pid, 0)
        if args.desktop:
            wait_until(lambda: "YAM_QUERY_1=PASSED" in call("read_session_snapshot",{"session_id":session})["data"])
            scene=call("read_terminal_frame",{"session_id":session})
            assert scene["projection"]["buffer"] == "alternate"
            assert "中" in scene["projection"]["data"]
        # A second authenticated viewer remains read-only until an explicit takeover.
        original_client=client
        call("write_session",{"session_id":session,"data":""})
        client=secrets.token_hex(32)
        assert "controls" in call("write_session",{"session_id":session,"data":""},error=True)
        assert "Unknown" in call("take_terminal_control",{"session_id":"s-missing"},error=True)
        call("take_terminal_control",{"session_id":session})
        call("write_session",{"session_id":session,"data":""})
        takeover_client=client;client=original_client
        assert "controls" in call("write_session",{"session_id":session,"data":""},error=True)
        client=takeover_client
        # Each RPC client socket has genuinely closed. Reconnect with a distinct client identity.
        client = secrets.token_hex(32)
        request_id = 0
        records = call("list_sessions")
        assert sum(record["summary"]["session_id"] == session for record in records) == 1
        assert next(record for record in records if record["summary"]["session_id"] == session)["status"] == "running"
        os.kill(pid, 0)
        duplicate = subprocess.run([str(current_executable()), "--yam-background"], capture_output=True, timeout=10)
        assert b"Another background instance" in duplicate.stderr
        assert owner.poll() is None
        os.kill(pid, 0)
        if args.desktop:
            old_instance = descriptor["instance"]
            desktop.terminate()  # Only the retained GUI handle; background owner survives.
            desktop.wait(timeout=5)
            desktop.stderr.close()
            desktop = None
            time.sleep(6)
            assert not call("background_status")["desktop_connected"]
            os.kill(pid, 0)
            assert "YAM_QUERY_2=PASSED" in call("read_session_snapshot",{"session_id":session})["data"]
            assert call("read_terminal_frame",{"session_id":session})["projection"]["buffer"] == "alternate"
            assert call("background_status")["pid"] == background_pid
            desktop = subprocess.Popen([str(current_executable())], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_until(lambda: call("background_status")["desktop_connected"])
            assert json.loads(connection.read_text())["instance"] == old_instance
            assert call("background_status")["pid"] == background_pid
            assert call("background_status")["active_sessions"] == 1
            os.kill(pid, 0)
            assert next(r for r in call("list_sessions") if r["summary"]["session_id"] == session)["status"] == "running"
        call("stop_session", {"session_id": session})
        wait_until(lambda: next(record for record in call("list_sessions") if record["summary"]["session_id"] == session)["status"] == "stopped")
        if args.desktop:
            wait_until(lambda: call("background_status")["active_sessions"] == 0)
            wait_until(lambda: call("read_terminal_frame",{"session_id":session}) is not None)
            saved=call("read_terminal_frame",{"session_id":session})
            assert saved["status"] == "stopped" and saved["projection"]["buffer"] == "alternate"
            if args.idle_check:
                time.sleep(65)
                assert owner.poll() is None
                assert call("background_status")["desktop_connected"]
                assert call("background_status")["pid"] == background_pid
            call("create_session", {"cwd":str(root),"command":command})
            call("shutdown")  # Explicit stop-all path, including an active task.
            owner.wait(timeout=10)
            owner.stderr.close()
            desktop.terminate()
            desktop.wait(timeout=5)
            desktop.stderr.close()
            desktop = None
            old_instance = descriptor["instance"]
            restart_owner(old_instance)
            restored=call("read_terminal_frame",{"session_id":session})
            assert restored["projection"] == saved["projection"] and restored["status"] == "stopped"
            assert call("background_status")["active_sessions"] == 0
            call("shutdown");owner.wait(timeout=10);assert owner.returncode == 0
            print(json.dumps({"desktop_exit_reopen":"passed","session":session,"same_background_pid":True,
                              "same_task_pid":True,"no_duplicate_launch":True,"stop_all_shutdown":True,"background_query_reply":True,"saved_alternate_scene":True,"frozen_scene_after_owner_restart":True,"explicit_input_takeover":True,
                              "connected_idle_retains_owner":args.idle_check,"exit_method":"SIGTERM to the fixture desktop"}))
            return
        interrupted = call("create_session", {"cwd": str(root), "command": command})["session_id"]
        snapshot = wait_until(lambda: (value if "YAM_BG_PID=" in (value := call("read_session_snapshot", {"session_id": interrupted}))["data"] else None))
        interrupted_pid = int(re.search(r"YAM_BG_PID=(\d+)", snapshot["data"])[1])
        old_instance = descriptor["instance"]
        owner.kill()  # Kill only the Popen handle created by this fixture.
        owner.wait(timeout=5)
        owner.stderr.close()

        def task_no_longer_running():
            result = subprocess.run(["/bin/ps", "-p", str(interrupted_pid), "-o", "stat="], capture_output=True, timeout=2)
            return not result.stdout.strip() or result.stdout.strip().startswith(b"Z")

        wait_until(task_no_longer_running)
        restart_owner(old_instance)
        assert call("ping")["ready"]
        records = call("list_sessions")
        assert next(record for record in records if record["summary"]["session_id"] == interrupted)["status"] == "needs_attention"
        assert sum(record["summary"]["session_id"] == interrupted for record in records) == 1
        assert task_no_longer_running(), "Recovery must not automatically rerun the interrupted task"
        call("shutdown")
        owner.wait(timeout=10)
        assert owner.returncode == 0
        print(json.dumps({"background_rpc": "passed", "session": session, "same_task_pid_after_client_disconnect": True,
                          "exclusive_owner": True,"explicit_input_takeover":True, "idempotent_start": True, "stop_and_shutdown": True, "crash_marks_interrupted_without_rerun": True,
                          "desktop_quit_reopen": "not covered by this smoke"}))
    finally:
        if desktop is not None:
            if desktop.poll() is None:
                desktop.terminate()
                try:
                    desktop.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    desktop.kill()
                    desktop.wait(timeout=5)
            desktop.stderr.close()
        if owner.poll() is None:
            if confirmed and descriptor:
                try:
                    if session in owned_sessions:
                        call("stop_session", {"session_id": session})
                    call("shutdown")
                    owner.wait(timeout=10)
                except (OSError, ValueError, AssertionError, subprocess.TimeoutExpired):
                    owner.terminate()
            else:
                owner.terminate()
            try:
                owner.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=5)
        owner.stderr.close()


if __name__ == "__main__":
    main()
