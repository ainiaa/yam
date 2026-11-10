// Author: Jeff.Liu. Reuse launch templates without copying prompts, argv or conversation identity.
import test from 'node:test';import assert from 'node:assert/strict';import {connectionTemplate,readLastConnection,rememberConnection} from '../src/saved-connections.ts';
const provider={id:'custom',model:'group/model',base_url:'http://127.0.0.1:3425',api_key_env:'GATEWAY_KEY'};
test('saved connection includes only compatible adapter and validated credential references',()=>{const v=connectionTemplate('codex',provider);assert.deepEqual(v,{adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null,provider});assert.notEqual(v.provider,provider);});
test('saved connection rejects incompatible adapter, URL credentials and injected raw credentials',()=>{for(const p of [{...provider,base_url:'https://user:secret@example.com'},{...provider,api_key_env:'sk-secret-x'},{...provider,secret:'key'}])assert.throws(()=>connectionTemplate('codex',p));assert.throws(()=>connectionTemplate('shell',provider));});
test('last connections survive reload per CLI, including an explicit return to native configuration',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 assert.deepEqual(readLastConnection(storage,'codex',provider),provider);
 rememberConnection(storage,'codex',provider);rememberConnection(storage,'claude',{...provider,model:'claude-model'});
 assert.deepEqual(readLastConnection(storage,'codex',null),provider);assert.equal(readLastConnection(storage,'claude',null).model,'claude-model');
 assert.deepEqual(Object.keys(JSON.parse(data.get('yam.lastConnection.codex'))).sort(),['api_key_env','base_url','id','model']);
 rememberConnection(storage,'codex',null);assert.equal(readLastConnection(storage,'codex',provider),null);assert.equal(readLastConnection(storage,'claude',null).model,'claude-model');
});
test('invalid, incompatible and unavailable remembered connections preserve the valid fallback',()=>{
 for(const raw of ['broken','{}',JSON.stringify({...provider,secret:'key'}),JSON.stringify({...provider,id:'claude'}),'x'.repeat(65537)])assert.deepEqual(readLastConnection({getItem:()=>raw},'codex',provider),provider);
 assert.deepEqual(readLastConnection({getItem(){throw Error('unavailable');}},'codex',provider),provider);
 const storage={setItem:assert.fail};assert.throws(()=>rememberConnection(storage,'codex',{...provider,secret:'key'}));
 rememberConnection(storage,'shell',null);
 assert.throws(()=>rememberConnection({setItem(){throw Error('quota');}},'codex',provider),/quota/);
});
