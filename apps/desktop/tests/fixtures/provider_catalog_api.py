"""Author: Jeff.Liu. Fixed loopback catalog fixture; never forwards requests."""
import argparse
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer
import json
from pathlib import Path
import time


def serve(mode, receipt):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            with receipt.open("a") as output:
                output.write(json.dumps({"method": "GET", "path": self.path, "auth_present": bool(self.headers.get("Authorization"))}) + "\n")
            if mode == "slow":
                time.sleep(4)
            status = int(mode) if mode.isdecimal() else 302 if mode == "redirect" else 200
            body = json.dumps({"name": "magpie", "version": "0.1.fixture"}).encode()
            if mode.startswith("models"):
                models = [{"id": "provider/model-1", "display_name": "Model one", "owned_by": "fixture", "private": "secret"}, {"id": "provider/model-2"}]
                if mode == "models-empty":
                    models = []
                if mode == "models-duplicate":
                    models[1]["id"] = models[0]["id"]
                if mode == "models-invalid":
                    models[1]["id"] = "bad model"
                if mode == "models-too-many":
                    models = [{"id": f"model-{i}"} for i in range(1001)]
                if mode == "models-invalid-label":
                    models[1]["display_name"] = "bad\nlabel"
                body = json.dumps({"object": "other" if mode == "models-bad-shape" else "list", "data": models, "has_more": mode == "models-more"}).encode()
            if mode == "bad":
                body = b'{"name":'
            if mode == "unrecognized":
                body = b'{"name":"other","version":"not-magpie"}'
            if mode == "unsafe-version":
                body = b'{"name":"magpie","version":"<script>secret</script>"}'
            if mode in ("large", "large-unknown"):
                body = b"x" * (2 * 1024 * 1024)
            self.send_response(status)
            if mode == "redirect":
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/sink")
            self.send_header("Content-Type", "application/json")
            if mode != "large-unknown":
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            with receipt.open("a") as output:
                output.write(json.dumps({"method": "POST", "path": self.path}) + "\n")
            self.send_error(405)

    with ThreadingTCPServer(("127.0.0.1", 0), Handler) as server:
        server.daemon_threads = True
        print(json.dumps({"endpoint": f"http://127.0.0.1:{server.server_address[1]}/v1"}), flush=True)
        server.serve_forever()



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="identity")
    parser.add_argument("--receipts", type=Path, required=True)
    options = parser.parse_args()
    serve(options.mode, options.receipts)
