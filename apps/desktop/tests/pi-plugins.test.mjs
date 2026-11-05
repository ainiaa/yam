// Author: Jeff.Liu. Validate only explicit npm Pi package metadata.
import {test} from 'node:test';import assert from 'node:assert/strict';
const api=await import('../src/pi-plugins.ts').catch(()=>null);
const state={revision:'a'.repeat(64),pi_available:true,configured_names:['pi-one'],packages:[{name:'pi-one',source:'npm:pi-one@1.0.0'}],other_count:1};
test('Pi plugin responses retain pinned sources and reject malformed or injected metadata',()=>{
 assert.ok(api,'Pi plugin response parser exists');assert.deepEqual(api.parsePiPackageState(state),state);
 const search={packages:[{name:'@scope/pi-two',version:'2.1.0',source:'npm:@scope/pi-two@2.1.0',description:'useful'}]};assert.deepEqual(api.parsePiPackageSearch(search),search);
 for(const bad of [{...state,revision:'old'},{...state,pi_available:'yes'},{...state,packages:[{name:'pi-one',source:'git:https://private:SECRET@host/path'}]}])assert.throws(()=>api.parsePiPackageState(bad));
 for(const source of ['npm:pi-two@2.1.0;echo BAD','npm:other@2.1.0','npm:@scope/pi-two@latest'])assert.throws(()=>api.parsePiPackageSearch({packages:[{...search.packages[0],source}]}));
 assert.throws(()=>api.parsePiPackageSearch({packages:Array(31).fill(search.packages[0])}));
});
