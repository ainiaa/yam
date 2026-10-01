#!/usr/bin/env python3
"""Author: Jeff.Liu. Validate the actual isolated background process on all desktop platforms."""
import argparse,importlib.util,json,os,pathlib,platform,plistlib,secrets,shlex,subprocess,tempfile,time
spec=importlib.util.spec_from_file_location('background_smoke',pathlib.Path(__file__).with_name('background-smoke.py'))
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)

def app_data(identifier):
 if platform.system()=='Darwin':return pathlib.Path.home()/'Library/Application Support'/identifier
 if platform.system()=='Windows':return pathlib.Path(os.environ['APPDATA'])/identifier
 return pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path.home()/'.local/share')))/identifier

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--executable',type=pathlib.Path,required=True);parser.add_argument('--identifier',required=True);args=parser.parse_args()
 assert args.identifier.startswith('com.yam.') and 'validation' in args.identifier
 executable=args.executable.resolve();assert executable.is_file()
 if platform.system()=='Darwin':
  info=plistlib.loads((executable.parent.parent/'Info.plist').read_bytes());assert info['CFBundleIdentifier']==args.identifier
 else:assert os.environ.get('GITHUB_ACTIONS')=='true','Non-macOS validation requires the CI-built isolated package'
 root=app_data(args.identifier);assert not root.exists() or not any(root.iterdir()),'Refusing a pre-existing validation data namespace'
 connection=root/'background/connection.json';owner=None;descriptor=None;client=None;request_id=0
 def call(command,arguments=None):
  nonlocal request_id
  request_id+=1;return smoke.rpc(descriptor,client,request_id,command,arguments)
 def start(previous=None):
  nonlocal owner,descriptor,client,request_id
  owner=subprocess.Popen([str(executable),'--yam-background'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  def ready():
   assert owner.poll() is None,'Validation background exited during setup'
   if not connection.exists():return False
   candidate=json.loads(connection.read_text(encoding='utf-8'))
   if candidate['instance']==previous:return False
   return candidate
  descriptor=smoke.wait_until(ready,20);client=secrets.token_hex(32);request_id=0
  assert call('ping')['ready'];assert call('background_status')['pid']==owner.pid
  call('set_agent_notification_context',{'selected':None,'paused':True}) # No system notification or trust prompts.
 def marker(path):
  try:return path.read_text(encoding='utf-8')
  except FileNotFoundError:return ''
 temporary=tempfile.TemporaryDirectory(prefix='yam-platform-fixture-')
 try:
  folder=pathlib.Path(temporary.name);fixture=folder/'fixture.py'
  fixture.write_text("import os,sys,time,pathlib\nsys.stdout.reconfigure(encoding='utf-8')\np=pathlib.Path(sys.argv[1]);seq=0\nsys.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HNATIVE_CONTINUITY 中😀\\r\\n');sys.stdout.flush()\nwhile True:\n seq+=1;t=p.with_suffix('.tmp');t.write_text(str(os.getpid())+','+str(seq),encoding='utf-8');os.replace(t,p);time.sleep(.05)\n",encoding='utf-8')
  def create(name):
   target=folder/name
   command=' '.join('"'+str(value)+'"' for value in [pathlib.Path(os.sys.executable),fixture,target]) if os.name=='nt' else ' '.join(shlex.quote(str(value)) for value in [pathlib.Path(os.sys.executable),fixture,target])
   summary=call('create_session',{'cwd':str(folder),'command':command});session=summary['session_id']
   smoke.wait_until(lambda:marker(target),10)
   smoke.wait_until(lambda:'NATIVE_CONTINUITY' in call('read_terminal_frame',{'session_id':session})['projection']['data'],10)
   frame=call('read_terminal_frame',{'session_id':session});assert '中😀' in frame['projection']['data']
   return session,target
  start();first_instance=descriptor['instance'];first_pid=owner.pid
  session,target=create('first')
  before=marker(target);time.sleep(.2);assert marker(target)!=before
  client=secrets.token_hex(32);request_id=0 # A genuinely disconnected client is replaced; no desktop process remains.
  assert call('background_status')['active_sessions']==1;assert call('background_status')['pid']==first_pid
  assert sum(r['summary']['session_id']==session for r in call('list_sessions'))==1
  call('stop_session',{'session_id':session})
  smoke.wait_until(lambda:call('background_status')['active_sessions']==0,15)
  saved=call('read_terminal_frame',{'session_id':session});assert saved and saved['status']=='stopped'
  stopped=marker(target);time.sleep(.2);assert marker(target)==stopped
  call('shutdown');owner.wait(timeout=10);owner.stderr.close();owner=None
  start(first_instance)
  assert call('background_status')['active_sessions']==0
  assert call('read_terminal_frame',{'session_id':session})==saved,'Cold owner must preserve the recorded final scene'
  interrupted,crash_target=create('interrupted');crash_instance=descriptor['instance']
  owner.kill();owner.wait(timeout=10);owner.stderr.close();owner=None
  time.sleep(.3);last_marker=marker(crash_target);time.sleep(.2);assert marker(crash_target)==last_marker,'An owner crash retained its PTY workload'
  start(crash_instance)
  assert call('background_status')['active_sessions']==0
  record=next(r for r in call('list_sessions') if r['summary']['session_id']==interrupted)
  assert record['status']=='needs_attention','An interrupted task was silently rerun or marked complete'
  assert marker(crash_target)==last_marker
  create('stop-all');call('shutdown');owner.wait(timeout=10);owner.stderr.close();owner=None
  print(json.dumps({'platform':platform.system(),'background_disconnect':True,'frozen_scene_after_owner_restart':True,'owner_crash_stops_workload':True,'no_automatic_rerun':True,'explicit_stop_all':True,'notification_delivery':'paused for validation'}))
 finally:
  if owner is not None:
   if owner.poll() is None:
    try:call('shutdown');owner.wait(timeout=5)
    except (OSError,AssertionError,subprocess.TimeoutExpired):owner.kill();owner.wait(timeout=5)
   owner.stderr.close()
  temporary.cleanup()

if __name__=='__main__':main()
