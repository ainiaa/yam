// Author: Jeff.Liu. Isolated parser/render-snapshot cost measurement.
import {createRequire} from 'node:module';import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url),root=process.argv[2];
const {Terminal}=require(root+'/node_modules/@xterm/headless');
const {SerializeAddon}=require(root+'/node_modules/@xterm/addon-serialize');
const write=(term,data)=>new Promise(resolve=>term.write(data,resolve));
const terms=Array.from({length:16},()=>{const term=new Terminal({cols:100,rows:40,scrollback:2000,allowProposedApi:true});const addon=new SerializeAddon();term.loadAddon(addon);return {term,addon};});
const line='YAM 中文 😀 '+'.'.repeat(80)+'\r\n';
await Promise.all(terms.map(({term})=>write(term,line.repeat(2000))));
const rssStart=process.memoryUsage().rss,start=performance.now(),cpu=process.cpuUsage(),costs=[];let bytes=0,ticks=0;
while(performance.now()-start<10000){
 const target=start+(++ticks)*100;
 await Promise.all(terms.map(({term})=>write(term,line.repeat(10))));
 const before=performance.now();bytes+=Buffer.byteLength(terms[0].addon.serialize());costs.push(performance.now()-before);
 await new Promise(r=>setTimeout(r,Math.max(0,target-performance.now())));
}
const elapsed=performance.now()-start,used=process.cpuUsage(cpu);costs.sort((a,b)=>a-b);
console.log(JSON.stringify({sessions:16,cols:100,rows:40,scrollback:2000,lines_per_second:ticks*10*16/(elapsed/1000),elapsed_ms:elapsed,rss_start_bytes:rssStart,rss_end_bytes:process.memoryUsage().rss,cpu_core_percent:(used.user+used.system)/(elapsed*10),visible_snapshot_p95_ms:costs[Math.floor(costs.length*.95)],visible_snapshot_bytes_per_second:bytes/(elapsed/1000)}));
for(const {term} of terms)term.dispose();
