"""Author: Jeff.Liu. Check the shared native smoke protocol at its trust boundary."""
import importlib.util,json,pathlib,plistlib,shlex,struct,subprocess,sys,tempfile,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('background_smoke',pathlib.Path(__file__).with_name('background-smoke.py'))
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
platform_spec=importlib.util.spec_from_file_location('background_platform_smoke',pathlib.Path(__file__).with_name('background-platform-smoke.py'))
platform_smoke=importlib.util.module_from_spec(platform_spec);platform_spec.loader.exec_module(platform_smoke)
performance_spec=importlib.util.spec_from_file_location('t08_existing_performance',pathlib.Path(__file__).with_name('terminal-performance.py'))
performance=importlib.util.module_from_spec(performance_spec);performance_spec.loader.exec_module(performance)

class Stream:
 def __init__(self,change=None,budget=None):self.change=change or {};self.budget=budget;self.response=b'';self.request=None
 def __enter__(self):return self
 def __exit__(self,*_):pass
 def settimeout(self,_):pass
 def sendall(self,wire):
  size=struct.unpack('!I',wire[:4])[0];self.request=json.loads(wire[4:]);assert size==len(wire)-4
  result={**{key:self.request[key] for key in ['version','instance','client','id']},'result':{'Ok':'中文😀'},**self.change}
  body=json.dumps(result,ensure_ascii=False).encode('utf-8');self.response=struct.pack('!I',self.budget or len(body))+body
 def recv(self,size):result=self.response[:min(size,3)];self.response=self.response[len(result):];return result

class SmokeProtocolTests(unittest.TestCase):
 def setUp(self):self.descriptor={'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64}
 def test_partial_utf8_frames_preserve_the_bound_request_and_result(self):
  stream=Stream()
  with mock.patch.object(smoke.socket,'create_connection',return_value=stream):
   self.assertEqual(smoke.rpc(self.descriptor,'c'*64,7,'list_sessions'),'中文😀')
  self.assertEqual(stream.request['args'],{});self.assertEqual(stream.request['id'],7);self.assertEqual(stream.request['command'],'list_sessions')
 def test_t04_old_protocol_is_rejected_before_contacting_live_owner(self):
  with mock.patch.object(smoke.socket,'create_connection',return_value=Stream()) as connect:
   with self.assertRaises(AssertionError):smoke.rpc({**self.descriptor,'version':1},'c'*64,7,'archive_session',{'session_id':'s-old'})
   connect.assert_not_called()
 def test_wrong_reply_identity_and_oversized_frames_are_rejected(self):
  for change in [{'version':1},{'instance':'d'*64},{'client':'d'*64},{'id':8}]:
   with mock.patch.object(smoke.socket,'create_connection',return_value=Stream(change)):
    with self.assertRaises(AssertionError):smoke.rpc(self.descriptor,'c'*64,7,'list_sessions')
  with mock.patch.object(smoke.socket,'create_connection',return_value=Stream(budget=64*1024*1024+1)):
   with self.assertRaises(AssertionError):smoke.rpc(self.descriptor,'c'*64,7,'list_sessions')
 def test_backend_errors_are_not_success_and_non_loopback_is_never_contacted(self):
  with mock.patch.object(smoke.socket,'create_connection',return_value=Stream({'result':{'Err':'fixture error'}})):
   with self.assertRaises(AssertionError):smoke.rpc(self.descriptor,'c'*64,7,'list_sessions')
   self.assertEqual(smoke.rpc(self.descriptor,'c'*64,7,'list_sessions',error=True),'fixture error')
  with mock.patch.object(smoke.socket,'create_connection') as connect:
   with self.assertRaises(AssertionError):smoke.rpc({**self.descriptor,'address':'example.com:12345'},'c'*64,7,'list_sessions')
   connect.assert_not_called()

class RetainedLogFlowTests(unittest.TestCase):
 def replies(self):
  return [{'complete':True,'hits':[{'session_id':'s-fixture','offset':0,'column':0,'text':'NATIVE_CONTINUITY 中😀'}]},'NATIVE_CONTINUITY 中😀\n',{'data':'\x1b[?1049hNATIVE_CONTINUITY 中😀\r\n'}]
 def test_unicode_search_hit_routes_to_the_same_recorded_excerpt_and_snapshot(self):
  call=mock.Mock(side_effect=self.replies())
  platform_smoke.check_retained_log(call,'s-fixture')
  self.assertEqual(call.call_args_list,[
   mock.call('search_session_logs',{'session_id':'s-fixture','request':{'query':'NATIVE_CONTINUITY 中😀','case_sensitive':True,'skip':0,'limit':50}}),
   mock.call('read_log_excerpt',{'session_id':'s-fixture','offset':0,'column':0}),
   mock.call('read_session_snapshot',{'session_id':'s-fixture'})])
 def test_partial_missing_wrong_session_and_wrong_excerpt_never_pass(self):
  for page in [{'complete':False,'hits':[]},{'complete':True,'hits':[]},{'complete':True,'hits':[{'session_id':'s-other','offset':0,'column':0,'text':'NATIVE_CONTINUITY 中😀'}]}]:
   with self.assertRaises(AssertionError):platform_smoke.check_retained_log(mock.Mock(return_value=page),'s-fixture')
  replies=self.replies();replies[1]='wrong retained output'
  with self.assertRaises(AssertionError):platform_smoke.check_retained_log(mock.Mock(side_effect=replies),'s-fixture')

class NativeRunBindingTests(unittest.TestCase):
 def setUp(self):
  self.temporary=tempfile.TemporaryDirectory(prefix='yam-t08-binding-test-');self.addCleanup(self.temporary.cleanup)
  self.folder=pathlib.Path(self.temporary.name).resolve();self.app=self.folder/'Fixture.app'
  self.executable=self.app/'Contents/MacOS/yam-desktop';self.executable.parent.mkdir(parents=True);self.executable.write_bytes(b'fixture executable')
  self.resource=self.app/'Contents/Resources/target/terminal-runtime/yam-terminal';self.resource.parent.mkdir(parents=True);self.resource.write_bytes(b'fixture runtime')
  self.info=self.app/'Contents/Info.plist';self.identifier='com.yam.performance-validation-t06'
  self.info.write_bytes(plistlib.dumps({'CFBundleIdentifier':self.identifier,'CFBundleExecutable':'yam-desktop'}))
  self.root=self.folder/'validation-data';self.receipt_path=self.folder/'build-receipt.json'
  self.receipt={'schema_version':1,'identifier':self.identifier,'commit':'6b00a7dcad249c4fca90efbcdafdbc4a836ea8ec',
   'source_state':'HEAD plus dirty working tree; product frozen before measurement-script changes',
   'source_sha256':performance.product_source_sha256(),'product_source_fingerprint':'a'*64,
   'package_sha256':performance.digest(self.app),'info_sha256':performance.digest(self.info),
   'binary_sha256':performance.digest(self.executable),'terminal_resource_sha256':performance.digest(self.resource)}
  self.product_source_sha=self.receipt['source_sha256']
  self.save()
 def save(self):self.receipt_path.write_text(json.dumps(self.receipt))
 def api(self):
  function=getattr(platform_smoke,'validate_native_run',None)
  self.assertTrue(callable(function),'T08 pre-start binding API is missing: validate_native_run')
  return function
 def check(self):return self.api()(self.executable,self.identifier,self.receipt_path,self.root)
 def rejected(self):
  with mock.patch.object(platform_smoke,'performance',performance,create=True),mock.patch.object(performance,'product_source_sha256',return_value=self.product_source_sha),mock.patch.object(platform_smoke.subprocess,'Popen') as start,mock.patch.object(platform_smoke.smoke,'rpc') as rpc:
   with self.assertRaises((ValueError,OSError)):self.check()
   start.assert_not_called();rpc.assert_not_called()
 def test_t08_normal_binding_delegates_to_existing_package_validator(self):
  check=self.api()
  with mock.patch.object(platform_smoke,'performance',performance,create=True),mock.patch.object(performance,'validate_package_receipt',wraps=performance.validate_package_receipt) as validate:
   self.assertEqual(check(self.executable,self.identifier,self.receipt_path,self.root),self.receipt)
   validate.assert_called_once_with(self.app,self.receipt)
  self.root.mkdir();self.assertEqual(self.check(),self.receipt,'An existing empty isolated namespace is allowed')
 def test_t08_missing_corrupt_or_wrong_schema_receipt_stops_before_processes(self):
  self.receipt_path.unlink();self.rejected()
  self.receipt_path.write_text('{not json');self.rejected()
  for value in [None,2,'1',True]:
   with self.subTest(schema=value):self.receipt['schema_version']=value;self.save();self.rejected()
 def test_t08_missing_receipt_argument_and_missing_required_identity_are_rejected(self):
  check=self.api()
  with self.assertRaises(ValueError):check(self.executable,self.identifier,None,self.root)
  for field in ['identifier','source_sha256','product_source_fingerprint','package_sha256']:
   receipt=dict(self.receipt);del receipt[field];self.receipt_path.write_text(json.dumps(receipt));self.rejected()
 def test_t08_changed_product_source_or_any_package_resource_is_rejected(self):
  self.receipt['source_sha256']='0'*64;self.save();self.rejected()
  self.receipt['source_sha256']=performance.product_source_sha256();self.save()
  for target in [self.executable,self.resource,self.info,self.app/'Contents/Resources/arbitrary-resource']:
   with self.subTest(target=target.name):
    previous=target.read_bytes() if target.exists() else None;target.write_bytes(b'changed fixture resource');self.rejected()
    if previous is None:target.unlink()
    else:target.write_bytes(previous)
 def test_t08_production_or_mismatched_app_identity_is_rejected(self):
  check=self.api()
  for identity in ['com.yam.desktop','com.yam.other-validation']:
   with self.subTest(identity=identity),self.assertRaises(ValueError):check(self.executable,identity,self.receipt_path,self.root)
  self.receipt['identifier']='com.yam.desktop';self.save();self.rejected()
 def test_t08_nonempty_or_linked_data_namespace_is_rejected_without_cleanup(self):
  self.root.mkdir();existing=self.root/'keep-existing-history';existing.write_bytes(b'existing validation data');self.rejected()
  self.assertEqual(existing.read_bytes(),b'existing validation data')
  link=self.folder/'linked-data';link.symlink_to(self.root,target_is_directory=True)
  with self.assertRaises(ValueError):self.api()(self.executable,self.identifier,self.receipt_path,link)
 def test_t08_cli_receipt_validation_precedes_any_owner_pty_or_gui_start(self):
  self.receipt_path.write_text('{corrupt receipt')
  argv=['background-platform-smoke.py','--executable',str(self.executable),'--identifier',self.identifier,'--receipt',str(self.receipt_path)]
  with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen') as start,mock.patch.object(platform_smoke.smoke,'rpc') as rpc:
   with self.assertRaises(ValueError):platform_smoke.main()
   start.assert_not_called();rpc.assert_not_called()
 def test_t08_nonempty_guard_survives_python_optimization(self):
  self.api();self.root.mkdir();(self.root/'keep').write_text('existing')
  code="import importlib.util,pathlib,sys; s=importlib.util.spec_from_file_location('runner',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\ntry: m.validate_native_run(pathlib.Path(sys.argv[2]),sys.argv[3],pathlib.Path(sys.argv[4]),pathlib.Path(sys.argv[5]))\nexcept ValueError: print('rejected-before-start')\nelse: raise RuntimeError('optimized guard allowed existing data')"
  result=subprocess.run([sys.executable,'-O','-c',code,str(pathlib.Path(__file__).with_name('background-platform-smoke.py')),str(self.executable),self.identifier,str(self.receipt_path),str(self.root)],capture_output=True,text=True,timeout=10)
  self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'rejected-before-start')
 def test_t08_executable_must_match_bundle_declared_executable(self):
  check=self.api();sibling=self.executable.with_name('wrong-sibling');sibling.write_bytes(b'other fixture executable')
  self.receipt['package_sha256']=performance.digest(self.app);self.save()
  with self.assertRaises(ValueError):check(sibling,self.identifier,self.receipt_path,self.root)
 def test_t08_entry_rejects_python_optimization_before_start(self):
  argv=['runner','--executable',str(self.executable),'--identifier',self.identifier]
  with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke.sys,'flags',mock.Mock(optimize=1)),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen',side_effect=RuntimeError('unexpected owner start')) as start:
   with self.assertRaises(ValueError):platform_smoke.main()
   start.assert_not_called()
 def test_t08_receipt_bound_desktop_mode_is_rejected_before_start(self):
  argv=['runner','--executable',str(self.executable),'--identifier',self.identifier,'--receipt',str(self.receipt_path),'--desktop']
  with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke,'performance',performance,create=True),mock.patch.object(performance,'product_source_sha256',return_value=self.product_source_sha),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen') as start,mock.patch.object(platform_smoke.smoke,'rpc') as rpc:
   with self.assertRaises(ValueError):platform_smoke.main()
   start.assert_not_called();rpc.assert_not_called()
 def startup_child(self,pid):
  child=mock.Mock();child.pid=pid;child.poll.return_value=None;child.stderr.read.return_value=b'';return child
 def write_connection(self,instance):
  connection=self.root/'background/connection.json';connection.parent.mkdir(parents=True,exist_ok=True)
  candidate={'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':instance}
  connection.write_text(json.dumps(candidate));return candidate
 def test_t08_unconfirmed_pid_or_connected_desktop_never_receives_cleanup_rpc(self):
  for status in [{'pid':999,'desktop_connected':False},{'pid':1234,'desktop_connected':True}]:
   with self.subTest(status=status):
    if self.root.exists():
     (self.root/'background/connection.json').unlink();(self.root/'background').rmdir();self.root.rmdir()
    child=self.startup_child(1234);events=[]
    def launch(*args,**kwargs):self.write_connection('b'*64);return child
    def rpc(descriptor,client,request_id,command,arguments=None,**kwargs):
     events.append(command)
     if command=='ping':return {'ready':True}
     if command=='background_status':return status
     if command=='create_session':raise AssertionError('unconfirmed owner reached PTY creation')
    argv=['runner','--executable',str(self.executable),'--identifier',self.identifier]
    with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen',side_effect=launch),mock.patch.object(platform_smoke.smoke,'wait_until',side_effect=lambda predicate,*args:predicate()),mock.patch.object(platform_smoke.smoke,'rpc',side_effect=rpc):
     with self.assertRaises((AssertionError,ValueError)):platform_smoke.main()
    self.assertNotIn('create_session',events)
    self.assertNotIn('shutdown',events,'An unconfirmed candidate must not receive shutdown')
    self.assertGreater(child.kill.call_count+child.terminate.call_count,0,'Only the newly spawned child may be reclaimed')
 def test_t08_initial_ready_timeout_only_reclaims_own_child(self):
  child=self.startup_child(1234);argv=['runner','--executable',str(self.executable),'--identifier',self.identifier]
  with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen',return_value=child),mock.patch.object(platform_smoke.smoke,'wait_until',side_effect=AssertionError('mock ready timeout')),mock.patch.object(platform_smoke.smoke,'rpc') as rpc:
   with self.assertRaises((AssertionError,ValueError)):platform_smoke.main()
   rpc.assert_not_called()
  self.assertGreater(child.kill.call_count+child.terminate.call_count,0)
 def restart_timeout_events(self):
  events=[];children=[];sessions={};targets={};running=set();attempts=0;holder=None
  def launch(*args,**kwargs):
   child=self.startup_child(2000+len(children));children.append(child);self.write_connection(('b' if len(children)==1 else 'c')*64)
   events.append(('spawn',child.pid));return child
  def wait(predicate,*args):
   nonlocal attempts
   if predicate.__name__=='ready':
    attempts+=1
    if attempts==2:raise AssertionError('mock restart ready timeout')
   return predicate()
  def sleep(_):
   for identity in running:
    path=targets[identity];path.write_text(path.read_text()+'1')
  def rpc(descriptor,client,request_id,command,arguments=None,*,error=False):
   nonlocal holder
   events.append(('rpc',command,descriptor['instance'],children[-1].pid,arguments))
   if command=='ping':return {'ready':True}
   if command=='background_status':return {'pid':children[-1].pid,'desktop_connected':False,'active_sessions':len(running)}
   if command=='create_session':
    identity='fixture-'+str(len(sessions));path=pathlib.Path(shlex.split(arguments['command'])[-1]);path.write_text('1');targets[identity]=path;sessions[identity]='running';running.add(identity);return {'session_id':identity}
   if command=='list_sessions':return [{'summary':{'session_id':identity},'status':status} for identity,status in sessions.items()]
   if command=='read_terminal_frame':return {'projection':{'data':'NATIVE_CONTINUITY 中😀'},'status':sessions[arguments['session_id']]}
   if command=='search_session_logs':return 'Unknown log session'
   if command=='stop_session':running.remove(arguments['session_id']);sessions[arguments['session_id']]='stopped'
   if command=='shutdown':running.clear()
   if command=='write_session':
    if holder is not None and holder!=client:return 'Another desktop currently controls this terminal'
    holder=client
   if command=='take_terminal_control':holder=client
  argv=['runner','--executable',str(self.executable),'--identifier',self.identifier]
  with mock.patch.object(platform_smoke.sys,'argv',argv),mock.patch.object(platform_smoke,'app_data',return_value=self.root),mock.patch.object(platform_smoke.subprocess,'Popen',side_effect=launch),mock.patch.object(platform_smoke.smoke,'wait_until',side_effect=wait),mock.patch.object(platform_smoke.smoke,'rpc',side_effect=rpc),mock.patch.object(platform_smoke.time,'sleep',side_effect=sleep),mock.patch.object(platform_smoke,'check_retained_log'):
   with self.assertRaises((AssertionError,ValueError)):platform_smoke.main()
  return events,children
 def test_t08_restart_timeout_does_not_shutdown_previous_descriptor(self):
  events,children=self.restart_timeout_events();self.assertEqual(len(children),2)
  stale=[event for event in events if event[0]=='rpc' and event[1]=='shutdown' and event[3]==children[1].pid]
  self.assertEqual(stale,[],'The failed restart cannot use the previous confirmed descriptor')
  self.assertGreater(children[1].kill.call_count+children[1].terminate.call_count,0)
 def test_t08_pause_precedes_create_and_owner_rpc_does_not_poll_desktop_events(self):
  events,_=self.restart_timeout_events();calls=[event for event in events if event[0]=='rpc']
  pause=next(i for i,event in enumerate(calls) if event[1]=='set_agent_notification_context')
  create=next(i for i,event in enumerate(calls) if event[1]=='create_session')
  self.assertLess(pause,create);self.assertEqual(calls[pause][4],{'selected':None,'paused':True})
  self.assertFalse(any(event[1]=='poll_events' for event in calls))
 def test_t08_two_rpc_clients_claim_conflict_takeover_and_reject_original_holder(self):
  check=getattr(platform_smoke,'check_rpc_input_leases',None);self.assertTrue(callable(check),'T08 RPC lease sequence API is missing')
  descriptor={'version':2,'instance':'b'*64,'address':'127.0.0.1:12345','token':'a'*64};holder='c'*64;events=[];owner=None
  def rpc(d,client,request_id,command,arguments=None,*,error=False):
   nonlocal owner
   self.assertIs(d,descriptor);self.assertEqual(len(client),64);int(client,16);events.append((client,request_id,command,arguments,error))
   if command=='write_session':
    self.assertEqual(arguments,{'session_id':'s-fixture','data':''})
    if owner is not None and client!=owner:
     self.assertTrue(error);return 'Another desktop currently controls this terminal'
    self.assertFalse(error);owner=client
   elif command=='take_terminal_control':self.assertFalse(error);owner=client
   else:self.fail('Unexpected lease command '+command)
  with mock.patch.object(platform_smoke.smoke,'rpc',side_effect=rpc),mock.patch.object(platform_smoke.secrets,'token_hex',return_value='d'*64):winner=check(descriptor,holder,'s-fixture')
  self.assertEqual(winner,'d'*64)
  self.assertEqual([event[2] for event in events],['write_session','write_session','take_terminal_control','write_session','write_session'])
  self.assertEqual([event[0] for event in events],[holder,winner,winner,winner,holder])
  self.assertEqual(len(set(event[1] for event in events)),5)
 def test_t08_lease_conflict_requires_exact_backend_error(self):
  check=getattr(platform_smoke,'check_rpc_input_leases',None);self.assertTrue(callable(check),'T08 RPC lease sequence API is missing')
  with mock.patch.object(platform_smoke.smoke,'rpc',side_effect=[None,'other controls failure']),self.assertRaises((AssertionError,ValueError)):
   check({'instance':'b'*64},'c'*64,'s-fixture')

class F7CurrentRunTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='yam-f7-preflight-');self.addCleanup(self.temp.cleanup)
  self.folder=pathlib.Path(self.temp.name).resolve();self.home=self.folder/'home';self.home.mkdir()
  self.app=self.folder/'Fixture.app';self.exe=self.app/'Contents/MacOS/yam-desktop';self.exe.parent.mkdir(parents=True);self.exe.write_bytes(b'inert binary')
  self.resource=self.app/'Contents/Resources/target/terminal-runtime/yam-terminal';self.resource.parent.mkdir(parents=True);self.resource.write_bytes(b'inert runtime')
  self.info=self.app/'Contents/Info.plist';self.identifier='com.yam.functional-validation-f7-'+'a'*32
  self.info.write_bytes(plistlib.dumps({'CFBundleIdentifier':self.identifier,'CFBundleExecutable':'yam-desktop','LSMinimumSystemVersion':'13.5'}))
  self.root=self.home/'Library/Application Support'/self.identifier
  self.config=self.folder/'config.json';self.config.write_text(json.dumps({'identifier':self.identifier}))
  self.buildlog=self.folder/'build.log';self.buildlog.write_text('actual fixture build stub, no native build')
  self.whole=self.folder/'source.json';self.whole.write_text(json.dumps({'source_fingerprint':'b'*64}))
  self.input=self.folder/'source.ts';self.input.write_text('current synthetic frontend/backend/assets input')
  self.source_map={'source.ts':performance.digest(self.input)}
  self.receipt_path=self.folder/'receipt.json'
  self.receipt={'schema_version':1,'purpose':'F7-current-source-developer-artifact','identifier':self.identifier,'package_path':str(self.app),'executable_path':str(self.exe),
   'source_manifest':self.source_map,'source_sha256':performance.digest(self.input),'whole_source_receipt':str(self.whole),'whole_source_receipt_sha256':performance.digest(self.whole),'whole_source_fingerprint':'b'*64,
   'package_sha256':performance.digest(self.app),'info_sha256':performance.digest(self.info),'binary_sha256':performance.digest(self.exe),'resources_sha256':performance.digest(self.app/'Contents/Resources'),'terminal_resource_sha256':performance.digest(self.resource),
   'build':{'argv':['fixture-build','--config',str(self.config)],'exit_code':0,'config_path':str(self.config),'config_sha256':performance.digest(self.config),'log_path':str(self.buildlog),'log_sha256':performance.digest(self.buildlog),'source_before_sha256':performance.digest(self.input),'source_after_sha256':performance.digest(self.input)}}
  self.save()
 def save(self):self.receipt_path.write_text(json.dumps(self.receipt))
 def preflight(self):return smoke.validate_f7_run(self.app,self.identifier,self.receipt_path)
 def patched(self):
  return mock.patch.multiple(smoke,app_data=mock.Mock(return_value=self.root),current_product_source=mock.Mock(return_value=(self.source_map,performance.digest(self.input))))
 def test_f7_current_full_receipt_accepts_absent_and_empty_namespace(self):
  with self.patched():
   value=self.preflight();self.assertEqual(value['executable'],self.exe);self.assertEqual(value['root'],self.root)
   self.root.mkdir(parents=True);self.assertEqual(self.preflight()['root'],self.root)
 def test_f7_receipt_identity_source_bundle_and_compiled_config_fail_closed(self):
  mutations=[('schema_version',True),('identifier','com.yam.performance-validation-t06'),('source_sha256','f'*64),('package_sha256','f'*64),('resources_sha256','f'*64),('terminal_resource_sha256','f'*64),('executable_path',str(self.folder/'other'))]
  for key,value in mutations:
   with self.subTest(key=key),self.patched():
    previous=self.receipt[key];self.receipt[key]=value;self.save()
    with self.assertRaises(ValueError):self.preflight()
    self.receipt[key]=previous
  self.save();self.config.write_text(json.dumps({'identifier':'com.yam.changed-uncompiled'}));self.receipt['build']['config_sha256']=performance.digest(self.config);self.save()
  with self.patched(),self.assertRaises(ValueError):self.preflight()
 def test_f7_namespace_and_linked_ancestor_never_deleted_or_contacted(self):
  self.root.mkdir(parents=True);marker=self.root/'connection.json';marker.write_text('unrelated prior run bytes')
  with self.patched(),self.assertRaises(ValueError):self.preflight()
  self.assertEqual(marker.read_text(),'unrelated prior run bytes');marker.unlink();self.root.rmdir()
  self.root.symlink_to(self.folder,target_is_directory=True)
  with self.patched(),self.assertRaises(ValueError):self.preflight()
  self.root.unlink();parent=self.home/'Library';parent.rename(self.home/'actual-library');parent.symlink_to(self.home/'actual-library',target_is_directory=True)
  with self.patched(),self.assertRaises(ValueError):self.preflight()
 def test_f7_actual_main_missing_receipt_rejects_before_descriptor_or_process(self):
  # Existing actual main reaches launch with no current-source receipt; mock blocks all OS launch.
  with mock.patch.object(smoke.sys,'argv',['runner','--app',str(self.app)]),mock.patch.object(pathlib.Path,'home',return_value=self.home),mock.patch.object(smoke.subprocess,'Popen',side_effect=RuntimeError('mock launch guard')) as popen,mock.patch.object(smoke.socket,'create_connection') as connect:
   try:smoke.main()
   except (ValueError,SystemExit,RuntimeError):pass
   self.assertEqual(popen.call_count,0,'unreceipted actual main reached process launch')
   connect.assert_not_called()

 def owner_child(self,pid=1234):
  child=mock.Mock(pid=pid,returncode=None);child.poll.return_value=None
  def wait(timeout=None):child.returncode=0;child.poll.return_value=0;return 0
  child.wait.side_effect=wait;return child
 def owner_run(self,status,*,desktop=False,timeout=False):
  child=self.owner_child();events=[]
  def launch(*args,**kwargs):
   events.append(('spawn',args[0]));self.root.joinpath('background').mkdir(parents=True,exist_ok=True)
   path=self.root/'background/connection.json';path.write_text(json.dumps({'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64}));path.chmod(0o600);return child
  def rpc(descriptor,client,request_id,command,arguments=None,**kwargs):
   events.append(('rpc',command))
   if command=='ping':return {'ready':True}
   if command=='background_status':return status
   if command=='get_notification_pause_state':return {'revision':0,'owner_instance':descriptor['instance'],'paused':False}
   if command=='set_notification_paused':return {'revision':1,'owner_instance':descriptor['instance'],'paused':True}
   raise ValueError('mock task stop point')
  def wait(predicate,*args):
   if timeout:raise AssertionError('owned startup timeout')
   return predicate()
  argv=['runner','--app',str(self.app),'--identifier',self.identifier,'--receipt',str(self.receipt_path)]+(['--desktop'] if desktop else [])
  with self.patched(),mock.patch.object(smoke.sys,'argv',argv),mock.patch.object(smoke.subprocess,'Popen',side_effect=launch),mock.patch.object(smoke,'rpc',side_effect=rpc),mock.patch.object(smoke,'wait_until',side_effect=wait):
   try:smoke.main()
   except (ValueError,AssertionError):pass
  return events,child
 def test_f7_wrong_owned_pid_never_reaches_task_or_cleanup_rpc(self):
  events,child=self.owner_run({'pid':999,'desktop_connected':False})
  self.assertFalse(any(e==('rpc','create_session') for e in events),'unconfirmed PID reached task allocation')
  self.assertFalse(any(e[0]=='rpc' and e[1] in ['stop_session','shutdown'] for e in events))
  self.assertGreater(child.terminate.call_count+child.kill.call_count,0)
 def test_f7_desktop_launch_retains_separate_explicit_background_handle(self):
  events,child=self.owner_run({'pid':1234,'desktop_connected':True},desktop=True)
  self.assertEqual(events[0],('spawn',[str(self.exe),'--yam-background']))
 def test_f7_initial_timeout_reclaims_only_retained_child(self):
  events,child=self.owner_run({'pid':1234,'desktop_connected':False},timeout=True)
  self.assertFalse(any(e[0]=='rpc' for e in events))
  self.assertGreater(child.terminate.call_count+child.kill.call_count,0)
 def test_f7_actual_optimized_entry_rejects_before_all_effects(self):
  marker=self.folder/'optimization-effects'
  script="""import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('actual_smoke',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def effect(*a,**k):
 pathlib.Path(sys.argv[2]).write_text('effect');raise RuntimeError('effect')
m.subprocess.Popen=effect;m.socket.create_connection=effect;m.current_product_source=effect
try:m.main()
except ValueError as e:
 print(str(e));sys.exit(0 if str(e)=='Optimized Python cannot run F7 acceptance' else 7)
sys.exit(8)
"""
  result=subprocess.run([sys.executable,'-O','-c',script,str(pathlib.Path(smoke.__file__).resolve()),str(marker)],capture_output=True,timeout=5)
  self.assertEqual(result.returncode,0,result.stderr.decode());self.assertFalse(marker.exists())

 def test_f7_actual_owner_confirmation_normal_and_restart_instance(self):
  self.root.joinpath('background').mkdir(parents=True);connection=self.root/'background/connection.json'
  descriptor={'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64};connection.write_text(json.dumps(descriptor));connection.chmod(0o600)
  child=self.owner_child()
  with mock.patch.object(smoke,'rpc',side_effect=[{'ready':True},{'pid':1234}]) as rpc:
   actual,last=smoke.confirm_f7_owner(child,connection,'c'*64,0)
   self.assertEqual(actual,descriptor);self.assertEqual(last,2);self.assertEqual([c.args[3] for c in rpc.call_args_list],['ping','background_status'])
  with mock.patch.object(smoke,'rpc') as rpc,self.assertRaises(ValueError):smoke.confirm_f7_owner(child,connection,'c'*64,0,previous_instance='b'*64)
  rpc.assert_not_called();descriptor['instance']='d'*64;connection.write_text(json.dumps(descriptor))
  with mock.patch.object(smoke,'rpc',side_effect=[{'ready':True},{'pid':1234}]):self.assertEqual(smoke.confirm_f7_owner(child,connection,'c'*64,0,previous_instance='b'*64)[0]['instance'],'d'*64)
 def test_f7_actual_owner_confirmation_rejects_bad_descriptor_and_dead_child(self):
  self.root.joinpath('background').mkdir(parents=True);connection=self.root/'background/connection.json';child=self.owner_child()
  descriptor={'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64}
  for changed in [{'version':True},{'version':1},{'address':'remote:123'},{'address':'127.0.0.1:0'},{'instance':'bad'},{'token':'bad'}]:
   connection.write_text(json.dumps({**descriptor,**changed}));connection.chmod(0o600)
   with mock.patch.object(smoke,'rpc') as rpc,self.assertRaises(ValueError):smoke.confirm_f7_owner(child,connection,'c'*64,0)
   rpc.assert_not_called()
  connection.write_text(json.dumps(descriptor));child.poll.return_value=1
  with mock.patch.object(smoke,'rpc') as rpc,self.assertRaises(ValueError):smoke.confirm_f7_owner(child,connection,'c'*64,0)
  rpc.assert_not_called()

 def test_f7_actual_entry_pause_precedes_task_and_gui_keeps_owner_pid(self):
  events,child=self.owner_run({'pid':1234,'desktop_connected':True},desktop=True)
  launches=[e[1] for e in events if e[0]=='spawn'];self.assertEqual(launches,[[str(self.exe),'--yam-background'],[str(self.exe)]])
  commands=[e[1] for e in events if e[0]=='rpc']
  self.assertLess(commands.index('set_notification_paused'),commands.index('create_session'))
  self.assertNotIn('poll_events',commands)
 def test_f7_unchanged_old_descriptor_after_restart_cannot_confirm(self):
  self.root.joinpath('background').mkdir(parents=True);connection=self.root/'background/connection.json'
  descriptor={'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64};connection.write_text(json.dumps(descriptor));connection.chmod(0o600)
  with mock.patch.object(smoke,'rpc') as rpc,self.assertRaises(ValueError):smoke.confirm_f7_owner(self.owner_child(5678),connection,'c'*64,0,previous_instance='b'*64)
  rpc.assert_not_called()
 def test_f7_current_package_and_required_resource_changes_are_rechecked(self):
  for path in [self.exe,self.resource,self.info]:
   with self.subTest(path=path),self.patched():
    before=path.read_bytes();path.write_bytes(before+b'changed')
    with self.assertRaises((ValueError,plistlib.InvalidFileException)):self.preflight()
    path.write_bytes(before)
  extra=self.app/'Contents/Resources/extra';extra.write_bytes(b'unexpected bundle change')
  with self.patched(),self.assertRaises(ValueError):self.preflight()
 def test_f7_actual_main_populated_namespace_leaves_descriptor_bytes_untouched(self):
  self.root.joinpath('background').mkdir(parents=True);connection=self.root/'background/connection.json';connection.write_text('prior fixture descriptor')
  argv=['runner','--app',str(self.app),'--identifier',self.identifier,'--receipt',str(self.receipt_path)]
  with self.patched(),mock.patch.object(smoke.sys,'argv',argv),mock.patch.object(smoke.subprocess,'Popen') as popen,mock.patch.object(smoke.socket,'create_connection') as connect,self.assertRaises(ValueError):smoke.main()
  popen.assert_not_called();connect.assert_not_called();self.assertEqual(connection.read_text(),'prior fixture descriptor')

 def test_f7_actual_main_same_run_restart_confirms_distinct_owned_instances(self):
  children=[];events=[];records={};receipts={}
  def launch(argv,**kwargs):
   child=self.owner_child(1000+len(children));children.append(child)
   child.kill.side_effect=lambda:(setattr(child,'returncode',-9),setattr(child.poll,'return_value',-9))
   self.root.joinpath('background').mkdir(parents=True,exist_ok=True)
   instance=('b' if len(children)==1 else 'd')*64
   connection=self.root/'background/connection.json';connection.write_text(json.dumps({'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':instance}));connection.chmod(0o600)
   if len(children)>1:
    for id,status in records.items():
     if status=='running':records[id]='needs_attention'
   events.append(('spawn',child.pid,instance));return child
  def rpc(desc,client,id,command,arguments=None,**kwargs):
   events.append(('rpc',command,desc['instance'],children[-1].pid))
   if command=='ping':return {'ready':True}
   if command=='background_status':return {'pid':children[-1].pid,'desktop_connected':False}
   if command=='get_notification_pause_state':return {'revision':0,'owner_instance':desc['instance'],'paused':False}
   if command=='set_notification_paused':
    self.assertEqual(arguments,{'paused':True,'expected_revision':0,'expected_owner_instance':desc['instance']});return {'revision':1,'owner_instance':desc['instance'],'paused':True}
   if command=='create_session':
    key=(desc['instance'],client,id)
    if key not in receipts:
     receipts[key]='fixture-'+str(len(records));records[receipts[key]]='running'
    return {'session_id':receipts[key]}
   if command=='read_session_snapshot':return {'data':'YAM_BG_PID=98765'}
   if command=='write_session':return 'Another controls this terminal' if kwargs.get('error') else None
   if command=='take_terminal_control':return 'Unknown session' if kwargs.get('error') else None
   if command=='list_sessions':return [{'summary':{'session_id':key},'status':status} for key,status in records.items()]
   if command=='stop_session':records[arguments['session_id']]='stopped';return None
   if command=='shutdown':return None
   self.fail('Unexpected command '+command)
  def wait(predicate,*args):
   value=predicate();self.assertTrue(value,'fixture condition must be immediately satisfied');return value
  argv=['runner','--app',str(self.app),'--identifier',self.identifier,'--receipt',str(self.receipt_path)]
  with self.patched(),mock.patch.object(smoke.sys,'argv',argv),mock.patch.object(smoke.subprocess,'Popen',side_effect=launch),mock.patch.object(smoke,'rpc',side_effect=rpc),mock.patch.object(smoke,'wait_until',side_effect=wait),mock.patch.object(smoke.os,'kill') as kill,mock.patch.object(smoke.subprocess,'run',return_value=mock.Mock(stdout=b'',stderr=b'Another background instance')),mock.patch.object(smoke,'print',create=True):smoke.main()
  self.assertEqual(len(children),2);self.assertEqual(len(records),2)
  self.assertEqual([e[2] for e in events if e[0]=='spawn'],['b'*64,'d'*64])
  self.assertEqual(records['fixture-1'],'needs_attention')
  self.assertTrue(all(call.args[1]==0 for call in kill.call_args_list),'PID-only signals must remain liveness-only')

 def test_f7_declared_executable_and_runtime_must_be_regular_files(self):
  for path,key in [(self.exe,'binary_sha256'),(self.resource,'terminal_resource_sha256')]:
   with self.subTest(path=path):
    before=path.read_bytes();path.unlink();path.mkdir()
    self.receipt[key]=performance.digest(path);self.receipt['package_sha256']=performance.digest(self.app);self.receipt['resources_sha256']=performance.digest(self.app/'Contents/Resources');self.save()
    with self.patched(),self.assertRaises(ValueError):self.preflight()
    path.rmdir();path.write_bytes(before)
    self.receipt[key]=performance.digest(path);self.receipt['package_sha256']=performance.digest(self.app);self.receipt['resources_sha256']=performance.digest(self.app/'Contents/Resources');self.save()

 def test_f7_current_repository_input_map_is_executable(self):
  manifest, digest = smoke.current_product_source()
  for name in ["apps/desktop/pnpm-lock.yaml", "apps/desktop/src/App.tsx", "apps/desktop/src-tauri/src/lib.rs", "scripts/build-terminal-runtime.py", "scripts/third-party-notices/manifest.json"]:
   self.assertIn(name, manifest)
  self.assertEqual(len(digest), 64)
  self.assertTrue(all(len(value) == 64 for value in manifest.values()))

 def later_launch_drift(self, stage, source=False):
  owner=self.owner_child(); desktop=self.owner_child(5678); launches=[]; runs=[]; records={}; receipts={}
  def drift():
   (self.input if source else self.exe).write_bytes(b'changed after initial accepted gate')
  def launch(argv, **kwargs):
   launches.append(argv)
   if len(launches)>({'initial_gui':1,'duplicate':2,'reopen':2}[stage]):
    raise ValueError('mock intercepted forbidden later launch')
   if len(launches)==1:
    self.root.joinpath('background').mkdir(parents=True)
    connection=self.root/'background/connection.json'
    connection.write_text(json.dumps({'version':2,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64}));connection.chmod(0o600)
    return owner
   return desktop
  def rpc(desc,client,id,command,arguments=None,**kwargs):
   if command=='ping':return {'ready':True}
   if command=='background_status':return {'pid':owner.pid,'desktop_connected':len(launches)>1 and desktop.poll() is None,'active_sessions':1}
   if command=='get_notification_pause_state':return {'revision':0,'owner_instance':desc['instance']}
   if command=='set_notification_paused':
    if stage=='initial_gui':drift()
    return {'owner_instance':desc['instance'],'paused':True}
   if command=='create_session':
    key=(client,id)
    if key not in receipts:receipts[key]='fixture';records['fixture']='running'
    return {'session_id':receipts[key]}
   if command=='read_session_snapshot':return {'data':'YAM_BG_PID=98765 YAM_QUERY_1=PASSED YAM_QUERY_2=PASSED'}
   if command=='read_terminal_frame':return {'projection':{'buffer':'alternate','data':'中'}}
   if command=='write_session':return 'Another controls this terminal' if kwargs.get('error') else None
   if command=='take_terminal_control':return 'Unknown session' if kwargs.get('error') else None
   if command=='list_sessions':
    if stage=='duplicate':drift()
    return [{'summary':{'session_id':'fixture'},'status':records['fixture']}]
   if command=='stop_session':records['fixture']='stopped';return None
   if command=='shutdown':return None
   self.fail('Unexpected command '+command)
  def run(argv,**kwargs):
   runs.append(argv);return mock.Mock(stderr=b'Another background instance')
  def sleep(seconds):
   self.assertEqual(seconds,6)
   if stage=='reopen':drift()
  argv=['runner','--app',str(self.app),'--identifier',self.identifier,'--receipt',str(self.receipt_path),'--desktop']
  with self.patched(),mock.patch.object(smoke,'current_product_source',side_effect=lambda:({'source.ts':performance.digest(self.input)},performance.digest(self.input))),mock.patch.object(smoke.sys,'argv',argv),mock.patch.object(smoke.subprocess,'Popen',side_effect=launch),mock.patch.object(smoke.subprocess,'run',side_effect=run),mock.patch.object(smoke,'rpc',side_effect=rpc),mock.patch.object(smoke,'wait_until',side_effect=lambda fn,*args:fn()),mock.patch.object(smoke.os,'kill'),mock.patch.object(smoke.time,'sleep',side_effect=sleep):
   with self.assertRaises(ValueError):smoke.main()
  self.assertEqual(len(runs),1 if stage=='reopen' else 0,'drift reached duplicate-owner launch')
  self.assertEqual(len(launches),1 if stage=='initial_gui' else 2,'drift reached a later process launch')
  self.assertGreater(owner.wait.call_count,0,'owned background must still be reclaimed')
 def test_f7_initial_gui_rejects_package_drift(self):self.later_launch_drift('initial_gui')
 def test_f7_initial_gui_rejects_source_drift(self):self.later_launch_drift('initial_gui',True)
 def test_f7_duplicate_owner_rejects_package_drift(self):self.later_launch_drift('duplicate')
 def test_f7_duplicate_owner_rejects_source_drift(self):self.later_launch_drift('duplicate',True)
 def test_f7_reopened_gui_rejects_package_drift(self):self.later_launch_drift('reopen')
 def test_f7_reopened_gui_rejects_source_drift(self):self.later_launch_drift('reopen',True)
