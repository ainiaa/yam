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
import argparse
import importlib.util
import secrets

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE_TIMEOUT_SECONDS = 300
SWIFT = r'''import AppKit
import WebKit
class Probe: NSObject, WKScriptMessageHandler {
 var view: WKWebView!
 var window:NSWindow!
 func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
  if let text=message.body as? String { try! text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8) }
 }
 func start() {
  let config=WKWebViewConfiguration();config.userContentController.add(self,name:"result")
  view=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:600),configuration:config)
  window=NSWindow(contentRect:view.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false)
  window.title="YAM isolated renderer module";window.contentView=view;window.makeKeyAndOrderFront(nil)
  let file=URL(fileURLWithPath:CommandLine.arguments[1]);view.loadFileURL(file,allowingReadAccessTo:file.deletingLastPathComponent())
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.regular)
let probe=Probe();probe.start();app.finishLaunching();app.activate(ignoringOtherApps:true)
DispatchQueue.main.asyncAfter(deadline:.now()+300){exit(3)};app.run()
'''
JS = r'''
(async()=>{try{
 const pool=new TerminalViews(16),times=[];
 async function select(f,sequence=null){
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
  if(sequence!==null)times.push({mode:release?'ended-cold-module':'warm-module',sequence,elapsed_ms:performance.now()-started});
 }
 for(const f of fixtures)await select(f);
 for(let sequence=0;sequence<100;sequence++)await select(fixtures[sequence%fixtures.length],sequence);
 await new Promise(r=>setTimeout(r,2000));
 window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:true,retained:pool.size,selections:times.length,raw_switches:times,measurement:'native-WebKit-TerminalViews-module',clock:'performance.now:same-document',boundary:'verified-frame-write-callback',experiment:release?'forced release of static synthetic ended scenes; not live/App behavior':null}));
}catch(error){window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:false,error:String(error)}))}})();
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    parser.add_argument('--rounds',type=int,default=3)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    identifier='com.yam.renderer-memory-validation-t06-'+secrets.token_hex(8)
    spec=importlib.util.spec_from_file_location('renderer_latency',pathlib.Path(__file__).with_name('terminal-latency-probe.py'))
    latency=importlib.util.module_from_spec(spec);spec.loader.exec_module(latency)
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
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier,'CFBundleExecutable':'probe','CFBundlePackageType':'APPL','LSUIElement':False}))
        shutil.copyfile(deps / '@xterm/xterm/lib/xterm.js', root / 'xterm.js')
        shutil.copyfile(deps / '@xterm/xterm/css/xterm.css', root / 'xterm.css')
        for run in range(args.rounds*2):
            release=bool(run%2)
            html = root / 'index.html'; receipt = root / 'result.json'
            receipt=root/f'result-{run}.json'
            html.write_text('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><style>.xterm{position:absolute;inset:0}</style><body><script src="xterm.js"></script><script>'+pool+'\nconst release='+str(release).lower()+';const fixtures='+fixtures+';'+JS+'</script>')
            subprocess.run(['open','-n',str(app),'--args',str(html),str(receipt)],check=True)
            pid = None
            try:
                for _ in range(PROBE_TIMEOUT_SECONDS * 10):
                    apps = subprocess.check_output(['lsappinfo','list'],text=True)
                    block = next((b for b in re.split(r'(?m)(?=^\s*\d+\))', apps) if 'bundleID="'+identifier+'"' in b), '')
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
                    block = next(b for b in re.split(r'(?m)(?=^\s*\d+\))', apps) if 'bundleID="'+identifier+'"' in b)
                    members = re.search(r'coalition:\s*\d+\s*\{([^}]+)\}',block)
                    assert members, 'Explicit WebKit coalition required'
                    total = 0
                    for member in map(int,members[1].split()):
                        buf = ctypes.create_string_buffer(256)
                        assert lib.proc_pid_rusage(member,2,ctypes.byref(buf)) == 0
                        total += ctypes.c_uint64.from_buffer(buf,72).value
                    samples.append(total)
                    time.sleep(1)
                value.update(release_experiment=release,footprint_bytes=samples,round=run//2+1,
                             cols=100,rows=40,scrollback=2000,
                             terminal_views_sha256=latency.performance.digest(ROOT/'apps/desktop/src/terminal-views.ts'),
                             terminal_service_sha256=latency.performance.digest(ROOT/'apps/desktop/terminal-service.cjs'))
                latency.performance.write_evidence(args.output/f'round-{run//2+1}-{"cold-experiment" if release else "warm"}.json',value)
                results.append(value)
            finally:
                if pid:
                    try: os.kill(pid,signal.SIGTERM)
                    except ProcessLookupError: pass
                    time.sleep(.5)
    for index in range(args.rounds):
        summary=latency.validate_switches(results[index*2]['raw_switches']+results[index*2+1]['raw_switches'])
        latency.performance.write_evidence(args.output/f'round-{index+1}-summary.json',summary)
        print(json.dumps({'round':index+1,'scope':'native-WebKit-TerminalViews-module',
                          'warm_p95_ms':summary['warm-module']['p95_ms'],
                          'cold_experiment_p95_ms':summary['ended-cold-module']['p95_ms']}),flush=True)


if __name__ == '__main__':
    main()
