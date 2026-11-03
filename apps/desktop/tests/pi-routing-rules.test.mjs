// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultRules,validateRules,routeFacts,rulesVersion,classifierPrompt} from '../src-tauri/pi/task-rules.mjs';

test('default automatic routing keeps deep and continued tasks at high while allowing explicitly higher review rules',()=>{
 const deep={intent:'new',task:'review',context:'independent',action:'none',depth:'deep',uncertain:false,readOnly:true};
 assert.deepEqual(routeFacts(deep).selection,{model:'strong',effort:'high'});
 assert.deepEqual(routeFacts({...deep,uncertain:true}).selection,{model:'strong',effort:'high'});
 assert.deepEqual(routeFacts({...deep,intent:'continue'},defaultRules,{v:1,model:'strong',effort:'max'}).selection,{model:'strong',effort:'high'});
 const custom=structuredClone(defaultRules);custom.rules.find(r=>r.task==='review').effort='max';
 assert.deepEqual(routeFacts(deep,custom).selection,{model:'strong',effort:'max'});
 assert.throws(()=>{const bad=structuredClone(defaultRules);bad.rules.find(r=>r.task==='review').effort='medium';validateRules(bad);});
});

test('default task rules cover synthetic design fixtures without keyword routing',()=>{
 for(const c of JSON.parse(readFileSync(new URL('./fixtures/pi-routing-cases.json',import.meta.url))))assert.deepEqual(routeFacts(c.facts,defaultRules).selection,c.expected,c.id);
 assert.equal(routeFacts({intent:'new',task:'coding',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true},defaultRules).selection.model,'strong');
});
test('rules validate exact schema, size, identity and conservative fallback',()=>{
 assert.deepEqual(validateRules(defaultRules),defaultRules);
 for(const value of [null,{}, {...defaultRules,v:2},{...defaultRules,script:'x'}, {...defaultRules,fallback:{model:'small',effort:'high'}},{...defaultRules,rules:defaultRules.rules.slice(1)},{...defaultRules,rules:defaultRules.rules.map(r=>({...r,description:'x'.repeat(5000)}))}])assert.throws(()=>validateRules(value));
 const duplicate=structuredClone(defaultRules);duplicate.rules[1].task=duplicate.rules[0].task;assert.throws(()=>validateRules(duplicate));
 const unsafe=structuredClone(defaultRules);unsafe.rules.find(r=>r.task==='coding').model='small';assert.throws(()=>validateRules(unsafe));
 const low=structuredClone(defaultRules);low.rules.find(r=>r.task==='review').effort='low';assert.throws(()=>validateRules(low));
});
test('facts fail conservatively; continuing work and insufficient context cannot silently downgrade',()=>{
 const simple={intent:'new',task:'answer',context:'independent',action:'none',depth:'normal',uncertain:false,readOnly:true};
 for(const value of [null,{}, {...simple,uncertain:'false'}, {...simple,action:'write'}, {...simple,intent:'unknown'}, {...simple,context:'insufficient'}, {...simple,readOnly:false}])assert.equal(routeFacts(value,defaultRules).selection.model,'strong');
 assert.deepEqual(routeFacts({...simple,intent:'continue'},defaultRules,{v:1,model:'strong',effort:'max'}).selection,{model:'strong',effort:'high'});
 assert.deepEqual(routeFacts({...simple,depth:'deep'},defaultRules).selection,{model:'strong',effort:'high'});
 assert.deepEqual(routeFacts({...simple,uncertain:true},defaultRules,{v:1,model:'strong',effort:'max'}).selection,{model:'strong',effort:'high'});
 assert.equal(routeFacts({...simple,depth:'deep',uncertain:true},defaultRules).selection.effort,'high');
});
test('edited rule versions are stable and the classifier contract treats descriptions and conversation as data',()=>{
 const copy=JSON.parse(JSON.stringify(defaultRules));assert.equal(rulesVersion(copy),rulesVersion(defaultRules));
 copy.rules[0].model='strong';assert.notEqual(rulesVersion(copy),rulesVersion(defaultRules));
 const prompt=classifierPrompt(copy);assert.match(prompt,/task/);assert.match(prompt,/Never solve/);assert.match(prompt,/untrusted/i);assert.doesNotMatch(prompt,/difficulty.*simple/);
});
