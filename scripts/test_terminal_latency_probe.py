"""Author: Jeff.Liu. Raw native-module latency evidence must not claim App input."""
import copy
import json
import importlib.util
import pathlib
import types
import unittest
import os
import select
import subprocess
import sys
import time

path = pathlib.Path(__file__).with_name("terminal-latency-probe.py")
if path.exists():
    spec = importlib.util.spec_from_file_location("terminal_latency_probe", path)
    probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
else:
    probe = types.SimpleNamespace()


def result():
    return {"schema_version": 1, "measurement": "pty-visible-webkit-module",
            "versions": {"xterm": "6.0.0", "serialize": "0.14.0"},
            "cols": 100, "rows": 40, "output_queue_bytes": None,
            "clock": "performance.now:same-document", "boundary": "production-frame-marker-then-two-rAF",
            "raw": [{"sequence": n, "submitted_ns": n * 1000000,
                     "visible_ns": n * 1000000 + (n + 1) * 1000} for n in range(100)]}


class LatencyTests(unittest.TestCase):
    def api(self, name):
        function = getattr(probe, name, None)
        self.assertTrue(callable(function), "T06 latency API is missing: " + name)
        return function

    def test_t06_raw_visible_receipts_have_nearest_rank_p50_p95_without_rounding(self):
        summarize = self.api("validate_probe")
        value = result(); summary = summarize(value)
        self.assertEqual(summary["measurement"], "pty-visible-webkit-module")
        self.assertEqual(summary["raw"], value["raw"])
        self.assertAlmostEqual(summary["p50_ms"], .050)
        self.assertAlmostEqual(summary["p95_ms"], .095)
        self.assertIsNone(summary["output_queue_bytes"])

    def test_t06_empty_partial_and_duplicate_visible_receipts_are_rejected(self):
        validate = self.api("validate_probe")
        for raw in [[], result()["raw"][:99], [result()["raw"][0]] * 100]:
            value = result(); value["raw"] = raw
            with self.subTest(size=len(raw)), self.assertRaises(ValueError): validate(value)

    def test_t06_latency_rejects_nan_negative_and_missing_visible_timestamp(self):
        validate = self.api("validate_probe")
        for value in [float("nan"), -1, None]:
            broken = result(); broken["raw"][0]["visible_ns"] = value
            with self.subTest(value=value), self.assertRaises(ValueError): validate(broken)
        broken = result(); del broken["raw"][0]["submitted_ns"]
        with self.assertRaises(ValueError): validate(broken)

    def test_t06_version_and_fixed_terminal_dimensions_are_enforced(self):
        validate = self.api("validate_probe")
        for key, value in [("schema_version", 2), ("cols", 80), ("rows", 24),
                           ("versions", {"xterm": "next", "serialize": "0.14.0"})]:
            broken = {**result(), key: value}
            with self.subTest(key=key), self.assertRaises(ValueError): validate(broken)

    def test_t06_rpc_and_static_frame_completion_cannot_be_labeled_visible_app_input(self):
        validate = self.api("validate_probe")
        for measurement in ["app-native-keyboard", "rpc-frame-as-app-input", "headless-visible-input"]:
            with self.subTest(measurement=measurement), self.assertRaises(ValueError):
                validate({**result(), "measurement": measurement})

    def test_t06_synthetic_probe_bytes_cannot_be_reported_as_production_output_queue(self):
        validate = self.api("validate_probe")
        with self.assertRaises(ValueError): validate({**result(), "output_queue_bytes": 123})

    def test_t06_latency_requires_one_clock_and_production_marker_render_boundary(self):
        validate = self.api("validate_probe")
        for changes in [{"clock": "python.monotonic-minus-js.performance.now"},
                        {"clock": None}, {"boundary": "rpc-ack"}, {"boundary": "static-frame"}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError): validate({**result(), **changes})

    def test_t06_warm_and_cold_switches_each_require_100_raw_samples(self):
        validate = self.api("validate_switches")
        raw = [{"mode": mode, "elapsed_ms": .25, "sequence": n}
               for mode in ["warm-module", "ended-cold-module"] for n in range(100)]
        summary = validate(raw)
        self.assertEqual(summary["warm-module"]["count"], 100)
        self.assertEqual(summary["ended-cold-module"]["count"], 100)
        with self.assertRaises(ValueError): validate(raw[:-1])

    @unittest.skipUnless(sys.platform == "darwin", "T06 native PTY fixture")
    def test_t06_large_paste_marker_survives_actual_production_alternate_projection(self):
        self.assertTrue(hasattr(probe, "ECHO"))
        import pty
        master, slave = pty.openpty()
        child = subprocess.Popen([sys.executable, "-c", probe.ECHO], stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = bytearray(); deadline = time.monotonic() + 5
        try:
            while b"READY_T06" not in output and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]: output.extend(os.read(master, 65536))
            self.assertIn(b"READY_T06", output)
            payload = b"T06_INPUT_000 " + b"x" * 32768 + b"\n"
            sent = 0
            while sent < len(payload): sent += os.write(master, payload[sent:])
            while time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]: output.extend(os.read(master, 65536))
                elif len(output) >= len(payload): break
            script = "const {Terminal}=require(process.argv[1]+'/@xterm/headless');const {SerializeAddon}=require(process.argv[1]+'/@xterm/addon-serialize');const {projection}=require(process.argv[2]+'/apps/desktop/terminal-service.cjs');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>{const t=new Terminal({cols:100,rows:40,scrollback:2000,allowProposedApi:true}),a=new SerializeAddon();t.loadAddon(a);t.write(data,()=>{console.log(JSON.stringify({marker:projection(t,a).data.includes('T06_ECHO_000'),buffer:t.buffer.active.type}));t.dispose()})});"
            root = pathlib.Path(__file__).resolve().parents[1]
            value = json.loads(subprocess.check_output(["node", "-e", script, str(root / "apps/desktop/node_modules"), str(root)], input=bytes(output), timeout=10))
            self.assertEqual(value["buffer"], "alternate")
            self.assertTrue(value["marker"], "full 32768-byte paste must finish before a visible acknowledgment marker")
        finally:
            child.terminate(); child.wait(timeout=5); os.close(master)

    def test_t06_renderer_budget_covers_100_cold_restores_without_relaxing_per_switch_target(self):
        renderer_path = pathlib.Path(__file__).with_name("terminal-renderer-memory.py")
        spec = importlib.util.spec_from_file_location("renderer_budget", renderer_path)
        renderer = importlib.util.module_from_spec(spec); spec.loader.exec_module(renderer)
        self.assertGreaterEqual(getattr(renderer, "PROBE_TIMEOUT_SECONDS", 0), 250)


if __name__ == "__main__": unittest.main()
