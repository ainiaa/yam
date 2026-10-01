#!/usr/bin/env python3
"""Author: Jeff.Liu. Exercise only an explicitly isolated macOS validation bundle."""
import argparse
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


def wait_until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Background acceptance timed out")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--desktop", action="store_true", help="Launch the actual desktop, then exit and reopen it around a live task")
    parser.add_argument("--idle-check",action="store_true",help="Verify a connected idle desktop retains its owner for longer than the 60-second detach timeout")
    args = parser.parse_args()
    assert not args.idle_check or args.desktop
    info = plistlib.loads((args.app / "Contents/Info.plist").read_bytes())
    identifier = info["CFBundleIdentifier"]
    assert identifier.startswith("com.yam.") and "validation" in identifier
    assert info["LSMinimumSystemVersion"] == "13.5"
    executable = args.app / "Contents/MacOS" / info["CFBundleExecutable"]
    root = Path.home() / "Library/Application Support" / identifier
    connection = root / "background/connection.json"
    if connection.exists():
        previous = json.loads(connection.read_text())
        address, port = previous["address"].rsplit(":", 1)
        assert address == "127.0.0.1"
        try:
            stream = socket.create_connection((address, int(port)), timeout=1)
        except OSError:
            pass
        else:
            stream.close()
            raise AssertionError("Existing validation background is active; refusing to replace its descriptor")
        connection.unlink()  # Validation namespace only; never touch production data.
    owner = subprocess.Popen([str(executable)] + ([] if args.desktop else ["--yam-background"]), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    session = None
    descriptor = None
    client = secrets.token_hex(32)
    request_id = 0

    def call(command, arguments=None, *, repeat_id=None, error=False):
        nonlocal request_id
        if repeat_id is None:
            request_id += 1
        wire_id = request_id if repeat_id is None else repeat_id
        address, port = descriptor["address"].rsplit(":", 1)
        assert address == "127.0.0.1"
        wire = json.dumps({"version": 1, "token": descriptor["token"], "instance": descriptor["instance"],
                           "client": client, "id": wire_id, "command": command, "args": arguments or {}}).encode()
        with socket.create_connection((address, int(port)), timeout=5) as stream:
            stream.settimeout(10)
            stream.sendall(struct.pack("!I", len(wire)) + wire)

            def read(length):
                result = bytearray()
                while len(result) < length:
                    chunk = stream.recv(length - len(result))
                    assert chunk, "Background closed connection before response"
                    result.extend(chunk)
                return result

            length = struct.unpack("!I", read(4))[0]
            assert 0 < length <= 64 * 1024 * 1024
            result = json.loads(read(length))
            assert result["instance"] == descriptor["instance"] and result["id"] == wire_id and result["client"] == client
            if error:
                assert isinstance(result["result"].get("Err"),str), "Background unexpectedly accepted an invalid command"
                return result["result"]["Err"]
            assert "Ok" in result["result"], "Background rejected validation command"
            return result["result"]["Ok"]

    try:
        wait_until(lambda: connection.exists() or owner.poll() is not None)
        assert owner.poll() is None, "Background exited during initialization"
        descriptor = json.loads(connection.read_text())
        assert connection.stat().st_mode & 0o777 == 0o600
        assert call("ping")["ready"]
        if args.desktop:
            wait_until(lambda: call("background_status")["desktop_connected"])
            background_pid = call("background_status")["pid"]
            assert background_pid != owner.pid
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
        duplicate = subprocess.run([str(executable), "--yam-background"], capture_output=True, timeout=10)
        assert b"Another background instance" in duplicate.stderr
        assert owner.poll() is None
        os.kill(pid, 0)
        if args.desktop:
            old_instance = descriptor["instance"]
            owner.terminate()  # Real desktop process exits; the task owner must survive.
            owner.wait(timeout=5)
            owner.stderr.close()
            time.sleep(6)
            assert not call("background_status")["desktop_connected"]
            os.kill(pid, 0)
            assert "YAM_QUERY_2=PASSED" in call("read_session_snapshot",{"session_id":session})["data"]
            assert call("read_terminal_frame",{"session_id":session})["projection"]["buffer"] == "alternate"
            assert call("background_status")["pid"] == background_pid
            owner = subprocess.Popen([str(executable)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
            owner.terminate()
            owner.wait(timeout=5)
            owner.stderr.close()
            old_instance=descriptor["instance"]
            owner=subprocess.Popen([str(executable),"--yam-background"],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            wait_until(lambda: connection.exists() and json.loads(connection.read_text())["instance"] != old_instance)
            descriptor=json.loads(connection.read_text());client,request_id=secrets.token_hex(32),0
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
        owner = subprocess.Popen([str(executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        wait_until(lambda: connection.exists() and json.loads(connection.read_text())["instance"] != old_instance)
        descriptor = json.loads(connection.read_text())
        client, request_id = secrets.token_hex(32), 0
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
        if owner.poll() is None:
            if descriptor and session:
                try:
                    call("stop_session", {"session_id": session})
                    call("shutdown")
                    owner.wait(timeout=10)
                except (OSError, AssertionError, subprocess.TimeoutExpired):
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
