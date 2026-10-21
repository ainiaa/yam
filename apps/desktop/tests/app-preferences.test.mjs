import {test} from 'node:test';
import assert from 'node:assert/strict';
const prefs=await import('../src/app-preferences.ts').catch(()=>null);
test('app preferences normalize system locales and reject unsafe persisted values',()=>{
 assert.ok(prefs,'application preference behavior must exist');
 assert.equal(prefs.resolveLocale('system',['zh-Hans-CN']),'zh-CN');
 assert.equal(prefs.resolveLocale('system',['de-DE']),'en');
 assert.equal(prefs.resolveLocale('en',['zh-CN']),'en');
 assert.deepEqual(prefs.loadAppPreferences(()=>'{bad').value,prefs.defaultAppPreferences);
 assert.ok(prefs.loadAppPreferences(()=>'{bad').error);
 assert.throws(()=>prefs.saveAppPreferences({...prefs.defaultAppPreferences,theme:'javascript:bad'},()=>{}));
});
test('storage write failure preserves previous preference and safe background validation',()=>{
 assert.ok(prefs); assert.throws(()=>prefs.saveAppPreferences({...prefs.defaultAppPreferences},()=>{throw Error('quota')}));
 assert.equal(prefs.isAppPreferences({...prefs.defaultAppPreferences,background:'https://remote/image.png'}),false);
});
test('valid preferences round trip while invalid fields never overwrite storage',()=>{assert.ok(prefs);const value={language:'zh-CN',theme:'mocha',background:null,backgroundStrength:0};let raw; prefs.saveAppPreferences(value,v=>raw=v);assert.deepEqual(prefs.loadAppPreferences(()=>raw),{value,error:null});assert.deepEqual(prefs.loadAppPreferences(()=>null),{value:prefs.defaultAppPreferences,error:null});for(const bad of [null,[],{}, {...value,extra:1},{...value,language:'fr'}, {...value,backgroundStrength:-1},{...value,backgroundStrength:31},{...value,backgroundStrength:NaN},{...value,background:'data:image/svg+xml;base64,AAAA'},{...value,background:'data:image/png;base64,'}])assert.equal(prefs.isAppPreferences(bad),false);assert.equal(prefs.isAppPreferences({...value,background:'data:image/png;base64,AAAA'}),true);assert.ok(prefs.loadAppPreferences(()=>{throw Error('denied')}).error);assert.ok(prefs.loadAppPreferences(()=>'{}').error);});
test('system language honors the first supported preference rather than any later Chinese entry',()=>{assert.equal(prefs.resolveLocale('system',['en-US','zh-CN']),'en');assert.equal(prefs.resolveLocale('system',['fr','zh-TW','en']),'zh-CN');assert.equal(prefs.resolveLocale('system',[]),'en');});
test('stored background rejects malformed base64 before browser decoding',()=>{for(const background of ['data:image/png;base64,A','data:image/png;base64,AA=','data:image/png;base64,AAAA=='])assert.equal(prefs.isAppPreferences({...prefs.defaultAppPreferences,background}),false);});
