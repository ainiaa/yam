"""Author: Jeff.Liu. No sockets, owner, PTY or workload children in these unit tests."""
import importlib.util
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load('responsiveness_smoke_test', 'background-smoke.py')
DESCRIPTOR = {'version': 2, 'address': '127.0.0.1:1234', 'token': 'a'*64, 'instance': 'b'*64}


class Socket:
    def __init__(self, payload):
        self.payload = bytearray(payload)
        self.timeouts = []
        self.sent = []
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): self.timeouts.append(value)
    def sendall(self, value): self.sent.append(value)
    def recv(self, size):
        chunk = self.payload[:min(size, 3)]
        del self.payload[:len(chunk)]
        return bytes(chunk)


def reply(**overrides):
    value = {'version': 2, 'instance': DESCRIPTOR['instance'], 'client': 'client', 'id': 1, 'result': {'Ok': {'ready': True}}}
    value.update(overrides)
    data = json.dumps(value).encode()
    return struct.pack('!I', len(data)) + data


class RPCBounds(unittest.TestCase):
    def call(self, stream, **kwargs):
        with patch.object(smoke.socket, 'create_connection', return_value=stream) as connect:
            result = smoke.rpc(DESCRIPTOR, 'client', 1, 'ping', **kwargs)
        return result, connect
    def test_legacy_defaults_unchanged(self):
        stream = Socket(reply())
        result, connect = self.call(stream)
        self.assertEqual(result, {'ready': True})
        self.assertEqual(connect.call_args.kwargs['timeout'], 5)
        self.assertEqual(stream.timeouts[0], 10)
    def test_explicit_timeout_bounds_connect_send_and_reply(self):
        stream = Socket(reply())
        result, connect = self.call(stream, timeout=.25, max_response_bytes=4096)
        self.assertEqual(result, {'ready': True})
        self.assertLessEqual(connect.call_args.kwargs['timeout'], .25)
        self.assertTrue(all(0 < value <= .25 for value in stream.timeouts))
    def test_cap_rejects_before_reading_body(self):
        stream = Socket(struct.pack('!I', 1000)+b'x'*1000)
        with self.assertRaises((ValueError, AssertionError)):
            self.call(stream, timeout=1, max_response_bytes=100)
        self.assertEqual(len(stream.payload), 1000)
    def test_truncated_reply(self):
        with self.assertRaises((ValueError, AssertionError)):
            self.call(Socket(struct.pack('!I', 8)+b'{}'), timeout=1)
    def test_authenticated_identity_cannot_change(self):
        for key, value in [('instance','c'*64), ('client','other'), ('id',2), ('version',3)]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.call(Socket(reply(**{key:value})), timeout=1)
    def test_invalid_bounds_zero_network(self):
        for kwargs in [{'timeout':0}, {'timeout':float('nan')}, {'timeout':True}, {'max_response_bytes':0}, {'max_response_bytes':64*1024*1024+1}, {'max_response_bytes':True}]:
            with self.subTest(kwargs=kwargs), patch.object(smoke.socket,'create_connection',side_effect=AssertionError('network forbidden')) as connect:
                with self.assertRaises(ValueError): smoke.rpc(DESCRIPTOR,'client',1,'ping',**kwargs)
                connect.assert_not_called()
    def test_connect_consumes_same_deadline(self):
        stream=Socket(reply())
        with patch.object(smoke.time,'monotonic',side_effect=[1,2]), patch.object(smoke.socket,'create_connection',return_value=stream):
            with self.assertRaises((ValueError, AssertionError)): smoke.rpc(DESCRIPTOR,'client',1,'ping',timeout=.5)
        self.assertEqual(stream.sent, [])



runner = load('owner_responsiveness_test', 'terminal-owner-responsiveness.py')


class RunnerContract(unittest.TestCase):
    def test_chunk_exact_ascii_and_sequence_ledger(self):
        for phase in range(3):
            for seq in [0, 1, 9999]:
                value = runner.chunk('a'*32, phase, seq)
                self.assertEqual(len(value), 4096)
                self.assertTrue(value.isascii())
                self.assertIn(f'{phase}:{seq}', value.decode())
        self.assertNotEqual(runner.chunk('a'*32, 0, 0), runner.chunk('a'*32, 0, 1))
    def test_marker_nonce_and_bounded_unicode_input(self):
        value=runner.marker('a'*32, 0, 1)
        self.assertIn('a'*32,value)
        self.assertNotEqual(value,runner.marker('b'*32,0,1))
        for args in [('bad',0,1),('a'*32,-1,1),('a'*32,0,True)]:
            with self.assertRaises(ValueError): runner.marker(*args)
    def test_summary_full_denominator_not_optimistic_partial(self):
        samples=[{'status':'complete','latency_ms':10,'write_ms':2}, {'status':'timeout'}, {'status':'rejected'}]
        value=runner.summarize(samples,3)
        self.assertEqual(value['scheduled'],3);self.assertEqual(value['complete'],1)
        self.assertEqual(value['timeouts'],1);self.assertEqual(value['rejected'],1)
        self.assertFalse(value['passed']);self.assertEqual(value['complete_ratio'],1/3)
        self.assertIsNone(value['queue_bytes']);self.assertEqual(value['scope'],'owner-write-RPC-to-parser-projection-marker')
    def test_summary_invalid_or_missing_samples(self):
        for samples,scheduled in [([],0),([{'status':'complete','latency_ms':float('nan'),'write_ms':1}],1),([],301),([{'status':'complete','latency_ms':1,'write_ms':1}],0)]:
            with self.assertRaises(ValueError):runner.summarize(samples,scheduled)
    def test_environment_allowlist_never_inherits_credentials(self):
        with patch.dict('os.environ',{'NODE_OPTIONS':'bad','SSH_AUTH_SOCK':'secret','TOKEN':'secret'}):
            env=runner.environment(Path('/private/fixture'),Path('/private/fixture/shell'),Path('/usr/bin/python3'))
        self.assertEqual(env['SHELL'],'/private/fixture/shell');self.assertEqual(env['HOME'],'/private/fixture/home')
        self.assertFalse(set(env)&{'NODE_OPTIONS','SSH_AUTH_SOCK','TOKEN','NODE_PATH','NODE_SEA_OPTIONS'})
    def test_new_root_private_exclusive_and_symlink_refusal(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve()/'fixture';runner.new_root(root,'a'*32)
            self.assertEqual(root.stat().st_mode&0o777,0o700)
            self.assertEqual((root/'ownership').stat().st_mode&0o777,0o600)
            with self.assertRaises((ValueError,FileExistsError)):runner.new_root(root,'a'*32)
            linked=Path(temporary).resolve()/'linked';linked.symlink_to(root)
            with self.assertRaises((ValueError,FileExistsError)):runner.new_root(linked,'a'*32)
    def test_actual_probe_unique_marker_not_kernel_input(self):
        expected=runner.marker('a'*32,0,0);calls=[]
        def call(command,args,**kwargs):
            calls.append((command,args))
            if command=='read_terminal_frame':return {'projection':{'data':'INPUT:'+expected if len(calls)==2 else expected},'persisted':False}
        result=runner.probe(call,'s','a'*32,0,0,1,lambda:0,lambda x:None)
        self.assertEqual(result['status'],'complete')
        self.assertEqual(sum(c[0]=='write_session' for c in calls),1)
    def test_probe_timeout_full_denominator_and_no_retry(self):
        ticks=iter([0,0,.1,.2,1.2]);calls=[]
        result=runner.probe(lambda c,a,**kwargs:calls.append(c) or {'projection':{'data':''}},'s','a'*32,0,0,2,lambda:next(ticks),lambda x:None)
        self.assertEqual(result['status'],'timeout');self.assertEqual(calls.count('write_session'),1)


class Owner:
    pid=100
    def __init__(self):self.events=[];self.dead=False
    def poll(self):return 0 if self.dead else None
    def wait(self,timeout):
        self.events.append(('wait',timeout))
        if not self.dead:raise __import__('subprocess').TimeoutExpired('fixture',timeout)
        return 0


class ZombieObservation(unittest.TestCase):
    def test_owner_zombie_wait_oserror_retry_never_signals(self):
        owner=Owner();attempts=[];signals=[];expected={'pid':100,'parent':1,'started':'birth','executable':'/full/Python'}
        def wait(timeout):
            attempts.append(timeout)
            if len(attempts)==1:raise OSError('recoverable wait')
            owner.dead=True;return 0
        owner.wait=wait;owner.terminate=lambda:signals.append('terminate');owner.kill=lambda:signals.append('kill')
        def inspect(pid):return None if owner.dead else {**expected,'executable':'<defunct>','zombie':True}
        result=runner.cleanup(owner,{100:expected},[],lambda *a:None,inspect,lambda *a:signals.append('signal'),30,lambda:0)
        self.assertEqual(signals,[]);self.assertTrue(result['complete']);self.assertTrue(result['direct_child_waited'])
        self.assertIn('wait_failed',result['errors']);self.assertEqual(result['identity_changes'],[])

    def test_single_ps_snapshot_alive_and_zombie(self):
        import types
        for status,image,zombie in [('S','/full/Python',False),('Z','<defunct>',True)]:
            with self.subTest(status=status),patch.object(runner.subprocess,'run',return_value=types.SimpleNamespace(stdout=f'101 100 12 {status} Fri Oct 9 08:06:49 2026 {image}\n')) as ps:
                value=runner.inspect_process(101)
                self.assertEqual(value,{'pid':101,'parent':100,'started':'Fri Oct 9 08:06:49 2026','executable':image,**({'zombie':True} if zombie else {})})
                self.assertEqual(ps.call_count,1);self.assertIn('stat=',ps.call_args.args[0][-1])
    def test_unknown_or_malformed_snapshot_is_not_absence(self):
        import types
        for text in ['101 100 12 ? Fri Oct 9 08:06:49 2026 /python','garbage','999 100 12 S Fri Oct 9 08:06:49 2026 /python']:
            with self.subTest(text=text),patch.object(runner.subprocess,'run',return_value=types.SimpleNamespace(stdout=text)):
                with self.assertRaises(ValueError):runner.inspect_process(101)
    def test_wrong_birth_zombie_and_live_image_change_are_unsafe(self):
        for change in ({'started':'other','zombie':True,'executable':'<defunct>'},{'parent':1,'zombie':True,'executable':'<defunct>'},{'executable':'/other/image'}):
            with self.subTest(change=change):
                owner=Owner();owner.dead=True;now=[0.0];expected={'pid':101,'parent':100,'started':'birth','executable':'/full/Python'}
                with patch.object(runner.time,'sleep',side_effect=lambda t:now.__setitem__(0,now[0]+t)):
                    result=runner.cleanup(owner,{101:expected},[],lambda *a:None,lambda pid:{**expected,**change},lambda *a:self.fail('unsafe PID signaled'),30,lambda:now[0])
                self.assertFalse(result['complete']);self.assertIn('process_identity_changed',result['errors'])
    def test_zombie_after_owner_wait_is_not_absence_or_reaping(self):
        owner=Owner();now=[0.0];expected={'pid':101,'parent':100,'started':'birth','executable':'/full/Python'}
        def call(command,args):
            if command=='shutdown':owner.dead=True
        with patch.object(runner.time,'sleep',side_effect=lambda t:now.__setitem__(0,now[0]+t)):
            result=runner.cleanup(owner,{101:expected},[],call,lambda pid:{**expected,'executable':'<defunct>','zombie':True},lambda *a:self.fail('zombie signaled'),30,lambda:now[0])
        self.assertTrue(result['direct_child_waited']);self.assertFalse(result['verified_descendants_exited']);self.assertFalse(result['complete']);self.assertLessEqual(now[0],3.01)
    def test_matched_zombie_no_signal_owner_wait_then_absence(self):
        owner=Owner();events=[];expected={'pid':101,'parent':100,'started':'birth','executable':'/full/Python'}
        def inspect(pid):
            if pid==100:return None if owner.dead else {'pid':100,'parent':1,'started':'owner','executable':'owner'}
            return None if owner.dead else {**expected,'executable':'<defunct>','zombie':True}
        def call(command,args):
            events.append(command)
            if command=='shutdown':owner.dead=True
        result=runner.cleanup(owner,{101:expected},[],call,inspect,lambda *a:self.fail('zombie signaled'),30,lambda:0)
        self.assertTrue(result['complete']);self.assertTrue(result['direct_child_waited']);self.assertIn('shutdown',events)

class CleanupOrder(unittest.TestCase):
    def test_survivor_kill_and_unknown_child_owner_handle_cleanup(self):
        for unknown in (False,True):
            with self.subTest(unknown=unknown):
                owner=Owner();now=[0.0];alive=[True];signals=[];handles=[]
                identities={100:{'pid':100,'parent':1,'started':'owner','executable':'owner'},101:{'pid':101,'parent':100,'started':'child','executable':'child'}}
                def inspect(pid):
                    if pid==100:return None if owner.dead else identities[100]
                    if not alive[0]:return None
                    return {**identities[101],'started':'reused'} if unknown else identities[101]
                def kill(pid,sig):
                    signals.append((pid,sig))
                    if pid==101 and sig==runner.signal.SIGKILL:alive[0]=False
                def close():handles.append('terminate');owner.dead=True
                owner.terminate=close;owner.kill=close
                def call(command,args):
                    if command=='shutdown':owner.dead=True
                with patch.object(runner.time,'sleep',side_effect=lambda t:now.__setitem__(0,now[0]+t)):
                    result=runner.cleanup(owner,identities,[],call,inspect,kill,30,lambda:now[0])
                if unknown:
                    self.assertFalse(result['complete']);self.assertFalse(any(pid==101 for pid,sig in signals));self.assertTrue(handles)
                else:
                    self.assertTrue(result['complete']);self.assertEqual([sig for pid,sig in signals if pid==101],[runner.signal.SIGTERM,runner.signal.SIGKILL])

    def test_actual_child_first_avoids_parent_reassignment(self):
        owner=Owner();events=[];child_alive=[True]
        identities={100:{'pid':100,'parent':1,'started':'owner','executable':'owner'},101:{'pid':101,'parent':100,'started':'child','executable':'child'}}
        def inspect(pid):
            if pid==100:return None if owner.dead else identities[100]
            return {**identities[101],'parent':1 if owner.dead else 100} if child_alive[0] else None
        def call(command,args):
            events.append(command)
            if command=='shutdown':owner.dead=True
        def signal(pid,sig):
            events.append(('signal',pid))
            if pid==101:child_alive[0]=False
            else:owner.dead=True
        result=runner.cleanup(owner,identities,['session'],call,inspect,signal,30,lambda:0)
        self.assertTrue(result['complete']);self.assertLess(events.index(('signal',101)),events.index('shutdown'))
        self.assertEqual(result['identity_changes'],[])

class CleanupContract(unittest.TestCase):
    def test_shutdown_failure_escalates_and_waits_direct_child(self):
        owner=Owner();signals=[];identities={100:{'pid':100,'started':'start','executable':'owner'},101:{'pid':101,'started':'start','executable':'parser'}}
        def signal(pid,sig):signals.append((pid,sig));owner.dead=True
        result=runner.cleanup(owner,identities,['s'],lambda *a,**kwargs:(_ for _ in ()).throw(OSError()),lambda pid:identities.get(pid) if not owner.dead else None,signal,30,lambda:0)
        self.assertTrue(owner.events);self.assertTrue(signals);self.assertTrue(result['direct_child_waited']);self.assertTrue(result['verified_descendants_exited'])
    def test_identity_change_then_absent_remains_incomplete_safe_diagnostic(self):
        owner=Owner();owner.dead=True;expected={'pid':100,'parent':1,'started':'old','executable':'private-path'};calls=[]
        def inspect(pid):
            calls.append(pid)
            return {**expected,'started':'new'} if len(calls)==1 else None
        result=runner.cleanup(owner,{100:expected},[],lambda *a:None,inspect,lambda *a:self.fail('changed identity signaled'),30,lambda:0)
        self.assertFalse(result['complete']);self.assertTrue(result['verified_descendants_exited'])
        self.assertEqual(result['identity_changes'],[{'role':'owner','changed_fields':['started'],'final_absent':True}])
        self.assertNotIn('private-path',json.dumps(result));self.assertNotIn('100',json.dumps(result))
    def test_pid_reuse_never_killed_cleanup_fails(self):
        owner=Owner();signals=[];identities={100:{'pid':100,'started':'old','executable':'owner'}}
        result=runner.cleanup(owner,identities,[],lambda *a,**kwargs:None,lambda pid:{'pid':pid,'started':'new','executable':'owner'},lambda *a,**kwargs:signals.append(a),30,lambda:0)
        self.assertFalse(result['complete']);self.assertEqual(signals,[])


class AdmissionAndSupervisor(unittest.TestCase):
    def test_all_four_identities_required_before_workload(self):
        owner=Owner()
        rows={100:{'pid':100,'parent':1,'started':'a','executable':'/app/owner'},101:{'pid':101,'parent':100,'started':'b','executable':'/app/Resources/target/terminal-runtime/yam-terminal'},102:{'pid':102,'parent':100,'started':'c','executable':'/python'},103:{'pid':103,'parent':100,'started':'d','executable':'/python'}}
        ready=[{'pid':102,'nonce':'a'*32,'mode':'fixture-echo'}, {'pid':103,'nonce':'a'*32,'mode':'fixture-flood'}]
        result=runner.verify_identities(owner,101,ready,'a'*32,Path('/app/Resources'),Path('/python'),rows.get)
        self.assertEqual(set(result),set(rows))
        for change in [('pid',100),('nonce','b'*32),('mode','other')]:
            bad=[dict(ready[0]),dict(ready[1])];bad[1][change[0]]=change[1]
            with self.assertRaises(ValueError):runner.verify_identities(owner,101,bad,'a'*32,Path('/app/Resources'),Path('/python'),rows.get)
        for field,value in [('executable','/other/python'),('parent',999)]:
            bad={pid:dict(row) for pid,row in rows.items()};bad[102][field]=value
            with self.assertRaises(ValueError):runner.verify_identities(owner,101,ready,'a'*32,Path('/app/Resources'),Path('/python'),bad.get)
        with self.assertRaises(ValueError):runner.verify_identities(owner,101,ready[:1],'a'*32,Path('/app/Resources'),Path('/python'),rows.get)
    def test_node_parser_identity_uses_authenticated_pid_and_native_parent(self):
        owner=Owner();rows={100:{'pid':100,'parent':1,'started':'a','executable':'/app/owner'},101:{'pid':101,'parent':100,'started':'b','executable':'/opt/homebrew/bin/node'},102:{'pid':102,'parent':100,'started':'c','executable':'/python'},103:{'pid':103,'parent':100,'started':'d','executable':'/python'}}
        ready=[{'pid':102,'nonce':'a'*32,'mode':'fixture-echo'},{'pid':103,'nonce':'a'*32,'mode':'fixture-flood'}]
        self.assertEqual(set(runner.verify_identities(owner,101,ready,'a'*32,Path('/app/Resources'),Path('/python'),rows.get)),set(rows))
        result=type('Result',(),{'stdout':'101 102'})()
        with patch.object(runner.subprocess,'run',return_value=result),patch.object(runner,'inspect_process',side_effect=rows.get):
            self.assertEqual(runner.parser_identity(owner,Path('/app/Resources'),101),rows[101])
            with self.assertRaises(ValueError):runner.parser_identity(owner,Path('/app/Resources'),103)
            with self.assertRaises(ValueError):runner.parser_identity(owner,Path('/app/Resources'))
            rows[101]['parent']=999
            with self.assertRaises(ValueError):runner.parser_identity(owner,Path('/app/Resources'),101)

    def test_canonical_versioned_runtime_name_requires_authenticated_pid(self):
        row={'pid':101,'parent':100,'started':'b','executable':'/opt/node/node-real-25'}
        self.assertTrue(runner.parser_image(row,Path('/app/Resources'),101));self.assertFalse(runner.parser_image(row,Path('/app/Resources')));self.assertFalse(runner.parser_image(row,Path('/app/Resources'),102))

    def test_known_created_sessions_retained_on_second_create_failure(self):
        calls=[]
        def call(command,args,**kwargs):
            calls.append((command,args))
            if len(calls)==3:raise OSError('lost create reply')
            return {'session_id':'s-one'}
        sessions=[]
        with self.assertRaises(OSError):runner.create_sessions(call,Path('/fixture'),sessions)
        self.assertEqual(sessions,['s-one']);self.assertEqual(len(calls),3)
    def test_deadline_prevents_admission_without_rpc(self):
        calls=[]
        with self.assertRaises(ValueError):runner.bounded_call(lambda *a,**k:calls.append(a),DESCRIPTOR,'client',1,'create_session',{},1,lambda:2)
        self.assertEqual(calls,[])
    def test_sample_rejected_or_duplicate_never_replayed(self):
        calls=[]
        result=runner.probe(lambda c,a,**kwargs:(_ for _ in ()).throw(OSError()),'s','a'*32,0,0,1,lambda:0,lambda _:None)
        self.assertEqual(result['status'],'rejected')
        expected=runner.marker('a'*32,0,0)
        def call(c,a,**kwargs):
            calls.append(c)
            return {'projection':{'data':expected+'\n'+expected}}
        result=runner.probe(call,'s','a'*32,0,0,1,lambda:0,lambda _:None)
        self.assertEqual(result['status'],'duplicate');self.assertEqual(calls.count('write_session'),1)
    def test_private_root_ownership_change_never_deleted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve()/'fixture';runner.new_root(root,'a'*32)
            (root/'ownership').write_text('b'*32)
            with self.assertRaises(ValueError):runner.remove_root(root,'a'*32)
            self.assertTrue(root.exists())
    def test_ansi_projection_marker_is_not_kernel_echo(self):
        expected=runner.marker('a'*32,0,0)
        result=runner.probe(lambda c,a,**kwargs:{'projection':{'data':'\x1b[2J\x1b[H'+expected}},'s','a'*32,0,0,1,lambda:0,lambda _:None)
        self.assertEqual(result['status'],'complete')
    def test_byte_ledger_partial_write_and_phase_attribution(self):
        value={'nonce':'a'*32,'phase':0,'bytes':8192,'markers_bytes':100,'chunks':2,'partial_bytes':0,'elapsed':5,'stall_seconds':.2,'done':True}
        result=runner.validate_ledger(value,'a'*32,0)
        self.assertEqual(result['bytes'],8292)
        for key,val in [('phase',1),('bytes',8191),('elapsed',float('nan')),('partial_bytes',4096),('done',False)]:
            bad=dict(value);bad[key]=val
            with self.assertRaises(ValueError):runner.validate_ledger(bad,'a'*32,0)

class RuntimeWiring(unittest.TestCase):
    def test_script_owner_receives_node_outside_isolated_path(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            app=Path(temporary).resolve()/'YAM.app'
            resource=app/'Contents/Resources/target/terminal-runtime/yam-terminal.cjs'
            resource.parent.mkdir(parents=True);resource.write_text('script')
            executable=app/'Contents/MacOS/yam-desktop'
            for location in ('nvm/node-real-25','private-cache/node'):
                node=app.parent/location;node.parent.mkdir();node.write_text('node');node.chmod(0o700)
                with patch.object(runner.shutil,'which',return_value=str(node)):
                    command=runner.owner_command(app,executable)
                self.assertEqual(command,[str(executable),'--yam-background','--yam-terminal-node',str(node)])
                with patch.object(runner.shutil,'which',return_value=None):
                    self.assertEqual(runner.owner_command(app,executable,node),command)
            with patch.object(runner.shutil,'which',return_value=None):
                with self.assertRaisesRegex(ValueError,'terminal-node'):runner.owner_command(app,executable)
            for invalid in (Path('node'),app/'missing',app.parent/'private-cache'):
                with self.assertRaises(ValueError):runner.owner_command(app,executable,invalid)
            node.chmod(0o600)
            with self.assertRaises(ValueError):runner.owner_command(app,executable,node)
    def test_legacy_owner_keeps_existing_startup_command(self):
        with patch.object(runner.shutil,'which',return_value=None):
            self.assertEqual(runner.owner_command(Path('/legacy/YAM.app'),Path('/legacy/owner')),['/legacy/owner','--yam-background'])
    def test_omitted_artifact_gate_never_starts_owner(self):
        import types
        args=types.SimpleNamespace(artifact_gate=Path('/private/gate'),identifier='id',receipt=Path('/private/receipt'))
        with patch.object(runner,'read_private',return_value={}),patch.object(runner.smoke,'regular_bytes',return_value=b'{}'),patch.object(runner.subprocess,'Popen') as spawn:
            with self.assertRaises(ValueError):runner.execute(args)
            spawn.assert_not_called()
    def test_cancelled_call_zero_dispatch_and_late_reply_discarded(self):
        run=runner.Run(90,clock=lambda:0)
        run.descriptor=DESCRIPTOR
        run.cancelled.set()
        with patch.object(runner.smoke,'rpc') as rpc:
            with self.assertRaises(ValueError):run.call('create_session')
            rpc.assert_not_called()
        run.cancelled.clear()
        def rpc(*args,**kwargs):run.cancelled.set();return {'session_id':'late'}
        with patch.object(runner.smoke,'rpc',side_effect=rpc):
            with self.assertRaisesRegex(ValueError,'Late reply'):run.call('create_session')
    def test_independent_watchdog_cleanup_unblocks_blocked_rpc(self):
        import threading
        run=runner.Run(30.001,clock=lambda:0)
        run.descriptor=DESCRIPTOR
        entered=threading.Event();released=threading.Event();errors=[]
        def rpc(descriptor,client,sequence,command,*args,**kwargs):
            if command=='read_terminal_frame':
                entered.set();released.wait(1);return {}
            if command=='shutdown':released.set();return {}
        def blocked():
            try:run.call('read_terminal_frame')
            except ValueError as error:errors.append(str(error))
        with patch.object(runner.smoke,'rpc',side_effect=rpc):
            task=threading.Thread(target=blocked);task.start();self.assertTrue(entered.wait(1))
            run.watchdog();task.join(1)
        self.assertFalse(task.is_alive());self.assertTrue(run.cancelled.is_set());self.assertTrue(run.cleanup_result['complete']);self.assertEqual(len(errors),1)
    def test_cleanup_idempotent_with_separate_client_identity(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;calls=[]
        with patch.object(runner.smoke,'rpc',side_effect=lambda *a,**k:calls.append(a) or {}):
            first=run.close();second=run.close()
        self.assertEqual(first,second);self.assertEqual(len(calls),1);self.assertNotEqual(calls[0][1],run.client)
    def test_direct_owner_birth_handle_is_reaped_even_if_ps_unavailable(self):
        owner=Owner()
        owner.terminate=lambda:setattr(owner,'dead',True)
        owner.kill=lambda:setattr(owner,'dead',True)
        result=runner.cleanup(owner,{},[],lambda *a,**kwargs:None,lambda pid:None,lambda *a,**kwargs:self.fail('unproven pid signal'),30,lambda:0)
        self.assertTrue(result['direct_child_waited']);self.assertTrue(owner.dead)
    def test_launcher_exact_arguments_gate_and_no_subprocess(self):
        source=runner.launcher_text(Path('/private/root'),'a'*32,Path('/usr/bin/python3'))
        compile(source,'private-launcher','exec')
        self.assertIn("['-l', '-c']",source);self.assertIn('identity-gate',source)
        self.assertNotIn('subprocess',source);self.assertNotIn('eval(',source)
        with self.assertRaises(ValueError):runner.launcher_text(Path('/private/root'),'a'*32,Path('/bad python'))
    def test_partial_frame_and_duplicate_receipts_rejected(self):
        for frame in [{'persisted':True,'projection':{'data':'x'}},{'projection':{'data':None}},{'projection':{'data':'x'*(8*1024*1024+1)}}]:
            result=runner.probe(lambda *a,**kwargs:frame,'s','a'*32,0,0,1,lambda:0,lambda _:None)
            self.assertEqual(result['status'],'rejected')
    def test_cleanup_one_stop_exception_does_not_skip_other_session(self):
        calls=[]
        def call(command,args,**kwargs):
            calls.append((command,args))
            if args.get('session_id')=='first':raise OSError('failure')
        result=runner.cleanup(None,{},['first','second'],call,lambda _:None,lambda *a,**kwargs:None,30,lambda:0)
        self.assertEqual([c[0] for c in calls],['stop_session','stop_session','shutdown'])
        self.assertTrue(result['complete']);self.assertIn('stop_failed',result['errors'])


class CleanupFailurePaths(unittest.TestCase):
    def test_inspection_failure_does_not_skip_known_descendant(self):
        rows={100:{'pid':100,'started':'a','executable':'owner'},101:{'pid':101,'started':'b','executable':'parser'}}
        calls=[]
        def inspect(pid):
            if pid==100:raise OSError('inspection unavailable')
            return rows.get(pid)
        def kill(pid,sig):calls.append(pid);rows.pop(pid,None)
        value=runner.cleanup(None,dict(rows),[],lambda *a,**kwargs:None,inspect,kill,30,lambda:0)
        self.assertIn(101,calls);self.assertFalse(value['complete'])
    def test_signal_error_still_attempts_all_identities(self):
        rows={100:{'pid':100,'started':'a','executable':'owner'},101:{'pid':101,'started':'b','executable':'parser'}};calls=[]
        def kill(pid,sig):
            calls.append(pid)
            if pid==100:raise PermissionError()
            rows.pop(pid,None)
        value=runner.cleanup(None,dict(rows),[],lambda *a,**kwargs:None,rows.get,kill,30,lambda:0)
        self.assertIn(101,calls);self.assertFalse(value['complete'])
    def test_hard_deadline_no_new_stop_calls(self):
        calls=[]
        value=runner.cleanup(None,{},['first','second'],lambda *a,**kwargs:calls.append(a),lambda _:None,lambda *a,**kwargs:None,30,lambda:31)
        self.assertEqual(calls,[]);self.assertFalse(value['complete'])


class CreationOrdering(unittest.TestCase):
    def test_ready_identity_captured_before_next_create(self):
        events=[];sessions=[]
        def call(command,args,**kwargs):
            events.append(command)
            return {'session_id':'s-'+str(len(sessions))}
        def captured(mode,identity):events.append('identity:'+mode)
        runner.create_sessions(call,Path('/fixture'),sessions,on_created=captured)
        self.assertEqual(events,['create_session','resize_session','identity:fixture-echo','create_session','resize_session','identity:fixture-flood'])


class DrainFrame(unittest.TestCase):
    def test_actual_outer_frame_projection_revision_and_capacity(self):
        frame={'end_offset':100,'status':'running','persisted':False,'projection':{'retained_lines':2000,'revision':12,'data':'screen'}}
        self.assertEqual(runner.validate_drain(frame,100),{'expected_raw_bytes':100,'owner_end_offset':100,'revision':12})
        self.assertIsNone(runner.validate_drain(frame,101))
        with self.assertRaises(ValueError):runner.validate_drain(frame,99)
        for key,value in [('retained_lines',None),('revision',True)]:
            bad={**frame,'projection':{**frame['projection'],key:value}}
            with self.assertRaises(ValueError):runner.validate_drain(bad,100)


class SelfIdentityBoundary(unittest.TestCase):
    def test_unknown_self_actual_execute_preallocation(self):
        import tempfile,types,hashlib
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary).resolve();receipt=base/'receipt';receipt.write_text('{}')
            args=types.SimpleNamespace(root=base/'run',output=base/'out',app=base/'app',receipt=receipt,artifact_gate=base/'gate',identifier='com.yam.functional-validation-f7-'+'a'*32)
            gate={'purpose':'A11-owner-workload-authorization','authorized':True,'identifier':args.identifier,'receipt_sha256':hashlib.sha256(b'{}').hexdigest(),'fixture_sha256':hashlib.sha256(Path(runner.__file__).read_bytes()).hexdigest(),'test_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
            with patch.object(runner,'read_private',return_value=gate),patch.object(runner.smoke,'validate_f7_run',return_value={'executable':base/'app','root':args.root/'home/Library/Application Support'/args.identifier,'receipt':{}}),patch.object(runner,'inspect_process',return_value=None),patch.object(runner.subprocess,'Popen') as spawn:
                with self.assertRaises(ValueError):runner.execute(args)
                spawn.assert_not_called();self.assertFalse(args.root.exists());self.assertFalse(args.output.exists())

class ExecuteWiring(unittest.TestCase):
    def exercise(self, fail_second=False, fail_descriptor=False, framework=False, changed_self=False, jitter=None, slow_write=0, stage_stderr=None):
        import hashlib,io,tempfile,types
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary).resolve();app=base/'isolated.app';root=base/'run';out=base/'out';data=root/'home/Library/Application Support'/('com.yam.functional-validation-f7-'+'a'*32);receipt=base/'receipt.json';receipt.write_text('{}')
            args=types.SimpleNamespace(app=app,root=root,output=out,receipt=receipt,artifact_gate=base/'gate',identifier='com.yam.functional-validation-f7-'+'a'*32)
            now=[100.0];sleep_count=[0]
            def sleep(seconds):
                if seconds>0:
                    extra=jitter[sleep_count[0]%len(jitter)] if jitter else 0
                    sleep_count[0]+=1;now[0]+=seconds+extra
            owner=Owner();owner.stderr=io.BytesIO(native_stage_wire()*2 if stage_stderr is None else stage_stderr);events=[];seen=[];latest='';created=[]
            resources=app/'Contents/Resources';python=Path(__import__('sys').executable).resolve()
            native=base/'Python';native.write_text('fixture native image')
            image=native if framework else python
            rows={runner.os.getpid():{'pid':runner.os.getpid(),'parent':1,'started':'self','executable':str(image)},100:{'pid':100,'parent':1,'started':'owner','executable':str(app/'Contents/MacOS/yam-desktop')},101:{'pid':101,'parent':100,'started':'parser','executable':str(resources/'target/terminal-runtime/yam-terminal')},102:{'pid':102,'parent':100,'started':'echo','executable':str(image)},103:{'pid':103,'parent':100,'started':'flood','executable':str(image)}}
            gate={'purpose':'A11-owner-workload-authorization','authorized':True,'identifier':args.identifier,'receipt_sha256':hashlib.sha256(b'{}').hexdigest(),'fixture_sha256':hashlib.sha256(Path(runner.__file__).read_bytes()).hexdigest(),'test_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
            def read(path):
                if path==args.artifact_gate:return gate
                if path.name=='echo-seen.json':return {'nonce':'a'*32,'seen':seen}
                raise AssertionError('unexpected private read')
            def wait_file(path,deadline,run):
                if path.name.endswith('-ready.json'):
                    mode=path.name[:-11];events.append('ready:'+mode)
                    return {'pid':102 if mode=='fixture-echo' else 103,'nonce':'a'*32,'mode':mode}
                phase=int(path.name.split('-')[1])
                if path.name.endswith('-running.json'):return {'nonce':'a'*32,'phase':phase}
                return {'nonce':'a'*32,'phase':phase,'bytes':8192,'markers_bytes':100,'chunks':2,'partial_bytes':0,'elapsed':5,'stall_seconds':0,'done':True}
            def spawn(*a,**k):
                events.append('spawn')
                self.assertEqual(k['env']['SHELL'],str(root/'shell'))
                connection=data/'background/connection.json';connection.parent.mkdir();connection.write_text('{}')
                return owner
            def rpc(descriptor,client,sequence,command,args=None,**kwargs):
                nonlocal latest
                events.append(command)
                if command=='background_status':return {'active_sessions':0,'desktop_connected':False}
                if command=='history_overview':return {'total':0}
                if command=='create_session':
                    if created and fail_second:raise OSError('lost reply')
                    identity='echo' if not created else 'flood';created.append(identity);return {'session_id':identity}
                if command=='write_session':
                    now[0]+=slow_write
                    raw=args['data'].strip();parts=raw.split('_');latest='_'.join(['ECHO',parts[1],parts[2],parts[3]]);seen.append([int(parts[2]),int(parts[3])]);return {}
                if command=='read_terminal_frame':return {'end_offset':24876,'projection':{'data':latest,'revision':42,'retained_lines':2000},'persisted':False}
                if command=='shutdown':owner.dead=True;rows.clear();return {}
                return {}
            def signal_process(pid,sig):
                if fail_descriptor:
                    owner.dead=True;rows.clear();return
                self.assertFalse(owner.dead,'owner closed before descendants')
                self.assertIn(pid,(101,102,103));rows.pop(pid,None)
            self_reads=0
            def inspect(pid):
                nonlocal self_reads
                row=rows.get(pid)
                if pid==runner.os.getpid():
                    self_reads+=1
                    if changed_self and self_reads>1:return {**row,'started':'changed'}
                return row
            real_run=runner.Run
            with patch.object(runner,'read_private',side_effect=read),patch.object(runner.smoke,'validate_f7_run',side_effect=lambda *a,**k: {'executable':app/'Contents/MacOS/yam-desktop','root': k['owner_home']/'Library/Application Support'/args.identifier,'receipt':{}}),patch.object(runner.subprocess,'Popen',side_effect=spawn),patch.object(runner,'inspect_process',side_effect=inspect),patch.object(runner.memory,'read_connection',side_effect=lambda _: (_ for _ in ()).throw(ValueError('private secret')) if fail_descriptor else DESCRIPTOR),patch.object(runner.smoke,'confirm_f7_owner',return_value=(DESCRIPTOR,2)),patch.object(runner.smoke,'rpc',side_effect=rpc),patch.object(runner,'wait_file',side_effect=wait_file),patch.object(runner,'parser_identity',return_value=rows[101]),patch.object(runner.secrets,'token_hex',side_effect=lambda n: 'a'*(2*n)),patch.object(runner.time,'monotonic',side_effect=lambda:now[0]),patch.object(runner.time,'monotonic_ns',side_effect=lambda:int(now[0]*1e9)),patch.object(runner.time,'sleep',side_effect=sleep),patch.object(runner,'Run',side_effect=lambda d:real_run(d,clock=lambda:now[0],inspect=rows.get,kill=signal_process)):
                code=runner.execute(args)
            result=json.loads((out/'result.json').read_text())
            self.assertTrue(result['cleanup']['complete']);self.assertFalse(root.exists());self.assertFalse(data.exists())
            if not fail_descriptor and not changed_self:self.assertLess(events.index('ready:fixture-echo'),events.index('create_session',events.index('create_session')+1))
            return code,result,events
    def test_actual_execute_fixed_sleep_overshoot_preserves_nominal_slots(self):
        code,result,events=self.exercise(jitter=[.006])
        self.assertEqual(code,0);self.assertEqual(result['summary']['complete'],300)
        self.assertEqual(result['nominal_interval_ms'],50);self.assertIs(result['one_inflight'],True)
    def test_actual_execute_variable_jitter_reports_short_actual_gap(self):
        code,result,events=self.exercise(jitter=[.024,.006])
        self.assertEqual(code,0);self.assertEqual(result['summary']['complete'],300)
        samples=result['samples'];gaps=[(b['submitted_ns']-a['submitted_ns'])/1e9 for a,b in zip(samples,samples[1:]) if a['phase']==b['phase']]
        self.assertAlmostEqual(min(gaps),.032,places=6)
    def test_actual_slow_work_keeps_missing_full_denominator(self):
        code,result,events=self.exercise(slow_write=.060)
        self.assertEqual(code,2);self.assertLess(events.count('write_session'),300)
        self.assertLessEqual(result['elapsed_seconds'],16)
        summary=runner.summarize(result['samples'],300)
        self.assertEqual(summary['scheduled'],300);self.assertGreater(summary['missing'],0)
        for phase in range(3):
            submitted=[sample['submitted_ns'] for sample in result['samples'] if sample['phase']==phase]
            self.assertLess(max(submitted)-min(submitted),5_000_000_000)
    def test_self_changed_before_spawn_actual_execute_rejects(self):
        code,result,events=self.exercise(changed_self=True)
        self.assertEqual(code,2);self.assertEqual(result['stage'],'spawn');self.assertNotIn('spawn',events)
    def test_framework_launch_and_native_image_differ_actual_execute(self):
        code,result,events=self.exercise(framework=True)
        self.assertEqual(code,0);self.assertEqual(result['summary']['complete'],300)
    def test_actual_descriptor_rejection_preserves_safe_stage(self):
        code,result,events=self.exercise(fail_descriptor=True)
        self.assertEqual(code,2);self.assertEqual(result['stage'],'descriptor_validate')
        self.assertIs(result['connection_seen'],True);self.assertEqual(result['owner_exit_code'],None)
        self.assertNotIn('private secret',json.dumps(result));self.assertNotIn('create_session',events)
    def test_actual_execute_normal_fake_process_and_rpc_chain(self):
        code,result,events=self.exercise()
        self.assertEqual(code,0);self.assertEqual(result['summary']['scheduled'],300)
        self.assertEqual(result['summary']['complete'],300);self.assertEqual(result['drain']['owner_end_offset'],24876)
        self.assertEqual(events.count('write_session'),300)
        self.assertIn('diagnostics',result)
        self.assertEqual(len(result['diagnostics']['phases']),3)
        self.assertEqual(result['diagnostics']['phases'][0]['written_data_bytes'],8192)
        self.assertEqual(result['diagnostics']['phases'][0]['marker_bytes'],100)
        self.assertNotIn('private secret',json.dumps(result['diagnostics']))
    def test_actual_execute_second_create_failure_cleanup_without_workload(self):
        code,result,events=self.exercise(True)
        self.assertEqual(code,2);self.assertEqual(result['status'],'incomplete');self.assertNotIn('write_session',events)
        self.assertIn('stop_session',events);self.assertIn('shutdown',events)


class UnicodeInput(unittest.TestCase):
    def test_one_bounded_unicode_variant_actual_probe_input(self):
        sent=[];expected=runner.marker('a'*32,2,99)
        def call(command,args,**kwargs):
            if command=='write_session':sent.append(args['data'])
            return {'projection':{'data':expected}}
        self.assertEqual(runner.probe(call,'s','a'*32,2,99,1,lambda:0,lambda _:None)['status'],'complete')
        self.assertEqual(len(sent),1);self.assertTrue(sent[0].endswith('_中\n'));self.assertLessEqual(len(sent[0].encode()),256)


class RawClockReceipt(unittest.TestCase):
    def test_same_parent_ns_clock_receipts_include_ack_and_observed(self):
        ticks=iter([1000000000,1010000000,1040000000]);expected=runner.marker('a'*32,0,0)
        value=runner.probe(lambda *a,**kwargs:{'projection':{'data':expected}},'s','a'*32,0,0,1,lambda:0,lambda _:None,lambda:next(ticks))
        self.assertEqual(value['submitted_ns'],1000000000);self.assertEqual(value['acknowledged_ns'],1010000000)
        self.assertEqual(value['observed_ns'],1040000000);self.assertEqual(value['write_ms'],10);self.assertEqual(value['latency_ms'],40)


class R1ObservationDeadline(unittest.TestCase):
    def test_delayed_matching_frame_past_one_second_after_ack_is_timeout(self):
        tick=[0.0];expected=runner.marker('a'*32,0,0);calls=[]
        def call(command,args,**kwargs):
            calls.append(command)
            if command=='read_terminal_frame':tick[0]=2.0
            return {'projection':{'data':expected}}
        value=runner.probe(call,'s','a'*32,0,0,5,lambda:tick[0],lambda _:None)
        self.assertEqual(value['status'],'timeout');self.assertTrue(value['late'])
        self.assertEqual(value['observed_ns'],2000000000);self.assertEqual(calls.count('write_session'),1)
        self.assertEqual(runner.summarize([value],1)['complete'],0)
    def test_ack_crosses_global_deadline_no_frame_read_and_raw_ack_retained(self):
        tick=[0.0];calls=[]
        def call(command,args,**kwargs):calls.append(command);tick[0]=4;return {}
        value=runner.probe(call,'s','a'*32,0,0,3,lambda:tick[0],lambda _:None)
        self.assertEqual(value['status'],'timeout');self.assertTrue(value['late']);self.assertEqual(value['acknowledged_ns'],4000000000)
        self.assertEqual(calls,['write_session'])
    def test_slow_ack_within_global_budget_keeps_full_second_observation(self):
        tick=[0.0];expected=runner.marker('a'*32,0,0);budgets=[]
        def call(command,args,**kwargs):
            if command=='write_session':tick[0]=2
            else:budgets.append(kwargs.get('deadline'));tick[0]=2.5
            return {'projection':{'data':expected}}
        value=runner.probe(call,'s','a'*32,0,0,5,lambda:tick[0],lambda _:None)
        self.assertEqual(value['status'],'complete');self.assertEqual(value['latency_ms'],2500)
        self.assertEqual(budgets,[3])
    def test_actual_Run_call_clamps_read_to_sample_and_soft_budget(self):
        run=runner.Run(90,clock=lambda:10);run.descriptor=DESCRIPTOR;calls=[]
        with patch.object(runner.smoke,'rpc',side_effect=lambda *a,**k:calls.append(k) or {}):
            run.call('read_terminal_frame',{},deadline=10.2)
        self.assertAlmostEqual(calls[0]['timeout'],.2)
    def test_returned_read_error_after_observation_deadline_is_timeout_not_rejection(self):
        tick=[0.0]
        def call(command,args,**kwargs):
            if command=='read_terminal_frame':tick[0]=2;raise OSError('expired read')
        value=runner.probe(call,'s','a'*32,0,0,5,lambda:tick[0],lambda _:None)
        self.assertEqual(value['status'],'timeout');self.assertTrue(value['late'])


class R2WaitCleanup(unittest.TestCase):
    def test_exact_wait_oserror_continues_verified_parser_cleanup_and_receipt(self):
        class BrokenOwner:
            pid=100
            def wait(self,timeout):raise OSError('wait unavailable')
        rows={101:{'pid':101,'started':'owned','executable':'parser'}};signals=[]
        def kill(pid,sig):signals.append(pid);rows.pop(pid,None)
        value=runner.cleanup(BrokenOwner(),dict(rows),[],lambda *a:None,rows.get,kill,30,lambda:0)
        self.assertIn(101,signals);self.assertFalse(value['complete']);self.assertFalse(value['direct_child_waited'])
        self.assertTrue(value['verified_descendants_exited']);self.assertIn('wait_failed',value['errors'])
    def test_wait_terminate_kill_errors_do_not_skip_other_verified_identity(self):
        class BrokenOwner:
            pid=100
            def __init__(self):self.waits=0
            def wait(self,timeout):self.waits+=1;raise OSError('wait unavailable')
            def terminate(self):raise OSError('terminate unavailable')
            def kill(self):raise OSError('kill unavailable')
        owner=BrokenOwner();rows={101:{'pid':101,'started':'owned','executable':'parser'},102:{'pid':102,'started':'owned','executable':'pty'}};signals=[]
        def kill(pid,sig):signals.append(pid);rows.pop(pid,None)
        value=runner.cleanup(owner,dict(rows),[],lambda *a:None,rows.get,kill,30,lambda:0)
        self.assertEqual(set(signals),{101,102});self.assertGreaterEqual(owner.waits,3)
        self.assertFalse(value['complete']);self.assertTrue({'wait_failed','terminate_failed','kill_failed'}<=set(value['errors']))
    def test_final_wait_success_is_actual_reaping_evidence_not_signal(self):
        class RecoveringOwner:
            pid=100
            def __init__(self):self.waits=0
            def wait(self,timeout):
                self.waits+=1
                if self.waits<3:raise OSError('temporary wait failure')
                return 0
            def terminate(self):raise OSError('temporary terminate failure')
            def kill(self):raise OSError('temporary kill failure')
        owner=RecoveringOwner();rows={101:{'pid':101,'started':'owned','executable':'parser'}}
        def kill(pid,sig):rows.pop(pid,None)
        value=runner.cleanup(owner,dict(rows),[],lambda *a:None,rows.get,kill,30,lambda:0)
        self.assertTrue(value['direct_child_waited']);self.assertTrue(value['complete']);self.assertGreaterEqual(owner.waits,3)


class R3ActualF7Shape(unittest.TestCase):
    def test_existing_real_validator_returns_explicit_dict_fields(self):
        legacy=load('r3_existing_f7_tests','test_background_smoke.py')
        fixture=legacy.F7CurrentRunTests('test_f7_current_full_receipt_accepts_absent_and_empty_namespace')
        fixture.setUp()
        try:
            with fixture.patched():
                value=legacy.smoke.validate_f7_run(fixture.app,fixture.identifier,fixture.receipt_path)
            self.assertEqual(set(value),{'executable','root','receipt'})
            self.assertIsInstance(value['executable'],Path);self.assertIsInstance(value['root'],Path)
            self.assertEqual(value['receipt'],fixture.receipt)
        finally:fixture.doCleanups()

class A11Diagnostics(unittest.TestCase):
    def test_cleanup_records_effective_budget_order_elapsed_and_no_duplicate_calls(self):
        now=[0.0];run=runner.Run(10.25,clock=lambda:now[0]);run.descriptor=DESCRIPTOR;run.sessions=['first','second'];calls=[]
        def rpc(*args,**kwargs):
            calls.append((args,kwargs));now[0]+=.1;return {}
        with patch.object(runner.smoke,'rpc',side_effect=rpc):
            first=run.close();self.assertIs(first,run.close())
        rows=run.diagnostics['cleanup_requests']
        self.assertEqual(len(rows),3);self.assertEqual([r['target'] for r in rows],['echo','flood','owner'])
        self.assertEqual([r['outcome'] for r in rows],['acknowledged']*3)
        self.assertAlmostEqual(rows[0]['budget_ms'],250);self.assertAlmostEqual(rows[1]['budget_ms'],150)
        self.assertAlmostEqual(rows[2]['budget_ms'],50);self.assertAlmostEqual(rows[2]['elapsed_ms'],100)
        self.assertEqual(len(calls),3);self.assertTrue(first['complete'])
    def test_deadline_and_no_descriptor_never_dispatch_and_are_safe(self):
        for hard,now,outcome in [(10,11,'deadline_exhausted'),(90,0,'not_attempted')]:
            run=runner.Run(hard,clock=lambda:now);run.sessions=['private-session']
            with patch.object(runner.smoke,'rpc') as rpc:run.close();rpc.assert_not_called()
            rows=run.diagnostics['cleanup_requests'];self.assertEqual(rows[0]['outcome'],outcome)
            self.assertFalse(rows[0]['attempted']);self.assertEqual(rows[0]['budget_ms'],0)
            self.assertNotIn('private-session',json.dumps(run.diagnostics))
    def test_phase_data_and_markers_remain_separate_and_schema_is_strict(self):
        ledger={'nonce':'a'*32,'phase':0,'bytes':8193,'markers_bytes':100,'chunks':2,'partial_bytes':1,'elapsed':5,'stall_seconds':.2,'done':True}
        row=runner.phase_diagnostic(runner.validate_ledger(ledger,'a'*32,0),0,[{'phase':0,'status':'complete'},{'phase':1,'status':'complete'},{'phase':0,'status':'timeout'}])
        self.assertEqual(row['written_data_bytes'],8193);self.assertEqual(row['marker_bytes'],100)
        self.assertEqual(row['nominal_offer_bytes'],51200);self.assertEqual(row['achieved_data_bytes_per_second'],8193/5)
        self.assertEqual(row['observed_probes'],2);self.assertEqual(row['completed_probes'],1)
        self.assertEqual(row['probe_phase_alignment'],'scheduled-label-only')
        run=runner.Run(90,clock=lambda:0);run.close();diag=run.diagnostics;diag['phases']=[row]
        runner.validate_diagnostics(diag)
        for mutation in [lambda d:d.update(extra='secret'),lambda d:d['phases'][0].update(written_data_bytes=-1),lambda d:d.update(phases=[row]*4)]:
            value=json.loads(json.dumps(diag));mutation(value)
            with self.assertRaises(ValueError):runner.validate_diagnostics(value)
    def test_actual_child_signal_before_shutdown_is_not_graceful(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.parser_pid=101
        rows={101:{'pid':101,'parent':100,'started':'birth','executable':'parser'}};run.identities=dict(rows);run.inspect=rows.get
        run.kill=lambda pid,sig:rows.pop(pid,None)
        with patch.object(runner.smoke,'rpc',return_value={}):run.close()
        out=run.diagnostics['cleanup_outcome'];self.assertTrue(out['parser_signal_attempted']);self.assertTrue(out['owner_shutdown_acknowledged'])
        self.assertFalse(out['owner_shutdown_before_parser_signal']);self.assertFalse(out['graceful_shutdown_verified'])
        self.assertTrue(run.diagnostics['cleanup_requests'][-1]['parser_termination_attempted_before_call'])

class A11DiagnosticErrors(unittest.TestCase):
    def test_fixed_outcomes_actual_runner_helper_identity_and_secret_not_retained(self):
        cases=[(runner.smoke.ServerRejected(),'server_rejected'),(TimeoutError('secret timeout'),'transport_timeout'),(EOFError('secret EOF'),'transport_closed'),(OSError('/private/secret'),'transport_error'),(AssertionError('token secret'),'protocol_or_validation_error')]
        for error,expected in cases:
            with self.subTest(outcome=expected):
                run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.sessions=['private-id']
                with patch.object(runner.smoke,'rpc',side_effect=error) as rpc:result=run.close()
                self.assertEqual(rpc.call_count,2);self.assertEqual([row['outcome'] for row in run.diagnostics['cleanup_requests']],[expected,expected])
                self.assertIn('stop_failed',result['errors']);self.assertIn('shutdown_failed',result['errors'])
                self.assertNotIn('secret',json.dumps(run.diagnostics));self.assertNotIn('private-id',json.dumps(run.diagnostics));runner.validate_diagnostics(run.diagnostics)
    def test_matched_helper_elapsed_budget_expiry_is_deadline_not_prose_classification(self):
        now=[0];run=runner.Run(90,clock=lambda:now[0]);run.descriptor=DESCRIPTOR
        def rpc(*args,**kwargs):now[0]+=1.1;raise ValueError('sensitive generic error')
        with patch.object(runner.smoke,'rpc',side_effect=rpc):run.close()
        self.assertEqual(run.diagnostics['cleanup_requests'][0]['outcome'],'deadline_exhausted')
        self.assertAlmostEqual(run.diagnostics['cleanup_requests'][0]['elapsed_ms'],1100)
    def test_no_verified_owner_or_parser_cannot_claim_graceful_shutdown(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR
        with patch.object(runner.smoke,'rpc',return_value={}):run.close()
        self.assertFalse(run.diagnostics['cleanup_outcome']['graceful_shutdown_verified'])
    def test_schema_rejects_boolean_numbers_nan_infinity_extra_and_inconsistent_fields(self):
        run=runner.Run(90,clock=lambda:0);run.close()
        mutations=[lambda d:d['cleanup_requests'][0].update(budget_ms=True),lambda d:d['cleanup_requests'][0].update(elapsed_ms=float('nan')),lambda d:d['cleanup_outcome'].update(graceful_shutdown_verified=True),lambda d:d.update(cleanup_requests=d['cleanup_requests']*4),lambda d:d['cleanup_requests'][0].update(target='/secret')]
        for change in mutations:
            d=json.loads(json.dumps(run.diagnostics));change(d)
            with self.assertRaises(ValueError):runner.validate_diagnostics(d)

class A11DiagnosticsSafety(unittest.TestCase):
    def test_unsafe_child_barrier_records_no_shutdown_and_no_unverified_signal(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.parser_pid=101
        old={'pid':101,'parent':100,'started':'old','executable':'parser'};run.identities={101:old};run.inspect=lambda pid:{**old,'started':'reused'};signals=[];run.kill=lambda *args:signals.append(args)
        with patch.object(runner.smoke,'rpc') as rpc:value=run.close();rpc.assert_not_called()
        self.assertFalse(value['complete']);self.assertEqual(signals,[])
        self.assertEqual(run.diagnostics['cleanup_requests'],[{'operation':'shutdown','target':'owner','attempted':False,'budget_ms':0,'elapsed_ms':0,'outcome':'not_attempted','parser_termination_attempted_before_call':False,'rejection_kind':None}])
        self.assertFalse(run.diagnostics['cleanup_outcome']['child_first_barrier_passed']);runner.validate_diagnostics(run.diagnostics)
    def test_malformed_matched_response_cleanup_continues_other_owned_requests(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.sessions=['first','second']
        with patch.object(runner.smoke,'rpc',side_effect=[KeyError('secret'),{},{}]) as rpc:value=run.close()
        self.assertEqual(rpc.call_count,3);self.assertIn('stop_failed',value['errors']);self.assertTrue(value['complete'])
        self.assertEqual([r['outcome'] for r in run.diagnostics['cleanup_requests']],['protocol_or_validation_error','acknowledged','acknowledged'])

class A11ActualMalformedReply(unittest.TestCase):
    def test_actual_runner_smoke_matched_malformed_reply_continues_cleanup(self):
        for missing in (True,False):
            calls=[]
            class MatchedSocket(Socket):
                def __init__(self):super().__init__(b'')
                def sendall(self,wire):
                    request=json.loads(wire[4:]);calls.append(request['command'])
                    result={key:request[key] for key in ('version','instance','client','id')}
                    if len(calls)>1:result['result']={'Ok':{}}
                    elif not missing:result['result']=None
                    encoded=json.dumps(result).encode();self.payload=bytearray(struct.pack('!I',len(encoded))+encoded)
            run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.sessions=['first','second']
            with patch.object(runner.smoke.socket,'create_connection',side_effect=lambda *a,**k:MatchedSocket()):value=run.close()
            self.assertEqual(calls,['stop_session','stop_session','shutdown']);self.assertTrue(value['complete']);self.assertIn('stop_failed',value['errors'])
            self.assertEqual([row['outcome'] for row in run.diagnostics['cleanup_requests']],['protocol_or_validation_error','acknowledged','acknowledged'])

class A11ActualBudget(unittest.TestCase):
    def test_record_is_the_exact_timeout_passed_at_actual_rpc_boundary(self):
        tick=[0.0]
        def clock():tick[0]+=.01;return tick[0]
        run=runner.Run(90,clock=clock);run.descriptor=DESCRIPTOR;budgets=[]
        with patch.object(runner.smoke,'rpc',side_effect=lambda *a,**k:budgets.append(k['timeout']) or {}):run.close()
        self.assertEqual([row['budget_ms'] for row in run.diagnostics['cleanup_requests']],[budget*1000 for budget in budgets])

class StopRejectionDiagnostics(unittest.TestCase):
    def test_actual_close_matched_wire_continues_with_safe_categories(self):
        for message,kind in [('Unknown session: private-first','missing_session'),('Background is shutting down; reconnect','owner_shutting_down'),('/private/secret token-secret','other_server_rejection')]:
            calls=[];streams=[]
            class MatchedSocket(Socket):
                def __init__(self):super().__init__(b'');streams.append(self)
                def sendall(self,wire):
                    request=json.loads(wire[4:]);calls.append(request)
                    response={key:request[key] for key in ('version','instance','client','id')}
                    response['result']={'Err':message} if len(calls)==1 else {'Ok':{}}
                    data=json.dumps(response).encode();self.payload=bytearray(struct.pack('!I',len(data))+data)
            run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.sessions=['private-first','private-second']
            with patch.object(runner.smoke.socket,'create_connection',side_effect=lambda *a,**k:MatchedSocket()):
                result=run.close();self.assertIs(result,run.close())
            self.assertEqual([c['command'] for c in calls],['stop_session','stop_session','shutdown'])
            self.assertEqual([c['id'] for c in calls],[1,2,3]);self.assertEqual(len({c['client'] for c in calls}),1)
            self.assertEqual([c['args'] for c in calls],[{'session_id':'private-first'},{'session_id':'private-second'},{}])
            self.assertIn('stop_failed',result['errors']);self.assertTrue(result['complete'])
            rows=run.diagnostics['cleanup_requests'];self.assertEqual([r['outcome'] for r in rows],['server_rejected','acknowledged','acknowledged'])
            self.assertEqual([r['rejection_kind'] for r in rows],[kind,None,None]);self.assertEqual(run.diagnostics['version'],2)
            self.assertEqual([r['budget_ms'] for r in rows],[1000]*3)
            self.assertTrue(all(0 < timeout <= 1 for stream in streams for timeout in stream.timeouts))
            self.assertEqual([r['parser_termination_attempted_before_call'] for r in rows],[False]*3)
            self.assertFalse(run.diagnostics['cleanup_outcome']['fallback_used']);runner.validate_diagnostics(run.diagnostics)
            for secret in ('private-first','private-second','/private/secret','token-secret'):self.assertNotIn(secret,json.dumps(run.diagnostics))
    def test_strict_v2_rejection_kind_outcome_relationship(self):
        run=runner.Run(90,clock=lambda:0);run.descriptor=DESCRIPTOR;run.sessions=['private']
        with patch.object(runner.smoke,'rpc',side_effect=runner.smoke.ServerRejected()):run.close()
        diag=run.diagnostics;self.assertEqual(diag['version'],2)
        self.assertEqual([r['rejection_kind'] for r in diag['cleanup_requests']],['other_server_rejection']*2)
        runner.validate_diagnostics(diag)
        mutations=[lambda d:d.update(version=1),lambda d:d['cleanup_requests'][0].update(rejection_kind=None),lambda d:d['cleanup_requests'][0].update(rejection_kind='secret'),lambda d:d['cleanup_requests'][0].update(rejection_kind=[]),lambda d:d['cleanup_requests'][0].update(rejection_kind=True),lambda d:d['cleanup_requests'][0].update(outcome='acknowledged'),lambda d:d['cleanup_requests'][0].update(extra='secret'),lambda d:d['cleanup_requests'][0].pop('rejection_kind')]
        for change in mutations:
            value=json.loads(json.dumps(diag));change(value)
            with self.assertRaises(ValueError):runner.validate_diagnostics(value)
    def test_nonrejections_and_skipped_rows_require_null_kind(self):
        for hard in (0,90):
            run=runner.Run(hard,clock=lambda:0);run.sessions=['private'];run.close()
            self.assertTrue(all(r['rejection_kind'] is None for r in run.diagnostics['cleanup_requests']))
            runner.validate_diagnostics(run.diagnostics)
        run=runner.Run(90,clock=lambda:0);run.close()
        for invalid in ('missing_session','unknown',[],False):
            value=json.loads(json.dumps(run.diagnostics));value['cleanup_requests'][0]['rejection_kind']=invalid
            with self.assertRaises(ValueError):runner.validate_diagnostics(value)

def native_stage_row():
    duration=lambda count=0:{'count':count,'sum_ns':0,'max_ns':0,'errors':0}
    return {'version':1,'read_count':1,'read_bytes':4,'read_min':4,'read_max':4,'read_buckets':[1,0,0,0],
            'publish_count':1,'publish_bytes':4,'read_errors':0,'overflow':False,
            'log_wait':duration(1),'parser_total':duration(1),'append':duration(1),'emit':duration(1),
            'parser':{'serial':duration(1),'reply':duration(1),'replies':[1,0,0],'outcomes':[1,0,0,0,0,0,0,0,0,0],'overflow':False}}


def native_stage_wire(row=None):
    return b'YAM_OUTPUT_STAGES_V1 '+json.dumps(native_stage_row() if row is None else row,separators=(',',':')).encode()+b'\n'


class NativeOutputStageDiagnostics(unittest.TestCase):
    def test_actual_execute_requires_two_rows_without_changing_rpc_or_cleanup(self):
        fixture=ExecuteWiring('test_actual_execute_normal_fake_process_and_rpc_chain')
        code,result,events=fixture.exercise()
        self.assertEqual(code,0);self.assertTrue(result['native_output_stages']['complete'])
        self.assertEqual(len(result['native_output_stages']['rows']),2)
        self.assertEqual(events.count('write_session'),300)
        self.assertEqual(events[-3:],['stop_session','stop_session','shutdown'])
        self.assertTrue(result['cleanup']['complete']);self.assertEqual(result['diagnostics']['version'],2)
        code,missing,again=fixture.exercise(stage_stderr=b'private secret\n')
        self.assertEqual(code,2);self.assertFalse(missing['native_output_stages']['complete'])
        self.assertEqual(events,again);self.assertTrue(missing['cleanup']['complete'])
        self.assertNotIn('private secret',json.dumps(missing))
    def test_only_isolated_fixture_environment_explicitly_opts_in(self):
        env=runner.environment(Path('/owned'),Path('/owned/shell'),Path('/python/bin/python'))
        self.assertEqual(env['YAM_OUTPUT_STAGE_DIAGNOSTICS'],'1')
    def collect(self, data, block=1):
        import io
        collector=runner.NativeOutputStages()
        for i in range(0,len(data),block):collector.feed(data[i:i+block])
        collector.finish()
        return collector
    def test_fragmented_equal_rows_are_two_observations_not_deduplicated(self):
        for block in (1,7,4096):
            value=self.collect(b'ignored secret\n'+native_stage_wire()*2,block).result()
            self.assertTrue(value['complete']);self.assertEqual(value['rows'],[native_stage_row()]*2)
            self.assertNotIn('secret',json.dumps(value));self.assertTrue(value['enabled'])
    def test_zero_and_mixed_counts_strict_schema_no_raw_messages(self):
        row=native_stage_row();row.update(read_count=0,read_bytes=0,read_min=0,read_max=0,read_buckets=[0]*4,publish_count=0,publish_bytes=0)
        for name in ('log_wait','parser_total','append','emit'):row[name]={'count':0,'sum_ns':0,'max_ns':0,'errors':0}
        row['parser']={'serial':dict(row['log_wait']),'reply':dict(row['log_wait']),'replies':[0]*3,'outcomes':[0]*10,'overflow':False}
        self.assertTrue(self.collect(native_stage_wire(row)*2).result()['complete'])
        changes=[lambda r:r.update(read_count=True),lambda r:r.update(extra='secret'),lambda r:r.pop('read_bytes'),
                 lambda r:r.update(read_bytes=-1),lambda r:r.update(overflow=True),lambda r:r.update(read_buckets=[0]*4),
                 lambda r:r['parser'].update(replies=[1,1,0]),lambda r:r['parser'].update(outcomes=[0]*10),
                 lambda r:r['append'].update(max_ns=1),lambda r:r['parser']['serial'].update(errors=2),
                 lambda r:r.update(read_max=4097),lambda r:r.update(version=2),
                 lambda r:r.update(read_count=2,read_bytes=8,read_min=4,read_max=300,read_buckets=[2,0,0,0])]
        for change in changes:
            bad=native_stage_row();change(bad)
            result=self.collect(native_stage_wire(bad)+native_stage_wire()).result()
            self.assertFalse(result['complete']);self.assertNotIn('secret',json.dumps(result))
    def test_missing_extra_malformed_overlong_and_partial_rows_are_incomplete_bounded(self):
        cases=[b'',native_stage_wire(),native_stage_wire()*3,b'YAM_OUTPUT_STAGES_V1 {secret}\n'+native_stage_wire()*2,
               b'YAM_OUTPUT_STAGES_V1 '+b'x'*3000+b'\n'+native_stage_wire()*2,
               b'YAM_OUTPUT_STAGES_V1 \xff\n'+native_stage_wire()*2,native_stage_wire()*2+b'YAM_OUTPUT_STAGES_V1 {',
               native_stage_wire()*2+b'YAM_OUTPUT_STAGES_V1 '+b'['*1000+b']'*1000+b'\n']
        for data in cases:
            collector=self.collect(data);result=collector.result()
            self.assertFalse(result['complete']);self.assertLessEqual(len(result['rows']),2)
            self.assertLessEqual(len(collector.pending),2048);self.assertNotIn('secret',json.dumps(result))
        collector=self.collect(b'x'*1000000+b'\n'+native_stage_wire()*2,4096)
        self.assertTrue(collector.result()['complete']);self.assertLessEqual(len(collector.pending),2048)
    def test_decoder_failure_after_two_rows_cannot_claim_complete(self):
        collector=runner.NativeOutputStages();collector.feed(native_stage_wire()*2)
        with patch.object(runner.json,'loads',side_effect=RecursionError('sensitive decoder context')):
            collector.feed(b'YAM_OUTPUT_STAGES_V1 {}\n')
        collector.finish();self.assertFalse(collector.result()['complete'])
        self.assertNotIn('sensitive',json.dumps(collector.result()))
    def test_histogram_totals_require_witnessed_extrema(self):
        cases=[(2,1,256,[2,0,0,0],257,257),(3,1,256,[3,0,0,0],258,513),
               (2,256,257,[1,1,0,0],513,513),(4,100,3000,[2,1,0,1],3457,4380),
               (2,4,4,[2,0,0,0],8,8)]
        for count,minimum,maximum,buckets,lower,upper in cases:
            for total,valid in ((lower,True),(upper,True),(lower-1,False),(upper+1,False)):
                with self.subTest(count=count,minimum=minimum,maximum=maximum,total=total):
                    row=native_stage_row();row.update(read_count=count,read_min=minimum,read_max=maximum,read_buckets=buckets,read_bytes=total)
                    self.assertEqual(self.collect(native_stage_wire(row)*2).result()['complete'],valid)
        row=native_stage_row();row.update(read_count=1,read_min=1,read_max=256,read_bytes=128)
        self.assertFalse(self.collect(native_stage_wire(row)*2).result()['complete'])
    def test_duplicate_json_keys_at_every_depth_are_invalid(self):
        wire=native_stage_wire()
        for old,new in ((b'"version":1',b'"version":2,"version":1'),
                        (b'"version":1',b'"version":1,"version":1'),
                        (b'"count":1',b'"count":2,"count":1')):
            with self.subTest(new=new):
                result=self.collect(wire.replace(old,new,1)+wire).result()
                self.assertFalse(result['complete']);self.assertIn('invalid_row',result['errors'])
    def test_capture_not_finished_cannot_claim_complete(self):
        collector=runner.NativeOutputStages();collector.feed(native_stage_wire()*2)
        self.assertFalse(collector.result()['complete']);collector.finish();self.assertTrue(collector.result()['complete'])

if __name__ == '__main__': unittest.main()
