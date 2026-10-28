#!/usr/bin/env python3
"""Author: Jeff.Liu. Render the built frontend in native WebKit with fixture IPC.

This checks real browser timer semantics and React startup, not native IPC.
The headless view has fixture visibility; no user window is controlled.
"""
import functools
import http.server
import pathlib
import platform
import socketserver
import subprocess
import tempfile
import threading

SWIFT = r'''import AppKit
import WebKit
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let view = WKWebView(frame:NSRect(x:0,y:0,width:1180,height:760), configuration:configuration)
let bootstrap = """
Object.defineProperty(document,'visibilityState',{get:()=>'visible'});window.__YAM_DESKTOP_EPOCH__=1;window.__yamDelayMs=0;window.__yamPending=0;window.__yamErrors=[];window.addEventListener('error',e=>window.__yamErrors.push(e.message));
const fixtureReply=(command)=>command==='desktop_window_bootstrap'?{slot:'main',epoch:1,main_epoch:1,owned_ids:[],conflict:false,restore_blocked:false,requested_session:null}:command==='list_session_summaries'||command==='list_unread_receipts'?{revision:'fixture-1',items:[],next_cursor:null}:command==='history_overview'?{total:0,active:0,unread_receipts:0,failed_receipts:0,attention_sessions:0,metadata_bytes:0}:command==='list_pending_notifications'?{items:[],next_key:null}:command==='memory_usage'?{application_bytes:104857600,workload_bytes:52428800,metric:'physical footprint',sampled_at:Date.now()}:command==='health_check'?{app:'YAM',version:'test',platform:'macos',architecture:'arm64',status:'ready'}:command==='get_notification_pause_state'?{paused:false,revision:0,owner_instance:'a'.repeat(64),established:true}:command==='query_terminal_move'?{status:'stale'}:command==='plugin:event|listen'?1:command==='list_sessions'||command==='list_adapters'?[]:null;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={metadata:{currentWebview:{label:'main'},currentWindow:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:(command)=>new Promise(resolve=>{window.__yamPending++;setTimeout(()=>{resolve(fixtureReply(command));window.__yamPending--;},window.__yamDelayMs);})};
"""
view.configuration.userContentController.addUserScript(WKUserScript(source:bootstrap,injectionTime:.atDocumentStart,forMainFrameOnly:true))
view.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
var lastDiagnostic="No JavaScript snapshot"
func check() {
 view.evaluateJavaScript("JSON.stringify({text:document.body.innerText,memory:document.querySelector('.memory-usage')?.textContent,diagnostics:!!document.querySelector('.diagnostics-details'),pending:window.__yamPending,errors:window.__yamErrors.concat(Array.from(document.querySelectorAll('.error-banner')).map(node=>node.textContent))})") { result,error in
  if let text=result as? String { lastDiagnostic=text }
  if let text=result as? String,let data=text.data(using:.utf8),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],value["diagnostics"] as? Bool == true {
   if (value["errors"] as? [String])?.isEmpty == false { print(text); exit(1) }
   if value["pending"] as? Int == 0, (value["memory"] as? String)?.contains("YAM 100.0 MiB") == true { print(text); exit(0) }
  }
  if let error=error {print(error)}
  DispatchQueue.main.asyncAfter(deadline:.now()+0.2,execute:check)
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+1,execute:check)
RunLoop.main.run(until:Date(timeIntervalSinceNow:15))
print("Native rendered diagnostics or memory sample did not appear: " + lastDiagnostic)
exit(2)
'''


def main(dist=None):
    if platform.system() != "Darwin":
        raise SystemExit("Native WebKit smoke requires macOS")
    dist = pathlib.Path(dist) if dist is not None else pathlib.Path(__file__).resolve().parent.parent / "apps/desktop/dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("Build the frontend before native WebKit smoke")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = socketserver.ThreadingTCPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=str(dist))
    )
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="yam-webkit-smoke-") as folder:
            script = pathlib.Path(folder) / "render.swift"
            script.write_text(SWIFT, encoding="utf-8")
            binary = pathlib.Path(folder) / "render"
            subprocess.run(["/usr/bin/swiftc", str(script), "-o", str(binary)], check=True, timeout=120)
            subprocess.run(
                [str(binary), f"http://127.0.0.1:{server.server_address[1]}/"],
                check=True, timeout=30,
            )
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=pathlib.Path, help="explicit built frontend directory")
    main(parser.parse_args().dist)
