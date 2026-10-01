#!/usr/bin/env python3
"""Author: Jeff.Liu. Build the pinned standalone terminal runtime from official artifacts."""
import argparse,hashlib,json,os,pathlib,platform,subprocess,tarfile,urllib.request,zipfile
VERSION='26.10.0'

def platform_name(system,machine):
    systems={'Darwin':'darwin','Linux':'linux','Windows':'win'};architectures={'arm64':'arm64','aarch64':'arm64','AMD64':'x64','x86_64':'x64','x64':'x64'}
    if system not in systems or machine not in architectures:raise ValueError('Unsupported terminal runtime platform')
    return systems[system]+'-'+architectures[machine]

def download_verified(target,digest,chunks,limit=200*1024*1024):
    temporary=target.with_suffix('.partial');hasher=hashlib.sha256();length=0;owned=False
    try:
        with temporary.open('xb') as output:
            owned=True
            for data in chunks():
                length+=len(data)
                if length>limit:raise ValueError('Runtime archive exceeds download budget')
                hasher.update(data);output.write(data)
            output.flush();os.fsync(output.fileno())
        if hasher.hexdigest()!=digest:raise ValueError('Runtime archive checksum mismatch')
        temporary.replace(target)
    finally:
        if owned:temporary.unlink(missing_ok=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path);args=parser.parse_args()
    repo=pathlib.Path(__file__).resolve().parents[1];desktop=repo/'apps/desktop'
    root=desktop/'src-tauri/target/terminal-runtime';root.mkdir(parents=True,exist_ok=True)
    native=platform_name(platform.system(),platform.machine());suffix='.zip' if native.startswith('win-') else '.tar.gz'
    name='node-v'+VERSION+'-'+native+suffix
    digest=json.loads(pathlib.Path(__file__).with_name('node-runtime-checksums.json').read_text(encoding='utf-8'))[name]
    archive=root/name
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=digest:
        def chunks():
            with urllib.request.urlopen('https://nodejs.org/dist/v'+VERSION+'/'+name,timeout=30) as response:
                if not response.geturl().startswith('https://nodejs.org/'):raise ValueError('Unexpected runtime download origin')
                while data:=response.read(1024*1024):yield data
        download_verified(archive,digest,chunks)
    folder='node-v'+VERSION+'-'+native;exe='node.exe' if native.startswith('win-') else 'bin/node'
    runtime=root/('node.exe' if native.startswith('win-') else 'node')
    names={folder+'/'+exe:runtime,folder+'/LICENSE':root/'NODE-LICENSE'}
    if suffix=='.zip':
        with zipfile.ZipFile(archive) as bundle:
            for source,destination in names.items():
                with bundle.open(source) as stream:content=stream.read(200*1024*1024+1)
                if len(content)>200*1024*1024:raise ValueError('Runtime member exceeds size budget')
                destination.write_bytes(content)
    else:
        with tarfile.open(archive) as bundle:
            for source,destination in names.items():
                member=bundle.getmember(source)
                if not member.isfile() or member.size>200*1024*1024:raise ValueError('Invalid runtime archive member')
                with bundle.extractfile(member) as stream:destination.write_bytes(stream.read())
    runtime.chmod(0o755)
    env=os.environ.copy()
    for key in ['NODE_OPTIONS','NODE_PATH','NODE_SEA_OPTIONS']:env.pop(key,None)
    assert subprocess.check_output([str(runtime),'--version'],env=env,text=True,encoding='utf-8').strip()=='v'+VERSION
    sources=[];licenses=[(root/'NODE-LICENSE').read_text(encoding='utf-8')]
    for name,package,file,version in [('headless','@xterm/headless','lib-headless/xterm-headless.js','6.0.0'),('serializer','@xterm/addon-serialize','lib/addon-serialize.js','0.14.0')]:
        module=desktop/'node_modules'/package;assert json.loads((module/'package.json').read_text(encoding='utf-8'))['version']==version
        source=(module/file).read_text(encoding='utf-8');sources.append(f'const {name}=(()=>{{const module={{exports:{{}}}};const exports=module.exports;\n{source}\nreturn module.exports;}})();\n')
        licenses.append(package+' '+version+'\n'+(desktop/'terminal-licenses/XTERM-LICENSE').read_text(encoding='utf-8'))
    source=(desktop/'terminal-service.cjs').read_text(encoding='utf-8').replace("require('@xterm/headless')",'headless').replace("require('@xterm/addon-serialize')",'serializer')
    entry=root/'terminal-entry.cjs';entry.write_text(''.join(sources)+source,encoding='utf-8')
    subprocess.run([str(runtime),'--check',str(entry)],env=env,check=True,capture_output=True)
    destination=(args.output or root/('yam-terminal.exe' if native.startswith('win-') else 'yam-terminal')).resolve()
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=destination.with_name(destination.stem+'.building'+destination.suffix)
    config=root/'sea.json';config.write_text(json.dumps({'main':str(entry),'output':str(temporary),'disableExperimentalSEAWarning':True,'useCodeCache':False,'useSnapshot':False,'execArgvExtension':'none'}),encoding='utf-8')
    try:
        subprocess.run([str(runtime),'--build-sea',str(config)],env=env,check=True,capture_output=True,timeout=120)
        if native.startswith('darwin-'):subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(temporary)],check=True,capture_output=True)
        probe_env={**env,'YAM_TERMINAL_INSTANCE':'e'*64};probe_env['PATH']='/usr/bin:/bin' if os.name!='nt' else env.get('PATH','')
        requests=[{'id':1,'op':'create','session':'probe','cols':20,'rows':8},{'id':2,'op':'write','session':'probe','data':'5Lit5paHIPCfmIA='},{'id':3,'op':'snapshot','session':'probe'}]
        result=subprocess.run([str(temporary)],env=probe_env,input=''.join(json.dumps(r)+'\n' for r in requests),text=True,encoding='utf-8',capture_output=True,timeout=10,check=True)
        frames=[json.loads(line) for line in result.stdout.splitlines()];assert len(frames)==4 and all(f.get('ok',True) for f in frames)
        assert '中文 😀' in frames[-1]['data']['data'] and frames[-1]['data']['instance']=='e'*64
        temporary.replace(destination);(root/'THIRD-PARTY-NOTICES.txt').write_text('\n\n'.join(licenses),encoding='utf-8')
        print(json.dumps({'platform':native,'runtime':VERSION,'sha256_verified':True,'standalone_probe':True,'binary_bytes':destination.stat().st_size,'output':str(destination)}))
    finally:temporary.unlink(missing_ok=True)

if __name__=='__main__':main()
