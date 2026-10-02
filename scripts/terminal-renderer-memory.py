#!/usr/bin/env python3
"""Author: Jeff.Liu. Compare isolated WebKit renderer retention with real xterm frames."""
import ctypes
import json
import os
import pathlib
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
SWIFT = r'''import AppKit
import WebKit
class Probe: NSObject, WKScriptMessageHandler {
 var view: WKWebView!
 func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
  if let text=message.body as? String { try! text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8) }
 }
 func start() {
  let config=WKWebViewConfiguration();config.userContentController.add(self,name:"result")
  view=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:600),configuration:config)
  let file=URL(fileURLWithPath:CommandLine.arguments[1]);view.loadFileURL(file,allowingReadAccessTo:file.deletingLastPathComponent())
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory)
let probe=Probe();probe.start();RunLoop.main.run(until:Date(timeIntervalSinceNow:90))
'''
JS = r'''
(async()=>{try{
 const pool=new TerminalViews(16),times=[];
 async function select(f){
  const started=performance.now();
  const existing=pool.get(f.id);
  const term=pool.open(f.id,false,()=>{
   const element=document.createElement('div');document.body.append(element);
   const t=new Terminal({cols:f.cols,rows:f.rows,scrollback:2000,allowProposedApi:true});t.open(element);
   const dispose=t.dispose.bind(t);t.dispose=()=>{dispose();element.remove()};return t;
  });
  for(const other of pool.all)other.element.style.visibility=other===term?'visible':'hidden';
  if(!existing){
   term.reset();term.resize(f.cols,f.rows);await new Promise(r=>term.write(f.data,r));
   term._core._inputHandler._activeBuffer.x=f.cursorX;term.scrollToLine(f.viewport);
  }
  const buffer=term.buffer.active;
  const lines=Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString(true));
  if(JSON.stringify(lines)!==JSON.stringify(f.lines)||buffer.type!==f.buffer||buffer.cursorX!==f.cursorX||buffer.cursorY!==f.cursorY||buffer.viewportY!==f.viewport)throw Error('Restored frame mismatch');
  if(release)pool.retain(other=>other===term);
  times.push(performance.now()-started);
 }
 for(const f of fixtures)await select(f);
 await select(fixtures[0]);
 await new Promise(r=>setTimeout(r,2000));
 window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:true,retained:pool.size,selections:times.length,max_selection_ms:Math.max(...times),return_selection_ms:times.at(-1)}));
}catch(error){window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:false,error:String(error)}))}})();
'''


def main():
    lib = ctypes.CDLL('/usr/lib/libproc.dylib')
    deps = ROOT / 'apps/desktop/node_modules'
    node = r'''
const {Terminal}=require(process.argv[1]+'/@xterm/headless');
const {SerializeAddon}=require(process.argv[1]+'/@xterm/addon-serialize');
const {projection}=require(process.argv[2]+'/apps/desktop/terminal-service.cjs');
(async()=>{const frames=[];for(let i=0;i<16;i++){
 const t=new Terminal({cols:100,rows:40,scrollback:2000,allowProposedApi:true});const a=new SerializeAddon();t.loadAddon(a);
 await new Promise(r=>t.write(('session '+i+' 中文😀 '+('x'.repeat(70))+'\r\n').repeat(2000),r));
 if(i%2)await new Promise(r=>t.write('\x1b[?1049hALT中文😀',r));
 const p=projection(t,a);frames.push({id:'s-'+i,...p,cursorY:t.buffer.active.cursorY,lines:Array.from({length:t.buffer.active.length},(_,j)=>t.buffer.active.getLine(j).translateToString(true))});t.dispose();
}console.log(JSON.stringify(frames))})();
'''
    fixtures = subprocess.check_output(['node', '-e', node, str(deps), str(ROOT)], text=True)
    transpile = "const ts=require(process.argv[1]+'/typescript');const fs=require('fs');console.log(ts.transpileModule(fs.readFileSync(process.argv[2],'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText.replace('export class','class'));"
    pool = subprocess.check_output(['node', '-e', transpile, str(deps), str(ROOT / 'apps/desktop/src/terminal-views.ts')], text=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='yam-renderer-memory-') as folder:
        root = pathlib.Path(folder)
        app = root / 'Renderer Memory.app'
        exe = app / 'Contents/MacOS/probe'
        exe.parent.mkdir(parents=True)
        swift = root / 'probe.swift'; swift.write_text(SWIFT)
        subprocess.run(['swiftc', str(swift), '-o', str(exe)], check=True, timeout=120)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'com.yam.renderer-memory-validation','CFBundleExecutable':'probe','CFBundlePackageType':'APPL','LSUIElement':True}))
        shutil.copyfile(deps / '@xterm/xterm/lib/xterm.js', root / 'xterm.js')
        shutil.copyfile(deps / '@xterm/xterm/css/xterm.css', root / 'xterm.css')
        for release in [False, True]:
            html = root / 'index.html'; receipt = root / 'result.json'
            receipt.unlink(missing_ok=True)
            html.write_text('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><style>.xterm{position:absolute;inset:0}</style><body><script src="xterm.js"></script><script>'+pool+'\nconst release='+str(release).lower()+';const fixtures='+fixtures+';'+JS+'</script>')
            subprocess.run(['open','-n','-g',str(app),'--args',str(html),str(receipt)],check=True)
            pid = None
            try:
                for _ in range(300):
                    apps = subprocess.check_output(['lsappinfo','list'],text=True)
                    block = next((b for b in re.split(r'(?m)(?=^\s*\d+\))', apps) if 'bundleID="com.yam.renderer-memory-validation"' in b), '')
                    match = re.search(r'\bpid = (\d+)',block)
                    if match: pid = int(match[1])
                    if receipt.exists(): break
                    time.sleep(.1)
                assert pid and receipt.exists(), 'Native fixture did not finish'
                value = json.loads(receipt.read_text()); assert value['passed'], value
                assert value['retained'] == (1 if release else 16), value
                samples = []
                for _ in range(3):
                    apps = subprocess.check_output(['lsappinfo','list'],text=True)
                    block = next(b for b in re.split(r'(?m)(?=^\s*\d+\))', apps) if 'bundleID="com.yam.renderer-memory-validation"' in b)
                    members = re.search(r'coalition:\s*\d+\s*\{([^}]+)\}',block)
                    assert members, 'Explicit WebKit coalition required'
                    total = 0
                    for member in map(int,members[1].split()):
                        buf = ctypes.create_string_buffer(256)
                        assert lib.proc_pid_rusage(member,2,ctypes.byref(buf)) == 0
                        total += ctypes.c_uint64.from_buffer(buf,72).value
                    samples.append(total)
                    time.sleep(1)
                value.update(release=release,footprint_MiB=[round(n/1048576,2) for n in samples])
                results.append(value)
            finally:
                if pid:
                    try: os.kill(pid,signal.SIGTERM)
                    except ProcessLookupError: pass
                    time.sleep(.5)
    print(json.dumps(results))
    assert max(results[1]['footprint_MiB']) < min(results[0]['footprint_MiB']), 'No measured footprint benefit'


if __name__ == '__main__':
    main()
