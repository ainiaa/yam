import {englishUiRead} from './fixtures/english-ui-source.mjs';
const readFileSync=(...args)=>englishUiRead(rawReadFileSync,...args);
// Author: Jeff.Liu. Initial restoration followed by the same raw bytes as the managed PTY.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as rawReadFileSync, existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
const require = createRequire(import.meta.url);
const {Terminal} = require('@xterm/headless');
const {SerializeAddon} = require('@xterm/addon-serialize');
const {projection} = require('../terminal-service.cjs');
const rust = readFileSync(new URL('../src-tauri/src/external_terminal.rs', import.meta.url), 'utf8');
const path = rust.slice(rust.indexOf('fn attach_fds('), rust.indexOf('#[cfg(test)]'));
const parts = path.match(/&\[\s*b"((?:\\.|[^"\\])*)",\s*first\.2\.as_bytes\(\),\s*b"((?:\\.|[^"\\])*)"/s);
assert.ok(parts, 'initial restoration must use the actual helper output path');
assert.match(path, /output_until\(\s*&mut output,\s*&\[scene\.0\.as_bytes\(\)\]/s, 'deltas must be forwarded without reset/replay');
const decode = body => JSON.parse('"' + body.replace(/\\x([0-9a-f]{2})/gi, '\\u00$1') + '"');
const [prefix, suffix] = parts.slice(1).map(decode);
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
function terminal() {
  const term = new Terminal({cols:80, rows:24, scrollback:2000, allowProposedApi:true});
  const addon = new SerializeAddon(); term.loadAddon(addon);
  return {term, addon};
}

test('one restored snapshot plus split raw deltas preserve buffers, modes, queries and resize', async () => {
  const source = terminal(), host = terminal(), responses = [];
  try {
    await write(source.term, Array.from({length:50}, (_, i) => 'history ' + i + '\r\n').join('') + 'READY');
    await write(host.term, prefix + projection(source.term, source.addon).data + suffix);
    host.term.onData(data => responses.push(data));
    const chunks = ['\x1b[?1049h\x1b[HSTART', '\x1b[2;', '1H中文😀', '\x1b[?2004h\x1b[?1003h\x1b[?1006h', '\x1b[6n', '\x1b[?1049l\r\nTAIL'];
    for (const chunk of chunks) {
      await write(source.term, chunk);
      await write(host.term, chunk);
      assert.deepEqual(projection(host.term, host.addon), projection(source.term, source.addon));
      assert.deepEqual(host.term.modes, source.term.modes);
    }
    source.term.resize(90, 30); host.term.resize(90, 30);
    await write(source.term, '\r\nRESIZED'); await write(host.term, '\r\nRESIZED');
    assert.deepEqual(projection(host.term, host.addon), projection(source.term, source.addon));
    assert.equal(responses.length, 1, 'only the live query reaches the external responder');
  } finally { source.term.dispose(); host.term.dispose(); }
});

const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('incremental TUI updates keep the real browser renderer nonblank and focused', {skip:!existsSync(chrome) && 'Set CHROME_BIN to an installed Chromium browser'}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yam-stream-render-'));
  const source = terminal();
  try {
    await write(source.term, '\x1b[?1049h\x1b[HFRAME 0\r\n中文😀 input stays available');
    const initial = prefix + projection(source.term, source.addon).data + suffix;
    writeFileSync(join(directory, 'xterm.js'), readFileSync(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url)));
    const css = readFileSync(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
    const script = `
      (async()=>{
        const term=new Terminal({cols:80,rows:24,allowProposedApi:true,cursorBlink:false});
        term.open(document.getElementById('terminal'));
        const write=data=>new Promise(resolve=>term.write(data,resolve));
        const paint=(data,label)=>new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{listener.dispose();reject(Error('Expected stream frame did not paint'));},3000);
          const listener=term.onRender(()=>{if(!document.querySelector('.xterm-rows').textContent.includes(label))return;clearTimeout(timer);listener.dispose();resolve();});
          write(data).catch(reject);
        });
        await paint(${JSON.stringify(initial)},'FRAME 0');term.focus();
        let blank=0,focusLost=0,paints=0,resets=0;const input=[];
        term.onData(data=>input.push(data));
        term.parser.registerEscHandler({final:'c'},()=>{resets++;return false;});
        const listener=term.onRender(()=>{paints++;if(!document.querySelector('.xterm-rows').textContent.trim())blank++;if(document.activeElement!==term.textarea)focusLost++;});
        for(let i=1;i<=30;i++){
          await write('\\x1b[?2026h\\x1b[H');
          await new Promise(resolve=>setTimeout(resolve,20));
          await write('FRAME '+i+'\\x1b[K');
          await paint('\\x1b[?2026l','FRAME '+i);
        }
        term.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',keyCode:65,which:65,bubbles:true}));
        listener.dispose();const finalText=document.querySelector('.xterm-rows').textContent;
        await fetch('/result',{method:'POST',body:JSON.stringify({blank,focusLost,paints,resets,input,finalText})});term.dispose();
      })().catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:String(error)})}));`;
    writeFileSync(join(directory, 'index.html'), `<meta charset="utf-8"><style>${css}</style><div id="terminal" style="width:900px;height:600px"></div><script src="xterm.js"></script><script>${script}</script>`);
    const result = await new Promise((resolve, reject) => {
      let child, completed, failure;
      const server = createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/result') {
          let body = '';
          request.on('data', chunk => { body += chunk; if (body.length > 65536) { failure = Error('Browser result exceeds budget'); child?.kill('SIGKILL'); } });
          request.on('end', () => { try { completed = JSON.parse(body); } catch (error) { failure = error; } response.end('ok'); child?.kill('SIGTERM'); });
        } else if (request.url === '/' || request.url === '/xterm.js') {
          response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
          response.end(readFileSync(join(directory, request.url === '/' ? 'index.html' : 'xterm.js')));
        } else { response.statusCode = 404; response.end(); }
      });
      const timer = setTimeout(() => { failure = Error('Browser stream timed out'); child?.kill('SIGKILL'); }, 15000);
      server.listen(0, '127.0.0.1', () => {
        child = spawn(chrome, ['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--user-data-dir='+join(directory,'profile'),'http://127.0.0.1:'+server.address().port], {stdio:'ignore'});
        child.on('error', error => { clearTimeout(timer); server.close(); reject(error); });
        child.on('close', () => { clearTimeout(timer); server.close(); if (failure || !completed) reject(failure ?? Error('Browser exited without result')); else resolve(completed); });
      });
      server.on('error', error => { clearTimeout(timer); child?.kill('SIGKILL'); reject(error); });
    });
    console.log(JSON.stringify(result));
    assert.equal(result.error, undefined);
    assert.ok(result.paints >= 30);
    assert.equal(result.blank, 0);
    assert.equal(result.resets, 0);
    assert.equal(result.focusLost, 0);
    assert.deepEqual(result.input, ['a']);
    assert.match(result.finalText, /FRAME 30/);
    assert.match(result.finalText, /中文😀/);
  } finally { source.term.dispose(); rmSync(directory, {recursive:true, force:true, maxRetries:5, retryDelay:100}); }
});
