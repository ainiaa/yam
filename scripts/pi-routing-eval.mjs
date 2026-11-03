// Author: Jeff.Liu. Offline observations only: this command never calls a model or executes a task.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const levels=['off','minimal','low','medium','high','xhigh','max'];
const selection=value=>value&&['small','strong'].includes(value.model)&&levels.includes(value.effort);
export function evaluateRouting(cases,observations){
 if(!Array.isArray(cases)||!cases.length||!Array.isArray(observations)||cases.length!==observations.length)throw Error('Require one observation per nonempty case');
 const expected=new Map();
 for(const item of cases){if(!item||typeof item.id!=='string'||!item.id||expected.has(item.id)||!selection(item.expected))throw Error('Invalid or duplicate case');expected.set(item.id,item.expected);}
 let exactMatches=0,underRouted=0,overRouted=0,latency=0,cost=0,passed=0,knownCost=true,knownQuality=true;
 const seen=new Set();
 for(const row of observations){
  if(!row||!expected.has(row.id)||seen.has(row.id)||!selection(row)||!Number.isFinite(row.latencyMs)||row.latencyMs<0)throw Error('Invalid, missing or duplicate observation');
  if(row.totalCost!=null&&(!Number.isFinite(row.totalCost)||row.totalCost<0)||row.taskPassed!=null&&typeof row.taskPassed!=='boolean')throw Error('Invalid cost or quality observation');
  seen.add(row.id);const target=expected.get(row.id),modelRank=Number(row.model==='strong')-Number(target.model==='strong'),effortRank=levels.indexOf(row.effort)-levels.indexOf(target.effort);
  if(!modelRank&&!effortRank)exactMatches++;
  if(modelRank<0||effortRank<0)underRouted++;
  if(modelRank>0||effortRank>0)overRouted++;
  latency+=row.latencyMs;knownCost&&=row.totalCost!=null;cost+=row.totalCost??0;knownQuality&&=row.taskPassed!=null;passed+=Number(row.taskPassed===true);
 }
 return {cases:cases.length,exactMatches,underRouted,overRouted,meanLatencyMs:latency/cases.length,totalCost:knownCost?cost:null,taskPassRate:knownQuality?passed/cases.length:null,costPerPassedTask:knownCost&&knownQuality&&passed?cost/passed:null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==4)throw Error('Usage: node scripts/pi-routing-eval.mjs <cases.json> <observations.json>');console.log(JSON.stringify(evaluateRouting(JSON.parse(readFileSync(process.argv[2],'utf8')),JSON.parse(readFileSync(process.argv[3],'utf8'))),null,2));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
