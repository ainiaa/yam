import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu. Actual xterm renderer events while applying full terminal projections.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync as rawReadFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import ts from 'typescript';

const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Headless Chrome can still display macOS keychain dialogs; installation is not test consent.
const chromeSkip = process.env.YAM_TEST_HEADLESS_CHROME !== '1'
  ? 'Set YAM_TEST_HEADLESS_CHROME=1 to explicitly run isolated local-browser tests'
  : !existsSync(chrome) && 'Set CHROME_BIN to an installed Chromium browser';
const source = ts.transpileModule(readFileSync(new URL('../src/terminal-frame.ts', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText.replace(/^export /gm, '');

test('full TUI projections keep screen, focus and scrollbar stable through replacement', {skip: chromeSkip}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yam-frame-render-'));
  try {
    writeFileSync(join(directory, 'xterm.js'), readFileSync(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url)));
    const css = readFileSync(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
    const script = `${source}
      (async () => {
        const terminal = new Terminal({cols:80,rows:24,allowProposedApi:true,cursorBlink:false});
        terminal.open(document.getElementById('terminal'));
        const frame = revision => ({projection:{version:1,instance:'a'.repeat(64),session:'s-render',terminal_version:'6.0.0',serialize_version:'0.14.0',revision,data:'\\x1b[?1049h\\x1b[HSTABLE TUI FRAME '+revision+'\\x1b[2;1HInput stays available',cols:80,rows:24,cursorX:21,viewport:0,buffer:'alternate'},end_offset:revision,status:'running'});
        const renderFrame = scene => new Promise((resolve,reject) => {
          const timeout=setTimeout(()=>{listener.dispose();reject(Error('Expected TUI frame did not render'));},3000);
          const listener=terminal.onRender(()=>{
            if(!document.querySelector('.xterm-rows').textContent.includes('STABLE TUI FRAME '+scene.projection.revision))return;
            clearTimeout(timeout);listener.dispose();resolve();
          });
          applyTerminalFrame(terminal,scene,'s-render').catch(error=>{clearTimeout(timeout);listener.dispose();reject(error);});
        });
        await renderFrame(frame(0));
        terminal.focus();
        const input=[];terminal.onData(data=>input.push(data));
        const paints=[];
        const listener=terminal.onRender(() => paints.push({text:document.querySelector('.xterm-rows').textContent.trim(),buffer:terminal.buffer.active.type,focused:document.activeElement===terminal.textarea}));
        for(let revision=1;revision<=30;revision++) {
          await renderFrame(frame(revision));
        }
        const large=frame(31);
        large.projection.data='\\x1b[0m'.repeat(Math.floor((8*1024*1024-large.projection.data.length)/4))+large.projection.data;
        await renderFrame(large);
        terminal.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',keyCode:65,which:65,bubbles:true}));
        const finalText=document.querySelector('.xterm-rows').textContent.trim();
        listener.dispose();
        const normal=frame(32);
        normal.projection.buffer='normal';normal.projection.viewport=50;
        normal.projection.data=Array.from({length:100},(_,i)=>'history row '+i+'\\r\\n').join('');
        await applyTerminalFrame(terminal,normal,'s-render');
        await new Promise(resolve=>setTimeout(resolve,100));
        const scrollable=terminal._core._viewport._scrollableElement;
        const stableHeight=scrollable.getScrollDimensions().scrollHeight;
        const scrollbarEvents=[],viewportMismatches=[];
        const scrollListener=scrollable.onScroll(e=>scrollbarEvents.push({height:e.scrollHeight,top:e.scrollTop}));
        for(let revision=33;revision<=62;revision++) {
          normal.projection.revision=revision;
          normal.projection.viewport=revision<48?50:terminal.buffer.active.baseY;
          await applyTerminalFrame(terminal,normal,'s-render');
          await new Promise(resolve=>setTimeout(resolve,20));
          if(terminal.buffer.active.viewportY!==normal.projection.viewport)viewportMismatches.push({revision,expected:normal.projection.viewport,actual:terminal.buffer.active.viewportY});
        }
        scrollListener.dispose();
        const scrollbar={viewportMismatches,stableHeight,shrinks:scrollbarEvents.filter(e=>e.height<stableHeight).length,finalHeight:scrollable.getScrollDimensions().scrollHeight,viewport:terminal.buffer.active.viewportY,base:terminal.buffer.active.baseY};
        const wheel=new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true});
        // Chromium initializes the legacy wheel delta to zero on constructed events.
        Object.defineProperty(wheel,'wheelDeltaY',{value:120});
        terminal.element.querySelector('.xterm-screen').dispatchEvent(wheel);
        await new Promise(resolve=>setTimeout(resolve,100));
        scrollbar.wheelViewport=terminal.buffer.active.viewportY;
        terminal.scrollToLine(12);
        await new Promise(resolve=>setTimeout(resolve,20));
        scrollbar.historyViewport=terminal.buffer.active.viewportY;
        const clear=frame(63);clear.projection.buffer='normal';clear.projection.viewport=0;clear.projection.data='Cleared scene';
        await applyTerminalFrame(terminal,clear,'s-render');
        await new Promise(resolve=>setTimeout(resolve,20));
        scrollbar.clearedBase=terminal.buffer.active.baseY;
        scrollbar.clearedHeight=scrollable.getScrollDimensions().scrollHeight;
        scrollbar.normalFocusRetained=document.activeElement===terminal.textarea;
        const result={scrollbar,paints:paints.length,blankPaints:paints.filter(paint=>!paint.text).length,wrongBufferPaints:paints.filter(paint=>paint.buffer!=='alternate').length,focusLost:paints.some(paint=>!paint.focused),input,largeFrameLength:large.projection.data.length,finalText};
        await fetch('/result',{method:'POST',body:JSON.stringify(result)});
        terminal.dispose();
      })().catch(error => fetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));`;
    const file=join(directory,'frame.html');
    writeFileSync(file,`<style>${css}</style><div id="terminal" style="width:900px;height:600px"></div><pre id="result"></pre><script src="xterm.js"></script><script>${script}</script>`);
    const result=await new Promise((resolve,reject)=>{
      let child,completed,failure;
      const server=createServer((request,response)=>{
        if(request.method==='POST'&&request.url==='/result'){
          let body='';
          request.on('data',chunk=>{body+=chunk;if(body.length>65536){failure=new Error('Chrome result exceeded limit');request.destroy();child?.kill('SIGKILL');}});
          request.on('end',()=>{
            try{completed=JSON.parse(body);}catch(error){failure=error;}
            response.end('ok');
            child?.kill('SIGTERM');
          });
        }else if(request.url==='/'||request.url==='/xterm.js'){
          response.setHeader('Content-Type',request.url==='/'?'text/html':'application/javascript');
          response.end(readFileSync(request.url==='/'?file:join(directory,'xterm.js')));
        }else{response.statusCode=404;response.end();}
      });
      const timeout=setTimeout(()=>{failure=new Error('Chrome render completion timed out');if(child)child.kill('SIGKILL');else{server.close();reject(failure);}},15000);
      server.listen(0,'127.0.0.1',()=>{
        child=spawn(chrome,['--headless','--disable-gpu','--disable-background-networking','--use-mock-keychain','--disable-features=DialMediaRouteProvider','--no-first-run','--no-default-browser-check','--user-data-dir='+join(directory,'profile'),'http://127.0.0.1:'+server.address().port],{stdio:['ignore','ignore','ignore']});
        child.on('error',error=>{clearTimeout(timeout);server.close();reject(error);});
        child.on('close',()=>{clearTimeout(timeout);server.close();if(failure||!completed)reject(failure??new Error('Chrome exited without render results'));else resolve(completed);});
      });
      server.on('error',error=>{clearTimeout(timeout);child?.kill('SIGKILL');reject(error);});
    });
    console.log(JSON.stringify(result));
    assert.equal(result.error,undefined);
    assert.ok(result.paints>=31,'each completed scene must actually render');
    assert.match(result.finalText,/STABLE TUI FRAME 31/);
    assert.equal(result.focusLost,false,'projection updates retain the input element focus');
    assert.deepEqual(result.input,['a'],'only user key input is emitted, without replay protocol replies');
    assert.ok(result.largeFrameLength>=8*1024*1024-4,'exercise the actual maximum-size frame parser');
    assert.equal(result.blankPaints,0,'no cleared intermediate scene may reach the renderer');
    assert.equal(result.wrongBufferPaints,0,'alternate scene must not temporarily paint the normal buffer');
    assert.ok(result.scrollbar.stableHeight>24,'normal scene must overflow with actual scrollback');
    assert.equal(result.scrollbar.shrinks,0,'full projection must not collapse scrollbar dimensions while replacing the scene');
    assert.deepEqual(result.scrollbar.viewportMismatches,[],'every historical frame must restore exactly its authoritative viewport');
    assert.equal(result.scrollbar.finalHeight,result.scrollbar.stableHeight);
    assert.equal(result.scrollbar.viewport,result.scrollbar.base,'latest authoritative viewport remains at bottom');
    assert.ok(result.scrollbar.wheelViewport<result.scrollbar.base,'real wheel input still scrolls after projection');
    assert.equal(result.scrollbar.historyViewport,12,'explicit historical position remains reachable');
    assert.equal(result.scrollbar.clearedBase,0,'a genuine clear must still remove scrollback');
    assert.ok(result.scrollbar.clearedHeight<result.scrollbar.stableHeight,'genuine scrollbar changes remain enabled');
    assert.equal(result.scrollbar.normalFocusRetained,true);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
