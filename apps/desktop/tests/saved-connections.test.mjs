// Author: Jeff.Liu. Reuse launch templates without copying prompts, argv or conversation identity.
import test from 'node:test';import assert from 'node:assert/strict';import {connectionTemplate} from '../src/saved-connections.ts';
const provider={id:'custom',model:'group/model',base_url:'http://127.0.0.1:3425',api_key_env:'GATEWAY_KEY'};
test('saved connection includes only compatible adapter and validated credential references',()=>{const v=connectionTemplate('codex',provider);assert.deepEqual(v,{adapter:'codex',mode:'interactive',extra_args:'',prompt:null,command:null,provider});assert.notEqual(v.provider,provider);});
test('saved connection rejects incompatible adapter, URL credentials and injected raw credentials',()=>{for(const p of [{...provider,base_url:'https://user:secret@example.com'},{...provider,api_key_env:'sk-secret-x'},{...provider,secret:'key'}])assert.throws(()=>connectionTemplate('codex',p));assert.throws(()=>connectionTemplate('shell',provider));});
