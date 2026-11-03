// Author: Jeff.Liu.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRouting} from '../../../scripts/pi-routing-eval.mjs';

const cases=[{id:'translate',expected:{model:'small',effort:'medium'}},{id:'debug',expected:{model:'strong',effort:'high'}}];
test('routing evaluation measures under-routing separately and keeps unknown cost and quality unknown',()=>{
 const report=evaluateRouting(cases,[{id:'translate',model:'strong',effort:'high',latencyMs:10},{id:'debug',model:'small',effort:'medium',latencyMs:30}]);
 assert.equal(report.underRouted,1);assert.equal(report.overRouted,1);assert.equal(report.exactMatches,0);
 assert.equal(report.meanLatencyMs,20);assert.equal(report.totalCost,null);assert.equal(report.taskPassRate,null);assert.equal(report.costPerPassedTask,null);
});
test('routing evaluation includes classification, execution, review and repair costs supplied by the runner',()=>{
 const rows=cases.map(c=>({id:c.id,...c.expected,latencyMs:0,totalCost:0,taskPassed:true}));
 rows[1].totalCost=.2;const report=evaluateRouting(cases,rows);
 assert.equal(report.exactMatches,2);assert.equal(report.totalCost,.2);assert.equal(report.taskPassRate,1);assert.equal(report.costPerPassedTask,.1);
});
test('routing evaluation refuses missing, duplicate, unexpected and malformed observations',()=>{
 const rows=cases.map(c=>({id:c.id,...c.expected,latencyMs:1}));
 for(const invalid of [[],[rows[0],rows[0]],[...rows,{...rows[0],id:'extra'}],[rows[0],{...rows[1],latencyMs:-1}],[rows[0],{...rows[1],totalCost:NaN}],[rows[0],{...rows[1],taskPassed:'true'}]])assert.throws(()=>evaluateRouting(cases,invalid));
 assert.throws(()=>evaluateRouting([],[]));assert.throws(()=>evaluateRouting([cases[0],cases[0]],rows));
});
