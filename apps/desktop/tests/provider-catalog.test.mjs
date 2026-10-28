// Author: Jeff.Liu. Native calls are the only mocked boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderGatewayController,gatewayOrigin,isGatewayIdentity,isModelCatalog,filterCatalogModels} from '../src/provider-catalog.ts';

test('model search matches every keyword across name, ID and owner without changing the catalog',()=>{
 const items=[{id:'route/gpt-sol',display_name:'GPT Sol',owned_by:'Gateway'},{id:'local/claude',display_name:null,owned_by:null},{id:'route/gemini',display_name:'Gemini Flash',owned_by:'Gateway'}],before=structuredClone(items);
 assert.deepEqual(filterCatalogModels(items,'  GPT   gateway '),[items[0]]);
 assert.deepEqual(filterCatalogModels(items,'LOCAL/CLAUDE'),[items[1]]);
 assert.deepEqual(filterCatalogModels(items,'flash ROUTE'),[items[2]]);
 assert.deepEqual(filterCatalogModels(items,'missing'),[]);
 assert.deepEqual(filterCatalogModels(items,'  '),items);
 assert.deepEqual(filterCatalogModels([],'gpt'),[]);assert.deepEqual(items,before);
});

const token='12345678-1234-4234-8234-123456789abc';
const ready=(id=token)=>({query_token:id,status:'identified',http_status:200,version:'0.1.fixture'});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const models=(items=[{id:'provider/model-1',display_name:'Model one',owned_by:'fixture'}])=>({query_token:token,status:'loaded',http_status:200,models:items});

test('R1B catalog DTO validates a complete bounded catalog and safe model identifiers',()=>{
 assert.equal(isModelCatalog(models(),token),true);assert.equal(isModelCatalog(models([]),token),true);
 for(const value of [null,{},models([{id:'bad model',display_name:null,owned_by:null}]),models([{id:'模'.repeat(86),display_name:null,owned_by:null}]),models([{id:'okay',display_name:'bad\nlabel',owned_by:null}]),models(Array.from({length:1001},(_,i)=>({id:String(i),display_name:null,owned_by:null}))),models([{id:'same',display_name:null,owned_by:null},{id:'same',display_name:null,owned_by:null}]),{...models(),http_status:401},{...models(),extra:'secret'},{...models(),query_token:'old'}])assert.equal(isModelCatalog(value,token),false);
 assert.equal(isModelCatalog({query_token:token,status:'pagination_unsupported',http_status:200,models:[]},token),true);
});

test('R1B explicit model load shares the identity mutex and cancels stale catalog responses',async()=>{
 const controller=new ProviderGatewayController(()=>token),calls=[],pending=deferred();controller.select('http://localhost:3425/v1',null);
 const invoke=async(name,args)=>{calls.push([name,args]);return name==='load_provider_models'?pending.promise:null;};
 const first=controller.load(invoke,()=>{});assert.equal(calls.length,1);assert.equal(calls[0][0],'load_provider_models');assert.equal(controller.busy,true);
 await controller.check(invoke,()=>{});assert.equal(calls.length,1);controller.select('http://127.0.0.1:3425',null);assert.equal(calls[1][0],'cancel_provider_gateway');pending.resolve(models());await first;
 assert.equal(controller.catalog.kind,'idle');assert.equal(controller.busy,false);
 await controller.load(async()=>models(),()=>{});assert.equal(controller.catalog.kind,'ready');assert.equal(controller.catalog.value.models[0].id,'provider/model-1');
 controller.cancel();assert.equal(controller.catalog.kind,'idle');
});

test('R1B bad catalog replies and errors preserve manual entry without exposing upstream data',async()=>{
 const controller=new ProviderGatewayController(()=>token);controller.select('http://localhost:3425',null);
 await controller.load(async()=>({...models(),models:[{id:'bad model'}]}),()=>{});assert.equal(controller.catalog.kind,'ready');assert.equal(controller.catalog.value.status,'invalid_response');assert.deepEqual(controller.catalog.value.models,[]);
 await controller.load(async()=>{throw Error('PRIVATE');},()=>{});assert.equal(controller.catalog.value.status,'unavailable');assert.ok(!JSON.stringify(controller.catalog).includes('PRIVATE'));
 controller.select('https://example.com',null);await controller.load(async()=>{assert.fail('remote');},()=>{});assert.equal(controller.catalog.value.status,'unsupported');
});

test('R1A literal loopback origin supports only the documented base paths',()=>{
 for(const [input,origin] of [['http://localhost:3425/v1','http://localhost:3425'],['https://127.0.0.1/','https://127.0.0.1'],['http://[::1]:3425/v1/','http://[::1]:3425']])assert.equal(gatewayOrigin(input),origin);
 for(const input of ['', 'https://example.com/v1','http://127.1/v1','http://2130706433','http://localhost.evil','http://localhost.','http://localhost/prefix/v1','http://localhost/a/../v1','http://user:secret@localhost','http://localhost/?key=secret','http://localhost/#secret','http://localhost:0', ' http://localhost'])assert.equal(gatewayOrigin(input),null,input);
 assert.equal(gatewayOrigin('http://localhost/'+ 'a'.repeat(2048)),null);
});

test('R1A native identity replies bind request identity and do not accept arbitrary upstream strings',()=>{
 assert.equal(isGatewayIdentity(ready(),token),true);
 for(const value of [null,{},ready('other'),{...ready(),extra:'secret'},{...ready(),http_status:401},{...ready(),version:'<script>secret</script>'},{...ready(),status:'anything'},{...ready(),version:'x'.repeat(129)}])assert.equal(isGatewayIdentity(value,token),false);
 assert.equal(isGatewayIdentity({query_token:token,status:'authentication_refused',http_status:401,version:null},token),true);
});

test('R1A explicit check sends only endpoint, key reference and token then exposes a checked snapshot',async()=>{
 const controller=new ProviderGatewayController(()=>token),calls=[],updates=[];
 controller.select('http://127.0.0.1:3425/v1','GATEWAY_API_KEY');
 await controller.check(async(name,args)=>{calls.push([name,args]);return ready();},()=>updates.push(controller.snapshot));
 assert.deepEqual(calls,[['check_provider_gateway',{endpoint:'http://127.0.0.1:3425/v1',apiKeyEnv:'GATEWAY_API_KEY',queryToken:token}]]);
 assert.equal(controller.snapshot.kind,'ready');assert.equal(controller.snapshot.value.version,'0.1.fixture');assert.equal(controller.busy,false);assert.ok(controller.snapshot.checkedAt>0);assert.ok(updates.length>=2);
});

test('R1A unsupported origins never invoke native or consume credentials',async()=>{
 const controller=new ProviderGatewayController(()=>token);controller.select('http://localhost.evil/?key=PRIVATE','PRIVATE_KEY');let calls=0;
 await controller.check(async()=>{calls++;throw Error('no call');},()=>{});
 assert.equal(calls,0);assert.equal(controller.snapshot.value.status,'unsupported');assert.ok(!JSON.stringify(controller.snapshot).includes('PRIVATE'));
});

test('R1A duplicate clicks share one in-flight query and cancellation fences late replies',async()=>{
 const controller=new ProviderGatewayController(()=>token),pending=deferred(),calls=[];controller.select('http://localhost:3425',null);
 const invoke=async(name,args)=>{calls.push([name,args]);return name==='check_provider_gateway'?pending.promise:null;};
 const first=controller.check(invoke,()=>{});await controller.check(invoke,()=>{});assert.equal(calls.length,1);assert.equal(controller.busy,true);
 controller.cancel();assert.deepEqual(calls[1],['cancel_provider_gateway',{queryToken:token}]);pending.resolve(ready());await first;
 assert.equal(controller.snapshot.kind,'idle');assert.equal(controller.busy,false);
});

test('R1A endpoint and key-reference changes fence old success, errors and token mismatches',async()=>{
 for(const fail of [false,true]){
  const controller=new ProviderGatewayController(()=>token),pending=deferred(),calls=[];controller.select('http://localhost:3425','OLD_REF');
  const first=controller.check(async(name,args)=>{calls.push([name,args]);return name==='check_provider_gateway'?pending.promise:null;},()=>{});
  controller.select('http://127.0.0.1:3425','NEW_REF');assert.ok(calls[1],'selection change must cancel the old request');assert.equal(calls[1][0],'cancel_provider_gateway');
  if(fail)pending.reject(Error('PRIVATE_UPSTREAM_ERROR'));else pending.resolve(ready());await first;assert.equal(controller.snapshot.kind,'idle');assert.equal(controller.busy,false);
 }
 const controller=new ProviderGatewayController(()=>token);controller.select('http://localhost:3425',null);
 await controller.check(async()=>ready('wrong-request'),()=>{});assert.equal(controller.snapshot.value.status,'invalid_response');
 await controller.check(async()=>{throw Error('PRIVATE_UPSTREAM_ERROR');},()=>{});assert.equal(controller.snapshot.value.status,'unavailable');assert.ok(!JSON.stringify(controller.snapshot).includes('PRIVATE'));
});
