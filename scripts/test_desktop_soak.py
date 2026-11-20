"""Author: Jeff.Liu. Test soak validation and scoped cleanup without launching apps."""
import importlib.util,json,pathlib,tempfile,unittest,signal,sys,ast
from unittest.mock import Mock,patch
SOURCE=pathlib.Path(__file__).with_name('desktop-soak.py')
class DesktopSoakTests(unittest.TestCase):
 def setUp(self):
  self.assertTrue(SOURCE.exists(),'desktop soak acceptance runner must exist')
  spec=importlib.util.spec_from_file_location('desktop_soak',SOURCE);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def sample(self,elapsed=60,offset=10):
  return {'elapsed':elapsed,'owner':{'pid':12,'runtime_pid':13},'records':[{'id':'s-own','status':'running','cwd':'/fixture/own','offset':offset}],'memory':{'application_bytes':1024},'issues':[]}
 def test_phases_have_eight_then_sixteen_with_full_duration_boundary(self):
  self.assertEqual([self.m.phase_count(x,28800) for x in [0,14399,14400,28800]],[8,8,16,16])
 def test_valid_sample_and_monotonic_progress(self):
  previous=self.sample();current=self.sample(120,11);self.m.validate_sample(current,previous,['s-own'],{'pid':12,'runtime_pid':13},'/fixture/own')
 def test_stall_owner_change_missing_session_and_metric_gap_are_rejected(self):
  for changed in [dict(offset=10),dict(status='stopped')]:
   current=self.sample(120,11);current['records'][0].update(changed)
   with self.assertRaises(ValueError):self.m.validate_sample(current,self.sample(),['s-own'],{'pid':12,'runtime_pid':13},'/fixture/own')
  for field,value in [('owner',{'pid':14,'runtime_pid':13}),('records',[]),('memory',{'application_bytes':None}),('issues',['missing process'])]:
   current=self.sample(120,11);current[field]=value
   with self.assertRaises(ValueError):self.m.validate_sample(current,self.sample(),['s-own'],{'pid':12,'runtime_pid':13},'/fixture/own')
 def test_first_observation_cannot_hide_a_long_initial_gap(self):
  with self.assertRaises(ValueError):self.m.validate_sample(self.sample(500),None,['s-own'],{'pid':12,'runtime_pid':13},'/fixture/own')
 def test_wall_clock_gap_is_not_counted_as_continuous_observation(self):
  first=self.sample();first['wall_time']=1000
  current=self.sample(120,11);current['wall_time']=5000
  with self.assertRaises(ValueError):self.m.validate_sample(current,first,['s-own'],{'pid':12,'runtime_pid':13},'/fixture/own')
 def test_coalition_inventory_precedes_process_snapshot_for_new_members(self):
  born=False;app=str(self.m.APP)
  processes={1:{'parent':0,'started':'old','executable':app+'/Contents/MacOS/yam-desktop'},2:{'parent':1,'started':'old','executable':app+'/Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background'},3:{'parent':2,'started':'old','executable':'/fixture/node'},4:{'parent':1,'started':'new','executable':'/fixture/system-service'}}
  def output(argv,**kwargs):
   nonlocal born
   if argv[0]=='lsappinfo':born=True;return 'apps'
   return 'new' if born else 'old'
  collector=Mock();collector.parse_processes.side_effect=lambda text:processes if text=='new' else {k:v for k,v in processes.items() if k!=4};collector.parse_apps.return_value=[{'bundle':'com.yam.desktop'}];collector.root_app.return_value={'pid':1,'members':[1,4]};collector.native_metrics.return_value={k:{'phys_footprint_bytes':1000,'cpu_seconds':1} for k in processes}
  observer=Mock(pid=99,returncode=0)
  def inventory(**_kwargs):
   nonlocal born
   born=True;return ('apps','')
  observer.communicate.side_effect=inventory
  with patch.object(self.m.subprocess,'Popen',return_value=observer),patch.object(self.m.subprocess,'check_output',side_effect=output):sample=self.m.memory_sample({'pid':2,'runtime_pid':3,'desktop_connected':True},collector)
  self.assertEqual(sample['issues'],[]);self.assertEqual(sample['application_bytes'],4000)
 def test_only_this_measurements_inventory_child_is_excluded(self):
  app=str(self.m.APP);processes={1:{'parent':0,'started':'old','executable':app+'/Contents/MacOS/yam-desktop'},2:{'parent':1,'started':'old','executable':app+'/Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background'},3:{'parent':2,'started':'old','executable':'/fixture/node'}}
  collector=Mock();collector.parse_processes.return_value=processes;collector.parse_apps.return_value=[{'bundle':'com.yam.desktop'}];collector.root_app.return_value={'pid':1,'members':[1,4]};collector.native_metrics.return_value={k:{'phys_footprint_bytes':1000,'cpu_seconds':1} for k in processes};observer=Mock(pid=4,returncode=0);observer.communicate.return_value=('apps','')
  with patch.object(self.m.subprocess,'Popen',return_value=observer),patch.object(self.m.subprocess,'check_output',return_value='records'):
   sample=self.m.memory_sample({'pid':2,'runtime_pid':3,'desktop_connected':True},collector)
   self.assertEqual(sample['issues'],[]);self.assertEqual(sample['application_bytes'],3000)
   collector.root_app.return_value={'pid':1,'members':[1,4,5]}
   sample=self.m.memory_sample({'pid':2,'runtime_pid':3,'desktop_connected':True},collector);self.assertTrue(sample['issues'],'an unrelated missing application member must remain a failure')
 def test_stabilization_keeps_each_failed_attempt_and_returns_a_complete_observation(self):
  seen=[];identity={'1':['old','gui']};partial={'application_bytes':None,'issues':['auxiliary sampler exited'],'critical_identities':identity,'critical_issues':[]};complete={**partial,'application_bytes':1000,'issues':[]}
  with patch.object(self.m,'memory_sample',side_effect=[partial,complete]):
   result=self.m.observe_memory({},None,identity,lambda row:seen.append(row),clock=lambda:0,sleep=lambda _:None)
  self.assertEqual(result[0],complete);self.assertEqual(len(seen),2);self.assertTrue(seen[0]['memory']['issues']);self.assertEqual(result[1],2)
 def test_stabilization_never_retries_a_critical_identity_change(self):
  seen=[];sample={'application_bytes':None,'issues':['missing core'],'critical_identities':{'2':['new','gui']},'critical_issues':[]}
  with patch.object(self.m,'memory_sample',return_value=sample) as probe:
   with self.assertRaises(ValueError):self.m.observe_memory({},None,{'1':['old','gui']},lambda row:seen.append(row),clock=lambda:0,sleep=lambda _:None)
  self.assertEqual(probe.call_count,1);self.assertEqual(len(seen),1)
 def test_stabilization_has_a_three_attempt_and_two_second_bound(self):
  partial={'application_bytes':None,'issues':['auxiliary gap'],'critical_identities':{},'critical_issues':[]};seen=[]
  with patch.object(self.m,'memory_sample',return_value=partial) as probe:
   with self.assertRaises(ValueError):self.m.observe_memory({},None,{},lambda row:seen.append(row),clock=lambda:0,sleep=lambda _:None)
  self.assertEqual(probe.call_count,3);self.assertEqual(len(seen),3)
  now=[0.0]
  def slow(*_):now[0]+=2.1;return {**partial,'application_bytes':1000,'issues':[]}
  with patch.object(self.m,'memory_sample',side_effect=slow):
   with self.assertRaises(ValueError):self.m.observe_memory({},None,{},lambda row:None,clock=lambda:now[0],sleep=lambda _:None)
 def test_initial_unknown_member_gap_cannot_become_a_smaller_core_baseline(self):
  seen=[];partial={'application_bytes':None,'issues':['unclassified missing GPU'],'critical_identities':{},'critical_issues':[]};complete={**partial,'application_bytes':1000,'issues':[]}
  with patch.object(self.m,'memory_sample',side_effect=[partial,complete]) as probe:
   with self.assertRaises(ValueError):self.m.observe_memory({},None,None,seen.append,clock=lambda:0,sleep=lambda _:None)
  self.assertEqual(probe.call_count,1)
 def test_an_exception_is_also_a_persisted_raw_attempt(self):
  seen=[]
  with patch.object(self.m,'memory_sample',side_effect=ValueError('GUI unavailable')):
   with self.assertRaises(ValueError):self.m.observe_memory({},None,{},seen.append,clock=lambda:0,sleep=lambda _:None)
  self.assertEqual(len(seen),1);self.assertIn('ValueError',seen[0]['error'])
 def replay(self,root):
  identity={'1':['birth','gui'],'12':['birth','owner'],'13':['birth','node']};ids=[{'session_id':'s-'+str(i)} for i in range(16)];samples=[];attempts=[]
  for index,elapsed in enumerate(range(0,61,10),1):
   memory={'application_bytes':1000,'issues':[],'critical_identities':identity,'critical_issues':[]};sample={'elapsed':elapsed,'phase_elapsed':elapsed,'wall_time':100000+elapsed,'interval':10,'owner':{'pid':12,'runtime_pid':13},'records':[{'id':r['session_id'],'status':'running','cwd':'/fixture/own','offset':elapsed+1} for r in ids[:(8 if elapsed<30 else 16)]],'memory':memory,'memory_attempts':1,'memory_window_seconds':.1,'issues':[]};samples.append(sample);attempts.append({'observation':index,'attempt':1,'window_seconds':.1,'memory':dict(memory)})
  def save(name,value):
   (root/name).write_text(''.join(json.dumps(r)+'\n' for r in value) if name.endswith('.jsonl') else json.dumps(value))
  save('samples.jsonl',samples);save('memory-attempts.jsonl',attempts);save('created.jsonl',ids);save('cleanup.json',[{'id':r['session_id'],'status':'stopped'} for r in ids]);save('manifest.json',{'duration':60,'interval':10,'sampling_window_seconds':2,'sampling_attempt_limit':3,'critical_processes':identity,'owner':{'pid':12,'runtime_pid':13},'project':'/fixture/own','package':{}});save('result.json',{'status':'pass','duration':60,'elapsed':60,'cleaned':True,'sample_count':7,'memory_attempts':7,'package':{}})
  return samples,attempts,save
 def test_valid_replay_passes_but_failed_nested_memory_never_does(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);samples,attempts,save=self.replay(root);self.m.verify(root,60)
   samples[-1]['memory']['issues']=['failed measurement'];attempts[-1]['memory']['issues']=['failed measurement'];save('samples.jsonl',samples);save('memory-attempts.jsonl',attempts)
   with self.assertRaises(ValueError):self.m.verify(root,60)
 def test_final_poll_does_not_shorten_output_interval_to_a_fraction_of_a_second(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);home=root/'home';path=home/'Library/Application Support/com.yam.desktop/background/connection.json';path.parent.mkdir(parents=True);path.write_text('{}');clock=[0.0];delays=[];created={};running=set();offsets={};policy={'policy':'all','revision':0};measurements=[0]
   def rpc(_d,_c,_seq,name,args=None,**kwargs):
    if name=='background_status':return {'pid':12,'runtime_pid':13,'desktop_connected':False}
    if name=='project_notification_policy':
     if args['request']['action']=='set':policy.update(policy=args['request']['policy'],revision=policy['revision']+1)
     return dict(policy)
    if name=='create_session':
     sid='s-'+str(len(created));created[sid]={'session_id':sid,**args};running.add(sid);offsets[sid]=0;return dict(created[sid])
    sid=args['session_id']
    if name=='get_session':return {'summary':created[sid],'status':'running' if sid in running else 'stopped'}
    if name=='stop_session':running.discard(sid);return None
    if name=='read_session_snapshot':offsets[sid]+=10;return {'end_offset':offsets[sid]}
    raise AssertionError(name)
   def pause(seconds):delays.append(seconds);clock[0]+=seconds
   def measure(*_):
    measurements[0]+=1;clock[0]=29.9 if measurements[0]==5 else clock[0]+.25
    return {'application_bytes':1000,'issues':[],'critical_identities':{'1':['birth','gui']},'critical_issues':[]}
   fake=Mock();fake.rpc=rpc
   with patch.object(self.m,'load',return_value=fake),patch.object(self.m,'package',return_value={}),patch.object(self.m,'PROJECT_ROOT',root),patch.object(self.m.pathlib.Path,'home',return_value=home),patch.object(self.m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(self.m.time,'sleep',side_effect=pause),patch.object(self.m,'memory_sample',side_effect=measure):self.m.run(root/'result',30,5)
   self.assertGreaterEqual(min(delays),1,'final snapshot must not race a one-second output producer')
 def test_cleanup_stops_only_verified_owned_records_and_keeps_other_tasks(self):
  calls=[]
  def rpc(name,args=None):
   calls.append((name,args));return {'summary':{'cwd':'/fixture/own','command':'owned command'},'status':'running'} if name=='get_session' else None
  self.m.cleanup_owned(rpc,[{'session_id':'s-own','command':'owned command'}],'/fixture/own')
  self.assertEqual(calls,[('get_session',{'session_id':'s-own'}),('stop_session',{'session_id':'s-own'})])
 def test_cleanup_refuses_changed_identity_and_does_not_hide_failures(self):
  rpc=Mock(return_value={'summary':{'cwd':'/other','command':'owned command'},'status':'running'})
  with self.assertRaises(ValueError):self.m.cleanup_owned(rpc,[{'session_id':'s-own','command':'owned command'}],'/fixture/own')
  self.assertEqual(rpc.call_count,1)
 def test_lost_create_response_can_only_reconcile_exact_project_and_command(self):
  def rpc(name,args):
   if name=='list_session_summaries':return {'items':[{'summary':{'session_id':'s-own','cwd':'/fixture/own'}},{'summary':{'session_id':'s-other','cwd':'/other'}}]}
   return {'summary':{'session_id':'s-own','cwd':'/fixture/own','command':'owned command'}}
  self.assertEqual(self.m.reconcile_creation(rpc,'/fixture/own','owned command')['session_id'],'s-own')
  with self.assertRaises(ValueError):self.m.reconcile_creation(rpc,'/fixture/own','another command')
 def failing_creation(self,signal_stop=False,signal_during_cleanup=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);home=root/'home';connection=home/'Library/Application Support/com.yam.desktop/background/connection.json';connection.parent.mkdir(parents=True);connection.write_text('{}')
   output=root/'observations';calls=[];created=[];policy={'policy':'all','revision':0};status='running'
   def rpc(_d,_c,_seq,name,args=None,**kwargs):
    nonlocal status
    calls.append((name,args))
    if name=='background_status':return {'pid':12,'runtime_pid':13,'desktop_connected':False}
    if name=='project_notification_policy':
     if args['request']['action']=='set':policy.update(policy=args['request']['policy'],revision=policy['revision']+1)
     return dict(policy)
    if name=='create_session':
     if created:
      if signal_stop:signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
      raise RuntimeError('creation response lost')
     created.append({'session_id':'s-own',**args});return dict(created[0])
    if name=='list_session_summaries':return {'items':[]}
    if name=='get_session':
     if signal_during_cleanup:signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
     return {'summary':dict(created[0]),'status':status}
    if name=='stop_session':status='stopped';return None
    raise AssertionError(name)
   fake=Mock();fake.rpc=rpc
   with patch.object(self.m,'load',return_value=fake),patch.object(self.m,'package',return_value={}),patch.object(self.m.pathlib.Path,'home',return_value=home):
    if hasattr(self.m,'PROJECT_ROOT'):
     with patch.object(self.m,'PROJECT_ROOT',root):self.invoke_failure(output,signal_stop or signal_during_cleanup)
    else:self.invoke_failure(output,signal_stop or signal_during_cleanup)
   self.assertEqual([args['session_id'] for name,args in calls if name=='stop_session'],['s-own'])
   self.assertEqual(status,'stopped');self.assertFalse(json.loads((output/'result.json').read_text())['cleaned'])
 def invoke_failure(self,output,signal_stop):
  if signal_stop:
   old=signal.getsignal(signal.SIGTERM)
   with patch.object(sys,'argv',['desktop-soak.py','run','--output',str(output),'--duration-seconds','30','--interval','5']):
    try:self.m.main()
    except BaseException as error:self.assertIsInstance(error,ValueError)
    else:self.fail('failed acceptance must report failure')
   self.assertEqual(signal.getsignal(signal.SIGTERM),old)
  else:
   with self.assertRaises(ValueError):self.m.run(output,30,5)
 def test_uncertain_reconciliation_never_skips_already_owned_cleanup(self):self.failing_creation()
 def test_sigterm_runs_scoped_cleanup_and_restores_the_handler(self):
  # Before the fix SIG_DFL is not callable; this still exercises the failed cleanup assertion.
  self.failing_creation(signal_stop=True)
 def test_first_sigterm_during_cleanup_does_not_interrupt_remaining_cleanup(self):
  self.failing_creation(signal_during_cleanup=True)
 def test_sparse_eight_hour_claim_cannot_override_manifest_interval(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);ids=[{'session_id':'s-'+str(i)} for i in range(16)]
   rows=[]
   for elapsed in [0,14400,28800]:
    count=8 if elapsed<14400 else 16
    rows.append({'elapsed':elapsed,'phase_elapsed':elapsed,'interval':14400,'wall_time':100000+elapsed,'owner':{'pid':12,'runtime_pid':13},'records':[{'id':r['session_id'],'status':'running','cwd':'/fixture/own','offset':elapsed+1} for r in ids[:count]],'memory':{'application_bytes':1024},'issues':[]})
   (root/'samples.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(root/'created.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in ids));(root/'cleanup.json').write_text(json.dumps([{'id':r['session_id'],'status':'stopped'} for r in ids]))
   (root/'manifest.json').write_text(json.dumps({'duration':28800,'interval':60,'owner':{'pid':12,'runtime_pid':13},'project':'/fixture/own','package':{}}));(root/'result.json').write_text(json.dumps({'duration':28800,'elapsed':28800,'status':'pass','cleaned':True,'sample_count':3,'package':{}}))
   with self.assertRaises(ValueError):self.m.verify(root,28800)
 def test_verifier_refuses_short_duration_partial_samples_and_missing_cleanup(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'samples.jsonl').write_text(json.dumps(self.sample())+'\n')
   summary={'status':'pass','elapsed':60,'duration':60,'cleaned':True}
   (root/'result.json').write_text(json.dumps(summary))
   with self.assertRaises(ValueError):self.m.verify(root,28800)
   summary.update(elapsed=28800,duration=28800,cleaned=False);(root/'result.json').write_text(json.dumps(summary))
   with self.assertRaises(ValueError):self.m.verify(root,28800)
 def growth_samples(self):
  rows=[]
  for elapsed in range(0,28801,60):
   roles=[('com.apple.WebKit.WebContent',100),('com.apple.WebKit.GPU',60),('node',80 if elapsed<14400 else 140)]
   processes=[{'executable':'/fixture/'+name,'phys_footprint_bytes':mib*1048576}for name,mib in roles]
   rows.append({'elapsed':elapsed,'phase_elapsed':elapsed,'memory':{'application_bytes':sum(r['phys_footprint_bytes']for r in processes)+40*1048576,'processes':processes}})
  return rows
 def growth(self,rows):
  fn=getattr(self.m,'memory_growth',None);self.assertTrue(callable(fn),'eight-hour acceptance must check stable phase memory, not duration alone');return fn(rows,28800)
 def test_growth_accepts_bounded_phases_without_treating_sixteen_tasks_as_a_leak(self):
  result=self.growth(self.growth_samples());self.assertTrue(result['pass']);self.assertEqual(len(result['phases']),2)
 def test_growth_rejects_each_page_gpu_node_and_total_increase(self):
  for role in ['com.apple.WebKit.WebContent','com.apple.WebKit.GPU','node',None]:
   rows=self.growth_samples()
   for r in rows:
    if 10800<=r['phase_elapsed']<14400:
     r['memory']['application_bytes']+=100*1048576
     if role:
      next(p for p in r['memory']['processes']if p['executable'].endswith('/'+role))['phys_footprint_bytes']+=100*1048576
   self.assertFalse(self.growth(rows)['pass'],role)
 def test_growth_has_an_explicit_absolute_and_relative_boundary(self):
  rows=self.growth_samples()
  for r in rows:
   if 10800<=r['phase_elapsed']<14400:
    r['memory']['processes'][0]['phys_footprint_bytes']+=16*1048576;r['memory']['application_bytes']+=16*1048576
  self.assertTrue(self.growth(rows)['pass'])
  for r in rows:
   if 10800<=r['phase_elapsed']<14400:r['memory']['processes'][0]['phys_footprint_bytes']+=1;r['memory']['application_bytes']+=1
  self.assertFalse(self.growth(rows)['pass'])
 def test_growth_refuses_missing_roles_sparse_windows_and_invalid_values(self):
  for change in [lambda rows:rows[65]['memory']['processes'].pop(),lambda rows:rows[65]['memory'].update(application_bytes=None),lambda rows:rows.__setitem__(slice(None),rows[::10])]:
   rows=self.growth_samples();change(rows)
   with self.assertRaises(ValueError):self.growth(rows)
 def test_workload_script_can_exercise_sgr_without_changing_default_or_using_models(self):
  fn=getattr(self.m,'workload_script',lambda *_args,**_kw:'')
  for ansi in [False,True]:
   script=fn(28800,'fixture',0,ansi=ansi);self.assertIn('YAM_SOAK_fixture_0',script);tree=ast.parse(script);values=[n.value for n in ast.walk(tree)if isinstance(n,ast.Constant)and isinstance(n.value,str)];prefix=next(v for v in values if 'YAM_SOAK_fixture_0'in v);self.assertEqual(prefix.startswith('\x1b['),ansi);self.assertNotIn('openai',script);self.assertNotIn('subprocess',script)
if __name__=='__main__':unittest.main()
