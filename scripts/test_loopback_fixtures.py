"""Author: Jeff.Liu. Loopback fixture binding must not consult host DNS."""
import contextlib
import importlib.util
import io
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
