#!/usr/bin/env python3
"""Author: Jeff.Liu. Real CLI round/ACK probe; only synthetic public prompts."""
import argparse,json,os,pathlib,socket,subprocess,tempfile,threading,time,urllib.request,base64,secrets,signal

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cli',required=True);parser.add_argument('--model',required=True)
    parser.add_argument('--extended',action='store_true')
    args=parser.parse_args()
    plugin=(pathlib.Path(__file__).resolve().parents[1]/'apps/desktop/src-tauri/src/opencode-plugin.mjs').as_uri()
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(.2)
    events=[];errors=[];stop=threading.Event()
    def receive():
        while not stop.is_set():
            try: connection,_=listener.accept()
            except TimeoutError: continue
            with connection:
                connection.settimeout(2);raw=b''
                try:
                    while chunk:=connection.recv(4096):
                        raw+=chunk
                        if len(raw)>4096: raise ValueError('oversized event')
                        if raw.endswith(b'\n'): break
                    wire=json.loads(raw);assert wire['version']==1 and wire['token']=='a'*64
                    events.append(wire['event']);connection.sendall(b'{"accepted":true}')
                except Exception as error:errors.append(type(error).__name__)
    worker=threading.Thread(target=receive);worker.start()
    env=os.environ.copy();config=json.loads(env.get('OPENCODE_CONFIG_CONTENT') or '{}')
    config['plugin']=[*config.get('plugin',[]),plugin]
    if args.extended:config['permission']={'*':'deny','read':'ask'}
    env.update(OPENCODE_CONFIG_CONTENT=json.dumps(config),YAM_AGENT_ADDRESS=f'127.0.0.1:{listener.getsockname()[1]}',YAM_AGENT_TOKEN='a'*64)
    try:
        with tempfile.TemporaryDirectory(prefix='yam-opencode-round-') as directory:
            probe=socket.socket();probe.bind(('127.0.0.1',0));port=probe.getsockname()[1];probe.close()
            password=secrets.token_hex(32);env['OPENCODE_SERVER_PASSWORD']=password
            logfile=open(pathlib.Path(directory)/'server.log','w')
            server=subprocess.Popen([args.cli,'serve','--hostname','127.0.0.1','--port',str(port)],cwd=directory,env=env,stdout=logfile,stderr=logfile,start_new_session=True)
            url=f'http://127.0.0.1:{port}'
            auth='Basic '+base64.b64encode(('opencode:'+password).encode()).decode()
            ready=False
            for _ in range(100):
                try:
                    request=urllib.request.Request(url+'/global/health',headers={'Authorization':auth})
                    with urllib.request.urlopen(request,timeout=.5) as response:
                        ready=json.loads(response.read(4096)).get('healthy') is True
                    if ready:break
                except OSError:pass
                time.sleep(.1)
            assert ready,'isolated authenticated OpenCode server did not become ready'
            session=None
            for number in (1,2):
                argv=[args.cli,'run','--attach',url,'--model',args.model,'--format','json']
                if session:argv+=['--session',session]
                argv+=[f'Reply only YAM_ROUND_{number}. Do not use tools.']
                result=subprocess.run(argv,cwd=directory,env=env,capture_output=True,text=True,timeout=90)
                assert result.returncode==0,f'CLI exited {result.returncode}'
                for _ in range(30):
                    if len([e for e in events if e['kind']=='TurnComplete'])>=number:break
                    time.sleep(.1)
                prompts=[e for e in events if e['kind']=='UserPromptSubmit']
                replies=[e for e in events if e['kind']=='TurnComplete']
                assert len(prompts)==number and len(replies)==number,f'native round/ACK chain incomplete: {[e["kind"] for e in events]}'
                session=prompts[-1]['agent_session_id']
                assert replies[-1]['agent_session_id']==session and replies[-1]['turn_id']==prompts[-1]['turn_id']
            assert prompts[0]['turn_id']!=prompts[1]['turn_id'];assert not errors
            assert all(e['source']=='opencode' for e in events)
            if args.extended:
                def api(path,body=None):
                    request=urllib.request.Request(url+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':auth,'Content-Type':'application/json'})
                    with urllib.request.urlopen(request,timeout=5) as response:
                        raw=response.read(1024*1024)
                        return json.loads(raw) if raw else None
                def wait_for(predicate,label):
                    deadline=time.monotonic()+60
                    while time.monotonic()<deadline:
                        value=predicate()
                        if value:return value
                        time.sleep(.1)
                    metadata=[{'role':m['info']['role'],'finish':m['info'].get('finish'),'error_name':m['info'].get('error',{}).get('name'),'completed':bool(m['info'].get('time',{}).get('completed')),'parent':m['info'].get('parentID')} for m in api('/session/'+session+'/message')]
                    raise AssertionError('Native scenario did not complete: '+label+'; events='+json.dumps([{'kind':e['kind'],'turn':e['turn_id']} for e in events])+'; messages='+json.dumps(metadata))
                def prompt(text,model=None,target=None):
                    api('/session/'+(target or session)+'/prompt_async',{'parts':[{'type':'text','text':text}],'model':model or {'providerID':args.model.split('/')[0],'modelID':args.model.split('/',1)[1]}})
                pathlib.Path(directory,'fixture.txt').write_text('YAM_PUBLIC_PERMISSION_FIXTURE')
                prompt('Use the read tool to read fixture.txt exactly once. If permission is rejected, do not retry; reply only YAM_PERMISSION_REJECTED.')
                permission=wait_for(lambda:next((e for e in events if e['kind']=='PermissionRequest'),None),'permission waiting')
                # Reject a test-only request: no durable grant and no new access to user files.
                api('/permission/'+permission['permission_key']+'/reply',{'reply':'reject'})
                wait_for(lambda:any(e['kind']=='ToolProgress' and e['turn_id']==permission['turn_id'] for e in events),'permission resumed')
                wait_for(lambda:any(e['kind']=='Interrupt' and e['turn_id']==permission['turn_id'] for e in events),'permission rejected round interruption')
                count=len([e for e in events if e['kind']=='UserPromptSubmit'])
                prompt('Reply only YAM_ERROR_PROBE. Do not use tools.',{'providerID':'opencode','modelID':'yam-validation-model-does-not-exist'})
                wait_for(lambda:len([e for e in events if e['kind']=='UserPromptSubmit'])>count,'error submission')
                failed_turn=[e for e in events if e['kind']=='UserPromptSubmit'][-1]['turn_id']
                wait_for(lambda:any(e['kind']=='TurnFailed' and e['turn_id']==failed_turn for e in events),'native model error')
                count=len([e for e in events if e['kind']=='UserPromptSubmit'])
                prompt('List 1000 integers with a sentence for each. Do not use tools.')
                wait_for(lambda:len([e for e in events if e['kind']=='UserPromptSubmit'])>count,'interrupt submission')
                aborted_turn=[e for e in events if e['kind']=='UserPromptSubmit'][-1]['turn_id']
                api('/session/'+session+'/abort',{})
                wait_for(lambda:any(e['kind']=='Interrupt' and e['turn_id']==aborted_turn for e in events),'native interruption')
                child=api('/session',{'parentID':session,'title':'YAM isolated child probe'})['id']
                count=len(events);prompt('Reply only YAM_CHILD_PROBE. Do not use tools.',target=child)
                wait_for(lambda:any(m['info'].get('time',{}).get('completed') for m in api('/session/'+child+'/message') if m['info']['role']=='assistant'),'child completion')
                time.sleep(.3);assert len(events)==count,'child events contaminated main session'
                assert not any(e['kind']=='TurnComplete' and e['turn_id'] in [failed_turn,aborted_turn] for e in events)
                assert not errors
            print(json.dumps({'status':'passed','rounds':2,'events':len(events),'extended':args.extended,'native_session_id':session}))
    finally:
        if 'server' in locals():
            if server.poll() is None:
                os.killpg(server.pid,signal.SIGTERM)
                try:server.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait(timeout=3)
            logfile.close()
        stop.set();worker.join();listener.close()

if __name__=='__main__': main()
