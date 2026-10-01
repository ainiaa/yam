#!/usr/bin/env python3
"""Author: Jeff.Liu. Isolated packaging check; never modifies product dependencies."""
import argparse,json,os,pathlib,subprocess,tempfile

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--runtime',type=pathlib.Path,required=True)
    parser.add_argument('--deps',type=pathlib.Path,required=True)
    args=parser.parse_args()
    runtime=args.runtime.resolve();modules=args.deps.resolve()/'node_modules'
    sources=[]
    for name,path in [('headless','@xterm/headless/lib-headless/xterm-headless.js'),('serializer','@xterm/addon-serialize/lib/addon-serialize.js')]:
        # A trailing source-map line comment must not swallow the wrapper closure.
        source=(modules/path).read_text()
        sources.append(f'const {name}=(()=>{{const module={{exports:{{}}}};const exports=module.exports;\n{source}\nreturn module.exports;}})();\n')
    entry=''.join(sources)+"""
const term=new headless.Terminal({cols:20,rows:8,allowProposedApi:true});
const addon=new serializer.SerializeAddon();term.loadAddon(addon);
const reader=require('node:readline').createInterface({input:process.stdin});let queue=Promise.resolve();
reader.on('line',line=>{queue=queue.then(()=>new Promise(resolve=>{
 const request=JSON.parse(line);term.write(request.data,()=>{
  console.log(JSON.stringify({snapshot:addon.serialize(),cols:term.cols,rows:term.rows}));resolve();
 });
}));});reader.on('close',()=>queue.then(()=>term.dispose()));
"""
    with tempfile.TemporaryDirectory(prefix='yam-sea-probe-') as directory:
        root=pathlib.Path(directory);mainfile=root/'entry.cjs';mainfile.write_text(entry)
        subprocess.run([str(runtime),'--check',str(mainfile)],check=True,capture_output=True)
        binary=root/'yam-terminal-probe';config=root/'sea.json'
        config.write_text(json.dumps({'main':str(mainfile),'output':str(binary),'disableExperimentalSEAWarning':True,'useCodeCache':False,'useSnapshot':False,'execArgvExtension':'none'}))
        subprocess.run([str(runtime),'--build-sea',str(config)],cwd=root,check=True,capture_output=True)
        if os.uname().sysname!='Darwin':raise RuntimeError('This packaging probe verifies the macOS runtime only')
        subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(binary)],check=True,capture_output=True)
        lines=''.join(json.dumps({'data':value})+'\n' for value in ['中文 😀\r\n\x1b[31','mRED'])
        result=subprocess.run([str(binary)],input=lines,text=True,capture_output=True,env={'PATH':'/usr/bin:/bin'},check=True)
        frames=[json.loads(line) for line in result.stdout.splitlines()]
        assert len(frames)==2 and '中文 😀' in frames[-1]['snapshot'] and 'RED' in frames[-1]['snapshot']
        assert frames[-1]['cols']==20 and frames[-1]['rows']==8
        libraries=subprocess.check_output(['/usr/bin/otool','-L',str(binary)],text=True).splitlines()[1:]
        assert all(line.strip().startswith(('/usr/lib/','/System/Library/')) for line in libraries)
        print(json.dumps({'macos_standalone':True,'unicode_split_csi':True,'binary_bytes':binary.stat().st_size,'library_count':len(libraries)}))

if __name__=='__main__':main()
