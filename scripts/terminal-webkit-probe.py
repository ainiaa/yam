#!/usr/bin/env python3
"""Author: Jeff.Liu. Native WebKit comparison using only isolated synthetic terminal fixtures."""
import argparse,json,pathlib,shutil,subprocess,tempfile,sys

SWIFT = 'import AppKit\nimport WebKit\nclass Probe: NSObject, WKScriptMessageHandler, WKNavigationDelegate {\n var view: WKWebView!; var window: NSWindow!\n func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {\n  guard let text=message.body as? String else { exit(2) }; print(text); fflush(stdout); let result = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]; exit(result?["passed"] as? Bool == true ? 0 : 1)\n }\n func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("navigation failed"); exit(2) }\n func start() {\n  let config=WKWebViewConfiguration();config.userContentController.add(self,name:"result")\n  view=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:600),configuration:config);view.navigationDelegate=self\n  window=NSWindow(contentRect:view.frame,styleMask:[.titled],backing:.buffered,defer:false);window.contentView=view;window.title="YAM isolated terminal probe";window.orderFront(nil)\n  let file=URL(fileURLWithPath:CommandLine.arguments[1]);view.loadFileURL(file,allowingReadAccessTo:file.deletingLastPathComponent())\n  DispatchQueue.main.asyncAfter(deadline:.now()+30){print("timeout");exit(2)}\n }\n}\nlet app=NSApplication.shared;app.setActivationPolicy(.accessory);let probe=Probe();probe.start();app.run()\n'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--deps',type=pathlib.Path,required=True);args=parser.parse_args()
    if sys.platform!='darwin':raise RuntimeError('Native WebKit probe requires macOS')
    repo=pathlib.Path(__file__).resolve().parents[1];package=repo/'apps/desktop/node_modules/@xterm/xterm'
    assert json.loads((package/'package.json').read_text())['version']=='6.0.0','Pinned front-end terminal version required'
    probe=repo/'scripts/terminal-state-probe.mjs'
    state=probe.read_text().split('function state(term){',1)[1].split('\nconst cases=',1)[0]
    with tempfile.TemporaryDirectory(prefix='yam-webkit-probe-') as directory:
        root=pathlib.Path(directory);frames=root/'frames.json'
        subprocess.run(['node',str(probe),str(args.deps.resolve()),'--projection','--frames',str(frames)],check=True,capture_output=True)
        shutil.copyfile(package/'lib/xterm.js',root/'xterm.js');shutil.copyfile(package/'css/xterm.css',root/'xterm.css')
        html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><div id="terminal"></div><script src="xterm.js"></script><script>const fixtures='+frames.read_text()+';function state(term){'+state+JS
        (root/'index.html').write_text(html);(root/'probe.swift').write_text(SWIFT)
        subprocess.run(['swiftc',str(root/'probe.swift'),'-o',str(root/'probe')],check=True,capture_output=True,timeout=120)
        result=subprocess.run([str(root/'probe'),str(root/'index.html')],capture_output=True,text=True,timeout=45)
        value=json.loads(result.stdout);assert result.returncode==0 and value['passed'],value
        print(json.dumps(value))

JS = r"""
(async()=>{const results=[];let term;
try{for(const f of fixtures){
 if(term)term.dispose();document.querySelector('#terminal').replaceChildren();
 term=new Terminal({cols:f.cols,rows:f.rows,scrollback:100,allowProposedApi:true});term.open(document.querySelector('#terminal'));
 const started=performance.now();await new Promise(r=>term.write(f.frame,r));
 if(!term._core._inputHandler?._activeBuffer)throw Error('xterm internal contract unavailable');
 term._core._inputHandler._activeBuffer.x=f.cursorX;term.scrollToLine(f.viewport);
 const equivalent=JSON.stringify(state(term))===JSON.stringify(f.expected);
 results.push({case:f.name,equivalent,parse_ms:performance.now()-started});
}
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const screen=document.querySelector('.xterm-screen').getBoundingClientRect();
 window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:results.every(r=>r.equivalent)&&screen.width>0&&screen.height>0,results,screen:[screen.width,screen.height]}));
}catch(error){window.webkit.messageHandlers.result.postMessage(JSON.stringify({passed:false,error:String(error)}));}
})();</script>
"""
if __name__=='__main__':main()
