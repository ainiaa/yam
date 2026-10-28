#!/usr/bin/env python3
"""Author: Jeff.Liu. PTY/owner RPC to native WebKit module render opportunity, not App input."""
import argparse
import http.server
import importlib.util
import json
import pathlib
import plistlib
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


performance = load("latency_performance", "terminal-performance.py")
ROOT = pathlib.Path(__file__).resolve().parents[1]


def validate_probe(value):
    if value.get("schema_version") != 1 or value.get("versions") != {"xterm": "6.0.0", "serialize": "0.14.0"} or (value.get("cols"), value.get("rows")) != (100, 40):
        raise ValueError("Unsupported terminal probe contract")
    if value.get("measurement") != "pty-visible-webkit-module" or value.get("clock") != "performance.now:same-document" or value.get("boundary") != "production-frame-marker-then-two-rAF":
        raise ValueError("Mixed clocks or unsupported visibility boundary")
    if value.get("output_queue_bytes") is not None: raise ValueError("Production queue telemetry is unmeasured")
    raw = value.get("raw", [])
    if len(raw) != 100 or sorted(row.get("sequence", -1) for row in raw) != list(range(100)):
        raise ValueError("Incomplete visible receipts")
    latencies = []
    for row in raw:
        try: elapsed = performance.number(row["visible_ns"]) - performance.number(row["submitted_ns"])
        except KeyError as error: raise ValueError("Missing visible timestamp") from error
        if elapsed < 0: raise ValueError("Negative visible latency")
        latencies.append(elapsed / 1e6)
    return {**value, "p50_ms": performance.nearest_rank(latencies, .5),
            "p95_ms": performance.nearest_rank(latencies, .95), "raw_latency_ms": latencies,
            "limitation": "Marker in production projection, xterm write callback, then two rAF paint opportunities; no App keyboard or screen-pixel assertion"}


def validate_switches(raw):
    result = {}
    for mode in ["warm-module", "ended-cold-module"]:
        values = [row for row in raw if row.get("mode") == mode]
        if len(values) != 100 or sorted(row.get("sequence", -1) for row in values) != list(range(100)):
            raise ValueError("Incomplete switch scenario")
        times = [performance.number(row["elapsed_ms"]) for row in values]
        result[mode] = {"count": 100, "p50_ms": performance.nearest_rank(times, .5),
                        "p95_ms": performance.nearest_rank(times, .95), "raw": values}
    if len(raw) != 200: raise ValueError("Unknown switch scenario")
    return result


SWIFT = r'''import AppKit
import WebKit
class Probe:NSObject,WKScriptMessageHandler {
 var window:NSWindow!;var view:WKWebView!
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){
  if let text=m.body as? String {do {try text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8);exit(0)} catch {exit(2)}}
 }
 func start(){
  let c=WKWebViewConfiguration();c.userContentController.add(self,name:"result")
  view=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:780),configuration:c)
  window=NSWindow(contentRect:view.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false)
  window.title="YAM isolated PTY module probe";window.contentView=view;window.makeKeyAndOrderFront(nil)
  view.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.regular)
let probe=Probe();probe.start();app.finishLaunching();app.activate(ignoringOtherApps:true)
func progress(){probe.view.evaluateJavaScript("JSON.stringify({sequence:window.__t06Sequence,stage:window.__t06Stage,visibility:document.visibilityState})"){value,error in
 if let value=value {print("T06 stage \(value) window_visible=\(probe.window.isVisible) app_active=\(app.isActive)");fflush(stdout)}
};DispatchQueue.main.asyncAfter(deadline:.now()+5,execute:progress)}
DispatchQueue.main.asyncAfter(deadline:.now()+5,execute:progress)
DispatchQueue.main.asyncAfter(deadline:.now()+120){exit(3)};app.run()
'''

JS = r'''(async()=>{try{
 window.__t06Stage='initializing';
 const t=new Terminal({cols:100,rows:40,scrollback:2000,allowProposedApi:true});t.open(document.getElementById('terminal'));
 const raw=[];const paint=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 for(let sequence=0;sequence<100;sequence++){
  window.__t06Sequence=sequence;window.__t06Stage='fetch';
  const marker='T06_ECHO_'+String(sequence).padStart(3,'0');
  const inputMarker='T06_INPUT_'+String(sequence).padStart(3,'0');
  const kind=['plain','ANSI-TUI','Unicode-emoji','large-paste'][sequence%4];
  const payload=kind==='large-paste'?'x'.repeat(32768):kind==='Unicode-emoji'?'中文😀':kind==='ANSI-TUI'?'\x1b[31mANSI\x1b[0m':'plain';
  const submitted_ns=performance.now()*1e6;
  const response=await fetch('input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence,data:inputMarker+' '+payload+'\n'})});
  const fetched_ns=performance.now()*1e6;
  window.__t06Stage='write';
  const f=await response.json();if(!response.ok)throw Error('Fixture RPC failed');
  if(!f.data.includes(marker))throw Error('Production projection omitted marker');
  t.reset();t.resize(f.cols,f.rows);await new Promise(r=>t.write(f.data,r));
  if(!Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i).translateToString()).some(s=>s.includes(marker)))throw Error('Rendered terminal buffer omitted marker');
  const write_callback_ns=performance.now()*1e6;
  window.__t06Stage='two-rAF';
  await paint();window.__t06Stage='complete';raw.push({sequence,kind,submitted_ns,fetched_ns,write_callback_ns,visible_ns:performance.now()*1e6,projection_bytes:new TextEncoder().encode(f.data).length});
 }
 window.webkit.messageHandlers.result.postMessage(JSON.stringify({schema_version:1,measurement:'pty-visible-webkit-module',versions:{xterm:'6.0.0',serialize:'0.14.0'},cols:100,rows:40,clock:'performance.now:same-document',boundary:'production-frame-marker-then-two-rAF',output_queue_bytes:null,raw}));
}catch(error){window.webkit.messageHandlers.result.postMessage(JSON.stringify({failed:true,error:String(error)}))}})();'''

ECHO = r'''import sys,tty
tty.setraw(sys.stdin.fileno())
sys.stdout.buffer.write(b"\x1b[?1049h\x1b[2J\x1b[HREADY_T06\r\n");sys.stdout.flush()
for line in sys.stdin.buffer:
 marker=line.split(b" ",1)[0].replace(b"T06_INPUT_",b"T06_ECHO_")
 sys.stdout.buffer.write(b"\x1b[H"+line.rstrip(b"\n")+b"\r\n"+marker+b"\r\n");sys.stdout.flush()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=pathlib.Path, required=True)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=False)
    app = args.app.resolve(); receipt = json.loads(args.receipt.read_text())
    performance.validate_package_receipt(app, receipt)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    identifier = info["CFBundleIdentifier"]
    smoke, memory = load("latency_smoke", "background-smoke.py"), load("latency_memory", "yam-memory.py")
    data_root = pathlib.Path.home() / "Library/Application Support" / identifier
    with tempfile.TemporaryDirectory(prefix="yam-t06-latency-") as temporary:
        folder = pathlib.Path(temporary); swift = folder / "probe.swift"; swift.write_text(SWIFT)
        probe_app = folder / "Latency Module.app"
        probe = probe_app / "Contents/MacOS/probe"; probe.parent.mkdir(parents=True)
        probe_identifier = "com.yam.latency-module-validation-" + secrets.token_hex(8)
        (probe_app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": probe_identifier,
            "CFBundleExecutable": "probe", "CFBundlePackageType": "APPL", "LSUIElement": False}))
        subprocess.run(["swiftc", str(swift), "-o", str(probe)], check=True, timeout=120)
        echo = folder / "echo.py"; echo.write_text(ECHO)
        for round_index in range(args.rounds):
            if data_root.exists(): raise ValueError("Pre-existing validation data")
            data_root.mkdir(mode=0o700); token = secrets.token_hex(32)
            marker_file = data_root / ".t06-owned-latency"; marker_file.write_text(token)
            owner = None; session = None; descriptor = None; request_id = 0; client = secrets.token_hex(32)
            server = None
            def call(command, arguments=None):
                nonlocal request_id
                request_id += 1
                return smoke.rpc(descriptor, client, request_id, command, arguments)
            try:
                owner = subprocess.Popen([str(executable), "--yam-background"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                smoke.wait_until(lambda: (data_root / "background/connection.json").exists(), 20)
                descriptor = memory.read_connection(data_root / "background/connection.json")
                call("set_agent_notification_context", {"selected": None, "paused": True})
                command = " ".join(shlex.quote(str(v)) for v in [pathlib.Path(sys.executable), echo])
                session = call("create_session", {"cwd": str(folder), "command": command})["session_id"]
                call("resize_session", {"session_id": session, "cols": 100, "rows": 40})
                smoke.wait_until(lambda: "READY_T06" in call("read_terminal_frame", {"session_id": session})["projection"]["data"], 10)
                class Handler(http.server.BaseHTTPRequestHandler):
                    def log_message(self, *_): pass
                    def do_GET(self):
                        if not self.path.startswith("/" + token + "/"): self.send_error(404); return
                        name = self.path.rsplit("/", 1)[-1]
                        if name == "xterm.js": data = (ROOT / "apps/desktop/node_modules/@xterm/xterm/lib/xterm.js").read_bytes(); content = "application/javascript"
                        elif name == "xterm.css": data = (ROOT / "apps/desktop/node_modules/@xterm/xterm/css/xterm.css").read_bytes(); content = "text/css"
                        else: data = ('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><div id="terminal"></div><script src="xterm.js"></script><script>' + JS + '</script>').encode(); content = "text/html"
                        self.send_response(200); self.send_header("Content-Type", content); self.end_headers(); self.wfile.write(data)
                    def do_POST(self):
                        if self.path != "/" + token + "/input": self.send_error(404); return
                        size = int(self.headers.get("Content-Length", 0))
                        if not 0 < size <= 65536: self.send_error(400); return
                        value = json.loads(self.rfile.read(size)); sequence = value["sequence"]
                        if type(sequence) is not int or not 0 <= sequence < 100: self.send_error(400); return
                        expected = "T06_ECHO_" + str(sequence).zfill(3)
                        if not isinstance(value["data"], str) or not value["data"].startswith("T06_INPUT_" + str(sequence).zfill(3)): self.send_error(400); return
                        call("write_session", {"session_id": session, "data": value["data"]})
                        def acknowledged_projection():
                            frame = call("read_terminal_frame", {"session_id": session})
                            return frame["projection"] if expected in frame["projection"]["data"] else False
                        frame = smoke.wait_until(acknowledged_projection, 10)
                        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(frame).encode())
                server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                result_path = folder / f"result-{round_index}.json"
                subprocess.run(["open", "-n", str(probe_app), "--args", f"http://127.0.0.1:{server.server_port}/{token}/index.html", str(result_path)], check=True, timeout=10)
                smoke.wait_until(result_path.exists, 130)
                value = json.loads(result_path.read_text())
                performance.write_evidence(args.output / f"round-{round_index + 1}-raw.json", value)
                summary = validate_probe(value)
                summary.update(package_sha256=receipt["package_sha256"], product_source_fingerprint=receipt["product_source_fingerprint"])
                performance.write_evidence(args.output / f"round-{round_index + 1}-summary.json", summary)
                print(json.dumps({"round": round_index + 1, "scope": value["measurement"], "p50_ms": summary["p50_ms"], "p95_ms": summary["p95_ms"]}), flush=True)
                performance.validate_package_receipt(app, receipt)
            finally:
                # Unique temporary bundle identity; never terminate an unrelated app or user task.
                for app_info in memory.parse_apps(memory.run(["lsappinfo", "list"])):
                    if app_info["bundle"] == probe_identifier:
                        import os, signal
                        try: os.kill(app_info["pid"], signal.SIGTERM)
                        except ProcessLookupError: pass
                if server: server.shutdown(); server.server_close()
                if owner and owner.poll() is None:
                    try:
                        if session: performance.cancel_fixture({session}, [session], lambda identity: call("stop_session", {"session_id": identity}))
                        if descriptor: call("shutdown"); owner.wait(timeout=10)
                        else: owner.terminate(); owner.wait(timeout=10)
                    except (OSError, AssertionError, subprocess.TimeoutExpired): owner.kill(); owner.wait(timeout=5)
                if data_root.is_symlink() or marker_file.is_symlink() or marker_file.read_text() != token:
                    raise ValueError("Changed fixture ownership; refusing cleanup")
                shutil.rmtree(data_root)
    return 0


if __name__ == "__main__": raise SystemExit(main())
