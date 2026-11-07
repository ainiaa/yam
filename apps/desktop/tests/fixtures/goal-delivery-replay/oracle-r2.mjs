// Author: Jeff.Liu. Frozen independent repository-replay oracle.
import assert from 'node:assert/strict';import {test} from 'node:test';
const fixtureUrl=__FIXTURE_URL__;
const api=await import(fixtureUrl+'native-codex.mjs');
test('native refresh replaces same-id model metadata and republishes the physical catalog',async()=>{
 const model={provider:'openai-codex',id:'same',input:['text'],contextWindow:1000,thinkingLevelMap:{high:'high'}};let current=model;const providers=[];
 const bridge=api.createNativeCodex({registerCommand(){},registerProvider:(_p,v)=>providers.push(v)},{loadModels:async()=>[current],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files','image_input']}]});
 const ctx={modelRegistry:{getAll:()=>[]}};await bridge.initialize(ctx);
 for(const patch of [{input:['text','image'],contextWindow:2000,thinkingLevelMap:{high:null}},{input:['text'],contextWindow:500,thinkingLevelMap:{high:'high'}}]){
  current={...model,...patch};await bridge.initialize(ctx);const resolved=bridge.resolveModel(ctx,model);
  assert.deepEqual(resolved.input,current.input);assert.equal(resolved.contextWindow,current.contextWindow);assert.deepEqual(resolved.thinkingLevelMap,current.thinkingLevelMap);assert.deepEqual(providers.at(-1).models.find(m=>m.id==='same'),resolved);
 }
 const count=providers.length;await bridge.initialize(ctx);assert.equal(providers.length,count,'unchanged discovery does not republish the catalog');
});

test('native fallback refresh ignores its own wrapped catalog and keeps fresh OAuth metadata',async()=>{
 let source={provider:'openai',id:'same',name:'Model',input:['text'],contextWindow:1000};const providers=[];
 const ctx={modelRegistry:{getAll:()=>[source,...providers.at(-1)?.models??[]],isUsingOAuth:m=>m.provider==='openai'}};
 const bridge=api.createNativeCodex({registerCommand(){},registerProvider:(_p,v)=>providers.push(v)},{loadModels:async()=>[],discover:async()=>[{kind:'codex',auth:'subscription',capabilities:['text','files','image_input']}]});
 await bridge.initialize(ctx);source={...source,input:['text','image']};await bridge.initialize(ctx);const resolved=bridge.resolveModel(ctx,source);
 assert.deepEqual(resolved.input,['text','image']);assert.equal(resolved.name,'Codex CLI · Model');const count=providers.length;await bridge.initialize(ctx);assert.equal(providers.length,count);
});
