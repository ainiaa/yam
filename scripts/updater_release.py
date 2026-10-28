"""Author: Jeff.Liu. Prepare a GitHub Releases updater manifest; never uploads or publishes."""
import argparse
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[1]
TARGETS={'darwin-aarch64','darwin-x86_64','windows-x86_64','windows-aarch64','linux-x86_64','linux-aarch64'}
def verify_artifact(artifact,version):
 try:
  public_key=json.loads((ROOT/'apps/desktop/src-tauri/tauri.conf.json').read_text())['plugins']['updater']['pubkey']
  result=subprocess.run([shutil.which('node') or 'node',str(Path(__file__).with_name('verify-updater-signature.mjs')),public_key,str(artifact),str(artifact)+'.sig',version],capture_output=True,timeout=30)
 except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as error:raise ValueError('Cannot verify updater artifact with the configured public key') from error
 if result.returncode:raise ValueError('Invalid updater artifact signature, public key or signed version')
def manifest(version,artifacts,notes):
 if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',version):raise ValueError('Expected a stable semantic version without a v prefix')
 if not artifacts or not set(artifacts)<=TARGETS:raise ValueError('Unsupported or empty release targets')
 if len(notes.encode())>8192:raise ValueError('Release notes exceed 8192 bytes')
 platforms={};published={'latest.json','SHA256SUMS'}
 for target,artifact in artifacts.items():
  artifact=Path(artifact)
  if not artifact.is_file() or artifact.stat().st_size==0 or artifact.stat().st_size>256*1024*1024:raise ValueError('Missing or oversized updater artifact')
  if not re.fullmatch(r'[a-zA-Z0-9_.+-]+',artifact.name):raise ValueError('Unsafe artifact filename')
  names={artifact.name,artifact.name+'.sig'}
  if published&names:raise ValueError('Release asset filenames must be unique, including signatures and metadata')
  published.update(names)
  try:
   if Path(str(artifact)+'.sig').stat().st_size>8192:raise ValueError('Oversized updater signature')
   signature=Path(str(artifact)+'.sig').read_text().strip()
   decoded=base64.b64decode(signature,validate=True).decode()
  except (OSError,ValueError,UnicodeError) as error:raise ValueError('Missing or malformed updater signature') from error
  trusted=[line for line in decoded.splitlines() if line.startswith('trusted comment: ')]
  if len(trusted)!=1 or f'version:{version}' not in trusted[0].split('\t'):raise ValueError('Signature is not bound to this release version')
  verify_artifact(artifact,version)
  platforms[target]={'signature':signature,'url':f'https://github.com/ainiaa/yam/releases/download/v{version}/{artifact.name}'}
 return {'version':version,'notes':notes,'pub_date':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'platforms':platforms}
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--version',required=True);parser.add_argument('--artifact',action='append',required=True,help='target=/absolute/artifact');parser.add_argument('--notes',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
 artifacts={}
 for value in args.artifact:
  target,separator,path=value.partition('=')
  if not separator or target in artifacts:parser.error('Expected unique target=artifact entries')
  artifacts[target]=Path(path)
 try:value=manifest(args.version,artifacts,args.notes.read_text())
 except (ValueError,OSError) as error:parser.error(str(error))
 args.output.mkdir(parents=True,exist_ok=True);(args.output/'latest.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
 sums=[]
 for artifact in artifacts.values():
  for path in [artifact,Path(str(artifact)+'.sig')]:sums.append(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.name)
 sums.append(hashlib.sha256((args.output/'latest.json').read_bytes()).hexdigest()+'  latest.json');(args.output/'SHA256SUMS').write_text('\n'.join(sums)+'\n')
 print(f'Prepared {len(artifacts)} target(s) in {args.output}; no release published.')
if __name__=='__main__':main()
