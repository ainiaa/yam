#!/usr/bin/env python3
"""Author: Jeff.Liu. Explicit live acceptance; never launches apps or touches unowned tasks."""
import argparse,datetime,hashlib,importlib.util,json,math,pathlib,plistlib,secrets,shlex,shutil,signal,statistics,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parent.parent
PROJECT_ROOT=pathlib.Path('/private/tmp')
APP=ROOT/'apps/desktop/src-tauri/target/debug/bundle/macos/YAM.app'

def load(name,filename):
 spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(filename));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def phase_count(elapsed,duration):return 8 if elapsed<duration/2 else 16

def workload_script(seconds,token,index,ansi=False):
 label=('\x1b[38;2;20;180;90m' if ansi else '')+f'YAM_SOAK_{token}_{index}'
 suffix='中文🙂'+('\x1b[0m' if ansi else '')
 return f"import os,time\nend=time.monotonic()+{seconds!r}\ni=0\nwhile time.monotonic()<end:\n print({label!r},os.getpid(),i,{suffix!r},flush=True);i+=1;time.sleep(1)"

def memory_growth(samples,duration):
 if type(duration) not in (int,float) or duration!=28800:raise ValueError('Growth acceptance requires the full eight-hour contract')
 phases=[]
 for start,tasks in [(0,8),(14400,16)]:
  windows=[(start+3600,start+7200),(start+10800,start+14400)]
  values=[]
  for lower,upper in windows:
   selected=[s for s in samples if lower<=s.get('phase_elapsed',s['elapsed'])<upper]
   if len(selected)<50:raise ValueError('Stable phase window has fewer than fifty observations')
   roles={'total':[],'page':[],'gpu':[],'node':[]}
   for row in selected:
    memory=row['memory'];total=memory['application_bytes']
    if type(total) is not int or total<=0:raise ValueError('Invalid total memory in growth window')
    roles['total'].append(total)
    for role,name in [('page','com.apple.WebKit.WebContent'),('gpu','com.apple.WebKit.GPU'),('node','node')]:
     matched=[p.get('phys_footprint_bytes') for p in memory['processes']if pathlib.Path(p['executable']).name==name]
     if len(matched)!=1 or type(matched[0]) is not int or matched[0]<=0:raise ValueError('Growth window requires exactly one complete '+role+' process')
     roles[role].append(matched[0])
   values.append({k:statistics.median(v)for k,v in roles.items()})
  metrics={}
  for role in values[0]:
   first,last=values[0][role],values[1][role];allowed=max(16*1048576,first*.15)
   metrics[role]={'first_median_mib':first/1048576,'last_median_mib':last/1048576,'growth_mib':(last-first)/1048576,'maximum_growth_mib':allowed/1048576,'pass':last-first<=allowed}
  phases.append({'tasks':tasks,'windows_seconds':windows,'metrics':metrics,'pass':all(v['pass']for v in metrics.values())})
 return {'pass':all(p['pass']for p in phases),'contract':'Compare each phase second-hour and fourth-hour medians independently; maximum increase max(16MiB,15%); >=50 complete observations per window','phases':phases,'limits':'bounded growth acceptance, not proof of zero leaks; phase expansion and first-hour buffer warmup are reported separately'}

def validate_sample(sample,previous,ids,owner,project):
 if sample['issues'] or not isinstance(sample['memory'].get('application_bytes'),int) or sample['memory']['application_bytes']<=0:raise ValueError('Incomplete memory observation')
 if any(sample['owner'].get(k)!=owner[k] for k in ['pid','runtime_pid']):raise ValueError('Original background identity changed')
 records={r['id']:r for r in sample['records']}
 if len(records)!=len(sample['records']) or set(records)!=set(ids):raise ValueError('Owned session set changed')
 old={r['id']:r for r in previous['records']} if previous else {}
 if not previous and not 0<=sample['elapsed']<=sample.get('interval',60)*2.5:raise ValueError('Initial observation gap')
 if previous and not 0<sample['elapsed']-previous['elapsed']<=sample.get('interval',60)*2.5:raise ValueError('Observation interval gap')
 if previous and 'wall_time' in sample and 'wall_time' in previous and abs((sample['wall_time']-previous['wall_time'])-(sample['elapsed']-previous['elapsed']))>10:raise ValueError('Wall-clock gap or clock adjustment')
 for sid,r in records.items():
  if r['status']!='running' or r['cwd']!=project:raise ValueError('Owned task ended or changed project')
  if sid in old and r['offset']<=old[sid]['offset']:raise ValueError('Owned output stopped advancing')

def reconcile_creation(call,project,command):
 page=call('list_session_summaries',{'request':{'page_size':100,'cursor':None,'query':project,'status':'all','matched_session_ids':[],'matched_project_paths':[]}})
 matches=[]
 for item in page['items']:
  if item['summary']['cwd']!=project:continue
  record=call('get_session',{'session_id':item['summary']['session_id']})
  if record['summary']['cwd']==project and record['summary']['command']==command:matches.append(record['summary'])
 if len(matches)!=1:raise ValueError('Creation result remains uncertain; preserve pending-create evidence')
 return matches[0]

def cleanup_owned(call,owned,project):
 errors=[]
 for row in owned:
  try:
   record=call('get_session',{'session_id':row['session_id']})
   if record['summary']['cwd']!=project or record['summary']['command']!=row['command']:raise ValueError('Owned task identity changed')
   if record['status'] in ['running','starting']:call('stop_session',{'session_id':row['session_id']})
  except Exception as error:errors.append(type(error).__name__)
 if errors:raise ValueError('Scoped cleanup incomplete: '+','.join(errors))

def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def package():
 info=plistlib.loads((APP/'Contents/Info.plist').read_bytes())
 if info['CFBundleIdentifier']!='com.yam.desktop' or APP.name!='YAM.app':raise ValueError('Only the canonical YAM bundle is allowed')
 files=[APP/'Contents/Info.plist',APP/'Contents/MacOS'/info['CFBundleExecutable'],APP/'Contents/Helpers/YAM Background.app/Contents/MacOS/yam-background']
 return {str(p.relative_to(ROOT)):digest(p) for p in files}

def memory_sample(owner,collector):
 command=['ps','-axo','pid=,ppid=,rss=,lstart=,comm=']
 observer=subprocess.Popen(['lsappinfo','list'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:inventory,errors=observer.communicate(timeout=10)
 except BaseException:
  observer.kill();observer.communicate(timeout=10);raise
 if observer.returncode:raise subprocess.CalledProcessError(observer.returncode,['lsappinfo','list'],inventory,errors)
 apps=collector.parse_apps(inventory)
 before=collector.parse_processes(subprocess.check_output(command,text=True,timeout=10))
 roots=[a for a in apps if a['bundle']=='com.yam.desktop'];issues=[]
 if len(roots)>1:raise ValueError('Multiple GUI instances')
 root=collector.root_app('com.yam.desktop',roots) if roots else None
 if owner['desktop_connected'] and not root:raise ValueError('GUI coalition unavailable')
 core={owner['pid'],owner['runtime_pid']}
 if any(pid not in before for pid in core) or before[owner['runtime_pid']]['parent']!=owner['pid']:raise ValueError('Owner/parser identity unavailable')
 if not before[owner['pid']]['executable'].startswith(str(APP)+'/'):raise ValueError('Owner outside canonical bundle')
 if root and not before[root['pid']]['executable'].startswith(str(APP)+'/'):raise ValueError('GUI outside canonical bundle')
 workloads={pid for pid,row in before.items() if row['parent']==owner['pid'] and pid!=owner['runtime_pid']}
 while True:
  expanded=workloads|{pid for pid,row in before.items() if row['parent'] in workloads}
  if expanded==workloads:break
  workloads=expanded
 ids=(set(root['members']) if root else set())|core;ids-=workloads|{observer.pid}
 metrics=collector.native_metrics(sorted(ids));after=collector.parse_processes(subprocess.check_output(command,text=True,timeout=10))
 critical=core|({root['pid']} if root else set())|{pid for pid in ids if pathlib.Path(before.get(pid,{}).get('executable','')).name in {'com.apple.WebKit.WebContent','com.apple.WebKit.GPU'}}
 critical_issues=[]
 for pid in ids:
  if pid not in after or pid not in before or any(before[pid][key]!=after[pid][key] for key in ['started','executable']) or pid not in metrics:
   issues.append(f'Process {pid} identity or metric gap: before={pid in before}, after={pid in after}, metric={pid in metrics}')
   if pid in critical:critical_issues.append(pid)
 return {'application_bytes':None if issues else sum(metrics[pid]['phys_footprint_bytes'] for pid in ids),'processes':[{'pid':pid,'executable':before.get(pid,after.get(pid,{})).get('executable'),**metrics.get(pid,{})} for pid in sorted(ids)],'gui_pid':root['pid'] if root else None,'issues':issues,'critical_identities':{str(pid):[before[pid]['started'],before[pid]['executable']] for pid in sorted(critical) if pid in before},'critical_issues':critical_issues,'excluded_observer_pid':observer.pid,'metric':'per-process physical footprint sum; shared pages are not deduplicated; PTY workloads and this owned inventory tool excluded'}

def observe_memory(owner,collector,expected,record,clock=time.monotonic,sleep=time.sleep):
 started=clock()
 for attempt in range(1,4):
  try:memory=memory_sample(owner,collector)
  except Exception as error:
   record({'attempt':attempt,'window_seconds':clock()-started,'memory':None,'error':type(error).__name__+': '+str(error)})
   raise
  elapsed=clock()-started
  record({'attempt':attempt,'window_seconds':elapsed,'memory':memory})
  if expected is None:
   if memory['issues']:raise ValueError('Initial process baseline requires one complete inventory')
   expected=memory['critical_identities']
  if memory['critical_issues'] or memory['critical_identities']!=expected:raise ValueError('Critical application process identity or metric changed')
  if elapsed>2:raise ValueError('Memory observation exceeded the two-second window')
  if not memory['issues'] and memory['application_bytes'] is not None:return memory,attempt,elapsed
  if attempt<3:sleep(.3)
 raise ValueError('No complete memory observation within the bounded window')

def run(output,duration,interval,should_stop=lambda:False,*,ansi=False):
 def check_stop():
  if should_stop():raise InterruptedError("acceptance stop requested")
 if not 30<=duration<=28800 or not 1<=interval<=60 or interval>duration/3:raise ValueError('Invalid acceptance timing')
 if shutil.disk_usage(ROOT).free<2*1024**3:raise ValueError('At least 2 GiB free disk space required')
 output.mkdir(parents=True,exist_ok=False)
 smoke=load('soak_rpc','background-smoke.py');collector=load('soak_memory','yam-memory.py')
 connection=pathlib.Path.home()/'Library/Application Support/com.yam.desktop/background/connection.json'
 descriptor=json.loads(connection.read_text());client=secrets.token_hex(32);seq=0
 def call(name,args=None):
  nonlocal seq
  seq+=1;return smoke.rpc(descriptor,client,seq,name,args,timeout=10)
 original=call('background_status');pack=package();policy=None;muted=None;critical=None;attempt_count=0;partial_count=0;owned=[];samples=[];problem=None;pending_create=None;cleaned=False;started=time.monotonic();token=secrets.token_hex(12)
 project=PROJECT_ROOT/('yam-soak-'+token);project.mkdir(mode=0o700)
 manifest={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'duration':duration,'interval':interval,'sampling_window_seconds':2,'sampling_attempt_limit':3,'project':str(project),'owner':original,'package':pack,'workload':'one local text line per second per task; first half 8, second half 16; no external models','ansi':ansi,'argv':sys.argv}
 write(output/'manifest.json',manifest)
 try:
  check_stop()
  policy=call('project_notification_policy',{'request':{'action':'get','project':str(project)}})
  muted=call('project_notification_policy',{'request':{'action':'set','project':str(project),'policy':'muted','expected_revision':policy['revision']}})
  with (output/'samples.jsonl').open('x') as log,(output/'created.jsonl').open('x') as journal,(output/'memory-attempts.jsonl').open('x') as attempts:
   while True:
    check_stop()
    elapsed=time.monotonic()-started
    for index in range(len(owned),phase_count(elapsed,duration)):
     check_stop()
     script=workload_script(max(1,duration-elapsed)+180,token,index,ansi)
     command=shlex.join([sys.executable,'-u','-c',script])
     pending_create=command;write(output/'pending-create.json',{'project':str(project),'command':command})
     created=call('create_session',{'cwd':str(project),'command':command});created['command']=command;owned.append(created);journal.write(json.dumps(created)+'\n');journal.flush();pending_create=None
    # Each newly added task gets time to produce its first output.
    if not samples or len(owned)!=len(samples[-1]['records']):time.sleep(2)
    status=call('background_status');records=[]
    for row in owned:
     check_stop()
     record=call('get_session',{'session_id':row['session_id']});snapshot=call('read_session_snapshot',{'session_id':row['session_id']})
     if record['summary']['command']!=row['command']:raise ValueError('Owned command changed')
     records.append({'id':row['session_id'],'cwd':record['summary']['cwd'],'status':record['status'],'offset':snapshot['end_offset']})
    def record_attempt(row):
     nonlocal attempt_count,partial_count
     attempt_count+=1;partial_count+=bool(row.get('error') or (row.get('memory') or {}).get('issues'))
     row.update(observation=len(samples)+1,elapsed=time.monotonic()-started)
     attempts.write(json.dumps(row,ensure_ascii=False)+'\n');attempts.flush();write(output/'latest-memory-attempt.json',row)
    memory,number,window=observe_memory(status,collector,critical,record_attempt)
    if critical is None:
     critical=memory['critical_identities'];manifest['critical_processes']=critical;write(output/'manifest.json',manifest)
    sample={'elapsed':time.monotonic()-started,'phase_elapsed':elapsed,'wall_time':time.time(),'interval':interval,'owner':status,'records':records,'memory':memory,'memory_attempts':number,'memory_window_seconds':window,'issues':memory['issues']}
    write(output/'latest-observation.json',sample)
    validate_sample(sample,samples[-1] if samples else None,[r['session_id'] for r in owned],original,str(project))
    log.write(json.dumps(sample,ensure_ascii=False)+'\n');log.flush();samples.append(sample)
    print(json.dumps({'elapsed':round(sample['elapsed'],2),'tasks':len(owned),'samples':len(samples),'application_bytes':memory['application_bytes']}),flush=True)
    if sample['elapsed']>=duration:break
    time.sleep(interval)
 except BaseException as error:problem=type(error).__name__+': '+str(error)
 finally:
  if pending_create is not None:
   try:
    recovered=reconcile_creation(call,str(project),pending_create);owned.append(recovered)
    with (output/'created.jsonl').open('a') as journal:journal.write(json.dumps(recovered)+'\n')
    pending_create=None
   except Exception as error:problem=(problem+'; ' if problem else '')+'creation reconciliation: '+type(error).__name__
  try:
   cleanup_owned(call,owned,str(project))
   deadline=time.monotonic()+20
   while True:
    rows=[call('get_session',{'session_id':r['session_id']}) for r in owned]
    if all(r['status'] not in ['running','starting'] for r in rows):break
    if time.monotonic()>deadline:raise ValueError('Owned tasks still running after stop')
    time.sleep(.2)
   write(output/'cleanup.json',[{'id':r['summary']['session_id'],'status':r['status']} for r in rows]);cleaned=pending_create is None
  except Exception as error:problem=(problem+'; ' if problem else '')+'cleanup: '+type(error).__name__
  try:
   if muted is not None:
    current=call('project_notification_policy',{'request':{'action':'get','project':str(project)}})
    if current['revision']!=muted['revision']:raise ValueError('Test project policy changed externally')
    call('project_notification_policy',{'request':{'action':'set','project':str(project),'policy':policy['policy'],'expected_revision':current['revision']}})
   if package()!=pack:problem=(problem+'; ' if problem else '')+'package changed'
  except Exception:problem=(problem+'; ' if problem else '')+'package identity unavailable'
  summary={'status':'fail' if problem else 'pass','problem':problem,'duration':duration,'elapsed':samples[-1]['elapsed'] if samples else 0,'cleaned':cleaned,'sample_count':len(samples),'memory_attempts':attempt_count,'incomplete_attempts':partial_count,'owned_ids':[r['session_id'] for r in owned],'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'package':pack}
  if samples:
   memory=[s['memory']['application_bytes'] for s in samples];summary['application_memory']={'median':statistics.median(memory),'minimum':min(memory),'maximum':max(memory),'first_quarter_median':statistics.median(memory[:max(1,len(memory)//4)]),'last_quarter_median':statistics.median(memory[-max(1,len(memory)//4):]),'boundary':'observed trend, not proof of no leaks; user activity may change GUI memory'}
  write(output/'result.json',summary);print(json.dumps(summary),flush=True)
 if problem:raise ValueError(problem)
 return summary

def verify(output,minimum,check_growth=False):
 result=json.loads((output/'result.json').read_text());manifest=json.loads((output/'manifest.json').read_text()) if (output/'manifest.json').exists() else {}
 if result.get('status')!='pass' or not result.get('cleaned') or result.get('elapsed',0)<minimum or result.get('duration',0)<minimum:raise ValueError('Incomplete duration or cleanup')
 interval=manifest.get('interval');duration=manifest.get('duration')
 if type(interval) not in (int,float) or not 1<=interval<=60 or type(duration) not in (int,float) or not 30<=duration<=28800 or duration!=result['duration']:raise ValueError('Invalid frozen timing parameters')
 if manifest.get('sampling_window_seconds')!=2 or manifest.get('sampling_attempt_limit')!=3 or not manifest.get('critical_processes'):raise ValueError('Missing frozen observation contract')
 samples=[json.loads(line) for line in (output/'samples.jsonl').read_text().splitlines()]
 attempts=[json.loads(line) for line in (output/'memory-attempts.jsonl').read_text().splitlines()]
 created=[json.loads(line) for line in (output/'created.jsonl').read_text().splitlines()]
 if len(samples)!=result['sample_count'] or len(samples)<3 or len(created)!=16 or len({r['session_id'] for r in created})!=16:raise ValueError('Incomplete or duplicate observations')
 cleanup=json.loads((output/'cleanup.json').read_text())
 if {r['id'] for r in cleanup}!={r['session_id'] for r in created} or len(cleanup)!=16 or any(r['status'] in ['running','starting'] for r in cleanup):raise ValueError('Incomplete cleanup evidence')
 previous=None;cursor=0
 for observation,sample in enumerate(samples,1):
  count=sample.get('memory_attempts',0)
  if not 1<=count<=3 or not 0<=sample.get('memory_window_seconds',3)<=2:raise ValueError('Invalid observation window')
  if sample['memory'].get('issues') or not isinstance(sample['memory'].get('application_bytes'),int) or sample['memory']['application_bytes']<=0:raise ValueError('Final memory observation is incomplete')
  group=attempts[cursor:cursor+count];cursor+=count
  if len(group)!=count or group[-1]['memory']!=sample['memory']:raise ValueError('Raw observation attempts are incomplete')
  for number,row in enumerate(group,1):
   if row.get('error') or row['memory'] is None:raise ValueError('An exception cannot be an accepted memory attempt')
   if row['observation']!=observation or row['attempt']!=number or row['memory']['critical_issues'] or row['memory']['critical_identities']!=manifest['critical_processes'] or not 0<=row['window_seconds']<=2:raise ValueError('Invalid raw attempt or changed critical process')
  if sample.get('interval')!=interval:raise ValueError('Sample changed the frozen interval')
  count=phase_count(sample.get('phase_elapsed',sample['elapsed']),manifest['duration']);ids=[r['session_id'] for r in created[:count]]
  validate_sample(sample,previous,ids,manifest['owner'],manifest['project']);previous=sample
 if cursor!=len(attempts) or len(attempts)!=result['memory_attempts']:raise ValueError('Unaccounted observation attempts')
 if result['package']!=manifest['package'] or samples[-1]['elapsed']<minimum:raise ValueError('Changed package or short observation')
 if check_growth:
  growth=memory_growth(samples,duration);write(output/'growth.json',growth)
  if not growth['pass']:raise ValueError('Stable phase memory exceeded the frozen growth limit')
 print(json.dumps({'status':'verified','elapsed':result['elapsed'],'sample_count':len(samples),'cleaned':True}))
 return result

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['run','verify']);parser.add_argument('--output',type=pathlib.Path,required=True);parser.add_argument('--duration-seconds',type=float,default=28800);parser.add_argument('--interval',type=float,default=60);parser.add_argument('--minimum-duration',type=float,default=28800);parser.add_argument('--ansi',action='store_true');parser.add_argument('--check-growth',action='store_true');args=parser.parse_args()
 if args.action=='run':
  previous={kind:signal.getsignal(kind) for kind in [signal.SIGTERM,signal.SIGINT]}
  requested=False
  def stop(_kind,_frame):
   nonlocal requested
   requested=True
  try:
   for kind in previous:signal.signal(kind,stop)
   run(args.output,args.duration_seconds,args.interval,lambda:requested,ansi=args.ansi)
  finally:
   for kind,handler in previous.items():signal.signal(kind,handler)
 else:verify(args.output,args.minimum_duration,args.check_growth)
if __name__=='__main__':main()
