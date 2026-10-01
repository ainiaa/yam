"""Author: Jeff.Liu. Check the shared native smoke protocol at its trust boundary."""
import importlib.util,json,pathlib,struct,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('background_smoke',pathlib.Path(__file__).with_name('background-smoke.py'))
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)

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
