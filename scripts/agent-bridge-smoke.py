"""Exercise the compiled non-UI helper without CLI trust or global configuration.
Author: Jeff.Liu
"""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time

binary = Path(sys.argv[1]).resolve()
token = secrets.token_hex(32)
received = []
with tempfile.TemporaryDirectory(prefix="yam-helper-") as directory:
    callback = Path(directory) / "callback.py"
    forwarded = Path(directory) / "forwarded.json"
    callback.write_text("import pathlib, sys\npathlib.Path(sys.argv[1]).write_text(sys.argv[2])\n")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(3)
        env = dict(os.environ, YAM_AGENT_ADDRESS=f"127.0.0.1:{listener.getsockname()[1]}",
                   YAM_AGENT_TOKEN=token, YAM_PREVIOUS_NOTIFY=json.dumps([sys.executable, str(callback), str(forwarded)]))
        def receive():
            for _ in range(5):
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(1)
                    data = b""
                    while chunk := connection.recv(4096):
                        data += chunk
                    value = json.loads(data)
                    received.append(value)
                    connection.sendall(json.dumps({"accepted": value["token"] == token}).encode())
        worker = threading.Thread(target=receive)
        worker.start()
        payload = {"hook_event_name": "SessionStart", "session_id": "main", "private": "do not send"}
        result = subprocess.run([str(binary), "--yam-agent-hook"], input=json.dumps(payload), env=env,
                                text=True, capture_output=True, timeout=2)
        assert result.returncode == 0 and json.loads(result.stdout) == {}
        assert not result.stderr
        raw = json.dumps({"type": "agent-turn-complete", "thread-id": "main", "turn-id": "one",
                          "last-assistant-message": "literal $(x) quotes ' 中文"}, ensure_ascii=False)
        result = subprocess.run([str(binary), "--yam-agent-notify", raw], env=env,
                                text=True, capture_output=True, timeout=2)
        assert result.returncode == 0 and result.stdout == "" and not result.stderr
        wrong = dict(env, YAM_AGENT_TOKEN=secrets.token_hex(32))
        result = subprocess.run([str(binary), "--yam-agent-hook"], input=json.dumps(payload), env=wrong,
                                text=True, capture_output=True, timeout=2)
        assert result.returncode == 0 and json.loads(result.stdout) == {} and "degraded" in result.stderr
        missing_callback = dict(env)
        missing_callback.pop("YAM_PREVIOUS_NOTIFY")
        for failed_env in [missing_callback, dict(env, YAM_PREVIOUS_NOTIFY=json.dumps([str(Path(directory)/"missing-callback")]))]:
            result = subprocess.run([str(binary), "--yam-agent-notify", raw], env=failed_env,
                                    text=True, capture_output=True, timeout=2)
            assert result.returncode == 0 and result.stdout == "" and "degraded" in result.stderr
        worker.join(timeout=3)
        assert not worker.is_alive()
        assert [value["event"]["kind"] for value in received] == ["SessionStart", "TurnComplete", "SessionStart", "TurnComplete", "TurnComplete"]
        assert all(set(value["event"]) == {"kind", "agent_session_id", "turn_id"} for value in received)
    # The original callback still runs when YAM's bridge is unavailable.
    forwarded.unlink(missing_ok=True)
    result = subprocess.run([str(binary), "--yam-agent-notify", raw], env=env,
                            text=True, capture_output=True, timeout=2)
    assert result.returncode == 0 and "degraded" in result.stderr
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if forwarded.exists() and forwarded.read_text() == raw:
            break
        time.sleep(0.01)
    assert forwarded.read_text() == raw
print("Compiled helper: authenticated events, bounded failure, literal callback and disconnected forwarding PASS")
