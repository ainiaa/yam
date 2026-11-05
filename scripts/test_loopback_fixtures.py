"""Author: Jeff.Liu. Loopback fixture binding must not consult host DNS."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import http.client
import http.server
import subprocess
import sys
import json
import runpy
from pathlib import Path
import socket
import socketserver
import tempfile
import unittest
from unittest import mock

class LoopbackFixtureTests(unittest.TestCase):
    def test_catalog_startup_binds_loopback_without_hostname_resolution(self):
        path = Path(__file__).resolve().parents[1] / "apps/desktop/tests/fixtures/provider_catalog_api.py"
        spec = importlib.util.spec_from_file_location("catalog_fixture", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(socket, "getfqdn", side_effect=AssertionError("DNS forbidden")), mock.patch.object(socketserver.BaseServer, "serve_forever"), contextlib.redirect_stdout(output):
            module.serve("identity", Path(directory) / "receipts.jsonl")
        self.assertRegex(json.loads(output.getvalue())["endpoint"], r"^http://127\.0\.0\.1:\d+/v1$")

    def test_catalog_redirect_returns_a_real_local_302(self):
        fixture = Path(__file__).resolve().parents[1] / "apps/desktop/tests/fixtures/provider_catalog_api.py"
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen([sys.executable, str(fixture), "--mode", "redirect", "--receipts", str(Path(directory) / "receipts.jsonl")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                endpoint = json.loads(process.stdout.readline())["endpoint"]
                connection = http.client.HTTPConnection(endpoint.removeprefix("http://").removesuffix("/v1"), timeout=3)
                try:
                    connection.request("GET", "/v1/models")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 302)
                    self.assertEqual(response.getheader("Location"), endpoint.removesuffix("/v1") + "/sink")
                    response.read()
                finally:
                    connection.close()
            finally:
                process.terminate()
                process.communicate(timeout=5)

    def test_updater_https_startup_never_resolves_loopback_hostnames(self):
        fixture = Path(__file__).resolve().parents[1] / "apps/desktop/tests/fixtures/updater_api.py"
        for mode in ["valid", "changed-bytes", "wrong-version", "no-update", "held"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                output = io.StringIO()
                with mock.patch.object(sys, "argv", [str(fixture), "--root", directory, "--mode", mode]), mock.patch.object(socket, "getfqdn", side_effect=AssertionError("DNS forbidden")), mock.patch.object(socket, "gethostbyaddr", side_effect=AssertionError("reverse DNS forbidden")), mock.patch.object(socketserver.BaseServer, "serve_forever") as serve, contextlib.redirect_stdout(output):
                    namespace = runpy.run_path(str(fixture), run_name="__main__")
                    try:
                        self.assertRegex(json.loads(output.getvalue())["endpoint"], r"^https://127\.0\.0\.1:[1-9]\d*/manifest$")
                        self.assertTrue(namespace["server"].daemon_threads)
                        serve.assert_called_once_with()
                    finally:
                        namespace["server"].server_close()

    def test_provider_startup_and_http_responses_do_not_resolve_hostnames(self):
        path = Path(__file__).resolve().parents[1] / "apps/desktop/tests/fixtures/provider_api.py"
        spec = importlib.util.spec_from_file_location("provider_fixture", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = io.StringIO()

        def serve_requests(server):
            self.assertEqual(server.server_address[0], "127.0.0.1")
            self.assertTrue(server.daemon_threads)
            server.timeout = 1
            cases = [
                ("GET", "/v1/models", None, {}, 200),
                ("POST", "/v1/responses", {"input": [{"role": "user", "content": "fixture-token"}], "stream": True}, {}, 200),
                ("POST", "/v1/images/generations", {"prompt": "fixture"}, {}, 200),
                ("POST", "/v1/images/generations", {"prompt": "YAM_IMAGE_ERROR"}, {}, 400),
                ("POST", "/unsupported", {}, {}, 404),
                ("POST", "/v1/responses", None, {"Content-Length": str(8 * 1024 * 1024 + 1)}, 413),
            ]
            with ThreadPoolExecutor(max_workers=1) as worker:
                for method, route, body, headers, status in cases:
                    with self.subTest(route=route, status=status):
                        handled = worker.submit(server.handle_request)
                        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
                        try:
                            connection.request(method, route, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", **headers})
                            response = connection.getresponse()
                            self.assertEqual(response.status, status)
                            payload = response.read()
                            if route == "/v1/models":
                                self.assertEqual(json.loads(payload), {"data": [], "models": []})
                            elif route == "/v1/responses" and status == 200:
                                self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
                                self.assertIn(b"event: response.completed", payload)
                                self.assertIn(b"fixture-token", payload)
                            elif status == 200:
                                self.assertTrue(json.loads(payload)["data"][0]["b64_json"])
                            elif status == 400:
                                self.assertEqual(json.loads(payload)["error"]["code"], "fixture_refusal")
                        finally:
                            connection.close()
                            handled.result(timeout=3)

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(socket, "getfqdn", side_effect=AssertionError("DNS forbidden")), mock.patch.object(socket, "gethostbyaddr", side_effect=AssertionError("reverse DNS forbidden")), mock.patch.object(socketserver.BaseServer, "serve_forever", autospec=True, side_effect=serve_requests), contextlib.redirect_stdout(output):
            module.serve("fixture-token", Path(directory) / "receipts.jsonl")
        self.assertRegex(json.loads(output.getvalue())["base_url"], r"^http://127\.0\.0\.1:[1-9]\d*$")

    def test_terminal_probe_http_binding_needs_neither_dns_nor_gui(self):
        path = Path(__file__).with_name("terminal-latency-probe.py")
        spec = importlib.util.spec_from_file_location("latency_fixture", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with mock.patch.object(socket, "getfqdn", side_effect=AssertionError("DNS forbidden")), mock.patch.object(socket, "gethostbyaddr", side_effect=AssertionError("reverse DNS forbidden")), mock.patch.object(subprocess, "run", side_effect=AssertionError("no desktop or compiler launch")), mock.patch.object(subprocess, "Popen", side_effect=AssertionError("no subprocess launch")):
            with module.loopback_server(http.server.BaseHTTPRequestHandler) as server:
                self.assertEqual(server.server_address[0], "127.0.0.1")
                self.assertGreater(server.server_address[1], 0)

    def test_webkit_http_startup_does_not_resolve_hostnames(self):
        path = Path(__file__).with_name("webkit-memory-smoke.py")
        spec = importlib.util.spec_from_file_location("webkit_fixture", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "index.html").write_text("fixture")
            with mock.patch.object(socket, "getfqdn", side_effect=AssertionError("DNS forbidden")), mock.patch.object(socket, "gethostbyaddr", side_effect=AssertionError("reverse DNS forbidden")), mock.patch.object(module.platform, "system", return_value="Darwin"), mock.patch.object(subprocess, "run") as run, mock.patch.object(subprocess, "Popen", side_effect=AssertionError("no subprocess launch")):
                module.main(directory)
            self.assertEqual(run.call_count, 2)
