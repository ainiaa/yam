// Author: Jeff.Liu. Literal selected-path contract; no filesystem or native operations.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedFilePath,filePreviewReply} from '../src/terminal-file-actions.ts';
test('A04b2 literal absolute path preserves spaces percent and line suffix',()=>{for(const path of ['/a b/文件%20:12','/ leading/trailing '])assert.equal(selectedFilePath(path),path);});
test('A04b2 selected paths reject expansions URIs controls bidi invalid Unicode and byte overflow',()=>{for(const path of ['', 'relative','~/file','file:///tmp/a','/a\n','/a\u0085','/a\u202e','/a\u2028','/a\u2029','/a\ud800','/'+ 'é'.repeat(2048)])assert.throws(()=>selectedFilePath(path));assert.equal(selectedFilePath('/'+'a'.repeat(4095)).length,4096);});
test('A04b2 preview reply requires exact original and bounded canonical text',()=>{assert.deepEqual(filePreviewReply({path:'/a',canonical:'/b'},'/a'),{path:'/a',canonical:'/b'});for(const reply of [null,{path:'/other',canonical:'/b'},{path:'/a',canonical:'relative'},{path:'/a',canonical:'/'+ 'a'.repeat(4096)}])assert.throws(()=>filePreviewReply(reply,'/a'));});
