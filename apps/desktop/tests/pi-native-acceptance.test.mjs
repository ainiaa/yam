// Author: Jeff.Liu. Artifact gate unit fixtures use test receipts/decoding and never invoke a provider or GUI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyAcceptance,relativeArtifact,snapshotBusiness,saveAcceptance,finalizeAcceptance} from '../../../scripts/pi-native-acceptance.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sdkMarkdown={skip:process.env.YAM_PI_SDK_DIR?false:'Set YAM_PI_SDK_DIR to run the real Pi Markdown parser integration'};
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'yam-combo-gate-'));try{
 const png=Buffer.alloc(32);png.writeUInt32BE(512,16);png.writeUInt32BE(512,20);await writeFile(join(root,'cover.png'),png);
 await writeFile(join(root,'article.md'),'# Pi Codex API\n'+ 'Pi负责协调和自动路由。普通API由当前Pi执行。ChatGPT订阅通过官方Codex原生执行。失败不自动切换计费通道或付费API。'.repeat(8)+'\n![封面](cover.png)');
 await writeFile(join(root,'normalize-title.mjs'),"export function normalizeTitle(v){if(typeof v!=='string')throw new TypeError();const s=v.trim().replace(/\\s+/g,' ');if(!s)throw new RangeError();return s;}");
 await writeFile(join(root,'normalize-title.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {normalizeTitle} from './normalize-title.mjs';test('trim',()=>assert.equal(normalizeTitle('  a  b '),'a b'));");
 const baseline=await readFile(join(root,'normalize-title.test.mjs'),'utf8');await writeFile(join(root,'baseline-normalize-title.test.mjs.txt'),baseline);await writeFile(join(root,'normalize-title.test.mjs'),baseline+"test('Chinese whitespace continuation',()=>assert.equal(normalizeTitle(' 中文 \t 标题 '),'中文 标题'));\n");
 const paths=['article.md','cover.png','normalize-title.mjs','normalize-title.test.mjs','baseline-normalize-title.test.mjs.txt'];
 const receipt={version:1,billing:'subscription',artifactRoot:'.',combo:{status:'completed',sessionId:'real-id'},followup:{status:'completed',sessionId:'real-id',coverHash:hash(png),testName:'Chinese whitespace continuation',testsBeforeHash:hash(Buffer.from(baseline)),testsAfterHash:hash(await readFile(join(root,'normalize-title.test.mjs')))},cancel:{before:{},after:{},status:'failed',aborted:true,filesUnchanged:true,replayBlocked:true},cover:'cover.png',coverHash:hash(png),imageToolObserved:true,hashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(join(root,p)))])))};
 receipt.imageEvidence={sessionId:receipt.combo.sessionId,tool:'image_gen__imagegen',callId:'call_fixture',generatedFile:join(root,'generated_images',receipt.combo.sessionId,'cover.png'),coverHash:receipt.coverHash};
 receipt.articleReview={articleHash:receipt.hashes['article.md'],sessionId:'native-review-fixture',criteria:Object.fromEntries(Object.entries({coordination:'Pi负责协调和自动路由。',api:'普通API由当前Pi执行。',subscription:'ChatGPT订阅通过官方Codex原生执行。',billing:'失败不自动切换计费通道或付费API。'}).map(([key,quote])=>[key,{ok:true,quote}]))};
 const observed=structuredClone(receipt.imageEvidence),readNative=async()=>({proof:observed});
 const tokens=[{type:'heading',depth:1,text:'Pi Codex API'},{type:'image',href:'cover.png'}];
 const markdown={lexer:()=>tokens,walkTokens:(items,visit)=>items.forEach(visit)};
 const path=join(root,'receipt.json');await writeFile(path,JSON.stringify(receipt));await run({root,path,receipt,save:()=>writeFile(path,JSON.stringify(receipt)),decode:async b=>b,readNative,markdown,tokens});
 }finally{await rm(root,{recursive:true,force:true});}}
test('combo artifact gate independently runs code tests and checks receipt and files',()=>fixture(async f=>assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown})).passed,true)));
test('combo gate rejects absent native image evidence, replaced sessions and replay',async()=>{
 for(const change of [r=>r.imageToolObserved=false,r=>r.followup.sessionId='different',r=>r.cancel.replayBlocked=false])await fixture(async f=>{change(f.receipt);await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}));});
});
test('combo gate rejects invalid normalizer behavior and tampered artifacts',async()=>{
 await fixture(async f=>{const source='export const normalizeTitle=()=>"wrong";';await writeFile(join(f.root,'normalize-title.mjs'),source);f.receipt.hashes['normalize-title.mjs']=hash(Buffer.from(source));await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}));});
 await fixture(async f=>{await writeFile(join(f.root,'cover.png'),'fake');await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}));});
});
test('artifact export canonicalizes root aliases and rejects files outside the fixture',()=>fixture(async f=>{
 const alias=join(f.root,'alias');await symlink(f.root,alias);assert.equal(await relativeArtifact(alias,join(f.root,'cover.png')),'cover.png');
 const nested=join(f.root,'nested');await mkdir(nested);await assert.rejects(relativeArtifact(nested,join(f.root,'cover.png')),/outside/);
}));

test('article gate requires a real local image link to the verified cover',async()=>{
 for(const link of ['../outside/cover.png','https://example.test/cover.png','other/cover.png'])await fixture(async f=>{
  f.tokens[1].href=link;
  const text=(await readFile(join(f.root,'article.md'),'utf8')).replace('](cover.png)',`](${link})`);
  await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/cover|reference|outside|ENOENT/i);
 });
});

test('article meaning evidence is required and bound to the exact reviewed article',async()=>{
 await fixture(async f=>{delete f.receipt.articleReview;await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/article|review/i);});
 await fixture(async f=>{const text='# Pi Codex API\n'+ '不解释任务和计费关系。'.repeat(50)+'\n![封面](cover.png)';await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/article|review/i);});
});

test('acceptance requires an article title, a changed continuation test and unchanged full cancellation inventory',async()=>{
 await fixture(async f=>{f.tokens.shift();const article=(await readFile(join(f.root,'article.md'),'utf8')).replace(/^#.*\n/,'');await writeFile(join(f.root,'article.md'),article);f.receipt.hashes['article.md']=hash(Buffer.from(article));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/title/i);});
});
test('continuation requires a changed test file',async()=>{
 await fixture(async f=>{f.receipt.followup.testsBeforeHash=f.receipt.hashes['normalize-title.test.mjs'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/test|baseline/i);});
});
test('cancellation requires an unchanged complete business inventory',async()=>{
 await fixture(async f=>{f.receipt.cancel.before={};f.receipt.cancel.after={'unexpected.txt':{type:'file',hash:'changed'}};await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/inventory|equal|unexpected/i);});
});

test('business snapshot detects new files, empty directories and changed symlinks while excluding native session caches',()=>fixture(async f=>{
 await mkdir(join(f.root,'pi-sessions'));const cache=join(f.root,'pi-sessions','cache.jsonl'),caches=[cache];await writeFile(cache,'cache');const original=await snapshotBusiness(f.root,caches);await writeFile(cache,'new cache entry');assert.deepEqual(await snapshotBusiness(f.root,caches),original);
 await writeFile(join(f.root,'unexpected.txt'),'changed');assert.notDeepEqual(await snapshotBusiness(f.root,caches),original);await rm(join(f.root,'unexpected.txt'));assert.deepEqual(await snapshotBusiness(f.root,caches),original);
 await mkdir(join(f.root,'empty'));assert.notDeepEqual(await snapshotBusiness(f.root,caches),original);await rm(join(f.root,'empty'),{recursive:true});
 await symlink('cover.png',join(f.root,'link'));const linked=await snapshotBusiness(f.root,caches);await rm(join(f.root,'link'));await symlink('article.md',join(f.root,'link'));assert.notDeepEqual(await snapshotBusiness(f.root,caches),linked);
}));

test('skipped and TODO continuation cases do not count as successful execution',async()=>{
 for(const flag of ['skip','todo'])await fixture(async f=>{
  const path=join(f.root,'normalize-title.test.mjs'),source=(await readFile(path,'utf8')).replace("test('Chinese whitespace continuation',","test('Chinese whitespace continuation', {"+flag+":true},");await writeFile(path,source);
  f.receipt.hashes['normalize-title.test.mjs']=hash(Buffer.from(source));f.receipt.followup.testsAfterHash=f.receipt.hashes['normalize-title.test.mjs'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/continuation|execute|pass/i);
 });
});

test('a valid template-literal continuation test name is recognized from actual runner events',()=>fixture(async f=>{
 const path=join(f.root,'normalize-title.test.mjs'),source=(await readFile(path,'utf8')).replace("test('Chinese whitespace continuation',",'test(`Chinese whitespace continuation`,');await writeFile(path,source);
 f.receipt.hashes['normalize-title.test.mjs']=hash(Buffer.from(source));f.receipt.followup.testsAfterHash=f.receipt.hashes['normalize-title.test.mjs'];await f.save();assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown})).passed,true);
}));

test('an unrelated newly passing Chinese test cannot replace the requested whitespace case',()=>fixture(async f=>{
 const path=join(f.root,'normalize-title.test.mjs'),source=(await readFile(path,'utf8')).replaceAll('Chinese whitespace continuation','Chinese punctuation');await writeFile(path,source);
 f.receipt.hashes['normalize-title.test.mjs']=hash(Buffer.from(source));f.receipt.followup.testsAfterHash=f.receipt.hashes['normalize-title.test.mjs'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/continuation|whitespace|requested/i);
}));

test('cancellation inventories cannot hide business files in Pi configuration or session directories',()=>fixture(async f=>{
 const before=await snapshotBusiness(f.root);await mkdir(join(f.root,'pi-agent'));await writeFile(join(f.root,'pi-agent','unexpected.txt'),'business');assert.notDeepEqual(await snapshotBusiness(f.root),before);
 await rm(join(f.root,'pi-agent'),{recursive:true});await mkdir(join(f.root,'pi-sessions'));await writeFile(join(f.root,'pi-sessions','unexpected.txt'),'business');assert.notDeepEqual(await snapshotBusiness(f.root),before);
}));

test('a fenced heading is not an article title and a real Setext H1 is accepted',sdkMarkdown,async()=>{
 await fixture(async f=>{const text=(await readFile(join(f.root,'article.md'),'utf8')).replace('# Pi Codex API','```md\n# Pi Codex API\n```');await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative}),/title/i);});
 await fixture(async f=>{const text=(await readFile(join(f.root,'article.md'),'utf8')).replace('# Pi Codex API','Pi Codex API\n===');await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative})).passed,true);});
});

test('cover references follow Markdown structure including definitions and excluding code fences',sdkMarkdown,async()=>{
 await fixture(async f=>{const text=(await readFile(join(f.root,'article.md'),'utf8')).replace('![封面](cover.png)','```md\n![封面](cover.png)\n```');await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative}),/cover|reference/i);});
 await fixture(async f=>{const text=(await readFile(join(f.root,'article.md'),'utf8')).replace('![封面](cover.png)','![封面][generated]\n\n[generated]: <cover.png> "Native cover"');await writeFile(join(f.root,'article.md'),text);f.receipt.hashes['article.md']=hash(Buffer.from(text));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative})).passed,true);});
});

test('an article review failure retains completed native evidence for review-only recovery',()=>fixture(async f=>{
 const report={...f.receipt,articleReview:undefined};await assert.rejects(saveAcceptance(f.path,report,async()=>{throw Error('temporary article reviewer outage');}),/reviewer outage/);
 const saved=JSON.parse(await readFile(f.path,'utf8'));assert.equal(saved.combo.status,'completed');assert.equal(saved.combo.sessionId,f.receipt.combo.sessionId);assert.equal(saved.coverHash,f.receipt.coverHash);assert.equal(saved.articleReview,undefined);
}));

test('an unrelated remote image is ignored without weakening the required local cover',async()=>{
 for(const keep of [true,false])await fixture(async f=>{if(!keep)f.tokens.pop();f.tokens.push({type:'image',href:'https://example.test/reference.png'});let article=await readFile(join(f.root,'article.md'),'utf8');if(!keep)article=article.replace('![封面](cover.png)','');article+='\n![Reference](https://example.test/reference.png)';await writeFile(join(f.root,'article.md'),article);f.receipt.hashes['article.md']=hash(Buffer.from(article));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();if(keep)assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown})).passed,true);else await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/reference|local/i);});
});

test('additional cancellation evidence cannot replace a failed original or hide its own changes',async()=>{
 await fixture(async f=>{f.receipt.cancel.before={original:{type:'file',hash:'before'}};f.receipt.cancel.after={original:{type:'file',hash:'after'}};f.receipt.cancel.additionalInventory={before:{},after:{}};await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/Cancellation changed business inventory/);assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')).cancel,f.receipt.cancel);});
 await fixture(async f=>{f.receipt.cancel.additionalInventory={before:{},after:{unexpected:{type:'file',hash:'new'}}};await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/Additional cancellation changed/);});
});

test('baseline and current generated tests must execute rather than skip, TODO or stay empty',async()=>{
 for(const marker of ['skip','todo','empty'])await fixture(async f=>{const baseline=marker==='empty'?'':"import {test} from 'node:test';test."+marker+"('baseline',()=>{});";await writeFile(join(f.root,'baseline-normalize-title.test.mjs.txt'),baseline);f.receipt.hashes['baseline-normalize-title.test.mjs.txt']=hash(Buffer.from(baseline));f.receipt.followup.testsBeforeHash=f.receipt.hashes['baseline-normalize-title.test.mjs.txt'];await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/baseline|execute|pass/i);});
});

test('a real baseline test named with its file path is not mistaken for an empty file',()=>fixture(async f=>{
 const path=join(f.root,'baseline-normalize-title.test.mjs.txt'),baseline=(await readFile(path,'utf8')).replace("test('trim',",'test(import.meta.filename,');await writeFile(path,baseline);f.receipt.hashes['baseline-normalize-title.test.mjs.txt']=hash(Buffer.from(baseline));f.receipt.followup.testsBeforeHash=f.receipt.hashes['baseline-normalize-title.test.mjs.txt'];await f.save();assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown})).passed,true);
}));

test('native image-call and cache hash evidence are required and bound to the combo',async()=>{
 for(const change of [r=>delete r.imageEvidence,r=>r.imageEvidence.sessionId='other',r=>r.imageEvidence.tool='placeholder',r=>r.imageEvidence.callId='',r=>r.imageEvidence.coverHash='wrong',r=>r.imageEvidence.generatedFile='/unbound/cover.png'])await fixture(async f=>{change(f.receipt);await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/native|image|cache|evidence|tool|session/i);});
});

test('acceptance rechecks native call and cache evidence instead of trusting the receipt',async()=>{
 await fixture(async f=>{f.receipt.imageEvidence.callId='call_nonexistent';await f.save();await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/native|evidence/i);});
 await fixture(async f=>{await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,markdown:f.markdown,readNative:async()=>{throw Error('Native image cache missing');}}),/cache missing/i);});
});
test('session-log exclusions reject leaf symlinks and cannot hide business files through directory aliases',()=>fixture(async f=>{
 await mkdir(join(f.root,'pi-sessions'));const log=join(f.root,'pi-sessions','session.jsonl');await symlink(join(f.root,'article.md'),log);await assert.rejects(snapshotBusiness(f.root,[log]),/regular|symlink/i);
 await rm(log);const alias=join(f.root,'session-alias');await symlink(f.root,alias);await assert.rejects(snapshotBusiness(f.root,[join(alias,'article.md')]),/regular|symlink/i);
}));

// This child has no Pi SDK; injected article parsing must keep the unit boundary self-contained.
test('injected Markdown parser verifies a valid receipt without a globally installed Pi SDK',()=>fixture(async f=>{
 const script=`import {readFile} from 'node:fs/promises';
 import {verifyAcceptance} from ${JSON.stringify(new URL('../../../scripts/pi-native-acceptance.mjs',import.meta.url).href)};
 const receipt=JSON.parse(await readFile(process.argv[1],'utf8'));
 const tokens=[{type:'heading',depth:1,text:'Pi Codex API'},{type:'image',href:'cover.png'}];
 const markdown={lexer:()=>tokens,walkTokens:(items,visit)=>items.forEach(visit)};
 console.log(JSON.stringify(await verifyAcceptance(process.argv[1],{decode:async bytes=>bytes,readNative:async()=>({proof:receipt.imageEvidence}),markdown})));`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,f.path],{env:{...process.env,YAM_PI_SDK_DIR:join(f.root,'sdk-not-installed')},timeout:15000});
 assert.equal(JSON.parse(result.stdout).passed,true);
}));

test('article validation requires a parsed nonempty H1 and a parsed local cover image',async()=>{
 for(const heading of [{type:'code',text:'# Pi Codex API'},{type:'heading',depth:2,text:'Pi Codex API'},{type:'heading',depth:1,text:' '}])await fixture(async f=>{f.tokens[0]=heading;await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/title/i);});
 await fixture(async f=>{f.tokens[1]={type:'code',text:'![封面](cover.png)'};await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/cover|reference/i);});
});

test('cover names beginning with two dots stay valid inside the artifact root',()=>fixture(async f=>{
 const name='..cover.png';await rename(join(f.root,'cover.png'),join(f.root,name));
 f.receipt.cover=name;f.receipt.hashes[name]=f.receipt.hashes['cover.png'];delete f.receipt.hashes['cover.png'];f.tokens[1].href=name;
 const article=(await readFile(join(f.root,'article.md'),'utf8')).replace('](cover.png)',`](${name})`);await writeFile(join(f.root,'article.md'),article);
 f.receipt.hashes['article.md']=hash(Buffer.from(article));f.receipt.articleReview.articleHash=f.receipt.hashes['article.md'];await f.save();
 assert.equal((await verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown})).passed,true);
}));

test('cover symlink escape is rejected before image decoding',()=>fixture(async f=>{
 const outside=await mkdtemp(join(tmpdir(),'yam-outside-cover-'));try{
  await writeFile(join(outside,'cover.png'),await readFile(join(f.root,'cover.png')));await rm(join(f.root,'cover.png'));await symlink(join(outside,'cover.png'),join(f.root,'cover.png'));
  let decoded=false;await assert.rejects(verifyAcceptance(f.path,{decode:async bytes=>{decoded=true;return bytes;},readNative:f.readNative,markdown:f.markdown}),/outside/i);assert.equal(decoded,false);
 }finally{await rm(outside,{recursive:true,force:true});}
}));

test('business snapshots record __proto__ filenames and empty directories without losing cancellation changes',()=>fixture(async f=>{
 const path=join(f.root,'__proto__');await writeFile(path,'before');const before=await snapshotBusiness(f.root);assert.deepEqual(await snapshotBusiness(f.root),before);await writeFile(path,'after');const after=await snapshotBusiness(f.root);
 assert.notDeepEqual(after,before,'changing a __proto__ file must invalidate the cancellation snapshot');assert.ok(Object.hasOwn(before,'__proto__'));assert.equal(JSON.parse(JSON.stringify(before)).__proto__.type,'file');
 await rm(path);const empty=await snapshotBusiness(f.root);await mkdir(path);const directory=await snapshotBusiness(f.root);
 assert.notDeepEqual(directory,empty,'creating an empty __proto__ directory must be recorded');assert.equal(JSON.parse(JSON.stringify(directory)).__proto__.type,'directory');
}));

for(const restore of [false,true])test(`tampered module is rejected before execution even when it restores its file: ${restore}`,()=>fixture(async f=>{
 const path=join(f.root,'normalize-title.mjs'),marker=join(f.root,'tampered-code-ran'),original=await readFile(path,'utf8');
 const prefix=`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');`+(restore?`writeFileSync(import.meta.filename,${JSON.stringify(original)});`:'');
 await writeFile(path,prefix+original);
 await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/normalize-title\.mjs|integrity|hash/i);
 await assert.rejects(readFile(marker),{code:'ENOENT'});
}));

test('post-execution integrity still rejects a hash-approved module that changes another artifact',()=>fixture(async f=>{
 const path=join(f.root,'normalize-title.mjs'),original=await readFile(path,'utf8');
 const source=`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(f.root,'article.md'))},'changed during verification');`+original;
 await writeFile(path,source);f.receipt.hashes['normalize-title.mjs']=hash(Buffer.from(source));await f.save();
 await assert.rejects(verifyAcceptance(f.path,{decode:f.decode,readNative:f.readNative,markdown:f.markdown}),/article\.md/);
}));

for(const missingHash of [false,true])test(`legacy finalization validates module integrity before backfilling test names: missing hash ${missingHash}`,()=>fixture(async f=>{
 const legacy=await mkdtemp(join(tmpdir(),'yam-legacy-cover-'));try{
  await writeFile(join(legacy,'cover.png'),await readFile(join(f.root,'cover.png')));f.receipt.fixtureRoot=legacy;delete f.receipt.followup.testName;
  const path=join(f.root,'normalize-title.mjs'),marker=join(f.root,'legacy-code-ran'),original=await readFile(path,'utf8');
  await writeFile(path,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');`+original);if(missingHash)delete f.receipt.hashes['normalize-title.mjs'];await f.save();
  await assert.rejects(finalizeAcceptance(f.path));await assert.rejects(readFile(marker),{code:'ENOENT'});
 }finally{await rm(legacy,{recursive:true,force:true});}
}));

test('legacy finalization with valid executable hashes backfills the requested test name',()=>fixture(async f=>{
 const legacy=await mkdtemp(join(tmpdir(),'yam-legacy-valid-'));try{
  await writeFile(join(legacy,'cover.png'),await readFile(join(f.root,'cover.png')));f.receipt.fixtureRoot=legacy;delete f.receipt.followup.testName;await f.save();
  await assert.rejects(finalizeAcceptance(f.path)); // Synthetic native image evidence is intentionally not valid for the default verifier.
  const saved=JSON.parse(await readFile(f.path,'utf8'));assert.equal(saved.followup.testName,'Chinese whitespace continuation');assert.ok(saved.followup.nameProvenance);
 }finally{await rm(legacy,{recursive:true,force:true});}
}));

for(const file of ['baseline-normalize-title.test.mjs.txt','normalize-title.test.mjs'])for(const missingHash of [false,true])test(`legacy finalization validates test source before execution: ${file}, missing hash ${missingHash}`,()=>fixture(async f=>{
 const legacy=await mkdtemp(join(tmpdir(),'yam-legacy-tests-'));try{
  await writeFile(join(legacy,'cover.png'),await readFile(join(f.root,'cover.png')));f.receipt.fixtureRoot=legacy;delete f.receipt.followup.testName;
  const path=join(f.root,file),marker=join(f.root,'legacy-test-code-ran'),source=await readFile(path,'utf8');
  await writeFile(path,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');`+source);if(missingHash)delete f.receipt.followup[file.startsWith('baseline-')?'testsBeforeHash':'testsAfterHash'];await f.save();
  await assert.rejects(finalizeAcceptance(f.path));await assert.rejects(readFile(marker),{code:'ENOENT'});
 }finally{await rm(legacy,{recursive:true,force:true});}
}));
