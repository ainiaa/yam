"""Author: Jeff.Liu. Loopback fixture binding must not consult host DNS."""
import contextlib
import importlib.util
import io
import http.client
import subprocess
import sys
import json
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
