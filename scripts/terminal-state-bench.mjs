// Author: Jeff.Liu. Isolated parser/render-snapshot cost measurement.
import {createRequire} from 'node:module';import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url),root=process.argv[2];
const count=Number(process.argv[3]??16),duration=Number(process.argv[4]??10000);
if(!root||![1,8,16].includes(count)||!Number.isSafeInteger(duration)||duration<100||duration>60000)throw Error('Invalid benchmark workload: pass dependency root, 1/8/16 sessions and 100–60000 ms');
const {Terminal}=require(root+'/node_modules/@xterm/headless');
const {SerializeAddon}=require(root+'/node_modules/@xterm/addon-serialize');
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
const terms=Array.from({length:count},()=>{const term=new Terminal({cols:100,rows:40,scrollback:2000,allowProposedApi:true});const addon=new SerializeAddon();term.loadAddon(addon);return {term,addon};});
const line='YAM 中文 😀 '+'.'.repeat(80)+'\r\n';
try{
await Promise.all(terms.map(({term})=>write(term,line.repeat(2000))));
const rssStart=process.memoryUsage().rss,start=performance.now(),cpu=process.cpuUsage(),costs=[];let bytes=0,ticks=0;
while(performance.now()-start<duration){
 const target=start+(++ticks)*100;
 await Promise.all(terms.map(({term})=>write(term,line.repeat(10))));
 const before=performance.now();bytes+=Buffer.byteLength(terms[(ticks-1)%count].addon.serialize());costs.push(performance.now()-before);
 await new Promise(r=>setTimeout(r,Math.max(0,target-performance.now())));
}
const elapsed=performance.now()-start,used=process.cpuUsage(cpu);costs.sort((a,b)=>a-b);
console.log(JSON.stringify({measurement:'headless-write-and-serialize',sessions:count,samples:costs.length,cols:100,rows:40,scrollback:2000,lines_per_second:ticks*10*count/(elapsed/1000),elapsed_ms:elapsed,rss_start_bytes:rssStart,rss_end_bytes:process.memoryUsage().rss,cpu_core_percent:(used.user+used.system)/(elapsed*10),visible_snapshot_p50_ms:costs[Math.ceil(costs.length*.5)-1],visible_snapshot_p95_ms:costs[Math.ceil(costs.length*.95)-1],visible_snapshot_bytes_per_second:bytes/(elapsed/1000)}));
}finally{for(const {term} of terms)term.dispose();}
