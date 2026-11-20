// Author: Jeff.Liu
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createYamAuth,authorizationUrl,verifyIdentity} from '../../../extensions/omp-chatgpt/yam-auth.mjs';

const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'};
const jwt=(nonce,clientId,changes={})=>{
 const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
 const body=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:clientId,sub:'fixture-account',exp:Math.floor(Date.now()/1000)+3600,nonce,...changes})).toString('base64url');
 const input=header+'.'+body;return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');
};
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'yam-oauth-test-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
function server({token,refresh}={}){
 const calls=[];
 const fetchRequest=async(url,init={})=>{
  const path=new URL(url).pathname;calls.push({path,init});
  if(path==='/.well-known/openid-configuration')return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/.well-known/jwks.json'});
  if(path==='/.well-known/jwks.json')return Response.json({keys:[jwk]});
  if(path==='/api/accounts/oauth/token'){
   const form=new URLSearchParams(init.body);
   if(form.get('grant_type')==='refresh_token')return refresh?refresh(form):Response.json({error:'invalid_grant'},{status:400});
   return token(form);
  }
  throw Error('Unexpected auth endpoint');
 };return {calls,fetchRequest};
}
async function login(root,options={}){
 let flow;const network=server({token:form=>Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600,earliest_refresh_at:0,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',id_token:jwt(flow.nonce,form.get('client_id')),...options.token})});
 const auth=createYamAuth({root,fetch:network.fetchRequest,...options});
 await auth.login({timeoutMs:2000,onAuth:async info=>{
  const u=new URL(info.authorizeUrl);flow={nonce:u.searchParams.get('nonce'),host:u.searchParams.get('ext_agent_host_id')};
  if(options.onAuth)await options.onAuth(info);
  const callback=new URL('/auth/callback',info.url);callback.search=new URLSearchParams({state:u.searchParams.get('state'),code:'fixture-code',client_id:'oaiapp_fixture'}).toString();
  assert.equal((await fetch(callback)).status,200);
 }});return {auth,network,flow};
}
test('YAM login uses actual app identity, PKCE and an independently persisted host/client',async()=>fixture(async root=>{
 const {auth,network,flow}=await login(root,{onAuth:async({authorizeUrl})=>{
  const u=new URL(authorizeUrl);assert.equal(u.searchParams.get('agent_name_hint'),'YAM');assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('resource'),'https://api.openai.com/v1');
 }});
 const c=await auth.read();assert.equal(c.access,'fixture-access');assert.equal(c.clientId,'oaiapp_fixture');assert.ok(c.scopes.includes('chatgpt.tokens.use.direct'));assert.equal(c.refresh,undefined);
 const stored=JSON.parse(await readFile(join(root,'auth.json'),'utf8'));assert.equal(stored.hostId,flow.host);assert.equal(stored.credential.refresh,'fixture-refresh');assert.equal((await stat(join(root,'auth.json'))).mode&0o777,0o600);
 const reopened=await createYamAuth({root,fetch:()=>{throw Error('must not register again');}}).read();assert.deepEqual(reopened,c);assert.ok(network.calls.every(c=>c.init.redirect==='error'));
 const returning=authorizationUrl({clientId:stored.registration.clientId,hostId:stored.hostId,state:'s',nonce:'n',verifier:'v',redirectUri:'http://127.0.0.1:1234/auth/callback'});assert.equal(returning.searchParams.has('agent_name_hint'),false);
}));
test('identity rejects invalid signature, issuer, audience, nonce and expiration',()=>{
 assert.equal(verifyIdentity(jwt('nonce','oaiapp_fixture'),{keys:[jwk]},'oaiapp_fixture','nonce').sub,'fixture-account');
 for(const changes of [{iss:'https://evil.invalid'},{aud:'wrong'},{nonce:'wrong'},{exp:1},{sub:''}])assert.throws(()=>verifyIdentity(jwt('nonce','oaiapp_fixture',changes),{keys:[jwk]},'oaiapp_fixture','nonce'));
 assert.throws(()=>verifyIdentity(jwt('nonce','oaiapp_fixture').slice(0,-10)+'bad',{keys:[jwk]},'oaiapp_fixture','nonce'));
});
test('a synchronous browser-open failure rejects login and releases the auth lock',async()=>fixture(async root=>{
 const network=server();
 const auth=createYamAuth({root,fetch:network.fetchRequest,lockTimeoutMs:200});
 const failure=Error('fixture browser launch failed');
 await assert.rejects(auth.login({timeoutMs:500,onAuth(){throw failure;}}),failure);
 await assert.rejects(auth.read(),{code:'YAM_AUTH_REQUIRED'});
 assert.equal(network.calls.some(call=>call.path==='/api/accounts/oauth/token'),false);
}));
test('invalid callback does not consume login; cancellation saves no credential and keeps the host',async()=>fixture(async root=>{
 const auth=createYamAuth({root,fetch:server().fetchRequest});const cancel=new AbortController();let originalHost;
 await assert.rejects(auth.login({signal:cancel.signal,timeoutMs:2000,onAuth:async info=>{
  originalHost=new URL(info.authorizeUrl).searchParams.get('ext_agent_host_id');const wrong=new URL('/auth/callback?state=wrong&code=PRIVATE_CODE',info.url);assert.equal((await fetch(wrong)).status,400);cancel.abort();
 }}),e=>e.name==='AbortError');
 const stored=JSON.parse(await readFile(join(root,'auth.json'),'utf8'));assert.equal(stored.hostId,originalHost);assert.equal(stored.credential,undefined);await assert.rejects(auth.read(),e=>e.code==='YAM_AUTH_REQUIRED');
}));
test('missing plan permission never persists usable tokens or falls back to Pi',async()=>fixture(async root=>{
 await assert.rejects(login(root,{token:{scope:'openid profile email'}}),e=>e.code==='YAM_PLAN_PERMISSION');
 const state=JSON.parse(await readFile(join(root,'auth.json'),'utf8'));assert.equal(state.credential,undefined);assert.equal(state.registration.clientId,'oaiapp_fixture');
}));
test('refresh honors earliest time and atomically persists a rotating token across instances',async()=>fixture(async root=>{
 await login(root);const file=join(root,'auth.json'),state=JSON.parse(await readFile(file,'utf8'));let now=Date.now();state.credential.expires=now+30000;state.credential.earliestRefreshAt=now/1000+10;await writeFile(file,JSON.stringify(state),{mode:0o600});
 let count=0;const network=server({refresh:async form=>{
  count++;assert.equal(form.get('client_id'),'oaiapp_fixture');assert.equal(form.get('refresh_token'),'fixture-refresh');assert.equal(form.has('scope'),false);await new Promise(r=>setTimeout(r,20));return Response.json({access_token:'next-access',refresh_token:'next-refresh',token_type:'Bearer',expires_in:3600,scope:'offline_access resource.invoke chatgpt.tokens.use.direct'});
 }});
 const a=createYamAuth({root,fetch:network.fetchRequest,now:()=>now}),b=createYamAuth({root,fetch:network.fetchRequest,now:()=>now});assert.equal((await a.read()).access,'fixture-access');assert.equal(count,0);
 now+=15000;const values=await Promise.all([a.read(),b.read()]);assert.ok(values.every(c=>c.access==='next-access'));assert.equal(count,1);const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.credential.refresh,'next-refresh');assert.equal(saved.credential.clientId,'oaiapp_fixture');assert.equal(saved.hostId,state.hostId);
}));
test('cancelling during owned refresh preserves its replacement and aborted waiters make no request',async()=>fixture(async root=>{
 await login(root);const file=join(root,'auth.json'),state=JSON.parse(await readFile(file,'utf8'));state.credential.expires=Date.now()+1000;await writeFile(file,JSON.stringify(state),{mode:0o600});
 let started,finish;const entered=new Promise(r=>started=r),waiting=new Promise(r=>finish=r),cancel=new AbortController();const network=server({refresh:async()=>{started();await waiting;return Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct'});}});
 const auth=createYamAuth({root,fetch:network.fetchRequest}),pending=auth.read({signal:cancel.signal});await entered;cancel.abort();finish();await pending;assert.equal(JSON.parse(await readFile(file,'utf8')).credential.refresh,'rotated-refresh');
 const aborted=new AbortController();aborted.abort();await assert.rejects(auth.read({signal:aborted.signal}),e=>e.name==='AbortError');
}));
test('credential files reject symlinks, public modes and invalid refresh without leaking responses',async()=>fixture(async root=>{
 await login(root);const file=join(root,'auth.json'),backup=join(root,'saved.json');await writeFile(backup,await readFile(file));await rm(file);await symlink(backup,file);await assert.rejects(createYamAuth({root}).read());await rm(file);await writeFile(file,await readFile(backup),{mode:0o600});
 const state=JSON.parse(await readFile(file,'utf8'));state.credential.expires=1;await writeFile(file,JSON.stringify(state));const auth=createYamAuth({root,fetch:server({refresh:()=>Response.json({error:'invalid_grant',error_description:'PRIVATE_REFRESH_TOKEN'},{status:400})}).fetchRequest});await assert.rejects(auth.read(),e=>e.code==='YAM_AUTH_REQUIRED'&&!e.message.includes('PRIVATE_REFRESH_TOKEN'));
 await chmod(file,0o644);await assert.rejects(auth.read(),e=>e.code==='YAM_AUTH_STORAGE');
}));
test('cancellation during identity discovery returns promptly without saving credentials',async()=>fixture(async root=>{
 const cancel=new AbortController();let began;
 const started=new Promise(r=>began=r),auth=createYamAuth({root,fetch:(_url,{signal})=>new Promise((_resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const pending=auth.login({signal:cancel.signal});await started;cancel.abort();
 await Promise.race([assert.rejects(pending,e=>e.name==='AbortError'),new Promise((_r,reject)=>setTimeout(()=>reject(Error('Discovery cancellation stalled')),300))]);
 assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).credential,undefined);
}));
test('helper pipe omits refresh and identity tokens, and a killed writer does not strand refresh ownership',async()=>fixture(async root=>{
 const {execFile,spawn}=await import('node:child_process'),{promisify}=await import('node:util');await login(root);
 const helper=new URL('../../../extensions/omp-chatgpt/yam-auth-helper.mjs',import.meta.url).pathname;
 const result=await promisify(execFile)(process.execPath,['--use-env-proxy',helper,root]);const c=JSON.parse(result.stdout);assert.equal(c.access,'fixture-access');assert.doesNotMatch(result.stdout,/fixture-refresh|idToken|refresh/);
 const file=join(root,'auth.json'),state=JSON.parse(await readFile(file,'utf8'));state.credential.expires=1;await writeFile(file,JSON.stringify(state));
 const code=`import {createYamAuth} from ${JSON.stringify(new URL('../../../extensions/omp-chatgpt/yam-auth.mjs',import.meta.url).href)};await createYamAuth({root:${JSON.stringify(root)},fetch:async url=>{if(url.endsWith('/openid-configuration'))return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/.well-known/jwks.json'});if(url.endsWith('/jwks.json'))return Response.json({keys:[${JSON.stringify(jwk)}]});console.log('refresh-owned');await new Promise(r=>setTimeout(r,60000));}}).read();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});const exited=new Promise(r=>child.once('exit',r));
 try{await new Promise((resolve,reject)=>{child.stdout.once('data',b=>String(b).includes('refresh-owned')?resolve():reject(Error('Unexpected probe output')));child.once('error',reject);setTimeout(()=>reject(Error('Refresh writer did not start')),3000).unref();});}finally{child.kill('SIGKILL');await exited;}
 const network=server({refresh:()=>Response.json({access_token:'recovered-access',refresh_token:'recovered-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct'})});
 assert.equal((await createYamAuth({root,fetch:network.fetchRequest}).read()).access,'recovered-access');
}));

test('YAM helper receives the scrubbed system proxy environment, with no Pi dependency',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const code=`import {mock} from 'node:test';import assert from 'node:assert/strict';
 const env={HTTPS_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost,127.0.0.1,::1'};
 const exec=()=>{};exec[Symbol.for('nodejs.util.promisify.custom')]=async(node,args,options)=>{assert.equal(node,'/node');assert.ok(args.includes('--use-env-proxy'));assert.equal(options.env,env);assert.equal(options.detached,true);return {stdout:JSON.stringify({type:'oauth',access:'fixture-access',expires:Date.now()+60000,clientId:'oaiapp_fixture',scopes:['chatgpt.tokens.use.direct']})};};
 mock.module('node:child_process',{namedExports:{execFile:exec}});
 const {createYamSubprocessCredentialReader}=await import(${JSON.stringify(new URL('../../../extensions/omp-chatgpt/runtime.mjs',import.meta.url).href)});
 assert.equal((await createYamSubprocessCredentialReader({node:'/node',authDir:'/private/auth',env})()).access,'fixture-access');`;
 await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code]);
});

test('accepted authorization saves a rotating grant even if its launcher has already cancelled',async()=>fixture(async root=>{
 let flow,entered,finish;const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r),cancel=new AbortController();
 const network=server({token:async form=>{entered();await wait;return Response.json({access_token:'accepted-access',refresh_token:'accepted-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct',id_token:jwt(flow.nonce,form.get('client_id'))});}});
 const auth=createYamAuth({root,fetch:network.fetchRequest}),pending=auth.login({signal:cancel.signal,onAuth:async info=>{const u=new URL(info.authorizeUrl);flow={nonce:u.searchParams.get('nonce')};const callback=new URL('/auth/callback',info.url);callback.search=new URLSearchParams({state:u.searchParams.get('state'),code:'accepted-code',client_id:'oaiapp_fixture'}).toString();await fetch(callback);}});
 await started;cancel.abort();finish();await pending;
 assert.equal((await createYamAuth({root,fetch:()=>{throw Error('No repeat exchange');}}).read()).access,'accepted-access');
 assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).credential.refresh,'accepted-refresh');
}));

test('identity metadata failure happens before token rotation, and recovery saves the verified replacement',async()=>fixture(async root=>{
 await login(root);const file=join(root,'auth.json'),state=JSON.parse(await readFile(file,'utf8'));state.credential.expires=1;await writeFile(file,JSON.stringify(state));
 let unavailable=true,rotations=0;const network=server({refresh:()=>{rotations++;return Response.json({access_token:'verified-access',refresh_token:'verified-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct',id_token:jwt(undefined,'oaiapp_fixture')});}});
 const auth=createYamAuth({root,fetch:(url,init)=>unavailable&&new URL(url).pathname.endsWith('/jwks.json')?Response.json({error:'unavailable'},{status:503}):network.fetchRequest(url,init)});
 await assert.rejects(auth.read(),e=>e.code==='YAM_AUTH_NETWORK');assert.equal(rotations,0,'Metadata failure must never consume a rotating refresh token');assert.equal(JSON.parse(await readFile(file,'utf8')).credential.refresh,'fixture-refresh');
 unavailable=false;assert.equal((await auth.read()).access,'verified-access');assert.equal(rotations,1);assert.equal(JSON.parse(await readFile(file,'utf8')).credential.refresh,'verified-refresh');
}));

test('owner job saves an accepted rotating token after the terminal relay is forcibly killed',async()=>fixture(async root=>{
 const {serveAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs');const {spawn}=await import('node:child_process');
 await login(root);const file=join(root,'auth.json'),state=JSON.parse(await readFile(file,'utf8'));state.credential.expires=1;await writeFile(file,JSON.stringify(state));
 let began,finish,ready;const entered=new Promise(r=>began=r),waiting=new Promise(r=>finish=r),listening=new Promise(r=>ready=r);
 const auth=createYamAuth({root,fetch:server({refresh:async()=>{began();await waiting;return Response.json({access_token:'owner-rotated-access',refresh_token:'owner-rotated-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct'});}}).fetchRequest});
 const serving=serveAuthentication(auth,{onReady:ready});const job=await listening;
 const code=String.raw`import {connect} from 'node:net';const s=connect({host:'127.0.0.1',port:${Number(job.address.split(':')[1])}});s.on('connect',()=>s.write(JSON.stringify({token:${JSON.stringify(job.token)},operation:'read'})+'\n'));s.on('error',()=>{});`;
 const relay=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});const exited=new Promise(r=>relay.once('exit',r));
 try{await entered;relay.kill('SIGKILL');await exited;await new Promise(r=>setTimeout(r,600));finish();await serving;
  assert.equal(JSON.parse(await readFile(file,'utf8')).credential.refresh,'owner-rotated-refresh');
  assert.equal((await createYamAuth({root,fetch:()=>{throw Error('No second rotation');}}).read()).access,'owner-rotated-access');
 }finally{relay.kill();finish();await serving;}
}));

test('owner job disconnect cancels an unaccepted login and never leaves a credential',async()=>fixture(async root=>{
 const {serveAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs');const {connect}=await import('node:net');let ready,opened;const listening=new Promise(r=>ready=r),prompt=new Promise(r=>opened=r);
 const serving=serveAuthentication(createYamAuth({root,fetch:server().fetchRequest}),{onReady:ready,onAuth:opened});const job=await listening;
 const socket=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});socket.on('connect',()=>socket.write(JSON.stringify({token:job.token,operation:'login'})+'\n'));socket.on('error',()=>{});
 await prompt;socket.destroy();await serving;assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).credential,undefined);
}));

test('owner job finishes accepted login after terminal disconnection',async()=>fixture(async root=>{
 const {serveAuthentication}=await import('../../../extensions/omp-chatgpt/auth-job.mjs');const {connect}=await import('node:net');
 let flow,ready,began,finish;const listening=new Promise(r=>ready=r),entered=new Promise(r=>began=r),waiting=new Promise(r=>finish=r);
 const network=server({token:async form=>{began();await waiting;return Response.json({access_token:'accepted-owner-access',refresh_token:'accepted-owner-refresh',token_type:'Bearer',expires_in:3600,scope:'resource.invoke chatgpt.tokens.use.direct',id_token:jwt(flow.nonce,form.get('client_id'))});}});
 const serving=serveAuthentication(createYamAuth({root,fetch:network.fetchRequest}),{onReady:ready,onAuth:async info=>{
  const u=new URL(info.authorizeUrl);flow={nonce:u.searchParams.get('nonce')};const callback=new URL('/auth/callback',info.url);callback.search=new URLSearchParams({state:u.searchParams.get('state'),code:'fixture-code',client_id:'oaiapp_fixture'}).toString();await fetch(callback);
 }});
 const job=await listening,socket=connect({host:'127.0.0.1',port:Number(job.address.split(':')[1])});socket.on('connect',()=>socket.write(JSON.stringify({token:job.token,operation:'login'})+'\n'));socket.on('error',()=>{});
 await entered;socket.destroy();finish();await serving;assert.equal(JSON.parse(await readFile(join(root,'auth.json'),'utf8')).credential.refresh,'accepted-owner-refresh');
}));
