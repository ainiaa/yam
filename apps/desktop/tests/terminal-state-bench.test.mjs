// Author: Jeff.Liu. The benchmark must stay headless and reject invalid workload sizes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../../../scripts/terminal-state-bench.mjs',import.meta.url)),root=fileURLToPath(new URL('../',import.meta.url));
test('headless benchmark accepts one session and emits a bounded measurement with its boundary',()=>{
 const result=spawnSync(process.execPath,[script,root,'1','100'],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
 assert.equal(value.sessions,1);assert.equal(value.measurement,'headless-write-and-serialize');assert.ok(value.samples>0);assert.ok(value.elapsed_ms>=100);for(const key of ['visible_snapshot_p50_ms','visible_snapshot_p95_ms','cpu_core_percent','rss_start_bytes','rss_end_bytes'])assert.ok(Number.isFinite(value[key])&&value[key]>=0,key);
});
test('headless benchmark rejects invalid counts and durations before loading dependencies',()=>{
 for(const [count,duration] of [['0','100'],['2','100'],['17','100'],['NaN','100'],['1','0'],['8','60001'],['16','100.5']]){
  const result=spawnSync(process.execPath,[script,'/missing/dependencies',count,duration],{encoding:'utf8',timeout:3000});assert.notEqual(result.status,0);assert.match(result.stderr,/Invalid benchmark workload/);
 }
});
