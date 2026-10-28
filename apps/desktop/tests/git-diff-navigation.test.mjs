// Author: Jeff.Liu. Assert unified diff locations independently of file names.
import test from 'node:test';import assert from 'node:assert/strict';
import {parseUnifiedDiff,findDiffLine} from '../src/git-diff-navigation.ts';
const parse=text=>{const value=parseUnifiedDiff(text);assert.ok(value,'valid patch required');return value;};
test('R2A unified diff assigns old and new line numbers through multiple change blocks',()=>{
 const doc=parse('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -2,3 +2,4 @@ code\n same\n-old\n+new\n+extra\n tail\n@@ -12 +13 @@\n-before\n+after\n');
 assert.equal(doc.hunks.length,2);assert.deepEqual(doc.hunks[0],{row:3,oldStart:2,newStart:2,oldCount:3,newCount:4});
 assert.deepEqual(doc.rows.filter(row=>row.hunk===0).map(row=>[row.kind,row.oldLine,row.newLine]),[['hunk',null,null],['context',2,2],['remove',3,null],['add',null,3],['add',null,4],['context',4,5]]);
 assert.equal(findDiffLine(doc,'old',3),5);assert.equal(findDiffLine(doc,'new',4),7);assert.equal(findDiffLine(doc,'new',12),-1);assert.equal(findDiffLine(doc,'new',NaN),-1);assert.equal(findDiffLine(doc,'old',0),-1);
});
test('R2A zero-count additions and deletions never fabricate the absent side',()=>{
 const added=parse('--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+one\n+two\n');assert.deepEqual(added.rows.slice(-2).map(row=>[row.oldLine,row.newLine]),[[null,1],[null,2]]);assert.equal(findDiffLine(added,'old',1),-1);
 const deleted=parse('--- a/old\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n');assert.deepEqual(deleted.rows.slice(-2).map(row=>[row.oldLine,row.newLine]),[[1,null],[2,null]]);assert.equal(findDiffLine(deleted,'new',1),-1);
});
test('R2A rename metadata, quoted names and no-newline markers remain literal',()=>{
 const doc=parse('diff --git "a/a b\\t.txt" "b/new name.txt"\nsimilarity index 70%\nrename from a b\\t.txt\nrename to new name.txt\n--- "a/a b\\t.txt"\n+++ "b/new name.txt"\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
 assert.equal(doc.hunks.length,1);assert.equal(doc.rows[0].text,'diff --git "a/a b\\t.txt" "b/new name.txt"');assert.deepEqual(doc.rows.slice(-4).map(row=>row.kind),['remove','marker','add','marker']);assert.equal(doc.rows.at(-1).newLine,null);
 const binary=parse('Binary files a/image.png and b/image.png differ\n');assert.equal(binary.hunks.length,0);assert.equal(findDiffLine(binary,'new',1),-1);
});
test('R2A malformed or overflowing ranges fall back without inventing line locations',()=>{
 for(const text of ['@@ -1,2 +1 @@\n-one\n+two\n','@@ -1 +1 @@\n-one\n+two\n+extra\n','@@ -0 +1 @@\n-old\n+new\n','@@ -9007199254740991,2 +1,2 @@\n a\n b\n','@@ -1 +1 @@\n?bad\n','@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n','x'.repeat(262145)])assert.equal(parseUnifiedDiff(text),null,text.slice(0,40));
 const empty=parse('');assert.deepEqual(empty,{rows:[],hunks:[]});
 assert.equal(parseUnifiedDiff('metadata\n'.repeat(20001)),null);
});

test('R2A overlapping or out-of-order hunks fall back on either side without breaking zero-length insertions',()=>{
 for(const second of ['@@ -1 +2 @@','@@ -2 +1 @@','@@ -0,0 +2 @@']) {
  const text='@@ -1 +1 @@\n-old\n+new\n'+second+'\n'+(second.includes('-0,0')?'': '-before\n')+'+after\n';assert.equal(parseUnifiedDiff(text),null,second);
 }
 const adjacent=parse('@@ -1 +1 @@\n-old\n+new\n@@ -1,0 +2 @@\n+inserted\n');assert.equal(adjacent.hunks.length,2);
 assert.equal(parseUnifiedDiff('diff --git a/a b/a\n@@ -10 +10 @@\n-a\n+b\ndiff --git a/b b/b\n@@ -1 +1 @@\n-c\n+d\n'),null,'multiple files cannot share one selected-file line jump');
 assert.equal(parseUnifiedDiff('diff --git a/a b/a\nold mode 100644\nnew mode 100755\ndiff --git a/b b/b\n@@ -1 +1 @@\n-a\n+b\n'),null,'metadata-only first file must not hide a second file');
});

test('diff editor targets stay inside the selected local project without guessing removed-side lines',async()=>{
 const {relativeProjectFile}=await import('../src/project-files.ts');
 assert.equal(relativeProjectFile('/repo','/repo/src/a.ts'),'src/a.ts');assert.equal(relativeProjectFile('/repo/','/repo/a.ts'),'a.ts');
 for(const name of ['/repository/a.ts','/repo/../outside','/repo/.git/config','/repo/bad\nname'])assert.equal(relativeProjectFile('/repo',name),null);
});
