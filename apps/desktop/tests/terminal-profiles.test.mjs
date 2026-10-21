// Author: Jeff.Liu. Profile storage never executes launch or serialization hooks.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as profiles from '../src/terminal-profiles.ts';
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const row=(n=1,extra={})=>({id:id(n),name:`Profile ${n}`,shell:null,cwd:{mode:'context',path:null},envRefs:{},appearance:null,...extra});
const store=(rows=[row()],defaultId=null)=>({version:3,profiles:rows,defaultId});
const memory=(value=null)=>({value,fail:false,writes:[],getItem(){return this.value;},setItem(key,raw){this.writes.push([key,raw]);if(this.fail)throw Error('PRIVATE_STORAGE_SENTINEL');this.value=raw;}});
const draft=(extra={})=>({name:'New',shell:null,cwd:{mode:'context',path:null},envRefs:{},appearance:null,...extra});
test('A02 profile codec roundtrips all cwd and both platform shell shapes',()=>{
 const rows=[row(1),row(2,{shell:{program:'/installed shells/中文/zsh',login:false},cwd:{mode:'home',path:null}}),row(3,{shell:{program:'C:\\Windows\\cmd.exe',login:null},cwd:{mode:'explicit',path:'C:\\Work space\\中文'}}),row(4,{shell:{program:null,login:true},cwd:{mode:'explicit',path:'/path with spaces/中文'}})];
 assert.deepEqual(profiles.decodeTerminalProfiles(null),store([]));assert.deepEqual(profiles.decodeTerminalProfiles(profiles.encodeTerminalProfiles(store(rows,id(2)))),store(rows,id(2)));
});
test('A02 exact data codec rejects unknown Agent fields and malformed defaults',()=>{
 for(const v of [null,[],{}, {...store(),version:4},{...store(),env:{}},store([row(1,{adapter:'codex'})]),store([row(1,{shell:{program:null,login:true,argv:[]}})]),store([row(1,{cwd:{mode:'context',path:'/wrong'}})]),store([row(1),row(1)]),store([row(1),row(2,{name:'Profile 1'})]),store([row(1,{id:'bad'})]),store([row(1,{name:' spaced '})]),store([row()],id(2))])assert.throws(()=>profiles.encodeTerminalProfiles(v));
 for(const raw of ['oops','null','[]',JSON.stringify({...store(),version:4})])assert.throws(()=>profiles.decodeTerminalProfiles(raw));
});
test('A02 nested getters serialization hooks symbol hidden keys prototypes and sparse arrays cannot execute',()=>{
 let hooks=0;
 for(const [target,key] of [['row','name'],['shell','program'],['cwd','path'],['store','profiles']]){
  const r=row(1,{shell:{program:'/bin/zsh',login:false}}),s=store([r]);const value=target==='row'?r:target==='store'?s:r[target];Object.defineProperty(value,key,{enumerable:true,get(){hooks++;return 'PRIVATE_SENTINEL';}});assert.throws(()=>profiles.encodeTerminalProfiles(s));
 }
 for(const kind of ['toJSON','hidden','symbol','prototype']){const r=row();if(kind==='toJSON')r.toJSON=()=>{hooks++;return null;};if(kind==='hidden')Object.defineProperty(r,'extra',{value:1});if(kind==='symbol')r[Symbol('extra')]=1;if(kind==='prototype')Object.setPrototypeOf(r,{toJSON(){hooks++;}});assert.throws(()=>profiles.encodeTerminalProfiles(store([r])));}
 const sparse=Array(1);assert.throws(()=>profiles.encodeTerminalProfiles(store(sparse)));const hooked=[row()];Object.defineProperty(hooked,'toJSON',{value:()=>{hooks++;return [];}});assert.throws(()=>profiles.encodeTerminalProfiles(store(hooked)));assert.equal(hooks,0);
 const original=Object.prototype.toJSON;Object.prototype.toJSON=function(){hooks++;return {secret:'PRIVATE_SENTINEL'};};try{assert.equal(profiles.encodeTerminalProfiles(store()).includes('PRIVATE_SENTINEL'),false);assert.equal(hooks,0);}finally{if(original===undefined)delete Object.prototype.toJSON;else Object.prototype.toJSON=original;}
});
test('A02 finite names count UTF8 path bytes and raw UTF16 storage budget',()=>{
 assert.equal(profiles.normalizeProfileName(' '+ '😀'.repeat(80)+' '),'😀'.repeat(80));for(const name of ['','  ','😀'.repeat(81)])assert.throws(()=>profiles.normalizeProfileName(name));
 const rows=Array.from({length:32},(_,i)=>row(i+1));assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(store(rows)));assert.throws(()=>profiles.encodeTerminalProfiles(store([...rows,row(33)])));
 const valid='/'+ '中'.repeat(1365);assert.equal(Buffer.byteLength(valid),4096);assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(store([row(1,{cwd:{mode:'explicit',path:valid}})])));
 for(const path of [valid+'x','relative','~/$HOME',' /valid','/valid ','/bad\n','/bad\0','C:relative'])assert.throws(()=>profiles.encodeTerminalProfiles(store([row(1,{cwd:{mode:'explicit',path}})])));
 const raw=JSON.stringify(store([]));assert.deepEqual(profiles.decodeTerminalProfiles(raw+' '.repeat(524288-raw.length)),store([]));assert.throws(()=>profiles.decodeTerminalProfiles(raw+' '.repeat(524289-raw.length)),/limit/);
});
test('A02 collection CRUD persists first and defaults never dangle',()=>{
 const storage=memory(),c=new profiles.TerminalProfileCollection(storage,(()=>{let n=1;return()=>id(n++);})());c.load();assert.equal(c.loadError,null);assert.equal(storage.writes.length,0);
 const first=c.save(draft({name:' First '}));assert.equal(first.name,'First');assert.equal(c.defaultId,null);c.setDefault(first.id);c.update(first.id,draft({name:'Updated',cwd:{mode:'home',path:null}}));assert.equal(c.defaultId,first.id);const copy=c.duplicate(first.id);assert.equal(copy.name,'Updated (copy)');assert.equal(c.defaultId,first.id);c.delete(first.id);assert.equal(c.defaultId,null);assert.equal(c.selectedId,null);assert.deepEqual(JSON.parse(storage.value).profiles.map(r=>r.id),[copy.id]);c.setDefault(null);
 for(const operation of [()=>c.update('stale',draft()),()=>c.delete('stale'),()=>c.duplicate('stale'),()=>c.setDefault('stale'),()=>c.select('stale')])assert.throws(operation,/unavailable/);
});
test('A02 collection denied reads and corrupt loads expose bounded errors without overwriting',()=>{
 for(const value of ['broken',JSON.stringify(store([row()],id(2)))]){const storage=memory(value),c=new profiles.TerminalProfileCollection(storage);c.load();assert.deepEqual(c.profiles,[]);assert.equal(c.defaultId,null);assert.ok(c.loadError);assert.equal(storage.writes.length,0);}
 const c=new profiles.TerminalProfileCollection({getItem(){throw Error('SECRET');},setItem(){assert.fail('no write');}});c.load();assert.ok(c.loadError);assert.equal(c.loadError.includes('SECRET'),false);
});
test('A02 all failed writes preserve rows defaults selection drafts and retained errors',()=>{
 const storage=memory(profiles.encodeTerminalProfiles(store([row(),row(2)],id(1)))),c=new profiles.TerminalProfileCollection(storage,()=>id(3));c.load();c.select(id(2));storage.fail=true;const rows=c.profiles;const d=draft({name:'Edited',shell:{program:'/bin/fish',login:false}});
 for(const operation of [()=>c.save(d),()=>c.update(id(2),d),()=>c.duplicate(id(2)),()=>c.delete(id(1)),()=>c.setDefault(id(2))]){assert.throws(operation,/Could not save/);assert.equal(c.profiles,rows);assert.equal(c.defaultId,id(1));assert.equal(c.selectedId,id(2));assert.equal(c.writeError,profiles.TERMINAL_PROFILE_WRITE_ERROR);assert.equal(JSON.stringify(d),JSON.stringify(draft({name:'Edited',shell:{program:'/bin/fish',login:false}})));}
 c.select(id(1));assert.ok(c.writeError);storage.fail=false;c.update(id(1),draft({name:'Successful'}));assert.equal(c.writeError,null);assert.equal(c.loadError,null);
});
test('A02 duplicate names IDs limits and codepoint-safe suffixes are enforced',()=>{
 const rows=[row(1,{name:'😀'.repeat(80)}),row(2,{name:'😀'.repeat(73)+' (copy)'})];const c=new profiles.TerminalProfileCollection(memory(profiles.encodeTerminalProfiles(store(rows))),()=>id(3));c.load();assert.equal([...c.duplicate(id(1)).name].length,80);assert.match(c.profiles[2].name,/copy 2/);assert.throws(()=>c.save(draft({name:rows[0].name})),/exists/);assert.throws(()=>c.save(draft({name:'Another'})),/ID/);assert.throws(()=>c.update(id(2),draft({name:rows[0].name})),/exists/);
 const full=new profiles.TerminalProfileCollection(memory(profiles.encodeTerminalProfiles(store(Array.from({length:32},(_,i)=>row(i+1))))),()=>id(33));full.load();assert.throws(()=>full.save(draft()),/limit/);assert.throws(()=>full.duplicate(id(1)),/limit/);
});
test('A02 snapshot selected beats default beats preference and cwd override including blank wins',()=>{
 const s=store([row(1,{shell:{program:'/bin/fish',login:false},cwd:{mode:'home',path:null}}),row(2,{shell:null,cwd:{mode:'explicit',path:'/literal space/中文'}})],id(1)),preference={program:'/bin/bash',login:true};
 assert.deepEqual(profiles.terminalProfileStart(s,undefined,undefined,'/context',preference,false),{cwd:'',command:'',launch:null,shell:{program:'/bin/fish',login:false}});
 assert.deepEqual(profiles.terminalProfileStart(s,id(2),undefined,'/context',preference,false),{cwd:'/literal space/中文',command:'',launch:null});
 for(const path of ['/once',''])assert.equal(profiles.terminalProfileStart(s,id(2),path,'/context',preference,false).cwd,path);
 assert.equal(profiles.terminalProfileStart(store([]),undefined,undefined,'/context',preference,false).cwd,'/context');assert.deepEqual(profiles.terminalProfileStart(store([]),undefined,undefined,'',null,false),{cwd:'',command:'',launch:null});
 assert.throws(()=>profiles.terminalProfileStart(s,'stale',undefined,'',preference,false),/unavailable/);assert.throws(()=>profiles.terminalProfileStart({...s,defaultId:'stale'},undefined,undefined,'',preference,false));
 const foreign=store([row(1,{shell:{program:'C:\\Windows\\cmd.exe',login:null}})],id(1));assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(foreign));assert.throws(()=>profiles.terminalProfileStart(foreign,undefined,undefined,'',null,false),/platform/);assert.equal(profiles.terminalProfileStart(foreign,undefined,undefined,'',null,true).shell.login,null);
});

test('A02 encoded budget rejects maximum escaped rows and draft getters never run',()=>{
 const path='C:\\'+'\\'.repeat(4093),rows=Array.from({length:32},(_,i)=>row(i+1,{shell:{program:path,login:null},cwd:{mode:'explicit',path}}));assert.equal(Buffer.byteLength(path),4096);assert.throws(()=>profiles.encodeTerminalProfiles(store(rows)),/size limit/);
 let called=0;const d=draft();Object.defineProperty(d,'shell',{enumerable:true,get(){called++;return null;}});const c=new profiles.TerminalProfileCollection(memory(),()=>id(1));assert.throws(()=>c.save(d));assert.equal(called,0);
 const array=[row()];array.extra=1;assert.throws(()=>profiles.encodeTerminalProfiles(store(array)));const custom=[row()];Object.setPrototypeOf(custom,{});assert.throws(()=>profiles.encodeTerminalProfiles(store(custom)));
});

test('A02 explicit null profile bypass ignores invalid store but retains preference and context snapshots',()=>{
 const preference={program:'/bin/zsh',login:false},start=profiles.terminalProfileStart({version:3,profiles:[],defaultId:'stale'},null,undefined,'/context',preference,false);assert.deepEqual(start,{cwd:'/context',command:'',launch:null,shell:{program:'/bin/zsh',login:false}});preference.program='/bin/bash';assert.equal(start.shell.program,'/bin/zsh');assert.throws(()=>profiles.terminalProfileStart({version:3,profiles:[],defaultId:'stale'},'stale',undefined,'/context',null,false));
});

test('A02 explicit cwd accepts Windows drive and UNC directory roots without requiring an executable leaf',()=>{
 for(const path of ['C:\\','\\\\server\\share','\\\\server\\share\\directory'])assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(store([row(1,{cwd:{mode:'explicit',path}})])));
});

test('A02 foreign explicit profile directory is stored unchanged and refused at startup on the other platform',()=>{
 for(const [path,windows] of [['C:\\project',false],['\\\\server\\share',false],['/project',true]]){const s=store([row(1,{cwd:{mode:'explicit',path}})],id(1));assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(s));assert.throws(()=>profiles.terminalProfileStart(s,undefined,undefined,'/context',null,windows),/directory.*platform/);assert.equal(profiles.terminalProfileStart(s,undefined,'/once','/context',null,windows).cwd,'/once');assert.equal(profiles.terminalProfileStart(s,null,undefined,'/context',null,windows).cwd,'/context');}
});

 test('A02b v1 load migrates in memory and v2 carries references without reading values',()=>{
 const keys=[],writes=[],legacy=JSON.stringify({version:1,profiles:[Object.fromEntries(Object.entries(row()).filter(([k])=>k!=='envRefs'&&k!=='appearance'))],defaultId:id(1)});const c=new profiles.TerminalProfileCollection({getItem:key=>{keys.push(key);return key==='yam.terminalProfiles.v1'?legacy:null;},setItem:(...args)=>writes.push(args)},()=>id(2));c.load();assert.equal(c.profiles.length,1);assert.deepEqual(c.profiles[0].envRefs,{});assert.equal(c.defaultId,id(1));assert.deepEqual(keys,['yam.terminalProfiles.v3','yam.terminalProfiles.v2','yam.terminalProfiles.v1']);assert.equal(writes.length,0);
 const r={...row(),envRefs:{TARGET:'SOURCE'}},v={version:3,profiles:[r],defaultId:id(1)};assert.deepEqual(profiles.decodeTerminalProfiles(profiles.encodeTerminalProfiles(v)),v);
 });

test('A02b reference names boundaries and hostile records are validated without hooks',()=>{
 const encode=refs=>profiles.encodeTerminalProfiles({version:3,profiles:[{...row(),envRefs:refs}],defaultId:null});
 for(const refs of [{A:'B'},{['_'.repeat(128)]:'S'},Object.fromEntries(Array.from({length:32},(_,n)=>['T'+n,'S']))])assert.doesNotThrow(()=>encode(refs));
 for(const refs of [null,[],{A:2},{'1A':'B'},{A:'a-b'},{Yam_SECRET:'S'},{T:'yAM_S'},{Path:'S',PATH:'S'},{['_'.repeat(129)]:'S'},Object.fromEntries(Array.from({length:33},(_,n)=>['T'+n,'S']))])assert.throws(()=>encode(refs));
 let hooks=0;for(const kind of ['getter','hidden','symbol','prototype','toJSON']){const refs={A:'B'};if(kind==='getter')Object.defineProperty(refs,'A',{enumerable:true,get(){hooks++;return 'B';}});if(kind==='hidden')Object.defineProperty(refs,'hidden',{value:'S'});if(kind==='symbol')refs[Symbol('s')]='S';if(kind==='prototype')Object.setPrototypeOf(refs,{x:1});if(kind==='toJSON')refs.toJSON=()=>{hooks++;return {};};assert.throws(()=>encode(refs));}assert.equal(hooks,0);
 const refs=JSON.parse('{"__proto__":"SOURCE","constructor":"SOURCE","prototype":"SOURCE"}');assert.deepEqual(profiles.decodeTerminalProfiles(encode(refs)).profiles[0].envRefs,refs);
});
test('A02b bad v2 never resurrects v1 and failed persistence preserves legacy and state',()=>{
 const legacy=JSON.stringify({version:1,profiles:[Object.fromEntries(Object.entries(row()).filter(([k])=>k!=='envRefs'&&k!=='appearance'))],defaultId:id(1)}),values=new Map([['yam.terminalProfiles.v1',legacy],['yam.terminalProfiles.v2','broken']]),reads=[],writes=[];let fail=false;const c=new profiles.TerminalProfileCollection({getItem:k=>{reads.push(k);return values.get(k)??null;},setItem:(k,v)=>{writes.push(k);if(fail)throw Error('synthetic');values.set(k,v);}},()=>id(2));c.load();assert.ok(c.loadError);assert.deepEqual(reads,['yam.terminalProfiles.v3','yam.terminalProfiles.v2']);assert.equal(c.profiles.length,0);values.delete('yam.terminalProfiles.v2');c.load();const old=c.profiles;fail=true;assert.throws(()=>c.save({...draft(),envRefs:{A:'B'}}));assert.equal(c.profiles,old);assert.equal(c.defaultId,id(1));assert.equal(values.get('yam.terminalProfiles.v1'),legacy);fail=false;c.setDefault(null);assert.equal(JSON.parse(values.get('yam.terminalProfiles.v3')).version,3);assert.equal(values.get('yam.terminalProfiles.v1'),legacy);
});
test('A02b starts copy nonempty refs and omit empty bypass and unsupported platform targets',()=>{
 const s={version:3,profiles:[{...row(),shell:{program:null,login:true},envRefs:{TARGET:'SOURCE'}}],defaultId:id(1)};const start=profiles.terminalProfileStart(s,undefined,undefined,'/context',null,false);assert.deepEqual(start.envRefs,{TARGET:'SOURCE'});s.profiles[0].envRefs.TARGET='OTHER';assert.equal(start.envRefs.TARGET,'SOURCE');assert.equal('envRefs' in profiles.terminalProfileStart(s,null,undefined,'/context',null,false),false);s.profiles[0].envRefs={};assert.equal('envRefs' in profiles.terminalProfileStart(s,undefined,undefined,'/context',null,false),false);
 for(const [target,windows] of [['SHELL',false],['UserProfile',true],['pathext',true]]){s.profiles[0].envRefs={[target]:'SOURCE'};s.profiles[0].shell={program:null,login:windows?null:true};assert.throws(()=>profiles.terminalProfileStart(s,undefined,undefined,'/context',null,windows),/unavailable.*platform/);assert.doesNotThrow(()=>profiles.encodeTerminalProfiles(s));}
 s.profiles[0].envRefs={shell:'SHELL'};s.profiles[0].shell={program:null,login:true};assert.doesNotThrow(()=>profiles.terminalProfileStart(s,undefined,undefined,'/context',null,false));s.profiles[0].shell=null;assert.throws(()=>profiles.terminalProfileStart(s,undefined,undefined,'/context',null,false),/System default/);
});

test('A02b editable rows reject duplicate targets before maps discard them',()=>{for(const rows of [[{target:'A',source:'S'},{target:'A',source:'T'}],[{target:'Path',source:'S'},{target:'PATH',source:'T'}],[{target:'',source:'S'}]])assert.throws(()=>profiles.profileEnvRefsFromRows(rows));const refs=profiles.profileEnvRefsFromRows([{target:'__proto__',source:'S'},{target:'constructor',source:'T'}]);assert.deepEqual(Object.keys(refs),['__proto__','constructor']);assert.equal(refs.__proto__,'S');});

test('A02b legacy migration never executes inherited serialization hooks',()=>{const raw=JSON.stringify({version:1,profiles:[{id:id(1),name:'Legacy',shell:null,cwd:{mode:'context',path:null}}],defaultId:id(1)});let hooks=0;const original=Object.prototype.toJSON;Object.prototype.toJSON=()=>{hooks++;return null;};try{const c=new profiles.TerminalProfileCollection({getItem:k=>k==='yam.terminalProfiles.v1'?raw:null,setItem:()=>assert.fail('load cannot write')});c.load();assert.equal(hooks,0);assert.equal(c.profiles.length,1);}finally{if(original===undefined)delete Object.prototype.toJSON;else Object.prototype.toJSON=original;}});

test('A02b collection duplicate update and returned refs keep prototype names as own snapshots',()=>{let n=0;const c=new profiles.TerminalProfileCollection({getItem:()=>null,setItem:()=>{}},()=>id(++n));c.load();const refs=JSON.parse('{"__proto__":"SOURCE","constructor":"SOURCE","prototype":"SOURCE"}');const first=c.save({...draft(),envRefs:refs});refs.__proto__='OTHER';assert.equal(c.profiles[0].envRefs.__proto__,'SOURCE');const copy=c.duplicate(first.id);copy.envRefs.constructor='OTHER';assert.equal(c.profiles[1].envRefs.constructor,'SOURCE');c.update(first.id,{...draft({name:'Updated'}),envRefs:{TARGET:'SOURCE'}});assert.equal(c.profiles[0].envRefs.TARGET,'SOURCE');assert.equal(c.profiles[1].envRefs.prototype,'SOURCE');});

 test('A02c1 v3 appearance roundtrip and v2 migration preserve environment references without writing',()=>{
 const appearance={fontFamily:'Profile font',fontSize:20,theme:'solarized'};
 const v3={version:3,profiles:[row(1,{envRefs:{TOKEN:'SOURCE_TOKEN'},appearance})],defaultId:id(1)};
 assert.deepEqual(profiles.decodeTerminalProfiles(JSON.stringify(v3)),v3);
 const reads=[],writes=[];const c=new profiles.TerminalProfileCollection({getItem(key){reads.push(key);return key==='yam.terminalProfiles.v2'?JSON.stringify({version:2,profiles:[Object.fromEntries(Object.entries(row(1,{envRefs:{TOKEN:'SOURCE_TOKEN'}})).filter(([k])=>k!=='appearance'))],defaultId:id(1)}):null;},setItem(...args){writes.push(args);}});c.load();
 assert.equal(c.loadError,null);assert.equal(c.profiles[0].appearance,null);assert.deepEqual(c.profiles[0].envRefs,{TOKEN:'SOURCE_TOKEN'});assert.deepEqual(reads,['yam.terminalProfiles.v3','yam.terminalProfiles.v2']);assert.deepEqual(writes,[]);
 });

test('A02c1 appearance strict boundaries and serialization hooks never execute',()=>{
 const appearance={fontFamily:'F',fontSize:10,theme:'dark'},encode=a=>profiles.encodeTerminalProfiles(store([row(1,{appearance:a})]));
 for(const a of [null,appearance,{fontFamily:'F'.repeat(200),fontSize:24,theme:'light'},{...appearance,theme:'solarized'}])assert.doesNotThrow(()=>encode(a));
 for(const a of [{...appearance,fontFamily:''},{...appearance,fontFamily:'F'.repeat(201)},{...appearance,fontFamily:'bad\n'},{...appearance,fontSize:9},{...appearance,fontSize:25},{...appearance,fontSize:13.5},{...appearance,fontSize:NaN},{...appearance,theme:'unknown'},{...appearance,cursor:true}])assert.throws(()=>encode(a));
 let hooks=0;for(const kind of ['getter','hidden','symbol','prototype','toJSON']){const a={...appearance};if(kind==='getter')Object.defineProperty(a,'fontSize',{enumerable:true,get(){hooks++;return 20;}});if(kind==='hidden')Object.defineProperty(a,'hidden',{value:1});if(kind==='symbol')a[Symbol('x')]=1;if(kind==='prototype')Object.setPrototypeOf(a,{toJSON(){hooks++;}});if(kind==='toJSON')a.toJSON=()=>{hooks++;return null;};assert.throws(()=>encode(a));}assert.equal(hooks,0);
});
test('A02c1 invalid v3 never falls back and failed v3 migration write preserves old records',()=>{
 const legacy=JSON.stringify({version:2,profiles:[{id:id(1),name:'Legacy',shell:null,cwd:{mode:'home',path:null},envRefs:{T:'S'}}],defaultId:id(1)}),values=new Map([['yam.terminalProfiles.v2',legacy],['yam.terminalProfiles.v3','broken']]),reads=[];let fail=true;
 const c=new profiles.TerminalProfileCollection({getItem:k=>{reads.push(k);return values.get(k)??null;},setItem:(k,v)=>{if(fail)throw Error('quota');values.set(k,v);}});c.load();assert.ok(c.loadError);assert.deepEqual(reads,['yam.terminalProfiles.v3']);values.delete('yam.terminalProfiles.v3');c.load();const old=c.profiles;assert.throws(()=>c.setDefault(null));assert.equal(c.profiles,old);assert.equal(c.defaultId,id(1));assert.equal(values.get('yam.terminalProfiles.v2'),legacy);fail=false;c.setDefault(null);assert.equal(JSON.parse(values.get('yam.terminalProfiles.v3')).version,3);assert.equal(values.get('yam.terminalProfiles.v2'),legacy);
});

test('A08b Profile v3 preserves symbolic system appearance and environment references',()=>{const value=store([row(1,{appearance:{fontFamily:'Profile mono',fontSize:18,theme:'system'},envRefs:{TOKEN:'SOURCE_TOKEN'}})],id(1));assert.deepEqual(profiles.decodeTerminalProfiles(profiles.encodeTerminalProfiles(value)),value);});
