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
 return {retained_lines:term.options.scrollback,data,cols:term.cols,rows:term.rows,cursorX:term.buffer.active.cursorX,viewport:term.buffer.active.viewportY,buffer:term.buffer.active.type};
}
function nextCwdReport(previous,uri){
 const sequence=Math.min(Number.MAX_SAFE_INTEGER,previous.sequence+1);
 return {uri:sequence===Number.MAX_SAFE_INTEGER||typeof uri!=='string'||Buffer.byteLength(uri)>4096?null:uri,sequence};
}
function nextCommandReport(previous,payload,normal=true){
 const unknown={phase:'unknown',last_exit:null};let pair=unknown;
 if(previous.sequence===Number.MAX_SAFE_INTEGER)return {sequence:previous.sequence,...unknown};
 if(normal&&typeof payload==='string'&&Buffer.byteLength(payload)<=32&&/^[\x00-\x7f]*$/.test(payload)){
  if(payload==='A')pair={phase:'prompt',last_exit:['complete','prompt','input'].includes(previous.phase)?previous.last_exit:null};
  else if(payload==='B'&&['prompt','input'].includes(previous.phase))pair={phase:'input',last_exit:previous.last_exit};
  else if(payload==='C')pair={phase:'running',last_exit:null};
  else if(payload==='D'||/^D;(?:0|[1-9][0-9]{0,2})$/.test(payload)){
   const exit=payload==='D'?null:Number(payload.slice(2));
   if(exit===null||exit<=255){
    if(previous.phase==='running'||(previous.phase==='complete'&&previous.last_exit===exit))pair={phase:'complete',last_exit:exit};
   }
  }
 }
 if(previous.phase===pair.phase&&previous.last_exit===pair.last_exit)return previous;
 const sequence=previous.sequence+1;return {sequence,...(sequence===Number.MAX_SAFE_INTEGER?unknown:pair)};
}
function clearDisplay(entry,expected,instance){
 if(typeof expected!=='string'||! /^[a-f0-9]{64}$/.test(expected))throw Error('Invalid terminal clear');
 if(expected!==instance)return {status:'stale'};
 if(entry.term.buffer.active.type!=='normal')return {status:'unavailable'};
 if(!Number.isSafeInteger(entry.revision)||entry.revision<0||entry.revision===Number.MAX_SAFE_INTEGER)throw Error('Terminal revision unavailable');
 entry.clearPrompts();entry.term.clear();entry.term.scrollToBottom();entry.revision++;return {status:'cleared'};
}
async function run(){
 const instance=process.env.YAM_TERMINAL_INSTANCE;
 if(!/^[a-f0-9]{64}$/.test(instance??''))throw Error('Invalid terminal instance');
 const sessions=new Map();
 async function emit(value){if(!process.stdout.write(JSON.stringify(value)+'\n'))await once(process.stdout,'drain');}
 const cells=(cols,rows)=>cols*(rows+2000);
 const allocated=()=>[...sessions.values()].reduce((sum,s)=>sum+cells(s.term.cols,s.term.rows)*(s.restoring?2:1),0);
 async function handle(request){
  const id=Number.isSafeInteger(request?.id)&&request.id>0?request.id:null;
  try{
   const shapes={create:['cols','rows','retained_lines'],restore:['data','final'],write:['data'],resize:['cols','rows'],snapshot:[],stream_snapshot:[],viewport:['line','bottom'],navigate_prompt:['direction','expected_instance'],clear_display:['expected_instance'],close:[]};
   const fields=Object.hasOwn(shapes,request?.op)?shapes[request.op]:null;
   if(!id||!fields||Object.keys(request).some(key=>!['id','op','session',...fields].includes(key))||!/^[a-zA-Z0-9_-]{1,128}$/.test(request.session??''))throw Error('Invalid terminal request');
   let entry=sessions.get(request.session),data=null;
   if(request.op==='create'){
    dimensions(request.cols,request.rows);
    const retained=request.retained_lines??2000;if(!Number.isSafeInteger(retained)||retained<200||retained>2000)throw Error('Invalid terminal retention');
    if(entry)throw Error('Terminal session already exists');
    if(sessions.size>=256||allocated()+cells(request.cols,request.rows)>MAX_CELLS)throw Error('Terminal memory budget reached');
    const term=new Terminal({cols:request.cols,rows:request.rows,scrollback:retained,allowProposedApi:true});
    const addon=new SerializeAddon();term.loadAddon(addon);projection(term,addon);
    term.onData(value=>{void emit({type:'input',instance,session:request.session,data:value}).catch(()=>{process.exitCode=1;process.stdin.destroy();});});
    entry={term,addon,revision:0,cwd_report:{uri:null,sequence:0},command_report:{sequence:0,phase:'unknown',last_exit:null}};
    term.parser.registerOscHandler(7,uri=>{entry.cwd_report=nextCwdReport(entry.cwd_report,uri);return true;});
    entry.promptMarkers=[];
    const prunePrompts=()=>{entry.promptMarkers=entry.promptMarkers.filter(marker=>!marker.isDisposed&&marker.line>=0);};
    const clearPrompts=()=>{for(const marker of entry.promptMarkers)marker.dispose();entry.promptMarkers=[];};
    const promptDestinations=()=>{prunePrompts();return [...new Set(entry.promptMarkers.map(marker=>Math.min(marker.line,term.buffer.normal.baseY)))].sort((a,b)=>a-b);};
    entry.clearPrompts=clearPrompts;
    entry.promptNavigation=()=>{const destinations=promptDestinations(),line=term.buffer.normal.viewportY;return {version:1,previous:term.buffer.active.type==='normal'&&destinations.some(x=>x<line),next:term.buffer.active.type==='normal'&&destinations.some(x=>x>line)};};
    entry.navigatePrompt=direction=>{if(term.buffer.active.type!=='normal')return false;const line=term.buffer.normal.viewportY,destinations=promptDestinations(),target=direction==='previous'?destinations.filter(x=>x<line).at(-1):destinations.find(x=>x>line);if(target===undefined)return false;term.scrollToLine(target);return true;};
    const markPrompt=()=>{if(term.buffer.active.type!=='normal')return;prunePrompts();const line=term.buffer.normal.baseY+term.buffer.normal.cursorY;if(entry.promptMarkers.some(marker=>marker.line===line))return;const marker=term.registerMarker();if(!marker)return;entry.promptMarkers.push(marker);if(entry.promptMarkers.length>100)entry.promptMarkers.shift().dispose();};
    const clearCommand=()=>{entry.command_report=nextCommandReport(entry.command_report,null);};
    term.parser.registerOscHandler(133,payload=>{if(payload==='A')markPrompt();entry.command_report=nextCommandReport(entry.command_report,payload,term.buffer.active.type==='normal');return true;});
    term.parser.registerEscHandler({final:'c'},()=>{clearPrompts();clearCommand();return false;});
    term.parser.registerCsiHandler({final:'J'},params=>{if(params[0]===2||params[0]===3){clearPrompts();clearCommand();}return false;});
    for(const final of ['h','l'])term.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.some(p=>[47,1047,1049].includes(p))){clearPrompts();clearCommand();}return false;});
    sessions.set(request.session,entry);
   }else{
    if(!entry)throw Error('Unknown terminal session');
    if(request.op==='write'||request.op==='restore'){
     if(typeof request.data!=='string'||request.data.length>MAX_REQUEST||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data))throw Error('Invalid terminal output encoding');
     const bytes=Buffer.from(request.data,'base64');if(bytes.toString('base64')!==request.data)throw Error('Invalid terminal output encoding');
     if(request.op==='restore'){
      if(entry.revision!==0||(request.final!==undefined&&typeof request.final!=='boolean'))throw Error('Invalid terminal history restoration');
      if(!entry.restoring&&allocated()+cells(entry.term.cols,entry.term.rows)>MAX_CELLS)throw Error('Terminal memory budget reached');
      // Parse old control sequences in isolation; only visible text reaches the new PTY scene.
      const previous=entry.restoring??=new Terminal({cols:entry.term.cols,rows:entry.term.rows,scrollback:entry.term.options.scrollback,allowProposedApi:true});
      await write(previous,bytes);
      if(request.final!==false){
       let text;
       try{const buffer=previous.buffer.active,lines=[];for(let line=0;line<buffer.length;line++)lines.push(buffer.getLine(line).translateToString(true));while(lines.at(-1)==='')lines.pop();text=lines.join('\r\n')+'\r\n── Terminal reopened ──\r\n';}finally{previous.dispose();entry.restoring=null;}
       await write(entry.term,text);data={text};entry.revision++;
      }
     }else{if(entry.restoring)throw Error('Terminal history restoration is pending');await write(entry.term,bytes);entry.revision++;}
    }else if(request.op==='resize'){
     dimensions(request.cols,request.rows);
     if(allocated()-cells(entry.term.cols,entry.term.rows)+cells(request.cols,request.rows)>MAX_CELLS)throw Error('Terminal memory budget reached');
     entry.term.resize(request.cols,request.rows);entry.revision++;
    }else if(request.op==='viewport'){
     if(!Number.isSafeInteger(request.line)||request.line<0||request.line>0xffffffff||(request.bottom!==undefined&&typeof request.bottom!=='boolean')||(!request.bottom&&request.line>entry.term.buffer.active.baseY))throw Error('Invalid terminal viewport');
     if(request.bottom)entry.term.scrollToBottom();else entry.term.scrollToLine(request.line);entry.revision++;
    }else if(request.op==='navigate_prompt'){
     if(!['previous','next'].includes(request.direction)||typeof request.expected_instance!=='string'||! /^[a-f0-9]{64}$/.test(request.expected_instance))throw Error('Invalid prompt navigation');
     const status=request.expected_instance!==instance?'stale':entry.navigatePrompt(request.direction)?'moved':'unavailable';if(status==='moved')entry.revision++;data={status};
    }else if(request.op==='clear_display'){data=clearDisplay(entry,request.expected_instance,instance);
    }else if(request.op==='snapshot'||request.op==='stream_snapshot'){
     if(request.op==='stream_snapshot'){
      const handler=entry.term._core?._inputHandler;
      if(handler?._parser?.currentState!==0||handler?._utf8Decoder?.interim?.[0]!==0)throw Error('Terminal output token incomplete; reconnect from YAM after output resumes');
     }
     data={version:1,instance,session:request.session,terminal_version:'6.0.0',serialize_version:'0.14.0',revision:entry.revision,clear_display_version:1,cwd_report:entry.cwd_report,command_report:entry.command_report,prompt_navigation:entry.promptNavigation(),...projection(entry.term,entry.addon)};
    }else if(request.op==='close'){entry.restoring?.dispose();entry.clearPrompts();entry.term.dispose();sessions.delete(request.session);}
   }
   await emit({id,ok:true,data});
  }catch(error){await emit({id,ok:false,error:error.message});}
 }
 await emit({type:'ready',version:1,instance,terminal_version:'6.0.0',serialize_version:'0.14.0',node_version:process.versions.node,node_arch:process.arch,node_platform:process.platform});
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
 }finally{for(const entry of sessions.values()){entry.restoring?.dispose();entry.clearPrompts();entry.term.dispose();}}
}
module.exports={clearDisplay,projection,run,nextCwdReport,nextCommandReport};
if(require.main===module||require('node:sea').isSea())run().catch(error=>{console.error('[YAM terminal] '+error.message);process.exitCode=1;process.stdin.destroy();});
