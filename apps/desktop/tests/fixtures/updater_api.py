# Author: Jeff.Liu. Owned loopback HTTPS fixture; never serves an installer.
import argparse
import http.server
import json
from pathlib import Path
import ssl
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--mode", choices=["valid", "changed-bytes", "wrong-version", "no-update", "held"], required=True)
args = parser.parse_args()
certificate = args.root / "certificate.pem"
key = args.root / "tls.key"
subprocess.run([
    "/usr/bin/openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
    "-keyout", str(key), "-out", str(certificate), "-days", "1",
    "-subj", "/CN=localhost",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
fixtures = Path(__file__).resolve().parent


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with (args.root / "requests.jsonl").open("a") as receipt:
            receipt.write(json.dumps({"path": self.path}) + "\n")
        if self.path == "/manifest":
            if args.mode == "no-update":
                self.send_response(204)
                self.end_headers()
                return
            body = json.dumps({
                "version": "7.8.10" if args.mode == "wrong-version" else "7.8.9",
                "notes": "owned fixture",
                "url": f"https://127.0.0.1:{self.server.server_port}/artifact",
                "signature": (fixtures / "updater-artifact.txt.sig").read_text().strip(),
            }).encode()
            content_type = "application/json"
        elif self.path == "/artifact":
            if args.mode == "held":
                time.sleep(10)
            body = (fixtures / "updater-artifact.txt").read_bytes()
            if args.mode == "changed-bytes":
                body += b"changed"
            content_type = "application/octet-stream"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certificate, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
print(json.dumps({"endpoint": f"https://127.0.0.1:{server.server_port}/manifest"}), flush=True)
server.serve_forever()
