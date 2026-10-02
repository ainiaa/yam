#!/usr/bin/env python3
"""Author: Jeff.Liu. Render the built frontend in native WebKit with fixture IPC.

This checks real browser timer semantics and React startup, not native IPC.
The headless view has fixture visibility; no user window is controlled.
"""
import functools
import http.server
import pathlib
import platform
import subprocess
import tempfile
import threading

SWIFT = r'''import AppKit
import WebKit
let app = NSApplication.shared
let view = WKWebView(frame:NSRect(x:0,y:0,width:1180,height:760))
let bootstrap = """
Object.defineProperty(document,'visibilityState',{get:()=>'visible'});window.__yamErrors=[];window.addEventListener('error',e=>window.__yamErrors.push(e.message));
window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:(command)=>Promise.resolve(command==='memory_usage'?{application_bytes:104857600,workload_bytes:52428800,metric:'physical footprint',sampled_at:Date.now()}:command==='health_check'?{app:'YAM',version:'test',platform:'macos',architecture:'arm64',status:'ok'}:command==='list_sessions'||command==='list_adapters'?[]:null)};
"""
view.configuration.userContentController.addUserScript(WKUserScript(source:bootstrap,injectionTime:.atDocumentStart,forMainFrameOnly:true))
view.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
func check() {
 view.evaluateJavaScript("JSON.stringify({memory:document.querySelector('.memory-usage')?.textContent,footer:!!document.querySelector('.statusbar'),errors:window.__yamErrors})") { result,error in
  if let text=result as? String,let data=text.data(using:.utf8),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],value["footer"] as? Bool == true {
   print(text)
   exit((value["memory"] as? String)?.contains("YAM 100.0 MiB") == true && (value["errors"] as? [String])?.isEmpty == true ? 0 : 1)
  }
  if let error=error {print(error)}
  DispatchQueue.main.asyncAfter(deadline:.now()+0.2,execute:check)
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+1,execute:check)
RunLoop.main.run(until:Date(timeIntervalSinceNow:15))
print("Native rendered footer did not appear")
exit(2)
'''


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Native WebKit smoke requires macOS")
    dist = pathlib.Path(__file__).resolve().parent.parent / "apps/desktop/dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("Build the frontend before native WebKit smoke")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=str(dist))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="yam-webkit-smoke-") as folder:
            script = pathlib.Path(folder) / "render.swift"
            script.write_text(SWIFT, encoding="utf-8")
            subprocess.run(
                ["/usr/bin/swift", str(script), f"http://127.0.0.1:{server.server_port}/"],
                check=True, timeout=30,
            )
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
