import './fixtures/i18n-test-init.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import * as find from '../src/terminal-find.ts';
import {scanFindText} from '../src/terminal-find-worker.ts';
const cell=(chars,width=1)=>({getChars:()=>chars,getWidth:()=>width});
function terminal(lines,cols=8){return {cols,rows:3,buffer:{active:{length:lines.length,baseY:0,cursorY:0,viewportY:0,type:'normal',getLine:i=>lines[i]}},getSelectionPosition:()=>undefined,hasSelection:()=>false};}
const line=(cells,wrapped=false)=>({isWrapped:wrapped,length:cells.length,getCell:i=>cells[i]});
test('A06 cell snapshot joins soft wraps and maps CJK emoji combining to whole cells',()=>{
 const term=terminal([line([cell('A'),cell('中',2),cell('',0),cell('😀',2),cell('',0),cell('é'),cell('x'),cell('y')]),line([cell('Z'),cell(' '),cell(' ')],true),line([cell('end')])]);
 const snap=find.snapshotTerminal(term);assert.equal(snap.text,'A中😀éxyZ\nend');assert.deepEqual(find.findCellRange(snap,1,2,8),{col:1,row:0,size:2});assert.deepEqual(find.findCellRange(snap,2,4,8),{col:3,row:0,size:2});assert.deepEqual(find.findCellRange(snap,4,6,8),{col:5,row:0,size:1});assert.deepEqual(find.findCellRange(snap,7,9,8),{col:7,row:0,size:2});
});
test('A06 regex scans arbitrary Unicode regex, zero-width safely excluded, case and limits honest',()=>{
 assert.deepEqual(scanFindText('Ab ab 中😀 é','(?<=A)b|中.|e\\p{M}',true,true),{matches:[[1,2],[6,9],[10,12]],overflow:false});
 assert.equal(scanFindText('a'.repeat(201),'a',false,true).matches.length,200);assert.equal(scanFindText('a'.repeat(200),'a',false,true).overflow,false);assert.equal(scanFindText('a'.repeat(201),'a',false,true).overflow,true);
 assert.deepEqual(scanFindText('abc','^|$|(?=.)',true,false),{matches:[],overflow:false});assert.deepEqual(scanFindText('Ab ab','ab',false,false).matches,[[0,2],[3,5]]);assert.deepEqual(scanFindText('Ab ab','ab',false,true).matches,[[3,5]]);assert.deepEqual(scanFindText('abc','',true,false).matches,[]);assert.throws(()=>scanFindText('abc','[',true,false),/Invalid regular expression/);
});
test('A06 find shortcut platform IME repeat alternate modifiers',()=>{
 const event={key:'f',metaKey:true,ctrlKey:false,shiftKey:false,altKey:false,isComposing:false,repeat:false,keyCode:70};assert.equal(find.terminalFindShortcut(event,true),true);assert.equal(find.terminalFindShortcut({...event,metaKey:false,ctrlKey:true},false),true);
 for(const change of [{metaKey:false},{ctrlKey:true},{shiftKey:true},{altKey:true},{isComposing:true},{repeat:true},{keyCode:229},{key:'g'}])assert.equal(find.terminalFindShortcut({...event,...change},true),false);
});
function workerFactory(){const worker=new Worker(`const {parentPort}=require('node:worker_threads');import(${JSON.stringify(new URL('../src/terminal-find-worker.ts',import.meta.url).href)}).then(({scanFindText})=>{parentPort.on('message',r=>{try{parentPort.postMessage({id:r.id,...scanFindText(r.text,r.query,r.regex,r.caseSensitive)});}catch(e){parentPort.postMessage({id:r.id,error:String(e)});}});parentPort.postMessage('ready');});`,{eval:true});const port={onmessage:null,onerror:null,postMessage:v=>worker.postMessage(v),terminate:()=>worker.terminate()};port.ready=new Promise((resolve,reject)=>{worker.on('message',data=>data==='ready'?resolve():port.onmessage?.({data}));worker.on('error',error=>{reject(error);port.onerror?.(error);});});return port;}
test('A06 actual worker deadline kills catastrophic regex and replacement literal continues',{timeout:10000},async()=>{
 assert.equal(typeof find.FindWorker,'function','Worker runner exists');
 // Measure execution cancellation and replacement after OS thread/module cold start.
 const ports=[workerFactory(),workerFactory()],workers=[...ports];
 const runner=new find.FindWorker(()=>{const port=ports.shift();assert.ok(port);return port;},100);
 try{
  await Promise.all(workers.map(port=>port.ready));
  const start=Date.now();await assert.rejects(runner.run('a'.repeat(100000)+'!','(a+)+$',true,true),/timed out/);assert.ok(Date.now()-start<1500);
  const result=await runner.run('ok ok','ok',false,true);assert.deepEqual(result.matches,[[0,2],[3,5]]);
  runner.dispose();await assert.rejects(runner.run('a','a',false,true),/disposed/);
 }finally{runner.dispose();await Promise.all(workers.map(port=>port.terminate()));}
});

function controller(){
 const events=[],term=terminal([line([...('hello hello')].map(c=>cell(c)))],20);let selection;Object.assign(term,{getSelectionPosition:()=>selection,hasSelection:()=>!!selection,clearSelection(){selection=undefined;events.push('clear');},select(col,row,size){selection={start:{x:col,y:row},end:{x:col+size,y:row}};events.push(['select',col,row,size]);},scrollToLine:n=>events.push(['scroll',n]),registerMarker:()=>({dispose(){}}),registerDecoration:()=>({dispose(){}})});
 const runner={run:async(text,query,regex,sensitive)=>scanFindText(text,query,regex,sensitive),cancel(){},dispose(){events.push('worker-dispose');}};
 const state=[],c=new find.TerminalFindController(term,runner,()=>state.push({...c.state}));return {c,term,events,state,setSelection:v=>{selection=v;}};
}
test('A06 per-view queries navigate wrap while background refresh never selects scrolls or focuses',async()=>{
 const a=controller(),b=controller();a.c.open();await a.c.setQuery('hello');assert.equal(a.c.state.visible,true);assert.equal(a.c.state.count,2);assert.equal(b.c.state.query,'');assert.ok(a.events.some(x=>Array.isArray(x)&&x[0]==='select'));a.events.length=0;
 await a.c.refresh();assert.ok(!a.events.some(x=>Array.isArray(x)&&['select','scroll','focus'].includes(x[0])));await a.c.setOptions({regex:true});await a.c.navigate(-1);assert.equal(a.c.state.index,1);await a.c.navigate(1);assert.equal(a.c.state.index,0);a.c.dispose();assert.ok(a.events.includes('worker-dispose'));
});
test('A06 manual selection even same coordinates becomes user owned and prevents projection',async()=>{
 const a=controller();a.c.open();await a.c.setQuery('hello');assert.equal(a.c.blocksProjection(),false);a.c.manualSelection();assert.equal(a.c.blocksProjection(),true);const before=a.term.getSelectionPosition();a.c.close();assert.deepEqual(a.term.getSelectionPosition(),before);await a.c.refresh();assert.deepEqual(a.term.getSelectionPosition(),before);
});
test('A06 before frame clears owned selection and stale async results cannot mutate disposed view',async()=>{
 const a=controller();a.c.open();await a.c.setQuery('hello');a.c.beforeFrame();assert.equal(a.term.hasSelection(),false);assert.equal(a.c.state.query,'hello');await a.c.afterFrame(()=>true);assert.equal(a.c.state.count,2);assert.equal(a.term.hasSelection(),false);
 let resolve;const runner={run:()=>new Promise(r=>resolve=r),cancel(){},dispose(){}};const c=new find.TerminalFindController(a.term,runner,()=>{});c.open();const pending=c.setQuery('x');await Promise.resolve();c.dispose();resolve({matches:[[0,1]],overflow:false});await pending;assert.equal(c.state.count,0);
});

test('A06 background refresh retains regex navigation anchor and previous from no anchor wraps last',async()=>{
 const a=controller();a.c.open();await a.c.setOptions({regex:true});await a.c.setQuery('hello');await a.c.navigate(1);assert.equal(a.c.state.index,1);await a.c.refresh();assert.equal(a.c.state.index,1);await a.c.navigate(1);assert.equal(a.c.state.index,0);
 const b=controller();b.c.open();b.c.state.query='hello';b.c.state.regex=true;await b.c.refresh();assert.equal(b.c.state.index,-1);await b.c.navigate(-1);assert.equal(b.c.state.index,1);
});
test('A06 literal navigation index follows authoritative selection and blank newline-only matches are excluded',async()=>{
 const a=controller();a.c.open();await a.c.setQuery('hello');await a.c.navigate(1);assert.equal(a.c.state.index,1,'Navigation follows the next authoritative retained span');
 assert.deepEqual(scanFindText('\n\n','\\n',true,true).matches,[]);
 const snap=find.snapshotTerminal(terminal([line([cell('x'),cell(' '),cell(' ')]),line([cell(' '),cell(' ')])]));assert.equal(snap.text,'x\n');assert.equal(find.findCellRange(snap,1,2,8),null);
});
test('A06 unavailable markers or alternate-screen decorations fall back without losing search',async()=>{
 for(const alternate of [false,true]){const a=controller();a.term.buffer.active.type=alternate?'alternate':'normal';a.term.registerMarker=()=>undefined;a.c.open();await a.c.setOptions({regex:true});await a.c.setQuery('hello');assert.equal(a.c.state.count,2);assert.equal(a.c.state.highlightUnavailable,true);assert.equal(a.term.hasSelection(),true);}
});

test('A06 maximum retained snapshot is compact and yields cancellable chunks',async()=>{
 const c=cell('x'),l=line(Array.from({length:500},()=>c)),term=terminal(Array.from({length:2200},()=>l),500);let yields=0;
 const snapshot=await find.snapshotTerminalAsync(term,()=>true,async()=>{yields++;});assert.ok(yields>=17);assert.equal(snapshot.text.length,1102199);assert.equal(snapshot.cells.length,2200,'ASCII rows map as runs, not a million objects');assert.deepEqual(find.findCellRange(snapshot,123,128,500),{col:123,row:0,size:5});
 let current=true;await assert.rejects(find.snapshotTerminalAsync(term,()=>current,async()=>{current=false;}),/cancelled/);
});

test('A06 worker unavailable errors are visible, cancellation is quiet and literal recovery keeps state',async()=>{
 const runner=new find.FindWorker(()=>{throw Error('denied');});await assert.rejects(runner.run('a','a',true,true),/unavailable/);runner.dispose();
 let port;const pendingRunner=new find.FindWorker(()=>port={postMessage(){},terminate(){},onmessage:null,onerror:null});const pending=pendingRunner.run('a','a',true,true);pendingRunner.cancel();await assert.rejects(pending,/cancelled/);pendingRunner.dispose();
 const a=controller();a.c.open();await a.c.setOptions({regex:true});await a.c.setQuery('[');assert.match(a.c.state.error,/Invalid regular expression/);await a.c.setOptions({regex:false});await a.c.setQuery('hello');assert.equal(a.c.state.count,2);assert.equal(a.c.state.error,null);
});

test('A06 repeated wide emoji and combining cells map compact runs without splitting a glyph',()=>{
 for(const [chars,width]of [['中',2],['😀',2],['é',1]]){const cells=[];for(let i=0;i<8/width;i++){cells.push(cell(chars,width));if(width===2)cells.push(cell('',0));}const snap=find.snapshotTerminal(terminal([line(cells)]));assert.equal(snap.cells.length,1);assert.deepEqual(find.findCellRange(snap,1,2,8),{col:chars.length===1?width:0,row:0,size:width});}
 const snap=find.snapshotTerminal(terminal([line([cell('x')]),line([cell('y')])]));assert.deepEqual(find.findCellRange(snap,0,2,8),{col:0,row:0,size:1});assert.deepEqual(find.findCellRange(snap,1,3,8),{col:0,row:1,size:1});
});

test('A06 literal totals follow official overlapping matches and literal case folding',()=>{
 assert.deepEqual(scanFindText('aaaa','aa',false,true).matches,[[0,2],[1,3],[2,4]]);assert.deepEqual(scanFindText('ς σ','σ',false,false).matches,[[2,3]]);assert.deepEqual(scanFindText('.*.*','.*',false,true).matches,[[0,2],[2,4]]);
});

test('A06 invalidated viewport results are discarded but pending indicator settles',async()=>{
 const a=controller();let resolve,valid=true;const c=new find.TerminalFindController(a.term,{run:()=>new Promise(r=>resolve=r),cancel(){},dispose(){}},()=>{});c.open();c.state.query='hello';const pending=c.afterFrame(()=>valid);await Promise.resolve();valid=false;resolve({matches:[[0,5]],overflow:false});await pending;assert.equal(c.state.count,0);assert.equal(c.state.busy,false);assert.equal(c.state.error,null);c.dispose();
});

async function installedController(text,cols=20){
 const {createRequire}=await import('node:module'),require=createRequire(new URL('../package.json',import.meta.url)),{Terminal}=require('@xterm/headless');
 const t=new Terminal({cols,rows:4,allowProposedApi:true});const events=[];let selection;
 Object.assign(t,{hasSelection:()=>!!selection,getSelectionPosition:()=>selection,clearSelection(){selection=undefined;},select(col,row,size){selection={start:{x:col,y:row},end:{x:(col+size)%cols,y:row+Math.floor((col+size)/cols)}};events.push(['select',col,row,size]);},scrollToLine:n=>events.push(['scroll',n]),scrollLines:n=>events.push(['scroll-lines',n]),registerDecoration:()=>undefined});
 await new Promise(resolve=>t.write(text,resolve));
 const c=new find.TerminalFindController(t,{run:async(text,q,r,s)=>scanFindText(text,q,r,s),cancel(){},dispose(){}},()=>{});c.open();return{c,t,events,selection:()=>selection,dispose(){c.dispose();t.dispose();}};
}
test('A06 literal spans advance wrap reverse and keep frame anchor in the actual terminal',async()=>{
 const a=await installedController('hello hello');await a.c.setQuery('hello');assert.equal(a.selection().start.x,0);await a.c.navigate(1);assert.equal(a.selection().start.x,6);assert.equal(a.c.state.index,1);await a.c.navigate(1);assert.equal(a.selection().start.x,0);await a.c.navigate(-1);assert.equal(a.selection().start.x,6);
 a.c.beforeFrame();a.events.length=0;await a.c.afterFrame(()=>true);assert.deepEqual(a.events,[],'Background frame refresh does not navigate');assert.equal(a.c.state.index,1);await a.c.navigate(1);assert.equal(a.selection().start.x,0);a.dispose();
 const b=await installedController('aaaa');await b.c.setQuery('aa');for(const col of [1,2,0]){await b.c.navigate(1);assert.equal(b.selection().start.x,col);}await b.c.navigate(-1);assert.equal(b.selection().start.x,2);b.dispose();
});
test('A06 repair folded literal spans keep original UTF16 bounds before and within matches',async()=>{
 assert.deepEqual(scanFindText('İx','x',false,false).matches,[[1,2]]);assert.deepEqual(scanFindText('İx','i',false,false).matches,[[0,1]]);assert.deepEqual(scanFindText('İx','i̇x',false,false).matches,[[0,2]]);assert.deepEqual(scanFindText('İ é x','x',false,false).matches,[[5,6]]);
 const a=await installedController('İx');await a.c.setQuery('x');assert.equal(a.c.state.count,1);assert.deepEqual(a.selection(),{start:{x:1,y:0},end:{x:2,y:0}});await a.c.setQuery('i̇');assert.deepEqual(a.selection(),{start:{x:0,y:0},end:{x:1,y:0}});a.dispose();
 const b=await installedController('aaaİxé',5);await b.c.setQuery('İxé');assert.equal(b.selection().start.x,3);assert.equal(b.selection().start.y,0);assert.deepEqual(b.selection().end,{x:1,y:1});b.dispose();
});

test('authoritative literal navigation never rescans retained lines or allocates a second search cache',async()=>{
 const a=await installedController('hello hello\r\n'+'中文🙂 '.repeat(100));
 try{
  await a.c.setQuery('hello');let reads=0;const buffer=a.t.buffer.active,getLine=buffer.getLine.bind(buffer);buffer.getLine=row=>{reads++;return getLine(row);};
  for(const [direction,col]of [[1,6],[1,0],[-1,6],[-1,0]]){await a.c.navigate(direction);assert.equal(a.selection().start.x,col);assert.equal(a.c.state.error,null);}
  assert.equal(reads,0,'the controller already owns validated match spans; navigation must not scan the terminal again');
  a.c.close();assert.equal(a.selection(),undefined);a.c.open();await new Promise(setImmediate);await a.c.navigate(1);assert.equal(a.selection().start.x,6,'reopen retains the previous authoritative anchor');
 }finally{a.dispose();}
});
test('A06 repair query options and frame pending cannot navigate old generation',async()=>{
 for(const mode of ['query','options','frame']){
  const a=controller();let resolve,delay=false;const runner={run:async(text,q,r,s)=>delay?new Promise(done=>{resolve=done;}):scanFindText(text,q,r,s),cancel(){},dispose(){}};
  const c=new find.TerminalFindController(a.term,runner,()=>{});c.open();await c.setOptions({regex:true});await c.setQuery('hello');delay=true;
  const pending=mode==='query'?c.setQuery('ello'):mode==='options'?c.setOptions({caseSensitive:true}):(c.beforeFrame(),c.afterFrame(()=>true));await Promise.resolve();assert.equal(c.state.busy,true);a.events.length=0;const index=c.state.index;
  await c.navigate(1);await c.navigate(-1);assert.deepEqual(a.events,[]);assert.equal(c.state.index,index);
  resolve(scanFindText(find.snapshotTerminal(a.term).text,c.state.query,c.state.regex,c.state.caseSensitive));await pending;assert.equal(c.state.busy,false);await c.navigate(1);assert.ok(a.events.some(x=>Array.isArray(x)&&x[0]==='select'));c.dispose();
 }
});

test('A06 literal spans cannot auto-select after parsed output or manual selection',async()=>{
 const a=await installedController('hello hello');await a.c.setQuery('hello');a.c.manualSelection();a.t.select(2,0,2);const selected=structuredClone(a.selection());await new Promise(resolve=>a.t.write(' updated',resolve));await new Promise(resolve=>setTimeout(resolve,250));assert.deepEqual(a.selection(),selected);assert.equal(a.c.blocksProjection(),true);a.c.close();assert.deepEqual(a.selection(),selected);a.dispose();
});
test('A06 repair folded offsets include multiple expansions emoji and a match inside the expanded glyph',()=>{
 assert.deepEqual(scanFindText('İİ😀x','x',false,false).matches,[[4,5]]);assert.deepEqual(scanFindText('İx','̇',false,false).matches,[[0,1]]);assert.deepEqual(scanFindText('İİ','i̇',false,false).matches,[[0,1],[1,2]]);assert.deepEqual(scanFindText('İ.*','.*',false,false).matches,[[1,3]]);
});


test('actual controller decorations stay readable in installed renderer over selection and ANSI backgrounds',async()=>{
 const {createRequire}=await import('node:module'),{readFileSync}=await import('node:fs'),vm=await import('node:vm'),path=await import('node:path');const require=createRequire(import.meta.url),ts=require('typescript');const base=path.dirname(require.resolve('@xterm/xterm/package.json'))+'/src',cache={};
 function load(name){if(cache[name])return cache[name].exports;const filename=base+'/'+name+'.ts',m={exports:{}};cache[name]=m;const code=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(code,{exports:m.exports,module:m,require:n=>load(n.startsWith('.')?path.posix.normalize(path.posix.dirname(name)+'/'+n):n),console,process,navigator:{userAgent:'node',platform:'MacIntel'},setTimeout,clearTimeout,setInterval,clearInterval,performance,queueMicrotask,globalThis},{filename});return m.exports;}
 const {DomRendererRowFactory}=load('browser/renderer/dom/DomRendererRowFactory'),{DecorationService}=load('common/services/DecorationService'),{css}=load('common/Color'),{Terminal}=require('@xterm/headless');
 class Span{constructor(){this.attrs={};this.style={setProperty:(name,value)=>{this.attrs.style=(this.attrs.style||'')+name+':'+value+';';}};this.classes=[];this.classList={add:(...values)=>this.classes.push(...values)};}setAttribute(n,v){this.attrs[n]=v;}getAttribute(n){return this.attrs[n]||null;}}
 const browserFile=ts.createSourceFile('CoreBrowserTerminal.ts',readFileSync(base+'/browser/CoreBrowserTerminal.ts','utf8'),ts.ScriptTarget.Latest,true);let markerMethod;
 function locate(n){if(ts.isMethodDeclaration(n)&&n.name?.getText(browserFile)==='registerMarker')markerMethod=n.getText(browserFile);ts.forEachChild(n,locate);}locate(browserFile);assert.ok(markerMethod);
 const BrowserMarker=new Function(ts.transpileModule('class BrowserMarker {'+markerMethod+'}; return BrowserMarker;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)();
 for(const alternate of [false,true])for(const focused of [false,true])for(const background of ['#202020','#ffffff','#002b36']){
  const t=new Terminal({cols:20,rows:4,allowProposedApi:true});await new Promise(r=>t.write((alternate?'\x1b[?1049h':'')+'\x1b[44mMATCH other',r));const decorations=new DecorationService();let selection;
  const adapter={cols:t.cols,rows:t.rows,buffer:t.buffer,registerMarker:n=>BrowserMarker.prototype.registerMarker.call({buffer:t._core._bufferService.buffer},n),registerDecoration:o=>decorations.registerDecoration(o),hasSelection:()=>!!selection,getSelectionPosition:()=>selection,clearSelection:()=>{selection=undefined;},select:(x,y,size)=>{selection={start:{x,y},end:{x:x+size,y}};},scrollToLine(){}};
  const runner={run:async(text,q,r,s)=>scanFindText(text,q,r,s),cancel(){},dispose(){}};const c=new find.TerminalFindController(adapter,runner,()=>{});c.open();await c.setOptions({regex:true});await c.setQuery('MATCH');assert.equal(c.state.count,1);assert.equal(t.buffer.active.type,alternate?'alternate':'normal');assert.equal(c.state.highlightUnavailable,false);
  const colors={foreground:css.toColor('#eeeeee'),background:css.toColor(background),selectionBackgroundOpaque:css.toColor('#334455'),selectionInactiveBackgroundOpaque:css.toColor('#445566'),selectionForeground:css.toColor('#eeeeee'),ansi:Array.from({length:256},()=>css.toColor('#112233'))};
  const factory=new DomRendererRowFactory({createElement:()=>new Span()},{getJoinedCharacters:()=>[]},{rawOptions:{drawBoldTextInBrightColors:true,minimumContrastRatio:1,cursorStyle:'block',cursorInactiveStyle:'outline'}},{isFocused:focused},{isCursorHidden:true},decorations,{colors});
  const row=()=>factory.createRow(t._core._bufferService.buffer.lines.get(0),0,false,'block','outline',0,false,20,{get:()=>20},-1,-1);
  for(const selected of [false,true]){factory.handleSelectionChanged(selected?[0,0]:undefined,selected?[5,0]:undefined,false);const spans=row();for(const span of spans.slice(0,5)){assert.match(span.attrs.style,/background-color:#facc15;/);assert.match(span.attrs.style,/(?:^|;)color:#171717;/);}assert.ok(spans.slice(5).every(span=>!span.attrs.style?.includes('#facc15')),'nonmatching text keeps original colors');assert.ok(spans.slice(5).some(span=>span.className?.split(' ').includes('xterm-bg-4')),'nonmatch preserves original ANSI background class');}
  c.close();assert.ok(row().every(span=>!span.attrs.style?.includes('#facc15')),'close disposes actual decorations');c.dispose();decorations.dispose();t.dispose();
 }
});

test('reopen retained query refreshes highlights and navigation without another owner frame',async()=>{const a=controller();let highlights=0;a.term.registerDecoration=()=>{highlights++;return {dispose(){}};};a.c.open();await a.c.setQuery('hello');a.c.close();highlights=0;a.events.length=0;a.c.open();await new Promise(setImmediate);assert.equal(a.c.state.count,2);assert.ok(highlights>0,'reopen recreates retained matches');await a.c.navigate(1);assert.ok(a.events.some(e=>Array.isArray(e)&&e[0]==='select'),'navigation uses refreshed valid results');a.c.dispose();});

test('alternate-screen search highlights every result and disposes them before frame replacement and close',async()=>{
 const a=controller();a.term.buffer.active.type='alternate';let markers=0,decorations=0,disposed=0;
 a.term.registerMarker=()=>{markers++;return {dispose(){disposed++;}};};a.term.registerDecoration=()=>{decorations++;return {dispose(){disposed++;}};};
 a.c.open();await a.c.setQuery('hello');assert.equal(a.c.state.count,2);assert.equal(a.c.state.highlightUnavailable,false);assert.equal(markers,2);assert.equal(decorations,2);
 a.c.beforeFrame();assert.equal(disposed,4);await a.c.afterFrame(()=>true);assert.equal(decorations,4);a.c.close();assert.equal(disposed,8);assert.equal(a.term.hasSelection(),false);a.c.dispose();
});

test('2000-line snapshots reuse one public xterm cell per scan, including simultaneous async scans',async()=>{
 const {default:headless}=await import('@xterm/headless');const t=new headless.Terminal({cols:100,rows:24,scrollback:2000,allowProposedApi:true});
 try{await new Promise(resolve=>t.write('line 中文🙂 e\u0301\r\n'.repeat(2200),resolve));let created=0,reads=0,scratch=0;const targets=new Set(),buffer=t.buffer.active,getLine=buffer.getLine.bind(buffer),getNullCell=buffer.getNullCell.bind(buffer);
  buffer.getNullCell=()=>{scratch++;return getNullCell();};buffer.getLine=row=>{const line=getLine(row);if(!line)return line;const get=line.getCell.bind(line);line.getCell=(col,target)=>{reads++;if(!target)created++;else targets.add(target);return get(col,target);};return line;};
  const sync=find.snapshotTerminal(t);const [a,b]=await Promise.all([find.snapshotTerminalAsync(t,()=>true),find.snapshotTerminalAsync(t,()=>true)]);assert.deepEqual(a,sync);assert.deepEqual(b,sync);assert.ok(reads>=600000);assert.equal(created,0,'getCell must receive the scan-local reusable public cell');assert.equal(scratch,3);assert.equal(targets.size,3,'concurrent scans cannot mutate one shared scratch cell');
 }finally{t.dispose();}
});
test('reused cell lookahead cannot overwrite the current width at a wrapped double-width padding cell',async()=>{
 const rows=[line([cell('a'),cell('b'),cell('c'),cell('')]),line([cell('中',2),cell('',0),cell('é'),cell('😀')],true)];
 const t=terminal(rows,4),legacy=find.snapshotTerminal(t);t.buffer.active.getNullCell=()=>({getChars(){return this.chars;},getWidth(){return this.width;}});
 t.buffer.active.getLine=index=>{const row=rows[index];return row&&{...row,getCell(col,target){const source=row.getCell(col);if(!source)return;if(!target)return source;target.chars=source.getChars();target.width=source.getWidth();return target;}};};
 const snap=await find.snapshotTerminalAsync(t,()=>true);assert.deepEqual(snap,legacy);assert.equal(snap.text,'abc中é😀');assert.deepEqual(find.findCellRange(snap,3,4,4),{col:0,row:1,size:2});assert.deepEqual(find.findCellRange(snap,4,6,4),{col:2,row:1,size:1});
 let active=true;await assert.rejects(find.snapshotTerminalAsync({...t,buffer:{active:{...t.buffer.active,length:260}}},()=>active,async()=>{active=false;}),/cancelled/);
});

function countedFindRunner(){let created=0;const requests=[];const runner=new find.FindWorker(()=>{created++;const port={onmessage:null,onerror:null,terminate(){},postMessage(data){requests.push(data);queueMicrotask(()=>port.onmessage?.({data:{id:data.id,...scanFindText(data.text,data.query,data.regex,data.caseSensitive)}}));}};return port;});return{runner,requests,created:()=>created};}
const scanResult=({id,...result})=>result;
test('ordinary literal scans avoid disposable workers while preserving overlapping and Unicode offsets',async()=>{
 const h=countedFindRunner();try{
  for(const [text,query,sensitive]of [['Ab ab','ab',false],['aaaa','aa',true],['.*.*','.*',true],['中文🙂 é','🙂',false],['ς σ','σ',false],['i̇x','İ',false],['İx','x',true],['\n\n','\n',false],['abc','',false]]){
   assert.deepEqual(scanResult(await h.runner.run(text,query,false,sensitive)),scanFindText(text,query,false,sensitive));
  }
  assert.equal(h.created(),0,'literal queries must not create a separate worker VM');
 }finally{h.runner.dispose();}
});
test('literal scan cancellation disposal and replacement cannot publish a previous microtask',async()=>{
 const h=countedFindRunner();try{
  const cancelled=h.runner.run('first','first',false,true);h.runner.cancel();await assert.rejects(cancelled,/cancelled/);
  const previous=h.runner.run('old','old',false,true),latest=h.runner.run('new new','new',false,true);await assert.rejects(previous,/cancelled/);assert.deepEqual((await latest).matches,[[0,3],[4,7]]);
  const disposed=h.runner.run('last','last',false,true);h.runner.dispose();await assert.rejects(disposed,/cancelled|disposed/);assert.equal(h.created(),0);
 }finally{h.runner.dispose();}
});
test('length-expanding case folds and arbitrary regex retain worker isolation and original coordinates',async()=>{
 const h=countedFindRunner();try{
  for(const [text,query,regex,sensitive]of [['İİ😀x','x',false,false],['İx','̇',false,false],['aA','a+',true,false]])assert.deepEqual(scanResult(await h.runner.run(text,query,regex,sensitive)),scanFindText(text,query,regex,sensitive));
  assert.equal(h.created(),3);assert.equal(h.requests[0].text,'İİ😀x');assert.equal(h.requests[0].caseSensitive,false);
 }finally{h.runner.dispose();}
});
test('maximum ordinary literal snapshot bounds matches without starting a worker',async()=>{
 const h=countedFindRunner();try{const text='a'.repeat(1102199);assert.equal((await h.runner.run(text,'a',false,false)).matches.length,200);assert.deepEqual(scanResult(await h.runner.run(text,'absent',false,false)),{matches:[],overflow:false});assert.equal(h.created(),0);}finally{h.runner.dispose();}
});
test('oversized combined-glyph text keeps worker isolation beyond the ordinary inline budget',async()=>{
 const h=countedFindRunner();try{
  assert.deepEqual(scanResult(await h.runner.run('a'.repeat(1200000),'absent',false,true)),{matches:[],overflow:false});assert.equal(h.created(),0);
  assert.deepEqual(scanResult(await h.runner.run('a'.repeat(1200001),'absent',false,true)),{matches:[],overflow:false});assert.equal(h.created(),1,'large combining-cell payloads must not run on the page thread');
 }finally{h.runner.dispose();}
});
