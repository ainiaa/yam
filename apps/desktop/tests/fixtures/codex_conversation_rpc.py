"""Synthetic read-only stdio server. Author: Jeff.Liu."""
import json, os, sys, time
mode=sys.argv[1]
expected=['initialize','thread/read','thread/items/list']
for i,line in enumerate(sys.stdin):
 r=json.loads(line)
 if r.get('method')=='initialized': continue
 assert r['method']==expected.pop(0),r
 if mode=='hang': time.sleep(3)
 if r['method']=='initialize': result={'userAgent':'fixture'}
 elif r['method']=='thread/read':
  thread={'id':'native-one','cwd':os.getcwd(),'modelProvider':'yam_api','historyMode':'paginated'}
  if mode in ['thread','cwd','provider']: thread[{'thread':'id','cwd':'cwd','provider':'modelProvider'}[mode]]='wrong'
  if mode=='legacy': thread['historyMode']='legacy'
  if mode=='missing_mode': del thread['historyMode']
  result={'thread':thread}
 else:
  assert r['params']['limit']==(50 if mode=='projection_boundary' else 2) and r['params']['sortDirection'] in ['asc','desc']
  if r['params'].get('cursor'):
   assert r['params']['cursor']=='native-next'; data=[{'turnId':'turn-two','item':{'id':'agent-two','type':'agentMessage','text':'reply'}}];cursor=None
  else:
   data=[{'turnId':'turn-one','item':{'id':'user-one','type':'userMessage','content':[{'type':'text','text':'hello <script>'}]}},{'turnId':'turn-one','item':{'id':'reason','type':'reasoning','summary':['SECRET_REASONING'],'content':['SECRET_REASONING']}}];cursor='native-next'
  if mode=='empty': data=[];cursor=None
  if mode=='duplicate': data=[data[0],data[0]]
  if mode=='too_many': data=data*3
  if mode=='bad_item': data=[{'item':{'id':'bad'}}]
  if mode=='projection_boundary':
   data=[{'turnId':'turn-one','item':{'id':f'item-{n}','type':'agentMessage','text':''}} for n in range(50)]
   empty={'id':r['id'],'result':{'data':data,'nextCursor':cursor}}
   room=(1024*1024-len(json.dumps(empty,separators=(',',':')).encode())-2)//50
   for row in data: row['item']['text']='x'*room
  result={'data':data,'nextCursor':cursor}
 if mode=='bad_json': print('{bad',flush=True);continue
 if mode in ['big','unterminated']: sys.stdout.write('x'*(1024*1024+1)+('\n' if mode=='big' else ''));sys.stdout.flush();continue
 response={'id':r['id']+1 if mode=='wrong_id' else r['id'],'result':result}
 if mode=='rpc_error': response={'id':r['id'],'error':{'message':'SECRET_ERROR'}}
 print(json.dumps(response,separators=(',',':')) if mode=='projection_boundary' else json.dumps(response),flush=True)
 if mode=='blocked_write' and r['method']=='thread/read': time.sleep(3)
