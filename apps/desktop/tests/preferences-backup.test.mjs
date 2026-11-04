// Author: Jeff.Liu. Backups cannot contain credentials, session state, paths or prompts.
import test from 'node:test';import assert from 'node:assert/strict';import {createPreferencesBackup,parsePreferencesBackup,preferencesImportWrites,applyPreferencesImport} from '../src/preferences-backup.ts';
import {piSetupMapping,piSetupStorageKey,restorePiSetup,parsePiDraft,validatePiDraft} from '../src/pi-routing.ts';
import {defaultRules} from '../src-tauri/pi/task-rules.mjs';
const appearance={language:'en',theme:'nord',background:null,backgroundStrength:12};
const provider={id:'custom',model:'gateway/model',base_url:'http://127.0.0.1:3425',api_key_env:'GATEWAY_KEY'};
const row={id:'11111111-1111-4111-8111-111111111111',name:'Magpie',adapter:'codex',mode:'interactive',extra_args:'',prompt:'PRIVATE_PROMPT',command:null,provider};
test('Pi policy backup migrates roles, fixed selection and rules without exporting its machine gateway',()=>{
 const rules=structuredClone(defaultRules);rules.rules.find(r=>r.task==='review').effort='max';
 const mapping=piSetupMapping({gateway:'https://PRIVATE_HOST.example/v1',small:'yam-codex/sol',strong:'yam-codex/strong',classifier:'yam-codex/sol',model:'yam-codex/strong',effort:'high',rules:JSON.stringify(rules)},'--yam-billing subscription');
 const raw=createPreferencesBackup(k=>k===piSetupStorageKey?JSON.stringify(mapping):null,[],true);assert.ok(!raw.includes('PRIVATE_HOST'));const backup=parsePreferencesBackup(raw,true);
 assert.equal(backup.version,2);assert.equal(backup.piRouting.billing,'subscription');assert.equal(backup.piRouting.rules.rules.find(r=>r.task==='review').effort,'max');
 const current=JSON.stringify({gateway:'http://127.0.0.1:4123',small:'p/local',strong:'p/local',classifier:'p/local'}),writes=preferencesImportWrites(backup,[],undefined,null,null,current),saved=JSON.parse(writes[piSetupStorageKey]);
 assert.equal(saved.gateway,'http://127.0.0.1:4123');assert.equal(saved.small,'yam-codex/sol');const args=restorePiSetup('',writes[piSetupStorageKey]),draft=parsePiDraft(args);assert.equal(draft.model,'yam-codex/strong');assert.equal(draft.effort,'high');assert.match(args,/--yam-billing subscription/);assert.match(validatePiDraft(draft,[],args),/unavailable/);
 assert.equal(JSON.parse(preferencesImportWrites(backup,[])[piSetupStorageKey]).gateway,null);
});
test('legacy backups preserve Pi defaults while unknown Pi fields and malformed policies fail before writing',()=>{
 const legacy=parsePreferencesBackup('{"version":1,"settings":{},"connections":[]}',true);assert.equal(piSetupStorageKey in preferencesImportWrites(legacy,[]),false);
 const policy={v:1,small:'p/small',strong:'p/strong',classifier:'p/small',model:'auto',effort:'auto',billing:'configured',rules:defaultRules};
 for(const piRouting of [{...policy,gateway:'http://remote'},{...policy,token:'secret'},{...policy,effort:'invalid'},{...policy,small:'https://user:secret@host'},{...policy,billing:'subscription'},{...policy,rules:{...defaultRules,token:'secret'}}])assert.throws(()=>parsePreferencesBackup(JSON.stringify({version:2,settings:{},connections:[],piRouting}),true));
 const backup=parsePreferencesBackup(JSON.stringify({version:2,settings:{},connections:[],piRouting:policy}),true);assert.throws(()=>preferencesImportWrites(backup,[],undefined,null,null,'{broken'));
});
test('Pi policy import rolls back the local mapping together with other preferences on storage failure',()=>{
 const policy={v:1,small:'p/small',strong:'p/strong',classifier:'p/small',model:'auto',effort:'auto',billing:'configured',rules:defaultRules};
 const backup=parsePreferencesBackup(JSON.stringify({version:2,settings:{'yam.appAppearance.v1':appearance},connections:[],piRouting:policy}),true),local=JSON.stringify({gateway:'http://127.0.0.1:4123',small:'p/local',strong:'p/local',classifier:'p/local'}),store=new Map([[piSetupStorageKey,local]]);let failed=false;
 const writes=preferencesImportWrites(backup,[],undefined,null,null,local),storage={getItem:k=>store.get(k)??null,setItem(k,v){if(k==='yam.appAppearance.v1'&&!failed){failed=true;throw Error('disk full');}store.set(k,v);},removeItem:k=>store.delete(k)};
 assert.throws(()=>applyPreferencesImport(storage,writes),/Previous preferences were restored/);assert.deepEqual([...store],[[piSetupStorageKey,local]]);
});
test('Pi policy migration cannot weaken an existing subscription-only default',()=>{
 const local=JSON.stringify(piSetupMapping({gateway:null,small:'yam-codex/sol',strong:'yam-codex/sol',classifier:'yam-codex/sol',model:'auto',effort:'auto'},'--yam-billing subscription'));
 const policy={v:1,small:'p/api',strong:'p/api',classifier:'p/api',model:'auto',effort:'auto',billing:'configured',rules:defaultRules},backup=parsePreferencesBackup(JSON.stringify({version:2,settings:{},connections:[],piRouting:policy}),true);
 assert.throws(()=>preferencesImportWrites(backup,[],undefined,null,null,local),/Subscription-only/);
 backup.piRouting={...policy,small:'yam-codex/sol',strong:'yam-codex/sol',classifier:'yam-codex/sol'};assert.equal(JSON.parse(preferencesImportWrites(backup,[],undefined,null,null,local)[piSetupStorageKey]).billing,'subscription');
});
test('malformed explicit saved policy values are rejected instead of silently restoring defaults',()=>{
 const mapping=piSetupMapping({gateway:null,small:'p/small',strong:'p/strong',classifier:'p/small',model:'auto',effort:'auto'},'');
 for(const key of ['model','effort','billing','rules']){
  const raw=JSON.stringify({...mapping,[key]:null});assert.equal(restorePiSetup('',raw),null,key);assert.throws(()=>createPreferencesBackup(k=>k===piSetupStorageKey?raw:null,[],true),undefined,key);
 }
});
test('backup uses an allowlist and strips image/background and template prompts',()=>{const store=new Map([['yam.appAppearance.v1',JSON.stringify({...appearance,background:'data:image/png;base64,AAAA'})],['auth.json','PRIVATE_AUTH'],['yam.window.main.terminalLayout','PRIVATE_LAYOUT']]);const raw=createPreferencesBackup(k=>store.get(k)??null,[row],true);assert.ok(!raw.includes('PRIVATE_'));const b=parsePreferencesBackup(raw,true);assert.equal(b.settings['yam.appAppearance.v1'].background,null);assert.equal(b.connections[0].provider.api_key_env,'GATEWAY_KEY');});
test('malformed, oversized, unknown settings and resolved credential fields fail before any writes',()=>{for(const raw of ['{',JSON.stringify({version:2,settings:{},connections:[]}),JSON.stringify({version:1,settings:{'auth.json':'secret'},connections:[]}),JSON.stringify({version:1,settings:{},connections:[{name:'x',adapter:'codex',provider:{...provider,key:'secret'}}]}),' '.repeat(1048577)])assert.throws(()=>parsePreferencesBackup(raw,true));});
test('import preserves existing template prompts, merges only validated connections and omits layout',()=>{const backup=parsePreferencesBackup(JSON.stringify({version:1,settings:{'yam.appAppearance.v1':appearance},connections:[{name:'Magpie',adapter:'codex',provider}]}),true);const writes=preferencesImportWrites(backup,[row],()=> '22222222-2222-4222-8222-222222222222');assert.ok(!Object.keys(writes).some(k=>k.includes('window')));const templates=JSON.parse(writes['yam.launchTemplates.v1']);assert.ok(JSON.stringify(templates).includes('PRIVATE_PROMPT'));assert.equal(Object.keys(writes).length,2);});

test('failed preference write rolls back every original value and never touches session keys',()=>{const values=new Map([['yam.terminalSettings','old']]);let failed=false;const storage={getItem:k=>values.get(k)??null,setItem(k,v){if(k==='yam.terminalCursor.v1'&&!failed){failed=true;throw Error('disk full');}values.set(k,v);},removeItem:k=>values.delete(k)};assert.throws(()=>applyPreferencesImport(storage,{'yam.terminalSettings':'new','yam.terminalCursor.v1':'cursor'}),/Previous preferences were restored/);assert.deepEqual([...values],[['yam.terminalSettings','old']]);});

test('connection import refuses unreadable existing templates before producing writes',()=>{const backup=parsePreferencesBackup(JSON.stringify({version:1,settings:{},connections:[{name:'Magpie',adapter:'codex',provider}]}),true);assert.throws(()=>preferencesImportWrites(backup,[],()=> '22222222-2222-4222-8222-222222222222','unreadable templates'),/saved connections/i);});

test('import of appearance never clears a local background image excluded from backup',()=>{const b=parsePreferencesBackup(JSON.stringify({version:1,settings:{'yam.appAppearance.v1':appearance},connections:[]}),true);const current={...appearance,background:'data:image/png;base64,AAAA'};const writes=preferencesImportWrites(b,[],undefined,null,current);assert.equal(JSON.parse(writes['yam.appAppearance.v1']).background,current.background);});
