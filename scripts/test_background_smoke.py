"""Author: Jeff.Liu. Check the shared native smoke protocol at its trust boundary."""
import importlib.util,json,pathlib,struct,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('background_smoke',pathlib.Path(__file__).with_name('background-smoke.py'))
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
platform_spec=importlib.util.spec_from_file_location('background_platform_smoke',pathlib.Path(__file__).with_name('background-platform-smoke.py'))
platform_smoke=importlib.util.module_from_spec(platform_spec);platform_spec.loader.exec_module(platform_smoke)

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
 def setUp(self):self.descriptor={'version':1,'address':'127.0.0.1:12345','token':'a'*64,'instance':'b'*64}
 def test_partial_utf8_frames_preserve_the_bound_request_and_result(self):
  stream=Stream()
  with mock.patch.object(smoke.socket,'create_connection',return_value=stream):
   self.assertEqual(smoke.rpc(self.descriptor,'c'*64,7,'list_sessions'),'中文😀')
  self.assertEqual(stream.request['args'],{});self.assertEqual(stream.request['id'],7);self.assertEqual(stream.request['command'],'list_sessions')
 def test_wrong_reply_identity_and_oversized_frames_are_rejected(self):
  for change in [{'version':2},{'instance':'d'*64},{'client':'d'*64},{'id':8}]:
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
