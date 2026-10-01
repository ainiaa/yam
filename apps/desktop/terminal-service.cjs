// Author: Jeff.Liu. Private pipe protocol; the Rust background process owns all PTYs.
'use strict';
const {Terminal}=require('@xterm/headless');
const {SerializeAddon}=require('@xterm/addon-serialize');
const {once}=require('node:events');
const MAX_REQUEST=1024*1024,MAX_FRAME=8*1024*1024,MAX_CELLS=4_000_000;
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
function dimensions(cols,rows){
 if(!Number.isSafeInteger(cols)||cols<2||cols>500||!Number.isSafeInteger(rows)||rows<2||rows>200)throw Error('Invalid terminal dimensions');
}
function projection(term,addon){
 const buffer=term._core?._inputHandler?._activeBuffer,service=term._core?.coreService;
 if(!buffer||!service?.decPrivateModes||!term._core.coreMouseService||!Number.isSafeInteger(buffer.x))throw Error('Terminal version contract unavailable');
 const row=term.buffer.active.cursorY-(term.modes.originMode?buffer.scrollTop:0)+1;
 const encoding=term._core.coreMouseService.activeEncoding;
 const mouse=encoding==='SGR'?'\x1b[?1006h':encoding==='SGR_PIXELS'?'\x1b[?1016h':'';
 const visibility=service.isCursorHidden?'\x1b[?25l':'\x1b[?25h';
 const cursor=service.decPrivateModes;
 const style=cursor.cursorStyle?`\x1b[${({block:2,underline:4,bar:6}[cursor.cursorStyle])-(cursor.cursorBlink?1:0)} q`:'';
 const margin=(term.modes.originMode||buffer.scrollTop!==0||buffer.scrollBottom!==term.rows-1)?`\x1b[${buffer.scrollTop+1};${buffer.scrollBottom+1}r`+(term.modes.originMode?'\x1b[?6h':'')+`\x1b[${row};${term.buffer.active.cursorX+1}H`:'';
 const data=addon.serialize()+mouse+visibility+style+margin;
 if(Buffer.byteLength(data)>MAX_FRAME)throw Error('Terminal snapshot exceeds retained frame budget');
 return {data,cols:term.cols,rows:term.rows,cursorX:term.buffer.active.cursorX,viewport:term.buffer.active.viewportY,buffer:term.buffer.active.type};
}
async function run(){
 const instance=process.env.YAM_TERMINAL_INSTANCE;
 if(!/^[a-f0-9]{64}$/.test(instance??''))throw Error('Invalid terminal instance');
 const sessions=new Map();
 async function emit(value){if(!process.stdout.write(JSON.stringify(value)+'\n'))await once(process.stdout,'drain');}
 const cells=(cols,rows)=>cols*(rows+2000);
 const allocated=()=>[...sessions.values()].reduce((sum,s)=>sum+cells(s.term.cols,s.term.rows),0);
 async function handle(request){
  const id=Number.isSafeInteger(request?.id)&&request.id>0?request.id:null;
  try{
   const shapes={create:['cols','rows'],write:['data'],resize:['cols','rows'],snapshot:[],viewport:['line'],close:[]};
   const fields=Object.hasOwn(shapes,request?.op)?shapes[request.op]:null;
   if(!id||!fields||Object.keys(request).some(key=>!['id','op','session',...fields].includes(key))||!/^[a-zA-Z0-9_-]{1,128}$/.test(request.session??''))throw Error('Invalid terminal request');
   let entry=sessions.get(request.session),data=null;
   if(request.op==='create'){
    dimensions(request.cols,request.rows);
    if(entry)throw Error('Terminal session already exists');
    if(sessions.size>=256||allocated()+cells(request.cols,request.rows)>MAX_CELLS)throw Error('Terminal memory budget reached');
    const term=new Terminal({cols:request.cols,rows:request.rows,scrollback:2000,allowProposedApi:true});
    const addon=new SerializeAddon();term.loadAddon(addon);projection(term,addon);
    term.onData(value=>{void emit({type:'input',instance,session:request.session,data:value}).catch(()=>{process.exitCode=1;process.stdin.destroy();});});
    entry={term,addon,revision:0};sessions.set(request.session,entry);
   }else{
    if(!entry)throw Error('Unknown terminal session');
    if(request.op==='write'){
     if(typeof request.data!=='string'||request.data.length>MAX_REQUEST||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data))throw Error('Invalid terminal output encoding');
     const bytes=Buffer.from(request.data,'base64');if(bytes.toString('base64')!==request.data)throw Error('Invalid terminal output encoding');
     await write(entry.term,bytes);entry.revision++;
    }else if(request.op==='resize'){
     dimensions(request.cols,request.rows);
     if(allocated()-cells(entry.term.cols,entry.term.rows)+cells(request.cols,request.rows)>MAX_CELLS)throw Error('Terminal memory budget reached');
     entry.term.resize(request.cols,request.rows);entry.revision++;
    }else if(request.op==='viewport'){
     if(!Number.isSafeInteger(request.line)||request.line<0||request.line>entry.term.buffer.active.baseY)throw Error('Invalid terminal viewport');
     entry.term.scrollToLine(request.line);entry.revision++;
    }else if(request.op==='snapshot'){
     data={version:1,instance,session:request.session,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:entry.revision,...projection(entry.term,entry.addon)};
    }else if(request.op==='close'){entry.term.dispose();sessions.delete(request.session);}
   }
   await emit({id,ok:true,data});
  }catch(error){await emit({id,ok:false,error:error.message});}
 }
 await emit({type:'ready',version:1,instance,terminal_version:'6.0.0',serialize_version:'0.14.0'});
 let pending=Buffer.alloc(0);
 try{
  for await(const bytes of process.stdin){
   pending=Buffer.concat([pending,bytes]);let end;
   while((end=pending.indexOf(10))>=0){
    if(end>MAX_REQUEST)throw Error('Terminal request exceeds frame budget');
    const line=pending.subarray(0,end);pending=pending.subarray(end+1);
    let request;try{request=JSON.parse(line.toString('utf8'));}catch{await emit({id:null,ok:false,error:'Invalid terminal request'});continue;}
    await handle(request);
   }
   if(pending.length>MAX_REQUEST)throw Error('Terminal request exceeds frame budget');
  }
  if(pending.length)throw Error('Truncated terminal request');
 }finally{for(const entry of sessions.values())entry.term.dispose();}
}
module.exports={projection,run};
if(require.main===module||require('node:sea').isSea())run().catch(error=>{console.error('[YAM terminal] '+error.message);process.exitCode=1;process.stdin.destroy();});
