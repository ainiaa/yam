#!/usr/bin/env python3
"""Author: Jeff.Liu. Validate the actual isolated background process on all desktop platforms."""
import argparse,importlib.util,json,os,pathlib,platform,plistlib,secrets,shlex,subprocess,sys,tempfile,time
spec=importlib.util.spec_from_file_location('background_smoke',pathlib.Path(__file__).with_name('background-smoke.py'))
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
performance_spec=importlib.util.spec_from_file_location('native_run_performance',pathlib.Path(__file__).with_name('terminal-performance.py'))
performance=importlib.util.module_from_spec(performance_spec);performance_spec.loader.exec_module(performance)

def validate_native_run(executable,identifier,receipt_path,root):
 if receipt_path is None:raise ValueError('T08 evidence requires a frozen build receipt')
 receipt=json.loads(pathlib.Path(receipt_path).read_text())
 if not isinstance(receipt,dict) or type(receipt.get('schema_version')) is not int or receipt['schema_version']!=1:raise ValueError('Unsupported build receipt schema')
 executable=pathlib.Path(executable).resolve();app=executable.parent.parent.parent
 info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
 if identifier!='com.yam.performance-validation-t06' or receipt.get('identifier')!=identifier or info.get('CFBundleIdentifier')!=identifier:raise ValueError('Isolated package identity mismatch')
 name=info.get('CFBundleExecutable')
 if not isinstance(name,str) or name!=executable.name or executable!=(app/'Contents/MacOS'/name).resolve():raise ValueError('Executable does not match bundle declaration')
 root=pathlib.Path(root)
 if root.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):raise ValueError('Refusing a pre-existing validation data namespace')
 performance.validate_package_receipt(app,receipt)
 return receipt

def check_rpc_input_leases(descriptor,holder,session,request_id=0):
 contender=secrets.token_hex(32);conflict='Another desktop currently controls this terminal'
 if contender==holder:raise ValueError('Lease clients must be distinct')
 def call(client,command,arguments,*,error=False):
  nonlocal request_id
  request_id+=1;return smoke.rpc(descriptor,client,request_id,command,arguments,error=error)
 payload={'session_id':session,'data':''}
 call(holder,'write_session',payload)
 if call(contender,'write_session',payload,error=True)!=conflict:raise ValueError('Unexpected lease conflict response')
 call(contender,'take_terminal_control',{'session_id':session})
 call(contender,'write_session',payload)
 if call(holder,'write_session',payload,error=True)!=conflict:raise ValueError('Original input holder was not rejected')
 return contender

def app_data(identifier):
 if platform.system()=='Darwin':return pathlib.Path.home()/'Library/Application Support'/identifier
 if platform.system()=='Windows':return pathlib.Path(os.environ['APPDATA'])/identifier
 return pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path.home()/'.local/share')))/identifier

def check_retained_log(call,session):
 needle='NATIVE_CONTINUITY 中😀'
 page=call('search_session_logs',{'session_id':session,'request':{'query':needle,'case_sensitive':True,'skip':0,'limit':50}})
 assert page['complete'] and len(page['hits'])==1,'Retained log search is incomplete or lost its unique fixture line'
 hit=page['hits'][0];assert hit['session_id']==session and needle in hit['text']
 excerpt=call('read_log_excerpt',{'session_id':session,'offset':hit['offset'],'column':hit['column']})
 assert needle in excerpt,'Search hit does not locate the same retained output'
 assert needle in call('read_session_snapshot',{'session_id':session})['data']

def main():
 if sys.flags.optimize:raise ValueError('Optimized Python disables native validation assertions')
 parser=argparse.ArgumentParser();parser.add_argument('--executable',type=pathlib.Path,required=True);parser.add_argument('--identifier',required=True);parser.add_argument('--desktop',action='store_true');parser.add_argument('--receipt',type=pathlib.Path,help='Frozen T08 build receipt; omit only for legacy CI lifecycle runs');args=parser.parse_args()
 if args.receipt is not None and args.desktop:raise ValueError('Receipt-bound T08 validation permits owner RPC only')
 if not args.identifier.startswith('com.yam.') or 'validation' not in args.identifier:raise ValueError('A non-production validation identifier is required')
 executable=args.executable.resolve()
 if not executable.is_file():raise ValueError('Validation executable is unavailable')
 if platform.system()=='Darwin':
  info=plistlib.loads((executable.parent.parent/'Info.plist').read_bytes())
  if info.get('CFBundleIdentifier')!=args.identifier or info.get('CFBundleExecutable')!=executable.name:raise ValueError('Validation executable and bundle identity differ')
 else:
  if args.receipt is not None:raise ValueError('Receipt-bound T08 validation requires the frozen macOS package')
  if os.environ.get('GITHUB_ACTIONS')!='true':raise ValueError('Non-macOS validation requires the CI-built isolated package')
 root=app_data(args.identifier)
 if root.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):raise ValueError('Refusing a pre-existing validation data namespace')
 binding=validate_native_run(executable,args.identifier,args.receipt,root) if args.receipt is not None else None
 connection=root/'background/connection.json';owner=None;desktop=None;descriptor=None;client=None;request_id=0;confirmed=False;verified_owners=[]
 def call(command,arguments=None,*,error=False):
  nonlocal request_id
  if not confirmed or descriptor is None:raise ValueError('Background identity has not been confirmed')
  request_id+=1;return smoke.rpc(descriptor,client,request_id,command,arguments,error=error)
 def start(previous=None):
  nonlocal owner,descriptor,client,request_id,confirmed
  descriptor=None;client=None;request_id=0;confirmed=False
  owner=subprocess.Popen([str(executable),'--yam-background'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  def ready():
   assert owner.poll() is None,'Validation background exited during setup'
   if not connection.exists():return False
   candidate=json.loads(connection.read_text(encoding='utf-8'))
   if candidate['instance']==previous:return False
   return candidate
  candidate=smoke.wait_until(ready,20);candidate_client=secrets.token_hex(32)
  if not smoke.rpc(candidate,candidate_client,1,'ping')['ready']:raise ValueError('Background is not ready')
  status=smoke.rpc(candidate,candidate_client,2,'background_status')
  if status.get('pid')!=owner.pid or status.get('desktop_connected') is not False:raise ValueError('Background identity or disconnected state is unconfirmed')
  descriptor=candidate;client=candidate_client;request_id=2;confirmed=True
  verified_owners.append({'pid':owner.pid,'instance':descriptor['instance']})
  call('set_agent_notification_context',{'selected':None,'paused':True}) # No system notification or trust prompts.
 def marker(path):
  try:return path.read_text(encoding='utf-8')
  except FileNotFoundError:return ''
 def close_desktop():
  nonlocal desktop
  if desktop is None:return
  if desktop.poll() is None:
   desktop.terminate()
   try:desktop.wait(timeout=10)
   except subprocess.TimeoutExpired:desktop.kill();desktop.wait(timeout=5)
  if sys.exc_info()[0] is not None:print('Validation desktop stderr: '+desktop.stderr.read(4096).decode('utf-8',errors='replace'),file=sys.stderr)
  desktop.stderr.close();desktop=None
 temporary=tempfile.TemporaryDirectory(prefix='yam-platform-fixture-')
 try:
  folder=pathlib.Path(temporary.name);fixture=folder/'fixture.py'
  fixture.write_text("import os,sys,time,pathlib\nsys.stdout.reconfigure(encoding='utf-8')\np=pathlib.Path(sys.argv[1]);seq=0\nsys.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HNATIVE_CONTINUITY 中😀\\r\\n');sys.stdout.flush()\nwhile True:\n seq+=1;t=p.with_suffix('.tmp');t.write_text(str(os.getpid())+','+str(seq),encoding='utf-8');os.replace(t,p);time.sleep(.05)\n",encoding='utf-8')
  def create(name):
   target=folder/name
   command=' '.join('"'+str(value)+'"' for value in [pathlib.Path(os.sys.executable),fixture,target]) if os.name=='nt' else ' '.join(shlex.quote(str(value)) for value in [pathlib.Path(os.sys.executable),fixture,target])
   summary=call('create_session',{'cwd':str(folder),'command':command});session=summary['session_id']
   try:smoke.wait_until(lambda:marker(target),10)
   except AssertionError:
    record=next(r for r in call('list_sessions') if r['summary']['session_id']==session)
    snapshot=call('read_session_snapshot',{'session_id':session})
    print(json.dumps({'fixture_start_failure':True,'status':record['status'],'reason':record.get('reason'),'fixture_terminal_excerpt':snapshot['data'][-1024:]}),file=sys.stderr)
    raise
   smoke.wait_until(lambda:'NATIVE_CONTINUITY' in call('read_terminal_frame',{'session_id':session})['projection']['data'],10)
   frame=call('read_terminal_frame',{'session_id':session});assert '中😀' in frame['projection']['data']
   return session,target
  start();first_instance=descriptor['instance'];first_pid=owner.pid
  session,target=create('first')
  client=check_rpc_input_leases(descriptor,client,session,request_id);request_id+=5
  before=marker(target);time.sleep(.2);assert marker(target)!=before
  client=secrets.token_hex(32);request_id=0 # A genuinely disconnected client is replaced; no desktop process remains.
  assert call('background_status')['active_sessions']==1;assert call('background_status')['pid']==first_pid
  assert sum(r['summary']['session_id']==session for r in call('list_sessions'))==1
  check_retained_log(call,session)
  assert 'Unknown log session' in call('search_session_logs',{'session_id':'s-not-created','request':{'query':'NATIVE_CONTINUITY','case_sensitive':True,'skip':0,'limit':50}},error=True)
  if args.desktop:
   for _ in range(2):
    desktop=subprocess.Popen([str(executable)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    smoke.wait_until(lambda:call('background_status')['desktop_connected'],30)
    assert desktop.poll() is None and call('background_status')['pid']==first_pid
    assert call('background_status')['active_sessions']==1
    before=marker(target);time.sleep(.2);assert marker(target)!=before
    close_desktop()
    smoke.wait_until(lambda:not call('background_status')['desktop_connected'],15)
    assert owner.poll() is None
    before=marker(target);time.sleep(.2);assert marker(target)!=before
   assert sum(r['summary']['session_id']==session for r in call('list_sessions'))==1
  call('stop_session',{'session_id':session})
  smoke.wait_until(lambda:call('background_status')['active_sessions']==0,15)
  saved=call('read_terminal_frame',{'session_id':session});assert saved and saved['status']=='stopped'
  stopped=marker(target);time.sleep(.2);assert marker(target)==stopped
  call('shutdown');owner.wait(timeout=10);owner.stderr.close();owner=None
  start(first_instance)
  assert call('background_status')['active_sessions']==0
  assert call('read_terminal_frame',{'session_id':session})==saved,'Cold owner must preserve the recorded final scene'
  check_retained_log(call,session)
  interrupted,crash_target=create('interrupted');crash_instance=descriptor['instance']
  owner.kill();owner.wait(timeout=10);owner.stderr.close();owner=None
  time.sleep(.3);last_marker=marker(crash_target);time.sleep(.2);assert marker(crash_target)==last_marker,'An owner crash retained its PTY workload'
  start(crash_instance)
  assert call('background_status')['active_sessions']==0
  record=next(r for r in call('list_sessions') if r['summary']['session_id']==interrupted)
  assert record['status']=='needs_attention','An interrupted task was silently rerun or marked complete'
  assert marker(crash_target)==last_marker
  create('stop-all');call('shutdown');owner.wait(timeout=10);owner.stderr.close();owner=None
  if binding is not None:performance.validate_package_receipt(executable.parent.parent.parent,binding)
  print(json.dumps({'platform':platform.system(),'background_disconnect':True,'desktop_exit_reopen':args.desktop,'desktop_exit_method':'terminate fixture process' if args.desktop else None,'retained_log_search_and_location_after_reconnect':True,'unknown_log_session_rejected':True,'frozen_scene_after_owner_restart':True,'owner_crash_stops_workload':True,'no_automatic_rerun':True,'explicit_stop_all':True,'notification_delivery':'paused for validation','receipt_bound':binding is not None,'scope':'legacy GUI fixture termination; not CmdQ or native keyboard acceptance' if args.desktop else 'owner RPC; no App GUI or native keyboard acceptance','rpc_input_lease_transfer':True,'verified_owners':verified_owners,'package_sha256':binding.get('package_sha256') if binding else None,'product_source_sha256':binding.get('source_sha256') if binding else None,'runner_sha256':performance.digest(__file__),'receipt_sha256':performance.digest(args.receipt) if args.receipt else None}))
 finally:
  close_desktop()
  if owner is not None:
   if owner.poll() is None:
    try:
     if not confirmed or descriptor is None:raise OSError('Background identity was not confirmed')
     call('shutdown');owner.wait(timeout=5)
    except (OSError,AssertionError,subprocess.TimeoutExpired):owner.kill();owner.wait(timeout=5)
   if sys.exc_info()[0] is not None:print('Validation background stderr: '+owner.stderr.read(4096).decode('utf-8',errors='replace'),file=sys.stderr)
   owner.stderr.close()
  temporary.cleanup()

if __name__=='__main__':main()
