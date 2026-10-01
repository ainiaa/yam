// Author: Jeff.Liu. Isolated candidate evaluation; does not install product dependencies.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const root=process.argv[2]&&resolve(process.argv[2]);if(!root)throw Error('Pass the isolated dependency directory');
const {Terminal}=require(root+'/node_modules/@xterm/headless');
const {SerializeAddon}=require(root+'/node_modules/@xterm/addon-serialize');
const {projection:projectFrame}=require('../apps/desktop/terminal-service.cjs');
const create=()=>new Terminal({cols:20,rows:8,scrollback:100,allowProposedApi:true});
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
function state(term){
 const buffer=term.buffer.active;
 return {mouseEncoding:term._core.coreMouseService.activeEncoding,cursorHidden:term._core.coreService.isCursorHidden,cursorStyle:term.options.cursorStyle,cursorBlink:term.options.cursorBlink,decCursorStyle:term._core.coreService.decPrivateModes.cursorStyle??null,decCursorBlink:term._core.coreService.decPrivateModes.cursorBlink??null,viewport:buffer.viewportY,type:buffer.type,cursor:[buffer.cursorX,buffer.cursorY],base:buffer.baseY,modes:term.modes,
  lines:Array.from({length:buffer.length},(_,index)=>{
   const line=buffer.getLine(index);return {wrapped:line.isWrapped,cells:Array.from({length:line.length},(_,column)=>{
    const c=line.getCell(column);return [c.getChars(),c.getWidth(),c.getFgColorMode(),c.getFgColor(),c.getBgColorMode(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline(),c.isInverse(),c.isInvisible()];
   })};
  })};
}
const cases=[
 ['normal Unicode and SGR','hello 中文 😀\r\n\x1b[31;1mRED\x1b[0m', ' later'],
 ['alternate screen','normal\x1b[?1049h\x1b[4;5Halt 中文\x1b[?2004h', 'X'],
 ['split CSI','prefix\x1b[31', 'mRED'],
 ['split UTF-8',new Uint8Array([0xe4,0xb8]),new Uint8Array([0xad])],
 ['custom tab stops','\x1b[3g\x1b[10G\x1bH\x1b[1G','\tX'],
 ['scroll region','one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[2;5r','\x1b[5;1Hnew\r\nnext'],
 ['saved cursor','\x1b[3;4H\x1b7\x1b[1;1H','\x1b8X'],
 ['character set','\x1b(0','q'],
 ['input modes','\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h',''],
 ['origin and wrap modes','\x1b[2;6r\x1b[?6h\x1b[?7l','test'],
 ['pending right-margin wrap','12345678901234567890',''],
 ['Unicode soft wraps','中文 😀 '.repeat(18),'tail'],
 ['cursor visibility and shape','\x1b[?25l\x1b[5 q','X'],
 ['pixel mouse protocol','\x1b[?1003h\x1b[?1016h',''],
 ['custom margin pending wrap','\x1b[2;6r12345678901234567890',''],
 ['resize narrower with Unicode','中文😀abcdefghijklmnop\r\n'.repeat(12),'more',term=>term.resize(13,6)],
 ['resize wider after alternate screen','normal 中文\x1b[?1049hALT\x1b[4;5H','end',term=>term.resize(30,10)],
 ['alternate screen exit after backend continuation','normal\x1b[?1049halt','\x1b[?1049lcontinued'],
 ['scrolled viewport','line\r\n'.repeat(50),'tail',term=>term.scrollToLine(10)],
 ['scrollback history','line\r\n'.repeat(50),'tail'],
 ['RGB attributes','\x1b[38;2;10;20;30m\x1b[48;5;123m\x1b[3;4;7;8mcolors','more'],
];
let failures=0;const frames=[];
const projection=process.argv.includes('--projection');
for(const [name,prefix,suffix,change] of cases){
 const original=create(),restored=create();const addon=new SerializeAddon();original.loadAddon(addon);
 await write(original,prefix);const snapshot=addon.serialize();await write(restored,snapshot);
 await write(original,suffix);change?.(original);
 if(projection){
  const projected=projectFrame(original,addon);const frame=projected.data;
  frames.push({name,frame,cols:original.cols,rows:original.rows,cursorX:original.buffer.active.cursorX,viewport:original.buffer.active.viewportY,expected:state(original)});
  restored.resize(original.cols,original.rows);restored.reset();await write(restored,frame);
  // CUP clamps a pending-wrap cursor at the right margin. Preserve its bounded metadata.
  assert.ok(original.buffer.active.cursorX>=0&&original.buffer.active.cursorX<=original.cols);
  restored._core._inputHandler._activeBuffer.x=original.buffer.active.cursorX;
  restored.scrollToLine(original.buffer.active.viewportY);
 }
 else await write(restored,suffix);
 let equivalent=true;try{assert.deepEqual(state(restored),state(original));}catch{equivalent=false;failures++;}
 console.log(JSON.stringify({case:name,equivalent,snapshot_bytes:Buffer.byteLength(snapshot)}));
 original.dispose();restored.dispose();
}
console.log(JSON.stringify({candidate:projection?'live backend parser + rendered snapshot':'xterm headless 6.0.0 + serialize 0.14.0',passed:cases.length-failures,failed:failures,complete:failures===0}));
const framePath=process.argv.indexOf('--frames');if(framePath>=0){assert.ok(projection);writeFileSync(process.argv[framePath+1],JSON.stringify(frames),{flag:'wx'});}
process.exitCode=failures?1:0;
